"""The BluesandAI client installed in a Jupyter Code Workspace (code_workspaces.py puts it, with model_lib.py, into
the workspace's Python environment).

It gives notebooks Foundry's Code Workspaces API, talking to the platform over HTTPS with the workspace's token:

    from foundry.transforms import Dataset
    df = Dataset.get("training_data").read_table(format="pandas")      # a dataset alias of the workspace
    Dataset.get("housing_test_data").write_table(test_df)

    files = Dataset.get("scans").files().download()                     # a dataset's raw files (non-tabular):
                                                                        # {path in the dataset: local path}
    Dataset.get("reports").upload_file("out/report.pdf")                # write files to a "files" output alias
    Dataset.get("reports").upload_directory("out/")

    import mlflow
    from bluesandai.workspace import Dataset, ModelOutput, ModelInput
    from bluesandai.evaluation import log_regresi                       # or log_klasifikasi
    with mlflow.start_run(run_name="my-experiment"):                    # the run becomes the version's experiment
        mlflow.log_param("alpha", 0.5)
        log_regresi(y_test, model.predict(X_test), "holdout")           # metrics + charts on the model's page
        ModelOutput("linear_regression_model").publish(model, input_example=X_test.head(5))
    model = ModelInput("linear_regression_model")                       # the latest version, loaded here

publish() takes an MLflow model (open source): an mlflow.pyfunc.PythonModel, a scikit-learn estimator or an MLflow
model URI; a PythonModel defined in a .py file of the working directory is saved with it. Older code using
`palantir_models.code_workspaces` and ModelAdapter classes keeps working.

Environment: BLUESANDAI_API_URL, BLUESANDAI_WORKSPACE_ID, BLUESANDAI_API_TOKEN (set on the workspace's machine).
"""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import types
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional

import model_lib

# MLflow runs of the notebook go to a local store, read back when a version is published (its experiment)
os.environ.setdefault("MLFLOW_TRACKING_URI", "sqlite:///" + (Path.home() / ".bluesandai-mlflow.db").as_posix())


def _base() -> str:
    if os.environ.get("BLUESANDAI_POD_URL"):
        # the workspace's own endpoints, reached with the pod secret
        return os.environ["BLUESANDAI_POD_URL"].rstrip("/")
    url, wid = os.environ.get("BLUESANDAI_API_URL"), os.environ.get("BLUESANDAI_WORKSPACE_ID")
    if not url or not wid:
        raise RuntimeError("this is not a BluesandAI Code Workspace: BLUESANDAI_API_URL / BLUESANDAI_WORKSPACE_ID are not set")
    return f"{url.rstrip('/')}/api/code-workspaces/{wid}/pod"


def _call(method: str, path: str, data: Optional[bytes] = None, content_type: Optional[str] = None, timeout: int = 600) -> bytes:
    headers = {"Authorization": f"Bearer {os.environ.get('BLUESANDAI_API_TOKEN', '')}", "User-Agent": "bluesandai-workspace/1.0"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(_base() + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - the platform's own API
            return r.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(body).get("detail")
        except ValueError:
            detail = body[:500]
        raise RuntimeError(f"{detail if isinstance(detail, str) else json.dumps(detail)} (HTTP {e.code})") from None


class Dataset:
    """A dataset alias of the workspace (Data tab)."""

    def __init__(self, alias: str) -> None:
        self.alias = alias

    @classmethod
    def get(cls, alias: str) -> "Dataset":
        return cls(alias)

    def read_table(self, format: str = "pandas", **_: Any):  # noqa: A002
        import pyarrow.parquet as pq

        table = pq.read_table(io.BytesIO(_call("GET", f"/datasets/{urllib.request.quote(self.alias)}")))
        if format == "arrow":
            return table
        if format == "polars":
            import polars as pl

            return pl.from_arrow(table)
        if format == "pandas":
            return table.to_pandas()
        raise ValueError("format is pandas, arrow or polars")

    def write_table(self, df: Any, **_: Any) -> dict:
        import pyarrow as pa
        import pyarrow.parquet as pq

        if hasattr(df, "to_arrow"):
            table = df.to_arrow()
        elif isinstance(df, pa.Table):
            table = df
        else:
            table = pa.Table.from_pandas(model_lib.to_pandas(df), preserve_index=False)
        buf = io.BytesIO()
        pq.write_table(table, buf)
        res = json.loads(_call("PUT", f"/datasets/{urllib.request.quote(self.alias)}", buf.getvalue(), "application/vnd.apache.parquet"))
        print(f"{self.alias}: {res.get('rows')} rows written to {res.get('name')}")
        return res


class DatasetFiles:
    """The files of a dataset (Foundry's filesystem access in Code Workspaces): list them, download them."""

    def __init__(self, alias: str, files: list[dict]) -> None:
        self.alias, self._files = alias, files

    def list(self) -> list[dict]:
        """[{path, size, modified}] of every file in the dataset."""
        return list(self._files)

    def __iter__(self):
        return iter(f["path"] for f in self._files)

    def __len__(self) -> int:
        return len(self._files)

    def __repr__(self) -> str:
        return f"<{len(self._files)} files of dataset {self.alias!r}>"

    def download(self, dest: Optional[str] = None, pattern: Optional[str] = None) -> dict[str, str]:
        """Download the files (those matching a glob pattern, e.g. "*.png") into dest (a temporary folder by default);
        returns {path in the dataset: local path}."""
        import fnmatch

        root = Path(dest or tempfile.mkdtemp(prefix=f"dataset-{self.alias}-"))
        out: dict[str, str] = {}
        for f in self._files:
            if pattern and not fnmatch.fnmatch(f["path"], pattern):
                continue
            target = root / f["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(_call("GET", f"/datasets/{urllib.request.quote(self.alias)}/files/{urllib.request.quote(f['path'])}"))
            out[f["path"]] = str(target)
        return out

    def open(self, path: str, mode: str = "rb"):
        """One file of the dataset, opened for reading ("rb" or "r")."""
        data = _call("GET", f"/datasets/{urllib.request.quote(self.alias)}/files/{urllib.request.quote(path)}")
        return io.BytesIO(data) if "b" in mode else io.StringIO(data.decode("utf-8"))


def _files_of(self: "Dataset") -> DatasetFiles:
    return DatasetFiles(self.alias, json.loads(_call("GET", f"/datasets/{urllib.request.quote(self.alias)}/files")))


def _upload_file(self: "Dataset", local_path: str, path_in_dataset: Optional[str] = None) -> dict:
    """Write a local file into a "files" output alias (under its name, or path_in_dataset)."""
    src = Path(local_path)
    name = (path_in_dataset or src.name).replace("\\", "/").lstrip("/")
    res = json.loads(_call("PUT", f"/datasets/{urllib.request.quote(self.alias)}/files/{urllib.request.quote(name)}", src.read_bytes(), "application/octet-stream"))
    return res


def _upload_directory(self: "Dataset", local_dir: str) -> list[dict]:
    """Write every file of a local folder (keeping its subfolders) into a "files" output alias."""
    root = Path(local_dir)
    out = [_upload_file(self, str(f), f.relative_to(root).as_posix()) for f in sorted(root.rglob("*")) if f.is_file()]
    print(f"{self.alias}: {len(out)} files written")
    return out


Dataset.files = _files_of  # type: ignore[attr-defined]
Dataset.upload_file = _upload_file  # type: ignore[attr-defined]
Dataset.upload_directory = _upload_directory  # type: ignore[attr-defined]


class ModelOutput(model_lib.WritableModel):
    """A writable reference to a model alias of the workspace: publish(adapter) creates a version on the platform."""

    def __init__(self, alias: str) -> None:
        super().__init__(alias, model_lib.ModelOutput(alias))
        self.alias = alias

    def publish(self, model: Any, experiment: Optional[model_lib.Experiment] = None, **kw: Any) -> dict:
        """model: an MLflow model (PythonModel, scikit-learn estimator, model URI) or a ModelAdapter; the MLflow run the
        notebook logged to becomes the version's experiment when none is passed."""
        if isinstance(model, model_lib.ModelAdapter) and type(model).__module__ == "__main__":
            raise TypeError("define the model adapter in a .py file of the workspace and import it: a class written in a notebook cell cannot be "
                            "packaged with the model")
        stage = Path(tempfile.mkdtemp(prefix="bsai-model-"))
        try:
            model_lib.begin(stage, "build", None)
            self.published = None
            super().publish(model, experiment=experiment, **kw)
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted((stage / self.param).rglob("*")):
                    if f.is_file():
                        z.write(f, f.relative_to(stage / self.param).as_posix())
            res = json.loads(_call("POST", f"/models/{urllib.request.quote(self.alias)}/publish", buf.getvalue(), "application/zip"))
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        print(f"Published {res['model']} version {res['version']} ({res['version_rid']})\nView it: {res['url']}")
        return res


def ModelInput(alias: str, model_version: Optional[str] = None, **_: object):  # noqa: N802 - Foundry's class name
    """The model behind an alias of the workspace, loaded here: the latest version, or `model_version`."""
    q = f"?version={urllib.request.quote(model_version)}" if model_version else ""
    data = _call("GET", f"/models/{urllib.request.quote(alias)}/download{q}")
    d = Path(tempfile.mkdtemp(prefix="bsai-model-in-"))
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(d)
    spec = json.loads((d / "spec.json").read_text("utf-8"))
    spec["dir"] = str(d)
    return model_lib.load_version(spec, alias)


def install(pm: types.ModuleType) -> None:
    """palantir_models (with .code_workspaces, .models, .transforms, .serializers, .experiments, .evaluations) and
    foundry.transforms."""
    pm.__path__ = getattr(pm, "__path__", [])  # type: ignore[attr-defined]
    model_lib.install(pm)
    pmt = types.ModuleType("palantir_models.transforms")
    pmm = types.ModuleType("palantir_models.models")
    sys.modules.update({"palantir_models.transforms": pmt, "palantir_models.models": pmm})
    model_lib.extend(pmt, pmm)
    cw = types.ModuleType("palantir_models.code_workspaces")
    cw.ModelOutput, cw.ModelInput = ModelOutput, ModelInput  # type: ignore[attr-defined]
    pm.transforms, pm.models, pm.code_workspaces = pmt, pmm, cw  # type: ignore[attr-defined]
    sys.modules["palantir_models.code_workspaces"] = cw


# the package files written next to this module in the workspace's site-packages
PACKAGE_FILES = {
    "palantir_models/__init__.py": "import sys\n\nimport workspace_client\n\nworkspace_client.install(sys.modules[__name__])\n",
    "foundry/__init__.py": "",
    # the platform's own names (open source MLflow underneath): from bluesandai.workspace import Dataset, ModelOutput
    "bluesandai/__init__.py": "",
    "bluesandai/workspace.py": "from workspace_client import Dataset, ModelInput, ModelOutput  # noqa: F401\n",
    "foundry/transforms.py": "from workspace_client import Dataset  # noqa: F401\n",
}
