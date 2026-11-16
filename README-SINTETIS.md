# AI JKN Synthetic

Salinan app **AI JKN Audit** yang berjalan di atas **Data Sampel BPJS sintetis**, bukan data BPJS asli. Kode app-nya sama.
Datanya dibangkitkan oleh `synthetic-gen/` dengan metode *sequential CART synthesis* yang dipakai lembaga statistik resmi.
Dasar ilmiah dan cara kerjanya ada di [synthetic-gen/METODOLOGI.md](synthetic-gen/METODOLOGI.md), dan hasil uji kemiripan,
kegunaan serta privasinya di [synthetic-gen/laporan/EVALUASI.md](synthetic-gen/laporan/EVALUASI.md).

## Yang berbeda dari AI JKN Audit

| | AI JKN Audit | AI JKN Synthetic |
|---|---|---|
| Sumber data | `Data BPJS/2025` (asli, terikat pakta integritas) | `Data Sintetis/2025` (sintetis, format `.dta` identik) |
| UI / API | 8900 / 8100 | **9300 / 8300** |
| PostgreSQL | 127.0.0.1:5434 `ai_jkn_audit` | **127.0.0.1:5435 `ai_jkn_synthetic`** |
| SQL untuk BI | 5443 | 5453 |
| Cookie sesi, container | `AIJKN_SESSION`, `aijkn-` | `AIJKNSYN_SESSION`, `aijknsyn-` |
| Run AI Agent Swarm, cache putusan LLM, model ML lama | ada (dari data asli) | **tidak ada**: dimulai bersih, model ML dilatih ulang di data sintetis |
| Kunci OpenAI | — | dinonaktifkan |
| Bucket S3 bersama (`bluesandai-data-infrastructure`) | dipakai | **dimatikan**: instance ini tidak bisa membaca atau menimpa file di S3 milik app lain. Item demo non-JKN yang tersimpan di S3 tidak tersedia di sini. |
| Batas objek per tipe Nexus | 50.000 | 150.000 (`instance.env`): tabel gold sintetis sedikit lebih menyebar |

`api/bpjs_sampel/catalog.py` dikunci ke `Data Sintetis/2025`. App ini tidak pernah membaca folder data BPJS asli.

## Menjalankan

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1          # lalu buka http://localhost:9300/aip-jkn
```

Akun sama dengan AI JKN Audit (database pengguna ikut disalin).

Build pipeline dan job ML menulis file sementara ke `TEMP`. Agar drive C tidak penuh, jalankan API dengan `TEMP`/`TMP`
diarahkan ke `D:\BluesandAI\ai-jkn-synthetic\.tmp`. Untuk memangkas versi dataset lama setelah pembangunan ulang berulang:
`.venv\Scripts\python.exe -I synthetic-gen\prune_versions.py`.

## Membuat ulang data sintetis

Butuh akses ke data asli (hanya di mesin tim BPJS, dibaca di tempat, tidak disalin):

```powershell
.venv\Scripts\python.exe -I synthetic-gen\run.py                 # 7 edisi -> Data Sintetis/2025 (±25 menit, 2 proses)
.venv\Scripts\python.exe -I synthetic-gen\evaluate.py            # fidelity, utility, privacy -> laporan/evaluasi.json
.venv\Scripts\python.exe -I synthetic-gen\laporan_md.py          # -> laporan/EVALUASI.md
.venv\Scripts\python.exe -I synthetic-gen\scan_real_ids.py       # tidak ada ID asli di data/, Data Sintetis/, synthetic-gen/
.venv\Scripts\python.exe -I synthetic-gen\place_raw.py           # .dta sintetis ke item Files raw/
cd api; ..\.venv\Scripts\python.exe -I ..\synthetic-gen\rebuild_platform.py bronze pipeline fakta nexus reindex swarm
                                                                                # bronze -> silver/gold -> Fakta -> Nexus (API 8300 hidup)
.venv\Scripts\python.exe -I synthetic-gen\retrain.py                            # model ML di data sintetis + Keamanan & Akses
cd api; ..\.venv\Scripts\python.exe -I ..\synthetic-gen\rebuild_platform.py reindex   # objek Nexus skor ML
```

## Aturan

- Angka di app ini adalah angka **dunia sintetis**. Pakai untuk demo, pengembangan dan pengujian metode, bukan sebagai
  statistik BPJS.
- Jangan arahkan instance ini ke data asli atau ke database AI JKN Audit.
- Run AI Agent Swarm di sini tetap memanggil model berbayar. Datanya sintetis, tapi biayanya nyata.
