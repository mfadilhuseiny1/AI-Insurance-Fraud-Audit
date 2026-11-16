"""Trains architecture v2 (arsitektur_v2.py), or for the comparison the first architecture on the new data, and checks it
on the validation chunks of data_v2.py (chunks 8 and 9: members never trained on). Synthetic data only.

Training data: the labelled stream claims (simulator claims, clean plants, copy-built normals, as latih_model.py) and,
unless --tanpa-data-v2, the training chunks 0–7 of data_v2.py (real claims of January–August 2024 with realistic fraud,
on members outside the stream and outside the 100.000-claim test). Out-of-fold over 5 folds (time blocks of the stream,
the chunks of data_v2) for the fusion, the calibration and the ring threshold; the final models are fitted on every
training claim. The 100.000-claim test is scored only by `uji`, after the choices are made.

Usage: .venv/Scripts/python.exe testing/latih_v2.py latih [--arsitektur v2|lama] [--tanpa-data-v2] [--out model_v2]
       .venv/Scripts/python.exe testing/latih_v2.py uji model_v2 [other model folders ...]"""
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
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import arsitektur_v2 as A  # noqa: E402
import fitur as FT  # noqa: E402

DATA = ROOT / ".tmp" / "testing-data" / "aip"
CACHE = ROOT / ".tmp" / "v2_stream.npz"
DV2 = ROOT / ".tmp" / "data_v2"
UJI_R2 = ROOT / ".tmp" / "uji100k" / "r2"
UJI_B = ROOT / ".tmp" / "uji100k_b"  # the fresh test B (uji100k.py with UJI100K_SET=B)
VALIDASI = (8, 9)
P1 = dict(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, n_jobs=4)
PF = dict(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, n_jobs=4)
PR = dict(n_estimators=200, learning_rate=0.05, num_leaves=15, min_child_samples=20, verbose=-1, n_jobs=4)
P2 = dict(n_estimators=300, learning_rate=0.05, num_leaves=7, min_child_samples=30, subsample=0.8, subsample_freq=1, verbose=-1, n_jobs=4)
PS = dict(n_estimators=150, learning_rate=0.05, num_leaves=7, min_child_samples=30, verbose=-1)
T0 = time.time()
OPSI = {"tanpa_model2": False, "tanpa_alert": False, "rute": False, "tanpa_lapisan_rule": False, "rule_jaringan": False}
# architecture v3 = v2 without Model 2, the ring alert and the rule layer, with the label-free ring rule
V3 = {"tanpa_model2": True, "tanpa_alert": True, "tanpa_lapisan_rule": True, "rule_jaringan": True}  # ablations (the user, 2026-11-12: "gausah ada model2 jaringan ya?")


def say(*a):
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def stream_fitur() -> dict:
    """The labelled stream claims' features exactly as latih_model.py builds them (randomized rings), cached."""
    if CACHE.exists():
        d = np.load(CACHE, allow_pickle=False)
        return {k: d[k] for k in d.files}
    import joblib
    import latih_model as LM

    recs, y, sk = LM.load_labeled(DATA / "realtime" / "realtime.sqlite")
    n = len(recs)
    SYS = FT.sys_features(recs, FT.load_ssl(DATA / "realtime" / "al"))
    fields = [FT.claim_fields(e) for e in recs]
    m = joblib.load(HERE / "model" / "model.joblib")
    mu, sd = m["mu"], m["sd"]
    rng = np.random.default_rng(12345)
    ring = sk == "cincin_kolusi"
    mem = {int(fields[i]["peserta"]) for i in np.where(ring)[0]}
    keep_m = {mm: rng.random() < 0.7 for mm in sorted(mem)}
    spread = {mm: int(rng.choice([0, 3, 7, 10])) for mm in sorted(mem)}
    keep = np.array([not (ring[i] and not keep_m[int(fields[i]["peserta"])]) for i in range(n)])
    fk = []
    for i in np.where(keep)[0]:
        fd = dict(fields[i])
        if ring[i]:
            s = spread[int(fd["peserta"])]
            fd["day"] = fd["day"] + int(rng.integers(-s, s + 1))
        fk.append(fd)
    idx = np.where(keep)[0]
    AGG = FT.agg_matrix(SYS[idx], fk, mu, sd)
    R = LM.ring_all(FT.Stream(SYS[idx], fk, mu, sd))
    lg1 = np.log1p
    S2 = np.column_stack([np.column_stack([lg1(R[W][:, 0]), lg1(R[W][:, 1]), R[W][:, 2]]) for W in FT.G3_WINS] + [np.array([f["ritl"] for f in fk], np.float32)])
    R2 = np.column_stack([np.column_stack([lg1(R[W][:, 0]), lg1(R[W][:, 1])]) for W in FT.R2_WINS])
    out = dict(X1=AGG.astype(np.float32), X2=S2.astype(np.float32), XR=R2.astype(np.float32), sk=sk[idx].astype(str),
               tahan=np.array([recs[i].get("keputusan") == "TAHAN" for i in idx]), periksa=np.array([recs[i].get("keputusan") == "PERIKSA" for i in idx]),
               peserta=np.array([str(recs[i].get("peserta")) for i in idx]), faskes=np.array([str(recs[i].get("faskes")) for i in idx]),
               tgl=np.array([str(recs[i].get("tgl_datang"))[:10] for i in idx]), kode=np.array([str(recs[i].get("kode")) for i in idx]))
    np.savez(CACHE, **out)
    return out


def muat_v2(chunks) -> dict:
    ds = [np.load(DV2 / f"fitur_{c:02d}.npz") for c in chunks]
    return {k: np.concatenate([d[k] for d in ds]) for k in ds[0].files}


def ringkas(y: np.ndarray, flag: np.ndarray, s: np.ndarray, sk: np.ndarray) -> dict:
    from sklearn.metrics import average_precision_score, roc_auc_score

    nrm = np.isin(sk, A.NORMAL)
    out = {"n": int(len(y)), "fraud": int(y.sum()), "precision": float(y[flag].mean()) if flag.any() else 0.0, "recall": float(flag[y == 1].mean()),
           "fpr": float(flag[nrm].mean()), "auprc": float(average_precision_score(y, s)), "auroc": float(roc_auc_score(y, s))}
    out["per_skema"] = {A.skema_dasar(x): round(float(flag[sk == x].mean()), 3) for x in sorted(set(sk)) if x not in A.NORMAL}
    return out


def latih(arsitektur: str, pakai_v2: bool, out: Path, tanpa: str | None = None) -> dict:
    import joblib
    import lightgbm as lgb
    from sklearn.isotonic import IsotonicRegression

    out.mkdir(exist_ok=True)
    cur = joblib.load(HERE / "model" / "model.joblib")
    sys_names = list(cur["sys_names"])
    S = stream_fitur()
    aug = np.char.startswith(S["sk"].astype(str), "aug:")
    sim = ~aug
    fold = np.zeros(len(aug), int)
    fold[sim] = np.minimum((np.cumsum(sim)[sim] - 1) * 5 // max(1, int(sim.sum())), 4)
    fold[aug] = np.random.default_rng(5).integers(0, 5, int(aug.sum()))
    X1, X2, XR, sk = S["X1"], S["X2"], S["XR"], S["sk"].astype(str)
    sumber = np.where(aug, "aug", "sim")
    if pakai_v2:
        V = muat_v2([c for c in range(10) if c not in VALIDASI])
        X1, X2, XR = np.vstack([X1, V["X1"]]), np.vstack([X2, V["X2"]]), np.vstack([XR, V["XR"]])
        sk = np.concatenate([sk, V["sk"].astype(str)])
        fold = np.concatenate([fold, V["chunk"] % 5])
        sumber = np.concatenate([sumber, np.full(len(V["sk"]), "v2")])
    y = (~np.isin(sk, A.NORMAL)).astype(int)
    fam = np.array([A.famili_dari(s) or "" for s in sk])
    if tanpa:  # a family the model never sees (the unseen-type check): its fraud leaves every source of the training data
        k = fam != tanpa
        X1, X2, XR, sk, fold, sumber, y, fam = X1[k], X2[k], XR[k], sk[k], fold[k], sumber[k], y[k], fam[k]
    say(f"without family {tanpa}" if tanpa else "", f"architecture {arsitektur}, data v2 {'on' if pakai_v2 else 'off'}: {len(y)} claims, fraud {int(y.sum())}",
        {s: int((sumber == s).sum()) for s in ("sim", "aug", "v2")})

    komp: dict[str, dict] = {"model1": dict(input="X1", kolom=None, mono=None, params=P1, elig=None)}
    if arsitektur in ("v2", "v3"):
        rc = A.kolom_rule(sys_names)
        if not OPSI["tanpa_lapisan_rule"]:
            komp["rule"] = dict(input="X1", kolom=rc, mono=[1] * len(rc), params=PR, elig=None)
        for f, d in A.FAMILI.items():
            if f == tanpa:
                continue
            c, mo = A.kolom_famili(sys_names, d)
            komp[f] = dict(input="X1", kolom=c, mono=[int(v) for v in mo], params=PF, elig=f)
    if not OPSI["tanpa_model2"]:
        komp["model2"] = dict(input="X2", kolom=None, mono=None, params=P2, elig=None)
    for nama, k in komp.items():
        say(f"  layer {nama}: {X1.shape[1] if k['kolom'] is None and k['input'] == 'X1' else (X2.shape[1] if k['kolom'] is None else len(k['kolom']))} features"
            + (f", monotone on {sum(k['mono'])}" if k["mono"] else "") + (f", trained on family {k['elig']} vs normal" if k["elig"] else ""))

    def baris(k: dict, rows: np.ndarray) -> np.ndarray:
        X = X1 if k["input"] == "X1" else X2
        return X[rows] if k["kolom"] is None else X[np.ix_(rows, k["kolom"])]

    def fit(k: dict, rows: np.ndarray):
        p = dict(k["params"])
        if k["mono"]:
            p["monotone_constraints"] = k["mono"]
        return lgb.LGBMClassifier(**p, random_state=0).fit(baris(k, rows), y[rows])

    def elig(k: dict) -> np.ndarray:
        return np.ones(len(y), bool) if k["elig"] is None else ((y == 0) | (fam == k["elig"]))

    O = {}
    for nama, k in komp.items():
        o = np.zeros(len(y))
        el = elig(k)
        for b in range(5):
            tr, te = np.where((fold != b) & el)[0], np.where(fold == b)[0]
            o[te] = fit(k, tr).predict_proba(baris(k, te))[:, 1]
        O[nama] = o
        say(f"  out-of-fold {nama} done")
    PM = dict(n_estimators=300, learning_rate=0.05, num_leaves=7, min_child_samples=30, subsample=0.8, subsample_freq=1,
              monotone_constraints=[1] * XR.shape[1], verbose=-1, n_jobs=4)
    om = np.zeros(len(y))
    for b in range(5):
        tr, te = np.where(fold != b)[0], np.where(fold == b)[0]
        om[te] = lgb.LGBMClassifier(**PM, random_state=0).fit(XR[tr], y[tr]).predict_proba(XR[te])[:, 1]
    urutan = list(komp)
    F = np.column_stack([A.lg(O[n]) for n in urutan])
    pss = dict(PS)
    if arsitektur in ("v2", "v3"):
        pss["monotone_constraints"] = [1] * len(urutan)
    os_ = np.zeros(len(y))
    for b in range(5):
        tr, te = np.where(fold != b)[0], np.where(fold == b)[0]
        os_[te] = lgb.LGBMClassifier(**pss, random_state=0).fit(F[tr], y[tr]).predict_proba(F[te])[:, 1]
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(os_, y)
    cal = iso.predict(os_)
    thr_mono = float(np.quantile(om[y == 0], 0.999)) if not OPSI["tanpa_alert"] else float("inf")
    rute_def = A.pilih_rute(sys_names, X1, y) if (arsitektur in ("v2", "v3") or OPSI["rute"]) else None
    rj_def = A.pilih_rule_jaringan(XR, y) if OPSI["rule_jaringan"] else None
    say("ring rule:", rj_def)
    rute = A.rute_rule({"rute_rule": rute_def}, X1) if rute_def else np.zeros(len(y), bool)
    rute = rute | (A.rule_jaringan({"rule_jaringan": rj_def}, XR) if rj_def else False)
    say("rule route:", rute_def and list(zip(rute_def["nama"], rute_def["contoh"], rute_def["laju_normal"])))
    flag = (cal >= 0.5) | (om > thr_mono) | rute
    kartu = {"arsitektur": arsitektur, "data_v2": pakai_v2, **OPSI, "klaim_latih": int(len(y)), "fraud_latih": int(y.sum()),
             "per_sumber": {s: int((sumber == s).sum()) for s in ("sim", "aug", "v2")}, "ambang_peluang": 0.5, "ambang_alert_ring": None if OPSI["tanpa_alert"] else thr_mono,
             "oof": ringkas(y, flag, os_, sk), "dilatih": time.strftime("%Y-%m-%d %H:%M")}
    kartu["oof_per_sumber"] = {s: ringkas(y[sumber == s], flag[sumber == s], os_[sumber == s], sk[sumber == s]) for s in ("sim", "v2") if (sumber == s).any() and y[sumber == s].any()}

    final = {}
    for nama, k in komp.items():
        final[nama] = dict(input=k["input"], kolom=k["kolom"], model=fit(k, np.where(elig(k))[0]))
    bundle = dict(komponen=final, urutan=urutan, stacker=lgb.LGBMClassifier(**pss, random_state=0).fit(F, y), iso=iso,
                  mono=None if OPSI["tanpa_alert"] else lgb.LGBMClassifier(**PM, random_state=0).fit(XR, y), ambang_peluang=0.5,
                  ambang_alert_ring=None if OPSI["tanpa_alert"] else thr_mono, rule_jaringan=rj_def,
                  mu=cur["mu"], sd=cur["sd"], sys_names=sys_names, agg_names=FT.feature_names(sys_names), arsitektur=arsitektur,
                  famili=A.FAMILI if arsitektur in ("v2", "v3") else None, rute_rule=rute_def, kartu=kartu)

    # validation: chunks 8 and 9 of data_v2 (members never trained on), against the first architecture as it is now
    V = muat_v2(VALIDASI)
    yv, skv = (~np.isin(V["sk"], A.NORMAL)).astype(int), V["sk"].astype(str)
    sv = A.skor(bundle, V["X1"], V["X2"], V["XR"])
    sc = A.skor_lama(cur, V["X1"], V["X2"], V["XR"])
    kartu["validasi"] = ringkas(yv, sv["flag"], sv["ps"], skv)
    kartu["validasi_sistem_sekarang"] = ringkas(yv, sc["flag"], sc["ps"], skv)
    bundle["kartu"] = kartu
    joblib.dump(bundle, out / "model.joblib")
    (out / "kartu.json").write_text(json.dumps(kartu, indent=1), "utf-8")
    np.savez_compressed(out / "oof.npz", y=y, sk=sk, sumber=sumber, fold=fold, os=os_, cal=cal, om=om, thr_mono=thr_mono if np.isfinite(thr_mono) else -1.0,
                        **{f"o_{n}": O[n] for n in urutan}, val_y=yv, val_sk=skv, val_ps=sv["ps"], val_cal=sv["cal"], val_flag=sv["flag"],
                        val_lama_ps=sc["ps"], val_lama_flag=sc["flag"], **{f"val_{n}": sv[n] for n in urutan})
    for nama, r in (("out-of-fold", kartu["oof"]), ("validation", kartu["validasi"]), ("validation, system now", kartu["validasi_sistem_sekarang"])):
        say(f"{nama:24s}", {k: round(v, 4) for k, v in r.items() if isinstance(v, float)})
    for s in kartu["validasi"]["per_skema"]:
        say(f"  validation {s:18s} v2 {kartu['validasi']['per_skema'][s]:.2f}   now {kartu['validasi_sistem_sekarang']['per_skema'][s]:.2f}")
    say("saved", out / "model.joblib")
    return bundle


def tak_dikenal(arsitektur: str) -> None:
    """Fraud types the model never saw: for each family, train without any of its fraud and score the family's test claims."""
    import shutil

    files = sorted(UJI_R2.glob("hasil_[0-9][0-9].npz"))
    ds = [np.load(f) for f in files]
    sk = np.concatenate([d["sk"] for d in ds]).astype(str)
    say("test", UJI_R2.name, len(sk), "claims")
    fam = np.array([A.famili_dari(s) or "" for s in sk])
    out = {}
    for f in [*A.FAMILI, "jaringan"]:
        tmp = HERE / f"_tmp_{arsitektur}_{f}"
        b = latih(arsitektur, True, tmp, tanpa=f)
        parts = [A.skor(b, d["X1"], d["X2"], d["XR"]) for d in ds]
        flag = np.concatenate([p["flag"] for p in parts]); cal = np.concatenate([p["cal"] for p in parts])
        m = fam == f
        out[f] = {"n": int(m.sum()), "recall": float(flag[m].mean()), "fpr": float(flag[sk == "normal"].mean()),
                  "per_skema": {s: round(float(flag[sk == s].mean()), 3) for s in sorted(set(sk[m]))}, "median_peluang": float(np.median(cal[m]))}
        say(f"unseen family {f}: recall {out[f]['recall']:.3f}", out[f]["per_skema"])
        shutil.rmtree(tmp, ignore_errors=True)
    akhiran = ("" if arsitektur == "v3" else "".join(f"_{k}" for k, v in OPSI.items() if v)) + ("_b" if UJI_R2 == UJI_B else "")
    (ROOT / ".tmp" / f"tak_dikenal_{arsitektur}{akhiran}.json").write_text(json.dumps(out, indent=1), "utf-8")


def uji(models: list[str]) -> None:
    import joblib

    files = sorted(UJI_R2.glob("hasil_[0-9][0-9].npz"))
    ds = [np.load(f) for f in files]
    c = {k: np.concatenate([d[k] for d in ds]) for k in ("sk", "flag", "ps", "flag_old", "ps_old", "tahan", "periksa", "peserta", "asal")}
    sk = c["sk"].astype(str)
    y = (sk != "normal").astype(int)
    lama = sorted(ROOT.joinpath(".tmp", "uji100k").glob("hasil_[0-9][0-9].npz")) if UJI_R2 != UJI_B else []
    if lama:
        L = {k: np.concatenate([np.load(f)[k] for f in lama]) for k in ("sk", "peserta", "asal")}
        sama = len(L["sk"]) == len(sk) and all((L[k].astype(str) == c[k].astype(str)).all() for k in ("sk", "peserta", "asal"))
        say(f"re-run claims identical to the first run: {sama} ({len(sk)} vs {len(L['sk'])})")
    say("system now", {k: round(v, 4) for k, v in ringkas(y, c["flag"], c["ps"], sk).items() if isinstance(v, float)})
    say("old system", {k: round(v, 4) for k, v in ringkas(y, c["flag_old"], c["ps_old"], sk).items() if isinstance(v, float)})
    for mname in models:
        b = joblib.load(HERE / mname / "model.joblib")
        parts = [A.skor(b, d["X1"], d["X2"], d["XR"]) for d in ds]
        s = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
        r = ringkas(y, s["flag"], s["ps"], sk)
        say(mname, {k: round(v, 4) for k, v in r.items() if isinstance(v, float)})
        say("   per scheme", r["per_skema"])
        np.savez_compressed(UJI_R2 / f"skor_{mname}.npz", **{k: v for k, v in s.items()})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["latih", "uji", "tak_dikenal"])
    ap.add_argument("models", nargs="*")
    ap.add_argument("--arsitektur", choices=["v3", "v2", "lama"], default="v2")
    ap.add_argument("--tanpa-data-v2", action="store_true")
    ap.add_argument("--out", default="model_v2")
    ap.add_argument("--tanpa-model2", action="store_true")
    ap.add_argument("--tanpa-alert", action="store_true")
    ap.add_argument("--rute", action="store_true", help="the rule route on the first architecture too")
    ap.add_argument("--uji", choices=["a", "b"], default="a", help="a = the 100.000-claim re-run, b = the fresh test B")
    a = ap.parse_args()
    OPSI.update(tanpa_model2=a.tanpa_model2, tanpa_alert=a.tanpa_alert, rute=a.rute)
    if a.arsitektur == "v3":
        OPSI.update(V3)
    if a.uji == "b":
        UJI_R2 = UJI_B
    if a.perintah == "latih":
        latih(a.arsitektur, not a.tanpa_data_v2, HERE / a.out)
    elif a.perintah == "tak_dikenal":
        tak_dikenal(a.arsitektur)
    else:
        uji(a.models or ["model_v2"])
