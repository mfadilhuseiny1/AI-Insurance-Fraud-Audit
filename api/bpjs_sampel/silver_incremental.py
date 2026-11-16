"""L1 bronze → L2 silver, incremental per edition (the hybrid MVP, 2026-10-26): process only what changed.

Why: a snapshot build re-reads every edition on every run (silver: minutes), while Data Sampel arrives as
per-edition file drops. The bronze manifest (bronze/_manifest.parquet: file, sha256, rows per edition and
table) says exactly what changed; this runner keeps a state file (silver/_state_incremental.json) of the
manifest signature per (table, edition) and, per run:

1. facts that are row-local (peserta, kunjungan_fktp, diagnosis_sekunder, tindakan_nonkapitasi and the FKRTL
   base) are regenerated only for changed editions, replacing just that edition's silver partition
   (silver/<dataset>/edisi=<edisi>/): rename/cast/label joins from the same bpjs_spec.select_sql the
   snapshot silver and the Code Repository run, so the columns are identical;
2. the stateful FKRTL flags (jumlah diagnosis sekunder, calon klaim ganda, selisih verifikasi, LOS ekstrem
   with its per-INA-CBG p99) are refreshed over the whole FKRTL silver — but reading only the few columns
   they need from the silver Parquet, never the bronze text columns or the twenty label joins again;
3. rujukan is regenerated for the editions whose FKRTL or FKTP side changed (a referral stays inside its
   edition, so partitions stay correct); the dimensions are small (hundreds to thousands of rows) and are
   recomputed whole, from the silver facts, as before;
4. expectations: per changed edition, silver rows = bronze rows; and the FKRTL totals still reconcile with
   bronze. The full snapshot (bpjs_sampel.silver) remains the periodic reconciliation and the fallback:
   when the state file is missing, this run is a full build through the same code paths.

Run: python -m bpjs_sampel.silver_incremental [edisi|tabel]  (from api/; a filter forces those editions)
Outputs land in the same data/bpjs-sampel/silver the snapshot writes — prove a run on a copy of the whole
data/bpjs-sampel tree first (BLUESANDAI_BPJS_OUT=<copy>) when comparing the two.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

import duckdb

from bpjs_sampel.catalog import OUT
from bpjs_sampel.repo.bpjs_spec import SILVER_NAME, select_sql

FACT_EDISI = ["peserta", "kunjungan_fktp", "diagnosis_sekunder", "kunjungan_fkrtl", "tindakan_nonkapitasi"]
TABEL_OF = {v: k for k, v in SILVER_NAME.items()}


def _bronze(out: Path, tabel: str) -> str:
    return f"read_parquet('{(out / 'bronze' / tabel).as_posix()}/*/*.parquet', hive_partitioning=true, union_by_name=true)"


def _signatures(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, str]:
    """(tabel:edisi) -> a signature of its bronze files (name, sha256, rows) from the bronze manifest."""
    rows = con.execute(f"SELECT tabel, edisi, file, sha256, rows FROM read_parquet('{(out / 'bronze' / '_manifest.parquet').as_posix()}')").fetchall()
    sig: dict[str, list] = {}
    for tabel, edisi, file, sha, n in rows:
        sig.setdefault(f"{tabel}:{edisi}", []).append((file, sha, n))
    return {k: hashlib.sha256(json.dumps(sorted(v)).encode()).hexdigest()[:16] for k, v in sig.items()}


def _write_partition(con: duckdb.DuckDBPyConnection, out: Path, name: str, edisi: str, table: str) -> int:
    part = out / "silver" / name / f"edisi={edisi}"
    shutil.rmtree(part, ignore_errors=True)
    target = (out / "silver" / name).as_posix()
    con.execute(f"COPY (SELECT * FROM {table} WHERE edisi = '{edisi}') TO '{target}' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (edisi), OVERWRITE_OR_IGNORE true)")
    return con.execute(f"SELECT count(*) FROM {table} WHERE edisi = '{edisi}'").fetchone()[0]


def _fact(con: duckdb.DuckDBPyConnection, out: Path, tabel: str, edisi: str) -> int:
    """One fact partition, row-local: the snapshot silver's SELECT for one edition."""
    name = SILVER_NAME[tabel]
    cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {_bronze(out, tabel)}").fetchall()}
    sel, joins = select_sql(tabel, cols)
    con.execute(f"CREATE OR REPLACE TEMP VIEW src AS SELECT\n  {sel}\nFROM {_bronze(out, tabel)} t\n{joins}")
    extra = {
        "peserta": """SELECT *, date_sub('year', tgl_lahir, DATE '2024-12-31') AS usia_akhir_2024,
                             tgl_lahir < DATE '1901-01-01' AS flag_tgl_lahir_pengganti FROM src WHERE edisi = '{e}'""",
        "kunjungan_fktp": "SELECT *, date_trunc('month', tgl_datang)::DATE AS bulan FROM src WHERE edisi = '{e}'",
        "diagnosis_sekunder": "SELECT * FROM src WHERE edisi = '{e}'",
        "tindakan_nonkapitasi": """SELECT *, row_number() OVER (PARTITION BY edisi, kunjungan_id ORDER BY tgl_tindakan, tindakan) AS tindakan_ke
                                    FROM src WHERE edisi = '{e}'""",
        # the FKRTL base; jumlah_dx_sekunder and the flags are the flag pass below (they span editions)
        "kunjungan_fkrtl": """SELECT *, date_diff('day', tgl_datang, tgl_pulang) AS los_hari,
                                     biaya_tagih_rp - biaya_verifikasi_rp AS selisih_rp,
                                     date_trunc('month', tgl_pulang)::DATE AS bulan
                              FROM src WHERE edisi = '{e}'""",
    }[name]
    con.execute(f"CREATE OR REPLACE TEMP TABLE one AS {extra.format(e=edisi)}")
    return _write_partition(con, out, name, edisi, "one")


def _fkrtl_flags(con: duckdb.DuckDBPyConnection, out: Path) -> dict:
    """The stateful FKRTL columns over the whole silver, reading only the columns they need."""
    s = (out / "silver").as_posix()
    have = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{s}/kunjungan_fkrtl/*/*.parquet', hive_partitioning=true, union_by_name=true)").fetchall()}
    stateful = [c for c in ("jumlah_dx_sekunder", "flag_calon_klaim_ganda", "flag_selisih_verifikasi", "flag_los_ekstrem") if c in have]
    base = f"SELECT * EXCLUDE ({', '.join(stateful)})" if stateful else "SELECT *"
    con.execute(f"""CREATE OR REPLACE TEMP TABLE fk AS
        WITH k AS ({base} FROM read_parquet('{s}/kunjungan_fkrtl/*/*.parquet', hive_partitioning=true, union_by_name=true)),
             dx AS (SELECT edisi, kunjungan_fkrtl_id, count(*) AS jumlah_dx_sekunder
                    FROM read_parquet('{s}/diagnosis_sekunder/*/*.parquet', hive_partitioning=true, union_by_name=true) GROUP BY ALL),
             p99 AS (SELECT inacbg_kode, quantile_cont(los_hari, 0.99) AS los_p99 FROM k GROUP BY ALL)
        SELECT k.*, coalesce(dx.jumlah_dx_sekunder, 0) AS jumlah_dx_sekunder,
               count(*) OVER (PARTITION BY k.edisi, k.peserta_id, k.tgl_datang, k.tgl_pulang, k.inacbg_kode, k.biaya_tagih_rp) > 1 AS flag_calon_klaim_ganda,
               k.selisih_rp <> 0 AS flag_selisih_verifikasi,
               k.los_hari > p99.los_p99 AND k.los_hari > 3 AS flag_los_ekstrem
        FROM k LEFT JOIN dx USING (edisi, kunjungan_fkrtl_id) LEFT JOIN p99 USING (inacbg_kode)""")
    editions = [r[0] for r in con.execute("SELECT DISTINCT edisi FROM fk ORDER BY 1").fetchall()]
    total = 0
    for edisi in editions:
        total += _write_partition(con, out, "kunjungan_fkrtl", edisi, "fk")
    return {"baris": total, "edisi": editions}


def _rujukan(con: duckdb.DuckDBPyConnection, out: Path, editions: set[str]) -> None:
    s = (out / "silver").as_posix()
    k = f"read_parquet('{s}/kunjungan_fkrtl/*/*.parquet', hive_partitioning=true, union_by_name=true)"
    f = f"read_parquet('{s}/kunjungan_fktp/*/*.parquet', hive_partitioning=true, union_by_name=true)"
    for edisi in sorted(editions):
        con.execute(f"""CREATE OR REPLACE TEMP TABLE one AS
            SELECT r.edisi, r.kunjungan_fkrtl_id, r.rujukan_fktp_id AS kunjungan_fktp_id, r.peserta_id,
                   f.tgl_datang AS tgl_fktp, r.tgl_datang AS tgl_fkrtl, date_diff('day', f.tgl_datang, r.tgl_datang) AS hari_ke_fkrtl,
                   f.kabkota_fktp_kode AS kabkota_asal_kode, f.kabkota_fktp AS kabkota_asal, f.jenis_fktp AS jenis_faskes_asal,
                   r.kabkota_fkrtl_kode AS kabkota_tujuan_kode, r.kabkota_fkrtl AS kabkota_tujuan, r.tipe_fkrtl AS tipe_faskes_tujuan,
                   f.dx_icd3 AS dx_fktp_icd3, r.dx_primer_icd3 AS dx_fkrtl_icd3, f.dx_icd3 = r.dx_primer_icd3 AS dx_sama,
                   f.kunjungan_fktp_id IS NULL AS flag_rujukan_tanpa_fktp
            FROM {k} r LEFT JOIN {f} f ON f.edisi = r.edisi AND f.kunjungan_fktp_id = r.rujukan_fktp_id
            WHERE r.rujukan_fktp_id IS NOT NULL AND r.edisi = '{edisi}'""")
        _write_partition(con, out, "rujukan", edisi, "one")


def _dimensi(con: duckdb.DuckDBPyConnection, out: Path) -> None:
    """The snapshot silver's dimensions, whole (they are small), from the silver facts and the ICD-10 books."""
    from bpjs_sampel.silver import _icd10_reference

    s = (out / "silver").as_posix()
    fk = f"read_parquet('{s}/kunjungan_fkrtl/*/*.parquet', hive_partitioning=true, union_by_name=true)"
    ff = f"read_parquet('{s}/kunjungan_fktp/*/*.parquet', hive_partitioning=true, union_by_name=true)"
    fn = f"read_parquet('{s}/tindakan_nonkapitasi/*/*.parquet', hive_partitioning=true, union_by_name=true)"
    con.register("icd_ref", _icd10_reference())

    def write(name: str, sql: str) -> None:
        target = (out / "silver" / f"{name}.parquet").as_posix()
        con.execute(f"COPY ({sql}) TO '{target}' (FORMAT parquet, COMPRESSION zstd, OVERWRITE_OR_IGNORE true)")

    write("dim_icd10", "SELECT icd3, nama, bab FROM icd_ref ORDER BY icd3")
    write("dim_icd10_rinci", f"""
        WITH v AS (SELECT dx_masuk_kode AS kode, dx_masuk_icd3 AS icd3, dx_masuk_nama AS nama FROM {fk}
                   UNION ALL SELECT dx_primer_kode, dx_primer_icd3, dx_primer_nama FROM {fk}
                   UNION ALL SELECT dx_kode, dx_icd3, dx_nama FROM {fn}),
             c AS (SELECT kode, icd3, nama, count(*) n FROM v WHERE kode IS NOT NULL AND nama IS NOT NULL GROUP BY ALL)
        SELECT kode, any_value(icd3 ORDER BY n DESC) AS icd3, any_value(nama ORDER BY n DESC) AS nama, sum(n) AS dipakai
        FROM c GROUP BY kode ORDER BY kode""")
    write("dim_inacbg", f"""
        SELECT inacbg_kode, mode(inacbg_deskripsi) AS deskripsi,
               mode(inacbg_cmg) AS cmg, mode(inacbg_tipe_kasus) AS tipe_kasus, mode(inacbg_spesifikasi) AS spesifikasi,
               mode(inacbg_keparahan) AS keparahan, count(*) AS dipakai
        FROM {fk} WHERE inacbg_kode IS NOT NULL GROUP BY inacbg_kode ORDER BY inacbg_kode""")
    write("dim_wilayah", """
        WITH k AS (SELECT kode, label FROM lab WHERE kolom IN ('PSTV10','PSTV14','FKP06','FKP17','FKL06','FKL26','PNK07')),
             p AS (SELECT kode, label FROM lab WHERE kolom IN ('PSTV09','PSTV13','FKP05','FKL05','PNK06'))
        SELECT k.kode AS kabkota_kode, mode(k.label) AS kabkota, k.kode // 100 AS provinsi_kode,
               (SELECT mode(p.label) FROM p WHERE p.kode = k.kode // 100) AS provinsi
        FROM k GROUP BY k.kode ORDER BY k.kode""")
    write("dim_profil_faskes", f"""
        WITH v AS (SELECT kabkota_fktp_kode AS kabkota_kode, kepemilikan_fktp AS kepemilikan, jenis_fktp AS jenis, tipe_fktp AS tipe, 'FKTP' AS tingkat FROM {ff}
                   UNION ALL SELECT kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl, 'FKRTL' FROM {fk}
                   UNION ALL SELECT kabkota_faskes_kode, kepemilikan_faskes, jenis_faskes, tipe_faskes, 'NONKAPITASI' FROM {fn})
        SELECT md5(concat_ws('|', tingkat, kabkota_kode, kepemilikan, jenis, tipe)) AS faskes_profil_id, tingkat, kabkota_kode,
               kepemilikan, jenis, tipe, count(*) AS kunjungan
        FROM v GROUP BY ALL ORDER BY tingkat, kabkota_kode""")


def run(out: Path = OUT, force: str | None = None) -> dict:
    t0 = time.time()
    (out / "silver").mkdir(parents=True, exist_ok=True)
    state_file = out / "silver" / "_state_incremental.json"
    state = json.loads(state_file.read_text("utf-8")) if state_file.exists() else {}
    con = duckdb.connect()
    con.execute("PRAGMA threads=8")
    con.execute(f"CREATE TABLE lab AS SELECT edisi, tabel, kolom, kode::INTEGER AS kode, label FROM read_parquet('{(out / 'bronze' / '_label_nilai.parquet').as_posix()}')")
    sig = _signatures(con, out)
    changed = {k for k, v in sig.items() if state.get(k) != v}
    if force:
        changed |= {k for k in sig if force in k}
    report: dict = {"diubah": sorted(changed), "detik": 0}
    if not changed:
        report["detik"] = round(time.time() - t0, 1)
        print(f"tidak ada edisi berubah — silver dibiarkan ({report['detik']} s)", flush=True)
        return report

    by_tabel: dict[str, set[str]] = {}
    for key in changed:
        tabel, edisi = key.split(":", 1)
        by_tabel.setdefault(tabel, set()).add(edisi)
    # 1. row-local facts, per changed edition (FKRTL as its base; its flags follow over the whole silver)
    fkrtl_base_changed = False
    for tabel, editions in sorted(by_tabel.items()):
        for edisi in sorted(editions):
            n = _fact(con, out, tabel, edisi)
            b = con.execute(f"SELECT count(*) FROM {_bronze(out, tabel)} WHERE edisi = '{edisi}'").fetchone()[0]
            if n != b:
                raise ValueError(f"{SILVER_NAME[tabel]} edisi {edisi}: silver {n} baris != bronze {b}")
            fkrtl_base_changed |= tabel == "fkrtl"
            print(f"  {SILVER_NAME[tabel]:24s} edisi={edisi:18s} {n:>10,} baris", flush=True)
    # 2. the stateful FKRTL flags, over the silver (only their columns are read)
    if fkrtl_base_changed or "diagnosissekunder" in by_tabel:
        print(f"  flag kunjungan_fkrtl: {_fkrtl_flags(con, out)}", flush=True)
    # 3. referrals of the editions whose FKRTL or FKTP side changed, then the dimensions whole
    ruj_edisi = by_tabel.get("fkrtl", set()) | by_tabel.get("fktpkapitasi", set())
    if ruj_edisi:
        _rujukan(con, out, ruj_edisi)
        print(f"  rujukan: edisi {sorted(ruj_edisi)}", flush=True)
    _dimensi(con, out)
    # 4. reconciliation that must still hold after an incremental run
    s = (out / "silver").as_posix()
    tot_s = con.execute(f"SELECT sum(biaya_tagih_rp) FROM read_parquet('{s}/kunjungan_fkrtl/*/*.parquet', hive_partitioning=true, union_by_name=true)").fetchone()[0]
    tot_b = con.execute(f"SELECT sum(FKL47) FROM {_bronze(out, 'fkrtl')}").fetchone()[0]
    if int(tot_s or 0) != int(tot_b or 0):
        raise ValueError(f"total biaya FKRTL silver {tot_s} != bronze {tot_b}")
    state.update(sig)
    state_file.write_text(json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "silver" / "_laporan_incremental.json").write_text(
        json.dumps({**report, "detik": round(time.time() - t0, 1)}, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"selesai {report.get('detik') or round(time.time() - t0)} s · {len(changed)} partisi berubah · total biaya FKRTL cocok", flush=True)
    return report


if __name__ == "__main__":
    run(Path(os.environ["BLUESANDAI_BPJS_OUT"]) if os.environ.get("BLUESANDAI_BPJS_OUT") else OUT,
        force=sys.argv[1] if len(sys.argv) > 1 else None)
