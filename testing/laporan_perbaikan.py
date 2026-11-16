"""Step 4 of the v3 retrain (2026-11-12): the retrained model_v3_bersih (one feature path, training data without the echo) and, for
contrast, model_v3 as served (trained on the old-path features), each scored ONCE on the two fresh sets:
  test C     generator 1, role uji_c, moved claims with their originals taken out of the history (testing/uji100k.py SET=C)
  gen2_baru  generator 2, same fitted parameters, new seed, role gen2_baru (testing/uji_gen2.py with GEN2_BARU=1)
The criteria were written before the results (testing/kriteria_langkah4.json) and are applied as written. The validation members
(data_v2_bersih chunks 8–9) are shown as context only. Aggregates only. Synthetic data only.

Output: data/aip/ml/sistem_terbaru/perbaikan_v3.json (and the key perbaikan_v3 in sistem.json unless PERBAIKAN_TANPA_SISTEM=1).
Usage: .venv/Scripts/python.exe testing/laporan_perbaikan.py"""
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
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import arsitektur_v2 as A  # noqa: E402
import generator2 as G  # noqa: E402
from laporan_gen2 import bootstrap, idn, per_chunk, tingkat, ukur  # noqa: E402

TMP = ROOT / ".tmp"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "perbaikan_v3.json"
SISTEM = OUT.parent / "sistem.json"
KRIT = json.loads((HERE / "kriteria_langkah4.json").read_text("utf-8"))
MODELS = {"model_v3_bersih": "v3 bersih (dilatih ulang)", "model_v3": "v3 lama (fitur jalur lama)"}
CAMPURAN = 0.20  # first-visit share of normal claims in the replay stream


def main() -> None:
    import joblib

    t0 = time.time()
    bundel = {m: joblib.load(HERE / m / "model.joblib") for m in MODELS}
    b3 = bundel["model_v3_bersih"]
    kf = list(b3["sys_names"]).index("klaim: kunjungan_peserta_faskes")
    st = np.load(TMP / "v2_stream_satu_jalur.npz", allow_pickle=True)
    nol = float(st["X1"][:, kf].min())

    # ---- the sets: labels, scheme, chunk, first visit, and every model's scores
    def dari_hasil(pola: str, kunci_sk: str = "sk") -> dict:
        fs = sorted(TMP.glob(pola))
        ds = [np.load(f) for f in fs]
        d = {"sk": np.concatenate([x[kunci_sk] for x in ds]).astype(str), "chunk": np.concatenate([np.full(len(x[kunci_sk]), i) for i, x in enumerate(ds)]),
             "pv": np.concatenate([x["X1"][:, kf] <= nol + 1e-5 for x in ds]), "n_chunk": len(fs),
             "peserta": np.concatenate([np.char.add(f"{i}:", x["peserta"].astype(str)) for i, x in enumerate(ds)]),
             "rule": np.concatenate([(x["tahan"] | x["periksa"]) if "tahan" in x.files else np.isin(x["keputusan"].astype(str), ["PERIKSA", "TAHAN"]) for x in ds]).astype(bool)}
        d["skor"] = {}
        for m, b in bundel.items():
            parts = [A.skor(b, x["X1"], x["X2"], x["XR"]) for x in ds]
            d["skor"][m] = {k: np.concatenate([p[k] for p in parts]) for k in ("flag", "ps", "cal")}
        return d

    S = {"uji_c": dari_hasil("uji100k_c/hasil_[0-9][0-9].npz"), "gen2_baru": dari_hasil("gen2_baru/hasil_[0-9][0-9].npz"),
         "validasi": dari_hasil("data_v2_bersih/fitur_0[89].npz")}
    ongeldig = dari_hasil("uji100k_c_ongeldig/hasil_[0-9][0-9].npz") if list(TMP.glob("uji100k_c_ongeldig/hasil_[0-9][0-9].npz")) else None
    for d in [*S.values(), *([ongeldig] if ongeldig else [])]:
        d["y"] = ~np.isin(d["sk"], A.NORMAL)
        u, inv, cnt = np.unique(d["peserta"], return_inverse=True, return_counts=True)
        d["k"] = cnt[inv]  # the member's number of claims in this chunk's window

    KEL = [("1 klaim", 1, 1), ("2 klaim", 2, 2), ("3–4 klaim", 3, 4), ("5+ klaim", 5, 10 ** 6)]

    def per_jumlah(d: dict) -> list[dict]:
        out = []
        for nama, lo, hi in KEL:
            m_ = (d["k"] >= lo) & (d["k"] <= hi)
            row = {"kelompok": nama, "normal": int((m_ & ~d["y"]).sum()), "fraud": int((m_ & d["y"]).sum())}
            for m in MODELS:
                f = d["skor"][m]["flag"].astype(bool)
                row[f"fpr_{m}"] = round(float(f[m_ & ~d["y"]].mean()), 5) if (m_ & ~d["y"]).any() else None
                row[f"recall_{m}"] = round(float(f[m_ & d["y"]].mean()), 4) if (m_ & d["y"]).any() else None
            out.append(row)
        return out

    def ringkas(d: dict, m: str) -> dict:
        y, s = d["y"], d["skor"][m]
        f = s["flag"].astype(bool)
        r = ukur(y, f, s["ps"], s["cal"])
        pv = d["pv"]
        r["fpr_kunjungan_pertama"] = round(float(f[~y & pv].mean()), 5)
        r["fpr_pasien_lama"] = round(float(f[~y & ~pv].mean()), 5)
        r["rasio_kunjungan_pertama"] = round(r["fpr_kunjungan_pertama"] / max(1e-9, r["fpr_pasien_lama"]), 2)
        r["recall_kunjungan_pertama"] = round(float(f[y & pv].mean()), 4) if (y & pv).any() else None
        r["recall_pasien_lama"] = round(float(f[y & ~pv].mean()), 4) if (y & ~pv).any() else None
        r["fpr_campuran20"] = round(CAMPURAN * r["fpr_kunjungan_pertama"] + (1 - CAMPURAN) * r["fpr_pasien_lama"], 5)
        r["porsi_kunjungan_pertama_normal"] = round(float(pv[~y].mean()), 4)
        r["porsi_kunjungan_pertama_fraud"] = round(float(pv[y].mean()), 4)
        return r

    hasil = {s: {m: ringkas(d, m) for m in MODELS} for s, d in S.items()}
    rule = {s: ukur(d["y"], d["rule"], d["rule"].astype(float)) for s, d in S.items()}
    ci = {s: bootstrap(d["y"], d["skor"]["model_v3_bersih"]["flag"], d["skor"]["model_v3_bersih"]["ps"], d["chunk"]) for s, d in S.items() if s != "validasi"}
    chunks = {s: per_chunk(d["y"], d["skor"]["model_v3_bersih"]["flag"], d["chunk"]) for s, d in S.items() if s != "validasi"}

    # ---- per scheme, both sets, both models
    skema = []
    for sk in sorted(set(S["uji_c"]["sk"]) | set(S["gen2_baru"]["sk"])):
        if sk in A.NORMAL:
            continue
        row = {"skema": sk, "label": (G.SKEMA.get(sk) or (sk,))[0], "famili": (G.SKEMA.get(sk) or (None, None, A.famili_dari(sk)))[2]}
        for s in ("uji_c", "gen2_baru", "validasi"):
            m_ = S[s]["sk"] == sk
            row[f"n_{s}"] = int(m_.sum())
            for m in MODELS:
                row[f"recall_{s}_{m}"] = round(float(S[s]["skor"][m]["flag"][m_].mean()), 4) if m_.any() else None
        skema.append(row)
    bersama = [r["skema"] for r in skema if r["n_uji_c"] and r["n_gen2_baru"]]

    def recall_bersama(s: str, m: str) -> float:
        msk = np.isin(S[s]["sk"], bersama)
        return round(float(S[s]["skor"][m]["flag"][msk].mean()), 4)

    # ---- the criteria, as written before the results
    K = KRIT["kriteria"]
    rb = "model_v3_bersih"
    c_, g_ = hasil["uji_c"][rb], hasil["gen2_baru"][rb]
    pc = c_["prevalensi"]
    prec = lambda r, p: r["recall"] * p / max(1e-12, r["recall"] * p + r["fpr_campuran20"] * (1 - p))  # noqa: E731
    nilai = {
        "K1_jalan_pintas": max(c_["rasio_kunjungan_pertama"], g_["rasio_kunjungan_pertama"]),
        "K2_recall_antar_generator": abs(c_["recall"] - g_["recall"]) * 100,
        "K3_fpr_antar_generator": max(c_["fpr_campuran20"], g_["fpr_campuran20"]) / max(1e-9, min(c_["fpr_campuran20"], g_["fpr_campuran20"])),
        "K4_presisi_antar_generator": abs(prec(c_, pc) - prec(g_, pc)) * 100,
        "K5_recall_skema_bersama": abs(recall_bersama("uji_c", rb) - recall_bersama("gen2_baru", rb)) * 100,
    }
    detail = {"K1_jalan_pintas": {"uji_c": c_["rasio_kunjungan_pertama"], "gen2_baru": g_["rasio_kunjungan_pertama"]},
              "K2_recall_antar_generator": {"uji_c": c_["recall"], "gen2_baru": g_["recall"]},
              "K3_fpr_antar_generator": {"uji_c": c_["fpr_campuran20"], "gen2_baru": g_["fpr_campuran20"]},
              "K4_presisi_antar_generator": {"uji_c": round(prec(c_, pc), 4), "gen2_baru": round(prec(g_, pc), 4), "prevalensi": pc},
              "K5_recall_skema_bersama": {"uji_c": recall_bersama("uji_c", rb), "gen2_baru": recall_bersama("gen2_baru", rb), "skema": bersama}}
    kriteria = [{"kunci": k, "ukuran": K[k]["ukuran"], "nilai": round(v, 3), "batas": [K[k]["konsisten_sampai"], K[k]["sebagian_sampai"]],
                 "hasil": tingkat(v, (K[k]["konsisten_sampai"], K[k]["sebagian_sampai"])), "detail": detail[k]} for k, v in nilai.items()]
    urut = ["konsisten", "sebagian", "tidak konsisten"]
    vonis = {"jalan_pintas": kriteria[0]["hasil"], "antar_generator": max((k["hasil"] for k in kriteria[1:]), key=urut.index)}

    # ---- the old model for contrast, and what was published before
    g2 = json.loads((OUT.parent / "generator2.json").read_text("utf-8"))
    sebelum = {"uji_b_dipublikasikan": {k: g2["uji_b"][k] for k in ("recall", "precision", "fpr", "auprc")},
               "uji_b_tanpa_skew": g2["penyebab"]["skew"]["uji_b"]["tanpa_skew"],
               "gen2_run1_v3_lama": {k: g2["ringkas"]["model_v3"][k] for k in ("recall", "precision", "fpr", "auprc")}}

    # ---- findings, computed
    tv, tc = hasil["validasi"][rb], hasil
    lemah = sorted([r for r in skema if (r["n_uji_c"] or r["n_gen2_baru"])], key=lambda r: min(x for x in (r.get(f"recall_uji_c_{rb}"), r.get(f"recall_gen2_baru_{rb}")) if x is not None))
    temuan = [
        {"ikon": "search", "nada": "baik" if c_["recall"] >= 0.8 else "buruk", "judul": f"Uji C: recall {idn(c_['recall'] * 100, 1)}%, precision {idn(c_['precision'] * 100, 1)}%",
         "isi": f"FPR {idn(c_['fpr'] * 100, 2)}% (95%: {idn(ci['uji_c']['fpr'][0] * 100, 2)}–{idn(ci['uji_c']['fpr'][1] * 100, 2)}%); fraud {idn(pc * 100, 1)}% dari {idn(c_['tp'] + c_['fn'] + c_['fp'] + c_['tn'])} klaim."},
        {"ikon": "sparkle", "nada": "baik" if g_["recall"] >= 0.8 else "buruk", "judul": f"Generator 2 baru: recall {idn(g_['recall'] * 100, 1)}%, precision {idn(g_['precision'] * 100, 1)}%",
         "isi": f"FPR {idn(g_['fpr'] * 100, 2)}%; v3 lama di set yang sama: recall {idn(tc['gen2_baru']['model_v3']['recall'] * 100, 1)}%, FPR {idn(tc['gen2_baru']['model_v3']['fpr'] * 100, 1)}%."},
        {"ikon": "eye", "nada": "baik" if kriteria[0]["hasil"] == "konsisten" else "buruk",
         "judul": f"Jalan pintas kunjungan pertama: rasio FPR {idn(c_['rasio_kunjungan_pertama'], 1)}× (uji C), {idn(g_['rasio_kunjungan_pertama'], 1)}× (generator 2)",
         "isi": f"Pasien baru vs pasien lama: uji C {idn(c_['fpr_kunjungan_pertama'] * 100, 2)}% vs {idn(c_['fpr_pasien_lama'] * 100, 2)}%, "
                f"generator 2 {idn(g_['fpr_kunjungan_pertama'] * 100, 2)}% vs {idn(g_['fpr_pasien_lama'] * 100, 2)}%."},
        {"ikon": "layers", "nada": "baik" if vonis["antar_generator"] == "konsisten" else "buruk", "judul": f"Antar generator: {vonis['antar_generator']}",
         "isi": "; ".join(f"{k['kunci'].split('_', 1)[1].replace('_', ' ')} {k['hasil']}" for k in kriteria[1:])},
        {"ikon": "alert", "nada": "buruk", "judul": f"Paling lemah: {', '.join(r['label'].split(' (')[0] for r in lemah[:3])}",
         "isi": "; ".join(f"{r['label'].split(' (')[0]} uji C {'—' if r.get(f'recall_uji_c_{rb}') is None else idn(r[f'recall_uji_c_{rb}'] * 100) + '%'}, "
                          f"gen 2 {'—' if r.get(f'recall_gen2_baru_{rb}') is None else idn(r[f'recall_gen2_baru_{rb}'] * 100) + '%'}" for r in lemah[:3])},
        {"ikon": "info", "nada": "netral", "judul": f"Validasi (konteks): recall {idn(tv['recall'] * 100, 1)}%, FPR {idn(tv['fpr'] * 100, 2)}%",
         "isi": "Peserta validasi data latih bersih; satu-satunya tempat pilihan desain boleh dibuat."},
    ]
    # the retrained model's own checks and card (testing/perbaikan_v3.py, step 3), copied as they are
    mb = HERE / "model_v3_bersih"
    cek = json.loads((mb / "cek_satu_jalur.json").read_text("utf-8")) if (mb / "cek_satu_jalur.json").exists() else None
    kartu = json.loads((mb / "kartu.json").read_text("utf-8")) if (mb / "kartu.json").exists() else {}
    model_bersih = {"cek_satu_jalur": cek, "kartu": {k: kartu.get(k) for k in ("validasi", "oof", "klaim_latih", "fraud_latih", "per_sumber", "dilatih")},
                    "validasi_kunjungan_pertama": {k: hasil["validasi"][rb][k] for k in ("fpr_kunjungan_pertama", "fpr_pasien_lama", "rasio_kunjungan_pertama",
                                                                                     "recall_kunjungan_pertama", "recall_pasien_lama", "fpr_campuran20")}}
    cekb = json.loads((TMP / "cek_bersih.json").read_text("utf-8")) if (TMP / "cek_bersih.json").exists() else None
    jumlah = {s_: per_jumlah(d) for s_, d in S.items()}
    # repeat visits on generator 2 (natural journeys): does the false-positive rate rise with the member's claims in the window?
    jg = [r for r in jumlah["gen2_baru"] if r["fpr_model_v3_bersih"] is not None and r["normal"] >= 100]
    if len(jg) >= 2:
        fv = [r["fpr_model_v3_bersih"] for r in jg]
        naik = all(b >= a for a, b in zip(fv, fv[1:])) and fv[-1] >= fv[0] * 1.5
        temuan.insert(4, {"ikon": "clock", "nada": "buruk" if naik else "netral",
                          "judul": f"Kunjungan berulang (generator 2): FPR {idn(fv[0] * 100, 1)}% → {idn(fv[-1] * 100, 1)}%",
                          "isi": " · ".join(f"{r['kelompok']} {idn(r['fpr_model_v3_bersih'] * 100, 1)}% (n {idn(r['normal'])})" for r in jg)
                                 + (". Naik bersama jumlah kunjungan: kelemahan model, bukan artefak uji." if naik else ".")})
    rg, mg = rule["gen2_baru"], hasil["gen2_baru"][rb]
    temuan.insert(5, {"ikon": "logic", "nada": "buruk" if mg["recall"] <= rg["recall"] + 0.05 else "netral",
                      "judul": f"Generator 2: v3 bersih {idn(mg['recall'] * 100)}% / {idn(mg['precision'] * 100)}% vs rule engine saja {idn(rg['recall'] * 100)}% / {idn(rg['precision'] * 100)}%",
                      "isi": f"Recall / precision. Di uji C v3 bersih jauh di atas rule engine ({idn(hasil['uji_c'][rb]['recall'] * 100)}% / {idn(hasil['uji_c'][rb]['precision'] * 100)}% vs "
                             f"{idn(rule['uji_c']['recall'] * 100)}% / {idn(rule['uji_c']['precision'] * 100)}%)."})
    tidak_valid = None
    if ongeldig:
        tidak_valid = {"alasan": KRIT.get("adendum", [{}])[0].get("alasan"), "aturan_build_ulang": KRIT.get("adendum", [{}])[0].get("aturan_build_ulang"),
                       "ditulis": KRIT.get("adendum", [{}])[0].get("ditulis"), "klaim": int(len(ongeldig["y"])), "fraud": int(ongeldig["y"].sum()),
                       "hasil": {m: {k: v for k, v in ringkas(ongeldig, m).items() if k in ("recall", "precision", "fpr", "auprc", "rasio_kunjungan_pertama")} for m in MODELS},
                       "per_jumlah_klaim": per_jumlah(ongeldig),
                       "porsi_normal_peserta_2plus": round(float(((ongeldig["k"] >= 2) & ~ongeldig["y"]).sum() / max(1, (~ongeldig["y"]).sum())), 4)}
    out = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "kriteria_ditulis": KRIT["ditulis"], "model": MODELS, "model_bersih": model_bersih,
           "cek_data": {k: cekb.get(k) for k in ("lulus", "wajib_nol", "catatan_diizinkan", "ukuran", "gema", "kunjungan_pertama")} if cekb else None,
           "hasil": hasil, "rule": rule, "ci": ci, "chunks": chunks, "per_jumlah_klaim": jumlah, "uji_c_tidak_valid": tidak_valid,
           "adendum": KRIT.get("adendum"),
           "skema": skema, "skema_bersama": bersama, "kriteria": kriteria, "vonis": vonis, "sebelum": sebelum, "temuan": temuan,
           "ukuran": {s: {"klaim": int(len(d["y"])), "fraud": int(d["y"].sum()), "chunk": d["n_chunk"]} for s, d in S.items()},
           "campuran_kunjungan_pertama": CAMPURAN, "set_uji": KRIT["set_uji"], "aturan": KRIT["aturan"],
           "batas": ["Uji C dibangun dua kali: build pertama memindahkan semua klaim Jan–Nov seorang peserta ke jendela yang sama (bug konstruksi); bug itu ketahuan karena skornya janggal, "
                     "angkanya dilaporkan di bagian 'Build uji C yang tidak valid', aturan build ulang ditulis (adendum) sebelum skor build ulang dilihat",
                     "Data sintetis; generator 2 memakai dunia (RS, kode, tarif, registri, riwayat) yang sama dengan generator 1",
                     "Uji C boleh berbagi peserta dengan generator 2 run pertama: klaimnya buatan, tidak pernah dilatih, dan hanya perilaku agregat run pertama yang membentuk perbaikan; peserta latih, validasi dan uji lain terpisah",
                     f"Uji C: {S['uji_c']['n_chunk']} chunk (~{idn(len(S['uji_c']['y']) / 1000)} ribu klaim). Percobaan pertama (20 chunk, tanpa peserta generator 2) dihentikan sebelum skor v3 bersih ada, karena hanya ~1.150 klaim per chunk dengan fraud 9%",
                     f"Generator 2 baru: {S['gen2_baru']['n_chunk']} chunk, hanya peserta peran gen2_baru (peserta dengan riwayat lebih sedikit daripada run pertama)",
                     "Generator 2 baru berbagi peserta dengan uji A, uji B dan generator 2 run pertama (klaimnya dibuat baru; tidak satu pun peserta latih)",
                     "66 klaim sumber uji C (0,18%) pernah dipakai data latih lama sebagai template plant untuk peserta lain: hanya menyangkut model pembanding v3 lama; v3 bersih nol",
                     "Porsi kunjungan pertama di data latih bersih 43% klaim normal (aliran 20%); FPR juga ditimbang ke campuran 20%",
                     "Arsitektur sama dengan v3: Model 1 masih memegang ~99% bobot fusi; varian arsitektur belum diuji",
                     "v3 lama dinilai pada fitur jalur baru, padahal dilatih pada jalur lama: angka pembandingnya memuat efek bug itu"],
           "detik": round(time.time() - t0, 1)}

    # the page says "echo" (English term, the user's preference); the locked criteria file keeps its original wording ("gema")
    def layar(x):
        if isinstance(x, str):
            return x.replace("tanpa gema", "tanpa echo").replace("gema", "echo")
        if isinstance(x, list):
            return [layar(v) for v in x]
        if isinstance(x, dict):
            return {k: layar(v) for k, v in x.items()}
        return x

    for k in ("set_uji", "adendum", "uji_c_tidak_valid", "batas", "aturan", "temuan"):
        out[k] = layar(out[k])
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    if SISTEM.exists() and not os.environ.get("PERBAIKAN_TANPA_SISTEM"):
        s = json.loads(SISTEM.read_text("utf-8"))
        s["perbaikan_v3"] = out
        SISTEM.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    print("written", OUT, "vonis", vonis, {s: {m: (r["recall"], r["precision"], r["fpr"], r["rasio_kunjungan_pertama"]) for m, r in v.items()} for s, v in hasil.items()})


if __name__ == "__main__":
    main()
