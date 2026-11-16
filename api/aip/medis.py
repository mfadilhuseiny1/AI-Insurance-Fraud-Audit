"""Clinical review by an LLM (Analisis medis): the model's score and the claim's clinical record → a plain explanation for
the BPJS verifier of why the claim looks reasonable or suspicious. Not a "Fraud / Clear" label: a reasoned opinion the
verifier reads in seconds and checks against the documents it names.

The facts of a claim, from the real data: its clinical record (admission and primary diagnoses with their names, every
procedure with its name, the INA-CBG group, case type and severity, length of stay, discharge, the number of secondary
diagnoses, special CMG items with their descriptions, the bill), its peers (the code's median and p90 length of stay
and tariff, how often the diagnosis is severe or procedural, how many claims share the code), the model's score
against its operating threshold with its TreeSHAP reasons, and its tags. Whether the verifier already corrected the
claim is left out of the prompt (the review must stand on the clinical record) and shown beside it.

An LLM (the platform's strongest open model) answers in a fixed JSON form: a conclusion (wajar / perlu_diperiksa /
mencurigakan), a summary in plain Indonesian, the clinical reasons (consistency of diagnosis, procedure, severity and
stay), what is odd, what would explain it honestly, the documents to request, and its confidence. Optionally a second
opinion from a model of another family, and whether the two agree.

The gate is code, not prompt: every number the review states must be one of the facts it was given (or a ratio given
with them), within rounding; a review that states another number is sent back once with those numbers named, and shown
with a warning if it still does. The review changes nothing: the verifier decides.

    POST /api/aip/medis/klaim     {klaim_id, pendapat_kedua?, segarkan?} → the review of a claim of the data (cached)
    (aip/layanan.py serves the same review for new claims: POST /api/aip/fraud/v1/analisis-medis)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip/medis")
log = logging.getLogger("aip.medis")

PROMPT_VERSION = "2026-10-23.2"
# what the judges' flat claim (claim_id, age, codes, costs, stay, notes) does not carry: unknown to the review, not empty
FLAT_UNSENT = ["prosedur (ICD-9-CM)", "diagnosis masuk dan diagnosis sekunder", "faskes (jenis, tipe, kepemilikan, wilayah)",
               "tanggal datang dan pulang", "status pulang, kelas rawat dan poli", "tarif tambahan (special CMG)"]
CONCLUSIONS = {"wajar": "Wajar secara klinis", "perlu_diperiksa": "Perlu diperiksa", "mencurigakan": "Mencurigakan"}
SCHEMA = {"type": "object", "properties": {
    "kesimpulan": {"type": "string", "enum": list(CONCLUSIONS)},
    "ringkasan": {"type": "string"},
    "alasan_klinis": {"type": "array", "items": {"type": "string"}},
    "kejanggalan": {"type": "array", "items": {"type": "string"}},
    "penjelasan_wajar": {"type": "array", "items": {"type": "string"}},
    "dokumen_diperiksa": {"type": "array", "items": {"type": "string"}},
    "keyakinan": {"type": "string", "enum": ["rendah", "sedang", "tinggi"]}},
    "required": ["kesimpulan", "ringkasan", "alasan_klinis", "kejanggalan", "penjelasan_wajar", "dokumen_diperiksa", "keyakinan"]}
SYSTEM = """Anda dokter verifikator klaim JKN (BPJS Kesehatan) yang berpengalaman dengan INA-CBG, ICD-10 dan ICD-9-CM.
Anda menelaah SATU klaim FKRTL untuk membantu verifikator: apakah klaim ini wajar secara klinis atau perlu diperiksa.
Aturan:
- Hanya pakai fakta yang diberikan. Jangan mengarang angka, kode, nama obat, hasil lab atau isi rekam medis yang tidak ada.
  Setiap angka yang Anda tulis harus PERSIS salah satu angka di fakta (boleh dibulatkan). Bila perlu perbandingan, pakai
  rasio yang sudah ada di fakta "pembanding".
- Nilai konsistensi klinis: diagnosis masuk vs diagnosis utama, diagnosis vs prosedur (apakah prosedur lazim untuk
  diagnosis itu), keparahan INA-CBG vs jumlah diagnosis sekunder, lama rawat vs median dan p90 kodenya, tarif tambahan
  (special CMG) vs diagnosis/prosedur, status pulang.
- Bila fakta punya "tidak_dikirim", data itu TIDAK DIBAWA format klaim ini: tidak diketahui, bukan kosong atau nol. Jangan
  menjadikannya kejanggalan atau alasan "perlu_diperiksa"; nilai dari fakta yang ada (diagnosis, kode, biaya, lama rawat,
  catatan medis), dan bila perlu sebut dokumen yang memastikannya di dokumen_diperiksa.
- Skor model adalah peluang klaim DIKOREKSI verifikator (bukan bukti fraud); alasan model (TreeSHAP) adalah pola statistik.
  Kesimpulan Anda berdiri pada pertimbangan klinis; sebut bila Anda sependapat atau tidak dengan model, dan mengapa.
- Kesimpulan: "wajar" (konsisten secara klinis), "perlu_diperiksa" (ada yang perlu dikonfirmasi dengan dokumen),
  "mencurigakan" (ketidaksesuaian klinis yang jelas: mis. prosedur tidak lazim untuk diagnosis, keparahan tidak didukung,
  lama rawat ekstrem tanpa alasan di fakta). Jangan menulis "fraud": tulis "indikasi" atau "ketidaksesuaian".
- ringkasan: 2–3 kalimat bahasa sederhana untuk verifikator. dokumen_diperiksa: dokumen spesifik (resume medis, laporan
  operasi, hasil laboratorium tertentu, catatan perawatan harian, dsb.). Bahasa Indonesia.
- Jawab hanya JSON dengan kunci persis: kesimpulan, ringkasan, alasan_klinis (daftar), kejanggalan (daftar),
  penjelasan_wajar (daftar), dokumen_diperiksa (daftar), keyakinan ("rendah" | "sedang" | "tinggi")."""


def _dir() -> Path:
    from aip import vertex as aip_vertex

    d = aip_vertex.DIR.parent / "medis"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _model(second: bool = False) -> str:
    if PROVIDER["kind"] != "vertex":  # a standalone service: the model its .env names (one family: no second opinion)
        return PROVIDER.get("model") or "-"
    from aip import models as aip_models

    first = aip_models.pick("writer", strong=True)
    return aip_models.pick("auditor_sim", checks=first) if second else first


# ------------------------------------------------------------------------------------------------
# the facts of a claim
# ------------------------------------------------------------------------------------------------


def _procedures(text: Optional[str]) -> list[str]:
    return [p.strip() for p in (text or "").split(";") if p.strip()][:30]


def facts_from_row(row: dict, peers: dict, model: dict, tags: list[dict], faskes: Optional[dict] = None) -> dict:
    """The structured facts the review is allowed to use (row: the silver claim's fields)."""
    def v(k: str) -> Any:
        x = row.get(k)
        return None if x is None or (isinstance(x, float) and x != x) else x

    extra = []
    for code, label in (("sa", "special sub-acute"), ("sp", "special procedure"), ("rr", "special prosthesis"), ("si", "special investigation"),
                        ("sd", "special drug")):
        if (v(f"{code}_tarif_rp") or 0) > 0:
            extra.append({"jenis": label, "kode": v(f"{code}_kode"), "deskripsi": v(f"{code}_deskripsi"), "tarif_rp": int(v(f"{code}_tarif_rp"))})
    los, tarif, tagih = v("los_hari"), v("tarif_inacbg_rp"), v("biaya_tagih_rp")
    base = (tarif or 0) + sum(e["tarif_rp"] for e in extra)
    pb = {k: x for k, x in peers.items() if x is not None}
    if los is not None and pb.get("los_median_kode"):
        pb["rasio_los_terhadap_median"] = round(los / pb["los_median_kode"], 2)
    if los is not None and pb.get("los_p90_kode"):
        pb["rasio_los_terhadap_p90"] = round(los / pb["los_p90_kode"], 2)
    if base and tagih is not None:
        pb["rasio_tagihan_terhadap_tarif"] = round(tagih / base, 2)
    return {
        "klaim": {"klaim_id": f"{v('edisi')}:{v('kunjungan_fkrtl_id')}", "edisi": v("edisi"), "tingkat_pelayanan": v("tingkat_pelayanan"),
                  "poli": v("poli"), "kelas_rawat": v("kelas_rawat"), "tgl_datang": str(v("tgl_datang") or ""), "tgl_pulang": str(v("tgl_pulang") or ""),
                  "lama_rawat_hari": los, "status_pulang": v("status_pulang"), "layanan_covid": bool(v("layanan_covid"))},
        "faskes": faskes or {"jenis": v("jenis_fkrtl"), "tipe": v("tipe_fkrtl"), "kepemilikan": v("kepemilikan_fkrtl"), "kabkota": v("kabkota_fkrtl"),
                             "provinsi": v("provinsi_fkrtl")},
        "diagnosis": {"masuk": " - ".join(x for x in (v("dx_masuk_kode"), v("dx_masuk_nama")) if x) or None,
                      "utama": " - ".join(x for x in (v("dx_primer_kode"), v("dx_primer_nama")) if x) or None,
                      "jumlah_diagnosis_sekunder": v("jumlah_dx_sekunder")},
        "prosedur": _procedures(v("prosedur")),
        "inacbg": {"kode": v("inacbg_kode"), "deskripsi": v("inacbg_deskripsi"), "cmg": v("inacbg_cmg"), "tipe_kasus": v("inacbg_tipe_kasus"),
                   "keparahan": v("inacbg_keparahan"), "regional_tarif": v("regional_tarif")},
        "biaya": {"tarif_inacbg_rp": tarif, "tarif_tambahan": extra, "tagihan_rp": tagih},
        "pembanding": pb, "model": model, "indikasi": tags}


def _numbers(obj: Any, out: Optional[set] = None) -> set[float]:
    out = set() if out is None else out
    if isinstance(obj, bool) or obj is None:
        return out
    if isinstance(obj, (int, float)):
        out.add(float(obj))
    elif isinstance(obj, str):
        for m in NUM.finditer(obj):
            x = parse_number(m.group(0))
            if x is not None:
                out.add(x)
    elif isinstance(obj, dict):
        for x in obj.values():
            _numbers(x, out)
    elif isinstance(obj, (list, tuple)):
        for x in obj:
            _numbers(x, out)
    return out


# a number in Indonesian text, not part of a code (I-1-40-I, K35, 0066): 5.200.000 · 3,5 · 12% · 4
NUM = re.compile(r"(?<![\w.,-])\d{1,3}(?:\.\d{3})+(?:,\d+)?(?![\w-])|(?<![\w.,-])\d+(?:[.,]\d+)?(?![\w-])")
SCALE = re.compile(r"\s*(juta|jt|miliar|ribu|rb)\b", re.I)


def parse_number(s: str) -> Optional[float]:
    t = s.strip()
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+(?:,\d+)?", t):
        t = t.replace(".", "").replace(",", ".")
    else:
        t = t.replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def unverified(text: str, facts: dict) -> list[str]:
    """The numbers of a review that are not among its facts (within rounding; counts up to 10 are free prose)."""
    known = _numbers(facts)
    shares = {x * 100 for x in known if 0 < x <= 1}
    bad = []
    for m in NUM.finditer(text):
        x = parse_number(m.group(0))
        if x is None or x <= 10 and float(x).is_integer():
            continue
        tail = SCALE.match(text, m.end())
        if tail:
            x *= {"juta": 1e6, "jt": 1e6, "miliar": 1e9, "ribu": 1e3, "rb": 1e3}[tail.group(1).lower()]
        if not any(abs(x - f) <= max(0.02 * abs(f), 0.051) for f in known | shares):
            bad.append(m.group(0) + (tail.group(0) if tail else ""))
    return bad


# ------------------------------------------------------------------------------------------------
# the review
# ------------------------------------------------------------------------------------------------


# the LLM, as the deployment configures it: the platform's Vertex open models; a standalone inference service may
# point at Gemini (generateContent) or any OpenAI-compatible API through its .env
PROVIDER: dict[str, Any] = {"kind": "vertex"}
BREAKER = {"fails": 0, "open_until": 0.0}
BREAK_AFTER, COOLDOWN = 3, 60.0  # consecutive failures that open the circuit, and for how long (s)


def _user(facts: dict, fix: Optional[list[str]]) -> str:
    user = "Fakta klaim (JSON):\n" + json.dumps(facts, ensure_ascii=False, default=str)
    if fix:
        user += ("\n\nTelaah Anda sebelumnya menyebut angka yang TIDAK ada di fakta: " + ", ".join(fix) +
                 ". Tulis ulang tanpa angka itu (pakai hanya angka di fakta).")
    return user


def _gemini_schema(s: dict) -> dict:
    """SCHEMA in the Gemini API's form (its OpenAPI subset: upper-case types)."""
    out = {k: v for k, v in s.items() if k not in ("type", "properties", "items")}
    out["type"] = s["type"].upper()
    if "properties" in s:
        out["properties"] = {k: _gemini_schema(v) for k, v in s["properties"].items()}
    if "items" in s:
        out["items"] = _gemini_schema(s["items"])
    return out


async def _post(model: str, facts: dict, fix: Optional[list[str]]) -> str:
    """The raw answer text of one call to the configured provider."""
    if PROVIDER["kind"] == "vertex":
        from aip import models as aip_models
        from aip import vertex as aip_vertex

        body: dict[str, Any] = {"model": aip_models.publisher_model(model), "temperature": 0.1, "max_tokens": 4000,
                                "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _user(facts, fix)}],
                                "response_format": {"type": "json_schema", "json_schema": {"name": "telaah_medis", "strict": False, "schema": SCHEMA}}}
        if aip_models.family(model) == "zai-org":
            body["chat_template_kwargs"] = {"enable_thinking": False}  # (GLM: an answer, not a monologue, as the agents use it)
        elif aip_models.family(model) == "openai":
            body["reasoning_effort"] = "medium"
        r = await aip_vertex.apost(model, body, PROVIDER.get("timeout", 150))
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        return r.json()["choices"][0]["message"].get("content") or ""
    client = PROVIDER["client"]
    if PROVIDER["kind"] == "gemini":
        url = f"{PROVIDER['base_url'].rstrip('/')}/{model}:generateContent"
        # the schema too: with the MIME type alone Gemini names its own keys and leaves the lists the verifier reads empty
        body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": [{"role": "user", "parts": [{"text": _user(facts, fix)}]}],
                "generationConfig": {"temperature": 0.1, "maxOutputTokens": 4000, "responseMimeType": "application/json",
                                     "responseSchema": _gemini_schema(SCHEMA)}}
        r = await client.post(url, headers={"x-goog-api-key": PROVIDER["api_key"]}, json=body, timeout=PROVIDER.get("timeout", 30))
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        parts = ((r.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts)
    body = {"model": model, "temperature": 0.1, "max_tokens": 4000, "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _user(facts, fix)}]}
    r = await client.post(f"{PROVIDER['base_url'].rstrip('/')}/chat/completions", headers={"Authorization": f"Bearer {PROVIDER['api_key']}"}, json=body,
                          timeout=PROVIDER.get("timeout", 30))
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    return r.json()["choices"][0]["message"].get("content") or ""


async def _ask(model: str, facts: dict, fix: Optional[list[str]] = None) -> dict:
    """One answer of `model` in the review's JSON form (asynchronous: the server keeps serving while it thinks); a
    network error, a 429/5xx or an unreadable answer is retried twice."""
    last = ""
    for attempt in range(3):
        if attempt:  # a quota burst (429) passes in seconds, not milliseconds
            await asyncio.sleep((5 if "429" in last else 2) * attempt)
        try:
            text = (await _post(model, facts, fix)).strip()
        except Exception as e:  # noqa: BLE001 - retried; the caller falls back after the last try
            last = f"{type(e).__name__}: {str(e)[:200]}"
            log.warning("telaah klinis %s percobaan %d: %s", model, attempt + 1, last, exc_info=True)
            if "HTTP 4" in last and "HTTP 429" not in last and "HTTP 408" not in last:
                break
            continue
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
        try:
            out = json.loads(text)
        except ValueError:
            last = f"bukan JSON: {text[:120]}"
            continue
        if isinstance(out, dict) and "kesimpulan" not in out:  # wrapped ({"value": {...}}, {"telaah": {...}})
            out = next((v for v in out.values() if isinstance(v, dict) and "kesimpulan" in v), out)
        if isinstance(out, dict):  # the label for the value ("Perlu diperiksa"), a list for the summary
            k = str(out.get("kesimpulan") or "").strip().lower().replace(" ", "_").replace("-", "_")
            out["kesimpulan"] = {"wajar_secara_klinis": "wajar", "perlu_pemeriksaan": "perlu_diperiksa", "curiga": "mencurigakan"}.get(k, k)
            if isinstance(out.get("ringkasan"), list):
                out["ringkasan"] = " ".join(map(str, out["ringkasan"]))
        if isinstance(out, dict) and out.get("kesimpulan") in CONCLUSIONS and isinstance(out.get("ringkasan"), str):
            for k in ("alasan_klinis", "kejanggalan", "penjelasan_wajar", "dokumen_diperiksa"):
                out[k] = [str(x) for x in out.get(k) or []][:8]
            if out.get("keyakinan") not in ("rendah", "sedang", "tinggi"):
                out["keyakinan"] = "sedang"
            return out
        last = f"tidak sesuai skema: {text[:200]}"
    raise RuntimeError(f"{model}: {last}")


def _num(x: Any) -> str:
    """A number as the facts hold it, in Indonesian notation (the gate reads it back)."""
    if isinstance(x, float) and not float(x).is_integer():
        return f"{x:.2f}".replace(".", ",")
    return f"{int(x):,}".replace(",", ".")


def fallback(facts: dict, why: str) -> dict:
    """The deterministic review (circuit open, LLM down or its answer unusable): the conclusion and the reasons from the
    facts alone — the model's flag and reasons, the length of stay and the bill against the code's peers, the tags —
    so the verifier always gets an explanation (zero downtime). Its numbers are the facts' own."""
    ml, pb, k = facts.get("model") or {}, facts.get("pembanding") or {}, facts.get("klaim") or {}
    tags = facts.get("indikasi") or []
    reasons, odd, fine = [], [], []
    if ml:
        reasons.append(f"Model ({ml.get('model')}) memberi peluang koreksi {_num(ml.get('risiko_pct', 0))}% "
                       f"({_num(ml.get('kelipatan_ambang') or 0)}× ambang operasional {_num(ml.get('ambang_pct', 0))}%)"
                       + (": ditandai." if ml.get("ditandai_model") else ": tidak ditandai."))
        for r in (ml.get("alasan_model") or [])[:3]:
            reasons.append(f"Pendorong skor: {r['fitur']} = {r['nilai']}" + (f" (umumnya {r['umumnya']})" if r.get("umumnya") else ""))
    ratio_los, ratio_bill = pb.get("rasio_los_terhadap_p90"), pb.get("rasio_tagihan_terhadap_tarif")
    if ratio_los is not None and ratio_los > 1:
        odd.append(f"Lama rawat {_num(k.get('lama_rawat_hari') or 0)} hari = {_num(ratio_los)}× p90 kodenya ({_num(pb.get('los_p90_kode') or 0)} hari).")
    elif ratio_los is not None:
        fine.append(f"Lama rawat {_num(k.get('lama_rawat_hari') or 0)} hari dalam batas p90 kodenya ({_num(pb.get('los_p90_kode') or 0)} hari).")
    if ratio_bill is not None and ratio_bill > 1.2 and not k.get("layanan_covid"):
        odd.append(f"Tagihan {_num(ratio_bill)}× tarif INA-CBG + tambahan.")
    elif ratio_bill is not None:
        fine.append(f"Tagihan {_num(ratio_bill)}× tarif INA-CBG + tambahan.")
    if k.get("layanan_covid"):
        fine.append("Klaim pasien COVID-19: skema tarif per hari, bukan INA-CBG; pembanding kode tidak setara.")
    for t in tags[:4]:
        odd.append(f"Indikasi {t.get('label') or t.get('tag')}: {t.get('bukti')}")
    flagged = bool(ml.get("ditandai_model"))
    conclusion = "mencurigakan" if flagged and len(odd) >= 2 else "perlu_diperiksa" if flagged or odd else "wajar"
    docs = ["resume medis", "catatan perawatan harian"] + (["laporan operasi / tindakan"] if facts.get("prosedur") else []) + \
           (["rincian tagihan per komponen"] if ratio_bill and ratio_bill > 1.2 else [])
    body = (("Model menandai klaim ini" if flagged else "Model tidak menandai klaim ini") +
            (f" dan {len(odd)} hal perlu dikonfirmasi dengan dokumen." if odd else "; tidak ada kejanggalan dari data klaim."))
    summary = f"Telaah deterministik (LLM tidak dipakai: {why}). {body}"
    bad = unverified(" ".join([body, *reasons, *odd, *fine]), facts)  # the gate reads the review, not the error that caused it
    return {"kesimpulan": conclusion, "ringkasan": summary, "alasan_klinis": reasons, "kejanggalan": odd, "penjelasan_wajar": fine,
            "dokumen_diperiksa": docs, "keyakinan": "rendah", "model": "deterministik (circuit breaker)", "percobaan": 0,
            "angka_tidak_terverifikasi": bad, "lolos_gerbang_angka": not bad, "label": CONCLUSIONS[conclusion], "fallback": True, "alasan_fallback": why}


async def areview(facts: dict, second: bool = False) -> dict:
    """The LLM's review of the facts through the numeric gate (one retry naming the numbers); with `second`, an
    opinion of another model family, asked at the same time, and whether the two agree. Behind a circuit breaker:
    after BREAK_AFTER failures in a row the LLM is not called for COOLDOWN seconds, and every failure falls back to
    the deterministic review."""
    async def checked(model: str) -> dict:
        t0 = time.time()
        if PROVIDER["kind"] == "none":
            return {**fallback(facts, "LLM tidak dikonfigurasi (.env: LLM_API_KEY, LLM_API_BASE_URL, LLM_MODEL_NAME)"), "detik": 0.0}
        if time.time() < BREAKER["open_until"]:
            return {**fallback(facts, f"circuit breaker terbuka setelah {BREAK_AFTER} kegagalan beruntun"), "detik": 0.0}
        try:
            r = await _ask(model, facts)
            text = " ".join([r["ringkasan"], *r["alasan_klinis"], *r["kejanggalan"], *r["penjelasan_wajar"]])
            bad = unverified(text, facts)
            tries = 1
            if bad:
                r = await _ask(model, facts, bad)
                tries = 2
                text = " ".join([r["ringkasan"], *r["alasan_klinis"], *r["kejanggalan"], *r["penjelasan_wajar"]])
                bad = unverified(text, facts)
        except Exception as e:  # noqa: BLE001 - the circuit counts it; the verifier still gets the deterministic review
            log.warning("telaah klinis %s gagal (%d beruntun): fallback deterministik", model, BREAKER["fails"] + 1, exc_info=True)
            BREAKER["fails"] += 1
            if BREAKER["fails"] >= BREAK_AFTER:
                BREAKER["open_until"] = time.time() + COOLDOWN
            return {**fallback(facts, f"{type(e).__name__}: {str(e)[:160]}"), "detik": round(time.time() - t0, 1)}
        BREAKER["fails"] = 0
        return {**r, "model": model, "percobaan": tries, "angka_tidak_terverifikasi": bad, "lolos_gerbang_angka": not bad,
                "label": CONCLUSIONS[r["kesimpulan"]], "detik": round(time.time() - t0, 1)}

    if second:
        first, other = await asyncio.gather(checked(_model()), checked(_model(second=True)))
        return {"telaah": first, "pendapat_kedua": other, "sepakat": other["kesimpulan"] == first["kesimpulan"], "versi_prompt": PROMPT_VERSION}
    return {"telaah": await checked(_model()), "versi_prompt": PROMPT_VERSION}


def facts_new(claim: Any, feat: dict, ml: dict, tags: list[dict], catatan: Optional[str] = None, usia: Optional[int] = None,
              flat: bool = False) -> dict:
    """The facts of a new claim (a /verify request): its own fields, the peers from its computed features, the model.
    `flat`: the judges' flat format — what it does not carry is said to be unsent (not empty), and the values the
    pipeline had to assume for the features (a hospital, today's date) are not shown as facts."""
    row = {k: getattr(claim, k, None) for k in type(claim).model_fields}
    if not row.get("kabkota_fkrtl") and getattr(claim, "kabkota_fkrtl_kode", None):
        row["kabkota_fkrtl"] = f"kode {claim.kabkota_fkrtl_kode}"
    peers = {"los_median_kode": feat.get("med_los"), "los_p90_kode": feat.get("p90_los"), "tarif_median_kode": feat.get("med_tarif"),
             "klaim_dengan_kode_sama": feat.get("frek_kode"), "porsi_dx_berat_rawat_inap": feat.get("p_berat_dx"),
             "porsi_dx_berprosedur": feat.get("p_prosedur_dx"), "klaim_dengan_diagnosis_sama": feat.get("frek_dx")}
    peers = {k: (round(float(v), 4) if isinstance(v, float) else v) for k, v in peers.items() if v is not None and v == v}
    facts = facts_from_row(row, peers, ml, tags)
    if flat:
        facts.update(prosedur=None, faskes=None, tidak_dikirim=FLAT_UNSENT)
        facts["klaim"].update(tgl_datang=None, tgl_pulang=None, status_pulang=None, kelas_rawat=None, poli=None)
    if catatan:
        facts["catatan_medis"] = catatan
    if usia is not None:
        facts["pasien"] = {"usia_tahun": usia}
    return facts


# ------------------------------------------------------------------------------------------------
# a claim of the data: its facts from the silver claims, the feature cache and the deployed / current model
# ------------------------------------------------------------------------------------------------


_lock = threading.Lock()


def _silver_row(klaim_id: str) -> dict:
    import duckdb

    from aip import ml as aip_ml

    edisi, _, kid = klaim_id.partition(":")
    if not edisi or not kid or not re.fullmatch(r"[A-Za-z0-9._-]+", kid) or not re.fullmatch(r"[a-z_]+", edisi):
        raise HTTPException(400, "klaim_id harus berbentuk <edisi>:<kunjungan_fkrtl_id>")
    src = aip_ml._source()
    import tempfile

    path = aip_ml._local(src, Path(tempfile.gettempdir()))
    con = duckdb.connect()
    rows = con.execute(f"SELECT * FROM read_parquet('{Path(path).as_posix()}') WHERE edisi = ? AND kunjungan_fkrtl_id = ?", [edisi, kid]).df()
    con.close()
    if rows.empty:
        raise HTTPException(404, f"klaim {klaim_id} tidak ada di data")
    return rows.iloc[0].to_dict()


def _peers(row: dict) -> dict:
    """The claim's peers from the deployed feature store (or the feature cache): code and diagnosis statistics."""
    import duckdb

    from aip import ml as aip_ml
    from aip import produksi

    dep = produksi.deployed()
    con = duckdb.connect()
    try:
        if dep and Path(dep["toko_fitur"], "ref_kode.parquet").is_file():
            k = Path(dep["toko_fitur"], "ref_kode.parquet").as_posix()
            d = Path(dep["toko_fitur"], "ref_dx.parquet").as_posix()
            kode = con.execute(f"SELECT med_los, p90_los, med_tarif, frek_kode FROM read_parquet('{k}') WHERE inacbg_kode = ?", [row.get("inacbg_kode")]).fetchone()
            dx = con.execute(f"SELECT p_berat_dx, p_prosedur_dx, frek_dx FROM read_parquet('{d}') WHERE dx_primer_icd3 = ?", [row.get("dx_primer_icd3")]).fetchone()
        else:
            cache = sorted((aip_ml._dir() / "cache").glob("fitur-*.parquet"), key=lambda p: p.stat().st_mtime)
            if not cache:
                return {}
            f = cache[-1].as_posix()
            kode = con.execute(f"SELECT median(los), quantile_cont(los, 0.9), median(tarif_inacbg), count(*) FROM read_parquet('{f}') WHERE inacbg_kode = ?",
                               [row.get("inacbg_kode")]).fetchone()
            dx = con.execute(f"""SELECT avg((inacbg_keparahan LIKE 'Berat%')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL'),
                                 avg((inacbg_tipe_kasus LIKE 'Prosedur%')::INT), count(*) FROM read_parquet('{f}') WHERE dx_primer_icd3 = ?""",
                             [row.get("dx_primer_icd3")]).fetchone()
    finally:
        con.close()
    out: dict[str, Any] = {}
    if kode:
        out.update(los_median_kode=kode[0], los_p90_kode=kode[1], tarif_median_kode=kode[2], klaim_dengan_kode_sama=kode[3])
    if dx:
        out.update(porsi_dx_berat_rawat_inap=round(dx[0], 4) if dx[0] is not None else None, porsi_dx_berprosedur=round(dx[1], 4) if dx[1] is not None else None,
                   klaim_dengan_diagnosis_sama=dx[2])
    return out


def _model_view(klaim_id: str) -> dict:
    """The model's score and reasons for a claim of the data: its batch features (feature cache), the current bundle."""
    import duckdb

    import ml_klaim as M
    from aip import ml as aip_ml

    c = aip_ml._loaded()
    cache = sorted((aip_ml._dir() / "cache").glob("fitur-*.parquet"), key=lambda p: p.stat().st_mtime)
    if not cache:
        return {}
    con = duckdb.connect()
    df = con.execute(f"SELECT * FROM read_parquet('{cache[-1].as_posix()}') WHERE klaim_id = ?", [klaim_id]).df()
    con.close()
    if df.empty:
        return {}
    seg_name = "rumah_sakit" if df["jenis_fkrtl"].iloc[0] == "Rumah sakit" else "klinik_utama"
    seg = c["bundle"]["segments"][seg_name]
    risk = float(M.predict(seg, df)[0])
    why = M.reasons(seg, df)[0]
    return {"segmen": seg_name, "model": seg["name"], "risiko_pct": round(100 * risk, 4), "ambang_pct": round(100 * seg["threshold"], 4),
            "kelipatan_ambang": round(risk / seg["threshold"], 2) if seg["threshold"] else None, "ditandai_model": bool(risk >= seg["threshold"]),
            "arti_skor": "peluang klaim dikoreksi verifikator menurut model (bukan bukti fraud)",
            "alasan_model": [{"fitur": r["label"], "nilai": r["nilai"], "umumnya": r.get("umumnya")} for r in why], "versi_model": c["version"]}


def claim_facts(klaim_id: str) -> tuple[dict, dict]:
    """(the facts for the review, what is shown beside it but not given to the model: the verifier's own outcome)."""
    from aip import indikasi as I

    row = _silver_row(klaim_id)
    tags = [{"tag": v["tag"], "label": v["tag_label"], "kekuatan": v["kekuatan"], "bukti": v["bukti"][:200]}
            for v in I._filtered(None, "klaim", None, None, None, None, None, None, None) if v["kunci"] == klaim_id][:10]
    facts = facts_from_row(row, _peers(row), _model_view(klaim_id), tags)
    aside = {"dikoreksi_verifikator": bool(row.get("flag_selisih_verifikasi")), "biaya_verifikasi_rp": row.get("biaya_verifikasi_rp"),
             "selisih_rp": row.get("selisih_rp")}
    return facts, aside


class ClaimIn(BaseModel):
    klaim_id: str = Field(min_length=3, max_length=120)
    pendapat_kedua: bool = False
    segarkan: bool = False


@router.post("/klaim")
async def claim_review(req: ClaimIn) -> dict:
    """The clinical review of a claim of the data (cached per claim, prompt version and models)."""
    import anyio

    facts, aside = await anyio.to_thread.run_sync(claim_facts, req.klaim_id)
    key = hashlib.sha1(json.dumps([req.klaim_id, PROMPT_VERSION, _model(), req.pendapat_kedua, (facts.get("model") or {}).get("versi_model")]).encode()).hexdigest()[:20]
    f = _dir() / f"{key}.json"
    if f.is_file() and not req.segarkan:
        try:
            return {**json.loads(f.read_text("utf-8")), "dari_cache": True}
        except ValueError:
            pass
    out = {"klaim_id": req.klaim_id, "fakta": facts, "di_luar_prompt": aside, **(await areview(facts, req.pendapat_kedua)),
           "dibuat": time.strftime("%Y-%m-%dT%H:%M:%S")}
    from aip.runs import _write

    _write(f, out)
    return out
