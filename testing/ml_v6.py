"""ML v6 = ML v5 + network features in the style of entity-network analytics (X6, testing/fitur_v6.py). No LLM, no cost.
Plan and rules fixed first in testing/kriteria_ml_v6.json; same data, dev sets and checks as ML v5 (testing/ml_v5.py).

  latih       L1 (= ML v5's features, retrained identically) and L2 (+ X6), LightGBM x 3 seeds; pick on the two dev sets (L2
              only if >= 1 point better); overfit checks; freeze in testing/model_ml_v6
  benchmark   generator 1 = test C2, generator 2 = gen2 seed 3 (seen before, never used to choose), generator 3 = a NEW seed
              (GEN3_GARAM=gen3-ml6, .tmp/gen3_ml6) scored once; v3, v4, ML v5 and ML v6 on the same claims
              -> data/aip/ml/sistem_terbaru/ml_v6_benchmark.json
Synthetic data only."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

import ml_v5 as M5
from ml_v5 import A, RT, V4, VG, say  # noqa: F401  (shared imports, path set up by ml_v5)
import fitur_v6 as F6

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MODEL = HERE / "model_ml_v6"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "ml_v6_benchmark.json"
UJI = {**M5.UJI, "generator3": ROOT / ".tmp" / "gen3_ml6"}
LABEL_UJI = {**M5.LABEL_UJI, "generator3": "Generator 3 · seed baru gen3-ml6 (data asing, dinilai sekali)"}


def _ci_skor() -> int:
    import joblib

    return list(joblib.load(HERE / "model_v3_bersih" / "model.joblib")["sys_names"]).index("skor_aturan")


def x6_set(F: "F6.Fitur6", U: dict, ci: int) -> np.ndarray:
    out = np.zeros((len(U["y"]), len(F6.NAMES)), np.float32)
    for c in np.unique(U["chunk"]):
        m = U["chunk"] == c
        out[m] = F.blok({"peserta": U["peserta"][m], "faskes": U["faskes"][m], "tgl": U["tgl"][m], "skor": U["X1"][m][:, ci]})
    return out


def fitur(kind: str, X1, X4, X6) -> np.ndarray:
    return np.hstack([X1, X4] + ([X6] if kind == "L2" else [])).astype(np.float32)


def latih() -> None:
    import joblib
    import lightgbm as lgb
    from sklearn.metrics import average_precision_score
    from sklearn.model_selection import GroupKFold

    ci = _ci_skor()
    say("muat data generator 1 (stream + data_v4)")
    D = VG.muat_data()
    S = np.load(VG.STREAM, allow_pickle=False)
    ns = int((D["chunk"] == -1).sum())
    tgl = np.empty(len(D["y"]), dtype=object)
    tgl[:ns] = S["tgl"][:ns].astype(str)
    for c in range(10):
        m = D["chunk"] == c
        tgl[m] = np.load(M5.TMP / "data_v4" / f"fitur_{c:02d}.npz", allow_pickle=False)["tgl"].astype(str)[D["pos"][m]]
    F = F6.Fitur6({"peserta": D["peserta"][:ns], "faskes": D["faskes"][:ns], "tgl": tgl[:ns], "skor": D["X1"][:ns, ci]})
    X6 = np.zeros((len(D["y"]), len(F6.NAMES)), np.float32)
    X6[:ns] = F.X_stream
    for c in range(10):
        m = D["chunk"] == c
        X6[m] = F.blok({"peserta": D["peserta"][m], "faskes": D["faskes"][m], "tgl": tgl[m], "skor": D["X1"][m][:, ci]})
    say("muat generator 2 latih + dev, X6")
    GL, GD = M5.muat_set(M5.G2_LATIH), M5.muat_set(M5.G2_DEV)
    GL["X6"], GD["X6"] = x6_set(F, GL, ci), x6_set(F, GD, ci)
    tr, va = D["latih"], D["val"]
    dev = {"gen1": {"X1": D["X1"][va], "X4": D["X4"][va], "X6": X6[va], "y": D["y"][va]},
           "gen2": {"X1": GD["X1"], "X4": GD["X4"], "X6": GD["X6"], "y": GD["y"]}}
    ytr = np.concatenate([D["y"][tr], GL["y"]])
    hasil, models = {}, {}
    for kind in ("L1", "L2"):
        Xtr = np.vstack([fitur(kind, D["X1"][tr], D["X4"][tr], X6[tr]), fitur(kind, GL["X1"], GL["X4"], GL["X6"])])
        ms = [lgb.LGBMClassifier(**VG.P1, n_jobs=VG.THREADS, random_state=sd).fit(Xtr, ytr) for sd in VG.SEEDS]
        models[kind] = ms
        per = {}
        for dn, dv in dev.items():
            s = M5.skor(ms, fitur(kind, dv["X1"], dv["X4"], dv["X6"]))
            t = VG.ambang_fpr(s[dv["y"] == 0], 0.01)
            per[dn] = {"recall": round(float((s[dv["y"] == 1] > t).mean()), 4), "auprc": round(float(average_precision_score(dv["y"], s)), 4)}
        hasil[kind] = {"per_dev": per, "rata_recall": round(float(np.mean([v["recall"] for v in per.values()])), 4)}
        say(kind, json.dumps(hasil[kind]))
    pilih = "L2" if hasil["L2"]["rata_recall"] - hasil["L1"]["rata_recall"] >= 0.01 else "L1"
    ms = models[pilih]
    s_all = np.concatenate([M5.skor(ms, fitur(pilih, dv["X1"], dv["X4"], dv["X6"])) for dv in dev.values()])
    y_all = np.concatenate([dv["y"] for dv in dev.values()])
    t_periksa, t_tahan = VG.ambang_fpr(s_all[y_all == 0], 0.01), VG.ambang_fpr(s_all[y_all == 0], 0.001)
    # overfit checks on the chosen candidate
    Xtr = np.vstack([fitur(pilih, D["X1"][tr], D["X4"][tr], X6[tr]), fitur(pilih, GL["X1"], GL["X4"], GL["X6"])])
    gtr = np.concatenate([D["peserta"][tr].astype(str), np.char.add("g2:", GL["peserta"].astype(str))])
    auc_in = float(average_precision_score(ytr, M5.skor(ms, Xtr)))
    oof = np.zeros(len(ytr))
    for a_, b_ in GroupKFold(n_splits=4).split(Xtr, ytr, gtr):
        oof[b_] = lgb.LGBMClassifier(**VG.P1, n_jobs=VG.THREADS, random_state=0).fit(Xtr[a_], ytr[a_]).predict_proba(Xtr[b_])[:, 1]
    auc_oof = float(average_precision_score(ytr, oof))
    gain = np.mean([m_.booster_.feature_importance("gain") for m_ in ms], axis=0); gain = gain / max(gain.sum(), 1e-12)
    names = list(joblib.load(HERE / "model_v3_bersih" / "model.joblib")["agg_names"]) + list(__import__("fitur_v4").NAMES) + (F6.NAMES if pilih == "L2" else [])
    blok = {"X1 klaim sendiri": float(gain[:124].sum()), "X1 tetangga graph": float(gain[124:624].sum()), "X4 mekanisme": float(gain[624:646].sum()),
            "X6 jaringan": float(gain[646:].sum())}
    top = [{"fitur": names[j], "porsi": round(float(gain[j]), 4)} for j in np.argsort(-gain)[:15]]
    x6_rank = [{"fitur": n, "porsi": round(float(g), 4)} for n, g in zip(F6.NAMES, gain[646:])] if pilih == "L2" else []
    peringatan = [w for w in ((f"selisih latih - CV {auc_in - auc_oof:.3f} > 0,10" if auc_in - auc_oof > 0.10 else None),
                              (f"satu fitur memegang {top[0]['porsi'] * 100:.0f}% gain" if top[0]["porsi"] > 0.30 else None)) if w]
    cek = {"auprc_latih_insample": round(auc_in, 4), "auprc_latih_oof_per_peserta": round(auc_oof, 4), "selisih_insample_oof": round(auc_in - auc_oof, 4),
           "porsi_gain_blok": {k: round(v, 4) for k, v in blok.items()}, "fitur_teratas": top, "fitur_x6": x6_rank, "peringatan": peringatan}
    say("cek overfit", json.dumps(cek, ensure_ascii=False)[:700])
    MODEL.mkdir(exist_ok=True)
    joblib.dump({"kind": pilih, "models": ms, "ambang_periksa": t_periksa, "ambang_tahan": t_tahan}, MODEL / "model.joblib")
    # L2 kept for an EXPLORATORY look at the benchmark (the user asked whether the network features help on generators 1-3);
    # its thresholds come from the same dev normals; it does not change the frozen choice
    m2 = models["L2"]
    s2 = np.concatenate([M5.skor(m2, fitur("L2", dv["X1"], dv["X4"], dv["X6"])) for dv in dev.values()])
    g2 = np.mean([m_.booster_.feature_importance("gain") for m_ in m2], axis=0); g2 = g2 / max(g2.sum(), 1e-12)
    joblib.dump({"kind": "L2", "models": m2, "ambang_periksa": VG.ambang_fpr(s2[y_all == 0], 0.01), "ambang_tahan": VG.ambang_fpr(s2[y_all == 0], 0.001)},
                MODEL / "model_l2_eksplorasi.joblib")
    cek["l2_porsi_gain_x6"] = round(float(g2[646:].sum()), 4)
    cek["l2_fitur_x6"] = [{"fitur": n, "porsi": round(float(g), 4)} for n, g in zip(F6.NAMES, g2[646:])]
    kartu = {"dibekukan": time.strftime("%Y-%m-%d %H:%M"), "kriteria": "testing/kriteria_ml_v6.json", "kandidat": hasil, "pilihan": pilih,
             "ambang_periksa": t_periksa, "ambang_tahan": t_tahan, "kolom": int(Xtr.shape[1]), "cek_overfit": cek,
             "latih": {"klaim": int(len(ytr)), "fraud": int(ytr.sum())}}
    (MODEL / "kartu.json").write_text(json.dumps(kartu, ensure_ascii=False, indent=1), "utf-8")
    say("DIBEKUKAN", pilih)


def benchmark() -> None:
    import joblib
    from sklearn.metrics import average_precision_score

    tanda = MODEL / "benchmark_sekali.txt"
    assert (MODEL / "kartu.json").exists(), "latih dulu"
    assert not tanda.exists(), "benchmark ML v6 sudah dijalankan: generator 3 seed baru hanya dinilai sekali"
    ci = _ci_skor()
    K = json.loads((MODEL / "kartu.json").read_text("utf-8"))
    b6, b5, b4 = joblib.load(MODEL / "model.joblib"), joblib.load(M5.MODEL / "model.joblib"), joblib.load(V4.MODEL / "model.joblib")
    bl2 = joblib.load(MODEL / "model_l2_eksplorasi.joblib")
    m3 = {"v3_lama": joblib.load(HERE / "model_v3" / "model.joblib"), "v3_bersih": joblib.load(HERE / "model_v3_bersih" / "model.joblib")}
    S = np.load(VG.STREAM, allow_pickle=False)
    F = F6.Fitur6({"peserta": S["peserta"], "faskes": S["faskes"], "tgl": S["tgl"], "skor": S["X1"][:, ci]})
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "kartu": K, "set": {}}
    for nama, d in UJI.items():
        U = M5.muat_set(d)
        y, seg, g = U["y"], U["pertama"], U["grup"]
        X6 = x6_set(F, U, ci)
        sc, fl = {}, {}
        for k, bb in m3.items():
            r = A.skor(bb, U["X1"], U["X2"], U["XR"])
            sc[k], fl[k] = np.asarray(r["cal"], float), np.asarray(r["flag"], bool)
        sc["v4"] = M5.skor(b4["models"], V4.fitur("B", U["X1"], U["X4"])); fl["v4"] = sc["v4"] > b4["ambang_periksa"]
        sc["ml_v5"] = M5.skor(b5["models"], np.hstack([U["X1"], U["X4"]]).astype(np.float32)); fl["ml_v5"] = M5.tandai(sc["ml_v5"], seg, b5["ambang_periksa"])
        sc["ml_v6"] = M5.skor(b6["models"], fitur(b6["kind"], U["X1"], U["X4"], X6)); fl["ml_v6"] = sc["ml_v6"] > b6["ambang_periksa"]
        sc["l2_jaringan"] = M5.skor(bl2["models"], fitur("L2", U["X1"], U["X4"], X6)); fl["l2_jaringan"] = sc["l2_jaringan"] > bl2["ambang_periksa"]
        nrm = y == 0
        model = {}
        for k in ("v3_lama", "v3_bersih", "v4", "ml_v5", "ml_v6", "l2_jaringan"):
            f = fl[k]
            f1 = sc[k] > np.quantile(sc[k][nrm], 0.99)
            model[k] = {**RT.ukur(y, f), "auprc": round(float(average_precision_score(y, sc[k])), 4),
                        "fpr_kunjungan_pertama": round(float(f[nrm & seg].mean()), 5), "fpr_pasien_lama": round(float(f[nrm & ~seg].mean()), 5),
                        "fpr1_pembanding": {"recall": round(float(f1[y == 1].mean()), 4), "presisi_mentah": round(float(y[f1].mean()), 4)},
                        "per_skema": VG.recall_per_skema(U["sk"][y == 1], f[y == 1])}
        out["set"][nama] = {"label": LABEL_UJI[nama], "klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 5), "model": model,
                            "ci_ml_v6_vs_ml_v5": RT.boot_selisih(y, fl["ml_v5"], fl["ml_v6"], g), "ci_ml_v6_vs_v4": RT.boot_selisih(y, fl["v4"], fl["ml_v6"], g),
                            "ci_l2_vs_ml_v5": RT.boot_selisih(y, fl["ml_v5"], fl["l2_jaringan"], g)}
        say(nama, {k: (model[k]["recall"], model[k]["fpr"], model[k]["presisi_prev2"], model[k]["auprc"]) for k in model})
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    tanda.write_text(time.strftime("%Y-%m-%d %H:%M"), "utf-8")
    say("ditulis", OUT)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["latih", "benchmark"])
    a = ap.parse_args()
    VG.LOCK_NAMA = f"ml-v6-{a.perintah}"
    with VG.kunci_berat():
        latih() if a.perintah == "latih" else benchmark()
