"""palantir_models for repository code: model adapters, their API, serialization, ModelOutput, experiments and
evaluations (palantir.com/docs/foundry/integrate-models). A local implementation of the library's public names so
Foundry code runs unchanged; nothing here calls an external service.

* `ModelAdapter` (`api()`, `predict()` / `run_inference()`, `load()` / `save()`, `transform()`, `transform_write()`),
  `@auto_serialize` with the serializers of `palantir_models.serializers`, `ModelStateWriter` / `ModelStateReader`.
* API types: `Pandas`, `Spark`, `Parameter` (type enforced), `FileSystem`, `NDArray`, `MediaReference`, `Object`,
  `ObjectSet`; `palantir_models.models.api` (`ModelApi`, `ModelApiColumn`, `DFType`, Tabular / Parameter inputs).
* `palantir_models.transforms.ModelOutput(path)`: the transform gets a `WritableModel` whose `publish(adapter,
  experiment=)` saves the adapter into this build's staging folder (`STATE["stage"]`) with the API, the adapter's
  source (the source root holding its module) and the experiment; the server commits it as a model version when the
  build succeeds (model_assets.commit_build).
* `ModelInput` of a model trained here: `load_version(spec)` imports the adapter (the repository's own module when it
  has one, else the version's source snapshot) and calls `load(state_reader)`; `LoadedModel` adds
  `create_evaluation()` and the version identifiers. `use_sidecar=True` runs it in a model_worker.py process.
* Experiments (`create_experiment`, `log_param(s)`, `log_metric(s)` with steps, images, plots, tables) and
  evaluations (`@palantir_models.transforms.evaluation(set)`, `create_evaluation`, `palantir_models.evaluations.evaluate`
  with the regression / classification evaluators, computed with numpy — no scikit-learn needed).
"""

from __future__ import annotations

import base64
import collections
import contextlib
import datetime as _dt
import enum
import functools
import importlib
import inspect
import io
import json
import logging
import math
import os
import re
import shutil
import sys
import tempfile
import types
import uuid
from pathlib import Path
from typing import Any, NamedTuple, Optional

log = logging.getLogger("palantir_models")
# MLflow (the open-source model format builds publish): no assistant hints in build logs
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")

# this run: the staging folder for ModelOutput versions, the evaluation set of the transform, what was collected
STATE: dict[str, Any] = {"stage": None, "mode": "build", "evaluation_set": None, "outputs": [], "evaluations": [], "evaluation_objects": {}}
NAME_MAX = 100


# ------------------------------------------------------------------------------------------------
# API types
# ------------------------------------------------------------------------------------------------


def type_name(t: Any) -> str:
    """A JSON-friendly name of an API type."""
    if t is None or t is Any:
        return "any"
    if isinstance(t, NDArray):
        return f"ndarray[{','.join(str(x) for x in t.shape)}:{t.dtype_name}]"
    if t is MediaReference or isinstance(t, MediaReference):
        return "media_reference"
    simple = {str: "string", int: "integer", float: "double", bool: "boolean", list: "list", dict: "map", _dt.date: "date",
              _dt.time: "time", _dt.datetime: "timestamp"}
    if t in simple:
        return simple[t]
    origin = getattr(t, "__origin__", None)
    if origin in (list, collections.abc.Sequence):
        args = getattr(t, "__args__", ()) or ()
        return f"list<{type_name(args[0]) if args else 'any'}>"
    if origin in (dict, collections.abc.Mapping):
        args = getattr(t, "__args__", ()) or ()
        return f"map<{type_name(args[0])},{type_name(args[1])}>" if len(args) == 2 else "map"
    return getattr(t, "__name__", str(t))


class ModelApiColumn(NamedTuple):
    """A column of a tabular input or output."""

    name: str
    type: Any = Any
    required: bool = True


class DFType(enum.Enum):
    SPARK = "spark"
    PANDAS = "pandas"


def _columns(columns: Optional[list]) -> list[ModelApiColumn]:
    out = []
    for c in columns or []:
        if isinstance(c, ModelApiColumn):
            out.append(c)
        elif isinstance(c, str):
            out.append(ModelApiColumn(c, Any))
        elif isinstance(c, (tuple, list)) and c:
            out.append(ModelApiColumn(str(c[0]), c[1] if len(c) > 1 else Any, bool(c[2]) if len(c) > 2 else True))
        else:
            raise TypeError(f"a column is a name or a (name, type) tuple, not {c!r}")
    return out


class _ApiItem:
    kind = "any"
    name: Optional[str] = None

    def describe(self) -> dict:
        return {"type": self.kind}


class Pandas(_ApiItem):
    """A pandas DataFrame input or output: columns as names or (name, type) tuples."""

    kind = "tabular"
    df_type = DFType.PANDAS

    def __init__(self, columns: Optional[list] = None, name: Optional[str] = None, **_: object) -> None:
        self.columns = _columns(columns)
        self.name = name

    def describe(self) -> dict:
        return {"type": "tabular", "df_type": self.df_type.value,
                "columns": [{"name": c.name, "type": type_name(c.type), "required": c.required} for c in self.columns]}


class Spark(Pandas):
    df_type = DFType.SPARK


class Parameter(_ApiItem):
    """A constant single value; its type is enforced."""

    kind = "parameter"

    def __init__(self, type: Any = Any, default: Any = None, name: Optional[str] = None, required: Optional[bool] = None, **_: object) -> None:  # noqa: A002
        self.type, self.default, self.name = type, default, name
        self.required = required

    def describe(self) -> dict:
        d = _jsonable(self.default)
        return {"type": "parameter", "value_type": type_name(self.type), "default": d}


class FileSystem(_ApiItem):
    kind = "filesystem"

    def __init__(self, name: Optional[str] = None, **_: object) -> None:
        self.name = name


class MediaReference(_ApiItem):
    """As an API input: a media reference (a JSON string or dict). As a column type: each value becomes one of these.
    A converted value has `media_reference`, `media_item_rid` and `get_media_item()`."""

    kind = "media_reference"

    def __init__(self, reference: Any = None, name: Optional[str] = None, **_: object) -> None:
        self.name = name
        self._raw = reference

    @property
    def media_reference(self) -> Any:
        return self._raw

    @property
    def media_item_rid(self) -> Optional[str]:
        ref = self._raw
        if isinstance(ref, str):
            try:
                ref = json.loads(ref)
            except ValueError:
                return ref
        if isinstance(ref, dict):
            inner = (ref.get("reference") or {}).get("mediaSetViewItem") or {}
            return inner.get("mediaItemRid") or ref.get("mediaItemRid")
        return None

    def get_media_item(self) -> io.BytesIO:
        """The item's bytes, read through this platform's API with the build's token."""
        rid = self.media_item_rid
        if not rid:
            raise ValueError("this media reference names no media item")
        return io.BytesIO(_api_get(f"/api/drive/items/{rid}/content"))

    def get_media_item_metadata(self) -> dict:
        rid = self.media_item_rid
        return json.loads(_api_get(f"/api/drive/items/{rid}")) if rid else {}

    def __repr__(self) -> str:
        return f"MediaReference({self.media_item_rid!r})"


class NDArray:
    """A numpy ndarray parameter type: a shape (-1 matches any size) and a dtype."""

    def __init__(self, shape: list, dtype: Any) -> None:
        import numpy as np

        self.shape = [int(x) for x in shape]
        self.dtype = np.dtype(dtype)
        self.dtype_name = self.dtype.name

    def convert(self, value: Any):
        import numpy as np

        arr = value if isinstance(value, np.ndarray) else np.array(value, dtype=self.dtype)
        if arr.dtype != self.dtype:
            arr = arr.astype(self.dtype)
        if len(arr.shape) != len(self.shape) or any(s != -1 and s != a for s, a in zip(self.shape, arr.shape)):
            raise TypeError(f"expected an ndarray of shape {self.shape}, got {list(arr.shape)}")
        return arr


class Object(_ApiItem):
    """An Ontology object input: an object of the type, or its primary key."""

    kind = "object"

    def __init__(self, object_type: Any = None, name: Optional[str] = None, **_: object) -> None:
        self.object_type, self.name = object_type, name

    def describe(self) -> dict:
        return {"type": "object", "object_type": getattr(self.object_type, "__name__", str(self.object_type))}


class ObjectSet(Object):
    kind = "object_set"

    def describe(self) -> dict:
        return {"type": "object_set", "object_type": getattr(self.object_type, "__name__", str(self.object_type))}


class ModelApi:
    """`palantir_models.models.api.ModelApi(inputs=[...], outputs=[...])`: named items instead of two dicts."""

    def __init__(self, inputs: list, outputs: list) -> None:
        self.inputs, self.outputs = list(inputs), list(outputs)


def _tabular(name: str, df_type: DFType = DFType.SPARK, columns: Optional[list] = None, **_: object) -> Pandas:
    return (Spark if df_type == DFType.SPARK else Pandas)(columns, name=name)


class _ApiInputs:
    Tabular = staticmethod(_tabular)
    Parameter = staticmethod(lambda name, type=Any, default=None, **kw: Parameter(type, default, name=name))  # noqa: A002
    FileSystem = staticmethod(lambda name, **kw: FileSystem(name=name))
    MediaReference = staticmethod(lambda name, **kw: MediaReference(name=name))


class _ApiOutputs:
    Tabular = staticmethod(lambda name, **kw: Pandas(kw.get("columns"), name=name))
    Parameter = staticmethod(lambda name, type=Any, default=None, **kw: Parameter(type, default, name=name))  # noqa: A002
    FileSystem = staticmethod(lambda name, **kw: FileSystem(name=name))


def api_of(cls: Any) -> tuple[dict, dict]:
    """The adapter's (inputs, outputs) by name."""
    res = cls.api()
    if isinstance(res, ModelApi):
        return {i.name: i for i in res.inputs}, {o.name: o for o in res.outputs}
    if isinstance(res, tuple) and len(res) == 2 and all(isinstance(x, dict) for x in res):
        ins, outs = res
        for k, v in [*ins.items(), *outs.items()]:
            if not isinstance(v, _ApiItem):
                raise TypeError(f"api() item {k} must be pm.Pandas, pm.Spark, pm.Parameter, pm.FileSystem, pm.MediaReference, pm.Object or pm.ObjectSet")
        return dict(ins), dict(outs)
    raise TypeError(f"{getattr(cls, '__name__', type(cls).__name__)}.api() must return (inputs, outputs) dicts or a ModelApi")


def describe_api(cls: type) -> dict:
    ins, outs = api_of(cls)
    return {"inputs": [{"name": k, **v.describe()} for k, v in ins.items()], "outputs": [{"name": k, **v.describe()} for k, v in outs.items()]}


# ------------------------------------------------------------------------------------------------
# converting inputs and outputs
# ------------------------------------------------------------------------------------------------


def _jsonable(v: Any) -> Any:
    try:
        import numpy as np

        if isinstance(v, np.ndarray):
            return v.tolist()
        if isinstance(v, np.generic):
            return v.item()
    except ImportError:
        pass
    if isinstance(v, (_dt.date, _dt.datetime, _dt.time)):
        return v.isoformat()
    if isinstance(v, MediaReference):
        return v.media_reference
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def to_pandas(v: Any):
    import pandas as pd

    if isinstance(v, pd.DataFrame):
        return v
    if hasattr(v, "pandas") and callable(v.pandas):
        return v.pandas()
    if hasattr(v, "toPandas") and callable(v.toPandas):
        return v.toPandas()
    if hasattr(v, "to_pandas") and callable(v.to_pandas):
        return v.to_pandas()
    if isinstance(v, list):
        return pd.DataFrame([dict(r) for r in v])
    if isinstance(v, dict):
        return pd.DataFrame(v)
    raise TypeError(f"a tabular input takes a DataFrame, a transform input or a list of rows, not {type(v).__name__}")


def _to_spark(v: Any):
    if hasattr(v, "dataframe") and callable(v.dataframe):
        return v.dataframe()
    if hasattr(v, "toPandas"):
        return v
    from pyspark.sql import SparkSession

    return SparkSession.builder.getOrCreate().createDataFrame(to_pandas(v))


def _cast_value(v: Any, t: Any, column: str) -> Any:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    try:
        if t is int:
            return int(float(v))
        if t is float:
            return float(v)
        if t is str:
            return str(v)
        if t is bool:
            return v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "y", "t")
        if t is _dt.datetime:
            return v if isinstance(v, _dt.datetime) else _dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        if t is _dt.date:
            return v if isinstance(v, _dt.date) else _dt.date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        raise TypeError(f"column {column}: {v!r} cannot be cast to {type_name(t)}") from None
    return v


def convert_input(name: str, spec: _ApiItem, value: Any, cast: bool = False) -> Any:
    """A value for the adapter: tabular inputs as pandas / Spark DataFrames (media reference columns converted), parameters
    type-checked. `cast` (live inference): declared column types are enforced and cast, required columns must exist."""
    if isinstance(spec, Spark):
        return _to_spark(value)
    if isinstance(spec, Pandas):
        df = to_pandas(value).copy()
        for c in spec.columns:
            if c.name not in df.columns:
                if cast and c.required:
                    raise TypeError(f"input {name} has no column {c.name} ({type_name(c.type)})")
                continue
            if c.type is MediaReference:
                df[c.name] = [MediaReference(x) if x is not None and not isinstance(x, MediaReference) else x for x in df[c.name]]
            elif cast and c.type in (int, float, str, bool, _dt.date, _dt.datetime):
                df[c.name] = [_cast_value(x, c.type, c.name) for x in df[c.name]]
        return df
    if isinstance(spec, Parameter):
        t = spec.type
        if isinstance(t, NDArray):
            return t.convert(value)
        if value is None or t is Any or t is None:
            return value
        base = getattr(t, "__origin__", None) or t
        if cast and base in (int, float, str, bool):
            return _cast_value(value, base, name)
        if base is float and isinstance(value, int) and not isinstance(value, bool):
            return float(value)
        if isinstance(base, type) and not isinstance(value, base) or (base is int and isinstance(value, bool)):
            raise TypeError(f"parameter {name} expects {type_name(t)}, got {type(value).__name__}")
        return value
    if isinstance(spec, MediaReference):
        return value if isinstance(value, MediaReference) else MediaReference(value)
    if isinstance(spec, (Object, ObjectSet)):
        return _ontology_value(spec, value)
    if isinstance(spec, FileSystem):
        if hasattr(value, "filesystem") and callable(value.filesystem):
            return value.filesystem()
        return value
    return value


def _ontology_value(spec: Object, value: Any) -> Any:
    """A primary key (Object) or an object set rid (ObjectSet) becomes the OSDK value when the type is an OSDK class."""
    if not isinstance(value, (str, int, float)) or spec.object_type is None:
        return value
    try:
        from ontology_sdk import FoundryClient  # type: ignore

        objects = getattr(FoundryClient().ontology.objects, getattr(spec.object_type, "__name__", str(spec.object_type)))
        if isinstance(spec, ObjectSet):
            return objects
        return objects.get(value)
    except Exception:  # noqa: BLE001 - outside a platform run the raw value is passed through
        return value


class Outputs(dict):
    """The result of transform(): outputs by name, also as attributes (result.output_df)."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


class _Slot:
    def __init__(self, spec: _ApiItem, target: Any = None) -> None:
        self.spec, self.target = spec, target
        self.value: Any = getattr(spec, "default", None)
        self.written = False

    def write(self, value: Any) -> None:
        self.value, self.written = value, True
        if self.target is not None and hasattr(self.target, "write_pandas"):
            if hasattr(value, "toPandas") and hasattr(self.target, "write_dataframe"):
                self.target.write_dataframe(value)
            else:
                self.target.write_pandas(to_pandas(value))

    def open(self, path: str, mode: str = "w", **kw: Any):
        if isinstance(self.spec, FileSystem) and self.target is not None:
            fs = self.target.filesystem() if hasattr(self.target, "filesystem") else self.target
            return fs.open(path, mode, **kw)
        raise TypeError("FileSystem outputs are only usable via .transform_write() with a dataset output")

    def __getattr__(self, name: str) -> Any:
        if name in ("spec", "target", "value", "written"):
            raise AttributeError(name)
        if self.target is not None:
            return getattr(self.target, name)
        raise AttributeError(name)


# ------------------------------------------------------------------------------------------------
# state readers and writers, serializers
# ------------------------------------------------------------------------------------------------


class ModelStateWriter:
    """Where save() writes the model's files (they are zipped into the model version)."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, rel: str) -> Path:
        p = (self.root / str(rel).lstrip("/\\")).resolve()
        if self.root.resolve() not in (p, *p.parents):
            raise ValueError(f"{rel} is outside the model's files")
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def open(self, asset_file_path: str, mode: str = "wb"):
        return open(self._p(asset_file_path), mode, **({} if "b" in mode else {"encoding": "utf-8"}))

    def put_file(self, local_file_path: str, asset_file_path: Optional[str] = None) -> None:
        shutil.copyfile(local_file_path, self._p(asset_file_path or Path(local_file_path).name))

    def put_directory(self, local_root_path: str, asset_root_path: str = "/") -> None:
        dest = self._p(asset_root_path) if asset_root_path.strip("/") else self.root
        shutil.copytree(local_root_path, dest, dirs_exist_ok=True)

    def mkdir(self, name: str) -> str:
        p = self._p(name)
        p.mkdir(parents=True, exist_ok=True)
        return str(p)


class ModelStateReader:
    """What load() reads the model's files from."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def _p(self, rel: str) -> Path:
        p = (self.root / str(rel).lstrip("/\\")).resolve()
        if self.root.resolve() not in (p, *p.parents):
            raise ValueError(f"{rel} is outside the model's files")
        return p

    def open(self, asset_file_path: str, mode: str = "rb"):
        p = self._p(asset_file_path)
        if not p.exists():
            raise FileNotFoundError(f"{asset_file_path} is not in this model version's files")
        return open(p, mode, **({} if "b" in mode else {"encoding": "utf-8"}))

    def dir(self, name: str) -> str:
        return str(self._p(name))

    def extract_to_temp_dir(self, root_dir: Optional[str] = None) -> str:
        d = tempfile.mkdtemp(prefix="model-", dir=root_dir)
        shutil.copytree(self.root, d, dirs_exist_ok=True)
        return d

    def extract(self, destination_path: Optional[str] = None) -> str:
        dest = destination_path or tempfile.mkdtemp(prefix="model-")
        shutil.copytree(self.root, dest, dirs_exist_ok=True)
        return dest


class _ScopedWriter(ModelStateWriter):
    def __init__(self, parent: ModelStateWriter, prefix: str) -> None:
        super().__init__(parent.root / prefix)


class _ScopedReader(ModelStateReader):
    def __init__(self, parent: ModelStateReader, prefix: str) -> None:
        super().__init__(parent.root / prefix)


class ModelSerializer:
    """A reusable serializer for @auto_serialize: serialize(writer, obj) and deserialize(reader)."""

    def __class_getitem__(cls, _item):
        return cls

    def serialize(self, writer: ModelStateWriter, obj: Any) -> None:
        raise NotImplementedError

    def deserialize(self, reader: ModelStateReader) -> Any:
        raise NotImplementedError


def _need(module: str, serializer: str):
    try:
        return importlib.import_module(module)
    except ImportError:
        raise ImportError(f"{serializer} needs the {module} package, which is not installed in this environment") from None


class DillSerializer(ModelSerializer):
    file_name = "dill.pkl"

    def __init__(self) -> None:
        self.dill = _need("dill", "DillSerializer")

    def serialize(self, writer, obj):
        with writer.open(self.file_name, "wb") as f:
            self.dill.dump(obj, f, recurse=True)

    def deserialize(self, reader):
        with reader.open(self.file_name, "rb") as f:
            return self.dill.load(f)


class CloudPickleSerializer(ModelSerializer):
    file_name = "cloudpickle.pkl"

    def __init__(self) -> None:
        self.cloudpickle = _need("cloudpickle", "CloudPickleSerializer")

    def serialize(self, writer, obj):
        with writer.open(self.file_name, "wb") as f:
            self.cloudpickle.dump(obj, f)

    def deserialize(self, reader):
        with reader.open(self.file_name, "rb") as f:
            return self.cloudpickle.load(f)


class JsonSerializer(ModelSerializer):
    file_name = "config.json"

    def serialize(self, writer, obj):
        with writer.open(self.file_name, "w") as f:
            json.dump(obj, f)

    def deserialize(self, reader):
        with reader.open(self.file_name, "r") as f:
            return json.load(f)


class YamlSerializer(ModelSerializer):
    file_name = "config.yaml"

    def __init__(self) -> None:
        self.yaml = _need("yaml", "YamlSerializer")

    def serialize(self, writer, obj):
        with writer.open(self.file_name, "w") as f:
            self.yaml.safe_dump(obj, f)

    def deserialize(self, reader):
        with reader.open(self.file_name, "r") as f:
            return self.yaml.safe_load(f)


class PytorchStateSerializer(ModelSerializer):
    STATE_DICT_FILE_NAME = "model_state_dict.pt"

    def __init__(self) -> None:
        self.torch = _need("torch", "PytorchStateSerializer")

    def serialize(self, writer, obj):
        with writer.open(self.STATE_DICT_FILE_NAME, "wb") as f:
            self.torch.save(obj, f)

    def deserialize(self, reader):
        with reader.open(self.STATE_DICT_FILE_NAME, "rb") as f:
            return self.torch.load(f)


class TensorflowFormat(enum.Enum):
    DIR = 0
    H5 = 1
    KERAS = 2

    def get_save_path(self, dir_path: str) -> str:
        return {0: dir_path, 1: os.path.join(dir_path, "model.h5"), 2: os.path.join(dir_path, "model.keras")}[self.value]


class TensorflowKerasSerializer(ModelSerializer):
    DIR_NAME = "tensorflow_saved_model_dir"

    def __init__(self, format: TensorflowFormat = TensorflowFormat.DIR, custom_objects: Optional[dict] = None) -> None:  # noqa: A002
        self.tf = _need("tensorflow", "TensorflowKerasSerializer")
        self.format, self.custom_objects = format, custom_objects

    def serialize(self, writer, obj):
        obj.save(self.format.get_save_path(writer.mkdir(self.DIR_NAME)))

    def deserialize(self, reader):
        obj = self.tf.keras.models.load_model(self.format.get_save_path(reader.dir(self.DIR_NAME)), custom_objects=self.custom_objects, compile=False)
        obj.compile()
        return obj


class XGBoostSerializer(ModelSerializer):
    file_name = "xgboost_model.json"

    def __init__(self) -> None:
        self.xgb = _need("xgboost", "XGBoostSerializer")

    def serialize(self, writer, obj):
        obj.save_model(str(writer._p(self.file_name)))

    def deserialize(self, reader):
        path = str(reader._p(self.file_name))
        # XGBoost 3 loads a model only into its own estimator type (recorded in the file); a plain Booster has none
        try:
            attrs = json.loads(json.loads(Path(path).read_text("utf-8"))["learner"]["attributes"].get("scikit_learn") or "{}")
        except (ValueError, KeyError, TypeError):
            attrs = {}
        kind = attrs.get("_estimator_type")
        if not attrs:
            model = self.xgb.Booster()
        else:
            model = {"classifier": self.xgb.XGBClassifier, "regressor": self.xgb.XGBRegressor, "ranker": self.xgb.XGBRanker}.get(kind, self.xgb.sklearn.XGBModel)()
        model.load_model(path)
        return model


class _HfSerializer(ModelSerializer):
    DIR_NAME = "model"

    def __init__(self, cls_name: str, model_class=None, **load_kwargs) -> None:
        self.transformers = _need("transformers", type(self).__name__)
        self.model_class = model_class or getattr(self.transformers, cls_name)
        self.load_kwargs = load_kwargs

    def serialize(self, writer, obj):
        obj.save_pretrained(writer.mkdir(self.DIR_NAME))

    def deserialize(self, reader):
        return self.model_class.from_pretrained(reader.dir(self.DIR_NAME), **self.load_kwargs)


class HfAutoModelSerializer(_HfSerializer):
    DIR_NAME = "model"

    def __init__(self, model_class=None, **load_kwargs) -> None:
        super().__init__("AutoModel", model_class, **load_kwargs)


class HfAutoTokenizerSerializer(_HfSerializer):
    DIR_NAME = "tokenizer"

    def __init__(self, tokenizer_class=None, **load_kwargs) -> None:
        super().__init__("AutoTokenizer", tokenizer_class, **load_kwargs)


class HfPipelineSerializer(ModelSerializer):
    DIR_NAME = "pipeline"

    def __init__(self, pipeline_type: str, **load_kwargs) -> None:
        self.transformers = _need("transformers", "HfPipelineSerializer")
        self.pipeline_type, self.load_kwargs = pipeline_type, load_kwargs

    def serialize(self, writer, obj):
        obj.save_pretrained(writer.mkdir(self.DIR_NAME))

    def deserialize(self, reader):
        return self.transformers.pipeline(self.pipeline_type, model=reader.dir(self.DIR_NAME), **self.load_kwargs)


class SparkMLAutoSerializer(ModelSerializer):
    """A pyspark.ml PipelineModel (any Spark MLlib model wrapped in a Pipeline)."""

    DIR_NAME = "spark_pipeline"
    # Windows without winutils.exe (HADOOP_HOME): Spark's own writer goes through Hadoop's local file system, which
    # needs it. The model's JVM object is written with Java serialization instead (same Spark version to read it).
    JAVA_FILE = "spark_pipeline.javaser"

    @staticmethod
    def _jvm():
        from pyspark.sql import SparkSession

        active = SparkSession.getActiveSession()
        if active is None:
            # a model is loaded before the transform's session exists (and in a model process): the platform's local
            # session, which knows where the JDK is
            try:
                import code_pyapi

                active = code_pyapi.spark_session()
            except ImportError:
                active = SparkSession.builder.getOrCreate()
        return active.sparkContext._jvm

    def serialize(self, writer, obj):
        if os.name == "nt" and not os.environ.get("HADOOP_HOME"):
            if not hasattr(obj, "_to_java"):
                raise TypeError(f"SparkMLAutoSerializer saves pyspark.ml models (a PipelineModel), not {type(obj).__name__}")
            jvm = self._jvm()
            buf = jvm.java.io.ByteArrayOutputStream()
            out = jvm.java.io.ObjectOutputStream(buf)
            out.writeObject(obj._to_java())
            out.close()
            with writer.open(self.JAVA_FILE, "wb") as f:
                f.write(bytes(buf.toByteArray()))
            return
        obj.write().overwrite().save(writer.mkdir(self.DIR_NAME))

    def deserialize(self, reader):
        try:
            f = reader.open(self.JAVA_FILE, "rb")
        except FileNotFoundError:
            f = None
        if f is not None:
            from pyspark.ml.wrapper import JavaParams

            with f:
                data = f.read()
            jvm = self._jvm()
            return JavaParams._from_java(jvm.java.io.ObjectInputStream(jvm.java.io.ByteArrayInputStream(bytearray(data))).readObject())
        from pyspark.ml import PipelineModel

        return PipelineModel.read().load(reader.dir(self.DIR_NAME))


def auto_serialize(*args: Any, **serializers: ModelSerializer):
    """`@auto_serialize` on `__init__`: every argument saved with Dill, or `@auto_serialize(arg=Serializer(), ...)` with
    a serializer for every argument."""

    def deco(init):
        sig = inspect.signature(init)
        names = [n for n, p in sig.parameters.items() if n != "self" and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)]
        if serializers and set(serializers) != set(names):
            missing = sorted(set(names) - set(serializers))
            extra = sorted(set(serializers) - set(names))
            raise TypeError("@auto_serialize(...) needs one serializer per __init__ argument"
                            + (f"; missing: {', '.join(missing)}" if missing else "") + (f"; not arguments: {', '.join(extra)}" if extra else ""))

        @functools.wraps(init)
        def wrapper(self, *a, **kw):
            bound = sig.bind(self, *a, **kw)
            bound.apply_defaults()
            self._pm_init_args = {k: v for k, v in bound.arguments.items() if k in names}
            return init(self, *a, **kw)

        wrapper._pm_serializers = dict(serializers) if serializers else None  # type: ignore[attr-defined]
        wrapper._pm_names = names  # type: ignore[attr-defined]
        return wrapper

    if len(args) == 1 and callable(args[0]) and not serializers:
        return deco(args[0])
    if args:
        raise TypeError("@auto_serialize takes serializers as keyword arguments")
    return deco


def _serializers(cls: type) -> Optional[dict]:
    init = getattr(cls, "__init__", None)
    if not hasattr(init, "_pm_names"):
        return None
    return init._pm_serializers or {n: DillSerializer() for n in init._pm_names}


# ------------------------------------------------------------------------------------------------
# model adapters
# ------------------------------------------------------------------------------------------------


class ModelAdapter:
    """The adapter base class: api() declares inputs and outputs, predict() (single output) or run_inference()
    computes, load() / save() (or @auto_serialize) read and write the model's files."""

    @classmethod
    def api(cls):
        raise NotImplementedError("Model adapter `api` not defined")

    def predict(self, *args, **kwargs):
        raise NotImplementedError("Model adapter predict method not defined")

    @classmethod
    def load(cls, state_reader: ModelStateReader, container_context=None, external_model_context=None):
        sers = _serializers(cls)
        if sers is None:
            raise NotImplementedError(f"{cls.__name__}.load() is not defined: implement load() / save() or use @auto_serialize")
        return cls(**{name: ser.deserialize(_ScopedReader(state_reader, name)) for name, ser in sers.items()})

    def save(self, state_writer: ModelStateWriter) -> None:
        sers = _serializers(type(self))
        if sers is None:
            raise NotImplementedError(f"{type(self).__name__}.save() is not defined: implement save() / load() or use @auto_serialize")
        args = getattr(self, "_pm_init_args", None)
        if args is None:
            raise RuntimeError(f"{type(self).__name__}.__init__ was not run through @auto_serialize")
        for name, ser in sers.items():
            ser.serialize(_ScopedWriter(state_writer, name), args[name])

    def run_inference(self, inputs, outputs) -> None:
        if type(self).predict is ModelAdapter.predict:
            raise NotImplementedError("Model adapter predict method not defined")
        res = self.predict(**inputs._asdict())
        names = list(outputs._fields)
        if len(names) == 1:
            getattr(outputs, names[0]).write(res)
        elif isinstance(res, dict) and set(res) <= set(names):
            for k, v in res.items():
                getattr(outputs, k).write(v)
        elif isinstance(res, tuple) and len(res) == len(names):
            for k, v in zip(names, res):
                getattr(outputs, k).write(v)
        else:
            raise TypeError("a model with several outputs returns them as a dict or tuple from predict(), or implements run_inference()")

    def _bind(self, args: tuple, kwargs: dict, cast: bool = False) -> dict:
        ins, _ = api_of(self)
        names = list(ins)
        if len(args) > len(names):
            raise TypeError(f"the model takes {len(names)} input(s) ({', '.join(names)}), got {len(args)}")
        bound = dict(zip(names, args))
        for k, v in kwargs.items():
            if k not in ins:
                raise TypeError(f"the model has no input {k}: its inputs are {', '.join(names)}")
            bound[k] = v
        out = {}
        for name, spec in ins.items():
            if name not in bound:
                if isinstance(spec, Parameter):
                    out[name] = spec.default
                    continue
                raise TypeError(f"missing model input {name}")
            out[name] = convert_input(name, spec, bound[name], cast)
        return out

    def transform(self, *args, **kwargs) -> Outputs:
        """Inference on these inputs (by api() order or by name): the outputs by name."""
        return self._transform(args, kwargs)

    def _transform(self, args: tuple, kwargs: dict, cast: bool = False, targets: Optional[dict] = None) -> Outputs:
        bound = self._bind(args, kwargs, cast)
        _, outs = api_of(self)
        slots = {k: _Slot(v, (targets or {}).get(k)) for k, v in outs.items()}
        if any(isinstance(v, FileSystem) and k not in (targets or {}) for k, v in outs.items()):
            raise TypeError("FileSystem outputs are only usable via .transform_write()")
        In = collections.namedtuple("ModelInputs", list(bound) or ["_"])  # type: ignore[misc]
        Out = collections.namedtuple("ModelOutputs", list(slots) or ["_"])  # type: ignore[misc]
        self.run_inference(In(**bound) if bound else In(None), Out(**slots) if slots else Out(None))
        return Outputs({k: s.value for k, s in slots.items()})

    def transform_write(self, *args) -> None:
        """transform(inputs…) written to the last argument: a dataset output, or outputs by name."""
        *inputs, output = args
        _, outs = api_of(self)
        targets = {next(iter(outs)): output} if len(outs) == 1 and not isinstance(output, dict) else dict(output)
        self._transform(tuple(inputs), {}, targets=targets)


class ContainerModelAdapter(ModelAdapter):
    @classmethod
    def init_container(cls, container_context):
        raise NotImplementedError(f"{cls.__name__}.init_container(container_context)")


class ExternalModelAdapter(ModelAdapter):
    @classmethod
    def init_external(cls, external_context):
        raise NotImplementedError(f"{cls.__name__}.init_external(external_context)")

    @classmethod
    def load(cls, state_reader=None, container_context=None, external_model_context=None):
        return cls.init_external(external_model_context)


class ContainerizedApplicationContext:
    """What init_container gets: services maps each container's name to its "host:port" URIs."""

    def __init__(self, services: dict, shared_empty_dir_mount_path: str) -> None:
        self.services = services
        self.shared_empty_dir_mount_path = shared_empty_dir_mount_path


class ExternalModel:
    def __init__(self, base_url: str, connection_configuration: dict) -> None:
        self.base_url = base_url
        self.connection_configuration = dict(connection_configuration or {})


class ExternalModelContext:
    """What an externally hosted model's adapter gets: the model (base URL, configuration) and decrypted credentials."""

    def __init__(self, base_url: str, connection_configuration: dict, resolved_credentials: dict) -> None:
        self.external_model = ExternalModel(base_url, connection_configuration)
        self.resolved_credentials = dict(resolved_credentials or {})
        # the flat names init_external examples use (external_context.base_url / .connection_config)
        self.base_url = base_url
        self.connection_config = self.external_model.connection_configuration


# ------------------------------------------------------------------------------------------------
# experiments and evaluations
# ------------------------------------------------------------------------------------------------


class ErrorHandlerType(enum.Enum):
    FAIL = "FAIL"
    WARN = "WARN"
    SUPPRESS = "SUPPRESS"


def _png(image: Any) -> bytes:
    if isinstance(image, (str, os.PathLike)):
        data = Path(image).read_bytes()
    elif isinstance(image, (bytes, bytearray)):
        data = bytes(image)
    elif hasattr(image, "save"):
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        data = buf.getvalue()
    else:
        raise TypeError("an image is a PNG file path, PNG bytes or a Pillow image")
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("only PNG images can be logged")
    return data


def _figure(plot: Any) -> dict:
    if hasattr(plot, "to_plotly_json"):
        return json.loads(json.dumps(plot.to_plotly_json(), default=_jsonable))
    if hasattr(plot, "to_json"):
        return json.loads(plot.to_json())
    if isinstance(plot, dict) and ("data" in plot or "layout" in plot):
        return json.loads(json.dumps(plot, default=_jsonable))
    raise TypeError("a plot is a plotly.graph_objects.Figure (or its JSON dict with data / layout)")


def _table(table: Any, limit: int = 100_000) -> dict:
    df = to_pandas(table)
    if len(df) > limit:
        raise ValueError(f"a table holds at most {limit:,} rows")
    return {"columns": [str(c) for c in df.columns], "rows": [[_jsonable(v) for v in r] for r in df.itertuples(index=False, name=None)]}


def _check_name(name: str, what: str) -> str:
    name = str(name)
    if not name or len(name) > NAME_MAX:
        raise ValueError(f"{what} names are 1 to {NAME_MAX} characters")
    return name


class Experiment:
    """A training run's hyperparameters and stepped metric series, published with a model version."""

    MAX_VALUES = 100_000
    MAX_PARAMS = 500

    def __init__(self, name: str, error_handler_type: ErrorHandlerType = ErrorHandlerType.WARN) -> None:
        self.name = _check_name(name, "experiment")
        self.error_handler_type = error_handler_type
        self.params: dict[str, Any] = {}
        self.metrics: dict[str, list[dict]] = {}
        self.images: dict[str, list[dict]] = {}
        self.plots: dict[str, list[dict]] = {}
        # structured evaluations (binary classification) logged with the run, drawn by the app
        self.evaluations: dict[str, dict] = {}
        self.tables: dict[str, dict] = {}
        self.created_at = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
        self._warned = False

    def _handle(self, e: Exception) -> None:
        if self.error_handler_type == ErrorHandlerType.FAIL:
            raise e
        if self.error_handler_type == ErrorHandlerType.WARN and not self._warned:
            self._warned = True
            log.warning("experiment %s: %s (further errors are suppressed)", self.name, e)

    def _guard(fn):  # noqa: N805
        @functools.wraps(fn)
        def wrapper(self, *a, **kw):
            try:
                return fn(self, *a, **kw)
            except (TypeError, ValueError, OSError) as e:
                self._handle(e)

        return wrapper

    @staticmethod
    def _next_step(series: list[dict], step: Optional[int]) -> int:
        last = series[-1]["step"] if series else -1
        if step is None:
            return last + 1
        step = int(step)
        if step <= last:
            raise ValueError(f"step {step} was already logged or is before the series' current step {last}")
        return step

    @_guard
    def log_param(self, key: str, value: Any) -> None:
        if not isinstance(value, (bool, int, float, str, _dt.date, _dt.datetime)):
            raise TypeError(f"parameter {key}: values are bool, date, datetime, float, int or str, not {type(value).__name__}")
        if key not in self.params and len(self.params) >= self.MAX_PARAMS:
            raise ValueError(f"an experiment holds at most {self.MAX_PARAMS} hyperparameters")
        self.params[_check_name(key, "hyperparameter")] = _jsonable(value)

    def log_params(self, parameter_map: dict) -> None:
        for k, v in parameter_map.items():
            self.log_param(k, v)

    @_guard
    def log_metric(self, metric_name: str, metric_value: float, step: Optional[int] = None) -> None:
        if isinstance(metric_value, bool) or not isinstance(_jsonable(metric_value), (int, float)):
            raise TypeError(f"metric {metric_name}: values are numeric")
        if sum(len(s) for s in self.metrics.values()) >= self.MAX_VALUES:
            raise ValueError(f"an experiment holds at most {self.MAX_VALUES:,} metric values")
        series = self.metrics.setdefault(_check_name(metric_name, "metric"), [])
        series.append({"step": self._next_step(series, step), "value": float(_jsonable(metric_value)),
                       "at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")})

    def log_metrics(self, values: dict, step: Optional[int] = None) -> None:
        for k, v in values.items():
            self.log_metric(k, v, step)

    @_guard
    def log_image(self, series_name: str, image: Any, caption: Optional[str] = None, step: Optional[int] = None) -> None:
        series = self.images.setdefault(_check_name(series_name, "image"), [])
        series.append({"step": self._next_step(series, step), "png": base64.b64encode(_png(image)).decode(), "caption": (caption or "")[:200]})

    @_guard
    def log_plot(self, series_name: str, plot_data: Any, caption: Optional[str] = None, step: Optional[int] = None) -> None:
        series = self.plots.setdefault(_check_name(series_name, "plot"), [])
        series.append({"step": self._next_step(series, step), "figure": _figure(plot_data), "caption": (caption or "")[:200]})

    @_guard
    def log_table(self, table_name: str, table: Any, description: Optional[str] = None) -> None:
        self.tables[_check_name(table_name, "table")] = {**_table(table), "description": description or ""}

    @contextlib.contextmanager
    def as_mlflow_run(self):
        """The active MLflow run writes to this experiment: params, stepped metrics and PNG artifacts are copied in when
        the block ends (like Foundry: tags and other assets are dropped, nested runs are not supported)."""
        mlflow = _need("mlflow", "Experiment.as_mlflow_run")
        if mlflow.active_run() is not None:
            raise RuntimeError("nested MLflow runs are not supported: end the active run first")
        prev_uri = mlflow.get_tracking_uri()
        with tempfile.TemporaryDirectory(prefix="bsai-mlflow-", ignore_cleanup_errors=True) as tmp:
            # a throwaway SQLite store (MLflow 3 refuses the file store) with its artifacts next to it
            mlflow.set_tracking_uri("sqlite:///" + Path(tmp, "mlflow.db").as_posix())
            try:
                exp_id = mlflow.tracking.MlflowClient().create_experiment(self.name, artifact_location=Path(tmp, "artifacts").as_uri())
                with mlflow.start_run(experiment_id=exp_id, run_name=self.name) as run:
                    yield run
                self._from_mlflow(mlflow, run.info.run_id)
            finally:
                mlflow.set_tracking_uri(prev_uri)

    def _from_mlflow(self, mlflow, run_id: str) -> None:
        client = mlflow.tracking.MlflowClient()
        data = client.get_run(run_id).data
        for k, v in data.params.items():
            # MLflow keeps every parameter as text: numbers and booleans come back typed
            val: Any = v
            for conv in (int, float):
                try:
                    val = conv(v)
                    break
                except ValueError:
                    pass
            if v in ("True", "False"):
                val = v == "True"
            self.log_param(k[:100], val)
        for name in data.metrics:
            last = None
            for m in sorted(client.get_metric_history(run_id, name), key=lambda m: (m.step, m.timestamp)):
                if last is not None and m.step <= last:
                    continue
                self.log_metric(name[:100], m.value, m.step)
                last = m.step

        def walk_all(path: Optional[str]):
            for a in client.list_artifacts(run_id, path):
                if a.is_dir:
                    yield from walk_all(a.path)
                else:
                    yield a.path

        for p in walk_all(None):
            low = p.lower()
            if not (low.endswith(".png") or low.endswith(".json")):
                continue
            local = client.download_artifacts(run_id, p)
            name = re.sub(r"[^A-Za-z0-9_\- .]", "_", os.path.splitext(p)[0])[:100]
            if low.endswith(".png"):
                self.log_image(name, Path(local).read_bytes())
                continue
            # mlflow.log_table: {"columns": [...], "data": [[...], ...]} → the experiment's table
            try:
                doc = json.loads(Path(local).read_text("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(doc, dict) and doc.get("type") in ("binary_classification", "regression"):
                # a structured evaluation (confusion matrix, ROC / PR curves, calibration, score histograms): drawn by
                # the app itself, keyed by its folder in the run ("kunci/evaluation.json" → "kunci")
                key = p.rsplit("/", 1)[0] if "/" in p else os.path.splitext(p)[0]
                self.evaluations[_check_name(re.sub(r"[^A-Za-z0-9_\- .]", "_", key)[:100], "evaluation")] = doc
                continue
            if isinstance(doc, dict) and isinstance(doc.get("columns"), list) and isinstance(doc.get("data"), list):
                import pandas as pd

                self.log_table(name, pd.DataFrame(doc["data"], columns=doc["columns"]))

    def export(self) -> dict:
        return {"name": self.name, "created_at": self.created_at, "params": self.params, "metrics": self.metrics, "images": self.images,
                "plots": self.plots, "tables": self.tables, **({"evaluations": self.evaluations} if self.evaluations else {})}


class Evaluation:
    """A snapshot of how one model version performs on test data: metrics, images, plots and tables, committed to the
    evaluation set when the build succeeds."""

    def __init__(self, name: str, evaluation_set: str, model: "LoadedModel") -> None:
        self.name = _check_name(name, "evaluation")
        self.evaluation_set = evaluation_set
        self.evaluation_rid = f"ri.models.main.evaluation.{uuid.uuid4()}"
        self.model = model
        self.metrics: dict[str, float] = {}
        self.images: dict[str, dict] = {}
        self.plots: dict[str, dict] = {}
        self.tables: dict[str, dict] = {}

    def log_metric(self, key: str, value: Any) -> None:
        v = _jsonable(value)
        if isinstance(value, bool) or not isinstance(v, (int, float)):
            raise TypeError(f"metric {key}: values are numeric (int or float)")
        self.metrics[_check_name(key, "metric")] = float(v)

    def log_metrics(self, metrics: dict) -> None:
        for k, v in metrics.items():
            self.log_metric(k, v)

    def log_image(self, name: str, image: Any, caption: Optional[str] = None) -> None:
        data = _png(image)
        if len(data) > 5 * 1024 * 1024:
            raise ValueError("an image is at most 5 MB")
        self.images[_check_name(name, "image")] = {"png": base64.b64encode(data).decode(), "caption": (caption or "")[:200]}

    def log_plot(self, name: str, plot_data: Any, description: Optional[str] = None) -> None:
        self.plots[_check_name(name, "plot")] = {"figure": _figure(plot_data), "description": description or ""}

    def log_table(self, name: str, table: Any, description: Optional[str] = None) -> None:
        self.tables[_check_name(name, "table")] = {**_table(table), "description": description or ""}

    def export(self) -> dict:
        return {"rid": self.evaluation_rid, "name": self.name, "set": self.evaluation_set, "model": self.model.model_rid,
                "version_rid": self.model.model_version_rid, "metrics": self.metrics, "images": self.images, "plots": self.plots,
                "tables": self.tables, "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")}


def evaluation(evaluation_set_name: str):
    """`@palantir_models.transforms.evaluation("set")` above a transform decorator: ModelInputs of the transform can
    create_evaluation(), committed to that evaluation set when the build succeeds."""
    if not isinstance(evaluation_set_name, str) or not evaluation_set_name.strip():
        raise ValueError("@evaluation needs a non-empty evaluation set name")

    def wrap(tr):
        entry = getattr(tr, "_entry", None)
        if entry is None:
            raise TypeError("apply @palantir_models.transforms.evaluation(...) above the @transform decorator")
        entry["evaluation_set"] = evaluation_set_name.strip()[:NAME_MAX]
        return tr

    return wrap


# ------------------------------------------------------------------------------------------------
# MLflow models: the open-source way to publish a model version
# ------------------------------------------------------------------------------------------------

# MLflow column types (mlflow.types.DataType names) → the API's Python types
_MLFLOW_TYPES = {"double": float, "float": float, "long": int, "integer": int, "string": str, "boolean": bool, "datetime": _dt.datetime,
                 "binary": bytes}


def _schema_columns(schema: Any) -> list:
    """An MLflow schema's named columns as (name, type); unnamed (tensor) schemas take any columns."""
    cols = []
    for c in getattr(schema, "inputs", None) or []:
        name = getattr(c, "name", None)
        if not name:
            return []
        t = getattr(getattr(c, "type", None), "name", None) or str(getattr(c, "type", ""))
        cols.append((name, _MLFLOW_TYPES.get(str(t).lower(), Any), not getattr(c, "optional", False)))
    return cols


class _ApiPerInstance:
    """api() of an MLflow model: on a loaded model the columns of its signature, on the class any columns."""

    def __get__(self, obj: Any, cls: type):
        if obj is None:
            return lambda: ({"df_in": Pandas()}, {"df_out": Pandas()})
        return obj._signature_api


class MlflowModel(ModelAdapter):
    """An MLflow model (any `mlflow.pyfunc` flavour: a PythonModel, scikit-learn, XGBoost, PyTorch …) as a model
    version. Its MLflow directory (MLmodel, the model files, the code_paths it needs) is the version's files; the API
    is the MLflow signature (df_in → df_out) and predict() is pyfunc predict. Publish one with
    `model_output.publish(python_model_or_estimator_or_uri, input_example=df)`."""

    api = _ApiPerInstance()  # type: ignore[assignment]

    def __init__(self, model_dir: str) -> None:
        mlflow = _need("mlflow", "MlflowModel")
        self.model_dir = str(model_dir)
        self.pyfunc = mlflow.pyfunc.load_model(self.model_dir)

    def _signature_api(self) -> tuple[dict, dict]:
        meta = self.pyfunc.metadata
        return ({"df_in": Pandas(_schema_columns(meta.get_input_schema()))}, {"df_out": Pandas(_schema_columns(meta.get_output_schema()))})

    @classmethod
    def load(cls, state_reader: ModelStateReader, container_context=None, external_model_context=None):
        return cls(state_reader.dir("mlflow"))

    def save(self, state_writer: ModelStateWriter) -> None:
        state_writer.put_directory(self.model_dir, "mlflow")

    def _conform(self, df: Any) -> Any:
        """The input cast to the signature's column types: MLflow refuses unsafe conversions (int64 → double), datasets
        hold integers where a model trained on doubles, so numbers are converted here (missing values stay missing)."""
        import pandas as pd

        schema = self.pyfunc.metadata.get_input_schema()
        if schema is None or not hasattr(df, "columns"):
            return df
        out = df.copy()
        for c in getattr(schema, "inputs", None) or []:
            name = getattr(c, "name", None)
            if not name or name not in out.columns:
                continue
            t = str(getattr(getattr(c, "type", None), "name", "") or "").lower()
            col = out[name]
            if t in ("double", "float"):
                out[name] = pd.to_numeric(col, errors="coerce").astype("float64" if t == "double" else "float32")
            elif t in ("long", "integer"):
                num = pd.to_numeric(col, errors="coerce")
                out[name] = num.astype("int64" if t == "long" else "int32") if num.notna().all() else num
            elif t == "string":
                out[name] = col.map(lambda v: v if v is None or isinstance(v, str) else (None if pd.isna(v) else str(v)))
            elif t == "boolean" and col.notna().all():
                out[name] = col.astype(bool)
        return out

    def predict(self, df_in):  # type: ignore[override]
        import pandas as pd

        out = self.pyfunc.predict(self._conform(df_in))
        if isinstance(out, pd.DataFrame):
            return out
        if isinstance(out, pd.Series):
            return out.to_frame(out.name or "prediction")
        if isinstance(out, dict):
            return pd.DataFrame(out)
        return pd.DataFrame({"prediction": list(out)})


def _code_path(obj: Any) -> Optional[list[str]]:
    """The repository code an MLflow PythonModel needs at load time (its top-level package), for code_paths."""
    root, module = _source_root(type(obj))
    if not root:
        return None
    top = module.split(".")[0]
    p = root / top
    return [str(p)] if p.is_dir() else [str(root / f"{top}.py")] if (root / f"{top}.py").exists() else None


def as_mlflow(model: Any, dest: Path, input_example: Any = None, signature: Any = None, pip_requirements: Optional[list] = None) -> MlflowModel:
    """What publish() takes besides a ModelAdapter, saved as an MLflow model in `dest`: an mlflow.pyfunc.PythonModel,
    a scikit-learn estimator, or an MLflow model URI / folder (runs:/…, models:/…, a path logged with log_model)."""
    if isinstance(model, MlflowModel):
        return model
    mlflow = _need("mlflow", "publish()")
    if dest.exists():
        shutil.rmtree(dest)
    if isinstance(model, (str, os.PathLike)):
        src = str(model)
        shutil.copytree(src if os.path.isdir(src) else mlflow.artifacts.download_artifacts(artifact_uri=src), dest)
        return MlflowModel(str(dest))
    kw: dict = {"pip_requirements": pip_requirements or ["mlflow", "pandas", "numpy", "scikit-learn"]}
    if signature is not None:
        kw["signature"] = signature
    elif input_example is not None:
        kw["input_example"] = input_example
    if isinstance(model, mlflow.pyfunc.PythonModel):
        mlflow.pyfunc.save_model(str(dest), python_model=model, code_paths=_code_path(model), **kw)
    elif type(model).__module__.split(".")[0] == "sklearn":
        # cloudpickle: skops (MLflow 3's default) refuses to load estimators whose types are not listed as trusted
        mlflow.sklearn.save_model(model, str(dest), serialization_format="cloudpickle", **kw)
    else:
        raise TypeError("publish() takes an mlflow.pyfunc.PythonModel, a scikit-learn estimator, an MLflow model URI or a ModelAdapter, "
                        f"not {type(model).__name__}")
    return MlflowModel(str(dest))


def _mlflow_build_store() -> None:
    """MLflow in a build writes to a store of this build only (SQLite with its artifacts next to it, under the staging
    folder): runs the transform starts become the published version's experiment."""
    stage = STATE.get("stage")
    if not stage:
        return
    try:
        import mlflow
    except ImportError:
        return
    Path(stage).mkdir(parents=True, exist_ok=True)
    uri = "sqlite:///" + Path(stage, "mlflow.db").as_posix()
    if mlflow.get_tracking_uri() == uri:
        return
    mlflow.set_tracking_uri(uri)
    client = mlflow.tracking.MlflowClient()
    name = "build"
    exp = client.get_experiment_by_name(name)
    exp_id = exp.experiment_id if exp else client.create_experiment(name, artifact_location=Path(stage, "mlruns").as_uri())
    mlflow.set_experiment(experiment_id=exp_id)


def _mlflow_experiment(default_name: str) -> Optional["Experiment"]:
    """The MLflow run the transform logged to in this build (active, else the last one), as an Experiment."""
    mlflow = sys.modules.get("mlflow")
    if mlflow is None:
        return None
    run = mlflow.active_run() or mlflow.last_active_run()
    if run is None:
        return None
    try:
        mlflow.tracking.MlflowClient().get_run(run.info.run_id)  # a run of this build's store, not an earlier one
    except Exception:  # noqa: BLE001
        return None
    e = Experiment(_check_name((run.info.run_name or default_name)[:100], "experiment"))
    e._from_mlflow(mlflow, run.info.run_id)
    return e


# ------------------------------------------------------------------------------------------------
# ModelOutput (publishing versions) and ModelInput (loaded versions)
# ------------------------------------------------------------------------------------------------


class ModelOutput:
    """`palantir_models.transforms.ModelOutput(path or rid)`: the transform publishes a new model version to it."""

    def __init__(self, model_rid_or_path: Optional[str] = None, **_: object) -> None:
        if not model_rid_or_path:
            raise TypeError("ModelOutput(...) needs a model path or resource identifier")
        ref = str(model_rid_or_path).rstrip("/")
        self.ref = ref
        self.name = ref.rsplit("/", 1)[-1]
        self.folder = ref.rsplit("/", 1)[0].strip("/") or None if "/" in ref else None

    def describe(self) -> dict:
        return {"ref": self.ref, "name": self.name, "folder": self.folder}


def copy_model_to_driver(filesystem: Any, destination: Optional[str] = None) -> str:
    """`palantir_models.transforms.copy_model_to_driver(dataset.filesystem())`: every file of the (unstructured)
    dataset copied to a local folder, whose path is returned. For models published from pre-trained files."""
    import tempfile

    if not hasattr(filesystem, "ls") or not hasattr(filesystem, "open"):
        raise TypeError("copy_model_to_driver() takes a dataset's file system: copy_model_to_driver(model_files.filesystem())")
    dest = Path(destination or tempfile.mkdtemp(prefix="model-files-"))
    n = 0
    for f in filesystem.ls():
        rel = str(f.path).replace("\\", "/").lstrip("/")
        if not rel or ".." in rel.split("/"):
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        with filesystem.open(rel, "rb") as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)
        n += 1
    if not n:
        raise FileNotFoundError("the dataset has no files to copy: upload the model files to it first")
    return str(dest)


def _source_root(cls: type) -> tuple[Optional[Path], str]:
    """(the import root holding the adapter's module, the module name)."""
    module = cls.__module__
    try:
        f = Path(inspect.getsourcefile(cls) or "").resolve()
    except TypeError:
        return None, module
    if not f.exists() or module == "__main__":
        return None, module
    depth = len(module.split(".")) - (0 if f.name == "__init__.py" else 1)
    root = f.parent
    for _ in range(depth):
        root = root.parent
    return root, module


def _snapshot(root: Path, dest: Path, max_bytes: int = 20 * 1024 * 1024) -> list[str]:
    files, total = [], 0
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if not p.is_file() or "__pycache__" in rel.parts or any(part.startswith(".") for part in rel.parts):
            continue
        if p.suffix not in (".py", ".json", ".yaml", ".yml", ".txt", ".csv"):
            continue
        total += p.stat().st_size
        if total > max_bytes:
            raise ValueError(f"the adapter's source root {root.name} is larger than {max_bytes // 1024 // 1024} MB")
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest / rel)
        files.append(rel.as_posix())
    return files


class WritableModel:
    """What a ModelOutput parameter receives: publish(adapter) creates the version, create_experiment() its experiment."""

    def __init__(self, param: str, decl: ModelOutput) -> None:
        self.param, self.decl = param, decl
        self.published: Optional[dict] = None
        self._experiments: list[Experiment] = []
        _mlflow_build_store()

    def create_experiment(self, name: str, error_handler_type: ErrorHandlerType = ErrorHandlerType.WARN) -> Experiment:
        e = Experiment(name, error_handler_type)
        self._experiments.append(e)
        return e

    def publish(self, model: Any, experiment: Optional[Experiment] = None, input_example: Any = None, signature: Any = None,
                pip_requirements: Optional[list] = None, **_: object) -> dict:
        """model: an MLflow model — an mlflow.pyfunc.PythonModel, a scikit-learn estimator, or an MLflow model URI /
        folder (input_example or signature give its columns) — or a ModelAdapter. The MLflow run the transform logged
        to becomes the version's experiment when none is passed."""
        if self.published:
            raise RuntimeError(f"{self.decl.ref}: publish() was already called in this build")
        stage = STATE.get("stage")
        if not stage:
            raise RuntimeError("ModelOutput.publish() runs inside a transform build or preview")
        if not isinstance(model, ModelAdapter):
            model = as_mlflow(model, Path(stage) / f"{self.param}-mlflow", input_example, signature, pip_requirements)
        if experiment is None and isinstance(model, MlflowModel):
            experiment = _mlflow_experiment(self.decl.name)
        model_adapter = model
        d = Path(stage) / self.param
        if d.exists():
            shutil.rmtree(d)
        state = d / "state"
        cls = type(model_adapter)
        api = describe_api(model_adapter)
        model_adapter.save(ModelStateWriter(state))
        # Foundry checks serialization both ways: the saved files must load back into an adapter
        reloaded = _call_load(cls, ModelStateReader(state))
        if not isinstance(reloaded, ModelAdapter):
            raise TypeError(f"{cls.__name__}.load() must return a ModelAdapter instance, not {type(reloaded).__name__}")
        # an MLflow model carries its own code (code_paths) in its files: no adapter source to snapshot
        root, module = (None, cls.__module__) if cls is MlflowModel else _source_root(cls)
        files = _snapshot(root, d / "adapter") if root else []
        sers = _serializers(cls)
        meta = {"param": self.param, "model": self.decl.describe(), "api": api,
                "adapter": {"module": module, "class": cls.__qualname__, "root": root.name if root else None, "files": files},
                "serializers": {k: type(v).__name__ for k, v in (sers or {}).items()} if sers else None,
                "custom_serialization": sers is None, "experiment": experiment.export() if experiment else None,
                "published_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")}
        if experiment is not None and experiment not in self._experiments:
            self._experiments.append(experiment)
        (d / "version.json").write_text(json.dumps(meta, default=_jsonable), "utf-8")
        self.published = meta
        STATE["outputs"].append({"param": self.param, "dir": str(d)})
        print(f"model {self.decl.ref}: a new version was published ({cls.__name__}, {len(api['inputs'])} input(s), "
              f"{len(api['outputs'])} output(s)); it is committed when the build succeeds")
        return {"model": self.decl.ref, "adapter": cls.__name__}


def _call_load(cls: type, reader: Optional[ModelStateReader], container_context=None, external_model_context=None):
    try:
        params = inspect.signature(cls.load).parameters
    except (TypeError, ValueError):
        params = {}
    kw = {}
    if "container_context" in params:
        kw["container_context"] = container_context
    if "external_model_context" in params:
        kw["external_model_context"] = external_model_context
    if "state_reader" in params or not params:
        return cls.load(reader, **kw)
    return cls.load(reader, **kw) if len(params) > len(kw) else cls.load(**kw)


def _resolve_class(module: str, qualname: str):
    obj: Any = importlib.import_module(module)
    for part in qualname.split("."):
        obj = getattr(obj, part)
    return obj


def adapter_class(spec: dict, prefer_local: bool = True):
    """The version's adapter class: the running repository's module when it defines it (and prefer_local), else the
    source snapshot published with the version."""
    a = spec["adapter"]
    if prefer_local:
        try:
            return _resolve_class(a["module"], a["class"])
        except (ImportError, AttributeError):
            pass
    snap = str(Path(spec["dir"]) / "adapter")
    if snap not in sys.path:
        sys.path.insert(0, snap)
    importlib.invalidate_caches()
    for name in [m for m in list(sys.modules) if m == a["module"] or a["module"].startswith(m + ".")]:
        mod = sys.modules.get(name)
        if mod is not None and not str(getattr(mod, "__file__", "") or "").startswith(snap):
            # a module of the same name from elsewhere (the repository's own) would shadow the snapshot
            del sys.modules[name]
    return _resolve_class(a["module"], a["class"])


class LoadedModel:
    """A ModelInput of a model version: the adapter's methods plus create_evaluation() and the version identifiers."""

    def __init__(self, adapter: Any, spec: dict, param: Optional[str] = None) -> None:
        self._pm_adapter = adapter
        self._pm_spec = spec
        self._pm_param = param

    @property
    def model_rid(self) -> str:
        return self._pm_spec.get("rid", "")

    @property
    def model_version_rid(self) -> str:
        return self._pm_spec.get("version_rid", "")

    @property
    def model_version(self) -> str:
        return self._pm_spec.get("version", "")

    def create_evaluation(self, name: Optional[str] = None) -> Evaluation:
        es = STATE.get("evaluation_set")
        if not es:
            raise RuntimeError("create_evaluation() must be called inside a transform decorated with @palantir_models.transforms.evaluation(...)")
        key = self._pm_param or self.model_rid
        ev = STATE["evaluation_objects"].get(key)
        if ev is None:
            ev = Evaluation(name or es, es, self)
            STATE["evaluation_objects"][key] = ev
        return ev

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_pm_"):
            raise AttributeError(name)
        import model_telemetry

        # a transform's model: its inference calls are recorded (model_telemetry.trace_model)
        return model_telemetry.wrap_method(self, name, getattr(self._pm_adapter, name))

    def __repr__(self) -> str:
        return f"<model {self._pm_spec.get('model')} {self._pm_spec.get('version')}>"


def load_version(spec: dict, param: Optional[str] = None, prefer_local: bool = True) -> LoadedModel:
    """A model version trained here (spec from model_assets.resolve_python) as the transform's ModelInput."""
    cls = adapter_class(spec, prefer_local)
    ext = spec.get("external")
    ctx = ExternalModelContext(ext.get("base_url", ""), ext.get("configuration") or {}, ext.get("credentials") or {}) if ext else None
    adapter = _call_load(cls, ModelStateReader(Path(spec["dir"]) / "state"), None, ctx)
    return LoadedModel(adapter, spec, param)


class RemoteModel(LoadedModel):
    """use_sidecar=True: the version runs in its own process (model_worker.py) with only its published source on the
    path; transform() / predict() calls go there."""

    def __init__(self, spec: dict, param: Optional[str] = None) -> None:
        super().__init__(None, spec, param)
        import model_worker

        self._pm_client = model_worker.Client(spec)

    def transform(self, *args, **kwargs) -> Outputs:
        import model_telemetry

        ok = False
        try:
            out = Outputs(self._pm_client.transform(_named_inputs(self._pm_spec["api"], args, kwargs)))
            ok = True
            return out
        finally:
            # the spans the model process made for this call (a transform's traced model)
            model_telemetry.report_remote(self, getattr(self._pm_client, "last_spans", None), ok, getattr(self._pm_client, "last_ms", None))
            self._pm_client.last_spans = None

    def predict(self, *args, **kwargs):
        out = self.transform(*args, **kwargs)
        return next(iter(out.values())) if len(out) == 1 else out

    def transform_write(self, *args) -> None:
        *inputs, output = args
        out = self.transform(*inputs)
        if hasattr(output, "write_pandas"):
            output.write_pandas(to_pandas(next(iter(out.values()))))
        else:
            for k, v in out.items():
                output[k].write_pandas(to_pandas(v))

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_pm_"):
            raise AttributeError(name)
        raise AttributeError(f"{name}: a model running as a sidecar exposes transform(), predict() and transform_write()")


def _named_inputs(api: dict, args: tuple, kwargs: dict) -> dict:
    names = [i["name"] for i in api.get("inputs") or []]
    out = dict(zip(names, args))
    out.update(kwargs)
    for i in api.get("inputs") or []:
        if i["type"] == "tabular" and i["name"] in out:
            out[i["name"]] = to_pandas(out[i["name"]])
    return out


class DistributedInferenceWrapper:
    """Spark inference on the executors: `predict(spark_df)` repartitions the DataFrame (`num_partitions`, "auto": the
    default parallelism), and each Spark task loads the model version itself (only its spec travels, not the
    adapter object) and predicts its partition in chunks of at most `max_rows_per_chunk` rows (mapInPandas). The output
    schema comes from predicting a few rows in the driver first. A model that is not a published version (an adapter
    built in the transform) is predicted in the driver, chunk by chunk."""

    def __init__(self, model: Any, ctx: Any = None, num_partitions: Any = "auto", max_rows_per_chunk: int = 1_000_000) -> None:
        self.model, self.ctx = model, ctx
        self.num_partitions, self.max_rows_per_chunk = num_partitions, int(max_rows_per_chunk)

    def _call(self, model: Any, chunk: Any, params: dict) -> Any:
        # transform() binds the model API (parameter defaults included); the first tabular output is the result
        res = model.transform(chunk, **params) if hasattr(model, "transform") else model.predict(chunk, **params)
        if isinstance(res, dict):
            res = next((v for v in res.values() if hasattr(v, "columns") or hasattr(v, "toPandas")), next(iter(res.values())))
        return to_pandas(res)

    def predict(self, df, **params):
        import pandas as pd
        from pyspark.sql import SparkSession

        spark = SparkSession.builder.getOrCreate()
        spec = getattr(self.model, "_pm_spec", None)
        if not hasattr(df, "mapInPandas") or not spec or not spec.get("dir"):
            pdf = df.toPandas() if hasattr(df, "toPandas") else to_pandas(df)
            parts = [self._call(self.model, pdf.iloc[i:i + self.max_rows_per_chunk].reset_index(drop=True), params)
                     for i in range(0, max(len(pdf), 1), self.max_rows_per_chunk)]
            return spark.createDataFrame(pd.concat(parts, ignore_index=True) if parts else pdf)
        sample = self._call(self.model, df.limit(5).toPandas(), params)
        schema = spark.createDataFrame(sample).schema
        columns = list(sample.columns)
        parts = spark.sparkContext.defaultParallelism if self.num_partitions == "auto" else int(self.num_partitions)
        version, rows, kw, sidecar = dict(spec), self.max_rows_per_chunk, dict(params), isinstance(self.model, RemoteModel)

        def run(batches):
            import code_models

            code_models.install()
            import model_lib as ml

            model = ml.RemoteModel(version) if sidecar else ml.load_version(version)
            for pdf in batches:
                for i in range(0, len(pdf), rows):
                    out = ml.DistributedInferenceWrapper(model)._call(model, pdf.iloc[i:i + rows].reset_index(drop=True), kw)
                    yield out[columns]

        return df.repartition(max(1, parts)).mapInPandas(run, schema)


# ------------------------------------------------------------------------------------------------
# built-in evaluators
# ------------------------------------------------------------------------------------------------


class RegressionEvaluatorConfig:
    def __init__(self, subset: Optional[str] = None) -> None:
        self.subset = subset


class ClassificationEvaluatorConfig:
    def __init__(self, average: str = "weighted", class_probabilities_columns: Optional[list] = None, class_probability_column: Optional[str] = None,
                 subset: Optional[str] = None) -> None:
        if average not in ("weighted", "micro", "macro", "samples"):
            raise ValueError("average is weighted, micro, macro or samples")
        if class_probabilities_columns and class_probability_column:
            raise ValueError("supply class probabilities through exactly one of class_probabilities_columns or class_probability_column")
        self.average, self.subset = average, subset
        self.class_probabilities_columns, self.class_probability_column = class_probabilities_columns, class_probability_column


class EvaluationResult:
    def __init__(self, metrics: dict, predictions: Any = None) -> None:
        self.metrics, self.predictions = metrics, predictions

    def __repr__(self) -> str:
        return f"EvaluationResult({self.metrics})"


def _auc(y: Any, score: Any) -> Optional[float]:
    """ROC AUC (Mann-Whitney, ties averaged); None when a class is missing."""
    import numpy as np

    y, score = np.asarray(y, dtype=bool), np.asarray(score, dtype=float)
    pos, neg = int(y.sum()), int((~y).sum())
    if not pos or not neg:
        return None
    order = score.argsort(kind="mergesort")
    ranks = np.empty(len(score))
    s = score[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and s[j + 1] == s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((ranks[y].sum() - pos * (pos + 1) / 2) / (pos * neg))


def regression_metrics(y_true: Any, y_pred: Any) -> dict:
    import numpy as np

    y, p = np.asarray(y_true, dtype=float), np.asarray(y_pred, dtype=float)
    ok = ~(np.isnan(y) | np.isnan(p))
    y, p = y[ok], p[ok]
    n = len(y)
    if not n:
        return {"example_count": 0}
    err = y - p
    ss_tot = float(((y - y.mean()) ** 2).sum())
    mse = float((err ** 2).mean())
    return {"example_count": n, "mean_absolute_error": float(np.abs(err).mean()), "mean_squared_error": mse,
            "root_mean_squared_error": math.sqrt(mse), "r2": (1 - float((err ** 2).sum()) / ss_tot) if ss_tot else 0.0,
            "max_error": float(np.abs(err).max()),
            "mean_absolute_percentage_error": float((np.abs(err) / np.maximum(np.abs(y), np.finfo(float).eps)).mean()),
            "explained_variance": (1 - float(err.var()) / float(y.var())) if float(y.var()) else 0.0}


def classification_metrics(y_true: Any, y_pred: Any, average: str = "weighted", proba: Any = None, classes_order: Optional[list] = None) -> dict:
    """accuracy, precision, recall, f1 (binary: the greater class is positive, with the confusion matrix counts;
    multiclass: averaged), roc_auc one-vs-rest when probabilities (rows × classes) are given."""
    import numpy as np

    y, p = list(y_true), list(y_pred)
    n = len(y)
    classes = classes_order or sorted({*y, *p}, key=lambda v: (str(type(v)), v))
    out: dict = {"example_count": n}
    if not n:
        return out
    ya, pa = np.array(y, dtype=object), np.array(p, dtype=object)
    out["accuracy"] = float((ya == pa).mean())
    if len(classes) <= 2:
        pos = classes[-1]
        tp = int(((ya == pos) & (pa == pos)).sum())
        fp = int(((ya != pos) & (pa == pos)).sum())
        fn = int(((ya == pos) & (pa != pos)).sum())
        tn = n - tp - fp - fn
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        out.update(precision=prec, recall=rec, f1=(2 * prec * rec / (prec + rec)) if prec + rec else 0.0,
                   true_positives=tp, true_negatives=tn, false_positives=fp, false_negatives=fn)
        if proba is not None:
            pr = np.asarray(proba, dtype=float)
            score = pr[:, -1] if pr.ndim == 2 else pr
            auc = _auc(ya == pos, score)
            if auc is not None:
                out["roc_auc"] = auc
        return out
    if average == "samples":
        raise ValueError("average='samples' is for multilabel data; this evaluation is multiclass")
    per = []
    for c in classes:
        tp = int(((ya == c) & (pa == c)).sum())
        fp = int(((ya != c) & (pa == c)).sum())
        fn = int(((ya == c) & (pa != c)).sum())
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        per.append((prec, rec, (2 * prec * rec / (prec + rec)) if prec + rec else 0.0, int((ya == c).sum()), tp, fp, fn))
    if average == "micro":
        tp, fp, fn = sum(x[4] for x in per), sum(x[5] for x in per), sum(x[6] for x in per)
        prec, rec = tp / (tp + fp) if tp + fp else 0.0, tp / (tp + fn) if tp + fn else 0.0
        out.update(precision=prec, recall=rec, f1=(2 * prec * rec / (prec + rec)) if prec + rec else 0.0)
    else:
        w = [x[3] / n for x in per] if average == "weighted" else [1 / len(per)] * len(per)
        out.update(precision=sum(a * x[0] for a, x in zip(w, per)), recall=sum(a * x[1] for a, x in zip(w, per)), f1=sum(a * x[2] for a, x in zip(w, per)))
    if proba is not None:
        pr = np.asarray(proba, dtype=float)
        aucs, weights = [], []
        for k, c in enumerate(classes):
            if k < pr.shape[1]:
                a = _auc(ya == c, pr[:, k])
                if a is not None:
                    aucs.append(a)
                    weights.append(int((ya == c).sum()))
        if aucs:
            out["roc_auc"] = float(np.average(aucs, weights=weights if average == "weighted" else None))
    return out


def _inference(model: Any, inputs: Any):
    # transform() binds the inputs by the model's API (parameter defaults included) and calls predict / run_inference
    call = model.transform if hasattr(model, "transform") else model.predict
    if isinstance(inputs, tuple):
        return call(*inputs)
    if isinstance(inputs, dict) and not (hasattr(inputs, "columns")):
        return call(**inputs)
    return call(inputs)


def _frames(res: Any) -> list:
    if isinstance(res, dict):
        return [to_pandas(v) for v in res.values() if hasattr(v, "columns") or hasattr(v, "toPandas")]
    if isinstance(res, (list, tuple)):
        return [to_pandas(v) for v in res if hasattr(v, "columns") or hasattr(v, "toPandas")]
    return [to_pandas(res)]


def evaluate(model: Any, inputs: Any, targets: str, prediction_column: Optional[str] = None, evaluator_config: Any = None,
             evaluation: Optional[Evaluation] = None, evaluation_df: Any = None) -> EvaluationResult:
    """Run inference, compare `prediction_column` with the ground truth `targets` and log the evaluator's metrics (to
    `evaluation`, or the transform's evaluation inside @palantir_models.transforms.evaluation)."""
    cfg = evaluator_config or RegressionEvaluatorConfig()
    pred_col = prediction_column or targets
    frames = [f for f in _frames(_inference(model, inputs)) if pred_col in f.columns]
    if not frames:
        raise ValueError(f"no output DataFrame of the model has the prediction column {pred_col}")
    if len(frames) > 1:
        raise ValueError(f"more than one output DataFrame has the prediction column {pred_col}")
    out = frames[0]
    truth_src = to_pandas(evaluation_df) if evaluation_df is not None else (to_pandas(inputs) if not isinstance(inputs, (tuple, dict)) else None)
    if truth_src is None or targets not in truth_src.columns:
        truth_src = out if targets in out.columns and targets != pred_col else truth_src
    if truth_src is None or targets not in truth_src.columns:
        raise ValueError(f"the ground-truth column {targets} is not in evaluation_df or the inputs")
    y_true = list(truth_src[targets])
    y_pred = list(out[pred_col])
    if len(y_true) != len(y_pred):
        raise ValueError(f"{len(y_true)} ground-truth rows but {len(y_pred)} predictions")
    if isinstance(cfg, ClassificationEvaluatorConfig):
        proba = None
        if cfg.class_probabilities_columns:
            miss = [c for c in cfg.class_probabilities_columns if c not in out.columns]
            if miss:
                raise ValueError(f"probability columns not in the model output: {', '.join(miss)}")
            proba = out[cfg.class_probabilities_columns].to_numpy(dtype=float)
        elif cfg.class_probability_column:
            if cfg.class_probability_column not in out.columns:
                raise ValueError(f"probability column {cfg.class_probability_column} is not in the model output")
            proba = [list(v) for v in out[cfg.class_probability_column]]
        metrics = classification_metrics(y_true, y_pred, cfg.average, proba)
    else:
        metrics = regression_metrics(y_true, y_pred)
    if getattr(cfg, "subset", None):
        metrics = {f"{cfg.subset}/{k}": v for k, v in metrics.items()}
    target = evaluation
    if target is None and STATE.get("evaluation_set") and isinstance(model, LoadedModel):
        target = model.create_evaluation()
    if target is not None:
        target.log_metrics(metrics)
    return EvaluationResult(metrics, out)


# ------------------------------------------------------------------------------------------------
# the run: staging, collecting
# ------------------------------------------------------------------------------------------------


def begin(stage: Path, mode: str, evaluation_set: Optional[str]) -> None:
    STATE.update(stage=str(stage), mode=mode, evaluation_set=evaluation_set, outputs=[], evaluations=[], evaluation_objects={})


def collected() -> dict:
    """What this run produced: model versions (staged folders) and evaluations."""
    return {"model_outputs": list(STATE["outputs"]), "evaluations": [e.export() for e in STATE["evaluation_objects"].values()]}


def _api_get(path: str) -> bytes:
    import urllib.parse
    import urllib.request

    class _Redirect(urllib.request.HTTPRedirectHandler):
        # files kept in S3 redirect to a presigned URL, which rejects a second auth header: drop ours off-host
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            new = super().redirect_request(req, fp, code, msg, headers, newurl)
            if new is not None and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
                new.remove_header("Authorization")
            return new

    req = urllib.request.Request(os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000") + path,
                                 headers={"Authorization": f"Bearer {os.environ.get('BLUESANDAI_API_TOKEN', '')}"})
    with urllib.request.build_opener(_Redirect).open(req, timeout=60) as r:  # noqa: S310 - this platform's own API
        return r.read()


def install(pm: types.ModuleType) -> None:
    """palantir_models, .models, .models.api, .serializers, .experiments, .evaluations, .transforms additions."""
    for c in (ModelAdapter, ContainerModelAdapter, ExternalModelAdapter, Pandas, Spark, Parameter, FileSystem, MediaReference, NDArray, Object,
              ObjectSet, ModelApi, ModelApiColumn, DFType, ModelStateWriter, ModelStateReader, ModelSerializer, ContainerizedApplicationContext,
              ExternalModelContext):
        setattr(pm, c.__name__, c)
    pm.ExternalContext = ExternalModelContext  # type: ignore[attr-defined]
    pm.auto_serialize = auto_serialize  # type: ignore[attr-defined]
    ser = types.ModuleType("palantir_models.serializers")
    for c in (DillSerializer, CloudPickleSerializer, JsonSerializer, YamlSerializer, PytorchStateSerializer, TensorflowKerasSerializer,
              TensorflowFormat, XGBoostSerializer, HfAutoModelSerializer, HfAutoTokenizerSerializer, HfPipelineSerializer, SparkMLAutoSerializer,
              ModelSerializer):
        setattr(ser, c.__name__, c)
    exp = types.ModuleType("palantir_models.experiments")
    exp.Experiment, exp.ErrorHandlerType = Experiment, ErrorHandlerType  # type: ignore[attr-defined]
    ev = types.ModuleType("palantir_models.evaluations")
    for c in (Evaluation, evaluate, RegressionEvaluatorConfig, ClassificationEvaluatorConfig, EvaluationResult):
        setattr(ev, c.__name__, c)
    api = types.ModuleType("palantir_models.models.api")
    api.ModelApi, api.ModelApiColumn, api.DFType = ModelApi, ModelApiColumn, DFType  # type: ignore[attr-defined]
    api.ModelInput, api.ModelOutput = _ApiInputs, _ApiOutputs  # type: ignore[attr-defined]
    api.TabularInput, api.ParameterInput = _tabular, _ApiInputs.Parameter  # type: ignore[attr-defined]
    serialization = types.ModuleType("palantir_models.models._serialization")
    serialization.ModelSerializer, serialization.ModelStateReader, serialization.ModelStateWriter = ModelSerializer, ModelStateReader, ModelStateWriter  # type: ignore[attr-defined]
    accessors = types.ModuleType("palantir_models.models._state_accessors")
    accessors.ModelStateReader, accessors.ModelStateWriter = ModelStateReader, ModelStateWriter  # type: ignore[attr-defined]
    pm.serializers, pm.experiments, pm.evaluations = ser, exp, ev  # type: ignore[attr-defined]
    mods = {"palantir_models.serializers": ser, "palantir_models.experiments": exp, "palantir_models.evaluations": ev,
            "palantir_models.models.api": api, "palantir_models.models._serialization": serialization,
            "palantir_models.models._state_accessors": accessors}
    executable = types.ModuleType("models_api.models_api_executable")
    executable.ContainerizedApplicationContext = ContainerizedApplicationContext  # type: ignore[attr-defined]
    executable.ExternalModelExecutionContext = ExternalModelContext  # type: ignore[attr-defined]
    models_api = types.ModuleType("models_api")
    models_api.__path__ = []  # type: ignore[attr-defined]
    models_api.models_api_executable = executable  # type: ignore[attr-defined]
    mods.update({"models_api": models_api, "models_api.models_api_executable": executable})
    sys.modules.update(mods)


def extend(pmt: types.ModuleType, pmm: types.ModuleType) -> None:
    """Names added to palantir_models.transforms and palantir_models.models."""
    pmt.ModelOutput, pmt.evaluation, pmt.DistributedInferenceWrapper = ModelOutput, evaluation, DistributedInferenceWrapper  # type: ignore[attr-defined]
    pmt.copy_model_to_driver = copy_model_to_driver  # type: ignore[attr-defined]
    for c in (ModelAdapter, ModelStateWriter, ModelStateReader, ModelSerializer):
        setattr(pmm, c.__name__, c)
    pmm.api = sys.modules.get("palantir_models.models.api")  # type: ignore[attr-defined]
    with contextlib.suppress(Exception):
        sys.modules["palantir_models.models"].__path__ = []  # type: ignore[attr-defined]
