# Analisis: Demo End-to-End *Grid Management System Intelligence*

Status: analisis, belum dibangun · 2026-10-15 · referensi: demo JKN ("JKN Healthcare System Intelligence") dan
NUSAGRID SCADA (`D:\Sadai\Power_SCADA`)
Lanjutan: benchmark jurnal/teknologi, pola pencurian industri & lembaga (NTL-07..13) dan peta transmisi Jabar di
[BENCHMARK_GRID_TL_NTL.md](BENCHMARK_GRID_TL_NTL.md)

---

## 0. Ringkasan

Tujuannya: demo end-to-end setingkat demo JKN, untuk **pengelolaan jaringan listrik distribusi**. Alurnya sama:
data mentah → pipeline → dataset bersih → Nexus (objek, relasi, action, function) → kecerdasan (aturan, ML, IoT) →
aplikasi (Workshop, Vertex, Peta, ruang kerja) → keputusan yang tercatat. Lineage serta keamanan & tata kelola
menjadi lapisan lintas.

Pertanyaan bisnis utamanya, yang juga menjadi benang merah demo:

> **"Ke mana hilangnya energi yang sudah kita beli atau bangkitkan, berapa nilainya, apa penyebabnya (teknis atau
> non-teknis), dan tindakan apa yang paling menguntungkan minggu ini?"**

Pertanyaan ini mengikat semua lapisan:

- **SCADA** memberi energi yang masuk ke GI dan penyulang, keandalan, serta beban.
- **AMI/AMR dan billing** memberi energi yang sampai ke pelanggan dan yang ditagih.
- **Neraca energi** memberi susut per level (GI → penyulang → gardu distribusi → pelanggan).
- **Model fisika (load flow) dan ML** memisahkan susut **teknis (TL)** dari **non-teknis (NTL)**.
- **Nexus** mengubah temuan menjadi target P2TL, perintah kerja perbaikan teknis, dan keputusan yang bisa diaudit.
- **Hasil P2TL lapangan** kembali sebagai **label** untuk melatih ulang model NTL. Lingkaran ini yang membuat demo
  terlihat seperti sistem nyata, bukan sekadar dashboard.

Power_SCADA (NUSAGRID) dipakai sebagai **sumber lapisan OT**: model jaringan CIM-lite-nya (522 peralatan, 2.764
titik ukur, koordinat GI/PLTS/BESS), point list bergaya SPLN, skenario gangguan, aturan alarm ISA-18.2, perhitungan
energi/susut (`packages/grid/src/energy.ts`), load flow, dan detektor anomali (`imbalance`, `meter_drift`,
`thermal`). Platform ini **hanya membaca** dari SCADA. Prinsip NUSAGRID "AI tidak pernah mengeksekusi kontrol"
dipertahankan: semua action di Nexus menghasilkan rekomendasi, target, atau perintah kerja, bukan perintah switching.

---

## 1. Posisi Power_SCADA vs platform ini

| | NUSAGRID SCADA (OT, real-time) | BluesandAI (IT, analitik & keputusan) |
|---|---|---|
| Waktu | milidetik–detik (RTDB, SOE, alarm) | 15 menit–harian–bulanan |
| Lingkup | GI, bay, feeder, recloser, DER | + gardu distribusi, pelanggan, billing, P2TL, keuangan |
| Keputusan | switching, SBO, interlock, LOTO | prioritas investasi, target P2TL, perintah kerja, audit |
| Zona IEC 62443 | Zona kontrol / operasi | Zona enterprise, menerima data lewat DMZ, **satu arah** |
| AI | advisory L0–L2, tanpa kontrol | ML TL/NTL, prioritas, Orbis; tetap tanpa kontrol |

Ada dua jalur integrasi, dan demo memakai keduanya:

1. **Impor konfigurasi (offline):** `config/demo/estate-grid/*.json` dan `points.jsonl` masuk sebagai raw dataset
   (topologi, peralatan, titik ukur, tarif). Model jaringannya benar-benar berasal dari SCADA, bukan dikarang ulang.
2. **Replikasi historian (online, nanti):** Data Connection read-only ke PostgreSQL historian NUSAGRID (rollup
   15 menit dan harian, alarm, SOE, outage) di sisi DMZ. Untuk demo, historian disintesis dengan profil yang sama
   (`packages/grid/src/profiles.ts`) agar demo tidak bergantung pada SCADA yang sedang berjalan.

---

## 2. Skenario dan skala (sintetis, wilayah fiktif)

Demo JKN punya lapisan pilot dan nasional. Grid dibuat dengan pola yang sama.

| Lapisan | Isi | Granularitas |
|---|---|---|
| **Pilot ULP** | 1 GI (GI Kawasan dari NUSAGRID) + 1 GI publik sintetis, 6 + 6 penyulang 20 kV, ~120 gardu distribusi (DT), ~6.000 pelanggan (rumah tangga, bisnis, industri; pascabayar & prabayar), AMI per jam / 15 menit | data mentah lengkap, bisa di-drill sampai bacaan meter |
| **Regional UP3** | 3–4 GI, ~30 penyulang, ~600 DT, ~45.000 pelanggan, 4 ULP | ringkasan harian dari "gateway AMI"; bacaan 15 menit diregenerasi deterministik saat di-drill (pola IoT nasional JKN) |
| **Waktu** | 6 bulan riwayat billing, 90 hari AMI/SCADA, 12 bulan hasil P2TL | |

Sumber kebenaran tersembunyi (*ground truth*) disuntikkan agar ML bisa divalidasi (AUROC, presisi@k), sama seperti
demo JKN. Untuk realisme, ada juga **pengecoh**, yaitu kasus yang terlihat mencurigakan padahal sah:

| Kode | Pola tersuntik | TL / NTL | Jejak di data |
|---|---|---|---|
| NTL-01 | Bypass meter (sambung langsung) | NTL | konsumsi pelanggan turun 60–90% mendadak, beban DT tetap; susut DT naik |
| NTL-02 | Magnet / tamper meter | NTL | event `MAGNETIC`/`COVER_OPEN` di AMI, profil datar |
| NTL-03 | Sambungan liar non-pelanggan (P4) | NTL | input DT > Σ pelanggan + TL, tanpa perubahan di pelanggan mana pun, terutama malam |
| NTL-04 | Limiter prabayar diakali (P1) | NTL | daya puncak melebihi VA kontrak, token jarang dibeli |
| NTL-05 | Rasio CT salah di pelanggan TM (administratif) | NTL | kWh tagihan = kWh AMI × konstanta keliru; selisih tetap |
| NTL-06 | Estimasi baca meter / stand macet | NTL (administratif) | stand sama berbulan-bulan, AMI tidak terbaca |
| TL-01 | DT overload | TL | arus > 100% rating, suhu minyak naik, I²R tinggi |
| TL-02 | Ketidakseimbangan fasa | TL | arus netral tinggi (`I_N`, detektor `imbalance` NUSAGRID) |
| TL-03 | JTR terlalu panjang / konduktor kecil | TL | drop tegangan ujung > 10%, susut DT tinggi tanpa anomali pelanggan |
| TL-04 | PF rendah / harmonisa | TL | PF < 0,85, THD tinggi (titik `PF`, `THD_I` dari point list) |
| TL-05 | Trafo tua (rugi besi tinggi) | TL | susut tetap tinggi saat beban rendah malam hari |
| X-01 | Rumah kosong / musiman (pengecoh) | — | konsumsi turun, tapi tanpa event tamper dan susut DT tidak naik |
| X-02 | Meter rusak (pengecoh) | — | detektor `meter_drift` / `stuck`; perlu ganti meter, bukan P2TL |
| X-03 | Pelanggan pasang PLTS atap (pengecoh) | — | impor turun di siang hari, ekspor naik |

Parameter sintetis yang ditargetkan: susut total per ULP 8–12%, dengan TL sekitar 5–6% dan sisanya NTL. Variasi
per penyulang dan DT dibuat lebar supaya peta dan antrean prioritas terlihat jelas.

---

## 3. Sumber data (layer "Sumber")

| Sumber (fiktif, gaya sistem utilitas) | Isi | Format raw |
|---|---|---|
| **SCADA / historian** (NUSAGRID) | model jaringan, point list, P/Q/I/U/PF/THD 15 menit, kWh `E_IMP`/`E_EXP` penyulang & GI, alarm, SOE, trip/recloser | JSON/JSONL dari config, CSV historian |
| **Sistem GIS aset** | geometri penyulang (LineString), tiang, DT (Point), konduktor, panjang, umur | GeoJSON |
| **AMI/AMR head-end** | load profile pelanggan & meter DT, event meter (tamper, power-off, reverse energy, phase-loss) | CSV harian + time series |
| **Billing & pelanggan** (gaya AP2T) | ID pelanggan, nama, NIK, alamat, tarif (R1, R2, B2, I3…), daya VA, stand meter, kWh tagihan bulanan, token prabayar | CSV (mengandung **PII**) |
| **Pengaduan & gangguan** (gaya APKT) | tiket gangguan, padam, keluhan tegangan | CSV |
| **P2TL** | hasil penertiban: golongan P1–P4, kWh susulan, tagihan susulan, foto/berita acara | CSV + media set (opsional) |
| **Pemeliharaan** | perintah kerja, inspeksi trafo, penggantian meter | CSV |
| **Cuaca** | suhu, hujan per kabupaten | CSV |
| **Tarif** | dari `tariffs.json` NUSAGRID (WBP/LWBP), diperluas per golongan | JSON |

---

## 4. Pipeline (layer "Olah"), dengan kompleksitas setingkat Palantir

Belajar dari demo JKN ("terlalu simpel" untuk 3 transform): **beberapa pipeline**, puluhan node, grup warna,
union/join, banyak output, terjadwal saat data baru masuk. Semua spec ditulis sekali per pipeline, seperti
`demo_jkn_pipeline.py`: spec → file Pipeline Builder, emulasi sqlite, dan graf halaman.

| # | Pipeline | Input → output utama | Catatan |
|---|---|---|---|
| P1 | **Aset & topologi jaringan** | GIS + model CIM NUSAGRID → `gardu_induk`, `penyulang`, `segmen`, `gardu_distribusi`, `peralatan_switching`, `konektivitas_pelanggan` (pelanggan→DT→penyulang→GI) | validasi topologi: DT yatim, pelanggan tanpa DT, konflik koordinat |
| P2 | **Telemetri SCADA & keandalan** | historian 15 menit, alarm, SOE → `beban_penyulang_harian`, `beban_dt_harian`, `kejadian_gangguan`, `keandalan_penyulang` (SAIDI/SAIFI/MAIFI, IEEE 1366, logika `reliability.ts`) | flag kualitas data (valid/questionable/substituted) dibawa ke dataset |
| P3 | **AMI & billing** | load profile, event meter, billing, token → `konsumsi_pelanggan_harian`, `fitur_pelanggan` (perubahan vs 3 bulan lalu, rasio malam/siang, konsumsi nol, puncak vs VA, event tamper, selisih billing vs AMI) | PII masuk sini dan langsung dipisah (lihat P6) |
| P4 | **Neraca energi & susut** | P1 + P2 + P3 → `neraca_energi` per GI/penyulang/DT per hari & bulan, `susut_teknis_estimasi` (I²R per segmen + rugi besi/tembaga trafo, gaya `loadflow.ts`), `susut_non_teknis` = total − teknis, `nilai_susut_rp` | inti demo; output menjadi backing object *Neraca Energi* |
| P5a | **Pelatihan model NTL** (Code Repo) | `fitur_pelanggan` + label P2TL → model asset | lihat §7 |
| P5b | **Skor NTL** (Pipeline Builder + function model) | fitur → `skor_ntl_pelanggan` (skor, suara detektor, alasan Shapley), `skor_ntl_dt` | pola `skorAnomaliDokterDemo` JKN |
| P5c | **Model & rekomendasi TL** | P4 → `rekomendasi_teknis` (uprating trafo, penyeimbangan fasa, rekonduktor, kapasitor) dengan estimasi kWh/tahun & Rp yang bisa diselamatkan | gabungan aturan fisika dan regresi |
| P6 | **Tata kelola identitas pelanggan** | billing raw (NIK, nama, alamat, no. meter) → Python transform Cipher → `pelanggan_pseudonim` | penanda PII tidak diturunkan, sama seperti `demo_jkn_governance.py` |
| P7 | **Akses berlapis per wilayah** | output P4/P5 → `*_per_ulp` → restricted views per UP3/ULP | pola `demo_jkn_akses.py` |
| P8 | **Ringkasan regional** | ringkasan harian gateway AMI 45.000 pelanggan → `wilayah_susut`, hotspot | pola IoT nasional JKN |

Jadwal: P2–P4 dipicu "data updated", sementara P5b berjalan setelah P4. Retrain P5a dijalankan bulanan atau
setelah hasil P2TL baru melewati ambang tertentu, sehingga lingkaran umpan balik terlihat di Builds.

Gotcha yang sudah diketahui dari JKN dan berlaku di sini: SQL Pipeline Builder memakai sqlite dengan aturan CAST
Spark. Hindari CAST pada teks, gunakan `ROUND(x, 1)`, dan bandingkan build nyata dengan emulasi baris demi baris.

---

## 5. Nexus (ontologi)

### 5.1 Object types (inti dicetak tebal)

| Object type | Backing dataset | Catatan |
|---|---|---|
| Wilayah (UID/UP3/ULP) | `wilayah_susut` | hierarki + choropleth |
| **Gardu Induk** | `gardu_induk` | geopoint; dari `substations.json` |
| Trafo Daya | dari P1 | OLTC, rating MVA |
| **Penyulang** | `penyulang` + `keandalan_penyulang` | geoshape garis, susut %, SAIDI/SAIFI |
| Peralatan Switching (PMT/Recloser/LBS) | `peralatan_switching` | **sensor object**: status POS; *Device and Machinery* (tertutup / terbuka / trip / lockout) |
| **Gardu Distribusi (DT)** | `gardu_distribusi` + `neraca_energi` | sensor object (beban kVA); Machinery: normal / overload / padam |
| **Pelanggan** | `pelanggan_pseudonim` + `fitur_pelanggan` + `skor_ntl_pelanggan` | **tanpa PII**; PII hanya lewat Cipher dan hanya untuk peran tertentu |
| Meter AMI | `meter` | sensor object, satu TSP (kWh), unit dari properti |
| Titik Ukur SCADA | `titik_ukur` (dari `points.jsonl`) | tag `DEG.GI01.20KV.F03.CB.POS`, kind, unit, kualitas |
| **Neraca Energi** | `neraca_energi` (per DT / penyulang / bulan) | input, terjual, TL, NTL, Rp |
| **Temuan Susut** | `temuan_susut` | jenis (TL-xx / NTL-xx), bukti, skor, status |
| Gangguan | `kejadian_gangguan` | SOE, durasi, pelanggan padam |
| **Target & Hasil P2TL** | `p2tl` (+ edit dari action) | golongan P1–P4, kWh & Rp susulan; **menjadi label ML** |
| Perintah Kerja | `perintah_kerja` (+ edit) | rekonduktor, uprating, balancing, ganti meter |
| Rekomendasi Teknis | `rekomendasi_teknis` | nilai penghematan, biaya, payback |

### 5.2 Link types

GI → Trafo Daya → Penyulang → Segmen → DT → Pelanggan → Meter · Penyulang → Peralatan Switching · Penyulang →
Gangguan · DT/Penyulang → Neraca Energi · Neraca/Pelanggan/DT → Temuan Susut · Temuan → Target P2TL → Hasil P2TL ·
Temuan/Rekomendasi → Perintah Kerja · Titik Ukur → Peralatan · Wilayah → GI/DT/Pelanggan.

### 5.3 Actions (semua advisory; tidak ada perintah ke lapangan SCADA)

1. **Tetapkan status temuan susut** (baru → diverifikasi → ditindaklanjuti → selesai / bukan masalah)
2. **Jadikan target operasi P2TL** (kumpulan pelanggan, tim, tanggal); dicekpoin dan perlu alasan
3. **Catat hasil P2TL** (golongan P1–P4 / tidak ditemukan, kWh & Rp susulan, foto); menulis label
4. **Buat perintah kerja teknis** dari rekomendasi TL (uprating, balancing, rekonduktor, kapasitor)
5. **Tandai meter rusak / jadwalkan penggantian** (untuk pengecoh X-02)
6. **Eskalasi ke manajemen / hukum**, misalnya untuk nilai susulan besar
7. **Konfirmasi gangguan & penyebab** (menautkan SOE ke tiket APKT)

### 5.4 Functions (Code Repository "Fungsi Susut Jaringan demo")

`susut_teknis_estimasi(dt)` · `alasan_ntl(pelanggan)` (penjelasan bahasa Indonesia: skor = kontribusi tiap fitur,
sama gayanya dengan `alasan_risiko` JKN) · `pelanggan_di_trafo(dt)` · `tetangga_serupa(pelanggan)` ·
`nilai_susut_rp(dt|penyulang)` · `prioritas_target_p2tl(dt)` (nilai × probabilitas × kemudahan akses) ·
`keandalan_penyulang(penyulang)` · `penghematan_rekomendasi(rek)`.

---

## 6. Kecerdasan: aturan, IoT, ML

### 6.1 Skrining aturan (deterministik, bisa diaudit)

Aturan untuk setiap pola di §2, dalam bentuk Python transform seperti `demo_jkn_rules.py`. Contohnya: konsumsi turun
>60% dengan beban DT tetap; event tamper ≥ 1 dalam 30 hari; puncak > 110% VA; stand meter tidak berubah ≥ 3 bulan;
susut DT > 15% dengan Σ pelanggan stabil; arus netral > 30% arus fasa; PF < 0,85.

### 6.2 IoT (AMI & SCADA sebagai bukti)

Ini analog dengan "listrik alat medis vs tindakan diklaim" di JKN. Di sini: **energi yang terukur di DT vs energi
yang ditagih ke pelanggan di bawahnya**. Ruang kerja men-drill: keputusan → aturan → grafik beban DT vs Σ pelanggan
(time series) → profil pelanggan tersangka → bacaan mentah 15 menit → event meter.

### 6.3 ML

| Model | Tipe | Label | Output |
|---|---|---|---|
| **NTL tanpa label** | Isolation Forest + autoencoder + LOF + pembanding peer (pelanggan satu DT dan tarif yang sama); ensemble suara, Shapley | — | skor 0–1, peringkat, alasan |
| **NTL berlabel** | Gradient boosting dari hasil P2TL (positif P1–P4, negatif "tidak ditemukan") | P2TL | probabilitas temuan; dibandingkan dengan model tanpa label (AUROC, presisi@100 target) |
| **Estimasi TL** | fisika (I²R, rugi trafo) + regresi koreksi atas DT ber-meter | neraca DT ber-AMI | TL per DT/penyulang |
| **Prakiraan beban** | dari `packages/insight/forecast.ts` NUSAGRID atau gradient boosting + suhu | historian | dipakai untuk risiko overload |

Rantainya sama dengan JKN: Code Repository → model asset → live deployment → model function → dipanggil di
pipeline P5b → properti di objek Pelanggan/DT. Lingkaran umpan balik: action "Catat hasil P2TL" → dataset label →
retrain → versi model baru → metrik eksperimen naik. Ini yang membedakannya dari demo yang statis.

### 6.4 Prioritas

`prioritas = nilai_susut_rp × P(temuan) × faktor operasional` → P1/P2/P3 per DT dan per pelanggan. Untuk TL,
peringkatnya memakai **payback** rekomendasi teknis.

---

## 7. Aplikasi

| Aplikasi | Isi |
|---|---|
| **Peta** "Demo: Peta susut jaringan" | penyulang (garis, warna = susut %), DT (titik, ukuran = Rp susut, warna = TL vs NTL dominan), heatmap skor NTL pelanggan, area padam, layer GI/PLTS/BESS dari NUSAGRID, choropleth ULP, slider waktu, rute tim P2TL |
| **Vertex** | (a) graf topologi GI → penyulang → DT → pelanggan dengan **aliran energi** (tebal = kWh, merah = hilang); (b) template "Investigasi susut trafo": DT → pelanggan → event → temuan → P2TL; (c) graf akar-penyebab gangguan (SOE → proteksi → recloser → pelanggan padam); (d) simulasi *what-if*: susut DT setelah rekonduktor atau penyeimbangan fasa |
| **Ruang kerja** `/demo-grid/ruang-kerja` (OSDK, seperti `/demo-jkn/audit`) | tab Antrean prioritas · Berkas DT · Pelanggan tersangka · Neraca energi (Sankey GI → pelanggan) · Keandalan · Model ML · Pantauan regional · Keamanan & tata kelola |
| **Workshop** "Kokpit susut & keandalan (demo)" | metrik, saringan wilayah, penjelasan (`alasan_ntl`), tombol action |
| **Halaman Nexus** `/demo-grid/nexus` | diagram ontologi + lineage (pakai ulang OntologyDiagram / LineageDiagram) |
| **Arsitektur** `/demo-grid/arsitektur` | layer + flow menyala (pola `demo_jkn_arsitektur.py`) |
| **Orbis** | graf pengetahuan grid + indeks vector; contoh: "kenapa susut DT-KBR-017 naik bulan ini?" |
| **Time Series / Quiver** | beban penyulang, profil pelanggan, PF/THD |

### Alur bernama (untuk halaman arsitektur)

1. **Telemetri → keandalan:** SCADA → P2 → Penyulang/Gangguan → SAIDI/SAIFI → Workshop
2. **kWh → neraca susut:** SCADA + AMI + billing → P4 → Neraca Energi → Peta
3. **Meter pelanggan → target P2TL → label:** AMI → P3 → P5 → skor NTL → action target → hasil → retrain
4. **Beban trafo → rekomendasi teknis:** SCADA/AMI DT → P4 → P5c → perintah kerja
5. **Identitas pelanggan → pseudonim:** billing → Cipher → objek Pelanggan
6. **OT → IT satu arah:** NUSAGRID historian → DMZ → raw (tidak ada jalur balik)

---

## 8. Lineage

Satu Project "Grid Management System Intelligence" dengan folder `raw/ clean/ ml/ iot/ governance/ akses/
pipelines/ apps/`, sama seperti JKN. Graf lineage tersimpan (seperti `jknakses`) dengan grup warna per pipeline,
dibuka dalam mode **Permissions + View as** untuk akun demo. Setiap angka di aplikasi bisa ditelusuri:
keputusan → objek → dataset bersih → transform → raw → baris historian/bacaan meter.

---

## 9. Keamanan & tata kelola

| Kontrol | Penerapan di demo |
|---|---|
| **Marking "PII Pelanggan (demo)"** | NIK, nama, alamat, no. meter di raw billing; SDS menandai otomatis; Cipher memberi pseudonim; hanya peran Verifikator P2TL yang bisa mendekripsi (dicekpoin) |
| **Marking "Infrastruktur Kritis (demo)"** (gaya CEII) | topologi detail, titik kontrol (`CMD`, `SETPOINT`), konfigurasi proteksi dan kanal dari NUSAGRID; tidak terlihat oleh analis komersial |
| **Akses per wilayah** | restricted views per UP3/ULP; akun `demo.grid.*`: dispatcher (keandalan, tanpa PII), analis susut (semua ULP, pseudonim), tim P2TL ULP-A (hanya target di wilayahnya, alamat via Cipher), manajer UP3, auditor internal, tamu |
| **Checkpoint & alasan** | ekspor daftar target P2TL, dekripsi identitas, action "Jadikan target P2TL", eskalasi hukum |
| **Approval** | rilis model NTL baru (model release + review); perubahan bobot prioritas |
| **Audit** | riwayat edit di setiap action; security auditing; jejak siapa melihat identitas pelanggan |
| **Zona IEC 62443** | platform di zona enterprise; data SCADA masuk lewat replikasi satu arah di DMZ; tidak ada kredensial tulis ke SCADA; dijelaskan di halaman arsitektur dan di Keamanan & tata kelola |
| **Retensi** | Data lifetime: bacaan 15 menit 90 hari, ringkasan 5 tahun, PII sesuai kebijakan |

Akun demo memakai pola kata sandi JKN. Kebijakannya didokumentasikan di memory, tidak di UI.

---

## 10. Rencana implementasi (mencerminkan modul JKN)

| Tahap | Modul baru | Hasil yang bisa didemokan |
|---|---|---|
| G1 | `api/demo_grid_network.py` | generator jaringan: impor NUSAGRID + perluasan sintetis (GI publik, DT, pelanggan, geometri), pola tersuntik, seed tetap |
| G2 | `api/demo_grid_pipeline.py` (spec P1–P4) + `demo_grid_e2e.py` (build idempoten per step) | Project, raw/clean, Pipeline Builder, jadwal |
| G3 | `api/demo_grid_ontology.py` | object/link types, datasource, Machinery, sensor objects + time series syncs |
| G4 | actions + Code Repo functions + keputusan awal | lingkaran keputusan |
| G5 | `api/demo_grid_map.py`, Vertex graf/template | peta & Vertex |
| G6 | `api/demo_grid_ml.py` (+ lib) | model NTL/TL, deployment, function, pipeline skor, eksperimen |
| G7 | `api/demo_grid_regional.py` | skala UP3, 45.000 pelanggan, ringkasan gateway |
| G8 | `api/demo_grid_governance.py`, `demo_grid_akses.py` | marking, Cipher, akun, restricted views, lineage Permissions |
| G9 | Web: `/demo-grid/{nexus,ruang-kerja,arsitektur}` + Workshop + Orbis | aplikasi |
| G10 | verifikasi: build nyata vs emulasi, klik headless Chrome, angka konsisten lintas halaman | siap demo |

Setiap tahap bisa diverifikasi sendiri, dan semua objek diberi judul "(demo)" atau "Demo:" lalu dipertahankan di UI.

---

## 11. Integrasi ke depan: ML + IoT nyata

- **AMI nyata:** MQTT/Sparkplug (sudah didukung NUSAGRID) → MQTT broker platform → streaming → time series; skor NTL
  dijalankan per jam.
- **Sensor DT** (meter trafo, suhu minyak) sebagai IoT edge; skor TL dan risiko overload mendekati real-time.
- **Streaming detection:** perubahan mendadak (bypass) ditandai dalam hitungan jam, bukan per siklus billing.
- **Feedback loop P2TL** sebagai sumber label utama. Metrik bisnis yang dipantau: hit-rate P2TL (temuan / target)
  naik dibandingkan pemilihan target manual.
- **Tetap read-only ke SCADA.** Rekomendasi switching, misalnya untuk menurunkan susut lewat rekonfigurasi
  jaringan, hanya dikirim sebagai usulan L2 ke switching order NUSAGRID dan dieksekusi operator.

---

## 12. Keputusan yang perlu dari Anda

1. **Domain inti:** utilitas distribusi gaya PLN (banyak pelanggan rumah tangga, NTL/pencurian dominan), kawasan
   industri NUSAGRID (120 tenant, NTL kecil), atau **hybrid** (GI Kawasan NUSAGRID + GI publik sintetis). Usulan saya:
   hybrid.
2. **Skala:** pilot ~6.000 pelanggan + regional ~45.000. Perlu dinaikkan atau diturunkan?
3. **Nama Project:** "Grid Management System Intelligence" (sejajar dengan nama JKN)?
4. **Urutan bangun:** G1–G5 dulu (pipeline → Nexus → peta/Vertex, demo tanpa ML), lalu ML dan tata kelola, atau
   langsung semuanya?

## 13. Status implementasi (sesi 2–4, 2026-10-16)

**Akses per ULP** (`api/demo_grid_akses.py`). 8 akun `demo.grid.*` (manajer UP3, analis susut, 3 tim P2TL, dispatcher,
auditor, tamu), 4 grup, atribut `kode_ulp`; pipeline akses → 4 dataset per ULP → 4 restricted views; row policy per ULP
di tipe Pelanggan/Temuan (UP3 semua) dan Gardu/Penyulang (UP3, analis, operasi semua); portal Workshop; permintaan akses
tamu (Approvals); checkpoint ekspor; graf lineage `gridakses` (Permissions, View as). Matriks akses per akun tampil di
`/demo-grid`, dan halaman itu kini membaca objek *sebagai pembacanya* (tim P2TL Utara: 85 dari 191 temuan).

Dua temuan arsitektur selama pengerjaan:
- **Penanda mengikuti input pipeline ke semua output.** Pipeline aset membaca model SCADA (CEII) hanya untuk titik ukur
  dan jumlah recloser/LBS, sehingga *semua* dataset bersih ikut ber-CEII. Diperbaiki: model SCADA diolah pipeline sendiri
  ("Pipeline model SCADA grid (demo)" → `titik_ukur_scada`), recloser/LBS dari register aset GIS; pipeline aset v2.
  Hasil: CEII hanya di 2 berkas SCADA mentah + titik ukur; 25/25 output build = emulasi.
- **Restricted view di platform ini dibaca dengan peran pembaca pada Project dataset sumbernya**, padahal kodenya
  menyatakan "dibaca sebagai sistem" dan semantik Foundry tidak mensyaratkan akses ke dataset sumber. Perbaikan sudah
  diterapkan (disetujui pemilik platform): `restricted_views._backing_table` membaca dataset sumber sebagai sistem,
  sedangkan peran di Project view, semua penanda dataset sumber (`inherited_markings`) dan policy baris tetap
  ditegakkan; membuat view tetap mensyaratkan Viewer pada dataset sumber. Hasil per akun: P2TL Utara 85 temuan ULP-KTU,
  P2TL Selatan 92 ULP-KTS, tim TM 14 ULP-KWS, analis dan dispatcher hanya gardu & penyulang, tamu 0. Portal Workshop
  tetap memakai tipe objek Nexus ber-row policy.

**Analitik** (`api/demo_grid_analitik.py`). Foundry Rules "Aturan susut grid — analis bisnis (demo)": 4 aturan atas
objek Pelanggan & Gardu (27 hasil ke dataset), lalu perubahan wajib lewat proposal — proposal FR-03 (event tamper ≥ 3)
terbuka menunggu reviewer. Nexus Scenarios: penyeimbangan beban (13 gardu), uprating (1), rekonduktor JTR (6); nilai
susut gardu Rp 304,3 jt/bln (main) → 301,5 / 302,4 / 298,7 jt. Quiver: beban per jam gardu NTL tertinggi vs penyulang
(SCADA) dan pelanggan TM dengan CT dimanipulasi. Contour: susut per ULP & bulan, efektivitas P2TL per dasar pemilihan
(temuan industri = 0: bias seleksi), nilai temuan per pola.

**Orbis — Grid** (`api/orbis_grid.py`, `/orbis/grid`). 10.621 simpul, 51.267 relasi, 50 jenis: lineage demo, semua
objek & link Nexus, 24 pola susut + golongan P2TL, model/eksperimen/22 fitur/9 metode/12 jurnal (DOI), 5 regulasi &
standar, 40 keputusan, 3 skenario. Indeks vector `orbis-grid-1` (bge-m3, US$0,02 penuh); tanya-jawab dengan rujukan
simpul. Explorer sama dengan Orbis JKN (varian di `web/src/lib/orbis.ts`).

**Arsitektur** (`/demo-grid/arsitektur`, `api/demo_grid_arsitektur.py`): 7 lapis, 27 blok bermetrik langsung, 6 alur
bernama (telemetri → keandalan, kWh → neraca, meter → target P2TL → label, beban trafo → perintah kerja, identitas →
pseudonim, OT → IT satu arah). Komponen tampilannya dipakai bersama dengan halaman arsitektur JKN.

**Uji klik** (headless Chrome, akun demo nyata di web 8888 / API 8000): ringkasan + arsitektur 28/28, semua aplikasi
terbuka 36/36 sebagai manajer, portal per akun (manajer/P2TL/analis/tamu) sesuai matriks, Orbis grid & Orbis JKN memuat.


## 14. Fase 5 — ML + IoT nyata (mulai 2026-10-16)

Rencana 5 sesi di `.work/grid/HANDOFF.md`: (1) AMI streaming, (2) skor NTL per jam & deteksi bypass, (3) sensor gardu
distribusi → TL & risiko overload, (4) feedback loop P2TL & hit-rate, (5) penutup (Orbis, uji menyeluruh).

**Sesi 5.1 — AMI streaming** (`api/demo_grid_ami.py`, langkah `ami`, bagian 9 di `/demo-grid`, alur "AMI → time series
(streaming)" di arsitektur). Pilot fiktif 292 meter: semua 142 pelanggan TM (AMR 3 fasa) + 150 pelanggan TR ber-AMI di
DT-K05-05, DT-K06-01, DT-K06-05. Simulator di proses API mengirim bacaan 15 menit ke MQTT Broker platform (Mosquitto;
namespace topik Sparkplug B `spBv1.0/GridDemo/DDATA/<head-end>/<meter>`, payload JSON hasil transkode gateway — bukan
protobuf), login terpisah untuk publish dan subscribe. Streaming sync MQTT (QoS 1) → ingest stream `ami_meter_15menit
(demo)` (diarsip tiap 15 menit ke raw/iot/ami) → "Pipeline AMI streaming grid (demo)" (job streaming): validasi, seri kW per
meter ke time series sync "Beban AMI pelanggan 15 menit (demo)", stream `ami_bersih` dan `ami_peristiwa` (event meter +
arus fasa timpang TM) untuk sesi 5.2 → tipe Nexus "Meter AMI Grid (demo)" (sensor dari Pelanggan, `seri_ami`, kebijakan
baris per ULP). Bacaan mengikuti profil beban dan pola NTL tertanam yang aktif; 3 kejadian baru (bypass, magnet, shunt CT
fasa L2) mulai di dalam 48 jam pertama — kebenarannya hanya di state demo, tidak di stream.

Hasil: backfill 48 jam 55.889 bacaan + interval live; broker → time series ±3 detik; 0 titik ganda. Dua temuan:
- **Backfill terlalu cepat dibuang broker.** 56 ribu pesan dalam ±1 menit melampaui antrean Mosquitto per klien (10.000);
  sync menyerap ±150 pesan/detik. Simulator kini mengatur laju (2,5 detik per interval tertunda) dan saat mulai mengirim
  ulang hanya bacaan yang belum ada di stream (store and forward) — 42.889 dikirim ulang, lengkap tanpa duplikat.
- **SQL Pipeline Builder menganggap SELECT tanpa baris sebagai error** ("The query returned no result"), sehingga langkah
  filter gagal pada batch streaming tanpa peristiwa. Diperbaiki di `web/src/lib/sql.ts`: kolom diambil dari statement yang
  disiapkan, hasilnya tabel kosong (berlaku untuk semua pipeline).

Akses per akun lewat API: manajer 292 meter, P2TL Utara 12 (ULP-KTU), Selatan 160 (ULP-KTS), TM 120 (ULP-KWS), analis dan
tamu 0; grafik beban pilot hanya untuk anggota Project. Uji klik 29/29 (bagian AMI, 6 tautan aplikasi, blok & alur
arsitektur); pemeriksaan demo 45/45 (39 lama + 6 AMI). Tetap read-only ke SCADA.

**Sesi 5.2 — Skor NTL per jam & deteksi bypass** (`api/demo_grid_ntl_stream.py`, langkah `ntl_stream`, bagian 10 di
`/demo-grid`, alur "NTL per jam → dugaan bypass" di arsitektur). "Pipeline NTL per jam grid (demo)" (streaming, sumber
ingest stream yang sama): agregasi per jam per meter dari bacaan bersih → fitur per jam → langkah Python-function
memanggil live deployment model NTL (`skorNtlPelangganGridDemo`, pola pipeline skor batch) → `skor_ntl_jam`. Fitur
model per siklus tagihan tidak tersedia per jam, jadi dipakai **adaptor per jam yang jujur**: `perubahan_pct` dari
rasio terhadap baseline jam-yang-sama (≤7 hari), `rasio_vs_peer` dari pangsa neraca gardu per jam, `event_tamper`
dari `ami_peristiwa` (magnet/buka tutup; `voltage_sag` bukan tamper), `rasio_arus_fasa_min` dari bacaan TM; fitur
khas tagihan diisi netral — skor per jam adalah peringatan dini, bukan pengganti skor siklus tagihan. Detektor di
API (CUSUM penurunan mendadak pada rasio baseline, picu langsung tamper/arus fasa timpang; skor model hanya bukti
pendukung — sebagai pemicu tunggal ia menandai 14% baris jam bersih) menulis tipe Nexus "Peristiwa AMI (demo)"
(sumber "AMI streaming", kebijakan baris per ULP, tautan ke Pelanggan dan Meter AMI) + Object Monitor "Dugaan
bypass AMI streaming (demo)" + notifikasi per ULP. Simulator punya endpoint suntik bypass (`POST
/api/demo/grid/ntl/suntik`, mulai sekarang, kebenaran dicatat seperti kejadian lain) untuk demo langsung. Integrasi
Platform Apps dari modul ini: 2 entri Portal (halaman skor + pipeline), graf Vertex "Demo: Dugaan bypass AMI
(streaming)", blok & alur arsitektur; lineage diperbarui pada build penuh berikutnya. Input streaming tanpa
PII/CEII (hanya id pelanggan + besaran listrik), jadi keluaran per jam tidak mewarisi penanda apa pun.

Hasil (67.236 bacaan, 17.227 meter-jam): latensi deteksi dari kebenaran `ami_sim.json` — AMI-E1 bypass 0,5 jam data,
AMI-E2 magnet 1,5 jam, AMI-E3 shunt CT L2 0,5 jam (target < 3 jam); 34 dugaan, false positive 19 pada 271 meter
tanpa kejadian (±6%, terutama sisa CUSUM saat baseline baru 1–2 hari). Akses peristiwa per akun: manajer 34 (semua
ULP), P2TL Utara 1 (ULP-KTU), Selatan 20 (ULP-KTS), TM 13 (ULP-KWS), analis & tamu 0. Uji klik headless 9/9
(bagian 10 + arsitektur); pemeriksaan demo 42/42 (termasuk 11 cek sesi ini). Tetap read-only ke SCADA.

**Sesi 5.3 — Sensor gardu: TL & risiko overload mendekati real-time** (`api/demo_grid_sensor_gardu.py`, langkah
`sensor_gardu`, bagian 11 di `/demo-grid`, alur "Sensor gardu → TL & overload" di arsitektur). Simulator sensor di
proses API untuk semua 102 gardu distribusi demo: meter trafo per fasa (arus 3 fasa + netral dari ketidakseimbangan
simulasi) dan suhu minyak/hotspot (model termal IEC 60076-7 yang disederhanakan: kenaikan oli sebanding K² dengan
jeda termal ±2 jam, hotspot = oli + gradien belitan, laju penuaan relatif 2^((hotspot−98)/6)) lewat MQTT (login
publish/subscribe terpisah, topik Sparkplug B `HE-DT-DEMO-01/<kode_dt>`, backfill 48 jam + live 15 menit) →
streaming sync → "Pipeline sensor gardu grid (demo)" (streaming, graf kompleks: 3 sumber termasuk register sensor
dan status gardu batch; cabang seri kVA dan agregasi per jam; join konteks fisik; 5 output: `sensor_bersih`, seri
"Sensor gardu distribusi 15 menit (demo)", `tl_gardu_jam`, `risiko_gardu_jam`, `status_banding_gardu`) → tipe Nexus
"Sensor Gardu (demo)" (sensor dari Gardu Distribusi, TSP kVA, baris per ULP/grup aset). Detektor di API menilai TL
per jam (rugi besi + tembaga K² trafo dan I²R JTR dengan faktor ketidakseimbangan) dan risiko overload; gardu
Overload otomatis menjadi Perintah Kerja "Usulan sensor (demo)" — rekomendasi L2 (penyeimbangan beban bila netral
tinggi, selain itu sisip/uprating), operator yang memutuskan; tetap tanpa jalur kendali ke SCADA. Kedua pipeline
streaming fase 5 memakai graf kompleks dari data mentah sampai bersih (pola pipeline audit JKN: banyak simpul,
cabang, join, grup legenda, catatan alur), bukan rantai lurus.

Hasil awal: 102/102 gardu terbaca, TL jam terakhir ±171 kWh/jam jaringan pilot; contoh nyata DT-K06-07 Overload
(beban 105,9%, hotspot 124,2 °C, penuaan 20,7×) → usulan `PK-SENSOR-DT-K06-07-2026-10-16` terbit otomatis. Uji klik
headless 7/7 (bagian 11 + kedua graf pipeline); pemeriksaan demo 59/59. Status beban live per gardu juga terbaca
sebagai seri kVA di objek Sensor Gardu; Device and Machinery gardu tetap mengikuti changelog pipeline beban per jam.

**Sesi 5.4 — Feedback loop P2TL & hit-rate** (`api/demo_grid_feedback.py`, langkah `feedback`, bagian 12 di
`/demo-grid`, alur "Hasil P2TL → label → retrain" di arsitektur). Hasil pemeriksaan P2TL (dataset
`p2tl_hasil_pemeriksaan`: 446 pemeriksaan, 62 terbukti pelanggaran; satu label per pelanggan dari pemeriksaan
terakhirnya: 398 pelanggan berlabel, 38 positif) menjadi dataset `label_p2tl_gabungan` di folder ml lewat
"Pipeline label P2TL gabungan grid (demo)" (batch, terjadwal saat data berubah; dataset berversi — pembangunan
ulang menaikkan versi data). Retrain terjadwal memakai jadwal transform Code Repository model: cron Senin 03:00
Asia/Jakarta + saat input label berubah (`sched-10fa5d26556d`, jalan berikutnya 19 Okt 2026 03:00 WIB); setiap
retrain tercatat sebagai experiment baru (terakhir `ntl-pelanggan-grid-4`: 398 label inspeksi, 38 temuan) dan bisa
dipicu dari tombol "Latih ulang sekarang" (Owner/admin). Dashboard hit-rate agregat **tanpa identitas pelanggan**:
keseluruhan 62/446 = 13,9%; per ULP dan per basis pemilihan (Analisa TO, laporan petugas/masyarakat, pemeriksaan
rutin TM, sampel acak) di bagian 12 — basis model/aturan dapat dibandingkan dengan pemilihan manual dari waktu ke
waktu. Label dari loop ini menggantikan label implisit fungsi `hasilP2tl` dengan versi yang eksplisit dan
berversi; kunci jawaban demo tetap tidak pernah dipakai melatih. Uji klik headless 6/6; pemeriksaan demo 67/67.
Tetap read-only ke SCADA.

**Sesi 5.5 — Penutup fase 5** (`api/demo_grid_penutup.py`, langkah `penutup`). Nexus dijelaskan sebagai graf di
Vertex ("Demo: Peta Nexus grid — objek, relasi, fungsi, aksi": 10 objek contoh, 9 relasi; simpul = objek, sisi =
link, fungsi menghitung dari objek, aksi mengubah objek dengan izin & audit). Maps: properti `lokasi` ditambahkan
ke Peristiwa AMI (36 peristiwa berlokasi dari lokasi pelanggan) dan register Sensor Gardu, sehingga peta susut
kini 11 layer termasuk "Peristiwa AMI dugaan bypass (demo)" (36 titik) dan "Sensor gardu distribusi (demo)" (102
titik). Orbis grid dibangun ulang dengan simpul fase 5 (10.639 simpul; metode streaming AMI, skor-jam-CUSUM,
sensor-termal, feedback-P2TL; jurnal Taruna dkk. 2025) dan graf lineage tersimpan `gridsusut` dihitung ulang (103
simpul: 5 pipeline, 14 tipe objek, 8 fungsi, 7 aksi, 5 graf Vertex, 1 peta, 1 model, 3 sinkron seri waktu).
Keamanan enterprise terintegrasi di semua permukaan Platform Apps dan terverifikasi 12/12: kebijakan baris per
ULP di Meter AMI, Peristiwa AMI, dan Sensor Gardu (manajer melihat semua, tim P2TL hanya ULP-nya, analis/tamu 0);
PII pelanggan ter-cipher; input streaming tanpa PII/CEII sehingga keluaran per jam tidak mewarisi penanda; Object
Monitor dugaan bypass aktif dengan notifikasi per ULP; jadwal retrain tercatat; jejak audit tersedia; 4 entri
Portal penutup (Vertex, Maps, Functions, Enterprise Security). Uji klik akhir: peta langsung 7/7, menyeluruh 9/10
(dua error 403 konsol berasal dari peta proyek lain di halaman daftar peta, bukan dari demo grid). Pemeriksaan
demo akhir 77/77. **Fase 5 selesai**: dari bacaan mentah 15 menit sampai keputusan — streaming (Pipeline Builder,
Streaming, MQTT Broker), skor & deteksi (Models, Functions, Object Monitors), objek & relasi (Nexus, Vertex),
peta (Maps), pengetahuan (Orbis, Data Lineage), dan keamanan (Cipher, Enterprise Security, audit) — tetap fiktif
berlabel "(demo)" dan read-only ke SCADA.

**Lapisan konteks Jawa Barat untuk visualisasi** (`api/demo_grid_konteks.py`, langkah `konteks`). Agar seluruh data demo mudah divisualisasikan, modul ini menulis tabel bintang siap peta/diagram dengan konteks administratif nyata Kabupaten Bekasi, Jawa Barat (sekitar GI demo di Cikarang): `raw/konteks/dim_wilayah_grid_jabar` (3 baris - satu per ULP: kabupaten/kota, kecamatan demo, karakter wilayah, kawasan industri acuan dari konteks OSM, profil beban, dan normal iklim sintetis berlabel konteks, bukan pengukuran), `clean/visualisasi/fakta_gardu_visual` (102 gardu: wilayah, koordinat/lokasi, kapasitas, beban puncak, estimasi TL, pelanggan, temuan), `clean/visualisasi/fakta_penyulang_visual` (14 penyulang: panjang, gardu, pelanggan termasuk TM langsung), `clean/visualisasi/fakta_ulp_visual` (rollup 3 ULP untuk diagram; ULP-KWS ditandai berpelanggan TM langsung tanpa gardu distribusi), dan `clean/visualisasi/sampel_pelanggan_visual` (1.500 pelanggan tanpa nama/NIK/alamat/telepon, koordinat dibulatkan ±100 m untuk scatter/heatmap). Kecamatan per gardu adalah penugasan sintetis deterministik berlabel `kecamatan_demo`; aset transmisi OSM tetap konteks tanpa angka demo; kunci jawaban pola tidak ditulis ke tabel visual. Verifikasi build langkah sendiri: 3/102/14/3/1.500 baris, semua gardu berlokasi dan berwilayah Kabupaten Bekasi; pyflakes bersih.

**Peta jaringan listrik Jawa Barat menyeluruh** (`api/demo_grid_peta_jabar.py`, langkah `peta_jabar`; peta Maps `map-b5804e01d0`). Meniru cakupan peta referensi Grid Jabar: seluruh aset transmisi nyata OpenStreetMap se-Jawa Barat sebagai 11 layer - batas 28 kabupaten/kota (geoBoundaries, ring diperbaiki ke right-hand rule agar lolos validator geoshape), SUTET 500 kV 1.513 km rute (134 ruas), SUTT 150 kV 1.915 km (502), SUTT 70 kV 846 km (127), tegangan tak diketahui 25 km (9), 216 gardu transmisi (17 kelas 500 kV), 78 pembangkit berwarna per bahan bakar (12,5 GW tercatat; parser kapasitas menangani desimal titik/koma), 46 kawasan industri - plus 3 layer pilot demo fiktif Cikarang (GI, penyulang berwarna susut, gardu distribusi). Dua tipe Nexus baru dari aset OSM yang sebelumnya belum dimodelkan: Pembangkit Jabar (OSM) dan Batas Kab/Kota Jabar (OSM, berisi cacah aset OSM per wilayah). Aset OSM tetap tanpa angka demo; KPI km adalah km rute di dalam Jabar, bukan kms sirkuit. Uji headless: layer tampil semua (28/216/78/46 objek terbaca di panel peta); pemeriksaan demo 87/87.

**Peta jaringan listrik Jawa-Bali** (`api/demo_grid_peta_jawa_bali.py`, langkah `peta_jawa_bali`; peta Maps `map-f8158414aa`, 15 layer). Data dicari dulu sebelum membangun: repo hanya punya aset Jabar, jadi jaringan regional diunduh dari OpenStreetMap lewat Overpass API (`docs/demo-grid/jawa_bali_transmisi_osm.geojson` 2,4 MB: 1.366 saluran di luar jendela Jabar - 500/150/70/lain, 323 gardu regional setelah deduplikasi, 91 pembangkit; total ruas OSM Jawa-Bali 4.377 km kelas 500 kV, 7.147 km 150 kV, 1.597 km 70 kV - km ruas geometri, bukan km rute gabungan) dan detail Jabodetabek (`jabodetabek_detail_osm.geojson`: 1.652 gardu power=substation sekotak metropolitan + 523 garis jaringan semua kelas (366 ruas 150 kV, 110 ruas 500 kV, 21 ruas 70 kV, sisanya minor_line/tanpa tegangan; garis regional dideduplikasi terhadapnya). Level tiang rumah tangga TIDAK tersedia dari OSM nyata (power=pole hanya 303 se-Jabodetabek dan 0 di Cikarang; power=tower 4.752 adalah menara transmisi) dan sesuai keputusan pengguna tidak dibuat sintetis - peta berhenti di gardu distribusi dan saluran yang benar-benar terpetakan). Lima tipe Nexus OSM regional baru; lapis regional sengaja mengecualikan jendela Jabar dan gardu yang sudah tampil di detail Jabodetabek agar tidak dobel - di Jabar tampil lapisan super-detail (216 gardu, 78 pembangkit, 46 kawasan, 28 batas) dan di Jabodetabek lapisan detail metropolitan, ditambah pilot demo Cikarang. Uji headless 6/6 (panel peta membaca 523 objek saluran detail); pemeriksaan demo 91/91. Aset OSM tetap konteks nyata tanpa angka demo.

**Audit ketat peta (tanpa bug)**: (1) Lubang SUTET terbesar ternyata di peta Jawa-Bali sendiri - saluran detail Jabar tidak ikut tergambar; ditambah layer Detail Jabar SUTET 500/SUTT 150/70 kV sehingga backbone 500 kV kontinu (audit kontinuitas: 556 ruas gabungan, 39 ujung menggantung dan hampir semua berpasangan <1,5 km = artefak segmentasi OSM atau tap pembangkit, bukan segmen hilang). (2) Sesuai keputusan pengguna kedua peta jaringan kini MURNI data riil OSM: layer pilot fiktif (GI/penyulang/gardu distribusi demo) dicabut; peta Jabar 8 layer, Jawa-Bali 15 layer. (3) Sumber tambahan diperiksa: 97 relasi route=power hanya menambah 27 ruas 20 kV (sudah dimasukkan), format voltage non-numerik tidak ada. (4) Tiga way OSM rusak bernama Segment 1/2/3 (lompatan lurus 54-150 km, membentuk kotak raksasa di peta) dibuang dari aset dan disaring permanen di modul (lompatan titik >25 km = tidak wajar; aset Jabar bersih, hop maksimum 4,1 km). (5) Deduplikasi osm_id antarlapis: 297 -> 0. Audit akhir: semua layer kedua peta >0 objek dan geometri 100% valid, uji UI per-layer hijau, verify_grid5 92/92.

**Satu peta gabungan (paling rapi)** (`api/demo_grid_peta_gabungan.py`, langkah `peta_gabungan`; peta Maps `map-06d3c34412`). Sesuai permintaan, ketiga cakupan dilebur jadi SATU peta 9 layer tanpa layer per-daerah dan tanpa objek dobel: saluran/gardu/pembangkit digabung per osm_id dari detail Jabar + regional Jawa-Bali + detail Jabodetabek (sumber lebih detail menang, cakupan tercatat per objek). Isi: 2.356 saluran (313 ruas 500 kV, 1.707 ruas 150 kV, 259 ruas 70 kV, 77 tegangan lain), 539 gardu transmisi berwarna kelas, 1.582 gardu detail Jabodetabek, 169 pembangkit berwarna bahan bakar, 46 kawasan industri, 28 batas kab/kota - semuanya murni OSM riil. Audit peta bersih (0 dobel, geometri 100% valid), UI 6/6, verify_grid5 94/94. Dua peta sebelumnya tetap ada sebagai referensi detail per wilayah.

**Jaringan menyatu (konektivitas)**: dikoreksi - sebelumnya layer hanya bertumpuk visual. Diukur: 500 kV memang 98% satu komponen, tetapi 150 kV hanya 41% dan 70 kV 29%, sehingga gardu dijadikan simpul jaringan di `_koneksi()`: setiap ujung saluran ditempelkan ke gardu/pembangkit terdekat (<=1,5 km; tercatat sebagai gardu_ujung_a/b bernama di objek saluran), titik yang belum menempel diberi layer Penghubung gardu-saluran (turunan OSM, 115 garis pendek <=1,5 km, dinyatakan bukan saluran). Hasil: 1.964/2.356 ruas berujung gardu bernama, 486 titik menempel langsung, 92% ruas berada di komponen jaringan terbesar dari 78 komponen - pulau jaringan daerah yang tersisa memang belum tersambung di pemetaan OSM dan tidak dikarang sambungannya. Peta gabungan kini 10 layer; audit bersih, UI 6/6, verify_grid5 96/96.

**Audit integrasi satu sistem** (`api/demo_grid_integrasi.py`, langkah `integrasi`). Dicek sebagai rantai, bukan per-app: semua tipe data grid ter-backing dataset (tipe perintah/kunjungan/tim memang edit-only lewat aksi); graf lineage tersimpan `gridsusut` dihitung ulang dengan biji diperluas sehingga kini 139 simpul tersimpan (136 terlihat manajer: 86 dataset, 24 tipe objek, 6 pipeline, 4 peta, 8 fungsi, 7 aksi, 5 vertex, 3 ts_sync, 1 model); koneksi jaringan jadi relasi Nexus beneran (link type Saluran berujung A/B di gardu dan Penghubung menempel ke saluran); portal menautkan Lineage, Nexus (Ontology), Orbis, Cipher, dan peta gabungan; Orbis dibangun ulang (10.653 simpul). Satu cerita ditelusuri utuh sebagai bukti: kunjungan KJ-TMN-0022 (TIM-KTU-1, Terjadwal) -> temuan TMN-0022 -> pelanggan 538200001627 -> gardu DT-K03-04 -> penyulang -> GI Demo Cikarang Kota; cabang teknisnya terpisah dan benar: perintah sensor PK-SENSOR-DT-K06-07-2026-10-16 -> gardu DT-K06-07. Dataset pelanggan terbukti lahir dari Pipeline neraca energi & susut grid (demo) di lineage. Traversal link Nexus yang sesungguhnya (bukan hanya kolom) lolos untuk saluran-gardu dan kunjungan-temuan-pelanggan-tim; 1.900/2.356 saluran punya ujung di Gardu Gabungan (total 1.964 berujung titik bernama gardu/pembangkit). UI lineage & portal 5/5; verify_grid5 98/98.

**Orbis Grid operasional transmisi** (`api/orbis_grid.py`). Orbis sebelumnya hanya memuat transmisi Jabar dari tipe inti; kini seluruh tipe operasional ikut: Meter AMI, Peristiwa AMI, Sensor Gardu, Pembangkit & Batas Jabar, Saluran/Gardu/Pembangkit Jawa-Bali regional, jaringan Gabungan, Penghubung, dan Gardu Detail Jabodetabek. Graf naik 10.675 -> 17.799 simpul dan 51.343 -> 76.838 relasi (70 jenis), dengan lapisan baru Operasional transmisi Jawa-Bali (6.566 simpul). Pengetahuan transmisinya dihitung dari objek, bukan karangan: hub kelas tegangan (500 kV 313 ruas/3.920 km/31 gardu; 150 kV 1.707/7.049/335; 70 kV 259/1.615/62), 101 koridor bernama, 2.767 relasi aset-yang-sama antarrepresentasi, 582 relasi wilayah kab/kota, 382 penghubung terhubung, dan simpul agregat Jawa-Bali (2.356 saluran, 539 gardu, 169 pembangkit, konektivitas 92% komponen terbesar) yang terhubung ke metode operasi transmisi (aliran daya & kontingensi, proteksi/SCADA-EMS, pemeliharaan, konektivitas) dan standar CIM/ODbL. Indeks vektor orbis-grid-1 diperbarui penuh 17.799 vektor; pencarian SUTET/gardu/pembangkit relevan dan UI Orbis 6/6. verify_grid5 101/101.

**PLN Grid Monitoring Cockpit** (`api/pln_cockpit.py` + `web/src/app/pln-cockpit/page.tsx`, terdaftar di Portal). Satu layar Transmission Operations Intelligence dengan tiga workspace: Live Operations (peta gabungan tertanam, KPI transmisi per kelas, alarm tergrup per aset dengan acknowledge/assign/resolve berriwayat, pencarian aset + detail topologi gardu ujung A/B, auto-refresh 15 detik), Grid Risk & Reliability (loading gardu distribusi dari sensor demo; loading transmisi dan kontingensi N-1 dinyatakan TIDAK TERSEDIA secara eksplisit karena rating konduktor, model impedansi, dan solver aliran daya belum terhubung - adapter & daftar kebutuhannya terdokumentasi di endpoint, tidak ada hasil rekayasa), dan Field Operations (perintah kerja & 36 kunjungan P2TL; pembuatan perintah lewat aksi Nexus agar peran/audit tercatat; cockpit read-only tanpa eksekusi switching). Mode selalu ditandai DEMONSTRASI (aset OSM riil + telemetri simulasi berlabel demo, bukan operasi PLN produksi). Uji: backend endpoint lolos, UI headless 8/8, pyflakes bersih, verify_grid5 104/104.

Kelengkapan P0/P1 cockpit ditambah sebagai status/adaptor jujur: detail padam distribusi dengan linimasa dan dampak yang dihitung dari topologi penyulang-gardu-pelanggan (bukan kedekatan peta; padam transmisi unavailable), profil kesehatan gardu distribusi berskor aturan deterministik dengan bukti terbuka (transmisi tetap N/A tanpa umur/inspeksi/rating), catatan inspeksi P2TL dan siklus status perintah kerja berriwayat di Field Operations, serta lima overlay ROW/lingkungan (vegetasi, konstruksi, banjir, longsor, kebakaran/cuaca) yang semuanya Tidak tersedia beserta sumber resmi yang dibutuhkan - tidak ada deteksi karangan. UI cockpit 12/12; verify_grid5 107/107. Terakhir permukaan cockpit ditata ulang mengikuti pola workspace audit JKN (`ModuleHeader` + `PageRail` kiri bergroup dengan count badge + `Widget`/`MetricWidget`/`BarList` yang sama): delapan halaman — Ringkasan operasi, Jaringan & peta, Alarm & gangguan, Risiko & keandalan, Analisis ML (strategi pemilihan target presisi@40 & AUROC lima strategi, metrik terekam experiment, 25 target prioritas berskor NTL + potensi Rp + penanda kunci, latensi deteksi bypass per jam AMI-E1/E2/E3/suntikan dan false positive — semua dari live deployment & endpoint NTL yang sama dengan /demo-grid), Operasi lapangan, Pantauan Jawa–Bali, Keamanan & tata kelola — dipilih lewat query `/pln-cockpit?tab=…` persis seperti `/demo-jkn/audit?tab=anomali|kasus|iot|nasional`, dengan tab horizontal di mobile; uji UI headless 13/13 hijau (login, ringkasan, klik alarm → detail padam, risiko unavailable jujur, lapangan, deep-link `?tab=nasional`). Koreksi tampilan menyusul: peta tertanam kini memakai mode `?embed=1` (tanpa sidebar platform ganda), tab jaringan ditata peta-lebar-penuh + pencarian di bawah, semua tab mengisi viewport tanpa ruang hitam (widget `flex-1`, daftar alarm/perintah dapat di-scroll), status kosong alarm dibedakan dari status memuat, dan strip loading dipersempit hanya pada tab yang menunggu overview — terverifikasi dari screenshot tiap tab. Terakhir seluruh artefak Drive demo dipindah ke project baru **PLN Grid Project** (`cf168ed066ca4544`): kesembilan folder (akses, apps, clean, governance, iot, ml, pipelines, raw, susut) dipindahkan utuh (id item tidak berubah), roles viewer disalin, project lama yang kosong masuk trash, konstanta `PROJECT` di `demo_grid_e2e`/`orbis_grid` diarahkan ke nama baru, dan API di-restart — cockpit & demo-grid overview tetap 200, verify_grid5 107/107. Project portal per-ULP tetap project tersendiri karena Drive melarang project bersarang. Sisa produksi: telemetri SCADA & rating resmi, solver N-1 tervalidasi, data umur/inspeksi trafo & menara, observasi ROW/lingkungan resmi, dan integrasi dispatch kru.

