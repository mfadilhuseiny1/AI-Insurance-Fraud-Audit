"""Runs a Code Workbook's nodes in a subprocess (code_workbook.py writes spec.json; results go to results.json).

Each Python node is a function named after the node whose parameters are the aliases of its inputs (pandas
DataFrames); it returns a DataFrame. The workbook's global code runs first and its names are available in every
node. SQL nodes are DuckDB SQL over their inputs' aliases. Matplotlib figures a node draws are returned as PNGs.
Console mode runs one snippet with every computed node available by alias.

Python nodes take each input as a pandas DataFrame or, with the input type "spark", a PySpark DataFrame (a local
SparkSession, created on first use and kept by the console session); a Spark DataFrame a node returns becomes a
pandas DataFrame for previews, downstream nodes and saving (downstream Spark inputs convert it back). The session
is the one Python transforms get (code_pyapi.spark_session), sized by the workbook's Spark profiles (spec
"spark_profiles": driver memory, cores, shuffle partitions, adaptive execution, cross joins, ...).

R nodes: the node's code defines a function named after the node whose parameters are its inputs' aliases
(data.frames) and returns a data.frame; it runs in Rscript (the platform's R, as R transforms use), the data crossing
as CSV (so types come back as numbers / text / logical; dates are text). An input an R node asks for as a Spark
DataFrame needs the SparkR package in that R (sparkr_status()): without it the node fails saying what is missing.

Session mode (the console's persistent session): `--session` reads one spec path per line on stdin, answers "done"
on stdout after writing that spec's results.json; node outputs are recomputed only when the spec's graph_key changes,
and names the console defines stay defined between calls.

Usage: python code_workbook_runner.py <spec.json>   |   python code_workbook_runner.py --session
"""

from __future__ import annotations

import ast
import base64
import contextlib
import io
import json
import sys
import time
import traceback
from pathlib import Path


def _figures() -> list[str]:
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return []
    out = []
    for n in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(n).savefig(buf, format="png", bbox_inches="tight", dpi=110)
        out.append(base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return out


def _preview(df, rows: int) -> dict:
    import pandas as pd

    head = df.head(rows).copy()
    for c in head.columns:
        if not (pd.api.types.is_numeric_dtype(head[c]) or pd.api.types.is_bool_dtype(head[c])):
            head[c] = head[c].map(lambda v: None if v is None or (isinstance(v, float) and v != v) else str(v))
    data = json.loads(head.to_json(orient="records", date_format="iso"))
    return {"columns": [str(c) for c in df.columns], "dtypes": {str(c): str(t) for c, t in df.dtypes.items()}, "rows": data, "total": int(len(df))}


def _call(code: str, name: str, args: dict, glob: dict):
    ns = dict(glob)
    exec(compile(code, f"<{name}>", "exec"), ns)
    fn = ns.get(name)
    if not callable(fn):
        defs = [k for k, v in ns.items() if callable(v) and getattr(v, "__module__", None) is None and k not in glob]
        fn = ns.get(defs[-1]) if defs else None
    if not callable(fn):
        raise ValueError(f"define a function named {name}(…) that returns a DataFrame")
    import inspect

    params = list(inspect.signature(fn).parameters)
    missing = [p for p in params if p not in args]
    if missing:
        raise ValueError(f"unknown inputs {', '.join(missing)}: parameters must be the aliases of the node's inputs ({', '.join(args) or 'none'})")
    return fn(*[args[p] for p in params])


def _is_model(v) -> bool:
    """A trained model (scikit-learn style: predict / transform), kept as an object rather than a table."""
    import pandas as pd

    return not isinstance(v, (pd.DataFrame, pd.Series, list, dict)) and (hasattr(v, "predict") or hasattr(v, "transform"))


def _model_info(v) -> dict:
    info = {"type": f"{type(v).__module__}.{type(v).__name__}"}
    if hasattr(v, "get_params"):
        try:
            info["params"] = {k: repr(x)[:200] for k, x in v.get_params(deep=False).items()}
        except Exception:  # noqa: BLE001 — parameters are informative only
            pass
    for attr in ("feature_names_in_", "classes_"):
        if hasattr(v, attr):
            info[attr.rstrip("_")] = [str(x) for x in list(getattr(v, attr))[:100]]
    return info


def _as_frame(v, name: str):
    import pandas as pd

    if isinstance(v, pd.DataFrame):
        return v
    if isinstance(v, pd.Series):
        return v.to_frame()
    if hasattr(v, "toPandas"):
        return v.toPandas()
    if isinstance(v, (list, dict)):
        return pd.DataFrame(v)
    raise ValueError(f"{name} must return a DataFrame (got {type(v).__name__})")


def _setup() -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
    except ImportError:
        pass


def main() -> None:
    _setup()
    spec = json.loads(Path(sys.argv[1]).read_text("utf-8"))
    results = run(spec, {})
    (Path(spec["out_dir"]) / "results.json").write_text(json.dumps(results, default=str), "utf-8")


def session() -> None:
    """The console's session: one spec per stdin line; state survives between specs."""
    _setup()
    state: dict = {}
    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
            spec = json.loads(Path(path).read_text("utf-8"))
            results = run(spec, state)
            (Path(spec["out_dir"]) / "results.json").write_text(json.dumps(results, default=str), "utf-8")
        except Exception:  # noqa: BLE001 — the session keeps running; the caller sees no results file
            pass
        sys.stdout.write("done\n")
        sys.stdout.flush()


class _ModelDone(Exception):
    """A Python node returned a model: its result is recorded, there is no table to preview."""


class FileSystem:
    """An imported folder of unstructured files (read-only): paths are relative to the folder."""

    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()

    def _file(self, path: str) -> Path:
        p = (self.root / path).resolve()
        if self.root not in p.parents or not p.is_file():
            raise FileNotFoundError(path)
        return p

    def ls(self, pattern: str = "**/*") -> list[str]:
        return [p.relative_to(self.root).as_posix() for p in sorted(self.root.glob(pattern)) if p.is_file()]

    def open(self, path: str, mode: str = "rb", **kw):
        if any(c in mode for c in "wax+"):
            raise PermissionError("imported files are read-only")
        return self._file(path).open(mode, **kw)

    def path(self, path: str) -> str:
        """A local path to the file (for libraries that want a file name)."""
        return str(self._file(path))

    def filesystem(self) -> "FileSystem":
        return self

    def __repr__(self) -> str:
        return f"<files: {len(self.ls())} files>"


def _spark(state: dict, profiles: list | None = None):
    """The local SparkSession Python transforms get (code_pyapi.spark_session: JDK 17 from BLUESANDAI_JAVA_HOME /
    JAVA_HOME or the project's .java/jdk-*), sized by the workbook's Spark profiles."""
    if state.get("spark") is not None:
        return state["spark"]
    import code_pyapi

    profiles = list(profiles or [])
    # ValueError (unknown / inconsistent profiles) is the node's error
    settings = code_pyapi.spark_settings(profiles)
    code_pyapi.SPARK_CONF.clear()
    # workbooks kept Spark's own default for cross joins (allowed) before they had profiles: keep it
    code_pyapi.SPARK_CONF.update({"cross_join": True, **settings}, app_name="code-workbook")
    try:
        session = code_pyapi.spark_session()
    except RuntimeError as e:
        raise RuntimeError(str(e).replace("Spark transforms", "Spark inputs")) from None
    state["spark"] = session
    state["spark_profiles"] = profiles
    return session


# what a run reports of its Spark session (the settings Spark profiles change)
SPARK_REPORT = ("spark.master", "spark.driver.memory", "spark.sql.shuffle.partitions", "spark.sql.adaptive.enabled", "spark.sql.crossJoin.enabled",
                "spark.sql.autoBroadcastJoinThreshold", "spark.memory.offHeap.enabled", "spark.memory.offHeap.size")


def _spark_info(state: dict) -> dict | None:
    session = state.get("spark")
    if session is None:
        return None
    conf = session.sparkContext.getConf()
    return {"profiles": state.get("spark_profiles") or [], "conf": {k: session.conf.get(k, None) or conf.get(k, None) for k in SPARK_REPORT}}


def sparkr_status(exe: str | None = None) -> dict:
    """Whether the platform's R has the SparkR package: {r, installed, version, library, spark, problem}. SparkR must
    be of pyspark's Spark version (it drives the same JVM classes)."""
    import subprocess
    import tempfile

    import code_r

    exe = exe or code_r.executable()
    if not exe:
        return {"r": None, "installed": False, "problem": "R is not installed (Rscript on the PATH, BLUESANDAI_RSCRIPT, or the project's .r folder)"}
    try:
        from importlib import metadata

        spark = metadata.version("pyspark")
    except Exception:  # noqa: BLE001
        spark = None
    with tempfile.TemporaryDirectory(prefix="workbook-sparkr-") as tmp:
        probe = Path(tmp, "probe.R")
        probe.write_text('cat("R=", paste(R.version$major, R.version$minor, sep = "."), "\\n", sep = "")\n'
                         'cat("LIB=", paste(.libPaths(), collapse = ";"), "\\n", sep = "")\n'
                         'cat("SPARKR=", if (requireNamespace("SparkR", quietly = TRUE)) as.character(utils::packageVersion("SparkR")) else "", "\\n", sep = "")\n', "utf-8")
        try:
            p = subprocess.run([exe, "--vanilla", str(probe)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            return {"r": None, "installed": False, "executable": exe, "problem": f"R did not answer: {e}"}
    got = dict(line.split("=", 1) for line in p.stdout.splitlines() if "=" in line)
    out = {"r": got.get("R") or None, "executable": exe, "library": got.get("LIB") or "", "version": got.get("SPARKR") or None, "spark": spark,
           "installed": bool(got.get("SPARKR"))}
    where = f"the platform's R ({'R ' + out['r'] if out['r'] else 'Rscript'} at {exe}; library {out['library'] or 'unknown'})"
    if not out["installed"]:
        out["problem"] = (f"the SparkR package is not installed in {where}. SparkR is not on CRAN and the pyspark package does not ship it: it comes "
                          f"with a Spark distribution (R/lib/SparkR{', Spark ' + spark if spark else ''})")
    elif spark and out["version"].split(".")[:2] != spark.split(".")[:2]:
        out["installed"] = False
        out["problem"] = f"SparkR {out['version']} in {where} does not match the platform's Spark {spark}"
    return out


def _run_r(code: str, name: str, args: dict, timeout: int = 600, spark_inputs: list | None = None, profiles: list | None = None):
    """An R node: inputs as CSV data.frames, the function's data.frame back. `spark_inputs` (aliases the node asks for
    as Spark DataFrames) need SparkR: they arrive as SparkDataFrames of a local SparkR session, and a SparkDataFrame
    the function returns is collected."""
    import os
    import subprocess
    import tempfile

    import pandas as pd

    import code_r

    exe = code_r.executable()
    if not exe:
        raise RuntimeError("R nodes need R (Rscript on the PATH, BLUESANDAI_RSCRIPT, or the project's .r folder)")
    for a, f in args.items():
        if not hasattr(f, "columns"):
            raise TypeError(f"{a} is not a table: R nodes take datasets and table nodes")
    spark_inputs = [a for a in (spark_inputs or []) if a in args]
    head, tail, env = "", "", None
    if spark_inputs:
        status = sparkr_status(exe)
        if not status["installed"]:
            raise RuntimeError(f"{name} asks for {', '.join(spark_inputs)} as {'a Spark DataFrame' if len(spark_inputs) == 1 else 'Spark DataFrames'}, "
                               f"which needs SparkR: {status['problem']}. Set the input back to R data.frame, or do the Spark step in a Python "
                               "node (PySpark) and pass its result on.")
        import code_java
        import code_pyapi
        import pyspark

        home = code_java.java_home()
        if not home:
            raise RuntimeError("Spark inputs need a JDK 17 (see the README: Java toolchain)")
        st = code_pyapi.spark_settings(list(profiles or []))
        conf = {"spark.driver.memory": f"{int(st.get('driver_memory_mb', 2048) + st.get('executor_memory_mb', 0))}m", "spark.ui.enabled": "false",
                "spark.driver.host": "127.0.0.1", "spark.driver.bindAddress": "127.0.0.1", "spark.sql.session.timeZone": "UTC",
                "spark.sql.shuffle.partitions": str(st.get("shuffle_partitions", 4)), **(st.get("conf") or {})}
        env = {**os.environ, "JAVA_HOME": str(home), "SPARK_HOME": str(Path(pyspark.__file__).parent)}
        rq = lambda v: '"' + str(v).replace("\\", "/").replace('"', '\\"') + '"'  # noqa: E731
        head = ("suppressPackageStartupMessages(library(SparkR))\n"
                f"sparkR.session(master = \"local[2]\", appName = \"code-workbook-r\", sparkConfig = list({', '.join(f'{rq(k)} = {rq(v)}' for k, v in conf.items())}))\n")
        head += "".join(f"{a} <- SparkR::as.DataFrame({a})\n" for a in spark_inputs)
        tail = 'if (methods::is(out, "SparkDataFrame")) out <- SparkR::collect(out)\n'
    with tempfile.TemporaryDirectory(prefix="workbook-r-") as tmp:
        d = Path(tmp)
        for a, f in args.items():
            f.to_csv(d / f"{a}.csv", index=False)
        (d / "node.R").write_text(code, "utf-8")
        q = lambda p: '"' + str(p).replace("\\", "/").replace('"', '\\"') + '"'  # noqa: E731
        reads = "\n".join(f"{a} <- read.csv({q(d / (a + '.csv'))}, stringsAsFactors = FALSE, check.names = FALSE)" for a in args)
        script = (f"{reads}\n{head}source({q(d / 'node.R')})\n"
                  f"if (!exists({q(name)}) || !is.function(get({q(name)}))) stop('define a function named {name}')\n"
                  f"out <- {name}({', '.join(args)})\n{tail}"
                  "if (!is.data.frame(out)) out <- as.data.frame(out)\n"
                  f"write.csv(out, {q(d / 'out.csv')}, row.names = FALSE, na = '')\n")
        (d / "run.R").write_text(script, "utf-8")
        p = subprocess.run([exe, "--vanilla", str(d / "run.R")], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                           env=env)
        if p.stdout:
            print(p.stdout, end="")
        if p.returncode != 0:
            err = (p.stderr or "R failed").strip()[-3000:]
            if "SparkR" in err and "there is no package called" in err:
                problem = sparkr_status(exe).get("problem") or ""
                err += "\n" + problem[:1].upper() + problem[1:]
            raise RuntimeError(err)
        if p.stderr:
            print(p.stderr, end="", file=sys.stderr)
        out = d / "out.csv"
        try:
            return pd.read_csv(out) if out.stat().st_size else pd.DataFrame()
        except pd.errors.EmptyDataError:
            return pd.DataFrame()


def _is_spark(v) -> bool:
    return type(v).__module__.startswith("pyspark.sql") and type(v).__name__ == "DataFrame"


def run(spec: dict, state: dict) -> dict:
    """Compute the spec's nodes (unless the session already holds them for this graph) and run its console snippet."""
    import duckdb
    import pandas as pd

    out_dir = Path(spec["out_dir"])
    key = spec.get("graph_key")
    if key and state.get("graph_key") == key and not any(n.get("persist") for n in spec["nodes"]):
        frames, glob = state["frames"], state["glob"]
        results: dict = {"nodes": state["node_results"], "reused": True}
        if state.get("global_error"):
            results["global_error"] = state["global_error"]
        results["spark"] = _spark_info(state)
        return _console(spec, frames, glob, state, results)
    frames: dict[str, pd.DataFrame] = {}
    for alias, path in spec["inputs"].items():
        if isinstance(path, dict) and path.get("model"):
            import pickle

            frames[alias] = pickle.loads(Path(path["model"]).read_bytes())
        else:
            frames[alias] = FileSystem(path["files"]) if isinstance(path, dict) else pd.read_parquet(path)
    glob: dict = {"__name__": "__workbook__", "pd": pd}
    results = {"nodes": {}}
    if spec.get("global_python"):
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                exec(compile(spec["global_python"], "<global code>", "exec"), glob)
        except Exception:  # noqa: BLE001 — reported, every Python node then fails with it
            results["global_error"] = traceback.format_exc(limit=3)
    for node in spec["nodes"]:
        name, started = node["name"], time.monotonic()
        res: dict = {}
        buf = io.StringIO()
        try:
            if results.get("global_error") and node["kind"] == "python":
                raise RuntimeError("the global code failed:\n" + results["global_error"])
            missing = [a for a in node["inputs"] if a not in frames]
            if missing:
                raise RuntimeError(f"input {', '.join(missing)} did not compute")
            args = {a: frames[a] for a in node["inputs"]}
            if node["kind"] == "python":
                for a, t in (node.get("input_types") or {}).items():
                    if t == "spark" and a in args and hasattr(args[a], "columns"):
                        sp = _spark(state, spec.get("spark_profiles"))
                        # through Arrow with the types Spark lacks converted (unsigned integers, nullable integer dtypes)
                        import code_pyapi

                        if not len(args[a].columns):
                            args[a] = sp.createDataFrame([], "dummy string").drop("dummy")
                        else:
                            try:
                                table = code_pyapi.to_arrow(args[a])
                            except Exception:  # noqa: BLE001 - mixed-type object columns: Spark's own inference
                                table = None
                            args[a] = code_pyapi.spark_frame(table) if table is not None else sp.createDataFrame(args[a])
                if "spark" in (node.get("input_types") or {}).values():
                    glob["spark"] = _spark(state, spec.get("spark_profiles"))
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                if node["kind"] == "python":
                    out = _call(node["code"], name, args, glob)
                    if _is_spark(out):
                        out = out.toPandas()
                    if _is_model(out):
                        # a model output: downstream Python nodes receive the object; Save keeps it (pickle)
                        frames[name] = out
                        res["model"] = _model_info(out)
                        if node.get("persist"):
                            try:
                                import cloudpickle as pickle  # models defined in the workbook's own code too
                            except ImportError:
                                import pickle

                            (out_dir / f"{name}.model.pkl").write_bytes(pickle.dumps(out))
                            res["persisted"] = True
                        raise _ModelDone()
                    df = _as_frame(out, name)
                elif node["kind"] == "sql":
                    con = duckdb.connect(config={"enable_external_access": False})
                    for a, f in args.items():
                        if isinstance(f, FileSystem):
                            raise TypeError(f"{a} is a folder of files: read it in a Python node")
                        if not hasattr(f, "columns"):
                            raise TypeError(f"{a} is a model: use it in a Python node")
                        con.register(a, f)
                    df = con.execute(node["code"]).df()
                    con.close()
                elif node["kind"] == "r":
                    df = _run_r(node["code"], name, args, spark_inputs=[a for a, t in (node.get("input_types") or {}).items() if t == "spark"],
                                profiles=spec.get("spark_profiles"))
                elif node["kind"] == "manual":
                    df = pd.DataFrame(node["rows"], columns=node["columns"])
                else:
                    raise ValueError(f"unknown node kind {node['kind']}")
            frames[name] = df
            res.update(_preview(df, spec.get("preview_rows", 100)))
            if node.get("persist"):
                df.to_parquet(out_dir / f"{name}.parquet", index=False)
                res["persisted"] = True
        except _ModelDone:
            pass
        except Exception as e:  # noqa: BLE001 — the node's error, shown on the node
            tb = traceback.format_exc()
            res["error"] = f"{type(e).__name__}: {e}"
            res["traceback"] = tb[-3000:]
        res["figures"] = _figures()
        res["logs"] = buf.getvalue()[-20000:]
        res["ms"] = int((time.monotonic() - started) * 1000)
        results["nodes"][name] = res
    if key:
        state.update(graph_key=key, frames=frames, glob=glob, node_results=results["nodes"], global_error=results.get("global_error"))
    results["spark"] = _spark_info(state)
    return _console(spec, frames, glob, state, results)


def _console(spec: dict, frames: dict, glob: dict, state: dict, results: dict) -> dict:
    """The console snippet: Python sees the nodes by alias plus what earlier snippets defined (in a session)."""
    import duckdb
    import pandas as pd

    if spec.get("console"):
        c = spec["console"]
        buf = io.StringIO()
        res = {}
        user = state.setdefault("user", {})
        try:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                if c["language"] == "sql":
                    con = duckdb.connect(config={"enable_external_access": False})
                    for a, f in {**frames, **{k: v for k, v in user.items() if isinstance(v, pd.DataFrame)}}.items():
                        if isinstance(f, pd.DataFrame):
                            con.register(a, f)
                    value = con.execute(c["code"]).df()
                else:
                    ns = {**glob, **frames, **user}
                    before = set(ns)
                    tree = ast.parse(c["code"])
                    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
                    try:
                        exec(compile(tree, "<console>", "exec"), ns)
                        value = eval(compile(ast.Expression(last.value), "<console>", "eval"), ns) if last else None
                    finally:
                        # names the snippet defined or rebound stay for the next snippet (in a session)
                        for k, v in ns.items():
                            if k.startswith("__"):
                                continue
                            if k not in before or (k in user and user[k] is not v) or (k in frames and frames[k] is not v) or (k in glob and glob[k] is not v):
                                user[k] = v
            if isinstance(value, (pd.DataFrame, pd.Series)):
                res["table"] = _preview(value if isinstance(value, pd.DataFrame) else value.to_frame(), 200)
            elif value is not None:
                if type(value).__module__ == "numpy" and hasattr(value, "item"):
                    value = value.item()  # numpy scalars read as plain numbers
                res["value"] = repr(value)[:20000]
        except Exception as e:  # noqa: BLE001
            res["error"] = f"{type(e).__name__}: {e}"
            res["traceback"] = traceback.format_exc()[-3000:]
        res["figures"] = _figures()
        res["logs"] = buf.getvalue()[-20000:]
        results["console"] = res
        results["session_names"] = sorted(user)[:200]
    return results


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--session":
        session()
    else:
        main()
