"""Model Studio trainers and the models they produce.

A run publishes an MLflow model (open source): `StudioModel`, an mlflow.pyfunc.PythonModel saved with this file as its
code (code_paths), so the model loads anywhere with numpy, pandas and MLflow: `ModelInput` in transforms, live and batch
deployments, evaluation. Versions published before keep `ModelStudioAdapter` (the platform's adapter API).

Trainers fit several candidate models and keep the best on a validation split (or the test dataset), by the chosen
evaluation metric:
* regression: ridge linear regression, k-nearest neighbours, gradient-boosted trees (depth-limited regression trees);
* classification: logistic regression (softmax), k-nearest neighbours, gradient-boosted trees (binary);
* time series forecasting: per item, naive, seasonal naive, drift and Holt's exponential smoothing, chosen by a
  backtest over the last `prediction_length` points.
Numeric features are imputed with the training mean and standardized, categorical ones one-hot encoded with the
categories seen in training. AutoGluon's model zoo (LightGBM, CatBoost, XGBoost, FastAI, stacking) is not here.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd

try:  # the adapter API of versions published before MLflow; an MLflow model loads without it
    import palantir_models as pm
    from palantir_models.serializers import DillSerializer, JsonSerializer
except ImportError:  # pragma: no cover - loaded as an MLflow model's code
    pm = None
try:
    import mlflow
except ImportError:  # pragma: no cover - older versions load without MLflow
    mlflow = None


# ------------------------------------------------------------------------------------------------
# features
# ------------------------------------------------------------------------------------------------


class Encoder:
    def __init__(self, numeric: list[str], categorical: list[str]) -> None:
        self.numeric, self.categorical = numeric, categorical
        self.mean: dict[str, float] = {}
        self.std: dict[str, float] = {}
        self.cats: dict[str, list[str]] = {}

    def fit(self, df: pd.DataFrame) -> "Encoder":
        for c in self.numeric:
            v = pd.to_numeric(df[c], errors="coerce")
            self.mean[c] = float(v.mean()) if v.notna().any() else 0.0
            self.std[c] = float(v.std()) if v.notna().sum() > 1 and float(v.std()) > 0 else 1.0
        for c in self.categorical:
            self.cats[c] = [str(x) for x in df[c].astype(str).value_counts().index[:50]]
        return self

    def transform(self, df: pd.DataFrame) -> np.ndarray:
        cols = []
        for c in self.numeric:
            v = pd.to_numeric(df[c], errors="coerce") if c in df.columns else pd.Series([np.nan] * len(df))
            cols.append(((v.fillna(self.mean[c]) - self.mean[c]) / self.std[c]).to_numpy(dtype=float))
        for c in self.categorical:
            s = df[c].astype(str) if c in df.columns else pd.Series([""] * len(df))
            for k in self.cats[c]:
                cols.append((s == k).to_numpy(dtype=float))
        return np.column_stack(cols) if cols else np.zeros((len(df), 0))


# ------------------------------------------------------------------------------------------------
# models
# ------------------------------------------------------------------------------------------------


class Ridge:
    name = "LR"

    def __init__(self, alpha: float = 1.0) -> None:
        self.alpha = alpha

    def fit(self, X, y):
        Z = np.c_[np.ones(len(X)), X]
        reg = self.alpha * np.eye(Z.shape[1])
        reg[0, 0] = 0
        self.w = np.linalg.solve(Z.T @ Z + reg, Z.T @ y)
        return self

    def predict(self, X):
        return np.c_[np.ones(len(X)), X] @ self.w


class Softmax:
    name = "LR"

    def __init__(self, epochs: int = 400, lr: float = 0.5, l2: float = 1e-3) -> None:
        self.epochs, self.lr, self.l2 = epochs, lr, l2

    def fit(self, X, y):
        k = int(y.max()) + 1
        Z = np.c_[np.ones(len(X)), X]
        Y = np.eye(k)[y]
        self.W = np.zeros((Z.shape[1], k))
        for _ in range(self.epochs):
            P = self._p(Z)
            self.W -= self.lr * (Z.T @ (P - Y) / len(X) + self.l2 * self.W)
        return self

    def _p(self, Z):
        s = Z @ self.W
        s -= s.max(axis=1, keepdims=True)
        e = np.exp(s)
        return e / e.sum(axis=1, keepdims=True)

    def predict_proba(self, X):
        return self._p(np.c_[np.ones(len(X)), X])


class KNN:
    name = "KNN"

    def __init__(self, k: int = 7, classify: bool = False) -> None:
        self.k, self.classify = k, classify

    def fit(self, X, y):
        self.X, self.y = X, y
        if self.classify:
            self.n = int(y.max()) + 1
        return self

    def _nn(self, X):
        out = []
        for s in range(0, len(X), 512):
            d = ((X[s:s + 512, None, :] - self.X[None, :, :]) ** 2).sum(axis=2)
            out.append(np.argsort(d, axis=1)[:, : min(self.k, len(self.X))])
        return np.vstack(out) if out else np.zeros((0, self.k), dtype=int)

    def predict(self, X):
        return self.y[self._nn(X)].mean(axis=1)

    def predict_proba(self, X):
        idx = self._nn(X)
        return np.stack([(self.y[idx] == c).mean(axis=1) for c in range(self.n)], axis=1)


class _Tree:
    """A regression tree on gradients (depth-limited, quantile split candidates)."""

    def __init__(self, depth: int, min_leaf: int) -> None:
        self.depth, self.min_leaf = depth, min_leaf

    def fit(self, X, g):
        self.root = self._grow(X, g, np.arange(len(X)), self.depth)
        return self

    def _grow(self, X, g, idx, depth):
        if depth == 0 or len(idx) < 2 * self.min_leaf:
            return float(g[idx].mean()) if len(idx) else 0.0
        best = None
        total, n = g[idx].sum(), len(idx)
        for j in range(X.shape[1]):
            col = X[idx, j]
            for t in np.unique(np.quantile(col, [0.1, 0.25, 0.5, 0.75, 0.9])):
                left = col <= t
                nl = int(left.sum())
                if nl < self.min_leaf or n - nl < self.min_leaf:
                    continue
                sl = g[idx][left].sum()
                gain = sl * sl / nl + (total - sl) ** 2 / (n - nl)
                if best is None or gain > best[0]:
                    best = (gain, j, t, left)
        if best is None:
            return float(g[idx].mean())
        _, j, t, left = best
        return (j, float(t), self._grow(X, g, idx[left], depth - 1), self._grow(X, g, idx[~left], depth - 1))

    def predict(self, X):
        out = np.empty(len(X))
        for i, x in enumerate(X):
            node = self.root
            while isinstance(node, tuple):
                node = node[2] if x[node[0]] <= node[1] else node[3]
            out[i] = node
        return out


class GBM:
    name = "GBM"

    def __init__(self, rounds: int = 60, lr: float = 0.1, depth: int = 3, min_leaf: int = 5, classify: bool = False) -> None:
        self.rounds, self.lr, self.depth, self.min_leaf, self.classify = rounds, lr, depth, min_leaf, classify

    def fit(self, X, y):
        y = y.astype(float)
        self.base = float(np.log((y.mean() + 1e-6) / (1 - y.mean() + 1e-6))) if self.classify else float(y.mean())
        f = np.full(len(y), self.base)
        self.trees = []
        for _ in range(self.rounds):
            r = y - (1 / (1 + np.exp(-f)) if self.classify else f)
            t = _Tree(self.depth, self.min_leaf).fit(X, r)
            f += self.lr * t.predict(X)
            self.trees.append(t)
        return self

    def raw(self, X):
        f = np.full(len(X), self.base)
        for t in self.trees:
            f += self.lr * t.predict(X)
        return f

    def predict(self, X):
        return self.raw(X)

    def predict_proba(self, X):
        p = 1 / (1 + np.exp(-self.raw(X)))
        return np.c_[1 - p, p]


# ------------------------------------------------------------------------------------------------
# metrics
# ------------------------------------------------------------------------------------------------


def regression_score(metric: str, y, p) -> float:
    err = y - p
    if metric == "mean_absolute_error":
        return -float(np.abs(err).mean())
    if metric == "r2":
        ss = float(((y - y.mean()) ** 2).sum())
        return 1 - float((err ** 2).sum()) / ss if ss else 0.0
    return -math.sqrt(float((err ** 2).mean()))


def classification_score(metric: str, y, proba) -> float:
    pred = proba.argmax(axis=1)
    if metric == "log_loss":
        return -float(-np.log(np.clip(proba[np.arange(len(y)), y], 1e-12, 1)).mean())
    if metric == "f1" and proba.shape[1] == 2:
        tp = int(((pred == 1) & (y == 1)).sum())
        fp, fn = int(((pred == 1) & (y == 0)).sum()), int(((pred == 0) & (y == 1)).sum())
        return 2 * tp / (2 * tp + fp + fn) if tp else 0.0
    if metric == "roc_auc" and proba.shape[1] == 2:
        s, pos = proba[:, 1], y == 1
        npos, nneg = int(pos.sum()), int((~pos).sum())
        if npos and nneg:
            ranks = pd.Series(s).rank().to_numpy()
            return float((ranks[pos].sum() - npos * (npos + 1) / 2) / (npos * nneg))
        return 0.5
    if metric == "balanced_accuracy":
        return float(np.mean([(pred[y == c] == c).mean() for c in np.unique(y)]))
    return float((pred == y).mean())


# ------------------------------------------------------------------------------------------------
# the adapter
# ------------------------------------------------------------------------------------------------


def predict_frame(model: dict, config: dict, df_in: pd.DataFrame) -> pd.DataFrame:
    """A Model Studio model's inference: the input with the prediction (and class probabilities) added, or the
    forecast of every series."""
    c = config
    df = df_in.copy()
    if c["task"] == "time_series":
        return forecast_frame(model, df, c)
    X = model["encoder"].transform(df)
    m = model["model"]
    col = c["prediction_column"]
    if c["task"] == "regression":
        df[col] = m.predict(X)
        return df
    proba = m.predict_proba(X)
    classes = c["classes"]
    df[col] = [classes[i] for i in proba.argmax(axis=1)]
    if c.get("predict_probabilities"):
        for i, k in enumerate(classes):
            df[f"{col}_proba_{k}"] = proba[:, i]
    return df


if mlflow is not None:

    class StudioModel(mlflow.pyfunc.PythonModel):
        """A Model Studio model as an MLflow model: the fitted encoder and model, and the training configuration."""

        def __init__(self, model, config):
            self.model = model
            self.config = config

        def predict(self, context, model_input, params=None):
            return predict_frame(self.model, self.config, model_input)


if pm is not None:

    class ModelStudioAdapter(pm.ModelAdapter):
        """A Model Studio model published before MLflow: the fitted encoder and model, and the API recorded at training."""

        @pm.auto_serialize(model=DillSerializer(), config=JsonSerializer())
        def __init__(self, model, config):
            self.model = model
            self.config = config

        @classmethod
        def api(cls):
            # the trained version's API is recorded in its config; this is the general shape
            return {"df_in": pm.Pandas()}, {"df_out": pm.Pandas()}

        def predict(self, df_in):
            return predict_frame(self.model, self.config, df_in)


def api_of(config: dict) -> dict:
    """The API description recorded with the version (what model_lib.describe_api would give)."""
    t = {"float": "double", "int": "integer", "str": "string"}
    if config["task"] == "time_series":
        cols = [{"name": config["timestamp"], "type": "timestamp", "required": True}, {"name": config["target"], "type": "double", "required": True}]
        if config.get("item_id"):
            cols.insert(0, {"name": config["item_id"], "type": "string", "required": True})
        out = [{"name": config.get("item_id") or "item_id", "type": "string", "required": True}, {"name": config["timestamp"], "type": "timestamp", "required": True},
               {"name": config["prediction_column"], "type": "double", "required": True}]
        return {"inputs": [{"name": "df_in", "type": "tabular", "df_type": "pandas", "columns": cols}], "outputs": [{"name": "df_out", "type": "tabular", "df_type": "pandas", "columns": out}]}
    cols = [{"name": f, "type": t.get(config["feature_types"][f], "string"), "required": True} for f in config["features"]]
    out = [*cols, {"name": config["prediction_column"], "type": "double" if config["task"] == "regression" else "string", "required": True}]
    if config["task"] == "classification" and config.get("predict_probabilities"):
        out += [{"name": f"{config['prediction_column']}_proba_{k}", "type": "double", "required": True} for k in config["classes"]]
    return {"inputs": [{"name": "df_in", "type": "tabular", "df_type": "pandas", "columns": cols}], "outputs": [{"name": "df_out", "type": "tabular", "df_type": "pandas", "columns": out}]}


# ------------------------------------------------------------------------------------------------
# training
# ------------------------------------------------------------------------------------------------


def _split(n: int, seed: int = 0, frac: float = 0.2):
    r = np.random.default_rng(seed)
    idx = r.permutation(n)
    k = max(1, int(round(n * frac)))
    return idx[k:], idx[:k]


CANDIDATES = {
    "regression": {"LR": lambda h: Ridge(h.get("alpha", 1.0)), "KNN": lambda h: KNN(h.get("k", 7)),
                   "GBM": lambda h: GBM(h.get("rounds", 60), h.get("learning_rate", 0.1), h.get("depth", 3))},
    "classification": {"LR": lambda h: Softmax(h.get("epochs", 400), h.get("learning_rate", 0.5)), "KNN": lambda h: KNN(h.get("k", 7), classify=True),
                       "GBM": lambda h: GBM(h.get("rounds", 60), h.get("learning_rate", 0.1), h.get("depth", 3), classify=True)},
}


def train_tabular(task: str, df: pd.DataFrame, target: str, features: list[str], params: dict, test: Optional[pd.DataFrame], log) -> tuple[dict, dict, dict]:
    """(model {encoder, model}, config, report {leaderboard, metrics})."""
    df = df[df[target].notna()].reset_index(drop=True)
    if len(df) < 10:
        raise ValueError(f"only {len(df)} training rows with a {target} value: at least 10 are needed")
    numeric = [f for f in features if pd.api.types.is_numeric_dtype(df[f]) and not pd.api.types.is_bool_dtype(df[f])]
    categorical = [f for f in features if f not in numeric]
    enc = Encoder(numeric, categorical).fit(df)
    metric = params.get("eval_metric") or ("root_mean_squared_error" if task == "regression" else "accuracy")
    if test is not None and len(test):
        tr, va = df, test[test[target].notna()].reset_index(drop=True)
    else:
        a, b = _split(len(df))
        tr, va = df.iloc[a].reset_index(drop=True), df.iloc[b].reset_index(drop=True)
    Xtr, Xva = enc.transform(tr), enc.transform(va)
    classes = None
    if task == "regression":
        ytr, yva = pd.to_numeric(tr[target], errors="coerce").to_numpy(float), pd.to_numeric(va[target], errors="coerce").to_numpy(float)
    else:
        classes = sorted({str(x) for x in df[target]})
        if len(classes) < 2:
            raise ValueError(f"{target} has a single class: classification needs at least two")
        pos = {k: i for i, k in enumerate(classes)}
        ytr = np.array([pos[str(x)] for x in tr[target]])
        yva = np.array([pos.get(str(x), -1) for x in va[target]])
        keep = yva >= 0
        Xva, yva = Xva[keep], yva[keep]
    # the candidates: the algorithm templates the configuration picked (ml_algorithms.py: scikit-learn, XGBoost, each
    # with its settings), else the built-in models (LR / KNN / GBM, with optional hyperparameters)
    cands: list[tuple[str, object, str]] = []
    algos = params.get("algorithms") or []
    if algos:
        import ml_algorithms

        for a in algos[:12]:
            key, ap = a.get("algorithm"), a.get("params") or {}
            ml_algorithms.settings(task, key, ap)  # every value checked before anything trains
            cands.append((a.get("label") or ml_algorithms.label(key, ap, task), lambda key=key, ap=ap: ml_algorithms.build(task, key, ap), str(ap or "default")))
    else:
        hyper = params.get("hyperparameters") or {}
        names = [k for k in CANDIDATES[task] if k not in (params.get("excluded_model_types") or []) and (not hyper or k in hyper)]
        if task == "classification" and classes and len(classes) > 2:
            names = [k for k in names if k != "GBM"]
        if not names:
            raise ValueError("No models trained: every model type was excluded (clear the excluded model types or the hyperparameters)")
        for name in names:
            hs = hyper.get(name) or [{}]
            hs = hs if isinstance(hs, list) else [hs]
            for i, h in enumerate(hs):
                cands.append((name + (f"_{i + 1}" if len(hs) > 1 else ""), lambda name=name, h=h: CANDIDATES[task][name](h), str(h or "default")))
    seen: dict[str, int] = {}
    board = []
    best = None
    outs: dict[str, object] = {}
    for label, factory, settings in cands:
        seen[label] = seen.get(label, 0) + 1
        if seen[label] > 1:
            label = f"{label} #{seen[label]}"
        m = factory().fit(Xtr, ytr)
        out = m.predict(Xva) if task == "regression" else m.predict_proba(Xva)
        score = regression_score(metric, yva, out) if task == "regression" else classification_score(metric, yva, out)
        board.append({"model": label, "score_val": round(score, 6), "eval_metric": metric, "hyperparameters": settings})
        outs[label] = out
        log(f"trained {label}: {metric} {abs(score) if metric in ('root_mean_squared_error', 'mean_absolute_error', 'log_loss') else score:.4f}")
        if best is None or score > best[0]:
            best = (score, label, factory)
            val_out = out
    # refit the best on all training data (with the validation rows when they came from the split)
    full = pd.concat([tr, va]) if test is None else tr
    Xf = enc.transform(full)
    yf = pd.to_numeric(full[target], errors="coerce").to_numpy(float) if task == "regression" else np.array([classes.index(str(x)) for x in full[target]])
    final = best[2]().fit(Xf, yf)
    board.sort(key=lambda r: -r["score_val"])
    for i, r in enumerate(board):
        r["rank"] = i + 1
    config = {"task": task, "target": target, "features": features, "feature_types": {f: ("float" if f in numeric else "str") for f in features},
              "prediction_column": params.get("prediction_column") or target, "classes": classes, "predict_probabilities": bool(params.get("predict_probabilities")),
              "best_model": best[1], "eval_metric": metric}
    return {"encoder": enc, "model": final}, config, {"leaderboard": board, "best": best[1], "score": best[0], "validation_rows": int(len(Xva)),
                                                       "validation": {"y": yva, "out": val_out, "by_model": outs}}


def _forecasters(y: np.ndarray, h: int, season: int) -> dict[str, np.ndarray]:
    out = {"naive": np.full(h, y[-1])}
    if season > 1 and len(y) >= season:
        out["seasonal_naive"] = np.array([y[len(y) - season + (i % season)] for i in range(h)])
    if len(y) > 1:
        slope = (y[-1] - y[0]) / (len(y) - 1)
        out["drift"] = y[-1] + slope * np.arange(1, h + 1)
    if len(y) > 2:
        a, b = 0.5, 0.2
        lvl, tr = y[0], y[1] - y[0]
        for v in y[1:]:
            prev = lvl
            lvl = a * v + (1 - a) * (lvl + tr)
            tr = b * (lvl - prev) + (1 - b) * tr
        out["holt"] = lvl + tr * np.arange(1, h + 1)
    return out


def train_time_series(df: pd.DataFrame, target: str, timestamp: str, item_id: Optional[str], params: dict, log) -> tuple[dict, dict, dict]:
    h = int(params.get("prediction_length") or 7)
    season = int(params.get("seasonal_period") or 7)
    d = df[[c for c in (item_id, timestamp, target) if c]].dropna().copy()
    d[timestamp] = pd.to_datetime(d[timestamp])
    d = d.sort_values([c for c in (item_id, timestamp) if c])
    groups = d.groupby(item_id) if item_id else [("all", d)]
    errs: dict[str, list[float]] = {}
    freq = params.get("frequency") or None
    for _, g in groups:
        y = g[target].to_numpy(float)
        if len(y) <= h + 1:
            continue
        fc = _forecasters(y[:-h], h, season)
        for k, f in fc.items():
            errs.setdefault(k, []).append(float(np.abs(y[-h:] - f).mean()))
        if not freq:
            freq = pd.infer_freq(g[timestamp].iloc[-min(len(g), 20):]) if len(g) >= 3 else None
    if not errs:
        raise ValueError(f"no series is longer than prediction_length + 1 ({h + 1}) points")
    if not freq:
        raise ValueError("Frequency of train data is not provided and cannot be inferred: set the frequency parameter (D, W, M, H…)")
    board = sorted(({"model": k, "score_val": -round(float(np.mean(v)), 6), "eval_metric": "mean_absolute_error", "series": len(v)} for k, v in errs.items()),
                   key=lambda r: -r["score_val"])
    for i, r in enumerate(board):
        r["rank"] = i + 1
        log(f"backtest {r['model']}: MAE {-r['score_val']:.4f} over {r['series']} series")
    config = {"task": "time_series", "target": target, "timestamp": timestamp, "item_id": item_id, "prediction_length": h, "seasonal_period": season,
              "frequency": freq, "method": board[0]["model"], "prediction_column": params.get("prediction_column") or "forecast", "features": [], "feature_types": {}}
    return {"method": board[0]["model"]}, config, {"leaderboard": board, "best": board[0]["model"], "score": board[0]["score_val"]}


def forecast_frame(model: dict, df: pd.DataFrame, c: dict) -> pd.DataFrame:
    """The next prediction_length points of every series in df (its history)."""
    ts, item = c["timestamp"], c.get("item_id")
    d = df.copy()
    d[ts] = pd.to_datetime(d[ts])
    rows = []
    for key, g in (d.sort_values(ts).groupby(item) if item else [("all", d.sort_values(ts))]):
        y = pd.to_numeric(g[c["target"]], errors="coerce").dropna().to_numpy(float)
        if not len(y):
            continue
        fc = _forecasters(y, c["prediction_length"], c["seasonal_period"])
        f = fc.get(model["method"], fc["naive"])
        future = pd.date_range(g[ts].iloc[-1], periods=c["prediction_length"] + 1, freq=c["frequency"])[1:]
        rows += [{item or "item_id": key, ts: t.isoformat(), c["prediction_column"]: float(v)} for t, v in zip(future, f)]
    return pd.DataFrame(rows)
