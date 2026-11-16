# Evaluasi data sintetis: fidelity, utility, privacy

Dihasilkan oleh `synthetic-gen/evaluate.py` + `laporan_md.py`. Semua angka adalah agregat. Metode dan rujukannya ada di [METODOLOGI.md](../METODOLOGI.md).

**Cara membaca.** Setiap ukuran kemiripan dibandingkan dengan **acuan holdout**: seberapa mirip sampel asli *baru* (20% peserta yang tidak pernah dipakai melatih) dengan data latih. Data sintetis yang sama mirip dengan acuan itu sudah sebaik yang bisa diharapkan dari sampel lain populasi yang sama. Nilai 1 berarti identik.

## Ringkasan

| Edisi | Baris sintetis (klaim FKRTL) | Baris asli | 1−TVD kategori (sintetis / acuan) | 1−KS angka & tanggal (sintetis / acuan) | AUC diskriminator klaim | Exact match klaim (sintetis / acuan) | AUC serangan keanggotaan |
|---|---:|---:|---|---|---:|---|---:|
| Reguler | 1,686,796 | 1,699,219 | 0.979 / 0.989 | 0.985 / 0.995 | 0.635 | 10.317% / 24.565% | 0.506 |
| COVID | 859,664 | 899,083 | 0.960 / 0.948 | 0.962 / 0.956 | 0.729 | 1.734% / 5.650% | 0.509 |
| DM | 1,070,148 | 1,074,811 | 0.975 / 0.972 | 0.971 / 0.974 | 0.611 | 23.117% / 39.503% | 0.502 |
| Kesehatan Mental | 880,263 | 899,004 | 0.963 / 0.945 | 0.963 / 0.964 | 0.651 | 11.689% / 43.413% | 0.499 |
| KIA-Ibu | 388,785 | 389,942 | 0.969 / 0.968 | 0.976 / 0.971 | 0.641 | 1.418% / 5.060% | 0.501 |
| KIA-Anak | 216,052 | 220,773 | 0.983 / 0.978 | 0.987 / 0.989 | 0.662 | 5.272% / 14.375% | 0.513 |
| TB | 229,660 | 235,671 | 0.976 / 0.968 | 0.981 / 0.981 | 0.674 | 2.655% / 7.151% | 0.503 |

**Utility untuk tugas app (label koreksi verifikasi, semua edisi, diuji pada 1,088,141 klaim holdout asli, 768 terkoreksi):** model dilatih pada data **asli** AUROC 0.999 (CI95 [0.998, 1.0]), AUPRC 0.899; dilatih pada data **sintetis** AUROC 0.998 (CI95 [0.996, 1.0]), AUPRC 0.854. Prevalensi uji 0.00071.

**Identitas:** ID asli yang ditemukan di tabel sintetis: **0** (dicek per kolom ID: kepesertaan.PSTV01, kepesertaan.PSTV02, fkrtl.FKL02, fkrtl.FKP02, fktpkapitasi.FKP02, nonkapitasi.PNK02, diagnosissekunder.FKL02).

**Pindai sidik jari `scan_akhir_database`:** 1 file (0.05 GB) diperiksa terhadap ±14,9 juta ID kunjungan/klaim asli dan ±3,8 juta nomor peserta asli: **0 file** berisi ID asli; kecocokan lemah (angka 10–12 digit yang kebetulan sama): 0 file.

**Pindai sidik jari `scan_akhir_repo`:** 17,449 file (23.05 GB) diperiksa terhadap ±14,9 juta ID kunjungan/klaim asli dan ±3,8 juta nomor peserta asli: **0 file** berisi ID asli; kecocokan lemah (angka 10–12 digit yang kebetulan sama): 13 file; tak terbaca: data\ontology\indexing\.watcher.lock.

> files_with_real_ids kosong: satu-satunya file yang dulu tercatat adalah .watcher.lock (file kunci yang dipegang API, tak terbaca, keliru dihitung). Kecocokan lemah: kolom peserta_id (nomor peserta SINTETIS 10 digit sebagai teks) di klaim_fkrtl dan klaim_fkrtl_fakta beserta versi/checkpoint-nya; 180 nomor kebetulan sama dengan nomor KUNJUNGAN asli berbentuk angka 10 digit (ruang ID entitas lain). Nomor peserta sintetis dijamin tidak sama dengan nomor peserta asli mana pun.

## Edisi Reguler

### Fidelity per kolom

| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |
|---|---|---|---|
| peserta | 0.995 / 0.998 (14 kolom) | 0.995 / 0.997 (4 kolom) | PSTV11 0.990 vs 1.000; PSTV13_NEW 0.988 vs 0.996; PSTV13 0.988 vs 0.996 |
| kunjungan FKTP | 0.986 / 0.996 (18 kolom) | 0.991 / 0.998 (7 kolom) | FKP14A 0.971 vs 0.990; FKP15 0.971 vs 0.990; FKP15A 0.962 vs 0.981 |
| klaim FKRTL | 0.978 / 0.986 (42 kolom) | 0.985 / 0.995 (11 kolom) | FKL09 0.964 vs 0.992; FKL18 0.946 vs 0.972; FKL18A 0.946 vs 0.972 |
| nonkapitasi | 0.960 / 0.984 (11 kolom) | 0.975 / 0.992 (8 kolom) | PNK06 0.900 vs 0.980; PNK06_NEW 0.900 vs 0.979; PNK13 0.970 vs 0.995 |
| diagnosis sekunder | 0.941 / 0.948 (3 kolom) | – / – (0 kolom) | FKL24A 0.947 vs 0.957; FKL24B 0.947 vs 0.957; FKL24 0.929 vs 0.929 |

### Fidelity multivariat

| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |
|---|---:|---:|---:|
| klaim FKRTL | 0.01410 | 2.35 | 0.635 |
| peserta | 0.00537 | 1.19 | 0.508 |

Selisih rata-rata Cramér's V antarpasangan kolom klaim: **0.015** (0 = struktur asosiasi sama). Pasangan terjauh: jenisÃƒÆ’Ã¢â‚¬â€poli 0.162→0.074, pulangÃƒÆ’Ã¢â‚¬â€keparahan 0.168→0.097, jenisÃƒÆ’Ã¢â‚¬â€cmg 0.142→0.088.

### Fidelity relasional (antartabel)

| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |
|---|---:|---:|---:|
| klaim FKRTL per peserta (rata-rata) | 0.657 | 0.651 | 0.652 |
| kunjungan FKTP per peserta (rata-rata) | 1.574 | 1.596 | 1.566 |
| diagnosis sekunder per klaim (rata-rata) | 1.159 | 1.140 | 1.153 |
| % klaim dengan rujukan FKTP | 58.920 | 60.060 | 59.150 |
| median hari rujukan → RS | 22.000 | 17.000 | 23.000 |
| % rujukan milik peserta yang sama | 100.000 | 100.000 | 100.000 |
| % rujukan: FKTP dan RS di kab/kota yang sama | 85.500 | 77.600 | 84.700 |
| % rujukan: FKTP dan RS di provinsi yang sama | 99.400 | 98.200 | 99.300 |
| % klaim di RS di kab/kota FKTP terdaftar | 77.000 | 74.600 | 76.300 |
| % kunjungan FKTP di kab/kota FKTP terdaftar | 97.300 | 96.600 | 97.300 |
| % rawat inap diikuti rawat inap ≤ 30 hari | 12.700 | 13.060 | 12.080 |
| % readmisi ≤ 30 hari di RS yang sama | 7.540 | 8.100 | 7.130 |
| calon klaim ganda per 100 ribu | 6.600 | 37.200 | 8.600 |
| % klaim dikoreksi verifikator | 0.097 | 0.233 | 0.093 |
| rata-rata biaya tagih (Rp) | 905,356 | 861,783 | 898,202 |
| median LOS rawat inap (hari) | 3.000 | 3.000 | 3.000 |

1−KS distribusi jumlah anak per induk (sintetis / acuan): klaim_fkrtl_per_peserta 0.999 / 0.999; kunjungan_fktp_per_peserta 0.995 / 0.999; dx_sekunder_per_klaim 0.991 / 0.998

### Privacy

| Uji | Sintetis | Acuan holdout asli | Artinya |
|---|---:|---:|---|
| Exact match peserta (8 quasi-identifier) | 6.251% | 6.133% | rekaman yang persis sama dengan seseorang di data latih |
| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | 10.317% | 24.565% | idem untuk klaim |
| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | 0.000% | 9.941% | Raab et al. 2024; 85.210% peserta unik di data asli |
| Median jarak ke rekaman asli terdekat (DCR) | 0.0583 | 0.0412 | sintetis tidak boleh lebih dekat dari sampel baru |
| % lebih dekat dari persentil-5 holdout | 0.000% | 5% | ≈ 5% berarti tidak ada penyalinan |
| % jarak nol | 13.590% | 13.790% | kembar persis pada fitur yang diukur |
| AUC serangan keanggotaan berbasis jarak | 0.506 | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |
| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | 6.692% | 8.482% | pengungkapan atribut; acuan = merilis sampel asli lain |

### Utility: tumpang tindih confidence interval (Karr et al. 2006)

| Model | Koefisien | Rata-rata overlap CI 95% | Median | % tanda koefisien sama | Korelasi koefisien asli–sintetis | n per sisi |
|---|---:|---:|---:|---:|---:|---:|
| rawat_inap | 33 | 0.359 | 0.058 | 75.8% | 0.627 | 150,000 |
| log_biaya_tagih | 40 | 0.383 | 0.377 | 80.0% | 0.811 | 150,000 |

Dengan n sebesar ini interval kepercayaan sangat sempit, jadi selisih koefisien yang kecil pun membuat overlap nol. Korelasi dan kesamaan tanda koefisien menunjukkan apakah arah dan besaran relatif pengaruhnya tetap sama.

## Edisi COVID

### Fidelity per kolom

| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |
|---|---|---|---|
| peserta | 0.988 / 0.988 (16 kolom) | 0.978 / 0.981 (4 kolom) | PSTV11 0.963 vs 0.991; PSTV12 0.962 vs 0.988; PSTV15 0.975 vs 0.984 |
| kunjungan FKTP | 0.977 / 0.981 (19 kolom) | 0.987 / 0.987 (7 kolom) | FKP07 0.966 vs 0.994; FKP08 0.967 vs 0.995; FKP09 0.965 vs 0.982 |
| klaim FKRTL | 0.968 / 0.969 (41 kolom) | 0.981 / 0.988 (13 kolom) | FKL43 0.964 vs 0.999; FKL34 0.964 vs 1.000; FKL40 0.964 vs 1.000 |
| nonkapitasi | 0.874 / 0.794 (13 kolom) | 0.908 / 0.872 (9 kolom) | PNK11 0.936 vs 0.991; PNK13 0.878 vs 0.915; PNK20 0.929 vs 0.937 |
| diagnosis sekunder | 0.946 / 0.918 (4 kolom) | – / – (0 kolom) | FKL49 1.000 vs 1.000; FKL24A 0.941 vs 0.919; FKL24 0.922 vs 0.876 |

### Fidelity multivariat

| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |
|---|---:|---:|---:|
| klaim FKRTL | 0.02913 | 4.88 | 0.729 |
| peserta | 0.02752 | 1.01 | 0.498 |

Selisih rata-rata Cramér's V antarpasangan kolom klaim: **0.025** (0 = struktur asosiasi sama). Pasangan terjauh: kelasÃƒÆ’Ã¢â‚¬â€pulang 0.567→0.155, kelasÃƒÆ’Ã¢â‚¬â€regional 0.137→0.048, jenisÃƒÆ’Ã¢â‚¬â€tagih 0.118→0.039.

### Fidelity relasional (antartabel)

| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |
|---|---:|---:|---:|
| klaim FKRTL per peserta (rata-rata) | 25.014 | 23.884 | 24.838 |
| kunjungan FKTP per peserta (rata-rata) | 23.248 | 22.977 | 22.888 |
| diagnosis sekunder per klaim (rata-rata) | 1.080 | 1.056 | 1.065 |
| % klaim dengan rujukan FKTP | 0.220 | 0.100 | 0.160 |
| median hari rujukan → RS | 32.000 | 8.000 | 18.500 |
| % rujukan milik peserta yang sama | 100.000 | 100.000 | 100.000 |
| % rujukan: FKTP dan RS di kab/kota yang sama | 93.500 | 29.900 | 93.800 |
| % rujukan: FKTP dan RS di provinsi yang sama | 99.700 | 30.300 | 100.000 |
| % klaim di RS di kab/kota FKTP terdaftar | 77.200 | 75.100 | 74.400 |
| % kunjungan FKTP di kab/kota FKTP terdaftar | 93.500 | 89.900 | 93.400 |
| % rawat inap diikuti rawat inap ≤ 30 hari | 23.180 | 20.110 | 24.810 |
| % readmisi ≤ 30 hari di RS yang sama | 15.980 | 13.120 | 17.430 |
| calon klaim ganda per 100 ribu | 14.600 | 37.600 | 10.000 |
| % klaim dikoreksi verifikator | 0.027 | 0.049 | 0.026 |
| rata-rata biaya tagih (Rp) | 982,201 | 1,027,617 | 1,024,238 |
| median LOS rawat inap (hari) | 3.000 | 3.000 | 3.000 |

1−KS distribusi jumlah anak per induk (sintetis / acuan): klaim_fkrtl_per_peserta 0.996 / 0.994; kunjungan_fktp_per_peserta 0.997 / 0.994; dx_sekunder_per_klaim 0.990 / 0.989

### Privacy

| Uji | Sintetis | Acuan holdout asli | Artinya |
|---|---:|---:|---|
| Exact match peserta (8 quasi-identifier) | 0.000% | 0.224% | rekaman yang persis sama dengan seseorang di data latih |
| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | 1.734% | 5.650% | idem untuk klaim |
| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | 0.000% | 0.379% | Raab et al. 2024; 99.750% peserta unik di data asli |
| Median jarak ke rekaman asli terdekat (DCR) | 0.0543 | 0.0514 | sintetis tidak boleh lebih dekat dari sampel baru |
| % lebih dekat dari persentil-5 holdout | 0.000% | 5% | ≈ 5% berarti tidak ada penyalinan |
| % jarak nol | 6.940% | 6.760% | kembar persis pada fitur yang diukur |
| AUC serangan keanggotaan berbasis jarak | 0.509 | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |
| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | 4.434% | 2.967% | pengungkapan atribut; acuan = merilis sampel asli lain |

## Edisi DM

### Fidelity per kolom

| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |
|---|---|---|---|
| peserta | 0.995 / 0.994 (14 kolom) | 0.990 / 0.994 (4 kolom) | PSTV12 0.989 vs 0.998; PSTV15 0.987 vs 0.994; PSTV10 0.989 vs 0.996 |
| kunjungan FKTP | 0.981 / 0.992 (18 kolom) | 0.981 / 0.995 (7 kolom) | PSTV15 0.967 vs 0.992; FKP13 0.976 vs 0.999; FKP08 0.975 vs 0.997 |
| klaim FKRTL | 0.987 / 0.986 (42 kolom) | 0.987 / 0.994 (11 kolom) | PSTV15 0.970 vs 0.991; FKL09 0.971 vs 0.989; FKL03 0.983 vs 0.996 |
| nonkapitasi | 0.901 / 0.869 (12 kolom) | 0.935 / 0.924 (9 kolom) | PNK08 0.968 vs 0.990; PNK11 0.930 vs 0.945; PNK19 0.947 vs 0.954 |
| diagnosis sekunder | 0.967 / 0.955 (3 kolom) | – / – (0 kolom) | FKL24B 0.975 vs 0.969; FKL24 0.963 vs 0.948; FKL24A 0.963 vs 0.948 |

### Fidelity multivariat

| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |
|---|---:|---:|---:|
| klaim FKRTL | 0.01374 | 2.51 | 0.611 |
| peserta | 0.02153 | 0.96 | 0.506 |

Selisih rata-rata Cramér's V antarpasangan kolom klaim: **0.012** (0 = struktur asosiasi sama). Pasangan terjauh: jenisÃƒÆ’Ã¢â‚¬â€poli 0.225→0.114, jenisÃƒÆ’Ã¢â‚¬â€cmg 0.15→0.091, tipeÃƒÆ’Ã¢â‚¬â€poli 0.105→0.05.

### Fidelity relasional (antartabel)

| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |
|---|---:|---:|---:|
| klaim FKRTL per peserta (rata-rata) | 6.553 | 6.520 | 6.529 |
| kunjungan FKTP per peserta (rata-rata) | 8.711 | 8.845 | 8.661 |
| diagnosis sekunder per klaim (rata-rata) | 1.591 | 1.566 | 1.574 |
| % klaim dengan rujukan FKTP | 68.940 | 69.810 | 69.110 |
| median hari rujukan → RS | 32.000 | 24.000 | 32.000 |
| % rujukan milik peserta yang sama | 100.000 | 100.000 | 100.000 |
| % rujukan: FKTP dan RS di kab/kota yang sama | 88.000 | 82.500 | 87.600 |
| % rujukan: FKTP dan RS di provinsi yang sama | 99.300 | 98.100 | 99.500 |
| % klaim di RS di kab/kota FKTP terdaftar | 82.900 | 80.300 | 82.200 |
| % kunjungan FKTP di kab/kota FKTP terdaftar | 98.200 | 97.600 | 98.100 |
| % rawat inap diikuti rawat inap ≤ 30 hari | 22.300 | 21.630 | 21.430 |
| % readmisi ≤ 30 hari di RS yang sama | 13.270 | 13.560 | 12.330 |
| calon klaim ganda per 100 ribu | 4.500 | 36.000 | 5.600 |
| % klaim dikoreksi verifikator | 0.042 | 0.081 | 0.038 |
| rata-rata biaya tagih (Rp) | 706,661 | 694,997 | 708,064 |
| median LOS rawat inap (hari) | 3.000 | 3.000 | 3.000 |

1−KS distribusi jumlah anak per induk (sintetis / acuan): klaim_fkrtl_per_peserta 0.998 / 0.997; kunjungan_fktp_per_peserta 0.989 / 0.997; dx_sekunder_per_klaim 0.991 / 0.993

### Privacy

| Uji | Sintetis | Acuan holdout asli | Artinya |
|---|---:|---:|---|
| Exact match peserta (8 quasi-identifier) | 1.407% | 1.170% | rekaman yang persis sama dengan seseorang di data latih |
| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | 23.117% | 39.503% | idem untuk klaim |
| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | 0.000% | 2.869% | Raab et al. 2024; 96.760% peserta unik di data asli |
| Median jarak ke rekaman asli terdekat (DCR) | 0.0103 | 0.0107 | sintetis tidak boleh lebih dekat dari sampel baru |
| % lebih dekat dari persentil-5 holdout | 0.000% | 5% | ≈ 5% berarti tidak ada penyalinan |
| % jarak nol | 25.080% | 24.900% | kembar persis pada fitur yang diukur |
| AUC serangan keanggotaan berbasis jarak | 0.502 | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |
| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | 11.529% | 15.841% | pengungkapan atribut; acuan = merilis sampel asli lain |

## Edisi Kesehatan Mental

### Fidelity per kolom

| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |
|---|---|---|---|
| peserta | 0.992 / 0.992 (14 kolom) | 0.991 / 0.992 (4 kolom) | PSTV12 0.978 vs 0.994; PSTV11 0.979 vs 0.992; PSTV10 0.989 vs 0.992 |
| kunjungan FKTP | 0.985 / 0.985 (18 kolom) | 0.987 / 0.991 (7 kolom) | FKP21 0.981 vs 0.992; FKP13 0.985 vs 0.995; FKP08 0.985 vs 0.994 |
| klaim FKRTL | 0.983 / 0.981 (41 kolom) | 0.987 / 0.990 (12 kolom) | FKL11 0.970 vs 0.989; FKL15 0.977 vs 0.993; FKL04 0.981 vs 0.995 |
| nonkapitasi | 0.859 / 0.757 (15 kolom) | 0.866 / 0.863 (6 kolom) | PNK12 0.867 vs 0.893; PNK07 0.753 vs 0.771; PNK05 0.887 vs 0.896 |
| diagnosis sekunder | 0.954 / 0.935 (3 kolom) | – / – (0 kolom) | FKL24A 0.959 vs 0.946; FKL24B 0.959 vs 0.946; FKL24 0.943 vs 0.914 |

### Fidelity multivariat

| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |
|---|---:|---:|---:|
| klaim FKRTL | 0.01909 | 3.54 | 0.651 |
| peserta | 0.02493 | 0.99 | 0.505 |

Selisih rata-rata Cramér's V antarpasangan kolom klaim: **0.015** (0 = struktur asosiasi sama). Pasangan terjauh: pulangÃƒÆ’Ã¢â‚¬â€keparahan 0.173→0.086, tipeÃƒÆ’Ã¢â‚¬â€poli 0.146→0.082, milikÃƒÆ’Ã¢â‚¬â€poli 0.116→0.066.

### Fidelity relasional (antartabel)

| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |
|---|---:|---:|---:|
| klaim FKRTL per peserta (rata-rata) | 9.959 | 9.796 | 10.183 |
| kunjungan FKTP per peserta (rata-rata) | 7.536 | 7.616 | 7.678 |
| diagnosis sekunder per klaim (rata-rata) | 1.230 | 1.212 | 1.224 |
| % klaim dengan rujukan FKTP | – | – | – |
| median hari rujukan → RS | – | – | – |
| % rujukan milik peserta yang sama | – | – | – |
| % rujukan: FKTP dan RS di kab/kota yang sama | – | – | – |
| % rujukan: FKTP dan RS di provinsi yang sama | – | – | – |
| % klaim di RS di kab/kota FKTP terdaftar | 78.600 | 76.500 | 78.500 |
| % kunjungan FKTP di kab/kota FKTP terdaftar | 97.600 | 95.800 | 97.500 |
| % rawat inap diikuti rawat inap ≤ 30 hari | 21.310 | 19.720 | 23.240 |
| % readmisi ≤ 30 hari di RS yang sama | 13.190 | 12.210 | 14.500 |
| calon klaim ganda per 100 ribu | 8.300 | 36.200 | 7.600 |
| % klaim dikoreksi verifikator | 0.045 | 0.076 | 0.049 |
| rata-rata biaya tagih (Rp) | 518,493 | 493,106 | 519,897 |
| median LOS rawat inap (hari) | 4.000 | 3.000 | 3.000 |

1−KS distribusi jumlah anak per induk (sintetis / acuan): klaim_fkrtl_per_peserta 0.996 / 0.986; kunjungan_fktp_per_peserta 0.993 / 0.988; dx_sekunder_per_klaim 0.995 / 0.998

### Privacy

| Uji | Sintetis | Acuan holdout asli | Artinya |
|---|---:|---:|---|
| Exact match peserta (8 quasi-identifier) | 0.110% | 0.242% | rekaman yang persis sama dengan seseorang di data latih |
| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | 11.689% | 43.413% | idem untuk klaim |
| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | 0.000% | 0.739% | Raab et al. 2024; 99.320% peserta unik di data asli |
| Median jarak ke rekaman asli terdekat (DCR) | 0.0114 | 0.0097 | sintetis tidak boleh lebih dekat dari sampel baru |
| % lebih dekat dari persentil-5 holdout | 0.000% | 5% | ≈ 5% berarti tidak ada penyalinan |
| % jarak nol | 21.160% | 22.550% | kembar persis pada fitur yang diukur |
| AUC serangan keanggotaan berbasis jarak | 0.499 | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |
| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | 13.973% | 15.959% | pengungkapan atribut; acuan = merilis sampel asli lain |

## Edisi KIA-Ibu

### Fidelity per kolom

| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |
|---|---|---|---|
| peserta | 0.996 / 0.997 (14 kolom) | 0.994 / 0.995 (4 kolom) | PSTV12 0.990 vs 0.998; PSTV11 0.990 vs 0.996; PSTV15 0.992 vs 0.996 |
| kunjungan FKTP | 0.987 / 0.993 (18 kolom) | 0.992 / 0.997 (7 kolom) | FKP08 0.979 vs 0.997; FKP07 0.981 vs 0.996; FKP14A 0.975 vs 0.986 |
| klaim FKRTL | 0.979 / 0.981 (42 kolom) | 0.982 / 0.992 (11 kolom) | FKL17A 0.943 vs 0.973; FKL17 0.964 vs 0.995; FKL22 0.964 vs 0.991 |
| nonkapitasi | 0.884 / 0.865 (12 kolom) | 0.946 / 0.913 (9 kolom) | PNK09 0.897 vs 0.969; PNK10 0.891 vs 0.952; PNK07 0.881 vs 0.919 |
| diagnosis sekunder | 0.928 / 0.920 (3 kolom) | – / – (0 kolom) | FKL24B 0.938 vs 0.942; FKL24 0.924 vs 0.909; FKL24A 0.924 vs 0.909 |

### Fidelity multivariat

| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |
|---|---:|---:|---:|
| klaim FKRTL | 0.01811 | 3.33 | 0.641 |
| peserta | 0.00821 | 1.02 | 0.508 |

Selisih rata-rata Cramér's V antarpasangan kolom klaim: **0.016** (0 = struktur asosiasi sama). Pasangan terjauh: milikÃƒÆ’Ã¢â‚¬â€cmg 0.094→0.035, tingkatÃƒÆ’Ã¢â‚¬â€cmg 0.919→0.863, jenisÃƒÆ’Ã¢â‚¬â€cmg 0.1→0.051.

### Fidelity relasional (antartabel)

| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |
|---|---:|---:|---:|
| klaim FKRTL per peserta (rata-rata) | 0.741 | 0.743 | 0.760 |
| kunjungan FKTP per peserta (rata-rata) | 3.176 | 3.229 | 3.201 |
| diagnosis sekunder per klaim (rata-rata) | 1.063 | 1.024 | 1.057 |
| % klaim dengan rujukan FKTP | 47.810 | 49.780 | 48.090 |
| median hari rujukan → RS | 12.000 | 10.000 | 13.000 |
| % rujukan milik peserta yang sama | 100.000 | 100.000 | 100.000 |
| % rujukan: FKTP dan RS di kab/kota yang sama | 86.500 | 78.700 | 86.000 |
| % rujukan: FKTP dan RS di provinsi yang sama | 99.500 | 97.400 | 99.600 |
| % klaim di RS di kab/kota FKTP terdaftar | 79.100 | 77.200 | 78.400 |
| % kunjungan FKTP di kab/kota FKTP terdaftar | 96.600 | 95.100 | 96.700 |
| % rawat inap diikuti rawat inap ≤ 30 hari | 7.840 | 8.870 | 7.510 |
| % readmisi ≤ 30 hari di RS yang sama | 5.240 | 6.530 | 4.920 |
| calon klaim ganda per 100 ribu | 9.700 | 38.100 | 5.000 |
| % klaim dikoreksi verifikator | 0.166 | 0.148 | 0.173 |
| rata-rata biaya tagih (Rp) | 1,238,293 | 1,170,255 | 1,226,776 |
| median LOS rawat inap (hari) | 2.000 | 2.000 | 2.000 |

1−KS distribusi jumlah anak per induk (sintetis / acuan): klaim_fkrtl_per_peserta 0.999 / 0.996; kunjungan_fktp_per_peserta 0.992 / 0.999; dx_sekunder_per_klaim 0.980 / 0.997

### Privacy

| Uji | Sintetis | Acuan holdout asli | Artinya |
|---|---:|---:|---|
| Exact match peserta (8 quasi-identifier) | 0.789% | 1.837% | rekaman yang persis sama dengan seseorang di data latih |
| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | 1.418% | 5.060% | idem untuk klaim |
| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | 0.000% | 6.512% | Raab et al. 2024; 93.850% peserta unik di data asli |
| Median jarak ke rekaman asli terdekat (DCR) | 0.0228 | 0.0155 | sintetis tidak boleh lebih dekat dari sampel baru |
| % lebih dekat dari persentil-5 holdout | 0.000% | 5% | ≈ 5% berarti tidak ada penyalinan |
| % jarak nol | 20.550% | 21.730% | kembar persis pada fitur yang diukur |
| AUC serangan keanggotaan berbasis jarak | 0.501 | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |
| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | 2.309% | 2.680% | pengungkapan atribut; acuan = merilis sampel asli lain |

## Edisi KIA-Anak

### Fidelity per kolom

| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |
|---|---|---|---|
| peserta | 0.996 / 0.996 (14 kolom) | 0.993 / 0.996 (3 kolom) | PSTV11 0.990 vs 0.997; PSTV12 0.993 vs 0.998; PSTV03 0.989 vs 0.994 |
| kunjungan FKTP | 0.989 / 0.991 (19 kolom) | 0.992 / 0.994 (5 kolom) | FKP21 0.985 vs 0.998; FKP11 0.985 vs 0.995; FKP22 0.989 vs 0.997 |
| klaim FKRTL | 0.980 / 0.974 (43 kolom) | 0.983 / 0.984 (9 kolom) | FKL17 0.968 vs 0.985; FKL09 0.969 vs 0.983; FKL21 0.985 vs 0.993 |
| diagnosis sekunder | 0.931 / 0.872 (3 kolom) | – / – (0 kolom) | FKL24B 0.940 vs 0.901; FKL24 0.927 vs 0.857; FKL24A 0.927 vs 0.857 |

### Fidelity multivariat

| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |
|---|---:|---:|---:|
| klaim FKRTL | 0.01966 | 3.89 | 0.662 |
| peserta | 0.00985 | 1.01 | 0.498 |

Selisih rata-rata Cramér's V antarpasangan kolom klaim: **0.017** (0 = struktur asosiasi sama). Pasangan terjauh: tingkatÃƒÆ’Ã¢â‚¬â€cmg 0.848→0.789, tipeÃƒÆ’Ã¢â‚¬â€cmg 0.113→0.062, milikÃƒÆ’Ã¢â‚¬â€cmg 0.092→0.044.

### Fidelity relasional (antartabel)

| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |
|---|---:|---:|---:|
| klaim FKRTL per peserta (rata-rata) | 0.688 | 0.671 | 0.676 |
| kunjungan FKTP per peserta (rata-rata) | 1.864 | 1.881 | 1.894 |
| diagnosis sekunder per klaim (rata-rata) | 0.893 | 0.876 | 0.897 |
| % klaim dengan rujukan FKTP | 43.170 | 44.350 | 43.210 |
| median hari rujukan → RS | 19.000 | 15.000 | 20.000 |
| % rujukan milik peserta yang sama | 100.000 | 100.000 | 100.000 |
| % rujukan: FKTP dan RS di kab/kota yang sama | 87.000 | 79.600 | 87.500 |
| % rujukan: FKTP dan RS di provinsi yang sama | 99.500 | 94.300 | 99.500 |
| % klaim di RS di kab/kota FKTP terdaftar | 80.400 | 79.100 | 80.500 |
| % kunjungan FKTP di kab/kota FKTP terdaftar | 97.900 | 96.900 | 97.800 |
| % rawat inap diikuti rawat inap ≤ 30 hari | 6.870 | 7.880 | 7.300 |
| % readmisi ≤ 30 hari di RS yang sama | 3.990 | 5.040 | 4.020 |
| calon klaim ganda per 100 ribu | 17.500 | 55.100 | 23.000 |
| % klaim dikoreksi verifikator | 0.115 | 0.113 | 0.138 |
| rata-rata biaya tagih (Rp) | 995,328 | 955,735 | 1,054,813 |
| median LOS rawat inap (hari) | 3.000 | 3.000 | 3.000 |

1−KS distribusi jumlah anak per induk (sintetis / acuan): klaim_fkrtl_per_peserta 1.000 / 0.998; kunjungan_fktp_per_peserta 0.995 / 0.997; dx_sekunder_per_klaim 0.987 / 0.997

### Privacy

| Uji | Sintetis | Acuan holdout asli | Artinya |
|---|---:|---:|---|
| Exact match peserta (8 quasi-identifier) | 0.527% | 6.075% | rekaman yang persis sama dengan seseorang di data latih |
| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | 5.272% | 14.375% | idem untuk klaim |
| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | 0.000% | 9.440% | Raab et al. 2024; 91.460% peserta unik di data asli |
| Median jarak ke rekaman asli terdekat (DCR) | 0.0556 | 0.0556 | sintetis tidak boleh lebih dekat dari sampel baru |
| % lebih dekat dari persentil-5 holdout | 0.000% | 5% | ≈ 5% berarti tidak ada penyalinan |
| % jarak nol | 33.210% | 33.760% | kembar persis pada fitur yang diukur |
| AUC serangan keanggotaan berbasis jarak | 0.513 | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |
| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | 3.403% | 3.220% | pengungkapan atribut; acuan = merilis sampel asli lain |

## Edisi TB

### Fidelity per kolom

| Tabel | Kolom kategori: rata-rata 1−TVD (sintetis / acuan) | Kolom angka & tanggal: rata-rata 1−KS (sintetis / acuan) | Kolom terlemah (sintetis vs acuan) |
|---|---|---|---|
| peserta | 0.993 / 0.993 (14 kolom) | 0.988 / 0.989 (4 kolom) | PSTV12 0.981 vs 0.997; PSTV11 0.981 vs 0.997; PSTV15 0.984 vs 0.988 |
| kunjungan FKTP | 0.984 / 0.984 (18 kolom) | 0.985 / 0.989 (7 kolom) | PSTV15 0.971 vs 0.989; FKP08 0.977 vs 0.995; FKP07 0.979 vs 0.993 |
| klaim FKRTL | 0.979 / 0.970 (42 kolom) | 0.986 / 0.985 (11 kolom) | FKL27 0.972 vs 0.991; FKL07 0.960 vs 0.971; FKL28 0.979 vs 0.988 |
| nonkapitasi | 0.944 / 0.933 (12 kolom) | 0.967 / 0.967 (9 kolom) | PSTV15 0.923 vs 0.946; PNK11 0.975 vs 0.995; PNK09 0.968 vs 0.982 |
| diagnosis sekunder | 0.936 / 0.865 (3 kolom) | – / – (0 kolom) | FKL24A 0.949 vs 0.897; FKL24 0.930 vs 0.849; FKL24B 0.930 vs 0.849 |

### Fidelity multivariat

| Tabel | pMSE | rasio pMSE (null = 1) | AUC diskriminator gradient boosting (0,5 = tak terbedakan) |
|---|---:|---:|---:|
| klaim FKRTL | 0.02022 | 3.49 | 0.674 |
| peserta | 0.02641 | 1.00 | 0.494 |

Selisih rata-rata Cramér's V antarpasangan kolom klaim: **0.014** (0 = struktur asosiasi sama). Pasangan terjauh: jenisÃƒÆ’Ã¢â‚¬â€cmg 0.136→0.077, jenisÃƒÆ’Ã¢â‚¬â€poli 0.13→0.075, tipeÃƒÆ’Ã¢â‚¬â€cmg 0.088→0.048.

### Fidelity relasional (antartabel)

| Ukuran | Asli (latih) | Sintetis | Asli (holdout) |
|---|---:|---:|---:|
| klaim FKRTL per peserta (rata-rata) | 1.982 | 1.934 | 1.997 |
| kunjungan FKTP per peserta (rata-rata) | 3.191 | 3.266 | 3.255 |
| diagnosis sekunder per klaim (rata-rata) | 1.253 | 1.225 | 1.240 |
| % klaim dengan rujukan FKTP | 61.800 | 61.800 | 62.030 |
| median hari rujukan → RS | 24.000 | 17.000 | 25.000 |
| % rujukan milik peserta yang sama | 100.000 | 100.000 | 100.000 |
| % rujukan: FKTP dan RS di kab/kota yang sama | 84.700 | 75.300 | 85.300 |
| % rujukan: FKTP dan RS di provinsi yang sama | 99.500 | 96.200 | 99.400 |
| % klaim di RS di kab/kota FKTP terdaftar | 75.800 | 72.300 | 76.900 |
| % kunjungan FKTP di kab/kota FKTP terdaftar | 97.700 | 96.400 | 97.800 |
| % rawat inap diikuti rawat inap ≤ 30 hari | 18.340 | 17.480 | 17.310 |
| % readmisi ≤ 30 hari di RS yang sama | 10.500 | 11.430 | 9.500 |
| calon klaim ganda per 100 ribu | 7.500 | 46.600 | 12.500 |
| % klaim dikoreksi verifikator | 0.086 | 0.095 | 0.077 |
| rata-rata biaya tagih (Rp) | 818,787 | 786,811 | 818,644 |
| median LOS rawat inap (hari) | 3.000 | 3.000 | 3.000 |

1−KS distribusi jumlah anak per induk (sintetis / acuan): klaim_fkrtl_per_peserta 0.996 / 0.997; kunjungan_fktp_per_peserta 0.993 / 0.997; dx_sekunder_per_klaim 0.990 / 0.996

### Privacy

| Uji | Sintetis | Acuan holdout asli | Artinya |
|---|---:|---:|---|
| Exact match peserta (8 quasi-identifier) | 0.306% | 0.389% | rekaman yang persis sama dengan seseorang di data latih |
| Exact match klaim (tanggal, RS, poli, diagnosis, INA-CBG, biaya) | 2.655% | 7.151% | idem untuk klaim |
| RepU (unik di asli & unik di sintetis; kunci: tgl lahir, JK, kab/kota, segmen) | 0.000% | 0.898% | Raab et al. 2024; 99.140% peserta unik di data asli |
| Median jarak ke rekaman asli terdekat (DCR) | 0.0358 | 0.0358 | sintetis tidak boleh lebih dekat dari sampel baru |
| % lebih dekat dari persentil-5 holdout | 0.000% | 5% | ≈ 5% berarti tidak ada penyalinan |
| % jarak nol | 12.990% | 11.810% | kembar persis pada fitur yang diukur |
| AUC serangan keanggotaan berbasis jarak | 0.503 | 0,5 | 0,5 = penyerang tidak bisa menebak siapa yang ikut melatih |
| DiSCO diagnosis utama (kunci: usia 5-th, JK, kab/kota, bulan, RS) | 6.845% | 4.621% | pengungkapan atribut; acuan = merilis sampel asli lain |

## Utility untuk audit klaim (semua edisi)

Random forest yang sama, fitur yang sama, diuji pada klaim **asli** holdout; satu dilatih pada klaim asli (latih), satu pada klaim sintetis.

| Dilatih pada | AUROC (CI95) | AUPRC (CI95) | Terkoreksi tertangkap di 1% skor teratas | Fitur terpenting |
|---|---|---|---:|---|
| data asli | 0.999 (0.998–1.0) | 0.899 (0.876–0.92) | 757 | jenis, tingkat, poli, tipe |
| data sintetis | 0.998 (0.996–1.0) | 0.854 (0.822–0.889) | 756 | jenis, tingkat, poli, tipe |

Korelasi Spearman laju aturan audit per kelompok jenis×tipe RS (164 kelompok, asli vs sintetis): LOS ekstrem 0.401, koreksi verifikasi 0.622, tagihan di atas tarif 0.329, rawat inap 0.875.

## Batasan

Lihat METODOLOGI.md §6. Angka dari data sintetis adalah angka dunia sintetis: pakai untuk demo, pengembangan dan pengujian metode, bukan sebagai statistik BPJS.
