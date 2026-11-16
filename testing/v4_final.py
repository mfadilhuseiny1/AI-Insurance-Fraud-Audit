"""v4 final assembly and the ONE scoring of the final tests (plan of 2026-11-12; rules in testing/kriteria_v4.json).

  latih   the winning variant (B = X1 + X4, or C = B + the hospital layer if --varian C), LightGBM with v3's Model 1 parameters, 3 seeds
          averaged, trained on the stream + data_v4 chunks 0–7; the v4 rules chosen on validation (.tmp/data_v4/aturan_v4.json) plus
          v3's rule route and network rule as the review route; the two-tier thresholds set on the validation normals (TAHAN: model
          score at FPR <= 0.1 %; PERIKSA: model score OR route, combined FPR <= 1 %); everything frozen in testing/model_v4.
  uji     loads the frozen bundle and scores the final tests once: generator 3 (headline), test C2, gen2 seed 3; with the frozen
          tiers, plus threshold-free AUPRC, per scheme, first visit vs returning, claims per member, member-level bootstrap CIs, and
          the cross-generator criteria K1–K5 (kriteria_langkah4.json) between generator 3 and test C2. v3 bersih and v3 are scored
          on the same claims for context. Output: data/aip/ml/sistem_terbaru/v4_final.json.
Synthetic data only."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

os.environ.setdefault("BLUESANDAI_AUTH", "off")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
import arsitektur_v2 as A  # noqa: E402
import fitur_v4 as F4  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

TMP = ROOT / ".tmp"
MODEL = HERE / "model_v4"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "v4_final.json"
UJI = {"generator3": TMP / "gen3_uji", "uji_c2": TMP / "uji100k_c2", "gen2_seed3": TMP / "gen2_seed3"}
N_SYS = 124
# generator 3 labels premature discharge alone as a quality deviation ("mutu"), not fraud: those claims are left out of the fraud and
# normal counts and their flag rate is reported apart
MUTU = {"pulang_dini"}
KOL_DERAJAT_PESERTA = 5 * N_SYS  # X1: log1p(number of earlier claims of the member), capped at 10


def rute(b: dict, X1: np.ndarray, XR: np.ndarray, X4: np.ndarray) -> np.ndarray:
    """The review route: v4 rules (X4 thresholds), v3's rule route (specific rule signals in X1) and v3's network rule (XR)."""
    f = np.zeros(len(X1), bool)
    for r in b["aturan_v4"]:
        f |= X4[:, F4.NAMES.index(r["fitur"])] >= r["ambang"]
    rr = b["rute_v3"]
    if rr.get("kolom"):
        f |= (X1[:, rr["kolom"]] > 0).any(1)
    rj = b["jaringan_v3"]
    if rj:
        f |= np.round(np.expm1(XR[:, rj["kolom"]])) >= rj["ambang"]
    return f


def fitur(varian: str, X1: np.ndarray, X4: np.ndarray, XRS: np.ndarray | None = None) -> np.ndarray:
    X = np.hstack([X1, X4]).astype(np.float32)
    return np.hstack([X, XRS]).astype(np.float32) if varian == "C" else X


def latih(varian: str) -> None:
    import joblib
    import lightgbm as lgb

    D = VG.muat_data()
    XRS = None
    if varian == "C":
        import fitur_rs_v4 as RS

        S = dict(np.load(VG.STREAM, allow_pickle=False))
        blok = [RS.matriks_rs(S)] + [RS.matriks_rs(S, dict(np.load(TMP / "data_v4" / f"fitur_{c:02d}.npz", allow_pickle=False))) for c in range(10)]
        XRS = np.vstack(blok).astype(np.float32)
    X = fitur(varian, D["X1"], D["X4"], XRS)
    tr, va = D["latih"], D["val"]
    models = [lgb.LGBMClassifier(**VG.P1, n_jobs=VG.THREADS, random_state=sd).fit(X[tr], D["y"][tr]) for sd in VG.SEEDS]
    s_val = np.mean([m.predict_proba(X[va])[:, 1] for m in models], axis=0)
    y_val = D["y"][va]
    # validation rows' XR (not in the evaluator's union): chunks 8–9 in file order
    XR_val = np.vstack([np.load(TMP / "data_v4" / f"fitur_{c:02d}.npz")["XR"] for c in VG.VALIDASI]).astype(np.float32)
    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    aturan = json.loads((TMP / "data_v4" / "aturan_v4.json").read_text("utf-8"))["dipilih"]
    b = {"varian": varian, "models": models, "aturan_v4": [{k: r[k] for k in ("aturan", "fitur", "ambang")} for r in aturan],
         "rute_v3": b3.get("rute_rule") or {}, "jaringan_v3": b3.get("rule_jaringan") or {}}
    nrm = y_val == 0
    # route components chosen on validation (greedy): a component stays only if, with the model threshold re-set so that the
    # combined FPR stays <= 1 %, it raises recall by >= 0.5 point (a rule that spends the FPR budget without catching more is dropped)
    X1v, X4v = D["X1"][va], D["X4"][va]
    komp = [(f"v4:{r['aturan']}", X4v[:, F4.NAMES.index(r["fitur"])] >= r["ambang"], ("v4", r)) for r in b["aturan_v4"]]
    for kol, nm in zip(b["rute_v3"].get("kolom") or [], b["rute_v3"].get("nama") or []):
        komp.append((f"v3rute:{nm}", X1v[:, kol] > 0, ("v3", kol)))
    if b["jaringan_v3"]:
        rj = b["jaringan_v3"]
        komp.append(("v3:network_rule", np.round(np.expm1(XR_val[:, rj["kolom"]])) >= rj["ambang"], ("jar", rj)))

    def recall_gabung(f_r: np.ndarray) -> tuple[float, float]:
        sisa_ = max(0.0, 0.01 - float(f_r[nrm].mean()))
        c_ = np.sort(s_val[nrm & ~f_r])[::-1]
        k_ = int(np.floor(sisa_ * nrm.sum()))
        t_ = float(c_[min(k_, len(c_) - 1)]) if len(c_) and k_ > 0 else float(c_[0]) if len(c_) else 1.0
        fl = (s_val > t_) | f_r
        return float(fl[~nrm].mean()), t_

    dipilih, f_cur = [], np.zeros(int(va.sum()), bool)
    r_cur, _ = recall_gabung(f_cur)
    jejak = [{"langkah": "model saja", "recall": round(r_cur, 4)}]
    while True:
        best = None
        for nm, fl, meta in komp:
            if nm in [d[0] for d in dipilih]:
                continue
            r_new, _ = recall_gabung(f_cur | fl)
            if r_new >= r_cur + 0.005 and (best is None or r_new > best[1]):
                best = (nm, r_new, fl, meta)
        if best is None:
            break
        dipilih.append((best[0], best[3])); f_cur = f_cur | best[2]; r_cur = best[1]
        jejak.append({"langkah": f"+ {best[0]}", "recall": round(r_cur, 4), "laju_normal_rute": round(float(f_cur[nrm].mean()), 5)})
    b["aturan_v4"] = [m[1] for _, m in dipilih if m[0] == "v4"]
    b["rute_v3"] = {"kolom": [m[1] for _, m in dipilih if m[0] == "v3"], "nama": [n[7:] for n, m in dipilih if m[0] == "v3"]}
    b["jaringan_v3"] = next((m[1] for _, m in dipilih if m[0] == "jar"), {})
    b["seleksi_rute"] = jejak
    f_rute = rute(b, X1v, XR_val, X4v)
    t_tahan = VG.ambang_fpr(s_val[nrm], 0.001)
    # PERIKSA: the model threshold such that (score > t) OR route stays at FPR <= 1 % on the validation normals
    laju_rute = float(f_rute[nrm].mean())
    sisa = max(0.0, 0.01 - laju_rute)
    cand = np.sort(s_val[nrm & ~f_rute])[::-1]
    k = int(np.floor(sisa * nrm.sum()))
    t_periksa = float(cand[min(k, len(cand) - 1)]) if len(cand) else 1.0
    periksa = (s_val > t_periksa) | f_rute
    tahan = s_val > t_tahan
    b.update(ambang_periksa=t_periksa, ambang_tahan=t_tahan, laju_rute_validasi=round(laju_rute, 5))
    MODEL.mkdir(exist_ok=True)
    joblib.dump(b, MODEL / "model.joblib")
    kartu = {"dibekukan": time.strftime("%Y-%m-%d %H:%M"), "varian": varian, "kolom": int(X.shape[1]), "seed": list(VG.SEEDS), "param": VG.P1,
             "latih": {"baris": int(tr.sum()), "fraud": int(D["y"][tr].sum())}, "aturan_v4": b["aturan_v4"],
             "rute_v3": b["rute_v3"].get("nama") or [], "jaringan_v3": b["jaringan_v3"], "seleksi_rute": b["seleksi_rute"], "ambang_periksa": t_periksa, "ambang_tahan": t_tahan,
             "validasi": {"periksa": {"recall": round(float(periksa[~nrm].mean()), 4), "fpr": round(float(periksa[nrm].mean()), 5),
                                      "rute_saja_fpr": round(laju_rute, 5), "rute_tambah_fraud": int((f_rute & ~(s_val > t_periksa) & ~nrm).sum())},
                          "tahan": {"recall": round(float(tahan[~nrm].mean()), 4), "fpr": round(float(tahan[nrm].mean()), 5)},
                          "nilai": VG.nilai(y_val, s_val, D["sk"][va], D["pertama"][va])}}
    (MODEL / "kartu.json").write_text(json.dumps(kartu, ensure_ascii=False, indent=1, default=float), "utf-8")
    print(json.dumps({k: kartu[k] for k in ("varian", "ambang_periksa", "ambang_tahan")}, default=float), json.dumps(kartu["validasi"]["periksa"]), json.dumps(kartu["validasi"]["tahan"]))


def muat_uji(d: Path) -> dict | None:
    fs = sorted(d.glob("hasil_[0-9][0-9].npz"))
    if not fs:
        return None
    ds = [np.load(f, allow_pickle=False) for f in fs]
    if "X4" not in ds[0].files:
        return None
    out = {k: np.concatenate([x[k] for x in ds]) for k in ("X1", "X2", "XR", "X4", "sk", "peserta")}
    out["chunk"] = np.concatenate([np.full(len(x["sk"]), i) for i, x in enumerate(ds)])
    out["sk"] = out["sk"].astype(str)
    out["raw"] = ds
    return out


def tier(y: np.ndarray, f: np.ndarray) -> dict:
    y = y.astype(bool)
    r, fpr = float(f[y].mean()), float(f[~y].mean())
    return {"recall": round(r, 4), "fpr": round(fpr, 5), "presisi_mentah": round(float(y[f].mean()) if f.any() else 0.0, 4),
            "presisi_prev": {str(p): round(VG.presisi_prevalensi(r, fpr, p), 4) for p in (0.005, 0.02, 0.05)}, "ditandai": int(f.sum())}


def boot_tier(y: np.ndarray, f: np.ndarray, grup: np.ndarray, B: int = 1000) -> dict:
    rng = np.random.default_rng(0)
    u, inv = np.unique(grup, return_inverse=True)
    idx = [np.flatnonzero(inv == i) for i in range(len(u))]
    rs, fs = [], []
    for _ in range(B):
        ii = np.concatenate([idx[i] for i in rng.integers(0, len(u), len(u))])
        yy, ff = y[ii].astype(bool), f[ii]
        rs.append(ff[yy].mean()); fs.append(ff[~yy].mean())
    q = lambda a: [round(float(np.percentile(a, 2.5)), 4), round(float(np.percentile(a, 97.5)), 5)]  # noqa: E731
    return {"recall": q(rs), "fpr": q(fs)}


def uji() -> None:
    import joblib

    b = joblib.load(MODEL / "model.joblib")
    kartu = json.loads((MODEL / "kartu.json").read_text("utf-8"))
    b3, bl = joblib.load(HERE / "model_v3_bersih" / "model.joblib"), joblib.load(HERE / "model_v3" / "model.joblib")
    hasil, ada = {}, {}
    for nama, d in UJI.items():
        U = muat_uji(d)
        if U is None:
            ada[nama] = "belum ada"
            continue
        XRS = None
        if b["varian"] == "C":
            import fitur_rs_v4 as RS

            S = dict(np.load(VG.STREAM, allow_pickle=False))
            XRS = np.vstack([RS.matriks_rs(S, {k: x[k] for k in x.files}) for x in U["raw"]]).astype(np.float32)
        mutu = np.isin(U["sk"], list(MUTU))
        if mutu.any():
            X_m = fitur(b["varian"], U["X1"][mutu], U["X4"][mutu], XRS[mutu] if XRS is not None else None)
            s_m = np.mean([m.predict_proba(X_m)[:, 1] for m in b["models"]], axis=0)
            f_m = (s_m > b["ambang_periksa"]) | rute(b, U["X1"][mutu], U["XR"][mutu], U["X4"][mutu])
            info_mutu = {"klaim": int(mutu.sum()), "ditandai_periksa": round(float(f_m.mean()), 4), "ditandai_tahan": round(float((s_m > b["ambang_tahan"]).mean()), 4)}
            keep = ~mutu
            U = {k: (v[keep] if isinstance(v, np.ndarray) and len(v) == len(keep) else v) for k, v in U.items()}
            if XRS is not None:
                XRS = XRS[keep]
        else:
            info_mutu = None
        X = fitur(b["varian"], U["X1"], U["X4"], XRS)
        s = np.mean([m.predict_proba(X)[:, 1] for m in b["models"]], axis=0)
        y = (~np.isin(U["sk"], A.NORMAL)).astype(int)
        f_rute = rute(b, U["X1"], U["XR"], U["X4"])
        periksa, tahan = (s > b["ambang_periksa"]) | f_rute, s > b["ambang_tahan"]
        col = U["X1"][:, list(b3["sys_names"]).index(VG.KOLOM_KUNJUNGAN)]
        nol = float(np.load(VG.STREAM, allow_pickle=False)["X1"][:, list(b3["sys_names"]).index(VG.KOLOM_KUNJUNGAN)].min())
        pertama = col <= nol + 1e-5
        n_pes = np.round(np.expm1(U["X1"][:, KOL_DERAJAT_PESERTA])).astype(int)
        grup = np.char.add(U["chunk"].astype(str), np.char.add(":", U["peserta"].astype(str)))
        nrm = y == 0
        ember = VG.ember_jumlah_klaim(n_pes)
        r = {"klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 5), "mutu_terpisah": info_mutu,
             "periksa": {**tier(y, periksa), "ci": boot_tier(y, periksa, grup), "target": "recall >= 80% pada FPR <= 1%",
                         "fpr_kunjungan_pertama": round(float(periksa[nrm & pertama].mean()), 5), "fpr_pasien_lama": round(float(periksa[nrm & ~pertama].mean()), 5),
                         "fpr_menurut_jumlah_klaim": {k: {"fpr": round(float(periksa[nrm & (ember == k)].mean()), 5), "n": int((nrm & (ember == k)).sum())}
                                                      for k in ("0", "1", "2-4", "5+") if (nrm & (ember == k)).any()},
                         "recall_per_skema": VG.recall_per_skema(U["sk"][y == 1], periksa[y == 1]), "rute_saja": tier(y, f_rute)},
             "tahan": {**tier(y, tahan), "ci": boot_tier(y, tahan, grup), "target": "FPR <= 0,1%, precision >= 90% pada fraud 2%"},
             "tanpa_ambang": {k: v for k, v in VG.nilai(y, s, U["sk"], pertama, n_pes).items() if k in ("auprc", "auroc")},
             "ambang_disetel_ulang_per_set_hanya_pembanding": {k: v for k, v in VG.nilai(y, s, U["sk"]).items() if k in ("recall_fpr1", "presisi_fpr1_prev", "recall_fpr01", "presisi_fpr01_prev2")}}
        # context: v3 bersih and v3 on the same claims (their own thresholds)
        for nm, bb in (("v3_bersih", b3), ("v3_lama", bl)):
            sc = A.skor(bb, U["X1"], U["X2"], U["XR"])
            r[nm] = tier(y, sc["flag"].astype(bool))
        hasil[nama] = r
        ada[nama] = "dinilai"
        print(nama, "periksa", r["periksa"]["recall"], r["periksa"]["fpr"], "tahan", r["tahan"]["recall"], r["tahan"]["fpr"], "auprc", r["tanpa_ambang"]["auprc"], flush=True)
    # cross-generator criteria (generator 3 vs test C2), kriteria_langkah4 thresholds
    krit = None
    if "generator3" in hasil and "uji_c2" in hasil:
        K = json.loads((HERE / "kriteria_langkah4.json").read_text("utf-8"))["kriteria"]
        g, c = hasil["generator3"]["periksa"], hasil["uji_c2"]["periksa"]
        w = lambda h: 0.2 * h["fpr_kunjungan_pertama"] + 0.8 * h["fpr_pasien_lama"]  # noqa: E731
        pc = hasil["uji_c2"]["prevalensi"]
        prec = lambda h: VG.presisi_prevalensi(h["recall"], w(h), pc)  # noqa: E731
        bersama = sorted(set(g["recall_per_skema"]) & set(c["recall_per_skema"]))
        nilai = {"K1_jalan_pintas": max(x["fpr_kunjungan_pertama"] / max(1e-9, x["fpr_pasien_lama"]) for x in (g, c)),
                 "K2_recall_antar_generator": abs(g["recall"] - c["recall"]) * 100,
                 "K3_fpr_antar_generator": max(w(g), w(c)) / max(1e-9, min(w(g), w(c))),
                 "K4_presisi_antar_generator": abs(prec(g) - prec(c)) * 100,
                 "K5_recall_skema_bersama": (abs(np.mean([g["recall_per_skema"][s] for s in bersama]) - np.mean([c["recall_per_skema"][s] for s in bersama])) * 100) if bersama else None}
        krit = []
        for k_, v in nilai.items():
            bt = (K[k_]["konsisten_sampai"], K[k_]["sebagian_sampai"])
            krit.append({"kunci": k_, "nilai": None if v is None else round(float(v), 3), "batas": list(bt),
                         "hasil": "tidak bisa dinilai (tidak ada skema bersama)" if v is None else ("konsisten" if v <= bt[0] else "sebagian" if v <= bt[1] else "tidak konsisten")})
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "model": kartu, "status_set": ada, "hasil": hasil, "kriteria_antar_generator": krit,
           "catatan": ["Ambang dan rule dibekukan di testing/model_v4 sebelum set uji mana pun dibaca; setiap set dinilai sekali",
                       "generator3 = angka utama di luar distribusi; uji_c2 dan gen2_seed3 pendukung (desain data_v4 dipengaruhi generator 2)",
                       "Varian D/E/F (GNN, hybrid, DL tabular) ditunda atas keputusan pengguna"]}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    print("written", OUT, ada)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["latih", "uji"])
    ap.add_argument("--varian", default="B", choices=["B", "C"])
    a = ap.parse_args()
    latih(a.varian) if a.perintah == "latih" else uji()
