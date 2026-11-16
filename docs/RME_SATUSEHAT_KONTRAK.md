# Rule engine × rekam medis elektronik (SATUSEHAT) — kontrak integrasi

Permintaan BPJS (2026-11-14): rule engine belum bisa membaca rekam medis elektronik (RME) rumah sakit. Kebutuhannya:
memverifikasi apakah klaim yang ditagih RS sesuai dengan rekam medisnya. Contoh: klaim menagih kateterisasi jantung, tetapi
rekam medis tidak memuat tindakan itu, sementara tekanan darah dan saturasi oksigen pasien normal.

Dokumen ini adalah kontrak antara RS (atau vendor SIMRS) yang mengirim rekam medis, dan sistem audit yang mencocokkannya.
Semua data di repo ini **sintetis**.

| Berkas | Isi |
|---|---|
| `api/aip/realtime/rme.py` | parser Bundle FHIR, basis pengetahuan klinis, aturan pencocokan |
| `docs/rme_satusehat_bundle.schema.json` | JSON Schema (draft 2020-12) Bundle yang diterima, dibangkitkan dari `rme.json_schema()` |
| `docs/contoh_rme_klaim_pci.json` | contoh satu klaim PCI dengan Bundle rekam medisnya (sintetis, lolos skema) |
| `api/aip/realtime/rme_batch.py`, `testing/uji_rme.py` | penilaian berkas klaim + rekam medis secara offline (JSONL, Bundle, atau FHIR Bulk NDJSON) |
| `api/test_rme.py` | 16 uji |

## 1. Standar yang dipakai

- **FHIR R4 4.0.1, profil ID Core SATUSEHAT** (Kemenkes, IG 0.3.16, https://ig.fhir-indonesia.org). Kanonik profil:
  `https://fhir.kemkes.go.id/r4/StructureDefinition/id-core-<resource>`.
- Kode:

| Data | Sistem kode |
|---|---|
| Diagnosis (Condition) | ICD-10 `http://hl7.org/fhir/sid/icd-10` |
| Tindakan (Procedure) | ICD-9-CM `http://hl7.org/fhir/sid/icd-9-cm` (contoh IG sendiri: 87.44 rontgen dada sebagai Procedure) |
| Tanda vital, laboratorium, EKG, ekokardiografi (Observation) | LOINC `http://loinc.org` |
| Obat | KFA `http://sys-ids.kemkes.go.id/kfa`; sistem lain (ATC) juga dibaca |
| Kelas kunjungan (Encounter.class) | v3-ActCode: `IMP` rawat inap, `AMB` rawat jalan, `EMER` IGD |
| Pasien | IHS `https://fhir.kemkes.go.id/id/patient-ihs-number` |

## 2. Cara mengirim

**Bersama klaim.** `POST /api/aip/realtime/v1/faskes/klaim` (header `X-Ingest-Token`) menerima field baru `rekam_medis`:
satu Bundle FHIR untuk episode yang diklaim. Field ini opsional: RS yang belum terhubung SATUSEHAT tidak dikenai temuan apa pun.

```json
{"sumber": "rs-contoh", "klaim_id": "KLAIM-0001", "jenis_episode": "ri", "tanggal_masuk": "2024-12-20", "tanggal_pulang": "2024-12-23",
 "diagnosis_utama": "I21.4", "diagnosis_sekunder": ["I10"], "tindakan": ["37.22", "00.66", "36.07"], "inacbg_kode": "I-1-40-I",
 "biaya_tagih_rp": 45000000, "rekam_medis": {"resourceType": "Bundle", "type": "collection", "entry": [ ... ]}}
```

Tanda terima hanya memuat apakah rekam medis **terbaca** dan masalah strukturnya. RS tidak pernah menerima hasil
pencocokan, skor, atau keputusan (tidak ada *tipping-off*; keputusan tetap di BPJS).

**Uji struktur sebelum produksi.** `POST /api/aip/realtime/v1/faskes/rme/validasi` (token yang sama) mengembalikan jumlah
resource yang terbaca, masalah, dan peringatan. Tidak ada pencocokan dengan klaim.

**Untuk tim internal.** `GET /api/aip/realtime/v1/rme/skema` mengembalikan JSON Schema, basis pengetahuan klinis, dan daftar
sinyal beserta bobotnya.

## 3. Isi Bundle yang dibaca

Satu Bundle per klaim, maksimal 3.000 entri. Resource lain boleh ada dan diabaikan.

| Resource | Elemen yang dibaca | Wajib untuk pencocokan |
|---|---|---|
| Encounter | `class`, `period.start/end` (atau `statusHistory`), `status`, `identifier`, `location[].extension` id-core-service-class (kelas rawat) | ya, minimal satu dengan `period.start` |
| Patient | `gender`, `birthDate` (cek identitas). NIK dan nama **tidak disimpan** | tidak |
| Condition | `code` ICD-10, `encounter`, `verificationStatus` (refuted/entered-in-error diabaikan) | tidak |
| Procedure | `code` ICD-9-CM, `status` (`not-done` = tidak jadi dilakukan), `encounter`, `focalDevice` | tidak |
| Observation | `code` LOINC, `valueQuantity` / `valueCodeableConcept`, `interpretation`, `referenceRange`, `component` (panel tekanan darah 85354-9) | tidak |
| DiagnosticReport | `code`, `conclusion`, `conclusionCode` (EKG 11524-6, ekokardiografi 34552-0) | tidak |
| MedicationRequest / Dispense / Administration, Medication | kode dan nama obat (`medicationReference` diresolusi ke Medication di Bundle) | tidak |
| Device | nama/jenis alat (stent, pacu jantung, ventilator) | tidak |
| Composition | teks resume medis: "boleh pulang sejak YYYY-MM-DD" | tidak |

Resource ditautkan ke kunjungan lewat `encounter.reference`, `encounter.identifier` (bentuk ekspor ai-jkn), atau tanggalnya
bila tidak bertaut. Kunjungan dicocokkan ke klaim lewat **tanggal dan jenis rawat**, tidak bergantung pada ID.

Parameter terukur (LOINC → batas normal dewasa; anak dan jenis kelamin disesuaikan): tekanan darah sistolik 8480-6 (90–139),
diastolik 8462-4 (60–89), nadi 8867-4 (60–100), napas 9279-1 (12–20), suhu 8310-5 (36,0–37,5), saturasi oksigen 59408-5/2708-6
(95–100), GCS 9269-2, troponin (89579-7, 6598-7, 10839-9, …; batas dari `referenceRange` atau satuan), Hb 718-7, trombosit 777-3,
leukosit 6690-2, kreatinin 2160-0, natrium 2951-2, kalium 2823-3, pO2 2703-7, pCO2 2019-8, laktat 2524-7, glukosa 2345-7,
prokalsitonin 33959-8. Daftar lengkap di `x-loinc` pada JSON Schema.

## 4. Aturan

Setiap temuan adalah sinyal rule engine dengan bobot, modus Permenkes 16/2019, dan bukti dalam kalimat biasa beserta angkanya.
Skor = 100 × (1 − e^(−Σ bobot × kekuatan × (1 − mitigasi))); PERIKSA mulai 45, TAHAN mulai 75 (ambang engine).

| Sinyal | Kapan | Modus | Bobot |
|---|---|---|---|
| `RME_KUNJUNGAN_TIDAK_ADA` | tidak ada kunjungan yang beririsan dengan tanggal klaim | M06 | 1,6 |
| `RME_TINDAKAN_TIDAK_TERCATAT` | tindakan yang ditagih tidak ada Procedure-nya. Kuat untuk tindakan bermakna (operatif, kateterisasi/PCI, ventilator, transfusi) dan untuk status `not-done`; ringan (0,4) untuk pemeriksaan minor | M14 | 1,4 |
| `RME_JENIS_RAWAT_BERBEDA` | ditagih rawat inap, rekam medis hanya rawat jalan/IGD (IGD dimitigasi) | M04, M06 | 1,2 |
| `RME_PASIEN_BERBEDA` | jenis kelamin atau usia pasien di rekam medis beda dari pemegang kartu | M06 | 1,2 |
| `RME_KUNJUNGAN_DIPAKAI_ULANG` | satu kunjungan menjadi dasar dua klaim dari faskes yang sama (engine menyimpan status ini) | M11 | 1,2 |
| `RME_KLINIS_TIDAK_MENDUKUNG` | tindakan dari kelompok yang dikenal tanpa diagnosis/hasil ukur indikasinya. Kuat hanya bila hasil ukur yang relevan **normal**; bila tidak ada hasil ukur, lemah (0,35): ketiadaan bukti bukan bukti | M15 | 1,0 |
| `RME_DIAGNOSIS_TIDAK_DIDUKUNG` | diagnosis yang bisa diukur dibantah hasil ukurnya (gagal napas dengan saturasi normal, infark dengan troponin normal, sepsis tanpa 2 kriteria SIRS, anemia dengan Hb normal, …) | M04 | 1,0 |
| `RME_LOS_TIDAK_SESUAI` | lama rawat klaim ≥2 hari di atas Encounter, atau di atas tanggal "boleh pulang" di resume medis | M12 | 1,0 |
| `RME_KELAS_BERBEDA` | kelas rawat klaim di atas kelas layanan Encounter | M13 | 1,0 |
| `RME_OBAT_ALKES_TIDAK_TERCATAT` | item top-up special CMG (dicocokkan lewat kode atau nama) atau baris obat yang ditagih tidak ada di rekam medis | M17 | 1,0 |
| `RME_EPISODE_DIPECAH` | rawat inap di rekam medis sudah berjalan sebelum tanggal masuk klaim / berlanjut sesudah tanggal pulangnya, atau klaim rawat jalan yang di rekam medis adalah bagian dari rawat inap hari itu | M08, M09 | 0,9 |
| `RME_DIAGNOSIS_TIDAK_TERCATAT` | diagnosis klaim tidak ada di Condition. Diagnosis utama 1,0; sekunder 0,7 pada keparahan II/III (yang menentukan tarif), 0,35 pada keparahan I. Bila klaim hanya mengirim jumlah diagnosis sekunder, jumlahnya dibandingkan | M04 | 0,8 |
| `RME_RAWAT_INAP_TANPA_INDIKASI` | rawat inap tanpa tindakan bermakna, semua tanda vital dan laboratorium normal sejak masuk, bukan ICU, bukan meninggal. Bobot rendah: hanya sampai PERIKSA, perlu telaah | M15 | 0,7 |

**Aturan tambahan 2026-11-15.** Aturan-aturan ini membaca waktu dan jumlah yang dicatat rekam medis sendiri, serta
kunjungan lain pasien yang sama. Kunjungan lain diambil dari Bundle dan dari riwayat yang disimpan engine (`rme.jejak`) dari
klaim sebelumnya. Hanya kunjungan yang mulai sebelum tanggal masuk klaim yang dihitung.

| Sinyal | Kapan | Modus | Bobot |
|---|---|---|---|
| `RME_READMISI_TERENCANA` | rawat inap tercatat sebagai rawat ulang terencana (`Encounter.hospitalization.reAdmission`, atau resume pulang sebelumnya merencanakan masuk pada tanggal ini ±3 hari), tetapi tanpa tindakan bermakna dan tanpa temuan akut. Perlu telaah | M16 | 0,9 |
| `RME_READMISI_PULANG_DINI` | masuk rawat inap ≤ 7 hari setelah pulang dari rawat inap dengan tanda vital terakhir belum stabil (kriteria Halm: suhu > 37,8 °C, nadi > 100, napas > 24, sistolik ≤ 90, saturasi < 90%; atau ≥ 180/120 mmHg), atau resume menyebut belum stabil. Dirujuk/meninggal dikecualikan; APS ×0,3; RS lain ×0,5 | M09, M16 | 1,0 |
| `RME_RUJUKAN_TANPA_INDIKASI` | `admitSource = hosp-trans` tanpa alasan (`reasonCode`/`basedOn`), tanpa tindakan bermakna, tanpa temuan akut. Pemeriksaan penunjang di RS tujuan ×0,7. Perlu telaah | M10 | 0,9 |
| `RME_DOKTER_PASIEN_DIPUTAR` | dokter (`Encounter.participant`) yang sama menangani pasien ini di RS lain dalam 30 hari. Kekuatan 0,6 untuk 2 RS, 0,8 untuk 2 RS dalam 14 hari dengan diagnosis sama, 1,0 untuk ≥ 3 RS | M10 | 0,9 |
| `RME_VENTILASI_TIDAK_SESUAI` | 96.72 atau ≥ 96 jam ventilator ditagih, sedangkan ventilasi di rekam medis (`Procedure.performedPeriod` ≥ 6 jam, `DeviceUseStatement.timingPeriod`) < 96 jam berturut-turut, atau rekam medis mengode 96.71. Periode < 6 jam dianggap waktu tindakan, bukan lama ventilasi | M04, M14 | 1,2 |
| `RME_HARI_ICU_LEBIH` | `lama_icu_hari` > periode lokasi ICU di `Encounter.location[].period` | M12, M13 | 1,0 |
| `RME_OBAT_JUMLAH_KURANG` | jumlah obat ditagih > `MedicationDispense.quantity`, atau > jumlah `MedicationAdministration` (×0,7: satuan bisa berbeda) | M18 | 1,0 |

**Perbaikan pembaca teks temuan (2026-11-15).** Kata abnormal dulu dicocokkan pada seluruh teks. Akibatnya, EKG
"Irama sinus normal, tidak ada perubahan iskemik" terbaca iskemik dan memberi indikasi palsu pada tindakan jantung. Sekarang
teks dibaca per klausa dan sadar negasi (`rme.teks_abn`).

Basis pengetahuan ikut dikoreksi:
- angina tidak stabil (I20.0) tidak lagi "dibantah" EKG/troponin normal, karena troponin normal adalah definisinya;
- fibrilasi atrium (I48) dan blok AV (I44) butuh 2 EKG normal agar bantahannya kuat, karena keduanya bisa paroksismal.

Yang tidak dijadikan aturan:
- implan/alat ditagih tanpa resource `Device`: data uji tidak memuat `Device` sama sekali, sehingga setiap PCI jujur akan
  ditandai. Top-up prostesis tanpa implan/tindakan sudah tercakup `RME_OBAT_ALKES_TIDAK_TERCATAT`;
- rekam medis salinan (kloning): hanya 17 dari 137 salinan di replika 0–8 yang identik nilainya, dengan 2 tabrakan pada klaim
  jujur;
- tindakan tanpa `reasonCode`: rekam medis riil sering tidak mengisinya.

Mitigasi yang tercatat bersama temuan: rekam medis hanya berisi kunjungan tanpa data klinis (×0,5), tindakan baru diminta
(ServiceRequest) belum dilaporkan selesai (×0,5), terapi oksigen untuk diagnosis gagal napas (×0,5), tindakan jantung
elektif (×0,8), kunjungan IGD yang berlanjut rawat inap (×0,6).

Contoh permintaan BPJS di sistem: klaim kateterisasi + PCI, rekam medis tanpa tindakan, tanpa diagnosis jantung, tekanan
darah 109–123/66–80 mmHg, nadi 64–88, saturasi 96–99% (8 pengukuran), troponin 2 kali dan EKG normal →
`RME_TINDAKAN_TIDAK_TERCATAT` (1,4) + `RME_KLINIS_TIDAK_MENDUKUNG` (0,8 setelah mitigasi tindakan elektif) +
`RME_DIAGNOSIS_TIDAK_TERCATAT` (0,8), skor 95, **TAHAN**.

**Basis pengetahuan klinis** (`TINDAKAN_KLINIS`, `DX_KLINIS` di `rme.py`; terbaca lewat `/rme/skema`): kelompok tindakan
jantung lebih dulu (kateterisasi, PCI, CABG, pacu jantung/ICD, ablasi, katup), lalu ventilator, transfusi, hemodialisis,
seksio sesarea, apendektomi; 25 diagnosis terukur. Ini **subset kerja untuk demonstrasi**: harus ditinjau tim medis BPJS
(TKMKB) sebelum dipakai pada klaim riil.

## 5. Di mana aturan ini berjalan

- **Engine realtime** (`mesin._fkrtl`): sinyal RME masuk skor rule, penjelasan, kasus, tag ledger indikasi, dan permintaan
  dokumen ke RS. Hasil pencocokan disimpan di event (`rme`: tabel butir, hasil ukur ringkas, nilai).
- **Ruang fitur model dibekukan** (`aktif.CODES`, 45 sinyal). Sinyal RME tidak menggeser kolom fitur ML v7 maupun model
  adaptif. Menambah sinyal ke fitur hanya boleh bersama pelatihan ulang.
- **V7 (`/testing`)**: formulir punya bagian rekam medis (tempel/unggah Bundle, atau buat Bundle sintetis dari isian), lima contoh
  klaim+RME, dan **rute rule rekam medis**. ML v7 dilatih tanpa rekam medis, jadi temuan rekam medis yang skornya sendiri
  mencapai ambang PERIKSA menandai klaim tanpa menunggu ML v7. Tabel "Cocokkan dengan rekam medis" tampil untuk klaim aman
  maupun terdeteksi, dan penjelasan AI membaca tabel itu.
- **Aturan kustom** (tab System Architecture): field `rme_*` (`rme_ada`, `rme_vital_normal`, `rme_spo2_min`,
  `rme_troponin_tinggi`, `rme_tindakan_tidak_tercatat`, …) bisa dipakai di kondisi rule bahasa awam; backtest membaca
  nilainya dari event tersimpan.
- **Simulator**: 30% klaim rawat inap normal dikirim dengan rekam medis sintetis yang konsisten (dengan celah dokumentasi),
  dan empat skenario `rme_*` ditanam, sehingga deteksi dan false alert terukur.

## 6. Hasil uji pada data independen

Data: 101.190 klaim jantung sintetis KC Makassar beserta rekam medis FHIR (2,1 juta resource), dibuat sesi lain
(`testing/gen_tema.py`, `testing/rekam_medis.py`, folder `Data Sintetis/tema_jantung_kc_sul-7371`). Klaim ditautkan ke
rekam medis lewat nomor peserta di `Patient.identifier` dan tanggal; berkas kunci hanya dipakai untuk laporan.

Aturan diperbaiki sambil melihat replika 0–8: false alert awal 3,6% (replika 0–4, versi pertama data) lalu 0,9% (replika
5–61, versi kedua), dari tiga kelemahan: pemilihan encounter saat ada dua kunjungan, bobot untuk ketiadaan bukti, dan
ventilator yang dianggap dibantah saturasi normal padahal saturasinya normal karena ventilatornya. Setelah itu replika 5–8
ikut dipakai sebagai set pengembangan. **Angka di bawah dari replika 9–61 yang tidak dilihat saat memperbaiki aturan**
(`testing/laporan_rme_jantung.json`):

| | Klaim | Ditandai |
|---|---|---|
| Klaim jujur | 81.958 | **133 (0,16%)** → 2026-11-15: **150 (0,18%)** |
| Fraud yang terlihat di rekam medis | 4.398 | **2.498 (56,8%)** → 2026-11-15: **3.290 (74,8%)** |
| Fraud yang memang tidak terlihat di rekam medis (tagihan/top-up digelembungkan, rekam medis konsisten) | 312 | 1 |

| Ketidaksesuaian yang ditanam | Ditandai |
|---|---|
| episode menyatu (episode dipecah) | 100% |
| obat/alat top-up tidak ada di rekam medis | 100% |
| kelas rawat berbeda | 100% |
| diagnosis utama diganti | 100% |
| "boleh pulang" lebih awal dari tagihan | 100% |
| identitas tidak cocok (kartu dipinjam) | 100% |
| rekam medis salinan pasien lain (kloning) | 99% (lewat temuan lain) |
| kunjungan ganda (klaim berulang) | 97% |
| tidak ada rekam medis (klaim fiktif) | 94% |
| diagnosis sekunder kurang / keparahan tidak didukung | 66% |
| tindakan tidak ada di rekam medis | 38% (temuan muncul pada 74%; tindakan minor saja sengaja tidak cukup untuk menandai) |
| tanpa indikasi klinis | 9% |
| readmisi terencana, rujukan semu, dokter di tiga RS, tindakan diagnostik tanpa indikasi | 0–2% (belum ada aturannya) |

**Pembaruan 2026-11-15** (`testing/laporan_rme_jantung.json`; laporan lama di `laporan_rme_jantung_2026-11-14.json`).
Aturan disetel hanya pada replika 0–8 (recall 62,8% → 77,7%, false alert 25 → 26 dari 13.966). Hasil pada replika 9–61:

| Ketidaksesuaian | Sebelum | Sesudah |
|---|---|---|
| readmisi terencana | 12 / 613 | **482** |
| rujukan tanpa indikasi | 1 / 143 | **106** |
| dokter di banyak RS | 0 / 99 | **45** |
| tanpa indikasi klinis | 90 / 957 | **678** (dari perbaikan pembaca EKG) |
| pulang belum stabil | 252 / 698 | **320** |

False alert naik 17 (133 → 150). Temuan yang muncul pada false alert sesudah perubahan (satu klaim bisa memuat lebih dari satu):
- 13 klaim jujur yang masuk lagi setelah rawat dengan tanda vital pulang tidak stabil (`RME_READMISI_PULANG_DINI`);
- 8 diagnosis tidak tercatat yang kini ikut melewati ambang;
- 5 bantahan diagnosis.

`pulang_dini` dihitung "fraud" oleh berkas kunci (skema ≠ normal), padahal generator menandainya **mutu, bukan fraud**.
Karena itu tidak ada aturan yang menandai pulang dini itu sendiri; yang ditandai adalah rawat inap lanjutannya.

Catatan: pada data ini "operasi batal ditagih" tidak selalu menuliskan Procedure `not-done`, sehingga aturan itu belum teruji
di sini (teruji di `api/test_rme.py`). Angka tetap angka **dunia sintetis**: dua generator berbeda, tetapi keduanya ditulis
dengan pemahaman klinis serupa. Kalibrasi sesungguhnya butuh rekam medis riil.

## 7. Menjalankan

```powershell
cd api; ..\.venv\Scripts\python.exe -I -m pytest -q test_rme.py
.venv\Scripts\python.exe -I testing\uji_rme.py --masuk "Data Sintetis\tema_jantung_kc_sul-7371" --replika 9 10 11 --proses 4
.venv\Scripts\python.exe -I testing\uji_rme.py --masuk berkas.jsonl --keluar hasil.jsonl     # {"klaim", "rekam_medis", "label"} per baris
.venv\Scripts\python.exe -I testing\uji_rme.py --sintetis 300                               # set berlabel dari generator sendiri
```

Kode baru aktif setelah API (8300) dan layanan `/testing` (8320) di-restart: API lewat
`.work\koordinasi\restart_api.ps1 -Sesi <nama> -Alasan <alasan>`, `/testing` lewat `testing\start-testing.ps1`.
