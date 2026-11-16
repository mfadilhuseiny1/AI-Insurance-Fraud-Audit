"""Training frames from the real bronze tables (the training split only: holdout peserta are never read here).

Everything this module returns stays in memory of the synthesizer process; nothing is written to disk.
"""

from __future__ import annotations

import duckdb
import numpy as np
import pandas as pd

from sgen import config

TOPUP = "coalesce(FKL34,0)+coalesce(FKL37,0)+coalesce(FKL40,0)+coalesce(FKL43,0)+coalesce(FKL46,0)"
NOT_HOLDOUT = f"NOT ({config.HOLDOUT_SQL})"


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET threads=16")
    con.execute("SET preserve_insertion_order=false")
    b = str(config.REAL_BRONZE).replace("\\", "/")
    for t in config.TABLES:
        con.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{b}/{t}/*/data.parquet', hive_partitioning=1, union_by_name=1)")
    con.execute("CREATE VIEW labels AS SELECT * FROM read_parquet('%s/_label_nilai.parquet')" % b)
    return con


def ritl_code(con) -> int:
    """The FKL10 code of inpatient care (its label says 'INAP')."""
    r = con.execute("SELECT kode FROM labels WHERE tabel='fkrtl' AND kolom='FKL10' AND upper(label) LIKE '%INAP%' LIMIT 1").fetchone()
    return int(r[0]) if r else 2


def columns(con, table: str, edisi: str) -> list[str]:
    """The table's columns that carry at least one value in this edition."""
    cols = [r[0] for r in con.execute(f"DESCRIBE {table}").fetchall() if r[0] not in ("edisi", "sumber_file")]
    sel = ", ".join(f'count("{c}") FILTER (WHERE CAST("{c}" AS VARCHAR) <> \'\')' for c in cols)
    got = con.execute(f"SELECT {sel} FROM {table} WHERE edisi = ?", [edisi]).fetchone()
    return [c for c, n in zip(cols, got) if n]


def windows(con, edisi: str) -> dict:
    """Date windows of the edition (origins for day offsets, limits for the synthetic dates)."""
    out = {}
    for t, a, b in [("fkrtl", "FKL03", "FKL04"), ("fktpkapitasi", "FKP03", "FKP04"), ("nonkapitasi", "PNK03", "PNK05")]:
        r = con.execute(f"SELECT min({a})::DATE, max({a})::DATE, min({b})::DATE, max({b})::DATE FROM {t} WHERE edisi=?", [edisi]).fetchone()
        out[t] = {"origin": r[0], "max_in": r[1], "min_out": r[2], "max_out": r[3]}
    return out


def counts(con, edisi: str) -> dict:
    """Row counts of every table in this edition (all peserta: the synthetic edition gets the same number of peserta)."""
    return {t: con.execute(f"SELECT count(*) FROM {t} WHERE edisi=?", [edisi]).fetchone()[0] for t in config.TABLES if t != "diagnosissekunder"}


def _same(a: pd.Series, b: pd.Series) -> np.ndarray:
    return (pd.to_numeric(a, errors="coerce").to_numpy() == pd.to_numeric(b, errors="coerce").to_numpy()).astype(int)


def _sample_ids(df: pd.DataFrame, budget: int, rng: np.random.Generator, n_col: str, must: pd.Series | None = None) -> tuple[np.ndarray, np.ndarray]:
    """A uniform sample of peserta whose rows fit the budget, plus every peserta in `must` (weight 1). Returns ids and the
    sampling weight of each id (1/rate for the uniform part)."""
    must_ids = df.loc[must.fillna(False).astype(bool).to_numpy(), "PSTV01"].to_numpy() if must is not None else np.array([], dtype=df["PSTV01"].dtype)
    rest = df.loc[~df["PSTV01"].isin(must_ids)]
    total = rest[n_col].sum()
    used = df.loc[df["PSTV01"].isin(must_ids), n_col].sum()
    rate = min(1.0, max(budget - used, budget * 0.5) / max(total, 1))
    pick = rest.loc[rng.random(len(rest)) < rate, "PSTV01"].to_numpy()
    ids = np.r_[must_ids, pick]
    w = np.r_[np.ones(len(must_ids)), np.full(len(pick), 1.0 / rate)]
    return ids, w


def peserta_frame(con, edisi: str, ritl: int, rng: np.random.Generator) -> pd.DataFrame:
    """Training peserta with their child summaries (counts, any inpatient stay, main ICD-10 letter)."""
    df = con.execute(f"""
        WITH k AS (SELECT * FROM kepesertaan WHERE edisi = $e AND {NOT_HOLDOUT}),
        refd AS (SELECT DISTINCT FKP02 FROM fkrtl WHERE edisi = $e AND FKP02 <> ''),
        fk AS (SELECT PSTV01, count(*) n_fkrtl, max((FKL10 = {ritl})::INT) has_ritl, mode(left(FKL17A, 1)) l1 FROM fkrtl WHERE edisi = $e GROUP BY 1),
        ft AS (SELECT p.PSTV01, count(*) FILTER (WHERE r.FKP02 IS NULL) n_fktp, mode(left(p.FKP14A, 1)) l2
               FROM fktpkapitasi p LEFT JOIN refd r USING (FKP02) WHERE p.edisi = $e GROUP BY 1),
        nk AS (SELECT PSTV01, count(DISTINCT PNK02) n_nk FROM nonkapitasi WHERE edisi = $e GROUP BY 1)
        SELECT k.*, date_diff('day', k.PSTV03::DATE, DATE '2024-12-31') AS age,
               coalesce(fk.n_fkrtl, 0) n_fkrtl, coalesce(fk.has_ritl, 0) has_ritl, coalesce(fk.l1, ft.l2, '-') main_letter,
               coalesce(ft.n_fktp, 0) n_fktp, coalesce(nk.n_nk, 0) n_nk
        FROM k LEFT JOIN fk USING (PSTV01) LEFT JOIN ft USING (PSTV01) LEFT JOIN nk USING (PSTV01)
        USING SAMPLE reservoir({config.TRAIN_ROWS} ROWS) REPEATABLE ({config.SEED})""", {"e": edisi}).df()
    return df


PESERTA_FEATS = "k.PSTV05, date_diff('day', k.PSTV03::DATE, DATE '2024-12-31') AS age, k.PSTV08, k.PSTV07, k.PSTV10, k.PSTV11, k.PSTV12, k.PSTV14"


def fkrtl_frame(con, edisi: str, ritl: int, origin, rng: np.random.Generator) -> tuple[pd.DataFrame, np.ndarray]:
    """Training claims: every claim of a sample of peserta (plus every peserta with a corrected claim), in order, with the
    previous claim's features, referral state, cost structure and the peserta's features. Returns the frame and row weights."""
    per = con.execute(f"""SELECT PSTV01, count(*) n, max((FKL48 < FKL47)::INT) pos FROM fkrtl WHERE edisi = ? AND {NOT_HOLDOUT} GROUP BY 1""", [edisi]).df()
    ids, w = _sample_ids(per, config.TRAIN_ROWS, rng, "n", per["pos"] == 1)
    con.register("ids_df", pd.DataFrame({"PSTV01": ids, "w": w}))
    df = con.execute(f"""
        SELECT f.*, ids_df.w AS _w, coalesce(dx.n_dx, 0) AS n_dx, ref.FKP03 AS ref_date, {PESERTA_FEATS}
        FROM fkrtl f JOIN ids_df USING (PSTV01)
        LEFT JOIN (SELECT FKL02, count(*) n_dx FROM diagnosissekunder WHERE edisi = $e GROUP BY 1) dx ON dx.FKL02 = f.FKL02
        LEFT JOIN (SELECT FKP02, FKP03 FROM fktpkapitasi WHERE edisi = $e) ref ON ref.FKP02 = f.FKP02
        JOIN (SELECT * FROM kepesertaan WHERE edisi = $e) k ON k.PSTV01 = f.PSTV01
        WHERE f.edisi = $e""", {"e": edisi}).df()
    con.unregister("ids_df")
    df = df.sort_values(["PSTV01", "FKL03", "FKL04", "FKL02"], kind="stable").reset_index(drop=True)
    o = pd.Timestamp(origin)
    df["day"] = (pd.to_datetime(df["FKL03"]) - o).dt.days
    df["los"] = (pd.to_datetime(df["FKL04"]) - pd.to_datetime(df["FKL03"])).dt.days
    g = df.groupby("PSTV01", sort=False)
    df["j"] = g.cumcount() + 1
    df["n_fkrtl"] = g["FKL02"].transform("size")
    df["rem"] = df["n_fkrtl"] - df["j"]
    lag = {"p_day": "day", "p_los": "los", "p_tingkat": "FKL10", "p_kab": "FKL06", "p_milik": "FKL07", "p_jenis": "FKL08", "p_tipe": "FKL09",
           "p_poli": "FKL11", "p_dx": "FKL18", "p_dxa": "FKL18A", "p_cbg": "FKL19", "p_ref": "FKP02", "p_rkab": "FKL26", "p_rmilik": "FKL27",
           "p_rjenis": "FKL28", "p_rtipe": "FKL29"}
    for t_, s_ in lag.items():
        df[t_] = g[s_].shift()
    df["has_ritl"] = (df["FKL10"] == ritl).astype(int).groupby(df["PSTV01"]).transform("max")
    letter1 = df["FKL17A"].astype(str).str[:1].where(df["FKL17A"].notna(), None)
    df["main_letter"] = letter1.groupby(df["PSTV01"]).transform(lambda s: s.mode().iloc[0] if s.notna().any() else "-").fillna("-")
    df["gap"] = df["day"] - df["p_day"]
    same = (df["FKL06"] == df["p_kab"]) & (df["FKL07"] == df["p_milik"]) & (df["FKL08"] == df["p_jenis"]) & (df["FKL09"] == df["p_tipe"])
    df["same_prof"] = np.where(df["j"] > 1, same.astype(int), np.nan)
    df["same_dx"] = np.where(df["j"] > 1, ((df["FKL18"] == df["p_dx"]) | (df["FKL18"].isna() & df["p_dx"].isna())).astype(int), np.nan)
    df["adm_same"] = ((df["FKL16"] == df["FKL18"]) | (df["FKL16"].isna() & df["FKL18"].isna())).astype(int)
    has_ref = df["FKP02"].notna() & (df["FKP02"].astype(str) != "")
    # 0 no referral; 1 a referral this peserta already used on an earlier claim (one referral serves several visits,
    # not always consecutive ones); 2 a referral used for the first time (it opens a referral visit at the FKTP)
    first_use = ~(df["PSTV01"].astype(str) + "|" + df["FKP02"].astype(str)).duplicated()
    df["ref_state"] = np.where(~has_ref, 0, np.where(first_use, 2, 1))
    df["p_has_ref"] = (df["p_ref"].notna() & (df["p_ref"].astype(str) != "")).astype(int)
    n_ref = has_ref.astype(int).groupby(df["PSTV01"]).cumsum()
    df["any_ref"] = (n_ref > 0).astype(int)
    df["p_any_ref"] = ((n_ref - has_ref.astype(int)) > 0).astype(int)
    # the referring facility of the peserta's latest referral before this claim (what a reused referral carries)
    for src, out, lag in (("FKL26", "lrkab", "p_lrkab"), ("FKL27", "lrmilik", "p_lrmilik"), ("FKL28", "lrjenis", "p_lrjenis"), ("FKL29", "lrtipe", "p_lrtipe")):
        df[out] = pd.to_numeric(df[src], errors="coerce").where(has_ref).groupby(df["PSTV01"]).ffill()
        df[lag] = df[out].groupby(df["PSTV01"]).shift()
    df["days_ref"] = (pd.to_datetime(df["FKL03"]) - pd.to_datetime(df["ref_date"])).dt.days
    topup = sum(pd.to_numeric(df[c], errors="coerce").fillna(0) for c in ("FKL34", "FKL37", "FKL40", "FKL43", "FKL46") if c in df.columns)
    base = pd.to_numeric(df["FKL32"], errors="coerce").fillna(0) + topup
    df["rs_home"] = _same(df["FKL06"], df["PSTV14"])  # hospital in the kab/kota of the registered FKTP (76 %; residence: 70 %)
    df["ruj_home"] = _same(df["FKL26"], df["PSTV14"])  # referring facility in the kab/kota of the registered FKTP
    df["topup"] = topup
    tagih = pd.to_numeric(df["FKL47"], errors="coerce").astype("float64")
    verif = pd.to_numeric(df["FKL48"], errors="coerce").astype("float64")
    df["resid_flag"] = (tagih.to_numpy() != base.to_numpy()).astype(int)
    df["resid_ratio"] = tagih / base.replace(0, np.nan)
    df["diff_flag"] = (verif.to_numpy() < tagih.to_numpy()).astype(int)
    df["diff_ratio"] = verif / tagih.replace(0, np.nan)
    return df, df.pop("_w").to_numpy()

def fktp_frame(con, edisi: str, origin, rng: np.random.Generator) -> tuple[pd.DataFrame, np.ndarray]:
    """Training FKTP visits that no FKRTL claim refers to (the referral visits are made from the claim side), in order,
    with the previous visit's features and the peserta's features."""
    con.execute("CREATE OR REPLACE TEMP TABLE refd AS SELECT DISTINCT FKP02 FROM fkrtl WHERE edisi = $e AND FKP02 <> ''", {"e": edisi})
    per = con.execute(f"""SELECT p.PSTV01, count(*) n FROM fktpkapitasi p ANTI JOIN refd r USING (FKP02)
                          WHERE p.edisi = $e AND {NOT_HOLDOUT.replace('PSTV01', 'p.PSTV01')} GROUP BY 1""", {"e": edisi}).df()
    ids, w = _sample_ids(per, config.TRAIN_ROWS, rng, "n")
    con.register("ids_df", pd.DataFrame({"PSTV01": ids, "w": w}))
    df = con.execute(f"""
        SELECT p.*, ids_df.w AS _w, {PESERTA_FEATS}
        FROM (SELECT * FROM fktpkapitasi WHERE edisi = $e) p JOIN ids_df USING (PSTV01) ANTI JOIN refd r ON r.FKP02 = p.FKP02
        JOIN (SELECT * FROM kepesertaan WHERE edisi = $e) k ON k.PSTV01 = p.PSTV01""", {"e": edisi}).df()
    fk = con.execute("""SELECT PSTV01, count(*) n_fkrtl, mode(left(FKL17A, 1)) l1 FROM fkrtl WHERE edisi = $e AND PSTV01 IN (SELECT PSTV01 FROM ids_df) GROUP BY 1""",
                     {"e": edisi}).df()
    ftl = con.execute("""SELECT PSTV01, mode(left(FKP14A, 1)) l2 FROM fktpkapitasi WHERE edisi = $e AND PSTV01 IN (SELECT PSTV01 FROM ids_df) GROUP BY 1""",
                      {"e": edisi}).df()
    con.unregister("ids_df")
    df = df.merge(fk, on="PSTV01", how="left").merge(ftl, on="PSTV01", how="left")
    df["n_fkrtl"] = df["n_fkrtl"].fillna(0)
    df["main_letter"] = df["l1"].fillna(df["l2"]).fillna("-")
    df = df.drop(columns=["l1", "l2"]).sort_values(["PSTV01", "FKP03", "FKP04", "FKP02"], kind="stable").reset_index(drop=True)
    o = pd.Timestamp(origin)
    df["day"] = (pd.to_datetime(df["FKP03"]) - o).dt.days
    df["los"] = (pd.to_datetime(df["FKP04"]) - pd.to_datetime(df["FKP03"])).dt.days
    g = df.groupby("PSTV01", sort=False)
    df["j"] = g.cumcount() + 1
    df["n_fktp"] = g["FKP02"].transform("size")
    df["rem"] = df["n_fktp"] - df["j"]
    for t_, s_ in {"p_day": "day", "p_kab": "FKP06", "p_milik": "FKP07", "p_jenis": "FKP08", "p_tipe": "FKP09", "p_tingkat": "FKP10",
                   "p_poli": "FKP11", "p_dx": "FKP14", "p_dx15": "FKP15", "p_dx15a": "FKP15A"}.items():
        df[t_] = g[s_].shift() if s_ in df.columns else np.nan
    df["gap"] = df["day"] - df["p_day"]
    same = (df["FKP06"] == df["p_kab"]) & (df["FKP07"] == df["p_milik"]) & (df["FKP08"] == df["p_jenis"]) & (df["FKP09"] == df["p_tipe"])
    df["same_prof"] = np.where(df["j"] > 1, same.astype(int), np.nan)
    df["same_dx"] = np.where(df["j"] > 1, ((df["FKP14"] == df["p_dx"]) | (df["FKP14"].isna() & df["p_dx"].isna())).astype(int), np.nan)
    df["ft_home"] = _same(df["FKP06"], df["PSTV14"])  # visit in the kab/kota of the registered FKTP
    return df, df.pop("_w").to_numpy()


def refvisit_frame(con, edisi: str) -> pd.DataFrame:
    """Training referral visits: each FKTP visit some claim refers to, with the first claim that refers to it."""
    c = con.execute(f"""SELECT FKP02, FKL02, FKL03, PSTV01, FKL06 c_kab, FKL07 c_milik, FKL08 c_jenis, FKL09 c_tipe, FKL10 c_tingkat, FKL11 c_poli,
                               FKL18 c_dx, FKL19 c_cbg FROM fkrtl WHERE edisi = $e AND FKP02 <> '' AND {NOT_HOLDOUT}""", {"e": edisi}).df()
    c = c.sort_values(["FKP02", "FKL03", "FKL02"], kind="stable").drop_duplicates("FKP02")
    if len(c) > config.TRAIN_ROWS:
        c = c.sample(config.TRAIN_ROWS, random_state=config.SEED)
    con.register("c1", c)
    df = con.execute(f"""SELECT p.*, c1.c_kab, c1.c_milik, c1.c_jenis, c1.c_tipe, c1.c_tingkat, c1.c_poli, c1.c_dx, c1.c_cbg,
                                date_diff('day', p.FKP03::DATE, c1.FKL03::DATE) AS days_ref, date_diff('day', p.FKP03::DATE, p.FKP04::DATE) AS los,
                                {PESERTA_FEATS}
                         FROM c1 JOIN (SELECT * FROM fktpkapitasi WHERE edisi = $e) p ON p.FKP02 = c1.FKP02
                         JOIN (SELECT * FROM kepesertaan WHERE edisi = $e) k ON k.PSTV01 = c1.PSTV01""", {"e": edisi}).df()
    con.unregister("c1")
    df["ft_home"] = _same(df["FKP06"], df["PSTV14"])
    return df

def nonkap_frames(con, edisi: str, origin) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Training non-capitation visits (one row per visit, in order per peserta) and their procedure rows."""
    rows = con.execute(f"""
        SELECT n.*, row_number() OVER (PARTITION BY n.PNK02 ORDER BY n.PNK04, n.PNK16, n.PNK17) AS k, count(*) OVER (PARTITION BY n.PNK02) AS n_tind
        FROM nonkapitasi n WHERE edisi = $e AND {NOT_HOLDOUT}""", {"e": edisi}).df()
    if rows.empty:
        return rows, rows
    v = rows.loc[rows["k"] == 1].copy()
    v["day"] = (pd.to_datetime(v["PNK03"]) - pd.Timestamp(origin)).dt.days
    v["los"] = (pd.to_datetime(v["PNK05"]) - pd.to_datetime(v["PNK03"])).dt.days
    v = v.sort_values(["PSTV01", "day", "PNK02"])
    v["j"] = v.groupby("PSTV01").cumcount() + 1
    v["p_day"] = v.groupby("PSTV01")["day"].shift()
    v["gap"] = v["day"] - v["p_day"]
    v["n_nk"] = v.groupby("PSTV01")["PNK02"].transform("count")
    v["rem"] = v["n_nk"] - v["j"]
    k = con.execute(f"SELECT PSTV01, PSTV05, date_diff('day', PSTV03::DATE, DATE '2024-12-31') AS age, PSTV08, PSTV10, PSTV14 FROM kepesertaan WHERE edisi = ?", [edisi]).df()
    v = v.merge(k, on="PSTV01", how="left")
    v["nk_home"] = _same(v["PNK07"], v["PSTV14"])
    rows["d_tind"] = (pd.to_datetime(rows["PNK04"]) - pd.to_datetime(rows["PNK03"])).dt.days
    rows["ratio18"] = rows["PNK18"] / rows["PNK17"].replace(0, np.nan)
    rows = rows.merge(v[["PNK02", "PNK09", "PNK10", "PNK11", "PNK14", "los", "PSTV05", "age"]].rename(columns={"PNK09": "v_jenis", "PNK10": "v_tipe", "PNK11": "v_tingkat", "PNK14": "v_dx", "los": "v_los"}),
                      on="PNK02", how="left")
    rows["p_tind"] = rows.groupby("PNK02")["PNK16"].shift()
    return v, rows


def dxsek_frame(con, edisi: str, rng: np.random.Generator) -> pd.DataFrame:
    """Training secondary diagnoses with their claim's features and their position in the claim."""
    c = con.execute(f"""SELECT f.FKL02, f.FKL10, f.FKL11, f.FKL09, f.FKL18, f.FKL19, f.FKL23, date_diff('day', f.FKL03::DATE, f.FKL04::DATE) los,
                               k.PSTV05, date_diff('day', k.PSTV03::DATE, DATE '2024-12-31') AS age
                        FROM (SELECT * FROM fkrtl WHERE edisi = $e AND {NOT_HOLDOUT}) f JOIN (SELECT * FROM kepesertaan WHERE edisi = $e) k
                        ON k.PSTV01 = f.PSTV01""", {"e": edisi}).df()
    d = con.execute("SELECT FKL02, FKL24 FROM diagnosissekunder WHERE edisi = $e", {"e": edisi}).df()
    d = d.merge(c[["FKL02"]], on="FKL02")
    per_claim = d.groupby("FKL02").size()
    rate = min(1.0, config.TRAIN_ROWS / max(len(d), 1))
    keep = per_claim.index[rng.random(len(per_claim)) < rate]
    d = d.loc[d["FKL02"].isin(keep)].sort_values(["FKL02", "FKL24"], kind="stable")
    d["k"] = d.groupby("FKL02").cumcount() + 1
    d["n_dx"] = d.groupby("FKL02")["FKL24"].transform("size")
    return d.merge(c, on="FKL02", how="left").drop(columns=["FKL02"])

def family_sizes(con, edisi: str) -> np.ndarray:
    return con.execute(f"SELECT count(*) n FROM kepesertaan WHERE edisi = ? AND {NOT_HOLDOUT} GROUP BY PSTV02", [edisi]).df()["n"].to_numpy()


def mother_link_share(con) -> float:
    r = con.execute(f"""SELECT avg((i.PSTV01 IS NOT NULL)::INT) FROM (SELECT * FROM kepesertaan WHERE edisi = 'kia_anak' AND {NOT_HOLDOUT}) a
                        LEFT JOIN (SELECT DISTINCT PSTV01 FROM kepesertaan WHERE edisi = 'kia_ibu') i ON i.PSTV01 = a.PSTV01_A""").fetchone()
    return float(r[0] or 0.0)
