"""The orchestration concept of AIP JKN (docs/Agent Orchestration Concept, 2026-10-22), shared by the question flow, the
missions and the fraud consultancy:

    orchestrator  plans the tasks, the milestones and the VALIDATION CONTRACT — what a correct result must satisfy —
                  before any worker starts
    workers       one task each, in a fresh context, driven by the skill the orchestrator assigned (aip/skills.py); each
                  hands off in one structure: what it did, what it left undone, the tool calls and how each ended, the
                  issues it found, and whether the skill's procedure was followed (checked by code, not claimed)
    validators    never see a worker's reasoning: the SCRUTINY validator is plain code (cited results exist, every task
                  has evidence, every scope of the plan is answered, the numbers come from results); the adversarial
                  validator, of another model family, re-reads the data as a user would and judges the contract
    learning      what the validators caught becomes a lesson of the skill involved (new task → execute → observe →
                  learn → encode skill), behind the gate of aip/skills.py

Workers run side by side only where they cannot conflict — they read, and their writes are notes to an idempotent
ledger or proposals for people; milestones run one after another. No agent talks to another directly: they share state
(the plan, the contract, the handoffs, the ledger), which keeps a long run coherent.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Optional

from aip.adk_runtime.platform import emit

HANDOFF_ASK = """Akhiri jawaban Anda dengan SATU baris serah-terima untuk orkestrator, validator dan agen berikutnya (JSON di baris itu):
SERAH-TERIMA {"dikerjakan": ["<yang selesai, dengan angka kunci>"], "belum": ["<yang tidak sempat atau tidak bisa dikerjakan>"], "masalah": ["<kendala data atau tool yang ditemukan>"]}"""
MARK = "SERAH-TERIMA"


def skill_of(skills: list[dict] | dict, key: str) -> Optional[dict]:
    pool = skills.values() if isinstance(skills, dict) else skills
    return next((s for s in pool if s.get("key") == key), None)


def skill_block(skills: list[dict] | dict, key: str) -> str:
    """The skill as the worker reads it: its procedure, the lessons earlier runs taught it, and what it hands off."""
    s = skill_of(skills, key)
    if not s:
        return ""
    steps = "\n".join(f"{i}. {x}" for i, x in enumerate(s.get("langkah") or [], 1))
    learned = "\n".join(f"- {x}" for x in s.get("pelajaran") or [])
    return (f"SKILL {s['nama']} (v{s.get('versi', '-')}) — {s.get('untuk', '')}\nLangkah:\n{steps}"
            + (f"\nPelajaran dari run sebelumnya (wajib diperhatikan):\n{learned}" if learned else "")
            + (f"\nSerahkan: {s['keluaran']}" if s.get("keluaran") else ""))


def skills_menu(skills: list[dict], flow: str) -> str:
    return "\n".join(f"- {s['key']}: {s['nama']} — {s['untuk']}" + (f" (agen: {', '.join(s['agen'])})" if s.get("agen") else "")
                     for s in skills if s.get("alur") == flow)


def split_handoff(text: str) -> tuple[str, dict]:
    """(the report without its handoff line, what the worker declared in it)."""
    t = text or ""
    i = t.rfind(MARK)
    if i < 0:
        return t.strip(), {}
    from aip.adk_runtime.agents import parse_json

    try:
        declared = parse_json(t[i + len(MARK):])
    except ValueError:
        declared = {}
    lst = lambda k: [str(x)[:400] for x in (declared.get(k) or []) if str(x).strip()][:8] if isinstance(declared.get(k), list) else []  # noqa: E731
    return t[:i].rstrip(), {"dikerjakan": lst("dikerjakan"), "belum": lst("belum"), "masalah": lst("masalah")}


def procedures(skill: Optional[dict], receipts: list[dict]) -> dict:
    """Whether the skill's procedure was followed, from what the tools record (not from what the agent says)."""
    used_ok = {r["tool"] for r in receipts if r.get("ok") and not str(r.get("summary", "")).startswith("batas ")}
    checks = [{"prosedur": "setiap angka diambil dengan tool (ada panggilan yang berhasil)", "ok": bool(used_ok)}]
    for group in (skill or {}).get("wajib") or []:
        checks.append({"prosedur": f"memakai {' / '.join(group)}", "ok": any(g in used_ok for g in group)})
    failed = [r for r in receipts if not r.get("ok")]
    if receipts:
        checks.append({"prosedur": "panggilan tool yang gagal ditangani (<= 1/3 gagal)", "ok": len(failed) * 3 <= len(receipts)})
    return {"ok": all(c["ok"] for c in checks), "cek": checks}


def handoff(agent: str, text: str, receipts: list[dict], skill: Optional[dict] = None, task: str = "", stopped: str = "") -> tuple[str, dict]:
    """(the report, the structured handoff of one worker): the same fields in every flow (as the missions' handoffs)."""
    report, declared = split_handoff(text)
    queries = [{"tool": r["tool"], "ok": bool(r.get("ok")), "rows": r.get("rows"), "rid": r.get("rid"), "ms": r.get("ms"),
                "ringkasan": str(r.get("summary") or "")[:200]} for r in receipts]
    done = declared.get("dikerjakan") or [f"{q['tool']}: {q['ringkasan']}" for q in queries if q["ok"] and q["ringkasan"]][-6:]
    undone = (declared.get("belum") or []) + ([stopped] if stopped else [])
    issues = (declared.get("masalah") or []) + [f"{q['tool']} gagal: {q['ringkasan']}" for q in queries if not q["ok"]][:6]
    h = {"agent": agent, "task": task[:300], "skill": (skill or {}).get("key"), "implemented": done, "left_undone": undone,
         "queries_run": queries, "issues_found": issues, "procedures_followed": procedures(skill, receipts),
         "results": [q["rid"] for q in queries if q["rid"]], "dinyatakan_agen": bool(declared)}
    return report, h


def emit_handoff(h: dict) -> None:
    emit({"type": "handoff", "agent": h["agent"], "handoff": h})


# ------------------------------------------------------------------------------------------------ the scrutiny validator


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


_NUM = re.compile(r"(?<![\w.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(?![\w])")


def numbers(text: str) -> set[str]:
    """The numbers of a text in a canonical form (Indonesian notation: 1.093 = 1093, 0,85 = 0.85)."""
    out = set()
    for m in _NUM.finditer(text or ""):
        whole = m.group(1).replace(".", "")
        out.add(f"{int(whole)}" + (f".{m.group(2).rstrip('0')}" if m.group(2) and m.group(2).rstrip("0") else ""))
    return out


def _result_numbers(rows: dict[str, list[dict]]) -> set[str]:
    out: set[str] = set()
    for rs in rows.values():
        for r in rs:
            for v in r.values():
                if isinstance(v, bool):
                    continue
                if isinstance(v, int):
                    out.add(str(v))
                elif isinstance(v, float):
                    out.add(str(int(v)) if float(v).is_integer() else f"{v:.10g}")
                    out.add(f"{round(v, 2):g}")
                    out.add(f"{round(v, 1):g}")
                    out.add(str(round(v)))
                if isinstance(v, (int, float)) and abs(v) >= 1e6:  # rupiah as an answer writes it: 153,98 juta, 1,2 miliar
                    for scale in (1e6, 1e9):
                        out.update({f"{round(v / scale, 1):g}", f"{round(v / scale, 2):g}"})
    return out


def scrutiny(answer: str, tasks: list[dict], handoffs: dict[str, dict], results: list[dict], rows: dict[str, list[dict]], question: str = "",
             quoted: str = "") -> list[dict]:
    """The scrutiny validator: plain code, run before the adversarial one. A blocking check that fails sends the answer
    back for revision; the numbers check only points the adversarial validator at what it should re-count. quoted: text
    the answer may repeat figures from (the consultancy's findings in an audit pack)."""
    out = []
    known = {r["rid"] for r in results}
    cited = set(re.findall(r"\br\d+\b", answer or ""))
    missing = sorted(cited - known, key=lambda x: int(x[1:]))
    out.append({"klaim": "setiap rujukan [rN] di jawaban adalah hasil run ini", "ok": not missing, "blok": True,
                "bukti": f"{len(cited)} rujukan" + (f"; tidak ada: {', '.join(missing)}" if missing else "")})
    bare = [t.get("cakupan") or t.get("agen") for t in tasks if not any(q["ok"] for q in (handoffs.get(t.get("kunci") or t.get("agen")) or {}).get("queries_run") or [])]
    out.append({"klaim": "setiap tugas rencana punya bukti dari tool", "ok": not bare, "blok": False,
                "bukti": f"{len(tasks) - len(bare)}/{len(tasks)} tugas" + (f"; tanpa bukti: {', '.join(map(str, bare))}" if bare else "")})
    text = _fold(answer)
    scopes = [t["cakupan"] for t in tasks if (t.get("cakupan") or "").strip()]
    # a scope is the entity a task covered (JAWA BARAT, Kelas A): the answer must name it. Planners also write descriptions
    # ("Ketersediaan data dokter terlibat di SULAWESI SELATAN"); of those only the entity in capitals is required, and a
    # description without one is the validator's to judge — the words of a task need not be repeated (false blocks cost
    # 124–158 s revisions, 2026-10-23)
    def needed(c: str) -> list[str]:
        c = re.sub(r"\(.*?\)", "", c)
        caps = re.findall(r"\b[A-Z][A-Z/&.-]{2,}(?:\s+[A-Z][A-Z/&.-]{1,})*\b", c)
        if caps:
            return [w for cap in caps for w in _fold(cap).split()]
        head = re.split(r"\s[—–-]\s|:", c)[0].split()
        return _fold(" ".join(head)).split() if len(head) <= 3 else []
    absent = [c for c in scopes if not all(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", text) for w in needed(c))]  # whole words: "b" is not in "sebab"
    if scopes:
        out.append({"klaim": "setiap cakupan rencana dijawab", "ok": not absent, "blok": True,
                    "bukti": f"{len(scopes) - len(absent)}/{len(scopes)} cakupan disebut" + (f"; tidak disebut: {', '.join(absent)}" if absent else "")})
    said = {n for n in numbers(answer) if len(n.split(".")[0]) >= 3 and not re.fullmatch(r"20[0-3]\d", n)}  # counts, rupiah; not years
    found = _result_numbers(rows) | numbers(question) | numbers(quoted)
    unsourced = sorted(said - found)
    out.append({"klaim": "angka di jawaban ada di hasil tool", "ok": len(unsourced) <= max(1, len(said) // 5), "blok": False,
                "bukti": f"{len(said) - len(unsourced)}/{len(said)} angka ditemukan di hasil" +
                         (f"; tidak ditemukan (hitungan turunan atau keliru): {', '.join(unsourced[:10])}" if unsourced else ""),
                "angka_tidak_ditemukan": unsourced[:20]})
    return out


# ------------------------------------------------------------------------------------------------ plain words, same numbers

# a number with what follows it: 4,79 miliar, 0,1%, 551×, 12 kali
_VALUE = re.compile(r"(?<![\w.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(?:\s*(%|persen|×|x(?![a-z])|kali|ribu|rb|juta|jt|miliar|m(?![a-z])|triliun|t(?![a-z])))?",
                    re.I)
_SCALE = {"ribu": 1e3, "rb": 1e3, "juta": 1e6, "jt": 1e6, "miliar": 1e9, "m": 1e9, "triliun": 1e12, "t": 1e12}
# a number as one token that a match never splits ("10.000" is not "1" and "0.000": a live run's sentence was dropped so)
_N = r"(?>\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)"
# "6 dari setiap 100.000", "6 klaim dari setiap 100.000 klaim rumah sakit" (a date after "dari" is no denominator)
_PER = re.compile(rf"({_N})\s+(?:[a-z/-]+\s+){{0,2}}?(?:dari|per|di antara)\s+(?:setiap\s+|tiap\s+)?({_N})(?![-/]\d)(?:\s*(ribu|juta))?", re.I)
# the other order: "dari setiap 100 klaim yang ditandai model, sekitar 3 …"
_PER_FIRST = re.compile(rf"(?:dari|per)\s+(?:setiap|tiap)\s+({_N})(?:\s*(ribu|juta))?[^.;:\d]{{0,80}}?({_N})", re.I)
_TIMES = re.compile(r"(\d[\d.,]*)\s*(?:×|x(?![a-z])|kali)", re.I)
# a code (INA-CBG Q-5-44-0, ICD-10 J18.9, COVID-19) or a month (2024-05) is one token, not its digits: a live run's
# commentary lost every sentence naming a code ("angka 0 tidak ada", the 0 of Q-5-44-0), 2026-10-28
_CODE = re.compile(r"(?<![\w.-])[A-Z][A-Z0-9]*(?:[-.][A-Z0-9]+)+(?![\w-])")
_DATE = re.compile(r"(?<![\w.-])\d{4}-\d{2}(?:-\d{2})?(?![\w-])")
_YEAR = re.compile(r"(?:19|20)\d\d")


def _num(s: str) -> float:
    whole, _, frac = s.partition(",")
    return float(whole.replace(".", "") + (f".{frac}" if frac else ""))


def _values(text: str, shares_only: bool = False) -> list[float]:
    """Every number of a text as the values it can stand for: as written, scaled by its unit (4,79 miliar → 4.79e9),
    and a percentage also as a share (0,1% → 0.001). shares_only: the rates and shares alone — a percentage as its share,
    a decimal below 1 written as such (AUPRC 0,086) — not a percentage's written number."""
    out: list[float] = []
    for m in _VALUE.finditer(text or ""):
        v = _num(m.group(1) + (f",{m.group(2)}" if m.group(2) else ""))
        unit = (m.group(3) or "").lower()
        pct = unit in ("%", "persen")
        if shares_only:
            out += [v / 100] if pct else [v] if 0 < v < 1 and not unit else []
            continue
        out.append(v)
        if unit in _SCALE:
            out.append(v * _SCALE[unit])
        if pct:
            out.append(v / 100)
    return out


def _near(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol * max(abs(a), abs(b), 1e-12)


def _pairs(text: str) -> list[tuple[re.Match, float, float]]:
    """Every "x dari/per n" of a text, either order: (its match, x, n)."""
    out = [(m, _num(m.group(1)), _num(m.group(2)) * _SCALE.get((m.group(3) or "").lower(), 1)) for m in _PER.finditer(text)]
    out += [(m, _num(m.group(3)), _num(m.group(1)) * _SCALE.get((m.group(2) or "").lower(), 1)) for m in _PER_FIRST.finditer(text)
            if not any(p.start() <= m.start() < p.end() or m.start() <= p.start() < m.end() for p, _, _ in out)]
    return out


def plain_check(text: str, source: str) -> str:
    """Why a plain-language sentence cannot be shown (a number it adds), or "". Each number must be one the source says
    (rounded within 5%: "sekitar"), or a reading of one that code recomputes: "6 dari setiap 100.000 klaim" is a share
    the source gives (within 15%: small counts round coarsely) or its own "x dari n" ("2 dari 4", "0 dari 30"), "12 kali
    lipat" is a multiple it gives or the ratio of two of its rates or shares (within 5%). A code or a month the source
    names is a word, not numbers. List numbering is not a number; a year the source does not name is one, and fails —
    exactly (2023 is not 2024 rounded)."""
    codes, dates = set(_CODE.findall(source or "")), set(_DATE.findall(source or ""))
    source = _CODE.sub("§", source or "")
    src = _values(source)
    given = [(x, n) for _, x, n in _pairs(source) if n]
    rates = {x / n for x, n in given if 0 < x < n and n.is_integer() and re.fullmatch(r"10+", f"{n:.0f}")}  # "3,30 per 1.000": a share it says too
    shares = sorted(set(v for v in _values(source, shares_only=True) if 0 < v < 1) | rates)
    t = re.sub(r"(?m)^\s*\d+[.)]\s", "", text or "")
    t = _CODE.sub(lambda m: "§" if m.group(0) in codes else m.group(0), t)
    t = _DATE.sub(lambda m: "§" if m.group(0) in dates else m.group(0), t)
    # the same digits at another magnitude: Indonesian "1.447" (thousands) read as "1,447" (a 2026-10-24 run wrote
    # "1,447×" for 1.447× above chance, explained as "1,45 kali") — a misreading, not a rounding
    written = {}
    for m in _VALUE.finditer(source or ""):
        written.setdefault(re.sub(r"\D", "", m.group(1) + (m.group(2) or "")), set()).add(_num(m.group(1) + (f",{m.group(2)}" if m.group(2) else "")))
    for m in _VALUE.finditer(t):
        v = _num(m.group(1) + (f",{m.group(2)}" if m.group(2) else ""))
        same = written.get(re.sub(r"\D", "", m.group(1) + (m.group(2) or "")), set())
        if v and same and all(max(v, s) / min(v, s) >= 10 for s in same if s):
            return f"angka {m.group(0).strip()} salah baca: di structuring angka yang sama bernilai {', '.join(f'{s:g}' for s in sorted(same))} (titik = ribuan, koma = desimal)"
    used: set[tuple[int, int]] = set()
    for m, x, n in _pairs(t):
        if n and (any(_near(x / n, s, 0.15) for s in shares) or any(_near(x, a, 0.05) and _near(n, b, 0.05) for a, b in given)):
            used.add(m.span())
        else:
            return f"\"{m.group(0).strip()}\" bukan porsi yang disebut structuring"
    for m in _TIMES.finditer(t):
        if any(a <= m.start() < b for a, b in used):
            continue
        k = _num(m.group(1))
        # a multiple recomputed from two rates or shares (0,071% vs 0,006%; AUPRC vs the share of positives): ratios of any
        # two numbers would cover nearly every value (a test's invented "40 kali" passed that way)
        if any(_near(k, s, 0.05) for s in src) or (k >= 2 and any(_near(k, a / b, 0.05) for a in shares for b in shares if a > b)):
            used.add(m.span())
        else:
            return f"\"{m.group(0)}\" bukan kelipatan yang disebut atau terhitung dari structuring"
    for m in _VALUE.finditer(t):
        if any(a <= m.start() < b for a, b in used):
            continue
        vals = _values(m.group(0))
        year = not m.group(2) and not m.group(3) and _YEAR.fullmatch(m.group(1))
        if not any(v == s if year else _near(v, s, 0.05) for v in vals for s in src):
            return f"angka {m.group(0).strip()} tidak ada di structuring"
    return ""


def emit_scrutiny(checks: list[dict], milestone: str = "") -> None:
    failed = [c for c in checks if not c["ok"]]
    emit({"type": "verdict", "validator": "scrutiny", "model": "kode (deterministik)", "milestone": milestone or None, "checks": checks,
          "passed": len(checks) - len(failed), "total": len(checks)})


def as_text(x: Any) -> str:
    """What an agent wrote, as text: a validator sometimes answers its evidence as an object or a list
    ({ukuran, nilai_total, hasil_id}; [{kelompok, nilai}] — engagement 4), which the page cannot show as it is."""
    if x is None:
        return ""
    if isinstance(x, str):
        return x
    if isinstance(x, (list, tuple)):
        return "; ".join(as_text(v) for v in x)
    if isinstance(x, dict):
        return ", ".join(f"{k}: {as_text(v)}" for k, v in x.items())
    return str(x)


def clean_checks(items: Any) -> list[dict]:
    """A verdict's checks as the page and the next stage read them: dicts only, the claim and its evidence as text."""
    return [{**c, "klaim": as_text(c.get("klaim"))[:600], "bukti": as_text(c.get("bukti"))[:900]} for c in (items or []) if isinstance(c, dict)]


def contract_text(contract: list[dict]) -> str:
    return "\n".join(f"- {c['id']}: {c['teks']}" for c in contract)


def contract_of(raw: Any, prefix: str = "k", limit: int = 10) -> list[dict]:
    items = [str(x.get("teks") or x.get("text") or x) if isinstance(x, dict) else str(x) for x in (raw or []) if str(x).strip()]
    return [{"id": f"{prefix}{i}", "teks": t[:300]} for i, t in enumerate(items[:limit], 1)]


_ASKS_WIDE = re.compile(r"nasional|seluruh|semua|indonesia|bandingkan|dibanding", re.I)
_WIDE = re.compile(r"\bnasional\b|seluruh (?:faskes|klaim|provinsi)", re.I)


def drill(question: str, tasks: list[dict], pledged: Any) -> tuple[list[dict], list, int]:
    """A follow-up drills into the set the conversation is on: national tasks and contract lines the question did not ask
    for are dropped (a follow-up's plan added the national loss of every facility as its "comparator" and required it in
    the contract; the answer led with it, 2026-10-24). Returns the tasks, the contract lines, and how many tasks went."""
    if _ASKS_WIDE.search(question):
        return tasks, pledged, 0
    narrow = [t for t in tasks if not _WIDE.search(f"{t.get('cakupan') or ''} {t.get('instruksi') or ''}")]
    kept = narrow if narrow and len(narrow) < len(tasks) else tasks
    return kept, [c for c in pledged or [] if not _WIDE.search(str(c))], len(tasks) - len(kept)


# ------------------------------------------------------------------------------------------------ learning


LEARN = """Anda Orkestrator AIP JKN, menutup sebuah run. Validator menemukan hal-hal berikut. Tulis PELAJARAN untuk skill yang
dipakai agar run berikutnya tidak mengulanginya: paling banyak 2 pelajaran, masing-masing satu kalimat umum (20–250 karakter)
yang bisa dipakai lagi — cara kerja, bukan angka atau nama objek run ini; tanpa tautan; tanpa perintah mengubah data.
Bila tidak ada yang layak dipelajari, kembalikan daftar kosong.
Skill yang dipakai: {skills}
Temuan validator dan kendala:
{issues}
Jawab HANYA JSON: {{"pelajaran": [{{"skill": "<key skill>", "teks": "<pelajaran>"}}]}}"""


def issues_for_learning(checks: list[dict], handoffs: list[dict]) -> list[str]:
    out = [f"validator: {c.get('klaim')} → {c.get('bukti')}" for c in checks if not c.get("ok")]
    for h in handoffs:
        out += [f"{h['agent']} ({h.get('skill')}): {x}" for x in (h.get("issues_found") or [])[:3]]
        out += [f"{h['agent']} ({h.get('skill')}): prosedur tidak diikuti — {c['prosedur']}" for c in h["procedures_followed"]["cek"] if not c["ok"]]
    return out[:30]


async def encode_lessons(stage, service, m, model: str, run_id: str, platform, skills_used: list[str], issues: list[str]) -> list[dict]:
    """The learning step: a lesson per skill from what the validators caught, kept only if aip/skills.py's gate allows it."""
    from google.adk.agents import LlmAgent

    from aip.adk_runtime import agents as A

    used = sorted({s for s in skills_used if s})
    if not issues or not used:
        return []
    agent = LlmAgent(name="orkestrator_belajar", model=m.llm(model, "orkestrator", 800), output_key="pelajaran",
                     instruction=A._const(LEARN.format(skills=", ".join(used), issues="\n".join(f"- {x}" for x in issues))))
    try:
        st = await stage(service, agent, "Tulis pelajaran.", 2)
        items = [x for x in A.parse_json(st.get("pelajaran", "")).get("pelajaran") or [] if isinstance(x, dict)]
    except Exception as e:  # noqa: BLE001 - learning never fails a run
        emit({"type": "error", "agent": "orkestrator", "message": f"pelajaran tidak tertulis: {type(e).__name__}"})
        return []
    kept = []
    for x in items[:2]:
        if x.get("skill") not in used:
            continue
        try:
            rec = platform.post("/api/aip/skills/pelajaran", {"skill": x["skill"], "teks": str(x.get("teks") or "")[:300], "run_id": run_id,
                                                              "sumber": "; ".join(issues[:3])[:200]})
            kept.append(rec)
            emit({"type": "pelajaran", "skill": rec["skill"], "teks": rec["teks"], "status": rec["status"], "id": rec["id"]})
        except Exception as e:  # noqa: BLE001 - the gate refused it (duplicate, too long …): said, not fatal
            emit({"type": "pelajaran_ditolak", "skill": x.get("skill"), "teks": str(x.get("teks") or "")[:300], "alasan": str(e)[:200]})
    return kept
