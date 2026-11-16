"""Hackathon report (the user, 2026-11-13: "I wanna report for a hackathon"): one visual page built from the result files of this
repo, synthetic data only. Reads data/aip/ml/sistem_terbaru/{arsitektur_graf,ml_v7_benchmark}.json and testing/model_ml_v7/kartu.json,
writes docs/laporan_hackathon.html (the template testing/laporan_hackathon.html with the data blob filled in)."""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
D = ROOT / "data" / "aip" / "ml" / "sistem_terbaru"
OUT = ROOT / "docs" / "laporan_hackathon.html"


def r(x, d=4):
    return None if x is None else round(float(x), d)


def m(x: dict) -> dict:
    return {"recall": r(x["recall"]), "fpr": r(x["fpr"], 5), "prec": r(x["presisi_prev2"]), "auprc": r(x.get("auprc"))}


def main() -> None:
    g = json.loads((D / "arsitektur_graf.json").read_text("utf-8"))
    import time

    out: dict = {"dibuat": time.strftime("%Y-%m-%d %H:%M")}
    # versions across generators (ML v6 benchmark: G1 = C2, G2 = seed 3, G3 = fresh seed gen3-ml6)
    b6 = g["ml_v6"]["set"]
    out["evolusi"] = {k.replace("generator", "g"): {mk: m(s["model"][mk]) for mk in ("v3_bersih", "v4", "ml_v5")} for k, s in b6.items()}
    # shift diagnosis
    sd = g["shift"]
    out["shift"] = {"model": {k: {"fpr": r(v["fpr"], 5), "recall": r(v["recall"]), "med_fraud": r(v["skor_fraud"]["med"], 3), "hist": v["hist_fraud"],
                                  "auroc": r(v["auroc"])} for k, v in sd["pandangan_model"].items()},
                    "ambang": r(sd["ambang"]), "famili": {k: {f: r(x["recall"]) for f, x in v.items()} for k, v in sd["famili"].items()},
                    "porsi_g3": {f: r(x["porsi"]) for f, x in sd["famili"]["g3"].items()},
                    "pola": {"terbalik": sd["pola"]["di_g3"]["terbalik"], "hilang": sd["pola"]["di_g3"]["hilang"], "total": sd["pola"]["informatif_di_g1_dan_g2"],
                             "gain": sd["pola"]["porsi_gain_ml_v5"], "kor_g2_g3": sd["pola"]["korelasi_spearman_auroc"]["g2_g3"]},
                    "sidik": sd["pola"]["contoh_hilang"], "dekomposisi": sd["dekomposisi"], "profil": sd["profil"]}
    # AI agent swarm layer (v5) on a fresh generator 3 seed
    v5 = g["v5"]
    h = v5["hasil"]
    out["swarm"] = {"klaim": h["klaim"], "fraud": h["fraud"], "ragu": h["ragu"], "v4": m(h["v4_B"]), "v5": m(h["v5"]), "ci": h["selisih_v5_vs_v4_ci"],
                    "usd": r(v5["biaya_swarm"]["gen3_v5"]["usd_perkiraan"], 2), "panggilan": v5["biaya_swarm"]["gen3_v5"]["panggilan"],
                    "zona": h["swarm_di_zona_ragu"], "lolos": v5["adopsi"]["lolos"]}
    # ML v7
    kp = HERE / "model_ml_v7" / "kartu.json"
    if kp.exists():
        K = json.loads(kp.read_text("utf-8"))
        out["v7_kartu"] = {"pilihan": K["pilihan"], "logo": K["logo"], "gabungan": K["gabungan"], "tidak_stabil": K["tidak_stabil"]["jumlah"],
                           "latih": K["latih"], "sidik_v7": K["cek_overfit"].get("porsi_gain_sidik_jari"), "sidik_v5": K["cek_overfit"].get("porsi_gain_sidik_jari_ml_v5"),
                           "overfit": {k: K["cek_overfit"][k] for k in ("auprc_latih_insample", "auprc_latih_oof_per_peserta", "auprc_dev", "peringatan")}}
    bp = D / "ml_v7_benchmark.json"
    if bp.exists():
        B = json.loads(bp.read_text("utf-8"))
        out["v7"] = {"pilihan": B["pilihan"], "adopsi": B["adopsi"], "set": {}}
        for k, s in B["set"].items():
            out["v7"]["set"][k.replace("generator", "g")] = {
                "klaim": s["klaim"], "fraud": s["fraud"], "skema": s["skema"], "famili_n": s["famili_n"],
                "model": {mk: {**m(v), "famili": v["famili"]} for mk, v in s["model"].items()},
                "ci": {mk: v for mk, v in s["ci_vs_A0"].items()}, "ci_v4": s["ci_pilihan_vs_v4"],
                "skema_pilihan": s["model"][B["pilihan"]]["per_skema"], "skema_v3": s["model"]["v3_bersih"]["per_skema"]}
    tpl = (HERE / "laporan_hackathon.html").read_text("utf-8")
    OUT.write_text(tpl.replace("/*DATA*/null", json.dumps(out, ensure_ascii=False, separators=(",", ":"))), "utf-8")
    print("ditulis", OUT, OUT.stat().st_size, "byte;", "v7" if "v7" in out else "tanpa v7")


if __name__ == "__main__":
    main()
