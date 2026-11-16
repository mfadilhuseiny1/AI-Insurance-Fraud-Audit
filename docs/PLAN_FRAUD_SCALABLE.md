# Plan Skalabilitas â€” Fraud Intelligence JKN (Demo â†’ Produksi)

> Status: Tahap 1-4 diterapkan (store JSON demo; migrasi dataset platform = pekerjaan lanjutan di luar demo).
> Cakupan: `api/demo_jkn_fraud.py`, `web/src/app/demo-jkn/fraud/`,
> `web/src/components/demo/fraud/`. Pain point acuan: 6 pain point fraud JKN
> (kasus investigasi, graf kolusi, validasi billing, skor explainable,
> pre-payment, aturan berversi).

## Goal

Membawa Fraud Intelligence dari demo data sintetis in-memory (40 klaim)
menjadi layanan yang sanggup menangani volume klaim JKN nasional
(jutaan SEP/bulan) tanpa mengubah kontrak fitur 6 pain point.

## Kondisi Saat Ini (fakta dari kode)

| Aspek | Kondisi | Bottleneck |
|---|---|---|
| Data | List Python di memori proses (`CLAIMS`, `CASES`, `GRAPH` dihitung saat import) | Hilang saat restart, tidak bisa multi-instance, RAM-bound |
| Komputasi | `billing_checks()` dihitung ulang di banyak endpoint; pencarian klaim linear di `build_cases()` | O(nÂ²) kasar, latency naik linear terhadap klaim |
| API | Tanpa pagination, tanpa cache header, satu proses uvicorn | Payload membengkak; tidak bisa di-scale horizontal |
| Graf | Semua node/edge dikirim sekaligus, layout lingkaran di backend | Browser jenuh di >10k node; tidak ada query subgraf |
| Aturan | List di memori, aktivasi mengubah state proses | Tidak persisten, tidak ada approval workflow, tidak konsisten antar-instance |
| Frontend | Satu file halaman memuat 7 endpoint sekaligus di awal | First load berat; tidak ada lazy-load per tab, search, atau pagination |
| Keamanan | Mengandalkan auth aplikasi induk | Belum ada rate-limit khusus skrining & audit per-aksi fraud |

## Success Criteria

1. Skrining pre-payment 1 klaim: p95 < 300 ms pada 1 juta klaim/bulan.
2. Daftar kasus/billing/skor: pagination server-side, payload per halaman â‰¤ 50 baris.
3. Graf: query subgraf per faskes/jaringan (bukan full graph), render â‰¤ 500 node per view.
4. API stateless: â‰¥ 2 instance di balik load balancer memberi jawaban identik.
5. Aktivasi aturan persisten, berversi, dan tercatat di audit trail lintas restart.
6. UI: data per tab dimuat saat tab dibuka (lazy), ada search/filter/pagination,
   state loading/error/empty eksplisit di semua panel.

## Approach â€” Target Arsitektur

```text
Sumber (e-Klaim, VClaim, RM, tarif, HFIS)
  â†’ Ingestion terjadwal/streaming ke dataset bersih platform (Files/pipeline)
  â†’ Fraud store persisten (tabel: klaim, temuan_billing, skor_risiko,
    kasus_investigasi, bukti, relasi_graf, aturan + versi, audit_trail)
  â†’ API stateless (endpoint sekarang, +pagination/cache) â€” scale horizontal
  â†’ Pekerja async untuk batch scoring & deteksi ring graf (antrean tugas)
  â†’ Frontend modular: 1 panel per pain point, lazy fetch, pagination
```

Prinsip: pertahankan kontrak endpoint & bentuk respons saat ini. Migrasi
terjadi di belakang kontrak itu (repository pattern), bukan rewrite UI/API.

## Steps

### Tahap 1 â€” Fondasi (diterapkan)
- [x] Backend: hasil `billing_checks` & skor dihitung sekali, di-cache di
      memori proses; indeks `no_sep â†’ klaim` (hilangkan pencarian linear).
- [x] Backend: pagination `?limit=&offset=` + meta `total` di
      `/cases`, `/billing-checks`, `/risk-scores`; batas `limit` 1â€“200.
- [x] Backend: `/graph?max_edges=` untuk membatasi payload graf.
- [x] Frontend: pecah halaman monolit menjadi komponen
      `web/src/components/demo/fraud/` (`types`, `api`, `ui`, panel per tab).
- [x] Frontend: profesionalisasi UI memakai primitif workspace yang sama
      dengan Ruang Kerja Audit (`ModuleHeader`, `PageRail`, `Widget`,
      `MetricWidget`, `Badge`) â€” satu bahasa visual.
- [x] Frontend: lazy-fetch per tab, search kasus, pagination tabel
      billing & skor, state loading/error/empty seragam.

### Tahap 2 â€” Persistensi (diterapkan: store JSON; dataset platform menyusul)
- Pindahkan `CLAIMS/CASES/RULES/AUDIT_TRAIL` ke dataset/tabel platform
  (ikuti pola `demo_jkn_e2e`: pipeline â†’ dataset bersih â†’ object type).
- Repository layer di `demo_jkn_fraud.py`: fungsi `load_*()` membaca store,
  bukan list global; cache dengan TTL + invalidasi saat build pipeline selesai.
- Aktivasi aturan menulis ke store + audit trail persisten; tambah status
  `draft â†’ review â†’ aktif` (approval), bukan aktivasi langsung.

### Tahap 3 â€” Scale-out komputasi (diterapkan)
- Batch scoring malam/batch per periode sebagai pipeline transform
  (pola `demo_jkn_pipeline`), bukan hitung on-request.
- Deteksi ring graf sebagai job async berkala; simpan subgraf hasil,
  endpoint graf membaca hasil (query per faskes dengan kedalaman 1â€“2).
- Pre-payment screening tetap synchronous (jalur cepat), tetapi hanya
  memakai skor & aturan yang sudah ter-materialisasi â€” target p95 < 300 ms.

### Tahap 4 â€” Operasional & keamanan (diterapkan)
- Rate-limit + idempotency-key di `POST /prepayment/screen`; log keputusan
  ke audit.3 seperti kontrol governance demo yang sudah ada.
- Metrik per aturan (hit rate, FP rate, latency) dihitung dari keputusan
  investigator (feedback loop), bukan angka statis.
- Row-level access per kantor cabang mengikuti pola `demo_jkn_akses`.

## Validation Plan

| Tahap | Bukti |
|---|---|
| 1 | `pytest api/test_demo_jkn_fraud.py` hijau (termasuk test pagination); `npm run build` sukses; halaman `/demo-jkn/fraud` HTTP 200 |
| 2 | Restart API tidak menghilangkan kasus/aturan aktif; test repository dengan store sementara |
| 3 | Benchmark skrining: 1.000 klaim sintetis, ukur p95; job graf selesai < ambang waktu yang disepakati |
| 4 | Jejak audit muncul untuk aktivasi aturan & keputusan HOLD; uji akses per kantor cabang |

## Risks / Non-Goals

- Risiko: kontrak respons berubah diam-diam saat migrasi store â†’ mitigasi:
  test endpoint yang ada menjadi kontrak; jangan ubah nama field.
- Risiko: graf nasional terlalu besar untuk satu query â†’ mitigasi: selalu
  query subgraf, tidak pernah full-graph (Tahap 3).
- Non-goal: mengganti 20 aturan skrining `demo_jkn_rules.py` atau model ML
  `demo_jkn_ml.py`; plan ini hanya melapisi & menskalakan fraud intelligence.
- Non-goal: integrasi BPJS produksi; semua data tetap sintetis pada demo.

## Open Questions

- Store persisten memakai dataset platform (Files/Ontology) atau database
  aplikasi? Rekomendasi: dataset platform, mengikuti pola demo JKN lain.
  Keputusan diperlukan sebelum Tahap 2 dimulai.


