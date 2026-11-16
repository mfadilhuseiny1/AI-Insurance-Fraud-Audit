"""Konfigurasi agen of the AI Agent Swarm: every agent of the firm as the IT team and the auditors see and set it — the
algorithm it runs, its model and limits, the tools it holds, the prompt it is given — and what may be changed, kept in
data/aip/konsultan_agen.json and handed to every engagement started after the change (konsultan.start → firm.Firm).

The user, 2026-10-29: "tombol configure agent disini, jadi saya bisa liat algoritma yang digunakan agen, tool yang
digunakan agen, prompt yang digunakan agen dan semua konfigurasi dari masing2 agen yang bisa di edit juga".

Read, not retold: the prompt templates and the tools' descriptions are parsed from the runtime's own source
(adk_runtime/firm.py, tools.py: the f-string an agent is given, placeholders and all); the default limits are firm.CALLS
and firm.TOKENS; a technique's algorithm is ml_klaim.MODELS with its research. The prompt and tools an agent actually got
are in each engagement's trail (event `instruksi`, written by firm.Firm.work since 2026-10-29), shown when there is one,
with the tools the agent called in the latest engagement and how many of those calls failed.

What may be changed (admin), each checked here in code: the model (enabled on Vertex, with tool calling; a QA reviewer,
the validator and the red team never of the partner's family), tool steps, model calls, answer tokens, reasoning depth,
tools switched off (never the one that closes an agent's work: its tag, recommendation, verdict or technique), an extra
instruction (no links, no orders to change data or ignore the rules: the gate of the skills' lessons), and a technique's
folds and top facilities. A role's setting holds for all its instances (each investigator, each red team).

    GET    /api/aip/agen-swarm            every agent: identity, effective model and limits, whether it was changed
    GET    /api/aip/agen-swarm/{key}      one agent: algorithm, tools, prompt template, skill, its last real instruction
    PUT    /api/aip/agen-swarm/{key}      change its settings (admin)
    DELETE /api/aip/agen-swarm/{key}      back to the defaults (admin)
"""

from __future__ import annotations

import ast
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip/agen-swarm")

RUNTIME = Path(__file__).resolve().parent / "adk_runtime"
_lock = threading.Lock()
_parsed: dict[str, Any] = {}
_usage: dict[str, Any] = {}

# the reasoning depth a model is asked for (adk_runtime/agents.Models.llm `think`)
PENALARAN = {"rendah": "", "sedang": "medium", "dalam": "deep"}
# the tool that closes an agent's work: never switched off
REQUIRED = {"tandai_indikasi", "rekomendasi_jalur", "putusan_red_team", "jalankan_teknik"}
LIMITS = {"langkah_tool": (1, 60), "panggilan_model": (2, 80), "token_jawaban": (1000, 20000), "lipatan": (2, 5), "faskes_teratas": (10, 50)}

SEM = ["kamus_semantik", "ukur"]
READ = ["cari_objek", "agregasi_objek", "detail_objek", "objek_terkait", "jalankan_fungsi", "estimasi_kerugian_klaim",
        "skor_risiko_klaim_ml", "risiko_faskes_ml", "jelaskan_klaim_ml", "verifikasi_klaim"]
# the tools each kind of agent is given (adk_runtime/firm.py: phase_0, analyst, technique, investigate, synthesize, review,
# phase_5 challenge, phase_6); an engagement's own `instruksi` events say what each agent actually got
TOOLS = {
    "partner": SEM + ["lihat_indikasi", "lihat_karantina"],
    "manajer": SEM + ["lihat_indikasi", "baca_hasil"],
    "analis": SEM + READ + ["tandai_indikasi", "tandai_hasil", "lihat_indikasi"],
    "ml": ["jalankan_teknik"],
    "penyidik": SEM + READ + ["tandai_indikasi", "lihat_indikasi", "rekomendasi_jalur"],
    "qa": SEM + READ + ["lihat_indikasi", "baca_hasil"],
    "red_team": SEM + READ + ["putusan_red_team"],
    "validator": SEM + ["cari_objek", "agregasi_objek", "detail_objek", "objek_terkait", "jalankan_fungsi", "estimasi_kerugian_klaim",
                        "lihat_indikasi", "lihat_karantina", "baca_hasil"],
    "editor": [], "analis_exhibit": [], "redaksi": [],
}
# the prompt templates: (title, path of the function in firm.py, the variable holding the text)
PROMPTS = {
    "partner": [("Rencana penugasan dan kontrak", ("Firm", "phase_0"), "text"), ("Bahan laporan akhir", ("Firm", "phase_6"), "material")],
    "manajer": [("Sintesis agen domain", ("Firm", "synthesize"), "text")],
    "analis": [("Kerja lapangan", ("Firm", "analyst"), "text")],
    "ml": [("Sub-agen teknik ML", ("Firm", "technique"), "text")],
    "penyidik": [("Kertas kerja penyidik", ("Firm", "investigate"), "text")],
    "qa": [("Reviewer QA", ("Firm", "review"), "text")],
    "red_team": [("Red team", ("Firm", "phase_5", "challenge"), "text")],
    "validator": [("Validator laporan akhir", ("Firm", "phase_6"), "vtext")],
    "editor": [("Editor laporan", ("Firm", "edit", "one"), "text")],
}
# the role whose CALLS/TOKENS hold an agent kind's defaults (firm.Firm.work's `role`)
ROLE = {"partner": "partner", "manajer": "manajer", "analis": "analis", "ml": "ml", "penyidik": "penyidik", "qa": "qa", "red_team": "red_team",
        "validator": "validator"}
# the skill each kind works from (firm.py: self.skill / work(skill=…)); an analyst's by its line
SKILL = {"partner": ["rencana_penugasan", "laporan_akhir"], "manajer": ["sintesis_agen_domain"], "ml": ["sub_agen_teknik"], "penyidik": ["penyidik_kasus"],
         "qa": ["reviewer_qa"], "red_team": ["red_team"]}
ALGORITMA = {
    "partner": "LLM dengan tool calling (Google ADK). Fase penugasan: membaca lanskap data lewat lapisan semantik, menulis rencana (hipotesis, "
               "fokus tiap lini) dan kontrak validasi sebagai JSON sebelum agen lain bekerja. Fase laporan: kerangka dulu (STORM) — butir per bagian "
               "dengan sumbernya, kode membuang butir tanpa sumber, tiap bagian ditulis dari butirnya, kode menggabungkan; tabel box dan kasus dari data.",
    "manajer": "LLM dengan tool calling: menyintesis laporan agen kecilnya (pola berulang, temuan terkuat dengan hasil_id, hipotesis didukung/"
               "dibantah, celah); boleh memeriksa ulang beberapa angka. Gerbang kode setelahnya: setiap sintesis mengutip hasil_id yang ada.",
    "analis": "LLM dengan tool calling (ReAct, Google ADK): membaca data nyata lewat lapisan semantik (ukuran dengan definisi sama untuk semua agen) "
              "dan objek Nexus, membandingkan dengan peer setipe, lalu menandai setiap indikasi. Gerbang bukti di kode: tag harus menunjuk hasil "
              "bacaan agen itu sendiri yang memuat objeknya; KLONING pada skema COVID dan KOREKSI_BERULANG dengan < 2 koreksi ditolak.",
    "penyidik": "LLM dengan tool calling: satu instans berkonteks segar per faskes antrean Box Karantina — kertas kerja audit, uji sinyal TSM dari data, "
                "rekomendasi jalur. Gerbang TSM di kode: 'ditindak' hanya bila Terstruktur, Sistematis dan Masif terpenuhi menurut penyidik DAN "
                "menurut data box; selain itu 'dibina' (manusia yang memutuskan).",
    "qa": "LLM dari keluarga model lain (bukan keluarga pimpinan): memeriksa klaim sintesis satu agen domain terhadap hasil penugasan (baca_hasil) "
          "dan data Nexus/ML; putusan JSON per klaim. Ringkasan QA untuk orkestrator ditulis kode.",
    "red_team": "LLM: satu instans per indikasi terkuat (sedang ke atas, dari agen) — membela penjelasan wajarnya (kelas faskes, case-mix, rawat "
                "ulang sah, diagnosis langka, faskes kecil, COVID), lalu memutus bertahan atau melemah; putusan mengubah kekuatan tag di buku besar.",
    "validator": "LLM dari keluarga lain: memeriksa 5–8 angka terpenting laporan akhir dan setiap pernyataan kontrak dengan bacaannya sendiri; satu "
                 "revisi bagian yang terkena. Rekonsiliasi kode: hitungan Nexus yang memuat tag ditolak manusia dicocokkan dengan buku besar.",
    "editor": "LLM: menyunting bahasa tiap bagian laporan. Kode menolak suntingan yang mengubah angka, rujukan [rN], kode tag atau panjang > ±50%.",
    "analis_exhibit": "LLM: menulis makna tiap exhibit laporan lengkap dari faktanya (aip/laporan_konsultan.py); kalimat yang angkanya tidak ada di "
                      "fakta exhibit dibuang kode.",
    "redaksi": "Kode (tanpa model): menjalankan editor dan analis exhibit, menolak suntingan yang mengubah angka, membekukan exhibit dan berkas kasus.",
}
MESIN = {
    "penanda_otomatis": "Aturan lapisan semantik (aip/indikasi.py auto_tag) atas semua objek: setiap sinyal jadi tag dengan kekuatannya (mis. "
                        "KOREKSI_BERULANG faskes bila rasio aktual/ekspektasi ≥ 2 dengan ekspektasi ≥ 1; kuat bila ≥ 4 dan ≥ 2).",
    "konsensus_ml": "Deterministik (firm.Firm.consensus): faskes di 25 teratas tiap teknik ML; kuat bila ≥ 75% teknik, sedang ≥ 50%, lemah ≥ 1/3 "
                    "→ tag KONSENSUS_TEKNIK_ML.",
    "karantina": "Deterministik (aip/karantina.py build): estimasi kerugian per klaim bertag yang belum dikoreksi, kelompok Pareto A … Z, sinyal TSM "
                 "berpoin (modus, layanan, kode INA-CBG, jaringan; bulan, koreksi; kelompok, klaim, peserta, porsi).",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _file() -> Path:
    from aip import runs

    return runs._dir().parent / "konsultan_agen.json"


def _load() -> dict:
    try:
        return json.loads(_file().read_text("utf-8"))
    except FileNotFoundError:
        return {"agen": {}, "riwayat": []}
    except (OSError, ValueError) as e:  # a read error is an error, never an empty file a write would then keep
        raise HTTPException(500, f"konfigurasi agen tidak terbaca: {e}") from e


def _save(st: dict) -> None:
    from aip.runs import _write

    _write(_file(), st)


def active() -> dict[str, dict]:
    """The settings changed from the defaults, per agent or role key: what konsultan.start hands the engagement."""
    with _lock:
        return {k: {x: v for x, v in c.items() if x not in ("diubah_pada", "diubah_oleh")} for k, c in (_load().get("agen") or {}).items()}


# ------------------------------------------------------------------------------------------------ the runtime's own source


def _source() -> dict:
    """firm.py and tools.py parsed once per change: the prompt templates, every tool's description, CALLS/TOKENS, RULES."""
    stamp = tuple((RUNTIME / f).stat().st_mtime_ns for f in ("firm.py", "tools.py"))
    with _lock:
        if _parsed.get("stamp") == stamp:
            return _parsed
        firm_src = (RUNTIME / "firm.py").read_text("utf-8")
        trees = {"firm": ast.parse(firm_src), "tools": ast.parse((RUNTIME / "tools.py").read_text("utf-8"))}
        docs: dict[str, str] = {}
        for tree in trees.values():
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name not in docs:
                    d = ast.get_docstring(node)
                    if d:
                        docs[node.name] = re.sub(r"\s+", " ", d).strip()
        consts: dict[str, Any] = {}
        for node in trees["firm"].body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ("CALLS", "TOKENS", "RULES"):
                consts[node.targets[0].id] = ast.literal_eval(node.value)
        _parsed.clear()
        _parsed.update(stamp=stamp, docs=docs, src=firm_src, tree=trees["firm"], **consts)
        return _parsed


def _template(path: tuple[str, ...], var: str) -> Optional[str]:
    """The f-string a function of firm.py assigns to `var`, as written: the prompt with its placeholders."""
    p = _source()
    scope: list[ast.AST] = p["tree"].body
    node: Optional[ast.AST] = None
    for name in path:
        node = next((n for n in scope if isinstance(n, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name), None)
        if node is None:  # a nested function sits deeper than the top of its parent (inside an if, a loop): search all of it
            node = next((n for parent in scope for n in ast.walk(parent) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name), None)
        if node is None:
            return None
        scope = node.body  # type: ignore[attr-defined]
    for n in ast.walk(node):  # type: ignore[arg-type]
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == var for t in n.targets) and isinstance(n.value, ast.JoinedStr):
            seg = ast.get_source_segment(p["src"], n.value) or ""
            return re.sub(r'^f"""|"""$', "", seg).strip("\r\n")
    return None


# ------------------------------------------------------------------------------------------------ the firm's agents


def kind(a: dict) -> str:
    """The kind of agent (its tools, prompt and default limits): from its role code, the ML line apart."""
    code = a.get("peran_kode") or ""
    if code == "analis" and a.get("lini") == "ml":
        return "ml"
    return code if code in ALGORITMA else "analis" if a.get("jenjang") == "analis" else code or "analis"


def _team() -> list[dict]:
    """The firm as the latest engagement formed it (the firm state konsultan.start keeps), with the report desk and the
    machines; the full roster (/api/aip/konsultan/tim) takes half a minute to size, this reads what was sized."""
    from aip import indikasi as I
    from aip import konsultan as K

    firm = I._state().get("firma") or {}
    tim = [dict(a) for a in firm.get("tim") or []]
    if not tim:
        tim, _ = K.roster()
    have = {a["key"] for a in tim}
    tim += [a for a in K.report_team(K._models()) if a["key"] not in have]
    return tim


def _technique(a: dict) -> Optional[str]:
    import ml_klaim

    name = re.sub(r"^Sub-agen\s+", "", a.get("name") or "")
    return name if name in ml_klaim.MODELS else None


def _effective(a: dict, cfg: dict) -> dict:
    """An agent's settings as an engagement would run it: the defaults with what was changed."""
    p = _source()
    k = kind(a)
    calls, tokens = p.get("CALLS", {}).get(ROLE.get(k, ""), (None, None)), p.get("TOKENS", {}).get(ROLE.get(k, ""))
    out = {"model": cfg.get("model") or a.get("model"), "langkah_tool": cfg.get("langkah_tool") or calls[0], "panggilan_model": cfg.get("panggilan_model") or calls[1],
           "token_jawaban": cfg.get("token_jawaban") or tokens, "penalaran": cfg.get("penalaran") or ("dalam" if k == "partner" else "sedang" if k in ("qa", "validator") else "rendah"),
           "tool_nonaktif": cfg.get("tool_nonaktif") or [], "instruksi_tambahan": cfg.get("instruksi_tambahan") or ""}
    if k == "ml":
        out.update(lipatan=cfg.get("lipatan") or 3, faskes_teratas=cfg.get("faskes_teratas") or 25)
    return out


def _latest_usage() -> dict:
    """From the newest finished engagement that ran its own phases (not a rewrite): each agent's tool calls and their
    failures; and from the newest trail holding them, each agent's real instruction (`instruksi` events)."""
    from aip import runs

    recs = sorted((r for r in runs.list_runs(300) if r.get("kind") == "konsultan" and r.get("status") in ("succeeded", "running")),
                  key=lambda r: r.get("created_at") or "", reverse=True)
    eng = next((r for r in recs if r.get("status") == "succeeded" and not r.get("ulang_laporan")), None)
    key = tuple((r["id"], r.get("status")) for r in recs[:6])
    with _lock:
        if _usage.get("key") == key:
            return _usage
    tools: dict[str, dict[str, list[int]]] = {}
    if eng:
        for e in runs._events(eng["id"]):
            if e.get("type") == "tool" and e.get("agent"):
                c = tools.setdefault(e["agent"], {}).setdefault(e.get("tool") or "?", [0, 0])
                c[0] += 1
                c[1] += e.get("ok") is False
    told: dict[str, dict] = {}
    for r in recs[:6]:  # the newest trails: an agent's latest instruction wins
        for e in runs._events(r["id"]):
            if e.get("type") == "instruksi" and e.get("agent") and e["agent"] not in told:
                told[e["agent"]] = {**e, "run": r["id"]}
        if told:
            break
    with _lock:
        _usage.clear()
        _usage.update(key=key, run=(eng or {}).get("id"), run_nama=(eng or {}).get("nama"), tools=tools, told=told)
        return _usage


def _summary(a: dict, cfg: dict) -> dict:
    return {**{x: a.get(x) for x in ("key", "name", "lini", "jenjang", "induk", "peran", "peran_kode")}, "jenis": kind(a),
            "model_bawaan": a.get("model"), "efektif": _effective(a, cfg), "diubah": bool(cfg), "diubah_pada": cfg.get("diubah_pada"),
            "teknik": _technique(a) if kind(a) == "ml" else None}


@router.get("")
def agents() -> dict:
    from aip import konsultan as K
    from aip import models as aip_models

    st = _load()
    tim = _team()
    models = [{"id": m["id"], "label": m["label"], "keluarga": m["family"], "siap": bool(m["ready"] and m["tools"])}
              for m in aip_models.catalogue()["models"] if m["tools"] or m["ready"]]
    return {"agen": [_summary(a, (st.get("agen") or {}).get(a["key"]) or {}) for a in tim],
            "mesin": [{**m, "algoritma": MESIN.get(m["key"], "")} for m in K.MACHINES],
            "model": models, "penalaran": list(PENALARAN), "batas": {k: {"min": lo, "maks": hi} for k, (lo, hi) in LIMITS.items()},
            "riwayat": (st.get("riwayat") or [])[-30:][::-1]}


@router.get("/{key}")
def agent(key: str) -> dict:
    import ml_klaim

    from aip import skills

    st = _load()
    a = next((x for x in _team() if x["key"] == key), None)
    if not a:
        raise HTTPException(404, f"agen {key} tidak ada di firma")
    cfg = (st.get("agen") or {}).get(key) or {}
    k = kind(a)
    p = _source()
    names = list(TOOLS.get(k) or [])
    if k == "manajer" and a.get("lini") == "kasus":
        names.append("lihat_karantina")
    if k == "manajer" and a.get("lini") == "ml":
        names += ["risiko_faskes_ml", "kartu_model_ml"]
    use = _latest_usage()
    mine = [x["key"] for x in _team() if x["key"] == key] + ([e for e in use["tools"] if e.startswith("penyidik_")] if key == "penyidik_kasus" else
                                                              [e for e in use["tools"] if e.startswith("redteam_")] if key == "red_team" else [])
    called: dict[str, list[int]] = {}
    for agent_key in mine:
        for t, (n, bad) in (use["tools"].get(agent_key) or {}).items():
            c = called.setdefault(t, [0, 0])
            c[0] += n
            c[1] += bad
    templates = [{"judul": title, "fungsi": ".".join(path), "teks": _template(path, var)} for title, path, var in PROMPTS.get(k, [])]
    skill_keys = SKILL.get(k, []) if k != "analis" else [{"wilayah": "analis_wilayah", "modus": "spesialis_modus", "peer": "analis_peer"}.get(a.get("lini") or "", "analis_wilayah")]
    cat = {s["key"]: s for s in skills.catalogue()}
    told = use["told"].get(key) or next((v for kk, v in use["told"].items() if v.get("instans_dari") == key), None)
    algo: dict[str, Any] = {"ringkas": ALGORITMA.get(k, "")}
    tech = _technique(a) if k == "ml" else None
    if tech:
        fam, ref = ml_klaim.MODELS[tech]
        algo.update(teknik=tech, keluarga=fam, rujukan=ref,
                    riset=[{x: r.get(x) for x in ("penulis", "tahun", "judul", "venue", "url")} for r in ml_klaim.RESEARCH.get(tech, [])],
                    protokol={"tugas": "rumah_sakit (klaim rumah sakit, label nyata: dikoreksi verifikator)", "validasi": "validasi silang dikelompokkan per faskes",
                              "porsi_negatif_latih": ml_klaim.TRAIN_NEG, "koreksi_prior": "odds × porsi negatif (probabilitas kembali ke skala populasi)",
                              "metrik": "AUPRC, AUROC, F1, presisi, recall, lift 0,1%; kalibrasi out-of-fold: kalibrasi_ae (aktual/ekspektasi), Brier, ECE"})
    return {**_summary(a, cfg), "algoritma": algo, "aturan_firma": p.get("RULES"),
            "tool": [{"nama": n, "deskripsi": p["docs"].get(n, ""), "wajib": n in REQUIRED, "nonaktif": n in (cfg.get("tool_nonaktif") or []),
                      "dipanggil": (called.get(n) or [0, 0])[0], "gagal": (called.get(n) or [0, 0])[1]} for n in names],
            "tool_lain_dipanggil": [{"nama": t, "dipanggil": n, "gagal": bad} for t, (n, bad) in called.items() if t not in names],
            "penugasan_acuan": {"run": use.get("run"), "nama": use.get("run_nama")},
            "prompt": templates, "skill": [{**{x: cat[s].get(x) for x in ("key", "nama", "untuk", "langkah", "wajib", "keluaran", "versi")}, "pelajaran": cat[s].get("pelajaran")}
                                           for s in skill_keys if s in cat],
            "instruksi_terakhir": {x: told.get(x) for x in ("run", "t", "model", "batas", "tools", "teks", "prompt", "konfigurasi")} if told else None,
            "bawaan": _effective(a, {}), "setelan": {x: v for x, v in cfg.items() if x not in ("diubah_pada", "diubah_oleh")}}


class ConfigIn(BaseModel):
    model: Optional[str] = Field(None, max_length=120)
    langkah_tool: Optional[int] = None
    panggilan_model: Optional[int] = None
    token_jawaban: Optional[int] = None
    penalaran: Optional[str] = None
    tool_nonaktif: list[str] = Field(default_factory=list)
    instruksi_tambahan: str = Field("", max_length=2000)
    lipatan: Optional[int] = None
    faskes_teratas: Optional[int] = None


def check(a: dict, req: ConfigIn, tim: list[dict]) -> dict:
    """The settings an engagement may run with, or a 422 saying why not (gates in code, as the project's seats)."""
    from aip import models as aip_models
    from aip import skills

    k = kind(a)
    bad = []
    out: dict[str, Any] = {}
    if req.model and req.model != a.get("model"):
        spec = aip_models.MODELS.get(req.model)
        if not spec or not aip_models.ready(req.model):
            bad.append(f"model {req.model} belum diaktifkan di Vertex")
        elif not spec.get("tools") and TOOLS.get(k):
            bad.append(f"{spec['label']} tidak bisa memanggil tool")
        load_cfg = _load().get("agen") or {}
        lead = (load_cfg.get("partner") or {}).get("model") or next((x["model"] for x in tim if x["key"] == "partner"), "")
        if k in ("qa", "validator", "red_team") and aip_models.family(req.model) == aip_models.family(lead):
            bad.append(f"{a['name']} harus dari keluarga model lain dari model pimpinan ({lead})")
        if k == "partner":  # the reviewers already set may not end up in the lead's family
            same = [x["name"] for x in tim if kind(x) in ("qa", "validator", "red_team")
                    and aip_models.family((load_cfg.get(x["key"]) or {}).get("model") or x["model"]) == aip_models.family(req.model)]
            if same:
                bad.append(f"model pimpinan sekeluarga dengan {', '.join(same[:3])}: QA, validator dan red team harus dari keluarga lain")
        out["model"] = req.model
    for f in ("langkah_tool", "panggilan_model", "token_jawaban", "lipatan", "faskes_teratas"):
        v = getattr(req, f)
        if v is None:
            continue
        if f in ("lipatan", "faskes_teratas") and k != "ml":
            bad.append(f"{f} hanya untuk sub-agen teknik ML")
            continue
        lo, hi = LIMITS[f]
        if not lo <= v <= hi:
            bad.append(f"{f} harus {lo}–{hi}")
        out[f] = v
    if req.penalaran:
        if req.penalaran not in PENALARAN:
            bad.append(f"penalaran: {', '.join(PENALARAN)}")
        out["penalaran"] = req.penalaran
    if req.tool_nonaktif:
        allowed = set(TOOLS.get(k) or []) | {"lihat_karantina", "risiko_faskes_ml", "kartu_model_ml"}
        wrong = [t for t in req.tool_nonaktif if t not in allowed]
        need = [t for t in req.tool_nonaktif if t in REQUIRED]
        if wrong:
            bad.append(f"tool tidak dimiliki agen ini: {', '.join(wrong)}")
        if need:
            bad.append(f"tool penutup kerja agen tidak bisa dimatikan: {', '.join(need)}")
        out["tool_nonaktif"] = sorted(set(req.tool_nonaktif))
    text = req.instruksi_tambahan.strip()
    if text:
        if skills._BAD.search(text):
            bad.append("instruksi tambahan tidak boleh berisi tautan, perintah mengubah data atau mengabaikan aturan, atau rahasia")
        out["instruksi_tambahan"] = text
    if bad:
        raise HTTPException(422, "; ".join(bad))
    return out


@router.put("/{key}")
def set_agent(key: str, req: ConfigIn) -> dict:
    from aip import konsultan as K

    p = K._admin("mengubah konfigurasi agen")
    tim = _team()
    a = next((x for x in tim if x["key"] == key), None)
    if not a:
        raise HTTPException(404, f"agen {key} tidak ada di firma")
    cfg = check(a, req, tim)
    with _lock:
        st = _load()
        old = (st.setdefault("agen", {}).get(key) or {})
        if cfg:
            st["agen"][key] = {**cfg, "diubah_pada": _now(), "diubah_oleh": p.get("username") or p.get("id")}
        else:
            st["agen"].pop(key, None)
        st["riwayat"] = (st.get("riwayat") or [])[-199:] + [{"t": _now(), "oleh": p.get("username") or p.get("id"), "agen": key, "nama": a["name"],
                                                              "dari": {x: v for x, v in old.items() if x not in ("diubah_pada", "diubah_oleh")}, "ke": cfg}]
        _save(st)
    return agent(key)


@router.delete("/{key}")
def reset_agent(key: str) -> dict:
    from aip import konsultan as K

    p = K._admin("mengubah konfigurasi agen")
    with _lock:
        st = _load()
        old = (st.get("agen") or {}).pop(key, None)
        if old:
            st["riwayat"] = (st.get("riwayat") or [])[-199:] + [{"t": _now(), "oleh": p.get("username") or p.get("id"), "agen": key, "dari": old, "ke": {}}]
            _save(st)
    return agent(key)
