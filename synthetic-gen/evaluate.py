"""Evaluate the synthetic data against the real data on three axes (Jordon et al. 2022; El Emam et al. 2020):

  1. Fidelity  - does it look like the real data?
       univariate: 1 - total variation distance (categories), 1 - Kolmogorov-Smirnov statistic (numbers, dates)
       bivariate: difference of Cramer's V association matrices
       multivariate: propensity-score mean squared error, pMSE ratio to its permutation null (Woo et al. 2009;
                     Snoke et al. 2018) and the AUC of a gradient-boosted discriminator (0.5 = cannot tell them apart)
       relational: children per peserta, secondary diagnoses per claim, referral share and timing, readmissions
     every number is shown next to the same number for a fresh REAL sample (holdout vs training): the noise floor.
  2. Utility   - does analysis on it reach the same conclusions?
       train-on-synthetic, test-on-real (TSTR, Esteban et al. 2017) for the verification-correction label the audit app
       learns, vs train-on-real; confidence-interval overlap of regression coefficients (Karr et al. 2006);
       rank agreement of the audit rules' rates across hospital types.
  3. Privacy   - can a real person be found or learned about?
       no real identifier anywhere; exact-match rate vs the holdout baseline; replicated uniques (RepU, Raab et al.
       2024); distance to closest record vs the holdout baseline; distance-based membership inference AUC;
       attribute disclosure (DiSCO-style) vs the holdout baseline.

Writes laporan/evaluasi.json and laporan/EVALUASI.md: aggregates only, never a row.
  .venv\\Scripts\\python.exe -I synthetic-gen\\evaluate.py [edisi ...]
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

import duckdb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy import stats  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import average_precision_score, roc_auc_score  # noqa: E402
from sklearn.neighbors import NearestNeighbors  # noqa: E402
from sklearn.tree import DecisionTreeClassifier  # noqa: E402

from sgen import config  # noqa: E402

RNG = np.random.default_rng(7)
HO = config.HOLDOUT_SQL
ID_COLS = {"PSTV01", "PSTV02", "PSTV01_A", "FKP02", "FKL02", "PNK02", "sumber_file", "edisi"}


def connect(eds: list[str]):
    """Views over the given editions only (real and synthetic alike), so the comparison is like for like and a partition
    still being written by the generator is never read."""
    con = duckdb.connect()
    con.execute("SET threads=16")
    rb = str(config.REAL_BRONZE).replace("\\", "/")
    sb = str(config.WORK / "bronze").replace("\\", "/")
    for t in config.TABLES:
        for pfx, base in (("r", rb), ("s", sb)):
            files = [f"{base}/{t}/edisi={e}/data.parquet" for e in eds if Path(f"{base}/{t}/edisi={e}/data.parquet").exists()]
            lst = "[" + ", ".join(f"'{x}'" for x in files) + "]"
            con.execute(f"CREATE VIEW {pfx}_{t} AS SELECT * FROM read_parquet({lst}, hive_partitioning=1, union_by_name=1)")
    # the three samples every metric compares: real training split, real holdout, synthetic
    for t in ("kepesertaan", "fktpkapitasi", "fkrtl", "nonkapitasi"):
        con.execute(f"CREATE VIEW tr_{t} AS SELECT * FROM r_{t} WHERE NOT ({HO})")
        con.execute(f"CREATE VIEW ho_{t} AS SELECT * FROM r_{t} WHERE {HO}")
    con.execute("CREATE VIEW tr_diagnosissekunder AS SELECT d.* FROM r_diagnosissekunder d JOIN tr_fkrtl f USING (FKL02, edisi)")
    con.execute("CREATE VIEW ho_diagnosissekunder AS SELECT d.* FROM r_diagnosissekunder d JOIN ho_fkrtl f USING (FKL02, edisi)")
    return con


def q(con, sql, params=None):
    return con.execute(sql, params or {}).df()


# ------------------------------------------------------------------------------------------------
# 1. fidelity
# ------------------------------------------------------------------------------------------------


def norm(col: str) -> str:
    """A category as text, numbers normalised (a code stored as 1 in one file and 1.0 in another is the same category:
    an integer column with missing values is read as float)."""
    return f"coalesce(CAST(TRY_CAST({col} AS DOUBLE) AS VARCHAR), CAST({col} AS VARCHAR))"


def _tvd(con, a, b, col, e):
    v = norm(f'"{col}"')
    r = con.execute(f"""
        WITH x AS (SELECT {v} v, count(*)::DOUBLE / sum(count(*)) OVER () p FROM {a} WHERE edisi = $e GROUP BY 1),
             y AS (SELECT {v} v, count(*)::DOUBLE / sum(count(*)) OVER () p FROM {b} WHERE edisi = $e GROUP BY 1)
        SELECT 0.5 * sum(abs(coalesce(x.p, 0) - coalesce(y.p, 0))) FROM x FULL OUTER JOIN y ON x.v IS NOT DISTINCT FROM y.v""", {"e": e}).fetchone()
    return float(r[0]) if r[0] is not None else None


def _vals(con, src, col, e, n=200_000, kind="num"):
    expr = f"date_diff('day', DATE '2000-01-01', \"{col}\"::DATE)" if kind == "date" else f'"{col}"::DOUBLE'
    return con.execute(f"SELECT {expr} v FROM {src} WHERE edisi = $e AND \"{col}\" IS NOT NULL USING SAMPLE reservoir({n} ROWS) REPEATABLE (1)", {"e": e}).df()["v"].to_numpy()


def univariate(con, table, e):
    cols = q(con, f"DESCRIBE s_{table}")
    rows = []
    for _, r in cols.iterrows():
        c, ty = r["column_name"], r["column_type"]
        if c in ID_COLS:
            continue
        nd = con.execute(f'SELECT approx_count_distinct("{c}") FROM tr_{table} WHERE edisi = $e', {"e": e}).fetchone()[0]
        if nd == 0:
            continue
        if ty.startswith(("BIGINT", "INTEGER", "DOUBLE", "FLOAT", "SMALLINT", "TINYINT", "TIMESTAMP", "DATE")) and nd > 60:
            kind = "date" if ty.startswith(("TIMESTAMP", "DATE")) else "num"
            a, b, h = (_vals(con, f"{s}_{table}", c, e, kind=kind) for s in ("tr", "s", "ho"))
            if len(a) and len(b):
                ks = stats.ks_2samp(a, b).statistic
                ks0 = stats.ks_2samp(a, h).statistic if len(h) else None
                rows.append({"kolom": c, "jenis": "numerik" if kind == "num" else "tanggal", "metrik": "1-KS", "sintetis": round(1 - ks, 4),
                             "holdout_riil": None if ks0 is None else round(1 - ks0, 4)})
        else:
            t = _tvd(con, f"tr_{table}", f"s_{table}", c, e)
            t0 = _tvd(con, f"tr_{table}", f"ho_{table}", c, e)
            rows.append({"kolom": c, "jenis": "kategori", "metrik": "1-TVD", "sintetis": None if t is None else round(1 - t, 4),
                         "holdout_riil": None if t0 is None else round(1 - t0, 4), "kategori": int(nd)})
    return rows


def _encode(frames: list[pd.DataFrame], cat_cols, num_cols):
    allx = pd.concat(frames, ignore_index=True)
    out = []
    for c in cat_cols:
        codes, _ = pd.factorize(allx[c].astype(str))
        out.append(codes.astype(np.float32))
    for c in num_cols:
        out.append(pd.to_numeric(allx[c], errors="coerce").fillna(-1).to_numpy(np.float32))
    X = np.column_stack(out)
    sizes = np.cumsum([0] + [len(f) for f in frames])
    return [X[sizes[i]:sizes[i + 1]] for i in range(len(frames))]


def _cramers_v(x, y):
    t = pd.crosstab(x, y)
    if t.shape[0] < 2 or t.shape[1] < 2:
        return 0.0
    chi2 = stats.chi2_contingency(t, correction=False)[0]
    n = t.to_numpy().sum()
    return float(np.sqrt(chi2 / (n * (min(t.shape) - 1))))


def bivariate(a: pd.DataFrame, b: pd.DataFrame, cols):
    """Mean |V_real - V_synth| over every pair (numbers binned into deciles of the real values)."""
    def prep(df, ref):
        out = {}
        for c in cols:
            s = df[c]
            if pd.api.types.is_numeric_dtype(ref[c]) and ref[c].nunique() > 20:
                edges = np.unique(np.nanquantile(pd.to_numeric(ref[c], errors="coerce").dropna(), np.linspace(0, 1, 11)))
                out[c] = pd.cut(pd.to_numeric(s, errors="coerce"), np.r_[-np.inf, edges[1:-1], np.inf], labels=False).astype(str)
            else:
                out[c] = s.astype(str)
        return pd.DataFrame(out)
    A, B = prep(a, a), prep(b, a)
    diffs, pairs = [], []
    for i, c1 in enumerate(cols):
        for c2 in cols[i + 1:]:
            va, vb = _cramers_v(A[c1], A[c2]), _cramers_v(B[c1], B[c2])
            diffs.append(abs(va - vb))
            pairs.append({"pair": f"{c1}ÃƒÆ’Ã¢â‚¬â€{c2}", "riil": round(va, 3), "sintetis": round(vb, 3)})
    return float(np.mean(diffs)) if diffs else None, sorted(pairs, key=lambda p: -abs(p["riil"] - p["sintetis"]))[:5]


def pmse(a: pd.DataFrame, b: pd.DataFrame, cat_cols, num_cols, perms=5):
    """pMSE with a CART propensity model (synthpop's default), its ratio to the mean pMSE under permuted labels, and the
    held-out AUC of a gradient-boosted discriminator."""
    n = min(len(a), len(b))
    a, b = a.sample(n, random_state=1), b.sample(n, random_state=2)
    Xa, Xb = _encode([a, b], cat_cols, num_cols)
    X = np.vstack([Xa, Xb])
    y = np.r_[np.zeros(n), np.ones(n)]

    def fit_pmse(lbl):
        m = DecisionTreeClassifier(min_samples_leaf=max(20, n // 500), random_state=0).fit(X, lbl)
        p = m.predict_proba(X)[:, 1]
        return float(np.mean((p - 0.5) ** 2))

    obs = fit_pmse(y)
    null = [fit_pmse(RNG.permutation(y)) for _ in range(perms)]
    idx = RNG.permutation(len(y))
    cut = int(0.7 * len(y))
    gb = HistGradientBoostingClassifier(max_iter=200, random_state=0).fit(X[idx[:cut]], y[idx[:cut]])
    auc = roc_auc_score(y[idx[cut:]], gb.predict_proba(X[idx[cut:]])[:, 1])
    return {"pmse": round(obs, 5), "pmse_ratio": round(obs / np.mean(null), 2), "auc_diskriminator": round(float(auc), 3), "n_per_sisi": int(n)}


CLAIM_SQL = """
SELECT f.edisi, TRY_CAST(f.FKL07 AS DOUBLE) milik, TRY_CAST(f.FKL08 AS DOUBLE) jenis, TRY_CAST(f.FKL09 AS DOUBLE) tipe, TRY_CAST(f.FKL10 AS DOUBLE) tingkat,
       TRY_CAST(f.FKL11 AS DOUBLE) poli, TRY_CAST(f.FKL13 AS DOUBLE) kelas, TRY_CAST(f.FKL14 AS DOUBLE) pulang, TRY_CAST(f.FKL31 AS DOUBLE) regional,
       left(f.FKL19, 1) cmg, right(f.FKL19, 3) keparahan, left(f.FKL17A, 1) dx_bab, date_diff('day', f.FKL03::DATE, f.FKL04::DATE) los,
       f.FKL32::DOUBLE tarif, f.FKL47::DOUBLE tagih, (f.FKL47 - coalesce(f.FKL32, 0))::DOUBLE topup, month(f.FKL03) bulan,
       TRY_CAST(k.PSTV05 AS DOUBLE) jk, date_diff('year', k.PSTV03::DATE, DATE '2024-12-31') usia, TRY_CAST(k.PSTV08 AS DOUBLE) segmen,
       TRY_CAST(k.PSTV07 AS DOUBLE) hak_kelas,
       coalesce(dx.n, 0) n_dx,
       coalesce((f.FKL48 < f.FKL47)::INT, 0) koreksi, f.FKL06 kab_rs, k.PSTV10 kab_peserta, f.FKL17A dx3
FROM {f} f JOIN {k} k ON k.PSTV01 = f.PSTV01 AND k.edisi = f.edisi
LEFT JOIN (SELECT edisi, FKL02, count(*) n FROM {d} GROUP BY 1, 2) dx ON dx.FKL02 = f.FKL02 AND dx.edisi = f.edisi
"""
CLAIM_CAT = ["milik", "jenis", "tipe", "tingkat", "poli", "kelas", "pulang", "regional", "cmg", "keparahan", "dx_bab", "jk", "segmen", "hak_kelas", "bulan"]
CLAIM_NUM = ["los", "tarif", "tagih", "topup", "usia", "n_dx"]


def claims(con, src, e, n=None, positives=False):
    base = CLAIM_SQL.format(f=f"{src}_fkrtl", k=f"{src}_kepesertaan", d=f"{src}_diagnosissekunder")
    where = "WHERE f.edisi = $e" if e else ""
    if n is None:
        return q(con, f"{base} {where}", {"e": e} if e else None)
    pos = q(con, f"{base} {where} {'AND' if e else 'WHERE'} f.FKL48 < f.FKL47", {"e": e} if e else None) if positives else None
    smp = q(con, f"SELECT * FROM ({base} {where}) USING SAMPLE reservoir({n} ROWS) REPEATABLE (3)", {"e": e} if e else None)
    return pd.concat([pos, smp[smp["koreksi"] == 0]], ignore_index=True) if positives else smp


def relational(con, e):
    out = {}
    for src in ("tr", "s", "ho"):
        r = {}
        for t, nm in (("fkrtl", "klaim_fkrtl"), ("fktpkapitasi", "kunjungan_fktp")):
            v = q(con, f"""SELECT count(x.PSTV01) n FROM {src}_kepesertaan k LEFT JOIN {src}_{t} x ON x.PSTV01 = k.PSTV01 AND x.edisi = k.edisi
                           WHERE k.edisi = $e GROUP BY k.PSTV01""", {"e": e})["n"].to_numpy()
            r[f"{nm}_per_peserta"] = {"rata2": round(float(v.mean()), 3), "p90": float(np.quantile(v, .9)), "p99": float(np.quantile(v, .99)),
                                      "pct_ada": round(float((v > 0).mean()) * 100, 2), "_v": v}
        d = q(con, f"""SELECT count(d.FKL24) n FROM {src}_fkrtl f LEFT JOIN {src}_diagnosissekunder d ON d.FKL02 = f.FKL02 AND d.edisi = f.edisi
                       WHERE f.edisi = $e GROUP BY f.FKL02""", {"e": e})["n"].to_numpy()
        r["dx_sekunder_per_klaim"] = {"rata2": round(float(d.mean()), 3), "pct_ada": round(float((d > 0).mean()) * 100, 2), "_v": d}
        x = con.execute(f"""
            WITH f AS (SELECT * FROM {src}_fkrtl WHERE edisi = $e),
            ref AS (SELECT f.FKP02, date_diff('day', p.FKP03::DATE, f.FKL03::DATE) d, (p.PSTV01 = f.PSTV01)::INT same
                    FROM f JOIN {src}_fktpkapitasi p ON p.FKP02 = f.FKP02 AND p.edisi = f.edisi WHERE f.FKP02 <> ''),
            inap AS (SELECT PSTV01, FKL03, FKL04, FKL06, FKL07, FKL08, FKL09,
                            lead(FKL03) OVER (PARTITION BY PSTV01 ORDER BY FKL03, FKL04) nxt,
                            lead(FKL06 || '-' || FKL07 || '-' || FKL08 || '-' || FKL09) OVER (PARTITION BY PSTV01 ORDER BY FKL03, FKL04) nxt_rs
                     FROM f WHERE date_diff('day', FKL03::DATE, FKL04::DATE) > 0 OR FKL10 = 2)
            SELECT (SELECT avg((FKP02 <> '')::INT) FROM f), (SELECT median(d) FROM ref), (SELECT avg(same) FROM ref),
                   (SELECT avg((nxt IS NOT NULL AND date_diff('day', FKL04::DATE, nxt::DATE) BETWEEN 0 AND 30)::INT) FROM inap),
                   (SELECT avg((nxt IS NOT NULL AND date_diff('day', FKL04::DATE, nxt::DATE) BETWEEN 0 AND 30 AND nxt_rs = FKL06 || '-' || FKL07 || '-' || FKL08 || '-' || FKL09)::INT) FROM inap),
                   (SELECT count(*) FROM (SELECT PSTV01, FKL03, FKL19, FKL47, count(*) c FROM f GROUP BY ALL HAVING c > 1)) * 100000.0 / (SELECT count(*) FROM f),
                   (SELECT avg((FKL48 < FKL47)::INT) * 100 FROM f), (SELECT avg(FKL47) FROM f), (SELECT median(date_diff('day', FKL03::DATE, FKL04::DATE)) FROM f WHERE FKL10 = 2)
            """, {"e": e}).fetchone()
        r.update({"pct_klaim_dengan_rujukan": None if x[0] is None else round(x[0] * 100, 2), "median_hari_rujukan_ke_rs": x[1],
                  "pct_rujukan_peserta_sama": None if x[2] is None else round(x[2] * 100, 2),
                  "pct_readmisi_30h": None if x[3] is None else round(x[3] * 100, 2), "pct_readmisi_30h_rs_sama": None if x[4] is None else round(x[4] * 100, 2),
                  "klaim_ganda_per_100rb": None if x[5] is None else round(x[5], 1), "pct_koreksi_verifikasi": None if x[6] is None else round(x[6], 3),
                  "rata2_biaya_tagih": None if x[7] is None else round(x[7]), "median_los_inap": x[8]})
        loc = con.execute(f"""
            WITH f AS (SELECT * FROM {src}_fkrtl WHERE edisi = $e), k AS (SELECT * FROM {src}_kepesertaan WHERE edisi = $e),
                 p AS (SELECT * FROM {src}_fktpkapitasi WHERE edisi = $e),
                 ref AS (SELECT TRY_CAST(f.FKL06 AS BIGINT) rs, TRY_CAST(p.FKP06 AS BIGINT) ft FROM f JOIN p ON p.FKP02 = f.FKP02 WHERE f.FKP02 <> '')
            SELECT (SELECT avg((rs = ft)::INT) FROM ref), (SELECT avg((rs // 100 = ft // 100)::INT) FROM ref),
                   (SELECT avg((TRY_CAST(f.FKL06 AS BIGINT) = TRY_CAST(k.PSTV14 AS BIGINT))::INT) FROM f JOIN k USING (PSTV01)),
                   (SELECT avg((TRY_CAST(p.FKP06 AS BIGINT) = TRY_CAST(k.PSTV14 AS BIGINT))::INT) FROM p JOIN k USING (PSTV01))""", {"e": e}).fetchone()
        r.update({"pct_rujukan_kab_sama": None if loc[0] is None else round(loc[0] * 100, 1), "pct_rujukan_provinsi_sama": None if loc[1] is None else round(loc[1] * 100, 1),
                  "pct_rs_di_kab_fktp_terdaftar": None if loc[2] is None else round(loc[2] * 100, 1),
                  "pct_fktp_di_kab_terdaftar": None if loc[3] is None else round(loc[3] * 100, 1)})
        out[src] = r
    ks = {}
    for key in ("klaim_fkrtl_per_peserta", "kunjungan_fktp_per_peserta", "dx_sekunder_per_klaim"):
        a, b, h = out["tr"][key].pop("_v"), out["s"][key].pop("_v"), out["ho"][key].pop("_v")
        ks[key] = {"sintetis": round(1 - stats.ks_2samp(a, b).statistic, 4), "holdout_riil": round(1 - stats.ks_2samp(a, h).statistic, 4)}
    return {"riil_training": out["tr"], "sintetis": out["s"], "riil_holdout": out["ho"], "1-KS": ks}


# ------------------------------------------------------------------------------------------------
# 2. utility
# ------------------------------------------------------------------------------------------------


def _xy(df, cats, nums, ref=None):
    X = pd.get_dummies(df[cats].astype(str), dtype=np.float32)
    X = pd.concat([X, df[nums].apply(pd.to_numeric, errors="coerce").fillna(-1).astype(np.float32)], axis=1)
    if ref is not None:
        X = X.reindex(columns=ref, fill_value=0)
    return X


def _boot_ci(y, p, fn, n=300):
    vals = []
    idx = np.arange(len(y))
    for _ in range(n):
        b = RNG.choice(idx, len(idx))
        if y[b].sum() == 0:
            continue
        vals.append(fn(y[b], p[b]))
    return [round(float(np.quantile(vals, .025)), 3), round(float(np.quantile(vals, .975)), 3)]


def tstr(con):
    """The audit app's label (claim corrected at verification): random forest trained on real training claims vs on
    synthetic claims, both tested on the real holdout claims of every edition."""
    test = claims(con, "ho", None)
    tr_r = claims(con, "tr", None, n=400_000, positives=True)
    tr_s = claims(con, "s", None, n=400_000, positives=True)
    cats = CLAIM_CAT + ["edisi"]
    Xr = _xy(tr_r, cats, CLAIM_NUM)
    cols = Xr.columns
    Xs = _xy(tr_s, cats, CLAIM_NUM, cols)
    Xt = _xy(test, cats, CLAIM_NUM, cols)
    y = test["koreksi"].to_numpy()
    res = {"uji_holdout": {"klaim": int(len(test)), "terkoreksi": int(y.sum())}}
    for name, X, lab in (("latih_riil", Xr, tr_r["koreksi"]), ("latih_sintetis", Xs, tr_s["koreksi"])):
        rf = RandomForestClassifier(n_estimators=300, min_samples_leaf=5, class_weight="balanced_subsample", n_jobs=-1, random_state=0).fit(X, lab)
        p = rf.predict_proba(Xt)[:, 1]
        top = np.argsort(-p)[: max(1, int(0.01 * len(p)))]
        res[name] = {"auroc": round(float(roc_auc_score(y, p)), 3), "auroc_ci95": _boot_ci(y, p, roc_auc_score),
                     "auprc": round(float(average_precision_score(y, p)), 3), "auprc_ci95": _boot_ci(y, p, average_precision_score),
                     "tertangkap_di_1pct_teratas": int(y[top].sum()), "n_latih": int(len(lab)), "positif_latih": int(lab.sum())}
        imp = pd.Series(rf.feature_importances_, index=cols)
        imp.index = [c.split("_")[0] for c in imp.index]
        res[name]["fitur_teratas"] = imp.groupby(level=0).sum().sort_values(ascending=False).head(6).round(3).to_dict()
    res["prevalensi_uji"] = round(float(y.mean()), 5)
    return res


def _logit_ci(X: np.ndarray, y: np.ndarray):
    m = LogisticRegression(C=np.inf, max_iter=500).fit(X, y)
    p = m.predict_proba(X)[:, 1]
    Xd = np.column_stack([np.ones(len(X)), X])
    W = p * (1 - p)
    cov = np.linalg.pinv(Xd.T @ (Xd * W[:, None]))
    se = np.sqrt(np.clip(np.diag(cov), 0, None))
    beta = np.r_[m.intercept_, m.coef_.ravel()]
    return beta, se


def _ols_ci(X: np.ndarray, y: np.ndarray):
    Xd = np.column_stack([np.ones(len(X)), X])
    beta, *_ = np.linalg.lstsq(Xd, y, rcond=None)
    resid = y - Xd @ beta
    s2 = resid @ resid / (len(y) - Xd.shape[1])
    se = np.sqrt(np.clip(np.diag(s2 * np.linalg.pinv(Xd.T @ Xd)), 0, None))
    return beta, se


def ci_overlap(con, e="reguler"):
    """Karr et al. (2006) interval overlap of the same regression fitted on real training claims and on synthetic claims:
    1 = the intervals coincide, 0 = disjoint. Two models: P(inpatient) and log(billed amount)."""
    a = claims(con, "tr", e, n=150_000)
    b = claims(con, "s", e, n=150_000)
    out = {}
    for name, target, kind in (("rawat_inap", "tingkat", "logit"), ("log_biaya_tagih", "tagih", "ols")):
        cats = ["jk", "segmen", "tipe", "milik"] + ([] if kind == "logit" else ["tingkat", "keparahan"])
        nums = ["usia"] + ([] if kind == "logit" else ["los", "n_dx"])
        ref = _xy(a, cats, nums)
        keep = [c for c in ref.columns if ref[c].std() > 0 and (ref[c] != 0).mean() > 0.005][:40]
        ref = ref[keep]
        Xa, Xb = ref.to_numpy(np.float64), _xy(b, cats, nums, keep).to_numpy(np.float64)
        mu, sd = Xa.mean(0), Xa.std(0) + 1e-9
        Xa, Xb = (Xa - mu) / sd, (Xb - mu) / sd
        if kind == "logit":
            ya = (a["tingkat"].to_numpy() == 2).astype(int)
            yb = (b["tingkat"].to_numpy() == 2).astype(int)
            (ba, sa), (bb, sb) = _logit_ci(Xa, ya), _logit_ci(Xb, yb)
        else:
            ya, yb = np.log1p(a["tagih"].to_numpy()), np.log1p(b["tagih"].to_numpy())
            (ba, sa), (bb, sb) = _ols_ci(Xa, ya), _ols_ci(Xb, yb)
        la, ua, lb, ub = ba - 1.96 * sa, ba + 1.96 * sa, bb - 1.96 * sb, bb + 1.96 * sb
        inter = np.maximum(0, np.minimum(ua, ub) - np.maximum(la, lb))
        with np.errstate(divide="ignore", invalid="ignore"):
            ov = 0.5 * (inter / (ua - la) + inter / (ub - lb))
        ov = np.where(np.isfinite(ov), ov, np.nan)
        same_sign = np.mean(np.sign(ba[1:]) == np.sign(bb[1:]))
        out[name] = {"koefisien": len(ov) - 1, "rata2_overlap_ci": round(float(np.nanmean(ov[1:])), 3), "median_overlap_ci": round(float(np.nanmedian(ov[1:])), 3),
                     "pct_tanda_sama": round(float(same_sign) * 100, 1),
                     "korelasi_koefisien": round(float(np.corrcoef(ba[1:], bb[1:])[0, 1]), 3),
                     "rata2_lebar_ci_riil": round(float(np.nanmean(ua[1:] - la[1:])), 4), "n_per_sisi": int(len(ya))}
    return out


def rule_ranks(con):
    """The audit rules' rates per hospital type and edition: Spearman correlation real vs synthetic (does the synthetic data
    rank the same hospital types as riskiest?)."""
    sql = """
        WITH f AS (SELECT *, date_diff('day', FKL03::DATE, FKL04::DATE) los FROM {f}),
        p99 AS (SELECT FKL19, quantile_cont(date_diff('day', FKL03::DATE, FKL04::DATE), .99) p FROM tr_fkrtl GROUP BY 1)
        SELECT f.edisi, f.FKL08 || '-' || f.FKL09 grp, count(*) n,
               avg((f.los > p99.p)::INT) los_ekstrem, avg((f.FKL48 < f.FKL47)::INT) koreksi, avg((f.FKL47 > f.FKL32 * 1.0 + 0)::INT) topup,
               avg((f.FKL10 = 2)::INT) inap
        FROM f JOIN p99 USING (FKL19) GROUP BY ALL HAVING count(*) >= 200"""
    a = q(con, sql.format(f="tr_fkrtl"))
    b = q(con, sql.format(f="s_fkrtl"))
    m = a.merge(b, on=["edisi", "grp"], suffixes=("_r", "_s"))
    out = {"kelompok": int(len(m))}
    for c in ("los_ekstrem", "koreksi", "topup", "inap"):
        out[c] = round(float(stats.spearmanr(m[f"{c}_r"], m[f"{c}_s"]).statistic), 3) if len(m) > 3 else None
    return out


# ------------------------------------------------------------------------------------------------
# 3. privacy
# ------------------------------------------------------------------------------------------------


def privacy_ids(con):
    out = {}
    for t, c in [("kepesertaan", "PSTV01"), ("kepesertaan", "PSTV02"), ("fkrtl", "FKL02"), ("fkrtl", "FKP02"), ("fktpkapitasi", "FKP02"),
                 ("nonkapitasi", "PNK02"), ("diagnosissekunder", "FKL02")]:
        n = con.execute(f"SELECT count(*) FROM (SELECT DISTINCT {c} FROM s_{t} WHERE CAST({c} AS VARCHAR) <> '') s JOIN (SELECT DISTINCT {c} FROM r_{t}) r USING ({c})").fetchone()[0]
        out[f"{t}.{c}"] = int(n)
    return out


def exact_match(con, e):
    """Share of records whose quasi-identifiers and attributes all equal some real TRAINING record: synthetic vs a real
    holdout record (which was never used to fit, so its matches are what the population gives by chance)."""
    res = {}
    keys = {"kepesertaan": "PSTV03, PSTV05, PSTV10, PSTV08, PSTV07, PSTV04, PSTV06, PSTV14",
            "fkrtl": "FKL03, FKL04, FKL06, FKL07, FKL09, FKL10, FKL11, FKL18, FKL19, FKL47"}
    for t, k in keys.items():
        row = {}
        for src in ("s", "ho"):
            row["sintetis" if src == "s" else "holdout_riil"] = round(float(con.execute(f"""
                WITH x AS (SELECT {k} FROM {src}_{t} WHERE edisi = $e USING SAMPLE reservoir(100000 ROWS) REPEATABLE (5)),
                     r AS (SELECT DISTINCT {k}, 1 AS hit FROM tr_{t} WHERE edisi = $e)
                SELECT avg(coalesce(r.hit, 0)) FROM x LEFT JOIN r USING ({k})""", {"e": e}).fetchone()[0]) * 100, 3)
        res[t] = row
    return res


def repu(con, e):
    """Replicated uniques (Raab, Nowok & Dibben 2024): % of real training records unique on the key that are also unique
    in the synthetic data with the same key. Key: birth date, sex, kab/kota, segment."""
    k = "PSTV03, PSTV05, PSTV10, PSTV08"
    r = con.execute(f"""
        WITH ru AS (SELECT {k} FROM tr_kepesertaan WHERE edisi = $e GROUP BY ALL HAVING count(*) = 1),
             su AS (SELECT {k} FROM s_kepesertaan WHERE edisi = $e GROUP BY ALL HAVING count(*) = 1),
             hu AS (SELECT {k} FROM ho_kepesertaan WHERE edisi = $e GROUP BY ALL HAVING count(*) = 1)
        SELECT (SELECT count(*) FROM tr_kepesertaan WHERE edisi = $e), (SELECT count(*) FROM ru),
               (SELECT count(*) FROM ru JOIN su USING ({k})), (SELECT count(*) FROM ru JOIN hu USING ({k})),
               (SELECT count(*) FROM s_kepesertaan WHERE edisi = $e), (SELECT count(*) FROM ho_kepesertaan WHERE edisi = $e)""", {"e": e}).fetchone()
    n, uniq, rep_s, rep_h, ns, nh = r
    return {"pct_unik_di_riil": round(uniq / n * 100, 2), "repU_sintetis_pct": round(rep_s / n * 100, 3),
            "repU_holdout_pct_disesuaikan_ukuran": round(rep_h / n * 100 * (ns / max(nh, 1)), 3), "catatan": "tanggal lahir sintetis digeser acak Ãƒâ€šÃ‚Â±30 hari"}


def dcr_mia(con, e):
    """Distance to closest record (one-hot categories + scaled numbers): synthetic -> real training vs real holdout ->
    real training. And a membership attack: does closeness to a synthetic record tell training members from holdout?"""
    n = 30_000
    tr = claims(con, "tr", e, n=200_000)
    ho = claims(con, "ho", e, n=n)
    sy = claims(con, "s", e, n=n)
    cats = ["milik", "jenis", "tipe", "tingkat", "kelas", "cmg", "keparahan", "dx_bab", "jk", "segmen", "bulan"]
    nums = ["los", "tagih", "usia", "n_dx"]
    ref = _xy(tr, cats, [])
    keep = list(ref.columns)

    def mat(df):
        X = _xy(df, cats, [], keep).to_numpy(np.float32)
        N = df[nums].apply(pd.to_numeric, errors="coerce").fillna(0).to_numpy(np.float32)
        N[:, 1] = np.log1p(N[:, 1])
        return X, N

    Xt, Nt = mat(tr)
    lo, hi = Nt.min(0), Nt.max(0)
    scale = np.where(hi > lo, hi - lo, 1)

    def full(df):
        X, N = mat(df)
        return np.hstack([X / np.sqrt(2), (N - lo) / scale])

    T = full(tr)
    nn = NearestNeighbors(n_neighbors=1).fit(T)
    d_s = nn.kneighbors(full(sy))[0].ravel()
    d_h = nn.kneighbors(full(ho))[0].ravel()
    p5 = np.quantile(d_h, 0.05)
    # membership attack: members = a sample of training rows, non-members = holdout rows; score = -distance to synthetic
    mem = tr.sample(n, random_state=4)
    nn_s = NearestNeighbors(n_neighbors=1).fit(full(sy))
    a_m = nn_s.kneighbors(full(mem))[0].ravel()
    a_h = nn_s.kneighbors(full(ho))[0].ravel()
    auc = roc_auc_score(np.r_[np.ones(len(a_m)), np.zeros(len(a_h))], -np.r_[a_m, a_h])
    return {"median_dcr_sintetis": round(float(np.median(d_s)), 4), "median_dcr_holdout_riil": round(float(np.median(d_h)), 4),
            "pct_sintetis_lebih_dekat_dari_p5_holdout": round(float((d_s < p5).mean()) * 100, 2), "acuan_p5": 5.0,
            "pct_dcr_nol_sintetis": round(float((d_s == 0).mean()) * 100, 2), "pct_dcr_nol_holdout_riil": round(float((d_h == 0).mean()) * 100, 2),
            "mia_auc": round(float(auc), 3)}


def disco(con, e):
    """Attribute disclosure (DiSCO-style): % of real training claims whose key (5-year age band, sex, residence kab/kota,
    admission month, hospital kab/kota) picks out, in the released data, records that ALL share one primary diagnosis, and
    it is the real one. Released = synthetic, vs released = an equal-size real holdout (the baseline any release carries)."""
    key = ("concat_ws('|', date_diff('year', k.PSTV03::DATE, DATE '2024-12-31') // 5, TRY_CAST(k.PSTV05 AS BIGINT), TRY_CAST(k.PSTV10 AS BIGINT), "
           "month(f.FKL03), TRY_CAST(f.FKL06 AS BIGINT))")
    sql = """WITH x AS (SELECT {key} AS key, f.FKL17A dx FROM {src}_fkrtl f JOIN {src}_kepesertaan k ON k.PSTV01 = f.PSTV01 AND k.edisi = f.edisi WHERE f.edisi = $e)
             SELECT * FROM x"""
    tr = q(con, sql.format(key=key, src="tr"), {"e": e})
    out = {}
    n_ho = None
    for src in ("ho", "s"):
        rel = q(con, sql.format(key=key, src=src), {"e": e})
        rel = rel.dropna(subset=["key"])
        if src == "ho":
            n_ho = len(rel)
        elif n_ho and len(rel) > n_ho:  # the same number of released records as the holdout: a like-for-like baseline
            rel = rel.sample(n_ho, random_state=6)
        g = rel.groupby("key")["dx"].agg(["nunique", "first"])
        uni = g[g["nunique"] == 1]["first"]
        hit = tr["key"].map(uni)
        out["sintetis" if src == "s" else "holdout_riil"] = round(float((hit == tr["dx"]).mean()) * 100, 3)
    return out


# ------------------------------------------------------------------------------------------------


def main(args: list[str]):
    """evaluate.py [edisi ...] [--no-utility | --utility-only]. Per-edition results are merged into laporan/evaluasi.json;
    the utility part (TSTR, rule ranks, identifiers) runs over every edition that is fully written."""
    t0 = time.time()
    flags = {a for a in args if a.startswith("--")}
    eds = [a for a in args if not a.startswith("--")]
    done = sorted(e for e in config.EDITIONS if (config.WORK / f"run_info_{e}.json").exists())  # editions fully written
    eds = [] if "--utility-only" in flags else [e for e in (eds or done) if e in done]
    out_file = config.REPORT / "evaluasi.json"
    rep = json.loads(out_file.read_text("utf-8")) if out_file.exists() else {"per_edisi": {}}
    rep["per_edisi"] = {k: v for k, v in rep.get("per_edisi", {}).items() if k in done}  # results of editions no longer written are dropped
    con = connect(eds or done)
    for e in eds:
        print(f"== {e}", flush=True)
        r = {"univariat": {}, "multivariat": {}, "bivariat": {}}
        for t in config.TABLES:
            r["univariat"][t] = univariate(con, t, e)
        a = claims(con, "tr", e, n=60_000)
        b = claims(con, "s", e, n=60_000)
        r["multivariat"]["fkrtl"] = pmse(a, b, CLAIM_CAT, CLAIM_NUM)
        r["bivariat"]["fkrtl"] = dict(zip(("rata2_selisih_cramers_v", "pasangan_terjauh"), bivariate(a, b, CLAIM_CAT[:10] + ["los", "tagih", "usia"])))
        pk = ("SELECT " + ", ".join(f"TRY_CAST({c} AS DOUBLE) {c}" for c in ("PSTV05", "PSTV04", "PSTV06", "PSTV07", "PSTV08", "PSTV12", "PSTV16", "PSTV17"))
              + ", date_diff('year', PSTV03::DATE, DATE '2024-12-31') usia, TRY_CAST(PSTV10 AS BIGINT) // 100 prov"
              + " FROM {s}_kepesertaan WHERE edisi = $e USING SAMPLE reservoir(60000 ROWS) REPEATABLE (2)")
        pa, pb = q(con, pk.format(s="tr"), {"e": e}), q(con, pk.format(s="s"), {"e": e})
        r["multivariat"]["kepesertaan"] = pmse(pa, pb, ["PSTV05", "PSTV04", "PSTV06", "PSTV07", "PSTV08", "prov", "PSTV12", "PSTV16", "PSTV17"], ["usia"])
        print("   relational", flush=True)
        r["relasional"] = relational(con, e)
        print("   privacy", flush=True)
        r["privasi"] = {"exact_match_pct": exact_match(con, e), "repU": repu(con, e), "dcr_mia": dcr_mia(con, e), "disco_pct": disco(con, e)}
        if e == "reguler":
            r["ci_overlap"] = ci_overlap(con, e)
        rep["per_edisi"][e] = r
        rep["edisi"] = [x for x in config.EDITIONS if x in rep["per_edisi"]]
        (config.REPORT).mkdir(parents=True, exist_ok=True)
        out_file.write_text(json.dumps(rep, indent=1, default=str, ensure_ascii=False), "utf-8")
    rep["edisi"] = [x for x in config.EDITIONS if x in rep["per_edisi"]]
    if "--no-utility" not in flags:
        print(f"== utility (editions: {', '.join(done)})", flush=True)
        con = connect(done)
        rep["tstr"] = tstr(con)
        rep["peringkat_aturan"] = rule_ranks(con)
        rep["privasi_id_riil_ditemukan"] = privacy_ids(con)
        rep["utility_edisi"] = done
        if "reguler" in rep["per_edisi"]:
            rep["per_edisi"]["reguler"]["ci_overlap"] = ci_overlap(con, "reguler")
    rep["detik"] = round(time.time() - t0)
    out_file.write_text(json.dumps(rep, indent=1, default=str, ensure_ascii=False), "utf-8")
    print(f"done in {rep['detik']} s")


if __name__ == "__main__":
    main(sys.argv[1:])
