"""The algorithm templates of Model Studio: popular open-source estimators (scikit-learn, XGBoost) with their main
hyperparameters as typed settings — a default, a range, what it does — so a configuration picks algorithms and sets
their constants instead of writing code. Each picked algorithm (and each variant of its settings) is a candidate of a
training run: all are scored on the same validation rows, the best is published, every one gets its evaluation charts.

catalog(task) is what the UI (and AIP Assist) read; build(task, key, params) makes the estimator, checking each value.
The features reach the estimator encoded by Model Studio (numeric standardized, categorical one-hot), so scale-
sensitive algorithms (SVM, ANN, KNN, logistic regression) work as they are.
"""

from __future__ import annotations

from typing import Any, Optional

# kind: int | float | select | layers (comma-separated layer sizes) | bool; tasks limits a setting to a task;
# options_by_task gives a select's options per task; optional: empty means the library's default (None)
ALGORITHMS: dict[str, dict[str, Any]] = {
    "random_forest": {
        "name": "Random Forest", "tasks": ["classification", "regression"], "library": "scikit-learn",
        "description": "Many decision trees on random samples of rows and features, averaged. Robust, little tuning, handles non-linear effects.",
        "params": [
            {"key": "n_estimators", "label": "Trees", "kind": "int", "default": 200, "min": 10, "max": 2000, "help": "More trees: steadier, slower."},
            {"key": "max_depth", "label": "Max depth", "kind": "int", "default": None, "min": 1, "max": 100, "optional": True, "help": "Empty: grow until leaves are pure."},
            {"key": "min_samples_leaf", "label": "Min rows per leaf", "kind": "int", "default": 1, "min": 1, "max": 1000, "help": "Higher: smoother, less overfitting."},
            {"key": "max_features", "label": "Features per split", "kind": "select", "default": "sqrt", "options": ["sqrt", "log2", "all"]},
            {"key": "class_weight", "label": "Class weight", "kind": "select", "default": "none", "options": ["none", "balanced"], "tasks": ["classification"],
             "help": "balanced: rare classes count more (imbalanced labels)."},
        ],
    },
    "decision_tree": {
        "name": "Decision Tree", "tasks": ["classification", "regression"], "library": "scikit-learn",
        "description": "One tree of if/then splits: easy to explain, prone to overfitting without a depth limit.",
        "params": [
            {"key": "max_depth", "label": "Max depth", "kind": "int", "default": 5, "min": 1, "max": 100, "optional": True},
            {"key": "min_samples_leaf", "label": "Min rows per leaf", "kind": "int", "default": 5, "min": 1, "max": 1000},
            {"key": "criterion", "label": "Split criterion", "kind": "select", "default": None,
             "options_by_task": {"classification": ["gini", "entropy", "log_loss"], "regression": ["squared_error", "absolute_error", "friedman_mse"]}},
            {"key": "class_weight", "label": "Class weight", "kind": "select", "default": "none", "options": ["none", "balanced"], "tasks": ["classification"]},
        ],
    },
    "ann": {
        "name": "Neural network (ANN / MLP)", "tasks": ["classification", "regression"], "library": "scikit-learn",
        "description": "A multi-layer perceptron: fully connected hidden layers trained with Adam. Learns complex patterns; needs more rows and tuning.",
        "params": [
            {"key": "hidden_layers", "label": "Hidden layers", "kind": "layers", "default": "64,32", "help": "Neurons per layer, comma-separated: 64,32 = two layers."},
            {"key": "activation", "label": "Activation", "kind": "select", "default": "relu", "options": ["relu", "tanh", "logistic"]},
            {"key": "alpha", "label": "L2 regularization", "kind": "float", "default": 0.0001, "min": 0, "max": 10},
            {"key": "learning_rate_init", "label": "Learning rate", "kind": "float", "default": 0.001, "min": 0.00001, "max": 1},
            {"key": "max_iter", "label": "Max epochs", "kind": "int", "default": 300, "min": 10, "max": 5000},
            {"key": "early_stopping", "label": "Early stopping", "kind": "bool", "default": True, "help": "Stop when a held-out 10 % stops improving."},
        ],
    },
    "svm": {
        "name": "Support Vector Machine (SVM)", "tasks": ["classification", "regression"], "library": "scikit-learn",
        "description": "A maximum-margin boundary, non-linear with a kernel. Strong on small and medium data; slow beyond ~20,000 rows.",
        "params": [
            {"key": "C", "label": "C (regularization)", "kind": "float", "default": 1.0, "min": 0.0001, "max": 10000, "help": "Higher: fits the training rows more closely."},
            {"key": "kernel", "label": "Kernel", "kind": "select", "default": "rbf", "options": ["rbf", "linear", "poly", "sigmoid"]},
            {"key": "gamma", "label": "Gamma", "kind": "select", "default": "scale", "options": ["scale", "auto"]},
            {"key": "epsilon", "label": "Epsilon", "kind": "float", "default": 0.1, "min": 0, "max": 100, "tasks": ["regression"], "help": "Errors smaller than this are ignored."},
            {"key": "class_weight", "label": "Class weight", "kind": "select", "default": "none", "options": ["none", "balanced"], "tasks": ["classification"]},
        ],
    },
    "logistic_regression": {
        "name": "Logistic regression", "tasks": ["classification"], "library": "scikit-learn",
        "description": "A linear model of the log-odds: a fast, explainable baseline.",
        "params": [
            {"key": "C", "label": "C (inverse regularization)", "kind": "float", "default": 1.0, "min": 0.0001, "max": 10000},
            {"key": "class_weight", "label": "Class weight", "kind": "select", "default": "none", "options": ["none", "balanced"]},
            {"key": "max_iter", "label": "Max iterations", "kind": "int", "default": 1000, "min": 50, "max": 10000},
        ],
    },
    "linear_regression": {
        "name": "Linear regression (Ridge)", "tasks": ["regression"], "library": "scikit-learn",
        "description": "A linear model with L2 regularization: a fast, explainable baseline.",
        "params": [{"key": "alpha", "label": "Alpha (regularization)", "kind": "float", "default": 1.0, "min": 0, "max": 10000}],
    },
    "gradient_boosting": {
        "name": "Gradient Boosting", "tasks": ["classification", "regression"], "library": "scikit-learn",
        "description": "Shallow trees added one after another, each correcting the previous ones. Often the most accurate on tables.",
        "params": [
            {"key": "n_estimators", "label": "Trees", "kind": "int", "default": 200, "min": 10, "max": 5000},
            {"key": "learning_rate", "label": "Learning rate", "kind": "float", "default": 0.05, "min": 0.001, "max": 1},
            {"key": "max_depth", "label": "Max depth", "kind": "int", "default": 3, "min": 1, "max": 20},
            {"key": "subsample", "label": "Row sample per tree", "kind": "float", "default": 1.0, "min": 0.1, "max": 1},
        ],
    },
    "hist_gradient_boosting": {
        "name": "Histogram Gradient Boosting", "tasks": ["classification", "regression"], "library": "scikit-learn",
        "description": "LightGBM-style boosting on binned features: fast on large tables.",
        "params": [
            {"key": "max_iter", "label": "Boosting rounds", "kind": "int", "default": 200, "min": 10, "max": 5000},
            {"key": "learning_rate", "label": "Learning rate", "kind": "float", "default": 0.1, "min": 0.001, "max": 1},
            {"key": "max_leaf_nodes", "label": "Leaves per tree", "kind": "int", "default": 31, "min": 2, "max": 1024},
            {"key": "l2_regularization", "label": "L2 regularization", "kind": "float", "default": 0.0, "min": 0, "max": 100},
        ],
    },
    "xgboost": {
        "name": "XGBoost", "tasks": ["classification", "regression"], "library": "xgboost",
        "description": "Regularized gradient boosting, a competition favourite on tabular data.",
        "params": [
            {"key": "n_estimators", "label": "Trees", "kind": "int", "default": 300, "min": 10, "max": 5000},
            {"key": "max_depth", "label": "Max depth", "kind": "int", "default": 6, "min": 1, "max": 20},
            {"key": "learning_rate", "label": "Learning rate", "kind": "float", "default": 0.1, "min": 0.001, "max": 1},
            {"key": "subsample", "label": "Row sample per tree", "kind": "float", "default": 0.9, "min": 0.1, "max": 1},
            {"key": "colsample_bytree", "label": "Feature sample per tree", "kind": "float", "default": 0.9, "min": 0.1, "max": 1},
        ],
    },
    "knn": {
        "name": "k-Nearest Neighbours", "tasks": ["classification", "regression"], "library": "scikit-learn",
        "description": "Predicts from the k most similar training rows. No training; slow to predict on large data.",
        "params": [
            {"key": "n_neighbors", "label": "k (neighbours)", "kind": "int", "default": 7, "min": 1, "max": 500},
            {"key": "weights", "label": "Weights", "kind": "select", "default": "uniform", "options": ["uniform", "distance"]},
        ],
    },
    "naive_bayes": {
        "name": "Naive Bayes (Gaussian)", "tasks": ["classification"], "library": "scikit-learn",
        "description": "Assumes independent, normally distributed features: very fast, a sanity-check baseline.",
        "params": [{"key": "var_smoothing", "label": "Variance smoothing", "kind": "float", "default": 1e-9, "min": 0, "max": 1}],
    },
}


def _params_for(task: str, spec: dict) -> list[dict]:
    out = []
    for p in spec["params"]:
        if p.get("tasks") and task not in p["tasks"]:
            continue
        q = {k: v for k, v in p.items() if k != "options_by_task"}
        if p.get("options_by_task"):
            q["options"] = p["options_by_task"][task]
            q["default"] = q["options"][0] if q.get("default") is None else q["default"]
        out.append(q)
    return out


def catalog(task: str) -> list[dict]:
    """The algorithms a task can use, with their settings (for the UI and AIP Assist)."""
    return [{"key": k, "name": a["name"], "description": a["description"], "library": a["library"], "params": _params_for(task, a)}
            for k, a in ALGORITHMS.items() if task in a["tasks"]]


def _value(p: dict, v: Any) -> Any:
    """A setting's value checked against its spec (None / "" → its default)."""
    name = p.get("label") or p["key"]
    if v is None or v == "":
        return p.get("default")
    kind = p["kind"]
    if kind == "bool":
        return v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
    if kind == "select":
        if str(v) not in p["options"]:
            raise ValueError(f"{name} is one of {', '.join(p['options'])}, not {v!r}")
        return str(v)
    if kind == "layers":
        try:
            sizes = tuple(int(x) for x in str(v).replace(" ", "").split(",") if x)
        except ValueError:
            raise ValueError(f"{name}: neurons per layer, comma-separated (e.g. 64,32), not {v!r}") from None
        if not sizes or any(s < 1 or s > 4096 for s in sizes) or len(sizes) > 10:
            raise ValueError(f"{name}: 1 to 10 layers of 1 to 4096 neurons")
        return sizes
    try:
        num = int(v) if kind == "int" else float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be {'a whole number' if kind == 'int' else 'a number'}, not {v!r}") from None
    if kind == "int" and float(v) != num:
        raise ValueError(f"{name} must be a whole number, not {v!r}")
    lo, hi = p.get("min"), p.get("max")
    if (lo is not None and num < lo) or (hi is not None and num > hi):
        raise ValueError(f"{name} is between {lo} and {hi}, not {v}")
    return num


def settings(task: str, key: str, params: Optional[dict]) -> dict:
    """The full settings of a candidate: every value checked, the defaults filled in."""
    if key not in ALGORITHMS:
        raise ValueError(f"unknown algorithm {key!r}: one of {', '.join(ALGORITHMS)}")
    spec = ALGORITHMS[key]
    if task not in spec["tasks"]:
        raise ValueError(f"{spec['name']} does not do {task}")
    given = dict(params or {})
    known = {p["key"] for p in _params_for(task, spec)}
    unknown = [k for k in given if k not in known]
    if unknown:
        raise ValueError(f"{spec['name']} has no setting {', '.join(unknown)} (it has {', '.join(sorted(known))})")
    return {p["key"]: _value(p, given.get(p["key"])) for p in _params_for(task, spec)}


def build(task: str, key: str, params: Optional[dict], seed: int = 0):
    """The estimator of a candidate, with fit / predict (and predict_proba for classification)."""
    s = settings(task, key, params)
    cls = task == "classification"
    cw = {"class_weight": None if s.get("class_weight") in (None, "none") else s["class_weight"]} if "class_weight" in s else {}
    if key == "random_forest":
        from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor

        kw = {"n_estimators": s["n_estimators"], "max_depth": s["max_depth"], "min_samples_leaf": s["min_samples_leaf"],
              "max_features": None if s["max_features"] == "all" else s["max_features"], "random_state": seed, "n_jobs": -1}
        return RandomForestClassifier(**kw, **cw) if cls else RandomForestRegressor(**kw)
    if key == "decision_tree":
        from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

        kw = {"max_depth": s["max_depth"], "min_samples_leaf": s["min_samples_leaf"], "criterion": s["criterion"], "random_state": seed}
        return DecisionTreeClassifier(**kw, **cw) if cls else DecisionTreeRegressor(**kw)
    if key == "ann":
        from sklearn.neural_network import MLPClassifier, MLPRegressor

        kw = {"hidden_layer_sizes": s["hidden_layers"], "activation": s["activation"], "alpha": s["alpha"], "learning_rate_init": s["learning_rate_init"],
              "max_iter": s["max_iter"], "early_stopping": s["early_stopping"], "random_state": seed}
        return MLPClassifier(**kw) if cls else MLPRegressor(**kw)
    if key == "svm":
        from sklearn.svm import SVC, SVR

        if cls:
            return SVC(C=s["C"], kernel=s["kernel"], gamma=s["gamma"], probability=True, random_state=seed, **cw)
        return SVR(C=s["C"], kernel=s["kernel"], gamma=s["gamma"], epsilon=s["epsilon"])
    if key == "logistic_regression":
        from sklearn.linear_model import LogisticRegression

        return LogisticRegression(C=s["C"], max_iter=s["max_iter"], **cw)
    if key == "linear_regression":
        from sklearn.linear_model import Ridge

        return Ridge(alpha=s["alpha"])
    if key == "gradient_boosting":
        from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor

        kw = {"n_estimators": s["n_estimators"], "learning_rate": s["learning_rate"], "max_depth": s["max_depth"], "subsample": s["subsample"], "random_state": seed}
        return GradientBoostingClassifier(**kw) if cls else GradientBoostingRegressor(**kw)
    if key == "hist_gradient_boosting":
        from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

        kw = {"max_iter": s["max_iter"], "learning_rate": s["learning_rate"], "max_leaf_nodes": s["max_leaf_nodes"], "l2_regularization": s["l2_regularization"],
              "random_state": seed}
        return HistGradientBoostingClassifier(**kw) if cls else HistGradientBoostingRegressor(**kw)
    if key == "xgboost":
        from xgboost import XGBClassifier, XGBRegressor

        kw = {"n_estimators": s["n_estimators"], "max_depth": s["max_depth"], "learning_rate": s["learning_rate"], "subsample": s["subsample"],
              "colsample_bytree": s["colsample_bytree"], "random_state": seed, "n_jobs": -1}
        return XGBClassifier(**kw) if cls else XGBRegressor(**kw)
    if key == "knn":
        from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor

        kw = {"n_neighbors": s["n_neighbors"], "weights": s["weights"]}
        return KNeighborsClassifier(**kw) if cls else KNeighborsRegressor(**kw)
    if key == "naive_bayes":
        from sklearn.naive_bayes import GaussianNB

        return GaussianNB(var_smoothing=s["var_smoothing"])
    raise ValueError(f"unknown algorithm {key!r}")


def label(key: str, params: Optional[dict], task: str) -> str:
    """A candidate's name on the leaderboard: the algorithm and the settings that differ from the defaults."""
    spec = ALGORITHMS.get(key, {"name": key, "params": []})
    defaults = {p["key"]: p.get("default") for p in _params_for(task, spec)} if key in ALGORITHMS else {}
    diff = [f"{k}={v}" for k, v in (params or {}).items() if v not in (None, "") and str(v) != str(defaults.get(k))]
    return spec["name"] + (f" ({', '.join(diff)})" if diff else "")
