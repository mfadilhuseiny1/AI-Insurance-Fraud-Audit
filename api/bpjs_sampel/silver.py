"""L1 bronze → L2 silver: tidy dimensions and facts (DuckDB over the bronze Parquet).

Every source column gets a descriptive name; a labelled column becomes two (`<name>_kode`, `<name>`); dates are dates,
money is BIGINT rupiah; empty strings and 'NONE' become NULL; quality problems become `flag_*` columns — no row is
dropped. Output: data/bpjs-sampel/silver/<dataset>/edisi=<edisi>/*.parquet (dimensions unpartitioned) and
silver/_laporan_kualitas.json with every expectation and its result.
Run: python -m bpjs_sampel.silver  (from api/)
"""

from __future__ import annotations

import glob
import json
import time
from pathlib import Path

import duckdb
import pandas as pd

from bpjs_sampel.catalog import OUT, SOURCE
from bpjs_sampel.repo.bpjs_spec import SILVER_NAME, icd10_reference, select_sql

# the column specification and the SELECT builder are shared with the platform transforms (repo/bpjs_spec.py)


def _bronze(out: Path, tabel: str) -> str:
    return f"read_parquet('{(out / 'bronze' / tabel).as_posix()}/*/*.parquet', hive_partitioning=true, union_by_name=true)"


def _icd10_reference() -> pd.DataFrame:
    return icd10_reference([(Path(f).name, f) for f in glob.glob(str(SOURCE / "*" / "icd10" / "*.xlsx"))])


def run(out: Path = OUT) -> dict:
    t0 = time.time()
    s = out / "silver"
    s.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("PRAGMA threads=8")
    con.execute(f"CREATE TABLE lab AS SELECT edisi, tabel, kolom, kode::INTEGER AS kode, label FROM read_parquet('{(out / 'bronze' / '_label_nilai.parquet').as_posix()}')")
    report: dict = {"dibuat": time.strftime("%Y-%m-%d %H:%M:%S"), "dataset": {}, "ekspektasi": []}

    def write(name: str, sql: str, partition: bool = True) -> None:
        target = (s / name).as_posix()
        con.execute(f"CREATE OR REPLACE TABLE {name} AS {sql}")
        opts = "FORMAT parquet, COMPRESSION zstd, OVERWRITE_OR_IGNORE true" + (", PARTITION_BY (edisi)" if partition else "")
        if partition:
            import shutil
            shutil.rmtree(s / name, ignore_errors=True)
        con.execute(f"COPY {name} TO '{target if partition else target + '.parquet'}' ({opts})")
        n = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
        report["dataset"][name] = {"baris": n, "kolom": len(con.execute(f"DESCRIBE {name}").fetchall())}
        print(f"  {name:24s} {n:>12,} baris  ({round(time.time() - t0)} s)", flush=True)

    # ---- facts
    for tabel, name in SILVER_NAME.items():
        cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {_bronze(out, tabel)}").fetchall()}
        sel, joins = select_sql(tabel, cols)
        con.execute(f"CREATE OR REPLACE TEMP VIEW src_{name} AS SELECT\n  {sel}\nFROM {_bronze(out, tabel)} t\n{joins}")
    write("peserta", """SELECT *, date_sub('year', tgl_lahir, DATE '2024-12-31') AS usia_akhir_2024,
                        tgl_lahir < DATE '1901-01-01' AS flag_tgl_lahir_pengganti FROM src_peserta""")
    write("kunjungan_fktp", "SELECT *, date_trunc('month', tgl_datang)::DATE AS bulan FROM src_kunjungan_fktp")
    write("diagnosis_sekunder", "SELECT * FROM src_diagnosis_sekunder")
    write("kunjungan_fkrtl", """
        WITH k AS (SELECT *, date_diff('day', tgl_datang, tgl_pulang) AS los_hari, biaya_tagih_rp - biaya_verifikasi_rp AS selisih_rp,
                          date_trunc('month', tgl_pulang)::DATE AS bulan FROM src_kunjungan_fkrtl),
             dx AS (SELECT edisi, kunjungan_fkrtl_id, count(*) AS jumlah_dx_sekunder FROM diagnosis_sekunder GROUP BY ALL),
             p99 AS (SELECT inacbg_kode, quantile_cont(los_hari, 0.99) AS los_p99 FROM k GROUP BY ALL)
        SELECT k.*, coalesce(dx.jumlah_dx_sekunder, 0) AS jumlah_dx_sekunder,
               count(*) OVER (PARTITION BY k.edisi, k.peserta_id, k.tgl_datang, k.tgl_pulang, k.inacbg_kode, k.biaya_tagih_rp) > 1 AS flag_calon_klaim_ganda,
               k.selisih_rp <> 0 AS flag_selisih_verifikasi,
               k.los_hari > p99.los_p99 AND k.los_hari > 3 AS flag_los_ekstrem
        FROM k LEFT JOIN dx USING (edisi, kunjungan_fkrtl_id) LEFT JOIN p99 USING (inacbg_kode)""")
    write("tindakan_nonkapitasi", """SELECT *, row_number() OVER (PARTITION BY edisi, kunjungan_id ORDER BY tgl_tindakan, tindakan) AS tindakan_ke
                                     FROM src_tindakan_nonkapitasi""")
    write("rujukan", """
        SELECT r.edisi, r.kunjungan_fkrtl_id, r.rujukan_fktp_id AS kunjungan_fktp_id, r.peserta_id,
               f.tgl_datang AS tgl_fktp, r.tgl_datang AS tgl_fkrtl, date_diff('day', f.tgl_datang, r.tgl_datang) AS hari_ke_fkrtl,
               f.kabkota_fktp_kode AS kabkota_asal_kode, f.kabkota_fktp AS kabkota_asal, f.jenis_fktp AS jenis_faskes_asal,
               r.kabkota_fkrtl_kode AS kabkota_tujuan_kode, r.kabkota_fkrtl AS kabkota_tujuan, r.tipe_fkrtl AS tipe_faskes_tujuan,
               f.dx_icd3 AS dx_fktp_icd3, r.dx_primer_icd3 AS dx_fkrtl_icd3, f.dx_icd3 = r.dx_primer_icd3 AS dx_sama,
               f.kunjungan_fktp_id IS NULL AS flag_rujukan_tanpa_fktp
        FROM kunjungan_fkrtl r LEFT JOIN kunjungan_fktp f ON f.edisi = r.edisi AND f.kunjungan_fktp_id = r.rujukan_fktp_id
        WHERE r.rujukan_fktp_id IS NOT NULL""")

    # ---- dimensions
    con.register("icd_ref", _icd10_reference())
    write("dim_icd10", "SELECT icd3, nama, bab FROM icd_ref ORDER BY icd3", partition=False)
    write("dim_icd10_rinci", """
        WITH v AS (SELECT dx_masuk_kode AS kode, dx_masuk_icd3 AS icd3, dx_masuk_nama AS nama FROM kunjungan_fkrtl
                   UNION ALL SELECT dx_primer_kode, dx_primer_icd3, dx_primer_nama FROM kunjungan_fkrtl
                   UNION ALL SELECT dx_kode, dx_icd3, dx_nama FROM tindakan_nonkapitasi),
             c AS (SELECT kode, icd3, nama, count(*) n FROM v WHERE kode IS NOT NULL AND nama IS NOT NULL GROUP BY ALL)
        SELECT kode, any_value(icd3 ORDER BY n DESC) AS icd3, any_value(nama ORDER BY n DESC) AS nama, sum(n) AS dipakai
        FROM c GROUP BY kode ORDER BY kode""", partition=False)
    write("dim_inacbg", """
        SELECT inacbg_kode, mode(inacbg_deskripsi) AS deskripsi,
               mode(inacbg_cmg) AS cmg, mode(inacbg_tipe_kasus) AS tipe_kasus, mode(inacbg_spesifikasi) AS spesifikasi,
               mode(inacbg_keparahan) AS keparahan, count(*) AS dipakai
        FROM kunjungan_fkrtl WHERE inacbg_kode IS NOT NULL GROUP BY inacbg_kode ORDER BY inacbg_kode""", partition=False)
    write("dim_wilayah", """
        WITH k AS (SELECT kode, label FROM lab WHERE kolom IN ('PSTV10','PSTV14','FKP06','FKP17','FKL06','FKL26','PNK07')),
             p AS (SELECT kode, label FROM lab WHERE kolom IN ('PSTV09','PSTV13','FKP05','FKL05','PNK06'))
        SELECT k.kode AS kabkota_kode, mode(k.label) AS kabkota, k.kode // 100 AS provinsi_kode,
               (SELECT mode(p.label) FROM p WHERE p.kode = k.kode // 100) AS provinsi
        FROM k GROUP BY k.kode ORDER BY k.kode""", partition=False)
    write("dim_profil_faskes", """
        WITH v AS (SELECT kabkota_fktp_kode AS kabkota_kode, kepemilikan_fktp AS kepemilikan, jenis_fktp AS jenis, tipe_fktp AS tipe, 'FKTP' AS tingkat FROM kunjungan_fktp
                   UNION ALL SELECT kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl, 'FKRTL' FROM kunjungan_fkrtl
                   UNION ALL SELECT kabkota_faskes_kode, kepemilikan_faskes, jenis_faskes, tipe_faskes, 'NONKAPITASI' FROM tindakan_nonkapitasi)
        SELECT md5(concat_ws('|', tingkat, kabkota_kode, kepemilikan, jenis, tipe)) AS faskes_profil_id, tingkat, kabkota_kode,
               kepemilikan, jenis, tipe, count(*) AS kunjungan
        FROM v GROUP BY ALL ORDER BY tingkat, kabkota_kode""", partition=False)

    # ---- expectations
    def expect(nama: str, sql: str, harus: int = 0) -> None:
        nilai = con.execute(sql).fetchone()[0]
        ok = nilai == harus
        report["ekspektasi"].append({"nama": nama, "nilai": nilai, "harus": harus, "lolos": ok})
        print(f"  {'✓' if ok else '✗'} {nama}: {nilai}", flush=True)

    bronze_rows = {t: con.execute(f"SELECT count(*) FROM {_bronze(out, t)}").fetchone()[0] for t in SILVER_NAME}
    for tabel, name in SILVER_NAME.items():
        expect(f"{name}: jumlah baris = bronze", f"SELECT abs((SELECT count(*) FROM {name}) - {bronze_rows[tabel]})")
    expect("peserta: (edisi, peserta_id) unik", "SELECT count(*) - count(DISTINCT (edisi, peserta_id)) FROM peserta")
    expect("kunjungan_fktp: (edisi, id) unik", "SELECT count(*) - count(DISTINCT (edisi, kunjungan_fktp_id)) FROM kunjungan_fktp")
    expect("kunjungan_fkrtl: (edisi, id) unik", "SELECT count(*) - count(DISTINCT (edisi, kunjungan_fkrtl_id)) FROM kunjungan_fkrtl")
    expect("diagnosis_sekunder: (edisi, kunjungan, kode) unik", "SELECT count(*) - count(DISTINCT (edisi, kunjungan_fkrtl_id, dx_kode)) FROM diagnosis_sekunder")
    expect("kunjungan_fktp: peserta ada", "SELECT count(*) FROM kunjungan_fktp k ANTI JOIN peserta p USING (edisi, peserta_id)")
    expect("kunjungan_fkrtl: peserta ada", "SELECT count(*) FROM kunjungan_fkrtl k ANTI JOIN peserta p USING (edisi, peserta_id)")
    expect("rujukan: kunjungan FKTP ada", "SELECT count(*) FROM rujukan WHERE flag_rujukan_tanpa_fktp")
    expect("diagnosis_sekunder: kunjungan FKRTL ada", "SELECT count(*) FROM diagnosis_sekunder d ANTI JOIN kunjungan_fkrtl k USING (edisi, kunjungan_fkrtl_id)")
    expect("tgl_pulang ≥ tgl_datang (FKTP)", "SELECT count(*) FROM kunjungan_fktp WHERE tgl_pulang < tgl_datang")
    expect("tgl_pulang ≥ tgl_datang (FKRTL)", "SELECT count(*) FROM kunjungan_fkrtl WHERE tgl_pulang < tgl_datang")
    expect("biaya verifikasi ≤ tagih (FKRTL)", "SELECT count(*) FROM kunjungan_fkrtl WHERE biaya_verifikasi_rp > biaya_tagih_rp")
    expect("biaya tidak negatif", "SELECT count(*) FROM kunjungan_fkrtl WHERE biaya_tagih_rp < 0 OR biaya_verifikasi_rp < 0")
    for tabel, name, src, col in [("fkrtl", "kunjungan_fkrtl", "FKL47", "biaya_tagih_rp"), ("nonkapitasi", "tindakan_nonkapitasi", "PNK17", "biaya_tagih_rp")]:
        expect(f"{name}: total {col} = sumber", f"SELECT abs((SELECT sum({col}) FROM {name}) - (SELECT sum({src}) FROM {_bronze(out, tabel)}))")
    # a labelled code without its text, other than the source's MISSING codes (those are NULL on purpose)
    expect("label: kode berlabel tanpa teks", """
        SELECT (SELECT count(*) FROM peserta p JOIN lab l ON l.edisi = p.edisi AND l.tabel = 'kepesertaan' AND l.kolom = 'PSTV08' AND l.kode = p.segmen_kode
                WHERE p.segmen IS NULL AND upper(trim(l.label)) NOT IN ('MISSING', 'TIDAK TERDEFINISI'))
             + (SELECT count(*) FROM kunjungan_fkrtl k JOIN lab l ON l.edisi = k.edisi AND l.tabel = 'fkrtl' AND l.kolom = 'FKL09' AND l.kode = k.tipe_fkrtl_kode
                WHERE k.tipe_fkrtl IS NULL AND upper(trim(l.label)) NOT IN ('MISSING', 'TIDAK TERDEFINISI'))""")
    report["catatan"] = {
        "calon_klaim_ganda": con.execute("SELECT count(*) FROM kunjungan_fkrtl WHERE flag_calon_klaim_ganda").fetchone()[0],
        "selisih_verifikasi": con.execute("SELECT count(*) FROM kunjungan_fkrtl WHERE flag_selisih_verifikasi").fetchone()[0],
        "los_ekstrem": con.execute("SELECT count(*) FROM kunjungan_fkrtl WHERE flag_los_ekstrem").fetchone()[0],
        "tgl_lahir_pengganti": con.execute("SELECT count(*) FROM peserta WHERE flag_tgl_lahir_pengganti").fetchone()[0],
        "nama_dx_diperbaiki": con.execute("SELECT count(*) FILTER (WHERE flag_dx_masuk_nama_diperbaiki) + count(*) FILTER (WHERE flag_dx_primer_nama_diperbaiki) FROM kunjungan_fkrtl").fetchone()[0],
        "icd3_tanpa_referensi": con.execute("SELECT count(DISTINCT dx_primer_icd3) FROM kunjungan_fkrtl k ANTI JOIN dim_icd10 d ON d.icd3 = k.dx_primer_icd3 WHERE k.dx_primer_icd3 IS NOT NULL").fetchone()[0],
    }
    report["detik"] = round(time.time() - t0)
    (s / "_laporan_kualitas.json").write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    return report


if __name__ == "__main__":
    r = run()
    gagal = [e for e in r["ekspektasi"] if not e["lolos"]]
    print(f"selesai {r['detik']} s · {len(r['ekspektasi']) - len(gagal)}/{len(r['ekspektasi'])} ekspektasi lolos · catatan {r['catatan']}")
