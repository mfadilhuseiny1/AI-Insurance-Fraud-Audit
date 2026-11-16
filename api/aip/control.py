"""Evaluation & production-control plane for AIP JKN (the tab "Evaluasi & Kontrol" in /aip-jkn).

One read model over what production already writes, plus the one write action the control plane owns: launching a
golden-set evaluation. Nothing here invents data — every number is read from the same stores the platform uses:

    GET  /api/aip/control/overview          spend (aip/vertex.py) · run ledger (<data>/aip/runs/*/run.json +
                                            verdict events) · missions (<data>/aip/missions) · golden sets
                                            (aip/golden/*.json) and their scored runs (<data>/aip/golden/runs) ·
                                            the deployed production model (<data>/aip/produksi/deployed.json) ·
                                            the control gates, each labelled with the evidence for its status
    POST /api/aip/control/golden/run        {set?, model?, max_usd?, live?} → start `python -m aip.golden.run`
                                            as a job (dry by default; live spends behind the Vertex guard, hard-
                                            capped by max_usd, default $0.10) → {job}
    GET  /api/aip/control/golden/jobs/{id}  the job's status and log tail

Gate statuses are honest, not aspirational: "aktif" only where code enforces the control today, "manual" where a
human runs it by hand, "belum" where the audit found no enforcement yet (PHI masking before external model calls,
an automated eval gate on deploy). The tab shows the label the endpoint returns; it does not upgrade it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from aip import models as aip_models
from aip import vertex as aip_vertex

router = APIRouter(prefix="/api/aip/control")

API_DIR = Path(__file__).resolve().parent.parent
GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
MAX_RUNS_SCANNED = 300


def _data() -> Path:
    return aip_vertex.DIR.parent  # <data>/aip (runs, missions, golden, produksi sit next to vertex_spend)


def _read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return None


def _runs() -> dict[str, Any]:
    root = _data() / "runs"
    dirs = sorted((d for d in root.glob("run-*") if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)[:MAX_RUNS_SCANNED] if root.exists() else []
    recs, spent = [], 0.0
    by_status: dict[str, int] = {}
    by_kind: dict[str, int] = {}
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    last7 = 0
    for d in dirs:
        rec = _read_json(d / "run.json")
        if not rec:
            continue
        by_status[rec.get("status") or "?"] = by_status.get(rec.get("status") or "?", 0) + 1
        by_kind[rec.get("kind") or "ask"] = by_kind.get(rec.get("kind") or "ask", 0) + 1
        spent += float(rec.get("spent_usd") or 0)
        if (rec.get("created_at") or "") >= week_ago:
            last7 += 1
        if len(recs) < 25:
            usage = rec.get("agents_usage") or {}
            recs.append({"id": rec.get("id"), "kind": rec.get("kind") or "ask", "status": rec.get("status"), "q": (rec.get("q") or "")[:140],
                         "username": rec.get("username"), "spent_usd": rec.get("spent_usd"), "created_at": rec.get("created_at"),
                         "finished_at": rec.get("finished_at"), "mission_id": rec.get("mission_id"),
                         "agents": {k: {"calls": v.get("calls"), "usd": v.get("usd"), "model": v.get("model")} for k, v in usage.items()}})
    return {"scanned": len(dirs), "by_status": by_status, "by_kind": by_kind, "spent_usd": round(spent, 4), "last7": last7, "recent": recs}


def _verdicts(limit: int = 60) -> dict[str, Any]:
    """The validators' verdicts over the newest runs: checks passed/total per validator, and blocking failures.
    A blocking failure (blok=true, ok=false) is the scrutiny layer saying the answer must not ship as-is."""
    root = _data() / "runs"
    if not root.exists():
        return {"runs_with_verdict": 0, "validators": {}, "blocking_failures": []}
    dirs = sorted((d for d in root.glob("run-*") if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)[:limit]
    validators: dict[str, dict[str, int]] = {}
    blocking: list[dict[str, Any]] = []
    with_verdict = 0
    for d in dirs:
        events_path = d / "events.jsonl"
        if not events_path.exists():
            continue
        seen = False
        try:
            lines = events_path.read_text("utf-8", errors="replace").splitlines()
        except Exception:
            continue
        for line in lines:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") != "verdict":
                continue
            seen = True
            v = validators.setdefault(e.get("validator") or "validator", {"passed": 0, "total": 0, "checks_failed": 0})
            v["passed"] += int(e.get("passed") or 0)
            v["total"] += int(e.get("total") or 0)
            for c in e.get("checks") or []:
                if not c.get("ok"):
                    v["checks_failed"] += 1
                    if c.get("blok") and len(blocking) < 20:
                        blocking.append({"run": d.name, "validator": e.get("validator"), "klaim": (c.get("klaim") or "")[:180], "bukti": (c.get("bukti") or "")[:180], "t": e.get("t")})
            for c in e.get("kontrak") or []:
                if not c.get("ok"):
                    v["checks_failed"] += 1
        if seen:
            with_verdict += 1
    return {"runs_with_verdict": with_verdict, "validators": validators, "blocking_failures": blocking}


def _missions() -> dict[str, Any]:
    root = _data() / "missions"
    out: list[dict[str, Any]] = []
    by_status: dict[str, int] = {}
    spent = budget = 0.0
    if root.exists():
        for d in sorted((x for x in root.glob("mis-*") if x.is_dir()), key=lambda x: x.stat().st_mtime, reverse=True):
            m = _read_json(d / "mission.json")
            if not m:
                continue
            by_status[m.get("status") or "?"] = by_status.get(m.get("status") or "?", 0) + 1
            spent += float(m.get("spent_usd") or 0)
            budget += float(m.get("budget_usd") or 0)
            if len(out) < 15:
                out.append({"id": m.get("id"), "goal": (m.get("goal") or "")[:160], "status": m.get("status"),
                            "budget_usd": m.get("budget_usd"), "spent_usd": m.get("spent_usd")})
    return {"total": sum(by_status.values()), "by_status": by_status, "spent_usd": round(spent, 4), "budget_usd": round(budget, 4), "recent": out}


def _golden() -> dict[str, Any]:
    sets = []
    for f in sorted(GOLDEN_DIR.glob("*.json")):
        doc = _read_json(f)
        if doc and isinstance(doc.get("questions"), list):
            sets.append({"id": f.stem, "name": doc.get("name") or f.stem, "questions": len(doc["questions"]),
                         "question_ids": [q.get("id") for q in doc["questions"]]})
    runs_root = _data() / "golden" / "runs"
    runs = []
    if runs_root.exists():
        for f in sorted(runs_root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:20]:
            doc = _read_json(f)
            if doc and doc.get("summary"):
                runs.append({"file": f.name, **doc["summary"]})
    latest = None
    if runs:
        for f in sorted(runs_root.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            doc = _read_json(f)
            if not doc:
                continue
            latest = {"summary": doc.get("summary"),
                      "failed": [{"id": r.get("id"), "q": r.get("q"), "missed": [c.get("check") for c in r.get("checks") or [] if not c.get("ok")],
                                  "error": r.get("error"), "tools": r.get("tools"), "secs": r.get("secs"), "tokens": r.get("tokens"), "usd": r.get("usd")}
                                 for r in doc.get("rows") or [] if r.get("pass") is False or r.get("skipped")],
                      "rows": [{"id": r.get("id"), "pass": r.get("pass"), "secs": r.get("secs"), "tokens": r.get("tokens"), "usd": r.get("usd")}
                               for r in doc.get("rows") or []]}
            break
    return {"sets": sets, "runs": runs, "latest": latest, "models": [m for m in aip_models.MODELS if not aip_models.is_decisions(m)],  # chat models only
            "default_model": aip_models.GPT_OSS}


def _production() -> dict[str, Any]:
    dep = _read_json(_data() / "produksi" / "deployed.json") or {}
    runs_root = _data() / "produksi" / "runs"
    return {"deployed": bool(dep), "run": dep.get("run"), "pada": dep.get("pada"), "model_versi": dep.get("model_versi"),
            "segmen": {k: {"model": v.get("model"), "ambang": v.get("ambang"), "paritas_max_abs": v.get("paritas_max_abs"), "disajikan_dari": v.get("disajikan_dari")}
                       for k, v in (dep.get("signature") or {}).get("segmen", {}).items()} if isinstance((dep.get("signature") or {}).get("segmen"), dict) else {},
            "pipeline_runs": len(list(runs_root.glob("*"))) if runs_root.exists() else 0}


def _gates() -> list[dict[str, Any]]:
    caps = aip_vertex.caps()
    return [
        {"id": "spend_guard", "nama": "Penjaga biaya Vertex (caps harian/bulanan/total)", "status": "aktif",
         "bukti": f"aip/vertex.py caps() — caps saat ini: {caps}; setiap panggilan model ADK lewat gateway dan dibukukan ke ledger yang sama"},
        {"id": "job_token", "nama": "Token pekerjaan per run, dicabut saat run selesai", "status": "aktif",
         "bukti": "aip/runs.py — run berjalan sebagai pengguna pemanggil (auth.issue_job_token), melihat hanya yang boleh ia lihat"},
        {"id": "mission_budget", "nama": "Persetujuan manusia + gerbang anggaran misi", "status": "aktif",
         "bukti": "aip/missions.py — approve/extend/waive adalah aksi manusia tercatat (siapa, kapan); run misi berhenti di cap"},
        {"id": "validator", "nama": "Validator adversarial + scrutiny deterministik sebelum jawaban tampil", "status": "aktif",
         "bukti": "events.jsonl setiap run: verdict validator (klaim diperiksa ke hasil tool) dan scrutiny (rujukan/angka harus ada di hasil run ini)"},
        {"id": "karantina", "nama": "Box Karantina: keputusan klaim/faskes di tangan peninjau manusia", "status": "aktif",
         "bukti": "aip/karantina.py + tab Box Karantina — agen menandai dan memberi bukti, manusia yang memutuskan"},
        {"id": "golden_gate", "nama": "Gerbang evaluasi golden sebelum deploy (otomatis di CI)", "status": "manual",
         "bukti": "aip/golden/run.py adalah CLI yang dijalankan manusia; belum ada pemicu CI yang memblokir deploy saat regresi. Tab ini bisa menjalankannya."},
        {"id": "phi_firewall", "nama": "Firewall PHI: masking NIK/diagnosis sebelum panggilan model eksternal", "status": "belum",
         "bukti": "Audit eksekutif 2026-10-24 tidak menemukan lapisan masking khusus PHI; payload tool/model belum terbukti disaring. Perlakukan sebagai utang P0."},
        {"id": "autonomy_tiers", "nama": "Tingkatan otonomi per tool (READ/DRAFT/APPROVE/FORBIDDEN) ditegakkan di kode", "status": "belum",
         "bukti": "Izin hari ini mengikuti token pengguna + gerbang misi/karantina per fitur, bukan taksonomi tool terpusat; penolakan klaim belum dinyatakan FORBIDDEN di satu tempat."},
    ]


@router.get("/overview")
def overview() -> dict[str, Any]:
    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "spend": aip_vertex.spend(),
            "runs": _runs(), "verdicts": _verdicts(), "missions": _missions(), "golden": _golden(),
            "arch": _arch(), "production": _production(), "gates": _gates()}


# --- launching a golden evaluation: the control plane's one write action -------------------------------------------

_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


class GoldenRunIn(BaseModel):
    set: str = "jkn_audit"
    model: str = aip_models.GPT_OSS
    max_usd: float = Field(default=0.10, gt=0, le=5.0)
    live: bool = False  # without live nothing is called and nothing is spent (the runner's own dry run)
    only: str = ""  # comma-separated question ids to keep
    skip: str = ""  # comma-separated question ids to leave out (out-of-domain probes)


@router.post("/golden/run")
def golden_run(body: GoldenRunIn) -> dict[str, Any]:
    if not (GOLDEN_DIR / f"{body.set}.json").exists():
        raise HTTPException(404, f"golden set {body.set!r} tidak ditemukan")
    if body.live and not aip_models.is_vertex(body.model) and body.model not in aip_models.MODELS:
        raise HTTPException(400, "model tidak dikenal; evaluasi live hanya untuk model pada katalog Vertex (di balik penjaga biaya)")
    job_id = f"eval-{uuid.uuid4().hex[:10]}"
    log_dir = _data() / "golden" / "jobs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{job_id}.log"
    cmd = [sys.executable, "-m", "aip.golden.run", "--set", body.set, "--model", body.model, "--max-usd", str(body.max_usd)]
    if body.only:
        cmd += ["--only", body.only]
    if body.skip:
        cmd += ["--skip", body.skip]
    if body.live:
        cmd.append("--live")
        if not body.model.startswith(aip_models.PREFIX):
            cmd.append("--allow-unmetered")
    with _jobs_lock:
        running = [j for j in _jobs.values() if j["status"] == "running"]
        if running:
            raise HTTPException(409, f"evaluasi {running[0]['id']} masih berjalan; satu evaluasi dalam satu waktu")
        log_file = open(log_path, "w", encoding="utf-8")  # noqa: SIM115 — the child writes it; closed below on spawn failure only
        try:
            proc = subprocess.Popen(cmd, cwd=str(API_DIR), stdout=log_file, stderr=subprocess.STDOUT,
                                    env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        except Exception:
            log_file.close()
            raise
        _jobs[job_id] = {"id": job_id, "status": "running", "proc": proc, "log": str(log_path), "cmd": cmd[2:],
                         "set": body.set, "model": body.model, "max_usd": body.max_usd, "live": body.live,
                         "only": body.only, "skip": body.skip,
                         "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    return {"job": {k: v for k, v in _jobs[job_id].items() if k != "proc"}}


class ArchEvalIn(BaseModel):
    set: str = "jkn_audit"
    max_usd: float = Field(default=2.00, gt=0, le=20.0)
    live: bool = False  # without live nothing is called: the questions are listed, like the golden dry run
    only: str = ""  # comma-separated question ids, e.g. "kpi-terflag,faskes-fiktif"
    skip: str = ""  # comma-separated question ids to leave out (out-of-domain probes)


def _arch() -> dict[str, Any]:
    from aip import arch_eval as AE

    runs = AE.list_arch_runs()
    return {"runs": runs, "latest": AE.latest_arch()}


@router.post("/arch-eval/run")
def arch_eval_run(body: ArchEvalIn, request: Request) -> dict[str, Any]:
    """Run the golden set through the FULL orchestrator (or dry-list it). Acts as the requesting user."""
    from aip import arch_eval as AE

    if not (GOLDEN_DIR / f"{body.set}.json").exists():
        raise HTTPException(404, f"golden set {body.set!r} tidak ditemukan")
    if not body.live:
        return {"job": None, "dry": AE.dry_list(body.set)}
    return {"job": AE.start_job(body.set, body.max_usd, request, body.only, body.skip)}


@router.get("/arch-eval/jobs/{job_id}")
def arch_eval_job(job_id: str) -> dict[str, Any]:
    from aip import arch_eval as AE

    return AE.job_status(job_id)


@router.get("/laporan.pdf")
def laporan_pdf() -> Any:
    """The publication-ready evaluation report, rendered from the live production ledger on every request."""
    from fastapi.responses import FileResponse
    from aip import laporan as aip_laporan

    out_dir = _data() / "control"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"laporan-evaluasi-aip-jkn-{stamp}.pdf"
    aip_laporan.build_pdf(path)
    for old in sorted(out_dir.glob("laporan-evaluasi-aip-jkn-*.pdf"), key=lambda p: p.stat().st_mtime)[:-5]:
        try:
            old.unlink()
        except Exception:
            pass
    return FileResponse(str(path), media_type="application/pdf", filename=path.name)


@router.get("/golden/jobs/{job_id}")
def golden_job(job_id: str) -> dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job evaluasi tidak ditemukan (server mungkin baru restart; hasil evaluasi tetap ada di riwayat golden)")
    if job["status"] == "running" and job["proc"].poll() is not None:
        job["status"] = "selesai" if job["proc"].returncode == 0 else "gagal"
        job["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        job["returncode"] = job["proc"].returncode
    tail = ""
    try:
        tail = Path(job["log"]).read_text("utf-8", errors="replace")[-6000:]
    except Exception:
        pass
    return {"job": {k: v for k, v in job.items() if k != "proc"}, "log_tail": tail}
