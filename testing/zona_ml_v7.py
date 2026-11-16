"""ML v7 inside v5's flow (the user, 2026-11-13: "pastikan v7 end2end terintegrasi ke box karantina sama sistem multiagent swarm").

v5 = screening model + rule engine + the ADK swarm for the uncertain zone. Its zones were set for v4 on generator 1's validation
set; for ML v7 they are set the same way on ML v7's own pooled dev normals (generator 1 + 2 + 2-halus dev, never a test set):
  TAHAN    = FPR 0.1 %  (ML v7's frozen ambang_tahan)
  PERIKSA  = FPR 1 %    (ML v7's frozen ambang_periksa; the "model alone" comparison)
  LEBAR    = FPR 3 %    (the uncertain zone the swarm reads, as v5's FPR_LEBAR)
  q_ref    = the dev normals' scores, for the percentile q(s) in v5's decision (p + q(s)) / 2 >= tau
tau (0.72) is v5's frozen value, not re-chosen (re-choosing it would need the swarm on a validation set).
-> testing/model_ml_v7/zona_v5.json, .tmp/swarm_v5/ref_ml_v7.npz. Synthetic data only."""
from __future__ import annotations

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
import ml_v7 as V7  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

OUT = V7.MODEL / "zona_v5.json"
REF = HERE.parent / ".tmp" / "swarm_v5" / "ref_ml_v7.npz"


def main() -> None:
    import joblib

    b7 = joblib.load(V7.MODEL / "model.joblib")
    k7 = b7["kandidat"][b7["pilihan"]]
    S = V7.muat_semua()
    dev = V7.gabung(S["g1_dev"], S["g2_dev"], S["g2h_dev"])
    s = V7.M.skor(k7["models"], dev["X"])
    nrm = dev["y"] == 0
    ambang = {"tahan": float(k7["ambang_tahan"]), "periksa": float(k7["ambang_periksa"]), "lebar": VG.ambang_fpr(s[nrm], 0.03)}
    REF.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(REF, q_ref=np.sort(s[nrm]))
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "model": "ml_v7", "pilihan": b7["pilihan"], "ambang": ambang,
           "dev": {"klaim": int(len(dev["y"])), "normal": int(nrm.sum()), "fraud": int(dev["y"].sum())},
           "cek": {"fpr_tahan": round(float((s[nrm] >= ambang["tahan"]).mean()), 5), "fpr_periksa": round(float((s[nrm] > ambang["periksa"]).mean()), 5),
                   "fpr_lebar": round(float((s[nrm] >= ambang["lebar"]).mean()), 5),
                   "recall_periksa": round(float((s[~nrm] > ambang["periksa"]).mean()), 4), "recall_lebar": round(float((s[~nrm] >= ambang["lebar"]).mean()), 4)},
           "tau": "0,72 dari v5 (testing/model_v5/kartu.json), tidak dipilih ulang"}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
