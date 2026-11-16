"""Telemetry of models (integrate-models/instrumentation-telemetry): spans of inference calls, of the outbound HTTP
requests a model makes, and their export to an OpenTelemetry collector.

In a model process (model_worker.py: deployments, test runs, `use_sidecar=True`) and in a transform that calls a
model in its own process (code_models.instance → model_lib.LoadedModel / model_container.ContainerModel):
  Recorder        a span over every inference call ("model inference"); the global OpenTelemetry tracer provider is
                  set, so spans the adapter makes with `trace.get_tracer(__name__)` nest under it. Without the
                  OpenTelemetry SDK the spans are made here (the request span and the HTTP spans).
  HTTP spans      while an inference call runs, requests sent with urllib.request (urlopen / OpenerDirector),
                  `requests` (Session.send) and `httpx` (Client.send / AsyncClient.send) get a CLIENT span ("HTTP
                  <method>": http.request.method, url.full without the query string or user info, server.address,
                  server.port, http.response.status_code; 4xx / 5xx and exceptions are ERROR) and carry the W3C
                  `traceparent` header of that span, so the service called continues the trace. This replaces
                  `opentelemetry-instrumentation` (not installed). urllib3 or http.client used directly are not seen.
  transform calls trace_model() marks a model a transform received; each transform() / predict() /
                  transform_write() call is recorded and the traces are posted (in the background, at most
                  MAX_TRANSFORM_TRACES per run) to POST /api/model-assets/telemetry/transform-traces with the build's
                  token, which keeps them with the model (GET /api/model-assets/{id}/traces) and exports them.

In the API process (deployments, test runs, transform traces, batch deployments):
  report()        hands a call's spans to the OTLP exporter and returns at once (a bounded queue; never raises).
  OtlpExporter    OTLP/HTTP with JSON encoding (POST <endpoint>/v1/traces, ExportTraceServiceRequest written by hand):
                  batches of up to 512 spans or 1 s, retries on connection errors, timeouts, 429, 502, 503 and 504 with
                  exponential backoff (Retry-After honoured, 5 attempts), the queue drops its oldest spans past 2,048.
                  Every attempt passes the egress policies (network.check_egress, and the request runs in an egress
                  scope so the names it resolves are checked); redirects are not followed.
  configuration   the platform setting (PUT /api/model-assets/telemetry/export, administrators: endpoint, headers
                  kept encrypted, on / off), else the OpenTelemetry environment variables:
                  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (used as is) or OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces),
                  OTEL_EXPORTER_OTLP_[TRACES_]HEADERS ("k=v,k2=v2", values URL-encoded), OTEL_EXPORTER_OTLP_[TRACES_]TIMEOUT
                  (ms), OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, OTEL_SDK_DISABLED, OTEL_TRACES_EXPORTER=none.
                  Only http/json is spoken (another OTEL_EXPORTER_OTLP_PROTOCOL is reported in the status).
                  Disabled unless one of the two names an endpoint.
  routes          (register(), on model_assets.router) GET / PUT /api/model-assets/telemetry/export (administrators),
                  POST /telemetry/export/test (one test span now), POST /telemetry/transform-traces (a build's model
                  calls: kept in <model dir>/traces.jsonl, 7 days / 5,000 lines, and exported), GET /{model_id}/traces
                  (?run=<build id>, ?trace_id=).
  callers         model_worker.serve (Recorder), model_assets._predict_python (test runs), model_deployments.infer
                  (live deployments) and run_model_on_dataset (batch runs) call report(); code_models.instance marks a
                  transform's models, model_lib.LoadedModel / RemoteModel and model_container.ContainerModel record them.
"""

from __future__ import annotations

import atexit
import collections
import contextlib
import contextvars
import json
import logging
import os
import random
import re
import sys
import threading
import time
import uuid
from typing import Any, Callable, Iterator, Optional
from urllib.parse import unquote, urlsplit, urlunsplit

log = logging.getLogger("bluesandai.model_telemetry")

KINDS = {"UNSPECIFIED": 0, "INTERNAL": 1, "SERVER": 2, "CLIENT": 3, "PRODUCER": 4, "CONSUMER": 5}
STATUS = {"UNSET": 0, "OK": 1, "ERROR": 2}
MAX_SPANS = 200
SCOPE = "bluesandai.model"

# the Recorder whose inference call is running in this context (HTTP spans are made only then)
_ACTIVE: contextvars.ContextVar[Optional["Recorder"]] = contextvars.ContextVar("bsai_model_call", default=None)
# without the SDK: (the current span, the list of the call's spans)
_MANUAL: contextvars.ContextVar[Optional[tuple]] = contextvars.ContextVar("bsai_manual_span", default=None)
# inside an instrumented HTTP call (a redirect or a library calling another): no second span
_IN_HTTP: contextvars.ContextVar[bool] = contextvars.ContextVar("bsai_in_http", default=False)


# ------------------------------------------------------------------------------------------------
# spans in a model process
# ------------------------------------------------------------------------------------------------


class _Sdk:
    """The process's OpenTelemetry SDK tracer provider (set once) and the finished spans it collected."""

    lock = threading.Lock()
    tracer: Any = None
    sink: list = []
    tried = False

    @classmethod
    def get(cls, service_name: str) -> Any:
        with cls.lock:
            if cls.tried:
                return cls.tracer
            cls.tried = True
            try:
                from opentelemetry import trace
                from opentelemetry.sdk.resources import Resource
                from opentelemetry.sdk.trace import TracerProvider
                from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
            except ImportError:
                return None
            sink, lock = cls.sink, cls.lock

            class _Collect(SpanExporter):
                def export(self, spans):  # noqa: ANN001
                    with lock:
                        sink.extend(spans)
                        if len(sink) > 20_000:
                            # spans no inference call collects (made outside one) do not pile up
                            del sink[: len(sink) - 10_000]
                    return SpanExportResult.SUCCESS

            provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
            provider.add_span_processor(SimpleSpanProcessor(_Collect()))
            # the global provider, so the adapter's `trace.get_tracer(__name__)` spans nest under the call's span (a
            # provider the code set before keeps its spans; the call's own spans still come here)
            trace.set_tracer_provider(provider)
            cls.tracer = provider.get_tracer(SCOPE)
            return cls.tracer

    @classmethod
    def take(cls, trace_id: Optional[int]) -> list:
        with cls.lock:
            mine = [s for s in cls.sink if s.get_span_context().trace_id == trace_id]
            cls.sink[:] = [s for s in cls.sink if s.get_span_context().trace_id != trace_id]
        return mine


def _hex(n: int, width: int) -> str:
    return format(n, f"0{width}x")


def _new_ids() -> tuple[str, str]:
    return uuid.uuid4().hex, uuid.uuid4().hex[:16]


class Recorder:
    """Spans of inference calls in this process: `with rec.request(id) as box:` runs one call; box["spans"] holds its
    spans (dicts, parents first) when the block ends."""

    def __init__(self, attributes: Optional[dict] = None, service_name: str = "model") -> None:
        self.attributes = {k: v for k, v in (attributes or {}).items() if v is not None}
        self.tracer = _Sdk.get(service_name)
        instrument_http()

    @contextlib.contextmanager
    def request(self, request_id: Optional[str] = None, attributes: Optional[dict] = None, name: str = "model inference",
                kind: str = "SERVER") -> Iterator[dict]:
        box: dict = {"spans": []}
        attrs = {**self.attributes, **(attributes or {})}
        if request_id is not None:
            attrs["request.id"] = request_id or ""
        instrument_http()  # libraries the adapter imported since
        if _ACTIVE.get() is not None:
            # a model called inside another model's call: a child span of that call (which collects it)
            with self.span(name, attrs):
                yield box
            return
        if self.tracer is not None:
            from opentelemetry.trace import SpanKind

            trace_id = None
            try:
                with self.tracer.start_as_current_span(name, kind=getattr(SpanKind, kind, SpanKind.INTERNAL), attributes=attrs) as sp:
                    trace_id = sp.get_span_context().trace_id
                    token = _ACTIVE.set(self)
                    try:
                        yield box
                    finally:
                        _ACTIVE.reset(token)
            finally:
                box["spans"] = _sdk_dicts(_Sdk.take(trace_id)) if trace_id is not None else []
            return
        trace_id, span_id = _new_ids()
        root = {"name": name, "span_id": span_id, "parent_id": None, "trace_id": trace_id, "kind": kind, "start_ns": time.time_ns(),
                "attributes": attrs, "events": [], "status": "UNSET"}
        spans = [root]
        t1, t2 = _MANUAL.set((root, spans)), _ACTIVE.set(self)
        try:
            yield box
        except BaseException as e:  # noqa: BLE001 - recorded on the span, raised again
            root.update(status="ERROR", status_message=f"{type(e).__name__}: {e}"[:500])
            root["events"].append({"name": "exception", "time_ns": time.time_ns(),
                                   "attributes": {"exception.type": type(e).__name__, "exception.message": str(e)[:2000]}})
            raise
        finally:
            _ACTIVE.reset(t2)
            _MANUAL.reset(t1)
            root["end_ns"] = time.time_ns()
            box["spans"] = _manual_dicts(spans)

    @contextlib.contextmanager
    def span(self, name: str, attributes: Optional[dict] = None, kind: str = "INTERNAL") -> Iterator[Any]:
        """A span under the current one (SDK or not)."""
        if self.tracer is not None:
            from opentelemetry.trace import SpanKind

            with self.tracer.start_as_current_span(name, kind=getattr(SpanKind, kind, SpanKind.INTERNAL), attributes=attributes or {}) as sp:
                yield sp
            return
        cur = _MANUAL.get()
        if cur is None:
            yield None
            return
        parent, spans = cur
        d = {"name": name, "span_id": uuid.uuid4().hex[:16], "parent_id": parent["span_id"], "trace_id": parent["trace_id"], "kind": kind,
             "start_ns": time.time_ns(), "attributes": dict(attributes or {}), "events": [], "status": "UNSET"}
        if len(spans) < MAX_SPANS:
            spans.append(d)
        token = _MANUAL.set((d, spans))
        try:
            yield d
        except BaseException as e:  # noqa: BLE001
            d.update(status="ERROR", status_message=f"{type(e).__name__}: {e}"[:500])
            d["attributes"].setdefault("error.type", type(e).__name__)
            raise
        finally:
            _MANUAL.reset(token)
            d["end_ns"] = time.time_ns()


def _attr(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (list, tuple)) and all(isinstance(x, (str, int, float, bool)) for x in v):
        return list(v)
    return str(v)


def _sdk_dicts(finished: list) -> list[dict]:
    """SDK spans as the dicts deployments store: parents before children, times relative to the first span (ms)
    and absolute (ns)."""
    if not finished:
        return []
    by_id = {s.get_span_context().span_id: s for s in finished}

    def depth(s) -> int:  # noqa: ANN001
        n = 0
        while s.parent is not None and s.parent.span_id in by_id and n < 100:
            s, n = by_id[s.parent.span_id], n + 1
        return n

    # a parent before its children even when the clock gives them the same start (Windows' coarse timer)
    spans = sorted(finished, key=lambda s: (s.start_time or 0, depth(s)))[:MAX_SPANS]
    t0 = min(s.start_time for s in spans)
    out = []
    for s in spans:
        ctx = s.get_span_context()
        end = s.end_time or s.start_time
        scope = getattr(s, "instrumentation_scope", None)
        d = {"name": s.name, "span_id": _hex(ctx.span_id, 16), "parent_id": _hex(s.parent.span_id, 16) if s.parent else None,
             "trace_id": _hex(ctx.trace_id, 32), "start_ms": round((s.start_time - t0) / 1e6, 3), "ms": round((end - s.start_time) / 1e6, 3),
             "status": s.status.status_code.name, "attributes": {str(k): _attr(v) for k, v in (s.attributes or {}).items()},
             "events": [{"name": e.name, "ms": round((e.timestamp - t0) / 1e6, 3), "time_ns": e.timestamp,
                         "attributes": {str(k): str(v)[:2000] for k, v in (e.attributes or {}).items()}} for e in s.events][:50],
             "at": t0 / 1e9, "start_ns": s.start_time, "end_ns": end, "kind": getattr(s.kind, "name", "INTERNAL")}
        if s.status.description:
            d["status_message"] = s.status.description[:500]
        if scope is not None and scope.name != SCOPE:
            d["scope"] = scope.name
        out.append(d)
    return out


def _manual_dicts(spans: list[dict]) -> list[dict]:
    t0 = min(s["start_ns"] for s in spans)
    out = []
    for s in spans:
        end = s.get("end_ns") or time.time_ns()
        d = {k: v for k, v in s.items() if k not in ("events",)}
        d.update(end_ns=end, start_ms=round((s["start_ns"] - t0) / 1e6, 3), ms=round((end - s["start_ns"]) / 1e6, 3), at=t0 / 1e9,
                 attributes={str(k): _attr(v) for k, v in s["attributes"].items()},
                 events=[{**e, "ms": round((e["time_ns"] - t0) / 1e6, 3)} for e in s.get("events") or []])
        out.append(d)
    return out


# ------------------------------------------------------------------------------------------------
# outbound HTTP requests of a model (instead of opentelemetry-instrumentation)
# ------------------------------------------------------------------------------------------------


def _url_attrs(method: str, url: str) -> dict:
    attrs: dict[str, Any] = {"http.request.method": (method or "GET").upper()}
    try:
        u = urlsplit(str(url))
        host = u.hostname or ""
        netloc = host if ":" not in host else f"[{host}]"
        if u.port:
            netloc += f":{u.port}"
        # the query string and user info can hold credentials: left out
        attrs["url.full"] = urlunsplit((u.scheme, netloc, u.path, "", ""))
        attrs["server.address"] = host
        port = u.port or {"https": 443, "http": 80}.get(u.scheme)
        if port:
            attrs["server.port"] = port
        if u.scheme:
            attrs["url.scheme"] = u.scheme
    except ValueError:
        attrs["url.full"] = "?"
    return attrs


class _Http:
    """The CLIENT span of one request: `traceparent` for its header, status() with the response code."""

    def __init__(self, span: Any, manual: Optional[dict], traceparent: str) -> None:
        self.span, self.manual, self.traceparent = span, manual, traceparent

    def status(self, code: Optional[int]) -> None:
        if code is None:
            return
        code = int(code)
        if self.span is not None:
            self.span.set_attribute("http.response.status_code", code)
            if code >= 400:
                from opentelemetry.trace import Status, StatusCode

                self.span.set_attribute("error.type", str(code))
                self.span.set_status(Status(StatusCode.ERROR, f"HTTP {code}"))
        elif self.manual is not None:
            self.manual["attributes"]["http.response.status_code"] = code
            if code >= 400:
                self.manual["attributes"]["error.type"] = str(code)
                self.manual.update(status="ERROR", status_message=f"HTTP {code}")


@contextlib.contextmanager
def _client_span(method: str, url: str) -> Iterator[Optional[_Http]]:
    rec = _ACTIVE.get()
    if rec is None or _IN_HTTP.get():
        yield None
        return
    token = _IN_HTTP.set(True)
    try:
        attrs = _url_attrs(method, url)
        with rec.span(f"HTTP {attrs['http.request.method']}", attrs, kind="CLIENT") as sp:
            if sp is None:
                yield None
            elif isinstance(sp, dict):
                yield _Http(None, sp, f"00-{sp['trace_id']}-{sp['span_id']}-01")
            else:
                ctx = sp.get_span_context()
                yield _Http(sp, None, f"00-{_hex(ctx.trace_id, 32)}-{_hex(ctx.span_id, 16)}-{int(ctx.trace_flags):02x}")
    finally:
        _IN_HTTP.reset(token)


_PATCHED: set = set()


def instrument_http() -> None:
    """Instrument the HTTP clients loaded in this process (idempotent; libraries imported later on the next call)."""
    if "urllib" not in _PATCHED:
        _PATCHED.add("urllib")
        _patch_urllib()
    if "requests" not in _PATCHED and "requests" in sys.modules:
        _PATCHED.add("requests")
        _patch_requests()
    if "httpx" not in _PATCHED and "httpx" in sys.modules:
        _PATCHED.add("httpx")
        _patch_httpx()


def _patch_urllib() -> None:
    import urllib.error
    import urllib.request

    orig = urllib.request.OpenerDirector.open

    def open(self, fullurl, data=None, *args, **kwargs):  # noqa: A001, ANN001
        if _ACTIVE.get() is None or _IN_HTTP.get():
            return orig(self, fullurl, data, *args, **kwargs)
        req = fullurl if isinstance(fullurl, urllib.request.Request) else urllib.request.Request(fullurl, data)
        if data is not None:
            req.data = data
        with _client_span(req.get_method(), req.full_url) as h:
            if h is None:
                return orig(self, req, None, *args, **kwargs)
            req.add_header("Traceparent", h.traceparent)
            try:
                resp = orig(self, req, None, *args, **kwargs)
            except urllib.error.HTTPError as e:
                h.status(e.code)
                raise
            h.status(getattr(resp, "status", None) or resp.getcode())
            return resp

    open._bsai = True  # type: ignore[attr-defined]
    urllib.request.OpenerDirector.open = open  # type: ignore[method-assign]


def _patch_requests() -> None:
    try:
        import requests.sessions
    except Exception:  # noqa: BLE001
        return
    orig = requests.sessions.Session.send

    def send(self, request, **kwargs):  # noqa: ANN001
        if _ACTIVE.get() is None or _IN_HTTP.get():
            return orig(self, request, **kwargs)
        with _client_span(request.method or "GET", request.url) as h:
            if h is None:
                return orig(self, request, **kwargs)
            request.headers["traceparent"] = h.traceparent
            resp = orig(self, request, **kwargs)
            h.status(resp.status_code)
            return resp

    requests.sessions.Session.send = send  # type: ignore[method-assign]


def _patch_httpx() -> None:
    try:
        import httpx
    except Exception:  # noqa: BLE001
        return
    orig, orig_async = httpx.Client.send, httpx.AsyncClient.send

    def send(self, request, **kwargs):  # noqa: ANN001
        if _ACTIVE.get() is None or _IN_HTTP.get():
            return orig(self, request, **kwargs)
        with _client_span(request.method, str(request.url)) as h:
            if h is None:
                return orig(self, request, **kwargs)
            request.headers["traceparent"] = h.traceparent
            resp = orig(self, request, **kwargs)
            h.status(resp.status_code)
            return resp

    async def send_async(self, request, **kwargs):  # noqa: ANN001
        if _ACTIVE.get() is None or _IN_HTTP.get():
            return await orig_async(self, request, **kwargs)
        with _client_span(request.method, str(request.url)) as h:
            if h is None:
                return await orig_async(self, request, **kwargs)
            request.headers["traceparent"] = h.traceparent
            resp = await orig_async(self, request, **kwargs)
            h.status(resp.status_code)
            return resp

    httpx.Client.send = send  # type: ignore[method-assign]
    httpx.AsyncClient.send = send_async  # type: ignore[method-assign]


# ------------------------------------------------------------------------------------------------
# models called inside a transform
# ------------------------------------------------------------------------------------------------

MAX_TRANSFORM_TRACES = 500
_TRACE_ATTR = "_pm_trace"


def _model_attrs(spec: dict) -> dict:
    return {"model.rid": spec.get("rid") or "", "model.version": spec.get("version") or "", "model.name": spec.get("model") or ""}


def trace_model(obj: Any, spec: Optional[dict]) -> Any:
    """Mark a model a transform received: its calls are recorded and reported (never raises)."""
    try:
        spec = spec or {}
        info = {**_model_attrs(spec), "version_rid": spec.get("version_rid") or "", "label": spec.get("label") or "",
                "param": spec.get("param") or "", "run": spec.get("run") or ""}
        obj.__dict__[_TRACE_ATTR] = info
    except Exception:  # noqa: BLE001
        pass
    return obj


def traced(obj: Any) -> Optional[dict]:
    try:
        return obj.__dict__.get(_TRACE_ATTR)
    except Exception:  # noqa: BLE001
        return None


_TRANSFORM_RECORDER: list = []


@contextlib.contextmanager
def model_call(obj: Any, method: str) -> Iterator[None]:
    """One call of a transform's model (LoadedModel / ContainerModel): its spans are reported when it ends."""
    info = traced(obj)
    cm = box = None
    if info and _ACTIVE.get() is None:
        # (a model called inside another model's call is part of that call's trace)
        try:
            if not _TRANSFORM_RECORDER:
                _TRANSFORM_RECORDER.append(Recorder({}, service_name="transform"))
            cm = _TRANSFORM_RECORDER[0].request(None, attributes={"model.rid": info["model.rid"], "model.version": info["model.version"],
                                                                  "model.name": info["model.name"], "model.method": method,
                                                                  **({"transform.run_id": info["run"]} if info.get("run") else {}),
                                                                  **({"model.input": info["param"]} if info.get("param") else {}),
                                                                  **_run_context_attrs()}, kind="INTERNAL")
            box = cm.__enter__()
        except Exception:  # noqa: BLE001 - telemetry never fails the call
            cm = None
    if cm is None:
        yield
        return
    started = time.monotonic()
    try:
        yield
    except BaseException:
        with contextlib.suppress(BaseException):
            cm.__exit__(*sys.exc_info())  # the span records the error
        with contextlib.suppress(Exception):
            REPORTER.add(info, box["spans"], False, int((time.monotonic() - started) * 1000))
        raise
    with contextlib.suppress(Exception):
        cm.__exit__(None, None, None)
        REPORTER.add(info, box["spans"], True, int((time.monotonic() - started) * 1000))


CALLS = ("transform", "predict", "transform_write", "run_inference")


def wrap_method(obj: Any, name: str, fn: Any) -> Any:
    """`fn` (the adapter's `name`, as LoadedModel / ContainerModel hand it out) recorded when `obj` is a transform's
    traced model and `name` is an inference method; else `fn` itself."""
    if name not in CALLS or not callable(fn) or not traced(obj):
        return fn

    def call(*args, **kwargs):  # noqa: ANN002, ANN003
        with model_call(obj, name):
            return fn(*args, **kwargs)

    call.__name__ = getattr(fn, "__name__", name)
    call.__doc__ = getattr(fn, "__doc__", None)
    call.__wrapped__ = fn  # type: ignore[attr-defined]
    return call


def report_remote(obj: Any, spans: Optional[list], ok: bool, ms: Optional[int] = None) -> None:
    """Spans a transform's sidecar model process returned (RemoteModel)."""
    info = traced(obj)
    if info and spans:
        with contextlib.suppress(Exception):
            REPORTER.add(info, spans, ok, ms)


_RUN: dict = {}


def _run_context() -> dict:
    """The transform this runner process builds (its spec.json), read once."""
    if not _RUN:
        _RUN["ctx"] = {}
        try:
            arg = sys.argv[1] if len(sys.argv) > 1 else ""
            if arg.endswith("spec.json") and os.path.exists(arg):
                with open(arg, encoding="utf-8") as f:
                    spec = json.load(f)
                _RUN["ctx"] = {"transform": str(spec.get("transform") or ""), "mode": str(spec.get("mode") or "")}
        except Exception:  # noqa: BLE001
            pass
        res = os.environ.get("BLUESANDAI_USAGE_RESOURCE") or ""
        if res.startswith("code_repo:"):
            _RUN["ctx"]["repo"] = res[len("code_repo:"):]
    return _RUN["ctx"]


def _run_context_attrs() -> dict:
    ctx = _run_context()
    return {f"transform.{k}": v for k, v in ctx.items() if v}


class _Reporter:
    """Traces of a transform's model calls, posted to the platform in the background (and when the process ends)."""

    def __init__(self) -> None:
        self.buf: list[dict] = []
        self.lock = threading.Lock()
        self.send_lock = threading.Lock()
        self.wake = threading.Event()
        self.accepted = 0
        self.dropped = 0
        self.sent = 0
        self.failed = 0
        self.thread: Optional[threading.Thread] = None
        self._atexit = False

    def add(self, info: dict, spans: list, ok: bool, ms: Optional[int]) -> None:
        if not spans:
            return
        with self.lock:
            if self.accepted >= MAX_TRANSFORM_TRACES:
                self.dropped += 1
                return
            self.accepted += 1
            self.buf.append({"rid": info.get("model.rid"), "version": info.get("model.version"), "version_rid": info.get("version_rid"),
                             "label": info.get("label"), "param": info.get("param"), "run": info.get("run"), **_run_context(), "ok": bool(ok), "ms": ms,
                             "spans": spans[:MAX_SPANS]})
            if self.thread is None:
                self.thread = threading.Thread(target=self._loop, name="model-telemetry-report", daemon=True)
                self.thread.start()
            if not self._atexit:
                self._atexit = True
                atexit.register(self.flush, 5.0)
            if len(self.buf) >= 50:
                self.wake.set()

    def _loop(self) -> None:
        while True:
            self.wake.wait(2.0)
            self.wake.clear()
            self.flush(30.0)

    def flush(self, timeout: float = 10.0) -> None:
        deadline = time.monotonic() + timeout
        if not self.send_lock.acquire(timeout=max(0.0, timeout)):
            return
        try:
            while True:
                with self.lock:
                    batch, self.buf = self.buf[:100], self.buf[100:]
                    dropped = self.dropped
                if not batch:
                    return
                sent = False
                for attempt in range(3):
                    if self._post({"traces": batch, "dropped": dropped}, max(0.5, deadline - time.monotonic())):
                        sent = True
                        break
                    if attempt == 2 or time.monotonic() + 0.5 * (attempt + 1) >= deadline:
                        break
                    time.sleep(0.5 * (attempt + 1))
                if sent:
                    self.sent += len(batch)
                    with self.lock:
                        self.dropped -= dropped
                else:
                    self.failed += len(batch)
                if time.monotonic() >= deadline:
                    return
        finally:
            self.send_lock.release()

    @staticmethod
    def _post(body: dict, timeout: float) -> bool:
        import urllib.request

        url = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000").rstrip("/") + "/api/model-assets/telemetry/transform-traces"
        token = os.environ.get("BLUESANDAI_API_TOKEN")
        req = urllib.request.Request(url, data=json.dumps(body, default=str).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
        try:
            with urllib.request.urlopen(req, timeout=min(30.0, timeout)) as r:  # noqa: S310 - this platform's own API
                return 200 <= r.status < 300
        except Exception as e:  # noqa: BLE001
            log.debug("transform model traces not reported: %s", e)
            return False


REPORTER = _Reporter()


# ------------------------------------------------------------------------------------------------
# OTLP/HTTP JSON export (the API process)
# ------------------------------------------------------------------------------------------------


_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_HEX16 = re.compile(r"^[0-9a-f]{16}$")


def any_value(v: Any) -> dict:
    """An OTLP AnyValue (JSON mapping: 64-bit integers as strings)."""
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [any_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"kvlistValue": {"values": key_values(v)}}
    return {"stringValue": "" if v is None else str(v)}


def key_values(d: dict) -> list[dict]:
    return [{"key": str(k), "value": any_value(v)} for k, v in d.items() if v is not None]


def _times(d: dict) -> tuple[int, int]:
    if d.get("start_ns"):
        start = int(d["start_ns"])
        return start, max(start, int(d.get("end_ns") or start))
    base = float(d.get("at") or time.time())
    start = int(round((base + float(d.get("start_ms") or 0) / 1000) * 1e9))
    return start, start + int(round(float(d.get("ms") or 0) * 1e6))


def otlp_span(d: dict) -> Optional[dict]:
    """A stored span dict as an OTLP Span (None when its ids are not valid)."""
    tid, sid = str(d.get("trace_id") or "").lower(), str(d.get("span_id") or "").lower()
    if not _HEX32.match(tid) or not _HEX16.match(sid) or tid == "0" * 32 or sid == "0" * 16:
        return None
    start, end = _times(d)
    out: dict[str, Any] = {"traceId": tid, "spanId": sid, "name": str(d.get("name") or "span")[:500],
                           "kind": KINDS.get(str(d.get("kind") or "INTERNAL").upper(), 1),
                           "startTimeUnixNano": str(start), "endTimeUnixNano": str(end),
                           "attributes": key_values(d.get("attributes") or {})}
    pid = str(d.get("parent_id") or "").lower()
    if _HEX16.match(pid):
        out["parentSpanId"] = pid
    events = []
    for e in d.get("events") or []:
        t = int(e["time_ns"]) if e.get("time_ns") else int(round((float(d.get("at") or start / 1e9)) * 1e9 + float(e.get("ms") or 0) * 1e6))
        events.append({"timeUnixNano": str(t), "name": str(e.get("name") or "event"), "attributes": key_values(e.get("attributes") or {})})
    if events:
        out["events"] = events
    code = STATUS.get(str(d.get("status") or "UNSET").upper(), 0)
    out["status"] = {"code": code, **({"message": str(d.get("status_message"))} if code == 2 and d.get("status_message") else {})}
    return out


def otlp_request(groups: list[tuple[dict, list[dict]]]) -> dict:
    """An ExportTraceServiceRequest: one ResourceSpans per resource, one ScopeSpans per instrumentation scope."""
    by_res: dict[str, tuple[dict, dict[str, list]]] = {}
    for resource, spans in groups:
        key = json.dumps(resource, sort_keys=True, default=str)
        _, scopes = by_res.setdefault(key, (resource, {}))
        for d in spans:
            s = otlp_span(d)
            if s is not None:
                scopes.setdefault(str(d.get("scope") or SCOPE), []).append(s)
    return {"resourceSpans": [{"resource": {"attributes": key_values(res)},
                               "scopeSpans": [{"scope": {"name": name}, "spans": spans} for name, spans in scopes.items()]}
                              for res, scopes in by_res.values() if scopes]}


def parse_headers(text: Optional[str]) -> dict[str, str]:
    """OTEL_EXPORTER_OTLP_HEADERS: "key1=value1,key2=value2", values URL-encoded."""
    out = {}
    for part in (text or "").split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = unquote(k.strip()), unquote(v.strip())
        if re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+", k) and "\r" not in v and "\n" not in v:
            out[k] = v
    return out


def _resource_env() -> dict:
    return {k: v for k, v in parse_headers(os.environ.get("OTEL_RESOURCE_ATTRIBUTES")).items()}


RETRYABLE = {429, 502, 503, 504}


class OtlpExporter:
    """Batches spans in the background and posts them; submit() never waits on the network."""

    def __init__(self, endpoint: str, headers: Optional[dict] = None, timeout_s: float = 10.0, *, max_queue: int = 2048,
                 max_batch: int = 512, delay_s: float = 1.0, max_attempts: int = 5, backoff_s: float = 0.5, max_backoff_s: float = 10.0,
                 check: Optional[Callable[[str], None]] = None) -> None:
        self.endpoint, self.headers, self.timeout_s = endpoint, dict(headers or {}), float(timeout_s)
        self.max_queue, self.max_batch, self.delay_s = max_queue, max_batch, delay_s
        self.max_attempts, self.backoff_s, self.max_backoff_s = max_attempts, backoff_s, max_backoff_s
        self.check = check if check is not None else _egress_check
        self.q: collections.deque = collections.deque()
        self.cv = threading.Condition()
        self.stop_ev = threading.Event()
        self.inflight = 0
        self.stats = {"exported": 0, "dropped": 0, "failed": 0, "rejected": 0, "retries": 0, "requests": 0, "last_error": None,
                      "last_success_at": None}
        self.thread = threading.Thread(target=self._run, name="otlp-export", daemon=True)
        self.thread.start()

    def submit(self, resource: dict, spans: list[dict]) -> None:
        with self.cv:
            for d in spans:
                if len(self.q) >= self.max_queue:
                    self.q.popleft()
                    self.stats["dropped"] += 1
                self.q.append((resource, d))
            self.cv.notify()

    def _take(self) -> list:
        with self.cv:
            while not self.q and not self.stop_ev.is_set():
                self.cv.wait(1.0)
            if self.stop_ev.is_set():
                return []
            # a batch: full, or the spans of the last delay_s
            first = time.monotonic()
            while len(self.q) < self.max_batch and time.monotonic() - first < self.delay_s and not self.stop_ev.is_set():
                self.cv.wait(self.delay_s - (time.monotonic() - first))
            batch = [self.q.popleft() for _ in range(min(len(self.q), self.max_batch))]
            self.inflight = len(batch)
            return batch

    def _run(self) -> None:
        while not self.stop_ev.is_set():
            batch = self._take()
            if not batch:
                continue
            try:
                self._send(batch)
            except Exception as e:  # noqa: BLE001
                self.stats["failed"] += len(batch)
                self.stats["last_error"] = f"{type(e).__name__}: {e}"[:500]
            finally:
                with self.cv:
                    self.inflight = 0
                    self.cv.notify_all()

    def _send(self, batch: list) -> None:
        groups: dict[str, tuple[dict, list]] = {}
        for res, d in batch:
            groups.setdefault(json.dumps(res, sort_keys=True, default=str), (res, []))[1].append(d)
        req = otlp_request(list(groups.values()))
        n = sum(len(ss["spans"]) for rs in req["resourceSpans"] for ss in rs["scopeSpans"])
        self.stats["invalid"] = self.stats.get("invalid", 0) + len(batch) - n  # spans without valid ids are not sent
        if not n:
            return
        body = json.dumps(req, separators=(",", ":")).encode()
        for attempt in range(1, self.max_attempts + 1):
            if self.stop_ev.is_set():
                self.stats["failed"] += n
                return
            wait = None
            try:
                self.check(self.endpoint)
            except Exception as e:  # noqa: BLE001 - egress refused: not retried
                self.stats["failed"] += n
                self.stats["last_error"] = f"egress: {e}"[:500]
                return
            try:
                status, text, retry_after = self._post(body)
            except Exception as e:  # noqa: BLE001 - connection refused, DNS, timeout: retried
                status, text, retry_after = None, f"{type(e).__name__}: {e}", None
            self.stats["requests"] += 1
            if status is not None and 200 <= status < 300:
                rejected = 0
                with contextlib.suppress(Exception):
                    rejected = int(((json.loads(text) if text.strip() else {}).get("partialSuccess") or {}).get("rejectedSpans") or 0)
                self.stats["exported"] += n - rejected
                self.stats["rejected"] += rejected
                self.stats["last_success_at"] = time.time()
                return
            self.stats["last_error"] = (f"HTTP {status}: {text[:300]}" if status is not None else text)[:500]
            if status is not None and status not in RETRYABLE:
                self.stats["failed"] += n
                return
            if attempt == self.max_attempts:
                break
            self.stats["retries"] += 1
            wait = min(self.max_backoff_s, self.backoff_s * (2 ** (attempt - 1))) * (0.8 + 0.4 * random.random())
            if retry_after is not None:
                wait = min(max(retry_after, 0.0), 30.0)
            if self.stop_ev.wait(wait):
                break
        self.stats["failed"] += n

    def _post(self, body: bytes) -> tuple[int, str, Optional[float]]:
        import httpx

        scope = contextlib.nullcontext()
        with contextlib.suppress(Exception):
            import network

            scope = network.egress_scope("The OpenTelemetry export")
        with scope, httpx.Client(timeout=self.timeout_s, follow_redirects=False) as client:
            r = client.post(self.endpoint, content=body, headers={**self.headers, "Content-Type": "application/json"})
        ra = r.headers.get("retry-after")
        retry_after = float(ra) if ra and re.fullmatch(r"\d+(\.\d+)?", ra.strip()) else None
        return r.status_code, r.text[:2000], retry_after

    def flush(self, timeout: float = 10.0) -> bool:
        """Wait until the queue is sent (tests, shutdown)."""
        deadline = time.monotonic() + timeout
        with self.cv:
            self.cv.notify_all()
            while (self.q or self.inflight) and time.monotonic() < deadline:
                self.cv.wait(min(0.1, max(0.0, deadline - time.monotonic())))
            return not self.q and not self.inflight

    def close(self) -> None:
        self.stop_ev.set()
        with self.cv:
            self.cv.notify_all()


def _egress_check(url: str) -> None:
    """The egress policies (when enforced) must allow the collector."""
    u = urlsplit(url)
    try:
        import network
    except Exception:  # noqa: BLE001 - outside the API
        return
    network.check_egress(u.hostname, u.port or (443 if u.scheme == "https" else 80), "The OpenTelemetry export")


# -- configuration --------------------------------------------------------------------------------

_STATE: dict = {"key": None, "exporter": None, "config": None, "file_mtime": None, "file": None}
_STATE_LOCK = threading.Lock()


def settings_path():
    import model_assets

    return model_assets.DIR / "telemetry-export.json"


def read_setting() -> dict:
    """The platform setting: {"enabled", "endpoint", "headers" (sealed hex), "header_names", "updated_at", "updated_by"}."""
    try:
        p = settings_path()
        mtime = p.stat().st_mtime if p.exists() else None
    except Exception:  # noqa: BLE001
        return {}
    if mtime != _STATE["file_mtime"]:
        try:
            _STATE["file"] = json.loads(p.read_text("utf-8")) if mtime else {}
        except (OSError, ValueError):
            _STATE["file"] = {}
        _STATE["file_mtime"] = mtime
    return dict(_STATE["file"] or {})


def _setting_headers(s: dict) -> dict:
    if not s.get("headers"):
        return {}
    try:
        import secretbox

        return secretbox.unseal(bytes.fromhex(s["headers"]))
    except Exception:  # noqa: BLE001
        return {}


def endpoint_from_env() -> Optional[str]:
    t = (os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or "").strip()
    if t:
        return t
    base = (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if base:
        return base.rstrip("/") + "/v1/traces"
    return None


def config() -> dict:
    """The effective export configuration: {"enabled", "endpoint", "headers", "timeout_s", "source", "problem"}."""
    env_disabled = (os.environ.get("OTEL_SDK_DISABLED") or "").strip().lower() == "true" or \
        ((os.environ.get("OTEL_TRACES_EXPORTER") or "").strip() and "otlp" not in (os.environ.get("OTEL_TRACES_EXPORTER") or "").lower())
    s = read_setting()
    problem = None
    if s.get("endpoint") or s.get("enabled") is False:
        endpoint = s.get("endpoint") or None
        headers = _setting_headers(s)
        enabled = bool(s.get("enabled", True)) and bool(endpoint)
        source = "setting"
    else:
        endpoint = endpoint_from_env()
        headers = {**parse_headers(os.environ.get("OTEL_EXPORTER_OTLP_HEADERS")), **parse_headers(os.environ.get("OTEL_EXPORTER_OTLP_TRACES_HEADERS"))}
        enabled = bool(endpoint) and not env_disabled
        source = "environment" if endpoint else None
    try:
        timeout_ms = float(os.environ.get("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT") or os.environ.get("OTEL_EXPORTER_OTLP_TIMEOUT") or 10000)
    except ValueError:
        timeout_ms = 10000.0
    proto = (os.environ.get("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL") or os.environ.get("OTEL_EXPORTER_OTLP_PROTOCOL") or "").strip()
    if proto and proto != "http/json":
        problem = f"OTEL_EXPORTER_OTLP_PROTOCOL={proto}: only http/json is sent"
    if endpoint:
        u = urlsplit(endpoint)
        if u.scheme not in ("http", "https") or not u.hostname:
            problem, enabled = f"{endpoint} is not an http(s) URL", False
    return {"enabled": enabled, "endpoint": endpoint, "headers": headers, "timeout_s": max(0.1, timeout_ms / 1000), "source": source, "problem": problem}


def exporter() -> Optional[OtlpExporter]:
    """The exporter of the current configuration (made again when it changes); None when export is off."""
    cfg = config()
    key = json.dumps([cfg["enabled"], cfg["endpoint"], cfg["headers"], cfg["timeout_s"]], sort_keys=True)
    with _STATE_LOCK:
        if key != _STATE["key"]:
            old = _STATE["exporter"]
            _STATE.update(key=key, config=cfg, exporter=OtlpExporter(cfg["endpoint"], cfg["headers"], cfg["timeout_s"]) if cfg["enabled"] else None)
            if old is not None:
                # what it still holds goes out in the background (callers never wait)
                threading.Thread(target=lambda o=old: (o.flush(5.0), o.close()), daemon=True).start()
        return _STATE["exporter"]


def resource_for(model: dict, source: str, extra: Optional[dict] = None) -> dict:
    name = model.get("model.name") or model.get("model") or ""
    res = {**_resource_env(), "service.name": os.environ.get("OTEL_SERVICE_NAME") or f"model:{name}", "service.namespace": "bluesandai",
           "telemetry.sdk.name": "bluesandai", "telemetry.sdk.language": "python",
           "model.name": name, "model.rid": model.get("model.rid") or model.get("rid") or "",
           "model.version": model.get("model.version") or model.get("version") or "", "bluesandai.source": source}
    res.update({k: v for k, v in (extra or {}).items() if v not in (None, "")})
    return res


def report(spans: Optional[list], model: dict, source: str, extra: Optional[dict] = None) -> None:
    """Export one call's spans (the API process); returns at once and never raises."""
    if not spans:
        return
    try:
        exp = exporter()
        if exp is not None:
            # what the caller does not know comes from the request span's attributes (model.name, model.rid, …)
            first = (spans[0].get("attributes") or {}) if isinstance(spans[0], dict) else {}
            model = {**{k: first[k] for k in ("model.name", "model.rid", "model.version") if first.get(k)},
                     **{k: v for k, v in (model or {}).items() if v}}
            exp.submit(resource_for(model, source, extra), list(spans))
    except Exception:  # noqa: BLE001
        log.debug("model spans not exported", exc_info=True)


def status() -> dict:
    cfg = config()
    exp = _STATE["exporter"] if _STATE["key"] else None
    return {"enabled": cfg["enabled"], "endpoint": cfg["endpoint"], "source": cfg["source"], "problem": cfg["problem"],
            "header_names": sorted(cfg["headers"]), "queued": len(exp.q) if exp else 0, **(dict(exp.stats) if exp else {})}


def test_export(timeout_s: float = 10.0) -> dict:
    """Send one test span to the configured collector now (one attempt) and say what happened."""
    cfg = config()
    if not cfg["endpoint"]:
        raise ValueError("no collector endpoint is configured")
    exp = OtlpExporter(cfg["endpoint"], cfg["headers"], min(cfg["timeout_s"], timeout_s), max_attempts=1, delay_s=0.0)
    try:
        tid, sid = _new_ids()
        now = time.time_ns()
        exp.submit(resource_for({"model.name": "telemetry test"}, "test"),
                   [{"name": "telemetry export test", "trace_id": tid, "span_id": sid, "kind": "INTERNAL", "start_ns": now, "end_ns": now + 1_000_000,
                     "attributes": {"bluesandai.test": True}, "status": "OK"}])
        exp.flush(timeout_s + 2)
        st = dict(exp.stats)
    finally:
        exp.close()
    return {"ok": st["exported"] == 1, "endpoint": cfg["endpoint"], "trace_id": tid, "error": None if st["exported"] == 1 else st["last_error"]}


# -- the API (routes on model_assets.router) -------------------------------------------------------

TRACE_DAYS = 7
MAX_TRACE_LINES = 5000
MAX_POSTED_TRACES = 100
_TRACES_LOCK = threading.Lock()


def _traces_path(model_id: str):
    import model_assets

    return model_assets.DIR / model_id / "traces.jsonl"


def _clean_span(d: Any) -> Optional[dict]:
    """A span a transform posted, reduced to the stored fields (None when it is not one)."""
    if not isinstance(d, dict) or not _HEX32.match(str(d.get("trace_id") or "")) or not _HEX16.match(str(d.get("span_id") or "")):
        return None
    out: dict[str, Any] = {"name": str(d.get("name") or "span")[:500], "trace_id": d["trace_id"], "span_id": d["span_id"],
                           "parent_id": d["parent_id"] if _HEX16.match(str(d.get("parent_id") or "")) else None,
                           "kind": str(d.get("kind") or "INTERNAL").upper() if str(d.get("kind") or "INTERNAL").upper() in KINDS else "INTERNAL",
                           "status": str(d.get("status") or "UNSET").upper() if str(d.get("status") or "UNSET").upper() in STATUS else "UNSET",
                           "attributes": {str(k)[:200]: _attr(v) if not isinstance(v, str) else v[:4000]
                                          for k, v in list((d.get("attributes") or {}).items())[:100]} if isinstance(d.get("attributes"), dict) else {},
                           "events": [e for e in (d.get("events") or [])[:50] if isinstance(e, dict)] if isinstance(d.get("events"), list) else []}
    for k in ("start_ms", "ms", "at", "start_ns", "end_ns"):
        if isinstance(d.get(k), (int, float)) and not isinstance(d.get(k), bool):
            out[k] = d[k]
    if d.get("status_message"):
        out["status_message"] = str(d["status_message"])[:500]
    if d.get("scope"):
        out["scope"] = str(d["scope"])[:200]
    return out


def _append_traces(model_id: str, rows: list[dict]) -> None:
    p = _traces_path(model_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    with _TRACES_LOCK:
        with open(p, "a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, default=str) + "\n")
        try:
            lines = p.read_text("utf-8").splitlines()
        except OSError:
            return
        cutoff = time.time() - TRACE_DAYS * 86400
        keep = [ln for ln in lines if ln.strip() and _line_time(ln) >= cutoff][-MAX_TRACE_LINES:]
        if len(keep) != len(lines):
            tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
            tmp.write_text("".join(ln + "\n" for ln in keep), "utf-8")
            os.replace(tmp, p)


def _line_time(line: str) -> float:
    try:
        return float(json.loads(line).get("ts") or 0)
    except (ValueError, AttributeError):
        return 0.0


def accept_transform_traces(body: dict) -> dict:
    """POST /telemetry/transform-traces: the traces a transform's model calls made, kept with each model (the caller
    must see the model) and exported."""
    import model_assets
    from fastapi import HTTPException

    traces = body.get("traces") if isinstance(body, dict) else None
    if not isinstance(traces, list):
        raise HTTPException(400, "traces: a list is expected")
    if len(traces) > MAX_POSTED_TRACES:
        raise HTTPException(413, f"at most {MAX_POSTED_TRACES} traces per request")
    by_model: dict[str, list[dict]] = {}
    refused: list[dict] = []
    recs: dict[str, Any] = {}
    now = time.time()
    for t in traces:
        if not isinstance(t, dict):
            continue
        rid = str(t.get("rid") or "")
        if rid not in recs:
            try:
                recs[rid] = model_assets.by_rid(rid)
            except HTTPException as e:
                recs[rid] = None
                refused.append({"rid": rid, "error": str(e.detail)[:300]})
        rec = recs[rid]
        if rec is None:
            continue
        spans = [s for s in (_clean_span(x) for x in (t.get("spans") or [])[:MAX_SPANS]) if s is not None]
        if not spans:
            continue
        row = {"ts": now, "at": datetime_iso(now), "source": "transform", "trace_id": spans[0]["trace_id"], "ok": bool(t.get("ok")),
               "ms": t.get("ms") if isinstance(t.get("ms"), (int, float)) else None, "version": str(t.get("version") or "")[:100],
               "run": str(t.get("run") or "")[:100], "transform": str(t.get("transform") or "")[:500], "mode": str(t.get("mode") or "")[:20],
               "repo": str(t.get("repo") or "")[:100], "input": str(t.get("param") or "")[:200], "user": _actor(), "spans": spans}
        by_model.setdefault(rec["id"], []).append(row)
        report(spans, {"model.name": rec.get("name"), "model.rid": rec.get("rid"), "model.version": row["version"]}, "transform",
               {"bluesandai.run.id": row["run"], "bluesandai.transform": row["transform"], "bluesandai.repository": row["repo"]})
    for mid, rows in by_model.items():
        _append_traces(mid, rows)
    return {"accepted": sum(len(v) for v in by_model.values()), "refused": refused}


def datetime_iso(ts: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds")


def _actor() -> Optional[str]:
    try:
        import auth

        return auth.actor_id()
    except Exception:  # noqa: BLE001
        return None


def model_traces(model_id: str, limit: int = 100, run: Optional[str] = None, trace_id: Optional[str] = None) -> list[dict]:
    """GET /{model_id}/traces: the model's calls in transforms, newest first (a run's, or one trace)."""
    import model_assets

    model_assets._get(model_id)
    p = _traces_path(model_id)
    if not p.exists():
        return []
    out = []
    for ln in reversed(p.read_text("utf-8").splitlines()):
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        if run and r.get("run") != run:
            continue
        if trace_id and r.get("trace_id") != trace_id:
            continue
        out.append(r)
        if len(out) >= max(1, min(int(limit), 1000)):
            break
    return out


def export_setting_view() -> dict:
    s = read_setting()
    return {**status(), "setting": {"enabled": s.get("enabled"), "endpoint": s.get("endpoint"), "header_names": s.get("header_names") or [],
                                    "updated_at": s.get("updated_at"), "updated_by": s.get("updated_by")} if s else None,
            "env_endpoint": endpoint_from_env()}


def save_export_setting(body: dict) -> dict:
    """PUT /telemetry/export: {"enabled", "endpoint", "headers" ({name: value}; omitted keeps the stored ones; a value
    of null drops one), "clear" (back to the environment variables)}."""
    from fastapi import HTTPException

    p = settings_path()
    if body.get("clear"):
        with contextlib.suppress(FileNotFoundError):
            p.unlink()
        _STATE["file_mtime"] = "cleared"
        return export_setting_view()
    old = read_setting()
    endpoint = str(body.get("endpoint") if body.get("endpoint") is not None else old.get("endpoint") or "").strip()
    if endpoint:
        u = urlsplit(endpoint)
        if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
            raise HTTPException(400, "endpoint: an http(s) URL without user info, e.g. http://collector:4318/v1/traces")
    enabled = bool(body.get("enabled", old.get("enabled", True)))
    if enabled and not endpoint:
        raise HTTPException(400, "endpoint: enter the collector's OTLP/HTTP traces URL to turn the export on")
    headers = _setting_headers(old)
    if isinstance(body.get("headers"), dict):
        for k, v in body["headers"].items():
            k = str(k).strip()
            if not re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+", k):
                raise HTTPException(400, f"header name {k!r} is not valid")
            if v is None:
                headers.pop(k, None)
                continue
            v = str(v)
            if "\r" in v or "\n" in v:
                raise HTTPException(400, f"header {k}: a value on one line is expected")
            headers[k] = v
    elif body.get("headers") is not None:
        raise HTTPException(400, "headers: an object {name: value} is expected")
    sealed = None
    if headers:
        import secretbox

        sealed = secretbox.seal(headers).hex()
    rec = {"enabled": enabled, "endpoint": endpoint or None, "headers": sealed, "header_names": sorted(headers),
           "updated_at": datetime_iso(time.time()), "updated_by": _actor()}
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(rec, indent=1), "utf-8")
    os.replace(tmp, p)
    _STATE["file_mtime"] = "changed"  # read again even when the clock gives the same mtime
    exporter()  # the new exporter now (the old one sends what it holds)
    return export_setting_view()


def register(router: Any) -> None:
    """The telemetry routes on /api/model-assets (model_assets.py calls this)."""
    from fastapi import Body

    import auth

    @router.get("/telemetry/export")
    def get_export() -> dict:
        """Where model spans are exported (OTLP/HTTP JSON) and how the export is doing."""
        auth.require_admin()
        return export_setting_view()

    @router.put("/telemetry/export")
    def put_export(body: dict = Body(...)) -> dict:
        auth.require_admin()
        return save_export_setting(body)

    @router.post("/telemetry/export/test")
    def post_export_test() -> dict:
        auth.require_admin()
        from fastapi import HTTPException

        try:
            return test_export()
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @router.post("/telemetry/transform-traces")
    def post_transform_traces(body: dict = Body(...)) -> dict:
        auth.require_user()
        return accept_transform_traces(body)

    @router.get("/{model_id}/traces")
    def get_model_traces(model_id: str, limit: int = 100, run: Optional[str] = None, trace_id: Optional[str] = None) -> list[dict]:
        return model_traces(model_id, limit, run, trace_id)


def _shutdown() -> None:
    exp = _STATE.get("exporter")
    if exp is not None:
        exp.flush(3.0)


atexit.register(_shutdown)
