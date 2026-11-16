"""Structured model evaluations the app draws (web/src/components/models/EvalCharts.tsx): the same documents a training
run logs with ml_models/evaluasi.py (`<name>/evaluation.json` in the MLflow run), made here for the platform's own
trainers (Model Studio). numpy only.

* binary_classification: metrics (accuracy, precision, recall, F1, MCC, ROC AUC, PR AUC), confusion counts, ROC and
  precision-recall curves, calibration, score histograms per class.
* regression: metrics (RMSE, MAE, R², MAPE), predicted-vs-actual points (sampled), residual histogram.
"""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np


def _thin(xs: np.ndarray, ys: np.ndarray, n: int = 200) -> tuple[list[float], list[float]]:
    if len(xs) > n:
        idx = np.unique(np.linspace(0, len(xs) - 1, n).round().astype(int))
        xs, ys = xs[idx], ys[idx]
    return [round(float(v), 4) for v in xs], [round(float(v), 4) for v in ys]


def _auc(x: np.ndarray, y: np.ndarray) -> float:
    return float(np.trapezoid(y, x)) if hasattr(np, "trapezoid") else float(np.trapz(y, x))


def binary_classification(y_true: Sequence[int], score: Sequence[float], threshold: float = 0.5, name: str = "validation",
                          labels: Sequence[str] = ("0", "1")) -> dict:
    y = np.asarray(y_true, dtype=int)
    p = np.asarray(score, dtype=float)
    pred = (p >= threshold).astype(int)
    tp, tn = int(((pred == 1) & (y == 1)).sum()), int(((pred == 0) & (y == 0)).sum())
    fp, fn = int(((pred == 1) & (y == 0)).sum()), int(((pred == 0) & (y == 1)).sum())
    n = max(1, len(y))
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    denom = float(np.sqrt(float(tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)))
    metrics = {"accuracy": (tp + tn) / n, "precision": prec, "recall": rec, "f1": 2 * prec * rec / (prec + rec) if prec + rec else 0.0,
               "mcc": (tp * tn - fp * fn) / denom if denom else 0.0}
    doc: dict = {"type": "binary_classification", "name": name, "labels": [str(labels[0]), str(labels[1])], "threshold": float(threshold), "rows": int(len(y)),
                 "prevalence": float(y.mean()) if len(y) else 0.0, "confusion": {"tn": tn, "fp": fp, "fn": fn, "tp": tp}}
    pos, neg = int((y == 1).sum()), int((y == 0).sum())
    if pos and neg:
        order = np.argsort(-p, kind="mergesort")
        ys, ps = y[order], p[order]
        cut = np.r_[np.flatnonzero(np.diff(ps)), len(ps) - 1]  # the last index of each distinct score
        ctp, cfp = np.cumsum(ys)[cut], np.cumsum(1 - ys)[cut]
        tpr, fpr = np.r_[0, ctp / pos], np.r_[0, cfp / neg]
        metrics["roc_auc"] = _auc(fpr, tpr)
        precision, recall = ctp / (ctp + cfp), ctp / pos
        metrics["pr_auc"] = float(np.sum(np.diff(np.r_[0, recall]) * precision))
        doc["roc"] = dict(zip(("x", "y"), _thin(fpr, tpr)))
        doc["pr"] = dict(zip(("x", "y"), _thin(np.r_[0, recall], np.r_[precision[0], precision])))
        qs = np.quantile(p, np.linspace(0, 1, 11))
        bins = np.clip(np.searchsorted(qs[1:-1], p, side="right"), 0, 9)
        mx, my = [], []
        for b in range(10):
            m = bins == b
            if m.any():
                mx.append(float(p[m].mean()))
                my.append(float(y[m].mean()))
        doc["calibration"] = {"x": [round(v, 4) for v in mx], "y": [round(v, 4) for v in my]}
    edges = np.linspace(min(float(p.min()), threshold), max(float(p.max()), threshold), 31) if len(p) else np.linspace(0, 1, 31)
    doc["scores"] = {"edges": [round(float(v), 4) for v in edges], "negative": np.histogram(p[y == 0], edges)[0].tolist(),
                     "positive": np.histogram(p[y == 1], edges)[0].tolist()}
    doc["metrics"] = {k: float(v) for k, v in metrics.items()}
    return doc


def regression(y_true: Sequence[float], y_pred: Sequence[float], name: str = "validation", max_points: int = 400, seed: int = 0) -> dict:
    y = np.asarray(y_true, dtype=float)
    p = np.asarray(y_pred, dtype=float)
    ok = ~(np.isnan(y) | np.isnan(p))
    y, p = y[ok], p[ok]
    res = p - y
    metrics = {"rmse": float(np.sqrt(np.mean(res ** 2))) if len(y) else 0.0, "mae": float(np.mean(np.abs(res))) if len(y) else 0.0}
    ss = float(np.sum((y - y.mean()) ** 2)) if len(y) else 0.0
    if ss:
        metrics["r2"] = 1 - float(np.sum(res ** 2)) / ss
    nz = y != 0
    if nz.any():
        metrics["mape"] = float(np.mean(np.abs(res[nz] / y[nz])))
    idx = np.random.default_rng(seed).permutation(len(y))[:max_points] if len(y) > max_points else np.arange(len(y))
    edges = np.linspace(float(res.min()), float(res.max()), 31) if len(res) and res.min() < res.max() else np.linspace(-1, 1, 31)
    return {"type": "regression", "name": name, "rows": int(len(y)), "metrics": metrics,
            "scatter": {"x": [round(float(v), 4) for v in y[idx]], "y": [round(float(v), 4) for v in p[idx]]},
            "residuals": {"edges": [round(float(v), 4) for v in edges], "counts": np.histogram(res, edges)[0].tolist()}}


def for_studio(task: str, y_val: np.ndarray, out: np.ndarray, classes: Optional[list] = None) -> Optional[dict]:
    """Model Studio's validation predictions as an evaluation: binary classification (out = class probabilities, the
    second class positive) or regression (out = predictions). Multiclass and forecasting have none (yet)."""
    if task == "regression":
        return regression(y_val, out)
    if task == "classification" and classes and len(classes) == 2:
        return binary_classification(y_val, np.asarray(out)[:, 1], 0.5, "validation", (str(classes[0]), str(classes[1])))
    return None
