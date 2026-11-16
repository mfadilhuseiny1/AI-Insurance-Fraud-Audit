# Data Sampel BPJS Sintetis — dasar ilmiah dan metode

Dokumen ini menjelaskan bagaimana data sintetis di `Data Sintetis/2025/` dibuat, mengapa metodenya sah secara ilmiah, dan
bagaimana kualitas serta keamanannya diukur. Hasil ukurnya ada di [laporan/EVALUASI.md](laporan/EVALUASI.md).

## 1. Ringkasan satu paragraf

Data sintetis dibuat dengan **sequential CART synthesis** (Reiter 2005; Drechsler & Reiter 2011; paket `synthpop`, Nowok,
Raab & Dibben 2016), yaitu metode yang dipakai lembaga statistik resmi untuk merilis microdata tanpa membuka data asli.
Metodenya diperluas secara **hierarkis** mengikuti relasi tabel BPJS (peserta → kunjungan/klaim berurutan → diagnosis
sekunder), seperti pendekatan Synthetic Data Vault (Patki, Wedge & Veeramachaneni 2016). Kualitasnya diuji pada tiga
sumbu standar, yaitu **fidelity, utility, privacy** (Jordon et al. 2022). Setiap angka dibandingkan dengan acuan yang
adil: sampel data asli yang tidak pernah dipakai melatih (*holdout*, 20% peserta).

## 2. Kerangka ilmiah

| Pertanyaan | Landasan | Yang dipakai di sini |
|---|---|---|
| Bolehkah analisis memakai data sintetis, bukan data asli? | Rubin (1993) mengusulkan rilis data yang seluruhnya sintetis lewat *multiple imputation*. Raghunathan, Reiter & Rubin (2003) menurunkan aturan inferensinya, dan Little (1993) membahas data sintetis parsial. | Setiap nilai dibangkitkan dari distribusi bersyarat yang ditaksir dari data asli, sehingga statistik turunannya menaksir besaran yang sama. |
| Model apa yang menangkap hubungan rumit tanpa asumsi bentuk? | Reiter (2005) memakai CART untuk data sintetis. Drechsler & Reiter (2011) membandingkan CART, bagging, random forest dan SVM, dan CART memberi utility tertinggi pada risiko yang dapat diterima. | Satu pohon CART per variabel, bersyarat pada variabel sebelumnya. Nilai diambil dari *donor* di daun pohon (metode `cart` di synthpop). |
| Bagaimana dengan banyak tabel yang saling terhubung? | Patki et al. (2016), Synthetic Data Vault: model hierarkis mengikuti *primary key–foreign key*, dan jumlah anak per induk ikut dimodelkan. | Peserta disintesis lebih dulu, termasuk jumlah klaim/kunjungannya. Klaim ke-*j* bersyarat pada peserta dan klaim ke-*j−1* (rantai Markov orde 1). Diagnosis sekunder bersyarat pada klaimnya. Rujukan FKTP dibuat dari klaim yang merujuknya. |
| Bagaimana membuktikan "distribusinya menyerupai data sampel"? | General utility: pMSE dari model propensity (Woo et al. 2009; Snoke et al. 2018), rasio pMSE terhadap null permutasi. Fidelity per kolom: TVD dan Kolmogorov–Smirnov (SDMetrics, DataCebo). | 1−TVD per kolom kategori, 1−KS per kolom angka/tanggal, selisih Cramér's V antarpasangan kolom, pMSE + rasio, dan AUC diskriminator gradient boosting. |
| Apakah kesimpulan analisis tetap sama? | Specific utility: tumpang tindih confidence interval koefisien regresi (Karr et al. 2006). *Train on Synthetic, Test on Real* (TSTR, Esteban, Hyland & Rätsch 2017). | TSTR untuk label yang dipelajari app (klaim terkoreksi saat verifikasi), overlap CI dua regresi, dan korelasi peringkat aturan audit antartipe RS. |
| Apakah orang asli bisa dikenali? | Disclosure risk untuk data sintetis penuh: RepU dan DiSCO (Raab, Nowok & Dibben 2024), distance to closest record dengan baseline holdout, membership inference (Shokri et al. 2017; Stadler, Oprisanu & Troncoso 2022). Panduan pemerintah: NIST SP 800-188 (2023). | Tidak ada ID asli, exact-match vs baseline holdout, RepU, DCR vs holdout, AUC serangan keanggotaan, dan DiSCO vs baseline holdout. |
| Contoh di bidang kesehatan | Goncalves et al. (2020) membandingkan model probabilistik, imputasi berbasis klasifikasi (termasuk CART) dan GAN untuk data pasien. El Emam, Mosquera & Hoptroff (2020), *Practical Synthetic Data Generation*. | Kerangka evaluasi yang sama, diterapkan pada klaim JKN. |

### Mengapa CART, bukan GAN atau LLM?

- **Terbukti untuk microdata resmi.** CART adalah metode bawaan synthpop yang dibuat untuk studi longitudinal resmi di
  Inggris (SYLLS). Dalam evaluasi Drechsler & Reiter (2011), CART memberi utility tertinggi pada risiko yang dapat
  diterima.
- **Bisa diaudit.** Setiap nilai berasal dari kumpulan ≥ 10 rekaman asli di daun pohon yang sama. Tidak ada kotak hitam
  yang bisa menghafal satu orang.
- **Cocok dengan data klaim.** Data klaim banyak berisi kode kategori berkardinalitas tinggi (ICD-10, INA-CBG, profil
  faskes), aturan tarif, dan ketergantungan bersyarat. Pohon menangkap interaksi seperti "Klinik Utama × rawat inap ×
  keparahan" tanpa ditentukan bentuknya.
- **Berjalan lokal, tanpa biaya model dan tanpa mengirim data ke pihak lain.** Seluruh proses berjalan di mesin yang
  sama dengan data asli, menggunakan Python dan scikit-learn.

## 3. Metode, langkah demi langkah

1. **Pemisahan training/holdout.** Peserta dengan `(PSTV01 × 48271 mod (2³¹−1)) mod 5 = 0` (±20%) disisihkan. Semua
   model hanya dilatih pada 80% sisanya. Holdout dipakai sebagai pembanding yang jujur: seberapa mirip sampel asli *baru*
   dengan data latih adalah batas bawah kemiripan yang masuk akal.
2. **Per edisi.** Tujuh edisi (Reguler, COVID, DM, Kesehatan Mental, KIA-Ibu, KIA-Anak, TB) dimodelkan terpisah, karena
   penomoran kode diagnosis dan cakupan waktunya berbeda per edisi. Jumlah peserta tiap edisi sama dengan aslinya.
3. **Peserta.** Urutan variabelnya: jenis kelamin → usia (hari, tanpa digeser di dalam rantai) → segmen → hubungan keluarga → status kawin → kelas →
   lokasi. Lokasi berupa satu *tuple donor* (kab/kota tinggal, kepemilikan dan jenis FKTP terdaftar, kab/kota FKTP),
   sehingga kombinasinya selalu ada di dunia nyata. Setelah itu tahun sampel, status, tahun meninggal, bobot, lalu
   **ringkasan anak**: jumlah klaim FKRTL, pernah rawat inap, huruf bab ICD-10 utama, jumlah kunjungan FKTP, dan jumlah
   kunjungan nonkapitasi.
4. **Klaim FKRTL berurutan.** Klaim ke-*j* disintesis bersyarat pada peserta dan klaim ke-*j−1*. Urutan variabelnya:
   - tanggal (hari pertama atau jeda dari klaim sebelumnya);
   - tingkat layanan;
   - apakah RS sama dengan klaim sebelumnya; bila tidak, apakah RS ada di kab/kota FKTP terdaftar (donor lokal di kab/kota
     itu), atau di tempat lain (tuple donor CART: kab/kota, kepemilikan, jenis, tipe);
   - poli, segmen, kelas, LOS dan status pulang;
   - diagnosis utama (sama dengan sebelumnya atau donor baru), lalu diagnosis masuk;
   - INA-CBG, regional tarif, special CMG, prosedur dan jumlah diagnosis sekunder;
   - status rujukan (tidak ada, sama dengan klaim sebelumnya, atau baru) beserta jedanya, lalu faskes perujuk;
   - apakah tagihan berbeda dari tarif, lalu **apakah klaim dikoreksi verifikator** beserta rasionya.

   Peristiwa langka, yaitu koreksi verifikasi (0,03–0,17%) dan tagihan di luar tarif, memakai pohon dengan bobot kelas
   seimbang untuk *mencari* daun berisiko. Donornya tetap diambil dengan bobot asli, sehingga laju di tiap daun tetap
   laju empiris.
5. **Kolom deterministik diturunkan, tidak disintesis.** Di data asli, kolom-kolom berikut merupakan fungsi dari kolom
   lain, dengan kecocokan 99,6–100% terhadap modus:
   - provinsi ← kab/kota;
   - ICD-10 3 digit ← kode rinci, dan nomor kode edisi ← ICD-10;
   - nama diagnosis ← kode;
   - deskripsi dan digit INA-CBG ← kode INA-CBG;
   - deskripsi special CMG ← kodenya.

   **Tarif INA-CBG** diambil dari tabel tarif (kode × regional × kelas × kepemilikan × tipe × tahun, cocok 96,7%), dan
   top-up special CMG dari kode × regional × tipe (99,4%). **Biaya tagih** = tarif + top-up (× rasio sintetis bila klaim
   ditandai di luar tarif). **Biaya verifikasi** = biaya tagih, atau biaya tagih × rasio koreksi bila klaim ditandai
   terkoreksi.
6. **Kunjungan FKTP rujukan** dibuat satu per rujukan baru, bersyarat pada klaim yang merujuknya: profil FKTP,
   diagnosis, dan tujuan rujukan. **Kunjungan FKTP lain** disintesis berurutan per peserta seperti klaim.
   **Nonkapitasi** disintesis per kunjungan, lalu per tindakan. **Diagnosis sekunder** disintesis per klaim, tanpa kode
   kembar dalam satu klaim.
7. **Identitas baru.**
   - Nomor peserta dan keluarga diambil acak di rentang int32, **di luar himpunan nomor asli**.
   - ID kunjungan berupa `SYN` + 13 karakter base-36, unik secara konstruksi (tidak ada ID asli yang berawalan `SYN`).
   - Keluarga dibentuk dari distribusi ukuran keluarga asli, di dalam kab/kota, segmen dan kelas yang sama.
   - Anak di edisi KIA-Anak ditautkan ke ibu sintetis di KIA-Ibu dengan proporsi tautan yang sama seperti aslinya.
8. **Format sama persis.** Hasilnya ditulis sebagai file Stata `.dta` dengan nama file, urutan kolom, tipe penyimpanan,
   label variabel dan buku label nilai yang sama. Dengan begitu pipeline app (`bronze.py` → Pipeline Builder → Nexus →
   ML → Swarm) membaca data sintetis **tanpa perubahan kode**. Buku kode ICD-10 per edisi (kode dan nama WHO, bukan data
   orang) ikut disalin.

## 4. Pengaman privasi yang dibangun ke dalam metode

| Pengaman | Rujukan |
|---|---|
| Fully synthetic: setiap sel dibangkitkan dari model, tidak ada baris asli yang disalin utuh. | Rubin 1993; Raghunathan et al. 2003 |
| Daun CART minimal 10 rekaman, sehingga setiap nilai diambil dari kumpulan ≥ 10 orang asli. | min-bucket synthpop |
| Kategori yang muncul < 5 kali di data latih (kode diagnosis langka, teks prosedur, profil faskes) tidak pernah keluar. | global recoding / suppression (SDC) |
| Tanggal lahir yang dirilis digeser acak ±30 hari, kecuali tanggal "menumpuk" (hari dalam setahun dengan frekuensi > 3× rata-rata di data asli, seperti tanggal pengganti), yang dipakai ribuan orang sehingga tidak mengidentifikasi. Penggeseran dilakukan **setelah** semua model, supaya struktur data tidak rusak (lihat catatan di bawah). | smoothing quasi-identifier (synthpop) |
| *Replicated uniques*: peserta sintetis yang tanggal lahir, jenis kelamin, kab/kota dan segmennya sama dengan orang yang **unik** pada kunci itu di data latih, tanggal lahirnya digeser 31–120 hari sampai tidak sama lagi. | `sdc(rm.replicated.uniques)` synthpop; Raab et al. 2024 |
| Nomor peserta, keluarga dan kunjungan dibuat baru dan dijamin tidak sama dengan nomor asli mana pun. | — |
| Model yang dilatih tidak disimpan, dan tidak ada data asli yang ditulis ke folder ini. | — |

**Catatan dari uji coba (mengapa urutan itu penting).** Pada versi pertama, tanggal lahir digeser di dalam rantai model,
sebelum segmen kepesertaan diambil. Di edisi Reguler hal ini menggeser segmen 2 dari 30,7% menjadi 19,5%, dan jumlah
klaim FKRTL ikut naik 9,7%. Penyebabnya: tanggal lahir di data asli menumpuk di beberapa tanggal tertentu, dan segmen
mengikuti pola itu. Usia yang sudah digeser jatuh ke daun pohon yang salah. Setelah penggeseran dipindahkan ke tahap rilis
(dan tanggal yang menumpuk dibiarkan), segmen sintetis kembali 30,7%. Inilah alasan setiap versi diukur ulang dengan
evaluasi di §5, bukan dianggap benar.

Perbaikan lain hasil evaluasi:
- **Target bantu tuple faskes.** Pohon untuk tuple faskes (RS, perujuk, tujuan rujukan) kini ditumbuhkan pada gabungan
  "jenis faskes | provinsi", bukan provinsi saja. Dengan provinsi saja, rujukan sintetis sempat berasal dari jenis faskes
  yang di data asli tidak pernah merujuk.
- **Jendela tanggal.** Klaim yang jatuh di luar jendela tanggal edisi diundi ulang dengan donor lain (sampai tiga kali)
  sebelum urutan klaim peserta itu dihentikan.
- **Lokalitas faskes (donor lokal).** Pada versi awal, lokalitas faskes terjaga di tingkat provinsi tetapi hilang di
  tingkat kab/kota:

  | Ukuran | Asli | Versi awal |
  |---|---|---|
  | Kunjungan FKTP di kab/kota FKTP terdaftar | 97% | 19% |
  | RS di kab/kota tempat tinggal | 69% | 27% |
  | Rujukan dalam kab/kota yang sama | 85% | 19% |

  Kini lokasi faskes dimodelkan seperti pola "sama dengan sebelumnya":
  1. Satu langkah biner memutuskan apakah faskes ada di kab/kota FKTP terdaftar peserta.
  2. Bila ya, tuple faskes (kepemilikan, jenis, tipe) diambil dari donor nyata **di kab/kota itu** dengan konteks yang sama
     (misalnya tingkat layanan, atau jenis FKTP terdaftar), dengan back-off ke kab/kota saja.
  3. Bila tidak, dipakai pohon CART.

  Pola ini diterapkan untuk RS, faskes perujuk, FKTP, dan kunjungan rujukan. Untuk nonkapitasi tetap dipakai CART, karena
  donor lokal di sana menggeser campuran jenis faskes dan menambah baris tindakan 28%.
- **Rujukan dipakai ulang.** Satu rujukan melayani beberapa klaim, dan tidak selalu berurutan. Status rujukan kini
  dibedakan menjadi "rujukan yang sudah pernah dipakai peserta" vs "rujukan baru", dan pemakaian ulang hanya untuk klaim di
  kab/kota RS yang sama. Sebelumnya kunjungan rujukan sintetis 28–56% terlalu banyak.

- **Uji utility menangkap bug yang lolos dari uji kemiripan.** Satu versi antara mengubah tipe kolom jenis/tipe RS menjadi
  teks di data latih, sehingga pohon-pohon sesudahnya tidak lagi "melihat" jenis faskes. Kemiripan per kolom tetap tampak
  baik (1−TVD ≈ 0,98), tetapi TSTR untuk label koreksi verifikasi jatuh dari AUPRC 0,84 ke 0,01. Bug diperbaiki dan semua
  edisi dibangkitkan ulang. Pelajarannya: kemiripan distribusi saja tidak cukup; utility harus diuji pada tugas yang
  sesungguhnya.

Batasan yang perlu jujur disampaikan: metode ini **bukan differential privacy**. Jaminannya empiris, yaitu diukur
dengan uji di §5, bukan bukti matematis. Stadler et al. (2022) menunjukkan bahwa data sintetis tidak otomatis anonim,
karena itulah risikonya diukur, bukan diasumsikan. Bila kelak dibutuhkan jaminan formal, metode DP seperti MST/AIM
(McKenna et al.) bisa dipakai dengan konsekuensi utility turun.

## 5. Cara mengukur (lihat laporan/EVALUASI.md)

- **Fidelity**
  - 1−TVD per kolom kategori dan 1−KS per kolom angka/tanggal, selalu berdampingan dengan nilai yang sama untuk holdout
    asli.
  - Selisih rata-rata Cramér's V antarpasangan kolom klaim.
  - pMSE (CART), rasio pMSE terhadap null permutasi, dan AUC diskriminator gradient boosting. AUC 0,5 berarti data
    sintetis tidak bisa dibedakan dari data asli.
  - Relasional: jumlah klaim/kunjungan per peserta, diagnosis sekunder per klaim, % klaim dengan rujukan, median jeda
    rujukan, readmisi ≤ 30 hari, klaim ganda, dan % koreksi verifikasi.
- **Utility**
  - TSTR: random forest dilatih pada data sintetis, diuji pada klaim holdout asli, lalu dibandingkan dengan model yang
    dilatih pada data asli. Ukurannya AUROC/AUPRC dengan CI bootstrap.
  - Overlap CI regresi logistik rawat inap dan regresi log biaya tagih.
  - Korelasi Spearman laju aturan audit per tipe RS.
- **Privacy**
  - Jumlah ID asli yang ditemukan di data sintetis (harus 0).
  - % exact match terhadap data latih, sintetis vs holdout.
  - RepU.
  - DCR, yaitu jarak ke rekaman asli terdekat, sintetis vs holdout.
  - AUC serangan keanggotaan berbasis jarak (0,5 berarti tidak bocor).
  - DiSCO, sintetis vs holdout.

## 6. Batasan yang diketahui

- Dirilis **satu** salinan sintetis (m = 1). Aturan inferensi Raghunathan, Reiter & Rubin (2003) untuk confidence interval
  yang benar memakai beberapa salinan (m > 1). Jadi taksiran titik dari data ini bisa dipakai, tetapi ketidakpastiannya
  akan sedikit terlalu sempit kalau dihitung seolah-olah data asli. Salinan tambahan bisa dibuat dengan `config.SEED`
  yang lain.
- Peserta yang sama di dua edisi (±1% di data asli) tidak dimodelkan. Edisi sintetis saling lepas, sehingga
  `jumlah_edisi` selalu 1.
- Keluarga dibentuk secara pengelompokan dan tidak memeriksa konsistensi usia antaranggota.
- Kunjungan FKTP dan klaim FKRTL milik peserta yang sama terhubung lewat ringkasan peserta (bab ICD-10 utama) dan lewat
  rujukan, bukan lewat riwayat penyakit lengkap.
- Data sintetis memodelkan pola yang ada di data latih. Pola yang tidak ada (fraud jenis baru) tidak muncul dengan
  sendirinya.
- Angka absolut (total biaya, jumlah klaim berisiko) mendekati, tetapi tidak sama dengan, angka asli. **Jangan melaporkan
  angka dari data sintetis sebagai angka BPJS.**

## 7. Pustaka

- Alaa, A., van Breugel, B., Saveliev, E., & van der Schaar, M. (2022). How Faithful is your Synthetic Data?
  Sample-level Metrics for Evaluating and Auditing Generative Models. *ICML*, PMLR 162, 290–306.
- Drechsler, J., & Reiter, J. P. (2011). An empirical evaluation of easily implemented, nonparametric methods for
  generating synthetic datasets. *Computational Statistics & Data Analysis*, 55(12), 3232–3243.
- Dove, I., Bates, A., Turner, A., & Špakulová, I. (2019). Synthetic data pilot. *ONS Methodology Working Paper Series*
  No. 16.
- El Emam, K., Mosquera, L., & Hoptroff, R. (2020). *Practical Synthetic Data Generation*. O'Reilly.
- Esteban, C., Hyland, S. L., & Rätsch, G. (2017). Real-valued (Medical) Time Series Generation with Recurrent
  Conditional GANs. arXiv:1706.02633.
- Goncalves, A., Ray, P., Soper, B., Stevens, J., Coyle, L., & Sales, A. P. (2020). Generation and evaluation of
  synthetic patient data. *BMC Medical Research Methodology*, 20, 108.
- Jordon, J., Szpruch, L., Houssiau, F., Bottarelli, M., Cherubin, G., Maple, C., Cohen, S. N., & Weller, A. (2022).
  Synthetic Data — what, why and how? arXiv:2205.03257 (laporan untuk The Royal Society).
- Karr, A. F., Kohnen, C. N., Oganian, A., Reiter, J. P., & Sanil, A. P. (2006). A framework for evaluating the utility
  of data altered to protect confidentiality. *The American Statistician*, 60(3), 224–232.
- Little, R. J. A. (1993). Statistical analysis of masked data. *Journal of Official Statistics*, 9(2), 407–426.
- National Institute of Standards and Technology (2023). *De-Identifying Government Datasets: Techniques and
  Governance*. NIST SP 800-188.
- Nowok, B., Raab, G. M., & Dibben, C. (2016). synthpop: Bespoke Creation of Synthetic Data in R. *Journal of
  Statistical Software*, 74(11).
- Patki, N., Wedge, R., & Veeramachaneni, K. (2016). The Synthetic Data Vault. *IEEE DSAA*.
- Raab, G. M., Nowok, B., & Dibben, C. (2024). Practical privacy metrics for synthetic data. arXiv:2406.16826.
- Raghunathan, T. E., Reiter, J. P., & Rubin, D. B. (2003). Multiple imputation for statistical disclosure limitation.
  *Journal of Official Statistics*, 19(1), 1–16.
- Reiter, J. P. (2005). Using CART to generate partially synthetic public use microdata. *Journal of Official
  Statistics*, 21(3), 441–462.
- Rubin, D. B. (1993). Statistical disclosure limitation. *Journal of Official Statistics*, 9(2), 461–468.
- Shokri, R., Stronati, M., Song, C., & Shmatikov, V. (2017). Membership Inference Attacks Against Machine Learning
  Models. *IEEE S&P*.
- Snoke, J., Raab, G. M., Nowok, B., Dibben, C., & Slavkovic, A. (2018). General and specific utility measures for
  synthetic data. *JRSS Series A*, 181(3), 663–688.
- Stadler, T., Oprisanu, B., & Troncoso, C. (2022). Synthetic Data – Anonymisation Groundhog Day. *USENIX Security*,
  1451–1468.
- Woo, M.-J., Reiter, J. P., Oganian, A., & Karr, A. F. (2009). Global measures of data utility for microdata masked for
  disclosure limitation. *Journal of Privacy and Confidentiality*, 1(1).
