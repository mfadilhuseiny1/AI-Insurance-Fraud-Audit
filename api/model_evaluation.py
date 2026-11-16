"""Automatic model evaluation in Modeling Objectives (evaluate-models/model-evaluation-automatic) and the data of
the evaluation dashboard.

The objective's evaluation configuration names evaluation datasets (each with a folder for inference datasets and
one for metrics datasets), evaluation libraries (the default binary classification and regression evaluators, with
their fields) and evaluation subsets (a string column: one subset per value; a numeric column: fixed-width buckets
or range cut-offs; several fields: every combination). Building evaluates a submission on a dataset: the model runs
over the dataset (model_deployments.run_model_on_dataset, a model with a single tabular input) into an inference
dataset `inference_<submission>_<dataset>-<hash>`; each library then computes its metrics and plots on the whole
inference dataset ("Overall") and on every subset, kept as a result and written as a metrics dataset
`metrics_<submission>_<dataset>_<library>-<hash>` (subset, metric, value). With automatic building on, a new
submission is evaluated on every evaluation dataset. Evaluation-based checks read these metrics.

A build reads and writes as the user who started it (who submitted the model, for automatic builds; run_as.py), never
as the system: it needs the editor role on the objective, read access to each evaluation dataset (its markings and
Project role) and the editor role on the folders it writes to. A background build re-checks the user when it starts:
when they were deleted or deactivated it does not run, and a dataset or folder they lost access to fails its row with
the reason, writing nothing.

Results live under <ontology>/modeling-objectives-eval/<objective>.json. Everything is computed with numpy.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import model_lib
import modeling_objectives as mo
import ontology

router = APIRouter(prefix="/api/modeling-objectives", tags=["modeling-objectives"])
_lock = threading.RLock()
_building: dict[str, dict] = {}
MAX_SUBSETS = 200

LIBRARIES = {
    "binary_classification": {
        "name": "Binary classification", "description": "Core metrics for binary classifiers: 1 is the positive class, 0 the negative class.",
        "fields": [{"id": "inference_field", "type": "column", "required": True, "description": "The model's predicted class (0 / 1)"},
                   {"id": "actual_field", "type": "column", "required": True, "description": "The values the predictions are compared to (0 / 1)"},
                   {"id": "probability_field", "type": "column", "required": False, "description": "Probability of the positive class"},
                   {"id": "max_samples_for_roc", "type": "int", "required": False, "default": 200, "description": "Samples of the ROC curve"}],
        "metrics": ["Row count", "Prior", "Accuracy", "Precision", "Recall", "F1 score", "Matthews correlation coefficient", "ROC AUC score"]},
    "regression": {
        "name": "Regression", "description": "Core metrics for regression models.",
        "fields": [{"id": "inference_field", "type": "column", "required": True, "description": "The model's prediction"},
                   {"id": "actual_field", "type": "column", "required": True, "description": "The values the predictions are compared to"},
                   {"id": "histogram_bins", "type": "int", "required": False, "default": 10, "description": "Buckets of the distribution plots"}],
        "metrics": ["Row Count", "Mean Absolute Error", "Root Mean Squared Error", "R2 Score", "Explained Variance"]},
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _file(objective_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", objective_id):
        raise HTTPException(404, "Modeling objective not found")
    d = ontology.DIR / "modeling-objectives-eval"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{objective_id}.json"


def _results(objective_id: str) -> list[dict]:
    p = _file(objective_id)
    return json.loads(p.read_text("utf-8")) if p.exists() else []


def _save_results(objective_id: str, rows: list[dict]) -> None:
    p = _file(objective_id)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(rows, default=str), "utf-8")
    os.replace(tmp, p)


# ------------------------------------------------------------------------------------------------
# configuration
# ------------------------------------------------------------------------------------------------


class EvalDataset(BaseModel):
    id: str
    inference_folder_id: str
    metrics_folder_id: Optional[str] = None


class EvalLibrary(BaseModel):
    id: Optional[str] = None
    kind: Literal["binary_classification", "regression", "custom"]
    # custom evaluators (model_evaluators.py): "custom:<repo id>:<module>:<class>"
    library_id: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=120)
    fields: dict[str, Any] = Field(default_factory=dict)


class SubsetField(BaseModel):
    column: str = Field(min_length=1, max_length=200)
    bucket: Literal["categorical", "fixed_width", "cutoffs"] = "categorical"
    start: Optional[float] = None
    width: Optional[float] = None
    cutoffs: list[float] = Field(default_factory=list)


class EvalSubset(BaseModel):
    id: Optional[str] = None
    fields: list[SubsetField] = Field(min_length=1, max_length=4)


class PinnedTab(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    metrics: list[str] = Field(default_factory=list)


class EvalConfig(BaseModel):
    # generate inference and metrics pipelines, or inference only
    generate: Literal["inference_metrics", "inference"] = "inference_metrics"
    # build them when a model is submitted
    auto_build: bool = True
    datasets: list[EvalDataset] = Field(default_factory=list, max_length=20)
    libraries: list[EvalLibrary] = Field(default_factory=list, max_length=10)
    subsets: list[EvalSubset] = Field(default_factory=list, max_length=20)
    # columns a submission is expected to produce (offered in the field pickers)
    expected_outputs: list[str] = Field(default_factory=list)
    # custom metric views: tabs of pinned metrics shown on every submission
    pinned_tabs: list[PinnedTab] = Field(default_factory=list, max_length=12)


@router.get("/tools/evaluation-libraries")
def libraries() -> dict:
    """The default evaluators and the custom evaluators of the repositories the caller may see."""
    import model_evaluators

    return {**LIBRARIES, **model_evaluators.discover()}


@router.put("/{objective_id}/evaluation")
def save_config(objective_id: str, req: EvalConfig) -> dict:
    import drive

    datasets = []
    for d in req.datasets:
        item = drive._item(d.id)
        if item["kind"] != "file" or not item["name"].endswith(".parquet"):
            raise HTTPException(400, f"{item['name']} is not a dataset")
        drive._item(d.inference_folder_id, need="editor")
        if d.metrics_folder_id:
            drive._item(d.metrics_folder_id, need="editor")
        datasets.append({"id": item["id"], "name": item["name"].removesuffix(".parquet"), "inference_folder_id": d.inference_folder_id,
                         "metrics_folder_id": d.metrics_folder_id or d.inference_folder_id})
    libs = []
    custom = None
    for lib in req.libraries:
        if lib.kind == "custom":
            if custom is None:
                import model_evaluators

                custom = model_evaluators.discover()
            spec = custom.get(lib.library_id or "")
            if not spec:
                raise HTTPException(400, f"no custom evaluator {lib.library_id}: publish (tag) the repository that defines it")
        else:
            spec = LIBRARIES[lib.kind]
        fields = {}
        for f in spec["fields"]:
            v = lib.fields.get(f["id"])
            if v in (None, ""):
                if f["required"]:
                    raise HTTPException(400, f"{spec['name']}: {f['id']} is required")
                continue
            fields[f["id"]] = int(v) if f["type"] == "int" else str(v)
        row = {"id": lib.id or f"lib-{uuid.uuid4().hex[:8]}", "kind": lib.kind, "name": (lib.name or spec["name"]).strip(), "fields": fields}
        if lib.kind == "custom":
            # pinned to the evaluator's version (commit) when the configuration is saved
            row.update(library_id=lib.library_id, spec={k: spec[k] for k in ("repo_id", "module", "class", "commit", "fields", "name", "version")})
        libs.append(row)
    subsets = []
    for s in req.subsets:
        for f in s.fields:
            if f.bucket == "fixed_width" and (f.start is None or not f.width or f.width <= 0):
                raise HTTPException(400, f"{f.column}: fixed-width buckets need a starting value and a bucket width above 0")
            if f.bucket == "cutoffs" and not f.cutoffs:
                raise HTTPException(400, f"{f.column}: give at least one range cut-off")
        subsets.append({"id": s.id or f"sub-{uuid.uuid4().hex[:8]}", "fields": [{**f.model_dump(), "cutoffs": sorted(f.cutoffs)} for f in s.fields]})
    with mo._lock:
        rec = mo._get(objective_id, "editor")
        rec["evaluation"] = {"generate": req.generate, "auto_build": req.auto_build, "datasets": datasets, "libraries": libs, "subsets": subsets,
                             "expected_outputs": [x.strip() for x in req.expected_outputs if x.strip()],
                             "pinned_tabs": [t.model_dump() for t in req.pinned_tabs], "updated_at": _now()}
        mo._write(rec)
    return dashboard(objective_id)


# ------------------------------------------------------------------------------------------------
# subsets and evaluators
# ------------------------------------------------------------------------------------------------


def _bucket(field: dict, series: Any) -> list[Optional[str]]:
    """A label per row for one subset field (None: the row is in no bucket)."""
    import numpy as np
    import pandas as pd

    col = field["column"]
    if field["bucket"] == "categorical":
        return [None if pd.isna(v) else f"{col}={v}" for v in series]
    vals = pd.to_numeric(series, errors="coerce")
    out: list[Optional[str]] = []
    if field["bucket"] == "fixed_width":
        start, width = float(field["start"]), float(field["width"])
        for v in vals:
            if pd.isna(v):
                out.append(None)
            else:
                lo = start + math.floor((v - start) / width) * width
                out.append(f"{col} [{_num(lo)}, {_num(lo + width)})")
        return out
    cuts = [float(c) for c in field["cutoffs"]]
    lo_all, hi_all = (float(np.nanmin(vals)), float(np.nanmax(vals))) if vals.notna().any() else (0.0, 0.0)
    for v in vals:
        if pd.isna(v):
            out.append(None)
        elif v < cuts[0]:
            out.append(f"{col} [{_num(lo_all)}, {_num(cuts[0])})")
        elif v >= cuts[-1]:
            out.append(f"{col} [{_num(cuts[-1])}, {_num(hi_all)}]")
        else:
            i = max(k for k, c in enumerate(cuts) if v >= c)
            out.append(f"{col} [{_num(cuts[i])}, {_num(cuts[i + 1])})")
    return out


def _num(v: float) -> str:
    return f"{v:g}"


def subset_masks(df: Any, subsets: list[dict]) -> tuple[dict[str, Any], list[str]]:
    """{"Overall": all rows, "<label>": mask, ...} and what could not be built."""
    import numpy as np

    masks: dict[str, Any] = {"Overall": np.ones(len(df), dtype=bool)}
    notes = []
    for s in subsets:
        missing = [f["column"] for f in s["fields"] if f["column"] not in df.columns]
        if missing:
            notes.append(f"subset on {', '.join(f['column'] for f in s['fields'])}: column {', '.join(missing)} is not in the inference dataset")
            continue
        labels = [_bucket(f, df[f["column"]]) for f in s["fields"]]
        combined = [None if any(x is None for x in parts) else ", ".join(parts) for parts in zip(*labels)]
        arr = np.array(combined, dtype=object)
        for label in sorted({x for x in combined if x is not None}):
            if len(masks) > MAX_SUBSETS:
                notes.append(f"more than {MAX_SUBSETS} subsets: the rest were left out")
                break
            masks[label] = arr == label
    return masks, notes


def _hist(values: Any, bins: int, rng: Optional[tuple] = None) -> dict:
    import numpy as np

    v = np.asarray(values, dtype=float)
    v = v[~np.isnan(v)]
    if not len(v):
        return {"type": "bar", "x": [], "y": []}
    counts, edges = np.histogram(v, bins=bins, range=rng)
    return {"type": "bar", "x": [f"{_num(round(float(a), 4))}–{_num(round(float(b), 4))}" for a, b in zip(edges[:-1], edges[1:])], "y": [int(c) for c in counts]}


def binary_classification(df: Any, fields: dict) -> tuple[dict, dict]:
    import numpy as np
    import pandas as pd

    pred = pd.to_numeric(df[fields["inference_field"]], errors="coerce")
    actual = pd.to_numeric(df[fields["actual_field"]], errors="coerce")
    ok = pred.notna() & actual.notna()
    p, y = pred[ok].astype(int).to_numpy(), actual[ok].astype(int).to_numpy()
    n = len(y)
    metrics: dict[str, float] = {"Row count": float(n)}
    plots: dict[str, dict] = {}
    if not n:
        return metrics, plots
    tp, tn = int(((p == 1) & (y == 1)).sum()), int(((p == 0) & (y == 0)).sum())
    fp, fn = int(((p == 1) & (y == 0)).sum()), int(((p == 0) & (y == 1)).sum())
    metrics["Prior"] = float((y == 1).mean())
    metrics["Accuracy"] = (tp + tn) / n
    if tp + fp:
        metrics["Precision"] = tp / (tp + fp)
    if tp + fn:
        metrics["Recall"] = tp / (tp + fn)
    if metrics.get("Precision") is not None and metrics.get("Recall") is not None and metrics["Precision"] + metrics["Recall"]:
        metrics["F1 score"] = 2 * metrics["Precision"] * metrics["Recall"] / (metrics["Precision"] + metrics["Recall"])
    denom = math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    if denom:
        metrics["Matthews correlation coefficient"] = (tp * tn - fp * fn) / denom
    plots["Confusion matrix"] = {"type": "matrix", "rows": ["Actual 1", "Actual 0"], "columns": ["Predicted 1", "Predicted 0"], "values": [[tp, fn], [fp, tn]]}
    plots["Score distribution"] = {"type": "bar", "x": ["0", "1"], "y": [int((p == 0).sum()), int((p == 1).sum())]}
    pf = fields.get("probability_field")
    if pf and pf in df.columns:
        prob = pd.to_numeric(df[pf], errors="coerce")[ok].to_numpy(dtype=float)
        keep = ~np.isnan(prob)
        prob, yy = prob[keep], y[keep]
        plots["Probability distribution"] = _hist(prob, 20, (0.0, 1.0))
        auc = model_lib._auc(yy == 1, prob)
        if auc is not None:
            metrics["ROC AUC score"] = auc
            k = max(2, min(int(fields.get("max_samples_for_roc") or 200), 2000))
            ths = np.linspace(1, 0, k)
            pos, neg = int((yy == 1).sum()), int((yy == 0).sum())
            tpr = [float(((prob >= t) & (yy == 1)).sum() / pos) for t in ths]
            fpr = [float(((prob >= t) & (yy == 0)).sum() / neg) for t in ths]
            prior = pos / len(yy)
            lift = [float((((prob >= t) & (yy == 1)).sum() / max(1, (prob >= t).sum())) / prior) for t in ths]
            tx = [round(float(t), 4) for t in ths]
            plots["ROC curve"] = {"type": "line", "x": [round(v, 4) for v in fpr], "y": [round(v, 4) for v in tpr], "x_label": "False positive rate", "y_label": "True positive rate"}
            plots["True positive rate curve"] = {"type": "line", "x": tx, "y": [round(v, 4) for v in tpr], "x_label": "Probability", "y_label": "TPR"}
            plots["False positive rate curve"] = {"type": "line", "x": tx, "y": [round(v, 4) for v in fpr], "x_label": "Probability", "y_label": "FPR"}
            plots["Lift curve"] = {"type": "line", "x": tx, "y": [round(v, 4) for v in lift], "x_label": "Probability", "y_label": "Lift"}
    return metrics, plots


def regression(df: Any, fields: dict) -> tuple[dict, dict]:
    import pandas as pd

    pred = pd.to_numeric(df[fields["inference_field"]], errors="coerce")
    actual = pd.to_numeric(df[fields["actual_field"]], errors="coerce")
    ok = pred.notna() & actual.notna()
    p, y = pred[ok].to_numpy(dtype=float), actual[ok].to_numpy(dtype=float)
    m = model_lib.regression_metrics(y, p)
    metrics = {"Row Count": float(m["example_count"])}
    if m["example_count"]:
        metrics.update({"Mean Absolute Error": m["mean_absolute_error"], "Root Mean Squared Error": m["root_mean_squared_error"], "R2 Score": m["r2"],
                        "Explained Variance": m["explained_variance"]})
    bins = max(2, min(int(fields.get("histogram_bins") or 10), 200))
    return metrics, ({"Score distribution": _hist(p, bins), "Residuals": _hist(y - p, bins)} if len(y) else {})


EVALUATORS = {"binary_classification": binary_classification, "regression": regression}


def _custom(df: Any, lib: dict, subsets: list[dict]) -> dict:
    import model_evaluators

    spec = lib["spec"]
    cols = [lib["fields"].get(f["id"]) for f in spec["fields"] if f["type"] == "column" and lib["fields"].get(f["id"])]
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError(f"{lib['name']}: the inference dataset has no column {', '.join(missing)}")
    masks, notes = subset_masks(df, subsets)
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    res = model_evaluators.run(spec, buf.getvalue(), {k: [bool(x) for x in m] for k, m in masks.items()}, lib["fields"])
    return {"subsets": {label: {"rows": int(m.sum()), "metrics": res.get(label, {}), "plots": {}} for label, m in masks.items()}, "notes": notes}


def evaluate_frame(df: Any, lib: dict, subsets: list[dict]) -> dict:
    """One library over an inference dataset: {"subsets": {label: {"metrics", "plots", "rows"}}, "notes"}."""
    if lib["kind"] == "custom":
        return _custom(df, lib, subsets)
    required = {f["id"] for f in LIBRARIES[lib["kind"]]["fields"] if f["required"]}
    missing = [v for k, v in lib["fields"].items() if k in required and v not in df.columns]
    if missing:
        raise ValueError(f"{lib['name']}: the inference dataset has no column {', '.join(missing)} (columns: {', '.join(map(str, df.columns))})")
    fields = dict(lib["fields"])
    masks, notes = subset_masks(df, subsets)
    for k, v in lib["fields"].items():
        if k.endswith("_field") and k not in required and v not in df.columns:
            # an optional column this model does not produce: the metrics that need it are left out
            del fields[k]
            notes.append(f"{lib['name']}: no column {v} in this model's output, so the metrics that need {k} are left out")
    out = {}
    for label, mask in masks.items():
        part = df[mask]
        metrics, plots = EVALUATORS[lib["kind"]](part, fields)
        out[label] = {"rows": int(len(part)), "metrics": {k: (None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v) for k, v in metrics.items()},
                      "plots": plots}
    return {"subsets": out, "notes": notes}


# ------------------------------------------------------------------------------------------------
# building
# ------------------------------------------------------------------------------------------------


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")[:60] or "x"


def _build_one(objective_id: str, rec: dict, cand: dict, ds: dict) -> list[dict]:
    """Inference of one submission on one evaluation dataset, then every library's metrics."""
    import pandas as pd

    import dataset_versions
    import model_assets
    import model_deployments

    cfg = rec["evaluation"]
    h = hashlib.sha1(f"{objective_id}/{cand['id']}/{ds['id']}".encode()).hexdigest()[:8]
    base = {"candidate_id": cand["id"], "submission": cand["name"], "model_version": cand.get("version"), "dataset_id": ds["id"], "dataset": ds["name"],
            "built_at": _now()}
    try:
        import drive

        # as the user the build runs for (sign-in off, the system: no limits): the evaluation dataset is read with their
        # markings and Project role, the inference / metrics folders need their editor role — checked before anything runs
        drive._item(ds["id"])
        drive._item(ds["inference_folder_id"], need="editor")
        if cfg.get("generate") != "inference" and cfg.get("libraries"):
            drive._item(ds["metrics_folder_id"], need="editor")
        m, _ = model_assets._get(cand["model_id"])
        v = model_assets._version(m, cand["model_version_id"])
        txs = dataset_versions.history(ds["id"])
        base["dataset_transaction"] = txs[0]["id"] if txs else None
        data, info = model_deployments.run_model_on_dataset(m, v, ds["id"], f"eval-{h}")
        inf = model_deployments.write_dataset(ds["inference_folder_id"], f"inference_{_slug(cand['name'])}_{_slug(ds['name'])}-{h}", data,
                                              {"kind": "model_evaluation", "id": objective_id, "name": rec["name"], "model": m["name"], "model_version": v["version"]})
        base["inference"] = {**inf, "rows": info["rows_out"], "columns": info["columns"]}
    except Exception as e:  # noqa: BLE001
        return [{**base, "id": f"evr-{uuid.uuid4().hex[:10]}", "library_id": None, "status": "failed", "error": str(getattr(e, "detail", None) or e)[:2000]}]
    if cfg.get("generate") == "inference" or not cfg.get("libraries"):
        return [{**base, "id": f"evr-{uuid.uuid4().hex[:10]}", "library_id": None, "status": "succeeded", "subsets": {}}]
    df = pd.read_parquet(io.BytesIO(data))
    try:
        # the ground truth and subset columns come from the evaluation dataset: a model that returns only its
        # predictions (an MLflow model's output schema) is evaluated next to the input columns it did not return
        src = pd.read_parquet(io.BytesIO(drive.read_bytes(drive._item(ds["id"]))))
        if len(src) == len(df):
            extra = [c for c in src.columns if c not in df.columns]
            if extra:
                df = pd.concat([df.reset_index(drop=True), src[extra].reset_index(drop=True)], axis=1)
    except Exception:  # noqa: BLE001 - evaluated on the model's output alone
        pass
    out = []
    for lib in cfg["libraries"]:
        row = {**base, "id": f"evr-{uuid.uuid4().hex[:10]}", "library_id": lib["id"], "library": lib["name"], "library_kind": lib["kind"]}
        try:
            res = evaluate_frame(df, lib, cfg.get("subsets") or [])
            rows = [{"subset": s, "metric": k, "value": val} for s, x in res["subsets"].items() for k, val in x["metrics"].items() if val is not None]
            buf = io.BytesIO()
            pd.DataFrame(rows, columns=["subset", "metric", "value"]).to_parquet(buf, index=False)
            met = model_deployments.write_dataset(ds["metrics_folder_id"], f"metrics_{_slug(cand['name'])}_{_slug(ds['name'])}_{_slug(lib['name'])}-{h}",
                                                  buf.getvalue(), {"kind": "model_evaluation", "id": objective_id, "name": rec["name"], "library": lib["name"]})
            row.update(status="succeeded", subsets=res["subsets"], notes=res["notes"], metrics_dataset=met)
        except Exception as e:  # noqa: BLE001
            row.update(status="failed", error=str(e)[:2000])
        out.append(row)
    return out


def build(objective_id: str, candidate_ids: Optional[list[str]] = None, dataset_ids: Optional[list[str]] = None) -> dict:
    with mo._lock:
        # building writes the objective's evaluation results: the editor role (the system and sign-in off pass)
        rec = mo._get(objective_id, "editor")
    cfg = rec.get("evaluation") or {}
    if not cfg.get("datasets"):
        raise HTTPException(400, "configure the evaluation dashboard first: add an evaluation dataset")
    cands = [c for c in rec["candidates"] if c.get("model_id") and not c.get("archived") and (not candidate_ids or c["id"] in candidate_ids)]
    if not cands:
        raise HTTPException(400, "no submission of a model resource version to evaluate")
    dss = [d for d in cfg["datasets"] if not dataset_ids or d["id"] in dataset_ids]
    state = _building.setdefault(objective_id, {"running": 0, "last_error": None})
    state["running"] += 1
    built = []
    try:
        for c in cands:
            for d in dss:
                rows = _build_one(objective_id, rec, c, d)
                with _lock:
                    allr = _results(objective_id)
                    # the newest result per submission, dataset, transaction and library is kept; older transactions stay
                    # a rebuild replaces every earlier result of the submission on that dataset transaction (a failed
                    # inference has no library: it would otherwise stay next to the libraries' new results)
                    keys = {(r["candidate_id"], r["dataset_id"], r.get("dataset_transaction")) for r in rows}
                    allr = [r for r in allr if (r["candidate_id"], r["dataset_id"], r.get("dataset_transaction")) not in keys]
                    _save_results(objective_id, [*allr, *rows][-2000:])
                built += rows
    finally:
        state["running"] -= 1
    failed = [r for r in built if r["status"] == "failed"]
    return {"built": len(built), "failed": len(failed), "errors": [f"{r['submission']} on {r['dataset']}: {r['error']}" for r in failed][:10]}


def on_submission(objective_id: str, candidate_id: str) -> None:
    """modeling_objectives: a model was submitted. With automatic building on it is evaluated on every dataset."""
    with mo._lock:
        cfg = mo._get(objective_id).get("evaluation") or {}
    if cfg.get("auto_build") and cfg.get("datasets"):
        # the build runs as the submitter (a thread starts without the request's principal)
        threading.Thread(target=_quiet_build, args=(objective_id, [candidate_id], _starter()), daemon=True).start()


def _starter() -> Optional[dict]:
    """Who a background build runs for: the caller (a user, a service, or None for the system)."""
    import auth

    return auth.current()


def _quiet_build(objective_id: str, candidate_ids: list[str], starter: Optional[dict] = None) -> None:
    """A build in the background, as `starter`: a user is looked up again (their current markings and roles; deleted or
    deactivated: it does not run), a service or the system runs as it is."""
    import contextlib

    import auth
    import run_as

    try:
        if not auth.enabled():
            ctx = contextlib.nullcontext()
        elif starter and not starter.get("service") and starter.get("id") not in (None, "local", "system"):
            ctx = run_as.acting_as(run_as.owner_principal(starter["id"], "the evaluation build"))
        else:
            ctx = run_as.acting_as(starter)
        with ctx:
            build(objective_id, candidate_ids)
    except run_as.OwnerUnavailable as e:
        _building.setdefault(objective_id, {"running": 0})["last_error"] = f"did not run: {e}"
    except Exception as e:  # noqa: BLE001
        _building.setdefault(objective_id, {"running": 0})["last_error"] = str(getattr(e, "detail", None) or e)


class BuildIn(BaseModel):
    candidate_ids: list[str] = Field(default_factory=list)
    dataset_ids: list[str] = Field(default_factory=list)
    wait: bool = True


@router.post("/{objective_id}/evaluation/build")
def build_route(objective_id: str, req: BuildIn) -> dict:
    """Build evaluation (inference and metrics) for the chosen submissions and datasets (default: all)."""
    mo._get(objective_id, "editor")
    if req.wait:
        return {**build(objective_id, req.candidate_ids or None, req.dataset_ids or None), "dashboard": dashboard(objective_id)}
    threading.Thread(target=_quiet_build, args=(objective_id, req.candidate_ids, _starter()), daemon=True).start()
    return {"started": True}


# ------------------------------------------------------------------------------------------------
# the dashboard and evaluation-based checks
# ------------------------------------------------------------------------------------------------


def _latest(rows: list[dict], transaction: Optional[str]) -> list[dict]:
    """Per submission, dataset and library: the result on the chosen dataset transaction, else the most recent."""
    best: dict[tuple, dict] = {}
    for r in rows:
        if transaction and r.get("dataset_transaction") != transaction:
            continue
        k = (r["candidate_id"], r["dataset_id"], r.get("library_id"))
        if k not in best or r["built_at"] >= best[k]["built_at"]:
            best[k] = r
    return list(best.values())


@router.get("/{objective_id}/evaluation")
def dashboard(objective_id: str, dataset_id: Optional[str] = None, transaction: Optional[str] = None) -> dict:
    """The evaluation configuration and, for one evaluation dataset (and optionally one of its transactions), every
    submission's metrics per library and subset."""
    import dataset_versions

    with mo._lock:
        rec = mo._get(objective_id)
    cfg = rec.get("evaluation") or {"generate": "inference_metrics", "auto_build": True, "datasets": [], "libraries": [], "subsets": [],
                                    "expected_outputs": [], "pinned_tabs": []}
    rows = _results(objective_id)
    pick = dataset_id or (cfg["datasets"][0]["id"] if cfg["datasets"] else None)
    shown = _latest([r for r in rows if r["dataset_id"] == pick], transaction) if pick else []
    txs = []
    if pick:
        used = {r.get("dataset_transaction") for r in rows if r["dataset_id"] == pick}
        txs = [{"id": t["id"], "at": t["at"], "rows": t.get("rows")} for t in dataset_versions.history(pick) if t["id"] in used]
    subsets = ["Overall", *sorted({s for r in shown for s in (r.get("subsets") or {}) if s != "Overall"})]
    state = _building.get(objective_id) or {}
    return {"config": cfg, "dataset_id": pick, "transaction": transaction, "transactions": txs, "results": shown, "subsets": subsets,
            "submissions": [{"id": c["id"], "name": c["name"], "version": c.get("version"), "status": c["status"], "archived": bool(c.get("archived")),
                             "evaluable": bool(c.get("model_id")), "submitted_by": c.get("submitted_by"), "metadata": c.get("metadata") or {}}
                            for c in rec["candidates"]],
            "building": bool(state.get("running")), "last_error": state.get("last_error"), "columns": _columns(cfg, rows)}


def _columns(cfg: dict, rows: list[dict]) -> list[str]:
    """Columns offered in the field pickers: those of inference datasets built so far, the evaluation datasets' own,
    and the expected model outputs."""
    import dataset_versions

    cols: list[str] = []
    for r in rows:
        cols += (r.get("inference") or {}).get("columns") or []
    for d in cfg.get("datasets") or []:
        txs = dataset_versions.history(d["id"])
        cols += (txs[0].get("columns") or []) if txs else []
    cols += cfg.get("expected_outputs") or []
    return sorted(dict.fromkeys(str(c) for c in cols))


OPS = {">": lambda a, b: a > b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, "<=": lambda a, b: a <= b, "==": lambda a, b: a == b}


def check_status(objective_id: str, candidate_id: str, evaluation: dict) -> dict:
    """An evaluation-based check for a submission: PASS, REJECT (with the reason) or PENDING (metrics not built yet)."""
    rows = [r for r in _latest(_results(objective_id), None) if r["candidate_id"] == candidate_id and r["dataset_id"] == evaluation["dataset_id"]
            and r.get("library_id") == evaluation["library_id"]]
    if not rows:
        return {"status": "pending", "message": "metrics were not built yet for this submission, dataset and library"}
    r = rows[0]
    if r["status"] != "succeeded":
        return {"status": "rejected", "message": f"the evaluation failed: {r.get('error')}"}
    sub = (r.get("subsets") or {}).get(evaluation.get("subset") or "Overall")
    val = (sub or {}).get("metrics", {}).get(evaluation["metric"])
    if val is None:
        return {"status": "rejected", "message": f"the metric {evaluation['metric']} was not produced by {r.get('library')}"}
    ok = OPS[evaluation["op"]](val, evaluation["value"])
    return {"status": "approved" if ok else "rejected", "value": val,
            "message": f"{evaluation['metric']} = {val:.4g} {'meets' if ok else 'does not meet'} {evaluation['op']} {evaluation['value']:g}"}


@router.get("/{objective_id}/checks/status")
def checks_status(objective_id: str) -> dict:
    """Every submission's status per check: the reviewers' decision, or the evaluation-based result."""
    with mo._lock:
        rec = mo._get(objective_id)
    checks = [c for c in rec.get("checks") or [] if not c.get("archived")]
    out = {}
    for cand in rec["candidates"]:
        per = {}
        for chk in checks:
            if chk.get("evaluation"):
                per[chk["id"]] = check_status(objective_id, cand["id"], chk["evaluation"])
            else:
                st = (cand.get("checks") or {}).get(chk["id"]) or {}
                per[chk["id"]] = {"status": st.get("status", "pending"), "events": len(st.get("events") or [])}
        states = [x["status"] for x in per.values()]
        overall = "none" if not states else "rejected" if "rejected" in states else "pending" if "pending" in states else "approved"
        out[cand["id"]] = {"checks": per, "overall": overall}
    return out
