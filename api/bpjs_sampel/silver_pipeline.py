"""L2 silver in Pipeline Builder: "Pipeline Silver Data Sampel BPJS" (DuckDB local), parallel to the Code Repository
silver (bpjs_sampel/repo/silver.py) — same silver contract, built where the user can see it: bronze Parquet in Files
→ silver datasets in a NEW folder (silver_pipeline/), so the running gold pipeline and Nexus keep reading the old
silver until this one is proven equal.

Mixed nodes (the user's choice, 2026-10-26): what the Builder shows well is visual — Rename/Cast steps generated
from bpjs_spec.SPEC (PSTV01 → peserta_id, FKL47 → biaya_tagih_rp …), an Aggregate step (diagnosis per kunjungan),
a Select step (dim_icd10) — and the rest is one SQL step per dataset: the label joins (one LEFT JOIN per labelled
column against the label_nilai books), the FKRTL part UNION ALL BY NAME, the p99/peer windows and the quality
flags. A visual Join node cannot sit after a SQL step in the DuckDB compiler (externalSql.ts: join needs known
columns, a SQL step's are unknown), so joins that follow SQL live inside the SQL step; the dx count is the visual
Aggregate, joined in SQL.

Expectations (the user's choice: move them into the Builder): primary key (unique), notNull on the keys, rowCount
>= 1 and rowLevel range checks (tgl_pulang >= tgl_datang, biaya_verifikasi <= biaya_tagih, biaya >= 0). What the
Builder cannot express — and is therefore NOT replaced yet: row count = bronze, FK relations between datasets
(kunjungan -> peserta, rujukan -> kunjungan FKTP) and sum(biaya_tagih) reconciliation against the source. Those
stay in the old silver's _laporan_kualitas until a Builder check can say them; retiring the Code Repository silver
before then would silently drop them.

The statement of every SQL step is generated from the same bpjs_spec the Code Repository runs, and the derived
columns copy api/bpjs_sampel/silver.py, so the two silvers can be compared row by row (baris, kunci, total biaya).
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from bpjs_sampel.repo.bpjs_spec import SPEC

PIPELINE = "Pipeline Silver Data Sampel BPJS"
SPEC_VERSION = 1
SAMPLE = 100  # rows of each input kept in the pipeline file for the editor's preview (gold_pipeline.SAMPLE)

SILVER = ["peserta", "kunjungan_fktp", "diagnosis_sekunder", "kunjungan_fkrtl", "tindakan_nonkapitasi", "rujukan",
          "dim_icd10", "dim_icd10_rinci", "dim_inacbg", "dim_wilayah", "dim_profil_faskes"]

# (node id, Files dataset name, folder, group, description) of the inputs; the name is the dataset in bronze/
# (fkrtl is two datasets, the label books live in bronze/_meta/) plus the running silver's dim_icd10 as the
# ICD-10 reference (the xlsx books it was built from are not Parquet, so the DuckDB engine cannot read them)
SOURCES = [
    ("s_kepesertaan", "kepesertaan", "bronze", "peserta", "Bronze kepesertaan: kode & nama kolom asli (PSTV*), 7 edisi"),
    ("s_fktpkapitasi", "fktpkapitasi", "bronze", "fktp", "Bronze FKTP kapitasi: 1 baris per kunjungan FKTP (FKP*)"),
    ("s_fkrtl_1", "fkrtl_bagian_1", "bronze", "klaim", "Bronze FKRTL bagian 1 (reguler, covid, dm): klaim INA-CBG (FKL*)"),
    ("s_fkrtl_2", "fkrtl_bagian_2", "bronze", "klaim", "Bronze FKRTL bagian 2 (KM, KIA ibu/anak, TB): klaim INA-CBG (FKL*)"),
    ("s_nonkapitasi", "nonkapitasi", "bronze", "fktp", "Bronze nonkapitasi: 1 baris per tindakan FKTP (PNK*)"),
    ("s_dx", "diagnosissekunder", "bronze", "klaim", "Bronze diagnosis sekunder: 1 baris per kode dx per kunjungan FKRTL"),
    ("s_lab_peserta", "label_nilai_kepesertaan", "_meta", "dimensi", "Buku label nilai kepesertaan (kode -> teks)"),
    ("s_lab_fktp", "label_nilai_fktpkapitasi", "_meta", "dimensi", "Buku label nilai FKTP kapitasi"),
    ("s_lab_fkrtl_1", "label_nilai_fkrtl_bagian_1", "_meta", "dimensi", "Buku label nilai FKRTL bagian 1"),
    ("s_lab_fkrtl_2", "label_nilai_fkrtl_bagian_2", "_meta", "dimensi", "Buku label nilai FKRTL bagian 2"),
    ("s_lab_nonkap", "label_nilai_nonkapitasi", "_meta", "dimensi", "Buku label nilai nonkapitasi"),
    ("s_icd10", "dim_icd10", "silver", "dimensi", "Referensi ICD-10 3 digit yang berjalan (dari buku kode xlsx; bukan Parquet sumber)"),
]
# node names the SQL steps address (node name = the table name in a query, as in gold_pipeline)
LAB_NODE = {"kepesertaan": "label_kepesertaan", "fktpkapitasi": "label_fktpkapitasi",
            "fkrtl": "label_fkrtl", "nonkapitasi": "label_nonkapitasi", "diagnosissekunder": "label_dx"}
GROUPS = [("klaim", "Klaim FKRTL", "#c23030"), ("fktp", "Kunjungan FKTP", "#2d72d2"), ("penyakit", "Penyakit", "#d1980b"),
          ("rujukan", "Rujukan", "#238551"), ("peserta", "Peserta", "#7961db"), ("dimensi", "Dimensi", "#5f6b7c")]

_CAST = {"date": "Date", "money": "Long", "int": "Long", "id": "Long", "float": "Double"}


def _steps(tabel: str, cols: set[str]) -> tuple[list[dict], list[str]]:
    """The visual steps of one fact (Rename + Cast from SPEC, only for columns the bronze dataset carries) and the
    silver column the SQL step may read for each SPEC row. FKRTL is renamed per part with the union of both schemas."""
    steps, read = [], []
    for src, name, kind in SPEC[tabel]:
        have = src in cols
        to = f"{name}_kode" if kind == "label" else name
        if have:
            steps.append({"id": uuid.uuid4().hex[:8], "kind": "rename", "params": {"column": src, "to": to}})
            if kind in _CAST:
                steps.append({"id": uuid.uuid4().hex[:8], "kind": "cast", "params": {"column": to, "type": _CAST[kind]}})
        read.append(to if have else "")
    return steps, read


def _fact_select(tabel: str, read: list[str]) -> tuple[str, str]:
    """The SELECT list and label joins of one fact over the renamed input (bpjs_spec.select_sql's rules):
    (silver select, joins) with the input as `t` and the label books as `lab`."""
    sel, joins = ["t.edisi"], []
    for (src, name, kind), col in zip(SPEC[tabel], read):
        if not col:
            sel.append(f"NULL AS {name}" if kind != "label" else f"NULL::INTEGER AS {name}_kode, NULL::VARCHAR AS {name}")
            continue
        c = f"t.{col}"
        if kind in ("id", "int", "money"):
            sel.append(f"TRY_CAST({c} AS BIGINT) AS {name}")
        elif kind == "float":
            sel.append(f"TRY_CAST({c} AS DOUBLE) AS {name}")
        elif kind == "key":
            sel.append(f"NULLIF(NULLIF(trim({c}::VARCHAR), ''), 'NONE') AS {name}")
        elif kind == "date":
            sel.append(f"CAST({c} AS DATE) AS {name}")
        elif kind == "flag":
            sel.append(f"CASE WHEN {c} IS NULL THEN NULL ELSE {c} = 1 END AS {name}")
        elif kind == "icd3":
            sel.append(f"NULLIF(upper(trim({c}::VARCHAR)), '') AS {name}")
        elif kind == "text":
            from bpjs_sampel.repo.bpjs_spec import REPAIR_COLS, repair_sql

            txt = f"NULLIF(NULLIF(trim({c}::VARCHAR), ''), 'NONE')"
            if src in REPAIR_COLS:
                fixed = repair_sql(txt)
                sel.append(f"CASE WHEN ({fixed}) IS DISTINCT FROM {txt} THEN upper(left({fixed}, 1)) || substr({fixed}, 2) ELSE {txt} END AS {name}")
                sel.append(f"({fixed}) IS DISTINCT FROM {txt} AS flag_{name}_diperbaiki")
            else:
                sel.append(f"{txt} AS {name}")
        elif kind == "label":
            a = f"l_{src.lower()}"
            joins.append(f"LEFT JOIN lab {a} ON {a}.edisi = t.edisi AND {a}.kolom = '{src}' AND {a}.kode = {c}")
            sel.append(f"TRY_CAST({c} AS INTEGER) AS {name}_kode")
            sel.append(f"CASE WHEN upper(trim({a}.label)) IN ('MISSING', 'TIDAK TERDEFINISI') THEN NULL ELSE {a}.label END AS {name}")
    return ",\n  ".join(sel), "\n".join(joins)


def _lab_cte(*nodes: str) -> str:
    union = " UNION ALL ".join(f"SELECT edisi, tabel, kolom, kode::INTEGER AS kode, label FROM {n}" for n in nodes)
    return f"lab AS ({union})"


def _fact_sql(tabel: str, read: list[str], extra: str, lab_nodes: tuple[str, ...]) -> str:
    sel, joins = _fact_select(tabel, read)
    if joins:  # a fact without labelled columns (diagnosis sekunder) needs no label book
        return (f"WITH {_lab_cte(*lab_nodes)},\nsrc AS (SELECT\n  {sel}\nFROM input t\n{joins})\n"
                f"SELECT *{extra}\nFROM src")
    return f"WITH src AS (SELECT\n  {sel}\nFROM input t)\nSELECT *{extra}\nFROM src"


# one SQL per silver dataset (the SQL steps); FKRTL and the dimensions reference the fact nodes by name
def _build_sql(reads: dict[str, list[str]]) -> dict[str, str]:
    sql = {
        "peserta": _fact_sql("kepesertaan", reads["kepesertaan"],
                             ", date_sub('year', tgl_lahir, DATE '2024-12-31') AS usia_akhir_2024,\n"
                             "  tgl_lahir < DATE '1901-01-01' AS flag_tgl_lahir_pengganti", ("label_kepesertaan",)),
        "kunjungan_fktp": _fact_sql("fktpkapitasi", reads["fktpkapitasi"],
                                    ", date_trunc('month', tgl_datang)::DATE AS bulan", ("label_fktpkapitasi",)),
        "diagnosis_sekunder": _fact_sql("diagnosissekunder", reads["diagnosissekunder"], "", ("label_dx",)),
        "tindakan_nonkapitasi": _fact_sql(
            "nonkapitasi", reads["nonkapitasi"],
            ", row_number() OVER (PARTITION BY edisi, kunjungan_id ORDER BY tgl_tindakan, tindakan) AS tindakan_ke",
            ("label_nonkapitasi",)),
    }
    # FKRTL: the two bronze parts renamed alike, unioned by name, labelled, then the dx count (the visual
    # Aggregate node dx_per_kunjungan) and the three quality flags with their p99 peer
    sel, joins = _fact_select("fkrtl", reads["fkrtl"])
    sql["kunjungan_fkrtl"] = f"""WITH {_lab_cte("label_fkrtl_1", "label_fkrtl_2")},
gab AS (SELECT * FROM input UNION ALL BY NAME SELECT * FROM fkrtl_2_bersih),
src AS (SELECT
  {sel}
FROM gab t
{joins}),
k AS (SELECT *, date_diff('day', tgl_datang, tgl_pulang) AS los_hari, biaya_tagih_rp - biaya_verifikasi_rp AS selisih_rp,
             date_trunc('month', tgl_pulang)::DATE AS bulan FROM src),
p99 AS (SELECT inacbg_kode, quantile_cont(los_hari, 0.99) AS los_p99 FROM k GROUP BY ALL)
SELECT k.*, coalesce(dx.jumlah_dx_sekunder, 0) AS jumlah_dx_sekunder,
       count(*) OVER (PARTITION BY k.edisi, k.peserta_id, k.tgl_datang, k.tgl_pulang, k.inacbg_kode, k.biaya_tagih_rp) > 1 AS flag_calon_klaim_ganda,
       k.selisih_rp <> 0 AS flag_selisih_verifikasi,
       k.los_hari > p99.los_p99 AND k.los_hari > 3 AS flag_los_ekstrem
FROM k LEFT JOIN dx_per_kunjungan dx USING (edisi, kunjungan_fkrtl_id) LEFT JOIN p99 USING (inacbg_kode)"""
    sql["rujukan"] = """SELECT r.edisi, r.kunjungan_fkrtl_id, r.rujukan_fktp_id AS kunjungan_fktp_id, r.peserta_id,
       f.tgl_datang AS tgl_fktp, r.tgl_datang AS tgl_fkrtl, date_diff('day', f.tgl_datang, r.tgl_datang) AS hari_ke_fkrtl,
       f.kabkota_fktp_kode AS kabkota_asal_kode, f.kabkota_fktp AS kabkota_asal, f.jenis_fktp AS jenis_faskes_asal,
       r.kabkota_fkrtl_kode AS kabkota_tujuan_kode, r.kabkota_fkrtl AS kabkota_tujuan, r.tipe_fkrtl AS tipe_faskes_tujuan,
       f.dx_icd3 AS dx_fktp_icd3, r.dx_primer_icd3 AS dx_fkrtl_icd3, f.dx_icd3 = r.dx_primer_icd3 AS dx_sama,
       f.kunjungan_fktp_id IS NULL AS flag_rujukan_tanpa_fktp
FROM input r LEFT JOIN kunjungan_fktp f ON f.edisi = r.edisi AND f.kunjungan_fktp_id = r.rujukan_fktp_id
WHERE r.rujukan_fktp_id IS NOT NULL"""
    sql["dim_icd10_rinci"] = """WITH v AS (SELECT dx_masuk_kode AS kode, dx_masuk_icd3 AS icd3, dx_masuk_nama AS nama FROM input
           UNION ALL SELECT dx_primer_kode, dx_primer_icd3, dx_primer_nama FROM input
           UNION ALL SELECT dx_kode, dx_icd3, dx_nama FROM tindakan_nonkapitasi),
     c AS (SELECT kode, icd3, nama, count(*) n FROM v WHERE kode IS NOT NULL AND nama IS NOT NULL GROUP BY ALL)
SELECT kode, any_value(icd3 ORDER BY n DESC) AS icd3, any_value(nama ORDER BY n DESC) AS nama, sum(n) AS dipakai
FROM c GROUP BY kode ORDER BY kode"""
    sql["dim_inacbg"] = """SELECT inacbg_kode, mode(inacbg_deskripsi) AS deskripsi,
       mode(inacbg_cmg) AS cmg, mode(inacbg_tipe_kasus) AS tipe_kasus, mode(inacbg_spesifikasi) AS spesifikasi,
       mode(inacbg_keparahan) AS keparahan, count(*) AS dipakai
FROM input WHERE inacbg_kode IS NOT NULL GROUP BY inacbg_kode ORDER BY inacbg_kode"""
    sql["dim_wilayah"] = f"""WITH {_lab_cte("label_kepesertaan", "label_fktpkapitasi", "label_fkrtl_1", "label_fkrtl_2", "label_nonkapitasi")},
     k AS (SELECT kode, label FROM lab WHERE kolom IN ('PSTV10','PSTV14','FKP06','FKP17','FKL06','FKL26','PNK07')),
     p AS (SELECT kode, label FROM lab WHERE kolom IN ('PSTV09','PSTV13','FKP05','FKL05','PNK06'))
SELECT k.kode AS kabkota_kode, mode(k.label) AS kabkota, k.kode // 100 AS provinsi_kode,
       (SELECT mode(p.label) FROM p WHERE p.kode = k.kode // 100) AS provinsi
FROM k GROUP BY k.kode ORDER BY k.kode"""
    sql["dim_profil_faskes"] = """WITH v AS (SELECT kabkota_fktp_kode AS kabkota_kode, kepemilikan_fktp AS kepemilikan, jenis_fktp AS jenis, tipe_fktp AS tipe, 'FKTP' AS tingkat FROM kunjungan_fktp
           UNION ALL SELECT kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl, 'FKRTL' FROM input
           UNION ALL SELECT kabkota_faskes_kode, kepemilikan_faskes, jenis_faskes, tipe_faskes, 'NONKAPITASI' FROM tindakan_nonkapitasi)
SELECT md5(concat_ws('|', tingkat, kabkota_kode, kepemilikan, jenis, tipe)) AS faskes_profil_id, tingkat, kabkota_kode,
       kepemilikan, jenis, tipe, count(*) AS kunjungan
FROM v GROUP BY ALL ORDER BY tingkat, kabkota_kode"""
    return sql


def _uid() -> str:
    return uuid.uuid4().hex[:8]


def _row_level(*conds: tuple[str, str, dict]) -> dict:
    items = [{"id": f"c{i}", "left": {"kind": "column", "column": left}, "op": op, "right": right} for i, (left, op, right) in enumerate(conds)]
    return {"id": _uid(), "kind": "rowLevel",
            "condition": json.dumps({"id": "root", "match": "all", "items": items})}


def _col(name: str) -> dict:
    return {"kind": "column", "column": name}


def _num(value: int) -> dict:
    return {"kind": "value", "type": "Long", "value": str(value)}


def _expectations(name: str) -> list[dict]:
    """The Builder expectations of one silver output: what used to be checked in the transform, as far as the
    Builder can say it (see the module docstring for what has no equivalent here)."""
    base = [{"id": _uid(), "kind": "rowCount", "min": 1}]
    unique = {"peserta": ["edisi", "peserta_id"], "kunjungan_fktp": ["edisi", "kunjungan_fktp_id"],
              "diagnosis_sekunder": ["edisi", "kunjungan_fkrtl_id", "dx_kode"],
              "kunjungan_fkrtl": ["edisi", "kunjungan_fkrtl_id"], "tindakan_nonkapitasi": ["edisi", "kunjungan_id", "tindakan_ke"],
              "rujukan": ["edisi", "kunjungan_fkrtl_id"], "dim_icd10": ["icd3"], "dim_icd10_rinci": ["kode"],
              "dim_inacbg": ["inacbg_kode"], "dim_wilayah": ["kabkota_kode"], "dim_profil_faskes": ["faskes_profil_id"]}[name]
    out = [{"id": _uid(), "kind": "unique", "columns": unique}, *base]
    if name in ("peserta", "kunjungan_fkrtl"):
        out.append({"id": _uid(), "kind": "notNull", "columns": unique})
    if name in ("kunjungan_fktp", "kunjungan_fkrtl"):
        out.append(_row_level(("tgl_pulang", "is greater than or equal to", _col("tgl_datang"))))
    if name == "kunjungan_fkrtl":
        out.append(_row_level(("biaya_verifikasi_rp", "is less than or equal to", _col("biaya_tagih_rp")),
                              ("biaya_tagih_rp", "is greater than or equal to", _num(0)),
                              ("biaya_verifikasi_rp", "is greater than or equal to", _num(0))))
    if name == "tindakan_nonkapitasi":
        out.append(_row_level(("biaya_tagih_rp", "is greater than or equal to", _num(0))))
    return out


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


def _rows(table, n: int = SAMPLE) -> list[dict]:
    from decimal import Decimal

    def cell(v):
        if isinstance(v, Decimal):
            return int(v) if v == v.to_integral_value() else float(v)
        return v.isoformat() if hasattr(v, "isoformat") else v

    return [{k: cell(v) for k, v in r.items()} for r in table.slice(0, n).to_pylist()]


def _id_num(n: int) -> str:
    return f"{n:,}".replace(",", ".")


X = {"source": 40, "clean": 380, "sql": 760, "output": 1180}
ROW_H = 110


def content(sources: dict[str, dict], out_folder: dict, project: str) -> tuple[dict, dict[str, str]]:
    """The pipeline file, like gold_pipeline.content. sources: {dataset name: {item_id, table, rows, folder}} for
    every SOURCES dataset (bronze, its label books, and the running silver's dim_icd10)."""
    now = datetime.now(timezone.utc).isoformat()
    cols = {name: {f.name for f in s["table"].schema} for name, s in sources.items()}
    fkrtl_cols = cols["fkrtl_bagian_1"] | cols["fkrtl_bagian_2"]
    steps: dict[str, list[dict]] = {}
    reads: dict[str, list[str]] = {}
    for tabel, have in (("kepesertaan", cols["kepesertaan"]), ("fktpkapitasi", cols["fktpkapitasi"]),
                        ("fkrtl", fkrtl_cols), ("nonkapitasi", cols["nonkapitasi"]),
                        ("diagnosissekunder", cols["diagnosissekunder"])):
        steps[tabel], reads[tabel] = _steps(tabel, have)
    sql = _build_sql(reads)

    datasets, nodes = {}, []
    y = {}

    def put(nid: str, row: int) -> int:
        y[nid] = 60 + ROW_H * row
        return y[nid]

    # sources, in SOURCES order
    src_name = {"s_kepesertaan": "kepesertaan", "s_fktpkapitasi": "fktpkapitasi", "s_fkrtl_1": "fkrtl_bagian_1",
                "s_fkrtl_2": "fkrtl_bagian_2", "s_nonkapitasi": "nonkapitasi", "s_dx": "diagnosissekunder",
                "s_lab_peserta": "label_kepesertaan", "s_lab_fktp": "label_fktpkapitasi",
                "s_lab_fkrtl_1": "label_fkrtl_1", "s_lab_fkrtl_2": "label_fkrtl_2",
                "s_lab_nonkap": "label_nonkapitasi", "s_icd10": "icd10_ref"}
    for i, (nid, ds_name, folder, group, doc) in enumerate(SOURCES):
        s = sources[ds_name]
        ds = f"ds_{nid}"
        datasets[ds] = {"id": ds, "name": ds_name, "origin": f"Files · {project} / {s['folder']} / {ds_name}", "createdAt": now,
                        "refreshedAt": now, "columns": [{"name": f.name, "type": _type(f.type)} for f in s["table"].schema],
                        "rows": _rows(s["table"]), "totalRows": s["rows"], "ref": {"kind": "drive", "itemId": s["item_id"]}}
        nodes.append({"id": nid, "kind": "source", "name": src_name[nid], "x": X["source"], "y": put(nid, i), "color": f"lg-{group}",
                      "datasetId": ds, "description": f"{doc} — {_id_num(s['rows'])} baris (preview: {_id_num(SAMPLE)} baris pertama)"})

    def transform(nid: str, name: str, group: str, inp: str, steps_: list[dict], row: int, x: str = "sql") -> str:
        nodes.append({"id": nid, "kind": "transform", "name": name, "x": X[x], "y": put(nid, row), "color": f"lg-{group}",
                      "input": inp, "steps": steps_})
        return nid

    def sql_node(nid: str, name: str, group: str, inp: str, query: str, row: int) -> str:
        return transform(nid, name, group, inp, [{"id": _uid(), "kind": "sql", "params": {"query": query.strip()}}], row)

    # the visual clean-ups (Rename/Cast from SPEC), then one SQL node per silver dataset
    transform("t_peserta_clean", "kepesertaan_bersih", "peserta", "s_kepesertaan", steps["kepesertaan"], 0, "clean")
    sql_node("t_peserta", "peserta", "peserta", "t_peserta_clean", sql["peserta"], 0)
    transform("t_fktp_clean", "fktpkapitasi_bersih", "fktp", "s_fktpkapitasi", steps["fktpkapitasi"], 1, "clean")
    sql_node("t_fktp", "kunjungan_fktp", "fktp", "t_fktp_clean", sql["kunjungan_fktp"], 1)
    transform("t_dx_clean", "diagnosissekunder_bersih", "klaim", "s_dx", steps["diagnosissekunder"], 2, "clean")
    sql_node("t_dx", "diagnosis_sekunder", "klaim", "t_dx_clean", sql["diagnosis_sekunder"], 2)
    # diagnosis per FKRTL visit, counted with the visual Aggregate step (on the renamed rows: columns known)
    transform("t_dx_agg", "dx_per_kunjungan", "klaim", "t_dx_clean",
              [{"id": _uid(), "kind": "aggregate", "params": {"groupBy": ["edisi", "kunjungan_fkrtl_id"],
                "aggs": json.dumps([{"id": "a0", "fn": "Count", "column": "", "output": "jumlah_dx_sekunder"}])}}], 3, "clean")
    transform("t_fkrtl_1_clean", "fkrtl_1_bersih", "klaim", "s_fkrtl_1", steps["fkrtl"], 4, "clean")
    transform("t_fkrtl_2_clean", "fkrtl_2_bersih", "klaim", "s_fkrtl_2", steps["fkrtl"], 5, "clean")
    sql_node("t_fkrtl", "kunjungan_fkrtl", "klaim", "t_fkrtl_1_clean", sql["kunjungan_fkrtl"], 4)
    transform("t_nonkap_clean", "nonkapitasi_bersih", "fktp", "s_nonkapitasi", steps["nonkapitasi"], 6, "clean")
    sql_node("t_nonkap", "tindakan_nonkapitasi", "fktp", "t_nonkap_clean", sql["tindakan_nonkapitasi"], 6)
    sql_node("t_rujukan", "rujukan", "rujukan", "t_fkrtl", sql["rujukan"], 7)
    # dimensions: dim_icd10 is the running reference, kept with a visual Select; the rest are SQL over the facts
    transform("t_dim_icd10", "dim_icd10", "dimensi", "s_icd10",
              [{"id": _uid(), "kind": "select", "params": {"columns": ["icd3", "nama", "bab"]}}], 8, "clean")
    sql_node("t_dim_icd10_rinci", "dim_icd10_rinci", "dimensi", "t_fkrtl", sql["dim_icd10_rinci"], 9)
    sql_node("t_dim_inacbg", "dim_inacbg", "dimensi", "t_fkrtl", sql["dim_inacbg"], 10)
    sql_node("t_dim_wilayah", "dim_wilayah", "dimensi", "s_lab_peserta", sql["dim_wilayah"], 11)
    sql_node("t_dim_faskes", "dim_profil_faskes", "dimensi", "t_fkrtl", sql["dim_profil_faskes"], 12)

    node_of = {"peserta": "t_peserta", "kunjungan_fktp": "t_fktp", "diagnosis_sekunder": "t_dx",
               "kunjungan_fkrtl": "t_fkrtl", "tindakan_nonkapitasi": "t_nonkap", "rujukan": "t_rujukan",
               "dim_icd10": "t_dim_icd10", "dim_icd10_rinci": "t_dim_icd10_rinci", "dim_inacbg": "t_dim_inacbg",
               "dim_wilayah": "t_dim_wilayah", "dim_profil_faskes": "t_dim_faskes"}
    outputs, out_ids = [], {}
    for row, name in enumerate(SILVER):
        oid = f"o_{node_of[name]}"
        out_ids[name] = oid
        outputs.append({"id": oid, "name": name, "node": node_of[name], "kind": "dataset", "columns": None,
                        "writeMode": "default", "location": {"id": out_folder["id"], "name": out_folder["name"]},
                        "expectations": _expectations(name), "x": X["output"], "y": 60 + ROW_H * row})
    text = [
        {"id": "note_1", "x": X["source"], "y": -210, "w": 360, "h": 160, "color": "lg-dimensi",
         "text": "SUMBER — bronze Data Sampel BPJS 2025 di Files (kolom asli PSTV/FKP/FKL/PNK, 7 edisi; FKRTL dua "
                 "bagian) + buku label_nilai_* + dim_icd10 berjalan sebagai referensi ICD-10 (buku xlsx-nya bukan Parquet)."},
        {"id": "note_2", "x": X["clean"], "y": -210, "w": 380, "h": 160, "color": "lg-klaim",
         "text": "CAMPURAN — node *_bersih = langkah visual Rename/Cast dari bpjs_spec; node dx_per_kunjungan = Aggregate "
                 "visual; dim_icd10 = Select visual. Sisanya satu langkah SQL per dataset: join label, UNION ALL BY NAME "
                 "FKRTL, flag p99, rujukan. Join visual tidak bisa setelah langkah SQL di mesin DuckDB, jadi join di SQL."},
        {"id": "note_3", "x": X["sql"], "y": -210, "w": 380, "h": 160, "color": "lg-peserta",
         "text": "EKSPEKTASI BUILDER — primary key, notNull, rowCount, rowLevel (tanggal & biaya) ada di tiap output. "
                 "Yang belum ada padanannya di Builder: baris = bronze, relasi antar-dataset, total biaya = sumber "
                 "(tetap di _laporan_kualitas silver lama). Output paralel di folder silver_pipeline/ — gold belum memakainya."},
    ]
    body = {"type": "batch", "compute": "duckdb", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes,
            "outputs": outputs, "legend": [{"id": f"lg-{g}", "name": n, "hex": h} for g, n, h in GROUPS],
            "location": {"id": out_folder["id"], "name": out_folder["name"]}, "textNodes": text, "schedules": [],
            "meta": {"version": SPEC_VERSION,
                     "description": "Silver Data Sampel BPJS Kesehatan Edisi 2025 di Pipeline Builder (DuckDB lokal), paralel Code Repository."}}
    return body, out_ids


def ensure(sources: dict[str, dict], out_folder: dict, pipelines_folder: str, project: str,
           existing: Optional[str] = None, queue: bool = True) -> dict:
    """Create (or bring up to SPEC_VERSION) the pipeline file in Files and queue a build, as gold_pipeline.ensure."""
    import json as _json

    import drive
    import pipeline_datasets
    import pipeline_runtime as rt

    body, out_ids = content(sources, out_folder, project)
    if existing:
        current = _json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(existing)))
        if (current.get("meta") or {}).get("version") == SPEC_VERSION:
            return {"pipeline_id": existing, "created": False}
        body["createdAt"] = current.get("createdAt") or body["createdAt"]
        pipeline_datasets.save_pipeline(existing, pipeline_datasets.PipelineFileChange(content=body))
        pid = existing
    else:
        pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=pipelines_folder, content=body))["id"]
    b = rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="manual")) if queue else {}
    return {"pipeline_id": pid, "outputs": out_ids, "build": b.get("id"), "created": not existing}

