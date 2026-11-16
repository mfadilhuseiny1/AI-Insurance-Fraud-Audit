# AI Agent Swarm Branch API v1 — audit modular untuk Kantor Cabang

Permintaan (2026-11-14): *"rancang skema API-nya biar software ini modular — client harus kasih apa ke API kita, kita return apa —
lalu masukkan ke API documentation, jadi tiap KC bisa pakai API kita untuk running audit modular."*

| Berkas | Isi |
|---|---|
| `docs/API_CABANG_V1.md` | dokumen ini: ringkasan, analisis, desain, daftar endpoint |
| `docs/openapi_cabang_v1.json` | spesifikasi mesin (OpenAPI 3.1, lolos `openapi-spec-validator`), dibaca tab **API Documentation** |
| `web/src/app/api/api-docs/cabang/route.ts` | menyajikan spesifikasi ke tab (dan `?format=openapi` untuk diunduh) |
| `web/src/components/aip/ApiDocsCabang.tsx` | bagian visual "AI Agent Swarm Branch API v1" di tab API Documentation |

Semua contoh angka diambil dari data **sintetis** run `gen3_kc2`, KC Makassar (`sul-7371`): `data/aip/cabang/gen3_kc2/kc_sul-7371.json`,
`graf_sul-7371/`, `runs.json`, `proyek.json`; contoh IoT dari dunia sintetis IoMT (`data/synthetic-iomt/`, RS fiktif, klaim KLM-000734).
Identitas pasien di contoh hanya token. Tidak ada nama vendor model di dokumen ini; model bahasa disebut **Model AI (LLM)**.

---

## Ringkasan untuk manajer

**Apa yang didapat KC.** Setiap Kantor Cabang bisa menjalankan audit klaim RS di wilayahnya sendiri, dari sistemnya sendiri, lewat
satu API. KC mengirim klaim (dan rekam medis SATUSEHAT bila ada); sistem menilai setiap klaim, menandai yang janggal, meminta tim agen AI
membaca klaim yang meragukan, menyusun Box Karantina dan laporan KC; verifikator KC memutuskan setiap klaim yang direkomendasikan.

**Kirim apa → dapat apa.**

| KC mengirim | KC menerima |
|---|---|
| klaim dalam format kontrak platform (`KlaimIn`), opsional Bundle rekam medis per klaim | laporan validasi per baris + id klaim yang stabil |
| pilihan audit: tema klinis (satu, beberapa, semua), tahap yang dipakai, batas biaya | estimasi biaya sebelum mulai, lalu status per tahap dan biaya berjalan |
| — | laporan KC: angka sampul, bab, exhibit, Box Karantina + TSM per RS, berkas tiap klaim yang menjelaskan *kenapa* dalam bahasa awam |
| putusan verifikator (terbukti / sesuai / perlu investigasi) | efek putusan ke buku besar indikasi dan ke estimasi kerugian |

**Modular.** KC boleh memakai hanya yang dibutuhkan: *skor saja*, *skor + tag*, *audit penuh dengan AI Agent Swarm*, atau *laporan saja*
dari audit yang sudah ada. Output satu tahap adalah input tahap berikutnya, dengan id klaim yang sama.

**Contoh nyata (sintetis).** KC Makassar, 18–31 Des 2024: 1.664 klaim senilai Rp 1,46 M dari 90 RS → 86 klaim ragu dibaca tim agen AI
→ 37 klaim direkomendasikan ke verifikator (Rp 176,0 jt), estimasi kerugian Rp 115,6 jt; 44 RS di Box Karantina (2 ditindak, 2 dibina,
40 dibebaskan). Biaya Model AI seluruh audit: **$0,117**.

**IoT alat medis.** Jalur masuk kedua: sensor clamp pada kabel daya (tanpa membuka alat) ventilator, mesin hemodialisis, bed / monitor
ICU, dan pompa infus mencatat **kapan alat jalan, siaga atau mati, dan berapa lama** (tanpa tanda vital). Gateway RS mengikat setiap alat ke satu
pasien dan satu kunjungan (*binding sesi*), menandatangani bacaan, dan menjangkarkan akar Merkle episode ke log anti-ubah sebelum klaim
diajukan. Sistem membandingkan yang ditagih dengan yang terukur — mis. kode 96.72 (ventilasi ≥ 96 jam berturut-turut) padahal
ventilator paling lama jalan 66 jam tanpa putus — dan selisihnya menjadi tag Indikasi dengan harga selisih tarif INA-CBG.

**Status jujur.** Dari 72 endpoint di spesifikasi, **12 sudah aktif** hari ini (laporan, putusan, buku besar, proyek & audit, kirim
klaim ke engine realtime, kontrak rekam medis, verifikasi paket bukti alat, laporan audit IoMT sintetis, bukti perangkat di klaim RS);
**60 masih rencana**. Setiap endpoint rencana menunjuk pengganti yang bisa dipakai sekarang bila ada. Tab API Documentation memberi
badge **aktif** / **rencana** per endpoint.

**Keamanan data.** Identitas pasien, rekam medis, dan id klaim tidak pernah dikirim ke Model AI (LLM): tim agen hanya membaca berkas
fakta tanpa identitas, delapan klaim per batch dengan id disamarkan. Setiap hasil membawa penanda *sintetis / riil* dan marking
(*Internal*, atau *Rahasia* untuk RS kelompok A / jalur ditindak / TSM penuh). Data riil hanya diproses di instans lokal yang terpisah
dan tidak masuk buku besar nasional. RS tidak pernah menerima skor (tidak ada *tipping-off*).

---

## 1. Analisis: apa yang ada hari ini

### 1.1 Alur yang sudah berjalan (dibaca dari kode)

| Tahap | Di mana | Bentuk hari ini |
|---|---|---|
| Kontrak klaim | `api/aip/layanan.py` `KlaimIn` | ketat: tipe, pola, rentang; field tak dikenal ditolak |
| Kirim klaim | `POST /api/aip/realtime/v1/klaim` (`routes.py ingest`) | ≤ 500 klaim, `tunggu=true` → keputusan engine (model produksi + rule engine), **bukan ML v7** |
| Rekam medis | `api/aip/realtime/rme.py`, `docs/RME_SATUSEHAT_KONTRAK.md`, `docs/rme_satusehat_bundle.schema.json` | Bundle FHIR R4 SATUSEHAT per klaim (kontrak `rme-1`), dicocokkan kode; sinyal `RME_*` menambah skor rule, bukan fitur model |
| Rule engine | `api/aip/realtime/modus.py` | sinyal per klaim → modus Permenkes 16/2019 → tag buku besar |
| Skor ML v7 + Indikasi + Swarm | `testing/v5.py`, `testing/swarm_v5_adk.py`, `testing/laporan_cabang.py` | **offline** (skrip): 646 fitur (124 klaim + 500 graph 4 relasi + 22 mekanisme) → zona TAHAN / RAGU / LOLOS; RAGU dibaca 3 spesialis + hakim, gerbang τ 0,72 |
| Laporan KC | `testing/laporan_cabang.py` + `testing/graf_cabang.py` → `data/aip/cabang/<run>/kc_<kc>.json`, `graf_<kc>.json` | berkas JSON, dibaca rute web `GET /api/swarm-cabang` |
| Buku besar | `api/aip/realtime/cabang_tag.py` | `POST /cabang/tag` (admin) menulis antrean; `GET /cabang/tag/{run}` merangkum |
| Putusan | `web/src/app/api/swarm-cabang/route.ts` POST → `POST /api/aip/realtime/v1/cabang/putusan` | per klaim: terbukti / sesuai / investigasi; disimpan per run dan diteruskan ke buku besar |
| Box Karantina | `api/aip/karantina.py` (nasional), `box` + `berkas_rs` di laporan KC | kelompok A–D/Z per estimasi kerugian; TSM → ditindak / dibina / dibebaskan |
| Tema | `laporan_cabang.TEMA`, `tema_klaim`, `--tema` | bab ICD-10 diagnosis utama; audit bisa dibatasi ke tema tertentu |
| Proyek & audit | `web/src/app/api/swarm-cabang/proyek/route.ts`, `data/aip/cabang/proyek.json` | GET proyek + audit + tema; POST `aksi` proyek_baru / audit_baru / mulai / batal (admin) / hapus |
| Bukti perangkat di klaim RS | `api/aip/realtime/integrasi.py` `BuktiPerangkat` | `POST /faskes/klaim` membawa `bukti_perangkat` (terverifikasi, mendukung lama rawat / keparahan, sha256 paket) → mitigasi engine |
| Verifikasi paket bukti alat | `POST /api/faskes-verify`, `web/src/lib/faskesVerify` | bacaan bertanda tangan (ECDSA secp256k1, hash kanonik), akar Merkle per versi, lalu cek ke rantai: registri alat (`wasDeviceValidAt`) dan jangkar sebelum klaim |
| Audit IoMT sintetis | `synthetic-iomt/audit.py`, `GET /api/iomt-audit`, `api/aip/laporan_iomt.py` | aturan `vent_run_96`, `niv_as_invasive`, `vent_standby`, `hd_short`, `icu_days`, `no_device_trace`, `anchor_mismatch`, `late_anchor`, … pada dunia sintetis (RS fiktif) |

Sedang dibangun agen lain (dirujuk sebagai *rencana*, tidak disentuh): pipeline runner run penuh (dengan `--tema`, batas biaya, berkas
status/progres) dan lapisan verifikasi IoT cabang (`testing/iot_cabang.py`, blok `iot` per klaim di laporan KC).

### 1.2 Celah yang ditemukan

1. **Tidak ada HTTP untuk menjalankan audit.** Skor ML v7, swarm, dan laporan hanya bisa dijalankan dengan skrip. KC tidak bisa memulai
   audit dari sistemnya.
2. **Tidak ada pembatasan per KC.** Token API pribadi (`bsai_pat_…`) melekat ke pengguna, bukan ke KC; siapa pun yang punya akses bisa
   membaca laporan KC lain. Perlu kunci per KC.
3. **`skor` hari ini ≠ ML v7.** Engine realtime memakai model produksi yang ter-deploy; ML v7 hanya ada di jalur offline. Dokumentasi
   tidak boleh menyebut `POST /realtime/v1/klaim` sebagai skor ML v7.
4. **Klaim RAGU yang belum dibaca swarm menjadi DIBERSIHKAN.** Di `laporan_cabang.muat`, skor hakim yang kosong diisi 0
   (`nan_to_num`), sehingga gabungan tidak pernah mencapai τ. Bila swarm berhenti di batas biaya, klaim yang belum dibaca diam-diam
   dianggap bersih. v1 menetapkan status terpisah **`RAGU_BELUM_DIBACA`** dan menghitungnya di `GET /audit/{id}/swarm`
   (`ragu_belum_dibaca`). Perbaikan di `laporan_cabang.py` di luar lingkup tugas ini.
5. **Id klaim 32 bit.** `KLM-` + 8 hex MD5 dari kunci internal: untuk 50.000 klaim peluang tabrakan ≈ 25%. v1 menjadikan id **diberikan
   server**, dicek unik di KC saat unggah, dan mengembalikan pemetaan `kunjungan_fkrtl_id → klaim_id`.
6. **Graf per klaim baru saja tersedia.** Run lama punya satu `graf_<kc>.json` (±1,2 MB untuk 93 klaim); sejak 2026-11-15 graf disimpan
   per klaim (`graf_<kc>/<KLM-id>.json`, `?graf=1&kasus=`). v1 menyajikannya per klaim untuk kedua bentuk.
7. **Laporan hanya utuh.** Satu JSON ±400 KB per KC; v1 memecahnya: sampul, bab, berkas RS, berkas klaim, peta.

### 1.3 Prinsip desain

- **Satu audit = satu run.** `audit_id` sama dengan id run yang sudah dipakai buku besar dan putusan (`^[a-z0-9_]{3,40}$`), jadi rute
  lama dan baru merujuk hal yang sama.
- **Tahap sebagai modul.** Setiap tahap menyimpan output di bawah audit; tahap berikutnya membacanya. Tahap bisa dijalankan belakangan
  (`POST /audit/{id}/tahap/{tahap}`).
- **Jujur soal status.** `x-status` per operasi; `x-hari-ini` menunjuk pengganti yang sudah ada.
- **Konvensi platform.** Nama field Bahasa Indonesia, galat bergaya FastAPI (`detail`), versi di path seperti `/api/aip/realtime/v1`.
- **White-box wajib.** Klaim TAHAN / PERIKSA tanpa penjelasan = galat server, bukan balasan yang sah.

---

## 2. Sumber daya dan siklus hidup

```
kunci KC ─┐
          ▼
proyek ── audit ──(sumber)── unggahan (potongan ≤ 500 klaim + rekam medis)   | jendela engine realtime | audit lain
            │
            ├─ tahap klaim     → klaim_id (KLM-…) per baris
            ├─ tahap iot       → blok iot per klaim: ditagih vs terukur, aturan, selisih tarif   (input: klaim + sesi binding + bacaan alat)
            ├─ tahap skor      → skor_model, zona TAHAN/RAGU/LOLOS, pendorong          (input: klaim)
            ├─ tahap indikasi  → tag aturan + tag model + tag IoT, kekuatan             (input: skor + sinyal rule + blok iot)
            ├─ tahap swarm     → pendapat 3 spesialis + hakim, gabungan, PERIKSA/DIBERSIHKAN/RAGU_BELUM_DIBACA  (input: klaim RAGU)
            ├─ tahap box       → kelompok A–Z per RS, TSM, jalur; estimasi kerugian per klaim (input: tag + antrean)
            ├─ tahap laporan   → bab, exhibit, berkas RS, berkas klaim (white-box), graf, peta
            └─ putusan         → buku besar indikasi + koreksi estimasi kerugian          (input: berkas klaim)
```

**Id yang stabil**

| Id | Pola | Asal |
|---|---|---|
| `kc` | `^[a-z]{3}-\d{1,5}$` (mis. `sul-7371`) | wilayah KC (demo: kab/kota satu provinsi, bukan peta resmi) |
| `proyek_id` | `^[A-Za-z0-9_-]{3,64}$` | penyimpanan proyek (sedang dibangun) |
| `audit_id` | `^[a-z0-9_]{3,40}$` | = id run (`gen3_kc2`) |
| `unggahan_id` | `^upl_[a-z0-9]{12}$` | sesi unggah |
| `klaim_id` | `^KLM-[0-9A-F]{8}$` | diberikan server, unik per KC, sama di semua tahap |
| `faskes_id` | 32 hex | profil RS (`faskes_profil_id`) |

**Status audit:** `draf → antre → berjalan → selesai | gagal | dibatalkan | berhenti` (batas biaya). `lanjut` meneruskan dari tahap
pertama yang belum selesai; batch swarm yang sudah dibayar diambil dari cache.

**Status tahap:** `menunggu`, `berjalan`, `selesai`, `dilewati`, `gagal`, `berhenti_batas_biaya`, `dibatalkan`.

**Keputusan klaim:** `TAHAN` (skor model ≥ ambang TAHAN), `PERIKSA` (RAGU dan gabungan ≥ τ), `DIBERSIHKAN` (RAGU, dibaca swarm, di bawah
τ), `RAGU_BELUM_DIBACA` (RAGU, swarm tidak sempat membaca: tetap perlu dilihat manusia), `LOLOS`.

**Paket modular**

| Paket | Cara | Biaya Model AI |
|---|---|---|
| Skor saja | `POST /skor` (sinkron, ≤ 500) atau audit `tahap: ["skor"]` | 0 |
| Skor + tag | `POST /skor` dengan `indikasi: true` | 0 |
| Audit penuh | audit `tahap: ["skor","indikasi","swarm","box","laporan"]` | swarm + narasi (contoh: $0,117) |
| Laporan saja | audit `sumber: {jenis: "audit", audit_id}` dengan tema lain, atau `POST /audit/{id}/tahap/laporan` setelah putusan | narasi saja (`opsi.narasi=false` → 0) |

---

## 3. Autentikasi dan peran

| Skema | Header | Status | Untuk |
|---|---|---|---|
| **Kunci API KC** | `Authorization: Bearer bsai_kc_<kc>_…` | rencana | sistem KC; satu kunci per KC, hanya data KC itu |
| Token API pribadi | `Authorization: Bearer bsai_pat_…` | aktif | pengguna (per orang, belum dibatasi per KC) |
| Sesi | cookie `BSAI_SESSION` | aktif | browser |
| Token faskes | `X-Ingest-Token` | aktif | SIMRS rumah sakit, **bukan** untuk KC |
| **Kunci gateway RS** | `Authorization: Bearer bsai_gw_<faskes>_…` | rencana | gateway AIoT rumah sakit: alat, binding, bacaan, jangkar; scope `iot:alat`, `iot:sesi`, `iot:kirim`; tidak pernah membaca hasil cek |

**Scope kunci KC:** `cabang:baca`, `cabang:klaim` (unggah, skor sinkron), `cabang:jalankan` (membuat dan menjalankan audit: memakai
biaya), `cabang:putusan`, `cabang:webhook`.

**Aturan:**
- Kunci diterbitkan admin BPJS pusat (`POST /kunci`), rahasia tampil sekali, disimpan sebagai hash, bisa dicabut seketika.
- Resource milik KC lain → `403 kc_scope`, tanpa membocorkan apakah resource itu ada.
- Putusan harus atribusi manusia: dengan kunci KC, `verifikator` (username yang terdaftar di KC itu) wajib; dengan sesi atau token
  pribadi, pemanggilnya. Rekaman menyimpan `oleh` dan `via`.
- Admin pusat membaca semua KC; tidak ada kunci KC untuk RS.

---

## 4. Konvensi umum

- **Versi:** path `/api/aip/cabang/v1`. Penambahan field / endpoint tetap v1; perubahan yang memutus → v2. `reproduksi.versi_api` di
  setiap hasil.
- **Galat:** `{"detail": "<pesan>", "code": "<kode>"}` (+ `galat[]` untuk validasi).

| HTTP | `code` |
|---|---|
| 400 | `isian_tidak_valid` |
| 401 | `tidak_masuk`, `kunci_tidak_sah` |
| 403 | `kc_scope`, `butuh_scope`, `butuh_admin` |
| 404 | `tidak_ada` |
| 409 | `status_konflik`, `idempotensi_konflik`, `potong_berbeda`, `batas_biaya` |
| 412 | `versi_berubah` (putusan dengan `If-Match`) |
| 413 | `terlalu_besar` (> 500 klaim atau > 32 MB per potongan) |
| 422 | `validasi` |
| 429 | `batas_laju` + `Retry-After` |
| 503 | `tahap_tidak_tersedia` |

- **Halaman:** `?limit=` (≤ 500, default 100) `&kursor=` → `{butir, kursor_berikut, total}`.
- **Idempotensi:** header `Idempotency-Key` (24 jam) pada POST yang membuat sesuatu atau memakai biaya; kirim ulang = balasan sama
  (`Idempotent-Replay: true`), body berbeda = 409. Potongan unggahan idempoten per nomor (isi sama = tanpa efek; isi beda sebelum
  `selesai` = 409 kecuali `?ganti=true`).
- **Batas laju (default rencana, per kunci KC):** 60 baca/menit, 10 tulis berbiaya/menit, 20 potongan/menit, `/skor` maks 4 serentak
  (sama dengan `layanan.CONCURRENT`). Header `RateLimit-Limit/Remaining/Reset`.
- **Batas ukuran:** 500 klaim per potongan atau per `/skor`, 100 potongan (50.000 klaim) per unggahan, 3.000 entri per Bundle.
- **Batas biaya:** `batas_biaya_usd` per audit (wajib bila swarm atau narasi aktif, maks 50) + kuota bulanan per KC. Batch 8 klaim
  hanya mulai di bawah batas; mencapai batas → tahap `berhenti_batas_biaya`, peristiwa `audit.batas_biaya_tercapai`, sisa klaim RAGU
  menjadi `RAGU_BELUM_DIBACA` (tidak pernah dianggap bersih). Lima batch gagal beruntun menghentikan tahap.
- **Estimasi biaya:** dari laju historis ≈ $0,0013 per klaim ragu (4 panggilan Model AI per 8 klaim) + narasi; contoh 86 klaim ragu →
  44 panggilan, 271.829 token masuk, 27.845 token keluar, $0,115.

---

## 5. Perlindungan data

| Data | Disimpan di | Ke Model AI (LLM)? | Ke respons API? |
|---|---|---|---|
| Identitas peserta (`peserta_id`, nama, NIK, no kartu) | penyimpanan audit KC | **tidak** | **tidak**: hanya pseudonim (`P-0950`) dan hash entitas |
| Bundle rekam medis FHIR | penyimpanan audit KC (hapus bersama audit) | **tidak**: dicocokkan kode | tidak; hanya temuan + ringkasan struktur |
| Id klaim, tanggal, nama RS | penyimpanan audit KC | **tidak** (id disamarkan K1–K8 per batch) | ya, untuk KC pemilik |
| Berkas fakta klaim RAGU | sementara, per batch | ya: kode INA-CBG, kategori, persentil terhadap klaim normal, fitur mekanisme, hitungan riwayat/jaringan, nama rule yang menyala; **tanpa** skor model, label, atau nama skema | — |
| Angka agregat exhibit | laporan | ya (narasi), kalimat yang angkanya tidak bersumber dibuang (cek angka) | ya |
| Bacaan alat IoT (nyala, arus, mode) | penyimpanan audit KC | **tidak**: cek IoT ditulis kode | ya: jam per mode, sesi, harian |
| Binding (token pasien, kunjungan, operator) | penyimpanan audit KC | **tidak** | ya: hanya token HMAC, tidak pernah identitas asli |

- **Sintetis vs riil:** setiap hasil membawa `penanda` (`sintetis`, `sumber_data`, `marking`, `ledger`). Run riil (sampel BPJS, pakta
  integritas) hanya di instans lokal terpisah (`CABANG_DIR`), `ledger: false`, tidak pernah ditulis ke buku besar aplikasi ini.
- **Marking:** *Internal* untuk semua; *Rahasia* juga untuk RS kelompok A, jalur ditindak, atau TSM penuh (aturan yang sama dengan Box
  Karantina nasional).
- **Tanpa tipping-off:** kunci KC hanya untuk BPJS; RS memakai token faskes dan hanya menerima tanda terima.
- **Hapus:** `DELETE /audit/{id}` menghapus klaim mentah, rekam medis, dan hasil di KC; tag yang sudah masuk buku besar nasional tetap
  (jejak audit).

---

## 6. White-box dan reproduksibilitas

**Setiap klaim TAHAN / PERIKSA** (`GET /audit/{id}/klaim/{klaim_id}`) wajib membawa:
- `penjelasan.paragraf` — satu paragraf awam: apa yang janggal, kenapa tanda fraud, bagaimana sistem memutuskan, di mana melihatnya;
- `penjelasan.modus` + `jenis_fraud[]` — modus Permenkes 16/2019 dengan keyakinan dan bukti;
- `penjelasan.bukti[]` — satu fakta per baris dibanding yang biasa;
- `penjelasan.langkah[]` — langkah verifikator;
- `penjelasan.bisa_wajar_bila` — kapan klaim masih bisa sah;
- `angka` — skor model, persentil di atas normal, ambang RAGU/TAHAN, skor hakim, gabungan, τ, porsi dorongan (klaim / graph / mekanisme);
- `jejak[]` — data lineage per tahap (rule engine, aturan telaah, ML v7, AI Agent Swarm, keputusan) dengan rinciannya;
- `estimasi_kerugian` dengan `dasar` dalam kata-kata.

Penjelasan ditulis kode dari fakta klaim (`testing/penjelasan_cabang.py`, tanpa LLM). Pendapat agen ada di endpoint teknis terpisah
(`/agen`).

**Reproduksi** (`reproduksi` di audit, laporan, skor):

```json
{"versi_api": "1.0.0",
 "model": {"nama": "ML v7", "fitur": 646, "blok": {"klaim": 124, "graph": 500, "mekanisme": 22}, "seed_latih": 3},
 "ambang": {"tahan": 0.7832, "periksa": 0.2931, "ragu": 0.121},
 "swarm": {"pilihan": "V5b", "tau": 0.72, "versi_prompt": "swarm-v5-p3", "klaim_per_batch": 8, "id_disamarkan": true, "model_ai": "Model AI (LLM)"},
 "rule_engine": {"sinyal_fitur_model": 45}, "rekam_medis": {"kontrak": "rme-1"},
 "data_uji": "tidak dipakai untuk melatih atau memilih apa pun"}
```

- Skor dan tag deterministik untuk versi model + riwayat KC + urutan klaim yang sama (klaim ditambahkan urut tanggal).
- Swarm: urutan batch dikocok dengan `benih` tetap; setiap batch di-cache per (audit, batch, versi prompt) — menjalankan ulang memberi
  jawaban yang sama tanpa biaya. Panggilan Model AI baru tidak dijamin identik bit demi bit; yang direkam adalah jawabannya.
- `versi_prompt` adalah alias netral yang dipetakan 1:1 ke kunci cache internal.

---

## 7. Daftar endpoint

Basis rencana: `/api/aip/cabang/v1` (disingkat `…`). **aktif** = bisa dipanggil hari ini; **rencana** = dirancang, belum dibangun.

| # | Metode | Path | Tujuan | Siapa | Status | Pakai dulu (hari ini) |
|---|---|---|---|---|---|---|
| **KC · akses & katalog** |
| 1 | GET | `…/sehat` | kesiapan tahap, versi, batas default | kunci KC / login | rencana | — |
| 2 | GET | `…/saya` | KC, scope, kuota & biaya terpakai | kunci KC / login | rencana | — |
| 3 | GET | `…/tema` | katalog tema klinis (+ jumlah klaim, ada rekam medis) | kunci KC / login | rencana | — |
| 4 | POST | `…/kunci` | terbitkan kunci API KC | admin | rencana | token API pribadi |
| 5 | GET | `…/kunci` | daftar kunci | admin | rencana | — |
| 6 | DELETE | `…/kunci/{kunci_id}` | cabut kunci | admin | rencana | — |
| 7 | GET | `/api/aip/realtime/v1/rme/skema` | kontrak rekam medis + sinyal RME | login | **aktif** | |
| **Orkestrator audit** |
| 8 | POST | `…/proyek` | buat proyek | kunci KC (jalankan) | rencana | `POST /api/swarm-cabang/proyek {aksi: "proyek_baru"}` |
| 9 | GET | `…/proyek` | daftar proyek | kunci KC (baca) | rencana | |
| 10 | GET | `…/proyek/{proyek_id}` | satu proyek + audit | kunci KC (baca) | rencana | |
| 11 | POST | `…/audit` | buat audit draf + estimasi biaya | kunci KC (jalankan) | rencana | |
| 12 | GET | `…/audit` | daftar audit | kunci KC (baca) | rencana | `GET /api/swarm-cabang` |
| 13 | GET | `…/audit/{audit_id}` | satu audit (konfigurasi, reproduksi, penanda) | kunci KC (baca) | rencana | `GET /api/swarm-cabang?run=` |
| 14 | POST | `…/audit/{audit_id}/mulai` | mulai (202) | kunci KC (jalankan) | rencana | `POST /api/swarm-cabang/proyek {aksi: "mulai"}` (admin) |
| 15 | GET | `…/audit/{audit_id}/status` | tahap, progres, biaya | kunci KC (baca) | rencana | |
| 16 | POST | `…/audit/{audit_id}/batal` | batalkan | kunci KC (jalankan) | rencana | |
| 17 | POST | `…/audit/{audit_id}/lanjut` | lanjutkan (batas biaya baru opsional) | kunci KC (jalankan) | rencana | |
| 18 | POST | `…/audit/{audit_id}/tahap/{tahap}` | jalankan / ulang satu tahap | kunci KC (jalankan) | rencana | |
| 19 | DELETE | `…/audit/{audit_id}` | hapus data audit | kunci KC (jalankan) | rencana | |
| 20 | GET | `…/audit/{audit_id}/peristiwa` | log peristiwa (tarik) | kunci KC (baca) | rencana | |
| 21 | POST | `…/webhook` | daftarkan webhook | kunci KC (webhook) | rencana | |
| 22 | GET | `…/webhook` | daftar webhook | kunci KC (webhook) | rencana | |
| 23 | DELETE | `…/webhook/{webhook_id}` | hapus webhook | kunci KC (webhook) | rencana | |
| 23a | GET | `/api/swarm-cabang/proyek` | proyek + audit + tema (`?tema=1&proyek=`) | login | **aktif** | |
| 23b | POST | `/api/swarm-cabang/proyek` | `aksi`: proyek_baru, audit_baru (tema, batas_usd), mulai / batal (admin), hapus | login / admin | **aktif** | |
| **Kirim klaim (+ rekam medis)** |
| 24 | POST | `…/unggahan` | buka unggahan bertahap | kunci KC (klaim) | rencana | `POST /api/aip/realtime/v1/klaim` |
| 25 | PUT | `…/unggahan/{unggahan_id}/potong/{no}` | ≤ 500 klaim + Bundle; validasi per baris | kunci KC (klaim) | rencana | |
| 26 | POST | `…/unggahan/{unggahan_id}/selesai` | kunci unggahan, ringkasan | kunci KC (klaim) | rencana | |
| 27 | GET | `…/unggahan/{unggahan_id}` | status + baris ditolak | kunci KC (baca) | rencana | |
| 28 | POST | `…/rekam-medis/validasi` | uji struktur satu Bundle | kunci KC (klaim) | rencana | `POST /api/aip/realtime/v1/faskes/rme/validasi` (token faskes) |
| 29 | POST | `/api/aip/realtime/v1/klaim` | klaim ke engine realtime (`tunggu` → keputusan) | login | **aktif** | |
| **IoT alat medis** (lihat §12) |
| I1 | POST | `…/iot/gateway` | terbitkan kunci gateway RS (+ kunci tokenisasi pasien) | admin | rencana | |
| I2 | POST | `…/iot/alat` | daftarkan alat + kunci publik | kunci gateway (iot:alat) | rencana | registri alat di kontrak bukti, dicek `POST /api/faskes-verify` |
| I3 | GET | `…/iot/alat` | daftar alat per RS / jenis + utilisasi | kunci KC / gateway | rencana | |
| I4 | DELETE | `…/iot/alat/{alat_id}` | cabut alat sejak waktu tertentu | kunci gateway / admin | rencana | |
| I5 | POST | `…/iot/sesi` | **mulai binding** alat ↔ pasien (token) ↔ kunjungan | kunci gateway (iot:sesi) | rencana | |
| I6 | POST | `…/iot/sesi/{sesi_id}/selesai` | tutup binding (dilepas / pulang / pindah / meninggal) | kunci gateway (iot:sesi) | rencana | |
| I7 | POST | `…/iot/sesi/{sesi_id}/pindah` | pindah pasien = tutup + buka (atomik) | kunci gateway (iot:sesi) | rencana | |
| I8 | GET | `…/iot/sesi` | binding per alat / pasien / kunjungan | kunci KC / gateway | rencana | |
| I9 | POST | `…/iot/bacaan` | bacaan bertanda tangan (JSON / NDJSON, ≤ 5.000) | kunci gateway (iot:kirim) | rencana | |
| I10 | POST | `…/iot/pemakaian` | sesi pemakaian siap pakai dari platform AIoT | kunci gateway (iot:kirim) | rencana | |
| I11 | POST | `…/iot/episode/{episode_id}/jangkar` | akar Merkle → log anti-ubah, tanda terima | kunci gateway (iot:kirim) | rencana | aplikasi faskes + `POST /api/faskes-verify` |
| I12 | PUT | `…/iot/episode/{episode_id}/klaim` | tautkan episode ↔ kunjungan / SEP | kunci gateway (iot:kirim) | rencana | |
| I13 | GET | `…/iot/episode/{episode_id}/bukti` | verifikasi akar, tanda tangan, registri, jangkar | kunci KC (baca) | rencana | `POST /api/faskes-verify` |
| I14 | GET | `…/iot/aturan` | katalog aturan IoT | kunci KC (baca) | rencana | `GET /api/iomt-audit` |
| I15 | POST | `…/iot/cek` | cek IoT ≤ 500 klaim → blok `iot` | kunci KC (klaim) | rencana | |
| I16 | GET | `…/audit/{audit_id}/klaim/{klaim_id}/iot` | blok `iot` satu klaim (white-box) | kunci KC (baca) | rencana | |
| I17 | GET | `…/audit/{audit_id}/iot` | ringkasan IoT audit (`L.iot`) | kunci KC (baca) | rencana | `GET /api/iomt-audit` |
| I18 | GET | `…/iot/utilisasi` | data dashboard utilisasi per RS / alat | kunci KC (baca) | rencana | |
| I19 | POST | `/api/faskes-verify` | verifikasi paket bukti alat (offline + rantai) | login | **aktif** | |
| I20 | GET | `/api/iomt-audit` | laporan audit IoMT (dunia sintetis) | login | **aktif** | |
| I21 | POST | `/api/aip/realtime/v1/faskes/klaim` | klaim RS + `bukti_perangkat` | token faskes | **aktif** | |
| **Skoring ML v7** |
| 30 | POST | `…/skor` | skor + zona + pendorong (+ tag) sinkron | kunci KC (klaim) | rencana | `POST /realtime/v1/klaim?tunggu` (model produksi), `POST /api/aip/fraud/v1/skor` |
| 31 | GET | `…/audit/{audit_id}/klaim` | hasil per klaim, filter | kunci KC (baca) | rencana | `GET /api/swarm-cabang?run=&kc=` (`kasus`) |
| **Indikasi** |
| 32 | GET | `…/audit/{audit_id}/indikasi` | tag aturan + model, kekuatan, ambang | kunci KC (baca) | rencana | idem (`indikasi`) |
| **AI Agent Swarm** |
| 33 | GET | `…/audit/{audit_id}/swarm` | dibaca, PERIKSA, dibersihkan, belum dibaca, biaya | kunci KC (baca) | rencana | |
| 34 | GET | `…/audit/{audit_id}/klaim/{klaim_id}/agen` | pendapat spesialis + hakim (teknis) | kunci KC (baca) | rencana | |
| **Box Karantina** |
| 35 | GET | `…/audit/{audit_id}/box` | kelompok A–Z, jalur, RS | kunci KC (baca) | rencana | idem (`box`, `berkas_rs`) |
| 36 | GET | `…/audit/{audit_id}/rs/{faskes_id}` | berkas RS: TSM + bukti, jalur, temuan | kunci KC (baca) | rencana | |
| 37 | POST | `/api/aip/realtime/v1/cabang/tag` | tulis antrean run ke buku besar | admin | **aktif** | |
| 38 | GET | `/api/aip/realtime/v1/cabang/tag/{run}` | isi run di buku besar | login | **aktif** | |
| **Laporan KC** |
| 39 | GET | `…/audit/{audit_id}/laporan` | sampul, bab, berkas (`?lengkap=true`) | kunci KC (baca) | rencana | `GET /api/swarm-cabang?run=&kc=` |
| 40 | GET | `…/audit/{audit_id}/laporan/bab/{bab_id}` | satu bab + exhibit + narasi | kunci KC (baca) | rencana | |
| 41 | GET | `…/audit/{audit_id}/klaim/{klaim_id}` | berkas klaim white-box | kunci KC (baca) | rencana | idem + `&graf=1` |
| 42 | GET | `…/audit/{audit_id}/klaim/{klaim_id}/graf` | jaringan klaim | kunci KC (baca) | rencana | `&graf=1` (semua sekaligus) |
| 43 | GET | `…/audit/{audit_id}/peta` | kab/kota + titik RS (sintetis) | kunci KC (baca) | rencana | |
| 44 | GET | `/api/swarm-cabang` | run / laporan lengkap / graf | login | **aktif** | |
| **Putusan verifikator** |
| 45 | PUT | `…/audit/{audit_id}/klaim/{klaim_id}/putusan` | catat putusan + efek | kunci KC (putusan) | rencana | `POST /api/swarm-cabang` |
| 46 | DELETE | `…/audit/{audit_id}/klaim/{klaim_id}/putusan` | tarik putusan | kunci KC (putusan) | rencana | idem `status: ""` |
| 47 | GET | `…/audit/{audit_id}/putusan` | putusan + total + efek kerugian | kunci KC (baca) | rencana | idem (`verifikasi`) |
| 48 | POST | `/api/swarm-cabang` | putusan (web) → buku besar | login | **aktif** | |
| 49 | POST | `/api/aip/realtime/v1/cabang/putusan` | putusan → tag buku besar | login | **aktif** | |

---

## 8. Spesifikasi inti (contoh dari data nyata)

Skema lengkap dan contoh setiap endpoint ada di `docs/openapi_cabang_v1.json`. Di bawah ini alur terpenting.

### 8.1 Kirim klaim

`POST …/unggahan` → `{"unggahan_id": "upl_4c1d0e9a7b2f", "batas": {"klaim_per_potong": 500, "potong_maks": 100, "byte_per_potong": 33554432, "entri_bundle_maks": 3000}}`

`PUT …/unggahan/upl_4c1d0e9a7b2f/potong/1` — body `{"klaim": [{"klaim": KlaimIn, "rekam_medis": Bundle?}, …]}`. Baris 0 adalah klaim
nyata `k:59602` (L-1-20-I, RS Kelas B · Vertikal · Kota Makassar, Rp 21.027.800), baris 1 klaim PCI dengan Bundle dari
`docs/contoh_rme_klaim_pci.json`, baris 2 sengaja salah. Balasan (galat dan ringkasan rekam medis adalah keluaran asli
`KlaimIn` dan `rme.validasi`):

```json
{"unggahan_id": "upl_4c1d0e9a7b2f", "potong": 1, "baris": 3, "diterima": 2, "ditolak": 1, "ulang": false,
 "hasil": [
  {"baris": 0, "kunjungan_fkrtl_id": "k:59602", "status": "diterima", "klaim_id": "KLM-2BDA4A57"},
  {"baris": 1, "kunjungan_fkrtl_id": "CONTOH-1", "status": "diterima", "klaim_id": "KLM-<diberikan server>",
   "rekam_medis": {"terbaca": true, "jumlah_resource": {"Patient": 1, "Encounter": 1, "Condition": 2, "Procedure": 3, "Observation": 50,
                   "MedicationRequest": 6, "MedicationAdministration": 6, "Device": 1}, "masalah": [], "peringatan": []}},
  {"baris": 2, "kunjungan_fkrtl_id": "CONTOH-2", "status": "ditolak",
   "galat": [{"medan": "dx_primer_icd3", "pesan": "String should match pattern '^[A-Z][0-9]{2}$'", "nilai": "I21.4"}]}]}
```

`POST …/unggahan/{id}/selesai {"potong": 4}` → `{"status": "siap", "klaim": 1664, "ditolak": 0, "duplikat": 0, "rs": 90, "periode":
{"dari": "2024-12-18", "sampai": "2024-12-31"}, "rekam_medis": {"dikirim": 0, …}}` (run gen3_kc2 tidak membawa rekam medis).

### 8.2 Buat, mulai, pantau audit

`POST …/audit` (header `Idempotency-Key`):

```json
{"kc": "sul-7371", "proyek_id": "p_ujicoba_ml_v7_makassar", "judul": "Uji coba ML v7 · KC Makassar",
 "sumber": {"jenis": "unggahan", "unggahan_id": "upl_4c1d0e9a7b2f"}, "tema": "semua",
 "tahap": ["skor", "indikasi", "swarm", "box", "laporan"], "opsi": {"rekam_medis": true, "narasi": true, "graf": true},
 "batas_biaya_usd": 1.0}
```

`tema` bisa `"semua"` atau daftar kode (`["I"]` = Jantung & pembuluh darah, `["I","N"]`). `sumber` juga bisa
`{"jenis": "jendela", "dari", "sampai"}` (klaim yang sudah masuk engine realtime untuk RS wilayah KC) atau `{"jenis": "audit",
"audit_id"}` (memakai ulang output tahap audit lain, mis. laporan tema lain tanpa biaya swarm). Balasan `201`: audit `draf` dengan
`tahap_efektif`, `estimasi` (`klaim 1664, ragu_perkiraan 86, biaya_usd_perkiraan 0.12`), `reproduksi`, `penanda`.

`POST …/audit/gen3_kc2/mulai` → `202`. `GET …/audit/gen3_kc2/status` (keadaan akhir run nyata):

```json
{"audit_id": "gen3_kc2", "status": "selesai", "progres": 1.0,
 "tahap": [
  {"tahap": "klaim", "status": "selesai", "diproses": 1664, "total": 1664},
  {"tahap": "skor", "status": "selesai", "diproses": 1664, "hasil": "TAHAN 7 · RAGU 86 · LOLOS 1571"},
  {"tahap": "indikasi", "status": "selesai", "diproses": 126, "hasil": "84 tag aturan · 84 tag model"},
  {"tahap": "swarm", "status": "selesai", "diproses": 11, "total": 11, "satuan": "batch (8 klaim)", "hasil": "86 dibaca · PERIKSA 30 · DIBERSIHKAN 56"},
  {"tahap": "box", "status": "selesai", "diproses": 44, "satuan": "RS", "hasil": "ditindak 2 · dibina 2 · dibebaskan 40"},
  {"tahap": "laporan", "status": "selesai", "diproses": 10, "satuan": "bab", "hasil": "41 exhibit · 33 narasi · 1 kalimat dibuang cek angka"}],
 "biaya": {"usd_perkiraan": 0.117, "batas_usd": 1.0, "swarm": 0.115, "narasi": 0.0015, "panggilan": 45, "gagal": 0, "berhenti": null}}
```

### 8.3 Skor saja (sinkron)

`POST …/skor {"klaim": [{"klaim": <k:59602>}], "indikasi": true}` →

```json
{"model": "ML v7", "ambang": {"tahan": 0.7832, "periksa": 0.2931, "ragu": 0.121},
 "hasil": [{"klaim_id": "KLM-2BDA4A57", "skor_model": 0.3662, "di_atas_normal": 0.9927, "zona": "RAGU",
            "dorongan": {"klaim": 0.7747, "graph": 0.1182, "mekanisme": 0.107},
            "pendorong": [{"fitur": "skor rule sebelum mitigasi", "kontribusi_log_odds": 1.645}, …],
            "rule_engine": {"skor": 45.1, "sinyal": [{"kode": "PASANGAN_KODE_LANGKA", "label": "Pasangan diagnosis–kode hampir tak pernah ada"}]},
            "indikasi": [{"tag": "TIDAK_SESUAI_INDIKASI", "sumber": "aturan", "kekuatan": "kuat"},
                         {"tag": "RISIKO_ML_TINGGI", "sumber": "model", "kekuatan": "sedang"}]}]}
```

Kekuatan mengikuti `laporan_cabang.indikasi_kc`: tag aturan *kuat* bila skor ≥ ambang periksa, tag model *sedang* bila skor ≥ periksa
dan < TAHAN. Fitur graph membaca riwayat klaim KC di server (55.932 klaim historis untuk KC Makassar); klaim dalam satu permintaan
ditambahkan urut tanggal.

### 8.4 Hasil

- `GET …/audit/gen3_kc2/laporan` → `sampul` (1.664 klaim, Rp 1.455.957.300, RAGU 86, PERIKSA 30, TAHAN 7, antrean 37, nilai antrean
  Rp 175.962.800, estimasi kerugian Rp 115.605.200), 10 bab, 41 exhibit, berkas 21 RS dan 37 klaim, `catatan`, `reproduksi`, `penanda`.
- `GET …/laporan/bab/ringkasan` → teks bab dan exhibit "skala" dengan `baris`, `fakta`, `sumber`, `narasi.makna/implikasi`.
- `GET …/box` → kelompok A (4 RS, Rp 69.344.600), B (3, Rp 24.533.300), C (5, Rp 17.857.400), D (3, Rp 3.196.700), Z (29, Rp 673.200);
  jalur ditindak 2, dibina 2, dibebaskan 40; kriteria TSM tertulis.
- `GET …/rs/faa82ee4834efbe8a3541990cd5e07b0` → RS Kelas A · Vertikal · Kota Makassar, kelompok A, **ditindak**: terstruktur 4 poin (6
  modus, 9 kode INA-CBG, 5 RS lain dengan modus sama), sistematis 3 poin (6 hari, laju tag 21,7% vs rata-rata KC 7,6%), masif 4 poin;
  marking `Internal + Rahasia`.
- `GET …/klaim/KLM-2BDA4A57` → berkas white-box: paragraf penjelasan, modus M15 (tindakan tidak sesuai indikasi medis), 5 bukti, 4
  langkah, *bisa wajar bila*, angka (skor 0,3662, di atas 99,27% normal, hakim 0,60, gabungan 0,796, τ 0,72), estimasi kerugian
  Rp 10.513.900 dengan dasarnya, jejak 5 tahap.
- `GET …/klaim/KLM-2BDA4A57/graf` → klaim fokus, 15 klaim pembanding (RS sama 10, kode sama 5), 4 relasi, cincin ±14 hari.

### 8.5 Putusan

`PUT …/audit/gen3_kc2/klaim/KLM-2BDA4A57/putusan {"status": "terbukti", "catatan": "…", "verifikator": "verif.makassar1"}` →

```json
{"klaim_id": "KLM-2BDA4A57", "status": "terbukti", "oleh": "verif.makassar1", "via": "kunci KC", "versi": 1,
 "efek": {"ledger": {"diputus": 1, "dibiarkan_sumber_lain": 0, "status": "terbukti"},
          "estimasi_kerugian": {"sebelum_rp": 115605200, "sesudah_rp": 115605200, "terkonfirmasi_rp": 10513900}}}
```

Efek (sama dengan `cabang_tag.putuskan` hari ini): **terbukti** → tag dikonfirmasi, kerugian berpindah dari *estimasi* ke
*terkonfirmasi*; **sesuai** → tag ditolak bila swarm satu-satunya sumber, estimasi kerugian turun sebesar kerugian klaim itu (di sini
menjadi Rp 105.091.300); bila sumber lain juga menandai, reviewer buku besar yang memutuskan (`dibiarkan_sumber_lain`);
**investigasi** → tetap terbuka, catatan disimpan. Box Karantina nasional membaca status tag ini setiap kali dibangun ulang dari buku
besar (`POST /api/aip/realtime/v1/box`, admin). Angka `estimasi_kerugian` di balasan adalah rencana v1 (hari ini hanya bagian `ledger`
yang dikembalikan).

---

## 9. Webhook dan peristiwa

Peristiwa: `unggahan.selesai`, `audit.tahap_selesai`, `audit.batas_biaya_tercapai`, `audit.laporan_siap`, `audit.gagal`,
`audit.dibatalkan`, `putusan.dicatat`, `iot.tidak_sesuai` (blok `iot` sebuah klaim = tidak_sesuai), `iot.bacaan_tanpa_pasien`
(bacaan alat di luar binding mana pun), `iot.jangkar_terlambat` (episode dijangkarkan setelah klaim diajukan). Webhook IoT hanya ke
KC, tidak pernah ke gateway RS.

```http
POST https://sim-kc.contoh.go.id/audit/webhook
X-Cabang-Peristiwa: audit.laporan_siap
X-Cabang-Id: evt_00000041
X-Cabang-Tanda: sha256=<HMAC-SHA256(rahasia, body)>

{"id": "evt_00000041", "jenis": "audit.laporan_siap", "audit_id": "gen3_kc2", "kc": "sul-7371", "pada": "2026-11-13T16:02:11+07:00",
 "data": {"bab": 10, "exhibit": 41, "antrean": 37}}
```

Dikirim minimal sekali (dedupe dengan `id`), dicoba ulang dengan backoff eksponensial sampai 24 jam; jawaban 2xx = diterima. Tanpa
webhook: `GET …/audit/{id}/peristiwa?sejak=`. Isi peristiwa hanya angka ringkas, tanpa data klaim.

---

## 10. Peta implementasi (urutan yang disarankan)

1. **Kunci KC + scope** di `api/auth.py` (prefix `bsai_kc_`, kolom `kc`, scope; middleware menolak path `/api/aip/cabang/v1` milik KC
   lain). Tanpa ini tidak ada endpoint v1 yang aman.
2. **Rute baca di atas berkas yang sudah ada** (`api/aip/cabang_v1.py`): `/audit`, `/audit/{id}`, `/laporan`, `/laporan/bab`, `/klaim`,
   `/klaim/{id}`, `/klaim/{id}/graf`, `/box`, `/rs/{id}`, `/indikasi`, `/swarm`, `/tema` — membaca `kc_<kc>.json` / `graf_<kc>/`.
   Ini membuat 12 endpoint aktif tanpa menyentuh pipeline.
3. **Putusan v1** membungkus `cabang_tag.putuskan` + `verifikasi.json` (menggantikan logika di rute web).
4. **Unggahan + audit + mulai/status/batal/lanjut** di atas pipeline runner dan `proyek.json` (berkas status → `/status`, batas biaya →
   `berhenti_batas_biaya`), dengan status `RAGU_BELUM_DIBACA` (celah 4).
5. **IoT baca** di atas lapisan IoT cabang yang sedang dibangun: `/audit/{id}/iot`, `/klaim/{id}/iot`, `/iot/aturan` membaca blok `iot`
   laporan KC; `/iot/episode/{id}/bukti` memakai ulang pemeriksa `web/src/lib/faskesVerify` (format yang sama).
6. **IoT tulis**: kunci gateway (`bsai_gw_`), registri alat, binding sesi dengan aturan tumpang tindih, bacaan + jangkar.
7. **`/skor` sinkron ML v7** (fitur graph dari riwayat KC), webhook, kuota bulanan.

Saat satu endpoint dibangun, ubah `x-status` di generator spesifikasi menjadi `aktif` — tab API Documentation langsung mengikutinya.

---

## 11. Keputusan desain dan trade-off

| Keputusan | Alasan | Harga |
|---|---|---|
| `audit_id` = id run | rute lama (buku besar, putusan) dan baru merujuk hal yang sama | id run harus unik lintas KC (sudah: pola satu namespace) |
| Tahap sebagai modul dengan output tersimpan | KC bisa skor saja, tambah swarm belakangan, ulang laporan tanpa biaya | penyimpanan per tahap per audit |
| Unggahan bertahap (potongan ≤ 500) | sama dengan batas `KlaimBatchIn`; Bundle rekam medis bisa besar; potongan gagal bisa dikirim ulang | tiga panggilan alih-alih satu |
| `klaim_id` diberikan server | mencegah tabrakan 32 bit; KC tidak perlu tahu cara membuatnya | KC menyimpan pemetaan dari laporan validasi |
| Putusan wajib atribusi manusia | jejak audit dan akuntabilitas | sistem KC mengirim `verifikator` |
| `RAGU_BELUM_DIBACA` terpisah | batas biaya tidak boleh membersihkan klaim diam-diam | antrean manusia bisa bertambah saat batas kecil |
| Box Karantina setelah swarm | estimasi kerugian Box menghitung antrean hasil swarm | Box belum ada untuk paket "skor saja" |
| Spesifikasi berkas, bukan dari FastAPI | sebagian besar endpoint belum ada; tab tetap jujur | dua sumber sampai v1 dibangun; saat rute v1 ada, bagiannya bisa dibaca dari `/openapi.json` |
| Nama field Indonesia, galat `detail` | konsisten dengan seluruh API realtime | — |
| Contoh dari data nyata | KC developer melihat bentuk dan besaran sebenarnya | contoh mengikuti run gen3_kc2; dibangkitkan ulang bila data berubah |
| IoT sebagai jalur masuk kedua ke Indikasi | pemakaian alat adalah bukti independen dari klaim; hasilnya tag seperti sinyal rule | butuh gateway di RS; RS tanpa gateway = `tanpa_bukti`, bukan tuduhan |
| Kunci gateway terpisah dari kunci KC | RS menulis bukti, KC membaca hasil; tanpa tipping-off | dua jenis kunci untuk dikelola |
| Binding eksplisit (sesi) | bacaan alat tanpa pasien tidak bisa dipakai menuduh klaim mana pun; satu alat tidak bisa "dipinjam" dua klaim | gateway / perawat harus mencatat pasang-lepas |
| Pasien hanya token HMAC per RS | identitas asli tidak pernah lewat API IoT | KC menghitung token yang sama dari klaim untuk mencocokkan |
| Peristiwa binding ikut akar Merkle | binding mundur (dibuat setelah klaim) terlihat dan ditandai | binding harus dicatat sebelum jangkar |
| Hanya pola daya, tanpa tanda vital | sensor clamp pada kabel daya (tanpa membuka alat); tidak ada data klinis pasien | tidak bisa membuktikan keparahan atau cara ventilasi, hanya jalan / siaga / mati dan lamanya |

---

## 12. IoT alat medis (jalur masuk kedua)

Permintaan (2026-11-15): *"make sure API also support IoT integration"* dan *"IoT binding — device ID and patient ID and session"*.

### 12.1 Alur

```
alat medis ──(clamp arus di kabel daya)──► gateway RS (platform AIoT) ──(kunci gateway)──► API v1 /iot
  ventilator · mesin HD · bed/monitor ICU · pompa infus      │                                     │
  hanya: status (ventilator jalan / siaga / mati;            │ tanda tangan alat per bacaan          ├─ binding sesi alat ↔ pasien ↔ kunjungan
  dialisis jalan / idle) dan durasi — TANPA tanda vital       │ sesi pemakaian                        ├─ bacaan / sesi pemakaian
                                                              │                                       ├─ jangkar akar Merkle → log anti-ubah (sebelum klaim)
                                                              ▼                                       └─ cek IoT per klaim → blok `iot`
                                                                                                          tidak_sesuai → tag Indikasi + rekomendasi (selisih tarif INA-CBG)
```

### 12.2 Binding sesi: alat ↔ sesi ↔ pasien / kunjungan ↔ klaim

Satu **sesi** mengikat **satu alat** (`alat_id`) ke **satu pasien** (token) dan **satu kunjungan** (`kunjungan_fkrtl_id` atau token SEP)
selama satu jendela waktu.

| Aturan | Akibat |
|---|---|
| Satu alat tidak boleh terikat ke dua pasien pada waktu yang sama | `409 alat_terikat` |
| Satu kunjungan boleh punya banyak alat (ventilator + bed ICU + pompa infus) | — |
| Sesi harus di dalam jendela rawat kunjungan (masuk–pulang, toleransi 2 jam) | `422 di_luar_rawat` |
| Bacaan di luar binding mana pun | diterima, ditandai `tanpa_pasien`, **tidak** dipakai mencocokkan klaim; peristiwa `iot.bacaan_tanpa_pasien` |
| Bacaan tanpa `sesi_id` | server mengikat lewat alat + waktu ke sesi yang terbuka saat itu |
| Pindah pasien | `POST …/sesi/{id}/pindah`: tutup (alasan `pindah`) + buka sesi baru, atomik |
| Setiap peristiwa binding (mulai, selesai, pindah, tautan klaim) | di-hash dan menjadi daun di akar Merkle episode; binding yang dibuat setelah klaim diajukan ditandai `sesi_terlambat` |

`POST …/iot/sesi` (kunci gateway, scope `iot:sesi`), contoh dari dunia sintetis IoMT (klaim KLM-000734, RS fiktif FK-029):

```json
{"alat_id": "DV-029-VNT-02", "pasien": {"token": "ptk_7d165058dbfcd609", "jenis": "no_kartu"},
 "kunjungan": {"kunjungan_fkrtl_id": "KLM-000734"}, "ruang": "ICU bed 2", "operator": "otk_610832d1172319f6",
 "mulai": "2026-04-20T21:40:19+07:00", "mode_diharapkan": "jalan"}
```
→ `201 {"sesi_id": "ses_e06d6b23ff9a", "episode_id": "EP-729309", "status": "terbuka", "hash_peristiwa": "0x96befc60…", "urutan_rantai": 1}`.
Ditutup dengan `POST …/sesi/ses_e06d6b23ff9a/selesai {"selesai": "2026-05-12T18:40:20+07:00", "alasan": "dilepas"}`.

**Token pasien:** `ptk_` + 16 hex HMAC-SHA256 dengan kunci tokenisasi per RS (diterbitkan bersama kunci gateway) atas no. kartu atau id
pasien RS. Identitas asli tidak pernah lewat API IoT; KC menghitung token yang sama dari klaim untuk mencocokkan. Token tidak pernah
dikirim ke Model AI (LLM).

### 12.3 Bacaan, sesi pemakaian, jangkar

`POST …/iot/bacaan` (scope `iot:kirim`, JSON atau NDJSON, ≤ 5.000 bacaan atau 2 MB):

```json
{"gateway_id": "DV-029-GWY-01", "bacaan": [
 {"alat_id": "DV-029-VNT-02", "seq": 393, "ts": "2026-04-20T22:40:21+07:00", "interval_detik": 3600, "metrik": "nyala", "nilai": 1,
  "mode": "jalan", "sesi_id": "ses_e06d6b23ff9a", "episode_id": "EP-729309",
  "hash": "0xb4f643f8e93b45c700954d9f5a8047200b1ade87fdf99a2f27af6c94b4cfee98", "tanda_tangan": "0x<ECDSA secp256k1 oleh kunci alat>"}]}
```

- Metrik yang diterima hanya `nyala` dan `arus_a` (+ `mode`: ventilator `jalan` / `siaga` / `mati`, dialisis dan pompa infus `jalan` /
  `idle` / `mati`, bed/monitor ICU `nyala` / `mati`; nilai lama `invasif` / `noninvasif` dibaca `jalan`, `standby` dibaca `siaga`);
  metrik lain, termasuk tanda vital, ditolak `422 metrik_dilarang`.
- Idempoten per `(alat_id, seq)`: kirim ulang bacaan yang sama = `duplikat`, isi berbeda dengan seq sama = ditolak. Celah seq dilaporkan
  (`celah_seq`): angka terukur menjadi batas bawah (`evidence_incomplete`).
- Tanda tangan diperiksa terhadap kunci alat yang terdaftar dan belum dicabut pada `ts` (sama dengan `wasDeviceValidAt`).
- Balasan ke gateway hanya penerimaan; hasil cek IoT tidak pernah dikirim ke RS.
- Platform AIoT yang sudah menghitung sesi boleh mengirim `POST …/iot/pemakaian` (mulai, selesai, mode, jumlah bacaan, akar bacaannya).

`POST …/iot/episode/EP-729309/jangkar` → `{"merkle_root": "0xa35fcd33…", "jumlah_bacaan": 1722, "peristiwa_sesi": 2, "tx": "0x9c4a2612…",
"dijangkarkan": "2026-05-19T02:13:53+07:00", "cocok_dengan_gateway": true}`; klaim diajukan 2026-05-21 → jangkar sebelum klaim.

### 12.4 Cek IoT: blok `iot` per klaim (white-box)

`GET …/audit/{audit_id}/klaim/{klaim_id}/iot` atau `POST …/iot/cek` (≤ 500 klaim). Setiap temuan membawa aturan, angka yang ditagih
dan yang terukur, ambang, binding, bukti jangkar, selisih tarif, dan langkah verifikasi:

```json
{"hasil": "tidak_sesuai", "aturan": "vent_run_96",
 "judul": "Kode 96.72 ditagih, tetapi ventilator tidak pernah menyala 96 jam berturut-turut",
 "penjelasan": "Klaim menagih ventilasi 146 jam (kode 96.72, minimal 96 jam berturut-turut), tetapi sensor clamp pada kabel daya ventilator DV-029-VNT-02 mencatat alat paling lama jalan 66 jam tanpa putus dan total 66 jam selama rawat inap.",
 "alat": [{"id": "DV-029-VNT-02", "jenis": "ventilator", "nama": "ventilator 2", "sensor": "clamp_arus", "rs": "FK-029", "jam_nyala": 365, "utilisasi_pct": 16.8}],
 "sesi": [{"sesi_id": "ses_e06d6b23ff9a", "device_id": "DV-029-VNT-02", "peserta": "ptk_7d165058dbfcd609", "kunjungan": "KLM-000734",
           "mulai": "2026-04-20T21:40:19+07:00", "selesai": "2026-05-12T18:40:20+07:00", "alasan_selesai": "dilepas"}],
 "ditagih": {"prosedur": "96.72", "jam": 146, "inacbg": "J-1-14-III", "tarif_rp": 97883000},
 "terukur": {"jam_total": 66, "jam_berturut_maks": 66, "mode_jam": {"jalan": 66, "siaga": 0},
             "sesi": [{"mulai": "2026-04-20T22:40:21+07:00", "selesai": "2026-04-23T16:40:19+07:00", "mode": "jalan", "jam": 66}]},
 "harian": [{"tanggal": "2026-04-20", "jam_dipakai": 2.0, "jam_ditagih": null}, {"tanggal": "2026-04-21", "jam_dipakai": 24.0, "jam_ditagih": null}, "…"],
 "ambang_jam": 96,
 "tarif": {"ditagih_rp": 97883000, "seharusnya_rp": 30306000, "kode_seharusnya": "J-1-14-II", "selisih_rp": 67577000},
 "bukti": {"pembacaan": 1722, "merkle_root": "0xa35fcd33…", "dijangkarkan": "2026-05-19T02:13:53+07:00",
           "klaim_diajukan": "2026-05-21T20:36:36+07:00", "rantai_ok": true},
 "langkah": ["Minta catatan ventilator dan lembar observasi ICU untuk masa rawat ini.", "…"], "sintetis": true}
```

`jam_ditagih` per hari bernilai `null` bila klaim hanya menyebut total jam. `tarif` dunia sintetis = tarif ditagih − median tarif
keparahan II sejenis (cara `synthetic-iomt/audit.py`); di data KC, selisih kelompok ≥ 96 jam vs < 96 jam INA-CBG.

**Aturan** (`GET …/iot/aturan`): `vent_run_96` (96.72 ditagih, ventilator jalan terpanjang tanpa putus < 96 jam), `vent_standby`
(ventilasi ditagih, ventilator hanya siaga), `hd_short` (dialisis < 3 jam ditagih penuh), `icu_days` (hari ICU > bed ICU terisi), `no_device_trace` (tidak ada jejak
alat), `anchor_mismatch`, `late_anchor`, `revoked_device`, `evidence_incomplete`, dan `tanpa_pasien` (baru: bacaan di luar binding).

**Ringkasan audit** (`GET …/audit/{id}/iot`, `L.iot`; contoh dunia sintetis IoMT): 28 RS dengan IoT, 1.140 alat, 784 klaim dengan
pembacaan alat — 546 sesuai, 224 tidak sesuai, 95 perlu klarifikasi, 37 tanpa jejak alat; selisih Rp 1.738.464.000. **Utilisasi**
(`GET …/iot/utilisasi`): jam nyala per status (jalan / siaga), utilisasi (ventilator DV-029-VNT-02: 365 jam, 16,8%), sesi, bacaan tanpa pasien.

### 12.5 Akses, batas, perlindungan data

- **Kunci gateway** `bsai_gw_<faskes>_…` (diterbitkan admin, satu per gateway): `iot:alat`, `iot:sesi`, `iot:kirim`. Terpisah dari kunci
  KC; gateway tidak pernah membaca hasil cek, Box, atau laporan.
- **KC** membaca alat, binding, bukti, blok `iot`, ringkasan, utilisasi dengan `cabang:baca`; `POST /iot/cek` dengan `cabang:klaim`.
- **Batas laju gateway:** 600 permintaan/menit, ≤ 5.000 bacaan atau 2 MB per permintaan.
- **Data:** bacaan hanya pola daya; tidak ada tanda vital, nama, atau nomor kartu. Satu-satunya tautan ke pasien adalah binding (token
  HMAC + kunjungan). Cek IoT ditulis kode; Model AI (LLM) tidak menerima bacaan, token, atau binding.
- **Tanpa bukti ≠ tuduhan:** RS tanpa gateway, gateway offline, atau bacaan bercelah menghasilkan `tanpa_bukti` / `perlu_klarifikasi`.
- **Audit modular:** tahap `iot` bisa dipilih di `POST /audit` (`tahap: ["iot", …]`, `opsi.iot`); `reproduksi.iot` mencatat versi aturan
  dan ambang (96 jam ventilasi, 3 jam dialisis).
