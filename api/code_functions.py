"""Python functions in Code Repositories, modelled on Foundry's Python functions and the Python Ontology SDK.

Modules for repository code (installed by code_pyapi.install_modules, after the time series modules):

  functions.api        @function / @function(api_name="myQuery", edits=[Employee, OntologyLinkType(Employee, "reports")]),
                       the type aliases (String, Integer, Long, Double, Float, Boolean, Date, Timestamp, Array, Set, Map,
                       Optional), OntologyEdit, OntologyLinkType and UserFacingError
                       @function(sources=["Weather"], errors=[MyError]); aggregation outputs (Range, SingleBucket,
                       TwoDimensionalAggregation, NestedBucket, ThreeDimensionalAggregation), Notification /
                       ShortNotification / EmailNotificationContent and Principal / User / Group (function-backed action
                       notifications), GeoPoint, GeoShape, Attachment (read(), get_metadata()), Media / MediaItem
                       (get_media_content(), get_media_metadata(), get_media_reference()), Marking, Iterator[...] outputs
                       (streamed as they are yielded), span("name") and get_logger() (run telemetry)
  functions.aliases    custom("key") and model("alias").rid: the repository's custom and model aliases
  functions.language_models
                       chat(prompt, model=None, system=None) and embed(texts, model=None, kind="doc"|"query")
  functions.sources    get_source("Api").get_https_connection().get_client().get("/path"): a REST API source imported into
                       the repository; the platform adds the credentials and keeps requests on its domains
  functions.webhooks   execute("Source", "webhook", **inputs): a Data Connection webhook
  functions.testing    stub_object(Type, pk, **props), StubObjectSet([...]) and verify_edits(edits, {...}) for unit tests
  ontology_sdk         FoundryClient().ontology.objects.<ObjectType> → an object set: where(<ObjectType>.object_type.<prop> > 1),
                       search_around("linkApiName"), get(pk), take(n), iterate(), count().compute(), sum / avg / min /
                       max("prop").compute(), group_by("a"[, "b"], granularity=, ranges=).count() / .sum("p") → aggregations,
                       union / intersect / subtract, order_by("p", descending=True).take(n), nearest_neighbors(query=, num_neighbors=,
                       vector_property=) (relevance ordered), keyword_search(query, k) (BM25), hybrid_search(query, k),
                       combine_with_rrf(list_a, list_b, k=60),
                       to_dataframe(); dict[Object, value] outputs back Workshop table columns; .ontology.edits() → an edits container (objects.<Type>.create(pk,
                       **props), .edit(obj | pk) with property assignment and link .add/.remove/.set/.clear, .delete(obj | pk),
                       get_edits()); .ontology.queries.<snake_name>(**inputs) calls an API-named query function;
                       .ontology.attachments.upload(file_path, name) → an Attachment, .ontology.media.upload_media(body=,
                       filename=) → a Media (Files items: set them on an object property with an edit to keep them)
  ontology_sdk.ontology.interfaces / interface_object_sets
                       interfaces as function inputs and outputs (Foundry offers them in TypeScript v2 only): an
                       interface object reads the interface's properties (mapped to its object type's), as_object() is the
                       concrete object; <Interface>ObjectSet (or client.ontology.interfaces.<Interface>) filters with
                       where(<Interface>.object_type.<prop> > 1) and iterates the objects of every implementing type;
                       edits through interfaces (TypeScript v2's Edits.Interface): edits.interfaces.<Interface>.edit(obj)
                       sets interface properties on the mapped properties (struct fields merged; not the one the primary
                       key implements), .create(object_type=<Type>, **interface_props) (the primary key's interface
                       property required), .delete(obj); edits=[<Interface>] declares every implementing type. Staged
                       writes accept them too (Foundry does not support interface edits there)
  foundry_sdk          the platform SDK (FoundryClient(auth=..., hostname=...) — both ignored): admin.User.get(id) /
                       get_current(), admin.Group.get(id), functions.Query.execute(api_name, parameters={...}) (an
                       API-named query, or a Palantir model's CreateChatCompletion → value {"completion"}),
                       media_sets.MediaSet.read(media_set_rid=, media_item_rid=) → bytes; datasets are refused, like
                       Foundry's function scopes (platform_sdk.py)
  ontology_sdk.WriteableClient
                       staged writes (@function(beta=True, edits=[...]) whose first parameter is a WriteableClient, injected
                       by the runtime): client.ontology.staged_writes() is an edits container whose edits every later read
                       sees (the run's hidden scenario, synced before each request); they need not be returned and are
                       committed together by the function-backed action, or discarded when the function raises;
                       queries and staged-write functions it calls (client.ontology.queries.<name>(...),
                       functions.Query.execute) run in the same transaction: they read the staged edits, a staged-write
                       one's edits join this run's, and if any call fails every staged edit is discarded; what a called
                       function writes without staging (an action it applies) joins this run's edits too, taken right
                       after the call (POST /staged-writes/<id>/direct), so the run's next sync keeps it — as does what
                       the run itself writes that way (taken after each of its POST requests, so edits keep their
                       order); so do the
                       edits of a staged-write function that a called plain query calls (the query hands them on with
                       POST /staged-writes/<id>/direct/add), and a failure the plain query catches still dooms the run
  ontology_sdk.ontology.objects / object_sets
                       any object type (and <ObjectType>ObjectSet) for type hints and predicates

Objects are read-only (assigning raises); everything is read through the platform API with the run's job token, so a
function only sees what its user may see. `describe` lists a repository's functions (inputs, output, edits, API name)
for the registry; `invoke` runs one with JSON inputs and returns a JSON value, edits or a user-facing error.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import inspect
import json
import os
import re
import sys
import types
import typing
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

ALIASES: dict = {"custom": {}, "model": {}}
# the running function: repository, name and declared sources (set by invoke)
CONTEXT: dict = {}
# telemetry of the current run: platform calls (performance), log records and spans
_CALLS: list = []
_LOGS: list = []
_SPANS: list = []


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


def _call(path: str, body: Optional[dict] = None, params: Optional[dict] = None) -> Any:
    import time as _time

    started = _time.monotonic()
    status = "ok"
    try:
        # read-after-write: the platform sees the staged edits before anything is read
        _sync_staged()
        res = _call_raw(path, body, params)
        if body is not None and _STAGED["box"] is not None and not path.startswith(("/api/ontology/staged-writes", "/api/functions/queries/")):
            # the run itself may have written without staging (an action it applied): those writes join its staged
            # edits right away, in order, so an edit it stages later still wins (nested calls take theirs after merging)
            _take_direct()
        return res
    except Exception:
        status = "error"
        raise
    finally:
        if len(_CALLS) < 2000:
            _CALLS.append({"path": path.split("?")[0], "method": "POST" if body is not None else "GET", "ms": round((_time.monotonic() - started) * 1000, 1),
                           "status": status, "at_ms": round((started - _T0[0]) * 1000, 1) if _T0 else 0})


_T0: list = []
# staged writes of the running function: its transaction (a hidden scenario), its edits container and what was synced
_STAGED: dict = {"sid": None, "box": None, "synced": None, "failed": None}


def _sync_staged() -> None:
    box = _STAGED["box"]
    if box is None or not _STAGED["sid"]:
        return
    edits = _jsonable([dict(e) for e in box.get_edits()])
    mark = json.dumps(edits, sort_keys=True, default=str)
    if mark != _STAGED["synced"]:
        _call_raw(f"/api/ontology/staged-writes/{_STAGED['sid']}", {"edits": edits}, method="PUT")
        _STAGED["synced"] = mark


def _take_direct() -> None:
    """Writes made inside the transaction without staging (a called function applying an action) join this run's
    staged edits, after what it staged so far — so its next sync keeps them and the action commits them."""
    if _STAGED["box"] is None or not _STAGED["sid"]:
        return
    got = _call_raw(f"/api/ontology/staged-writes/{_STAGED['sid']}/direct", {})
    if got.get("failed"):
        # a call somewhere inside the transaction failed (also one a called plain query caught): every edit is discarded
        _STAGED["failed"] = _STAGED["failed"] or str(got["failed"])
    taken = got.get("edits") or []
    if taken:
        _STAGED["box"].merge(taken)


def _call_raw(path: str, body: Optional[dict] = None, params: Optional[dict] = None, method: Optional[str] = None) -> Any:
    base = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000").rstrip("/")
    token = os.environ.get("BLUESANDAI_API_TOKEN")
    url = base + path + (("?" + urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})) if params else "")
    headers = {"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})}
    if os.environ.get("BLUESANDAI_USAGE_RESOURCE"):
        headers["x-bluesandai-resource"] = os.environ["BLUESANDAI_USAGE_RESOURCE"]
    if _STAGED["sid"] and not path.startswith("/api/ontology/staged-writes"):
        headers["x-bluesandai-scenario"] = _STAGED["sid"]
    elif CONTEXT.get("scenario") and not path.startswith("/api/ontology/staged-writes"):
        # the function was called inside an Ontology scenario: its reads and writes stay in it
        headers["x-bluesandai-scenario"] = CONTEXT["scenario"]
    if CONTEXT.get("snapshot"):
        # consistent snapshots: every Ontology read of this run sees the same data
        headers["x-bluesandai-snapshot"] = CONTEXT["snapshot"]
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 method=method or ("POST" if body is not None else "GET"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        raise RuntimeError(f"Ontology request failed ({e.code}): {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"the platform API is not reachable: {e.reason}") from None


_META: dict = {}


def _types() -> list[dict]:
    if "types" not in _META:
        _META["types"] = _call("/api/ontology/object-types")
    return _META["types"]


def _links() -> list[dict]:
    if "links" not in _META:
        _META["links"] = _call("/api/ontology/link-types")
    return _META["links"]


def _norm(name: str) -> str:
    return re.sub(r"[_\s]", "", name).lower()


def _type(name: str) -> dict:
    for t in _types():
        if _norm(t["api_name"]) == _norm(name) or t["id"] == name:
            return t
    raise AttributeError(f"no object type named {name} (import it into the ontology this function reads)")


def _prop_name(t: dict, name: str) -> str:
    for p in t["properties"]:
        if p["api_name"] == name or _norm(p["api_name"]) == _norm(name):
            return p["api_name"]
    raise AttributeError(f"{t['api_name']} has no property {name}")


# ------------------------------------------------------------------------------------------------
# functions.api
# ------------------------------------------------------------------------------------------------


class UserFacingError(Exception):
    """An error whose message is shown to the user (in actions, Workshop and the function's metrics)."""


class OntologyLinkType:
    def __init__(self, source: Any, api_name: str) -> None:
        self.source = getattr(source, "__name__", str(source))
        self.api_name = api_name


class OntologyEdit(dict):
    """One edit: {"op": create|modify|delete, object_type_id, primary_key, properties} or a link edit."""


@dataclasses.dataclass
class Range:
    """A bucket key covering [start, end) (numbers or dates); None is open."""
    start: Any = None
    end: Any = None


@dataclasses.dataclass
class SingleBucket:
    key: Any
    value: Any


@dataclasses.dataclass
class TwoDimensionalAggregation:
    """Buckets of one key and a value: what Workshop charts render (bar, pie, line)."""
    buckets: list = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class NestedBucket:
    key: Any
    buckets: list = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class ThreeDimensionalAggregation:
    """Buckets of a key, each with buckets of a second key and a value (stacked or grouped charts)."""
    buckets: list = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class Principal:
    id: str
    kind: str = "user"  # user | group


def User(id: str) -> Principal:  # noqa: N802,A002 - Foundry names
    return Principal(id, "user")


def Group(id: str) -> Principal:  # noqa: N802,A002
    return Principal(id, "group")


@dataclasses.dataclass
class ShortNotification:
    """The in-platform notification: a heading, content and optional links ([{"label", "url"}])."""
    heading: str
    content: str = ""
    links: list = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class EmailNotificationContent:
    subject: str
    body: str = ""


@dataclasses.dataclass
class Notification:
    """What a function-backed notification rule sends: the platform notification and the email."""
    platform_notification: Optional[ShortNotification] = None
    email_notification: Optional[EmailNotificationContent] = None


class GeoPoint(str):
    """"latitude,longitude"."""


class GeoShape(dict):
    """A GeoJSON geometry."""


def _file_meta(rid: str) -> types.SimpleNamespace:
    m = _call(f"/api/ontology/attachments/{urllib.parse.quote(str(rid))}")
    return types.SimpleNamespace(rid=m["id"], name=m["name"], filename=m["name"], media_type=m["media_type"], size_bytes=m["size_bytes"], path=m["path"])


def _file_bytes(rid: str) -> Any:
    import base64
    import io

    return io.BytesIO(base64.b64decode(_call(f"/api/ontology/attachments/{urllib.parse.quote(str(rid))}/content")["data"]))


class Attachment(str):
    """An attachment's reference (a Files item): read() its bytes, get_metadata()."""

    @property
    def rid(self) -> str:
        return str(self)

    def read(self) -> Any:
        """The contents as a BytesIO."""
        return _file_bytes(self)

    def get_metadata(self) -> types.SimpleNamespace:
        return _file_meta(self)


class MediaItem(str):
    """A media reference (a Files / media set item): its contents, metadata and reference."""

    def get_media_reference(self) -> str:
        return str(self)

    def get_media_metadata(self) -> types.SimpleNamespace:
        """path, size_bytes, media_type."""
        m = _file_meta(self)
        return types.SimpleNamespace(path=m.path, size_bytes=m.size_bytes, media_type=m.media_type)

    def get_media_full_metadata(self) -> types.SimpleNamespace:
        return _file_meta(self)

    def get_media_content(self) -> Any:
        """The contents as a BytesIO."""
        return _file_bytes(self)

    read = get_media_content


Media = MediaItem


def _upload(data: bytes, filename: str, kind: str, object_type: Any = None, property: Optional[str] = None) -> dict:  # noqa: A002
    import base64

    tid = None
    if object_type is not None:
        tid = _type(object_type if isinstance(object_type, str) else getattr(object_type, "__name__", str(object_type)))["id"]
    return _call("/api/ontology/attachments", {"filename": filename, "data": base64.b64encode(data).decode(), "kind": kind,
                                               "object_type_id": tid, "property": property})


class _Attachments:
    def upload(self, file_path: str, attachment_name: Optional[str] = None) -> Attachment:
        """Upload a local file; set the Attachment on an object property with an edit to keep it."""
        data = Path(file_path).read_bytes()
        return Attachment(_upload(data, attachment_name or Path(file_path).name, "attachment")["id"])


class _MediaNS:
    def upload_media(self, body: bytes, filename: str, object_type: Any = None, property: Optional[str] = None) -> MediaItem:  # noqa: A002
        """Upload bytes as media (into the property's upload destination when object_type and property are given)."""
        return MediaItem(_upload(bytes(body), filename, "media", object_type, property)["id"])

    async def async_upload_media(self, body: bytes, filename: str, object_type: Any = None, property: Optional[str] = None) -> MediaItem:  # noqa: A002
        return self.upload_media(body, filename, object_type, property)


class Marking(str):
    """A marking ID."""


String, Integer, Long, Double, Float, Boolean, Short, Byte, Decimal = str, int, int, float, float, bool, int, int, float
Date, Timestamp = dt.date, dt.datetime
Array, Set, Map = list, set, dict
# a user / group ID (the platform SDK reads them: admin.User.get, admin.Group.get)
UserId = GroupId = str


def function(fn: Optional[Callable] = None, *, api_name: Optional[str] = None, edits: Optional[list] = None, beta: bool = False,
             sources: Optional[list] = None, errors: Optional[list] = None, implements: Optional[str] = None,
             dimension: Optional[int] = None, **_: Any):
    """Mark a function for the functions registry; api_name exposes a query through the API gateway; edits declares the
    object types (and many-to-many link types) an Ontology edit function edits; sources the REST API sources it calls
    (imported into the repository); errors the named errors (UserFacingError subclasses) callers can handle;
    implements a function interface (ChatCompletion, Embedding) — an Embedding function may declare the dimension of
    its vectors (checked on every call; otherwise the dimension of its first answer is recorded)."""

    def mark(f: Callable) -> Callable:
        f.__bsai_function__ = True  # type: ignore[attr-defined]
        f.__bsai_meta__ = {"api_name": api_name, "beta": beta, "implements": implements, "dimension": dimension,  # type: ignore[attr-defined]
                           "edits": None if edits is None else [getattr(e, "__name__", None) or (f"link:{e.source}.{e.api_name}" if isinstance(e, OntologyLinkType) else str(e)) for e in edits],
                           "sources": [str(x) for x in sources or []],
                           "errors": [{"name": e.__name__, "doc": inspect.getdoc(e) or ""} for e in errors or []]}
        return f

    return mark(fn) if fn is not None else mark


# ------------------------------------------------------------------------------------------------
# objects, predicates and object sets
# ------------------------------------------------------------------------------------------------


class Predicate:
    def __init__(self, filters: list[dict]) -> None:
        self.filters = filters

    def __and__(self, other: "Predicate") -> "Predicate":
        return Predicate(self.filters + other.filters)

    def __or__(self, other: "Predicate") -> "Predicate":
        raise TypeError("combine predicates with & (or use .in_([...]) for alternatives)")


class _PropRef:
    def __init__(self, type_name: str, prop: str) -> None:
        self._type, self._prop = type_name, prop

    def _p(self, op: str, value: Any = None) -> Predicate:
        t = _type(self._type)
        if isinstance(value, (dt.date, dt.datetime)):
            value = value.isoformat()
        return Predicate([{"property": _prop_name(t, self._prop), "op": op, "value": value}])

    def __eq__(self, v: Any) -> Predicate:  # type: ignore[override]
        return self._p("eq", v)

    def __ne__(self, v: Any) -> Predicate:  # type: ignore[override]
        return self._p("neq", v)

    def __gt__(self, v: Any) -> Predicate:
        return self._p("gt", v)

    def __ge__(self, v: Any) -> Predicate:
        return self._p("gte", v)

    def __lt__(self, v: Any) -> Predicate:
        return self._p("lt", v)

    def __le__(self, v: Any) -> Predicate:
        return self._p("lte", v)

    def contains(self, v: Any) -> Predicate:
        return self._p("contains", v)

    def starts_with(self, v: Any) -> Predicate:
        return self._p("starts_with", v)

    def in_(self, values: list) -> Predicate:
        return self._p("in", list(values))

    is_in = in_

    def is_null(self) -> Predicate:
        return self._p("is_null")

    def is_not_null(self) -> Predicate:
        return self._p("not_null")

    def range(self, gte: Any = None, lte: Any = None) -> Predicate:
        return self._p("between", [gte, lte])

    __hash__ = None  # type: ignore[assignment]


class _TypeProps:
    def __init__(self, name: str) -> None:
        self._name = name

    def __getattr__(self, prop: str) -> _PropRef:
        return _PropRef(self._name, prop)


class OsdkObject:
    """A read-only object: properties as attributes (API or snake_case names), links as attributes."""

    object_type: _TypeProps

    def __init__(self, pub: dict) -> None:
        self.__dict__["_pub"] = pub

    @property
    def primary_key(self) -> Any:
        return self.__dict__["_pub"]["primary_key"]

    @property
    def title(self) -> str:
        return self.__dict__["_pub"]["title"]

    def _type(self) -> dict:
        return next(t for t in _types() if t["id"] == self.__dict__["_pub"]["object_type_id"])

    def __getattr__(self, name: str) -> Any:
        pub = self.__dict__["_pub"]
        t = self._type()
        for p in t["properties"]:
            if p["api_name"] == name or _norm(p["api_name"]) == _norm(name):
                if p["type"] == "timeseries":
                    import code_foundryts

                    return code_foundryts.TimeSeriesProperty(pub, p["api_name"])
                v = pub["properties"].get(p["api_name"])
                wrap = {"attachment": Attachment, "media": MediaItem}.get(p["type"])
                if wrap and v:
                    return [wrap(x) for x in v] if isinstance(v, list) else wrap(v)
                return v
        links = _call(f"/api/ontology/object-types/{t['id']}/objects/{urllib.parse.quote(str(pub['primary_key']))}/links", params={"limit": 10000})
        for ln in links:
            if _norm(ln["api_name"]) == _norm(name):
                objs = [_wrap(o) for o in ln["objects"]]
                return objs if ln["many"] else (objs[0] if objs else None)
        raise AttributeError(f"{t['api_name']} has no property or link {name}")

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("objects are read-only: edit them through FoundryClient().ontology.edits().objects.<Type>.edit(obj)")

    def __eq__(self, other: Any) -> bool:
        return isinstance(other, OsdkObject) and other.__dict__["_pub"]["object_type_id"] == self.__dict__["_pub"]["object_type_id"] \
            and str(other.primary_key) == str(self.primary_key)

    def __hash__(self) -> int:
        return hash((self.__dict__["_pub"]["object_type_id"], str(self.primary_key)))

    def __repr__(self) -> str:
        return f"{self._type()['api_name']}({self.primary_key!r})"


# ------------------------------------------------------------------------------------------------
# interfaces (inputs, outputs and object sets)
# ------------------------------------------------------------------------------------------------

_IFACES: list = []


def _interfaces() -> list[dict]:
    if not _IFACES:
        _IFACES.extend(_call("/api/ontology/interfaces"))
    return _IFACES


def _iface(name: str) -> dict:
    for i in _interfaces():
        if name in (i["api_name"], i["id"]) or _norm(i["api_name"]) == _norm(name):
            return i
    raise AttributeError(f"no interface {name}")


def _iface_prop(i: dict, name: str) -> str:
    for p in i.get("all_properties") or i.get("properties") or []:
        if p["api_name"] == name or _norm(p["api_name"]) == _norm(name):
            return p["api_name"]
    raise AttributeError(f"{i['api_name']} has no property {name}")


class _IfacePropRef(_PropRef):
    def _p(self, op: str, value: Any = None) -> Predicate:
        if isinstance(value, (dt.date, dt.datetime)):
            value = value.isoformat()
        return Predicate([{"property": _iface_prop(_iface(self._type), self._prop), "op": op, "value": value}])


class _IfaceProps:
    def __init__(self, name: str) -> None:
        self._name = name

    def __getattr__(self, prop: str) -> _IfacePropRef:
        return _IfacePropRef(self._name, prop)


class OsdkInterface:
    """An object seen through an interface: the interface's properties as attributes; as_object() is the object."""

    object_type: _IfaceProps

    def __init__(self, pub: dict, iface: dict, props: dict) -> None:
        self.__dict__.update(_pub=pub, _iface=iface, _props=props)

    @property
    def primary_key(self) -> Any:
        return self.__dict__["_pub"]["primary_key"]

    @property
    def title(self) -> str:
        return self.__dict__["_pub"].get("title")

    @property
    def object_type_api_name(self) -> str:
        return next((t["api_name"] for t in _types() if t["id"] == self.__dict__["_pub"]["object_type_id"]), "")

    def as_object(self) -> "OsdkObject":
        pub = self.__dict__["_pub"]
        t = next(x for x in _types() if x["id"] == pub["object_type_id"])
        return _wrap(_call(f"/api/ontology/object-types/{t['id']}/objects/{urllib.parse.quote(str(pub['primary_key']))}"))

    def __getattr__(self, name: str) -> Any:
        return self.__dict__["_props"].get(_iface_prop(self.__dict__["_iface"], name))

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("interface objects are read-only")

    def __eq__(self, other: Any) -> bool:
        return isinstance(other, OsdkInterface) and (other.__dict__["_pub"]["object_type_id"], str(other.primary_key)) == \
            (self.__dict__["_pub"]["object_type_id"], str(self.primary_key))

    def __hash__(self) -> int:
        return hash((self.__dict__["_pub"]["object_type_id"], str(self.primary_key)))

    def __repr__(self) -> str:
        return f"{self.__dict__['_iface']['api_name']}({self.object_type_api_name}:{self.primary_key!r})"


_ICLASSES: dict[str, type] = {}


def _iface_class(name: str) -> type:
    if name not in _ICLASSES:
        _ICLASSES[name] = type(name, (OsdkInterface,), {"object_type": _IfaceProps(name), "__module__": "ontology_sdk.ontology.interfaces"})
    return _ICLASSES[name]


def _iface_wrap(pub: dict, i: dict, props: Optional[dict] = None) -> OsdkInterface:
    if props is None:
        # a concrete object: its implementation maps the interface's properties to its own (struct fields as "prop.field")
        t = next(x for x in _types() if x["id"] == pub["object_type_id"])
        imp = next((m for m in t.get("implements") or [] if m.get("interface_id") == i["id"]), None) or _implementation(t, i) or {}
        own = pub.get("properties") or {}
        props = {}
        for ip, local in (imp.get("mapping") or {}).items():
            if local in own or "." not in local:
                props[ip] = own.get(local)
            else:
                v = own.get(local.split(".", 1)[0])
                props[ip] = v.get(local.split(".", 1)[1]) if isinstance(v, dict) else None
    return _iface_class(i["api_name"])(pub, i, props)


class InterfaceObjectSet:
    """The objects of every object type implementing an interface, filtered on the interface's properties."""

    def __init__(self, iface_name: str, filters: Optional[list] = None, members: Optional[list] = None) -> None:
        self._iface_name, self._filters, self._members = iface_name, list(filters or []), members

    def where(self, *preds: Predicate) -> "InterfaceObjectSet":
        return InterfaceObjectSet(self._iface_name, self._filters + [f for p in preds for f in p.filters], self._members)

    def _rows(self, limit: int = 100_000) -> list[OsdkInterface]:
        i = _iface(self._iface_name)
        res = _call("/api/ontology/explorer/search", {"interface_id": i["id"], "filters": self._filters, "limit": min(limit, 1000) if self._members is None else 1000,
                                                       "histograms": False})
        rows = res["objects"]
        if self._members is not None:
            keep = {(m["object_type_id"], str(m["primary_key"])) for m in self._members}
            rows = [r for r in rows if (r["object_type_id"], str(r["primary_key"])) in keep]
        return [_iface_wrap(r, i, r.get("properties") or {}) for r in rows[:limit]]

    def iterate(self) -> list[OsdkInterface]:
        return self._rows()

    def take(self, n: int) -> list[OsdkInterface]:
        return self._rows(n)

    def all(self) -> list[OsdkInterface]:  # noqa: A003
        return self._rows()

    def __iter__(self) -> Any:
        return iter(self._rows())

    def count(self) -> "_Agg":
        return _Agg(len(self._rows()))


def _iface_set_class(name: str) -> type:
    base = name[: -len("ObjectSet")] if name.endswith("ObjectSet") else name
    def init(self: InterfaceObjectSet, filters: Optional[list] = None, members: Optional[list] = None) -> None:
        InterfaceObjectSet.__init__(self, base, filters, members)

    return type(name, (InterfaceObjectSet,), {"__init__": init, "__module__": "ontology_sdk.ontology.interface_object_sets", "_base": base})


_CLASSES: dict[str, type] = {}


def _class(name: str) -> type:
    if name not in _CLASSES:
        _CLASSES[name] = type(name, (OsdkObject,), {"object_type": _TypeProps(name), "__module__": "ontology_sdk.ontology.objects"})
    return _CLASSES[name]


def _wrap(pub: dict) -> OsdkObject:
    t = next((x for x in _types() if x["id"] == pub["object_type_id"]), None)
    return _class(t["api_name"] if t else "Object")(pub)


class _Agg:
    def __init__(self, value: Any) -> None:
        self._v = value

    def compute(self) -> Any:
        return self._v


class ObjectSet:
    def __init__(self, type_name: str, filters: Optional[list] = None, around: Optional[list] = None, pks: Optional[list] = None) -> None:
        self._type_name = type_name
        self._filters = list(filters or [])
        self._around = list(around or [])
        if pks is not None:
            t = _type(type_name)
            self._filters.append({"property": t["primary_key"], "op": "in", "value": [str(x) for x in pks]})

    def _spec(self, **extra: Any) -> dict:
        return {"object_type_id": _type(self._type_name)["id"], "filters": self._filters, "search_around": self._around, "histograms": False,
                "resource": os.environ.get("BLUESANDAI_USAGE_RESOURCE") or "function", **extra}

    def where(self, *preds: Predicate) -> "ObjectSet":
        if self._around:
            raise TypeError("filter before a Search Around (filters apply to the starting object type)")
        return ObjectSet(self._type_name, self._filters + [f for p in preds for f in p.filters])

    def search_around(self, link: str) -> "ObjectSet":
        t = _type(self._type_name)
        for lt in _links():
            for direction, start, reach in (("forward", lt["source"], lt["target"]), ("reverse", lt["target"], lt["source"])):
                if start["object_type_id"] == t["id"] and _norm(reach["api_name"]) == _norm(link):
                    nxt = next(x for x in _types() if x["id"] == reach["object_type_id"])
                    return _AroundSet(t["api_name"], [r.primary_key for r in self._all()], lt["id"], direction, nxt["api_name"])
        raise AttributeError(f"{t['api_name']} has no link {link}")

    def _page(self, offset: int, limit: int) -> dict:
        return _call("/api/ontology/explorer/search", self._spec(offset=offset, limit=limit))

    def _all(self, limit: int = 100_000) -> list[OsdkObject]:
        out: list[OsdkObject] = []
        offset = 0
        while len(out) < limit:
            page = self._page(offset, min(1000, limit - len(out)))
            out.extend(_wrap(o) for o in page["objects"])
            offset += len(page["objects"])
            if not page["objects"] or offset >= page["total"]:
                break
        if len(out) >= 100_000:
            raise RuntimeError("an object set loads at most 100,000 objects at once: filter it or aggregate instead")
        return out

    def iterate(self) -> list[OsdkObject]:
        return self._all()

    __iter__ = lambda self: iter(self._all())  # noqa: E731

    def take(self, n: int) -> list[OsdkObject]:
        return self._all(n)

    def all(self) -> list[OsdkObject]:
        return self._all()

    def get(self, pk: Any) -> Optional[OsdkObject]:
        t = _type(self._type_name)
        try:
            return _wrap(_call(f"/api/ontology/object-types/{t['id']}/objects/{urllib.parse.quote(str(pk))}"))
        except RuntimeError:
            return None

    def count(self) -> _Agg:
        return _Agg(self._page(0, 1)["total"])

    def _metric(self, metric: str, prop: str) -> _Agg:
        t = _type(self._type_name)
        res = _call("/api/ontology/explorer/search", self._spec(limit=1, aggregate={"metric": metric, "property": _prop_name(t, prop)}))
        groups = (res.get("aggregation") or {}).get("groups") or []
        return _Agg(groups[0]["value"] if groups else None)

    def sum(self, prop: str) -> _Agg:
        return self._metric("sum", prop)

    def avg(self, prop: str) -> _Agg:
        return self._metric("avg", prop)

    def min(self, prop: str) -> _Agg:
        return self._metric("min", prop)

    def max(self, prop: str) -> _Agg:
        return self._metric("max", prop)

    def group_by(self, *props: str, granularity: Optional[str] = None, ranges: Optional[list] = None) -> "_Grouped":
        """Group by one property ({key: count}, with .count() / .sum(p) / .avg(p) / .min(p) / .max(p) returning a
        TwoDimensionalAggregation) or two (ThreeDimensionalAggregation). Dates group by day, month or year with
        granularity=...; numbers into ranges=[Range(0, 10), Range(10, None)]."""
        if not props or len(props) > 2:
            raise TypeError("group by one or two properties")
        t = _type(self._type_name)
        names = [_prop_name(t, p) for p in props]
        if len(names) == 1 and not granularity and not ranges and not getattr(self, "_local", None):
            res = _call("/api/ontology/explorer/search", self._spec(limit=1, aggregate={"metric": "count", "group_by": names[0]}))
            counts = {g["group"]: g["count"] for g in (res.get("aggregation") or {}).get("groups") or []}
            return _Grouped(self, names, granularity, ranges, counts)
        g = _Grouped(self, names, granularity, ranges, None)
        dict.update(g, {(b.key if len(names) == 1 else b.key): (b.value if len(names) == 1 else {x.key: x.value for x in b.buckets}) for b in g.count().buckets})
        return g

    def _rows(self) -> list[dict]:
        return [r.__dict__["_pub"]["properties"] for r in self._all()]

    def _pks(self) -> list[str]:
        return [str(r.primary_key) for r in self._all()]

    def _same(self, other: "ObjectSet") -> None:
        if _norm(getattr(other, "_reach", other._type_name)) != _norm(getattr(self, "_reach", self._type_name)):
            raise TypeError("set operations need object sets of the same object type")

    def union(self, *others: "ObjectSet") -> "ObjectSet":
        pks = dict.fromkeys(self._pks())
        for o in others:
            self._same(o)
            pks.update(dict.fromkeys(o._pks()))
        return ObjectSet(getattr(self, "_reach", self._type_name), pks=list(pks))

    def intersect(self, *others: "ObjectSet") -> "ObjectSet":
        pks = set(self._pks())
        for o in others:
            self._same(o)
            pks &= set(o._pks())
        return ObjectSet(getattr(self, "_reach", self._type_name), pks=[p for p in self._pks() if p in pks])

    def subtract(self, *others: "ObjectSet") -> "ObjectSet":
        drop: set = set()
        for o in others:
            self._same(o)
            drop |= set(o._pks())
        return ObjectSet(getattr(self, "_reach", self._type_name), pks=[p for p in self._pks() if p not in drop])

    def order_by(self, prop: str, descending: bool = False) -> "_OrderedSet":
        return _OrderedSet(self, prop, descending)

    def _ranked(self, body: dict) -> list[OsdkObject]:
        t = _type(getattr(self, "_reach", self._type_name))
        scoped = bool(self._filters or self._around or getattr(self, "_reach", None))
        res = _call("/api/ontology/semantic/knn", {"object_type_id": t["id"], **({"primary_keys": self._pks()} if scoped else {}),
                                                   "resource": os.environ.get("BLUESANDAI_USAGE_RESOURCE") or "function", **body})
        return [_wrap(o) for o in res["objects"]]

    def nearest_neighbors(self, query: Any = None, k: Optional[int] = None, prop: Any = None, *, num_neighbors: Optional[int] = None,
                          vector_property: Any = None) -> list[OsdkObject]:
        """The objects nearest the query (k / num_neighbors of them, 1-500), most relevant first: a query text is
        embedded with the vector property's embedding model; a list of floats is used as is.
        nearest_neighbors(query="...", num_neighbors=5, vector_property=Doc.object_type.embedding)."""
        t = _type(getattr(self, "_reach", self._type_name))
        vp = vector_property if vector_property is not None else prop
        name = vp._prop if isinstance(vp, _PropRef) else (_prop_name(t, vp) if vp else None)
        n = int(num_neighbors or k or 10)
        body = {"k": n, "property": name}
        body.update({"query": query} if isinstance(query, str) else {"vector": [float(x) for x in query or []]})
        return self._ranked(body)

    def keyword_search(self, query: str, k: int = 10, properties: Optional[list] = None) -> list[OsdkObject]:
        """Ranked keyword search (BM25): any query token matches, ordered by relevance."""
        return self._ranked({"query": query, "k": int(k), "mode": "keyword",
                             "text_properties": [p._prop if isinstance(p, _PropRef) else p for p in properties or []] or None})

    def hybrid_search(self, query: str, k: int = 10, vector_property: Any = None) -> list[OsdkObject]:
        """Semantic and keyword search fused with reciprocal rank fusion."""
        name = vector_property._prop if isinstance(vector_property, _PropRef) else vector_property
        return self._ranked({"query": query, "k": int(k), "mode": "hybrid", "property": name})

    def to_dataframe(self):
        import pandas as pd

        rows = self._all()
        return pd.DataFrame([{"__primary_key": r.primary_key, **r.__dict__["_pub"]["properties"]} for r in rows])

    def primary_keys(self) -> list[str]:
        return [str(r.primary_key) for r in self._all()]


def _bucket(v: Any, granularity: Optional[str], ranges: Optional[list]) -> Any:
    if v is None:
        return None
    if ranges:
        for r in ranges:
            if (r.start is None or v >= r.start) and (r.end is None or v < r.end):
                return f"{'' if r.start is None else r.start}–{'' if r.end is None else r.end}"
        return None
    if granularity:
        text = v.isoformat() if isinstance(v, (dt.date, dt.datetime)) else str(v)
        return {"year": text[:4], "month": text[:7], "day": text[:10], "hour": text[:13]}.get(granularity, text)
    return v


class _Grouped(dict):
    """{key: count} for one property; metrics return aggregations."""

    def __init__(self, src: "ObjectSet", props: list, granularity: Optional[str], ranges: Optional[list], counts: Optional[dict]) -> None:
        super().__init__(counts or {})
        self._src, self._props, self._gran, self._ranges = src, props, granularity, ranges

    def _metric(self, metric: str, prop: Optional[str]) -> Any:
        rows = self._src._rows()
        t = _type(getattr(self._src, "_reach", self._src._type_name))
        col = _prop_name(t, prop) if prop else None
        groups: dict = {}
        for r in rows:
            k1 = _bucket(r.get(self._props[0]), self._gran, self._ranges)
            k2 = _bucket(r.get(self._props[1]), None, None) if len(self._props) > 1 else None
            groups.setdefault(k1, {}).setdefault(k2, []).append(r.get(col) if col else 1)

        def agg(vals: list) -> Any:
            nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if metric == "count":
                return len(vals)
            if not nums:
                return None
            return {"sum": sum(nums), "avg": sum(nums) / len(nums), "min": min(nums), "max": max(nums)}[metric]

        keys = sorted(groups, key=lambda x: (x is None, str(x)))
        if len(self._props) == 1:
            return TwoDimensionalAggregation([SingleBucket(k, agg(groups[k][None])) for k in keys])
        return ThreeDimensionalAggregation([NestedBucket(k, [SingleBucket(k2, agg(v)) for k2, v in sorted(groups[k].items(), key=lambda x: str(x[0]))]) for k in keys])

    def count(self) -> Any:  # type: ignore[override]
        return self._metric("count", None)

    def sum(self, prop: str) -> Any:
        return self._metric("sum", prop)

    def avg(self, prop: str) -> Any:
        return self._metric("avg", prop)

    def min(self, prop: str) -> Any:
        return self._metric("min", prop)

    def max(self, prop: str) -> Any:
        return self._metric("max", prop)


class _OrderedSet:
    def __init__(self, src: "ObjectSet", prop: str, descending: bool) -> None:
        self._src, self._prop, self._desc = src, prop, descending

    def _sorted(self) -> list:
        col = self._prop if getattr(self._src, "_local", False) else _prop_name(_type(getattr(self._src, "_reach", self._src._type_name)), self._prop)
        rows = self._src._all()
        present = [r for r in rows if r.__dict__["_pub"]["properties"].get(col) is not None]
        missing = [r for r in rows if r.__dict__["_pub"]["properties"].get(col) is None]
        return sorted(present, key=lambda r: r.__dict__["_pub"]["properties"][col], reverse=self._desc) + missing

    def take(self, n: int) -> list:
        return self._sorted()[:n]

    def all(self) -> list:
        return self._sorted()

    iterate = all
    __iter__ = lambda self: iter(self._sorted())  # noqa: E731


class _AroundSet(ObjectSet):
    def __init__(self, start_type: str, pks: list, link_type_id: str, direction: str, reach_type: str) -> None:
        super().__init__(start_type, pks=pks)
        self._around = [{"link_type_id": link_type_id, "direction": direction}]
        self._reach = reach_type


_SETS: dict[str, type] = {}


def _set_class(name: str) -> type:
    if name not in _SETS:
        base = name[: -len("ObjectSet")] if name.endswith("ObjectSet") else name
        _SETS[name] = type(name, (ObjectSet,), {"__init__": lambda self, *a, **k: ObjectSet.__init__(self, base, *a, **k)})
    return _SETS[name]


# ------------------------------------------------------------------------------------------------
# edits
# ------------------------------------------------------------------------------------------------


class _LinkEditor:
    def __init__(self, ed: "EditableObject", lt: dict, direction: str) -> None:
        self._ed, self._lt, self._dir = ed, lt, direction

    def _other_pk(self, other: Any) -> str:
        return str(other.primary_key if isinstance(other, (OsdkObject, EditableObject)) else other)

    def _link(self, op: str, other: Any) -> None:
        mine, theirs = str(self._ed.primary_key), self._other_pk(other)
        lt = self._lt
        if lt["kind"] == "join_table":
            src, tgt = (mine, theirs) if self._dir == "forward" else (theirs, mine)
            self._ed._box.links.append(OntologyEdit(kind="link", op="add" if op == "add" else "remove", link_type_id=lt["id"], source=src, target=tgt))
        elif lt["kind"] == "foreign_key":
            if self._dir == "forward":
                # this object holds the foreign key
                self._ed._set(lt["foreign_key"], theirs if op == "add" else None)
            else:
                holder = self._ed._box.objects_by_id(lt["source"]["object_type_id"]).edit(theirs)
                holder._set(lt["foreign_key"], mine if op == "add" else None)
        else:
            raise TypeError("links of a backing object type are edited by editing the link objects")

    def add(self, other: Any) -> None:
        self._link("add", other)

    def remove(self, other: Any) -> None:
        self._link("remove", other)

    def set(self, other: Any) -> None:  # noqa: A003
        self._link("add", other)

    def clear(self) -> None:
        if self._lt["kind"] == "foreign_key" and self._dir == "forward":
            self._ed._set(self._lt["foreign_key"], None)
        else:
            raise TypeError("clear() applies to single links held by this object")


class EditableObject:
    def __init__(self, box: "_Edits", t: dict, pk: Any, base: Optional[dict], created: bool) -> None:
        self.__dict__.update(_box=box, _t=t, _pk=str(pk), _base=base or {}, _created=created)

    @property
    def primary_key(self) -> str:
        return self.__dict__["_pk"]

    def _set(self, prop: str, value: Any) -> None:
        box, t = self.__dict__["_box"], self.__dict__["_t"]
        if prop == t["primary_key"] and not self.__dict__["_created"]:
            raise AttributeError("the primary key of an existing object cannot change")
        if isinstance(value, (dt.datetime, dt.date)):
            value = value.isoformat()
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            value = dataclasses.asdict(value)
        box.record("create" if self.__dict__["_created"] else "modify", t["id"], self.primary_key, {prop: value})

    def __setattr__(self, name: str, value: Any) -> None:
        self._set(_prop_name(self.__dict__["_t"], name), value)

    def __getattr__(self, name: str) -> Any:
        t, box = self.__dict__["_t"], self.__dict__["_box"]
        try:
            prop = _prop_name(t, name)
            edit = box.edits.get((t["id"], self.primary_key))
            if edit and prop in edit["properties"]:
                return edit["properties"][prop]
            return self.__dict__["_base"].get(prop)
        except AttributeError:
            pass
        for lt in _links():
            for direction, start, reach in (("forward", lt["source"], lt["target"]), ("reverse", lt["target"], lt["source"])):
                if start["object_type_id"] == t["id"] and _norm(reach["api_name"]) == _norm(name):
                    return _LinkEditor(self, lt, direction)
        raise AttributeError(f"{t['api_name']} has no property or link {name}")


class _TypeEdits:
    def __init__(self, box: "_Edits", t: dict) -> None:
        self._box, self._t = box, t

    def create(self, primary_key: Any = None, **props: Any) -> EditableObject:
        if primary_key is None:
            # create(employee_id=..., first_name=...): the primary key among the properties
            key = next((k for k in props if _prop_name(self._t, k) == self._t["primary_key"]), None)
            if key is None:
                raise TypeError(f"create() needs the primary key {self._t['primary_key']}")
            primary_key = props.pop(key)
        ed = EditableObject(self._box, self._t, primary_key, {}, True)
        self._box.record("create", self._t["id"], str(primary_key), {self._t["primary_key"]: primary_key})
        for k, v in props.items():
            setattr(ed, k, v)
        return ed

    def edit(self, obj: Any) -> EditableObject:
        pk = obj.primary_key if isinstance(obj, (OsdkObject, EditableObject, OsdkInterface, EditableInterfaceObject)) else obj
        base = obj.__dict__["_pub"]["properties"] if isinstance(obj, OsdkObject) else {}
        if not base:
            try:
                base = _call(f"/api/ontology/object-types/{self._t['id']}/objects/{urllib.parse.quote(str(pk))}")["properties"]
            except RuntimeError:
                base = {}
        created = (self._t["id"], str(pk)) in self._box.edits and self._box.edits[(self._t["id"], str(pk))]["op"] == "create"
        return EditableObject(self._box, self._t, pk, base, created)

    def delete(self, obj: Any) -> None:
        pk = obj.primary_key if isinstance(obj, (OsdkObject, EditableObject, OsdkInterface, EditableInterfaceObject)) else obj
        self._box.record("delete", self._t["id"], str(pk), {})


def _iface_lineage(iface_id: str) -> set:
    """An interface and every interface it extends (transitively)."""
    out, todo = set(), [iface_id]
    while todo:
        x = todo.pop()
        if x in out:
            continue
        out.add(x)
        rec = next((i for i in _interfaces() if i["id"] == x), None)
        todo.extend((rec or {}).get("extends") or [])
    return out


def _implementation(t: dict, i: dict) -> Optional[dict]:
    """How object type t implements interface i (directly, or through an interface that extends it)."""
    return next((imp for imp in t.get("implements") or [] if i["id"] in _iface_lineage(imp["interface_id"])), None)


def _type_arg(object_type: Any) -> dict:
    """An object type given as its class (ontology_sdk.ontology.objects.X), API name or id."""
    if isinstance(object_type, dict):
        return object_type
    return _type(getattr(object_type, "__name__", None) if isinstance(object_type, type) else str(object_type))


class EditableInterfaceObject:
    """An object edited through an interface: setting an interface property sets the property (or struct field) the
    object's type maps it to; reading one reads the edited value, else the object's current value."""

    def __init__(self, ed: EditableObject, iface: dict, imp: dict) -> None:
        self.__dict__.update(_ed=ed, _iface=iface, _imp=imp)

    @property
    def primary_key(self) -> str:
        return self.__dict__["_ed"].primary_key

    @property
    def object_type_api_name(self) -> str:
        return self.__dict__["_ed"].__dict__["_t"]["api_name"]

    def as_object(self) -> EditableObject:
        """The same edit seen as the implementing object type's editable object."""
        return self.__dict__["_ed"]

    def _local(self, name: str) -> tuple[str, str]:
        i, imp, t = self.__dict__["_iface"], self.__dict__["_imp"], self.__dict__["_ed"].__dict__["_t"]
        ip = _iface_prop(i, name)
        local = (imp.get("mapping") or {}).get(ip)
        if not local:
            raise AttributeError(f"{t['api_name']} does not map the interface property {i['api_name']}.{ip}")
        return ip, local

    def __setattr__(self, name: str, value: Any) -> None:
        ip, local = self._local(name)
        ed = self.__dict__["_ed"]
        t = ed.__dict__["_t"]
        if local == t["primary_key"] and not ed.__dict__["_created"]:
            raise AttributeError(f"{self.__dict__['_iface']['api_name']}.{ip} is implemented by the primary key of {t['api_name']}: it cannot be updated")
        if "." in local and not any(p["api_name"] == local for p in t["properties"]):
            # a struct field: merged into the struct's current value
            sp, sf = local.split(".", 1)
            cur = getattr(ed, sp)
            if isinstance(value, (dt.datetime, dt.date)):
                value = value.isoformat()
            ed._set(sp, {**(cur if isinstance(cur, dict) else {}), sf: value})
            return
        ed._set(local, value)

    def __getattr__(self, name: str) -> Any:
        _, local = self._local(name)
        ed = self.__dict__["_ed"]
        if "." in local and not any(p["api_name"] == local for p in ed.__dict__["_t"]["properties"]):
            v = getattr(ed, local.split(".", 1)[0])
            return v.get(local.split(".", 1)[1]) if isinstance(v, dict) else None
        return getattr(ed, local)

    def __repr__(self) -> str:
        return f"{self.__dict__['_iface']['api_name']}({self.object_type_api_name}:{self.primary_key!r}, editable)"


class _InterfaceEdits:
    """Edits through an interface (like TypeScript v2's Edits.Interface): edit / delete an object of any implementing
    type, create one of a given implementing type from interface properties."""

    def __init__(self, box: "_Edits", iface: dict) -> None:
        self._box, self._i = box, iface

    def _target(self, obj: Any, object_type: Any) -> tuple[dict, Any, Any]:
        if isinstance(obj, EditableInterfaceObject):
            obj = obj.as_object()
        if isinstance(obj, (OsdkInterface, OsdkObject)):
            t = next(x for x in _types() if x["id"] == obj.__dict__["_pub"]["object_type_id"])
            return t, obj.primary_key, obj if isinstance(obj, OsdkObject) else obj.primary_key
        if isinstance(obj, EditableObject):
            return obj.__dict__["_t"], obj.primary_key, obj.primary_key
        if object_type is None:
            raise TypeError(f"{self._i['api_name']}: pass an object, or its primary key with object_type=<the implementing type>")
        return _type_arg(object_type), obj, obj

    def _imp(self, t: dict) -> dict:
        imp = _implementation(t, self._i)
        if imp is None:
            raise TypeError(f"{t['api_name']} does not implement the interface {self._i['api_name']}")
        return imp

    def edit(self, obj: Any, object_type: Any = None) -> EditableInterfaceObject:
        t, _, ref = self._target(obj, object_type)
        imp = self._imp(t)
        return EditableInterfaceObject(_TypeEdits(self._box, t).edit(ref), self._i, imp)

    def create(self, object_type: Any = None, **props: Any) -> EditableInterfaceObject:
        """create(object_type=Employee, first_name=..., ...): creating through an interface needs the concrete type,
        and one of the properties given must be the interface property its primary key implements."""
        if object_type is None:
            raise TypeError(f"creating through the interface {self._i['api_name']} needs object_type=<an implementing object type>")
        t = _type_arg(object_type)
        imp = self._imp(t)
        mapping = imp.get("mapping") or {}
        given = {_iface_prop(self._i, k): v for k, v in props.items()}
        pk_prop = next((ip for ip, local in mapping.items() if local == t["primary_key"]), None)
        if pk_prop is None or given.get(pk_prop) is None:
            raise TypeError(f"creating a {t['api_name']} through {self._i['api_name']} needs "
                            + (f"{pk_prop} (implemented by its primary key {t['primary_key']})" if pk_prop else f"an interface property implemented by its primary key {t['primary_key']} (none is mapped)"))
        ed = EditableInterfaceObject(_TypeEdits(self._box, t).create(primary_key=given.pop(pk_prop)), self._i, imp)
        for ip, v in given.items():
            setattr(ed, ip, v)
        return ed

    def delete(self, obj: Any, object_type: Any = None) -> None:
        t, pk, _ = self._target(obj, object_type)
        self._imp(t)
        self._box.record("delete", t["id"], str(pk), {})


def _declared_type_ids(names: Optional[list]) -> list[str]:
    """The object types an edit function declares: object types, and every implementing type of a declared interface."""
    out: list[str] = []
    for name in names or []:
        if name.startswith("link:"):
            continue
        try:
            out.append(_type(name)["id"])
            continue
        except AttributeError:
            pass
        try:
            i = _iface(name)
        except AttributeError:
            continue
        out += [t["id"] for t in _types() if _implementation(t, i) is not None]
    return list(dict.fromkeys(out))


class _Edits:
    def __init__(self) -> None:
        self.edits: dict[tuple[str, str], OntologyEdit] = {}
        self.order: list[tuple[str, str]] = []
        self.links: list[OntologyEdit] = []

    def record(self, op: str, type_id: str, pk: str, props: dict) -> None:
        key = (type_id, pk)
        cur = self.edits.get(key)
        if cur is None:
            self.edits[key] = OntologyEdit(op=op, object_type_id=type_id, primary_key=pk, properties=dict(props))
            self.order.append(key)
        elif op == "delete":
            if cur["op"] == "create":
                self.edits.pop(key)
                self.order.remove(key)
            else:
                cur.update(op="delete", properties={})
        else:
            cur["properties"].update(props)

    def objects_by_id(self, type_id: str) -> _TypeEdits:
        return _TypeEdits(self, next(t for t in _types() if t["id"] == type_id))

    @property
    def objects(self) -> Any:
        box = self

        class _NS:
            def __getattr__(self, name: str) -> _TypeEdits:
                return _TypeEdits(box, _type(name))

        return _NS()

    @property
    def interfaces(self) -> Any:
        """Edits through interfaces: edits.interfaces.<Interface>.edit(obj) / .create(object_type=..., ...) / .delete(obj)."""
        box = self

        class _NS:
            def __getattr__(self, name: str) -> _InterfaceEdits:
                if name.startswith("__") and name.endswith("__"):
                    raise AttributeError(name)
                return _InterfaceEdits(box, _iface(name))

        return _NS()

    def get_edits(self) -> list[OntologyEdit]:
        return [self.edits[k] for k in self.order] + list(self.links)

    def merge(self, edits: list) -> None:
        """Stage the edits a nested staged-write call returned, after this run's own (later edits win)."""
        for e in edits or []:
            if e.get("kind") == "link":
                self.links.append(OntologyEdit(e))
                continue
            key, cur = (e["object_type_id"], str(e["primary_key"])), self.edits.get((e["object_type_id"], str(e["primary_key"])))
            if cur is not None and cur["op"] == "delete" and e["op"] != "delete":
                cur.update(op="modify" if e["op"] == "modify" else "create", properties=dict(e.get("properties") or {}))
            else:
                self.record(e["op"], key[0], key[1], e.get("properties") or {})


def _nested_call(path: str, body: dict) -> dict:
    """A query or function called from the running function. Inside a staged-write run it runs in the same transaction:
    it reads the staged edits, a staged-write function's edits join this run's, and a failure discards them all."""
    try:
        res = _call(path, body)
    except Exception as e:
        if _STAGED["box"] is not None:
            _STAGED["failed"] = _STAGED["failed"] or str(e)
        raise
    if _STAGED["box"] is not None:
        if not res.get("ok"):
            _STAGED["failed"] = _STAGED["failed"] or str(res.get("error") or "the query failed")
        else:
            if res.get("staged_writes") and res.get("edits"):
                _STAGED["box"].merge(res["edits"])
            # what the call wrote without staging joins the run's edits right away (later edits of the run win)
            _take_direct()
    elif CONTEXT.get("staged_parent") and CONTEXT.get("scenario") and res.get("ok") and res.get("staged_writes") and res.get("edits"):
        # a plain query running inside a staged-write run called a staged-write function: the query has no staged edits
        # of its own to hold them, so they join the transaction as writes made with its caller's header — this query
        # reads them from now on, and the caller takes them after the call (committed or discarded with the outer run)
        _call_raw(f"/api/ontology/staged-writes/{CONTEXT['scenario']}/direct/add", {"edits": _jsonable(res["edits"])})
    return res


class _Queries:
    def __getattr__(self, name: str) -> Callable:
        camel = re.sub(r"_([a-z])", lambda m: m.group(1).upper(), name)

        def call(**inputs: Any) -> Any:
            res = _nested_call(f"/api/functions/queries/{camel}/execute", {"inputs": {k: _jsonable(v) for k, v in inputs.items()}})
            if not res.get("ok"):
                raise RuntimeError(res.get("error") or "the query failed")
            return res.get("value")

        return call


class _OntologyNS:
    @property
    def objects(self) -> Any:
        class _NS:
            def __getattr__(self, name: str) -> ObjectSet:
                return ObjectSet(_type(name)["api_name"])

        return _NS()

    def edits(self) -> _Edits:
        return _Edits()

    @property
    def interfaces(self) -> Any:
        class _NS:
            def __getattr__(self, name: str) -> InterfaceObjectSet:
                return InterfaceObjectSet(_iface(name)["api_name"])

        return _NS()

    @property
    def attachments(self) -> _Attachments:
        return _Attachments()

    @property
    def media(self) -> _MediaNS:
        return _MediaNS()

    @property
    def queries(self) -> _Queries:
        return _Queries()


class FoundryClient:
    def __init__(self, *_: Any, **__: Any) -> None:
        if CONTEXT.get("pipeline_udf"):
            # like Foundry: Pipeline Builder UDFs cannot read the Ontology (data would leave its markings)
            raise RuntimeError("EnvironmentNotConfigured: a Pipeline Builder UDF cannot access the Ontology")
        self.ontology = _OntologyNS()


class _StagedOntologyNS(_OntologyNS):
    def staged_writes(self) -> _Edits:
        if _STAGED["box"] is None:
            raise RuntimeError("staged writes need a WriteableClient injected by the functions runtime")
        return _STAGED["box"]


class WriteableClient(FoundryClient):
    """The client of a staged-write function: injected by the runtime as its first parameter."""

    def __init__(self, *_: Any, **__: Any) -> None:
        self.ontology = _StagedOntologyNS()


# ------------------------------------------------------------------------------------------------
# the Foundry platform SDK (foundry_sdk)
# ------------------------------------------------------------------------------------------------


def _ns(d: dict) -> types.SimpleNamespace:
    return types.SimpleNamespace(**d)


class _PUsers:
    def get(self, user_id: str, **_: Any) -> types.SimpleNamespace:
        return _ns(_call(f"/api/platform-sdk/admin/users/{urllib.parse.quote(str(user_id))}"))

    def get_current(self, **_: Any) -> types.SimpleNamespace:
        return _ns(_call("/api/platform-sdk/admin/users/current"))


class _PGroups:
    def get(self, group_id: str, **_: Any) -> types.SimpleNamespace:
        return _ns(_call(f"/api/platform-sdk/admin/groups/{urllib.parse.quote(str(group_id))}"))


class _PAdmin:
    User, Group = _PUsers(), _PGroups()


class _PQueries:
    def execute(self, query_api_name: str, parameters: Optional[dict] = None, **_: Any) -> types.SimpleNamespace:
        params = parameters or {}
        if query_api_name.startswith("com.foundry.languagemodelservice.models.") and query_api_name.endswith("CreateChatCompletion"):
            msgs = [{"role": str(m.get("role", "user")).lower(), "content": m.get("content")} for m in params.get("messages") or []]
            return _ns({"value": _call("/api/platform-sdk/language-models/chat", {"messages": msgs})})
        res = _nested_call(f"/api/functions/queries/{urllib.parse.quote(query_api_name)}/execute", {"inputs": {k: _jsonable(v) for k, v in params.items()}})
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "the query failed")
        return _ns({"value": res.get("value")})


class _PFunctions:
    Query = _PQueries()


class _PMediaSet:
    def read(self, media_set_rid: Optional[str] = None, media_item_rid: Optional[str] = None, **_: Any) -> bytes:
        return _file_bytes(media_item_rid or "").getvalue()


class _PMediaSets:
    MediaSet = _PMediaSet()


class _PDatasets:
    def __getattr__(self, name: str) -> Any:
        raise PermissionError("functions cannot read datasets through the platform SDK (no api:usage:datasets-read scope)")


class PlatformClient:
    """foundry_sdk.FoundryClient: authentication and hostname are the platform's own (the run's job token)."""

    def __init__(self, auth: Any = None, hostname: Optional[str] = None, **_: Any) -> None:
        self.admin, self.functions, self.media_sets, self.datasets = _PAdmin(), _PFunctions(), _PMediaSets(), _PDatasets()


# ------------------------------------------------------------------------------------------------
# aliases and language models
# ------------------------------------------------------------------------------------------------


def custom(key: str) -> str:
    if key not in ALIASES["custom"]:
        raise KeyError(f"no custom alias {key} (add it in the Functions app → Aliases)")
    return ALIASES["custom"][key]


class _Model:
    def __init__(self, alias: str, model_id: str) -> None:
        self.alias, self.model_id = alias, model_id
        self.rid = f"ri.language-model-service..language-model.{model_id}"


def model(alias: str) -> _Model:
    if alias not in ALIASES["model"]:
        raise KeyError(f"no model alias {alias}")
    return _Model(alias, ALIASES["model"][alias])


def embed(texts: Any, model: Any = None, kind: str = "doc") -> list:
    """Embeddings (unit-length vectors) for one text or a list; kind="query" for search queries."""
    single = isinstance(texts, str)
    mid = model.model_id if isinstance(model, _Model) else (ALIASES["model"].get(model) or model) if model else None
    out = _call("/api/functions/llm/embed", {"texts": [texts] if single else list(texts), "model": mid, "kind": kind})["vectors"]
    return out[0] if single else out


def chat(prompt: str, model: Any = None, system: Optional[str] = None) -> str:  # noqa: A002 - Foundry name
    mid = model.model_id if isinstance(model, _Model) else (ALIASES["model"].get(model) or model) if model else None
    res = _call("/api/functions/llm/chat", {"prompt": prompt, "model": mid, "system": system})
    return res["text"]


# ------------------------------------------------------------------------------------------------
# telemetry, sources, webhooks and testing
# ------------------------------------------------------------------------------------------------


def combine_with_rrf(*result_lists: list, k: int = 60) -> list:
    """Reciprocal rank fusion of ranked result lists (objects, or anything hashable): score = sum of 1 / (k + rank)."""
    scores: dict = {}
    first: dict = {}
    for lst in result_lists:
        for rank, item in enumerate(lst):
            key = (item.__dict__["_pub"]["object_type_id"], str(item.primary_key)) if isinstance(item, OsdkObject) else item
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            first.setdefault(key, item)
    return [first[x] for x in sorted(scores, key=lambda x: scores[x], reverse=True)]


class span:  # noqa: N801 - used as a context manager or decorator, like an OpenTelemetry span
    """with span("load orders"): ... records the block's duration in the run's telemetry (Performance tab)."""

    def __init__(self, name: str, **attributes: Any) -> None:
        self.name, self.attributes = name, attributes

    def __enter__(self) -> "span":
        import time as _time

        self._start = _time.monotonic()
        return self

    def __exit__(self, *exc: Any) -> None:
        import time as _time

        end = _time.monotonic()
        if len(_SPANS) < 1000:
            _SPANS.append({"name": self.name, "attributes": _jsonable(self.attributes), "start_ms": round((self._start - (_T0[0] if _T0 else self._start)) * 1000, 1),
                           "ms": round((end - self._start) * 1000, 1), "error": bool(exc and exc[0])})

    def __call__(self, f: Callable) -> Callable:
        def wrapped(*a: Any, **k: Any) -> Any:
            with span(self.name, **self.attributes):
                return f(*a, **k)

        wrapped.__name__ = getattr(f, "__name__", "wrapped")
        return wrapped


def get_logger(name: str = "function") -> Any:
    """A standard logger: its records are kept with the run (level, message, time)."""
    import logging

    return logging.getLogger(name)


class _Response:
    def __init__(self, r: dict) -> None:
        self.status_code = r["status"]
        self.headers = r.get("headers") or {}
        self.text = r.get("text") or ""
        self.ok = 200 <= self.status_code < 400

    def json(self) -> Any:
        return json.loads(self.text)

    def raise_for_status(self) -> None:
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}: {self.text[:500]}")


class _SourceClient:
    """A requests-like client limited to the source's domains; the platform adds the credentials (never visible to code)."""

    def __init__(self, source: str) -> None:
        self._source = source

    def request(self, method: str, url: str, params: Optional[dict] = None, headers: Optional[dict] = None, json: Any = None, data: Any = None,  # noqa: A002
                timeout: Optional[float] = None) -> _Response:
        body = {"repo_id": CONTEXT.get("repo_id"), "function": CONTEXT.get("function"), "source": self._source, "method": method.upper(), "url": url,
                "params": params, "headers": headers, "json": json, "data": data if isinstance(data, (str, type(None))) else None, "timeout": timeout}
        return _Response(_call("/api/functions/sources/request", body))

    def get(self, url: str, **kw: Any) -> _Response:
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw: Any) -> _Response:
        return self.request("POST", url, **kw)

    def put(self, url: str, **kw: Any) -> _Response:
        return self.request("PUT", url, **kw)

    def patch(self, url: str, **kw: Any) -> _Response:
        return self.request("PATCH", url, **kw)

    def delete(self, url: str, **kw: Any) -> _Response:
        return self.request("DELETE", url, **kw)


class _HttpsConnection:
    def __init__(self, source: str, info: dict) -> None:
        self._source, self._info = source, info
        self.url = (info.get("domains") or [{}])[0].get("url")

    def get_client(self) -> _SourceClient:
        return _SourceClient(self._source)


class _Source:
    def __init__(self, api_name: str) -> None:
        self.api_name = api_name
        self._info = _call("/api/functions/sources/describe", {"repo_id": CONTEXT.get("repo_id"), "source": api_name})

    def get_https_connection(self) -> _HttpsConnection:
        return _HttpsConnection(self.api_name, self._info)

    def get_secret(self, name: str) -> str:
        raise PermissionError("source secrets stay on the platform: reference them in webhooks, or let the client add the credentials")


def get_source(api_name: str) -> _Source:
    """A REST API source imported into the repository and declared in @function(sources=[...])."""
    if CONTEXT.get("sources") is not None and api_name not in CONTEXT["sources"]:
        raise PermissionError(f"declare the source in @function(sources=[\"{api_name}\"]) to use it")
    return _Source(api_name)


def execute_webhook(source: str, webhook: str, **inputs: Any) -> dict:
    """Run a Data Connection webhook (by the source's and the webhook's API names); returns its outputs."""
    if CONTEXT.get("sources") is not None and source not in CONTEXT["sources"]:
        raise PermissionError(f"declare the source in @function(sources=[\"{source}\"]) to call its webhooks")
    return _call("/api/functions/sources/webhook", {"repo_id": CONTEXT.get("repo_id"), "source": source, "webhook": webhook, "inputs": _jsonable(inputs)})["outputs"]


class _StubType(dict):
    pass


class _StubObject(OsdkObject):
    def _type(self) -> dict:
        return self.__dict__["_stub_type"]

    def __getattr__(self, name: str) -> Any:
        props = self.__dict__["_pub"]["properties"]
        if name in props:
            return props[name]
        for k, v in props.items():
            if _norm(k) == _norm(name):
                return v
        links = self.__dict__.get("_links") or {}
        if name in links:
            return links[name]
        raise AttributeError(name)


def stub_object(type_name: str, primary_key: Any, links: Optional[dict] = None, **props: Any) -> OsdkObject:
    """A test object that never calls the platform (functions.testing)."""
    t = {"id": f"stub-{type_name}", "api_name": type_name, "primary_key": "id", "properties": [{"api_name": k, "type": "string"} for k in props]}
    o = _StubObject({"object_type_id": t["id"], "primary_key": primary_key, "title": str(primary_key), "properties": props})
    o.__dict__["_stub_type"] = t
    o.__dict__["_links"] = links or {}
    return o


class StubObjectSet(ObjectSet):
    """An in-memory object set for unit tests: where(lambda o: ...), count, metrics, group_by, order_by, set operations."""

    def __init__(self, objects: list) -> None:
        self._objs = list(objects)
        self._type_name = objects[0]._type()["api_name"] if objects else "Stub"
        self._filters, self._around, self._local = [], [], True

    def _all(self, limit: int = 100_000) -> list:
        return self._objs[:limit]

    def where(self, *preds: Any) -> "StubObjectSet":  # type: ignore[override]
        return StubObjectSet([o for o in self._objs if all(p(o) for p in preds)])

    def count(self) -> _Agg:
        return _Agg(len(self._objs))

    def _metric(self, metric: str, prop: str) -> _Agg:
        nums = [getattr(o, prop) for o in self._objs if isinstance(getattr(o, prop, None), (int, float))]
        if not nums:
            return _Agg(None)
        return _Agg({"sum": sum(nums), "avg": sum(nums) / len(nums), "min": min(nums), "max": max(nums)}[metric])

    def _pks(self) -> list:
        return [str(o.primary_key) for o in self._objs]

    def union(self, *others: Any) -> "StubObjectSet":  # type: ignore[override]
        seen, out = set(), []
        for o in self._objs + [x for s in others for x in s._objs]:
            if str(o.primary_key) not in seen:
                seen.add(str(o.primary_key))
                out.append(o)
        return StubObjectSet(out)

    def intersect(self, *others: Any) -> "StubObjectSet":  # type: ignore[override]
        keep = set(self._pks())
        for s in others:
            keep &= set(s._pks())
        return StubObjectSet([o for o in self._objs if str(o.primary_key) in keep])

    def subtract(self, *others: Any) -> "StubObjectSet":  # type: ignore[override]
        drop = {p for s in others for p in s._pks()}
        return StubObjectSet([o for o in self._objs if str(o.primary_key) not in drop])

    def group_by(self, *props: str, granularity: Optional[str] = None, ranges: Optional[list] = None) -> "_Grouped":  # type: ignore[override]
        g = _StubGrouped(self, list(props), granularity, ranges, None)
        dict.update(g, {b.key: (b.value if len(props) == 1 else {x.key: x.value for x in b.buckets}) for b in g.count().buckets})
        return g


class _StubGrouped(_Grouped):
    def _metric(self, metric: str, prop: Optional[str]) -> Any:
        rows = [o.__dict__["_pub"]["properties"] for o in self._src._objs]
        groups: dict = {}
        for r in rows:
            k1 = _bucket(r.get(self._props[0]), self._gran, self._ranges)
            k2 = _bucket(r.get(self._props[1]), None, None) if len(self._props) > 1 else None
            groups.setdefault(k1, {}).setdefault(k2, []).append(r.get(prop) if prop else 1)

        def agg(vals: list) -> Any:
            nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if metric == "count":
                return len(vals)
            return {"sum": sum(nums), "avg": sum(nums) / len(nums), "min": min(nums), "max": max(nums)}[metric] if nums else None

        keys = sorted(groups, key=lambda x: (x is None, str(x)))
        if len(self._props) == 1:
            return TwoDimensionalAggregation([SingleBucket(k, agg(groups[k][None])) for k in keys])
        return ThreeDimensionalAggregation([NestedBucket(k, [SingleBucket(k2, agg(v)) for k2, v in sorted(groups[k].items(), key=lambda x: str(x[0]))]) for k in keys])


def verify_edits(edits: list, *expected: dict) -> None:
    """Assert that an edit function returned the expected edits ({op, object_type?, primary_key?, properties?} subsets)."""
    for exp in expected:
        if not any(all(e.get(k) == v or (k == "properties" and all(e.get("properties", {}).get(pk) == pv for pk, pv in v.items())) for k, v in exp.items() if k != "object_type")
                   for e in edits):
            raise AssertionError(f"no edit matches {exp}: got {edits}")


# ------------------------------------------------------------------------------------------------
# describe and invoke
# ------------------------------------------------------------------------------------------------


def _type_str(a: Any) -> str:
    if a is inspect.Parameter.empty or a is None:
        return "any"
    if isinstance(a, str):
        return a
    origin = typing.get_origin(a)
    args = typing.get_args(a)
    import collections.abc as cabc

    if origin in (cabc.Iterator, cabc.Iterable, cabc.Generator):
        return f"stream<{_type_str(args[0]) if args else 'any'}>"
    if origin in (list, set, tuple, typing.List, typing.Set):
        inner = _type_str(args[0]) if args else "any"
        return "edits" if inner == "OntologyEdit" else f"array<{inner}>"
    if origin is dict:
        if args and isinstance(args[0], type) and issubclass(args[0], OsdkObject):
            return f"map<object:{args[0].__name__},{_type_str(args[1]) if len(args) > 1 else 'any'}>"
        return "map"
    if origin is typing.Union:
        rest = [x for x in args if x is not type(None)]
        return f"optional<{_type_str(rest[0])}>" if len(rest) == 1 else "any"
    if a is str:
        return "string"
    if a is bool:
        return "boolean"
    if a is int:
        return "integer"
    if a is float:
        return "double"
    if a is dt.datetime:
        return "timestamp"
    if a is dt.date:
        return "date"
    if a is OntologyEdit:
        return "OntologyEdit"
    if origin in (typing.Iterator, typing.Iterable, typing.Generator) or getattr(origin, "__name__", "") in ("Iterator", "Iterable", "Generator"):
        return f"stream<{_type_str(args[0]) if args else 'any'}>"
    named = {TwoDimensionalAggregation: "aggregation2d", ThreeDimensionalAggregation: "aggregation3d", Range: "range", Notification: "notification",
             Principal: "principal", GeoPoint: "geopoint", GeoShape: "geoshape", Attachment: "attachment", MediaItem: "media", Marking: "marking"}
    if a in named:
        return named[a]
    if isinstance(a, type) and issubclass(a, OsdkObject):
        return f"object:{a.__name__}"
    if isinstance(a, type) and issubclass(a, OsdkInterface):
        return f"interface:{a.__name__}"
    if isinstance(a, type) and issubclass(a, InterfaceObjectSet):
        return f"interface_set:{getattr(a, '_base', a.__name__)}"
    if isinstance(a, type) and issubclass(a, ObjectSet):
        name = a.__name__
        return f"object_set:{name[: -len('ObjectSet')] if name.endswith('ObjectSet') else name}"
    if dataclasses.is_dataclass(a):
        return f"struct:{a.__name__}"
    return getattr(a, "__name__", str(a))


def _functions(repo: Path) -> list[tuple[str, Callable]]:
    out = []
    for m in list(sys.modules.values()):
        # not getattr: the SDK's lazy modules answer any attribute
        f = (getattr(m, "__dict__", None) or {}).get("__file__")
        if not isinstance(f, str):
            continue
        try:
            rel = Path(f).resolve().relative_to(repo.resolve()).as_posix()
        except ValueError:
            continue
        for name, obj in vars(m).items():
            if callable(obj) and getattr(obj, "__bsai_function__", False) and getattr(obj, "__module__", None) == m.__name__:
                out.append((rel, obj))
    return out


# function interfaces (Foundry's ChatCompletion, and Embedding shaped like a Palantir model's createEmbeddings): a
# function implementing one is a registered model the platform discovers — its language model calls (AIP Logic,
# Pipeline Builder's LLM step, agents) and its text embeddings (semantic search, vector properties, Pipeline Builder's
# Text to embeddings, KNN text queries) can use it like a provider's model
FUNCTION_INTERFACES = {
    "ChatCompletion": "messages: a list of {role, content} → the completion text (or {completion: text}); an Iterator[str] streams it",
    "Embedding": "inputs: a list of strings → one float vector per input (or {embeddings: [...]}); dimension= declares the vector size",
}


def _interface_error(name: str, inputs: list[dict], output: str, dimension: Any = None) -> Optional[str]:
    if name not in FUNCTION_INTERFACES:
        return f"unknown function interface {name} (known: {', '.join(FUNCTION_INTERFACES)})"
    if name == "Embedding":
        if not inputs or inputs[0]["name"] != "inputs" or inputs[0]["type"] not in ("array<string>", "array<any>", "any"):
            return "Embedding: the first input must be inputs: list[str]"
        if any(i["required"] for i in inputs[1:]):
            return "Embedding: inputs after inputs must be optional"
        if output not in ("array<array<double>>", "array<array<integer>>", "array<array<any>>", "array<any>", "any", "map") and not output.startswith("struct:"):
            return "Embedding: return a list of float vectors (list[list[float]]) or a struct with an embeddings field"
        if dimension is not None and (not isinstance(dimension, int) or isinstance(dimension, bool) or not 1 <= dimension <= 4096):
            return "Embedding: dimension must be a whole number from 1 to 4096"
        return None
    if dimension is not None:
        return f"{name}: dimension applies to Embedding functions only"
    if not inputs or inputs[0]["name"] != "messages" or not (inputs[0]["type"].startswith("array") or inputs[0]["type"] == "any"):
        return "ChatCompletion: the first input must be messages: list[dict] (role, content)"
    if any(i["required"] for i in inputs[1:]):
        return "ChatCompletion: inputs after messages must be optional"
    if output not in ("string", "any", "map", "stream<string>", "stream<any>") and not output.startswith("struct:"):
        return "ChatCompletion: return the completion text (str), a struct with a completion field, or stream it (Iterator[str])"
    return None


def describe(repo: Path) -> list[dict]:
    out = []
    for rel, fn in _functions(repo):
        meta = getattr(fn, "__bsai_meta__", {}) or {}
        try:
            hints = typing.get_type_hints(fn)
        except Exception:  # noqa: BLE001 - unresolved forward references
            hints = getattr(fn, "__annotations__", {})
        sig = inspect.signature(fn)
        staged = [n for n, p in sig.parameters.items() if _type_str(hints.get(n, p.annotation)) == "WriteableClient"]
        inputs = [{"name": n, "type": _type_str(hints.get(n, p.annotation)), "required": p.default is inspect.Parameter.empty,
                   **({"default": p.default} if p.default is not inspect.Parameter.empty and isinstance(p.default, (str, int, float, bool, type(None))) else {})}
                  for n, p in sig.parameters.items() if n not in staged]
        output = _type_str(hints.get("return", sig.return_annotation))
        out.append({"name": fn.__name__, "file": rel, "doc": inspect.getdoc(fn) or "", "line": inspect.getsourcelines(fn)[1] if hasattr(fn, "__code__") else 0,
                    "inputs": inputs, "output": output, "api_name": meta.get("api_name"), "edits": meta.get("edits"),
                    "sources": meta.get("sources") or [], "errors": meta.get("errors") or [], **({"staged_writes": staged[0]} if staged else {}),
                    **({"implements": meta["implements"], "interface_error": _interface_error(meta["implements"], inputs, output, meta.get("dimension")),
                        **({"dimension": meta["dimension"]} if meta.get("dimension") is not None else {})} if meta.get("implements") else {}),
                    "kind": "edit" if output == "edits" or meta.get("edits") is not None else "query" if meta.get("api_name") else "function"})
    return out


def _arg(v: Any, annotation: str) -> Any:
    if isinstance(v, dict) and "__object__" in v and annotation.startswith("interface:"):
        return _iface_wrap(v["__object__"], _iface(annotation[10:]))
    if isinstance(v, dict) and "__interface_object_set__" in v:
        s = v["__interface_object_set__"]
        return InterfaceObjectSet(_iface(s["interface_id"])["api_name"], members=s.get("objects"))
    if isinstance(v, dict) and "__object__" in v:
        return _wrap(v["__object__"])
    if isinstance(v, dict) and "__object_set__" in v:
        s = v["__object_set__"]
        t = next(x for x in _types() if x["id"] == s["object_type_id"])
        return ObjectSet(t["api_name"], pks=s.get("primary_keys"))
    if isinstance(v, list):
        inner = annotation[6:-1] if annotation.startswith("array<") else "any"
        return [_arg(x, inner) for x in v]
    if annotation in ("attachment", "media") and isinstance(v, str) and v:
        return Attachment(v) if annotation == "attachment" else MediaItem(v)
    if annotation == "timestamp" and isinstance(v, str):
        return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    if annotation == "date" and isinstance(v, str):
        return dt.date.fromisoformat(v[:10])
    if annotation.startswith("struct:") and isinstance(v, dict):
        return types.SimpleNamespace(**v)
    return v


def _jsonable(v: Any) -> Any:
    if isinstance(v, OsdkInterface):
        p = v.__dict__["_pub"]
        return {"__object__": {"object_type_id": p["object_type_id"], "primary_key": p["primary_key"], "title": p.get("title")},
                "interface": v.__dict__["_iface"]["api_name"]}
    if isinstance(v, InterfaceObjectSet):
        i = _iface(v._iface_name)
        return {"__interface_object_set__": {"interface_id": i["id"], "objects": [
            {"object_type_id": x.__dict__["_pub"]["object_type_id"], "primary_key": x.primary_key} for x in v._rows(10_000)]}}
    if isinstance(v, OsdkObject):
        p = v.__dict__["_pub"]
        return {"__object__": {"object_type_id": p["object_type_id"], "primary_key": p["primary_key"], "title": p["title"]}}
    if isinstance(v, ObjectSet):
        t = _type(getattr(v, "_reach", v._type_name))
        return {"__object_set__": {"object_type_id": t["id"], "primary_keys": v.primary_keys()[:10_000]}}
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, dict) and v and all(isinstance(k, OsdkObject) for k in v):
        # Map<Object, T>: a function-backed column (Workshop object tables)
        return {"__object_map__": [{"primary_key": str(k.primary_key), "value": _jsonable(x)} for k, x in v.items()]}
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x) for x in v]
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return _jsonable(dataclasses.asdict(v))
    if hasattr(v, "to_dict") and hasattr(v, "columns"):
        return json.loads(v.to_json(orient="records", date_format="iso"))
    if isinstance(v, types.SimpleNamespace):
        return _jsonable(vars(v))
    if isinstance(v, float) and v != v:
        return None
    if hasattr(v, "item") and callable(v.item):
        return v.item()
    return v


def invoke(repo: Path, spec: dict) -> dict:
    ALIASES.update(spec.get("aliases") or {})
    fns = {(rel, fn.__name__): fn for rel, fn in _functions(repo)}
    fn = fns.get((spec["file"], spec["function"]))
    if fn is None:
        raise LookupError(f"{spec['file']} has no function {spec['function']}")
    info = next(d for d in describe(repo) if d["file"] == spec["file"] and d["name"] == spec["function"])
    types_ = {i["name"]: i["type"] for i in info["inputs"]}
    CONTEXT["pipeline_udf"] = spec.get("rows") is not None
    if spec.get("rows") is not None:
        # a Pipeline Builder UDF: the function once per row, each row's cells as its arguments; a row's error is kept
        # with it (its output cell is null) instead of failing the step
        out = []
        for row in spec["rows"]:
            try:
                out.append({"value": _jsonable(fn(**{k: _arg(v, types_[k]) for k, v in (row or {}).items() if k in types_ and v is not None}))})
            except Exception as e:  # noqa: BLE001 - a row's failure is reported with the row
                out.append({"error": f"{type(e).__name__}: {e}"[:300]})
        return {"ok": True, "rows": out}
    args = spec.get("args") or {}
    unknown = set(args) - set(types_)
    if unknown:
        return {"ok": False, "category": "invalid_inputs", "error": f"unknown input {sorted(unknown)[0]}"}
    missing = [i["name"] for i in info["inputs"] if i["required"] and args.get(i["name"]) is None]
    if missing:
        return {"ok": False, "category": "invalid_inputs", "error": f"{missing[0]} is required"}
    CONTEXT.update(repo_id=spec.get("repo_id"), function=spec["function"], sources=info.get("sources") or [], snapshot=spec.get("snapshot"), scenario=spec.get("scenario"),
                   staged_parent=spec.get("staged_parent"))
    _CALLS.clear()
    _LOGS.clear()
    _SPANS.clear()
    import logging
    import time as _time

    _T0[:] = [_time.monotonic()]

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if len(_LOGS) < 2000:
                _LOGS.append({"level": record.levelname, "logger": record.name, "message": record.getMessage()[:2000],
                              "at_ms": round((_time.monotonic() - _T0[0]) * 1000, 1)})

    handler = _Capture(logging.DEBUG)
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(min(root.level or logging.INFO, logging.INFO))
    telemetry = lambda: {"calls": list(_CALLS), "log_records": list(_LOGS), "spans": list(_SPANS)}  # noqa: E731
    declared = {e["name"] for e in info.get("errors") or []}
    call_args = {k: _arg(v, types_.get(k, "any")) for k, v in args.items()}
    if info.get("staged_writes"):
        # called from inside another staged-write run (nested): this run joins the caller's transaction
        parent = spec.get("staged_parent")
        _STAGED.update(sid=_call_raw("/api/ontology/staged-writes", {"parent": parent} if parent else {})["id"], box=_Edits(), synced=None, failed=None)
        call_args[info["staged_writes"]] = WriteableClient()
    try:
        try:
            value = fn(**call_args)
            if info["output"].startswith("stream<") or inspect.isgenerator(value):
                chunks = []
                with open("stream.jsonl", "a", encoding="utf-8") as out:
                    for chunk in value:
                        chunks.append(_jsonable(chunk))
                        out.write(json.dumps({"chunk": chunks[-1], "at_ms": round((_time.monotonic() - _T0[0]) * 1000, 1)}) + "\n")
                        out.flush()
                value = "".join(chunks) if all(isinstance(c, str) for c in chunks) else chunks
                return {"ok": True, "value": value, "streamed": len(chunks), **telemetry()}
        except UserFacingError as e:
            name = type(e).__name__
            return {"ok": False, "category": "user_facing", "user_facing": True, "error": str(e), **telemetry(),
                    **({"error_name": name, "error_params": _jsonable(getattr(e, "params", {}) or {})} if name != "UserFacingError" or declared else {})}
        except Exception as e:
            if type(e).__name__ in declared:
                return {"ok": False, "category": "user_facing", "user_facing": True, "error": str(e), "error_name": type(e).__name__, **telemetry()}
            raise
    finally:
        root.removeHandler(handler)
        if _STAGED["sid"] and _STAGED["box"] is not None and not _STAGED.get("failed"):
            # anything written inside the transaction without staging that this run has not taken yet
            try:
                _take_direct()
            except RuntimeError:
                pass
        staged_box, staged_sid, staged_failed = _STAGED["box"], _STAGED["sid"], _STAGED.get("failed")
        _STAGED.update(sid=None, box=None, synced=None, failed=None)
        if staged_sid:
            try:
                ended = _call_raw(f"/api/ontology/staged-writes/{staged_sid}", method="DELETE") or {}
                if not staged_failed and ended.get("failed"):
                    staged_failed = str(ended["failed"])
            except RuntimeError:
                pass
    if staged_box is not None and staged_failed:
        # a call inside the transaction raised: like Foundry, the whole set of staged edits is discarded (even when the
        # function caught the error)
        return {"ok": False, "category": "runtime", "error": f"a call inside the staged-write transaction failed, so every staged edit was discarded: {staged_failed}"[:2000],
                **telemetry()}
    if staged_box is not None:
        # staged writes: the function returns any value; its staged edits are committed by the action
        edits = [dict(e) for e in staged_box.get_edits()]
        return {"ok": True, "value": _jsonable(value), "edits": _jsonable(edits), "staged_writes": True,
                "declared_types": _declared_type_ids(info.get("edits")), **telemetry()}
    if info["kind"] == "edit" or (isinstance(value, list) and value and all(isinstance(x, OntologyEdit) for x in value)):
        edits = [dict(e) for e in (value or [])]
        declared = info.get("edits")
        # object types, and the implementing types of declared interfaces (edits through an interface)
        type_ids = _declared_type_ids(declared)
        if declared is not None:
            for e in edits:
                if e.get("kind") != "link" and e["object_type_id"] not in type_ids:
                    return {"ok": False, "category": "undeclared_edits", "error": f"the function edits {e['object_type_id']} without declaring it in edits=[...]"}
        return {"ok": True, "edits": _jsonable(edits), "declared_types": type_ids, **telemetry()}
    return {"ok": True, "value": _jsonable(value), **telemetry()}


def install() -> None:
    """Register the modules; called after code_foundryts.install (it replaces its simpler functions.api)."""
    api = types.ModuleType("functions.api")
    for name in ("function", "UserFacingError", "OntologyEdit", "OntologyLinkType", "String", "Integer", "Long", "Double", "Float", "Boolean",
                 "Short", "Byte", "Decimal", "Date", "Timestamp", "Array", "Set", "Map", "Range", "SingleBucket", "TwoDimensionalAggregation",
                 "NestedBucket", "ThreeDimensionalAggregation", "Principal", "User", "Group", "Notification", "ShortNotification",
                 "EmailNotificationContent", "GeoPoint", "GeoShape", "Attachment", "MediaItem", "Media", "Marking", "UserId", "GroupId", "span", "get_logger", "combine_with_rrf"):
        setattr(api, name, globals()[name])
    api.Optional = Optional
    api.Iterator = typing.Iterator
    srcs = types.ModuleType("functions.sources")
    srcs.get_source = get_source
    hooks = types.ModuleType("functions.webhooks")
    hooks.execute = execute_webhook
    testing = types.ModuleType("functions.testing")
    testing.stub_object, testing.StubObjectSet, testing.verify_edits = stub_object, StubObjectSet, verify_edits
    aliases = types.ModuleType("functions.aliases")
    aliases.custom, aliases.model = custom, model
    lm = types.ModuleType("functions.language_models")
    lm.chat, lm.embed = chat, embed
    pkg = types.ModuleType("functions")
    pkg.__path__ = []  # type: ignore[attr-defined]
    pkg.api, pkg.aliases, pkg.language_models = api, aliases, lm  # type: ignore[attr-defined]
    pkg.sources, pkg.webhooks, pkg.testing = srcs, hooks, testing  # type: ignore[attr-defined]
    osdk = types.ModuleType("ontology_sdk")
    osdk.__path__ = []  # type: ignore[attr-defined]
    osdk.FoundryClient = FoundryClient
    # the platform's own name (templates and new code): from ontology_sdk import Client
    osdk.Client = FoundryClient  # type: ignore[attr-defined]
    osdk.WriteableClient = WriteableClient
    sdk = types.ModuleType("foundry_sdk")
    sdk.__path__ = []  # type: ignore[attr-defined]
    sdk.FoundryClient = PlatformClient  # type: ignore[attr-defined]
    sdk.UserTokenAuth = sdk.ConfidentialClientAuth = lambda *a, **k: None  # type: ignore[attr-defined]
    v2, core, core_models = types.ModuleType("foundry_sdk.v2"), types.ModuleType("foundry_sdk.v2.core"), types.ModuleType("foundry_sdk.v2.core.models")
    v2.__path__, core.__path__ = [], []  # type: ignore[attr-defined]
    core_models.MediaReference = str  # type: ignore[attr-defined]
    sdk.v2, v2.core, core.models = v2, core, core_models  # type: ignore[attr-defined]
    sys.modules.update({"foundry_sdk": sdk, "foundry_sdk.v2": v2, "foundry_sdk.v2.core": core, "foundry_sdk.v2.core.models": core_models})
    ont = types.ModuleType("ontology_sdk.ontology")
    ont.__path__ = []  # type: ignore[attr-defined]
    def _named(fn):
        # dunder lookups (__file__, __spec__, … asked by inspect, torch, pickle) are not object type names
        def get(name: str):
            if name.startswith("__") and name.endswith("__"):
                raise AttributeError(name)
            return fn(name)

        return get

    objs = types.ModuleType("ontology_sdk.ontology.objects")
    objs.__getattr__ = _named(_class)  # type: ignore[attr-defined]
    sets = types.ModuleType("ontology_sdk.ontology.object_sets")
    sets.__getattr__ = _named(_set_class)  # type: ignore[attr-defined]
    osdk.ontology, ont.objects, ont.object_sets = ont, objs, sets  # type: ignore[attr-defined]
    ifs = types.ModuleType("ontology_sdk.ontology.interfaces")
    ifs.__getattr__ = _named(_iface_class)  # type: ignore[attr-defined]
    ifsets = types.ModuleType("ontology_sdk.ontology.interface_object_sets")
    ifsets.__getattr__ = _named(_iface_set_class)  # type: ignore[attr-defined]
    ont.interfaces, ont.interface_object_sets = ifs, ifsets  # type: ignore[attr-defined]
    sys.modules.update({"ontology_sdk.ontology.interfaces": ifs, "ontology_sdk.ontology.interface_object_sets": ifsets})
    sys.modules.update({"functions.sources": srcs, "functions.webhooks": hooks, "functions.testing": testing})
    sys.modules.update({"functions": pkg, "functions.api": api, "functions.aliases": aliases, "functions.language_models": lm,
                        "ontology_sdk": osdk, "ontology_sdk.ontology": ont, "ontology_sdk.ontology.objects": objs, "ontology_sdk.ontology.object_sets": sets})
