"""AIP Operator: the Agen tab of AIP JKN as one assistant that works across every app of the page through tools, like the
operator of Palantir AIP (the user, 2026-10-28: "kayak Palantir AIP bisa tool calling ke informasi yg ada di" AI Agent Swarm,
Agen, ML Studio, Box Karantina, Pipeline Produksi, Evaluasi & Kontrol, Keamanan & Akses, Nexus · Object Explorer, Data
Lineage, Pipeline Builder — "sama UI nya juga enak").

One agent on the tools model reads each app's API as the user (the run's job token): no planner, no domain agents, an
answer in seconds. A new analysis no app holds goes to the agents' full pipeline (analisis_agen: a child "ask" run, its
progress streamed into this one). Opening an app on the user's screen is a tool too (buka_aplikasi → a "nav" event the
page follows). Every number of the answer is checked by code against what the tools returned (orkestrasi.plain_check);
one revision when one is not there, and the page says which numbers stayed unconfirmed.

Started by aip/runs.py as its own module (kind "operator"): the input as JSON on stdin, events as JSON lines on stdout,
like aip.adk_runtime.main.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import litellm
from google.adk.agents import LlmAgent
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.agents.run_config import RunConfig, ToolThreadPoolConfig
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from aip.adk_runtime import agents as A
from aip.adk_runtime import orkestrasi as O
from aip.adk_runtime import tools as T
from aip.adk_runtime.platform import Platform, emit

APP = "aip_jkn"
AGENT = "operator"
STEPS = 14  # tool calls a turn may make (the revision included): a hard stop, then the answer comes from what was read
CALLS = 22  # model calls a turn may make: the steps, the answer, a revision
SUB_WAIT = 420  # seconds analisis_agen follows its child run before it stops waiting (the run goes on, linked)
# no time cut on the work: an 18-second cut (2026-10-29) stopped a turn whose first model call took 18 s before it read anything,
# and the answer said the data was not there (the user: "ga usah gini juga jadinya ga return answer apa2"); STEPS and CALLS bound it
HANG_SECONDS = 300  # only a hung turn (a tool or model call that never returns) is stopped, after this long
TOOL_GRACE = 12  # a read still running when a hung turn is stopped is waited for this long
REVISION_SECONDS = 90  # the number revision runs whenever the gate finds a number; a model call that hangs leaves the first answer
_RUNNING: dict[str, int] = {}  # the reads under way: tool → how many (a cut turn waits for them, the writer is told of the rest)
_RUNNING_LOCK = threading.Lock()
TOOL_THREADS = 4  # the tools one model answer asks for run side by side (two reads of 3 s each took 6 s one after the other)
# the operator's own model, when it should differ from the tools role's (None: the role's). Tried 2026-10-29 at the user's "ok do it":
# DeepSeek-V4.1-Flash spent 166 s of model time on ten questions where GLM-5.2 spent 101 s (spikes of 55 s), so the role's GLM-5.2
# stays; when GLM-5.2 (Preview on Vertex, guaranteed through 2026-10-31) goes, the gateway's failover answers with another family
# then (the user, same day, after a Vertex vs OpenRouter measurement: "ok pake openrouter aja"): GLM-5.2 on OpenRouter — the gateway
# routes it with the platform's key and falls back to Vertex's GLM-5.2 when OpenRouter does not answer
OPERATOR_MODEL: str | None = A.aip_models.OR_GLM
litellm.suppress_debug_info = True

# the tabs of the page (web/src/app/aip-jkn/page.tsx) and the words a model may use for them
TABS = {"konsultan": "AI Agent Swarm", "agents": "Agen", "ml": "ML Studio", "karantina": "Box Karantina", "kontrol": "Evaluasi Swarm",
        "akses": "Keamanan & Akses", "objects": "Nexus · Object Explorer", "lineage": "Data Lineage", "pipeline": "Pipeline Builder"}
ALIAS = {"swarm": "konsultan", "ai agent swarm": "konsultan", "agen": "agents", "ml studio": "ml", "box": "karantina", "box karantina": "karantina",
         "aturan": "karantina", "aturan indikasi": "karantina", "evaluasi": "kontrol", "kontrol": "kontrol", "evaluasi swarm": "kontrol", "evaluasi & kontrol": "kontrol",
         "akses": "akses", "keamanan": "akses", "keamanan & akses": "akses", "objek": "objects", "nexus": "objects", "object explorer": "objects",
         "lineage": "lineage", "data lineage": "lineage", "pipeline": "pipeline", "pipeline builder": "pipeline"}

WIB = timezone(timedelta(hours=7))
# words of a facility's written name that do not tell it apart (its kind, owner, region level)
_GENERIC = {"rumah", "sakit", "fkrtl", "pemprov", "pemkab", "pemkot", "pemerintah", "provinsi", "kota", "kab", "kabupaten", "swasta",
            "vertikal", "setara", "type", "tipe", "kelas", "klinik", "utama", "faskes", "dan", "the"}


def _wib(iso: Any) -> str:
    """A time of the API (UTC) as the page shows it: "2026-10-28 18:15 WIB" — the answer repeats what the tool said."""
    if not iso:
        return ""
    s = str(iso)
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return s
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(WIB).strftime("%Y-%m-%d %H:%M WIB")


def _num(v: Any) -> Any:
    """A float the model reads: a few decimals, not 17 (0.9741525212408779 → 0.9742)."""
    if isinstance(v, float):
        return round(v, 4) if abs(v) < 100 else round(v, 1)
    return v


def _pick(d: dict, *keys: str) -> dict:
    return {k: _num(d.get(k)) for k in keys if d.get(k) not in (None, "", [], {})}


def _match(text: Any, want: str) -> bool:
    return want.lower() in str(text or "").lower()


# ------------------------------------------------------------------------------------------------ the number check


def _id_text(x: Any) -> str:
    """What the tools returned, as text in Indonesian notation (1.386; 0,0899; Rp in full), for orkestrasi.plain_check."""
    if isinstance(x, bool) or x is None:
        return str(x)
    if isinstance(x, int):
        return f"{x:,}".replace(",", ".")
    if isinstance(x, float):
        if x.is_integer() and abs(x) < 1e15:
            return f"{int(x):,}".replace(",", ".")
        s = f"{x:,.2f}" if abs(x) >= 1000 else f"{x:.6f}".rstrip("0").rstrip(".")
        if 0 < abs(x) < 0.001:  # a tiny share as the model may copy it too: 5,95e-05 (its digits, not 0,00006)
            s += f" {x:.3g}"
        return s.replace(",", "_").replace(".", ",").replace("_", ".")
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        return "; ".join(f"{k}: {_id_text(v)}" for k, v in x.items())
    if isinstance(x, (list, tuple)):
        return " | ".join(_id_text(v) for v in x)
    return str(x)


_CITE = re.compile(r"\[r\d+(?:\s*,\s*r\d+)*\]")
# an engagement's own references in its report ("[r566]", "[r1443, r1445]"): results of that run, not of this one
_REFS = re.compile(r"\s*\[r\d+(?:\s*,\s*r\d+)*\]")


def own_citations(text: str, known: set[str]) -> str:
    """Citations of results this run made, the others dropped (the model copied the report's [r1443])."""
    def keep(m: re.Match) -> str:
        ids = [x.strip() for x in m.group(2).split(",") if x.strip() in known]
        return f"{m.group(1)}[{', '.join(ids)}]" if ids else ""
    return re.sub(r"(\s*)\[(r\d+(?:\s*,\s*r\d+)*)\]", keep, text or "")
# names with a number in them, not figures: "readmisi 30 hari" (the definition), "presisi top 0,1%" (a metric)
_TERMS = re.compile(r"(?i)\b(?:readmisi|kunjungan ulang)\s*(?:≤|<=|<)?\s*30\s*hari\b|\b30\s*hari\s+readmisi\b|\btop[\s_]*0?[,.]?\d+\s*%")
_WORDS = {"satu": 1, "dua": 2, "tiga": 3, "empat": 4, "lima": 5, "enam": 6, "tujuh": 7, "delapan": 8, "sembilan": 9, "sepuluh": 10,
          "sebelas": 11, "dua belas": 12}
_SMALL = re.compile(r"(?<![\w.,$])(\d{1,2}|" + "|".join(sorted(_WORDS, key=len, reverse=True)) + r")(?![\w.,%]|\s*(?:%|persen|juta|miliar|ribu))", re.I)


def table_counts(answer: str) -> list[str]:
    """A count said just before a table that the table does not have: "Empat peran …" above six rows (2026-10-28). Small
    counts are in nearly every tool result, so the number check passes them; the table beside them does not."""
    lines = (answer or "").splitlines()
    fails: list[str] = []
    i = 0
    while i < len(lines):
        if not lines[i].lstrip().startswith("|"):
            i += 1
            continue
        j = i
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            j += 1
        body = [x for x in lines[i + 2:j] if not re.match(r"^\|\s*(?:\*\*)?(?:total|jumlah)\b", x.strip(), re.I)]
        before = next((lines[k] for k in range(i - 1, -1, -1) if lines[k].strip()), "")
        clean = _CITE.sub("", O._CODE.sub("§", before))
        said = list(_SMALL.finditer(clean))
        # a count of what the table's rows are: the word after the number names the table's first columns ("Empat peran" over
        # "| Peran | Akun |"); "masing-masing 3 fitur" over a table of methods, or "50 properti — sebagian:" is no such count
        cells = [c.strip().strip("*").lower() for c in lines[i].strip().strip("|").split("|")]
        head = next((c for c in cells if c and c not in ("#", "no", "no.")), "")  # the column that names the rows
        if len(body) >= 2 and len(said) == 1:
            m = said[0]
            noun = (re.match(r"\s*\**\s*([a-zA-Z]{4,})", clean[m.end():]) or [None, ""])[1].lower()
            n = int(m.group(1)) if m.group(1).isdigit() else _WORDS[m.group(1).lower()]
            if noun and noun[:5] in head and n != len(body):
                fails.append(f"kalimat sebelum tabel menyebut {m.group(1)} {noun}, tabel berisi {len(body)} baris")
        i = j
    return fails


def check_numbers(answer: str, source: str) -> tuple[int, list[str]]:
    """How many numbers the answer states, and why each one that is not in what the tools returned fails (empty: all
    found). plain_check names the first failing number; it is masked and the check runs again, so every one is listed."""
    t = _CITE.sub("", answer or "")
    t = re.sub(r"(?m)^\s*\d+[.)]\s", "", t)
    t = re.sub(r"(?m)^(\|\s*)#?\d{1,3}(\s*\|)", r"\1§\2", t)  # a table's row number is numbering, not a figure
    t = O._CODE.sub("§", t)  # a code (ICD-10, O-6-10-I, GLM-5.2) is a name, not a figure
    t = _TERMS.sub("§", t)
    n = sum(1 for m in O._VALUE.finditer(O._CODE.sub("§", O._DATE.sub("§", t))))
    fails: list[str] = table_counts(answer)
    known: list[float] | None = None
    for _ in range(25):
        why = O.plain_check(t, source)
        if not why:
            break
        m = re.match(r'^angka (.+?) (?:salah baca|tidak ada)', why) or re.match(r'^"(.+?)"', why)
        if not m:
            fails.append(why.replace("di structuring", "di hasil tool").replace("structuring", "hasil tool"))
            break
        # "salah baca" guards 1.447 read as 1,447; a value the tools did return is no misreading ("p 1,0" beside a "10"
        # elsewhere; "100%" for a share of 1)
        if "salah baca" in why or "bukan porsi" in why:
            known = known if known is not None else O._values(O._CODE.sub("§", source))
            # "192 tool gagal dari 2.120": both read values, not a share the model worked out
            vals = O._values(m.group(1)) if "salah baca" in why else [O._num(x) for x in re.findall(r"\d[\d.]*(?:,\d+)?", m.group(1))]
            ok = any if "salah baca" in why else all
            if vals and ok(any(O._near(v, s, 0.05) for s in known) for v in vals):
                why = ""
        if why:
            fails.append(why.replace("di structuring", "di hasil tool").replace("structuring", "hasil tool"))
        # masked as a whole number: a bare "5" must not cut "622.521.550" into two figures that then fail too
        whole = re.compile(r"(?<![\w.,])" + re.escape(m.group(1)) + r"(?![\w]|[.,]\d)")
        if not whole.search(t):
            break
        t = whole.sub("§", t, count=1)
    return n, fails


_APP_WORDS = r"(ai agent swarm|swarm|box karantina|karantina|aturan indikasi|ml studio|evaluasi swarm|keamanan (?:&|dan) akses|object explorer|nexus|data lineage|lineage|pipeline builder|pipeline)"
_OPEN = re.compile(r"\b(?:buka|bukakan|tampilkan|tunjukkan|perlihatkan)\b[^.?!\n]{0,60}?\b(?:di|ke|pada)\s+" + _APP_WORDS
                   + r"|\b(?:buka|bukakan)\s+" + _APP_WORDS, re.I)


def asked_to_open(q: str) -> str | None:
    """The tab a question explicitly asks to open ("… Buka di Data Lineage."), or None."""
    m = _OPEN.search(q or "")
    if not m:
        return None
    words = (m.group(1) or m.group(2) or "").lower().replace(" dan ", " & ")
    return words if words in TABS else ALIAS.get(words) or ("objects" if words == "object explorer" else None)


def opened_target(tab: str, receipts: list[dict]) -> dict:
    """Where in `tab` a turn's reads point: the lineage node it traced, the facility, the type, the pipeline it read."""
    for r in reversed(receipts):
        buka = r.get("buka") or {}
        if tab == "karantina" and buka.get("faskes"):
            return {"faskes": buka["faskes"]}
        if tab == "pipeline" and buka.get("pipeline"):
            return {"pipeline": buka["pipeline"]}
        for link in r.get("links") or []:
            if tab == "lineage" and link.get("app") == "lineage" and link.get("node_id"):
                return {"node_id": link["node_id"], "node": link.get("node")}
            if tab == "objects" and link.get("app") in ("objects", "object") and link.get("type_id"):
                return {"type_id": link["type_id"], "type": link.get("type")}
    return {}


def _split(text: str) -> tuple[str, list[str]]:
    """The answer and its suggested next steps (its last line "SARAN: a | b | c")."""
    lines = (text or "").rstrip().splitlines()
    for i in range(len(lines) - 1, max(-1, len(lines) - 4), -1):
        m = re.match(r"^\s*[*_>-]*\s*(?:SARAN|Saran|Langkah berikutnya)\s*[*_]*\s*:\s*[*_]*\s*(.+)$", lines[i])
        if m:
            steps = [s.strip(" -*_\"'") for s in re.split(r"\s*\|\s*", m.group(1)) if s.strip(" -*_\"'")]
            return "\n".join(lines[:i] + lines[i + 1:]).strip(), steps[:3]
    return "\n".join(lines).strip(), []


# ------------------------------------------------------------------------------------------------ the tools, one app each


def app_tools(box: T.Toolbox, cat: dict, follow: str | None = None) -> list[Callable]:
    """The operator's own tools: one read of each app's API (as the user), every read a result of the run (hasil_id).
    follow: the turn this one follows (its rows help name what the conversation already found)."""
    p = box.p
    cache: dict[str, Any] = {}
    prior: list[dict] = []
    prior_read = False

    def prior_rows() -> list[dict]:
        """The rows of the earlier turns' results that carry a facility id, read once, at the first need."""
        nonlocal prior_read
        if prior_read:
            return prior
        prior_read = True
        rid = follow
        for _ in range(4):
            if not rid:
                break
            try:
                x = p.get(f"/api/aip/runs/{rid}")
            except Exception:  # noqa: BLE001 - a help, never a failure
                break
            for e in x.get("events") or []:
                if e.get("type") == "result" and e.get("rid") and "faskes_profil_id" in (e.get("columns") or []):
                    try:
                        prior.extend(p.get(f"/api/aip/runs/{rid}/results/{e['rid']}").get("rows") or [])
                    except Exception:  # noqa: BLE001
                        pass
            rid = (x.get("run") or {}).get("follow")
        return prior

    def get(path: str, **params: Any) -> Any:
        key = path + json.dumps(params, sort_keys=True)
        if key not in cache:
            cache[key] = p.get(path, **params)
        return cache[key]

    def receipt(app: str, endpoint: str, rid: str, rows: int, buka: dict | None = None) -> dict:
        return {"app": app, "request": {"endpoint": endpoint}, "rid": rid, "rows": rows, **({"buka": buka} if buka else {})}

    # ---------------------------------------------------------------- AI Agent Swarm

    def penugasan_swarm() -> dict:
        """AI Agent Swarm: proyek, penugasan (engagement) dan hasilnya — penugasan terakhir yang selesai (yang dibaca chat dan
        paket audit), status, waktu (WIB), biaya. Susunan tim per lini: tim_swarm; temuannya: laporan_swarm."""
        # read side by side, and without the team (GET /tim sizes the firm from the data: 23–35 s, 2026-10-29 — a summary
        # question waited 35 s on it)
        with ThreadPoolExecutor(3) as pool:
            last, runs, plist = pool.map(get, ("/api/aip/konsultan/terakhir", "/api/aip/konsultan/runs", "/api/aip/konsultan/proyek"))
        projects = {x["id"]: x for x in plist}
        rows = [{"penugasan": r.get("nama") or r["id"], "run": r["id"], "proyek": (projects.get(r.get("proyek")) or {}).get("nama"), "status": r.get("status"),
                 "mulai": _wib(r.get("created_at")), "selesai": _wib(r.get("finished_at")), "biaya_usd": round(r.get("spent_usd") or 0, 2)}
                for r in runs if not r.get("ulang_laporan")]
        rid = box.result("AI Agent Swarm: penugasan", rows, None, {"penugasan": "string", "run": "string", "proyek": "string"})
        return ({"penugasan_terakhir_selesai": {"run": last.get("run"), "selesai": _wib(last.get("pada")), "biaya_usd": round(last.get("biaya_usd") or 0, 2)}
                 if last.get("ada") else None,
                 "jumlah_proyek": len(projects), "proyek": [{"nama": x["nama"], "fokus": x.get("fokus") or "nasional", "dibuat": _wib(x.get("dibuat_pada"))} for x in projects.values()],
                 "jumlah_penugasan": len(rows), "penugasan": rows[:8],
                 "hasil_id": rid,
                 "ringkasan": f"{len(projects)} proyek, {len(rows)} penugasan; terakhir selesai {_wib(last.get('pada'))}" if last.get("ada") else "belum ada penugasan selesai"},
                receipt("konsultan", "GET /api/aip/konsultan/runs", rid, len(rows)))

    def tim_swarm() -> dict:
        """Susunan tim AI Agent Swarm: jumlah agen per lini (pimpinan, wilayah, peer, modus, ML, kasus, QA) dan alasannya,
        keluarga model, mesin. LAMBAT (±30 detik): pakai hanya untuk pertanyaan tentang susunan atau ukuran tim Swarm."""
        team = get("/api/aip/konsultan/tim")
        rows = [{"lini": k, "agen": v} for k, v in (team.get("lini") or {}).items()]
        rid = box.result("AI Agent Swarm: tim per lini", rows, None, {"lini": "string"})
        return ({"jumlah_agen": team.get("jumlah_agen"), "per_lini": team.get("lini"), "keluarga_model": team.get("keluarga_model"),
                 "mesin": [m.get("name") for m in team.get("mesin") or []],
                 "alasan_ukuran": [_pick(u, "lini", "agen", "alasan") for u in team.get("ukuran") or [] if isinstance(u, dict)][:8],
                 "hasil_id": rid, "ringkasan": f"{team.get('jumlah_agen')} agen dalam {len(rows)} lini"},
                receipt("konsultan", "GET /api/aip/konsultan/tim", rid, len(rows)))

    def _report(run: str) -> dict:
        run = (run or "").strip() or (get("/api/aip/konsultan/terakhir").get("run") or "")
        if not run:
            raise LookupError("belum ada penugasan AI Agent Swarm yang selesai")
        return get(f"/api/aip/konsultan/{run}/laporan-lengkap")

    def laporan_swarm(bab: str, penugasan: str) -> dict:
        """Laporan lengkap penugasan AI Agent Swarm (bab, exhibit, temuan). bab "" → daftar bab dan exhibit dengan intinya; bab =
        id bab (mis. "ringkasan", "wilayah", "modus", "rekomendasi") → teks bab itu dan angka exhibit-nya. penugasan: id run
        ("" = penugasan terakhir yang selesai)."""
        r = _report(penugasan)
        chapters = r.get("bab") or []
        if not (bab or "").strip():
            rows = [{"bab": c["id"], "judul": c["judul"], "inti": _REFS.sub("", " ".join(s.get("teks") or "" for s in c.get("bagian") or []))[:300]} for c in chapters]
            rid = box.result(f"Laporan AI Agent Swarm {r.get('run')}", rows, None, {"bab": "string", "judul": "string", "inti": "string"})
            return ({"judul": r.get("judul"), "penugasan": r.get("run"), "selesai": _wib(r.get("selesai")), "agen": r.get("agen"),
                     "bab": rows, "exhibit": [{"no": x.get("nomor"), "bab": x.get("bab"), "judul": x.get("judul")} for x in r.get("exhibit") or []],
                     "berkas_kasus": len(r.get("berkas") or []), "hasil_id": rid, "ringkasan": f"{len(rows)} bab, {len(r.get('exhibit') or [])} exhibit"},
                    receipt("konsultan", f"GET /api/aip/konsultan/{r.get('run')}/laporan-lengkap", rid, len(rows), {"run": r.get("run")}))
        want = bab.strip().lower()
        c = next((c for c in chapters if c["id"] == want or _match(c["judul"], want)), None)
        if not c:  # a topic, not a chapter ("rekomendasi"): the chapter whose text speaks of it most
            hits = sorted(((" ".join(s.get("teks") or "" for s in x.get("bagian") or []).lower().count(want), x) for x in chapters), key=lambda h: -h[0])
            c = hits[0][1] if hits and hits[0][0] else None
        if not c:
            raise LookupError(f"bab '{bab}' tidak ada; bab: {', '.join(x['id'] for x in chapters)}")
        ex = [x for x in r.get("exhibit") or [] if x.get("bab") == c["id"]]
        rows = [{"exhibit": x.get("judul"), "label": b.get("label"), "nilai": b.get("nilai")} for x in ex for b in (x.get("baris") or [])[:12]]
        rid = box.result(f"Laporan AI Agent Swarm · {c['judul']}", rows, None, {"exhibit": "string", "label": "string", "nilai": "double"})
        text = _REFS.sub("", "\n\n".join(f"{s.get('judul') or ''}\n{s.get('teks') or ''}" for s in c.get("bagian") or []))
        return ({"bab": c["judul"], "teks": text[:7000], "terpotong": len(text) > 7000,
                 "exhibit": [{"judul": x.get("judul"), "satuan": x.get("satuan"), "baris": [_pick(b, "label", "nilai") for b in (x.get("baris") or [])[:12]],
                              "fakta": _REFS.sub("", x["fakta"]) if isinstance(x.get("fakta"), str) else x.get("fakta")} for x in ex],
                 "hasil_id": rid, "ringkasan": f"bab {c['judul']}: {len(c.get('bagian') or [])} bagian, {len(ex)} exhibit"},
                receipt("konsultan", f"GET /api/aip/konsultan/{r.get('run')}/laporan-lengkap", rid, len(rows), {"run": r.get("run")}))

    def berkas_kasus(faskes: str) -> dict:
        """Berkas kasus satu faskes dari laporan AI Agent Swarm terakhir (faskes kelompok prioritas): profil, kerugian, TSM,
        penilaian penyidik, modus, temuan. faskes: nama, kab/kota atau faskes_profil_id; "" → daftar faskes yang punya berkas."""
        r = _report("")
        files = r.get("berkas") or []
        if not (faskes or "").strip():
            rows = [_pick(b, "nama", "provinsi", "kabkota", "kelompok", "status") for b in files]
            rid = box.result("Berkas kasus AI Agent Swarm", rows, None, {k: "string" for k in ("nama", "provinsi", "kabkota", "kelompok", "status")})
            return ({"jumlah": len(rows), "berkas": rows, "hasil_id": rid, "ringkasan": f"{len(rows)} berkas kasus"},
                    receipt("konsultan", f"GET /api/aip/konsultan/{r.get('run')}/laporan-lengkap", rid, len(rows), {"run": r.get("run")}))
        hit = [b for b in files if faskes.strip() in (b.get("faskes_profil_id"),) or _match(b.get("nama"), faskes) or _match(b.get("kabkota"), faskes)]
        if not hit:
            raise LookupError(f"tidak ada berkas kasus untuk '{faskes}' ({len(files)} berkas: faskes kelompok prioritas saja); coba faskes_karantina")
        b = hit[0]
        rid = box.result(f"Berkas kasus {b.get('nama')}", [_pick(b, "faskes_profil_id", "nama", "provinsi", "kabkota", "kelompok", "status")], None,
                         {"faskes_profil_id": "string"})
        body = {k: v for k, v in b.items() if k not in ("peserta",)}
        text = _REFS.sub("", json.dumps(body, ensure_ascii=False, default=str))  # the engagement's own [r…] references
        body = json.loads(text)
        return ({"berkas": json.loads(text[:9000]) if len(text) <= 9000 else {k: (json.dumps(v, ensure_ascii=False, default=str)[:1500] if isinstance(v, (list, dict)) else v)
                                                                           for k, v in body.items()},
                 "lainnya_cocok": [x.get("nama") for x in hit[1:5]], "hasil_id": rid, "ringkasan": f"berkas {b.get('nama')}"},
                receipt("konsultan", f"GET /api/aip/konsultan/{r.get('run')}/laporan-lengkap", rid, 1, {"run": r.get("run"), "faskes": b.get("faskes_profil_id")}))

    def paket_audit(provinsi: str, kabkota: str, faskes: str, inacbg_kode: str, diagnosis: str, modus: str, kelompok: str, flag: str,
                    bulan_dari: str, bulan_sampai: str) -> dict:
        """Paket audit hasil AI Agent Swarm untuk SATU cakupan, disusun kode sekali baca (1–4 detik): angka kunci dan pembanding
        nasional, sebaran wilayah, komposisi modus, faskes prioritas (urutan Box Karantina), tren per bulan, kode INA-CBG dan
        diagnosis, per kelas rumah sakit, klaim penyumbang kerugian, temuan analis dan rekomendasi penyidik. PAKAI INI DULU untuk
        pertanyaan fraud tentang wilayah, faskes, kode, diagnosis, modus atau kelompok klaim, dan untuk estimasi kerugiannya.
        provinsi/kabkota HURUF BESAR; faskes nama atau id; diagnosis ICD-10 3 karakter atau nama; kelompok Box ("A" atau "A,B");
        flag dipisah koma (los_ekstrem, koreksi, readmisi, klaim_ganda, rawat_inap); bulan YYYY-MM. Isi "" untuk yang tidak
        dipakai — semua "" = nasional."""
        scope = {"provinsi": provinsi, "kabkota": kabkota, "faskes": faskes, "inacbg_kode": inacbg_kode, "diagnosis": diagnosis, "modus": modus,
                 "kelompok": kelompok, "flag": [f.strip() for f in (flag or "").split(",") if f.strip()], "bulan_dari": bulan_dari, "bulan_sampai": bulan_sampai}
        res, rec = T.audit_pack(box, AGENT, {k: v for k, v in scope.items() if v})
        return ({"cakupan": res["cakupan"], "teks": res["teks"], "hasil_id": res["hasil"], "ringkasan": res["ringkasan"]},
                {**rec, "app": "konsultan"})

    # ---------------------------------------------------------------- Agen

    def jaringan_agen(cari: str) -> dict:
        """Agen AIP JKN: jaringan semua agen AI (orkestrator, agen domain, validator, agen kecil, mesin, layanan), jumlah per
        jenis, model dan keluarganya, skill, dan hubungan antaragen. Bukan peran akses pengguna (itu keamanan_akses). cari "" →
        ringkasan; cari = nama agen → rinciannya."""
        g = get("/api/aip/jaringan")
        nodes, links = g.get("simpul") or [], g.get("hubungan") or []
        by_kind: dict[str, int] = {}
        for n in nodes:
            by_kind[n.get("jenis") or "-"] = by_kind.get(n.get("jenis") or "-", 0) + 1
        if (cari or "").strip():
            hit = [n for n in nodes if _match(n.get("nama"), cari) or _match(n.get("id"), cari) or _match(n.get("fungsi"), cari)][:8]
            rows = [{"agen": n.get("nama"), "jenis": n.get("jenis"), "model": A.aip_models.MODELS.get(n.get("model") or "", {}).get("label") or n.get("model"),
                     "induk": n.get("induk"), "fungsi": str(n.get("fungsi") or "")[:400], "skill": n.get("skill"),
                     "hubungan": [f"{x.get('jenis')} → {x.get('ke')}" for x in links if x.get("dari") == n.get("id")][:8]
                     + [f"{x.get('dari')} {x.get('jenis')} →" for x in links if x.get("ke") == n.get("id")][:8]} for n in hit]
        else:
            rows = [{"jenis": k, "arti": str((g.get("jenis_simpul") or {}).get(k) or "")[:160], "jumlah": v} for k, v in sorted(by_kind.items(), key=lambda x: -x[1])]
        rid = box.result("Jaringan agen AIP JKN" + (f": {cari}" if cari else ""), rows, None, None)
        models: dict[str, int] = {}
        for n in nodes:
            if n.get("model"):
                lab = A.aip_models.MODELS.get(n["model"], {}).get("label") or n["model"]
                models[lab] = models.get(lab, 0) + 1
        return ({"jumlah_agen": len(nodes), "jumlah_hubungan": len(links), "per_jenis": by_kind, "per_model": models, "agen": rows if cari else None,
                 "jenis_hubungan": {k: v.get("label") for k, v in (g.get("jenis_hubungan") or {}).items()}, "hasil_id": rid,
                 "ringkasan": f"{len(nodes)} simpul agen, {len(links)} hubungan" + (f"; {len(rows)} cocok '{cari}'" if cari else "")},
                receipt("agents", "GET /api/aip/jaringan", rid, len(rows)))

    async def analisis_agen(pertanyaan: str) -> dict:
        """Analisis BARU oleh orkestrator dan agen domain (alur lengkap: rencana, agen kecil, validator; 1–3 menit). Hanya bila
        tidak ada aplikasi yang memegang jawabannya: membandingkan teknik ML, menguji hipotesis lintas sumber, menelusuri
        pola yang belum dianalisis AI Agent Swarm. Jawabannya sudah divalidasi; tautan analisisnya tampil sendiri untuk
        pengguna — jangan tulis id run atau lama detiknya di jawaban."""
        r = await asyncio.to_thread(p.post, "/api/aip/ask", {"q": pertanyaan})
        run = r["run"]
        emit({"type": "sub_run", "run": run, "q": pertanyaan})
        after, answer, status, t0 = 0, "", "running", time.time()
        while time.time() - t0 < SUB_WAIT:
            x = await asyncio.to_thread(p.get, f"/api/aip/runs/{run}", after=after)
            for e in x.get("events") or []:
                if e.get("type") == "stage":
                    emit({"type": "sub_step", "run": run, "agent": e.get("agent"), "text": f"tahap {e.get('stage')}"})
                elif e.get("type") == "tool":
                    emit({"type": "sub_step", "run": run, "agent": e.get("agent"), "tool": e.get("tool"), "text": str(e.get("summary") or "")[:200], "ok": e.get("ok")})
                elif e.get("type") == "answer":
                    answer = str(e.get("text") or "")
            after, status = x.get("next", after), (x.get("run") or {}).get("status", status)
            if answer or status != "running":
                break
            await asyncio.sleep(2)
        rid = box.result(f"Analisis agen: {pertanyaan[:80]}", [{"run": run, "status": status, "jawaban": answer}], None, {"run": "string", "jawaban": "string"})
        if not answer:
            note = "masih berjalan — buka tautannya untuk mengikuti" if status == "running" else f"berhenti ({status}) tanpa jawaban"
            return ({"run": run, "status": status, "hasil_id": rid, "ringkasan": f"analisis agen {note}"}, receipt("agents", "POST /api/aip/ask", rid, 0, {"run": run}))
        return ({"run": run, "jawaban": answer[:6000], "hasil_id": rid, "ringkasan": f"analisis agen selesai ({int(time.time() - t0)} detik)"},
                receipt("agents", "POST /api/aip/ask", rid, 1, {"run": run}))

    # ---------------------------------------------------------------- ML Studio

    def ml_studio(model: str) -> dict:
        """ML Studio: model yang terdaftar (versi, terbaru, usang), run pelatihan dan notebook terbaru dengan metriknya. model
        "" → semua model dan 10 run terbaru; model = nama model → run-run model itu."""
        s = get("/api/ml-studio")
        models, runs = s.get("models") or [], s.get("runs") or []
        if (model or "").strip():
            runs = [r for r in runs if _match(r.get("model"), model) or _match(r.get("name"), model)]
        runs = sorted(runs, key=lambda r: str(r.get("started_at") or ""), reverse=True)

        def metrics(m: Any) -> dict:
            if not isinstance(m, dict):
                return {}
            flat = {k: v for k, v in m.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
            return {k: _num(v) for k, v in list(flat.items())[:8]}
        rows = [{"run": r.get("name") or r.get("key"), "model": r.get("model"), "jenis": r.get("kind"), "status": r.get("status"), "mulai": _wib(r.get("started_at")),
                 **metrics(r.get("metrics"))} for r in runs[:10]]
        rid = box.result("ML Studio: run" + (f" {model}" if model else ""), rows, None, {"run": "string", "model": "string", "jenis": "string", "status": "string"})
        mods = [{"model": m.get("name"), "versi": len(m.get("versions") or []) if isinstance(m.get("versions"), list) else m.get("versions"),
                 "terbaru": (m.get("latest") or {}).get("version") if isinstance(m.get("latest"), dict) else m.get("latest"), "usang": m.get("out_of_date"),
                 "keterangan": str(m.get("description") or "")[:140]} for m in models]
        return ({"jumlah_model": len(models), "model": mods, "jumlah_run": len(s.get("runs") or []), "run_terbaru": rows,
                 "docker": (s.get("docker") or {}).get("available"), "hasil_id": rid,
                 "ringkasan": f"{len(models)} model, {len(s.get('runs') or [])} run" + (f"; {len(runs)} run '{model}'" if model else "")},
                receipt("ml", "GET /api/ml-studio", rid, len(rows)))

    # ---------------------------------------------------------------- Box Karantina

    def box_karantina(kelompok: str, provinsi: str, status: str, batas: int) -> dict:
        """Box Karantina: faskes yang dikarantina AI Agent Swarm, kelompok A (prioritas, 50% kerugian) sampai Z, status
        (karantina, diaudit, dibina, ditindak, dibebaskan), jalur awal, estimasi kerugian dan yang sudah dikoreksi, indikasi TSM.
        Total seluruh box dan tiap kelompok ada di ringkasan_box (satu panggilan cukup). kelompok A, B, C, D atau Z, provinsi
        HURUF BESAR, status — "" bila tidak dipakai; batas 1–30 faskes (urut estimasi kerugian)."""
        # an unknown group read as empty and the model went on through the alphabet (14 calls for E…N, 2026-10-29)
        if (kelompok or "").strip() and not all(k.strip().upper() in ("A", "B", "C", "D", "Z") for k in kelompok.split(",")):
            raise ValueError(f"kelompok '{kelompok}' tidak ada: hanya A, B, C, D, Z. Total box dan per kelompok ada di ringkasan_box.")
        n = max(1, min(int(batas or 10), 30))
        b = get("/api/aip/karantina", kelompok=kelompok or None, status=status or None, provinsi=provinsi or None, limit=n)
        fs = [f for g in (b.get("kelompok") or {}).values() for f in g.get("faskes") or []]
        fs.sort(key=lambda f: -(f.get("estimasi_kerugian_rp") or 0))
        rows = [{**_pick(f, "faskes_profil_id", "nama", "provinsi", "kabkota", "kelompok", "status", "jalur_awal", "estimasi_kerugian_rp", "sudah_dikoreksi_rp",
                         "klaim_bertag", "klaim_faskes", "tag", "kuat", "indikasi_tsm", "keparahan_label"),
                 "modus_teratas": ", ".join(list((f.get("modus") or {}).keys())[:3])} for f in fs[:n]]
        rid = box.result("Box Karantina" + "".join(f" · {x}" for x in (kelompok, provinsi, status) if x), rows, None,
                         {"faskes_profil_id": "string", "estimasi_kerugian_rp": "double", "sudah_dikoreksi_rp": "double"})
        s = b.get("ringkasan") or {}
        return ({"ringkasan_box": {**_pick(s, "faskes", "total_estimasi_kerugian_rp", "sudah_dikoreksi_rp", "rasio_koreksi_median", "indikasi_tsm"),
                                   "dihitung": _wib(s.get("pada")),
                                   "kelompok": {k: _pick(v, "faskes", "kerugian_rp", "arti") for k, v in (s.get("kelompok") or {}).items()}},
                 "per_status": b.get("per_status"), "faskes_cocok": b.get("total"),
                 "per_kelompok_cocok": {k: g.get("total") for k, g in (b.get("kelompok") or {}).items()}, "faskes": rows, "hasil_id": rid,
                 "ringkasan": f"Box Karantina: {b.get('total')} faskes cocok, {len(rows)} ditampilkan"},
                receipt("karantina", "GET /api/aip/karantina", rid, len(rows), {"kelompok": kelompok} if kelompok else None))

    def faskes_karantina(faskes: str) -> dict:
        """Satu faskes di Box Karantina: kelompok, status, jalur, estimasi kerugian dan rinciannya, klaim bertag, modus, TSM,
        rekomendasi, riwayat keputusan, klaim penyumbang kerugian. faskes: faskes_profil_id atau nama (bagian nama, mis. "KOTA MEDAN")."""
        # the name resolved like buka_aplikasi's (2026-10-29: "RS Khusus Jiwa Singkawang" read the Type C hospital of the city)
        fid = _faskes_id((faskes or "").strip())
        if not fid:
            raise LookupError(f"tidak ada faskes '{faskes}' di Box Karantina")
        f = get(f"/api/aip/karantina/{fid}")
        tags: dict[str, int] = {}
        for x in f.get("indikasi") or []:
            k = x.get("tag_label") or x.get("tag") or "-"
            tags[k] = tags.get(k, 0) + 1
        top = sorted(tags.items(), key=lambda x: -x[1])[:8]
        rows = [{"indikasi": k, "jumlah": v} for k, v in top]
        rid = box.result(f"Box Karantina · {f.get('nama')}", rows, None, {"indikasi": "string", "jumlah": "integer"})
        contrib = [_pick(c, "klaim_id", "inacbg_kode", "komponen", "nilai_rp", "estimasi_kerugian_rp", "dibayar_rp", "los_hari") for c in (f.get("klaim_kontributor") or [])[:5]]
        recs = [x if isinstance(x, str) else {k: v for k, v in x.items() if isinstance(v, (str, int, float))} for x in (f.get("rekomendasi") or [])[:5]]
        return ({**_pick(f, "faskes_profil_id", "nama", "provinsi", "kabkota", "jenis", "tipe", "kelompok", "status", "jalur_awal", "estimasi_kerugian_rp",
                         "sudah_dikoreksi_rp", "nilai_terpapar_rp", "klaim_bertag", "klaim_faskes", "peserta_terdampak", "bulan_aktif", "tag", "kuat", "sedang",
                         "lemah", "indikasi_tsm", "keparahan_label", "klasifikasi"),
                 "rincian_kerugian": f.get("rincian_kerugian"), "tsm": f.get("tsm"), "modus": dict(list((f.get("modus") or {}).items())[:6]),
                 "indikasi_teratas": dict(top), "jenis_indikasi": len(tags), "jumlah_klaim_penyumbang": len(f.get("klaim_kontributor") or []),
                 "klaim_penyumbang_teratas": contrib, "jumlah_rekomendasi": len(f.get("rekomendasi") or []), "rekomendasi": recs, "keputusan": f.get("keputusan"),
                 "riwayat": [{**_pick(x, "status", "oleh", "catatan"), "pada": _wib(x.get("pada"))} for x in (f.get("riwayat") or [])[-3:] if isinstance(x, dict)],
                 "masuk": _wib(f.get("masuk_pada")), "hasil_id": rid, "ringkasan": f"{f.get('nama')}: kelompok {f.get('kelompok')}, {f.get('status')}"},
                receipt("karantina", f"GET /api/aip/karantina/{fid}", rid, len(rows), {"faskes": fid}))

    def aturan_indikasi(cari: str) -> dict:
        """Aturan indikasi fraud (lapisan fakta, aturan, ML, agen) dan 19 modus Permenkes 16/2019 yang dipakai penanda otomatis:
        kondisi, alasan, data, keterbatasan, jumlah temuan. cari "" → daftar; cari = kata (mis. "readmisi", "tarif", "M05") → rinciannya."""
        a = get("/api/aip/aturan")
        rules, modes = a.get("aturan") or [], a.get("modus") or []
        if (cari or "").strip():
            rules = [r for r in rules if any(_match(r.get(k), cari) for k in ("id", "nama", "tag", "tag_label", "modus", "kondisi"))]
            modes = [m for m in modes if any(_match(m.get(k), cari) for k in ("id", "nama", "dasar"))]
            shown = [_pick(r, "id", "nama", "lapisan", "tag_label", "modus", "kondisi", "kenapa", "data", "keterbatasan", "temuan", "temuan_satuan") for r in rules[:8]]
        else:
            shown = [_pick(r, "id", "nama", "lapisan", "tag_label", "temuan", "temuan_satuan") for r in rules]
        rid = box.result("Aturan indikasi" + (f": {cari}" if cari else ""), shown, None, None)
        last = a.get("penandaan_terakhir") or {}
        return ({"jumlah_aturan": len(a.get("aturan") or []), "aturan": shown, "modus": [_pick(m, "id", "nama", "deteksi", "dasar", "fokus") for m in modes[:19]],
                 "penandaan_terakhir": {"pada": _wib(last.get("pada")), **_pick(last, "tag", "dicabut")}, "kekuatan": a.get("kekuatan"), "hasil_id": rid,
                 "ringkasan": f"{len(shown)} aturan" + (f" cocok '{cari}'" if cari else "") + f", {len(modes)} modus"},
                receipt("karantina", "GET /api/aip/aturan", rid, len(shown), {"aturan": True}))

    def indikasi_fraud(provinsi: str) -> dict:
        """Indikasi fraud (tag) yang ditulis penanda otomatis dan agen: total, kekuatan (kuat/sedang/lemah), per jenis tag, per
        entitas, per provinsi, faskes teratas, hasil aturan otomatis, sinkron ke Nexus. provinsi HURUF BESAR ("" = nasional)."""
        s = get("/api/aip/indikasi/ringkasan")
        prov = s.get("per_provinsi") or []
        ranked = sorted(prov, key=lambda x: -(x.get("tag") or 0))
        mine = next((dict(x, peringkat=i + 1) for i, x in enumerate(ranked) if (provinsi or "").strip() and _match(x.get("provinsi"), provinsi)), None)
        fac_all = [f for f in s.get("faskes_teratas") or [] if not provinsi or _match(f.get("provinsi"), provinsi)]
        fac = fac_all[:10]
        rows = [_pick(t, "label", "kuat", "sedang", "lemah", "total") for t in s.get("per_tag") or []]
        rid = box.result("Indikasi fraud per jenis", rows, None, {"label": "string"})
        auto = s.get("otomatis") or {}
        nx = s.get("nexus") or {}
        return ({"total_tag": s.get("total"), "kuat": s.get("kuat"), "sedang": s.get("sedang"), "lemah": s.get("lemah"), "ditolak": s.get("ditolak"),
                 "per_jenis": rows, "per_entitas": s.get("per_entitas"), "provinsi_teratas": ranked[:8], "provinsi_diminta": mine,
                 "jumlah_provinsi": len(prov), "faskes_teratas_dalam_daftar": len(fac_all),
                 "faskes_teratas": [_pick(f, "nama", "provinsi", "tag", "kuat", "bobot") for f in fac],
                 "penanda_otomatis": {"pada": _wib(auto.get("pada")), "per_aturan": auto.get("aturan")},
                 "nexus": {"status": nx.get("status"), "pada": _wib(nx.get("pada")), "tag": nx.get("tag")}, "hasil_id": rid,
                 "ringkasan": f"{s.get('total')} tag indikasi ({s.get('kuat')} kuat)"},
                receipt("karantina", "GET /api/aip/indikasi/ringkasan", rid, len(rows)))

    # ---------------------------------------------------------------- Pipeline Produksi

    def pipeline_produksi() -> dict:
        """Pipeline Produksi: model terpasang per segmen (model, ambang, fitur, format), run pipeline terakhir (status, tahap,
        baris, ditandai), jadwal, kesehatan layanan POST /verify, dan batch verifikasi CSV/JSON terakhir."""
        s = get("/api/aip/produksi")
        try:
            health = get("/api/aip/fraud/v1/sehat")
        except Exception as e:  # noqa: BLE001 - the service down is an answer too
            health = {"error": str(e)[:200]}
        try:
            batches = get("/api/aip/fraud/v1/verify/batch")
        except Exception:  # noqa: BLE001
            batches = []
        dep = s.get("deploy") or {}
        rows = [{"run": r.get("id"), "status": r.get("status"), "pemicu": r.get("pemicu"), "mulai": _wib(r.get("mulai")), "selesai": _wib(r.get("selesai")),
                 **{k: v for k, v in (r.get("ringkasan") or {}).items() if isinstance(v, (int, float, str)) and k != "status"}} for r in (s.get("runs") or [])[:6]]
        rid = box.result("Pipeline Produksi: run", rows, None, {"run": "string", "status": "string"})
        seg = {k: {**_pick(v, "model", "tugas", "ambang", "disajikan_dari", "paritas_max_abs"), "fitur": len(v.get("fitur") or []), "onnx": bool(v.get("onnx"))}
               for k, v in (s.get("signature") or {}).items()}
        return ({"terpasang": {"pada": _wib(dep.get("pada")), "model_versi": dep.get("model_versi"), "run": dep.get("run")}, "segmen": seg, "run_terakhir": rows,
                 "jadwal": s.get("jadwal"), "kolom_kontrak": len((s.get("kontrak") or {}).get("kolom") or {}),
                 "layanan_verify": {k: v for k, v in health.items() if isinstance(v, (str, int, float, bool))} if isinstance(health, dict) else health,
                 "batch_verifikasi": [{**_pick(b, "id", "status", "sumber", "jumlah", "selesai", "ditolak", "per_status", "detik"), "dibuat": _wib(b.get("dibuat"))}
                                      for b in (batches or [])[:5]],
                 "hasil_id": rid, "ringkasan": f"model {dep.get('model_versi')} terpasang {_wib(dep.get('pada'))}; run terakhir {rows[0]['status'] if rows else '-'}"},
                receipt("produksi", "GET /api/aip/produksi", rid, len(rows)))

    # ---------------------------------------------------------------- Evaluasi & Kontrol

    def evaluasi_kontrol(bagian: str) -> dict:
        """Evaluasi & Kontrol: biaya model (hari ini, bulan ini, per model), run AIP per status dan jenis, validator (lulus/total),
        kegagalan pemblokir, evaluasi golden dan arsitektur terakhir, model produksi, gerbang kontrol. bagian "" = semua; atau
        "biaya", "run", "validator", "golden", "gerbang"."""
        o = get("/api/aip/control/overview")
        sp, rn, vd, gd = o.get("spend") or {}, o.get("runs") or {}, o.get("verdicts") or {}, o.get("golden") or {}
        today = sp.get("today") or {}
        per_model = {A.aip_models.MODELS.get(k, {}).get("label") or k: (round(v.get("usd", 0), 2) if isinstance(v, dict) else v)
                     for k, v in (today.get("models") or {}).items()}
        val = [{"validator": k, "lulus": v.get("passed"), "total": v.get("total"), "cek_gagal": v.get("checks_failed")} for k, v in (vd.get("validators") or {}).items()]
        rid = box.result("Evaluasi & Kontrol: validator", val, None, {"validator": "string"})
        out: dict[str, Any] = {
            "biaya": {"hari_ini_usd": round(today.get("usd") or 0, 2), "panggilan_hari_ini": today.get("calls"), "per_model_hari_ini_usd": per_model,
                      "bulan_ini_usd": round((sp.get("month") or {}).get("usd") or 0, 2), "total_usd": round(sp.get("total_usd") or 0, 2),
                      "batas": {k: v for k, v in (sp.get("caps") or {}).items() if v is not None} or "tanpa batas",
                      "per_hari": [{"hari": d.get("day"), "usd": round(d.get("usd") or 0, 2)} for d in (sp.get("days") or [])[-7:]]},
            "run": {"dibaca": rn.get("scanned"), "per_status": rn.get("by_status"), "per_jenis": rn.get("by_kind"), "biaya_usd": round(rn.get("spent_usd") or 0, 2),
                    "7_hari": rn.get("last7")},
            "validator": val, "run_dengan_putusan": vd.get("runs_with_verdict"),
            # a list cut short says how long it is: a model counting the rows it sees reported 5 of 7 failures (2026-10-28)
            "jumlah_kegagalan_pemblokir": len(vd.get("blocking_failures") or []),
            "kegagalan_pemblokir_terbaru": [{**_pick(b, "run", "validator", "klaim", "bukti"), "pada": _wib(b.get("t"))} for b in (vd.get("blocking_failures") or [])[:5]],
            "golden": {"set": [x.get("name") for x in gd.get("sets") or []], "terakhir": (gd.get("latest") or {}).get("summary"),
                       "jumlah_gagal": len((gd.get("latest") or {}).get("failed") or []),
                       "gagal": [x.get("id") for x in ((gd.get("latest") or {}).get("failed") or [])[:8]]},
            "arsitektur": ((o.get("arch") or {}).get("latest") or {}).get("summary"),
            "produksi": o.get("production"), "gerbang": [_pick(g, "nama", "status", "bukti") for g in o.get("gates") or []],
        }
        want = (bagian or "").strip().lower()
        keys = {"biaya": ["biaya"], "run": ["run"], "validator": ["validator", "run_dengan_putusan", "jumlah_kegagalan_pemblokir", "kegagalan_pemblokir_terbaru"],
                "golden": ["golden", "arsitektur"],
                "gerbang": ["gerbang", "produksi"]}.get(want)
        if keys:
            out = {k: out[k] for k in keys}
        return ({**out, "dibuat": _wib(o.get("generated_at")), "hasil_id": rid,
                 "ringkasan": f"biaya hari ini ${round(today.get('usd') or 0, 2)}, {rn.get('scanned')} run, {len(val)} validator"},
                receipt("kontrol", "GET /api/aip/control/overview", rid, len(val)))

    def evaluasi_swarm(penugasan: str) -> dict:
        """Evaluasi Swarm: mutu tiap penugasan AI Agent Swarm, dinilai kode dari jejaknya — kriteria lulus/terukur, skor
        scrutiny, QA per lini, validator, kontrak, hasil (tag, kasus, jalur, red team) dan orkestrasi (fase, serah-terima,
        tool gagal, galat). penugasan "" → daftar penugasan dan rincian yang terakhir selesai; penugasan = id run atau nama → rinciannya."""
        lst = get("/api/aip/evaluasi-swarm")
        items = (lst.get("penugasan") or []) if isinstance(lst, dict) else (lst or [])
        rows = [{"penugasan": x.get("nama") or x.get("id"), "run": x.get("id"), "proyek": x.get("proyek_nama"), "status": x.get("status"),
                 "selesai": _wib(x.get("selesai")), "lulus": x.get("lulus"), "terukur": x.get("terukur"), "biaya_usd": round(x.get("biaya_usd") or 0, 2),
                 "tag": x.get("tag"), "kasus": x.get("kasus"), "galat": x.get("galat")} for x in items]
        want = (penugasan or "").strip()
        pick = next((x for x in items if want and (x.get("id") == want or _match(x.get("nama"), want))), None) if want else \
            next((x for x in items if x.get("status") == "succeeded"), items[0] if items else None)
        if want and not pick:
            raise LookupError(f"penugasan '{penugasan}' tidak ada di Evaluasi Swarm ({len(items)} penugasan)")
        detail = None
        if pick:
            d = get(f"/api/aip/evaluasi-swarm/{pick['id']}")
            o, h = d.get("orkestrasi") or {}, d.get("hasil") or {}
            detail = {"penugasan": d.get("nama"), "run": d.get("id"), "status": d.get("status"), "lama_detik": d.get("detik"),
                      "biaya_usd": round(d.get("biaya_usd") or 0, 2), "kriteria_lulus": d.get("lulus"), "kriteria_terukur": d.get("terukur"),
                      "kriteria": [_pick(k, "nama", "nilai", "syarat", "lulus") for k in d.get("kriteria") or []], "skor": d.get("skor"),
                      "qa_per_lini": [_pick(q, "nama", "lini", "passed", "total") for q in d.get("qa") or []],
                      "validator": {"model": A.aip_models.MODELS.get((d.get("validator") or {}).get("model") or "", {}).get("label"),
                                    "cek": len((d.get("validator") or {}).get("cek") or [])},
                      "kontrak": {"jumlah": len(d.get("kontrak") or []), "terpenuhi": sum(1 for k in d.get("kontrak") or [] if k.get("ok")),
                                  "tidak_terpenuhi": [_pick(k, "teks", "bukti") for k in d.get("kontrak") or [] if not k.get("ok")][:5]},
                      "hasil": {k: v for k, v in h.items() if isinstance(v, (int, float, str, dict))},
                      "orkestrasi": {k: o.get(k) for k in ("agen", "instans", "serah_terima", "prosedur_diikuti", "masalah_dilaporkan", "tool", "tool_gagal",
                                                           "galat_total", "giliran_diulang", "dilanjutkan")},
                      "tool_gagal_teratas": o.get("tool_gagal_teratas")}
        rid = box.result("Evaluasi Swarm: penugasan", rows, None, {"penugasan": "string", "run": "string", "proyek": "string"})
        return ({"jumlah_penugasan": len(rows), "penugasan": rows[:10], "rincian": detail, "hasil_id": rid,
                 "ringkasan": f"{len(rows)} penugasan dinilai" + (f"; {detail['penugasan']}: {detail['kriteria_lulus']}/{detail['kriteria_terukur']} kriteria lulus" if detail else "")},
                receipt("kontrol", "GET /api/aip/evaluasi-swarm", rid, len(rows)))

    # ---------------------------------------------------------------- Keamanan & Akses

    def keamanan_akses(peran: str) -> dict:
        """Keamanan & Akses: akses data per peran atas Data Sampel BPJS per tahap (Arsip Sumber, Data Mentah, Data Bersih, Siap
        Analisis, model, logika, portal, Nexus), peran akses (mis. "Peran · Temuan Fraud Swarm") dengan penanda, kebijakan baris
        dan ANGGOTANYA (akun pengguna), lapisan aturan akses. Pertanyaan tentang peran pengguna, akun, anggota, atau siapa boleh
        melihat apa → tool ini. peran "" → matriks ringkas; peran = nama/username peran → rinciannya."""
        a = get("/api/aip/akses")
        stages = {t["id"]: t["nama"] for t in a.get("tahap") or []}

        def level(x: Any) -> str:
            if not isinstance(x, dict):
                return str(x)
            n = {k: x.get(k) or 0 for k in ("view", "no_access", "no_data", "unknown")}
            return "lihat" if n["view"] and not n["no_access"] else "sebagian" if n["view"] else "tanpa akses" if n["no_access"] else "tanpa data" if n["no_data"] else "-"
        roles = a.get("peran") or []
        if (peran or "").strip():
            roles = [r for r in roles if _match(r.get("nama"), peran) or _match(r.get("username"), peran) or _match(r.get("judul"), peran)]
        rows = [{"peran": r.get("nama"), "akun": r.get("username"), **{stages.get(k, k): level(v) for k, v in (r.get("tahap") or {}).items()}} for r in roles]
        rid = box.result("Keamanan & Akses: matriks peran", rows, None, None)
        # per stage, how many roles have which access, and which ones: the answer counts from here, not from the rows
        per_stage: dict[str, dict[str, list[str]]] = {}
        for r in rows:
            for s in stages.values():
                if s in r:
                    per_stage.setdefault(s, {}).setdefault(r[s], []).append(str(r["peran"]))
        detail = None
        if (peran or "").strip() and roles:
            r = roles[0]
            detail = {"tugas": r.get("tugas"), "per_tahap": {stages.get(k, k): {"lihat": v.get("view"), "tanpa_akses": v.get("no_access"), "tanpa_data": v.get("no_data"),
                                                                                   "contoh_ditolak": [i.get("nama") for i in v.get("items") or [] if i.get("status") == "no_access"][:5]}
                                                         for k, v in (r.get("tahap") or {}).items() if isinstance(v, dict)}}
        return ({"tahap": list(stages.values()), "jumlah_peran": len(rows), "peran": rows,
                 "per_tahap": {s: {lvl: {"jumlah": len(names), "peran": names} for lvl, names in v.items()} for s, v in per_stage.items()},
                 "rincian": detail,
                 "peran_akses": [_pick(x, "nama", "membuka", "penanda", "semua_baris", "anggota") for x in a.get("peran_akses") or []],
                 "lapisan": [{"nama": x.get("nama"), "arti": x.get("arti"), "aturan": (x.get("aturan") or [])[:6]} for x in a.get("lapisan") or []],
                 "dibangun": _wib(a.get("dibangun")), "hasil_id": rid, "ringkasan": f"{len(rows)} peran × {len(stages)} tahap"},
                receipt("akses", "GET /api/aip/akses", rid, len(rows)))

    # ---------------------------------------------------------------- Nexus · Object Explorer (schema; the reads are tools.object_tools)

    def skema_nexus(tipe: str) -> dict:
        """Skema Nexus: tipe objek AIP JKN dengan kunci, judul dan propertinya (api_name:tipe) — panggil sebelum cari_objek atau
        agregasi_objek bila nama properti belum pasti. tipe "" → daftar tipe per agen pemiliknya."""
        if not (tipe or "").strip():
            rows = [{"tipe": t["name"], "agen": box.agents[o]["name"], "kunci": t["primary_key"], "judul": t.get("title"), "properti": len(t.get("properties") or []),
                     "arti": str(t.get("description") or "")[:140]} for t, o in box.types.values()]
            rid = box.result("Skema Nexus: tipe objek", rows, None, None)
            return ({"jumlah_tipe": len(rows), "tipe": rows, "hasil_id": rid, "ringkasan": f"{len(rows)} tipe objek"},
                    receipt("objects", "GET /api/aip/agents", rid, len(rows)))
        t = box.type_of(AGENT, tipe, any_owner=True)
        rows = [{"properti": x["api_name"], "jenis": x["type"]} for x in t.get("properties") or []]
        rid = box.result(f"Skema {t['name']}", rows, None, None)
        return ({"tipe": t["name"], "kunci": t["primary_key"], "judul": t.get("title"), "arti": t.get("description"),
                 "properti": [f"{x['api_name']}:{x['type']}" for x in t.get("properties") or []][:80], "hasil_id": rid,
                 "ringkasan": f"{t['name']}: {len(rows)} properti"},
                receipt("objects", "GET /api/aip/agents", rid, len(rows), {"type_id": t["id"]}))

    # ---------------------------------------------------------------- Pipeline Builder

    def pipeline_builder(pipeline: str, cari: str) -> dict:
        """Pipeline Builder: dua pipeline data BPJS — "utama" (Data Mentah → Siap Analisis) dan "fakta" (Fakta Klaim per
        klaim). Sumber, transform dan keluaran dengan keterangannya, dan status build tiap keluaran. cari "" → ringkasan; cari =
        nama/kata → node yang cocok dengan keterangannya."""
        apps = cat.get("apps") or {}
        href = apps.get("pipeline_fakta") if (pipeline or "").strip().lower().startswith("fakta") else apps.get("pipeline")
        if not href:
            raise LookupError("pipeline data BPJS belum terhubung ke AIP JKN")
        pid = href.rstrip("/").split("/")[-1]
        f = get(f"/api/pipeline/files/{pid}")
        doc = f.get("content") or {}
        doc = json.loads(doc) if isinstance(doc, str) else doc
        # the outputs are kept apart from the graph's nodes (the datasets the pipeline writes, with their location)
        outs = [{**o, "kind": "output", "description": o.get("description") or f"keluaran ke {(o.get('location') or {}).get('name') or '-'}"}
                for o in doc.get("outputs") or []]
        nodes = (doc.get("nodes") or []) + outs
        try:
            state = get(f"/api/pipeline/state/{pid}")
        except Exception:  # noqa: BLE001 - the build state is a help
            state = {}
        kinds: dict[str, int] = {}
        for n in nodes:
            kinds[n.get("kind") or "-"] = kinds.get(n.get("kind") or "-", 0) + 1
        built = {k.split(":", 1)[1]: v for k, v in state.items() if k.startswith("built:") and isinstance(v, dict)}
        if (cari or "").strip():
            found = [n for n in nodes if _match(n.get("name"), cari) or _match(n.get("description"), cari)]
            hit = found[:10]
        else:
            found = [n for n in nodes if n.get("kind") in ("source", "output")]
            hit = found[:40]
        rows = [{"node": n.get("name"), "jenis": n.get("kind"), "keterangan": str(n.get("description") or "")[:300 if cari else 120],
                 **({"dibangun": _wib(built[n["id"]].get("at"))} if n.get("id") in built else {})} for n in hit]
        rid = box.result(f"Pipeline {(f.get('item') or {}).get('name')}", rows, None, {"node": "string", "jenis": "string", "keterangan": "string"})
        last = max((v.get("at") or "" for v in built.values()), default="")
        return ({"pipeline": (f.get("item") or {}).get("name"), "node_per_jenis": kinds, "keluaran_dibangun": len(built), "build_terakhir": _wib(last),
                 "node_cocok": len(found), "node": rows, "hasil_id": rid, "ringkasan": f"{len(nodes)} node ({', '.join(f'{v} {k}' for k, v in kinds.items())})"},
                receipt("pipeline", f"GET /api/pipeline/files/{pid}", rid, len(rows), {"pipeline": "fakta" if href == apps.get("pipeline_fakta") else "utama"}))

    # ---------------------------------------------------------------- opening an app on the user's screen

    def _faskes_id(s: str) -> str | None:
        """A facility named the way an answer writes it ("RS Khusus Jiwa, Pemprov — Kota Singkawang") → its faskes_profil_id:
        the id itself; else a facility already read in this run whose name holds the name's distinctive words; else a
        search of the box by them (2026-10-28: the whole written name matched nothing, the box opened unfocused)."""
        if re.fullmatch(r"[0-9a-f]{32}", s):
            return s
        words = [w for w in re.findall(r"[a-z0-9]+", s.lower()) if len(w) > 2 and w not in _GENERIC]
        # the class letter tells two hospitals of one city apart ("Type B" vs "Type A" in Kota Medan): it must match too
        grades = re.findall(r"\b(?:type|tipe|kelas)\s+([a-d])\b", s.lower())
        if not words:  # only kind words ("RS Kelas A Vertikal"): they and the class are what there is to match
            words = [w for w in re.findall(r"[a-z]+", s.lower()) if len(w) > 3 and w not in ("rumah", "sakit", "fkrtl", "faskes", "kelas", "type", "tipe")]
            words += [f"{k} {g}" for k, g in re.findall(r"\b(type|tipe|kelas)\s+([a-d])\b", s.lower())]
        if not words:
            return None

        def fits(name: str) -> bool:
            name = name.lower()
            return all(w in name for w in words) and all(re.search(rf"\b(?:type|tipe|kelas)\s+{g}\b", name) for g in grades)

        def name_of(r: dict) -> str:
            return " ".join(str(r.get(k) or "") for k in ("nama", "faskes", "_judul", "kabkota", "tipe"))
        # the facilities this turn read, then the ones the turns before it read (a follow-up names a facility of the last
        # answer in short: "RS Khusus Jiwa (Pemprov)" for the one in Kota Singkawang, 2026-10-29)
        for rows in [*box.rows.values(), prior_rows()]:
            for r in rows:
                if r.get("faskes_profil_id") and fits(name_of(r)):
                    return str(r["faskes_profil_id"])
        # the box itself: the name's distinctive words, the biggest loss first (several facilities may share a written
        # name — Type B private hospitals of Kota Medan, 33 provincial mental hospitals); fewer words when the model wrote
        # one the name has not
        t = box.type_of(AGENT, T.BOX_TYPE, any_owner=True)
        longest = sorted(words, key=len, reverse=True)
        for use in (words, longest[:2], longest[:1]):
            r, _ = T._search(p, {"object_type_id": t["id"], "q": "", "filters": [{"property": "nama", "op": "contains", "value": w} for w in use],
                                 "sort": "estimasi_kerugian_rp", "order": "desc", "limit": 25, "histograms": False, "resource": "aip"})
            hits = [o for o in r.get("objects") or [] if all(re.search(rf"\b(?:type|tipe|kelas)\s+{g}\b", str(o.get("title") or "").lower()) for g in grades)]
            if hits:
                return str(hits[0].get("primary_key"))
        return None

    def buka_aplikasi(aplikasi: str, sasaran: str) -> dict:
        """Buka aplikasi AIP JKN di layar pengguna, di samping percakapan (seperti "Operator · Open" di Palantir AIP). HANYA
        bila pengguna meminta membuka, menampilkan atau menunjukkan sesuatu. aplikasi: konsultan (AI Agent Swarm), agents,
        ml, karantina, kontrol (Evaluasi Swarm), akses, objects (Nexus Object Explorer), lineage, pipeline. sasaran ("" bila
        tidak ada): faskes_profil_id dari hasil tool (paling tepat) atau nama faskes untuk karantina ("aturan" membuka Aturan Indikasi); nama tipe objek
        untuk objects; nama dataset/pipeline untuk lineage; "utama" atau "fakta" untuk pipeline."""
        key = (aplikasi or "").strip().lower()
        tab = key if key in TABS else ALIAS.get(key)
        if not tab:
            raise LookupError(f"aplikasi '{aplikasi}' tidak ada; pilih: {', '.join(TABS)}")
        target: dict[str, Any] = {}
        s = (sasaran or "").strip()
        if (key == "aturan" or s.lower().startswith("aturan")) and tab == "karantina":
            target["aturan"] = True
        elif s and tab == "karantina":
            fid = _faskes_id(s)
            if fid:
                target["faskes"] = fid
        elif s and tab == "objects":
            t = box.type_of(AGENT, s, any_owner=True)
            target.update(type_id=t["id"], type=t["name"])
        elif s and tab == "lineage":
            g = get("/api/lineage/graph")
            hit = [n for n in g.get("nodes") or [] if (n.get("name") or "").lower() == s.lower()] or \
                  [n for n in g.get("nodes") or [] if s.lower() in (n.get("name") or "").lower()]
            if hit:
                target.update(node_id=hit[0]["id"], node=hit[0].get("name"))
        elif s and tab == "pipeline":
            target["pipeline"] = "fakta" if s.lower().startswith("fakta") else "utama"
        label = TABS[tab] + (f" · {target.get('type') or target.get('node') or s}" if s else "")
        emit({"type": "nav", "tab": tab, "target": target, "label": label})
        return ({"dibuka": label, "ringkasan": f"membuka {label}"}, {"app": tab, "buka": {"tab": tab, **target}})

    fns: list[Callable] = [penugasan_swarm, tim_swarm, laporan_swarm, berkas_kasus, paket_audit, jaringan_agen, ml_studio, box_karantina, faskes_karantina,
                           aturan_indikasi, indikasi_fraud, pipeline_produksi, evaluasi_swarm, evaluasi_kontrol, keamanan_akses, skema_nexus, pipeline_builder]
    tools = [box.wrap(AGENT, f.__name__, f) for f in fns]
    tools.append(box.wrap(AGENT, "buka_aplikasi", buka_aplikasi, counted=False))
    tools.append(box.wrap_async(AGENT, "analisis_agen", analisis_agen))
    return tools


PER_TOOL = 5  # calls of one tool a turn may make: a model stuck on one tool is told to conclude (14 × box_karantina, 2026-10-29)


def _capped(fn: Callable, used: dict[str, int]) -> Callable:
    """fn, refused after PER_TOOL calls in a turn (its signature kept: ADK reads the tool's parameters from it)."""
    import inspect

    if inspect.iscoroutinefunction(fn):
        return fn

    def call(**kwargs: Any) -> dict:
        used[fn.__name__] = used.get(fn.__name__, 0) + 1
        # the page shows what is being read while it is read (a 35 s read showed "Memilih tool…" the whole time)
        emit({"type": "tool_mulai", "tool": fn.__name__, "args": kwargs})
        if used[fn.__name__] > PER_TOOL:
            return {"error": f"{fn.__name__} sudah dipanggil {PER_TOOL} kali: simpulkan dari hasil yang sudah ada, atau pakai tool lain "
                             "(jangan sebut batas ini di jawaban)"}
        with _RUNNING_LOCK:
            _RUNNING[fn.__name__] = _RUNNING.get(fn.__name__, 0) + 1
        try:
            return fn(**kwargs)
        finally:
            with _RUNNING_LOCK:
                _RUNNING[fn.__name__] -= 1
    call.__name__, call.__doc__ = fn.__name__, fn.__doc__
    call.__annotations__ = dict(getattr(fn, "__annotations__", {}))
    call.__signature__ = inspect.signature(fn)  # type: ignore[attr-defined]
    return call


def operator_tools(box: T.Toolbox, cat: dict, follow: str | None = None) -> list[Callable]:
    """Every tool of the operator: the apps' own, then the Nexus, lineage and ML tools the domain agents use (read only)."""
    ml_keep = {"kartu_model_ml", "kartu_bukti_model", "skor_risiko_klaim_ml", "risiko_faskes_ml", "jelaskan_klaim_ml", "verifikasi_klaim"}
    used: dict[str, int] = {}
    tools = (app_tools(box, cat, follow) + T.object_tools(box, AGENT, any_owner=True, read_only=True) + T.platform_tools(box, AGENT)
             + [f for f in T.ml_tools(box, AGENT, read_only=True) if f.__name__ in ml_keep])
    return [_capped(f, used) for f in tools]


# ------------------------------------------------------------------------------------------------ the instruction

INSTRUCTION = """Anda AIP Operator di AIP JKN: asisten yang bekerja di atas SEMUA aplikasi AIP JKN lewat tool, seperti AIP di Palantir.
Pengguna adalah tim audit dan anti-fraud BPJS Kesehatan; data adalah Data Sampel BPJS (klaim FKRTL JKN).

Aplikasi → tool:
- AI Agent Swarm (analisis fraud seluruh data oleh puluhan agen): penugasan_swarm, laporan_swarm, berkas_kasus, paket_audit,
  tim_swarm (susunan tim; lambat)
- Agen (jaringan agen AIP): jaringan_agen; analisis baru oleh agen: analisis_agen
- ML Studio (model ML klaim berisiko): ml_studio, kartu_model_ml, kartu_bukti_model, skor_risiko_klaim_ml, risiko_faskes_ml, jelaskan_klaim_ml, verifikasi_klaim
- Box Karantina (faskes prioritas audit): box_karantina, faskes_karantina, aturan_indikasi, indikasi_fraud, estimasi_kerugian_klaim
- Layanan produksi (model terpasang, run pipeline produksi, POST /verify): pipeline_produksi
- Evaluasi Swarm (mutu tiap penugasan AI Agent Swarm: kriteria, QA per lini, validator, kontrak): evaluasi_swarm;
  biaya model, run AIP, golden dan gerbang kontrol: evaluasi_kontrol
- Keamanan & Akses (akses data per peran, peran akses pengguna dan anggotanya): keamanan_akses
- Nexus · Object Explorer (objek klaim, faskes, wilayah, kode, peserta): skema_nexus, cari_objek, agregasi_objek, detail_objek, objek_terkait, jalankan_fungsi
- Data Lineage (asal-usul data, kode): telusuri_lineage, cari_nexus, baca_kode
- Pipeline Builder (pipeline data BPJS): pipeline_builder
- buka_aplikasi: membuka aplikasi di layar pengguna

Cara kerja:
1. Pilih tool yang paling langsung menjawab; panggil beberapa tool sekaligus bila saling lepas. Paling banyak sekitar 8 langkah.
2. Pertanyaan fraud tentang SATU cakupan (provinsi, kab/kota, faskes, kode INA-CBG, diagnosis, modus, kelompok klaim) atau
   estimasi kerugiannya → paket_audit DULU (hasil AI Agent Swarm, sekali baca); perbandingan beberapa cakupan → paket_audit per
   cakupan. Pertanyaan tentang satu aplikasi → tool aplikasi itu.
3. Angka HANYA dari hasil tool, dalam notasi Indonesia (1.386; 4,63 miliar; 13,9%). Jangan menjumlah, mengurangi atau membagi
   sendiri — kode memeriksa setiap angka jawaban terhadap hasil tool. Bulatkan desimal panjang secara wajar (0,16390423 → 0,164
   atau 16,4%), bukan notasi ilmiah (5,95e-05 → 0,0000595). Nama field mentah (p_vs_terbaik, setara_dengan_terbaik, auprc_acak)
   ditulis artinya dalam bahasa Indonesia, bukan namanya. Banyaknya sesuatu
   ("berapa peran/faskes/run …") diambil dari field jumlah_* atau total di hasil tool, bukan dihitung dari baris yang terlihat
   (daftar sering dipotong); tulis angka itu sebagai angka, bukan kata. Waktu ditulis WIB.
4. Sebut hasil_id dalam kurung siku sesudah angka atau temuan penting, mis. "1.386 faskes [r2]".
5. analisis_agen HANYA untuk analisis baru yang tidak dipegang aplikasi mana pun (membandingkan teknik ML, menguji hipotesis
   lintas sumber, pola yang belum dianalisis): lambat (1–3 menit). Jangan untuk pertanyaan yang bisa dibaca dari tool lain.
6. buka_aplikasi HANYA bila pengguna meminta membuka, menampilkan atau menunjukkan ("buka", "tampilkan", "tunjukkan di …").
7. Data yang tidak ada (mis. identitas dokter) → katakan tidak tersedia; jangan menebak. Tool gagal → coba cara lain sekali,
   lalu katakan apa yang tidak bisa dibaca.

Jawaban: bahasa Indonesia, markdown ringkas. Kalimat pertama langsung menjawab. Lalu poin-poin atau tabel kecil (paling banyak
6 baris). Tanpa basa-basi, tanpa mengulang pertanyaan, tanpa menyebut nama tool, batas atau pemeriksaan, tanpa menceritakan
proses kerja Anda, tanpa emoji.
Baris TERAKHIR jawaban selalu: "SARAN: <langkah lanjutan 1> | <2> | <3>" — tiga pertanyaan atau perintah lanjutan yang berguna,
pendek (≤ 9 kata), yang bisa Anda kerjakan dengan tool di atas. Membuka aplikasi hanya ke tab yang ada (AI Agent Swarm, Agen, ML
Studio, Box Karantina, Evaluasi Swarm, Keamanan & Akses, Nexus, Data Lineage, Pipeline Builder); layanan produksi tidak punya tab.
"""


def instruction(cat: dict, tab: str) -> str:
    types_ = "; ".join(f"{t['name']}" for a in cat["agents"] for t in a["object_types"])
    now = datetime.now(WIB).strftime("%Y-%m-%d")  # the day, not the minute: the prompt stays the same and Vertex caches it
    # the length the screen holds: the dock beside another tab is a narrow column (a 130-number answer filled it, 2026-10-28)
    if tab in TABS and tab != "agents":
        where = (f"Pengguna sedang membuka tab {TABS[tab]}; percakapan tampil di panel sempit di sampingnya: jawaban paling banyak "
                 "sekitar 120 kata dan tabel paling banyak 3 kolom, kecuali pengguna meminta rincian.")
    else:
        where = "Pengguna di tab Agen (percakapan penuh): jawaban paling banyak sekitar 220 kata, kecuali pengguna meminta rincian."
    return f"{INSTRUCTION}\nTipe objek Nexus: {types_}.\n{where} Sekarang {now}.\n{A.LANG}"


# ------------------------------------------------------------------------------------------------ one turn


WORK_PHASE = """
FASE KERJA (sekarang): kumpulkan data dengan tool, dan buka aplikasi bila diminta. Bila data sudah cukup — atau pertanyaan tidak
butuh data — balas HANYA satu kata: SIAP. Jawaban untuk pengguna ditulis sesudahnya, terpisah, dari hasil tool Anda."""
WRITE = ("Tulis sekarang jawaban untuk pengguna, hanya dari hasil tool di atas (tidak ada tool lagi), dengan aturan jawaban di atas: angka "
         "dari hasil tool, hasil_id dalam kurung siku, ringkas, baris SARAN di akhir. Bila hasil tool kosong, jawab sesuai aturan (sapaan, "
         "di luar lingkup, data tidak tersedia).")
DELTA_SECONDS = 0.15  # the written answer goes to the page in pieces this often (or every DELTA_CHARS)
DELTA_CHARS = 48


def writer_messages(cat: dict, tab: str, q: str, thread: str, box: T.Toolbox, unfinished: list[str] | None = None) -> list[dict]:
    """The writer's prompt: the operator's rules, the conversation, the question and everything the tools returned."""
    def flat(v: Any) -> list[str]:  # hasil_id is one id, a list of them (the model cards) or a dict of either
        if isinstance(v, str):
            return [v]
        if isinstance(v, dict):
            v = list(v.values())
        return [i for y in v for i in flat(y)] if isinstance(v, (list, tuple)) else []

    def head(x: dict) -> str:  # the read's hasil_id first: the writer cites [r3], not the tool's name (seen: "[keamanan_akses]")
        ids = flat((x.get("result") or {}).get("hasil_id")) if isinstance(x.get("result"), dict) else []
        return f"### Hasil {', '.join(ids) or '(tanpa hasil_id)'} — dibaca dengan {x['tool']}"
    reads = [f"{head(x)}\n{json.dumps(x['result'], ensure_ascii=False, default=str)[:9000]}" for xs in box.seen.values() for x in xs]
    user = ((f"Percakapan sebelumnya:\n{thread}\n" if thread else "") + f"Pertanyaan: {q}\n\nHasil tool:\n"
            + ("\n\n".join(reads) or "(tidak ada: pertanyaan ini tidak membaca data)") + "\n\n"
            + (f"Catatan: bacaan {', '.join(unfinished)} belum selesai dalam batas waktu — katakan datanya belum sempat terbaca dan sarankan "
               "bertanya lagi; JANGAN menyebut datanya tidak tersedia.\n\n" if unfinished else "") + WRITE)
    return [{"role": "system", "content": instruction(cat, tab)}, {"role": "user", "content": user}]


async def write_answer(inp: dict, model: str, messages: list[dict], seg: int) -> str:
    """The answer, written by the model in a stream through the platform's gateway: each piece goes to the page as a "delta"
    event (seg: the attempt — 2 is the revision). A stream that fails (a 429 before it starts, a cut connection) is written
    once more as a whole through the gateway's retries and failover, and sent as one piece."""
    import httpx

    url = f"{inp['api'].rstrip('/')}/api/aip/openai/v1/chat/completions"
    headers = {"X-AIP-Run": inp["run_id"], "X-AIP-Agent": AGENT, **({"Authorization": f"Bearer {inp['token']}"} if inp.get("token") else {})}
    fam = A.aip_models.family(model)
    body = {"model": model, "messages": messages, "max_tokens": 3000, "temperature": 0.1,
            **({"chat_template_kwargs": {"enable_thinking": False}} if fam == "zai-org" else {"reasoning_effort": "low"} if fam == "openai" else {})}
    timeout = httpx.Timeout(A.aip_models.client_timeout(3000), connect=15)
    text, buf, last = "", "", time.time()

    def flush() -> None:
        nonlocal buf, last
        if buf:
            emit({"type": "delta", "seg": seg, "text": buf})
            buf, last = "", time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            async with c.stream("POST", url, headers=headers, json={**body, "stream": True}) as r:
                if r.status_code != 200:
                    raise RuntimeError(f"stream {r.status_code}")
                async for line in r.aiter_lines():
                    data = line[5:].strip() if line.startswith("data:") else ""
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    for ch in chunk.get("choices") or []:
                        piece = (ch.get("delta") or {}).get("content") or ""
                        if piece:
                            text += piece
                            buf += piece
                            if len(buf) >= DELTA_CHARS or time.time() - last >= DELTA_SECONDS:
                                flush()
        flush()
        if text.strip():
            return text.rsplit("</think>", 1)[-1].strip()
    except Exception as e:  # noqa: BLE001 - written whole instead
        flush()
        emit({"type": "catatan_sistem", "text": f"jawaban ditulis tanpa stream ({type(e).__name__}: {str(e)[:120]})"})
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(url, headers=headers, json={**body, "stream": False})
    if r.status_code != 200:
        raise RuntimeError(f"model gateway {r.status_code}: {r.text[:300]}")
    whole = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    emit({"type": "delta", "seg": seg, "text": whole, "utuh": True})
    return whole.rsplit("</think>", 1)[-1].strip()


async def _turn(runner: Runner, sid: str, text: str) -> str:
    """One message to the operator; its words between tool calls become notes on the page, its final text comes back."""
    final = ""
    msg = types.Content(role="user", parts=[types.Part(text=text)])
    try:
        async for ev in runner.run_async(user_id="aip", session_id=sid, new_message=msg, run_config=RunConfig(max_llm_calls=CALLS, tool_thread_pool_config=ToolThreadPoolConfig(max_workers=TOOL_THREADS))):
            if getattr(ev, "error_message", None):
                emit({"type": "error", "agent": AGENT, "message": ev.error_message})
            parts = (ev.content.parts if ev.content else None) or []
            words = "".join(x.text or "" for x in parts if getattr(x, "text", None) and not getattr(x, "thought", False)).strip()
            if not words:
                continue
            if ev.is_final_response():
                final = words
            elif any(getattr(x, "function_call", None) for x in parts):
                emit({"type": "catatan", "agent": AGENT, "text": words[:800]})
    except LlmCallsLimitExceededError:
        emit({"type": "error", "agent": AGENT, "message": f"batas {CALLS} panggilan model tercapai: jawaban disusun dari yang sudah dibaca"})
    return final


async def operator(inp: dict) -> None:
    p = Platform(inp["api"], inp.get("token", ""))
    m = A.Models(inp["api"], inp.get("token", ""), inp["run_id"])
    q, hist, tab = inp["q"], inp.get("history") or [], str(inp.get("tab") or "agents")
    cat = inp.get("catalogue") or p.get("/api/aip/agents")  # sent with the input by aip/runs.py (kept there a minute)
    model = OPERATOR_MODEL if OPERATOR_MODEL and A.aip_models.ready(OPERATOR_MODEL) else cat["roles"]["tools"]
    box = T.Toolbox(p, cat)
    box.limits[AGENT] = STEPS
    tools = operator_tools(box, cat, inp.get("follow"))
    emit({"type": "run", "status": "started", "mode": "operator", "model": model, "tab": tab, "tools": [f.__name__ for f in tools]})

    agent = LlmAgent(name=AGENT, model=m.llm(model, AGENT, 1500), instruction=lambda _ctx: instruction(cat, tab) + WORK_PHASE, tools=tools)
    service = InMemorySessionService()
    runner = Runner(app_name=APP, agent=agent, session_service=service)
    s = await service.create_session(app_name=APP, user_id="aip")
    thread = "".join(f"{'Pengguna' if h.get('role') == 'user' else 'AIP'}: {h.get('text')}\n"
                     + (f"(data yang dibaca jawaban itu: {h['data']})\n" if h.get("data") else "") for h in hist[-8:])
    text = (f"Percakapan sebelumnya:\n{thread}\nPertanyaan sekarang: {q}" if thread else q)

    # the work — tools, apps opened — until the model says SIAP or its STEPS / CALLS run out: no time cut (HANG_SECONDS)
    t0 = time.time()
    try:
        await asyncio.wait_for(_turn(runner, s.id, text), HANG_SECONDS)
    except asyncio.TimeoutError:
        # hung: a read already under way is waited for a little, then the answer is written from what was read
        cut = time.time()
        while any(_RUNNING.values()) and time.time() - cut < TOOL_GRACE:
            await asyncio.sleep(0.2)
        emit({"type": "catatan_sistem", "text": f"pengumpulan data macet lebih dari {HANG_SECONDS // 60} menit: jawaban disusun dari yang sudah terbaca"})
    # the answer, written from what the tools returned and streamed to the page as it is written (the user, 2026-10-29:
    # "bikin interaktif kayak chat sama claude")
    messages = writer_messages(cat, tab, q, thread, box, [k for k, v in _RUNNING.items() if v > 0])
    emit({"type": "fase", "fase": "tulis", "detik": round(time.time() - t0, 1)})  # where a turn's time went (not shown)
    raw = await write_answer(inp, model, messages, seg=1)
    answer, steps = _split(raw)
    answer = own_citations(answer, set(box.rows))
    tool_names = "|".join(re.escape(f.__name__) for f in tools)
    answer = re.sub(rf"\s*\[(?:{tool_names})(?:\s*,\s*(?:{tool_names}))*\]", "", answer)  # a tool's name is no citation

    # the number gate (code, not a model): every number of the answer is in what the tools returned, the question or the thread
    def source() -> str:
        text = "\n".join([q] + [str(h.get("text") or "") for h in hist]
                         + [_id_text(x["args"]) + "\n" + _id_text(x["result"]) for xs in box.seen.values() for x in xs])
        return re.sub(r"(?<=\d)_(?=\d{3})", "", text)  # a number in code read as one (CHUNK = 250_000 is the answer's 250.000)
    n, fails = check_numbers(answer, source())
    revised = False
    if fails and answer:  # every time the gate finds a number (no longer only with time left in a 30-second turn)
        emit({"type": "cek_angka", "ok": False, "diperiksa": n, "gagal": fails, "tahap": "revisi"})
        # the revision is bounded: a model call that hangs (180 s on 2026-10-29) leaves the first answer, its numbers flagged
        try:
            fix = await asyncio.wait_for(write_answer(inp, model, messages + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": "PEMERIKSA ANGKA (kode): " + "; ".join(fails[:8]) + ".\nTulis ulang SELURUH jawaban: setiap angka harus "
                                            "tertulis di hasil tool di atas; jangan menjumlah, membagi atau membulatkan sendiri; hilangkan angka yang "
                                            "tidak ada. Jawaban untuk pengguna saja: jangan menyebut pemeriksaan ini, tool, batas, atau proses kerja. "
                                            "Tetap akhiri dengan baris SARAN."}], seg=2), REVISION_SECONDS)
        except asyncio.TimeoutError:
            fix = ""
            emit({"type": "catatan_sistem", "text": "revisi angka melewati batas waktu: jawaban pertama ditampilkan, angkanya ditandai"})
        if fix.strip():
            answer, steps2 = _split(fix)
            answer = own_citations(answer, set(box.rows))
            steps = steps2 or steps
            revised = True
            n, fails = check_numbers(answer, source())
    emit({"type": "cek_angka", "ok": not fails, "diperiksa": n, "gagal": fails, "direvisi": revised})
    # the gate for "… buka di <app>" (code, not the prompt): the model sometimes read the app and forgot to open it
    # (2026-10-28, "Dari mana dataset klaim_berisiko berasal? Buka di Data Lineage.")
    want = asked_to_open(q)
    receipts = box.receipts.get(AGENT, [])
    if want and want in TABS and not any(r.get("tool") == "buka_aplikasi" and r.get("ok") for r in receipts):
        target = opened_target(want, receipts)
        if want == "karantina" and "aturan" in q.lower() and not target:
            target = {"aturan": True}
        emit({"type": "nav", "tab": want, "target": target, "oleh": "kode",
              "label": TABS[want] + (f" · {target.get('node') or target.get('type') or ''}" if target.get("node") or target.get("type") else "")})
    emit({"type": "answer", "agent": AGENT, "text": answer or "Maaf, jawaban tidak tersusun. Coba ulangi pertanyaannya.", "saran": steps,
          "tools": sum(len(v) for v in box.receipts.values())})


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():  # a runtime started ahead (aip/runs.py) whose API stopped before it got a turn
        return
    inp = json.loads(raw)
    try:
        if inp.get("kind") != "operator":
            raise ValueError(f"unknown run kind {inp.get('kind')!r}")
        asyncio.run(operator(inp))
        emit({"type": "done"})
    except Exception as e:  # noqa: BLE001 - the page shows why the run stopped
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"[:1000]})
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
