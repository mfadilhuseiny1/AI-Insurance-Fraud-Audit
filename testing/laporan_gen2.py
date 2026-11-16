"""Report of the v3 workflow on generator 2 (testing/generator2.py, uji_gen2.py) for ML Studio: data/aip/ml/sistem_terbaru/generator2.json,
also written into sistem.json (laporan_ml.py reads the same file), so /api/ml-sistem serves it without rebuilding the rest.

Compared with test B (generator 1's fresh test, used once for v3's published numbers) with the same metric code. The verdict
"konsisten" uses criteria fixed in this file BEFORE the generator 2 results were looked at (KRITERIA). Aggregates only, no claim
rows. Synthetic data only.

Usage: .venv/Scripts/python.exe testing/laporan_gen2.py"""
from __future__ import annotations

import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

os.environ.setdefault("BLUESANDAI_AUTH", "off")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import arsitektur_v2 as A  # noqa: E402
import generator2 as G  # noqa: E402

G2 = G.KERJA
UJI_B = ROOT / ".tmp" / "uji100k_b"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "generator2.json"
SISTEM = OUT.parent / "sistem.json"
MODEL_NAMA = {"model_v3": "v3 (dipakai /testing)", "model_v3_tanpa_vime": "v3 tanpa VIME (kandidat)", "model_v2": "v2", "model": "v1"}
# "konsisten" with test B, fixed before the results were seen: (consistent up to, partly consistent up to); beyond = not consistent
KRITERIA = {"recall_pp": (5.0, 15.0), "fpr_rasio": (1.5, 3.0), "presisi_pp": (5.0, 15.0)}
LABEL_B = {"cincin_bentuk_baru": "Collusion ring bentuk baru (uji B)"}


def idn(v: float, d: int = 0) -> str:
    return f"{v:,.{d}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def ukur(y: np.ndarray, f: np.ndarray, s: np.ndarray, cal: np.ndarray | None = None) -> dict:
    from sklearn.metrics import average_precision_score, roc_auc_score

    y, f = y.astype(bool), f.astype(bool)
    tp, fp, fn, tn = int((f & y).sum()), int((f & ~y).sum()), int((~f & y).sum()), int((~f & ~y).sum())
    p, r = tp / max(1, tp + fp), tp / max(1, tp + fn)
    fpr = fp / max(1, fp + tn)
    mcc_d = np.sqrt(float(tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    out = {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(p, 4), "recall": round(r, 4), "fpr": round(fpr, 5),
           "f1": round(2 * p * r / max(1e-12, p + r), 4), "akurasi": round((tp + tn) / max(1, len(y)), 5),
           "akurasi_seimbang": round((r + (1 - fpr)) / 2, 4), "mcc": round((tp * tn - fp * fn) / mcc_d, 4) if mcc_d else 0.0,
           "auprc": round(float(average_precision_score(y, s)), 4), "auroc": round(float(roc_auc_score(y, s)), 4), "prevalensi": round(float(y.mean()), 5)}
    if cal is not None:
        out["brier"] = round(float(np.mean((cal - y) ** 2)), 5)
        b = np.clip((cal * 10).astype(int), 0, 9)
        out["ece"] = round(float(sum(abs(cal[b == i].mean() - y[b == i].mean()) * (b == i).mean() for i in range(10) if (b == i).any())), 5)
    return out


def bootstrap(y: np.ndarray, f: np.ndarray, s: np.ndarray, grup: np.ndarray, n: int = 400, seed: int = 0) -> dict:
    """95 % intervals by resampling whole chunks (claims of one chunk share hospitals and rings)."""
    from sklearn.metrics import average_precision_score

    rng = np.random.default_rng(seed)
    gs = np.unique(grup)
    idx = {g: np.flatnonzero(grup == g) for g in gs}
    acc = {"recall": [], "precision": [], "fpr": [], "auprc": []}
    for _ in range(n):
        ii = np.concatenate([idx[g] for g in rng.choice(gs, len(gs))])
        yy, ff = y[ii].astype(bool), f[ii].astype(bool)
        acc["recall"].append(ff[yy].mean()); acc["precision"].append(yy[ff].mean() if ff.any() else 0); acc["fpr"].append(ff[~yy].mean())
        acc["auprc"].append(average_precision_score(yy, s[ii]))
    return {k: [round(float(np.percentile(v, 2.5)), 5), round(float(np.percentile(v, 97.5)), 5)] for k, v in acc.items()}


def per_chunk(y: np.ndarray, f: np.ndarray, grup: np.ndarray) -> list[dict]:
    out = []
    for g in np.unique(grup):
        m = grup == g
        yy, ff = y[m].astype(bool), f[m].astype(bool)
        out.append({"chunk": int(g), "klaim": int(m.sum()), "fraud": int(yy.sum()), "recall": round(float(ff[yy].mean()), 4),
                    "precision": round(float(yy[ff].mean()) if ff.any() else 0.0, 4), "fpr": round(float(ff[~yy].mean()), 5)})
    return out


def prec_pada(r: dict, ps: list[float]) -> list[float]:
    return [round(r["recall"] * p / max(1e-12, r["recall"] * p + r["fpr"] * (1 - p)), 4) for p in ps]


def tingkat(nilai: float, batas: tuple[float, float]) -> str:
    return "konsisten" if nilai <= batas[0] else "sebagian" if nilai <= batas[1] else "tidak konsisten"


def main() -> None:
    import duckdb
    import joblib

    t0 = time.time()
    # ---- generator 2
    files = sorted(G2.glob("hasil_[0-9][0-9].npz"))
    ds = [np.load(f) for f in files]
    g = {k: np.concatenate([d[k] for d in ds]) for k in ds[0].files if k not in ("X1", "X2", "XR")}
    g["chunk"] = np.concatenate([np.full(len(d["sk"]), int(f.stem[-2:])) for d, f in zip(ds, files)])
    sk = g["sk"].astype(str)
    y = sk != "normal"
    S = {m: dict(np.load(G2 / f"skor_{m}.npz")) for m in ("model_v3", "model_v3_tanpa_vime", "model_v2", "model")}
    rule = np.isin(g["keputusan"].astype(str), ["PERIKSA", "TAHAN"])
    v3 = S["model_v3"]
    # ---- test B (generator 1), the same metric code
    fb = sorted(UJI_B.glob("hasil_[0-9][0-9].npz"))
    dbs = [np.load(f) for f in fb]
    skb = np.concatenate([d["sk"] for d in dbs]).astype(str)
    yb = skb != "normal"
    chb = np.concatenate([np.full(len(d["sk"]), i) for i, d in enumerate(dbs)])
    B = dict(np.load(UJI_B / "skor_model_v3.npz"))
    ruleb = np.concatenate([d["tahan"] | d["periksa"] for d in dbs]).astype(bool)

    ringkas = {m: ukur(y, S[m]["flag"], S[m]["ps"], S[m].get("cal")) for m in S}
    ringkas["rule"] = {k: v for k, v in ukur(y, rule, g["skor_rule"]).items()}
    rb = ukur(yb, B["flag"], B["ps"], B["cal"])
    ci = {"gen2": bootstrap(y, v3["flag"], v3["ps"], g["chunk"]), "uji_b": bootstrap(yb, B["flag"], B["ps"], chb)}
    chunks = {"gen2": per_chunk(y, v3["flag"], g["chunk"]), "uji_b": per_chunk(yb, B["flag"], chb)}

    # ---- per scheme
    b3 = joblib.load(HERE / "model_v3" / "model.joblib")
    lewat_model = v3["cal"] >= b3["ambang_peluang"]
    skema = []
    semua = sorted(set(sk) | set(skb))
    for s in semua:
        if s == "normal":
            continue
        m, mb = sk == s, skb == s
        meta = G.SKEMA.get(s)
        fam = meta[2] if meta else A.famili_dari(s)
        row = {"skema": s, "label": meta[0] if meta else LABEL_B.get(s, s), "modus": meta[1] if meta else ("M10" if "cincin" in s else ""),
               "famili": fam, "baru": bool(meta and meta[3]), "di_uji_b": bool(mb.any()), "di_gen2": bool(m.any()),
               "n_gen2": int(m.sum()), "n_uji_b": int(mb.sum())}
        if m.any():
            row.update(recall_gen2=round(float(v3["flag"][m].mean()), 4), recall_gen2_tanpa_vime=round(float(S["model_v3_tanpa_vime"]["flag"][m].mean()), 4),
                       recall_gen2_v1=round(float(S["model"]["flag"][m].mean()), 4), recall_rule_gen2=round(float(rule[m].mean()), 4),
                       lewat={"model": round(float(lewat_model[m].mean()), 4), "rute": round(float((v3["rute"].astype(bool) & ~lewat_model)[m].mean()), 4),
                              "jaringan": round(float((v3["jaringan_rule"].astype(bool) & ~lewat_model & ~v3["rute"].astype(bool))[m].mean()), 4)},
                       median_peluang=round(float(np.median(v3["cal"][m])), 3))
            var = Counter(g["varian"][m].astype(str))
            if len(var) > 1 or (var and next(iter(var)) != ""):
                row["varian"] = [{"varian": k, "n": int(n), "recall": round(float(v3["flag"][m & (g["varian"].astype(str) == k)].mean()), 4)} for k, n in var.items()]
        if mb.any():
            row.update(recall_uji_b=round(float(B["flag"][mb].mean()), 4), recall_rule_uji_b=round(float(ruleb[mb].mean()), 4))
        skema.append(row)
    skema.sort(key=lambda r: (not r["di_gen2"], r.get("recall_gen2", 2)))
    famili = []
    for f, d in [*A.FAMILI.items(), ("jaringan", A.JARINGAN)]:
        mg = np.array([(G.SKEMA.get(s) or ("", "", None))[2] == f for s in sk])
        mb = np.array([A.famili_dari(s) == f for s in skb])
        famili.append({"famili": f, "nama": d["nama"], "n_gen2": int(mg.sum()), "recall_gen2": round(float(v3["flag"][mg].mean()), 4) if mg.any() else None,
                       "n_uji_b": int(mb.sum()), "recall_uji_b": round(float(B["flag"][mb].mean()), 4) if mb.any() else None})
    bersama = [r for r in skema if r["di_gen2"] and r["di_uji_b"]]
    mb_sama = np.isin(sk, [r["skema"] for r in bersama])
    mbb_sama = np.isin(skb, [r["skema"] for r in bersama])
    recall_bersama = {"gen2": round(float(v3["flag"][mb_sama].mean()), 4), "uji_b": round(float(B["flag"][mbb_sama].mean()), 4),
                      "n_gen2": int(mb_sama.sum()), "n_uji_b": int(mbb_sama.sum())}
    mbaru = np.isin(sk, [s for s, v in G.SKEMA.items() if v[3]])
    recall_baru = round(float(v3["flag"][mbaru].mean()), 4) if mbaru.any() else None

    # ---- normal claims flagged: which layer, which signals
    fpm = v3["flag"].astype(bool) & ~y
    sig_fp = Counter(s_ for x in g["sinyal"][fpm].astype(str) for s_ in x.split())
    sig_n = Counter(s_ for x in g["sinyal"][~y].astype(str) for s_ in x.split())
    normal_ditandai = {"n": int(fpm.sum()), "lewat": {"model": int((fpm & lewat_model).sum()), "rute": int((fpm & v3["rute"].astype(bool) & ~lewat_model).sum()),
                                                      "jaringan": int((fpm & v3["jaringan_rule"].astype(bool) & ~lewat_model & ~v3["rute"].astype(bool)).sum())},
                       "sinyal": [{"kode": k, "n": int(n), "laju_semua_normal": round(sig_n[k] / max(1, int((~y).sum())), 5)} for k, n in sig_fp.most_common(8)],
                       "tanpa_sinyal": int(sum(1 for x in g["sinyal"][fpm].astype(str) if not x.strip()))}

    # ---- fidelity: generator 2 normals against test B normals (generator 1)
    asal = np.concatenate([d["asal"] for d in dbs]).astype(str)[~yb]
    con = duckdb.connect()
    con.register("ids", __import__("pandas").DataFrame({"id": np.unique(asal)}))
    q = con.execute(f"""SELECT tingkat_pelayanan = 'RITL' ritl, coalesce(los_hari, 0) los, biaya_tagih_rp biaya, coalesce(jumlah_dx_sekunder, 0) dxs,
                       (sa_tarif_rp + sp_tarif_rp + rr_tarif_rp + si_tarif_rp + sd_tarif_rp) > 0 topup, prosedur IS NOT NULL pros, kelas_rawat
                       FROM read_parquet('{G.SILVER.as_posix()}') WHERE edisi = 'reguler' AND kunjungan_fkrtl_id::VARCHAR IN (SELECT id FROM ids)""").df()
    n_ = ~y
    gr = g["tingkat"][n_].astype(str) == "RITL"
    fid = [
        {"ukuran": "Rawat inap", "gen2": round(float(gr.mean()), 4), "gen1": round(float(q.ritl.mean()), 4), "jenis": "pct"},
        {"ukuran": "Lama rawat inap (rata-rata hari)", "gen2": round(float(g["los"][n_][gr].mean()), 2), "gen1": round(float(q.los[q.ritl].mean()), 2), "jenis": "angka"},
        {"ukuran": "Biaya rawat inap (median)", "gen2": float(np.median(g["biaya"][n_][gr])), "gen1": float(q.biaya[q.ritl].median()), "jenis": "rp"},
        {"ukuran": "Biaya rawat jalan (median)", "gen2": float(np.median(g["biaya"][n_][~gr])), "gen1": float(q.biaya[~q.ritl].median()), "jenis": "rp"},
        {"ukuran": "Diagnosis sekunder (rata-rata)", "gen2": round(float(g["dxs"][n_].mean()), 2), "gen1": round(float(q.dxs.mean()), 2), "jenis": "angka"},
        {"ukuran": "Klaim dengan top-up", "gen2": round(float((g["topup"][n_] > 0).mean()), 4), "gen1": round(float(q.topup.mean()), 4), "jenis": "pct"},
        {"ukuran": "Klaim dengan prosedur", "gen2": round(float(g["prosedur"][n_].mean()), 4), "gen1": round(float(q.pros.mean()), 4), "jenis": "pct"},
        {"ukuran": "Rawat inap di atas kelas 3", "gen2": round(float((g["kelas"][n_][gr].astype(str) != "Kelas 3").mean()), 4),
         "gen1": round(float((q.kelas_rawat[q.ritl] != "Kelas 3").mean()), 4), "jenis": "pct"},
        {"ukuran": "Rule: perlu diperiksa / ditahan", "gen2": round(float(rule[n_].mean()), 4), "gen1": round(float(ruleb[~yb].mean()), 4), "jenis": "pct"},
    ]
    # can a classifier tell the two generators' normal claims apart (C2ST)? own claim block (124 features) and the full row (+ neighbours)
    from lightgbm import LGBMClassifier
    from sklearn.model_selection import cross_val_predict
    from sklearn.metrics import roc_auc_score

    rng = np.random.default_rng(0)
    X1g = [d["X1"] for d in ds]  # loaded once (an npz member is read again on every access)
    X1b = [d["X1"] for d in dbs]
    Xg = np.vstack([x[d["sk"].astype(str) == "normal"] for x, d in zip(X1g, ds)])
    Xb = np.vstack([x[d["sk"].astype(str) == "normal"] for x, d in zip(X1b, dbs)])
    ng = min(20000, len(Xg), len(Xb))
    Xg, Xb = Xg[rng.choice(len(Xg), ng, replace=False)], Xb[rng.choice(len(Xb), ng, replace=False)]
    yy = np.r_[np.ones(ng), np.zeros(ng)]
    nsys = len(b3["sys_names"])
    c2st = {}
    for nama, cols in (("klaim", slice(0, nsys)), ("lengkap", slice(None))):
        X = np.vstack([Xg[:, cols], Xb[:, cols]])
        p = cross_val_predict(LGBMClassifier(n_estimators=200, learning_rate=0.05, num_leaves=31, verbose=-1, random_state=0), X, yy, cv=5, method="predict_proba")[:, 1]
        mdl = LGBMClassifier(n_estimators=200, learning_rate=0.05, num_leaves=31, verbose=-1, random_state=0).fit(X, yy)
        gain = mdl.booster_.feature_importance("gain")
        names = (b3["sys_names"] if nama == "klaim" else b3["agg_names"])
        top = np.argsort(-gain)[:6]
        c2st[nama] = {"auc": round(float(roc_auc_score(yy, p)), 4), "fitur": [{"fitur": str(names[i]) if i < len(names) else f"f{i}", "gain_pct": round(float(gain[i] / gain.sum() * 100), 1)} for i in top]}

    # ---- why normal claims are flagged: the member's first visit to this hospital (found 2026-11-12 on the first generator 2 run).
    # Test B and training data v2 move earlier claims into the window and leave the original in the history, at the same hospital,
    # so none of their normal claims is a first visit; the stream's are 20 %, its fraud 67 %.
    sn = b3["sys_names"]
    kf, hs = sn.index("klaim: kunjungan_peserta_faskes"), sn.index("klaim: hari_sejak_sebelumnya")
    import latih_v2 as LV

    st_ = np.load(ROOT / ".tmp" / "v2_stream.npz", allow_pickle=True)
    Xs_full = st_["X1"]
    Xs, ys = Xs_full[:, :nsys], ~np.isin(st_["sk"].astype(str), A.NORMAL)
    V = LV.muat_v2(list(range(10)))
    Xv, yv = V["X1"][:, :nsys], ~np.isin(V["sk"].astype(str), A.NORMAL)
    Xg1 = np.vstack([x[:, :nsys] for x in X1g])
    Xb1 = np.vstack([x[:, :nsys] for x in X1b])
    nol = float(min(Xs[:, kf].min(), Xg1[:, kf].min()))  # zero earlier visits of the member to this hospital, standardized
    pertama = lambda X: X[:, kf] <= nol + 1e-6  # noqa: E731
    pg, pb_ = pertama(Xg1), pertama(Xb1)
    f3 = v3["flag"].astype(bool)
    sumber = [{"sumber": "Aliran replay (latih)", "normal": round(float(pertama(Xs)[~ys].mean()), 4), "fraud": round(float(pertama(Xs)[ys].mean()), 4), "n_normal": int((~ys).sum())},
              {"sumber": "Data latih v2 (klaim dipindah)", "normal": round(float(pertama(Xv)[~yv].mean()), 4), "fraud": round(float(pertama(Xv)[yv].mean()), 4), "n_normal": int((~yv).sum())},
              {"sumber": "Uji B (klaim dipindah)", "normal": round(float(pb_[~yb].mean()), 4), "fraud": round(float(pb_[yb].mean()), 4), "n_normal": int((~yb).sum())},
              {"sumber": "Generator 2", "normal": round(float(pg[~y].mean()), 4), "fraud": round(float(pg[y].mean()), 4), "n_normal": int((~y).sum())}]
    kelompok = []
    for nama, m in (("Kunjungan pertama ke RS ini", pg), ("Pernah ke RS ini", ~pg)):
        kelompok.append({"kelompok": nama, "normal": int((m & ~y).sum()), "fraud": int((m & y).sum()), "fpr": round(float(f3[m & ~y].mean()), 4),
                         "recall": round(float(f3[m & y].mean()), 4) if (m & y).any() else None,
                         "precision": round(float(y[m & f3].mean()), 4) if (m & f3).any() else None})
    kelompok.append({"kelompok": "Uji B (semua pernah ke RS ini)", "normal": int((~yb).sum()), "fraud": int(yb.sum()), "fpr": rb["fpr"], "recall": rb["recall"], "precision": rb["precision"]})
    # what pushes the flagged normal claims up: Model 1 contributions (TreeSHAP), flagged against unflagged normal claims
    m1 = b3["komponen"]["model1"]
    ofs = np.cumsum([0] + [len(d["sk"]) for d in ds])

    def baris_x1(ix: np.ndarray) -> np.ndarray:  # rows of the full Model 1 matrix without stacking all 200.000
        c_ = np.searchsorted(ofs, ix, side="right") - 1
        return np.vstack([X1g[c][i - ofs[c]] for c, i in zip(c_, ix)])

    rs_ = np.random.default_rng(1)
    a_ = rs_.choice(np.flatnonzero(f3 & ~y), min(3000, int((f3 & ~y).sum())), replace=False) if (f3 & ~y).any() else np.array([], int)
    o_ = rs_.choice(np.flatnonzero(~f3 & ~y), 3000, replace=False)
    kontribusi = []
    if len(a_):
        bst = m1["model"].booster_
        sel_ = (lambda X: X) if m1["kolom"] is None else (lambda X: X[:, m1["kolom"]])
        ca, co = bst.predict(sel_(baris_x1(a_)), pred_contrib=True)[:, :-1].mean(0), bst.predict(sel_(baris_x1(o_)), pred_contrib=True)[:, :-1].mean(0)
        nm_ = b3["agg_names"] if m1["kolom"] is None else [b3["agg_names"][j] for j in m1["kolom"]]
        kontribusi = [{"fitur": str(nm_[j]), "selisih": round(float(ca[j] - co[j]), 3)} for j in np.argsort(-(ca - co))[:8]]
    # train/serve skew (found 2026-11-12): the stream's training rows were computed in one batch (fitur.agg_matrix), data v2, the
    # tests and the live service one claim at a time (Stream.agg_row); near-constant neighbour features then differ in the last float
    # digits (-0.154408872 vs -0.154408887) and Model 1 splits exactly between them, so it can tell the source of a row. Diagnostic:
    # snap each served value to the batch value it differs from only by rounding, and score again (no model or threshold changed).
    U = {j: np.unique(Xs_full[:, j]) for j in range(Xs_full.shape[1]) if len(np.unique(Xs_full[:, j])) <= 60}

    def snap(X: np.ndarray) -> np.ndarray:
        X = X.copy()
        for j, u in U.items():
            v = X[:, j]
            k = np.clip(np.searchsorted(u, v), 1, len(u) - 1)
            lo, hi = u[k - 1], u[k]
            dekat = np.where(np.abs(v - lo) <= np.abs(hi - v), lo, hi)
            ok = np.abs(dekat - v) <= 1e-6 * (1 + np.abs(v))
            X[ok, j] = dekat[ok]
        return X

    def nilai(f: np.ndarray, yy: np.ndarray, pv: np.ndarray | None = None) -> dict:
        f, yy = f.astype(bool), yy.astype(bool)
        o = {"recall": round(float(f[yy].mean()), 4), "precision": round(float(yy[f].mean()) if f.any() else 0.0, 4), "fpr": round(float(f[~yy].mean()), 5)}
        if pv is not None:
            o["fpr_kunjungan_pertama"] = round(float(f[~yy & pv].mean()), 4)
            o["fpr_pernah"] = round(float(f[~yy & ~pv].mean()), 5)
        return o

    sg = A.skor(b3, snap(np.vstack(X1g)), np.vstack([d["X2"] for d in ds]), np.vstack([d["XR"] for d in ds]))
    sb = A.skor(b3, snap(np.vstack(X1b)), np.vstack([d["X2"] for d in dbs]), np.vstack([d["XR"] for d in dbs]))
    # splits that fall inside the rounding noise, by the strict test (peer review, 2026-11-12): the training rows (stream + data v2) have
    # values within 2 x tol on BOTH sides of the threshold, i.e. the split separates numbers that differ only in the last float digits.
    # (A first, looser test, "threshold within tol of a stream value", also counted the ordinary splits at 0: 987 splits, 15.5 %.)
    latih_x = {"X1": (Xs_full, V["X1"]), "X2": (st_["X2"], V["X2"])}
    urut_nilai: dict = {}

    def nilai_latih(inp: str, col: int) -> np.ndarray:
        if (inp, col) not in urut_nilai:
            a_, b_ = latih_x[inp]
            urut_nilai[(inp, col)] = np.unique(np.concatenate([a_[:, col], b_[:, col]]).astype(np.float64))
        return urut_nilai[(inp, col)]

    def hitung_bising(komp: dict) -> dict:
        n_, g_, gt_ = 0, 0.0, 0.0
        stack = [t["tree_structure"] for t in komp["model"].booster_.dump_model()["tree_info"]]
        while stack:
            nd = stack.pop()
            if "split_feature" not in nd:
                continue
            gt_ += nd.get("split_gain", 0.0)
            col = nd["split_feature"] if komp["kolom"] is None else int(komp["kolom"][nd["split_feature"]])
            t, tol = float(nd["threshold"]), 1e-6 * (1 + abs(float(nd["threshold"])))
            # both conditions (as testing/node_gen2.py split_bulat): the threshold sits at a near-discrete stream value, and the training
            # rows have values within 2 x tol on both sides of it
            if komp["input"] == "X1" and col in U and np.min(np.abs(U[col] - t)) <= tol:
                u = nilai_latih(komp["input"], col)
                k_ = np.searchsorted(u, t, side="right")
                kiri, kanan = (u[k_ - 1] if k_ > 0 else -np.inf), (u[k_] if k_ < len(u) else np.inf)
                if t - kiri <= 2 * tol and kanan - t <= 2 * tol:
                    n_ += 1; g_ += nd.get("split_gain", 0.0)
            stack += [nd["left_child"], nd["right_child"]]
        return {"split": n_, "gain_pct": round(g_ / max(1e-9, gt_) * 100, 2)}

    split_komp = {k: hitung_bising(c) for k, c in b3["komponen"].items()}
    urut_nilai.clear()
    skew = {"gen2": {"dijalankan": nilai(v3["flag"], y, pg), "tanpa_skew": nilai(sg["flag"], y, pg)},
            "uji_b": {"dijalankan": nilai(B["flag"], yb), "tanpa_skew": nilai(sb["flag"], yb)},
            "split": split_komp["model1"]["split"], "gain_pct": split_komp["model1"]["gain_pct"], "split_komponen": split_komp,
            "split_uji": "ambang di nilai aliran yang hampir diskret, dan nilai latih dalam 2 x toleransi di kedua sisinya", "kolom": len(U),
            "contoh": {"fitur": "tetangga RS sama: klaim: jenis_fkrtl=Klinik Utama", "batch": -0.154408872, "per_klaim": -0.154408887}}
    fs_ = sg["flag"].astype(bool)
    for row in skema:
        if row["di_gen2"]:
            row["recall_gen2_tanpa_skew"] = round(float(fs_[sk == row["skema"]].mean()), 4)
        if row["di_uji_b"]:
            row["recall_uji_b_tanpa_skew"] = round(float(sb["flag"].astype(bool)[skb == row["skema"]].mean()), 4)
    penyebab = {"sumber": sumber, "kelompok": kelompok, "kontribusi": kontribusi, "skew": skew,
                "batas_hari": round(float(np.quantile(Xg1[~y, hs], 0.99)), 3)}

    # ---- calibration: does a probability of 0.8 still mean 80 %?
    def reliab(cal: np.ndarray, yy: np.ndarray) -> list[dict]:
        b = np.clip((cal * 10).astype(int), 0, 9)
        return [{"bin": i / 10, "n": int((b == i).sum()), "prediksi": round(float(cal[b == i].mean()), 4), "teramati": round(float(yy[b == i].mean()), 4)}
                for i in range(10) if (b == i).sum() >= 20]

    kalibrasi = {"gen2": reliab(v3["cal"], y), "uji_b": reliab(B["cal"], yb.astype(float))}

    # ---- the verdict, by the fixed criteria
    pb = float(yb.mean())
    pr_g2_pb = prec_pada(ringkas["model_v3"], [pb])[0]
    d_recall = abs(ringkas["model_v3"]["recall"] - rb["recall"]) * 100
    d_recall_sama = abs(recall_bersama["gen2"] - recall_bersama["uji_b"]) * 100
    r_fpr = max(ringkas["model_v3"]["fpr"], rb["fpr"]) / max(1e-9, min(ringkas["model_v3"]["fpr"], rb["fpr"]))
    d_prec = abs(pr_g2_pb - rb["precision"]) * 100
    kriteria = [
        {"ukuran": "Recall, semua skema", "gen2": ringkas["model_v3"]["recall"], "uji_b": rb["recall"], "selisih": round(d_recall, 1), "satuan": "poin",
         "batas": KRITERIA["recall_pp"], "hasil": tingkat(d_recall, KRITERIA["recall_pp"])},
        {"ukuran": "Recall, skema yang ada di keduanya", "gen2": recall_bersama["gen2"], "uji_b": recall_bersama["uji_b"], "selisih": round(d_recall_sama, 1),
         "satuan": "poin", "batas": KRITERIA["recall_pp"], "hasil": tingkat(d_recall_sama, KRITERIA["recall_pp"])},
        {"ukuran": "Klaim normal ditandai (FPR)", "gen2": ringkas["model_v3"]["fpr"], "uji_b": rb["fpr"], "selisih": round(r_fpr, 2), "satuan": "x",
         "batas": KRITERIA["fpr_rasio"], "hasil": tingkat(r_fpr, KRITERIA["fpr_rasio"])},
        {"ukuran": f"Precision pada fraud {idn(pb * 100, 1)}% (prevalensi uji B)", "gen2": pr_g2_pb, "uji_b": rb["precision"], "selisih": round(d_prec, 1),
         "satuan": "poin", "batas": KRITERIA["presisi_pp"], "hasil": tingkat(d_prec, KRITERIA["presisi_pp"])},
    ]
    urut = ["konsisten", "sebagian", "tidak konsisten"]
    vonis = max((k["hasil"] for k in kriteria), key=urut.index)
    tingkat_p = sorted({0.001, 0.002, 0.005, 0.01, 0.02, round(pb, 4), round(float(y.mean()), 4), 0.05})

    # ---- findings, computed
    r3 = ringkas["model_v3"]
    lemah = [r for r in skema if r["di_gen2"] and r["recall_gen2"] < 0.6]
    turun = sorted([r for r in bersama if r["recall_uji_b"] - r["recall_gen2"] >= 0.1], key=lambda r: r["recall_gen2"] - r["recall_uji_b"])
    temuan = [
        {"ikon": "check" if r3["recall"] >= 0.8 else "alert", "nada": "baik" if r3["recall"] >= 0.8 else "buruk",
         "judul": f"Recall {idn(r3['recall'] * 100, 1)}% di generator 2 (uji B {idn(rb['recall'] * 100, 1)}%)",
         "isi": f"{idn(r3['tp'])} dari {idn(r3['tp'] + r3['fn'])} fraud tertangkap; interval 95% {idn(ci['gen2']['recall'][0] * 100, 1)}–{idn(ci['gen2']['recall'][1] * 100, 1)}%."},
        {"ikon": "alert" if r3["fpr"] > rb["fpr"] * KRITERIA["fpr_rasio"][0] else "check", "nada": "buruk" if r3["fpr"] > rb["fpr"] * KRITERIA["fpr_rasio"][0] else "baik",
         "judul": f"Klaim normal ditandai {idn(r3['fpr'] * 100, 2)}% (uji B {idn(rb['fpr'] * 100, 2)}%)",
         "isi": f"{idn(r3['fp'])} dari {idn(r3['fp'] + r3['tn'])} klaim normal; precision {idn(r3['precision'] * 100, 1)}% pada fraud {idn(r3['prevalensi'] * 100, 1)}%."},
        {"ikon": "layers", "nada": "netral", "judul": f"Skema yang sama di kedua generator: {idn(recall_bersama['gen2'] * 100, 1)}% vs {idn(recall_bersama['uji_b'] * 100, 1)}%",
         "isi": f"{len(bersama)} skema ada di uji B dan generator 2, ditulis dengan parameter berbeda."},
    ]
    kp, kl_ = penyebab["kelompok"][0], penyebab["kelompok"][1]
    sk_ = penyebab["skew"]
    temuan.insert(2, {"ikon": "bug", "nada": "buruk", "judul": f"Bug fitur: Model 1 membedakan sumber baris dari pembulatan angka ({sk_['split']} split)",
                      "isi": f"Tanpa selisih pembulatan itu: generator 2 recall {idn(sk_['gen2']['tanpa_skew']['recall'] * 100)}%, FPR {idn(sk_['gen2']['tanpa_skew']['fpr'] * 100, 1)}%; "
                             f"uji B recall {idn(sk_['uji_b']['tanpa_skew']['recall'] * 100)}% (dipublikasikan {idn(sk_['uji_b']['dijalankan']['recall'] * 100)}%)."})
    temuan.insert(2, {"ikon": "eye", "nada": "buruk" if kp["fpr"] > 0.05 else "netral",
                      "judul": f"Pasien yang baru pertama ke RS itu: {idn(kp['fpr'] * 100, 0)}% klaim normalnya ditandai",
                      "isi": f"Pasien yang pernah ke RS itu: {idn(kl_['fpr'] * 100, 1)}%. Data latih v2 dan uji B tidak punya satu pun klaim normal kunjungan pertama, "
                             f"aliran latih {idn(penyebab['sumber'][0]['normal'] * 100, 0)}% (fraudnya {idn(penyebab['sumber'][0]['fraud'] * 100, 0)}%)."})
    if recall_baru is not None:
        rk = {r["skema"]: r for r in skema}
        ph, up = rk.get("phantom_billing", {}), rk.get("upcoding_prosedur", {})
        temuan.append({"ikon": "search", "nada": "buruk", "judul": f"Skema yang tidak pernah ditulis generator 1: {idn(recall_baru * 100, 1)}%, tapi lewat jalan pintas",
                       "isi": f"Phantom billing {idn(ph.get('recall_gen2', 0) * 100)}% tetapi {idn(ph.get('recall_gen2_tanpa_skew', 0) * 100)}% tanpa bug pembulatan: tertangkap karena "
                              f"pesertanya pasien baru di RS itu. Upcoding ke kode prosedur {idn(up.get('recall_gen2', 0) * 100)}%."})
    if turun:
        temuan.append({"ikon": "eye", "nada": "buruk", "judul": f"Turun ≥ 10 poin dari uji B: {len(turun)} skema",
                       "isi": ", ".join(f"{r['label'].split(' (')[0]} {idn(r['recall_uji_b'] * 100)}% → {idn(r['recall_gen2'] * 100)}%" for r in turun[:4])})
    if lemah:
        temuan.append({"ikon": "alert", "nada": "buruk", "judul": f"Recall < 60%: {len(lemah)} skema", "isi": ", ".join(f"{r['label'].split(' (')[0]} {idn(r['recall_gen2'] * 100)}%" for r in lemah[:5])})
    temuan.append({"ikon": "graph", "nada": "netral", "judul": f"Pembeda dua generator: AUC {idn(c2st['klaim']['auc'], 2)}",
                   "isi": f"Terutama dari '{c2st['klaim']['fitur'][0]['fitur'].replace('klaim: ', '')}' ({idn(c2st['klaim']['fitur'][0]['gain_pct'])}% gain): klaim uji B selalu punya "
                          "klaim aslinya di riwayat. Biaya, lama rawat, top-up dan prosedur hampir sama (0,5 = tak bisa dibedakan)."})

    out = {
        "dibuat": time.strftime("%Y-%m-%d %H:%M"), "chunk": len(files), "klaim": int(len(y)), "fraud": int(y.sum()), "normal": int((~y).sum()),
        "anggota": int(len(np.unique(g["peserta"]))), "riwayat": round(float(g["riwayat"].mean()), 4),
        "ringkas": ringkas, "uji_b": rb, "ci": ci, "chunks": chunks, "model_nama": MODEL_NAMA,
        "skema": skema, "famili": famili, "recall_bersama": recall_bersama, "recall_baru": recall_baru,
        "normal_ditandai": normal_ditandai, "fidelitas": fid, "c2st": c2st, "kalibrasi": kalibrasi,
        "prevalensi": {"tingkat": tingkat_p, "gen2": prec_pada(r3, tingkat_p), "uji_b": prec_pada(rb, tingkat_p), "p_gen2": round(float(y.mean()), 5), "p_uji_b": round(pb, 5)},
        "penyebab": penyebab, "kriteria": kriteria, "vonis": vonis, "kriteria_batas": KRITERIA, "temuan": temuan,
        "beda": ["Klaim normal disusun per field dari model parametrik (campuran kasus RS, NB lama rawat dan diagnosis sekunder, buku tarif, top-up log-normal), tidak menyalin baris klaim",
                 "Perjalanan peserta: 80% punya klaim sebelumnya, kunjungan ulang diambil bersama (jeda, RS, kode) dari data 1–14 Nov",
                 "Fraud ditulis ulang dari definisi Permenkes 16/2019 dengan parameter sendiri, ditetapkan sebelum hasil dilihat",
                 "Dua skema yang tidak pernah ditulis generator 1: phantom billing dan upcoding ke kode prosedur",
                 "Fraud dan normal diambil dari peserta yang sama, tanpa sidik jari plant generator 1"],
        "batas": ["Dunia yang sama: RS, kode, buku tarif, registri peserta dan riwayat klaim adalah data sintetis generator 1",
                  "Parameter generator 2 diukur dari klaim generator 1, jadi kedua generator berbagi pola agregat",
                  "Model v3 sudah melihat klaim lain dari RS yang sama lewat fitur tetangga; peserta data latih dikeluarkan",
                  "Uji B dan data latih v2 memindah klaim lama ke jendela: klaim aslinya tetap di riwayat RS yang sama, jadi tidak ada klaim normal kunjungan pertama; generator 2 tidak punya jejak itu",
                  "Angka 'tanpa selisih pembulatan' adalah diagnosis (nilai fitur disamakan dengan versi batch), bukan sistem yang berjalan",
                  "model_v3 dinilai pada fitur tanpa VIME, padahal dilatih dengan anomali VIME di skor rule (menyala ~0,2% klaim latih)",
                  "Prevalensi fraud generator 2 berbeda dari uji B; precision dibandingkan pada prevalensi yang sama",
                  "Perbaikan generator sebelum uji penuh (tanpa melihat skor model): kunjungan ulang diambil bersama, pita umur lebih halus, pemilihan peserta menurut jarak klaim terakhir, top-up tersebar"],
        "detik": round(time.time() - t0, 1),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    if SISTEM.exists() and not os.environ.get("GEN2_TANPA_SISTEM"):  # served without re-running laporan_ml.py (which also reads generator2.json)
        s = json.loads(SISTEM.read_text("utf-8"))
        s["generator2"] = out
        SISTEM.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    print("written", OUT, "vonis", vonis, {k: (v["recall"], v["precision"], v["fpr"], v["auprc"]) for k, v in ringkas.items()},
          "test B", (rb["recall"], rb["precision"], rb["fpr"], rb["auprc"]), "c2st", {k: v["auc"] for k, v in c2st.items()})


if __name__ == "__main__":
    main()
