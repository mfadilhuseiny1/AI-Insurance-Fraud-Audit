"""Distribution-shift diagnosis across generator 1, 2 and 3 (reviewer note, 2026-11-13: "jangan langsung ganti algoritma ML, fokus
dulu ke data generating process: evaluasi perbedaan distribusi fitur, median, varians; periksa apakah pola fraud dan non-fraud
konsisten antar generator").

Diagnosis only: no model is trained to be used, nothing is chosen. Generator 3 = the two seeds that were already scored once
(gen3-ml5, gen3-ml6); looking at their labels here means any later claim about generator 3 needs a NEW seed (and see the
caveat in the output: shaping generator 1/2 after generator 3's mechanics would make even a new seed less foreign).

  1  set profile       claims, fraud rate, first-visit share of normals and frauds
  2  model view        ML v5 score per generator: AUROC/AUPRC, recall/FPR at the frozen threshold, score histograms
  3  domain gap        a classifier told to tell the generators apart (normals only, frauds only), member-grouped CV AUC
  4  feature shift     the ML v5 features carrying most gain: median, IQR, SD per generator x class, KS and PSI of G3 vs G1+G2
  5  pattern check     single-feature AUROC fraud vs normal in each generator: which training signals vanish or flip in G3
  6  scheme mix        fraud schemes mapped to five mechanism families; recall per family; G3 recall under G2's family mix
-> data/aip/ml/sistem_terbaru/shift_diagnosis.json. Synthetic data only."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

os.environ.setdefault("BLUESANDAI_AUTH", "off")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "api"))
import ml_v5 as M  # noqa: E402
import v4_rule_tambah as RT  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

OUT = M.ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "shift_diagnosis.json"
SETS = {"g1": ["uji100k_c2"], "g2": ["gen2_seed3"], "g3": ["gen3_ml5", "gen3_ml6"]}
LABEL = {"g1": "Generator 1", "g2": "Generator 2", "g3": "Generator 3"}
# planted schemes -> mechanism family (G1/G2 as testing/blu3_evaluasi.py SKEMA_FAMILI; G3's own names mapped by meaning)
FAM = {
    "koding": ["upcoding", "dx_sekunder", "prosedur_fiktif", "kode_tidak_sesuai", "upcoding_prosedur", "upcoding_keparahan", "diagnosis_utama_diganti",
               "tidak_sesuai_indikasi", "tindakan_fiktif", "operasi_batal_ditagih", "sesi_rutin_fiktif", "rawat_inap_tanpa_indikasi"],
    "tagihan": ["topup_inflasi", "topup_fiktif", "kelas_naik", "naik_kelas", "phantom_billing", "klaim_fiktif", "obat_alkes_fiktif", "tagihan_gelembung",
                "topup_gelembung"],
    "episode": ["los_bergeser", "los_diperpanjang", "geser_bertahap", "pemecahan_episode", "readmisi", "readmisi_direncanakan", "pulang_dini_readmisi"],
    "identitas": ["kloning", "kartu_dipinjam", "klaim_ganda", "klaim_berulang", "episode_hari_sama"],
    "jaringan": ["cincin_kolusi", "cincin_bentuk_baru", "dokter_tiga_rs", "rujukan_semu"],
}
SK2FAM = {s: f for f, v in FAM.items() for s in v}
TOP_FITUR = 24


def say(*a) -> None:
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def muat(nama: str) -> dict:
    parts = []
    for d in SETS[nama]:
        U = M.muat_set(M.TMP / d)
        parts.append({"X": M.fitur("K1", U["X1"], U["X4"], None), "y": U["y"], "sk": U["sk"].astype(str), "pertama": U["pertama"],
                      "grup": np.char.add(d + ":", U["grup"].astype(str))})
        del U
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def auc_kolom(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Single-feature AUROC fraud vs normal per column (NaN ranked lowest)."""
    from scipy.stats import rankdata

    n1, n0 = int(y.sum()), int((y == 0).sum())
    out = np.empty(X.shape[1])
    for j in range(X.shape[1]):
        x = np.nan_to_num(X[:, j].astype(np.float64), nan=-1e30)
        r = rankdata(x)
        out[j] = (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)
    return out


def psi(ref: np.ndarray, x: np.ndarray, bins: int = 10) -> float:
    ref, x = ref.astype(float), x.astype(float)
    na_r, na_x = np.isnan(ref).mean(), np.isnan(x).mean()
    rr, xx = ref[~np.isnan(ref)], x[~np.isnan(x)]
    if len(rr) == 0 or len(xx) == 0:
        return 0.0
    edges = np.unique(np.quantile(rr, np.linspace(0, 1, bins + 1)))
    if len(edges) < 2:
        p = np.array([1 - na_r, na_r]); q = np.array([np.mean(xx == rr[0]) * (1 - na_x), na_x])
        q = np.r_[q, 1 - q.sum()]; p = np.r_[p, 0.0]
    else:
        cut = edges[1:-1]
        p = np.bincount(np.searchsorted(cut, rr, side="right"), minlength=len(edges) - 1) / len(rr) * (1 - na_r)
        q = np.bincount(np.searchsorted(cut, xx, side="right"), minlength=len(edges) - 1) / len(xx) * (1 - na_x)
        p, q = np.r_[p, na_r], np.r_[q, na_x]
    p, q = np.clip(p, 1e-4, None), np.clip(q, 1e-4, None)
    return float(np.sum((q - p) * np.log(q / p)))


def ringkas(x: np.ndarray) -> dict:
    x = x.astype(float)
    na = float(np.isnan(x).mean())
    v = x[~np.isnan(x)]
    if len(v) == 0:
        return {"med": None, "q25": None, "q75": None, "sd": None, "na": na}
    q25, med, q75 = np.quantile(v, [0.25, 0.5, 0.75])
    return {"med": float(med), "q25": float(q25), "q75": float(q75), "sd": float(v.std()), "nol": float(np.mean(v == 0)), "na": na}


def domain_auc(A: np.ndarray, B: np.ndarray, gA: np.ndarray, gB: np.ndarray, names: list[str], rng) -> dict:
    import lightgbm as lgb
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import GroupKFold

    def sub(X, g, n):
        i = rng.choice(len(X), size=min(n, len(X)), replace=False)
        return X[i], g[i]

    A, gA = sub(A, gA, 12000); B, gB = sub(B, gB, 12000)
    X = np.vstack([A, B]); y = np.r_[np.zeros(len(A)), np.ones(len(B))]; g = np.r_[gA, gB]
    par = dict(n_estimators=200, learning_rate=0.05, num_leaves=31, colsample_bytree=0.5, subsample=0.8, subsample_freq=1, min_child_samples=40,
               verbose=-1, n_jobs=8, random_state=0)
    oof = np.zeros(len(y))
    for tr, te in GroupKFold(3).split(X, y, g):
        m = lgb.LGBMClassifier(**par).fit(X[tr], y[tr])
        oof[te] = m.predict_proba(X[te])[:, 1]
    m = lgb.LGBMClassifier(**par).fit(X, y)
    gain = m.booster_.feature_importance("gain"); gain = gain / max(gain.sum(), 1e-12)
    return {"auc": round(float(roc_auc_score(y, oof)), 4), "n": [int(len(A)), int(len(B))],
            "top": [{"fitur": names[j], "porsi": round(float(gain[j]), 4)} for j in np.argsort(-gain)[:8]]}


def jalan() -> None:
    import joblib
    from sklearn.metrics import average_precision_score, roc_auc_score

    b5 = joblib.load(M.MODEL / "model.joblib")
    assert b5["kind"] == "K1"
    names = list(joblib.load(HERE / "model_v3_bersih" / "model.joblib")["agg_names"]) + list(__import__("fitur_v4").NAMES)
    t = b5["ambang_periksa"]["global"]
    gain = np.mean([m.booster_.feature_importance("gain") for m in b5["models"]], axis=0); gain = gain / gain.sum()
    D = {}
    for g in SETS:
        D[g] = muat(g)
        D[g]["s"] = M.skor(b5["models"], D[g]["X"])
        say(g, len(D[g]["y"]), int(D[g]["y"].sum()))
    out: dict = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "data_sintetis_saja": True,
                 "sumber": {g: SETS[g] for g in SETS}, "model": "ML v5 (beku, ambang global FPR 1% di dev)", "ambang": t,
                 "catatan": ["Generator 3 = dua seed yang sudah dinilai sekali (gen3-ml5, gen3-ml6). Labelnya dipakai di sini untuk diagnosis; klaim generator 3 berikutnya wajib seed baru.",
                             "Bila generator 1/2 nanti dibentuk meniru mekanisme generator 3, seed generator 3 yang baru pun tidak lagi asing: perlu generator 4 yang ditulis terpisah untuk uji jujur."]}
    # 1 + 2: profile and model view
    prof, mv = {}, {}
    bins = np.linspace(0, 1, 21)
    for g, d in D.items():
        y, s, p = d["y"], d["s"], d["pertama"]
        f = s > t
        nrm = y == 0
        prof[g] = {"label": LABEL[g], "klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 5),
                   "pertama_normal": round(float(p[nrm].mean()), 4), "pertama_fraud": round(float(p[y == 1].mean()), 4),
                   "skema": int(len(np.unique(d["sk"][y == 1])))}
        mv[g] = {**RT.ukur(y, f), "auroc": round(float(roc_auc_score(y, s)), 4), "auprc": round(float(average_precision_score(y, s)), 4),
                 "fpr_pertama": round(float(f[nrm & p].mean()), 5), "fpr_lama": round(float(f[nrm & ~p].mean()), 5),
                 "recall_pertama": round(float(f[(y == 1) & p].mean()), 4) if ((y == 1) & p).any() else None,
                 "recall_lama": round(float(f[(y == 1) & ~p].mean()), 4) if ((y == 1) & ~p).any() else None,
                 "skor_normal": ringkas(s[nrm]), "skor_fraud": ringkas(s[y == 1]),
                 "hist_normal": np.round(np.histogram(s[nrm], bins)[0] / nrm.sum(), 5).tolist(),
                 "hist_fraud": np.round(np.histogram(s[y == 1], bins)[0] / max(1, (y == 1).sum()), 5).tolist()}
    out["profil"], out["pandangan_model"] = prof, mv
    say("model", {g: (mv[g]["recall"], mv[g]["fpr"], mv[g]["auroc"]) for g in mv})
    # 3: domain gap
    rng = np.random.default_rng(0)
    dom = []
    for a, b in (("g1", "g2"), ("g1", "g3"), ("g2", "g3"), ("g12", "g3")):
        for kelas, c in (("normal", 0), ("fraud", 1)):
            if a == "g12":
                XA = np.vstack([D["g1"]["X"][D["g1"]["y"] == c], D["g2"]["X"][D["g2"]["y"] == c]])
                GA = np.r_[D["g1"]["grup"][D["g1"]["y"] == c], D["g2"]["grup"][D["g2"]["y"] == c]]
            else:
                XA, GA = D[a]["X"][D[a]["y"] == c], D[a]["grup"][D[a]["y"] == c]
            XB, GB = D[b]["X"][D[b]["y"] == c], D[b]["grup"][D[b]["y"] == c]
            r = domain_auc(XA, XB, GA, GB, names, rng)
            dom.append({"pasangan": f"{a}_{b}", "kelas": kelas, **r})
            say("domain", a, b, kelas, r["auc"])
    out["domain"] = dom
    # 5: single-feature AUROC per generator (all features) and pattern consistency
    au = {g: auc_kolom(d["X"], d["y"]) for g, d in D.items()}
    e = {g: au[g] - 0.5 for g in au}
    from scipy.stats import spearmanr

    kor = {f"{a}_{b}": round(float(spearmanr(e[a], e[b]).statistic), 3) for a, b in (("g1", "g2"), ("g1", "g3"), ("g2", "g3"))}
    latih = (np.abs(e["g1"]) >= 0.1) & (np.abs(e["g2"]) >= 0.1) & (np.sign(e["g1"]) == np.sign(e["g2"]))
    tanda = np.sign(e["g1"] + e["g2"])
    hilang = latih & (np.abs(e["g3"]) < 0.03)
    balik = latih & (np.sign(e["g3"]) != tanda) & (np.abs(e["g3"]) >= 0.03)
    lemah = latih & ~hilang & ~balik & (np.abs(e["g3"]) < 0.5 * np.minimum(np.abs(e["g1"]), np.abs(e["g2"])))
    tetap = latih & ~hilang & ~balik & ~lemah
    g3baru = ~latih & (np.abs(e["g3"]) >= 0.1)
    out["pola"] = {"korelasi_spearman_auroc": kor, "fitur_total": len(names), "informatif_di_g1_dan_g2": int(latih.sum()),
                   "di_g3": {"tetap": int(tetap.sum()), "melemah": int(lemah.sum()), "hilang": int(hilang.sum()), "terbalik": int(balik.sum())},
                   "porsi_gain_ml_v5": {"tetap": round(float(gain[tetap].sum()), 4), "melemah": round(float(gain[lemah].sum()), 4),
                                        "hilang": round(float(gain[hilang].sum()), 4), "terbalik": round(float(gain[balik].sum()), 4),
                                        "lain": round(float(gain[~latih].sum()), 4)},
                   "sinyal_baru_g3": int(g3baru.sum()),
                   "contoh_hilang": [names[j] for j in np.argsort(-gain * hilang)[:6] if hilang[j]],
                   "contoh_terbalik": [names[j] for j in np.argsort(-gain * balik)[:6] if balik[j]],
                   "contoh_baru_g3": [{"fitur": names[j], "auroc_g3": round(float(au["g3"][j]), 3)} for j in np.argsort(-np.abs(e["g3"]) * g3baru)[:6] if g3baru[j]]}
    say("pola", kor, out["pola"]["di_g3"])
    # 4: feature shift on the top-gain features
    top = np.argsort(-gain)[:TOP_FITUR]
    fit = []
    from scipy.stats import ks_2samp

    for j in top:
        row = {"fitur": names[j], "porsi_gain": round(float(gain[j]), 4), "per_gen": {}}
        for g, d in D.items():
            row["per_gen"][g] = {"normal": ringkas(d["X"][d["y"] == 0, j]), "fraud": ringkas(d["X"][d["y"] == 1, j]), "auroc": round(float(au[g][j]), 4)}
        for kelas, c in (("normal", 0), ("fraud", 1)):
            ref = np.r_[D["g1"]["X"][D["g1"]["y"] == c, j], D["g2"]["X"][D["g2"]["y"] == c, j]].astype(float)
            x3 = D["g3"]["X"][D["g3"]["y"] == c, j].astype(float)
            x1, x2 = D["g1"]["X"][D["g1"]["y"] == c, j].astype(float), D["g2"]["X"][D["g2"]["y"] == c, j].astype(float)
            ks = lambda a, b: float(ks_2samp(np.nan_to_num(a, nan=-1e30), np.nan_to_num(b, nan=-1e30)).statistic)
            sd_ref = np.nanstd(ref)
            sd3 = np.nanstd(x3)
            row[f"shift_{kelas}"] = {"ks_g3_vs_g12": round(ks(ref, x3), 3), "ks_g1_vs_g2": round(ks(x1, x2), 3), "psi_g3_vs_g12": round(psi(ref, x3), 3),
                                     "psi_g2_vs_g1": round(psi(x1, x2), 3), "rasio_sd_g3": round(float(sd3 / sd_ref), 3) if sd_ref > 0 else None}
        e12 = (au["g1"][j] - 0.5, au["g2"][j] - 0.5)
        row["arah"] = "terbalik" if balik[j] else "hilang" if hilang[j] else "melemah" if lemah[j] else "tetap" if tetap[j] else "tidak informatif di latih"
        fit.append(row)
    out["fitur"] = fit
    # 6: scheme mix and recall per family
    fam, skm = {}, {}
    for g, d in D.items():
        y, f = d["y"], d["s"] > t
        fr = y == 1
        fa = np.array([SK2FAM.get(s, "lain") for s in d["sk"]])
        fam[g] = {}
        for k in list(FAM) + ["lain"]:
            m = fr & (fa == k)
            if m.any():
                fam[g][k] = {"n": int(m.sum()), "porsi": round(float(m.sum() / fr.sum()), 4), "recall": round(float(f[m].mean()), 4)}
        skm[g] = sorted([{"skema": s, "famili": SK2FAM.get(s, "lain"), "n": int(((d["sk"] == s) & fr).sum()), "recall": round(float(f[(d["sk"] == s) & fr].mean()), 4)}
                         for s in np.unique(d["sk"][fr])], key=lambda r: -r["n"])
    def campur(rec_of: str, mix_of: str) -> float:
        ks_ = [k for k in fam[mix_of] if k in fam[rec_of]]
        w = np.array([fam[mix_of][k]["porsi"] for k in ks_]); r = np.array([fam[rec_of][k]["recall"] for k in ks_])
        return round(float((w * r).sum() / w.sum()), 4)
    out["famili"], out["skema"] = fam, skm
    out["dekomposisi"] = {"recall_g2": mv["g2"]["recall"], "recall_g3": mv["g3"]["recall"],
                          "recall_g3_dengan_campuran_g2": campur("g3", "g2"), "recall_g2_dengan_campuran_g3": campur("g2", "g3"),
                          "recall_g1": mv["g1"]["recall"], "recall_g3_dengan_campuran_g1": campur("g3", "g1")}
    say("famili", {g: {k: (v["porsi"], v["recall"]) for k, v in fam[g].items()} for g in fam})
    say("dekomposisi", out["dekomposisi"])
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    say("ditulis", OUT)


if __name__ == "__main__":
    VG.LOCK_NAMA = "diagnosa-shift"
    with VG.kunci_berat():
        jalan()
