r"""Tuning the chat orchestrator's planning rules per model with GEPA — the reflective prompt optimizer of the DSPy
authors (github.com/gepa-ai/gepa, the engine dspy.GEPA wraps) — scored on a question set whose right plans are known
(aip/golden/rencana.json).

Why: the planner's rules (adk_runtime/agents.PLAN_RULES) were written against GLM-5.2, whose Vertex preview is
guaranteed only through 2026-10-31; another model reads the same rules differently. GEPA asks the model under test for
plans, reads what the score below says went wrong, has a reflection model rewrite the rules, and keeps the versions that
score better on questions it reflects on (latih) and on questions it only scores (val). The questions marked uji are
never shown to it: the result compares the code's rules with the tuned rules there, each question asked REPEAT times.

    ..\.venv-adk\Scripts\python -m aip.optimasi                                       dry run: the set, the split, the cost guess
    ..\.venv-adk\Scripts\python -m aip.optimasi --live --model vertex/deepseek-ai/deepseek-v4.1-flash-maas
    ..\.venv-adk\Scripts\python -m aip.optimasi --live --model vertex/openai/gpt-oss-120b-maas --eval-only

Run from api/ in .venv-adk with gepa installed (uv pip install --python ..\.venv-adk\Scripts\python.exe gepa==0.1.4).
The prompt is the runtime's own (agents.planner_text, as ADK sends it: the instruction and its identity line as the system
message, the question as the user message, the planner's max_tokens and temperature, the model's thinking setting). The
agent catalogue is the running API's (--api), read as the e2e admin account (BLUESANDAI_E2E_TOKEN, or
BLUESANDAI_E2E_USER/PASSWORD in .env.local), and saved with the result. Every model call goes through the Vertex spend
guard (aip/vertex.py) and books into the server's ledger; --max-usd stops the tuning once this run has spent that much.

The score of a plan is plain code (score_plan), with the runtime's own gates (main._quantities, the fast route's limits):
the route against the label, the domain agents it needs and none it does not, the number of tasks (one per scope), one
task for the ML agent, the scopes the tasks must name, the focus of a follow-up, the contract (3–6 statements), each
task's skill, the summary for data that is not there, and what must not appear. Each miss is a line of feedback, which
is what the reflection model reads. A tuned version that scores higher on uji is posted as a proposal
(POST /api/aip/skills/aturan): it changes nothing until an admin switches it on.
Results: <data>/aip/optimasi/<time>-<model>.json (and GEPA's own run directory next to it).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import requests

API_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API_DIR))

from aip import models as aip_models  # noqa: E402
from aip import skills as aip_skills  # noqa: E402
from aip import vertex as aip_vertex  # noqa: E402
from aip.adk_runtime import agents as A  # noqa: E402
from aip.adk_runtime.main import MAX_TASKS, _quantities  # noqa: E402
from mailer import env  # noqa: E402

DATA = Path(os.environ.get("BLUESANDAI_DATA_DIR", API_DIR.parent / "data"))
SETS = Path(__file__).resolve().parent / "golden"
PLAN_TOKENS, PLAN_TEMPERATURE = 3000, 0.1  # agents.planner: m.llm(planner, "orkestrator", 3000), temperature 0.1
IDENTITY = 'You are an agent. Your internal name is "orkestrator".'  # what ADK appends to an agent's instruction
REFLECT_MODEL = aip_models.GLM  # thinking: the strongest model on the project writes the rules its successor runs on
REFLECT_TOKENS, REFLECT_TIMEOUT = 12000, 360
WEIGHTS = {"jalur": 0.30, "agen": 0.30, "tugas": 0.20, "struktur": 0.20, "cakupan": 0.10, "fokus": 0.10}  # the last two only when labelled
NOT_THERE = "tidak (tersedia|ada|memuat|mencatat|dimiliki|terdapat|tercatat)|bukan bagian|belum tersedia"


# ------------------------------------------------------------------------------------------------ the score (plain code)


def route_of(plan: dict, cat: dict) -> tuple[str, list[str], list[dict]]:
    """The route the runtime takes with this plan (adk_runtime/main.ask's gates), why it differs from the plan's own,
    and the tasks it keeps (known agents, an instruction, at most MAX_TASKS)."""
    agents = {a["key"]: a for a in cat["agents"]}
    jalur = str(plan.get("jalur") or "").strip().lower()
    tasks = [t for t in plan.get("tugas") or [] if isinstance(t, dict) and t.get("agen") in agents and str(t.get("instruksi") or "").strip()][:MAX_TASKS]
    notes = []
    if jalur == "langsung" and str(plan.get("jawaban") or "").strip():
        found = _quantities(str(plan["jawaban"]))
        if not found:
            return "langsung", notes, []
        notes.append(f"jawaban langsung memuat angka ({', '.join(found[:4])}): gerbang kode mengalihkannya ke agen — jawaban langsung tidak boleh memuat angka apa pun, "
                     "termasuk nomor atau tahun peraturan")
    if jalur == "cepat":
        ml = [t for t in tasks if "kartu_model_ml" in (agents[t["agen"]].get("tools") or [])]
        if len(tasks) <= 2 and not ml:
            return "cepat", notes, tasks
        notes.append("jalur cepat ditolak kode (" + ("lebih dari 2 tugas" if len(tasks) > 2 else "ada tugas untuk Agen Machine Learning") + "): dijalankan alur lengkap")
    if jalur == "audit" and (isinstance(plan.get("audit"), dict) or (isinstance(plan.get("audit"), list) and any(isinstance(x, dict) for x in plan["audit"]))):
        # main.ask: the audit pack (a pack per scope for a comparison), and at most 2 tasks beside it
        return "audit", notes, tasks[:2]
    return "agen", notes, tasks


def _skill_fits(skills: dict, task: dict) -> bool:
    s = skills.get(str(task.get("skill") or ""))
    return bool(s) and (not s.get("agen") or task["agen"] in s["agen"])


def score_plan(text: str, item: dict, cat: dict) -> dict:
    """{score 0–1, feedback lines, route, parts}: how close a plan is to the item's label, in the runtime's terms."""
    try:
        plan = A.parse_json(text)
    except ValueError:
        plan = None
    if not isinstance(plan, dict):
        return {"score": 0.0, "feedback": ["jawaban model bukan JSON rencana yang bisa dibaca kode: tidak ada rencana sama sekali (jawab HANYA JSON)"],
                "jalur": None, "bagian": {}}
    route, fb, tasks = route_of(plan, cat)
    want, why = item["jalur"], item.get("alasan", "")
    bad = re.compile(item["dilarang"], re.I) if item.get("dilarang") else None
    said = " ".join(str(plan.get(k) or "") for k in ("ringkasan", "jawaban")) + " " + " ".join(str(t.get("instruksi") or "") for t in tasks)
    if route == "langsung":
        if "langsung" not in want:
            return {"score": 0.0, "jalur": route, "bagian": {}, "feedback": fb + [
                f"jalur: rencana menjawab langsung tanpa membaca data, padahal pertanyaan ini butuh agen ({why}); yang benar: {' atau '.join(want)}"]}
        answer = str(plan["jawaban"]).strip()
        sentences = len([s for s in re.split(r"(?<=[.!?])\s+", answer) if s.strip()])
        limit = 2 if item.get("suara") else 4
        parts = {"jalur": 1.0, "panjang": 1.0 if sentences <= limit else max(0.0, 1 - (sentences - limit) / limit), "bersih": 1.0,
                 "kosong": 1.0 if not plan.get("tugas") and not plan.get("kontrak") else 0.5}
        if sentences > limit:
            fb.append(f"jawaban langsung {sentences} kalimat, batasnya {limit}" + (" (mode suara)" if item.get("suara") else ""))
        if bad and bad.search(said):
            parts["bersih"] = 0.0
            fb.append(f"rencana memuat yang tidak boleh ada ({bad.search(said).group(0)}): {why}")
        if parts["kosong"] < 1:
            fb.append("jalur langsung ditulis tanpa tugas dan tanpa kontrak")
        score = 0.5 * parts["jalur"] + 0.2 * parts["panjang"] + 0.2 * parts["bersih"] + 0.1 * parts["kosong"]
        return {"score": round(score, 4), "jalur": route, "bagian": parts, "feedback": fb or ["rencana sesuai label"]}
    if want == ["langsung"]:
        return {"score": 0.0, "jalur": route, "bagian": {}, "feedback": fb + [
            f"jalur: rencana memanggil agen ({route}), padahal pertanyaan ini tidak butuh data ({why}); yang benar: jalur langsung — tanpa tugas dan kontrak, "
            "jawaban singkat tanpa angka"]}
    if route == "audit":  # the pack reads what the claims and facility agents hold (claims, the box, the tags)
        tasks = tasks + [{"agen": k, "instruksi": "paket audit"} for k in ("klaim_fraud", "faskes_wilayah")]
    if not tasks:  # main.ask: the claims agent takes the question as it is
        default = next((a["key"] for a in cat["agents"] if a["key"].startswith("klaim")), cat["agents"][0]["key"])
        tasks = [{"agen": default, "instruksi": item["q"]}]
        fb.append(f"rencana tanpa tugas yang bisa dijalankan (agen tidak dikenal atau tanpa instruksi): kode memberi pertanyaan mentah ke {default}")
    parts: dict[str, float] = {}
    if route in want or (route == "audit" and "agen" in want):
        parts["jalur"] = 1.0
    elif route == "audit":
        parts["jalur"] = 0.6
        fb.append(f"jalur: paket audit dipakai untuk pertanyaan yang cukup dibaca ({why}) — jalur cepat menjawab lebih cepat")
    elif route == "agen":
        parts["jalur"] = 0.6
        fb.append(f"jalur: alur lengkap dipakai untuk pertanyaan yang cukup dibaca ({why}) — jalur cepat (paling banyak 2 tugas) menjawab lebih cepat")
    else:
        parts["jalur"] = 0.4
        fb.append(f"jalur: jalur cepat dipakai untuk pertanyaan yang butuh alur lengkap ({why})")
    keys = [t["agen"] for t in tasks]
    groups = item.get("agen") or []
    for g in groups:
        if not any(k in g for k in keys):
            fb.append(f"agen: tidak ada tugas untuk {' atau '.join(g)} ({why})")
    allowed = {k for g in groups for k in g} | set(item.get("agen_boleh") or [])
    extra = sorted({k for k in keys if allowed and k not in allowed})
    if extra:
        fb.append(f"agen: {', '.join(extra)} tidak dibutuhkan pertanyaan ini ({why})")
    recall = sum(any(k in g for k in keys) for g in groups) / len(groups) if groups else 1.0
    precision = 1 - sum(k not in allowed for k in keys) / len(keys) if allowed else 1.0
    parts["agen"] = 0.7 * recall + 0.3 * precision
    lo, hi = item.get("tugas") or [1, MAX_TASKS]
    n = len(tasks)
    parts["tugas"] = 1.0 if lo <= n <= hi else n / lo if n < lo else hi / n
    if n < lo:
        fb.append(f"tugas: {n}, pertanyaan ini butuh paling sedikit {lo} (satu tugas per cakupan yang disebut)")
    if n > hi:
        fb.append(f"tugas: {n}, paling banyak {hi} untuk pertanyaan ini — tugas yang tidak diperlukan memperlambat jawaban")
    for k in item.get("satu_tugas") or []:
        if keys.count(k) > 1:
            parts["tugas"] *= 0.5
            fb.append(f"tugas: {keys.count(k)} tugas untuk {k}, mestinya SATU (agen itu membentuk sub-agennya sendiri)")
    if item.get("sebut"):
        scope = " ".join(f"{t.get('cakupan') or ''} {t.get('instruksi') or ''}" for t in tasks)
        missing = [s for s in item["sebut"] if not re.search(s, scope, re.I)]
        parts["cakupan"] = 1 - len(missing) / len(item["sebut"])
        if missing:
            fb.append(f"cakupan: tugas tidak menyebut {', '.join(missing)} — setiap cakupan yang ditanyakan dikerjakan dan disebut di tugasnya")
    if item.get("fokus"):
        fokus = " ".join(str(x) for x in plan.get("fokus") or []).lower()
        missing = [f for f in item["fokus"] if f.lower() not in fokus]
        parts["fokus"] = 1 - len(missing) / len(item["fokus"])
        if missing:
            fb.append(f"fokus: pertanyaan lanjutan tentang {', '.join(missing)} (dari percakapan), tetapi \"fokus\" berisi {plan.get('fokus') or '[]'}")
    checks = []
    contract = [c for c in plan.get("kontrak") or [] if str(c).strip()]
    checks.append(3 <= len(contract) <= 6)
    if not checks[-1]:
        fb.append(f"kontrak: {len(contract)} pernyataan, harus 3–6 (ditulis sebelum agen bekerja)")
    skills = {s["key"]: s for s in cat.get("skills") or [] if s.get("alur") == "tanya_jawab"}
    misfit = [f"{t['agen']}:{t.get('skill') or '-'}" for t in tasks if t.get("skill") is not None and not _skill_fits(skills, t)]
    checks.append(not misfit)
    if misfit:
        fb.append(f"skill: {', '.join(misfit)} bukan skill tanya-jawab untuk agen itu")
    if item.get("ringkasan"):
        checks.append(bool(re.search(item["ringkasan"], str(plan.get("ringkasan") or ""), re.I)))
        if not checks[-1]:
            fb.append(f"ringkasan: tidak menyebut bahwa sebagian data tidak tersedia ({why})")
    if bad:
        checks.append(not bad.search(said))
        if not checks[-1]:
            fb.append(f"rencana memuat yang tidak boleh ada ({bad.search(said).group(0)}): {why}")
    parts["struktur"] = sum(checks) / len(checks)
    score = sum(WEIGHTS[k] * v for k, v in parts.items()) / sum(WEIGHTS[k] for k in parts)
    return {"score": round(score, 4), "jalur": route, "bagian": {k: round(v, 3) for k, v in parts.items()}, "feedback": fb or ["rencana sesuai label"]}


# ------------------------------------------------------------------------------------------------ model calls (spend guard)


def _body(model: str, system: str, user: str, max_tokens: int, temperature: float, think: bool) -> dict:
    """The body the gateway forwards for this model with agents.Models.llm's settings: gpt-oss low reasoning (medium
    when thinking), GLM without thinking unless asked."""
    body = {"model": aip_models.publisher_model(model), "max_tokens": max_tokens, "temperature": temperature,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    fam = aip_models.family(model)
    if fam == "openai":
        body["reasoning_effort"] = "medium" if think else "low"
    if fam == "zai-org" and not think:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    return body


def call(model: str, system: str, user: str, max_tokens: int, temperature: float, think: bool = False, timeout: float = 0) -> dict:
    """One answer inside the spend guard: {text, usage, secs, error}. A quota refusal or a 5xx is waited out on the SAME
    model (the gateway's failover would score another model's plan)."""
    body, t0, why = _body(model, system, user, max_tokens, temperature, think), time.time(), ""
    for pause in (0, 6, 15, 30):
        if pause:
            time.sleep(pause)
        try:
            r = aip_vertex.post(model, body, timeout or aip_models.attempt_timeout(max_tokens))
        except (requests.Timeout, requests.ConnectionError) as e:
            why = type(e).__name__
            continue
        except OSError as e:  # the ledger file held by another reader on Windows (its replace failed): try again
            why = f"{type(e).__name__}: {e}"[:200]
            continue
        if r.status_code == 200:
            payload = r.json()
            text = ((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            if "</think>" in text:  # GLM writes its reasoning into the answer (the gateway's _repair)
                text = text.rsplit("</think>", 1)[1]
            try:
                text, _ = aip_vertex.repair_harmony(text, [], False)
            except ValueError as e:
                return {"text": "", "usage": payload.get("usage") or {}, "secs": round(time.time() - t0, 1), "error": str(e)}
            return {"text": text.strip(), "usage": payload.get("usage") or {}, "secs": round(time.time() - t0, 1), "error": ""}
        why = f"HTTP {r.status_code}: {r.text[:200]}"
        if r.status_code not in (429, 500, 502, 503, 504):
            break
    return {"text": "", "usage": {}, "secs": round(time.time() - t0, 1), "error": why}


def ask_plan(model: str, rules: str, item: dict, cat: dict, histories: dict) -> dict:
    """The planner's answer to one question with these rules, as a run would get it (system = instruction + identity)."""
    hist = histories.get(item.get("riwayat") or "", [])
    system = A.planner_text(cat, item["q"], hist, bool(item.get("suara")), rules) + "\n\n" + IDENTITY
    return call(model, system, item["q"], PLAN_TOKENS, PLAN_TEMPERATURE)


def reflect(prompt: Any) -> str:
    """GEPA's reflection model: GLM-5.2 thinking, one call."""
    user = prompt if isinstance(prompt, str) else "\n\n".join(str(m.get("content") or "") for m in prompt)
    got = call(REFLECT_MODEL, "Anda menyempurnakan prompt agen. Ikuti format keluaran yang diminta.", user, REFLECT_TOKENS, 0.7, think=True,
               timeout=REFLECT_TIMEOUT)
    if got["error"]:
        raise RuntimeError(f"reflection model: {got['error']}")
    return got["text"]


# what the reflection model reads (GEPA fills <curr_param> and <side_info>); it writes the rules, the code the rest
REFLECT = """Anda menyempurnakan ATURAN PERENCANAAN orkestrator AIP JKN (BPJS Kesehatan): bagian prompt yang memberi tahu model
perencana cara menyusun rencana untuk pertanyaan auditor — jalur (langsung / cepat / agen), tugas sempit untuk agen domain, kontrak
validasi, fokus pertanyaan lanjutan. Bagian lain prompt ditulis kode dan TIDAK Anda tulis: daftar agen dan objeknya, pertanyaan,
percakapan sebelumnya, daftar skill dan bentuk JSON jawaban (kunci ringkasan, jalur, fokus, tugas [agen, skill, cakupan, instruksi],
kontrak, jawaban).

Agen yang tersedia (key: nama — objeknya):
<agents>

Aturan saat ini:
```
<curr_param>
```

Contoh pertanyaan, rencana yang dihasilkan model perencana dengan aturan itu, dan umpan balik penilai (kode deterministik yang tahu
rencana yang benar) atas setiap rencana:
```
<side_info>
```

Tulis aturan baru yang memperbaiki kesalahan di umpan balik tanpa merusak yang sudah benar:
- bahasa Indonesia, ringkas dan tegas, sebagai aturan UMUM yang berlaku untuk pertanyaan lain juga: penilai menguji pada pertanyaan
  yang tidak Anda lihat, jadi jangan menyalin pertanyaan contoh, nama wilayah/faskes atau angka dari contoh;
- boleh menambah kriteria pemilihan jalur dan agen yang jelas (mis. objek mana milik agen mana, kapan cukup dibaca), dan contoh
  umum yang singkat;
- pertahankan larangan yang ada: jawaban langsung tanpa angka (termasuk nomor/tahun peraturan); data yang tidak ada di properti
  disebut tidak tersedia di ringkasan, tidak dicari; satu tugas untuk Agen Machine Learning; paling banyak 16 tugas; kontrak 3–6
  pernyataan; action hanya diusulkan, manusia yang memutuskan;
- jangan menulis daftar agen, daftar skill, bentuk JSON atau blok kode di dalam aturan — kode yang menambahkannya;
- paling banyak sekitar 6.500 karakter (model perencana membacanya di setiap pertanyaan).
Tulis aturan baru di dalam SATU blok ``` dan tidak ada yang lain."""


class Planner:
    """The GEPA adapter. A candidate is {"aturan": <rules>}; evaluate asks the model for each question's plan with the
    runtime's prompt and scores it; the reflective dataset is each question, its plan and the score's feedback."""

    propose_new_texts = None  # GEPA's own proposer, with the REFLECT template

    def __init__(self, model: str, cat: dict, histories: dict, workers: int, log: list):
        self.model, self.cat, self.histories, self.workers, self.log = model, cat, histories, workers, log

    def one(self, item: dict, rules: str) -> dict:
        got = ask_plan(self.model, rules, item, self.cat, self.histories)
        s = score_plan(got["text"], item, self.cat) if not got["error"] else {"score": 0.0, "jalur": None, "bagian": {},
                                                                              "feedback": [f"model tidak menjawab: {got['error']}"]}
        return {"id": item["id"], "score": s["score"], "jalur": s["jalur"], "bagian": s["bagian"], "feedback": s["feedback"], "text": got["text"],
                "usage": got["usage"], "secs": got["secs"], "error": got["error"]}

    def run(self, items: list[dict], rules: str) -> list[dict]:
        with ThreadPoolExecutor(self.workers) as ex:
            return list(ex.map(lambda it: self.one(it, rules), items))

    def evaluate(self, batch: list[dict], candidate: dict, capture_traces: bool = False) -> Any:
        from gepa import EvaluationBatch

        rules = candidate["aturan"]
        why = aip_skills.check_rules("rencana", rules)
        if why:  # the gate the store applies: a version it would refuse scores nothing
            rows = [{"id": it["id"], "score": 0.0, "feedback": [f"aturan ditolak gerbang kode sebelum dipakai: {why}"], "text": ""} for it in batch]
        else:
            rows = self.run(batch, rules)
        mean = sum(r["score"] for r in rows) / max(1, len(rows))
        self.log.append({"pada": datetime.now(timezone.utc).isoformat(timespec="seconds"), "n": len(rows), "rata": round(mean, 4),
                         "panjang_aturan": len(rules), "jejak": capture_traces})
        print(f"    nilai {len(rows):>2} rencana: rata {mean:.3f}  (aturan {len(rules)} karakter{', jejak' if capture_traces else ''})", flush=True)
        return EvaluationBatch(outputs=rows, scores=[r["score"] for r in rows],
                               trajectories=[{"item": it, **r} for it, r in zip(batch, rows)] if capture_traces else None)

    def make_reflective_dataset(self, candidate: dict, eval_batch: Any, components_to_update: list[str]) -> dict:
        records = []
        for tr in eval_batch.trajectories or []:
            it = tr["item"]
            rec = {"Pertanyaan": it["q"] + (" (mode suara)" if it.get("suara") else "")}
            hist = self.histories.get(it.get("riwayat") or "")
            if hist:
                rec["Percakapan sebelumnya (dipotong)"] = " | ".join(f"{h['role']}: {h['text'][:300]}" for h in hist)
            rec["Rencana model"] = (tr.get("text") or "(tidak ada jawaban)")[:2500]
            rec["Skor"] = f"{tr['score']:.2f} dari 1"
            rec["Umpan balik penilai"] = "\n".join(tr.get("feedback") or [])
            records.append(rec)
        return {name: records for name in components_to_update}


# ------------------------------------------------------------------------------------------------ the run


def _sign_in(api: str) -> httpx.Client:
    """A client signed in as the e2e admin: an API token (BLUESANDAI_E2E_TOKEN) or a password sign-in."""
    base = {"origin": api.rstrip("/")}
    if env("BLUESANDAI_E2E_TOKEN"):
        return httpx.Client(base_url=api.rstrip("/"), timeout=120, headers={**base, "authorization": f"Bearer {env('BLUESANDAI_E2E_TOKEN')}"})
    user, password = env("BLUESANDAI_E2E_USER"), env("BLUESANDAI_E2E_PASSWORD")
    if not (user and password):
        sys.exit("Set BLUESANDAI_E2E_TOKEN or BLUESANDAI_E2E_USER/PASSWORD in .env.local (the e2e admin account) to run live.")
    client = httpx.Client(base_url=api.rstrip("/"), timeout=120, headers=base)
    r = client.post("/api/auth/login", json={"username": user, "password": password})
    if r.status_code != 200 or (r.json() or {}).get("mfa_required"):
        sys.exit(f"sign-in as {user} failed: {r.status_code} {r.text[:200]}")
    return client


def summary(rows: list[dict]) -> dict:
    by_item: dict[str, list[float]] = {}
    for r in rows:
        by_item.setdefault(r["id"], []).append(r["score"])
    usage = [r.get("usage") or {} for r in rows]
    return {"rata": round(statistics.mean(r["score"] for r in rows), 4) if rows else None, "butir": {k: round(statistics.mean(v), 4) for k, v in by_item.items()},
            "sempurna": sum(r["score"] >= 0.999 for r in rows), "rencana": len(rows), "galat": sum(bool(r.get("error")) for r in rows),
            "detik_median": statistics.median(r.get("secs") or 0 for r in rows) if rows else None,
            "token_keluar_median": statistics.median(int(u.get("completion_tokens") or 0) for u in usage) if usage else None}


def paired(before: dict, after: dict, seed: int = 0, n: int = 4000) -> dict:
    """The tuned rules against the code's on the same held-out questions: the mean difference per question with a 95%
    bootstrap interval over questions, and how many questions got better, worse, or stayed."""
    ids = sorted(set(before) & set(after))
    diffs = [after[i] - before[i] for i in ids]
    rng = random.Random(seed)
    boots = sorted(statistics.mean(rng.choice(diffs) for _ in diffs) for _ in range(n)) if diffs else []
    return {"n": len(ids), "selisih_rata": round(statistics.mean(diffs), 4) if diffs else None,
            "ik95": [round(boots[int(0.025 * n)], 4), round(boots[int(0.975 * n) - 1], 4)] if boots else None,
            "naik": sum(d > 0.001 for d in diffs), "turun": sum(d < -0.001 for d in diffs), "sama": sum(abs(d) <= 0.001 for d in diffs)}


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True, encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", default="rencana", help="question set (a .json file in aip/golden)")
    ap.add_argument("--model", default=aip_models.DEEPSEEK, help="the planner model the rules are tuned for")
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--live", action="store_true", help="call the models; without it nothing is called")
    ap.add_argument("--eval-only", action="store_true", help="score the code's rules (PLAN_RULES) on uji, no tuning")
    ap.add_argument("--budget", type=int, default=320, help="GEPA's metric calls (plans scored while tuning)")
    ap.add_argument("--repeat", type=int, default=3, help="times each uji question is asked per version")
    ap.add_argument("--workers", type=int, default=8, help="plans asked at once")
    ap.add_argument("--max-usd", type=float, default=15.0, help="stop tuning once this run has spent this much on Vertex")
    ap.add_argument("--no-post", action="store_true", help="keep the tuned rules in the result file only")
    a = ap.parse_args()
    if a.model not in aip_models.MODELS or not aip_models.ready(a.model):
        sys.exit(f"{a.model} is not a ready model of the registry")

    gs = json.loads((SETS / f"{a.set}.json").read_text("utf-8"))
    items, histories = gs["questions"], gs.get("riwayat") or {}
    split = {b: [q for q in items if q["bagian"] == b] for b in ("latih", "val", "uji")}
    est_in = 1.15 * len(A.PLAN_RULES) / 3.2 + 4500  # the catalogue and the skills are about 4.5k tokens
    per = aip_models.cost(a.model, {"prompt_tokens": int(est_in), "completion_tokens": 700})
    calls = a.repeat * len(split["uji"]) * (1 if a.eval_only else 2) + (0 if a.eval_only else a.budget)
    print(f"{gs['name']}: {len(items)} pertanyaan — latih {len(split['latih'])}, val {len(split['val'])}, uji {len(split['uji'])}; model {a.model}")
    print(f"  ~{calls} rencana × ${per:.4f}" + ("" if a.eval_only else f" + ~{a.budget // 10} refleksi {REFLECT_MODEL}") + f", batas tuning ${a.max_usd:.2f}")
    if not a.live:
        for b, qs in split.items():
            print(f"  {b}: " + ", ".join(f"{q['id']} ({'/'.join(q['jalur'])})" for q in qs))
        print("Dry run: nothing was called. Add --live to run it.")
        return

    aip_vertex.configure(DATA, env)
    client = _sign_in(a.api)
    cat = client.get("/api/aip/agents").raise_for_status().json()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = DATA / "aip" / "optimasi" / f"{stamp}-{a.model.replace('/', '_')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    start_usd, t0, log = aip_vertex.spend()["total_usd"], time.time(), []
    adapter = Planner(a.model, cat, histories, a.workers, log)
    rec: dict[str, Any] = {"set": a.set, "versi_set": gs.get("versi"), "model": a.model, "reflektor": REFLECT_MODEL, "mulai": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                           "bagian": {b: [q["id"] for q in qs] for b, qs in split.items()}, "ulang": a.repeat, "katalog": cat, "log": log}

    def save() -> None:
        rec["usd"] = round(aip_vertex.spend()["total_usd"] - start_usd, 6)
        rec["detik"] = round(time.time() - t0)
        tmp = out.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=1, default=str), "utf-8")
        tmp.replace(out)

    uji = [q for q in split["uji"] for _ in range(a.repeat)]
    print(f"\n1. aturan kode (PLAN_RULES) pada uji, {a.repeat}× tiap pertanyaan")
    base = adapter.run(uji, A.PLAN_RULES)
    rec["uji_awal"] = {"ringkas": summary(base), "rencana": base}
    save()
    print(f"   rata {rec['uji_awal']['ringkas']['rata']}")
    if a.eval_only:
        print(f"\n{out}\n${rec['usd']:.4f}, {rec['detik']} s")
        return

    import gepa

    print(f"\n2. GEPA: {a.budget} rencana, refleksi {REFLECT_MODEL}")
    agents = "\n".join(f"- {x['key']}: {x['name']} — {', '.join(t['name'] for t in x['object_types']) or 'platform (dataset, pipeline, lineage, kode)'}" for x in cat["agents"])
    over = lambda _state: aip_vertex.spend()["total_usd"] - start_usd >= a.max_usd  # noqa: E731
    result = gepa.optimize(seed_candidate={"aturan": A.PLAN_RULES}, trainset=split["latih"], valset=split["val"], adapter=adapter,
                           reflection_lm=reflect, reflection_prompt_template=REFLECT.replace("<agents>", agents), max_metric_calls=a.budget,
                           stop_callbacks=[over], reflection_minibatch_size=4, candidate_selection_strategy="pareto", skip_perfect_score=True,
                           run_dir=str(out.with_suffix("")) + "-gepa", seed=0, raise_on_exception=False, display_progress_bar=False)
    tuned = result.best_candidate["aturan"]
    rec["gepa"] = {"kandidat": [{"aturan": c["aturan"], "val": round(s, 4), "induk": p} for c, s, p in
                                zip(result.candidates, result.val_aggregate_scores, getattr(result, "parents", [None] * len(result.candidates)))],
                   "terbaik": result.best_idx, "panggilan_metrik": result.total_metric_calls}
    save()
    print(f"   {len(result.candidates)} versi; terbaik #{result.best_idx}, val {result.val_aggregate_scores[result.best_idx]:.3f} "
          f"(versi kode {result.val_aggregate_scores[0]:.3f})")

    print(f"\n3. aturan hasil GEPA pada uji, {a.repeat}× tiap pertanyaan")
    after = adapter.run(uji, tuned) if tuned != A.PLAN_RULES else base
    rec["uji_tuned"] = {"ringkas": summary(after), "rencana": after}
    rec["banding"] = paired(rec["uji_awal"]["ringkas"]["butir"], rec["uji_tuned"]["ringkas"]["butir"])
    rec["aturan"] = tuned
    save()
    b, t, d = rec["uji_awal"]["ringkas"], rec["uji_tuned"]["ringkas"], rec["banding"]
    print(f"   uji: kode {b['rata']} → GEPA {t['rata']}  (selisih {d['selisih_rata']}, IK95 {d['ik95']}; naik {d['naik']}, turun {d['turun']}, sama {d['sama']})")

    # a proposal only for a gain the held-out questions show beyond chance (the whole 95% interval above 0): DeepSeek's
    # first run (2026-10-24) gained 0.0015 with an interval of [-0.011, 0.014] — noise an admin could mistake for better
    better = tuned != A.PLAN_RULES and bool(d["ik95"]) and d["ik95"][0] > 0
    rec["diusulkan"] = better
    if not better:
        print("   tidak diusulkan: aturan hasil GEPA tidak lebih baik secara bermakna pada uji (IK95 selisih tidak seluruhnya di atas 0)")
    if better and not a.no_post:
        label = (f"GEPA {stamp[:8]} · {aip_models.MODELS[a.model]['label']} · uji {b['rata']:.2f}→{t['rata']:.2f}")
        try:
            r = client.post("/api/aip/skills/aturan", json={"peran": "rencana", "model": a.model, "teks": tuned, "label": label, "sumber": out.name,
                                                            "skor": {"uji_awal": b["rata"], "uji_tuned": t["rata"], "banding": d, "val": rec["gepa"]["kandidat"][result.best_idx]["val"],
                                                                     "val_awal": rec["gepa"]["kandidat"][0]["val"], "set": f"{a.set} {gs.get('versi')}", "ulang": a.repeat}})
            rec["usulan"] = r.json() if r.status_code == 200 else {"galat": f"{r.status_code} {r.text[:300]}"}
        except httpx.HTTPError as e:
            rec["usulan"] = {"galat": str(e)}
        save()
        print(f"   usulan: {rec['usulan'].get('id') or rec['usulan']} — aktif setelah admin menyalakannya (POST /api/aip/skills/aturan/<id>/status)")
    print(f"\n{out}\n${rec['usd']:.4f}, {rec['detik']} s")


if __name__ == "__main__":
    main()
