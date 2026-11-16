"""Demo Grid: analitik operasi jaringan untuk PLN Grid Monitoring Cockpit (langkah "operasi" di demo_grid_e2e.build).

Semua angka cockpit datang dari pipeline, dataset dan objek Nexus — bukan dihitung ulang di halaman:

1. "Pipeline analitik operasi grid (demo)" (Pipeline Builder, SQL, batch; bangun ulang saat data masuk) membaca keluaran
   pipeline aset, susut dan beban per jam: beban gardu induk per jam dan kontingensi N-1 trafo GI (kapasitas firm
   satu trafo keluar), pembebanan termal penyulang terhadap KHA penghantar GIS dan rating PMT, kurva beban harian,
   keandalan per penyulang per bulan (IEEE 1366: SAIDI, SAIFI, MAIFI, CAIDI, ENS), risiko aset (aturan deterministik
   berbukti) dan alarm operasi terpadu → folder operasi/.
2. Code Repository "Analitik Topologi Transmisi Grid demo" (transform Python) membaca jaringan transmisi Jawa–Bali
   gabungan (OpenStreetMap, riil): koridor gardu-ke-gardu, koridor kritis N-1 STRUKTURAL (jembatan graf: lepasnya
   memisahkan jaringan), gardu titik artikulasi, gardu & MW pembangkit (tag kapasitas OSM) yang terisolasi. Tidak ada
   angka listrik yang dikarang untuk aset riil — rating/impedansi transmisi tidak ada di OSM, jadi ini analisis
   konektivitas, bukan aliran daya.
3. Nexus: Alarm Operasi, Risiko Aset Operasi, Kontingensi N-1 GI, Pembebanan Penyulang, Keandalan Penyulang Bulanan
   (demo) dan Koridor/Simpul Transmisi (OSM, analisis), bertaut ke GI/Penyulang/Gardu dan gardu OSM; baris per ULP
   (UP3, analis & operasi semua); riwayat edit; actions untuk alarm (akui/tugaskan/selesaikan/buka ulang), status
   peristiwa AMI dan status perintah kerja — cockpit menulis lewat actions ini, jadi audit ada di Nexus.
4. Aplikasi: layer koridor kritis N-1 di peta gabungan Jawa–Bali, layer risiko gardu di peta susut demo, graf lineage
   tersimpan "gridoperasi".

Fiktif untuk jaringan distribusi demo (berlabel "(demo)"); aset transmisi OSM riil tanpa angka demo. Read-only ke SCADA.
"""

from __future__ import annotations

import hashlib
import inspect
import io
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

log = logging.getLogger("bluesandai.demo_grid_operasi")

PIPELINE = "Pipeline analitik operasi grid (demo)"
VERSION = 1
FOLDER = "operasi"
REPO = "Analitik Topologi Transmisi Grid demo"
LINEAGE_GRAPH = "gridoperasi"


def _e():
    import demo_grid_e2e as e

    return e


# ------------------------------------------------------------------------------------------------
# 1 · pipeline analitik operasi (SQL, sqlite/sql.js — tanpa CAST teks, tanpa fungsi tanggal Spark)
# ------------------------------------------------------------------------------------------------

# source name → folder of the project where the upstream pipeline writes it
SOURCES = [
    ("gardu_induk", "clean", "Gardu induk (pipeline aset): kapasitas MVA, konfigurasi trafo daya"),
    ("penyulang", "clean", "Penyulang (pipeline aset): jenis, panjang, R per km, KHA penghantar dari GIS"),
    ("penyulang_status", "susut", "Penyulang berstatus (pipeline susut): GI, ULP, pelanggan, faktor daya, susut, SAIDI"),
    ("gardu_distribusi_status", "susut", "Gardu distribusi berstatus (pipeline susut): kVA, umur, suhu minyak, tegangan ujung, susut"),
    ("gangguan_penyulang", "susut", "Gangguan penyulang dari SOE SCADA (pipeline susut): jenis, penyebab, durasi, pelanggan padam"),
    ("temuan_susut", "susut", "Temuan susut berprioritas (pipeline susut): pola, skor, nilai harapan, P1/P2/P3"),
    ("daya_penyulang_per_jam", "iot", "Daya aktif penyulang per jam (pipeline beban per jam, historian SCADA)"),
    ("puncak_harian_gardu", "iot", "Puncak harian gardu distribusi (pipeline beban per jam, AMR)"),
]

SQL_BEBAN_GI = """-- Beban gardu induk per jam: Σ daya penyulang (historian SCADA) per GI; MVA = kW / faktor daya rata-rata penyulang;
-- persentase terhadap kapasitas terpasang dan terhadap kapasitas firm N-1 (satu trafo daya keluar: kapasitas × (n−1)/n).
WITH g AS (
  SELECT kode_gi, nama, kode_ulp, kapasitas_mva,
         CASE WHEN trafo LIKE '3 %' THEN 3 WHEN trafo LIKE '2 %' THEN 2 ELSE 1 END AS n_trafo
  FROM gardu_induk
),
p AS (
  SELECT d.ts, d.waktu, f.kode_gi, SUM(d.kw) / 1000.0 AS mw,
         SUM(d.kw / COALESCE(NULLIF(f.pf_rata, 0), 0.9)) / 1000.0 AS mva
  FROM input d JOIN penyulang_status f ON f.kode_penyulang = d.kode_penyulang
  GROUP BY d.ts, d.waktu, f.kode_gi
)
SELECT p.kode_gi || ' · ' || p.waktu AS id_beban, p.kode_gi, g.nama AS nama_gi, g.kode_ulp, p.ts, p.waktu,
       ROUND(p.mw, 3) AS mw, ROUND(p.mva, 3) AS mva, g.kapasitas_mva, g.n_trafo,
       ROUND(g.kapasitas_mva * (g.n_trafo - 1) / g.n_trafo, 1) AS kapasitas_firm_mva,
       ROUND(100.0 * p.mva / g.kapasitas_mva, 2) AS beban_pct,
       ROUND(100.0 * p.mva / NULLIF(g.kapasitas_mva * (g.n_trafo - 1) / g.n_trafo, 0), 2) AS beban_firm_pct
FROM p JOIN g ON g.kode_gi = p.kode_gi
ORDER BY p.kode_gi, p.ts"""

SQL_N1_GI = """-- Kontingensi N-1 trafo gardu induk: puncak beban koinsiden (jam yang sama, semua penyulang) dibanding kapasitas firm;
-- jam melanggar/waspada N-1, margin MVA, faktor diversitas (Σ puncak penyulang / puncak GI) dan status.
WITH r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY kode_gi ORDER BY mva DESC) AS rk FROM input),
f AS (SELECT kode_gi, COUNT(*) AS penyulang, SUM(kw_puncak) / 1000.0 AS mw_puncak_penyulang FROM penyulang_status GROUP BY kode_gi),
a AS (
  SELECT r.kode_gi, MAX(r.nama_gi) AS nama_gi, MAX(r.kode_ulp) AS kode_ulp, MAX(r.kapasitas_mva) AS kapasitas_mva,
         MAX(r.n_trafo) AS n_trafo, MAX(r.kapasitas_firm_mva) AS kapasitas_firm_mva,
         MAX(r.mva) AS puncak_mva, MAX(CASE WHEN r.rk = 1 THEN r.mw END) AS puncak_mw, MAX(CASE WHEN r.rk = 1 THEN r.waktu END) AS waktu_puncak,
         AVG(r.mva) AS rata_mva, MAX(r.beban_firm_pct) AS beban_firm_maks,
         SUM(CASE WHEN r.beban_firm_pct > 100 THEN 1 ELSE 0 END) AS jam_melanggar_n1,
         SUM(CASE WHEN r.beban_firm_pct > 90 THEN 1 ELSE 0 END) AS jam_waspada_n1, COUNT(*) AS jam_data
  FROM r GROUP BY r.kode_gi
)
SELECT a.kode_gi, a.nama_gi, a.kode_ulp,
       a.kode_gi || ' · N-1 ' || CASE WHEN a.beban_firm_maks > 100 THEN 'melanggar' WHEN a.beban_firm_maks > 90 THEN 'waspada' ELSE 'aman' END
         || ' · puncak ' || ROUND(a.puncak_mva, 2) || ' MVA' AS judul,
       a.kapasitas_mva, a.n_trafo, a.kapasitas_firm_mva, ROUND(a.puncak_mva, 3) AS puncak_mva, ROUND(a.puncak_mw, 3) AS puncak_mw,
       a.waktu_puncak, ROUND(a.rata_mva, 3) AS rata_mva, ROUND(a.rata_mva / NULLIF(a.puncak_mva, 0), 3) AS faktor_beban,
       ROUND(100.0 * a.puncak_mva / a.kapasitas_mva, 2) AS beban_puncak_pct, ROUND(a.beban_firm_maks, 2) AS beban_firm_puncak_pct,
       ROUND(a.kapasitas_firm_mva - a.puncak_mva, 2) AS margin_n1_mva, a.jam_melanggar_n1, a.jam_waspada_n1, a.jam_data,
       COALESCE(f.penyulang, 0) AS penyulang, ROUND(COALESCE(f.mw_puncak_penyulang, 0), 3) AS mw_puncak_penyulang,
       ROUND(COALESCE(f.mw_puncak_penyulang, 0) / NULLIF(a.puncak_mw, 0), 3) AS faktor_diversitas,
       CASE WHEN a.beban_firm_maks > 100 THEN 'Melanggar N-1' WHEN a.beban_firm_maks > 90 THEN 'Waspada N-1' ELSE 'Aman N-1' END AS status_n1,
       CASE WHEN a.beban_firm_maks > 100 THEN 'Pindahkan ' || ROUND(a.puncak_mva - a.kapasitas_firm_mva, 2) || ' MVA ke GI tetangga / tambah trafo'
            WHEN a.beban_firm_maks > 90 THEN 'Siapkan manuver penyulang ke GI tetangga saat puncak'
            ELSE 'Satu trafo keluar masih menanggung puncak (margin ' || ROUND(a.kapasitas_firm_mva - a.puncak_mva, 1) || ' MVA)' END AS rekomendasi
FROM a LEFT JOIN f ON f.kode_gi = a.kode_gi
ORDER BY a.kode_gi"""

SQL_PROFIL = """-- Kurva beban harian penyulang (Jul–Sep): rata-rata, minimum dan maksimum daya per jam-hari (WIB),
-- rata-rata hari kerja vs akhir pekan (dayofweek: 1 Minggu … 7 Sabtu).
SELECT kode_penyulang || ' · ' || SUBSTR(waktu, 12, 2) AS id_profil, kode_penyulang, SUBSTR(waktu, 12, 2) AS jam,
       ROUND(AVG(kw), 1) AS rata_kw, ROUND(MIN(kw), 1) AS min_kw, ROUND(MAX(kw), 1) AS maks_kw,
       ROUND(AVG(CASE WHEN dayofweek(SUBSTR(waktu, 1, 10)) IN (1, 7) THEN kw END), 1) AS rata_akhir_pekan_kw,
       ROUND(AVG(CASE WHEN dayofweek(SUBSTR(waktu, 1, 10)) NOT IN (1, 7) THEN kw END), 1) AS rata_hari_kerja_kw
FROM input
GROUP BY kode_penyulang, SUBSTR(waktu, 12, 2)
ORDER BY kode_penyulang, jam"""

SQL_PEMBEBANAN = """-- Pembebanan termal penyulang (Jul–Sep): arus I = P / (√3 · 20 kV · PF) per jam dari daya SCADA, dibanding batas
-- termal = min(KHA penghantar GIS, rating PMT 630 A); faktor beban, jam > 80 % batas, rugi I²R saat puncak (beban
-- tersebar merata: faktor 1/3) dan ruang tambah beban hingga 80 % batas.
WITH h AS (
  SELECT d.kode_penyulang, d.waktu, d.kw, COALESCE(NULLIF(s.pf_rata, 0), 0.9) AS pf,
         d.kw / (1.7320508 * 20.0 * COALESCE(NULLIF(s.pf_rata, 0), 0.9)) AS arus_a,
         ROW_NUMBER() OVER (PARTITION BY d.kode_penyulang ORDER BY d.kw DESC) AS rk
  FROM input d JOIN penyulang_status s ON s.kode_penyulang = d.kode_penyulang
),
a AS (
  SELECT p.kode_penyulang, p.nama, p.kode_gi, p.kode_ulp, p.jenis, p.panjang_km, p.r_ohm_km, p.kha_a,
         MIN(p.kha_a, 630) AS batas_termal_a, MAX(h.pf) AS pf,
         MAX(h.kw) AS puncak_kw, MAX(CASE WHEN h.rk = 1 THEN h.waktu END) AS waktu_puncak, AVG(h.kw) AS rata_kw,
         MAX(h.arus_a) AS arus_puncak_a, SUM(CASE WHEN h.arus_a > 0.8 * MIN(p.kha_a, 630) THEN 1 ELSE 0 END) AS jam_di_atas_80pct,
         COUNT(*) AS jam_data
  FROM penyulang p JOIN h ON h.kode_penyulang = p.kode_penyulang
  GROUP BY p.kode_penyulang, p.nama, p.kode_gi, p.kode_ulp, p.jenis, p.panjang_km, p.r_ohm_km, p.kha_a
)
SELECT kode_penyulang, nama, kode_gi, kode_ulp, jenis, panjang_km, kha_a, 630 AS rating_pmt_a, batas_termal_a,
       kode_penyulang || ' · ' || ROUND(100.0 * arus_puncak_a / batas_termal_a, 1) || '% batas termal' AS judul,
       ROUND(puncak_kw, 1) AS puncak_kw, waktu_puncak, ROUND(rata_kw, 1) AS rata_kw, ROUND(rata_kw / NULLIF(puncak_kw, 0), 3) AS faktor_beban,
       ROUND(arus_puncak_a, 1) AS arus_puncak_a, ROUND(100.0 * arus_puncak_a / batas_termal_a, 2) AS beban_termal_pct,
       jam_di_atas_80pct, jam_data,
       ROUND(arus_puncak_a * arus_puncak_a * r_ohm_km * panjang_km / 1000.0, 3) AS rugi_i2r_puncak_kw,
       ROUND(MAX(0, 0.8 * batas_termal_a - arus_puncak_a) * 1.7320508 * 20.0 * pf, 0) AS ruang_tambah_kw,
       CASE WHEN arus_puncak_a > batas_termal_a THEN 'Melebihi batas termal' WHEN arus_puncak_a > 0.8 * batas_termal_a THEN 'Beban tinggi'
            ELSE 'Normal' END AS status_termal
FROM a
ORDER BY kode_penyulang"""

SQL_KEANDALAN = """-- Keandalan per penyulang per bulan (IEEE 1366, dari SOE SCADA): SAIDI dan SAIFI dari gangguan permanen, MAIFI dari
-- gangguan temporer, CAIDI = SAIDI / SAIFI, energi tidak tersalur (ENS), pelanggan-jam padam, penyebab terbanyak.
WITH b AS (SELECT DISTINCT SUBSTR(tanggal, 1, 7) AS bulan FROM input),
k AS (SELECT f.kode_penyulang, f.kode_gi, f.kode_ulp, f.jumlah_pelanggan, b.bulan FROM penyulang_status f CROSS JOIN b),
g AS (SELECT *, SUBSTR(tanggal, 1, 7) AS bulan FROM input),
c AS (
  SELECT kode_penyulang, bulan, penyebab, ROW_NUMBER() OVER (PARTITION BY kode_penyulang, bulan ORDER BY COUNT(*) DESC, penyebab) AS rk
  FROM g GROUP BY kode_penyulang, bulan, penyebab
)
SELECT k.kode_penyulang || ' · ' || k.bulan AS id_keandalan, k.kode_penyulang, k.kode_gi, k.kode_ulp, k.bulan, k.jumlah_pelanggan,
       k.kode_penyulang || ' · ' || k.bulan || ' · SAIDI ' ||
         ROUND(COALESCE(SUM(CASE WHEN g.jenis = 'Permanen' THEN g.durasi_menit * g.pelanggan_padam END), 0) * 1.0 / NULLIF(k.jumlah_pelanggan, 0), 1) || ' mnt' AS judul,
       COUNT(g.id_gangguan) AS gangguan,
       SUM(CASE WHEN g.jenis = 'Permanen' THEN 1 ELSE 0 END) AS gangguan_permanen,
       SUM(CASE WHEN g.jenis = 'Temporer' THEN 1 ELSE 0 END) AS gangguan_temporer,
       ROUND(COALESCE(SUM(CASE WHEN g.jenis = 'Permanen' THEN g.durasi_menit * g.pelanggan_padam END), 0) * 1.0 / NULLIF(k.jumlah_pelanggan, 0), 3) AS saidi_menit,
       ROUND(COALESCE(SUM(CASE WHEN g.jenis = 'Permanen' THEN g.pelanggan_padam END), 0) * 1.0 / NULLIF(k.jumlah_pelanggan, 0), 4) AS saifi_kali,
       ROUND(COALESCE(SUM(CASE WHEN g.jenis = 'Temporer' THEN g.pelanggan_padam END), 0) * 1.0 / NULLIF(k.jumlah_pelanggan, 0), 4) AS maifi_kali,
       ROUND(SUM(CASE WHEN g.jenis = 'Permanen' THEN g.durasi_menit * g.pelanggan_padam END) * 1.0
             / NULLIF(SUM(CASE WHEN g.jenis = 'Permanen' THEN g.pelanggan_padam END), 0), 1) AS caidi_menit,
       ROUND(COALESCE(SUM(g.kwh_tidak_tersalur), 0), 1) AS ens_kwh,
       ROUND(COALESCE(SUM(g.pelanggan_jam_padam), 0), 1) AS pelanggan_jam_padam,
       COALESCE(MAX(c.penyebab), '-') AS penyebab_dominan
FROM k
LEFT JOIN g ON g.kode_penyulang = k.kode_penyulang AND g.bulan = k.bulan
LEFT JOIN c ON c.kode_penyulang = k.kode_penyulang AND c.bulan = k.bulan AND c.rk = 1
GROUP BY k.kode_penyulang, k.kode_gi, k.kode_ulp, k.bulan, k.jumlah_pelanggan
ORDER BY k.kode_penyulang, k.bulan"""

SQL_RISIKO = """-- Risiko aset operasi — aturan deterministik berbukti, bukan prediksi model. Gardu distribusi: beban maksimum per jam
-- (AMR), durasi overload, suhu minyak, umur trafo, tegangan ujung JTR (SPLN: 220 V −10 % = 198 V), NTL gardu, temuan P1.
-- Penyulang: beban termal, SAIDI 6 bulan, gangguan permanen, susut, jumlah temuan. Skor 0–100 + bukti + rekomendasi.
WITH pk AS (
  SELECT kode_dt, MAX(beban_puncak_pct) AS beban_maks_pct, SUM(jam_overload) AS jam_overload, SUM(jam_beban_tinggi) AS jam_beban_tinggi,
         SUM(CASE WHEN jam_overload > 0 THEN 1 ELSE 0 END) AS hari_overload, MAX(CASE WHEN jam_overload > 0 THEN tanggal END) AS overload_terakhir,
         MAX(CASE WHEN SUBSTR(tanggal, 1, 7) = (SELECT SUBSTR(MAX(tanggal), 1, 7) FROM puncak_harian_gardu) THEN beban_puncak_pct END) AS beban_maks_bulan_akhir_pct
  FROM puncak_harian_gardu GROUP BY kode_dt
),
dt AS (
  SELECT d.kode_dt, d.nama, d.kode_penyulang, d.kode_ulp, d.lokasi, d.kva, d.umur_tahun, d.suhu_minyak_maks_c, d.tegangan_ujung_min_v,
         d.susut_non_teknis_pct, d.susut_pct, d.temuan_p1, d.status_gardu, d.jumlah_pelanggan,
         COALESCE(pk.beban_maks_pct, d.beban_puncak_pct) AS beban_pct, COALESCE(pk.jam_overload, 0) AS jam_overload,
         COALESCE(pk.hari_overload, 0) AS hari_overload, pk.overload_terakhir, pk.beban_maks_bulan_akhir_pct
  FROM input d LEFT JOIN pk ON pk.kode_dt = d.kode_dt
),
sd AS (
  SELECT *,
         CASE WHEN beban_pct > 100 THEN 30 WHEN beban_pct > 80 THEN 15 ELSE 0 END AS s_beban,
         CASE WHEN jam_overload >= 24 THEN 10 WHEN jam_overload > 0 THEN 5 ELSE 0 END AS s_durasi,
         CASE WHEN suhu_minyak_maks_c >= 90 THEN 15 WHEN suhu_minyak_maks_c >= 75 THEN 8 ELSE 0 END AS s_suhu,
         CASE WHEN umur_tahun >= 25 THEN 15 WHEN umur_tahun >= 15 THEN 8 ELSE 0 END AS s_umur,
         CASE WHEN tegangan_ujung_min_v < 198 THEN 10 WHEN tegangan_ujung_min_v < 207 THEN 5 ELSE 0 END AS s_tegangan,
         CASE WHEN susut_non_teknis_pct >= 10 THEN 10 WHEN susut_non_teknis_pct >= 5 THEN 5 ELSE 0 END AS s_ntl,
         CASE WHEN temuan_p1 > 0 THEN 10 ELSE 0 END AS s_temuan
  FROM dt
),
kd AS (
  SELECT kode_penyulang, SUM(saidi_menit) AS saidi_6bln, SUM(saifi_kali) AS saifi_6bln, SUM(gangguan_permanen) AS permanen
  FROM keandalan_penyulang_bulanan GROUP BY kode_penyulang
),
fp AS (
  SELECT f.kode_penyulang, f.nama, f.kode_ulp, f.susut_pct, f.jumlah_temuan, f.jumlah_pelanggan,
         b.beban_termal_pct, COALESCE(kd.saidi_6bln, 0) AS saidi_6bln, COALESCE(kd.saifi_6bln, 0) AS saifi_6bln, COALESCE(kd.permanen, 0) AS permanen,
         CASE WHEN b.beban_termal_pct > 100 THEN 30 WHEN b.beban_termal_pct > 80 THEN 15 WHEN b.beban_termal_pct > 60 THEN 5 ELSE 0 END AS s_termal,
         CASE WHEN COALESCE(kd.saidi_6bln, 0) >= 300 THEN 20 WHEN COALESCE(kd.saidi_6bln, 0) >= 120 THEN 10 ELSE 0 END AS s_saidi,
         CASE WHEN COALESCE(kd.permanen, 0) >= 3 THEN 10 WHEN COALESCE(kd.permanen, 0) >= 1 THEN 5 ELSE 0 END AS s_gangguan,
         CASE WHEN f.susut_pct >= 15 THEN 20 WHEN f.susut_pct >= 10 THEN 10 ELSE 0 END AS s_susut,
         CASE WHEN f.jumlah_temuan >= 10 THEN 10 WHEN f.jumlah_temuan >= 3 THEN 5 ELSE 0 END AS s_temuan
  FROM penyulang_status f
  LEFT JOIN pembebanan_penyulang b ON b.kode_penyulang = f.kode_penyulang
  LEFT JOIN kd ON kd.kode_penyulang = f.kode_penyulang
),
u AS (
  SELECT 'DT:' || kode_dt AS id_risiko, 'Gardu distribusi' AS jenis_aset, kode_dt AS kode_aset, kode_dt, kode_penyulang, kode_ulp, lokasi,
         MIN(100, s_beban + s_durasi + s_suhu + s_umur + s_tegangan + s_ntl + s_temuan) AS skor,
         CASE WHEN s_beban + s_durasi >= MAX(s_suhu, s_umur, s_tegangan, s_ntl, s_temuan) AND s_beban + s_durasi > 0 THEN 'Beban trafo'
              WHEN s_suhu >= MAX(s_umur, s_tegangan, s_ntl, s_temuan) AND s_suhu > 0 THEN 'Suhu minyak'
              WHEN s_umur >= MAX(s_tegangan, s_ntl, s_temuan) AND s_umur > 0 THEN 'Umur trafo'
              WHEN s_tegangan >= MAX(s_ntl, s_temuan) AND s_tegangan > 0 THEN 'Tegangan ujung'
              WHEN s_ntl + s_temuan > 0 THEN 'Susut non-teknis' ELSE 'Tidak ada' END AS faktor_utama,
         RTRIM(CASE WHEN s_beban > 0 THEN 'Beban maks ' || ROUND(beban_pct, 1) || '% kVA terpasang (AMR per jam); ' ELSE '' END ||
               CASE WHEN jam_overload > 0 THEN jam_overload || ' jam overload dalam ' || hari_overload || ' hari, terakhir ' || overload_terakhir || '; ' ELSE '' END ||
               CASE WHEN s_suhu > 0 THEN 'Suhu minyak maks ' || ROUND(suhu_minyak_maks_c, 1) || ' °C; ' ELSE '' END ||
               CASE WHEN s_umur > 0 THEN 'Umur trafo ' || umur_tahun || ' tahun; ' ELSE '' END ||
               CASE WHEN s_tegangan > 0 THEN 'Tegangan ujung JTR min ' || ROUND(tegangan_ujung_min_v, 1) || ' V; ' ELSE '' END ||
               CASE WHEN s_ntl > 0 THEN 'NTL gardu ' || ROUND(susut_non_teknis_pct, 1) || '%; ' ELSE '' END ||
               CASE WHEN s_temuan > 0 THEN temuan_p1 || ' temuan P1; ' ELSE '' END, '; ') AS bukti,
         CASE WHEN beban_pct > 100 THEN 'Sisip / uprating trafo atau pecah beban ke gardu tetangga'
              WHEN s_suhu >= 15 THEN 'Inspeksi termal & uji minyak trafo'
              WHEN tegangan_ujung_min_v < 198 THEN 'Rekonduktor / pecah JTR, sisip gardu'
              WHEN beban_pct > 80 THEN 'Penyeimbangan beban fasa & pantau beban puncak'
              WHEN s_ntl + s_temuan > 0 THEN 'Tindak lanjut temuan susut (P2TL)'
              WHEN s_umur > 0 THEN 'Masukkan ke rencana pemeliharaan / penggantian trafo'
              ELSE 'Pemeliharaan rutin' END AS rekomendasi,
         ROUND(beban_pct, 2) AS beban_pct, jam_overload, umur_tahun, ROUND(suhu_minyak_maks_c, 1) AS suhu_minyak_maks_c,
         ROUND(tegangan_ujung_min_v, 1) AS tegangan_ujung_min_v, ROUND(susut_pct, 2) AS susut_pct, NULL AS saidi_6bln_menit,
         overload_terakhir AS kejadian_terakhir, status_gardu AS status_aset, jumlah_pelanggan
  FROM sd
  UNION ALL
  SELECT 'PNY:' || kode_penyulang, 'Penyulang', kode_penyulang, NULL, kode_penyulang, kode_ulp, NULL,
         MIN(100, s_termal + s_saidi + s_gangguan + s_susut + s_temuan),
         CASE WHEN s_termal >= MAX(s_saidi, s_gangguan, s_susut, s_temuan) AND s_termal > 0 THEN 'Beban termal'
              WHEN s_saidi + s_gangguan >= MAX(s_susut, s_temuan) AND s_saidi + s_gangguan > 0 THEN 'Keandalan'
              WHEN s_susut + s_temuan > 0 THEN 'Susut' ELSE 'Tidak ada' END,
         RTRIM(CASE WHEN s_termal > 0 THEN 'Beban termal puncak ' || ROUND(beban_termal_pct, 1) || '% batas; ' ELSE '' END ||
               CASE WHEN s_saidi > 0 THEN 'SAIDI Apr–Sep ' || ROUND(saidi_6bln, 1) || ' menit; ' ELSE '' END ||
               CASE WHEN s_gangguan > 0 THEN permanen || ' gangguan permanen; ' ELSE '' END ||
               CASE WHEN s_susut > 0 THEN 'Susut ' || ROUND(susut_pct, 1) || '% (Jul–Sep); ' ELSE '' END ||
               CASE WHEN s_temuan > 0 THEN jumlah_temuan || ' temuan susut; ' ELSE '' END, '; '),
         CASE WHEN beban_termal_pct > 100 THEN 'Manuver beban ke penyulang tetangga / tambah penyulang'
              WHEN s_saidi >= 20 THEN 'Evaluasi proteksi, pemangkasan pohon & penambahan recloser/LBS'
              WHEN s_susut >= 20 THEN 'Program penurunan susut penyulang (P2TL terarah + perbaikan teknis)'
              WHEN s_gangguan > 0 THEN 'Patroli & perbaikan titik gangguan berulang'
              WHEN s_temuan > 0 THEN 'Tindak lanjut temuan susut (P2TL)' ELSE 'Pemeliharaan rutin' END,
         ROUND(beban_termal_pct, 2), NULL, NULL, NULL, NULL, ROUND(susut_pct, 2), ROUND(saidi_6bln, 2), NULL, NULL, jumlah_pelanggan
  FROM fp
)
SELECT id_risiko, jenis_aset, kode_aset, jenis_aset || ' ' || kode_aset || ' · risiko ' || skor AS judul, kode_dt, kode_penyulang, kode_ulp, lokasi,
       skor, CASE WHEN skor >= 50 THEN 'Tinggi' WHEN skor >= 25 THEN 'Sedang' ELSE 'Rendah' END AS kelas_risiko,
       faktor_utama, CASE WHEN bukti = '' THEN 'Tidak ada indikator di atas ambang' ELSE bukti END AS bukti, rekomendasi,
       beban_pct, jam_overload, umur_tahun, suhu_minyak_maks_c, tegangan_ujung_min_v, susut_pct, saidi_6bln_menit,
       kejadian_terakhir, status_aset, jumlah_pelanggan
FROM u
ORDER BY skor DESC, id_risiko"""

SQL_ALARM = """-- Alarm operasi terpadu: satu baris per kondisi per aset dari keluaran pipeline — trafo overload / beban tinggi,
-- tegangan ujung di bawah SPLN, kontingensi N-1 GI, beban termal penyulang, gangguan besar (SOE) dan temuan susut P1/P2.
-- Status awal Baru (gangguan yang sudah pulih: Pulih); perubahan status lewat actions Nexus (berriwayat).
SELECT 'ALM-DT-OVL-' || kode_dt AS id_alarm, 'critical' AS severity, 'Beban trafo' AS kategori, 'risiko_aset_operasi' AS sumber_data,
       'Gardu distribusi' AS jenis_aset, kode_dt AS kode_aset, kode_dt, kode_penyulang, kode_ulp,
       'Trafo ' || kode_dt || ' overload ' || ROUND(beban_pct, 1) || '% kVA' AS judul, bukti AS detail,
       beban_pct AS nilai, 100.0 AS ambang, '% kVA' AS satuan, kejadian_terakhir AS waktu, 'Baru' AS status_alarm,
       '' AS ditugaskan_ke, '' AS catatan_operator, rekomendasi
FROM risiko_aset_operasi WHERE jenis_aset = 'Gardu distribusi' AND beban_pct > 100
UNION ALL
SELECT 'ALM-DT-HI-' || kode_dt, 'warning', 'Beban trafo', 'risiko_aset_operasi', 'Gardu distribusi', kode_dt, kode_dt, kode_penyulang, kode_ulp,
       'Trafo ' || kode_dt || ' beban tinggi ' || ROUND(beban_pct, 1) || '% kVA', bukti, beban_pct, 80.0, '% kVA', kejadian_terakhir, 'Baru', '', '', rekomendasi
FROM risiko_aset_operasi WHERE jenis_aset = 'Gardu distribusi' AND beban_pct > 80 AND beban_pct <= 100
UNION ALL
SELECT 'ALM-DT-VLO-' || kode_dt, 'warning', 'Mutu tegangan', 'risiko_aset_operasi', 'Gardu distribusi', kode_dt, kode_dt, kode_penyulang, kode_ulp,
       'Tegangan ujung JTR ' || kode_dt || ' ' || ROUND(tegangan_ujung_min_v, 1) || ' V (< 198 V)', bukti, tegangan_ujung_min_v, 198.0, 'V', NULL, 'Baru', '', '',
       'Rekonduktor / pecah JTR, sisip gardu'
FROM risiko_aset_operasi WHERE jenis_aset = 'Gardu distribusi' AND tegangan_ujung_min_v < 198
UNION ALL
SELECT 'ALM-GI-N1-' || kode_gi, CASE WHEN status_n1 = 'Melanggar N-1' THEN 'critical' ELSE 'warning' END, 'Kontingensi N-1', 'kontingensi_n1_gi',
       'Gardu induk', kode_gi, NULL, NULL, kode_ulp, nama_gi || ': ' || status_n1 || ' (' || ROUND(beban_firm_puncak_pct, 1) || '% kapasitas firm)',
       'Puncak ' || ROUND(puncak_mva, 2) || ' MVA pada ' || waktu_puncak || ' vs firm ' || kapasitas_firm_mva || ' MVA; ' || jam_melanggar_n1 || ' jam melanggar',
       beban_firm_puncak_pct, 90.0, '% firm', waktu_puncak, 'Baru', '', '', rekomendasi
FROM kontingensi_n1_gi WHERE status_n1 <> 'Aman N-1'
UNION ALL
SELECT 'ALM-PNY-TH-' || kode_penyulang, CASE WHEN beban_termal_pct > 100 THEN 'critical' ELSE 'warning' END, 'Beban termal penyulang', 'pembebanan_penyulang',
       'Penyulang', kode_penyulang, NULL, kode_penyulang, kode_ulp,
       'Penyulang ' || kode_penyulang || ' ' || ROUND(beban_termal_pct, 1) || '% batas termal', 'Arus puncak ' || arus_puncak_a || ' A vs batas ' || batas_termal_a || ' A; '
         || jam_di_atas_80pct || ' jam > 80 %', beban_termal_pct, 80.0, '% batas', waktu_puncak, 'Baru', '', '', 'Manuver beban ke penyulang tetangga'
FROM pembebanan_penyulang WHERE beban_termal_pct > 80
UNION ALL
SELECT 'ALM-GGN-' || id_gangguan, CASE WHEN pelanggan_padam >= 1000 OR durasi_menit >= 180 THEN 'critical' ELSE 'warning' END, 'Gangguan penyulang',
       'gangguan_penyulang', 'Penyulang', kode_penyulang, NULL, kode_penyulang, kode_ulp,
       'Gangguan ' || jenis || ' ' || kode_penyulang || ': ' || penyebab,
       peralatan_trip || ' trip, ' || durasi_menit || ' menit, ' || pelanggan_padam || ' pelanggan padam, ENS ' || ROUND(kwh_tidak_tersalur, 1) || ' kWh',
       durasi_menit, 60.0, 'menit', waktu_trip, 'Pulih', '', '', 'Analisis penyebab & patroli jalur'
FROM gangguan_penyulang WHERE jenis = 'Permanen' AND (durasi_menit >= 60 OR pelanggan_padam >= 500)
UNION ALL
SELECT 'ALM-TMN-' || id_temuan, CASE WHEN prioritas = 'P1' THEN 'critical' ELSE 'warning' END,
       CASE WHEN kelompok_susut LIKE 'Teknis%' THEN 'Susut teknis' ELSE 'Susut non-teknis' END, 'temuan_susut',
       jenis_objek, kode_objek, kode_dt, kode_penyulang, kode_ulp, id_temuan || ' · ' || kode_pola_dugaan || ': ' || judul,
       'Skor ' || skor || ', nilai harapan Rp ' || ROUND(nilai_harapan_rp / 1000000.0, 1) || ' jt, status temuan ' || status_temuan,
       skor, 70.0, 'skor', NULL, 'Baru', '', '', 'Tindak lanjut temuan (P2TL / perbaikan teknis)'
FROM temuan_susut WHERE prioritas IN ('P1', 'P2')"""

NODES_SQL = [
    ("t_bgi", "beban_gi_per_jam", "beban", "daya_penyulang_per_jam", SQL_BEBAN_GI),
    ("t_n1", "kontingensi_n1_gi", "beban", "t_bgi", SQL_N1_GI),
    ("t_prof", "profil_beban_penyulang", "beban", "daya_penyulang_per_jam", SQL_PROFIL),
    ("t_bpy", "pembebanan_penyulang", "beban", "daya_penyulang_per_jam", SQL_PEMBEBANAN),
    ("t_kdl", "keandalan_penyulang_bulanan", "keandalan", "gangguan_penyulang", SQL_KEANDALAN),
    ("t_rsk", "risiko_aset_operasi", "risiko", "gardu_distribusi_status", SQL_RISIKO),
    ("t_alm", "alarm_operasi", "alarm", "t_rsk", SQL_ALARM),
]
OUTPUTS = ["beban_gi_per_jam", "kontingensi_n1_gi", "profil_beban_penyulang", "pembebanan_penyulang", "keandalan_penyulang_bulanan",
           "risiko_aset_operasi", "alarm_operasi"]
GROUPS = [("sumber", "Keluaran pipeline hulu", "#64748b"), ("beban", "Beban & kontingensi", "#0ea5e9"),
          ("keandalan", "Keandalan (IEEE 1366)", "#22c55e"), ("risiko", "Risiko aset", "#f97316"), ("alarm", "Alarm operasi", "#dc2626")]
EXPECT = {"beban_gi_per_jam": [("unique", ["id_beban"])], "kontingensi_n1_gi": [("unique", ["kode_gi"]), ("notNull", ["status_n1"])],
          "profil_beban_penyulang": [("unique", ["id_profil"])], "pembebanan_penyulang": [("unique", ["kode_penyulang"]), ("notNull", ["batas_termal_a"])],
          "keandalan_penyulang_bulanan": [("unique", ["id_keandalan"])], "risiko_aset_operasi": [("unique", ["id_risiko"]), ("notNull", ["skor"])],
          "alarm_operasi": [("unique", ["id_alarm"]), ("oneOf", ("severity", ["critical", "warning", "info"]))]}


def spec() -> list[dict]:
    """The pipeline as nodes (sources by dataset name, SQL transforms) — the same list drives the emulation."""
    by_name = {n: f"s_{i}" for i, (n, _, _) in enumerate(SOURCES)}
    nodes = [{"id": f"s_{i}", "kind": "source", "name": n, "group": "sumber", "doc": d} for i, (n, _, d) in enumerate(SOURCES)]
    for nid, name, group, inp, sql in NODES_SQL:
        nodes.append({"id": nid, "kind": "sql", "name": name, "group": group, "input": by_name.get(inp, inp), "sql": sql})
    return nodes


def _rows_of(item_id: str) -> list[dict]:
    """A dataset's current rows (parquet in Files) — the real data the pipeline reads, not a regenerated copy."""
    from datetime import date

    import pyarrow.parquet as pq

    import drive

    rows = pq.read_table(io.BytesIO(drive.read_bytes(drive._item(item_id)))).to_pylist()
    # date/timestamp columns as ISO text, the way the SQL step and the pipeline file's previews see them
    for r in rows:
        for k, v in r.items():
            if isinstance(v, date):
                r[k] = v.isoformat()
    return rows


def _source_items() -> dict[str, str]:
    import drive

    e = _e()
    project = e._folder(None, e.PROJECT, "project")
    out = {}
    for name, folder, _ in SOURCES:
        fid = e._folder(project, folder)
        hit = next((f for f in drive.list_files(fid) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)
        if not hit:
            raise RuntimeError(f"sumber {folder}/{name} belum ada — bangun pipeline hulunya dulu")
        out[name] = hit["id"]
    return out


def emulate(sources: dict[str, list[dict]]) -> dict[str, list[dict]]:
    import demo_jkn_pipeline as base

    rows = base.run(sources, spec())
    return {name: rows[name] for name in OUTPUTS}


def _content(items: dict[str, str], previews: dict[str, list[dict]], folder: str) -> tuple[dict, dict[str, str]]:
    import demo_grid_pipeline as gp
    import demo_jkn_pipeline as base

    e = _e()
    now = datetime.now(timezone.utc).isoformat()
    uid = lambda: uuid.uuid4().hex[:8]  # noqa: E731
    ns = spec()
    pos = gp.layout(ns, GROUPS)
    datasets, nodes = {}, []
    for n in ns:
        x, y = pos[n["id"]]
        b = {"id": n["id"], "name": n["name"], "x": x, "y": y, "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            src_folder = next(f for nm, f, _ in SOURCES if nm == n["name"])
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {e.PROJECT} / {src_folder} / {n['name']}.parquet", "createdAt": now,
                            "refreshedAt": now, "columns": [{"name": c, "type": t} for c, t in base.schema_of(rows)], "rows": rows[:100],
                            "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            nodes.append({**b, "kind": "source", "datasetId": ds, "description": n["doc"]})
        else:
            nodes.append({**b, "kind": "transform", "input": n["input"], "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}]})
    location = {"id": folder, "name": f"{e.PROJECT} / {FOLDER}"}
    by = {n["name"]: n["id"] for n in ns}
    xmax = max(x for x, _ in pos.values())
    out_ids = {name: f"o_{by[name]}" for name in OUTPUTS}

    def expectations(name: str) -> list[dict]:
        out = [{"id": uid(), "kind": "rowCount", "min": 1}]
        for kind, arg in EXPECT.get(name, []):
            if kind in ("unique", "notNull"):
                out.append({"id": uid(), "kind": kind, "columns": arg})
            else:
                out.append({"id": uid(), "kind": "oneOf", "column": arg[0], "values": arg[1]})
        return out

    outputs = [{"id": out_ids[name], "name": name, "node": by[name], "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": expectations(name), "x": xmax + 320, "y": pos[by[name]][1]} for name in OUTPUTS]
    notes = [
        ("lg-sumber", "1 · SUMBER — keluaran pipeline aset (GI, penyulang dengan KHA GIS), susut (penyulang/gardu berstatus, gangguan SOE, "
                      "temuan) dan beban per jam (daya penyulang SCADA, puncak harian gardu AMR). Tidak membaca data mentah."),
        ("lg-beban", "2 · BEBAN & KONTINGENSI — beban GI per jam dan N-1 trafo daya (kapasitas firm = kapasitas × (n−1)/n); arus penyulang "
                     "I = P/(√3·20 kV·PF) vs min(KHA, PMT 630 A); kurva beban harian."),
        ("lg-risiko", "3 · KEANDALAN, RISIKO, ALARM — IEEE 1366 per bulan; skor risiko aturan berbukti per gardu & penyulang; alarm "
                      "terpadu ke Nexus (status lewat actions, berriwayat). Bukan prediksi; read-only ke SCADA."),
    ]
    body = {"type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes, "outputs": outputs,
            "legend": [{"id": f"lg-{g}", "name": nm, "hex": h} for g, nm, h in GROUPS], "location": location,
            "textNodes": [{"id": f"note_{i + 1}", "x": 40 + i * 600, "y": -230, "w": 560, "h": 160, "color": c, "text": t} for i, (c, t) in enumerate(notes)],
            "schedules": [e._schedule("operasi", list(out_ids.values()))],
            "meta": {"version": VERSION, "description": "Demo: analitik operasi jaringan untuk PLN Grid Monitoring Cockpit — beban GI & N-1, "
                                                        "pembebanan termal penyulang, keandalan IEEE 1366, risiko aset dan alarm operasi."}}
    return body, out_ids


def _ensure_pipeline(st: dict, folder: str) -> dict:
    import drive
    import pipeline_datasets
    import pipeline_runtime as rt

    e = _e()
    items = _source_items()
    sources = {name: _rows_of(iid) for name, iid in items.items()}
    results = emulate(sources)
    out: dict[str, Any] = {"rows": {k: len(v) for k, v in results.items()}}
    # first load: the emulation writes the outputs (the Nexus reads them right away); the pipeline owns them afterwards
    ids = {name: e._put(folder, name, rows, replace=False) for name, rows in results.items()}
    project = e._folder(None, e.PROJECT, "project")
    pid = st.get("pipeline_id")
    current = None
    if pid:
        try:
            current = json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(pid)))
        except Exception:  # noqa: BLE001
            current, pid = None, None
    created = False
    if not pid or (current.get("meta") or {}).get("version") != VERSION:
        body, out_ids = _content(items, sources, folder)
        if pid:
            body["createdAt"] = current.get("createdAt") or body["createdAt"]
            pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=body))
        else:
            pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))["id"]
            created = True
        st.update(pipeline_id=pid, output_ids=out_ids)
    for name, oid in (st.get("output_ids") or {}).items():
        if not rt.get_state(pid, f"output:{oid}"):
            rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": folder, "version": 0, "rows": len(results[name]),
                                                "path": f"{e.PROJECT} / {FOLDER} / {name}.parquet"})
    st.update(datasets=ids, sources=items)
    if created or not any(b["status"] in ("queued", "running", "succeeded") for b in rt._builds(pid, 5)):
        try:
            out["build"] = rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="demo"))["id"]
        except Exception as ex:  # noqa: BLE001
            out["build_error"] = str(getattr(ex, "detail", ex))[:300]
    out["pipeline_id"] = pid
    return out


# ------------------------------------------------------------------------------------------------
# 2 · analisis topologi struktural (transform Python Code Repository) — satu sumber kode untuk transform & emulasi
# ------------------------------------------------------------------------------------------------

def analisis_struktural(saluran: list, gardu: list, pembangkit: list, kelas_min: int = 70) -> tuple:
    """N-1 struktural jaringan transmisi OSM: ruas (way) dirangkai menjadi koridor gardu-ke-gardu (simpul derajat dua
    tanpa gardu diciutkan), lalu jembatan graf (Tarjan, multigraf: koridor paralel bukan jembatan) = koridor yang bila
    lepas memisahkan jaringan, dan titik artikulasi = gardu yang bila lepas memisahkan jaringan. Untuk tiap koridor
    kritis dihitung sisi yang terpisah: gardu, pembangkit dan MW (tag kapasitas OSM). Tanpa rating/impedansi: ini
    konektivitas, bukan aliran daya. Satu way OSM bisa memuat dua sirkuit (tag circuits tidak tersedia)."""
    import json as _j
    import math
    from collections import Counter, defaultdict

    def num(v, d=0.0):
        try:
            x = float(v)
            return d if math.isnan(x) else x
        except (TypeError, ValueError):
            return d

    def txt(v):
        return v if isinstance(v, str) and v else None

    titik = {}
    for r in gardu:
        titik[r["osm_id"]] = {"nama": txt(r.get("nama")) or r["osm_id"], "jenis": "Gardu", "kelas_kv": int(num(r.get("kelas_kv"))), "mw": 0.0}
    for r in pembangkit:
        titik[r["osm_id"]] = {"nama": txt(r.get("nama")) or r["osm_id"], "jenis": "Pembangkit", "kelas_kv": int(num(r.get("kelas_kv"))),
                              "mw": num(r.get("kapasitas_mw"))}

    def simpul(r, sisi, pt):
        g = txt(r.get(f"gardu_ujung_{sisi}"))
        if g and g in titik:
            return g
        return f"x:{round(pt[0] / 0.004)}:{round(pt[1] / 0.004)}"

    edges, geom = [], {}
    for r in saluran:
        kv = int(num(r.get("kelas_kv")))
        if kv < kelas_min or not txt(r.get("geometri")):
            continue
        cs = _j.loads(r["geometri"])["coordinates"]
        a, b = simpul(r, "a", cs[0]), simpul(r, "b", cs[-1])
        if a == b:
            continue
        geom[r["osm_id"]] = cs
        edges.append((a, b, r["osm_id"], kv, num(r.get("panjang_km")), txt(r.get("nama")) or ""))
    adj = defaultdict(list)
    for i, e in enumerate(edges):
        adj[e[0]].append(i)
        adj[e[1]].append(i)
    used = [False] * len(edges)
    koridor = []
    for i in range(len(edges)):
        if used[i]:
            continue
        used[i] = True
        chain, ends = [i], []
        for start in (edges[i][0], edges[i][1]):
            cur, prev = start, i
            while cur not in titik and len(adj[cur]) == 2:
                nxt = adj[cur][0] if adj[cur][1] == prev else adj[cur][1]
                if used[nxt]:
                    break
                used[nxt] = True
                chain.append(nxt)
                e = edges[nxt]
                cur = e[1] if e[0] == cur else e[0]
                prev = nxt
            ends.append(cur)
        if ends[0] == ends[1]:
            continue
        ways = sorted(edges[k][2] for k in chain)
        koridor.append({"u": ends[0], "v": ends[1], "ways": ways, "kelas_kv": Counter(edges[k][3] for k in chain).most_common(1)[0][0],
                        "panjang_km": round(sum(edges[k][4] for k in chain), 2),
                        "nama": next((edges[k][5] for k in chain if edges[k][5] and "tanpa nama" not in edges[k][5]), "")})
    g = defaultdict(list)
    for i, k in enumerate(koridor):
        g[k["u"]].append((k["v"], i))
        g[k["v"]].append((k["u"], i))
    nodes = list(g)
    comp, cid = {}, 0
    for n in nodes:
        if n in comp:
            continue
        comp[n] = cid
        st = [n]
        while st:
            x = st.pop()
            for y, _ in g[x]:
                if y not in comp:
                    comp[y] = cid
                    st.append(y)
        cid += 1
    size = Counter(comp.values())
    main = size.most_common(1)[0][0] if size else -1
    disc, low, parent = {}, {}, {}
    bridges, art = set(), set()
    timer = 0
    for root in nodes:
        if root in disc:
            continue
        disc[root] = low[root] = timer
        timer += 1
        kids = 0
        stack = [(root, -1, iter(g[root]))]
        while stack:
            x, pe, it = stack[-1]
            moved = False
            for y, eid in it:
                if eid == pe:
                    continue
                if y not in disc:
                    disc[y] = low[y] = timer
                    timer += 1
                    parent[y] = x
                    if x == root:
                        kids += 1
                    stack.append((y, eid, iter(g[y])))
                    moved = True
                    break
                low[x] = min(low[x], disc[y])
            if moved:
                continue
            stack.pop()
            if stack:
                p = stack[-1][0]
                low[p] = min(low[p], low[x])
                if low[x] > disc[p]:
                    bridges.add(pe)
                if p != root and low[x] >= disc[p]:
                    art.add(p)
        if kids > 1:
            art.add(root)
    members = defaultdict(list)
    for n in nodes:
        members[comp[n]].append(n)

    def side(start, banned):
        seen = {start}
        st = [start]
        while st:
            x = st.pop()
            for y, eid in g[x]:
                if eid != banned and y not in seen:
                    seen.add(y)
                    st.append(y)
        return seen

    def nama(n):
        return titik[n]["nama"] if n in titik else "simpul tanpa gardu"

    rows_k = []
    for i, k in enumerate(koridor):
        kritis = i in bridges
        cut = set()
        if kritis:
            a = side(k["u"], i)
            b = set(members[comp[k["u"]]]) - a
            cut = a if len(a) <= len(b) else b
        mw = round(sum(titik[n]["mw"] for n in cut if n in titik), 1)
        n_gardu = sum(1 for n in cut if n in titik and titik[n]["jenis"] == "Gardu")
        n_pemb = sum(1 for n in cut if n in titik and titik[n]["jenis"] == "Pembangkit")
        label = k["nama"] or f"{nama(k['u'])} – {nama(k['v'])}"
        rows_k.append({
            "id_koridor": f"KOR-{k['ways'][0]}", "judul": f"{k['kelas_kv']} kV · {label}" + (" · KRITIS N-1" if kritis else ""),
            "nama": label, "kelas_kv": int(k["kelas_kv"]), "panjang_km": float(k["panjang_km"]), "jumlah_ruas": len(k["ways"]),
            "ruas_osm": ", ".join(k["ways"]), "simpul_a": k["u"] if k["u"] in titik else "", "nama_simpul_a": nama(k["u"]),
            "simpul_b": k["v"] if k["v"] in titik else "", "nama_simpul_b": nama(k["v"]),
            "komponen_utama": comp[k["u"]] == main, "kritis_n1": kritis,
            "simpul_terisolasi": len(cut), "gardu_terisolasi": n_gardu, "pembangkit_terisolasi": n_pemb, "mw_terisolasi": float(mw),
            "contoh_terisolasi": "; ".join(sorted(nama(n) for n in cut if n in titik)[:8]),
            "dampak": (f"Lepas → {n_gardu} gardu & {n_pemb} pembangkit ({mw:g} MW) terpisah dari jaringan" if kritis and (n_gardu or n_pemb)
                       else "Lepas → hanya ujung tanpa gardu terpisah" if kritis else "Ada jalur alternatif (bukan jembatan)"),
            "geometri": _j.dumps({"type": "MultiLineString", "coordinates": [geom[w] for w in k["ways"]]}),
        })
    rows_s = []
    for n in nodes:
        if n not in titik:
            continue
        nb = {y for y, _ in g[n]}
        n_kritis = sum(1 for _, eid in g[n] if eid in bridges)
        rows_s.append({"osm_id": n, "nama": titik[n]["nama"], "jenis": titik[n]["jenis"], "kelas_kv": titik[n]["kelas_kv"],
                       "kapasitas_mw": float(titik[n]["mw"]), "koridor": len(g[n]), "tetangga": len(nb), "koridor_kritis": n_kritis,
                       "titik_artikulasi": n in art, "komponen_utama": comp[n] == main,
                       "redundansi": ("Radial (1 koridor)" if len(g[n]) == 1 else "Titik artikulasi" if n in art
                                      else "Bergantung koridor kritis" if n_kritis else "Redundan (≥2 jalur)")})
    stats = {"ruas_dipakai": len(edges), "koridor": len(koridor), "koridor_kritis": len(bridges), "titik_artikulasi": len(art),
             "komponen": len(size), "simpul": len(nodes), "simpul_komponen_utama": size.get(main, 0),
             "gardu_radial": sum(1 for r in rows_s if r["koridor"] == 1)}
    return rows_k, rows_s, stats


TRANSFORM = '''from transforms.api import transform, Input, Output
import pandas as pd


@transform.using(
    saluran=Input("{base}/raw/konteks/saluran_gabungan_osm"),
    gardu=Input("{base}/raw/konteks/gardu_gabungan_osm"),
    pembangkit=Input("{base}/raw/konteks/pembangkit_gabungan_osm"),
    koridor=Output("{base}/{folder}/koridor_transmisi_n1"),
    simpul=Output("{base}/{folder}/simpul_transmisi_struktural"),
)
def topologi_struktural(saluran, gardu, pembangkit, koridor, simpul):
    """N-1 struktural jaringan transmisi Jawa–Bali (OpenStreetMap, riil): koridor gardu-ke-gardu, koridor kritis
    (jembatan graf), titik artikulasi, gardu & MW yang terisolasi. Konektivitas, bukan aliran daya."""
    rec = lambda df: df.astype(object).where(df.notna(), None).to_dict("records")
    k, s, _ = analisis_struktural(rec(saluran.pandas()), rec(gardu.pandas()), rec(pembangkit.pandas()))
    koridor.write_pandas(pd.DataFrame(k))
    simpul.write_pandas(pd.DataFrame(s))


{algo}'''


def _topologi(st: dict, folder: str) -> dict:
    """The Code Repository transform builds both outputs; if the build cannot run here, the same code writes them."""
    import code_repos
    import drive

    import demo_grid_peta_gabungan as pg

    e = _e()
    out: dict[str, Any] = {}
    algo = inspect.getsource(analisis_struktural)
    src = TRANSFORM.format(base=f"/{e.PROJECT}", folder=FOLDER, algo=algo)
    repo = next((r for r in code_repos.list_repos() if r["name"] == REPO), None)
    if not repo:
        repo = code_repos.create_repo(code_repos.RepoIn(name=REPO, template="python",
                                                        description="Demo: N-1 struktural jaringan transmisi Jawa–Bali (OSM riil) — koridor kritis, titik artikulasi."))
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    files = dict(b["files"])
    main = next((p for p in sorted(files) if p.endswith(".py") and "/src/" in p and not p.endswith("__init__.py") and "test" not in p), None)
    path = f"{main.rsplit('/', 1)[0] if main else 'transforms-python/src/myproject/datasets'}/topologi_struktural.py"
    digest = hashlib.sha256(src.encode()).hexdigest()[:12]
    if files.get(path) != src:
        files[path] = src
        code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
        code_repos.commit(repo["id"], code_repos.CommitIn(message="N-1 struktural transmisi: koridor, jembatan graf, titik artikulasi"))
        st.pop("topologi_built", None)
    st["repo_id"] = repo["id"]
    status = st.get("topologi_built")
    if st.get("topologi_digest") != digest or status not in ("succeeded", "written"):
        rec = code_repos._repo(repo["id"])
        b = code_repos._branch(rec, None)
        try:
            built = code_repos.build_transform(rec, b["files"], b["name"], f"{path}::topologi_struktural", "demo", b.get("head"))
            status = built["status"]
            if status != "succeeded":
                out["transform_error"] = (built.get("error") or "")[-800:]
        except Exception as ex:  # noqa: BLE001
            status, out["transform_error"] = "failed", str(ex)[:800]
        if status != "succeeded":
            saluran, gardu, pemb = pg._saluran_gabungan(), pg._gardu_gabungan(), pg._pembangkit_gabungan()
            pg._koneksi(saluran, gardu + pemb)
            k, s, _ = analisis_struktural(saluran, gardu, pemb)
            e._put(folder, "koridor_transmisi_n1", k)
            e._put(folder, "simpul_transmisi_struktural", s)
            status = "written"
        st.update(topologi_built=status, topologi_digest=digest)
    items = {f["name"].removesuffix(".parquet"): f["id"] for f in drive.list_files(folder) if not f.get("trashed_at")}
    st.setdefault("datasets", {}).update({k: items[k] for k in ("koridor_transmisi_n1", "simpul_transmisi_struktural") if k in items})
    rows = _rows_of(items["koridor_transmisi_n1"])
    st["topologi_stats"] = {"koridor": len(rows), "koridor_kritis": sum(1 for r in rows if r.get("kritis_n1")),
                            "mw_berisiko": round(sum(float(r.get("mw_terisolasi") or 0) for r in rows if r.get("kritis_n1")), 1)}
    out.update(transform={"repo": repo["id"], "status": status}, stats=st["topologi_stats"])
    return out


# ------------------------------------------------------------------------------------------------
# 3 · Nexus: tipe, tautan, riwayat, kebijakan baris, actions
# ------------------------------------------------------------------------------------------------

# key → (display name, api name, pk, title, dataset name, icon, color, description, geo {col: type}, per-ULP policy)
TYPES: dict[str, tuple] = {
    "alarm": ("Grid Operations Alarm (demo)", "AlarmOperasiGridDemo", "id_alarm", "judul", "alarm_operasi", "bell", "#dc2626",
              "Demo: alarm operasi terpadu dari pipeline analitik operasi — beban trafo, mutu tegangan, N-1 GI, termal penyulang, gangguan besar, "
              "temuan susut P1/P2. Status lewat actions (akui/tugaskan/selesaikan) dengan riwayat edit.", {}, True),
    "risiko": ("Grid Operational Asset Risk (demo)", "RisikoAsetOperasiGridDemo", "id_risiko", "judul", "risiko_aset_operasi", "shield", "#f97316",
               "Demo: skor risiko aturan deterministik per gardu distribusi dan penyulang (beban, suhu, umur, tegangan, keandalan, susut) dengan bukti "
               "dan rekomendasi — bukan prediksi model.", {"lokasi": "geopoint"}, True),
    "n1_gi": ("Grid Primary Substation N-1 Contingency (demo)", "KontingensiN1GarduIndukGridDemo", "kode_gi", "judul", "kontingensi_n1_gi", "bolt", "#0ea5e9",
              "Demo: N-1 trafo daya gardu induk — puncak beban koinsiden vs kapasitas firm (satu trafo keluar), jam melanggar, margin, rekomendasi.",
              {}, True),
    "pembebanan": ("Grid Feeder Loading (demo)", "PembebananPenyulangGridDemo", "kode_penyulang", "judul", "pembebanan_penyulang", "gauge",
                   "#14b8a6", "Demo: pembebanan termal penyulang — arus puncak dari daya SCADA per jam vs min(KHA penghantar, PMT 630 A), faktor beban, "
                   "rugi I²R puncak, ruang tambah beban.", {}, True),
    "keandalan": ("Grid Monthly Feeder Reliability (demo)", "KeandalanPenyulangBulananGridDemo", "id_keandalan", "judul", "keandalan_penyulang_bulanan",
                  "activity", "#22c55e", "Demo: keandalan per penyulang per bulan (IEEE 1366) — SAIDI, SAIFI, MAIFI, CAIDI, ENS, penyebab terbanyak.", {}, True),
    "koridor": ("Transmission Branch N-1 (OSM, analysis)", "KoridorTransmisiN1Osm", "id_koridor", "judul", "koridor_transmisi_n1", "route", "#b4123a",
                "Analisis struktural atas jaringan transmisi Jawa–Bali OpenStreetMap (riil, ODbL): koridor gardu-ke-gardu; kritis N-1 = jembatan graf "
                "(lepasnya memisahkan jaringan) dengan gardu & MW pembangkit yang terisolasi. Konektivitas, bukan aliran daya — tanpa angka demo.",
                {"geometri": "geoshape"}, False),
    "simpul": ("Transmission Bus (OSM, analysis)", "SimpulTransmisiStrukturalOsm", "osm_id", "nama", "simpul_transmisi_struktural", "bolt",
               "#1e293b", "Analisis struktural gardu/pembangkit OSM Jawa–Bali: jumlah koridor, tetangga, koridor kritis, titik artikulasi, redundansi.",
               {}, False),
}
LABELS = {
    "id_alarm": "ID alarm", "severity": "Severity", "kategori": "Kategori", "sumber_data": "Sumber data (dataset)", "jenis_aset": "Jenis aset",
    "kode_aset": "Kode aset", "judul": "Judul", "detail": "Detail", "nilai": "Nilai", "ambang": "Ambang", "satuan": "Satuan", "waktu": "Waktu kejadian",
    "status_alarm": "Status alarm", "ditugaskan_ke": "Ditugaskan ke", "catatan_operator": "Catatan operator", "rekomendasi": "Rekomendasi",
    "skor": "Skor risiko", "kelas_risiko": "Kelas risiko", "faktor_utama": "Faktor utama", "bukti": "Bukti", "status_n1": "Status N-1",
    "kritis_n1": "Kritis N-1 (struktural)", "mw_terisolasi": "MW pembangkit terisolasi", "titik_artikulasi": "Titik artikulasi",
    "beban_termal_pct": "Beban termal (%)", "saidi_menit": "SAIDI (menit)", "saifi_kali": "SAIFI (kali)", "kode_ulp": "ULP",
}
SEARCH = {"id_alarm", "judul", "kode_aset", "kode_dt", "kode_penyulang", "id_risiko", "kode_gi", "id_keandalan", "id_koridor", "nama", "osm_id"}
SELECT = {"severity", "kategori", "jenis_aset", "status_alarm", "kode_ulp", "kelas_risiko", "faktor_utama", "status_n1", "status_termal",
          "bulan", "kelas_kv", "kritis_n1", "jenis", "redundansi", "titik_artikulasi", "penyebab_dominan"}
# links: (name, source key, fk, target (own key or e2e key or display name), source label, target label, cardinality)
# many_to_one: many sources hold one target's key (seen from the target: one-to-many); one_to_one: the key is also the
# source's primary key (one analysis row per asset)
LINKS = [
    ("Operations alarm on feeder (grid demo)", "alarm", "kode_penyulang", "e:penyulang", "Alarm operasi", "Penyulang", "many_to_one"),
    ("Operations alarm at substation (grid demo)", "alarm", "kode_dt", "e:gardu", "Alarm operasi", "Gardu distribusi", "many_to_one"),
    ("Substation asset risk (grid demo)", "risiko", "kode_dt", "e:gardu", "Risiko aset", "Gardu distribusi", "many_to_one"),
    ("Feeder asset risk (grid demo)", "risiko", "kode_penyulang", "e:penyulang", "Risiko aset", "Penyulang", "many_to_one"),
    ("Primary substation N-1 contingency (grid demo)", "n1_gi", "kode_gi", "e:gi", "Kontingensi N-1", "Gardu induk", "one_to_one"),
    ("Feeder thermal loading (grid demo)", "pembebanan", "kode_penyulang", "e:penyulang", "Pembebanan termal", "Penyulang", "one_to_one"),
    ("Feeder monthly reliability (grid demo)", "keandalan", "kode_penyulang", "e:penyulang", "Keandalan bulanan", "Penyulang", "many_to_one"),
    ("Branch from-bus (OSM, analysis)", "koridor", "simpul_a", "simpul", "Koridor (ujung A)", "Simpul ujung A", "many_to_one"),
    ("Branch to-bus (OSM, analysis)", "koridor", "simpul_b", "simpul", "Koridor (ujung B)", "Simpul ujung B", "many_to_one"),
    ("Bus of OSM substation", "simpul", "osm_id", "n:Substation Java-Bali Combined (OSM)", "Analisis struktural", "Gardu OSM", "one_to_one"),
]
# many-to-many (join table): every corridor touches two nodes, every node lies on many corridors
M2M = ("Branch ↔ connected bus (OSM, analysis)", "koridor", "simpul", "Koridor terhubung", "Simpul terhubung")
# actions: (name, type key or display name, description, [(param, label, required)])
ALARM_ACTIONS = {
    "acknowledge": ("Akui alarm operasi (demo)", "Operator mengakui alarm (status Diakui) dengan catatan.",
                    [("status_alarm", "Status (Diakui)", True), ("catatan_operator", "Catatan", False)]),
    "assign": ("Tugaskan alarm operasi (demo)", "Tugaskan alarm ke tim/petugas (status Ditugaskan) dengan catatan.",
               [("status_alarm", "Status (Ditugaskan)", True), ("ditugaskan_ke", "Ditugaskan ke", True), ("catatan_operator", "Catatan", False)]),
    "resolve": ("Selesaikan alarm operasi (demo)", "Tutup alarm setelah ditangani (status Selesai) dengan catatan penyelesaian.",
                [("status_alarm", "Status (Selesai)", True), ("catatan_operator", "Catatan penyelesaian", False)]),
    "reopen": ("Buka ulang alarm operasi (demo)", "Buka kembali alarm yang sudah selesai/diakui (status Baru).",
               [("status_alarm", "Status (Baru)", True), ("catatan_operator", "Alasan", False)]),
}
PERISTIWA = "AMI Event (demo)"
PERISTIWA_ACTION = ("Tetapkan status peristiwa AMI (demo)", "Operator menetapkan status dugaan bypass AMI (Diakui, Ditugaskan, Selesai, Baru) "
                    "dengan petugas dan catatan.",
                    [("status_peristiwa", "Status", True), ("ditugaskan_ke", "Ditugaskan ke", False), ("catatan_operator", "Catatan", False)])
PERINTAH_ACTION = ("Ubah status perintah kerja (demo)", "Status pelaksanaan perintah kerja teknis (Terbuka, Dikerjakan, Ditunda, Selesai) dan pelaksananya.",
                   [("status_pekerjaan", "Status pekerjaan", True), ("pelaksana", "Pelaksana", False)])


def _type_by_name(name: str) -> Optional[dict]:
    import ontology

    return next((t for t in ontology._all("object-types") if t["display_name"] == name), None)


def type_of(key: str) -> Optional[dict]:
    return _type_by_name(TYPES[key][0]) if key in TYPES else None


def _ensure_types(st: dict) -> dict:
    import demo_jkn_pipeline as base
    import ontology
    import ontology_datasources as ods

    e = _e()
    made, attached = [], []
    ds = st.get("datasets") or {}
    for key, (name, api, pk, title, dname, icon, color, desc, geo, _pol) in TYPES.items():
        item = ds.get(dname)
        if not item:
            continue
        t = _type_by_name(name)
        if not t:
            rows = _rows_of(item)
            props = []
            for c, ty in base.schema_of(rows):
                hints = (["searchable"] if c in SEARCH else []) + (["selectable"] if c in SELECT else []) + (["identifier"] if c == pk else []) + \
                        (["long_text"] if c in ("bukti", "detail", "rekomendasi", "contoh_terisolasi", "ruas_osm") else [])
                props.append(ontology.Property(api_name=c, display_name=LABELS.get(c, c.replace("_", " ").capitalize()),
                                               type=geo.get(c) or e.PTYPE[ty], description="", **({"render_hints": hints} if hints else {})))
            t = ontology.create_object_type(ontology.ObjectTypeIn(display_name=name, plural_name=name, api_name=api, primary_key=pk, title_property=title,
                                                                  icon=icon, color=color, description=desc, properties=props))
            made.append(name)
        if (ontology._object_type(t["id"]).get("backing_dataset") or {}).get("dataset_id") != item:
            r = ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=item, columns=None, map_unmapped=True))
            attached.append(f"{name}: {r.get('imported')}")
    return {"made": made, "attached": attached}


def _ensure_links() -> list[str]:
    import ontology
    import ontology_model as om

    e = _e()
    have = {x.get("display_name"): x for x in ontology._all("link-types")}
    made = []
    for name, src, fk, tgt, sl, tl, card in LINKS:
        if name in have:
            if have[name].get("cardinality") != card:
                om.update_link_type(have[name]["id"], om.LinkTypeIn(cardinality=card))
                made.append(f"{name}: {card}")
            continue
        s = type_of(src)
        t = e._type(tgt[2:]) if tgt.startswith("e:") else _type_by_name(tgt[2:]) if tgt.startswith("n:") else type_of(tgt)
        if not s or not t:
            continue
        om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality=card, foreign_key=fk,
                                          source=om.LinkSide(object_type_id=s["id"], display_name=sl, plural_display_name=sl),
                                          target=om.LinkSide(object_type_id=t["id"], display_name=tl)))
        made.append(name)
    # the many-to-many relation, its pairs written from the corridors' two end nodes (the join table is the link store)
    name, src, tgt, sl, tl = M2M
    s, t = type_of(src), type_of(tgt)
    if s and t:
        lt = have.get(name) or om.create_link_type(om.LinkTypeIn(
            display_name=name, kind="join_table", cardinality="many_to_many",
            description="Koridor transmisi dan simpul (gardu/pembangkit OSM) di kedua ujungnya: satu koridor dua simpul, satu simpul banyak koridor.",
            source=om.LinkSide(object_type_id=s["id"], display_name=sl, plural_display_name=sl),
            target=om.LinkSide(object_type_id=t["id"], display_name=tl, plural_display_name=tl)))
        simpul = set(ontology._objects(t["id"]))
        pairs = sorted({(pk, str(v)) for pk, o in ontology._objects(s["id"]).items() for v in
                        ((o.get("properties") or {}).get("simpul_a"), (o.get("properties") or {}).get("simpul_b")) if v and str(v) in simpul})
        path = ontology.DIR / "links" / f"{lt['id']}.json"
        if [tuple(p) for p in (om._read(path, []) or [])] != pairs:
            with om._lock:
                om._write(path, [list(p) for p in pairs])
            made.append(f"{name}: {len(pairs)} pasangan")
    return made


def _ensure_props(t: dict, props: list[tuple[str, str, str]]) -> list[str]:
    """Edit-only properties the cockpit's actions write on a type that has none for them (e.g. Peristiwa AMI)."""
    import ontology

    added = []
    with ontology._lock:
        rec = ontology._object_type(t["id"])
        new = [(a, lbl, ty) for a, lbl, ty in props if not any(p["api_name"] == a for p in rec["properties"])]
        if new:
            rec["properties"] += [{"api_name": a, "display_name": lbl, "type": ty, "description": "Diisi lewat action cockpit operasi.", "edit_only": True}
                                  for a, lbl, ty in new]
            ontology._put("object-types", rec)
            added = [a for a, _, _ in new]
    return added


def _action(name: str) -> Optional[dict]:
    import ontology

    return next((a for a in ontology._all("action-types") if a["display_name"] == name), None)


def _ensure_action(name: str, t: dict, desc: str, params: list[tuple[str, str, bool]]) -> Optional[str]:
    import ontology

    if _action(name):
        return None
    props = {p["api_name"]: p for p in ontology._object_type(t["id"])["properties"]}
    ontology.create_action_type(ontology.ActionTypeIn(
        display_name=name, object_type_id=t["id"], kind="modify", status="active", description=desc,
        parameters=[ontology.Parameter(id="object", display_name="Objek", type="object", required=True)] +
                   [ontology.Parameter(id=pid, display_name=lbl, type=props[pid]["type"], property=pid, required=req) for pid, lbl, req in params if pid in props]))
    return name


def _ensure_actions_and_history() -> dict:
    import ontology
    import ontology_edits

    e = _e()
    made, history = [], []
    alarm = type_of("alarm")
    if alarm:
        for name, desc, params in ALARM_ACTIONS.values():
            if _ensure_action(name, alarm, desc, params):
                made.append(name)
    per = _type_by_name(PERISTIWA)
    if per:
        _ensure_props(per, [("ditugaskan_ke", "Ditugaskan ke", "string"), ("catatan_operator", "Catatan operator", "string")])
        if _ensure_action(PERISTIWA_ACTION[0], per, PERISTIWA_ACTION[1], PERISTIWA_ACTION[2]):
            made.append(PERISTIWA_ACTION[0])
    pk = e._type("perintah")
    if pk and _ensure_action(PERINTAH_ACTION[0], pk, PERINTAH_ACTION[1], PERINTAH_ACTION[2]):
        made.append(PERINTAH_ACTION[0])
    for t in (alarm, per, type_of("risiko")):
        if t and not ontology_edits.config(ontology._object_type(t["id"]))["history"]:
            ontology_edits.set_config(t["id"], ontology_edits.EditsConfigIn(history=True))
            history.append(t["display_name"])
    return {"actions": made, "history": history}


def _ensure_policies() -> list[str]:
    """Rows per ULP like the other grid types (UP3, analysts and network operations see every ULP)."""
    import ontology
    import ontology_security as osec

    import demo_grid_akses as ak

    groups = (_e().STATE.get("akses") or {}).get("groups") or {}
    extra = [groups[k] for k in ("up3", "analis", "ops") if groups.get(k)]
    if not extra:
        return []
    done = []
    for key, v in TYPES.items():
        t = type_of(key)
        if not t or not v[9]:
            continue
        sec = ontology._object_type(t["id"]).get("security") or {}
        op = {**(sec.get("object_policy") or {"markings": []}), "granular": ak.policy(extra)}
        if (sec.get("object_policy") or {}).get("granular") != op["granular"]:
            osec.set_security(t["id"], osec.SecurityIn(object_policy=op, property_policies=sec.get("property_policies") or []))
            done.append(v[0])
    return done


# ------------------------------------------------------------------------------------------------
# 4 · aplikasi: layer peta, lineage tersimpan
# ------------------------------------------------------------------------------------------------

L_KORIDOR = "Koridor kritis N-1 (struktural, OSM)"
L_RISIKO = "Risiko gardu distribusi (demo) — skor"


def _ensure_map_layers() -> dict:
    import geospatial

    import demo_grid_peta_gabungan as pg

    e = _e()
    out = {}
    kor, rsk = type_of("koridor"), type_of("risiko")
    for map_name, layer_name, t, cfg, color in (
        (pg.MAP, L_KORIDOR, kor, {"property": "geometri", "line_width": 4, "filters": [{"property": "kritis_n1", "op": "eq", "value": True}],
                                  "color_by": "mw_terisolasi", "color_mode": "range", "color_from": "#facc15", "color_to": "#dc2626", "label_key": "nama"}, "#dc2626"),
        (e.MAP, L_RISIKO, rsk, {"property": "lokasi", "radius": 7, "color_by": "kelas_risiko", "color_mode": "category", "label_key": "kode_aset",
                                "filters": [{"property": "jenis_aset", "op": "eq", "value": "Gardu distribusi"}]}, "#f97316"),
    ):
        m = next((x for x in geospatial.list_maps() if x.get("name") == map_name), None)
        if not m or not t:
            continue
        rec = geospatial._get_map(m["id"])
        layers = list(rec.get("layers") or [])
        if any(lr.get("name") == layer_name for lr in layers):
            out[layer_name] = "ada"
            continue
        layers.append(geospatial.Layer(name=layer_name, kind="objects", color=color, opacity=0.95, config={"object_type_id": t["id"], **cfg}).model_dump())
        geospatial.save_map(m["id"], geospatial.MapIn(name=rec["name"], description=rec.get("description") or "",
                                                      basemap=rec.get("basemap") or "streets", view=rec.get("view"), layers=layers))
        out[layer_name] = m["id"]
    return out


def _ensure_lineage(st: dict) -> dict:
    """Saved lineage graph of the cockpit's data: upstream datasets → pipeline / transform → outputs → Nexus types."""
    import lineage

    ids = [f"dataset:{i}" for i in (st.get("sources") or {}).values()]
    ids += [f"pipeline:{st['pipeline_id']}"] if st.get("pipeline_id") else []
    ids += [f"dataset:{i}" for i in (st.get("datasets") or {}).values()]
    ids += [f"object_type:{t['id']}" for t in (type_of(k) for k in TYPES) if t]
    e = _e()
    ids += [f"object_type:{t['id']}" for t in (e._type(k) for k in ("gi", "penyulang", "gardu")) if t]
    for name in ("saluran_gabungan_osm", "gardu_gabungan_osm", "pembangkit_gabungan_osm"):
        iid = (st.get("osm_sources") or {}).get(name)
        if iid:
            ids.append(f"dataset:{iid}")
    # the topology transform, as lineage names it (repo::transform::branch of its last successful build)
    import code_repos

    done = [b for b in code_repos.all_builds() if b.get("repo_id") == st.get("repo_id") and b["status"] == "succeeded"]
    if done:
        b = max(done, key=lambda b: b["at"])
        ids.append(f"transform:{b['repo_id']}::{b['transform']}::{b.get('branch') or b.get('default_branch', 'master')}")
    rec = lineage.save_graph(lineage.SavedGraph(name="Lineage cockpit operasi grid (demo)", nodes=sorted(set(ids)), color_by="type"), id=LINEAGE_GRAPH)
    return {"graph": rec["id"], "nodes": len(set(ids))}


# ------------------------------------------------------------------------------------------------
# build
# ------------------------------------------------------------------------------------------------

def build(state: dict, save) -> dict:
    import drive

    e = _e()
    st = state.setdefault("operasi", {})
    out: dict[str, Any] = {}
    project = e._folder(None, e.PROJECT, "project")
    folder = e._folder(project, FOLDER)
    st["folder_id"] = folder
    konteks = e._folder(e._folder(project, "raw"), "konteks")
    st["osm_sources"] = {f["name"].removesuffix(".parquet"): f["id"] for f in drive.list_files(konteks)
                         if not f.get("trashed_at") and f["name"].removesuffix(".parquet") in ("saluran_gabungan_osm", "gardu_gabungan_osm", "pembangkit_gabungan_osm")}

    def step(key: str, fn) -> Any:
        try:
            r = fn()
            out[key] = r
            save()
            return r
        except Exception as ex:  # noqa: BLE001
            log.exception("demo grid operasi: %s failed", key)
            out[key] = {"error": str(getattr(ex, "detail", ex))[:500]}
            return None

    step("pipeline", lambda: _ensure_pipeline(st, folder))
    step("topologi", lambda: _topologi(st, folder))
    step("nexus", lambda: _ensure_types(st))
    step("links", _ensure_links)
    step("actions", _ensure_actions_and_history)
    step("policies", _ensure_policies)
    step("map", _ensure_map_layers)
    step("lineage", lambda: _ensure_lineage(st))
    st["built_at"] = datetime.now(timezone.utc).isoformat()
    save()
    return out
