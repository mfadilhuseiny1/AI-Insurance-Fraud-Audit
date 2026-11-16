# Pipeline Data Sampel BPJS Kesehatan Edisi 2025

Transformasi Data Sampel BPJS Kesehatan (7 edisi: Reguler, COVID, DM, Kesehatan Mental, KIA Ibu, KIA Anak, TB) dari
file Stata mentah menjadi dataset rapi. Rancangan lengkap: `docs/PIPELINE_DATA_SAMPEL_BPJS.md` di repositori platform.

```
raw/<tabel>/*.dta ── bronze_<tabel> ──▶ bronze/<tabel>            kode & nama kolom asli, 7 edisi digabung
                                    └─▶ bronze/_meta/label_nilai_<tabel>, katalog_<tabel>
bronze/* ── silver_* ──▶ silver/peserta, kunjungan_fktp, kunjungan_fkrtl, diagnosis_sekunder,
                         tindakan_nonkapitasi, rujukan, dim_icd10, dim_icd10_rinci, dim_inacbg,
                         dim_wilayah, dim_profil_faskes, _laporan_kualitas
silver/* ── Pipeline Builder "Pipeline Gold Data Sampel BPJS" (DuckDB lokal) ──▶ gold/* (agregat, nama, rasio, peringkat)
```

Urutan build: `bronze_*` (5) → `silver_peserta`, `silver_kunjungan_fktp`, `silver_diagnosis_sekunder`,
`silver_tindakan_nonkapitasi` → `silver_kunjungan_fkrtl` → `silver_rujukan`, `silver_dimensi` → `silver_laporan_kualitas` → pipeline gold.

- Satu transform per dataset fakta (memori: satu keluaran per build); teks berulang disimpan sebagai dictionary.
- Ekspektasi dicek di dalam transform; gagal = build gagal. `silver/_laporan_kualitas` mencatat semuanya.
- Masalah kualitas jadi kolom `flag_*`; baris tidak pernah dibuang.
- Cacat sumber: huruf "go" terhapus di sebagian teks nama diagnosis ("goitre" → "itre"); hanya kata yang sudah
  diperiksa yang dipulihkan (`GO_REPAIR` di `bpjs_spec.py`), barisnya ditandai, teks asli tetap di bronze.
- Bobot (`PSTV15` → `bobot`) dibawa sebagai kolom; transformasi ini tidak menerapkannya.
- Readmisi 30 hari: klaim rawat inap (keparahan INA-CBG bukan "Rawat Jalan") yang diikuti rawat inap berikutnya peserta
  yang sama dalam ≤ 30 hari setelah pulang, dalam edisi yang sama (dihitung di pipeline gold, node `klaim`).
- Gold dibangun di Pipeline Builder langsung dari silver (jutaan baris) dengan mesin DuckDB lokal: tiap output menjadi satu
  SQL DuckDB atas file Parquet di disk. Repositori ini berhenti di silver.
