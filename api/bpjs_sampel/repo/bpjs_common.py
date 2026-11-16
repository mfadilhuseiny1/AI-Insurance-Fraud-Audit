"""Shared by the bronze and silver transforms of Data Sampel BPJS Kesehatan Edisi 2025.

See README.md. P is the Files Project the datasets live in.
"""

import re
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc

P = "Data Sampel BPJS 2025"
TABLES = ["kepesertaan", "fktpkapitasi", "fkrtl", "nonkapitasi", "diagnosissekunder"]
EDITIONS = ["reguler", "covid", "dm", "kesehatan_mental", "kia_ibu", "kia_anak", "tb"]
# A code build reads at most 2 GiB of files: the FKRTL source files (2.16 GB for 7 editions) are read in two parts,
# raw/fkrtl_bagian_1 and raw/fkrtl_bagian_2; silver_kunjungan_fkrtl puts them together again.
FKRTL_PARTS = {"fkrtl_bagian_1": ["reguler", "covid", "dm"], "fkrtl_bagian_2": ["kesehatan_mental", "kia_ibu", "kia_anak", "tb"]}


def edisi_of(file_name: str) -> str:
    """The edition of a source file, from its name (202403_fkrtl.dta, COV20152024_fkrtl.dta, KIA2024ibu_fkrtl.dta …)."""
    n = file_name.rsplit("/", 1)[-1]
    for prefix, edisi in (("COV", "covid"), ("DM", "dm"), ("KM", "kesehatan_mental"), ("KIA2024ibu", "kia_ibu"),
                          ("KIA2024anak", "kia_anak"), ("TB", "tb")):
        if n.startswith(prefix):
            return edisi
    if re.match(r"^\d", n):
        return "reguler"
    raise ValueError(f"edisi tidak dikenal untuk {n}")


def dictionary_encoded(batches, keep_plain=("_id",)) -> pa.Table:
    """Record batches → a table whose repeated texts (labels, names, codes) are dictionary-encoded: the same strings
    once, the rows as indexes — a 9.7 million-row visit table needs about half the memory. Identifiers stay plain."""
    out = []
    for b in batches:
        cols = []
        for f, c in zip(b.schema, b.columns):
            text = pa.types.is_string(f.type) or pa.types.is_large_string(f.type)
            cols.append(pc.dictionary_encode(c) if text and not f.name.endswith(keep_plain) else c)
        out.append(pa.RecordBatch.from_arrays(cols, names=b.schema.names))
    if not out:
        raise ValueError("tidak ada baris")
    schema = out[0].schema
    return pa.Table.from_batches([o.cast(schema) if o.schema != schema else o for o in out], schema=schema)


def parquet_of(*inps) -> str:
    """One or more dataset inputs as one DuckDB source (their Parquet files, downloaded on demand; columns by name)."""
    files = ", ".join(f"'{Path(i.path()).as_posix()}/*.parquet'" for i in inps)
    return f"read_parquet([{files}], union_by_name = true)"


def expect(results: list, nama: str, nilai, harus=0) -> None:
    """Record an expectation; the transform raises after all are recorded when one failed."""
    results.append({"nama": nama, "nilai": int(nilai) if nilai is not None else None, "harus": harus, "lolos": nilai == harus})


def raise_failed(results: list) -> None:
    bad = [r for r in results if not r["lolos"]]
    if bad:
        raise ValueError("ekspektasi gagal: " + "; ".join(f"{r['nama']} = {r['nilai']} (harus {r['harus']})" for r in bad))
