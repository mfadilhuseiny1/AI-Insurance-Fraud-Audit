"""L3 gold in Pipeline Builder: "Pipeline Gold Data Sampel BPJS". It reads the silver facts directly (5.4 million
FKRTL claims, 9.7 million FKTP visits, 2.2 million referrals, 3.8 million participants) and the silver dimensions,
and writes the gold datasets: aggregates with names (wilayah, ICD-10, INA-CBG), ratios and rankings.

It builds on the DuckDB local engine (compute "duckdb", api/pipeline_duckdb.py): each output compiles to one DuckDB
statement that runs over the Parquet files on disk, so the SQL steps are DuckDB SQL. The editor keeps a sample of each
input (SAMPLE rows) for its preview.

Readmission: an inpatient claim (INA-CBG severity not "Rawat Jalan") followed by the same participant's next inpatient
admission within 30 days of discharge, in the same edition (node `klaim`).

Provinces: the 38-province coding the data carries (its *_38 columns), through one dimension, node `wilayah` (kab/kota
→ province): the 2022 split of Papua moved 26 kab/kota to Papua Barat Daya (92), Papua Selatan (95), Papua Tengah (96)
and Papua Pegunungan (97). Every province column of the gold is this coding, joined by kab/kota; the BPS prefix of a
kab/kota code (kode // 100) is the 34-province coding and is kept only in `wilayah` (provinsi_34_kode).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

PIPELINE = "Pipeline Gold Data Sampel BPJS"
SPEC_VERSION = 12
# rows of each input kept in the pipeline file for the editor's preview (web/src/lib/deployed.ts SAMPLE_ROWS)
SAMPLE = 100

# (node id, name, group, description) of the sources; the name is the dataset in silver/ and the SQL table name
SOURCES = [
    ("s_fkrtl", "kunjungan_fkrtl", "klaim", "Klaim FKRTL (rawat jalan & inap RS): 1 baris per kunjungan, INA-CBG, biaya, flag kualitas"),
    ("s_fktp", "kunjungan_fktp", "fktp", "Kunjungan FKTP (puskesmas, klinik, dokter praktik): 1 baris per kunjungan"),
    ("s_rujukan", "rujukan", "rujukan", "Rujukan FKTP → FKRTL: kunjungan FKTP yang dirujuk dan kunjungan RS-nya"),
    ("s_peserta", "peserta", "peserta", "Peserta JKN: 1 baris per peserta per edisi"),
    ("s_wilayah", "dim_wilayah", "dimensi", "Kab/kota → provinsi (label nilai sumber)"),
    ("s_icd10", "dim_icd10", "dimensi", "ICD-10 3 digit (buku kode resmi)"),
    ("s_dim_inacbg", "dim_inacbg", "dimensi", "INA-CBG: deskripsi, CMG, tipe kasus, keparahan"),
    ("s_profil", "dim_profil_faskes", "dimensi", "Profil faskes (pengganti ID faskes yang tidak ada di sumber): tingkat, kab/kota, kepemilikan, jenis, tipe"),
]


def _tt(c: str) -> str:
    """A grouping column left empty in the source is a group of its own, named: every gold key stays non-null."""
    return f"coalesce({c}, 'tidak tercatat') AS {c}"


# the claim measures every FKRTL aggregate carries
MEASURES = """count(*) AS klaim, count(*) FILTER (WHERE rawat_inap) AS klaim_inap, count(DISTINCT peserta_id) AS peserta,
         sum(biaya_tagih_rp)::DOUBLE AS biaya_tagih_rp, sum(biaya_verifikasi_rp)::DOUBLE AS biaya_verifikasi_rp,
         sum(los_hari) FILTER (WHERE rawat_inap)::DOUBLE AS los_hari_inap, count(*) FILTER (WHERE readmisi_30) AS readmisi_30,
         count(*) FILTER (WHERE flag_calon_klaim_ganda) AS calon_klaim_ganda, count(*) FILTER (WHERE flag_selisih_verifikasi) AS selisih_verifikasi,
         count(*) FILTER (WHERE flag_los_ekstrem) AS los_ekstrem"""

SQL = {
    # kab/kota → its province in the data's 38-province coding (the *_38 columns of the FKTP visits, the participants'
    # residence and the FKRTL claims). A kab/kota belongs to the province its rows are coded to; where it also shows its
    # old province (the FKRTL claims took the new codes only from July 2024 on), the code other than its BPS prefix wins.
    # dim_wilayah's columns (kab/kota code and name, province code and name) are renamed by position, and the output
    # columns are *_nama: the province and kab/kota nodes read this node, and a SQL step pulls in every node whose name
    # appears in its text, so naming them here would be a cycle.
    "wilayah": """
WITH v AS (
  SELECT kabkota_fktp_kode AS kode, provinsi_fktp_38_kode AS kode_38, provinsi_fktp_38 AS nama_38 FROM kunjungan_fktp
  UNION ALL SELECT kabkota_tinggal_kode, provinsi_tinggal_38_kode, provinsi_tinggal_38 FROM peserta
  UNION ALL SELECT kabkota_fkrtl_kode, provinsi_fkrtl_38_kode, provinsi_fkrtl_38 FROM kunjungan_fkrtl),
pindah AS (SELECT kode, mode(kode_38) AS kode_38 FROM v WHERE kode_38 <> kode // 100 GROUP BY kode),
nama AS (SELECT kode_38, mode(nama_38) AS nama_38 FROM v WHERE nama_38 IS NOT NULL GROUP BY kode_38)
SELECT i.kode AS kabkota_kode, i.nama AS kabkota_nama, coalesce(p.kode_38, i.kode_34) AS provinsi_kode,
       coalesce(n.nama_38, i.nama_34) AS provinsi_nama, i.kode_34 AS provinsi_34_kode, i.nama_34 AS provinsi_34_nama
FROM input AS i(kode, nama, kode_34, nama_34)
LEFT JOIN pindah p ON p.kode = i.kode
LEFT JOIN nama n ON n.kode_38 = coalesce(p.kode_38, i.kode_34)""",
    # provinces placed at their capital (the map's point layer); 99 'TIDAK TERDEFINISI' has none
    "provinsi": f"""
SELECT w.provinsi_kode, w.provinsi, w.kabkota, c.ibukota, c.lokasi,
       coalesce(k.klaim, 0) AS klaim_fkrtl, k.peserta AS peserta_fkrtl, k.biaya_tagih_rp, k.biaya_verifikasi_rp,
       ROUND(100.0 * k.readmisi_30 / NULLIF(k.klaim_inap, 0), 2) AS pct_readmisi_30, coalesce(k.klaim_berisiko, 0) AS klaim_berisiko
FROM (SELECT provinsi_kode, provinsi_nama AS provinsi, count(*) AS kabkota FROM input WHERE provinsi_nama IS NOT NULL GROUP BY ALL) w
LEFT JOIN (VALUES
         (11, 'Banda Aceh', '5.55,95.32'),
         (12, 'Medan', '3.59,98.67'),
         (13, 'Padang', '-0.95,100.35'),
         (14, 'Pekanbaru', '0.51,101.45'),
         (15, 'Jambi', '-1.61,103.61'),
         (16, 'Palembang', '-2.99,104.76'),
         (17, 'Bengkulu', '-3.8,102.27'),
         (18, 'Bandar Lampung', '-5.43,105.26'),
         (19, 'Pangkalpinang', '-2.13,106.11'),
         (21, 'Tanjungpinang', '0.92,104.45'),
         (31, 'Jakarta', '-6.2,106.85'),
         (32, 'Bandung', '-6.91,107.61'),
         (33, 'Semarang', '-6.97,110.42'),
         (34, 'Yogyakarta', '-7.8,110.36'),
         (35, 'Surabaya', '-7.26,112.75'),
         (36, 'Serang', '-6.12,106.15'),
         (51, 'Denpasar', '-8.65,115.22'),
         (52, 'Mataram', '-8.58,116.12'),
         (53, 'Kupang', '-10.17,123.61'),
         (61, 'Pontianak', '-0.03,109.33'),
         (62, 'Palangka Raya', '-2.21,113.92'),
         (63, 'Banjarbaru', '-3.44,114.83'),
         (64, 'Samarinda', '-0.5,117.15'),
         (65, 'Tanjung Selor', '2.84,117.37'),
         (71, 'Manado', '1.47,124.84'),
         (72, 'Palu', '-0.9,119.87'),
         (73, 'Makassar', '-5.15,119.43'),
         (74, 'Kendari', '-3.97,122.51'),
         (75, 'Gorontalo', '0.54,123.06'),
         (76, 'Mamuju', '-2.68,118.89'),
         (81, 'Ambon', '-3.7,128.17'),
         (82, 'Sofifi', '0.74,127.56'),
         (91, 'Manokwari', '-0.86,134.06'),
         (92, 'Sorong', '-0.88,131.26'),
         (94, 'Jayapura', '-2.53,140.72'),
         (95, 'Merauke', '-8.49,140.4'),
         (96, 'Nabire', '-3.37,135.48'),
         (97, 'Wamena', '-4.1,138.95')) c(provinsi_kode, ibukota, lokasi) USING (provinsi_kode)
LEFT JOIN (SELECT provinsi_kode, {MEASURES},
                  count(*) FILTER (WHERE flag_calon_klaim_ganda OR flag_selisih_verifikasi OR flag_los_ekstrem) AS klaim_berisiko
           FROM klaim GROUP BY ALL) k USING (provinsi_kode)""",
    "klaim": f"""
WITH c AS (
  SELECT edisi, kunjungan_fkrtl_id, peserta_id, tgl_datang, tgl_pulang, bulan, kabkota_fkrtl_kode, w.provinsi_kode, {_tt('tipe_fkrtl')}, inacbg_kode,
         inacbg_cmg, inacbg_keparahan, {_tt('regional_tarif')}, los_hari, biaya_tagih_rp, biaya_verifikasi_rp, dx_primer_icd3,
         flag_calon_klaim_ganda, flag_selisih_verifikasi, flag_los_ekstrem,
         md5(concat_ws('|', 'FKRTL', kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl)) AS faskes_profil_id,
         kelas_rawat, poli, dx_primer_nama, tarif_inacbg_rp, selisih_rp,
         coalesce(inacbg_keparahan, '') <> 'Rawat Jalan' AND inacbg_keparahan IS NOT NULL AS rawat_inap
  FROM input LEFT JOIN wilayah w ON w.kabkota_kode = input.kabkota_fkrtl_kode),
n AS (
  SELECT edisi, kunjungan_fkrtl_id,
         lead(tgl_datang) OVER (PARTITION BY edisi, peserta_id ORDER BY tgl_datang, kunjungan_fkrtl_id) AS inap_berikut
  FROM c WHERE rawat_inap)
SELECT c.*, coalesce(date_diff('day', c.tgl_pulang, n.inap_berikut) BETWEEN 0 AND 30, false) AS readmisi_30
FROM c LEFT JOIN n USING (edisi, kunjungan_fkrtl_id)""",
    "klaim_kabkota": f"""
SELECT concat_ws(':', k.edisi, k.kabkota_kode, k.tipe_fkrtl) AS klaim_kabkota_id, k.edisi, k.kabkota_kode, w.kabkota_nama AS kabkota, w.provinsi_kode,
       w.provinsi_nama AS provinsi, k.tipe_fkrtl,
       k.klaim, k.klaim_inap, k.peserta, k.biaya_tagih_rp, k.biaya_verifikasi_rp,
       ROUND(k.biaya_tagih_rp * 1.0 / k.klaim, 0) AS rata_biaya_tagih_rp,
       ROUND(k.los_hari_inap * 1.0 / NULLIF(k.klaim_inap, 0), 2) AS rata_los_inap_hari,
       k.readmisi_30, ROUND(100.0 * k.readmisi_30 / NULLIF(k.klaim_inap, 0), 2) AS pct_readmisi_30,
       k.calon_klaim_ganda, ROUND(100.0 * k.calon_klaim_ganda / k.klaim, 3) AS pct_calon_klaim_ganda,
       k.selisih_verifikasi, k.los_ekstrem
FROM (SELECT edisi, kabkota_fkrtl_kode AS kabkota_kode, tipe_fkrtl,
         {MEASURES}
      FROM input GROUP BY ALL) k
LEFT JOIN wilayah w ON w.kabkota_kode = k.kabkota_kode""",
    "klaim_bulanan": f"""
SELECT concat_ws(':', b.edisi, b.bulan, b.provinsi_kode, coalesce(b.inacbg_cmg, '-'), coalesce(b.inacbg_keparahan, '-')) AS klaim_bulanan_id,
       b.edisi, b.bulan, b.provinsi_kode, p.provinsi, b.inacbg_cmg, b.inacbg_keparahan,
       b.klaim, b.klaim_inap, b.peserta, b.biaya_tagih_rp, b.biaya_verifikasi_rp,
       ROUND(b.biaya_tagih_rp * 1.0 / b.klaim, 0) AS rata_biaya_tagih_rp,
       ROUND(b.los_hari_inap * 1.0 / NULLIF(b.klaim_inap, 0), 2) AS rata_los_inap_hari,
       b.readmisi_30, b.calon_klaim_ganda, b.los_ekstrem
FROM (SELECT edisi, strftime(bulan, '%Y-%m') AS bulan, provinsi_kode, inacbg_cmg, inacbg_keparahan,
         {MEASURES}
      FROM input GROUP BY ALL) b
LEFT JOIN provinsi p ON p.provinsi_kode = b.provinsi_kode""",
    "indikator_inacbg": f"""
SELECT concat_ws('|', a.edisi, a.inacbg_kode, a.tipe_fkrtl, a.regional_tarif) AS indikator_id, a.edisi, a.inacbg_kode, d.deskripsi AS inacbg_deskripsi, d.cmg, d.tipe_kasus, d.keparahan, a.tipe_fkrtl, a.regional_tarif,
       a.klaim, a.klaim_inap, a.biaya_tagih_rp, a.biaya_verifikasi_rp,
       ROUND(a.biaya_tagih_rp * 1.0 / a.klaim, 0) AS rata_biaya_tagih_rp, a.biaya_tagih_p50_rp,
       a.los_inap_p50, a.los_inap_p90,
       ROUND(100.0 * a.readmisi_30 / NULLIF(a.klaim_inap, 0), 2) AS pct_readmisi_30,
       ROUND(100.0 * a.calon_klaim_ganda / a.klaim, 3) AS pct_calon_klaim_ganda,
       ROUND(100.0 * a.los_ekstrem / a.klaim, 3) AS pct_los_ekstrem,
       ROUND(100.0 * a.selisih_verifikasi / a.klaim, 3) AS pct_selisih_verifikasi
FROM (SELECT edisi, inacbg_kode, tipe_fkrtl, regional_tarif,
         {MEASURES},
         quantile_cont(los_hari, 0.5) FILTER (WHERE rawat_inap) AS los_inap_p50,
         quantile_cont(los_hari, 0.9) FILTER (WHERE rawat_inap) AS los_inap_p90,
         quantile_cont(biaya_tagih_rp, 0.5)::DOUBLE AS biaya_tagih_p50_rp
      FROM input WHERE inacbg_kode IS NOT NULL GROUP BY ALL) a
LEFT JOIN dim_inacbg d ON d.inacbg_kode = a.inacbg_kode""",
    "kunjungan_fktp_bulanan": f"""
SELECT concat_ws(':', f.edisi, f.bulan, f.provinsi_kode, f.jenis_fktp, f.poli) AS kunjungan_fktp_bulanan_id, f.edisi, f.bulan, f.provinsi_kode, p.provinsi, f.jenis_fktp, f.poli, f.kunjungan, f.peserta, f.kunjungan_sakit, f.rujuk_lanjut,
       ROUND(100.0 * f.rujuk_lanjut / f.kunjungan, 2) AS pct_rujuk_lanjut
FROM (SELECT edisi, strftime(bulan, '%Y-%m') AS bulan, w.provinsi_kode, jenis_fktp, {_tt('poli')},
             count(*) AS kunjungan, count(DISTINCT peserta_id) AS peserta,
             count(*) FILTER (WHERE status_pulang = 'RUJUK LANJUT') AS rujuk_lanjut,
             count(*) FILTER (WHERE jenis_kunjungan = 'KUNJUNGAN SAKIT') AS kunjungan_sakit
      FROM input LEFT JOIN wilayah w ON w.kabkota_kode = input.kabkota_fktp_kode GROUP BY ALL) f
LEFT JOIN provinsi p ON p.provinsi_kode = f.provinsi_kode""",
    "penyakit_teratas": """
WITH d AS (
  SELECT edisi, w.provinsi_kode, 'FKTP' AS tingkat, dx_icd3 AS icd3, count(*) AS kunjungan,
         count(DISTINCT peserta_id) AS peserta, 0::DOUBLE AS biaya_tagih_rp
  FROM input LEFT JOIN wilayah w ON w.kabkota_kode = input.kabkota_fktp_kode WHERE dx_icd3 IS NOT NULL GROUP BY ALL
  UNION ALL
  SELECT edisi, provinsi_kode, 'FKRTL', dx_primer_icd3, count(*), count(DISTINCT peserta_id), sum(biaya_tagih_rp)::DOUBLE
  FROM klaim WHERE dx_primer_icd3 IS NOT NULL GROUP BY ALL)
SELECT concat_ws(':', edisi, provinsi_kode, tingkat, peringkat) AS penyakit_teratas_id, * FROM (
  SELECT d.edisi, d.provinsi_kode, p.provinsi, d.tingkat, d.icd3, i.nama AS diagnosis, i.bab, d.kunjungan, d.peserta, d.biaya_tagih_rp,
         ROW_NUMBER() OVER (PARTITION BY d.edisi, d.provinsi_kode, d.tingkat ORDER BY d.kunjungan DESC, d.icd3) AS peringkat
  FROM d LEFT JOIN dim_icd10 i ON i.icd3 = d.icd3 LEFT JOIN provinsi p ON p.provinsi_kode = d.provinsi_kode
) WHERE peringkat <= 20""",
    "alur_rujukan": f"""
SELECT concat_ws(':', r.edisi, r.kabkota_asal_kode, r.kabkota_tujuan_kode, r.tipe_faskes_tujuan) AS alur_rujukan_id,
       r.edisi, r.kabkota_asal_kode, a.kabkota_nama AS kabkota_asal, a.provinsi_nama AS provinsi_asal,
       r.kabkota_tujuan_kode, t.kabkota_nama AS kabkota_tujuan, t.provinsi_nama AS provinsi_tujuan, r.tipe_faskes_tujuan,
       r.rujukan, r.median_hari_ke_fkrtl, ROUND(100.0 * r.dx_sama / r.rujukan, 2) AS pct_dx_sama,
       CASE WHEN r.kabkota_asal_kode = r.kabkota_tujuan_kode THEN 0 ELSE 1 END AS lintas_kabkota,
       CASE WHEN a.provinsi_kode = t.provinsi_kode THEN 0 ELSE 1 END AS lintas_provinsi
FROM (SELECT edisi, kabkota_asal_kode, kabkota_tujuan_kode, {_tt('tipe_faskes_tujuan')}, count(*) AS rujukan,
             median(hari_ke_fkrtl) AS median_hari_ke_fkrtl, count(*) FILTER (WHERE dx_sama) AS dx_sama
      FROM input GROUP BY ALL) r
LEFT JOIN wilayah a ON a.kabkota_kode = r.kabkota_asal_kode
LEFT JOIN wilayah t ON t.kabkota_kode = r.kabkota_tujuan_kode""",
    "profil_peserta": f"""
SELECT concat_ws(':', s.edisi, s.provinsi_kode, s.segmen, s.jenis_kelamin, s.kelompok_usia) AS profil_peserta_id,
       s.edisi, s.provinsi_kode, p.provinsi, s.segmen, s.jenis_kelamin, s.kelompok_usia, s.peserta, s.peserta_aktif, s.peserta_meninggal
FROM (SELECT edisi, coalesce(w.provinsi_kode, provinsi_tinggal_38_kode) AS provinsi_kode, {_tt('segmen')}, jenis_kelamin,
             CASE WHEN usia_akhir_2024 IS NULL OR flag_tgl_lahir_pengganti THEN 'tidak diketahui'
                  WHEN usia_akhir_2024 >= 70 THEN '70+'
                  ELSE lpad((usia_akhir_2024 // 10 * 10)::VARCHAR, 2, '0') || '-' || lpad((usia_akhir_2024 // 10 * 10 + 9)::VARCHAR, 2, '0') END AS kelompok_usia,
             count(*) AS peserta, count(*) FILTER (WHERE status_kepesertaan = 'AKTIF') AS peserta_aktif,
             count(*) FILTER (WHERE status_kepesertaan = 'MENINGGAL') AS peserta_meninggal
      FROM input LEFT JOIN wilayah w ON w.kabkota_kode = input.kabkota_tinggal_kode GROUP BY ALL) s
LEFT JOIN provinsi p ON p.provinsi_kode = s.provinsi_kode""",
    # --- for the Nexus: one row per object (kab/kota, facility profile, risky claim, its participant)
    "kabkota": f"""
SELECT w.kabkota_kode, w.kabkota_nama AS kabkota, w.provinsi_kode, w.provinsi_nama AS provinsi,
       coalesce(k.klaim, 0) AS klaim_fkrtl, k.klaim_inap, k.peserta AS peserta_fkrtl, k.biaya_tagih_rp, k.biaya_verifikasi_rp,
       ROUND(100.0 * k.readmisi_30 / NULLIF(k.klaim_inap, 0), 2) AS pct_readmisi_30, k.calon_klaim_ganda, k.selisih_verifikasi, k.los_ekstrem,
       coalesce(k.klaim_berisiko, 0) AS klaim_berisiko, coalesce(f.profil_faskes, 0) AS profil_faskes
FROM input w
LEFT JOIN (SELECT kabkota_fkrtl_kode AS kabkota_kode, {MEASURES},
                  count(*) FILTER (WHERE flag_calon_klaim_ganda OR flag_selisih_verifikasi OR flag_los_ekstrem) AS klaim_berisiko
           FROM klaim GROUP BY ALL) k USING (kabkota_kode)
LEFT JOIN (SELECT kabkota_kode, count(*) AS profil_faskes FROM dim_profil_faskes GROUP BY ALL) f USING (kabkota_kode)""",
    "profil_faskes": f"""
SELECT p.faskes_profil_id, concat_ws(' · ', p.tingkat, p.jenis, p.tipe, p.kepemilikan, w.kabkota_nama) AS nama_profil,
       p.tingkat, p.kabkota_kode, w.kabkota_nama AS kabkota, w.provinsi_kode, w.provinsi_nama AS provinsi, p.kepemilikan, p.jenis, p.tipe, p.kunjungan,
       coalesce(k.klaim, 0) AS klaim_fkrtl, k.klaim_inap, k.biaya_tagih_rp, k.biaya_verifikasi_rp,
       ROUND(100.0 * k.readmisi_30 / NULLIF(k.klaim_inap, 0), 2) AS pct_readmisi_30, k.calon_klaim_ganda, k.selisih_verifikasi, k.los_ekstrem,
       coalesce(k.klaim_berisiko, 0) AS klaim_berisiko
FROM input p
LEFT JOIN wilayah w ON w.kabkota_kode = p.kabkota_kode
LEFT JOIN (SELECT faskes_profil_id, {MEASURES},
                  count(*) FILTER (WHERE flag_calon_klaim_ganda OR flag_selisih_verifikasi OR flag_los_ekstrem) AS klaim_berisiko
           FROM klaim GROUP BY ALL) k USING (faskes_profil_id)""",
    "klaim_berisiko": """
WITH peer AS (
  SELECT edisi, inacbg_kode, tipe_fkrtl, regional_tarif, count(*) AS peer_klaim,
         quantile_cont(biaya_tagih_rp, 0.5)::DOUBLE AS peer_biaya_p50_rp,
         quantile_cont(los_hari, 0.9) FILTER (WHERE rawat_inap) AS peer_los_inap_p90
  FROM input WHERE inacbg_kode IS NOT NULL GROUP BY ALL),
r AS (
  SELECT * FROM input WHERE flag_calon_klaim_ganda OR flag_selisih_verifikasi OR flag_los_ekstrem),
x AS (
  SELECT r.*, coalesce(r.flag_calon_klaim_ganda, false) AS ganda, coalesce(r.flag_selisih_verifikasi, false) AS selisih,
         coalesce(r.flag_los_ekstrem, false) AS los, p.peer_klaim, p.peer_biaya_p50_rp, p.peer_los_inap_p90,
         ROUND(r.biaya_tagih_rp / NULLIF(p.peer_biaya_p50_rp, 0), 2) AS rasio_biaya_peer
  FROM r LEFT JOIN peer p USING (edisi, inacbg_kode, tipe_fkrtl, regional_tarif))
SELECT edisi || ':' || kunjungan_fkrtl_id AS klaim_id, edisi, kunjungan_fkrtl_id,
       edisi || ':' || peserta_id::VARCHAR AS peserta_key, peserta_id::VARCHAR AS peserta_id,
       tgl_datang, tgl_pulang, strftime(bulan, '%Y-%m') AS bulan, kabkota_fkrtl_kode AS kabkota_kode, w.kabkota_nama AS kabkota, w.provinsi_kode,
       w.provinsi_nama AS provinsi,
       faskes_profil_id,
       CASE WHEN ganda THEN 'Calon klaim ganda' WHEN selisih THEN 'Selisih verifikasi' WHEN los THEN 'LOS ekstrem' END AS indikasi_utama,
       tipe_fkrtl, kelas_rawat, poli, inacbg_kode, inacbg_keparahan, regional_tarif, dx_primer_icd3, dx_primer_nama,
       rawat_inap, los_hari, tarif_inacbg_rp::DOUBLE AS tarif_inacbg_rp, biaya_tagih_rp::DOUBLE AS biaya_tagih_rp,
       biaya_verifikasi_rp::DOUBLE AS biaya_verifikasi_rp, selisih_rp::DOUBLE AS selisih_rp, readmisi_30,
       ganda AS flag_calon_klaim_ganda, selisih AS flag_selisih_verifikasi, los AS flag_los_ekstrem,
       CASE WHEN inacbg_kode IS NOT NULL THEN concat_ws('|', edisi, inacbg_kode, tipe_fkrtl, regional_tarif) END AS indikator_id,
       peer_klaim, peer_biaya_p50_rp, peer_los_inap_p90, rasio_biaya_peer,
       ganda::INT + selisih::INT + los::INT + readmisi_30::INT AS jumlah_indikasi,
       LEAST(100, 35 * ganda::INT + 25 * selisih::INT + 25 * los::INT + 10 * readmisi_30::INT
             + LEAST(15, GREATEST(0, coalesce(ROUND((rasio_biaya_peer - 1) * 5), 0)))::INT) AS skor_risiko,
       concat_ws(chr(59) || ' ',
         CASE WHEN ganda THEN 'Calon klaim ganda: peserta, tanggal, INA-CBG dan biaya sama dengan klaim lain' END,
         CASE WHEN selisih THEN concat('Selisih tagih vs verifikasi Rp ', replace(format('{:,}', selisih_rp::BIGINT), ',', '.')) END,
         CASE WHEN los THEN concat('LOS ', los_hari, ' hari, di atas p99 INA-CBG ini') END,
         CASE WHEN readmisi_30 THEN 'Rawat inap ulang <= 30 hari setelah pulang' END,
         CASE WHEN rasio_biaya_peer >= 2 THEN concat('Biaya ', ROUND(rasio_biaya_peer, 1), 'x median peer (INA-CBG, tipe RS, regional)') END
       ) AS alasan_risiko
FROM x LEFT JOIN wilayah w ON w.kabkota_kode = x.kabkota_fkrtl_kode""",
    # object grains under the Nexus index limit (BLUESANDAI_ONTOLOGY_MAX_ROWS): the full tables above stay for analysis
    "indikator_peer": """
SELECT * FROM input WHERE klaim >= 30 OR indikator_id IN (SELECT indikator_id FROM klaim_berisiko)""",
    "klaim_bulanan_provinsi": f"""
SELECT concat_ws(':', b.edisi, b.bulan, b.provinsi_kode) AS klaim_bulanan_id, b.edisi, b.bulan, b.provinsi_kode, p.provinsi,
       b.klaim, b.klaim_inap, b.peserta, b.biaya_tagih_rp, b.biaya_verifikasi_rp, ROUND(b.biaya_tagih_rp * 1.0 / b.klaim, 0) AS rata_biaya_tagih_rp,
       ROUND(b.los_hari_inap * 1.0 / NULLIF(b.klaim_inap, 0), 2) AS rata_los_inap_hari, b.readmisi_30,
       ROUND(100.0 * b.readmisi_30 / NULLIF(b.klaim_inap, 0), 2) AS pct_readmisi_30, b.calon_klaim_ganda, b.selisih_verifikasi, b.los_ekstrem
FROM (SELECT edisi, strftime(bulan, '%Y-%m') AS bulan, provinsi_kode, {MEASURES} FROM input GROUP BY ALL) b
LEFT JOIN provinsi p ON p.provinsi_kode = b.provinsi_kode""",
    "kunjungan_fktp_provinsi": f"""
SELECT concat_ws(':', f.edisi, f.bulan, f.provinsi_kode, f.jenis_fktp) AS kunjungan_fktp_bulanan_id, f.edisi, f.bulan, f.provinsi_kode, p.provinsi,
       f.jenis_fktp, f.kunjungan, f.peserta, f.kunjungan_sakit, f.rujuk_lanjut, ROUND(100.0 * f.rujuk_lanjut / f.kunjungan, 2) AS pct_rujuk_lanjut
FROM (SELECT edisi, strftime(bulan, '%Y-%m') AS bulan, w.provinsi_kode, {_tt('jenis_fktp')},
             count(*) AS kunjungan, count(DISTINCT peserta_id) AS peserta,
             count(*) FILTER (WHERE status_pulang = 'RUJUK LANJUT') AS rujuk_lanjut,
             count(*) FILTER (WHERE jenis_kunjungan = 'KUNJUNGAN SAKIT') AS kunjungan_sakit
      FROM input LEFT JOIN wilayah w ON w.kabkota_kode = input.kabkota_fktp_kode GROUP BY ALL) f
LEFT JOIN provinsi p ON p.provinsi_kode = f.provinsi_kode""",
    "peserta_klaim_berisiko": """
WITH r AS (
  SELECT edisi, peserta_id, count(*) AS klaim_berisiko, sum(biaya_tagih_rp)::DOUBLE AS biaya_klaim_berisiko_rp, max(skor_risiko) AS skor_risiko_maks
  FROM klaim_berisiko GROUP BY ALL)
SELECT p.edisi || ':' || p.peserta_id::VARCHAR AS peserta_key, p.edisi, p.peserta_id::VARCHAR AS peserta_id, p.jenis_kelamin, p.usia_akhir_2024,
       p.hubungan_keluarga, p.segmen, p.kelas_rawat, p.status_kepesertaan, coalesce(w.provinsi_nama, p.provinsi_tinggal_38) AS provinsi_tinggal,
       p.kabkota_tinggal_kode, p.kabkota_tinggal, p.jenis_fktp_terdaftar, p.kabkota_fktp_terdaftar_kode, p.flag_tgl_lahir_pengganti,
       r.klaim_berisiko, r.biaya_klaim_berisiko_rp, r.skor_risiko_maks
FROM input p JOIN r ON r.edisi = p.edisi AND r.peserta_id = p.peserta_id::VARCHAR
LEFT JOIN wilayah w ON w.kabkota_kode = p.kabkota_tinggal_kode""",
}
# (node id, name, group, input node, output?)
TRANSFORMS = [
    ("t_wilayah", "wilayah", "dimensi", "s_wilayah", True),
    ("t_provinsi", "provinsi", "dimensi", "t_wilayah", True),
    ("t_klaim", "klaim", "klaim", "s_fkrtl", False),
    ("t_kabkota", "klaim_kabkota", "klaim", "t_klaim", True),
    ("t_bulanan", "klaim_bulanan", "klaim", "t_klaim", True),
    ("t_inacbg", "indikator_inacbg", "klaim", "t_klaim", True),
    ("t_fktp", "kunjungan_fktp_bulanan", "fktp", "s_fktp", True),
    ("t_penyakit", "penyakit_teratas", "penyakit", "s_fktp", True),
    ("t_rujukan", "alur_rujukan", "rujukan", "s_rujukan", True),
    ("t_peserta", "profil_peserta", "peserta", "s_peserta", True),
    ("t_kabkota_obj", "kabkota", "dimensi", "t_wilayah", True),
    ("t_profil", "profil_faskes", "dimensi", "s_profil", True),
    ("t_berisiko", "klaim_berisiko", "klaim", "t_klaim", True),
    ("t_peserta_berisiko", "peserta_klaim_berisiko", "peserta", "s_peserta", True),
    ("t_peer", "indikator_peer", "klaim", "t_inacbg", True),
    ("t_bulanan_prov", "klaim_bulanan_provinsi", "klaim", "t_klaim", True),
    ("t_fktp_prov", "kunjungan_fktp_provinsi", "fktp", "s_fktp", True),
]
KEYS = {
    "klaim_kabkota": ["edisi", "kabkota_kode", "tipe_fkrtl"], "klaim_bulanan": ["edisi", "bulan", "provinsi_kode", "inacbg_cmg", "inacbg_keparahan"],
    "indikator_inacbg": ["edisi", "inacbg_kode", "tipe_fkrtl", "regional_tarif"], "kunjungan_fktp_bulanan": ["edisi", "bulan", "provinsi_kode", "jenis_fktp", "poli"],
    "penyakit_teratas": ["edisi", "provinsi_kode", "tingkat", "peringkat"], "alur_rujukan": ["edisi", "kabkota_asal_kode", "kabkota_tujuan_kode", "tipe_faskes_tujuan"],
    "profil_peserta": ["edisi", "provinsi_kode", "segmen", "jenis_kelamin", "kelompok_usia"],
    "wilayah": ["kabkota_kode"], "provinsi": ["provinsi_kode"], "kabkota": ["kabkota_kode"], "profil_faskes": ["faskes_profil_id"], "klaim_berisiko": ["klaim_id"],
    "peserta_klaim_berisiko": ["peserta_key"], "indikator_peer": ["indikator_id"], "klaim_bulanan_provinsi": ["klaim_bulanan_id"],
    "kunjungan_fktp_provinsi": ["kunjungan_fktp_bulanan_id"],
}
GROUPS = [("klaim", "Klaim FKRTL", "#c23030"), ("fktp", "Kunjungan FKTP", "#2d72d2"), ("penyakit", "Penyakit", "#d1980b"),
          ("rujukan", "Rujukan", "#238551"), ("peserta", "Peserta", "#7961db"), ("dimensi", "Dimensi", "#5f6b7c")]
# canvas columns: sources, the shared intermediates (provinsi, klaim), the outputs' transforms, the outputs
X = {"source": 40, "middle": 420, "transform": 820, "output": 1240}


def _type(arrow_type) -> str:
    import pyarrow as pa

    t = arrow_type.value_type if pa.types.is_dictionary(arrow_type) else arrow_type
    if pa.types.is_boolean(t):
        return "Boolean"
    if pa.types.is_integer(t):
        return "Long"
    if pa.types.is_floating(t) or pa.types.is_decimal(t):
        return "Double"
    if pa.types.is_date(t):
        return "Date"
    if pa.types.is_timestamp(t):
        return "Timestamp"
    return "String"


def _id_num(n: int) -> str:
    """12.345.678 (Indonesian thousands separator)."""
    return f"{n:,}".replace(",", ".")


def _rows(table, n: int = SAMPLE) -> list[dict]:
    """Sample rows for the pipeline file (JSON): dates as ISO text, decimals as numbers."""
    from decimal import Decimal

    def cell(v):
        if isinstance(v, Decimal):
            return int(v) if v == v.to_integral_value() else float(v)
        return v.isoformat() if hasattr(v, "isoformat") else v

    return [{k: cell(v) for k, v in r.items()} for r in table.slice(0, n).to_pylist()]


ROW_H = 110  # a node (64 px) and the gap below it


def _rows_of() -> dict[str, int]:
    """y of every node, as a tree: each node a row of its own in its column, a node level with its first reader (the
    rows of a source's readers stack below it, the next source starts below them). Stacking each input's readers from
    the input's y laid readers of neighbouring sources (and a reader in its input's column) over one another."""
    col = {nid: "source" for nid, *_ in SOURCES} | {nid: "transform" if out else "middle" for nid, _, _, _, out in TRANSFORMS}
    readers: dict[str, list[str]] = {}
    for nid, _, _, inp, _ in TRANSFORMS:
        readers.setdefault(inp, []).append(nid)
    y_of: dict[str, int] = {}
    row = 0

    def place(nid: str) -> int:
        nonlocal row
        kids = readers.get(nid, [])
        if not kids or any(col[k] == col[nid] for k in kids):
            y_of[nid] = row  # a leaf, or a node with a reader below it in its own column
            row += 1
            for k in kids:
                place(k)
        else:
            y_of[nid] = min(place(k) for k in kids)
        return y_of[nid]

    for nid, *_ in SOURCES:
        place(nid)
    return {nid: 60 + ROW_H * r for nid, r in y_of.items()}


def content(sources: dict[str, dict], gold_folder: dict, project: str) -> tuple[dict, dict[str, str]]:
    """The pipeline file. sources: {dataset name: {item_id, table (pyarrow, its first rows), rows (total), folder}};
    gold_folder: {id, name}."""
    now = datetime.now(timezone.utc).isoformat()
    uid = lambda: uuid.uuid4().hex[:8]  # noqa: E731
    datasets, nodes = {}, []
    y_of = _rows_of()
    for nid, name, group, doc in SOURCES:
        s = sources[name]
        ds = f"ds_{nid}"
        datasets[ds] = {"id": ds, "name": name, "origin": f"Files · {project} / {s['folder']} / {name}", "createdAt": now, "refreshedAt": now,
                        "columns": [{"name": f.name, "type": _type(f.type)} for f in s["table"].schema], "rows": _rows(s["table"]), "totalRows": s["rows"],
                        "ref": {"kind": "drive", "itemId": s["item_id"]}}
        nodes.append({"id": nid, "kind": "source", "name": name, "x": X["source"], "y": y_of[nid], "color": f"lg-{group}", "datasetId": ds,
                      "description": f"{doc} — {_id_num(s['rows'])} baris (preview: {_id_num(SAMPLE)} baris pertama)"})
    for nid, name, group, inp, is_out in TRANSFORMS:
        nodes.append({"id": nid, "kind": "transform", "name": name, "x": X["transform" if is_out else "middle"], "y": y_of[nid],
                      "color": f"lg-{group}", "input": inp, "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL[name].strip()}}]})
    location = {"id": gold_folder["id"], "name": gold_folder["name"]}
    outputs, out_ids = [], {}
    for nid, name, group, inp, is_out in TRANSFORMS:
        if not is_out:
            continue
        out_ids[name] = f"o_{nid}"
        outputs.append({"id": out_ids[name], "name": name, "node": nid, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                        "expectations": [{"id": uid(), "kind": "unique", "columns": KEYS[name]}, {"id": uid(), "kind": "rowCount", "min": 1}],
                        "x": X["output"], "y": y_of[nid]})
    text = [
        {"id": "note_1", "x": X["source"], "y": -200, "w": 360, "h": 150, "color": "lg-dimensi",
         "text": "SUMBER — fakta & dimensi silver (Code Repository 'Pipeline Data Sampel BPJS': raw → bronze → silver). Versi sintetis Data "
                 "Sampel BPJS Kesehatan Edisi 2025, 7 edisi: klaim FKRTL, kunjungan FKTP, rujukan, peserta."},
        {"id": "note_2", "x": X["middle"], "y": -200, "w": 380, "h": 150, "color": "lg-klaim",
         "text": "MESIN — DuckDB lokal: tiap output dikompilasi menjadi satu SQL DuckDB dan dijalankan di file Parquet di disk (jutaan "
                 "baris). Node 'klaim': klaim FKRTL + readmisi 30 hari. Preview memakai 1.000 baris pertama tiap input."},
        {"id": "note_3", "x": X["output"], "y": -200, "w": 380, "h": 150, "color": "lg-peserta",
         "text": "GOLD — 16 dataset di gold/: 7 agregat + 8 tabel objek Nexus (provinsi, kab/kota, profil faskes, klaim berisiko dengan statistik peer dan alasan, pesertanya) + dimensi wilayah: kab/kota → 38 provinsi (kolom *_38 data, pemekaran Papua 2022). Setiap keluaran dicek: kunci unik tanpa NULL, tidak kosong."},
    ]
    # the DuckDB local engine (api/pipeline_duckdb.py): builds run as SQL over the Parquet files on disk
    body = {"type": "batch", "compute": "duckdb", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes, "outputs": outputs,
            "legend": [{"id": f"lg-{g}", "name": n, "hex": h} for g, n, h in GROUPS], "location": location, "textNodes": text,
            "schedules": [], "meta": {"version": SPEC_VERSION, "description": "Gold Data Sampel BPJS Kesehatan Edisi 2025: dari silver (jutaan baris) dengan mesin DuckDB lokal."}}
    return body, out_ids


def ensure(dataset_items: dict[str, dict], gold_folder: dict, pipelines_folder: str, project: str, existing: Optional[str] = None, queue: bool = True) -> dict:
    """Create (or bring up to SPEC_VERSION) the pipeline file in Files and queue a build. The live API dispatches it:
    from a script that needs the fixed BLUESANDAI_SERVICE_TOKEN (.env.local) the API also uses."""
    import json

    import drive
    import pipeline_datasets
    import pipeline_runtime as rt

    body, out_ids = content(dataset_items, gold_folder, project)
    if existing:
        current = json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(existing)))
        if (current.get("meta") or {}).get("version") == SPEC_VERSION:
            return {"pipeline_id": existing, "created": False}
        body["createdAt"] = current.get("createdAt") or body["createdAt"]
        pipeline_datasets.save_pipeline(existing, pipeline_datasets.PipelineFileChange(content=body))
        pid = existing
    else:
        pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=pipelines_folder, content=body))["id"]
    b = rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="manual")) if queue else {}
    return {"pipeline_id": pid, "outputs": out_ids, "build": b.get("id")}
