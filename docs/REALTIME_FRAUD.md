# Realtime Fraud: deteksi fraud realtime untuk 20 modus Permenkes 16/2019, terintegrasi ke sistem audit

Tab **Realtime Fraud** di `/aip-jkn` (AI JKN Synthetic). Setiap peristiwa (klaim FKRTL, kunjungan FKTP beserta
rujukannya, klaim nonkapitasi) dinilai saat masuk, dalam konteks entitas dan jaringan di sekitarnya. Polanya mengikuti
cara Quantexa mendeskripsikan deteksi fraud:
1. entity resolution;
2. graf dinamis;
3. skor kontekstual dengan faktor mitigasi;
4. alert dikonsolidasi per entitas;
5. investigasi;
6. keputusan kembali ke sistem.

Hasilnya langsung masuk ke sistem audit yang sudah ada: ledger tag indikasi, lalu Box Karantina, lalu AI Agent Swarm.

Semua data di sini sintetis: kembaran sintetis Data Sampel BPJS (`synthetic-gen/`) dan kiriman faskes dari aplikasi demo
ai-jkn.

## Alur

```
ai-jkn Kodifikasi "Submit klaim" ─POST /faskes/klaim (token ingest)─┐
Simulator (replay 14 hari: FKRTL + FKTP + nonkapitasi, skenario) ───┤
Sistem lain ─POST /klaim, /fktp, /nonkapitasi (sesi/PAT) ───────────┘
      ▼ antrean → worker (micro-batch, urut kedatangan; bertindak sebagai admin pemilik mesin)
  1 versi       id klaim FKRTL yang sama = pengajuan ulang (bukan klaim ganda)
  2 peserta     registri (jenis kelamin, usia, hak kelas, segmen, keluarga, tahun meninggal) per kartu: entity resolution
  3 model       klaim FKRTL: model produksi ter-deploy, fitur point-in-time + riwayat aliran; TreeSHAP hanya untuk alert
  4 konteks     graf.py (jaringan, riwayat peserta), aturan_rt.py (registri, referensi kode, baris obat/hasil faskes),
                fktp.py (FKTP & nonkapitasi vs riwayat faskes itu sendiri); pemantauan periodik angka kontak unit kapitasi
  5 keputusan   bobot, tag dan modus tiap sinyal dari modus.SIGNALS (bobot terkalibrasi menimpa);
                skor = 100·(1 − e^(−Σ bobot·kekuatan·(1 − mitigasi)))  → LOLOS < 45 ≤ PERIKSA < 75 ≤ TAHAN
  6 kasus       satu kasus per entitas fokus (faskes / peserta / cincin); ringkasan investigasi per kasus
  7 integrasi   tiap alert → tag di ledger indikasi (agen `deteksi_realtime`) → Box Karantina (debounce 2 menit)
                → AI Agent Swarm; keputusan manusia atas kasus memutus tag-nya dan mengkalibrasi bobot sinyal
```

Faskes hanya menerima **tanda terima**, tidak pernah skor atau keputusan (tidak ada tipping-off). Profil faskes diambil
dari **registri sistem audit**, bukan dari deklarasi faskes.

## 20 modus (M07 dan M19 sama di daftar: inflated bills)

Status deteksi:
- **data**: dibaca langsung dari aliran dan registri.
- **proksi**: hanya jejak tidak langsung yang terlihat.
- **kontrak**: aturannya berjalan atas baris yang dikirim faskes; data sampel tidak memuatnya.

| Modus | Deteksi | Sinyal (realtime) |
|---|---|---|
| M01 Penyalahgunaan dana kapitasi | proksi | Kontak semu (lonjakan online/home-visit, binomial vs riwayat FKTP); angka kontak unit anjlok (Poisson, jendela 3 hari); rujukan non-spesialistik Puskesmas naik |
| M02 Manipulasi klaim nonkapitasi | data | Tindakan ganda (ANC/persalinan berulang); pemeriksaan Prolanis/PRB terlalu sering; KB/ANC untuk laki-laki atau di luar usia 10–55; tarif > 1,25× p95 tindakan; tanggal di luar kunjungan; lonjakan volume (mitigasi hari Prolanis) |
| M03 Rujukan tidak sesuai | data | Rujukan diagnosis kompetensi FKTP (4A); loncat jenjang ke RS kelas A; RRNS FKTP naik (binomial vs riwayat) |
| M04 Upcoding | data | Lonjakan keparahan III faskes (binomial vs riwayat); diagnosis sekunder > p99 kode + 2; skor model |
| M05 Cloning | data | Klaim rawat inap identik lintas ≥ 3 peserta (tagihan bukan tarif paket) |
| M06 Phantom billing | data | Rawat inap tumpang tindih di dua faskes; satu kartu di ≥ 3 faskes dalam 3 hari; klaim setelah kematian (tercatat di aliran / registri); kartu anggota keluarga dipakai |
| M07/M19 Inflated bills | data | Tagihan > 1,2× tarif + top-up; top-up special CMG > 1,5× p95 kode & jenisnya |
| M08 Pemecahan episode (hari sama) | data | Rawat jalan + rawat inap (atau dua rawat jalan) di faskes yang sama hari yang sama |
| M09 Unbundling | data | Masuk lagi 0–3 hari setelah pulang, diagnosis & faskes sama |
| M10 Self-referral | data | Rujukan FKTP memusat ke satu tujuan (binomial vs sebaran riwayat); cincin RS berbagi peserta (Poisson vs riwayat pasangan) |
| M11 Repeat billing | data | Klaim sama dengan id lain; versi mirip (tanggal masuk digeser 1 hari) |
| M12 Prolonged LOS | data | LOS > 2× p90 kode; indeks LOS faskes bergeser (rata-rata ≥ 1,4× riwayat, z ≥ 4) |
| M13 Kelas rawat | data | Kelas di atas hak (PBI kuat; non-PBI dimitigasi naik kelas sendiri) |
| M14 Tindakan tidak dilakukan | data | Kode INA-CBG kelompok prosedur tanpa tindakan tercatat |
| M15 Tidak sesuai indikasi | data | Diagnosis/kode tidak mungkin untuk jenis kelamin/usia; pasangan diagnosis–kode ≤ 3 dari ≥ 1.000 klaim diagnosis |
| M16 Readmisi | data | Rawat inap ulang 4–30 hari, diagnosis sama; readmisi ≤ 30 hari diagnosis lain (lemah) |
| M17 Klaim fiktif obat/alkes/tindakan | data + kontrak | Top-up yang hampir tak pernah ada untuk kode (≤ 2 dari ≥ 200 klaim); obat ditagih tanpa diserahkan (baris obat faskes) |
| M18 Pengurangan obat | kontrak | Diserahkan < ditagih (baris obat faskes: diresepkan, ditagih, diserahkan) |
| M20 Manipulasi hasil pemeriksaan | kontrak | Nilai di klaim ≠ nilai alat/LIS di luar toleransi (baris pemeriksaan faskes) |

Tag ledger baru (di `aip/semantik.py`):
- KAPITASI_TIDAK_WAJAR, NONKAPITASI_TIDAK_WAJAR, RUJUKAN_TIDAK_SESUAI;
- TINDAKAN_TIDAK_DILAKUKAN, TIDAK_SESUAI_INDIKASI;
- OBAT_ALKES_FIKTIF, PENGURANGAN_OBAT, MANIPULASI_PEMERIKSAAN;
- JARINGAN_FASKES.

Daftar diagnosis non-spesialistik (`modus.NON_SPESIALISTIK`) adalah daftar kerja SKDI 4A dan perlu dicocokkan dengan daftar
resmi sebelum dipakai di luar demonstrasi.

## Kemampuan ala Quantexa

| Kemampuan | Di sini |
|---|---|
| Ingestion batch + realtime | 3 jenis peristiwa + kiriman SIMRS faskes |
| Entity resolution | Registri peserta per kartu (dan keluarganya), kematian yang tercatat di aliran, pasien kiriman faskes (no RM + nama, Jaro-Winkler, identitas ganda tidak digabung otomatis) |
| Graf dinamis | Peserta–faskes, faskes–faskes, FKTP → tujuan rujukan; dipulihkan dari peristiwa tersimpan saat restart (195 ribu peristiwa ±17 detik) |
| Skor kontekstual + mitigasi | Model + aturan + graf; mitigasi: rujukan berjenjang, pindah rawat satu provinsi, IGD, pulang paksa, naik kelas sendiri, tanggal lahir pengganti, registri tahun saja, tarif referensi, hari Prolanis, bukti IoMT. Skor tanpa mitigasi ikut disimpan |
| Kasus per entitas | Prioritas skor × rupiah; modus per kasus |
| Copilot investigasi | Ringkasan per kasus dari templat (tanpa model bahasa): temuan, modus, bukti terkuat, jaringan, dokumen yang diminta, batas data |
| Umpan balik | Bobot sinyal dari keputusan kasus (Beta(2,2) posterior, usulan = bawaan × clip(post/0,5; 0,5; 1,6)), diterapkan admin; label kasus diekspor (CSV) |
| Kirim sinyal ke sistem lain | Ledger indikasi → Box Karantina → AI Agent Swarm; Nexus lewat ledger |

## Self-supervised + active learning: model yang membaik dari waktu ke waktu

Siklusnya mengikuti MONAI Label: pretraining tanpa label → strategi aktif → anotasi → latih → infer. Diterjemahkan ke konteks
asuransi menjadi lima bagian (sub-tab **Active Learning**).

### 1. Pretraining self-supervised (`ssl.py`)

- **Metode:** masked autoencoder tabular (VIME, Yoon dkk. NeurIPS 2020), satu model per jenis peristiwa, dilatih pada rekaman
  tanpa label sebelum jendela replay:

  | Model | Data | Medan (dimensi) | Input |
  |---|---|---|---|
  | FKRTL | 389 ribu klaim (tabel fitur ML) | 31 (70) | fitur titik-waktu model produksi: uang dan cacah (log), rasio terhadap norma kode, riwayat peserta dan faskes, profil faskes |
  | FKTP | 388 ribu kunjungan (silver + registri) | 25 (70) | tingkat, jenis kunjungan, poli, status pulang, rujukan (non-spesialistik, kelas tujuan, luar kab/kota), peserta (usia, jenis kelamin, segmen, berobat di FKTP terdaftar), kelaziman diagnosis dan kecocokannya dengan poli, jenis kelamin, kelompok usia, jenis FKTP, dan rujukan (PMI), riwayat FKTP |
  | Nonkapitasi | 284 ribu klaim (silver + registri) | 19 (57) | kelompok tindakan, biaya terhadap median tindakan, urutan tindakan, jarak kunjungan–tindakan, peserta, kelaziman tindakan dan kecocokannya dengan jenis kelamin, usia, diagnosis, jenis faskes (PMI), volume faskes |

  - **Tugas belajar:** 30% **medan** tiap rekaman ditukar dengan medan rekaman lain (nilai beserta penanda hilangnya, atau
    satu blok kategori utuh), lalu jaringan merekonstruksi nilai asli dan menebak medan mana yang ditukar. Versi awal menukar
    kolom one-hot satu per satu, sehingga 1,5–23% baris latih berisi kategori yang mustahil.
  - **Data held-out:** 10% data tidak ikut dilatih. Galatnya dicatat per epoch, dan ambang anomali (p99, p99,9) dihitung dari
    data ini, bukan dari data yang dihafal jaringan.
  - **Durasi:** 12–20 detik per model di CPU.
- **Keluaran 1, embedding 16 dimensi:** dipakai active learner sebagai fitur dan untuk keragaman antrean.
- **Keluaran 2, skor anomali dengan penjelasan:** galat rekonstruksi rekaman apa adanya.
  - Skala: lazim (< p99), tidak lazim (≥ p99), anomali (≥ p99,9). Sinyal `ANOMALI_SSL` (bobot 0,4) menyala di atas p99,9.
  - Penjelasan: medan dengan porsi galat ≥ 10% ditampilkan bersama nilai klaim ini dan nilai yang diharapkan dari pola serupa,
    misalnya "tarif tambahan Rp4,2 juta (pola serupa: Rp0,3 juta)".
  - Ambang tidak diturunkan ke p99. Pada FKRTL, p99 menangkap 7,7% klaim tanam tetapi juga menyala pada 0,9% klaim normal, dan
    hanya menambah 8 dari 499 klaim tanam yang lolos dari aturan. Nilai SSL ada pada fitur kontinu yang dipakai model adaptif.
- **Versi dan input mentah:** setiap peristiwa menyimpan versi model, kunci spesifikasi input, dan input mentahnya (`x`).
  - Bila model SSL dilatih ulang, `aktif.refresh` menghitung ulang embedding peristiwa lama dari `x`. Ruang embedding versi
    lama tidak pernah dicampur dengan yang baru.
  - Juara model adaptif mencatat versi SSL yang dipakainya (`ssl_versi`). Fitur SSL dari versi lain diabaikan (NaN) sampai
    juara dilatih ulang, dan tab Active Learning menampilkan peringatan.
- **Drift:** mesin menghitung porsi rekaman aliran di atas p99 held-out per jenis. Bila porsinya jauh di atas 1% (uji binomial
  p < 10⁻⁴ dan porsi > 1,5%), statusnya menjadi "drift" dan disarankan latih ulang dengan data terbaru.

### 2. Model adaptif (`aktif.py`)

- **Bentuk model:** komite 5 LightGBM bootstrap.
- **Fitur:** kekuatan tiap sinyal, jenis peristiwa, risiko model produksi, tagihan, skor aturan dan mitigasinya, serta anomali
  dan embedding SSL.
- **Bertumpu pada skor aturan:** skor aturan dipakai sebagai `init_score` (log-odds). Boosting mempelajari koreksi atas aturan,
  misalnya sinyal yang sering memicu pada klaim normal, sehingga tidak belajar fraud dari nol dengan beberapa ratus label.
- **Ketidakpastian:** sebaran antar anggota komite adalah ketidakpastian epistemik, setara strategi Epistemic di MONAI yang
  memakai MC-dropout.

### 3. Strategi kueri (antrean telaah)

- **acak:** pembanding.
- **entropi:** peristiwa dengan p paling dekat 0,5.
- **epistemik:** ketidaksepakatan komite terbesar.
- **hibrida:**
  - skor gabungan: 0,45 entropi + 0,35 epistemik + 0,20 nilai (p × log tagihan);
  - lalu k-center serakah di ruang fitur + embedding untuk keragaman;
  - ditambah 20% acak (ε-greedy) supaya label tidak bias ke batas keputusan.
- **Awal dingin:** sebelum kedua kelas berlabel, separuh antrean dari skor aturan tertinggi dan separuh dari keragaman.

### 4. Label dan gerbang

- **Sumber label:** antrean telaah (perlu tindakan / wajar) dan keputusan kasus (konfirmasi = 1 dan false positive = 0, pada
  peristiwa yang di-alert).
- **Gerbang promosi:** challenger dipromosikan bila tiap kelas punya ≥ 10 label dan AUPRC validasi silangnya ≥ skor aturan
  pada lipatan yang sama − 0,02.
- **Mode juara:**
  - **bayangan** (bawaan): p dicatat di setiap peristiwa, keputusan tetap dari aturan;
  - **aktif:** keputusan dari model adaptif, PERIKSA bila p ≥ 0,3 dan TAHAN bila p ≥ 0,7 (`al_ambang_periksa`,
    `al_ambang_tahan`); skor aturan disimpan sebagai `skor_aturan`;
  - **mati.**
- **Tanpa koreksi prior:** strategi aktif memilih peristiwa menurut fiturnya, bukan menurut kelasnya. Sampel label
  mengalami *covariate shift*, bukan *label shift*, jadi P(y | x) yang dipelajari tetap berlaku untuk aliran walaupun
  separuh label positif. Koreksi Elkan (yang benar untuk model ML produksi, karena dilatih dari sampel per kelas) sempat
  dicoba di sini: model lalu memperkirakan 107 positif pada data uji, padahal teramati 1.223. Koreksi itu dicabut.

### 5. Bukti "membaik dari waktu ke waktu"

- **Cara simulasi:** oracle membaca kebenaran skenario tanam.
  - Pool: 70% peristiwa pertama. Uji: 30% terakhir.
  - Setiap strategi mulai dari 20 label acak yang sama, lalu 25 label per ronde.
  - AUPRC uji dicatat per ronde, berdampingan dengan AUPRC skor aturan.
- **Run penuh 2026-11-10, dengan tiga model SSL** (195.301 peristiwa dari replay ulang tanpa batch hilang; pool 136.710
  dengan 2.835 positif; uji 58.591 dengan 1.135 positif = 1,9%; 770 label; ±200 detik termasuk ablation):

  | | AUPRC uji | positif di antara 770 label | label untuk melampaui aturan (+0,01) |
  |---|---|---|---|
  | Skor aturan (tanpa belajar) | 0,483 | – | – |
  | Model ML produksi saja | 0,058 | – | – |
  | Acak | 0,695 | 20 | 70 |
  | Entropi | 0,788 | 374 | 70 |
  | Epistemik (terbaik) | 0,801 | 352 | 95 |
  | Hibrida | 0,616 | 304 | 45 |

  - Sebelum SSL FKTP dan nonkapitasi ada (SSL hanya FKRTL): epistemik 0,634, acak 0,553, aturan 0,467. Run sebelumnya
    lagi: entropi 0,625, epistemik 0,610, hibrida 0,598. **Urutan antar strategi tidak stabil** (hibrida terburuk di run
    ini). Yang stabil: semua strategi melampaui aturan, dan strategi aktif mengisi antrean telaah dengan 15–19× lebih banyak
    kasus nyata daripada acak.
  - Dengan 20 label awal (1 positif), komite sama persis dengan aturan karena aturan adalah `init_score`-nya. Model mulai
    dari aturan, bukan dari nol.
- **Ablation: sumbangan self-supervised** (strategi epistemik, label dan ronde sama, rata-rata 2 seed):

  | Jenis (positif di uji) | Aturan | Model tanpa SSL | Model dengan SSL |
  |---|---|---|---|
  | Semua (1.135) | 0,483 | 0,630 | **0,791** |
  | FKTP (732) | 0,566 | 0,572 | **0,857** |
  | FKRTL (379) | 0,434 | 0,694 | 0,683 |
  | Nonkapitasi (24) | 0,490 | 0,557 | 0,501 |

  Sumbangan terbesar ada di FKTP, yang sebelumnya tanpa SSL. Di FKRTL run ini tidak menunjukkan manfaat (selisih di dalam
  sebaran antar seed; ablation awal dengan SSL lama memberi +0,04 sampai +0,14). Nonkapitasi hanya 24 positif di uji, jadi
  terlalu sedikit untuk disimpulkan. Galat rekonstruksi sendirian: AUPRC FKTP 0,24 vs acak 0,02, FKRTL 0,16 vs 0,02,
  nonkapitasi 0,14 vs 0,01. Sinyal ANOMALI_SSL (> p99,9) menyala pada 12% kunjungan FKTP tanam vs 0,12% normal.
- **Titik operasi** (model epistemik vs keputusan aturan, peristiwa uji yang sama):

  | Keputusan | Laju alarm | Presisi | Recall |
  |---|---|---|---|
  | Aturan: PERIKSA atau TAHAN | 2,3% | 54% | 63% |
  | Aturan: TAHAN | 0,54% | 53% | 15% |
  | Model p ≥ 0,3 (ambang PERIKSA) | 1,9% | 74% | 72% |
  | Model p ≥ 0,5 | 1,5% | 88% | 66% |
  | Model p ≥ 0,7 (ambang TAHAN) | 1,2% | 95% | 56% |
  | Model p ≥ 0,85 | 0,61% | 98% | 31% |

  Pada laju alarm yang mirip TAHAN aturan (0,6%), presisi model 98% vs 53% dan recall 31% vs 15%.
- **Kalibrasi:** total diharapkan 1.349 vs teramati 1.135. Pada run sebelumnya: 1% → 0,5%; 10% → 4%; 23% → 24%; 52% → 50%;
  65% → 83%; 87% → 96% (sedikit melebihkan di bawah, sedikit merendahkan di atas).
- **Uji coba pertama tanpa tumpuan pada skor aturan:** strategi aktif tidak lebih baik dari acak. Karena itu desainnya
  diubah.

**Catatan jujur:**
- Label oracle adalah skenario yang dibuat simulator ini sendiri. Kurva mengukur seberapa cepat model belajar pola yang
  ditanam, bukan kinerja pada fraud nyata.
- AUPRC validasi silang di registri (0,89) dihitung pada label yang dipilih aktif, sehingga optimistis. Angka yang adil
  adalah AUPRC uji pada urutan waktu (0,80).
- Juara yang sekarang dilatih dari label oracle dan berjalan **bayangan**. Di produksi, label datang dari verifikator dan
  investigator lewat antrean telaah dan keputusan kasus. Juara baru dari label itu perlu melewati gerbang, lalu dipantau di
  mode bayangan sebelum diaktifkan.

## Dua lapis pencegahan: rumah sakit dan audit pusat

Analisis jaringan ala Quantexa dijalankan di dua tempat. Pembagiannya menurut data yang sah dilihat masing-masing.

| | Lapis 1 · rumah sakit (ai-jkn) | Lapis 2 · audit pusat (sistem ini) |
|---|---|---|
| Kapan | sebelum Submit (gerbang di tombol Submit Kodifikasi) | saat Submit, sebelum pembayaran |
| Data | registrasi, pasien, staf, alat, dan klaim tersimpan milik RS itu sendiri | semua faskes, registri peserta, graf lintas faskes |
| Entity resolution | no RM → orang: NIK; kartu + tanggal lahir + jenis kelamin; nama mirip (Jaro-Winkler ≥ 0,90) + tanggal lahir | no RM + nama dari kiriman faskes (`entitas.py`) |
| Pola | rawat inap tumpang tindih, episode dipecah, kartu dipakai orang lain, jaringan pasien (telepon/alamat bersama), pasangan koder + DPJP dengan keparahan III tanpa dx sekunder | 20 modus Permenkes, graf lintas faskes, anomali SSL, model adaptif |
| Keluaran | Fix / Hold / Check dengan pemilik bernama (DPJP, admisi, tim pencegahan) | LOLOS / PERIKSA / TAHAN, kasus, permintaan dokumen |

**Yang melintas di antara keduanya, dan yang tidak:**
- RS → pusat: klaim, plus keputusan gerbangnya sebagai deklarasi (`pencegahan_faskes`: gerbang, keputusan, kunci temuan
  jaringan tanpa rincian pasien lain, nama penelaah, catatan). Deklarasi ditampilkan ke auditor di detail peristiwa
  ("Lapis 1 · pencegahan di rumah sakit") dan tidak diskor.
- Pusat → RS: tanda terima, status, permintaan dokumen, dan **pre-check kelengkapan** (`precheck.py`,
  `POST /faskes/precheck`).
- Tidak pernah ke RS: skor, keputusan, sinyal, pandangan model anomali, atau data faskes lain.

**Pre-check kelengkapan** (sebelum Submit, tanpa nama pasien):
- Dokumen yang akan dicari verifikator menurut aturan verifikasi:
  - tindakan → laporan operasi;
  - keparahan III → hasil penunjang dx sekunder;
  - naik kelas → surat pernyataan;
  - top-up → bukti pemakaian.
- Lama rawat di atas p90 kode INA-CBG-nya (`ref_kode.p90_los`, norma agregat) → CPPT.
- Dokumen yang diminta verifikator ke RS ini sendiri untuk CMG yang sama: hanya bila diminta ≥ 2 kali.
- Konflik dengan kiriman RS ini sendiri: no RM sama dengan tanggal beririsan, atau readmisi ≤ 30 hari. Kiriman yang baru
  diterima tetapi masih di antrean mesin ikut dihitung (`ACCEPTED`). Tanpanya, draf kedua yang dicek sedetik setelah
  Submit pertama lolos.
- Jawabannya tidak bergantung pada mesin fraud. Mengulang pre-check tidak membocorkan apa pun tentang penilaian klaim.
- Batas frekuensi: 60 per menit per sistem, 40 per draf per hari.
- Sumber harus terdaftar di registri faskes.
- Setiap pre-check dicatat (tabel `precheck`, medan tagihan saja). Auditor melihat berapa kali draf dicek dan apa yang
  berubah di antaranya (mis. INA-CBG III → II, lama rawat 18 → 6). Ini konteks untuk manusia, bukan sinyal: menghukum
  pemakaian pre-check akan mengajari RS untuk tidak memeriksa.

**Batas lapis 1 yang jujur:**
- Riwayat RS di demo adalah rekaman sintetis 12 bulan (RS Demo Nusantara) dengan skema tanam dan pembanding jujur,
  digabung dengan klaim tersimpan dari Kodifikasi.
- Backtest: 20/20 instans tanam tertangkap. Satu-satunya pembanding jujur yang ikut tertandai adalah readmisi karena kambuh
  1–2 hari kemudian (6/6): di klaim, kasus ini memang identik dengan episode dipecah, jadi DPJP yang memutuskan.
- Angka backtest menunjukkan perilaku pemeriksaan, bukan seberapa sering skema itu terjadi di RS sungguhan.
- Satu token ingest melayani satu sumber terdaftar (ai-jkn). Di produksi, tiap RS butuh tokennya sendiri yang terikat ke
  sumbernya.

## API (`/api/aip/realtime/v1`)

**Ingest:**
- `POST /klaim`, `/fktp`, `/nonkapitasi` (sesi/PAT)
- `POST /faskes/klaim` (header `X-Ingest-Token`, path publik di `auth.PUBLIC`; baris `obat` dan `pemeriksaan` opsional)

**Baca:**
- `GET /status`, `/umpan`, `/peristiwa/{id}`
- `GET /kasus`, `/kasus/{id}`, `/kasus/{id}/ringkasan`
- `GET /modus`, `/graf`, `/jaringan`, `/entitas/{id}`, `/evaluasi`, `/sumber`

**Active learning:**
- `GET /al`, `/al/antrean`, `/al/simulasi`
- `POST /al/ssl/latih` (body opsional `{"jenis": ["fkrtl", "fktp", "nonkap"]}`), `/al/label`, `/al/latih`, `/al/mode`, `/al/simulasi`,
  `/al/simulasi/promosikan` (admin)

**Permintaan dokumen ke faskes** (`permintaan.py`):
- `GET /peristiwa/{id}/permintaan`: apakah peristiwa ini kiriman sistem faskes, riwayat permintaan dan balasannya, serta draf
  yang disusun dari medan tidak lazim (penjelasan SSL) dan sinyal tingkat klaim, masing-masing dengan dokumen yang menjawabnya.
- `POST /peristiwa/{id}/permintaan` (admin): butir yang sudah disunting auditor.
- `POST /faskes/permintaan` (token ingest): status pemrosesan klaim faskes (diterima → diproses | ditolak) dan permintaannya.
- `POST /faskes/permintaan/{id}/balas` (token ingest): balasan faskes.
- `POST /faskes/precheck` (token ingest): pre-check kelengkapan draf sebelum Submit (lihat "Dua lapis pencegahan").
- Yang tidak pernah sampai ke faskes: skor, keputusan, sinyal, asal butir, dan identitas auditor. Ini sama dengan permintaan
  kelengkapan untuk klaim pending dalam verifikasi biasa.

**Simulator:** batch yang ditolak karena antrean mesin penuh dikirim ulang lebih dulu, tidak dibuang. Versi lama membuangnya,
sehingga pada laju 500/detik sekitar 6 ribu peristiwa (termasuk klaim tanam) hilang dari aliran.

**Admin:**
- `POST /mesin`, `/kasus/{id}/keputusan`
- `GET /bobot`, `POST /bobot/terapkan`, `/bobot/bawaan`, `GET /label` (CSV)
- `POST /simulator`, `/simulator/tanam`
- `PUT /sumber/{id}`, `POST /token`, `/box`, `/reset`

**Lokasi kode dan data:**
- Kode: `api/aip/realtime/` (mesin, graf, entitas, aturan_rt, fktp, referensi, modus, investigasi, integrasi, kontrak,
  simulator, store, routes)
- UI: `web/src/components/aip/RealtimeFraudView.tsx`
- Data: `data/aip/realtime/`

**Sisi faskes (ai-jkn):**
- `lib/faskes/audit-realtime.ts`, dipanggil `app/api/knowledge-graph/klaim` setelah klaim tersimpan. Keputusan gerbang ikut
  sebagai `pencegahan_faskes`.
- Tanda terima disimpan di `hasil.auditRealtime`.
- Lapis 1:
  - `lib/faskes/jaringan/`: `data.ts` (rekaman sintetis), `nama.ts`, `detect.ts` (entity resolution, graf, detektor,
    cek draf), `service.ts` (gabung klaim tersimpan, backtest, contoh draf);
  - `app/api/faskes/jaringan`;
  - bagian "Network check" di tab Early Prevention.
- Gerbang Submit: `app/api/faskes/early/gate` menjalankan cek jaringan dan pre-check bersamaan. Dialognya menampilkan
  "Lapis 1" dan "Lapis 2".
- Env: `AUDIT_REALTIME_URL`, `AUDIT_REALTIME_TOKEN`.

## Evaluasi

**Cara kerja replay:**
- Yang diputar: 18–31 Des 2024 edisi reguler, yaitu 52.584 klaim FKRTL, 134.807 kunjungan FKTP, dan 7.852 klaim
  nonkapitasi, berselang urut tanggal layanan.
- Jendela itu dikeluarkan dari riwayat peserta. Tiap faskes FKTP/nonkapitasi dibandingkan dengan 60 hari sebelum jendela.

**Skenario tanam:**
- 30 skenario mencakup setiap modus, dibangun dari peristiwa yang baru diputar.
- Kebenarannya disimpan terpisah dan tidak pernah menjadi input mesin.
- M18 dan M20 memakai baris obat/hasil yang dibangkitkan simulator.

**Yang dihitung tab Evaluasi:**
- instans tertangkap dan sinyal yang tepat;
- jeda deteksi;
- porsi alert pada peristiwa normal per jenis;
- lift terhadap label koreksi verifikator (FKRTL);
- efek mitigasi.

## Batas yang jujur

**Batas data:**
- Data sampel tidak memuat ID faskes asli: "faskes" adalah profil (kab/kota, kepemilikan, jenis, tipe). Unit kapitasi FKTP
  adalah kab/kota + kepemilikan + jenis (kunci yang dimiliki registri).
- Penggunaan dana kapitasi (M01), penyerahan obat (M18), dan hasil lab (M20) tidak ada di data. M01 dibaca dari proksi.
  M18/M20 (dan baris obat M17) menunggu kiriman faskes.
- Di data sintetis, tahun meninggal, jenis kelamin, dan usia peserta disintesis terpisah dari urutan klaim. Sinyal
  registri (klaim setelah meninggal, tidak cocok jenis kelamin/usia, kartu keluarga) karena itu lebih sering memicu pada
  klaim normal daripada yang wajar di data asli. Umpan balik keputusan kasus adalah mekanisme untuk menurunkan bobotnya.

**Batas evaluasi:**
- Label verifikator mengukur koreksi verifikasi, bukan fraud terbukti.
- Skenario tanam dibuat oleh simulator ini sendiri: tingkat tangkap mengukur apakah sinyal bekerja seperti dirancang,
  bukan kinerja pada fraud nyata.

**Batas implementasi:**
- Ringkasan investigasi dari templat, bukan model bahasa (tidak ada data dikirim keluar).
- Bobot dikalibrasi dari keputusan. Model ML produksi belum dilatih ulang dari label kasus (label diekspor untuk itu).
  Model adaptif dilatih ulang dari label telaah dan kasus atas perintah admin, tidak terjadwal otomatis.
