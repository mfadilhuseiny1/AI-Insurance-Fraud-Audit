"""Who finds the claims the BPJS verifier corrected, on the claims Blu screened (Klaim Berisiko + Skor Risiko Klaim ML,
44,567): OpenAI Decisions (Blu 1.3, verdicts already in the cache), DeepSeek (Blu 1.1, its 11,980), Random Forest (ML) and
an FT-Transformer (deep learning). No model call is made: the LLM verdicts are read from data/aip/telaah/telaah.db.

ML and DL are scored out of fold: the facilities are dealt into 5 folds (ml_klaim.facility_folds, the production split),
each model is trained on the other folds' claims (the benchmark's training sample: all corrected claims, 3 % of the others)
and scores the screened claims of the held-out facilities. So no model scores a claim of a facility it was trained on.

The yardstick is the data's own label, flag_selisih_verifikasi (the verifier paid less than billed). It is what ML and DL
were trained on and not what the LLMs were asked ("clinically suspicious?"), so the comparison favours them by design;
the report says so. Only aggregate numbers are printed and written.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
KERJA = Path(__file__).resolve().parents[2] / "data" / "aip" / "ml" / "perbandingan" / "kerja"  # work files (row-level: never in git)
sys.path.insert(0, str(HERE))
from bench_dl import FEATURES, FTTClassifier, M  # noqa: E402

DB = Path(__file__).resolve().parents[2] / "data" / "aip" / "telaah" / "telaah.db"
LEVEL = {"wajar": 0, "perlu_diperiksa": 1, "mencurigakan": 2}
CONF = {"rendah": 0.2, "sedang": 0.5, "tinggi": 0.8}


def verdicts() -> dict[str, pd.DataFrame]:
    con = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    out: dict[str, list] = {}
    for model, rec in con.execute("SELECT model, rec FROM vonis WHERE peran = 'saring'"):
        d = json.loads(rec)
        lvl = LEVEL.get(d.get("kesimpulan"), 0)
        # Decisions has a probability-weighted level; the chat models a level and a confidence
        skor = float(d["skor"]) if d.get("skor") is not None and d.get("peluang") else lvl + CONF.get(d.get("keyakinan"), 0.5) * 0.9
        out.setdefault(model, []).append({"klaim_id": d.get("klaim_id"), "level": lvl, "skor": skor})
    return {m: pd.DataFrame(v).drop_duplicates("klaim_id") for m, v in out.items()}


def ranking_score(level: np.ndarray, skor: np.ndarray) -> np.ndarray:
    """Blu 1.3's own order (telaah.handed_rank): mencurigakan first, then the score."""
    return (level == 2) * 10.0 + skor


def metrics(y: np.ndarray, s: np.ndarray, groups: np.ndarray, flagged: int, boot: int = 200, seed: int = 0) -> dict:
    from sklearn.metrics import average_precision_score, roc_auc_score

    order = np.argsort(-s, kind="stable")
    out = {"n": int(len(y)), "corrected": int(y.sum()), "auroc": float(roc_auc_score(y, s)), "auprc": float(average_precision_score(y, s))}
    for k in (500, 1000, 2433, 5000):
        top = order[:k]
        out[f"precision_top_{k}"] = float(y[top].mean())
        out[f"recall_top_{k}"] = float(y[top].sum() / max(1, y.sum()))
    rng = np.random.default_rng(seed)
    codes, inv = np.unique(groups, return_inverse=True)
    aps = []
    for _ in range(boot):
        w = np.bincount(rng.integers(0, len(codes), len(codes)), minlength=len(codes))[inv].astype(float)
        if (w * y).sum() > 0:
            aps.append(average_precision_score(y, s, sample_weight=w))
    out["auprc_ci95"] = [float(np.percentile(aps, 2.5)), float(np.percentile(aps, 97.5))]
    return out


def paired(y: np.ndarray, a: np.ndarray, b: np.ndarray, groups: np.ndarray, boot: int = 300, seed: int = 1) -> dict:
    """AUPRC(a) - AUPRC(b) with a facility bootstrap interval (both scored on the same resample)."""
    from sklearn.metrics import average_precision_score

    rng = np.random.default_rng(seed)
    codes, inv = np.unique(groups, return_inverse=True)
    d = []
    for _ in range(boot):
        w = np.bincount(rng.integers(0, len(codes), len(codes)), minlength=len(codes))[inv].astype(float)
        if (w * y).sum() > 0:
            d.append(average_precision_score(y, a, sample_weight=w) - average_precision_score(y, b, sample_weight=w))
    lo, hi = np.percentile(d, [2.5, 97.5])
    return {"diff": float(average_precision_score(y, a) - average_precision_score(y, b)), "ci95": [float(lo), float(hi)], "clear": bool(lo > 0 or hi < 0)}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    import duckdb

    t0 = time.time()
    V = verdicts()
    dec_key = next(k for k in V if "gpt" in k or "openai" in k)
    ds_key = next((k for k in V if "deepseek" in k), None)
    con = duckdb.connect()
    con.execute("SET memory_limit = '3GB'")
    con.execute(f"CREATE VIEW fitur AS SELECT * FROM read_parquet('{FEATURES.as_posix()}')")
    fold_of = M.facility_folds(con, 5)
    ids = pd.DataFrame({"klaim_id": V[dec_key]["klaim_id"]})
    con.register("ids", ids)
    S = con.execute(f"SELECT {', '.join(M.eval_columns())} FROM fitur JOIN ids USING (klaim_id)").df()
    S = S.merge(V[dec_key].rename(columns={"level": "dec_level", "skor": "dec_skor"}), on="klaim_id", how="left")
    if ds_key:
        S = S.merge(V[ds_key].rename(columns={"level": "ds_level", "skor": "ds_skor"}), on="klaim_id", how="left")
    S["fold"] = S["faskes_profil_id"].map(fold_of)
    print(f"screened set: {len(ids):,} Decisions verdicts, {len(S):,} found in the feature table, {int(S['y'].sum())} corrected by the verifier, "
          f"{S['faskes_profil_id'].nunique()} facility profiles", flush=True)

    ev = M.evaluation_set(con, "semua")
    ev["fold"] = ev["faskes_profil_id"].map(fold_of)
    S["ml"] = np.nan
    S["dl"] = np.nan
    fits = []
    for f in range(5):
        train = M._train_part(ev[ev["fold"] != f], np.random.default_rng(M.SEED + f))
        enc = M.Encoder().fit(train)
        part = S["fold"] == f
        t = time.time()
        rf = M.make_model("Random Forest", M.SEED).fit(enc.transform(train), train["y"].to_numpy())
        S.loc[part, "ml"] = rf.predict_proba(enc.transform(S[part]))[:, 1]
        t_rf = time.time() - t
        t = time.time()
        dl = FTTClassifier(seed=M.SEED + f).fit(enc.transform(train), train["y"].to_numpy())
        S.loc[part, "dl"] = dl.predict_proba(enc.transform(S[part]))[:, 1]
        fits.append({"fold": f + 1, "train_rows": len(train), "train_corrected": int(train["y"].sum()), "screened_scored": int(part.sum()),
                     "rf_seconds": round(t_rf, 1), "dl_seconds": round(time.time() - t, 1), "dl_epochs": dl.epochs_run, "dl_inner_val_auprc": round(dl.val_ap, 4)})
        print(f"fold {f + 1}/5: trained on {len(train):,} ({int(train['y'].sum())} corrected), scored {int(part.sum()):,} screened claims; "
              f"RF {t_rf:.0f} s, FT-Transformer {dl.epochs_run} epochs {time.time() - t:.0f} s; {time.time() - t0:.0f} s total", flush=True)

    def board(df: pd.DataFrame, label: str, with_ds: bool) -> dict:
        y, g = df["y"].to_numpy().astype(int), df["faskes_profil_id"].to_numpy()
        cols = {"OpenAI Decisions (Blu 1.3)": ranking_score(df["dec_level"].to_numpy(), df["dec_skor"].to_numpy()),
                "Random Forest (ML)": df["ml"].to_numpy(), "FT-Transformer (deep learning)": df["dl"].to_numpy()}
        if with_ds:
            cols["DeepSeek (Blu 1.1)"] = ranking_score(df["ds_level"].to_numpy(), df["ds_skor"].to_numpy())
        res = {name: metrics(y, s, g, flagged=0) for name, s in cols.items()}
        # what each LLM itself flagged, against the same number of top ML/DL claims
        flag = {"OpenAI Decisions (Blu 1.3)": df["dec_level"].to_numpy() == 2}
        if with_ds:
            flag["DeepSeek (Blu 1.1)"] = df["ds_level"].to_numpy() == 2
        budget = {}
        for name, mask in flag.items():
            k = int(mask.sum())
            row = {"flagged": k, "corrected_among_flagged": int(y[mask].sum())}
            for other in ("Random Forest (ML)", "FT-Transformer (deep learning)"):
                top = np.argsort(-cols[other], kind="stable")[:k]
                row[f"{other} top {k}"] = int(y[top].sum())
            budget[name] = row
        pairs = {"FT-Transformer vs Random Forest": paired(y, cols["FT-Transformer (deep learning)"], cols["Random Forest (ML)"], g),
                 "Random Forest vs OpenAI Decisions": paired(y, cols["Random Forest (ML)"], cols["OpenAI Decisions (Blu 1.3)"], g),
                 "FT-Transformer vs OpenAI Decisions": paired(y, cols["FT-Transformer (deep learning)"], cols["OpenAI Decisions (Blu 1.3)"], g)}
        if with_ds:
            pairs["OpenAI Decisions vs DeepSeek"] = paired(y, cols["OpenAI Decisions (Blu 1.3)"], cols["DeepSeek (Blu 1.1)"], g)
        print(f"\n== {label}: {len(df):,} claims, {int(y.sum())} corrected ({y.mean() * 100:.2f} %)")
        for name, m in sorted(res.items(), key=lambda kv: -kv[1]["auprc"]):
            print(f"  {name:32s} AUPRC {m['auprc']:.3f} [{m['auprc_ci95'][0]:.3f}-{m['auprc_ci95'][1]:.3f}]  AUROC {m['auroc']:.3f}  "
                  f"precision top-1000 {m['precision_top_1000']:.3f}  recall top-5000 {m['recall_top_5000']:.3f}")
        for name, r in budget.items():
            print(f"  {name} flagged {r['flagged']:,} as mencurigakan, {r['corrected_among_flagged']} corrected; same number from "
                  + ", ".join(f"{k.split(' top')[0]}: {v}" for k, v in r.items() if " top " in k))
        for name, p in pairs.items():
            print(f"  {name}: AUPRC diff {p['diff']:+.3f} [{p['ci95'][0]:+.3f}, {p['ci95'][1]:+.3f}]{'  (clear)' if p['clear'] else '  (not clear)'}")
        return {"label": label, "n": len(df), "corrected": int(y.sum()), "methods": res, "flag_budget": budget, "pairs": pairs}

    out = {"screened_total": len(S), "fits": fits, "boards": [
        board(S, "Screened set (Klaim Berisiko + Skor Risiko Klaim ML)", False),
        board(S[S["jenis_fkrtl"] == "Rumah sakit"], "Screened set, hospitals only", False),
    ]}
    if ds_key:
        both = S[S["ds_level"].notna()]
        out["boards"].append(board(both, "Claims both Decisions and DeepSeek screened", True))
    out["seconds"] = round(time.time() - t0, 1)
    (KERJA).mkdir(exist_ok=True)
    (KERJA / "compare_screen.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), "utf-8")
    print(f"\nwritten out/compare_screen.json, {out['seconds']:.0f} s")


if __name__ == "__main__":
    main()
