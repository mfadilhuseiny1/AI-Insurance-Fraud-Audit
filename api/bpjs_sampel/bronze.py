"""L0 → L1 bronze: every Stata file of the source into Parquet, one dataset per table with all editions.

Columns keep their source names and codes (FKL05 = 32, not "JAWA BARAT"); types are fixed per column so every chunk and
every edition agrees; `edisi` and `sumber_file` say where a row came from. Next to the tables:
  _label_nilai      (edisi, tabel, kolom, kode, label)   — the Stata value labels, the code books of the labelled columns
  _katalog_kolom    (edisi, tabel, kolom, label, tipe)   — the variable labels
  _manifest         (edisi, tabel, file, bytes, sha256, rows) — for reconciliation
Run: python -m bpjs_sampel.bronze  (from api/)
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from bpjs_sampel.catalog import OUT, source_files

CHUNK = 250_000


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def _arrow_type(s: pd.Series) -> pa.DataType:
    k = s.dtype.kind
    if k in "iub":
        return pa.int64()
    if k == "f":
        return pa.float64()
    if k == "M":
        return pa.timestamp("ms")
    return pa.string()


def _coerce(df: pd.DataFrame, schema: pa.Schema) -> pa.Table:
    """This chunk in the table's fixed schema (an integer column with a missing value arrives as float)."""
    cols = {}
    for field in schema:
        if field.name not in df.columns:
            cols[field.name] = pa.nulls(len(df), field.type)
            continue
        s = df[field.name]
        if pa.types.is_integer(field.type):
            s = pd.to_numeric(s, errors="coerce").astype("Int64")
        elif pa.types.is_string(field.type):
            s = s.astype("string")
        cols[field.name] = pa.array(s, type=field.type, from_pandas=True)
    return pa.table(cols, schema=schema)


def convert(item: dict, out: Path) -> dict:
    """One source file → bronze/<tabel>/edisi=<edisi>/data.parquet, plus its labels and variable catalogue."""
    path, edisi, tabel = item["path"], item["edisi"], item["tabel"]
    target = out / "bronze" / tabel / f"edisi={edisi}" / "data.parquet"
    target.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rows = 0
    writer = None
    # the labels from a reader of their own: pandas only loads the strL table (long texts — diagnosis and INA-CBG names)
    # before the first chunk when the value labels have not been read yet; read them first and every strL column
    # comes back as its pointer number instead of its text
    with pd.read_stata(path, iterator=True) as lr:
        var_labels = lr.variable_labels()
        value_labels = lr.value_labels()
        lbl_of = dict(zip(lr._varlist, lr._lbllist))  # column → its value-label set (pandas' reader keeps the pairing)
    with pd.read_stata(path, iterator=True, convert_categoricals=False, convert_missing=False, chunksize=CHUNK) as r:
        for chunk in r:
            chunk["sumber_file"] = path.name
            if writer is None:
                schema = pa.schema([pa.field(c, _arrow_type(chunk[c])) for c in chunk.columns])
                writer = pq.ParquetWriter(target, schema, compression="zstd")
            writer.write_table(_coerce(chunk, schema))
            rows += len(chunk)
    if writer is not None:
        writer.close()
    labels = [{"edisi": edisi, "tabel": tabel, "kolom": col, "kode": int(code), "label": str(text)}
              for col, lbl in lbl_of.items() if lbl and lbl in value_labels for code, text in value_labels[lbl].items()]
    catalog = [{"edisi": edisi, "tabel": tabel, "kolom": col, "label": var_labels.get(col, ""), "tipe": str(schema.field(col).type),
                "berlabel": bool(lbl_of.get(col) and lbl_of[col] in value_labels)} for col in var_labels]
    return {"edisi": edisi, "tabel": tabel, "file": path.name, "bytes": path.stat().st_size, "sha256": _sha256(path), "rows": rows,
            "seconds": round(time.time() - t0, 1), "labels": labels, "catalog": catalog}


def run(out: Path = OUT, only: str | None = None) -> list[dict]:
    items = [i for i in source_files() if not only or i["tabel"] == only or i["edisi"] == only]
    results = []
    for i in items:
        res = convert(i, out)
        results.append(res)
        print(f"{res['tabel']:18s} {res['edisi']:17s} {res['rows']:>10,} baris  {res['seconds']:>6.1f}s", flush=True)
    meta = out / "bronze"
    pq.write_table(pa.Table.from_pylist([lab for r in results for lab in r["labels"]]), meta / "_label_nilai.parquet")
    pq.write_table(pa.Table.from_pylist([c for r in results for c in r["catalog"]]), meta / "_katalog_kolom.parquet")
    manifest = [{k: v for k, v in r.items() if k not in ("labels", "catalog")} for r in results]
    pq.write_table(pa.Table.from_pylist(manifest), meta / "_manifest.parquet")
    (meta / "_manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    t = time.time()
    m = run(only=sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"selesai: {len(m)} file, {sum(x['rows'] for x in m):,} baris, {round(time.time() - t)} s")
