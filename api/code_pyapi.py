"""Foundry's Python transforms API, as the `transforms.api` / `transforms.mediasets` / `transforms.expectations`
modules code_runner.py gives a repository's code.

Two generations of the API live side by side:

* the original one here, kept for existing repositories: `@transform_df` and `@transform` (without `.using`) on
  pandas DataFrames, one output; `TransformInput` proxies DataFrame attributes;
* Foundry's current API (palantir.com/docs/foundry/transforms-python):
  - `@transform.using(...)` (also `@transform.lightweight(...)`, and `@lightweight` above `@transform(...)`): a
    single-node transform. Inputs are read as Polars (`.polars(lazy=True)` scans the Parquet file lazily), pandas,
    Arrow or a file system; outputs take `write_table()` of any of those (or a DuckDB relation, or a folder of
    Parquet files), or files through `filesystem().open()`. Several outputs per transform. `ctx` is a
    LightweightContext with `ctx.duckdb()` (every input registered as a lazy view, `<input>_files()` macros) and
    `ctx.abort_job()`. `.with_resources(cpu_cores, memory_gb | memory_mb, gpu_type)`.
  - `@transform.spark.using(...)`: the same on real PySpark (local mode, pyspark_worker.py): `.dataframe()` is a
    pyspark.sql.DataFrame, `write_dataframe()`, `ctx.spark_session`, `filesystem().files()`.
  - `transform_pandas` / `transform_polars` (DataFrame in, DataFrame out), parameters (`BooleanParam`,
    `IntegerParam`, `FloatParam`, `StringParam`, values from repoSettings.json "pythonParameters"), data
    expectations (`Check(E..., name, on_error)` on inputs and outputs, code_expectations.py), `@configure`,
    `Pipeline` with `discover_transforms` / `add_transforms` (a setup.py `transforms.pipelines` entry point makes
    only the pipeline's transforms buildable), column descriptions and typeclasses (kept as Parquet field metadata).

Media sets (MediaSetInput / MediaSetOutput) work with both; their built-in transformations are in code_media.py.

The original decorators run on Spark (palantir.com/docs/foundry/transforms-python-spark) when the file imports
pyspark, when `@configure(...)` is applied, or when repoSettings.json says `"legacyPythonEngine": "spark"`; otherwise
they keep running on pandas (repositories written before Spark was available here). On Spark, `transform_df`
passes pyspark DataFrames and writes the one it returns; `@transform` passes TransformSparkInput / Output.
Spark profiles (`@configure(profile=[...])`) set the local session's memory, cores, shuffle partitions, off-heap
memory and cross joins; `backend=ComputeBackend.VELOX` is accepted and runs on standard Spark (no native engine
here). `Input(..., transaction_limit=N)` and `MediaSetInput(..., batch_limit=N)` cap what one incremental Spark job
reads. Palantir-provided language models come from code_models.py.
"""

from __future__ import annotations

import fnmatch
import functools
import inspect
import io
import json
import math
import os
import re
import shutil
import sys
import types
from collections import namedtuple
from datetime import timedelta
from pathlib import Path
from typing import Any, Optional

import code_expectations
import code_geo
import code_tables
import code_media
import code_models
import model_lib

REGISTRY: list[dict] = []
CURRENT_FILE: dict[str, str] = {"path": ""}
# repoSettings.json "legacyPythonEngine": "spark" | "pandas" (None: decide per file by its pyspark imports)
LEGACY_ENGINE: dict[str, Optional[str]] = {"value": None}
PIPELINES: list["Pipeline"] = []

GPU_TYPES = ("NVIDIA_T4", "NVIDIA_V100", "NVIDIA_A10G", "NVIDIA_A100", "NVIDIA_A16", "NVIDIA_H100", "NVIDIA_H200", "NVIDIA_L4", "NVIDIA_L40S")
MAX_CORES = 8
MAX_MEMORY_GB = 64


class AbortJob(Exception):
    """ctx.abort_job(): the job succeeds and commits nothing."""


# ------------------------------------------------------------------------------------------------
# parameter specifications
# ------------------------------------------------------------------------------------------------


def _checks_of(checks) -> list:
    if checks is None:
        return []
    items = list(checks) if isinstance(checks, (list, tuple)) else [checks]
    for c in items:
        if not isinstance(c, code_expectations.Check):
            raise TypeError("checks= takes Check(...) objects (from transforms.api)")
    return items


def _unmarking(value: Any, what: str) -> Optional[dict]:
    """stop_propagating / stop_requiring: Markings([...], on_branches=[...]), a list of marking ids, or one id."""
    if value is None:
        return None
    if isinstance(value, Markings):
        ids, branches = value.marking_ids, value.on_branches
    elif isinstance(value, str):
        ids, branches = [value], None
    elif isinstance(value, (list, tuple, set)):
        ids, branches = list(value), None
    else:
        raise TypeError(f"{what} takes Markings([...]) (or OrgMarkings for stop_requiring), a list of marking ids or one id")
    if not all(isinstance(i, str) and i for i in ids):
        raise TypeError(f"{what}: marking ids are non-empty strings")
    if branches is not None and (isinstance(branches, str) or not all(isinstance(b, str) for b in branches)):
        raise TypeError(f"{what}: on_branches is a list of branch names")
    return {"ids": sorted(set(ids)), "on_branches": list(branches) if branches is not None else None}


class Input:
    """A dataset input, by path or item id (a Files folder is read as a dataset without a schema)."""

    def __init__(self, alias: Optional[str] = None, branch: Optional[str] = None, description: Optional[str] = None,
                 stop_propagating=None, stop_requiring=None, checks=None, transaction_limit: Optional[int] = None, **_: object) -> None:
        if not alias:
            raise TypeError("Input(...) needs the dataset's path or id")
        if transaction_limit is not None and (not isinstance(transaction_limit, int) or transaction_limit < 1):
            raise ValueError("transaction_limit must be a positive number of transactions")
        self.ref = alias
        self.branch = branch
        self.description = description
        self.checks = _checks_of(checks)
        self.transaction_limit = transaction_limit
        # markings of this input that do not propagate to the outputs (stop_requiring: organizations)
        self.stop_propagating = _unmarking(stop_propagating, "stop_propagating")
        self.stop_requiring = _unmarking(stop_requiring, "stop_requiring")


class Output:
    def __init__(self, alias: Optional[str] = None, sever_permissions: bool = False, description: Optional[str] = None, checks=None,
                 folder: Optional[str] = None, **_: object) -> None:
        if not alias:
            raise TypeError("Output(...) needs a dataset name or path")
        name = alias.rstrip("/")
        self.name = name.rsplit("/", 1)[-1]
        self.folder = folder if folder else (name.rsplit("/", 1)[0].strip("/") or None if "/" in name else None)
        self.description = description
        self.checks = _checks_of(checks)
        # the output does not inherit the markings of the transform's inputs
        self.sever_permissions = bool(sever_permissions)


class InputSet:
    """A list of transform inputs: the compute function gets a list of inputs, in the order of `aliases`."""

    def __init__(self, aliases=None, description: Optional[str] = None, **kwargs: object) -> None:
        if isinstance(aliases, str) or not aliases:
            raise TypeError("InputSet(...) takes a non-empty list of dataset paths or ids")
        self.inputs = [Input(a, description=description, **kwargs) for a in aliases]  # type: ignore[arg-type]
        self.description = description


class OutputSet:
    """A list of transform outputs: the compute function gets a list of outputs, in the order of `aliases`."""

    def __init__(self, aliases=None, sever_permissions: bool = False, description: Optional[str] = None, **kwargs: object) -> None:
        if isinstance(aliases, str) or not aliases:
            raise TypeError("OutputSet(...) takes a non-empty list of dataset names or paths")
        self.outputs = [Output(a, sever_permissions=sever_permissions, description=description, **kwargs) for a in aliases]  # type: ignore[arg-type]
        self.description = description


def _expand_sets(params: dict) -> tuple[dict, dict]:
    """InputSet / OutputSet parameters as one Input / Output each (named "param[i]"), and {param: [names]}."""
    out: dict = {}
    sets: dict[str, list[str]] = {}
    for k, v in params.items():
        if isinstance(v, (InputSet, OutputSet)):
            members = v.inputs if isinstance(v, InputSet) else v.outputs
            sets[k] = [f"{k}[{i}]" for i in range(len(members))]
            out.update(zip(sets[k], members))
        else:
            out[k] = v
    return out, sets


def _attach_markings(t: dict, ins: dict, outs: dict, engine: str) -> None:
    """Unmarking rules: markings an input stops propagating / requiring, outputs that sever permissions."""
    rules = {k: {r: getattr(v, r) for r in ("stop_propagating", "stop_requiring") if getattr(v, r, None)} for k, v in ins.items()}
    rules = {k: v for k, v in rules.items() if v}
    sever = [k for k, v in outs.items() if getattr(v, "sever_permissions", False)]
    if sever and engine == "lightweight":
        raise TypeError("sever_permissions is not supported in single-node transforms (use stop_propagating / stop_requiring on the inputs)")
    if rules:
        t["unmarking"] = rules
    if sever:
        t["sever_permissions"] = sever


class MediaSetInput:
    """A media set (a folder in Files, by path or item id) read by a transform."""

    def __init__(self, ref: str, batch_limit: Optional[int] = None, **_: object) -> None:
        if batch_limit is not None and (not isinstance(batch_limit, int) or batch_limit < 1):
            raise ValueError("batch_limit must be a positive number of media items")
        self.ref = ref
        self.batch_limit = batch_limit


class MediaSetOutput:
    """A media set (a folder in Files) a transform writes media items into with put_media_item()."""

    def __init__(self, name: str, folder: str | None = None, should_snapshot: Optional[bool] = None, **_: object) -> None:
        o = Output(name, folder=folder)
        self.name, self.folder = o.name, o.folder
        self.should_snapshot = should_snapshot


class Markings:
    def __init__(self, marking_ids, on_branches=None) -> None:
        self.marking_ids = list(marking_ids or [])
        self.on_branches = on_branches


class OrgMarkings(Markings):
    pass


class Param:
    type = "string"

    def __init__(self, default=None, *, description: Optional[str] = None, **_: object) -> None:
        self.default = self.coerce(default) if default is not None else None
        self.description = description

    def coerce(self, v):
        return v


class BooleanParam(Param):
    type = "boolean"

    def coerce(self, v):
        if isinstance(v, str):
            if v.lower() not in ("true", "false"):
                raise ValueError(f"not a boolean: {v!r}")
            return v.lower() == "true"
        return bool(v)


class IntegerParam(Param):
    type = "integer"

    def coerce(self, v):
        if isinstance(v, bool) or (isinstance(v, float) and not v.is_integer()):
            raise ValueError(f"not an integer: {v!r}")
        return int(v)


class FloatParam(Param):
    type = "float"

    def coerce(self, v):
        return float(v)


class StringParam(Param):
    type = "string"

    def __init__(self, default=None, *, description: Optional[str] = None, allowed_values=None, **kw: object) -> None:
        self.allowed_values = list(allowed_values) if allowed_values else None
        super().__init__(default, description=description, **kw)

    def coerce(self, v):
        v = str(v)
        if self.allowed_values and v not in self.allowed_values:
            raise ValueError(f"{v!r} is not one of {self.allowed_values}")
        return v


class ParamValueInput:
    """A parameter's value in the compute function (`param.value`)."""

    def __init__(self, value) -> None:
        self.value = value

    def __repr__(self) -> str:
        return f"ParamValueInput({self.value!r})"


class _Unavailable:
    """Specs for features this platform has no backend for (virtual tables, containers): loading works, building fails."""

    def __init__(self, what: str, *_: object, **__: object) -> None:
        self.what = what


# Iceberg tables (code_tables.py): TableInput / TableOutput in a transform decorator
TableInput = code_tables.TableInput
TableOutput = code_tables.TableOutput


# ------------------------------------------------------------------------------------------------
# Transform objects and registration
# ------------------------------------------------------------------------------------------------


class Transform:
    """What the transform decorators return: the compute function plus its declaration. Calling it calls the
    compute function (handy in unit tests)."""

    def __init__(self, fn, entry: dict) -> None:
        self._fn = fn
        self._entry = entry
        functools.update_wrapper(self, fn)

    def __call__(self, *a, **kw):
        if not a:
            kw = {**_datasets_for(self._fn, self._entry, kw), **kw}
        return self._fn(*a, **kw)

    @property
    def compute(self):
        return self._fn


def _datasets_for(fn, entry: dict, given: dict) -> dict:
    """Called directly (a unit test) without some inputs / outputs: they come from foundry.transforms.Dataset.get
    (by parameter name, then by path or id), so tests can patch that module with their own datasets."""
    mod = sys.modules.get("foundry.transforms")
    specs = entry.get("_params") or {}
    if mod is None or not specs:
        return {}
    try:
        sig = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return {}
    out: dict = {}
    for name, p in sig.items():
        if name in given or name == "ctx" or p.default is not p.empty or p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
            continue
        spec = specs.get(name)
        refs = [name] + ([spec.ref] if isinstance(spec, Input) else [f"{spec.folder}/{spec.name}" if spec.folder else spec.name] if isinstance(spec, Output) else [])
        for ref in refs:
            ds = mod.Dataset.get(ref)
            if ds is not None:
                out[name] = ds
                break
    return out


# the running transform's inputs and outputs by parameter name, path and id (foundry.transforms.Dataset.get)
CURRENT_IO: dict[str, Any] = {}


class _DatasetHandle:
    """foundry.transforms.Dataset over a declared input or output of the running transform."""

    def __init__(self, target: Any, alias: str) -> None:
        self._target, self.alias = target, alias

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)

    def read_table(self, format: str = "arrow"):  # noqa: A002 - Foundry's parameter name
        t = self._target
        if format == "pandas":
            return t.pandas()
        if format in ("polars", "lazy-polars"):
            return t.polars(lazy=format == "lazy-polars")
        if format == "arrow":
            return t.arrow() if hasattr(t, "arrow") else to_arrow(t.dataframe())
        raise ValueError('read_table(format=...) is "arrow", "pandas", "polars" or "lazy-polars"')

    def read_pandas(self):
        return self.read_table("pandas")

    def read_polars(self):
        return self.read_table("polars")

    def write_table(self, df) -> None:
        t = self._target
        (t.write_table if hasattr(t, "write_table") else t.write_dataframe)(df)

    write_pandas = write_table
    write_polars = write_table

    def files(self):
        return self._target.filesystem()


class _RemoteDataset:
    """foundry.transforms.Dataset over another dataset, read by item id through the API as the user running the build."""

    def __init__(self, item_id: str) -> None:
        self.alias = item_id

    def read_table(self, format: str = "arrow"):  # noqa: A002
        import urllib.request

        import pyarrow.parquet as pq

        url = f"{os.environ.get('BLUESANDAI_API_URL', 'http://127.0.0.1:8000').rstrip('/')}/api/drive/items/{self.alias}/content"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {os.environ.get('BLUESANDAI_API_TOKEN', '')}"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                table = pq.read_table(io.BytesIO(r.read()))
        except Exception as e:  # noqa: BLE001
            raise LookupError(f"Dataset {self.alias} could not be read: {e}") from None
        if format == "pandas":
            return table.to_pandas()
        if format in ("polars", "lazy-polars"):
            import polars as pl

            df = pl.from_arrow(table)
            return df.lazy() if format == "lazy-polars" else df
        return table

    def read_pandas(self):
        return self.read_table("pandas")

    def read_polars(self):
        return self.read_table("polars")

    def write_table(self, df) -> None:
        raise PermissionError(f"Dataset {self.alias} is not an output of this transform: only declared outputs can be written")

    write_pandas = write_polars = write_table


class FoundryDataset:
    """foundry.transforms.Dataset: Dataset.get(alias). Inside a transform, a declared input or output (its parameter
    name, path or id) returns it; any other dataset is read (not written) by its item id."""

    @staticmethod
    def get(alias: str):
        if alias in CURRENT_IO:
            return _DatasetHandle(CURRENT_IO[alias], alias)
        if isinstance(alias, str) and re.fullmatch(r"[0-9a-f]{16}", alias):
            return _RemoteDataset(alias)
        raise LookupError(f'Dataset "{alias}" is not an input or output of this transform (other datasets are read by item id)')


def _io_of(param: Any) -> Any:
    if isinstance(param, str):
        if param not in CURRENT_IO:
            raise LookupError(f'"{param}" is not an input or output of this transform')
        return CURRENT_IO[param]
    return param._target if isinstance(param, _DatasetHandle) else param


class FoundryDataSidecarFileSystem:
    """The raw files of a dataset input / output in a lightweight transform (its filesystem())."""

    def __init__(self, param: Any, *_: object, **__: object) -> None:
        self._fs = _io_of(param).filesystem()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._fs, name)


class FoundryDataSidecarFile:
    """One raw file of a dataset input / output in a lightweight transform, opened like open(): `with
    FoundryDataSidecarFile(output, "out.csv", "w") as f: ...`."""

    def __init__(self, param: Any, path: str, mode: str = "r", **kwargs: object) -> None:
        self._fs = _io_of(param).filesystem()
        self.path, self.mode, self._kwargs = path, mode, kwargs
        self._f: Any = None

    def open(self):
        self._f = self._fs.open(self.path, self.mode, **self._kwargs)
        return self._f

    def __enter__(self):
        return self.open().__enter__()

    def __exit__(self, *exc: Any) -> Any:
        return self._f.__exit__(*exc)

    def __repr__(self) -> str:
        return f"<Transform {self._entry['key']}>"


def _source_file(fn) -> str:
    """The repository-relative file a function is defined in (whatever module imported it first)."""
    try:
        return Path(fn.__code__.co_filename).resolve().relative_to(Path(CURRENT_FILE["root"]).resolve()).as_posix()
    except (KeyError, ValueError):
        return CURRENT_FILE["path"]


def _entry(key: str, file: str, function: str, line: int, kind: str, output: dict, inputs: dict, doc: str = "", **extra) -> dict:
    return {"key": key, "file": file, "function": function, "line": line, "kind": kind,
            "language": {"sql": "sql", "java": "java"}.get(kind, "python"), "output": output, "output_param": None,
            "inputs": inputs, "media_inputs": {}, "media_outputs": {}, "incremental": None, "uses_ctx": False,
            "doc": doc[:500], **extra}


def _unique_key(key: str) -> str:
    """Generated transforms (a loop over sources) share a function name: number the later ones."""
    keys = {t["key"] for t in REGISTRY}
    if key not in keys:
        return key
    i = 2
    while f"{key}#{i}" in keys:
        i += 1
    return f"{key}#{i}"


def _unwrap(obj):
    return obj._fn if isinstance(obj, Transform) else obj


def _register(fn, output, inputs: dict, kind: str, media_inputs: dict | None = None, media_outputs: dict | None = None) -> dict:
    rel = _source_file(fn)
    if output is not None:
        out = {"name": output.name, "folder": output.folder}
    else:
        first = next(iter(media_outputs.values()))
        out = {"name": first.name, "folder": first.folder, "media_set": True}
    t = _entry(_unique_key(f"{rel}::{fn.__name__}"), rel, fn.__name__, fn.__code__.co_firstlineno, kind, out, {k: v.ref for k, v in inputs.items()},
               (fn.__doc__ or "").strip(), _fn=fn)
    t["media_inputs"] = {k: v.ref for k, v in (media_inputs or {}).items()}
    t["media_outputs"] = {k: {"name": v.name, "folder": v.folder} for k, v in (media_outputs or {}).items()}
    try:
        t["uses_ctx"] = "ctx" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        pass
    REGISTRY.append(t)
    return t


def _uses_pyspark(fn) -> bool:
    """Whether the compute function's module works with pyspark (imports it, or uses its objects)."""
    if LEGACY_ENGINE["value"] in ("spark", "pandas"):
        return LEGACY_ENGINE["value"] == "spark"
    for v in list(getattr(fn, "__globals__", {}).values()):
        mod = v.__name__ if isinstance(v, types.ModuleType) else getattr(v, "__module__", None)
        # geospatial_tools (the legacy geospatial library) is Spark-only
        if isinstance(mod, str) and mod.split(".", 1)[0] in ("pyspark", "geospatial_tools", "code_geo"):
            return True
    return False


def transform_df(output: Output, **inputs: Input):
    """The DataFrame transform: the returned DataFrame is the output. On Spark (see the module docstring) inputs are
    pyspark DataFrames; otherwise pandas DataFrames."""

    def wrap(fn):
        if not isinstance(output, Output):
            raise TypeError("transform_df's first argument must be an Output(...)")
        bad = [k for k, v in inputs.items() if not isinstance(v, Input)]
        if bad:
            raise TypeError(f"transform_df inputs must be Input(...): {', '.join(bad)} (media sets need @transform)")
        if _uses_pyspark(fn):
            return _spark_df(fn, output, inputs)
        t = _register(fn, output, inputs, "df")
        t["_df_spec"] = (output, inputs)
        _attach_checks(t, {"$output": output, **inputs})
        return Transform(fn, t)

    return wrap


def _spark_df(fn, output: Output, inputs: dict) -> "Transform":
    tr = _register_new(fn, "spark", {"$output": output, **inputs}, {}, returns="$output")
    tr._entry["legacy"] = "transform_df"
    tr._entry["_df_spec"] = (output, inputs)
    return tr


def transform_pandas(output: Output, **inputs: Input):
    """pandas DataFrames in, the returned pandas DataFrame is the output."""
    return transform_df(output, **inputs)


def transform_polars(output: Output, **inputs: Input):
    """Polars DataFrames in, the returned Polars DataFrame (or LazyFrame) is the output."""

    def wrap(fn):
        tr = transform_df(output, **inputs)(fn)
        tr._entry["engine"] = "polars"
        return tr

    return wrap


def _legacy_transform(**params):
    def wrap(fn):
        outs = {k: v for k, v in params.items() if isinstance(v, Output)}
        ins = {k: v for k, v in params.items() if isinstance(v, Input)}
        m_ins = {k: v for k, v in params.items() if isinstance(v, MediaSetInput)}
        m_outs = {k: v for k, v in params.items() if isinstance(v, MediaSetOutput)}
        tables = any(isinstance(v, (code_tables.TableInput, code_tables.TableOutput)) for v in params.values())
        spark = _uses_pyspark(fn) or tables
        if spark or len(outs) > 1 or any(isinstance(v, (Param, _Unavailable, code_models.ModelInput, model_lib.ModelOutput, InputSet, OutputSet))
                                         for v in params.values()):
            # Spark, several outputs, parameters or models: Foundry's API (on Spark, or lightweight)
            tr = _Using("spark" if spark else "lightweight", params)(fn)
            tr._entry["legacy"] = "transform"
            # @sidecar above it makes a lightweight one a Spark transform
            tr._entry["_params"] = dict(params)
            return tr
        other = [k for k in params if k not in outs and k not in ins and k not in m_ins and k not in m_outs]
        if other:
            raise TypeError(f"@transform parameters must be Input, Output, MediaSetInput or MediaSetOutput: {', '.join(other)}")
        if not outs and not m_outs:
            raise TypeError("@transform needs an Output(...) (and/or MediaSetOutput(...) for media sets)")
        out_name, out = next(iter(outs.items())) if outs else (None, None)
        t = _register(fn, out, ins, "transform", m_ins, m_outs)
        t["output_param"] = out_name
        t["_params"] = dict(params)
        _attach_checks(t, {**ins, **outs})
        _attach_markings(t, ins, outs, "transform")
        return Transform(fn, t)

    return wrap


def _attach_checks(t: dict, specs: dict) -> None:
    checks: dict[str, list] = {}
    names: set[str] = set()
    for param, spec in specs.items():
        for c in getattr(spec, "checks", None) or []:
            if c.name in names:
                raise ValueError(f'two checks are named "{c.name}": check names must be unique in a transform')
            names.add(c.name)
            checks.setdefault(param, []).append(c)
    if checks:
        t["_checks"] = checks
        t["checks"] = {p: [{"name": c.name, "on_error": c.on_error, "description": c.description} for c in cs] for p, cs in checks.items()}


def _validate_resources(cpu_cores=None, memory_gb=None, memory_mb=None, gpu_type=None) -> dict:
    if memory_gb is not None and memory_mb is not None:
        raise ValueError("Only one of memory_gb and memory_mb can be configured")
    out: dict[str, Any] = {}
    if cpu_cores is not None:
        cpu = float(cpu_cores)
        if cpu <= 0 or cpu > MAX_CORES:
            raise ValueError(f"cpu_cores must be above 0 and at most {MAX_CORES}")
        out["cpu_cores"] = cpu
    mem = memory_gb * 1024 if memory_gb is not None else memory_mb
    if mem is not None:
        if mem <= 0 or mem > MAX_MEMORY_GB * 1024:
            raise ValueError(f"memory must be above 0 and at most {MAX_MEMORY_GB} GB")
        out["memory_mb"] = int(mem)
    if gpu_type is not None:
        if gpu_type not in GPU_TYPES:
            raise ValueError(f"gpu_type must be one of {', '.join(GPU_TYPES)}")
        out["gpu_type"] = gpu_type
    return out


class _Using:
    """`transform.using(...)` / `transform.spark.using(...)`: a decorator that can be configured first."""

    def __init__(self, engine: str, params: dict, blocked: Optional[str] = None) -> None:
        self.engine = engine
        self.params = params
        self.resources: dict = {}
        self.blocked = blocked
        self.container: Optional[dict] = None

    def with_resources(self, cpu_cores=None, memory_gb=None, memory_mb=None, gpu_type=None) -> "_Using":
        if self.engine == "spark":
            raise TypeError("Spark transforms are sized with Spark profiles (@configure(profile=[...])), not with_resources()")
        self.resources = _validate_resources(cpu_cores, memory_gb, memory_mb, gpu_type)
        return self

    def with_container(self, container_image=None, container_tag=None, **_: object) -> "_Using":
        """Bring your own container (byoc_slot.py): the programs the transform starts run from this image."""
        self.container = _container(container_image, container_tag, self.engine)
        return self

    def with_compute(self, *_: object, **__: object) -> "_Using":
        return self

    def with_dependencies(self, *_: object, **__: object) -> "_Using":
        return self

    def with_warehouse(self, *_: object, **__: object) -> "_Using":
        return self

    def with_engine(self, *_: object, **__: object) -> "_Using":
        return self

    def __call__(self, fn):
        res = _register_new(fn, self.engine, self.params, self.resources, self.blocked)
        if self.container:
            res._entry["container"] = self.container
        return res


def _container(image, tag, engine: str) -> dict:
    if engine == "spark":
        raise TypeError("with_container is for lightweight transforms (@transform.using): Spark transforms take containers with @sidecar")
    if not image or not tag:
        raise TypeError("with_container needs container_image and container_tag")
    if str(tag) == "latest":
        raise TypeError("with_container: images tagged latest are not run: use a versioned tag")
    return {"image": str(image), "tag": str(tag)}


def _register_new(fn, engine: str, params: dict, resources: dict, blocked: Optional[str] = None, returns: Optional[str] = None) -> Transform:
    """`returns`: the output the compute function's return value is written to (transform_df on Spark)."""
    if isinstance(fn, Transform):
        raise TypeError("a transform decorator is applied twice")
    declared = params
    params, sets = _expand_sets(params)
    outs = {k: v for k, v in params.items() if isinstance(v, Output)}
    ins = {k: v for k, v in params.items() if isinstance(v, Input)}
    m_ins = {k: v for k, v in params.items() if isinstance(v, MediaSetInput)}
    m_outs = {k: v for k, v in params.items() if isinstance(v, MediaSetOutput)}
    prm = {k: v for k, v in params.items() if isinstance(v, Param)}
    models = {k: v for k, v in params.items() if isinstance(v, code_models.ModelInput)}
    # palantir_models.transforms.ModelOutput: the transform publishes model versions (model_lib.py)
    m_models = {k: v for k, v in params.items() if isinstance(v, model_lib.ModelOutput)}
    t_ins = {k: v for k, v in params.items() if isinstance(v, code_tables.TableInput)}
    t_outs = {k: v for k, v in params.items() if isinstance(v, code_tables.TableOutput)}
    unavailable = [v.what for v in params.values() if isinstance(v, _Unavailable)]
    other = [k for k in params if k not in outs and k not in ins and k not in m_ins and k not in m_outs and k not in prm and k not in models
             and k not in t_ins and k not in t_outs and k not in m_models and not isinstance(params[k], _Unavailable)]
    if other:
        raise TypeError("transform parameters must be Input, Output, TableInput, TableOutput, MediaSetInput, MediaSetOutput, a *Param or a model "
                        f"input: {', '.join(other)}")
    limits = {k: v.transaction_limit for k, v in ins.items() if v.transaction_limit}
    batch = {k: v.batch_limit for k, v in m_ins.items() if v.batch_limit}
    if (limits or batch) and engine != "spark":
        raise TypeError("transaction_limit / batch_limit work in Spark transforms only: a lightweight transform cannot limit its incremental inputs")
    if "ctx" in params:
        raise TypeError("no input or output may be named ctx (it is the transform context)")
    if not outs and not m_outs and not t_outs and not m_models and not unavailable:
        raise TypeError("a transform needs at least one Output(...), TableOutput(...), MediaSetOutput(...) or ModelOutput(...)")
    try:
        sig = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        sig = {}
    var_kw = any(p.kind == p.VAR_KEYWORD for p in sig.values())
    missing = [k for k in declared if k not in sig and not var_kw and k != returns]
    if missing:
        raise TypeError(f"{fn.__name__}() does not take the transform's parameter(s) {', '.join(missing)}: the function signature must match the decorator")
    rel = _source_file(fn)
    first_name, first = next(iter(outs.items())) if outs else (None, None)
    out = ({"name": first.name, "folder": first.folder} if first else
           {"name": next(iter(m_outs.values())).name, "folder": next(iter(m_outs.values())).folder, "media_set": True} if m_outs else
           {"name": next(iter(t_outs.values())).name, "folder": next(iter(t_outs.values())).folder, "table": True} if t_outs else
           {"name": next(iter(m_models.values())).name, "folder": next(iter(m_models.values())).folder, "model": True} if m_models else
           {"name": fn.__name__, "folder": None})
    t = _entry(_unique_key(f"{rel}::{fn.__name__}"), rel, fn.__name__, fn.__code__.co_firstlineno, engine, out, {k: v.ref for k, v in ins.items()},
               (fn.__doc__ or "").strip(), _fn=fn)
    t["output_param"] = first_name
    t["outputs"] = {k: {"name": v.name, "folder": v.folder, **({"description": v.description} if v.description else {})} for k, v in outs.items()}
    t["media_inputs"] = {k: v.ref for k, v in m_ins.items()}
    t["media_outputs"] = {k: {"name": v.name, "folder": v.folder} for k, v in m_outs.items()}
    t["table_inputs"] = {k: v.ref for k, v in t_ins.items()}
    t["table_outputs"] = {k: {"name": v.name, "folder": v.folder, "ref": v.ref, **({"source": v.source, "locator": v.locator} if v.locator else {})}
                          for k, v in t_outs.items()}
    if first_name is None and t_outs and not m_outs:
        t["output_param"] = next(iter(t_outs))
    t["params"] = {k: {"type": v.type, "default": v.default, "description": v.description} for k, v in prm.items()}
    t["_param_specs"] = prm
    t["models"] = {k: v.describe() for k, v in models.items()}
    t["_model_specs"] = models
    if m_models:
        t["model_outputs"] = {k: v.describe() for k, v in m_models.items()}
        t["_model_output_specs"] = m_models
    t["returns"] = returns
    if limits:
        t["transaction_limits"] = limits
    if batch:
        t["media_batch_limits"] = batch
    t["files_inputs"] = True
    t["resources"] = resources
    t["uses_ctx"] = "ctx" in sig
    t["_params"] = dict(params)
    if sets:
        # the compute function gets each InputSet / OutputSet as a list
        t["sets"] = sets
    _attach_markings(t, ins, outs, engine)
    if blocked or unavailable:
        t["blocked"] = blocked or unavailable[0]
    if resources.get("gpu_type"):
        t["blocked"] = f"with_resources(gpu_type={resources['gpu_type']!r}): no GPUs are available to this project"
    _attach_checks(t, {**ins, **outs})
    REGISTRY.append(t)
    return Transform(fn, t)


class _SparkFactory:
    def using(self, **params) -> _Using:
        return _Using("spark", params)

    def __call__(self, **params) -> _Using:
        return _Using("spark", params)


class _PushdownFactory:
    def __init__(self, system: str) -> None:
        self.system = system

    def using(self, **params) -> _Using:
        return _Using("lightweight", params, f"compute pushdown to {self.system} needs virtual tables, which this platform does not have")

    __call__ = using


class _TransformFactory:
    """`transform`: `@transform(...)` (the original API), `.using(...)`, `.lightweight(...)`, `.spark.using(...)`."""

    spark = _SparkFactory()
    databricks = _PushdownFactory("Databricks")
    snowflake = _PushdownFactory("Snowflake")
    bigquery = _PushdownFactory("BigQuery")

    def __call__(self, **params):
        return _legacy_transform(**params)

    def using(self, **params) -> _Using:
        return _Using("lightweight", params)

    def lightweight(self, **params) -> _Using:
        return _Using("lightweight", params)


transform = _TransformFactory()


def lightweight(_maybe_function=None, cpu_cores=None, memory_mb=None, memory_gb=None, gpu_type=None, container_image=None, container_tag=None, **_: object):
    """`@lightweight` (or `@lightweight(cpu_cores=...)`) above `@transform(...)`: run it as a single-node transform."""

    def wrap(obj):
        if not isinstance(obj, Transform):
            raise TypeError("@lightweight must be placed above @transform(...)")
        t = obj._entry
        if t["kind"] == "lightweight":
            t["resources"] = {**t.get("resources", {}), **_validate_resources(cpu_cores, memory_gb, memory_mb, gpu_type)}
            return obj
        if t["kind"] != "transform":
            raise TypeError("@lightweight goes above @transform(...)")
        REGISTRY.remove(t)
        new = _Using("lightweight", t["_params"])
        new.resources = _validate_resources(cpu_cores, memory_gb, memory_mb, gpu_type)
        if container_image:
            new.container = _container(container_image, container_tag, "lightweight")
        res = new(obj._fn)
        if t.get("incremental"):
            res._entry["incremental"] = t["incremental"]
        return res

    if callable(_maybe_function):
        return wrap(_maybe_function)
    return wrap


class _Incremental:
    """What @incremental(...) returns: the decorator, plus `.with_table_incremental_options(table_read_mode=...)` for
    Iceberg table inputs (append_only, the default, or changelog)."""

    def __init__(self, wrap) -> None:
        self._wrap = wrap
        self.table_read_mode = "append_only"

    def with_table_incremental_options(self, table_read_mode: str = "append_only", **_: object) -> "_Incremental":
        if table_read_mode not in code_tables.READ_MODES:
            raise ValueError(f"table_read_mode must be one of {', '.join(code_tables.READ_MODES)}")
        self.table_read_mode = table_read_mode
        return self

    def __call__(self, obj):
        res = self._wrap(obj)
        t = getattr(res, "_entry", None) or next((x for x in reversed(REGISTRY) if x.get("_fn") is res), None)
        if t and t.get("incremental"):
            t["incremental"]["table_read_mode"] = self.table_read_mode
            if (t.get("table_inputs") or t.get("table_outputs")) and not t["incremental"]["v2_semantics"]:
                raise TypeError("Iceberg table inputs and outputs need @incremental(v2_semantics=True)")
            if self.table_read_mode == "changelog" and t["kind"] != "spark":
                raise TypeError('table_read_mode="changelog" is available in Spark transforms only (@transform.spark.using)')
        return res


def incremental(require_incremental: bool = False, semantic_version: int = 1, snapshot_inputs=None, allow_retention: bool = False,
                allow_user_deletes: bool = False, strict_append: bool = False, v2_semantics: bool = False, **_: object):
    """Stack above a transform decorator: process only rows added to inputs since the last build."""

    def wrap(obj):
        t = getattr(obj, "_entry", None) or next((x for x in reversed(REGISTRY) if x.get("_fn") is obj), None)
        if not t:
            raise TypeError("@incremental must be placed above @transform(...), @transform.using(...) or @transform_df(...)")
        snaps = list(snapshot_inputs or [])
        unknown = [s for s in snaps if s not in t["inputs"] and s not in (t.get("table_inputs") or {})]
        if unknown:
            raise TypeError(f"snapshot_inputs names unknown inputs: {', '.join(unknown)}")
        if allow_user_deletes and not v2_semantics:
            raise TypeError("allow_user_deletes=True requires v2_semantics=True")
        if allow_user_deletes and t["kind"] == "lightweight":
            raise TypeError("allow_user_deletes is not supported for lightweight transforms")
        if not t["inputs"] and not t.get("media_inputs") and not t.get("table_inputs"):
            raise TypeError("an incremental transform must have at least one input")
        if (t.get("transaction_limits") or t.get("media_batch_limits")) and not v2_semantics:
            raise TypeError("transaction_limit / batch_limit need @incremental(v2_semantics=True)")
        both = sorted(set(t.get("transaction_limits") or {}) & set(snaps))
        if both:
            raise TypeError(f"a snapshot input cannot have a transaction limit: {', '.join(both)}")
        t["incremental"] = {"require_incremental": bool(require_incremental), "semantic_version": int(semantic_version),
                            "snapshot_inputs": snaps, "strict_append": bool(strict_append), "allow_retention": bool(allow_retention),
                            "allow_user_deletes": bool(allow_user_deletes), "v2_semantics": bool(v2_semantics)}
        return obj

    return _Incremental(wrap)


class ComputeBackend:
    """Spark's execution engine. VELOX (native acceleration) is accepted; here it runs on standard Spark."""

    SPARK = "SPARK"
    VELOX = "VELOX"


# Spark profiles: what each sets on the local Spark session (memory in MB, cores, shuffle partitions, ...)
SPARK_PROFILES: dict[str, dict[str, Any]] = {
    **{f"DRIVER_MEMORY_{k}": {"driver_memory_mb": v} for k, v in (("SMALL", 2048), ("MEDIUM", 4096), ("LARGE", 8192), ("EXTRA_LARGE", 16384))},
    **{f"EXECUTOR_MEMORY_{k}": {"executor_memory_mb": v} for k, v in (("SMALL", 1024), ("MEDIUM", 2048), ("LARGE", 4096), ("EXTRA_LARGE", 8192))},
    **{f"EXECUTOR_CORES_{k}": {"executor_cores": v} for k, v in (("EXTRA_SMALL", 1), ("SMALL", 1), ("MEDIUM", 2), ("LARGE", 4), ("EXTRA_LARGE", 8))},
    **{f"DRIVER_CORES_{k}": {"driver_cores": v} for k, v in (("SMALL", 1), ("MEDIUM", 2), ("LARGE", 4))},
    **{f"NUM_EXECUTORS_{n}": {"executors": n} for n in (1, 2, 4, 8, 16, 32, 64)},
    **{f"SHUFFLE_PARTITIONS_{k}": {"shuffle_partitions": v} for k, v in (("SMALL", 4), ("MEDIUM", 50), ("LARGE", 200), ("EXTRA_LARGE", 800))},
    **{f"EXECUTOR_MEMORY_OFFHEAP_FRACTION_{k}": {"offheap_fraction": v} for k, v in (("LOW", 0.2), ("MODERATE", 0.4), ("HIGH", 0.6), ("VERY_HIGH", 0.8))},
    "CROSS_JOIN_ENABLED": {"cross_join": True},
    "AUTO_BROADCAST_JOIN_DISABLED": {"broadcast_disabled": True},
    "ADAPTIVE_ENABLED": {"adaptive": True},
    "ADAPTIVE_DISABLED": {"adaptive": False},
    "DYNAMIC_ALLOCATION_ENABLED": {},
    "DYNAMIC_ALLOCATION_DISABLED": {},
    "KUBERNETES_NO_EXECUTORS": {"executors": 0},
    # distributed model training (XGBoost's Spark estimators): executors reach each other on any port. Local Spark
    # tasks share one machine, so there is nothing to open
    "KUBERNETES_OPEN_PORTS_ALL": {},
    # geospatial-tools' profile (Apache Sedona on Foundry; here its functions are Python UDFs, nothing to set)
    "GEOSPARK": {},
}
# the session the next Spark transform gets (set by the runner from the transform's profiles)
SPARK_CONF: dict[str, Any] = {}


def load_custom_profiles(settings: dict) -> list[str]:
    """Custom Transforms profiles from repoSettings.json "sparkProfiles": {"NAME": {"spark.sql.files.maxPartitionBytes":
    "64m", ...}}: Spark SQL settings (spark.sql.*) applied by @configure(profile=["NAME"]). Returns problems."""
    problems = []
    for name, conf in (settings.get("sparkProfiles") or {}).items() if isinstance(settings.get("sparkProfiles"), dict) else []:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_\-]{0,63}", str(name)) or not isinstance(conf, dict):
            problems.append(f"sparkProfiles: {name!r} must be a name with a map of Spark settings")
            continue
        bad = [k for k in conf if not re.fullmatch(r"spark\.sql\.[A-Za-z0-9_.]+", str(k))]
        if bad:
            problems.append(f"sparkProfiles {name}: only spark.sql.* settings can be set ({', '.join(map(str, bad))})")
            continue
        SPARK_PROFILES[name] = {"conf": {str(k): str(v) for k, v in conf.items()}}
    return problems


def spark_settings(profiles: list[str]) -> dict:
    """Profiles → settings for spark_session(); ValueError for unknown or inconsistent profiles."""
    unknown = [p for p in profiles if p not in SPARK_PROFILES]
    if unknown:
        raise ValueError(f"unknown Spark profile {', '.join(unknown)} (available: {', '.join(sorted(SPARK_PROFILES))})")
    out: dict[str, Any] = {}
    for p in profiles:
        prof = SPARK_PROFILES[p]
        out.update({k: v for k, v in prof.items() if k != "conf"})
        if prof.get("conf"):
            out["conf"] = {**out.get("conf", {}), **prof["conf"]}
    if "offheap_fraction" in out and "executor_memory_mb" not in out:
        raise ValueError("fractional off-heap profiles (EXECUTOR_MEMORY_OFFHEAP_FRACTION_*) require an EXECUTOR_MEMORY_* profile")
    return out


def configure(profile=None, allowed_run_duration=None, run_as_user: bool = False, backend=None, **_: object):
    """Spark profiles, the compute backend and the allowed run duration of a Spark transform. On the original
    decorators it also makes the transform a Spark transform (configure is Spark's)."""

    profiles = [profile] if isinstance(profile, str) else list(profile or [])
    spark_settings(profiles)

    def wrap(obj):
        t = getattr(obj, "_entry", None)
        if not t:
            raise TypeError("@configure must be placed above a transform decorator")
        if t["kind"] in ("df", "transform"):
            inc = t.get("incremental")
            REGISTRY.remove(t)
            if t["kind"] == "df":
                output, inputs = t["_df_spec"]
                obj = _spark_df(obj._fn, output, inputs)
            else:
                obj = _Using("spark", t["_params"])(obj._fn)
                obj._entry["legacy"] = "transform"
            obj._entry["incremental"] = inc
            t = obj._entry
        if backend is not None:
            t["backend"] = str(getattr(backend, "value", backend))
        if allowed_run_duration is not None:
            if t["kind"] == "lightweight":
                raise TypeError("allowed_run_duration is not supported for lightweight transforms")
            secs = allowed_run_duration.total_seconds() if isinstance(allowed_run_duration, timedelta) else float(allowed_run_duration)
            t["max_duration_s"] = int(secs)
        if profile:
            t["profiles"] = [profile] if isinstance(profile, str) else list(profile)
        return obj

    return wrap


# transforms.sidecar (palantir.com/docs/foundry/transforms-container/transforms-sidecar): resource profiles of the
# sidecar container (CPU cores, memory GB, GPU, shared memory GB)
from container_runtime import SIDECAR_PROFILES  # noqa: E402


class Volume:
    """A shared volume between the executor and its sidecar: /opt/palantir/sidecars/shared-volumes/<name>."""

    def __init__(self, name: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name or ""):
            raise ValueError(f"invalid volume name {name!r}")
        self.name = name

    @property
    def path(self) -> str:
        return f"/opt/palantir/sidecars/shared-volumes/{self.name}"


# -- external transforms (transforms-external-systems) ------------------------------------------


class Source:
    """A Data Connection source imported into the repository (Settings → External systems), by RID or name."""

    def __init__(self, rid: str) -> None:
        if not rid or not isinstance(rid, str):
            raise TypeError("Source needs the source's RID (or API name)")
        self.rid = rid


class _HttpsConnection:
    def __init__(self, source: "_BoundSource") -> None:
        self._source = source
        self.url = source._describe()["domains"][0]["url"].rstrip("/")

    def get_client(self):
        """A requests Session for the source's domain: requests go through the platform, which adds the source's
        credentials, applies egress (and agent proxy) policies and the source's export controls."""
        return _ProxySession(self._source)


def _proxy_session_class():
    import requests

    class ProxySession(requests.Session):
        def __init__(self, source: "_BoundSource") -> None:
            super().__init__()
            self._source = source

        def request(self, method, url, params=None, data=None, headers=None, json=None, timeout=None, **_kw):  # noqa: A002, ANN001
            import base64 as b64

            body = None
            if data is not None:
                body = data if isinstance(data, (bytes, bytearray)) else (str(data).encode() if not isinstance(data, dict) else None)
            payload = {"source": self._source._rid, "method": str(method).upper(), "url": url, "params": params,
                       "headers": {**dict(self.headers or {}), **(headers or {})}, "json": json, "form": data if isinstance(data, dict) else None,
                       "data_b64": b64.b64encode(body).decode() if body is not None else None, "timeout": timeout, "has_inputs": self._source._has_inputs}
            res = self._source._call("request", payload)
            r = requests.Response()
            r.status_code = int(res["status"])
            r._content = b64.b64decode(res.get("content_b64") or "")
            r.headers = requests.structures.CaseInsensitiveDict(res.get("headers") or {})
            r.url = res.get("url") or url
            r.encoding = requests.utils.get_encoding_from_headers(r.headers)
            r.reason = res.get("reason") or ""
            return r

    return ProxySession


def _ProxySession(source):  # noqa: N802 - a class built lazily (requests is imported only when used)
    return _proxy_session_class()(source)


class _BoundSource:
    """What a transform receives for a Source: its HTTPS connection (REST API sources) and its secrets."""

    def __init__(self, rid: str, has_inputs: bool) -> None:
        self._rid, self._has_inputs = rid, has_inputs
        self._info = None

    def _call(self, what: str, payload: dict) -> dict:
        import json as _json
        import urllib.error
        import urllib.request

        repo = os.environ.get("BLUESANDAI_USAGE_RESOURCE", "").removeprefix("code_repo:")
        if not repo:
            raise RuntimeError("external systems are used from a Code Repositories build or preview")
        url = f"{os.environ.get('BLUESANDAI_API_URL', 'http://127.0.0.1:8000').rstrip('/')}/api/code-repos/{repo}/external/{what}"
        req = urllib.request.Request(url, data=_json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('BLUESANDAI_API_TOKEN', '')}"})
        try:
            with urllib.request.urlopen(req, timeout=float(payload.get("timeout") or 60) + 30) as r:
                return _json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                detail = _json.loads(e.read()).get("detail")
            except Exception:  # noqa: BLE001
                detail = str(e)
            raise RuntimeError(f"source {self._rid}: {detail}") from None

    def _describe(self) -> dict:
        if self._info is None:
            self._info = self._call("describe", {"source": self._rid})
        return self._info

    def get_https_connection(self) -> _HttpsConnection:
        return _HttpsConnection(self)

    def get_secret(self, name: str) -> str:
        return self._call("secret", {"source": self._rid, "name": name})["value"]

    @property
    def secrets(self) -> list[str]:
        return list(self._describe().get("secrets") or [])


def external_systems(**sources: Source):
    """Above a transform decorator: each keyword names a Source the compute function receives under that name."""
    for k, v in sources.items():
        if not isinstance(v, Source):
            raise TypeError(f"external_systems({k}=...) takes a Source(...)")

    def wrap(obj):
        t = getattr(obj, "_entry", None) or next((x for x in reversed(REGISTRY) if x.get("_fn") is obj), None)
        if not t:
            raise TypeError("@external_systems must be placed above a transform decorator")
        original = t["_fn"]
        has_inputs = bool(t.get("inputs") or t.get("media_inputs") or t.get("table_inputs"))
        t["external_sources"] = {k: v.rid for k, v in sources.items()}

        @functools.wraps(original)
        def inner(*a, **kw):
            for k, v in sources.items():
                kw.setdefault(k, _BoundSource(v.rid, has_inputs))
            return original(*a, **kw)

        try:
            sig = inspect.signature(original)
            inner.__signature__ = sig.replace(parameters=[p for n, p in sig.parameters.items() if n not in sources])  # type: ignore[attr-defined]
        except (TypeError, ValueError):
            pass
        t["_fn"] = inner
        if isinstance(obj, Transform):
            obj._fn = inner
        return obj

    return wrap


def sidecar(image: str, tag: str = None, volumes=None, resource_profile=None, **_: object):
    """Launch one container of `image:tag` (an image in an Artifacts repository added to the repository's Settings →
    Libraries) alongside each executor of a PySpark transform, and its driver. Above the transform decorator."""
    if not image or not isinstance(image, str):
        raise TypeError("@sidecar needs image='<image name>'")
    if not tag:
        raise TypeError("@sidecar needs tag='<tag>' (images tagged latest are not run)")
    if resource_profile is not None and str(getattr(resource_profile, "value", resource_profile)) not in SIDECAR_PROFILES:
        raise ValueError(f"unknown resource_profile {resource_profile!r}: one of {', '.join(SIDECAR_PROFILES)}")
    vols = [v.name if isinstance(v, Volume) else str(v) for v in (volumes or [])]

    def wrap(obj):
        t = getattr(obj, "_entry", None)
        if not t:
            raise TypeError("@sidecar must be placed above a transform decorator")
        if t["kind"] == "lightweight" and t.get("legacy") != "transform":
            raise TypeError("Spark sidecar transforms run on Spark: use @transform.spark.using, @transform or @transform_df")
        if t["kind"] == "lightweight":
            # a legacy @transform with several outputs: on Spark
            inc = t.get("incremental")
            REGISTRY.remove(t)
            obj = _Using("spark", t["_params"])(t["_fn"])
            obj._entry["legacy"] = "transform"
            obj._entry["incremental"] = inc
            t = obj._entry
        elif t["kind"] in ("df", "transform"):
            # the original decorators become Spark transforms (sidecars run next to Spark executors)
            inc = t.get("incremental")
            REGISTRY.remove(t)
            if t["kind"] == "df":
                output, inputs = t["_df_spec"]
                obj = _spark_df(obj._fn, output, inputs)
            else:
                obj = _Using("spark", t["_params"])(obj._fn)
                obj._entry["legacy"] = "transform"
            obj._entry["incremental"] = inc
            t = obj._entry
        t["sidecar"] = {"image": image, "tag": str(tag), "volumes": vols,
                        "resource_profile": str(getattr(resource_profile, "value", resource_profile)) if resource_profile else None}
        return obj

    return wrap


class Pipeline:
    """The project's transforms. With a setup.py `transforms.pipelines` entry point only the transforms added to
    the pipeline it names can be built."""

    def __init__(self) -> None:
        self._transforms: list[Transform] = []
        PIPELINES.append(self)

    @property
    def transforms(self) -> list[Transform]:
        return list(self._transforms)

    def add_transforms(self, *transforms: Transform) -> None:
        seen = {(t._entry["output"]["folder"], t._entry["output"]["name"]) for t in self._transforms}
        for tr in transforms:
            if not isinstance(tr, Transform):
                raise TypeError(f"add_transforms takes transforms, not {type(tr).__name__}")
            if tr in self._transforms:
                continue
            outs = {(o["folder"], o["name"]) for o in (tr._entry.get("outputs") or {"_": tr._entry["output"]}).values()}
            clash = outs & seen
            if clash:
                raise ValueError(f"two transforms in the pipeline declare the output {', '.join(n for _, n in clash)}")
            seen |= outs
            self._transforms.append(tr)

    def discover_transforms(self, *modules: types.ModuleType) -> None:
        """Every transform defined at module level (also in module-level lists, e.g. generated transforms) in the
        modules and their submodules."""
        import importlib
        import pkgutil

        found: list[Transform] = []
        for mod in modules:
            mods = [mod]
            if hasattr(mod, "__path__"):
                for info in pkgutil.walk_packages(mod.__path__, mod.__name__ + "."):
                    try:
                        mods.append(importlib.import_module(info.name))
                    except Exception:  # noqa: BLE001 - reported when the file itself is loaded
                        pass
            for m in mods:
                for value in list(vars(m).values()):
                    for v in (value if isinstance(value, (list, tuple)) else [value]):
                        if isinstance(v, Transform) and v not in found:
                            found.append(v)
        self.add_transforms(*found)


# ------------------------------------------------------------------------------------------------
# the original API's runtime objects (pandas)
# ------------------------------------------------------------------------------------------------


class TransformContext:
    def __init__(self, is_incremental: bool = False, spark=None) -> None:
        self.is_incremental = is_incremental
        self._spark = spark

    @property
    def spark_session(self):
        """A local Spark session (started on first use)."""
        return (self._spark or spark_session)()

    def abort_job(self) -> None:
        raise AbortJob()


IncrementalTransformContext = TransformContext


def _empty_like(df):
    return df.iloc[0:0].copy()


class TransformInput:
    """An input dataset. dataframe() / dataframe('added') are the rows to process: in an incremental build the rows
    added since the last build, otherwise every row. 'previous' is what earlier builds processed, 'current' all."""

    def __init__(self, df, previous=None, added=None):
        self._df = df
        self._previous = previous if previous is not None else _empty_like(df)
        self._added = added if added is not None else df

    def dataframe(self, mode: str = "added"):
        if mode == "current":
            return self._df
        if mode == "previous":
            return self._previous
        if mode == "added":
            return self._added
        raise ValueError(f"dataframe mode must be 'added', 'previous' or 'current', not {mode!r}")

    def pandas(self, mode: str = "added"):
        return self.dataframe(mode)

    def __getattr__(self, name):
        # src.groupby(...) works as well as src.dataframe().groupby(...)
        if name.startswith("__") or name in ("_df", "_previous", "_added"):
            raise AttributeError(name)
        return getattr(self._added, name)


IncrementalTransformInput = TransformInput


class TransformOutput:
    """The output dataset. In an incremental build write_dataframe() appends to the output as last built ('modify'
    mode) unless set_mode('replace'); otherwise it replaces it."""

    def __init__(self, previous=None, incremental: bool = False) -> None:
        self.df = None
        self._previous = previous
        self._incremental = incremental
        self.mode = "modify" if incremental else "replace"

    def write_dataframe(self, df, **_: object) -> None:
        self.df = df

    write_pandas = write_dataframe

    def set_mode(self, mode: str) -> None:
        if mode not in ("replace", "modify"):
            raise ValueError("set_mode takes 'replace' or 'modify'")
        self.mode = mode

    def dataframe(self, mode: str = "current", schema=None):
        """'previous': the output as last built (incremental builds only, else empty); 'current': with this build's writes."""
        import pandas as pd

        if mode not in ("current", "previous"):
            raise ValueError("an output's dataframe mode is 'current' or 'previous'")
        prior = self._previous if self._incremental and self._previous is not None else None
        if mode == "current" and self.df is not None:
            return self.final()
        return prior if prior is not None else pd.DataFrame(columns=list(schema) if schema else None)

    def final(self):
        """What the build writes."""
        import pandas as pd

        if self.df is None:
            return None
        if self._incremental and self.mode == "modify" and self._previous is not None:
            return pd.concat([self._previous, as_frame(self.df)], ignore_index=True)
        return self.df


IncrementalTransformOutput = TransformOutput


def as_frame(df):
    import pandas as pd

    if isinstance(df, pd.Series):
        return df.to_frame()
    if type(df).__module__.split(".", 1)[0] == "pyspark" and hasattr(df, "toPandas"):
        return to_arrow(df).to_pandas()
    try:
        import polars as pl

        if isinstance(df, pl.LazyFrame):
            df = df.collect()
        if isinstance(df, pl.DataFrame):
            return df.to_pandas()
    except ImportError:
        pass
    if not isinstance(df, pd.DataFrame):
        raise TypeError(f"the transform must produce a pandas DataFrame, not {type(df).__name__}")
    return df


# ------------------------------------------------------------------------------------------------
# Foundry's current API: lightweight and Spark inputs and outputs
# ------------------------------------------------------------------------------------------------

FileStatus = namedtuple("FileStatus", ["path", "size", "modified"])


def _match(path: str, glob: Optional[str], regex: Optional[str]) -> bool:
    if glob:
        ok = fnmatch.fnmatch(path, glob) or (glob.startswith("**/") and fnmatch.fnmatch(path, glob[3:]))
        if not ok and "/" not in glob:
            ok = fnmatch.fnmatch(path.rsplit("/", 1)[-1], glob)
        if not ok:
            return False
    if regex and not re.fullmatch(regex, path):
        return False
    return True


class FileSystem:
    """A dataset's files: read-only for an input (and an output's previous files), write-only for an output."""

    def __init__(self, files: list[dict], write_dir: Optional[Path] = None, spark=None) -> None:
        self._files = files
        self._write_dir = write_dir
        self._spark = spark
        self.read_only = write_dir is None

    def ls(self, glob: Optional[str] = None, regex: Optional[str] = None, show_hidden: bool = False):
        for f in self._listing():
            name = f["path"].rsplit("/", 1)[-1]
            if not show_hidden and (name.startswith(".") or name.startswith("_")):
                continue
            if _match(f["path"], glob, regex):
                yield FileStatus(f["path"], int(f.get("size") or 0), int(f.get("modified") or 0))

    def _listing(self) -> list[dict]:
        if self._write_dir is None:
            return self._files
        out = []
        if self._write_dir.is_dir():
            for p in sorted(self._write_dir.rglob("*")):
                if p.is_file():
                    st = p.stat()
                    out.append({"path": p.relative_to(self._write_dir).as_posix(), "file": str(p), "size": st.st_size, "modified": int(st.st_mtime * 1000)})
        return out

    def open(self, path: str, mode: str = "r", **kwargs):
        path = str(path).replace("\\", "/").lstrip("/")
        if not path or ".." in path.split("/"):
            raise ValueError(f"not a file path: {path!r}")
        writing = any(c in mode for c in "wax+")
        if "b" not in mode:
            # text files are UTF-8 with \n line ends, as on Foundry's Linux hosts
            kwargs.setdefault("encoding", "utf-8")
            if writing:
                kwargs.setdefault("newline", "\n")
        if self._write_dir is None:
            if writing:
                raise PermissionError("an input's file system is read-only")
            f = next((x for x in self._files if x["path"] == path), None)
            if not f:
                raise FileNotFoundError(path)
            return open(f["file"], mode, **kwargs)  # noqa: SIM115 - the caller closes it
        if not writing:
            raise PermissionError("an output's file system is write-only: open files with 'w' or 'wb'")
        dest = self._write_dir / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        return open(dest, mode, **kwargs)  # noqa: SIM115

    @property
    def hadoop_path(self) -> str:
        """A file: URI of a folder holding the dataset's files (for spark.read.csv(fs.hadoop_path + "/" + path))."""
        if self._write_dir is not None:
            self._write_dir.mkdir(parents=True, exist_ok=True)
            return self._write_dir.resolve().as_uri()
        import tempfile

        d = Path(tempfile.mkdtemp(prefix="fs-"))
        for f in self._files:
            dest = d / f["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f["file"], dest)
        return d.resolve().as_uri()

    def files(self, glob: Optional[str] = None, regex: Optional[str] = None):
        """The files as a DataFrame of (path, size, modified): a Spark DataFrame in Spark transforms, else pandas."""
        rows = [tuple(s) for s in self.ls(glob=glob, regex=regex)]
        if self._spark is not None:
            from pyspark.sql.types import LongType, StringType, StructField, StructType

            schema = StructType([StructField("path", StringType()), StructField("size", LongType()), StructField("modified", LongType())])
            spark = self._spark()
            # partitioned by file size like Spark's file sources: spark.sql.files.maxPartitionBytes per partition,
            # each file counting spark.sql.files.openCostInBytes extra
            bins = pack_files(rows, _bytes_conf(spark, "spark.sql.files.maxPartitionBytes", 128 << 20),
                              _bytes_conf(spark, "spark.sql.files.openCostInBytes", 4 << 20))
            if not bins:
                return spark.createDataFrame([], schema)
            rdd = spark.sparkContext.parallelize(bins, len(bins)).flatMap(lambda b: b)
            return spark.createDataFrame(rdd, schema)
        import pandas as pd

        return pd.DataFrame(rows, columns=["path", "size", "modified"])

    def __getstate__(self):
        # sent to Spark executors (files().rdd.flatMap(...)): the session stays behind
        return {**self.__dict__, "_spark": None}


def _field_meta(table) -> tuple[dict, dict]:
    desc, tcs = {}, {}
    for f in table.schema:
        md = f.metadata or {}
        if b"description" in md:
            desc[f.name] = md[b"description"].decode("utf-8", "replace")
        if b"typeclasses" in md:
            try:
                tcs[f.name] = json.loads(md[b"typeclasses"])
            except ValueError:
                pass
    return desc, tcs


def _empty_frame(schema, kind: str):
    """An empty DataFrame (pandas / polars / arrow) with a schema: a polars schema dict, a list of names or a
    pyspark StructType."""
    import pyarrow as pa

    fields = []
    if schema is None:
        pass
    elif hasattr(schema, "fields"):  # pyspark StructType
        from pyspark.sql.pandas.types import to_arrow_type

        fields = [pa.field(f.name, to_arrow_type(f.dataType)) for f in schema.fields]
    elif isinstance(schema, dict):
        import polars as pl

        df = pl.DataFrame(schema={k: (v() if isinstance(v, type) else v) if not isinstance(v, str) else pl.Utf8 for k, v in schema.items()})
        fields = list(df.to_arrow().schema)
    else:
        fields = [pa.field(str(n), pa.string()) for n in schema]
    return _convert(pa.schema(fields).empty_table(), kind)


def _convert(table, kind: str, lazy: bool = False):
    if kind == "arrow":
        return table
    if kind == "pandas":
        return table.to_pandas()
    if kind == "polars":
        import polars as pl

        df = pl.from_arrow(table)
        if isinstance(df, pl.Series):
            df = df.to_frame()
        return df.lazy() if lazy else df
    raise ValueError(kind)


# the query plans of the Spark DataFrames a build wrote (Linter reads them from the build record)
SPARK_PLANS: list[dict] = []
PLAN_CHARS = 20_000


def _record_plan(df) -> None:
    try:
        qe = df._jdf.queryExecution()
        if len(SPARK_PLANS) < 20:
            SPARK_PLANS.append({"logical": qe.optimizedPlan().toString()[:PLAN_CHARS], "physical": qe.executedPlan().toString()[:PLAN_CHARS]})
    except Exception:  # noqa: BLE001 - the plan is informative
        pass


def to_arrow(obj, engine: Optional[str] = None, logs=None):
    """Anything a transform can write: Polars (eager or lazy), pandas, Arrow, a DuckDB relation, a PySpark
    DataFrame, or a folder of Parquet files."""
    import pyarrow as pa

    if hasattr(obj, "_jdf"):
        _record_plan(obj)

    if isinstance(obj, pa.Table):
        return obj
    if isinstance(obj, pa.RecordBatchReader):
        return obj.read_all()
    if isinstance(obj, (str, Path)):
        import pyarrow.dataset as pads

        p = Path(obj)
        if not p.exists():
            raise FileNotFoundError(f"write_table: no such file or folder {obj}")
        files = [p] if p.is_file() else sorted(x for x in p.rglob("*.parquet") if x.is_file())
        if not files:
            raise ValueError(f"write_table: no Parquet files in {obj} (only Parquet files can be written this way)")
        return pads.dataset([str(f) for f in files], format="parquet", partitioning="hive" if p.is_dir() else None,
                            partition_base_dir=str(p) if p.is_dir() else None).to_table()
    mod = type(obj).__module__.split(".", 1)[0]
    import pandas as pd

    if isinstance(obj, (pd.DataFrame, pd.Series)):
        mod = "pandas"
    if mod == "polars":
        import polars as pl

        if isinstance(obj, pl.LazyFrame):
            if engine == "gpu":
                try:
                    obj = obj.collect(engine=pl.GPUEngine(raise_on_fail=False))
                except Exception:  # noqa: BLE001 - no cudf-polars: the CPU engine, as Polars does for unsupported queries
                    if logs is not None:
                        logs.write("write_table(engine='gpu'): no GPU engine here, collected on the CPU\n")
                    obj = obj.collect()
            else:
                obj = obj.collect()
        if isinstance(obj, pl.Series):
            obj = obj.to_frame()
        return obj.to_arrow()
    if mod == "pandas":
        import pandas as pd

        if isinstance(obj, pd.Series):
            obj = obj.to_frame()
        df = obj.copy()
        df.columns = [str(c) for c in df.columns]
        return pa.Table.from_pandas(df, preserve_index=False)
    if mod in ("duckdb", "_duckdb") or type(obj).__name__ == "DuckDBPyRelation":
        res = obj.arrow() if hasattr(obj, "arrow") else obj.fetch_arrow_table()
        return res.read_all() if isinstance(res, pa.RecordBatchReader) else res
    if mod == "pyspark":
        return spark_to_arrow(obj)
    if hasattr(obj, "to_arrow"):
        return to_arrow(obj.to_arrow())
    raise TypeError(f"cannot write a {type(obj).__name__}: write a Polars, pandas or Arrow table, a DuckDB relation or a folder of Parquet files")


def spark_to_arrow(df):
    """A Spark DataFrame as an Arrow table, collected as Arrow batches: integers with nulls stay integers (toPandas
    makes them floats), decimals stay decimals, timestamps are UTC instants. Types Arrow collection does not take (a
    user-defined type such as an ML vector) go through toPandas."""
    import pyarrow as pa

    if hasattr(df, "_collect_as_arrow") and hasattr(df, "_jdf"):
        try:
            from pyspark.sql.pandas.types import to_arrow_type

            # every field nullable and timestamps as UTC wall-clock times without a zone, as a dataset written from
            # toPandas was (appends to an incremental output keep one schema; spark_frame reads them back as UTC)
            def plain(t):
                if pa.types.is_timestamp(t):
                    return pa.timestamp(t.unit)
                if pa.types.is_list(t):
                    return pa.list_(pa.field(t.value_field.name, plain(t.value_type)))
                if pa.types.is_map(t):
                    return pa.map_(t.key_field.with_type(plain(t.key_type)), t.item_field.with_type(plain(t.item_type)))
                if pa.types.is_struct(t):
                    return pa.struct([f.with_type(plain(f.type)) for f in t])
                return t

            schema = pa.schema([pa.field(f.name, plain(to_arrow_type(f.dataType))) for f in df.schema.fields])
            batches = df._collect_as_arrow()
            if not batches:
                return schema.empty_table()
            return pa.Table.from_batches(batches).cast(schema)
        except Exception:  # noqa: BLE001 - user-defined types and PySpark internals: pandas, as before
            pass
    return to_arrow(df.toPandas())


def with_column_meta(table, descriptions: Optional[dict] = None, typeclasses: Optional[dict] = None):
    """Column descriptions (at most 800 characters) and typeclasses, as Parquet field metadata."""
    import pyarrow as pa

    descriptions = descriptions or {}
    typeclasses = typeclasses or {}
    for k, v in typeclasses.items():
        if not isinstance(v, list) or not all(isinstance(x, dict) and set(x) <= {"name", "kind"} for x in v):
            raise ValueError(f"column_typeclasses[{k!r}] must be a list of {{'name': ..., 'kind': ...}} dicts")
    for k, v in descriptions.items():
        if len(str(v)) > 800:
            raise ValueError(f"the description of column {k} is longer than 800 characters")
    if not descriptions and not typeclasses:
        return table
    fields = []
    for f in table.schema:
        md = dict(f.metadata or {})
        if f.name in descriptions:
            md[b"description"] = str(descriptions[f.name]).encode()
        if f.name in typeclasses:
            md[b"typeclasses"] = json.dumps(typeclasses[f.name]).encode()
        fields.append(f.with_metadata(md) if md else f)
    return table.cast(pa.schema(fields, metadata=table.schema.metadata))


class LightweightInput:
    """An input of a single-node transform. Read modes: 'added' (the default: rows added since the last build when
    running incrementally, else every row), 'previous' (rows earlier builds processed), 'current' (every row)."""

    def __init__(self, name: str, ref: str, path: Optional[str], files: Optional[list[dict]] = None, select: Optional[tuple] = None,
                 incremental: bool = False, snapshot: bool = False, work: Optional[Path] = None, added_files: Optional[set] = None) -> None:
        self.alias = ref
        self.rid = ref
        self.branch = None
        self._name = name
        self._path = path
        self._files = files
        # ("prefix", n): the first n rows were processed before; ("index", previous rows, added rows) after deletions;
        # ("range", start, end): a transaction-limited batch (rows start..end), also on snapshot builds
        self._select = select if (incremental and not snapshot) or (select and select[0] == "range") else None
        self._incremental = incremental and not snapshot
        self._snapshot = snapshot
        self._work = work
        self._added_files = added_files
        self._table = None

    # -- tabular reads
    def _require_schema(self) -> None:
        if self._path is None:
            raise TypeError(f"input {self._name} is a dataset without a schema (a folder of files): read it with filesystem()")

    def _rows(self, mode: str) -> tuple:
        """("slice", start, end or None) or ("take", row indices) of a read mode."""
        if mode not in ("added", "previous", "current"):
            raise ValueError(f"read mode must be 'added', 'previous' or 'current', not {mode!r}")
        if mode == "current" and self._select is not None and self._select[0] == "range":
            return ("slice", 0, self._select[2])
        if mode == "current" or (mode == "added" and self._select is None):
            return ("slice", 0, None)
        if self._select is None:
            return ("slice", 0, 0)
        if self._select[0] == "prefix":
            n = self._select[1]
            return ("slice", n, None) if mode == "added" else ("slice", 0, n)
        if self._select[0] == "range":
            _, a, b = self._select
            return {"added": ("slice", a, b), "previous": ("slice", 0, a)}[mode]
        return ("take", self._select[2] if mode == "added" else self._select[1])

    def _arrow_all(self):
        import pyarrow.parquet as pq

        self._require_schema()
        if self._table is None:
            self._table = pq.read_table(self._path)
        return self._table

    def arrow(self, mode: str = "added"):
        import pyarrow as pa

        r = self._rows(mode)
        t = self._arrow_all()
        if r[0] == "take":
            return t.take(pa.array(r[1], type=pa.int64()))
        return t.slice(r[1], (r[2] if r[2] is not None else t.num_rows) - r[1])

    def pandas(self, mode: str = "added"):
        return self.arrow(mode).to_pandas()

    def polars(self, mode: str = "added", lazy: bool = False):
        import polars as pl

        self._require_schema()
        r = self._rows(mode)
        if lazy:
            lf = pl.scan_parquet(self._path)
            if r[0] == "take":
                return lf.with_row_index("__row").filter(pl.col("__row").is_in(list(r[1]))).drop("__row")
            if r[1] or r[2] is not None:
                lf = lf.slice(r[1], None if r[2] is None else r[2] - r[1])
            return lf
        return _convert(self.arrow(mode), "polars")

    def dataframe(self, mode: str = "added"):
        return self.pandas(mode)

    read_table = pandas

    def path(self, mode: str = "current") -> str:
        """A folder holding the dataset's Parquet file (downloaded on demand)."""
        self._require_schema()
        d = (self._work or Path(self._path).parent) / f"path-{self._name}"
        if not d.is_dir():
            d.mkdir(parents=True)
            shutil.copyfile(self._path, d / "part-00000.parquet")
        return str(d)

    def filesystem(self, mode: str = "added") -> FileSystem:
        if self._files is not None:
            files = self._files
            if self._incremental and mode == "added" and self._added_files is not None:
                files = [f for f in files if f["path"] in self._added_files]
            elif self._incremental and mode == "previous" and self._added_files is not None:
                files = [f for f in files if f["path"] not in self._added_files]
            return FileSystem(files, spark=getattr(self, "_spark", None))
        st = os.stat(self._path)
        return FileSystem([{"path": "part-00000.parquet", "file": self._path, "size": st.st_size, "modified": int(st.st_mtime * 1000)}],
                          spark=getattr(self, "_spark", None))

    @property
    def column_descriptions(self) -> dict:
        return _field_meta(self._arrow_all())[0] if self._path else {}

    @property
    def column_typeclasses(self) -> dict:
        return _field_meta(self._arrow_all())[1] if self._path else {}

    @property
    def schema(self):
        return self._arrow_all().schema

    def __getstate__(self):
        return {**self.__dict__, "_table": None, "_spark": None}


IncrementalLightweightInput = LightweightInput


class LightweightOutput:
    """An output of a single-node transform: write_table(...) makes it a dataset, filesystem().open(...) a dataset
    of files. In an incremental build the default mode is 'modify' (append); set_mode('replace') replaces."""

    def __init__(self, name: str, ref: str, work: Path, previous: Optional[str] = None, incremental: bool = False,
                 strict_append: bool = False, logs=None) -> None:
        self.alias = ref
        self.rid = ref
        self.branch = None
        self._name = name
        self._work = work
        self._previous = previous if incremental else None
        self._incremental = incremental
        self._strict = strict_append
        self._logs = logs
        self.mode = "modify" if incremental else "replace"
        self.table = None
        self.aborted = False
        self.column_descriptions: dict = {}
        self.column_typeclasses: dict = {}
        self._files_dir = work / f"files-{name}"
        self._table_dir = work / f"write-table-{name}"

    def set_mode(self, mode: str) -> None:
        if mode not in ("replace", "modify"):
            raise ValueError("set_mode takes 'replace' or 'modify'")
        if mode == "replace" and self._strict and self._incremental:
            raise ValueError("strict_append=True: an incremental build can only append (set_mode('replace') is not allowed)")
        self.mode = mode

    def write_table(self, table, engine: Optional[str] = None, column_descriptions: Optional[dict] = None,
                    column_typeclasses: Optional[dict] = None, **_: object) -> None:
        self.table = to_arrow(table, engine, self._logs)
        if column_descriptions is not None:
            self.column_descriptions = dict(column_descriptions)
        if column_typeclasses is not None:
            self.column_typeclasses = dict(column_typeclasses)

    def write_pandas(self, df, **kw) -> None:
        self.write_table(df, **kw)

    def write_polars(self, df, **kw) -> None:
        self.write_table(df, **kw)

    def write_dataframe(self, df, column_descriptions: Optional[dict] = None, column_typeclasses: Optional[dict] = None, **_: object) -> None:
        self.write_table(df, column_descriptions=column_descriptions, column_typeclasses=column_typeclasses)

    @property
    def path_for_write_table(self) -> str:
        """A folder to write Parquet files into (e.g. DuckDB COPY ... TO), then write_table(this path) or put_metadata()."""
        self._table_dir.mkdir(parents=True, exist_ok=True)
        return str(self._table_dir)

    @property
    def path_for_object_store_write_table(self) -> str:
        return self.path_for_write_table

    def put_metadata(self) -> None:
        """Commit the Parquet files written into path_for_write_table (inferring the schema)."""
        self.write_table(self.path_for_write_table)

    def abort(self) -> None:
        """Abort this output's transaction (prefer ctx.abort_job(): aborting some outputs breaks incrementality)."""
        self.aborted = True

    def filesystem(self, mode: str = "current") -> FileSystem:
        if mode == "previous":
            if not self._previous:
                return FileSystem([])
            st = os.stat(self._previous)
            return FileSystem([{"path": "part-00000.parquet", "file": self._previous, "size": st.st_size, "modified": int(st.st_mtime * 1000)}])
        return FileSystem([], write_dir=self._files_dir)

    def _prior(self):
        import pyarrow.parquet as pq

        return pq.read_table(self._previous) if self._incremental and self._previous else None

    def _read(self, mode: str, schema=None):
        import pyarrow as pa

        prior = self._prior()
        if mode == "previous":
            if prior is None:
                if schema is None and self._incremental:
                    pass
                return _empty_frame(schema, "arrow")
            if schema is not None:
                expected = _empty_frame(schema, "arrow").schema
                if expected.names != prior.schema.names or any(a.type != b.type for a, b in zip(expected, prior.schema)):
                    raise TypeError(f"SchemaMismatchError: the schema given for {self._name}'s previous output ({expected.names}) "
                                    f"does not match it ({prior.schema.names}: {[str(f.type) for f in prior.schema]})")
            return prior
        if mode not in ("current", "added"):
            raise ValueError("an output's read mode is 'current', 'added' or 'previous'")
        if mode == "added" or self.mode == "replace" or prior is None:
            return self.table if self.table is not None else (_empty_frame(schema, "arrow") if prior is None else prior.schema.empty_table())
        return pa.concat_tables([prior, self.table], promote_options="permissive") if self.table is not None else prior

    def arrow(self, mode: str = "current", schema=None):
        return self._read(mode, schema)

    def pandas(self, mode: str = "current", schema=None):
        return self._read(mode, schema).to_pandas()

    def polars(self, mode: str = "current", schema=None, lazy: bool = False):
        return _convert(self._read(mode, schema), "polars", lazy)

    def dataframe(self, mode: str = "current", schema=None):
        return self.pandas(mode, schema)

    def final(self):
        """(kind, data, mode, written rows) of what the build commits; kind None when nothing was written."""
        import pyarrow as pa

        has_files = self._files_dir.is_dir() and any(p.is_file() for p in self._files_dir.rglob("*"))
        if self.table is not None and has_files:
            raise ValueError(f"output {self._name}: write either a table (write_table) or files (filesystem().open), not both")
        if has_files:
            files = [{"path": f["path"], "file": f["file"], "size": f["size"]} for f in FileSystem([], write_dir=self._files_dir)._listing()]
            return "files", files, ("UPDATE" if self._incremental and self.mode == "modify" else "SNAPSHOT"), len(files)
        if self.table is None:
            return None, None, None, None
        table = self.table
        prior = self._prior()
        appending = self._incremental and self.mode == "modify" and prior is not None
        if appending:
            if [n for n in table.schema.names] != [n for n in prior.schema.names] and table.num_rows:
                raise ValueError(f"output {self._name}: the rows written have columns {table.schema.names}, the output has {prior.schema.names}")
            table = pa.concat_tables([prior, table.select(prior.schema.names) if table.num_rows else prior.schema.empty_table()], promote_options="permissive")
        desc = {**_field_meta(prior)[0], **self.column_descriptions} if prior is not None else self.column_descriptions
        tcs = {**_field_meta(prior)[1], **self.column_typeclasses} if prior is not None else self.column_typeclasses
        table = with_column_meta(table, {k: v for k, v in desc.items() if k in table.schema.names}, {k: v for k, v in tcs.items() if k in table.schema.names})
        return "dataframe", table, ("UPDATE" if appending else "SNAPSHOT"), self.table.num_rows


IncrementalLightweightOutput = LightweightOutput


class _Conn:
    """A DuckDB connection with Foundry's sql_from_file()."""

    def __init__(self, conn) -> None:
        object.__setattr__(self, "_conn", conn)

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def __setattr__(self, name, value):
        setattr(self._conn, name, value)

    def sql_from_file(self, path: str, *a, **kw):
        caller = Path(inspect.stack()[1].filename).parent
        return self._conn.sql((caller / path).read_text("utf-8"), *a, **kw)


class DuckDbContext:
    def __init__(self, conn) -> None:
        self.conn = _Conn(conn)


def _sql_str(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


class LightweightContext:
    """`ctx` of a single-node transform: is_incremental, duckdb(), abort_job()."""

    def __init__(self, inputs: dict, is_incremental: bool = False, threads: Optional[int] = None, spark=None) -> None:
        self._inputs = inputs
        self.is_incremental = is_incremental
        self._threads = threads
        self._duck: dict[str, DuckDbContext] = {}
        self._spark = spark

    def duckdb(self, read_modes: Optional[dict] = None) -> DuckDbContext:
        """A DuckDB connection with every dataset input registered as a lazy view named after it, and a
        <input>_files() macro listing its Parquet files. read_modes={input: 'added' | 'current' | 'previous'}."""
        import duckdb

        modes = {}
        for k, v in (read_modes or {}).items():
            name = k if isinstance(k, str) else next((n for n, inp in self._inputs.items() if inp is k), None)
            if name not in self._inputs:
                raise KeyError(f"read_modes names an unknown input: {k!r}")
            modes[name] = v
        key = json.dumps(modes, sort_keys=True)
        if key in self._duck:
            return self._duck[key]
        conn = duckdb.connect(":memory:")
        if self._threads:
            conn.execute(f"SET threads={int(self._threads)}")
        for name, inp in self._inputs.items():
            if not isinstance(inp, LightweightInput) or inp._path is None:
                continue
            ident = '"' + name.replace('"', '""') + '"'
            r = inp._rows(modes.get(name, "added"))
            src = f"read_parquet({_sql_str(inp._path)}, file_row_number=true)"
            if r[0] == "take":
                import pyarrow as pa

                conn.register(f"__rows_{name}", pa.table({"i": pa.array(r[1], type=pa.int64())}))
                where = [f'file_row_number IN (SELECT i FROM "__rows_{name}")']
            else:
                where = [f"file_row_number >= {r[1]}"] if r[1] else []
                if r[2] is not None:
                    where.append(f"file_row_number < {r[2]}")
            conn.execute(f"CREATE VIEW {ident} AS SELECT * EXCLUDE (file_row_number) FROM {src}" + (f" WHERE {' AND '.join(where)}" if where else ""))
            conn.execute(f'CREATE MACRO "{name}_files"() AS [{_sql_str(inp._path)}]')
        self._duck[key] = DuckDbContext(conn)
        return self._duck[key]

    def abort_job(self) -> None:
        raise AbortJob()

    @property
    def spark_session(self):
        if self._spark is None:
            raise RuntimeError("this is a single-node transform: use @transform.spark.using(...) for a Spark session")
        return self._spark()


IncrementalTransformContextLightweight = LightweightContext


# -- Spark --------------------------------------------------------------------------------------

_SPARK: dict[str, Any] = {}


def spark_session(cores: Optional[int] = None, memory: Optional[str] = None):
    """A local Spark session (one per process), sized by SPARK_CONF (the transform's Spark profiles)."""
    if "session" in _SPARK:
        return _SPARK["session"]
    s = SPARK_CONF
    if cores is None:
        cores = max(1, min(os.cpu_count() or 2, (s.get("executor_cores", 2) * max(1, s.get("executors", 1))) if "executor_cores" in s or "executors" in s else 2))
    if memory is None:
        memory = f"{int(s.get('driver_memory_mb', 2048) + s.get('executor_memory_mb', 0))}m"
    import code_java

    home = code_java.java_home()
    if not home:
        raise RuntimeError("Spark transforms need a JDK 17 (see the README: Java toolchain)")
    os.environ["JAVA_HOME"] = str(home)
    os.environ["PYSPARK_PYTHON"] = sys.executable
    os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
    paths = [str(Path(__file__).parent), *[p for p in sys.path if p and Path(p).is_dir() and CURRENT_FILE.get("root") and str(p).startswith(CURRENT_FILE["root"])]]
    os.environ["PYTHONPATH"] = os.pathsep.join(dict.fromkeys([*paths, *os.environ.get("PYTHONPATH", "").split(os.pathsep)]).keys()).strip(os.pathsep)
    import tempfile

    from pyspark.sql import SparkSession

    tmp = tempfile.mkdtemp(prefix="spark-")
    builder = SparkSession.builder
    if s.get("jar_packages"):
        # condaJars / sparkJars from build.gradle on the driver's classpath (local mode: executors share the JVM)
        jars = resolve_jars(s["jar_packages"], s.get("ivy_dir") or str(Path(tmp, "ivy")), home)
        builder = builder.config("spark.driver.extraClassPath", os.pathsep.join(jars))
    for k, v in (s.get("conf") or {}).items():
        # custom profiles (spark.sql.*), e.g. spark.sql.files.maxPartitionBytes for files()
        builder = builder.config(k, v)
    if s.get("spark_ui"):
        # a debug job: Spark's web UI on a free local port, read back as a snapshot when the job ends (spark_ui_snapshot)
        import socket

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            ui_port = sock.getsockname()[1]
        builder = builder.config("spark.ui.port", str(ui_port)).config("spark.ui.retainedTasks", "10000")
    session = (builder.master(f"local[{max(1, cores)}]").appName(s.get("app_name") or "transforms")
               .config("spark.ui.enabled", "true" if s.get("spark_ui") else "false").config("spark.driver.host", "127.0.0.1").config("spark.driver.bindAddress", "127.0.0.1")
               .config("spark.driver.memory", memory).config("spark.sql.session.timeZone", "UTC")
               .config("spark.sql.execution.arrow.pyspark.enabled", "true").config("spark.sql.shuffle.partitions", str(s.get("shuffle_partitions", 4)))
               .config("spark.sql.crossJoin.enabled", "true" if s.get("cross_join") else "false")
               .config("spark.sql.autoBroadcastJoinThreshold", "-1" if s.get("broadcast_disabled") else "10485760")
               .config("spark.sql.adaptive.enabled", "false" if s.get("adaptive") is False else "true")
               .config("spark.memory.offHeap.enabled", "true" if s.get("offheap_fraction") else "false")
               .config("spark.memory.offHeap.size", f"{int(s.get('executor_memory_mb', 0) * s.get('offheap_fraction', 0))}m" if s.get("offheap_fraction") else "0")
               .config("spark.python.worker.module", "pyspark_worker").config("spark.python.worker.reuse", "false")
               .config("spark.sql.warehouse.dir", Path(tmp, "warehouse").as_uri()).config("spark.local.dir", tmp))
    if code_tables.CTX.get("spark_jar") and code_tables.CTX.get("uri"):
        # Iceberg table inputs / outputs: the Iceberg Spark runtime with Foundry's REST catalog as `foundry`
        for k, v in code_tables.spark_conf().items():
            session = session.config(k, v)
    session = session.getOrCreate()
    session.sparkContext.setLogLevel("ERROR")
    _map_in_pandas_profile()
    _SPARK["session"] = session
    return session


def _map_in_pandas_profile() -> None:
    """xgboost.spark (3.x) calls mapInPandas(..., profile=...), PySpark 4's stage-level scheduling argument. On PySpark
    3.5 the argument does not exist: accept it and leave it out (a local session has one resource profile)."""
    import inspect

    from pyspark.sql import DataFrame

    for name in ("mapInPandas", "mapInArrow"):
        orig = getattr(DataFrame, name, None)
        if orig is None or "profile" in inspect.signature(orig).parameters:
            continue

        def compat(self, func, schema, barrier=False, profile=None, _orig=orig):  # noqa: ANN001, ARG001
            return _orig(self, func, schema, barrier)

        compat.__name__, compat.__doc__ = name, orig.__doc__
        setattr(DataFrame, name, compat)


IVY_SETTINGS = """<ivysettings>
  <settings defaultResolver="chain"/>
  <resolvers>
    <chain name="chain" returnFirst="true">
      <ibiblio name="central" m2compatible="true"/>
      <ibiblio name="spark-packages" m2compatible="true" root="https://repos.spark-packages.org/"/>
    </chain>
  </resolvers>
</ivysettings>
"""


def resolve_jars(coords: list[str], ivy_dir: str, java_home) -> list[str]:
    """Maven coordinates (group:name:version) → JAR files with their dependencies, resolved with the Ivy jar that
    ships with pyspark from Maven Central and the spark-packages repository (graphframes) and cached in ivy_dir. Not
    Spark's spark.jars.packages: fetching through Hadoop needs winutils on Windows."""
    import hashlib
    import subprocess

    import pyspark

    ivy_jar = next(iter(sorted((Path(pyspark.__file__).parent / "jars").glob("ivy-*.jar"))), None)
    if ivy_jar is None:
        raise RuntimeError("condaJars / sparkJars need the Ivy jar that ships with pyspark")
    base = Path(ivy_dir)
    base.mkdir(parents=True, exist_ok=True)
    settings = base / "ivysettings.xml"
    if not settings.exists():
        settings.write_text(IVY_SETTINGS, "utf-8")
    java = str(Path(java_home) / "bin" / ("java.exe" if os.name == "nt" else "java"))
    out: list[str] = []
    for coord in coords:
        group, name, version = coord.split(":")
        dest = base / "retrieved" / hashlib.sha256(coord.encode()).hexdigest()[:16]
        if not (dest / ".done").exists():
            p = subprocess.run([java, "-jar", str(ivy_jar), "-settings", str(settings), "-dependency", group, name, version, "-confs", "default",
                                "-types", "jar", "bundle", "-cache", str(base / "cache"),
                                "-retrieve", str(dest / "[organisation]-[artifact]-[revision](-[classifier]).[ext]"), "-sync"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
            if p.returncode != 0 or not list(dest.glob("*.jar")):
                detail = "\n".join(ln for ln in (p.stdout + p.stderr).splitlines() if "::" in ln or "ERROR" in ln or "not found" in ln.lower())[-1500:]
                raise RuntimeError(f"the JAR {coord} (condaJars / sparkJars in build.gradle) could not be resolved from Maven:\n{detail}")
            (dest / ".done").write_text(coord, "utf-8")
        out += [str(j) for j in sorted(dest.glob("*.jar"))]
    return list(dict.fromkeys(out))


def _bytes_conf(spark, key: str, default: int) -> int:
    """A Spark size setting in bytes ("128m", "4194304b", "1g" or a number)."""
    try:
        v = str(spark.conf.get(key, str(default))).strip().lower()
    except Exception:  # noqa: BLE001
        return default
    m = re.fullmatch(r"(\d+)\s*([kmgt]?)b?", v)
    if not m:
        return default
    return int(m.group(1)) * (1024 ** "_kmgt".index(m.group(2) or "_")) if m.group(2) else int(m.group(1))


def pack_files(rows: list[tuple], max_bytes: int, open_cost: int) -> list[list[tuple]]:
    """(path, size, modified) rows in partitions the way Spark packs file splits: largest first, a new partition when
    the next file (its size plus the open cost) would exceed max_bytes."""
    bins: list[list[tuple]] = []
    cur: list[tuple] = []
    size = 0
    for r in sorted(rows, key=lambda r: -(r[1] or 0)):
        n = (r[1] or 0) + open_cost
        if cur and size + n > max_bytes:
            bins.append(cur)
            cur, size = [], 0
        cur.append(r)
        size += n
    if cur:
        bins.append(cur)
    return bins


def spark_ui_snapshot(max_stages: int = 200) -> Optional[dict]:
    """Spark's web UI of the running session as data (its REST API: jobs, stages with task metric quantiles, SQL
    executions with their plans, executors, environment), for the debug job's Spark UI page. None without a session."""
    import json as _json
    import urllib.request

    s = _SPARK.get("session")
    if s is None:
        return None
    sc = s.sparkContext
    base = (sc.uiWebUrl or "").replace("localhost", "127.0.0.1")
    if not base:
        return None
    app = sc.applicationId

    def get(path: str):
        try:
            with urllib.request.urlopen(f"{base}/api/v1/applications/{app}{path}", timeout=20) as r:  # noqa: S310 - the local Spark UI
                return _json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}

    stages = get("/stages?details=false")
    if isinstance(stages, list):
        stages = stages[:max_stages]
        for st in stages:
            q = get(f"/stages/{st['stageId']}/{st['attemptId']}/taskSummary?quantiles=0.0,0.25,0.5,0.75,1.0")
            if isinstance(q, dict) and "error" not in q:
                st["taskSummary"] = q
    return {"app_id": app, "app_name": sc.appName, "spark_version": sc.version, "captured_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds"),
            "jobs": get("/jobs"), "stages": stages, "sql": get("/sql?details=true&planDescription=true"), "executors": get("/allexecutors"),
            "environment": get("/environment")}


def stop_spark() -> None:
    s = _SPARK.pop("session", None)
    if s is not None:
        try:
            s.stop()
        except Exception:  # noqa: BLE001
            pass


def _spark_arrow_type(t):
    """The Arrow type Spark reads a column of type t as (Spark has no unsigned integers, half floats, 64-bit dates,
    times of day, large / view / fixed-size variants or decimals past 38 digits). Unsigned integers widen to the next
    signed type and uint64 to DECIMAL(20,0) — the types Spark's own Parquet reader gives UINT_8/16/32/64 columns, so a
    value above the signed range keeps its value; timestamps become microseconds in UTC (Spark's TimestampType)."""
    import pyarrow as pa

    ty = pa.types
    if isinstance(t, pa.BaseExtensionType):
        return _spark_arrow_type(t.storage_type)
    if ty.is_dictionary(t):
        return _spark_arrow_type(t.value_type)
    if ty.is_uint8(t):
        return pa.int16()
    if ty.is_uint16(t):
        return pa.int32()
    if ty.is_uint32(t):
        return pa.int64()
    if ty.is_uint64(t):
        return pa.decimal128(20, 0)
    if ty.is_float16(t):
        return pa.float32()
    if ty.is_decimal(t):
        return pa.decimal128(t.precision, t.scale) if t.precision <= 38 else pa.string()
    if ty.is_string(t) or ty.is_large_string(t) or getattr(ty, "is_string_view", lambda _: False)(t):
        return pa.string()
    if ty.is_binary(t) or ty.is_large_binary(t) or ty.is_fixed_size_binary(t) or getattr(ty, "is_binary_view", lambda _: False)(t):
        return pa.binary()
    if ty.is_date(t):
        return pa.date32()
    if ty.is_timestamp(t):
        return pa.timestamp("us", tz="UTC")
    if ty.is_duration(t):
        return pa.duration("us")
    if ty.is_time(t) or ty.is_interval(t):
        return pa.string()
    if ty.is_list(t) or ty.is_large_list(t) or ty.is_fixed_size_list(t) or getattr(ty, "is_list_view", lambda _: False)(t) \
            or getattr(ty, "is_large_list_view", lambda _: False)(t):
        return pa.list_(pa.field("element", _spark_arrow_type(t.value_type), nullable=t.value_field.nullable))
    if ty.is_map(t):
        return pa.map_(pa.field("key", _spark_arrow_type(t.key_type), nullable=False),
                       pa.field("value", _spark_arrow_type(t.item_type), nullable=t.item_field.nullable))
    if ty.is_struct(t):
        return pa.struct([pa.field(f.name, _spark_arrow_type(f.type), nullable=f.nullable) for f in t])
    if getattr(ty, "is_run_end_encoded", lambda _: False)(t):
        return _spark_arrow_type(t.value_type)
    return t


def _has_temporal(t) -> bool:
    import pyarrow as pa

    if pa.types.is_temporal(t):
        return True
    if pa.types.is_dictionary(t):
        return _has_temporal(t.value_type)
    if isinstance(t, pa.BaseExtensionType):
        return _has_temporal(t.storage_type)
    return any(_has_temporal(t.field(i).type) for i in range(t.num_fields)) if t.num_fields else False


def spark_arrow(table):
    """(the table with every column cast to a type Spark reads, its Spark schema). Integers are cast safely (an
    out-of-range value is an error, never wrapped); timestamps / durations / times finer than a microsecond are
    truncated to microseconds, as Spark stores them."""
    import pyarrow as pa
    import pyarrow.compute as pc
    from pyspark.sql.pandas.types import from_arrow_type, to_arrow_type
    from pyspark.sql.types import StructField, StructType

    cols, fields = [], []
    for f, col in zip(table.schema, table.columns):
        want = _spark_arrow_type(f.type)
        if isinstance(f.type, pa.BaseExtensionType):
            col = pa.chunked_array([c.storage for c in col.chunks], type=f.type.storage_type)
        if getattr(pa.types, "is_run_end_encoded", lambda _: False)(col.type):
            col = pc.run_end_decode(col)
        spark_type = from_arrow_type(want)
        want = to_arrow_type(spark_type)
        if col.type != want:
            try:
                col = pc.cast(col, want, safe=True)
            except (pa.ArrowInvalid, pa.ArrowNotImplementedError):
                if not _has_temporal(col.type):
                    raise
                col = pc.cast(col, want, safe=False)
        cols.append(col)
        fields.append(StructField(f.name, spark_type, True))
    out = pa.Table.from_arrays(cols, schema=pa.schema([pa.field(f.name, c.type) for f, c in zip(fields, cols)])) if cols else table
    return out, StructType(fields)


def _spark_from_arrow(spark, table, schema):
    """A Spark DataFrame straight from Arrow record batches (one partition per batch), as createDataFrame(pandas) does
    after its pandas → Arrow step — without the pandas round trip that turns nullable integers into floats and needs
    pandas dtypes Spark knows."""
    from pyspark.sql import DataFrame
    from pyspark.sql.pandas.serializers import ArrowStreamSerializer

    step = spark._jconf.arrowMaxRecordsPerBatch()
    batches = [b for b in table.to_batches(max_chunksize=step if step > 0 else None) if b.num_rows]
    jvm = spark._jvm
    jiter = spark._sc._serialize_to_jvm(batches, ArrowStreamSerializer(), lambda fn: jvm.PythonSQLUtils.readArrowStreamFromFile(fn),
                                        lambda: jvm.ArrowIteratorServer())
    df = DataFrame(jvm.PythonSQLUtils.toDataFrame(jiter, schema.json(), spark._jsparkSession), spark)
    df._schema = schema
    return df


def spark_frame(table):
    """An Arrow table as a Spark DataFrame (with its schema even when it has no rows). Columns of types Spark lacks
    are converted (spark_arrow): uint8/16/32 → short/int/long, uint64 → decimal(20,0), large / view / dictionary /
    extension / fixed-size variants → their plain type, times of day → strings."""
    import pyarrow as pa

    spark = spark_session()
    if not isinstance(table, pa.Table):
        table = to_arrow(table)
    table, schema = spark_arrow(table)
    if table.num_rows == 0:
        return spark.createDataFrame([], schema)
    try:
        df = _spark_from_arrow(spark, table, schema)
    except Exception:  # noqa: BLE001 - PySpark internals moved: pandas, as createDataFrame does
        df = spark.createDataFrame(table.to_pandas(), schema)
    # Foundry reads a dataset as about one partition per 128 MB file block: a small dataset is one partition (so
    # repartition(n) spreads its rows evenly, as sidecar transforms rely on), not one per local core
    # (checkpointed: Spark's optimizer would fold a later repartition(n) over a plain coalesce and drop it)
    want = max(1, math.ceil(table.nbytes / (128 * 1024 * 1024)))
    return df.coalesce(want).localCheckpoint() if want < df.rdd.getNumPartitions() else df


class TransformSparkInput(LightweightInput):
    """An input of a Spark transform: dataframe() is a pyspark.sql.DataFrame."""

    _spark = staticmethod(spark_session)

    def dataframe(self, mode: str = "added", schema=None):
        return spark_frame(self.arrow(mode))


class TransformSparkOutput(LightweightOutput):
    def write_dataframe(self, df, column_descriptions: Optional[dict] = None, column_typeclasses: Optional[dict] = None, **_: object) -> None:
        self.write_table(df, column_descriptions=column_descriptions, column_typeclasses=column_typeclasses)

    def dataframe(self, mode: str = "current", schema=None):
        if mode == "previous" and schema is not None and hasattr(schema, "fields"):
            # the previous output is read back nullable (non-nullable fields such as groupBy counts are relaxed)
            from pyspark.sql.types import StructField, StructType

            schema = StructType([StructField(f.name, f.dataType, True, f.metadata) for f in schema.fields])
        return spark_frame(self._read(mode, schema))

    def filesystem(self, mode: str = "current") -> FileSystem:
        fs = super().filesystem(mode)
        fs._spark = spark_session
        return fs


# ------------------------------------------------------------------------------------------------
# the modules user code imports
# ------------------------------------------------------------------------------------------------

API_NAMES = (
    "Input", "Output", "InputSet", "OutputSet", "transform_df", "transform_pandas", "transform_polars", "transform", "lightweight",
    "incremental", "configure", "ComputeBackend", "Pipeline", "Transform", "TransformInput", "TransformOutput", "TransformContext",
    "IncrementalTransformInput", "IncrementalTransformOutput", "IncrementalTransformContext", "LightweightInput", "LightweightOutput",
    "LightweightContext", "IncrementalLightweightInput", "IncrementalLightweightOutput", "BooleanParam", "IntegerParam", "FloatParam",
    "StringParam", "Param", "ParamValueInput", "Markings", "OrgMarkings", "FileStatus", "FileSystem", "TransformSparkInput",
    "TransformSparkOutput", "FoundryDataSidecarFile", "FoundryDataSidecarFileSystem",
)


def install_modules() -> None:
    pkg = types.ModuleType("transforms")
    api = types.ModuleType("transforms.api")
    for name in API_NAMES:
        setattr(api, name, globals()[name])
    api.Check = code_expectations.Check
    # models without palantir_models: a ModelOutput publishes an MLflow model (or an adapter), a ModelInput loads one
    api.ModelOutput = model_lib.ModelOutput
    api.ModelInput = code_models.ModelInput
    # @evaluation("set") above @transform: model.create_evaluation() logs metrics (e.g. sklearn.metrics) to that set
    api.evaluation = model_lib.evaluation
    api.LightweightException = TypeError
    api.LightweightTypeError = TypeError
    api.LightweightValueError = ValueError
    api.LightweightNotImplementedError = NotImplementedError
    media = types.ModuleType("transforms.mediasets")
    for name in ("MediaSetInput", "MediaSetOutput"):
        setattr(media, name, globals()[name])
    for name in ("TransformMediaSetInput", "TransformMediaSetOutput", "MediaItem", "MediaSetInputTransform"):
        setattr(media, name, getattr(code_media, name))
    media.MediaSetInputParam = code_media.TransformMediaSetInput
    media.MediaSetOutputParam = code_media.TransformMediaSetOutput
    media.LightweightMediaSetInputParam = code_media.TransformMediaSetInput
    media.LightweightMediaSetOutputParam = code_media.TransformMediaSetOutput
    media_api = types.ModuleType("transforms.mediasets.api")
    media_api.Coordinate = code_media.Coordinate  # type: ignore[attr-defined]
    media_api.Polygon = list  # type: ignore[attr-defined]
    media.api = media_api  # type: ignore[attr-defined]
    sys.modules["transforms.mediasets.api"] = media_api
    media_inputs = types.ModuleType("transforms.mediasets.inputs")
    media_inputs.MediaSetInputParam = code_media.TransformMediaSetInput
    media_outputs = types.ModuleType("transforms.mediasets.outputs")
    media_outputs.MediaSetOutputParam = code_media.TransformMediaSetOutput
    tables = types.ModuleType("transforms.tables")
    for name in code_tables.NAMES:
        setattr(tables, name, getattr(code_tables, name))
    api.IncrementalTableTransformInput = code_tables.IncrementalTableTransformInput
    api.TableTransformInput = code_tables.TableTransformInput
    api.TableTransformOutput = code_tables.TableTransformOutput

    def _no_tables(*_a, **_k):
        raise TypeError("compute pushdown is not available on this platform: virtual tables run on Foundry-native compute "
                        "(TableInput / TableOutput with @transform.spark.using or @transform.using)")

    # compute pushdown (Snowpark, Databricks Connect, Ibis on BigQuery) has no backend here; the table locators are real
    for name in ("databricks", "DatabricksInput", "DatabricksOutput", "SnowflakeInput", "SnowflakeOutput",
                 "IbisInput", "IbisOutput", "SnowparkConnectInput", "SnowparkConnectOutput"):
        setattr(tables, name, _no_tables)
    expectations = code_expectations.module()
    code_models.install()
    import code_foundryts

    code_foundryts.install(pkg)
    import code_functions

    code_functions.install()
    code_geo.install()
    # bellaso-python-lib: Cipher EncrypterInput / DecrypterInput / HasherInput (Admin licenses)
    import code_cipher

    code_cipher.install()
    verbs = types.ModuleType("transforms.verbs")
    verbs.__path__ = []  # type: ignore[attr-defined]
    verbs_df = types.ModuleType("transforms.verbs.dataframes")
    verbs_df.sanitize_schema_for_parquet = sanitize_schema_for_parquet
    verbs.dataframes = verbs_df  # type: ignore[attr-defined]
    sys.modules.update({"transforms.verbs": verbs, "transforms.verbs.dataframes": verbs_df})
    if "foundry.transforms" not in sys.modules:
        # foundry.transforms.Dataset (unit tests patch this module with their own datasets)
        foundry = types.ModuleType("foundry")
        foundry.__path__ = []  # type: ignore[attr-defined]
        foundry_transforms = types.ModuleType("foundry.transforms")
        foundry_transforms.Dataset = FoundryDataset  # type: ignore[attr-defined]
        foundry.transforms = foundry_transforms  # type: ignore[attr-defined]
        sys.modules.update({"foundry": foundry, "foundry.transforms": foundry_transforms})
    pkg.api = api  # type: ignore[attr-defined]
    pkg.mediasets = media  # type: ignore[attr-defined]
    pkg.expectations = expectations  # type: ignore[attr-defined]
    pkg.tables = tables  # type: ignore[attr-defined]
    pkg.verbs = verbs  # type: ignore[attr-defined]
    pkg.__path__ = []  # type: ignore[attr-defined]
    media.__path__ = []  # type: ignore[attr-defined]
    media.inputs = media_inputs  # type: ignore[attr-defined]
    media.outputs = media_outputs  # type: ignore[attr-defined]
    sys.modules.update({"transforms": pkg, "transforms.api": api, "transforms.mediasets": media, "transforms.mediasets.inputs": media_inputs,
                        "transforms.mediasets.outputs": media_outputs, "transforms.expectations": expectations, "transforms.tables": tables})
    # transforms-external-systems: @external_systems, Source (requests go through the platform: credentials, egress)
    ext = types.ModuleType("transforms.external")
    ext.__path__ = []  # type: ignore[attr-defined]
    ext_systems = types.ModuleType("transforms.external.systems")
    ext_systems.external_systems, ext_systems.Source = external_systems, Source  # type: ignore[attr-defined]
    ext.systems = ext_systems  # type: ignore[attr-defined]
    pkg.external = ext  # type: ignore[attr-defined]
    sys.modules.update({"transforms.external": ext, "transforms.external.systems": ext_systems})
    # transforms-sidecar: @sidecar, Volume (the container runs on the platform's Docker runtime, sidecar_slot.py)
    side = types.ModuleType("transforms.sidecar")
    side.sidecar, side.Volume = sidecar, Volume
    side.ResourceProfile = types.SimpleNamespace(**{k: k for k in SIDECAR_PROFILES})
    pkg.sidecar = side
    sys.modules["transforms.sidecar"] = side


def ceil_threads(cores: Optional[float]) -> Optional[int]:
    return max(1, math.ceil(cores)) if cores else None


def sanitize_schema_for_parquet(df):
    """Column names Parquet accepts: the characters ` ,;{}()\\n\\t=` become underscores (pyspark or pandas)."""
    bad = re.compile(r"[ ,;{}()\n\t=]")
    if hasattr(df, "toDF"):
        return df.toDF(*[bad.sub("_", c) for c in df.columns])
    return df.rename(columns={c: bad.sub("_", str(c)) for c in df.columns})
