# AI JKN Audit

AIP JKN dari platform BluesandAI, disalin pada 29 Oktober 2026 dari `D:\BluesandAI\bluesandai-parse` supaya bisa
dijalankan sendiri. Isinya: kode, data, database, histori eksperimen, dan virtualenv yang paketnya identik. Aplikasi ini
berjalan berdampingan dengan platform asal tanpa saling menyentuh.

## Menjalankan

Klik dua kali `start.bat`, atau jalankan:

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1            # lalu terbuka http://localhost:8900/aip-jkn
powershell -ExecutionPolicy Bypass -File start.ps1 -NoBrowser # tanpa membuka browser
```

`start.ps1` menyalakan tiga layanan, masing-masing tanpa jendela konsol:

| Layanan | AI JKN Audit | Platform asal |
| --- | --- | --- |
| PostgreSQL | 127.0.0.1:5434, database `ai_jkn_audit` (folder `.pgdata`) | 127.0.0.1:5432, `bluesandai_parse` |
| API | http://localhost:8100 | http://localhost:8000 |
| UI | http://localhost:8900 | http://localhost:8888 |
| SQL untuk BI | 127.0.0.1:5443 | 127.0.0.1:5433 |

Untuk restart API: `.work\koordinasi\restart_api.ps1 -Sesi <nama> -Alasan <alasan>`. Skrip ini menolak restart selama
ada job, build, atau penugasan Swarm yang sedang berjalan, dan hanya menyentuh port 8100.

## Yang ikut tersalin

- Semua tab AIP JKN: AI Agent Swarm, Agen, ML Studio, Box Karantina, Evaluasi Swarm, Keamanan & Akses, Nexus · Object
  Explorer, Data Lineage, Pipeline Builder. Juga menu akun: Account settings, Users and markings, emulation mode.
- Histori: 386 run AIP (termasuk semua penugasan Swarm dan laporannya), job ML dan model card, MLflow, model produksi,
  Box Karantina per penugasan, buku besar indikasi, missions, skills, workspace JupyterLab, pengguna, role, dan marking.
- Data Sampel BPJS: pipeline Data Mentah → Siap Analisis dan Fakta Klaim, semua versi dataset, dan objek Nexus.
- Kode platform inti (`api/`, `web/`). Nexus, Lineage, Pipeline Builder, dan sign-in adalah modul platform yang dimuat
  `server.py` bersama-sama, jadi semuanya ikut.

Yang tidak disalin: worker OCR (docling, mineru, paddleocr, glmocr, fast-worker), folder referensi dokumentasi, log,
store MQTT demo (`data/streaming`, sehingga demo time series tidak jalan di sini), serta dua cache yang dibangun ulang
saat dibutuhkan (`data/dataset_preview`, `data/duckdb-checkpoints`). Akibatnya preview pertama Pipeline Builder lebih lambat.

## Yang berbeda dari platform asal

- `instance.env` memuat port, nama cookie sesi (`AIJKN_SESSION`), dan awalan nama container Docker (`aijkn-…`).
  Dengan begitu login di sini tidak menimpa login platform, dan JupyterLab/VS Code di sini tidak menghentikan container
  milik platform. `api/server.py` membaca file ini saat start.
- `web/.env.local`: `NEXT_PUBLIC_API_PORT=8100`; `web/package.json`: port 8900.
- Tidak ada panel kiri dan belum ada logo. Bulatan profil ada di ujung kanan bilah atas AIP JKN. Menunya berisi
  Account settings, Users and markings, emulation mode, dan Sign out (`UserMenu` di `web/src/components/Sidebar.tsx`).
  Halaman lain mendapat bilah tipis berisi "← AIP JKN" dan bulatan yang sama. `/` langsung membuka /aip-jkn. Katalog aplikasi
  (`web/src/lib/platformApps.ts`, Platform Apps, pencarian Ctrl+J) hanya berisi AIP JKN. Halaman platform lain masih
  ada di kode dan bisa dibuka lewat URL, tetapi tidak ditautkan.
- Path absolut ke repo asal di data (job ML, paket model produksi, run, metadata Iceberg) dan di tabel `files` sudah
  diarahkan ke folder ini.
- `requirements/api-lock.txt` dan `requirements/adk-lock.txt` adalah daftar paket persis dari `.venv` dan `.venv-adk`
  asal. Pasang ulang dengan `uv pip install --python .venv\Scripts\python.exe -r requirements\api-lock.txt`.

## Perlu diketahui

- **Hard link.** File versi dataset (`data/lineage/versions/**/*.parquet`), arsip `.dta` di `data/drive`, dan `Data BPJS/`
  adalah hard link ke file yang sama di repo asal (25 GB tanpa memakan ruang tambahan). Aplikasi hanya membuat file baru
  dan tidak pernah menulis ulang file-file ini. Menghapusnya di salah satu sisi tidak memengaruhi sisi lain. Jangan
  mengedit file-file itu di tempat dengan alat lain.
- **Sumber mentah BPJS** dibaca dari `D:\BPJS\2025` bila ada (sama dengan platform, hanya dibaca), lalu dari `Data BPJS\2025`.
- **Anggaran Vertex** dicatat terpisah (`data/aip/vertex_spend`). Batas $70 berlaku per aplikasi, jadi bila keduanya
  dipakai, total belanja bisa melebihi anggaran awal.
- Database dibuat oleh `setup-database.ps1` (sekali saja). Password role `bluesandai` di sini baru dan hanya tersimpan di
  `.env.local`. Password superuser cluster ini ada di `secrets\pg-superuser.txt`.
- Folder ini belum menjadi repo git.
