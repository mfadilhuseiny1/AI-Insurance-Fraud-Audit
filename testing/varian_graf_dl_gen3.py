"""Exploratory, labelled as such: the graph variants (D = GraphSAGE / R-GCN, E = hybrid LightGBM + out-of-fold GNN outputs) on
generator 3. This is the SECOND use of generator 3: v4 = B was chosen on validation (kriteria_v4.json; E_sage tied with B within
1 point, the simpler B wins) and scored once on 2026-11-13. Nothing here changes that choice.

Same rules as v4 B: models trained on the stream + data_v4 chunks 0-7; the two tiers set on the validation normals (seed-mean
score: PERIKSA at FPR 1 %, TAHAN at FPR 0.1 %), then applied unchanged to generator 3. Premature discharge ("pulang_dini") is a
quality deviation in generator 3 and is reported apart, as in v4_final. B's frozen bundle (testing/model_v4) is scored on the same
claims for reference.

Graph: generator 3's chunks were judged in a copy of the world after the stream (testing/uji_gen2.py), so chunk c's claims are
linked to the stream and to the earlier claims of chunk c, as the data_v4 chunks are; no edge points into a training or validation
node, so their outputs are unchanged (checked against the saved validation scores). D uses the GPU-trained weights
(.tmp/varian_graf_dl/model_D_*.pt) on CPU; E's fold models were not saved, so E is retrained here on CPU with the epoch counts
D chose. Synthetic data only.

Usage: .venv/Scripts/python.exe testing/varian_graf_dl_gen3.py"""
from __future__ import annotations

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
import varian_graf_dl as VG  # noqa: E402
import varian_graf_dl_model as VM  # noqa: E402

GEN3 = VG.TMP / "gen3_uji"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "v4_graf_gen3.json"
MUTU = {"pulang_dini"}
say = VG.say


def tier(y: np.ndarray, f: np.ndarray) -> dict:
    y = y.astype(bool)
    r, fpr = float(f[y].mean()), float(f[~y].mean())
    return {"recall": round(r, 4), "fpr": round(fpr, 5), "presisi_mentah": round(float(y[f].mean()) if f.any() else 0.0, 4),
            "presisi_prev2": round(VG.presisi_prevalensi(r, fpr, 0.02), 4), "ditandai": int(f.sum())}


def boot(y: np.ndarray, f: np.ndarray, grup: np.ndarray, B: int = 1000) -> dict:
    rng = np.random.default_rng(0)
    _, inv = np.unique(grup, return_inverse=True)
    M = inv.max() + 1
    rs, fs = [], []
    for _ in range(B):
        w = np.bincount(rng.integers(0, M, M), minlength=M)[inv]
        ii = np.repeat(np.arange(len(y)), w)
        yy, ff = y[ii].astype(bool), f[ii]
        rs.append(ff[yy].mean()); fs.append(ff[~yy].mean())
    q = lambda a, d: [round(float(np.percentile(a, 2.5)), d), round(float(np.percentile(a, 97.5)), d)]  # noqa: E731
    return {"recall": q(rs, 4), "fpr": q(fs, 5)}


def tambah_gen3(D: dict) -> dict:
    fs = sorted(GEN3.glob("hasil_[0-9][0-9].npz"))
    parts = []
    for i, f in enumerate(fs):
        d = np.load(f, allow_pickle=False)
        n = len(d["sk"])
        parts.append({"X1": d["X1"].astype(np.float32), "sk": VG._str(d["sk"]), "peserta": VG._str(d["peserta"]),
                      "faskes": VG._str(d["faskes"]), "kode": VG._str(d["kode"]), "X4": d["X4"].astype(np.float32),
                      "chunk": np.full(n, 100 + i), "pos": np.arange(n)})
    G = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    n0, m = len(D["sk"]), len(G["sk"])
    for k, v in G.items():
        D[k] = np.concatenate([D[k], v])
    for k in ("latih", "val", "es"):
        D[k] = np.concatenate([D[k], np.zeros(m, bool)])
    D["fold"] = np.concatenate([D["fold"], np.full(m, -1)])
    D["y"] = (~np.isin(D["sk"], VG.NORMAL)).astype(int)
    D["x4_ada"] = ~np.isnan(D["X4"]).any(1)
    j = D["info"]["kolom_kunjungan_pertama"]["indeks"]
    D["pertama"] = D["X1"][:, j] <= D["info"]["kolom_kunjungan_pertama"]["nilai_min"] + 1e-5
    D["gen3"] = np.r_[np.zeros(n0, bool), np.ones(m, bool)]
    D.pop("X4_alt", None)
    say(f"generator 3: {m} claims in {len(fs)} chunks appended (nodes {n0} -> {n0 + m})")
    return D


def cek_tetangga(D: dict, E: dict) -> dict:
    """Share of generator-3 rows whose graph neighbour means equal X1's (as cek_graf does for the data_v4 chunks)."""
    XS = VG.xs_sendiri(D).astype(np.float64)
    g = D["gen3"]
    out = {}
    for ri, r in enumerate(VG.REL):
        M = VG.adj_mean(len(XS), *E[r]) @ XS
        ref = D["X1"][:, VG.N_SYS * (1 + ri):VG.N_SYS * (2 + ri)].astype(np.float64)
        out[r] = round(float((np.abs(M - ref).max(1)[g] < 1e-4).mean()), 4)
    return out


def ambang(s: np.ndarray, D: dict) -> tuple[float, float]:
    v = D["val"] & (D["y"] == 0)
    return VG.ambang_fpr(s[v], 0.01), VG.ambang_fpr(s[v], 0.001)


def nilai_gen3(s: np.ndarray, tP: float, tT: float, D: dict) -> dict:
    from sklearn.metrics import average_precision_score, roc_auc_score

    g = D["gen3"]
    sk = D["sk"][g]
    mutu = np.isin(sk, list(MUTU))
    keep = ~mutu
    y, sg = D["y"][g][keep], s[g][keep]
    P, T = sg > tP, sg > tT
    nrm = y == 0
    pt = D["pertama"][g][keep]
    grup = np.char.add(D["chunk"][g][keep].astype(str), np.char.add(":", D["peserta"][g][keep]))
    return {"klaim": int(len(y)), "fraud": int(y.sum()),
            "periksa": {**tier(y, P), "ci": boot(y, P, grup)}, "tahan": {**tier(y, T), "ci": boot(y, T, grup)},
            "auprc": round(float(average_precision_score(y, sg)), 4), "auroc": round(float(roc_auc_score(y, sg)), 4),
            "fpr_kunjungan_pertama": round(float(P[nrm & pt].mean()), 5), "fpr_pasien_lama": round(float(P[nrm & ~pt].mean()), 5),
            "recall_per_skema": VG.recall_per_skema(sk[keep][y == 1], P[y == 1]),
            "mutu_pulang_dini": {"klaim": int(mutu.sum()), "ditandai_periksa": round(float((s[g][mutu] > tP).mean()), 4) if mutu.any() else None}}


def nilai_val(s: np.ndarray, tP: float, tT: float, D: dict) -> dict:
    v = D["val"]
    y = D["y"][v]
    return {"periksa": tier(y, s[v] > tP), "tahan": tier(y, s[v] > tT)}


def sig(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.asarray(x, np.float64)))


def skor_D(jenis: str, D: dict, E: dict) -> tuple[np.ndarray, dict]:
    import torch

    X, _ = VG.fitur_node(D, E)
    Z1, At, R = VG.masukan_gnn(jenis, X, E)
    ref = np.load(VG.KERJA / f"skor_D_{jenis}.npz")["skor"]
    ps, cek = [], []
    for sd in VG.SEEDS:
        ck = torch.load(VG.KERJA / f"model_D_{jenis}_s{sd}.pt", map_location="cpu")
        m = ck["meta"]
        net = VM.GNN(m["f_in"], m["h"], m["R"], m["n_cls"])
        net.load_state_dict(ck["state_dict"])
        o = VM.prediksi_gnn(net, Z1, At)[0]
        cek.append(float(np.abs(o[D["val"]] - ref[sd]).max()))
        ps.append(sig(o))
    return np.mean(ps, 0), {"bobot": "dilatih di GPU (RunPod RTX 4090), dijalankan di CPU",
                            "selisih_maks_logit_validasi_vs_skor_gpu": round(max(cek), 7)}


def skor_E(jenis: str, D: dict, E: dict, ep: dict) -> tuple[np.ndarray, dict]:
    import lightgbm as lgb

    X, _ = VG.fitur_node(D, E)
    Z1, At, R = VG.masukan_gnn(jenis, X, E)
    cls, kn = VG.kelas_skema(D)
    XB = VG.fitur_B(D)
    lat = D["latih"]
    ps, det = [], {}
    for sd in VG.SEEDS:
        t = time.time()
        F = np.zeros((len(X), 1 + len(kn)), np.float32)
        for k in range(VG.N_FOLD):
            fit = lat & (D["fold"] != k)
            model, _, _ = VM.latih_gnn(Z1, At, R, D["y"], cls, len(kn), fit, None, sd, epochs=ep[sd])
            o, p = VM.prediksi_gnn(model, Z1, At)
            Fk = np.column_stack([o, p])
            te = D["fold"] == k
            F[te] = Fk[te]
            F[~lat] += Fk[~lat] / VG.N_FOLD  # validation and generator 3: the mean of the fold models (none saw their labels)
            say(f"    E_{jenis} seed {sd} fold {k}: {ep[sd]} epochs ({time.time() - t:.0f}s)")
        Xh = np.hstack([XB, F])
        m = lgb.LGBMClassifier(**VG.P1, n_jobs=VG.THREADS, random_state=sd).fit(Xh[lat], D["y"][lat])
        s = np.zeros(len(X)); s[~lat] = m.predict_proba(Xh[~lat])[:, 1]
        ps.append(s)
        det[sd] = round(time.time() - t, 1)
    return np.mean(ps, 0), {"bobot": "dilatih ulang di CPU (model fold tidak disimpan saat run GPU)", "detik_per_seed": det,
                            "epoch_per_seed": {str(k): int(v) for k, v in ep.items()}}


def skor_B(D: dict) -> tuple[np.ndarray, float, float]:
    import joblib

    b = joblib.load(HERE / "model_v4" / "model.joblib")
    # the frozen v4 has no route (validation kept "model saja"): PERIKSA = score > threshold, as scored in v4_final
    assert b["varian"] == "B" and not b["aturan_v4"] and not b["rute_v3"].get("kolom") and not b["jaringan_v3"], "v4 bundle has a route"
    X = VG.fitur_B(D)
    idx = ~D["latih"]
    s = np.zeros(len(X)); s[idx] = np.mean([m.predict_proba(X[idx])[:, 1] for m in b["models"]], axis=0)
    return s, float(b["ambang_periksa"]), float(b["ambang_tahan"])


def main() -> None:
    import torch

    torch.set_num_threads(VG.THREADS)
    t0 = time.time()
    D = VG.muat_data()
    E0 = VG.bangun_tepi(D)
    n0 = len(D["sk"])
    D = tambah_gen3(D)
    E = VG.bangun_tepi(D)
    for r in VG.REL:  # the training/validation part of the graph is unchanged by the appended chunks
        a = E[r][0] < n0
        assert np.array_equal(E[r][0][a], E0[r][0]) and np.array_equal(E[r][1][a], E0[r][1]), r
        assert (E[r][1][~a] < E[r][0][~a]).all()
    D["n_peserta"] = VG.derajat(D, E)[:, 0]
    graf = {"simpul_gen3": int(D["gen3"].sum()), "tepi_ke_gen3": {r: int((E[r][0] >= n0).sum()) for r in VG.REL},
            "tetangga_sama_dengan_X1": cek_tetangga(D, E)}
    say("graph:", json.dumps(graf))
    H = json.loads(VG.HASIL.read_text("utf-8"))
    hasil = {}
    s, tP, tT = skor_B(D)
    tP_val, tT_val = ambang(s, D)
    hasil["B"] = {"nama": "v4 = B (LightGBM, X1 + X4)", "sumber": "testing/model_v4 (dibekukan, ambang dari bundle)",
                  "ambang": {"periksa": tP, "tahan": tT, "cek_ulang_dari_validasi": [tP_val, tT_val]},
                  "validasi": nilai_val(s, tP, tT, D), "gen3": nilai_gen3(s, tP, tT, D)}
    say("B gen3 periksa", hasil["B"]["gen3"]["periksa"]["recall"], hasil["B"]["gen3"]["periksa"]["fpr"])
    for j in ("sage", "rgcn"):
        t = time.time()
        s, info = skor_D(j, D, E)
        tP, tT = ambang(s, D)
        hasil[f"D_{j}"] = {"nama": "GraphSAGE" if j == "sage" else "R-GCN", "ambang": {"periksa": tP, "tahan": tT}, **info,
                           "validasi": nilai_val(s, tP, tT, D), "gen3": nilai_gen3(s, tP, tT, D), "detik": round(time.time() - t, 1)}
        say(f"D_{j} gen3 periksa", hasil[f"D_{j}"]["gen3"]["periksa"]["recall"], hasil[f"D_{j}"]["gen3"]["periksa"]["fpr"], info)
    for j in ("sage", "rgcn"):
        t = time.time()
        ep = {int(k): int(x["epoch_es"]) for k, x in H["varian"][f"D_{j}"]["latih"].items()}
        s, info = skor_E(j, D, E, ep)
        tP, tT = ambang(s, D)
        hasil[f"E_{j}"] = {"nama": f"Hybrid LightGBM + {'GraphSAGE' if j == 'sage' else 'R-GCN'}", "ambang": {"periksa": tP, "tahan": tT}, **info,
                           "validasi": nilai_val(s, tP, tT, D), "gen3": nilai_gen3(s, tP, tT, D), "detik": round(time.time() - t, 1)}
        say(f"E_{j} gen3 periksa", hasil[f"E_{j}"]["gen3"]["periksa"]["recall"], hasil[f"E_{j}"]["gen3"]["periksa"]["fpr"])
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "skrip": "testing/varian_graf_dl_gen3.py", "graf": graf, "varian": hasil,
           "catatan": ["Eksplorasi: pemakaian KEDUA generator 3. v4 = B tetap (dipilih di validasi; E_sage seri < 1 poin -> yang lebih sederhana).",
                       "Ambang tiap varian disetel di normal validasi (PERIKSA FPR 1%, TAHAN FPR 0,1%) lalu dipakai apa adanya di generator 3.",
                       "pulang_dini = deviasi mutu di generator 3: dipisah dari hitungan fraud/normal (seperti v4_final).",
                       "Data sintetis saja."],
           "detik_total": round(time.time() - t0, 1)}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    say("written", OUT)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    VG.LOCK_NAMA = "graf-gen3"
    with VG.kunci_berat():
        main()
