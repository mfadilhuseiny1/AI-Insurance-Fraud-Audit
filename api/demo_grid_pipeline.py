"""Demo Grid: the Pipeline Builder pipelines of "Grid Management System Intelligence", each described once as a spec
(nodes in colour groups) from which come the Pipeline Builder file, a sqlite emulation for the first load and the graph
the pages draw — the same machinery as demo_jkn_pipeline.py, generalised to several pipelines.

1. "Pipeline aset & topologi jaringan grid (demo)" — GIS, NUSAGRID SCADA's equipment and point list, AP2T's technical
   customer master, the tariff table and the real West Java transmission grid (OpenStreetMap, context only) into the
   asset tables: substations, feeders, distribution transformers, customers (no identity), SCADA points, the network's
   connectivity and the transmission context.
2. "Pipeline neraca energi & susut grid (demo)" — SCADA feeder energy, distribution-transformer AMR, six monthly
   billing files, AMI daily consumption and meter events, TM three-phase AMR, SCADA outages (SOE) and P2TL results,
   with the asset tables of pipeline 1: monthly energy balances per transformer and feeder, technical losses estimated
   from physics (I²R with a loss factor, transformer iron and copper losses), non-technical losses as the residual,
   reliability (SAIDI/SAIFI), customer features, rule screening (the planted patterns' signatures) and the loss
   findings with their value and priority.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

import demo_jkn_pipeline as base

# ------------------------------------------------------------------------------------------------
# pipeline 1: assets & topology
# ------------------------------------------------------------------------------------------------

ASET_GROUPS = [
    ("wilayah", "Wilayah & GI", "#4c78c4"),
    ("gis", "GIS jaringan distribusi", "#2f855a"),
    ("ap2t", "AP2T pelanggan", "#805ad5"),
    ("osm", "Konteks transmisi Jabar (OSM)", "#718096"),
    ("inti", "Aset inti (Nexus)", "#c53030"),
    ("analitik", "Kualitas & ringkasan", "#d53f8c"),
]

SQL_GI = """-- Gardu induk: register GIS + ringkasan jaringan di bawahnya (penyulang, gardu distribusi, pelanggan).
SELECT g.kode_gi, g.nama, g.kode_ulp, w.nama AS nama_ulp,
       ROUND(g.latitude, 5) || ',' || ROUND(g.longitude, 5) AS lokasi,
       g.kapasitas_mva, g.trafo, g.rugi_besi_kw_per_trafo, g.rugi_tembaga_kw_per_trafo, g.sistem_scada, g.rtu,
       g.gitet_hulu_osm, g.jarak_gitet_km,
       (SELECT MIN(o.osm_id) FROM osm_jaringan_transmisi_jabar o WHERE o.jenis = 'gardu' AND o.nama = g.gitet_hulu_osm) AS gitet_hulu_osm_id,
       (SELECT COUNT(*) FROM gis_penyulang p WHERE p.kode_gi = g.kode_gi) AS jumlah_penyulang,
       (SELECT COUNT(*) FROM gis_gardu_distribusi d JOIN gis_penyulang p ON p.kode_penyulang = d.kode_penyulang WHERE p.kode_gi = g.kode_gi) AS jumlah_gardu_distribusi,
       (SELECT COUNT(*) FROM ap2t_pelanggan_teknis c JOIN gis_penyulang p ON p.kode_penyulang = c.kode_penyulang WHERE p.kode_gi = g.kode_gi) AS jumlah_pelanggan,
       g.latitude, g.longitude
FROM input g
LEFT JOIN wilayah_layanan w ON w.kode_wilayah = g.kode_ulp
ORDER BY g.kode_gi"""

SQL_PENYULANG = """-- Penyulang 20 kV: geometri dan parameter saluran dari GIS, tag SCADA kWh/daya, recloser dan LBS (register aset GIS)
-- dan pelanggan yang dilayani (TR lewat gardu distribusi, TM langsung). Model SCADA (CEII) tidak dibaca di sini.
WITH pel AS (
  SELECT kode_penyulang, COUNT(*) AS pelanggan, SUM(CASE WHEN tegangan = 'TM' THEN 1 ELSE 0 END) AS pelanggan_tm,
         SUM(daya_kontrak_kva) AS daya_tersambung_kva
  FROM ap2t_pelanggan_teknis GROUP BY kode_penyulang
),
dt AS (SELECT kode_penyulang, COUNT(*) AS gardu, SUM(kva) AS kva_gardu FROM gis_gardu_distribusi GROUP BY kode_penyulang)
SELECT f.kode_penyulang, f.nama, f.kode_gi, g.nama AS nama_gi, f.kode_ulp, f.jenis, f.karakter_beban,
       ROUND(f.panjang_km, 2) AS panjang_km, f.r_ohm_km, f.x_ohm_km, f.kha_a, f.tag_scada_kwh, f.tag_scada_daya,
       COALESCE(dt.gardu, 0) AS jumlah_gardu_distribusi, COALESCE(dt.kva_gardu, 0) AS kva_gardu_distribusi,
       COALESCE(pel.pelanggan, 0) AS jumlah_pelanggan, COALESCE(pel.pelanggan_tm, 0) AS jumlah_pelanggan_tm,
       COALESCE(pel.daya_tersambung_kva, 0) AS daya_tersambung_kva,
       COALESCE(f.jumlah_recloser, 0) AS recloser_scada, COALESCE(f.jumlah_lbs, 0) AS lbs_scada,
       f.geometri
FROM input f
JOIN gis_gardu_induk g ON g.kode_gi = f.kode_gi
LEFT JOIN pel ON pel.kode_penyulang = f.kode_penyulang
LEFT JOIN dt ON dt.kode_penyulang = f.kode_penyulang
ORDER BY f.kode_penyulang"""

SQL_GARDU = """-- Gardu distribusi (trafo 20 kV/400 V): register GIS, umur, rugi besi/tembaga, JTR, dan pelanggan TR di bawahnya.
WITH pel AS (
  SELECT kode_dt, COUNT(*) AS pelanggan, SUM(daya_va) / 1000.0 AS daya_tersambung_kva,
         SUM(CASE WHEN ami = 'Ya' THEN 1 ELSE 0 END) AS pelanggan_ami,
         SUM(CASE WHEN jenis_meter = 'prabayar' THEN 1 ELSE 0 END) AS pelanggan_prabayar
  FROM ap2t_pelanggan_teknis WHERE kode_dt <> '' GROUP BY kode_dt
)
SELECT d.kode_dt, d.nama, d.kode_penyulang, p.kode_gi, d.kode_ulp, d.kva, d.tahun_pasang, 2026 - d.tahun_pasang AS umur_tahun,
       d.rugi_besi_w, d.rugi_tembaga_w, d.panjang_jtr_km, d.r_jtr_ohm_km,
       COALESCE(pel.pelanggan, 0) AS jumlah_pelanggan, ROUND(COALESCE(pel.daya_tersambung_kva, 0), 1) AS daya_tersambung_kva,
       COALESCE(pel.pelanggan_ami, 0) AS pelanggan_ami, COALESCE(pel.pelanggan_prabayar, 0) AS pelanggan_prabayar,
       ROUND(d.latitude, 6) || ',' || ROUND(d.longitude, 6) AS lokasi, d.latitude, d.longitude
FROM input d
JOIN gis_penyulang p ON p.kode_penyulang = d.kode_penyulang
LEFT JOIN pel ON pel.kode_dt = d.kode_dt
ORDER BY d.kode_dt"""

SQL_PELANGGAN = """-- Pelanggan (tanpa identitas): data teknis AP2T, harga tarif, lokasi dibulatkan (±10 m) dan jalur pasokannya.
SELECT c.id_pelanggan, c.tarif, c.daya_va, c.segmen, c.tegangan, c.fase, c.kode_dt, c.kode_penyulang, p.kode_gi, c.kode_ulp,
       c.jenis_meter, c.ami, c.petugas_baca, c.faktor_kali, c.ct_terpasang, c.daya_kontrak_kva, c.tag_scada, c.tgl_pasang,
       t.rp_per_kwh AS tarif_rp_kwh, t.rp_per_kwh_wbp AS tarif_rp_kwh_wbp,
       c.tarif || ' / ' || c.daya_va || ' VA · ' || c.segmen AS golongan,
       ROUND(c.latitude, 4) || ',' || ROUND(c.longitude, 4) AS lokasi, c.latitude, c.longitude
FROM input c
JOIN gis_penyulang p ON p.kode_penyulang = c.kode_penyulang
LEFT JOIN tarif_tenaga_listrik t ON t.golongan = c.tarif
ORDER BY c.id_pelanggan"""

SQL_TITIK = """-- Titik ukur SCADA NUSAGRID (pola tag SITE.GARDU.TEGANGAN.BAY.PERALATAN.SINYAL) dengan peralatan dan bay-nya.
SELECT t.tag, t.jenis_titik, t.satuan, t.deskripsi, t.area, t.historian,
       SUBSTR(t.tag, INSTR(t.tag, '.') + 1) AS tag_tanpa_site,
       e.tipe AS tipe_peralatan, e.nama AS nama_peralatan, e.bay, e.nama_bay,
       CASE WHEN e.bay IN ('F01', 'F02', 'F03', 'F04', 'F05', 'F06') THEN 'KWS-' || e.bay
            WHEN SUBSTR(e.bay, 1, 1) = 'F' AND INSTR(e.bay, 'TEN') > 0 THEN 'KWS-' || SUBSTR(e.bay, 1, 3) ELSE '' END AS kode_penyulang
FROM input t
LEFT JOIN scada_peralatan_nusagrid e ON e.id_peralatan = t.id_peralatan
ORDER BY t.tag"""

SQL_KONEKTIVITAS = """-- Konektivitas: setiap pelanggan ke gardu distribusi, penyulang, GI dan GITET hulu, dan pemeriksaan topologi
-- (pelanggan TR tanpa gardu, pelanggan di gardu yang penyulangnya tidak cocok).
SELECT c.id_pelanggan, c.tegangan, c.kode_dt, c.kode_penyulang, p.kode_gi, g.gitet_hulu_osm,
       CASE WHEN c.tegangan = 'TR' THEN c.kode_dt || ' → ' ELSE '' END || c.kode_penyulang || ' → ' || p.kode_gi || ' → ' || g.gitet_hulu_osm AS jalur_pasokan,
       CASE WHEN c.tegangan = 'TR' AND (c.kode_dt = '' OR d.kode_dt IS NULL) THEN 'TR tanpa gardu distribusi'
            WHEN c.tegangan = 'TR' AND d.kode_penyulang <> c.kode_penyulang THEN 'Penyulang pelanggan ≠ penyulang gardu'
            ELSE 'OK' END AS cek_topologi
FROM input c
JOIN gis_penyulang p ON p.kode_penyulang = c.kode_penyulang
JOIN gis_gardu_induk g ON g.kode_gi = p.kode_gi
LEFT JOIN gis_gardu_distribusi d ON d.kode_dt = c.kode_dt
ORDER BY c.id_pelanggan"""

SQL_SALURAN_TX = """-- Saluran transmisi Jawa Barat (OpenStreetMap, konteks): kelas tegangan (tag atau inferensi) dan geometri.
SELECT osm_id, COALESCE(NULLIF(nama, ''), 'Saluran ' || kelas_kv || ' kV ' || osm_id) AS nama, kelas_kv, kelas_kv_sumber,
       CASE kelas_kv WHEN 500 THEN 'SUTET 500 kV' WHEN 150 THEN 'SUTT 150 kV' WHEN 70 THEN 'SUTT 70 kV' ELSE 'Tegangan lain / tak diketahui' END AS kelas,
       operator, ROUND(panjang_dalam_jabar_km, 2) AS panjang_dalam_jabar_km, gardu_ujung_a, gardu_ujung_b, geometri
FROM input WHERE jenis = 'saluran'
ORDER BY kelas_kv DESC, osm_id"""

SQL_GARDU_TX = """-- Gardu transmisi Jawa Barat (OpenStreetMap, konteks): GITET dan GI dengan kelas tegangan dan jumlah ruas terhubung.
SELECT osm_id, COALESCE(NULLIF(nama, ''), 'Gardu ' || osm_id) AS nama, voltage, kelas_kv, kelas_kv_sumber,
       CASE WHEN kelas_kv = 500 THEN 'GITET 500 kV' WHEN kelas_kv = 150 THEN 'GI 150 kV' WHEN kelas_kv = 70 THEN 'GI 70 kV' ELSE 'Lainnya' END AS kelas,
       kabkota, ruas_terhubung, ROUND(lat, 5) || ',' || ROUND(lon, 5) AS lokasi, lat, lon
FROM input WHERE jenis = 'gardu'
ORDER BY kelas_kv DESC, nama"""

SQL_KAWASAN = """-- Kawasan industri Jawa Barat (OpenStreetMap, konteks): tidak ada data pelanggan yang dikaitkan ke kawasan nyata.
SELECT osm_id, nama, kabkota, ROUND(lat, 5) || ',' || ROUND(lon, 5) AS lokasi, lat, lon
FROM input WHERE jenis = 'kawasan_industri'
ORDER BY nama"""

SQL_RINGKAS_ASET = """-- Ringkasan aset per ULP: GI, penyulang, gardu distribusi, kVA terpasang, pelanggan per segmen dan cakupan AMI.
SELECT c.kode_ulp, w.nama AS nama_ulp, COUNT(*) AS pelanggan,
       SUM(CASE WHEN c.segmen = 'Rumah tangga' THEN 1 ELSE 0 END) AS rumah_tangga,
       SUM(CASE WHEN c.segmen = 'Bisnis' THEN 1 ELSE 0 END) AS bisnis,
       SUM(CASE WHEN c.segmen = 'Industri' THEN 1 ELSE 0 END) AS industri,
       SUM(CASE WHEN c.segmen IN ('Pemerintah', 'Sosial') THEN 1 ELSE 0 END) AS lembaga,
       SUM(CASE WHEN c.segmen = 'PJU' THEN 1 ELSE 0 END) AS pju,
       SUM(CASE WHEN c.tegangan = 'TM' THEN 1 ELSE 0 END) AS pelanggan_tm,
       ROUND(100.0 * SUM(CASE WHEN c.ami = 'Ya' THEN 1 ELSE 0 END) / COUNT(*), 1) AS cakupan_ami_pct,
       ROUND(SUM(c.daya_kontrak_kva) / 1000.0, 1) AS daya_tersambung_mva
FROM input c
LEFT JOIN wilayah_layanan w ON w.kode_wilayah = c.kode_ulp
GROUP BY c.kode_ulp, w.nama
ORDER BY c.kode_ulp"""


def aset_spec() -> list[dict]:
    S = lambda i, n, g, d: {"id": i, "kind": "source", "name": n, "group": g, "doc": d}  # noqa: E731
    return [
        S("s_wil", "wilayah_layanan", "wilayah", "UP3 dan ULP (master organisasi)"),
        S("s_gi", "gis_gardu_induk", "wilayah", "Register gardu induk (GIS) dengan GITET hulu terdekat (OSM)"),
        S("s_pny", "gis_penyulang", "gis", "Penyulang 20 kV: geometri, panjang, konduktor, tag SCADA"),
        S("s_dt", "gis_gardu_distribusi", "gis", "Gardu distribusi: kVA, tahun pasang, rugi trafo, JTR"),
        S("s_pel", "ap2t_pelanggan_teknis", "ap2t", "Master teknis pelanggan AP2T (tanpa identitas)"),
        S("s_tarif", "tarif_tenaga_listrik", "ap2t", "Tarif per golongan (contoh) dan harga WBP"),
        S("s_osm", "osm_jaringan_transmisi_jabar", "osm", "Saluran, gardu, pembangkit, kawasan industri Jabar (OpenStreetMap, ODbL)"),
        {"id": "t_gi", "kind": "sql", "name": "gardu_induk", "group": "inti", "input": "s_gi", "sql": SQL_GI},
        {"id": "t_pny", "kind": "sql", "name": "penyulang", "group": "inti", "input": "s_pny", "sql": SQL_PENYULANG},
        {"id": "t_dt", "kind": "sql", "name": "gardu_distribusi", "group": "inti", "input": "s_dt", "sql": SQL_GARDU},
        {"id": "t_pel", "kind": "sql", "name": "pelanggan", "group": "inti", "input": "s_pel", "sql": SQL_PELANGGAN},
        {"id": "t_kon", "kind": "sql", "name": "konektivitas_jaringan", "group": "analitik", "input": "s_pel", "sql": SQL_KONEKTIVITAS},
        {"id": "t_ring", "kind": "sql", "name": "ringkasan_aset_ulp", "group": "analitik", "input": "s_pel", "sql": SQL_RINGKAS_ASET},
        {"id": "t_stx", "kind": "sql", "name": "saluran_transmisi_jabar", "group": "osm", "input": "s_osm", "sql": SQL_SALURAN_TX},
        {"id": "t_gtx", "kind": "sql", "name": "gardu_transmisi_jabar", "group": "osm", "input": "s_osm", "sql": SQL_GARDU_TX},
        {"id": "t_kws", "kind": "sql", "name": "kawasan_industri_jabar", "group": "osm", "input": "s_osm", "sql": SQL_KAWASAN},
    ]


ASET_OUTPUTS = [("gardu_induk", "t_gi"), ("penyulang", "t_pny"), ("gardu_distribusi", "t_dt"), ("pelanggan", "t_pel"),
                ("konektivitas_jaringan", "t_kon"), ("ringkasan_aset_ulp", "t_ring"),
                ("saluran_transmisi_jabar", "t_stx"), ("gardu_transmisi_jabar", "t_gtx"), ("kawasan_industri_jabar", "t_kws")]

# ------------------------------------------------------------------------------------------------
# pipeline 1b: the SCADA network model (CEII) on its own — markings follow a pipeline's inputs to every output, so the
# asset and loss pipelines never read it and their outputs stay readable without the CEII marking
# ------------------------------------------------------------------------------------------------

SCADA_GROUPS = [("scada", "NUSAGRID SCADA (CEII)", "#c05621"), ("inti", "Titik ukur (Nexus)", "#c53030")]


def scada_spec() -> list[dict]:
    S = lambda i, n, g, d: {"id": i, "kind": "source", "name": n, "group": g, "doc": d}  # noqa: E731
    return [
        S("s_alat", "scada_peralatan_nusagrid", "scada", "Peralatan model CIM-lite NUSAGRID (Demo Estate Grid) — infrastruktur kritis"),
        S("s_titik", "scada_titik_ukur_nusagrid", "scada", "Daftar titik ukur NUSAGRID (tag, jenis, satuan) — infrastruktur kritis"),
        {"id": "t_titik", "kind": "sql", "name": "titik_ukur_scada", "group": "inti", "input": "s_titik", "sql": SQL_TITIK},
    ]


SCADA_OUTPUTS = [("titik_ukur_scada", "t_titik")]

# ------------------------------------------------------------------------------------------------
# pipeline 2: energy balance & losses
# ------------------------------------------------------------------------------------------------

SUSUT_GROUPS = [
    ("scada", "SCADA (NUSAGRID & RTU)", "#c05621"),
    ("amr", "AMR gardu & TM", "#2c9c9c"),
    ("tagihan", "AP2T tagihan bulanan", "#805ad5"),
    ("ami", "AMI head-end", "#0ea5e9"),
    ("p2tl", "P2TL", "#b7791f"),
    ("aset", "Aset (pipeline 1)", "#4c78c4"),
    ("neraca", "Neraca & susut teknis", "#2f855a"),
    ("fitur", "Fitur pelanggan", "#6b46c1"),
    ("inti", "Temuan & Nexus", "#c53030"),
    ("analitik", "Analitik", "#d53f8c"),
]

SQL_TAGIHAN = """-- Tagihan bulanan (enam file AP2T digabung): angka bertipe, satu baris per pelanggan per bulan.
SELECT id_pelanggan, bulan, CAST(kwh AS DOUBLE) AS kwh, CAST(kwh_wbp AS DOUBLE) AS kwh_wbp, CAST(kw_maks AS DOUBLE) AS kw_maks,
       cara_baca, CAST(rp_tagihan AS DOUBLE) AS rp_tagihan, CAST(stand_akhir AS DOUBLE) AS stand_akhir
FROM input
ORDER BY id_pelanggan, bulan"""

SQL_TAGIHAN_RINGKAS = """-- Per pelanggan: rata-rata kWh triwulan II (Apr–Jun, sebelum AMI) vs III (Jul–Sep), bulan estimasi, stand yang macet.
WITH s AS (
  SELECT id_pelanggan, bulan, kwh, kw_maks, cara_baca, stand_akhir,
         LAG(stand_akhir) OVER (PARTITION BY id_pelanggan ORDER BY bulan) AS stand_lalu
  FROM input
)
SELECT id_pelanggan,
       ROUND(AVG(CASE WHEN bulan <= '2026-06' THEN kwh END), 1) AS kwh_bulan_q2,
       ROUND(AVG(CASE WHEN bulan >= '2026-07' THEN kwh END), 1) AS kwh_bulan_q3,
       ROUND(SUM(CASE WHEN bulan >= '2026-07' THEN kwh ELSE 0 END), 1) AS kwh_q3,
       ROUND(MAX(kw_maks), 2) AS kw_maks_6bln,
       SUM(CASE WHEN cara_baca = 'estimasi' THEN 1 ELSE 0 END) AS bulan_estimasi,
       SUM(CASE WHEN stand_lalu IS NOT NULL AND stand_akhir = stand_lalu THEN 1 ELSE 0 END) AS bulan_stand_sama,
       MAX(CASE WHEN bulan = '2026-09' THEN cara_baca END) AS cara_baca_terakhir
FROM s
GROUP BY id_pelanggan"""

SQL_AMI_PROFIL = """-- Profil AMI harian (Jul–Sep): hari tanpa konsumsi, porsi malam, beban puncak, faktor beban, variasi harian.
SELECT id_pelanggan, COUNT(*) AS hari_ami, ROUND(SUM(kwh), 1) AS kwh_ami_q3,
       SUM(CASE WHEN kwh < 0.05 THEN 1 ELSE 0 END) AS hari_nol,
       ROUND(SUM(kwh_malam) / NULLIF(SUM(kwh), 0), 3) AS porsi_malam,
       ROUND(MAX(kw_puncak), 2) AS kw_puncak_ami,
       ROUND(AVG(kwh) / 24.0 / NULLIF(MAX(kw_puncak), 0), 3) AS faktor_beban,
       ROUND(AVG(CASE WHEN tanggal < '2026-08-01' THEN kwh END), 2) AS kwh_hari_juli,
       ROUND(AVG(CASE WHEN tanggal >= '2026-09-01' THEN kwh END), 2) AS kwh_hari_september,
       ROUND(MIN(tegangan_min_v), 1) AS tegangan_min_v
FROM input
GROUP BY id_pelanggan"""

SQL_EVENT = """-- Event meter AMI per pelanggan (Jul–Sep): magnet, tutup terminal dibuka, ketidakseimbangan arus, hilang fasa, padam.
SELECT id_pelanggan,
       SUM(CASE WHEN kode_event = 'MAGNETIC' THEN 1 ELSE 0 END) AS event_magnet,
       SUM(CASE WHEN kode_event = 'COVER_OPEN' THEN 1 ELSE 0 END) AS event_tutup_terbuka,
       SUM(CASE WHEN kode_event = 'CURRENT_UNBALANCE' THEN 1 ELSE 0 END) AS event_arus_tak_seimbang,
       SUM(CASE WHEN kode_event = 'PHASE_LOSS' THEN 1 ELSE 0 END) AS event_hilang_fasa,
       SUM(CASE WHEN kode_event = 'POWER_OFF' THEN 1 ELSE 0 END) AS event_padam,
       COUNT(*) AS event_total
FROM input
GROUP BY id_pelanggan"""

SQL_TM = """-- AMR TM tiga fasa (Jul–Sep): keseimbangan arus dan tegangan per fasa, porsi WBP, demand 15 menit vs daya kontrak,
-- dan kWh terukur AMR dibandingkan kWh yang ditagihkan (faktor kali CT di sistem tagihan).
WITH d AS (
  SELECT a.*, p.daya_kontrak_kva, p.faktor_kali,
         MIN(i_l1_a, i_l2_a, i_l3_a) / NULLIF(MAX(i_l1_a, i_l2_a, i_l3_a), 0) AS rasio_arus_min,
         MIN(u_l1_kv, u_l2_kv, u_l3_kv) / NULLIF(MAX(u_l1_kv, u_l2_kv, u_l3_kv), 0) AS rasio_tegangan_min
  FROM input a JOIN pelanggan p ON p.id_pelanggan = a.id_pelanggan
)
SELECT d.id_pelanggan, ROUND(SUM(d.kwh), 1) AS kwh_amr_q3, ROUND(SUM(d.kwh_wbp) / NULLIF(SUM(d.kwh), 0), 3) AS porsi_wbp,
       ROUND(AVG(d.rasio_arus_min), 3) AS rasio_arus_fasa_min, ROUND(AVG(d.rasio_tegangan_min), 3) AS rasio_tegangan_fasa_min,
       ROUND(MAX(d.kw_dmd15_maks), 1) AS kw_dmd15_maks, MAX(d.daya_kontrak_kva) AS daya_kontrak_kva,
       SUM(CASE WHEN d.kw_dmd15_maks > 0.85 * d.daya_kontrak_kva THEN 1 ELSE 0 END) AS hari_melebihi_kontrak,
       ROUND(AVG(d.pf_rata), 3) AS pf_rata,
       ROUND(t.kwh_q3 / NULLIF(SUM(d.kwh), 0), 3) AS rasio_tagih_vs_amr
FROM d
LEFT JOIN tagihan_ringkas t ON t.id_pelanggan = d.id_pelanggan
GROUP BY d.id_pelanggan, t.kwh_q3"""

SQL_NERACA_DT = """-- Neraca energi gardu distribusi per bulan: energi keluar trafo (AMR) − energi pelanggan TR (tagihan) = susut JTR.
-- Susut teknis JTR = I²R × faktor rugi (Buller–Woodrow 0,3·LF + 0,7·LF²) × faktor ketidakseimbangan (1 + 1,6·(In/I)²)
-- dengan R = panjang × r / 3 (beban tersebar merata) + 1,5% rugi sambungan rumah & kWh meter; NTL = sisa.
WITH a AS (
  SELECT g.kode_dt, SUBSTR(g.tanggal, 1, 7) AS bulan, SUM(g.kwh_keluar) AS kwh_keluar, SUM(g.kwh_malam) AS kwh_malam,
         MAX(g.kva_puncak) AS kva_puncak, AVG((g.i_r + g.i_s + g.i_t) / 3.0) AS i_rata, AVG(g.i_netral) AS i_netral,
         MIN(g.tegangan_ujung_min_v) AS tegangan_ujung_min_v, MAX(g.suhu_minyak_maks_c) AS suhu_minyak_maks_c,
         SUM(CASE WHEN g.kva_puncak > d.kva THEN 1 ELSE 0 END) AS hari_overload, COUNT(*) AS hari,
         AVG(g.kwh_keluar / 24.0 / NULLIF(g.kva_puncak * 0.9, 0)) AS lf
  FROM input g JOIN gardu_distribusi d ON d.kode_dt = g.kode_dt
  GROUP BY g.kode_dt, SUBSTR(g.tanggal, 1, 7)
),
b AS (
  SELECT p.kode_dt, t.bulan, SUM(t.kwh) AS kwh_tagih, COUNT(*) AS pelanggan
  FROM tagihan_bersih t JOIN pelanggan p ON p.id_pelanggan = t.id_pelanggan
  WHERE p.kode_dt <> '' GROUP BY p.kode_dt, t.bulan
),
tl AS (
  SELECT a.*, d.kva, d.panjang_jtr_km, d.r_jtr_ohm_km, d.rugi_besi_w, d.rugi_tembaga_w, d.tahun_pasang, d.kode_penyulang, d.kode_ulp,
         (i_netral / NULLIF(i_rata, 0)) AS rasio_netral,
         -- daily mean current from energy (the AMR's mean current is the same quantity, kept as a cross-check)
         3 * (a.kwh_keluar / a.hari / 24.0 * 1000 / (1.732 * 400)) * (a.kwh_keluar / a.hari / 24.0 * 1000 / (1.732 * 400))
           * d.panjang_jtr_km * d.r_jtr_ohm_km / 3.0 * (1 + 1.6 * (i_netral / NULLIF(i_rata, 0)) * (i_netral / NULLIF(i_rata, 0)))
           * (0.3 * a.lf + 0.7 * a.lf * a.lf) / (a.lf * a.lf) * 24 * a.hari / 1000.0 AS tl_i2r_kwh
  FROM a JOIN gardu_distribusi d ON d.kode_dt = a.kode_dt
)
SELECT tl.kode_dt || ' · ' || tl.bulan AS id_neraca, tl.kode_dt, tl.kode_penyulang, tl.kode_ulp, tl.bulan,
       ROUND(tl.kwh_keluar, 0) AS kwh_keluar, ROUND(COALESCE(b.kwh_tagih, 0), 0) AS kwh_tagih,
       ROUND(tl.kwh_keluar - COALESCE(b.kwh_tagih, 0), 0) AS susut_kwh,
       ROUND(100.0 * (tl.kwh_keluar - COALESCE(b.kwh_tagih, 0)) / tl.kwh_keluar, 2) AS susut_pct,
       ROUND(tl.tl_i2r_kwh + 0.015 * COALESCE(b.kwh_tagih, 0), 0) AS susut_teknis_kwh,
       ROUND(100.0 * (tl.tl_i2r_kwh + 0.015 * COALESCE(b.kwh_tagih, 0)) / tl.kwh_keluar, 2) AS susut_teknis_pct,
       ROUND(tl.kwh_keluar - COALESCE(b.kwh_tagih, 0) - tl.tl_i2r_kwh - 0.015 * COALESCE(b.kwh_tagih, 0), 0) AS susut_non_teknis_kwh,
       ROUND(100.0 * (tl.kwh_keluar - COALESCE(b.kwh_tagih, 0) - tl.tl_i2r_kwh - 0.015 * COALESCE(b.kwh_tagih, 0)) / tl.kwh_keluar, 2) AS susut_non_teknis_pct,
       ROUND(tl.rugi_besi_w * 24 * tl.hari / 1000.0 + tl.rugi_tembaga_w * (tl.kva_puncak / tl.kva) * (tl.kva_puncak / tl.kva)
             * (0.3 * tl.lf + 0.7 * tl.lf * tl.lf) * 24 * tl.hari / 1000.0, 0) AS rugi_trafo_kwh,
       ROUND(100.0 * tl.kva_puncak / tl.kva, 1) AS beban_puncak_pct, tl.hari_overload,
       ROUND(tl.rasio_netral, 3) AS rasio_arus_netral, ROUND(tl.tegangan_ujung_min_v, 1) AS tegangan_ujung_min_v,
       ROUND(tl.suhu_minyak_maks_c, 1) AS suhu_minyak_maks_c, ROUND(tl.kwh_malam / tl.kwh_keluar, 3) AS porsi_malam,
       ROUND(tl.lf, 3) AS faktor_beban, COALESCE(b.pelanggan, 0) AS pelanggan
FROM tl
LEFT JOIN b ON b.kode_dt = tl.kode_dt AND b.bulan = tl.bulan
ORDER BY tl.kode_dt, tl.bulan"""

SQL_NERACA_PNY = """-- Neraca energi penyulang per bulan: kWh kirim SCADA (NUSAGRID E_IMP / RTU GI Kota) = Σ gardu (keluar + rugi trafo)
-- + Σ pelanggan TM + rugi SUTM/SKTM (3·I²·R·0,45 untuk beban tersebar). Susut penyulang = kirim − Σ tagihan semua pelanggannya.
WITH s AS (
  SELECT kode_penyulang, SUBSTR(tanggal, 1, 7) AS bulan, SUM(kwh_kirim) AS kwh_kirim, MAX(kw_puncak) AS kw_puncak,
         AVG(pf_rata) AS pf_rata, AVG(thd_i_pct) AS thd_i_pct, SUM(menit_padam) AS menit_padam, COUNT(*) AS hari,
         SUM(CASE WHEN kualitas <> 'valid' THEN 1 ELSE 0 END) AS hari_data_meragukan
  FROM input GROUP BY kode_penyulang, SUBSTR(tanggal, 1, 7)
),
dt AS (
  SELECT kode_penyulang, bulan, SUM(kwh_keluar) AS kwh_gardu, SUM(rugi_trafo_kwh) AS rugi_trafo_kwh, SUM(susut_teknis_kwh) AS tl_jtr_kwh
  FROM neraca_gardu_bulanan GROUP BY kode_penyulang, bulan
),
bill AS (
  SELECT p.kode_penyulang, t.bulan, SUM(t.kwh) AS kwh_tagih, SUM(CASE WHEN p.tegangan = 'TM' THEN t.kwh ELSE 0 END) AS kwh_tagih_tm,
         SUM(t.rp_tagihan) AS rp_tagihan
  FROM tagihan_bersih t JOIN pelanggan p ON p.id_pelanggan = t.id_pelanggan GROUP BY p.kode_penyulang, t.bulan
),
mv AS (
  SELECT s.*, f.panjang_km, f.r_ohm_km, f.kode_gi, f.kode_ulp, f.jenis,
         3 * (s.kwh_kirim / s.hari / 24.0 * 1000 / (1.732 * 20000 * s.pf_rata)) * (s.kwh_kirim / s.hari / 24.0 * 1000 / (1.732 * 20000 * s.pf_rata))
           * f.panjang_km * f.r_ohm_km * 0.45 * 24 * s.hari / 1000.0 * 1.35 AS rugi_saluran_kwh
  FROM s JOIN penyulang f ON f.kode_penyulang = s.kode_penyulang
)
SELECT mv.kode_penyulang || ' · ' || mv.bulan AS id_neraca, mv.kode_penyulang, mv.kode_gi, mv.kode_ulp, mv.bulan,
       ROUND(mv.kwh_kirim, 0) AS kwh_kirim, ROUND(COALESCE(bill.kwh_tagih, 0), 0) AS kwh_tagih,
       ROUND(COALESCE(bill.kwh_tagih_tm, 0), 0) AS kwh_tagih_tm, ROUND(COALESCE(dt.kwh_gardu, 0), 0) AS kwh_gardu_distribusi,
       ROUND(mv.kwh_kirim - COALESCE(bill.kwh_tagih, 0), 0) AS susut_kwh,
       ROUND(100.0 * (mv.kwh_kirim - COALESCE(bill.kwh_tagih, 0)) / mv.kwh_kirim, 2) AS susut_pct,
       ROUND(mv.rugi_saluran_kwh + COALESCE(dt.rugi_trafo_kwh, 0) + COALESCE(dt.tl_jtr_kwh, 0), 0) AS susut_teknis_kwh,
       ROUND(100.0 * (mv.rugi_saluran_kwh + COALESCE(dt.rugi_trafo_kwh, 0) + COALESCE(dt.tl_jtr_kwh, 0)) / mv.kwh_kirim, 2) AS susut_teknis_pct,
       ROUND(mv.kwh_kirim - COALESCE(bill.kwh_tagih, 0) - mv.rugi_saluran_kwh - COALESCE(dt.rugi_trafo_kwh, 0) - COALESCE(dt.tl_jtr_kwh, 0), 0) AS susut_non_teknis_kwh,
       ROUND(100.0 * (mv.kwh_kirim - COALESCE(bill.kwh_tagih, 0) - mv.rugi_saluran_kwh - COALESCE(dt.rugi_trafo_kwh, 0) - COALESCE(dt.tl_jtr_kwh, 0)) / mv.kwh_kirim, 2) AS susut_non_teknis_pct,
       ROUND(mv.rugi_saluran_kwh, 0) AS rugi_saluran_kwh, ROUND(COALESCE(dt.rugi_trafo_kwh, 0), 0) AS rugi_trafo_kwh,
       ROUND(mv.kw_puncak, 0) AS kw_puncak, ROUND(mv.pf_rata, 3) AS pf_rata, ROUND(mv.thd_i_pct, 2) AS thd_i_pct,
       mv.menit_padam, mv.hari_data_meragukan, ROUND(COALESCE(bill.rp_tagihan, 0), 0) AS rp_tagihan
FROM mv
LEFT JOIN dt ON dt.kode_penyulang = mv.kode_penyulang AND dt.bulan = mv.bulan
LEFT JOIN bill ON bill.kode_penyulang = mv.kode_penyulang AND bill.bulan = mv.bulan
ORDER BY mv.kode_penyulang, mv.bulan"""

SQL_KEANDALAN = """-- Keandalan penyulang Apr–Sep (IEEE 1366, dari SOE SCADA): SAIDI = Σ(durasi × pelanggan padam) / pelanggan,
-- SAIFI = Σ pelanggan padam / pelanggan (gangguan permanen; MAIFI untuk temporer), energi tidak tersalur.
SELECT f.kode_penyulang, f.nama, f.kode_gi, f.jumlah_pelanggan,
       COUNT(g.id_gangguan) AS gangguan,
       SUM(CASE WHEN g.jenis = 'Permanen' THEN 1 ELSE 0 END) AS gangguan_permanen,
       ROUND(SUM(CASE WHEN g.jenis = 'Permanen' THEN g.durasi_menit * g.pelanggan_padam ELSE 0 END) / NULLIF(f.jumlah_pelanggan, 0), 1) AS saidi_menit,
       ROUND(1.0 * SUM(CASE WHEN g.jenis = 'Permanen' THEN g.pelanggan_padam ELSE 0 END) / NULLIF(f.jumlah_pelanggan, 0), 2) AS saifi_kali,
       ROUND(1.0 * SUM(CASE WHEN g.jenis = 'Temporer' THEN g.pelanggan_padam ELSE 0 END) / NULLIF(f.jumlah_pelanggan, 0), 2) AS maifi_kali,
       ROUND(COALESCE(SUM(g.kwh_tidak_tersalur), 0), 0) AS kwh_tidak_tersalur
FROM penyulang f
LEFT JOIN input g ON g.kode_penyulang = f.kode_penyulang
GROUP BY f.kode_penyulang, f.nama, f.kode_gi, f.jumlah_pelanggan
ORDER BY f.kode_penyulang"""

SQL_FITUR = """-- Fitur per pelanggan: pemakaian Q2 vs Q3, pembanding sesama golongan di gardu yang sama, AMI, event meter, TM tiga fasa,
-- dan susut gardunya (masukan aturan skrining dan model ML).
WITH peer AS (
  SELECT p.kode_dt, p.tarif, AVG(t.kwh_bulan_q3) AS kwh_peer, COUNT(*) AS n_peer
  FROM pelanggan p JOIN tagihan_ringkas t ON t.id_pelanggan = p.id_pelanggan
  WHERE p.kode_dt <> '' GROUP BY p.kode_dt, p.tarif
),
dt AS (
  SELECT kode_dt, AVG(susut_non_teknis_pct) AS ntl_dt_pct, MAX(porsi_malam) - MIN(porsi_malam) AS naik_porsi_malam_dt
  FROM neraca_gardu_bulanan WHERE bulan >= '2026-07' GROUP BY kode_dt
),
rute AS (
  SELECT p.petugas_baca, AVG(CASE WHEN t.kwh_bulan_q3 < 0.6 * t.kwh_bulan_q2 THEN 1.0 ELSE 0.0 END) AS porsi_turun_rute
  FROM pelanggan p JOIN tagihan_ringkas t ON t.id_pelanggan = p.id_pelanggan
  WHERE p.petugas_baca <> '' AND p.ami = 'Tidak' GROUP BY p.petugas_baca
)
SELECT p.id_pelanggan, p.tarif, p.daya_va, p.segmen, p.tegangan, p.jenis_meter, p.ami, p.kode_dt, p.kode_penyulang, p.kode_ulp, p.petugas_baca,
       p.tarif_rp_kwh, p.daya_kontrak_kva,
       t.kwh_bulan_q2, t.kwh_bulan_q3,
       ROUND(100.0 * (t.kwh_bulan_q3 - t.kwh_bulan_q2) / NULLIF(t.kwh_bulan_q2, 0), 1) AS perubahan_pct,
       ROUND(t.kwh_bulan_q3 / NULLIF(peer.kwh_peer, 0), 3) AS rasio_vs_peer, COALESCE(peer.n_peer, 0) AS n_peer,
       ROUND(t.kwh_bulan_q3 / NULLIF(p.daya_va / 1000.0, 0), 1) AS kwh_per_kva_bulan,
       t.kw_maks_6bln, ROUND(t.kw_maks_6bln / NULLIF(p.daya_va / 1000.0, 0), 3) AS rasio_puncak_vs_daya,
       t.bulan_estimasi, t.bulan_stand_sama,
       a.hari_nol, a.porsi_malam, a.faktor_beban, a.kwh_hari_juli, a.kwh_hari_september,
       COALESCE(e.event_magnet, 0) + COALESCE(e.event_tutup_terbuka, 0) AS event_tamper,
       COALESCE(e.event_arus_tak_seimbang, 0) + COALESCE(e.event_hilang_fasa, 0) AS event_fasa,
       tm.porsi_wbp, tm.rasio_arus_fasa_min, tm.rasio_tegangan_fasa_min, tm.hari_melebihi_kontrak, tm.kw_dmd15_maks, tm.rasio_tagih_vs_amr,
       ROUND(dt.ntl_dt_pct, 2) AS ntl_gardu_pct, ROUND(dt.naik_porsi_malam_dt, 3) AS naik_porsi_malam_gardu,
       ROUND(COALESCE(rute.porsi_turun_rute, 0), 3) AS porsi_turun_rute_baca
FROM pelanggan p
JOIN input t ON t.id_pelanggan = p.id_pelanggan
LEFT JOIN peer ON peer.kode_dt = p.kode_dt AND peer.tarif = p.tarif
LEFT JOIN ami_profil a ON a.id_pelanggan = p.id_pelanggan
LEFT JOIN event_meter_pelanggan e ON e.id_pelanggan = p.id_pelanggan
LEFT JOIN tm_tiga_fasa tm ON tm.id_pelanggan = p.id_pelanggan
LEFT JOIN dt ON dt.kode_dt = p.kode_dt
LEFT JOIN rute ON rute.petugas_baca = p.petugas_baca
ORDER BY p.id_pelanggan"""

# rule → (pattern it signals, score, kWh lost per month, evidence); one row per hit
SQL_SKRINING = """-- Skrining aturan pelanggan: tiap aturan menandai pola yang ditanam di demo (kode NTL-xx), dengan skor (0–100),
-- perkiraan kWh hilang per bulan dan nilai rupiahnya, serta buktinya dalam kalimat.
WITH f AS (SELECT * FROM input),
hits AS (
  SELECT id_pelanggan, 'R-01' AS aturan, 'NTL-01' AS kode_pola, 'Pemakaian turun tajam tanpa penjelasan' AS judul,
         60 + MIN(30, CAST(-perubahan_pct / 3 AS INT)) AS skor,
         kwh_bulan_q2 - kwh_bulan_q3 AS kwh_hilang_bulan,
         'Pemakaian turun ' || printf('%.0f', -perubahan_pct) || '% (Q2 ' || printf('%.0f', kwh_bulan_q2) || ' → Q3 ' || printf('%.0f', kwh_bulan_q3) || ' kWh/bln)' AS bukti
  FROM f WHERE tegangan = 'TR' AND perubahan_pct <= -45 AND COALESCE(hari_nol, 0) < 20
  UNION ALL
  SELECT id_pelanggan, 'R-02', 'NTL-01', 'Jauh di bawah tetangga segolongan',
         55 + MIN(30, CAST((1 - rasio_vs_peer) * 40 AS INT)), kwh_bulan_q3 / NULLIF(rasio_vs_peer, 0) - kwh_bulan_q3,
         'Hanya ' || printf('%.0f', 100 * rasio_vs_peer) || '% rata-rata ' || n_peer || ' pelanggan ' || tarif || ' di ' || kode_dt
  FROM f WHERE tegangan = 'TR' AND rasio_vs_peer < 0.35 AND n_peer >= 5 AND COALESCE(hari_nol, 0) < 20
  UNION ALL
  SELECT id_pelanggan, 'R-03', 'NTL-02', 'Event magnet / tutup terminal', 70 + MIN(25, event_tamper * 5), MAX(0, kwh_bulan_q2 - kwh_bulan_q3),
         event_tamper || ' event magnet/tutup terminal di AMI (Jul–Sep)'
  FROM f WHERE event_tamper >= 1
  UNION ALL
  SELECT id_pelanggan, 'R-04', 'NTL-06', 'Stand meter macet / tagihan estimasi', 65 + bulan_estimasi * 5, MAX(0, kwh_bulan_q2 - kwh_bulan_q3),
         bulan_estimasi || ' bulan ditagih estimasi; stand sama ' || bulan_stand_sama || ' bulan'
  FROM f WHERE bulan_estimasi >= 2
  UNION ALL
  SELECT id_pelanggan, 'R-05', 'NTL-04', 'Beban puncak melebihi daya tersambung', 50 + MIN(30, CAST((rasio_puncak_vs_daya - 1) * 40 AS INT)), 0.0,
         'Puncak ' || ROUND(kw_maks_6bln, 1) || ' kW = ' || printf('%.0f', 100 * rasio_puncak_vs_daya) || '% daya ' || daya_va || ' VA'
  FROM f WHERE tegangan = 'TR' AND rasio_puncak_vs_daya > 1.1
  UNION ALL
  SELECT id_pelanggan, 'R-06', 'NTL-09', 'Pemakaian tarif sosial/pemerintah setara usaha', 60 + MIN(30, CAST(kwh_per_kva_bulan / 20 AS INT)),
         kwh_bulan_q3 * (1444.70 - tarif_rp_kwh) / NULLIF(tarif_rp_kwh, 0),
         printf('%.0f', kwh_per_kva_bulan) || ' kWh/kVA/bln pada golongan ' || tarif || ' (pola usaha)'
  FROM f WHERE tarif IN ('S2', 'P1') AND kwh_per_kva_bulan > 200
  UNION ALL
  SELECT id_pelanggan, 'R-07', 'NTL-13', 'Rute baca meter dengan banyak penurunan', 55 + CAST(porsi_turun_rute_baca * 60 AS INT), MAX(0, kwh_bulan_q2 - kwh_bulan_q3),
         'Rute ' || petugas_baca || ': ' || printf('%.0f', 100 * porsi_turun_rute_baca) || '% pelanggan non-AMI turun > 40%'
  FROM f WHERE porsi_turun_rute_baca >= 0.12 AND kwh_bulan_q3 < 0.6 * kwh_bulan_q2
  UNION ALL
  SELECT id_pelanggan, 'R-08', 'NTL-14', 'Usaha turun tajam saat beban malam gardu naik', 75, MAX(0, kwh_bulan_q2 - kwh_bulan_q3) + 4000,
         'Bisnis turun ' || printf('%.0f', -perubahan_pct) || '% sementara NTL gardu ' || kode_dt || ' ' || ROUND(ntl_gardu_pct, 1) || '% (beban tetap jalan, meter tidak mencatat)'
  FROM f WHERE segmen = 'Bisnis' AND perubahan_pct <= -50 AND ntl_gardu_pct >= 4
  UNION ALL
  SELECT id_pelanggan, 'R-09', 'X-02', 'AMI mencatat nol berhari-hari (cek meter)', 50, 0.0, hari_nol || ' hari tanpa konsumsi di AMI'
  FROM f WHERE hari_nol >= 20
  UNION ALL
  SELECT id_pelanggan, 'R-10', 'NTL-07', 'Arus/tegangan satu fasa hilang (CT/PT)', 85, kwh_bulan_q3 * 0.5,
         'Rasio arus fasa terkecil ' || ROUND(rasio_arus_fasa_min, 2) || ', tegangan ' || ROUND(rasio_tegangan_fasa_min, 2) || ' (AMR TM)'
  FROM f WHERE tegangan = 'TM' AND (rasio_arus_fasa_min < 0.4 OR rasio_tegangan_fasa_min < 0.5)
  UNION ALL
  SELECT id_pelanggan, 'R-11', 'NTL-05', 'kWh ditagih jauh di bawah kWh AMR (faktor kali)', 90, kwh_bulan_q3 * (1 / rasio_tagih_vs_amr - 1),
         'Tagihan = ' || printf('%.0f', 100 * rasio_tagih_vs_amr) || '% kWh AMR'
  FROM f WHERE tegangan = 'TM' AND rasio_tagih_vs_amr < 0.85
  UNION ALL
  SELECT id_pelanggan, 'R-12', 'NTL-10', 'Porsi WBP tidak wajar (register TOU)', 70, kwh_bulan_q3 * (0.2 - porsi_wbp) * 0.5,
         'Porsi WBP ' || ROUND(100 * porsi_wbp, 1) || '% (wajar 15–25% untuk beban 3 shift/komersial)'
  FROM f WHERE tegangan = 'TM' AND porsi_wbp < 0.06
  UNION ALL
  SELECT id_pelanggan, 'R-13', 'NTL-12', 'Demand melebihi daya kontrak berulang', 60 + MIN(30, hari_melebihi_kontrak), 0.0,
         hari_melebihi_kontrak || ' hari demand 15 menit > 85% daya kontrak ' || printf('%.0f', daya_kontrak_kva) || ' kVA'
  FROM f WHERE tegangan = 'TM' AND hari_melebihi_kontrak >= 10
)
SELECT h.id_pelanggan, h.aturan, h.kode_pola, h.judul, MIN(98, h.skor) AS skor,
       ROUND(MAX(0, h.kwh_hilang_bulan), 1) AS kwh_hilang_bulan,
       ROUND(MAX(0, h.kwh_hilang_bulan) * f.tarif_rp_kwh + CASE WHEN h.kode_pola = 'NTL-12' THEN (f.kw_dmd15_maks - 0.85 * f.daya_kontrak_kva) * 1.5 * 45000
                                                         WHEN h.kode_pola = 'NTL-04' THEN f.daya_va / 1000.0 * 40000 ELSE 0 END, 0) AS nilai_rp_bulan,
       h.bukti, f.segmen, f.tegangan, f.kode_dt, f.kode_penyulang, f.kode_ulp
FROM hits h JOIN f ON f.id_pelanggan = h.id_pelanggan
ORDER BY h.id_pelanggan, h.aturan"""

SQL_SKRINING_JARINGAN = """-- Skrining aturan jaringan: gardu distribusi (sambungan liar, overload, fasa tak seimbang, JTR panjang, trafo tua) dan
-- penyulang (faktor daya rendah, NTL penyulang yang tidak terjelaskan pelanggan TR — dugaan pelanggaran di pelanggan TM).
WITH dt AS (
  SELECT n.kode_dt, n.kode_penyulang, n.kode_ulp, AVG(n.susut_pct) AS susut_pct, AVG(n.susut_non_teknis_pct) AS ntl_pct,
         SUM(n.susut_non_teknis_kwh) / 3.0 AS ntl_kwh_bulan, SUM(n.susut_teknis_kwh) / 3.0 AS tl_kwh_bulan,
         MAX(n.beban_puncak_pct) AS beban_puncak_pct, SUM(n.hari_overload) AS hari_overload, AVG(n.rasio_arus_netral) AS rasio_netral,
         MIN(n.tegangan_ujung_min_v) AS v_min, AVG(n.porsi_malam) AS porsi_malam, MAX(d.tahun_pasang) AS tahun_pasang, MAX(d.rugi_besi_w) AS rugi_besi_w
  FROM input n JOIN gardu_distribusi d ON d.kode_dt = n.kode_dt
  WHERE n.bulan >= '2026-07' GROUP BY n.kode_dt, n.kode_penyulang, n.kode_ulp
),
explained AS (
  SELECT kode_dt, SUM(kwh_hilang_bulan) AS kwh FROM skrining_aturan_pelanggan WHERE kode_dt <> '' GROUP BY kode_dt
),
pny AS (
  SELECT kode_penyulang, kode_ulp, AVG(pf_rata) AS pf, AVG(susut_non_teknis_pct) AS ntl_pct, SUM(susut_non_teknis_kwh) / 3.0 AS ntl_kwh_bulan,
         SUM(rugi_saluran_kwh) / 3.0 AS rugi_saluran_kwh
  FROM neraca_penyulang_bulanan WHERE bulan >= '2026-07' GROUP BY kode_penyulang, kode_ulp
),
pny_dt AS (SELECT kode_penyulang, SUM(MAX(0, susut_non_teknis_kwh)) / 3.0 AS ntl_dt_kwh FROM input WHERE bulan >= '2026-07' GROUP BY kode_penyulang),
pny_tm AS (SELECT kode_penyulang, SUM(kwh_hilang_bulan) AS kwh FROM skrining_aturan_pelanggan WHERE tegangan = 'TM' GROUP BY kode_penyulang)
SELECT dt.kode_dt AS kode_aset, 'Gardu distribusi' AS jenis_aset, 'R-21' AS aturan, 'NTL-03' AS kode_pola, 'Susut non-teknis gardu tak terjelaskan pelanggan' AS judul,
       MIN(95, 55 + CAST(dt.ntl_pct AS INT)) AS skor, dt.ntl_kwh_bulan - COALESCE(e.kwh, 0) AS kwh_hilang_bulan,
       'NTL ' || ROUND(dt.ntl_pct, 1) || '% (' || printf('%.0f', dt.ntl_kwh_bulan) || ' kWh/bln); dijelaskan pelanggan ' || printf('%.0f', COALESCE(e.kwh, 0)) || ' kWh; porsi malam ' || printf('%.0f', 100 * dt.porsi_malam) || '%' AS bukti,
       dt.kode_dt AS kode_dt, dt.kode_penyulang, dt.kode_ulp
FROM dt LEFT JOIN explained e ON e.kode_dt = dt.kode_dt
WHERE dt.ntl_pct > 6 AND dt.ntl_kwh_bulan - COALESCE(e.kwh, 0) > 400
UNION ALL
SELECT kode_dt, 'Gardu distribusi', 'R-22', 'TL-01', 'Trafo overload', MIN(95, 50 + hari_overload), tl_kwh_bulan * 0.35,
       'Beban puncak ' || printf('%.0f', beban_puncak_pct) || '% kVA, ' || hari_overload || ' hari overload (Jul–Sep)', kode_dt, kode_penyulang, kode_ulp
FROM dt WHERE hari_overload >= 15
UNION ALL
SELECT kode_dt, 'Gardu distribusi', 'R-23', 'TL-02', 'Beban fasa tidak seimbang', MIN(95, 40 + CAST(rasio_netral * 80 AS INT)), tl_kwh_bulan * 0.25,
       'Arus netral ' || printf('%.0f', 100 * rasio_netral) || '% arus fasa rata-rata', kode_dt, kode_penyulang, kode_ulp
FROM dt WHERE rasio_netral > 0.3
UNION ALL
SELECT kode_dt, 'Gardu distribusi', 'R-24', 'TL-03', 'Tegangan ujung JTR rendah', MIN(95, 40 + CAST(198 - v_min AS INT) * 2), tl_kwh_bulan * 0.3,
       'Tegangan ujung terendah ' || printf('%.0f', v_min) || ' V (batas 198 V)', kode_dt, kode_penyulang, kode_ulp
FROM dt WHERE v_min < 195
UNION ALL
SELECT kode_dt, 'Gardu distribusi', 'R-25', 'TL-05', 'Trafo tua, rugi besi tinggi', 55, rugi_besi_w * 24 * 30 * 0.25 / 1000.0,
       'Terpasang ' || tahun_pasang || ', rugi besi ' || rugi_besi_w || ' W', kode_dt, kode_penyulang, kode_ulp
FROM dt WHERE tahun_pasang < 2000
UNION ALL
SELECT kode_penyulang, 'Penyulang', 'R-26', 'TL-04', 'Faktor daya penyulang rendah', 60, rugi_saluran_kwh * 0.3,
       'PF rata-rata ' || ROUND(pf, 2) || ' (< 0,85): arus dan rugi saluran naik', '', kode_penyulang, kode_ulp
FROM pny WHERE pf < 0.85
UNION ALL
SELECT p.kode_penyulang, 'Penyulang', 'R-27', 'NTL-08', 'NTL penyulang tak terjelaskan (dugaan di pelanggan TM)',
       MIN(90, 50 + CAST(p.ntl_pct * 5 AS INT)), p.ntl_kwh_bulan - COALESCE(d.ntl_dt_kwh, 0) - COALESCE(t.kwh, 0),
       'NTL penyulang ' || ROUND(p.ntl_pct, 1) || '% (' || ROUND(p.ntl_kwh_bulan / 1000, 1) || ' MWh/bln); gardu TR ' || ROUND(COALESCE(d.ntl_dt_kwh, 0) / 1000, 1)
         || ' MWh, temuan TM ' || ROUND(COALESCE(t.kwh, 0) / 1000, 1) || ' MWh', '', p.kode_penyulang, p.kode_ulp
FROM pny p LEFT JOIN pny_dt d ON d.kode_penyulang = p.kode_penyulang LEFT JOIN pny_tm t ON t.kode_penyulang = p.kode_penyulang
WHERE p.ntl_kwh_bulan - COALESCE(d.ntl_dt_kwh, 0) - COALESCE(t.kwh, 0) > 15000"""

SQL_TEMUAN = """-- Temuan susut (inti Nexus): satu temuan per pelanggan atau aset — aturan terkuat jadi pola dugaan, aturan lain jadi bukti
-- pendukung; nilai harapan = skor/100 × nilai per bulan × 3 bulan; prioritas P1/P2/P3 berdasarkan nilai harapan.
WITH semua AS (
  SELECT id_pelanggan AS kode_objek, 'Pelanggan' AS jenis_objek, aturan, kode_pola, judul, skor, kwh_hilang_bulan, nilai_rp_bulan, bukti,
         segmen, tegangan, kode_dt, kode_penyulang, kode_ulp
  FROM input
  UNION ALL
  SELECT kode_aset, jenis_aset, aturan, kode_pola, judul, skor, ROUND(MAX(0, kwh_hilang_bulan), 1),
         ROUND(MAX(0, kwh_hilang_bulan) * CASE WHEN jenis_aset = 'Penyulang' THEN 1114.74 ELSE 1444.70 END, 0), bukti,
         '-', CASE WHEN jenis_aset = 'Penyulang' THEN 'TM' ELSE 'TR' END, kode_dt, kode_penyulang, kode_ulp
  FROM skrining_aturan_jaringan
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY kode_objek ORDER BY skor * (1 + nilai_rp_bulan / 1000000.0) DESC, aturan) AS rk,
         COUNT(*) OVER (PARTITION BY kode_objek) AS jumlah_aturan,
         GROUP_CONCAT(aturan, ', ') OVER (PARTITION BY kode_objek) AS semua_aturan,
         SUM(nilai_rp_bulan) OVER (PARTITION BY kode_objek) AS nilai_total_bulan
  FROM semua
),
top AS (SELECT * FROM ranked WHERE rk = 1)
SELECT 'TMN-' || SUBSTR('0000' || ROW_NUMBER() OVER (ORDER BY skor * nilai_total_bulan DESC, kode_objek), -4) AS id_temuan,
       kode_objek, jenis_objek, CASE WHEN SUBSTR(kode_pola, 1, 2) = 'TL' THEN 'Teknis (TL)' WHEN SUBSTR(kode_pola, 1, 1) = 'X' THEN 'Perlu cek (bukan pelanggaran?)'
                                      ELSE 'Non-teknis (NTL)' END AS kelompok_susut,
       kode_pola AS kode_pola_dugaan, judul, skor, jumlah_aturan, semua_aturan, bukti,
       ROUND(kwh_hilang_bulan, 0) AS kwh_hilang_bulan, ROUND(nilai_total_bulan, 0) AS nilai_rp_bulan,
       ROUND(skor / 100.0 * nilai_total_bulan * 3, 0) AS nilai_harapan_rp,
       CASE WHEN skor / 100.0 * nilai_total_bulan * 3 >= 50000000 THEN 'P1'
            WHEN skor / 100.0 * nilai_total_bulan * 3 >= 1500000 THEN 'P2' ELSE 'P3' END AS prioritas,
       CASE WHEN SUBSTR(kode_pola, 1, 2) = 'TL' THEN 'Perintah kerja teknis' WHEN SUBSTR(kode_pola, 1, 1) = 'X' THEN 'Cek / ganti meter'
            WHEN jenis_objek = 'Penyulang' THEN 'Analisis pelanggan TM penyulang' ELSE 'Target P2TL' END AS tindak_lanjut_usulan,
       'Baru' AS status_temuan, segmen, tegangan, kode_dt, kode_penyulang, kode_ulp
FROM top
ORDER BY id_temuan"""

SQL_PELANGGAN_STATUS = """-- Pelanggan untuk Nexus: data teknis + fitur ringkas + temuan terkuat dan riwayat P2TL terakhir.
WITH p2 AS (
  SELECT id_pelanggan, MAX(tanggal) AS p2tl_terakhir, COUNT(*) AS jumlah_p2tl,
         MAX(CASE WHEN golongan LIKE 'P-%' THEN golongan END) AS golongan_pelanggaran
  FROM p2tl_bersih GROUP BY id_pelanggan
)
SELECT p.id_pelanggan, p.id_pelanggan || ' · ' || p.tarif || '/' || p.daya_va || ' VA' AS judul, p.tarif, p.daya_va, p.segmen, p.tegangan,
       p.golongan, p.jenis_meter, p.ami, p.kode_dt, p.kode_penyulang, p.kode_gi, p.kode_ulp, p.petugas_baca, p.daya_kontrak_kva, p.tag_scada,
       p.tarif_rp_kwh, p.lokasi, p.latitude, p.longitude,
       f.kwh_bulan_q2, f.kwh_bulan_q3, f.perubahan_pct, f.rasio_vs_peer, f.porsi_malam, f.event_tamper, f.porsi_wbp,
       f.rasio_arus_fasa_min, f.rasio_tagih_vs_amr, f.hari_melebihi_kontrak,
       COALESCE(t.id_temuan, '') AS id_temuan, COALESCE(t.kode_pola_dugaan, '') AS pola_dugaan, COALESCE(t.skor, 0) AS skor_aturan,
       COALESCE(t.nilai_harapan_rp, 0) AS nilai_harapan_rp, COALESCE(t.prioritas, '-') AS prioritas,
       COALESCE(p2.p2tl_terakhir, '') AS p2tl_terakhir, COALESCE(p2.jumlah_p2tl, 0) AS jumlah_p2tl, COALESCE(p2.golongan_pelanggaran, '') AS golongan_pelanggaran_lalu
FROM pelanggan p
LEFT JOIN input f ON f.id_pelanggan = p.id_pelanggan
LEFT JOIN temuan_susut t ON t.kode_objek = p.id_pelanggan
LEFT JOIN p2 ON p2.id_pelanggan = p.id_pelanggan
ORDER BY p.id_pelanggan"""

SQL_GARDU_STATUS = """-- Gardu distribusi untuk Nexus: aset + neraca Jul–Sep (susut, TL, NTL), beban, temuan dan status.
WITH n AS (
  SELECT kode_dt, SUM(kwh_keluar) AS kwh_keluar_q3, SUM(susut_kwh) AS susut_kwh_q3, SUM(susut_teknis_kwh) AS tl_kwh_q3,
         SUM(susut_non_teknis_kwh) AS ntl_kwh_q3, MAX(beban_puncak_pct) AS beban_puncak_pct, AVG(rasio_arus_netral) AS rasio_arus_netral,
         MIN(tegangan_ujung_min_v) AS tegangan_ujung_min_v, MAX(suhu_minyak_maks_c) AS suhu_minyak_maks_c
  FROM neraca_gardu_bulanan WHERE bulan >= '2026-07' GROUP BY kode_dt
),
t AS (
  SELECT kode_dt, COUNT(*) AS temuan, SUM(CASE WHEN prioritas = 'P1' THEN 1 ELSE 0 END) AS temuan_p1, SUM(nilai_harapan_rp) AS nilai_harapan_rp,
         MAX(CASE WHEN jenis_objek = 'Gardu distribusi' THEN kode_pola_dugaan END) AS pola_gardu
  FROM temuan_susut WHERE kode_dt <> '' GROUP BY kode_dt
)
SELECT d.kode_dt, d.nama, d.nama || ' · ' || ROUND(100.0 * n.susut_kwh_q3 / n.kwh_keluar_q3, 1) || '%' AS judul, d.kode_penyulang, d.kode_gi, d.kode_ulp,
       d.kva, d.tahun_pasang, d.umur_tahun, d.panjang_jtr_km, d.jumlah_pelanggan, d.pelanggan_ami, d.lokasi, d.latitude, d.longitude,
       ROUND(n.kwh_keluar_q3, 0) AS kwh_keluar_q3, ROUND(100.0 * n.susut_kwh_q3 / n.kwh_keluar_q3, 2) AS susut_pct,
       ROUND(100.0 * n.tl_kwh_q3 / n.kwh_keluar_q3, 2) AS susut_teknis_pct, ROUND(100.0 * n.ntl_kwh_q3 / n.kwh_keluar_q3, 2) AS susut_non_teknis_pct,
       ROUND(n.susut_kwh_q3 / 3.0 * 1444.70, 0) AS nilai_susut_rp_bulan,
       ROUND(n.beban_puncak_pct, 1) AS beban_puncak_pct, ROUND(n.rasio_arus_netral, 3) AS rasio_arus_netral,
       ROUND(n.tegangan_ujung_min_v, 1) AS tegangan_ujung_min_v, ROUND(n.suhu_minyak_maks_c, 1) AS suhu_minyak_maks_c,
       COALESCE(t.temuan, 0) AS jumlah_temuan, COALESCE(t.temuan_p1, 0) AS temuan_p1, COALESCE(t.nilai_harapan_rp, 0) AS nilai_harapan_rp,
       COALESCE(t.pola_gardu, '') AS pola_gardu,
       CASE WHEN 100.0 * n.ntl_kwh_q3 / n.kwh_keluar_q3 > 8 THEN 'Susut NTL tinggi'
            WHEN n.beban_puncak_pct > 100 THEN 'Overload'
            WHEN 100.0 * n.susut_kwh_q3 / n.kwh_keluar_q3 > 10 THEN 'Susut tinggi'
            WHEN 100.0 * n.susut_kwh_q3 / n.kwh_keluar_q3 > 6 THEN 'Perlu perhatian' ELSE 'Normal' END AS status_gardu
FROM gardu_distribusi d
JOIN n ON n.kode_dt = d.kode_dt
LEFT JOIN t ON t.kode_dt = d.kode_dt
ORDER BY d.kode_dt"""

SQL_PENYULANG_STATUS = """-- Penyulang untuk Nexus: aset + neraca Jul–Sep, keandalan Apr–Sep, temuan, status.
WITH n AS (
  SELECT kode_penyulang, SUM(kwh_kirim) AS kwh_kirim_q3, SUM(susut_kwh) AS susut_kwh_q3, SUM(susut_teknis_kwh) AS tl_q3,
         SUM(susut_non_teknis_kwh) AS ntl_q3, AVG(pf_rata) AS pf_rata, MAX(kw_puncak) AS kw_puncak
  FROM neraca_penyulang_bulanan WHERE bulan >= '2026-07' GROUP BY kode_penyulang
),
t AS (SELECT kode_penyulang, COUNT(*) AS temuan, SUM(nilai_harapan_rp) AS nilai_harapan_rp FROM temuan_susut GROUP BY kode_penyulang)
SELECT f.kode_penyulang, f.nama, f.nama || ' · ' || ROUND(100.0 * n.susut_kwh_q3 / n.kwh_kirim_q3, 1) || '%' AS judul, f.kode_gi, f.nama_gi, f.kode_ulp,
       f.jenis, f.karakter_beban, f.panjang_km, f.tag_scada_kwh, f.jumlah_gardu_distribusi, f.jumlah_pelanggan, f.jumlah_pelanggan_tm,
       f.recloser_scada, f.lbs_scada, f.geometri,
       ROUND(n.kwh_kirim_q3 / 1000, 1) AS mwh_kirim_q3, ROUND(100.0 * n.susut_kwh_q3 / n.kwh_kirim_q3, 2) AS susut_pct,
       ROUND(100.0 * n.tl_q3 / n.kwh_kirim_q3, 2) AS susut_teknis_pct, ROUND(100.0 * n.ntl_q3 / n.kwh_kirim_q3, 2) AS susut_non_teknis_pct,
       ROUND(n.susut_kwh_q3 / 3.0 * CASE WHEN f.jumlah_pelanggan_tm > 10 THEN 1114.74 ELSE 1444.70 END, 0) AS nilai_susut_rp_bulan,
       ROUND(n.pf_rata, 3) AS pf_rata, ROUND(n.kw_puncak, 0) AS kw_puncak,
       k.saidi_menit, k.saifi_kali, k.maifi_kali, k.gangguan,
       COALESCE(t.temuan, 0) AS jumlah_temuan, COALESCE(t.nilai_harapan_rp, 0) AS nilai_harapan_rp,
       CASE WHEN 100.0 * n.susut_kwh_q3 / n.kwh_kirim_q3 > 15 THEN 'Kritis' WHEN 100.0 * n.susut_kwh_q3 / n.kwh_kirim_q3 > 8 THEN 'Tinggi'
            WHEN 100.0 * n.susut_kwh_q3 / n.kwh_kirim_q3 > 5 THEN 'Sedang' ELSE 'Rendah' END AS tingkat_susut
FROM penyulang f
JOIN n ON n.kode_penyulang = f.kode_penyulang
LEFT JOIN keandalan_penyulang k ON k.kode_penyulang = f.kode_penyulang
LEFT JOIN t ON t.kode_penyulang = f.kode_penyulang
ORDER BY f.kode_penyulang"""

SQL_GANGGUAN = """-- Gangguan penyulang dari SOE SCADA: waktu trip, peralatan, jenis, penyebab, durasi, pelanggan padam, energi tidak tersalur.
SELECT g.id_gangguan, g.id_gangguan || ' · ' || g.kode_penyulang || ' · ' || g.jenis AS judul, g.kode_penyulang, f.kode_gi, f.kode_ulp,
       g.waktu_trip, SUBSTR(g.waktu_trip, 1, 10) AS tanggal, g.peralatan_trip, g.tag_trip, g.jenis, g.penyebab,
       CAST(g.durasi_menit AS INT) AS durasi_menit, CAST(g.pelanggan_padam AS INT) AS pelanggan_padam,
       CAST(g.kwh_tidak_tersalur AS DOUBLE) AS kwh_tidak_tersalur,
       ROUND(g.durasi_menit * g.pelanggan_padam / 60.0, 1) AS pelanggan_jam_padam
FROM input g
JOIN penyulang f ON f.kode_penyulang = g.kode_penyulang
ORDER BY g.waktu_trip"""

SQL_P2TL = """-- Riwayat P2TL (label model): hasil pemeriksaan dengan segmen pelanggan; temuan = golongan P-I..P-IV.
SELECT r.no_ba, r.id_pelanggan, r.tanggal, SUBSTR(r.tanggal, 1, 7) AS bulan, r.dasar_pemilihan, r.golongan, r.temuan,
       CASE WHEN r.golongan LIKE 'P-%' THEN 1 ELSE 0 END AS ditemukan_pelanggaran,
       CAST(r.kwh_tagihan_susulan AS DOUBLE) AS kwh_tagihan_susulan, CAST(r.rp_tagihan_susulan AS DOUBLE) AS rp_tagihan_susulan, r.tim,
       p.segmen, p.tegangan, p.tarif, p.kode_dt, p.kode_penyulang, p.kode_ulp
FROM input r
JOIN pelanggan p ON p.id_pelanggan = r.id_pelanggan
ORDER BY r.tanggal, r.no_ba"""

SQL_P2TL_EFEKTIVITAS = """-- Efektivitas P2TL per dasar pemilihan dan segmen: hit-rate dan rupiah per pemeriksaan (bias pemilihan terlihat di sini).
SELECT dasar_pemilihan, segmen, COUNT(*) AS pemeriksaan, SUM(ditemukan_pelanggaran) AS temuan,
       ROUND(100.0 * SUM(ditemukan_pelanggaran) / COUNT(*), 1) AS hit_rate_pct,
       ROUND(SUM(rp_tagihan_susulan), 0) AS rp_tagihan_susulan, ROUND(SUM(rp_tagihan_susulan) / COUNT(*), 0) AS rp_per_pemeriksaan
FROM input
GROUP BY dasar_pemilihan, segmen
ORDER BY dasar_pemilihan, segmen"""

SQL_ULP = """-- Ringkasan per ULP (Jul–Sep): energi kirim, tagih, susut, TL, NTL, nilai, temuan P1 dan nilai harapannya.
WITH n AS (
  SELECT kode_ulp, SUM(kwh_kirim) AS kirim, SUM(kwh_tagih) AS tagih, SUM(susut_teknis_kwh) AS tl, SUM(susut_non_teknis_kwh) AS ntl
  FROM input WHERE bulan >= '2026-07' GROUP BY kode_ulp
),
t AS (SELECT kode_ulp, COUNT(*) AS temuan, SUM(CASE WHEN prioritas = 'P1' THEN 1 ELSE 0 END) AS p1, SUM(nilai_harapan_rp) AS nilai_harapan_rp
      FROM temuan_susut GROUP BY kode_ulp)
SELECT n.kode_ulp, ROUND(n.kirim / 1000, 0) AS mwh_kirim_q3, ROUND(n.tagih / 1000, 0) AS mwh_tagih_q3,
       ROUND(100.0 * (n.kirim - n.tagih) / n.kirim, 2) AS susut_pct, ROUND(100.0 * n.tl / n.kirim, 2) AS susut_teknis_pct,
       ROUND(100.0 * n.ntl / n.kirim, 2) AS susut_non_teknis_pct, ROUND((n.kirim - n.tagih) * 1300, 0) AS nilai_susut_rp_q3,
       COALESCE(t.temuan, 0) AS temuan, COALESCE(t.p1, 0) AS temuan_p1, COALESCE(t.nilai_harapan_rp, 0) AS nilai_harapan_rp
FROM n LEFT JOIN t ON t.kode_ulp = n.kode_ulp
ORDER BY n.kode_ulp"""


def susut_spec() -> list[dict]:
    S = lambda i, n, g, d: {"id": i, "kind": "source", "name": n, "group": g, "doc": d}  # noqa: E731
    import demo_grid_data as gd

    bills = [S(f"s_b{m[-2:]}", f"ap2t_tagihan_{m.replace('-', '_')}", "tagihan", f"Tagihan AP2T bulan {m}") for m in gd.MONTHS]
    return [
        S("s_scada", "scada_penyulang_harian", "scada", "Historian SCADA: kWh kirim, puncak, PF, arus, THD, menit padam per penyulang per hari"),
        S("s_soe", "scada_gangguan_soe", "scada", "SOE SCADA: trip PMT/recloser, durasi, pelanggan padam"),
        S("s_amr", "amr_gardu_harian", "amr", "AMR gardu distribusi: kWh keluar, arus per fasa & netral, tegangan ujung, suhu minyak"),
        S("s_tm", "amr_tm_tiga_fasa_harian", "amr", "AMR pelanggan TM: kWh, WBP, demand 15 menit, U & I per fasa"),
        *bills,
        S("s_ami", "ami_konsumsi_harian", "ami", "AMI: konsumsi harian pelanggan TR (sejak 1 Juli 2026)"),
        S("s_evt", "ami_event_meter", "ami", "AMI: event meter (magnet, tutup terminal, fasa, padam)"),
        S("s_p2tl", "p2tl_hasil_pemeriksaan", "p2tl", "Berita acara P2TL Okt 2025 – Sep 2026"),
        S("s_pel", "pelanggan", "aset", "Pelanggan (output pipeline aset)"),
        S("s_dt", "gardu_distribusi", "aset", "Gardu distribusi (output pipeline aset)"),
        S("s_pny", "penyulang", "aset", "Penyulang (output pipeline aset)"),
        {"id": "u_tag", "kind": "union", "name": "tagihan_gabungan", "group": "tagihan", "inputs": [b["id"] for b in bills]},
        {"id": "t_tag", "kind": "sql", "name": "tagihan_bersih", "group": "tagihan", "input": "u_tag", "sql": SQL_TAGIHAN},
        {"id": "t_tagr", "kind": "sql", "name": "tagihan_ringkas", "group": "tagihan", "input": "t_tag", "sql": SQL_TAGIHAN_RINGKAS},
        {"id": "t_ami", "kind": "sql", "name": "ami_profil", "group": "ami", "input": "s_ami", "sql": SQL_AMI_PROFIL},
        {"id": "t_evt", "kind": "sql", "name": "event_meter_pelanggan", "group": "ami", "input": "s_evt", "sql": SQL_EVENT},
        {"id": "t_tm", "kind": "sql", "name": "tm_tiga_fasa", "group": "amr", "input": "s_tm", "sql": SQL_TM},
        {"id": "t_ndt", "kind": "sql", "name": "neraca_gardu_bulanan", "group": "neraca", "input": "s_amr", "sql": SQL_NERACA_DT},
        {"id": "t_npy", "kind": "sql", "name": "neraca_penyulang_bulanan", "group": "neraca", "input": "s_scada", "sql": SQL_NERACA_PNY},
        {"id": "t_kdl", "kind": "sql", "name": "keandalan_penyulang", "group": "neraca", "input": "s_soe", "sql": SQL_KEANDALAN},
        {"id": "t_fit", "kind": "sql", "name": "fitur_pelanggan", "group": "fitur", "input": "t_tagr", "sql": SQL_FITUR},
        {"id": "t_skr", "kind": "sql", "name": "skrining_aturan_pelanggan", "group": "fitur", "input": "t_fit", "sql": SQL_SKRINING},
        {"id": "t_skj", "kind": "sql", "name": "skrining_aturan_jaringan", "group": "neraca", "input": "t_ndt", "sql": SQL_SKRINING_JARINGAN},
        {"id": "t_ggn", "kind": "sql", "name": "gangguan_penyulang", "group": "neraca", "input": "s_soe", "sql": SQL_GANGGUAN},
        {"id": "t_p2", "kind": "sql", "name": "p2tl_bersih", "group": "p2tl", "input": "s_p2tl", "sql": SQL_P2TL},
        {"id": "t_tmn", "kind": "sql", "name": "temuan_susut", "group": "inti", "input": "t_skr", "sql": SQL_TEMUAN},
        {"id": "t_pst", "kind": "sql", "name": "pelanggan_status", "group": "inti", "input": "t_fit", "sql": SQL_PELANGGAN_STATUS},
        {"id": "t_gst", "kind": "sql", "name": "gardu_distribusi_status", "group": "inti", "input": "t_ndt", "sql": SQL_GARDU_STATUS},
        {"id": "t_fst", "kind": "sql", "name": "penyulang_status", "group": "inti", "input": "t_npy", "sql": SQL_PENYULANG_STATUS},
        {"id": "t_eff", "kind": "sql", "name": "efektivitas_p2tl", "group": "analitik", "input": "t_p2", "sql": SQL_P2TL_EFEKTIVITAS},
        {"id": "t_ulp", "kind": "sql", "name": "ringkasan_susut_ulp", "group": "analitik", "input": "t_npy", "sql": SQL_ULP},
    ]


SUSUT_OUTPUTS = [("pelanggan_status", "t_pst"), ("gardu_distribusi_status", "t_gst"), ("penyulang_status", "t_fst"), ("temuan_susut", "t_tmn"),
                 ("neraca_gardu_bulanan", "t_ndt"), ("neraca_penyulang_bulanan", "t_npy"), ("keandalan_penyulang", "t_kdl"),
                 ("fitur_pelanggan", "t_fit"), ("skrining_aturan_pelanggan", "t_skr"), ("skrining_aturan_jaringan", "t_skj"),
                 ("tagihan_bersih", "t_tag"), ("p2tl_bersih", "t_p2"), ("gangguan_penyulang", "t_ggn"), ("efektivitas_p2tl", "t_eff"), ("ringkasan_susut_ulp", "t_ulp")]

# the pipelines: key → (name, spec, groups, outputs, folder of the outputs, version, description, canvas notes)
PIPELINES: dict[str, dict] = {
    "aset": {"name": "Pipeline aset & topologi jaringan grid (demo)", "spec": aset_spec, "groups": ASET_GROUPS, "outputs": ASET_OUTPUTS,
             "folder": "clean", "version": 2,
             "description": "Demo: GIS, AP2T dan konteks transmisi Jabar (OSM) menjadi tabel aset jaringan: GI, penyulang, gardu distribusi, "
                            "pelanggan (tanpa identitas) dan konektivitas. Model SCADA (CEII) diolah pipeline tersendiri.",
             "notes": [("lg-gis", "1 · SUMBER — GIS distribusi (termasuk recloser & LBS), register GI, master organisasi, master teknis AP2T (tanpa "
                                  "identitas), tarif, dan jaringan transmisi Jabar dari OpenStreetMap (konteks). Tanpa model SCADA (CEII)."),
                       ("lg-inti", "2 · ASET INTI (mendukung Nexus) — gardu induk, penyulang (geometri, tag SCADA, recloser/LBS), gardu "
                                   "distribusi (umur, rugi trafo, JTR), pelanggan (golongan, tarif, jalur pasokan)."),
                       ("lg-analitik", "3 · KUALITAS & KONTEKS — konektivitas pelanggan → gardu → penyulang → GI → GITET dengan cek topologi, "
                                       "ringkasan aset per ULP, saluran/gardu transmisi dan kawasan industri Jabar (OSM, tanpa data demo).")]},
    "scada": {"name": "Pipeline model SCADA grid (demo)", "spec": scada_spec, "groups": SCADA_GROUPS, "outputs": SCADA_OUTPUTS,
              "folder": "clean", "version": 1,
              "description": "Demo: model jaringan NUSAGRID SCADA (peralatan CIM-lite dan titik ukur) — bertanda Infrastruktur Kritis (CEII) — "
                             "menjadi tabel titik ukur untuk Nexus. Terpisah agar penanda CEII tidak turun ke data aset dan susut.",
              "notes": [("lg-scada", "1 · SUMBER (CEII) — peralatan CIM-lite dan daftar titik ukur NUSAGRID. Penanda mengikuti input pipeline ke "
                                     "semua output: hanya pipeline ini yang membacanya."),
                        ("lg-inti", "2 · TITIK UKUR — tag SITE.GARDU.TEGANGAN.BAY.PERALATAN.SINYAL dengan peralatan, bay dan penyulangnya; "
                                    "hanya pemegang CEII (dispatcher) yang melihatnya.")]},
    "susut": {"name": "Pipeline neraca energi & susut grid (demo)", "spec": susut_spec, "groups": SUSUT_GROUPS, "outputs": SUSUT_OUTPUTS,
              "folder": "susut", "version": 2,
              "description": "Demo: SCADA, AMR, AMI, tagihan AP2T dan P2TL menjadi neraca energi gardu dan penyulang, susut teknis (fisika) dan "
                             "non-teknis (sisa), keandalan, fitur pelanggan, skrining aturan dan temuan susut berprioritas nilai.",
              "notes": [("lg-scada", "1 · SUMBER — historian SCADA (NUSAGRID E_IMP & RTU GI Kota), SOE, AMR gardu & TM, 6 file tagihan AP2T, AMI "
                                     "harian & event meter, berita acara P2TL; aset dari pipeline 1."),
                        ("lg-neraca", "2 · NERACA & SUSUT TEKNIS — kirim SCADA vs Σ tagihan per gardu/penyulang/bulan; TL = I²R × faktor rugi × "
                                      "ketidakseimbangan + rugi trafo & saluran; NTL = sisa. SAIDI/SAIFI dari SOE."),
                        ("lg-fitur", "3 · FITUR & SKRINING — pemakaian Q2 vs Q3, pembanding tetangga, AMI, event, tiga fasa TM, rute baca; 13 aturan "
                                     "pelanggan + 7 aturan jaringan menandai pola NTL/TL."),
                        ("lg-inti", "4 · TEMUAN & NEXUS — satu temuan per objek, nilai harapan = skor × nilai × 3 bulan, prioritas P1/P2/P3; "
                                    "pelanggan, gardu dan penyulang berstatus untuk Nexus.")]},
}


def generate_sources(key: str) -> dict[str, list[dict]]:
    """The source rows of a pipeline: raw tables, and for pipeline 2 the asset outputs of pipeline 1 (emulated)."""
    import demo_grid_data as gd

    raw = gd.generate()
    if key in ("aset", "scada"):
        names = [n["name"] for n in PIPELINES[key]["spec"]() if n["kind"] == "source"]
        return {n: (osm_rows() if n == "osm_jaringan_transmisi_jabar" else raw[n]) for n in names}
    aset = run("aset")
    out = {}
    for n in susut_spec():
        if n["kind"] == "source":
            out[n["name"]] = aset[n["name"]] if n["group"] == "aset" else raw[n["name"]]
    return out


def osm_rows() -> list[dict]:
    """The OpenStreetMap context as one flat table (lines with GeoJSON geometry; points with lat/lon)."""
    import json as _json

    import demo_grid_data as gd

    rows = []
    for f in gd.osm()["features"]:
        p = f["properties"]
        if p.get("jenis") not in ("saluran", "gardu", "pembangkit", "kawasan_industri"):
            continue
        geom = f.get("geometry") or {}
        lat, lon = p.get("lat"), p.get("lon")
        if p["jenis"] == "kawasan_industri":
            lon, lat = geom.get("coordinates", [None, None])
        rows.append({"osm_id": p.get("osm_id") or "", "jenis": p["jenis"], "nama": p.get("nama") or "", "voltage": p.get("voltage") or "",
                     "kelas_kv": int(p.get("kelas_kv") or 0), "kelas_kv_sumber": p.get("kelas_kv_sumber") or "", "operator": p.get("operator") or "",
                     "panjang_dalam_jabar_km": float(p.get("panjang_dalam_jabar_km") or 0.0), "gardu_ujung_a": p.get("gardu_ujung_a") or "",
                     "gardu_ujung_b": p.get("gardu_ujung_b") or "", "ruas_terhubung": int(p.get("ruas_terhubung") or 0), "kabkota": p.get("kabkota") or "",
                     "sumber_energi": p.get("sumber") or "", "kapasitas": p.get("kapasitas") or "",
                     "lat": float(lat) if lat is not None else 0.0, "lon": float(lon) if lon is not None else 0.0,
                     "geometri": _json.dumps(geom) if p["jenis"] == "saluran" else ""})
    return rows


_RUN: dict[str, dict] = {}


def run(key: str) -> dict[str, list[dict]]:
    """Every node's rows of a pipeline (the sqlite emulation of its SQL), cached per process."""
    if key not in _RUN:
        p = PIPELINES[key]
        _RUN[key] = base.run(generate_sources(key), p["spec"]())
    return _RUN[key]


def outputs(key: str) -> dict[str, list[dict]]:
    rows = run(key)
    by = {n["id"]: n["name"] for n in PIPELINES[key]["spec"]()}
    return {name: rows[by[node]] for name, node in PIPELINES[key]["outputs"]}


# ------------------------------------------------------------------------------------------------
# layout, Pipeline Builder content, the graph pages draw
# ------------------------------------------------------------------------------------------------

def layout(nodes: list[dict], groups: list[tuple[str, str, str]]) -> dict[str, tuple[int, int]]:
    d = base.deps(nodes)
    depth: dict[str, int] = {}
    for n in base.order(nodes):
        depth[n["id"]] = 0 if not d[n["id"]] else 1 + max(depth[x] for x in d[n["id"]])
    y: dict[str, float] = {}
    cursor = 40.0
    for gid, _, _ in groups:
        members = [n for n in nodes if n["group"] == gid and n["kind"] == "source"]
        for n in members:
            y[n["id"]] = cursor
            cursor += 92
        if members:
            cursor += 40
    taken: dict[int, list[float]] = {}
    for n in base.order(nodes):
        if n["kind"] == "source":
            continue
        ups = d[n["id"]]
        main = n.get("input") or n.get("left") or ups[0]
        want = (2 * y[main] + sum(y[u] for u in ups)) / (2 + len(ups))
        col = taken.setdefault(depth[n["id"]], [])
        while any(abs(want - t) < 84 for t in col):
            want += 88
        col.append(want)
        y[n["id"]] = want
    return {i: (60 + depth[i] * 300, int(y[i])) for i in depth}


EXPECT: dict[str, list[tuple[str, Any]]] = {
    "gardu_induk": [("unique", ["kode_gi"])], "penyulang": [("unique", ["kode_penyulang"]), ("notNull", ["geometri", "tag_scada_kwh"])],
    "gardu_distribusi": [("unique", ["kode_dt"]), ("notNull", ["lokasi", "kode_penyulang"])],
    "pelanggan": [("unique", ["id_pelanggan"]), ("notNull", ["tarif", "kode_penyulang"])], "titik_ukur_scada": [("unique", ["tag"])],
    "konektivitas_jaringan": [("oneOf", ("cek_topologi", ["OK", "TR tanpa gardu distribusi", "Penyulang pelanggan ≠ penyulang gardu"]))],
    "ringkasan_aset_ulp": [("rowCount", 1)], "saluran_transmisi_jabar": [("unique", ["osm_id"])], "gardu_transmisi_jabar": [("unique", ["osm_id"])],
    "kawasan_industri_jabar": [("rowCount", 1)],
    "pelanggan_status": [("unique", ["id_pelanggan"])], "gardu_distribusi_status": [("unique", ["kode_dt"])],
    "penyulang_status": [("unique", ["kode_penyulang"])], "temuan_susut": [("unique", ["id_temuan"]), ("notNull", ["kode_pola_dugaan", "prioritas"])],
    "neraca_gardu_bulanan": [("unique", ["id_neraca"])], "neraca_penyulang_bulanan": [("unique", ["id_neraca"])],
    "keandalan_penyulang": [("unique", ["kode_penyulang"])], "fitur_pelanggan": [("unique", ["id_pelanggan"])],
    "skrining_aturan_pelanggan": [("notNull", ["kode_pola", "skor"])], "skrining_aturan_jaringan": [("notNull", ["kode_pola"])],
    "tagihan_bersih": [("rowCount", 1000)], "p2tl_bersih": [("unique", ["no_ba"])], "efektivitas_p2tl": [("rowCount", 1)],
    "ringkasan_susut_ulp": [("unique", ["kode_ulp"])], "gangguan_penyulang": [("unique", ["id_gangguan"])],
}


def _expectations(name: str, uid: Callable[[], str]) -> list[dict]:
    out = []
    for kind, arg in EXPECT.get(name, []):
        if kind in ("unique", "notNull"):
            out.append({"id": uid(), "kind": kind, "columns": arg})
        elif kind == "oneOf":
            out.append({"id": uid(), "kind": "oneOf", "column": arg[0], "values": arg[1]})
        else:
            out.append({"id": uid(), "kind": "rowCount", "min": arg})
    return out


def content(key: str, source_items: dict[str, str], out_folder: str, project: str, uid, schedule) -> tuple[dict, dict[str, str]]:
    p = PIPELINES[key]
    now = datetime.now(timezone.utc).isoformat()
    nodes = p["spec"]()
    pos = layout(nodes, p["groups"])
    srcs = generate_sources(key)
    legend = [{"id": f"lg-{g}", "name": name, "hex": hexc} for g, name, hexc in p["groups"]]
    datasets, out_nodes = {}, []
    for n in nodes:
        x, y = pos[n["id"]]
        b = {"id": n["id"], "name": n["name"], "x": x, "y": y, "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = srcs[n["name"]]
            ds = f"ds_{n['id']}"
            folder = "clean" if n["group"] == "aset" else "raw"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {project} / {folder} / {n['name']}.parquet", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in base.schema_of(rows)], "rows": rows[:200],
                            "ref": {"kind": "drive", "itemId": source_items[n["name"]]}}
            out_nodes.append({**b, "kind": "source", "datasetId": ds, "description": n["doc"]})
        elif n["kind"] == "union":
            out_nodes.append({**b, "kind": "union", "inputs": n["inputs"], "mode": "union all", "strict": True})
        else:
            out_nodes.append({**b, "kind": "transform", "input": n["input"], "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}]})
    location = {"id": out_folder, "name": f"{project} / {p['folder']}"}
    outputs_, out_ids = [], {}
    xmax = max(x for x, _ in pos.values())
    for name, node in p["outputs"]:
        out_ids[name] = f"o_{node}"
        outputs_.append({"id": out_ids[name], "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                         "expectations": _expectations(name, uid), "x": xmax + 320, "y": pos[node][1]})
    text = [{"id": f"note_{i + 1}", "x": 40 + i * 600, "y": -230, "w": 560, "h": 160, "color": color, "text": t} for i, (color, t) in enumerate(p["notes"])]
    body = {"type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": out_nodes, "outputs": outputs_, "legend": legend,
            "location": location, "textNodes": text, "schedules": [schedule(key, list(out_ids.values()))],
            "meta": {"version": p["version"], "description": p["description"]}}
    return body, out_ids


def lineage(key: str) -> dict:
    p = PIPELINES[key]
    nodes = p["spec"]()
    d = base.deps(nodes)
    pos = layout(nodes, p["groups"])
    return {"name": p["name"], "groups": [{"id": g, "name": n, "hex": h} for g, n, h in p["groups"]],
            "nodes": [{"id": n["id"], "name": n["name"], "kind": n["kind"], "group": n["group"], "x": pos[n["id"]][0], "y": pos[n["id"]][1], "doc": n.get("doc")} for n in nodes],
            "edges": [[u, n] for n, ups in d.items() for u in ups], "outputs": [{"name": name, "node": node} for name, node in p["outputs"]]}
