"""v5 = v4 (variant B, frozen) + the rule engine + a multi-agent swarm (Google ADK, Vertex AI) for the uncertain claims.
Plan, zones, candidates and the adoption rule were fixed first in testing/kriteria_v5.json. Synthetic data only.

  siapkan --set validasi|gen3_v5   model scores, rule hits and zones (TAHAN / RAGU / LOLOS) for a set; the RAGU claims' dossiers
                                   to .tmp/swarm_v5/berkas_<set>.jsonl (features only: no score, label or scheme) for the swarm:
                                   .venv-adk/Scripts/python.exe testing/swarm_v5_adk.py jalankan --set <set> --masuk ... --keluar ...
  pilih                            on validation: tau for V5a / V5b at total FPR <= 1 %, the pick, frozen in testing/model_v5
  uji                              the fresh set (generator 3, GEN3_GARAM=gen3-v5), scored ONCE with everything frozen
Output: data/aip/ml/sistem_terbaru/v5.json."""
from __future__ import annotations

import argparse
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
import swarm_v5 as SW  # noqa: E402
import v4_final as V4  # noqa: E402
import v4_rule_tambah as RT  # noqa: E402
import varian_graf_dl as VG  # noqa: E402

# SWARM_V5_KERJA / UJI_SET_ROOT (testing/uji_riil.py): a real-data run keeps its files in the BPJS project's data folder
KERJA = Path(os.environ.get("SWARM_V5_KERJA") or ROOT / ".tmp" / "swarm_v5")
SET_ROOT = Path(os.environ.get("UJI_SET_ROOT") or ROOT / ".tmp")
MODEL = HERE / "model_v5"
SET_BARU = ROOT / ".tmp" / "gen3_v5"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "v5.json"
KRIT = json.loads((HERE / "kriteria_v5.json").read_text("utf-8"))
FPR_LEBAR, FPR_BUDGET = 0.03, 0.01


def _bundel():
    import joblib

    b = joblib.load(V4.MODEL / "model.joblib")
    assert b["varian"] == "B" and not b["aturan_v4"] and not b["rute_v3"].get("kolom") and not b["jaringan_v3"]
    b3 = joblib.load(HERE / "model_v3_bersih" / "model.joblib")
    aturan = [{k: r[k] for k in ("aturan", "fitur", "ambang")} for r in json.loads((V4.TMP / "data_v4" / "aturan_v4.json").read_text("utf-8"))["dipilih"]]
    return b, b3, aturan


def _rule(aturan, b3, X1, X4, XR) -> np.ndarray:
    f = np.zeros(len(X1), bool)
    for v in RT.komponen(aturan, b3.get("rute_rule") or {}, b3.get("rule_jaringan") or {}, X1, X4, XR).values():
        f |= v
    return f


def skor_model(model: str, X1: np.ndarray, X4: np.ndarray) -> np.ndarray:
    """The screening model's score: v4 (variant B, frozen) or ML v7 (testing/model_ml_v7, the adopted pick; same 646 features)."""
    import joblib

    if model == "ml_v7":
        b7 = joblib.load(HERE / "model_ml_v7" / "model.joblib")
        ms = b7["kandidat"][b7["pilihan"]]["models"]
    else:
        ms = joblib.load(V4.MODEL / "model.joblib")["models"]
    X = V4.fitur("B", X1, X4)
    return np.mean([m.predict_proba(X)[:, 1] for m in ms], axis=0)


def ambang_model(model: str) -> tuple[dict, Path]:
    """Zone thresholds and the q(s) reference of a screening model: v4's (set on validation by `siapkan --set validasi`) or
    ML v7's (testing/zona_ml_v7.py, on ML v7's pooled dev normals)."""
    if model == "ml_v7":
        z = json.loads((HERE / "model_ml_v7" / "zona_v5.json").read_text("utf-8"))["ambang"]
        return {"tahan": z["tahan"], "periksa_v4": z["periksa"], "lebar": z["lebar"]}, KERJA / "ref_ml_v7.npz"
    return json.loads((KERJA / "ambang.json").read_text("utf-8")), KERJA / "ref.npz"


def muat_set(nama: str, model: str = "v4") -> dict:
    """X1, X4, XR, kode, y, sk, grup (member), pertama (first visit) and a stable key per claim; premature discharge (mutu) out."""
    b, b3, _ = _bundel()
    if nama == "validasi":
        D = VG.muat_data()
        va = D["val"]
        ch, pos = D["chunk"][va], D["pos"][va]
        XRc = {c: np.load(V4.TMP / "data_v4" / f"fitur_{c:02d}.npz")["XR"] for c in np.unique(ch)}
        S = {"X1": D["X1"][va], "X4": D["X4"][va], "XR": np.vstack([XRc[c][p] for c, p in zip(ch, pos)]).astype(np.float32),
             "kode": D["kode"][va].astype(str), "sk": D["sk"][va].astype(str), "peserta": D["peserta"][va].astype(str), "pertama": D["pertama"][va],
             "kunci": np.array([f"val:{c}:{p}" for c, p in zip(ch, pos)]), "chunk": ch}
        lat = D["latih"] & (D["y"] == 0)
        ref = {"sys_names": list(b3["sys_names"]), "X1_normal_latih": D["X1"][lat][:, :124]}
        del D
    else:
        U = V4.muat_uji(SET_BARU if nama == "gen3_v5" else SET_ROOT / nama)
        assert U is not None, f"set {nama} belum ada"
        kode = np.concatenate([x["kode"].astype(str) for x in U["raw"]])
        ci = list(b3["sys_names"]).index(VG.KOLOM_KUNJUNGAN)
        nol = float(np.load(VG.STREAM, allow_pickle=False)["X1"][:, ci].min())
        posisi = np.concatenate([np.arange(len(x["sk"])) for x in U["raw"]])
        S = {"X1": U["X1"], "X4": U["X4"], "XR": U["XR"], "kode": kode, "sk": U["sk"], "peserta": U["peserta"].astype(str),
             "pertama": U["X1"][:, ci] <= nol + 1e-5, "kunci": np.array([f"{nama}:{c}:{p}" for c, p in zip(U["chunk"], posisi)]), "chunk": U["chunk"]}
        ref = None
    keep = ~np.isin(S["sk"], list(V4.MUTU))
    S = {k: v[keep] for k, v in S.items()}
    S["y"] = (~np.isin(S["sk"], A.NORMAL)).astype(int)
    S["grup"] = np.char.add(S["chunk"].astype(str), np.char.add(":", S["peserta"]))
    S["s"] = skor_model(model, S["X1"], S["X4"])
    return S | {"_ref": ref}


def zona(S: dict, ambang: dict, b3, aturan) -> dict:
    f_rule = _rule(aturan, b3, S["X1"], S["X4"], S["XR"])
    tahan = S["s"] >= ambang["tahan"]
    ragu = ~tahan & ((S["s"] >= ambang["lebar"]) | f_rule)
    return {"rule": f_rule, "tahan": tahan, "ragu": ragu}


def siapkan(nama: str, model: str = "v4") -> None:
    b, b3, aturan = _bundel()
    KERJA.mkdir(parents=True, exist_ok=True)
    assert not (nama == "validasi" and model != "v4"), "validasi menetapkan ambang v4; ambang ML v7 dari testing/zona_ml_v7.py"
    S = muat_set(nama, model)
    if nama == "validasi":
        nrm = S["y"] == 0
        ambang = {"tahan": float(b["ambang_tahan"]), "periksa_v4": float(b["ambang_periksa"]), "lebar": VG.ambang_fpr(S["s"][nrm], FPR_LEBAR)}
        q_ref = np.sort(S["s"][nrm])
        np.savez_compressed(KERJA / "ref.npz", X1_normal_latih=S["_ref"]["X1_normal_latih"], q_ref=q_ref)
        (KERJA / "ambang.json").write_text(json.dumps(ambang), "utf-8")
    else:
        assert (MODEL / "kartu.json").exists(), "bekukan dulu di validasi: v5.py pilih"
        ambang, q_file = ambang_model(model)
        # which screening model a set's zones come from, for the branch report and the ledger (testing/laporan_cabang.py)
        (KERJA / f"zona_{nama}.json").write_text(json.dumps({"model": model, "ambang": ambang, "q_ref": q_file.name}), "utf-8")
    ref = np.load(KERJA / "ref.npz")
    R = SW.Referensi(list(b3["sys_names"]), ref["X1_normal_latih"])
    Z = zona(S, ambang, b3, aturan)
    idx = np.flatnonzero(Z["ragu"])
    with (KERJA / f"berkas_{nama}.jsonl").open("w", encoding="utf-8") as fh:
        for i in idx:
            fh.write(json.dumps({"kunci": str(S["kunci"][i]), "teks": SW.berkas(R, S["X1"][i], S["X4"][i], S["XR"][i], str(S["kode"][i]),
                                                                                  S["X1"][i, 620:624], F4.NAMES)}, ensure_ascii=False) + "\n")
    np.savez_compressed(KERJA / f"zona_{nama}.npz", kunci=S["kunci"], y=S["y"], sk=S["sk"], s=S["s"], grup=S["grup"], pertama=S["pertama"],
                        rule=Z["rule"], tahan=Z["tahan"], ragu=Z["ragu"])
    n_batch = -(-len(idx) // 8)
    # cost guess from a dossier's length (~3 chars a token): 3 specialists + the judge (dossiers + opinions), ~1,500 output tokens each
    tok_berkas = np.mean([len(json.loads(l)["teks"]) for l in (KERJA / f"berkas_{nama}.jsonl").read_text("utf-8").splitlines()[:200]]) / 3 if len(idx) else 0
    usd = n_batch * (4 * (8 * tok_berkas + 600) * 0.30 + 4 * 1500 * 1.20) / 1e6
    print(json.dumps({"set": nama, "klaim": int(len(S["y"])), "fraud": int(S["y"].sum()), "tahan": int(Z["tahan"].sum()), "ragu": int(len(idx)),
                      "ragu_fraud_tidak_dibuka_ke_swarm": "label hanya untuk evaluasi", "batch": n_batch, "perkiraan_usd": round(usd, 2),
                      "ambang": ambang}, ensure_ascii=False))


def _p_swarm(nama: str, kunci: np.ndarray, ragu: np.ndarray) -> tuple[np.ndarray, int]:
    H = json.loads((KERJA / f"hasil_{nama}.json").read_text("utf-8"))["hasil"]
    p = np.full(len(kunci), np.nan)
    for i in np.flatnonzero(ragu):
        r = H.get(str(kunci[i]))
        if r:
            p[i] = float(r["p"])
    return p, int(np.isnan(p[ragu]).sum())


def mutu_swarm(nama: str, Zn: dict) -> dict:
    """Inside the uncertain zone: each agent's AUROC against the label, and the judge's p for fraud vs normal claims (10 bins)."""
    from sklearn.metrics import roc_auc_score

    H = json.loads((KERJA / f"hasil_{nama}.json").read_text("utf-8"))["hasil"]
    idx = [i for i in np.flatnonzero(Zn["ragu"]) if str(Zn["kunci"][i]) in H]
    y = Zn["y"][idx]
    rec = [H[str(Zn["kunci"][i])] for i in idx]
    out = {"n": len(idx), "fraud": int(y.sum())}
    if 0 < y.sum() < len(y):
        for a in ("koding", "tagihan", "episode"):
            out[f"auroc_{a}"] = round(float(roc_auc_score(y, [r["spesialis"][a] for r in rec])), 4)
        out["auroc_hakim"] = round(float(roc_auc_score(y, [r["p"] for r in rec])), 4)
        out["auroc_model_B"] = round(float(roc_auc_score(y, Zn["s"][idx])), 4)
    pj = np.array([r["p"] for r in rec])
    out["hist_p"] = {"batas": np.round(np.linspace(0, 1, 11), 1).tolist(),
                     "fraud": np.histogram(pj[y == 1], bins=10, range=(0, 1))[0].tolist(), "normal": np.histogram(pj[y == 0], bins=10, range=(0, 1))[0].tolist()}
    return out


def keputusan(Zn: dict, p: np.ndarray, varian: str, tau: float, q_ref: np.ndarray) -> np.ndarray:
    pp = np.nan_to_num(p, nan=0.0)  # an unreviewed uncertain claim is not flagged (reported apart)
    if varian == "V5a":
        f = pp
    else:
        q = np.searchsorted(q_ref, Zn["s"], "right") / len(q_ref)
        f = (pp + q) / 2
    return Zn["tahan"] | (Zn["ragu"] & (f >= tau))


def pilih() -> None:
    Zn = dict(np.load(KERJA / "zona_validasi.npz", allow_pickle=False))
    q_ref = np.load(KERJA / "ref.npz")["q_ref"]
    p, hilang = _p_swarm("validasi", Zn["kunci"], Zn["ragu"])
    y = Zn["y"]; nrm = y == 0
    kand = {}
    for v in ("V5a", "V5b"):
        best = None
        for tau in np.round(np.arange(0.0, 1.0001, 0.01), 2):
            f = keputusan(Zn, p, v, float(tau), q_ref)
            if f[nrm].mean() <= FPR_BUDGET:
                best = (float(tau), f)
                break
        tau, f = best
        kand[v] = {"tau": tau, **RT.ukur(y, f)}
    a, bb = kand["V5a"], kand["V5b"]
    pilihan = "V5b" if bb["recall"] - a["recall"] >= 0.01 else "V5a"
    ambang = json.loads((KERJA / "ambang.json").read_text("utf-8"))
    lebar = keputusan(Zn, p, "V5a", 0.5, q_ref)
    kartu = {"dibekukan": time.strftime("%Y-%m-%d %H:%M"), "kriteria": "testing/kriteria_v5.json", "ambang": ambang, "kandidat": kand, "pilihan": pilihan,
             "tau": kand[pilihan]["tau"], "ragu_tanpa_jawaban_swarm": hilang,
             "validasi": {"v4_B": RT.ukur(y, Zn["s"] > ambang["periksa_v4"]), "v5": kand[pilihan], "v5_lebar_p05": RT.ukur(y, lebar),
                          "ragu": {"klaim": int(Zn["ragu"].sum()), "fraud": int((Zn["ragu"] & ~nrm).sum())}, "swarm": mutu_swarm("validasi", Zn)}}
    MODEL.mkdir(exist_ok=True)
    (MODEL / "kartu.json").write_text(json.dumps(kartu, ensure_ascii=False, indent=1), "utf-8")
    print(json.dumps(kartu, ensure_ascii=False))


def _boot(y, f0, f1, grup):
    return RT.boot_selisih(y, f0, f1, grup)


def uji() -> None:
    K = json.loads((MODEL / "kartu.json").read_text("utf-8"))
    tanda = MODEL / "uji_sekali.txt"
    assert not tanda.exists(), f"set baru sudah dinilai ({tanda.read_text('utf-8').strip()}): v5 hanya dinilai sekali"
    nama = "gen3_v5"
    Zn = dict(np.load(KERJA / f"zona_{nama}.npz", allow_pickle=False))
    q_ref = np.load(KERJA / "ref.npz")["q_ref"]
    p, hilang = _p_swarm(nama, Zn["kunci"], Zn["ragu"])
    y, nrm = Zn["y"], Zn["y"] == 0
    am = K["ambang"]
    v4 = Zn["s"] > am["periksa_v4"]
    v4_rule = v4 | Zn["rule"]
    v5 = keputusan(Zn, p, K["pilihan"], K["tau"], q_ref)
    lebar = keputusan(Zn, p, "V5a", 0.5, q_ref)
    tahan = Zn["tahan"]
    hasil = {"klaim": int(len(y)), "fraud": int(y.sum()), "prevalensi": round(float(y.mean()), 5), "ragu": int(Zn["ragu"].sum()),
             "ragu_fraud": int((Zn["ragu"] & ~nrm).sum()), "ragu_tanpa_jawaban_swarm": hilang,
             "v4_B": RT.ukur(y, v4), "v4_plus_rule": RT.ukur(y, v4_rule), "v5": RT.ukur(y, v5), "v5_lebar_p05": RT.ukur(y, lebar), "tahan": RT.ukur(y, tahan),
             "selisih_v5_vs_v4_ci": _boot(y, v4, v5, Zn["grup"]), "selisih_lebar_vs_v4_ci": _boot(y, v4, lebar, Zn["grup"]),
             "fpr_kunjungan_pertama": {k: round(float(f[nrm & Zn["pertama"]].mean()), 5) for k, f in (("v4_B", v4), ("v5", v5))},
             "fpr_pasien_lama": {k: round(float(f[nrm & ~Zn["pertama"]].mean()), 5) for k, f in (("v4_B", v4), ("v5", v5))},
             "per_skema": {k: VG.recall_per_skema(Zn["sk"][y == 1], f[y == 1]) for k, f in (("v4_B", v4), ("v4_plus_rule", v4_rule), ("v5", v5))},
             "n_skema": {str(k): int(v) for k, v in zip(*np.unique([VG.skema_dasar(x) for x in Zn["sk"][y == 1]], return_counts=True))},
             "swarm_di_zona_ragu": {"fraud_dipertahankan_p05": round(float((np.nan_to_num(p)[Zn["ragu"] & ~nrm] >= 0.5).mean()), 4),
                                    "normal_dibuang_p05": round(float((np.nan_to_num(p)[Zn["ragu"] & nrm] < 0.5).mean()), 4), **mutu_swarm(nama, Zn)}}
    d = hasil["selisih_v5_vs_v4_ci"]
    adopsi = d["recall"][0] > 0 and (hasil["v5"]["presisi_prev2"] - hasil["v4_B"]["presisi_prev2"]) >= -0.02
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "model": K, "set": "generator 3 seed baru (GEN3_GARAM=gen3-v5), dinilai sekali", "hasil": hasil,
           "adopsi": {"aturan": KRIT["aturan_adopsi"], "lolos": bool(adopsi)},
           "biaya_swarm": {k: json.loads((KERJA / f"hasil_{k}.json").read_text("utf-8"))["biaya"] for k in ("validasi", nama)}}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), "utf-8")
    tanda.write_text(time.strftime("%Y-%m-%d %H:%M"), "utf-8")
    print(json.dumps({k: hasil[k] for k in ("v4_B", "v4_plus_rule", "v5", "v5_lebar_p05")}), "adopsi", adopsi)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["siapkan", "pilih", "uji"])
    ap.add_argument("--set", default="validasi", help="validasi, gen3_v5, or any generator run folder in .tmp (a branch batch, e.g. gen3_kc1)")
    ap.add_argument("--model", default="v4", choices=["v4", "ml_v7"], help="screening model of the flow (ML v7: zones from testing/zona_ml_v7.py)")
    a = ap.parse_args()
    if a.perintah == "siapkan":
        VG.LOCK_NAMA = f"v5-siapkan-{a.set}"
        with VG.kunci_berat():
            siapkan(a.set, a.model)
    elif a.perintah == "pilih":
        pilih()
    else:
        uji()
