"""Demo: the JKN facility audit end to end, from raw data to decisions (POST /api/demo/jkn/e2e).

The chain the JKN judges walk through, every step a real resource of the platform:

1. Raw data (Files, project "JKN Healthcare System Intelligence" / raw): what BPJS systems export — the facility register
   (with duplicate rows and untidy names), the doctors, the monthly claim summary per facility, the claims the
   screening rules flagged (one row per SEP, grouped by referral letter) and the audit team's decisions.
2. Data pipeline (Pipeline Builder, "Pipeline audit faskes JKN (demo)"): three SQL transforms — the facilities
   (deduplicated, cleaned, scored: risk score = share of flagged claims + referral rate, status from the score unless
   the audit team decided otherwise), the risky cases (one per referral letter: facility → facility, referring
   doctor → DPJP) and the doctors (their cases and roles) — writing the clean datasets (Files / clean).
3. Ontology: "Faskes Audit JKN (demo)", "Kasus Rujukan Berisiko JKN (demo)" and "Dokter Audit JKN (demo)" are
   backed by the clean datasets (re-indexed whenever a pipeline build rewrites them; edits made through actions win
   over the data), with their link types (demo_jkn_map.py) and the claims of the earlier JKN demo linked in.
4. Actions: the audit team's decisions as action types — set an audit status and team, escalate a facility to the
   investigation team, record a case's follow-up, close an audit with the recovered amount.
5. Functions (Code Repositories "Fungsi Audit JKN demo", published 1.0.0): explainable risk (why a facility scores
   what it does), the doctors behind a facility's cases, self-referral detection for a doctor, similar cases — each
   runnable from Vertex (function-backed Search Around or derived value).
6. Apps: the map, the Vertex graphs and the overview page (/demo-jkn/ontologi) that draws the ontology.

The clean datasets are first computed here by running the pipeline's own SQL (sqlite3), so the Ontology is ready at
once; the pipeline's outputs point at the same files, and a build is queued so the pipeline itself rewrites them.
Seeded and idempotent: what exists is kept, and nothing is ever deleted.
"""

from __future__ import annotations

import json
import logging
import math
import random
import sqlite3
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

import demo_jkn_map as jm
import ontology

log = logging.getLogger("bluesandai.demo_jkn_e2e")
router = APIRouter(prefix="/api/demo/jkn/e2e")

PROJECT = "JKN Healthcare System Intelligence"
# the project's earlier name: renamed in place (same items, ids and links) the first time the demo looks for it
OLD_PROJECTS = ("Audit Faskes JKN (demo)",)
PIPELINE = "Pipeline audit faskes JKN (demo)"
FUNCTIONS_REPO = "Fungsi Audit JKN demo"
FUNCTIONS_VERSION = "1.0.0"
MONTHS = ["2026-07", "2026-08", "2026-09"]
DIR: Path = Path()
_lock = threading.RLock()
STATE: dict = {}

# the risk score: 800 × flagged share + referral rate (%), capped at 98; status thresholds
SCORE_WEIGHT = 800
REFERRAL_TYPES = ("Rujukan tidak sesuai", "Penyalahgunaan dana kapitasi/nonkapitasi")

# ------------------------------------------------------------------------------------------------
# the pipeline's SQL (run by Pipeline Builder's SQL step, and here by sqlite3 for the first load)
# ------------------------------------------------------------------------------------------------

SQL_FASKES = """-- Faskes audit: deduplicate and tidy the register, then score each facility from its claims.
-- Flagged claims count against the facility responsible: the referring facility for referral cases,
-- the billing facility for everything else.
WITH register AS (
  SELECT UPPER(TRIM(kode)) AS kode,
         MIN(TRIM(REPLACE(REPLACE(nama_faskes, '   ', ' '), '  ', ' '))) AS nama,
         MIN(jenis) AS jenis, MIN(kepemilikan) AS kepemilikan, MIN(wilayah) AS wilayah,
         MIN(kantor_cabang) AS kantor_cabang, MIN(latitude) AS latitude, MIN(longitude) AS longitude
  FROM input
  GROUP BY UPPER(TRIM(kode))
),
responsible AS (
  SELECT CASE WHEN indikasi IN ('Rujukan tidak sesuai', 'Penyalahgunaan dana kapitasi/nonkapitasi')
              THEN faskes_asal ELSE faskes_tujuan END AS kode,
         indikasi, nilai_klaim
  FROM klaim_berisiko
),
flagged AS (
  SELECT kode, COUNT(*) AS klaim_berisiko, SUM(nilai_klaim) AS nilai_berisiko FROM responsible GROUP BY kode
),
main_indication AS (
  SELECT kode, indikasi FROM (
    SELECT kode, indikasi, ROW_NUMBER() OVER (PARTITION BY kode ORDER BY COUNT(*) DESC, indikasi) AS rk
    FROM responsible GROUP BY kode, indikasi
  ) WHERE rk = 1
),
volume AS (
  SELECT UPPER(TRIM(kode_faskes)) AS kode, SUM(jumlah_klaim) AS klaim_3_bulan, SUM(nilai_klaim) AS nilai_klaim_rp,
         SUM(jumlah_rujukan) AS rujukan
  FROM klaim_bulanan_bersih GROUP BY UPPER(TRIM(kode_faskes))
),
involved AS (
  SELECT faskes_asal AS kode, no_rujukan, dokter_perujuk, dokter_dpjp FROM klaim_berisiko
  UNION ALL
  SELECT faskes_tujuan AS kode, no_rujukan, dokter_perujuk, dokter_dpjp FROM klaim_berisiko
),
cases AS (
  SELECT kode, COUNT(DISTINCT no_rujukan) AS jumlah_kasus FROM involved GROUP BY kode
),
doctors AS (
  SELECT kode, GROUP_CONCAT(nama_dokter, '; ') AS dokter_terkait FROM (
    SELECT DISTINCT i.kode, d.nama_dokter, d.id_dokter
    FROM involved i JOIN dokter_bersih d ON d.id_dokter = i.dokter_perujuk OR d.id_dokter = i.dokter_dpjp
    ORDER BY i.kode, d.id_dokter
  ) GROUP BY kode
),
scored AS (
  SELECT r.*, v.klaim_3_bulan, v.nilai_klaim_rp,
         ROUND(100.0 * v.rujukan / v.klaim_3_bulan, 1) AS rasio_rujukan_pct,
         COALESCE(f.klaim_berisiko, 0) AS klaim_berisiko, COALESCE(f.nilai_berisiko, 0) AS nilai_berisiko,
         MIN(98, 5 + CAST(800.0 * COALESCE(f.klaim_berisiko, 0) / v.klaim_3_bulan AS INT)
                   + CAST(100.0 * v.rujukan / v.klaim_3_bulan AS INT)) AS skor_risiko,
         COALESCE(m.indikasi, '') AS indikasi_utama,
         COALESCE(c.jumlah_kasus, 0) AS jumlah_kasus, COALESCE(d.dokter_terkait, '') AS dokter_terkait,
         k.keputusan, k.tim_audit, k.tanggal_audit, k.pengembalian_rp
  FROM register r
  JOIN volume v ON v.kode = r.kode
  LEFT JOIN flagged f ON f.kode = r.kode
  LEFT JOIN main_indication m ON m.kode = r.kode
  LEFT JOIN cases c ON c.kode = r.kode
  LEFT JOIN doctors d ON d.kode = r.kode
  LEFT JOIN keputusan_audit k ON UPPER(TRIM(k.kode_faskes)) = r.kode
),
status AS (
  SELECT *, COALESCE(NULLIF(keputusan, ''),
                     CASE WHEN skor_risiko >= 56 THEN 'Ada Indikasi Fraud'
                          WHEN skor_risiko >= 31 THEN 'Perlu Pemantauan'
                          ELSE 'Sehat' END) AS status_audit
  FROM scored
)
SELECT kode, nama, nama || ' · ' || status_audit AS judul,
       CAST(ROUND(latitude, 5) AS STRING) || ',' || CAST(ROUND(longitude, 5) AS STRING) AS lokasi,
       jenis,
       CASE WHEN jenis IN ('Puskesmas', 'Klinik Pratama', 'Dokter Praktik Perorangan') THEN 'FKTP' ELSE 'FKRTL' END AS tingkat,
       kepemilikan, wilayah, kantor_cabang, status_audit, skor_risiko,
       CASE status_audit WHEN 'Dalam Investigasi' THEN 'P1 — segera' WHEN 'Ada Indikasi Fraud' THEN 'P2 — jadwalkan audit'
                         WHEN 'Perlu Pemantauan' THEN 'P3 — pantau' ELSE '-' END AS prioritas,
       indikasi_utama, klaim_3_bulan, klaim_berisiko, nilai_klaim_rp,
       CAST(nilai_berisiko * 0.6 / 10000 AS INT) * 10000.0 AS potensi_kerugian_rp,
       COALESCE(pengembalian_rp, 0.0) AS pengembalian_rp,
       CASE WHEN status_audit = 'Sehat' THEN '' ELSE COALESCE(tim_audit, '') END AS tim_audit,
       CASE WHEN status_audit = 'Sehat' THEN '' ELSE COALESCE(tanggal_audit, '') END AS tanggal_audit,
       rasio_rujukan_pct, dokter_terkait, jumlah_kasus,
       ROUND(latitude, 5) AS latitude, ROUND(longitude, 5) AS longitude
FROM status
ORDER BY kode"""

SQL_KASUS = """-- Kasus rujukan berisiko: one case per referral letter (no_rujukan) whose claims the screening rules flagged —
-- from the referring facility to the receiving one, the referring doctor and the DPJP, with the claims' count and value.
WITH letters AS (
  SELECT no_rujukan, MIN(faskes_asal) AS faskes_asal, MIN(faskes_tujuan) AS faskes_tujuan, MIN(indikasi) AS jenis_kasus,
         MIN(dokter_perujuk) AS dokter_perujuk, MIN(dokter_dpjp) AS dokter_dpjp, MIN(diagnosa) AS diagnosa,
         COUNT(*) AS jumlah_klaim, SUM(nilai_klaim) AS nilai_klaim_rp, MIN(tgl_layanan) AS mulai, MAX(tgl_layanan) AS selesai
  FROM input GROUP BY no_rujukan
),
numbered AS (
  SELECT *, 'KRB-' || SUBSTR('000' || CAST(ROW_NUMBER() OVER (ORDER BY no_rujukan) AS STRING), -3) AS id_kasus FROM letters
),
-- the referral on the map: a quadratic arc from the referring facility (x1, y1) to the receiving one (x2, y2),
-- bent sideways through the control point (cx, cy), sampled at t = 0, .25, .5, .75, 1
arc AS (
  SELECT n.id_kasus, a.longitude AS x1, a.latitude AS y1, t.longitude AS x2, t.latitude AS y2,
         (a.longitude + t.longitude) / 2 - (t.latitude - a.latitude) * 0.25 AS cx,
         (a.latitude + t.latitude) / 2 + (t.longitude - a.longitude) * 0.25 AS cy
  FROM numbered n JOIN faskes_audit a ON a.kode = n.faskes_asal JOIN faskes_audit t ON t.kode = n.faskes_tujuan
),
path AS (
  SELECT id_kasus, '{"type":"LineString","coordinates":[' ||
         '[' || ROUND(x1, 5) || ',' || ROUND(y1, 5) || '],' ||
         '[' || ROUND(0.5625 * x1 + 0.375 * cx + 0.0625 * x2, 5) || ',' || ROUND(0.5625 * y1 + 0.375 * cy + 0.0625 * y2, 5) || '],' ||
         '[' || ROUND(0.25 * x1 + 0.5 * cx + 0.25 * x2, 5) || ',' || ROUND(0.25 * y1 + 0.5 * cy + 0.25 * y2, 5) || '],' ||
         '[' || ROUND(0.0625 * x1 + 0.375 * cx + 0.5625 * x2, 5) || ',' || ROUND(0.0625 * y1 + 0.375 * cy + 0.5625 * y2, 5) || '],' ||
         '[' || ROUND(x2, 5) || ',' || ROUND(y2, 5) || ']]}' AS jalur
  FROM arc
)
SELECT n.id_kasus, n.id_kasus || ' · ' || n.jenis_kasus AS judul, n.jenis_kasus,
       a.nama || ' → ' || t.nama AS alur,
       n.faskes_asal, a.nama AS nama_faskes_asal, n.faskes_tujuan, t.nama AS nama_faskes_tujuan,
       n.dokter_perujuk, p.nama_dokter AS nama_dokter_perujuk, n.dokter_dpjp, j.nama_dokter AS nama_dokter_dpjp,
       n.diagnosa, n.jumlah_klaim, n.nilai_klaim_rp, n.no_rujukan, n.mulai || ' s.d. ' || n.selesai AS periode,
       COALESCE(r.status_audit, 'Perlu Pemantauan') AS status_kasus,
       CASE n.jenis_kasus
         WHEN 'Rujukan tidak sesuai' THEN 'Diagnosis termasuk 144 kompetensi FKTP tetapi dirujuk ke FKRTL; pola berulang dari dokter perujuk yang sama.'
         WHEN 'Self-referral' THEN 'Dokter perujuk adalah juga DPJP / pemilik praktik di faskes tujuan: pasien dirujuk ke praktiknya sendiri.'
         WHEN 'Penyalahgunaan dana kapitasi/nonkapitasi' THEN 'Peserta kapitasi dirujuk tanpa indikasi sehingga beban layanan berpindah ke FKRTL.'
         ELSE 'Klaim di ' || t.nama || ' terindikasi ' || LOWER(n.jenis_kasus) || ' oleh DPJP; perlu verifikasi rekam medis.'
       END AS temuan,
       g.jalur
FROM numbered n
JOIN path g ON g.id_kasus = n.id_kasus
JOIN faskes_audit a ON a.kode = n.faskes_asal
JOIN faskes_audit t ON t.kode = n.faskes_tujuan
JOIN dokter_bersih p ON p.id_dokter = n.dokter_perujuk
JOIN dokter_bersih j ON j.id_dokter = n.dokter_dpjp
LEFT JOIN faskes_audit r ON r.kode = CASE WHEN n.jenis_kasus IN ('Rujukan tidak sesuai', 'Penyalahgunaan dana kapitasi/nonkapitasi')
                                          THEN n.faskes_asal ELSE n.faskes_tujuan END
ORDER BY n.id_kasus"""

SQL_DOKTER = """-- Dokter audit: the doctors with the facility they work at and their part in the risky cases.
WITH roles AS (
  SELECT dokter_perujuk AS id_dokter, 'perujuk' AS peran, id_kasus FROM kasus_berisiko
  UNION ALL
  SELECT dokter_dpjp AS id_dokter, 'DPJP' AS peran, id_kasus FROM kasus_berisiko
),
per_doctor AS (
  SELECT id_dokter, COUNT(*) AS jumlah_kasus,
         CASE WHEN SUM(peran = 'DPJP') > 0 AND SUM(peran = 'perujuk') > 0 THEN 'DPJP, perujuk'
              WHEN SUM(peran = 'DPJP') > 0 THEN 'DPJP' ELSE 'perujuk' END AS peran_dalam_kasus
  FROM roles GROUP BY id_dokter
)
SELECT d.id_dokter, TRIM(d.nama_dokter) AS nama, d.spesialisasi, d.kode_faskes_utama AS faskes_utama,
       f.nama AS nama_faskes, COALESCE(p.nama, '') AS praktik_lain,
       COALESCE(r.jumlah_kasus, 0) AS jumlah_kasus, COALESCE(r.peran_dalam_kasus, '') AS peran_dalam_kasus
FROM input d
JOIN faskes_audit f ON f.kode = d.kode_faskes_utama
LEFT JOIN faskes_audit p ON p.kode = d.praktik_lain
LEFT JOIN per_doctor r ON r.id_dokter = d.id_dokter
ORDER BY d.id_dokter"""

# output schemas (column → pipeline type); the order is the dataset's
OUT_FASKES = [("kode", "String"), ("nama", "String"), ("judul", "String"), ("lokasi", "String"), ("jenis", "String"), ("tingkat", "String"),
              ("kepemilikan", "String"), ("wilayah", "String"), ("kantor_cabang", "String"), ("status_audit", "String"), ("skor_risiko", "Integer"),
              ("prioritas", "String"), ("indikasi_utama", "String"), ("klaim_3_bulan", "Integer"), ("klaim_berisiko", "Integer"),
              ("nilai_klaim_rp", "Double"), ("potensi_kerugian_rp", "Double"), ("pengembalian_rp", "Double"), ("tim_audit", "String"),
              ("tanggal_audit", "String"), ("rasio_rujukan_pct", "Double"), ("dokter_terkait", "String"), ("jumlah_kasus", "Integer"),
              ("latitude", "Double"), ("longitude", "Double")]
OUT_KASUS = [("id_kasus", "String"), ("judul", "String"), ("jenis_kasus", "String"), ("alur", "String"), ("faskes_asal", "String"),
             ("nama_faskes_asal", "String"), ("faskes_tujuan", "String"), ("nama_faskes_tujuan", "String"), ("dokter_perujuk", "String"),
             ("nama_dokter_perujuk", "String"), ("dokter_dpjp", "String"), ("nama_dokter_dpjp", "String"), ("diagnosa", "String"),
             ("jumlah_klaim", "Integer"), ("nilai_klaim_rp", "Double"), ("no_rujukan", "String"), ("periode", "String"),
             ("status_kasus", "String"), ("temuan", "String"), ("jalur", "String")]
OUT_DOKTER = [("id_dokter", "String"), ("nama", "String"), ("spesialisasi", "String"), ("faskes_utama", "String"), ("nama_faskes", "String"),
              ("praktik_lain", "String"), ("jumlah_kasus", "Integer"), ("peran_dalam_kasus", "String")]

# raw schemas
RAW_SCHEMAS = {
    "faskes_raw": [("kode", "String"), ("nama_faskes", "String"), ("jenis", "String"), ("kepemilikan", "String"), ("wilayah", "String"),
                   ("kantor_cabang", "String"), ("latitude", "Double"), ("longitude", "Double")],
    "dokter_raw": [("id_dokter", "String"), ("nama_dokter", "String"), ("spesialisasi", "String"), ("kode_faskes_utama", "String"), ("praktik_lain", "String")],
    "klaim_bulanan_raw": [("kode_faskes", "String"), ("bulan", "String"), ("jumlah_klaim", "Integer"), ("nilai_klaim", "Double"), ("jumlah_rujukan", "Integer")],
    "klaim_berisiko_raw": [("no_sep", "String"), ("no_rujukan", "String"), ("tgl_layanan", "String"), ("faskes_asal", "String"), ("faskes_tujuan", "String"),
                           ("dokter_perujuk", "String"), ("dokter_dpjp", "String"), ("diagnosa", "String"), ("nilai_klaim", "Double"),
                           ("indikasi", "String"), ("aturan", "String")],
    "keputusan_audit_raw": [("kode_faskes", "String"), ("keputusan", "String"), ("tim_audit", "String"), ("tanggal_audit", "String"), ("pengembalian_rp", "Double")],
}
RULE_OF = {"Rujukan tidak sesuai": "R03 rujukan diagnosis kompetensi FKTP", "Self-referral": "R11 perujuk = DPJP / pemilik praktik tujuan",
           "Penyalahgunaan dana kapitasi/nonkapitasi": "R01 rasio rujukan peserta kapitasi"}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "demo-jkn-e2e"
    DIR.mkdir(parents=True, exist_ok=True)
    try:
        STATE.update(json.loads((DIR / "state.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass


def _save() -> None:
    (DIR / "state.json").write_text(json.dumps(STATE, indent=1, default=str), encoding="utf-8")


# ------------------------------------------------------------------------------------------------
# raw data
# ------------------------------------------------------------------------------------------------


def _responsible(c: dict) -> str:
    return c["faskes_asal"] if c["jenis_kasus"] in REFERRAL_TYPES else c["faskes_tujuan"]


def generate_raw(seed: int = 26) -> dict[str, list[dict]]:
    """The raw tables, built so that the pipeline's score lands on each facility's target (demo_jkn_map.generate)."""
    rnd = random.Random(seed)
    faskes = jm.generate()
    doctors, cases, _ = jm.generate_flow(faskes)
    flagged: dict[str, int] = {}
    for c in cases:
        flagged[_responsible(c)] = flagged.get(_responsible(c), 0) + c["jumlah_klaim"]
    raw_f, raw_m, raw_k = [], [], []
    for i, f in enumerate(faskes):
        lat, lon = (float(x) for x in f["lokasi"].split(","))
        # the register as exported: untidy names, a lower-case code now and then, some facilities twice
        nama = f["nama"] if i % 5 else f"  {f['nama'].replace(' ', '  ', 1)} "
        kode = f["kode"].lower() if i % 7 == 3 else f["kode"]
        row = {"kode": kode, "nama_faskes": nama, "jenis": f["jenis"], "kepemilikan": f["kepemilikan"], "wilayah": f["wilayah"],
               "kantor_cabang": f["kantor_cabang"], "latitude": lat, "longitude": lon}
        raw_f.append(row)
        if i % 9 == 4:
            raw_f.append(dict(row, kode=f["kode"]))
        b = flagged.get(f["kode"], 0)
        target = f["skor_risiko"]
        if b:
            r = min(max(1, target - 6), rnd.randint(6, 18))
            term = target - 5 - r
            total = max(b + 1, math.floor(SCORE_WEIGHT * b / (term + 0.5)))
        else:
            r = max(0, min(25, target - 5))
            total = f["klaim_3_bulan"]
        rujukan = math.ceil(total * (r + 0.4) / 100)
        nilai = f["nilai_klaim_rp"] * total / max(1, f["klaim_3_bulan"])
        shares = [rnd.uniform(0.9, 1.1) for _ in MONTHS]
        s = sum(shares)
        js = [int(total * x / s) for x in shares]
        js[-1] += total - sum(js)
        rs = [int(rujukan * x / s) for x in shares]
        rs[-1] += rujukan - sum(rs)
        for m, j, rj, x in zip(MONTHS, js, rs, shares):
            raw_m.append({"kode_faskes": f["kode"], "bulan": m, "jumlah_klaim": j, "nilai_klaim": round(nilai * x / s, -3), "jumlah_rujukan": rj})
        if f["status_audit"] != "Sehat":
            keputusan = f["status_audit"] if f["status_audit"] in ("Dalam Investigasi", "Selesai Diaudit") else ""
            raw_k.append({"kode_faskes": f["kode"], "keputusan": keputusan, "tim_audit": f["tim_audit"], "tanggal_audit": f["tanggal_audit"],
                          "pengembalian_rp": f["pengembalian_rp"]})
    seq = 0
    raw_c = []
    for n, c in enumerate(cases, 1):
        weights = [rnd.uniform(0.5, 1.5) for _ in range(c["jumlah_klaim"])]
        s = sum(weights)
        start = date(2026, 7, 1) + timedelta(days=rnd.randint(0, 40))
        for w in weights:
            seq += 1
            raw_c.append({"no_sep": f"0301R0010926V{seq:06d}", "no_rujukan": f"0301B{n:04d}0926", "tgl_layanan": (start + timedelta(days=rnd.randint(0, 45))).isoformat(),
                          "faskes_asal": c["faskes_asal"], "faskes_tujuan": c["faskes_tujuan"], "dokter_perujuk": c["dokter_perujuk"],
                          "dokter_dpjp": c["dokter_dpjp"], "diagnosa": c["diagnosa"], "nilai_klaim": round(c["nilai_klaim_rp"] * w / s, -3),
                          "indikasi": c["jenis_kasus"], "aturan": RULE_OF.get(c["jenis_kasus"], "R20 pola klaim FKRTL (" + c["jenis_kasus"].split(" (")[0] + ")")})
    by_name = {f["kode"]: f["nama"] for f in faskes}
    raw_d = [{"id_dokter": d["id_dokter"], "nama_dokter": d["nama"], "spesialisasi": d["spesialisasi"], "kode_faskes_utama": d["faskes_utama"],
              "praktik_lain": next((k for k, v in by_name.items() if v == d["praktik_lain"]), "") if d["praktik_lain"] else ""} for d in doctors]
    return {"faskes_raw": raw_f, "dokter_raw": raw_d, "klaim_bulanan_raw": raw_m, "klaim_berisiko_raw": raw_c, "keputusan_audit_raw": raw_k}


def run_sql(raw: Optional[dict[str, list[dict]]] = None) -> dict[str, list[dict]]:
    """The pipeline (demo_jkn_pipeline.py) emulated on its sources: every output's rows by name."""
    import demo_jkn_pipeline as dp

    rows = dp.run(dp.generate_sources())
    return {name: rows[next(n["name"] for n in dp.spec() if n["id"] == node)] for name, node, _ in dp.OUTPUTS}


def run_sql_v1(raw: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """The first version's transforms on the five raw tables (sqlite3): faskes_audit, kasus_berisiko, dokter_audit."""
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row

    def load(name: str, rows: list[dict], schema: list[tuple[str, str]]) -> None:
        cols = [c for c, _ in schema]
        con.execute(f"CREATE TABLE {name} ({', '.join(cols)})")
        con.executemany(f"INSERT INTO {name} VALUES ({', '.join('?' * len(cols))})", [[r.get(c) for c in cols] for r in rows])

    for name, rows in raw.items():
        load(name, rows, RAW_SCHEMAS[name])

    def run(sql: str, input_table: str, out: str, schema: list[tuple[str, str]]) -> list[dict]:
        con.execute("DROP VIEW IF EXISTS input")
        con.execute(f"CREATE TEMP VIEW input AS SELECT * FROM {input_table}")
        # Spark's CAST(x AS STRING) is sqlite's TEXT; a double cast to text keeps its decimals there too
        rows = [dict(r) for r in con.execute(sql.replace("AS STRING)", "AS TEXT)")).fetchall()]
        load(out, rows, schema)
        return rows

    faskes = run(SQL_FASKES, "faskes_raw", "faskes_audit", OUT_FASKES)
    kasus = run(SQL_KASUS, "klaim_berisiko_raw", "kasus_berisiko", OUT_KASUS)
    dokter = run(SQL_DOKTER, "dokter_raw", "dokter_audit", OUT_DOKTER)
    return {"faskes_audit": faskes, "kasus_berisiko": kasus, "dokter_audit": dokter}


# ------------------------------------------------------------------------------------------------
# Files: the project, its raw and clean folders
# ------------------------------------------------------------------------------------------------


def _arrow(rows: list[dict], schema: list[tuple[str, str]]):
    import pyarrow as pa

    kinds = {"String": pa.string(), "Integer": pa.int64(), "Double": pa.float64()}
    cast = {"String": lambda v: None if v is None else str(v), "Integer": lambda v: None if v is None else int(v),
            "Double": lambda v: None if v is None else float(v)}
    return pa.table({c: pa.array([cast[t](r.get(c)) for r in rows], type=kinds[t]) for c, t in schema})


def _folder(parent: Optional[str], name: str, kind: str = "folder") -> str:
    import db
    import drive

    live = [c for c in db.drive_list(parent) if c["kind"] in drive.CONTAINERS and not c.get("trashed_at")]
    found = next((c for c in live if c["name"] == name), None)
    if not found and parent is None and name == PROJECT:
        old = next((c for c in live if c["name"] in OLD_PROJECTS), None)
        if old:
            db.drive_update(old["id"], drive._now(), name=PROJECT)
            return old["id"]
    return found["id"] if found else drive._insert_container(parent, kind, name)


def _put(folder_id: str, name: str, table, replace: bool = True) -> str:
    """Write (or replace) <name>.parquet in the folder; returns the item id."""
    import drive
    import pipeline_datasets

    data = pipeline_datasets._parquet_bytes(table)
    existing = next((f for f in drive.list_files(folder_id) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)
    if existing:
        if replace:
            pipeline_datasets._replace_content(existing, data)
        return existing["id"]
    return drive.save_bytes(folder_id, f"{name}.parquet", data, pipeline_datasets.PARQUET)["id"]


def _ensure_files() -> dict:
    """The 15 sources in raw/ (rewritten every build: the schedule's data trigger then rebuilds the pipeline) and, on
    the first load only, the 8 outputs in clean/ computed by the emulation (the pipeline owns them afterwards)."""
    import drive

    import demo_jkn_pipeline as dp

    project = _folder(None, PROJECT, "project")
    raw_dir, clean_dir = _folder(project, "raw"), _folder(project, "clean")
    # the first version's five raw tables are kept, out of the way
    old = [f for f in drive.list_files(raw_dir) if f["name"] in {f"{n}.parquet" for n in RAW_SCHEMAS} and not f.get("trashed_at")]
    if old:
        archive = _folder(raw_dir, "arsip v1 (tidak dipakai)")
        for f in old:
            drive.update_item(f["id"], drive.ItemChange(move_to=archive))
    sources = dp.generate_sources()
    outputs = run_sql()
    raw_ids = {name: _put(raw_dir, name, _arrow(rows, dp.schema_of(rows))) for name, rows in sources.items()}
    clean_ids = {name: _put(clean_dir, name, _arrow(rows, dp.schema_of(rows)), replace=False) for name, rows in outputs.items()}
    return {"project_id": project, "raw_folder": raw_dir, "clean_folder": clean_dir, "raw": raw_ids, "clean": clean_ids,
            "rows": {**{k: len(v) for k, v in sources.items()}, **{k: len(v) for k, v in outputs.items()}}}


# ------------------------------------------------------------------------------------------------
# the Pipeline Builder pipeline (its nodes, layout and outputs come from demo_jkn_pipeline.spec)
# ------------------------------------------------------------------------------------------------


def _uid() -> str:
    return uuid.uuid4().hex[:8]


def _schedule(output_ids: list[str]) -> dict:
    """Rebuild when the raw data changes (and every morning): the Ontology follows through its re-index."""
    return {"id": "jkn-raw-updated", "name": "Bangun ulang saat data mentah berubah (demo)", "enabled": True,
            "enabledAt": datetime.now(timezone.utc).isoformat(), "target": "single", "outputs": output_ids,
            "trigger": {"id": "root", "kind": "or", "items": [{"id": "data", "kind": "data"},
                                                              {"id": "pagi", "kind": "time", "cron": "0 6 * * *", "timezone": "Asia/Jakarta"}]},
            "retries": {"count": 1, "delayMinutes": 5}}


def _seed_output_state(pid: str, files: dict, out_ids: dict[str, str]) -> None:
    """The outputs write into the clean datasets computed here (the Ontology already reads the core ones)."""
    import pipeline_runtime as rt

    for name, oid in out_ids.items():
        if rt.get_state(pid, f"output:{oid}"):
            continue
        rt.set_state(pid, f"output:{oid}", {"itemId": files["clean"][name], "parentId": files["clean_folder"], "version": 0,
                                            "rows": files["rows"][name], "path": f"{PROJECT} / clean / {name}.parquet"})


def _ensure_pipeline(files: dict) -> dict:
    """Create the pipeline, or bring an earlier version up to the current spec (same file, so its id, builds and
    lineage stay)."""
    import db
    import drive
    import pipeline_datasets
    import pipeline_runtime as rt

    import demo_jkn_pipeline as dp

    pid = STATE.get("pipeline_id")
    item = None
    if pid:
        try:
            item = db.drive_get(pid)
        except Exception:  # noqa: BLE001
            item = None
    if item and not item.get("trashed_at"):
        current = json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(pid)))
        if (current.get("meta") or {}).get("version") == dp.SPEC_VERSION:
            return {"pipeline_id": pid, "created": False}
        body, out_ids = dp.content(files["raw"], files["clean_folder"], PROJECT, _uid, _schedule)
        body["createdAt"] = current.get("createdAt") or body["createdAt"]
        # the core outputs keep the files (and so the Ontology's datasources) of the first version
        old_by_name = {o["name"]: o["id"] for o in current.get("outputs") or []}
        for o in body["outputs"]:
            if o["name"] in old_by_name:
                o["id"] = old_by_name[o["name"]]
                out_ids[o["name"]] = o["id"]
        body["schedules"] = [_schedule(list(out_ids.values()))]
        pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=body))
        _seed_output_state(pid, files, out_ids)
        STATE.update(output_ids=out_ids)
        _save()
        return {"pipeline_id": pid, "created": False, "upgraded_to": dp.SPEC_VERSION, "nodes": len(body["nodes"]), "outputs": len(out_ids)}
    body, out_ids = dp.content(files["raw"], files["clean_folder"], PROJECT, _uid, _schedule)
    item = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=files["project_id"], content=body))
    _seed_output_state(item["id"], files, out_ids)
    STATE.update(pipeline_id=item["id"], output_ids=out_ids)
    _save()
    try:
        b = rt.queue_build(rt.NewBuild(pipeline_id=item["id"], trigger="demo"))
        STATE.update(first_build=b.get("id"))
    except Exception as e:  # noqa: BLE001
        log.info("demo e2e: the first build was not queued (%s)", e)
    return {"pipeline_id": item["id"], "created": True}


# ------------------------------------------------------------------------------------------------
# Ontology: the object types backed by the clean datasets, extra properties, links, actions
# ------------------------------------------------------------------------------------------------

EDIT_PROPS = {
    jm.FASKES: [("catatan_audit", "Catatan audit", "string")],
    jm.KASUS: [("tindak_lanjut", "Tindak lanjut", "string")],
    jm.DOKTER: [("status_klarifikasi", "Status klarifikasi", "string")],
}


def _ensure_edit_props() -> list[str]:
    """Properties only the audit team's actions write (no column backs them, so re-indexes keep them)."""
    added = []
    with ontology._lock:
        for type_name, props in EDIT_PROPS.items():
            rec = ontology._object_type(jm._type(type_name)["id"])
            new = [(api, label, typ) for api, label, typ in props if not any(p["api_name"] == api for p in rec["properties"])]
            if new:
                rec["properties"] += [{"api_name": api, "display_name": label, "type": typ, "description": "Diisi lewat action tim audit."} for api, label, typ in new]
                ontology._put("object-types", rec)
                added += [f"{type_name}.{api}" for api, _, _ in new]
    return added


def _attach(type_name: str, dataset_id: str) -> dict:
    """Back the object type with the dataset (columns mapped by name; new columns become properties)."""
    import ontology_datasources as ods

    t = jm._type(type_name)
    rec = ontology._object_type(t["id"])
    if (rec.get("backing_dataset") or {}).get("dataset_id") == dataset_id:
        return {"type": type_name, "attached": False}
    r = ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=dataset_id, columns=None, map_unmapped=True))
    return {"type": type_name, "attached": True, "imported": r.get("imported")}


def _reset_creation_edits() -> Optional[dict]:
    """Once, after the types are dataset-backed: drop the edits that first created their objects (demo_jkn_map.py
    wrote them as edits, and user edits win over the datasource), so the pipeline's data is what they show. Edits
    the audit team makes later through the actions are kept."""
    import ontology_edits

    if STATE.get("creation_edits_dropped"):
        return None
    out = {}
    for name in (jm.FASKES, jm.KASUS, jm.DOKTER):
        t = jm._type(name)
        if (ontology._object_type(t["id"]).get("backing_dataset") or {}).get("dataset_id"):
            out[name] = ontology_edits.migrate(t["id"], ontology_edits.MigrateIn(kind="drop_all"))
    STATE["creation_edits_dropped"] = datetime.now(timezone.utc).isoformat()
    _save()
    return out


def _enable_history() -> list[str]:
    """Track user edit history on the audit types: every decision the workspace's actions take leaves a trail."""
    import ontology_edits

    done = []
    for name in (jm.FASKES, jm.KASUS, jm.DOKTER):
        t = jm._type(name)
        if not ontology_edits.config(ontology._object_type(t["id"]))["history"]:
            ontology_edits.set_config(t["id"], ontology_edits.EditsConfigIn(history=True))
            done.append(name)
    return done


def _action(name: str) -> Optional[dict]:
    return next((a for a in ontology._all("action-types") if a["display_name"] == name), None)


ACTIONS = [
    ("Tetapkan status audit faskes (demo)", jm.FASKES, "Faskes",
     "Tim audit menetapkan status (Sehat … Selesai Diaudit), prioritas, tim dan tanggal audit sebuah faskes; keputusan ini menang atas hasil skrining.",
     [("status_audit", "Status audit", True), ("prioritas", "Prioritas", False), ("tim_audit", "Tim audit", False), ("tanggal_audit", "Tanggal audit", False),
      ("catatan_audit", "Catatan audit", False)]),
    ("Eskalasi ke tim investigasi (demo)", jm.FASKES, "Faskes",
     "Naikkan faskes ke Dalam Investigasi (P1) dan serahkan ke Tim Investigasi Kedeputian Wilayah, dengan alasan eskalasi.",
     [("status_audit", "Status audit (Dalam Investigasi)", True), ("prioritas", "Prioritas (P1 — segera)", True), ("tim_audit", "Tim investigasi", True),
      ("catatan_audit", "Alasan eskalasi", True)]),
    ("Tutup audit dan catat pengembalian (demo)", jm.FASKES, "Faskes",
     "Audit selesai: status Selesai Diaudit, tanggal selesai dan dana yang dikembalikan faskes.",
     [("status_audit", "Status audit (Selesai Diaudit)", True), ("tanggal_audit", "Tanggal selesai", True), ("pengembalian_rp", "Pengembalian dana (Rp)", True),
      ("catatan_audit", "Kesimpulan audit", False)]),
    ("Tindak lanjut kasus rujukan (demo)", jm.KASUS, "Kasus",
     "Catat tindak lanjut sebuah kasus: klarifikasi faskes, koreksi klaim, penolakan, atau rujukan ke investigasi.",
     [("status_kasus", "Status kasus", True), ("tindak_lanjut", "Tindak lanjut", True)]),
    ("Minta klarifikasi dokter (demo)", jm.DOKTER, "Dokter",
     "Tandai dokter yang perlu dimintai klarifikasi (pola self-referral atau rujukan berulang) dan statusnya.",
     [("status_klarifikasi", "Status klarifikasi", True)]),
]


def _ensure_actions() -> list[str]:
    made = []
    for name, type_name, label, desc, params in ACTIONS:
        if _action(name):
            continue
        t = jm._type(type_name)
        props = {p["api_name"]: p for p in ontology._object_type(t["id"])["properties"]}
        ontology.create_action_type(ontology.ActionTypeIn(
            display_name=name, object_type_id=t["id"], kind="modify", status="active", description=desc,
            parameters=[ontology.Parameter(id="object", display_name=label, type="object", required=True)]
            + [ontology.Parameter(id=pid, display_name=plabel, type=props[pid]["type"], property=pid, required=req) for pid, plabel, req in params]))
        made.append(name)
    return made


def _ensure_claims_link() -> Optional[str]:
    """The earlier JKN demo's claims (Klaim JKN (demo)) linked to the audited facilities, when that demo was built."""
    import ontology_model as om

    kl = jm._type("Klaim JKN (demo)")
    fk = jm._type(jm.FASKES)
    name = "Klaim JKN di faskes audit (demo)"
    if not kl or not fk or any(x.get("display_name") == name for x in ontology._all("link-types")):
        return None
    om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key="faskes",
                                      source=om.LinkSide(object_type_id=kl["id"], display_name="Klaim JKN", plural_display_name="Klaim JKN"),
                                      target=om.LinkSide(object_type_id=fk["id"], display_name="Faskes audit")))
    return name


# ------------------------------------------------------------------------------------------------
# Functions: a Python repository published to the functions registry
# ------------------------------------------------------------------------------------------------

FUNCTIONS_PY = '''"""Fungsi audit faskes JKN (demo).

Functions on the audit Ontology (Faskes Audit, Kasus Rujukan Berisiko, Dokter Audit). Each takes one object, so
Vertex runs it from a selected node: those returning objects are function-backed Search Arounds, the others derived
values on the node. The same functions back Workshop widgets and the API gateway.
"""

from functions.api import Integer, String, function
from ontology_sdk import FoundryClient
from ontology_sdk.ontology.objects import DokterAuditJknDemo, FaskesAuditJknDemo, KasusRujukanBerisikoJknDemo

# referral cases count against the referring facility; the others against the billing (receiving) facility
REFERRAL_TYPES = ("Rujukan tidak sesuai", "Penyalahgunaan dana kapitasi/nonkapitasi")


def _objects():
    return FoundryClient().ontology.objects


def _cases_of(kode: str) -> list:
    k = _objects().KasusRujukanBerisikoJknDemo
    out = list(k.where(KasusRujukanBerisikoJknDemo.object_type.faskes_asal == kode).iterate())
    seen = {c.id_kasus for c in out}
    out += [c for c in k.where(KasusRujukanBerisikoJknDemo.object_type.faskes_tujuan == kode).iterate() if c.id_kasus not in seen]
    return sorted(out, key=lambda c: c.id_kasus)


def _responsible(c) -> str:
    return c.faskes_asal if c.jenis_kasus in REFERRAL_TYPES else c.faskes_tujuan


def _rupiah(v) -> str:
    return "Rp " + f"{float(v or 0):,.0f}".replace(",", ".")


@function
def dokter_di_balik_kasus(faskes: FaskesAuditJknDemo) -> list[DokterAuditJknDemo]:
    """Dokter perujuk dan DPJP pada semua kasus rujukan berisiko yang melibatkan faskes ini."""
    ids: list[str] = []
    for c in _cases_of(faskes.kode):
        for d in (c.dokter_perujuk, c.dokter_dpjp):
            if d and d not in ids:
                ids.append(d)
    o = _objects().DokterAuditJknDemo
    return [o.get(i) for i in ids]


@function
def faskes_lawan_rujukan(faskes: FaskesAuditJknDemo) -> list[FaskesAuditJknDemo]:
    """Faskes di ujung lain kasus berisiko faskes ini: ke mana ia merujuk, dan siapa yang merujuk kepadanya."""
    kodes: list[str] = []
    for c in _cases_of(faskes.kode):
        other = c.faskes_tujuan if c.faskes_asal == faskes.kode else c.faskes_asal
        if other not in kodes:
            kodes.append(other)
    o = _objects().FaskesAuditJknDemo
    return [o.get(k) for k in kodes]


@function
def faskes_self_referral(dokter: DokterAuditJknDemo) -> list[FaskesAuditJknDemo]:
    """Faskes tujuan kasus di mana dokter ini sekaligus perujuk dan DPJP (pola self-referral)."""
    k = _objects().KasusRujukanBerisikoJknDemo
    kodes: list[str] = []
    for c in k.where(KasusRujukanBerisikoJknDemo.object_type.dokter_perujuk == dokter.id_dokter).iterate():
        if c.dokter_dpjp == dokter.id_dokter and c.faskes_tujuan not in kodes:
            kodes.append(c.faskes_tujuan)
    o = _objects().FaskesAuditJknDemo
    return [o.get(x) for x in kodes]


@function
def kasus_serupa(kasus: KasusRujukanBerisikoJknDemo) -> list[KasusRujukanBerisikoJknDemo]:
    """Kasus lain dengan jenis yang sama dari dokter perujuk atau DPJP yang sama (pola berulang)."""
    k = _objects().KasusRujukanBerisikoJknDemo
    out = []
    for c in k.where(KasusRujukanBerisikoJknDemo.object_type.jenis_kasus == kasus.jenis_kasus).iterate():
        if c.id_kasus != kasus.id_kasus and (c.dokter_perujuk == kasus.dokter_perujuk or c.dokter_dpjp == kasus.dokter_dpjp):
            out.append(c)
    return out


@function
def skor_risiko_terhitung(faskes: FaskesAuditJknDemo) -> Integer:
    """Skor risiko dihitung ulang dari objek: 5 + 800 × klaim berisiko / klaim 3 bulan + rasio rujukan (%), maks. 98."""
    flagged = sum(int(c.jumlah_klaim or 0) for c in _cases_of(faskes.kode) if _responsible(c) == faskes.kode)
    total = max(1, int(faskes.klaim_3_bulan or 1))
    return min(98, 5 + int(800.0 * flagged / total) + int(float(faskes.rasio_rujukan_pct or 0)))


@function
def alasan_risiko(faskes: FaskesAuditJknDemo) -> String:
    """Penjelasan skor dan status faskes: komponen skor, indikasi, kasus, dokter dan nilai yang dipertaruhkan."""
    cases = _cases_of(faskes.kode)
    own = [c for c in cases if _responsible(c) == faskes.kode]
    flagged = sum(int(c.jumlah_klaim or 0) for c in own)
    total = max(1, int(faskes.klaim_3_bulan or 1))
    part = int(800.0 * flagged / total)
    rujukan = int(float(faskes.rasio_rujukan_pct or 0))
    lines = [f"Skor {faskes.skor_risiko} = 5 + {part} (800 × {flagged} klaim berisiko / {total} klaim) + {rujukan} (rasio rujukan {faskes.rasio_rujukan_pct}%)"
             f" → {faskes.status_audit}."]
    if faskes.status_audit in ("Dalam Investigasi", "Selesai Diaudit"):
        lines.append(f"Status ditetapkan tim audit ({faskes.tim_audit or '-'}, {faskes.tanggal_audit or '-'}).")
    if own:
        by_type: dict[str, list] = {}
        for c in own:
            by_type.setdefault(c.jenis_kasus, []).append(c)
        for jenis, cs in sorted(by_type.items(), key=lambda kv: -sum(int(c.jumlah_klaim or 0) for c in kv[1])):
            value = sum(float(c.nilai_klaim_rp or 0) for c in cs)
            lines.append(f"• {jenis}: {len(cs)} kasus, {sum(int(c.jumlah_klaim or 0) for c in cs)} klaim, {_rupiah(value)} "
                         f"({', '.join(c.id_kasus for c in cs)}).")
        doctors = sorted({c.nama_dokter_dpjp for c in own} | {c.nama_dokter_perujuk for c in own})
        lines.append("Dokter terkait: " + "; ".join(doctors) + ".")
        lines.append(f"Potensi kerugian (60% nilai klaim berisiko): {_rupiah(faskes.potensi_kerugian_rp)}.")
    elif cases:
        lines.append(f"Terlibat di {len(cases)} kasus faskes lain (sebagai {'tujuan' if cases[0].faskes_tujuan == faskes.kode else 'asal'}), "
                     "tetapi tidak sebagai penanggung jawab klaim berisiko.")
    else:
        lines.append("Tidak ada klaim yang ditandai aturan skrining.")
    return "\\n".join(lines)


@function
def nilai_kasus_berisiko(faskes: FaskesAuditJknDemo) -> Integer:
    """Total nilai klaim (Rp) kasus berisiko yang menjadi tanggung jawab faskes ini."""
    return int(sum(float(c.nilai_klaim_rp or 0) for c in _cases_of(faskes.kode) if _responsible(c) == faskes.kode))
'''

FUNCTIONS_README = """# Fungsi Audit JKN demo

Functions on the JKN facility audit Ontology, published as release 1.0.0 to the functions registry:

| Function | Input | Output | In Vertex |
|---|---|---|---|
| dokter_di_balik_kasus | Faskes Audit | Dokter Audit[] | function Search Around |
| faskes_lawan_rujukan | Faskes Audit | Faskes Audit[] | function Search Around |
| faskes_self_referral | Dokter Audit | Faskes Audit[] | function Search Around |
| kasus_serupa | Kasus Rujukan Berisiko | Kasus Rujukan Berisiko[] | function Search Around |
| skor_risiko_terhitung | Faskes Audit | Integer | derived value |
| alasan_risiko | Faskes Audit | String | derived value (explainable risk) |
| nilai_kasus_berisiko | Faskes Audit | Integer | derived value |
"""


def _ensure_functions() -> dict:
    import code_repos as cr
    import functions_registry as fr

    repo = next((r for r in cr.list_repos() if r["name"] == FUNCTIONS_REPO), None)
    if not repo:
        repo = cr.create_repo(cr.RepoIn(name=FUNCTIONS_REPO, description="Demo: functions on the JKN facility audit Ontology (risk explanation, doctor networks, self-referral)."))
    d = fr._repo_data(repo["id"])
    if any(r["version"] == FUNCTIONS_VERSION for r in d["releases"]):
        return {"repo_id": repo["id"], "published": False}
    with cr._lock:
        rec = cr._repo(repo["id"])
        branch = rec["default_branch"]
        files = dict(rec["branches"][branch]["files"])
        files["README.md"] = FUNCTIONS_README
        files["python-functions/src/jkn_fungsi/__init__.py"] = ""
        files["python-functions/src/jkn_fungsi/audit.py"] = FUNCTIONS_PY
        commit = cr._commit(rec, branch, "Fungsi audit faskes JKN", files=files)
    release = fr.publish(repo["id"], FUNCTIONS_VERSION, commit["id"])
    return {"repo_id": repo["id"], "published": True, "functions": [f["name"] for f in release["functions"]]}


# ------------------------------------------------------------------------------------------------
# keeping an existing demo current: the pipeline's SQL, new columns on the Ontology, the map's flow layers
# ------------------------------------------------------------------------------------------------

COLUMN_LABELS = {"latitude": ("Lintang", None), "longitude": ("Bujur", None), "jalur": ("Jalur rujukan (peta)", "geoshape"),
                 "rasio_rujukan_pct": ("Rasio rujukan (%)", None), "no_rujukan": ("No. surat rujukan", None)}
PTYPE = {"String": "string", "Integer": "integer", "Double": "double"}


def _sync_pipeline_sql() -> list[str]:
    """The SQL transforms of an existing pipeline get the spec's current SQL (a logic change: the next build uses it)."""
    import drive
    import pipeline_datasets

    import demo_jkn_pipeline as dp

    pid = STATE.get("pipeline_id")
    if not pid:
        return []
    item = pipeline_datasets._pipeline_item(pid)
    content = json.loads(drive.read_bytes(item))
    want = {n["name"]: n["sql"] for n in dp.spec() if n["kind"] == "sql"}
    changed = []
    for n in content.get("nodes") or []:
        if n.get("kind") == "transform" and n.get("name") in want:
            step = next((st for st in n.get("steps") or [] if st.get("kind") == "sql"), None)
            if step and step["params"].get("query") != want[n["name"]]:
                step["params"]["query"] = want[n["name"]]
                changed.append(n["name"])
    if changed:
        content["updatedAt"] = datetime.now(timezone.utc).isoformat()
        pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=content))
    return changed


def _sync_columns() -> dict:
    """Columns the clean datasets gained (once a build wrote them) become mapped properties, then a re-index."""
    import ontology_datasources as ods

    out = {}
    for type_name, schema in ((jm.FASKES, OUT_FASKES), (jm.KASUS, OUT_KASUS), (jm.DOKTER, OUT_DOKTER)):
        t = jm._type(type_name)
        with ontology._lock:
            rec = ontology._object_type(t["id"])
            b = rec.get("backing_dataset") or {}
            if not b.get("dataset_id"):
                continue
            present = {c["name"] for c in ods.dataset_schema(b["dataset_id"])["columns"]}
            mapping = dict(b.get("columns") or {})
            props = {p["api_name"] for p in rec["properties"]}
            added = []
            for col, typ in schema:
                if col in mapping or col not in present:
                    continue
                if col not in props:
                    label, ptype = COLUMN_LABELS.get(col, (col.replace("_", " ").capitalize(), None))
                    rec["properties"].append({"api_name": col, "display_name": label, "type": ptype or PTYPE[typ], "description": "Dari pipeline audit faskes JKN."})
                mapping[col] = col
                added.append(col)
            if not added:
                continue
            rec["backing_dataset"] = {**b, "columns": mapping}
            ontology._put("object-types", rec)
        ods.reindex(t["id"])
        out[type_name] = added
    return out


def _ensure_map_flows() -> list[str]:
    """The cases' referral arcs on the audit map, under the facilities: referrals from primary care, and claims at
    hospitals."""
    import geospatial

    ks = jm._type(jm.KASUS)
    m = next((x for x in geospatial.list_maps() if x.get("name") == jm.MAP), None)
    if not ks or not m or any((layer.get("config") or {}).get("property") == "jalur" for layer in m.get("layers") or []):
        return []
    rec = geospatial.get_map(m["id"])
    flows = [
        geospatial.Layer(name="Alur rujukan berisiko dari FKTP", kind="objects", color="#fb923c", opacity=0.9,
                         config={"object_type_id": ks["id"], "property": "jalur",
                                 "filters": [{"property": "jenis_kasus", "op": "in", "value": [*REFERRAL_TYPES, "Self-referral"]}]}),
        geospatial.Layer(name="Klaim berisiko di FKRTL (asal → RS penagih)", kind="objects", color="#f43f5e", opacity=0.75,
                         config={"object_type_id": ks["id"], "property": "jalur",
                                 "filters": [{"property": "jenis_kasus", "op": "in", "value": [x for x in jm.FKRTL_RISKS if x != "Self-referral"]}]}),
    ]
    layers = [*(geospatial.Layer(**layer) for layer in rec.get("layers") or [])]
    geospatial.save_map(m["id"], geospatial.MapIn(
        name=rec["name"], basemap=rec.get("basemap") or "streets", view=rec.get("view"), layers=[*flows, *layers],
        description=(rec.get("description") or "") + " Garis lengkung = kasus rujukan berisiko dari faskes asal ke faskes tujuan (oranye: rujukan "
                    "dari FKTP / self-referral; merah: klaim berisiko yang ditagihkan RS)."))
    return [x.name for x in flows]


# ------------------------------------------------------------------------------------------------
# Vertex: one facility through every layer (audit cases, doctors, claims, alerts); the template reaches claims too
# ------------------------------------------------------------------------------------------------

G_OPS = "Demo: Ontologi operasional audit — RSUD Contoh Sejahtera"
CLAIMS_LINK = "Klaim JKN di faskes audit (demo)"
ALERT_LINK = "Peringatan untuk klaim (demo)"


def _link_id(name: str) -> Optional[str]:
    return next((x["id"] for x in ontology._all("link-types") if x.get("display_name") == name), None)


def _ensure_vertex_ops() -> list[str]:
    import vertex

    fk, ks, dk = jm._type(jm.FASKES), jm._type(jm.KASUS), jm._type(jm.DOKTER)
    kl, al = jm._type("Klaim JKN (demo)"), jm._type("Peringatan Risiko JKN (demo)")
    l_claim, l_alert = _link_id(CLAIMS_LINK), _link_id(ALERT_LINK)
    graphs = {g["name"]: g for g in vertex.list_graphs()}
    made = []
    layers = {
        fk["id"]: {"color": "#22c55e", "label_property": "nama", "size_property": "skor_risiko",
                   "rules": [{"property": "status_audit", "op": "eq", "value": st, "color": jm.STATUS[st][0]} for st in jm.STATUS if st != "Sehat"]},
        ks["id"]: {"color": "#f97316", "label_property": "jenis_kasus", "size_property": "nilai_klaim_rp",
                   "rules": [{"property": "status_kasus", "op": "eq", "value": "Dalam Investigasi", "color": "#ef4444"}]},
        dk["id"]: {"color": "#38bdf8", "label_property": "nama",
                   "rules": [{"property": "peran_dalam_kasus", "op": "eq", "value": "DPJP, perujuk", "color": "#e879f9"}]},
    }
    if kl:
        layers[kl["id"]] = {"color": "#a78bfa", "label_property": "no_sep", "size_property": "tarif_rs",
                            "rules": [{"property": "status_verifikasi", "op": "eq", "value": "ditolak", "color": "#ef4444"},
                                      {"property": "status_verifikasi", "op": "eq", "value": "ditunda", "color": "#f59e0b"}]}
    if al:
        layers[al["id"]] = {"color": "#ef4444", "label_property": "judul", "rules": [{"property": "tingkat", "op": "eq", "value": "warning", "color": "#f59e0b"}]}
    if G_OPS not in graphs:
        nodes, seen = [], set()

        def add(tid: str, pk: str) -> None:
            if (tid, pk) not in seen:
                seen.add((tid, pk))
                nodes.append({"object_type_id": tid, "primary_key": pk})

        add(fk["id"], "RS-01")
        for pk, o in sorted(ontology.stored_objects(ks["id"]).items()):
            p = o.get("properties") or {}
            if "RS-01" in (p.get("faskes_asal"), p.get("faskes_tujuan")):
                add(fk["id"], p["faskes_asal"])
                add(ks["id"], pk)
                add(fk["id"], p["faskes_tujuan"])
                add(dk["id"], p["dokter_perujuk"])
                add(dk["id"], p["dokter_dpjp"])
        if kl:
            alerts = ontology.stored_objects(al["id"]) if al else {}
            for pk, o in sorted(ontology.stored_objects(kl["id"]).items()):
                p = o.get("properties") or {}
                if p.get("faskes") == "RS-01" and p.get("kategori_risiko"):
                    add(kl["id"], pk)
                    if f"PR-{pk}" in alerts:
                        add(al["id"], f"PR-{pk}")
        vertex.create_graph(vertex.GraphIn(
            name=G_OPS, layout="hierarchy_lr", layers=layers, nodes=nodes,
            edge_styles={x: {"color": "#38bdf8", "dashed": True} for x in (_link_id(jm.L_PERUJUK), _link_id(jm.L_DPJP)) if x},
            description="Demo: satu faskes melewati semua lapisan ontologi — kasus rujukan berisiko (faskes asal → kasus → RS), dokter perujuk dan "
                        "DPJP (ungu muda = perujuk sekaligus DPJP), klaim JKN yang ditandai aturan skrining (ungu; merah = ditolak, kuning = ditunda) "
                        "dan peringatan risikonya di timeline. Pilih node lalu jalankan function (dokter_di_balik_kasus, alasan_risiko …) dari "
                        "Search Around."))
        made.append(G_OPS)
    tpl = graphs.get(jm.G_TEMPLATE)
    if tpl and l_claim:
        g = vertex.get_graph(tpl["id"])
        param = (g.get("template") or {}).get("parameters", [{}])[0]
        arounds = param.get("search_arounds") or []
        if not any(st.get("steps", [{}])[0].get("link_type_id") == l_claim for st in arounds):
            arounds.append({"steps": [{"link_type_id": l_claim, "direction": "reverse", "filters": [{"property": "kategori_risiko", "op": "not_null"}]}]})
            if l_alert:
                arounds.append({"steps": [{"link_type_id": l_claim, "direction": "reverse", "filters": [{"property": "kategori_risiko", "op": "not_null"}]},
                                          {"link_type_id": l_alert, "direction": "reverse"}]})
            param["search_arounds"] = arounds
            g["layers"] = {**(g.get("layers") or {}), **{k: v for k, v in layers.items() if k not in (g.get("layers") or {})}}
            vertex.save_graph(tpl["id"], vertex.GraphIn(**{k: v for k, v in g.items() if k in vertex.GraphIn.model_fields}))
            made.append(f"{jm.G_TEMPLATE}: klaim + peringatan")
    return made


# ------------------------------------------------------------------------------------------------
# Vertex: readable layouts — system flow with a column per object type (doctor → case → facility → claim → alert)
# ------------------------------------------------------------------------------------------------

def _tidy_vertex() -> list[str]:
    import vertex

    fk, ks, dk = jm._type(jm.FASKES), jm._type(jm.KASUS), jm._type(jm.DOKTER)
    kl, al = jm._type("Klaim JKN (demo)"), jm._type("Peringatan Risiko JKN (demo)")
    columns = {dk["id"]: 0, ks["id"]: 1, fk["id"]: 2, **({kl["id"]: 3} if kl else {}), **({al["id"]: 4} if al else {})}
    want = {G_OPS: "flow", jm.G_ALUR: "flow", jm.G_TEMPLATE: "flow", jm.G_ALIRAN: "auto"}
    done = []
    for row in vertex.list_graphs():
        layout = want.get(row["name"])
        if not layout:
            continue
        g = vertex.get_graph(row["id"])
        layers = {tid: ({**layer, "column": columns[tid]} if tid in columns and layout == "flow" else layer) for tid, layer in (g.get("layers") or {}).items()}
        nodes = [{k: v for k, v in n.items() if k not in ("x", "y")} for n in g.get("nodes") or []]
        if g.get("layout") == layout and layers == g.get("layers") and nodes == g.get("nodes") and g.get("line_type") == "curved":
            continue
        g.update(layout=layout, layers=layers, nodes=nodes, line_type="curved")
        vertex.save_graph(row["id"], vertex.GraphIn(**{k: v for k, v in g.items() if k in vertex.GraphIn.model_fields}))
        done.append(row["name"])
    return done


# ------------------------------------------------------------------------------------------------
# decisions: a few audit-team actions applied once, so the action log shows decisions winning over the data
# ------------------------------------------------------------------------------------------------

DECISIONS = [
    ("Minta klarifikasi dokter (demo)", "D-05",
     {"status_klarifikasi": "Diminta klarifikasi — perujuk sekaligus DPJP di Klinik Utama Contoh Medika (KRB-001); surat 10 Okt 2026"}),
    ("Tindak lanjut kasus rujukan (demo)", "KRB-002",
     {"status_kasus": "Klarifikasi faskes", "tindak_lanjut": "Surat klarifikasi ke Puskesmas Contoh Barat: rujukan diagnosis kompetensi FKTP berulang dari dokter yang sama; "
                                                             "minta bukti indikasi medis per SEP."}),
    ("Eskalasi ke tim investigasi (demo)", "KLU-07",
     {"status_audit": "Dalam Investigasi", "prioritas": "P1 — segera", "tim_audit": "Tim Investigasi Kedeputian Wilayah",
      "catatan_audit": "Self-referral: dr. Dian Rahayu (Puskesmas Contoh Barat) merujuk pasiennya ke klinik yang ia jalankan sendiri, lalu menjadi DPJP. "
                       "Dieskalasi dari 'Ada Indikasi Fraud' menunggu klarifikasi dokter."}),
]


def _seed_decisions() -> Optional[list[str]]:
    if STATE.get("decisions_seeded"):
        return None
    done = []
    for name, pk, values in DECISIONS:
        a = _action(name)
        if not a:
            continue
        hook = ontology.MODEL_HOOKS.get("apply_action")
        if hook:
            hook(a, {"object": pk, **values})
        else:
            ontology.run_action(a, {"object": pk, **values}, source="demo-jkn-e2e")
        done.append(f"{name} → {pk}")
    STATE["decisions_seeded"] = datetime.now(timezone.utc).isoformat()
    _save()
    return done


def _run_pk(v: Any) -> str:
    """An action run's object parameter: an object reference ({primary_key, …}) or a bare key."""
    return str(v.get("primary_key")) if isinstance(v, dict) else str(v)


def _backfill_decision_history() -> list[str]:
    """Decisions seeded before edit history was on have no history entries: write them from the action runs (the run's
    user and time, each changed property's value before the run and the value the run set)."""
    import ontology_edits as oe

    done = []
    for name, pk, _values in DECISIONS:
        a = _action(name)
        if not a or not a.get("object_type_id"):
            continue
        tid = a["object_type_id"]
        if not oe.config(ontology._object_type(tid))["history"]:
            continue
        hist = oe._read(oe._history_path(tid), {}) or {}
        if hist.get(pk):
            continue
        runs = ontology._read(ontology._path("action-runs", a["id"])) or []
        runs = runs if isinstance(runs, list) else runs.get("runs", [])
        run = next((r for r in runs if r.get("status") == "succeeded" and _run_pk((r.get("parameters") or {}).get("object")) == pk), None)
        if not run:
            continue
        before = ((run.get("before") or {}).get(f"{tid}|{pk}") or {}).get("properties") or {}
        props = {p["id"]: p.get("property") for p in a.get("parameters") or [] if p.get("property")}
        changes = {props[k]: [before.get(props[k]), v] for k, v in (run.get("parameters") or {}).items() if k in props and before.get(props[k]) != v}
        hist[pk] = [{"at": run["at"], "user": run.get("user") or "system", "op": "modify", "changes": changes}]
        oe._write(oe._history_path(tid), hist)
        done.append(f"{name} → {pk}")
    return done


def _decisions() -> list[dict]:
    """The audit team's edits on the audit types (they win over the pipeline's data)."""
    import ontology_edits

    import demo_jkn_iot as iot
    import demo_jkn_iot_nasional as nas

    out = []
    for name in (jm.FASKES, jm.KASUS, jm.DOKTER, iot.TEMUAN, nas.RS):
        t = jm._type(name)
        if not t:
            continue
        objs = ontology.stored_objects(t["id"])
        for pk, e in ontology_edits.layer(t["id"]).items():
            props = e.get("properties") or {}
            if not props:
                continue
            o = (objs.get(pk) or {}).get("properties") or {}
            at = max((v for v in (e.get("prop_at") or {}).values() if isinstance(v, str)), default=e.get("at") or "")
            out.append({"type": name, "type_id": t["id"], "pk": pk, "title": o.get(t.get("title_property") or "") or pk, "properties": props, "at": at})
    return sorted(out, key=lambda x: x["at"] or "", reverse=True)[:20]


# ------------------------------------------------------------------------------------------------
# Workshop: the audit team's cockpit on the same objects (pick a facility → why → decide)
# ------------------------------------------------------------------------------------------------

WORKSHOP = "Demo: Kokpit audit faskes JKN"
# the cockpit's grid (rows are 44 px): a metric needs 3 rows for its title, label, number and row count; a filter 2
COCKPIT = {"": (0, 0, 12, 2), "Faskes dipantau": (0, 2, 3, 3), "Ada indikasi fraud": (3, 2, 3, 3), "Dalam investigasi": (6, 2, 3, 3),
           "Potensi kerugian (Rp)": (9, 2, 3, 3), "Kantor cabang": (0, 5, 4, 2), "Jenis faskes": (4, 5, 4, 2), "Indikasi utama": (8, 5, 4, 2),
           "Faskes per status audit": (0, 7, 4, 6), "Faskes (urut skor risiko)": (4, 7, 8, 6), "Mengapa faskes ini berisiko? (ƒ alasan_risiko)": (0, 13, 7, 6),
           "Keputusan tim audit": (7, 13, 5, 6), "Kasus rujukan berisiko": (0, 19, 12, 6)}


# what each widget says under its title (a metric's label), the filters' labels and the money format
RP = {"": {"prefix": "Rp ", "notation": "compact", "max_fraction": 1}}
COCKPIT_CONFIG = {"Faskes dipantau": {"label": "faskes dalam pantauan audit"}, "Ada indikasi fraud": {"label": "status audit: Ada Indikasi Fraud"},
                  "Dalam investigasi": {"label": "status audit: Dalam Investigasi"},
                  "Potensi kerugian (Rp)": {"label": "jumlah potensi kerugian semua faskes", "formats": RP},
                  "Kantor cabang": {"label": "Kantor cabang"}, "Jenis faskes": {"label": "Jenis faskes"}, "Indikasi utama": {"label": "Indikasi utama"}}


def _tidy_workshop() -> Optional[list[str]]:
    """The cockpit laid out on COCKPIT (an earlier version gave metrics 2 rows and filters 1: their content was cut off),
    its labels and formats from COCKPIT_CONFIG, and the facility it opens on (RSUD Contoh Sejahtera), so the risk
    explanation and the decision form show something before anyone clicks a row."""
    import workshop

    m = next((x for x in workshop.list_modules() if x.get("name") == WORKSHOP), None)
    if not m:
        return None
    full = workshop.get_module(m["id"], count=False)
    widgets, changed = [], []
    for w in full.get("widgets") or []:
        title = w.get("title") or ""
        geo = COCKPIT.get(title)
        if geo and (w.get("x"), w.get("y"), w.get("w"), w.get("h")) != geo:
            w = {**w, "x": geo[0], "y": geo[1], "w": geo[2], "h": geo[3]}
            changed.append(f"{title or 'teks'}: tata letak")
        want = COCKPIT_CONFIG.get(title) or {}
        if any((w.get("config") or {}).get(k) != v for k, v in want.items()):
            w = {**w, "config": {**(w.get("config") or {}), **want}}
            changed.append(f"{title}: label / format")
        widgets.append(w)
    settings = dict(full.get("settings") or {})
    fk = jm._type(jm.FASKES)
    sel = {f"object_type:{fk['id']}": "RS-01"} if fk else {}
    if sel and settings.get("default_selection") != sel:
        settings["default_selection"] = sel
        changed.append("pilihan awal: RSUD Contoh Sejahtera")
    if changed:
        workshop.save_module(m["id"], workshop.ModuleIn(widgets=widgets, settings=settings,
                                                        version_note="Kokpit rapi: tata letak, label metrik & saringan, format rupiah, faskes awal terpilih"))
    return changed


def _ensure_workshop() -> Optional[str]:
    import functions_registry as fr
    import workshop

    if any(m.get("name") == WORKSHOP for m in workshop.list_modules()):
        return None
    fk, ks = jm._type(jm.FASKES), jm._type(jm.KASUS)
    src = {"kind": "object_type", "id": fk["id"]}
    ksrc = {"kind": "object_type", "id": ks["id"]}
    fn = next((f for f in fr.all_functions() if f.get("repo_id") == STATE.get("functions_repo_id") and f["name"] == "alasan_risiko"), None)
    acts = [a["id"] for a in (_action(n) for n in ("Eskalasi ke tim investigasi (demo)", "Tetapkan status audit faskes (demo)", "Tutup audit dan catat pengembalian (demo)")) if a]
    w = []

    def add(kind: str, title: str, x: int, y: int, wd: int, h: int, config: dict) -> None:
        x, y, wd, h = COCKPIT.get(title, (x, y, wd, h))
        w.append({"id": f"w{len(w) + 1}", "type": kind, "title": title, "x": x, "y": y, "w": wd, "h": h, "config": {**config, **COCKPIT_CONFIG.get(title, {})}})

    add("text", "", 0, 0, 12, 1, {"text": "**Kokpit audit faskes JKN** — pilih faskes di tabel: penjelasan risikonya (function `alasan_risiko`) dan keputusan tim audit (actions) "
                                          "mengikuti pilihan itu. Klik batang grafik untuk menyaring semua widget. Data: pipeline audit faskes JKN (demo)."})
    for i, (label, flt) in enumerate((("Faskes dipantau", None), ("Ada indikasi fraud", "Ada Indikasi Fraud"), ("Dalam investigasi", "Dalam Investigasi"))):
        add("metric", label, i * 3, 1, 3, 2, {"source": src, "metric": "count", "label": label,
                                               **({"filters": [{"column": "status_audit", "op": "eq", "value": flt}]} if flt else {})})
    add("metric", "Potensi kerugian (Rp)", 9, 1, 3, 2, {"source": src, "metric": "sum", "metric_column": "potensi_kerugian_rp", "label": "Potensi kerugian (Rp)"})
    add("filter", "Kantor cabang", 0, 3, 4, 1, {"source": src, "column": "kantor_cabang", "label": "kantor cabang"})
    add("filter", "Jenis faskes", 4, 3, 4, 1, {"source": src, "column": "jenis", "label": "jenis faskes"})
    add("filter", "Indikasi utama", 8, 3, 4, 1, {"source": src, "column": "indikasi_utama", "label": "indikasi"})
    add("bar", "Faskes per status audit", 0, 4, 4, 6, {"source": src, "group_by": "status_audit", "metric": "count"})
    add("table", "Faskes (urut skor risiko)", 4, 4, 8, 6, {"source": src, "sort": "skor_risiko", "descending": True, "limit": 100,
                                                           "columns": ["nama", "jenis", "status_audit", "skor_risiko", "indikasi_utama", "potensi_kerugian_rp", "tim_audit"]})
    if fn:
        add("function", "Mengapa faskes ini berisiko? (ƒ alasan_risiko)", 0, 10, 7, 6,
            {"function_id": fn["id"], "object_type_id": fk["id"], "object_input": "faskes", "function_inputs": {}})
    if acts:
        add("inline_action", "Keputusan tim audit", 7, 10, 5, 6, {"action_ids": acts, "action_type_id": acts[0]})
    add("table", "Kasus rujukan berisiko", 0, 16, 12, 6, {"source": ksrc, "sort": "nilai_klaim_rp", "descending": True, "limit": 100,
                                                          "columns": ["id_kasus", "jenis_kasus", "alur", "nama_dokter_perujuk", "nama_dokter_dpjp", "jumlah_klaim", "nilai_klaim_rp", "status_kasus"]})
    m = workshop.create_module(workshop.ModuleIn(name=WORKSHOP, widgets=w, folder_id=STATE.get("project_id"),
                                                 description="Demo: kokpit tim audit JKN di atas ontologi audit faskes — metrik, saringan, faskes per status, penjelasan "
                                                             "risiko per faskes (function) dan keputusan (actions), serta kasus rujukan berisiko."))
    STATE["workshop_id"] = m["id"]
    _save()
    return m["id"]


def _tidy_project() -> list[str]:
    """One project for the whole demo, kept tidy: data in raw/ clean/ ml/ iot/, the pipelines in pipelines/, the
    Workshop module and the OSDK application in apps/ (moved: their ids, links and references stay)."""
    import db
    import drive

    project = _folder(None, PROJECT, "project")
    pipes, apps = _folder(project, "pipelines"), _folder(project, "apps")
    moved = []
    for c in db.drive_list(project):
        if c.get("trashed_at"):
            continue
        if c["kind"] in drive.CONTAINERS and c["name"].startswith("Pipeline "):
            target = pipes
        elif c["kind"] == "file" and c["name"].endswith((".workshop", ".devconsole")):
            target = apps
        else:
            continue
        db.drive_update(c["id"], drive._now(), parent_id=target)
        moved.append(c["name"])
    return moved


def _iot_step() -> dict:
    import demo_jkn_iot

    res = demo_jkn_iot.build(STATE, _save)
    STATE["iot"] = {k: v for k, v in res.items() if k in ("pipeline_id", "sync_id", "machinery", "temuan")}
    return res


def _iot_nasional_step() -> dict:
    import demo_jkn_iot_nasional

    res = demo_jkn_iot_nasional.build(STATE, _save)
    STATE["iot_nasional"] = {k: v for k, v in res.items() if k in ("pipeline_id", "sync_id", "nasional", "hotspot", "map", "vertex")}
    return res


PORTAL_APP = "Ruang Kerja Audit Faskes JKN"


def _ensure_portal_apps() -> dict:
    """The audit workspace (/demo-jkn/audit) as an OSDK React application — Application Building → Developer Console:
    an application in the demo project whose scopes are the audit object types, its actions and functions — listed
    under Agentic Apps in the Applications Portal, beside the Workshop cockpit."""
    import agentic_apps
    import developer_console as dc
    import functions_registry as fr

    app = None
    if STATE.get("dc_app_id"):
        try:
            app = dc._app(STATE["dc_app_id"])
            if not dc._alive(app):
                app = None
        except Exception:  # noqa: BLE001
            app = None
    if app is None:
        app = dc.create_app(dc.AppIn(name=PORTAL_APP, folder_id=STATE["project_id"],
                                     description="Demo: ruang kerja tim audit JKN — antrean prioritas (aturan + ML), berkas faskes, pola baru dan keputusan audit."))
        STATE["dc_app_id"] = app["id"]
        _save()
    import demo_jkn_iot as iot
    import demo_jkn_iot_nasional as nas

    types = [t["id"] for t in (jm._type(n) for n in (jm.FASKES, jm.KASUS, jm.DOKTER, iot.ALAT, iot.TEMUAN, iot.TINDAKAN, nas.WILAYAH, nas.RS)) if t]
    acts = [a["id"] for a in (_action(n) for n in [*(n for n, *_ in ACTIONS), iot.ACTION, nas.ACTION]) if a]
    fns = [f["id"] for f in fr.all_functions() if STATE.get("functions_repo_id") and f.get("repo_id") == STATE["functions_repo_id"]]
    dc.set_resources(app["id"], dc.ResourcesIn(object_types=types, action_types=acts, functions=fns))
    listed = [agentic_apps.register(agentic_apps.AppIn(
        name=PORTAL_APP, kind="osdk", resource_id=app["id"], href="/demo-jkn/audit", icon="table", collection="Audit JKN",
        description="Antrean faskes yang perlu diaudit (skor aturan + deteksi anomali ML), berkas tiap faskes, pola baru dan keputusan tim audit.",
        tags=["JKN", "audit", "demo"]))["id"]]
    if STATE.get("workshop_id"):
        listed.append(agentic_apps.register(agentic_apps.AppIn(
            name="Kokpit Audit Faskes JKN", kind="workshop", resource_id=STATE["workshop_id"], icon="gauge", collection="Audit JKN",
            description="Kokpit Workshop: metrik, saringan, faskes per status, penjelasan risiko (function) dan keputusan (actions).",
            tags=["JKN", "audit", "demo"]))["id"])
    return {"developer_console_app": app["id"], "objects": len(types), "actions": len(acts), "functions": len(fns), "listed": listed}


LINEAGE_GRAPH = "jknaudit"


def _governance_step() -> dict:
    """Security and governance of the demo data (demo_jkn_governance.py): identity scanned, marked, pseudonymised with Cipher,
    property policies, checkpoints, retention."""
    import demo_jkn_governance as g

    return g.build(STATE, _save)


def _ensure_lineage_graph() -> dict:
    """The case in Data Lineage as a saved graph (/lineage?graph=jknaudit): everything upstream of the three audit object
    types (raw files → pipeline → clean datasets, the ML features, model and scoring pipeline) and everything built on
    them (actions, functions, the Workshop cockpit, Vertex graphs, the map, the OSDK application)."""
    import lineage

    g = lineage.graph()
    nodes = {n["id"]: n for n in g["nodes"]}
    up: dict[str, set] = {}
    down: dict[str, set] = {}
    for e in g["edges"]:
        down.setdefault(e["from"], set()).add(e["to"])
        up.setdefault(e["to"], set()).add(e["from"])

    def walk(start: list[str], nbrs: dict[str, set]) -> set[str]:
        seen: set[str] = set()
        todo = list(start)
        while todo:
            for w in nbrs.get(todo.pop(), ()):
                if w not in seen:
                    seen.add(w)
                    todo.append(w)
        return seen

    import demo_jkn_iot as iot
    import demo_jkn_iot_nasional as nas

    seeds = [nid for nid, n in nodes.items() if n["kind"] == "object_type"
             and n["name"] in (jm.FASKES, jm.KASUS, jm.DOKTER, iot.ALAT, iot.TEMUAN, iot.TINDAKAN, nas.WILAYAH, nas.RS)]
    desc = walk(seeds, down)
    case = set(seeds) | walk(seeds, up) | desc
    # what feeds the apps and functions besides the audit types: the model behind a model function, the actions on a module
    for v in list(desc):
        case |= {w for w in up.get(v, ()) if nodes[w]["kind"] in ("model", "function", "action", "transform")}
    rec = lineage.save_graph(lineage.SavedGraph(name="Lineage audit faskes JKN (demo)", nodes=sorted(case), color_by="type"), id=LINEAGE_GRAPH)
    kinds: dict[str, int] = {}
    for v in case:
        kinds[nodes[v]["kind"]] = kinds.get(nodes[v]["kind"], 0) + 1
    return {"graph": rec["id"], "nodes": len(case), "kinds": kinds}


# ------------------------------------------------------------------------------------------------
# build, status, and the ontology the overview page draws
# ------------------------------------------------------------------------------------------------


@router.post("")
def build() -> dict:
    """Build (or complete) the end-to-end demo; nothing existing is changed or deleted."""
    with _lock:
        steps: list[dict] = []

        def step(key: str, fn) -> Any:
            try:
                out = fn()
                steps.append({"step": key, "ok": True, "result": out})
                return out
            except Exception as e:  # noqa: BLE001
                log.exception("demo e2e: %s failed", key)
                steps.append({"step": key, "ok": False, "error": str(getattr(e, "detail", e))[:500]})
                return None

        step("ontology", lambda: {k: v for k, v in jm.build().items() if k != "map_id"})
        step("edit_properties", _ensure_edit_props)
        files = step("files", _ensure_files)
        if files:
            STATE.update(project_id=files["project_id"], raw=files["raw"], clean=files["clean"], rows=files["rows"])
            step("datasource", lambda: [_attach(n, files["clean"][d]) for n, d in ((jm.FASKES, "faskes_audit"), (jm.KASUS, "kasus_berisiko"), (jm.DOKTER, "dokter_audit"))])
            step("reset_creation_edits", _reset_creation_edits)
            step("pipeline", lambda: _ensure_pipeline(files))
            step("pipeline_sql", _sync_pipeline_sql)
            step("new_columns", _sync_columns)
        step("map_flows", _ensure_map_flows)
        step("vertex", _ensure_vertex_ops)
        step("vertex_layout", _tidy_vertex)
        step("workshop", _ensure_workshop)
        step("workshop_layout", _tidy_workshop)

        def ml_step():
            import demo_jkn_ml

            res = demo_jkn_ml.build(STATE, _save)
            STATE.update(ml={k: v for k, v in res.items() if k != "experiment"}, ml_experiment=res.get("experiment"))
            return {k: v for k, v in res.items() if k != "experiment"}

        step("ml", ml_step)
        step("actions", _ensure_actions)
        step("edit_history", _enable_history)
        # after edit history is on (seeded earlier, the decisions had no history; those are backfilled from their runs)
        step("decisions", _seed_decisions)
        step("decision_history", _backfill_decision_history)
        step("claims_link", _ensure_claims_link)
        fn = step("functions", _ensure_functions)
        if fn:
            STATE.update(functions_repo_id=fn["repo_id"])
        step("iot", _iot_step)
        step("iot_nasional", _iot_nasional_step)
        step("portal_apps", _ensure_portal_apps)
        step("lineage_graph", _ensure_lineage_graph)
        step("governance", _governance_step)
        # access per account: demo accounts, row and property rules, the access pipeline, restricted views (demo_jkn_akses.py)
        step("akses", lambda: __import__("demo_jkn_akses").build())
        step("tidy_project", _tidy_project)
        STATE.update(built_at=datetime.now(timezone.utc).isoformat(), steps=steps)
        _save()
    return status()


def _build_status() -> Optional[dict]:
    import pipeline_runtime as rt

    pid = STATE.get("pipeline_id")
    if not pid:
        return None
    try:
        b = next(iter(rt._builds(pid, 1)), None)
    except Exception:  # noqa: BLE001
        return None
    return b and {"id": b["id"], "status": b["status"], "created_at": b.get("created_at"), "finished_at": b.get("finished_at"), "error": b.get("error")}


@router.get("")
def status() -> dict:
    return {**{k: v for k, v in STATE.items() if k != "steps"}, "steps": [{k: v for k, v in s.items() if k != "result"} for s in STATE.get("steps") or []],
            "build": _build_status()}


def _functions_on(type_ids: dict[str, str]) -> list[dict]:
    """The published functions of the demo repository with the object type each takes and returns."""
    import functions_registry as fr

    rid = STATE.get("functions_repo_id")
    if not rid:
        return []
    by_api = {v: k for k, v in type_ids.items()}
    out = []
    for f in fr.all_functions():
        if f.get("repo_id") != rid:
            continue
        inp = next((str(i["type"]) for i in f.get("inputs") or [] if str(i.get("type", "")).startswith("object:")), "")
        output = str(f.get("output") or "")
        ret = output.split(":", 1)[1].rstrip(">") if "object:" in output else None
        out.append({"id": f["id"], "name": f["name"], "doc": f.get("doc") or "", "version": f.get("version"), "output": output,
                    "input_type": by_api.get(inp.split(":", 1)[1] if inp else ""), "returns_type": by_api.get(ret or ""),
                    "kind": "search_around" if ret else "derived"})
    return out


def _summary() -> dict:
    """What the audit team sees: facilities per status, value at risk, cases per subcategory, top risks."""
    fk, ks, dk = jm._type(jm.FASKES), jm._type(jm.KASUS), jm._type(jm.DOKTER)
    if not (fk and ks and dk):
        return {}
    faskes = [o.get("properties") or {} for o in ontology.stored_objects(fk["id"]).values()]
    kasus = [o.get("properties") or {} for o in ontology.stored_objects(ks["id"]).values()]
    dokter = [o.get("properties") or {} for o in ontology.stored_objects(dk["id"]).values()]
    per_type: dict[str, dict] = {}
    for k in kasus:
        r = per_type.setdefault(k.get("jenis_kasus") or "-", {"jenis": k.get("jenis_kasus") or "-", "kasus": 0, "klaim": 0, "nilai": 0.0})
        r["kasus"] += 1
        r["klaim"] += int(k.get("jumlah_klaim") or 0)
        r["nilai"] += float(k.get("nilai_klaim_rp") or 0)
    top = sorted(faskes, key=lambda f: -(f.get("skor_risiko") or 0))[:6]
    return {
        "faskes": len(faskes), "per_status": {st: sum(1 for f in faskes if f.get("status_audit") == st) for st in jm.STATUS},
        "potensi_kerugian_rp": sum(float(f.get("potensi_kerugian_rp") or 0) for f in faskes),
        "pengembalian_rp": sum(float(f.get("pengembalian_rp") or 0) for f in faskes),
        "kasus": len(kasus), "klaim_berisiko": sum(int(k.get("jumlah_klaim") or 0) for k in kasus),
        "dokter_terlibat": sum(1 for d in dokter if (d.get("jumlah_kasus") or 0) > 0),
        "self_referral_dokter": sum(1 for d in dokter if d.get("peran_dalam_kasus") == "DPJP, perujuk"),
        "kasus_per_jenis": sorted(per_type.values(), key=lambda r: -r["nilai"]),
        "top_faskes": [{k: f.get(k) for k in ("kode", "nama", "jenis", "status_audit", "skor_risiko", "indikasi_utama", "potensi_kerugian_rp")} for f in top],
        "subkategori": jm.FKRTL_RISKS + jm.FKTP_RISKS,
    }


@router.get("/ontology")
def ontology_map() -> dict:
    """The audit Ontology as a diagram: object types (counts, backing datasets), link types, action types and
    functions per type, plus the pipeline and the apps built on it."""
    import vertex

    import demo_jkn_pipeline as dp

    names = [jm.FASKES, jm.KASUS, jm.DOKTER, "Klaim JKN (demo)", "Peringatan Risiko JKN (demo)"]
    types, nodes, links, actions = _ontology_part(names, core=names[:3])
    graphs = {g["name"]: g["id"] for g in vertex.list_graphs()}
    import geospatial

    maps = {m["name"]: m["id"] for m in geospatial.list_maps()}
    return {
        "summary": _summary(), "decisions": _decisions(), "ml": _ml_overview(), "object_types": nodes, "link_types": links, "action_types": actions,
        "functions": _functions_on({t["id"]: t["api_name"] for t in types}),
        "pipeline": {"id": STATE.get("pipeline_id"), "name": PIPELINE, "raw": [n["name"] for n in dp.spec() if n["kind"] == "source"],
                     "outputs": [o[0] for o in dp.OUTPUTS], "graph": dp.lineage(),
                     "backs": {"faskes_audit": jm.FASKES, "kasus_berisiko": jm.KASUS, "dokter_audit": jm.DOKTER},
                     "rows": STATE.get("rows") or {}, "sql": {n["name"]: n["sql"] for n in dp.spec() if n["kind"] == "sql"},
                     "build": _build_status()},
        "project_id": STATE.get("project_id"), "functions_repo_id": STATE.get("functions_repo_id"),
        "apps": {"map": maps.get(jm.MAP), "graph_alur": graphs.get(jm.G_ALUR), "graph_aliran": graphs.get(jm.G_ALIRAN), "template": graphs.get(jm.G_TEMPLATE),
                 "graph_ops": graphs.get(G_OPS), "workshop": STATE.get("workshop_id")},
        "iot": _iot_overview(),
    }


def _ontology_part(names: list[str], core: list[str]) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """Object types (by name) with their properties and backing dataset, the link types among them, their actions."""
    types = [t for t in (jm._type(n) for n in names) if t]
    ids = {t["id"] for t in types}
    nodes = []
    for t in types:
        rec = ontology._object_type(t["id"])
        b = rec.get("backing_dataset") or {}
        nodes.append({"id": t["id"], "name": t["display_name"], "api_name": t["api_name"], "color": t.get("color"), "icon": t.get("icon"),
                      "description": t.get("description") or "", "objects": len(ontology.stored_objects(t["id"])),
                      "properties": [{"api_name": p["api_name"], "display_name": p["display_name"], "type": p["type"]} for p in rec["properties"]],
                      "dataset": b.get("name"), "dataset_id": b.get("dataset_id"), "core": t["display_name"] in core})
    links = [{"id": lt["id"], "name": lt.get("display_name") or "", "source": lt["source"]["object_type_id"], "target": lt["target"]["object_type_id"],
              "foreign_key": lt.get("foreign_key"), "cardinality": lt.get("cardinality")}
             for lt in ontology._all("link-types") if lt["source"]["object_type_id"] in ids and lt["target"]["object_type_id"] in ids]
    actions = [{"id": a["id"], "name": a["display_name"], "object_type_id": a.get("object_type_id"), "description": a.get("description") or "",
                "parameters": [p.get("display_name") for p in a.get("parameters") or [] if p.get("id") != "object"]}
               for a in ontology._all("action-types") if a.get("object_type_id") in ids]
    return types, nodes, links, actions


def _iot_overview() -> Optional[dict]:
    """The IoT layer for the overview page: its piece of the Ontology, the pilot's numbers, the pipeline and the apps."""
    import demo_jkn_iot as iot
    import demo_jkn_workbench as wb

    if not jm._type(iot.ALAT):
        return None
    names = [jm.FASKES, jm.DOKTER, iot.ALAT, iot.TEMUAN, iot.TINDAKAN]
    _types, nodes, links, actions = _ontology_part(names, core=names)
    try:
        ov = wb.iot_overview()
    except Exception:  # noqa: BLE001
        return None
    by_status: dict[str, int] = {}
    for m in ov["matrix"]:
        for c in m["cells"]:
            if c:
                by_status[c["status"]] = by_status.get(c["status"], 0) + 1
    return {"object_types": nodes, "link_types": links, "action_types": actions, "kpi": ov["kpi"], "apps": ov["apps"], "status": by_status,
            "rows": (STATE.get("iot") or {}).get("temuan"), "nodes": [{"id": n["id"], "name": n["name"], "kind": n["kind"], "group": n["group"]} for n in iot.nodes()],
            "outputs": [o[0] for o in iot.OUTPUTS], "sql": {n["name"]: n["sql"] for n in iot.nodes() if n["kind"] == "sql"},
            "contoh": next((t for t in ov["temuan"] if t["id_temuan"] == "IOT-RS-01-RONTGEN-2026-09-15"), None), "nasional": _iot_national_overview()}


def _iot_national_overview() -> Optional[dict]:
    """The national network's headline for the overview page (the workspace's national tab has the rest)."""
    import demo_jkn_workbench as wb

    try:
        n = wb.national("ID")
    except Exception:  # noqa: BLE001 - the national layer is not built
        return None
    w = n["wilayah"]
    return {"wilayah": {k: w.get(k) for k in ("rs_total", "rs_terhubung", "cakupan_pct", "alat_bermeter", "klaim_terpantau_14h", "tak_didukung_14h",
                                              "nilai_tak_didukung_rp", "rasio_tak_didukung_pct", "rs_prioritas", "rs_perhatian", "rs_data_kurang", "kelengkapan_pct")},
            "provinsi": len({x["induk"] for x in n["peta"]["kabkota"]}), "kabkota": len(n["peta"]["kabkota"]),
            "kedeputian": [{k: c.get(k) for k in ("id_wilayah", "nama", "cakupan_pct", "rs_prioritas", "nilai_tak_didukung_rp", "status_wilayah")} for c in n["anak"]],
            "hotspot": [{k: h.get(k) for k in ("id_wilayah", "nama", "rs_prioritas", "rs_terhubung", "nilai_tak_didukung_rp")} for h in n["hotspot"]],
            "skala": n["skala"], "apps": n["apps"], "status_rs": n["status_rs"]}


# ------------------------------------------------------------------------------------------------
# the anomaly detection layer for the overview page
# ------------------------------------------------------------------------------------------------


def _ml_overview() -> Optional[dict]:
    """The ML chain's resources, the experiment's AUROC table and the ranked doctors (from the Dokter objects)."""
    import json as _json

    ml = STATE.get("ml") or {}
    if not ml:
        return None
    dk = jm._type(jm.DOKTER)
    doctors = []
    for pk, o in ontology.stored_objects(dk["id"]).items():
        p = o.get("properties") or {}
        if p.get("skor_anomali") is None:
            continue
        try:
            reasons = _json.loads(p.get("alasan_anomali") or "[]")
        except ValueError:
            reasons = []
        doctors.append({"id_dokter": pk, "nama": p.get("nama"), "spesialisasi": p.get("spesialisasi"), "nama_faskes": p.get("nama_faskes"),
                        "skor": p.get("skor_anomali"), "suara": p.get("suara_model"), "peringkat": p.get("peringkat_anomali"),
                        "status": p.get("status_anomali"), "jumlah_kasus": p.get("jumlah_kasus"), "alasan": reasons,
                        "skor_gan": p.get("skor_gan"), "skor_isolation_forest": p.get("skor_isolation_forest"), "skor_autoencoder": p.get("skor_autoencoder")})
    doctors.sort(key=lambda d: (d["peringkat"] or 9999, d["id_dokter"]))
    exp = STATE.get("ml_experiment") or {}
    tables = exp.get("tables") or {}
    auroc = tables.get("auroc_embedding_vs_onehot") or {}
    status: dict[str, int] = {}
    for d in doctors:
        status[d["status"] or "-"] = status.get(d["status"] or "-", 0) + 1
    return {**ml, "dokter_type_id": dk["id"], "experiment": {"name": exp.get("name"), "params": exp.get("params"), "created_at": exp.get("created_at"),
                                                            "auroc": [dict(zip(auroc.get("columns") or [], r)) for r in auroc.get("rows") or []]},
            "status": status, "top": doctors[:30], "dokter": len(doctors)}


_DIST: dict = {}


@router.get("/ml/distribusi/{id_dokter}")
def ml_distribution(id_dokter: str) -> dict:
    """A top doctor's category distributions vs the population (the scoring pipeline's distribusi_kategori_anomali)."""
    import io

    import drive
    import pyarrow.parquet as pq

    project = _folder(None, PROJECT, "project")
    folder = _folder(project, "ml")
    item = next((f for f in drive.list_files(folder) if f["name"] == "distribusi_kategori_anomali.parquet" and not f.get("trashed_at")), None)
    if not item:
        return {"rows": []}
    key = (item["id"], str(item.get("updated_at")))
    if _DIST.get("key") != key:
        _DIST.update(key=key, rows=pq.read_table(io.BytesIO(drive.read_bytes(drive._item(item["id"])))).to_pylist())
    rows = [r for r in _DIST["rows"] if r["id_dokter"] == id_dokter]
    by: dict[str, list] = {}
    for r in rows:
        by.setdefault(r["variabel"], []).append(r)
    out = []
    for var, rs in by.items():
        rs.sort(key=lambda r: -abs(r["selisih_porsi"] or 0))
        out.append({"variabel": var, "maks_selisih": max(abs(r["selisih_porsi"] or 0) for r in rs), "kategori": rs[:6]})
    out.sort(key=lambda v: -v["maks_selisih"])
    return {"rows": out[:6]}
