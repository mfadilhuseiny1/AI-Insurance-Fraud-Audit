"""A Code Repositories debug session: one Python transform under a debugger, or a console (REPL), in its own process.

Started by code_debug.py with a spec.json: {mode: "debug" | "console", repo (folder holding the repository's files),
transform ("path::function"), inputs ({name: parquet path}), media_inputs, media_out, previous_output,
incremental_state, breakpoints ([{file, line, condition}], files relative to repo), stop_on_entry}.

The repository loads as code_runner.py loads it for a preview (same `transforms.api`, same inputs) and the transform
runs exactly as a preview runs it (code_runner._run_transform for @transform_df / @transform, code_runner._run_new for
@transform.using / @transform.spark.using), so nothing is written: there is no output dataset in a debug session. On
Spark only the driver side (the compute function) is debugged; UDFs run in Spark's Python workers.

Pausing and breakpoints set while running interrupt the main thread with _thread.interrupt_main(SIGINT), which works on
Windows as well as POSIX (no SIGUSR1, no os.kill).

Protocol: JSON lines. Commands arrive on stdin, events leave on the original stdout (fd 1 is pointed at stderr so
nothing else can write there; print() in user code becomes "output" events).

  commands  {"cmd": "continue" | "step" | "next" | "return"}     resume (paused only)
            {"cmd": "pause"}                                    pause a running transform / interrupt an evaluation
            {"cmd": "eval", "id", "code", "frame"}              run code in a paused frame or the console namespace
            {"cmd": "frame", "frame"}                           select a stack frame (variables of that frame)
            {"cmd": "breakpoints", "breakpoints": [...]}        replace the breakpoints (also while running)
            {"cmd": "watches", "watches": ["expr", ...]}        replace the watch expressions (values at each pause)
            {"cmd": "stop"}
  events    loading, ready (console), running, paused, frame, eval, breakpoints, watches, output, finished, error,
            stopped

Debugging is bdb.Bdb limited to the repository's files: stepping never stops inside pandas or the runner, and a
breakpoint in a helper module of the repository works as one in the transform's file.

Watch expressions are evaluated off the transform's thread, each limited to WATCH_TIMEOUT: in a helper process (this
file run with --watch-helper) on pickled copies of the values they use, else on a helper thread (see evaluate_watches).
"""

from __future__ import annotations

import _thread
import ast
import bdb
import builtins
import ctypes
import importlib
import io
import json
import os
import pickle
import queue
import re
import reprlib
import signal
import subprocess
import sys
import threading
import time
import traceback
import types
from pathlib import Path

import code_runner

ROWS = 20
MAX_COLS = 50
MAX_VARS = 150
MAX_CELL = 200
MAX_OUTPUT = 2_000_000

_PROTO: io.TextIOWrapper | None = None
_plock = threading.Lock()


def emit(ev: dict) -> None:
    line = json.dumps(ev, default=str)
    with _plock:
        assert _PROTO is not None
        _PROTO.write(line + "\n")
        _PROTO.flush()


# ------------------------------------------------------------------------------------------------
# output capture
# ------------------------------------------------------------------------------------------------


class Capture(io.TextIOBase):
    """sys.stdout / sys.stderr: streamed to the API as "output" events (or into `sink` during an evaluation)."""

    sent = 0

    def __init__(self, stream: str) -> None:
        self.stream = stream
        self.buf: list[str] = []
        self.size = 0
        self.sink: io.StringIO | None = None

    def writable(self) -> bool:
        return True

    def write(self, s) -> int:  # type: ignore[override]
        s = s if isinstance(s, str) else str(s)
        if getattr(threading.current_thread(), "watch", False):
            return len(s)  # print() inside a watch expression (also one left running after its time limit)
        if self.sink is not None:
            self.sink.write(s)
            return len(s)
        self.buf.append(s)
        self.size += len(s)
        if "\n" in s or self.size > 4096:
            self.flush()
        return len(s)

    def flush(self) -> None:
        if not self.buf:
            return
        text = "".join(self.buf)
        self.buf, self.size = [], 0
        if Capture.sent >= MAX_OUTPUT:
            return
        Capture.sent += len(text)
        if Capture.sent >= MAX_OUTPUT:
            text += "\n[output truncated]\n"
        emit({"event": "output", "stream": self.stream, "text": text})


OUT = Capture("stdout")
ERR = Capture("stderr")


def flush_output() -> None:
    OUT.flush()
    ERR.flush()


# ------------------------------------------------------------------------------------------------
# values
# ------------------------------------------------------------------------------------------------

_repr = reprlib.Repr()
_repr.maxstring = MAX_CELL
_repr.maxother = MAX_CELL
_repr.maxlist = _repr.maxtuple = _repr.maxset = _repr.maxfrozenset = _repr.maxdict = _repr.maxdeque = 20
_repr.maxlevel = 3
_repr.maxlong = 60


def short_repr(v) -> str:
    try:
        s = _repr.repr(v)
    except Exception as e:  # noqa: BLE001
        s = f"<repr failed: {type(e).__name__}: {e}>"
    return s if len(s) <= 2 * MAX_CELL else s[: 2 * MAX_CELL] + "…"


def cell(v):
    try:
        c = code_runner._cell(v)
    except Exception:  # noqa: BLE001
        c = str(v)
    if isinstance(c, str) and len(c) > MAX_CELL:
        return c[:MAX_CELL] + "…"
    if isinstance(c, (list, dict)):
        s = json.dumps(c, default=str)
        return c if len(s) <= MAX_CELL else s[:MAX_CELL] + "…"
    return c


def _frame_summary(df, rows: int) -> dict:
    n_rows, n_cols = df.shape
    shown = df.iloc[:rows, :MAX_COLS]
    dtypes = list(df.dtypes.iloc[:MAX_COLS])
    return {
        "kind": "dataframe",
        "shape": [int(n_rows), int(n_cols)],
        "columns": [{"name": str(c), "type": str(t)} for c, t in zip(shown.columns, dtypes)],
        "index": [cell(i) for i in shown.index],
        "rows": [[cell(x) for x in r] for r in shown.itertuples(index=False, name=None)],
        "truncated_columns": n_cols > MAX_COLS,
        "repr": f"{n_rows:,} rows × {n_cols} columns",
    }


def summarize(v, rows: int = ROWS) -> dict:
    """A JSON-able description of a value: DataFrames / Series as tables, containers by length, else a short repr."""
    pd = sys.modules.get("pandas")
    np = sys.modules.get("numpy")
    t = type(v)
    out: dict = {"type": t.__name__ if t.__module__ in ("builtins", "__main__") else f"{t.__module__.split('.')[0]}.{t.__name__}"}
    try:
        if isinstance(v, code_runner.TransformInput):
            df = v.dataframe("current")
            out.update(_frame_summary(df, rows), type="TransformInput")
            added = len(v.dataframe())
            if added != len(df):
                out["note"] = f"{added:,} rows to process (dataframe()), {len(df):,} in all (dataframe('current'))"
            return out
        if isinstance(v, code_runner.TransformOutput):
            if v.df is None:
                return {**out, "type": "TransformOutput", "kind": "object", "repr": "TransformOutput (nothing written yet)"}
            out.update(_frame_summary(code_runner._as_frame(v.df), rows), type="TransformOutput", note=f"written ({v.mode})")
            return out
        if pd is not None and isinstance(v, pd.DataFrame):
            out.update(_frame_summary(v, rows), type="DataFrame")
            return out
        if pd is not None and isinstance(v, pd.Series):
            head = v.iloc[:rows]
            return {**out, "type": "Series", "kind": "series", "length": len(v), "dtype": str(v.dtype),
                    "series_name": None if v.name is None else str(v.name),
                    "index": [cell(i) for i in head.index], "rows": [[cell(x)] for x in head.tolist()],
                    "columns": [{"name": "value" if v.name is None else str(v.name), "type": str(v.dtype)}],
                    "repr": f"{len(v):,} values, dtype {v.dtype}"}
        if np is not None and isinstance(v, np.ndarray):
            return {**out, "kind": "array", "shape": [int(x) for x in v.shape], "dtype": str(v.dtype), "length": int(v.size),
                    "repr": short_repr(v)}
        if v is None or isinstance(v, (bool, int, float, complex, str, bytes)):
            return {**out, "kind": "scalar", "repr": short_repr(v), **({"length": len(v)} if isinstance(v, (str, bytes)) else {})}
        if isinstance(v, dict):
            return {**out, "kind": "dict", "length": len(v), "repr": short_repr(v)}
        if isinstance(v, (list, tuple, set, frozenset)):
            return {**out, "kind": "sequence", "length": len(v), "repr": short_repr(v)}
        if isinstance(v, types.ModuleType):
            return {**out, "kind": "module", "repr": f"<module {v.__name__}>"}
        if isinstance(v, type) or callable(v):
            return {**out, "kind": "callable", "repr": short_repr(v)}
    except Exception as e:  # noqa: BLE001
        return {**out, "kind": "object", "repr": f"<could not summarize: {type(e).__name__}: {e}>"}
    return {**out, "kind": "object", "repr": short_repr(v)}


def variables(ns, hide_code: bool = False) -> list[dict]:
    out = []
    try:
        items = list(ns.items())
    except Exception:  # noqa: BLE001
        return out
    for name, v in items:
        if not isinstance(name, str) or name.startswith("__"):
            continue
        if hide_code and (isinstance(v, (types.ModuleType, type)) or (callable(v) and not hasattr(v, "dataframe"))):
            continue
        out.append({"name": name, **summarize(v)})
        if len(out) >= MAX_VARS:
            break
    return out


# ------------------------------------------------------------------------------------------------
# running code typed in the console
# ------------------------------------------------------------------------------------------------


def run_source(src: str, g: dict, l=None) -> tuple[bool, object]:
    """exec a block; when its last statement is an expression, return its value (as a REPL shows it)."""
    tree = ast.parse(src, "<console>", "exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    if tree.body:
        exec(compile(tree, "<console>", "exec"), g, g if l is None else l)
    if last is not None:
        return True, eval(compile(last, "<console>", "eval"), g, g if l is None else l)
    return False, None


def _is_expression(src: str) -> bool:
    try:
        ast.parse(src, "<console>", "eval")
        return True
    except SyntaxError:
        return False


REPO = {"prefix": "\0"}


def _console_traceback(e: BaseException) -> str:
    """The traceback from the first frame of the user's code (console input or a repository file) on."""
    tb = e.__traceback__
    while tb is not None:
        fn = tb.tb_frame.f_code.co_filename
        if fn == "<console>" or os.path.abspath(fn).startswith(REPO["prefix"]):
            break
        tb = tb.tb_next
    if tb is None:
        text = "".join(traceback.format_exception_only(type(e), e))
    else:
        text = "".join(traceback.format_exception(type(e), e, tb, limit=-12))
    text = text.replace(REPO["prefix"], "")
    if os.sep != "/":
        # repository paths as the editor shows them (transforms-python/src/…), not with Windows separators
        text = re.sub(r'File "([^"<>]+)"', lambda m: 'File "%s"' % m.group(1).replace(os.sep, "/"), text)
    return text[-6000:]


STATE = {"evaluating": False}


def evaluate(cmd: dict, g: dict, l=None, console_ns: dict | None = None, before_result=None) -> None:
    """Runs a console command; before_result() is called just before the "eval" event is sent (the API answers the
    evaluation as soon as that event arrives, so what before_result emits is already in that answer)."""
    code = str(cmd.get("code") or "")
    sink = io.StringIO()
    OUT.sink = ERR.sink = sink
    STATE["evaluating"] = True
    ev: dict = {"event": "eval", "id": cmd.get("id"), "code": code}
    try:
        if l is not None and _is_expression(code):
            # an expression in a function's frame: locals and globals merged, so lambdas and generator
            # expressions see the frame's variables
            has, value = True, eval(compile(code, "<console>", "eval"), {**g, **dict(l.items())})
        else:
            has, value = run_source(code, g, l)
        STATE["evaluating"] = False
        ev["ok"] = True
        ev["value"] = summarize(value) if has else None
        if has and console_ns is not None and value is not None:
            console_ns["_"] = value
    except KeyboardInterrupt:
        ev.update(ok=False, error="KeyboardInterrupt: interrupted")
    except SystemExit:
        ev.update(ok=False, error="SystemExit is not allowed here (stop the session instead)")
    except BaseException as e:  # noqa: BLE001
        ev.update(ok=False, error=_console_traceback(e))
    finally:
        STATE["evaluating"] = False
        OUT.sink = ERR.sink = None
    ev["output"] = sink.getvalue()[-100_000:]
    if before_result is not None:
        try:
            before_result()
        except Exception:  # noqa: BLE001 - the result is sent anyway
            pass
    emit(ev)


WATCH_TIMEOUT = 3.0
MAX_WATCHES = 30


def _watch_list(v) -> list[str]:
    return [str(x)[:2000] for x in (v or []) if str(x).strip()][:MAX_WATCHES]


# Watch expressions never run on the paused transform's own thread: a watch stuck in one long C call (sum(range(10**12)),
# a huge regex backtrack) holds the GIL and cannot be interrupted, which would hang the whole session. So:
# - the values a watch uses are pickled to a helper process (this file run with --watch-helper, kept warm between
#   pauses) that evaluates it; past WATCH_TIMEOUT the helper is killed (and started again for the next watch);
# - a watch using a value that cannot be copied there (a Spark DataFrame, a lock, a class only the repository defines)
#   runs on a helper thread of this process instead; past WATCH_TIMEOUT it is interrupted (an asynchronous
#   KeyboardInterrupt) or, stuck in a C call that releases the GIL (sleep, I/O, Spark), left behind while the session
#   goes on. Only such a watch stuck in a C call that keeps the GIL still needs Stop.
WATCH_START_TIMEOUT = 60.0
WATCH_PICKLE_MAX = 64 << 20
WATCH_THREADS_MAX = 4


def _watch_error(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"[:1000]


def _code_names(code: types.CodeType) -> set[str]:
    out = set(code.co_names)
    for c in code.co_consts:
        if isinstance(c, types.CodeType):
            out |= _code_names(c)
    return out


def _send_frame(stream, data: bytes) -> None:
    stream.write(len(data).to_bytes(4, "big") + data)
    stream.flush()


def _read_frame(stream) -> bytes | None:
    head = stream.read(4)
    if len(head) < 4:
        return None
    n = int.from_bytes(head, "big")
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


class _HelperDown(Exception):
    pass


class WatchHelper:
    """The helper process evaluating watch expressions on pickled copies of the values they use."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.answers: queue.Queue = queue.Queue()
        self.ready = False
        self.lock = threading.Lock()

    def warm(self) -> None:
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._spawn()

    def _spawn(self) -> None:
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--watch-helper"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=os.getcwd(), env=env)
        self.answers = queue.Queue()
        self.ready = False
        threading.Thread(target=self._read, args=(self.proc, self.answers), daemon=True, name="debug-watch-helper").start()

    @staticmethod
    def _read(proc: subprocess.Popen, answers: queue.Queue) -> None:
        assert proc.stdout is not None
        while True:
            data = _read_frame(proc.stdout)
            if data is None:
                answers.put(None)
                return
            try:
                answers.put(json.loads(data.decode("utf-8")))
            except ValueError:
                answers.put({"ok": False, "error": "unreadable answer"})

    def kill(self) -> None:
        with self.lock:
            p, self.proc, self.ready = self.proc, None, False
        if p is not None and p.poll() is None:
            try:
                # its process tree: a virtual environment's python.exe on Windows is a launcher running the real one
                import psutil

                for child in psutil.Process(p.pid).children(recursive=True):
                    try:
                        child.kill()
                    except psutil.Error:
                        pass
            except Exception:  # noqa: BLE001 - psutil missing (a repository environment) or the process is gone
                pass
            try:
                p.kill()
                p.wait(5)
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _get(answers: queue.Queue, timeout: float):
        """queue.get in short slices: on Windows a blocked lock wait does not see Pause (SIGINT) until it returns."""
        end = time.monotonic() + timeout
        while True:
            left = end - time.monotonic()
            if left <= 0:
                raise queue.Empty
            try:
                return answers.get(timeout=min(0.05, left))
            except queue.Empty:
                continue

    def _ask(self, msg: dict, timeout: float) -> dict:
        """Sends one request and waits for its answer: _HelperDown when the helper died, queue.Empty past timeout."""
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._spawn()
            proc, answers = self.proc, self.answers
        assert proc is not None and proc.stdin is not None
        if not self.ready:
            ans = self._get(answers, WATCH_START_TIMEOUT)
            if not ans or not ans.get("ready"):
                raise _HelperDown()
            self.ready = True
        try:
            _send_frame(proc.stdin, pickle.dumps(msg, protocol=pickle.HIGHEST_PROTOCOL))
        except (OSError, ValueError):
            raise _HelperDown() from None
        ans = self._get(answers, timeout)
        if ans is None:
            raise _HelperDown()
        return ans

    def load(self, blob: bytes | None, modules: dict[str, str], ns: dict, in_blob: set[str]) -> set[str]:
        """The namespace of the next evaluations; returns the names the helper could not load."""
        ans = self._ask({"op": "ns", "blob": blob, "modules": modules}, WATCH_START_TIMEOUT)
        failed = set(ans.get("failed") or [])
        if "*" in failed:
            # one value could not be rebuilt there (an instance of a class only the repository defines): one pickle
            # per value, so only the watches using that one are evaluated here
            single: dict[str, bytes] = {}
            for name in in_blob:
                try:
                    single[name] = pickle.dumps(ns[name], protocol=pickle.HIGHEST_PROTOCOL)
                except Exception:  # noqa: BLE001
                    pass
            ans = self._ask({"op": "ns", "values": single, "modules": modules}, WATCH_START_TIMEOUT)
            failed = (in_blob - set(single)) | set(ans.get("failed") or [])
            good = in_blob - failed
            if len(good) > 1:
                # the others again as one pickle, so objects they share stay shared (a is b)
                ans = self._ask({"op": "ns", "blob": pickle.dumps({n: ns[n] for n in good}, protocol=pickle.HIGHEST_PROTOCOL),
                                 "modules": modules}, WATCH_START_TIMEOUT)
                if "*" in (ans.get("failed") or []):
                    failed |= good
        return failed

    def evaluate(self, expr: str, timeout: float) -> dict:
        return self._ask({"op": "eval", "expr": expr}, timeout)


WATCH_HELPER = WatchHelper()


def _pack(ns: dict, names: set[str]) -> tuple[bytes | None, set[str], dict[str, str], set[str]]:
    """The values for the helper: one pickle of every copyable value (shared objects stay shared), modules by name;
    and the names that stay here (not copyable, too large, or the repository's own modules)."""
    pd = sys.modules.get("pandas")
    values: dict = {}
    modules: dict[str, str] = {}
    local: set[str] = set()
    for name in names:
        v = ns[name]
        if isinstance(v, types.ModuleType):
            f = getattr(v, "__file__", None) or ""
            if f and os.path.abspath(f).startswith(REPO.get("prefix") or "\0"):
                local.add(name)
            else:
                modules[name] = v.__name__
            continue
        try:
            if pd is not None and isinstance(v, (pd.DataFrame, pd.Series)) and int(v.memory_usage(deep=False).sum() if isinstance(v, pd.DataFrame) else v.memory_usage(deep=False)) > WATCH_PICKLE_MAX:
                local.add(name)
                continue
        except Exception:  # noqa: BLE001
            pass
        values[name] = v
    blob, in_blob = None, set()
    if values:
        try:
            blob = pickle.dumps(values, protocol=pickle.HIGHEST_PROTOCOL)
        except Exception:  # noqa: BLE001 - find the values that cannot be copied
            blob = None
        if blob is None or len(blob) > WATCH_PICKLE_MAX:
            blob = None
            keep: dict = {}
            for name, v in values.items():
                try:
                    if len(pickle.dumps(v, protocol=pickle.HIGHEST_PROTOCOL)) <= WATCH_PICKLE_MAX // 4:
                        keep[name] = v
                        continue
                except Exception:  # noqa: BLE001
                    pass
                local.add(name)
            try:
                blob = pickle.dumps(keep, protocol=pickle.HIGHEST_PROTOCOL) if keep else None
            except Exception:  # noqa: BLE001
                local |= set(keep)
                blob = None
            in_blob = set(keep) if blob is not None else set()
        else:
            in_blob = set(values)
    return blob, in_blob, modules, local


def _async_interrupt(th: threading.Thread) -> None:
    if th.ident is not None:
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(th.ident), ctypes.py_object(KeyboardInterrupt))


def _evaluate_here(code: types.CodeType, ns: dict) -> dict:
    """A watch on a helper thread of this process, limited to WATCH_TIMEOUT."""
    alive = [t for t in threading.enumerate() if getattr(t, "watch", False)]
    if len(alive) >= WATCH_THREADS_MAX:
        return {"ok": False, "error": f"not evaluated: {len(alive)} earlier watches are still running in calls that cannot be interrupted"}
    box: dict = {}

    def run() -> None:
        try:
            box["value"] = summarize(eval(code, dict(ns)))
        except KeyboardInterrupt:
            box["error"] = "interrupted"
        except BaseException as e:  # noqa: BLE001
            box["error"] = _watch_error(e)

    th = threading.Thread(target=run, daemon=True, name="debug-watch")
    th.watch = True  # type: ignore[attr-defined]
    STATE["evaluating"] = True
    paused = False
    try:
        th.start()
        end = time.monotonic() + WATCH_TIMEOUT
        while th.is_alive() and time.monotonic() < end:
            th.join(0.05)  # short slices: Pause (SIGINT) is seen between them on Windows too
    except KeyboardInterrupt:  # Pause pressed while the watches are evaluated
        paused = True
    finally:
        STATE["evaluating"] = False
    if th.is_alive():
        _async_interrupt(th)
        th.join(0.5)
        msg = "interrupted" if paused else f"stopped after {WATCH_TIMEOUT:g} s"
        if th.is_alive():
            msg += " (still running in a call that cannot be interrupted; the session goes on)"
        return {"ok": False, "error": msg}
    if "value" in box:
        return {"ok": True, "value": box["value"]}
    return {"ok": False, "error": box.get("error") or "no value"}


def evaluate_watches(exprs: list[str], ns: dict) -> list[dict]:
    """The watch expressions' values in a frame (expressions only; print() output is dropped; each limited to
    WATCH_TIMEOUT, see above)."""
    out: list[dict] = [{"expr": e} for e in exprs]
    codes: dict[int, types.CodeType] = {}
    for k, expr in enumerate(exprs):
        try:
            codes[k] = compile(expr.strip(), "<watch>", "eval")
        except SyntaxError as e:
            out[k].update(ok=False, error=f"SyntaxError: {e.msg} (a watch is an expression)")
    if not codes:
        return out
    uses = {k: _code_names(c) & ns.keys() for k, c in codes.items()}
    needed = set().union(*uses.values())
    blob, in_blob, modules, local = _pack(ns, needed)
    remote = [k for k in codes if not uses[k] & local]
    here = [k for k in codes if k not in remote]
    loaded = False
    for k in remote:
        try:
            if not loaded:
                failed = WATCH_HELPER.load(blob, modules, ns, in_blob)
                loaded = True
                if failed:
                    # the helper could not rebuild some values (a class only the repository defines): evaluated here
                    for j in list(remote):
                        if uses[j] & failed and j not in here:
                            here.append(j)
            if k in here:
                continue
            STATE["evaluating"] = True
            try:
                ans = WATCH_HELPER.evaluate(exprs[k], WATCH_TIMEOUT)
            finally:
                STATE["evaluating"] = False
            out[k].update({"ok": bool(ans.get("ok"))}, **({"value": ans.get("value")} if ans.get("ok") else {"error": ans.get("error")}))
        except queue.Empty:
            WATCH_HELPER.kill()
            loaded = False
            out[k].update(ok=False, error=f"stopped after {WATCH_TIMEOUT:g} s")
        except KeyboardInterrupt:  # Pause pressed while waiting
            WATCH_HELPER.kill()
            loaded = False
            out[k].update(ok=False, error="interrupted")
        except _HelperDown:
            WATCH_HELPER.kill()
            loaded = False
            if k not in here:
                here.append(k)
    for k in here:
        out[k].update(_evaluate_here(codes[k], ns))
    return out


def evaluate_watch(expr: str, ns: dict) -> dict:
    return evaluate_watches([expr], ns)[0]


def watch_helper_main() -> None:
    """The helper process: pickled requests on stdin, JSON answers (length-prefixed) on stdout."""
    proto = os.fdopen(os.dup(1), "wb")
    null = os.open(os.devnull, os.O_RDWR)
    os.dup2(null, 1)
    sys.stdout = sys.stderr = open(os.devnull, "w", encoding="utf-8")
    inp = sys.stdin.buffer
    ns: dict = {}

    def send(obj: dict) -> None:
        _send_frame(proto, json.dumps(obj, default=str).encode("utf-8"))

    send({"ready": True})
    while True:
        data = _read_frame(inp)
        if data is None:
            os._exit(0)
        try:
            msg = pickle.loads(data)
        except Exception as e:  # noqa: BLE001
            send({"ok": False, "error": _watch_error(e)})
            continue
        if msg.get("op") == "ns":
            ns, failed = {}, []
            blob = msg.get("blob")
            if blob is not None:
                try:
                    ns.update(pickle.loads(blob))
                except Exception:  # noqa: BLE001 - e.g. a class defined in the repository: asked again value by value
                    failed.append("*")
            for name, b in (msg.get("values") or {}).items():
                try:
                    ns[name] = pickle.loads(b)
                except Exception:  # noqa: BLE001
                    failed.append(name)
            for name, mod in (msg.get("modules") or {}).items():
                try:
                    ns[name] = importlib.import_module(mod)
                except Exception:  # noqa: BLE001
                    failed.append(name)
            send({"ok": True, "failed": failed})
        elif msg.get("op") == "eval":
            try:
                v = eval(compile(str(msg.get("expr") or "").strip(), "<watch>", "eval"), {**ns, "__builtins__": builtins})
                send({"ok": True, "value": summarize(v)})
            except BaseException as e:  # noqa: BLE001
                send({"ok": False, "error": _watch_error(e)})


# ------------------------------------------------------------------------------------------------
# breakpoints
# ------------------------------------------------------------------------------------------------

_LINES: dict[str, set[int]] = {}


def code_lines(path: str) -> set[int]:
    """Lines where execution can stop (from the compiled code objects)."""
    if path in _LINES:
        return _LINES[path]
    lines: set[int] = set()
    try:
        stack = [compile(Path(path).read_text("utf-8"), path, "exec")]
        while stack:
            c = stack.pop()
            lines.update(ln for _, _, ln in c.co_lines() if ln)
            stack.extend(k for k in c.co_consts if isinstance(k, types.CodeType))
    except (OSError, SyntaxError, ValueError):
        pass
    _LINES[path] = lines
    return lines


def check_breakpoints(repo: str, bps: list[dict]) -> list[dict]:
    out = []
    for bp in bps:
        file, line = str(bp.get("file") or ""), int(bp.get("line") or 0)
        path = os.path.abspath(os.path.join(repo, file))
        cond = (bp.get("condition") or "").strip() or None
        res = {"file": file, "line": line, "condition": cond, "verified": True, "message": None}
        if not path.startswith(repo + os.sep) or not os.path.isfile(path):
            res.update(verified=False, message="no such file in the repository")
        elif not file.endswith(".py"):
            res.update(verified=False, message="breakpoints work in Python files")
        elif line not in code_lines(path):
            res.update(verified=False, message="no code on this line (blank, comment or a continuation)")
        elif cond:
            try:
                compile(cond, "<condition>", "eval")
            except SyntaxError as e:
                res.update(verified=False, message=f"condition: {e.msg}")
        out.append(res)
    return out


# ------------------------------------------------------------------------------------------------
# the debugger
# ------------------------------------------------------------------------------------------------


class Debugger(bdb.Bdb):
    def __init__(self, repo: str) -> None:
        super().__init__()
        self.repo = repo
        # bdb's canonic() lowercases paths on Windows (normcase): compare canonic paths with a canonic prefix
        self.repo_prefix = self.canonic(repo) + os.sep
        self._in_repo: dict[str, bool] = {}
        self.state = "starting"
        self.reason: str | None = None
        self.entry_code = None
        self.pending_bps: list[dict] | None = None
        # set by the command thread before it interrupts the main thread (_thread.interrupt_main)
        self.retrace = False
        self.pause_requested = False
        self.cmds: queue.Queue = queue.Queue()
        self.frames: list = []
        self.cur = 0
        self.post_mortem = False
        # each paused frame's f_locals, read once per pause: on Python < 3.13 every read of f_locals copies the fast
        # locals over the dict again, which would undo an assignment made in the console (written back to the top
        # frame when the trace function returns, as pdb does it)
        self.locals: dict[int, dict] = {}
        # watch expressions, evaluated in the selected frame whenever the transform pauses or the frame changes
        self.watches: list[str] = []

    # -- limiting the debugger to the repository's files

    def in_repo(self, frame) -> bool:
        fn = frame.f_code.co_filename
        r = self._in_repo.get(fn)
        if r is None:
            r = self._in_repo[fn] = self.canonic(fn).startswith(self.repo_prefix)
        return r

    def stop_here(self, frame) -> bool:
        return self.in_repo(frame) and super().stop_here(frame)

    def break_anywhere(self, frame) -> bool:
        return frame.f_code is self.entry_code or super().break_anywhere(frame)

    def break_here(self, frame) -> bool:
        if self.entry_code is not None and frame.f_code is self.entry_code:
            self.entry_code = None
            self.reason = "entry"
            return True
        if super().break_here(frame):
            self.reason = "breakpoint"
            return True
        return False

    def trace_dispatch(self, frame, event, arg):
        if self.pending_bps is not None:
            bps, self.pending_bps = self.pending_bps, None
            self.apply_breakpoints(bps)
        return super().trace_dispatch(frame, event, arg)

    def run(self, func, *args):
        """bdb.runcall, but starting as "continue" (runcall starts by stepping)."""
        self.reset()
        self.botframe = sys._getframe()
        self.set_continue()
        sys.settrace(self.trace_dispatch)
        try:
            return func(*args)
        finally:
            self.quitting = True
            sys.settrace(None)

    def set_continue(self) -> None:
        # keep tracing even without breakpoints, so breakpoints added while it runs still stop it
        self._set_stopinfo(self.botframe, None, -1)

    def do_clear(self, arg) -> None:
        self.clear_bpbynumber(arg)

    def user_call(self, frame, argument_list) -> None:
        pass

    def user_return(self, frame, return_value) -> None:
        pass

    def user_exception(self, frame, exc_info) -> None:
        pass

    def user_line(self, frame) -> None:
        reason, self.reason = self.reason or "step", None
        self.interaction(frame, reason)

    # -- breakpoints

    def apply_breakpoints(self, bps: list[dict]) -> None:
        self.clear_all_breaks()
        for bp in check_breakpoints(self.repo, bps):
            if bp["verified"]:
                self.set_break(os.path.join(self.repo, bp["file"]), bp["line"], cond=bp["condition"])

    def request_breakpoints(self, bps: list[dict]) -> None:
        """From the stdin thread: applied by the main thread at its next traced event."""
        self.pending_bps = bps
        if self.state == "running":
            self.retrace = True
            _thread.interrupt_main(signal.SIGINT)

    def request_pause(self) -> None:
        """From the stdin thread: pause the running transform, or interrupt an evaluation."""
        self.pause_requested = True
        _thread.interrupt_main(signal.SIGINT)

    def retrace_stack(self, frame) -> None:
        # trace the repository frames on the stack again (a loop that started without breakpoints is not traced)
        f = frame
        while f is not None:
            if self.in_repo(f):
                f.f_trace = self.trace_dispatch
                f.f_trace_lines = True
            f = f.f_back
        sys.settrace(self.trace_dispatch)

    def on_sigint(self, signum, frame) -> None:
        if self.retrace:
            self.retrace = False
            self.retrace_stack(frame)
            if not self.pause_requested:
                return
        self.pause_requested = False
        if STATE["evaluating"]:
            raise KeyboardInterrupt
        if self.state != "running":
            return
        self.reason = "pause"
        f = frame
        while f is not None:
            f.f_trace = self.trace_dispatch
            f.f_trace_lines = True
            f = f.f_back
        self._set_stopinfo(None, None)
        sys.settrace(self.trace_dispatch)

    # -- pausing

    def _stack(self) -> list[dict]:
        return [{"index": i, "file": self.rel(f.f_code.co_filename), "line": ln, "function": f.f_code.co_name}
                for i, (f, ln) in enumerate(self.frames)]

    def rel(self, filename: str) -> str:
        """The repository-relative path with "/" separators and the file's own letter case."""
        p = os.path.abspath(filename)
        if self.canonic(p).startswith(self.repo_prefix):
            p = p[len(self.repo_prefix):]
        return p.replace(os.sep, "/")

    def flocals(self, i: int) -> dict:
        if i not in self.locals:
            self.locals[i] = self.frames[i][0].f_locals
        return self.locals[i]

    def watch_values(self, i: int) -> list[dict]:
        if not self.watches:
            return []
        f = self.frames[i][0]
        ns = {**f.f_globals, **dict(self.flocals(i).items())}
        return evaluate_watches(self.watches, ns)

    def emit_frame(self) -> None:
        f, ln = self.frames[self.cur]
        emit({"event": "frame", "frame": self.cur, "file": self.rel(f.f_code.co_filename), "line": ln,
              "variables": variables(self.flocals(self.cur)), "watches": self.watch_values(self.cur)})

    def interaction(self, frame, reason: str, exception: str | None = None, frames: list | None = None) -> None:
        flush_output()
        if frames is None:
            frames = []
            f = frame
            while f is not None:
                if self.in_repo(f):
                    frames.append((f, f.f_lineno))
                f = f.f_back
        self.frames, self.cur, self.locals = frames, 0, {}
        self.state = "paused"
        top, line = frames[0]
        emit({"event": "paused", "reason": reason, "file": self.rel(top.f_code.co_filename), "line": line,
              "function": top.f_code.co_name, "stack": self._stack(), "frame": 0, "exception": exception,
              "variables": variables(self.flocals(0)), "watches": self.watch_values(0)})
        while True:
            try:
                cmd = self.cmds.get()
            except KeyboardInterrupt:
                continue
            c = cmd.get("cmd")
            sel = self.frames[self.cur][0]
            if c == "eval":
                i = int(cmd.get("frame") or 0)
                if not 0 <= i < len(self.frames):
                    i = self.cur
                # an assignment changes the frame's variables (and what the watches show): sent with the result
                evaluate(cmd, self.frames[i][0].f_globals, self.flocals(i), before_result=self.emit_frame)
                continue
            if c == "frame":
                i = int(cmd.get("frame") or 0)
                if 0 <= i < len(self.frames):
                    self.cur = i
                self.emit_frame()
                continue
            if c == "breakpoints":
                self.apply_breakpoints(cmd.get("breakpoints") or [])
                continue
            if c == "watches":
                self.watches = _watch_list(cmd.get("watches"))
                emit({"event": "watches", "watches": self.watch_values(self.cur)})
                continue
            if c not in ("continue", "step", "next", "return"):
                continue
            if self.post_mortem:
                break
            if c == "continue":
                self.set_continue()
            elif c == "step":
                self.set_step()
            elif c == "next":
                self.set_next(sel)
            else:
                self.set_return(sel)
            break
        self.state = "running"
        emit({"event": "running"})


# ------------------------------------------------------------------------------------------------
# main
# ------------------------------------------------------------------------------------------------


def _reader(dbg: Debugger, commands) -> None:
    for line in commands:
        try:
            cmd = json.loads(line)
        except ValueError:
            continue
        c = cmd.get("cmd")
        if c == "stop":
            flush_output()
            emit({"event": "stopped"})
            os._exit(0)
        elif c == "pause":
            dbg.request_pause()
        elif c == "breakpoints":
            bps = cmd.get("breakpoints") or []
            emit({"event": "breakpoints", "breakpoints": check_breakpoints(dbg.repo, bps)})
            if dbg.state == "paused":
                dbg.cmds.put(cmd)
            else:
                dbg.request_breakpoints(bps)
        elif c == "watches":
            if dbg.state == "paused":
                dbg.cmds.put(cmd)
            else:
                # evaluated at the next pause
                dbg.watches = _watch_list(cmd.get("watches"))
                if dbg.watches and dbg.state != "ready":
                    WATCH_HELPER.warm()
                emit({"event": "watches", "watches": [{"expr": w, "ok": None} for w in dbg.watches]})
        else:
            dbg.cmds.put(cmd)
    os._exit(0)  # the API went away


def _load(spec: dict) -> tuple[dict, dict]:
    import pandas as pd

    code_runner._api_module()
    with _redirect():
        errors = code_runner._load(Path(spec["repo"]))
    t = next((x for x in code_runner.REGISTRY if x["key"] == spec["transform"]), None)
    if not t:
        mine = [e["error"] for e in errors if e.get("file") == spec["transform"].split("::")[0]]
        raise LookupError(f"transform {spec['transform']} not found" + (f":\n{mine[0]}" if mine else ""))
    if t["kind"] not in ("df", "transform", *NEW_KINDS):
        raise ValueError("the debugger runs Python transforms (@transform_df / @transform / @transform.using / @transform.spark.using)")
    # the original API gets pandas DataFrames; the current API reads its inputs itself (code_runner._run_new)
    frames = {k: pd.read_parquet(p) for k, p in spec["inputs"].items()} if t["kind"] not in NEW_KINDS else {}
    return t, frames


NEW_KINDS = ("lightweight", "spark")


class _redirect:
    def __enter__(self):
        self.saved = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = OUT, ERR

    def __exit__(self, *exc):
        sys.stdout, sys.stderr = self.saved
        return False


def _result(df, info) -> dict:
    if df is None:
        return {"rows": 0, "columns": [], "preview": [], "dataset_output": False, "incremental": info,
                "outputs": _outputs()}
    df = code_runner._as_frame(df).copy()
    df.columns = [str(c) for c in df.columns]
    head = df.head(100)
    out = {"rows": len(df), "columns": [{"name": c, "type": str(df[c].dtype)} for c in df.columns],
           "preview": [{c: cell(v) for c, v in r.items()} for r in head.to_dict(orient="records")], "dataset_output": True}
    if info:
        info = {k: v for k, v in info.items() if k != "state"}
    out["incremental"] = info
    out["outputs"] = _outputs()
    return out


def _outputs() -> dict:
    """Every output a @transform.using / .spark.using transform wrote (rows, columns, first rows)."""
    try:
        return code_runner._output_previews(dict(code_runner.MULTI_OUTPUTS), 100) if code_runner.MULTI_OUTPUTS else {}
    except Exception:  # noqa: BLE001
        return {}


def run_debug(spec: dict, dbg: Debugger) -> None:
    t, frames = _load(spec)
    fn = t["_fn"]
    dbg.apply_breakpoints(spec.get("breakpoints") or [])
    dbg.watches = _watch_list(spec.get("watches"))
    if dbg.watches:
        WATCH_HELPER.warm()  # started now, ready by the first pause
    if spec.get("stop_on_entry"):
        dbg.entry_code = fn.__code__
    signal.signal(signal.SIGINT, dbg.on_sigint)
    out_dir = Path(spec["media_out"]).parent
    dbg.state = "running"
    code_runner.MULTI_OUTPUTS.clear()
    rows = {k: len(v) for k, v in frames.items()} or _input_rows(spec)
    emit({"event": "running", "function": t["function"], "file": t["file"], "input_rows": rows})
    try:
        if t["kind"] in NEW_KINDS:
            df, info, _media, _checks, aborted = dbg.run(code_runner._run_new, t, spec, OUT, out_dir)
            if aborted:
                flush_output()
                emit({"event": "finished", "result": {**_result(None, None), "aborted": True}})
                return
        else:
            df, info, _media = dbg.run(code_runner._run_transform, t, spec, frames, OUT, out_dir)
    except bdb.BdbQuit:
        emit({"event": "stopped"})
        return
    except BaseException as e:  # noqa: BLE001
        sys.settrace(None)
        msg = _console_traceback(e)
        tb, pm = e.__traceback__, []
        while tb is not None:
            if dbg.in_repo(tb.tb_frame):
                pm.append((tb.tb_frame, tb.tb_lineno))
            tb = tb.tb_next
        if pm and not isinstance(e, KeyboardInterrupt):
            dbg.post_mortem = True
            dbg.interaction(pm[-1][0], "exception", exception=msg, frames=list(reversed(pm)))
        flush_output()
        emit({"event": "error", "error": msg})
        return
    finally:
        sys.settrace(None)
        if t["kind"] == "spark":
            code_runner.code_pyapi.stop_spark()
    flush_output()
    emit({"event": "finished", "result": _result(df, info)})


def _input_rows(spec: dict) -> dict:
    import pyarrow.parquet as pq

    out = {}
    for k, p in (spec.get("inputs") or {}).items():
        try:
            out[k] = pq.ParquetFile(p).metadata.num_rows
        except Exception:  # noqa: BLE001
            out[k] = None
    return out


def _console_new(t: dict, spec: dict, ns: dict, preloaded: list[str]) -> None:
    """The console of a @transform.using / .spark.using transform: its inputs and outputs as the compute function
    gets them (non-incremental), its parameters and models, and ctx."""
    api = code_runner.code_pyapi
    spark = t["kind"] == "spark"
    work = Path(spec["media_out"]).parent / "console-work"
    work.mkdir(parents=True, exist_ok=True)
    In = api.TransformSparkInput if spark else api.LightweightInput
    Out = api.TransformSparkOutput if spark else api.LightweightOutput
    ds_paths = spec.get("inputs") or {}
    media_in = spec.get("media_inputs") or {}
    inputs: dict = {}
    for name, ref in t["inputs"].items():
        if name in ds_paths:
            inputs[name] = In(name, ref, ds_paths[name], select=None, incremental=False, snapshot=False, work=work)
        elif name in media_in and name not in t["media_inputs"]:
            files = [{"path": i["path"], "file": i["file"], "size": i.get("size"), "modified": 0} for i in media_in[name].get("items", [])]
            inputs[name] = In(name, ref, None, files, incremental=False, snapshot=False, added_files=None)
    outputs = {p: Out(p, o["name"], work, None, False, False, OUT) for p, o in t["outputs"].items()}
    kwargs: dict = {**inputs, **outputs}
    spark_fn = api.spark_session if spark else None
    for k, ref in t["media_inputs"].items():
        kwargs[k] = code_runner.code_media.TransformMediaSetInput(ref, media_in.get(k, {}).get("items", []), spark=spark_fn)
    for k in t["media_outputs"]:
        kwargs[k] = code_runner.code_media.TransformMediaSetOutput(Path(spec["media_out"]) / k, lightweight=not spark)
    kwargs.update(code_runner._param_values(t, spec))
    kwargs.update({k: code_runner.code_models.instance(m) for k, m in (t.get("_model_specs") or {}).items()})
    for k, names in (t.get("sets") or {}).items():
        kwargs[k] = [kwargs.pop(n) for n in names if n in kwargs]
    if t["uses_ctx"]:
        kwargs["ctx"] = api.LightweightContext(inputs, False, None, spark=spark_fn)
    api.CURRENT_IO.clear()
    api.CURRENT_IO.update({**inputs, **outputs})
    for k, v in kwargs.items():
        ns[k] = v
        preloaded.append(k)


def run_console(spec: dict, dbg: Debugger) -> None:
    t, frames = _load(spec)
    fn = t["_fn"]
    mod = sys.modules.get(fn.__module__)
    ns: dict = dict(vars(mod)) if mod else {}
    ns["__name__"] = "__console__"
    ns.pop("__builtins__", None)
    try:
        import pandas as pd

        ns.setdefault("pd", pd)
    except ImportError:
        pass
    preloaded: list[str] = []
    if t["kind"] in NEW_KINDS:
        _console_new(t, spec, ns, preloaded)
    elif t["kind"] == "df":
        for k, df in frames.items():
            ns[k] = df
            preloaded.append(k)
    else:
        for k, df in frames.items():
            ns[k] = code_runner.TransformInput(df)
            preloaded.append(k)
        for k in t["media_inputs"]:
            ns[k] = code_runner.TransformMediaSetInput(t["media_inputs"][k], (spec.get("media_inputs") or {}).get(k, {}).get("items", []))
            preloaded.append(k)
        for k in t["media_outputs"]:
            ns[k] = code_runner.TransformMediaSetOutput(Path(spec["media_out"]) / k)
            preloaded.append(k)
        if t["output_param"]:
            ns[t["output_param"]] = code_runner.TransformOutput()
            preloaded.append(t["output_param"])
    if t["uses_ctx"] and "ctx" not in ns:
        ns["ctx"] = code_runner.TransformContext(False)
        preloaded.append("ctx")
    ns[t["function"]] = fn
    signal.signal(signal.SIGINT, dbg.on_sigint)
    dbg.state = "ready"
    flush_output()
    emit({"event": "ready", "preloaded": preloaded, "function": t["function"], "file": t["file"],
          "input_rows": {k: len(v) for k, v in frames.items()} or _input_rows(spec), "variables": variables(ns, hide_code=True)})
    while True:
        try:
            cmd = dbg.cmds.get()
        except KeyboardInterrupt:
            continue
        c = cmd.get("cmd")
        if c == "eval":
            dbg.state = "running"

            def ready() -> None:
                # the namespace's variables after the command, sent before its result (which answers the request)
                dbg.state = "ready"
                flush_output()
                emit({"event": "ready", "variables": variables(ns, hide_code=True)})

            evaluate(cmd, ns, None, console_ns=ns, before_result=ready)
            dbg.state = "ready"
        elif c == "frame":
            emit({"event": "ready", "variables": variables(ns, hide_code=True)})


def main() -> None:
    global _PROTO
    _PROTO = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)  # anything writing to fd 1 directly (C code, subprocesses) goes to stderr, not into the protocol
    spec = json.loads(Path(sys.argv[1]).read_text("utf-8"))
    repo = os.path.abspath(spec["repo"])
    spec["repo"] = repo
    REPO["prefix"] = repo + os.sep
    dbg = Debugger(repo)
    sys.stdout, sys.stderr = OUT, ERR
    # commands come on a duplicate of stdin; fd 0 and sys.stdin become the null device. On Windows a thread blocked
    # reading a pipe blocks every other call on that handle (an import checking sys.stdin would hang until the next
    # command arrived)
    commands = os.fdopen(os.dup(0), "r", encoding="utf-8")
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    sys.stdin = io.StringIO()
    threading.Thread(target=_reader, args=(dbg, commands), daemon=True, name="debug-commands").start()
    emit({"event": "loading"})
    if spec.get("breakpoints"):
        emit({"event": "breakpoints", "breakpoints": check_breakpoints(repo, spec["breakpoints"])})
    try:
        if spec.get("mode") == "console":
            run_console(spec, dbg)
        else:
            run_debug(spec, dbg)
    except BaseException as e:  # noqa: BLE001
        flush_output()
        emit({"event": "error", "error": str(e) if isinstance(e, LookupError) else _console_traceback(e)})
    flush_output()
    _PROTO.flush()
    os._exit(0)


if __name__ == "__main__":
    if sys.argv[1:] == ["--watch-helper"]:
        watch_helper_main()
    else:
        main()
