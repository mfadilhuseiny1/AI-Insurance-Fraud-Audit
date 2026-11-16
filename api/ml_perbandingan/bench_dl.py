"""Deep learning against Random Forest on the claim-risk task, with the repo's own benchmark protocol (ml_klaim.benchmark):
5 folds grouped by facility profile x repeats, threshold chosen on held-out facilities, population-weighted metrics, the
corrected resampled t-test. The DL model is an FT-Transformer (Gorishniy et al., NeurIPS 2021), plugged in through
ml_klaim.make_model without changing the repo. Everything runs locally on CPU; only aggregate metrics are written.

    python bench_dl.py --task semua|rumah_sakit [--folds 5] [--repeats 3] [--smoke]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API))
import ml_klaim as M  # noqa: E402

import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
import torch.nn.functional as F  # noqa: E402

FEATURES = API.parent / "data" / "aip" / "ml" / "cache" / "fitur-217f2b804b0c4525-324971703-v1.parquet"  # the cache model 0.6.0 used
OUT = API.parent / "data" / "aip" / "ml" / "perbandingan" / "kerja"
DL = "FT-Transformer"


class FTTransformer(nn.Module):
    """Feature tokenizer + transformer: every feature becomes a d-dimensional token (numeric: x*w + b, a learned token when
    missing; categorical: an embedding), a [CLS] token is prepended, pre-norm transformer blocks, the head reads [CLS]."""

    # no dropout by default: on this CPU build the dropout masks (aten::bernoulli_) took 60 % of a training step; weight
    # decay and early stopping regularise instead (profiled 2026-11-08: 1,800 -> 10,000 rows/s)
    def __init__(self, n_num: int, cards: list[int], d: int = 32, layers: int = 3, heads: int = 4, attn_drop: float = 0.0, ffn_drop: float = 0.0):
        super().__init__()
        self.w = nn.Parameter(torch.randn(n_num, d) * 0.1)
        self.b = nn.Parameter(torch.zeros(n_num, d))
        self.missing = nn.Parameter(torch.randn(n_num, d) * 0.1)
        self.embs = nn.ModuleList([nn.Embedding(c, d) for c in cards])
        self.cat_bias = nn.Parameter(torch.zeros(len(cards), d))
        self.cls = nn.Parameter(torch.randn(1, 1, d) * 0.1)
        block = nn.TransformerEncoderLayer(d, heads, dim_feedforward=int(d * 4 / 3) * 2, dropout=ffn_drop, activation="gelu", batch_first=True, norm_first=True)
        block.self_attn.dropout = attn_drop
        self.encoder = nn.TransformerEncoder(block, layers, enable_nested_tensor=False)
        self.head = nn.Sequential(nn.LayerNorm(d), nn.ReLU(), nn.Linear(d, 1))

    def forward(self, xn: torch.Tensor, miss: torch.Tensor, xc: torch.Tensor) -> torch.Tensor:
        tn = xn.unsqueeze(-1) * self.w + self.b
        tn = torch.where(miss.unsqueeze(-1), self.missing.expand_as(tn), tn)
        tc = torch.stack([e(xc[:, i]) for i, e in enumerate(self.embs)], 1) + self.cat_bias
        x = torch.cat([self.cls.expand(len(xn), -1, -1), tn, tc], 1)
        return self.head(self.encoder(x)[:, 0]).squeeze(-1)


class FTTClassifier:
    """scikit-learn shaped: fit(X, y) on the coded matrix ml_klaim.Encoder makes (numeric columns, then integer category
    codes with -1 for unknown), predict_proba(X). Early stopping on 10 % of the training rows (random, stratified)."""

    def __init__(self, seed: int = 0, epochs: int = 30, patience: int = 5, batch: int = 512, lr: float = 3e-4, wd: float = 1e-4, threads: int = 8,
                 log=print):
        self.seed, self.epochs, self.patience, self.batch, self.lr, self.wd, self.threads, self.log = seed, epochs, patience, batch, lr, wd, threads, log

    def _arrays(self, X: pd.DataFrame):
        num = X[self.num].to_numpy(np.float64)
        miss = np.isnan(num)
        num = np.where(miss, 0.0, M.signed_log(num))
        num = (num - self.mu) / self.sd
        num[miss] = 0.0
        cat = X[self.cat].to_numpy(np.float64)
        cat = np.where(np.isnan(cat), -1, cat).astype(np.int64) + 1  # -1 (unknown) -> 0
        cat = np.minimum(cat, self.cards_arr - 1)
        return torch.tensor(num, dtype=torch.float32), torch.tensor(miss), torch.tensor(cat)

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> "FTTClassifier":
        from sklearn.metrics import average_precision_score
        from sklearn.model_selection import train_test_split

        torch.manual_seed(self.seed)
        np.random.seed(self.seed)
        torch.set_num_threads(self.threads)
        self.cat = [c for c in X.columns if c in M.CAT_LOW]
        self.num = [c for c in X.columns if c not in self.cat]
        raw = X[self.num].to_numpy(np.float64)
        lg = M.signed_log(np.where(np.isnan(raw), np.nan, raw))
        self.mu, self.sd = np.nanmean(lg, 0), np.nanstd(lg, 0) + 1e-6
        self.mu, self.sd = np.nan_to_num(self.mu), np.where(np.isnan(self.sd), 1.0, self.sd)
        self.cards_arr = np.array([int(np.nanmax(X[c].to_numpy())) + 2 if X[c].notna().any() else 2 for c in self.cat])
        tr, va = train_test_split(np.arange(len(y)), test_size=0.1, stratify=y, random_state=self.seed)
        xn, ms, xc = self._arrays(X)
        yt = torch.tensor(y, dtype=torch.float32)
        self.model = FTTransformer(len(self.num), [int(c) for c in self.cards_arr])
        opt = torch.optim.AdamW(self.model.parameters(), lr=self.lr, weight_decay=self.wd)
        pos = float(y[tr].sum())
        pos_weight = torch.tensor(np.sqrt((len(tr) - pos) / max(pos, 1.0)), dtype=torch.float32)
        best, best_state, wait, t0 = -1.0, None, 0, time.time()
        g = torch.Generator().manual_seed(self.seed)
        for ep in range(self.epochs):
            self.model.train()
            order = torch.tensor(tr)[torch.randperm(len(tr), generator=g)]
            for i in range(0, len(order), self.batch):
                idx = order[i : i + self.batch]
                loss = F.binary_cross_entropy_with_logits(self.model(xn[idx], ms[idx], xc[idx]), yt[idx], pos_weight=pos_weight)
                opt.zero_grad()
                loss.backward()
                opt.step()
            s = self._scores(xn[va], ms[va], xc[va])
            ap = float(average_precision_score(y[va], s))
            if ap > best + 1e-4:
                best, wait = ap, 0
                best_state = {k: v.detach().clone() for k, v in self.model.state_dict().items()}
            else:
                wait += 1
            if wait >= self.patience:
                break
        self.model.load_state_dict(best_state)
        self.epochs_run, self.val_ap, self.fit_seconds = ep + 1, best, time.time() - t0
        return self

    @torch.no_grad()
    def _scores(self, xn, ms, xc) -> np.ndarray:
        self.model.eval()
        out = [torch.sigmoid(self.model(xn[i : i + 4096], ms[i : i + 4096], xc[i : i + 4096])) for i in range(0, len(xn), 4096)]
        return torch.cat(out).numpy()

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        p = self._scores(*self._arrays(X))
        return np.c_[1 - p, p]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="semua", choices=list(M.TASKS))
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--models", default=f"Random Forest,{DL},MLP")
    ap.add_argument("--smoke", action="store_true", help="a 1-in-4 sample of facilities, 2 folds, few epochs: checks the pipeline and the timing")
    a = ap.parse_args()

    original = M.make_model
    fits: list[dict] = []

    def make_model(name: str, seed: int = M.SEED):
        if name == DL:
            m = FTTClassifier(seed=seed, epochs=4 if a.smoke else 30)
            fit0 = m.fit

            def fit(X, y):
                r = fit0(X, y)
                fits.append({"epochs": r.epochs_run, "val_ap": round(r.val_ap, 4), "seconds": round(r.fit_seconds, 1)})
                print(f"  {DL}: {r.epochs_run} epochs, inner val AUPRC {r.val_ap:.3f}, {r.fit_seconds:.0f} s", flush=True)
                return r

            m.fit = fit
            return m
        return original(name, seed)

    M.make_model = make_model
    M.MODELS.setdefault(DL, ("deep learning (PyTorch)", "Gorishniy dkk. 2021, Revisiting Deep Learning Models for Tabular Data (NeurIPS)"))

    import duckdb

    con = duckdb.connect()
    con.execute("SET memory_limit = '3GB'")
    con.execute(f"CREATE VIEW fitur AS SELECT * FROM read_parquet('{FEATURES.as_posix()}')")
    data = M.evaluation_set(con, a.task)
    if a.smoke:
        ids = data["faskes_profil_id"].drop_duplicates().sample(frac=0.25, random_state=0)
        data = data[data["faskes_profil_id"].isin(set(ids))].reset_index(drop=True)
    print(f"[{a.task}] evaluation set: {len(data):,} claims, {int(data['y'].sum())} corrected, {data['faskes_profil_id'].nunique()} facility profiles", flush=True)
    res = M.benchmark(data, models=a.models.split(","), folds=2 if a.smoke else a.folds, repeats=1 if a.smoke else a.repeats, references=[],
                      log=lambda m: print(m, flush=True))
    res.pop("oof", None)  # row-level scores stay in memory, never written
    OUT.mkdir(exist_ok=True)
    keep = []
    for b in res["papan"]:
        keep.append({"model": b["model"], "rata": b["rata"], "gabungan_oof": b["gabungan_oof"], "menang": b["menang"], "dari": b["dari"],
                     "detik_latih": b["detik_latih"], "uji_vs_terbaik": b.get("uji_vs_terbaik"),
                     "auprc_lipatan": [[f["ulangan"], f["lipatan"], f["auprc"]] for f in b["lipatan"]]})
    doc = {"task": a.task, "task_label": M.TASKS[a.task][0], "smoke": a.smoke, "evaluasi": res["evaluasi"], "folds": res["lipatan"], "repeats": res["ulangan"],
           "seconds": res["detik"], "board": keep, "dl_fits": fits, "features": M.FEATURES, "feature_table": FEATURES.name}
    f = OUT / f"bench_{a.task}{'_smoke' if a.smoke else ''}.json"
    f.write_text(json.dumps(doc, indent=1, ensure_ascii=False), "utf-8")
    print("\nleaderboard (mean over splits):")
    for b in keep:
        r = b["rata"]
        t = b.get("uji_vs_terbaik") or {}
        print(f"  {b['model']:16s} AUPRC {r['auprc']['mean']:.3f} ± {r['auprc']['sd']:.3f}  AUROC {r['auroc']['mean']:.4f}  F1 {r['f1']['mean']:.3f}  "
              f"precision@0.1% {r['presisi_top_0_1pct']['mean']:.3f}  fit {b['detik_latih']:.0f} s  wins {b['menang']}/{b['dari']}"
              + (f"  vs best: Δ {t['selisih_auprc']:+.3f}, p = {t['p']:.3f}" if t else "  (best)"))
    print(f"written {f}")


if __name__ == "__main__":
    main()
