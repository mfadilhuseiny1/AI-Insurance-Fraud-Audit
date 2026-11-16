"""Trains the /testing fraud models on the synthetic stream (the testing copy, read-only) and saves them to
testing/model/model.joblib.

Final configuration of the experiments (see the dashboard "Riset Deteksi Fraud FKRTL"): Model 1 = LightGBM on the system
+ neighbour features; Model 2 = small LightGBM on ring features, trained with randomized rings (each ring member kept
with probability 0.7, dates moved by up to 0/3/7/10 days per member) so it learns the concept, not the simulator's
shape; a small LightGBM stacker on both scores; isotonic calibration of the stacker; a monotone ring-alert model whose
threshold lets through 0.1 % of normal claims. Out-of-fold over 5 contiguous time blocks for the stacker, calibration
and threshold; the final models are fitted on every training claim.

The simulator plants every single-claim scheme on a member who had a claim at another hospital the same day (100 % of
them, against 1.6 % of normal claims), so a model can learn that journey instead of the scheme. Two remedies:
- clean plants: the same schemes built by the /testing generator on members with an ordinary journey, run through the
  realtime engine (source aug:<scheme>, POST /testing/api/augmentasi) and labelled fraud here; 30 % of them (by id) are
  never trained on and give the clean recall per scheme;
- copy-built normals: every plant is a near-copy of an existing claim at the same hospital, so ordinary claims are
  built the same way (aug:normal, labelled normal), and "a near-copy" alone carries no label; 30 % of them are held out
  and give the false-positive rate of an ordinary claim built through the form;
- masking: some simulator single-claim plants and normals get the same-member neighbour block hidden in training.
Default: trained on the simulator claims, the clean plants and the copy-built normals together (best on every check).
Flags: --tanpa-aug (simulator claims only; all clean plants are the holdout), --tanpa-plant-simulator (the simulator's
plants of the schemes the generator covers are not trained on but scored as a second holdout), --tanpa-mask, --out <dir>."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

os.environ.setdefault("BLUESANDAI_AUTH", "off")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import fitur as FT  # noqa: E402

DATA = ROOT / ".tmp" / "testing-data" / "aip"
OUT = HERE / (sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "model")
NO_MASK = "--tanpa-mask" in sys.argv
NO_AUG = "--tanpa-aug" in sys.argv
KEEP_SIM = "--tanpa-plant-simulator" not in sys.argv
SATU_KLAIM = {"upcoding", "dx_sekunder", "kelas_naik", "topup_inflasi", "topup_fiktif", "prosedur_fiktif", "kode_tidak_sesuai", "los_bergeser",
              "kloning", "obat_fiktif", "obat_dikurangi", "hasil_manipulasi"}
# the simulator plants of the schemes the clean generator covers: with clean plants, these are not trained on (they carry
# the fingerprint) but scored as a second holdout
GANTI = SATU_KLAIM - {"obat_fiktif", "obat_dikurangi", "hasil_manipulasi"}
T0 = time.time()


def say(*a):
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def load_labeled(db: Path) -> tuple[list[dict], np.ndarray, np.ndarray]:
    """Labelled simulator claims and the clean plants (aug:<scheme>), in arrival order."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    recs, sk = [], []
    for rec, scen in con.execute("""SELECT p.rec, coalesce(k.skenario, 'aug:' || substr(p.sumber, 5)) FROM peristiwa p
                                    LEFT JOIN kebenaran k ON k.peristiwa = p.id
                                    WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'aug:%')
                                    ORDER BY p.seq"""):
        recs.append(json.loads(rec)); sk.append(scen)
    con.close()
    sk = np.array(sk)
    return recs, (~np.isin(sk, ["normal", "aug:normal"])).astype(int), sk


def ring_all(stream: FT.Stream) -> dict[int, np.ndarray]:
    out = {}
    for W in sorted(set(FT.G3_WINS) | set(FT.R2_WINS)):
        a = np.zeros((len(stream), 3), np.float32)
        for i in range(len(stream)):
            rs, co, nh, _ = stream.ring_detail(i, W)
            a[i] = (rs, co, nh)
        out[W] = a
    return out


def main() -> None:
    import joblib
    import lightgbm as lgb
    from sklearn.isotonic import IsotonicRegression
    from sklearn.metrics import average_precision_score, roc_auc_score

    OUT.mkdir(exist_ok=True)
    recs, y, sk = load_labeled(DATA / "realtime" / "realtime.sqlite")
    n = len(recs)
    aug = np.char.startswith(sk.astype(str), "aug:")
    say("labeled claims", n, "fraud", int(y.sum()), "of which clean plants", int(aug.sum()))
    M = FT.load_ssl(DATA / "realtime" / "al")
    SYS = FT.sys_features(recs, M)
    _, eng_names = FT.engine_cols()
    sys_names = eng_names + FT.vime_names(M, SYS.shape[1] - len(eng_names))
    fields = [FT.claim_fields(e) for e in recs]
    pool = (np.cumsum(~aug) <= int(0.7 * (~aug).sum())) & ~aug
    mu = np.nanmean(SYS[pool], axis=0); sd = np.nanstd(SYS[pool], axis=0)
    sd[~np.isfinite(sd) | (sd < 1e-6)] = 1.0; mu[~np.isfinite(mu)] = 0.0

    # randomized rings for training
    rng = np.random.default_rng(12345)
    ring = sk == "cincin_kolusi"
    mem = {int(fields[i]["peserta"]) for i in np.where(ring)[0]}
    keep_m = {m: rng.random() < 0.7 for m in sorted(mem)}
    spread = {m: int(rng.choice([0, 3, 7, 10])) for m in sorted(mem)}
    keep = np.array([not (ring[i] and not keep_m[int(fields[i]["peserta"])]) for i in range(n)])
    fk = []
    for i in np.where(keep)[0]:
        fd = dict(fields[i])
        if ring[i]:
            s = spread[int(fd["peserta"])]
            fd["day"] = fd["day"] + int(rng.integers(-s, s + 1))
        fk.append(fd)
    idx = np.where(keep)[0]
    Xk, yk, skk = SYS[idx], y[idx], sk[idx]
    AGG = FT.agg_matrix(Xk, fk, mu, sd)
    st = FT.Stream(Xk, fk, mu, sd)
    R = ring_all(st)
    lg1 = np.log1p
    S2 = np.column_stack([np.column_stack([lg1(R[W][:, 0]), lg1(R[W][:, 1]), R[W][:, 2]]) for W in FT.G3_WINS] + [np.array([f["ritl"] for f in fk], np.float32)])
    R2 = np.column_stack([np.column_stack([lg1(R[W][:, 0]), lg1(R[W][:, 1])]) for W in FT.R2_WINS])
    say("features", AGG.shape, S2.shape, R2.shape)

    # the clean holdout: 30 % of the clean plants by id, never trained on (all of them with --tanpa-aug)
    augk = aug[idx]
    by_id = np.array([int(hashlib.md5(str(recs[i].get("id")).encode()).hexdigest(), 16) % 10 < 3 for i in idx])
    hold = augk & (by_id | NO_AUG)
    hold_sim = np.isin(skk, list(GANTI)) & (not NO_AUG) & (not KEEP_SIM)
    T = np.where(~hold & ~hold_sim)[0]
    H = np.where(hold)[0]
    Hs = np.where(hold_sim)[0]

    # masking of the same-member block for some simulator single-claim plants and normals
    nsys = SYS.shape[1]
    blk = np.r_[nsys:2 * nsys, AGG.shape[1] - len(FT.CAPS)]
    no_hist = AGG[:, AGG.shape[1] - len(FT.CAPS)] == 0
    q = float(no_hist[skk == "normal"].mean())
    r_n = 0.3
    r_f = q + (1 - q) * r_n
    single = np.isin(skk, list(SATU_KLAIM))
    rng_m = np.random.default_rng(777)
    mask = np.where(skk == "normal", rng_m.random(len(skk)) < r_n, single & (rng_m.random(len(skk)) < r_f)) & ~no_hist
    AGGm = AGG.copy()
    if not NO_MASK:
        AGGm[np.ix_(np.where(mask)[0], blk)] = 0.0
    say(f"clean plants {int(augk.sum())}, holdout {len(H)}; masking {'off' if NO_MASK else 'on, rows ' + str(int(mask.sum()))}")

    P1 = dict(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, n_jobs=4)
    P2 = dict(n_estimators=300, learning_rate=0.05, num_leaves=7, min_child_samples=30, subsample=0.8, subsample_freq=1, verbose=-1, n_jobs=4)
    PS = dict(n_estimators=150, learning_rate=0.05, num_leaves=7, min_child_samples=30, verbose=-1)
    PM = dict(n_estimators=300, learning_rate=0.05, num_leaves=7, min_child_samples=30, subsample=0.8, subsample_freq=1, monotone_constraints=[1] * R2.shape[1], verbose=-1, n_jobs=4)

    def lg(p):
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return np.log(p / (1 - p))

    # folds: 5 contiguous time blocks for the simulator claims; the clean plants (all at the end) spread over the folds
    yT, skT = yk[T], skk[T]
    sim = ~augk[T]
    fold = np.zeros(len(T), int)
    fold[sim] = np.minimum((np.cumsum(sim)[sim] - 1) * 5 // max(1, int(sim.sum())), 4)
    fold[~sim] = np.random.default_rng(5).integers(0, 5, int((~sim).sum()))

    def oof(X, params, Xfit=None, sudah_T=False):
        XT = X if sudah_T else X[T]
        XF = XT if Xfit is None else Xfit[T]
        o = np.zeros(len(T))
        for b in range(5):
            te, tr = np.where(fold == b)[0], np.where(fold != b)[0]
            o[te] = lgb.LGBMClassifier(**params, random_state=0).fit(XF[tr], yT[tr]).predict_proba(XT[te])[:, 1]
        return o

    o1 = oof(AGG, P1, AGGm)
    o2, om = oof(S2, P2), oof(R2, PM)
    F = np.column_stack([lg(o1), lg(o2)])
    os_ = oof(F, PS, sudah_T=True)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(os_, yT)
    cal = iso.predict(os_)
    thr_mono = float(np.quantile(om[yT == 0], 0.999))
    K = int(round(0.02 * len(yT)))
    top = np.argsort(-os_, kind="stable")[:K]
    flag = (cal >= 0.5) | (om > thr_mono)
    kartu = {"klaim_latih": int(len(yT)), "fraud_latih": int(yT.sum()), "plant_bersih_latih": int(augk[T].sum()), "plant_bersih_holdout": int(len(H)),
             "oof_auprc": float(average_precision_score(yT, os_)), "oof_auroc": float(roc_auc_score(yT, os_)),
             "oof_auprc_model1": float(average_precision_score(yT, o1)), "oof_precision_top2pct": float(yT[top].mean()),
             "oof_recall_top2pct": float(yT[top].sum() / yT.sum()), "oof_ditandai": int(flag.sum()), "oof_ditandai_precision": float(yT[flag].mean()),
             "oof_ditandai_recall": float(yT[flag].sum() / yT.sum()), "oof_fpr_normal": float(flag[skT == "normal"].mean()),
             "ambang_peluang": 0.5, "ambang_alert_ring": thr_mono, "masking_riwayat_peserta": not NO_MASK, "dilatih": time.strftime("%Y-%m-%d %H:%M")}
    kartu["oof_simulator_saja"] = {"auprc": float(average_precision_score(yT[sim], os_[sim])), "precision": float(yT[sim & flag].mean()),
                                   "recall": float(yT[sim & flag].sum() / yT[sim].sum())}
    kartu["oof_per_skenario"] = {s_: {"n": int((skT == s_).sum()), "ditandai": round(float(flag[skT == s_].mean()), 3)} for s_ in sorted(set(skT))}

    m1 = lgb.LGBMClassifier(**P1, random_state=0).fit(AGGm[T], yT)
    m2 = lgb.LGBMClassifier(**P2, random_state=0).fit(S2[T], yT)
    ms = lgb.LGBMClassifier(**PS, random_state=0).fit(F, yT)
    mm = lgb.LGBMClassifier(**PM, random_state=0).fit(R2[T], yT)
    def skor(I):
        p1, p2 = m1.predict_proba(AGG[I])[:, 1], m2.predict_proba(S2[I])[:, 1]
        pc = iso.predict(ms.predict_proba(np.column_stack([lg(p1), lg(p2)]))[:, 1])
        return (pc >= 0.5) | (mm.predict_proba(R2[I])[:, 1] > thr_mono), p1

    if len(H):  # the clean holdout, scored by the final models
        fh, p1 = skor(H)
        hs = skk[H]
        kartu["holdout_bersih_recall"] = float(fh.mean())
        kartu["holdout_bersih_per_skenario"] = {s_[4:]: {"n": int((hs == s_).sum()), "ditandai": round(float(fh[hs == s_].mean()), 3),
                                                         "model1_median": round(float(np.median(p1[hs == s_])), 3)} for s_ in sorted(set(hs))}
    hn = H[skk[H] == "aug:normal"]
    if len(hn):  # copy-built normal claims never trained on: the false-positive rate of an ordinary typed claim
        fn, _ = skor(hn)
        kartu["holdout_normal_bersih_n"] = int(len(hn))
        kartu["holdout_normal_bersih_fpr"] = float(fn.mean())
    hp = H[skk[H] != "aug:normal"]
    if len(hp):
        fp_, _ = skor(hp)
        kartu["holdout_bersih_recall"] = float(fp_.mean())
    if len(Hs):  # the simulator's own plants of those schemes, never trained on
        fs, p1 = skor(Hs)
        hs = skk[Hs]
        kartu["holdout_plant_simulator_recall"] = float(fs.mean())
        kartu["holdout_plant_simulator_per_skenario"] = {s_: {"n": int((hs == s_).sum()), "ditandai": round(float(fs[hs == s_].mean()), 3)} for s_ in sorted(set(hs))}
    say("out-of-fold", {k: (round(v, 4) if isinstance(v, float) else v) for k, v in kartu.items() if not isinstance(v, dict)})
    say("simulator claims only", {k: round(v, 4) for k, v in kartu["oof_simulator_saja"].items()})
    for s_, v in sorted(kartu["oof_per_skenario"].items(), key=lambda kv: -kv[1]["n"]):
        say(f"  oof {s_:24s}", v)
    for s_, v in (kartu.get("holdout_bersih_per_skenario") or {}).items():
        say(f"  clean holdout {s_:18s}", v)
    for s_, v in (kartu.get("holdout_plant_simulator_per_skenario") or {}).items():
        say(f"  simulator-plant holdout {s_:18s}", v)
    # the out-of-fold scores and the holdout scores, for the evaluation report of ML Studio (laporan_ml.py): no claim rows
    hold_scores = {}
    for nama, I in (("holdout_bersih", H), ("holdout_plant_simulator", Hs)):
        if len(I):
            p1h, p2h = m1.predict_proba(AGG[I])[:, 1], m2.predict_proba(S2[I])[:, 1]
            hold_scores[nama + "_cal"] = iso.predict(ms.predict_proba(np.column_stack([lg(p1h), lg(p2h)]))[:, 1])
            hold_scores[nama + "_mono"] = mm.predict_proba(R2[I])[:, 1]
            hold_scores[nama + "_sk"] = skk[I].astype(str)
    # the overfitting check: the final models on their own training rows (in-sample) against the out-of-fold scores
    ins1, ins2 = m1.predict_proba(AGG[T])[:, 1], m2.predict_proba(S2[T])[:, 1]
    ins = ms.predict_proba(np.column_stack([lg(ins1), lg(ins2)]))[:, 1]
    # the realtime engine's own decision, the "rule only" baseline (no labels)
    tahan = np.array([recs[i].get("keputusan") == "TAHAN" for i in idx])[T]
    np.savez_compressed(OUT / "oof.npz", o1=o1, o2=o2, om=om, os=os_, cal=cal, y=yT, sk=skT.astype(str), sim=sim, fold=fold, thr_mono=thr_mono,
                        ins1=ins1, ins2=ins2, ins=ins, tahan=tahan, **hold_scores)
    joblib.dump({"m1": m1, "m2": m2, "stacker": ms, "iso": iso, "mono": mm, "mu": mu, "sd": sd, "sys_names": sys_names,
                 "agg_names": FT.feature_names(sys_names), "kartu": kartu}, OUT / "model.joblib")
    (OUT / "kartu.json").write_text(json.dumps(kartu, indent=1), "utf-8")
    say("saved", OUT / "model.joblib")


if __name__ == "__main__":
    main()
