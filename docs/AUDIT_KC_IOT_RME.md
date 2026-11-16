# Audit KC dengan rekam medis dan data IoT (AI Agent Swarm Branch)

Satu perintah menjalankan audit kantor cabang dari ujung ke ujung: **klaim + rekam medis pasien (SATUSEHAT FHIR) + data
pemakaian alat (IoT)** → mesin aturan → ML v7 → AI Agent Swarm → laporan KC yang sama dengan laporan audit sekarang.
Runner: `testing/jalan_kc_tema.py` (rincian di docstring-nya). Format masukan IoT: `docs/IOT_FORMAT_MASUKAN.md`.

## Tahap

| Tahap | Isi | Keluaran |
|---|---|---|
| `fitur` | klaim per ulangan lewat mesin aturan realtime; klaim tema di RS KC dicocokkan dengan rekam medisnya (temuan `RME_*` beserta buktinya, `rme_bukti`) | `.tmp/kc_tema/<set>/hasil_NN.npz` |
| `zona` | zona ML v7: TAHAN / RAGU / LOLOS, berkas klaim RAGU | `zona_<set>.npz`, `berkas_<set>.jsonl` |
| `iot` | `--iot <folder>`: data IoT sendiri, diperiksa dulu (baris per berkas, baris ditolak dan alasannya); `--iot-sintetis`: dunia IoT sintetis untuk KC set ini (benih tetap). Lalu pemeriksa `testing/iot_cabang.py periksa` | `<cabang>/iot/<set>/bukti.json`, `monitoring.json`, `.tmp/kc_tema/<set>/iot_validasi.json` |
| `aturan` | temuan rekam medis dan IoT → rute ke swarm, bagian berkas, jalur bukti aturan, perkiraan biaya | `jalur_<set>.json`, `berkas_<set>_swarm.jsonl`, `perkiraan.json` |
| `swarm` | 3 spesialis + hakim membaca klaim; lalu gerbang | `agen_<set>.json`, `gerbang_<set>.json` |
| `laporan` | `testing/laporan_cabang.py` (+ `graf_cabang.py`) | `kc_<kc>.json`, `graf_<kc>.json` |
| `narasi` | agen penulis (hanya run nyata) | laporan dengan narasi |

`<cabang>` = `data/aip/cabang` untuk run nyata; `.tmp/kc_tema/<set>/cabang` untuk `--dry-run` (tidak menyentuh
`runs.json` aplikasi). Status tiap tahap (jumlah per berkas IoT, temuan, jalur, biaya) ada di `.tmp/kc_tema/<set>/status.json`.

## Mesin aturan dan AI Agent Swarm: bagaimana keduanya bekerja sama

Mesin aturan rekam medis (`api/aip/realtime/rme.py`) dan pemeriksa IoT (`testing/iot_cabang.py`) melihat hal yang tidak
pernah dilihat ML v7: dokumen RS dan catatan alat. Tetapi aturan juga salah alarm (rekam medis: 0,16% klaim normal jantung)
dan tidak bisa menimbang penjelasan wajar. Swarm bisa. Jadi tidak ada yang memutus sendiri:

1. **Rute.** Setiap temuan diberi nomor (R1, R2, …) dan kekuatan 0–1 (kekuatan dari mesin aturan setelah faktor peringan,
   mis. rekam medis tanpa data klinis ×0,5; IoT: 1,0 bila catatan alat dijangkarkan sebelum klaim dan rantainya cocok).
   Temuan ≥ **0,5** membawa klaim ke swarm walaupun ML v7 meloloskannya. Temuan **terverifikasi** (ketidaksesuaian yang bisa
   dicek langsung pada dokumen: tindakan ditagih tetapi tidak ada di rekam medis yang lengkap, ventilator terjangkar < 96 jam
   untuk kode 96.72, kunjungan dipakai dua klaim, …) ≥ **0,8** membuka **jalur bukti aturan**.
2. **Bukti ke spesialis yang tepat.** Berkas mendapat bagian *Temuan rekam medis (RME)* dan *Bukti pemakaian alat (IoT)*,
   tanpa identitas (tanggal ditulis H0 = hari masuk, H+3; tanpa nomor pasien/kunjungan/alat/nama RS). Tiap temuan punya
   pemilik: **koding** (tindakan/diagnosis/keparahan/indikasi vs rekam medis), **tagihan** (jam alat dipakai vs jam
   ditagih dan dampak tarif; obat/alat, kelas rawat), **episode** (alat terikat ke pasien lain, kunjungan tidak ada/dipakai
   ulang, LOS, episode dipecah, identitas). Semua agen tetap melihat semua fakta (catatan alat yang *sesuai* adalah
   pembelaan klaim). **Hakim** wajib menyatakan *terima* atau *tolak* untuk setiap temuan, dengan alasan.
3. **Gerbang.** Jalur ML tidak berubah: `f = (p_hakim + q(s)) / 2 ≥ τ 0,72`, q(s) = porsi klaim normal yang skornya di
   bawah klaim ini. Untuk klaim dengan temuan terverifikasi yang tidak ditolak hakim:
   `f = maks(f_ML, (p_hakim + k) / 2)`, k = kekuatan temuan (paling tinggi 0,99). k berdiri di tempat q(s) karena keduanya
   menjawab "seberapa jarang ini terjadi pada klaim normal". Akibatnya hakim tetap memegang veto: antrean butuh
   p_hakim ≥ 0,45; hakim yang menolak temuan mematikan jalur ini. Bukti aturan hanya bisa **menambah** klaim ke antrean,
   tidak pernah mengeluarkan. `gerbang_<set>.json` mencatat jalur, f_ML, f_aturan, k dan sikap hakim per klaim.
4. **Biaya.** Klaim yang dirutekan aturan ikut dihitung per tema; biaya per klaim mengikuti panjang berkasnya sendiri.
   Bila batas biaya tidak cukup: jalur bukti aturan dibaca lebih dulu, lalu urut skor ML.

Fitur model tetap 45 sinyal (`aktif.CODES` beku). Temuan rekam medis dan IoT tidak pernah menjadi fitur ML.
Versi prompt swarm: `v5-adk-p3` (alias netral `swarm-v5-p3`); kunci cache memuat sidik berkas, jadi berkas yang berubah
(data IoT baru, rekam medis diperbaiki) selalu ditanyakan ulang.

## Perintah (PowerShell, dari folder proyek)

**(a) Data sendiri: klaim + rekam medis pasien + folder IoT**

Klaim dan rekam medis disusun seperti dataset tema di `Data Sintetis/<folder>` (`klaim/klaim_semua.parquet`,
`rekam_medis/replika_00/*.ndjson.gz` FHIR bulk, `peserta/peserta.parquet`, `kunci/label_fraud.parquet` — boleh kosong
untuk data nyata, lampiran teknis lalu tanpa recall —, `ringkasan.json` dengan `kc`). Folder IoT mengikuti
`docs/IOT_FORMAT_MASUKAN.md` (`alat`, `sesi`, `pembacaan`, `jangkar.json`, `klaim_alat`, `manifest.json`) dan diletakkan di
`data\iot\<folder>` atau `Data Sintetis\<dataset>\iot…`.

```powershell
# uji kering dulu: semua tahap, $0, laporan di .tmp\kc_tema\audit_rs_saya\cabang
.venv\Scripts\python.exe testing\jalan_kc_tema.py --set audit_rs_saya --dataset <folder> --tema I --iot "data\iot\<folder>" --dry-run
# run nyata (batas biaya model AI)
.venv\Scripts\python.exe testing\jalan_kc_tema.py --set audit_rs_saya --dataset <folder> --tema I --iot "data\iot\<folder>" --batas-usd 20 --label "Audit jantung KC ..."
```

**(b) Dataset jantung sintetis dengan IoT sintetis**

```powershell
.venv\Scripts\python.exe testing\jalan_kc_tema.py --set tema_jantung_iot_uji --dataset tema_jantung_kc_sul-7371 --replika 60,61 --tema I --dry-run --iot-sintetis
.venv\Scripts\python.exe testing\jalan_kc_tema.py --set tema_jantung_iot --dataset tema_jantung_kc_sul-7371 --tema I --iot-sintetis --batas-usd 20
```

Dari aplikasi: **AI Agent Swarm Branch → proyek → Buat audit baru → Data IoT: Tidak ada / Sintetis / Folder** (folder harus
di dalam `Data Sintetis/` atau `data/iot`; diperiksa lagi saat audit dimulai).

## Hasil uji kering (2 ulangan, tema jantung, IoT sintetis, model palsu) — 2026-11-15

`tema_jantung_iot_uji`, replika 60–61, tema I, $0, 5,5 menit (lanjutan dari fitur yang sudah ada: < 1 menit). Uji kering
membuktikan alur, **bukan** akurasi: angka hakim berasal dari model palsu.

- IoT sintetis: 19 RS, 132 alat, 389 sesi, 63.423 pembacaan, 319 jangkar. Validasi: `sesi.csv` 3 baris ditolak (selesai
  sebelum mulai), `pembacaan.parquet` 26 ditolak (sesinya ditolak). Pemeriksa: 320 klaim beralat, 299 sesuai, 19 tidak
  sesuai, 2 tanpa bukti, selisih tarif Rp348,9 juta.
- Tahap `aturan`: 3.258 klaim tema jantung di KC; RAGU ML 530 + 3 dirutekan aturan dari LOLOS = 533 dibaca swarm; 48 klaim
  di jalur bukti aturan (2 dari LOLOS); temuan RME 136, IoT 7, terverifikasi 51; pemilik: koding 103, tagihan 7, episode 33.
  Lampiran (kunci jawaban, tidak dipakai untuk rute): 42 dari 48 klaim jalur bukti aturan memang fraud.
- Laporan: bab *Verifikasi IoT alat medis*, exhibit `iot-cek` / `iot-kasus` / `iot-tarif`, 25 berkas kasus dengan blok IoT,
  tag `IOT_DURASI_ALAT`; 620 berkas kasus graph + jejak. `data/aip/cabang/runs.json` tidak tersentuh.
- Cache: setelah berkas berubah, 53 dari 67 batch dijawab cache dan 14 batch yang berkasnya berubah ditanyakan ulang.

## Biaya

Berkas rata-rata 1.449 → 1.597 karakter (+148 karakter ≈ +49 token, dibaca 4 agen ≈ +200 token masukan per klaim); prompt
p3 +6.172 karakter per batch 8 klaim (≈ +2.060 token); sikap hakim ≈ 40 token keluaran per temuan. Per klaim
$0,00134 → $0,00149 (+11%). Subset 2 ulangan tema jantung: $0,71 → $0,79; semua tema KC (2 ulangan): $2,01 → $2,09.

## Validasi nyata yang diusulkan (belum dijalankan)

Satu ulangan tema jantung dengan model AI sungguhan, ±$0,5 (±265 klaim dibaca + smoke $0,05):

```powershell
.venv\Scripts\python.exe testing\jalan_kc_tema.py --set tema_jantung_iot_val --dataset tema_jantung_kc_sul-7371 --replika 58 --tema I --iot-sintetis --batas-usd 1 --label "Validasi RME+IoT 1 ulangan"
# pembanding (opsional, ±$0,45): ulangan sama tanpa tahap aturan (berkas tanpa temuan aturan)
.venv\Scripts\python.exe testing\jalan_kc_tema.py --set tema_jantung_val_kontrol --dataset tema_jantung_kc_sul-7371 --replika 58 --tema I --tahap fitur,zona,swarm,laporan --batas-usd 1 --label "Validasi kontrol"
```

Yang dibandingkan (kunci jawaban hanya untuk lampiran): sikap hakim per kode temuan pada klaim fraud vs normal (temuan
benar diterima, alarm salah ditolak); recall pada fraud yang terlihat di rekam medis (`kunci/ketidaksesuaian_rm.parquet`)
atau IoT (`kunci_benar.json`): keputusan terpadu vs `keputusan_jalur_ml_saja` di `gerbang_<set>.json` vs run kontrol;
PERIKSA pada klaim normal (total dan lewat jalur bukti aturan); pergeseran p hakim pada klaim bertemuan (perlakuan vs kontrol);
biaya per klaim nyata vs perkiraan. Run nyata menulis ke `data/aip/cabang` dan tampil di aplikasi.
