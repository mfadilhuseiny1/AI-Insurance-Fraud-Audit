"""The AIP fraud consultancy: one engagement on the real JKN data, worked by the system's own agents as a firm works one.

The firm (built by aip/konsultan.py from the data) is the agents of the question flow at work: the orchestrator as its
partner; the domain agents, each leading the small agents that work on its objects (analysts per province, one peer
analyst across the facility classes, specialists per fraud mode of Permenkes 16/2019, investigators for the quarantine
box) — the ML agent leads its technique sub-agents; the validator leads the QA reviewers (another model family) and
the red team. Machines do the deterministic work: the auto-tagger, the ML consensus, the quarantine box, the Nexus sync.

    0 penugasan   the auto-tagger tags every signal of the semantic layer's rules; the orchestrator reads the data and
                  writes the engagement's hypotheses and each workstream's focus
    1 lapangan    the province, mode and peer analysts and the technique sub-agents work side by side: each reads the
                  real data through the semantic layer, and tags every indication it finds, however small (a tag must
                  point at a result the agent itself read); the ML consensus tags facilities many techniques rank high
    2 karantina   every facility with a tag goes into the box, grouped by estimated loss (A … Z) with its TSM reading
    3 investigasi investigators take the top of the box, write an audit workpaper and recommend a path (dibina /
                  ditindak only when Terstruktur, Sistematis dan Masif / dibebaskan)
    4 sintesis    each domain agent synthesises its small agents' work
    5 qa          QA reviewers re-check each synthesis against the data; the red team argues the honest explanation of
                  the strongest tags (they hold or weaken); the summary of both is plain code
    6 laporan     the orchestrator writes the deliverable; the validator (another family) checks its numbers; one revision

The orchestration concept (adk_runtime/orkestrasi.py, docs/Agent Orchestration Concept): the orchestrator writes the
engagement's validation contract with its plan, before any worker starts; every role works from its skill
(aip/skills.py) and hands off in one structure; plain-code scrutiny closes every milestone (phase); the final
validator, of another family, judges the contract; what the validators caught becomes lessons of the skills. Workers
run side by side only within a phase, where they cannot conflict (they read; tags are notes to an idempotent ledger).

Plain code runs the engagement: who works when, how many at once, what each receives. Nothing an agent does changes a
claim or a facility: tags are annotations, a path is a recommendation, people decide both (aip/indikasi.py,
aip/karantina.py). Every step is an event: the page draws the firm live.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from google.adk.agents import LlmAgent

from aip import models as aip_models
from aip import semantik as S
from aip import telaah as TL
from aip.adk_runtime import agents as A
from aip.adk_runtime import orkestrasi as O
from aip.adk_runtime import telaah as TR
from aip.adk_runtime import tools as T
from aip.adk_runtime.main import _evidence, _setup, stage
from aip.adk_runtime.platform import emit

CONCURRENT = 8  # agents thinking at once: 12 exhausted the Vertex quota of both families at once (2026-10-23)
THREADS = 32  # threads for the agents' blocking tools
ML_JOBS = 3  # technique cross-validations at once (each holds a few GB)
CALLS = {"analis": (34, 48), "analis_kecil": (24, 34), "ml": (4, 8), "manajer": (8, 12), "penyidik": (26, 36), "qa": (14, 18), "red_team": (12, 16), "partner": (6, 12),
         "validator": (12, 20)}  # role -> (tool calls, model calls)
# (analis 24 → 34 and analis_kecil 16 → 24 on 2026-10-29, the user: "bikin agen2 nya working harder … gpp $15 jadi $25";
# Audit Nasional 1's 54 field analysts left 1.119 tags, 21 of them stopping before 60% of their steps — see Firm.analyst)
FIELD_MORE = 0.6  # a field analyst that used less than this share of its steps, or tagged fewer than FIELD_MIN_TAGS, works a second turn
FIELD_MIN_TAGS = 3
# (manajer 6 → 8 and qa 12 → 14 on 2026-10-29: the ML line's lead spent its 6 on the glossary before checking a figure, and
# its reviewer now opens the cited tables with baca_hasil before testing them on the data)
# (the report's validator: 8 reads and 12 model calls ran out before its verdict on 2026-10-28 — the verdict then came from
# its reads on a second call; checking 5–8 numbers takes a read each and room to answer)
# (deeper since 2026-10-24: the chat now reads the engagement instead of re-analysing — the audit pack, aip/paket.py — and
# 49 of 105 handoffs of the last engagement left work undone at their step limit; the user: "run Konsultan Fraud longer so
# it gives more detailed analysis rather than re-analysing each time we ask")
# answer tokens per role: an analyst reading 16 results and writing its report needs room (3,000 cut 9 of 100 agents, 2026-10-23)
PAUSE = 20  # seconds before another try when an endpoint failed (a quota burst passes)
TRIES = 4  # recoveries of an agent whose turn failed, the pause growing each time


def _rate_limited(e: BaseException) -> bool:
    text = f"{type(e).__name__} {e}"
    return "RateLimit" in text or "429" in text or "Resource exhausted" in text or "RESOURCE_EXHAUSTED" in text


def _transient(e: BaseException) -> bool:
    # (a malformed model reply, "Error in response object", passes on a retry: 9 agents of the 2026-10-24 engagement were
    # cut short by it and handed off half their work)
    return _rate_limited(e) or "Timeout" in type(e).__name__ or "upstream_timeout" in str(e) or "no model answered" in str(e) \
        or "Error in response object" in str(e)
TOKENS = {"analis": 10000, "analis_kecil": 10000, "ml": 3000, "manajer": 6000, "penyidik": 10000, "qa": 8000, "red_team": 6000, "partner": 8000, "validator": 8000}
PHASES = [("penugasan", "Penugasan"), ("lapangan", "Kerja lapangan"), ("karantina", "Box karantina"), ("investigasi", "Investigasi"),
          ("sintesis", "Sintesis agen domain"), ("qa", "QA & red team"), ("laporan", "Laporan orkestrator"), ("redaksi", "Redaksi laporan")]
# Blu 1.1 and 1.3 (aip/telaah.py): the clinical review of every screened claim before the plan, so the plan and every agent
# read it. A phase list per version: a Blu 1.0 engagement continued after a cut must not think it was cut at a phase it never has
PHASES_11 = [("telaah", "Telaah klinis (Blu 1.1)")] + PHASES
PHASES_13 = [("telaah", "Pemeriksaan keputusan (Blu 1.3)")] + PHASES
# Blu 3.0 (aip/blu3.py): the v3 scoring machine before the plan; no clinical review, no ML technique line
PHASES_30 = [("skoring_v3", "Scoring ML v3")] + PHASES
# what every province analyst discovers on its own when the orchestrator's plan names no regional questions
REGIONAL = ["Modus apa yang paling menonjol di provinsi ini per 1.000 klaim dibanding nasional dan faskes sekelasnya?",
            "Faskes mana yang menyimpang dari faskes sekelasnya di provinsi ini, pada ukuran apa, dan seberapa jauh?",
            "Kode INA-CBG, diagnosis atau bulan apa yang mengumpulkan sinyal di provinsi ini?",
            "Pola apa yang khas provinsi ini dan tidak ada di hipotesis global?"]
LABELS = {**dict(PHASES_11), "skoring_v3": "Scoring ML v3"}

RULES = """Aturan firma (wajib):
- Data: Data Sampel BPJS Kesehatan 2025 — klaim JKN nyata yang dianonimkan — lewat objek Nexus dan model ML yang dilatih
  dengan label nyata. Bukan data sintetis. Setiap angka diambil dengan tool dan disebut dengan hasil_id-nya (mis. [r12]).
- Bahasa: "indikasi", bukan tuduhan. Label model = klaim yang DIKOREKSI verifikator (dibayar kurang dari tagihan), bukan
  fraud terbukti. Fraud hanya dinyatakan oleh audit dan penegak hukum.
- Pakai lapisan semantik: hitung dengan `ukur` (definisi ukuran sama untuk semua agen), pakai `kamus_semantik` bila istilah
  ragu. Bandingkan dengan PEER (tipe faskes yang sama) sebelum menyebut sesuatu tidak wajar.
- Negatif sulit (wajar walau tampak mencurigakan): RS kelas A/tersier dan RS khusus (keparahan dan LOS memang tinggi),
  dialisis dan kemoterapi (rawat ulang sah), diagnosis langka berbiaya tinggi, faskes kecil (angka tidak stabil), masa
  COVID. Sebut bila sebuah sinyal mungkin dijelaskan oleh ini — tetapi TETAP tandai dengan kekuatan yang jujur.
- TANDAI SETIAP INDIKASI, SEKECIL APA PUN: tandai_indikasi (satu objek) atau tandai_hasil (semua baris satu hasil, untuk
  sapuan sinyal lemah). Kekuatan: lemah = satu sinyal, bisa jadi wajar; sedang = beberapa sinyal searah atau > p95 peer;
  kuat = beberapa sumber saling menguatkan atau penyimpangan ekstrem yang tidak dijelaskan kelas/case-mix. Bukti tag
  harus hasil yang ANDA baca (hasil_id Anda), dengan angkanya. Menandai objek yang sudah bertag dari agen lain menambah
  dukungan — lakukan hanya setelah Anda memeriksa datanya sendiri.
- Tidak ada yang Anda ubah: tag adalah catatan, manusia yang memutuskan. Jawab dalam Bahasa Indonesia."""


BASE_CONTRACT = ["Setiap faskes kelompok A dan B yang diaudit punya rekomendasi jalur dari penyidiknya di penugasan ini.",
                 "Rekomendasi 'ditindak' hanya untuk faskes yang Terstruktur, Sistematis dan Masif ketiganya terpenuhi.",
                 "Setiap angka di ringkasan eksekutif menyebut hasil_id dan cocok dengan buku besar indikasi atau box karantina.",
                 "Laporan menyebut indikasi (bukan fraud terbukti) dan keputusan yang dibutuhkan dari manusia."]

# The report is written outline first (STORM's outline → sections → article, on the engagement's own evidence): the
# partner outlines every section as points, each with its sources; code drops a point whose result id is not of this
# engagement, or that has no source where numbers live; each section is written from only what its points cite; code
# joins them, so no narration about the writing reaches the client (engagements 3–5 opened with "Sebelum menulis…").
# (id, heading, what it holds, most points)
SECTIONS = [("ringkasan", "Ringkasan eksekutif", "5 butir: angka terpenting penugasan, tiap butir dengan hasil_id", 5),
            # for leaders who are not technical (the user, 2026-10-24), by the plain-language model; code drops a sentence
            # whose number its material does not give (orkestrasi.plain_check)
            ("awam", "Penjelasan untuk pimpinan", "3–5 kalimat tanpa istilah teknis: apa yang ditemukan, seberapa besar dalam ukuran "
                                                          "sehari-hari (\"x dari setiap 1.000 klaim\", \"n kali lipat\"), apa yang perlu diputuskan", 4),
            ("lingkup", "Lingkup & metode", "siapa bekerja dan bagaimana: orkestrator, agen domain dengan agen kecilnya, sub-agen teknik ML, validator "
                                            "dengan QA dan peran red team; penyidik dan red team adalah peran dinamis (satu instans per kasus antrean); "
                                            "lapisan semantik, penanda otomatis, konsensus teknik ML; data nyata", 4),
            ("temuan", "Temuan utama", "per agen domain (wilayah dan kelas faskes, modus klaim, klinis, peserta dan rujukan, ML): angka + hasil_id", 10),
            # the long report's chapters on where and how (aip/laporan_konsultan.py CHAPTERS), in the firm's own words since
            # 2026-10-24: before, those two chapters held only exhibits
            ("wilayah", "Di mana risikonya berada", "provinsi dan kelas faskes yang menanggung kerugian dan klaim berisiko terbesar, dibandingkan per "
                                                   "1.000 klaim dengan peernya (sintesis Agen Faskes & Wilayah, laporan analis provinsi): angka + hasil_id", 5),
            ("modus", "Bagaimana indikasi fraud terjadi", "modus Permenkes 16/2019 yang paling banyak dan paling kuat buktinya, kode INA-CBG dan pola "
                                                          "waktunya (sintesis agen klinis, klaim, peserta): angka + hasil_id", 5),
            ("box", "Box karantina dan kasus prioritas", "2–4 kalimat tafsiran box dan kasus (tabelnya ditambahkan kode dari data); rekomendasi "
                                                         "jalur hanya dari penyidik, \"ditindak\" hanya bila T, S dan M terpenuhi", 4),
            ("keandalan", "Keandalan", "QA, red team, keterbatasan: indikasi bukan fraud terbukti; label = koreksi verifikator; data sampel", 5),
            ("keputusan", "Keputusan yang dibutuhkan dari manusia", "konfirmasi tag, keputusan jalur audit, siapa memutuskan apa", 4)]
SOURCED = {"ringkasan", "temuan", "box", "wilayah", "modus"}  # where a point without a source is dropped (the numbers live there)
SOURCE_WORDS = {"qa", "fakta", "kontrak", "rencana"}  # sources other than a result id or a domain agent's synthesis


def _idn(n: Any) -> str:
    """A whole number in Indonesian notation (17.013), as the report writes it."""
    return f"{round(float(n or 0)):,}".replace(",", ".")


def _when(t: Any) -> datetime | None:
    """An event's time ("2026-10-23T12:24:31", UTC, as the run log writes it) as a naive UTC datetime; None when it has none."""
    try:
        d = datetime.fromisoformat(str(t))
    except (TypeError, ValueError):
        return None
    return d.astimezone(timezone.utc).replace(tzinfo=None) if d.tzinfo else d


def _section_only(text: str) -> str:
    """A section's body: without a heading of its own on top, or a line about the writing in front of it."""
    lines = (text or "").strip().splitlines()
    while lines and (re.match(r"^#{1,4}\s", lines[0]) or not lines[0].strip()
                     or re.match(r"(?i)^(berikut|baik|tentu|here|sure|okay|ok)\b.{0,160}:?\s*$", lines[0]) and len(lines) > 1):
        lines.pop(0)
    return "\n".join(lines).strip()


# a model thinking aloud in its answer: lines opening in English the way reasoning does (the report is Indonesian)
NARRATION = re.compile(r"(?mi)^\s*(?:[-*\d.]+\s*)?(?:I need to|I'll|I will|I should|I think|Let me|Let's|Wait\b|Hmm|Actually\b|Okay\b|So the\b|"
                       r"Now I\b|First, I|From fakta|From r\d+|Looking at|The framework|Maybe the)")
SCRATCH = re.compile(r"(?i)^\s*(?:[-*]\s*)?(?:Let me (?:verify|check|re-?check|look|re-?read|review)|Wait\b|Hmm)")


def _strip_narration(text: str) -> str:
    """A section without the model's thinking: its reasoning lines dropped, and from the first scratch line on ("Let me
    verify…", "Wait…") once the section's own content stands above it, nothing kept (what follows is its working)."""
    out: list[str] = []
    for line in (text or "").splitlines():
        if SCRATCH.match(line) and sum(1 for x in out if x.strip()) >= 2:
            break
        if not NARRATION.match(line):
            out.append(line)
    return "\n".join(out).strip()


def _assemble(title: str, sections: list[dict]) -> str:
    return f"# {title}\n\n" + "\n\n".join(f"## {s['judul']}\n\n{s.get('teks') or '_(tidak ada poin bersumber untuk bagian ini)_'}" for s in sections)


def _numbers(text: str) -> set[str]:
    return {re.sub(r"[.,]", "", n) for n in re.findall(r"\d[\d.,]*\d|\d{2,}", text or "")}


# the report desk (aip/konsultan.py report_team): leads that are not domain agents — no synthesis of their own
NOT_DOMAIN = {"validator", "redaksi"}


def _edit_refused(old: str, new: str) -> str:
    """Why the editor's version of a section is not kept ("" when it is): it may change the words, never what is claimed."""
    if not new.strip():
        return "suntingan kosong"
    if _numbers(old) != _numbers(new):
        gone, added = sorted(_numbers(old) - _numbers(new))[:4], sorted(_numbers(new) - _numbers(old))[:4]
        return f"angka berubah (hilang: {', '.join(gone) or '-'}; baru: {', '.join(added) or '-'})"
    if set(re.findall(r"\br\d+\b", old)) != set(re.findall(r"\br\d+\b", new)):
        return "rujukan hasil_id berubah"
    codes = lambda t: set(re.findall(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b", t))  # noqa: E731 - tag codes such as KLAIM_GANDA
    if codes(old) - codes(new):
        return f"kode tag hilang: {', '.join(sorted(codes(old) - codes(new))[:3])}"
    if not 0.6 <= len(new) / max(1, len(old)) <= 1.5:
        return f"panjang berubah terlalu jauh ({len(old)} → {len(new)} karakter)"
    return ""


# the words by which a contract statement or a scrutiny check names the section it is about
ABOUT = {"ringkasan": r"ringkasan", "awam": r"penjelasan untuk pimpinan|bahasa awam|non-teknis", "lingkup": r"jumlah agen|lingkup|metode", "box": r"box karantina|rekomendasi jalur|ditindak|dibina|diaudit",
         "keandalan": r"red team|keterbatasan|keandalan", "keputusan": r"keputusan (yang dibutuhkan|manusia)",
         "wilayah": r"provinsi|wilayah|kelas (rs|rumah sakit)", "modus": r"modus|permenkes|ina-cbg"}


def _implicated(sections: list[dict], fix: list[dict]) -> set[str]:
    """The sections the validator's notes are about: those holding a number a failed claim quotes, or a result id a
    scrutiny check could not find, or named by a contract statement (ABOUT); every section when a note points nowhere
    (engagement 5's rewrite: a summary-only statement rewrote all six sections, $0.20)."""
    every = {s["id"] for s in sections}
    out: set[str] = set()
    for f in fix:
        about = str(f.get("pernyataan") or f.get("scrutiny") or "")
        ghosts = set(re.findall(r"\br\d+\b", str(f.get("bukti") or ""))) if "scrutiny" in f else set()
        hit = ({s["id"] for s in sections if ghosts & set(re.findall(r"\br\d+\b", s.get("teks") or ""))} if ghosts else
               {sid for sid, rx in ABOUT.items() if re.search(rx, about, re.I)} if about else
               {s["id"] for s in sections if _numbers(str(f.get("klaim") or "")) & _numbers(s.get("teks") or "")})
        if not hit & every:
            return every
        out |= hit & every
    return out or every


def _qa_summary(team: dict, verdicts: dict, red: list[dict]) -> str:
    """The validator's summary of QA and the red team for the orchestrator: counts and the claims that failed, in plain code."""
    summary = "\n".join(f"- QA {(team.get(lead) or {}).get('name', lead)}: {sum(bool(c.get('ok')) for c in cs)}/{len(cs)} lolos" +
                        ("; gagal: " + "; ".join(str(c.get("klaim"))[:140] for c in cs if not c.get("ok")) if any(not c.get("ok") for c in cs) else "")
                        for lead, cs in verdicts.items())
    reds = "\n".join(f"- {x['tag']} · {x['judul'][:70]}: {x['hasil']} → {x['kekuatan']}" for x in red)
    return f"QA per sintesis:\n{summary or '- tidak ada putusan QA'}\nRed team ({len(red)} indikasi diuji):\n{reds or '- tidak ada putusan red team'}"


def _tag_code(tag: str) -> str:
    """A tag code as the semantic layer writes it ("Klaim ganda", "klaim-ganda" → KLAIM_GANDA); a near miss of one code
    is that code; anything else is refused with the codes."""
    import difflib

    code = re.sub(r"[\s-]+", "_", str(tag or "").strip()).upper()
    if code in S.TAG:
        return code
    near = difflib.get_close_matches(code, list(S.TAG), n=2, cutoff=0.8)
    if len(near) == 1:
        return near[0]
    raise ValueError(f"tag '{tag}' tidak ada di lapisan semantik; kode: {', '.join(S.TAG)}")


def _strength(k: str) -> str:
    k = str(k or "").strip().lower()
    k = {"rendah": "lemah", "weak": "lemah", "low": "lemah", "menengah": "sedang", "medium": "sedang", "tinggi": "kuat", "strong": "kuat", "high": "kuat"}.get(k, k)
    if k not in ("lemah", "sedang", "kuat"):
        raise ValueError(f"kekuatan '{k}' tidak dikenal: lemah, sedang atau kuat")
    return k


def _mine(box: Any, key: str, rid: str) -> bool:
    """A data result the agent itself read in this run (a tag's evidence: never another's read, never a tag list)."""
    hit = next((x for x in box.index if x["rid"] == rid), None)
    return bool(hit) and hit["meta"].get("agent") == key and hit["meta"].get("kind") != "indikasi"


def _holds(box: Any, key: str, rid: str, kunci: Any) -> bool:
    """Whether the agent's own data result `rid` has a row with `kunci` in some column (the API decides by its key columns)."""
    want = str(kunci or "").strip().upper()
    return bool(want) and _mine(box, key, rid) and any(str(v).strip().upper() == want for r in box.rows.get(rid) or [] for v in r.values())


def _short(f: dict) -> str:
    """ "Khusus Jiwa", "KOTA SINGKAWANG" → "RS Jiwa Singkawang": a facility in a few words, for an instance's name."""
    tipe = str(f.get("tipe") or f.get("jenis") or "Faskes")
    for a, b in (("Khusus ", "RS "), ("RS Swasta Setara Type ", "RS Swasta "), ("RS TNI Polri Kelas ", "RS TNI/Polri "), ("RS Kelas ", "RS ")):
        tipe = tipe.replace(a, b)
    return f"{tipe} {str(f.get('kabkota') or '').title().replace('Kabupaten ', 'Kab. ').replace('Kota ', '')}".strip()


def _report_only(text: str) -> str:
    """The report without the agent's narration in front of it (engagements 3 and 4 opened with "Sebelum menulis laporan…
    Berikut laporan akhir. ---"): from its first heading on, when it has one near the top."""
    m = re.search(r"(?m)^#{1,3} \S", text or "")
    return text[m.start():] if m and m.start() < 4000 else text


def _semantic_brief() -> str:
    meas = "\n".join(f"- {k}: {u['label']} [{u['tipe']}, {u['metrik']}({u['properti'] or '*'})" +
                     (f", filter {json.dumps(u['filter'], ensure_ascii=False)}" if u["filter"] else "") + "]" +
                     (f" → tag {', '.join(u['tag'])}" if u["tag"] else "") for k, u in S.UKURAN.items())
    dims = ", ".join(S.DIMENSI)
    tags = "\n".join(f"- {k}: {t['label']} — {t['modus']}; sinyal: {t['sinyal']}" for k, t in S.TAG.items())
    return f"""Lapisan semantik (aip/semantik.py, versi {S.VERSION}):
Ukuran (nama untuk `ukur`):
{meas}
Dimensi: {dims}
Tag indikasi (Permenkes 16/2019 bila modus):
{tags}
Entitas tag: {', '.join(S.ENTITAS)} (kunci: klaim_id, faskes_profil_id, kabkota_kode atau nama, provinsi_kode atau nama, inacbg_kode,
peserta_key, alur_rujukan_id, icd3)."""


def _types_brief(catalogue: dict) -> str:
    """The main Nexus types' properties (api_name), so agents filter and sort on names that exist."""
    want = (S.T_KLAIM, S.T_ML_KLAIM, S.T_ML_FASKES, S.T_FASKES, S.T_KAB, S.T_PROV, S.T_INDIKATOR, S.T_RUJUKAN, S.T_PESERTA)
    types = {t["name"]: t for a in catalogue["agents"] for t in a["object_types"]}
    return "Properti tipe objek utama (pakai nama persis):\n" + "\n".join(
        f"- {n} (kunci {types[n]['primary_key']}): " + ", ".join(p["api_name"] for p in types[n]["properties"][:48]) for n in want if n in types)


class Firm:
    def __init__(self, inp: dict):
        self.inp = inp
        # the AI orchestration: Blu 1.0, Blu 1.1 (the clinical review first) or Blu 1.3 (the review's screen is OpenAI Decisions)
        self.versi = str(inp.get("versi") or "1.0")
        # Blu 3.0's reading scope (the user, 2026-11-12, options 1-3): claim rows only from ML v3's output and a control sample
        self.lingkup_v3 = self.versi == "3.0" and bool(inp.get("lingkup_v3"))
        self.reviewed = self.versi in TL.REVIEWED
        self.phases = {"1.1": PHASES_11, "1.3": PHASES_13, "3.0": PHASES_30}.get(self.versi, PHASES)
        self.v3: dict = {}  # Blu 3.0: the v3 scoring machine's summary and its result ids
        # Blu 1.1 / 1.3: the clinical review's summary (never `self.review`: that name is the QA method below, and shadowing it
        # crashed every QA reviewer of the engagements of 2026-10-30)
        self.telaah: dict = {}
        self.p, self.m, self.cat, self.box, self.service = _setup(inp)
        self.run_id = inp["run_id"]
        self.team = {a["key"]: a for a in inp["tim"]}
        if "validator" in self.team:  # the system's validator: the model its role has in this run
            self.team["validator"]["model"] = inp.get("validator_model") or self.cat["roles"]["validator"]
        for k, c in (inp.get("konfigurasi") or {}).items():  # a model set in Konfigurasi agen: the team (and its instances) carry it
            if k in self.team and c.get("model"):
                self.team[k]["model"] = c["model"]
        self.sem = asyncio.Semaphore(int(inp.get("paralel") or CONCURRENT))  # a project's IT setting (aip/konsultan.py PARALEL)
        seats = inp.get("kursi") or {}
        if seats.get("glm"):  # the project's lead model also plans the lessons; the plain-language layer stays off its family
            self.cat["roles"]["planner"] = seats["glm"]
            if aip_models.family(self.cat["roles"].get("awam") or "") == aip_models.family(seats["glm"]):
                self.cat["roles"]["awam"] = seats.get("oss") or self.cat["roles"]["awam"]
        self.cool_until = 0.0  # after a 429 every agent waits until then before its next call
        self.ml_sem = asyncio.Semaphore(ML_JOBS)
        self.tags: dict[str, int] = {}
        self.tag_log: dict[str, list[dict]] = {}  # agent -> its tags as they were set: a domain agent's synthesis reads its team's (Firm.team_tags)
        self.reports: dict[str, str] = {}
        self.ml_top: dict[str, list[dict]] = {}
        self.brief = _semantic_brief() + "\n\n" + _types_brief(self.cat)
        if self.versi == "3.0":  # what the v3 profile's types hold, told to every agent
            from aip import blu3

            self.brief += "\n\n" + blu3.brief_line()
            if self.lingkup_v3:
                self.brief += ("\nLINGKUP BACA BLU 3.0: ML v3 sudah menilai SEMUA klaim; agen bekerja di atas hasilnya. Baris klaim hanya dibaca dari "
                               "'Klaim Berisiko (BPJS)' (saringan v3) dan dari sampel kontrol (klaim acak di luar saringan, hasil_id di Scoring ML v3). "
                               "'Skor Risiko Klaim ML (BPJS)' memuat semua klaim: hanya untuk agregasi (ukur, agregasi_objek per faskes/provinsi/kode/"
                               "bulan) dan detail_objek satu klaim dalam lingkup. Tool menolak bacaan klaim di luar lingkup.")
        self.skills = self.cat.get("skills") or []
        self.handoffs: dict[str, dict] = {}
        self.contract: list[dict] = O.contract_of(BASE_CONTRACT, "d")
        self.scrutinies: list[dict] = []
        self.used: set[str] = set()
        self.refused: list[str] = []  # agents whose report was refused: nothing read behind it
        # an engagement continued after an interruption (inp["lanjut"], resume_state): what its earlier attempt finished
        self.done: dict[str, str] = {}  # agent -> its report: finished before the cut, not run again
        self.prior: dict[str, list[dict]] = {}  # agent -> the tool steps of a turn the cut stopped: it goes on from them
        self.prior_instances: dict[str, list[str]] = {}  # role -> the instances formed before the cut (same targets)
        self.prior_verdicts: dict[str, list] = {}
        self.prior_red: list[dict] = []

    def conf(self, key: str) -> dict:
        """An agent's settings from Konfigurasi agen (inp["konfigurasi"], aip/konfigurasi_agen.active at the start): its own,
        else its role's (an investigator, a red team instance)."""
        cfg = self.inp.get("konfigurasi") or {}
        return cfg.get(key) or cfg.get((self.team.get(key) or {}).get("instans_dari") or "") or {}

    def skill(self, key: str) -> str:
        self.used.add(key)
        return O.skill_block(self.skills, key)

    def contract_text(self) -> str:
        return O.contract_text(self.contract)

    # -------------------------------------------------------------------------------------------- tools

    def semantic_tools(self, key: str) -> list[Callable]:
        box, p = self.box, self.p

        def kamus_semantik(istilah: str) -> dict:
            """Arti istilah bisnis di lapisan semantik (mis. "upcoding", "klaim ganda", "lolos verifikasi", "peer",
            "phantom billing"): ukuran, dimensi, tag atau entitas yang menjawabnya, beserta catatannya."""
            hits = S.resolve(istilah)
            keep = ("jenis", "nama", "label", "arti", "catatan", "ke", "tipe", "metrik", "properti", "modus", "sinyal")
            brief = [{k: h[k] for k in keep if h.get(k)} for h in hits[:5]]
            return ({"istilah": istilah, "hasil": brief, "ringkasan": f"{len(hits)} padanan untuk '{istilah}'"},
                    {"request": {"endpoint": "lapisan semantik aip/semantik.py"}})

        def ukur(ukuran: str, dimensi: str, filter_json: str, batas: int) -> dict:
            """Hitung SATU ukuran lapisan semantik (definisi sama untuk semua agen), dikelompokkan menurut dimensi ("" =
            satu angka total). ukuran: nama ukuran dari daftar (mis. klaim_calon_ganda, berisiko_lolos_verifikasi,
            readmisi_faskes, rasio_biaya_peer); dimensi: provinsi, kabkota, faskes, tipe_faskes, jenis_faskes, inacbg,
            keparahan, kelas_rawat, bulan, segmen_model, diagnosis …; filter_json: [{"dimensi": "provinsi", "op": "eq",
            "nilai": "JAWA BARAT"}] dan/atau filter properti [{"property": "klaim", "op": "gte", "value": 200}] ("" bila
            tanpa filter); batas: kelompok yang ditampilkan (1–50, nilai terbesar dulu)."""
            filters = json.loads(filter_json) if (filter_json or "").strip() else []
            if isinstance(filters, dict):
                filters = [filters]
            # the arguments checked before the query (tools.check_measure): 52 calls of `ukur` failed on names in Audit Nasional 1
            ukuran = (ukuran or "").strip()
            dimensi, filters = T.check_measure(ukuran, dimensi, filters, lambda tipe: T._props(box.type_of(key, tipe, any_owner=True)))
            q = S.query(ukuran, dimensi, filters)
            t = box.type_of(key, q["tipe"], any_owner=True)
            q["filters"] = T.check_filters(t, q["filters"])
            body = {"object_type_id": t["id"], "filters": q["filters"], "limit": 1, "histograms": False, "resource": "aip", "aggregate": q["aggregate"]}
            r, note = T._search(p, body)
            prop = q["aggregate"]["group_by"]
            groups = sorted((r.get("aggregation") or {}).get("groups") or [], key=lambda g: -(g.get("value") or 0) if isinstance(g.get("value"), (int, float)) else 0)
            names = box.labels(prop, [g.get("group") for g in groups[:200]]) if prop else {}
            where = box.geo(prop, [g.get("group") for g in groups[:200]]) if prop else {}
            rows = [{**({"nama": names[str(g.get("group"))]} if str(g.get("group")) in names else {}), **g, **({prop: g.get("group")} if prop else {}),
                     **({"lokasi": where[str(g.get("group"))]} if str(g.get("group")) in where else {})} for g in groups]
            u = q["ukuran"]
            rid = box.result(f"{u['label']}" + (f" per {S.DIMENSI[dimensi]['label'].lower()}" if dimensi else "") +
                             (f" · {', '.join(str(f.get('nilai', f.get('value'))) for f in filters)}" if filters else ""),
                             rows, t, {"group": "string", "nama": "string", "value": "double", "count": "integer", "lokasi": "string", **({prop: "string"} if prop else {})},
                             {"kind": "agg", "group": prop, "metric": q["aggregate"]["metric"], "prop": q["aggregate"]["property"], "type": t["name"],
                              "filters": q["filters"], "ukuran": ukuran})
            n = max(1, min(int(batas or 15), 50))
            shown = [{**({"kelompok": g.get("group"), **({"nama": g["nama"]} if g.get("nama") else {})} if prop else {}),
                      "nilai": g.get("value"), "jumlah_objek_dihitung": g.get("count")} for g in rows[:n]]
            total = rows[0].get("value") if rows and not prop else None
            return ({"ukuran": ukuran, "label": u["label"], "arti": u["arti"], "satuan": u["satuan"], **({"catatan": u["catatan"]} if u["catatan"] else {}),
                     "tipe": t["name"], **({"nilai_total": total, "satuan_nilai": u["satuan"]} if not prop else {}),
                     "objek_dihitung": r.get("total"), "hasil": shown, "jumlah_kelompok": len(rows), "hasil_id": rid,
                     "cara_baca": "nilai = ukuran itu sendiri; jumlah_objek_dihitung / objek_dihitung = banyaknya objek Nexus yang diagregasi (BUKAN nilai ukuran)",
                     **({"catatan_filter": note} if note else {}),
                     "ringkasan": f"{ukuran}" + (f" per {dimensi}: {len(rows)} kelompok" if prop else f" = {total} {u['satuan']} (dihitung atas {r.get('total')} objek)")},
                    {"request": {"endpoint": "POST /api/ontology/explorer/search", "body": body, "semantik": {"ukuran": ukuran, "dimensi": dimensi}},
                     # objek: the Nexus objects this measure aggregated (the firm chart counts them beside the rows read)
                     "rid": rid, "rows": len(rows), "objek": r.get("total"), "links": [{"app": "objects", "type_id": t["id"], "type": t["name"]}]})

        return [box.wrap(key, f.__name__, f) for f in (kamus_semantik, ukur)]

    def tag_tools(self, key: str, bulk: bool = True) -> list[Callable]:
        box, p, a = self.box, self.p, self.team.get(key) or {"name": key, "model": ""}

        def own(rid: str) -> dict:
            hit = next((x for x in box.index if x["rid"] == rid), None)
            if not hit:
                raise LookupError(f"hasil_id {rid} tidak ada di run ini")
            if hit["meta"].get("agent") != key:
                raise PermissionError(f"{rid} bukan hasil bacaan Anda: tandai hanya dari hasil yang Anda baca sendiri")
            if hit["meta"].get("kind") == "indikasi":
                raise PermissionError("bukti tag harus data, bukan daftar tag: baca datanya dulu (ukur, cari_objek, risiko_faskes_ml …) lalu pakai hasil_id itu")
            return hit

        def tandai_indikasi(entitas: str, kunci: str, tag: str, kekuatan: str, bukti: str, hasil_id: str) -> dict:
            """TANDAI SATU indikasi, sekecil apa pun. entitas: klaim, faskes, kabkota, provinsi, inacbg, peserta, rujukan,
            diagnosis; kunci: kunci objek itu (klaim_id, faskes_profil_id, kode atau nama wilayah …) yang ADA di hasil_id;
            tag: kode tag lapisan semantik (mis. KLAIM_GANDA, UPCODING_KEPARAHAN, OUTLIER_PEER); kekuatan: lemah, sedang
            atau kuat; bukti: angka dan pembandingnya (mis. "porsi calon ganda 4,1% vs median kelas 0,6%"); hasil_id:
            hasil bacaan Anda yang memuat objek itu. Gerbang kode (ditolak, jangan dicoba): KOREKSI_BERULANG pada faskes
            dengan < 2 klaim dikoreksi (koreksi_aktual); KLONING_KLAIM pada klaim skema COVID-19; bukti berupa daftar tag."""
            tag, kekuatan = _tag_code(tag), _strength(kekuatan)
            # the result the tag points at: the one named when it is the agent's own data holding the object, else one of its
            # own data reads that holds it (those its evidence cites first) — 57 tags of Audit Nasional 1 were refused for
            # pointing at a tag list or at a result grouped by another key while the agent had read the object elsewhere
            tries = [rid for rid in dict.fromkeys([hasil_id, *re.findall(r"\br\d+\b", bukti or ""), *[x["rid"] for x in reversed(box.index)]])
                     if _holds(box, key, rid, kunci) or rid == hasil_id and _mine(box, key, rid)][:3]
            # an object named rather than keyed ("FKRTL · Rumah sakit · … · PASURUAN"): the key of the row so named, so the
            # data's gates decide the tag, not its spelling (prov_35 of 29-10 tagged a facility by its name)
            col = {"faskes": "faskes_profil_id", "klaim": "klaim_id", "peserta": "peserta_key", "rujukan": "alur_rujukan_id"}.get(str(entitas or "").strip().lower())
            row = next((r for rid in tries for r in box.rows.get(rid) or [] if col and r.get(col) and str(r.get(col)) != str(kunci)
                        and str(kunci).strip().upper() in {str(v).strip().upper() for v in r.values()}), None)
            if row:
                kunci = str(row[col])
            if self.lingkup_v3 and str(entitas or "").strip().lower() == "klaim":
                T._claim_in_scope(box, kunci)
            if not tries:
                own(hasil_id)  # its own refusal says why (not this run's, not the agent's, a tag list)
                raise LookupError(f"{entitas} '{kunci}' tidak ada di {hasil_id} maupun hasil bacaan data Anda yang lain: baca objek itu dulu "
                                  "(cari_objek / detail_objek / ukur dengan filternya), lalu tandai dengan hasil_id bacaan itu")
            for n, rid in enumerate(tries):
                body = {"run_id": self.run_id, "agen": key, "peran": a.get("name", key), "model": a.get("model", ""), "entitas": entitas, "kunci": str(kunci),
                        "tag": tag, "kekuatan": kekuatan, "bukti": bukti, "hasil_id": rid}
                try:
                    r = p.post("/api/aip/indikasi", body)
                    break
                except Exception as e:  # noqa: BLE001 - the next result holding the object, or the refusal as it was
                    if "tidak ada di hasil" not in str(e) or n == len(tries) - 1:
                        raise
            if rid != hasil_id:
                r = {**r, "catatan_hasil_id": f"{entitas} '{kunci}' tidak ada di {hasil_id}: tag menunjuk {rid}, bacaan Anda yang memuatnya"}
            hasil_id = rid
            self.tags[key] = self.tags.get(key, 0) + 1
            self.tag_log.setdefault(key, []).append({"judul": str(r.get("judul") or kunci)[:90], "tag": tag, "kekuatan": r.get("kekuatan") or kekuatan, "rid": hasil_id})
            emit({"type": "tag", "agent": key, "id": r["id"], "tag": tag, "entitas": entitas, "kunci": str(kunci), "judul": r["judul"], "kekuatan_agen": kekuatan,
                  "kekuatan": r["kekuatan"], "dukungan": r["dukungan"], "keluarga_model": r["keluarga_model"], "klasifikasi": r["klasifikasi"], "baru": r["baru"],
                  "bukti": bukti[:300], "rid": hasil_id})
            return ({**r, "ringkasan": f"{tag} pada {entitas} {str(r['judul'])[:60]}: {r['kekuatan']}, {r['dukungan']} sumber"},
                    {"request": {"endpoint": "POST /api/aip/indikasi", "body": {k: v for k, v in body.items() if k != "bukti"}}, "rid": hasil_id})

        def tandai_hasil(hasil_id: str, entitas: str, tag: str, kekuatan: str, bukti: str) -> dict:
            """Tandai SEMUA baris satu hasil bacaan Anda dengan satu tag (sapuan sinyal lemah: semua yang muncul dicatat,
            maks. 500 baris). Pakai untuk daftar yang seluruhnya memenuhi sinyal (mis. hasil ukur yang sudah difilter
            di atas ambang, atau daftar faskes teratas sebuah teknik ML). bukti: kriteria dan ambangnya."""
            hit = own(hasil_id)
            tag, kekuatan = _tag_code(tag), _strength(kekuatan)
            # a sweep is a weak signal by design: its evidence is the list's criterion, not each row's own reading — on 29-10
            # agents swept whole top-100 rankings as "kuat" on a note about their top 5. At most sedang, lemah past 20 rows;
            # a row grows stronger as other sources tag it (the ledger's corroboration)
            n_rows = len(box.rows.get(hasil_id) or [])
            if self.lingkup_v3 and box.lingkup and str(entitas or "").strip().lower() == "klaim":
                outside = [r.get("klaim_id") for r in box.rows.get(hasil_id) or [] if r.get("klaim_id") and str(r["klaim_id"]) not in box.lingkup["boleh"]]
                if outside:
                    raise LookupError(f"Blu 3.0: {len(outside)} klaim di {hasil_id} di luar lingkup baca (bukan Klaim Berisiko, bukan sampel kontrol); "
                                      "tandai klaim dari Klaim Berisiko (BPJS) atau sampel kontrol saja.")
            kekuatan = "lemah" if n_rows > 20 else "sedang" if kekuatan == "kuat" else kekuatan
            body = {"run_id": self.run_id, "agen": key, "peran": a.get("name", key), "model": a.get("model", ""), "entitas": entitas, "tag": tag,
                    "kekuatan": kekuatan, "bukti": bukti, "hasil_id": hasil_id}
            r = p.post("/api/aip/indikasi/hasil", body)
            self.tags[key] = self.tags.get(key, 0) + r["ditandai"]
            self.tag_log.setdefault(key, []).append({"judul": f"{r['ditandai']} {entitas} dari {hit['title'][:70]}", "tag": tag, "kekuatan": kekuatan, "rid": hasil_id,
                                                     "sapuan": True})
            emit({"type": "tag", "agent": key, "bulk": True, "tag": tag, "entitas": entitas, "jumlah": r["ditandai"], "baru": r["baru"], "kekuatan_agen": kekuatan,
                  "judul": hit["title"], "bukti": bukti[:300], "rid": hasil_id})
            return ({**r, "ringkasan": f"{r['ditandai']} {entitas} ditandai {tag} ({kekuatan}), {r['baru']} tag baru"},
                    {"request": {"endpoint": "POST /api/aip/indikasi/hasil", "body": {k: v for k, v in body.items() if k != "bukti"}}, "rid": hasil_id})

        def lihat_indikasi(provinsi: str, faskes_profil_id: str, tag: str, kekuatan_min: str, batas: int) -> dict:
            """Tag indikasi yang sudah ada (penanda otomatis dan agen lain) di cakupan Anda: provinsi (nama HURUF BESAR),
            faskes_profil_id, tag, kekuatan_min (lemah/sedang/kuat) — "" bila tidak dipakai; batas 1–50. Untuk menguatkan
            sebuah tag, periksa DATANYA dulu dengan tool data, lalu tandai dengan hasil_id data itu."""
            r = p.get("/api/aip/indikasi", provinsi=provinsi or None, faskes=faskes_profil_id or None, tag=tag or None, kekuatan=kekuatan_min or None,
                      limit=max(1, min(int(batas or 20), 50)))
            rows = [{"indikasi_id": v["id"], "tag": v["tag"], "entitas": v["entitas"], "kunci": v["kunci"], "judul": v["judul"], "kekuatan": v["kekuatan"],
                     "dukungan": v["dukungan"], "otomatis": v["otomatis"], "bukti": (v["bukti"] or "")[:160],
                     **{c: (v.get("konteks") or {}).get(c) for c in ("faskes_profil_id", "provinsi")}} for v in r["tags"]]
            rid = box.result(f"Indikasi yang sudah ada · {provinsi or faskes_profil_id or tag or 'semua'}", rows, meta={"kind": "indikasi"})
            return ({"total": r["total"], "indikasi": rows[:15], "hasil_id": rid, "ringkasan": f"{r['total']} tag di cakupan ini"},
                    {"request": {"endpoint": "GET /api/aip/indikasi"}, "rid": rid, "rows": len(rows)})

        fns = [tandai_indikasi] + ([tandai_hasil] if bulk else []) + [lihat_indikasi]
        # a tag is the agent's finding: like a verdict, it does not spend the reading budget (engagement 3: most specialists
        # ran out of steps before they could tag what they had read)
        return [box.wrap(key, f.__name__, f, counted=f.__name__ == "lihat_indikasi") for f in fns]

    def read_tools(self, key: str, ml: bool = True) -> list[Callable]:
        tools = T.object_tools(self.box, key, any_owner=True, read_only=True)
        if ml:
            tools += [t for t in T.ml_tools(self.box, key, read_only=True) if t.__name__ in ("skor_risiko_klaim_ml", "risiko_faskes_ml", "jelaskan_klaim_ml",
                                                                                             "verifikasi_klaim")]
        return tools

    def box_tool(self, key: str) -> Callable:
        box, p = self.box, self.p

        def lihat_karantina(kelompok: str, batas: int) -> dict:
            """Box karantina: faskes berindikasi per kelompok kerugian (A prioritas … Z kecil) dengan estimasi kerugian,
            penilaian TSM (terstruktur, sistematis, masif), status dan rekomendasi agen. kelompok: A, B, C, D, Z atau ""."""
            r = p.get("/api/aip/karantina", kelompok=kelompok or None, limit=max(1, min(int(batas or 15), 50)))
            rows = [{"faskes_profil_id": f["faskes_profil_id"], "nama": f["nama"], "kelompok": g, "provinsi": f.get("provinsi"), "tipe": f.get("tipe"),
                     "estimasi_kerugian_rp": f["estimasi_kerugian_rp"], "sudah_dikoreksi_rp": f["sudah_dikoreksi_rp"], "klaim_bertag": f["klaim_bertag"],
                     "tag": f["tag"], "kuat": f["kuat"], "keparahan": f["keparahan_label"], "terstruktur": f["tsm"]["terstruktur"]["nilai"],
                     "sistematis": f["tsm"]["sistematis"]["nilai"], "masif": f["tsm"]["masif"]["nilai"], "jalur_awal": f["jalur_awal"], "status": f["status"],
                     "rekomendasi_agen": (f.get("rekomendasi") or [{}])[-1].get("jalur")}
                    for g, grp in r["kelompok"].items() for f in grp["faskes"]]
            rid = box.result(f"Box karantina{' · kelompok ' + kelompok if kelompok else ''}", rows, types={"faskes_profil_id": "string", "nama": "string"},
                             meta={"kind": "karantina", "metric": "estimasi_kerugian_rp", "label": "nama"})
            return ({"ringkasan_box": r.get("ringkasan"), "per_status": r.get("per_status"), "faskes": rows[:20], "hasil_id": rid,
                     "ringkasan": f"{r['total']} faskes di box" + (f", kelompok {kelompok}" if kelompok else "")},
                    {"request": {"endpoint": "GET /api/aip/karantina"}, "rid": rid, "rows": len(rows)})

        return box.wrap(key, "lihat_karantina", lihat_karantina)

    def result_tool(self, key: str) -> Callable:
        box = self.box

        def baca_hasil(hasil_id: str, cari: str, batas: int) -> dict:
            """Baca ulang SATU hasil penugasan ini menurut hasil_id-nya (mis. "r812"): tabel yang dibaca agen mana pun di
            penugasan ini — tabel teknik ML, konsensus ML, ukur, cari_objek, box karantina. Untuk memeriksa angka yang
            dikutip dengan [rN]. cari: teks penyaring baris (nama faskes, kode, kunci; "" = semua); batas: baris (1–40)."""
            rid = str(hasil_id or "").strip().strip("[]")
            hit = next((x for x in box.index if x["rid"] == rid), None)
            if not hit:
                raise LookupError(f"hasil_id {rid} tidak ada di penugasan ini (r1–r{box.n_results})")
            rows = box.rows.get(rid) or []
            q = (cari or "").strip().upper()
            # Blu 3.0: a regional analyst reads the control sample of its own province (the smoke run of 2026-11-12: two read
            # it unfiltered and got the first 40 rows, other provinces')
            provs = ((self.team.get(key) or {}).get("target") or {}).get("provinsi") or []
            if not q and rid == (self.v3.get("rid") or {}).get("kontrol") and (self.team.get(key) or {}).get("lini") == "wilayah" and provs:
                q = str(provs[0] if isinstance(provs, list) else provs).strip().upper()
            sel = [r for r in rows if q in json.dumps(r, ensure_ascii=False).upper()] if q else rows
            if q and not sel:
                # the reviewer's label is shorter than the row's (Audit Nasional 1.1: "RS B Kota Mataram" for "… RS Kelas B ·
                # Pemerintah kab/kota · KOTA MATARAM", 49 claims there, judged unsupported): every word, whole, in any order
                words = re.findall(r"\w+", re.sub(r"\(.*?\)", " ", q))
                sel = [r for r in rows if words and all(re.search(rf"\b{re.escape(w)}\b", json.dumps(r, ensure_ascii=False).upper()) for w in words)]
            return ({"hasil_id": rid, "judul": hit["title"], "kolom": hit["columns"], "total_baris": hit.get("total"), "cocok": len(sel),
                     "baris": sel[:max(1, min(int(batas or 15), 40))], "ringkasan": f"{rid} {hit['title'][:80]}: {len(sel)} baris" + (f" cocok '{cari}'" if q else "")},
                    {"rid": rid, "rows": len(sel)})

        # (the QA of the ML line passed 0 of 6 claims on 2026-10-28: the figures came from the technique tables, which no
        # reviewer's tool could open, so each was judged against a profile search that does not hold them)
        return box.wrap(key, "baca_hasil", baca_hasil)

    def team_tags(self, team: list[dict]) -> str:
        """Each small agent's tags as code recorded them — how many, how strong, its strongest single ones with the result
        they point at — so a domain agent's synthesis covers every agent of its line, not only what fits in their reports
        (the lead of 39 analysts read each report cut to 1.400 characters and named five patterns)."""
        rank = {"kuat": 3, "sedang": 2, "lemah": 1}
        lines = []
        for a in team:
            log = self.tag_log.get(a["key"]) or []
            if not log:
                continue
            single = sorted((x for x in log if not x.get("sapuan")), key=lambda x: -rank.get(str(x.get("kekuatan")), 0))
            swept = sum(1 for x in log if x.get("sapuan"))
            lines.append(f"- {a['name']}: {self.tags.get(a['key'], 0)} tag ({len(single)} satu per satu, {swept} sapuan); terkuat: " +
                         ("; ".join(f"{x['tag']} {x['kekuatan']} · {x['judul']} [{x['rid']}]" for x in single[:3]) or "-"))
        return "\n".join(lines)

    def ml_tables(self) -> str:
        """The technique sub-agents' tables and the consensus by hasil_id, with their first rows: what the ML line's
        synthesis cites and its QA re-opens (baca_hasil)."""
        lines = []
        for x in self.box.index:
            title = x.get("title") or ""
            if not title.startswith(("Faskes teratas menurut ", "Konsensus ")):
                continue
            rows = self.box.rows.get(x["rid"]) or []
            top = "; ".join(f"{r.get('nama') or r.get('faskes_profil_id')} (" + ", ".join(f"{k} {v}" for k, v in r.items() if k in ("ditandai", "klaim", "per_1000", "koreksi", "teknik"))
                            + ")" for r in rows[:5])
            lines.append(f"- [{x['rid']}] {title} — {len(rows)} faskes; teratas: {top}")
        return "\n".join(lines)

    # -------------------------------------------------------------------------------------------- one agent

    async def work(self, key: str, text: str, tools: list, role: str, prompt: str, max_tokens: int = 0, think: str = "", skill: str = "") -> str:
        """One agent's turn, under the firm's concurrency limit; its report comes back (and is shown), its handoff goes to
        the shared state."""
        if key in self.done:  # finished before the engagement was cut: its report and handoff stand, nothing runs again
            return self.done[key]
        # the agent as configured (aip/konfigurasi_agen.py, the Swarm's "Konfigurasi agen"): its own setting or its role's
        c = self.conf(key)
        a = {**self.team[key], **({"model": c["model"]} if c.get("model") else {})}
        limit, calls = c.get("langkah_tool") or CALLS[role][0], c.get("panggilan_model") or CALLS[role][1]
        max_tokens = c.get("token_jawaban") or max(max_tokens, TOKENS[role])
        think = {"rendah": "", "sedang": "medium", "dalam": "deep"}.get(c.get("penalaran") or "", think)
        off = set(c.get("tool_nonaktif") or []) - {"tandai_indikasi", "rekomendasi_jalur", "putusan_red_team", "jalankan_teknik"}
        tools = [t for t in tools if t.__name__ not in off]
        if c.get("instruksi_tambahan"):
            text = f"{text}\n\nInstruksi tambahan dari tim (Konfigurasi agen):\n{c['instruksi_tambahan']}"
        # what the agent is given, in the trail: the configuration page shows the real prompt and tools of the last engagement
        emit({"type": "instruksi", "agent": key, "instans_dari": a.get("instans_dari"), "model": a["model"], "batas": {"langkah_tool": limit,
              "panggilan_model": calls, "token_jawaban": max_tokens, "penalaran": think or "rendah"}, "tools": [t.__name__ for t in tools],
              "teks": text[:16000], "prompt": prompt[:4000], **({"konfigurasi": c} if c else {})})
        self.box.limits[key] = limit
        earlier = self.prior.pop(key, None)
        if earlier:  # its turn was cut: it goes on from the steps it took (their results and tags stand)
            steps = "\n".join(f"- {r.get('tool')} → {r.get('summary') or ''}" for r in earlier[-16:])
            prompt = (f"{prompt}\n\nGiliran Anda sebelumnya terputus (layanan dimulai ulang) setelah langkah-langkah ini; hasilnya tetap berlaku "
                      f"dan tag yang sudah Anda pasang tersimpan. Jangan ulangi langkah itu, lanjutkan dari sana:\n{steps}")
            self.box.calls[key] = max(0, min(len(earlier), limit - 8))
        emit({"type": "agent_status", "agent": key, "status": "antre"})
        async with self.sem:
            await self.cooldown()
            emit({"type": "agent_status", "agent": key, "status": "bekerja", "model": a["model"]})
            t0 = time.time()
            try:
                out, status = await self.turn(key, a["model"], text, tools, prompt, calls, max_tokens, think), "selesai"
            except Exception as e:  # noqa: BLE001 - one agent failing does not stop the firm
                out, status = await self.recover(key, a, text, tools, prompt, calls, max_tokens, think, e)
            if tools and not self.read(key):
                out, status = await self.unread(key, a, text, tools, prompt, calls, max_tokens, think)
        out, h = O.handoff(key, out, self.box.receipts.get(key, []), O.skill_of(self.skills, skill), a.get("peran", ""),
                           "" if status == "selesai" else "giliran agen gagal")
        self.handoffs[key] = h
        O.emit_handoff(h)
        self.reports[key] = out
        emit({"type": "agent_status", "agent": key, "status": status, "ms": int((time.time() - t0) * 1000), "calls": self.box.calls.get(key, 0),
              "tags": self.tags.get(key, 0), "laporan": out[:1500]})
        return out

    async def turn(self, key: str, model: str, text: str, tools: list, prompt: str, calls: int, max_tokens: int, think: str) -> str:
        agent = LlmAgent(name=key, model=self.m.llm(model, key, max_tokens, think=think), instruction=A._const(text), tools=tools, output_key=f"laporan_{key}")
        st = await stage(self.service, agent, prompt, calls, threads=THREADS)
        out = (st.get(f"laporan_{key}") or "").strip()
        if not out:  # the turn ended before the report: what its steps established, said plainly
            rs = self.box.receipts.get(key, [])
            out = "(laporan tidak selesai ditulis) Langkah: " + "; ".join(f"{r['tool']} → {r['summary']}" for r in rs[-12:])
        return out

    def read(self, key: str) -> bool:
        """Whether the agent read anything: at least one tool call that answered."""
        return any(r.get("ok") for r in self.box.receipts.get(key, []))

    async def unread(self, key: str, a: dict, text: str, tools: list, prompt: str, calls: int, max_tokens: int, think: str) -> tuple[str, str]:
        """A report with no read behind it is not evidence (engagement 4: the cloning specialist wrote facilities, INA-CBG
        codes and result ids that do not exist, without a single tool call). The turn runs once more on the other family,
        told why; still nothing read → the report is refused and passed on to no one."""
        other = aip_models.failover(a["model"]) or a["model"]
        why = "laporan tanpa satu pun panggilan tool ditolak (tidak berbukti)"
        emit({"type": "error", "agent": key, "message": f"{why}: giliran diulang pada {other}"})
        emit({"type": "agent_status", "agent": key, "status": "bekerja", "model": other, "catatan": f"{why}; giliran diulang"})
        try:
            out = await self.turn(key, other, text, tools, f"{prompt}\n\nPENTING: laporan Anda sebelumnya ditolak karena tidak memanggil tool apa pun — "
                                                         "tanpa data tidak ada bukti. Panggil tool dulu, lalu tulis hanya yang ada di hasilnya.", calls, max_tokens, think)
        except Exception as e:  # noqa: BLE001 - refused below when it still read nothing
            out = f"(gagal: {type(e).__name__}: {str(e)[:200]})"
        if self.read(key):
            return f"{out}\n\n_(diulang pada {other}: laporan pertama ditolak karena tanpa panggilan tool)_", "selesai"
        self.refused.append(key)
        return f"({why}: agen tidak membaca data apa pun, dua kali; isinya tidak dipakai)", "gagal"

    async def cooldown(self) -> None:
        """Wait out a quota burst: after a 429 no agent starts a call until the firm's cooldown has passed."""
        wait = self.cool_until - time.time()
        if wait > 0:
            await asyncio.sleep(wait)

    def burst(self, err: BaseException, attempt: int = 0) -> None:
        if _rate_limited(err):
            self.cool_until = max(self.cool_until, time.time() + PAUSE * (attempt + 1))

    async def recover(self, key: str, a: dict, text: str, tools: list, prompt: str, calls: int, max_tokens: int, think: str,
                      err: Exception) -> tuple[str, str]:
        """An agent whose turn failed (a model that looped to its token limit, an endpoint that stalled or ran out of
        quota) is not lost. With steps done, a model writes its report from them (the tags it set are in the ledger
        already); with none, the turn runs again. Up to TRIES times, families alternating, the pause growing; a quota
        burst also holds every other agent back (cooldown)."""
        why = f"{type(err).__name__}: {str(err)[:200]}"
        other = aip_models.failover(a["model"])
        if not other:
            return f"(gagal: {why})", "gagal"
        last: BaseException = err
        for attempt in range(TRIES):
            model = other if attempt % 2 == 0 else a["model"]
            self.burst(last, attempt)
            await self.cooldown()
            if not _rate_limited(last) and attempt:
                await asyncio.sleep(PAUSE)
            rs = self.box.receipts.get(key, [])
            emit({"type": "agent_status", "agent": key, "status": "bekerja", "model": model,
                  "catatan": f"dipulihkan oleh {model} (percobaan {attempt + 1}) setelah: {why}"})
            try:
                if rs:
                    steps = "\n".join(f"- {r['tool']} → {r['summary']}" for r in rs[-16:])
                    agent = LlmAgent(name=f"{key}_laporan", model=self.m.llm(model, key, max_tokens), instruction=A._const(text), output_key=f"laporan_{key}")
                    st = await stage(self.service, agent, f"{prompt}\n\nGiliran Anda terhenti ({why}) setelah langkah-langkah ini; hasilnya tetap berlaku dan "
                                                          f"tag yang sudah Anda pasang tersimpan:\n{steps}\n\nTulis laporan Anda sekarang dari hasil langkah itu "
                                                          "saja: tanpa memanggil alat dan tanpa angka yang tidak ada di sana.", 2)
                    out, how = (st.get(f"laporan_{key}") or "").strip(), f"laporan ditulis ulang oleh {model} dari langkah agen ini"
                else:
                    out, how = await self.turn(key, model, text, tools, prompt, calls, max_tokens, think), f"giliran diulang pada {model}"
                if out:
                    return f"{out}\n\n_({how}, percobaan {attempt + 1}, setelah: {why})_", "selesai"
            except Exception as e:  # noqa: BLE001 - another try while it is transient; the steps stand either way
                last = e
                if not _transient(e):
                    break
        return f"(gagal: {why}; pemulihan gagal setelah {attempt + 1} percobaan: {type(last).__name__})", "gagal"

    async def fallback(self, key: str, model: str, make: Callable[[str], Any], output_key: str, prompt: str) -> str:
        """A short stage without tools that turns what an agent read into its verdict or recommendation. An endpoint that
        fails (seen 2026-10-23: a quota burst answered 429 to both families and took the second engagement down) gets one
        more try on another family after a pause; empty when neither answers."""
        models = [x for x in (model, aip_models.failover(model)) if x]
        for n in range(TRIES):
            m_ = models[n % len(models)]
            try:
                await self.cooldown()
                if n:
                    await asyncio.sleep(PAUSE)
                st = await stage(self.service, make(m_), prompt, 3, threads=THREADS)
                if str(st.get(output_key) or "").strip():
                    return str(st[output_key])
            except Exception as e:  # noqa: BLE001 - the next family, or nothing
                self.burst(e, n)
                emit({"type": "error", "agent": key, "message": f"{type(e).__name__}: {str(e)[:200]}"})
                if not _transient(e):
                    break
        return ""

    async def all(self, jobs: list, phase: str) -> None:
        """Agents side by side: one that fails outright is reported and the others carry on."""
        for r in await asyncio.gather(*jobs, return_exceptions=True):
            if isinstance(r, Exception):
                emit({"type": "error", "agent": None, "message": f"fase {phase}: {type(r).__name__}: {str(r)[:300]}"})

    def sizes(self) -> str:
        names = {"wilayah": "analis wilayah", "modus": "spesialis modus", "peer": "analis peer lintas kelas", "ml": "sub-agen teknik ML"}
        cap = ((self.team.get("penyidik_kasus") or {}).get("target") or {}).get("kapasitas", 0)
        return "; ".join(f"{lini} = {sum(1 for a in self.team.values() if a['lini'] == lini and a['jenjang'] == 'analis')} {label}" for lini, label in names.items()) + \
            f"; kasus = peran penyidik, satu instans per faskes antrean box (kapasitas {cap})"

    def counts(self) -> str:
        """ "69 agen dan 29 instans dinamis (17 penyidik, 12 red team)": agents and the instances of the roles, apart."""
        fixed = [a for a in self.team.values() if not a.get("instans_dari")]
        inst: dict[str, int] = {}
        for a in self.team.values():
            if a.get("instans_dari"):
                inst[a["instans_dari"]] = inst.get(a["instans_dari"], 0) + 1
        names = {"penyidik_kasus": "penyidik", "red_team": "red team"}
        return f"{len(fixed)} agen" + (f" dan {sum(inst.values())} instans dinamis (" + ", ".join(f"{n} {names.get(k, k)}" for k, n in inst.items()) + ")"
                                       if inst else "")

    def instances(self, role_key: str, items: list, make: Callable[[int, Any], dict]) -> list[dict]:
        """A role's instances for this engagement: one per queued item, up to the role's capacity, each a fresh-context
        worker with the role's skill, model and lead; announced so the page draws them as they are formed."""
        role = self.team.get(role_key) or {}
        cap = int((role.get("target") or {}).get("kapasitas") or len(items))
        out = []
        for n, item in enumerate(items[:cap], 1):
            inst = {"jenjang": "analis", "induk": role.get("induk"), "lini": role.get("lini"), "model": role.get("model"),
                    "peran_kode": role.get("peran_kode") if role.get("peran_kode") == "red_team" else "analis", "instans_dari": role_key, **make(n, item)}
            self.team[inst["key"]] = inst
            out.append(inst)
        emit({"type": "instances", "role": role_key, "parent": role.get("induk"), "kapasitas": cap, "antrean": len(items),
              "agents": [{k: a.get(k) for k in ("key", "name", "lini", "jenjang", "induk", "model", "peran", "peran_kode", "instans_dari", "target")} for a in out]})
        return out

    def _head(self, a: dict) -> str:
        return f"Anda {a['name']} di AI Agent Swarm AIP JKN (BPJS Kesehatan), swarm agen audit indikasi fraud. Peran: {a['peran']}."

    # -------------------------------------------------------------------------------------------- the phases

    async def engagement(self) -> None:
        if self.inp.get("ulang_laporan"):  # a rewrite of an engagement's report: phases 0–5 copied, the report written anew
            brief, plan, syntheses, qa, box = await asyncio.to_thread(self.restore, self.inp["ulang_laporan"])
            if self.inp.get("ulang_lini"):  # and some lines' synthesis and QA run again first
                syntheses, qa = await self.redo_lines(list(self.inp["ulang_lini"]), plan, syntheses, qa)
            await self.phase_6(brief, plan, syntheses, qa, box)
            await self.phase_7()
            return
        team, brief = self.inp["tim"], self.inp["q"]
        st: dict[str, Any] = {"done_phases": set()}
        if self.inp.get("lanjut"):  # cut short before (an API restart, the machine down): go on from its own trail
            st = await asyncio.to_thread(self.resume_state)
            emit({"type": "lanjut", "fase_selesai": [p for p, _ in self.phases if p in st["done_phases"]], "fase": st.get("cut"), "agen_selesai": len(self.done),
                  "agen_dilanjutkan": len(self.prior), "hasil": self.box.n_results,
                  "catatan": "penugasan dilanjutkan dari jejaknya sendiri: fase yang selesai tidak diulang, agen yang sudah selesai tidak dijalankan lagi, "
                             "agen yang terputus melanjutkan dari langkahnya"})
        else:
            emit({"type": "run", "status": "started", "roles": self.cat["roles"], "kind": "konsultan",
                  "agents": [{"key": a["key"], "name": a["name"], "object_types": [t["name"] for t in a["object_types"]]} for a in self.cat["agents"]]})
            emit({"type": "firm", "tim": team, "mesin": self.inp.get("mesin") or [], "fase": [{"id": i, "label": label} for i, label in self.phases],
                  "brief": brief, "versi": self.versi,
                  # Blu 1.3's examination as a tree beside the domain leads (the user, 2026-10-30): drawn, never one of the roster's agents
                  **({"telaah_tim": TL.team(self.inp.get("kursi") or {}, "1.3")} if self.versi == "1.3" else {})})
        done = st["done_phases"]
        if self.reviewed:
            self.telaah = (st.get("review") or {}) if "telaah" in done else await self.phase_telaah()
        if self.versi == "3.0":  # deterministic and quick: run again on a resume, so its result ids are this process's
            self.v3 = await self.phase_skoring_v3(rerun="skoring_v3" in done)
        plan = st["plan"] if "penugasan" in done else await self.phase_0(brief)
        if "lapangan" not in done:
            await self.phase_1(plan)
        box = st["box"] if "karantina" in done else self.phase_2()
        if "investigasi" not in done:
            await self.phase_3(plan)
        syntheses = st["syntheses"] if "sintesis" in done else await self.phase_4(plan)
        qa = st["qa"] if "qa" in done else await self.phase_5(syntheses)
        await self.phase_6(brief, plan, syntheses, qa, box)
        await self.phase_7()

    def resume_state(self) -> dict:
        """An engagement cut short (the API restarted, the machine went down), continued in the same run: the firm's state
        rebuilt from its own trail — the team and its instances, the plan and contract, every result under its id, each
        agent's steps, handoffs and tags. Phases that finished are not run again; in the phase that was cut, an agent that
        finished keeps its report (Firm.work returns it) and one that was cut goes on from its steps. The report phases
        (laporan, redaksi) run whole again."""
        events = self.p.get(f"/api/aip/runs/{self.run_id}")["events"]
        firm = next((e for e in events if e.get("type") == "firm"), None)
        if firm:
            self.team = {a["key"]: dict(a) for a in firm["tim"]}
            if "validator" in self.team:
                self.team["validator"]["model"] = self.inp.get("validator_model") or self.cat["roles"]["validator"]
        done: set[str] = set()
        plan: dict = {}
        box: dict = {}
        review: dict = {}
        phase = ""
        finished: dict[str, str] = {}  # agent -> the phase it finished in
        texts: dict[str, tuple[str, str]] = {}  # agent -> (phase, its last final text)
        steps: dict[str, list[tuple[str, dict]]] = {}  # agent -> [(phase, tool event)]
        scr: list[dict] = []
        for e in events:
            t = e.get("type")
            if t == "phase":
                phase = e.get("phase") or phase
                if e.get("status") == "selesai":
                    done.add(e["phase"])
            elif t == "result":
                rid = e["rid"]
                try:
                    r = self.p.get(f"/api/aip/runs/{self.run_id}/results/{rid}")
                except Exception:  # noqa: BLE001 - its rows were not kept: the id stays taken
                    r = {}
                title = str(r.get("title") or e.get("title") or "")
                self.box.index.append({"rid": rid, "title": title, "columns": r.get("columns") or [], "total": r.get("total"), "sample": (r.get("rows") or [])[:3],
                                       "meta": {"kind": "lanjutan"}, "types": r.get("types") or {}, "object_type": (r.get("object_type") or {}).get("name")})
                self.box.rows[rid] = r.get("rows") or []
                self.box.n_results = max(self.box.n_results, int(rid[1:]))
                if title.startswith("Faskes teratas menurut "):  # a technique's top facilities: the ML consensus reads them
                    self.ml_top[title[len("Faskes teratas menurut "):].split(" (")[0]] = r.get("rows") or []
            elif t == "instances":
                for a in e.get("agents") or []:
                    self.team[a["key"]] = dict(a)
                    self.prior_instances.setdefault(e.get("role") or "", []).append(a["key"])
            elif t == "assign" and e.get("agent") in self.team:
                self.team[e["agent"]]["target"] = e.get("target")
            elif t == "tool" and e.get("agent"):
                self.box.receipts.setdefault(e["agent"], []).append(e)
                self.box.seen.setdefault(e["agent"], []).append({"tool": e.get("tool"), "args": e.get("args"), "result": e.get("summary")})
                steps.setdefault(e["agent"], []).append((phase, e))
            elif t == "handoff":
                self.handoffs[e["agent"]] = e["handoff"]
                if (e["handoff"] or {}).get("skill"):
                    self.used.add(e["handoff"]["skill"])
            elif t == "tag" and e.get("agent"):
                self.tags[e["agent"]] = self.tags.get(e["agent"], 0) + int(e.get("jumlah") or 1)
                self.tag_log.setdefault(e["agent"], []).append({"judul": (f"{e.get('jumlah')} objek dari " if e.get("bulk") else "") + str(e.get("judul") or "")[:90],
                                                              "tag": e.get("tag"), "kekuatan": e.get("kekuatan") or e.get("kekuatan_agen"), "rid": e.get("rid"), "sapuan": bool(e.get("bulk"))})
            elif t == "text" and e.get("agent"):
                texts[e["agent"]] = (phase, e.get("text") or "")
            elif t == "agent_status" and e.get("status") in ("selesai", "gagal"):
                self.reports[e["agent"]] = e.get("laporan") or ""
                finished[e["agent"]] = phase
            elif t == "verdict" and e.get("validator") == "scrutiny":
                scr.append({"milestone": e.get("milestone"), "checks": e.get("checks") or []})
            elif t == "verdict" and e.get("lini"):
                self.prior_verdicts[e["lini"]] = e.get("checks") or []
            elif t == "red_team":
                self.prior_red.append({k: e.get(k) for k in ("indikasi_id", "judul", "tag", "hasil", "kekuatan")} | {"agen": e.get("agent")})
            elif t == "engagement_plan":
                plan = e.get("plan") or {}
            elif t == "kontrak":
                self.contract = e.get("kontrak") or self.contract
            elif t == "machine" and e.get("key") == "karantina" and e.get("status") == "selesai":
                box = e.get("hasil") or {}
            elif t == "machine" and e.get("key") == "telaah_klinis" and e.get("status") == "selesai":
                review = e.get("hasil") or {}
        self.scrutinies = [s for s in scr if s["milestone"] in done]
        cut = next((pid for pid, _ in self.phases if pid not in done), None)
        if cut in ("penugasan", "lapangan", "investigasi", "sintesis", "qa"):  # the report phases run whole again
            for k, ph in finished.items():
                if ph == cut:
                    ph_t, txt = texts.get(k, ("", ""))
                    self.done[k] = O.handoff(k, txt, [])[0] if txt and ph_t == cut else self.reports.get(k, "")
            for k, rs in steps.items():
                mine = [e for ph, e in rs if ph == cut]
                if k not in self.done and mine:
                    self.prior[k] = mine
        leads = {a["key"] for a in self.team.values() if a["jenjang"] == "manajer" and a["key"] not in NOT_DOMAIN}
        return {"done_phases": done, "cut": cut, "plan": plan, "box": box, "review": review,
                "syntheses": {k: O.handoff(k, txt, [])[0] for k, (ph, txt) in texts.items() if ph == "sintesis" and k in leads},
                "qa": {"verdicts": dict(self.prior_verdicts), "red": list(self.prior_red),
                       "ringkasan": _qa_summary(self.team, self.prior_verdicts, self.prior_red)}}

    def restore(self, src: str) -> tuple[str, dict, dict[str, str], dict, dict]:
        """A rewrite of an engagement's report (POST /api/aip/konsultan/{id}/laporan). Phases 0–5 are copied, not run
        again: the source's trail up to its report — every event, and every result under the same hasil_id, so the
        syntheses' [rN] still point at what was read — and the firm's state rebuilt from that trail. phase_6 then runs anew."""
        events = self.p.get(f"/api/aip/runs/{src}")["events"]
        cut = next((i for i, e in enumerate(events) if e.get("type") == "phase" and e.get("phase") == "laporan" and e.get("status") == "mulai"), None)
        if cut is None:
            raise RuntimeError(f"{src} has no report phase to rewrite")
        firm = next(e for e in events if e.get("type") == "firm")
        self.team = {a["key"]: dict(a) for a in firm["tim"]}
        if "validator" in self.team:
            self.team["validator"]["model"] = self.inp.get("validator_model") or self.cat["roles"]["validator"]
        # the copied trail keeps its own pace but is moved in time to end as this rewrite starts: replayed (the animation's
        # timeline is the events' times), the copy then flows into the new report phase; each event keeps its time as t_asli
        stamps = [_when(e.get("t")) for e in events[:cut]]
        known = [s for s in stamps if s]
        shift = (datetime.now(timezone.utc).replace(tzinfo=None) - max(known)) if known else timedelta(0)
        moved = lambda s: (s + shift).isoformat(timespec="seconds") if s else None  # noqa: E731
        emit({"type": "salinan", "sumber": src, "fase": [p for p, _ in PHASES if p not in ("laporan", "redaksi")], "peristiwa": cut, **({"t": moved(min(known))} if known else {})})
        plan: dict = {}
        box: dict = {}
        texts: dict[str, str] = {}
        verdicts: dict[str, list] = {}
        red: list[dict] = []
        phase = ""
        for e, when in zip(events[:cut], stamps):
            t = e.get("type")
            at = {"t": moved(when), "t_asli": e.get("t")} if when else {}
            if t == "result":  # its rows from the source, under the same id
                r = self.p.get(f"/api/aip/runs/{src}/results/{e['rid']}")
                emit({"type": "result", "rid": e["rid"], "title": r.get("title") or e.get("title"), "columns": r.get("columns") or [], "rows": r.get("rows") or [],
                      "total": r.get("total"), "types": r.get("types") or {}, "object_type": r.get("object_type"), **at})
                self.box.index.append({"rid": e["rid"], "title": r.get("title") or "", "columns": r.get("columns") or [], "total": r.get("total"),
                                       "sample": (r.get("rows") or [])[:3], "meta": {"kind": "salinan"}, "types": r.get("types") or {},
                                       "object_type": (r.get("object_type") or {}).get("name")})
                self.box.rows[e["rid"]] = r.get("rows") or []
                self.box.n_results = max(self.box.n_results, int(e["rid"][1:]))
                continue
            if t in ("done", "answer"):
                continue
            emit({**{k: v for k, v in e.items() if k != "seq"}, **at})
            if t == "phase":
                phase = e["phase"]
            elif t == "instances":
                for a in e.get("agents") or []:
                    self.team[a["key"]] = dict(a)
            elif t == "assign" and e.get("agent") in self.team:
                self.team[e["agent"]]["target"] = e.get("target")
            elif t == "tool":
                self.box.receipts.setdefault(e["agent"], []).append(e)
            elif t == "handoff":
                self.handoffs[e["agent"]] = e["handoff"]
                if (e["handoff"] or {}).get("skill"):
                    self.used.add(e["handoff"]["skill"])
            elif t == "tag":
                self.tags[e["agent"]] = self.tags.get(e["agent"], 0) + int(e.get("jumlah") or 1)
                self.tag_log.setdefault(e["agent"], []).append({"judul": (f"{e.get('jumlah')} objek dari " if e.get("bulk") else "") + str(e.get("judul") or "")[:90],
                                                              "tag": e.get("tag"), "kekuatan": e.get("kekuatan") or e.get("kekuatan_agen"), "rid": e.get("rid"), "sapuan": bool(e.get("bulk"))})
            elif t == "agent_status" and e.get("status") in ("selesai", "gagal"):
                self.reports[e["agent"]] = e.get("laporan") or ""
            elif t == "text" and phase == "sintesis":
                texts[e["agent"]] = e["text"]
            elif t == "verdict" and e.get("validator") == "scrutiny":
                self.scrutinies.append({"milestone": e.get("milestone"), "checks": e.get("checks") or []})
            elif t == "verdict" and e.get("lini"):
                verdicts[e["lini"]] = e.get("checks") or []
            elif t == "red_team":
                red.append({k: e.get(k) for k in ("indikasi_id", "judul", "tag", "hasil", "kekuatan")} | {"agen": e.get("agent")})
            elif t == "engagement_plan":
                plan = e.get("plan") or {}
            elif t == "kontrak":
                self.contract = e.get("kontrak") or self.contract
            elif t == "machine" and e.get("key") == "karantina" and e.get("status") == "selesai":
                box = e.get("hasil") or {}
            elif t == "machine" and e.get("key") == "telaah_klinis" and e.get("status") == "selesai":
                self.telaah = e.get("hasil") or {}  # a Blu 1.1 engagement's review: its report rewritten says it too
        leads = {a["key"] for a in self.team.values() if a["jenjang"] == "manajer" and a["key"] not in NOT_DOMAIN}
        syntheses = {k: O.handoff(k, v, [])[0] for k, v in texts.items() if k in leads}
        return self.inp["q"], plan, syntheses, {"verdicts": verdicts, "red": red, "ringkasan": _qa_summary(self.team, verdicts, red)}, box

    def scrutinize(self, milestone: str, box: dict | None = None, syntheses: dict | None = None, report: str = "") -> list[dict]:
        """The scrutiny validator at the end of a milestone: plain code over what the phase left in the shared state."""
        members = [a for a in self.team.values() if a["jenjang"] == "analis"]
        checks: list[dict] = []
        if milestone == "lapangan":
            field = [a for a in members if a["lini"] in ("wilayah", "modus", "peer", "ml")]
            hs = [self.handoffs[a["key"]] for a in field if a["key"] in self.handoffs]
            checks.append({"klaim": "setiap agen lapangan menyerahkan serah-terima", "ok": len(hs) == len(field), "blok": False,
                           "bukti": f"{len(hs)}/{len(field)} serah-terima; {sum(h['dinyatakan_agen'] for h in hs)} dengan isian agen"})
            checks.append({"klaim": "prosedur skill diikuti (tool wajib dipakai)", "ok": sum(h["procedures_followed"]["ok"] for h in hs) * 10 >= 8 * max(1, len(hs)),
                           "blok": False, "bukti": f"{sum(h['procedures_followed']['ok'] for h in hs)}/{len(hs)} agen"})
            refused = [r for a in field for r in self.box.receipts.get(a["key"], []) if r["tool"].startswith("tandai") and not r["ok"]]
            checks.append({"klaim": "setiap tag berbukti hasil yang dibaca agen itu sendiri (gerbang bukti)", "ok": True, "blok": False,
                           "bukti": f"{sum(self.tags.values())} tag tersimpan; {len(refused)} ditolak gerbang bukti"})
            unread = [a["name"] for a in field if a["key"] in self.handoffs and not self.read(a["key"])]
            checks.append({"klaim": "setiap laporan agen berbukti panggilan tool (laporan tanpa bacaan ditolak, tidak dipakai)", "ok": not unread, "blok": False,
                           "bukti": "semua agen membaca data" if not unread else f"ditolak: {', '.join(unread)}"})
            checks.append({"klaim": "konsensus ML dihitung dari >= 3 teknik", "ok": len(self.ml_top) >= 3, "blok": False, "bukti": f"{len(self.ml_top)} teknik"})
        elif milestone == "karantina":
            groups = (box or {}).get("kelompok") or {}
            checks.append({"klaim": "box karantina terhitung dan kelompoknya menjumlah ke total", "ok": bool(box) and sum(v["faskes"] for v in groups.values()) == box.get("faskes"),
                           "blok": False, "bukti": f"{(box or {}).get('faskes')} faskes; " + ", ".join(f"{g} {v['faskes']}" for g, v in groups.items())})
        elif milestone == "investigasi":
            cases = [a for a in members if a["lini"] == "kasus" and (a.get("target") or {}).get("faskes_profil_id")]
            recs, wrong = 0, []
            for a in cases:
                fid = a["target"]["faskes_profil_id"]
                mine = [r for r in (self.p.get(f"/api/aip/karantina/{fid}").get("rekomendasi") or []) if r.get("run_id") == self.run_id]
                recs += bool(mine)
                wrong += [a["target"]["nama"] for r in mine if r.get("jalur") == "ditindak" and not all((r.get("tsm") or {}).get(d) == "terpenuhi"
                                                                                                     for d in ("terstruktur", "sistematis", "masif"))]
            checks.append({"klaim": "setiap faskes yang diaudit punya rekomendasi penyidik", "ok": recs == len(cases), "blok": False, "bukti": f"{recs}/{len(cases)}"})
            checks.append({"klaim": "'ditindak' hanya bila T, S dan M terpenuhi", "ok": not wrong, "blok": False,
                           "bukti": "tidak ada pelanggaran" if not wrong else "melanggar: " + "; ".join(wrong[:5])})
        elif milestone == "sintesis":
            syn = syntheses or {}
            leads = [a for a in self.team.values() if a["jenjang"] == "manajer" and a["key"] not in NOT_DOMAIN and any(x.get("induk") == a["key"] for x in members)]
            cited = [k for k, v in syn.items() if re.search(r"\br\d+\b", v or "")]
            checks.append({"klaim": "setiap agen domain yang memimpin menyerahkan sintesis", "ok": all(a["key"] in syn for a in leads), "blok": False,
                           "bukti": f"{len(syn)}/{len(leads)}"})
            checks.append({"klaim": "setiap sintesis mengutip hasil_id", "ok": len(cited) == len(syn), "blok": False, "bukti": f"{len(cited)}/{len(syn)}"})
            known = {r["rid"] for r in self.box.index}
            ghost = sorted({x for v in syn.values() for x in re.findall(r"\br\d+\b", v or "")} - known, key=lambda x: int(x[1:]))
            checks.append({"klaim": "setiap rujukan [rN] di sintesis adalah hasil penugasan ini", "ok": not ghost, "blok": False,
                           "bukti": "semua rujukan ada" if not ghost else f"tidak ada: {', '.join(ghost[:12])}"})
        elif milestone == "laporan":
            known = {r["rid"] for r in self.box.index}
            cited = set(re.findall(r"\br\d+\b", report))
            missing = sorted(cited - known, key=lambda x: int(x[1:]))
            checks.append({"klaim": "setiap rujukan [rN] di laporan adalah hasil penugasan ini", "ok": not missing, "blok": True,
                           "bukti": f"{len(cited)} rujukan" + (f"; tidak ada: {', '.join(missing)}" if missing else "")})
            said = [int(n) for n in re.findall(r"(\d+)\s+agen\b", report)]
            fixed = sum(1 for a in self.team.values() if not a.get("instans_dari"))
            checks.append({"klaim": "jumlah agen yang disebut sama dengan tim (agen tetap, tanpa instans)", "ok": not said or fixed in said, "blok": True,
                           "bukti": f"{self.counts()}; disebut: {', '.join(map(str, said)) or '-'}"})
            checks.append({"klaim": "laporan memakai kata indikasi, bukan fraud terbukti", "ok": "indikasi" in report.lower(), "blok": True, "bukti": ""})
            thinking = [m.group(0).strip()[:60] for m in NARRATION.finditer(report)]
            checks.append({"klaim": "laporan tanpa penalaran model (\"Let me…\", \"Wait…\", bahasa Inggris)", "ok": not thinking, "blok": False,
                           "bukti": "bersih" if not thinking else f"{len(thinking)} baris: " + "; ".join(thinking[:3])})
        self.scrutinies.append({"milestone": milestone, "checks": checks})
        O.emit_scrutiny(checks, milestone)
        return checks

    def phase(self, pid: str, status: str, **extra: Any) -> None:
        emit({"type": "phase", "phase": pid, "label": LABELS[pid], "status": status, **extra})

    def machine(self, key: str, status: str, **extra: Any) -> None:
        emit({"type": "machine", "key": key, "status": status, **extra})

    async def phase_telaah(self) -> dict:
        """Blu 1.1 / 1.3: the clinical review of every screened claim (adk_runtime/telaah.py), before the plan. Whatever stops
        it (its calibration, its ceiling, failing models), the engagement goes on as Blu 1.0 with what was reviewed."""
        self.phase("telaah", "mulai")
        self.machine("telaah_klinis", "bekerja")

        def result(title: str, rows: list[dict], meta: dict) -> str:
            token = T._CURRENT.set("telaah_klinis")
            try:
                return self.box.result(title, rows, meta=meta)
            finally:
                T._CURRENT.reset(token)

        try:
            out = await TR.Review(self.inp, self.p, result).run("penuh")
        except Exception as e:  # noqa: BLE001 - the review is a head start, not a condition of the engagement
            out = {"status": "gagal", "alasan": [f"{type(e).__name__}: {str(e)[:300]}"]}
            emit({"type": "error", "agent": "telaah_klinis", "message": f"telaah klinis gagal: {out['alasan'][0]}; penugasan berlanjut sebagai Blu 1.0"})
        self.machine("telaah_klinis", "selesai", hasil=out)
        self.phase("telaah", "selesai", status_telaah=out.get("status"), ditelaah=out.get("ditelaah"), tag=out.get("tag"))
        return out

    async def phase_skoring_v3(self, rerun: bool = False) -> dict:
        """Blu 3.0: the v3 scoring machine. Every claim was scored by architecture v3 (testing/blu3_data.py) and the Nexus
        types hold it (testing/blu3_profil.py); here its summary becomes results the plan and every agent cite: the claims per
        Permenkes family, the facilities and provinces with the largest expected fraud, and each family's work list."""
        if not rerun:
            self.phase("skoring_v3", "mulai")
        self.machine("skoring_v3", "bekerja")
        st = await asyncio.to_thread(self.p.get, "/api/aip/konsultan/v3")
        rk = st.get("ringkasan") or {}
        token = T._CURRENT.set("skoring_v3")
        rid: dict[str, str] = {}
        try:
            fam = [{**{k: v for k, v in x.items() if k != "modus"}, "modus": ", ".join(x.get("modus") or [])} for x in rk.get("famili") or []]
            rid["famili"] = self.box.result("Scoring ML v3: klaim per kelompok modus Permenkes (spesialis v3 >= 50%)", fam,
                                            types={"famili": "string", "nama": "string", "modus": "string"}, meta={"kind": "v3_famili", "metric": "klaim", "label": "nama"})
            rid["faskes"] = self.box.result("Scoring ML v3: 25 faskes dengan ekspektasi klaim fraud terbesar", rk.get("faskes_teratas") or [],
                                            types={"faskes_profil_id": "string", "nama": "string", "provinsi": "string"},
                                            meta={"kind": "v3_faskes", "metric": "ekspektasi", "label": "nama"})
            # every province (one regional analyst each; the user, 2026-11-12), the older package's top 10 otherwise
            rid["provinsi"] = self.box.result("Scoring ML v3: provinsi menurut ekspektasi klaim fraud", rk.get("provinsi_semua") or rk.get("provinsi_teratas") or [],
                                              types={"provinsi": "string"}, meta={"kind": "v3_provinsi", "metric": "ekspektasi", "label": "provinsi"})
            for f, rows in (rk.get("famili_teratas") or {}).items():
                if rows:
                    rid[f"famili_{f}"] = self.box.result(f"Scoring ML v3: klaim teratas keluarga {f} (work list, belum bukti)", rows,
                                                         types={"klaim_id": "string", "faskes_profil_id": "string", "faskes": "string", "provinsi": "string",
                                                                "inacbg_kode": "string", "sinyal_rule": "string"},
                                                         meta={"kind": "v3_daftar_kerja", "metric": "risiko_v3", "label": "klaim_id"})
            kontrol: dict = {}
            if self.lingkup_v3:
                # the reading scope: Klaim Berisiko and a control sample of the rest (aip/blu3.py lingkup, computed by the API)
                lk = await asyncio.to_thread(self.p.get, "/api/aip/konsultan/v3/lingkup")
                ids = {str(x["klaim_id"]) for x in lk.get("kontrol") or []}
                self.box.lingkup = {"tipe": "Skor Risiko Klaim ML (BPJS)", "boleh": set(lk.get("klaim_berisiko") or []) | ids, "kontrol": ids}
                aturan = lk.get("aturan") or {}
                rid["kontrol"] = self.box.result(
                    f"Scoring ML v3: sampel kontrol — {len(ids)} klaim acak di luar Klaim Berisiko ({100 * float(aturan.get('fraksi') or 0):g}% per provinsi, "
                    f"maks {aturan.get('maks_provinsi')}), untuk mengukur yang terlewat ML", lk.get("kontrol") or [],
                    types={"klaim_id": "string", "faskes_profil_id": "string", "faskes": "string", "provinsi": "string", "inacbg_kode": "string",
                           "tingkat_pelayanan": "string", "alasan_utama": "string"},
                    meta={"kind": "v3_kontrol", "metric": "risiko_v3", "label": "klaim_id"})
                kontrol = {"klaim": len(ids), "di_luar": lk.get("di_luar"), "klaim_berisiko": len(lk.get("klaim_berisiko") or []), "aturan": aturan}
        finally:
            T._CURRENT.reset(token)
        out = {"status": "selesai" if rk else "tanpa_paket", "klaim": rk.get("klaim"), "ditandai": rk.get("ditandai"), "berisiko": rk.get("berisiko"),
               "kontrol": kontrol,
               "faskes": rk.get("faskes"), "rute_rule": rk.get("rute_rule"), "rule_jaringan": rk.get("rule_jaringan"), "famili": rk.get("famili") or [],
               "profil": (st.get("profil") or {}).get("aktif"), "rid": rid}
        self.machine("skoring_v3", "selesai", hasil={**{k: out[k] for k in ("klaim", "ditandai", "berisiko", "faskes", "profil")},
                                                     **({"kontrol": kontrol["klaim"], "di_luar": kontrol["di_luar"]} if kontrol else {}),
                                                     "famili": [{"famili": x.get("famili"), "nama": x.get("nama"), "klaim": x.get("klaim")} for x in out["famili"]]},
                     rid=rid.get("famili"))
        if not rerun:
            self.phase("skoring_v3", "selesai", ditandai=out["ditandai"], klaim=out["klaim"])
        return out

    def v3_line(self) -> str:
        """Blu 3.0: the v3 scoring in the words the plan and the report read (numbers and result ids from code)."""
        v = self.v3 or {}
        if not v.get("klaim"):
            return "Scoring ML v3: paket v3 tidak terbaca; agen bekerja dari tipe Nexus saja."
        fam = "; ".join(f"{x['famili']} {x['klaim']} klaim di {x['faskes']} faskes" for x in v.get("famili") or [])
        rid = v.get("rid") or {}
        return (f"Scoring ML v3 [{rid.get('famili')}]: {v['klaim']} klaim dinilai arsitektur v3 (profil data {v.get('profil')}), {v['ditandai']} ditandai, "
                f"{v['berisiko']} masuk Klaim Berisiko; per keluarga (spesialis >= 50%): {fam}. Faskes dengan ekspektasi fraud terbesar [{rid.get('faskes')}], "
                f"provinsi [{rid.get('provinsi')}]; rule route {v.get('rute_rule')} klaim, network rule {(v.get('rule_jaringan') or {}).get('klaim')} klaim. "
                "Skor v3 adalah petunjuk, bukan bukti: setiap tag tetap butuh data yang dibaca agen sendiri."
                + (f" Lingkup baca: klaim dibaca dari Klaim Berisiko ({v['berisiko']} klaim) dan sampel kontrol [{rid.get('kontrol')}] — "
                   f"{(v.get('kontrol') or {}).get('klaim')} klaim acak dari {(v.get('kontrol') or {}).get('di_luar')} klaim yang menurut v3 tidak berisiko, "
                   "diperiksa analis wilayah per provinsi untuk mengukur yang terlewat ML; laporan menyebut berapa sampel kontrol yang diperiksa dan "
                   "berapa yang ternyata berindikasi." if (v.get("kontrol") or {}).get("klaim") else ""))

    def review_line(self) -> str:
        """The review's outcome in the words the plan and the report read (numbers and result ids from code)."""
        if self.versi == "3.0":
            return self.v3_line()
        r = self.telaah
        if not r:
            return ""
        cal = r.get("kalibrasi") or {}
        if r.get("status") != "selesai":
            return (f"Telaah klinis Blu {self.versi} tidak berjalan penuh ({r.get('status')}: {'; '.join(r.get('alasan') or []) or '-'}); "
                    f"kalibrasi [{cal.get('rid') or r.get('rid') or '-'}]. Penugasan ini bekerja seperti Blu 1.0.")
        if self.versi == "1.3":  # Decisions alone: every claim not wajar for the plan, no tags of its own
            per = r.get("kesimpulan_saring") or {}

            def span(rids: list) -> str:
                return f"[{rids[0]}]" if len(rids) == 1 else f"[{rids[0]}]–[{rids[-1]}] ({len(rids)} bagian)" if rids else "-"

            prov = "; ".join(f"{x['provinsi']} {x['teratas']} ({x['mencurigakan']} mencurigakan)" for x in r.get("per_provinsi") or [] if x.get("teratas"))
            fas = "; ".join(f"{x['faskes_profil_id']} ({x['provinsi']}) {x['teratas']}" for x in r.get("faskes_teratas") or [])
            return (f"Pemeriksaan keputusan Blu 1.3 [{r.get('rid')}]: {r.get('ditelaah')} klaim berisiko dinilai OpenAI Decisions (peluang per kesimpulan, "
                    f"tanpa alasan tertulis): {per.get('wajar')} wajar, {per.get('perlu_diperiksa')} perlu diperiksa, {per.get('mencurigakan')} mencurigakan. "
                    f"Diserahkan ke agen untuk dianalisis: {r.get('diserahkan')} klaim teratas — semua {r.get('diserahkan_mencurigakan')} yang mencurigakan, lalu "
                    f"perlu diperiksa dengan skor tertinggi — {span(r.get('rid_diserahkan') or [])}. Klaim teratas per provinsi [{r.get('rid_provinsi')}]: {prov or '-'}. "
                    f"Faskes dengan klaim teratas terbanyak ({span(r.get('rid_faskes') or [])}): {fas or '-'}. Pemeriksaan ini TIDAK menandai klaim: agen "
                    f"memeriksa klaim teratas itu sendiri dan menandai dengan bukti (tool telaah_klinis_klaim, per faskes atau provinsi, hanya klaim teratas). "
                    f"Kalibrasi [{cal.get('rid')}]: kappa berbobot {(cal.get('hasil') or {}).get('kappa_berbobot')} dengan putusan DeepSeek yang tersimpan.")
        return (f"Telaah klinis Blu {self.versi} [{r.get('rid')}]: {r.get('ditelaah')} klaim berisiko ditelaah {r['model']['saring']} (saring), "
                f"{r.get('diperiksa_ulang')} diperiksa ulang {r['model']['periksa']}; {r.get('layak_tag')} klaim bermasalah menurut kedua model "
                f"(salah satunya mencurigakan), {r.get('tag')} ditandai (tag lemah, agen telaah_klinis; tanpa sumber lain tidak menambah kerugian Box). Kalibrasi "
                f"[{cal.get('rid')}]: kappa berbobot {(cal.get('hasil') or {}).get('kappa_berbobot')}. Klaim per faskes: tool telaah_klinis_klaim.")

    def review_tools(self, key: str) -> list[Callable]:
        """Blu 1.1 / 1.3: the clinical review's verdicts for an investigator or a clinical-mode specialist (a result it can tag from)."""
        if not self.reviewed or (self.telaah or {}).get("status") not in ("selesai", "berhenti"):
            return []
        box, p, models, label = self.box, self.p, (self.telaah.get("model") or {}), f"Blu {self.versi}"

        def telaah_klinis_klaim(faskes_profil_id: str, provinsi: str, kesimpulan: str, batas: int) -> dict:
            """Hasil telaah klinis (sebelum agen bekerja, dua keluarga model) atas klaim berisiko: per klaim kesimpulan model saring
            dan model periksa ulang (wajar / perlu_diperiksa / mencurigakan), tag usulan dan alasan klinisnya; bila model saring
            OpenAI Decisions, juga peluang_saring per kesimpulan dan skor_saring (0 wajar – 2 mencurigakan). faskes_profil_id dan provinsi
            (HURUF BESAR) "" bila tidak dipakai; kesimpulan "" = semua yang bukan wajar; batas 1–200. Yang mencurigakan menurut kedua model
            sudah bertag lemah (tag_kedua_model): tandai dengan hasil_id ini untuk menguatkan HANYA setelah Anda memeriksa datanya sendiri.
            Pemeriksaan OpenAI Decisions tidak menandai apa pun: tool ini memberi klaim teratasnya (mencurigakan dulu, lalu skor) untuk Anda
            analisis; tandai HANYA setelah Anda memeriksa datanya sendiri."""
            # Blu 1.3: the Decisions verdicts alone (its other seat is the calibration's reference, not a re-check)
            r = p.get("/api/aip/telaah/hasil", saring=models.get("saring"), periksa=None if self.versi == "1.3" else models.get("periksa"),
                      versi=self.versi, teratas=TL.HANDED if self.versi == "1.3" else None, faskes=faskes_profil_id or None, provinsi=provinsi or None,
                      kesimpulan=kesimpulan or None, limit=max(1, min(int(batas or 30), 200)))
            rows = r["klaim"]
            rid = box.result(f"Telaah klinis {label} · {faskes_profil_id or provinsi or 'semua'} · {kesimpulan or 'bukan wajar'}", rows,
                             types={"klaim_id": "string", "faskes_profil_id": "string"}, meta={"kind": "telaah", "label": "klaim_id"})
            told = (f"hanya {TL.HANDED} klaim teratas OpenAI Decisions, mencurigakan dulu lalu skor; belum ada yang ditandai" if self.versi == "1.3" else
                    f"{sum(x['tag_kedua_model'] for x in rows)} dari {len(rows)} yang diambil bermasalah menurut kedua model (sudah bertag lemah)")
            return ({"total": r["total"], "klaim": rows[:8], "hasil_id": rid, "ringkasan": f"{r['total']} klaim ({kesimpulan or 'bukan wajar'}) di cakupan; {told}"},
                    {"request": {"endpoint": "GET /api/aip/telaah/hasil"}, "rid": rid, "rows": len(rows)})

        return [box.wrap(key, "telaah_klinis_klaim", telaah_klinis_klaim)]

    async def phase_0(self, brief: str) -> dict:
        self.phase("penugasan", "mulai")
        self.machine("penanda_otomatis", "bekerja")
        # Blu 3.0: only the rules over its v3 data profile (claims, v3 scores, v3 facility risk, members); the baseline tables are a year
        auto = await asyncio.to_thread(self.p.post, "/api/aip/indikasi/otomatis", {"hanya": ["klaim", "ml", "ml_faskes", "peserta"]} if self.versi == "3.0" else {})
        rows = [{"aturan": k, "tag": v} for k, v in sorted(auto["aturan"].items(), key=lambda x: -x[1])]
        token = T._CURRENT.set("penanda_otomatis")
        rid = self.box.result("Penanda otomatis: tag per aturan lapisan semantik", rows, meta={"kind": "auto_tags", "metric": "tag", "label": "aturan"})
        T._CURRENT.reset(token)
        self.machine("penanda_otomatis", "selesai", hasil=auto, rid=rid)
        key = "partner"
        a = self.team[key]
        text = f"""{self._head(a)}
Penugasan dari klien: {brief}

{RULES}

{self.brief}

Penanda otomatis sudah menandai {auto['tag_tersentuh']} indikasi dari aturan lapisan semantik ({auto['total_tag']} tag di buku besar).
{self.review_line()}
TAHAP PENUGASAN. Lini dan jumlah agennya: {self.sizes()}.
{self.skill("rencana_penugasan")}
Kontrak dasar yang selalu berlaku (jangan diulang, tambahkan yang khas penugasan ini):
{self.contract_text()}
Pisahkan dua hal: "hipotesis" = hipotesis GLOBAL, konteks investigasi nasional yang boleh dipertimbangkan lini mana pun, bukan
kesimpulan untuk wilayah tertentu; "penemuan_regional" = pertanyaan yang dijawab SETIAP analis wilayah secara mandiri dari data
provinsinya sendiri — pertanyaan, bukan jawaban: jangan sebut provinsi, faskes atau modus tertentu sebagai jawabannya.
Jawab HANYA JSON:
{{"ringkasan": "<rencana satu kalimat>", "hipotesis": [{{"id": "H1", "teks": "<hipotesis global>", "ukuran": ["<nama ukuran>"], "tag": ["<kode tag>"]}}],
"penemuan_regional": ["<pertanyaan yang dijawab tiap analis wilayah dari data provinsinya>"],
"fokus": {{"wilayah": "<instruksi>", "modus": "<instruksi>", "peer": "<instruksi>", "ml": "<instruksi>", "kasus": "<instruksi>"}},
"kontrak": ["<pernyataan yang harus benar tentang hasil penugasan>"]}}"""
        tools = self.semantic_tools(key) + [t for t in self.tag_tools(key) if t.__name__ == "lihat_indikasi"]
        raw = await self.work(key, text, tools, "partner", "Susun rencana kerja firma dan kontrak validasinya.", 3500, think="deep", skill="rencana_penugasan")
        try:
            plan = A.parse_json(raw)
        except ValueError:
            plan = {}
        plan.setdefault("ringkasan", "Telusuri setiap indikasi per wilayah, modus, kelas faskes dan teknik ML; karantina dan audit faskes prioritas.")
        plan.setdefault("hipotesis", [])
        if not isinstance(plan.get("penemuan_regional"), list) or not plan["penemuan_regional"]:
            plan["penemuan_regional"] = REGIONAL
        plan.setdefault("fokus", {})
        # the validation contract, written before any worker starts: the floor plus the orchestrator's own statements. It
        # tends to copy the floor, numbered on ("d1: …", seen 2026-10-23): a copy is dropped, a number prefix stripped
        base = {O._fold(c["teks"]) for c in self.contract}
        own = [re.sub(r"^\s*[dk]\d+\s*[:.)-]\s*", "", str(x.get("teks") or x.get("text") or "") if isinstance(x, dict) else str(x))
               for x in plan.get("kontrak") or []]
        self.contract += O.contract_of([t for t in own if t.strip() and O._fold(t) not in base], "k", 8)
        plan["kontrak"] = self.contract
        emit({"type": "engagement_plan", "plan": plan})
        emit({"type": "kontrak", "kontrak": self.contract})
        self.phase("penugasan", "selesai")
        return plan

    async def phase_1(self, plan: dict) -> None:
        self.phase("lapangan", "mulai")
        focus = plan.get("fokus") or {}
        hyp = "\n".join(f"- {h.get('id')}: {h.get('teks')}" if isinstance(h, dict) else f"- {h}" for h in plan.get("hipotesis") or [])
        regional = "\n".join(f"- {q.get('teks') if isinstance(q, dict) else q}" for q in plan.get("penemuan_regional") or REGIONAL)
        jobs = []
        for a in self.team.values():
            if a["lini"] in ("wilayah", "modus", "peer") and a["jenjang"] == "analis":
                jobs.append(self.analyst(a, focus.get(a["lini"], ""), hyp, regional))
            elif a["lini"] == "ml" and a["jenjang"] == "analis":
                jobs.append(self.technique(a, focus.get("ml", "")))
        await self.all(jobs, "lapangan")
        if self.versi != "3.0":  # Blu 3.0 has no technique line: the v3 scoring took the consensus's place
            self.consensus()
        self.scrutinize("lapangan")
        self.phase("lapangan", "selesai", tag=sum(self.tags.values()))

    async def analyst(self, a: dict, focus: str, hyp: str, regional: str = "") -> None:
        key, target = a["key"], a.get("target") or {}
        # the orchestrator's hypotheses, as the line reads them: a province analyst gets them as national context only and
        # discovers its own province's patterns first (the user, 2026-10-30: a national hypothesis is never a province's
        # starting conclusion — Sumatera Barat's analyst had taken the national ones as its findings)
        hypotheses = f"Hipotesis orkestrator:\n{hyp or '-'}"
        report = ""
        if a["lini"] == "wilayah":
            provs = target["provinsi"] if isinstance(target["provinsi"], list) else [target["provinsi"]]
            flt = json.dumps([{"dimensi": "provinsi", "op": "in" if len(provs) > 1 else "eq", "nilai": provs if len(provs) > 1 else provs[0]}], ensure_ascii=False)
            lens = f" LENSA Anda: {target['fokus_lensa']} — analis lain memegang lensa yang lain di provinsi ini." if target.get("lensa") else ""
            scope = (f"Cakupan Anda: {'provinsi ' + provs[0] if len(provs) == 1 else str(len(provs)) + ' provinsi kecil ' + target.get('wilayah', '') + ': ' + ', '.join(provs)} "
                     f"({target.get('porsi_klaim', 0):.1%} klaim).{lens} Filter `ukur`: {flt}; risiko_faskes_ml / skor_risiko_klaim_ml / lihat_indikasi "
                     "dipanggil per provinsi (nama HURUF BESAR).")
            # Blu 1.3: the claims OpenAI Decisions handed the swarm in this analyst's provinces (the user, 2026-10-30: "openai
            # decision decide from 40000->5000 then ai agent orchestra analyze top 5000")
            mine = [x for x in (self.telaah or {}).get("per_provinsi") or [] if x["provinsi"] in provs and x.get("teratas")] if self.versi == "1.3" else []
            if mine:
                scope += (f"\nPemeriksaan keputusan Blu 1.3 menyerahkan {sum(x['teratas'] for x in mine)} klaim teratas di cakupan Anda (OpenAI Decisions, "
                          f"{sum(x['mencurigakan'] for x in mine)} mencurigakan): analisis klaim itu dengan telaah_klinis_klaim (provinsi HURUF BESAR, "
                          "kesimpulan \"\"), periksa datanya sendiri, dan tandai HANYA yang terbukti, dengan buktinya.")
            kontrol = (self.v3.get("rid") or {}).get("kontrol") if self.lingkup_v3 else None
            n_kontrol = sum(1 for r in self.box.rows.get(kontrol) or [] if str(r.get("provinsi") or "").upper() == str(provs[0]).upper()) if kontrol else 0
            if n_kontrol:
                scope += (f"\nSAMPEL KONTROL provinsi Anda (Blu 3.0): {n_kontrol} klaim — baca_hasil(hasil_id \"{kontrol}\", cari \"{provs[0]}\", batas 40): klaim acak yang "
                          "menurut ML v3 TIDAK berisiko. Periksa setiap klaim itu (detail_objek di Skor Risiko Klaim ML (BPJS): biaya vs tarif, LOS, kode, "
                          "skor lapisan v3; bandingkan dengan peer kodenya lewat ukur). Tandai HANYA yang terbukti berindikasi, dengan buktinya. Di "
                          "serah-terima tulis: sampel kontrol diperiksa N klaim, berindikasi M klaim (M boleh 0 — itu hasil yang sah).")
            skill = "analis_wilayah"
            hypotheses = f"""Hipotesis GLOBAL orkestrator — konteks investigasi nasional, BUKAN kesimpulan awal untuk provinsi Anda:
{hyp or '-'}
PENEMUAN REGIONAL — tugas utama Anda, ditemukan secara mandiri dari data provinsi Anda sendiri:
{regional or '-'}
Urutan kerja: (1) ukur provinsi Anda dulu — modus, faskes dan kode yang menyimpang dibanding peer — tanpa berangkat dari hipotesis
global; (2) baru uji hipotesis global di data provinsi Anda. Hipotesis global hanya boleh Anda nyatakan berlaku di provinsi Anda bila
angka provinsi Anda sendiri (dengan hasil_id, dibanding peer) menunjukkannya; sebut juga yang TIDAK berlaku atau tidak teruji."""
            report = (" Pisahkan di laporan: (a) penemuan regional — pola khas provinsi Anda, termasuk yang tidak ada di hipotesis global; "
                      "(b) hipotesis global: berlaku / tidak berlaku / tidak teruji di provinsi Anda, masing-masing dengan hasil_id.")
        elif a["lini"] == "modus" and target.get("famili"):  # Blu 3.0: a family of Permenkes modes, from the v3 specialists
            from aip import blu3

            fam = target["famili"]
            label = f"{blu3.FAMILI[fam]['nama']} ({', '.join(target['modus'])})"
            work = (self.v3.get("rid") or {}).get(f"famili_{fam}")
            scope = (f"Kelompok modus Anda: {label}. Tag yang Anda pakai: {', '.join(target['tag'])} — pilih yang buktinya paling kuat per objek. "
                     f"Menurut v3: {target.get('klaim_v3') or 0} klaim di {target.get('faskes_v3') or 0} faskes. "
                     + (f"Work list dari mesin scoring v3: hasil_id {work} (klaim teratas keluarga Anda; petunjuk, belum bukti) — baca dengan baca_hasil. " if work else "")
                     + f"Klaim keluarga Anda di Klaim Berisiko (BPJS): filter indikasi_utama eq \"{label}\". Skor tiap lapisan v3 ada di alasan_json "
                     "Skor Risiko Klaim ML (BPJS)" + (" (untuk jaringan: rule_jaringan, rute_rule, dan peserta yang berbagi RS)" if fam == "jaringan" else "") + ".")
            skill = "spesialis_famili_v3"
        elif a["lini"] == "modus":
            t = S.TAG[target["tag"]]
            scope = (f"Spesialisasi Anda: modus {target['tag']} — {t['label']} ({t['modus']}). Sinyal: {t['sinyal']}. Ukuran terkait: "
                     f"{', '.join(t['ukuran']) or '(pakai kamus_semantik dan cari_objek)'}. Tag modus Anda: {target['tag']}.")
            skill = "spesialis_modus"
        else:  # the peer analyst: every class with enough facilities, several measures at once
            classes = "\n".join(f"- {c['label']}: {c['faskes']} faskes; filter Risiko Faskes ML (BPJS): {json.dumps(c['filter_ml'], ensure_ascii=False)}"
                                for c in target["kelas"])
            scope = f"Kelas peer Anda ({len(target['kelas'])} kelas dengan >= 20 faskes):\n{classes}"
            skill = "analis_peer"
        text = f"""{self._head(a)}
{RULES}

{self.brief}

{hypotheses}
Fokus lini Anda dari orkestrator: {focus or '-'}

{scope}

{self.skill(skill)}
Kontrak validasi penugasan (yang akan diperiksa validator):
{self.contract_text()}

Laporan akhir (paling banyak 14 baris): temuan utama dengan angka dan hasil_id, objek kunci dengan NAMA, modus yang terlihat,
apa yang mungkin wajar (negatif sulit), dan berapa tag yang Anda buat (lemah/sedang/kuat).{report}
{O.HANDOFF_ASK}"""
        tools = self.semantic_tools(key) + self.read_tools(key) + self.tag_tools(key)
        if a["lini"] == "modus" and target.get("tag") in TL.TAGS:  # Blu 1.1 / 1.3: the clinical review's verdicts on this mode's claims
            tools += self.review_tools(key)
        elif a["lini"] == "wilayah" and self.versi == "1.3":  # Blu 1.3: the top claims of its provinces (no tags of the examination's own)
            tools += self.review_tools(key)
        if self.versi == "3.0" and a["lini"] in ("wilayah", "modus"):
            # Blu 3.0: the scoring machine's results are read with baca_hasil — a family agent's work list, a regional analyst's
            # control sample (the runs of 2026-11-12 named the tool in the instructions but never gave it: no work list was read)
            tools.append(self.result_tool(key))
        # a province with few claims gets a smaller step budget: proportional effort, one analyst per province all the same
        role = "analis_kecil" if target.get("kecil") else "analis"
        # gpt-oss at its low reasoning effort read little and swept (Audit Nasional 1.1: its 13 province analysts made 158 tool calls in all,
        # 12 each against GLM's 50, and set 694 of their 712 tags by sweeps): it reasons at medium in the field
        think = "medium" if aip_models.family(self.team[key]["model"]) == "openai" else ""
        first = await self.work(key, text, tools, role, "Kerjakan cakupan Anda dan tandai setiap indikasi.", skill=skill, think=think)
        await self.more(key, text, tools, role, skill, first, target.get("tag"), think)

    async def more(self, key: str, text: str, tools: list, role: str, skill: str, report: str, tag: str | None, think: str = "") -> None:
        """A second turn for a field analyst that stopped early — under FIELD_MORE of its steps, or fewer than FIELD_MIN_TAGS
        tags — on the steps it has left: the measures of the semantic layer it has not read yet, its first report to go on
        from. Every tag still passes the evidence gate; the report it writes now replaces the first (it holds both)."""
        limit = self.box.limits.get(key) or CALLS[role][0]
        used, tagged = self.box.calls.get(key, 0), self.tags.get(key, 0)
        if key in self.done or key in self.refused or (used >= FIELD_MORE * limit and tagged >= FIELD_MIN_TAGS) or used >= limit:
            return
        read = {str((r.get("args") or {}).get("ukuran") or "") for r in self.box.receipts.get(key, []) if r.get("tool") == "ukur"}
        mine = S.TAG[tag]["ukuran"] if tag in S.TAG else []
        todo = [u for u in [*mine, *[k for k, v in S.UKURAN.items() if v["tag"] and k not in mine]] if u not in read][:10]
        emit({"type": "agent_status", "agent": key, "status": "antre", "catatan": f"kerja lanjutan: {used}/{limit} langkah, {tagged} tag"})
        prompt = (f"Anda baru memakai {used} dari {limit} langkah dan menandai {tagged} indikasi — cakupan Anda belum tuntas. Lanjutkan dengan "
                  f"{limit - used} langkah tersisa: baca ukuran yang belum Anda pakai ({', '.join(todo) or 'ukuran lain di lapisan semantik'}), bandingkan "
                  "dengan peer, dan TANDAI setiap objek yang melewati ambangnya (tandai_hasil untuk daftar yang seluruhnya memenuhi; tag yang sudah "
                  f"Anda pasang tetap tersimpan). Lalu tulis laporan akhir lengkap (temuan pertama dan yang baru).\n\nLaporan pertama Anda:\n{report[:2500]}")
        self.handoffs.pop(key, None)
        await self.work(key, text, tools, role, prompt, skill=skill, think=think)

    async def technique(self, a: dict, focus: str) -> None:
        key, tech = a["key"], a["target"]["teknik"]
        box, p = self.box, self.p

        async def jalankan_teknik(catatan: str) -> dict:
            """Jalankan validasi silang teknik Anda pada klaim RUMAH SAKIT nyata (3 lipatan dikelompokkan per faskes, label
            nyata 'dikoreksi verifikator'), lalu kembalikan metriknya, rujukan risetnya, dan 25 faskes yang paling sering
            ditandai teknik ini di skor out-of-fold (hasil_id untuk tandai_hasil). catatan: boleh kosong."""
            c = self.conf(key)
            body = {"tugas": "rumah_sakit", "model": [tech], "lipatan": int(c.get("lipatan") or 3), "ulangan": 1, "pembanding": False,
                    "faskes_teratas": int(c.get("faskes_teratas") or 25)}
            async with self.ml_sem:
                job = await asyncio.to_thread(p.post, "/api/aip/ml/benchmark", body)
                t0, last = time.time(), ""
                while job["status"] == "running" and time.time() - t0 < T.BENCH_WAIT:
                    await asyncio.sleep(5)
                    job = await asyncio.to_thread(p.get, f"/api/aip/ml/jobs/{job['id']}")
                    line = (job.get("log") or [""])[-1]
                    if line and line != last:
                        emit({"type": "progress", "agent": key, "tool": "jalankan_teknik", "text": line[:200]})
                        last = line
            if job["status"] != "succeeded":
                raise RuntimeError(job.get("error") or f"job {job['id']} belum selesai")
            res = job["result"]
            r = res["papan"][0]
            m = r["rata"]
            top = (res.get("faskes_teratas") or {}).get(tech) or []
            names = box.labels("faskes_profil_id", [x["faskes_profil_id"] for x in top])
            rows = [{"faskes_profil_id": x["faskes_profil_id"], "nama": names.get(x["faskes_profil_id"], ""), **{k: v for k, v in x.items() if k != "faskes_profil_id"}}
                    for x in top]
            self.ml_top[tech] = rows
            rid = box.result(f"Faskes teratas menurut {tech} (skor out-of-fold, klaim rumah sakit)", rows, types={"faskes_profil_id": "string", "nama": "string"},
                             meta={"kind": "ml_top_faskes", "technique": tech, "metric": "ditandai", "label": "nama"})
            out = {"teknik": tech, "job": job["id"], "evaluasi": res.get("evaluasi"),
                   **{k: {"rata": round(m[k]["mean"], 4), "sd": round(m[k]["sd"], 4)} for k in ("auprc", "auroc", "f1", "presisi", "recall") if k in m},
                   # calibration out of fold (ml_klaim.calibration): actual / expected corrections, Brier, ECE
                   **({"kalibrasi": {k: round(m[k]["mean"], 4) for k in ("kalibrasi_ae", "brier", "ece") if k in m},
                       "cara_baca_kalibrasi": "kalibrasi_ae = koreksi aktual / ekspektasi skor (1 = terkalibrasi; < 1 skor terlalu tinggi, > 1 terlalu "
                                              "rendah); brier dan ece makin kecil makin baik"} if "kalibrasi_ae" in m else {}),
                   "lift_top_0_1pct": round(m.get("lift_top_0_1pct", {}).get("mean", 0), 1),
                   "riset": [f"{x['penulis']} ({x['tahun']}): {x['judul']}" for x in r.get("riset") or []][:3],
                   "faskes_teratas": rows[:8], "hasil_id_faskes": rid}
            return ({**out, "ringkasan": f"{tech}: AUPRC {out.get('auprc', {}).get('rata')}, {len(rows)} faskes teratas"},
                    {"request": {"endpoint": "POST /api/aip/ml/benchmark", "body": body}, "rid": rid, "rows": len(rows)})

        text = f"""{self._head(self.team[key])}
{RULES}

Teknik Anda: {tech} ({a['target']['keluarga']}). Fokus lini ML dari orkestrator: {focus or '-'}
{self.skill("sub_agen_teknik")}
(Daftar teratas satu teknik tumpang tindih 80–90% dengan teknik sekeluarganya, jadi tag per teknik hanya mengulang: konsensus
yang menandai.)
Laporan Anda: metrik (AUPRC, AUROC, F1) dan kalibrasinya bila ada, lalu faskes teratas dengan NAMA persis dan angkanya (ditandai,
klaim, koreksi), setiap angka faskes dikutip dengan hasil_id_faskes Anda [rN] — QA memeriksa angka itu di tabel tersebut.
{O.HANDOFF_ASK}"""
        tools = [box.wrap_async(key, "jalankan_teknik", jalankan_teknik)]
        await self.work(key, text, tools, "ml", "Jalankan teknik Anda dan laporkan.", 2000, skill="sub_agen_teknik")

    def consensus(self) -> None:
        """The ML consensus (deterministic): facilities that many techniques rank among their top 25."""
        if len(self.ml_top) < 3:
            self.machine("konsensus_ml", "dilewati", alasan=f"hanya {len(self.ml_top)} teknik selesai")
            return
        n = len(self.ml_top)
        per: dict[str, dict] = {}
        for tech, rows in self.ml_top.items():
            for x in rows:
                f = per.setdefault(x["faskes_profil_id"], {"faskes_profil_id": x["faskes_profil_id"], "nama": x.get("nama", ""), "teknik": 0, "daftar": []})
                f["teknik"] += 1
                f["daftar"].append(tech)
        table = sorted(per.values(), key=lambda f: -f["teknik"])
        for f in table:
            f["daftar"] = ", ".join(f["daftar"])
        token = T._CURRENT.set("konsensus_ml")
        made = {}
        try:
            all_rid = self.box.result(f"Konsensus {n} teknik ML: berapa teknik menaruh tiap faskes di 25 teratasnya", table,
                                      types={"faskes_profil_id": "string", "nama": "string"}, meta={"kind": "ml_consensus", "metric": "teknik", "label": "nama"})
            for level, lo, hi in (("kuat", 0.75, 1.01), ("sedang", 0.5, 0.75), ("lemah", 1 / 3, 0.5)):
                rows = [f for f in table if lo <= f["teknik"] / n < hi]
                if not rows:
                    continue
                rid = self.box.result(f"Konsensus teknik ML · {level}: di daftar teratas {int(lo * n + 0.999)}+ dari {n} teknik", rows,
                                      types={"faskes_profil_id": "string", "nama": "string"}, meta={"kind": "ml_consensus", "metric": "teknik", "label": "nama"})
                r = self.p.post("/api/aip/indikasi/hasil", {"run_id": self.run_id, "agen": "konsensus_ml", "peran": "Konsensus teknik ML (deterministik)", "model": "ml",
                                                           "entitas": "faskes", "tag": "KONSENSUS_TEKNIK_ML", "kekuatan": level, "hasil_id": rid,
                                                           "bukti": f"faskes di 25 teratas >= {lo:.0%} dari {n} teknik ML (validasi silang out-of-fold per faskes, "
                                                                    "klaim rumah sakit, label nyata dikoreksi verifikator)"})
                made[level] = r["ditandai"]
                emit({"type": "tag", "agent": "konsensus_ml", "bulk": True, "tag": "KONSENSUS_TEKNIK_ML", "entitas": "faskes", "jumlah": r["ditandai"],
                      "baru": r["baru"], "kekuatan_agen": level, "judul": f"konsensus {n} teknik", "rid": rid})
        finally:
            T._CURRENT.reset(token)
        self.machine("konsensus_ml", "selesai", hasil={"teknik": n, "faskes": len(table), "tag": made}, rid=all_rid)

    def phase_2(self) -> dict:
        self.phase("karantina", "mulai")
        self.machine("karantina", "bekerja")
        box = self.p.post("/api/aip/karantina/hitung", {"run_id": self.run_id})  # kept as this engagement's box
        rows = [{"kelompok": g, "faskes": v["faskes"], "kerugian_rp": v["kerugian_rp"], "batas_bawah_rp": v["batas_bawah_rp"], "arti": v["arti"]}
                for g, v in box["kelompok"].items()]
        token = T._CURRENT.set("karantina")
        rid = self.box.result("Box karantina: faskes per kelompok kerugian", rows, meta={"kind": "karantina_groups", "metric": "kerugian_rp", "label": "kelompok"})
        T._CURRENT.reset(token)
        self.machine("karantina", "selesai", hasil=box, rid=rid)
        self.scrutinize("karantina", box=box)
        self.phase("karantina", "selesai", faskes=box["faskes"])
        return box

    async def phase_3(self, plan: dict) -> None:
        self.phase("investigasi", "mulai")
        r = self.p.get("/api/aip/karantina", limit=60)
        queue = [f for g in ("A", "B", "C", "D", "Z") for f in r["kelompok"][g]["faskes"] if f["status"] in ("karantina", "diaudit")]
        prior = [self.team[k] for k in self.prior_instances.get("penyidik_kasus", []) if (self.team.get(k) or {}).get("target")]
        if prior:  # continued after a cut: the investigators formed before it, on the same facilities (the queue moved since)
            by_id = {f["faskes_profil_id"]: f for f in queue}
            pairs = [(a, by_id.get(a["target"]["faskes_profil_id"]) or dict(a["target"])) for a in prior]
        else:
            # the investigator role: an instance per facility of the queue, up to the capacity of this engagement
            slots = self.instances("penyidik_kasus", queue, lambda n, f: {
                "key": f"penyidik_{n:02d}", "name": f"Penyidik · {_short(f)}",
                "peran": f"mengaudit {f['nama']} (kelompok {f['kelompok']} box karantina): kertas kerja audit dan rekomendasi jalur"})
            pairs = []
            for a, f in zip(slots, queue):
                a["target"] = {"faskes_profil_id": f["faskes_profil_id"], "nama": f["nama"], "kelompok": f["kelompok"]}
                emit({"type": "assign", "agent": a["key"], "target": a["target"]})
                pairs.append((a, f))
        jobs = [self.investigate(a, f, (plan.get("fokus") or {}).get("kasus", "")) for a, f in pairs]
        await self.all(jobs, "investigasi")
        self.scrutinize("investigasi")
        self.phase("investigasi", "selesai", kasus=len(jobs))

    async def investigate(self, a: dict, f: dict, focus: str) -> None:
        key, fid = a["key"], f["faskes_profil_id"]
        p = self.p
        rec = p.get(f"/api/aip/karantina/{fid}")
        tags = [f"- {v['tag']} ({v['kekuatan']}, {v['dukungan']} sumber) pada {v['entitas']} {v['judul'][:60]}: {v['bukti'][:160]}" for v in rec["indikasi"][:25]]
        tsm = "\n".join(f"- {d}: {rec['tsm'][d]['nilai']} — {rec['tsm'][d]['bukti']}" for d in ("terstruktur", "sistematis", "masif"))

        def rekomendasi_jalur(jalur: str, terstruktur: str, sistematis: str, masif: str, alasan: str) -> dict:
            """Rekomendasi jalur audit faskes yang Anda periksa (bukan keputusan: manusia yang memutuskan). jalur:
            "dibina" (kesalahan sistem / salah kelola tanpa unsur kesengajaan: diobati), "ditindak" (HANYA bila fraud
            Terstruktur, Sistematis DAN Masif — ketiganya "terpenuhi", menurut Anda DAN menurut sinyal TSM data box
            karantina; bila data box masih "sebagian", rekomendasikan "dibina" dan tulis buktinya di alasan — manusia
            dapat menaikkannya — dilanjutkan ke Tim PK-JKN dan penegak hukum),
            atau "dibebaskan" (tidak ada kelebihan bayar atau kesengajaan). terstruktur/sistematis/masif: terpenuhi,
            sebagian atau tidak — penilaian Anda dari data. alasan: bukti per dimensi TSM, dengan angka dan hasil_id."""
            body = {"run_id": self.run_id, "agen": key, "model": a["model"], "jalur": jalur, "terstruktur": terstruktur, "sistematis": sistematis,
                    "masif": masif, "alasan": alasan}
            r = p.post(f"/api/aip/karantina/{fid}/rekomendasi", body)
            emit({"type": "rekomendasi", "agent": key, "faskes": fid, "nama": f["nama"], "kelompok": f["kelompok"], "jalur": jalur,
                  "tsm": {"terstruktur": terstruktur, "sistematis": sistematis, "masif": masif}, "alasan": alasan[:800]})
            return ({**r, "ringkasan": f"rekomendasi {jalur} untuk {f['nama'][:60]}"}, {"request": {"endpoint": f"POST /api/aip/karantina/{fid}/rekomendasi"}})

        text = f"""{self._head(a)}
{RULES}

{self.brief}

Fokus lini kasus dari orkestrator: {focus or '-'}

KASUS ANDA: {rec['nama']} (faskes_profil_id {fid}) — {rec.get('tipe')}, {rec.get('kabkota')}, {rec.get('provinsi')}.
Box karantina: kelompok {rec['kelompok']} ({rec['estimasi_kerugian_rp']:,.0f} rupiah estimasi kerugian; {rec['sudah_dikoreksi_rp']:,.0f} rupiah sudah
dikoreksi verifikator), {rec['klaim_bertag']} klaim bertag dari {rec['klaim_faskes']} klaim, {rec['peserta_terdampak']} peserta, aktif {rec['bulan_aktif']} bulan.
Sinyal TSM dari data (penanda otomatis, harus Anda uji):
{tsm}
Tag yang ada (teratas):
{chr(10).join(tags) or '-'}

{self.skill("penyidik_kasus")}
{f"Telaah klinis Blu {self.versi} atas klaim faskes ini: telaah_klinis_klaim dengan faskes_profil_id {fid}." if self.reviewed and self.telaah.get("status") in ("selesai", "berhenti") else ""}
Filter faskes Anda: [{{"property": "faskes_profil_id", "op": "eq", "value": "{fid}"}}]; tipe pembanding: {rec.get('tipe')}. rekomendasi_jalur
tidak menghabiskan jatah langkah; tanpa rekomendasi kertas kerja Anda tidak lengkap.
Kontrak validasi penugasan (yang akan diperiksa validator):
{self.contract_text()}
Laporan = kertas kerja (paling banyak 18 baris): ringkasan kasus, bukti per dimensi TSM (angka + hasil_id), negatif sulit yang
mungkin menjelaskan, rekomendasi jalur dan alasannya, dan langkah audit lapangan yang disarankan (dokumen rekam medis, resume
medis, wawancara koder/verifikator, uji petik klaim).
{O.HANDOFF_ASK}"""
        rec_tool = self.box.wrap(key, "rekomendasi_jalur", rekomendasi_jalur, counted=False)
        tools = self.semantic_tools(key) + self.read_tools(key) + [t for t in self.tag_tools(key, bulk=False)] + [rec_tool] + self.review_tools(key)
        report = await self.work(key, text, tools, "penyidik", f"Audit kasus {rec['nama']}.", 3500, skill="penyidik_kasus")
        if not any(r.get("agen") == key and r.get("run_id") == self.run_id for r in (p.get(f"/api/aip/karantina/{fid}").get("rekomendasi") or [])):
            # its turn ended without the recommendation: one from what it read and wrote, nothing new
            ask = (f"Anda penyidik kasus {rec['nama']}. Sinyal TSM dari data:\n{tsm}\nBukti dari pemeriksaan Anda:\n"
                   f"{_evidence(self.box.seen.get(key) or [])[:7000]}\nKertas kerja Anda: {report[:2500]}\n"
                   "Tulis rekomendasi jalur sekarang. ditindak HANYA bila terstruktur, sistematis DAN masif ketiganya terpenuhi. Jawab HANYA JSON: "
                   '{"jalur": "dibina|ditindak|dibebaskan", "terstruktur": "terpenuhi|sebagian|tidak", "sistematis": "terpenuhi|sebagian|tidak", '
                   '"masif": "terpenuhi|sebagian|tidak", "alasan": "<bukti per dimensi dengan angka>"}')
            raw = await self.fallback(key, a["model"], lambda m_: LlmAgent(name=f"{key}_rekomendasi", model=self.m.llm(m_, key, 2500), instruction=A._const(ask),
                                                                           output_key="rekomendasi"), "rekomendasi", "Tulis rekomendasi.")
            try:
                rv = A.parse_json(raw)
                # the TSM rule, in code: the investigator's reading and the box's own reading of the data both full
                # (karantina.recommend refuses it otherwise)
                if rv.get("jalur") == "ditindak" and not (rv.get("terstruktur") == rv.get("sistematis") == rv.get("masif") == "terpenuhi"
                                                          and all(rec["tsm"][d]["nilai"] == "terpenuhi" for d in ("terstruktur", "sistematis", "masif"))):
                    rv["jalur"] = "dibina"
                rekomendasi_jalur(rv["jalur"], rv["terstruktur"], rv["sistematis"], rv["masif"], str(rv.get("alasan") or "")[:4000])
            except Exception:  # noqa: BLE001 - no recommendation: the box keeps its status, the report says so
                pass

    async def phase_4(self, plan: dict) -> dict[str, str]:
        self.phase("sintesis", "mulai")
        out: dict[str, str] = {}

        async def lead(mgr: dict) -> None:
            out[mgr["key"]] = await self.synthesize(mgr, plan)

        leads = [a for a in self.team.values() if a["jenjang"] == "manajer" and a["key"] not in NOT_DOMAIN
                 and any(x.get("induk") == a["key"] for x in self.team.values())]
        await self.all([lead(m) for m in leads], "sintesis")
        self.scrutinize("sintesis", syntheses=out)
        self.phase("sintesis", "selesai")
        return out

    async def synthesize(self, mgr: dict, plan: dict) -> str:
        """One domain agent's synthesis of its small agents' work."""
        focus = plan.get("fokus") or {}
        team = [a for a in self.team.values() if a.get("induk") == mgr["key"] and a["jenjang"] == "analis"]
        kinds = sorted({a["lini"] for a in team})
        reports = "\n\n".join(f"[{a['name']} · {self.tags.get(a['key'], 0)} tag] {self.reports.get(a['key'], '(tidak ada laporan)')[:1400]}" for a in team)
        # the ML line: the technique tables by hasil_id, so every figure it repeats cites the table it is in
        tables = self.ml_tables() if "ml" in kinds else ""
        tagged = self.team_tags(team)
        text = f"""{self._head(mgr)}
{RULES}

Hipotesis orkestrator: {json.dumps(plan.get('hipotesis') or [], ensure_ascii=False)[:2000]}
Fokus dari orkestrator: {'; '.join(f'{k}: {focus[k]}' for k in kinds if focus.get(k)) or '-'}
Laporan agen kecil Anda ({len(team)} agen, bekerja di objek Nexus Anda):
{reports}

Serah-terima agen kecil Anda yang belum selesai atau bermasalah:
{chr(10).join(f"- {a['name']}: belum {'; '.join(self.handoffs[a['key']]['left_undone']) or '-'}; masalah {'; '.join(self.handoffs[a['key']]['issues_found'][:3]) or '-'}"
          for a in team if a['key'] in self.handoffs and (self.handoffs[a['key']]['left_undone'] or self.handoffs[a['key']]['issues_found'])) or '- tidak ada'}

{self.skill("sintesis_agen_domain")}
{f'''Tabel teknik ML penugasan ini (hasil kode, per hasil_id; baca_hasil membuka seluruh barisnya):
{tables}
Setiap angka faskes yang Anda ulang dari laporan sub-agen (ditandai, klaim, per_1000, koreksi, jumlah teknik) DIKUTIP dengan
hasil_id tabel tempat angka itu berada, NAMA faskes persis seperti di tabel; angka yang tidak ada di tabel mana pun jangan ditulis.
Sebut juga keandalan teknik (AUPRC, kalibrasi bila dilaporkan) dari laporan sub-agen.
''' if tables else ''}{f'''Tag agen kecil Anda (dicatat kode; hasil_id di kurung siku, baca_hasil membuka barisnya):
{tagged}
''' if tagged else ''}Setiap faskes disebut dengan NAMA persis seperti di hasil (mis. "FKRTL · Rumah sakit · RS Kelas B · Pemerintah kab/kota · KOTA MATARAM"),
bukan singkatan: QA mencarinya dengan nama itu.
Tugas: sintesis Anda untuk orkestrator (paling banyak 20 baris): pola yang berulang di banyak laporan, temuan terkuat (angka +
hasil_id dari laporan), objek yang muncul di beberapa laporan, hipotesis yang didukung/dibantah, dan celah yang belum
diperiksa. Anda boleh memeriksa ulang paling banyak 5 angka dengan ukur/lihat_indikasi/baca_hasil{'/lihat_karantina' if 'kasus' in kinds else ''}.
{O.HANDOFF_ASK}"""
        tools = self.semantic_tools(mgr["key"]) + [t for t in self.tag_tools(mgr["key"]) if t.__name__ == "lihat_indikasi"] + [self.result_tool(mgr["key"])]
        if "kasus" in kinds:
            tools.append(self.box_tool(mgr["key"]))
        if "ml" in kinds:  # the deployed model's facility table, to re-check a facility the techniques rank
            tools += [t for t in T.ml_tools(self.box, mgr["key"], read_only=True) if t.__name__ in ("risiko_faskes_ml", "kartu_model_ml")]
        return await self.work(mgr["key"], text, tools, "manajer", "Sintesis kerja agen kecil Anda.", 3500, skill="sintesis_agen_domain")

    async def phase_5(self, syntheses: dict[str, str]) -> dict:
        self.phase("qa", "mulai")
        # continued after a cut: the verdicts and red-team calls made before it stand
        verdicts: dict[str, list] = dict(self.prior_verdicts)
        red: list[dict] = list(self.prior_red)

        async def qa(a: dict) -> None:
            lead = a["target"]["lead"]
            if a["key"] in self.done and lead in verdicts:
                return
            verdicts[lead] = await self.review(a, syntheses)

        r = self.p.get("/api/aip/indikasi", kekuatan="sedang", sumber="agen", limit=300)
        seen, picks = set(), []
        for v in sorted(r["tags"], key=lambda v: (-v["tingkat"], v["entitas"] != "faskes", -v["dukungan"])):
            ent = (v["entitas"], v["kunci"])
            if ent in seen:
                continue
            seen.add(ent)
            picks.append(v)
        prior = [self.team[k] for k in self.prior_instances.get("red_team", []) if (self.team.get(k) or {}).get("target")]
        if prior:  # continued after a cut: the red team formed before it, on the same indications (their strengths moved since)
            by_id = {v["id"]: v for v in picks}
            pairs = []
            for a in prior:
                iid = a["target"]["indikasi_id"]
                v = by_id.get(iid)
                if v is None:
                    try:
                        v = {**self.p.get(f"/api/aip/indikasi/{iid}"), "id": iid}
                    except Exception:  # noqa: BLE001 - an indication gone meanwhile: nothing to challenge
                        continue
                pairs.append((a, v))
        else:
            # the red team role: an instance per strongest tag, up to its capacity
            slots = self.instances("red_team", picks, lambda n, v: {
                "key": f"redteam_{n:02d}", "name": f"Red team · {v['tag']} · {str(v['judul'])[:40]}",
                "peran": f"membela penjelasan wajar dari indikasi {v['tag']} pada {v['judul']}, lalu memutus bertahan atau melemah"})
            pairs = list(zip(slots, picks))

        async def challenge(a: dict, v: dict) -> None:
            key = a["key"]
            if key in self.done and any(x["indikasi_id"] == v["id"] for x in red):
                return
            full = self.p.get(f"/api/aip/indikasi/{v['id']}")
            srcs = "\n".join(f"- {s['agen']} ({s.get('kekuatan')}): {s.get('bukti', '')[:240]}" for s in full["sumber"][-8:])

            def putusan_red_team(hasil: str, alasan: str) -> dict:
                """Putusan Anda atas indikasi yang Anda uji: "bertahan" bila penjelasan wajar (kelas faskes, case-mix,
                rawat ulang yang sah, diagnosis langka, faskes kecil, COVID) TIDAK cukup menjelaskannya; "melemah" bila
                penjelasan wajar cukup. alasan: bukti dari data yang Anda baca, dengan angka dan hasil_id."""
                res = self.p.post("/api/aip/indikasi/red-team", {"run_id": self.run_id, "agen": key, "model": a["model"], "indikasi_id": v["id"],
                                                                 "hasil": hasil, "alasan": alasan})
                red.append({"indikasi_id": v["id"], "judul": v["judul"], "tag": v["tag"], "hasil": hasil, "kekuatan": res["kekuatan"], "agen": key})
                emit({"type": "red_team", "agent": key, "indikasi_id": v["id"], "judul": v["judul"], "tag": v["tag"], "hasil": hasil,
                      "kekuatan": res["kekuatan"], "alasan": alasan[:800]})
                return ({**res, "ringkasan": f"{hasil}: {v['judul'][:60]}"}, {"request": {"endpoint": "POST /api/aip/indikasi/red-team"}})

            text = f"""{self._head(a)}
Anda RED TEAM: tugas Anda membela kemungkinan bahwa indikasi ini WAJAR. Cari penjelasan jujur di data (kelas faskes, case-mix,
rawat ulang yang sah seperti dialisis/kemoterapi, diagnosis langka, faskes kecil, masa COVID), lalu putuskan dengan jujur.
{RULES}

Indikasi yang Anda uji: {v['tag']} ({v['tag_label']}) pada {v['entitas']} "{v['judul']}" (kunci {v['kunci']}), kekuatan {v['kekuatan']},
{v['dukungan']} sumber ({', '.join(v['keluarga_model'])}). Sumber dan buktinya:
{srcs}
Konteks: {json.dumps(v.get('konteks') or {}, ensure_ascii=False)}

{self.skill("red_team")}
Laporan 5 baris: penjelasan wajar yang Anda uji,
apa kata datanya, putusan."""
            tools = self.semantic_tools(key) + self.read_tools(key) + [self.box.wrap(key, "putusan_red_team", putusan_red_team, counted=False)]
            emit({"type": "assign", "agent": key, "target": {"indikasi_id": v["id"], "judul": v["judul"], "tag": v["tag"]}})
            a["target"] = {"indikasi_id": v["id"], "judul": v["judul"], "tag": v["tag"]}
            report = await self.work(key, text, tools, "red_team", "Uji indikasi ini.", 2500, skill="red_team")
            if not any(x["indikasi_id"] == v["id"] for x in red):
                # its turn ended without the verdict call: the verdict from what it read and wrote, nothing new
                ask = (f"Anda red team yang sudah memeriksa indikasi {v['tag']} pada {v['judul']}. Bukti dari pemeriksaan Anda:\n"
                       f"{_evidence(self.box.seen.get(key) or [])[:6000]}\nLaporan Anda: {report[:2000]}\n"
                       'Tulis putusan Anda sekarang. Jawab HANYA JSON: {"hasil": "bertahan" atau "melemah", "alasan": "<bukti dengan angka>"}')
                raw = await self.fallback(key, a["model"], lambda m_: LlmAgent(name=f"{key}_putusan", model=self.m.llm(m_, key, 2000), instruction=A._const(ask),
                                                                               output_key="putusan"), "putusan", "Tulis putusan.")
                try:
                    pv = A.parse_json(raw)
                    if pv.get("hasil") in ("bertahan", "melemah") and len(str(pv.get("alasan") or "")) >= 10:
                        putusan_red_team(pv["hasil"], str(pv["alasan"])[:2000])
                except Exception:  # noqa: BLE001 - no verdict: the tag keeps its strength, the report says so
                    pass

        qa_team = [a for a in self.team.values() if a["lini"] == "qa" and a["jenjang"] == "analis" and a["peran_kode"] == "qa"]
        await self.all([qa(a) for a in qa_team] + [challenge(a, v) for a, v in pairs], "qa")
        qa_text = _qa_summary(self.team, verdicts, red)
        if "validator" in self.team:
            self.reports["validator"] = qa_text
            emit({"type": "agent_status", "agent": "validator", "status": "selesai", "ms": 0, "calls": 0, "tags": 0, "laporan": qa_text[:1500]})
        self.phase("qa", "selesai", red_team=len(red))
        return {"verdicts": verdicts, "red": red, "ringkasan": qa_text}

    async def review(self, a: dict, syntheses: dict[str, str]) -> list[dict]:
        """A QA reviewer's checks of one domain agent's synthesis, against the data and the engagement's own results."""
        lead = a["target"]["lead"]
        name = (self.team.get(lead) or {}).get("name", lead)
        text = f"""{self._head(a)}
Anda reviewer QA dari keluarga model lain; Anda tidak melihat penalaran tim, hanya sintesisnya dan data.
{RULES}

Sintesis {name}:
{syntheses.get(lead, '(tidak ada)')[:6000]}

{self.skill("reviewer_qa")}
Klaim yang mengutip [rN] periksa dulu dengan baca_hasil (hasil bacaan penugasan ini: tabel teknik ML, ukur, box) — cocokkan angka dan
nama faskesnya di baris tabel itu; lalu uji dengan data Nexus/ML bila perlu. Klaim tanpa [rN] periksa dengan data.
Jawab HANYA JSON:
{{"checks": [{{"klaim": "<pernyataan>", "ok": true, "bukti": "<yang Anda temukan, dengan hasil_id>"}}]}}"""
        # its own reads and the engagement's results: the ML line's figures live in the technique tables (baca_hasil) and
        # the deployed model's tables (risiko_faskes_ml), which the reviewers could not open before 2026-10-29
        tools = self.semantic_tools(a["key"]) + self.read_tools(a["key"]) + [t for t in self.tag_tools(a["key"]) if t.__name__ == "lihat_indikasi"] + \
            [self.result_tool(a["key"])]
        raw = await self.work(a["key"], text, tools, "qa", "Periksa sintesis ini.", 3000, think="medium", skill="reviewer_qa")
        try:
            checks = O.clean_checks(A.parse_json(raw).get("checks"))
        except ValueError:
            checks = []
        if not checks and self.box.seen.get(a["key"]):
            # its turn ended without a readable verdict: the verdict from the checks it ran (as the question flow does)
            raw = await self.fallback(a["key"], a["model"], lambda m_: A.validator_verdict(self.m, m_, f"sintesis {name}", syntheses.get(lead, "")[:6000],
                                                                                          _evidence(self.box.seen[a["key"]])[:12000]), "verdict", "Tulis putusan.")
            try:
                checks = O.clean_checks(A.parse_json(raw).get("checks"))
            except ValueError:
                checks = []
        if not checks and self.box.seen.get(a["key"]):
            checks = [{"klaim": "(putusan tidak tertulis)", "ok": False, "bukti": _evidence(self.box.seen[a["key"]])[:800]}]
        # the validator's code gates on the reviewer too (Audit Nasional 1.1: 3 of Faskes & Wilayah's 3 "fails" were a cited
        # result never opened, or a total summed over the 10 rows shown): a claim whose numbers the cited results hold passes
        # by code; one failed for want of data is unmeasured — counted neither way
        checks = self.cited_numbers(checks, syntheses.get(lead, ""), {})
        checks = [{**c, "ok": None, "bukti": f"tidak terukur (reviewer tidak menemukan datanya): {c.get('bukti')}"}
                  if c.get("ok") is False and NO_DATA.search(str(c.get("bukti") or "")) else c for c in checks]
        emit({"type": "verdict", "validator": a["key"], "model": a["model"], "lini": lead, "sintesis": name, "checks": checks,
              "passed": sum(c.get("ok") is True for c in checks), "total": sum(c.get("ok") is not None for c in checks),
              "steps": self.box.receipts.get(a["key"], [])})
        return checks

    async def redo_lines(self, leads: list[str], plan: dict, syntheses: dict[str, str], qa: dict) -> tuple[dict[str, str], dict]:
        """A rewrite that also runs again the synthesis and the QA of some domain agents (POST …/laporan?ulang_lini=…): their
        small agents' reports stand as copied; the lead writes its synthesis anew with today's tools and prompt, and its QA
        reviewer checks it anew. The other lines' syntheses and verdicts stand as copied."""
        syntheses, verdicts = dict(syntheses), dict(qa.get("verdicts") or {})
        mgrs = [self.team[k] for k in leads if (self.team.get(k) or {}).get("jenjang") == "manajer"]
        reviewers = {(a.get("target") or {}).get("lead"): a for a in self.team.values() if a["lini"] == "qa" and a["jenjang"] == "analis" and a.get("peran_kode") == "qa"}
        emit({"type": "ulang_lini", "status": "mulai", "lini": [m["key"] for m in mgrs],
              "catatan": "sintesis dan QA lini ini dijalankan ulang di atas laporan agen kecil yang disalin; lini lain tetap seperti sumbernya"})
        for k in [m["key"] for m in mgrs] + [reviewers[m["key"]]["key"] for m in mgrs if m["key"] in reviewers]:
            # their copied steps are the source's: the guard against a report without reads must see this turn's own
            self.box.receipts.pop(k, None)
            self.box.seen.pop(k, None)
            self.box.calls[k] = 0
        for m in mgrs:
            syntheses[m["key"]] = await self.synthesize(m, plan)
        self.scrutinize("sintesis", syntheses=syntheses)
        for m in mgrs:
            if m["key"] in reviewers:
                verdicts[m["key"]] = await self.review(reviewers[m["key"]], syntheses)
        red = list(qa.get("red") or [])
        emit({"type": "ulang_lini", "status": "selesai", "lini": [m["key"] for m in mgrs],
              "qa": {k: f"{sum(bool(c.get('ok')) for c in verdicts.get(k) or [])}/{len(verdicts.get(k) or [])}" for k in [m["key"] for m in mgrs]}})
        return syntheses, {"verdicts": verdicts, "red": red, "ringkasan": _qa_summary(self.team, verdicts, red)}

    async def outline(self, key: str, material: str, tools: list, syntheses: dict[str, str]) -> dict | None:
        """The report's outline: the partner's points per section, each with its sources (it may check numbers with its
        tools first). Code keeps a point only when every result id it names is of this engagement, and — in the sections
        where the numbers live — when it has a source; what it drops is shown, as a scrutiny milestone. None when no
        readable outline came back (the report is then written in one pass)."""
        shape = ", ".join(f'"{sid}": [{{"klaim": "<satu kalimat>", "sumber": ["<rN atau key agen domain atau qa/fakta>"]}}]' for sid, *_ in SECTIONS[:2])
        ask = f"""
Langkah 1 dari 2 — KERANGKA laporan akhir. Bagian-bagiannya ditulis sesudah ini dari kerangka Anda, masing-masing HANYA dari
sumber yang Anda sebut untuk poinnya; kode menggabungkannya. Bagian (tetap, berurutan):
{chr(10).join(f"- {sid}: {title} — {what} (paling banyak {cap} poin)" for sid, title, what, cap in SECTIONS)}
Untuk tiap bagian tulis poin-poinnya: "klaim" = satu kalimat yang akan dikatakan bagian itu (dengan angkanya bila ada), "sumber" =
dari mana: hasil_id (mis. "r12") dari sintesis, fakta firma atau bacaan Anda sendiri, key agen domain yang sintesisnya dipakai
({', '.join(syntheses) or '-'}), "qa" (QA & red team), "fakta" (fakta firma), "kontrak" atau "rencana". Poin di
{', '.join(sorted(SOURCED))} tanpa sumber, atau dengan hasil_id yang bukan dari penugasan ini, DIBUANG kode. Anda boleh memeriksa
angka dengan tool (paling banyak 6 panggilan) sebelum menulis kerangka.
Jawab HANYA JSON: {{"judul": "<judul laporan>", "bagian": {{{shape}, …}}}}"""
        raw = await self.work(key, material + ask, tools, "partner", "Susun kerangka laporan akhir.", 5000, skill="laporan_akhir")
        try:
            got = A.parse_json(raw)
        except ValueError:
            got = {}
        parts = got.get("bagian") if isinstance(got, dict) else None
        if isinstance(parts, list):
            parts = {str(s.get("id")): s.get("poin") for s in parts if isinstance(s, dict)}
        if not isinstance(parts, dict) or not any(parts.get(sid) for sid, *_ in SECTIONS):
            emit({"type": "error", "agent": key, "message": "kerangka laporan tidak terbaca: laporan ditulis sekali jalan"})
            return None
        known = {r["rid"] for r in self.box.index}
        alias = {k: k for k in syntheses} | {str((self.team.get(k) or {}).get("name", "")).lower(): k for k in syntheses}
        sections, dropped = [], []
        for sid, title, what, cap in SECTIONS:
            keep = []
            for p in parts.get(sid) or []:
                p = {"klaim": p, "sumber": []} if isinstance(p, str) else p
                if not isinstance(p, dict) or not str(p.get("klaim") or "").strip():
                    continue
                claim = str(p["klaim"]).strip()
                src = [str(s).strip().strip("[]") for s in (p.get("sumber") or []) if str(s).strip()] if isinstance(p.get("sumber"), list) else []
                src = list(dict.fromkeys(src + re.findall(r"\br\d+\b", claim)))
                ghost = [s for s in src if re.fullmatch(r"r\d+", s) and s not in known]
                good = [s if re.fullmatch(r"r\d+", s) else alias.get(s.lower(), s.lower()) for s in src
                        if (re.fullmatch(r"r\d+", s) and s in known) or s.lower() in alias or s.lower() in SOURCE_WORDS]
                if ghost:
                    dropped.append({"bagian": sid, "klaim": claim[:300], "alasan": f"hasil_id bukan dari penugasan ini: {', '.join(ghost)}"})
                elif sid in SOURCED and not good:
                    dropped.append({"bagian": sid, "klaim": claim[:300], "alasan": "tanpa sumber"})
                else:
                    keep.append({"klaim": claim[:400], "sumber": good})
            sections.append({"id": sid, "judul": title, "isi": what, "poin": keep[:cap]})
        out = {"judul": str(got.get("judul") or "Laporan akhir penugasan AI Agent Swarm").strip("# ")[:200], "bagian": sections}
        emit({"type": "kerangka", "judul": out["judul"], "bagian": sections, "dibuang": dropped})
        ghosts = [d for d in dropped if d["alasan"] != "tanpa sumber"]
        bare = [d for d in dropped if d["alasan"] == "tanpa sumber"]
        empty = [s["judul"] for s in sections if not s["poin"]]
        checks = [{"klaim": "setiap hasil_id di kerangka adalah hasil penugasan ini (poin dengan rujukan lain dibuang)", "ok": not ghosts, "blok": False,
                   "bukti": f"{sum(len(s['poin']) for s in sections)} poin dipakai" + (f"; {len(ghosts)} dibuang: " + "; ".join(d["alasan"] for d in ghosts[:4]) if ghosts else "")},
                  {"klaim": f"setiap poin di {', '.join(sorted(SOURCED))} bersumber (poin tanpa sumber dibuang)", "ok": not bare, "blok": False,
                   "bukti": "semua bersumber" if not bare else f"{len(bare)} dibuang: " + "; ".join(d["klaim"][:80] for d in bare[:3])},
                  {"klaim": "setiap bagian laporan punya poin", "ok": not empty, "blok": False, "bukti": "lengkap" if not empty else f"kosong: {', '.join(empty)}"}]
        self.scrutinies.append({"milestone": "kerangka", "checks": checks})
        O.emit_scrutiny(checks, "kerangka")
        return out

    async def write_all(self, title: str, sections: list[dict], ctx: dict, fix: str = "", only: set[str] | None = None) -> list[dict]:
        """The sections written side by side (all, or `only` those the validator's notes are about), the partner shown
        working meanwhile — on the org chart and in the animation, which draw agents from their status."""
        a = self.team["partner"]
        todo = [s for s in sections if only is None or s["id"] in only]
        emit({"type": "agent_status", "agent": "partner", "status": "bekerja", "model": a["model"],
              "catatan": f"menulis {len(todo)} bagian laporan dari kerangka" + (" (revisi)" if fix else "")})
        t0 = time.time()
        out = list(await asyncio.gather(*(self.section(s, ctx, fix) if s in todo else asyncio.sleep(0, s) for s in sections)))
        emit({"type": "agent_status", "agent": "partner", "status": "selesai", "ms": int((time.time() - t0) * 1000), "calls": self.box.calls.get("partner", 0),
              "tags": 0, "laporan": _assemble(title, out)[:1500]})
        return out

    async def section(self, s: dict, ctx: dict, fix: str = "") -> dict:
        """One section of the report, written from only what its points cite (the syntheses and results they name, and
        the firm's facts or QA where the section is about them), without tools; its heading is the code's."""
        if not s["poin"]:
            return {**s, "teks": ""}
        a, key = self.team["partner"], "partner"
        cited = [x for p in s["poin"] for x in p["sumber"]]
        rids = list(dict.fromkeys(x for x in cited if re.fullmatch(r"r\d+", x)))
        parts = [f"### Sintesis {(self.team.get(k) or {}).get('name', k)}\n{ctx['syntheses'][k][:3500]}" for k in dict.fromkeys(cited) if k in ctx["syntheses"]]
        for rid in rids[:12]:
            hit = next((x for x in self.box.index if x["rid"] == rid), {})
            parts.append(f"### Hasil {rid} — {hit.get('title', '')} ({hit.get('total')} baris)\n"
                         f"{json.dumps((self.box.rows.get(rid) or [])[:15], ensure_ascii=False, default=str)[:2200]}")
        if s["id"] in ("ringkasan", "awam", "box", "keputusan") or "fakta" in cited:
            parts.append(f"### Fakta firma\n{json.dumps(ctx['facts'], ensure_ascii=False, default=str)[:7000]}")
        if s["id"] in ("ringkasan", "keandalan") or "qa" in cited:
            parts.append(f"### QA & red team\n{ctx['qa'].get('ringkasan', '')[:3000]}")
        if s["id"] == "lingkup" or "rencana" in cited:
            parts.append(f"### Tim dan rencana\n{self.counts()}; {self.sizes()}\nRencana: {json.dumps(ctx['plan'], ensure_ascii=False)[:2500]}")
        only = {"box": "Tulis 2–4 kalimat tafsiran saja: TABEL box karantina dan tabel kasus ditambahkan kode di bawah laporan — jangan menulis tabel, "
                       "dan jangan menyebut rekomendasi jalur untuk faskes yang tidak ada di fakta \"kasus\".",
                "lingkup": f"Sebut jumlah agen persis seperti ini: {self.counts()}."}.get(s["id"], "")
        plain = s["id"] == "awam"
        numbers = ("Untuk pimpinan yang BUKAN orang teknis: tanpa istilah teknis (AUPRC, recall, presisi, lift, prevalensi, IK95 — terangkan "
                   "maknanya), tanpa hasil_id. Angka hanya dari bahan di atas, boleh dibulatkan dengan \"sekitar\"; porsi boleh ditulis \"X dari "
                   "setiap N klaim/faskes\" dan perbandingan \"N kali lipat\" (dihitung ulang kode); kalimat dengan angka lain dibuang kode."
                   if plain else
                   "Setiap angka harus ada di bahan di atas dan menyebut hasil_id-nya (mis. [r12]); pakai \"nilai_total\"/\"nilai\" dari hasil ukur, "
                   "bukan \"objek_dihitung\".")
        text = f"""{self._head(a)}
{RULES}

Anda menulis SATU bagian laporan akhir penugasan untuk klien (BPJS Kesehatan): "{s['judul']}" — {s['isi']}.
Kerangka bagian ini (poin dan sumbernya, dari kerangka Anda):
{chr(10).join(f"- {p['klaim']} [sumber: {', '.join(p['sumber']) or '-'}]" for p in s['poin'])}

Bahan dari sumber yang dirujuk (satu-satunya bahan; jangan menambah fakta):
{chr(10).join(parts) or '-'}

Kontrak validasi penugasan (laporan harus memenuhinya):
{self.contract_text()}
{(chr(10) + fix + chr(10) + 'Perbaiki bagian ini bila catatan validator menyangkutnya; bila tidak, tulis bagian ini lagi apa adanya.') if fix else ''}
Tulis ISI bagian ini saja dalam Markdown: tanpa judul bagian (kode menambahkannya) dan tanpa kalimat tentang proses menulis.
{numbers} Kata "indikasi", bukan fraud terbukti. {only} Ringkas: paling banyak {max(4, 2 * len(s['poin']))} butir atau kalimat."""
        model = (self.cat["roles"].get("awam") or a["model"]) if plain else a["model"]
        emit({"type": "bagian", "agent": key, "id": s["id"], "judul": s["judul"], "status": "menulis", "model": model, **({"revisi": True} if fix else {})})
        async with self.sem:
            raw = await self.fallback(key, model, lambda m_: LlmAgent(name=f"partner_{s['id']}", model=self.m.llm(m_, key, 3000), instruction=A._const(text),
                                                                      output_key=f"bagian_{s['id']}"), f"bagian_{s['id']}", "Tulis bagian ini.")
        body = _section_only(raw)
        if NARRATION.search(body):
            # the model's own thinking in its answer (Audit Nasional 1.1, chapter 8: "I need to write… Let me verify… Wait…", cut
            # at its token limit before a clean version): written again on the other family, told plainly; still thinking
            # aloud → the thinking lines are cut by code
            emit({"type": "bagian", "agent": key, "id": s["id"], "judul": s["judul"], "status": "menulis", "model": model,
                  "catatan": "penalaran model tercampur di jawaban: bagian ditulis ulang"})
            again = text + ("\n\nPENTING: tulis LANGSUNG isi bagian ini dalam Bahasa Indonesia. Jangan menulis penalaran, rencana atau pemeriksaan "
                            "Anda (tanpa \"I need to\", \"Let me\", \"Wait\", tanpa bahasa Inggris).")
            async with self.sem:
                raw2 = await self.fallback(key, aip_models.failover(model) or model, lambda m_: LlmAgent(
                    name=f"partner_{s['id']}_ulang", model=self.m.llm(m_, key, 3000), instruction=A._const(again), output_key=f"bagian_{s['id']}"),
                    f"bagian_{s['id']}", "Tulis bagian ini.")
            body2 = _section_only(raw2)
            body = body2 if body2 and not NARRATION.search(body2) else _strip_narration(body2 or body)
        dropped: list[dict] = []
        if plain and body:  # the plain words' gate: a line whose number its material does not give is not shown
            source, kept = "\n".join(parts), []
            for line in body.splitlines():
                why = O.plain_check(line, source) if line.strip() else ""
                (dropped.append({"teks": line.strip()[:400], "alasan": why}) if why else kept.append(line))
            body = "\n".join(kept).strip()
        emit({"type": "bagian", "agent": key, "id": s["id"], "judul": s["judul"], "status": "selesai" if body else "gagal", "teks": body[:6000],
              **({"revisi": True} if fix else {}), **({"dibuang": dropped} if dropped else {})})
        return {**s, "teks": body}

    def report_team(self) -> None:
        """The report desk in the team: in the roster of an engagement since 2026-10-24; for a rewrite of one from before,
        the desk the API sent (aip/konsultan.py report_team) joins the copied team, shown as instances."""
        new = [dict(a) for a in self.inp.get("tim_laporan") or [] if a.get("key") not in self.team]
        for a in new:
            self.team[a["key"]] = a
        if new:
            emit({"type": "instances", "agents": new})

    async def edit(self, sections: list[dict]) -> list[dict]:
        """Each section's language edited by the editor, side by side. Code keeps an edit only when _edit_refused finds
        nothing (its numbers, result ids and tag codes the section's own, its length in bounds): what the validator
        checked is unchanged; otherwise the partner's text stands. Every decision is shown, as a scrutiny milestone."""
        key, a = "editor_laporan", self.team["editor_laporan"]
        emit({"type": "agent_status", "agent": "redaksi", "status": "bekerja", "model": "kode", "catatan": "editor menyunting bagian laporan"})
        emit({"type": "agent_status", "agent": key, "status": "bekerja", "model": a["model"]})
        t0 = time.time()

        async def one(s: dict) -> tuple[dict, dict | None]:
            if s["id"] == "awam" or not (s.get("teks") or "").strip():
                return s, None  # the leaders' explanation has its own gate (plain_check) and stays as written
            text = f"""Anda Editor laporan AI Agent Swarm untuk BPJS Kesehatan. Sunting BAHASA bagian laporan di bawah agar jernih dan enak
dibaca pimpinan: perbaiki salah ketik dan tata bahasa, pecah kalimat yang terlalu panjang, satukan istilah (indikasi, faskes, klaim,
kelompok A–Z), pertahankan bentuk Markdown (butir tetap butir, tebal tetap tebal).
DILARANG: mengubah, menambah, menghapus atau membulatkan angka; mengubah atau menghapus rujukan [rN]; menghapus kode tag (mis.
KLAIM_GANDA); menambah fakta, kesimpulan atau kata yang menuduh (tetap "indikasi"). Kode membandingkan angka, rujukan dan kode tag:
suntingan yang mengubahnya ditolak dan teks asli dipakai.

Bagian "{s['judul']}":
{s['teks']}

Keluarkan HANYA teks bagian hasil suntingan, tanpa judul dan tanpa komentar."""
            async with self.sem:
                raw = await self.fallback(key, a["model"], lambda m_: LlmAgent(name=f"editor_{s['id']}", model=self.m.llm(m_, key, 3500), instruction=A._const(text),
                                                                               output_key=f"sunting_{s['id']}"), f"sunting_{s['id']}", "Sunting bagian ini.")
            new = _section_only(raw)
            first = new.splitlines()[0] if new else ""
            if re.sub(r"[*#_:\s]", "", first).lower() == re.sub(r"[*#_:\s]", "", s["judul"]).lower():  # its title again, in bold: the heading is code's
                new = "\n".join(new.splitlines()[1:]).strip()
            why = _edit_refused(s["teks"], new)
            if why:
                return s, {"bagian": s["judul"], "diterima": False, "alasan": why}
            emit({"type": "bagian", "agent": key, "id": s["id"], "judul": s["judul"], "status": "selesai", "teks": new[:6000], "disunting": True, "model": a["model"]})
            return {**s, "teks": new}, {"bagian": s["judul"], "diterima": True, "alasan": ""}

        done = await asyncio.gather(*(one(s) for s in sections))
        notes = [n for _, n in done if n]
        kept, refused = [n for n in notes if n["diterima"]], [n for n in notes if not n["diterima"]]
        checks = [{"klaim": "suntingan editor tidak mengubah angka, rujukan hasil_id atau kode tag (yang mengubahnya ditolak kode)", "ok": True, "blok": False,
                   "bukti": f"{len(kept)} bagian disunting, {len(refused)} ditolak" + (": " + "; ".join(f"{n['bagian']} — {n['alasan']}" for n in refused[:4]) if refused else "")}]
        self.scrutinies.append({"milestone": "suntingan", "checks": checks})
        O.emit_scrutiny(checks, "suntingan")
        emit({"type": "agent_status", "agent": key, "status": "selesai", "ms": int((time.time() - t0) * 1000), "calls": self.box.calls.get(key, 0), "tags": 0,
              "laporan": f"{len(kept)} bagian disunting, {len(refused)} ditolak kode" + "".join(f"\n- {n['bagian']}: {n['alasan']}" for n in refused)})
        return [x for x, _ in done]

    async def phase_7(self) -> None:
        """Redaksi: the long report's exhibits and case files frozen as this engagement leaves them, then the exhibit
        analyst's commentary on what the frozen exhibits show — the API gates every sentence against their facts
        (aip/laporan_konsultan.py). The report stands as written if a step fails; the failure is shown."""
        self.phase("redaksi", "mulai")
        self.report_team()
        emit({"type": "agent_status", "agent": "redaksi", "status": "bekerja", "model": "kode", "catatan": "membekukan exhibit dan berkas kasus"})
        t0, done = time.time(), []
        key, a = "analis_exhibit", self.team.get("analis_exhibit")
        try:
            frozen = await asyncio.to_thread(self.p.post, f"/api/aip/konsultan/{self.run_id}/laporan-lengkap/bekukan", {})
            ex = frozen.get("exhibit") or []
            done.append(f"{len(ex)} exhibit dan {frozen.get('berkas', 0)} berkas kasus dibekukan")
            if a and ex:
                emit({"type": "agent_status", "agent": key, "status": "bekerja", "model": a["model"]})
                t1 = time.time()
                async with self.sem:
                    raw = await self.fallback(key, a["model"], lambda m_: LlmAgent(name=key, model=self.m.llm(m_, key, 6000), instruction=A._const(frozen["prompt"]),
                                                                                   output_key="narasi_exhibit"), "narasi_exhibit", "Tulis penjelasan tiap exhibit.")
                try:
                    got = A.parse_json(raw)
                except ValueError:
                    got = {}
                saved = await asyncio.to_thread(self.p.post, f"/api/aip/konsultan/{self.run_id}/laporan-lengkap/narasi-agen",
                                                {"model": a["model"], "narasi": got if isinstance(got, dict) else {}})
                n, cut = int(saved.get("disimpan") or 0), int(saved.get("dibuang") or 0)
                checks = [{"klaim": "setiap exhibit laporan lengkap punya penjelasan", "ok": n == len(ex), "blok": False,
                           "bukti": f"{n}/{len(ex)} exhibit" + (f"; {saved['alasan']}" if saved.get("alasan") else "")},
                          {"klaim": "kalimat penjelasan yang angkanya tidak ada di fakta exhibit dibuang kode", "ok": True, "blok": False,
                           "bukti": f"{cut} kalimat dibuang" + "".join(f"; [{d.get('exhibit')}] {d.get('alasan')}" for d in (saved.get("contoh_dibuang") or [])[:2])}]
                self.scrutinies.append({"milestone": "redaksi", "checks": checks})
                O.emit_scrutiny(checks, "redaksi")
                emit({"type": "agent_status", "agent": key, "status": "selesai" if n else "gagal", "ms": int((time.time() - t1) * 1000),
                      "calls": self.box.calls.get(key, 0), "tags": 0, "laporan": f"penjelasan {n} dari {len(ex)} exhibit; {cut} kalimat dibuang kode"
                      + (f"; {saved['alasan']}" if saved.get("alasan") else "")})
                done.append(f"penjelasan {n}/{len(ex)} exhibit")
        except Exception as e:  # noqa: BLE001 - the report is written; its long form computes the exhibits live instead
            emit({"type": "error", "agent": "redaksi", "message": f"redaksi laporan: {str(e)[:300]}"})
            done.append(f"gagal: {str(e)[:160]}")
        emit({"type": "agent_status", "agent": "redaksi", "status": "selesai", "ms": int((time.time() - t0) * 1000), "calls": 0, "tags": 0, "laporan": "; ".join(done)})
        self.phase("redaksi", "selesai")

    def cited_numbers(self, checks: list[dict], report: str, facts: dict) -> list[dict]:
        """A validator's "no" on a claim whose every number is in the results the report cites for it (or in the firm's
        facts): passed by code, the result ids named (2026-10-29: it failed "Sulsel 1.093, Jabar 936, Jatim 767 …" saying no
        result held provinces, while the cited [r1457] did — and that "no" rewrote all nine sections)."""
        lines = report.splitlines()
        base = _numbers(json.dumps(facts, ensure_ascii=False, default=str))
        out = []
        for c in checks:
            want = _numbers(str(c.get("klaim") or ""))
            if c.get("ok") is not False or not any(len(n) >= 3 for n in want):  # two-digit figures alone match by chance
                out.append(c)
                continue
            rids = set(re.findall(r"\br\d+\b", f"{c.get('klaim')} {c.get('bukti')}"))
            for ln in lines:  # the report's lines saying most of these numbers: the results they cite
                if len(want & _numbers(ln)) * 2 >= len(want):
                    rids |= set(re.findall(r"\br\d+\b", ln))
            pool = set(base)
            for rid in rids:
                sums: dict[str, float] = {}
                for row in self.box.rows.get(rid) or []:
                    for k, v in row.items():
                        pool |= _numbers(str(int(v)) if isinstance(v, float) and v.is_integer() else str(v))
                        if isinstance(v, (int, float)) and not isinstance(v, bool):
                            sums[k] = sums.get(k, 0) + v
                pool |= {str(round(s)) for s in sums.values()}  # a ranking's total (all risky claims of the 38 provinces)
            if want <= pool:
                c = {**c, "ok": True, "oleh": "kode", "bukti": f"kode: semua angka klaim ({', '.join(sorted(want))}) ada di "
                                                                f"{', '.join(sorted(rids, key=lambda x: int(x[1:]))) or 'fakta firma'} · validator: {c.get('bukti')}"}
            out.append(c)
        return out

    async def contract_verdict(self, vkey: str, judged: list[dict], report: str) -> list[dict]:
        """The contract statements still unjudged, in one call of their own: the report, what the validator's own reads
        returned, and the rows of the results each statement cites; a verdict per statement (null when the data cannot
        say), on the other family when the first fails."""
        open_ = [c for c in judged if c["ok"] is None]
        cited = sorted({r for c in open_ for r in re.findall(r"\br\d+\b", c.get("teks") or "")}, key=lambda x: int(x[1:]))
        rows = "\n".join(f"[{r}] {next((x['title'] for x in self.box.index if x['rid'] == r), '')}: "
                         f"{json.dumps((self.box.rows.get(r) or [])[:20], ensure_ascii=False, default=str)[:1500]}" for r in cited)
        ask = (f"Anda Validator AIP JKN. Nilai SETIAP pernyataan kontrak di bawah terhadap laporan, hasil yang dikutipnya dan bukti pemeriksaan Anda. "
               f"ok = true bila terpenuhi, false HANYA bila data menunjukkan pelanggaran, null bila data tidak cukup untuk memutus. bukti: alasan "
               f"singkat dengan angka dan hasil_id.\n\nKontrak:\n{O.contract_text(open_)}\n\nHasil yang dikutip kontrak:\n{rows or '-'}\n\n"
               f"Laporan:\n{report[:8000]}\n\nBukti pemeriksaan:\n{_evidence(self.box.seen.get(vkey) or [])[:8000]}\n\n"
               'Jawab HANYA JSON, tanpa penalaran: {"kontrak": [{"id": "<id>", "ok": true, "bukti": "<alasan>"}]}')
        raw = await self.fallback(vkey, self.team[vkey]["model"], lambda m_: LlmAgent(name="validator_kontrak", model=self.m.llm(m_, vkey, 3000),
                                                                                        instruction=A._const(ask), output_key="kontrak"), "kontrak", "Nilai kontrak.")
        try:
            got = A.parse_json(raw)
        except ValueError:
            got = {}
        rows = got.get("kontrak") if isinstance(got, dict) else got if isinstance(got, list) else []
        by_id = {str(x.get("id")): x for x in rows or [] if isinstance(x, dict)}
        return [{**c, "ok": by_id[c["id"]]["ok"], "bukti": O.as_text(by_id[c["id"]].get("bukti"))[:600], "oleh": "validator (putusan kontrak)"}
                if c["ok"] is None and isinstance((by_id.get(c["id"]) or {}).get("ok"), bool) else c for c in judged]

    async def phase_6(self, brief: str, plan: dict, syntheses: dict[str, str], qa: dict, box: dict) -> None:
        self.phase("laporan", "mulai")
        self.report_team()
        key = "partner"
        a = self.team[key]
        # the run whose work the report is about: this one, or for a rewrite the engagement whose phases were copied (its
        # tags and its investigators' recommendations carry that run's id) — followed back through a rewrite of a rewrite,
        # which keeps no box or tags of its own (2026-10-29: a rewrite of a line rerun stopped on "tidak menyimpan box")
        worked, seen = self.inp.get("ulang_laporan") or self.run_id, set()
        while worked != self.run_id and worked not in seen:
            seen.add(worked)
            src = (self.p.get(f"/api/aip/runs/{worked}", after=10 ** 9).get("run") or {}).get("ulang_laporan")
            if not src:
                break
            worked = src
        tag_sum = self.p.get("/api/aip/indikasi/ringkasan")
        run_sum = self.p.get("/api/aip/indikasi/ringkasan", run_id=worked)
        # the box the engagement left (a rewrite: the one of the engagement it copies, not today's live box)
        kar = self.p.get("/api/aip/karantina", limit=400, **({"penugasan": worked} if worked != self.run_id else {}))
        audited = {(a.get("target") or {}).get("faskes_profil_id") for a in self.team.values() if a["lini"] == "kasus" and a["jenjang"] == "analis"}
        cases = []
        for g in ("A", "B", "C", "D", "Z"):
            for f in kar["kelompok"][g]["faskes"]:
                if f["faskes_profil_id"] in audited:
                    mine = [r for r in f.get("rekomendasi") or [] if r.get("run_id") == worked]
                    cases.append({"faskes": f["nama"], "kelompok": g, "kerugian_rp": f["estimasi_kerugian_rp"], "tsm": {d: f["tsm"][d]["nilai"] for d in f["tsm"]},
                                  "tsm_penyidik": (mine[-1].get("tsm") if mine else None), "rekomendasi": (mine[-1].get("jalur") if mine else None),
                                  "rekomendasi_oleh": (mine[-1].get("agen") if mine else None),
                                  "penyidik": next((r.get("jalur") for r in reversed(mine) if r.get("agen") != "gerbang_tsm"), None), "status": f["status"]})
        token = T._CURRENT.set(key)
        r_tags = self.box.result("Indikasi per tag dan kekuatan (buku besar)", tag_sum["per_tag"], meta={"kind": "tag_summary", "metric": "total", "label": "label"})
        r_box = self.box.result("Box karantina per kelompok", [{"kelompok": g, **v} for g, v in (kar.get("ringkasan") or {}).get("kelompok", {}).items()],
                                meta={"kind": "karantina_groups", "metric": "kerugian_rp", "label": "kelompok"})
        r_cases = self.box.result("Kasus yang diaudit agen penyidik", cases, meta={"kind": "cases"})
        T._CURRENT.reset(token)
        facts = {"tag_total": tag_sum["total"], "kuat": tag_sum["kuat"], "sedang": tag_sum["sedang"], "lemah": tag_sum["lemah"], "tag_run_ini": run_sum["total"],
                 "tag_ditolak": int(tag_sum.get("ditolak") or 0),
                 # (Audit Nasional 1.1's report said "14 tag ditolak oleh validator")
                 "catatan_tag_ditolak": "tag_ditolak = tag yang DITOLAK MANUSIA (keputusan tim audit di buku besar), bukan oleh validator; tidak dihitung di tag_total",
                 "per_tag": tag_sum["per_tag"][:16], "faskes_teratas": tag_sum["faskes_teratas"][:10], "box": kar.get("ringkasan"), "kasus": cases,
                 "hasil_id": {"tag": r_tags, "box": r_box, "kasus": r_cases},
                 **({f"telaah_klinis_blu_{self.versi.replace('.', '_')}": {"ringkasan": self.review_line(), **{k: self.telaah.get(k) for k in (
                     "status", "ditelaah", "kesimpulan_saring", "diperiksa_ulang", "layak_tag", "tag", "sampel_audit", "usd", "rid")}}}
                    if self.telaah else {})}
        material = f"""{self._head(a)}
Penugasan klien: {brief}
{RULES}

Rencana Anda: {json.dumps(plan, ensure_ascii=False)[:3000]}

Sintesis agen domain:
{chr(10).join(f"## {(self.team.get(k) or {}).get('name', k)} (key {k}){chr(10)}{v[:3500]}" for k, v in syntheses.items())}

QA & red team:
{qa.get('ringkasan', '')[:3000]}

Fakta firma (dari buku besar dan box karantina; hasil_id ada di dalamnya): {json.dumps(facts, ensure_ascii=False, default=str)[:9000]}

Kontrak validasi yang Anda tulis sebelum pekerjaan dimulai (laporan harus memenuhinya; validator akan memeriksanya):
{self.contract_text()}

{self.skill("laporan_akhir")}"""
        single = f"""
Tulis LAPORAN AKHIR untuk klien (BPJS Kesehatan) dalam Markdown, ringkas dan tajam:
# judul
## Ringkasan eksekutif (5 butir: angka terpenting dengan hasil_id)
## Lingkup & metode ({self.counts()}: orkestrator, agen domain dengan agen kecilnya, sub-agen teknik ML, validator dengan QA dan peran
   red team; penyidik dan red team adalah peran dinamis — satu instans per kasus antrean, bukan agen tetap; lapisan semantik, penanda
   otomatis, konsensus teknik ML; data nyata)
## Temuan utama (per agen domain: wilayah dan kelas faskes, modus klaim, klinis, peserta dan rujukan, ML) — angka + hasil_id
## Box karantina dan kasus prioritas: 2–4 kalimat tafsiran saja — TABEL box karantina dan tabel kasus (dengan rekomendasi agen
   penyidik) DITAMBAHKAN OTOMATIS dari data di bawah laporan Anda; jangan menulis tabel itu, dan jangan menyebut rekomendasi jalur
   untuk faskes yang tidak ada di fakta "kasus" (rekomendasi hanya dari penyidik; "ditindak" hanya bila T, S dan M terpenuhi)
## Keandalan (QA, red team, keterbatasan: indikasi bukan fraud terbukti; label = koreksi verifikator; data sampel)
## Keputusan yang dibutuhkan dari manusia (konfirmasi tag, keputusan jalur audit)
Hanya angka yang ada di bahan di atas atau yang Anda periksa dengan tool (paling banyak 6 panggilan). Dari hasil ukur, pakai
"nilai_total" / "nilai" — "objek_dihitung" adalah banyaknya objek yang diagregasi, bukan nilai ukuran."""
        tools = self.semantic_tools(key) + [t for t in self.tag_tools(key) if t.__name__ == "lihat_indikasi"] + [self.box_tool(key)]
        self.box.calls[key] = 0  # a fresh budget for the report
        ctx = {"plan": plan, "syntheses": syntheses, "qa": qa, "facts": facts}
        # the outline-first writer; "kerangka": false keeps the single pass (a rewrite's A/B control)
        outline = await self.outline(key, material, tools, syntheses) if self.inp.get("kerangka", True) else None
        ledger = _ledger_line(facts, r_tags)
        if outline:
            sections = _ledger_into(await self.write_all(outline["judul"], outline["bagian"], ctx), ledger)
            report = _assemble(outline["judul"], sections)
        else:  # no readable outline: the report in one pass, as before the outline
            sections = []
            self.box.calls[key] = 0
            report = _ledger_report(_report_only(await self.work(key, material + single, tools, "partner", "Tulis laporan akhir.", 7000, skill="laporan_akhir")), ledger)
        emit({"type": "draft", "text": report})
        self.scrutinize("laporan", report=report)
        # the validator: another family, its own reads of the same data
        vkey = "validator"
        self.team.setdefault(vkey, {"key": vkey, "name": "Validator", "peran": "memeriksa angka laporan terhadap data", "model": self.inp.get("validator_model")
                                    or self.cat["roles"]["validator"], "lini": "qa", "jenjang": "manajer", "induk": "partner"})
        self.box.calls[vkey] = 0  # a fresh budget for the report
        # the measures code computed, with what each counts: on 2026-10-28 the validator failed the ledger's 17.013 tags
        # against the Box facilities' sum(tag) 14.862 — another measure — and the revision wrote that note into the summary
        bx = facts.get("box") or {}
        measures = (f"- tag indikasi di buku besar (semua entitas: klaim, faskes, wilayah, kode, peserta, rujukan; tanpa tag yang ditolak manusia): "
                    f"{_idn(facts['tag_total'])} (kuat {_idn(facts['kuat'])}, sedang {_idn(facts['sedang'])}, lemah {_idn(facts['lemah'])}) [{r_tags}]\n"
                    f"- tag yang ditulis atau dikuatkan penugasan ini: {_idn(facts['tag_run_ini'])}\n"
                    f"- Box Karantina: {_idn(bx.get('faskes') or 0)} faskes, estimasi kerugian Rp {_idn(bx.get('total_estimasi_kerugian_rp') or 0)} [{r_box}]\n"
                    "- sum(tag) tipe Karantina Faskes = tag pada faskes di Box saja (tag klaimnya dan tag faskesnya), BUKAN jumlah tag buku besar\n"
                    # (2026-10-28: the validator counted the Nexus type without this filter — 17.076 = 17.063 + 13 rejected — and
                    # failed a right summary)
                    f"- di tipe Nexus Indikasi Fraud (AI Agent Swarm) hitung buku besar dengan filter status != ditolak "
                    f"[{{\"property\": \"status\", \"op\": \"neq\", \"value\": \"ditolak\"}}]: tanpa filter itu totalnya "
                    f"{_idn(facts['tag_total'] + facts['tag_ditolak'])}, termasuk {_idn(facts['tag_ditolak'])} tag yang sudah ditolak manusia\n"
                    # its reads go to what the report cites (the 29-10 validator spent steps guessing type names)
                    f"- tabel kode penugasan ini (buka dengan baca_hasil): [{r_tags}] tag per kode dan kekuatan, [{r_box}] box per kelompok, "
                    f"[{r_cases}] kasus yang diaudit dengan rekomendasi dan TSM")
        vtext = f"""Anda Validator AIP JKN (adversarial, dari keluarga model lain) memeriksa laporan akhir penugasan AI Agent Swarm (audit indikasi fraud). Anda hanya melihat laporannya dan data.
{RULES}

Laporan:
{report[:12000]}

Kontrak validasi penugasan — nilai SETIAP pernyataan terhadap laporan dan data:
{self.contract_text()}

Ukuran resmi yang dihitung kode — bandingkan klaim dengan ukuran yang sama artinya, jangan dengan ukuran lain yang mirip namanya:
{measures}

Periksa 5–8 klaim angka terpenting (ringkasan eksekutif dan box karantina dulu) dengan tool sendiri. Setiap [rN] di laporan adalah hasil
penugasan ini dan bisa dibuka dengan baca_hasil(rN): buka dulu sebelum menulis bahwa datanya tidak ada; "tidak bisa diverifikasi" bukan
"salah" (untuk kontrak: ok null). Jawab HANYA JSON:
{{"checks": [{{"klaim": "<pernyataan>", "ok": true, "bukti": "<yang Anda temukan, dengan hasil_id>"}}],
 "kontrak": [{{"id": "d1", "ok": true, "bukti": "<mengapa terpenuhi atau tidak>"}}]}}"""
        vtools = self.semantic_tools(vkey) + T.object_tools(self.box, vkey, any_owner=True, read_only=True) + \
            [t for t in self.tag_tools(vkey) if t.__name__ == "lihat_indikasi"] + [self.box_tool(vkey), self.result_tool(vkey)]
        raw = await self.work(vkey, vtext, vtools, "validator", "Periksa laporan.", 3000, think="medium")
        try:
            verdict = A.parse_json(raw)
        except ValueError:
            verdict = {}
        checks = O.clean_checks(verdict.get("checks"))
        by_id = {str(c.get("id")): c for c in verdict.get("kontrak") or [] if isinstance(c, dict)}
        note = ""
        if (not checks or not by_id) and self.box.seen.get(vkey):
            # its turn ended without a readable verdict (engagement 4: the model answered empty after nine reads, the contract
            # went unjudged): the verdict from what those reads returned — the report's numbers and every contract statement —
            # on the other family when the first does not answer, as the QA reviewers do
            ids = {c["id"] for c in self.contract}
            again = await self.fallback(vkey, self.team[vkey]["model"], lambda m_: A.validator_verdict(
                self.m, m_, "laporan akhir penugasan AI Agent Swarm", report[:8000], _evidence(self.box.seen[vkey])[:12000], self.contract_text(),
                claims=True), "verdict", "Tulis putusan.")
            try:
                got = O.clean_checks(A.parse_json(again).get("checks"))
            except ValueError:
                got = []
            checks = checks or [c for c in got if str(c.get("id")) not in ids]
            by_id = by_id or {str(c.get("id")): c for c in got if str(c.get("id")) in ids}
            note = "putusan ditulis dari hasil pemeriksaan validator sendiri (gilirannya berakhir tanpa putusan)" if got else ""
        judged = [{**c, "ok": by_id[c["id"]].get("ok") if isinstance((by_id.get(c["id"]) or {}).get("ok"), bool) else None,
                   "bukti": O.as_text((by_id.get(c["id"]) or {}).get("bukti"))[:600]} for c in self.contract]
        # what code can decide from the box and the report, code decides; what is still unjudged gets one call of its own
        # (2026-10-29: the validator's turn ended in its reasoning, its fallback wrote checks but no contract — all 11 unjudged)
        judged = _contract_by_code(judged, report, cases, kar, worked)
        if any(c["ok"] is None for c in judged):
            judged = await self.contract_verdict(vkey, judged, report)
        checks, judged = _reconcile(checks, facts, "klaim"), _reconcile(judged, facts, "teks")
        checks, judged = self.cited_numbers(checks, report, facts), _unmeasured(judged)
        failed = [c for c in checks if not c.get("ok")]
        broken = [c for c in judged if c["ok"] is False]
        emit({"type": "verdict", "validator": vkey, "model": self.team[vkey]["model"], "checks": checks, "passed": len(checks) - len(failed), "total": len(checks),
              "steps": self.box.receipts.get(vkey, []), "kontrak": judged, **({"catatan": note} if note else {})})
        blocked = [c for c in self.scrutinies[-1]["checks"] if c["blok"] and not c["ok"]] if self.scrutinies else []
        if failed or broken or blocked:
            self.box.calls[key] = 0
            fix = failed + [{"kontrak": c["id"], "pernyataan": c["teks"], "bukti": c["bukti"]} for c in broken] + [{"scrutiny": c["klaim"], "bukti": c["bukti"]} for c in blocked]
            notes = f"VALIDATOR menemukan klaim atau pernyataan kontrak yang tidak bertahan — perbaiki:\n{json.dumps(fix, ensure_ascii=False)[:3500]}"
            if sections:  # only the sections the notes are about are written again, each from its own sources
                sections = _ledger_into(await self.write_all(outline["judul"], sections, ctx, notes, _implicated(sections, fix)), ledger)
                report = _assemble(outline["judul"], sections)
            else:
                report = _ledger_report(_report_only(await self.work(key, material + single + "\n\n" + notes, tools, "partner", "Perbaiki laporan akhir.", 7000,
                                                                     skill="laporan_akhir")), ledger)
            emit({"type": "draft", "text": report, "revised": True})
        if sections and "editor_laporan" in self.team:  # the language edited after the validator: what it checked stays as it was
            sections = _ledger_into(await self.edit(sections), ledger)
            report = _assemble(outline["judul"], sections)
            emit({"type": "draft", "text": report, "disunting": True})
        report = report.rstrip() + "\n\n" + self.tables(kar, cases, r_box, r_cases)
        self.machine("sinkron_nexus", "bekerja")
        try:
            nexus = await asyncio.to_thread(self.p.post, "/api/aip/indikasi/sinkron", {})
        except Exception as e:  # noqa: BLE001 - the ledger stands; the Nexus view is retried later
            nexus = {"status": "gagal", "error": str(e)[:300]}
        self.machine("sinkron_nexus", "selesai" if nexus.get("status") == "tersinkron" else "gagal", hasil=nexus)
        final = self.p.get("/api/aip/indikasi/ringkasan", run_id=worked)
        stats = {"agen": sum(1 for a in self.team.values() if not a.get("instans_dari")),
                 "instans_dinamis": sum(1 for a in self.team.values() if a.get("instans_dari")), "agen_bekerja": len([k for k in self.reports if k in self.team]), "tag_run_ini": final["total"], "tag_buku_besar": tag_sum["total"],
                 "kuat": final["kuat"], "sedang": final["sedang"], "lemah": final["lemah"], "box": box.get("faskes"), "kasus": len(cases),
                 "red_team": len(qa.get("red") or []), "qa": {k: f"{sum(bool(c.get('ok')) for c in v)}/{len(v)}" for k, v in (qa.get("verdicts") or {}).items()},
                 "validator": f"{len(checks) - len(failed)}/{len(checks)}", "nexus": nexus.get("status"),
                 "kontrak": f"{sum(c['ok'] is True for c in judged)}/{len(judged)}",
                 "scrutiny": {x["milestone"]: f"{sum(c['ok'] for c in x['checks'])}/{len(x['checks'])}" for x in self.scrutinies},
                 "serah_terima": f"{sum(h['procedures_followed']['ok'] for h in self.handoffs.values())}/{len(self.handoffs)} prosedur diikuti"}
        emit({"type": "engagement", "laporan": report, "statistik": stats})
        emit({"type": "draft", "text": report, "final": True})
        self.phase("laporan", "selesai")
        emit({"type": "answer", "text": report, "checks": {"passed": len(checks) - len(failed), "total": len(checks), "revised": bool(failed or broken or blocked),
                                                           "kontrak": {"terpenuhi": sum(c["ok"] is True for c in judged), "total": len(judged)}}})
        # learning: what QA, the validator and the scrutiny caught becomes lessons of the skills used
        caught = failed + [{"klaim": f"kontrak {c['id']}: {c['teks']}", "bukti": c["bukti"], "ok": False} for c in broken] + \
            [c for x in self.scrutinies for c in x["checks"] if not c["ok"]] + [c for cs in (qa.get("verdicts") or {}).values() for c in cs if not c.get("ok")]
        await O.encode_lessons(stage, self.service, self.m, self.cat["roles"]["planner"], self.run_id, self.p, sorted(self.used),
                               O.issues_for_learning(caught, list(self.handoffs.values())))


def _rp(x: float) -> str:
    return f"Rp{x:,.0f}".replace(",", ".")


# contract statements code can decide (the base contract's d1, d2, d4 and the orchestrator's restatements of them)
TSM_RX = re.compile(r"ditindak.{0,120}(terstruktur|tsm)|(terstruktur|tsm).{0,120}ditindak", re.I | re.S)
REC_RX = re.compile(r"kelompok a dan b.{0,160}rekomendasi jalur|rekomendasi jalur.{0,160}kelompok a dan b", re.I | re.S)
LANG_RX = re.compile(r"indikasi.{0,160}keputusan|keputusan.{0,160}indikasi", re.I | re.S)


def _contract_by_code(judged: list[dict], report: str, cases: list[dict], kar: dict, worked: str) -> list[dict]:
    """The contract statements about the path rule, the investigators' recommendations and the report's words, decided by
    code from the box and the report — never by a reading of them (the 28-10 validator failed 'ditindak only with TSM'
    on the box's own TSM while the gate had no say; the 29-10 one left them unjudged). The validator's note stays beside."""
    full = lambda t: bool(t) and all(v == "terpenuhi" for v in t.values())  # noqa: E731
    held = [c["faskes"] for c in cases if c.get("rekomendasi") == "ditindak"]
    wrong = [c["faskes"] for c in cases if c.get("rekomendasi") == "ditindak" and not (full(c.get("tsm_penyidik")) and full(c.get("tsm")))]
    gated = [c["faskes"] for c in cases if c.get("rekomendasi_oleh") == "gerbang_tsm"]
    audited = [c for c in cases if c["kelompok"] in ("A", "B")]
    ab = [f for g in ("A", "B") for f in (((kar.get("kelompok") or {}).get(g) or {}).get("faskes") or [])]
    heads = [h.lower() for h in re.findall(r"(?m)^#{1,3} .*$", report)]
    out = []
    for c in judged:
        t = c.get("teks") or ""
        if TSM_RX.search(t):
            ok, why = not wrong, (f"{len(held)} rekomendasi ditindak, " + ("semuanya T, S dan M terpenuhi menurut penyidik dan data box" if not wrong else
                                                                          f"tanpa TSM penuh: {'; '.join(wrong[:4])}")
                                  + (f"; diturunkan gerbang TSM ke dibina: {'; '.join(gated[:4])}" if gated else ""))
        elif REC_RX.search(t):
            missing = [x["faskes"] for x in audited if not x.get("rekomendasi")] if re.search(r"diaudit", t, re.I) else \
                [f["nama"] for f in ab if not any(r.get("run_id") == worked for r in f.get("rekomendasi") or [])]
            scope = f"{len(audited)} faskes A/B yang diaudit" if re.search(r"diaudit", t, re.I) else f"{len(ab)} faskes kelompok A dan B di box"
            ok, why = not missing, f"{scope}: " + ("semua punya rekomendasi penyidik penugasan ini" if not missing else f"{len(missing)} tanpa rekomendasi: {'; '.join(missing[:4])}")
        elif LANG_RX.search(t):
            ok = "indikasi" in report.lower() and any("keputusan" in h for h in heads)
            why = "laporan memakai kata indikasi dan punya bagian keputusan untuk manusia" if ok else "kata indikasi atau bagian keputusan manusia tidak ada"
        else:
            out.append(c)
            continue
        out.append({**c, "ok": ok, "bukti": f"kode: {why}" + (f" · validator: {c['bukti']}" if c.get("bukti") else ""), "oleh": "kode"})
    return out


NO_DATA = re.compile(r"tidak (ada|tersedia|dapat|bisa)\b.{0,60}(data|hasil|diverifikasi|dipastikan|di-?akses|referensi)|"
                     r"(data|hasil|referensi)\b.{0,40}tidak (ada|tersedia|cukup)|tidak dapat (diverifikasi|dipastikan)", re.I | re.S)


def _unmeasured(judged: list[dict]) -> list[dict]:
    """A contract statement judged false only because the validator found no data is unmeasured, not broken: it is no
    violation, and as one it sent every section of the 29-10 rewrite to revision."""
    return [{**c, "ok": None, "bukti": f"tidak terukur (validator tidak menemukan datanya): {c.get('bukti')}"}
            if c.get("ok") is False and c.get("oleh") != "kode" and NO_DATA.search(str(c.get("bukti") or "")) else c for c in judged]


LEDGER_MARK = "_Buku besar indikasi (kode):"


def _ledger_line(facts: dict, r_tags: str) -> str:
    """The ledger's count written by code into the executive summary: the standing tags, and the rejected ones a Nexus
    count of the same ledger also holds (the 13 between 17.063 and 17.076 on 2026-10-28)."""
    gone = int(facts.get("tag_ditolak") or 0)
    return (f"{LEDGER_MARK} {_idn(facts['tag_total'])} tag indikasi aktif — kuat {_idn(facts['kuat'])}, sedang {_idn(facts['sedang'])}, "
            f"lemah {_idn(facts['lemah'])} [{r_tags}]" +
            (f"; {_idn(gone)} tag lain sudah ditolak manusia dan tidak dihitung (tipe Nexus Indikasi Fraud memuat "
             f"{_idn(facts['tag_total'] + gone)}, termasuk yang ditolak)" if gone else "") + "._")


def _ledger_into(sections: list[dict], line: str) -> list[dict]:
    """The ledger line at the end of the executive summary, once (a revision or the editor may have dropped or kept it)."""
    for s in sections:
        if s.get("id") == "ringkasan":
            body = "\n".join(x for x in (s.get("teks") or "").splitlines() if not x.startswith(LEDGER_MARK)).rstrip()
            s["teks"] = f"{body}\n\n{line}" if body else line
    return sections


def _ledger_report(report: str, line: str) -> str:
    """The same for a report written in one pass: after its executive summary, before the next heading."""
    report = "\n".join(x for x in report.splitlines() if not x.startswith(LEDGER_MARK))
    m = re.search(r"(?mi)^##\s*Ringkasan eksekutif.*$", report)
    if not m:
        return report
    nxt = re.search(r"(?m)^## ", report[m.end():])
    at = m.end() + nxt.start() if nxt else len(report)
    return report[:at].rstrip() + f"\n\n{line}\n\n" + report[at:].lstrip()


def _reconcile(items: list[dict], facts: dict, about: str) -> list[dict]:
    """A validator's "no" on the ledger's tag count that its own figure explains: the Nexus type of the ledger holds the
    tags people rejected too. On 2026-10-28 it counted 17.076 there against the summary's 17.063 standing tags (13
    rejected), and the revision would have written its figure into a right summary. Such a check is marked reconciled by
    code with both figures; nothing else changes."""
    total, gone = int(facts.get("tag_total") or 0), int(facts.get("tag_ditolak") or 0)
    if not gone:
        return items
    out = []
    for c in items:
        said, found = _numbers(str(c.get(about) or "")) | _numbers(str(c.get("bukti") or "")), _numbers(str(c.get("bukti") or ""))
        if c.get("ok") is False and str(total) in said and str(total + gone) in found:
            c = {**c, "ok": True, "rekonsiliasi": f"kode: {_idn(total + gone)} di tipe Nexus = {_idn(total)} tag aktif + {_idn(gone)} tag yang ditolak manusia; "
                                                  f"ringkasan memakai buku besar tanpa yang ditolak"}
        out.append(c)
    return out


def _tables(self: "Firm", kar: dict, cases: list[dict], r_box: str, r_cases: str) -> str:
    """The box and the audited cases as tables, from the data (the orchestrator's report never writes them)."""
    groups = (kar.get("ringkasan") or {}).get("kelompok") or {}
    lines = [f"## Box karantina (dari data [{r_box}])", "", "| Kelompok | Faskes | Estimasi kerugian | Batas bawah | Arti |", "|---|---:|---:|---:|---|"]
    for g, v in groups.items():
        lines.append(f"| {g} | {v['faskes']:,} | {_rp(v['kerugian_rp'])} | {_rp(v['batas_bawah_rp'] or 0)} | {v['arti']} |".replace(",", "."))
    lines += ["", f"## Kasus yang diaudit agen penyidik (dari data [{r_cases}])", ""]
    if cases:
        lines += ["| Faskes | Kelompok | Estimasi kerugian | T | S | M | Rekomendasi penyidik | Status |", "|---|---|---:|---|---|---|---|---|"]
        for c in cases:
            gate = f" (gerbang TSM; penyidik: {c.get('penyidik')})" if c.get("rekomendasi_oleh") == "gerbang_tsm" else ""
            lines.append(f"| {c['faskes']} | {c['kelompok']} | {_rp(c['kerugian_rp'])} | {c['tsm'].get('terstruktur')} | {c['tsm'].get('sistematis')} | "
                         f"{c['tsm'].get('masif')} | {c.get('rekomendasi') or '— (tidak ada)'}{gate} | {c['status']} |")
        lines.append("")
        lines.append("Rekomendasi adalah saran penyidik AI; jalur ditetapkan manusia di Box Karantina (dibina / ditindak bila TSM / dibebaskan).")
    else:
        lines.append("Tidak ada rekomendasi penyidik yang tercatat di penugasan ini.")
    return "\n".join(lines)


Firm.tables = _tables  # type: ignore[attr-defined]


async def engagement(inp: dict) -> None:
    await Firm(inp).engagement()
