"""The architecture v2 report for ML Studio: data/aip/ml/sistem_terbaru/arsitektur_v2.json (laporan_ml.py adds it to
sistem.json, the /api/ml-sistem payload).

Every test number comes from the 100.000 claims no model trained on (the re-run of uji100k.py with features, identical
claims to the first run; the overlap check is uji100k_cek.py), the layer quality from out-of-fold scores, the unseen-type
check from latih_v2.py tak_dikenal. Aggregates only, no claim rows. Synthetic data only.

Usage: .venv/Scripts/python.exe testing/laporan_v2.py   (then laporan_ml.py and build-web.ps1)"""
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

R2 = ROOT / ".tmp" / "uji100k" / "r2"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "arsitektur_v2.json"
LAPISAN = ["rule", "koding", "tagihan", "episode", "identitas", "model1", "model2"]
NAMA_LAPISAN = {"rule": "Rule (45 sinyal)", "koding": "Spesialis coding", "tagihan": "Spesialis tagihan", "episode": "Spesialis episode",
                "identitas": "Spesialis identitas", "model1": "Model 1 graph", "model2": "Model 2 jaringan"}


def idn(v: float, d: int = 0) -> str:
    s = f"{v:,.{d}f}"
    return s.replace(",", "_").replace(".", ",").replace("_", ".")


def bench() -> dict:
    """The /testing browser tests as they last ran (testing/e2e.mjs and testing/uji15.mjs write these files)."""
    out = {}
    f = HERE / "e2e-shots" / "e2e.json"
    if f.exists():
        d = json.loads(f.read_text("utf-8"))
        out["e2e"] = {"lulus": len(d["lulus"]), "gagal": len(d["gagal"]), "gagal_daftar": d["gagal"], "dijalankan": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime))}
    f = next((x for x in (HERE / "e2e-shots" / "uji20" / "uji20.json", HERE / "e2e-shots" / "uji15" / "uji15.json") if x.exists()), HERE / "e2e-shots" / "uji15" / "uji15.json")
    if f.exists():
        h = json.loads(f.read_text("utf-8"))
        out["uji15"] = {"total": len(h), "cocok": sum(r["cocok"] for r in h), "fraud": sum(1 for r in h if r["harap"] == "terdeteksi" and r["cocok"]),
                        "n_fraud": sum(1 for r in h if r["harap"] == "terdeteksi"), "normal": sum(1 for r in h if r["harap"] == "aman" and r["cocok"]),
                        "n_normal": sum(1 for r in h if r["harap"] == "aman"), "modus": sum(1 for r in h if r.get("modus_ada")),
                        "bug": sum(1 for r in h if r.get("bug")), "dijalankan": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime))}
    return out


def main() -> None:
    from sklearn.metrics import average_precision_score, roc_auc_score

    import penjelas as PJ
    from aip.realtime import simulator as SIM

    ds = [np.load(f) for f in sorted(R2.glob("hasil_[0-9][0-9].npz"))]
    c = {k: np.concatenate([d[k] for d in ds]) for k in ("sk", "flag", "ps", "cal", "tahan", "periksa")}
    sk = c["sk"].astype(str)
    y = (sk != "normal").astype(int)
    S = {n: dict(np.load(R2 / f"skor_{n}.npz")) for n in ("model_v2", "model_lama_data_v2", "model_v2_tanpa_data_v2")}
    v2 = S["model_v2"]

    def ringkas(f: np.ndarray, s: np.ndarray) -> dict:
        f = f.astype(bool)
        tp, fp = int((f & (y == 1)).sum()), int((f & (y == 0)).sum())
        fn, tn = int((~f & (y == 1)).sum()), int((~f & (y == 0)).sum())
        return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(tp / max(1, tp + fp), 4), "recall": round(tp / max(1, tp + fn), 4),
                "fpr": round(fp / max(1, fp + tn), 5), "auprc": round(float(average_precision_score(y, s)), 4), "auroc": round(float(roc_auc_score(y, s)), 4)}

    def pk(s: np.ndarray, ks: list[int]) -> dict:
        o = np.argsort(-s, kind="stable"); tp = np.cumsum(y[o])
        return {"k": ks, "precision": [round(float(tp[k - 1] / k), 4) for k in ks], "recall": [round(float(tp[k - 1] / max(1, y.sum())), 4) for k in ks]}

    def top(s: np.ndarray, k: int) -> np.ndarray:
        f = np.zeros(len(s), bool); f[np.argsort(-s, kind="stable")[:k]] = True
        return f

    p0 = float(y.mean())
    tingkat = sorted({0.001, 0.002, 0.005, 0.01, 0.02, round(p0, 4), 0.05, 0.1, 0.2})

    def prev(f: np.ndarray) -> list[float]:
        f = f.astype(bool)
        tpr = (f & (y == 1)).sum() / max(1, y.sum()); fpr = (f & (y == 0)).sum() / max(1, (y == 0).sum())
        return [round(float(tpr * p / max(1e-12, tpr * p + fpr * (1 - p))), 4) for p in tingkat]

    k2 = int(round(0.02 * len(y)))
    ks = [50, 100, 250, 500, 1000, 1500, 2000, 2500, 3000, 5000]
    daftar = PJ.modus_daftar()

    def modus_dari(s: str) -> list[dict]:
        ms = (SIM.SCENARIOS.get(s) or ("", [], set()))[1]
        return [{"kode": ("M07" if x == "M19" else x), "nama": daftar.get("M07" if x == "M19" else x, x)} for x in ms]

    skema = []
    for s in sorted(set(sk) - {"normal"}):
        m = sk == s
        skema.append({"skema": s, "label": (SIM.SCENARIOS.get(s) or (s,))[0], "modus": modus_dari(s), "famili": A.famili_dari(s), "n": int(m.sum()),
                      "recall_v2": round(float(v2["flag"][m].mean()), 4), "recall_sekarang": round(float(c["flag"][m].mean()), 4),
                      "recall_v1_data_baru": round(float(S["model_lama_data_v2"]["flag"][m].mean()), 4),
                      "lapisan": {k: round(float(np.median(v2[k][m])), 3) for k in LAPISAN}})
    lap_normal = {k: round(float(np.median(v2[k][y == 0])), 4) for k in LAPISAN}
    lap_normal_p99 = {k: round(float(np.quantile(v2[k][y == 0], 0.99)), 3) for k in LAPISAN}

    # layer quality out-of-fold (model_v2/oof.npz): each specialist on its own family against normal claims
    o = np.load(HERE / "model_v2" / "oof.npz")
    yo, sko = o["y"], o["sk"].astype(str)
    famo = np.array([A.famili_dari(s) or "" for s in sko])
    mutu = {}
    for k in LAPISAN:
        rows = (yo == 0) | (famo == k) if k in A.FAMILI else np.ones(len(yo), bool)
        mutu[k] = round(float(average_precision_score(yo[rows], o[f"o_{k}"][rows])), 3)
    mutu["fusi"] = round(float(average_precision_score(yo, o["os"])), 3)
    kartu = json.loads((HERE / "model_v2" / "kartu.json").read_text("utf-8"))

    # fraud types never seen in training (one family left out at a time)
    tak = {}
    for arsi in ("v2", "v2_tanpa_rute", "lama"):
        f = ROOT / ".tmp" / f"tak_dikenal_{arsi}.json"
        if f.exists():
            tak[arsi] = json.loads(f.read_text("utf-8"))
    tak_dikenal = []
    for fam, d in [*A.FAMILI.items(), ("jaringan", A.JARINGAN)]:
        if fam in tak.get("v2", {}):
            tak_dikenal.append({"famili": fam, "nama": d["nama"], "modus": d["modus"], "n": tak["v2"][fam]["n"],
                                "recall_v2": round(tak["v2"][fam]["recall"], 4), "recall_v1": round(tak.get("lama", {}).get(fam, {}).get("recall", float("nan")), 4),
                                "recall_v2_tanpa_rute": round(tak.get("v2_tanpa_rute", {}).get(fam, {}).get("recall", float("nan")), 4),
                                "recall_v2_dikenal": round(float(v2["flag"][np.array([A.famili_dari(s) == fam for s in sk])].mean()), 4),
                                "fpr_v2": round(tak["v2"][fam]["fpr"], 5),
                                "per_skema": [{"skema": sx, "label": (SIM.SCENARIOS.get(sx) or (sx,))[0], "recall_v2": rv,
                                               "recall_v2_tanpa_rute": tak.get("v2_tanpa_rute", {}).get(fam, {}).get("per_skema", {}).get(sx),
                                               "recall_v1": tak.get("lama", {}).get(fam, {}).get("per_skema", {}).get(sx)}
                                              for sx, rv in sorted(tak["v2"][fam]["per_skema"].items(), key=lambda kv: kv[1])]})

    r = {"sekarang": ringkas(c["flag"], c["ps"]), "v2": ringkas(v2["flag"], v2["ps"]),
         "v1_data_baru": ringkas(S["model_lama_data_v2"]["flag"], S["model_lama_data_v2"]["ps"]),
         "v2_data_lama": ringkas(S["model_v2_tanpa_data_v2"]["flag"], S["model_v2_tanpa_data_v2"]["ps"])}
    import joblib

    b2 = joblib.load(HERE / "model_v2" / "model.joblib")
    model_flag = (v2["cal"] >= b2["ambang_peluang"]) | (v2["pm"] > b2["ambang_alert_ring"])
    r["v2_tanpa_rute"] = ringkas(model_flag, v2["ps"])
    hanya_rute = v2["rute"].astype(bool) & ~model_flag
    rr = b2.get("rute_rule") or {}
    rute = {"sinyal": [{"nama": n[2:], "contoh": c_, "laju_normal": l_} for n, c_, l_ in zip(rr.get("nama", []), rr.get("contoh", []), rr.get("laju_normal", []))
                       if c_ > 0 or l_ > 0], "min_contoh": rr.get("min_contoh"), "maks_normal": rr.get("maks_normal"),
            "tambah_fraud": int((hanya_rute & (y == 1)).sum()), "tambah_normal": int((hanya_rute & (y == 0)).sum())}
    fp_v2 = v2["flag"].astype(bool) & (y == 0)
    fp_rule = float((fp_v2 & (c["tahan"] | c["periksa"])).sum() / max(1, fp_v2.sum()))
    lemah = [x for x in sorted(skema, key=lambda x: x["recall_v2"]) if x["recall_v2"] < 0.9]
    temuan = [
        {"ikon": "check", "nada": "baik", "judul": f"{idn(r['v2']['recall'] * 100)}% fraud tertangkap",
         "isi": f"{idn(r['v2']['tp'])} dari {idn(int(y.sum()))} fraud pada klaim yang tidak pernah dilatih; sistem v1 {idn(r['sekarang']['tp'])}."},
        {"ikon": "alert", "nada": "buruk" if r["v2"]["fpr"] > r["sekarang"]["fpr"] * 1.5 else "netral",
         "judul": f"Klaim normal ditandai {idn(r['v2']['fpr'] * 100, 2)}%",
         "isi": f"{idn(r['v2']['fp'])} dari {idn(int((y == 0).sum()))} (v1 {idn(r['sekarang']['fp'])}); {idn(fp_rule * 100)}% di antaranya juga ditandai rule."},
        {"ikon": "layers", "nada": "netral", "judul": "Kenaikan datang dari data latih",
         "isi": f"Arsitektur lama + data baru {idn(r['v1_data_baru']['recall'] * 100)}%; arsitektur baru + data lama {idn(r['v2_data_lama']['recall'] * 100)}%."},
    ]
    if lemah:
        temuan.append({"ikon": "eye", "nada": "buruk", "judul": f"Masih lemah: {len(lemah)} skema",
                       "isi": ", ".join(f"{x['label']} {idn(x['recall_v2'] * 100)}%" for x in lemah[:3])})
    if tak_dikenal:
        rv2 = float(np.mean([t["recall_v2"] for t in tak_dikenal])); rv1 = float(np.mean([t["recall_v1"] for t in tak_dikenal]))
        rv0 = float(np.mean([t["recall_v2_tanpa_rute"] for t in tak_dikenal]))
        temuan.append({"ikon": "search", "nada": "baik" if rv2 >= 0.7 else "buruk", "judul": f"Jenis fraud baru: rata-rata {idn(rv2 * 100)}% tertangkap",
                       "isi": f"Satu kelompok modus tidak pernah dilatih: tanpa rule route {idn(rv0 * 100)}%, arsitektur v1 {idn(rv1 * 100)}%."})
        temuan.append({"ikon": "logic", "nada": "netral", "judul": f"Rule route: +{idn(rute['tambah_normal'])} klaim normal di uji ini",
                       "isi": f"Pada 12 jenis yang sudah dikenal rute menambah {idn(rute['tambah_fraud'])} fraud; manfaatnya hanya untuk jenis baru."})
    buta = [x for t in tak_dikenal for x in t["per_skema"] if x["recall_v2"] < 0.2]
    if buta:
        temuan.append({"ikon": "eye", "nada": "buruk", "judul": f"Titik buta jenis baru: {len(buta)} skema",
                       "isi": ", ".join(f"{x['label']} {idn(x['recall_v2'] * 100, 1 if x['recall_v2'] < 0.1 else 0)}%" for x in buta[:3]) + " saat tidak pernah dilatih."})
    i01 = tingkat.index(0.001)
    pv2, psk = prev(v2["flag"])[i01], prev(c["flag"])[i01]
    temuan.append({"ikon": "sliders", "nada": "buruk" if pv2 < psk else "baik", "judul": f"Fraud langka 0,1%: precision {idn(pv2 * 100)}%",
                   "isi": f"Sistem v1 {idn(psk * 100)}%; v2 menangkap jauh lebih banyak fraud tetapi juga lebih banyak klaim normal."})
    temuan.append({"ikon": "info", "nada": "netral", "judul": "Fraud uji: 12 skema yang sama dengan data latih",
                   "isi": "Periode (Sep–Nov), peserta dan besaran berbeda; jenis baru diuji terpisah di bawah."})

    cek = None
    u = OUT.parent / "uji_100k.json"
    if u.exists():
        cek = json.loads(u.read_text("utf-8")).get("cek_luar_latih")

    out = {
        "dibuat": time.strftime("%Y-%m-%d %H:%M"), "dilatih": kartu.get("dilatih"), "klaim": int(len(y)), "fraud": int(y.sum()), "normal": int((y == 0).sum()),
        "ringkas": r, "temuan": temuan, "rute": rute, "skema": skema, "lapisan_nama": NAMA_LAPISAN, "lapisan_normal": lap_normal, "lapisan_normal_p99": lap_normal_p99,
        "mutu_lapisan": mutu, "ambang_alert": round(float(kartu["ambang_alert_ring"]), 4), "ambang_peluang": kartu["ambang_peluang"],
        "famili": [{"kunci": f, "nama": d["nama"], "modus": d["modus"], "sinyal": len(d["sinyal"])} for f, d in A.FAMILI.items()],
        "jaringan": {"nama": A.JARINGAN["nama"], "modus": A.JARINGAN["modus"]},
        "data_latih": {**kartu["per_sumber"], "klaim": kartu["klaim_latih"], "fraud": kartu["fraud_latih"]},
        "validasi": {"v2": kartu["validasi"], "sekarang": kartu["validasi_sistem_sekarang"]},
        "tak_dikenal": tak_dikenal,
        "cm": {k: r["v2"][k] for k in ("tp", "fp", "fn", "tn")},
        "presisi_k": {"sekarang": pk(c["ps"], ks), "v2": pk(v2["ps"], ks)},
        "prevalensi": {"tingkat": tingkat, "uji": round(p0, 4), "anggaran_k": k2,
                       "keputusan": {"sekarang": prev(c["flag"]), "v2": prev(v2["flag"])},
                       "anggaran": {"sekarang": prev(top(c["ps"], k2)), "v2": prev(top(v2["ps"], k2))}},
        "distribusi": {"batas": [round(x, 2) for x in np.linspace(0, 1, 21)], "normal": np.histogram(v2["cal"][y == 0], np.linspace(0, 1, 21))[0].tolist(),
                       "fraud": np.histogram(v2["cal"][y == 1], np.linspace(0, 1, 21))[0].tolist()},
        "cek_luar_latih": cek,
        "sumber_uji": [f"Data sintetis: klaim FKRTL Sep–Nov 2024", "Klaim normal = klaim dataset, tidak diubah",
                       f"Planted fraud pada {idn(p0 * 100, 1)}% klaim (12 skema)",
                       f"0 tumpang tindih dengan {idn((cek or {}).get('latih', {}).get('klaim', 0))} klaim latih" if cek and cek.get("lulus") else "Cek tumpang tindih belum lulus"],
        "dipakai": {"layanan": "/testing (port 8320)", "sejak": kartu.get("dilatih"), "v1_disimpan": "testing/model"},
        "bench": bench(),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print("written", OUT, {k: (v["recall"], v["precision"], v["fpr"]) for k, v in r.items()}, "layers", mutu)


if __name__ == "__main__":
    main()
