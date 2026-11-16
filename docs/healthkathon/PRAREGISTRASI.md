# Pra-registrasi target evaluasi (Healthkathon 2026)

> **AI JKN Synthetic:** dokumen ini disalin dari AI JKN Audit dan menggambarkan pengerjaan di atas Data Sampel BPJS yang asli. Angka agregat data asli sudah dihapus dan diganti `[…]`. Aplikasi ini berjalan di atas data sintetis (lihat `synthetic-gen/METODOLOGI.md` dan `synthetic-gen/laporan/EVALUASI.md`).

Mengikuti `templates/preregistration.md` dari [healthkathon-eval-kit](https://github.com/Luche/healthkathon-eval-kit)
(commit `336bf7b`). Berkas ini di-commit **sebelum** kartu bukti kit dijalankan pada data penuh; stempel waktu commit
menunjukkan target ditetapkan sebelum angka kit itu diketahui.

**Yang sudah terlihat sebelum target ini ditulis (diungkap apa adanya):** hasil benchmark AUPRC/F1 per teknik
(validasi silang per faskes, dua kali dijalankan), dan uji coba kit pada sampel 5% data (untuk memastikan alurnya
jalan). Angka kit pada data penuh (precision@k, lift, recall rupiah, profil faskes jujur yang diaudit, ablasi, uji
permutasi, kebocoran, negatif sulit) **belum** dihitung.

## Catatan

- Tanggal: 2026-10-23
- Commit detektor yang diuji: `511e022` (repo bluesandai-parse, cabang local-computer): `api/ml_klaim.py`,
  `api/aip/ml.py`; model = keluaran job pelatihan berikutnya (validasi silang 3 × 5, model terbaik per segmen)
- Commit generator: **tidak ada generator.** Data bukan sintetis: Data Sampel BPJS Kesehatan Edisi 2025 (data klaim
  nyata yang dianonimkan, silver `kunjungan_fkrtl`, […] klaim FKRTL)
- Siapa menulis generator: tidak berlaku

## Kondisi pengujian

- Tolok ukur: label nyata dalam data, `flag_selisih_verifikasi` = klaim yang dibayar kurang dari tagihan oleh
  verifikator BPJS ([…] klaim, […]%). **Positif = dikoreksi verifikator, bukan fraud terbukti.** Tidak ada modus.
- Skor: out-of-fold untuk setiap klaim, dengan faskes dibagi ke 5 lipatan (model tidak pernah melihat faskes yang
  dinilainya); prevalensi nyata dipertahankan (tidak ada penyeimbangan pada data uji).
- Sumber data: sampel publik (Data Sampel BPJS Kesehatan 2025)
- Distribusi yang dikalibrasi / dikarang: tidak ada; semua angka dari data nyata
- Kapasitas audit k: **0,1% klaim** (asumsi kami, bukan angka BPJS): verifikator × kasus per verifikator per hari ×
  hari kerja belum diisi angka resmi
- Seed: 0 (pembagian lipatan faskes)
- Dua kartu: (1) semua klaim FKRTL, (2) klaim rumah sakit saja (tanpa klinik utama: […] terkoreksi dari […])

## Target

| Metrik | Ambang | Kartu | Mengapa ambang ini |
|---|---|---|---|
| precision@k, batas bawah IK 95% (resampling per profil faskes) | ≥ 0,40 | semua klaim | satu aturan (rawat inap klinik utama) sudah sangat presisi; model harus setidaknya setara |
| precision@k, batas bawah IK 95% | ≥ 0,01 | rumah sakit | prevalensi […]%: 0,01 = > 150× acak |
| lift dibanding acak pada k | ≥ 100× / ≥ 50× | semua / rumah sakit | daftar audit harus jauh lebih baik dari acak |
| recall rupiah@k | ≥ 25% / ≥ 10% | semua / rumah sakit | koreksi bernilai besar harus masuk daftar |
| profil faskes jujur yang diaudit | ≤ 5% keseluruhan; tak ada strata > 3× rata-rata | keduanya | beban audit tidak jatuh pada faskes jujur |
| ablasi: model vs aturan klinik utama | model tidak lebih buruk (perubahan precision@k ≥ 0, atau p ≥ 0,05 bila negatif) | semua klaim | di kapasitas kecil keduanya mungkin memilih klaim yang sama |
| ablasi: model vs aturan yang ada (flag ganda / LOS ekstrem) | precision@k naik, p < 0,05 | rumah sakit | inilah nilai tambah model |
| uji permutasi label (PR-AUC) | p < 0,01 | keduanya | skor tidak boleh setara acak |
| kebocoran: AUC satu fitur > 0,80 | hanya fitur yang dijelaskan pola klinik utama (jenis/tipe faskes, poli); tak ada di kartu rumah sakit | keduanya | aturan 4 kit |
| tinjauan ahli buta: % mencurigakan, ditandai − acak | ≥ 20 poin persentase | rumah sakit | menunggu peninjau BPJS (lembar dibuat, belum diisi) |
| recall@k per modus | tidak berlaku | - | label nyata tanpa modus |

## Apa yang dihitung sebagai gagal

- Target meleset bila estimasi titik (atau batas bawah IK untuk precision@k) di bawah ambang.
- Target yang meleset dilaporkan apa adanya di tab Model ML dan di laporan ke pengguna, tanpa mengganti ambang.

## Uji ketahanan yang kami jalankan

- [x] ablasi dengan uji berpasangan antar-varian berturutan (aturan yang ada → aturan klinik utama → aturan + model → model)
- [ ] plasebo: **tidak berlaku** (butuh versi data tanpa fraud dari generator sendiri; ini data nyata)
- [x] uji permutasi label
- [x] pemindaian kebocoran
- [x] tinjauan ahli buta: 20 klaim teratas + 20 acak (lembar dibuat; penilaian menunggu peninjau)
- [x] profil faskes jujur yang diaudit per strata: kelas faskes, wilayah (provinsi), ukuran
- [x] negatif sulit dari data nyata: RS kelas A, dialisis/kemoterapi, diagnosis langka berbiaya tinggi, faskes kecil, masa wabah COVID

## Pengesahan

| Nama | Peran | Tanggal |
|---|---|---|
| (diisi tim) | | |
