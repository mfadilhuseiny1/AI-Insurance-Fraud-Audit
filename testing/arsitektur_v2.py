"""Architecture v2 (rule-aware) of the /testing fraud models: definitions and scoring, shared by latih_v2.py (training),
the 100.000-claim test and the /testing service. Synthetic data only.

Why: the first architecture (one LightGBM on 624 features + ring model + stacker) gave the rule signal of each scheme
almost no weight (KELAS_DI_ATAS_HAK 0.01 % of the gain) and leaned on how the training fraud was built. On claims it never
saw, it caught 28 % of the fraud while the rules flagged every single-claim scheme.

Layers (all inputs are the features the realtime engine and fitur.py already compute):
1. Rule evidence: a LightGBM on the engine's rule signals and rule score, monotone increasing in every input, so each rule's
   reliability is learned from the labels and a finding can only raise the risk.
2. Specialists, one per family of Permenkes 16/2019 modes. The engine already maps every rule signal to its modes
   (aip.realtime.modus); FAMILI groups those modes with their schemes, rule signals, claim fields and graph relations (a
   small ontology). Each specialist sees only its own feature group (own claim + the means of its graph neighbours), is
   monotone increasing in its rule signals, and is trained on its own family's fraud against normal claims, so a rare
   family is not drowned by a frequent one and the history of the member cannot stand in for the scheme.
3. Graph model (Model 1): the claim and its neighbours over four relations (624 features), as before.
4. Ring model (Model 2) and the monotone ring alert, as before (family "jaringan", M10).
5. Fusion: a LightGBM on the logits of 1–4, monotone increasing in every input, then isotonic calibration.
6. Rule route: a rule signal that is specific (it fires on at most 0.5 % of the normal training claims) but that the models
   have fewer than 30 labelled fraud examples of sends the claim to review: where the models have evidence they decide,
   where they have none the expert rule decides (a new fraud type is otherwise invisible to a supervised model).
Decision: calibrated p >= 0.5, or the ring alert, or the rule route.

Architecture v3 (2026-11-12, after the ablations on claims never trained on): the same module, with the layers that added
nothing removed: Model 2 and the ring alert (the fusion gave Model 2 2.7 % of its weight, the alert caught no fraud the
others missed) and the rule layer (0 % of the weight; Model 1 reads the same rule signals). Kept: Model 1, the four
specialists, the monotone fusion, the rule route. Added: a label-free ring rule for ring shapes no model has seen: a claim
whose member shares hospitals with at least t other members within +-3 days, t set on the normal training claims only.
The ring computation itself (fitur.Stream.ring_detail) stays for the evidence of M10 and the network on screen."""
from __future__ import annotations

import numpy as np

RELASI = ["peserta", "faskes", "faskes_kode", "kode"]  # the order of fitur.CAPS (the blocks of a Model 1 row)
NORMAL = ("normal", "aug:normal")

FAMILI: dict[str, dict] = {
    "koding": {
        "nama": "Coding diagnosis dan tindakan", "modus": ["M04", "M14", "M15", "M20"],
        "skema": ["upcoding", "dx_sekunder", "prosedur_fiktif", "kode_tidak_sesuai", "hasil_manipulasi"],
        "sinyal": ["LONJAKAN_KEPARAHAN", "DX_SEKUNDER_BERLEBIH", "KODE_PROSEDUR_TANPA_TINDAKAN", "PASANGAN_KODE_LANGKA",
                   "TIDAK_SESUAI_PESERTA", "HASIL_PEMERIKSAAN_TIDAK_COCOK"],
        "klaim": ["log_biaya", "biaya_tagih", "tarif_inacbg", "frek_kode", "frek_dx", "p_berat_dx", "p_prosedur_dx", "dx_sekunder",
                  "ada_prosedur", "idx_tarif_kode", "rasio_tagih_tarif", "f_pct_keparahan_berat", "f_rata_dx_sekunder", "f_idx_tarif_kode",
                  "f_pct_prosedur_rj", "f_pct_rawat_inap"],
        "kategori": ["tingkat_pelayanan", "inacbg_keparahan", "inacbg_tipe_kasus", "jenis_fkrtl"],
        "relasi": ["faskes", "faskes_kode", "kode"],
    },
    "tagihan": {
        "nama": "Tagihan, kelas rawat dan obat/alkes", "modus": ["M07", "M13", "M17", "M18"],
        "skema": ["topup_inflasi", "topup_fiktif", "kelas_naik", "obat_fiktif", "obat_dikurangi"],
        "sinyal": ["TOPUP_TIDAK_LAZIM", "TOPUP_DI_ATAS_PEER", "KELAS_DI_ATAS_HAK", "OBAT_DIKURANGI", "OBAT_TIDAK_DISERAHKAN",
                   "TAGIHAN_MELEBIHI_TARIF"],
        "klaim": ["log_biaya", "biaya_tagih", "tarif_inacbg", "tarif_tambahan", "rasio_tagih_tarif", "idx_tarif_kode", "f_pct_tarif_tambahan",
                  "f_idx_tarif_kode", "frek_kode"],
        "kategori": ["kelas_rawat", "tingkat_pelayanan", "inacbg_keparahan", "inacbg_tipe_kasus"],
        "relasi": ["faskes", "faskes_kode", "kode"],
    },
    "episode": {
        "nama": "Episode dan lama rawat", "modus": ["M08", "M09", "M12", "M16"],
        "skema": ["los_bergeser", "readmisi", "pemecahan_episode", "episode_hari_sama"],
        "sinyal": ["LOS_FASKES_BERGESER", "LOS_DIPERPANJANG", "PEMECAHAN_EPISODE", "EPISODE_HARI_SAMA", "READMISI_DX_SAMA", "READMISI"],
        "klaim": ["los", "idx_los", "f_idx_los", "f_pct_rawat_inap", "frek_kode", "hari_sejak_sebelumnya", "kunjungan_peserta_faskes"],
        "kategori": ["tingkat_pelayanan", "inacbg_keparahan", "inacbg_tipe_kasus"],
        "relasi": ["peserta", "faskes", "faskes_kode"],
    },
    "identitas": {
        "nama": "Identitas peserta dan duplikasi", "modus": ["M05", "M06", "M11"],
        "skema": ["kloning", "kartu_dipinjam", "klaim_ganda", "klaim_mirip", "setelah_meninggal", "kartu_keluarga"],
        "sinyal": ["RAWAT_INAP_TUMPANG_TINDIH", "KARTU_BANYAK_FASKES", "KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP",
                   "KLONING_LINTAS_PESERTA", "KLAIM_SETELAH_MENINGGAL", "MENINGGAL_TERCATAT", "KARTU_KELUARGA"],
        "klaim": ["kunjungan_peserta", "kunjungan_peserta_faskes", "kembar", "hari_sejak_sebelumnya", "f_pct_kembar", "f_jumlah_klaim", "los",
                  "biaya_tagih"],
        "kategori": ["tingkat_pelayanan"],
        "relasi": ["peserta", "faskes_kode", "kode"],
    },
}
JARINGAN = {"nama": "Jaringan faskes", "modus": ["M10"], "skema": ["cincin_kolusi", "cincin_bentuk_baru"], "sinyal": ["CINCIN_FASKES", "RISIKO_ASOSIASI", "KONSENTRASI_RUJUKAN"]}


def skema_dasar(sk: str) -> str:
    return sk[4:] if sk.startswith("aug:") else sk


def famili_dari(sk: str) -> str | None:
    s = skema_dasar(sk)
    for f, d in FAMILI.items():
        if s in d["skema"]:
            return f
    return "jaringan" if s in JARINGAN["skema"] else None


def kolom_famili(sys_names: list[str], fam: dict) -> tuple[np.ndarray, np.ndarray]:
    """Column indexes into a Model 1 row (own block, the blocks of the family's relations, their degrees) and monotone flags
    (+1 on the family's own rule signals)."""
    n = len(sys_names)
    pos = {nm: i for i, nm in enumerate(sys_names)}
    sig = [pos["s:" + s] for s in fam["sinyal"] if "s:" + s in pos]
    kl: list[int] = []
    for k in fam["klaim"]:
        for nm in (f"klaim: {k}", f"klaim: na_{k}", k):
            if nm in pos:
                kl.append(pos[nm])
    for pre in fam["kategori"]:
        kl += [i for nm, i in pos.items() if nm.startswith(f"klaim: {pre}=")]
    base = sig + [i for i in dict.fromkeys(kl) if i not in sig]
    cols, mono = list(base), [1] * len(sig) + [0] * (len(base) - len(sig))
    for r in fam["relasi"]:
        b = 1 + RELASI.index(r)
        cols += [b * n + i for i in base]; mono += [0] * len(base)
        cols.append(5 * n + RELASI.index(r)); mono.append(0)
    return np.array(cols), np.array(mono)


def kolom_rule(sys_names: list[str]) -> np.ndarray:
    """The rule signals (not the engine's own ML score) and the rule score, before and after mitigation."""
    return np.array([i for i, nm in enumerate(sys_names) if (nm.startswith("s:") and nm != "s:SKOR_ML") or nm in ("skor_aturan", "skor_tanpa_mitigasi")])


def lg(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def skor(b: dict, X1: np.ndarray, X2: np.ndarray, XR: np.ndarray) -> dict:
    """Every layer's probability, the fused score, the calibrated probability, the ring alert and the decision."""
    out = {}
    for nama, k in b["komponen"].items():
        X = X1 if k["input"] == "X1" else X2
        out[nama] = k["model"].predict_proba(X if k["kolom"] is None else X[:, k["kolom"]])[:, 1]
    ps = b["stacker"].predict_proba(np.column_stack([lg(out[n]) for n in b["urutan"]]))[:, 1]
    cal = b["iso"].predict(ps)
    pm = b["mono"].predict_proba(XR)[:, 1] if b.get("mono") is not None else np.zeros(len(XR))
    alert = pm > b["ambang_alert_ring"] if b.get("ambang_alert_ring") is not None else np.zeros(len(XR), bool)
    rute = rute_rule(b, X1)
    jar = rule_jaringan(b, XR)
    return {**out, "ps": ps, "cal": cal, "pm": pm, "rute": rute, "jaringan_rule": jar, "flag": (cal >= b["ambang_peluang"]) | alert | rute | jar}


def pilih_rule_jaringan(XR: np.ndarray, y: np.ndarray, maks_normal: float = 0.002) -> dict:
    """The label-free ring rule: other members sharing hospitals with this member within +-3 days (XR column 0, log1p);
    the smallest count >= 2 that fires on at most 0.2 % of the normal training claims."""
    v = np.round(np.expm1(XR[y == 0, 0]))
    t = next(t for t in range(2, 50) if (v >= t).mean() <= maks_normal)
    return {"kolom": 0, "hari": 3, "ambang": int(t), "laju_normal_latih": round(float((v >= t).mean()), 5)}


def rule_jaringan(b: dict, XR: np.ndarray) -> np.ndarray:
    rj = b.get("rule_jaringan")
    return np.round(np.expm1(XR[:, rj["kolom"]])) >= rj["ambang"] if rj else np.zeros(len(XR), bool)


RUTE_MIN_CONTOH, RUTE_MAKS_NORMAL = 30, 0.005


def pilih_rute(sys_names: list[str], X1: np.ndarray, y: np.ndarray) -> dict:
    """The rule signals of the route, from the training data only: specific (fire on <= 0.5 % of normal claims) and with
    fewer than 30 labelled fraud examples."""
    idx = [i for i, nm in enumerate(sys_names) if nm.startswith("s:") and nm != "s:SKOR_ML"]
    nz = X1[:, idx] > 0
    n_pos, laju = nz[y == 1].sum(0), nz[y == 0].mean(0)
    pilih = [j for j in range(len(idx)) if n_pos[j] < RUTE_MIN_CONTOH and laju[j] <= RUTE_MAKS_NORMAL]
    return {"kolom": [idx[j] for j in pilih], "nama": [sys_names[idx[j]] for j in pilih], "contoh": [int(n_pos[j]) for j in pilih],
            "laju_normal": [round(float(laju[j]), 5) for j in pilih], "min_contoh": RUTE_MIN_CONTOH, "maks_normal": RUTE_MAKS_NORMAL}


def rute_rule(b: dict, X1: np.ndarray) -> np.ndarray:
    rr = b.get("rute_rule") or {}
    return (X1[:, rr["kolom"]] > 0).any(1) if rr.get("kolom") else np.zeros(len(X1), bool)


def skor_lama(m: dict, X1: np.ndarray, X2: np.ndarray, XR: np.ndarray) -> dict:
    """The first architecture (testing/model, model_tanpa_aug), for comparisons."""
    p1, p2 = m["m1"].predict_proba(X1)[:, 1], m["m2"].predict_proba(X2)[:, 1]
    ps = m["stacker"].predict_proba(np.column_stack([lg(p1), lg(p2)]))[:, 1]
    cal = m["iso"].predict(ps)
    pm = m["mono"].predict_proba(XR)[:, 1]
    return {"model1": p1, "model2": p2, "ps": ps, "cal": cal, "pm": pm,
            "flag": (cal >= m["kartu"]["ambang_peluang"]) | (pm > m["kartu"]["ambang_alert_ring"])}
