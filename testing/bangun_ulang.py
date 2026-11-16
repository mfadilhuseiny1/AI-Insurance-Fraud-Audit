"""Rebuild the /testing model from scratch on a fresh data copy (after siapkan_data.py --force).

1. With the service running (start-testing.ps1), puts the clean training data through the realtime engine:
   - clean plants of nine single-claim schemes on members with an ordinary journey (a patient of the template's hospital,
     no claim in the stream), as POST /testing/api/augmentasi builds them, and
   - 2,000 ordinary claims built the same way (copy-built normals), so "a near-copy of an existing claim" carries no label.
2. Trains testing/model (latih_model.py) and the two comparison variants (model_tanpa_aug, model_tanpa_plant_sim), and
   writes testing/model/evaluasi.json.
3. Restart the service afterwards so it loads the new model.
About 20 minutes. Synthetic data only. Usage: .venv/Scripts/python.exe testing/bangun_ulang.py"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
B = "http://127.0.0.1:8320/testing/api"
PLANT = {"kelas_naik": 57, "prosedur_fiktif": 57, "kode_tidak_sesuai": 57, "topup_inflasi": 57, "topup_fiktif": 57, "dx_sekunder": 57,
         "kloning": 57, "upcoding": 97, "los_bergeser": 93}
NORMAL = 2000


def main() -> None:
    c = httpx.Client(timeout=1800)
    s = c.get(f"{B}/status").json()
    if not s.get("siap"):
        sys.exit("start the service first (testing/start-testing.ps1) and wait until it is ready")
    for sk, n in list(PLANT.items()) + [("normal", NORMAL)]:
        left = n
        while left > 0:
            r = c.post(f"{B}/augmentasi", json={"skenario": sk, "n": min(400, left)}).json()
            print(sk, r.get("dimasukkan"), "in", r.get("detik"), "s", r.get("gagal") or "", flush=True)
            left -= max(1, int(r.get("dimasukkan") or 0))
    env = dict(os.environ, PYTHONUTF8="1")
    py = sys.executable
    for args in (["--tanpa-aug", "--out", "model_tanpa_aug"], ["--tanpa-plant-simulator", "--out", "model_tanpa_plant_sim"], []):
        print("training", args or "final", flush=True)
        subprocess.run([py, str(HERE / "latih_model.py"), *args], check=True, env=env)
    keys = ["oof_auprc", "oof_ditandai_precision", "oof_ditandai_recall", "oof_fpr_normal", "holdout_bersih_recall", "holdout_normal_bersih_fpr",
            "holdout_plant_simulator_recall"]
    v = {d: json.loads((HERE / d / "kartu.json").read_text("utf-8")) for d in ("model_tanpa_aug", "model_tanpa_plant_sim", "model")}
    out = {"catatan": ("Tiga varian pelatihan /testing pada aliran sintetis FKRTL. model_tanpa_aug = hanya klaim simulator (seperti riset "
                       "sebelumnya); model_tanpa_plant_sim = plant bersih + normal hasil salinan, plant simulator 9 skema tidak dilatih "
                       "(holdout kedua); model = semua digabung (dipakai layanan). holdout_bersih = plant bersih yang tidak pernah dilatih "
                       "(generator yang sama); holdout_normal_bersih = klaim normal hasil salinan lewat formulir yang tidak pernah dilatih."),
           "varian": {d: {k: v[d].get(k) for k in keys} | {"holdout_bersih_per_skenario": v[d].get("holdout_bersih_per_skenario"),
                                                            "holdout_plant_simulator_per_skenario": v[d].get("holdout_plant_simulator_per_skenario")}
                      for d in v}}
    (HERE / "model" / "evaluasi.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), "utf-8")
    print("done: restart the service to load testing/model")


if __name__ == "__main__":
    main()
