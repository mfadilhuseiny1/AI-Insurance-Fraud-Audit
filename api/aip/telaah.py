"""Telaah klinis massal — Blu 1.1 (the AI orchestration before 2026-10-30 is Blu 1.0): before the swarm starts, every claim
the screening holds — Klaim Berisiko (the rules) and Skor Risiko Klaim ML (the model's riskiest), tens of
thousands of claims together — is read by a model ten at a time and given a clinical verdict; the claims it finds suspicious, and a
random 5% of the rest, are read again by a model of another family. Only a claim both families find suspicious becomes a
tag, always "lemah", and a claim only this review tagged adds nothing to the Box's loss or TSM (aip/karantina.py): the
review can open a lead, not move a facility up the box.

The user (2026-10-30): "make sure Blu 1.1 working well since if it fail it cost a lot". So:
- every verdict is kept as soon as it is paid for, one row per claim, model, prompt version and facts: a claim already
  reviewed is never paid for again (a cut run, the next engagement, the calibration the engagement starts with);
- a calibration first (the first 300 claims of the set's fixed random order, both models): the full review only runs
  when both models answer validly, agree beyond chance (weighted kappa) and the projected cost fits the ceiling;
- the runtime (adk_runtime/telaah.py) checks the ceiling before every call, stops on a run of failures, on a refused
  budget, and on an answer from a model of the wrong family (the gateway's failover would make a re-check its own judge);
- a review that stops leaves the engagement to go on as Blu 1.0, with what was reviewed kept.

The facts are the clinical review's own (aip/medis.py facts_from_row: the silver claim, its code and diagnosis peers from
the feature cache). Not given to the model: its score, the rule indications and whether the verifier corrected the claim
— the verdict stands on the clinical record, and the correction is the yardstick the calibration measures it against.

    GET  /api/aip/telaah/ringkasan          the review set, the verdicts kept per model, the last calibration, the estimate
                                            (?versi=1.3: Blu 1.3's seats, OpenAI Decisions screening and DeepSeek re-checking)
    POST /api/aip/telaah/klaim              facts of the set: a page {offset, limit}, the calibration sample, or {klaim_ids};
                                            with the verdicts already kept for the two models
    POST /api/aip/telaah/simpan             verdicts of a running run, kept at once
    POST /api/aip/telaah/kalibrasi/hasil    a calibration's numbers (running run)
    GET  /api/aip/telaah/hasil              kept verdicts by facility / province / conclusion (the agents' tool, the page)
    POST /api/aip/telaah/kalibrasi          a calibration-only run (admin): 300 claims, both models, under a dollar
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip/telaah")

PROMPT_VERSION = "2026-10-30.1"
AGENT = "telaah_klinis"  # the ledger's source of the review's tags (aip/indikasi.py REVIEW_AGENT)
BATCH = 10  # claims per call: fewer mix-ups than 25, a tenth of the calls of one per claim
SAMPLE_N = 300  # the calibration
SEED = "blu-1.1"  # the set's fixed random order: the calibration is its first 300, a stopped review a random sample
AUDIT_SHARE = 0.05  # the share of the screen's other verdicts the check model reads again: the screen's miss rate
KAPPA_MIN = 0.40  # quadratic-weighted kappa between the two models on the calibration ("moderate" agreement and up)
VALID_MIN = 0.95  # the share of claims each model must answer in form on the calibration
CEILING_USD = 60.0  # the review's own ceiling per run (BLUESANDAI_TELAAH_BATAS_USD); option 1 was estimated at ~$40
AGENT_RESERVE_USD = 30.0  # what an engagement with a cost limit keeps for its agents (an engagement costs $15–25)
CONCLUSIONS = ("wajar", "perlu_diperiksa", "mencurigakan")  # ordinal: the kappa weighs a two-step disagreement more
FLAG = "mencurigakan"
# what the check model reads again: every verdict of the screen that is not wajar (the live smoke test of 2026-10-30: the
# screen said "perlu_diperiksa" on both claims the check found "mencurigakan" — a re-check of "mencurigakan" alone missed them)
RECHECK = ("perlu_diperiksa", "mencurigakan")


def tag_worthy(screen: Optional[str], check: Optional[str]) -> bool:
    """A tag: both families see a problem, and at least one calls it suspicious (two "perlu_diperiksa" ask for documents,
    not for a lead)."""
    return screen in RECHECK and check in RECHECK and FLAG in (screen, check)
TAGS = ("UPCODING_KEPARAHAN", "LOS_DIPERPANJANG", "TAGIHAN_MELEBIHI_TARIF", "LAINNYA")  # what one claim's record can show
CONFIDENCE = ("rendah", "sedang", "tinggi")
OUT_TOKENS = 110  # an answer per claim, for the estimate before the calibration measures it
# the examiners working at once per seat, each a worker of the clinical examination's tree in the firm (the user, 2026-10-30:
# "make it multiagent"): the first full review ran 8 DeepSeek batches at once and screened ~82 claims a minute; Vertex
# throttles GLM, so its re-check team is smaller
# sized for the whole review in about an hour (the user, 2026-10-30): 32 screeners at ~22 s a call (median) read ~650
# claims a minute; 10 re-checkers keep up with what the screen does not find wajar. Blu 1.3's Decisions examiners ask one
# claim at a time (~0.3 s): 10 at once read ~1.800 claims a minute, the key's 2M tokens a minute at ~1.130 tokens a claim
WORKERS = {"other": int(__import__("os").environ.get("BLUESANDAI_TELAAH_PEMERIKSA") or 32), "zai-org": int(__import__("os").environ.get("BLUESANDAI_TELAAH_PEMERIKSA_ULANG") or 10),
           "decisions": int(__import__("os").environ.get("BLUESANDAI_TELAAH_PEMERIKSA_KEPUTUSAN") or 10)}
# the orchestrations with a clinical examination before the agents (the user, 2026-10-30): Blu 1.1 (DeepSeek screens, GLM
# re-checks, both families' suspicion becomes a weak tag) and Blu 1.3 (OpenAI Decisions alone gives every claim a probability
# per conclusion; no re-check and no tags — "we have agent for this later": the agents read the claims it ranks and tag
# with their own evidence). Blu 1.3's other seat is a reference, never called: the screen it was calibrated against
REVIEWED = ("1.1", "1.3")
LEAD_13 = "telaah_keputusan"  # Blu 1.3's examination in the firm's tree (the Nexus chip stays AGENT's)
# what Blu 1.3 hands the swarm (the user, 2026-10-30: "openai decision decide from 40000->5000 then ai agent orchestra analyze
# top 5000"): every mencurigakan, then perlu diperiksa by score, up to this many — the plan's list and the agents' tool
HANDED = 5000


def handed_rank(klaim_id: str, v: dict) -> tuple:
    """A Decisions verdict's place in what Blu 1.3 hands the swarm: mencurigakan before perlu diperiksa, then its score
    (a perlu diperiksa can score above a mencurigakan: 0/.55/.45 is 1.45, .3/.2/.5 is 1.2), then its id."""
    return (v.get("kesimpulan") != FLAG, -(v.get("skor") or 0), klaim_id)


def workers(model: str) -> int:
    from aip import models as aip_models

    if model and aip_models.is_decisions(model):
        return WORKERS["decisions"]
    return WORKERS.get(aip_models.family(model) if model else "", WORKERS["other"])


def examiner_key(seat: str, model: str, k: int) -> str:
    """The firm's key of a seat's k-th examiner (team, and the runtime's agent events)."""
    from aip import models as aip_models

    if seat == "periksa":
        return f"pemeriksa_ulang_{k:02d}"
    return f"pemeriksa_keputusan_{k:02d}" if aip_models.is_decisions(model) else f"pemeriksa_{k:02d}"


def seats_for(versi: str, seats: dict) -> dict:
    """The review's seats of an orchestration: Blu 1.1's as the project sets them; Blu 1.3's fixed — OpenAI Decisions
    screens, and Blu 1.1's screen (DeepSeek) is the reference its calibration compares with, from verdicts already kept
    (never called). Refused when the key is not there."""
    from aip import gateway
    from aip import models as aip_models

    if versi != "1.3":
        return seats
    if not gateway.decisions_ready():
        raise HTTPException(422, "Blu 1.3: OPENAI_API_KEY belum diisi di .env.local (OpenAI Decisions)")
    return {**seats, "telaah_saring": aip_models.DECISIONS, "telaah_periksa": aip_models.DEEPSEEK}


def team(seats: dict, versi: str = "1.1") -> list[dict]:
    """The clinical examination as a tree of the firm: its lead and its examiners — each a worker that takes ten claims at
    a time from one shared queue and asks its model (adk_runtime/telaah.py). Blu 1.1: the screen's and the re-check's;
    Blu 1.3: the Decisions examiners alone. Drawn beside the domain leads, never one of them: the firm's roster does not
    hold it (adk_runtime/firm.py sends it with the firm event)."""
    s, c = seats.get("telaah_saring") or "", seats.get("telaah_periksa") or ""

    def worker(seat: str, model: str, i: int, name: str, code: str, role: str, lead: str) -> dict:
        return {"key": examiner_key(seat, model, i), "name": f"{name} {i:02d}", "lini": "telaah", "jenjang": "analis", "induk": lead, "model": model,
                "peran_kode": code, "peran": role}

    if versi == "1.3":
        return [{"key": LEAD_13, "name": "Decision examination", "lini": "telaah", "jenjang": "manajer", "induk": "partner", "model": s, "peran_kode": "manajer",
                 "peran": "Blu 1.3: memimpin pemeriksaan keputusan — OpenAI Decisions menilai setiap klaim berisiko di Nexus dengan peluang per kesimpulan, "
                          "sebelum agen bekerja; tanpa tag: agen memeriksa klaim teratas dan menandai dengan buktinya sendiri"}] + [
            worker("saring", s, i, "Pemeriksa keputusan", "pemeriksa_keputusan",
                   "menilai satu klaim per panggilan dengan OpenAI Decisions: peluang wajar / perlu diperiksa / mencurigakan dan tag usulan", LEAD_13)
            for i in range(1, workers(s) + 1)]
    return [{"key": AGENT, "name": "Clinical examination", "lini": "telaah", "jenjang": "manajer", "induk": "partner", "model": s, "peran_kode": "manajer",
             "peran": "Blu 1.1: memimpin pemeriksa klinis — setiap klaim berisiko di Nexus ditelaah sebelum agen lain bekerja; kalibrasi, saring, periksa ulang, tag lemah"}] + [
        worker("saring", s, i, "Pemeriksa klinis", "pemeriksa", "menelaah klinis klaim berisiko dari antrean bersama, sepuluh klaim per panggilan", AGENT)
        for i in range(1, workers(s) + 1)] + [
        worker("periksa", c, i, "Pemeriksa ulang", "pemeriksa_ulang", "memeriksa ulang klaim yang bukan wajar dan sampel acak, dari keluarga model lain", AGENT)
        for i in range(1, workers(c) + 1)]

SYSTEM = """Anda dokter verifikator klaim JKN (BPJS Kesehatan) yang berpengalaman dengan INA-CBG, ICD-10 dan ICD-9-CM.
Anda menelaah BEBERAPA klaim FKRTL sekaligus. Setiap klaim berdiri sendiri: nilai masing-masing hanya dari faktanya sendiri.
Aturan:
- Hanya pakai fakta yang diberikan. Jangan mengarang angka, kode, obat, hasil lab atau isi rekam medis.
- Setiap angka di "alasan" harus PERSIS salah satu angka di fakta klaim itu (boleh dibulatkan). Untuk perbandingan pakai
  rasio yang sudah ada di "pembanding".
- Nilai konsistensi klinis: diagnosis masuk vs diagnosis utama; diagnosis vs prosedur (lazimkah prosedur itu untuk
  diagnosisnya); keparahan INA-CBG vs jumlah diagnosis sekunder dan porsi diagnosis itu yang berat; lama rawat vs median
  dan p90 kodenya; tarif tambahan (special CMG) vs diagnosis dan prosedur; status pulang.
- Data ini TIDAK memuat rekam medis, hasil lab, obat, atau hak kelas peserta: ketiadaannya bukan kejanggalan.
- kesimpulan:
  "wajar" = konsisten secara klinis, atau penyimpangannya kecil dan lazim; pakai ini bila ragu tanpa ketidaksesuaian nyata.
  "perlu_diperiksa" = ada SATU hal spesifik di fakta yang hanya bisa dipastikan dengan dokumen.
  "mencurigakan" = ketidaksesuaian klinis yang JELAS di fakta: prosedur tidak lazim untuk diagnosisnya, keparahan berat
  tanpa diagnosis sekunder yang mendukung, lama rawat jauh di atas p90 kodenya tanpa alasan di fakta, tarif tambahan yang
  tidak sesuai diagnosis atau prosedurnya.
- Negatif sulit (biasanya wajar): RS kelas A dan RS khusus, dialisis, kemoterapi, diagnosis langka berbiaya tinggi, masa COVID.
- tag ("" bila kesimpulan "wajar"): UPCODING_KEPARAHAN (keparahan atau kode tidak didukung diagnosis dan prosedur),
  LOS_DIPERPANJANG (lama rawat tidak didukung), TAGIHAN_MELEBIHI_TARIF (tarif tambahan tidak sesuai), LAINNYA
  (ketidaksesuaian klinis lain).
- alasan: 1–2 kalimat Bahasa Indonesia, spesifik untuk klaim itu. Jangan menulis "fraud": tulis "indikasi" atau "ketidaksesuaian".
- keyakinan: "rendah", "sedang" atau "tinggi".
Jawab HANYA JSON: {"hasil": [{"id": "<id klaim persis>", "kesimpulan": "...", "tag": "...", "alasan": "...", "keyakinan": "..."}]}
dengan tepat satu entri untuk setiap klaim yang diberikan."""
SCHEMA = {"type": "object", "required": ["hasil"], "properties": {"hasil": {"type": "array", "items": {
    "type": "object", "required": ["id", "kesimpulan", "tag", "alasan", "keyakinan"],
    "properties": {"id": {"type": "string"}, "kesimpulan": {"type": "string", "enum": list(CONCLUSIONS)}, "tag": {"type": "string", "enum": ["", *TAGS]},
                   "alasan": {"type": "string"}, "keyakinan": {"type": "string", "enum": list(CONFIDENCE)}}}}}}

# Blu 1.3's screen: OpenAI Decisions reads one claim and answers two typed questions, the conclusion as a score over the
# three ordered levels (a probability each) and the tag as a choice. No text: the agents after it read the claims it ranks
# and write their own reasons, with evidence. As tested on the set's first 1.000 claims (2026-10-30: 58% wajar, 37% perlu diperiksa, 5% mencurigakan;
# weighted kappa 0.49 with DeepSeek, 0.52 with GLM; none of its 46 mencurigakan corrected by the verifier)
DECISION_RUBRIC = """Anda dokter verifikator klaim JKN (BPJS Kesehatan) yang berpengalaman dengan INA-CBG, ICD-10 dan ICD-9-CM. Nilai SATU klaim FKRTL hanya dari faktanya sendiri.
- Nilai konsistensi klinis: diagnosis masuk vs diagnosis utama; diagnosis vs prosedur (lazimkah prosedur itu untuk diagnosisnya); keparahan INA-CBG vs jumlah diagnosis sekunder dan porsi diagnosis itu yang berat; lama rawat vs median dan p90 kodenya; tarif tambahan (special CMG) vs diagnosis dan prosedur; status pulang.
- Data ini TIDAK memuat rekam medis, hasil lab, obat, atau hak kelas peserta: ketiadaannya bukan kejanggalan.
- Negatif sulit (biasanya wajar): RS kelas A dan RS khusus, dialisis, kemoterapi, diagnosis langka berbiaya tinggi, masa COVID."""
NO_TAG = "TIDAK_ADA"
DECISION_QUESTIONS = [
    {"type": "score", "name": "kesimpulan", "instructions": "Kesimpulan telaah klinis klaim ini.",
     "levels": [{"label": "wajar", "description": "konsisten secara klinis, atau penyimpangannya kecil dan lazim; pilih ini bila ragu tanpa ketidaksesuaian nyata"},
                {"label": "perlu_diperiksa", "description": "ada SATU hal spesifik di fakta yang hanya bisa dipastikan dengan dokumen"},
                {"label": "mencurigakan", "description": "ketidaksesuaian klinis yang JELAS di fakta: prosedur tidak lazim untuk diagnosisnya, keparahan berat tanpa diagnosis sekunder yang mendukung, lama rawat jauh di atas p90 kodenya tanpa alasan di fakta, tarif tambahan yang tidak sesuai diagnosis atau prosedurnya"}]},
    {"type": "choice", "name": "tag", "instructions": "Ketidaksesuaian utama klaim ini, bila ada.",
     "choices": [{"value": NO_TAG, "description": "tidak ada ketidaksesuaian klinis"},
                 {"value": "UPCODING_KEPARAHAN", "description": "keparahan atau kode tidak didukung diagnosis dan prosedur"},
                 {"value": "LOS_DIPERPANJANG", "description": "lama rawat tidak didukung"},
                 {"value": "TAGIHAN_MELEBIHI_TARIF", "description": "tarif tambahan tidak sesuai"},
                 {"value": "LAINNYA", "description": "ketidaksesuaian klinis lain"}]}]


def decision_input(facts: dict) -> str:
    return DECISION_RUBRIC + "\n\nFakta klaim (JSON):\n" + json.dumps(facts, ensure_ascii=False, default=str)


def parse_decision(payload: dict) -> tuple[Optional[dict], str]:
    """A Decisions answer as a verdict of the screen ({kesimpulan: the likeliest level, peluang per level, skor = the
    probability-weighted level, tag, keyakinan from its confidence}), or None and why (a refusal, an answer out of form).
    Its alasan is a sentence without numbers, marked tanpa_alasan: never a tag's reason."""
    answers = {a.get("name"): a for a in (payload.get("answers") or []) if isinstance(a, dict)}
    s, t = answers.get("kesimpulan") or {}, answers.get("tag") or {}
    if s.get("type") != "score":
        return None, f"Decisions tidak menjawab kesimpulan ({s.get('type') or 'tanpa jawaban'})"
    p = {str(x.get("label")): float(x.get("probability") or 0) for x in s.get("probabilities") or []}
    if set(p) != set(CONCLUSIONS):
        return None, f"Decisions menjawab level di luar {list(CONCLUSIONS)}: {sorted(p)}"
    k = max(CONCLUSIONS, key=lambda c: p[c])
    tag = str(t.get("choice") or "") if t.get("type") == "choice" else ""
    tag = "" if k == "wajar" else tag if tag in TAGS else "LAINNYA"
    conf = float(s.get("confidence") or 0)
    alasan = f"OpenAI Decisions (tanpa alasan tertulis): kesimpulan dengan peluang terbesar {k}" + (f", tag usulan {tag}" if tag else "")
    return {"kesimpulan": k, "tag": tag, "alasan": alasan, "keyakinan": "tinggi" if conf >= 0.7 else "sedang" if conf >= 0.4 else "rendah",
            "peluang": {c: round(p[c], 4) for c in CONCLUSIONS}, "skor": round(float(s.get("score") or 0), 4), "tanpa_alasan": True}, ""


# ------------------------------------------------------------------------------------------------
# what the API and the runtime share: the prompt, the answer's reading, the agreement
# ------------------------------------------------------------------------------------------------


def ceiling(budget_usd: Optional[float] = None) -> float:
    """The review's ceiling in a run: its own (the env may set it), within an engagement's cost limit less what the
    agents need."""
    try:
        own = float(os.environ.get("BLUESANDAI_TELAAH_BATAS_USD") or CEILING_USD)
    except ValueError:
        own = CEILING_USD
    if budget_usd:
        own = min(own, max(0.0, float(budget_usd) - AGENT_RESERVE_USD))
    return round(own, 2)


def user_text(batch: list[tuple[str, dict]]) -> str:
    return ("Klaim yang ditelaah (JSON, satu objek per klaim):\n" +
            json.dumps([{"id": i, "fakta": f} for i, f in batch], ensure_ascii=False, default=str))


def _json(text: str) -> Any:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    try:
        return json.loads(text)
    except ValueError:
        m = re.search(r"\{.*\}", text, re.S)  # prose around the object (a model that explains first)
        if m:
            try:
                return json.loads(m.group(0))
            except ValueError:
                return None
    return None


def parse(text: str, ids: list[str]) -> tuple[dict[str, dict], str]:
    """{local id: verdict} for the ids answered in form, and what was wrong with the answer ("" when nothing)."""
    out = _json(text)
    if isinstance(out, dict):
        items = out.get("hasil") or next((v for v in out.values() if isinstance(v, list)), None)
    else:
        items = out if isinstance(out, list) else None
    if not isinstance(items, list):
        return {}, f"bukan JSON hasil: {str(text)[:120]}"
    want, got, odd = set(ids), {}, []
    for x in items:
        if not isinstance(x, dict):
            continue
        i = str(x.get("id") or "").strip()
        if i not in want or i in got:
            odd.append(i)
            continue
        k = str(x.get("kesimpulan") or "").strip().lower().replace(" ", "_").replace("-", "_")
        k = {"wajar_secara_klinis": "wajar", "perlu_pemeriksaan": "perlu_diperiksa", "curiga": "mencurigakan"}.get(k, k)
        alasan = x.get("alasan")
        alasan = " ".join(map(str, alasan)) if isinstance(alasan, list) else str(alasan or "").strip()
        if k not in CONCLUSIONS or not alasan:
            odd.append(i)
            continue
        tag = str(x.get("tag") or "").strip().upper()
        tag = "" if k == "wajar" else tag if tag in TAGS else "LAINNYA"
        conf = str(x.get("keyakinan") or "").strip().lower()
        got[i] = {"kesimpulan": k, "tag": tag, "alasan": alasan[:600], "keyakinan": conf if conf in CONFIDENCE else "sedang"}
    missing = [i for i in ids if i not in got]
    why = "; ".join(p for p in (f"{len(missing)} klaim tanpa jawaban sah" if missing else "", f"{len(odd)} entri tidak dikenal" if odd else "") if p)
    return got, why


def unverified(alasan: str, facts: dict) -> list[str]:
    """The numbers of a reason that are not among its claim's facts (aip/medis.py: the same gate as the clinical review)."""
    from aip import medis

    return medis.unverified(alasan, facts)


def weighted_kappa(pairs: list[tuple[int, int]], k: int = 3) -> Optional[float]:
    """Cohen's kappa with quadratic weights for ordinal verdicts (wajar < perlu_diperiksa < mencurigakan); None when it is
    undefined (no pairs, or both models gave one verdict throughout)."""
    n = len(pairs)
    if not n:
        return None
    obs = [[0.0] * k for _ in range(k)]
    for a, b in pairs:
        obs[a][b] += 1
    ra = [sum(obs[i]) / n for i in range(k)]
    rb = [sum(obs[i][j] for i in range(k)) / n for j in range(k)]
    w = [[(i - j) ** 2 / (k - 1) ** 2 for j in range(k)] for i in range(k)]
    num = sum(w[i][j] * obs[i][j] / n for i in range(k) for j in range(k))
    den = sum(w[i][j] * ra[i] * rb[j] for i in range(k) for j in range(k))
    return None if den == 0 else round(1 - num / den, 4)


def wilson(k: int, n: int) -> Optional[list[float]]:
    if not n:
        return None
    z, p = 1.96, k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 4), round(min(1.0, c + h), 4)]


def auc(scores: list[float], labels: list[bool]) -> Optional[float]:
    """The chance a positive outranks a negative (ties half): 0.5 is chance; None without both."""
    import bisect

    pos = [x for x, y in zip(scores, labels, strict=True) if y]
    neg = sorted(x for x, y in zip(scores, labels, strict=True) if not y)
    if not pos or not neg:
        return None
    won = sum(bisect.bisect_left(neg, x) + 0.5 * (bisect.bisect_right(neg, x) - bisect.bisect_left(neg, x)) for x in pos)
    return round(won / (len(pos) * len(neg)), 4)


def calibration(rows: list[dict], vs: dict[str, dict], vp: dict[str, dict]) -> dict:
    """The calibration's numbers: each model's valid share and verdicts, their agreement, and each model's "mencurigakan"
    against the verifier's correction (which neither model saw); a screen that answers probabilities (Blu 1.3) also its
    score's AUC against that correction."""
    n = len(rows)
    both = [r for r in rows if r["klaim_id"] in vs and r["klaim_id"] in vp]
    rank = {c: i for i, c in enumerate(CONCLUSIONS)}
    pairs = [(rank[vs[r["klaim_id"]]["kesimpulan"]], rank[vp[r["klaim_id"]]["kesimpulan"]]) for r in both]
    base = sum(bool(r.get("dikoreksi")) for r in rows)

    def model(v: dict[str, dict]) -> dict:
        got = [r for r in rows if r["klaim_id"] in v]
        per = {c: sum(v[r["klaim_id"]]["kesimpulan"] == c for r in got) for c in CONCLUSIONS}
        flag = [r for r in got if v[r["klaim_id"]]["kesimpulan"] == FLAG]
        rest = [r for r in got if v[r["klaim_id"]]["kesimpulan"] != FLAG]
        hit = sum(bool(r.get("dikoreksi")) for r in flag)
        usd = [float(v[r["klaim_id"]].get("usd") or 0) for r in got]
        scored = [r for r in got if v[r["klaim_id"]].get("skor") is not None]
        return {"sah": len(got), "porsi_sah": round(len(got) / n, 4) if n else 0.0, "kesimpulan": per,
                "porsi_mencurigakan": round(len(flag) / len(got), 4) if got else 0.0,
                "porsi_diperiksa_ulang": round(sum(v[r["klaim_id"]]["kesimpulan"] in RECHECK for r in got) / len(got), 4) if got else 0.0,
                "dikoreksi_di_mencurigakan": {"k": hit, "n": len(flag), "porsi": round(hit / len(flag), 4) if flag else None, "ci95": wilson(hit, len(flag))},
                "dikoreksi_di_lainnya": {"k": sum(bool(r.get("dikoreksi")) for r in rest), "n": len(rest)},
                "gerbang_angka_gagal": sum(bool(v[r["klaim_id"]].get("gerbang")) for r in got),
                "usd_per_klaim": round(sum(usd) / len(usd), 6) if usd else None,
                "auc_skor_dikoreksi": auc([float(v[r["klaim_id"]]["skor"]) for r in scored], [bool(r.get("dikoreksi")) for r in scored])}

    return {"n": n, "sepasang": len(both), "setuju_3_kelas": round(sum(a == b for a, b in pairs) / len(pairs), 4) if pairs else None,
            "setuju_mencurigakan": round(sum((a == 2) == (b == 2) for a, b in pairs) / len(pairs), 4) if pairs else None,
            "setuju_bermasalah": round(sum((a > 0) == (b > 0) for a, b in pairs) / len(pairs), 4) if pairs else None,
            "layak_tag": sum(tag_worthy(CONCLUSIONS[a], CONCLUSIONS[b]) for a, b in pairs),
            "kappa_berbobot": weighted_kappa(pairs), "dikoreksi_di_sampel": {"k": base, "n": n, "porsi": round(base / n, 4) if n else None},
            "saring": model(vs), "periksa": model(vp)}


def gate(cal: dict, projected_usd: float, spent_usd: float, limit_usd: float, reference: bool = False) -> list[str]:
    """Why the full review must not run after this calibration ([] = it may). With a `reference` (Blu 1.3) the other seat
    is verdicts already kept, not a model asked: its agreement is judged only where it covers the sample."""
    why = []
    for seat, label in (("saring", "model saring"), *(() if reference else (("periksa", "model periksa"),))):
        if cal[seat]["porsi_sah"] < VALID_MIN:
            why.append(f"{label} menjawab sah hanya {cal[seat]['porsi_sah']:.0%} klaim (minimal {VALID_MIN:.0%})")
    kappa = cal.get("kappa_berbobot")
    if reference and cal["periksa"]["porsi_sah"] < VALID_MIN:
        pass  # too few kept reference verdicts to judge the agreement: validity and cost decide
    elif kappa is None or kappa < KAPPA_MIN:
        what = "dengan putusan rujukan yang tersimpan" if reference else "kedua model"
        why.append(f"kesepakatan {what} terlalu rendah: kappa berbobot {kappa if kappa is not None else '-'} (minimal {KAPPA_MIN})")
    if spent_usd + projected_usd > limit_usd:
        why.append(f"proyeksi biaya telaah penuh ${spent_usd + projected_usd:.2f} melebihi batas ${limit_usd:.2f}")
    return why


# ------------------------------------------------------------------------------------------------
# the review set and its facts (API side: the data as the caller, DuckDB)
# ------------------------------------------------------------------------------------------------


_set_lock = threading.Lock()
_set_cache: dict[str, Any] = {"key": None, "rows": None, "at": 0.0}
PEER_COLS = ["los_median_kode", "los_p90_kode", "tarif_median_kode", "klaim_dengan_kode_sama", "porsi_dx_berat_rawat_inap", "porsi_dx_berprosedur",
             "klaim_dengan_diagnosis_sama"]


def _admin() -> None:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "telaah klinis memuat data per klaim: butuh admin")


def _order(klaim_id: str) -> str:
    return hashlib.sha1(f"{SEED}|{klaim_id}".encode()).hexdigest()


def _peer_sql(con: Any) -> str:
    """The code and diagnosis peers (aip/medis.py _peers, for every code at once): the deployed feature store, else the
    feature cache of the silver claims."""
    import duckdb  # noqa: F401 - the caller's connection

    from aip import ml as aip_ml
    from aip import produksi

    dep = produksi.deployed()
    if dep and Path(dep["toko_fitur"], "ref_kode.parquet").is_file():
        k, d = Path(dep["toko_fitur"], "ref_kode.parquet").as_posix(), Path(dep["toko_fitur"], "ref_dx.parquet").as_posix()
        return (f"kode AS (SELECT inacbg_kode, med_los los_median_kode, p90_los los_p90_kode, med_tarif tarif_median_kode, frek_kode klaim_dengan_kode_sama "
                f"FROM read_parquet('{k}')), dx AS (SELECT dx_primer_icd3, p_berat_dx porsi_dx_berat_rawat_inap, p_prosedur_dx porsi_dx_berprosedur, "
                f"frek_dx klaim_dengan_diagnosis_sama FROM read_parquet('{d}'))")
    cache = sorted((aip_ml._dir() / "cache").glob("fitur-*.parquet"), key=lambda p: p.stat().st_mtime)
    if not cache:
        raise HTTPException(409, "pembanding kode dan diagnosis belum ada (cache fitur ML kosong): latih atau skor model dulu")
    f = cache[-1].as_posix()
    return (f"kode AS (SELECT inacbg_kode, median(los) los_median_kode, quantile_cont(los, 0.9) los_p90_kode, median(tarif_inacbg) tarif_median_kode, "
            f"count(*) klaim_dengan_kode_sama FROM read_parquet('{f}') GROUP BY 1), "
            f"dx AS (SELECT dx_primer_icd3, avg((inacbg_keparahan LIKE 'Berat%')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL') porsi_dx_berat_rawat_inap, "
            f"avg((inacbg_tipe_kasus LIKE 'Prosedur%')::INT) porsi_dx_berprosedur, count(*) klaim_dengan_diagnosis_sama FROM read_parquet('{f}') GROUP BY 1)")


def _plain(x: Any) -> Any:
    """A value of a DuckDB/pandas row as plain Python: NaN and pandas NA as None (bool(pd.NA) raises), numpy scalars
    unboxed, timestamps as text."""
    if x is None or isinstance(x, float) and x != x:
        return None
    if type(x).__name__ in ("NAType", "NaTType"):
        return None
    if hasattr(x, "isoformat"):
        return str(x)
    return x.item() if hasattr(x, "item") else x


def _facts(row: dict) -> dict:
    """A claim's facts as the model reads them: the clinical review's (aip/medis.py), without its id (the batch names it),
    the model's score and the tags, and with dates as dates."""
    from aip import medis

    def clean(x: Any) -> Any:
        x = _plain(x)
        return round(x, 4) if isinstance(x, float) else x

    peers = {c: clean(row.get(c)) for c in PEER_COLS}
    f = medis.facts_from_row(row, peers, {}, [])
    for k in ("model", "indikasi"):
        f.pop(k, None)
    f["klaim"].pop("klaim_id", None)
    for k in ("tgl_datang", "tgl_pulang"):
        f["klaim"][k] = (f["klaim"].get(k) or "")[:10] or None
    return json.loads(json.dumps(f, ensure_ascii=False, default=str))


def review_set() -> list[dict]:
    """The set in its fixed random order: [{klaim_id, faskes_profil_id, provinsi, sumber, dikoreksi, hash, fakta (JSON)}].
    Built as the caller (the silver claims from Files, the two Nexus types), kept while neither changes."""
    import tempfile

    import duckdb
    import pandas as pd

    from aip import indikasi as I
    from aip import ml as aip_ml
    from aip import semantik as S

    src = aip_ml._source()  # 403/404 for a caller without the silver claims
    kb = {str(r.get("klaim_id") or r["_kunci"]): r for r in I._objects(S.T_KLAIM)}
    ml = {str(r.get("klaim_id") or r["_kunci"]): r for r in I._objects(S.T_ML_KLAIM)}
    if not kb and not ml:
        raise HTTPException(409, f"{S.T_KLAIM} dan {S.T_ML_KLAIM} kosong: tidak ada klaim untuk ditelaah")
    ids = sorted(set(kb) | set(ml))
    key = hashlib.sha1(json.dumps([src["id"], src.get("updated_at"), len(ids), _order("".join(ids[:50]) + "".join(ids[-50:]))], default=str).encode()).hexdigest()
    with _set_lock:
        if _set_cache["key"] == key:
            return _set_cache["rows"]
        path = aip_ml._local(src, Path(tempfile.gettempdir()))
        con = duckdb.connect()
        try:
            con.register("ids", pd.DataFrame({"klaim_id": ids}))
            df = con.execute(f"""WITH {_peer_sql(con)}
                SELECT s.*, s.edisi || ':' || s.kunjungan_fkrtl_id AS _klaim_id, kode.* EXCLUDE (inacbg_kode), dx.* EXCLUDE (dx_primer_icd3)
                FROM read_parquet('{Path(path).as_posix()}') s JOIN ids ON ids.klaim_id = s.edisi || ':' || s.kunjungan_fkrtl_id
                LEFT JOIN kode USING (inacbg_kode) LEFT JOIN dx USING (dx_primer_icd3)""").df()
        finally:
            con.close()
        rows = []
        for raw in df.to_dict("records"):
            r = {c: _plain(v) for c, v in raw.items()}
            cid = r["_klaim_id"]
            k, m = kb.get(cid) or {}, ml.get(cid) or {}
            fakta = _facts(r)
            text = json.dumps(fakta, ensure_ascii=False, sort_keys=True)
            rows.append({"klaim_id": cid, "faskes_profil_id": k.get("faskes_profil_id") or m.get("faskes_profil_id"),
                         "provinsi": k.get("provinsi") or m.get("provinsi"), "inacbg_kode": r.get("inacbg_kode"),
                         "sumber": "keduanya" if k and m else "aturan" if k else "ml", "dikoreksi": bool(r.get("flag_selisih_verifikasi")),
                         "hash": hashlib.sha1(text.encode()).hexdigest()[:16], "fakta": text, "_o": _order(cid)})
        rows.sort(key=lambda x: x["_o"])
        _set_cache.update(key=key, rows=rows, at=time.time())
        return rows


# ------------------------------------------------------------------------------------------------
# the verdicts kept
# ------------------------------------------------------------------------------------------------


_db_lock = threading.Lock()
_con: Optional[sqlite3.Connection] = None


def _db() -> sqlite3.Connection:
    global _con
    if _con is None:
        from aip import vertex as aip_vertex

        d = aip_vertex.DIR.parent / "telaah"
        d.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(d / "telaah.db"), check_same_thread=False, timeout=30)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("""CREATE TABLE IF NOT EXISTS vonis (klaim_id TEXT NOT NULL, model TEXT NOT NULL, versi TEXT NOT NULL, hash TEXT NOT NULL,
                       peran TEXT, run_id TEXT, rec TEXT NOT NULL, t TEXT, PRIMARY KEY (klaim_id, model, versi, hash))""")
        con.execute("CREATE INDEX IF NOT EXISTS vonis_model ON vonis (model, versi)")
        con.execute("CREATE TABLE IF NOT EXISTS kalibrasi (run_id TEXT PRIMARY KEY, t TEXT, rec TEXT NOT NULL)")
        con.commit()
        _con = con
    return _con


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def kept(model: str, rows: Optional[list[dict]] = None) -> dict[str, dict]:
    """{klaim_id: verdict} of `model` under this prompt, for the claims whose facts are still the ones it read."""
    if not model:
        return {}
    with _db_lock:
        got = _db().execute("SELECT klaim_id, hash, rec FROM vonis WHERE model = ? AND versi = ?", (model, PROMPT_VERSION)).fetchall()
    if rows is None:
        return {k: json.loads(r) for k, _h, r in got}
    want = {r["klaim_id"]: r["hash"] for r in rows}
    return {k: json.loads(r) for k, h, r in got if want.get(k) == h}


def _last_calibration(screen: str = "", check: str = "") -> Optional[dict]:
    """The latest calibration; of these two models when given (Blu 1.1's and 1.3's are kept side by side)."""
    with _db_lock:
        recs = [json.loads(r[0]) for r in _db().execute("SELECT rec FROM kalibrasi ORDER BY t DESC").fetchall()]
    if screen:
        recs = [r for r in recs if (r.get("model") or {}).get("saring") == screen and (r.get("model") or {}).get("periksa") == check]
    return recs[0] if recs else None


def _running(run_id: str) -> None:
    from aip import runs

    if runs.check_access(run_id).get("status") != "running":
        raise HTTPException(409, "run sudah selesai: hanya run yang berjalan yang menyimpan telaah")


def estimate(rows: list[dict], screen: str, check: str, flag_rate: Optional[float] = None, rechecks: bool = True) -> dict:
    """The cost of what is left, from the facts' length and the models' prices (the calibration measures it instead);
    without `rechecks` (Blu 1.3) the screen's alone."""
    from aip import models as aip_models

    n = len(rows)
    ks, kp = kept(screen, rows), kept(check, rows)
    facts = (sum(len(r["fakta"]) for r in rows) / max(1, n)) / 3
    per_in = (len(SYSTEM) / 3) / BATCH + facts + 15
    # a Decisions request: the rubric and the questions with each claim (measured ~1.130 tokens a claim)
    per_decision = (len(DECISION_RUBRIC) + len(json.dumps(DECISION_QUESTIONS, ensure_ascii=False))) / 3 + facts

    def usd(model: str) -> float:
        p = (aip_models.MODELS.get(model) or {}).get("price") or {"input": 0, "output": 0}
        if aip_models.is_decisions(model):
            return per_decision * p["input"] / 1e6
        return (per_in * p["input"] + OUT_TOKENS * p["output"]) / 1e6

    rate = flag_rate if flag_rate is not None else 0.30  # the share the screen sends to the check (not wajar)
    left_s = n - len(ks)
    left_p = max(0, round(n * (rate + AUDIT_SHARE * (1 - rate))) - len(kp)) if rechecks else 0
    return {"klaim": n, "sisa_saring": left_s, "sisa_periksa_perkiraan": left_p, "porsi_mencurigakan_dipakai": rate,
            "usd_saring": round(left_s * usd(screen), 2), "usd_periksa": round(left_p * usd(check), 2),
            "usd_total": round(left_s * usd(screen) + left_p * usd(check), 2), "usd_per_klaim": {"saring": round(usd(screen), 6), "periksa": round(usd(check), 6)}}


# ------------------------------------------------------------------------------------------------
# endpoints
# ------------------------------------------------------------------------------------------------


def _seats(saring: Optional[str], periksa: Optional[str], versi: str = "1.1") -> tuple[str, str]:
    from aip import konsultan

    s = seats_for(versi, konsultan._seat_models(None))
    return saring or s["telaah_saring"], periksa or s["telaah_periksa"]


@router.get("/ringkasan")
def summary(saring: Optional[str] = None, periksa: Optional[str] = None, batas_usd: Optional[float] = None, versi: str = "1.1") -> dict:
    """What the start form shows before Blu 1.1 or 1.3 runs: the set, what is already reviewed, the last calibration of
    the version's two models, the cost."""
    _admin()
    rows = review_set()
    screen, check = _seats(saring, periksa, versi)
    cal = _last_calibration(screen, check)
    same = cal and cal.get("model", {}).get("saring") == screen and cal.get("model", {}).get("periksa") == check and cal.get("versi_prompt") == PROMPT_VERSION
    rate = ((cal or {}).get("hasil") or {}).get("saring", {}).get("porsi_diperiksa_ulang") if same else None
    est = estimate(rows, screen, check, rate, rechecks=versi != "1.3")
    ks, kp = kept(screen, rows), kept(check, rows)
    per = {c: sum(v["kesimpulan"] == c for v in ks.values()) for c in CONCLUSIONS}
    # Blu 1.3 tags nothing (its other seat is a reference, not a re-check)
    both = 0 if versi == "1.3" else sum(1 for k, v in kp.items() if tag_worthy((ks.get(k) or {}).get("kesimpulan"), v["kesimpulan"]))
    return {"klaim": len(rows), "sumber": {s: sum(r["sumber"] == s for r in rows) for s in ("aturan", "ml", "keduanya")},
            "model": {"saring": screen, "periksa": check}, "versi": versi, "versi_prompt": PROMPT_VERSION, "batch": BATCH,
            "tersimpan": {"saring": len(ks), "periksa": len(kp), "kesimpulan_saring": per, "layak_tag": both},
            "kalibrasi": cal, "kalibrasi_berlaku": bool(same), "estimasi": est, "batas_usd": ceiling(batas_usd),
            "aturan": {"sampel_kalibrasi": SAMPLE_N, "kappa_min": KAPPA_MIN, "porsi_sah_min": VALID_MIN, "audit_acak": AUDIT_SHARE}}


class PageIn(BaseModel):
    offset: int = Field(0, ge=0)
    limit: int = Field(500, ge=1, le=500)
    sampel: Optional[str] = Field(None, pattern="^kalibrasi$")
    klaim_ids: Optional[list[str]] = Field(None, max_length=500)
    saring: Optional[str] = None
    periksa: Optional[str] = None


@router.post("/klaim")
def page(req: PageIn) -> dict:
    """Facts of the set for the runtime: a page in the fixed order, the calibration sample, or chosen claims; each with
    the verdicts already kept for the two models (the runtime does not pay for those again) and the verifier's
    correction (for the calibration's yardstick: never in the prompt)."""
    _admin()
    rows = review_set()
    if req.klaim_ids is not None:
        want = set(req.klaim_ids)
        sel = [r for r in rows if r["klaim_id"] in want]
    elif req.sampel:
        sel = rows[:SAMPLE_N]
    else:
        sel = rows[req.offset: req.offset + req.limit]
    ks, kp = kept(req.saring or "", sel), kept(req.periksa or "", sel)
    return {"total": len(rows), "baris": [{**{k: v for k, v in r.items() if k not in ("fakta", "_o")}, "fakta": json.loads(r["fakta"]),
                                           "tersimpan": {"saring": ks.get(r["klaim_id"]), "periksa": kp.get(r["klaim_id"])}} for r in sel]}


class VerdictIn(BaseModel):
    klaim_id: str = Field(min_length=3, max_length=80)
    hash: str = Field(min_length=8, max_length=40)
    kesimpulan: str = Field(pattern="^(wajar|perlu_diperiksa|mencurigakan)$")
    tag: str = Field("", max_length=40)
    alasan: str = Field(min_length=1, max_length=800)
    keyakinan: str = "sedang"
    model_jawab: str = Field("", max_length=120)
    gerbang: list[str] = Field(default_factory=list, max_length=20)
    usd: float = 0.0
    ms: int = 0
    # Blu 1.3's screen (OpenAI Decisions): a probability per conclusion, the probability-weighted level; no written reason
    peluang: Optional[dict[str, float]] = None
    skor: Optional[float] = None
    tanpa_alasan: bool = False


class SaveIn(BaseModel):
    run_id: str
    model: str = Field(min_length=3, max_length=120)
    peran: str = Field(pattern="^(saring|periksa)$")
    hasil: list[VerdictIn] = Field(max_length=500)


@router.post("/simpan")
def save(req: SaveIn) -> dict:
    """A running run's verdicts, kept at once: what was paid for is never paid for again."""
    _admin()
    _running(req.run_id)
    now = _now()
    vals = [(v.klaim_id, req.model, PROMPT_VERSION, v.hash, req.peran, req.run_id, json.dumps({**v.model_dump(), "peran": req.peran, "run_id": req.run_id, "t": now},
                                                                                              ensure_ascii=False), now) for v in req.hasil]
    with _db_lock:
        con = _db()
        con.executemany("INSERT OR REPLACE INTO vonis (klaim_id, model, versi, hash, peran, run_id, rec, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vals)
        con.commit()
    return {"disimpan": len(vals)}


class CalibrationIn(BaseModel):
    run_id: str
    rec: dict


@router.post("/kalibrasi/hasil")
def save_calibration(req: CalibrationIn) -> dict:
    _admin()
    _running(req.run_id)
    rec = {**req.rec, "run_id": req.run_id, "t": _now(), "versi_prompt": PROMPT_VERSION}
    with _db_lock:
        con = _db()
        con.execute("INSERT OR REPLACE INTO kalibrasi (run_id, t, rec) VALUES (?, ?, ?)", (req.run_id, rec["t"], json.dumps(rec, ensure_ascii=False)))
        con.commit()
    return {"ok": True}


@router.get("/hasil")
def verdicts(saring: Optional[str] = None, periksa: Optional[str] = None, faskes: Optional[str] = None, provinsi: Optional[str] = None,
             kesimpulan: Optional[str] = None, limit: int = 50, versi: str = "1.1", teratas: Optional[int] = None) -> dict:
    """The kept verdicts of the two models on the set, by facility, province or the screen's conclusion ("" = every
    verdict that is not wajar): both models' suspicion first."""
    _admin()
    rows = review_set()
    screen, check = _seats(saring, periksa, versi)
    if versi == "1.3" and not periksa:
        check = ""  # Blu 1.3 re-checks nothing: its screen's verdicts alone
    ks, kp = kept(screen, rows), kept(check, rows)
    if teratas:  # Blu 1.3's agents: only the claims handed to the swarm (HANDED), ranked as the examination ranked them
        top = sorted((k for k, v in ks.items() if v["kesimpulan"] != "wajar"), key=lambda k: handed_rank(k, ks[k]))[:max(1, int(teratas))]
        ks = {k: ks[k] for k in top}
    want_p = (provinsi or "").strip().upper()
    sel = []
    for r in rows:
        s = ks.get(r["klaim_id"])
        if not s or faskes and r.get("faskes_profil_id") != faskes or want_p and str(r.get("provinsi") or "").upper() != want_p:
            continue
        if kesimpulan and s["kesimpulan"] != kesimpulan or not kesimpulan and s["kesimpulan"] == "wajar":
            continue
        c = kp.get(r["klaim_id"])
        f = json.loads(r["fakta"])
        sel.append({"klaim_id": r["klaim_id"], "faskes_profil_id": r.get("faskes_profil_id"), "provinsi": r.get("provinsi"), "inacbg_kode": r.get("inacbg_kode"),
                    "diagnosis_utama": (f.get("diagnosis") or {}).get("utama"), "lama_rawat_hari": (f.get("klaim") or {}).get("lama_rawat_hari"),
                    "kesimpulan_saring": s["kesimpulan"], "kesimpulan_periksa": (c or {}).get("kesimpulan"),
                    "tag_kedua_model": tag_worthy(s["kesimpulan"], (c or {}).get("kesimpulan")),
                    "tag": (c or s).get("tag") or s.get("tag"), "alasan": (c or s)["alasan"], "keyakinan": (c or s).get("keyakinan"),
                    **({"peluang_saring": s["peluang"], "skor_saring": s.get("skor")} if s.get("peluang") else {})})
    # both models' suspicion first (Blu 1.1); Blu 1.3's mencurigakan first, then the screen's score
    sel.sort(key=lambda x: (not x["tag_kedua_model"], FLAG not in (x["kesimpulan_saring"], x["kesimpulan_periksa"]), -(x.get("skor_saring") or 0), x["klaim_id"]))
    lim = max(1, min(int(limit or 50), 500))
    return {"total": len(sel), "model": {"saring": screen, "periksa": check}, "klaim": sel[:lim],
            "ringkasan": {c: sum(v["kesimpulan"] == c for v in ks.values()) for c in CONCLUSIONS}}


class StartIn(BaseModel):
    proyek: Optional[str] = Field(None, max_length=40)
    n: int = Field(SAMPLE_N, ge=10, le=SAMPLE_N)  # fewer for a smoke test
    versi: str = Field("1.1", pattern=r"^1\.[13]$")


@router.post("/kalibrasi")
def start_calibration(req: StartIn, request: Request) -> dict:
    """A calibration-only run (admin): the first n claims of the set, both models, under a dollar; its numbers show in
    the start form before an engagement is asked to spend on the full review. Its verdicts are kept: the engagement's
    own calibration reads them, free."""
    from aip import konsultan, runs

    _admin()
    pr = konsultan._project(req.proyek) if req.proyek else {}
    seats = seats_for(req.versi, konsultan._seat_models(pr.get("model")))
    rows = review_set()
    if not rows:
        raise HTTPException(409, "tidak ada klaim untuk ditelaah")
    # its own spend is capped at $5; its projection is judged against what an engagement of this project may spend on the review
    rec = runs.start("telaah", {"q": f"Uji kalibrasi Blu {req.versi} ({req.n} klaim)", "nama": f"Uji kalibrasi Blu {req.versi}", "proyek": pr.get("id"),
                                "kursi": seats, "versi": req.versi, "telaah_mode": "kalibrasi", "telaah_n": req.n, "telaah_batas_usd": min(ceiling(), 5.0),
                                "telaah_batas_rencana_usd": ceiling(pr.get("batas_usd"))}, request, budget_usd=5.0)
    return {"run": rec["id"], "model": {"saring": seats["telaah_saring"], "periksa": seats["telaah_periksa"]}, "n": req.n, "versi": req.versi}
