"""ML v5 (Lapis 1 of the audit): candidates trained on generator 1 + generator 2, chosen on two dev sets, frozen, then the
benchmark against v3 (old and clean) and v4 on generator 1, 2 and 3. Plan and rules fixed first in testing/kriteria_ml_v5.json.

  latih       train K1 (v4 features) and K2 (+ X5, testing/fitur_v5.py), LightGBM x 3 seeds with v3's Model 1 parameters, on
              stream + data_v4 chunks 0-7 + generator 2 (members "latih", .tmp/gen2_ml5_latih); dev = data_v4 chunks 8-9 +
              generator 2 (members "validasi", .tmp/gen2_ml5_dev); thresholds global or per segment (first visit vs returning);
              pick by the mean dev recall at FPR 1%; freeze in testing/model_ml_v5.
  benchmark   generator 1 = test C2, generator 2 = gen2 seed 3 (both seen before, never used to choose), generator 3 = a NEW
              seed (GEN3_GARAM=gen3-ml5, .tmp/gen3_ml5), scored once -> data/aip/ml/sistem_terbaru/ml_v5_benchmark.json
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
import fitur_v5 as F5  # noqa: E402
import v4_final as V4  # noqa: E402
import v4_rule_tambah as RT  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

TMP = ROOT / ".tmp"
MODEL = HERE / "model_ml_v5"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "ml_v5_benchmark.json"
G2_LATIH, G2_DEV = TMP / "gen2_ml5_latih", TMP / "gen2_ml5_dev"
UJI = {"generator1": TMP / "uji100k_c2", "generator2": TMP / "gen2_seed3", "generator3": TMP / "gen3_ml5"}
LABEL_UJI = {"generator1": "Generator 1 · test C2 (dipakai ulang, bukan untuk memilih)", "generator2": "Generator 2 · seed 3 (dipakai ulang, bukan untuk memilih)",
             "generator3": "Generator 3 · seed baru gen3-ml5 (data asing, dinilai sekali)"}
KRIT = json.loads((HERE / "kriteria_ml_v5.json").read_text("utf-8"))


def say(*a) -> None:
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def _kol_kunjungan() -> tuple[int, float]:
    import joblib

    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    ci = list(b3["sys_names"]).index(VG.KOLOM_KUNJUNGAN)
    nol = float(np.load(VG.STREAM, allow_pickle=False)["X1"][:, ci].min())
    return ci, nol


def muat_set(d: Path) -> dict:
    """A generator run folder: features, labels (premature discharge alone = quality, left out), first visit, member group, X5 input."""
    U = V4.muat_uji(d)
    assert U is not None, f"{d} belum ada"
    raw = U["raw"]
    for k in ("faskes", "tgl", "kode"):
        U[k] = np.concatenate([x[k].astype(str) for x in raw])
    U["pos"] = np.concatenate([np.arange(len(x["sk"])) for x in raw])
    keep = ~np.isin(U["sk"], list(V4.MUTU))
    U = {k: (v[keep] if isinstance(v, np.ndarray) and len(v) == len(keep) else v) for k, v in U.items()}
    U["y"] = (~np.isin(U["sk"], A.NORMAL)).astype(int)
    ci, nol = _kol_kunjungan()
    U["pertama"] = U["X1"][:, ci] <= nol + 1e-5
    U["grup"] = np.char.add(U["chunk"].astype(str), np.char.add(":", U["peserta"].astype(str)))
    return U


def x5_set(F: "F5.Fitur5", U: dict) -> np.ndarray:
    out = np.zeros((len(U["y"]), len(F5.NAMES)), np.float32)
    for c in np.unique(U["chunk"]):
        m = U["chunk"] == c
        out[m] = F.blok({k: U[k][m] for k in ("peserta", "faskes", "tgl", "kode")})
    return out


def fitur(kind: str, X1, X4, X5) -> np.ndarray:
    return np.hstack([X1, X4] + ([X5] if kind == "K2" else [])).astype(np.float32)


def skor(models: list, X: np.ndarray) -> np.ndarray:
    return np.mean([m.predict_proba(X)[:, 1] for m in models], axis=0)


def ambang(s: np.ndarray, y: np.ndarray, seg: np.ndarray | None, fpr: float) -> dict:
    nrm = y == 0
    if seg is None:
        return {"global": VG.ambang_fpr(s[nrm], fpr)}
    return {"pertama": VG.ambang_fpr(s[nrm & seg], fpr), "lama": VG.ambang_fpr(s[nrm & ~seg], fpr)}


def tandai(s: np.ndarray, seg: np.ndarray, t: dict) -> np.ndarray:
    if "global" in t:
        return s > t["global"]
    return np.where(seg, s > t["pertama"], s > t["lama"])


def latih() -> None:
    import joblib
    import lightgbm as lgb

    say("muat data generator 1 (stream + data_v4)")
    D = VG.muat_data()
    S = np.load(VG.STREAM, allow_pickle=False)
    ns = int((D["chunk"] == -1).sum())
    tgl = np.empty(len(D["y"]), dtype=object)
    tgl[:ns] = S["tgl"][:ns].astype(str)
    for c in range(10):
        m = D["chunk"] == c
        tgl[m] = np.load(TMP / "data_v4" / f"fitur_{c:02d}.npz", allow_pickle=False)["tgl"].astype(str)[D["pos"][m]]
    F = F5.Fitur5({"peserta": D["peserta"][:ns].astype(str), "faskes": D["faskes"][:ns].astype(str), "tgl": tgl[:ns], "kode": D["kode"][:ns].astype(str)})
    X5 = np.zeros((len(D["y"]), len(F5.NAMES)), np.float32)
    X5[:ns] = F.X_stream
    for c in range(10):
        m = D["chunk"] == c
        X5[m] = F.blok({"peserta": D["peserta"][m].astype(str), "faskes": D["faskes"][m].astype(str), "tgl": tgl[m], "kode": D["kode"][m].astype(str)})
    say("muat generator 2 latih + dev, X5")
    GL, GD = muat_set(G2_LATIH), muat_set(G2_DEV)
    GL["X5"], GD["X5"] = x5_set(F, GL), x5_set(F, GD)
    say(f"latih: gen1 {int(D['latih'].sum())} + gen2 {len(GL['y'])} klaim ({int(D['y'][D['latih']].sum()) + int(GL['y'].sum())} fraud); "
        f"dev: gen1 {int(D['val'].sum())} + gen2 {len(GD['y'])}")
    tr, va = D["latih"], D["val"]
    dev = {"gen1": {"X1": D["X1"][va], "X4": D["X4"][va], "X5": X5[va], "y": D["y"][va], "seg": D["pertama"][va]},
           "gen2": {"X1": GD["X1"], "X4": GD["X4"], "X5": GD["X5"], "y": GD["y"], "seg": GD["pertama"]}}
    hasil, models = {}, {}
    for kind in ("K1", "K2"):
        Xtr = np.vstack([fitur(kind, D["X1"][tr], D["X4"][tr], X5[tr]), fitur(kind, GL["X1"], GL["X4"], GL["X5"])])
        ytr = np.concatenate([D["y"][tr], GL["y"]])
        ms = [lgb.LGBMClassifier(**VG.P1, n_jobs=VG.THREADS, random_state=sd).fit(Xtr, ytr) for sd in VG.SEEDS]
        models[kind] = ms
        for segmen in (False, True):
            nama = f"{kind}{'s' if segmen else 'g'}"
            per = {}
            for dn, dv in dev.items():
                s = skor(ms, fitur(kind, dv["X1"], dv["X4"], dv["X5"]))
                t = ambang(s, dv["y"], dv["seg"] if segmen else None, 0.01)
                f = tandai(s, dv["seg"], t)
                per[dn] = {"recall": round(float(f[dv["y"] == 1].mean()), 4), "fpr": round(float(f[dv["y"] == 0].mean()), 5)}
            hasil[nama] = {"per_dev": per, "rata_recall": round(float(np.mean([v["recall"] for v in per.values()])), 4)}
            say(nama, json.dumps(hasil[nama]))
    # v4 (frozen) on the same dev sets, for reference
    b4 = joblib.load(V4.MODEL / "model.joblib")
    ref = {}
    for dn, dv in dev.items():
        s = skor(b4["models"], V4.fitur("B", dv["X1"], dv["X4"]))
        t = ambang(s, dv["y"], None, 0.01)
        f = tandai(s, dv["seg"], t)
        ref[dn] = {"recall": round(float(f[dv["y"] == 1].mean()), 4)}
    say("v4 di dev (pembanding)", json.dumps(ref))
    urut = ["K1g", "K1s", "K2g", "K2s"]  # simplest first
    best = max(urut, key=lambda k: hasil[k]["rata_recall"])
    pilih = next(k for k in urut if hasil[best]["rata_recall"] - hasil[k]["rata_recall"] < 0.01)
    kind, segmen = pilih[:2], pilih.endswith("s")
    ms = models[kind]
    s_all = np.concatenate([skor(ms, fitur(kind, dv["X1"], dv["X4"], dv["X5"])) for dv in dev.values()])
    y_all = np.concatenate([dv["y"] for dv in dev.values()])
    seg_all = np.concatenate([dv["seg"] for dv in dev.values()])
    t_periksa = ambang(s_all, y_all, seg_all if segmen else None, 0.01)
    t_tahan = ambang(s_all, y_all, None, 0.001)
    # ---- overfitting checks on the chosen candidate (the user: "pastikan ga overfit"): in-sample vs member-grouped out-of-fold
    # vs dev AUPRC, the seed spread on dev, and whether one feature or block carries the model (a generator fingerprint)
    from sklearn.metrics import average_precision_score
    from sklearn.model_selection import GroupKFold

    Xtr = np.vstack([fitur(kind, D["X1"][tr], D["X4"][tr], X5[tr]), fitur(kind, GL["X1"], GL["X4"], GL["X5"])])
    ytr = np.concatenate([D["y"][tr], GL["y"]])
    gtr = np.concatenate([D["peserta"][tr].astype(str), np.char.add("g2:", GL["peserta"].astype(str))])
    auc_in = float(average_precision_score(ytr, skor(ms, Xtr)))
    oof = np.zeros(len(ytr))
    for a_, b_ in GroupKFold(n_splits=4).split(Xtr, ytr, gtr):
        m_ = lgb.LGBMClassifier(**VG.P1, n_jobs=VG.THREADS, random_state=0).fit(Xtr[a_], ytr[a_])
        oof[b_] = m_.predict_proba(Xtr[b_])[:, 1]
    auc_oof = float(average_precision_score(ytr, oof))
    auc_dev = {dn: round(float(average_precision_score(dv["y"], skor(ms, fitur(kind, dv["X1"], dv["X4"], dv["X5"])))), 4) for dn, dv in dev.items()}
    seed_rec = {}
    for dn, dv in dev.items():
        r_ = []
        for m_ in ms:
            s_ = m_.predict_proba(fitur(kind, dv["X1"], dv["X4"], dv["X5"]))[:, 1]
            r_.append(float((s_[dv["y"] == 1] > VG.ambang_fpr(s_[dv["y"] == 0], 0.01)).mean()))
        seed_rec[dn] = [round(x, 4) for x in r_]
    names = (list(joblib.load(HERE / "model_v3_bersih" / "model.joblib")["agg_names"]) + list(__import__("fitur_v4").NAMES)
             + (F5.NAMES if kind == "K2" else []))
    gain = np.mean([m_.booster_.feature_importance("gain") for m_ in ms], axis=0)
    gain = gain / max(gain.sum(), 1e-12)
    blok = {"X1 klaim sendiri": float(gain[:124].sum()), "X1 tetangga graph": float(gain[124:624].sum()), "X4 mekanisme": float(gain[624:646].sum()),
            "X5 modus baru": float(gain[646:].sum())}
    top = [{"fitur": names[j], "porsi": round(float(gain[j]), 4)} for j in np.argsort(-gain)[:15]]
    cek = {"auprc_latih_insample": round(auc_in, 4), "auprc_latih_oof_per_peserta": round(auc_oof, 4), "auprc_dev": auc_dev,
           "selisih_insample_oof": round(auc_in - auc_oof, 4), "recall_dev_per_seed": seed_rec, "porsi_gain_blok": {k: round(v, 4) for k, v in blok.items()},
           "fitur_teratas": top,
           "peringatan": [w for w in ((f"selisih in-sample vs OOF {auc_in - auc_oof:.3f} > 0,10" if auc_in - auc_oof > 0.10 else None),
                                      (f"satu fitur memegang {top[0]['porsi'] * 100:.0f}% gain ({top[0]['fitur']})" if top[0]["porsi"] > 0.30 else None),
                                      (f"sebaran recall antar-seed > 3 poin" if any(max(v) - min(v) > 0.03 for v in seed_rec.values()) else None)) if w]}
    say("cek overfit", json.dumps(cek, ensure_ascii=False)[:900])
    MODEL.mkdir(exist_ok=True)
    joblib.dump({"kind": kind, "segmen": segmen, "models": ms, "ambang_periksa": t_periksa, "ambang_tahan": t_tahan, "x5_names": F5.NAMES}, MODEL / "model.joblib")
    kartu = {"dibekukan": time.strftime("%Y-%m-%d %H:%M"), "kriteria": "testing/kriteria_ml_v5.json", "kandidat": hasil, "v4_di_dev": ref, "pilihan": pilih,
             "ambang_periksa": t_periksa, "ambang_tahan": t_tahan, "kolom": int(fitur(kind, dev["gen1"]["X1"][:1], dev["gen1"]["X4"][:1], dev["gen1"]["X5"][:1]).shape[1]),
             "latih": {"gen1": int(tr.sum()), "gen2": int(len(GL["y"])), "fraud": int(D["y"][tr].sum()) + int(GL["y"].sum())},
             "dev": {"gen1": int(va.sum()), "gen2": int(len(GD["y"]))}, "cek_overfit": cek}
    (MODEL / "kartu.json").write_text(json.dumps(kartu, ensure_ascii=False, indent=1), "utf-8")
    say("DIBEKUKAN", pilih, json.dumps(t_periksa))


def benchmark() -> None:
    import joblib
    from sklearn.metrics import average_precision_score

    tanda = MODEL / "benchmark_sekali.txt"
    assert (MODEL / "kartu.json").exists(), "latih dulu"
    assert not tanda.exists(), f"benchmark sudah dijalankan ({tanda.read_text('utf-8').strip()}): generator 3 seed baru hanya dinilai sekali"
    K = json.loads((MODEL / "kartu.json").read_text("utf-8"))
    b5 = joblib.load(MODEL / "model.joblib")
    b4 = joblib.load(V4.MODEL / "model.joblib")
    m3 = {"v3_lama": joblib.load(HERE / "model_v3" / "model.joblib"), "v3_bersih": joblib.load(HERE / "model_v3_bersih" / "model.joblib")}
    S = np.load(VG.STREAM, allow_pickle=False)
    F = F5.Fitur5({k: S[k].astype(str) for k in ("peserta", "faskes", "tgl", "kode")})
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "kartu": K, "set": {}}
    for nama, d in UJI.items():
        U = muat_set(d)
        y, seg, g = U["y"], U["pertama"], U["grup"]
        X5 = x5_set(F, U)
        sc, fl = {}, {}
        for k, bb in m3.items():
            r = A.skor(bb, U["X1"], U["X2"], U["XR"])
            sc[k], fl[k] = np.asarray(r["cal"], float), np.asarray(r["flag"], bool)
        sc["v4"] = skor(b4["models"], V4.fitur("B", U["X1"], U["X4"]))
        fl["v4"] = sc["v4"] > b4["ambang_periksa"]
        sc["ml_v5"] = skor(b5["models"], fitur(b5["kind"], U["X1"], U["X4"], X5))
        fl["ml_v5"] = tandai(sc["ml_v5"], seg, b5["ambang_periksa"])
        nrm = y == 0
        model = {}
        for k in ("v3_lama", "v3_bersih", "v4", "ml_v5"):
            f = fl[k]
            t1 = np.quantile(sc[k][nrm], 0.99)
            f1 = sc[k] > t1
            model[k] = {**RT.ukur(y, f), "auprc": round(float(average_precision_score(y, sc[k])), 4),
                        "fpr_kunjungan_pertama": round(float(f[nrm & seg].mean()), 5), "fpr_pasien_lama": round(float(f[nrm & ~seg].mean()), 5),
                        "fpr1_pembanding": {"recall": round(float(f1[y == 1].mean()), 4), "presisi_mentah": round(float(y[f1].mean()), 4)},
                        "per_skema": VG.recall_per_skema(U["sk"][y == 1], f[y == 1])}
        for k, bb in (("v4", b4), ("ml_v5", b5)):
            t = bb["ambang_tahan"]["global"] if isinstance(bb["ambang_tahan"], dict) else bb["ambang_tahan"]
            model[k]["tahan"] = RT.ukur(y, sc[k] > t)
        out["set"][nama] = {"label": LABEL_UJI[nama], "klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 5), "model": model,
                            "ci_ml_v5_vs_v4": RT.boot_selisih(y, fl["v4"], fl["ml_v5"], g)}
        say(nama, {k: (model[k]["recall"], model[k]["fpr"], model[k]["presisi_prev2"], model[k]["auprc"]) for k in model})
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    tanda.write_text(time.strftime("%Y-%m-%d %H:%M"), "utf-8")
    say("ditulis", OUT)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["latih", "benchmark"])
    a = ap.parse_args()
    VG.LOCK_NAMA = f"ml-v5-{a.perintah}"
    with VG.kunci_berat():
        latih() if a.perintah == "latih" else benchmark()
