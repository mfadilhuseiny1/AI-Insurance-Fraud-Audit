"""Time series in Code Repositories (Palantir's "Work with time series in FoundryTS", "Time series in Functions" and
"Function-backed time series").

Modules for repository code, installed with transforms.api (code_pyapi.install_modules):

  foundryts                   FoundryTS(): search.series(predicate, object_types=[…]) → results to map(F.time_extent())
                              and to_dataframe(); series(series_id, sync=None) → a node
  foundryts.nodes (N)         TimeseriesNode(series_id, sync=None), ObjectTimeseriesNode(object_type, primary_key,
                              property="")
  foundryts.functions (F)     dsl(program, return_type)([a, b]) ('a+b': inputs named a, b, … in order), time_range,
                              rolling_aggregate, periodic_aggregate, derivative, integral, shift, sample, scale,
                              time_extent, statistics, first_point, last_point
  foundryts.search            ontology(property) == value (also != < <= > >=, & and |)
  transforms.timeseries       TimeSeriesInput(sync RID): a transform parameter naming the sync it reads
  transforms.objects          ObjectInput(object_type_rid, ontology_rid=None, ontology_branch_rid=None)
  timeseries_sdk.types / timeseries_sdk.functions.types
                              TimeSeries.serialize(df) → list[bytes] (a pandas DataFrame of timestamp, value) and
                              TimeSeries.deserialize
  functions.api               @function (marks a Python function; function-backed series call it)
  ontology_sdk.ontology.objects
                              any object type name, for type hints

Nodes are compiled into the platform's time series logic (ts_engine.py cards) and evaluated by the API
(/api/timeseries/query) with the build's job token, so a transform reads exactly what its user may read; the
queries' compute-seconds are attributed to the repository (BLUESANDAI_USAGE_RESOURCE).

A function-backed series runs a @function whose object parameter receives an object with its properties as
attributes and each time series property as a TimeSeriesProperty: to_pandas(all_time=True | start=, end=),
to_polars(), get_first_point(), get_last_point(), get_all_points(). It returns TimeSeries.serialize(df) or a
DataFrame of timestamp / value.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

import code_models

SYNC_RID = "ri.time-series-catalog.main.sync."


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


def _resource() -> str:
    return os.environ.get("BLUESANDAI_USAGE_RESOURCE") or "code_repo"


def _call(path: str, body: Optional[dict] = None, params: Optional[dict] = None) -> Any:
    base = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000").rstrip("/")
    token = os.environ.get("BLUESANDAI_API_TOKEN")
    url = base + path + (("?" + urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})) if params else "")
    headers = {"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})}
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method="POST" if body is not None else "GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        raise RuntimeError(f"time series query failed ({e.code}): {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"time series queries run in previews and builds (the platform API is not reachable: {e.reason})") from None


def _frame(points: list[dict]):
    import pandas as pd

    df = pd.DataFrame({"timestamp": pd.to_datetime([p["t"] for p in points], utc=True), "value": [p["value"] for p in points]})
    return df


# ------------------------------------------------------------------------------------------------
# nodes
# ------------------------------------------------------------------------------------------------


class Node:
    """A time series expression; evaluated by to_pandas() / to_dataframe()."""

    def __init__(self, kind: str, config: Optional[dict] = None, children: Optional[list["Node"]] = None, root: Optional[dict] = None) -> None:
        self.kind = kind
        self.config = dict(config or {})
        self.children = list(children or [])
        self.root = root
        self.range: tuple[Optional[str], Optional[str]] = (None, None)

    # -- building ---------------------------------------------------------------------------------

    def _wrap(self, kind: str, **config: Any) -> "Node":
        n = Node(kind, config, [self], self.root)
        n.range = self.range
        return n

    def time_range(self, start: Any = None, end: Any = None) -> "Node":
        n = Node(self.kind, self.config, self.children, self.root)
        n.range = (_text(start), _text(end))
        return n

    def rolling_aggregate(self, aggregate: str = "mean", window: str = "1h") -> "Node":
        return self._wrap("rolling", aggregation=aggregate, window=window)

    def periodic_aggregate(self, aggregate: str = "mean", period: str = "1d") -> "Node":
        return self._wrap("periodic", aggregation=aggregate, period=period)

    def derivative(self, unit: str = "s") -> "Node":
        return self._wrap("derivative", unit=unit)

    def integral(self, unit: str = "s") -> "Node":
        return self._wrap("integral", unit=unit)

    def shift(self, by: str) -> "Node":
        return self._wrap("shift", by=by)

    def sample(self, every: str) -> "Node":
        return self._wrap("sample", every=every)

    def scale(self, factor: float) -> "Node":
        return dsl(f"a * {float(factor)!r}")([self])

    def value_filter(self, min: Optional[float] = None, max: Optional[float] = None) -> "Node":  # noqa: A002 (FoundryTS names)
        return self._wrap("filter", min=min, max=max)

    def __add__(self, other: "Node") -> "Node":
        return dsl("a + b")([self, other])

    def __sub__(self, other: "Node") -> "Node":
        return dsl("a - b")([self, other])

    # -- compiling and evaluating -----------------------------------------------------------------

    def logic(self) -> tuple[dict, Optional[dict]]:
        cards: list[dict] = []
        ids = _ids()
        root: list[Optional[dict]] = [None]

        def emit(n: Node) -> str:
            child = [emit(c) for c in n.children]
            cid = next(ids)
            cfg = dict(n.config)
            if n.root and root[0] is None:
                root[0] = n.root
            if n.kind == "formula":
                program = cfg.pop("program")
                for i, c in reversed(list(enumerate(child))):
                    program = _replace_var(program, "abcdefghijklmnopqrstuvwxyz"[i], f"${c}")
                cfg["formula"] = program
            elif child:
                cfg["input"] = child[0]
            cards.append({"id": cid, "type": n.kind, "config": cfg})
            return cid

        out = emit(self)
        return {"cards": cards, "output": out}, root[0]

    def to_pandas(self, start: Any = None, end: Any = None):
        logic, root = self.logic()
        body = {"logic": logic, "root": root, "start": _text(start) or self.range[0], "end": _text(end) or self.range[1], "cards": [logic["output"]],
                "buckets": 20000, "raw": True, "resource": _resource()}
        res = _call("/api/timeseries/query", body)
        card = res["cards"][logic["output"]]
        if card["kind"] == "error":
            raise RuntimeError(card["error"])
        return _frame(card["points"])

    to_dataframe = to_pandas

    def to_polars(self, start: Any = None, end: Any = None):
        import polars as pl

        return pl.from_pandas(self.to_pandas(start, end))


def _replace_var(program: str, var: str, ref: str) -> str:
    import re

    return re.sub(rf"(?<![A-Za-z0-9_$@]){var}(?![A-Za-z0-9_])", ref, program)


def _ids():
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for a in letters:
        yield a
    for a in letters:
        for b in letters:
            yield a + b


def _text(v: Any) -> Optional[str]:
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def TimeseriesNode(series_id: str, sync: Optional[str] = None) -> Node:  # noqa: N802 (FoundryTS names)
    return Node("series", {"series_id": series_id, **({"sync": sync} if sync else {})})


def ObjectTimeseriesNode(object_type: str, primary_key: Any, property: str = "") -> Node:  # noqa: N802, A002
    return Node("tsp", {"property": property}, root={"object_type_id": _type_id(object_type), "primary_key": str(primary_key)})


def dsl(program: str, return_type: type = float) -> Callable[[list[Node]], Node]:
    """A formula over the input series, named a, b, c … in the order given: F.dsl('a+b')([s1, s2])."""

    def apply(inputs: list[Node]) -> Node:
        if not inputs:
            raise TypeError("dsl(...) needs at least one input series")
        n = Node("formula", {"program": program}, list(inputs), next((i.root for i in inputs if i.root), None))
        return n

    return apply


def _fn(method: str, *args: Any, **kwargs: Any) -> Callable[[Node], Node]:
    return lambda node: getattr(node, method)(*args, **kwargs)


def time_range(start: Any = None, end: Any = None) -> Callable[[Node], Node]:
    return _fn("time_range", start, end)


def rolling_aggregate(aggregate: str = "mean", window: str = "1h") -> Callable[[Node], Node]:
    return _fn("rolling_aggregate", aggregate, window)


def periodic_aggregate(aggregate: str = "mean", period: str = "1d") -> Callable[[Node], Node]:
    return _fn("periodic_aggregate", aggregate, period)


def derivative(unit: str = "s") -> Callable[[Node], Node]:
    return _fn("derivative", unit)


def integral(unit: str = "s") -> Callable[[Node], Node]:
    return _fn("integral", unit)


def shift(by: str) -> Callable[[Node], Node]:
    return _fn("shift", by)


def sample(every: str) -> Callable[[Node], Node]:
    return _fn("sample", every)


def scale(factor: float) -> Callable[[Node], Node]:
    return _fn("scale", factor)


class _Summary:
    """A function mapped over search results: one row of columns per series."""

    def __init__(self, name: str, compute: Callable[[Any], dict]) -> None:
        self.name = name
        self.compute = compute

    def __call__(self, node: Node) -> dict:
        return self.compute(node.to_pandas())


def time_extent() -> _Summary:
    return _Summary("time_extent", lambda df: {"start": df["timestamp"].min() if len(df) else None, "end": df["timestamp"].max() if len(df) else None})


def statistics() -> _Summary:
    def calc(df):
        v = df["value"]
        num = v[v.map(lambda x: isinstance(x, (int, float)))] if len(v) else v
        return {"count": int(len(v)), "min": num.min() if len(num) else None, "max": num.max() if len(num) else None,
                "mean": num.mean() if len(num) else None, "start": df["timestamp"].min() if len(df) else None,
                "end": df["timestamp"].max() if len(df) else None}

    return _Summary("statistics", calc)


def first_point() -> _Summary:
    return _Summary("first_point", lambda df: {"timestamp": df["timestamp"].iloc[0], "value": df["value"].iloc[0]} if len(df) else {"timestamp": None, "value": None})


def last_point() -> _Summary:
    return _Summary("last_point", lambda df: {"timestamp": df["timestamp"].iloc[-1], "value": df["value"].iloc[-1]} if len(df) else {"timestamp": None, "value": None})


# ------------------------------------------------------------------------------------------------
# search
# ------------------------------------------------------------------------------------------------


class Predicate:
    def __init__(self, spec: dict) -> None:
        self.spec = spec

    def __and__(self, other: "Predicate") -> "Predicate":
        return Predicate({"op": "and", "args": [self.spec, other.spec]})

    def __or__(self, other: "Predicate") -> "Predicate":
        return Predicate({"op": "or", "args": [self.spec, other.spec]})

    def matches(self, props: dict) -> bool:
        return _match(self.spec, props)


def _match(spec: dict, props: dict) -> bool:
    op = spec["op"]
    if op == "and":
        return all(_match(a, props) for a in spec["args"])
    if op == "or":
        return any(_match(a, props) for a in spec["args"])
    v, w = props.get(spec["property"]), spec["value"]
    try:
        return {"eq": v == w, "ne": v != w, "lt": v is not None and v < w, "le": v is not None and v <= w,
                "gt": v is not None and v > w, "ge": v is not None and v >= w}[op]
    except TypeError:
        return False


class ontology:  # noqa: N801 (FoundryTS name)
    """ontology('sector') == 'Technology'"""

    def __init__(self, prop: str) -> None:
        self.prop = prop

    def _p(self, op: str, value: Any) -> Predicate:
        return Predicate({"op": op, "property": self.prop, "value": value})

    def __eq__(self, value: Any) -> Predicate:  # type: ignore[override]
        return self._p("eq", value)

    def __ne__(self, value: Any) -> Predicate:  # type: ignore[override]
        return self._p("ne", value)

    def __lt__(self, value: Any) -> Predicate:
        return self._p("lt", value)

    def __le__(self, value: Any) -> Predicate:
        return self._p("le", value)

    def __gt__(self, value: Any) -> Predicate:
        return self._p("gt", value)

    def __ge__(self, value: Any) -> Predicate:
        return self._p("ge", value)

    __hash__ = object.__hash__


class SeriesResult:
    def __init__(self, obj: dict, node: Node, values: Optional[dict] = None) -> None:
        self.object = obj
        self.node = node
        self.values = values or {}


class SearchResult:
    def __init__(self, items: list[SeriesResult]) -> None:
        self.items = items

    def __iter__(self):
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def map(self, fn: Callable[[Node], Any]) -> "SearchResult":
        out = []
        for it in self.items:
            r = fn(it.node)
            if isinstance(r, Node):
                out.append(SeriesResult(it.object, r, it.values))
            else:
                out.append(SeriesResult(it.object, it.node, {**it.values, **(r if isinstance(r, dict) else {"value": r})}))
        return SearchResult(out)

    def to_dataframe(self):
        import pandas as pd

        rows = []
        for it in self.items:
            o = it.object
            rows.append({"object_type": o["object_type"], "primary_key": o["primary_key"], "title": o["title"], "series": o.get("property"),
                         **{k: v for k, v in o["properties"].items() if not isinstance(v, (dict, list))}, **it.values})
        return pd.DataFrame(rows)

    to_pandas = to_dataframe


class _Search:
    def series(self, predicate: Optional[Predicate] = None, object_types: Optional[list[str]] = None, properties: Optional[list[str]] = None) -> SearchResult:
        """Series of objects of the given object types (API names or ids) matching the predicate — each object's
        default time series property, or each of `properties`."""
        res = _call("/api/timeseries/foundryts/objects", {"object_types": object_types or [], "properties": properties or []})
        items = []
        for o in res["objects"]:
            if predicate is not None and not predicate.matches(o["properties"]):
                continue
            for prop in o["series"]:
                items.append(SeriesResult({**o, "property": prop}, Node("tsp", {"property": prop}, root={"object_type_id": o["object_type_id"], "primary_key": o["primary_key"]})))
        return SearchResult(items)


class FoundryTS:
    """The FoundryTS client. Transform inputs declared with TimeSeriesInput / ObjectInput need no configuration here."""

    def __init__(self, *_: Any, **__: Any) -> None:
        self.search = _Search()

    def series(self, series_id: str, sync: Optional[str] = None) -> Node:
        return TimeseriesNode(series_id, sync)

    def object_series(self, object_type: str, primary_key: Any, property: str = "") -> Node:  # noqa: A002
        return ObjectTimeseriesNode(object_type, primary_key, property)


def _type_id(object_type: str) -> str:
    """An object type id from an id, an API name or an object type RID."""
    s = str(object_type)
    if s.startswith("ri.ontology.") and "." in s:
        s = s.rsplit(".", 1)[-1]
    return s


# ------------------------------------------------------------------------------------------------
# transform inputs
# ------------------------------------------------------------------------------------------------


class TimeSeriesInput(code_models.ModelInput):
    kind = "timeseries_input"


class ObjectInput(code_models.ModelInput):
    kind = "object_input"

    def __init__(self, object_type_rid: str = "", ontology_rid: Optional[str] = None, ontology_branch_rid: Optional[str] = None, **kw: Any) -> None:
        super().__init__(object_type_rid or kw.get("rid") or "")
        self.ontology_rid, self.ontology_branch_rid = ontology_rid, ontology_branch_rid


class _Handle:
    def __init__(self, spec: code_models.ModelInput) -> None:
        self.rid = spec.rid

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.rid!r})"


class TimeSeriesInputHandle(_Handle):
    def series(self, series_id: str) -> Node:
        return TimeseriesNode(series_id, self.rid[len(SYNC_RID):] if self.rid.startswith(SYNC_RID) else self.rid)


class ObjectInputHandle(_Handle):
    def objects(self) -> list[dict]:
        return _call("/api/timeseries/foundryts/objects", {"object_types": [_type_id(self.rid)], "properties": []})["objects"]


code_models.MODEL_CLASSES.update({"timeseries_input": TimeSeriesInputHandle, "object_input": ObjectInputHandle})


# ------------------------------------------------------------------------------------------------
# timeseries_sdk, functions.api, the OSDK objects a function receives
# ------------------------------------------------------------------------------------------------


class TimeSeries:
    """timeseries_sdk.types.TimeSeries: (de)serialize a pandas DataFrame of timestamp / value."""

    @staticmethod
    def serialize(df) -> list[bytes]:
        import pandas as pd

        if df is None or len(df) == 0:
            return []
        ts = pd.to_datetime(df["timestamp"], utc=True)
        out = []
        for t, v in zip(ts, df["value"]):
            if v is None or (isinstance(v, float) and v != v):
                continue
            if isinstance(v, str):
                raise TypeError("categorical time series outputs are not supported")
            out.append(json.dumps([int(t.value // 1_000_000), float(v)]).encode())
        return out

    @staticmethod
    def deserialize(data: list[bytes]):
        import pandas as pd

        rows = [json.loads(b) for b in data or []]
        return pd.DataFrame({"timestamp": pd.to_datetime([r[0] for r in rows], unit="ms", utc=True), "value": [r[1] for r in rows]})


def function(fn: Optional[Callable] = None, **_: Any):
    """functions.api.function: marks a function that Functions (and function-backed series) can call."""

    def mark(f: Callable) -> Callable:
        f.__bsai_function__ = True  # type: ignore[attr-defined]
        return f

    return mark(fn) if fn is not None else mark


class TimeSeriesProperty:
    def __init__(self, obj: dict, prop: str) -> None:
        self._obj = obj
        self._prop = prop

    def _points(self, start: Any = None, end: Any = None) -> list[dict]:
        res = _call(f"/api/timeseries/objects/{urllib.parse.quote(self._obj['object_type_id'])}/{urllib.parse.quote(str(self._obj['primary_key']))}/series",
                    params={"property": self._prop, "start": _text(start), "end": _text(end), "buckets": 20000, "raw": "true", "resource": _resource()})
        return res["points"]

    def to_pandas(self, all_time: bool = False, start: Any = None, end: Any = None):
        return _frame(self._points(None if all_time else start, None if all_time else end))

    def to_polars(self, all_time: bool = False, start: Any = None, end: Any = None):
        import polars as pl

        return pl.from_pandas(self.to_pandas(all_time, start, end))

    def get_all_points(self, start: Any = None, end: Any = None) -> list[dict]:
        return [{"time": p["t"], "value": p["value"]} for p in self._points(start, end)]

    def get_first_point(self) -> Optional[dict]:
        pts = self.get_all_points()
        return pts[0] if pts else None

    def get_last_point(self) -> Optional[dict]:
        pts = self.get_all_points()
        return pts[-1] if pts else None

    getFirstPoint = get_first_point  # noqa: N815 (TypeScript-style names)
    getLastPoint = get_last_point  # noqa: N815


class OsdkObject:
    """An object as a function receives it: properties as attributes, time series properties as TimeSeriesProperty."""

    def __init__(self, obj: dict) -> None:
        self.__dict__["_obj"] = obj

    def __getattr__(self, name: str) -> Any:
        obj = self.__dict__["_obj"]
        if name in ("primary_key", "pk"):
            return obj["primary_key"]
        if name in obj.get("timeseries", []):
            return TimeSeriesProperty(obj, name)
        if name in obj.get("properties", {}):
            return obj["properties"][name]
        raise AttributeError(f"{obj.get('object_type', 'object')} has no property {name}")

    def __repr__(self) -> str:
        return f"{self.__dict__['_obj'].get('object_type')}({self.__dict__['_obj']['primary_key']!r})"


def run_function(repo: Path, spec: dict) -> list[list]:
    """Call spec['function'] of spec['file'] (already imported by the runner) with spec['args']; points as [ms, value]."""
    path = (repo / spec["file"]).resolve()
    mod = next((m for m in list(sys.modules.values()) if isinstance((getattr(m, "__dict__", None) or {}).get("__file__"), str) and Path(m.__dict__["__file__"]).resolve() == path), None)
    if mod is None:
        spec_ = importlib.util.spec_from_file_location("bsai_function_module", path)
        mod = importlib.util.module_from_spec(spec_)  # type: ignore[arg-type]
        spec_.loader.exec_module(mod)  # type: ignore[union-attr]
    fn = getattr(mod, spec["function"], None)
    if not callable(fn):
        raise LookupError(f"{spec['file']} has no function {spec['function']}")
    args = {k: OsdkObject(v["__object__"]) if isinstance(v, dict) and "__object__" in v else v for k, v in (spec.get("args") or {}).items()}
    out = fn(**args)
    if isinstance(out, list) and (not out or isinstance(out[0], (bytes, bytearray))):
        df = TimeSeries.deserialize(out)
    elif hasattr(out, "to_pandas") and not hasattr(out, "iloc"):
        df = out.to_pandas()
    else:
        df = out
    if df is None or not hasattr(df, "columns") or not {"timestamp", "value"} <= set(map(str, df.columns)):
        raise TypeError("a function-backed time series returns TimeSeries.serialize(df) or a DataFrame with timestamp and value columns")
    import pandas as pd

    ts = pd.to_datetime(df["timestamp"], utc=True)
    points = []
    for t, v in zip(ts, df["value"]):
        if v is None or (isinstance(v, float) and v != v):
            continue
        if isinstance(v, str):
            raise TypeError("categorical time series outputs are not supported")
        points.append([int(t.value // 1_000_000), float(v)])
    return points


def install(transforms_pkg: types.ModuleType) -> None:
    fts = types.ModuleType("foundryts")
    fts.__path__ = []  # type: ignore[attr-defined]
    fts.FoundryTS = FoundryTS
    nodes = types.ModuleType("foundryts.nodes")
    nodes.TimeseriesNode, nodes.ObjectTimeseriesNode, nodes.Node = TimeseriesNode, ObjectTimeseriesNode, Node
    funcs = types.ModuleType("foundryts.functions")
    for f in (dsl, time_range, rolling_aggregate, periodic_aggregate, derivative, integral, shift, sample, scale, time_extent, statistics, first_point, last_point):
        setattr(funcs, f.__name__, f)
    search = types.ModuleType("foundryts.search")
    search.ontology, search.Predicate = ontology, Predicate
    fts.nodes, fts.functions, fts.search = nodes, funcs, search  # type: ignore[attr-defined]
    tts = types.ModuleType("transforms.timeseries")
    tts.TimeSeriesInput = TimeSeriesInput
    tobj = types.ModuleType("transforms.objects")
    tobj.ObjectInput = ObjectInput
    transforms_pkg.timeseries, transforms_pkg.objects = tts, tobj  # type: ignore[attr-defined]
    sdk = types.ModuleType("timeseries_sdk")
    sdk.__path__ = []  # type: ignore[attr-defined]
    sdk_types = types.ModuleType("timeseries_sdk.types")
    sdk_types.TimeSeries = TimeSeries
    sdk_fn = types.ModuleType("timeseries_sdk.functions")
    sdk_fn.__path__ = []  # type: ignore[attr-defined]
    sdk_fn_types = types.ModuleType("timeseries_sdk.functions.types")
    sdk_fn_types.TimeSeries = TimeSeries
    sdk.types, sdk.functions, sdk_fn.types = sdk_types, sdk_fn, sdk_fn_types  # type: ignore[attr-defined]
    functions_pkg = types.ModuleType("functions")
    functions_pkg.__path__ = []  # type: ignore[attr-defined]
    functions_api = types.ModuleType("functions.api")
    functions_api.function = function
    functions_pkg.api = functions_api  # type: ignore[attr-defined]
    osdk = types.ModuleType("ontology_sdk")
    osdk.__path__ = []  # type: ignore[attr-defined]
    osdk_ont = types.ModuleType("ontology_sdk.ontology")
    osdk_ont.__path__ = []  # type: ignore[attr-defined]
    osdk_objs = types.ModuleType("ontology_sdk.ontology.objects")
    osdk_objs.__getattr__ = lambda name: type(name, (OsdkObject,), {})  # type: ignore[attr-defined]
    osdk.ontology, osdk_ont.objects = osdk_ont, osdk_objs  # type: ignore[attr-defined]
    sys.modules.update({"foundryts": fts, "foundryts.nodes": nodes, "foundryts.functions": funcs, "foundryts.search": search,
                        "transforms.timeseries": tts, "transforms.objects": tobj, "timeseries_sdk": sdk, "timeseries_sdk.types": sdk_types,
                        "timeseries_sdk.functions": sdk_fn, "timeseries_sdk.functions.types": sdk_fn_types, "functions": functions_pkg,
                        "functions.api": functions_api, "ontology_sdk": osdk, "ontology_sdk.ontology": osdk_ont, "ontology_sdk.ontology.objects": osdk_objs})
