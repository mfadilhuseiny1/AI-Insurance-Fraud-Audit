"""Generator 1 report (the user, 2026-11-13: "kasih report aja buat Gen 1"; the problem scope: data whose distribution is close to
the BPJS sample, not yet tested on other distributions). Descriptive only, on test C2 (generator 1, members never in training,
never used to choose anything): every frozen model at its own frozen threshold. Nothing is tuned here.
-> data/aip/ml/sistem_terbaru/gen1_report.json and docs/laporan_gen1.html (template testing/laporan_gen1.html). Synthetic data only."""
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
import arsitektur_v2 as A  # noqa: E402
import diagnosa_shift as DS  # noqa: E402
import ml_v5 as M  # noqa: E402
import v4_final as V4  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

OUT = M.ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "gen1_report.json"
HTML = M.ROOT / "docs" / "laporan_gen1.html"
PREV = [0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.10]


def boot(y, f, g, B=1000, seed=0) -> dict:
    """Member-level bootstrap CIs of recall, FPR and precision at 2% fraud."""
    rng = np.random.default_rng(seed)
    ug, inv = np.unique(g, return_inverse=True)
    tp = np.bincount(inv, weights=(f & (y == 1)).astype(float), minlength=len(ug)); P = np.bincount(inv, weights=(y == 1).astype(float), minlength=len(ug))
    fp = np.bincount(inv, weights=(f & (y == 0)).astype(float), minlength=len(ug)); N = np.bincount(inv, weights=(y == 0).astype(float), minlength=len(ug))
    rs, fs, ps = [], [], []
    for _ in range(B):
        w = np.bincount(rng.integers(0, len(ug), len(ug)), minlength=len(ug))
        r = (w * tp).sum() / max(1e-9, (w * P).sum()); fr = (w * fp).sum() / max(1e-9, (w * N).sum())
        rs.append(r); fs.append(fr); ps.append(0.02 * r / max(1e-12, 0.02 * r + 0.98 * fr))
    q = lambda a: [round(float(np.quantile(a, 0.025)), 4), round(float(np.quantile(a, 0.975)), 4)]
    return {"recall": q(rs), "fpr": q(fs), "prec2": q(ps)}


def main() -> None:
    import joblib
    from sklearn.metrics import average_precision_score, roc_auc_score

    U = M.muat_set(M.TMP / "uji100k_c2")
    y, g, sk = U["y"], U["grup"], U["sk"].astype(str)
    X = M.fitur("K1", U["X1"], U["X4"], None)
    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    b4 = joblib.load(V4.MODEL / "model.joblib")
    b5 = joblib.load(M.MODEL / "model.joblib")
    b7 = joblib.load(HERE / "model_ml_v7" / "model.joblib")
    k7 = b7["kandidat"][b7["pilihan"]]
    sc, fl, th = {}, {}, {}
    r = A.skor(b3, U["X1"], U["X2"], U["XR"])
    sc["v3"], fl["v3"] = np.asarray(r["cal"], float), np.asarray(r["flag"], bool)
    sc["v4"] = M.skor(b4["models"], V4.fitur("B", U["X1"], U["X4"]))
    fl["v4"], th["v4"] = sc["v4"] > b4["ambang_periksa"], float(b4["ambang_periksa"])
    t4 = b4["ambang_tahan"]["global"] if isinstance(b4["ambang_tahan"], dict) else b4["ambang_tahan"]
    sc["ml_v5"] = M.skor(b5["models"], X)
    fl["ml_v5"], th["ml_v5"] = sc["ml_v5"] > b5["ambang_periksa"]["global"], float(b5["ambang_periksa"]["global"])
    sc["ml_v7"] = M.skor(k7["models"], X)
    fl["ml_v7"], th["ml_v7"] = sc["ml_v7"] > k7["ambang_periksa"], float(k7["ambang_periksa"])
    out: dict = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "data_sintetis_saja": True, "set": "test C2 (generator 1)",
                 "klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 4), "peserta": int(len(np.unique(g))),
                 "skema_n": int(len(np.unique(sk[y == 1]))), "model": {}}
    nrm = y == 0
    for k in ("v3", "v4", "ml_v5", "ml_v7"):
        f = fl[k]
        tp, fp, fn, tn = int((f & (y == 1)).sum()), int((f & nrm).sum()), int((~f & (y == 1)).sum()), int((~f & nrm).sum())
        rec, fpr = tp / (tp + fn), fp / (fp + tn)
        out["model"][k] = {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "recall": round(rec, 4), "fpr": round(fpr, 5),
                           "presisi_mentah": round(tp / max(1, tp + fp), 4),
                           "presisi_prev": {str(p): round(p * rec / max(1e-12, p * rec + (1 - p) * fpr), 4) for p in PREV},
                           "auprc": round(float(average_precision_score(y, sc[k])), 4), "auroc": round(float(roc_auc_score(y, sc[k])), 4),
                           "ci": boot(y, f, g),
                           # comparison mode: every model at FPR exactly 1% on the test normals (descriptive only, nothing chosen)
                           "recall_fpr1": round(float((sc[k][y == 1] > np.quantile(sc[k][nrm], 0.99)).mean()), 4),
                           "fpr_pertama": round(float(f[nrm & U["pertama"]].mean()), 5), "fpr_lama": round(float(f[nrm & ~U["pertama"]].mean()), 5),
                           "per_skema": {s: round(float(f[sk == s].mean()), 4) for s in np.unique(sk[y == 1])}}
    out["skema"] = {s: {"n": int((sk == s).sum()), "famili": DS.SK2FAM.get(s, "lain")} for s in np.unique(sk[y == 1])}
    # two tiers of v4: TAHAN (very high score) and PERIKSA
    ft = sc["v4"] > t4
    out["v4_tahan"] = {"ditandai": int(ft.sum()), "tp": int((ft & (y == 1)).sum()), "recall": round(float(ft[y == 1].mean()), 4),
                       "fpr": round(float(ft[nrm].mean()), 5), "presisi_mentah": round(float(y[ft].mean()), 4) if ft.any() else None}
    bins = np.linspace(0, 1, 21)
    out["hist"] = {"normal": np.round(np.histogram(sc["v4"][nrm], bins)[0] / nrm.sum(), 5).tolist(),
                   "fraud": np.round(np.histogram(sc["v4"][y == 1], bins)[0] / (y == 1).sum(), 5).tolist(), "ambang": th["v4"], "tahan": float(t4)}
    v4k = json.loads((V4.MODEL / "kartu.json").read_text("utf-8")) if (V4.MODEL / "kartu.json").exists() else {}
    out["v4_latih"] = {k: v4k.get(k) for k in ("dibekukan", "latih", "validasi") if k in v4k}
    # the AI agent swarm as a filter on generator 1's validation set (testing/v5.py): it did not add recall on this distribution
    g5 = json.loads((M.ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "arsitektur_graf.json").read_text("utf-8"))["v5"]["model"]["validasi"]
    out["swarm_validasi"] = {k: {kk: g5[k][kk] for kk in ("recall", "fpr", "presisi_prev2")} for k in ("v4_B", "v5")}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    tpl = (HERE / "laporan_gen1.html").read_text("utf-8") if (HERE / "laporan_gen1.html").exists() else None
    if tpl:
        HTML.write_text(tpl.replace("/*DATA*/null", json.dumps(out, ensure_ascii=False, separators=(",", ":"))), "utf-8")
    print(json.dumps({k: {kk: v[kk] for kk in ("recall", "fpr", "auprc", "tp", "fp", "fn", "ci")} for k, v in out["model"].items()}, ensure_ascii=False))
    print("tahan", out["v4_tahan"], "v4 kartu keys", list(v4k.keys())[:15])


if __name__ == "__main__":
    main()
