"""ML v7: the reviewer's order against distribution shift (testing/kriteria_ml_v7.json, written before any of this ran).

  latih      step 1 (data): generator 2 "halus" (GEN2_HALUS=1: local members with history for the schemes that added outside
             members) joins generator 1 + 2 in training. Steps 2-3: candidates A1 (ML v5 recipe on the new data), A2 (+ equal
             weight per generator), A3 (+ group DRO, two rounds), A4 (+ context randomisation of features unstable across the
             training generators). Selection by leave-one-generator-out (train G1 -> G2 + G2-halus dev; train G2 + G2-halus ->
             G1 dev), score = the WORSE direction, recall at FPR 1%; pooled-dev guard; overfit checks; every candidate frozen
             (all of them are reported on the final tests) in testing/model_ml_v7, the pick marked.
  benchmark  generator 1 (C2), 2 (seed 3), 3 (fresh seed gen3-ml7), 4 (testing/generator4.py, written blind), scored ONCE:
             v3 bersih, v4, A0 = ML v5, A1-A4 -> data/aip/ml/sistem_terbaru/ml_v7_benchmark.json
Synthetic data only."""
from __future__ import annotations

import argparse
import hashlib
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
import v4_rule_tambah as RT  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

TMP = M.TMP
MODEL = HERE / "model_ml_v7"
OUT = M.ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "ml_v7_benchmark.json"
G2H_LATIH, G2H_DEV = TMP / "gen2_ml7h_latih", TMP / "gen2_ml7h_dev"
UJI = {"generator1": TMP / "uji100k_c2", "generator2": TMP / "gen2_seed3", "generator3": TMP / "gen3_ml7", "generator4": TMP / "gen4_ml7"}
LABEL_UJI = {"generator1": "Generator 1 · test C2 (dipakai ulang)", "generator2": "Generator 2 · seed 3 (dipakai ulang)",
             "generator3": "Generator 3 · seed baru gen3-ml7 (dinilai sekali)", "generator4": "Generator 4 · ditulis buta (dinilai sekali)"}
KAND = ("A1", "A2", "A3", "A4")  # simplest first (ties go left)
NJ = 12


def say(*a) -> None:
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def famili(sk: str) -> str:
    s = sk[4:] if sk.startswith("aug:") else sk
    if s in DS.SK2FAM:
        return DS.SK2FAM[s]
    try:
        import generator4 as G4
        return G4.SKEMA4.get(s, {}).get("famili", "lain")
    except Exception:  # noqa: BLE001
        return "lain"


def _blok(X, y, sk, grup, seg, gen) -> dict:
    return {"X": X, "y": np.asarray(y).astype(int), "sk": np.asarray(sk).astype(str), "grup": np.asarray(grup).astype(str),
            "seg": np.asarray(seg).astype(bool), "gen": np.full(len(y), gen)}


def muat_semua() -> dict:
    D = VG.muat_data()
    out = {}
    for nm, m in (("g1_tr", D["latih"]), ("g1_dev", D["val"])):
        out[nm] = _blok(M.fitur("K1", D["X1"][m], D["X4"][m], None), D["y"][m], D["sk"][m], np.char.add("g1:", D["peserta"][m].astype(str)),
                        D["pertama"][m], "g1")
    del D
    for nm, d, gen in (("g2_tr", M.G2_LATIH, "g2"), ("g2_dev", M.G2_DEV, "g2"), ("g2h_tr", G2H_LATIH, "g2h"), ("g2h_dev", G2H_DEV, "g2h")):
        U = M.muat_set(d)
        # G2 and G2-halus draw from the same member pool: one group key per member across both
        out[nm] = _blok(M.fitur("K1", U["X1"], U["X4"], None), U["y"], U["sk"], np.char.add("g2:", U["peserta"].astype(str)), U["pertama"], gen)
        del U
    for k, v in out.items():
        say(k, len(v["y"]), int(v["y"].sum()))
    return out


def gabung(*bs: dict) -> dict:
    return {k: np.concatenate([b[k] for b in bs]) for k in bs[0]}


def latih_m(X, y, w=None, seeds=VG.SEEDS) -> list:
    import lightgbm as lgb

    return [lgb.LGBMClassifier(**VG.P1, n_jobs=NJ, random_state=s).fit(X, y, sample_weight=w) for s in seeds]


def rec_fpr(s: np.ndarray, y: np.ndarray, fpr: float = 0.01) -> float:
    t = VG.ambang_fpr(s[y == 0], fpr)
    return float((s[y == 1] > t).mean())


# ---- candidate recipes ---------------------------------------------------------------------------------------------
def bobot_seimbang(T: dict) -> np.ndarray:
    gens = np.unique(T["gen"])
    w = np.ones(len(T["y"]))
    for c in (0, 1):
        tot = (T["y"] == c).sum()
        for g in gens:
            m = (T["gen"] == g) & (T["y"] == c)
            if m.any():
                w[m] = tot / (len(gens) * m.sum())
    return w


def bobot_dro(T: dict) -> tuple[np.ndarray, dict]:
    import lightgbm as lgb
    from sklearn.model_selection import GroupKFold

    X, y = T["X"], T["y"]
    oof = np.zeros(len(y))
    for a, b in GroupKFold(n_splits=4).split(X, y, T["grup"]):
        oof[b] = lgb.LGBMClassifier(**VG.P1, n_jobs=NJ, random_state=0).fit(X[a], y[a]).predict_proba(X[b])[:, 1]
    p = np.clip(oof, 1e-6, 1 - 1e-6)
    ll = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    key = np.array([f"{g}:{famili(s) if yy else 'normal'}" for g, s, yy in zip(T["gen"], T["sk"], y)])
    w = np.ones(len(y))
    tab = {}
    for c in (0, 1):
        ks = np.unique(key[y == c])
        loss = {k: float(ll[key == k].mean()) for k in ks}
        mu = float(np.mean(list(loss.values())))
        for k in ks:
            f = float(np.clip(loss[k] / mu, 0.5, 4.0))
            w[key == k] = f
            tab[k] = {"n": int((key == k).sum()), "logloss": round(loss[k], 4), "bobot": round(f, 3)}
    return w, tab


def tidak_stabil(Xa, ya, Xb, yb) -> np.ndarray:
    ea, eb = DS.auc_kolom(Xa, ya) - 0.5, DS.auc_kolom(Xb, yb) - 0.5
    return np.flatnonzero((np.abs(ea - eb) >= 0.10) | ((np.sign(ea) != np.sign(eb)) & (np.abs(ea) >= 0.05) & (np.abs(eb) >= 0.05)))


def acak_konteks(T: dict, U: np.ndarray, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    X = T["X"].copy()
    if len(U) == 0:
        return X
    for g in np.unique(T["gen"]):
        fr = np.flatnonzero((T["gen"] == g) & (T["y"] == 1))
        nr = np.flatnonzero((T["gen"] == g) & (T["y"] == 0))
        pick = fr[rng.random(len(fr)) < 0.5]
        donor = rng.choice(nr, size=len(pick))
        X[np.ix_(pick, U)] = X[np.ix_(donor, U)]
    return X


def paruh(grup: np.ndarray) -> np.ndarray:
    return np.array([int(hashlib.md5(g.encode()).hexdigest()[:8], 16) % 2 for g in grup], bool)


def resep(kand: str, T: dict, U: np.ndarray | None = None) -> tuple[list, dict]:
    """Train one candidate on training block T. U = unstable columns for A4 (computed by the caller without held-out data)."""
    info: dict = {}
    if kand == "A1":
        return latih_m(T["X"], T["y"]), info
    if kand == "A2":
        if len(np.unique(T["gen"])) == 1:
            info["catatan"] = "satu generator: sama dengan A1"
        return latih_m(T["X"], T["y"], bobot_seimbang(T)), info
    if kand == "A3":
        w, tab = bobot_dro(T)
        info["grup"] = tab
        return latih_m(T["X"], T["y"], w), info
    if kand == "A4":
        info["n_tidak_stabil"] = int(len(U))
        return latih_m(acak_konteks(T, U), T["y"]), info
    raise ValueError(kand)


def latih() -> None:
    import joblib
    from sklearn.metrics import average_precision_score
    from sklearn.model_selection import GroupKFold

    import lightgbm as lgb

    S = muat_semua()
    names = list(joblib.load(HERE / "model_v3_bersih" / "model.joblib")["agg_names"]) + list(__import__("fitur_v4").NAMES)
    # ---- leave-one-generator-out
    arah = {"latih_G1_uji_G2": (S["g1_tr"], gabung(S["g2_dev"], S["g2h_dev"])),
            "latih_G2_uji_G1": (gabung(S["g2_tr"], S["g2h_tr"]), S["g1_dev"])}
    U_arah = {}
    for an, (T, _) in arah.items():
        if an == "latih_G1_uji_G2":  # only generator 1 in training: halves of its members (A vs B)
            h = paruh(T["grup"])
            U_arah[an] = tidak_stabil(T["X"][h], T["y"][h], T["X"][~h], T["y"][~h])
        else:  # generator 2 vs generator 2-halus
            g = T["gen"] == "g2"
            U_arah[an] = tidak_stabil(T["X"][g], T["y"][g], T["X"][~g], T["y"][~g])
        say("LOGO", an, "fitur tidak stabil", len(U_arah[an]))
    logo: dict = {k: {} for k in KAND}
    for an, (T, V) in arah.items():
        for k in KAND:
            if k == "A2" and len(np.unique(T["gen"])) == 1 and "A1" in logo and an in logo["A1"]:
                logo[k][an] = dict(logo["A1"][an], catatan="satu generator: sama dengan A1")
                continue
            ms, _ = resep(k, T, U_arah[an])
            s = M.skor(ms, V["X"])
            logo[k][an] = {"recall_fpr1": round(rec_fpr(s, V["y"]), 4), "auprc": round(float(average_precision_score(V["y"], s)), 4)}
            say("LOGO", k, an, logo[k][an])
    for k in KAND:
        logo[k]["terburuk"] = round(min(v["recall_fpr1"] for a, v in logo[k].items() if a in arah), 4)
        logo[k]["rata"] = round(float(np.mean([v["recall_fpr1"] for a, v in logo[k].items() if a in arah])), 4)
    # ---- pooled: every candidate trained on all training generators, dev recall per dev set
    T = gabung(S["g1_tr"], S["g2_tr"], S["g2h_tr"])
    g1m, g2m = T["gen"] == "g1", T["gen"] == "g2"
    U_all = tidak_stabil(T["X"][g1m], T["y"][g1m], T["X"][g2m], T["y"][g2m])
    say("gabungan: fitur tidak stabil G1 vs G2", len(U_all), [names[j] for j in U_all[:12]])
    devs = {"g1": S["g1_dev"], "g2": S["g2_dev"], "g2h": S["g2h_dev"]}
    Vall = gabung(*devs.values())
    b5 = joblib.load(M.MODEL / "model.joblib")
    gab, models, infos = {}, {}, {}
    ref = {dn: round(rec_fpr(M.skor(b5["models"], dv["X"]), dv["y"]), 4) for dn, dv in devs.items()}
    gab["A0"] = {"per_dev": ref, "rata": round(float(np.mean(list(ref.values()))), 4)}
    say("A0 (ML v5) dev", gab["A0"])
    for k in KAND:
        ms, info = resep(k, T, U_all)
        models[k], infos[k] = ms, info
        per = {dn: round(rec_fpr(M.skor(ms, dv["X"]), dv["y"]), 4) for dn, dv in devs.items()}
        gab[k] = {"per_dev": per, "rata": round(float(np.mean(list(per.values()))), 4)}
        say("gabungan", k, gab[k])
    # ---- selection (pre-registered)
    best = max(KAND, key=lambda k: logo[k]["terburuk"])
    urut = [k for k in KAND if logo[best]["terburuk"] - logo[k]["terburuk"] < 0.01]
    pilih, alasan = None, []
    for k in urut + [k for k in sorted(KAND, key=lambda k: -logo[k]["terburuk"]) if k not in urut]:
        if gab[k]["rata"] >= gab["A1"]["rata"] - 0.03:
            pilih = k
            break
        alasan.append(f"{k} gagal penjaga dev gabungan ({gab[k]['rata']} < {gab['A1']['rata']} - 0,03)")
    say("PILIHAN", pilih, alasan)
    # ---- thresholds per candidate on pooled dev normals; overfit checks on the pick
    simpan = {}
    for k in KAND:
        s_all = M.skor(models[k], Vall["X"])
        simpan[k] = {"models": models[k], "ambang_periksa": VG.ambang_fpr(s_all[Vall["y"] == 0], 0.01),
                     "ambang_tahan": VG.ambang_fpr(s_all[Vall["y"] == 0], 0.001), "info": infos[k]}
    ms = models[pilih]
    Xtr = acak_konteks(T, U_all) if pilih == "A4" else T["X"]
    auc_in = float(average_precision_score(T["y"], M.skor(ms, Xtr)))
    oof = np.zeros(len(T["y"]))
    for a_, b_ in GroupKFold(n_splits=4).split(Xtr, T["y"], T["grup"]):
        oof[b_] = lgb.LGBMClassifier(**VG.P1, n_jobs=NJ, random_state=0).fit(Xtr[a_], T["y"][a_]).predict_proba(Xtr[b_])[:, 1]
    auc_oof = float(average_precision_score(T["y"], oof))
    auc_dev = {dn: round(float(average_precision_score(dv["y"], M.skor(ms, dv["X"]))), 4) for dn, dv in devs.items()}
    seed_rec = {dn: [round(rec_fpr(m_.predict_proba(dv["X"])[:, 1], dv["y"]), 4) for m_ in ms] for dn, dv in devs.items()}
    gain = np.mean([m_.booster_.feature_importance("gain") for m_ in ms], axis=0)
    gain = gain / max(gain.sum(), 1e-12)
    top = [{"fitur": names[j], "porsi": round(float(gain[j]), 4)} for j in np.argsort(-gain)[:15]]
    sidik = [j for j, nm in enumerate(names) if nm in DS_SIDIK]
    cek = {"auprc_latih_insample": round(auc_in, 4), "auprc_latih_oof_per_peserta": round(auc_oof, 4), "auprc_dev": auc_dev,
           "selisih_insample_oof": round(auc_in - auc_oof, 4), "recall_dev_per_seed": seed_rec,
           "porsi_gain_blok": {"X1 klaim sendiri": round(float(gain[:124].sum()), 4), "X1 tetangga graph": round(float(gain[124:624].sum()), 4),
                               "X4 mekanisme": round(float(gain[624:646].sum()), 4)},
           "porsi_gain_sidik_jari": round(float(gain[sidik].sum()), 4), "fitur_teratas": top,
           "peringatan": [w for w in ((f"selisih in-sample vs OOF {auc_in - auc_oof:.3f} > 0,10" if auc_in - auc_oof > 0.10 else None),
                                      (f"satu fitur memegang {top[0]['porsi'] * 100:.0f}% gain" if top[0]["porsi"] > 0.30 else None),
                                      ("sebaran recall antar-seed > 3 poin" if any(max(v) - min(v) > 0.03 for v in seed_rec.values()) else None)) if w]}
    g5 = np.mean([m_.booster_.feature_importance("gain") for m_ in b5["models"]], axis=0); g5 = g5 / g5.sum()
    cek["porsi_gain_sidik_jari_ml_v5"] = round(float(g5[sidik].sum()), 4)
    say("cek overfit", json.dumps(cek, ensure_ascii=False)[:900])
    MODEL.mkdir(exist_ok=True)
    joblib.dump({"pilihan": pilih, "kandidat": simpan, "tidak_stabil": U_all.tolist()}, MODEL / "model.joblib")
    kartu = {"dibekukan": time.strftime("%Y-%m-%d %H:%M"), "kriteria": "testing/kriteria_ml_v7.json", "pilihan": pilih, "alasan_lewati": alasan,
             "logo": logo, "gabungan": gab, "tidak_stabil": {"jumlah": int(len(U_all)), "fitur": [names[j] for j in U_all]},
             "tidak_stabil_logo": {a: int(len(u)) for a, u in U_arah.items()}, "dro_grup": infos["A3"].get("grup"),
             "latih": {k: int(len(S[k]["y"])) for k in ("g1_tr", "g2_tr", "g2h_tr")}, "fraud_latih": int(T["y"].sum()),
             "dev": {k: int(len(S[k]["y"])) for k in ("g1_dev", "g2_dev", "g2h_dev")},
             "ambang": {k: {"periksa": simpan[k]["ambang_periksa"], "tahan": simpan[k]["ambang_tahan"]} for k in KAND}, "cek_overfit": cek}
    (MODEL / "kartu.json").write_text(json.dumps(kartu, ensure_ascii=False, indent=1, default=float), "utf-8")
    say("DIBEKUKAN", pilih)


# the four signals the diagnosis found missing in generator 3 (reported only; not used to train or choose)
DS_SIDIK = {"v4: domisili_fktp_jarak", "klaim: hari_sejak_sebelumnya", "v4: domisili_tinggal_jarak", "tetangga RS sama: klaim: hari_sejak_sebelumnya"}


def benchmark() -> None:
    import joblib
    from sklearn.metrics import average_precision_score

    tanda = MODEL / "benchmark_sekali.txt"
    assert (MODEL / "kartu.json").exists(), "latih dulu"
    assert not tanda.exists(), f"benchmark sudah dijalankan ({tanda.read_text('utf-8').strip()}): generator 3 dan 4 hanya dinilai sekali"
    for nama, d in UJI.items():  # the new sets must be complete (8 chunks); generator 1 and 2 sets are the ones used before
        n = len(list(d.glob("hasil_[0-9][0-9].npz")))
        assert n == 8 if nama in ("generator3", "generator4") else n > 0, f"{d} belum lengkap ({n})"
    K = json.loads((MODEL / "kartu.json").read_text("utf-8"))
    b7 = joblib.load(MODEL / "model.joblib")
    pilih = b7["pilihan"]
    b5 = joblib.load(M.MODEL / "model.joblib")
    b4 = joblib.load(V4.MODEL / "model.joblib")
    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "pilihan": pilih, "kartu": K, "set": {}}
    for nama, d in UJI.items():
        U = M.muat_set(d)
        y, g = U["y"], U["grup"]
        X = M.fitur("K1", U["X1"], U["X4"], None)
        sc, fl = {}, {}
        r = A.skor(b3, U["X1"], U["X2"], U["XR"])
        sc["v3_bersih"], fl["v3_bersih"] = np.asarray(r["cal"], float), np.asarray(r["flag"], bool)
        sc["v4"] = M.skor(b4["models"], V4.fitur("B", U["X1"], U["X4"]))
        fl["v4"] = sc["v4"] > b4["ambang_periksa"]
        sc["A0"] = M.skor(b5["models"], X)
        fl["A0"] = M.tandai(sc["A0"], U["pertama"], b5["ambang_periksa"])
        for k in KAND:
            sc[k] = M.skor(b7["kandidat"][k]["models"], X)
            fl[k] = sc[k] > b7["kandidat"][k]["ambang_periksa"]
        fam = np.array([famili(s) for s in U["sk"]])
        model = {}
        for k in sc:
            f = fl[k]
            model[k] = {**RT.ukur(y, f), "auprc": round(float(average_precision_score(y, sc[k])), 4),
                        "recall_fpr1": round(rec_fpr(sc[k], y), 4),
                        "famili": {fm: round(float(f[(y == 1) & (fam == fm)].mean()), 4) for fm in np.unique(fam[y == 1])},
                        "per_skema": VG.recall_per_skema(U["sk"][y == 1], f[y == 1])}
        out["set"][nama] = {"label": LABEL_UJI[nama], "klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 5),
                            "skema": int(len(np.unique(U["sk"][y == 1]))),
                            "famili_n": {fm: int(((y == 1) & (fam == fm)).sum()) for fm in np.unique(fam[y == 1])}, "model": model,
                            "ci_vs_A0": {k: RT.boot_selisih(y, fl["A0"], fl[k], g) for k in KAND},
                            "ci_pilihan_vs_v4": RT.boot_selisih(y, fl["v4"], fl[pilih], g)}
        say(nama, {k: (model[k]["recall"], model[k]["fpr"], model[k]["presisi_prev2"], model[k]["auprc"]) for k in model})
    ci = out["set"]["generator4"]["ci_vs_A0"][pilih]
    m4 = out["set"]["generator4"]["model"]
    lolos = ci["recall"][0] > 0 and (m4[pilih]["presisi_prev2"] - m4["A0"]["presisi_prev2"]) >= -0.02
    out["adopsi"] = {"lolos": bool(lolos), "aturan": json.loads((HERE / "kriteria_ml_v7.json").read_text("utf-8"))["adopsi"],
                     "ci_recall_g4": ci["recall"], "selisih_prec2_g4": round(m4[pilih]["presisi_prev2"] - m4["A0"]["presisi_prev2"], 4)}
    say("ADOPSI", out["adopsi"])
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    tanda.write_text(time.strftime("%Y-%m-%d %H:%M"), "utf-8")
    say("ditulis", OUT)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["latih", "benchmark"])
    a = ap.parse_args()
    VG.LOCK_NAMA = f"ml-v7-{a.perintah}"
    with VG.kunci_berat():
        latih() if a.perintah == "latih" else benchmark()
