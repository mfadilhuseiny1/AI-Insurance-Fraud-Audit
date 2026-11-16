"""ML v7 · metrik juri (the user, 2026-11-15: "bikin report v7 sesuai metrik2 permintaan juri ... F1 score, FP TP FN TN, confusion
matrix, metrik2 ml"). The Healthkathon 2026 coaching deck (2026-10-23) asks for: precision@k at a stated capacity + lift over
random, rupiah recall@k, the share of honest hospitals audited (by class, region, size), conditions varied one dial at a time,
a fraud type the model never saw, honest cases that look like fraud, the fraud rate next to every precision, intervals by
resampling HOSPITALS (not claims), and whether the model earns its place next to the rules.

What this does NOT do: train, pick, or move a threshold. It re-scores the FROZEN models (testing/model_ml_v7 pick A1,
testing/model_ml_v5, testing/model_v4) on the SAME four test sets ml_v7.py benchmarked once, checks the operating point
reproduces ml_v7_benchmark.json, and adds metrics. The adoption decision in ml_v7_benchmark.json stands as written.
Per-claim scores go to .tmp/ml_v7_skor (never served); data/aip/ml/sistem_terbaru/ml_v7_metrik_juri.json holds aggregates only.

  python testing/ml_v7_metrik_juri.py            score (once) + metrics
  python testing/ml_v7_metrik_juri.py --cache    metrics from .tmp/ml_v7_skor
Synthetic data only."""
from __future__ import annotations

import argparse
import json
import os
import pickle
import sys
import time
from pathlib import Path

import numpy as np

os.environ.setdefault("BLUESANDAI_AUTH", "off")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "api"))
import ml_v5 as M  # noqa: E402
import ml_v7 as M7  # noqa: E402
import v4_final as V4  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

CACHE = M.TMP / "ml_v7_skor"
OUT = M.ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "ml_v7_metrik_juri.json"
BENCH = M.ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "ml_v7_benchmark.json"
B = 1000
K = 0.01  # capacity share (stated assumption, see KAPASITAS)
K_SWEEP = (0.005, 0.01, 0.02, 0.05)
PREV_SWEEP = (0.005, 0.01, 0.02, 0.05, 0.10, 0.20)
KAPASITAS = {"porsi": K, "verifikator": 4, "kasus_per_hari": 10, "hari_kerja": 10, "klaim_jendela": 40000, "jendela_hari": 14,
             "asumsi": "k = 4 verifikator × 10 kasus/hari × 10 hari kerja = 400 kasus per 2 minggu ≈ 1% dari ±40.000 klaim set uji. "
                       "Asumsi, bukan angka operasional BPJS; hasil juga dilaporkan pada k = 0,5%, 2%, 5%."}
MODELS = ("ml_v7", "ml_v5", "v4")
NAMA = {"ml_v7": "ML v7", "ml_v5": "ML v5", "v4": "v4", "aturan": "Rule engine saja", "gabungan": "Rule engine + ML v7", "acak": "Acak"}


def say(*a) -> None:
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def r4(v, d: int = 4):
    if v is None:
        return None
    v = float(v)
    return None if not np.isfinite(v) else round(v, d)


def q95(a) -> list:
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    return [r4(np.percentile(a, 2.5)), r4(np.percentile(a, 97.5))] if len(a) else [None, None]


def p_dua(d) -> float:
    """Two-sided bootstrap p for a paired difference (share of replicates on the other side of 0, doubled; floor 1/B)."""
    d = np.asarray(d, float)
    d = d[np.isfinite(d)]
    p = 2 * min((d <= 0).mean(), (d >= 0).mean())
    return r4(max(p, 1 / len(d)))


def wilson(x: int, n: int) -> list:
    if n == 0:
        return [None, None]
    z, p = 1.96, x / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [r4(max(0, c - h)), r4(min(1, c + h))]


# ---- hospitals ------------------------------------------------------------------------------------------------------
def tabel_rs() -> dict:
    import generator3 as G3

    class _U(pickle.Unpickler):
        def find_class(self, module, name):
            return G3.Tab if name == "Tab" else super().find_class(module, name)

    with open(G3.OUT / "model.pkl", "rb") as fh:
        return _U(fh).load()["rs"]


def kelas_rs(t) -> str:
    if not t:
        return "Tidak tercatat"
    if t.startswith("Khusus"):
        return "RS khusus"
    if "TNI" in t:
        return "RS TNI/Polri"
    for c in "ABCD":
        if t.endswith(f"Kelas {c}") or t.endswith(f"Type {c}"):
            return f"Kelas {c}"
    return "Lainnya"


def milik_rs(k) -> str:
    if not k:
        return "Tidak tercatat"
    if k.startswith("Pemerintah") or k == "Vertikal":
        return "Pemerintah"
    if k.startswith("TNI") or k == "POLRI":
        return "TNI/Polri"
    return k if k in ("Swasta", "BUMN") else "Lainnya"


# ---- scoring (once) -------------------------------------------------------------------------------------------------
def skor_semua() -> None:
    import joblib

    CACHE.mkdir(exist_ok=True)
    b7 = joblib.load(M7.MODEL / "model.joblib")
    P = b7["pilihan"]
    b5 = joblib.load(M.MODEL / "model.joblib")
    b4 = joblib.load(V4.MODEL / "model.joblib")
    for nama, d in M7.UJI.items():
        U = M.muat_set(d)
        raw = U["raw"]
        sk_raw = np.concatenate([x["sk"].astype(str) for x in raw])
        keep = ~np.isin(sk_raw, list(V4.MUTU))
        assert keep.sum() == len(U["y"])

        def kol(k, dt=None):
            if k not in raw[0].files:
                return None
            v = np.concatenate([x[k] for x in raw])[keep]
            return v.astype(dt) if dt else v

        X = M.fitur("K1", U["X1"], U["X4"], None)
        s7 = M.skor(b7["kandidat"][P]["models"], X)
        s5 = M.skor(b5["models"], X)
        s4 = M.skor(b4["models"], V4.fitur("B", U["X1"], U["X4"]))
        z = {"y": U["y"].astype(np.int8), "sk": U["sk"].astype(str), "faskes": U["faskes"].astype(str), "peserta": U["peserta"].astype(str),
             "tgl": U["tgl"].astype(str), "kode": U["kode"].astype(str),
             "s_ml_v7": s7, "f_ml_v7": s7 > b7["kandidat"][P]["ambang_periksa"],
             "s_ml_v5": s5, "f_ml_v5": M.tandai(s5, U["pertama"], b5["ambang_periksa"]),
             "s_v4": s4, "f_v4": s4 > b4["ambang_periksa"]}
        kp = kol("keputusan", str)
        if kp is not None:
            z["f_aturan"], z["s_aturan"] = kp != "LOLOS", kol("skor_rule", float)
        else:  # generator 1 run: the rule engine's two flags, no score (ordinal: hold > check > pass)
            th, pe = kol("tahan", bool), kol("periksa", bool)
            z["f_aturan"], z["s_aturan"] = th | pe, 2.0 * th + 1.0 * pe
        for k, dt in (("biaya", float), ("los", float), ("tingkat", str), ("dx", str)):
            v = kol(k, dt)
            if v is not None:
                z[k] = v
        np.savez_compressed(CACHE / f"{nama}.npz", **z)
        say(nama, len(z["y"]), int(z["y"].sum()), "skor disimpan")
        del U, X


# ---- metrics --------------------------------------------------------------------------------------------------------
def cm_metrik(tp, fp, fn, tn) -> dict:
    tp, fp, fn, tn = (np.asarray(v, float) for v in (tp, fp, fn, tn))
    with np.errstate(all="ignore"):
        pos, neg = tp + fn, fp + tn
        n = pos + neg
        prec, rec, spec = tp / (tp + fp), tp / pos, tn / neg
        acc = (tp + tn) / n
        pe = ((tp + fp) * pos + (fn + tn) * neg) / (n * n)
        return {"presisi": prec, "recall": rec, "spesifisitas": spec, "fpr": fp / neg, "fnr": fn / pos, "npv": tn / (tn + fn),
                "akurasi": acc, "akurasi_seimbang": (rec + spec) / 2, "f1": 2 * tp / (2 * tp + fp + fn), "f2": 5 * tp / (5 * tp + 4 * fn + fp),
                "f05": 1.25 * tp / (1.25 * tp + 0.25 * fn + fp),
                "mcc": (tp * tn - fp * fn) / np.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)), "kappa": (acc - pe) / (1 - pe)}


class Boot:
    """Hospital-cluster bootstrap: B replicates of hospitals drawn with replacement (claims of a hospital move together)."""

    def __init__(self, faskes: np.ndarray, seed: int = 0):
        self.u, self.inv = np.unique(faskes, return_inverse=True)
        self.nh = len(self.u)
        rng = np.random.default_rng(seed)
        self.W = np.stack([np.bincount(rng.integers(0, self.nh, self.nh), minlength=self.nh) for _ in range(B)]).astype(np.float64)

    def tot(self, x: np.ndarray) -> np.ndarray:
        return self.W @ np.bincount(self.inv, weights=np.asarray(x, float), minlength=self.nh)

    def w(self, b: int) -> np.ndarray:
        return self.W[b][self.inv]


def cm_blok(y, f, bt: Boot) -> dict:
    y, f = y.astype(bool), f.astype(bool)
    c = {"tp": int((y & f).sum()), "fp": int((~y & f).sum()), "fn": int((y & ~f).sum()), "tn": int((~y & ~f).sum())}
    pt = cm_metrik(c["tp"], c["fp"], c["fn"], c["tn"])
    bs = cm_metrik(bt.tot(y & f), bt.tot(~y & f), bt.tot(y & ~f), bt.tot(~y & ~f))
    return {**c, "ditandai": int(f.sum()), **{k: r4(v) for k, v in pt.items()}, "ci": {k: q95(bs[k]) for k in pt}}, bs


def urutan(s: np.ndarray, seed: int = 1) -> np.ndarray:
    """Descending score; ties broken at random (fixed seed) so a coarse score (the rule engine's) is not ranked by file order."""
    return np.lexsort((np.random.default_rng(seed).random(len(s)), -np.asarray(s, float)))


def auc_cepat(order, y, w) -> tuple[float, float]:
    """Weighted ROC-AUC and average precision from a fixed descending order (ties ignored: bootstrap only)."""
    ws, ys = w[order], y[order].astype(float)
    wp, wn = ws * ys, ws * (1 - ys)
    Wp, Wn = wp.sum(), wn.sum()
    neg_atas = np.cumsum(wn) - wn
    roc = 1 - float((wp * neg_atas).sum() / (Wp * Wn))
    ctp, cw = np.cumsum(wp), np.cumsum(ws)
    ap = float((wp / Wp * ctp / np.maximum(cw, 1e-12)).sum())
    return roc, ap


def pada_k(order, y, w, share, biaya=None, inv=None, nh=None, jujur_h=None, Wh=None) -> dict:
    """Metrics among the top `share` of (weighted) claims of a ranking."""
    ws, ys = w[order], y[order].astype(float)
    cw = np.cumsum(ws)
    i = int(np.searchsorted(cw, share * cw[-1]))
    top = slice(0, i + 1)
    wt = ws[top]
    tp, nk, pos = float((wt * ys[top]).sum()), float(wt.sum()), float((ws * ys).sum())
    prev = pos / cw[-1]
    o = {"k": nk, "presisi": tp / nk if nk else np.nan, "recall": tp / pos if pos else np.nan}
    o["lift"] = o["presisi"] / prev if prev else np.nan
    if biaya is not None:
        bs = biaya[order]
        o["rupiah_recall"] = float((wt * ys[top] * bs[top]).sum() / max((ws * ys * bs).sum(), 1e-9))
        o["rupiah_temuan"] = float((wt * ys[top] * bs[top]).sum())
    if jujur_h is not None:
        aud = np.zeros(nh, bool)
        aud[inv[order[top]][wt > 0]] = True
        o["rs_jujur_diaudit"] = float(Wh[jujur_h & aud].sum() / max(Wh[jujur_h].sum(), 1e-9))
        o["rs_jujur_diaudit_n"] = int((jujur_h & aud & (Wh > 0)).sum())
    return o


def pada_k_boot(order, y, share, bt: Boot, biaya=None, jujur_h=None, mask_fn=None) -> tuple[dict, dict]:
    """Point estimate (+ CI by hospital bootstrap) of pada_k. mask_fn(b, rng) -> per-claim 0/1 multiplier (subsampled conditions)."""
    rng = np.random.default_rng(11)
    one = np.ones(len(y))
    if mask_fn is None:
        pt = pada_k(order, y, one, share, biaya, bt.inv, bt.nh, jujur_h, np.ones(bt.nh))
    else:  # point = mean over 200 subsamples of the full hospital set
        draws = [pada_k(order, y, mask_fn(rng), share, biaya, bt.inv, bt.nh, jujur_h, np.ones(bt.nh)) for _ in range(200)]
        pt = {k: float(np.nanmean([d[k] for d in draws])) for k in draws[0]}
    reps = []
    for b in range(B):
        w = bt.w(b) * (mask_fn(rng) if mask_fn else 1.0)
        reps.append(pada_k(order, y, w, share, biaya, bt.inv, bt.nh, jujur_h, bt.W[b]))
    bs = {k: np.array([r[k] for r in reps]) for k in reps[0]}
    return pt, bs


def kurva(y, s) -> dict:
    from sklearn.metrics import precision_recall_curve, roc_curve

    fpr, tpr, _ = roc_curve(y, s)
    g = np.r_[0, np.geomspace(1e-4, 1, 70)]
    roc = [[r4(x, 5), r4(np.interp(x, fpr, tpr))] for x in g]
    p, r, _ = precision_recall_curve(y, s)
    gr = np.linspace(0.01, 1, 60)
    pr = [[r4(x, 3), r4(p[r >= x].max() if (r >= x).any() else 0)] for x in gr]
    return {"roc": roc, "pr": pr}


def nilai_set(nama: str, Z: dict, RS: dict, bench: dict) -> dict:
    from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

    t0 = time.time()
    y = Z["y"].astype(int)
    yb = y.astype(bool)
    n, nf = len(y), int(y.sum())
    prev = nf / n
    bt = Boot(Z["faskes"])
    inv, nh = bt.inv, bt.nh
    fraud_h = np.bincount(inv, weights=y, minlength=nh)
    jujur_h = fraud_h == 0
    biaya = Z.get("biaya")
    hari = len(np.unique(Z["tgl"]))
    out = {"label": bench["label"], "klaim": n, "fraud": nf, "prevalensi": r4(prev, 5), "rs": nh, "rs_jujur": int(jujur_h.sum()),
           "rs_dengan_fraud": int((~jujur_h).sum()), "hari": hari, "rupiah_ada": biaya is not None,
           "rupiah_fraud": r4(biaya[yb].sum(), 0) if biaya is not None else None,
           "k": int(np.ceil(K * n)), "skema_n": int(len(np.unique([VG.skema_dasar(s) for s in Z["sk"][yb]])))}

    # -- check: the operating points reproduce the one-shot benchmark
    pick = bench["pilihan"]
    for k_, kb in (("ml_v7", pick), ("ml_v5", "A0"), ("v4", "v4")):
        f = Z[f"f_{k_}"]
        r, fp = float(f[yb].mean()), float(f[~yb].mean())
        mb = bench["model"][kb]
        assert abs(r - mb["recall"]) < 2e-3 and abs(fp - mb["fpr"]) < 2e-4, (nama, k_, r, mb["recall"], fp, mb["fpr"])
    out["cek_reproduksi"] = "titik operasi ML v7, ML v5, v4 sama dengan ml_v7_benchmark.json (selisih recall < 0,2 poin, FPR < 0,02 poin)"

    # -- confusion matrices at each system's frozen operating point
    flags = {m: Z[f"f_{m}"].astype(bool) for m in MODELS}
    flags["aturan"] = Z["f_aturan"].astype(bool)
    flags["gabungan"] = flags["aturan"] | flags["ml_v7"]
    cm, cmb = {}, {}
    for m, f in flags.items():
        cm[m], cmb[m] = cm_blok(y, f, bt)
    out["cm"] = cm

    # -- threshold-free metrics (models with a continuous score) + curves
    orders = {m: urutan(Z[f"s_{m}"]) for m in MODELS}
    orders["aturan"] = urutan(Z["s_aturan"])
    auc = {}
    for m in MODELS:
        s = Z[f"s_{m}"]
        rocs, aps = zip(*(auc_cepat(orders[m], y, bt.w(b)) for b in range(B)))
        auc[m] = {"roc_auc": r4(roc_auc_score(y, s)), "pr_auc": r4(average_precision_score(y, s)), "brier": r4(brier_score_loss(y, np.clip(s, 0, 1)), 5),
                  "ci": {"roc_auc": q95(rocs), "pr_auc": q95(aps)}}
    s_a = Z["s_aturan"]
    auc["aturan"] = {"roc_auc": r4(roc_auc_score(y, s_a)), "pr_auc": r4(average_precision_score(y, s_a)), "brier": None, "ci": {},
                     "catatan": "skor rule engine (bukan probabilitas)" if "biaya" in Z else "rule engine set ini hanya punya 2 bendera (tahan/periksa), bukan skor"}
    out["auc"] = auc
    out["kurva"] = {m: kurva(y, Z[f"s_{m}"]) for m in ("ml_v7", "ml_v5")}
    out["titik_aturan"] = {"fpr": cm["aturan"]["fpr"], "recall": cm["aturan"]["recall"], "presisi": cm["aturan"]["presisi"]}
    say(nama, "cm + auc", round(time.time() - t0))

    # -- precision@k, lift, recall@k, rupiah recall@k, honest hospitals audited; k sweep
    atk, atk_b = {}, {}
    for m in ("ml_v7", "ml_v5", "aturan"):
        atk[m] = {}
        for sh in K_SWEEP:
            pt, bs = pada_k_boot(orders[m], y, sh, bt, biaya, jujur_h)
            atk[m][str(sh)] = {**{k: r4(v) for k, v in pt.items()}, "ci": {k: q95(bs[k]) for k in ("presisi", "lift", "recall", "rupiah_recall", "rs_jujur_diaudit") if k in bs}}
            if sh == K:
                atk_b[m] = bs
    # random targeting: expected precision = prevalence; expected honest hospitals audited by simulation
    rng = np.random.default_rng(5)
    acak = []
    for _ in range(200):
        o = rng.permutation(n)
        acak.append(pada_k(o, y, np.ones(n), K, biaya, inv, nh, jujur_h, np.ones(nh)))
    atk["acak"] = {str(K): {k: r4(np.mean([a[k] for a in acak])) for k in acak[0]}}
    out["pada_k"] = atk
    say(nama, "pada_k", round(time.time() - t0))

    # -- the rupiah objective (probability × claim amount) vs the probability objective
    if biaya is not None:
        o_rp = urutan(Z["s_ml_v7"] * biaya)
        pt, bs = pada_k_boot(o_rp, y, K, bt, biaya, jujur_h)
        out["objektif"] = {"probabilitas": atk["ml_v7"][str(K)],
                           "rupiah": {**{k: r4(v) for k, v in pt.items()}, "ci": {k: q95(bs[k]) for k in ("presisi", "lift", "recall", "rupiah_recall", "rs_jujur_diaudit")}},
                           "catatan": "rupiah = nilai klaim (biaya). Generator tidak mencatat porsi kelebihan bayar (excess_rupiah), jadi rupiah recall@k di sini "
                                      "memakai nilai klaim fraud utuh: batas atas, bukan kelebihan bayar."}
        orders["ml_v7_rupiah"] = o_rp

    # -- stated fraud rate: precision at the operating point re-weighted to other prevalences (arithmetic, not data)
    r_b, f_b = cmb["ml_v7"]["recall"], cmb["ml_v7"]["fpr"]
    r_p, f_p = cm["ml_v7"]["recall"], cm["ml_v7"]["fpr"]
    out["prevalensi_sweep"] = [{"prevalensi": p, "presisi": r4(VG.presisi_prevalensi(r_p, f_p, p)),
                                "ci": q95([VG.presisi_prevalensi(a, b, p) for a, b in zip(r_b, f_b)])} for p in PREV_SWEEP]

    # -- intervals: claims resampled vs whole hospitals resampled (precision@k of ML v7)
    rngc = np.random.default_rng(3)
    pk_c = [pada_k(orders["ml_v7"], y, np.bincount(rngc.integers(0, n, n), minlength=n).astype(float), K)["presisi"] for _ in range(B)]
    ci_c, ci_h = q95(pk_c), atk["ml_v7"][str(K)]["ci"]["presisi"]
    lc = ci_c[1] - ci_c[0]
    lebar = (ci_h[1] - ci_h[0]) / lc if lc > 1e-6 else None  # both intervals collapse when every top-k claim is fraud
    nk = atk["ml_v7"][str(K)]["k"]
    out["ci_klaster"] = {"presisi_k": atk["ml_v7"][str(K)]["presisi"], "ci_klaim": ci_c, "ci_rs": ci_h, "rasio_lebar": r4(lebar, 2) if lebar else None,
                         "deff": r4(lebar ** 2, 2) if lebar else None, "k": nk, "n_efektif": r4(nk / max(lebar ** 2, 1.0), 0) if lebar else None, "rs_uji": nh,
                         "rs_di_top_k": int(len(np.unique(inv[orders["ml_v7"][: int(round(nk))]])))}

    # -- per scheme (generator 3/4: every scheme is one the model never trained on)
    base = np.array([VG.skema_dasar(s) for s in Z["sk"]])
    topk = np.zeros(n, bool)
    topk[orders["ml_v7"][: int(np.ceil(K * n))]] = True
    try:
        import generator4 as G4
        meta4 = G4.SKEMA4
    except Exception:  # noqa: BLE001
        meta4 = {}
    sk_out = []
    for s in sorted(set(base[yb])):
        m = yb & (base == s)
        ns = int(m.sum())
        f7 = flags["ml_v7"]
        rb = bt.tot(m & f7) / np.maximum(bt.tot(m), 1e-9)
        rb = rb[bt.tot(m) > 0]
        md = meta4.get(s, {}) if nama == "generator4" else {}
        sk_out.append({"skema": s, "famili": M7.famili(s), "n": ns, "rs": int(len(np.unique(inv[m]))), "kehalusan": md.get("kehalusan"), "pelaku": md.get("pelaku"),
                       "recall_ml_v7": r4(f7[m].mean()), "ci": q95(rb) if len(rb) else [None, None], "ci_wilson": wilson(int(f7[m].sum()), ns),
                       "recall_k_ml_v7": r4(topk[m].mean()), "recall_ml_v5": r4(flags["ml_v5"][m].mean()), "recall_aturan": r4(flags["aturan"][m].mean()),
                       "recall_gabungan": r4(flags["gabungan"][m].mean())})
    out["skema"] = sk_out

    # -- honest cases that look like fraud (proxies built from honest claims that share a fraud-like trait)
    nrm = ~yb
    jenis = []
    kode = Z["kode"]
    kemo = np.char.startswith(kode, "C-3-") | np.char.startswith(kode, "C-4-13-")
    jenis.append(("kemo", "Kemoterapi / radioterapi berulang", "sesi terapi kanker yang memang berulang", nrm & kemo))
    jenis.append(("dialisis", "Hemodialisis rutin", "cuci darah 2-3× seminggu, wajar sering", nrm & np.char.startswith(kode, "N-3-15")))
    pes = Z["peserta"]
    up, ip, cp = np.unique(pes, return_inverse=True, return_counts=True)
    jenis.append(("sering", "Peserta kunjungan sering (≥ 3 klaim dalam jendela)", "pasien kronis yang memang sering kontrol", nrm & (cp[ip] >= 3)))
    kls = np.array([kelas_rs(RS.get(f, {}).get("tipe")) for f in bt.u])[inv]
    if "tingkat" in Z:
        ri = Z["tingkat"] == "RITL"
        jenis.append(("tersier", "Rawat inap di RS kelas A/B", "RS rujukan tersier: pasien lebih berat, rawat lebih lama", nrm & ri & np.isin(kls, ["Kelas A", "Kelas B"])))
        if "los" in Z:
            los = Z["los"]
            jenis.append(("los", "Rawat inap panjang (LOS ≥ persentil 95)", "lama rawat memang panjang", nrm & ri & (los >= np.percentile(los[nrm & ri], 95))))
        o = np.lexsort((Z["tgl"], pes))
        ri_o = ri[o]
        prev_ri = np.zeros(n, bool)
        cnt = {}
        for j in range(n):  # an earlier inpatient claim of the same member in the window
            i = o[j]
            if ri_o[j]:
                prev_ri[i] = cnt.get(pes[i], 0) > 0
                cnt[pes[i]] = cnt.get(pes[i], 0) + 1
        jenis.append(("readmisi", "Rawat inap ulang peserta yang sama", "admisi ulang jujur (mis. penyakit kronis kambuh)", nrm & ri & prev_ri))
    if biaya is not None:
        jenis.append(("mahal", "Klaim biaya tertinggi (persentil 99)", "diagnosis berbiaya tinggi yang jarang", nrm & (biaya >= np.percentile(biaya[nrm], 99))))
    fpr_all = cm["ml_v7"]["fpr"]
    hn = []
    for kj, nm, ket, m in jenis:
        nm_ = int(m.sum())
        if nm_ == 0:
            continue
        f7 = flags["ml_v7"]
        den = bt.tot(m)
        rb = (bt.tot(m & f7) / np.maximum(den, 1e-9))[den > 0]
        hn.append({"kunci": kj, "jenis": nm, "keterangan": ket, "n": nm_, "rs": int(len(np.unique(inv[m]))), "fpr_ml_v7": r4(f7[m].mean(), 5), "ci": q95(rb),
                   "rasio": r4(f7[m].mean() / fpr_all if fpr_all else np.nan, 2), "top_k": r4(topk[m].mean(), 5),
                   "fpr_aturan": r4(flags["aturan"][m].mean(), 5), "fpr_ml_v5": r4(flags["ml_v5"][m].mean(), 5)})
    out["hard_negatif"] = {"fpr_semua_jujur": fpr_all, "fpr_aturan_semua": cm["aturan"]["fpr"], "jenis": hn}
    say(nama, "skema + hard negatif", round(time.time() - t0))

    # -- honest hospitals audited, by hospital class / region / ownership / size (ranking by probability; and by rupiah)
    meta = [RS.get(f, {}) for f in bt.u]
    nsamp = np.array([float(r.get("n") or 0) for r in meta])
    t1, t2 = np.percentile(nsamp, [100 / 3, 200 / 3])
    grup = {"kelas": np.array([kelas_rs(r.get("tipe")) for r in meta]),
            "regional": np.array([(r.get("regional") or "tidak tercatat").replace("regional", "Regional") for r in meta]),
            "kepemilikan": np.array([milik_rs(r.get("kep")) for r in meta]),
            "ukuran": np.where(nsamp <= t1, "Kecil", np.where(nsamp <= t2, "Sedang", "Besar"))}

    def diaudit(order) -> np.ndarray:
        a = np.zeros(nh, bool)
        a[inv[order[: int(np.ceil(K * n))]]] = True
        return a

    aud = {"probabilitas": diaudit(orders["ml_v7"])}
    if "ml_v7_rupiah" in orders:
        aud["rupiah"] = diaudit(orders["ml_v7_rupiah"])
    flag_h = np.bincount(inv, weights=flags["ml_v7"] & nrm, minlength=nh)
    nrm_h = np.bincount(inv, weights=nrm, minlength=nh)
    adil = {}
    for gk, g in grup.items():
        rows = []
        for v in sorted(set(g)):
            hm = jujur_h & (g == v)
            nj = int(hm.sum())
            if nj == 0:
                continue
            row = {"grup": v, "rs_jujur": nj, "klaim_jujur": int(nrm_h[g == v].sum()), "fpr_klaim": r4(flag_h[g == v].sum() / max(nrm_h[g == v].sum(), 1), 5)}
            for ok, a in aud.items():
                x = int((hm & a).sum())
                row[ok] = {"diaudit": x, "porsi": r4(x / nj), "ci": wilson(x, nj)}
            rows.append(row)
        top = max(rows, key=lambda r: (r["probabilitas"]["porsi"] if r["rs_jujur"] >= 10 else -1))
        adil[gk] = {"baris": rows, "paling_banyak": top["grup"] if top["probabilitas"]["porsi"] > 0 else None}
    out["keadilan"] = {"semua": {ok: {"diaudit": int((jujur_h & a).sum()), "porsi": r4((jujur_h & a).sum() / jujur_h.sum())} for ok, a in aud.items()}, **adil}
    say(nama, "keadilan", round(time.time() - t0))

    # -- conditions, one dial at a time from the baseline (precision@k at k = 1% of the condition's claims)
    if nama == "generator4":
        hal = np.array([meta4.get(s, {}).get("kehalusan", "") for s in base])
    fh_claim = fraud_h[inv]
    nn_ = int(nrm.sum())
    kond = [("baseline", "Baseline (semua)", None, None)]
    if nama == "generator4":
        kond.append(("sulit", "Skema halus saja (sulit dilihat manusia)", ~yb | (hal == "halus"), None))
        kond.append(("mudah", "Skema kasar saja (kasat mata bagi manusia)", ~yb | (hal == "kasar"), None))
    qr = 0.005 * nn_ / (0.995 * nf)  # keep share of fraud for 0.5 %
    qf = nf * 0.90 / (0.10 * nn_)  # keep share of honest claims for 10 %
    kond.append(("langka", "Langka (fraud 0,5%)", None, lambda rng: np.where(yb, rng.random(n) < qr, 1.0).astype(float)))
    kond.append(("sering", "Sering (fraud 10%)", None, lambda rng: np.where(yb, 1.0, rng.random(n) < qf).astype(float)))
    kond.append(("konsentrasi", "Terkumpul (RS ≥ 5 klaim fraud)", ~yb | (fh_claim >= 5), None))
    kond.append(("tersebar", "Tersebar (RS ≤ 2 klaim fraud)", ~yb | (fh_claim <= 2), None))
    krow = []
    for kk, nm, mtetap, mfn in kond:
        if mtetap is not None and not (mtetap & yb).any():
            continue
        tetap = np.ones(n) if mtetap is None else mtetap.astype(float)
        fn_ = (lambda rng, t=tetap, f=mfn: t * (f(rng) if f else 1.0)) if (mfn or mtetap is not None) else None
        pt, bs = pada_k_boot(orders["ml_v7"], y, K, bt, mask_fn=fn_)
        if mfn is None:
            wv = tetap
        else:
            wv = tetap * mfn(np.random.default_rng(1))
        nfk = float((wv * y).sum())
        rs_f = int(len(np.unique(inv[(wv > 0) & yb])))
        rec_op = float((wv * y * flags["ml_v7"]).sum() / max(nfk, 1e-9))
        krow.append({"kunci": kk, "kondisi": nm, "klaim": int(wv.sum()), "fraud": int(nfk), "prevalensi": r4(nfk / wv.sum(), 5), "rs_fraud": rs_f,
                     "presisi_k": r4(pt["presisi"]), "ci": q95(bs["presisi"]), "recall_k": r4(pt["recall"]), "ci_recall": q95(bs["recall"]),
                     "lift": r4(pt["lift"], 2), "recall_operasi": r4(rec_op)})
    out["kondisi"] = krow
    say(nama, "kondisi", round(time.time() - t0))

    # -- does the model earn its place next to the rules? (paired, same hospital replicates)
    d_f1 = cmb["gabungan"]["f1"] - cmb["aturan"]["f1"]
    d_rec = cmb["gabungan"]["recall"] - cmb["aturan"]["recall"]
    d_pk = atk_b["ml_v7"]["presisi"] - atk_b["aturan"]["presisi"]
    d_rk = atk_b["ml_v7"]["recall"] - atk_b["aturan"]["recall"]
    out["aturan_vs_model"] = {
        "f1": {"aturan": cm["aturan"]["f1"], "gabungan": cm["gabungan"]["f1"], "selisih": r4(cm["gabungan"]["f1"] - cm["aturan"]["f1"]), "ci": q95(d_f1), "p": p_dua(d_f1)},
        "recall": {"aturan": cm["aturan"]["recall"], "gabungan": cm["gabungan"]["recall"], "selisih": r4(cm["gabungan"]["recall"] - cm["aturan"]["recall"]), "ci": q95(d_rec), "p": p_dua(d_rec)},
        "presisi_k": {"aturan": atk["aturan"][str(K)]["presisi"], "ml_v7": atk["ml_v7"][str(K)]["presisi"],
                      "selisih": r4(atk["ml_v7"][str(K)]["presisi"] - atk["aturan"][str(K)]["presisi"]), "ci": q95(d_pk), "p": p_dua(d_pk)},
        "recall_k": {"aturan": atk["aturan"][str(K)]["recall"], "ml_v7": atk["ml_v7"][str(K)]["recall"],
                     "selisih": r4(atk["ml_v7"][str(K)]["recall"] - atk["aturan"][str(K)]["recall"]), "ci": q95(d_rk), "p": p_dua(d_rk)},
        "uji": "bootstrap berpasangan per rumah sakit (1.000 ulangan, replikat RS yang sama untuk kedua sistem); p dua sisi"}
    say(nama, "selesai", round(time.time() - t0), "detik")
    return out


def kartu_bukti(s: dict, nama: str) -> dict:
    a = s["pada_k"]["ml_v7"][str(K)]
    av = s["aturan_vs_model"]
    lemah = sorted([x for x in s["skema"] if x["n"] >= 10], key=lambda x: x["recall_ml_v7"])[:4]
    return {"set": nama, "label": s["label"], "k": int(round(a["k"])), "presisi_k": a["presisi"], "ci": a["ci"]["presisi"], "lift": a["lift"], "ci_lift": a["ci"]["lift"],
            "rupiah_recall_k": a.get("rupiah_recall"), "ci_rupiah": a["ci"].get("rupiah_recall"), "rs_jujur": s["rs_jujur"],
            "rs_jujur_diaudit": a.get("rs_jujur_diaudit_n"), "porsi_rs_jujur": a.get("rs_jujur_diaudit"), "ci_rs_jujur": a["ci"].get("rs_jujur_diaudit"),
            "fraud_benar": int(round(a["presisi"] * a["k"])), "prevalensi": s["prevalensi"], "aturan_vs_model": av,
            "lemah": [{"skema": x["skema"], "recall": x["recall_ml_v7"], "n": x["n"]} for x in lemah]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true", help="pakai skor di .tmp/ml_v7_skor (tanpa menilai ulang)")
    a = ap.parse_args()
    if not a.cache or not all((CACHE / f"{g}.npz").exists() for g in M7.UJI):
        VG.LOCK_NAMA = "ml-v7-metrik-juri"
        with VG.kunci_berat():
            skor_semua()
    bench = json.loads(BENCH.read_text("utf-8"))
    RS = tabel_rs()
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "benchmark_dibuat": bench["dibuat"], "pilihan": bench["pilihan"], "adopsi": bench["adopsi"],
           "kapasitas": KAPASITAS, "bootstrap": B, "nama": NAMA,
           "integritas": ["Model, ambang, dan keputusan adopsi tidak berubah: skrip ini hanya menilai ulang model beku pada set uji yang sama dan "
                          "mengecek titik operasinya sama dengan benchmark sekali-jalan (ml_v7_benchmark.json).",
                          "Metrik di halaman ini ditambahkan setelah benchmark; tidak ada yang dipakai untuk memilih model atau ambang.",
                          "Semua data sintetis. Generator 4 ditulis oleh sesi agen terpisah yang tidak membaca model, fitur, rule engine, atau kriteria; "
                          "itu pemisahan penulis di dalam satu tim, bukan tim lain.",
                          "Latih dan uji dipisah per peserta, bukan per rumah sakit: hampir semua RS di set uji juga ada di data latih."],
           "set": {}}
    for nama in M7.UJI:
        Z = dict(np.load(CACHE / f"{nama}.npz", allow_pickle=False))
        out["set"][nama] = nilai_set(nama, Z, RS, {**bench["set"][nama], "pilihan": bench["pilihan"]})
    out["kartu_bukti"] = {g: kartu_bukti(s, g) for g, s in out["set"].items()}
    # train/test hospital overlap (the split is by member)
    S = np.load(VG.STREAM, allow_pickle=False)
    latih = set(S["faskes"].astype(str))
    for d in ("data_v4", "gen2_ml5_latih", "gen2_ml7h_latih"):
        for f in (M.TMP / d).glob("*.npz"):
            z = np.load(f, allow_pickle=False)
            if "faskes" in z.files:
                latih |= set(z["faskes"].astype(str))
    for g, s in out["set"].items():
        fk = np.unique(np.load(CACHE / f"{g}.npz", allow_pickle=False)["faskes"])
        s["rs_juga_di_latih"] = r4(np.isin(fk, list(latih)).mean())
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    say("ditulis", OUT)


if __name__ == "__main__":
    main()
