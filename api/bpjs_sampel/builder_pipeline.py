"""One Pipeline Builder pipeline from Data Mentah (bronze) to Siap Analisis (gold), built from visual nodes the way a
Palantir Pipeline Builder graph is: sources → Union → Transform (Rename, Cast, Trim, Conditional column, Mapping
join, Formula, Window, Aggregate …) → Join → outputs. No SQL step anywhere: every node shows what it does on the
canvas, and every step can be opened and edited in the Builder.

Stages, as the jury reads them (code keeps the bronze/silver/gold keys):
  1 · Data Mentah    the bronze tables in Files: original column codes (PSTV/FKP/FKL/PNK), values as read from the
                     source files, plus the label books (code → text per edition) and two reference tables.
  2 · Data Bersih    one transform per fact (checkpoint): clear column names, types, codes looked up in the label
                     books (Mapping join), text repaired; joins for the FKRTL derived columns; the dimensions.
  3 · Siap Analisis  the gold datasets for dashboards, the Nexus and the AI agents: aggregates, ratios, peer
                     statistics, risk scores, each joined to the 38-province region dimension.

It runs on the DuckDB local engine (compute "duckdb", api/pipeline_duckdb.py): each output compiles to one DuckDB
statement over the Parquet files on disk, and checkpoint nodes (each Data Bersih fact, klaim, wilayah, provinsi …) are
computed once per content and shared by every output and preview. The rules are the Code Repository's
(bpjs_sampel/repo/silver.py, bpjs_spec.SPEC) and the SQL gold pipeline's (gold_pipeline.SQL), node for node, so the
outputs can be compared row by row with both before anything reads them.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from bpjs_sampel import builder_layout
from bpjs_sampel.repo.bpjs_spec import GO_REPAIR, REPAIR_COLS, SPEC

PIPELINE = "Pipeline Data Sampel BPJS: Data Mentah → Siap Analisis"
SPEC_VERSION = 10
SAMPLE = 100  # rows of each input kept in the pipeline file for the editor's preview (web/src/lib/deployed.ts SAMPLE_ROWS)
LIT = "\u0001"  # marks a literal in a Concatenate / Coalesce expression list (web/src/lib/pipeline.ts LITERAL)

# (dataset key, Files folder key, group, description) of the inputs; the key is the dataset's name in Files
SOURCES = [
    ("kepesertaan", "bronze", "peserta", "Peserta JKN per edisi, kolom asli PSTV* (kode)"),
    ("fktpkapitasi", "bronze", "fktp", "Kunjungan FKTP kapitasi (puskesmas, klinik, dokter praktik), kolom asli FKP*"),
    ("fkrtl_bagian_1", "bronze", "klaim", "Klaim FKRTL bagian 1 (reguler, covid, DM), kolom asli FKL*"),
    ("fkrtl_bagian_2", "bronze", "klaim", "Klaim FKRTL bagian 2 (kesehatan mental, KIA ibu/anak, TB), kolom asli FKL*"),
    ("diagnosissekunder", "bronze", "klaim", "Diagnosis sekunder klaim FKRTL: satu baris per kode per kunjungan"),
    ("nonkapitasi", "bronze", "fktp", "Tindakan FKTP nonkapitasi, kolom asli PNK*"),
    ("label_nilai_kepesertaan", "bronze/_meta", "dimensi", "Buku label: kode → teks per kolom per edisi (kepesertaan)"),
    ("label_nilai_fktpkapitasi", "bronze/_meta", "dimensi", "Buku label FKTP kapitasi"),
    ("label_nilai_fkrtl_bagian_1", "bronze/_meta", "dimensi", "Buku label FKRTL bagian 1"),
    ("label_nilai_fkrtl_bagian_2", "bronze/_meta", "dimensi", "Buku label FKRTL bagian 2"),
    ("label_nilai_nonkapitasi", "bronze/_meta", "dimensi", "Buku label nonkapitasi"),
    ("dim_icd10", "silver", "dimensi", "Referensi ICD-10 3 digit (buku kode resmi, dibaca dari xlsx oleh Code Repository)"),
    ("ibukota_provinsi", "bronze/_meta", "dimensi", "Referensi ibu kota 38 provinsi dan koordinatnya (titik peta)"),
]
# the legend, in lane order top to bottom (the Builder's Layout draws one lane per legend colour, in this order)
GROUPS = [("peserta", "Peserta", "#7961db"), ("fktp", "Kunjungan FKTP", "#2d72d2"), ("penyakit", "Penyakit", "#d1980b"),
          ("dimensi", "Dimensi & referensi", "#5f6b7c"), ("klaim", "Klaim FKRTL", "#c23030"), ("rujukan", "Rujukan", "#238551")]
# the province capitals (gold provinsi's map point layer); 99 'TIDAK TERDEFINISI' has none
IBUKOTA = [
    (11, "Banda Aceh", "5.55,95.32"), (12, "Medan", "3.59,98.67"), (13, "Padang", "-0.95,100.35"), (14, "Pekanbaru", "0.51,101.45"),
    (15, "Jambi", "-1.61,103.61"), (16, "Palembang", "-2.99,104.76"), (17, "Bengkulu", "-3.8,102.27"), (18, "Bandar Lampung", "-5.43,105.26"),
    (19, "Pangkalpinang", "-2.13,106.11"), (21, "Tanjungpinang", "0.92,104.45"), (31, "Jakarta", "-6.2,106.85"), (32, "Bandung", "-6.91,107.61"),
    (33, "Semarang", "-6.97,110.42"), (34, "Yogyakarta", "-7.8,110.36"), (35, "Surabaya", "-7.26,112.75"), (36, "Serang", "-6.12,106.15"),
    (51, "Denpasar", "-8.65,115.22"), (52, "Mataram", "-8.58,116.12"), (53, "Kupang", "-10.17,123.61"), (61, "Pontianak", "-0.03,109.33"),
    (62, "Palangka Raya", "-2.21,113.92"), (63, "Banjarbaru", "-3.44,114.83"), (64, "Samarinda", "-0.5,117.15"), (65, "Tanjung Selor", "2.84,117.37"),
    (71, "Manado", "1.47,124.84"), (72, "Palu", "-0.9,119.87"), (73, "Makassar", "-5.15,119.43"), (74, "Kendari", "-3.97,122.51"),
    (75, "Gorontalo", "0.54,123.06"), (76, "Mamuju", "-2.68,118.89"), (81, "Ambon", "-3.7,128.17"), (82, "Sofifi", "0.74,127.56"),
    (91, "Manokwari", "-0.86,134.06"), (92, "Sorong", "-0.88,131.26"), (94, "Jayapura", "-2.53,140.72"), (95, "Merauke", "-8.49,140.4"),
    (96, "Nabire", "-3.37,135.48"), (97, "Wamena", "-4.1,138.95"),
]
# label columns per region dimension (silver dim_wilayah): kab/kota and province codes of every table
KABKOTA_COLS = "PSTV10, PSTV14, FKP06, FKP17, FKL06, FKL26, PNK07"
PROVINSI_COLS = "PSTV09, PSTV13, FKP05, FKL05, PNK06"


def _uid() -> str:
    return uuid.uuid4().hex[:8]


# ------------------------------------------------------------------------------------------------ steps (the Builder's
# params, as web/src/lib/pipeline.ts stores them)


def _s(kind: str, **params) -> dict:
    return {"id": _uid(), "kind": kind, "params": {k.rstrip("_"): v for k, v in params.items() if v is not None}}


def rename(column, to):
    return _s("rename", column=column, to=to)


def cast(column, type_, output=None):
    return _s("cast", column=column, type=type_, output=output)


def constant(output, type_, value=""):
    return _s("constant", output=output, type=type_, value=value)


def trim(column, output=None):
    return _s("trim", column=column, side="Both", output=output)


def upper(column, output=None):
    return _s("uppercase", column=column, output=output)


def nullif(column, value, output=None):
    return _s("nullif", column=column, value=value, output=output)


def fill(column, value):
    return _s("fill", column=column, value=value)


def formula(output, text):
    return _s("formula", formula=text, output=output)


def lit(text: str) -> str:
    return LIT + text


def concat(output, parts, sep="", null_if_any=False):
    return _s("concat", columns=parts, separator=sep, nullIfAny="true" if null_if_any else "false", output=output)


def coalesce(output, parts):
    return _s("coalesce", columns=parts, output=output)


def md5(output, column):
    return _s("hash", columns=[column], algorithm="MD5", output=output)


def select(columns):
    return _s("select", columns=list(columns))


def drop(columns):
    return _s("drop", columns=list(columns))


def keep(group):
    return _s("filter", filter=json.dumps(group), mode="Keep rows")


def aggregate(group_by, aggs):
    return _s("aggregate", groupBy=list(group_by), aggs=json.dumps(aggs), grouping="Group by")


def window(fn, output, partition, order=(), column="", frame=None):
    return _s("window", fn=fn, column=column, partitionBy=list(partition), orderBy=json.dumps([{"column": c, "direction": d} for c, d in order]),
              output=output, frame=frame)


def case(output, branches, else_=None, type_="Auto"):
    return _s("case_when", cases=json.dumps({"cases": [{"id": _uid(), "when": w, "then": t} for w, t in branches], "else": else_}),
              type=type_, output=output)


def date_diff(output, end, start, unit="Days"):
    return _s("date_diff", column=end, start=start, unit=unit, output=output)


def date_trunc(output, column, unit):
    return _s("date_trunc", column=column, unit=unit, output=output)


def date_part(output, column, part):
    return _s("date_part", column=column, part=part, output=output)


def month_text(column):
    """A date as its month, 2024-07 (strftime '%Y-%m'), in place."""
    return _s("format_date", column=column, pattern="yyyy-MM")


def regex_replace(column, find, with_, output=None):
    return _s("replace", column=column, find=find, with_=with_, mode="Regex", output=output)


def substring(output, column, start, length=None):
    return _s("substring", column=column, start=str(start), length="" if length is None else str(length), output=output)


def lpad(output, column, length, fill_):
    return _s("pad", column=column, length=str(length), fill=fill_, side="Left", output=output)


def mapping(columns, node, key, value):
    return _s("mapping_join", mapping=node, key=key, value=value, columns=list(columns), default="")


# conditions


def col(c):
    return {"kind": "column", "column": c}


def val(v, t="String"):
    return {"kind": "value", "type": t, "value": str(v).lower() if isinstance(v, bool) else str(v)}


TRUE, FALSE, NULL = val(True, "Boolean"), val(False, "Boolean"), None


def c(left, op, right=None, right2=None):
    out = {"id": _uid(), "left": col(left), "op": op, "right": right}
    if right2 is not None:
        out["right2"] = right2
    return out


def all_(*items):
    return {"id": _uid(), "match": "all", "items": list(items)}


def any_(*items):
    return {"id": _uid(), "match": "any", "items": list(items)}


def is_true(column):
    return c(column, "is equal to", TRUE)


def agg(fn, output, column="", where=None, arg=None):
    out = {"id": _uid(), "fn": fn, "column": column, "output": output}
    if where is not None:
        out["where"] = where
    if arg is not None:
        out["arg"] = str(arg)
    return out


# the claim measures every FKRTL aggregate carries (gold_pipeline.MEASURES); the sums are cast to Double after
def measures(*, berisiko=False):
    out = [agg("Count", "klaim"), agg("Count", "klaim_inap", where=all_(is_true("rawat_inap"))), agg("Count distinct", "peserta", "peserta_id"),
           agg("Sum", "biaya_tagih_rp", "biaya_tagih_rp"), agg("Sum", "biaya_verifikasi_rp", "biaya_verifikasi_rp"),
           agg("Sum", "los_hari_inap", "los_hari", where=all_(is_true("rawat_inap"))), agg("Count", "readmisi_30", where=all_(is_true("readmisi_30"))),
           agg("Count", "calon_klaim_ganda", where=all_(is_true("flag_calon_klaim_ganda"))),
           agg("Count", "selisih_verifikasi", where=all_(is_true("flag_selisih_verifikasi"))), agg("Count", "los_ekstrem", where=all_(is_true("flag_los_ekstrem")))]
    if berisiko:
        out.append(agg("Count", "klaim_berisiko", where=any_(is_true("flag_calon_klaim_ganda"), is_true("flag_selisih_verifikasi"), is_true("flag_los_ekstrem"))))
    return out


SUMS = [cast("biaya_tagih_rp", "Double"), cast("biaya_verifikasi_rp", "Double"), cast("los_hari_inap", "Double")]


def _measure_steps(group_by, *, berisiko=False):
    return [aggregate(group_by, measures(berisiko=berisiko)), *[dict(s, id=_uid()) for s in SUMS]]


# ------------------------------------------------------------------------------------------------ the graph


class Graph:
    """Nodes and outputs as the pipeline file stores them; x/y are laid out at the end (`layout`)."""

    def __init__(self):
        self.nodes: list[dict] = []
        self.outputs: list[dict] = []
        # the stage the nodes being added belong to (1 Data Mentah, 2 Data Bersih, 3 Siap Analisis): layout columns
        self.stage = 1
        self.stage_of: dict[str, int] = {}

    def _add(self, node: dict, group: str, description: Optional[str]) -> str:
        node["color"] = f"lg-{group}"
        if description:
            node["description"] = description
        self.nodes.append(node)
        self.stage_of[node["id"]] = self.stage
        return node["id"]

    def source(self, nid, name, dataset_id, group, description=None):
        return self._add({"id": nid, "kind": "source", "name": name, "datasetId": dataset_id}, group, description)

    def transform(self, nid, name, inp, steps, group, description=None, checkpoint=False):
        node = {"id": nid, "kind": "transform", "name": name, "input": inp, "steps": steps}
        if checkpoint:
            node["checkpoint"] = True
        return self._add(node, group, description)

    def join(self, nid, name, left, right, keys, group, right_columns, how="left", prefix="", description=None):
        keys = [(k, k) if isinstance(k, str) else k for k in keys]
        node = {"id": nid, "kind": "join", "name": name, "left": left, "right": right, "leftKey": keys[0][0], "rightKey": keys[0][1],
                "keys": [{"left": a, "right": b, "op": "="} for a, b in keys], "how": how, "leftColumns": None,
                "rightColumns": list(right_columns), "rightPrefix": prefix}
        return self._add(node, group, description)

    def union(self, nid, name, inputs, group, description=None):
        return self._add({"id": nid, "kind": "union", "name": name, "inputs": list(inputs), "mode": "union all"}, group, description)

    def output(self, name, node, folder, expectations):
        oid = f"o_{name}"
        self.outputs.append({"id": oid, "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default",
                             "location": folder, "expectations": expectations})
        return oid


# ------------------------------------------------------------------------------------------------ 2 · Data Bersih


def _silver_columns(tabel: str) -> list[str]:
    """The silver columns of a fact in order (bpjs_spec.select_sql): a label is its code then its text, a repaired
    text is followed by its flag."""
    out = ["edisi"]
    for src, name, kind in SPEC[tabel]:
        if kind == "label":
            out += [f"{name}_kode", name]
        elif kind == "text" and src in REPAIR_COLS:
            out += [name, f"flag_{name}_diperbaiki"]
        else:
            out.append(name)
    return out


def _clean_steps(tabel: str, have: set[str], label_node: Optional[str]) -> list[dict]:
    """The visual steps of a fact (bpjs_spec.select_sql's rules): Rename to the silver names, the cleaning of each
    kind, the label keys and one Mapping join against the table's label book, the repaired diagnosis texts."""
    steps = [rename(src, f"{name}_kode" if kind == "label" else name) for src, name, kind in SPEC[tabel] if src in have]
    labels = []
    for src, name, kind in SPEC[tabel]:
        if src not in have:  # a column this table's source lacks: null, as the Code Repository writes it
            steps += [constant(f"{name}_kode", "Integer"), constant(name, "String")] if kind == "label" else \
                [constant(name, {"id": "Long", "int": "Long", "money": "Long", "float": "Double", "date": "Date", "flag": "Boolean"}.get(kind, "String"))]
            continue
        if kind in ("id", "int", "money"):
            steps.append(cast(name, "Long"))
        elif kind == "float":
            steps.append(cast(name, "Double"))
        elif kind == "date":
            steps.append(cast(name, "Date"))
        elif kind in ("key", "text"):
            steps += [trim(name), nullif(name, ""), nullif(name, "NONE")]
            if kind == "text" and src in REPAIR_COLS:
                steps += _repair_steps(name)
        elif kind == "icd3":
            # the ICD-10 category: the first three characters, kept when they are one (a letter, a digit, a digit or
            # letter). In the dm, kia_ibu and kia_anak editions FKL24A holds "code-name" (FKL24A and FKL24B swapped);
            # every other value is the code itself, except the placeholder 9999 (no category: empty)
            steps += [trim(name), upper(name), substring(name, name, 1, 3),
                      case(name, [(all_(c(name, "regex match", val("[A-Z][0-9][0-9A-Z]"))), col(name))], NULL, "String")]
        elif kind == "flag":
            steps.append(case(name, [(all_(c(name, "is equal to (not null safe)", val(1, "Long"))), TRUE), (all_(c(name, "is not null")), FALSE)], NULL, "Boolean"))
        elif kind == "label":
            # the label book key: column code | edition | value code (node label_*: kunci)
            steps += [cast(f"{name}_kode", "Integer"), concat(name, [lit(src), "edisi", f"{name}_kode"], "|", null_if_any=True)]
            labels.append(name)
    if labels:
        steps.append(mapping(labels, label_node, "kunci", "label"))
    return steps


def _repair_steps(name: str) -> list[dict]:
    """Diagnosis names whose 'go' the source lost (narthrosis → gonarthrosis …): each word restored by a Find and
    replace (regex, whole word), the first letter capitalised where something changed, and a flag of the change."""
    fixed, head, rest, cap = f"{name}_dipulihkan", f"{name}_awal", f"{name}_sisa", f"{name}_kapital"
    steps, first = [], True
    for bad, good in GO_REPAIR.items():
        for b, g in ((bad, good), (bad.capitalize(), good.capitalize())):
            steps.append(regex_replace(name if first else fixed, f"\\b{b}\\b", g, output=fixed))
            first = False
    flag = f"flag_{name}_diperbaiki"
    steps += [case(flag, [(all_(c(fixed, "is equal to", col(name))), FALSE)], TRUE, "Boolean"),
              substring(head, fixed, 1, 1), upper(head), substring(rest, fixed, 2), concat(cap, [head, rest]),
              case(name, [(all_(is_true(flag)), col(cap))], col(name), "String"), drop([fixed, head, rest, cap])]
    return steps


def _label_book(g: Graph, nid: str, name: str, inp: str) -> str:
    """A label book ready for a Mapping join: key column|edition|code → label, MISSING / TIDAK TERDEFINISI as null."""
    return g.transform(nid, name, inp, [
        concat("kunci", ["kolom", "edisi", "kode"], "|"),
        trim("label", "label_baku"), upper("label_baku"),
        case("label", [(all_(c("label_baku", "is in", val("MISSING, TIDAK TERDEFINISI"))), NULL)], col("label"), "String"),
        select(["kunci", "label"]),
    ], "dimensi", "Buku label siap dipakai: kunci kolom|edisi|kode → teks label; MISSING dan TIDAK TERDEFINISI menjadi kosong (null).")


LABEL_BOOK = "label_siap"


def _label_books(g: Graph, books: list[str]) -> str:
    """Every table's label book in one, keyed column|edition|code (no key is in two books), with the labels an edition
    lacks borrowed: when an edition has no label at all for a column that at least two other editions label, and those
    editions agree on the label of every code of that column (FKP05_NEW, FKP16_NEW in the covid edition: the
    38-province coding). A column whose codes mean different things per edition (FKP14: each edition numbers its own
    diagnoses) never lends. Returns the union of the raw books (the dimensions read it too)."""
    lab_all = g.union("u_label", "label_semua", books, "dimensi", "Union: semua buku label (arti tiap kode per kolom per edisi), lima tabel.")
    seragam = g.transform("t_label_seragam", "label_kolom_seragam", lab_all, [
        aggregate(["tabel", "kolom", "kode"], [agg("Count distinct", "n_label", "label"), agg("Count distinct", "n_edisi", "edisi"), agg("Min", "label", "label")]),
        window("Max", "n_label_kolom", ["tabel", "kolom"], column="n_label", frame="Whole partition"),
        window("Max", "n_edisi_kolom", ["tabel", "kolom"], column="n_edisi", frame="Whole partition"),
        keep(all_(c("n_label_kolom", "is equal to", val(1, "Long")), c("n_edisi_kolom", "is greater than or equal to", val(2, "Long")))),
        select(["tabel", "kolom", "kode", "label"]),
    ], "dimensi", "Kolom yang artinya sama di semua edisi: setiap kodenya berlabel sama di ≥ 2 edisi.")
    edisi = g.transform("t_label_edisi", "label_edisi_tabel", lab_all, [aggregate(["tabel", "edisi"], [agg("Count", "n")]), select(["tabel", "edisi"])],
                        "dimensi", "Edisi tiap tabel yang punya buku label.")
    kandidat = g.join("j_label_kandidat", "label_kandidat", seragam, edisi, ["tabel"], "dimensi", ["edisi"], how="inner",
                      description="Inner join: tiap label kolom seragam untuk setiap edisi tabelnya.")
    pinjam = g.join("j_label_pinjam", "label_pinjaman", kandidat, lab_all, ["tabel", "kolom", "edisi"], "dimensi", [], how="left anti",
                    description="Left anti join: hanya edisi yang sama sekali tidak punya label untuk kolom itu.")
    lengkap = g.union("u_label_lengkap", "label_lengkap", [lab_all, pinjam], "dimensi", "Union: buku label asli + label pinjaman.")
    _label_book(g, "lab_siap", LABEL_BOOK, lengkap)
    return lab_all


def silver(g: Graph, src: dict[str, str], cols: dict[str, set[str]]) -> dict[str, str]:
    """The Data Bersih nodes; the node id of each silver dataset."""
    out = {}
    # the label book; the facts read it by name (their Mapping join steps), not as an input
    lab_all = _label_books(g, [src[k] for k in ("label_nilai_kepesertaan", "label_nilai_fktpkapitasi", "label_nilai_fkrtl_bagian_1",
                                                "label_nilai_fkrtl_bagian_2", "label_nilai_nonkapitasi")])

    def fact(nid, name, tabel, inp, have, label_node, group, extra, description):
        steps = _clean_steps(tabel, have, label_node) + extra + [select(_silver_columns(tabel) + [s for s in EXTRA_COLS.get(name, [])])]
        return g.transform(nid, name, inp, steps, group, description, checkpoint=True)

    out["peserta"] = fact("t_peserta", "peserta", "kepesertaan", src["kepesertaan"], cols["kepesertaan"], LABEL_BOOK, "peserta", [
        constant("akhir_2024", "Date", "2024-12-31"), date_diff("usia_akhir_2024", "akhir_2024", "tgl_lahir", "Years"),
        # a birth date after the end of 2024 (one in the source: 2033) has no age at the end of 2024
        case("usia_akhir_2024", [(all_(c("tgl_lahir", "is greater than", val("2024-12-31", "Date"))), NULL)], col("usia_akhir_2024"), "Auto"),
        case("flag_tgl_lahir_pengganti", [(all_(c("tgl_lahir", "is null")), NULL), (all_(c("tgl_lahir", "is less than", val("1901-01-01", "Date"))), TRUE)], FALSE, "Boolean"),
    ], "Peserta bersih: nama kolom jelas, kode → label (Mapping join ke buku label), usia akhir 2024, flag tanggal lahir pengganti (< 1901).")
    out["kunjungan_fktp"] = fact("t_fktp", "kunjungan_fktp", "fktpkapitasi", src["fktpkapitasi"], cols["fktpkapitasi"], LABEL_BOOK, "fktp",
                                 [date_trunc("bulan", "tgl_datang", "Month")],
                                 "Kunjungan FKTP bersih: satu baris per kunjungan per edisi, kode → label, bulan kunjungan.")
    out["diagnosis_sekunder"] = fact("t_dx", "diagnosis_sekunder", "diagnosissekunder", src["diagnosissekunder"], cols["diagnosissekunder"], None, "klaim", [],
                                     "Diagnosis sekunder bersih: satu baris per kode diagnosis per kunjungan FKRTL.")
    out["tindakan_nonkapitasi"] = fact("t_nonkap", "tindakan_nonkapitasi", "nonkapitasi", src["nonkapitasi"], cols["nonkapitasi"], LABEL_BOOK, "fktp", [
        window("Row number", "tindakan_ke", ["edisi", "kunjungan_id"], [("tgl_tindakan", "asc"), ("tindakan", "asc")]),
    ], "Tindakan nonkapitasi bersih: satu baris per tindakan, urutan tindakan_ke per kunjungan.")

    # FKRTL: two bronze parts → Union by name → the clean-up → LOS, selisih, bulan → dx count and p99 joins → flags
    fk_u = g.union("fkrtl_u", "fkrtl_gabung", [src["fkrtl_bagian_1"], src["fkrtl_bagian_2"]], "klaim",
                   "Union by name: klaim FKRTL bagian 1 dan 2; kolom yang tidak ada di satu bagian menjadi kosong.")
    fk_have = cols["fkrtl_bagian_1"] | cols["fkrtl_bagian_2"]
    fk_clean = g.transform("t_fkrtl_bersih", "kunjungan_fkrtl_bersih", fk_u, _clean_steps("fkrtl", fk_have, LABEL_BOOK) + [
        date_diff("los_hari", "tgl_pulang", "tgl_datang", "Days"),
        formula("selisih_rp", "biaya_tagih_rp - biaya_verifikasi_rp"), cast("selisih_rp", "Long"),
        date_trunc("bulan", "tgl_pulang", "Month"),
        select(_silver_columns("fkrtl") + ["los_hari", "selisih_rp", "bulan"]),
    ], "klaim", "Klaim FKRTL bersih: nama kolom, tipe, kode → label (21 kolom), nama diagnosis dipulihkan, LOS, selisih tagih−verifikasi, bulan pulang.",
        checkpoint=True)
    dx_n = g.transform("t_dx_n", "dx_per_kunjungan", out["diagnosis_sekunder"], [
        aggregate(["edisi", "kunjungan_fkrtl_id"], [agg("Count", "jumlah_dx_sekunder")])], "klaim", "Jumlah diagnosis sekunder per kunjungan FKRTL.")
    p99 = g.transform("t_p99", "los_p99_inacbg", fk_clean, [
        aggregate(["inacbg_kode"], [agg("Percentile", "los_p99", "los_hari", arg=99)])], "klaim", "Persentil 99 LOS per INA-CBG (batas LOS ekstrem).")
    fk_j1 = g.join("j_fkrtl_dx", "fkrtl_dx", fk_clean, dx_n, ["edisi", "kunjungan_fkrtl_id"], "klaim", ["jumlah_dx_sekunder"],
                   description="Left join: jumlah diagnosis sekunder tiap klaim.")
    fk_j2 = g.join("j_fkrtl_p99", "fkrtl_p99", fk_j1, p99, ["inacbg_kode"], "klaim", ["los_p99"], description="Left join: p99 LOS INA-CBG tiap klaim.")
    out["kunjungan_fkrtl"] = g.transform("t_fkrtl", "kunjungan_fkrtl", fk_j2, [
        fill("jumlah_dx_sekunder", "0"),
        window("Count", "kembar", ["edisi", "peserta_id", "tgl_datang", "tgl_pulang", "inacbg_kode", "biaya_tagih_rp"], frame="Whole partition"),
        case("flag_calon_klaim_ganda", [(all_(c("kembar", "is greater than", val(1, "Long"))), TRUE)], FALSE, "Boolean"),
        case("flag_selisih_verifikasi", [(all_(c("selisih_rp", "is null")), NULL), (all_(c("selisih_rp", "is not equal to (not null safe)", val(0, "Long"))), TRUE)], FALSE, "Boolean"),
        case("flag_los_ekstrem", [(all_(c("los_hari", "is less than or equal to", val(3, "Long"))), FALSE),
                                  (all_(c("los_hari", "is less than or equal to", col("los_p99"))), FALSE),
                                  (all_(c("los_hari", "is greater than", col("los_p99")), c("los_hari", "is greater than", val(3, "Long"))), TRUE)], NULL, "Boolean"),
        select(_silver_columns("fkrtl") + EXTRA_COLS["kunjungan_fkrtl"]),
    ], "klaim", "Klaim FKRTL siap: flag calon klaim ganda (peserta, tanggal, INA-CBG, biaya sama), selisih verifikasi, LOS ekstrem (> p99 INA-CBG dan > 3 hari).",
        checkpoint=True)

    # rujukan: FKRTL visits that carry their FKTP visit, joined to it
    rj_f = g.transform("t_rj_fkrtl", "fkrtl_dengan_rujukan", out["kunjungan_fkrtl"], [keep(all_(c("rujukan_fktp_id", "is not null")))], "rujukan",
                       "Klaim FKRTL yang membawa nomor kunjungan FKTP asalnya.")
    rj_j = g.join("j_rujukan", "rujukan_fktp", rj_f, out["kunjungan_fktp"], [("edisi", "edisi"), ("rujukan_fktp_id", "kunjungan_fktp_id")], "rujukan",
                  ["kunjungan_fktp_id", "tgl_datang", "kabkota_fktp_kode", "kabkota_fktp", "jenis_fktp", "dx_icd3"], prefix="fktp_",
                  description="Left join: kunjungan FKTP asal tiap rujukan.")
    out["rujukan"] = g.transform("t_rujukan", "rujukan", rj_j, [
        date_diff("hari_ke_fkrtl", "tgl_datang", "fktp_tgl_datang", "Days"),
        case("dx_sama", [(any_(c("fktp_dx_icd3", "is null"), c("dx_primer_icd3", "is null")), NULL),
                         (all_(c("fktp_dx_icd3", "is equal to", col("dx_primer_icd3"))), TRUE)], FALSE, "Boolean"),
        case("flag_rujukan_tanpa_fktp", [(all_(c("fktp_kunjungan_fktp_id", "is null")), TRUE)], FALSE, "Boolean"),
        rename("rujukan_fktp_id", "kunjungan_fktp_id"), rename("fktp_tgl_datang", "tgl_fktp"), rename("tgl_datang", "tgl_fkrtl"),
        rename("fktp_kabkota_fktp_kode", "kabkota_asal_kode"), rename("fktp_kabkota_fktp", "kabkota_asal"), rename("fktp_jenis_fktp", "jenis_faskes_asal"),
        rename("kabkota_fkrtl_kode", "kabkota_tujuan_kode"), rename("kabkota_fkrtl", "kabkota_tujuan"), rename("tipe_fkrtl", "tipe_faskes_tujuan"),
        rename("fktp_dx_icd3", "dx_fktp_icd3"), rename("dx_primer_icd3", "dx_fkrtl_icd3"),
        select(["edisi", "kunjungan_fkrtl_id", "kunjungan_fktp_id", "peserta_id", "tgl_fktp", "tgl_fkrtl", "hari_ke_fkrtl", "kabkota_asal_kode", "kabkota_asal",
                "jenis_faskes_asal", "kabkota_tujuan_kode", "kabkota_tujuan", "tipe_faskes_tujuan", "dx_fktp_icd3", "dx_fkrtl_icd3", "dx_sama", "flag_rujukan_tanpa_fktp"]),
    ], "rujukan", "Rujukan FKTP → FKRTL: jarak hari, asal dan tujuan, diagnosis sama atau tidak.", checkpoint=True)

    # dimensions
    out["dim_icd10"] = g.transform("t_dim_icd10", "dim_icd10_ref", src["dim_icd10"], [select(["icd3", "nama", "bab"])], "dimensi",
                                   "Referensi ICD-10 3 digit: kode, nama, bab.")
    rinci = [g.transform(f"t_icd_{i}", f"icd10_dari_{n}", node, [select([k, i3, nm]), rename(k, "kode"), rename(i3, "icd3"), rename(nm, "nama")], "dimensi")
             for i, (n, node, k, i3, nm) in enumerate([("dx_masuk", fk_clean, "dx_masuk_kode", "dx_masuk_icd3", "dx_masuk_nama"),
                                                         ("dx_primer", fk_clean, "dx_primer_kode", "dx_primer_icd3", "dx_primer_nama"),
                                                         ("nonkapitasi", out["tindakan_nonkapitasi"], "dx_kode", "dx_icd3", "dx_nama")])]
    rinci_u = g.union("u_icd_rinci", "icd10_rinci_gabung", rinci, "dimensi", "Union: kode ICD-10 rinci dari diagnosis masuk, primer dan nonkapitasi.")
    out["dim_icd10_rinci"] = g.transform("t_dim_icd10_rinci", "dim_icd10_rinci", rinci_u, [
        keep(all_(c("kode", "is not null"), c("nama", "is not null"))),
        aggregate(["kode", "icd3", "nama"], [agg("Count", "n")]),
        # the most used ICD-10 and name of each code; a tie goes to the first alphabetically (every build the same)
        window("First value", "icd3_utama", ["kode"], [("n", "desc"), ("icd3", "asc")], column="icd3", frame="Whole partition"),
        window("First value", "nama_utama", ["kode"], [("n", "desc"), ("nama", "asc")], column="nama", frame="Whole partition"),
        window("Sum", "dipakai", ["kode"], column="n", frame="Whole partition"),
        _s("dedupe", columns=["kode"]),
        select(["kode", "icd3_utama", "nama_utama", "dipakai"]), rename("icd3_utama", "icd3"), rename("nama_utama", "nama"),
    ], "dimensi", "ICD-10 rinci dari data: tiap kode dengan ICD-10 3 digit dan nama yang paling sering dipakai.")
    out["dim_inacbg"] = g.transform("t_dim_inacbg", "dim_inacbg", out["kunjungan_fkrtl"], [
        keep(all_(c("inacbg_kode", "is not null"))),
        aggregate(["inacbg_kode"], [agg("Mode", "deskripsi", "inacbg_deskripsi"), agg("Mode", "cmg", "inacbg_cmg"), agg("Mode", "tipe_kasus", "inacbg_tipe_kasus"),
                                    agg("Mode", "spesifikasi", "inacbg_spesifikasi"), agg("Mode", "keparahan", "inacbg_keparahan"), agg("Count", "dipakai")]),
    ], "dimensi", "INA-CBG: deskripsi, CMG, tipe kasus, keparahan yang paling sering tercatat.", checkpoint=True)
    prov = g.transform("t_label_prov", "label_provinsi_34", lab_all, [
        keep(all_(c("kolom", "is in", val(PROVINSI_COLS)))), cast("kode", "Integer"),
        aggregate(["kode"], [agg("Mode", "provinsi", "label")]), rename("kode", "provinsi_kode")], "dimensi", "Nama provinsi (34) per kode, dari buku label.")
    kab = g.transform("t_label_kab", "label_kabkota", lab_all, [
        keep(all_(c("kolom", "is in", val(KABKOTA_COLS)))), cast("kode", "Integer"),
        aggregate(["kode"], [agg("Mode", "kabkota", "label")]), rename("kode", "kabkota_kode"),
        formula("provinsi_kode", "floor(kabkota_kode / 100)"), cast("provinsi_kode", "Integer")], "dimensi", "Nama kab/kota per kode, provinsinya dari 2 digit pertama.")
    wil = g.join("j_dim_wilayah", "kabkota_provinsi", kab, prov, ["provinsi_kode"], "dimensi", ["provinsi"], description="Left join: nama provinsi tiap kab/kota.")
    out["dim_wilayah"] = g.transform("t_dim_wilayah", "dim_wilayah", wil, [select(["kabkota_kode", "kabkota", "provinsi_kode", "provinsi"])], "dimensi",
                                     "Wilayah sumber: kab/kota → provinsi (kode BPS 34 provinsi).", checkpoint=True)
    pf = [g.transform(f"t_pf_{t.lower()}", f"faskes_{t.lower()}", node, [
        select([k, kp, j, tp]), rename(k, "kabkota_kode"), rename(kp, "kepemilikan"), rename(j, "jenis"), rename(tp, "tipe"), constant("tingkat", "String", t)], "dimensi")
          for t, node, k, kp, j, tp in [("FKTP", out["kunjungan_fktp"], "kabkota_fktp_kode", "kepemilikan_fktp", "jenis_fktp", "tipe_fktp"),
                                        ("FKRTL", out["kunjungan_fkrtl"], "kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl"),
                                        ("NONKAPITASI", out["tindakan_nonkapitasi"], "kabkota_faskes_kode", "kepemilikan_faskes", "jenis_faskes", "tipe_faskes")]]
    pf_u = g.union("u_faskes", "faskes_gabung", pf, "dimensi", "Union: kunjungan FKTP, klaim FKRTL dan tindakan nonkapitasi dengan ciri faskesnya.")
    out["dim_profil_faskes"] = g.transform("t_dim_faskes", "dim_profil_faskes", pf_u, [
        aggregate(["tingkat", "kabkota_kode", "kepemilikan", "jenis", "tipe"], [agg("Count", "kunjungan")]),
        concat("profil", ["tingkat", "kabkota_kode", "kepemilikan", "jenis", "tipe"], "|"), md5("faskes_profil_id", "profil"),
        select(["faskes_profil_id", "tingkat", "kabkota_kode", "kepemilikan", "jenis", "tipe", "kunjungan"]),
    ], "dimensi", "Profil faskes (pengganti ID faskes yang tidak ada di sumber): tingkat × kab/kota × kepemilikan × jenis × tipe.", checkpoint=True)
    return out


EXTRA_COLS = {
    "peserta": ["usia_akhir_2024", "flag_tgl_lahir_pengganti"],
    "kunjungan_fktp": ["bulan"],
    "tindakan_nonkapitasi": ["tindakan_ke"],
    "kunjungan_fkrtl": ["los_hari", "selisih_rp", "bulan", "jumlah_dx_sekunder", "flag_calon_klaim_ganda", "flag_selisih_verifikasi", "flag_los_ekstrem"],
}


# ------------------------------------------------------------------------------------------------ 3 · Siap Analisis


def _pct(output, part, whole, digits=2):
    return formula(output, f"round(100 * {part} / {whole}, {digits})")


def gold(g: Graph, s: dict[str, str], ibukota: str) -> dict[str, str]:
    """The Siap Analisis nodes (gold_pipeline.SQL as visual nodes); the node id of each gold dataset."""
    out = {}
    # wilayah: kab/kota → its province in the data's 38-province coding (gold_pipeline.SQL["wilayah"])
    w = [g.transform(f"t_w_{n}", f"kode_wilayah_{n}", s[node], [select([k, k38, n38]), rename(k, "kode"), rename(k38, "kode_38"), rename(n38, "nama_38")], "dimensi")
         for n, node, k, k38, n38 in [("fktp", "kunjungan_fktp", "kabkota_fktp_kode", "provinsi_fktp_38_kode", "provinsi_fktp_38"),
                                      ("peserta", "peserta", "kabkota_tinggal_kode", "provinsi_tinggal_38_kode", "provinsi_tinggal_38"),
                                      ("fkrtl", "kunjungan_fkrtl", "kabkota_fkrtl_kode", "provinsi_fkrtl_38_kode", "provinsi_fkrtl_38")]]
    wu = g.union("u_wilayah_38", "kode_wilayah_38", w, "dimensi", "Union: kab/kota dan provinsi 38 yang tercatat di kunjungan FKTP, peserta dan klaim FKRTL.")
    pindah = g.transform("t_pindah", "kabkota_pindah_provinsi", wu, [
        formula("kode_34", "floor(kode / 100)"), keep(all_(c("kode_38", "is not equal to (not null safe)", col("kode_34")))),
        aggregate(["kode"], [agg("Mode", "kode_38_baru", "kode_38")])], "dimensi",
        "Kab/kota yang tercatat di provinsi lain dari kode BPS-nya (pemekaran Papua 2022): provinsi barunya.")
    nama38 = g.transform("t_nama38", "nama_provinsi_38", wu, [
        keep(all_(c("nama_38", "is not null"))), aggregate(["kode_38"], [agg("Mode", "nama_38", "nama_38")])], "dimensi", "Nama tiap kode provinsi 38.")
    wj1 = g.join("j_w1", "wilayah_pindah", s["dim_wilayah"], pindah, [("kabkota_kode", "kode")], "dimensi", ["kode_38_baru"])
    wt = g.transform("t_w_kode", "wilayah_kode_38", wj1, [coalesce("provinsi_kode_38", ["kode_38_baru", "provinsi_kode"])], "dimensi")
    wj2 = g.join("j_w2", "wilayah_nama_38", wt, nama38, [("provinsi_kode_38", "kode_38")], "dimensi", ["nama_38"])
    out["wilayah"] = g.transform("t_wilayah", "wilayah", wj2, [
        coalesce("provinsi_nama", ["nama_38", "provinsi"]),
        rename("provinsi_kode", "provinsi_34_kode"), rename("provinsi", "provinsi_34_nama"), rename("provinsi_kode_38", "provinsi_kode"), rename("kabkota", "kabkota_nama"),
        select(["kabkota_kode", "kabkota_nama", "provinsi_kode", "provinsi_nama", "provinsi_34_kode", "provinsi_34_nama"]),
    ], "dimensi", "Dimensi wilayah: kab/kota → 38 provinsi (kolom *_38 data); kode 34 provinsi disimpan.", checkpoint=True)
    W = out["wilayah"]

    # klaim: FKRTL claims with province, inpatient flag, facility profile and 30-day readmission
    kj = g.join("j_klaim_w", "klaim_wilayah", s["kunjungan_fkrtl"], W, [("kabkota_fkrtl_kode", "kabkota_kode")], "klaim", ["provinsi_kode"])
    klaim = g.transform("t_klaim", "klaim", kj, [
        case("rawat_inap", [(all_(c("inacbg_keparahan", "is not null"), c("inacbg_keparahan", "is not equal to", val("Rawat Jalan"))), TRUE)], FALSE, "Boolean"),
        concat("profil", [lit("FKRTL"), "kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl"], "|"), md5("faskes_profil_id", "profil"),
        fill("tipe_fkrtl", "tidak tercatat"), fill("regional_tarif", "tidak tercatat"),
        window("Lead", "inap_berikut", ["edisi", "peserta_id", "rawat_inap"], [("tgl_datang", "asc"), ("kunjungan_fkrtl_id", "asc")], column="tgl_datang"),
        date_diff("hari_ke_inap_berikut", "inap_berikut", "tgl_pulang", "Days"),
        case("readmisi_30", [(all_(is_true("rawat_inap"), c("hari_ke_inap_berikut", "is between", val(0, "Long"), val(30, "Long"))), TRUE)], FALSE, "Boolean"),
        # what the grouper prices: the INA-CBG package plus the special CMG top-ups (an empty top-up is 0), and what was
        # billed beyond both. Within one code, RS type and region the package still differs by ownership, care class and
        # tariff year: the peer of a bill is its tariff table (peer_tarif_id)
        *[fill(t, "0") for t in ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")],
        rename("sa_tarif_rp", "topup_subakut_rp"),
        formula("topup_khusus_rp", "sp_tarif_rp + rr_tarif_rp + si_tarif_rp + sd_tarif_rp"), cast("topup_khusus_rp", "Long"),
        formula("sisa_di_luar_tarif_rp", "biaya_tagih_rp - tarif_inacbg_rp - topup_subakut_rp - topup_khusus_rp"), cast("sisa_di_luar_tarif_rp", "Long"),
        date_part("tahun_tarif", "tgl_pulang", "Year"),
        coalesce("kelas_rawat_peer", ["kelas_rawat", lit("tidak tercatat")]),
        concat("peer_tarif_id", ["edisi", "inacbg_kode", "tipe_fkrtl", "regional_tarif", "kepemilikan_fkrtl", "kelas_rawat_peer", "tahun_tarif"], "|", null_if_any=True),
        select(["edisi", "kunjungan_fkrtl_id", "peserta_id", "tgl_datang", "tgl_pulang", "bulan", "kabkota_fkrtl_kode", "provinsi_kode", "tipe_fkrtl", "inacbg_kode",
                "inacbg_cmg", "inacbg_keparahan", "regional_tarif", "los_hari", "biaya_tagih_rp", "biaya_verifikasi_rp", "dx_primer_icd3", "flag_calon_klaim_ganda",
                "flag_selisih_verifikasi", "flag_los_ekstrem", "faskes_profil_id", "kelas_rawat", "poli", "dx_primer_nama", "tarif_inacbg_rp", "selisih_rp",
                "rawat_inap", "readmisi_30", "kepemilikan_fkrtl", "tahun_tarif", "topup_subakut_rp", "topup_khusus_rp", "sisa_di_luar_tarif_rp", "peer_tarif_id",
                "bobot"]),
    ], "klaim", "Klaim FKRTL + provinsi (38), rawat inap, profil faskes, readmisi 30 hari (rawat inap berikutnya ≤ 30 hari setelah pulang), "
                "top-up special CMG, tagihan di luar tarif, kunci peer setarif.", checkpoint=True)

    # provinsi (map points)
    p1 = g.transform("t_prov_w", "provinsi_wilayah", W, [
        keep(all_(c("provinsi_nama", "is not null"))), aggregate(["provinsi_kode", "provinsi_nama"], [agg("Count", "kabkota")]), rename("provinsi_nama", "provinsi")], "dimensi")
    p2 = g.join("j_prov_ibukota", "provinsi_ibukota", p1, ibukota, ["provinsi_kode"], "dimensi", ["ibukota", "lokasi"], description="Left join: ibu kota dan titik peta.")
    pk = g.transform("t_prov_klaim", "klaim_per_provinsi", klaim, _measure_steps(["provinsi_kode"], berisiko=True), "klaim")
    p3 = g.join("j_prov_klaim", "provinsi_klaim", p2, pk, ["provinsi_kode"], "dimensi",
                ["klaim", "peserta", "biaya_tagih_rp", "biaya_verifikasi_rp", "readmisi_30", "klaim_inap", "klaim_berisiko"])
    out["provinsi"] = g.transform("t_provinsi", "provinsi", p3, [
        fill("klaim", "0"), rename("klaim", "klaim_fkrtl"), rename("peserta", "peserta_fkrtl"), _pct("pct_readmisi_30", "readmisi_30", "klaim_inap"),
        fill("klaim_berisiko", "0"),
        select(["provinsi_kode", "provinsi", "kabkota", "ibukota", "lokasi", "klaim_fkrtl", "peserta_fkrtl", "biaya_tagih_rp", "biaya_verifikasi_rp", "pct_readmisi_30",
                "klaim_berisiko"]),
    ], "dimensi", "Provinsi: ibu kota dan titik peta, ringkasan klaim FKRTL dan klaim berisiko.", checkpoint=True)
    P = out["provinsi"]

    def rata(steps_out):
        return [formula("rata_biaya_tagih_rp", "round(biaya_tagih_rp / klaim, 0)"), formula("rata_los_inap_hari", "round(los_hari_inap / klaim_inap, 2)"), *steps_out]

    # klaim_kabkota
    a = g.transform("t_kk_agg", "klaim_per_kabkota", klaim, _measure_steps(["edisi", "kabkota_fkrtl_kode", "tipe_fkrtl"]) + [rename("kabkota_fkrtl_kode", "kabkota_kode")], "klaim")
    j = g.join("j_kk_w", "klaim_kabkota_wilayah", a, W, ["kabkota_kode"], "klaim", ["kabkota_nama", "provinsi_kode", "provinsi_nama"])
    out["klaim_kabkota"] = g.transform("t_klaim_kabkota", "klaim_kabkota", j, rata([
        _pct("pct_readmisi_30", "readmisi_30", "klaim_inap"), _pct("pct_calon_klaim_ganda", "calon_klaim_ganda", "klaim", 3),
        concat("klaim_kabkota_id", ["edisi", "kabkota_kode", "tipe_fkrtl"], ":"), rename("kabkota_nama", "kabkota"), rename("provinsi_nama", "provinsi"),
        select(["klaim_kabkota_id", "edisi", "kabkota_kode", "kabkota", "provinsi_kode", "provinsi", "tipe_fkrtl", "klaim", "klaim_inap", "peserta", "biaya_tagih_rp",
                "biaya_verifikasi_rp", "rata_biaya_tagih_rp", "rata_los_inap_hari", "readmisi_30", "pct_readmisi_30", "calon_klaim_ganda", "pct_calon_klaim_ganda",
                "selisih_verifikasi", "los_ekstrem"])]), "klaim", "Klaim per kab/kota × tipe RS × edisi: biaya, rata-rata, readmisi, calon klaim ganda.")

    # klaim_bulanan
    a = g.transform("t_kb_agg", "klaim_per_bulan_cmg", klaim, [month_text("bulan")] + _measure_steps(["edisi", "bulan", "provinsi_kode", "inacbg_cmg", "inacbg_keparahan"]), "klaim")
    j = g.join("j_kb_p", "klaim_bulanan_provinsi_nama", a, P, ["provinsi_kode"], "klaim", ["provinsi"])
    out["klaim_bulanan"] = g.transform("t_klaim_bulanan", "klaim_bulanan", j, rata([
        coalesce("cmg_id", ["inacbg_cmg", lit("-")]), coalesce("keparahan_id", ["inacbg_keparahan", lit("-")]),
        concat("klaim_bulanan_id", ["edisi", "bulan", "provinsi_kode", "cmg_id", "keparahan_id"], ":"),
        select(["klaim_bulanan_id", "edisi", "bulan", "provinsi_kode", "provinsi", "inacbg_cmg", "inacbg_keparahan", "klaim", "klaim_inap", "peserta", "biaya_tagih_rp",
                "biaya_verifikasi_rp", "rata_biaya_tagih_rp", "rata_los_inap_hari", "readmisi_30", "calon_klaim_ganda", "los_ekstrem"])]), "klaim",
        "Klaim per bulan × provinsi × CMG × keparahan.")

    # indikator_inacbg (and the peer statistics of klaim_berisiko)
    inacbg_agg = g.transform("t_ia_agg", "statistik_inacbg", klaim, [
        keep(all_(c("inacbg_kode", "is not null"))),
        aggregate(["edisi", "inacbg_kode", "tipe_fkrtl", "regional_tarif"], measures() + [
            agg("Percentile", "los_inap_p50", "los_hari", all_(is_true("rawat_inap")), 50), agg("Percentile", "los_inap_p90", "los_hari", all_(is_true("rawat_inap")), 90),
            agg("Percentile", "biaya_tagih_p50_rp", "biaya_tagih_rp", arg=50)]),
        *[dict(x, id=_uid()) for x in SUMS],
    ], "klaim", "Statistik per INA-CBG × tipe RS × regional tarif × edisi: median biaya, median dan p90 LOS rawat inap.", checkpoint=True)
    j = g.join("j_ia_d", "statistik_inacbg_deskripsi", inacbg_agg, s["dim_inacbg"], ["inacbg_kode"], "klaim", ["deskripsi", "cmg", "tipe_kasus", "keparahan"])
    out["indikator_inacbg"] = g.transform("t_indikator_inacbg", "indikator_inacbg", j, [
        concat("indikator_id", ["edisi", "inacbg_kode", "tipe_fkrtl", "regional_tarif"], "|"), rename("deskripsi", "inacbg_deskripsi"),
        formula("rata_biaya_tagih_rp", "round(biaya_tagih_rp / klaim, 0)"), _pct("pct_readmisi_30", "readmisi_30", "klaim_inap"),
        _pct("pct_calon_klaim_ganda", "calon_klaim_ganda", "klaim", 3), _pct("pct_los_ekstrem", "los_ekstrem", "klaim", 3), _pct("pct_selisih_verifikasi", "selisih_verifikasi", "klaim", 3),
        select(["indikator_id", "edisi", "inacbg_kode", "inacbg_deskripsi", "cmg", "tipe_kasus", "keparahan", "tipe_fkrtl", "regional_tarif", "klaim", "klaim_inap",
                "biaya_tagih_rp", "biaya_verifikasi_rp", "rata_biaya_tagih_rp", "biaya_tagih_p50_rp", "los_inap_p50", "los_inap_p90", "pct_readmisi_30",
                "pct_calon_klaim_ganda", "pct_los_ekstrem", "pct_selisih_verifikasi"]),
    ], "klaim", "Indikator INA-CBG: biaya, median, LOS, persentase readmisi, calon klaim ganda, LOS ekstrem, selisih verifikasi.", checkpoint=True)

    # FKTP visits with province (bulanan, provinsi, penyakit)
    fj = g.join("j_fktp_w", "fktp_wilayah", s["kunjungan_fktp"], W, [("kabkota_fktp_kode", "kabkota_kode")], "fktp", ["provinsi_kode"])
    fktp_aggs = [agg("Count", "kunjungan"), agg("Count distinct", "peserta", "peserta_id"),
                 agg("Count", "kunjungan_sakit", where=all_(c("jenis_kunjungan", "is equal to", val("KUNJUNGAN SAKIT")))),
                 agg("Count", "rujuk_lanjut", where=all_(c("status_pulang", "is equal to", val("RUJUK LANJUT"))))]
    for name, by, idcols, nid in (("kunjungan_fktp_bulanan", ["edisi", "bulan", "provinsi_kode", "jenis_fktp", "poli"], "kunjungan_fktp_bulanan_id", "t_fb"),
                                  ("kunjungan_fktp_provinsi", ["edisi", "bulan", "provinsi_kode", "jenis_fktp"], "kunjungan_fktp_bulanan_id", "t_fp")):
        fills = [fill("poli", "tidak tercatat")] if "poli" in by else [fill("jenis_fktp", "tidak tercatat")]
        a = g.transform(f"{nid}_agg", f"{name}_agg", fj, [month_text("bulan"), *fills, aggregate(by, fktp_aggs)], "fktp")
        j = g.join(f"j_{nid}_p", f"{name}_provinsi", a, P, ["provinsi_kode"], "fktp", ["provinsi"])
        out[name] = g.transform(nid, name, j, [
            concat(idcols, by, ":"), _pct("pct_rujuk_lanjut", "rujuk_lanjut", "kunjungan"),
            select([idcols, "edisi", "bulan", "provinsi_kode", "provinsi", *by[3:], "kunjungan", "peserta", "kunjungan_sakit", "rujuk_lanjut", "pct_rujuk_lanjut"]),
        ], "fktp", "Kunjungan FKTP per bulan × provinsi × jenis FKTP" + (" × poli" if "poli" in by else "") + ": kunjungan sakit, rujuk lanjut.")

    # penyakit_teratas: the 20 most frequent ICD-10 per edition × province × level, FKTP and FKRTL unioned
    d1 = g.transform("t_py_fktp", "penyakit_fktp", fj, [
        keep(all_(c("dx_icd3", "is not null"))), constant("tingkat", "String", "FKTP"), rename("dx_icd3", "icd3"),
        aggregate(["edisi", "provinsi_kode", "tingkat", "icd3"], [agg("Count", "kunjungan"), agg("Count distinct", "peserta", "peserta_id")]),
        constant("biaya_tagih_rp", "Double", "0")], "penyakit")
    d2 = g.transform("t_py_fkrtl", "penyakit_fkrtl", klaim, [
        keep(all_(c("dx_primer_icd3", "is not null"))), constant("tingkat", "String", "FKRTL"), rename("dx_primer_icd3", "icd3"),
        aggregate(["edisi", "provinsi_kode", "tingkat", "icd3"], [agg("Count", "kunjungan"), agg("Count distinct", "peserta", "peserta_id"), agg("Sum", "biaya_tagih_rp", "biaya_tagih_rp")]),
        cast("biaya_tagih_rp", "Double")], "penyakit")
    du = g.union("u_penyakit", "penyakit_gabung", [d1, d2], "penyakit", "Union: diagnosis FKTP dan diagnosis primer FKRTL.")
    dj1 = g.join("j_py_icd", "penyakit_icd10", du, s["dim_icd10"], ["icd3"], "penyakit", ["nama", "bab"])
    dj2 = g.join("j_py_p", "penyakit_provinsi", dj1, P, ["provinsi_kode"], "penyakit", ["provinsi"])
    out["penyakit_teratas"] = g.transform("t_penyakit_teratas", "penyakit_teratas", dj2, [
        rename("nama", "diagnosis"), window("Row number", "peringkat", ["edisi", "provinsi_kode", "tingkat"], [("kunjungan", "desc"), ("icd3", "asc")]),
        keep(all_(c("peringkat", "is less than or equal to", val(20, "Long")))), concat("penyakit_teratas_id", ["edisi", "provinsi_kode", "tingkat", "peringkat"], ":"),
        select(["penyakit_teratas_id", "edisi", "provinsi_kode", "provinsi", "tingkat", "icd3", "diagnosis", "bab", "kunjungan", "peserta", "biaya_tagih_rp", "peringkat"]),
    ], "penyakit", "20 penyakit teratas per edisi × provinsi × tingkat layanan (Window: row number).")

    # alur_rujukan
    a = g.transform("t_ar_agg", "rujukan_per_alur", s["rujukan"], [
        fill("tipe_faskes_tujuan", "tidak tercatat"),
        aggregate(["edisi", "kabkota_asal_kode", "kabkota_tujuan_kode", "tipe_faskes_tujuan"],
                  [agg("Count", "rujukan"), agg("Median", "median_hari_ke_fkrtl", "hari_ke_fkrtl"), agg("Count", "dx_sama", where=all_(is_true("dx_sama")))])], "rujukan")
    j1 = g.join("j_ar_asal", "alur_asal", a, W, [("kabkota_asal_kode", "kabkota_kode")], "rujukan", ["kabkota_nama", "provinsi_nama", "provinsi_kode"], prefix="asal_")
    j2 = g.join("j_ar_tujuan", "alur_tujuan", j1, W, [("kabkota_tujuan_kode", "kabkota_kode")], "rujukan", ["kabkota_nama", "provinsi_nama", "provinsi_kode"], prefix="tujuan_")
    out["alur_rujukan"] = g.transform("t_alur_rujukan", "alur_rujukan", j2, [
        concat("alur_rujukan_id", ["edisi", "kabkota_asal_kode", "kabkota_tujuan_kode", "tipe_faskes_tujuan"], ":"),
        _pct("pct_dx_sama", "dx_sama", "rujukan"),
        case("lintas_kabkota", [(all_(c("kabkota_asal_kode", "is equal to (not null safe)", col("kabkota_tujuan_kode"))), val(0, "Integer"))], val(1, "Integer"), "Integer"),
        case("lintas_provinsi", [(all_(c("asal_provinsi_kode", "is equal to (not null safe)", col("tujuan_provinsi_kode"))), val(0, "Integer"))], val(1, "Integer"), "Integer"),
        rename("asal_kabkota_nama", "kabkota_asal"), rename("asal_provinsi_nama", "provinsi_asal"),
        rename("tujuan_kabkota_nama", "kabkota_tujuan"), rename("tujuan_provinsi_nama", "provinsi_tujuan"),
        select(["alur_rujukan_id", "edisi", "kabkota_asal_kode", "kabkota_asal", "provinsi_asal", "kabkota_tujuan_kode", "kabkota_tujuan", "provinsi_tujuan",
                "tipe_faskes_tujuan", "rujukan", "median_hari_ke_fkrtl", "pct_dx_sama", "lintas_kabkota", "lintas_provinsi"]),
    ], "rujukan", "Alur rujukan kab/kota asal → tujuan: jumlah, median hari ke RS, diagnosis sama, lintas kab/kota dan provinsi.")

    # profil_peserta
    j = g.join("j_pp_w", "peserta_wilayah", s["peserta"], W, [("kabkota_tinggal_kode", "kabkota_kode")], "peserta", ["provinsi_kode"])
    a = g.transform("t_pp_agg", "peserta_per_kelompok", j, [
        coalesce("provinsi_kode", ["provinsi_kode", "provinsi_tinggal_38_kode"]), fill("segmen", "tidak tercatat"),
        formula("usia_bawah", "sign(usia_akhir_2024) * floor(abs(usia_akhir_2024) / 10) * 10"), formula("usia_atas", "usia_bawah + 9"),
        cast("usia_bawah", "Long"), cast("usia_atas", "Long"), cast("usia_bawah", "String"), cast("usia_atas", "String"),
        lpad("usia_bawah", "usia_bawah", 2, "0"), lpad("usia_atas", "usia_atas", 2, "0"), concat("rentang_usia", ["usia_bawah", lit("-"), "usia_atas"]),
        case("kelompok_usia", [(any_(c("usia_akhir_2024", "is null"), is_true("flag_tgl_lahir_pengganti")), val("tidak diketahui")),
                               (all_(c("usia_akhir_2024", "is greater than or equal to", val(70, "Long"))), val("70+"))], col("rentang_usia"), "String"),
        aggregate(["edisi", "provinsi_kode", "segmen", "jenis_kelamin", "kelompok_usia"],
                  [agg("Count", "peserta"), agg("Count", "peserta_aktif", where=all_(c("status_kepesertaan", "is equal to", val("AKTIF")))),
                   agg("Count", "peserta_meninggal", where=all_(c("status_kepesertaan", "is equal to", val("MENINGGAL"))))]),
    ], "peserta")
    j = g.join("j_pp_p", "peserta_provinsi", a, P, ["provinsi_kode"], "peserta", ["provinsi"])
    out["profil_peserta"] = g.transform("t_profil_peserta", "profil_peserta", j, [
        concat("profil_peserta_id", ["edisi", "provinsi_kode", "segmen", "jenis_kelamin", "kelompok_usia"], ":"),
        select(["profil_peserta_id", "edisi", "provinsi_kode", "provinsi", "segmen", "jenis_kelamin", "kelompok_usia", "peserta", "peserta_aktif", "peserta_meninggal"]),
    ], "peserta", "Profil peserta per edisi × provinsi × segmen × jenis kelamin × kelompok usia.")

    # kabkota (Nexus objects)
    ka = g.transform("t_ko_klaim", "klaim_per_kabkota_objek", klaim, _measure_steps(["kabkota_fkrtl_kode"], berisiko=True) + [rename("kabkota_fkrtl_kode", "kabkota_kode")], "klaim")
    kf = g.transform("t_ko_faskes", "profil_faskes_per_kabkota", s["dim_profil_faskes"], [aggregate(["kabkota_kode"], [agg("Count", "profil_faskes")])], "dimensi")
    j1 = g.join("j_ko_klaim", "kabkota_klaim", W, ka, ["kabkota_kode"], "dimensi",
                ["klaim", "klaim_inap", "peserta", "biaya_tagih_rp", "biaya_verifikasi_rp", "readmisi_30", "calon_klaim_ganda", "selisih_verifikasi", "los_ekstrem", "klaim_berisiko"])
    j2 = g.join("j_ko_faskes", "kabkota_faskes", j1, kf, ["kabkota_kode"], "dimensi", ["profil_faskes"])
    out["kabkota"] = g.transform("t_kabkota", "kabkota", j2, [
        fill("klaim", "0"), rename("klaim", "klaim_fkrtl"), rename("peserta", "peserta_fkrtl"), _pct("pct_readmisi_30", "readmisi_30", "klaim_inap"),
        fill("klaim_berisiko", "0"), fill("profil_faskes", "0"), rename("kabkota_nama", "kabkota"), rename("provinsi_nama", "provinsi"),
        select(["kabkota_kode", "kabkota", "provinsi_kode", "provinsi", "klaim_fkrtl", "klaim_inap", "peserta_fkrtl", "biaya_tagih_rp", "biaya_verifikasi_rp",
                "pct_readmisi_30", "calon_klaim_ganda", "selisih_verifikasi", "los_ekstrem", "klaim_berisiko", "profil_faskes"]),
    ], "dimensi", "Kab/kota (objek Nexus): klaim FKRTL, readmisi, klaim berisiko, jumlah profil faskes.")

    # profil_faskes (Nexus objects)
    j1 = g.join("j_pf_w", "faskes_wilayah", s["dim_profil_faskes"], W, ["kabkota_kode"], "dimensi", ["kabkota_nama", "provinsi_kode", "provinsi_nama"])
    # upcoding moves a claim to a dearer code or severity, so it shows in a facility's case mix, not in a claim against
    # its own code: the share of inpatient claims at severity III, compared with facilities of the same type
    pa = g.transform("t_pf_klaim", "klaim_per_profil_faskes", klaim, [
        aggregate(["faskes_profil_id"], measures(berisiko=True) + [
            agg("Count", "klaim_inap_berat", where=all_(is_true("rawat_inap"), c("inacbg_keparahan", "is equal to", val("Berat (rawat inap keparahan 3)"))))]),
        *[dict(s, id=_uid()) for s in SUMS]], "klaim")
    j2 = g.join("j_pf_klaim", "faskes_klaim", j1, pa, ["faskes_profil_id"], "dimensi",
                ["klaim", "klaim_inap", "biaya_tagih_rp", "biaya_verifikasi_rp", "readmisi_30", "calon_klaim_ganda", "selisih_verifikasi", "los_ekstrem", "klaim_berisiko",
                 "klaim_inap_berat"])
    out["profil_faskes"] = g.transform("t_profil_faskes", "profil_faskes", j2, [
        concat("nama_profil", ["tingkat", "jenis", "tipe", "kepemilikan", "kabkota_nama"], " · "),
        fill("klaim", "0"), rename("klaim", "klaim_fkrtl"), _pct("pct_readmisi_30", "readmisi_30", "klaim_inap"), fill("klaim_berisiko", "0"),
        _pct("pct_keparahan_berat", "klaim_inap_berat", "klaim_inap"),
        rename("kabkota_nama", "kabkota"), rename("provinsi_nama", "provinsi"),
        select(["faskes_profil_id", "nama_profil", "tingkat", "kabkota_kode", "kabkota", "provinsi_kode", "provinsi", "kepemilikan", "jenis", "tipe", "kunjungan",
                "klaim_fkrtl", "klaim_inap", "biaya_tagih_rp", "biaya_verifikasi_rp", "pct_readmisi_30", "calon_klaim_ganda", "selisih_verifikasi", "los_ekstrem", "klaim_berisiko",
                "klaim_inap_berat", "pct_keparahan_berat"]),
    ], "dimensi", "Profil faskes (objek Nexus): klaim FKRTL, readmisi, klaim berisiko, porsi rawat inap keparahan III.")

    # klaim_berisiko: flagged claims with peer statistics, score and reasons
    r = g.transform("t_kr_flag", "klaim_dengan_indikasi", klaim, [
        keep(any_(is_true("flag_calon_klaim_ganda"), is_true("flag_selisih_verifikasi"), is_true("flag_los_ekstrem")))], "klaim",
        "Klaim dengan sedikitnya satu indikasi: calon klaim ganda, selisih verifikasi, LOS ekstrem.")
    j1 = g.join("j_kr_peer", "klaim_peer", r, inacbg_agg, ["edisi", "inacbg_kode", "tipe_fkrtl", "regional_tarif"], "klaim",
                ["los_inap_p90"], prefix="peer_", description="Left join: p90 LOS rawat inap peer (INA-CBG, tipe RS, regional tarif, edisi).")
    # the bill's peer: the claims of the same tariff table, which the grouper prices alike — a bill above them is a
    # top-up or an amount beyond the tariff, not a dearer tariff table (70% of the bills 1.5x above the old peer were that)
    pt = g.transform("t_peer_tarif", "statistik_peer_tarif", klaim, [
        keep(all_(c("peer_tarif_id", "is not null"))),
        aggregate(["peer_tarif_id"], [agg("Count", "klaim"), agg("Percentile", "biaya_tagih_p50_rp", "biaya_tagih_rp", arg=50),
                                      agg("Count", "klaim_topup_khusus", where=all_(c("topup_khusus_rp", "is greater than", val(0, "Long"))))]),
        _pct("pct_topup_khusus", "klaim_topup_khusus", "klaim", 1),
    ], "klaim", "Statistik peer setarif: INA-CBG × tipe RS × regional × kepemilikan × kelas rawat × tahun tarif × edisi — median biaya tagih, % klaim ber-top-up khusus.")
    j1t = g.join("j_kr_tarif", "klaim_peer_tarif", j1, pt, ["peer_tarif_id"], "klaim", ["klaim", "biaya_tagih_p50_rp", "pct_topup_khusus"], prefix="peer_",
                 description="Left join: statistik peer setarif (tabel tarif yang sama), prefix peer_.")
    j2 = g.join("j_kr_w", "klaim_peer_wilayah", j1t, W, [("kabkota_fkrtl_kode", "kabkota_kode")], "klaim", ["kabkota_nama", "provinsi_nama"])

    def ribuan(column, output):  # a rupiah amount as text with thousands dots (6 Find and replace steps)
        return [cast(column, "String", output), *[regex_replace(output, "^(-?[0-9]+)([0-9]{3})", "$1.$2") for _ in range(6)]]

    out["klaim_berisiko"] = g.transform("t_klaim_berisiko", "klaim_berisiko", j2, [
        fill("flag_calon_klaim_ganda", "false"), fill("flag_selisih_verifikasi", "false"), fill("flag_los_ekstrem", "false"),
        rename("peer_biaya_tagih_p50_rp", "peer_biaya_p50_rp"), formula("rasio_biaya_peer", "round(biaya_tagih_rp / peer_biaya_p50_rp, 2)"),
        concat("klaim_id", ["edisi", "kunjungan_fkrtl_id"], ":"), cast("peserta_id", "String"), concat("peserta_key", ["edisi", "peserta_id"], ":"), month_text("bulan"),
        rename("kabkota_fkrtl_kode", "kabkota_kode"), rename("kabkota_nama", "kabkota"), rename("provinsi_nama", "provinsi"),
        case("indikasi_utama", [(all_(is_true("flag_calon_klaim_ganda")), val("Calon klaim ganda")), (all_(is_true("flag_selisih_verifikasi")), val("Selisih verifikasi")),
                                (all_(is_true("flag_los_ekstrem")), val("LOS ekstrem"))], NULL, "String"),
        concat("indikator_id", ["edisi", "inacbg_kode", "tipe_fkrtl", "regional_tarif"], "|", null_if_any=True),
        formula("jumlah_indikasi", "flag_calon_klaim_ganda + flag_selisih_verifikasi + flag_los_ekstrem + readmisi_30"), cast("jumlah_indikasi", "Integer"),
        formula("bonus_peer", "round((rasio_biaya_peer - 1) * 5)"), fill("bonus_peer", "0"),
        formula("skor_risiko", "min(100, 35*flag_calon_klaim_ganda + 25*flag_selisih_verifikasi + 25*flag_los_ekstrem + 10*readmisi_30 + min(15, max(0, bonus_peer)))"),
        cast("skor_risiko", "Integer"),
        # the reasons, one text per indication, joined with "; "
        *ribuan("selisih_rp", "selisih_teks"),
        concat("selisih_kalimat", [lit("Selisih tagih vs verifikasi Rp "), "selisih_teks"]),
        concat("los_kalimat", [lit("LOS "), "los_hari", lit(" hari, di atas p99 INA-CBG ini")]),
        formula("rasio_1", "round(rasio_biaya_peer, 1)"),
        concat("biaya_kalimat", [lit("Biaya "), "rasio_1", lit("x median peer setarif (INA-CBG, tipe dan kepemilikan RS, regional, kelas rawat, tahun)")]),
        # what makes up a bill above its tariff table: an amount beyond the tariff, a sub-acute/chronic top-up (a long
        # stay), a special drug/prosthesis/procedure/investigation top-up few peers carry
        *ribuan("sisa_di_luar_tarif_rp", "sisa_teks"), *ribuan("topup_subakut_rp", "subakut_teks"), *ribuan("topup_khusus_rp", "khusus_teks"),
        concat("sisa_kalimat", [lit("Tagihan Rp "), "sisa_teks", lit(" di luar tarif INA-CBG + top-up special CMG")]),
        concat("subakut_kalimat", [lit("Top-up subakut/kronis Rp "), "subakut_teks"]),
        concat("khusus_kalimat", [lit("Top-up obat/prostesis/prosedur/investigasi khusus Rp "), "khusus_teks", lit(" (ada di "), "peer_pct_topup_khusus",
                                  lit("% klaim peer)")]),
        case("alasan_1", [(all_(is_true("flag_calon_klaim_ganda")), val("Calon klaim ganda: peserta, tanggal, INA-CBG dan biaya sama dengan klaim lain"))], NULL, "String"),
        case("alasan_2", [(all_(is_true("flag_selisih_verifikasi")), col("selisih_kalimat"))], NULL, "String"),
        case("alasan_3", [(all_(is_true("flag_los_ekstrem")), col("los_kalimat"))], NULL, "String"),
        case("alasan_4", [(all_(is_true("readmisi_30")), val("Rawat inap ulang <= 30 hari setelah pulang"))], NULL, "String"),
        case("alasan_5", [(all_(c("rasio_biaya_peer", "is greater than or equal to", val(2, "Double"))), col("biaya_kalimat"))], NULL, "String"),
        case("alasan_6", [(all_(c("sisa_di_luar_tarif_rp", "is greater than", val(1000, "Long"))), col("sisa_kalimat"))], NULL, "String"),
        case("alasan_7", [(all_(c("rasio_biaya_peer", "is greater than or equal to", val(2, "Double")), c("topup_subakut_rp", "is greater than", val(0, "Long"))),
                           col("subakut_kalimat"))], NULL, "String"),
        case("alasan_8", [(all_(c("rasio_biaya_peer", "is greater than or equal to", val(2, "Double")), c("topup_khusus_rp", "is greater than", val(0, "Long"))),
                           col("khusus_kalimat"))], NULL, "String"),
        concat("alasan_risiko", ["alasan_1", "alasan_2", "alasan_3", "alasan_4", "alasan_5", "alasan_6", "alasan_7", "alasan_8"], "; "),
        *[cast(m, "Double") for m in ("tarif_inacbg_rp", "topup_subakut_rp", "topup_khusus_rp", "biaya_tagih_rp", "biaya_verifikasi_rp", "selisih_rp",
                                      "sisa_di_luar_tarif_rp")],
        select(["klaim_id", "edisi", "kunjungan_fkrtl_id", "peserta_key", "peserta_id", "tgl_datang", "tgl_pulang", "bulan", "kabkota_kode", "kabkota", "provinsi_kode",
                "provinsi", "faskes_profil_id", "indikasi_utama", "tipe_fkrtl", "kepemilikan_fkrtl", "kelas_rawat", "poli", "inacbg_kode", "inacbg_keparahan",
                "regional_tarif", "tahun_tarif", "dx_primer_icd3", "dx_primer_nama", "rawat_inap", "los_hari", "tarif_inacbg_rp", "topup_subakut_rp", "topup_khusus_rp",
                "biaya_tagih_rp", "biaya_verifikasi_rp", "selisih_rp", "sisa_di_luar_tarif_rp", "readmisi_30",
                "flag_calon_klaim_ganda", "flag_selisih_verifikasi", "flag_los_ekstrem", "indikator_id", "peer_klaim", "peer_biaya_p50_rp", "peer_pct_topup_khusus",
                "peer_los_inap_p90", "rasio_biaya_peer", "jumlah_indikasi", "skor_risiko", "alasan_risiko"]),
    ], "klaim", "Klaim berisiko (objek Nexus): statistik peer setarif, top-up dan tagihan di luar tarif, skor risiko 0–100 (Formula) dan alasan dalam kalimat.",
        checkpoint=True)
    KR = out["klaim_berisiko"]

    # klaim_fkrtl: every FKRTL claim with its facts, one row per claim (backs the live Nexus type Klaim FKRTL: millions
    # of objects read from this dataset by ontology_live, not indexed)
    kf = g.join("j_kf_w", "klaim_fkrtl_wilayah", klaim, W, [("kabkota_fkrtl_kode", "kabkota_kode")], "klaim", ["kabkota_nama", "provinsi_nama"])
    # one claim in several editions (a DM patient sampled in reguler too: the same row, 55,988 claims): how many, and the
    # copy a count of claims keeps (reguler first, else the first edition alphabetically) — an aggregate per visit joined
    # back, far lighter than a window over the wide rows
    kunci = [case("prioritas_edisi", [(all_(c("edisi", "is equal to", val("reguler"))), val("0"))], val("1"), "String"),
             concat("kunci_edisi", ["prioritas_edisi", "edisi"], "|")]
    ed = g.transform("t_kf_edisi", "edisi_per_kunjungan", klaim, [
        *kunci, aggregate(["kunjungan_fkrtl_id"], [agg("Count", "jumlah_edisi"), agg("Min", "kunci_kanonik", "kunci_edisi")]), cast("jumlah_edisi", "Integer"),
    ], "klaim", "Di berapa edisi tiap kunjungan tercatat, dan salinan mana yang dihitung.")
    kf = g.join("j_kf_edisi", "klaim_fkrtl_edisi", kf, ed, ["kunjungan_fkrtl_id"], "klaim", ["jumlah_edisi", "kunci_kanonik"],
                description="Left join: jumlah edisi dan salinan yang dihitung tiap klaim.")
    out["klaim_fkrtl"] = g.transform("t_klaim_fkrtl", "klaim_fkrtl", kf, [
        concat("klaim_id", ["edisi", "kunjungan_fkrtl_id"], ":"), cast("peserta_id", "String"), concat("peserta_key", ["edisi", "peserta_id"], ":"), month_text("bulan"),
        rename("kabkota_fkrtl_kode", "kabkota_kode"), rename("kabkota_nama", "kabkota"), rename("provinsi_nama", "provinsi"),
        *[cast(m, "Double") for m in ("tarif_inacbg_rp", "topup_subakut_rp", "topup_khusus_rp", "biaya_tagih_rp", "biaya_verifikasi_rp", "selisih_rp",
                                      "sisa_di_luar_tarif_rp")],
        *[dict(x, id=_uid()) for x in kunci],
        case("klaim_kanonik", [(all_(c("kunci_edisi", "is equal to", col("kunci_kanonik"))), TRUE)], FALSE, "Boolean"),
        select(["klaim_id", "edisi", "kunjungan_fkrtl_id", "peserta_key", "peserta_id", "tgl_datang", "tgl_pulang", "bulan", "kabkota_kode", "kabkota", "provinsi_kode",
                "provinsi", "faskes_profil_id", "tipe_fkrtl", "kepemilikan_fkrtl", "kelas_rawat", "poli", "inacbg_kode", "inacbg_cmg", "inacbg_keparahan",
                "regional_tarif", "tahun_tarif", "dx_primer_icd3", "dx_primer_nama", "rawat_inap", "los_hari", "tarif_inacbg_rp", "topup_subakut_rp", "topup_khusus_rp",
                "biaya_tagih_rp", "biaya_verifikasi_rp", "selisih_rp", "sisa_di_luar_tarif_rp", "readmisi_30", "flag_calon_klaim_ganda", "flag_selisih_verifikasi",
                "flag_los_ekstrem", "peer_tarif_id", "bobot", "jumlah_edisi", "klaim_kanonik"]),
    ], "klaim", "Semua klaim FKRTL, satu baris per klaim (bobot sampel, salinan lintas edisi ditandai): wilayah, faskes, INA-CBG, tarif + top-up, tagihan di luar tarif, flag, readmisi (objek Nexus live).")

    # indikator_peer: INA-CBG groups with at least 30 claims or a risky claim
    n = g.transform("t_ip_n", "indikator_dengan_klaim_berisiko", KR, [aggregate(["indikator_id"], [agg("Count", "klaim_berisiko_n")])], "klaim")
    j = g.join("j_ip", "indikator_peer_berisiko", out["indikator_inacbg"], n, ["indikator_id"], "klaim", ["klaim_berisiko_n"])
    out["indikator_peer"] = g.transform("t_indikator_peer", "indikator_peer", j, [
        keep(any_(c("klaim", "is greater than or equal to", val(30, "Long")), c("klaim_berisiko_n", "is not null"))), drop(["klaim_berisiko_n"])], "klaim",
        "Indikator INA-CBG untuk objek Nexus: kelompok dengan ≥ 30 klaim atau yang punya klaim berisiko.")

    # klaim_bulanan_provinsi
    a = g.transform("t_kbp_agg", "klaim_per_bulan_provinsi", klaim, [month_text("bulan")] + _measure_steps(["edisi", "bulan", "provinsi_kode"]), "klaim")
    j = g.join("j_kbp_p", "klaim_bulanan_provinsi_nama2", a, P, ["provinsi_kode"], "klaim", ["provinsi"])
    out["klaim_bulanan_provinsi"] = g.transform("t_klaim_bulanan_provinsi", "klaim_bulanan_provinsi", j, rata([
        concat("klaim_bulanan_id", ["edisi", "bulan", "provinsi_kode"], ":"), _pct("pct_readmisi_30", "readmisi_30", "klaim_inap"),
        select(["klaim_bulanan_id", "edisi", "bulan", "provinsi_kode", "provinsi", "klaim", "klaim_inap", "peserta", "biaya_tagih_rp", "biaya_verifikasi_rp",
                "rata_biaya_tagih_rp", "rata_los_inap_hari", "readmisi_30", "pct_readmisi_30", "calon_klaim_ganda", "selisih_verifikasi", "los_ekstrem"])]), "klaim",
        "Klaim per bulan × provinsi (objek Nexus).")

    # peserta_klaim_berisiko
    a = g.transform("t_pkb_agg", "klaim_berisiko_per_peserta", KR, [
        aggregate(["edisi", "peserta_id"], [agg("Count", "klaim_berisiko"), agg("Sum", "biaya_klaim_berisiko_rp", "biaya_tagih_rp"), agg("Max", "skor_risiko_maks", "skor_risiko")])], "peserta")
    pt = g.transform("t_pkb_p", "peserta_id_teks", s["peserta"], [cast("peserta_id", "String", "peserta_id_teks")], "peserta")
    j1 = g.join("j_pkb", "peserta_berisiko", pt, a, [("edisi", "edisi"), ("peserta_id_teks", "peserta_id")], "peserta",
                ["klaim_berisiko", "biaya_klaim_berisiko_rp", "skor_risiko_maks"], how="inner", description="Inner join: hanya peserta yang punya klaim berisiko.")
    j2 = g.join("j_pkb_w", "peserta_berisiko_wilayah", j1, W, [("kabkota_tinggal_kode", "kabkota_kode")], "peserta", ["provinsi_nama"])
    out["peserta_klaim_berisiko"] = g.transform("t_peserta_klaim_berisiko", "peserta_klaim_berisiko", j2, [
        coalesce("provinsi_tinggal", ["provinsi_nama", "provinsi_tinggal_38"]), concat("peserta_key", ["edisi", "peserta_id_teks"], ":"),
        drop(["peserta_id"]), rename("peserta_id_teks", "peserta_id"),
        select(["peserta_key", "edisi", "peserta_id", "jenis_kelamin", "usia_akhir_2024", "hubungan_keluarga", "segmen", "kelas_rawat", "status_kepesertaan",
                "provinsi_tinggal", "kabkota_tinggal_kode", "kabkota_tinggal", "jenis_fktp_terdaftar", "kabkota_fktp_terdaftar_kode", "flag_tgl_lahir_pengganti",
                "klaim_berisiko", "biaya_klaim_berisiko_rp", "skor_risiko_maks"]),
    ], "peserta", "Peserta dengan klaim berisiko (objek Nexus): jumlah klaim, biayanya, skor tertinggi.")
    return out


# ------------------------------------------------------------------------------------------------ expectations


def _row_level(*conds) -> dict:
    """Every row passes each condition, or has no value to check (as the Code Repository counts: a claim without a
    verified cost is no violation; the Builder's row-level check counts a null comparison as failing)."""
    return {"id": _uid(), "kind": "rowLevel",
            "condition": json.dumps(all_(*[any_(c(a, "is null"), *([c(b["column"], "is null")] if b.get("kind") == "column" else []), c(a, op, b))
                                           for a, op, b in conds]))}


SILVER_KEYS = {"peserta": ["edisi", "peserta_id"], "kunjungan_fktp": ["edisi", "kunjungan_fktp_id"], "diagnosis_sekunder": ["edisi", "kunjungan_fkrtl_id", "dx_kode"],
               "kunjungan_fkrtl": ["edisi", "kunjungan_fkrtl_id"], "tindakan_nonkapitasi": ["edisi", "kunjungan_id", "tindakan_ke"],
               "rujukan": ["edisi", "kunjungan_fkrtl_id"], "dim_icd10_rinci": ["kode"], "dim_inacbg": ["inacbg_kode"], "dim_wilayah": ["kabkota_kode"],
               "dim_profil_faskes": ["faskes_profil_id"]}
GOLD_KEYS = {
    "klaim_kabkota": ["klaim_kabkota_id"], "klaim_bulanan": ["klaim_bulanan_id"], "indikator_inacbg": ["indikator_id"],
    "kunjungan_fktp_bulanan": ["kunjungan_fktp_bulanan_id"], "penyakit_teratas": ["penyakit_teratas_id"], "alur_rujukan": ["alur_rujukan_id"],
    "profil_peserta": ["profil_peserta_id"], "wilayah": ["kabkota_kode"], "provinsi": ["provinsi_kode"], "kabkota": ["kabkota_kode"],
    "profil_faskes": ["faskes_profil_id"], "klaim_berisiko": ["klaim_id"], "peserta_klaim_berisiko": ["peserta_key"], "indikator_peer": ["indikator_id"],
    "klaim_bulanan_provinsi": ["klaim_bulanan_id"], "kunjungan_fktp_provinsi": ["kunjungan_fktp_bulanan_id"], "klaim_fkrtl": ["klaim_id"],
}


def _expectations(name: str) -> list[dict]:
    keys = SILVER_KEYS.get(name) or GOLD_KEYS[name]
    if name == "diagnosis_sekunder":
        # 55 secondary diagnoses carry no code (the source's blank): the Code Repository counts (edisi, kunjungan,
        # kode) distinct with blanks as values, which a primary key (no nulls) cannot say; the visit is always there
        return [{"id": _uid(), "kind": "notNull", "columns": ["edisi", "kunjungan_fkrtl_id"]}, {"id": _uid(), "kind": "rowCount", "min": 1}]
    out = [{"id": _uid(), "kind": "unique", "columns": keys}, {"id": _uid(), "kind": "rowCount", "min": 1}]
    if name in ("peserta", "kunjungan_fkrtl"):
        out.append({"id": _uid(), "kind": "notNull", "columns": keys})
    if name in ("kunjungan_fktp", "kunjungan_fkrtl"):
        out.append(_row_level(("tgl_pulang", "is greater than or equal to", col("tgl_datang"))))
    if name == "kunjungan_fkrtl":
        out.append(_row_level(("biaya_verifikasi_rp", "is less than or equal to", col("biaya_tagih_rp")),
                              ("biaya_tagih_rp", "is greater than or equal to", val(0, "Long")), ("biaya_verifikasi_rp", "is greater than or equal to", val(0, "Long"))))
    if name == "tindakan_nonkapitasi":
        out.append(_row_level(("biaya_tagih_rp", "is greater than or equal to", val(0, "Long"))))
    return out


# ------------------------------------------------------------------------------------------------ layout & file

def _refs(g: Graph) -> dict[str, list[str]]:
    """The nodes each node reads: its inputs, and the label books of its Mapping join steps."""
    ids = {n["id"] for n in g.nodes}
    name_to_id = {n["name"]: n["id"] for n in g.nodes}
    out = {}
    for n in g.nodes:
        ins = [n["input"]] if n["kind"] == "transform" else [n["left"], n["right"]] if n["kind"] == "join" else n.get("inputs", [])
        books = [s["params"]["mapping"] for s in n.get("steps", []) if s["kind"] == "mapping_join"]
        out[n["id"]] = [i for i in ins if i in ids] + [name_to_id[b] for b in books if b in name_to_id]
    return out


def layout(g: Graph, stage_notes: dict[int, tuple[str, str]]) -> list[dict]:
    """Places the cards (builder_layout.arrange: stages as columns, a lane per legend colour) and returns the text
    nodes: each stage's note above its columns and a label per lane."""
    return builder_layout.arrange(g.nodes, g.outputs, _refs(g), g.stage_of, [(f"lg-{k}", n) for k, n, _ in GROUPS], stage_notes)


def _type(arrow_type) -> str:
    import pyarrow as pa

    t = arrow_type.value_type if pa.types.is_dictionary(arrow_type) else arrow_type
    if pa.types.is_boolean(t):
        return "Boolean"
    if pa.types.is_int32(t) or pa.types.is_int16(t) or pa.types.is_int8(t):
        return "Integer"
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


def content(sources: dict[str, dict], folders: dict[str, dict], project: str, catalog: Optional[dict[str, str]] = None,
            upstream: Optional[dict] = None) -> tuple[dict, dict[str, str]]:
    """The pipeline file. sources: {dataset key: {item_id, table (pyarrow, its first rows), rows (total), folder}} for
    every SOURCES key; folders: {"silver": {id, name}, "gold": {id, name}} where the outputs are written; catalog: each
    source column code → its label in the Stata files (the data dictionary's meanings); upstream: how the inputs were
    made from the source files (builder_upstream.build: the Builder's "Dari Arsip Sumber")."""
    from bpjs_sampel import builder_notes as notes
    now = datetime.now(timezone.utc).isoformat()
    g = Graph()
    datasets, src, cols = {}, {}, {}
    for key, folder, group, doc in SOURCES:
        s = sources[key]
        ds = f"ds_{key}"
        cols[key] = {f.name for f in s["table"].schema}
        datasets[ds] = {"id": ds, "name": key, "origin": f"Files · {project} / {s['folder']} / {key}", "createdAt": now, "refreshedAt": now,
                        "columns": [{"name": f.name, "type": _type(f.type)} for f in s["table"].schema], "rows": _rows(s["table"]), "totalRows": s["rows"],
                        "ref": {"kind": "drive", "itemId": s["item_id"]}}
        src[key] = g.source(f"s_{key}", key, ds, group, f"{doc}\nBaris: {_id_num(s['rows'])} (preview: {_id_num(SAMPLE)} baris pertama)")
    g.stage = 2
    silver_nodes = silver(g, src, cols)
    g.stage = 3
    gold_nodes = gold(g, silver_nodes, src["ibukota_provinsi"])
    out_ids = {}
    for name, node in silver_nodes.items():
        if name != "dim_icd10":  # the reference stays the Code Repository's (read from its xlsx books)
            out_ids[name] = g.output(name, node, folders["silver"], _expectations(name))
    for name, node in gold_nodes.items():
        out_ids[name] = g.output(name, node, folders["gold"], _expectations(name))
    # why each node and output exists (builder_notes): the About panel and the note on the card show it
    missing = [n["id"] for n in g.nodes if n["id"] not in notes.NOTES] + [o["name"] for o in g.outputs if o["name"] not in notes.OUTPUT_NOTES]
    if missing:
        raise ValueError(f"no note for {missing}: add them to builder_notes")
    for n in g.nodes:
        rows = n.get("description", "").split("\nBaris: ", 1)[1:] if n["kind"] == "source" else []
        n["description"] = notes.NOTES[n["id"]] + (f"\nBaris: {rows[0]}" if rows else "")
    for o in g.outputs:
        o["description"] = notes.OUTPUT_NOTES[o["name"]]
    text = layout(g, {
        1: ("note_1",
            "1 · DATA MENTAH — tabel dari file sintetis Data Sampel BPJS Kesehatan 2025 (7 edisi, tata letak sama dengan file asli): kode kolom asli (PSTV, FKP, FKL, PNK) dan nilai apa "
            "adanya, jutaan baris. Buku label menerjemahkan kode menjadi teks per edisi; dua tabel referensi: ICD-10 dan ibu kota provinsi."),
        2: ("note_2",
            "2 · DATA BERSIH — satu transform per tabel: nama kolom jelas, tipe data, kode → label (Mapping join), teks diagnosis dipulihkan; "
            "klaim FKRTL digabung (Union) dan dilengkapi LOS, jumlah diagnosis, p99 LOS (Join) dan flag kualitas. Setiap dataset dicek: kunci unik, "
            "tidak kosong, tanggal & biaya masuk akal. Node bertanda checkpoint dihitung sekali dan dipakai bersama."),
        3: ("note_3",
            "3 · SIAP ANALISIS — 17 dataset untuk dashboard, Nexus dan agen AI: ringkasan per wilayah (38 provinsi), bulan, INA-CBG, faskes, "
            "peserta; statistik peer; klaim berisiko dengan skor 0–100 dan alasannya. Mesin: DuckDB lokal, jutaan baris dihitung dari file Parquet di disk."),
    })
    body = {"type": "batch", "compute": "duckdb", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": g.nodes, "outputs": g.outputs,
            "legend": [{"id": f"lg-{k}", "name": n, "hex": h} for k, n, h in GROUPS], "location": folders["gold"], "textNodes": text, "schedules": [],
            "dictionary": notes.dictionary(catalog), **({"upstream": upstream} if upstream else {}),
            "meta": {"version": SPEC_VERSION, "description": "Data Sampel BPJS Kesehatan 2025 (versi sintetis) dari Data Mentah sampai Siap Analisis, semuanya node visual (DuckDB lokal)."}}
    return body, out_ids


def ibukota_table():
    """The province capitals as a table (the reference dataset ibukota_provinsi)."""
    import pyarrow as pa

    return pa.table({"provinsi_kode": pa.array([k for k, _, _ in IBUKOTA], pa.int32()), "ibukota": [n for _, n, _ in IBUKOTA], "lokasi": [loc for _, _, loc in IBUKOTA]})


def ensure(sources: dict[str, dict], folders: dict[str, dict], pipelines_folder: str, project: str, existing: Optional[str] = None, queue: bool = True,
           catalog: Optional[dict[str, str]] = None, upstream: Optional[dict] = None) -> dict:
    """Create (or bring up to SPEC_VERSION) the pipeline file in Files and queue a build, as gold_pipeline.ensure."""
    import drive
    import pipeline_datasets
    import pipeline_runtime as rt

    body, out_ids = content(sources, folders, project, catalog, upstream)
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
    return {"pipeline_id": pid, "outputs": out_ids, "build": b.get("id"), "created": not existing}
