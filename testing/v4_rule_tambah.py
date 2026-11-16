"""Exploratory: what precision and recall does v4 (variant B, frozen in testing/model_v4) get with the rule engine added?

The frozen v4 has an empty review route: on validation no rule raised recall at FPR 1 % (testing/v4_final.py latih). The user asked
to see the numbers with the rules switched on anyway. The rule set is the one the engine would run, fixed before any test set is read:
  - the 5 v4 rules chosen on validation (.tmp/data_v4/aturan_v4.json "dipilih"),
  - v3's rule route (built-in engine rule signals, testing/model_v3_bersih "rute_rule"),
  - v3's label-free network rule ("rule_jaringan").
Three ways to add them, all thresholds from the validation normals only:
  1. "atas"     rule hit -> PERIKSA on top of the frozen model threshold (more caught, more false alarms);
  2. "anggaran" model threshold re-set on validation so that (model OR rules) keeps FPR <= 1 % (same false-alarm budget);
  3. "rule saja" the rules alone, for context.
TAHAN (hold) is unchanged: rules only send a claim to review.
Sets: validation (chunks 8-9, where everything was chosen), test C2 and gen2 seed 3 (second use), generator 3 (third use). This is a
look, not a selection: v4 stays B as pre-registered; adopting a route would need a fresh set scored once.
Output: data/aip/ml/sistem_terbaru/v4_rule_tambah.json. Synthetic data only."""
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
import arsitektur_v2 as A  # noqa: E402
import fitur_v4 as F4  # noqa: E402
import v4_final as V4  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "v4_rule_tambah.json"
PREV = 0.02


def komponen(aturan: list[dict], rr: dict, rj: dict, X1: np.ndarray, X4: np.ndarray, XR: np.ndarray) -> dict[str, np.ndarray]:
    k = {}
    for r in aturan:
        k[f"v4 · {r['aturan']}"] = X4[:, F4.NAMES.index(r["fitur"])] >= r["ambang"]
    for kol, nm in zip(rr.get("kolom") or [], rr.get("nama") or []):
        k[f"bawaan · {nm[2:] if nm.startswith('s:') else nm}"] = X1[:, kol] > 0
    if rj:
        k["jaringan · network rule"] = np.round(np.expm1(XR[:, rj["kolom"]])) >= rj["ambang"]
    return k


def ukur(y: np.ndarray, f: np.ndarray) -> dict:
    y = y.astype(bool)
    r, fpr = float(f[y].mean()), float(f[~y].mean())
    return {"recall": round(r, 4), "fpr": round(fpr, 5), "presisi_prev2": round(VG.presisi_prevalensi(r, fpr, PREV), 4),
            "presisi_mentah": round(float(y[f].mean()) if f.any() else 0.0, 4), "ditandai": int(f.sum())}


def boot_selisih(y: np.ndarray, f0: np.ndarray, f1: np.ndarray, grup: np.ndarray, B: int = 1000) -> dict:
    """Member-level paired bootstrap of recall, FPR and precision-at-2% differences (f1 - f0)."""
    rng = np.random.default_rng(0)
    u, inv = np.unique(grup, return_inverse=True)
    order = np.argsort(inv, kind="stable")
    starts = np.r_[0, np.cumsum(np.bincount(inv))]
    dr, df, dp = [], [], []
    yb = y.astype(bool)
    for _ in range(B):
        pick = rng.integers(0, len(u), len(u))
        ii = np.concatenate([order[starts[i]:starts[i + 1]] for i in pick])
        yy = yb[ii]
        a, b = f0[ii], f1[ii]
        r0, r1, q0, q1 = a[yy].mean(), b[yy].mean(), a[~yy].mean(), b[~yy].mean()
        dr.append(r1 - r0); df.append(q1 - q0)
        dp.append(VG.presisi_prevalensi(r1, q1, PREV) - VG.presisi_prevalensi(r0, q0, PREV))
    q = lambda a: [round(float(np.percentile(a, 2.5)), 4), round(float(np.percentile(a, 97.5)), 4)]  # noqa: E731
    return {"recall": q(dr), "fpr": q(df), "presisi_prev2": q(dp)}


def nilai_set(nama: str, y, s, kmp, t_model, t_anggaran, t_tahan, sk, pertama, grup) -> dict:
    f_rule = np.zeros(len(y), bool)
    for v in kmp.values():
        f_rule |= v
    nrm = y == 0
    model = s > t_model
    atas = model | f_rule
    angg = (s > t_anggaran) | f_rule
    res = {"klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 5),
           "B_saja": ukur(y, model), "B_plus_rule_atas": ukur(y, atas), "B_plus_rule_anggaran": ukur(y, angg), "rule_saja": ukur(y, f_rule),
           "tahan_tidak_berubah": ukur(y, s > t_tahan),
           "selisih_ci": {"atas": boot_selisih(y, model, atas, grup), "anggaran": boot_selisih(y, model, angg, grup)},
           "fpr_kunjungan_pertama": {"B_saja": round(float(model[nrm & pertama].mean()), 5), "atas": round(float(atas[nrm & pertama].mean()), 5)},
           "fpr_pasien_lama": {"B_saja": round(float(model[nrm & ~pertama].mean()), 5), "atas": round(float(atas[nrm & ~pertama].mean()), 5)},
           "per_skema": {"B_saja": VG.recall_per_skema(sk[y == 1], model[y == 1]), "atas": VG.recall_per_skema(sk[y == 1], atas[y == 1])}}
    # each rule's own effect on top of the model: fraud it adds that the model missed, normals it adds that the model left alone
    per = []
    for k, v in kmp.items():
        tambah_f, tambah_n = int((v & ~model & ~nrm).sum()), int((v & ~model & nrm).sum())
        if v.any():
            per.append({"rule": k, "kena": int(v.sum()), "fraud_baru": tambah_f, "normal_baru": tambah_n,
                        "presisi_mentah": round(float((~nrm)[v].mean()), 4), "sudah_ditangkap_model": int((v & model & ~nrm).sum())})
    res["per_rule"] = sorted(per, key=lambda d: -(d["fraud_baru"] + d["normal_baru"]))
    print(nama, json.dumps({k: res[k] for k in ("B_saja", "B_plus_rule_atas", "B_plus_rule_anggaran", "rule_saja")}), flush=True)
    return res


def main() -> None:
    import joblib

    b = joblib.load(V4.MODEL / "model.joblib")
    assert b["varian"] == "B" and not b["aturan_v4"] and not b["rute_v3"].get("kolom") and not b["jaringan_v3"]
    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    aturan = [{k: r[k] for k in ("aturan", "fitur", "ambang")} for r in json.loads((V4.TMP / "data_v4" / "aturan_v4.json").read_text("utf-8"))["dipilih"]]
    rr, rj = b3.get("rute_rule") or {}, b3.get("rule_jaringan") or {}
    t_model, t_tahan = b["ambang_periksa"], b["ambang_tahan"]

    # validation: the frozen models' scores and the rule hits; the "anggaran" threshold is set here and nowhere else
    D = VG.muat_data()
    va = D["val"]
    X = V4.fitur("B", D["X1"], D["X4"])
    s_val = np.mean([m.predict_proba(X[va])[:, 1] for m in b["models"]], axis=0)
    del X
    ch, pos = D["chunk"][va], D["pos"][va]
    XR_c = {c: np.load(V4.TMP / "data_v4" / f"fitur_{c:02d}.npz")["XR"] for c in np.unique(ch)}
    XR_val = np.vstack([XR_c[c][p] for c, p in zip(ch, pos)]).astype(np.float32)
    y_val = D["y"][va].astype(int)
    kmp_val = komponen(aturan, rr, rj, D["X1"][va], D["X4"][va], XR_val)
    f_val = np.zeros(int(va.sum()), bool)
    for v in kmp_val.values():
        f_val |= v
    nrm = y_val == 0
    sisa = max(0.0, 0.01 - float(f_val[nrm].mean()))
    cand = np.sort(s_val[nrm & ~f_val])[::-1]
    kk = int(np.floor(sisa * nrm.sum()))
    t_angg = float(cand[min(kk, len(cand) - 1)]) if len(cand) and kk > 0 else float(cand[0])
    grup_val = np.char.add(ch.astype(str), np.char.add(":", D["peserta"][va].astype(str)))
    hasil = {"validasi": nilai_set("validasi", y_val, s_val, kmp_val, t_model, t_angg, t_tahan, D["sk"][va], D["pertama"][va], grup_val)}
    hasil["validasi"]["penggunaan"] = "tempat semua ambang dan rule dipilih"
    del D

    pakai = {"uji_c2": "pemakaian ke-2", "gen2_seed3": "pemakaian ke-2", "generator3": "pemakaian ke-3"}
    for nama, d in V4.UJI.items():
        U = V4.muat_uji(d)
        if U is None:
            continue
        keep = ~np.isin(U["sk"], list(V4.MUTU))
        U = {k: (v[keep] if isinstance(v, np.ndarray) and len(v) == len(keep) else v) for k, v in U.items()}
        s = np.mean([m.predict_proba(V4.fitur("B", U["X1"], U["X4"]))[:, 1] for m in b["models"]], axis=0)
        y = (~np.isin(U["sk"], A.NORMAL)).astype(int)
        col = U["X1"][:, list(b3["sys_names"]).index(VG.KOLOM_KUNJUNGAN)]
        nol = float(np.load(VG.STREAM, allow_pickle=False)["X1"][:, list(b3["sys_names"]).index(VG.KOLOM_KUNJUNGAN)].min())
        grup = np.char.add(U["chunk"].astype(str), np.char.add(":", U["peserta"].astype(str)))
        kmp = komponen(aturan, rr, rj, U["X1"], U["X4"], U["XR"])
        hasil[nama] = nilai_set(nama, y, s, kmp, t_model, t_angg, t_tahan, U["sk"], col <= nol + 1e-5, grup)
        hasil[nama]["penggunaan"] = pakai[nama]

    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "jenis": "eksplorasi (bukan pemilihan model)",
           "rule": {"v4": [r["aturan"] for r in aturan], "bawaan_v3": len(rr.get("kolom") or []), "jaringan": bool(rj)},
           "ambang": {"model_beku": t_model, "model_anggaran_1persen": t_angg, "tahan": t_tahan,
                      "laju_rule_normal_validasi": round(float(f_val[nrm].mean()), 5)},
           "hasil": hasil,
           "catatan": ["Rule dan ambang ditetapkan di validasi sebelum set uji dibaca; set uji dipakai ulang (test C2 dan gen2 seed 3 ke-2, generator 3 ke-3)",
                       "v4 tetap B (pilihan pra-registrasi); memakai rule route butuh set baru yang dinilai sekali",
                       "Rule hanya mengirim klaim ke PERIKSA; TAHAN tidak berubah"]}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    print("written", OUT)


if __name__ == "__main__":
    VG.LOCK_NAMA = "rule-tambah"
    with VG.kunci_berat():
        main()
