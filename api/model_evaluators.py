"""Custom evaluation libraries (palantir.com/docs/foundry/evaluate-models/evaluator-custom).

A custom evaluator is a class implementing `foundry_ml_metrics.evaluation.Evaluator` (`apply_spark(df)` returning
`ComputedMetricValue`s) in a Python repository (the Model Evaluator Template Library layout: `src/evaluator/...`).
Its docstring names it and documents it for the Modeling Objectives application:

    :display-name: Row Count Evaluator
    :description: This evaluator calculates the row count of the input DataFrame.
    :param column: Filtered column
    :metric Row Count: The row count

Parameters are the class's annotations: `int`, `float`, `bool`, `str`, `Field[float]`, `Field[int]`, `Field[str]`
(a column of the evaluation data), each optionally `Optional[...]`. Evaluators are discovered from the latest tag of
each repository (a published version), or the default branch's last commit marked unpublished; their library id is
`custom:<repo id>:<module>:<class>`.

Running one (model_evaluation.py) happens in its own process (`python model_evaluators.py job.json`): the
repository's src root on the path, the `foundry_ml_metrics.evaluation` module provided here, the inference dataset as
a Spark DataFrame (local Spark), the evaluator built with the configured parameters (columns as `Field`), called once
per subset.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from typing import Any, Generic, Optional, TypeVar

from fastapi import HTTPException

HERE = Path(__file__).resolve().parent
T = TypeVar("T")


# ------------------------------------------------------------------------------------------------
# foundry_ml_metrics.evaluation (for evaluator code)
# ------------------------------------------------------------------------------------------------


class Field(Generic[T]):
    """A column of the evaluation data, chosen when the evaluator is configured."""

    def __init__(self, name: str) -> None:
        self.name = name

    def __repr__(self) -> str:
        return f"Field({self.name!r})"


class ComputedMetricValue:
    """A metric computed by an evaluator."""

    def __init__(self, metric_name: str, metric_value: Any) -> None:
        self.metric_name = metric_name
        self.metric_value = metric_value


class Evaluator:
    def apply_spark(self, df):  # noqa: ANN001
        raise NotImplementedError("an Evaluator implements apply_spark(df) -> List[ComputedMetricValue]")


def install() -> None:
    pkg = types.ModuleType("foundry_ml_metrics")
    pkg.__path__ = []  # type: ignore[attr-defined]
    ev = types.ModuleType("foundry_ml_metrics.evaluation")
    ev.Field, ev.ComputedMetricValue, ev.Evaluator = Field, ComputedMetricValue, Evaluator  # type: ignore[attr-defined]
    ev.MetricValue = Any  # type: ignore[attr-defined]
    pkg.evaluation = ev  # type: ignore[attr-defined]
    sys.modules.update({"foundry_ml_metrics": pkg, "foundry_ml_metrics.evaluation": ev})


# ------------------------------------------------------------------------------------------------
# discovery
# ------------------------------------------------------------------------------------------------


def _ann(node: Optional[ast.expr]) -> tuple[str, bool]:
    """(type, optional) of a parameter annotation: int, float, bool, str, column[float|int|str]."""
    if node is None:
        return "str", False
    text = ast.unparse(node).replace(" ", "")
    optional = text.startswith("Optional[") and text.endswith("]")
    if optional:
        text = text[len("Optional["):-1]
    m = re.fullmatch(r"Field\[(float|int|str)\]", text)
    if m:
        return f"column:{m.group(1)}", optional
    return (text if text in ("int", "float", "bool", "str") else "str"), optional


def _doc(doc: str) -> dict:
    out: dict = {"name": None, "description": "", "params": {}, "metrics": {}}
    for line in (doc or "").splitlines():
        line = line.strip()
        m = re.match(r":display-name:\s*(.+)", line)
        if m:
            out["name"] = m.group(1).strip()
        m = re.match(r":description:\s*(.+)", line)
        if m:
            out["description"] = m.group(1).strip()
        m = re.match(r":param\s+(\w+):\s*(.*)", line)
        if m:
            out["params"][m.group(1)] = m.group(2).strip()
        m = re.match(r":metric\s+([^:]+):\s*(.*)", line)
        if m:
            out["metrics"][m.group(1).strip()] = m.group(2).strip()
    return out


def evaluators_in(files: dict[str, str]) -> list[dict]:
    """The Evaluator classes of a repository's files: name, description, parameters, metrics, module."""
    out = []
    for path, text in files.items():
        if not path.endswith(".py") or "foundry_ml_metrics" not in text or "src/" not in f"/{path}":
            continue
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        rel = path[path.index("src/") + 4:] if "src/" in path else path
        module = rel[:-3].replace("/", ".").removesuffix(".__init__")
        for node in tree.body:
            if not isinstance(node, ast.ClassDef) or not any(ast.unparse(b).split(".")[-1] == "Evaluator" for b in node.bases):
                continue
            doc = _doc(ast.get_docstring(node) or "")
            params = []
            for item in node.body:
                if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                    t, optional = _ann(item.annotation)
                    params.append({"id": item.target.id, "type": t, "required": not optional, "description": doc["params"].get(item.target.id, "")})
            out.append({"module": module, "class": node.name, "file": path, "name": doc["name"] or node.name, "description": doc["description"],
                        "params": params, "metrics": doc["metrics"]})
    return out


def discover() -> dict[str, dict]:
    """Every custom evaluator of the repositories the caller may see: {library id: spec}."""
    import code_repos

    out: dict[str, dict] = {}
    for summary in code_repos.list_repos():
        try:
            rec = code_repos._repo(summary["id"])
        except HTTPException:
            continue
        tag = (rec.get("tags") or [None])[0]
        commit = tag["commit"] if tag else code_repos._branch(rec, None).get("head")
        if not commit:
            continue
        try:
            files = code_repos._commit_files(rec["id"], commit)
        except HTTPException:
            continue
        for e in evaluators_in(files):
            lid = f"custom:{rec['id']}:{e['module']}:{e['class']}"
            out[lid] = {"kind": "custom", "name": e["name"], "description": e["description"], "metrics": list(e["metrics"]), "metric_docs": e["metrics"],
                        "fields": [{"id": p["id"], "type": "column" if p["type"].startswith("column") else ("int" if p["type"] == "int" else "value"),
                                    "value_type": p["type"], "required": p["required"], "description": p["description"]} for p in e["params"]],
                        "repo_id": rec["id"], "repo": rec["name"], "module": e["module"], "class": e["class"], "commit": commit,
                        "version": tag["name"] if tag else None, "published": bool(tag)}
    return out


# ------------------------------------------------------------------------------------------------
# running
# ------------------------------------------------------------------------------------------------


def run(spec: dict, parquet: bytes, masks: dict[str, list[bool]], params: dict) -> dict[str, dict]:
    """{subset: {metric: value}} from the evaluator over the inference dataset and each subset (its own process)."""
    import code_repos

    files = code_repos._commit_files(spec["repo_id"], spec["commit"])
    with tempfile.TemporaryDirectory(prefix="evaluator-") as tmp:
        root = Path(tmp)
        for path, text in files.items():
            if "src/" in path and path.endswith(".py"):
                p = root / "src" / path[path.index("src/") + 4:]
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text, "utf-8")
        (root / "data.parquet").write_bytes(parquet)
        job = {"src": str(root / "src"), "data": str(root / "data.parquet"), "module": spec["module"], "class": spec["class"], "masks": masks,
               "params": params, "fields": spec["fields"], "out": str(root / "out.json")}
        (root / "job.json").write_text(json.dumps(job), "utf-8")
        env = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL", k)}
        p = subprocess.run([sys.executable, str(HERE / "model_evaluators.py"), str(root / "job.json")], cwd=str(HERE), capture_output=True, timeout=1800, env=env)
        out = root / "out.json"
        if not out.exists():
            raise ValueError(f"the evaluator did not run: {(p.stderr or p.stdout).decode(errors='replace')[-2000:]}")
        res = json.loads(out.read_text("utf-8"))
    if not res.get("ok"):
        raise ValueError(f"{spec['name']}: {res.get('error')}")
    return res["subsets"]


def _job(path: str) -> None:
    job = json.loads(Path(path).read_text("utf-8"))
    res: dict = {"ok": False}
    try:
        sys.path.insert(0, str(HERE))
        sys.path.insert(0, job["src"])
        install()
        import importlib

        import pandas as pd

        import code_pyapi

        mod = importlib.import_module(job["module"])
        cls = getattr(mod, job["class"])
        kwargs = {}
        for f in job["fields"]:
            v = job["params"].get(f["id"])
            if v in (None, ""):
                if f["required"]:
                    raise ValueError(f"the parameter {f['id']} is required")
                kwargs[f["id"]] = None
                continue
            vt = f.get("value_type", "str")
            kwargs[f["id"]] = Field(str(v)) if vt.startswith("column") else int(v) if vt == "int" else float(v) if vt == "float" else (str(v).lower() in ("1", "true", "yes")) if vt == "bool" else str(v)
        evaluator = cls(**kwargs)
        pdf = pd.read_parquet(job["data"])
        spark = code_pyapi.spark_session()
        sdf = spark.createDataFrame(pdf)
        out = {}
        for label, mask in job["masks"].items():
            part = sdf if all(mask) else spark.createDataFrame(pdf[pd.Series(mask, index=pdf.index)]) if any(mask) else None
            if part is None:
                continue
            metrics = {}
            for m in evaluator.apply_spark(part) or []:
                v = m.metric_value
                try:
                    metrics[str(m.metric_name)] = float(v.item() if hasattr(v, "item") else v)
                except (TypeError, ValueError):
                    metrics[str(m.metric_name)] = None
            out[label] = metrics
        res = {"ok": True, "subsets": out}
        code_pyapi.stop_spark()
    except Exception as e:  # noqa: BLE001
        import traceback

        res = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc(limit=5)}
    Path(job["out"]).write_text(json.dumps(res, default=str), "utf-8")


if __name__ == "__main__":
    _job(sys.argv[1])
