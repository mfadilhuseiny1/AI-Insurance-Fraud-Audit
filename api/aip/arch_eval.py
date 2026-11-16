"""Architecture-mode evaluation: the same golden questions through the FULL multiagent orchestrator.

The per-model golden runner (`aip/golden/run.py`) swaps one engine inside the single-agent `jkn_agent` loop — it
answers "which model is the best engine". This module answers the architecture question instead: it asks every golden
question through the shipped path (`POST /api/aip/ask` → the ADK runtime with planner, workers, writer, scrutiny and
validator) and scores the answers with the golden set's own checks (`must_call`, live truths, `must_say_any`).

The job acts as the user who started it: the endpoint captures that user's principal and mints a job token
(`auth.issue_job_token`, revoked when the job ends), then drives the platform over its own HTTP surface — the same
calls a browser makes. No golden credentials are needed and what is measured is what ships, auth and gateway included.

    POST /api/aip/control/arch-eval/run   {set?, max_usd?, live?, only?} → dry lists the questions; live starts a job
    GET  /api/aip/control/arch-eval/jobs/{id}                              the job's status, rows so far and log tail

Results land next to the golden runs: <data>/aip/arch-eval/runs/<time>-orkestrator.json ({summary, rows}).
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
PER_QUESTION_TIMEOUT_S = 1500
POLL_S = 3

_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def load_set(set_id: str) -> dict:
    return json.loads((GOLDEN_DIR / f"{set_id}.json").read_text("utf-8"))


def dry_list(set_id: str) -> dict[str, Any]:
    gs = load_set(set_id)
    return {"set": set_id, "name": gs.get("name"), "questions": [{"id": q["id"], "q": q["q"]} for q in gs["questions"]]}


def extract_answer_tools(events: list[dict]) -> tuple[str, list[str]]:
    """The run's final answer and the successful tools behind it, from raw run events.

    Mirrors what the page shows: the `answer` event wins, otherwise the last `draft`. Tools are the successful
    `tool` steps in first-seen order — the same surface the golden `must_call` check reads."""
    answer = ""
    for e in events:
        if e.get("type") == "answer" and e.get("text"):
            answer = str(e["text"])
    if not answer:
        drafts = [e for e in events if e.get("type") == "draft" and e.get("text")]
        if drafts:
            answer = str(drafts[-1]["text"])
    tools: list[str] = []
    for e in events:
        if e.get("type") == "tool" and e.get("ok") and e.get("tool") and e["tool"] not in tools:
            tools.append(str(e["tool"]))
    return answer, tools


def score_row(q: dict, answer: str, tools: list[str], truths: list[dict]) -> list[dict]:
    """Score one orchestrator answer with the golden checks, plus the rencana schema's `sebut` regexes.

    A question with no checkable contract at all (no must_call/truth/must_say_any/sebut) is marked unscorable
    instead of vacuously passing — an empty check list must never read as success."""
    import re

    from aip.golden import run as G

    checks = G.score(q, {"answer": answer, "steps": [{"tool": t, "ok": True} for t in tools]}, truths)
    for pattern in q.get("sebut") or []:
        try:
            hit = re.search(pattern, answer, re.IGNORECASE) is not None
        except re.error:
            hit = pattern.lower() in answer.lower()
        checks.append({"check": f"menyebut /{pattern}/", "ok": hit})
    if not checks:
        checks.append({"check": "tidak ada kontrak yang bisa dinilai (tanpa must_call/truth/must_say_any/sebut)",
                       "ok": False, "unscorable": True})
    return checks


def _runs_root() -> Path:
    from aip import vertex as aip_vertex

    root = aip_vertex.DIR.parent / "arch-eval" / "runs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def list_arch_runs(limit: int = 20) -> list[dict[str, Any]]:
    try:
        # names carry the timestamp, so ties in the (coarse, on Windows) mtime stay deterministic
        files = sorted(_runs_root().glob("*-orkestrator.json"),
                       key=lambda p: (p.stat().st_mtime, p.name), reverse=True)[:limit]
    except Exception:
        return []
    out = []
    for f in files:
        try:
            out.append({"file": f.name, **json.loads(f.read_text("utf-8"))["summary"]})
        except Exception:
            continue
    return out


def latest_arch() -> Optional[dict[str, Any]]:
    try:
        files = sorted(_runs_root().glob("*-orkestrator.json"),
                       key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    except Exception:
        return None
    if not files:
        return None
    try:
        doc = json.loads(files[0].read_text("utf-8"))
    except Exception:
        return None
    return {"summary": doc.get("summary"),
            "failed": [{"id": r.get("id"), "q": r.get("q"), "missed": [c.get("check") for c in r.get("checks") or [] if not c.get("ok")],
                        "error": r.get("error"), "tools": r.get("tools"), "secs": r.get("secs"), "usd": r.get("usd")}
                       for r in doc.get("rows") or [] if r.get("pass") is False or r.get("skipped")],
            "rows": [{"id": r.get("id"), "pass": r.get("pass"), "secs": r.get("secs"), "usd": r.get("usd")} for r in doc.get("rows") or []]}


def start_job(set_id: str, max_usd: float, request: Any, only: str = "", skip: str = "") -> dict[str, Any]:
    """Start the orchestrator-mode job as the requesting user. Raises HTTPException (401/404/409) like the runs API."""
    import auth
    from fastapi import HTTPException
    from aip import runs as aip_runs

    try:
        principal = aip_runs._principal()
    except Exception:
        raise HTTPException(401, "sign in to run the architecture evaluation")
    api = aip_runs.internal_api(request)
    with _jobs_lock:
        if any(j["status"] == "running" for j in _jobs.values()):
            running = next(j["id"] for j in _jobs.values() if j["status"] == "running")
            raise HTTPException(409, f"evaluasi {running} masih berjalan; satu evaluasi dalam satu waktu")
        job_id = f"arch-{uuid.uuid4().hex[:10]}"
        job = {"id": job_id, "status": "running", "mode": "orkestrator", "set": set_id, "max_usd": max_usd,
               "live": True, "only": only, "skip": skip, "user": principal.get("username"),
               "user_id": principal.get("id"), "api": api,
               "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "log": [], "rows": []}
        _jobs[job_id] = job
    threading.Thread(target=_run, args=(job_id,), name=f"arch-eval-{job_id}", daemon=True).start()
    return {k: v for k, v in job.items() if k != "api"}


def job_status(job_id: str) -> dict[str, Any]:
    from fastapi import HTTPException

    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job evaluasi arsitektur tidak ditemukan (hasil tersimpan tetap ada di riwayat)")
    return {"job": {k: v for k, v in job.items() if k != "api"}, "log_tail": "\n".join(job["log"][-40:])}


def _say(job: dict, msg: str) -> None:
    job["log"].append(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {msg}")


def _run(job_id: str) -> None:
    import httpx
    import auth
    from aip import vertex as aip_vertex
    from aip.golden import run as G

    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return
    token: Optional[str] = None
    try:
        gs = load_set(job["set"])
        skipped = set(x for x in (job.get("skip") or "").split(",") if x)
        qs = [q for q in gs["questions"]
              if (not job["only"] or q["id"] in job["only"].split(",")) and q["id"] not in skipped]
        if skipped:
            _say(job, f"melewati {len(skipped)} soal di luar domain: {', '.join(sorted(skipped))}")
        uid = job["user_id"]
        token = auth.issue_job_token(uid if uid != "local" else None, 7200, f"arch-eval:{job_id}") or ""
        if not token:
            raise RuntimeError("could not mint a job token for this user")
        client = httpx.Client(base_url=job["api"], timeout=180,
                              headers={"authorization": f"Bearer {token}", "origin": job["api"], "referer": job["api"] + "/"})
        me = client.get("/api/auth/me")
        if me.status_code != 200:
            raise RuntimeError(f"job token was refused ({me.status_code}): sign in again and retry")
        start_usd = aip_vertex.spend()["total_usd"]
        out = _runs_root() / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-orkestrator.json"
        rows: list[dict] = []
        capped = False

        def save(final: bool) -> dict:
            done = [r for r in rows if "pass" in r]
            summary = {"mode": "orkestrator", "set": job["set"], "user": job.get("user"),
                       "complete": bool(final and not capped), "capped": capped,
                       "note": f"berhenti di batas biaya ${job['max_usd']:.2f}; {len(done)} dari {len(qs)} soal terjawab" if capped else None,
                       "time": datetime.now(timezone.utc).isoformat(timespec="seconds"), "questions": len(qs),
                       "answered": len(done), "passed": sum(r["pass"] for r in done),
                       "usd": round(aip_vertex.spend()["total_usd"] - start_usd, 6),
                       "avg_secs": round(sum(r["secs"] for r in done) / len(done), 1) if done else None}
            out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1), "utf-8")
            return summary

        for q in qs:
            if aip_vertex.spend()["total_usd"] - start_usd >= job["max_usd"]:
                if not capped:
                    capped = True
                    with _jobs_lock:
                        job["capped"] = True
                    _say(job, f"batas biaya ${job['max_usd']:.2f} tercapai — sisa soal dilewati, hasil sejauh ini TETAP tersimpan")
                rows.append({"id": q["id"], "skipped": f"run cap ${job['max_usd']:.2f} reached"})
                with _jobs_lock:
                    job["rows"] = [{"id": x.get("id"), "pass": x.get("pass"), "secs": x.get("secs")} for x in rows]
                save(False)
                continue
            t0, tok0, usd0 = time.time(), 0, aip_vertex.spend()["total_usd"]
            try:
                truths = G._truths(client, q)
                ask = client.post("/api/aip/ask", json={"q": q["q"], "history": []})
                if ask.status_code == 429:
                    rows.append({"id": q["id"], "error": ask.json().get("detail", "daily cap")[:200]})
                    _say(job, f"{q['id']}: BERHENTI — {rows[-1]['error']}")
                    break
                ask.raise_for_status()
                rid = ask.json()["run"]
                events: list[dict] = []
                after, rec, deadline = 0, {}, time.time() + PER_QUESTION_TIMEOUT_S
                while True:
                    r = client.get(f"/api/aip/runs/{rid}", params={"after": after})
                    r.raise_for_status()
                    body = r.json()
                    events.extend(body.get("events") or [])
                    after = body.get("next", after)
                    rec = body.get("run") or {}
                    if rec.get("status") != "running":
                        break
                    if time.time() > deadline:
                        client.post(f"/api/aip/runs/{rid}/cancel")
                        raise TimeoutError(f"run {rid} passed {PER_QUESTION_TIMEOUT_S}s, cancelled")
                    time.sleep(POLL_S)
                answer, tools = extract_answer_tools(events)
                checks = score_row(q, answer, tools, truths)
                rows.append({"id": q["id"], "q": q["q"], "pass": all(c["ok"] for c in checks), "checks": checks,
                             "answer": answer[:4000], "tools": tools, "usd": round(aip_vertex.spend()["total_usd"] - usd0, 6),
                             "secs": round(time.time() - t0, 1)})
            except Exception as e:
                rows.append({"id": q["id"], "q": q["q"], "error": f"{type(e).__name__}: {e}"[:300],
                             "secs": round(time.time() - t0, 1)})
            r = rows[-1]
            _say(job, f"{'PASS' if r.get('pass') else 'FAIL' if 'pass' in r else 'SKIP/ERR'}  {r['id']}  {r.get('secs')}s  "
                      + (", ".join(r.get("tools") or []) or r.get("error", ""))[:160])
            with _jobs_lock:
                job["rows"] = [k for k in ({"id": x.get("id"), "pass": x.get("pass"), "secs": x.get("secs")} for x in rows)]
            save(False)
        summary = save(True)
        with _jobs_lock:
            job["status"] = "selesai"
            job["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _say(job, f"selesai: {summary['passed']}/{summary['answered']} lulus, ${summary['usd']}"
                  + (" (TERBATAS BIAYA — hasil parsial tersimpan)" if capped else ""))
    except Exception as e:
        # whatever failed, the rows answered so far are already on disk (save(False) per question);
        # try once more so the file also records the failure itself
        try:
            if "out" in dir() and "rows" in dir():
                save(False)
        except Exception:
            pass
        with _jobs_lock:
            job["status"] = "gagal"
            job["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _say(job, f"GAGAL: {type(e).__name__}: {e} — hasil sejauh ini TETAP tersimpan"[:300])
    finally:
        try:
            if token:
                auth.revoke_job_token(token)
        except Exception:
            pass
