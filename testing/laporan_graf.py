"""The "Arsitektur & sistem terbaru" report data: every v4 variant on validation (testing/varian_graf_dl.py, D/E/F trained on a
RunPod GPU), the graph variants on generator 3 (testing/varian_graf_dl_gen3.py, a second use of generator 3, labelled), and the
GPU -> CPU load check. Aggregates only. Output: data/aip/ml/sistem_terbaru/arsitektur_graf.json (read by testing/laporan_ml.py
into sistem.json -> ML Studio). Synthetic data only."""
from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "data" / "aip" / "ml" / "sistem_terbaru"
KERJA = ROOT / ".tmp" / "varian_graf_dl"
OUT = D / "arsitektur_graf.json"

NAMA = {"A": ("LightGBM · fitur v3", "tabular"), "B": ("LightGBM · fitur v3 + X4", "tabular"), "C": ("B + lapisan RS × periode", "tabular"),
        "D_sage": ("GraphSAGE", "graph"), "D_rgcn": ("R-GCN", "graph"), "E_sage": ("Hybrid: B + GraphSAGE", "hybrid"),
        "E_rgcn": ("Hybrid: B + R-GCN", "hybrid"), "F_mlp": ("MLP", "deep learning"), "F_ft": ("FT-Transformer", "deep learning")}


def n_skema() -> dict:
    """Fraud claims per base scheme in generator 3 (premature discharge alone is quality, left out), for the small-n caveat."""
    import numpy as np

    sk = np.concatenate([np.load(f, allow_pickle=False)["sk"].astype(str) for f in sorted((ROOT / ".tmp" / "gen3_uji").glob("hasil_[0-9][0-9].npz"))])
    base = np.array([x[4:] if x.startswith("aug:") else x for x in sk])
    u, n = np.unique(base[~np.isin(base, ["normal", "pulang_dini"])], return_counts=True)
    return {str(k): int(v) for k, v in zip(u, n)}


def main() -> None:
    H = json.loads((D / "varian_v4_graf_dl.json").read_text("utf-8"))
    val = []
    for k, (nama, jenis) in NAMA.items():
        v = H["varian"].get(k)
        if not v:
            continue
        r, b = v["ringkas"], v.get("bootstrap", {})
        val.append({"kunci": k, "nama": nama, "jenis": jenis, "recall_fpr1": r["recall_fpr1"], "presisi_fpr01_prev2": r["presisi_fpr01_prev2"],
                    "auprc": r["auprc"]["rata"], "ci_recall": b.get("recall_fpr1_ci95"), "selisih_vs_B_ci": b.get("selisih_recall_fpr1_ci95"),
                    "perangkat": v.get("perangkat", "CPU lokal"), "detik": v.get("detik")})
    p = H["pemilihan"]
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"),
           "validasi": {"varian": val, "terpilih": p["terpilih"], "seri": p["seri_dengan_tertinggi"], "aturan": p["aturan"],
                        "baris": H["data"]["validasi"]["baris"], "fraud": H["data"]["validasi"]["fraud"],
                        "latih_baris": H["data"]["latih"]["baris"], "latih_fraud": H["data"]["latih"]["fraud"], "graf": H["data"].get("graf")}}
    g3 = D / "v4_graf_gen3.json"
    if g3.exists():
        G = json.loads(g3.read_text("utf-8"))
        out["gen3"] = {"varian": {k: {"nama": x["nama"], "validasi": x["validasi"], "gen3": x["gen3"], "bobot": x.get("bobot"),
                                      "cek_gpu": x.get("selisih_maks_logit_validasi_vs_skor_gpu")} for k, x in G["varian"].items()},
                       "graf": G["graf"], "catatan": G["catatan"], "dibuat": G["dibuat"], "n_skema": n_skema()}
    rt = D / "v4_rule_tambah.json"  # exploratory: v4 B with the rule engine's rules added (testing/v4_rule_tambah.py)
    if rt.exists():
        R = json.loads(rt.read_text("utf-8"))
        out["rule_tambah"] = {k: R[k] for k in ("dibuat", "jenis", "rule", "ambang", "hasil", "catatan")}
    m7 = D / "ml_v7_benchmark.json"  # ML v7 (testing/ml_v7.py): reviewer-order fix, generator 1-4
    if m7.exists():
        out["ml_v7"] = json.loads(m7.read_text("utf-8"))
    sd = D / "shift_diagnosis.json"  # distribution-shift diagnosis (testing/diagnosa_shift.py)
    if sd.exists():
        out["shift"] = json.loads(sd.read_text("utf-8"))
    m6 = D / "ml_v6_benchmark.json"  # ML v6 (testing/ml_v6.py): network features, benchmark on generator 1, 2, 3
    if m6.exists():
        out["ml_v6"] = json.loads(m6.read_text("utf-8"))
    mb = D / "ml_v5_benchmark.json"  # ML v5 (testing/ml_v5.py): benchmark on generator 1, 2, 3 against v3 and v4
    if mb.exists():
        out["ml_v5"] = json.loads(mb.read_text("utf-8"))
    v5 = D / "v5.json"  # v5 = v4 + rule engine + ADK swarm on Vertex (testing/v5.py), the fresh generator 3 seed scored once
    if v5.exists():
        out["v5"] = json.loads(v5.read_text("utf-8"))
    cpu = KERJA / "cek_cpu_load.json"
    run = KERJA / "run_runpod.txt"
    if cpu.exists():
        c = json.loads(cpu.read_text("utf-8"))
        menit = None
        if run.exists():
            import re
            m = re.findall(r"\[\s*([\d.]+) min\]", run.read_text("utf-8"))
            menit = float(m[-1]) if m else None
        out["gpu_cpu"] = {"gpu": "RunPod RTX 4090 (24 GB)", "menit_latih_semua_DEF": menit, "biaya_usd_kira": 0.18, "harga_per_jam": 0.89,
                          "cek": c, "catatan": "Bobot disimpan di CPU (state_dict); torch.load(map_location='cpu') di mesin tanpa GPU"}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    # inject into the served sistem.json without rebuilding the whole report (laporan_ml.py reads the same file)
    S = D / "sistem.json"
    if S.exists():
        s = json.loads(S.read_text("utf-8"))
        s["arsitektur_graf"] = out
        S.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    print("written", OUT, "and injected into sistem.json")


if __name__ == "__main__":
    main()
