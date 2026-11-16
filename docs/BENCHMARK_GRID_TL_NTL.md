# Benchmark: Jurnal & Teknologi untuk Grid Management, Susut Teknis (TL) dan Non-Teknis (NTL)

Versi 2 · 2026-10-15 · melengkapi [ANALISIS_DEMO_GRID_E2E.md](ANALISIS_DEMO_GRID_E2E.md)
Data peta: [demo-grid/jabar_transmisi_osm.geojson](demo-grid/jabar_transmisi_osm.geojson) (OpenStreetMap, ODbL)

---

## 0. Ringkasan eksekutif

1. **Skala masalah.**
   - **Indonesia:** susut PLN turun dari 10,58% (2014) ke 8,63% (2023). Untuk 2024, PLN melaporkan 8,55% (sasaran
     8,51%).
   - **UID Jawa Barat:** menjual 61.637 GWh ke 17,56 juta pelanggan pada 2024. Dengan asumsi eksplisit di §2.3,
     **setiap 1 poin persen susut di Jabar ≈ 670 GWh ≈ Rp 1 triliun per tahun**.
   - **Brasil 2025:** ANEEL mencatat susut 90,2 TWh (14,3% energi yang masuk ke jaringan distribusi), dibagi hampir
     rata antara TL (7,2%) dan NTL (7,1%).
2. **Literaturnya matang. Dari situ demo mengambil enam pelajaran:**
   - label hasil inspeksi bias;
   - kelasnya sangat tidak seimbang;
   - metrik yang benar adalah nilai uang, bukan akurasi;
   - data tiga fasa membuka deteksi untuk pelanggan industri;
   - topologi jaringan (neraca trafo/penyulang) adalah sinyal yang kuat;
   - model yang sederhana dan bisa dijelaskan sering lebih berguna daripada deep learning yang mahal.
3. **Teknologi komersial terbagi dalam tiga pola:**
   - analitik data meter (Siemens, Landis+Gyr, C3 AI, Bidgely);
   - deteksi di meter/edge (Itron);
   - platform keputusan berbasis ontologi (Palantir).

   Tidak satu pun yang sekaligus menggabungkan SCADA, AMI, billing, GIS, dan hasil P2TL ke dalam satu lingkaran
   keputusan yang bisa diaudit. Itulah posisi BluesandAI.
4. **Pencurian industri & lembaga.**
   - Dari jumlah kasus, NTL Brasil terkonsentrasi di tegangan rendah. ANEEL bahkan mengukur NTL terhadap pasar
     tegangan rendah.
   - Dari nilai per kasus dan kecanggihan modus, pelanggan besar (Grupo A, ≥ 2,3 kV) jauh lebih berat.
   - Klaim bahwa "kerugian terbesar dari industri & lembaga" **belum saya temukan di sumber primer**.
   - Desain demo tetap menangkapnya lewat prioritas berbasis nilai.
5. **Peta Jabar dari data nyata (OSM), dengan kualitas data yang terukur.** Koordinat GI Kawasan NUSAGRID jatuh 0,6 km
   dari Kawasan Industri Jababeka 2. Karena itu kawasan pilot harus diberi nama fiktif (§7.4).

---

## 1. Metodologi dan tingkat keyakinan

| Label | Arti |
|---|---|
| **[DOI]** | metadata dicek ke Crossref (judul, penulis, jurnal, volume, halaman) |
| **[Resmi]** | sumber pemerintah, regulator, atau perusahaan yang bersangkutan |
| **[Sekunder]** | media atau repositori yang mengutip sumber resmi |
| **[Vendor]** | klaim pemasaran atau studi kasus vendor, tidak diverifikasi independen |
| **[Lemah]** | satu sumber non-resmi (mis. unggahan LinkedIn); hanya untuk konteks |
| **[Asumsi]** | perhitungan saya dengan asumsi yang disebutkan |

Koreksi atas versi 1: makalah Buzau dkk. terbit 2019 (TSG 10(3)), bukan 2018. Lima rujukan yang di versi 1 bertanda
"belum diverifikasi" sekarang sudah dicek DOI-nya.

---

## 2. Konteks angka

### 2.1 Indonesia

| Data | Nilai | Label |
|---|---|---|
| Susut jaringan PLN | 10,58% (2014) → 8,63% (2023) | [Resmi] ESDM |
| Susut jaringan PLN 2024 | 8,55% realisasi vs sasaran 8,51% | [Sekunder] RRI, Koran Jakarta (pernyataan PLN) |
| UID Jabar, penjualan | 61.637 GWh (2024) → 63.503 GWh (2025, +3%) | [Sekunder] Pikiran Rakyat (laporan PLN UID Jabar) |
| UID Jabar, pelanggan | 17.563.127 (2024) → 18.143.215 (Des 2025, +3,3%) | [Sekunder] idem |
| UID Jabar, organisasi | 17 UP3, 92 ULP; UP3 Cikarang, Bekasi, Karawang, Purwakarta terkonfirmasi namanya | [Lemah] skripsi UMN; [Sekunder] laporan banjir |
| Aturan P2TL | Peraturan Direksi PLN 0028.P/DIR/2023, disahkan DJK lewat Kepdirjen 539.K/TL.04/DJL.3/2023 (27 Sep 2023); menggantikan 088-Z.P/DIR/2016 | [Resmi] ESDM; [Sekunder] Antara |
| Golongan P2TL | P-I: memengaruhi batas daya · P-II: memengaruhi pengukuran energi · P-III: keduanya · P-IV: dilakukan bukan pelanggan | [Sekunder] |
| AMI PLN | tahap 1: 1,2 juta meter AMI di 8 wilayah (2023–2024); Itron menyuplai >1 juta meter prabayar | [Lemah] LinkedIn; [Vendor] Itron |
| RUPTL 2025–2034 | +69,5 GW pembangkit nasional, Jawa-Madura-Bali +33,5 GW; ±47.758 kms transmisi, 107.950 MVA gardu induk | [Resmi] ESDM |

Rumus tagihan susulan per golongan di Perdir 0028/2023 **tidak saya temukan teks resminya**. Demo jangan menuliskan
rumusnya sebelum ada salinan peraturan.

### 2.2 Brasil (pembanding paling relevan: negara berkembang besar, regulator yang transparan)

| Data | Nilai | Label |
|---|---|---|
| Susut distribusi 2025 | 90,2 TWh = 14,3% energi yang masuk ke jaringan distribusi; TL 45,2 TWh (7,2%), NTL 45,0 TWh (7,1%) | [Sekunder] Cenário Energia (laporan ANEEL) |
| Biaya 2024 | NTL ≈ R$ 10,3 miliar; TL ≈ R$ 11,2 miliar; TL jaringan dasar ≈ R$ 1,5 miliar | [Resmi] ANEEL |
| Biaya NTL 2025 | riil R$ 11,5 miliar; diakui di tarif R$ 7,9 miliar (3,1% pendapatan yang diizinkan); selisih R$ 3,58 miliar tidak boleh diteruskan ke tarif (*glosa*) | [Sekunder] |
| Konsentrasi | 10 distributor = 74% NTL; Light (RJ) + Amazonas Energia = 34,1% | [Resmi] ANEEL |
| Metodologi | NTL dihitung terhadap **pasar tegangan rendah**; batas regulasi lewat perbandingan antar-distributor di area yang sebanding (PRORET, PRODIST modul 7); sejak 2025 dasar perhitungannya pasar terukur, bukan pasar tertagih (dampak PLTS atap) | [Sekunder] |
| Grupo A | pelanggan yang tersambung ≥ 2,3 kV (tegangan menengah/tinggi) | [Resmi] ANEEL REN 1000 |

### 2.3 Nilai susut di Jawa Barat (ilustrasi)

[Asumsi] susut Jabar = rata-rata nasional 8,55%, dan biaya energi Rp 1.450/kWh (kira-kira tarif rata-rata).
Keduanya **asumsi**, bukan data PLN Jabar.

- Energi yang hilang ≈ penjualan × s / (1 − s) = 61.637 × 0,0855 / 0,9145 ≈ **5.760 GWh/tahun** ≈ **Rp 8,4 triliun**.
- Energi yang disalurkan ≈ 61.637 / 0,9145 ≈ 67.400 GWh, sehingga setiap 1 poin persen susut ≈ **674 GWh** ≈ **Rp 0,98 triliun/tahun**.

Gunakan angka ini sebagai "skala taruhan" di demo, dengan keterangan asumsinya.

---

## 3. Benchmark jurnal (DOI terverifikasi)

### 3.1 Survei dan kajian sistematis

| Rujukan | Pokok | Untuk demo |
|---|---|---|
| Glauner, Meira, Valtchev & State (2017), IJCIS 10:760 [DOI 10.2991/ijcis.2017.10.1.51] | taksonomi NTL (pencurian, meter rusak, salah tagih); NTL bisa mencapai 40% di sebagian negara | taksonomi penyebab |
| Viegas, Esteves, Melício & Mendes (2017), RSER 80:1256–1268 [DOI 10.1016/j.rser.2017.05.193] | 103 studi: 25 hardware, 72 non-hardware; belum ada solusi tunggal | gabungkan aturan + ML + bukti |
| Messinis & Hatziargyriou (2018), EPSR 158:250–266 [DOI 10.1016/j.epsr.2018.01.005] | metode berbasis data, berbasis jaringan, hybrid | arsitektur hybrid |
| Chuwa & Wang (2021), EPSR 199:107415 [DOI 10.1016/j.epsr.2021.107415] | model serangan NTL + metode deteksi | katalog pola sintetis |
| Guarda dkk. (2023), Energies 16:2054 [DOI 10.3390/en16042054] | metode non-hardware: jaringan / data / hybrid | idem |
| Stracqualursi dkk. (2023), RSER 184:113544 | kajian sistematis praktik pencurian + deteksi AI | katalog modus |
| Nayak & Jaidhar (2025), Applied Intelligence | kajian sistematis model berbasis data, privasi, dataset | pembanding terkini |
| Rahaman & Idris (2026), Jurnal Teknologi (PRISMA, 50 studi 2012–2024) | **hanya 28% studi mempertimbangkan skalabilitas nyata; 54% kurang kuat metrik evaluasinya**; sarankan model hybrid yang bisa dijelaskan | alasan demo menekankan operasional + metrik bisnis |

### 3.2 Deteksi NTL: metode dan pelajaran

| Rujukan | Data | Metode | Pelajaran untuk demo |
|---|---|---|---|
| Glauner dkk. (2016), ISGT; arXiv 1602.08350 | **Brasil**: 3,6 juta pelanggan, 820 rb hasil inspeksi | fitur konsumsi + master data, kelas tidak seimbang | hasil inspeksi = label (padanan P2TL) |
| Glauner dkk. (2017), ISAP; arXiv 1702.03767 | data yang sama | **covariate shift**: inspeksi terkumpul di lingkungan dan golongan tertentu, sehingga model mewarisi bias | porsi inspeksi acak; tampilkan peta bias inspeksi |
| Jokar, Arianpoo & Leung (2016), IEEE TSG 7:216–226 [DOI 10.1109/TSG.2015.2425222] | AMI | 6 fungsi serangan sintetis + detektor pola (SVM) | resep injeksi pola pencurian |
| Zheng, Yang, Niu & Dai (2018), IEEE TII 14:1606–1615 [DOI 10.1109/TII.2017.2785963] | **SGCC** | Wide & Deep CNN, matriks minggu × hari | baseline deep learning; tampilan matriks mingguan |
| Punmiya & Choe (2019), IEEE TSG 10:2326–2329 [DOI 10.1109/TSG.2019.2892595] | AMI | gradient boosting + rekayasa fitur | baseline GBM cepat |
| Buzau dkk. (2019), IEEE TSG 10:2661–2670 [DOI 10.1109/TSG.2018.2807925] | **Endesa (Spanyol)** | XGBoost atas konsumsi, event, master data | model berlabel utama |
| Buzau dkk. (2020), IEEE TPWRS 35:1254–1263 [DOI 10.1109/TPWRS.2019.2943115] | Endesa | hybrid LSTM + MLP | pembanding deep learning |
| Coma-Puig & Carmona (2019), Energies 12:1748 [DOI 10.3390/en12091748] | **Naturgy (Spanyol)** | sistem NTL produksi | integrasi ke operasi |
| Calvo, Coma-Puig, Carmona & Arias (2020), Energies 13:5674 [DOI 10.3390/en13215674] | Naturgy | segmentasi berbasis pengetahuan untuk akurasi + penjelasan | model per segmen (rumah tangga / bisnis / industri / lembaga) |
| **Massaferro, Di Martino & Fernández (2020), IEEE TPWRS 35:703–710** [DOI 10.1109/TPWRS.2019.2928276] | **UTE (Uruguay)** | kerangka risiko Bayesian: pendapatan yang dipulihkan vs biaya inspeksi; prioritas jangka pendek dan rencana anggaran | **dasar prioritas berbasis nilai** |
| Massaferro dkk. (2022), IEEE TSG 13:2381–2389 | UTE | deteksi saat **transisi ke meter pintar**, memakai data multi-resolusi (bulanan + interval) | sangat relevan: AMI PLN belum menyeluruh |
| Acevedo, Massaferro, Fernández & Martins (2023), ISGT [DOI 10.1109/ISGT51731.2023.10066346] | UTE | log event meter dengan LSTM + gradient boosting | fitur event meter |
| **Taruna, Arisona, Irwanto, Bestari & Juniawan (2025), IEEE Access 13** [DOI 10.1109/ACCESS.2025.3526764] | **PLN (Indonesia)**: pelanggan pascabayar 450 VA bermeter tradisional (tanpa AMI) | 6 model klasifikasi; Random Forest terbaik; **penyaringan sekuensial** model 3-pola → 2-pola → 1-pola (RF+KNN: akurasi 0,89, presisi 0,83, recall 0,98, F1 0,90, AUC 0,89) untuk membentuk daftar **Target Operasi (TO)** | padanan nyata antrean target P2TL demo untuk pelanggan tanpa AMI; skor per jam AMI (sesi 5.2) menjadi peringatan dini ke antrean yang sama. PDF: `paper_reference/` (properti pengguna) |
| Pengwah, Razzaghi & Andrew (2023), IEEE TPWRD 38:3469–3479 [DOI 10.1109/TPWRD.2023.3280551] | tegangan meter pintar LV | deteksi tanpa model jaringan memakai sensitivitas tegangan | fitur fisika: tegangan tidak cocok dengan kWh |
| De Meulemeester dkk. (2025), dipakai di demo JKN | — | anomali tanpa label yang bisa dijelaskan (Shapley) | NTL tanpa label |

### 3.3 Industri / tiga fasa dan topologi

| Rujukan | Isi | Untuk demo |
|---|---|---|
| Bai dkk. (2024), Sensors 24:6057 [DOI 10.3390/s24186057] | deteksi pencurian **tiga fasa**: Catch22 + Conv-Transformer atas tegangan fasa, arus, PF; data State Grid; Dice loss untuk kelas minoritas | fitur NTL-07 (CT/PT) |
| EPSR 2025 (S0378779625000951), mengutip eksperimen sebelumnya | manipulasi terminal CT fasa menaikkan selisih tertimbang arus fasa vs netral dari ±0,35% ke 70%; bypass fasa + netral bersamaan tidak memberi sinyal itu | tanda khas CT, plus batasnya |
| Zhuang dkk. (2024), IEEE Access [DOI 10.1109/ACCESS.2024.3379201] | graph convolution residual dinamis untuk deteksi pencurian | baseline graf |
| Oguntola dkk. (2026), arXiv 2603.20488 (pra-cetak) | LSTM-AE + RF + **GNN atas topologi distribusi**, fitur drop tegangan dan indeks ketidakseimbangan jaringan | arah GNN atas graf Nexus |

**Celah riset yang bisa dimanfaatkan demo:** saya tidak menemukan karya yang secara eksplisit memakai **neraca energi
trafo/penyulang sebagai sinyal inti di dalam model graf**. Demo bisa menunjukkan hal ini secara langsung karena Nexus
sudah menyimpan graf GI → penyulang → DT → pelanggan, dan SCADA memberi kWh di simpul atasnya.

### 3.4 Estimasi susut teknis

| Rujukan | Isi | Untuk demo |
|---|---|---|
| Velasco, Amaris & Alonso (2020), IJEPES 121:106054 [DOI 10.1016/j.ijepes.2020.106054] | model susut LV berbasis deep learning, divalidasi di Madrid; cukup cepat untuk real-time | TL per DT |
| Telford, Stephen, Browell & Haben (2021), IEEE TPWRD 36:2676–2686 [DOI 10.1109/TPWRD.2020.3025125] | kapasitas dan susut LV dengan cakupan meter **parsial** (GMM sampel Dirichlet); unggul saat hanya 10–50% pelanggan bermeter pintar | realistis untuk Jabar |
| NUSAGRID `loadflow.ts`, `energy.ts` | load flow radial/mesh, neraca hierarki meter | mesin fisika demo |

### 3.5 Dataset publik

| Dataset | Isi | Catatan |
|---|---|---|
| **SGCC** (State Grid Corporation of China) | 42.372 pelanggan, konsumsi harian 1.035 hari (1 Jan 2014 – 31 Okt 2016), ±8,5% berlabel pencuri, ±25% nilai hilang | standar de facto; berguna untuk menguji pipeline ML demo sebelum data sintetis |
| Irlandia CER smart meter trial | interval 30 menit (dipakai Jokar dkk.) | pola serangan disuntikkan |

---

## 4. Benchmark teknologi

### 4.1 Profil

| Teknologi | Pola | Fakta & klaim | Label |
|---|---|---|---|
| **Palantir Foundry: grid digital twin** | ontologi + keputusan | Utilitas Eropa: aset jaringan dari sistem kontrol PSI + GIS digabung jadi objek ontologi ("puluhan ribu koordinat, jaringan, kabel, sirkuit, relasi"). Ada writeback ke kedua sistem. Aplikasi Slate menebak lokasi penyebab gangguan. Konteks regulasi: target SAIDI Jerman < 12 menit/pelanggan. Ontologi awal butuh ±12 bulan, lalu dijadikan pustaka yang bisa dipasang "dalam hitungan minggu". Tidak ada angka hasil | [Resmi] dokumentasi Palantir |
| Palantir × PG&E (2021) | ontologi + keputusan | gambaran operasional terpadu untuk program pemadaman preventif (PSPS), lalu risiko aset dan investigasi gangguan | [Sekunder] |
| **C3 AI Fraud Detection × Enel** | analitik NTL | 20 juta meter Italia + Spanyol, 7 sistem sumber, 22 integrasi, 500+ fitur. **Prioritas = besarnya energi yang bisa dipulihkan × peluang fraud**. Energi pulih per inspeksi +70% (Italia), >300% (Spanyol) | [Vendor] |
| Siemens Gridscale X MDM Revenue Protection (d/h EnergyIP) | analitik data meter | 70+ algoritme atas data meter + aset; otomasi kasus | [Vendor] |
| Landis+Gyr Advanced Grid Analytics | analitik data meter | konsumsi + event meter + cuaca | [Vendor] |
| Itron Distributed Intelligence | edge | analisis impedansi tiap detik untuk mendeteksi bypass; klaim akurasi hingga 300% lebih baik daripada sistem AMI murni | [Vendor] |
| Bidgely (playbook) | analitik data meter | sebagian besar modus manipulasi **tidak tertangkap andal oleh alarm tamper meter**, yang juga sering memberi alarm palsu; gabungkan arus fasa/netral, tegangan, PF, event | [Vendor] |
| GE Vernova GridOS | ADMS/EMS | satu lingkungan keputusan, rantai GIS → ADMS | [Resmi] (dari dokumen NUSAGRID) |
| NUSAGRID SCADA | SCADA OT (internal) | CIM-lite, IEC 104/Modbus/MQTT, ISA-18.2, load flow, FLISR, anomali | internal |

### 4.2 Matriks kemampuan (penilaian saya dari bahan di atas)

● kuat · ◐ sebagian · ○ tidak terlihat dari sumber

| Kemampuan | Palantir | C3/Enel | Siemens | L+G | Itron | BluesandAI (target demo) |
|---|---|---|---|---|---|---|
| Integrasi banyak sistem (SCADA, AMI, billing, GIS) | ● | ● (7 sistem) | ◐ | ◐ | ○ | ● |
| Model jaringan / topologi sebagai objek | ● | ○ | ◐ | ○ | ○ | ● (Nexus) |
| Skor NTL berbasis ML | ◐ (dibangun pengguna) | ● | ● | ● | ◐ | ● |
| Prioritas berbasis nilai | ○ | ● | ○ | ○ | ○ | ● |
| Deteksi di meter (edge) | ○ | ○ | ○ | ○ | ● | ○ (fitur dari edge nanti) |
| Estimasi susut teknis | ◐ | ○ | ○ | ○ | ○ | ● (load flow NUSAGRID) |
| Keputusan tertulis balik + label kembali ke model | ● | ◐ | ◐ (kasus) | ○ | ○ | ● |
| Tata kelola (marking, purpose, audit) | ● | ◐ | ○ | ○ | ○ | ● |

---

## 5. Pencurian industri & lembaga

### 5.1 Bukti

| Temuan | Label |
|---|---|
| Abradee: pencurian terutama di pasar tegangan rendah (rumah, komersial kecil, kantor, industri kecil), dihitung dari jumlah kasus dan volume. ANEEL mengukur NTL terhadap pasar tegangan rendah | [Sekunder] Agência Brasil |
| Brasil Energia: di tegangan menengah praktiknya makin canggih; "konsumen besar memang mencuri dan melakukan fraud, dan banyak". Tren: menyerang komponen di sekitar meter (CT/PT, pengawatan) | [Sekunder] |
| Neoenergia: operasi terbesar Brasil, 23 usaha (susu, keramik, perdagangan, pertanian) di 4 negara bagian, 3,5 juta kWh pulih (rata-rata ±150 MWh per lokasi) | [Sekunder] (situs Neoenergia tidak bisa diakses dari sesi ini) |
| Goiânia (Okt 2025): supermarket membakar meter, tagihan ±R$ 3 rb padahal seharusnya ±R$ 22 rb. Pidana diperberat UU 15.181/2025 | [Sekunder] |
| CPFL: pelanggan industri dipasangi kubikel meter eksternal berlapis baja dengan telemetri; 43,5 ribu MWh pulih Jan–Jul 2025 | [Sekunder] |
| Skripsi UFOP: seleksi inspeksi Grupo A dari telemetri pembacaan meter menaikkan pemulihan energi dan pendapatan | [Lemah] |
| **Indonesia, Tambun Selatan, Bekasi (2026):** ruko memakai sambungan tiga fasa yang mem-bypass meter untuk *crypto mining* (12 server disita); berawal dari laporan warga dan petugas catat meter | [Sekunder] Periskop |
| UP3 Gorontalo: 362 pelanggan P1–P4, 694.855 kWh, tagihan susulan Rp 821,9 juta (rata-rata ±1.900 kWh per kasus); satu kasus P2 Kebon Jeruk Rp 68 juta | [Lemah] skripsi; [Sekunder] Kontan |

**Penilaian.** Yang terdukung bukti adalah polanya: jumlah kasus didominasi rumah tangga, sementara nilai per kasus
dan kecanggihan modus didominasi pelanggan besar (industri, komersial besar, lembaga). Klaim bahwa "kerugian terbesar
datang dari industri & lembaga" belum saya temukan dalam data per golongan dari ANEEL atau distributor. Kalau klaim
itu akan dipakai di depan juri, sebaiknya Anda punya sumbernya. Desain demo tidak bergantung pada klaim tersebut,
karena prioritas berbasis nilai otomatis mengangkat kasus-kasus besar.

### 5.2 Pola yang disuntikkan untuk segmen besar

| Kode | Segmen | Modus | Jejak di data | Deteksi |
|---|---|---|---|---|
| NTL-07 | Industri TM (I-3/I-4) | manipulasi CT/PT: sekunder CT di-shunt, fuse PT satu fasa dibuka, polaritas dibalik | satu fasa: U ≈ 0 atau I jauh lebih kecil; selisih arus fasa vs netral; PF janggal; kWh turun ±⅓ | fitur tiga fasa (Bai dkk. 2024), tanda CT fasa/netral |
| NTL-08 | Industri, bisnis besar | sambungan sebelum kubikel meter | kWh penyulang di SCADA tetap, AMI pelanggan turun | **neraca penyulang SCADA vs Σ AMI** |
| NTL-09 | Lembaga | tarif sosial/pemerintah dipakai untuk usaha | profil jam kerja komersial di golongan S/P | klasifikasi profil vs golongan; model per segmen (Calvo dkk. 2020) |
| NTL-10 | Industri TOU | register WBP/LWBP digeser | porsi WBP jauh di bawah profil penyulang | WBP pelanggan vs beban penyulang |
| NTL-11 | Lembaga, kawasan | listrik disalurkan ulang ke penyewa/tetangga | puncak melebihi kontrak; tetangga konsumsinya nol | puncak vs daya kontrak, korelasi spasial |
| NTL-12 | Industri | pemakaian melebihi daya kontrak, pembatas di-bypass | `P_DMD15` di atas kontrak berulang | titik `P_DMD15` dari point list NUSAGRID |
| NTL-13 | Internal | kolusi baca meter | anomali menumpuk per petugas/rute | agregasi per petugas |
| **NTL-14** | Komersial (ruko) | **bypass tiga fasa untuk crypto mining** (kasus Bekasi 2026) | beban datar 24/7, load factor ≈ 1, meter mencatat sangat kecil, trafo DT naik | load factor, neraca DT, profil malam |
| X-04 | Industri (pengecoh) | libur produksi, Lebaran, pengurangan shift | konsumsi turun, neraca penyulang ikut turun | kalender + neraca |
| X-05 | Industri (pengecoh) | PLTS atap, captive power, efisiensi | impor siang hari turun, ekspor naik | ekspor, profil siang |

---

## 6. Rancangan evaluasi model (dari literatur)

| Aspek | Keputusan demo | Dasar |
|---|---|---|
| Metrik utama | **Rp pulih per inspeksi**, presisi@k (k = kapasitas tim P2TL per minggu) | Massaferro 2020; Enel/C3 |
| Metrik pendukung | AUROC, PR-AUC (kelas jarang) | standar literatur |
| Bias label | 10% target dipilih acak; laporkan performa di sampel acak terpisah dari sampel terpilih | Glauner 2017 (ISAP) |
| Segmentasi | model/ambang per segmen: rumah tangga, bisnis, industri TM, lembaga | Calvo 2020 |
| Transisi AMI | fitur multi-resolusi: bulanan untuk semua, interval untuk yang ber-AMI | Massaferro 2022 |
| Ketidakseimbangan | ±5–9% positif (SGCC ±8,5%); bobot kelas / focal-Dice loss | SGCC; Bai 2024 |
| Penjelasan | Shapley per pelanggan + bukti fisik (neraca, fasa) | De Meulemeester 2025 |
| Uji realisme | pengecoh X-01..X-05 harus tetap rendah skornya | — |

---

## 7. Peta transmisi Jawa Barat

### 7.1 Isi

Sumber: OpenStreetMap via Overpass API, diunduh 2026-10-15 (ODbL). Batas kab/kota dari geoBoundaries (BPS/OCHA,
CC BY 3.0 IGO).

| Lapisan | Isi (di dalam Jabar) |
|---|---|
| SUTET 500 kV | ±1.515 km rute |
| SUTT 150 kV | ±1.913 km rute (termasuk saluran hasil inferensi) |
| SUTT 70 kV | ±846 km rute (termasuk inferensi); ±25 km tetap tidak diketahui tegangannya |
| Gardu | 216, 17 berkelas 500 kV; GITET antara lain Bandung Selatan, Mandirancan, Ujungberung, Tasikmalaya, Cibinong, Bekasi, Saguling, Cibatu, Deltamas, Gandul, Sukatani, Tambun II, PLTU Indramayu; juga GI "Data Center" (150 kV) |
| Pembangkit | 78; 43 dengan kapasitas tercatat (±12,5 GW): Muara Tawar 2.593 MW, Jawa-1 1.760 MW, Palabuhan Ratu 1.050 MW, Cirata 1.008 MW, Indramayu 990 MW, Saguling 701 MW, Cirebon 2 × 660 MW, PLTP Wayang Windu / Darajat / Salak, PLTS Terapung Cirata (OSM mencatat 192 MW; itu kapasitas MWp) |
| Kawasan industri | 46 kawasan (Jababeka 1–7, MM2100, Delta Silicon, EJIP, KIIC, Suryacipta, GIIC, Kota Bukit Indah, Kertajati, Rancaekek, dll.) |
| Batas | 27 kab/kota + Waduk Cirata |

### 7.2 Kualitas data (terukur)

| Ukuran | Nilai |
|---|---|
| Saluran (way OSM) | 775; 754 bertag tegangan; **12 diinferensi** dari gardu ujungnya; 9 tetap tidak diketahui |
| Saluran bernama | 185 dari 775 |
| Gardu | 216; 176 bernama; 168 bertag tegangan; **18 diinferensi** dari saluran yang terhubung |
| Gardu tanpa saluran dalam 900 m | 44 (kemungkinan gardu distribusi, GI yang salurannya belum dipetakan, atau kabel bawah tanah) |
| Pembangkit dengan kapasitas tercatat | 43 dari 78 |

Cara inferensi: ujung saluran dicocokkan ke gardu dalam radius ±900 m. Saluran tanpa tag mengambil kelas tegangan
**terendah** yang ada di gardu ujungnya, karena saluran tanpa tag di gardu 500/150 kV umumnya adalah sisi 150 kV.
Di GeoJSON, hasil inferensi diberi label `kelas_kv_sumber = "inferensi …"`.

### 7.3 Topologi

Jumlah ruas OSM yang berujung di sebuah gardu (bukan jumlah sirkuit): GITET Bandung Selatan 52, satu GITET tanpa nama
45, Mandirancan 39, Ujungberung 35, Tasikmalaya 29, Cibinong 27, Bekasi 27; GI 150 kV Lagadar dan Cimanggis 24. Angka
ini cukup untuk graf topologi kasar di Nexus, belum untuk analisis aliran daya.

### 7.4 Batasan dan etika pemakaian

- OSM **bukan data resmi PLN** dan tidak lengkap. Panjang = km rute, bukan kms sirkuit.
- **GI Kawasan NUSAGRID (-6,3021 / 107,1523) berjarak 0,6 km dari Kawasan Industri Jababeka 2.** Kawasan pilot di demo
  harus diberi nama fiktif (mis. "Kawasan Industri Demo Cikarang") dan disebut sintetis, supaya kasus pencurian
  sintetis tidak terbaca sebagai tuduhan terhadap kawasan atau tenant yang nyata.
- Gardu dan kawasan nyata hanya menjadi konteks. Penyulang, DT, pelanggan, dan semua angka susut/pencurian fiktif,
  dengan label "(demo)".
- Di platform: GeoJSON → `raw/jaringan_transmisi_jabar_osm` → P1 → object type *Saluran Transmisi*, *Gardu Induk*,
  *Kawasan Industri* (konteks). Atribusi ODbL wajib tampil di peta.

---

## 8. Perubahan ke rencana E2E (ringkasan)

1. Segmen pelanggan: rumah tangga, bisnis, industri TM/TT, lembaga (P/S); model dan ambang per segmen.
2. Pola NTL-07..14 dan pengecoh X-04/X-05; fitur tiga fasa dan neraca penyulang SCADA vs AMI.
3. Prioritas berbasis nilai (Bayesian risk: pemulihan − biaya inspeksi); metrik Rp per inspeksi dan presisi@k.
4. Porsi inspeksi acak 10% dan peta bias inspeksi.
5. Fitur multi-resolusi untuk transisi AMI.
6. Lapisan peta nyata (transmisi, kawasan industri) dengan pilot berlabel fiktif; benchmarking susut antar-UP3 vs
   batas, mencontoh metodologi ANEEL.
7. Approval untuk target dan eskalasi bernilai besar.
8. Angka skala taruhan Jabar (§2.3), dengan asumsinya ditampilkan.

---

## Daftar pustaka

**Jurnal & konferensi (DOI dicek ke Crossref, kecuali yang bertanda)**
- Acevedo, Massaferro, Fernández, Martins (2023). Fraud Detection Using Event Logs with LSTM and Gradient Boosting. ISGT. doi:10.1109/ISGT51731.2023.10066346
- Bai dkk. (2024). Detection Method for Three-Phase Electricity Theft Based on Multi-Dimensional Feature Extraction. Sensors 24(18):6057. doi:10.3390/s24186057
- Buzau, Tejedor-Aguilera, Cruz-Romero, Gómez-Expósito (2019). Detection of Non-Technical Losses Using Smart Meter Data and Supervised Learning. IEEE TSG 10(3):2661–2670. doi:10.1109/TSG.2018.2807925
- Buzau dkk. (2020). Hybrid Deep Neural Networks for Detection of Non-Technical Losses in Electricity Smart Meters. IEEE TPWRS 35(2):1254–1263. doi:10.1109/TPWRS.2019.2943115
- Calvo, Coma-Puig, Carmona, Arias (2020). Knowledge-Based Segmentation to Improve Accuracy and Explainability in NTL Detection. Energies 13:5674. doi:10.3390/en13215674
- Chuwa, Wang (2021). A review of non-technical loss attack models and detection methods in the smart grid. EPSR 199:107415. doi:10.1016/j.epsr.2021.107415
- Coma-Puig, Carmona (2019). Bridging the Gap between Energy Consumption and Distribution through NTL Detection. Energies 12:1748. doi:10.3390/en12091748
- Glauner, Meira, Valtchev, State (2017). The Challenge of NTL Detection Using AI: A Survey. IJCIS 10:760. doi:10.2991/ijcis.2017.10.1.51
- Glauner dkk. (2016). Large-Scale Detection of Non-Technical Losses in Imbalanced Data Sets. ISGT. arXiv:1602.08350
- Glauner dkk. (2017). Is Big Data Sufficient for a Reliable Detection of Non-Technical Losses? ISAP. arXiv:1702.03767
- Guarda dkk. (2023). Non-Hardware-Based Non-Technical Losses Detection Methods: A Review. Energies 16:2054. doi:10.3390/en16042054
- Jokar, Arianpoo, Leung (2016). Electricity Theft Detection in AMI Using Customers' Consumption Patterns. IEEE TSG 7(1):216–226. doi:10.1109/TSG.2015.2425222
- Massaferro, Di Martino, Fernández (2020). Fraud Detection in Electric Power Distribution: An Approach That Maximizes the Economic Return. IEEE TPWRS 35(1):703–710. doi:10.1109/TPWRS.2019.2928276
- Massaferro, Di Martino, Fernández (2022). Fraud Detection on Power Grids While Transitioning to Smart Meters by Leveraging Multi-Resolution Consumption Data. IEEE TSG 13(3):2381–2389 (dicek via DBLP/UCU)
- Messinis, Hatziargyriou (2018). Review of non-technical loss detection methods. EPSR 158:250–266. doi:10.1016/j.epsr.2018.01.005
- Pengwah, Razzaghi, Andrew (2023). Model-Less Non-Technical Loss Detection Using Smart Meter Data. IEEE TPWRD 38:3469–3479. doi:10.1109/TPWRD.2023.3280551
- Punmiya, Choe (2019). Energy Theft Detection Using Gradient Boosting Theft Detector With Feature Engineering-Based Preprocessing. IEEE TSG 10:2326–2329. doi:10.1109/TSG.2019.2892595
- Taruna, Arisona, Irwanto, Bestari, Juniawan (2025). Electricity Theft Detection Using Machine Learning in Traditional Meter Postpaid Residential Customers: A Case Study on State Electricity Company (PLN) Indonesia. IEEE Access 13. doi:10.1109/ACCESS.2025.3526764
- Telford, Stephen, Browell, Haben (2021). Dirichlet Sampled Capacity and Loss Estimation for LV Distribution Networks With Partial Observability. IEEE TPWRD 36(5):2676–2686. doi:10.1109/TPWRD.2020.3025125
- Velasco, Amaris, Alonso (2020). Deep Learning loss model for large-scale low voltage smart grids. IJEPES 121:106054. doi:10.1016/j.ijepes.2020.106054
- Viegas, Esteves, Melício, Mendes (2017). Solutions for detection of non-technical losses in the electricity grid: A review. RSER 80:1256–1268. doi:10.1016/j.rser.2017.05.193
- Zheng, Yang, Niu, Dai (2018). Wide and Deep CNNs for Electricity-Theft Detection to Secure Smart Grids. IEEE TII 14(4):1606–1615. doi:10.1109/TII.2017.2785963
- Zhuang dkk. (2024). Dynamic Generative Residual Graph Convolutional Neural Networks for Electricity Theft Detection. IEEE Access. doi:10.1109/ACCESS.2024.3379201 (dari DOAJ)
- Belum dicek DOI-nya, dikutip dari hasil pencarian: Stracqualursi dkk. (2023) RSER 184:113544 (https://www.sciencedirect.com/science/article/pii/S136403212300401X); Nayak & Jaidhar (2025) Applied Intelligence (https://idr.nitk.ac.in/handle/123456789/20204); Rahaman & Idris (2026) Jurnal Teknologi (https://journals.utm.my/jurnalteknologi/article/view/24029); EPSR 2025 (https://www.sciencedirect.com/science/article/abs/pii/S0378779625000951); Oguntola dkk. (2026) arXiv:2603.20488

**Regulator, perusahaan, media**
- ESDM, susut 2014–2023: https://www.esdm.go.id/id/berita-unit/direktorat-jenderal-ketenagalistrikan/turunkan-susut-ditjen-gatrik-titipkan-tiga-pesan-ini-ke-pln
- RRI, susut 2024: https://rri.co.id/bisnis/1596675/frekuensi-dan-durasi-gangguan-listrik-menurun-sepanjang-2024
- Pikiran Rakyat, penjualan & pelanggan UID Jabar 2025: https://jurnalgaya.pikiran-rakyat.com/bizz/pr-8010017890/ekonomi-jabar-menggeliat-penjualan-listrik-pln-uid-jawa-barat-tumbuh-signifikan-di-2025
- ESDM, sosialisasi P2TL: https://esdm.go.id/id/berita-unit/direktorat-jenderal-ketenagalistrikan/tingkatkan-kesadaran-pemakaian-listrik-pemerintah-dan-pln-sosialisasikan-aturan-p2tl
- Antara, aturan P2TL terbaru: https://kalsel.antaranews.com/berita/401043/pln-sosialisasikan-aturan-p2tl-terbaru-kepada-berbagai-pihak
- ESDM, FAQ RUPTL 2025–2034: https://gatrik.esdm.go.id/assets/uploads/download_index/files/daa0b-faq-ruptl-pln-2025-2034.pdf
- Periskop, crypto mining Bekasi: https://periskop.id/hukum/20260703/pln-pencurian-listrik-crypto-mining-bekasi
- ANEEL, perdas 2024: https://www.gov.br/aneel/pt-br/assuntos/noticias/2025/relatorio-traz-niveis-de-perdas-tecnicas-e-nao-tecnicas-em-2024-no-sistema-de-distribuicao-de-energia
- Cenário Energia, perdas 2025: https://cenarioenergia.com.br/2026/07/03/furtos-e-perdas-na-distribuicao-custam-r-232-bilhoes-aneel-glosa-r-35-bilhoes-de-distribuidoras/
- Agência Brasil, furto 2024: https://agenciabrasil.ebc.com.br/economia/noticia/2025-09/furto-de-energia-no-pais-gerou-custo-de-r-103-bilhoes-em-2024
- ANEEL REN 1000 (definisi Grupo A): https://www.enel.com.br/content/dam/enel-br/megamenu/quem-somos/conselho/REN%201000.pdf
- Brasil Energia, fraude média tensão: https://brasilenergia.com.br/brasilenergia/novos-modelos-e-tecnologias-em-energia/o-combate-as-fraudes-de-big-consumidores-na-media-tensao
- Neoenergia: https://www.neoenergia.com/w/maior-operacao-contra-desvio-de-energia-do-brasil-recupera-3-5-milhoes-de-kwh-em-4-estados
- Jornal Opção, Goiânia: https://www.jornalopcao.com.br/ultimas-noticias/supermercado-em-goiania-queimava-medidor-para-pagar-r-3-mil-em-vez-de-r-22-mil-de-energia-751333/
- CPFL: https://cenarioenergia.com.br/2025/09/01/cpfl-energia-recupera-435-mil-mwh-em-2025-com-investimentos-contra-fraudes-e-furtos-de-energia/
- UFOP, Grupo A: https://www.monografias.ufop.br/bitstream/35400000/1366/6/MONOGRAFIA_Identifica%C3%A7%C3%A3oCombatePerdas.pdf
- Palantir, grid network modelling: https://palantir.com/docs/foundry/use-case-examples/improving-decision-making-through-holistic-power-grid-network-modelling/
- PG&E × Palantir: https://bigdatawire.com/2021/01/21/pge-deploys-palantirs-foundry-platform
- Enel × C3 AI: https://bestpractice.ai/ai-use-cases/case-studies/energy-utilities/enel-improved-the-average-energy-recovered-per-non-technical-loss-inspection-by-70-in-italy-and-more-than-300-in-spain-using-machine-learning
- Siemens: https://www.siemens.com/global/en/products/energy/grid-software/meter-data-management/revenue-protection.html
- Itron: https://pl.itron.com/what-we-offer/revenue-assurance
- Landis+Gyr: https://landisgyr.com/ezine-article/revenue-protection
- Bidgely playbook: https://go.bidgely.com/rs/492-VKN-623/images/Bidgely-Energy-Theft-Detection-Playbook.pdf
- SGCC (deskripsi dataset): https://arxiv.org/pdf/2002.06219
- Skripsi P2TL Gorontalo: https://api-repo.unisan.ac.id/doc/download/skripsi/a750f8d4-15a4-41b2-93ea-fd01eb89 · Kontan: https://industri.kontan.co.id/news/kronologi-tagihan-listrik-hingga-rp-68-juta-versi-pelanggan-dan-pln?page=all
- OpenStreetMap: https://www.openstreetmap.org/copyright · geoBoundaries: https://www.geoboundaries.org
