"""The architecture v3 report for ML Studio: data/aip/ml/sistem_terbaru/arsitektur_v3.json (laporan_ml.py adds it to
sistem.json, the /api/ml-sistem payload).

v3's settings were chosen on the validation members only; the first 100.000-claim test (A) had already been used to compare
several versions, so v1, v2 and v3 are compared once on a fresh test B (uji100k.py with UJI100K_SET=B: other claims of
Sep–Nov 2024, members outside test A and every training set, other seeds, and two ring shapes no training data has). Test
A is shown only as a consistency check. Aggregates only, no claim rows. Synthetic data only.

Usage: .venv/Scripts/python.exe testing/laporan_v3.py   (after latih_v2.py uji/tak_dikenal --uji b, uji100k_cek.py .tmp/uji100k_b)"""
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
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import arsitektur_v2 as A  # noqa: E402
from laporan_v2 import bench, idn  # noqa: E402

UJI_A = ROOT / ".tmp" / "uji100k" / "r2"
UJI_B = ROOT / ".tmp" / "uji100k_b"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "arsitektur_v3.json"
LAPISAN = ["koding", "tagihan", "episode", "identitas", "model1"]
NAMA = {"koding": "Spesialis coding", "tagihan": "Spesialis tagihan", "episode": "Spesialis episode", "identitas": "Spesialis identitas",
        "model1": "Model 1 graph", "rute": "Rule route", "jaringan_rule": "Network rule"}
LABEL_BARU = {"cincin_bentuk_baru": "Collusion ring bentuk baru (tidak ada di data latih)"}


def muat(d: Path) -> dict:
    ds = [np.load(f) for f in sorted(d.glob("hasil_[0-9][0-9].npz"))]
    c = {k: np.concatenate([x[k] for x in ds]) for k in ("sk", "flag", "ps", "cal", "tahan", "periksa")}
    c["sk"] = c["sk"].astype(str)
    return c


def main() -> None:
    import joblib
    from sklearn.metrics import average_precision_score, roc_auc_score

    import penjelas as PJ
    from aip.realtime import simulator as SIM

    B = muat(UJI_B)
    sk = B["sk"]
    y = (sk != "normal").astype(int)
    S = {"v1": {"flag": B["flag"], "ps": B["ps"]}, "v2": dict(np.load(UJI_B / "skor_model_v2.npz")), "v3": dict(np.load(UJI_B / "skor_model_v3.npz"))}

    def ringkas(f: np.ndarray, s: np.ndarray, yy: np.ndarray = y) -> dict:
        f = f.astype(bool)
        tp, fp = int((f & (yy == 1)).sum()), int((f & (yy == 0)).sum())
        fn, tn = int((~f & (yy == 1)).sum()), int((~f & (yy == 0)).sum())
        return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(tp / max(1, tp + fp), 4), "recall": round(tp / max(1, tp + fn), 4),
                "fpr": round(fp / max(1, fp + tn), 5), "auprc": round(float(average_precision_score(yy, s)), 4), "auroc": round(float(roc_auc_score(yy, s)), 4)}

    r = {k: ringkas(v["flag"], v["ps"]) for k, v in S.items()}
    p0 = float(y.mean())
    tingkat = sorted({0.001, 0.002, 0.005, 0.01, 0.02, round(p0, 4), 0.05, 0.1, 0.2})

    def prev(f: np.ndarray) -> list[float]:
        f = f.astype(bool)
        tpr = (f & (y == 1)).sum() / max(1, y.sum()); fpr = (f & (y == 0)).sum() / max(1, (y == 0).sum())
        return [round(float(tpr * p / max(1e-12, tpr * p + fpr * (1 - p))), 4) for p in tingkat]

    def top(s: np.ndarray, k: int) -> np.ndarray:
        f = np.zeros(len(s), bool); f[np.argsort(-s, kind="stable")[:k]] = True
        return f

    def pk(s: np.ndarray, ks: list[int]) -> dict:
        o = np.argsort(-s, kind="stable"); tp = np.cumsum(y[o])
        ks = [k for k in ks if k <= len(o)]
        return {"k": ks, "precision": [round(float(tp[k - 1] / k), 4) for k in ks], "recall": [round(float(tp[k - 1] / max(1, y.sum())), 4) for k in ks]}

    k2 = int(round(0.02 * len(y)))
    ks = [25, 50, 100, 250, 500, 1000, 1500, 2000, 2500, 3000]
    daftar = PJ.modus_daftar()

    def modus_dari(s: str) -> list[dict]:
        ms = (SIM.SCENARIOS.get(s) or ("", [], set()))[1] or (["M10"] if s == "cincin_bentuk_baru" else [])
        return [{"kode": ("M07" if x == "M19" else x), "nama": daftar.get("M07" if x == "M19" else x, x)} for x in ms]

    v3 = S["v3"]
    skema = []
    for s in sorted(set(sk) - {"normal"}):
        m = sk == s
        skema.append({"skema": s, "label": LABEL_BARU.get(s) or (SIM.SCENARIOS.get(s) or (s,))[0], "modus": modus_dari(s), "famili": A.famili_dari(s),
                      "n": int(m.sum()), "baru": s in LABEL_BARU, **{f"recall_{k}": round(float(S[k]["flag"][m].mean()), 4) for k in S},
                      "lapisan": {**{k: round(float(np.median(v3[k][m])), 3) for k in LAPISAN},
                                  "rute": round(float(v3["rute"][m].mean()), 3), "jaringan_rule": round(float(v3["jaringan_rule"][m].mean()), 3)}})
    nrm = y == 0
    lap_normal = {**{k: round(float(np.median(v3[k][nrm])), 4) for k in LAPISAN},
                  "rute": round(float(v3["rute"][nrm].mean()), 4), "jaringan_rule": round(float(v3["jaringan_rule"][nrm].mean()), 4)}

    # layer quality out-of-fold (model_v3/oof.npz), each specialist on its own family against normal claims
    o = np.load(HERE / "model_v3" / "oof.npz")
    yo, sko = o["y"], o["sk"].astype(str)
    famo = np.array([A.famili_dari(x) or "" for x in sko])
    mutu = {k: round(float(average_precision_score(yo[(yo == 0) | (famo == k)] if k in A.FAMILI else yo,
                                                   o[f"o_{k}"][(yo == 0) | (famo == k)] if k in A.FAMILI else o[f"o_{k}"])), 3) for k in LAPISAN}
    mutu["fusi"] = round(float(average_precision_score(yo, o["os"])), 3)
    b3 = joblib.load(HERE / "model_v3" / "model.joblib")
    kartu = b3["kartu"]
    g = b3["stacker"].booster_.feature_importance("gain")
    bobot = {n: round(float(x / max(1e-9, g.sum())), 4) for n, x in zip(b3["urutan"], g)}

    # what v3 dropped from v2, with the evidence (v2 on test A, where the choice was made)
    b2 = joblib.load(HERE / "model_v2" / "model.joblib")
    g2 = b2["stacker"].booster_.feature_importance("gain")
    bobot2 = {n: float(x / max(1e-9, g2.sum())) for n, x in zip(b2["urutan"], g2)}
    a2 = dict(np.load(UJI_A / "skor_model_v2.npz"))
    ya = (np.concatenate([np.load(f)["sk"] for f in sorted(UJI_A.glob("hasil_[0-9][0-9].npz"))]).astype(str) != "normal")
    alert = a2["pm"] > b2["ambang_alert_ring"]
    lain = (a2["cal"] >= b2["ambang_peluang"]) | a2["rute"].astype(bool)
    dibuang = [{"nama": "Model 2 · jaringan RS", "ikon": "constellation", "bobot_fusi": round(bobot2.get("model2", 0), 4),
                "isi": f"{idn(bobot2.get('model2', 0) * 100, 1)}% bobot fusi; median {idn(float(np.median(a2['model2'][ya])) * 100)}% pada fraud"},
               {"nama": "Alert jaringan RS", "ikon": "bell", "unik_fraud": int((alert & ~lain & ya).sum()), "unik_normal": int((alert & ~lain & ~ya).sum()),
                "isi": f"{idn(int((alert & ~lain & ya).sum()))} fraud yang tidak tertangkap lapisan lain; +{idn(int((alert & ~lain & ~ya).sum()))} klaim normal"},
               {"nama": "Rule layer", "ikon": "logic", "bobot_fusi": round(bobot2.get("rule", 0), 4),
                "isi": f"{idn(bobot2.get('rule', 0) * 100, 1)}% bobot fusi; Model 1 sudah membaca sinyal rule yang sama"}]

    # test A (already used to choose between versions): v3 there, as a consistency check only
    A3 = dict(np.load(UJI_A / "skor_model_v3.npz"))
    uji_a = {"v3": ringkas(A3["flag"], A3["ps"], ya.astype(int)), "v2": ringkas(a2["flag"], a2["ps"], ya.astype(int)), "klaim": int(len(ya))}

    cek = json.loads((UJI_B / "cek.json").read_text("utf-8")) if (UJI_B / "cek.json").exists() else None
    rr = b3.get("rute_rule") or {}
    rj = b3.get("rule_jaringan") or {}
    hanya_rute = v3["rute"].astype(bool) & ~(v3["cal"] >= b3["ambang_peluang"]) & ~v3["jaringan_rule"].astype(bool)
    hanya_jar = v3["jaringan_rule"].astype(bool) & ~(v3["cal"] >= b3["ambang_peluang"]) & ~v3["rute"].astype(bool)
    baru = sk == "cincin_bentuk_baru"

    # fraud types never seen in training, on test B
    tak = {}
    for arsi, nama in (("v3", "tak_dikenal_v3_b.json"), ("v2", "tak_dikenal_v2_b.json"), ("v1", "tak_dikenal_lama_b.json")):
        f = ROOT / ".tmp" / nama
        if f.exists():
            tak[arsi] = json.loads(f.read_text("utf-8"))
    tak_dikenal = []
    for fam, d in [*A.FAMILI.items(), ("jaringan", A.JARINGAN)]:
        if fam not in tak.get("v3", {}):
            continue
        famm = np.array([A.famili_dari(x) == fam for x in sk])
        tak_dikenal.append({"famili": fam, "nama": d["nama"], "modus": d["modus"], "n": tak["v3"][fam]["n"],
                            **{f"recall_{k}": round(tak[k][fam]["recall"], 4) for k in tak if fam in tak[k]},
                            "recall_v3_dikenal": round(float(v3["flag"][famm].mean()), 4),
                            "per_skema": [{"skema": sx, "label": LABEL_BARU.get(sx) or (SIM.SCENARIOS.get(sx) or (sx,))[0], "recall_v3": rv,
                                           "recall_v2": tak.get("v2", {}).get(fam, {}).get("per_skema", {}).get(sx),
                                           "recall_v1": tak.get("v1", {}).get(fam, {}).get("per_skema", {}).get(sx)}
                                          for sx, rv in sorted(tak["v3"][fam]["per_skema"].items(), key=lambda kv: kv[1])]})

    lemah = [x for x in sorted(skema, key=lambda x: x["recall_v3"]) if x["recall_v3"] < 0.9]
    temuan = [
        {"ikon": "check", "nada": "baik" if r["v3"]["recall"] >= 0.9 else "buruk", "judul": f"{idn(r['v3']['recall'] * 100)}% fraud tertangkap di uji baru",
         "isi": f"{idn(r['v3']['tp'])} dari {idn(int(y.sum()))} fraud; v2 {idn(r['v2']['recall'] * 100)}%, v1 {idn(r['v1']['recall'] * 100)}%."},
        {"ikon": "alert", "nada": "netral", "judul": f"Klaim normal ditandai {idn(r['v3']['fpr'] * 100, 2)}%",
         "isi": f"{idn(r['v3']['fp'])} dari {idn(int((y == 0).sum()))}; v2 {idn(r['v2']['fpr'] * 100, 2)}%, v1 {idn(r['v1']['fpr'] * 100, 2)}%."},
        {"ikon": "layers", "nada": "netral", "judul": "Lebih sederhana, hasil sama",
         "isi": f"Tanpa Model 2, alert jaringan dan lapisan rule; AUPRC {idn(r['v3']['auprc'], 3)} (v2 {idn(r['v2']['auprc'], 3)})."},
        {"ikon": "constellation", "nada": "baik" if float(v3["flag"][baru].mean()) >= 0.7 else "buruk",
         "judul": f"Collusion ring bentuk baru: {idn(float(v3['flag'][baru].mean()) * 100)}% tertangkap",
         "isi": f"Bentuk yang tidak ada di data latih; v2 {idn(float(S['v2']['flag'][baru].mean()) * 100)}%, v1 {idn(float(S['v1']['flag'][baru].mean()) * 100)}%."
                + (f" Bila tidak ada cincin sama sekali di data latih: {idn(tak['v3']['jaringan']['per_skema'].get('cincin_bentuk_baru', 0) * 100)}%."
                   if 'jaringan' in tak.get('v3', {}) else "")},
        {"ikon": "graph", "nada": "netral", "judul": f"Model 1 memegang {idn(bobot.get('model1', 0) * 100)}% bobot fusi",
         "isi": "Empat spesialis menambah sedikit (lama rawat, upcoding); rule route dan network rule menangkap yang belum pernah dilihat."},
    ]
    if lemah:
        temuan.append({"ikon": "eye", "nada": "buruk", "judul": f"Masih lemah: {len(lemah)} skema",
                       "isi": ", ".join(f"{x['label']} {idn(x['recall_v3'] * 100)}%" for x in lemah[:3])})
    if tak_dikenal and "recall_v3" in tak_dikenal[0]:
        rv3 = float(np.mean([t["recall_v3"] for t in tak_dikenal])); rv1 = float(np.mean([t.get("recall_v1", np.nan) for t in tak_dikenal]))
        temuan.append({"ikon": "search", "nada": "baik" if rv3 >= 0.6 else "buruk", "judul": f"Jenis fraud baru: rata-rata {idn(rv3 * 100)}%",
                       "isi": f"Satu kelompok modus tidak pernah dilatih; arsitektur v1 {idn(rv1 * 100)}%."})
    temuan.append({"ikon": "info", "nada": "netral", "judul": "Uji B dipakai sekali, untuk ketiga versi",
                   "isi": f"Desain v3 dipilih pada peserta validasi; uji A (100 ribu) sudah dipakai membandingkan versi, jadi hanya cek konsistensi."})

    # the overfitting check (the user, 2026-11-12: "kasih report bahwa ini engga overfitting di ML studio"): the same v3 model on
    # the claims it was trained on, out-of-fold, on the validation members, and on tests A and B; stability over folds and batches
    import latih_v2 as LV

    def baris(nama: str, yy: np.ndarray, ff: np.ndarray, ss: np.ndarray, ket: str) -> dict:
        ff = ff.astype(bool)
        return {"nama": nama, "ket": ket, "n": int(len(yy)), "fraud": round(float(yy.mean()), 4), "recall": round(float(ff[yy == 1].mean()), 4), "precision": round(float(yy[ff].mean()), 4),
                "fpr": round(float(ff[yy == 0].mean()), 5), "auprc": round(float(average_precision_score(yy, ss)), 4)}

    St = LV.stream_fitur(); Vt = LV.muat_v2([c for c in range(10) if c not in LV.VALIDASI])
    skt = np.concatenate([St["sk"].astype(str), Vt["sk"].astype(str)])
    yt = (~np.isin(skt, A.NORMAL)).astype(int)
    st_ = A.skor(b3, np.vstack([St["X1"], Vt["X1"]]), np.vstack([St["X2"], Vt["X2"]]), np.vstack([St["XR"], Vt["XR"]]))
    Vv = LV.muat_v2(LV.VALIDASI)
    yv = (~np.isin(Vv["sk"].astype(str), A.NORMAL)).astype(int)
    sv_ = A.skor(b3, Vv["X1"], Vv["X2"], Vv["XR"])
    oo = kartu["oof"]
    tahap = [baris("Data latih", yt, st_["flag"], st_["ps"], "dilihat saat latih"),
             {"nama": "Out-of-fold", "ket": "5 lipatan, tiap klaim dinilai model yang tidak melihatnya", "n": oo["n"], "fraud": round(oo["fraud"] / max(1, oo["n"]), 4), "recall": round(oo["recall"], 4),
              "precision": round(oo["precision"], 4), "fpr": round(oo["fpr"], 5), "auprc": round(oo["auprc"], 4)},
             baris("Validasi", yv, sv_["flag"], sv_["ps"], "peserta yang disisihkan"),
             baris("Uji A", ya.astype(int), A3["flag"], A3["ps"], "100 ribu klaim, dipakai memilih versi"),
             baris("Uji B", y, v3["flag"], v3["ps"], "klaim baru, dipakai sekali")]
    lip = []
    for f_ in range(5):
        m_ = o["fold"] == f_
        lip.append({"lipatan": f_ + 1, "n": int(m_.sum()), "auprc": round(float(average_precision_score(yo[m_], o["os"][m_])), 4),
                    "recall": round(float((o["cal"][m_][yo[m_] == 1] >= 0.5).mean()), 4)})
    per_batch, i0 = [], 0
    for fb in sorted(UJI_B.glob("hasil_[0-9][0-9].npz")):
        nb = len(np.load(fb)["sk"]); yb = y[i0:i0 + nb] == 1; fbb = v3["flag"][i0:i0 + nb].astype(bool); i0 += nb
        per_batch.append({"recall": round(float(fbb[yb].mean()), 4), "precision": round(float(yb[fbb].mean()), 4), "fpr": round(float(fbb[~yb].mean()), 5)})
    overfit = {"tahap": tahap, "lipatan": lip, "batch_b": per_batch,
               "selisih_auprc": round(tahap[0]["auprc"] - min(t["auprc"] for t in tahap[1:]), 4),
               "rentang_auprc_tak_dilihat": [min(t["auprc"] for t in tahap[1:]), max(t["auprc"] for t in tahap[1:])],
               "tak_dikenal_rata": round(float(np.mean([t["recall_v3"] for t in tak_dikenal])), 4) if tak_dikenal else None}

    out = {
        "dibuat": time.strftime("%Y-%m-%d %H:%M"), "dilatih": kartu.get("dilatih"), "klaim": int(len(y)), "fraud": int(y.sum()), "normal": int((y == 0).sum()),
        "ringkas": r, "uji_a": uji_a, "temuan": temuan, "skema": skema, "lapisan": LAPISAN + ["rute", "jaringan_rule"], "lapisan_nama": NAMA,
        "lapisan_normal": lap_normal, "mutu_lapisan": mutu, "bobot_fusi": bobot, "ambang_peluang": b3["ambang_peluang"], "dibuang": dibuang,
        "rute": {"sinyal": [n[2:] for n, c_, l_ in zip(rr.get("nama", []), rr.get("contoh", []), rr.get("laju_normal", [])) if c_ > 0 or l_ > 0],
                 "min_contoh": rr.get("min_contoh"), "maks_normal": rr.get("maks_normal"),
                 "tambah_fraud": int((hanya_rute & (y == 1)).sum()), "tambah_normal": int((hanya_rute & (y == 0)).sum())},
        "rule_jaringan": {**rj, "tambah_fraud": int((hanya_jar & (y == 1)).sum()), "tambah_normal": int((hanya_jar & (y == 0)).sum()),
                          "cincin_baru": round(float(v3["jaringan_rule"][baru].mean()), 4)},
        "famili": [{"kunci": f, "nama": d["nama"], "modus": d["modus"], "sinyal": len(d["sinyal"])} for f, d in A.FAMILI.items()],
        "data_latih": {**kartu["per_sumber"], "klaim": kartu["klaim_latih"], "fraud": kartu["fraud_latih"]},
        "validasi": {"v3": kartu["validasi"], "v1": kartu["validasi_sistem_sekarang"]},
        "tak_dikenal": tak_dikenal,
        "cm": {k: r["v3"][k] for k in ("tp", "fp", "fn", "tn")},
        "presisi_k": {k: pk(S[k]["ps"], ks) for k in S},
        "prevalensi": {"tingkat": tingkat, "uji": round(p0, 4), "anggaran_k": k2, "keputusan": {k: prev(S[k]["flag"]) for k in S},
                       "anggaran": {k: prev(top(S[k]["ps"], k2)) for k in S}},
        "distribusi": {"batas": [round(x, 2) for x in np.linspace(0, 1, 21)], "normal": np.histogram(v3["cal"][y == 0], np.linspace(0, 1, 21))[0].tolist(),
                       "fraud": np.histogram(v3["cal"][y == 1], np.linspace(0, 1, 21))[0].tolist()},
        "cek_luar_latih": cek,
        "sumber_uji": ["Uji B: klaim FKRTL Sep–Nov 2024 yang belum pernah dipakai", "Peserta di luar uji A dan di luar semua data latih",
                       f"Planted fraud pada {idn(p0 * 100, 1)}% klaim, termasuk 2 bentuk cincin baru",
                       f"0 tumpang tindih dengan {idn((cek or {}).get('latih', {}).get('klaim', 0))} klaim latih" if cek and cek.get("lulus") else "Cek tumpang tindih belum lulus"],
        "dipakai": {"layanan": "/testing (port 8320)", "sejak": kartu.get("dilatih"), "sebelumnya": "testing/model_v2 dan testing/model"},
        "bench": bench(),
        "overfit": overfit,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print("written", OUT, {k: (v["recall"], v["precision"], v["fpr"], v["auprc"]) for k, v in r.items()}, "test A v3", uji_a["v3"]["recall"])


if __name__ == "__main__":
    main()
