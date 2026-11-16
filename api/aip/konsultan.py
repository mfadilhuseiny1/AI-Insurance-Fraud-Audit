"""The AIP fraud consultancy (AI Agent Swarm; Konsultan Fraud AIP until 2026-10-24): the firm's roster, built from the real data, and its engagements.

The firm is the system's own agents at work (the run itself: adk_runtime/firm.py), as many as the work needs — each
workstream's head count comes from the data and the roster says why (the user: "jumlah agen yang proporsional"). Since
2026-10-23 there is no second hierarchy beside the agents that answer questions (the user: "merge agen yang redundan"):

    Orkestrator · Partner (the question flow's orchestrator)
    ├── Agen Faskes & Wilayah ──── analis wilayah: one per province (a smaller step budget below 2% of the claims); one
    │                              peer analyst across the facility classes
    ├── Agen Klaim & Indikasi ──── spesialis modus klaim (Permenkes 16/2019, where the ledger has signals); the investigator
    │                              role: an instance per facility of the box's queue at run time (capacity 6–25)
    ├── Agen Klinis ────────────── spesialis modus klinis (coding and severity, length of stay)
    ├── Agen Peserta & Rujukan ─── spesialis modus peserta (readmission, split episodes, referrals, phantom-claim signals)
    ├── Agen Machine Learning ──── its technique sub-agents, the same ones it forms for a question
    └── Validator ──────────────── reviewer QA, one per synthesis; the red team role: an instance per strongest tag (4–12)

A case-bound worker is a role, not an agent per case (the user, 2026-10-23: hospitals are many and change): the
roster holds the role (jenjang "peran": its skill, its capacity, its queue) and the engagement forms the instances.

What was merged, and the evidence (the engagements of 2026-10-23): six managers (each domain agent leads its own small
agents), the partner and the orchestrator (one lead), the firm's nine ML agents and the ML agent's sub-agents (one set;
92% of their per-technique tags repeated another technique, so only the consensus tags), the two lenses of a big
province (the mode specialists cover those modes nationally), nine peer analysts (the auto-tagger tags OUTLIER_PEER for
every facility; nine produced 1–3 tags an engagement), the report validator and the validator (one).

Machines do the deterministic work (no model): the auto-tagger, the ML consensus, the quarantine box, the Nexus sync.
The models are spread over three families (GLM, DeepSeek, gpt-oss) so a tag several agents raise is corroborated
across families; QA and the validator are never the family whose work they check.

    GET  /api/aip/konsultan/tim     the roster (the page draws it before a run starts)
    POST /api/aip/konsultan         start an engagement (admin): markings and Nexus types first, then the run
    GET  /api/aip/konsultan/runs    the engagements
    POST /api/aip/konsultan/{id}/laporan   the engagement's report written anew (admin): phases 0–5 copied from its trail
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from aip import konfigurasi_agen
from aip import models as aip_models
from aip import semantik as S

router = APIRouter(prefix="/api/aip/konsultan")

BRIEF = ("Audit indikasi fraud klaim FKRTL JKN pada Data Sampel BPJS Kesehatan 2025 (data nyata yang dianonimkan): temukan dan tandai "
         "setiap indikasi sekecil apa pun, masukkan faskes berindikasi ke box karantina menurut estimasi kerugian, audit faskes prioritas, "
         "dan rekomendasikan jalurnya (dibina, atau ditindak bila Terstruktur, Sistematis dan Masif).")
MODUS = ["UPCODING_KEPARAHAN", "TAGIHAN_MELEBIHI_TARIF", "KLAIM_GANDA", "KLONING_KLAIM", "LOS_DIPERPANJANG", "READMISI", "PEMECAHAN_EPISODE",
         "RUJUKAN_SEMU", "KELAS_RAWAT", "KLAIM_FIKTIF", "KOREKSI_BERULANG", "LOLOS_VERIFIKASI_BERISIKO"]
PEER = [("rs_kelas_a", "RS kelas A (termasuk swasta setara A dan TNI/Polri I)", ["RS Kelas A", "RS Swasta Setara Type A", "RS TNI Polri Kelas I"]),
        ("rs_kelas_b", "RS kelas B pemerintah", ["RS Kelas B"]),
        ("rs_swasta_b", "RS swasta setara tipe B", ["RS Swasta Setara Type B"]),
        ("rs_kelas_c", "RS kelas C pemerintah", ["RS Kelas C"]),
        ("rs_swasta_c", "RS swasta setara tipe C", ["RS Swasta Setara Type C"]),
        ("rs_kelas_d", "RS kelas D dan swasta setara D", ["RS Kelas D", "RS Swasta Setara Type D"]),
        ("rs_tni_polri", "RS TNI/Polri kelas II–IV", ["RS TNI Polri Kelas II", "RS TNI Polri Kelas III", "RS TNI Polri Kelas IV"]),
        ("rs_khusus", "RS khusus (jiwa, ibu dan anak, mata, jantung, kanker, paru, bedah …)",
         ["Khusus Jiwa", "Khusus Ibu dan Anak", "Khusus Mata", "Khusus Jantung", "Khusus Kanker Onkologi", "Khusus Paru", "Khusus Bedah",
          "Khusus Gigi dan Mulut", "Khusus Tulang", "Khusus Lain", "Khusus Kusta", "Khusus Hemodialisa", "Khusus Stroke"]),
        ("klinik_utama", "Klinik utama", None)]
OWN = 0.02  # below this share of the claims, a province's analyst gets the smaller step budget
# who leads whom: the domain agent whose objects a small agent works on (aip/domains.py keys), and the validator
LEADS = {"faskes_wilayah": "analis wilayah dan peer kelas faskes", "klaim_fraud": "spesialis modus klaim dan penyidik box karantina",
         "klinis": "spesialis modus klinis (kode, keparahan, lama rawat)", "peserta": "spesialis modus peserta dan rujukan",
         "machine_learning": "sub-agen teknik ML", "validator": "reviewer QA dan red team"}
LEAD_LINE = {"faskes_wilayah": "wilayah", "klaim_fraud": "kasus", "klinis": "modus", "peserta": "modus", "machine_learning": "ml", "validator": "qa"}
MODUS_OWNER = {"UPCODING_KEPARAHAN": "klinis", "LOS_DIPERPANJANG": "klinis", "READMISI": "peserta", "PEMECAHAN_EPISODE": "peserta",
               "RUJUKAN_SEMU": "peserta", "KLAIM_FIKTIF": "peserta"}  # the other modes are claims': klaim_fraud
LINES = ["pimpinan", "wilayah", "peer", "modus", "ml", "kasus", "qa"]
MACHINES = [{"key": "penanda_otomatis", "name": "Penanda otomatis", "peran": "aturan lapisan semantik atas semua objek: setiap sinyal jadi tag", "lini": "mesin"},
            {"key": "konsensus_ml", "name": "Konsensus teknik ML", "peran": "faskes yang ditaruh banyak teknik di daftar teratasnya", "lini": "mesin"},
            {"key": "karantina", "name": "Box karantina", "peran": "faskes berindikasi per kelompok kerugian A … Z, dengan sinyal TSM", "lini": "mesin"}]
# the few settings an IT team owns, set per project (the user, 2026-10-24: "data source dll yang bisa di set sama tim IT …
# yg kritikal2 aja"). The Nexus types the firm reads (aip/semantik.py): a required one missing or empty refuses the start —
# an hour of model calls on no data; a supporting one missing only narrows what its agents can read
SOURCE = "Nexus · Data Sampel BPJS Kesehatan 2025"
SOURCES = [(S.T_KLAIM, True, "klaim berisiko: setiap modus, box karantina, estimasi kerugian"),
           (S.T_FASKES, True, "profil faskes: peer kelas dan box karantina"), (S.T_PROV, True, "provinsi: satu analis per provinsi"),
           (S.T_ML_KLAIM, True, "skor risiko klaim: konsensus teknik ML"), (S.T_ML_FASKES, True, "risiko faskes: konsensus teknik ML"),
           (S.T_KAB, False, "kabupaten/kota"), (S.T_KLAIM_KAB, False, "klaim per kabupaten/kota"), (S.T_BULAN, False, "tren bulanan provinsi"),
           (S.T_INDIKATOR, False, "indikator INA-CBG: modus klinis"), (S.T_KODE, False, "kode INA-CBG"), (S.T_DX, False, "diagnosis ICD-10"),
           (S.T_PESERTA, False, "peserta klaim berisiko: modus peserta"), (S.T_FKTP, False, "kunjungan FKTP"),
           (S.T_RUJUKAN, False, "alur rujukan: rujukan semu")]
# the model seats (roster slots): an IT team moves a seat off a model that is switched off (GLM-5.2 Preview ends 2026-10-31)
SEATS = [("glm", "Model pimpinan", "orkestrator (partner), agen domain, penyidik kasus, analis exhibit, sepertiga analis"),
         ("deepseek", "Model analis & ML", "sub-agen teknik ML, red team, editor laporan, sepertiga analis"),
         ("oss", "Model QA", "reviewer QA lintas keluarga, sepertiga analis"),
         ("validator", "Model validator", "validator sintesis dan laporan akhir"),
         # Blu 1.1's clinical review (aip/telaah.py): the screen reads every claim, the check (another family) the suspicious ones
         ("telaah_saring", "Model telaah klinis · saring", "Blu 1.1: menelaah setiap klaim berisiko, 10 per panggilan"),
         ("telaah_periksa", "Model telaah klinis · periksa ulang", "Blu 1.1: memeriksa ulang klaim yang mencurigakan dan 5% sampel acak; keluarga lain dari model saring")]
# the AI orchestration (the user, 2026-10-30: the system before is "Blu 1.0", the clinical review before the agents "Blu 1.1"):
# chosen per engagement on its start form
VERSIONS = {"1.0": {"nama": "Blu 1.0", "ringkas": "AI Agent Swarm: agen bekerja dari ringkasan, skor ML dan klaim berisiko yang dibuka sebagai bukti",
                    "tambahan": None},
            "1.1": {"nama": "Blu 1.1", "ringkas": "Blu 1.0, didahului telaah klinis setiap klaim berisiko (aturan + ML) oleh dua keluarga model",
                    "tambahan": "uji kalibrasi 300 klaim dulu; telaah penuh hanya bila kedua model sepakat dan proyeksi biaya muat di batas; "
                                "tag hanya bila keduanya menilai mencurigakan, selalu lemah, tanpa menambah kerugian Box"},
            # the user, 2026-10-30: "create 1.3 model with openai decision for clinical examination"; the agents after it
            # write the reasons and the tags ("we have agent for this later")
            # (the user, 2026-10-30: short, no vendor name and no numbers on the start form — "dont say openai here", "too much information")
            "1.3": {"nama": "Blu 1.3", "ringkas": "Blu 1.0, didahului pemeriksaan keputusan setiap klaim berisiko",
                    "tambahan": "uji kalibrasi 300 klaim dulu, dibandingkan dengan putusan telaah klinis Blu 1.1 yang tersimpan; tanpa tag dari pemeriksaan: "
                                "agen menganalisis klaim teratas dan menandai dengan buktinya sendiri; ~$5 dan ~30 menit untuk puluhan ribu klaim"}}
# Blu 3.0 (aip/blu3.py): the swarm on fraud-model architecture v3, its own roster and machines; Blu 1.x stay as they are
from aip import blu3  # noqa: E402

VERSIONS["3.0"] = blu3.VERSION
MACHINES_30 = [MACHINES[0], blu3.MACHINE, MACHINES[2]]  # the auto-tagger, the v3 scoring (no ML consensus), the quarantine box
TELAAH_MACHINE = {"key": "telaah_klinis", "name": "Telaah klinis (Blu 1.1)", "lini": "mesin",
                  "peran": "setiap klaim berisiko ditelaah model saring; yang mencurigakan dan 5% sampel acak diperiksa ulang keluarga lain"}
TELAAH_MACHINE_13 = {"key": "telaah_klinis", "name": "Pemeriksaan keputusan (Blu 1.3)", "lini": "mesin",
                     "peran": "setiap klaim berisiko dinilai OpenAI Decisions: peluang wajar / perlu diperiksa / mencurigakan; tanpa tag, agen memeriksa yang teratas"}
PARALEL = (2, 8, 12)  # agents thinking at once (min, default, max): adk_runtime/firm.py CONCURRENT; 12 exhausted the Vertex quota


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def lead_of(a: dict) -> str:
    """The lead of a small agent of the firm: its induk, or — in a roster of before the merge, with a manager per line —
    the domain agent that owns its objects."""
    if a.get("induk") in LEADS:
        return a["induk"]
    if a["lini"] == "modus":
        return MODUS_OWNER.get(a["key"].removeprefix("modus_").upper(), "klaim_fraud")
    return {"wilayah": "faskes_wilayah", "peer": "faskes_wilayah", "ml": "machine_learning", "kasus": "klaim_fraud", "qa": "validator"}.get(a["lini"], "partner")


def _models() -> dict[str, str]:
    ready = lambda m: m if aip_models.ready(m) else aip_models.pick("tools")  # noqa: E731
    return {"glm": ready(aip_models.GLM), "deepseek": ready(aip_models.DEEPSEEK), "oss": ready(aip_models.GPT_OSS)}


def _provinces() -> list[dict]:
    """The provinces with FKRTL claims (as the caller sees them), by claim volume: the data's 38-province coding (the
    gold dimension wilayah), so 38."""
    import ontology

    from aip import indikasi as I

    if not any(x["display_name"] == S.T_PROV for x in ontology._all("object-types")):
        raise HTTPException(404, f"tipe {S.T_PROV} tidak ada")
    rows = [r for r in I._objects(S.T_PROV) if (r.get("klaim_fkrtl") or 0) > 0]
    return sorted(rows, key=lambda r: -(r.get("klaim_fkrtl") or 0))


def _signals() -> tuple[dict[str, int], int, dict[str, int]]:
    """(tags per tag code, objects with a strong tag, quarantine facilities per group) — what sizes the firm."""
    from aip import indikasi as I
    from aip import karantina as K

    per: dict[str, int] = {}
    strong = set()
    for rec in filter(I.standing, I._all().values()):
        per[rec["tag"]] = per.get(rec["tag"], 0) + 1
        if I.view(rec)["tingkat"] == 3:
            strong.add((rec["entitas"], rec["kunci"]))
    box: dict[str, int] = {}
    for r in K._load().values():
        box[r["kelompok"]] = box.get(r["kelompok"], 0) + 1
    return per, len(strong), box


def roster(models: Optional[dict] = None) -> tuple[list[dict], list[dict]]:
    """(the team, why each workstream has the size it has); `models` = a project's seat models (SEATS), checked by _seat_models."""
    import ml_klaim

    from aip import domains
    from aip import indikasi as I

    mod = {**_models(), **{k: v for k, v in (models or {}).items() if k in ("glm", "deepseek", "oss") and v}}
    rot = [mod["glm"], mod["deepseek"], mod["oss"]]
    names = {a["key"]: a["name"].replace(" (BPJS)", "") for a in domains.catalogue()["agents"]}
    validator = (models or {}).get("validator") or aip_models.pick("auditor_sim", checks=mod["glm"])
    why: list[dict] = []
    members: list[dict] = []
    i = 0

    def add(a: dict) -> None:
        nonlocal i
        members.append({**a, "jenjang": "analis", "peran_kode": a.get("peran_kode", "analis"), "model": a.get("model") or rot[i % 3]})
        i += 1

    provs = _provinces()
    total = sum(r.get("klaim_fkrtl") or 0 for r in provs) or 1
    small = 0
    for r in provs:
        share = (r.get("klaim_fkrtl") or 0) / total
        small += share < OWN
        add({"key": f"prov_{r['provinsi_kode']}", "name": f"Analis Wilayah · {str(r['provinsi']).title()}", "lini": "wilayah", "induk": "faskes_wilayah",
             "peran": f"menelusuri indikasi di provinsi {r['provinsi']} ({share:.1%} klaim), lintas modus",
             "target": {"provinsi": [r["provinsi"]], "provinsi_kode": [r["provinsi_kode"]], "porsi_klaim": round(share, 4), "kecil": share < OWN}})
    why.append({"lini": "wilayah", "agen": len(members),
                "alasan": f"satu analis per provinsi ({len(provs)} provinsi dengan faskes di data); yang proporsional dengan volume klaim adalah jatah "
                          f"langkahnya: {small} provinsi < {OWN:.0%} klaim mendapat jatah lebih kecil. Dua lensa per provinsi besar digabung: modusnya "
                          "sudah dicakup spesialis modus secara nasional"})
    ml_fac = I._objects(S.T_ML_FASKES)
    classes = []
    for slug, label, tipe in PEER:
        if tipe is None:
            n = sum(1 for r in ml_fac if r.get("jenis_fkrtl") == "Klinik Utama")
            flt = [{"property": "jenis_fkrtl", "op": "eq", "value": "Klinik Utama"}]
        else:
            n = sum(1 for r in ml_fac if r.get("tipe_fkrtl") in tipe and r.get("jenis_fkrtl") == "Rumah sakit")
            flt = [{"property": "tipe_fkrtl", "op": "in", "value": tipe}, {"property": "jenis_fkrtl", "op": "eq", "value": "Rumah sakit"}]
        if n >= 20:
            classes.append({"kelas": slug, "label": label, "faskes": n, "filter_ml": flt})
    if classes:
        add({"key": "peer_kelas", "name": "Analis Peer Kelas Faskes", "lini": "peer", "induk": "faskes_wilayah",
             "peran": f"membandingkan faskes dengan kelasnya sendiri di {len(classes)} kelas, pada beberapa ukuran sekaligus", "target": {"kelas": classes}})
    why.append({"lini": "peer", "agen": 1 if classes else 0,
                "alasan": f"satu analis lintas {len(classes)} kelas (>= 20 faskes); digabung dari satu per kelas: penanda otomatis sudah menandai "
                          "OUTLIER_PEER tiap faskes dan spesialis modus membandingkan per tipe faskes (sembilan analis kelas menghasilkan 1–3 tag per penugasan)"})
    per, strong, box = _signals()
    skipped = []
    n_modus = len(members)
    for tag in MODUS:
        t = S.TAG[tag]
        if not per.get(tag) and not t["ukuran"]:
            skipped.append(f"{tag} (tidak ada sinyal dan ukuran di data)")
            continue
        add({"key": f"modus_{_slug(tag)}", "name": f"Spesialis {t['label']}", "lini": "modus", "peran": f"spesialis modus: {t['modus']}",
             "induk": MODUS_OWNER.get(tag, "klaim_fraud"), "target": {"tag": tag, "sinyal_di_buku_besar": per.get(tag, 0)}})
    why.append({"lini": "modus", "agen": len(members) - n_modus,
                "alasan": "satu per modus Permenkes 16/2019 yang punya sinyal atau ukuran di data, di bawah agen domain pemilik objeknya"
                          + (f"; dilewati: {'; '.join(skipped)}" if skipped else "")})
    for name, (fam, _ref) in ml_klaim.MODELS.items():
        add({"key": f"sub_{_slug(name)}", "name": f"Sub-agen {name}", "lini": "ml", "peran": f"menguji teknik {name} ({fam}); daftar teratasnya masuk konsensus",
             "induk": "machine_learning", "model": mod["deepseek"], "target": {"teknik": name, "keluarga": fam,
                                                                                "riset": [f"{x['penulis']} {x['tahun']}" for x in ml_klaim.RESEARCH.get(name, [])][:3]}})
    why.append({"lini": "ml", "agen": len(ml_klaim.MODELS), "alasan": "sub-agen teknik milik Agen Machine Learning (set yang sama dengan tanya-jawab); "
                                                                    "tidak menandai sendiri — konsensus antarteknik yang menandai"})
    # the cases change with every engagement (and could be hundreds): one role, an instance per case at run time
    # every A and B facility and the top of C, up to 32 (the user, 2026-10-29: "working harder … gpp $15 jadi $25"; it was 25)
    cases = max(6, min(32, box.get("A", 0) + box.get("B", 0) + 4)) if box else 12
    members.append({"key": "penyidik_kasus", "name": "Penyidik kasus", "lini": "kasus", "jenjang": "peran", "induk": "klaim_fraud", "model": mod["glm"],
                    "peran_kode": "penyidik", "peran": "satu peran: saat penugasan, satu instans berkonteks segar per faskes di antrean box karantina "
                                                       "(kelompok A, lalu B …) — kertas kerja audit dan rekomendasi jalur",
                    "target": {"kapasitas": cases, "antrean": "box karantina, kelompok A → Z, status karantina / diaudit"}})
    why.append({"lini": "kasus", "agen": 1, "alasan": f"satu peran penyidik; instans per faskes dibentuk saat penugasan, kapasitas {cases} faskes "
                                                     f"(kelompok A {box.get('A', 0)} + B {box.get('B', 0)}, 6–25) — faskes di box berubah, agennya tidak"
                if box else "satu peran penyidik; box karantina belum dihitung: kapasitas 12"})
    leads = [k for k in LEADS if k == "validator" or any(m["induk"] == k for m in members)]
    for lead in leads:
        if lead == "validator":
            continue
        add({"key": f"qa_{lead}", "name": f"Reviewer QA · {names.get(lead, lead).removeprefix('Agen ')}", "lini": "qa",
             "peran": f"memeriksa ulang sintesis {names.get(lead, lead)} terhadap data", "induk": "validator", "model": mod["oss"], "peran_kode": "qa",
             "target": {"lead": lead}})
    reds = max(4, min(16, -(-strong // 3)))  # (12 until 2026-10-29)
    members.append({"key": "red_team", "name": "Red team", "lini": "qa", "jenjang": "peran", "induk": "validator", "model": mod["deepseek"],
                    "peran_kode": "red_team", "peran": "satu peran: saat penugasan, satu instans per indikasi terkuat di buku besar — membela penjelasan "
                                                       "wajarnya, lalu memutus bertahan atau melemah",
                    "target": {"kapasitas": reds, "antrean": "indikasi terkuat (sedang ke atas, dari agen), satu per objek"}})
    why.append({"lini": "qa", "agen": len(leads), "alasan": f"{len(leads) - 1} reviewer QA (satu per sintesis agen domain) dan satu peran red team: "
                                                           f"instans per indikasi, kapasitas {reds} (sepertiga dari {strong} objek bertag kuat, 4–16)"})
    team: list[dict] = [{"key": "partner", "name": "Orkestrator · Partner", "lini": "pimpinan", "jenjang": "partner", "induk": None, "model": mod["glm"],
                         "peran": "agen pimpinan, sama dengan orkestrator tanya-jawab: hipotesis, fokus tiap lini, laporan akhir untuk klien", "peran_kode": "partner"}]
    for lead in leads:
        team.append({"key": lead, "name": "Validator" if lead == "validator" else names.get(lead, lead), "lini": LEAD_LINE[lead], "jenjang": "manajer",
                     "induk": "partner", "model": validator if lead == "validator" else mod["glm"], "peran_kode": "validator" if lead == "validator" else "manajer",
                     "peran": (f"memimpin {LEADS[lead]}: memeriksa setiap sintesis dan laporan akhir ke data, dari keluarga model lain" if lead == "validator" else
                               f"agen domain yang memimpin {LEADS[lead]} di objek Nexus-nya dan menyintesis laporan mereka")})
    why.insert(0, {"lini": "pimpinan", "agen": 1 + len(leads), "alasan": f"orkestrator (partner), {len(leads) - 1} agen domain yang memimpin agen kecilnya, "
                                                                         "dan validator — tanpa lapisan manajer terpisah"})
    desk = report_team(mod)
    team.append(desk[0])
    members += desk[1:]
    why.append({"lini": "laporan", "agen": len(desk), "alasan": "redaksi laporan (kode) dengan editor bahasa dan analis exhibit: laporan lengkap setiap penugasan "
                                                               "selesai dengan penjelasan exhibit dan berkas kasus yang dibekukan; angka dijaga kode"})
    return team + members, why


def report_team(mod: dict) -> list[dict]:
    """The report desk (adk_runtime/firm.py: the editor in phase 6, the exhibit analyst in phase 7; the user, 2026-10-24:
    agents may be added so that every engagement's report has the long report's quality): a desk of code that runs them
    and holds the gates, the editor on the second seat (another family than the partner who writes), the analyst on
    the lead seat."""
    return [{"key": "redaksi", "name": "Redaksi laporan", "lini": "laporan", "jenjang": "manajer", "induk": "partner", "model": "kode", "peran_kode": "redaksi",
             "peran": "meja redaksi (kode): menjalankan editor dan analis exhibit, menolak suntingan yang mengubah angka, rujukan atau kode tag, "
                      "membekukan exhibit dan berkas kasus laporan lengkap saat penugasan selesai"},
            {"key": "editor_laporan", "name": "Editor laporan", "lini": "laporan", "jenjang": "analis", "induk": "redaksi", "model": mod["deepseek"],
             "peran_kode": "editor", "peran": "menyunting bahasa tiap bagian laporan (salah ketik, kalimat panjang, istilah) tanpa mengubah angka, "
                                             "rujukan hasil_id atau kode tag — kode membandingkannya"},
            {"key": "analis_exhibit", "name": "Analis exhibit", "lini": "laporan", "jenjang": "analis", "induk": "redaksi", "model": mod["glm"],
             "peran_kode": "analis_exhibit", "peran": "menulis makna dan implikasi tiap exhibit laporan lengkap; kalimat yang angkanya tidak ada di fakta "
                                                     "exhibit dibuang kode"}]


def _family(model: str) -> str:
    return aip_models.family(model)


def sources() -> dict:
    """The data the firm reads, as the IT team checks it: each Nexus type, its objects, its backing dataset, when it last
    changed; `siap` is false while a required one is missing or empty."""
    import ontology
    import ontology_store

    types = {x["display_name"]: x for x in ontology._all("object-types")}
    rows = []
    for name, need, use in SOURCES:
        t = types.get(name)
        st = ontology_store.stat(t["id"]) if t else None
        rows.append({"tipe": name, "wajib": need, "dipakai": use, "ada": bool(t), "objek": ontology_store.count(t["id"]) if t else 0,
                     "dataset": ((t or {}).get("backing_dataset") or {}).get("name"),
                     "diperbarui": datetime.fromtimestamp(st["mtime_ns"] / 1e9, timezone.utc).isoformat(timespec="seconds") if st else None})
    missing = [r["tipe"] for r in rows if r["wajib"] and not r["objek"]]
    return {"sumber": SOURCE, "tipe": rows, "siap": not missing, "kurang": missing,
            "pendukung_kurang": [r["tipe"] for r in rows if not r["wajib"] and not r["objek"]]}


def _seat_models(given: Optional[dict]) -> dict[str, str]:
    """The model of each seat: the defaults, with what a project sets. Code refuses a model not enabled on Vertex or
    without tool calling, and a validator or QA model of the lead model's family (no model judges its own family)."""
    given = {k: v for k, v in (given or {}).items() if v}
    out = {**_models(), **{k: v for k, v in given.items() if k in ("glm", "deepseek", "oss")}}
    other = [m for m in (aip_models.GPT_OSS, aip_models.DEEPSEEK, aip_models.GLM)  # a seat left to its default, off the lead's family
             if aip_models.ready(m) and aip_models.family(m) != aip_models.family(out["glm"])]
    if "oss" not in given and aip_models.family(out["oss"]) == aip_models.family(out["glm"]) and other:
        out["oss"] = other[0]
    out["validator"] = given.get("validator") or (out["oss"] if aip_models.family(out["oss"]) != aip_models.family(out["glm"]) else other[0] if other else out["oss"])
    # Blu 1.1: DeepSeek screens, GLM re-checks (the user's choice, 2026-10-30); a seat whose model is off moves to another family
    ready = lambda m: m if aip_models.ready(m) else None  # noqa: E731
    out["telaah_saring"] = given.get("telaah_saring") or ready(aip_models.DEEPSEEK) or aip_models.pick("tools")
    check = given.get("telaah_periksa") or ready(aip_models.GLM)
    if not check or aip_models.family(check) == aip_models.family(out["telaah_saring"]) and "telaah_periksa" not in given:
        check = aip_models.failover(out["telaah_saring"]) or check or out["telaah_saring"]
    out["telaah_periksa"] = check
    label = {k: lab for k, lab, _ in SEATS}
    bad = []
    for key, _, _ in SEATS:
        spec = aip_models.MODELS.get(out[key])
        if not spec or not aip_models.ready(out[key]):
            bad.append(f"{label[key]}: {spec['label'] if spec else out[key]} belum diaktifkan di Vertex")
        elif not spec["tools"]:
            bad.append(f"{label[key]}: {spec['label']} tidak bisa memanggil tool")
    lead = aip_models.MODELS.get(out["glm"], {}).get("label", out["glm"])
    bad += [f"{label[k]} harus dari keluarga model lain dari model pimpinan ({lead})" for k in ("oss", "validator")
            if aip_models.family(out[k]) == aip_models.family(out["glm"])]
    if aip_models.family(out["telaah_periksa"]) == aip_models.family(out["telaah_saring"]):
        bad.append(f"{label['telaah_periksa']} harus dari keluarga model lain dari model saring: pemeriksa ulang tidak menilai keluarganya sendiri")
    if bad:
        raise HTTPException(422, "; ".join(bad))
    return out


def _admin(what: str) -> dict:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, f"{what} butuh admin")
    return p


# projects (the user, 2026-10-24: "Create new project", a tab of its own, then its engagements): what it audits and the IT
# settings above, in one file next to the runs; a read error is an error, never an empty list a write would then keep
_PROJECTS_LOCK = threading.Lock()


def _projects_file() -> Path:
    from aip import runs

    return runs._dir().parent / "konsultan_proyek.json"


def _projects() -> list[dict]:
    try:
        return json.loads(_projects_file().read_text("utf-8")).get("proyek") or []
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        raise HTTPException(500, f"daftar proyek tidak terbaca: {e}") from e


def _write_projects(items: list[dict]) -> None:
    p = _projects_file()
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"proyek": items}, ensure_ascii=False, indent=1), "utf-8")
    for i in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:  # Windows: a reader holds the file for a moment
            time.sleep(0.05 * (i + 1))
    os.replace(tmp, p)


def _project(pid: str) -> dict:
    pr = next((x for x in _projects() if x["id"] == pid), None)
    if not pr:
        raise HTTPException(404, "proyek tidak ada")
    return pr


def _bin(run_id: str) -> None:
    """An engagement's trail moved to runs-terhapus/, where an administrator can restore it."""
    import shutil

    from aip import paket, runs

    bin_ = runs._dir().parent / "runs-terhapus"
    bin_.mkdir(parents=True, exist_ok=True)
    shutil.move(str(runs._dir() / run_id), str(bin_ / run_id))
    paket._engagement.clear()  # the last engagement may have been this one
    _refirm(run_id)


def _refirm(gone: str) -> None:
    """The firm the agent network draws (indikasi state `firma`, set when an engagement starts), once its engagement is
    deleted: the latest remaining engagement's, its roster read from its trail's firm event; none if there is none."""
    from aip import indikasi as I
    from aip import runs

    if (I._state().get("firma") or {}).get("run") != gone:
        return
    for d in sorted(runs._dir().iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            rec = json.loads((d / "run.json").read_text("utf-8"))
        except (OSError, ValueError):
            continue
        firm = next((e for e in runs._events(d.name) if e.get("type") == "firm"), None) if rec.get("kind") == "konsultan" else None
        if firm and firm.get("tim"):
            I._put_state(firma={"run": d.name, "pada": rec["created_at"], "agen": len(firm["tim"]), "ukuran": None,
                                "tim": [{k: a.get(k) for k in ("key", "name", "lini", "jenjang", "induk", "model", "peran", "peran_kode")} for a in firm["tim"]]})
            return
    I._put_state(firma={})


@router.get("/tim")
def team(versi: str = "1.0") -> dict:
    if versi == "3.0":
        t, why = blu3.roster(blu3.seats(), _provinces(), report_team)
        fams: dict[str, int] = {}
        for a in t:
            fams[_family(a["model"])] = fams.get(_family(a["model"]), 0) + 1
        return {"tim": t, "mesin": MACHINES_30, "jumlah_agen": len(t), "keluarga_model": fams, "brief": BRIEF, "ukuran": why, "versi": "3.0",
                "lini": {lini: sum(a["lini"] == lini for a in t) for lini in LINES}, "profil_data": blu3.profil()}
    t, why = roster()
    fams: dict[str, int] = {}
    for a in t:
        fams[_family(a["model"])] = fams.get(_family(a["model"]), 0) + 1
    return {"tim": t, "mesin": MACHINES, "jumlah_agen": len(t), "keluarga_model": fams, "brief": BRIEF, "ukuran": why,
            "lini": {lini: sum(a["lini"] == lini for a in t) for lini in LINES}}


class EngagementIn(BaseModel):
    """What the form asks before an engagement starts (the user, 2026-10-24: a click alone started one; a form first)."""
    brief: Optional[str] = Field(None, max_length=4000)
    nama: str = Field("", max_length=120)  # the engagement's name, as the list shows it
    fokus: Optional[str] = Field(None, max_length=600)  # added to the brief; None: the project's
    batas_usd: Optional[float] = Field(None, ge=1, le=500)  # a cost limit: the gateway refuses the call that would pass it
    proyek: Optional[str] = Field(None, max_length=40)  # the project it belongs to: its brief, focus and IT settings
    versi: str = Field("1.0", pattern=r"^(1\.[013]|3\.0)$")  # the AI orchestration: Blu 1.0, 1.1 (the clinical review first), 1.3 (OpenAI Decisions first), 3.0 (v3)


@router.post("")
def start(req: EngagementIn, request: Request) -> dict:
    """An engagement: the firm sized to the work, for up to an hour (admin: it writes tags and the quarantine box, and its
    model cost is that of every agent). In a project, with the project's settings; never on data that is not there."""
    from aip import indikasi as I
    from aip import runs

    _admin("penugasan konsultan")
    pr = _project(req.proyek) if req.proyek else {}
    src = sources()
    if not src["siap"]:
        raise HTTPException(409, f"sumber data belum siap: {', '.join(src['kurang'])} kosong atau tidak ada di Nexus")
    if not (I._state().get("markings") or {}).get("internal"):
        I.setup()
    if req.versi == "3.0":  # Blu 3.0: Vertex seats (GLM 5.2 orchestrates only), and only on the v3 data profile (an hour on the wrong data is refused here)
        try:
            seats = blu3.seats(pr.get("model"))
        except ValueError as e:
            raise HTTPException(422, str(e))
        prof = blu3.profil()
        if prof["aktif"] != "v3" or not prof["paket"]:
            raise HTTPException(409, "Blu 3.0 butuh profil data v3 di Nexus (testing/blu3_data.py lalu testing/blu3_profil.py pasang)")
    else:
        seats = _seat_models(pr.get("model"))
    budget = req.batas_usd if req.batas_usd is not None else pr.get("batas_usd")
    review: dict = {}
    if req.versi in ("1.1", "1.3"):
        # refused here rather than an hour in: the claims to review, the key (Blu 1.3), and a ceiling the review can work under
        from aip import telaah

        seats = telaah.seats_for(req.versi, seats)
        if not telaah.review_set():
            raise HTTPException(409, f"Blu {req.versi}: tidak ada klaim berisiko untuk ditelaah")
        if telaah.ceiling(budget) < 5:
            raise HTTPException(422, f"Blu {req.versi}: batas biaya penugasan ${budget} menyisakan ${telaah.ceiling(budget):.2f} untuk telaah klinis setelah "
                                     f"${telaah.AGENT_RESERVE_USD:.0f} untuk agen: naikkan batasnya, atau pilih Blu 1.0")
        review = {"telaah_batas_usd": telaah.ceiling(budget)}
    t, why = blu3.roster(seats, _provinces(), report_team) if req.versi == "3.0" else roster(seats)
    fokus = ((pr.get("fokus") or "") if req.fokus is None else req.fokus).strip()
    brief = (req.brief or pr.get("brief") or BRIEF).strip() + (f"\n\nFokus penugasan ini: {fokus}" if fokus else "")
    n = sum(1 for r in runs.list_runs(200) if pr and r.get("proyek") == pr["id"] and r.get("kind") == "konsultan"
            and not r.get("ulang_laporan"))  # rewrites (and Blu 1.1 calibrations) are not engagements
    nama = req.nama.strip() or (f"{pr['nama']} · penugasan {n + 1}" if pr else None)
    rec = runs.start("konsultan", {"q": brief, "nama": nama, "proyek": pr.get("id"), "paralel": pr.get("paralel") or PARALEL[1], "kursi": seats,
                                   "tim": t, "ukuran": why, "mesin": MACHINES_30 if req.versi == "3.0" else MACHINES + {"1.1": [TELAAH_MACHINE], "1.3": [TELAAH_MACHINE_13]}.get(req.versi, []),
                                   "validator_model": seats["validator"], "versi": req.versi, **review,
                                   # Blu 3.0: claim rows only from ML v3's output and a control sample (aip/blu3.py lingkup); engagements
                                   # started before 2026-11-12 lack the flag and keep their open reads, also when resumed
                                   **({"lingkup_v3": True} if req.versi == "3.0" else {}),
                                   # each agent as set in Konfigurasi agen (aip/konfigurasi_agen.py), kept with the engagement's input
                                   "konfigurasi": konfigurasi_agen.active()},
                     request, budget_usd=budget)
    I._put_state(firma={"run": rec["id"], "pada": rec["created_at"], "agen": len(t), "ukuran": why,
                        "tim": [{k: a.get(k) for k in ("key", "name", "lini", "jenjang", "induk", "model", "peran", "peran_kode")} for a in t]})
    return {"run": rec["id"], "jumlah_agen": len(t)}


def resume_payload(rec: dict, events: list[dict]) -> dict:
    """The input of an engagement that started before runs kept theirs (aip/runs.py input.json), for continuing it after a
    cut: its record, its project's IT settings, and the team it was formed with (its own "firm" event)."""
    try:
        pr = _project(rec["proyek"]) if rec.get("proyek") else {}
    except HTTPException:  # the project is gone: the default settings
        pr = {}
    seats = _seat_models(pr.get("model"))
    firm = next((e for e in events if e.get("type") == "firm"), {})
    t, why = roster(seats) if not firm.get("tim") else (firm["tim"], [])
    return {"q": rec.get("q") or BRIEF, "nama": rec.get("nama"), "proyek": rec.get("proyek"), "paralel": pr.get("paralel") or PARALEL[1], "kursi": seats,
            "tim": t, "ukuran": why, "mesin": firm.get("mesin") or MACHINES, "validator_model": seats["validator"]}


@router.post("/{run_id}/laporan")
def rewrite_report(run_id: str, request: Request, kerangka: bool = True, ulang_lini: str = "") -> dict:
    """The report of a finished engagement written anew, as a new engagement run: its phases 0–5 are copied from the
    source's trail, not run again (no tag, box or recommendation is written twice), and only the report phase runs —
    outline, sections, validator. For a report writer that changed since, at the cost of the report alone (admin).
    kerangka=false writes it in one pass, as before the outline (to compare the two on the same evidence).
    ulang_lini: domain agents (keys, comma-separated, e.g. machine_learning) whose synthesis and QA run again first, on
    their small agents' copied reports (firm.redo_lines) — a line whose QA failed, after its tools or prompt were fixed."""
    import auth

    from aip import runs

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "menulis ulang laporan penugasan butuh admin")
    src = runs.check_access(run_id)
    if src.get("kind") != "konsultan" or src.get("status") != "succeeded":
        raise HTTPException(409, "hanya laporan penugasan konsultan yang selesai yang bisa ditulis ulang")
    t, _ = roster()
    validator = next(a["model"] for a in t if a["key"] == "validator")
    # the report desk joins the copied team when the engagement is from before it (adk_runtime/firm.py report_team)
    lini = [k.strip() for k in (ulang_lini or "").split(",") if k.strip()]
    # in its source's project, named after it (2026-10-29: rewrites had no project and showed under "Audit nasional FKRTL 2025")
    rec = runs.start("konsultan", {"q": src.get("q") or BRIEF, "tim": [], "ulang_laporan": run_id, "validator_model": validator, "kerangka": kerangka,
                                   **({"proyek": src["proyek"]} if src.get("proyek") else {}), "nama": f"{src.get('nama') or run_id} · tulis ulang laporan",
                                   "tim_laporan": report_team(_models()), "konfigurasi": konfigurasi_agen.active(), **({"ulang_lini": lini} if lini else {})}, request)
    return {"run": rec["id"], "sumber": run_id, **({"ulang_lini": lini} if lini else {})}


@router.get("/sistem")
def system() -> dict:
    """Every layer of the fraud system at a glance (the system map): data and Nexus, the production pipeline and the
    deployed model, the agents (questions, ML, the firm), the ledger and the box, the human gates, the evidence ladder."""
    from aip import indikasi as I
    from aip import karantina as K
    from aip import ml as aip_ml
    from aip import produksi as P
    from aip import runs

    aip_ml._source()
    st = I._state()
    have = I._viewer_markings()
    views = [I.view(r) for r in I._all().values()]
    views = [v for v in views if I._visible(v, have)]
    rejected = sum(not I.standing(v) for v in views)
    views = [v for v in views if I.standing(v)]
    box = [r for r in K._load().values() if K._visible(r, have)]
    cur = aip_ml.current() or {}
    dep = P.deployed() or {}
    last_run = next(iter(P.status()["runs"]), None)
    engagements = [r for r in runs.list_runs(200) if r.get("kind") == "konsultan"]
    groups: dict[str, dict] = {}
    for r in box:
        g = groups.setdefault(r["kelompok"], {"faskes": 0, "kerugian_rp": 0})
        g["faskes"] += 1
        g["kerugian_rp"] += r["estimasi_kerugian_rp"]
    return {
        "data": {"klaim": ((last_run or {}).get("ringkasan") or {}).get("baris"), "sumber": cur.get("source_item")},
        "pipeline": {"run": (last_run or {}).get("id"), "status": (last_run or {}).get("status"), "selesai": (last_run or {}).get("selesai"),
                     "tahap": [t["id"] for t in ((last_run or {}).get("ringkasan") or {}).get("tahap") or []]},
        "model": {"versi": cur.get("version"), "segmen": {s_: i.get("model") for s_, i in ((dep.get("signature") or {}).get("segmen") or {}).items()},
                  "deploy": dep.get("run"), "format": sorted(((dep.get("signature") or {}).get("format") or {}).keys())},
        "indikasi": {"total": len(views), "kuat": sum(v["tingkat"] == 3 for v in views), "sedang": sum(v["tingkat"] == 2 for v in views),
                     "lemah": sum(v["tingkat"] == 1 for v in views), "oleh_agen": sum(any(s_["agen"] != "penanda_otomatis" for s_ in r.get("sumber") or [])
                                                                         for r in I._all().values() if I.standing(r)),
                     "dikonfirmasi": sum(v["status"] == "dikonfirmasi" for v in views), "ditolak": rejected,
                     "markings": bool((st.get("markings") or {}).get("internal"))},
        "karantina": {"faskes": len(box), "kelompok": groups, "per_status": {x: sum(r["status"] == x for r in box) for x in K.STATUSES}},
        "firma": st.get("firma"), "penugasan": len(engagements), "penugasan_terakhir": engagements[0] if engagements else None,
        "nexus": (st.get("nexus") or {}).get("status"),
    }


@router.delete("/{run_id}")
def delete(run_id: str) -> dict:
    """An engagement taken off the list (a wrong or accidental one): its trail is moved to runs-terhapus/, where an
    administrator can restore it; the tags and the box it wrote stay, as later engagements build on them (admin)."""
    from aip import runs

    _admin("menghapus penugasan")
    rec = runs.check_access(run_id)
    if rec.get("kind") != "konsultan":
        raise HTTPException(404, "bukan penugasan AI Agent Swarm")
    if rec.get("status") == "running":
        raise HTTPException(409, "penugasan masih berjalan: hentikan dulu")
    _bin(run_id)
    return {"dihapus": run_id, "disimpan_di": f"runs-terhapus/{run_id}"}


@router.get("/v3")
def v3_status() -> dict:
    """Blu 3.0: which data profile the Nexus types hold, and the v3 scoring summary the engagement starts from."""
    return {"profil": blu3.profil(), "ringkasan": blu3.ringkasan(), "versi": blu3.VERSION}


@router.get("/v3/lingkup")
def v3_scope() -> dict:
    """Blu 3.0's reading scope (aip/blu3.py lingkup): the claim ids of Klaim Berisiko and the control sample of the other
    claims; the engagement runtime (adk_runtime/firm.py) holds the agents' claim reads to them."""
    return blu3.lingkup()


@router.get("/sumber")
def source_check() -> dict:
    return sources()


@router.get("/konfigurasi")
def configuration() -> dict:
    """What the project form offers the IT team: the data source and its readiness, each model seat (what sits there, its
    default) with the models it may move to, agents at once, the cost limit's bounds. How many agents sit in each seat the
    page counts from the roster it already has (/tim): no second roster here."""
    seats = _seat_models(None)
    rows = [{"kursi": key, "label": label, "dipakai": use, "default": seats[key]} for key, label, use in SEATS]
    models = [{"id": m["id"], "label": m["label"], "vendor": m["vendor"], "keluarga": m["family"], "siap": bool(m["ready"] and m["tools"]),
               "alasan": None if m["ready"] and m["tools"] else "tanpa pemanggilan tool" if not m["tools"] else "belum diaktifkan di Vertex",
               "harga": m["price"]} for m in aip_models.catalogue()["models"] if m["tools"] or m["ready"]]
    return {"sumber": sources(), "kursi": rows, "model": models, "paralel": dict(zip(("min", "default", "maks"), PARALEL, strict=True)),
            "batas_usd": {"min": 1, "maks": 500}, "brief": BRIEF, "versi": VERSIONS}


class ProjectIn(BaseModel):
    """A project: what it audits, and the settings its IT team owns — each seat's model, agents at once, a cost limit for
    each of its engagements."""
    nama: str = Field(..., min_length=3, max_length=120)
    brief: Optional[str] = Field(None, max_length=4000)
    fokus: str = Field("", max_length=600)
    batas_usd: Optional[float] = Field(None, ge=1, le=500)
    paralel: int = Field(PARALEL[1], ge=PARALEL[0], le=PARALEL[2])
    model: dict[str, str] = Field(default_factory=dict)  # seat (SEATS) -> model id; left out: the default


@router.get("/proyek")
def projects() -> list[dict]:
    return sorted(_projects(), key=lambda x: x.get("dibuat_pada") or "", reverse=True)


def _project_rec(req: ProjectIn) -> dict:
    return {"nama": req.nama.strip(), "brief": (req.brief or BRIEF).strip(), "fokus": req.fokus.strip(), "batas_usd": req.batas_usd,
            "paralel": req.paralel, "model": _seat_models(req.model)}


@router.post("/proyek")
def create_project(req: ProjectIn) -> dict:
    p = _admin("membuat proyek")
    rec = {"id": "pr-" + secrets.token_hex(5), **_project_rec(req), "dibuat_pada": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "dibuat_oleh": p.get("username") or p.get("id")}
    with _PROJECTS_LOCK:
        _write_projects([*_projects(), rec])
    return rec


@router.put("/proyek/{pid}")
def update_project(pid: str, req: ProjectIn) -> dict:
    """A project's settings changed (a seat moved off a model, another limit): the next engagement uses them."""
    _admin("mengubah proyek")
    with _PROJECTS_LOCK:
        items = _projects()
        i = next((i for i, x in enumerate(items) if x["id"] == pid), None)
        if i is None:
            raise HTTPException(404, "proyek tidak ada")
        items[i] = {**items[i], **_project_rec(req), "diubah_pada": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        _write_projects(items)
    return items[i]


@router.delete("/proyek/{pid}")
def delete_project(pid: str) -> dict:
    """A project off the list, with its engagements (each to runs-terhapus/, as one engagement's delete); refused while one runs."""
    from aip import runs

    _admin("menghapus proyek")
    _project(pid)
    mine = []
    for d in runs._dir().iterdir():
        try:
            rec = json.loads((d / "run.json").read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if rec.get("proyek") == pid:
            if d.name in runs._live:
                raise HTTPException(409, "satu penugasan proyek ini masih berjalan: hentikan dulu")
            mine.append(d.name)
    for run_id in mine:
        _bin(run_id)
    with _PROJECTS_LOCK:
        _write_projects([x for x in _projects() if x["id"] != pid])
    return {"dihapus": pid, "penugasan": mine}


@router.get("/{run_id}/laporan-lengkap")
def full_report(run_id: str, request: Request) -> dict:
    """The engagement's long report: its chapters (the firm's sections) with numbered exhibits computed from its results,
    and the exhibits' commentary once written (aip/laporan_konsultan.py)."""
    from aip import laporan_konsultan as L
    from aip import runs

    if runs.check_access(run_id).get("kind") != "konsultan":
        raise HTTPException(404, "bukan penugasan AI Agent Swarm")
    return L.build(run_id, request)


@router.post("/{run_id}/laporan-lengkap/narasi")
def write_report_notes(run_id: str, request: Request) -> dict:
    """The writer model's commentary on each exhibit, once per engagement, every number checked by code (admin: it costs
    a model call)."""
    import auth

    from aip import laporan_konsultan as L
    from aip import runs

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "menulis penjelasan exhibit butuh admin")
    rec = runs.check_access(run_id)
    if rec.get("kind") != "konsultan" or rec.get("status") != "succeeded":
        raise HTTPException(409, "hanya penugasan yang selesai")
    doc = L.frozen(run_id)  # the frozen exhibits when the engagement has them: the commentary is about what the report shows
    return {"status": L.start_commentary(run_id, doc["exhibit"] if doc else L.exhibits(rec, runs._events(run_id), request))}


@router.get("/{run_id}/laporan-lengkap/jejak")
def claim_lineage(run_id: str, klaim: str, faskes: str, request: Request) -> dict:
    """One claim of a case file traced from the BPJS source file to the case file's figure, through bronze, silver,
    gold, the ML inference, the indications and the Box rule (aip/jejak_data.py); each layer read as the caller."""
    from aip import jejak_data as J
    from aip import runs

    run = runs.check_access(run_id)
    if run.get("kind") != "konsultan":
        raise HTTPException(404, "bukan penugasan AI Agent Swarm")
    return J.trace(klaim.strip(), faskes.strip(), request, run)


@router.get("/{run_id}/laporan-lengkap/pdf")
def report_pdf(run_id: str):
    """The long report as a PDF (A4, light, every case file open): its print page drawn by headless Chrome as the asking
    user (report_render.py), so it holds what they may see; it waits for the page to say the report is drawn."""
    import auth
    import report_render
    from fastapi.responses import Response

    from aip import runs

    if runs.check_access(run_id).get("kind") != "konsultan":
        raise HTTPException(404, "bukan penugasan AI Agent Swarm")
    css = "font-size:7.5px;color:#6b7280;width:100%;padding:0 0.45in;font-family:Arial,Helvetica,sans-serif;"
    head = f'<div style="{css}">AI Agent Swarm · Laporan penugasan · BluesandAI</div>'
    foot = (f'<div style="{css}display:flex;justify-content:space-between;"><span>{run_id} · indikasi, bukan putusan fraud; keputusan di tangan manusia</span>'
            '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>')
    try:
        data = report_render.render(f"/aip-jkn/laporan?run={run_id}&cetak=1&embed=1", "pdf", (auth.current() or {}).get("id"), width=900, height=1200,
                                    ready="(d => d.laporan === 'gagal' ? 'gagal' : d.laporan === 'siap' && d.jejak !== 'memuat' ? 'siap' : '')(document.documentElement.dataset)", timeout_s=150,
                                    pdf={"paperWidth": 8.27, "paperHeight": 11.69, "marginTop": 0.6, "marginBottom": 0.6, "marginLeft": 0.45,
                                         "marginRight": 0.45, "scale": 0.8, "displayHeaderFooter": True, "headerTemplate": head, "footerTemplate": foot})
    except report_render.RenderError as e:
        raise HTTPException(503, f"PDF tidak bisa dibuat: {e}") from e
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="laporan-ai-agent-swarm-{run_id}.pdf"', "Cache-Control": "no-store"})


@router.post("/{run_id}/laporan-lengkap/bekukan")
def freeze_report(run_id: str, request: Request) -> dict:
    """The long report's exhibits and case files frozen as the engagement leaves them: by the engagement's report desk
    at its end (with the engagement's own token), or by an administrator for one from before."""
    from aip import laporan_konsultan as L
    from aip import runs

    rec = runs.check_access(run_id)
    if rec.get("kind") != "konsultan":
        raise HTTPException(404, "bukan penugasan AI Agent Swarm")
    if rec.get("status") not in ("running", "succeeded"):
        raise HTTPException(409, "hanya penugasan yang berjalan atau selesai")
    return L.freeze(run_id, request)


class NotesIn(BaseModel):
    model: str = Field(..., max_length=120)
    narasi: dict = Field(default_factory=dict)  # exhibit id (or "Exhibit N") -> {"makna", "implikasi"}


@router.post("/{run_id}/laporan-lengkap/narasi-agen")
def save_report_notes(run_id: str, req: NotesIn) -> dict:
    """The exhibit analyst's commentary, while its engagement runs: gated here against the frozen exhibits, every
    sentence whose numbers their facts do not give dropped and named."""
    from aip import laporan_konsultan as L
    from aip import runs

    rec = runs.check_access(run_id)
    if rec.get("kind") != "konsultan" or rec.get("status") != "running":
        raise HTTPException(409, "penjelasan agen hanya selama penugasannya berjalan; sesudahnya lewat tombol admin")
    try:
        return L.save_agent_commentary(run_id, req.model, req.narasi)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.get("/terakhir")
def latest() -> dict:
    """The last finished engagement on the platform (whoever ran it): the analysis the chat answers from. None yet: the
    chat waits for one (the user, 2026-10-24: start an engagement first, then the analysis, then the questions)."""
    from aip import paket

    rec, _ = paket._last_engagement()
    return {"ada": bool(rec), **({"run": rec["id"], "pada": rec.get("finished_at") or rec["created_at"], "biaya_usd": rec.get("spent_usd")} if rec else {})}


@router.get("/runs")
def engagements(limit: int = 20) -> list[dict]:
    from aip import runs

    return [r for r in runs.list_runs(200) if r.get("kind") == "konsultan"][:limit]


SIM_VERSION = "1"  # bump when the simulation's events change: every cached simulation is built again
_sim_mem: dict[str, bytes] = {}  # the latest simulations, as sent


@router.get("/simulasi")
def simulation(proyek: Optional[str] = None, sumber: Optional[str] = None) -> Any:
    """A Blu 1.1 engagement as an animation only, no model called (the user, 2026-10-30: "animation simulation phase 1 - end
    without consuming real api … in audit nasional 1.1 project"): phase 1, the clinical review, made of events projected
    from the last calibration over the whole review set; phases 2–8, the real trail of the project's latest finished
    engagement, as it ran. The replay file the animation opens (Simpan replay's form), never a run: the chat's audit pack,
    Evaluasi Swarm and the box read real engagements only."""
    from datetime import timedelta

    from aip import runs, telaah

    if sumber:
        src = runs.check_access(sumber)
    else:
        src = next((r for r in runs.list_runs(200) if r.get("kind") == "konsultan" and r.get("status") == "succeeded" and not r.get("ulang_laporan")
                    and r.get("versi") != "1.1" and (not proyek or r.get("proyek") == proyek)), None)
        if not src:
            raise HTTPException(404, "proyek ini belum punya penugasan selesai untuk disimulasikan")
    # built once per source trail and calibration, kept on disk and in memory (the user, 2026-10-30: "kalau udh load gausah
    # loading lagi"): ~13 s to build after a restart (the review set, a 9 MB trail), a moment to send again
    import hashlib

    from fastapi.responses import Response

    cal = telaah._last_calibration() or {}
    trail = runs._dir() / src["id"] / "events.jsonl"
    try:
        stamp = trail.stat().st_mtime_ns
    except OSError:
        raise HTTPException(404, f"jejak {src['id']} tidak ada") from None
    key = hashlib.sha1(json.dumps([SIM_VERSION, src["id"], stamp, cal.get("run_id"), cal.get("t")]).encode()).hexdigest()[:16]
    cache = runs._dir().parent / "simulasi"
    path = cache / f"{src['id']}-{key}.json"
    hit = _sim_mem.get(key)
    if hit is None and path.is_file():
        hit = path.read_bytes()
        _sim_mem.clear()
        _sim_mem[key] = hit
    if hit is not None:
        return Response(hit, media_type="application/json")
    events = runs._events(src["id"])
    firm = next((e for e in events if e.get("type") == "firm"), None)
    if not firm:
        raise HTTPException(409, f"jejak {src['id']} tidak memuat tim firma")
    hasil = cal.get("hasil") or {}
    try:
        n = len(telaah.review_set())
    except HTTPException:
        n = 0  # no review set on this data yet
    screen_rate = float(((hasil.get("saring") or {}).get("porsi_diperiksa_ulang")) or 0.16)
    tag_rate = (hasil.get("layak_tag") or 31) / max(1, cal.get("n") or 300)
    mix = (hasil.get("saring") or {}).get("kesimpulan") or {"wajar": 252, "perlu_diperiksa": 24, "mencurigakan": 24}
    mix_n = max(1, sum(mix.values()))
    checked = round(n * (screen_rate + telaah.AUDIT_SHARE * (1 - screen_rate)))
    tags = round(n * tag_rate)
    models = (cal.get("model") or {"saring": aip_models.DEEPSEEK, "periksa": aip_models.GLM})
    per = cal.get("hasil", {}).get("saring", {}).get("usd_per_klaim") or 0.000284, cal.get("hasil", {}).get("periksa", {}).get("usd_per_klaim") or 0.00123
    # phase 1 ends a minute before the trail's first event, and takes what it would take: ~2.5 h screening, ~1.5 h re-check
    first = datetime.fromisoformat(str(events[0]["t"]))
    t0 = first - timedelta(hours=4, minutes=12)
    at = lambda s: (t0 + timedelta(seconds=s)).strftime("%Y-%m-%dT%H:%M:%S")  # noqa: E731
    sim = {"simulasi": True}
    out: list[dict] = [{"t": at(0), "type": "run", "status": "started", "kind": "konsultan", **sim},
                       {**firm, "t": at(0), "versi": "1.1", "mesin": (firm.get("mesin") or MACHINES) + [TELAAH_MACHINE],
                        "fase": [{"id": "telaah", "label": "Telaah klinis (Blu 1.1)"}] + list(firm.get("fase") or []), **sim},
                       {"t": at(1), "type": "phase", "phase": "telaah", "label": "Telaah klinis (Blu 1.1)", "status": "mulai", **sim},
                       {"t": at(1), "type": "machine", "key": "telaah_klinis", "status": "bekerja", **sim},
                       {"t": at(2), "type": "telaah", "tahap": "mulai", "mode": "penuh", "klaim": n, "model": models, "batas_usd": telaah.ceiling(), "usd": 0, **sim}]

    def progress(s: int, tahap: str, done: int, total: int, usd: float) -> dict:
        k = {c: round(done * mix.get(c, 0) / mix_n) for c in telaah.CONCLUSIONS} if tahap == "saring" else {}
        return {"t": at(s), "type": "telaah", "tahap": tahap, "selesai": done, "total": total, "usd": round(usd, 4), "batas_usd": telaah.ceiling(),
                **({"kesimpulan": k} if k else {}), "gagal": 0, "ditolak_keluarga": 0, **sim}

    # the calibration: the first 300 claims through both models
    s = 3
    for tahap, steps in (("saring", (150, 300)), ("periksa", (150, 300))):
        for d in steps:
            s += 60
            out.append(progress(s, tahap, d, 300, d * (per[0] if tahap == "saring" else per[1])))
    s += 10
    out.append({"t": at(s), "type": "telaah", "tahap": "kalibrasi", "n": cal.get("n") or 300, "kappa": hasil.get("kappa_berbobot", 0.5833), "lolos": True,
                "alasan": [], "proyeksi_usd": cal.get("proyeksi_usd"), "model": models, **sim})
    # the whole set through the screen, then the re-check of what was not wajar and a 5% random sample
    for i in range(1, 37):
        s += 250
        out.append(progress(s, "saring", round(n * i / 36), n, n * i / 36 * per[0]))
    for i in range(1, 19):
        s += 300
        out.append(progress(s, "periksa", round(checked * i / 18), checked, n * per[0] + checked * i / 18 * per[1]))
    usd = round(n * per[0] + checked * per[1], 2)
    s += 20
    out.append({"t": at(s), "type": "tag", "agent": telaah.AGENT, "bulk": True, "tag": "telaah_klinis", "entitas": "klaim", "jumlah": tags, "baru": tags,
                "kekuatan_agen": "lemah", "kekuatan": "lemah", "judul": f"{tags} klaim bermasalah menurut kedua model", "bukti": "telaah klinis Blu 1.1 (simulasi)", **sim})
    summary = {"status": "selesai", "ditelaah": n, "diperiksa_ulang": checked, "layak_tag": tags, "tag": tags, "usd": usd, "model": models,
               "kesimpulan_saring": {c: round(n * mix.get(c, 0) / mix_n) for c in telaah.CONCLUSIONS}, "kalibrasi": {"hasil": {"kappa_berbobot": hasil.get("kappa_berbobot")}}}
    out += [{"t": at(s + 5), "type": "telaah", "tahap": "selesai", **{k: v for k, v in summary.items() if k != "kalibrasi"}, **sim},
            {"t": at(s + 6), "type": "machine", "key": "telaah_klinis", "status": "selesai", "hasil": summary, **sim},
            {"t": at(s + 6), "type": "phase", "phase": "telaah", "label": "Telaah klinis (Blu 1.1)", "status": "selesai", "status_telaah": "selesai",
             "ditelaah": n, "tag": tags, **sim}]
    # phases 2–8: the real engagement as it ran (its own start and roster were laid at the head)
    out += [e for e in events if e.get("type") not in ("run", "firm")]
    run = {"id": f"simulasi-{src['id']}", "kind": "konsultan", "status": "succeeded", "versi": "1.1", "simulasi": True,
           "nama": f"Simulasi Blu 1.1 · {src.get('nama') or src['id']}", "proyek": src.get("proyek"), "q": src.get("q"),
           "created_at": t0.isoformat(), "finished_at": src.get("finished_at"), "spent_usd": 0.0, "agents_usage": {}}
    body = json.dumps({"jenis": "animasi-penugasan", "versi": 1, "simulasi": True, "sumber": src["id"], "run": run, "events": out,
                       "catatan": "fase telaah klinis adalah proyeksi dari kalibrasi terakhir (tanpa panggilan model); fase 2–8 jejak nyata penugasan sumber"},
                      ensure_ascii=False, default=str).encode("utf-8")
    cache.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(body)
    os.replace(tmp, path)
    for old in cache.glob(f"{src['id']}-*.json"):  # an older simulation of the same trail (another calibration)
        if old != path:
            old.unlink(missing_ok=True)
    _sim_mem.clear()
    _sim_mem[key] = body
    return Response(body, media_type="application/json")
