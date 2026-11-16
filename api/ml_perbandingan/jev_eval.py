"""JEv against OpenAI Decisions, DeepSeek, Random Forest and the FT-Transformer on the same balanced sample of screened
claims (40 corrected, 40 not). ML and DL are scored out of fold exactly as in compare_screen.py (same folds, same seeds).
Precision and AUPRC are reweighted to the screened set's prevalence (read from compare_screen.json); AUROC and recall do not depend on the balance.
Only aggregate numbers are written."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
KERJA = Path(__file__).resolve().parents[2] / "data" / "aip" / "ml" / "perbandingan" / "kerja"  # work files (row-level: never in git)
sys.path.insert(0, str(HERE))
from bench_dl import FEATURES, FTTClassifier, M  # noqa: E402
from compare_screen import ranking_score, verdicts  # noqa: E402


def screened_counts() -> tuple[int, int]:
    """Corrected and other claims of the whole screened set the sample was drawn from (compare_screen.json, board 0)."""
    b = json.loads((KERJA / "compare_screen.json").read_text("utf-8"))["boards"][0]
    return int(b["corrected"]), int(b["n"]) - int(b["corrected"])


def stats(y: np.ndarray, s: np.ndarray, w: np.ndarray, flag: np.ndarray | None, boot: int = 1000, seed: int = 0) -> dict:
    from sklearn.metrics import average_precision_score, roc_auc_score

    out = {"auroc": float(roc_auc_score(y, s)), "auprc_weighted": float(average_precision_score(y, s, sample_weight=w))}
    rng = np.random.default_rng(seed)
    au = []
    for _ in range(boot):
        i = rng.integers(0, len(y), len(y))
        if 0 < y[i].sum() < len(i):
            au.append(roc_auc_score(y[i], s[i]))
    out["auroc_ci95"] = [float(np.percentile(au, 2.5)), float(np.percentile(au, 97.5))]
    if flag is not None:
        tp, fp = int((flag & (y == 1)).sum()), int((flag & (y == 0)).sum())
        out.update({"flagged": int(flag.sum()), "recall": tp / max(1, int(y.sum())), "false_alarm_rate": fp / max(1, int((y == 0).sum())),
                    "precision_weighted": float((w * (flag & (y == 1))).sum() / max(1e-9, (w * flag).sum()))})
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    import duckdb

    t0 = time.time()
    rows = [json.loads(x) for x in (KERJA / "jev_verdicts.jsonl").read_text("utf-8").splitlines()]
    jev = pd.DataFrame([r for r in rows if r.get("ok")]).drop_duplicates("klaim_id", keep="last")
    sample = pd.DataFrame(json.loads((KERJA / "jev_sample.json").read_text("utf-8")))
    jev = sample.merge(jev[["klaim_id", "kesimpulan", "skor", "usd", "routed_to"]], on="klaim_id", how="inner")
    V = verdicts()
    dec = V[next(k for k in V if "gpt" in k)].rename(columns={"level": "dec_level", "skor": "dec_skor"})
    ds_key = next((k for k in V if "deepseek" in k), None)
    S = jev.merge(dec, on="klaim_id", how="left")
    if ds_key:
        S = S.merge(V[ds_key].rename(columns={"level": "ds_level", "skor": "ds_skor"}), on="klaim_id", how="left")

    con = duckdb.connect()
    con.execute("SET memory_limit = '2GB'")
    con.execute(f"CREATE VIEW fitur AS SELECT * FROM read_parquet('{FEATURES.as_posix()}')")
    fold_of = M.facility_folds(con, 5)
    con.register("ids", S[["klaim_id"]])
    X = con.execute(f"SELECT {', '.join(M.eval_columns())} FROM fitur JOIN ids USING (klaim_id)").df()
    S = S.merge(X.drop(columns=["y"]), on="klaim_id", how="left")
    S["fold"] = S["faskes_profil_id"].map(fold_of)
    ev = M.evaluation_set(con, "semua")
    ev["fold"] = ev["faskes_profil_id"].map(fold_of)
    S["ml"], S["dl"] = np.nan, np.nan
    for f in sorted(S["fold"].unique()):
        train = M._train_part(ev[ev["fold"] != f], np.random.default_rng(M.SEED + int(f)))
        enc = M.Encoder().fit(train)
        part = S["fold"] == f
        rf = M.make_model("Random Forest", M.SEED).fit(enc.transform(train), train["y"].to_numpy())
        S.loc[part, "ml"] = rf.predict_proba(enc.transform(S[part]))[:, 1]
        dl = FTTClassifier(seed=M.SEED + int(f)).fit(enc.transform(train), train["y"].to_numpy())
        S.loc[part, "dl"] = dl.predict_proba(enc.transform(S[part]))[:, 1]
        print(f"fold {int(f) + 1}: {int(part.sum())} sample claims scored, {time.time() - t0:.0f} s", flush=True)

    y = S["y"].to_numpy().astype(int)
    n_pos, n_neg = screened_counts()  # the screened set the sample was drawn from
    w = np.where(y == 1, n_pos / max(1, y.sum()), n_neg / max(1, (y == 0).sum()))
    jl = S["kesimpulan"].map({"wajar": 0, "perlu_diperiksa": 1, "mencurigakan": 2}).to_numpy()
    res = {
        "JEv (typesafe/jev-router)": stats(y, ranking_score(jl, S["skor"].to_numpy()), w, jl == 2),
        "OpenAI Decisions (Blu 1.3)": stats(y, ranking_score(S["dec_level"].to_numpy(), S["dec_skor"].to_numpy()), w, S["dec_level"].to_numpy() == 2),
        "Random Forest (ML)": stats(y, S["ml"].to_numpy(), w, None),
        "FT-Transformer (deep learning)": stats(y, S["dl"].to_numpy(), w, None),
    }
    # ML and DL at the same number of flags as each LLM
    for name, k in (("JEv", int((jl == 2).sum())), ("Decisions", int((S["dec_level"] == 2).sum()))):
        for m, col in (("Random Forest (ML)", "ml"), ("FT-Transformer (deep learning)", "dl")):
            top = np.argsort(-S[col].to_numpy(), kind="stable")[:k]
            res[m][f"recall_at_{name}_budget_{k}"] = float(y[top].sum() / y.sum())
    agree = float((jl == S["dec_level"].to_numpy()).mean())
    out = {"sample": len(S), "corrected": int(y.sum()), "jev_usd": float(S["usd"].sum()), "jev_routed_to": S["routed_to"].value_counts().to_dict(),
           "jev_levels": S["kesimpulan"].value_counts().to_dict(), "jev_vs_decisions_same_level": agree, "methods": res}
    (KERJA / "jev_eval.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), "utf-8")
    print(f"\n== {len(S)} claims ({int(y.sum())} corrected), JEv cost ${out['jev_usd']:.3f}; JEv levels {out['jev_levels']}; same level as Decisions {agree:.0%}")
    for name, r in sorted(res.items(), key=lambda kv: -kv[1]["auroc"]):
        line = f"  {name:32s} AUROC {r['auroc']:.3f} [{r['auroc_ci95'][0]:.2f}-{r['auroc_ci95'][1]:.2f}]  AUPRC (at the set's prevalence) {r['auprc_weighted']:.3f}"
        if "recall" in r:
            line += f"  flagged {r['flagged']}: recall {r['recall']:.2f}, false alarms {r['false_alarm_rate']:.2f}, precision at the set's prevalence {r['precision_weighted']:.3f}"
        else:
            line += "  " + ", ".join(f"{k.replace('recall_at_', 'recall at ').replace('_budget_', ' budget ')} {v:.2f}" for k, v in r.items() if k.startswith("recall_at"))
        print(line)


if __name__ == "__main__":
    main()
