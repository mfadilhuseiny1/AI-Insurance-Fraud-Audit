"""New rules from the X4 mechanism features (the user, 2026-11-12: "tambah rule kalau memungkinkan bisa ningkatin precision, recall,
AUPRC"), chosen by the pre-registered rule in testing/kriteria_v4.json: candidates and thresholds are judged on the TRAINING rows
(stream + data_v4 chunks 0–7) for their normal-claim fire rate and on the VALIDATION members (chunks 8–9) for what they add; no test
set is read. A rule is kept when it fires on <= 0.5 % of normal training claims and its precision on validation is >= 30 %. The kept
rules are appended to kriteria_v4.json as an addendum (with a timestamp) and written to .tmp/data_v4/aturan_v4.json for the v4 route.
Synthetic data only."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
import arsitektur_v2 as A  # noqa: E402
import fitur_v4 as F4  # noqa: E402

D4 = ROOT / ".tmp" / "data_v4"
MAKS_NORMAL, MIN_PRESISI = 0.005, 0.30
# candidates: (name, X4 column, comparison, thresholds tried)
KANDIDAT = [
    ("GANDA_DEKAT_BIAYA_MIRIP", "v4: ganda_dekat_biaya_mirip", ">=", [1, 2]),
    ("KLON_MIRIP", "v4: klon_mirip_3h", ">=", [1, 2, 3]),
    ("KLON_MIRIP_14H", "v4: klon_mirip_14h", ">=", [2, 3, 5]),
    ("READMISI_SETELAH_RAWAT_PENDEK", "v4: readmisi_setelah_rawat_pendek", ">=", [1]),
    ("RAWAT_TERLALU_PENDEK", "v4: los_di_bawah_p10", ">=", [1]),
    ("KARTU_DI_RS_LAIN_HARI_SAMA", "v4: peserta_hari_sama_rs_lain", ">=", [1, 2]),
    ("TOPUP_JAUH_DI_ATAS_KODE", "v4: topup_rasio_median_kode", ">=", [2.0, 3.0, 5.0]),
    ("DX_SEKUNDER_DI_ATAS_P90", "v4: dx_sekunder_di_atas_p90", ">=", [2, 3, 5]),
    ("RS_SEV3_NAIK", "v4: rs_sev3_drift", ">=", [0.15, 0.25, 0.35]),
    ("RS_RAWAT_PENDEK_NAIK", "v4: rs_rawat_pendek_drift", ">=", [0.15, 0.25, 0.35]),
]


def muat(chunks) -> tuple[np.ndarray, np.ndarray]:
    ds = [np.load(D4 / f"fitur_{c:02d}.npz") for c in chunks]
    return np.vstack([d["X4"] for d in ds]), np.concatenate([d["sk"] for d in ds]).astype(str)


def main() -> None:
    s4 = np.load(D4 / "stream_x4.npz", allow_pickle=True)
    Xl, skl = muat(range(8))
    X_lat = np.vstack([s4["X4"], Xl])
    y_lat = ~np.isin(np.concatenate([s4["sk"].astype(str), skl]), A.NORMAL)
    Xv, skv = muat((8, 9))
    yv = ~np.isin(skv, A.NORMAL)
    hari_v = 14 * 2  # two validation chunks, each a 14-day window
    hasil, pilih = [], []
    for nama, kol, op, ambang in KANDIDAT:
        j = F4.NAMES.index(kol)
        terbaik = None
        for t in ambang:
            fl, fv = X_lat[:, j] >= t, Xv[:, j] >= t
            laju = float(fl[~y_lat].mean())
            tp, fp = int((fv & yv).sum()), int((fv & ~yv).sum())
            prec = tp / max(1, tp + fp)
            row = {"aturan": nama, "fitur": kol, "ambang": t, "laju_normal_latih": round(laju, 5), "validasi_tp": tp, "validasi_fp": fp,
                   "validasi_precision": round(prec, 4), "validasi_recall": round(tp / max(1, int(yv.sum())), 4), "per_hari_validasi": round((tp + fp) / hari_v, 2),
                   "skema": {s: int((fv & (skv == s)).sum()) for s in sorted(set(skv[fv & yv]))}}
            hasil.append(row)
            if laju <= MAKS_NORMAL and prec >= MIN_PRESISI and tp > 0 and (terbaik is None or tp > terbaik["validasi_tp"]):
                terbaik = row
        if terbaik:
            pilih.append(terbaik)
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "syarat": {"maks_laju_normal_latih": MAKS_NORMAL, "min_precision_validasi": MIN_PRESISI},
           "dipilih": pilih, "semua": hasil}
    (D4 / "aturan_v4.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    k = json.loads((HERE / "kriteria_v4.json").read_text("utf-8"))
    k.setdefault("adendum", []).append({"ditulis": time.strftime("%Y-%m-%d %H:%M") + ", sebelum uji akhir mana pun",
                                         "rule_v4_dipilih": [{kk: r[kk] for kk in ("aturan", "fitur", "ambang", "laju_normal_latih", "validasi_precision", "validasi_recall")} for r in pilih],
                                         "syarat": out["syarat"]})
    (HERE / "kriteria_v4.json").write_text(json.dumps(k, ensure_ascii=False, indent=1), "utf-8")
    for r in hasil:
        print(f"{r['aturan']:32s} >= {r['ambang']:<5} normal {r['laju_normal_latih'] * 100:6.3f}%  val TP {r['validasi_tp']:4d} FP {r['validasi_fp']:4d} "
              f"P {r['validasi_precision'] * 100:5.1f}%  {'<- dipilih' if r in pilih else ''}")


if __name__ == "__main__":
    main()
