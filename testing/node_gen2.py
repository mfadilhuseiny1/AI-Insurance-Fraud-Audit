"""Which v3 node earns recall and precision, and which one costs them (the user, 2026-11-12: "node mana yg menyumbang hasil
precision & recall bagus, node mana yg jelek di arsitektur, biar tau mana yg harus diperbaiki").

Measured on claims no v3 model trained on: generator 2 (200.032 claims, testing/uji_gen2.py) and test B (generator 1's fresh
test, .tmp/uji100k_b). Each is scored as run and with the rounding-skew diagnostic of laporan_gen2.py (served values snapped
to the batch value they differ from only by rounding; no model or threshold changed). Per node:
  own quality      engine rule decision, each layer's AUPRC (a specialist on its own family vs normal claims, next to Model 1
                   on the same claims), the fused probability, the two rules on their own;
  share of the decision   the final flag is (calibrated p >= 0.5) OR rule route OR network rule: fraud caught and normal claims
                   flagged by each path, only by that path, and the decision without it;
  rounding shortcut       splits of each layer at a rounding boundary and their share of its gain.
Nothing is tuned or chosen here. Aggregates only, synthetic data only. model_v3 is scored on the stored features, the same rows
as generator2.json (sanity checks below). Writes data/aip/ml/sistem_terbaru/generator2_node.json and the generator2_node key
of sistem.json. laporan_ml.py reads the same file.

Usage: .venv/Scripts/python.exe testing/node_gen2.py"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

os.environ.setdefault("BLUESANDAI_AUTH", "off")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import arsitektur_v2 as A  # noqa: E402

G2 = ROOT / ".tmp" / "gen2"
UJI_B = ROOT / ".tmp" / "uji100k_b"
STREAM = ROOT / ".tmp" / "v2_stream.npz"
MODEL = "model_v3"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "generator2_node.json"
SISTEM = OUT.parent / "sistem.json"
GEN2_JSON = OUT.parent / "generator2.json"
LAYER = ["model1", "koding", "tagihan", "episode", "identitas"]
SPESIALIS = LAYER[1:]
T0 = time.time()


def log(*a) -> None:
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


# ---- the snap diagnostic, exactly as laporan_gen2.py main() (block "train/serve skew")
def kolom_bulat(Xs: np.ndarray) -> dict[int, np.ndarray]:
    return {j: np.unique(Xs[:, j]) for j in range(Xs.shape[1]) if len(np.unique(Xs[:, j])) <= 60}


def snap(X: np.ndarray, U: dict[int, np.ndarray]) -> np.ndarray:
    X = X.copy()
    for j, u in U.items():
        v = X[:, j]
        k = np.clip(np.searchsorted(u, v), 1, len(u) - 1)
        lo, hi = u[k - 1], u[k]
        dekat = np.where(np.abs(v - lo) <= np.abs(hi - v), lo, hi)
        ok = np.abs(dekat - v) <= 1e-6 * (1 + np.abs(v))
        X[ok, j] = dekat[ok]
    return X


def split_bulat(model, kolom, U: dict[int, np.ndarray], latih: list[np.ndarray]) -> dict:
    """Splits of one layer at a rounding boundary, two ways.
    split / gain_pct: laporan_gen2.py's test (threshold within the tolerance of a stream value). It also counts ordinary splits
      at 0 (LightGBM's zero bin, e.g. a rule signal 0 vs > 0), so it overstates the shortcut.
    bising / bising_gain_pct: the strict test, a split inside rounding noise: the training data (stream batch + data v2 per
      claim) has values within twice the tolerance on BOTH sides of the threshold."""
    n, g, nb, gb, tot, total = 0, 0.0, 0, 0.0, 0.0, 0

    def jalan(nd: dict) -> None:
        nonlocal n, g, nb, gb, tot, total
        if "split_feature" not in nd:
            return
        total += 1
        sg = nd.get("split_gain", 0.0)
        tot += sg
        j = nd["split_feature"] if kolom is None else int(kolom[nd["split_feature"]])
        t = nd["threshold"]
        tol = 1e-6 * (1 + abs(t))
        # float64 throughout: LightGBM compares the float32 value cast to double with a double threshold (float32 arithmetic
        # would round t and can drop the only value on one side; found by ai-jkn-audit-54, 2026-11-12)
        if j in U and np.min(np.abs(U[j].astype(np.float64) - t)) <= tol:
            n += 1
            g += sg
            near = np.concatenate([x[np.abs(x - t) <= 2 * tol] for x in (c[:, j].astype(np.float64) for c in latih)])
            if (near < t).any() and (near > t).any():
                nb += 1
                gb += sg
        jalan(nd["left_child"])
        jalan(nd["right_child"])

    for tr in model.booster_.dump_model()["tree_info"]:
        jalan(tr["tree_structure"])
    return {"split": n, "split_total": total, "gain_pct": round(g / max(1e-9, tot) * 100, 2),
            "bising": nb, "bising_gain_pct": round(gb / max(1e-9, tot) * 100, 2)}


# ---- data
def muat(folder: Path, gen2: bool, b: dict, U: dict, kf: int) -> dict:
    files = sorted(folder.glob("hasil_[0-9][0-9].npz"))
    acc: dict[str, list] = {}
    for f in files:
        d = np.load(f, allow_pickle=False)
        X1 = d["X1"]
        rule = np.isin(d["keputusan"].astype(str), ["PERIKSA", "TAHAN"]) if gen2 else (d["tahan"] | d["periksa"]).astype(bool)
        part = {"y": d["y"].astype(bool), "sk": d["sk"].astype(str), "rule": rule, "kf": X1[:, kf].astype(np.float64)}
        for mode, X in (("raw", X1), ("snap", snap(X1, U))):
            s = A.skor(b, X, d["X2"], d["XR"])
            for k in LAYER + ["cal", "rute", "jaringan_rule", "flag"]:
                part[f"{mode}:{k}"] = np.asarray(s[k])
        for k, v in part.items():
            acc.setdefault(k, []).append(v)
        log(folder.name, f.name, len(X1))
    return {k: np.concatenate(v) for k, v in acc.items()}


# ---- metrics
def r(v: float, d: int = 4) -> float:
    return round(float(v), d)


def ukur(f: np.ndarray, y: np.ndarray) -> dict:
    f, y = f.astype(bool), y.astype(bool)
    tp, fp, fn = int((f & y).sum()), int((f & ~y).sum()), int((~f & y).sum())
    return {"tp": tp, "fp": fp, "recall": r(tp / max(1, tp + fn)), "precision": r(tp / (tp + fp)) if tp + fp else 0.0,
            "fpr": r(fp / max(1, int((~y).sum())), 5)}


def ap(y: np.ndarray, s: np.ndarray) -> float | None:
    return r(average_precision_score(y, s)) if y.any() and (~y).any() else None


def auc(y: np.ndarray, s: np.ndarray) -> float | None:
    return r(roc_auc_score(y, s)) if y.any() and (~y).any() else None


def nilai_data(D: dict, b: dict, nol: float, fam_skema: dict[str, str | None]) -> dict:
    y = D["y"]
    fam = np.array([fam_skema.get(s, A.famili_dari(s)) if yy else None for s, yy in zip(D["sk"], D["y"])], dtype=object)
    pertama = D["kf"] <= nol + 1e-6
    out: dict = {"klaim": int(len(y)), "fraud": int(y.sum()), "normal": int((~y).sum()),
                 "normal_kunjungan_pertama": int((~y & pertama).sum())}
    for mode in ("raw", "snap"):
        M = D[f"{mode}:cal"] >= b["ambang_peluang"]
        R, J, F = D[f"{mode}:rute"].astype(bool), D[f"{mode}:jaringan_rule"].astype(bool), D[f"{mode}:flag"].astype(bool)
        assert np.array_equal(F, M | R | J), "decision is not model OR route OR network rule"
        o: dict = {"keputusan": ukur(F, y), "engine": ukur(D["rule"], y)}
        o["lapisan"] = {}
        for k in LAYER:
            p = D[f"{mode}:{k}"]
            row = {"auprc": ap(y, p), "auroc": auc(y, p)}
            if k in SPESIALIS:  # the specialist on its own family vs all normal claims, Model 1 on the same claims
                m = (fam == k) | ~y
                row.update({"n_famili": int((fam == k).sum()), "auprc_famili": ap(y[m], p[m]), "auprc_famili_model1": ap(y[m], D[f"{mode}:model1"][m])})
            o["lapisan"][k] = row
        o["fusi"] = {"auprc": ap(y, D[f"{mode}:cal"]), "auroc": auc(y, D[f"{mode}:cal"])}
        jalur = {"model": M, "rute": R, "jaringan": J}
        o["jalur"] = {}
        for nm, P in jalur.items():
            lain = np.zeros(len(y), bool)
            for nm2, P2 in jalur.items():
                if nm2 != nm:
                    lain |= P2
            tanpa = ukur(lain, y)
            o["jalur"][nm] = {**ukur(P, y), "unik_tp": int((P & ~lain & y).sum()), "unik_fp": int((P & ~lain & ~y).sum()),
                              "fp_kunjungan_pertama": int((P & ~y & pertama).sum()),
                              "tanpa": {"recall": tanpa["recall"], "precision": tanpa["precision"], "fpr": tanpa["fpr"]}}
        o["famili"] = []
        for k in ["koding", "tagihan", "episode", "identitas", "jaringan"]:
            m = fam == k
            if m.any():
                o["famili"].append({"famili": k, "n": int(m.sum()), "recall": r(F[m].mean()), "model": r(M[m].mean()), "rute": r(R[m].mean()),
                                    "jaringan": r(J[m].mean()), "engine": r(D["rule"][m].mean())})
        out[mode] = o
    return out


def main() -> None:
    b = joblib.load(HERE / MODEL / "model.joblib")
    sn = list(b["sys_names"])
    kf = sn.index("klaim: kunjungan_peserta_faskes")
    import latih_v2 as LV

    g2 = json.loads(GEN2_JSON.read_text("utf-8"))
    fam_skema = {s["skema"]: s["famili"] for s in g2["skema"]}  # generator 2's own families, incl. its two new schemes
    Xs = np.load(STREAM, allow_pickle=True)["X1"]
    U = kolom_bulat(Xs)
    nol = float(Xs[:, kf].min())
    log("rounding columns", len(U))
    Xv = LV.muat_v2(list(range(10)))["X1"]
    gain = b["stacker"].booster_.feature_importance("gain").astype(float)
    bobot = {k: r(v / gain.sum()) for k, v in zip(b["urutan"], gain)}
    bulat = {k: split_bulat(b["komponen"][k]["model"], b["komponen"][k]["kolom"], U, [Xs, Xv]) for k in LAYER}
    log("splits", {k: (v["split"], v["bising"]) for k, v in bulat.items()})
    del Xs, Xv
    res = {}
    for nama, folder, gen2 in (("gen2", G2, True), ("uji_b", UJI_B, False)):
        D = muat(folder, gen2, b, U, kf)
        nol = min(nol, float(D["kf"].min()))
        res[nama] = nilai_data(D, b, nol, fam_skema)
        del D
    # sanity: the same rows and decisions as generator2.json
    cek = {"gen2": [res["gen2"]["raw"]["keputusan"]["recall"], g2["ringkas"]["model_v3"]["recall"]],
           "gen2_tanpa_skew": [res["gen2"]["snap"]["keputusan"]["recall"], g2["penyebab"]["skew"]["gen2"]["tanpa_skew"]["recall"]],
           "uji_b": [res["uji_b"]["raw"]["keputusan"]["recall"], g2["uji_b"]["recall"]],
           "uji_b_tanpa_skew": [res["uji_b"]["snap"]["keputusan"]["recall"], g2["penyebab"]["skew"]["uji_b"]["tanpa_skew"]["recall"]],
           "split_model1": [bulat["model1"]["bising"], g2["penyebab"]["skew"]["split"]]}  # laporan_gen2.py uses the strict test since 2026-11-12
    log("cek", cek)
    beda = {k: v for k, v in cek.items() if abs(v[0] - v[1]) > 0.002 * (1 if k != "split_model1" else 1000)}
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "model": MODEL, "ambang_peluang": b["ambang_peluang"], "bobot_fusi": bobot,
           "split_bulat": bulat, "kolom_bulat": len(U), "data": res, "cek": cek, "cek_beda": beda, "detik": round(time.time() - T0)}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    if SISTEM.exists():  # served without re-running laporan_ml.py (which also reads this file)
        s = json.loads(SISTEM.read_text("utf-8"))
        s["generator2_node"] = out
        SISTEM.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    log("written", OUT, "mismatch" if beda else "matches generator2.json", beda or "")


if __name__ == "__main__":
    main()
