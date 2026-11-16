"""Code Repositories templates for models.

* Model Training (MLflow, open source): a transforms repository with an `ml_models` package (an
  mlflow.pyfunc.PythonModel) and a `model_training` package (a training transform logging an MLflow run and
  publishing the model to a ModelOutput, an inference transform using a ModelInput, an evaluation transform writing
  RMSE / MAE). Runs as is on the sample dataset: the model fits a least squares linear model on its numeric columns.
* Model Adapter Library: a Python library repository with example adapters for an externally hosted model and a
  container model; tag a version to publish it, other repositories add it to their meta.yaml.
"""

from __future__ import annotations

import code_py_templates as t

ADAPTER = """import mlflow
import numpy as np


class LinearModel(mlflow.pyfunc.PythonModel):
    \"\"\"Least squares on the numeric feature columns: an MLflow PythonModel (replace it with your own model, or
    publish a scikit-learn estimator directly). MLflow saves it with this package, so it loads anywhere.\"\"\"

    def __init__(self, features, prediction_column="prediction"):
        self.features = list(features)
        self.prediction_column = prediction_column
        self.w = None

    def _matrix(self, df):
        if "row_number" in self.features and "row_number" not in df.columns:
            df = df.assign(row_number=range(len(df)))
        X = df[self.features].fillna(0).to_numpy(dtype=float)
        return df, np.c_[np.ones(len(X)), X]

    def fit(self, df, y):
        _, Z = self._matrix(df)
        self.w, *_ = np.linalg.lstsq(Z, np.asarray(y, dtype=float), rcond=None)
        return self

    def predict(self, context, model_input, params=None):
        df, Z = self._matrix(model_input.copy())
        df[self.prediction_column] = Z @ self.w
        return df
"""

TRAINING = """import mlflow
from transforms.api import transform, Input, ModelOutput

from ml_models.evaluasi import log_regresi
from ml_models.linear_model import LinearModel


@transform.using(
    training_data=Input("{input}"),
    # the model is created next to the repository's outputs; use a path such as "/Project/models/example_model"
    model_output=ModelOutput("example_model"),
)
def train_model(training_data, model_output):
    df = training_data.pandas()
    numeric = [c for c in df.columns if df[c].dtype.kind in "if"]
    if not numeric:
        raise ValueError("the example needs a numeric column to predict (the last numeric column is the target)")
    # the other numeric columns are the features (the row number when there are none)
    target = numeric[-1]
    features = numeric[:-1]
    if not features:
        df["row_number"] = range(len(df))
        features = ["row_number"]
    # hold out 20 % of the rows to evaluate on
    test = df.sample(frac=0.2, random_state=0)
    train = df.drop(test.index)
    # an MLflow run: its parameters, metrics and evaluation become the model version's experiment (charts on the
    # model's page)
    with mlflow.start_run(run_name="linear-baseline"):
        mlflow.log_params({{"features": ", ".join(features), "target": target, "train_rows": len(train), "test_rows": len(test)}})
        model = LinearModel(features).fit(train, train[target].fillna(0))
        log_regresi(test[target].fillna(0), model.predict(None, test)["prediction"], "holdout")
        # saved in the MLflow format; the input example gives the version its input columns
        model_output.publish(model, input_example=df[features].head(5))
"""

BENCHMARK = """import mlflow
from sklearn.ensemble import RandomForestRegressor
from transforms.api import transform, Input, ModelOutput

from ml_models.evaluasi import log_regresi


@transform.using(
    training_data=Input("{input}"),
    # a second candidate: submit both models to a Modeling Objective to compare them (its Comparisons tab)
    model_output=ModelOutput("example_model_random_forest"),
)
def train_random_forest(training_data, model_output):
    df = training_data.pandas()
    numeric = [c for c in df.columns if df[c].dtype.kind in "if"]
    target, features = numeric[-1], numeric[:-1]
    if not features:
        df["row_number"] = range(len(df))
        features = ["row_number"]
    test = df.sample(frac=0.2, random_state=0)
    train = df.drop(test.index)
    with mlflow.start_run(run_name="random-forest"):
        mlflow.log_params({{"model": "RandomForestRegressor", "n_estimators": 200, "features": ", ".join(features), "target": target}})
        model = RandomForestRegressor(n_estimators=200, random_state=0).fit(train[features].fillna(0), train[target].fillna(0))
        log_regresi(test[target].fillna(0), model.predict(test[features].fillna(0)), "holdout")
        # a scikit-learn estimator is published as an MLflow model as it is
        model_output.publish(model, input_example=df[features].head(5).fillna(0))
"""

EVALUASI = '''"""Model evaluation for the training run: scikit-learn metrics and curves logged to the active MLflow run as a
structured evaluation (`<name>/evaluation.json`) the platform draws on the model's page (KPI tiles, confusion matrix,
ROC, precision-recall, calibration, score distribution; or predicted vs actual and residuals), plus a report table.

    with mlflow.start_run():
        ...
        log_regresi(y_test, model.predict(...), "holdout")                      # regression
        log_klasifikasi(y_test, proba_positive, 0.5, "holdout", ("no", "yes"))  # binary classification
"""

import mlflow
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    classification_report,
    confusion_matrix,
    f1_score,
    matthews_corrcoef,
    mean_absolute_error,
    mean_squared_error,
    precision_recall_curve,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)


def _thin(xs, ys, n=200):
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    if len(xs) > n:
        idx = np.unique(np.linspace(0, len(xs) - 1, n).round().astype(int))
        xs, ys = xs[idx], ys[idx]
    return [round(float(v), 4) for v in xs], [round(float(v), 4) for v in ys]


def log_klasifikasi(y_true, score, threshold=0.5, name="holdout", labels=("negative", "positive")):
    """A binary classifier: score = the probability of the positive class, predicted positive at score >= threshold."""
    y = np.asarray(y_true, dtype=int)
    p = np.asarray(score, dtype=float)
    pred = (p >= threshold).astype(int)
    metrics = {"accuracy": accuracy_score(y, pred), "precision": precision_score(y, pred, zero_division=0),
               "recall": recall_score(y, pred, zero_division=0), "f1": f1_score(y, pred, zero_division=0), "mcc": matthews_corrcoef(y, pred)}
    both = len(np.unique(y)) == 2
    if both:
        metrics["roc_auc"] = roc_auc_score(y, p)
        metrics["pr_auc"] = average_precision_score(y, p)
    mlflow.log_metrics({f"{name}/{k}": float(v) for k, v in metrics.items()})
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    doc = {"type": "binary_classification", "name": name, "labels": list(labels), "threshold": float(threshold), "rows": int(len(y)),
           "prevalence": float(y.mean()), "metrics": {k: float(v) for k, v in metrics.items()},
           "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}}
    if both:
        fpr, tpr, _ = roc_curve(y, p)
        doc["roc"] = dict(zip(("x", "y"), _thin(fpr, tpr)))
        prec, rec, _ = precision_recall_curve(y, p)
        doc["pr"] = dict(zip(("x", "y"), _thin(rec[::-1], prec[::-1])))
        frac, mean = calibration_curve(y, np.clip(p, 0, 1), n_bins=10, strategy="quantile")
        doc["calibration"] = {"x": [round(float(v), 4) for v in mean], "y": [round(float(v), 4) for v in frac]}
    edges = np.linspace(min(p.min(), threshold), max(p.max(), threshold), 31)
    doc["scores"] = {"edges": [round(float(v), 4) for v in edges], "negative": np.histogram(p[y == 0], edges)[0].tolist(),
                     "positive": np.histogram(p[y == 1], edges)[0].tolist()}
    mlflow.log_dict(doc, f"{name}/evaluation.json")
    report = pd.DataFrame(classification_report(y, pred, labels=[0, 1], target_names=list(labels), output_dict=True, zero_division=0)).T.reset_index()
    mlflow.log_table(report.rename(columns={"index": "class"}).round(4), f"{name}/classification_report.json")
    return metrics


def log_regresi(y_true, y_pred, name="holdout", max_points=400):
    """A regression: RMSE, MAE, R², MAPE, predicted vs actual (a sample of the rows) and the residuals."""
    y = np.asarray(y_true, dtype=float)
    p = np.asarray(y_pred, dtype=float)
    res = p - y
    metrics = {"rmse": float(np.sqrt(mean_squared_error(y, p))), "mae": mean_absolute_error(y, p), "r2": r2_score(y, p)}
    if (y != 0).any():
        metrics["mape"] = float(np.mean(np.abs(res[y != 0] / y[y != 0])))
    mlflow.log_metrics({f"{name}/{k}": float(v) for k, v in metrics.items()})
    idx = np.random.default_rng(0).permutation(len(y))[:max_points]
    edges = np.linspace(res.min(), res.max(), 31) if res.min() < res.max() else np.linspace(-1, 1, 31)
    mlflow.log_dict({"type": "regression", "name": name, "rows": int(len(y)), "metrics": {k: float(v) for k, v in metrics.items()},
                     "scatter": {"x": [round(float(v), 4) for v in y[idx]], "y": [round(float(v), 4) for v in p[idx]]},
                     "residuals": {"edges": [round(float(v), 4) for v in edges], "counts": np.histogram(res, edges)[0].tolist()}},
                    f"{name}/evaluation.json")
    return metrics
'''

INFERENCE = """import numpy as np
import pandas as pd
from transforms.api import transform, Input, Output, ModelInput

# After the first build of train_model, point these at the model (its path in Files, or its rid).
MODEL = "/path/to/example_model"


@transform.using(
    inference_input=Input("{input}"),
    model=ModelInput(MODEL),  # use_sidecar=True runs it in its own process
    predictions=Output("example_predictions"),
)
def run_inference(inference_input, model, predictions):
    df = inference_input.pandas()
    # the model reads the columns of its signature; keep every input column next to the prediction
    df["prediction"] = model.predict(df)["prediction"].to_numpy()
    predictions.write_pandas(df)


@transform.using(
    test_data=Input("{input}"),
    model=ModelInput(MODEL),
    metrics=Output("example_evaluation"),
)
def evaluate_model(test_data, model, metrics):
    df = test_data.pandas()
    target = [c for c in df.columns if df[c].dtype.kind in "if" and c != "row_number"][-1]
    predicted = model.predict(df)["prediction"].to_numpy(dtype=float)
    error = df[target].to_numpy(dtype=float) - predicted
    metrics.write_pandas(pd.DataFrame([{{
        "rows": len(df),
        "rmse": float(np.sqrt((error ** 2).mean())),
        "mae": float(np.abs(error).mean()),
    }}]))
"""

PIPELINE = """from transforms.api import Pipeline

from model_training import benchmark, model_training, run_inference

my_pipeline = Pipeline()
my_pipeline.add_transforms(model_training.train_model, benchmark.train_random_forest, run_inference.run_inference, run_inference.evaluate_model)
"""

README = """# {name}

A model training repository (Model Training template), built on MLflow (open source).

- `src/ml_models/linear_model.py`: the model, an `mlflow.pyfunc.PythonModel` (`predict(context, model_input)`).
  Keep it apart from the training code: MLflow saves this package with the model so it loads anywhere.
- `src/model_training/model_training.py`: trains the model inside an MLflow run (`mlflow.log_params`,
  `mlflow.log_metric`) and publishes a version with `ModelOutput(...).publish(model, input_example=...)`. Build it:
  the version is committed when the build succeeds, with the run as its experiment, and the model appears in Files
  and on the Models page. `publish()` also takes a scikit-learn estimator or an MLflow model URI (`runs:/…`).
- `src/ml_models/evaluasi.py`: `log_regresi(...)` / `log_klasifikasi(...)` log the evaluation of a held-out set to the
  run (metrics + the curves the model's page draws: predicted vs actual, residuals; or confusion matrix, ROC,
  precision-recall, calibration).
- `src/model_training/benchmark.py`: a second candidate (a scikit-learn random forest). To benchmark: open a model →
  Submit to a Modeling Objective, submit the other one too, add an evaluation dataset; the objective's Comparisons tab
  compares them (metrics by subset, confusion matrices, ROC curves).
- `src/model_training/run_inference.py`: batch inference with `ModelInput` and an evaluation that writes RMSE / MAE.
  Point `MODEL` at your model first.

The way through: explore in a Jupyter Code Workspace (optional) → train here (each build: a model version with its
experiment and charts; Data Lineage links the datasets, this code and the model) → benchmark in a Modeling Objective →
release and deploy (live endpoint, function for Pipeline Builder / Workshop, batch). Model Integration shows each
model's progress.
"""

EXTERNAL = '''import json
import urllib.request

import pandas as pd
import palantir_models as pm


class ExampleExternalModelAdapter(pm.ExternalModelAdapter):
    """An externally hosted model: init_external gets the URL, the connection configuration and the decrypted
    credentials configured on the model (Models → Connect externally hosted model)."""

    def __init__(self, url, credentials, configuration):
        self.url = url
        self.api_key = credentials.get("api_key", "")
        self.model_name = configuration.get("model_name", "")

    @classmethod
    def init_external(cls, external_context):
        return cls(external_context.base_url, external_context.resolved_credentials, external_context.connection_config)

    @classmethod
    def api(cls):
        return {"df_in": pm.Pandas([("text", str)])}, {"df_out": pm.Pandas([("text", str), ("prediction", str)])}

    def predict(self, df_in):
        body = json.dumps({"model": self.model_name, "instances": df_in["text"].tolist()}).encode()
        request = urllib.request.Request(self.url, data=body, headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            df_in["prediction"] = json.loads(response.read())["predictions"]
        return df_in
'''

CONTAINER = '''import json
import urllib.request

import palantir_models as pm


class ExampleContainerModelAdapter(pm.ContainerModelAdapter):
    """A container-backed model: init_container gets each container's "host:port" (Models → Import containerized model)."""

    def __init__(self, address):
        self.address = address

    @classmethod
    def init_container(cls, container_context):
        name, uris = next(iter(container_context.services.items()))
        return cls(uris[0])

    @classmethod
    def api(cls):
        return {"df_in": pm.Pandas([("text", str)])}, {"df_out": pm.Pandas([("text", str), ("prediction", str)])}

    def predict(self, df_in):
        body = json.dumps({"instances": df_in["text"].tolist()}).encode()
        with urllib.request.urlopen(urllib.request.Request(f"http://{self.address}/predict", data=body), timeout=60) as response:
            df_in["prediction"] = json.loads(response.read())["predictions"]
        return df_in
'''


def model_training_files(name: str, settings: str, sample_input: str) -> dict[str, str]:
    base = "transforms-python"
    files = t.python_files(name, settings, sample_input)
    for k in [k for k in files if k.startswith(f"{base}/src/myproject") or k.startswith(f"{base}/src/test")]:
        del files[k]
    files.update({
        "README.md": README.format(name=name),
        f"{base}/src/ml_models/__init__.py": "",
        f"{base}/src/ml_models/linear_model.py": ADAPTER,
        f"{base}/src/model_training/__init__.py": "",
        f"{base}/src/model_training/pipeline.py": PIPELINE,
        f"{base}/src/model_training/model_training.py": TRAINING.format(input=sample_input),
        f"{base}/src/model_training/benchmark.py": BENCHMARK.format(input=sample_input),
        f"{base}/src/ml_models/evaluasi.py": EVALUASI,
        f"{base}/src/model_training/run_inference.py": INFERENCE.format(input=sample_input),
    })
    setup = files.get(f"{base}/src/setup.py", "")
    files[f"{base}/src/setup.py"] = setup.replace("myproject.pipeline", "model_training.pipeline")
    return files


def adapter_library_files(name: str, settings: str) -> dict[str, str]:
    files = t.library_files(name, settings)
    for k in [k for k in files if k.startswith("src/") and k != "src/setup.py"]:
        del files[k]
    files.update({
        "src/model_adapter/__init__.py": "",
        "src/model_adapter/example_adapter.py": EXTERNAL,
        "src/model_adapter/container_adapter.py": CONTAINER,
    })
    files["README.md"] = files["README.md"] + "\nModel Adapter Library: `model_adapter.example_adapter` (externally hosted model) and\n`model_adapter.container_adapter` (container model). Pick a file and class when you connect or import a model.\n"
    return files


EVALUATOR = '''from typing import List

from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from foundry_ml_metrics.evaluation import ComputedMetricValue, Evaluator, Field


class CustomEvaluator(Evaluator):
    """
        :display-name: Configurable Row Count Evaluator
        :description: This evaluator calculates the row count of the input DataFrame, filtered to the specified value.
        :param column: Filtered column
        :param value: Filtered value
        :metric Row Count: The unfiltered row count
        :metric Filtered Row Count: The filtered row count
    """

    column: Field[int]
    value: int

    def __init__(self, column: Field[int], value: int):
        self.column = column
        self.value = value

    def apply_spark(self, df: DataFrame) -> List[ComputedMetricValue]:
        row_count = df.count()
        filtered_row_count = df.filter(F.col(self.column.name) == self.value).count()
        return [
            ComputedMetricValue(metric_name="Row Count", metric_value=row_count),
            ComputedMetricValue(metric_name="Filtered Row Count", metric_value=filtered_row_count),
        ]
'''


def evaluator_library_files(name: str, settings: str) -> dict[str, str]:
    """Model Evaluator Template Library: an Evaluator in src/evaluator/custom_evaluator.py; tag a version to publish it."""
    files = t.library_files(name, settings)
    for k in [k for k in files if k.startswith("src/")]:
        del files[k]
    files.update({"src/evaluator/__init__.py": "", "src/evaluator/custom_evaluator.py": EVALUATOR})
    files["README.md"] = files["README.md"] + ("\nModel Evaluator Template Library: implement `Evaluator.apply_spark` in `src/evaluator/`; the docstring's "
                                               ":display-name:, :description:, :param and :metric lines describe it in Modeling Objectives. Tag a version "
                                               "to publish it, then pick it in an objective's evaluation configuration.\n")
    return files
