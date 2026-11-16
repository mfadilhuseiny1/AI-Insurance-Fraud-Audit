"""L0 → L1 bronze: the Stata files of one table type (7 editions) → one dataset, source column names and codes.

Per table: bronze/<tabel> (the rows, with edisi and sumber_file), bronze/_meta/label_nilai_<tabel> (the Stata value
labels: the code books of the labelled columns), bronze/_meta/katalog_<tabel> (variable labels, types, and per file its
size, sha256 and row count for reconciliation).
"""

import hashlib
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from transforms.api import Input, Output, transform

from myproject.datasets.bpjs_common import FKRTL_PARTS, P, TABLES, edisi_of

CHUNK = 250_000
LABEL_SCHEMA = pa.schema([("edisi", pa.string()), ("tabel", pa.string()), ("kolom", pa.string()), ("kode", pa.int64()), ("label", pa.string())])
KATALOG_SCHEMA = pa.schema([("edisi", pa.string()), ("tabel", pa.string()), ("kolom", pa.string()), ("label", pa.string()), ("tipe", pa.string()),
                            ("berlabel", pa.bool_()), ("file", pa.string()), ("file_bytes", pa.int64()), ("file_sha256", pa.string()), ("file_rows", pa.int64())])
# repeated texts stored once (dictionary): every text column but the visit identifiers
PLAIN_TEXT = {"FKP02", "FKL02", "PNK02"}


def _arrow_type(kind: str, name: str) -> pa.DataType:
    if kind in "iub":
        return pa.int64()
    if kind == "f":
        return pa.float64()
    if kind == "M":
        return pa.timestamp("ms")
    return pa.string() if name in PLAIN_TEXT else pa.dictionary(pa.int32(), pa.string())


def _merge(a: pa.DataType, b: pa.DataType) -> pa.DataType:
    """The type two editions agree on: text wins, then decimals."""
    if a == b:
        return a
    if pa.types.is_dictionary(a) or pa.types.is_string(a) or pa.types.is_dictionary(b) or pa.types.is_string(b):
        return pa.dictionary(pa.int32(), pa.string())
    if pa.types.is_floating(a) or pa.types.is_floating(b):
        return pa.float64()
    return a


def _coerce(df: pd.DataFrame, schema: pa.Schema) -> pa.Table:
    cols = {}
    for field in schema:
        if field.name not in df.columns:
            cols[field.name] = pa.nulls(len(df), field.type)
            continue
        s = df[field.name]
        if pa.types.is_integer(field.type):
            cols[field.name] = pa.array(pd.to_numeric(s, errors="coerce").astype("Int64"), type=field.type, from_pandas=True)
        elif pa.types.is_floating(field.type):
            cols[field.name] = pa.array(pd.to_numeric(s, errors="coerce"), type=field.type, from_pandas=True)
        elif pa.types.is_timestamp(field.type):
            cols[field.name] = pa.array(pd.to_datetime(s, errors="coerce"), type=field.type, from_pandas=True)
        else:
            text = pa.array(s.astype("string"), type=pa.string(), from_pandas=True)
            cols[field.name] = text.dictionary_encode() if pa.types.is_dictionary(field.type) else text
    return pa.table(cols, schema=schema)


def _meta(fh):
    """Labels from a reader of their own: pandas only loads the strL table (long texts — diagnosis and INA-CBG names)
    when the value labels have not been read before the first chunk."""
    with pd.read_stata(fh, iterator=True) as r:
        # the sample rows FIRST (they load the strL table, so long texts come as text and the column is typed as text),
        # the labels after; read the other way round, the long-text columns were typed as integers and lost every value
        head = r.read(1000, convert_categoricals=False)
        var_labels = r.variable_labels()
        value_labels = r.value_labels()
        lbl_of = dict(zip(r._varlist, r._lbllist))
    return var_labels, value_labels, lbl_of, head


def _make(tabel: str, part: str | None = None):
    """part: the raw folder and the dataset name when a table is read in parts (fkrtl_bagian_1 …); else the table."""
    name = part or tabel
    def compute(raw, out, labels, katalog):
        fs = raw.filesystem()
        status = {f.path: f for f in fs.ls(glob="*.dta")}
        files = sorted(status)
        if not files:
            raise ValueError(f"raw/{name} tidak berisi file .dta")
        # 1. one schema for every edition (an edition may carry a few columns more)
        metas, fields = {}, {}
        for p in files:
            with fs.open(p, "rb") as fh:
                metas[p] = _meta(fh)
            for col in metas[p][3].columns:
                t = _arrow_type(metas[p][3][col].dtype.kind, col)
                fields[col] = _merge(fields[col], t) if col in fields else t
        fields["edisi"] = pa.dictionary(pa.int32(), pa.string())
        fields["sumber_file"] = pa.dictionary(pa.int32(), pa.string())
        schema = pa.schema([pa.field(k, v) for k, v in fields.items()])
        # 2. the rows, chunk by chunk, into one Parquet file
        target = Path(out.path_for_write_table) / "part-00000.parquet"
        lab_rows, kat_rows = [], []
        with pq.ParquetWriter(target, schema, compression="zstd") as w:
            for p in files:
                edisi, fname = edisi_of(p), p.rsplit("/", 1)[-1]
                var_labels, value_labels, lbl_of, _ = metas[p]
                rows = 0
                with fs.open(p, "rb") as fh, pd.read_stata(fh, iterator=True, convert_categoricals=False, chunksize=CHUNK) as r:
                    for chunk in r:
                        chunk["edisi"], chunk["sumber_file"] = edisi, fname
                        w.write_table(_coerce(chunk, schema))
                        rows += len(chunk)
                h = hashlib.sha256()
                with fs.open(p, "rb") as f:
                    for block in iter(lambda: f.read(1 << 22), b""):
                        h.update(block)
                for col, lbl in lbl_of.items():
                    if lbl and lbl in value_labels:
                        lab_rows += [{"edisi": edisi, "tabel": tabel, "kolom": col, "kode": int(k), "label": str(v)} for k, v in value_labels[lbl].items()]
                kat_rows += [{"edisi": edisi, "tabel": tabel, "kolom": c, "label": var_labels.get(c, ""), "tipe": str(schema.field(c).type),
                              "berlabel": bool(lbl_of.get(c) and lbl_of[c] in value_labels), "file": fname, "file_bytes": status[p].size,
                              "file_sha256": h.hexdigest(), "file_rows": rows} for c in var_labels]
                print(f"{fname}: {rows:,} baris ({edisi})")
        out.write_table(out.path_for_write_table)
        # explicit schemas: a table without labelled columns (diagnosis sekunder) still gets an empty, well-typed dataset
        labels.write_table(pa.Table.from_pylist(lab_rows, schema=LABEL_SCHEMA))
        katalog.write_table(pa.Table.from_pylist(kat_rows, schema=KATALOG_SCHEMA))

    editions = ", ".join(FKRTL_PARTS.get(name, ["7 edisi"]))
    compute.__name__ = f"bronze_{name}"
    compute.__doc__ = f"Bronze {name}: Data Sampel BPJS 2025 ({editions}) → satu dataset (kode & nama kolom asli)."
    return transform.using(
        out=Output(f"{P}/bronze/{name}"),
        labels=Output(f"{P}/bronze/_meta/label_nilai_{name}"),
        katalog=Output(f"{P}/bronze/_meta/katalog_{name}"),
        raw=Input(f"{P}/raw/{name}"),
    )(compute)


bronze_kepesertaan = _make("kepesertaan")
bronze_fktpkapitasi = _make("fktpkapitasi")
bronze_fkrtl_bagian_1 = _make("fkrtl", "fkrtl_bagian_1")
bronze_fkrtl_bagian_2 = _make("fkrtl", "fkrtl_bagian_2")
bronze_nonkapitasi = _make("nonkapitasi")
bronze_diagnosissekunder = _make("diagnosissekunder")
assert len(TABLES) == 5
