"""Blu 3.0: the AI Agent Swarm on fraud-model architecture v3 (the user, 2026-11-12: "perbaiki juga skema AI Agent swarm, mungkin
ada beberapa agent yg harus dihilangkan atau di modifikasi, bikin juga arsitektur multiagent baru buat AI agent swarm yg pake v3
ini biar cocok · Blu 3.0"; "source data AI agent swarm pake synthetic data dulu"; "for agent swarm use Vertex Google").

What changed from Blu 1.0, and the evidence (testing/laporan_v3.py; ML Studio → Sistem ML terbaru):
- the ML line (Agen Machine Learning, its technique sub-agents, the ML consensus machine) → the v3 scoring machine: one
  fused, calibrated model already scores every claim (fresh test B: 95.8 % of the planted fraud at 89 % precision); the
  technique agents' tags repeated each other 92 % of the time (aip/konsultan.py, 2026-10-23);
- the clinical review of Blu 1.1 / 1.3 (a model reads every risky claim) → the same machine: deterministic and free (on
  verifier corrections the language models predicted nothing, ML Studio · Perbandingan);
- 12 mode specialists and 5 domain managers → 5 family agents, one per family of Permenkes 16/2019 modes that the v3
  specialists cover (koding, tagihan, episode, identitas, jaringan), under three leads;
- one analyst per province stays (38 in Nexus; the user, 2026-11-12: "Analis wilayah jadi 38 aja, soalnya riil nya per
  provinsi banyak nanti"): ordered by v3 expected fraud, and a province under 2 % of it gets the smaller step budget;
- the peer analyst → dropped: two weeks of claims are too few per facility for a peer outlier.
Kept: the partner, the investigators (one instance per facility at the top of the quarantine box), one QA reviewer per
lead (another model family), the red team, the validator, the report desk.

Data: the Nexus types the swarm reads, in their v3 profile (testing/blu3_profil.py: Klaim Berisiko, Skor Risiko Klaim ML,
Risiko Faskes ML and Peserta Klaim Berisiko hold the v3 package of testing/blu3_data.py; facility profiles, provinces and
peer tables are the baseline). Synthetic now; the real data later is another profile through the same pipeline."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from aip import models as aip_models

ROOT = Path(__file__).resolve().parents[2]
PAKET = ROOT / "testing" / "blu3" / "out"
PROFIL = ROOT / "testing" / "blu3" / "profil.json"
OWN = 0.02  # below this share of the v3 expected fraud, a province's analyst gets the smaller step budget (aip/konsultan.py OWN)

VERSION = {"nama": "Blu 3.0", "ringkas": "AI Agent Swarm di atas model fraud v3: skor v3 setiap klaim, lima agen kelompok modus Permenkes, "
                                         "investigasi box karantina",
           "tambahan": "data profil v3 (sintetis dulu); tanpa telaah LLM per klaim: mesin scoring v3 menggantikannya; model Vertex: "
                       "GLM 5.2 orkestrator, DeepSeek V4.1 Flash bekerja, gpt-oss-120b memeriksa"}
MACHINE = {"key": "skoring_v3", "name": "Scoring ML v3", "lini": "mesin",
           "peran": "setiap klaim dinilai arsitektur v3: peluang fraud, skor 4 spesialis keluarga Permenkes, rule route, network rule"}

# family -> (name, Permenkes modes, the ledger's tags, the lead, the v3 layer that scores it)
FAMILI: dict[str, dict] = {
    "koding": {"nama": "Coding diagnosis dan tindakan", "modus": ["M04", "M14", "M15", "M20"], "lead": "klaim_fraud", "lapisan": "koding",
               "tag": ["UPCODING_KEPARAHAN", "TINDAKAN_TIDAK_DILAKUKAN", "TIDAK_SESUAI_INDIKASI", "MANIPULASI_PEMERIKSAAN"]},
    "tagihan": {"nama": "Tagihan, kelas rawat dan obat/alkes", "modus": ["M07", "M13", "M17", "M18"], "lead": "klaim_fraud", "lapisan": "tagihan",
                "tag": ["TAGIHAN_MELEBIHI_TARIF", "KELAS_RAWAT", "OBAT_ALKES_FIKTIF", "PENGURANGAN_OBAT"]},
    "identitas": {"nama": "Identitas peserta dan duplikasi", "modus": ["M05", "M06", "M11"], "lead": "klaim_fraud", "lapisan": "identitas",
                  "tag": ["KLONING_KLAIM", "KLAIM_FIKTIF", "KLAIM_GANDA"]},
    "episode": {"nama": "Episode dan lama rawat", "modus": ["M08", "M09", "M12", "M16"], "lead": "peserta", "lapisan": "episode",
                "tag": ["PEMECAHAN_EPISODE", "LOS_DIPERPANJANG", "READMISI"]},
    "jaringan": {"nama": "Jaringan faskes", "modus": ["M10"], "lead": "peserta", "lapisan": "rule_jaringan",
                 "tag": ["RUJUKAN_SEMU", "JARINGAN_FASKES"]},
}
LEADS = {"klaim_fraud": "agen keluarga koding, tagihan dan identitas, dan penyidik box karantina",
         "peserta": "agen keluarga episode dan jaringan",
         "faskes_wilayah": "analis wilayah, satu per provinsi",
         "validator": "reviewer QA dan red team"}
LEAD_LINE = {"klaim_fraud": "kasus", "peserta": "modus", "faskes_wilayah": "wilayah", "validator": "qa"}


def seats(given: Optional[dict] = None) -> dict[str, str]:
    """The model of each seat on Vertex (the user, 2026-11-12: "orkestrator pasang glm 5.2 tapi sisanya GPT oss sama deepseek
    aja"): GLM 5.2 only in the orchestrator's seat ("glm": the partner and the run's planner); DeepSeek V4.1 Flash leads the
    lines, works, investigates and red-teams ("manajer", "deepseek"); gpt-oss-120b, another family than both, reviews and
    validates ("oss", "validator"). GLM in any other seat is refused: a project's other models fall back to the defaults."""
    given = {k: v for k, v in (given or {}).items() if v}
    is_glm = lambda m: aip_models.family(m) == aip_models.family(aip_models.GLM)  # noqa: E731
    out = {"glm": given.get("glm") or aip_models.GLM}
    for k, default in (("deepseek", aip_models.DEEPSEEK), ("oss", aip_models.GPT_OSS)):
        out[k] = given[k] if given.get(k) and not is_glm(given[k]) else default
    out["manajer"] = given["manajer"] if given.get("manajer") and not is_glm(given["manajer"]) else out["deepseek"]
    out["validator"] = given["validator"] if given.get("validator") and not is_glm(given["validator"]) else out["oss"]
    out["telaah_saring"], out["telaah_periksa"] = out["deepseek"], out["oss"]
    fam = {aip_models.family(out[k]) for k in ("glm", "deepseek", "manajer")}
    bad = [k for k in ("oss", "validator") if aip_models.family(out[k]) in fam]
    if bad:
        raise ValueError(f"Blu 3.0: {', '.join(bad)} harus dari keluarga model lain dari orkestrator dan model kerja")
    return out


# the control sample (the user, 2026-11-12, option 3): per province, 1 % of the claims outside Klaim Berisiko, at least 1 and at
# most 40 (what one regional analyst reads at once with baca_hasil), drawn with a fixed seed
KONTROL = {"fraksi": 0.01, "min_provinsi": 1, "maks_provinsi": 40, "seed": 20261112}
_LINGKUP: dict = {}


def lingkup() -> dict:
    """Blu 3.0's reading scope (the user, 2026-11-12: "kan kita bikin ML buat deteksi large data, data riil nya ratusan juta
    row ga mungkin pake AI swarm langsung makanya lewat flow ML v3 dulu"): the agents read claim rows only from Klaim
    Berisiko (ML v3's output) and from a control sample of the other claims, drawn to measure what the machine missed;
    aggregates (ukur, agregasi_objek) still count every claim. Read from the package's files, cached per file version."""
    import pandas as pd

    files = [PAKET / "klaim_berisiko.parquet", PAKET / "skor_risiko_klaim_ml.parquet"]
    stamp = tuple(f.stat().st_mtime for f in files)
    if _LINGKUP.get("stamp") == stamp:
        return _LINGKUP["data"]
    kb = set(pd.read_parquet(files[0], columns=["klaim_id"])["klaim_id"].astype(str))
    cols = ["klaim_id", "faskes_profil_id", "nama_profil", "provinsi", "inacbg_kode", "tingkat_pelayanan", "biaya_tagih", "tarif_inacbg", "los",
            "risiko", "alasan_utama"]
    ml = pd.read_parquet(files[1], columns=cols)
    ml["klaim_id"] = ml["klaim_id"].astype(str)
    for c in ("biaya_tagih", "tarif_inacbg", "los", "risiko"):
        ml[c] = pd.to_numeric(ml[c], errors="coerce").fillna(0)
    out = ml[~ml["klaim_id"].isin(kb)]
    parts = []
    for _, g in out.groupby("provinsi", sort=True):
        n = int(min(KONTROL["maks_provinsi"], max(KONTROL["min_provinsi"], round(KONTROL["fraksi"] * len(g)))))
        parts.append(g.sample(n=min(n, len(g)), random_state=KONTROL["seed"]).assign(populasi_provinsi=len(g)))
    s = pd.concat(parts) if parts else out.head(0).assign(populasi_provinsi=0)
    txt = lambda v: None if v is None or (isinstance(v, float) and v != v) else str(v)  # noqa: E731
    rows = [{"klaim_id": x.klaim_id, "faskes_profil_id": txt(x.faskes_profil_id), "faskes": txt(x.nama_profil), "provinsi": txt(x.provinsi),
             "inacbg_kode": txt(x.inacbg_kode), "tingkat_pelayanan": txt(x.tingkat_pelayanan), "biaya_tagih_rp": float(x.biaya_tagih),
             "tarif_inacbg_rp": float(x.tarif_inacbg), "los_hari": int(x.los), "risiko_v3": round(float(x.risiko), 4), "alasan_utama": txt(x.alasan_utama),
             "populasi_provinsi": int(x.populasi_provinsi)} for x in s.itertuples()]
    data = {"klaim_berisiko": sorted(kb), "kontrol": rows, "di_luar": int(len(out)), "aturan": KONTROL}
    _LINGKUP.update(stamp=stamp, data=data)
    return data


def ringkasan() -> Optional[dict]:
    f = PAKET / "ringkasan_v3.json"
    return json.loads(f.read_text("utf-8")) if f.exists() else None


def profil() -> dict:
    """Which data profile the Nexus types hold now: "v3" only when all four claim-level types point at the v3 package."""
    import ontology

    st = json.loads(PROFIL.read_text("utf-8")) if PROFIL.exists() else {}
    types = {x["display_name"]: x for x in ontology._all("object-types")}
    now = {n: ((types.get(n) or {}).get("backing_dataset") or {}).get("dataset_id") for n in (st.get("v3") or {})}
    aktif = bool(st.get("v3")) and all(now[n] == st["v3"][n] for n in st["v3"])
    return {"aktif": "v3" if aktif else "cart", "dataset": now, "paket": bool(ringkasan())}


def roster(models: dict, provinces: list[dict], report_team) -> tuple[list[dict], list[dict]]:
    """(the team, why each line has its size) for Blu 3.0. provinces: the Nexus provinces (code, name, claims)."""
    from aip import domains

    names = {a["key"]: a["name"].replace(" (BPJS)", "") for a in domains.catalogue()["agents"]}
    rot = [models["deepseek"], models["oss"]]  # the field corroborates across two families
    why: list[dict] = []
    members: list[dict] = []
    i = 0

    def add(a: dict) -> None:
        nonlocal i
        members.append({**a, "jenjang": "analis", "peran_kode": a.get("peran_kode", "analis"), "model": a.get("model") or rot[i % 2]})
        i += 1

    rk = ringkasan() or {}
    exp = {str(x["provinsi"]).upper(): x for x in rk.get("provinsi_semua") or rk.get("provinsi_teratas") or []}
    total = sum(x["ekspektasi"] for x in exp.values()) or 1
    small = 0
    # one analyst per Nexus province, the largest v3 expected fraud first; a province with none in this period still gets its
    # analyst (the real data later fills every province), on the smaller step budget
    for p in sorted(provinces, key=lambda p: -(exp.get(str(p["provinsi"]).upper()) or {}).get("ekspektasi", 0)):
        x = exp.get(str(p["provinsi"]).upper()) or {}
        e, share = x.get("ekspektasi", 0.0), x.get("ekspektasi", 0.0) / total
        small += share < OWN
        add({"key": f"prov_{p['provinsi_kode']}", "name": f"Analis Wilayah · {str(p['provinsi']).title()}", "lini": "wilayah", "induk": "faskes_wilayah",
             "peran": (f"menelusuri indikasi di provinsi {p['provinsi']}: ekspektasi {e:.1f} klaim fraud menurut v3 ({share:.1%}), lintas kelompok modus"
                       if e else f"menelusuri indikasi di provinsi {p['provinsi']}: belum ada klaim di periode ini, lintas kelompok modus"),
             "target": {"provinsi": [p["provinsi"]], "provinsi_kode": [p["provinsi_kode"]], "porsi_klaim": round(share, 4), "kecil": share < OWN}})
    why.append({"lini": "wilayah", "agen": len(members),
                "alasan": f"satu analis per provinsi ({len(provinces)} provinsi), diurutkan menurut ekspektasi klaim fraud v3; {small} provinsi < "
                          f"{OWN:.0%} ekspektasi mendapat jatah langkah lebih kecil. Agen kelompok modus tetap mencakup modusnya secara nasional"})
    n0 = len(members)
    fam_rk = {x["famili"]: x for x in rk.get("famili") or []}
    for f, d in FAMILI.items():
        k = fam_rk.get(f) or {}
        add({"key": f"famili_{f}", "name": f"Agen {d['nama']}", "lini": "modus", "induk": d["lead"], "peran_kode": "analis",
             "peran": f"kelompok modus Permenkes {', '.join(d['modus'])} secara nasional, dari skor spesialis v3 dan sinyal rule",
             "target": {"famili": f, "modus": d["modus"], "tag": d["tag"], "lapisan": d["lapisan"], "klaim_v3": k.get("klaim"), "faskes_v3": k.get("faskes")}})
    why.append({"lini": "modus", "agen": len(members) - n0,
                "alasan": "satu agen per kelompok modus yang dinilai spesialis v3 (dari 12 spesialis modus dan agen ML dengan sub-agen teknik di Blu 1.0): "
                          "skor v3 sudah memisahkan keluarga, agen membuktikan dan menandai dengan modus yang tepat"})
    work = models.get("manajer") or models["deepseek"]  # leads, investigators, exhibits: DeepSeek; GLM only orchestrates
    members.append({"key": "penyidik_kasus", "name": "Penyidik kasus", "lini": "kasus", "jenjang": "peran", "induk": "klaim_fraud", "model": work,
                    "peran_kode": "penyidik", "peran": "satu peran: saat penugasan, satu instans berkonteks segar per faskes di antrean box karantina "
                                                       "(kelompok A, lalu B …) — kertas kerja audit dan rekomendasi jalur",
                    "target": {"kapasitas": 10, "antrean": "box karantina, kelompok A → Z"}})
    why.append({"lini": "kasus", "agen": 1, "alasan": "satu peran penyidik; instans per faskes di puncak box karantina saat penugasan, kapasitas 10"})
    leads = list(LEADS)
    for lead in leads:
        if lead == "validator":
            continue
        add({"key": f"qa_{lead}", "name": f"Reviewer QA · {names.get(lead, lead).removeprefix('Agen ')}", "lini": "qa", "induk": "validator", "model": models["oss"],
             "peran_kode": "qa", "peran": f"memeriksa ulang sintesis {names.get(lead, lead)} terhadap data", "target": {"lead": lead}})
    members.append({"key": "red_team", "name": "Red team", "lini": "qa", "jenjang": "peran", "induk": "validator", "model": models["deepseek"], "peran_kode": "red_team",
                    "peran": "satu peran: satu instans per indikasi terkuat di buku besar — membela penjelasan wajarnya, lalu memutus bertahan atau melemah",
                    "target": {"kapasitas": 6, "antrean": "indikasi terkuat (sedang ke atas, dari agen), satu per objek"}})
    why.append({"lini": "qa", "agen": len(leads), "alasan": f"{len(leads) - 1} reviewer QA (satu per agen pimpinan) dan satu peran red team (kapasitas 6)"})
    team: list[dict] = [{"key": "partner", "name": "Orkestrator · Partner", "lini": "pimpinan", "jenjang": "partner", "induk": None, "model": models["glm"],
                         "peran": "agen pimpinan: membaca ringkasan scoring v3, menyusun hipotesis dan fokus tiap lini, menulis laporan akhir", "peran_kode": "partner"}]
    for lead in leads:
        team.append({"key": lead, "name": "Validator" if lead == "validator" else names.get(lead, lead), "lini": LEAD_LINE[lead], "jenjang": "manajer",
                     "induk": "partner", "model": models["validator"] if lead == "validator" else work,
                     "peran_kode": "validator" if lead == "validator" else "manajer",
                     "peran": (f"memimpin {LEADS[lead]}: memeriksa setiap sintesis dan laporan akhir ke data, dari keluarga model lain" if lead == "validator" else
                               f"memimpin {LEADS[lead]} dan menyintesis laporan mereka")})
    why.insert(0, {"lini": "pimpinan", "agen": 1 + len(leads), "alasan": f"orkestrator (partner), {len(leads) - 1} agen pimpinan dan validator"})
    desk = report_team({"glm": work, "deepseek": models["deepseek"], "oss": models["oss"]})  # its "glm" seat (exhibits) → DeepSeek
    team.append(desk[0])
    members += desk[1:]
    why.append({"lini": "laporan", "agen": len(desk), "alasan": "redaksi laporan (kode) dengan editor bahasa dan analis exhibit"})
    return team + members, why


def brief_line() -> str:
    """What every agent of a Blu 3.0 engagement is told about the data it reads."""
    rk = ringkasan() or {}
    return ("DATA BLU 3.0 (profil v3, sintetis): 'Skor Risiko Klaim ML (BPJS)' berisi skor arsitektur v3 untuk SETIAP klaim — risiko = peluang "
            "fraud terkalibrasi (bukan peluang koreksi verifikator), ditandai = keputusan v3, alasan_json = skor tiap lapisan (model1 graph, "
            "spesialis coding, tagihan, episode, identitas) serta rute_rule dan rule_jaringan, lolos_verifikasi_berisiko = v3 menandai tetapi "
            "pemeriksaan otomatis meloloskan. 'Risiko Faskes ML (BPJS)': ekspektasi_koreksi = jumlah peluang fraud v3 di faskes itu (ekspektasi "
            "klaim fraud), klaim_ditandai = ditandai v3; koreksi_aktual kosong (tidak ada data verifikator). 'Klaim Berisiko (BPJS)': klaim yang "
            "ditandai v3, ditandai rule, atau berpeluang >= 20%; biaya_verifikasi kosong. Profil faskes, provinsi dan indikator INA-CBG adalah "
            f"baseline. Periode klaim {'–'.join(rk.get('periode') or ['-'])}; {rk.get('klaim', '?')} klaim, {rk.get('ditandai', '?')} ditandai v3.\n"
            # the smoke run of 2026-11-12 (run-c378fc7543b4): the partner still wrote a verifier-correction hypothesis and an analyst
            # ranked facilities by rasio_aktual_ekspektasi, both empty on this profile
            "ATURAN BLU 3.0: profil v3 TIDAK punya data koreksi verifikator: jangan menyusun hipotesis atau tag koreksi (koreksi_aktual, "
            "rasio_aktual_ekspektasi, KOREKSI_BERULANG); urutkan Risiko Faskes ML (BPJS) dengan ekspektasi_koreksi atau risiko_per_1000_klaim; "
            "susun hipotesis per kelompok modus v3 (coding, tagihan, episode, identitas, jaringan) dari hasil Scoring ML v3.")
