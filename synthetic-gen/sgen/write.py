"""Write the synthetic tables as Stata files laid out like the real source: same file names, same columns in the same
order, the same storage types, variable labels and value-label books (code books, no person data). Also a Parquet copy
in kerja/ with the bronze layout, for evaluation."""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pandas as pd

import pandas.io.stata as _stata

from sgen import config

INT_TYPES = {"b": "Int8", "h": "Int16", "l": "Int32"}


def _prepare_value_labels_118(self) -> None:
    """pandas' value-label encoder without its 32,000-character cap: that cap belongs to the old .dta 114 format; format
    118 stores a label table's text length in 4 bytes, and the real source files (format 118) carry diagnosis label books
    far longer than that. Otherwise the same as pandas.io.stata.StataValueLabel._prepare_value_labels."""
    self.text_len = 0
    self.txt = []
    self.n = 0
    offsets, values = [], []
    for code, category in self.value_labels:
        b = (category if isinstance(category, str) else str(category)).encode(self._encoding)
        offsets.append(self.text_len)
        self.text_len += len(b) + 1
        values.append(code)
        self.txt.append(b)
        self.n += 1
    self.off = np.array(offsets, dtype=np.int32)
    self.val = np.array(values, dtype=np.int32)
    self.len = 4 + 4 + 4 * self.n + 4 * self.n + self.text_len


_stata.StataValueLabel._prepare_value_labels = _prepare_value_labels_118


def source_files(edisi: str) -> dict[str, Path]:
    folder = config.REAL_DTA / config.EDITIONS[edisi] / "data"
    out = {}
    for f in sorted(folder.glob("*.dta")):
        if f.name.startswith("._"):
            continue
        for t in config.TABLES:
            if f.name.endswith(f"_{t}.dta"):
                out[t] = f
    return out


def meta(path: Path) -> dict:
    with pd.read_stata(path, iterator=True) as r:
        var_labels = r.variable_labels()  # reads the header (the variable list is filled then)
        value_labels = r.value_labels()
        return {"vars": list(r._varlist), "types": list(r._typlist), "fmts": list(r._fmtlist), "lbl": dict(zip(r._varlist, r._lbllist)),
                "value_labels": value_labels, "var_labels": var_labels}


def _column(s: pd.Series | None, n: int, typ, fmt: str) -> tuple[pd.Series, str]:
    if s is None:
        s = pd.Series([None] * n)
    s = s.reset_index(drop=True)
    if fmt.startswith("%td") or fmt.startswith("%d"):
        return pd.to_datetime(s, errors="coerce"), "date"
    if typ == "Q" or isinstance(typ, (int, np.integer)):
        v = s.astype(object).where(s.notna(), "")
        v = v.map(lambda x: x if isinstance(x, str) else (str(int(x)) if isinstance(x, float) and float(x).is_integer() else str(x)))
        return v, "strl" if typ == "Q" else "str"
    if typ in INT_TYPES:
        return pd.array(pd.to_numeric(s, errors="coerce").round(), dtype="Float64").astype(INT_TYPES[typ]), "int"
    if typ == "f":
        return pd.to_numeric(s, errors="coerce").astype("float32"), "float"
    return pd.to_numeric(s, errors="coerce").astype("float64"), "float"


def write_table(df: pd.DataFrame, src: Path, out: Path) -> dict:
    mt = meta(src)
    data, strl, dates = {}, [], {}
    for c, typ, fmt in zip(mt["vars"], mt["types"], mt["fmts"]):
        col, kind = _column(df[c] if c in df.columns else None, len(df), typ, fmt)
        data[c] = col
        if kind == "date":
            dates[c] = "td"
        elif kind == "strl":
            strl.append(c)
    frame = pd.DataFrame(data)
    vlabels = {c: mt["value_labels"][l] for c, l in mt["lbl"].items() if l and l in mt["value_labels"] and str(frame[c].dtype).startswith("Int")}
    out.parent.mkdir(parents=True, exist_ok=True)
    frame.to_stata(out, write_index=False, version=118, convert_dates=dates, convert_strl=strl,
                   variable_labels={k: v[:80] for k, v in mt["var_labels"].items()}, value_labels=vlabels)
    return {"file": out.name, "rows": len(frame), "bytes": out.stat().st_size}


def parquet_copy(df: pd.DataFrame, src: Path, table: str, edisi: str) -> None:
    """The same columns, typed as bronze types them (for the evaluation only)."""
    mt = meta(src)
    cols = {}
    for c, typ, fmt in zip(mt["vars"], mt["types"], mt["fmts"]):
        col, kind = _column(df[c] if c in df.columns else None, len(df), typ, fmt)
        cols[c] = col.astype("float64") if kind == "float" else col
    target = config.WORK / "bronze" / table / f"edisi={edisi}" / "data.parquet"
    target.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(cols).to_parquet(target, index=False)


def copy_reference(edisi: str) -> list[str]:
    """The ICD-10 code books shipped with each edition (WHO codes and names, no person data): copied as they are."""
    src = config.REAL_DTA / config.EDITIONS[edisi] / "icd10"
    dst = config.OUT_DTA / config.EDITIONS[edisi] / "icd10"
    dst.mkdir(parents=True, exist_ok=True)
    done = []
    for f in sorted(src.glob("*")):
        if f.is_file() and not f.name.startswith("._") and f.suffix in (".dta", ".xlsx"):
            shutil.copy2(f, dst / f.name)
            done.append(f.name)
    return done


def write_edition(edisi: str, tables: dict[str, pd.DataFrame], log=print) -> list[dict]:
    files = source_files(edisi)
    out = []
    for t, src in files.items():
        df = tables.get(t)
        if df is None:
            continue
        target = config.OUT_DTA / config.EDITIONS[edisi] / "data" / src.name
        r = write_table(df, src, target)
        parquet_copy(df, src, t, edisi)
        out.append({"edisi": edisi, "tabel": t, **r})
        log(f"    wrote {src.name}: {r['rows']:,} rows, {r['bytes'] / 1e6:.0f} MB")
    copy_reference(edisi)
    return out
