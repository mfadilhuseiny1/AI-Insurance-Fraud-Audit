# Rancangan pipeline — Data Sampel BPJS Kesehatan Edisi 2025

> **AI JKN Synthetic:** dokumen ini disalin dari AI JKN Audit dan menggambarkan pengerjaan di atas Data Sampel BPJS yang asli. Angka agregat data asli sudah dihapus dan diganti `[…]`. Aplikasi ini berjalan di atas data sintetis (lihat `synthetic-gen/METODOLOGI.md` dan `synthetic-gen/laporan/EVALUASI.md`).

Pengganti pipeline audit JKN demo (data fiktif). Sumber: `Data BPJS/2025` (lokal, **tidak masuk git**). Semua angka di
dokumen ini diukur dari file aslinya (profil 2026-10-20).

## 1. Sumber

7 edisi × 5 jenis tabel + referensi ICD-10, format Stata `.dta` (label nilai ikut di file), total ±4,6 GB.
`Data sampel 2015-2024.zip` adalah arsip dari folder `2025/` yang sama (isi identik) — diabaikan.

Cakupan waktu: kepesertaan Reguler = panel 2015–2024 (tahun sampel 2016–2024); layanan (FKTP, FKRTL, nonkapitasi)
Reguler, DM, KM, KIA, TB = tahun 2024 (FKRTL datang mulai Juli 2023); hanya edisi COVID yang layanannya 2015–2024.

| Jenis tabel | Grain (1 baris =) | Kunci | Reguler | 6 edisi kontekstual |
|---|---|---|---:|---:|
| kepesertaan | 1 peserta | `PSTV01` | […] | […] |
| fktpkapitasi | 1 kunjungan FKTP | `FKP02` | […] | […] |
| fkrtl | 1 kunjungan / klaim FKRTL (INA-CBG) | `FKL02` | […] | […] |
| diagnosissekunder | 1 diagnosis sekunder per kunjungan FKRTL | `FKL02` + `FKL24` | […] | […] |
| nonkapitasi | 1 **tindakan** per kunjungan (bukan kunjungan) | `PNK02` + tindakan | […] | […] |

Edisi kontekstual: COVID (2015–2024), DM, Kesehatan Mental, KIA-Ibu, KIA-Anak, TB (2024). Skema sama dengan Reguler,
selisihnya hanya kolom khusus: COVID `FKL49/FKP23/PNK21` (flag layanan COVID), `PSTV21/22` (vaksin, komorbid);
DM/KM/TB/KIA-Ibu/COVID `PNK19/PNK20` (GDP 1 & 2); KIA-Anak `PSTV01_A` (nomor peserta ibu) dan **tanpa bobot**.

### Hasil profil (Reguler)

- Kunci unik semua: `PSTV01` […] unik, `FKP02` […] unik, `FKL02` […] unik, tanpa duplikat (FKL02, kode dx).
- Relasi utuh: […]% kunjungan FKTP/FKRTL punya peserta; […]% kunjungan FKRTL punya rujukan dan **[…]%** rujukan itu ada
  di FKTP; […]% diagnosis sekunder menempel ke kunjungan FKRTL.
- Tanggal: FKTP 2024-01-01…2024-12-31; FKRTL datang mulai 2023-07-15 (pulang 2024); tidak ada pulang < datang.
- Biaya FKRTL: tagih Rp […], verifikasi Rp […]; berbeda di […]% klaim; tidak ada verifikasi > tagih,
  tidak ada biaya nol. LOS p50 […] hari, p99 […], maks […].
- **[…] calon klaim ganda** (peserta + tanggal + INA-CBG + biaya sama) — ditandai, tidak dibuang.
- Tanggal lahir minimum 1900-07-01 — diduga nilai pengganti, ditandai.
- `PSTV18` (tahun meninggal) kosong […]% — wajar.
- `FKP02` di FKRTL berisi string kosong (bukan null) bila tanpa rujukan.
- **Tidak ada ID faskes.** Faskes hanya dikenal dari provinsi, kab/kota, kepemilikan, jenis, tipe (anonimisasi
  sumber). Analisis "per faskes" tidak mungkin; unit terkecilnya profil faskes per kab/kota.
- Bobot (`PSTV15`) dibawa apa adanya sebagai kolom `bobot`; pipeline ini transformasi data, bukan estimasi statistik,
  jadi bobot tidak diterapkan di agregat mana pun.

## 2. Prinsip "dataset rapi"

1. **Satu dataset per entitas, semua edisi digabung** dengan kolom `edisi` (`reguler`, `covid`, `dm`, `kesehatan_mental`,
   `kia_ibu`, `kia_anak`, `tb`). Peserta yang muncul di beberapa edisi tetap baris terpisah per edisi (bobotnya beda).
2. **Nama kolom deskriptif, snake_case Indonesia** (`tgl_datang`, `biaya_tagih_rp`), kode asli disimpan di katalog
   kolom (`PSTV01 → peserta_id`) — tidak ada lagi `FKL47` di lapisan bersih.
3. **Kode dan label dipisah**: setiap kolom berlabel jadi dua kolom, `*_kode` (angka asli) dan `*_label` (teks); kode
   wilayah ikut standar Kemendagri (11 = ACEH, 1101 = SIMEULUE) dan jadi kunci ke dimensi wilayah.
4. **Tipe tegas**: tanggal `date`, uang `int64` rupiah, bobot `double`, flag `boolean`; string kosong → null.
5. **Ditandai, bukan dibuang**: masalah kualitas jadi kolom `flag_*`; baris tidak pernah hilang diam-diam.
6. **Partisi** per `edisi` (dan bulan untuk tabel kunjungan) agar baca sebagian murah.
7. Setiap dataset punya **ekspektasi** (kunci unik, relasi, rentang) yang gagal = build gagal.

## 3. Lapisan

```
L0 raw/      .dta asli + xlsx ICD-10 (tidak diubah, hanya dicatat checksum & ukurannya)
   │  konversi (Python transform, DuckDB/pyarrow — di luar engine Pipeline Builder, lihat §5)
L1 bronze/   per jenis tabel, 7 edisi digabung, kolom asli + edisi + sumber_file, tipe dibakukan, Parquet
   │  pembersihan & pemodelan (Python transform, DuckDB)
L2 silver/   dimensi + fakta rapi (nama deskriptif, kode/label, flag kualitas)
   │  agregasi (Pipeline Builder, input kecil)
L3 gold/     tabel analitik ringkas → Nexus, aplikasi, model
```

### L2 silver — dimensi

| Dataset | Grain | Kolom utama |
|---|---|---|
| `dim_wilayah` | kab/kota | `kabkota_kode`, `kabkota`, `provinsi_kode`, `provinsi`, `provinsi_38_kode/_label` (dari label nilai) |
| `dim_icd10` | kode 3 digit | `icd3`, `nama`, `bab` — gabungan `icd10_info*.dta` + xlsx (FKTP kapitasi/nonkap/FKRTL) |
| `dim_icd10_rinci` | kode 3–6 digit | `kode`, `nama`, `icd3` (dari kolom kode+nama di data kunjungan) |
| `dim_inacbg` | kode INA-CBG | `inacbg_kode`, `deskripsi`, `cmg` (digit 1), `tipe_kasus` (2), `spesifikasi` (3), `keparahan` (4) |
| `dim_profil_faskes` | kombinasi atribut | `faskes_profil_id` (hash), provinsi/kabkota, kepemilikan, jenis, tipe, tingkat — pengganti ID faskes yang tidak ada |

### L2 silver — fakta

| Dataset | Grain | Kolom utama | Flag |
|---|---|---|---|
| `peserta` | edisi × peserta | `peserta_id`, `keluarga_id`, `peserta_ibu_id` (KIA-Anak), `tgl_lahir`, `usia_2024`, `jenis_kelamin`, `hubungan_keluarga`, `status_kawin`, `kelas_rawat`, `segmen`, wilayah tinggal & FKTP terdaftar (kode), `bobot`, `tahun_sampel`, `status_kepesertaan`, `tahun_meninggal`, `status_vaksin`, `komorbid` | `flag_tgl_lahir_pengganti` |
| `kunjungan_fktp` | edisi × kunjungan | `kunjungan_fktp_id`, `peserta_id`, `tgl_datang`, `tgl_pulang`, `faskes_profil_id`, `poli`, `segmen`, `status_pulang`, `dx_icd3`, `dx_kode`, `jenis_kunjungan`, rujukan tujuan (profil), `layanan_covid`, `bulan` | — |
| `kunjungan_fkrtl` | edisi × klaim | `kunjungan_fkrtl_id`, `peserta_id`, `rujukan_fktp_id`, tanggal, `los_hari`, `faskes_profil_id`, `faskes_perujuk_profil_id`, `poli`, `kelas_rawat`, `status_pulang`, dx masuk/primer (icd3 + rinci), `inacbg_kode`, `regional_tarif`, `tarif_inacbg_rp`, komponen SA/SP/RR/SI/SD (kode, deskripsi, tarif), `biaya_tagih_rp`, `biaya_verifikasi_rp`, `selisih_rp`, `jumlah_dx_sekunder`, `bulan` | `flag_calon_klaim_ganda`, `flag_selisih_verifikasi`, `flag_los_ekstrem` (> p99 per INA-CBG) |
| `diagnosis_sekunder` | edisi × kunjungan × dx | `kunjungan_fkrtl_id`, `dx_kode`, `dx_icd3` | — |
| `tindakan_nonkapitasi` | edisi × kunjungan × tindakan | `kunjungan_id`, `tindakan_ke`, `peserta_id`, tanggal kunjungan/tindakan/pulang, `faskes_profil_id`, `tingkat_layanan`, dx, `tindakan`, `biaya_tagih_rp`, `biaya_verifikasi_rp`, `gdp_1`, `gdp_2` | — |
| `rujukan` | rujukan FKTP→FKRTL | `kunjungan_fktp_id`, `kunjungan_fkrtl_id`, `hari_ke_fkrtl`, profil asal & tujuan, dx asal & dx FKRTL, `dx_sama` | — |

### L3 gold — untuk Nexus & aplikasi (kecil, dibangun di Pipeline Builder)

| Dataset | Grain | Isi |
|---|---|---|
| `klaim_fkrtl_bulanan` | bulan × kab/kota × tipe RS × INA-CBG | jumlah klaim, biaya tagih/verifikasi, LOS rata/p90 |
| `kunjungan_fktp_bulanan` | bulan × kab/kota × jenis FKTP × poli × icd3 | kunjungan, rasio rujuk lanjut |
| `alur_rujukan` | kab/kota asal × kab/kota tujuan × tipe RS | jumlah rujukan, median hari ke FKRTL, % dx sama |
| `profil_peserta` | edisi × provinsi × segmen × kelompok usia × JK | jumlah peserta |
| `indikator_klaim` | kab/kota × tipe RS × INA-CBG | outlier LOS, readmisi 30 hari, calon klaim ganda, selisih verifikasi — bahan skrining risiko |
| `kohort_penyakit` | edisi (DM/TB/KM/KIA/COVID) × bulan | utilisasi & biaya per peserta kohort vs Reguler |

## 4. Ekspektasi (gagal = build gagal)

- Unik: `peserta (edisi, peserta_id)`, `kunjungan_fktp (edisi, kunjungan_fktp_id)`, `kunjungan_fkrtl (edisi, kunjungan_fkrtl_id)`, `diagnosis_sekunder (edisi, kunjungan_fkrtl_id, dx_kode)`.
- Relasi: […]% kunjungan → peserta (edisi sama); rujukan → kunjungan FKTP; diagnosis sekunder → kunjungan FKRTL.
- Rentang: `tgl_pulang ≥ tgl_datang`; `biaya_verifikasi_rp ≤ biaya_tagih_rp`; biaya ≥ 0; `bobot > 0` (kecuali KIA-Anak: null).
- Jumlah baris L2 = L1 per tabel per edisi (tidak ada baris hilang).
- Rekonsiliasi: total `biaya_tagih_rp` per edisi sama dengan sumber.

## 5. Engine & penempatan

- **Mesin JavaScript Pipeline Builder memuat input ke memori sebagai baris** (`web/src/lib/server/runner.ts`). Cocok
  untuk ratusan ribu baris, tidak untuk […] baris × 57 kolom. Maka:
  - **L0 → L1**: Python transforms di Code Repository (DuckDB + pyarrow, streaming per file, Parquet), terlacak
    lineage-nya sebagai pipeline kode. Stata (.dta) hanya terbaca di sini.
  - **L1 → L2 → L3** (sejak 2026-10-26): satu Pipeline Builder **"Pipeline Data Sampel BPJS: Data Mentah → Siap
    Analisis"** (`bpjs_sampel/builder_pipeline.py`) dengan **mesin DuckDB lokal** (compute `duckdb`,
    `api/pipeline_duckdb.py`), semuanya node visual (lihat §8 "Pipeline Builder visual"). Sebelumnya L1 → L2 di Code
    Repository dan L2 → L3 di "Pipeline Gold Data Sampel BPJS" (langkah SQL, kini di `pipelines/Arsip`).
- Istilah untuk pengguna dan juri: **Arsip Sumber** (raw) → **Data Mentah** (bronze) → **Data Bersih** (silver) →
  **Siap Analisis** (gold). Kode, nama folder di Files dan kunci tetap bronze/silver/gold.
- Project baru di Files: **"Data Sampel BPJS 2025"** dengan folder `raw/ bronze/ silver/ gold/ pipelines/`. Pipeline
  demo JKN lama dibiarkan (tidak dihapus), tidak dipakai lagi.

## 6. Keamanan

Data sampel resmi, sudah dianonimkan (nomor peserta pseudonim, tanpa nama/NIK/ID faskes), tetapi tetap data kesehatan
riil: project diberi marking **"Data Sampel BPJS"**, hanya akun tim yang berhak; file tidak pernah masuk git
(`/Data BPJS/` di `.gitignore`); ikuti ketentuan penggunaan Data Sampel BPJS Kesehatan.

### Akses per peran (demo, 2026-10-28)

Tab **Keamanan & Akses** di /aip-jkn (`api/aip/akses.py`, `GET /api/aip/akses`, admin: `POST /api/aip/akses/bangun`)
menghitung apa yang bisa dibuka tiap akun demo per tahap, dengan pemeriksaan yang sama dengan Data Lineage →
Permissions. Empat lapis, berurutan:

| Lapis | Aturan |
|---|---|
| Peran Project "Data Sampel BPJS 2025" | Pengelola Data → Editor (semua tahap); Pengembang, tim nasional, analis, auditor KC, verifikator → Discoverer (tahu ada, tanpa baris) |
| Peran folder/berkas (fitur baru, `auth.granted_operations`) | `silver` → Pengembang; `gold`, `ml` → Pengembang + tim nasional; `pipelines` → Pengembang; jalur peserta (raw/kepesertaan … gold/peserta_klaim_berisiko) → Verifikator |
| Kebijakan baris: Project "Portal Data BPJS per Peran (demo)" | 4 restricted view atas `gold` (profil_faskes, klaim_bulanan_provinsi, klaim_kabkota, klaim_berisiko): auditor KC = baris provinsinya (atribut `provinsi_kode`: Kota 31, Kabupaten 32, Raya 35); tim nasional semua; analis semua kecuali klaim_berisiko; tamu Viewer portal tanpa baris |
| Penanda | `Indikasi Fraud · Internal` (keluaran Swarm) → tim nasional; **`Data Individu BPJS (demo)`** baru pada tipe Nexus per klaim/peserta (Klaim FKRTL, Klaim Berisiko, Peserta Klaim Berisiko, Skor Risiko Klaim ML, Tag Indikasi Fraud) → tim nasional, pengelola, pengembang, semua administrator |

Tahap dipisah dengan peran folder karena semua tahap satu Project (folder dicari menurut nama oleh pipeline, AIP dan
ML). Foundry lebih menyarankan satu Project per tahap; penanda tidak dipakai untuk tahap karena menurun ke Siap Analisis
saat build berikutnya (platform belum punya `stop_propagating` di pipeline). Objek Nexus dijaga penanda, bukan Project
datanya, karena itu tipe per klaim/peserta diberi penanda. Graf lineage: `/lineage?graph=bpjsakses` (dibuka dalam
Permissions, semua peran dibandingkan).

## 7. Keputusan

Diputuskan 2026-10-20: 7 edisi sekaligus; bobot tidak diterapkan (kolom saja).

## 8. Status implementasi (2026-10-20)

Kode: `api/bpjs_sampel/` — `catalog.py` (sumber), `bronze.py` (L0→L1), `silver.py` (L1→L2 + ekspektasi).
Keluaran lokal: `data/bpjs-sampel/` (tidak di git). Jalankan dari `api/`: `python -m bpjs_sampel.bronze`, lalu
`python -m bpjs_sampel.silver`.

**Incremental per edisi (2026-10-26)** — untuk run berulang tanpa menghitung ulang semua edisi:
`python -m bpjs_sampel.silver_incremental [edisi|tabel]` membandingkan `_manifest.parquet` bronze
(sha256 per file per edisi) dengan `silver/_state_incremental.json`, lalu hanya menulis ulang partisi
`edisi=` yang berubah dengan transform yang sama (`bpjs_spec.select_sql`); flag stateful FKRTL disegarkan
dari kolom silver yang dibutuhkannya saja, rujukan hanya untuk edisi yang berubah, dimensi dihitung utuh.
Terukur: build pertama dari kosong 235 dtk dengan hasil identik snapshot (baris per dataset, total biaya
dan hitungan flag FKRTL sama); tanpa perubahan 0 dtk; satu edisi (tb) 48 dtk. Snapshot `silver.py` tetap
jadi rekonsiliasi berkala dan fallback saat state belum ada.

| Lapisan | Hasil | Waktu |
|---|---|---|
| L1 bronze | 34 file → 5 dataset, […] baris, + `_label_nilai` ([…] label), `_katalog_kolom`, `_manifest` (sha256) — 0,58 GB | ±2 menit |
| L2 silver | `peserta` […] · `kunjungan_fktp` […] · `kunjungan_fkrtl` […] · `diagnosis_sekunder` […] · `tindakan_nonkapitasi` […] · `rujukan` […] · `dim_icd10` […] · `dim_icd10_rinci` […] · `dim_inacbg` 974 · `dim_wilayah` 516 · `dim_profil_faskes` […] — 0,7 GB | ±2 menit |

Ekspektasi: 20/20 lolos (`silver/_laporan_kualitas.json`). Flag (7 edisi): […] calon klaim ganda, […] selisih
verifikasi, […] LOS ekstrem, […] tanggal lahir pengganti, […] nama diagnosis diperbaiki.

### Temuan saat implementasi

- **Bug pembacaan strL (pandas)**: tabel teks panjang Stata hanya dimuat bila label nilai belum dibaca; membaca label
  dulu membuat kolom teks (nama diagnosis, deskripsi INA-CBG, prosedur) keluar sebagai nomor penunjuk. Label kini
  dibaca dari reader terpisah.
- **Cacat sumber: huruf "go" terhapus** di sebagian teks (`FKL16A`, `FKL18A`, sebagian lain): "goitre" → "itre",
  "Gonarthrosis" → "narthrosis", "gonococcal" → "nococcal" ([…]% nilai teks). Perbaikan otomatis berbasis kamus
  menghasilkan tebakan keliru (mis. "glucan" → "glucagon"), jadi silver hanya memulihkan 17 kata yang sudah diperiksa
  (`GO_REPAIR` di `silver.py`), menandai barisnya (`flag_*_diperbaiki`), dan nama ICD-10 3 digit selalu diambil dari
  referensi resmi yang bersih. Teks asli tetap di bronze.
- **Cacat sumber: kolom diagnosis sekunder tertukar** (diperiksa 2026-10-27 di semua baris): di edisi dm, kia_ibu dan
  kia_anak `FKL24A` (label: kode ICD-10 3 digit) berisi kode-nama ("I69-Sequelae of stroke…") dan `FKL24B` (label:
  kode dan nama) berisi kodenya, di […] baris. Di semua edisi tiga karakter pertama `FKL24A` = tiga karakter
  pertama `FKL24`, jadi `dx_icd3` kini = tiga karakter pertama, dipakai bila berbentuk kategori ICD-10 (huruf, angka,
  angka/huruf), selain itu kosong — juga untuk […] baris nonkapitasi berkode pengganti `9999`. Sebelum perbaikan ini
  (SPEC_VERSION 6) `diagnosis_sekunder.dx_icd3` di tiga edisi itu berisi teks, sehingga hanya […] dari […]
  baris cocok ke `dim_icd10`; sesudahnya […].
- **Label provinsi 38 tidak ada di file covid** (audit 2026-10-27): buku label edisi covid tidak memuat `FKP05_NEW` dan
  `FKP16_NEW`, sehingga […] kunjungan FKTP covid (dan […] rujukannya) punya kode provinsi 38 tanpa nama.
  Sejak SPEC_VERSION 7 semua tabel memakai satu buku label (`label_siap`), dan edisi yang sama sekali tidak punya label
  untuk sebuah kolom meminjam label dari edisi lain — hanya bila ≥ 2 edisi melabeli kolom itu dan sepakat untuk setiap
  kodenya. Kolom yang artinya berbeda per edisi (mis. `FKP14`, `FKL15`, `FKL17`: tiap edisi menomori diagnosisnya sendiri,
  […] kode berbeda arti) tidak pernah meminjamkan. (Silver Code Repository, yang bukan produsen sejak 2026-10-26, belum
  memakai aturan ini.)
- **Kode tanpa label di file BPJS mana pun** (teksnya tetap kosong, dicatat di kamus data): `PSTV17` 99 ([…] peserta
  reguler), `FKP20` 56 ([…] kunjungan), `FKL14` 9 ([…] klaim covid), `PNK10` 99 ([…] tindakan), `PSTV04` 9 ([…] peserta).
- **Tanggal lahir mustahil**: tanggal lahir sesudah 2024 → `usia_akhir_2024` kosong; tanggal lahir yang sangat tua
  dibiarkan.
- Audit 2026-10-27 lainnya lolos: kunci unik, semua referensi antartabel utuh (peserta, kunjungan FKTP rujukan, wilayah,
  INA-CBG, ICD-10 — kecuali 4 diagnosis sekunder V66/V78/W66 yang tak ada di referensi), tanggal, LOS, selisih, flag,
  dan 15 rekonsiliasi gold = silver (jumlah klaim, biaya tagih/verifikasi, kunjungan, peserta, rujukan, flag).
- Label kode 9 "MISSING"/"TIDAK TERDEFINISI" → teks NULL, kode tetap.
- Deskripsi INA-CBG berbeda bahasa antar-edisi (Indonesia/Inggris); `dim_inacbg` memakai yang paling sering.
- **Tagihan = tarif grouper, peer setarif** (2026-10-27, SPEC_VERSION 8): pada […]% klaim tiap edisi `biaya_tagih_rp`
  = `tarif_inacbg_rp` + top-up special CMG (`sa/sp/rr/si/sd_tarif_rp`). Peer lama (INA-CBG × tipe RS × regional ×
  edisi) tidak memisahkan tabel tarif: dari […] klaim ≥ 1,5× median peer, […]% hanya karena kepemilikan, kelas
  rawat atau tahun tarif yang berbeda, […]% karena top-up, […]% karena tagihan di luar tarif. Sejak v8 `klaim` membawa
  `topup_subakut_rp` (FKL34), `topup_khusus_rp` (FKL37+40+43+46), `sisa_di_luar_tarif_rp` (tagih − tarif − top-up),
  `tahun_tarif` dan `peer_tarif_id`; biaya `klaim_berisiko` dibandingkan dengan peer setarif (`t_peer_tarif`: + kepemilikan,
  kelas rawat, tahun tarif; p90 LOS tetap per INA-CBG × tipe RS × regional), dan alasannya menyebut penyebabnya (di luar
  tarif, top-up subakut/kronis, top-up khusus). Klaim berisiko ≥ 1,5× peer (≥ 30 klaim peer): […] → […], […] di antaranya
  bertagihan di luar tarif. Upcoding tidak terlihat dengan membandingkan klaim dengan kodenya sendiri (klaimnya pindah
  kode/keparahan), jadi `profil_faskes` kini membawa `klaim_inap_berat` dan `pct_keparahan_berat` untuk dibandingkan
  dengan faskes setipe. Output lain identik dengan v7 (`EXCEPT ALL` dua arah); `peserta_klaim_berisiko.skor_risiko_maks`
  mengikuti skor baru.
- **Semua klaim jadi objek Nexus** (2026-10-27, SPEC_VERSION 9): output gold baru `klaim_fkrtl` ([…] baris, kunci
  `klaim_id` = edisi:kunjungan_fkrtl_id, semua fakta node `klaim`) membacking tipe Nexus **Klaim FKRTL (BPJS)** lewat mesin
  objek *live* (`api/ontology_live.py`): objek dibaca langsung dari Parquet dengan DuckDB, tidak diindeks ke JSON, jadi
  batas 50.000 objek per tipe tidak berlaku. Pencarian dengan filter, urutan, agregasi dan histogram atas […] klaim
  < 1 detik; satu objek 0,07 detik; Search Around ke/dari Profil Faskes, Kab/Kota, Kode INA-CBG, Diagnosis dan Klaim
  Berisiko lewat foreign key. Edit (action) disimpan terpisah per objek dan dilapiskan di setiap baca dan query; membuat
  atau menghapus objek ditolak (barisnya milik dataset). Didefinisikan di `nexus.LIVE_TYPES` / `LIVE_LINKS`
  (`nexus.ensure_live`).
- **Dua pipeline** (2026-10-27): pipeline 1 (SPEC_VERSION 10) menambah ke `klaim_fkrtl` bobot sampel (`bobot`), jumlah
  edisi tiap klaim (`jumlah_edisi`; […] klaim tercatat identik di 2+ edisi) dan `klaim_kanonik` (satu salinan per klaim,
  reguler dulu: hitungan nasional memakai `klaim_kanonik = true`). Pipeline 2 **"Fakta Klaim BPJS: Siap Analisis → Fakta
  Klaim"** (`bpjs_sampel/fakta_pipeline.py`, kanvas sendiri, jadwal: setiap build pipeline 1 yang menulis `klaim_fkrtl`)
  menulis `klaim_fkrtl_fakta` = semua klaim + fakta: di luar tarif ([…]), skema COVID ([…]), kelas di atas hak ([…]),
  rawat inap tumpang tindih ([…]; pasangan persis lewat self-join, rujukan di hari yang sama tidak termasuk), klaim rawat
  jalan berganda di hari sama ([…]), readmisi ≤ 30 hari di RS sama ([…]), pindah RS ≤ 1 hari ([…]). Setiap angka
  dicocokkan dengan kueri pembanding independen. Tipe Nexus Klaim FKRTL (BPJS) membaca dataset ini. Penjelasan setiap
  aturan dan fakta: tab **Aturan Indikasi** di /aip-jkn (`GET /api/aip/aturan`, `aip/aturan.py`).

### Di platform (2026-10-20)

- **Penyimpanan lokal**: project "Data Sampel BPJS 2025" ada di space "Data Sampel BPJS (lokal)" (storage `local`,
  `bpjs_sampel/local_storage.py`). Semua file ada di `data/drive/` (NVMe), tetap tampil di /drive, 0 objek di S3.
- **Code Repository "Pipeline Data Sampel BPJS"** (`bpjs_sampel/repo/`): 6 transform bronze (FKRTL dibagi dua folder
  raw karena batas 2 GiB per build) dan 8 transform silver. Repositori berhenti di silver; `gold_dasar` dihapus
  (commit `950baffda6`) dan folder `gold/_dasar` dipindah ke trash.
- **Pipeline Builder "Pipeline Gold Data Sampel BPJS"** (`bpjs_sampel/gold_pipeline.py`, mesin **DuckDB lokal**):
  membaca silver langsung ([…] klaim FKRTL, […] kunjungan FKTP, […] rujukan, […] peserta + 3 dimensi).
  7 sumber → `provinsi`, `klaim` (klaim + readmisi 30 hari) → 7 dataset gold (`klaim_kabkota`, `klaim_bulanan`,
  `indikator_inacbg`, `kunjungan_fktp_bulanan`, `penyakit_teratas`, `alur_rujukan`, `profil_peserta`). Setiap keluaran
  dicek: primary key tanpa NULL, jumlah baris ≥ 1. Build 7/7 dalam ±30 detik. Rekonsiliasi: jumlah klaim, biaya tagih
  (Rp […]), kunjungan FKTP, rujukan dan peserta di gold sama persis dengan silver; readmisi […] dari
  […] rawat inap.
- **Provinsi memakai kode 38** (spec v12, 2026-10-23): dimensi gold `wilayah` (kab/kota → provinsi) dari kolom `*_38`
  data (kunjungan FKTP, tempat tinggal peserta, klaim FKRTL). 26 kab/kota Papua pindah ke Papua Barat Daya (92), Papua
  Selatan (95), Papua Tengah (96) dan Papua Pegunungan (97). Semua kolom provinsi gold, objek Nexus, skor ML dan roster
  analis provinsi memakai kode ini lewat kab/kota. Kode 34 (`kabkota_kode // 100`) hanya disimpan di
  `wilayah.provinsi_34_kode`. Kode 38 per klaim FKRTL baru berpindah bertahap Juli–Desember 2024, jadi tidak dipakai
  langsung untuk mengelompokkan. Total klaim tetap […]: Papua Barat lama ([…]) = Papua Barat […] + Papua
  Barat Daya […]. SQL node `wilayah` tidak boleh menyebut nama node yang membacanya (`provinsi`, `kabkota`), karena
  langkah SQL menarik setiap node yang namanya muncul sebagai kata di teksnya. Kolomnya karena itu `*_nama`.
- **Mesin DuckDB lokal** (Build settings → Engine): tiap output dikompilasi menjadi satu SQL DuckDB dan dijalankan API
  atas file Parquet di disk, sehingga tidak ada baris yang lewat mesin JavaScript. SQL langkahnya memakai dialek DuckDB. Editor
  menyimpan 1.000 baris pertama tiap input; preview node transform dijalankan di DuckDB atas semua baris (0,1–3 detik).
- Kolom kelompok yang kosong di sumber (tipe FKRTL, regional tarif, poli, tipe faskes tujuan, segmen) menjadi
  kelompok `tidak tercatat`. Barisnya tidak dibuang, dan primary key Pipeline Builder menolak NULL.
- Kolom biaya bertipe DOUBLE (float): `sum()` DuckDB menghasilkan HUGEINT (decimal128 di Parquet), jadi di-cast `::DOUBLE`.
- **Lineage** lengkap: gold ← Pipeline Gold ← silver ← transform silver ← bronze ← transform bronze ← folder raw
  (65 node, semuanya tersambung). Graf tersimpan "Data Sampel BPJS: raw → bronze → silver → gold" di
  `/lineage?graph=bb6c6d906c`. Transform yang file-nya dihapus dari repositori tidak lagi tampil di lineage.
- Build dari skrip: `gold_pipeline.ensure()` menyimpan file pipeline lalu mengantre build, dan API yang sedang berjalan
  menjalankannya. Syaratnya `BLUESANDAI_SERVICE_TOKEN` tetap di `.env.local` (git-ignored), sehingga skrip dan API memakai
  token yang sama.

### Pipeline Builder visual: Data Mentah → Siap Analisis (2026-10-26)

Satu pipeline gaya Palantir dari bronze sampai gold, tanpa langkah SQL: **120 node** (13 sumber, 69 transform, 31
join, 7 union), 824 langkah, 26 output (10 Data Bersih di `silver/`, 16 Siap Analisis di `gold/`), 16 checkpoint.

- **Tombol "Dari Arsip Sumber"** (panel bawah, di samping Data dictionary): langkah sebelum pipeline ini — 34 file `.dta`
  BPJS (7 edisi, 4,21 GB, […] baris) dibaca Code Repository (`bronze.py`) menjadi 6 dataset Data Mentah. Isinya:
  langkah transform, tiap file (edisi, ukuran, baris, sha256 — dihitung ulang dari file di Files: 34/34 cocok), tiap
  dataset (baris = jumlah baris filenya, build dan commit-nya), dan kode `bronze.py` di setiap commit yang dipakai
  (ee9fe87947, dd430fff74, 2a226d9058). Disimpan di file pipeline sebagai `upstream` (`bpjs_sampel/builder_upstream.py`,
  dimuat `nexus._upstream` saat pipeline dibuat ulang).
- **Data Bersih**: satu transform per fakta (Rename/Cast/Trim/Conditional dari `bpjs_spec.SPEC`), kode → label lewat
  **Mapping join** ke buku label (`kunci` = kolom|edisi|kode, MISSING/TIDAK TERDEFINISI → null), nama diagnosis
  dipulihkan (Find and replace regex). FKRTL: **Union by name** bagian 1 + 2, lalu Join jumlah diagnosis sekunder dan
  p99 LOS per INA-CBG, flag lewat Window + Conditional column. Dimensi: Union + Aggregate (Mode, First value).
- **Siap Analisis**: Join ke `wilayah` / `provinsi` / `dim_inacbg` / statistik peer, Aggregate dengan hitungan
  bersyarat (FILTER), Percentile, Window (lead untuk readmisi, row number untuk peringkat), Formula (persentase,
  skor risiko), Concatenate untuk kunci objek. `ibukota_provinsi` kini dataset referensi di `bronze/_meta`.
- **Kesetaraan**: 26/26 output identik dengan dataset yang digantikannya (Code Repository silver, gold SQL v12):
  skema, jumlah baris, `EXCEPT ALL` dua arah 0. Satu pilihan seri (`dim_icd10_rinci` M0645, dua ejaan nama sama
  seringnya) kini deterministik: seri ke abjad pertama.
- **Pengalihan**: output menulis ke item Files yang sama (state output diisi dulu, `nexus._seed_outputs`), jadi tipe
  Nexus, AIP dan ML tetap membaca dataset yang sama. Build penuh ±8,5 menit; build ulang dengan checkpoint ±2,5 menit.
  `nexus.build()` membangun pipeline ini. Transform silver di Code Repository masih ada (bisa menulis silver yang sama
  bila dijalankan); `dim_icd10` (dari buku xlsx) dan `_laporan_kualitas` tetap dari Code Repository.
- **Mesin DuckDB lokal**, tambahan untuk pipeline ini (`web/src/lib/externalSql.ts`, `api/pipeline_duckdb.py`):
  Union, Mapping join, Formula, Percentile/Mode; **checkpoint** dihitung sekali per isi (hash statement + identitas
  input) ke `data/duckdb-checkpoints/<pipeline>/`, dipakai bersama build dan preview; **fusi proyeksi** (langkah baris
  per baris berurutan menjadi satu SELECT: 250 CTE bertumpuk butuh > 8 GB berapa pun barisnya); join memegang input
  kanannya di memori (input Arrow tak punya statistik); statement dicek dengan parser DuckDB.

### Berikutnya

1. Hubungkan dataset gold (dan silver untuk drill-down) ke Nexus.
