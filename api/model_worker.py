"""A process hosting one model version for inference: `python model_worker.py spec.json`.

Used by `ModelInput(..., use_sidecar=True)` in transforms (the adapter runs with only its version's published source
on the path, apart from the repository's modules), by live deployments (model_deployments.py keeps one per running
deployment) and by batch deployments. The spec is what model_assets.resolve_ref returns: a model trained here
("python", loaded with model_lib.load_version from the version's source snapshot) or a container-backed one
(model_container.ContainerModel).

Protocol: JSON lines. The worker first writes {"ready": true, "api": ...} (or {"ready": false, "error": ...}); then for
each request line {"id", "op": "transform", "inputs": {name: {"rows": [...]} | {"parquet": path} | {"value": v}},
"cast": bool, "outputs_dir": optional} it writes {"id", "ok", "outputs": {name: {"rows"} | {"parquet"} | {"value"}},
"logs", "ms"} or {"id", "ok": false, "error", "traceback"}. Prints and log records of the adapter go to "logs".
`Client` is the other end.
"""

from __future__ import annotations

import contextlib
import io
import json
import logging
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

HERE = Path(__file__).resolve().parent


# ------------------------------------------------------------------------------------------------
# the worker
# ------------------------------------------------------------------------------------------------


def _load(spec: dict):
    import code_models

    code_models.install()
    import model_lib

    if spec.get("kind") == "python":
        return model_lib.load_version(spec, spec.get("param"), prefer_local=False)
    import model_container

    return model_container.ContainerModel(spec)


def _decode(v: dict) -> Any:
    import pandas as pd

    if "parquet" in v:
        return pd.read_parquet(v["parquet"])
    if "rows" in v:
        return pd.DataFrame(v["rows"])
    return v.get("value")


def _encode(name: str, v: Any, out_dir: Optional[str]) -> dict:
    import model_lib

    frame = None
    if hasattr(v, "toPandas"):
        frame = v.toPandas()
    elif hasattr(v, "columns") and hasattr(v, "to_dict"):
        frame = v
    if frame is not None:
        frame = frame.copy()
        frame.columns = [str(c) for c in frame.columns]
        if out_dir:
            p = Path(out_dir) / f"{re.sub(r'[^A-Za-z0-9_-]', '_', name)}-{uuid.uuid4().hex[:6]}.parquet"
            frame.to_parquet(p, index=False)
            return {"parquet": str(p)}
        return {"rows": json.loads(frame.to_json(orient="records", date_format="iso", default_handler=str))}
    return {"value": model_lib._jsonable(v)}


class _Telemetry:
    """Spans of one inference call (integrate-models/instrumentation-telemetry): a span over the whole call is made
    for every request, and the adapter's own spans (`opentelemetry.trace.get_tracer(__name__)`, the global tracer
    provider is set here) nest under it. Without the OpenTelemetry SDK only the request span is reported."""

    def __init__(self, spec: dict) -> None:
        self.finished: list = []
        self.tracer = None
        self.attributes = {"model.rid": spec.get("rid") or "", "model.version": spec.get("version") or "", "model.name": spec.get("model") or ""}
        try:
            from opentelemetry import trace
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
        except ImportError:
            return
        finished = self.finished

        class _Collect(SpanExporter):
            def export(self, spans):  # noqa: ANN001
                finished.extend(spans)
                return SpanExportResult.SUCCESS

        provider = TracerProvider(resource=Resource.create({"service.name": f"model:{spec.get('model') or ''}"}))
        provider.add_span_processor(SimpleSpanProcessor(_Collect()))
        trace.set_tracer_provider(provider)
        self.tracer = trace.get_tracer("bluesandai.model")

    @contextlib.contextmanager
    def request(self, request_id: Optional[str]):
        """The request span; `.spans` of the yielded dict is filled when it ends."""
        del self.finished[:]
        box: dict = {"spans": []}
        started, t0 = time.time(), time.monotonic()
        failed: Optional[BaseException] = None
        try:
            if self.tracer is None:
                yield box
            else:
                with self.tracer.start_as_current_span("model inference", attributes={**self.attributes, "request.id": request_id or ""}):
                    yield box
        except BaseException as e:  # noqa: BLE001 - recorded on the span, raised again
            failed = e
            raise
        finally:
            if self.tracer is None:
                box["spans"] = [{"name": "model inference", "span_id": uuid.uuid4().hex[:16], "parent_id": None, "trace_id": uuid.uuid4().hex,
                                 "start_ms": 0.0, "ms": round((time.monotonic() - t0) * 1000, 3), "status": "ERROR" if failed else "OK",
                                 "attributes": self.attributes, "events": [], "at": started}]
            else:
                box["spans"] = self._export()

    def _export(self) -> list[dict]:
        if not self.finished:
            return []
        by_id = {s.get_span_context().span_id: s for s in self.finished}

        def depth(s) -> int:  # noqa: ANN001
            n = 0
            while s.parent is not None and s.parent.span_id in by_id and n < 100:
                s, n = by_id[s.parent.span_id], n + 1
            return n

        # a parent before its children even when the clock gives them the same start (Windows' coarse timer)
        spans = sorted(self.finished, key=lambda s: (s.start_time or 0, depth(s)))[:200]
        t0 = min(s.start_time for s in spans)
        out = []
        for s in spans:
            ctx = s.get_span_context()
            out.append({"name": s.name, "span_id": format(ctx.span_id, "016x"), "parent_id": format(s.parent.span_id, "016x") if s.parent else None,
                        "trace_id": format(ctx.trace_id, "032x"), "start_ms": round((s.start_time - t0) / 1e6, 3),
                        "ms": round(((s.end_time or s.start_time) - s.start_time) / 1e6, 3), "status": s.status.status_code.name,
                        "attributes": {str(k): (v if isinstance(v, (str, int, float, bool)) else str(v)) for k, v in (s.attributes or {}).items()},
                        "events": [{"name": e.name, "ms": round((e.timestamp - t0) / 1e6, 3),
                                    "attributes": {str(k): str(v)[:2000] for k, v in (e.attributes or {}).items()}} for e in s.events][:50],
                        "at": t0 / 1e9})
        del self.finished[:]
        return out


def serve(spec_path: str) -> None:
    out = sys.stdout
    sys.stdout = sys.stderr  # stray prints never reach the protocol stream
    logs = io.StringIO()
    logging.basicConfig(stream=logs, level=logging.INFO, format="%(levelname)s %(name)s: %(message)s", force=True)

    def send(obj: dict) -> None:
        out.write(json.dumps(obj, default=str) + "\n")
        out.flush()

    spec = json.loads(Path(spec_path).read_text("utf-8"))
    try:
        # the request span, the adapter's spans and CLIENT spans (with `traceparent`) of its outbound HTTP requests
        import model_telemetry

        telemetry: Any = model_telemetry.Recorder({"model.rid": spec.get("rid") or "", "model.version": spec.get("version") or "",
                                                   "model.name": spec.get("model") or ""}, service_name=f"model:{spec.get('model') or ''}")
    except Exception:  # noqa: BLE001 - the older recorder (request span and the adapter's spans)
        telemetry = _Telemetry(spec)
    try:
        with contextlib.redirect_stdout(logs):
            model = _load(spec)
        api = spec.get("api")
        adapter0 = getattr(model, "_pm_adapter", None)
        if adapter0 is None and spec.get("kind") == "container":
            # a container model: start its containers now (the deployment is ready once they run)
            with contextlib.redirect_stdout(logs):
                adapter0 = model._start()
        if adapter0 is not None:
            # the API the loaded adapter declares (what a version records)
            import model_lib

            try:
                api = model_lib.describe_api(adapter0)
            except Exception:  # noqa: BLE001
                pass
        send({"ready": True, "api": api, "logs": logs.getvalue()[-4000:]})
    except Exception as e:  # noqa: BLE001
        send({"ready": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc(limit=8)[-4000:], "logs": logs.getvalue()[-4000:]})
        return
    adapter = getattr(model, "_pm_adapter", None)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            send({"ok": False, "error": "the request is not JSON"})
            continue
        logs.seek(0)
        logs.truncate()
        started = time.monotonic()
        trace_box: dict = {"spans": []}
        try:
            if req.get("op") == "ping":
                send({"id": req.get("id"), "ok": True})
                continue
            inputs = {k: _decode(v) for k, v in (req.get("inputs") or {}).items()}
            with telemetry.request(req.get("request_uuid") or req.get("id")) as trace_box, contextlib.redirect_stdout(logs):
                if adapter is not None and hasattr(adapter, "_transform"):
                    res = adapter._transform((), inputs, cast=bool(req.get("cast")))
                else:
                    res = model.transform(**inputs)
            send({"id": req.get("id"), "ok": True, "outputs": {k: _encode(k, v, req.get("outputs_dir")) for k, v in res.items()},
                  "logs": logs.getvalue()[-20000:], "ms": int((time.monotonic() - started) * 1000), "spans": trace_box["spans"]})
        except Exception as e:  # noqa: BLE001
            send({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc(limit=8)[-6000:],
                  "logs": logs.getvalue()[-20000:], "ms": int((time.monotonic() - started) * 1000), "spans": trace_box["spans"]})
    with contextlib.suppress(Exception):
        if hasattr(model, "close"):
            model.close()


# ------------------------------------------------------------------------------------------------
# the client
# ------------------------------------------------------------------------------------------------


class WorkerError(RuntimeError):
    def __init__(self, message: str, detail: Optional[dict] = None) -> None:
        super().__init__(message)
        self.detail = detail or {}


def _env() -> dict:
    env = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL", k) or k.startswith("BLUESANDAI_API")}
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill a worker process and every process it started (a container model's `wsl.exe` keepalive and docker
    calls): its children are listed before it is killed, while they can still be found by their parent."""
    children = []
    try:
        import psutil

        children = psutil.Process(proc.pid).children(recursive=True)
    except Exception:  # noqa: BLE001 - psutil missing or the process already gone
        pass
    with contextlib.suppress(Exception):
        proc.kill()
    for ch in children:
        with contextlib.suppress(Exception):
            ch.kill()
    with contextlib.suppress(Exception):
        proc.wait(10)


class Client:
    """One worker process: started on construction, `transform()` / `query()` send requests (one at a time)."""

    def __init__(self, spec: dict, start_timeout: float = 300, on_stderr: Optional[Callable[[str], None]] = None) -> None:
        self.spec = spec
        self.tmp = tempfile.mkdtemp(prefix="model-worker-")
        sp = Path(self.tmp) / "spec.json"
        sp.write_text(json.dumps(spec, default=str), "utf-8")
        self.stderr_tail: list[str] = []
        self._on_stderr = on_stderr
        self._lines: "queue.Queue[Optional[str]]" = queue.Queue()
        self._lock = threading.Lock()
        self.proc = subprocess.Popen([sys.executable, str(HERE / "model_worker.py"), str(sp)], cwd=str(HERE), stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=_env())
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()
        try:
            first = self._next(start_timeout)
        except BaseException:
            # no answer in time (or the caller was interrupted): the worker and anything it started do not stay
            self.close(wait=0)
            raise
        if first is None or not first.get("ready"):
            self.close()
            msg = (first or {}).get("error") or "the model process stopped while loading: " + "".join(self.stderr_tail[-20:])[-2000:]
            raise WorkerError(f"the model could not be loaded: {msg}", first or {})
        self.load_logs = first.get("logs") or ""
        self.api = first.get("api") or {}

    def _read_out(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._lines.put(line)
        self._lines.put(None)

    def _read_err(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr_tail = (self.stderr_tail + [line])[-200:]
            if self._on_stderr:
                with contextlib.suppress(Exception):
                    self._on_stderr(line)

    def _next(self, timeout: float) -> Optional[dict]:
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            raise WorkerError(f"the model did not answer within {timeout:.0f} s") from None
        if line is None:
            return None
        return json.loads(line)

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None

    def call(self, req: dict, timeout: float = 600) -> dict:
        with self._lock:
            if not self.alive:
                raise WorkerError("the model process is not running")
            req = {**req, "id": uuid.uuid4().hex[:8]}
            assert self.proc.stdin is not None
            self.proc.stdin.write(json.dumps(req, default=str) + "\n")
            self.proc.stdin.flush()
            res = self._next(timeout)
            if res is None:
                raise WorkerError("the model process stopped: " + "".join(self.stderr_tail[-20:])[-2000:])
            return res

    def transform(self, inputs: dict, timeout: float = 3600) -> dict:
        """Python values in (DataFrames go through parquet), Python values out; WorkerError on a model error."""
        import model_lib
        import pandas as pd

        enc = {}
        for k, v in inputs.items():
            if isinstance(v, pd.DataFrame) or hasattr(v, "toPandas") or hasattr(v, "pandas"):
                p = Path(self.tmp) / f"in-{uuid.uuid4().hex[:8]}.parquet"
                df = model_lib.to_pandas(v)
                df.columns = [str(c) for c in df.columns]
                df.to_parquet(p, index=False)
                enc[k] = {"parquet": str(p)}
            else:
                enc[k] = {"value": model_lib._jsonable(v)}
        res = self.call({"op": "transform", "inputs": enc, "outputs_dir": self.tmp}, timeout)
        self.last_spans, self.last_ms = res.get("spans") or [], res.get("ms")  # telemetry (RemoteModel, batch runs)
        if not res.get("ok"):
            raise WorkerError(res.get("error") or "the model failed", res)
        if res.get("logs"):
            print(res["logs"], end="" if res["logs"].endswith("\n") else "\n")
        return {k: _decode(v) for k, v in (res.get("outputs") or {}).items()}

    def query(self, inputs: dict, cast: bool = True, timeout: float = 120, request_uuid: Optional[str] = None) -> dict:
        """JSON in (tabular inputs as lists of rows), the worker's answer out (outputs as rows / values, "spans")."""
        enc = {k: ({"rows": v} if isinstance(v, list) and all(isinstance(r, dict) for r in v) else {"value": v}) for k, v in inputs.items()}
        return self.call({"op": "transform", "inputs": enc, "cast": cast, "request_uuid": request_uuid}, timeout)

    def close(self, wait: float = 10) -> None:
        """Ask the worker to stop (stdin closed) and wait up to `wait` s; then kill it with its child processes."""
        with contextlib.suppress(Exception):
            if self.proc.stdin:
                self.proc.stdin.close()
        if wait > 0:
            with contextlib.suppress(Exception):
                self.proc.wait(wait)
        if self.proc.poll() is None:
            _kill_tree(self.proc)
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    serve(sys.argv[1])
