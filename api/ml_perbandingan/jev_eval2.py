"""Prompt v1 against prompt v2 on the 80-claim sample: JEv with Decisions' prompt, JEv with prompt v2 (tariff vs INA-CBG vs
the code's median, the platform's rules, the ontology context), and OpenAI Decisions' cached verdicts. The ML and DL rows
come from jev_eval.json (same claims). Adds the v2 row and a paired v2 - v1 interval to jev_eval.json's methods."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
KERJA = Path(__file__).resolve().parents[2] / "data" / "aip" / "ml" / "perbandingan" / "kerja"  # work files (row-level: never in git)
sys.path.insert(0, str(HERE))
from compare_screen import ranking_score  # noqa: E402
from jev_eval import screened_counts, stats  # noqa: E402

LV = {"wajar": 0, "perlu_diperiksa": 1, "mencurigakan": 2}


def load(name: str) -> pd.DataFrame:
    rows = [json.loads(x) for x in (KERJA / name).read_text("utf-8").splitlines()]
    return pd.DataFrame([r for r in rows if r.get("ok")]).drop_duplicates("klaim_id", keep="last")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    from sklearn.metrics import roc_auc_score

    sample = pd.DataFrame(json.loads((KERJA / "jev_sample.json").read_text("utf-8")))
    v1, v2 = load("jev_verdicts.jsonl"), load("jev_v2_verdicts.jsonl")
    S = sample.merge(v1[["klaim_id", "kesimpulan", "skor"]], on="klaim_id").merge(v2[["klaim_id", "kesimpulan", "skor", "usd", "routed_to"]], on="klaim_id", suffixes=("_v1", "_v2"))
    y = S["y"].to_numpy().astype(int)
    n_pos, n_neg = screened_counts()
    w = np.where(y == 1, n_pos / max(1, y.sum()), n_neg / max(1, (y == 0).sum()))
    l1, l2 = S["kesimpulan_v1"].map(LV).to_numpy(), S["kesimpulan_v2"].map(LV).to_numpy()
    s1, s2 = ranking_score(l1, S["skor_v1"].to_numpy()), ranking_score(l2, S["skor_v2"].to_numpy())
    doc = json.loads((KERJA / "jev_eval.json").read_text("utf-8"))
    name = "JEv + prompt v2 (nilai klaim, aturan, ontologi)"
    doc["methods"][name] = stats(y, s2, w, l2 == 2)
    rng = np.random.default_rng(7)
    d = []
    for _ in range(2000):
        i = rng.integers(0, len(y), len(y))
        if 0 < y[i].sum() < len(i):
            d.append(roc_auc_score(y[i], s2[i]) - roc_auc_score(y[i], s1[i]))
    doc["prompt_v2"] = {"claims": len(S), "usd": float(S["usd"].sum()), "routed_to": S["routed_to"].value_counts().to_dict(),
                        "levels": S["kesimpulan_v2"].value_counts().to_dict(),
                        "auroc_v2_minus_v1": float(roc_auc_score(y, s2) - roc_auc_score(y, s1)), "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))],
                        "note": "OpenAI Decisions itself was not re-run with v2: the user's standing rule is never to use the OpenAI key again. v2 ran on JEv (OpenRouter)."}
    (KERJA / "jev_eval.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False), "utf-8")
    p = doc["prompt_v2"]
    print(f"v2 on {p['claims']} claims, ${p['usd']:.3f}, routed {p['routed_to']}, levels {p['levels']}")
    for k, r in sorted(doc["methods"].items(), key=lambda kv: -kv[1]["auroc"]):
        extra = f"  flagged {r['flagged']}: recall {r['recall']:.2f}, false alarms {r['false_alarm_rate']:.2f}, precision at the set's prevalence {r['precision_weighted']:.3f}" if "recall" in r else ""
        print(f"  {k:50s} AUROC {r['auroc']:.3f} [{r['auroc_ci95'][0]:.2f}-{r['auroc_ci95'][1]:.2f}]  AUPRC (at the set's prevalence) {r['auprc_weighted']:.3f}{extra}")
    print(f"  AUROC v2 - v1: {p['auroc_v2_minus_v1']:+.3f} [{p['ci95'][0]:+.3f}, {p['ci95'][1]:+.3f}]")


if __name__ == "__main__":
    main()
