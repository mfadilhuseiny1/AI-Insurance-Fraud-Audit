"""L1 bronze → L2 silver: tidy facts and dimensions (DuckDB). One transform per dataset (each build holds one output
in memory); every fact transform checks its own expectations and fails the build when one does not hold;
silver_laporan_kualitas checks the relations between datasets and records every result as a dataset.
"""

import tempfile

import duckdb
import pyarrow as pa
from transforms.api import Input, Output, transform

from myproject.datasets.bpjs_common import P, dictionary_encoded, expect, parquet_of, raise_failed
from myproject.datasets.bpjs_spec import SPEC, icd10_reference, select_sql

B, S = f"{P}/bronze", f"{P}/silver"


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET threads = 8")
    con.execute("SET memory_limit = '3GB'")
    con.execute(f"SET temp_directory = '{tempfile.mkdtemp().replace(chr(92), '/')}'")
    return con


def _write(out, con, sql: str) -> int:
    reader = con.execute(sql).fetch_record_batch(500_000)
    table = dictionary_encoded(_batches(reader))
    out.write_table(table)
    return table.num_rows


def _batches(reader):
    while True:
        try:
            yield reader.read_next_batch()
        except StopIteration:
            return


def _fact_source(con, tabel: str, bronze, labels) -> None:
    """View src: the bronze rows with silver names, code + label, types, NULLs (bpjs_spec.select_sql). bronze and
    labels: one input, or a tuple of inputs (a table read in parts)."""
    bronze = bronze if isinstance(bronze, tuple) else (bronze,)
    labels = labels if isinstance(labels, tuple) else (labels,)
    con.execute(f"CREATE TABLE lab AS SELECT edisi, tabel, kolom, kode::INTEGER AS kode, label FROM {parquet_of(*labels)}")
    src = parquet_of(*bronze)
    cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
    sel, joins = select_sql(tabel, cols)
    con.execute(f"CREATE VIEW src AS SELECT\n  {sel}\nFROM {src} t\n{joins}")


@transform.using(out=Output(f"{S}/peserta"), bronze=Input(f"{B}/kepesertaan"), labels=Input(f"{B}/_meta/label_nilai_kepesertaan"))
def silver_peserta(bronze, labels, out):
    """Peserta: satu baris per peserta per edisi; usia akhir 2024, flag tanggal lahir pengganti."""
    con = _con()
    _fact_source(con, "kepesertaan", bronze, labels)
    con.execute("""CREATE TABLE t AS SELECT *, date_sub('year', tgl_lahir, DATE '2024-12-31') AS usia_akhir_2024,
                   tgl_lahir < DATE '1901-01-01' AS flag_tgl_lahir_pengganti FROM src""")
    r: list = []
    expect(r, "jumlah baris = bronze", con.execute(f"SELECT (SELECT count(*) FROM t) - (SELECT count(*) FROM {parquet_of(bronze)})").fetchone()[0])
    expect(r, "(edisi, peserta_id) unik", con.execute("SELECT count(*) - count(DISTINCT (edisi, peserta_id)) FROM t").fetchone()[0])
    expect(r, "segmen berlabel tanpa teks", con.execute("""SELECT count(*) FROM t JOIN lab l ON l.edisi = t.edisi AND l.kolom = 'PSTV08' AND l.kode = t.segmen_kode
                                                           WHERE t.segmen IS NULL AND upper(trim(l.label)) NOT IN ('MISSING', 'TIDAK TERDEFINISI')""").fetchone()[0])
    raise_failed(r)
    _write(out, con, "SELECT * FROM t")


@transform.using(out=Output(f"{S}/kunjungan_fktp"), bronze=Input(f"{B}/fktpkapitasi"), labels=Input(f"{B}/_meta/label_nilai_fktpkapitasi"))
def silver_kunjungan_fktp(bronze, labels, out):
    """Kunjungan FKTP kapitasi: satu baris per kunjungan per edisi."""
    con = _con()
    _fact_source(con, "fktpkapitasi", bronze, labels)
    con.execute("CREATE TABLE t AS SELECT *, date_trunc('month', tgl_datang)::DATE AS bulan FROM src")
    r: list = []
    expect(r, "jumlah baris = bronze", con.execute(f"SELECT (SELECT count(*) FROM t) - (SELECT count(*) FROM {parquet_of(bronze)})").fetchone()[0])
    expect(r, "(edisi, kunjungan_fktp_id) unik", con.execute("SELECT count(*) - count(DISTINCT (edisi, kunjungan_fktp_id)) FROM t").fetchone()[0])
    expect(r, "tgl_pulang ≥ tgl_datang", con.execute("SELECT count(*) FROM t WHERE tgl_pulang < tgl_datang").fetchone()[0])
    raise_failed(r)
    _write(out, con, "SELECT * FROM t")


@transform.using(out=Output(f"{S}/diagnosis_sekunder"), bronze=Input(f"{B}/diagnosissekunder"),
                 labels=Input(f"{B}/_meta/label_nilai_diagnosissekunder"))
def silver_diagnosis_sekunder(bronze, labels, out):
    """Diagnosis sekunder: satu baris per kode diagnosis per kunjungan FKRTL."""
    con = _con()
    _fact_source(con, "diagnosissekunder", bronze, labels)
    con.execute("CREATE TABLE t AS SELECT * FROM src")
    r: list = []
    expect(r, "jumlah baris = bronze", con.execute(f"SELECT (SELECT count(*) FROM t) - (SELECT count(*) FROM {parquet_of(bronze)})").fetchone()[0])
    expect(r, "(edisi, kunjungan, kode) unik", con.execute("SELECT count(*) - count(DISTINCT (edisi, kunjungan_fkrtl_id, dx_kode)) FROM t").fetchone()[0])
    raise_failed(r)
    _write(out, con, "SELECT * FROM t")


@transform.using(out=Output(f"{S}/kunjungan_fkrtl"), bronze_1=Input(f"{B}/fkrtl_bagian_1"), bronze_2=Input(f"{B}/fkrtl_bagian_2"),
                 labels_1=Input(f"{B}/_meta/label_nilai_fkrtl_bagian_1"), labels_2=Input(f"{B}/_meta/label_nilai_fkrtl_bagian_2"),
                 dx=Input(f"{S}/diagnosis_sekunder"))
def silver_kunjungan_fkrtl(bronze_1, bronze_2, labels_1, labels_2, dx, out):
    """Kunjungan / klaim FKRTL (INA-CBG): LOS, selisih verifikasi, jumlah diagnosis sekunder; flag calon klaim ganda,
    selisih verifikasi, LOS ekstrem (> p99 INA-CBG-nya dan > 3 hari), nama diagnosis yang dipulihkan."""
    con = _con()
    bronze = (bronze_1, bronze_2)
    _fact_source(con, "fkrtl", bronze, (labels_1, labels_2))
    con.execute(f"""CREATE TABLE t AS
        WITH k AS (SELECT *, date_diff('day', tgl_datang, tgl_pulang) AS los_hari, biaya_tagih_rp - biaya_verifikasi_rp AS selisih_rp,
                          date_trunc('month', tgl_pulang)::DATE AS bulan FROM src),
             d AS (SELECT edisi, kunjungan_fkrtl_id, count(*) AS jumlah_dx_sekunder FROM {parquet_of(dx)} GROUP BY ALL),
             p99 AS (SELECT inacbg_kode, quantile_cont(los_hari, 0.99) AS los_p99 FROM k GROUP BY ALL)
        SELECT k.*, coalesce(d.jumlah_dx_sekunder, 0) AS jumlah_dx_sekunder,
               count(*) OVER (PARTITION BY k.edisi, k.peserta_id, k.tgl_datang, k.tgl_pulang, k.inacbg_kode, k.biaya_tagih_rp) > 1 AS flag_calon_klaim_ganda,
               k.selisih_rp <> 0 AS flag_selisih_verifikasi,
               k.los_hari > p99.los_p99 AND k.los_hari > 3 AS flag_los_ekstrem
        FROM k LEFT JOIN d USING (edisi, kunjungan_fkrtl_id) LEFT JOIN p99 USING (inacbg_kode)""")
    r: list = []
    expect(r, "jumlah baris = bronze", con.execute(f"SELECT (SELECT count(*) FROM t) - (SELECT count(*) FROM {parquet_of(*bronze)})").fetchone()[0])
    expect(r, "(edisi, kunjungan_fkrtl_id) unik", con.execute("SELECT count(*) - count(DISTINCT (edisi, kunjungan_fkrtl_id)) FROM t").fetchone()[0])
    expect(r, "tgl_pulang ≥ tgl_datang", con.execute("SELECT count(*) FROM t WHERE tgl_pulang < tgl_datang").fetchone()[0])
    expect(r, "biaya verifikasi ≤ tagih", con.execute("SELECT count(*) FROM t WHERE biaya_verifikasi_rp > biaya_tagih_rp").fetchone()[0])
    expect(r, "biaya tidak negatif", con.execute("SELECT count(*) FROM t WHERE biaya_tagih_rp < 0 OR biaya_verifikasi_rp < 0").fetchone()[0])
    expect(r, "total biaya tagih = sumber", con.execute(f"SELECT (SELECT sum(biaya_tagih_rp) FROM t) - (SELECT sum(FKL47) FROM {parquet_of(*bronze)})").fetchone()[0])
    # long texts (Stata strL) must arrive as text: a reading mistake once typed them as numbers and emptied them
    expect(r, "nama diagnosis masuk sebanyak kodenya", con.execute("SELECT count(dx_masuk_kode) - count(dx_masuk_nama) FROM t").fetchone()[0])
    expect(r, "nama diagnosis primer sebanyak kodenya", con.execute("SELECT count(dx_primer_kode) - count(dx_primer_nama) FROM t").fetchone()[0])
    expect(r, "INA-CBG tanpa deskripsi > 0,1%", con.execute("""SELECT CASE WHEN count(*) FILTER (WHERE inacbg_kode IS NOT NULL AND inacbg_deskripsi IS NULL) * 1000
                                                                   > count(inacbg_kode) THEN count(*) FILTER (WHERE inacbg_kode IS NOT NULL AND inacbg_deskripsi IS NULL)
                                                                   ELSE 0 END FROM t""").fetchone()[0])
    expect(r, "tipe FKRTL berlabel tanpa teks", con.execute("""SELECT count(*) FROM t JOIN lab l ON l.edisi = t.edisi AND l.kolom = 'FKL09' AND l.kode = t.tipe_fkrtl_kode
                                                               WHERE t.tipe_fkrtl IS NULL AND upper(trim(l.label)) NOT IN ('MISSING', 'TIDAK TERDEFINISI')""").fetchone()[0])
    raise_failed(r)
    _write(out, con, "SELECT * FROM t")


@transform.using(out=Output(f"{S}/tindakan_nonkapitasi"), bronze=Input(f"{B}/nonkapitasi"), labels=Input(f"{B}/_meta/label_nilai_nonkapitasi"))
def silver_tindakan_nonkapitasi(bronze, labels, out):
    """Tindakan nonkapitasi: satu baris per tindakan (bukan per kunjungan), urutan tindakan_ke per kunjungan."""
    con = _con()
    _fact_source(con, "nonkapitasi", bronze, labels)
    con.execute("CREATE TABLE t AS SELECT *, row_number() OVER (PARTITION BY edisi, kunjungan_id ORDER BY tgl_tindakan, tindakan) AS tindakan_ke FROM src")
    r: list = []
    expect(r, "jumlah baris = bronze", con.execute(f"SELECT (SELECT count(*) FROM t) - (SELECT count(*) FROM {parquet_of(bronze)})").fetchone()[0])
    expect(r, "total biaya tagih = sumber", con.execute(f"SELECT (SELECT sum(biaya_tagih_rp) FROM t) - (SELECT sum(PNK17) FROM {parquet_of(bronze)})").fetchone()[0])
    raise_failed(r)
    _write(out, con, "SELECT * FROM t")


@transform.using(out=Output(f"{S}/rujukan"), fkrtl=Input(f"{S}/kunjungan_fkrtl"), fktp=Input(f"{S}/kunjungan_fktp"))
def silver_rujukan(fkrtl, fktp, out):
    """Rujukan FKTP → FKRTL: setiap kunjungan FKRTL yang membawa nomor kunjungan FKTP asalnya."""
    con = _con()
    con.execute(f"""CREATE TABLE t AS
        SELECT r.edisi, r.kunjungan_fkrtl_id, r.rujukan_fktp_id AS kunjungan_fktp_id, r.peserta_id,
               f.tgl_datang AS tgl_fktp, r.tgl_datang AS tgl_fkrtl, date_diff('day', f.tgl_datang, r.tgl_datang) AS hari_ke_fkrtl,
               f.kabkota_fktp_kode AS kabkota_asal_kode, f.kabkota_fktp AS kabkota_asal, f.jenis_fktp AS jenis_faskes_asal,
               r.kabkota_fkrtl_kode AS kabkota_tujuan_kode, r.kabkota_fkrtl AS kabkota_tujuan, r.tipe_fkrtl AS tipe_faskes_tujuan,
               f.dx_icd3 AS dx_fktp_icd3, r.dx_primer_icd3 AS dx_fkrtl_icd3, f.dx_icd3 = r.dx_primer_icd3 AS dx_sama,
               f.kunjungan_fktp_id IS NULL AS flag_rujukan_tanpa_fktp
        FROM {parquet_of(fkrtl)} r LEFT JOIN {parquet_of(fktp)} f ON f.edisi = r.edisi AND f.kunjungan_fktp_id = r.rujukan_fktp_id
        WHERE r.rujukan_fktp_id IS NOT NULL""")
    r: list = []
    expect(r, "rujukan menemukan kunjungan FKTP", con.execute("SELECT count(*) FROM t WHERE flag_rujukan_tanpa_fktp").fetchone()[0])
    raise_failed(r)
    _write(out, con, "SELECT * FROM t")


@transform.using(
    icd10=Output(f"{S}/dim_icd10"), icd10_rinci=Output(f"{S}/dim_icd10_rinci"), inacbg=Output(f"{S}/dim_inacbg"),
    wilayah=Output(f"{S}/dim_wilayah"), profil_faskes=Output(f"{S}/dim_profil_faskes"),
    fkrtl=Input(f"{S}/kunjungan_fkrtl"), fktp=Input(f"{S}/kunjungan_fktp"), nonkap=Input(f"{S}/tindakan_nonkapitasi"),
    lab_peserta=Input(f"{B}/_meta/label_nilai_kepesertaan"), lab_fktp=Input(f"{B}/_meta/label_nilai_fktpkapitasi"),
    lab_fkrtl_1=Input(f"{B}/_meta/label_nilai_fkrtl_bagian_1"), lab_fkrtl_2=Input(f"{B}/_meta/label_nilai_fkrtl_bagian_2"), lab_nonkap=Input(f"{B}/_meta/label_nilai_nonkapitasi"),
    icd_reguler=Input(f"{P}/raw/icd10/reguler"), icd_covid=Input(f"{P}/raw/icd10/covid"), icd_dm=Input(f"{P}/raw/icd10/dm"),
    icd_km=Input(f"{P}/raw/icd10/kesehatan_mental"), icd_ibu=Input(f"{P}/raw/icd10/kia_ibu"), icd_anak=Input(f"{P}/raw/icd10/kia_anak"),
    icd_tb=Input(f"{P}/raw/icd10/tb"),
)
def silver_dimensi(fkrtl, fktp, nonkap, lab_peserta, lab_fktp, lab_fkrtl_1, lab_fkrtl_2, lab_nonkap, icd_reguler, icd_covid, icd_dm, icd_km, icd_ibu, icd_anak, icd_tb,
                   icd10, icd10_rinci, inacbg, wilayah, profil_faskes):
    """Dimensi: ICD-10 3 digit (buku kode resmi), ICD-10 rinci (dari data, nama dipulihkan), INA-CBG, wilayah (kab/kota →
    provinsi dari label nilai), profil faskes (pengganti ID faskes yang tidak ada di sumber)."""
    con = _con()
    books = []
    for inp in (icd_reguler, icd_covid, icd_dm, icd_km, icd_ibu, icd_anak, icd_tb):
        fs = inp.filesystem()
        books += [(f.path, fs.open(f.path, "rb")) for f in fs.ls(glob="*.xlsx")]
    ref = icd10_reference(books)
    for _, fh in books:
        fh.close()
    icd10.write_table(pa.Table.from_pandas(ref[["icd3", "nama", "bab"]], preserve_index=False))
    labels = " UNION ALL ".join(f"SELECT edisi, tabel, kolom, kode::INTEGER AS kode, label FROM {parquet_of(x)}"
                                for x in (lab_peserta, lab_fktp, lab_fkrtl_1, lab_fkrtl_2, lab_nonkap))
    con.execute(f"CREATE TABLE lab AS {labels}")
    k, f, n = parquet_of(fkrtl), parquet_of(fktp), parquet_of(nonkap)
    icd10_rinci.write_table(con.execute(f"""
        WITH v AS (SELECT dx_masuk_kode AS kode, dx_masuk_icd3 AS icd3, dx_masuk_nama AS nama FROM {k}
                   UNION ALL SELECT dx_primer_kode, dx_primer_icd3, dx_primer_nama FROM {k}
                   UNION ALL SELECT dx_kode, dx_icd3, dx_nama FROM {n}),
             c AS (SELECT kode, icd3, nama, count(*) n FROM v WHERE kode IS NOT NULL AND nama IS NOT NULL GROUP BY ALL)
        SELECT kode, any_value(icd3 ORDER BY n DESC) AS icd3, any_value(nama ORDER BY n DESC) AS nama, sum(n)::BIGINT AS dipakai
        FROM c GROUP BY kode ORDER BY kode""").arrow())
    inacbg.write_table(con.execute(f"""
        SELECT inacbg_kode, mode(inacbg_deskripsi) AS deskripsi, mode(inacbg_cmg) AS cmg, mode(inacbg_tipe_kasus) AS tipe_kasus,
               mode(inacbg_spesifikasi) AS spesifikasi, mode(inacbg_keparahan) AS keparahan, count(*) AS dipakai
        FROM {k} WHERE inacbg_kode IS NOT NULL GROUP BY inacbg_kode ORDER BY inacbg_kode""").arrow())
    wilayah.write_table(con.execute("""
        WITH kk AS (SELECT kode, label FROM lab WHERE kolom IN ('PSTV10','PSTV14','FKP06','FKP17','FKL06','FKL26','PNK07')),
             pp AS (SELECT kode, mode(label) AS label FROM lab WHERE kolom IN ('PSTV09','PSTV13','FKP05','FKL05','PNK06') GROUP BY kode)
        SELECT kk.kode AS kabkota_kode, mode(kk.label) AS kabkota, kk.kode // 100 AS provinsi_kode, any_value(pp.label) AS provinsi
        FROM kk LEFT JOIN pp ON pp.kode = kk.kode // 100 GROUP BY kk.kode ORDER BY kk.kode""").arrow())
    profil_faskes.write_table(con.execute(f"""
        WITH v AS (SELECT kabkota_fktp_kode AS kabkota_kode, kepemilikan_fktp AS kepemilikan, jenis_fktp AS jenis, tipe_fktp AS tipe, 'FKTP' AS tingkat FROM {f}
                   UNION ALL SELECT kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl, 'FKRTL' FROM {k}
                   UNION ALL SELECT kabkota_faskes_kode, kepemilikan_faskes, jenis_faskes, tipe_faskes, 'NONKAPITASI' FROM {n})
        SELECT md5(concat_ws('|', tingkat, kabkota_kode, kepemilikan, jenis, tipe)) AS faskes_profil_id, tingkat, kabkota_kode,
               kepemilikan, jenis, tipe, count(*) AS kunjungan
        FROM v GROUP BY ALL ORDER BY tingkat, kabkota_kode""").arrow())


@transform.using(
    out=Output(f"{S}/_laporan_kualitas"),
    peserta=Input(f"{S}/peserta"), fktp=Input(f"{S}/kunjungan_fktp"), fkrtl=Input(f"{S}/kunjungan_fkrtl"),
    dx=Input(f"{S}/diagnosis_sekunder"), nonkap=Input(f"{S}/tindakan_nonkapitasi"), rujukan=Input(f"{S}/rujukan"),
    icd10=Input(f"{S}/dim_icd10"),
)
def silver_laporan_kualitas(peserta, fktp, fkrtl, dx, nonkap, rujukan, icd10, out):
    """Pemeriksaan antar-dataset (relasi) dan ringkasan flag kualitas: satu baris per pemeriksaan; gagal = build gagal."""
    con = _con()
    p, f, k, d, n, rj, i = (parquet_of(x) for x in (peserta, fktp, fkrtl, dx, nonkap, rujukan, icd10))
    r: list = []
    expect(r, "kunjungan FKTP → peserta ada", con.execute(f"SELECT count(*) FROM {f} x ANTI JOIN {p} y USING (edisi, peserta_id)").fetchone()[0])
    expect(r, "kunjungan FKRTL → peserta ada", con.execute(f"SELECT count(*) FROM {k} x ANTI JOIN {p} y USING (edisi, peserta_id)").fetchone()[0])
    expect(r, "tindakan nonkapitasi → peserta ada", con.execute(f"SELECT count(*) FROM {n} x ANTI JOIN {p} y USING (edisi, peserta_id)").fetchone()[0])
    expect(r, "diagnosis sekunder → kunjungan FKRTL ada", con.execute(f"SELECT count(*) FROM {d} x ANTI JOIN {k} y USING (edisi, kunjungan_fkrtl_id)").fetchone()[0])
    expect(r, "rujukan → kunjungan FKTP ada", con.execute(f"SELECT count(*) FROM {rj} WHERE flag_rujukan_tanpa_fktp").fetchone()[0])
    expect(r, "ICD-10 3 digit FKRTL ada di buku kode", con.execute(f"SELECT count(DISTINCT dx_primer_icd3) FROM {k} x ANTI JOIN {i} y ON y.icd3 = x.dx_primer_icd3 WHERE x.dx_primer_icd3 IS NOT NULL").fetchone()[0])
    flags = {
        "calon klaim ganda": f"SELECT count(*) FROM {k} WHERE flag_calon_klaim_ganda",
        "selisih verifikasi": f"SELECT count(*) FROM {k} WHERE flag_selisih_verifikasi",
        "LOS ekstrem": f"SELECT count(*) FROM {k} WHERE flag_los_ekstrem",
        "tanggal lahir pengganti": f"SELECT count(*) FROM {p} WHERE flag_tgl_lahir_pengganti",
        "nama diagnosis dipulihkan (masuk + primer)": f"SELECT count(*) FILTER (WHERE flag_dx_masuk_nama_diperbaiki) + count(*) FILTER (WHERE flag_dx_primer_nama_diperbaiki) FROM {k}",
    }
    rows = [{"jenis": "ekspektasi", **x} for x in r]
    rows += [{"jenis": "flag", "nama": name, "nilai": int(con.execute(sql).fetchone()[0]), "harus": None, "lolos": None} for name, sql in flags.items()]
    out.write_table(pa.Table.from_pylist(rows, schema=pa.schema([("jenis", pa.string()), ("nama", pa.string()), ("nilai", pa.int64()),
                                                                  ("harus", pa.int64()), ("lolos", pa.bool_())])))
    raise_failed(r)


# keep SPEC importable from here for the repository's tests
assert SPEC
