"""Deterministic columns: code books and tariff tables learned from the training split.

These columns are functions of other columns in the source (checked on the real data: share of rows equal to the mode
given the determinant columns, 99.6-100 %), so they are derived, not synthesized:
  province <- kab/kota; ICD-10 3-digit <- detailed code; edition code number <- ICD-10 3-digit; diagnosis name <- code;
  INA-CBG description and digits <- INA-CBG code; special CMG description <- its code.
The INA-CBG tariff is a lookup on (code, regional, class, ownership, type, tariff year) -> 96.7 % of claims match, with
back-off to coarser keys; the special CMG top-ups on (code, regional, type) -> 99.4 %.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from sgen.real import NOT_HOLDOUT


class Lookup:
    """mode(target | keys) with back-off: the first key set that knows the row decides."""

    def __init__(self, con, sql_from: str, target: str, key_sets: list[list[str]], params=None):
        self.key_sets = key_sets
        self.target = target
        self.tables = []
        for keys in key_sets:
            k = ", ".join(keys)
            df = con.execute(f"SELECT {k}, mode({target}) AS __v FROM {sql_from} GROUP BY ALL", params or {}).df()
            self.tables.append(df)

    def __call__(self, df: pd.DataFrame) -> pd.Series:
        out = pd.Series([None] * len(df), index=df.index, dtype=object)
        todo = np.ones(len(df), bool)
        for keys, tab in zip(self.key_sets, self.tables):
            if not todo.any():
                break
            names = [k.split(" AS ")[-1].strip() for k in keys]
            left = df.loc[todo, names].copy()
            for c in names:
                if c in tab.columns and left[c].dtype != tab[c].dtype:
                    if pd.api.types.is_numeric_dtype(tab[c]):
                        left[c] = pd.to_numeric(left[c], errors="coerce")
                    else:
                        left[c] = left[c].astype(object)
            v = left.reset_index(drop=True).merge(tab, on=names, how="left")["__v"].to_numpy()  # a left merge keeps the row order
            hit = pd.notna(v)
            pos = np.flatnonzero(todo)
            out.iloc[pos[hit]] = v[hit]
            todo[pos[hit]] = False
        return out


def edition_maps(con, edisi: str) -> dict:
    """Every deterministic column of one edition."""
    e = {"e": edisi}
    W = f"edisi = $e AND {NOT_HOLDOUT}"
    W_all = "edisi = $e"  # code books (not person data): learned from every row of the edition
    m = {}
    m["PSTV09"] = Lookup(con, f"kepesertaan WHERE {W_all}", "PSTV09", [["PSTV10"]], e)
    m["PSTV09_NEW"] = Lookup(con, f"kepesertaan WHERE {W_all}", "PSTV09_NEW", [["PSTV10"]], e)
    m["PSTV13"] = Lookup(con, f"kepesertaan WHERE {W_all}", "PSTV13", [["PSTV14"]], e)
    m["PSTV13_NEW"] = Lookup(con, f"kepesertaan WHERE {W_all}", "PSTV13_NEW", [["PSTV14"]], e)
    for d, k in [("FKP05", "FKP06"), ("FKP05_NEW", "FKP06"), ("FKP16", "FKP17"), ("FKP16_NEW", "FKP17"), ("FKP14A", "FKP14")]:
        m[d] = Lookup(con, f"fktpkapitasi WHERE {W_all}", d, [[k]], e)
    for d, k in [("FKL05", "FKL06"), ("FKL05_NEW", "FKL06"), ("FKL25", "FKL26"), ("FKL25_NEW", "FKL26"), ("FKL15A", "FKL16"), ("FKL15", "FKL15A"),
                 ("FKL17A", "FKL18"), ("FKL17", "FKL17A"), ("FKL19A", "FKL19"), ("FKL20", "FKL19"), ("FKL21", "FKL19"), ("FKL22", "FKL19"),
                 ("FKL23", "FKL19"), ("FKL36", "FKL35"), ("FKL39", "FKL38"), ("FKL42", "FKL41"), ("FKL45", "FKL44")]:
        m[d] = Lookup(con, f"fkrtl WHERE {W_all}", d, [[k]], e)
    for d, k in [("PNK06", "PNK07"), ("PNK06_NEW", "PNK07"), ("PNK13A", "PNK14"), ("PNK13", "PNK13A")]:
        m[d] = Lookup(con, f"nonkapitasi WHERE {W_all}", d, [[k]], e)
    m["FKL24A"] = Lookup(con, f"diagnosissekunder WHERE {W_all}", "FKL24A", [["FKL24"]], e)
    m["FKL24B"] = Lookup(con, f"diagnosissekunder WHERE {W_all}", "FKL24B", [["FKL24"]], e)
    # FKL49 (COVID service flag) is copied from the claim to its secondary diagnoses
    _ = W
    return m


def tariff_maps(con) -> dict:
    """INA-CBG and special-CMG tariffs (national tables: learned from every edition's training claims)."""
    src = f"(SELECT *, year(FKL04) AS thn FROM fkrtl WHERE {NOT_HOLDOUT})"
    m = {"FKL32": Lookup(con, src, "FKL32", [["FKL19", "FKL31", "FKL13", "FKL07", "FKL09", "thn"], ["FKL19", "FKL31", "FKL13", "FKL09", "thn"],
                                             ["FKL19", "FKL31", "FKL13", "thn"], ["FKL19", "FKL31", "FKL13"], ["FKL19", "FKL31"], ["FKL19"]])}
    for code, tar in [("FKL33", "FKL34"), ("FKL35", "FKL37"), ("FKL38", "FKL40"), ("FKL41", "FKL43"), ("FKL44", "FKL46")]:
        m[tar] = Lookup(con, src, tar, [[code, "FKL31", "FKL09"], [code, "FKL31"], [code]])
    return m
