"""The evidence chapters of the branch report (the user's reviewer, 2026-11-13): confusion matrices, the swarm's contribution
against LightGBM alone and LightGBM + rules (and a fair test: the model choosing the same number of uncertain claims), the
money (bill values of fraud found, fraud missed, normal claims queued), the reason for every TAHAN/PERIKSA claim (indicators,
SHAP contributions of the model, confidence, a recommendation for the verifier), and an error analysis per theme and scheme.
Used by testing/laporan_cabang.py. Synthetic data only: the labels are the planted schemes."""
from __future__ import annotations

import re

import numpy as np

PREV = 0.02
REKOMENDASI = {
    "koding": "Minta resume medis, hasil penunjang dan lembar koding; cocokkan diagnosis sekunder, keparahan dan prosedur dengan catatan klinis.",
    "tagihan": "Minta rincian tagihan dan bukti pemakaian obat/alkes/top-up (CMG khusus); bandingkan dengan tarif INA-CBG dan klaim sejenis.",
    "episode": "Periksa riwayat episode peserta (tanggal pulang-masuk, surat kontrol/rujukan); pastikan bukan pemecahan episode atau readmisi terencana.",
    "identitas": "Verifikasi identitas peserta saat layanan (SEP, foto/sidik jari) dan klaim di RS lain pada hari yang sama.",
    "jaringan": "Telusuri pola rujukan dan peserta bersama antar-RS; eskalasi ke tim investigasi kedeputian bila berulang.",
    "normal": "Telaah dokumen standar; tidak ada indikator kuat, klaim masuk antrean karena skor/rule.",
}
# a model feature's family, for a TAHAN claim's recommendation (the swarm did not read it)
POLA_FAMILI = [("jaringan", r"jaringan|CINCIN|KONSENTRASI|tetangga RS"), ("identitas", r"KARTU|hari_sama|IDENTITAS|TIDAK_SESUAI_PESERTA|MENINGGAL"),
               ("episode", r"readmisi|READMISI|ganda|GANDA|klon|KLON|EPISODE|BERULANG|hari_sejak|kembar"),
               ("tagihan", r"topup|TOPUP|tarif|tagih|biaya|TAGIHAN|OBAT"), ("koding", r"dx|DX|keparahan|KEPARAHAN|los|LOS|prosedur|PROSEDUR|KODE|kelas")]


NAMA_KHUSUS = {"skor_aturan": "skor gabungan rule engine", "skor_tanpa_mitigasi": "skor rule sebelum mitigasi", "ml_log_risiko": "skor ML platform",
               "ml_kelipatan": "kelipatan risiko ML platform", "log_biaya": "besar tagihan", "mitigasi_n": "jumlah mitigasi rule",
               "klaim: hari_sejak_sebelumnya": "hari sejak klaim sebelumnya", "klaim: biaya_tagih": "biaya ditagih", "klaim: kunjungan_peserta_faskes": "kunjungan peserta ke RS ini"}


def nama_fitur(n: str, x4_label: dict) -> str:
    if n in NAMA_KHUSUS:
        return NAMA_KHUSUS[n]
    if n.startswith("v4: "):
        return x4_label.get(n, n[4:].replace("_", " "))
    n = n.replace("klaim: ", "").replace("s:", "rule ")
    n = re.sub(r"^tetangga (.+?): ", r"rata-rata klaim tetangga (\1) · ", n)
    return n.replace("_", " ")


def famili_fitur(nama_asli: list[str]) -> str:
    for fam, pola in POLA_FAMILI:
        if any(re.search(pola, n) for n in nama_asli):
            return fam
    return "normal"


def shap_top(models: list, X: np.ndarray, names: list[str], x4_label: dict, k: int = 5) -> list[list[dict]]:
    """The model's top positive contributions (log-odds, mean of the 3 LightGBM seeds) per row."""
    if not len(X):
        return []
    c = np.mean([m.predict(X, pred_contrib=True) if hasattr(m, "booster_") is False else m.booster_.predict(X, pred_contrib=True) for m in models], axis=0)[:, :-1]
    out = []
    for row in c:
        top = np.argsort(row)[::-1][:k]
        out.append([{"fitur": nama_fitur(names[j], x4_label), "asli": names[j], "kontribusi": round(float(row[j]), 3)} for j in top if row[j] > 0])
    return out


def ukur(y: np.ndarray, f: np.ndarray, biaya: np.ndarray) -> dict:
    y = y.astype(bool); f = f.astype(bool)
    tp, fp, fn, tn = int((f & y).sum()), int((f & ~y).sum()), int((~f & y).sum()), int((~f & ~y).sum())
    r = tp / max(1, tp + fn); fpr = fp / max(1, fp + tn)
    p2 = r * PREV / max(1e-12, r * PREV + fpr * (1 - PREV))
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "recall": round(r, 4), "presisi_mentah": round(tp / max(1, tp + fp), 4), "fpr": round(fpr, 5),
            "presisi_prev2": round(p2, 4), "antrean": tp + fp,
            "rp": {"fraud_ditemukan": int(biaya[f & y].sum()), "fraud_lolos": int(biaya[~f & y].sum()), "normal_di_antrean": int(biaya[f & ~y].sum()),
                   "total_fraud": int(biaya[y].sum())}}


def sistem(z: dict, kep: np.ndarray, rule: np.ndarray, t_periksa: float, idx: np.ndarray) -> dict[str, np.ndarray]:
    """The systems compared on the same claims: LightGBM alone (v4), LightGBM + rules, v5 (+ swarm), and the fair test: in the
    uncertain zone the MODEL picks as many claims as the swarm sent to the queue (same queue size, no swarm)."""
    s, tahan, ragu = z["s"][idx], z["tahan"][idx], z["ragu"][idx]
    k = kep[idx]
    v5 = np.isin(k, ["TAHAN", "PERIKSA"])
    n_periksa = int((k == "PERIKSA").sum())
    model_sama = tahan.copy()
    if n_periksa:
        cand = np.flatnonzero(ragu)
        model_sama[cand[np.argsort(-s[cand])[:n_periksa]]] = True
    v4 = s > t_periksa
    return {"v4": v4, "v4_rule": v4 | rule[idx], "model_antrean_sama": model_sama, "v5": v5}


LABEL_SISTEM = {"v4": "LightGBM saja (v4)", "v4_rule": "LightGBM + rule engine", "model_antrean_sama": "LightGBM + rule, filter model (antrean sama dengan v5)",
                "v5": "LightGBM + rule + AI Agent Swarm (v5)"}


def kinerja(z: dict, kep: np.ndarray, rule: np.ndarray, t_periksa: float, idx: np.ndarray, biaya: np.ndarray, ci: bool = False) -> dict:
    y = z["y"][idx]
    S = sistem(z, kep, rule, t_periksa, idx)
    out = {"sistem": {k: {"label": LABEL_SISTEM[k], **ukur(y, f, biaya)} for k, f in S.items()}}
    ragu = z["ragu"][idx]
    if ragu.any() and 0 < y[ragu].sum() < ragu.sum():
        from sklearn.metrics import roc_auc_score

        out["zona_ragu"] = {"klaim": int(ragu.sum()), "fraud": int(y[ragu].sum()), "auroc_model": round(float(roc_auc_score(y[ragu], z["s"][idx][ragu])), 3)}
    if ci:
        import v4_rule_tambah as RT

        g = z["grup"][idx]
        out["ci_selisih_v5"] = {k: RT.boot_selisih(y, S[k], S["v5"], g, B=500) for k in ("v4", "v4_rule", "model_antrean_sama")}
    return out


def kesalahan(z: dict, kep: np.ndarray, idx: np.ndarray, tema: np.ndarray, nama_tema: dict, biaya: np.ndarray) -> dict:
    """Where the fraud is lost, per theme and per planted scheme: never uncertain (the model and the rules saw nothing), or
    uncertain but cleared by the swarm; and the normal claims that entered the queue."""
    y = z["y"][idx].astype(bool)
    k = kep[idx]
    q = np.isin(k, ["TAHAN", "PERIKSA"])
    sk = np.array([s[4:] if s.startswith("aug:") else s for s in z["sk"][idx]])
    per_tema = []
    for t in sorted(set(tema[y])):
        m = (tema == t)
        f = m & y
        per_tema.append({"kode": t, "nama": nama_tema.get(t, t), "fraud": int(f.sum()), "tertangkap": int((f & q).sum()),
                         "tidak_masuk_ragu": int((f & (k == "LOLOS")).sum()), "dibersihkan_swarm": int((f & (k == "DIBERSIHKAN")).sum()),
                         "normal_di_antrean": int((m & ~y & q).sum()), "rp_lolos": int(biaya[f & ~q].sum()),
                         "skema_lolos": [{"skema": s, "n": int(n)} for s, n in zip(*np.unique(sk[f & ~q], return_counts=True))] if (f & ~q).any() else []})
    per_tema.sort(key=lambda r: -(r["fraud"] - r["tertangkap"]))
    for r in per_tema:
        r["skema_lolos"].sort(key=lambda x: -x["n"])
    per_skema = []
    for s in sorted(set(sk[y])):
        f = y & (sk == s)
        per_skema.append({"skema": s, "fraud": int(f.sum()), "tertangkap": int((f & q).sum()), "tidak_masuk_ragu": int((f & (k == "LOLOS")).sum()),
                          "dibersihkan_swarm": int((f & (k == "DIBERSIHKAN")).sum())})
    per_skema.sort(key=lambda r: -(r["fraud"] - r["tertangkap"]))
    return {"tema": per_tema, "skema": per_skema}


def keputusan_ai(kep: str, s: float, q: float, p: float | None, f: float | None, tau: float, famili_hakim: str | None, rule: list[str],
                 shap: list[dict], agen: dict | None) -> dict:
    """The decision's explanation for the verifier: indicators, reason, confidence (not a calibrated probability), recommendation."""
    if kep == "TAHAN":
        fam = famili_fitur([x["asli"] for x in shap[:3]] + [f"s:{r}" for r in rule])
        tingkat = "Tinggi"
        yakin = f"Skor model lebih tinggi dari {q * 100:.1f}% klaim normal validasi (ambang TAHAN = FPR 0,1%).".replace(".", ",", 1)
        alasan = "Skor model sangat tinggi; dipicu terutama oleh " + ", ".join(x["fitur"] for x in shap[:3]) + "." if shap else "Skor model sangat tinggi."
    else:
        fam = (famili_hakim or "normal").lower()
        if fam not in REKOMENDASI:
            fam = "normal"
        nilai = f if f is not None else 0.0
        tingkat = "Tinggi" if nilai >= tau + 0.12 else "Sedang" if nilai >= tau + 0.05 else "Rendah" if kep == "PERIKSA" else "Di bawah ambang"
        yakin = (f"Gabungan skor swarm dan model {nilai:.2f} (ambang {tau:.2f}); skor risiko hakim {p:.2f}".replace(".", ",") + "."
                 if p is not None else "")
        alasan = (agen or {}).get("hakim", {}).get("alasan") or ""
    indikator = [f"rule {r.replace('_', ' ').lower()}" for r in rule] + [x["fitur"] for x in shap[:3]]
    return {"famili": fam, "indikator": indikator[:6], "alasan": alasan, "keyakinan": tingkat, "keyakinan_teks": yakin,
            "rekomendasi": REKOMENDASI[fam], "shap": shap}
