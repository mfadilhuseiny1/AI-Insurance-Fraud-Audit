"""ML Studio · "Metrik AI Agent Swarm cabang" (the user, 2026-11-15: "saya penasaran precision sama recall hasil audit AI Agent
Swarm Branch ... precision & recall sistem (rule engine + ml7) [dan] keseluruhan (rule engine + ml7 + AIoT verification + AI
Agent Swarm)", then "bikin reportnya di ML studio bikin tab baru metrik2 nya kayak di Laporan v7 metrik juri ... bandingkan apakah
multi agent swarm bisa nurunin false positive?").

What this does: reads one finished branch run (testing/jalan_kc_tema.py -> .tmp/kc_tema/<set>, the same loader the branch report
uses: laporan_cabang.muat), takes the audit's claims (one KC, the selected themes) and scores every system on the SAME claims and
the SAME planted labels (kunci/label_fraud.parquet; the IoT world's own key for the device checks):

  ml_v7         ML v7 alone at its frozen "periksa" threshold
  ml_rule       ML v7 + rule engine (= v5's v4_plus_rule: score above "periksa" OR a review rule) -- the system WITHOUT the swarm
  ml_rule_rme   ... + the medical-record rules flagging on their own (rme_tingkat PERIKSA/TAHAN, the engine's thresholds)
  ml_rule_iot   ... + an IoT mismatch flagging on its own
  zona          every claim the screening flags before the swarm (TAHAN + all RAGU), i.e. what verifiers face with no swarm
  tahan         TAHAN only (the model's high-confidence zone; the swarm never reads it)
  model_sama    fair test: TAHAN + the model's own top-n RAGU claims, n = what the swarm sent to the queue (same queue size)
  swarm         the whole system: ML v7 + rule engine + medical record + IoT + AI Agent Swarm (TAHAN + PERIKSA)

Confusion matrix, F1 score, MCC ... with 95% CIs from resampling HOSPITALS (claims of one hospital move together; the jury deck's
rule, the same Boot class as testing/ml_v7_metrik_juri.py), paired differences swarm vs each baseline (FP, TP, precision, recall),
the swarm's own ranking inside the uncertain zone (AUROC of the gate score vs the model score), where the remaining false
positives come from, the fraud the swarm cleared by scheme, per replica, and the IoT checks against the IoT key.

No model is trained, no threshold moves, no model is called. Aggregates only (no claim rows) go to
data/aip/ml/sistem_terbaru/swarm_cabang_metrik.json (one entry per run, merged), read by /api/swarm-cabang-metrik.

  .venv\\Scripts\\python.exe testing\\swarm_cabang_metrik.py --set jantung_iot_5r --kc sul-7371 --tema I
Synthetic data only."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
os.environ.setdefault("UJI_SET_ROOT", str(ROOT / ".tmp" / "kc_tema"))
os.environ.setdefault("BLUESANDAI_AUTH", "off")
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))

OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "swarm_cabang_metrik.json"
KEP_ANTRE = ("TAHAN", "PERIKSA")
NAMA = {
    "ml_v7": "ML v7 saja", "ml_rule": "ML v7 + rule engine", "ml_rule_rme": "ML v7 + rule engine + rule rekam medis",
    "ml_rule_iot": "ML v7 + rule engine + rekam medis + IoT", "zona": "Semua zona curiga sebelum swarm (TAHAN + RAGU)",
    "tahan": "Zona TAHAN saja", "model_sama": "Model memilih, antrean sama dengan swarm", "swarm": "Keseluruhan: + AI Agent Swarm",
}
KET = {
    "ml_v7": "Klaim ditandai bila skor ML v7 di atas ambang periksa yang dibekukan.",
    "ml_rule": "Klaim ditandai bila skor ML v7 di atas ambang periksa ATAU kena rule engine. Ini sistem tanpa swarm.",
    "ml_rule_rme": "Seperti di atas, ditambah rule rekam medis (SATUSEHAT) yang langsung menandai klaim sendiri.",
    "ml_rule_iot": "Seperti di atas, ditambah ketidaksesuaian pemakaian alat (IoT) yang langsung menandai klaim sendiri.",
    "zona": "Semua klaim yang diloloskan penyaringan ke TAHAN atau RAGU; tanpa swarm, semuanya harus dibaca verifikator.",
    "tahan": "Hanya klaim berskor sangat tinggi (TAHAN). Swarm tidak membaca zona ini.",
    "model_sama": "Uji adil: dari zona RAGU, model sendiri memilih klaim berskor tertinggi sebanyak yang dikirim swarm ke antrean.",
    "swarm": "ML v7 + rule engine + rekam medis + IoT + AI Agent Swarm: TAHAN ditambah klaim RAGU yang lolos gerbang swarm.",
}


def say(*a) -> None:
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def main(nama: str, kc: str, tema_pilih: str) -> None:
    import laporan_cabang as LC
    import ml_v7_metrik_juri as J
    from sklearn.metrics import roc_auc_score

    say("memuat run", nama)
    M = LC.muat(nama)
    F, z, kep = M["F"], M["z"], M["kep"]
    P = LC.bagi_kc(M["rs"])
    kc_of = np.array([P["kab_kc"][M["rs"][fk]["kab"]] for fk in F["faskes"]])
    tema_set = sorted({t.strip().upper() for t in tema_pilih.split(",") if t.strip()})
    tema = np.array([LC.tema_klaim(d, kd) for d, kd in zip(F["dx"], F["kode"])])
    idx = np.flatnonzero((kc_of == kc) & (np.isin(tema, tema_set) if tema_set else True))
    if not len(idx):
        raise SystemExit(f"tidak ada klaim untuk KC {kc} tema {tema_set}")
    y = z["y"][idx].astype(bool)
    k = kep[idx]
    s = z["s"][idx]
    kunci = z["kunci"][idx].astype(str)
    biaya = F["biaya"][idx].astype(np.int64)
    faskes = F["faskes"][idx]
    replika = F["replika"][idx] if "replika" in F else np.zeros(len(idx), int)
    tahan, ragu = z["tahan"][idx], z["ragu"][idx]
    t_periksa = float(M["K"]["ambang"]["periksa_v4"])
    rule = M["rule_mask"][idx]

    SET = Path(os.environ["UJI_SET_ROOT"]) / nama
    raw = [dict(np.load(f, allow_pickle=False)) for f in sorted(SET.glob("hasil_[0-9][0-9].npz"))]
    cp = np.array([[int(x) for x in kk.split(":")[1:]] for kk in kunci])
    rme_flag = np.array([str(raw[c]["rme_tingkat"][i]) in KEP_ANTRE for c, i in cp])
    iot = M.get("iot") or {}
    iot_mis = np.array([(iot.get(kk) or {}).get("hasil") == "tidak_sesuai" for kk in kunci])

    v5 = np.isin(k, KEP_ANTRE)
    n_periksa = int((k == "PERIKSA").sum())
    model_sama = tahan.copy()
    cand = np.flatnonzero(ragu)
    model_sama[cand[np.argsort(-s[cand], kind="stable")[:n_periksa]]] = True
    ml = s > t_periksa
    S = {"ml_v7": ml, "ml_rule": ml | rule, "ml_rule_rme": ml | rule | rme_flag, "ml_rule_iot": ml | rule | rme_flag | iot_mis,
         "zona": tahan | ragu, "tahan": tahan, "model_sama": model_sama, "swarm": v5}

    rs_jujur = set(faskes) - set(faskes[y])  # hospitals with no planted fraud in the audit (the jury's "honest hospitals audited")
    bt = J.Boot(faskes, seed=0)
    say(f"{len(idx)} klaim, {int(y.sum())} fraud, {bt.nh} RS, bootstrap {J.B}x per RS")
    sistem, boots = {}, {}
    for key, f in S.items():
        c, bs = J.cm_blok(y, f, bt)
        boots[key] = {"tp": bt.tot(y & f), "fp": bt.tot(~y & f), "bs": bs}
        sistem[key] = {"nama": NAMA[key], "ket": KET[key], **c,
                       "rp": {"fraud_ditemukan": int(biaya[f & y].sum()), "fraud_lolos": int(biaya[~f & y].sum()),
                              "jujur_diperiksa": int(biaya[f & ~y].sum()), "total_fraud": int(biaya[y].sum())},
                       "rs_jujur_diperiksa": int(len(set(faskes[f]) & rs_jujur)), "rs_terbebani": int(len(set(faskes[f & ~y])))}

    def beda(a: str, b: str = "swarm") -> dict:
        """Paired bootstrap difference b - a (hospitals resampled together for both systems)."""
        out = {}
        for m_ in ("fp", "tp"):
            d = boots[b][m_] - boots[a][m_]
            out[m_] = {"selisih": int(sistem[b][m_] - sistem[a][m_]), "ci": J.q95(d), "p": J.p_dua(d)}
        for m_ in ("presisi", "recall", "f1", "fpr"):
            d = boots[b]["bs"][m_] - boots[a]["bs"][m_]
            out[m_] = {"selisih": J.r4(sistem[b][m_] - sistem[a][m_]), "ci": J.q95(d), "p": J.p_dua(d)}
        out["fp_turun_persen"] = J.r4(1 - sistem[b]["fp"] / max(1, sistem[a]["fp"]))
        return out

    banding = {a: beda(a) for a in ("ml_v7", "ml_rule", "ml_rule_rme", "ml_rule_iot", "zona", "model_sama")}

    # ---- inside the uncertain zone: what the swarm did, and who ranks fraud higher (the model's score or the swarm's gate)
    yr = y[ragu]
    kr = k[ragu]
    f_gate = np.asarray(M["f"])[idx][ragu]
    p_hakim = np.nan_to_num(np.asarray(M["p"])[idx][ragu], nan=0.0)
    s_r = s[ragu]
    bt_r = J.Boot(faskes[ragu], seed=1)

    def auc_boot(score: np.ndarray) -> tuple[float, np.ndarray]:
        a = roc_auc_score(yr, score)
        vals = np.full(J.B, np.nan)
        for b in range(J.B):
            w = bt_r.w(b)
            if (w * yr).sum() > 0 and (w * ~yr).sum() > 0:
                vals[b] = roc_auc_score(yr, score, sample_weight=w)
        return float(a), vals

    a_mod, b_mod = auc_boot(s_r)
    a_gate, b_gate = auc_boot(f_gate)
    a_hak, b_hak = auc_boot(p_hakim)
    ragu_blok = {
        "klaim": int(ragu.sum()), "fraud": int(yr.sum()), "jujur": int((~yr).sum()), "dibaca": int(np.isin(kr, ["PERIKSA", "DIBERSIHKAN"]).sum()),
        "periksa_fraud": int(((kr == "PERIKSA") & yr).sum()), "periksa_jujur": int(((kr == "PERIKSA") & ~yr).sum()),
        "bersih_fraud": int(((kr == "DIBERSIHKAN") & yr).sum()), "bersih_jujur": int(((kr == "DIBERSIHKAN") & ~yr).sum()),
        "belum_dibaca": int((kr == "BELUM_DIBACA").sum()),
        "auroc": {"model": {"nilai": J.r4(a_mod), "ci": J.q95(b_mod)}, "gerbang": {"nilai": J.r4(a_gate), "ci": J.q95(b_gate)},
                  "hakim": {"nilai": J.r4(a_hak), "ci": J.q95(b_hak)},
                  "selisih_gerbang_model": {"selisih": J.r4(a_gate - a_mod), "ci": J.q95(b_gate - b_mod), "p": J.p_dua(b_gate - b_mod)}},
        "tau": float(M["K"]["tau"]),
    }

    # ---- trade-off curves on the same claims: x = honest claims queued (FP), y = fraud caught (recall)
    def jalur(order: np.ndarray, basis: np.ndarray | None = None, n_titik: int = 160) -> list[list[float]]:
        tp0 = int((basis & y).sum()) if basis is not None else 0
        fp0 = int((basis & ~y).sum()) if basis is not None else 0
        ctp = tp0 + np.concatenate([[0], np.cumsum(y[order])])
        cfp = fp0 + np.concatenate([[0], np.cumsum(~y[order])])
        pick = np.unique(np.linspace(0, len(order), min(n_titik, len(order) + 1)).round().astype(int))
        return [[int(cfp[i]), J.r4(ctp[i] / max(1, y.sum()))] for i in pick]

    order_all = np.argsort(-s, kind="stable")
    lim = int(np.searchsorted(np.cumsum(~y[order_all]), max(sistem["zona"]["fp"], sistem["ml_rule_iot"]["fp"]) * 1.15))
    kurva = {"model_dari_ragu": jalur(cand[np.argsort(-s[cand], kind="stable")], basis=tahan),
             "ml_v7_global": jalur(order_all[:lim])}

    # ---- where the remaining false positives come from, and where the fraud is lost
    g = M.get("gerbang") or {}
    jalur_k = np.array([(g.get(kk) or {}).get("jalur") or "ml" for kk in kunci])
    # routed to the swarm by a rule finding although ML v7 put the claim in LOLOS (muat keeps the model's own RAGU as ragu_ml)
    asal_lolos = ragu & ~z["ragu_ml"][idx] if "ragu_ml" in z else np.zeros(len(idx), bool)
    fp_sumber = {"tahan": int((tahan & ~y).sum()), "periksa_ml": int(((k == "PERIKSA") & (jalur_k != "bukti_aturan") & ~y).sum()),
                 "periksa_aturan": int(((k == "PERIKSA") & (jalur_k == "bukti_aturan") & ~y).sum())}
    tp_sumber = {"tahan": int((tahan & y).sum()), "periksa_ml": int(((k == "PERIKSA") & (jalur_k != "bukti_aturan") & y).sum()),
                 "periksa_aturan": int(((k == "PERIKSA") & (jalur_k == "bukti_aturan") & y).sum())}
    jalur_aturan = {"periksa": int(((k == "PERIKSA") & (jalur_k == "bukti_aturan")).sum()), "fraud": tp_sumber["periksa_aturan"],
                    "jujur": fp_sumber["periksa_aturan"], "dari_lolos_periksa": int(((k == "PERIKSA") & asal_lolos).sum()),
                    "dari_lolos_periksa_fraud": int(((k == "PERIKSA") & asal_lolos & y).sum()),
                    "dari_lolos_dibersihkan": int(((k == "DIBERSIHKAN") & asal_lolos).sum())}
    sk = np.array([x[4:] if x.startswith("aug:") else x for x in z["sk"][idx]])
    hilang = {"tidak_pernah_curiga": int((y & (k == "LOLOS")).sum()), "dibersihkan_swarm": int((y & (k == "DIBERSIHKAN")).sum())}
    skema = []
    for nm in sorted(set(sk[y])):
        m_ = y & (sk == nm)
        skema.append({"skema": nm, "fraud": int(m_.sum()), "tertangkap": int((m_ & v5).sum()), "dibersihkan_swarm": int((m_ & (k == "DIBERSIHKAN")).sum()),
                      "tidak_pernah_curiga": int((m_ & (k == "LOLOS")).sum()), "tertangkap_tanpa_swarm": int((m_ & S["ml_rule"]).sum())})
    skema.sort(key=lambda r: (-(r["fraud"] - r["tertangkap"]), -r["fraud"]))

    # ---- per replica (each replica = one independent synthetic year)
    per_rep = []
    for r in sorted(set(replika.tolist())):
        m_ = replika == r
        row = {"replika": int(r), "klaim": int(m_.sum()), "fraud": int((y & m_).sum())}
        for key in ("ml_rule", "zona", "model_sama", "swarm"):
            f = S[key] & m_
            tp, fp = int((f & y).sum()), int((f & ~y).sum())
            row[key] = {"tp": tp, "fp": fp, "presisi": J.r4(tp / max(1, tp + fp)), "recall": J.r4(tp / max(1, int((y & m_).sum())))}
        per_rep.append(row)

    # ---- IoT: the checker against the IoT world's own key (the main key does not hold the device frauds)
    iot_blok = None
    kb_f = ROOT / "data" / "aip" / "cabang" / "iot" / nama / "kunci_benar.json"
    if iot and kb_f.exists():
        kb = json.loads(kb_f.read_text("utf-8"))["klaim"]
        ks = set(kunci.tolist())
        pos = {kk: i for i, kk in enumerate(kunci)}
        alat = [kk for kk in kb if kk in ks]
        fr = {kk for kk in alat if kb[kk]["fraud"]}
        flag = {kk for kk in alat if (iot.get(kk) or {}).get("hasil") == "tidak_sesuai"}
        tp, fp, fn = len(fr & flag), len(flag - fr), len(fr - flag)
        y_gab = y.copy()
        for kk in fr:
            y_gab[pos[kk]] = True
        c_gab, _ = J.cm_blok(y_gab, v5, bt)
        c_gab0, _ = J.cm_blok(y_gab, S["ml_rule"], bt)
        iot_blok = {"klaim_dengan_alat": len(alat), "fraud_tanam": len(fr), "terdeteksi": tp, "jujur": len(alat) - len(fr), "jujur_ditandai": fp, "terlewat": fn,
                    "tn": len(alat) - len(fr) - fp, "presisi": J.r4(tp / max(1, tp + fp)), "recall": J.r4(tp / max(1, len(fr))),
                    "tidak_sesuai_di_antrean_akhir": int((iot_mis & v5).sum()), "tidak_sesuai_sudah_ditandai_tanpa_iot": int((iot_mis & S["ml_rule_rme"]).sum()),
                    "aturan": dict(Counter((iot.get(kk) or {}).get("aturan") or (iot.get(kk) or {}).get("kode") or "?" for kk in flag)),
                    "label_gabungan": {"fraud": int(y_gab.sum()), "swarm": {kk_: c_gab[kk_] for kk_ in ("tp", "fp", "fn", "presisi", "recall", "f1")},
                                       "ml_rule": {kk_: c_gab0[kk_] for kk_ in ("tp", "fp", "fn", "presisi", "recall", "f1")}}}

    hb = M.get("biaya_swarm") or {}
    entri = {
        "dibuat": time.strftime("%Y-%m-%d %H:%M"), "set": nama, "label": json.loads((SET / "status.json").read_text("utf-8")).get("label", nama),
        "kc": kc, "kc_nama": (P["kc"].get(kc) or {}).get("nama", kc), "tema": tema_set, "replika": sorted({int(x) for x in replika}),
        "klaim": int(len(idx)), "fraud": int(y.sum()), "prevalensi": J.r4(y.mean()), "rs": int(bt.nh), "rs_jujur": len(rs_jujur),
        "bootstrap": J.B, "model": M["model_nama"],
        "ambang": {"periksa": J.r4(t_periksa), "tahan": J.r4(float(M["K"]["ambang"]["tahan"])), "tau": float(M["K"]["tau"])},
        "sistem": sistem, "banding": banding, "ragu": ragu_blok, "kurva": kurva, "fp_sumber": fp_sumber, "tp_sumber": tp_sumber,
        "jalur_aturan": jalur_aturan, "hilang": hilang, "skema": skema, "per_replika": per_rep, "iot": iot_blok,
        "biaya": {"usd": J.r4(float(hb.get("usd_perkiraan") or 0), 3), "panggilan": int(hb.get("panggilan") or 0), "klaim_dibaca": ragu_blok["dibaca"]},
        "catatan": ["Data sintetis: label = skema fraud yang ditanam (kunci/label_fraud.parquet); fraud alat (IoT) punya kunci sendiri.",
                    "Model beku, ambang tidak diubah, tidak ada panggilan model baru; angka dihitung ulang dari hasil run.",
                    "95% CI: rumah sakit diambil ulang dengan pengembalian (klaim satu RS ikut bersama), "
                    f"{J.B}x; selisih swarm vs pembanding dihitung berpasangan pada sampel ulang yang sama."],
    }
    old = json.loads(OUT.read_text("utf-8")) if OUT.exists() else {"runs": {}}
    old.setdefault("runs", {})[nama] = entri
    old["terbaru"] = nama
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(old, ensure_ascii=False, indent=1), "utf-8")
    for key in S:
        x = sistem[key]
        say(f"{key:12s} antrean {x['ditandai']:5d}  TP {x['tp']:4d}  FP {x['fp']:5d}  precision {x['presisi']:.3f}  recall {x['recall']:.3f}  F1 {x['f1']:.3f}")
    say("swarm vs ml_rule:", json.dumps(banding["ml_rule"]["fp"]), "| vs model_sama:", json.dumps(banding["model_sama"]["fp"]), json.dumps(banding["model_sama"]["tp"]))
    say("AUROC di zona ragu:", json.dumps(ragu_blok["auroc"]))
    say("->", OUT)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="jantung_iot_5r")
    ap.add_argument("--kc", default="sul-7371")
    ap.add_argument("--tema", default="I")
    a = ap.parse_args()
    if not os.environ.get("SWARM_V5_KERJA"):
        os.environ["SWARM_V5_KERJA"] = str(Path(os.environ["UJI_SET_ROOT"]) / a.set / "swarm_v5")
    main(a.set, a.kc, a.tema)
