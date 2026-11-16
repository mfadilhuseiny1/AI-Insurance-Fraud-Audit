"""AI Agent Swarm Branch: the audit report of a BPJS branch office (Kantor Cabang), where claims are verified in practice.

The user (2026-11-13): "tab baru AI agent swarm branch — audit dilakukan kantor cabang, bukan kantor pusat; karena proses
real-nya yang melakukan verifikasi adalah kantor cabang; hasil audit dikelompokkan berdasarkan tema (jantung, paru, ...);
style audit mirip laporan AI Agent Swarm nasional".

The batch is the fresh generator 3 seed that v5 scored (testing/v5.py): every claim of a branch's hospitals went through v4
(model) + the rule engine, and the uncertain ones through the ADK swarm (3 specialists + a judge, Vertex AI). This script
reads those results, maps each hospital to a branch and each claim to a clinical theme (the INA-CBG CMG), and writes one
report per branch in the national report's shape (chapters, numbered exhibits, case files). No model is called.

Branch areas are a DEMO: each province's regencies/cities are grouped in code order into areas of about 1,200+ claims,
named after their largest city; this is not BPJS's official branch map. Synthetic data only.
Output: data/aip/cabang/index.json + kc_<id>.json."""
from __future__ import annotations

import hashlib
import os
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
import cabang_analisis as CA  # noqa: E402
# SWARM_V5_KERJA / UJI_SET_ROOT / CABANG_BASIS (testing/uji_riil.py): a real-data run stays in the BPJS project's data folder
KERJA = Path(os.environ.get("SWARM_V5_KERJA") or ROOT / ".tmp" / "swarm_v5")
SET_ROOT = Path(os.environ.get("UJI_SET_ROOT") or ROOT / ".tmp")
BASIS = Path(os.environ.get("CABANG_BASIS") or ROOT / "data" / "aip" / "cabang")
# UJI_RIIL_RS / UJI_RIIL_FKRTL (testing/uji_riil.py, 2026-11-13): the REAL sample's hospital profiles and silver claims. No labels:
# the technical appendix shows the verifiers' corrections as a weak proxy instead of a confusion matrix
RIIL_RS, RIIL_FKRTL = os.environ.get("UJI_RIIL_RS"), os.environ.get("UJI_RIIL_FKRTL")
RIIL = bool(RIIL_RS)
SUMBER_DATA = "klaim riil sampel BPJS (internal, pakta integritas)" if RIIL else "batch klaim sintetis"
PORSI_KC = 0.03  # a demo branch area holds about 3% of the national claim volume (historical, so areas are stable across runs)
TEMA = {"A": "Infeksi & parasit", "B": "Hati, empedu & pankreas", "C": "Kanker & neoplasma", "D": "Darah & imunitas", "E": "Endokrin & metabolik (diabetes)",
        "F": "Kesehatan jiwa", "G": "Saraf & otak", "H": "Mata", "I": "Jantung & pembuluh darah", "J": "Paru & pernapasan", "K": "Pencernaan",
        "L": "Kulit & payudara", "M": "Otot, tulang & sendi", "N": "Ginjal & saluran kemih", "O": "Persalinan", "P": "Bayi baru lahir",
        "Q": "Rawat jalan episodik", "S": "Cedera & keracunan", "U": "THT & mulut", "V": "Reproduksi pria", "W": "Reproduksi wanita",
        "Z": "Kontrol & observasi (organ tidak disebut)"}
TEMA.update({"O": "Kehamilan & persalinan", "KB": "Kelainan bawaan", "R": "Gejala & tanda tidak spesifik", "Q": "Rawat jalan (diagnosis tidak terbaca)"})


def tema_klaim(icd: str, kode: str) -> str:
    """The clinical theme: the primary diagnosis's ICD-10 chapter (dialysis care -> kidney, chemo/radiotherapy -> cancer, dental
    -> ENT & mouth); without a diagnosis, the INA-CBG CMG (its first letter)."""
    icd = (icd or "").strip().upper()
    if len(icd) >= 3 and icd[0].isalpha() and icd[1:3].isdigit():
        c, n = icd[0], int(icd[1:3])
        if c in "AB" or (c == "U" and n == 7):
            return "A"
        if c == "C" or (c == "D" and n <= 48):
            return "C"
        if c in "DEFGIJLMOP":
            return c
        if c == "H":
            return "H" if n <= 59 else "U"
        if c == "K":
            return "U" if n <= 14 else "K"
        if c == "N":
            return "N" if n <= 39 else ("V" if n <= 51 else "W")
        if c == "Q":
            return "KB"
        if c == "R":
            return "R"
        if c in "STVWXY":
            return "S"
        if c == "Z":
            # a follow-up/encounter code says no organ: a specific one by its meaning, else the INA-CBG CMG when it names a system
            khusus = {49: "N", 99: "N", 51: "C", 34: "O", 35: "O", 36: "O", 39: "O", 47: "M", 50: "M", 96: "H", 97: "H", 1: "U"}
            if n in khusus:
                return khusus[n]
            k = str(kode)[:1]
            return k if k in TEMA and k not in "QZ" else "Z"
    k = str(kode)[:1]
    return k if k in TEMA else "Q"


NON_SPESIFIK = ("Z", "R", "Q")  # themes that name no organ: listed after the clinical ones
FAMILI = {"koding": "Koding & klinis", "tagihan": "Tagihan", "episode": "Episode", "identitas": "Identitas", "jaringan": "Jaringan", "normal": "Tidak ada modus"}
KEP = {"TAHAN": "Tahan", "PERIKSA": "Periksa", "DIBERSIHKAN": "Dibersihkan swarm", "LOLOS": "Lolos"}


def judul(s: str) -> str:
    return " ".join(w.capitalize() if w not in ("DKI", "DI") else w for w in str(s).split())


def rp(v: float) -> str:
    return f"Rp {v / 1e9:,.2f} M".replace(",", "X").replace(".", ",").replace("X", ".") if v >= 1e9 else f"Rp {v / 1e6:,.1f} jt".replace(",", "X").replace(".", ",").replace("X", ".")


def pct(a: float, b: float) -> str:
    return f"{100 * a / b:.1f}%".replace(".", ",") if b else "—"


# ---- estimated loss per claim in the queue (the user, 2026-11-13: "nilai transaksi yang dianalisis, nilai klaim terindikasi fraud,
# nilai kerugian fraud di bagian atas"). Operational: no label is read. The mode is the one the ledger tag carries (the swarm
# judge's family, or for a TAHAN claim the family of its strongest indicators; aip/realtime/cabang_tag.tag_untuk), priced from
# the claim's own bill against the batch's peers (same INA-CBG code). The same number goes into the ledger tag, so Box Karantina
# prices the claim the same way (aip/karantina.claim_loss, part "estimasi_cabang").
PORSI_PASANGAN = 0.5  # a duplicate / copy / split / readmission: one claim of the pair is the legitimate one (= karantina.DUPLICATE_SHARE)
PITA_PEER = 1.5  # a claim with no specific mode: only what was billed above 1.5x the code's median (= karantina.PEER_BAND)
DASAR = {
    "UPCODING_KEPARAHAN": "selisih tarif ke tingkat keparahan satu di bawahnya",
    "TAGIHAN_MELEBIHI_TARIF": "tagihan di atas 1,5x median kode INA-CBG yang sama, atau top-up di atas median kode",
    "KLAIM_FIKTIF": "seluruh tagihan (pelayanan diduga tidak terjadi)",
    "KLONING_KLAIM": "separuh tagihan (satu dari pasangan klaim jiplakan dianggap sah)",
    "KLAIM_GANDA": "separuh tagihan (satu dari pasangan klaim ganda dianggap sah)",
    "PEMECAHAN_EPISODE": "separuh tagihan (episode yang dipecah dibayar satu kali)",
    "READMISI": "separuh tagihan (readmisi dibayar sebagai episode lanjutan)",
    "RUJUKAN_SEMU": "separuh tagihan (rujukan tidak sesuai)",
    "RISIKO_ML_TINGGI": "tagihan di atas 1,5x median kode INA-CBG yang sama",
    "IOT_DURASI_ALAT": "selisih tarif menurut pemakaian alat medis yang tercatat sensor IoT",
}
# the IoT layer (testing/iot_cabang.py; the user, 2026-11-15: "add another verification layer ... most device claims differ a lot for
# >= 96 h vs < 96 h, create fraud cases and add them to the audit report"): a current clamp on a device's power cable records when it
# runs, how long and in which mode; a claim whose billed device use the device contradicts gets this tag (strength kuat) and goes to
# the verifier even when the model and the swarm let it pass. Read from data/aip/cabang/iot/<set>/bukti.json when it exists.
TAG_IOT = "IOT_DURASI_ALAT"
LABEL_IOT = "Durasi alat medis tidak sesuai klaim (IoT)"
KEP_ANTRE = ("TAHAN", "PERIKSA")


def referensi_biaya(F: dict) -> dict:
    """Medians per INA-CBG code over the whole batch (all branches): tariff, bill and top-up."""
    import pandas as pd

    df = pd.DataFrame({"kode": F["kode"].astype(str), "tarif": F["tarif"].astype(float), "biaya": F["biaya"].astype(float), "topup": F["topup"].astype(float)})
    g = df.groupby("kode").median()
    return {"tarif": g["tarif"].to_dict(), "biaya": g["biaya"].to_dict(), "topup": g["topup"].to_dict()}


def kode_lebih_ringan(kode: str) -> str | None:
    base, _, sev = kode.rpartition("-")
    return {"III": f"{base}-II", "II": f"{base}-I"}.get(sev)


def taksir_kerugian(tag: str, biaya: float, tarif: float, topup: float, kode: str, ref: dict, iot: dict | None = None) -> tuple[int, str]:
    """(estimated loss in rupiah, the basis in words) for one claim in the queue."""
    med_b = ref["biaya"].get(kode) or biaya
    if tag == TAG_IOT and iot:  # the device's tariff difference: billed against what the measured usage supports
        t = iot["tarif"]
        v = float(t["selisih_rp"])
        dasar = (f"{DASAR[tag]}: {t.get('dasar') or 'selisih tarif'} (ditagih {iot['ditagih']['inacbg']} {rp(t['ditagih_rp'])} − "
                 f"{t['kode_seharusnya']} {rp(t['seharusnya_rp'])})")
    elif tag == "UPCODING_KEPARAHAN":
        low = kode_lebih_ringan(kode)
        if low and low in ref["tarif"]:
            v = max(0.0, tarif - ref["tarif"][low])
            dasar = f"{DASAR[tag]} ({low})"
        else:
            v = max(0.0, biaya - med_b)
            dasar = "tagihan di atas median kode INA-CBG yang sama (tidak ada tingkat keparahan lebih rendah)"
    elif tag == "TAGIHAN_MELEBIHI_TARIF":
        v = max(0.0, topup - (ref["topup"].get(kode) or 0.0), biaya - PITA_PEER * med_b)  # = Box's TAGIHAN_MELEBIHI_TARIF band
        dasar = DASAR[tag]
    elif tag == "KLAIM_FIKTIF":
        v, dasar = biaya, DASAR[tag]
    elif tag in ("KLONING_KLAIM", "KLAIM_GANDA", "PEMECAHAN_EPISODE", "READMISI", "RUJUKAN_SEMU"):
        v, dasar = PORSI_PASANGAN * biaya, DASAR[tag]
    else:
        v, dasar = max(0.0, biaya - PITA_PEER * med_b), DASAR["RISIKO_ML_TINGGI"]
    return int(round(min(v, biaya), -2)), dasar


def cek_kerugian(q_kasus: list[dict], z: dict, idx: np.ndarray) -> dict:
    """Technical appendix only (synthetic labels): how much of the estimated loss sits on claims that really are fraud."""
    lab = {"KLM-" + hashlib.md5(str(z["kunci"][i]).encode()).hexdigest()[:8].upper(): int(z["y"][i]) for i in idx}
    fr = [c for c in q_kasus if lab.get(c["id"]) == 1]
    tot = sum(c["estimasi_kerugian_rp"] for c in q_kasus)
    di = sum(c["estimasi_kerugian_rp"] for c in fr)
    return {"klaim_antrean": len(q_kasus), "klaim_fraud": len(fr), "estimasi_rp": int(tot), "di_klaim_fraud_rp": int(di),
            "porsi_di_fraud": round(di / tot, 4) if tot else None, "nilai_terindikasi_rp": int(sum(c["biaya_rp"] for c in q_kasus)),
            "nilai_terindikasi_fraud_rp": int(sum(c["biaya_rp"] for c in fr))}


def cek_riil(M: dict, idx: np.ndarray) -> dict:
    """Real runs (no labels): the model's zones (TAHAN / RAGU / LOLOS, model + rule only), what the swarm did with the RAGU claims
    it read (a one-branch run reads only that branch's), and where the claims the BPJS verifiers corrected (flag_selisih_verifikasi,
    0.07 % of the window) and the dataset's duplicate-candidate flag landed. A weak proxy: a correction is not fraud, and most fraud
    is never corrected."""
    F, kep, z = M["F"], M["kep"][idx], M["z"]
    tahan, ragu = z["tahan"][idx].astype(bool), z["ragu"][idx].astype(bool)
    dibaca = ragu & np.array([str(k) in M["agen"] for k in z["kunci"][idx]])
    zona = {"TAHAN": tahan, "RAGU": ragu, "LOLOS": ~tahan & ~ragu}

    def hitung(m: np.ndarray) -> dict:
        return {"n": int(m.sum()), "zona": {k: int((v & m).sum()) for k, v in zona.items()},
                "swarm": {"dibaca": int((dibaca & m).sum()), "periksa": int((dibaca & m & (kep == "PERIKSA")).sum()),
                          "dibersihkan": int((dibaca & m & (kep == "DIBERSIHKAN")).sum())}}

    out = {"klaim": int(len(idx)), **{k: v for k, v in hitung(np.ones(len(idx), bool)).items() if k != "n"},
           "rule": int(M["rule_mask"][idx].sum()), "ragu_belum_dibaca": int((ragu & ~dibaca).sum())}
    for nm, lbl in (("proksi_selisih", "koreksi_verifikator"), ("calon_ganda", "calon_klaim_ganda")):
        if nm in F:
            out[lbl] = hitung(F[nm][idx].astype(bool))
    if "selisih_rp" in F:
        sel = np.abs(F["selisih_rp"][idx].astype(float))
        out["selisih_rp"] = {"total": int(sel.sum()), "di_antrean": int(sel[np.isin(kep, ["TAHAN", "PERIKSA"])].sum()),
                             "di_ragu": int(sel[ragu].sum())}
    return out


def tag_klaim(ka: dict, hakim: dict, rule: list[str]) -> str:
    """The ledger tag of a queued claim, exactly as aip/realtime/cabang_tag.tulis writes it."""
    from aip.realtime.cabang_tag import tag_untuk

    return tag_untuk(ka.get("famili") or "normal", f"{hakim.get('alasan', '')} {hakim.get('bukti', '')} {ka.get('alasan', '')}", rule or [])


def label_tag(tag: str) -> str:
    from aip import semantik as SEM

    if tag == TAG_IOT:
        return LABEL_IOT

    return (SEM.TAG.get(tag) or {}).get("label", tag)



def muat(nama: str) -> dict:
    SET = SET_ROOT / nama
    import v4_rule_tambah as RT
    import v5 as V5

    z = dict(np.load(KERJA / f"zona_{nama}.npz", allow_pickle=False))
    K = json.loads((V5.MODEL / "kartu.json").read_text("utf-8"))
    meta_f = KERJA / f"zona_{nama}.json"  # written by v5.py siapkan since ML v7 (older sets: v4)
    meta = json.loads(meta_f.read_text("utf-8")) if meta_f.exists() else {"model": "v4", "q_ref": "ref.npz"}
    if meta.get("ambang"):
        K = {**K, "ambang": {**K["ambang"], **meta["ambang"]}}
    q_ref = np.load(KERJA / meta["q_ref"])["q_ref"]
    agen = json.loads((KERJA / f"agen_{nama}.json").read_text("utf-8"))
    p = np.array([agen[k]["hakim"]["p"] if k in agen else np.nan for k in z["kunci"]])
    pp = np.nan_to_num(p, nan=0.0)
    f = pp if K["pilihan"] == "V5a" else (pp + np.searchsorted(q_ref, z["s"], "right") / len(q_ref)) / 2
    # the rule-evidence lane (testing/jalan_kc_tema.py stage aturan; swarm_v5.gerbang): claims the rule engines (RME, IoT) route to the
    # swarm are RAGU too, and a judge who accepts a verified finding can lift f to (p + k) / 2. A run without jalur_<set>.json builds as before
    jf = KERJA / f"jalur_{nama}.json"
    jalur = json.loads(jf.read_text("utf-8")) if jf.exists() else None
    gerbang = {}
    if jalur:  # rule engines -> swarm (jalan_kc_tema stage aturan; swarm_v5.gerbang)
        import swarm_v5 as SW

        rute = np.isin(z["kunci"].astype(str), jalur["rute_aturan"]) & ~z["tahan"]
        z["ragu_ml"], z["ragu"] = z["ragu"], z["ragu"] | rute
        f, gerbang = SW.terapkan_gerbang(z["kunci"], f, p, agen, jalur["klaim"], float(K["tau"]))
    # a RAGU claim the swarm never read (the cost cap stopped new batches, or a one-branch run) is BELUM_DIBACA, not cleared
    # (the user's run review, 2026-11-15: an unread claim shown as "dibersihkan swarm" claimed a judgement nobody made)
    dibaca = np.array([str(k) in agen for k in z["kunci"]])
    kep = np.where(z["tahan"], "TAHAN", np.where(z["ragu"] & ~dibaca, "BELUM_DIBACA", np.where(z["ragu"] & (f >= K["tau"]), "PERIKSA",
                   np.where(z["ragu"], "DIBERSIHKAN", "LOLOS"))))
    raw = [dict(np.load(f, allow_pickle=False)) for f in sorted(SET.glob("hasil_[0-9][0-9].npz"))]  # loaded once (NpzFile re-reads per access)
    cp = np.array([[int(x) for x in k.split(":")[1:]] for k in z["kunci"]])
    ambil = lambda nm: np.array([raw[c][nm][i] for c, i in cp])  # noqa: E731
    F = {nm: ambil(nm) for nm in ("faskes", "kode", "biaya", "tarif", "los", "topup", "dxs", "tgl", "tingkat", "kelas", "peserta", "sinyal")}
    for nm in ("proksi_selisih", "selisih_rp", "calon_ganda", "replika"):  # real runs only (testing/uji_riil.py): the verifiers' corrections
        if nm in raw[0]:
            F[nm] = ambil(nm)
    # the primary diagnosis: saved by the runner since 2026-11-13; for gen3_v5 recovered by testing/gen3_dx.py ("" where not aligned)
    if "dx" in raw[0]:
        F["dx"], F["dx_nama"] = ambil("dx").astype(str), ambil("dx_nama").astype(str)
    else:
        dx = {c: dict(np.load(SET / f"dx_{c:02d}.npz", allow_pickle=False)) for c in range(8) if (SET / f"dx_{c:02d}.npz").exists()}
        F["dx"] = np.array([str(dx[c]["icd"][i]) if c in dx else "" for c, i in cp])
        F["dx_nama"] = np.array([str(dx[c]["nama"][i]) if c in dx else "" for c, i in cp])
    # rule names per claim (the rule engine's set, as v5 used it)
    import joblib

    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    aturan = [{k: r[k] for k in ("aturan", "fitur", "ambang")} for r in json.loads((ROOT / ".tmp" / "data_v4" / "aturan_v4.json").read_text("utf-8"))["dipilih"]]
    X1 = np.vstack([raw[c]["X1"][i] for c, i in cp]); X4 = np.vstack([raw[c]["X4"][i] for c, i in cp]); XR = np.vstack([raw[c]["XR"][i] for c, i in cp])
    komp = RT.komponen(aturan, b3.get("rute_rule") or {}, b3.get("rule_jaringan") or {}, X1, X4, XR)
    rule = [[n.split(" · ", 1)[-1] for n, v in komp.items() if v[i]] for i in range(len(cp))]
    if RIIL:
        import duckdb

        rs_d = json.loads(Path(RIIL_RS).read_text("utf-8"))
        desk = dict(duckdb.sql(f"""SELECT inacbg_kode, any_value(inacbg_deskripsi) FROM read_parquet('{Path(RIIL_FKRTL).as_posix()}')
                                    WHERE inacbg_kode IS NOT NULL GROUP BY 1""").fetchall())
    else:
        import generator3 as G

        D = G.dunia()
        rs_d = D.rs
        con = G._con()
        desk = dict(con.execute("SELECT inacbg_kode, any_value(inacbg_deskripsi) FROM s GROUP BY 1").fetchall())
    # the model's reasons (SHAP) for the claims a verifier sees, and the risk score each decision rests on
    import cabang_analisis as CA
    import fitur_v4 as F4
    import swarm_v5 as SW

    if meta["model"] == "ml_v7":
        b7 = joblib.load(HERE / "model_ml_v7" / "model.joblib")
        bm = {"models": b7["kandidat"][b7["pilihan"]]["models"]}
    else:
        bm = joblib.load(V5.V4.MODEL / "model.joblib")
    q = np.searchsorted(q_ref, z["s"], "right") / len(q_ref)
    lihat = np.flatnonzero(np.isin(kep, ["TAHAN", "PERIKSA", "DIBERSIHKAN"]))
    sh = CA.shap_top(bm["models"], np.hstack([X1[lihat], X4[lihat]]).astype(np.float32), list(b3["agg_names"]) + list(F4.NAMES), SW.X4_LABEL)
    shap = {int(i): v for i, v in zip(lihat, sh)}
    hj = json.loads((KERJA / f"hasil_{nama}.json").read_text("utf-8"))
    hb = hj["biaya"]
    # per claim the swarm answered (a one-branch run reads only that branch's uncertain claims)
    usd_ragu = float(hb["usd_perkiraan"]) / max(1, len(hj.get("hasil") or {}) or int(z["ragu"].sum()))
    ref = referensi_biaya(F)
    iot = muat_iot(nama, z, F)
    return {"z": z, "kep": kep, "p": p, "agen": agen, "F": F, "rule": rule, "rs": rs_d, "desk": desk, "K": K, "usd_ragu": usd_ragu, "biaya_swarm": hb, "nama": nama, "shap": shap, "q": q, "f": f,
            "rule_mask": np.array([bool(x) for x in rule]), "model": meta["model"], "model_nama": "ML v7" if meta["model"] == "ml_v7" else "model v4",
            "ref_biaya": ref, "jalur": jalur, "gerbang": gerbang, **iot}


def muat_iot(nama: str, z: dict, F: dict) -> dict:
    """The IoT layer of a run (testing/iot_cabang.periksa wrote data/aip/cabang/iot/<set>/bukti.json), or {} when there is none.
    iot       claim key -> the device evidence block (every claim at an IoT hospital that bills device use)
    iot_naik  claim keys an IoT mismatch puts in the queue although the model and the swarm let them pass
    A claim the SYNTHETIC layer re-billed (a fraud that bills ventilation: J-1-02 / J-1-20; its block carries `klaim_asli`) is reported
    as billed: F's code, tariff and bill are replaced here, after the batch's reference medians were taken."""
    import iot_cabang as IOT

    b = IOT.baca_bukti(nama)
    if not b:
        return {}
    zi = {str(k): n for n, k in enumerate(z["kunci"])}
    iot = {k: v for k, v in (b.get("klaim") or {}).items() if k in zi}
    for k, v in iot.items():
        if v.get("klaim_asli"):
            n = zi[k]
            F["kode"][n] = v["ditagih"]["inacbg"]
            F["tarif"][n] = int(v["ditagih"]["tarif_rp"])
            F["biaya"][n] = int(v["ditagih"]["tarif_rp"]) + int(F["topup"][n])
    rk = json.loads((IOT.basis_iot() / nama / "ringkasan.json").read_text("utf-8")) if (IOT.basis_iot() / nama / "ringkasan.json").exists() else {}
    return {"iot": iot, "iot_meta": {k: b.get(k) for k in ("dibuat", "masukan", "format", "sintetis", "kc")} | {"rs_dengan_iot": rk.get("rs_dengan_iot"), "alat": rk.get("alat"),
                                                                                                                 "tarif_ventilasi": rk.get("tarif_ventilasi")}}


# the swarm family a mismatch reads as (the case's recommendation text), and the Permenkes 16/2019 mode its explanation names
FAMILI_IOT = {"vent_run_96": "koding", "vent_standby": "koding", "vent_hours": "koding", "binding_tumpang": "episode",
              "no_device_trace": "tagihan", "hd_short": "tagihan", "hd_phantom": "tagihan", "icu_days": "tagihan"}
HASIL_IOMT = {"tidak_sesuai": "disanggah", "tanpa_bukti": "perlu klarifikasi", "sesuai": "sesuai"}
SLICES_IOT = 40


def iot_kasus(ib: dict) -> dict:
    """A case's `iot` block (the contract the web IoT tab reads): the checker's block without its internal fields."""
    return {k: v for k, v in ib.items() if k not in ("tagihan_jenis", "faskes_profil_id")}


def _ms(t: str) -> int:
    from datetime import datetime, timedelta, timezone

    return int(datetime.strptime(str(t)[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone(timedelta(hours=7))).timestamp() * 1000)


def iomt_klaim(ib: dict, c: dict) -> dict:
    """One IoT mismatch in the IomtClaim shape the national report's IoMT exhibit draws (web LaporanLengkap IomtKlaim): billed against
    measured, the checks, the verifier's step, and the device's timeline under the billed window (cells = share of each slice the
    device ran in that mode)."""
    import iot_cabang as IOT

    d, t, tr = ib["ditagih"], ib["terukur"], ib["tarif"]
    mj = dict(t.get("mode_jam") or {})
    seg = [dict(x) for x in t.get("sesi") or []]
    if d["prosedur"] in ("96.72", "96.71", "96.70", "93.90"):
        # the clamp's ventilator states (an older block's invasif / noninvasif read as jalan, standby as siaga)
        mj = {"jalan": float(mj.get("jalan") or 0) + float(mj.get("invasif") or 0) + float(mj.get("noninvasif") or 0),
              "siaga": float(mj.get("siaga") or 0) + float(mj.get("standby") or 0)}
        for x in seg:
            x["mode"] = IOT.MODE_LAMA.get(x["mode"], x["mode"])
        ukuran = [{"label": "Ventilator jalan berturut-turut terpanjang", "satuan": "jam", "ditagih": d["jam"], "terukur": t["jam_berturut_maks"],
                   "kode": d["prosedur"], "berturut": True, **({"ambang": IOT.AMBANG_VENT} if d["prosedur"] == "96.72" else {})},
                  {"label": "Ventilator jalan total", "satuan": "jam", "ditagih": d["jam"], "terukur": round(mj["jalan"], 1)}]
        seri = [("jalan", "Ventilator jalan")]
        t0 = _ms(next((s["mulai"] for s in ib["sesi"] if s["jenis"] == "ventilator"), ib["rawat"]["masuk"]))
        c0, c1 = t0, t0 + int(float(d["jam"] or 0) * 3600_000)
    elif d["prosedur"] == "ICU":
        hari = int(round(float(d["jam"]) / 24))
        ukuran = [{"label": "Hari ICU", "satuan": "hari", "ditagih": hari, "terukur": t.get("hari", 0), "kode": "ICU"},
                  {"label": "Monitor bed ICU menyala", "satuan": "jam", "ditagih": d["jam"], "terukur": mj.get("nyala", 0)}]
        seri = [("nyala", "Monitor bed ICU menyala")]
        c0 = _ms(ib["rawat"]["masuk"])
        c1 = c0 + int(float(d["jam"]) * 3600_000)
    else:
        ukuran = [{"label": "Sesi dialisis berjalan", "satuan": "menit", "ditagih": IOT.HD_STANDAR_MENIT, "terukur": round(float(mj.get("jalan", 0)) * 60),
                   "kode": d["prosedur"], "ambang": IOT.HD_MIN_MENIT}]
        seri = [("jalan", "Mesin dialisis berjalan")]
        c0 = _ms(next((s["mulai"] for s in ib.get("sesi") or []), ib["rawat"]["masuk"]))
        c1 = c0 + IOT.HD_STANDAR_MENIT * 60_000
    lo = min([_ms(ib["rawat"]["masuk"]), c0] + [_ms(x["mulai"]) for x in seg])
    hi = max([_ms(ib["rawat"]["pulang"]), c1] + [_ms(x["selesai"]) for x in seg]) + 1
    lebar = (hi - lo) / SLICES_IOT
    series = []
    for mode, label in seri:
        xs = [(_ms(x["mulai"]), _ms(x["selesai"])) for x in seg if x["mode"] == mode]
        if not xs:
            continue
        cells = []
        for n in range(SLICES_IOT):
            a, b = lo + n * lebar, lo + (n + 1) * lebar
            cells.append(round(sum(max(0.0, min(b, y) - max(a, x)) for x, y in xs) / lebar, 2))
        dev = sorted({x["device_id"] for x in seg if x["mode"] == mode})
        series.append({"metric": mode, "label": label, "note": " · ".join(dev), "cells": cells})
    return {"id": c["id"], "faskes": c["rs"], "jenis": "Rawat inap" if c["tingkat"] == "RITL" else "Rawat jalan", "dx": f"{c['dx']} {c['dx_nama']}".strip(),
            "masuk": ib["rawat"]["masuk"][:10], "pulang": ib["rawat"]["pulang"][:10], "keparahan": str(d["inacbg"]).rsplit("-", 1)[-1], "tarif_rp": int(tr["ditagih_rp"]),
            "hasil": HASIL_IOMT.get(ib["hasil"], ib["hasil"]), "estimasi_rp": int(tr["selisih_rp"]), "judul": ib["judul"], "ukuran": ukuran,
            "temuan": [{"hasil": HASIL_IOMT.get(x["hasil"], x["hasil"]), "judul": IOT.JUDUL_ATURAN.get(x["aturan"], x["aturan"])} for x in ib.get("cek") or []],
            "langkah": (ib.get("langkah") or [""])[0], "garis_waktu": {"from": lo, "to": hi, "claimedFrom": c0, "claimedTo": c1, "series": series} if series else None}


def bab_iot(M: dict, blok: dict[str, dict], kasus: list[dict], exhibit, naik: int) -> tuple[dict, list[str], str]:
    """The chapter "Verifikasi IoT alat medis": L["iot"], its three exhibits (claims by result; the mismatches drawn as the IoMT
    exhibit draws a claim; the tariff difference per rule) and its text. Every number from the checker's blocks."""
    import iot_cabang as IOT

    meta = M.get("iot_meta") or {}
    n = Counter(b["hasil"] for b in blok.values())
    ts = sorted(((k, b) for k, b in blok.items() if b["hasil"] == "tidak_sesuai"), key=lambda x: (-x[1]["tarif"]["selisih_rp"], x[1]["klaim_id"]))
    selisih = int(sum(b["tarif"]["selisih_rp"] for _, b in ts))
    per: dict[str, list] = defaultdict(lambda: [0, 0, 0, 0])
    for _, b in ts:
        x = per[b["aturan"]]
        x[0] += 1
        x[1] += b["tarif"]["selisih_rp"]
        x[2] += b["tarif"]["ditagih_rp"]
        x[3] += b["tarif"]["seharusnya_rp"]
    aturan = [{"aturan": a, "judul": IOT.JUDUL_ATURAN.get(a, a), "klaim": v[0], "selisih_rp": int(v[1])} for a, v in sorted(per.items(), key=lambda x: (-x[1][1], x[0]))]
    n_aug = sum(1 for b in blok.values() if b.get("klaim_asli"))
    rs_n = meta.get("rs_dengan_iot") or len({b["faskes_profil_id"] for b in blok.values()})
    sint = bool(meta.get("sintetis", True))
    L = {"rs_dengan_iot": rs_n, "alat": meta.get("alat") or 0, "klaim_dengan_alat": len(blok), "sesuai": n["sesuai"], "tidak_sesuai": n["tidak_sesuai"],
         "tanpa_bukti": n["tanpa_bukti"], "selisih_rp": selisih, "aturan": aturan, "sintetis": sint, "masuk_antrean_karena_iot": int(naik), "klaim_ventilasi_sintetis": n_aug}
    src = ("Lapisan IoT " + ("SINTETIS " if sint else "") + "(testing/iot_cabang.py): sensor clamp pada kabel daya alat (tanpa membuka alat), sesi alat–pasien–kunjungan, jangkar Merkle per "
           f"kunjungan; diperiksa terhadap klaim {SUMBER_DATA} RS di wilayah KC")
    e1 = exhibit("iot-cek", f"{n['tidak_sesuai']} dari {len(blok)} klaim berperangkat tidak sesuai catatan alat medis; selisih tarif {rp(selisih)}",
                 "Klaim yang menagih pemakaian alat di RS ber-IoT, menurut hasil pemeriksaan sensor", "bar",
                 [{"label": "Sesuai catatan alat", "nilai": n["sesuai"]}, {"label": "Tidak sesuai catatan alat", "nilai": n["tidak_sesuai"]},
                  {"label": "Tanpa bukti (gateway offline / bukti tidak cocok jangkar)", "nilai": n["tanpa_bukti"]}],
                 [f"{len(blok)} klaim di {rs_n} RS ber-IoT menagih pemakaian ventilator, monitor bed ICU atau mesin hemodialisis.",
                  f"{n['sesuai']} sesuai catatan alat, {n['tidak_sesuai']} tidak sesuai, {n['tanpa_bukti']} tanpa bukti yang bisa dipakai (bukan tuduhan).",
                  f"{naik} klaim yang tidak sesuai sebelumnya diloloskan model dan swarm; kini masuk antrean verifikator dengan tag kuat."], bab_="iot", sumber=src)
    by_rule: dict[str, list] = defaultdict(list)
    for k, b in ts:
        by_rule[b["aturan"]].append(k)
    urut = [v[0] for v in sorted(by_rule.values(), key=lambda v: -blok[v[0]]["tarif"]["selisih_rp"])]
    urut += [k for k, _ in ts if k not in urut]
    kas = {c.get("kunci"): c for c in kasus}
    kl = [iomt_klaim(blok[k], kas[k]) for k in urut if k in kas][:6]
    ids = [e1]
    kecil = lambda t: t[:1].lower() + t[1:]  # noqa: E731
    if kl:
        c0 = kl[0]
        flat = [{"klaim": c["id"], "faskes": c["faskes"], "ukuran": u["label"], "ditagih": u["ditagih"], "terukur": u["terukur"], "satuan": u["satuan"]} for c in kl for u in c["ukuran"]]
        ids.append(exhibit("iot-kasus", f"{c0['id']}: {kecil(c0['judul'])}; selisih {rp(c0['estimasi_rp'])}",
                           f"{len(kl)} klaim yang tidak sesuai catatan alat, satu per aturan lalu selisih terbesar: ditagih terhadap terukur, dan garis waktu alat",
                           "iomt_klaim", flat, [f"{c['id']} ({c['faskes']}, {c['dx']}): {kecil(c['judul'])}; selisih tarif {rp(c['estimasi_rp'])}." for c in kl]
                           + ["Garis waktu menunjukkan kapan alat jalan, siaga atau mati; kotak kuning adalah jam yang ditagih klaim."], bab_="iot", sumber=src, klaim=kl))
    if aturan:
        tv = [r for r in meta.get("tarif_ventilasi") or [] if r.get("nasional_median_rp") and all(r["nasional_median_rp"])]
        ids.append(exhibit("iot-tarif", f"{aturan[0]['judul']}: selisih tarif terbesar ({rp(aturan[0]['selisih_rp'])} dari {aturan[0]['klaim']} klaim)",
                           "Selisih tarif per aturan IoT: tarif yang ditagih dikurangi tarif yang didukung pemakaian alat", "bar",
                           [{"label": a["judul"], "nilai": a["selisih_rp"], "klaim": a["klaim"], "ditagih_rp": int(per[a["aturan"]][2]), "seharusnya_rp": int(per[a["aturan"]][3])}
                            for a in aturan],
                           [f"{a['judul']}: {a['klaim']} klaim, ditagih {rp(per[a['aturan']][2])}, didukung alat {rp(per[a['aturan']][3])}, selisih {rp(a['selisih_rp'])}." for a in aturan[:4]]
                           + [f"Ventilasi keparahan {r['keparahan']}: {r['kode_96_jam_atau_lebih']} (≥ 96 jam) median sampel {rp(r['nasional_median_rp'][0])}, "
                              f"{r['kode_kurang_96_jam']} (< 96 jam) {rp(r['nasional_median_rp'][1])}." for r in tv],
                           satuan="rp", bab_="iot", sumber=src))
    tv2 = next((r for r in meta.get("tarif_ventilasi") or [] if r.get("keparahan") == "II" and r.get("nasional_median_rp") and all(r["nasional_median_rp"])), None)
    teks = ((f"**Data IoT di bab ini SINTETIS.** Lapisan IoT dan episode ventilasinya adalah tambahan pada data klaim run ini; {n_aug} klaim fraud ditagih dengan grup "
             f"ventilasi oleh lapisan ini (kode dan tarif asli run tetap tercatat di berkasnya). Skor model dan keputusan swarm tidak diubah.\n\n") if sint else "") + (
        f"Di {rs_n} RS ber-IoT, sensor clamp dipasang pada kabel daya (tanpa membuka alat) ventilator, mesin hemodialisis, monitor bed ICU dan pompa infus. "
        f"Sensor hanya tahu **kapan alat menyala, berapa lama, dan statusnya** dari besar arus (ventilator jalan memberi napas, siaga atau mati; mesin dialisis "
        f"jalan atau siaga); tidak ada data pasien seperti saturasi oksigen atau tekanan darah. Setiap pemakaian diikat ke satu pasien dan satu kunjungan, dan "
        f"setiap pembacaan serta ikatan itu di-hash dan dirangkum menjadi satu Merkle root per kunjungan yang dijangkarkan ke ledger sebelum klaim diajukan, "
        f"sehingga perubahan data sesudahnya terlihat.\n\n"
        f"Pertanyaannya satu: **apakah alat benar-benar jalan selama yang ditagih klaim?** Untuk ventilasi jawabannya menentukan tarif: kode 96.72 "
        f"(ventilasi ≥ 96 jam berturut-turut) masuk grup J-1-02, 96.71 (< 96 jam) grup J-1-20"
        + (f"; pada keparahan sedang median tarif sampel {rp(tv2['nasional_median_rp'][0])} terhadap {rp(tv2['nasional_median_rp'][1])}" if tv2 else "")
        + f". Dari {len(blok)} klaim berperangkat, **{n['tidak_sesuai']} tidak sesuai** catatan alat dengan selisih tarif **{rp(selisih)}**; {n['tanpa_bukti']} tanpa bukti "
        f"yang bisa dipakai (gateway offline atau data tidak cocok dengan jangkarnya) dan hanya perlu klarifikasi. Klaim yang tidak sesuai mendapat tag kuat "
        f"\"{LABEL_IOT}\" dan masuk antrean verifikator walaupun model dan swarm meloloskannya ({naik} klaim); estimasi kerugiannya adalah selisih tarif itu. "
        f"Pembacaan yang hilang selalu dihitung menguntungkan klaim.")
    return L, ids, teks


def cek_iot(M: dict, idx: np.ndarray) -> dict | None:
    """Technical appendix only (synthetic): the IoT checks against the IoT world's answer key (kunci_benar.json), which the checker
    never reads."""
    import iot_cabang as IOT

    f = IOT.basis_iot() / M["nama"] / "kunci_benar.json"
    if not f.exists() or not M.get("iot"):
        return None
    kb = json.loads(f.read_text("utf-8"))["klaim"]
    kunci = {str(M["z"]["kunci"][i]) for i in idx}
    fr = [k for k, v in kb.items() if k in kunci and v["fraud"]]
    jujur = [k for k, v in kb.items() if k in kunci and not v["fraud"]]
    hasil = lambda k: (M["iot"].get(k) or {}).get("hasil")  # noqa: E731
    return {"fraud_tanam": len(fr), "fraud_terdeteksi": sum(1 for k in fr if hasil(k) == "tidak_sesuai"),
            "jujur": len(jujur), "jujur_ditandai": sum(1 for k in jujur if hasil(k) == "tidak_sesuai"),
            "jujur_tanpa_bukti": sum(1 for k in jujur if hasil(k) == "tanpa_bukti"), "sumber": "data/aip/cabang/iot/<set>/kunci_benar.json"}


def iot_tidak_sesuai(M: dict, kunci: str) -> dict | None:
    v = (M.get("iot") or {}).get(str(kunci))
    return v if v and v.get("hasil") == "tidak_sesuai" else None


def bagi_kc(rs: dict) -> dict[str, dict]:
    """Demo branch areas, the same for every run: in each province, regencies/cities in code order grouped until they hold
    PORSI_KC of the national historical claim volume (the hospitals' 2024 silver counts)."""
    n_kab = Counter(); nama_kab = {}; prov_kab = defaultdict(set)
    for r in rs.values():
        n_kab[r["kab"]] += int(r["n"]); nama_kab[r["kab"]] = r["kab_nama"]; prov_kab[r["prov_nama"]].add(r["kab"])
    MIN_KLAIM_KC = PORSI_KC * sum(n_kab.values())
    kab_kc: dict[int, str] = {}; kcs: dict[str, dict] = {}
    for prov in sorted(prov_kab):
        kabs = sorted(prov_kab[prov])
        grup, cur = [], []
        for k in kabs:
            cur.append(k)
            if sum(n_kab[x] for x in cur) >= MIN_KLAIM_KC:
                grup.append(cur); cur = []
        if cur:
            if grup and sum(n_kab[x] for x in cur) < MIN_KLAIM_KC / 2:
                grup[-1] += cur
            else:
                grup.append(cur)
        for g in grup:
            besar = max(g, key=lambda x: n_kab[x])
            nm = judul(nama_kab[besar]).replace("Kota ", "")
            kid = f"{prov[:3].lower()}-{besar}"
            kcs[kid] = {"id": kid, "nama": f"KC {nm}", "provinsi": judul(prov), "kabkota": [judul(nama_kab[x]) for x in g], "kab_kode": [int(x) for x in g], "klaim_historis": sum(n_kab[x] for x in g)}
            for x in g:
                kab_kc[x] = kid
    return {"kab_kc": kab_kc, "kc": kcs}


def label_rs(r: dict) -> str:
    return f"{r['tipe'] or r['jenis']} · {judul(r['kab_nama'])}"


def nama_rs(rs: dict) -> dict[str, str]:
    """A readable, unique hospital name for the report: class · ownership · kab/kota, and a short id where two profiles share it
    (label_rs alone merged distinct hospitals of the same class in one city)."""
    dasar = {f: " · ".join(x for x in (r.get("tipe") or r["jenis"], r.get("kep") or "", judul(r["kab_nama"])) if x) for f, r in rs.items()}
    n = Counter(dasar.values())
    return {f: (f"{v} · RS-{f[:4].upper()}" if n[v] > 1 else v) for f, v in dasar.items()}


_KOORD: dict | None = None


def koordinat_rs() -> dict:
    """SYNTHETIC hospital coordinates (testing/geo_rs.py): a fixed-seed point inside the hospital's kab/kota, not an address."""
    global _KOORD
    if _KOORD is None:
        f = ROOT / "data" / "aip" / "cabang" / "rs_koordinat.json"
        _KOORD = json.loads(f.read_text("utf-8"))["rs"] if f.exists() else {}
    return _KOORD


# the branch's Box Karantina: the national bands (api/aip/karantina.BANDS) and the TSM reading of a two-week batch
BANDS = (("A", 0.50), ("B", 0.80), ("C", 0.95), ("D", 0.99), ("Z", 1.01))
GROUP_TEXT = {"A": "prioritas: bersama-sama menanggung 50% pertama estimasi kerugian", "B": "kerugian besar (50–80% kumulatif)",
              "C": "kerugian menengah (80–95%)", "D": "kerugian kecil (95–99%)", "Z": "kerugian sangat kecil atau hanya sinyal non-uang"}
JENIS_LAYANAN = {"RITL": "rawat inap", "RJTL": "rawat jalan"}
REF_KLAIM_TSM = 1664  # the two-week KC batch the TSM thresholds were set on (KC Makassar, generator 3)


def kriteria_tsm(skala: float, v_tag: int, v_ulang: int, hari: int, n: int, n_rep: int, awal: str, akhir: str, v_modus: int = 3, v_kode: int = 5) -> list[str]:
    """The TSM criteria in plain words with THIS batch's thresholds (the UI reads the "(poin …; terpenuhi bila ≥ …)" part)."""
    batch = (f"Batch ini: {f'{n:,}'.replace(',', '.')} klaim, {hari} hari klaim ({awal} s/d {akhir})"
             + (f", {n_rep} ulangan" if n_rep > 1 else "")
             + (f"; ambang volume dikali {skala:.1f}".replace(".", ",") + " (ambang dasar per 1.664 klaim, batch KC dua minggu)." if skala > 1 else "."))
    return [
        f"Terstruktur (poin 0–4; terpenuhi bila ≥ 3, sebagian bila ≥ 2): minimal {v_modus} modus berbeda; klaim bertag di rawat inap dan rawat jalan; "
        f"minimal {v_kode} kode INA-CBG; minimal 2 RS lain di kab/kota yang sama dengan modus yang sama (tag sedang/kuat)"
        + (" (ambang modus dan kode tumbuh lebih lambat dari volume: 3 + log2 skala dan 5 × akar skala)." if skala > 1 else "."),
        "Sistematis (poin 0–3; terpenuhi bila ≥ 2, sebagian bila ≥ 1): "
        + ("klaim bertag di minimal 35% hari klaim batch (20–34%: setengah poin)" if hari <= 31 else "klaim bertag di minimal 6 bulan berbeda (3–5 bulan: setengah poin)")
        + "; modus yang "
        f"sama berulang di minimal {v_ulang} klaim yang direkomendasikan; laju tag minimal 2× rata-rata KC (dengan minimal 3 klaim bertag).",
        f"Masif (poin 0–4; terpenuhi bila ≥ 3, sebagian bila ≥ 2): kelompok A atau B; minimal {v_tag} klaim bertag; minimal {v_tag} peserta terdampak; "
        "minimal 5% klaim RS bertag.",
        "Jalur RS: ditindak bila Terstruktur, Sistematis dan Masif ketiganya terpenuhi; dibina bila minimal satu terpenuhi; dibebaskan bila tidak ada yang "
        "terpenuhi. Jalur menyangkut RS; klaim yang direkomendasikan tetap diverifikasi satu per satu.",
        batch,
    ]


JALUR_LABEL = {"ditindak": "Ditindak (T, S, M terpenuhi)", "dibina": "Dibina (minimal satu terpenuhi)", "dibebaskan": "Dibebaskan (tidak ada yang terpenuhi)"}
SARAN_JALUR = {"ditindak": "Ditindak: teruskan ke Tim PK-JKN dan aparat penegak hukum; verifikasi semua klaim yang direkomendasikan",
               "dibina": "Dibina: perbaikan koding dan sistem, pengembalian kelebihan bayar, sanksi administratif; verifikasi klaim yang direkomendasikan",
               "dibebaskan": "Dibebaskan dari jalur RS (tidak ada pola TSM); klaim yang direkomendasikan tetap diverifikasi satu per satu"}


# review rules (testing/v4_rule_tambah.komponen) -> the ledger tag they indicate; rule-engine signals take aip.realtime.modus's own tag
TAG_ATURAN = {"KLON_MIRIP": "KLONING_KLAIM", "KLON_MIRIP_14H": "KLONING_KLAIM", "KARTU_DI_RS_LAIN_HARI_SAMA": "KLAIM_FIKTIF",
              "TOPUP_JAUH_DI_ATAS_KODE": "TAGIHAN_MELEBIHI_TARIF", "DX_SEKUNDER_DI_ATAS_P90": "UPCODING_KEPARAHAN", "network rule": "JARINGAN_FASKES"}


def indikasi_kc(idx: np.ndarray, M: dict) -> dict:
    """The branch's first output, before any agent (the user, 2026-11-14: "proses dari raw data ke ML ke output awal masuk juga di
    visualisasi ... blok indikasi berdasarkan tag yang dikasih rule engine sama prediksi model ML v7"): every claim's tags, as the
    national AI Agent Swarm's Indikasi block counts them, written by code only.
      tag aturan  the rule engine's signals at ingest (aip.realtime.modus: signal -> ledger tag) and the review rules (TAG_ATURAN),
                  one tag per claim and tag code
      tag model   "Risiko tinggi menurut model" for a claim whose screening score s reaches the RAGU threshold
      kekuatan    a model tag: kuat at s >= TAHAN, sedang at s >= PERIKSA, else lemah; a rule tag: kuat when the model also scores
                  it >= PERIKSA, sedang >= RAGU, else lemah (the rule says what, the model how strongly)
      tag IoT     "Durasi alat medis tidak sesuai klaim (IoT)" for a claim the device evidence contradicts (testing/iot_cabang.py),
                  always kuat: a measurement, not a score (only when the run has an IoT layer)
    Display only: the indikasi ledger still receives only the queued claims (realtime/cabang_tag.py)."""
    from aip import layanan as L
    from aip import semantik as SEM
    from aip.realtime import modus as MO

    z, F, a = M["z"], M["F"], M["K"]["ambang"]
    t_tahan, t_periksa = float(a["tahan"]), float(a.get("periksa_v4") or a["tahan"])
    t_ragu = float(a.get("lebar") or a.get("ragu") or t_periksa)
    lbl = lambda t: (SEM.TAG.get(t) or {}).get("label", t)  # noqa: E731
    kek = {"lemah": 0, "sedang": 0, "kuat": 0}
    per_tag: dict[tuple[str, str], int] = {}
    per_sinyal: dict[str, int] = {}
    n_aturan = n_model = n_iot = 0
    bertag = bersinyal = 0
    per_klaim: dict[int, list[tuple[str, str, str]]] = {}
    for i in idx:
        s = float(z["s"][i])
        sig = [x for x in str(F["sinyal"][i]).split() if x in MO.SIGNALS and x not in ("SKOR_ML",)]
        if sig:
            bersinyal += 1
        for x in sig:
            per_sinyal[x] = per_sinyal.get(x, 0) + 1
        tags = {MO.SIGNALS[x][1] for x in sig if MO.SIGNALS[x][1]} | {TAG_ATURAN.get(r) or (MO.SIGNALS.get(r) or [None, None])[1] for r in M["rule"][i]}
        tags.discard(None)
        tags.discard("RISIKO_ML_TINGGI")
        for t in tags:
            k = "kuat" if s >= t_periksa else "sedang" if s >= t_ragu else "lemah"
            kek[k] += 1
            per_tag[(t, "aturan")] = per_tag.get((t, "aturan"), 0) + 1
            n_aturan += 1
            per_klaim.setdefault(int(i), []).append((lbl(t), "aturan", k))
        model = s >= t_ragu
        if model:
            k = "kuat" if s >= t_tahan else "sedang" if s >= t_periksa else "lemah"
            kek[k] += 1
            per_tag[("RISIKO_ML_TINGGI", "model")] = per_tag.get(("RISIKO_ML_TINGGI", "model"), 0) + 1
            n_model += 1
            per_klaim.setdefault(int(i), []).append((lbl("RISIKO_ML_TINGGI"), "model", k))
        alat = iot_tidak_sesuai(M, z["kunci"][i])
        if alat:
            kek["kuat"] += 1
            per_tag[(TAG_IOT, "iot")] = per_tag.get((TAG_IOT, "iot"), 0) + 1
            n_iot += 1
            per_klaim.setdefault(int(i), []).append((LABEL_IOT, "iot", "kuat"))
        bertag += bool(tags or model or alat)
    urut = sorted(per_tag.items(), key=lambda x: -x[1])
    return {"_per_klaim": per_klaim, "klaim": int(len(idx)), "klaim_bertag": int(bertag), "tag_aturan": n_aturan, "tag_model": n_model, "kekuatan": kek,
            **({"tag_iot": n_iot} if M.get("iot") else {}),
            "per_tag": [{"tag": t, "label": LABEL_IOT if t == TAG_IOT else lbl(t), "sumber": src, "n": n} for (t, src), n in urut],
            "ambang": {"tahan": round(t_tahan, 4), "periksa": round(t_periksa, 4), "ragu": round(t_ragu, 4)},
            "data": {"baris": int(len(idx)), "kolom": len(L.KlaimIn.model_fields), "peserta": int(len(set(F["peserta"][idx]))),
                     "rs": int(len(set(F["faskes"][idx]))), "klaim_bersinyal": int(bersinyal),
                     "sinyal": [{"kode": k, "label": MO.SIGNALS[k][3], "n": n} for k, n in sorted(per_sinyal.items(), key=lambda x: -x[1])[:8]]}}


def laporan_kc(kc: dict, idx: np.ndarray, M: dict) -> dict:
    z, F, kep, agen = M["z"], M["F"], M["kep"], M["agen"]
    y = z["y"][idx]
    biaya = F["biaya"][idx].astype(float)
    k0 = kep[idx]  # the model / swarm decision
    k = k0.copy()
    naik = np.zeros(len(idx), bool)  # queued by an IoT mismatch alone (the model and the swarm let it pass)
    if M.get("iot"):
        for j, i in enumerate(idx):
            if iot_tidak_sesuai(M, z["kunci"][i]) and k[j] not in KEP_ANTRE:
                k[j], naik[j] = "PERIKSA", True
    tema = np.array([tema_klaim(d, kd) for d, kd in zip(F["dx"][idx], F["kode"][idx])])
    antre = np.isin(k, ["TAHAN", "PERIKSA"])
    if "_nama_rs" not in M:
        M["_nama_rs"] = nama_rs(M["rs"])
    rs_lbl = {fk: M["_nama_rs"][fk] for fk in set(F["faskes"][idx])}
    n_rs = len(rs_lbl)
    # ---- case files: every claim in the queue, plus the uncertain ones the swarm cleared (top by p, for the verifier to see why)
    kasus, kasus_i = [], {}
    for j in np.flatnonzero(antre | (k == "DIBERSIHKAN")):
        i = idx[j]
        kk = str(z["kunci"][i]); a = agen.get(kk)
        a_ = agen.get(kk)
        sp = [a_[x]["p"] for x in ("koding", "tagihan", "episode")] if a_ else []
        ka = CA.keputusan_ai(k[j], float(z["s"][i]), float(M["q"][i]), None if a_ is None else a_["hakim"]["p"], float(M["f"][i]) if a_ else None,
                             M["K"]["tau"], None if a_ is None else a_["hakim"].get("famili"), M["rule"][i], M["shap"].get(int(i), []), a_)
        risiko = float(M["q"][i]) if k[j] == "TAHAN" else float(M["f"][i])
        tag = tag_klaim(ka, (a_ or {}).get("hakim") or {}, M["rule"][i]) if k[j] in ("TAHAN", "PERIKSA") else None
        rugi, dasar = taksir_kerugian(tag, float(F["biaya"][i]), float(F["tarif"][i]), float(F["topup"][i]), str(F["kode"][i]), M["ref_biaya"]) if tag else (0, "")
        ib = (M.get("iot") or {}).get(kk)
        tag_asal = None
        if ib and ib["hasil"] == "tidak_sesuai":  # the device contradicts the bill: the IoT tag, priced by the tariff difference
            tag_asal, tag = tag, TAG_IOT
            rugi, dasar = taksir_kerugian(tag, float(F["biaya"][i]), float(F["tarif"][i]), float(F["topup"][i]), str(F["kode"][i]), M["ref_biaya"], iot=ib)
            ka = {**ka, "famili": FAMILI_IOT.get(ib["aturan"], "tagihan"), "alasan": f"Verifikasi IoT: {ib['judul']}.", "keyakinan": "Tinggi",
                  "keyakinan_teks": "Bukti pemakaian alat dari sensor clamp pada kabel daya (tanpa membuka alat); rantai jangkar bukti " + ("utuh." if ib["bukti"].get("rantai_ok") else "tidak utuh."),
                  "rekomendasi": " ".join(ib.get("langkah") or [])[:400], "indikator": [LABEL_IOT, *ka.get("indikator", [])][:6]}
        # the case id: KLM- + 8 hex of the claim key; one that would collide inside this report takes 12 hex (a full theme run has
        # tens of thousands of case files; the internal key rides along so graf_cabang never attaches another claim's graph)
        cid = "KLM-" + hashlib.md5(kk.encode()).hexdigest()[:8].upper()
        if cid in kasus_i:
            cid = "KLM-" + hashlib.md5(kk.encode()).hexdigest()[:12].upper()
        kasus_i[cid] = int(i)
        kasus.append({"id": cid, "kunci": kk, "keputusan_ai": ka, "skor_risiko": round(risiko, 3),
                      "indeks_prioritas": round(risiko * float(F["biaya"][i])), "perbedaan_pendapat": round(max(sp) - min(sp), 2) if sp else None, "tema": tema[j], "tema_nama": TEMA.get(tema[j], tema[j]), "keputusan": k[j],
                      "rs": rs_lbl[F["faskes"][i]], "rs_id": str(F["faskes"][i])[:8], "faskes": str(F["faskes"][i]),
                      "kabkota": judul(M["rs"][F["faskes"][i]]["kab_nama"]), "provinsi": judul(M["rs"][F["faskes"][i]]["prov_nama"]), "inacbg": str(F["kode"][i]), "deskripsi": M["desk"].get(str(F["kode"][i]), ""),
                      "dx": str(F["dx"][i]), "dx_nama": str(F["dx_nama"][i]),
                      "tingkat": str(F["tingkat"][i]), "kelas": str(F["kelas"][i]), "los": int(F["los"][i]), "tgl": str(F["tgl"][i]),
                      "biaya_rp": int(F["biaya"][i]), "tarif_rp": int(F["tarif"][i]), "topup_rp": int(F["topup"][i]), "dx_sekunder": int(F["dxs"][i]),
                      "peserta": f"P-{str(F['peserta'][i])[-4:]}", "skor_model": round(float(z["s"][i]), 3), "rule": M["rule"][i],
                      "agen": a, "p_hakim": None if a is None else a["hakim"]["p"],
                      "tag": tag, "tag_label": label_tag(tag) if tag else None, "estimasi_kerugian_rp": rugi, "dasar_kerugian": dasar})
        if M.get("jalur"):  # the rule-evidence lane: the gate's record and the rule engines' findings for this claim
            kasus[-1]["jalur"] = M["gerbang"].get(kk)
            kasus[-1]["temuan_aturan"] = (M["jalur"] or {}).get("klaim", {}).get(kk, {}).get("temuan")
        if ib:  # the claim's device evidence (contract: web IoT tab), and the decision before the IoT layer
            kasus[-1]["iot"] = iot_kasus(ib)
            kasus[-1]["keputusan_asal"] = str(k0[j])
            if ib["hasil"] == "tidak_sesuai":
                kasus[-1]["indeks_prioritas"] = max(kasus[-1]["indeks_prioritas"], int(ib["tarif"]["selisih_rp"]))
                kasus[-1]["tag_asal"] = tag_asal
    # priority = risk score x bill value (not the score alone): P1 the top 20% of the queue, P2 the next 30%, P3 the rest
    antri = sorted([c for c in kasus if c["keputusan"] != "DIBERSIHKAN"], key=lambda c: -c["indeks_prioritas"])
    for r_, c in enumerate(antri):
        c["prioritas"] = "P1" if r_ < max(1, round(0.2 * len(antri))) else "P2" if r_ < max(1, round(0.5 * len(antri))) else "P3"
    for c in kasus:
        c.setdefault("prioritas", None)
    kasus.sort(key=lambda c: (c["keputusan"] == "DIBERSIHKAN", -c["indeks_prioritas"]))
    # ---- themes
    tem = []
    for t in sorted(set(tema)):
        m = tema == t
        q = m & antre
        fam = Counter(agen[str(z["kunci"][idx[j]])]["hakim"]["famili"] for j in np.flatnonzero(q) if str(z["kunci"][idx[j]]) in agen)
        rsq = Counter(rs_lbl[F["faskes"][idx[j]]] for j in np.flatnonzero(q))
        tem.append({"kode": t, "nama": TEMA.get(t, t), "klaim": int(m.sum()), "tagihan_rp": int(biaya[m].sum()), "periksa": int((m & (k == "PERIKSA")).sum()),
                    "tahan": int((m & (k == "TAHAN")).sum()), "dibersihkan": int((m & (k == "DIBERSIHKAN")).sum()), "nilai_antrean_rp": int(biaya[q].sum()),
                    "modus": [{"label": FAMILI.get(x, x), "nilai": n} for x, n in fam.most_common()], "rs": [{"label": x, "nilai": n} for x, n in rsq.most_common(8)]})
    tem.sort(key=lambda t: (t["kode"] in NON_SPESIFIK, -(t["periksa"] + t["tahan"]), -t["nilai_antrean_rp"]))
    aktif = [t for t in tem if t["periksa"] + t["tahan"] > 0]
    # ---- exhibits and chapters in the national report's order (the user, 2026-11-14: "can you make audit report like this, + our
    # current graph for each case" + "add synthetic data for hospital coordinate"): summary -> scale and concentration -> where ->
    # how -> clinical themes -> hospitals to audit first -> case files per hospital (each claim with its explanation and network)
    # -> how reliable -> decisions -> appendix. Every number is computed here; the narrative only explains it.
    ex, bab, nomor = [], [], [0]

    def exhibit(id_, judul_, ukuran, jenis, baris, fakta, satuan=None, pimpinan=None, bab_="", **lain):
        nomor[0] += 1
        e = {"id": id_, "nomor": nomor[0], "bab": bab_, "judul": judul_, "ukuran": ukuran, "jenis": jenis, "baris": baris, "fakta": fakta,
             "sumber": f"v5 ({M['model_nama']} + rule engine + AI Agent Swarm) atas {SUMBER_DATA} RS di wilayah KC; testing/laporan_cabang.py", **lain}
        if satuan:
            e["satuan"] = satuan
        if pimpinan:
            e["pimpinan"] = pimpinan
        ex.append(e)
        return id_

    titik = lambda v: f"{v:,}".replace(",", ".")  # noqa: E731
    koma = lambda v, d=2: f"{v:.{d}f}".replace(".", ",")  # noqa: E731
    # the model / swarm counts read their own decisions (k0); the queue (nq) also holds the claims an IoT mismatch put there
    n, nq, ntahan, nperiksa, nbersih, nragu = len(idx), int(antre.sum()), int((k0 == "TAHAN").sum()), int((k0 == "PERIKSA").sum()), int((k0 == "DIBERSIHKAN").sum()), int(np.isin(k0, ["PERIKSA", "DIBERSIHKAN"]).sum())
    nbelum = int((k0 == "BELUM_DIBACA").sum())  # RAGU, not read by the swarm (cost cap)
    niot = int(naik.sum())
    q_kasus = [c for c in kasus if c["keputusan"] in ("TAHAN", "PERIKSA")]
    nilai_tx, nilai_ind = float(biaya.sum()), float(biaya[antre].sum())
    rugi_tot = float(sum(c["estimasi_kerugian_rp"] for c in q_kasus))
    per_1000_kc = 1000 * nq / max(1, n)
    ind = indikasi_kc(idx, M)
    per_klaim = ind.pop("_per_klaim")
    # ---- per hospital: volume, tags (with strength), recommendations, value, estimated loss
    rsd: dict[str, dict] = {}
    for i in idx:
        f = str(F["faskes"][i])
        d = rsd.setdefault(f, {"nama": rs_lbl[f], "klaim": 0, "tagihan": 0.0, "bertag": 0, "rekomendasi": 0, "tahan": 0, "periksa": 0, "nilai": 0.0, "rugi": 0.0,
                               "modus": {}, "rugi_modus": {}, "kasus": [], "tgl_t": set(), "jenis_t": set(), "kode_t": set(), "peserta_t": set(),
                               "mode_aturan": set(), "mode_jar": set()})
        d["klaim"] += 1
        d["tagihan"] += float(F["biaya"][i])
        tg = per_klaim.get(int(i), [])
        d["bertag"] += bool(tg)
        if tg:
            d["tgl_t"].add(str(F["tgl"][i])); d["jenis_t"].add(str(F["tingkat"][i])); d["kode_t"].add(str(F["kode"][i])); d["peserta_t"].add(str(F["peserta"][i]))
        for lb, src, kk in tg:
            d["modus"].setdefault(lb, {"kuat": 0, "sedang": 0, "lemah": 0})[kk] += 1
            if src in ("aturan", "iot"):
                d["mode_aturan"].add(lb)
                if kk in ("sedang", "kuat"):
                    d["mode_jar"].add(lb)
    for c in kasus:
        rsd[c["faskes"]]["kasus"].append(c["id"])
    for c in q_kasus:
        d = rsd[c["faskes"]]
        d["rekomendasi"] += 1
        d[c["keputusan"].lower()] += 1
        d["nilai"] += c["biaya_rp"]
        d["rugi"] += c["estimasi_kerugian_rp"]
        m = d["rugi_modus"].setdefault(c["tag_label"], [0, 0.0])
        m[0] += 1
        m[1] += c["estimasi_kerugian_rp"]
    # ---- the branch's Box Karantina (the national box's rule, api/aip/karantina.py; the user, 2026-11-14: "box karantina setelah
    # bagian indikasi"): every hospital with at least one tag is in the box; groups by its estimated loss (the loss of its
    # recommended claims: the national box prices a branch's claims the same way): A = the first 50 % of the loss, B = up to 80 %,
    # C = 95 %, D = 99 %, Z = the rest or no loss
    box_rs = sorted([f for f, d in rsd.items() if d["bertag"] or d["rekomendasi"]], key=lambda f: (-rsd[f]["rugi"], -rsd[f]["nilai"], -rsd[f]["bertag"]))
    kum = 0.0
    for f in box_rs:
        sebelum = kum / rugi_tot if rugi_tot else 1.0
        kum += rsd[f]["rugi"]
        rsd[f]["kelompok"] = "Z" if rsd[f]["rugi"] <= 0 else next(g for g, s_ in BANDS if sebelum < s_)
        rsd[f]["porsi"] = rsd[f]["rugi"] / rugi_tot if rugi_tot else 0.0
    urut_rs = [f for f in box_rs if rsd[f]["rekomendasi"]]
    nA = sum(1 for f in urut_rs if rsd[f]["kelompok"] == "A")
    nAB = sum(1 for f in urut_rs if rsd[f]["kelompok"] in "AB")
    rugi_A, rugi_AB = sum(rsd[f]["rugi"] for f in urut_rs[:nA]), sum(rsd[f]["rugi"] for f in urut_rs[:nAB])
    # ---- TSM per hospital in the box, from the batch's own data (KRITERIA_TSM; the national box reads months and the verifiers'
    # corrections, a branch batch is two weeks without corrections), and the path (the user, 2026-11-14): ditindak = Terstruktur,
    # Sistematis and Masif all met; dibina = at least one met; dibebaskan = none met. A path concerns the hospital: its recommended
    # claims are verified one by one whatever the path.
    lbl_model = label_tag("RISIKO_ML_TINGGI")
    jar_kab: dict[tuple, set] = defaultdict(set)
    for f in box_rs:
        for m_ in rsd[f]["mode_jar"]:
            jar_kab[(int(M["rs"][f]["kab"]), m_)].add(f)
    laju_kc = ind["klaim_bertag"] / max(1, n)
    # the thresholds were set on a two-week KC batch (1,664 claims, KC Makassar); a longer or larger batch (the theme dataset:
    # years of replicas) scales the volume thresholds, and "Sistematis" reads the share of the batch's claim days instead of a
    # day count (5 of 14 days = 35 %), so a year-long batch does not meet every pattern by size alone (run review 2026-11-15)
    skala = max(1.0, n / REF_KLAIM_TSM)
    hari_kc = max(1, len(set(F["tgl"][idx])))
    n_rep = len(set(F["replika"][idx])) if "replika" in F else 1
    v_tag, v_ulang = round(10 * skala), max(2, round(2 * skala))
    # variety (modes, codes) grows more slowly than volume: a big batch made every hospital "Terstruktur" (69 of 76 on the 5-replica
    # cardiology run, 2026-11-15) with the two-week counts; log2 / sqrt keep them at 3 and 5 for a two-week batch
    v_modus, v_kode = 3 + round(float(np.log2(skala))), round(5 * float(np.sqrt(skala)))
    tsm_kriteria = kriteria_tsm(skala, v_tag, v_ulang, hari_kc, n, n_rep, str(min(F["tgl"][idx])), str(max(F["tgl"][idx])), v_modus, v_kode)
    tingkat = lambda poin, penuh, sebagian: "terpenuhi" if poin >= penuh else "sebagian" if poin >= sebagian else "tidak"  # noqa: E731
    for f in box_rs:
        d = rsd[f]
        modes = d["mode_aturan"] | {lb for lb in d["rugi_modus"] if lb and lb != lbl_model}
        jar = sorted({o for m_ in d["mode_jar"] for o in jar_kab[(int(M["rs"][f]["kab"]), m_)] if o != f})
        layanan = sorted(JENIS_LAYANAN.get(x, x) for x in d["jenis_t"])
        ts = (len(modes) >= v_modus) + (len(d["jenis_t"]) == 2) + (len(d["kode_t"]) >= v_kode) + (len(jar) >= 2)
        ulang = max((v[0] for v in d["rugi_modus"].values()), default=0)
        laju = d["bertag"] / max(1, d["klaim"])
        # active over time: a batch of a month or less reads the share of its claim days (5 of 14 days = 35 %); a longer batch
        # reads the months with tagged claims, as the national box does (≥ 6 months a point, ≥ 3 half)
        if hari_kc <= 31:
            hari_aktif = len(d["tgl_t"]) / hari_kc  # (not `aktif`: that name holds the active themes)
            p_waktu = 1 if hari_aktif >= 0.35 else 0.5 if hari_aktif >= 0.2 else 0
            t_waktu = f"klaim bertag di {len(d['tgl_t'])} dari {hari_kc} hari klaim ({pct(len(d['tgl_t']), hari_kc)})"
        else:
            bulan_aktif = len({str(x)[:7] for x in d["tgl_t"]})
            p_waktu = 1 if bulan_aktif >= 6 else 0.5 if bulan_aktif >= 3 else 0
            t_waktu = f"klaim bertag di {bulan_aktif} bulan berbeda"
        sy = p_waktu + (ulang >= v_ulang) + (laju >= 2 * laju_kc and d["bertag"] >= 3)
        ms = (d["kelompok"] in ("A", "B")) + (d["bertag"] >= v_tag) + (len(d["peserta_t"]) >= v_tag) + (laju >= 0.05)
        d["tsm"] = {
            "terstruktur": {"nilai": tingkat(ts, 3, 2), "poin": ts, "bukti": f"{len(modes)} modus berbeda ({', '.join(sorted(modes)[:4]) or '-'}); layanan: "
                            f"{' dan '.join(layanan) or '-'}; {len(d['kode_t'])} kode INA-CBG; {len(jar)} RS lain di kab/kota yang sama dengan modus yang sama"},
            "sistematis": {"nilai": tingkat(sy, 2, 1), "poin": sy, "bukti": f"{t_waktu}; modus yang sama berulang di {ulang} klaim "
                           f"yang direkomendasikan; laju tag {pct(d['bertag'], d['klaim'])} (rata-rata KC {pct(ind['klaim_bertag'], n)})"},
            "masif": {"nilai": tingkat(ms, 3, 2), "poin": ms, "bukti": f"kelompok {d['kelompok']}, estimasi kerugian {rp(d['rugi'])}; {d['bertag']} klaim bertag "
                      f"({pct(d['bertag'], d['klaim'])} klaim RS); {len(d['peserta_t'])} peserta"},
        }
        n_ok = sum(v["nilai"] == "terpenuhi" for v in d["tsm"].values())
        d["jalur"] = "ditindak" if n_ok == 3 else "dibina" if n_ok >= 1 else "dibebaskan"
    jalur_n = {j: sum(1 for f in box_rs if rsd[f]["jalur"] == j) for j in ("ditindak", "dibina", "dibebaskan")}
    box = {"rs": len(box_rs), "rs_klaim": n_rs, "estimasi_kerugian_rp": round(rugi_tot),
           "kelompok": {g: {"rs": sum(1 for f in box_rs if rsd[f]["kelompok"] == g), "estimasi_kerugian_rp": round(sum(rsd[f]["rugi"] for f in box_rs if rsd[f]["kelompok"] == g)),
                            "rekomendasi": sum(1 for f in urut_rs if rsd[f]["kelompok"] == g)} for g, _ in BANDS},
           "jalur": jalur_n, "kriteria": tsm_kriteria, "skala": round(skala, 2)}

    # ======== 1. executive summary
    e0 = exhibit("skala", f"Dari transaksi {rp(nilai_tx)}, klaim senilai {rp(nilai_ind)} terindikasi fraud; estimasi kerugian {rp(rugi_tot)}",
                 "Nilai transaksi, klaim terindikasi, dan estimasi kerugian", "bar",
                 [{"label": "Nilai transaksi yang dianalisis", "nilai": round(nilai_tx)}, {"label": "Nilai klaim terindikasi fraud", "nilai": round(nilai_ind)},
                  {"label": "Estimasi nilai kerugian fraud", "nilai": round(rugi_tot)}],
                 [f"{titik(n)} klaim senilai {rp(nilai_tx)} dianalisis.",
                  f"{nq} klaim senilai {rp(nilai_ind)} ({pct(nilai_ind, nilai_tx)} dari nilai transaksi) terindikasi dan direkomendasikan ke verifikator.",
                  f"Estimasi kerugian {rp(rugi_tot)} ({pct(rugi_tot, nilai_tx)} dari nilai transaksi, {pct(rugi_tot, nilai_ind)} dari nilai klaim terindikasi)."],
                 satuan="rp", bab_="ringkasan")
    e1 = exhibit("alur", f"Dari {titik(n)} klaim, {ind['klaim_bertag']} bertag indikasi dan {nq} direkomendasikan ke verifikator",
                 "Alur audit: data mentah, tag aturan dan model, AI Agent Swarm, rekomendasi", "alur",
                 [{"tahap": "Klaim dianalisis", "nilai": n, "satuan": "klaim", "rincian": f"{n_rs} RS · tagihan {rp(nilai_tx)}"},
                  {"tahap": "Bertag indikasi", "nilai": ind["klaim_bertag"], "satuan": "klaim", "rincian": f"{ind['tag_aturan']} tag aturan · {ind['tag_model']} tag model"
                   + (f" · {ind['tag_iot']} tag IoT" if "tag_iot" in ind else "")},
                  {"tahap": "Ragu, dibaca swarm", "nilai": nragu, "satuan": "klaim", "rincian": f"{nperiksa} diteruskan · {nbersih} dibersihkan"
                   + (f" · {nbelum} belum dibaca (batas biaya)" if nbelum else "")},
                  {"tahap": "Tahan langsung", "nilai": ntahan, "satuan": "klaim", "rincian": "skor model di atas ambang tahan"},
                  *([{"tahap": "Verifikasi IoT alat medis", "nilai": niot, "satuan": "klaim", "rincian": f"{ind['tag_iot']} tidak sesuai catatan alat · {niot} diloloskan model/swarm"}]
                    if "tag_iot" in ind else []),
                  {"tahap": "Rekomendasi", "nilai": nq, "satuan": "klaim", "rincian": f"nilai {rp(nilai_ind)} · estimasi kerugian {rp(rugi_tot)}"}],
                 [f"{titik(n)} klaim dari {n_rs} RS di {len(kc['kabkota'])} kab/kota wilayah {kc['nama']}.",
                  f"{ind['klaim_bertag']} klaim bertag: {ind['tag_aturan']} tag dari rule engine dan aturan telaah, {ind['tag_model']} tag dari skor {M['model_nama']}.",
                  f"{nragu} klaim ragu dibaca AI Agent Swarm (4 agen); {nperiksa} diteruskan ke verifikator, {nbersih} dibersihkan.",
                  f"{ntahan} klaim langsung ditahan karena skor model sangat tinggi."]
                 + ([f"{ind['tag_iot']} klaim tidak sesuai catatan alat medis (IoT); {niot} di antaranya diloloskan model dan swarm, kini direkomendasikan."] if "tag_iot" in ind else []),
                 pimpinan=[{"metrik": "Rekomendasi ke verifikator", "nilai": f"{nq} klaim", "arti": f"{pct(nq, n)} dari klaim masuk perlu dibuka verifikator; sisanya lolos."},
                           {"metrik": "Nilai tagihan yang direkomendasikan", "nilai": rp(nilai_ind), "arti": f"dari total tagihan {rp(nilai_tx)} di batch ini."}],
                 bab_="ringkasan")
    rs_a = [rsd[f]["nama"] for f in urut_rs if rsd[f]["kelompok"] == "A"]
    bab.append({"id": "ringkasan", "judul": "Ringkasan eksekutif", "exhibit": [e0, e1], "bagian": [{"id": "r1", "judul": "Ringkasan", "teks":
        f"Audit ini menganalisis **{titik(n)} klaim** senilai **{rp(nilai_tx)}** dari **{n_rs} RS** di wilayah {kc['nama']} ({kc['provinsi']}). "
        f"Klaim senilai **{rp(nilai_ind)}** ({nq} klaim) terindikasi dan direkomendasikan ke verifikator kantor cabang, dengan **estimasi kerugian {rp(rugi_tot)}** "
        f"({pct(rugi_tot, nilai_tx)} dari nilai transaksi). Angka kerugian adalah estimasi potensi kelebihan bayar, bukan kerugian yang sudah terbukti; "
        f"kepastiannya menunggu verifikasi.\n\n"
        f"Kerugian terkonsentrasi: **{nA} RS** (kelompok A) memegang {pct(rugi_A, rugi_tot)} estimasi kerugian"
        + (f" ({', '.join(rs_a[:3])}{' dan lainnya' if len(rs_a) > 3 else ''})" if rs_a else "") + ". "
        f"**{len(box_rs)} RS** dengan tag indikasi masuk Box Karantina KC; menurut pola Terstruktur, Sistematis dan Masif (TSM), jalur RS-nya: "
        f"**{jalur_n['ditindak']} ditindak, {jalur_n['dibina']} dibina, {jalur_n['dibebaskan']} dibebaskan**. "
        f"Setiap klaim dinilai {M['model_nama']} dan rule engine; **{nragu} klaim ragu** dibaca AI Agent Swarm: tiga spesialis (koding & klinis, tagihan, "
        f"episode & jaringan) bekerja paralel, lalu hakim memutuskan. **{ntahan} klaim** ditahan langsung karena skor model sangat tinggi."
        + (f" **{nbelum} klaim ragu belum dibaca** swarm karena batas biaya run; klaim itu tidak direkomendasikan dan tidak dibersihkan." if nbelum else "")
        + (f" Verifikasi IoT alat medis (data sintetis) menemukan **{ind['tag_iot']} klaim** yang pemakaian alatnya tidak sesuai tagihan; **{niot} klaim** di antaranya "
           f"diloloskan model dan swarm, kini ikut direkomendasikan (bab Verifikasi IoT alat medis)." if "tag_iot" in ind else "")
        + "\n\n"
        f"Bab berikut menjawab seberapa besar dan terkonsentrasi kerugiannya, di mana dan bagaimana indikasinya terjadi, RS mana yang diaudit lebih dulu, "
        f"dan keputusan apa yang dibutuhkan. Setiap klaim yang direkomendasikan punya berkas sendiri: penjelasan satu paragraf berbasis bukti dan "
        f"jaringan klaimnya (peserta, RS, dan klaim pembanding), dikelompokkan per RS di bab berkas kasus."}]})

    # ======== 2. scale and concentration
    per_tag: dict[str, list] = defaultdict(lambda: [0, 0.0, 0.0])
    per_tema: dict[str, list] = defaultdict(lambda: [0, 0.0])
    for c in q_kasus:
        t_ = per_tag[c["tag_label"]]; t_[0] += 1; t_[1] += c["estimasi_kerugian_rp"]; t_[2] += c["biaya_rp"]
        m_ = per_tema[c["tema_nama"]]; m_[0] += 1; m_[1] += c["estimasi_kerugian_rp"]
    tag_urut = sorted(per_tag.items(), key=lambda x: -x[1][1])
    tema_urut = sorted(per_tema.items(), key=lambda x: -x[1][1])
    e_k1 = exhibit("kerugian-modus", (f"{tag_urut[0][0]} memegang estimasi kerugian terbesar ({rp(tag_urut[0][1][1])})" if tag_urut else "Tidak ada klaim terindikasi"),
                   "Estimasi kerugian per modus (tag Permenkes 16/2019)", "bar",
                   [{"label": t, "nilai": round(v[1]), "klaim": v[0]} for t, v in tag_urut],
                   [f"{t}: {v[0]} klaim, estimasi kerugian {rp(v[1])} dari tagihan {rp(v[2])}." for t, v in tag_urut[:4]], satuan="rp", bab_="skala")
    par = []
    kum = 0.0
    for r_, f in enumerate(urut_rs, 1):
        kum += rsd[f]["rugi"]
        par.append({"faskes": r_, "kumulatif_pct": round(100 * kum / rugi_tot, 2) if rugi_tot else 100.0, "rs": rsd[f]["nama"], "estimasi_kerugian_rp": round(rsd[f]["rugi"])})
    top3 = sum(rsd[f]["rugi"] for f in urut_rs[:3])
    e_k2 = exhibit("konsentrasi-rs", (f"{nA} dari {len(urut_rs)} RS memegang {pct(rugi_A, rugi_tot)} estimasi kerugian; {nAB} RS memegang {pct(rugi_AB, rugi_tot)}" if urut_rs else "Tidak ada RS dengan klaim terindikasi"),
                   "Porsi kumulatif estimasi kerugian, RS diurutkan dari kerugian terbesar", "pareto", par,
                   [f"{len(urut_rs)} dari {n_rs} RS punya klaim yang direkomendasikan."]
                   + ([f"3 RS teratas memegang {pct(top3, rugi_tot)} estimasi kerugian ({rp(top3)})."] if len(urut_rs) >= 3 else [])
                   + [f"{rsd[f]['nama']}: {rp(rsd[f]['rugi'])} ({pct(rsd[f]['rugi'], rugi_tot)})." for f in urut_rs[:3]],
                   bab_="skala", tanda=[x for x in ([{"faskes": nA, "label": "kelompok A"}] if nA else []) + ([{"faskes": nAB, "label": "kelompok A–B"}] if nAB > nA else [])])
    e_k3 = exhibit("kerugian-tema", (f"Tema {tema_urut[0][0].lower()} memegang estimasi kerugian terbesar ({rp(tema_urut[0][1][1])})" if tema_urut else "Tidak ada tema dengan klaim terindikasi"),
                   "Estimasi kerugian per tema klinis", "bar", [{"label": x, "nilai": round(v[1]), "klaim": v[0]} for x, v in tema_urut],
                   [f"{x}: {v[0]} klaim, estimasi kerugian {rp(v[1])}." for x, v in tema_urut[:3]], satuan="rp", bab_="skala")
    bab.append({"id": "skala", "judul": "Skala dan konsentrasi kerugian", "exhibit": [e_k1, e_k2, e_k3], "bagian": [{"id": "k1", "judul": "Cara estimasi", "teks":
        f"Setiap klaim yang direkomendasikan diberi modus sesuai tag yang dicatat ke buku besar indikasi (dari hakim swarm, atau indikator model untuk klaim "
        f"yang ditahan), lalu ditaksir dari tagihannya sendiri terhadap klaim lain dengan kode INA-CBG yang sama. Upcoding: selisih tarif ke tingkat keparahan "
        f"satu di bawahnya. Tagihan berlebih: tagihan di atas 1,5x median kode atau top-up di atas median kode. Klaim fiktif: seluruh tagihan. Klaim ganda, "
        f"kloning, pemecahan episode, readmisi dan rujukan semu: separuh tagihan, karena satu klaim dari pasangannya dianggap sah. Tanpa modus khusus: hanya "
        f"bagian di atas 1,5x median kode. Total estimasi **{rp(rugi_tot)}** dari **{len(q_kasus)} klaim**; angka yang sama tercatat di tag buku besar, sehingga "
        f"Box Karantina menghitung RS ini dengan taksiran yang sama."}]})

    # ======== 3. where: kab/kota (map with the hospitals at synthetic coordinates) and hospital type
    koord = koordinat_rs()
    kab_d: dict[int, dict] = {}
    for f, d in rsd.items():
        r = M["rs"][f]
        kb = kab_d.setdefault(int(r["kab"]), {"kode": int(r["kab"]), "kabkota": judul(r["kab_nama"]), "klaim": 0, "rekomendasi": 0, "estimasi_kerugian_rp": 0.0, "rs": 0, "rs_rekomendasi": 0})
        kb["klaim"] += d["klaim"]; kb["rekomendasi"] += d["rekomendasi"]; kb["estimasi_kerugian_rp"] += d["rugi"]; kb["rs"] += 1; kb["rs_rekomendasi"] += bool(d["rekomendasi"])
    for kb in kab_d.values():
        kb["rekomendasi_per_1000"] = round(1000 * kb["rekomendasi"] / max(1, kb["klaim"]), 2)
        kb["estimasi_kerugian_rp"] = round(kb["estimasi_kerugian_rp"])
    kab_urut = sorted(kab_d.values(), key=lambda x: (-x["estimasi_kerugian_rp"], -x["rekomendasi"]))
    kab_aktif = [x for x in kab_urut if x["rekomendasi"]]
    kab_rasio = sorted([x for x in kab_aktif if x["klaim"] >= 20], key=lambda x: -x["rekomendasi_per_1000"])
    peta = {"kab": [{**x} for x in kab_urut], "keterangan": "Koordinat RS sintetis: titik acak (benih tetap per profil RS) di dalam batas kab/kota-nya, bukan alamat RS nyata.",
            "rs": [{"id": f, "nama": d["nama"], "kab": int(M["rs"][f]["kab"]), "kabkota": judul(M["rs"][f]["kab_nama"]), "lon": koord[f]["lon"], "lat": koord[f]["lat"],
                    "klaim": d["klaim"], "rekomendasi": d["rekomendasi"], "estimasi_kerugian_rp": round(d["rugi"]), "kelompok": d.get("kelompok"),
                    "jalur": d.get("jalur")}
                   for f, d in sorted(rsd.items(), key=lambda x: -x[1]["rugi"]) if f in koord],
            "rata_per_1000": round(per_1000_kc, 2)}
    e_w = exhibit("wilayah-kc", (f"{kab_aktif[0]['kabkota']} memegang estimasi kerugian terbesar ({rp(kab_aktif[0]['estimasi_kerugian_rp'])})"
                                 + (f"; rasio tertinggi di {kab_rasio[0]['kabkota']} ({koma(kab_rasio[0]['rekomendasi_per_1000'])} per 1.000 klaim)" if kab_rasio and kab_rasio[0]["kode"] != kab_aktif[0]["kode"] else ""))
                  if kab_aktif else "Tidak ada kab/kota dengan klaim yang direkomendasikan",
                  "Estimasi kerugian dan klaim yang direkomendasikan per 1.000 klaim, per kab/kota", "bar_rate",
                  [{"kabkota": x["kabkota"], "kode": x["kode"], "estimasi_kerugian_rp": x["estimasi_kerugian_rp"], "rekomendasi_per_1000": x["rekomendasi_per_1000"],
                    "klaim": x["klaim"], "rekomendasi": x["rekomendasi"], "rs": x["rs"]} for x in kab_aktif],
                  [f"{len(kab_aktif)} dari {len(kab_d)} kab/kota punya klaim yang direkomendasikan; rata-rata KC {koma(per_1000_kc)} per 1.000 klaim."]
                  + [f"{x['kabkota']}: {rp(x['estimasi_kerugian_rp'])} ({pct(x['estimasi_kerugian_rp'], rugi_tot)}), {koma(x['rekomendasi_per_1000'])} per 1.000 klaim dari {titik(x['klaim'])} klaim."
                     for x in kab_aktif[:4]],
                  bab_="wilayah", peta=peta)
    tipe_d: dict[str, dict] = {}
    for f, d in rsd.items():
        r = M["rs"][f]
        t = tipe_d.setdefault(r.get("tipe") or r["jenis"], {"label": r.get("tipe") or r["jenis"], "klaim": 0, "rekomendasi": 0, "estimasi_kerugian_rp": 0.0, "rs": 0})
        t["klaim"] += d["klaim"]; t["rekomendasi"] += d["rekomendasi"]; t["estimasi_kerugian_rp"] += d["rugi"]; t["rs"] += 1
    for t in tipe_d.values():
        t["rekomendasi_per_1000"] = round(1000 * t["rekomendasi"] / max(1, t["klaim"]), 2)
        t["estimasi_kerugian_rp"] = round(t["estimasi_kerugian_rp"])
    tipe_urut = sorted([t for t in tipe_d.values() if t["klaim"] >= 20], key=lambda t: -t["rekomendasi_per_1000"])
    lo = tipe_urut[-1]["rekomendasi_per_1000"] if tipe_urut else 0
    e_t = exhibit("tipe-rs", (f"{tipe_urut[0]['label']} mencatat {koma(tipe_urut[0]['rekomendasi_per_1000'])} klaim direkomendasikan per 1.000 klaim"
                              + (f", {koma(tipe_urut[0]['rekomendasi_per_1000'] / lo, 1)}× kelompok terendah" if lo > 0 and len(tipe_urut) > 1 else ""))
                  if tipe_urut else "Tidak ada kelas RS dengan cukup klaim",
                  "Klaim yang direkomendasikan per 1.000 klaim dan estimasi kerugian, per kelas RS (kelas dengan minimal 20 klaim)", "bar_rate",
                  [{"label": t["label"], "rekomendasi_per_1000": t["rekomendasi_per_1000"], "estimasi_kerugian_rp": t["estimasi_kerugian_rp"], "klaim": t["klaim"],
                    "rekomendasi": t["rekomendasi"], "rs": t["rs"]} for t in tipe_urut],
                  [f"{t['label']}: {koma(t['rekomendasi_per_1000'])} per 1.000 klaim ({t['rekomendasi']} dari {titik(t['klaim'])} klaim, {t['rs']} RS), estimasi kerugian {rp(t['estimasi_kerugian_rp'])}."
                   for t in tipe_urut[:4]], bab_="wilayah")
    bab.append({"id": "wilayah", "judul": "Di mana risikonya berada", "exhibit": [e_w, e_t], "bagian": [{"id": "w1", "judul": "Wilayah", "teks":
        f"Peta menunjukkan {len(kab_d)} kab/kota tempat RS wilayah {kc['nama']} berada, diwarnai menurut estimasi kerugian atau menurut klaim yang "
        f"direkomendasikan per 1.000 klaim. Titik adalah RS: warnanya kelompok prioritas (A, B, C), besarnya volume klaim. Klik titik RS untuk membuka berkas kasusnya. "
        f"Koordinat RS adalah **sintetis** (titik acak di dalam kab/kota-nya), karena data klaim tidak memuat alamat RS."}]})

    # ======== 4. how: indications per mode (rule tags and model tag, by strength) and the INA-CBG codes
    agg: dict[str, dict] = {}
    for i in idx:
        for lb, _src, kk in per_klaim.get(int(i), []):
            agg.setdefault(lb, {"modus": lb, "kuat": 0, "sedang": 0, "lemah": 0})[kk] += 1
    kuat_urut = sorted(({**v, "total": v["kuat"] + v["sedang"] + v["lemah"]} for v in agg.values()), key=lambda v: (-v["total"], -v["kuat"]))
    e_m = exhibit("indikasi-modus", (f"{kuat_urut[0]['modus']} paling sering ditandai: {kuat_urut[0]['total']} tag, {kuat_urut[0]['kuat']} kuat" if kuat_urut else "Tidak ada tag indikasi"),
                  "Tag indikasi per modus, menurut kekuatan (aturan × skor model)", "strength", kuat_urut,
                  [f"{ind['klaim_bertag']} dari {titik(n)} klaim bertag; {ind['kekuatan']['kuat']} tag kuat, {ind['kekuatan']['sedang']} sedang, {ind['kekuatan']['lemah']} lemah."]
                  + [f"{v['modus']}: {v['total']} tag ({v['kuat']} kuat, {v['sedang']} sedang, {v['lemah']} lemah)." for v in kuat_urut[:4]],
                  bab_="modus")
    kd: dict[str, dict] = {}
    for c in q_kasus:
        x = kd.setdefault(c["inacbg"], {"label": c["inacbg"], "deskripsi": c["deskripsi"], "nilai": 0, "estimasi_kerugian_rp": 0})
        x["nilai"] += 1; x["estimasi_kerugian_rp"] += c["estimasi_kerugian_rp"]
    kd_urut = sorted(kd.values(), key=lambda x: (-x["nilai"], -x["estimasi_kerugian_rp"]))[:10]
    e_c = exhibit("kode-cabang", (f"Kode {kd_urut[0]['label']} paling sering direkomendasikan ({kd_urut[0]['nilai']} klaim)" if kd_urut else "Tidak ada kode INA-CBG yang direkomendasikan"),
                  "Klaim yang direkomendasikan dan estimasi kerugian per kode INA-CBG (10 teratas)", "bar_rate", kd_urut,
                  [f"{x['label']} {x['deskripsi'].lower()}: {x['nilai']} klaim, estimasi kerugian {rp(x['estimasi_kerugian_rp'])}." for x in kd_urut[:4]], bab_="modus")
    bab.append({"id": "modus", "judul": "Bagaimana indikasi terjadi", "exhibit": [e_m, e_c], "bagian": [{"id": "m1", "judul": "Modus", "teks":
        f"Sebelum agen bekerja, setiap klaim diberi tag: **tag aturan** dari rule engine saat klaim masuk dan dari aturan telaah, dan **tag model** bila skor "
        f"{M['model_nama']} melewati ambang ragu. Kekuatan tag menggabungkan keduanya: aturan menyebut *apa* yang janggal, skor model menyebut *seberapa kuat*. "
        f"{ind['klaim_bertag']} klaim bertag; tidak semua tag berarti masalah: tag lemah tanpa dukungan lain berhenti di sini dan tidak membebani verifikator."}]})

    # ======== 4b. the IoT layer (testing/iot_cabang.py): device usage against the bill, right after "how"
    L_iot = None
    if M.get("iot"):
        blok = {str(z["kunci"][i]): M["iot"][str(z["kunci"][i])] for i in idx if str(z["kunci"][i]) in M["iot"]}
        if blok:
            L_iot, e_iot, teks_iot = bab_iot(M, blok, kasus, exhibit, niot)
            bab.append({"id": "iot", "judul": "Verifikasi IoT alat medis", "exhibit": e_iot, "bagian": [{"id": "i1", "judul": "Verifikasi IoT", "teks": teks_iot}]})

    # ======== 5. clinical themes (the branch verifies per theme)
    e2 = exhibit("tema", (f"Di antara tema klinis, {aktif[0]['nama'].lower()} paling banyak direkomendasikan" if aktif[0]["kode"] not in NON_SPESIFIK
                  else f"{aktif[0]['nama']} paling banyak direkomendasikan") if aktif else "Tidak ada klaim yang direkomendasikan",
                 "Klaim yang direkomendasikan per tema klinis (diagnosis utama ICD-10)", "bar",
                 [{"label": t["nama"], "nilai": t["periksa"] + t["tahan"], "klaim_masuk": t["klaim"]} for t in aktif],
                 [f"{len(aktif)} dari {len(tem)} tema punya klaim yang direkomendasikan."] + [f"{t['nama']}: {t['periksa'] + t['tahan']} dari {t['klaim']} klaim ({rp(t['nilai_antrean_rp'])})." for t in aktif[:3]],
                 bab_="tema")
    sub = []
    for t in aktif:
        tid = f"tema-{t['kode']}"
        ids = []
        if t["modus"]:
            ids.append(exhibit(f"{tid}-modus", f"{t['nama']}: modus terbanyak menurut swarm adalah {t['modus'][0]['label'].lower()}", "Klaim yang dibaca swarm, per modus menurut hakim", "bar",
                               t["modus"], [f"{m['label']}: {m['nilai']} klaim." for m in t["modus"][:4]], bab_="tema"))
        if t["rs"]:
            ids.append(exhibit(f"{tid}-rs", f"{t['nama']}: {len(t['rs'])} RS dengan klaim yang direkomendasikan, teratas {t['rs'][0]['label']}", "Klaim yang direkomendasikan per RS", "bar",
                               t["rs"], [f"{r['label']}: {r['nilai']} klaim." for r in t["rs"][:3]], bab_="tema"))
        sub.append({"id": tid, "tema": t["kode"], "judul": t["nama"], "exhibit": ids, "teks":
                    f"**{t['klaim']} klaim** tema {t['nama'].lower()} masuk (tagihan {rp(t['tagihan_rp'])}). **{t['periksa'] + t['tahan']} klaim** direkomendasikan "
                    f"({t['tahan']} ditahan, {t['periksa']} diperiksa) senilai {rp(t['nilai_antrean_rp'])}; swarm membersihkan {t['dibersihkan']} klaim ragu."})
    bab.append({"id": "tema", "judul": "Temuan per tema klinis", "exhibit": [e2], "subbab": sub, "bagian": [{"id": "t1", "judul": "Tema", "teks":
        f"Kantor cabang memverifikasi per tema klinis (bab ICD-10 diagnosis utama). {len(aktif)} tema punya klaim yang direkomendasikan; setiap tema di bawah "
        f"menunjukkan modus menurut hakim swarm dan RS yang klaimnya direkomendasikan. Berkas kasus di bab berikutnya bisa dibuka per RS atau per tema."}]})

    # ======== 6. hospitals to audit first and the Box Karantina
    for f in box_rs:
        d = rsd[f]
        if d["rugi_modus"]:
            m = max(d["rugi_modus"].items(), key=lambda x: (x[1][1], x[1][0]))
            d["modus_utama"] = f"{m[0]} ({m[1][0]} klaim)"
        else:
            d["modus_utama"] = "-"
        d["saran"] = SARAN_JALUR[d["jalur"]]
    kel_ada = [g for g, _ in BANDS if box["kelompok"][g]["rs"]]
    e_b = exhibit("box", (f"{len(box_rs)} RS bertag masuk Box Karantina; {nA} RS kelompok A menanggung {pct(rugi_A, rugi_tot)} estimasi kerugian" if nA
                          else f"{len(box_rs)} RS bertag masuk Box Karantina; belum ada estimasi kerugian"),
                  "RS di Box Karantina KC per kelompok estimasi kerugian (A = 50% pertama, B = sampai 80%, C = 95%, D = 99%, Z = sisanya atau tanpa kerugian)", "groups",
                  [{"kelompok": g, "faskes": box["kelompok"][g]["rs"], "estimasi_kerugian_rp": box["kelompok"][g]["estimasi_kerugian_rp"],
                    "diaudit": box["kelompok"][g]["rekomendasi"], "label_diaudit": "RS dengan klaim direkomendasikan", "arti": GROUP_TEXT[g]} for g in kel_ada],
                  [f"{len(box_rs)} dari {n_rs} RS punya minimal satu tag indikasi dan masuk Box Karantina."]
                  + [f"Kelompok {g}: {box['kelompok'][g]['rs']} RS, estimasi kerugian {rp(box['kelompok'][g]['estimasi_kerugian_rp'])}." for g in kel_ada],
                  bab_="rs")
    e_r = exhibit("rs-prioritas", (f"{nA} RS kelompok A memegang {pct(rugi_A, rugi_tot)} estimasi kerugian; diaudit lebih dulu" if nA else "Tidak ada RS prioritas"),
                  "RS dengan klaim yang direkomendasikan: kelompok Box, estimasi kerugian, pola TSM dan jalur RS", "table",
                  [{"faskes": rsd[f]["nama"], "faskes_profil_id": f, "provinsi": judul(M["rs"][f]["kab_nama"]), "kelompok": rsd[f]["kelompok"],
                    "estimasi_kerugian_rp": round(rsd[f]["rugi"]), "nilai_terindikasi_rp": round(rsd[f]["nilai"]), "klaim": f"{rsd[f]['rekomendasi']} dari {titik(rsd[f]['klaim'])}",
                    "modus": rsd[f]["modus_utama"], "tsm": {x: v["nilai"] for x, v in rsd[f]["tsm"].items()}, "jalur": rsd[f]["jalur"]} for f in urut_rs],
                  [f"{len(urut_rs)} RS punya klaim yang direkomendasikan: " + ", ".join(f"kelompok {g} {sum(1 for f in urut_rs if rsd[f]['kelompok'] == g)} RS" for g in kel_ada
                                                                                  if any(rsd[f]["kelompok"] == g for f in urut_rs)) + "."]
                  + [f"{rsd[f]['nama']}: {rp(rsd[f]['rugi'])}, {rsd[f]['rekomendasi']} klaim, modus utama {rsd[f]['modus_utama'].lower()}." for f in urut_rs[:3]],
                  bab_="rs", kolom=[{"key": "faskes", "label": "RS", "jenis": "rs"}, {"key": "kelompok", "label": "Kelompok", "jenis": "kelompok"},
                                    {"key": "estimasi_kerugian_rp", "label": "Estimasi kerugian", "jenis": "rp"},
                                    {"key": "klaim", "label": "Klaim direkomendasikan", "jenis": "teks"}, {"key": "modus", "label": "Modus utama", "jenis": "teks"},
                                    {"key": "tsm", "label": "TSM", "jenis": "tsm"}, {"key": "jalur", "label": "Jalur RS", "jenis": "jalur"}])
    bab.append({"id": "rs", "judul": "RS prioritas dan Box Karantina", "exhibit": [e_b, e_r], "bagian": [{"id": "p1", "judul": "Box Karantina", "teks":
        f"Setiap RS dengan minimal satu tag indikasi masuk **Box Karantina KC** ({len(box_rs)} RS), lalu dikelompokkan menurut estimasi kerugian seperti Box "
        f"Karantina nasional: **A** = RS teratas sampai separuh estimasi kerugian tercapai ({nA} RS, {pct(rugi_A, rugi_tot)}), **B** = sampai 80%, **C** = sampai 95%, "
        f"**D** = sampai 99%, **Z** = sisanya atau RS yang tagnya tidak berujung pada estimasi kerugian.\n\n"
        f"Setiap RS di Box dibaca polanya: **Terstruktur** (banyak modus, rawat inap dan jalan, banyak kode, RS lain di kab/kota yang sama dengan modus sama), "
        f"**Sistematis** (berulang di banyak hari, modus yang sama di beberapa klaim, laju tag jauh di atas rata-rata KC) dan **Masif** (kelompok A/B, banyak klaim "
        f"dan peserta, porsi klaim RS yang besar). Jalur RS: **ditindak** bila ketiganya terpenuhi ({jalur_n['ditindak']} RS), **dibina** bila minimal satu "
        f"terpenuhi ({jalur_n['dibina']} RS), **dibebaskan** bila tidak ada yang terpenuhi ({jalur_n['dibebaskan']} RS). Jalur menyangkut RS; klaim yang "
        f"direkomendasikan tetap diverifikasi satu per satu. Ambang tiap pola ada di lampiran; buktinya di berkas tiap RS. Klik baris RS untuk membuka berkasnya."}]})

    # ======== 7. case files per hospital (the UI draws each claim's explanation and claim network)
    berkas_rs = []
    for f in urut_rs:
        d, r = rsd[f], M["rs"][f]
        temuan = [f"{d['rekomendasi']} dari {titik(d['klaim'])} klaim direkomendasikan ({koma(1000 * d['rekomendasi'] / d['klaim'])} per 1.000 klaim; rata-rata KC {koma(per_1000_kc)})."]
        for lb, (nk, rg) in sorted(d["rugi_modus"].items(), key=lambda x: -x[1][1])[:3]:
            temuan.append(f"{lb}: {nk} klaim, estimasi kerugian {rp(rg)}" + (" — pola berulang di RS ini." if nk >= 2 else "."))
        if d["tahan"]:
            temuan.append(f"{d['tahan']} klaim ditahan langsung karena skor model sangat tinggi.")
        berkas_rs.append({"faskes_profil_id": f, "nama": d["nama"], "kabkota": judul(r["kab_nama"]), "kab": int(r["kab"]), "tipe": r.get("tipe") or r["jenis"], "jenis": r["jenis"],
                          "kepemilikan": r.get("kep") or "", "kelompok": d["kelompok"], "klaim": d["klaim"], "tagihan_rp": round(d["tagihan"]), "bertag": d["bertag"],
                          "rekomendasi": d["rekomendasi"], "tahan": d["tahan"], "periksa": d["periksa"], "nilai_terindikasi_rp": round(d["nilai"]),
                          "estimasi_kerugian_rp": round(d["rugi"]), "porsi_kerugian": round(d["porsi"], 4), "saran": d["saran"], "modus_utama": d["modus_utama"], "tsm": d["tsm"], "jalur": d["jalur"],
                          "rugi_modus": [{"label": lb, "klaim": v[0], "estimasi_kerugian_rp": round(v[1])} for lb, v in sorted(d["rugi_modus"].items(), key=lambda x: -x[1][1])],
                          "modus": sorted(({"modus": lb, **v, "total": sum(v.values())} for lb, v in d["modus"].items()), key=lambda v: (-v["total"], -v["kuat"])),
                          "kasus": d["kasus"], "temuan": temuan, "koordinat": koord.get(f)})
    bab.append({"id": "kasus", "judul": "Berkas kasus per RS", "exhibit": [], "bagian": [{"id": "b1", "judul": "Berkas", "teks":
        f"Satu berkas per RS yang klaimnya direkomendasikan ({len(berkas_rs)} RS), urut estimasi kerugian. Setiap berkas memuat ringkasan RS, kerugian per modus, "
        f"kekuatan tag, dan **berkas tiap klaim**: penjelasan satu paragraf untuk pimpinan (apa yang janggal, buktinya, langkah verifikasi), jaringan klaimnya "
        f"(peserta, RS, klaim pembanding yang dibaca model), dan pendapat tiap agen. Tidak ada kotak hitam: setiap angka dan tanda bisa ditelusuri ke data klaim."}]})

    # ======== 8. how reliable: corroboration of each recommendation (no label is read here; the model evaluation is Appendix A)
    i_of = kasus_i
    def aturan_ada(c: dict, iot: bool = False) -> bool:
        return any(src == "aturan" or (iot and src == "iot") for _lb, src, _k in per_klaim.get(i_of[c["id"]], []))
    def spesialis(c: dict) -> int:
        a_ = c["agen"] or {}
        return sum(1 for x in ("koding", "tagihan", "episode") if x in a_ and float(a_[x]["p"]) >= 0.5)
    n2 = sum(1 for c in q_kasus if (c["keputusan"] == "PERIKSA" and c["agen"]) or aturan_ada(c, True))
    n_atur = sum(1 for c in q_kasus if aturan_ada(c))
    q_ag = [c for c in q_kasus if c["keputusan"] == "PERIKSA" and c["agen"]]
    n_sep = sum(1 for c in q_ag if spesialis(c) >= 2)
    n_pola = sum(1 for c in q_kasus if rsd[c["faskes"]]["rugi_modus"].get(c["tag_label"], [0])[0] >= 2)
    n_baca = sum(1 for j in np.flatnonzero(np.isin(k, ["PERIKSA", "DIBERSIHKAN"])) if str(z["kunci"][idx[j]]) in agen)
    cek = [{"uji": "Dikuatkan sumber kedua selain skor model (tag aturan" + (", bukti IoT" if "tag_iot" in ind else "") + " atau hakim swarm)", "lolos": n2, "total": nq},
           {"uji": "Ditandai aturan saat klaim masuk (rule engine atau aturan telaah)", "lolos": n_atur, "total": nq},
           {"uji": "Klaim yang diperiksa swarm: minimal 2 dari 3 spesialis juga menilai berisiko", "lolos": n_sep, "total": len(q_ag)},
           {"uji": "Bagian dari pola berulang (2 klaim atau lebih, modus sama, RS sama)", "lolos": n_pola, "total": nq},
           {"uji": "Klaim ragu selesai dibaca AI Agent Swarm", "lolos": n_baca, "total": nragu + nbelum}]
    if "tag_iot" in ind:
        cek.append({"uji": "Dibantah catatan alat medis (verifikasi IoT, rantai jangkar bukti)", "lolos": sum(1 for c in q_kasus if c.get("tag") == TAG_IOT), "total": nq})
    e_a = exhibit("keandalan", f"{n2} dari {nq} rekomendasi dikuatkan sumber kedua selain skor model",
                  "Pemeriksaan silang tiap rekomendasi (tanpa label: berlaku juga untuk data nyata)", "checks", cek,
                  [f"{c['uji']}: {c['lolos']} dari {c['total']}." for c in cek], bab_="andal")
    bab.append({"id": "andal", "judul": "Seberapa andal temuan ini", "exhibit": [e_a], "bagian": [{"id": "a1", "judul": "Keandalan", "teks":
        "Rekomendasi lebih bisa dipegang bila lebih dari satu sumber bukti menunjuk ke arah yang sama: skor model, tag aturan, pendapat spesialis swarm, "
        "dan pola berulang di RS yang sama. Pemeriksaan ini tidak membaca label fraud, jadi berlaku sama di data nyata. Skor risiko bukan peluang yang "
        "terkalibrasi; rekomendasi adalah indikasi untuk diverifikasi, bukan putusan. "
        + ("Evaluasi model terhadap label sintetis ada di Lampiran A, terpisah dari laporan audit." if not RIIL else
           "Data nyata tidak punya label fraud; Lampiran A membandingkan rekomendasi dengan koreksi verifikator BPJS (proksi lemah).")}]})

    # ======== 9. decisions
    pr: dict[str, list] = {"P1": [0, 0.0], "P2": [0, 0.0], "P3": [0, 0.0]}
    for c in q_kasus:
        if c["prioritas"]:
            pr[c["prioritas"]][0] += 1
            pr[c["prioritas"]][1] += c["biaya_rp"]
    nama_p = {"P1": "P1 · segera", "P2": "P2", "P3": "P3"}
    e_d = exhibit("keputusan", f"P1: {pr['P1'][0]} klaim senilai {rp(pr['P1'][1])} dibuka lebih dulu",
                  "Nilai tagihan yang direkomendasikan per prioritas verifikasi (skor risiko × nilai tagihan)", "stacked",
                  [{"komponen": nama_p[p], "nilai": round(v[1]), "klaim": v[0]} for p, v in pr.items()],
                  [f"{nama_p[p]}: {v[0]} klaim, {rp(v[1])}." for p, v in pr.items()], satuan="rp", bab_="keputusan")
    e_j = exhibit("jalur", f"Jalur RS menurut TSM: {jalur_n['ditindak']} ditindak, {jalur_n['dibina']} dibina, {jalur_n['dibebaskan']} dibebaskan",
                  "RS di Box Karantina per jalur (ditindak = Terstruktur, Sistematis dan Masif terpenuhi; dibina = minimal satu; dibebaskan = tidak ada)", "bar",
                  [{"label": JALUR_LABEL[j], "nilai": jalur_n[j]} for j in ("ditindak", "dibina", "dibebaskan")],
                  [f"{JALUR_LABEL[j]}: {jalur_n[j]} RS" + (f" ({', '.join(rsd[f]['nama'] for f in box_rs if rsd[f]['jalur'] == j)[:200]})" if j != "dibebaskan" and jalur_n[j] and jalur_n[j] <= 4 else "") + "."
                   for j in ("ditindak", "dibina", "dibebaskan")], bab_="keputusan")
    keputusan = []
    if jalur_n["ditindak"]:
        keputusan.append(f"**Teruskan {jalur_n['ditindak']} RS jalur ditindak** (Terstruktur, Sistematis dan Masif terpenuhi) ke Tim PK-JKN dan aparat penegak hukum, dengan berkasnya.")
    if jalur_n["dibina"]:
        keputusan.append(f"**Bina {jalur_n['dibina']} RS** yang memenuhi minimal satu pola TSM: perbaikan koding dan sistem, pengembalian kelebihan bayar, sanksi administratif.")
    keputusan.append(f"**{jalur_n['dibebaskan']} RS tanpa pola TSM dibebaskan dari jalur RS**; klaimnya yang direkomendasikan tetap diverifikasi.")
    keputusan += [f"**Verifikasi {pr['P1'][0]} klaim P1** (nilai {rp(pr['P1'][1])}) lebih dulu, lalu P2 ({pr['P2'][0]} klaim) dan P3 ({pr['P3'][0]} klaim)."]
    if nA:
        keputusan.append(f"**Audit {nA} RS kelompok A** ({', '.join(rs_a[:3])}{' dan lainnya' if len(rs_a) > 3 else ''}): minta rekam medis dan dokumen pendukung untuk semua klaim yang direkomendasikan.")
    if ntahan:
        keputusan.append(f"**Tahan pembayaran {ntahan} klaim** yang ditahan langsung sampai verifikasi selesai.")
    keputusan.append("**Catat hasil verifikasi** di tiap berkas klaim (terbukti bermasalah, sesuai, atau perlu investigasi): dashboard keputusan di bawah dan Box Karantina memakainya untuk mengoreksi estimasi kerugian.")
    bab.append({"id": "keputusan", "judul": "Keputusan yang dibutuhkan", "exhibit": [e_j, e_d], "bagian": [{"id": "d1", "judul": "Keputusan", "teks":
        "\n".join(f"{i_ + 1}. {x}" for i_, x in enumerate(keputusan))}]})

    # ======== 10. appendix: scope, method and cost
    bab.append({"id": "lampiran", "judul": "Lampiran: lingkup, metode dan biaya", "exhibit": [], "bagian": [{"id": "l1", "judul": "Lingkup", "teks":
        f"Lingkup: {titik(n)} klaim {SUMBER_DATA} dari {n_rs} RS di {len(kc['kabkota'])} kab/kota wilayah {kc['nama']}, periode {min(F['tgl'][idx])} s/d {max(F['tgl'][idx])}. "
        f"Biaya model AI Agent Swarm untuk KC ini sekitar ${nragu * M['usd_ragu']:.3f} ({nragu} klaim ragu dibaca)."}]})
    if nq == 0:  # a branch without recommendations: say so plainly instead of "0 RS hold —"
        kosong_teks = {
            "ringkasan": f"Audit ini menganalisis **{titik(n)} klaim** senilai **{rp(nilai_tx)}** dari **{n_rs} RS** di wilayah {kc['nama']} ({kc['provinsi']}). "
                         f"**Tidak ada klaim yang direkomendasikan ke verifikator** di batch ini: {ind['klaim_bertag']} klaim bertag indikasi, {nragu} klaim ragu "
                         f"dibaca AI Agent Swarm dan semuanya dibersihkan, dan tidak ada klaim dengan skor model di atas ambang tahan. Tag yang ada tetap tercatat "
                         f"(bab Bagaimana indikasi terjadi) untuk dipantau di batch berikutnya.",
            "skala": "Tidak ada klaim yang direkomendasikan, jadi tidak ada estimasi kerugian di batch ini.",
            "tema": "Tidak ada tema klinis dengan klaim yang direkomendasikan di batch ini.",
            "rs": "Tidak ada RS dengan klaim yang direkomendasikan di batch ini.",
            "kasus": "Tidak ada berkas kasus: tidak ada klaim yang direkomendasikan di batch ini.",
            "andal": "Tidak ada rekomendasi untuk diperiksa silang di batch ini.",
            "keputusan": "1. **Tidak ada klaim yang perlu dibuka** di batch ini.\n2. **Pantau tag indikasi** yang tercatat di batch berikutnya: tag yang berulang di RS yang sama layak diperhatikan.",
        }
        for b_ in bab:
            if b_["id"] in kosong_teks:
                b_["bagian"] = [{**b_["bagian"][0], "teks": kosong_teks[b_["id"]]}]
        for e in ex:
            if e["id"] == "skala":
                e["judul"] = f"Dari transaksi {rp(nilai_tx)}, tidak ada klaim yang direkomendasikan ke verifikator"
    # an exhibit with no rows says nothing (a branch without recommendations): dropped, the rest renumbered
    kosong = {e["id"] for e in ex if not e["baris"] and not e.get("peta")} | ({"tipe-rs", "keandalan", "keputusan"} if nq == 0 else set())
    for b_ in bab:
        b_["exhibit"] = [x for x in b_["exhibit"] if x not in kosong]
        for s_ in b_.get("subbab") or []:
            s_["exhibit"] = [x for x in s_["exhibit"] if x not in kosong]
    # numbered in reading order (chapter by chapter, a chapter's own exhibits before its sections')
    urutan = [x for b_ in bab for x in [*b_["exhibit"], *(x2 for s_ in b_.get("subbab") or [] for x2 in s_["exhibit"])]]
    posisi = {x: j for j, x in enumerate(urutan)}
    ex[:] = sorted((e for e in ex if e["id"] not in kosong), key=lambda e: posisi.get(e["id"], len(posisi)))
    for n_, e in enumerate(ex, 1):
        e["nomor"] = n_
    # technical appendix (internal model evaluation on the planted labels; not part of the operational audit report)
    if RIIL:  # no labels in the real sample: the verifiers' corrections as a weak proxy
        lamp = {"riil": cek_riil(M, idx)}
    else:
        lamp = {"kinerja": CA.kinerja(z, kep, M["rule_mask"], M["K"]["ambang"]["periksa_v4"], idx, biaya),
                "kesalahan": CA.kesalahan(z, kep, idx, tema, TEMA, biaya),
                "kerugian": cek_kerugian([c for c in q_kasus if c.get("keputusan_asal", c["keputusan"]) in KEP_ANTRE], z, idx)}  # the model/swarm queue only
        if M.get("iot") and cek_iot(M, idx):
            lamp["iot"] = cek_iot(M, idx)
    return {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "kc": kc | {"rs": n_rs}, "periode": f"{min(F['tgl'][idx])} s/d {max(F['tgl'][idx])}",
            "sampul": {"klaim": n, "tagihan_rp": int(biaya.sum()), "rs": n_rs, "ragu": nragu, "periksa": nperiksa, "tahan": ntahan, "dibersihkan": nbersih, "belum_dibaca": nbelum,
                       "lolos": int((k == "LOLOS").sum()), "antrean": nq, "nilai_antrean_rp": int(biaya[antre].sum()), "tema_aktif": len(aktif),
                       "persen_antrean": round(100 * nq / max(1, n), 2),
                       "nilai_transaksi_rp": int(round(nilai_tx)), "nilai_terindikasi_rp": int(round(nilai_ind)), "estimasi_kerugian_rp": int(round(rugi_tot)),
                       "model": M["model_nama"],
                       "biaya_swarm_usd": round(nragu * M["usd_ragu"], 3), **({"iot_antrean": niot} if L_iot else {})},
            "bab": bab, "exhibit": ex, "tema": tem, "kasus": kasus, "lampiran": lamp, "indikasi": ind, "berkas_rs": berkas_rs, "box": box, **({"iot": L_iot} if L_iot else {}),
            "catatan": [*(["DATA RIIL sampel BPJS Kesehatan (18–31 Des 2024): terikat pakta integritas, hanya untuk internal; jangan dibagikan atau dipresentasikan.",
                           "Model ML v7 dilatih di data sintetis dan ambangnya dari data dev sintetis; belum dikalibrasi di data riil. Profil RS = kab/kota + kepemilikan + jenis + tipe (data sampel tidak punya ID RS).",
                           "Wilayah KC adalah demo: kab/kota satu provinsi dikelompokkan, bukan peta KC resmi BPJS."] if RIIL else
                         [f"Data sintetis (batch {M['nama']}). Wilayah KC adalah demo: kab/kota satu provinsi dikelompokkan, bukan peta KC resmi BPJS."]),
                        "Tema = bab ICD-10 diagnosis utama (hemodialisis -> ginjal, kemoterapi/radioterapi -> kanker); tanpa diagnosis, CMG INA-CBG. Agen hanya membaca fakta dari fitur, tanpa skor model atau label.",
                        "Prioritas = skor risiko x nilai tagihan: P1 20% teratas antrean, P2 30% berikutnya, P3 sisanya. Skor risiko bukan peluang yang terkalibrasi.",
                        ("Data riil tidak punya label fraud: lampiran teknis membandingkan antrean dengan koreksi verifikator BPJS (proksi lemah, bukan kebenaran fraud)."
                         if RIIL else "Evaluasi model terhadap label sintetis ada di lampiran teknis, terpisah dari laporan audit.")]}


import re  # noqa: E402

_ANGKA = re.compile(r"\d+(?:[.,]\d+)*")
BOLEH = {"1", "2", "3", "4", "16", "2019"}  # numbers of the method itself (agents, specialists, Permenkes 16/2019)


def _norm(t: str) -> str:
    t = t.replace(".", "") if re.fullmatch(r"\d{1,3}(\.\d{3})+", t) else t
    return t.replace(",", ".").rstrip("0").rstrip(".") if "," in t or "." in t else t


def angka_fakta(e: dict) -> set[str]:
    teks = " ".join([e["judul"], e["ukuran"], *e["fakta"], *[f"{m['nilai']} {m['arti']}" for m in e.get("pimpinan") or []],
                     *[f"{r.get('label', r.get('komponen', ''))} {r.get('nilai', '')}" for r in e["baris"]]])
    return {_norm(x) for x in _ANGKA.findall(teks)} | BOLEH


def cek_kalimat(teks: str, ok: set[str]) -> tuple[str, int]:
    """Keep only the sentences whose every number is in the exhibit's facts (the national report's rule)."""
    keep, buang = [], 0
    for k in re.split(r"(?<=[.!?])\s+", teks.strip()):
        # the operational report speaks of indications for review, never of fraud (the user, 2026-11-13)
        if k and all(_norm(x) in ok for x in _ANGKA.findall(k)) and not re.search(r"fraud", k, re.I):
            keep.append(k)
        elif k:
            buang += 1
    return " ".join(keep), buang


def metrik_run(M: dict, idx: np.ndarray | None = None) -> dict:
    """The batch (or one branch) against its planted labels: the screening model alone vs the full flow (synthetic data only).
    Key "v4" = the screening model alone (v4 or ML v7, see "model")."""
    import v4_rule_tambah as RT

    z, K = M["z"], M["K"]
    idx = np.arange(len(z["y"])) if idx is None else idx
    y = z["y"][idx]
    v4 = z["s"][idx] > K["ambang"]["periksa_v4"]
    v5 = np.isin(M["kep"][idx], ["TAHAN", "PERIKSA"])
    if RIIL:
        return {"klaim": int(len(y)), "ragu": int(z["ragu"][idx].sum()), "antrean": int(v5.sum()), "model": M["model_nama"], "riil": True}
    return {"v4": RT.ukur(y, v4), "v5": RT.ukur(y, v5), "klaim": int(len(y)), "fraud": int(y.sum()), "ragu": int(z["ragu"][idx].sum()), "model": M["model_nama"]}


def sumber_tema(nama: str) -> str | None:
    """A set built from a theme dataset (testing/jalan_kc_tema.py writes replika.json): its name and replicas, else None."""
    f = SET_ROOT / nama / "replika.json"
    if not f.exists():
        return None
    r = json.loads(f.read_text("utf-8"))
    return (f"dataset tema {Path(str(r.get('data', ''))).name} (testing/gen_tema.py, dibangun di atas generator 3), "
            f"{len(r.get('replika') or [])} ulangan setahun{', dengan rekam medis SATUSEHAT' if r.get('rme') else ''}")


def indikasi_awal(nama: str, kc_pilih: str = "", tema_pilih: str = "") -> dict:
    """The Indikasi block before the swarm (the user, 2026-11-16: "pastikan blok2 ini juga jalan waktu live"): indikasi_kc needs only the
    zones, the rule engine's signals and rules and the IoT layer, all there after jalan_kc_tema's aturan stage, so the runner writes it to
    status.json and the live chart shows the tags while the swarm reads. The same claims and counts as the report (muat + main's branch
    and theme selection, without the swarm's outputs, SHAP or the world's tariffs); its per-claim list is left out."""
    import joblib
    import v4_rule_tambah as RT
    import v5 as V5

    SET = SET_ROOT / nama
    z = dict(np.load(KERJA / f"zona_{nama}.npz", allow_pickle=False))
    K = json.loads((V5.MODEL / "kartu.json").read_text("utf-8"))
    meta_f = KERJA / f"zona_{nama}.json"
    meta = json.loads(meta_f.read_text("utf-8")) if meta_f.exists() else {}
    if meta.get("ambang"):
        K = {**K, "ambang": {**K["ambang"], **meta["ambang"]}}
    raw = [dict(np.load(f, allow_pickle=False)) for f in sorted(SET.glob("hasil_[0-9][0-9].npz"))]
    cp = np.array([[int(x) for x in k.split(":")[1:]] for k in z["kunci"]])
    ambil = lambda nm: np.array([raw[c][nm][i] for c, i in cp])  # noqa: E731
    F = {nm: ambil(nm) for nm in ("faskes", "kode", "biaya", "tarif", "topup", "peserta", "sinyal")}
    F["dx"] = ambil("dx").astype(str) if "dx" in raw[0] else np.array([""] * len(cp))
    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    aturan = [{k: r[k] for k in ("aturan", "fitur", "ambang")} for r in json.loads((ROOT / ".tmp" / "data_v4" / "aturan_v4.json").read_text("utf-8"))["dipilih"]]
    X1 = np.vstack([raw[c]["X1"][i] for c, i in cp]); X4 = np.vstack([raw[c]["X4"][i] for c, i in cp]); XR = np.vstack([raw[c]["XR"][i] for c, i in cp])
    komp = RT.komponen(aturan, b3.get("rute_rule") or {}, b3.get("rule_jaringan") or {}, X1, X4, XR)
    rule = [[n.split(" · ", 1)[-1] for n, v in komp.items() if v[i]] for i in range(len(cp))]
    M = {"z": z, "F": F, "K": K, "rule": rule}
    M.update(muat_iot(nama, z, F))  # as muat: a re-billed claim counts with its billed code from here on
    if RIIL:
        rs_d = json.loads(Path(RIIL_RS).read_text("utf-8"))
    else:
        import generator3 as G

        rs_d = G.dunia().rs
    P = bagi_kc(rs_d)
    kc_of = np.array([P["kab_kc"][rs_d[fk]["kab"]] for fk in F["faskes"]])
    tema_set = sorted({t.strip().upper() for t in tema_pilih.split(",") if t.strip()})
    tema_semua = np.array([tema_klaim(d, kd) for d, kd in zip(F["dx"], F["kode"])])
    di = np.isin(tema_semua, tema_set) if tema_set else np.ones(len(tema_semua), bool)
    if kc_pilih:
        di &= kc_of == kc_pilih
    idx = np.flatnonzero(di)
    ind = indikasi_kc(idx, M)
    ind.pop("_per_klaim", None)
    # the IoT check on these claims, counted as bab_iot counts the report's (its blocks for the audit's claims only)
    if M.get("iot"):
        blok = {str(z["kunci"][i]): M["iot"][str(z["kunci"][i])] for i in idx if str(z["kunci"][i]) in M["iot"]}
        n = Counter(b["hasil"] for b in blok.values())
        meta = M.get("iot_meta") or {}
        ind["iot"] = {"klaim_dengan_alat": len(blok), "sesuai": n["sesuai"], "tidak_sesuai": n["tidak_sesuai"], "tanpa_bukti": n["tanpa_bukti"],
                      "selisih_rp": int(sum(b["tarif"]["selisih_rp"] for b in blok.values() if b["hasil"] == "tidak_sesuai")),
                      "rs_dengan_iot": meta.get("rs_dengan_iot") or len({b["faskes_profil_id"] for b in blok.values()}), "alat": meta.get("alat") or 0,
                      "sintetis": bool(meta.get("sintetis", True))}
    return ind


def main(nama: str, label: str, kc_pilih: str = "", tema_pilih: str = "") -> None:
    """tema_pilih: the audit's clinical themes, comma-separated tema_klaim codes ("I,N"); empty = every theme (the user,
    2026-11-14: a new audit picks one, several or all themes). The report, its Box and its metrics cover those themes' claims."""
    M = muat(nama)
    F = M["F"]
    P = bagi_kc(M["rs"])
    kc_of = np.array([P["kab_kc"][M["rs"][fk]["kab"]] for fk in F["faskes"]])
    tema_set = sorted({t.strip().upper() for t in tema_pilih.split(",") if t.strip()})
    tema_semua = np.array([tema_klaim(d, kd) for d, kd in zip(F["dx"], F["kode"])])
    di_tema = np.isin(tema_semua, tema_set) if tema_set else np.ones(len(tema_semua), bool)
    OUT = BASIS / nama
    OUT.mkdir(parents=True, exist_ok=True)
    nar_f = KERJA / f"narasi_{nama}.json"
    narasi = json.loads(nar_f.read_text("utf-8"))["narasi"] if nar_f.exists() else {}
    tugas, idx_all, dibuang = [], [], 0
    for kid, kc in sorted(P["kc"].items(), key=lambda x: (x[1]["provinsi"], x[1]["nama"])):
        if kc_pilih and kid != kc_pilih:
            continue
        idx = np.flatnonzero((kc_of == kid) & di_tema)
        if not len(idx):
            continue
        L = laporan_kc(kc, idx, M)
        L["run"] = {"id": nama, "label": label}
        L["tema_audit"] = [{"kode": t, "nama": TEMA.get(t, t)} for t in tema_set] or None  # None = every theme
        L["narasi"] = {}
        for e in L["exhibit"]:
            kunci = f"{kid}|{e['id']}"
            tugas.append({"kunci": kunci, "judul": f"{kc['nama']} — {e['judul']} ({e['ukuran']})",
                          "fakta": e["fakta"] + [f"{m['metrik']}: {m['nilai']} — {m['arti']}" for m in e.get("pimpinan") or []]})
            n = narasi.get(kunci)
            if n:
                ok = angka_fakta(e)
                mk, b1 = cek_kalimat(n.get("makna", ""), ok)
                im, b2 = cek_kalimat(n.get("implikasi", ""), ok)
                dibuang += b1 + b2
                if mk or im:
                    L["narasi"][e["id"]] = {"makna": mk, "implikasi": im}
        (OUT / f"kc_{kid}.json").write_text(json.dumps(L, ensure_ascii=False, default=str), "utf-8")
        s = L["sampul"]
        idx_all.append({"id": kid, "nama": kc["nama"], "provinsi": kc["provinsi"], "kabkota": kc["kabkota"], "klaim": s["klaim"], "antrean": s["antrean"],
                        "nilai_antrean_rp": s["nilai_antrean_rp"], "ragu": s["ragu"], "tema_teratas": next((t["nama"] for t in L["tema"] if t["periksa"] + t["tahan"] > 0), None)})
    with (KERJA / f"narasi_tugas_{nama}.jsonl").open("w", encoding="utf-8") as fh:
        for t in tugas:
            fh.write(json.dumps(t, ensure_ascii=False) + "\n")
    nar_biaya = json.loads(nar_f.read_text("utf-8"))["biaya"] if nar_f.exists() else None
    import cabang_analisis as CA

    semua = np.flatnonzero(((kc_of == kc_pilih) if kc_pilih else np.ones(len(kc_of), bool)) & di_tema)
    tema_all = np.array([tema_klaim(d, kd) for d, kd in zip(F["dx"][semua], F["kode"][semua])])
    b_all = F["biaya"].astype(float)[semua]
    K4 = json.loads((HERE / "model_v4" / "kartu.json").read_text("utf-8"))
    if M["model"] == "ml_v7":
        K7 = json.loads((HERE / "model_ml_v7" / "kartu.json").read_text("utf-8"))
        latih_d = {"baris": sum(K7["latih"].values()), "fraud": K7["fraud_latih"], "generator": "generator 1 + 2 + 2-halus"}
        Z7 = json.loads((HERE / "model_ml_v7" / "zona_v5.json").read_text("utf-8"))["dev"]
        val_d = {"baris": Z7["klaim"], "fraud": Z7["fraud"], "untuk": "ambang ML v7 (zona TAHAN/RAGU/PERIKSA, testing/zona_ml_v7.py); tau dan prompt swarm dari v5"}
    else:
        latih_d, val_d = K4["latih"], {"baris": 8152, "fraud": 595, "untuk": "ambang model, pilihan rule, ambang swarm (tau), prompt dibekukan"}
    lampiran = {**({"riil": cek_riil(M, semua), "riil_nasional": cek_riil(M, np.arange(len(F["faskes"])))} if RIIL else
                   {"kinerja": CA.kinerja(M["z"], M["kep"], M["rule_mask"], M["K"]["ambang"]["periksa_v4"], semua, b_all, ci=True),
                    "kesalahan": CA.kesalahan(M["z"], M["kep"], semua, tema_all, TEMA, b_all)}),
                "desain": {"latih": latih_d, "validasi": val_d, "model": M["model_nama"],
                           "uji": {"set": nama, "klaim": int(len(semua)), "fraud": None if RIIL else int(M["z"]["y"].sum()), "untuk": "tidak dipakai untuk melatih atau memilih apa pun"},
                           "generator": ("data riil sampel BPJS, jendela 18–31 Des 2024 (tanpa label fraud)" if RIIL else sumber_tema(nama) or
                                         "generator 3 (ditulis terpisah dari generator 1/2 yang membuat data latih)")}}
    hasil_f = KERJA / f"hasil_{nama}.json"  # when the swarm actually ran (the report may be rebuilt later)
    meta = {"id": nama, "label": label, "dibuat": time.strftime("%Y-%m-%d %H:%M"), "dijalankan": time.strftime("%Y-%m-%d %H:%M", time.localtime(hasil_f.stat().st_mtime)),
            "kc": len(idx_all), "metrik": metrik_run(M, semua), "model": M["model_nama"], "kc_pilih": kc_pilih or None, "tema_pilih": tema_set or None,
            "biaya_usd": round(float(M["biaya_swarm"]["usd_perkiraan"]) + float((nar_biaya or {}).get("usd_perkiraan") or 0), 3),
            "biaya_swarm": M["biaya_swarm"], "biaya_narasi": nar_biaya, "narasi_exhibit": sum(1 for _ in narasi), "kalimat_dibuang_cek_angka": dibuang}
    q_sem = np.isin(M["kep"][semua], ["TAHAN", "PERIKSA"])
    if M.get("iot"):  # a claim an IoT mismatch put in the queue
        q_sem |= np.array([bool(iot_tidak_sesuai(M, M["z"]["kunci"][i])) for i in semua], bool)
    rugi_run = 0
    for f_ in OUT.glob("kc_*.json"):
        if not kc_pilih or f_.name == f"kc_{kc_pilih}.json":
            rugi_run += json.loads(f_.read_text("utf-8"))["sampul"].get("estimasi_kerugian_rp", 0)
    meta["operasional"] = {"klaim": int(len(semua)), "antrean": int(q_sem.sum()), "nilai_transaksi_rp": int(b_all.sum()),
                           "nilai_ditandai_rp": int(b_all[q_sem].sum()), "estimasi_kerugian_rp": int(rugi_run), "dibaca_swarm": int(M["z"]["ragu"][semua].sum())}
    (OUT / "index.json").write_text(json.dumps({**meta, "kc": idx_all, "porsi_kc": PORSI_KC, "lampiran": lampiran}, ensure_ascii=False, default=int), "utf-8")
    runs_f = BASIS / "runs.json"
    runs = [r for r in (json.loads(runs_f.read_text("utf-8"))["runs"] if runs_f.exists() else []) if r["id"] != nama]
    runs.append(meta)
    runs.sort(key=lambda r: r.get("dijalankan") or r["dibuat"], reverse=True)
    runs_f.write_text(json.dumps({"runs": runs}, ensure_ascii=False), "utf-8")
    print(f"{len(idx_all)} KC -> {OUT}; tugas narasi {len(tugas)}; narasi dipakai {len(narasi)}, kalimat dibuang {dibuang}; metrik {json.dumps(meta['metrik'])}")
    if not RIIL:  # the claim network of every case file (testing/graf_cabang.py, shown in the case file; the user, 2026-11-14)
        try:
            import graf_cabang

            graf_cabang.main(nama, kc_pilih)
        except (Exception, SystemExit) as e:  # noqa: BLE001 - the report stands without it
            print(f"graf_cabang: claim networks not written ({e}); run testing/graf_cabang.py --set {nama}")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="gen3_v5")
    ap.add_argument("--label", default="")
    ap.add_argument("--kc", default="", help="one branch id (e.g. sum-1275): the report and metrics for that branch only")
    ap.add_argument("--tema", default="", help="clinical themes of the audit, tema_klaim codes comma-separated (e.g. I,N); default every theme")
    ap.add_argument("--indikasi-awal", action="store_true", help="only the Indikasi block (before the swarm): one line 'INDIKASI {json}' on stdout")
    a = ap.parse_args()
    if a.indikasi_awal:
        print("INDIKASI " + json.dumps(indikasi_awal(a.set, a.kc, a.tema), ensure_ascii=False), flush=True)
    else:
        main(a.set, a.label or a.set, a.kc, a.tema)
