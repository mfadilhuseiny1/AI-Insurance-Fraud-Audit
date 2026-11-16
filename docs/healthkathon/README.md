# Healthkathon 2026: deteksi risiko klaim FKRTL, dan buktinya

> **AI JKN Synthetic:** dokumen ini disalin dari AI JKN Audit dan menggambarkan pengerjaan di atas Data Sampel BPJS yang asli. Angka agregat data asli sudah dihapus dan diganti `[…]`. Aplikasi ini berjalan di atas data sintetis (lihat `synthetic-gen/METODOLOGI.md` dan `synthetic-gen/laporan/EVALUASI.md`).

Bagaimana model ML di platform ini dievaluasi menurut kit Healthkathon
([healthkathon-eval-kit](https://github.com/Luche/healthkathon-eval-kit), commit `336bf7b`), dan cara mengulanginya.
Target ditetapkan lebih dulu di [PRAREGISTRASI.md](PRAREGISTRASI.md) (commit `78c67c7`).

## Data dan label

- Data Sampel BPJS Kesehatan Edisi 2025 (data klaim nyata yang dianonimkan): silver `kunjungan_fkrtl`, […]
  klaim FKRTL dari […] profil faskes. **Bukan data sintetis**, jadi tidak ada generator.
- Label: `flag_selisih_verifikasi`, klaim yang dibayar kurang dari tagihan oleh verifikator BPJS ([…] klaim,
  […]%). Positif berarti **dikoreksi verifikator, bukan fraud terbukti**. Label ini tidak bisa dihitung dari tagihan
  ([…] dari […] ditagih sesuai tarif + tambahan).
- […]% koreksi adalah klaim rawat inap klinik utama ([…]% klaim jenis itu dikoreksi): pola yang sudah ditangkap satu
  aturan. Di rumah sakit hanya […] koreksi dari […] klaim ([…]%), dan di situlah ujian model sebenarnya.

## Model dan benchmark (api/ml_klaim.py)

- Fitur sebelum verifikasi saja (tagihan, tarif INA-CBG, tarif tambahan, LOS dan indeksnya terhadap kode yang sama,
  keparahan, CMG, diagnosis, pola kunjungan peserta, indeks case-mix faskes); tidak ada kolom hasil verifikasi.
- Sembilan teknik supervised (regresi logistik, random forest, extra trees, HistGradientBoosting, XGBoost, LightGBM,
  CatBoost, MLP, EBM), Isolation Forest dan aturan sebagai pembanding; tiap teknik dengan rujukan riset deteksi fraud
  asuransi kesehatan (lihat tab Model ML).
- Validasi silang diulang 3 × 5, bertingkat per kelas dan dikelompokkan per profil faskes; ambang dipilih di
  validasi; interval bootstrap per faskes; t-test resampel terkoreksi (Nadeau & Bengio 2003) antarteknik; ablasi
  undersampling; uji temporal.

## Bukti menurut kit (api/aip/ml.py, job `bukti`)

1. Skor out-of-fold untuk **setiap** klaim: faskes dibagi 5 lipatan (seimbang menurut jumlah koreksi); model tiap
   segmen dilatih tanpa faskes yang dinilainya. Prevalensi nyata, tanpa penyeimbangan data uji (aturan 4).
2. Kartu bukti kit (`hkeval.report.build_card`, Bahasa Indonesia) untuk semua klaim dan untuk klaim rumah sakit:
   precision@k pada kapasitas 0,1% (asumsi), lift, recall rupiah, profil faskes jujur yang ikut diaudit per strata
   (kelas faskes, provinsi, ukuran), interval yang me-resample seluruh faskes.
3. Interval 95% (resampling seluruh profil faskes, undian yang sama dengan kit) juga untuk lift, recall@k, recall
   rupiah@k dan porsi faskes tanpa koreksi yang diaudit: keempat baris slide bukti kit. Juga ROC-AUC di samping
   PR-AUC, dan jumlah audit yang tidak berujung koreksi.
4. Uji ketahanan kit: ablasi berpasangan (aturan yang ada → aturan klinik utama → aturan + model → model → model yang
   diurutkan menurut nilai harapan, skor × tagihan: antrean menurut peluang atau menurut nilai adalah pilihan kebijakan),
   uji permutasi label, pemindaian kebocoran per kartu (AUC satu fitur > 0,80 harus dijelaskan; penjelasannya dihitung:
   AUC fitur itu terhadap pola rawat inap klinik utama dan di klaim rumah sakit, tempat pola itu tidak ada).
5. Negatif sulit dari data nyata: RS kelas A, dialisis/kemoterapi, diagnosis langka berbiaya tinggi, faskes kecil,
   masa wabah COVID: berapa yang jujur ikut ditandai.
6. Lembar tinjauan ahli buta (20 klaim rumah sakit teratas + 20 acak, tanpa skor): untuk diisi verifikator BPJS, lalu
   dinilai dengan `python -m hkeval score-review`.
7. Setiap target di [PRAREGISTRASI.md](PRAREGISTRASI.md) diperiksa kode terhadap kartu, dengan ambang yang terdaftar;
   yang meleset tampil apa adanya di tab Model ML.

Tidak berlaku di label nyata: plasebo (data nyata tidak punya versi tanpa fraud) dan recall per modus (label nyata
tidak punya modus). Keduanya diuji di benchmark aturan 2 di bawah.

## Benchmark aturan 2 (api/ml_sintetis.py, job `sintetis`)

Sumber kebenaran sekunder. Tujuh modus ditanam di klaim rumah sakit nyata (spesifikasi di
[SPESIFIKASI_GENERATOR.md](SPESIFIKASI_GENERATOR.md), di-commit sebelum output detektor dilihat): kesulitan, frekuensi
dan klaster diubah satu per satu dari kondisi dasar, satu kartu kit per kondisi; di kondisi dasar tiap modus sekali
ditahan dari pelatihan (recall@k modus itu dibanding acak), dan plasebo: model lipatan yang sama menilai klaim yang sama
sebelum fraud ditanam, dengan ambang kapasitas tetap, sehingga tiap klaim yang lewat adalah alarm palsu.

## Mengulangi

```bash
# kit evaluasi (tanpa lisensi: dipakai di tempatnya, tidak disalin ke repo ini)
git clone https://github.com/Luche/healthkathon-eval-kit data/aip/ml/hkeval-kit
git -C data/aip/ml/hkeval-kit checkout 336bf7b4e46dae2e0e4495684c0aad037f0e1f56
# sebagai admin, lewat API platform:
#   POST /api/aip/ml/train  {"lipatan": 5, "ulangan": 3}   benchmark, model terpilih, skor semua klaim, MLflow
#   POST /api/aip/ml/bukti  {"kapasitas": 0.001}          skor out-of-fold + kartu bukti kit
#   GET  /api/aip/ml/bukti/bukti_rumah_sakit.html          kartu; review/review_sheet.csv untuk peninjau
#   POST /api/aip/ml/aturan2 {}                            benchmark aturan 2 (fraud ditanam, ±1 jam)
#   GET  /api/aip/ml/aturan2/aturan2_baseline.html         kartu per kondisi; aturan2.json ringkasannya
```

Hasilnya tampil di /aip-jkn, tab **Model ML**, dan bisa ditanyakan ke Agen Machine Learning di orkestrasi AIP.
