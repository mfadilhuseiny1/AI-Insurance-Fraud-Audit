"""The evaluation report of the latest ML system for ML Studio ("Sistem ML terbaru"): aggregate numbers only, no claim rows.

Reads testing/model (model.joblib, kartu.json, evaluasi.json, oof.npz written by latih_model.py) and writes
data/aip/ml/sistem_terbaru/sistem.json, which the web serves at /api/ml-sistem:
- the system: Model 1 (graph + neighbours), Model 2 (hospital network), the stacker with isotonic calibration, the
  monotone network alert, the decision rule, the training data (simulator claims, clean plants, copy-built normals);
- out-of-fold metrics on the synthetic stream (5 time blocks): AUPRC, AUROC, precision/recall/FPR at the decision rule,
  the confusion matrix, the PR curves and precision@k of the combined score, Model 1 and Model 2, the score distribution;
- recall per fraud scheme with its Permenkes 16/2019 mode, out-of-fold and on the clean holdout;
- the three training variants (evaluasi.json) and the features Model 1 leans on most.
Synthetic data only. Usage: .venv/Scripts/python.exe testing/laporan_ml.py"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
os.environ.setdefault("BLUESANDAI_AUTH", "off")
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "sistem.json"
K_TABEL = [25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000]


def pr_kurva(y: np.ndarray, s: np.ndarray, titik: int = 120) -> list[list[float]]:
    """(recall, precision) along the ranking, thinned to about `titik` points (the steps kept where precision moves)."""
    o = np.argsort(-s, kind="stable")
    tp = np.cumsum(y[o]); k = np.arange(1, len(o) + 1)
    rec, pre = tp / max(1, y.sum()), tp / k
    idx = np.unique(np.concatenate([np.linspace(0, len(o) - 1, titik).astype(int), np.searchsorted(rec, np.linspace(0, 1, titik)).clip(0, len(o) - 1)]))
    return [[round(float(rec[i]), 4), round(float(pre[i]), 4)] for i in idx]


def presisi_k(y: np.ndarray, s: np.ndarray, ks: list[int]) -> dict[str, list]:
    o = np.argsort(-s, kind="stable")
    tp = np.cumsum(y[o])
    ks = [k for k in ks if k <= len(o)]
    return {"k": ks, "precision": [round(float(tp[k - 1] / k), 4) for k in ks], "recall": [round(float(tp[k - 1] / max(1, y.sum())), 4) for k in ks],
            "tp": [int(tp[k - 1]) for k in ks]}


def main() -> None:
    import joblib
    from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

    from aip.realtime import simulator as SIM
    import penjelas as PJ

    m = joblib.load(HERE / "model" / "model.joblib")
    kartu = json.loads((HERE / "model" / "kartu.json").read_text("utf-8"))
    evaluasi = json.loads((HERE / "model" / "evaluasi.json").read_text("utf-8")) if (HERE / "model" / "evaluasi.json").exists() else {}
    d = np.load(HERE / "model" / "oof.npz", allow_pickle=False)
    y, sk, sim = d["y"].astype(int), d["sk"], d["sim"].astype(bool)
    os_, cal, o1, o2, om, thr = d["os"], d["cal"], d["o1"], d["o2"], d["om"], float(d["thr_mono"])
    flag = (cal >= kartu["ambang_peluang"]) | (om > thr)

    # the synthetic stream (the simulator's claims, its own fraud rate) for the curves; the clean plants are reported apart
    ys, ss, s1, s2, cs, fs = y[sim], os_[sim], o1[sim], o2[sim], cal[sim], flag[sim]
    tp = int((fs & (ys == 1)).sum()); fp = int((fs & (ys == 0)).sum()); fn = int((~fs & (ys == 1)).sum()); tn = int((~fs & (ys == 0)).sum())
    ks = sorted(set([10, 20] + list(range(25, 3001, 25))))
    curve = {nama: presisi_k(ys, s, ks) for nama, s in (("gabungan", ss), ("model1", s1), ("model2", s2))}
    tabel = {nama: presisi_k(ys, s, K_TABEL) for nama, s in (("gabungan", ss), ("model1", s1), ("model2", s2))}
    bins = np.linspace(0, 1, 21)
    hist = {"batas": [round(float(b), 2) for b in bins], "normal": np.histogram(cs[ys == 0], bins)[0].tolist(), "fraud": np.histogram(cs[ys == 1], bins)[0].tolist()}

    # recall per scheme: out-of-fold (simulator plants) and the clean holdout (generator plants never trained on)
    modes, _ = PJ._modes()
    daftar = PJ.modus_daftar()

    def modus_of(s: str) -> list[dict]:
        ms = (SIM.SCENARIOS.get(s) or ("", [], set()))[1]
        return [{"kode": ("M07" if x == "M19" else x), "nama": daftar.get("M07" if x == "M19" else x, x)} for x in ms]

    per = kartu.get("oof_per_skenario") or {}
    bersih = kartu.get("holdout_bersih_per_skenario") or {}
    skema = []
    for s, v in sorted(per.items(), key=lambda kv: -kv[1]["n"]):
        if s in ("normal", "aug:normal") or s.startswith("aug:"):
            continue
        skema.append({"skema": s, "label": (SIM.SCENARIOS.get(s) or (s,))[0], "modus": modus_of(s), "n_oof": v["n"], "recall_oof": v["ditandai"],
                      "n_bersih": (bersih.get(s) or {}).get("n"), "recall_bersih": (bersih.get(s) or {}).get("ditandai")})
    # Model 1's features by gain, in readable names (no internal codes)
    gain = m["m1"].booster_.feature_importance("gain")
    names = m["agg_names"]
    top = np.argsort(-gain)[:15]
    tot = float(gain.sum()) or 1.0
    fitur = [{"fitur": PJ.ganti_kode(PJ._nama_fitur(names[i])), "gain_pct": round(100 * float(gain[i]) / tot, 2)} for i in top]
    g2 = m["m2"].booster_.feature_importance("gain")
    n2 = [f"{a} ±{w} hari" for w in (3, 7, 14) for a in ("peserta lain berbagi RS (log)", "total peserta berbagi (log)", "RS lain dikunjungi")] + ["rawat inap"]
    fitur2 = sorted([{"fitur": n2[i], "gain_pct": round(100 * float(g2[i]) / (float(g2.sum()) or 1), 2)} for i in range(len(n2))], key=lambda r: -r["gain_pct"])[:8]

    # precision at other fraud rates, each method at its own operating point: TPR·π / (TPR·π + FPR·(1−π)) (the stream's
    # rate is the measured point; the others reweight the normal claims, as in the research report)
    p0 = float(ys.mean())
    nflag = int(fs.sum())

    def titik_kerja(flagged: np.ndarray, yy: np.ndarray) -> dict:
        tpr = float((flagged & (yy == 1)).sum() / max(1, (yy == 1).sum()))
        fpr = float((flagged & (yy == 0)).sum() / max(1, (yy == 0).sum()))
        return {"tpr": round(tpr, 4), "fpr": round(fpr, 6), "ditandai": int(flagged.sum()), "tp": int((flagged & (yy == 1)).sum()), "fp": int((flagged & (yy == 0)).sum())}

    def top(s: np.ndarray, k: int) -> np.ndarray:
        f = np.zeros(len(s), bool); f[np.argsort(-s, kind="stable")[:k]] = True
        return f

    metode = [("Model 1 + 2 (sistem sekarang)", titik_kerja(fs, ys), "utama"),
              ("Model 1 saja (graph + tetangga)", titik_kerja(top(s1, nflag), ys), ""),
              ("Model 2 saja (jaringan RS)", titik_kerja(top(s2, nflag), ys), ""),
              ("Rule saja (tanpa label)", titik_kerja(d["tahan"][sim].astype(bool), ys), "garis")]
    lama = HERE / "model_tanpa_aug" / "oof.npz"
    if lama.exists():
        dl = np.load(lama, allow_pickle=False)
        sl = dl["sim"].astype(bool)
        if int(sl.sum()) == len(ys) and np.array_equal(dl["y"][sl].astype(int), ys):
            kl = json.loads((HERE / "model_tanpa_aug" / "kartu.json").read_text("utf-8"))
            fl = ((dl["cal"] >= kl["ambang_peluang"]) | (dl["om"] > float(dl["thr_mono"])))[sl]
            metode.append(("Sistem lama (latih simulator saja)", titik_kerja(fl, ys), "lama"))
    tingkat = sorted({0.001, 0.002, 0.005, 0.01, 0.02, round(p0, 4), 0.05, 0.1, 0.2})

    def kurva(ms_: list) -> list:
        return [{"nama": n, "gaya": g, **tk, "precision": [round(tk["tpr"] * p / max(1e-12, tk["tpr"] * p + tk["fpr"] * (1 - p)), 4) for p in tingkat]}
                for n, tk, g in ms_]

    # a second operating point, as the research report measured it: a review budget of the top 2 % of claims per method
    kb = int(round(0.02 * len(ys)))
    anggaran = [("Model 1 + 2 (sistem sekarang)", titik_kerja(top(ss, kb), ys), "utama"), ("Model 1 saja (graph + tetangga)", titik_kerja(top(s1, kb), ys), ""),
                ("Model 2 saja (jaringan RS)", titik_kerja(top(s2, kb), ys), ""), metode[3]]
    if len(metode) > 4:
        anggaran.append(("Sistem lama (latih simulator saja)", titik_kerja(top(dl["os"][sl], kb), ys), "lama"))
    prevalensi = {"tingkat": tingkat, "aliran": round(p0, 4), "anggaran_k": kb,
                  "titik": {"keputusan": {"label": "Aturan keputusan (peluang ≥ 50% atau alert)", "metode": kurva(metode)},
                            "anggaran": {"label": f"Anggaran review 2% teratas ({kb:,} klaim)".replace(",", "."), "metode": kurva(anggaran)}}}

    # the overfitting check: in-sample against out-of-fold, and the five time blocks one by one
    ins, ins1, ins2 = d["ins"][sim], d["ins1"][sim], d["ins2"][sim]
    fold_s = d["fold"][sim]
    overfit = {
        "train_vs_oof": [{"model": n, "train": round(float(average_precision_score(ys, a)), 4), "oof": round(float(average_precision_score(ys, b)), 4)}
                         for n, a, b in (("Model 1 + 2", ins, ss), ("Model 1", ins1, s1), ("Model 2", ins2, s2))],
        "per_blok": [{"blok": int(b) + 1, "klaim": int((fold_s == b).sum()), "fraud": int(ys[fold_s == b].sum()),
                      "auprc": round(float(average_precision_score(ys[fold_s == b], ss[fold_s == b])), 4) if ys[fold_s == b].sum() else None,
                      "precision": round(float((fs & (ys == 1))[fold_s == b].sum() / max(1, fs[fold_s == b].sum())), 4),
                      "recall": round(float((fs & (ys == 1))[fold_s == b].sum() / max(1, ys[fold_s == b].sum())), 4)} for b in sorted(set(fold_s.tolist()))],
    }

    out = {
        "dibuat": time.strftime("%Y-%m-%d %H:%M"),
        "prevalensi": prevalensi, "overfit": overfit,
        "dilatih": kartu.get("dilatih"),
        "sistem": {
            "nama": "Sistem deteksi fraud FKRTL · Model 1 + Model 2",
            "keputusan": f"Terdeteksi bila peluang terkalibrasi ≥ {kartu['ambang_peluang']:.0%} atau alert jaringan RS aktif",
            "ambang_peluang": kartu["ambang_peluang"], "ambang_alert": round(thr, 4),
            "komponen": [
                {"kunci": "masukan", "nama": "Klaim + entity resolution", "detail": "Pasien dicocokkan lewat no RM, nama, dan SEP; klaim masuk ke engine realtime."},
                {"kunci": "engine", "nama": "Engine realtime", "detail": "Pemeriksaan otomatis (rule, 20 modus Permenkes) memberi 54 fitur (44 sinyal rule); ditambah 70 field klaim yang diskalakan dengan persiapan data VIME menjadi 124 fitur sistem per klaim. Embedding dan skor anomaly VIME tidak dipakai model."},
                {"kunci": "model1", "nama": "Model 1 · graph + tetangga", "detail": "LightGBM (300 pohon, 15 daun) pada 624 fitur: fitur sistem klaim + rata-rata klaim tetangga di 4 relasi graph (peserta, RS, RS+kode, kode)."},
                {"kunci": "model2", "nama": "Model 2 · jaringan RS", "detail": "LightGBM kecil (7 daun) pada 10 fitur jaringan: peserta lain yang berbagi RS dalam ±3/7/14 hari; dilatih dengan ring acak."},
                {"kunci": "stacker", "nama": "Stacker + kalibrasi", "detail": "LightGBM kecil menggabungkan logit Model 1 dan Model 2, lalu isotonic regression menjadi peluang."},
                {"kunci": "alert", "nama": "Alert jaringan RS", "detail": f"LightGBM monoton pada peserta berbagi ±3–60 hari; ambang = persentil 99,9 klaim normal ({thr:.3f})."},
                {"kunci": "keputusan", "nama": "Keputusan + penjelasan AI", "detail": "Terdeteksi → AI menjelaskan jenis fraud (Permenkes), alasan, graph, dan perbaikan; lolos → “Klaim aman”."},
            ],
            "data_latih": {"klaim": kartu["klaim_latih"], "fraud": kartu["fraud_latih"], "plant_bersih": kartu.get("plant_bersih_latih"),
                           "aliran_simulator": int(sim.sum()), "fraud_aliran": int(ys.sum()), "normal_salinan": int((sk == "aug:normal").sum()),
                           "holdout_plant_bersih": kartu.get("plant_bersih_holdout"), "holdout_normal_salinan": kartu.get("holdout_normal_bersih_n")},
        },
        "metrik": {
            "auprc": round(float(average_precision_score(ys, ss)), 4), "auroc": round(float(roc_auc_score(ys, ss)), 4),
            "auprc_model1": round(float(average_precision_score(ys, s1)), 4), "auprc_model2": round(float(average_precision_score(ys, s2)), 4),
            "brier": round(float(brier_score_loss(ys, np.clip(cs, 0, 1))), 5),
            "precision": round(tp / max(1, tp + fp), 4), "recall": round(tp / max(1, tp + fn), 4), "fpr_normal": round(fp / max(1, fp + tn), 5),
            "f1": round(2 * tp / max(1, 2 * tp + fp + fn), 4), "basis": round(float(ys.mean()), 4),
            "recall_plant_bersih": kartu.get("holdout_bersih_recall"), "fpr_normal_salinan": kartu.get("holdout_normal_bersih_fpr"),
            "auprc_semua_oof": round(kartu.get("oof_auprc", 0), 4),
        },
        "cm": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "pr": {"gabungan": pr_kurva(ys, ss), "model1": pr_kurva(ys, s1), "model2": pr_kurva(ys, s2), "basis": round(float(ys.mean()), 4)},
        "presisi_k": curve, "presisi_k_tabel": tabel,
        "distribusi": hist,
        "skema": skema,
        "varian": [{"kunci": k, **{kk: v.get(kk) for kk in ("oof_auprc", "oof_ditandai_precision", "oof_ditandai_recall", "oof_fpr_normal", "holdout_bersih_recall",
                                                               "holdout_normal_bersih_fpr", "holdout_plant_simulator_recall")}} for k, v in (evaluasi.get("varian") or {}).items()],
        "fitur_model1": fitur, "fitur_model2": fitur2,
        "catatan": [
            "Evaluasi out-of-fold: 5 blok waktu berurutan pada aliran sintetis FKRTL; tiap klaim dinilai model yang tidak melihatnya saat dilatih.",
            "Plant bersih: skema fraud satu klaim pada pasien dengan riwayat wajar, dibuat lewat engine realtime; 30% tidak pernah dilatih (holdout).",
            "Normal salinan: klaim wajar yang dibuat dengan cara yang sama (salinan klaim yang ada), agar 'mirip klaim lain' sendirian bukan tanda fraud.",
            "Plant simulator selalu jatuh pada peserta yang di hari yang sama baru klaim di RS lain (sidik jari simulator); karena itu sistem juga dilatih dengan plant bersih.",
            "Data sintetis; angka ini mengukur sistem pada data sintetis, bukan kinerja pada klaim BPJS sungguhan.",
        ],
    }
    # the test on 100.000 claims outside the training data (testing/uji100k.py), shown as it came out
    u = OUT.parent / "uji_100k.json"
    if u.exists():
        out["uji_100k"] = json.loads(u.read_text("utf-8"))
    # architecture v2 (rule-aware), on the same 100.000 claims (testing/laporan_v2.py)
    v2 = OUT.parent / "arsitektur_v2.json"
    if v2.exists():
        out["arsitektur_v2"] = json.loads(v2.read_text("utf-8"))
    v3 = OUT.parent / "arsitektur_v3.json"  # architecture v3 (testing/laporan_v3.py), on the fresh test B
    if v3.exists():
        out["arsitektur_v3"] = json.loads(v3.read_text("utf-8"))
    g2 = OUT.parent / "generator2.json"  # v3 on generator 2's claims (testing/laporan_gen2.py)
    if g2.exists():
        out["generator2"] = json.loads(g2.read_text("utf-8"))
    g2n = OUT.parent / "generator2_node.json"  # each v3 node on generator 2 and test B (testing/node_gen2.py)
    if g2n.exists():
        out["generator2_node"] = json.loads(g2n.read_text("utf-8"))
    v4f = OUT.parent / "v4_final.json"  # v4 frozen on validation, scored once on the final tests (testing/v4_final.py)
    if v4f.exists():
        out["v4_final"] = json.loads(v4f.read_text("utf-8"))
    ag = OUT.parent / "arsitektur_graf.json"  # every v4 variant incl. graph / DL, and the graph variants on generator 3 (testing/laporan_graf.py)
    if ag.exists():
        out["arsitektur_graf"] = json.loads(ag.read_text("utf-8"))
    pv3 = OUT.parent / "perbaikan_v3.json"  # the retrained v3 on test C and generator 2 (new seed) (testing/laporan_perbaikan.py)
    if pv3.exists():
        out["perbaikan_v3"] = json.loads(pv3.read_text("utf-8"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False), "utf-8")
    print("written", OUT, f"{OUT.stat().st_size / 1e3:.0f} KB · AUPRC {out['metrik']['auprc']} · precision {out['metrik']['precision']} · recall {out['metrik']['recall']}")
    print("precision@k:", {k: p for k, p in zip(tabel['gabungan']['k'], tabel['gabungan']['precision'])})


if __name__ == "__main__":
    main()
