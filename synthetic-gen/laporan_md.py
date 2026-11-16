"""laporan/evaluasi.json (+ scan_real_ids*.json, kerja/run_info_*.json) -> laporan/EVALUASI.md. Aggregates only."""

from __future__ import annotations

import json
import statistics as st
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sgen import config  # noqa: E402

NAMA = {"reguler": "Reguler", "covid": "COVID", "dm": "DM", "kesehatan_mental": "Kesehatan Mental", "kia_ibu": "KIA-Ibu", "kia_anak": "KIA-Anak", "tb": "TB"}
TABEL = {"kepesertaan": "peserta", "fkrtl": "klaim FKRTL", "fktpkapitasi": "kunjungan FKTP", "nonkapitasi": "nonkapitasi", "diagnosissekunder": "diagnosis sekunder"}


def f(x, d=3):
    return "–" if x is None else (f"{x:,.{d}f}" if isinstance(x, float) else f"{x:,}")


def mean_metric(rows, key):
    v = [r[key] for r in rows if r.get(key) is not None]
    return st.mean(v) if v else None


def main() -> None:
    ev = json.loads((config.REPORT / "evaluasi.json").read_text("utf-8"))
    runs = {p.stem.removeprefix("run_info_"): json.loads(p.read_text("utf-8")) for p in config.WORK.glob("run_info_*.json")}
    scans = {p.stem: json.loads(p.read_text("utf-8-sig")) for p in config.REPORT.glob("scan_*.json")}
    eds = ev["edisi"]
    L = []
    w = L.append
    w("# Evaluasi data sintetis: fidelity, utility, privacy\n")
    w("Dihasilkan oleh `synthetic-gen/evaluate.py` + `laporan_md.py`. Semua angka adalah agregat. Metode dan rujukannya ada di "
      "[METODOLOGI.md](../METODOLOGI.md).\n")
    w("**Cara membaca.** Setiap ukuran kemiripan dibandingkan dengan **acuan holdout**: seberapa mirip sampel asli *baru* (20% peserta "
      "yang tidak pernah dipakai melatih) dengan data latih. Data sintetis yang sama mirip dengan acuan itu sudah sebaik yang bisa "
      "diharapkan dari sampel lain populasi yang sama. Nilai 1 berarti identik.\n")

    # ---------------------------------------------------------------- summary
    w("## Ringkasan\n")
    w("| Edisi | Baris sintetis (klaim FKRTL) | Baris asli | 1−TVD kategori (sintetis / acuan) | 1−KS angka & tanggal (sintetis / acuan) | "
      "AUC diskriminator klaim | Exact match klaim (sintetis / acuan) | AUC serangan keanggotaan |")
    w("|---|---:|---:|---|---|---:|---|---:|")
    for e in eds:
        r = ev["per_edisi"][e]
        allrows = [x for t in r["univariat"].values() for x in t]
        cat = [x for x in allrows if x["metrik"] == "1-TVD"]
        num = [x for x in allrows if x["metrik"] == "1-KS"]
        ri = runs.get(e, {})
        w(f"| {NAMA.get(e, e)} | {f((ri.get('synthetic_rows') or {}).get('fkrtl'))} | {f((ri.get('real_rows') or {}).get('fkrtl'))} | "
          f"{f(mean_metric(cat, 'sintetis'))} / {f(mean_metric(cat, 'holdout_riil'))} | {f(mean_metric(num, 'sintetis'))} / {f(mean_metric(num, 'holdout_riil'))} | "
          f"{f(r['multivariat']['fkrtl']['auc_diskriminator'])} | {f(r['privasi']['exact_match_pct']['fkrtl']['sintetis'])}% / "
          f"{f(r['privasi']['exact_match_pct']['fkrtl']['holdout_riil'])}% | {f(r['privasi']['dcr_mia']['mia_auc'])} |")
    w("")
    if "tstr" in ev:
        t = ev["tstr"]
        w(f"**Utility untuk tugas app (label koreksi verifikasi, semua edisi, diuji pada {f(t['uji_holdout']['klaim'])} klaim holdout asli, "
          f"{f(t['uji_holdout']['terkoreksi'])} terkoreksi):** model dilatih pada data **asli** AUROC {f(t['latih_riil']['auroc'])} "
          f"(CI95 {t['latih_riil']['auroc_ci95']}), AUPRC {f(t['latih_riil']['auprc'])}; dilatih pada data **sintetis** AUROC {f(t['latih_sintetis']['auroc'])} "
          f"(CI95 {t['latih_sintetis']['auroc_ci95']}), AUPRC {f(t['latih_sintetis']['auprc'])}. Prevalensi uji {f(t['prevalensi_uji'], 5)}.\n")
    ids = ev.get("privasi_id_riil_ditemukan") or {}
    w(f"**Identitas:** ID asli yang ditemukan di tabel sintetis: **{sum(ids.values()) if ids else '–'}** (dicek per kolom ID: "
      f"{', '.join(ids) if ids else '–'}).\n")
    for name, sc in sorted(scans.items()):
        w(f"**Pindai sidik jari `{name}`:** {f(sc['files_scanned'])} file ({sc['gb_scanned']} GB) diperiksa terhadap ±14,9 juta ID kunjungan/klaim asli "
          f"dan ±3,8 juta nomor peserta asli: **{len(sc['files_with_real_ids'])} file** berisi ID asli"
          f"{'' if not sc['files_with_real_ids'] else ' (' + ', '.join(sc['files_with_real_ids']) + ')'}; "
          f"kecocokan lemah (angka 10–12 digit yang kebetulan sama): {len(sc.get('weak_numeric_matches') or {})} file"
          f"{'; tak terbaca: ' + ', '.join(sc['unreadable_files']) if sc.get('unreadable_files') else ''}.\n")
        if sc.get("penjelasan"):
            w(f"> {sc['penjelasan']}\n")

    # ---------------------------------------------------------------- per edition
    for e in eds:
        r = ev["per_edisi"][e]
        w(f"## Edisi {NAMA.get(e, e)}\n")
        w("### Fidelity per kolom\n")
        w("| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |")
        w("|---|---|---|---|")
        for t, rows in r["univariat"].items():
            if not rows:
                continue
            cat = [x for x in rows if x["metrik"] == "1-TVD"]
            num = [x for x in rows if x["metrik"] == "1-KS"]
            worst = sorted([x for x in rows if x["sintetis"] is not None], key=lambda x: x["sintetis"] - (x["holdout_riil"] or 1))[:3]
            ws = "; ".join(f"{x['kolom']} {x['sintetis']:.3f} vs {x['holdout_riil']:.3f}" for x in worst if x["holdout_riil"] is not None)
            w(f"| {TABEL.get(t, t)} | {f(mean_metric(cat, 'sintetis'))} / {f(mean_metric(cat, 'holdout_riil'))} ({len(cat)} kolom) | "
              f"{f(mean_metric(num, 'sintetis'))} / {f(mean_metric(num, 'holdout_riil'))} ({len(num)} kolom) | {ws} |")
        w("")
        m = r["multivariat"]
        w("### Fidelity multivariat\n")
        w("| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |")
        w("|---|---:|---:|---:|")
        for t, v in m.items():
            w(f"| {TABEL.get(t, t)} | {f(v['pmse'], 5)} | {f(v['pmse_ratio'], 2)} | {f(v['auc_diskriminator'])} |")
        bv = r["bivariat"]["fkrtl"]
        w(f"\nSelisih rata-rata Cramér's V antarpasangan kolom klaim: **{f(bv['rata2_selisih_cramers_v'])}** (0 = struktur asosiasi sama). "
          f"Pasangan terjauh: {', '.join(p['pair'] + ' ' + str(p['riil']) + '→' + str(p['sintetis']) for p in bv['pasangan_terjauh'][:3])}.\n")
        rel = r["relasional"]
        w("### Fidelity relasional (antartabel)\n")
        w("| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |")
        w("|---|---:|---:|---:|")
        a, s, h = rel["riil_training"], rel["sintetis"], rel["riil_holdout"]
        for key, label in (("klaim_fkrtl_per_peserta", "klaim FKRTL per peserta (rata-rata)"), ("kunjungan_fktp_per_peserta", "kunjungan FKTP per peserta (rata-rata)"),
                           ("dx_sekunder_per_klaim", "diagnosis sekunder per klaim (rata-rata)")):
            w(f"| {label} | {f(a[key]['rata2'])} | {f(s[key]['rata2'])} | {f(h[key]['rata2'])} |")
        for key, label in (("pct_klaim_dengan_rujukan", "% klaim dengan rujukan FKTP"), ("median_hari_rujukan_ke_rs", "median hari rujukan → RS"),
                           ("pct_rujukan_peserta_sama", "% rujukan milik peserta yang sama"),
                           ("pct_rujukan_kab_sama", "% rujukan: FKTP dan RS di kab/kota yang sama"),
                           ("pct_rujukan_provinsi_sama", "% rujukan: FKTP dan RS di provinsi yang sama"),
                           ("pct_rs_di_kab_fktp_terdaftar", "% klaim di RS di kab/kota FKTP terdaftar"),
                           ("pct_fktp_di_kab_terdaftar", "% kunjungan FKTP di kab/kota FKTP terdaftar"), ("pct_readmisi_30h", "% rawat inap diikuti rawat inap ≤ 30 hari"),
                           ("pct_readmisi_30h_rs_sama", "% readmisi ≤ 30 hari di RS yang sama"), ("klaim_ganda_per_100rb", "calon klaim ganda per 100 ribu"),
                           ("pct_koreksi_verifikasi", "% klaim dikoreksi verifikator"), ("rata2_biaya_tagih", "rata-rata biaya tagih (Rp)"),
                           ("median_los_inap", "median LOS rawat inap (hari)")):
            w(f"| {label} | {f(a.get(key))} | {f(s.get(key))} | {f(h.get(key))} |")
        w("\n1−KS distribusi jumlah anak per induk (sintetis / acuan): " + "; ".join(f"{k} {v['sintetis']:.3f} / {v['holdout_riil']:.3f}" for k, v in rel["1-KS"].items()) + "\n")
        p = r["privasi"]
        w("### Privacy\n")
        dm = p["dcr_mia"]
        w("| Uji | Sintetis | Acuan holdout asli | Artinya |")
        w("|---|---:|---:|---|")
        w(f"| Exact match peserta (8 quasi-identifier) | {f(p['exact_match_pct']['kepesertaan']['sintetis'])}% | {f(p['exact_match_pct']['kepesertaan']['holdout_riil'])}% | "
          "rekaman yang persis sama dengan seseorang di data latih |")
        w(f"| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | {f(p['exact_match_pct']['fkrtl']['sintetis'])}% | "
          f"{f(p['exact_match_pct']['fkrtl']['holdout_riil'])}% | idem untuk klaim |")
        w(f"| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | {f(p['repU']['repU_sintetis_pct'])}% | "
          f"{f(p['repU']['repU_holdout_pct_disesuaikan_ukuran'])}% | Raab et al. 2024; {f(p['repU']['pct_unik_di_riil'])}% peserta unik di data asli |")
        w(f"| Median jarak ke rekaman asli terdekat (DCR) | {f(dm['median_dcr_sintetis'], 4)} | {f(dm['median_dcr_holdout_riil'], 4)} | "
          "sintetis tidak boleh lebih dekat dari sampel baru |")
        w(f"| % lebih dekat dari persentil-5 holdout | {f(dm['pct_sintetis_lebih_dekat_dari_p5_holdout'])}% | 5% | ≈ 5% berarti tidak ada penyalinan |")
        w(f"| % jarak nol | {f(dm['pct_dcr_nol_sintetis'])}% | {f(dm['pct_dcr_nol_holdout_riil'])}% | kembar persis pada fitur yang diukur |")
        w(f"| AUC serangan keanggotaan berbasis jarak | {f(dm['mia_auc'])} | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |")
        w(f"| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | {f(p['disco_pct']['sintetis'])}% | {f(p['disco_pct']['holdout_riil'])}% | "
          "pengungkapan atribut; acuan = merilis sampel asli lain |")
        if "ci_overlap" in r:
            w("\n### Utility: tumpang tindih confidence interval (Karr et al. 2006)\n")
            w("| Model | Koefisien | Rata-rata overlap CI 95% | Median | % tanda koefisien sama | Korelasi koefisien asli–sintetis | n per sisi |")
            w("|---|---:|---:|---:|---:|---:|---:|")
            for k, v in r["ci_overlap"].items():
                w(f"| {k} | {v['koefisien']} | {f(v['rata2_overlap_ci'])} | {f(v['median_overlap_ci'])} | {f(v['pct_tanda_sama'], 1)}% | "
                  f"{f(v.get('korelasi_koefisien'))} | {f(v.get('n_per_sisi'))} |")
            w("\nDengan n sebesar ini interval kepercayaan sangat sempit, jadi selisih koefisien yang kecil pun membuat overlap nol. "
              "Korelasi dan kesamaan tanda koefisien menunjukkan apakah arah dan besaran relatif pengaruhnya tetap sama.")
        w("")

    if "tstr" in ev:
        t = ev["tstr"]
        w("## Utility untuk audit klaim (semua edisi)\n")
        w("Random forest yang sama, fitur yang sama, diuji pada klaim **asli** holdout; satu dilatih pada klaim asli (latih), satu pada klaim sintetis.\n")
        w("| Dilatih pada | AUROC (CI95) | AUPRC (CI95) | Terkoreksi tertangkap di 1% skor teratas | Fitur terpenting |")
        w("|---|---|---|---:|---|")
        for k, label in (("latih_riil", "data asli"), ("latih_sintetis", "data sintetis")):
            v = t[k]
            w(f"| {label} | {f(v['auroc'])} ({v['auroc_ci95'][0]}–{v['auroc_ci95'][1]}) | {f(v['auprc'])} ({v['auprc_ci95'][0]}–{v['auprc_ci95'][1]}) | "
              f"{v['tertangkap_di_1pct_teratas']} | {', '.join(list(v['fitur_teratas'])[:4])} |")
        if "peringkat_aturan" in ev:
            pr = ev["peringkat_aturan"]
            w(f"\nKorelasi Spearman laju aturan audit per kelompok jenis×tipe RS ({pr['kelompok']} kelompok, asli vs sintetis): LOS ekstrem {f(pr['los_ekstrem'])}, "
              f"koreksi verifikasi {f(pr['koreksi'])}, tagihan di atas tarif {f(pr['topup'])}, rawat inap {f(pr['inap'])}.\n")
    w("## Batasan\n")
    w("Lihat METODOLOGI.md §6. Angka dari data sintetis adalah angka dunia sintetis: pakai untuk demo, pengembangan dan pengujian metode, "
      "bukan sebagai statistik BPJS.\n")
    (config.REPORT / "EVALUASI.md").write_text("\n".join(L), "utf-8")
    print("wrote", config.REPORT / "EVALUASI.md")


if __name__ == "__main__":
    main()
