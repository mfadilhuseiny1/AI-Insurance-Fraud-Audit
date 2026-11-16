"""Runs a Code Repositories transform in its own process (started by code_repos.py).

Reads spec.json: {mode: list | test | preview | build, repo, transform ("path::function"), inputs ({name:
parquet path}), media_inputs ({name: {items: [{id, path, file, size, content_type, updated_at}]}}: media sets, and
folders read as datasets without a schema), out, media_out (folder for media items written), media_existing
({param: {path: item id}}), previous_output / previous_outputs (Parquet files of outputs as last built, for
incremental builds), incremental_state, force_snapshot, parameters, resources, library_paths, limit}. Installs
the `transforms.api` / `transforms.mediasets` / `transforms.expectations` modules (code_pyapi.py), imports the
repository's Python files, reads its .sql files (code_sql.py) and .java files (code_java.py), then lists the
declared transforms (with a logic version each), runs the unit tests (pytest), or runs one transform. Writes
result.json next to spec.json; print() and logging (INFO and above) in user code are captured as logs.

Incremental transforms (`@incremental` above a transform decorator): an input whose rows so far are an unchanged
prefix of its current rows is read incrementally ('added' = the new rows, 'previous' = the rows already
processed, 'current' = all); with allow_user_deletes, rows deleted since the last build are allowed too (the
input's row hashes are kept). Retention here only deletes old transaction copies, never rows of a dataset's
current view, so every removed row is a user delete: allow_retention alone does not keep such a build incremental.
A folder input is incremental when files were only added. Outputs
then append ('modify') unless set_mode('replace'). Anything else (first build, an input rewritten, an output
changed outside builds, a new semantic_version, an output aborted on its own last time) runs as a snapshot —
or fails when require_incremental=True (except on the first build or after a semantic_version change).
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib
import importlib.util
import inspect
import io
import json
import logging
import math
import os
import subprocess
import py_compile
import re
import sys
import traceback
from collections import Counter
from pathlib import Path

import code_expectations
import code_foundryts
import code_functions
import code_java
import code_media
import code_models
import model_lib
import code_r
import code_pyapi
import code_sql
import code_tables
from code_pyapi import CURRENT_FILE, REGISTRY, TransformContext, TransformInput, TransformOutput, as_frame

NEW_KINDS = ("lightweight", "spark")


class CheckFailed(Exception):
    def __init__(self, message: str, results: list[dict]) -> None:
        super().__init__(message)
        self.results = results


# ------------------------------------------------------------------------------------------------
# loading the repository
# ------------------------------------------------------------------------------------------------


def _load_sql(repo: Path, errors: list) -> None:
    for path in sorted(repo.rglob("*.sql")):
        rel = path.relative_to(repo).as_posix()
        if rel.startswith("libs/") or "/resources/" in f"/{rel}" or rel.endswith(".duckdb.sql"):
            continue
        try:
            text = path.read_text("utf-8")
            if not re.search(r"(?i)\bcreate\s+table\b", text):
                continue  # a query file read by Python code (sql_from_file), not a SQL transform
            for s in code_sql.parse(text):
                REGISTRY.append(code_pyapi._entry(f"{rel}::{s['output']['name']}", rel, s["output"]["name"], s["line"], "sql", s["output"], s["inputs"],
                                                  _sql=s["select"]))
        except ValueError as e:
            errors.append({"file": rel, "error": str(e)})


def _load_java(repo: Path, errors: list) -> None:
    """Java transforms (code_java.py): the project is compiled and its PipelineDefiner asked what it registers."""
    if not code_java.has_java(repo):
        return
    if not code_java.available():
        first = next(iter(sorted(repo.rglob("*.java"))), None)
        errors.append({"file": first.relative_to(repo).as_posix() if first else "", "error": code_java.NO_JDK, "warning": True})
        return
    try:
        entries, errs = code_java.list_repo(repo)
    except Exception as e:  # noqa: BLE001
        errors.append({"file": "", "error": f"Java: {e}"})
        return
    REGISTRY.extend(entries)
    errors.extend(errs)


def src_roots(repo: Path) -> list[Path]:
    """Python source folders: src/ and every src/ holding a setup.py (transforms-python/src), deepest first."""
    roots = {p.parent for p in repo.rglob("setup.py") if p.parent.name == "src"}
    if (repo / "src").is_dir():
        roots.add(repo / "src")
    return sorted(roots, key=lambda p: -len(p.parts))


def _load(repo: Path, libraries: list[str] | None = None) -> list[dict]:
    """Import Python files and discover .sql, Java, and R transforms; return per-file errors."""
    errors: list[dict] = []
    CURRENT_FILE["root"] = str(repo)
    roots = src_roots(repo)
    for lib in libraries or []:
        sys.path.insert(0, lib)
    for root in [repo, *reversed(roots)]:
        sys.path.insert(0, str(root))
    for path in sorted(repo.rglob("*.py")):
        rel = path.relative_to(repo).as_posix()
        if rel == "setup.py" or rel.endswith("/setup.py") or "/conda_recipe/" in f"/{rel}":
            continue
        try:
            py_compile.compile(str(path), doraise=True)
        except py_compile.PyCompileError as e:
            errors.append({"file": rel, "error": str(e.exc_value) if hasattr(e, "exc_value") else str(e)})
            continue
        base = next((r for r in roots if path.is_relative_to(r)), repo)
        module = ".".join(path.relative_to(base).with_suffix("").parts)
        if module.endswith(".__init__"):
            module = module[: -len(".__init__")]
        CURRENT_FILE["path"] = rel
        try:
            if module in sys.modules:
                continue
            spec = importlib.util.spec_from_file_location(module, path, submodule_search_locations=[str(path.parent)] if path.name == "__init__.py" else None)
            mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
            sys.modules[module] = mod
            spec.loader.exec_module(mod)  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            sys.modules.pop(module, None)
            errors.append({"file": rel, "error": traceback.format_exc(limit=3)[-1500:]})
    _load_sql(repo, errors)
    _load_java(repo, errors)
    r_entries, r_errors = code_r.load_transforms(repo)
    REGISTRY.extend(r_entries)
    errors.extend(r_errors)
    for t in REGISTRY:
        if t.get("blocked"):
            errors.append({"file": t["file"], "error": f"{t['function']}: {t['blocked']} (it cannot be built)", "warning": True})
    return errors


def _setup_entry_point(repo: Path) -> tuple[str, str] | None:
    """The `transforms.pipelines` root entry point of setup.py: (module, attribute)."""
    for setup in [repo / "src" / "setup.py", repo / "setup.py", *sorted(repo.rglob("setup.py"))]:
        if not setup.is_file():
            continue
        text = setup.read_text("utf-8", "replace")
        m = re.search(r"""['"]transforms\.pipelines['"]\s*:\s*\[([^\]]*)\]""", text)
        if not m:
            continue
        for spec in re.findall(r"""['"]([^'"]+)['"]""", m.group(1)):
            name, _, target = spec.partition("=")
            if name.strip() == "root" and ":" in target:
                mod, attr = target.strip().split(":", 1)
                return mod.strip(), attr.strip()
        return ("", "")
    return None


def _apply_pipeline(repo: Path, errors: list) -> None:
    """With a setup.py entry point, only the transforms added to its Pipeline can be built."""
    ep = _setup_entry_point(repo)
    if ep is None:
        return
    mod_name, attr = ep
    if not mod_name:
        errors.append({"file": "setup.py", "error": "EntryPointError: Key root was not found, please check your repo's meta.yaml and setup.py files"})
        return
    try:
        mod = sys.modules.get(mod_name) or importlib.import_module(mod_name)
        pipeline = getattr(mod, attr)
    except Exception as e:  # noqa: BLE001
        errors.append({"file": "setup.py", "error": f"EntryPointError: the root entry point {mod_name}:{attr} cannot be loaded ({e})"})
        return
    if not isinstance(pipeline, code_pyapi.Pipeline):
        errors.append({"file": "setup.py", "error": f"EntryPointError: {mod_name}:{attr} is not a transforms.api.Pipeline"})
        return
    keep = {id(tr._entry) for tr in pipeline.transforms}
    for t in list(REGISTRY):
        if t["language"] == "python" and id(t) not in keep:
            REGISTRY.remove(t)
            errors.append({"file": t["file"], "warning": True,
                           "error": f"{t['function']} is not in the pipeline ({mod_name}.{attr}): add it with discover_transforms or add_transforms to build it"})


def _logic_versions(repo: Path) -> None:
    """Transform logic level versioning: a Python transform's version hashes its module, the repository modules it
    depends on (transitively), the project's dependencies (meta.yaml) and the build.gradle tllvFiles. With
    `tllv false` in build.gradle every file counts."""
    gradle = "\n".join(re.sub(r"//[^\n]*|/\*.*?\*/", "", p.read_text("utf-8", "replace"), flags=re.S) for p in repo.rglob("build.gradle"))
    tllv = not re.search(r"\btllv\s*(=\s*)?false\b", gradle)
    extra_files = re.findall(r"""['"]([^'"]+)['"]""", " ".join(re.findall(r"tllvFiles\s*(?:=|\()?\s*\[?([^\]\n)]*)", gradle)))
    meta = "\n".join(p.read_text("utf-8", "replace") for p in sorted(repo.rglob("meta.yaml")))
    base = hashlib.sha256(meta.encode())
    for f in extra_files:
        cand = [repo / f, repo / "src" / f, *repo.rglob(Path(f).name)]
        p = next((c for c in cand if c.is_file()), None)
        base.update(f.encode() + (p.read_bytes() if p else b"<missing>"))
    if not tllv:
        h = base.copy()
        for p in sorted(repo.rglob("*")):
            if p.is_file():
                h.update(p.relative_to(repo).as_posix().encode() + p.read_bytes())
        for t in REGISTRY:
            if t["language"] == "python":
                t["version"] = h.hexdigest()[:16]
        return
    root = repo.resolve()
    repo_mods: dict[str, Path] = {}
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        # isinstance: ontology_sdk modules (code_functions) make up an attribute for any name, __file__ included
        if isinstance(f, str) and f:
            try:
                Path(f).resolve().relative_to(root)
                repo_mods[name] = Path(f)
            except ValueError:
                pass

    def deps(name: str) -> set[str]:
        out = set()
        mod = sys.modules.get(name)
        for v in list(vars(mod).values()) if mod else []:
            m = v.__name__ if inspect.ismodule(v) else getattr(v, "__module__", None)
            if isinstance(m, str) and m in repo_mods and m != name:
                out.add(m)
        return out

    closure_cache: dict[str, set[str]] = {}

    def closure(name: str) -> set[str]:
        if name in closure_cache:
            return closure_cache[name]
        seen, todo = {name}, [name]
        while todo:
            for d in deps(todo.pop()):
                if d not in seen:
                    seen.add(d)
                    todo.append(d)
        closure_cache[name] = seen
        return seen

    for t in REGISTRY:
        if t["language"] != "python":
            continue
        fn = t.get("_fn")
        mod = getattr(fn, "__module__", None)
        h = base.copy()
        files = sorted({repo_mods[m] for m in closure(mod) if m in repo_mods}) if mod in repo_mods else [repo / t["file"]]
        for f in files:
            h.update(f.resolve().relative_to(root).as_posix().encode() + f.read_bytes())
        t["version"] = h.hexdigest()[:16]


# ------------------------------------------------------------------------------------------------
# tests
# ------------------------------------------------------------------------------------------------


def _is_test_file(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1]
    return name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py"))


def _run_pytest(repo: Path, only: str | None, logs: io.StringIO, workers: int | None = None, library_paths: list[str] | None = None) -> list[dict] | None:
    """The repository's tests with pytest (fixtures, parametrize, unittest, pytest.ini / --cov ...) and a
    session-scoped `spark_session` fixture (code_pytest_plugin). `workers`: tasks.pytest { numProcesses "N" } with
    pytest-xdist (each worker loads the plugin and the repository's source folders). None when pytest is not
    installed."""
    try:
        import pytest
    except ImportError:
        return None
    roots = src_roots(repo)
    root = roots[0] if len(roots) == 1 else repo
    results: list[dict] = []

    def rel_of(p) -> str:
        try:
            return Path(str(p)).resolve().relative_to(repo.resolve()).as_posix()
        except ValueError:
            return str(p)

    class Plugin:
        def pytest_runtest_logreport(self, report):
            if report.when == "call" or (report.when == "setup" and report.outcome != "passed"):
                file, line, name = report.location
                out = "".join(c for _, c in getattr(report, "sections", []) if c)
                err = None
                if report.failed:
                    err = str(report.longreprtext)[-3000:]
                elif report.skipped and isinstance(report.longrepr, tuple):
                    err = str(report.longrepr[2])
                results.append({"file": rel_of(report.fspath), "name": name, "line": (line or 0) + 1, "ok": not report.failed,
                                "skipped": bool(report.skipped), "error": err, "ms": int(report.duration * 1000), "output": out[-2000:]})

        def pytest_collectreport(self, report):
            if report.failed:
                results.append({"file": rel_of(report.fspath), "name": "collection", "line": 0, "ok": False, "error": str(report.longreprtext)[-3000:], "ms": 0})

    targets = [repo / only] if only else ([str(r) for r in roots] or [repo])
    if only and not targets[0].is_file():
        return []
    args = [*map(str, targets), "-q", "-p", "no:cacheprovider", "-p", "code_pytest_plugin", "--rootdir", str(root), "--color=no",
            "-o", "python_files=test_*.py *_test.py", "-W", "ignore::DeprecationWarning"]
    if workers and workers > 1:
        if importlib.util.find_spec("xdist") is None:
            logs.write("numProcesses is set but pytest-xdist is not installed: the tests run in one process\n")
        else:
            # workers import the plugin from this folder and the repository's code from its source folders
            here = str(Path(__file__).resolve().parent)
            os.environ["PYTHONPATH"] = os.pathsep.join(dict.fromkeys([here, *[str(r) for r in roots], str(repo), *(library_paths or []),
                                                                      *[p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]]))
            os.environ["BLUESANDAI_REPO_ROOT"] = str(repo)
            os.environ["BLUESANDAI_SPARK_CONF"] = json.dumps(code_pyapi.SPARK_CONF, default=str)
            args += ["-n", str(workers)]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        code = pytest.main(args, plugins=[Plugin()])
    logs.write(buf.getvalue()[-20000:])
    if int(code) not in (0, 5) and all(r["ok"] for r in results):
        tail = "\n".join(buf.getvalue().strip().splitlines()[-15:])
        results.append({"file": "", "name": "pytest session" if "Required test coverage" not in tail else "coverage", "line": 0, "ok": False,
                        "error": tail, "ms": 0})
    return sorted(results, key=lambda t: (t["file"], t["line"]))


def _run_tests(repo: Path, only: str | None, logs: io.StringIO, workers: int | None = None, library_paths: list[str] | None = None) -> list[dict]:
    """pytest when installed; otherwise every test_* function in test files, called without arguments."""
    res = _run_pytest(repo, only, logs, workers, library_paths)
    if res is not None:
        return res
    import time

    out = []
    for name, mod in list(sys.modules.items()):
        path = getattr(mod, "__file__", None)
        if not path:
            continue
        try:
            rel = Path(path).resolve().relative_to(repo.resolve()).as_posix()
        except ValueError:
            continue
        if not _is_test_file(rel) or (only and rel != only):
            continue
        for fname, fn in inspect.getmembers(mod, inspect.isfunction):
            if not fname.startswith("test") or fn.__module__ != mod.__name__:
                continue
            started = time.monotonic()
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf):
                    fn()
                out.append({"file": rel, "name": fname, "line": fn.__code__.co_firstlineno, "ok": True, "error": None})
            except AssertionError as e:
                tb = traceback.extract_tb(e.__traceback__)
                where = next((f"line {f.lineno}: {f.line}" for f in reversed(tb) if f.filename == path), "")
                out.append({"file": rel, "name": fname, "line": fn.__code__.co_firstlineno, "ok": False,
                            "error": f"AssertionError {e}".strip() + (f" ({where})" if where else "")})
            except Exception:  # noqa: BLE001
                out.append({"file": rel, "name": fname, "line": fn.__code__.co_firstlineno, "ok": False, "error": traceback.format_exc(limit=4)[-2000:]})
            out[-1]["ms"] = int((time.monotonic() - started) * 1000)
            out[-1]["output"] = buf.getvalue()[-2000:]
            logs.write(buf.getvalue())
    return sorted(out, key=lambda t: (t["file"], t["line"]))


# ------------------------------------------------------------------------------------------------
# incremental planning
# ------------------------------------------------------------------------------------------------


def _cell(v):
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if hasattr(v, "item"):
        try:
            return _cell(v.item())
        except Exception:  # noqa: BLE001
            pass
    if isinstance(v, (list, tuple)):
        return [_cell(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _cell(x) for k, x in v.items()}
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, bytes):
        return f"<{len(v)} bytes>"
    try:
        import pandas as pd

        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return str(v)


def frame_hash(df) -> str:
    """Content hash of a DataFrame (column names + values), to tell an appended input from a rewritten one."""
    import pandas as pd

    head = ",".join(f"{c}:{df[c].dtype}" for c in df.columns).encode()
    try:
        values = pd.util.hash_pandas_object(df, index=False).values.tobytes()
    except Exception:  # noqa: BLE001
        values = df.to_json(orient="records", date_format="iso", default_handler=str).encode()
    return hashlib.sha256(head + values).hexdigest()[:32]


def _row_hashes(df) -> list[int]:
    import pandas as pd

    try:
        return [int(x) for x in pd.util.hash_pandas_object(df, index=False).values]
    except Exception:  # noqa: BLE001
        return [int(hashlib.sha256(r.encode()).hexdigest()[:15], 16) for r in df.astype(str).agg("\x1f".join, axis=1)]


def _encode_hashes(hs: list[int]) -> str:
    import numpy as np

    return base64.b64encode(np.asarray(hs, dtype=np.uint64).tobytes()).decode()


def _decode_hashes(s: str) -> list[int]:
    import numpy as np

    return [int(x) for x in np.frombuffer(base64.b64decode(s), dtype=np.uint64)]


def _file_sig(i: dict) -> str:
    return f"{i.get('size')}:{i.get('updated_at')}"


def _plan_incremental(t: dict, frames: dict, spec: dict, folders: dict | None = None, media: dict | None = None) -> dict:
    """Whether this build can run incrementally, which rows / files / media items of each input were processed
    before, and the batches of transaction-limited inputs."""
    inc = t["incremental"]
    state = spec.get("incremental_state") or None
    snapshots = set(inc["snapshot_inputs"])
    # every removed row is a user delete: retention (dataset_retention.py) never removes rows of a current view
    allow_deletes = bool(inc.get("allow_user_deletes"))
    reason = None
    if spec.get("force_snapshot"):
        reason = "a snapshot build was requested"
    elif not state:
        reason = "first build"
    elif int(state.get("semantic_version", -1)) != inc["semantic_version"]:
        reason = f"semantic_version changed ({state.get('semantic_version')} → {inc['semantic_version']})"
    elif state.get("inconsistent"):
        reason = "InconsistentProvenanceRecords: provenance records for the previous build are inconsistent (some outputs were aborted)"
    elif t.get("outputs") is not None and t["kind"] in NEW_KINDS and spec.get("previous_output_reason"):
        reason = spec["previous_output_reason"]
    elif t.get("outputs") is None and not spec.get("previous_output"):
        reason = spec.get("previous_output_reason") or "the output as last built is missing"
    select: dict[str, tuple] = {}
    added_files: dict[str, set] = {}
    notes: list[str] = []
    if reason is None:
        for name, df in frames.items():
            if name in snapshots:
                continue
            seen = (state.get("inputs") or {}).get(name)
            if not seen or "rows" not in seen:
                reason = f"input {name} is new"
                break
            n = int(seen.get("rows") or 0)
            if len(df) >= n and frame_hash(df.iloc[:n]) == seen.get("hash"):
                select[name] = ("prefix", n)
                continue
            if seen.get("row_hashes"):
                prev = Counter(_decode_hashes(seen["row_hashes"]))
                previous_idx, added_idx = [], []
                for i, h in enumerate(_row_hashes(df)):
                    if prev[h] > 0:
                        prev[h] -= 1
                        previous_idx.append(i)
                    else:
                        added_idx.append(i)
                removed = sum(prev.values())
                if allow_deletes:
                    select[name] = ("index", previous_idx, added_idx)
                    if removed:
                        notes.append(f"{removed:,} rows were deleted from {name} (allowed by allow_user_deletes)")
                    continue
                if removed and inc.get("allow_retention"):
                    reason = (f"{removed:,} rows were deleted from input {name} outside retention policies (retention only removes old "
                              "transaction copies, never rows of a dataset's current view): allow_user_deletes=True keeps such builds incremental")
                    break
            reason = f"input {name} was rewritten (not only appended to) since the last build"
            break
    if reason is None:
        for name, items in (folders or {}).items():
            if name in snapshots:
                continue
            seen = (state.get("inputs") or {}).get(name)
            if not seen or "files" not in seen:
                reason = f"input {name} is new"
                break
            cur = {i["path"]: _file_sig(i) for i in items}
            prev = seen["files"]
            changed = [p for p, s in prev.items() if p in cur and cur[p] != s]
            removed = [p for p in prev if p not in cur]
            if changed or (removed and not allow_deletes):
                reason = f"files of input {name} were {'modified' if changed else 'deleted'} since the last build"
                break
            added_files[name] = {p for p in cur if p not in prev}
            if removed:
                notes.append(f"{len(removed)} files were deleted from {name}")
    # media set inputs (v2 semantics): items are processed once; overwrites and deletions keep the build incremental,
    # a replaced media set does not (unless it is a snapshot input)
    media_modes: dict[str, dict] = {}
    media_v2 = bool(inc.get("v2_semantics"))
    if reason is None and media_v2:
        for name, items in (media or {}).items():
            if name in snapshots:
                continue
            seen = (state.get("inputs") or {}).get(name)
            if not seen or "media_ids" not in seen:
                reason = f"media set input {name} is new"
                break
            if seen.get("replaced_at") != (spec.get("media_replaced") or {}).get(name):
                reason = f"the contents of media set input {name} were replaced since the last build"
                break
    if reason and inc["require_incremental"] and not (reason is not None and (not state or reason.startswith("semantic_version"))) and not spec.get("force_snapshot"):
        raise RuntimeError(f"require_incremental=True but this build cannot run incrementally: {reason}")
    if media_v2:
        limits = t.get("media_batch_limits") or {}
        for name, items in (media or {}).items():
            current = [i for i in items if not i.get("overwritten")] + [i for i in items if i.get("overwritten")]
            prev_ids = set(((state or {}).get("inputs") or {}).get(name, {}).get("media_ids") or []) if reason is None and name not in snapshots else set()
            added = sorted((i for i in current if i["id"] not in prev_ids), key=lambda i: str(i.get("updated_at")))
            if name in limits and len(added) > limits[name]:
                notes.append(f"media set {name}: processing {limits[name]} of {len(added)} new items (batch_limit)")
                added = added[: limits[name]]
            media_modes[name] = {"added": {i["id"] for i in added}, "previous": {i["id"] for i in current if i["id"] in prev_ids}}
    # transaction limits (v2 semantics): at most N unprocessed transactions of an input per job
    ranges: dict[str, dict] = {}
    for name, limit in (t.get("transaction_limits") or {}).items():
        txs = (spec.get("input_transactions") or {}).get(name) or []
        if not txs or name not in frames:
            continue
        bad = [tx for tx in txs[1:] if tx["type"] != "APPEND"]
        if bad:
            raise RuntimeError(f"Build2:InvalidTransactionTypeForBatchInputResolution: the current view of input {name} has a "
                               f"{bad[0]['type']} transaction ({bad[0]['id']}); transaction limits need APPEND transactions after the start")
        seen = ((state or {}).get("inputs") or {}).get(name) or {}
        start_idx, start_rows = 0, 0
        if reason is None and seen.get("last_tx") in [tx["id"] for tx in txs]:
            start_idx = [tx["id"] for tx in txs].index(seen["last_tx"]) + 1
            start_rows = int(seen.get("rows") or 0)
        batch = txs[start_idx:start_idx + limit]
        end_rows = int(batch[-1]["rows"]) if batch else start_rows
        end_rows = min(end_rows, len(frames[name]))
        select[name] = ("range", start_rows, end_rows)
        ranges[name] = {"current_view": [txs[0]["id"], txs[-1]["id"]], "processed_batch": [batch[0]["id"], batch[-1]["id"]] if batch else None,
                        "previous_end": seen.get("view_end"), "last_read": seen.get("last_tx"), "last_tx": batch[-1]["id"] if batch else seen.get("last_tx"),
                        "view_end": txs[-1]["id"], "remaining": len(txs) - start_idx - len(batch), "limit": limit, "rows": [start_rows, end_rows]}
    return {"incremental": reason is None, "reason": reason, "select": select, "added_files": added_files, "snapshots": snapshots, "notes": notes,
            "media_modes": media_modes, "ranges": ranges}


def _input_state(t: dict, frames: dict, folders: dict, plan: dict | None = None, spec: dict | None = None) -> dict:
    inc = t["incremental"] or {}
    keep_rows = bool(inc.get("allow_retention") or inc.get("allow_user_deletes"))
    ranges = (plan or {}).get("ranges") or {}
    out = {}
    for k, v in frames.items():
        if k in ranges:
            # a transaction-limited input: what this job processed, up to the end of its batch
            end = ranges[k]["rows"][1]
            out[k] = {"rows": int(end), "hash": frame_hash(v.iloc[:end]), "last_tx": ranges[k]["last_tx"], "view_end": ranges[k]["view_end"]}
            continue
        out[k] = {"rows": int(len(v)), "hash": frame_hash(v)}
        if keep_rows:
            out[k]["row_hashes"] = _encode_hashes(_row_hashes(v))
    for k, items in folders.items():
        out[k] = {"files": {i["path"]: _file_sig(i) for i in items}}
    for k, modes in ((plan or {}).get("media_modes") or {}).items():
        out[k] = {"media_ids": sorted(modes["previous"] | modes["added"]), "replaced_at": ((spec or {}).get("media_replaced") or {}).get(k)}
    return out


def _check_media_snapshot(t: dict, spec: dict, plan: dict | None) -> None:
    """A transactionless media set output cannot be written as a snapshot (it cannot be reset): an incremental
    transform that cannot run incrementally fails, unless the output is still empty."""
    if not t.get("incremental") or not plan or plan["incremental"]:
        return
    for k in t.get("media_outputs") or {}:
        s = (spec.get("media_out_settings") or {}).get(k) or {}
        if s.get("transaction_policy") == "transactionless" and (spec.get("media_existing") or {}).get(k):
            raise RuntimeError(f"media set output {k} is transactionless and cannot be replaced, but this build cannot run incrementally "
                               f"({plan['reason']}): find out why the build is not incremental")


def _media_items(spec: dict, name: str) -> list[dict]:
    return (spec.get("media_inputs") or {}).get(name, {}).get("items", [])


# ------------------------------------------------------------------------------------------------
# running a transform
# ------------------------------------------------------------------------------------------------


def _param_values(t: dict, spec: dict) -> dict:
    given = spec.get("parameters") or {}
    out = {}
    for name, p in (t.get("_param_specs") or {}).items():
        raw = given.get(name, p.default)
        try:
            # Cipher license inputs (code_cipher.py) give an encrypter / decrypter / hasher instead of a value
            out[name] = p.make_value(raw) if hasattr(p, "make_value") else code_pyapi.ParamValueInput(p.coerce(raw) if raw is not None else None)
        except ValueError as e:
            raise ValueError(f"parameter {name}: {e}") from None
    return out


def _check_inputs(t: dict, tables: dict, datasets: dict) -> list[dict]:
    results = []
    for name, checks in (t.get("_checks") or {}).items():
        if name in tables:
            results += code_expectations.evaluate(checks, tables[name](), name, "input", datasets)
    failed = [r for r in results if not r["ok"] and r["mode"] == "abort"]
    if failed:
        raise CheckFailed("input check failed: " + "; ".join(f"{r['name']} on {r['target']}: {r['message']}" for r in failed), results)
    return results


def _run_legacy(t: dict, spec: dict, frames: dict, logs: io.StringIO, out_dir: Path) -> tuple:
    """The original API (transform_df / @transform on pandas, SQL): (output DataFrame or None, incremental info,
    media outputs, check results)."""
    import pandas as pd

    plan = _plan_incremental(t, frames, spec, None, {k: _media_items(spec, k) for k in t.get("media_inputs") or {}}) if t["incremental"] else None
    is_inc = bool(plan and plan["incremental"])
    _check_media_snapshot(t, spec, plan)
    inputs = {}
    for name, df in frames.items():
        sel = plan["select"].get(name) if is_inc else None
        if sel and sel[0] == "prefix":
            inputs[name] = TransformInput(df, df.iloc[: sel[1]].reset_index(drop=True), df.iloc[sel[1]:].reset_index(drop=True))
        elif sel:
            inputs[name] = TransformInput(df, df.iloc[sel[1]].reset_index(drop=True), df.iloc[sel[2]].reset_index(drop=True))
        else:
            inputs[name] = TransformInput(df)
    import pyarrow as pa

    tables = {k: (lambda df=df: pa.Table.from_pandas(df, preserve_index=False)) for k, df in frames.items()}
    datasets = {k: (lambda df=df: __import__("polars").from_pandas(df)) for k, df in frames.items()}
    checks = _check_inputs(t, tables, datasets)
    previous = pd.read_parquet(spec["previous_output"]) if is_inc and spec.get("previous_output") else None
    media_out: dict[str, code_media.TransformMediaSetOutput] = {}
    ctx = TransformContext(is_inc)
    out = None

    if t["kind"] == "sql":
        df = code_sql.execute(t["_sql"], t["inputs"], frames)
    else:
        kwargs: dict = {}
        if t["uses_ctx"]:
            kwargs["ctx"] = ctx
        with contextlib.redirect_stdout(logs):
            if t["kind"] == "df":
                args = {k: inputs[k].dataframe() for k in frames}
                if t.get("engine") == "polars":
                    import polars as pl

                    args = {k: pl.from_pandas(v) for k, v in args.items()}
                df = t["_fn"](**args, **kwargs)
                if df is not None:
                    df = as_frame(df)
                if df is not None and t["incremental"]:
                    out = TransformOutput(previous, is_inc)
                    out.write_dataframe(df)
                    df = out.final()
            else:
                for k in t["media_inputs"]:
                    kwargs[k] = code_media.TransformMediaSetInput(t["media_inputs"][k], _media_items(spec, k),
                                                                  modes=(plan["media_modes"].get(k) if plan else None))
                for k in t["media_outputs"]:
                    media_out[k] = kwargs[k] = code_media.TransformMediaSetOutput(Path(spec["media_out"]) / k, (spec.get("media_existing") or {}).get(k),
                                                                                  (spec.get("media_folders_out") or {}).get(k),
                                                                                  settings=(spec.get("media_out_settings") or {}).get(k))
                if t["output_param"]:
                    out = TransformOutput(previous, is_inc)
                    kwargs[t["output_param"]] = out
                t["_fn"](**inputs, **kwargs)
                df = out.final() if out else None
                if out and df is None:
                    if is_inc and out.mode == "modify":
                        # an empty incremental transaction: the output stays as it was
                        df = previous if previous is not None else pd.DataFrame()
                        logs.write("the output was not written: its incremental transaction is empty (nothing changes)\n")
                    else:
                        # the output's transaction is committed with nothing in it: an empty snapshot
                        df = pd.DataFrame()
                        logs.write("the output was not written: it gets an empty snapshot\n")
    if df is None and t["kind"] == "df":
        raise ValueError("the transform returned no DataFrame")
    all_checks = t.get("_checks") or {}
    key = "$output" if "$output" in all_checks else (t.get("output_param") if t.get("output_param") in all_checks else None)
    if df is not None and key:
        res = code_expectations.evaluate(t["_checks"][key], pa.Table.from_pandas(as_frame(df), preserve_index=False), t["output"]["name"], "output", datasets)
        checks += res
        failed = [r for r in res if not r["ok"] and r["mode"] == "abort"]
        if failed:
            raise CheckFailed("output check failed: " + "; ".join(f"{r['name']}: {r['message']}" for r in failed), checks)
    info = None
    if t["incremental"]:
        info = {"mode": "incremental" if is_inc else "snapshot", "reason": plan["reason"], "notes": plan["notes"],
                "output_mode": out.mode if out else ("modify" if is_inc else "replace"),
                "semantic_version": t["incremental"]["semantic_version"],
                "added_rows": {k: int(len(v.dataframe("added"))) for k, v in inputs.items()},
                "written_rows": int(len(out.df)) if out is not None and out.df is not None else None,
                "state": {"semantic_version": t["incremental"]["semantic_version"], "inputs": _input_state(t, frames, {}, plan, spec)}}
    media = {k: {"mode": v.write_mode, "items": list(v.items.values()), "registrations": v.registrations} for k, v in media_out.items()}
    return df, info, media, checks


def _run_new(t: dict, spec: dict, logs: io.StringIO, out_dir: Path) -> tuple:
    """Foundry's current API (@transform.using / @transform.spark.using): every output goes to MULTI_OUTPUTS.
    Returns (primary output as pandas or None, incremental info, media outputs, check results)."""
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    if t.get("blocked"):
        raise RuntimeError(t["blocked"])
    spark = t["kind"] == "spark"
    inc = t["incremental"]
    ds_paths: dict[str, str] = spec.get("inputs") or {}
    media_in = spec.get("media_inputs") or {}
    for k, v in media_in.items():
        if v.get("hidden_by_markings"):
            logs.write(f"media set input {k}: {v['hidden_by_markings']} item(s) carry markings the build's user does not hold and are left out\n")
    folders = {k: v.get("items", []) for k, v in media_in.items() if k not in t["media_inputs"]}
    frames = {k: pd.read_parquet(p) for k, p in ds_paths.items()} if inc else {}
    plan = _plan_incremental(t, frames, spec, folders, {k: _media_items(spec, k) for k in t["media_inputs"]}) if inc else None
    tables = bool(t.get("table_inputs") or t.get("table_outputs"))
    tplan = None
    if tables:
        # Iceberg table inputs / outputs: through Foundry's Iceberg catalog, as this build's job (code_tables.py)
        code_tables.configure(spec)
        tplan = code_tables.plan(t, spec, plan)
        if plan is not None and plan["incremental"] and not tplan["incremental"]:
            plan["incremental"], plan["reason"] = False, tplan["reason"]
    is_inc = bool(plan and plan["incremental"])
    _check_media_snapshot(t, spec, plan)
    if spark:
        code_pyapi.SPARK_CONF.update(code_pyapi.spark_settings(t.get("profiles") or []))
        if t.get("backend") == "VELOX":
            logs.write("backend VELOX: native acceleration is not available here, the transform runs on standard Spark\n")
    work = out_dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    In = code_pyapi.TransformSparkInput if spark else code_pyapi.LightweightInput
    Out = code_pyapi.TransformSparkOutput if spark else code_pyapi.LightweightOutput
    snaps = set(inc["snapshot_inputs"]) if inc else set()
    inputs: dict = {}
    for name, ref in t["inputs"].items():
        if name in ds_paths:
            inputs[name] = In(name, ref, ds_paths[name], select=(plan["select"].get(name) if plan else None), incremental=is_inc,
                              snapshot=name in snaps, work=work)
        elif name in folders:
            files = [{"path": i["path"], "file": i["file"], "size": i.get("size"), "modified": 0} for i in folders[name]]
            inputs[name] = In(name, ref, None, files, incremental=is_inc, snapshot=name in snaps, added_files=(plan["added_files"].get(name) if plan else None))
        else:
            raise LookupError(f"input {name} ({ref}) was not provided")
    prev_outputs = spec.get("previous_outputs") or {}
    strict = bool(inc and inc.get("strict_append"))
    outputs = {p: Out(p, o["name"], work, prev_outputs.get(p), is_inc, strict, logs) for p, o in t["outputs"].items()}
    kwargs: dict = {**inputs, **outputs}
    t_ins, t_outs = code_tables.runtime_objects(t, spark, tplan, is_inc) if tables else ({}, {})
    kwargs.update(t_ins)
    kwargs.update(t_outs)
    spark_fn = code_pyapi.spark_session if spark else None
    for k, ref in t["media_inputs"].items():
        kwargs[k] = code_media.TransformMediaSetInput(ref, media_in.get(k, {}).get("items", []), spark=spark_fn,
                                                      modes=(plan["media_modes"].get(k) if plan else None))
    media_out: dict[str, code_media.TransformMediaSetOutput] = {}
    for k in t["media_outputs"]:
        media_out[k] = kwargs[k] = code_media.TransformMediaSetOutput(Path(spec["media_out"]) / k, (spec.get("media_existing") or {}).get(k),
                                                                      (spec.get("media_folders_out") or {}).get(k), lightweight=not spark,
                                                                      settings=(spec.get("media_out_settings") or {}).get(k))
    kwargs.update(_param_values(t, spec))
    # models: ModelOutputs get a WritableModel (versions staged under models-out, committed by the server after a
    # successful build); ModelInputs a loaded model; @palantir_models.transforms.evaluation names the evaluation set
    model_lib.begin(out_dir / "models-out", spec.get("mode") or "build", t.get("evaluation_set"))
    kwargs.update({k: model_lib.WritableModel(k, d) for k, d in (t.get("_model_output_specs") or {}).items()})
    kwargs.update({k: code_models.instance(m, (spec.get("container_models") or {}).get(k)) for k, m in (t.get("_model_specs") or {}).items()})
    # foundry.transforms.Dataset.get: the transform's inputs and outputs by parameter name, path or id
    code_pyapi.CURRENT_IO.clear()
    for k, decl in (t.get("_params") or {}).items():
        if k in inputs or k in outputs:
            obj = inputs.get(k) or outputs.get(k)
            code_pyapi.CURRENT_IO[k] = obj
            if isinstance(decl, code_pyapi.Input):
                code_pyapi.CURRENT_IO.setdefault(decl.ref, obj)
            elif isinstance(decl, code_pyapi.Output):
                code_pyapi.CURRENT_IO.setdefault(f"{decl.folder}/{decl.name}" if decl.folder else decl.name, obj)
    for name, item_id in (spec.get("input_items") or {}).items():
        if name in inputs:
            code_pyapi.CURRENT_IO.setdefault(item_id, inputs[name])
    for k, names in (t.get("sets") or {}).items():
        # InputSet / OutputSet: the function gets the list
        kwargs[k] = [kwargs.pop(n) for n in names]
    threads = code_pyapi.ceil_threads((t.get("resources") or {}).get("cpu_cores"))
    if t["uses_ctx"]:
        kwargs["ctx"] = code_pyapi.LightweightContext(inputs, is_inc, threads, spark=spark_fn)
    datasets = {k: (lambda v=v: __import__("polars").from_arrow(v.arrow("current"))) for k, v in inputs.items() if v._path}
    checks = _check_inputs(t, {k: (lambda v=v: v.arrow("current")) for k, v in inputs.items() if v._path}, datasets)
    if spark:
        code_pyapi.spark_session()
    try:
        with contextlib.redirect_stdout(logs):
            if t.get("returns"):
                # transform_df on Spark: DataFrames in, the returned DataFrame is the output
                ret = t["returns"]
                args = {k: (v.dataframe() if k in inputs else [x.dataframe() for x in v] if k in (t.get("sets") or {}) and all(n in inputs for n in t["sets"][k]) else v)
                        for k, v in kwargs.items() if k not in outputs}
                result = t["_fn"](**args)
                if result is None:
                    raise ValueError("the transform returned no DataFrame")
                outputs[ret].write_dataframe(result)
            elif spec.get("container"):
                # bring your own container: the programs the transform starts run from the image (byoc_slot.py)
                import byoc_slot

                with byoc_slot.session(spec["container"], Path(spec["repo"]), logs):
                    t["_fn"](**kwargs)
            else:
                t["_fn"](**kwargs)
    except code_pyapi.AbortJob:
        return None, None, {}, checks, True
    written: dict[str, dict] = {}
    primary_df = None
    failed: list[dict] = []
    for i, (param, out) in enumerate(outputs.items()):
        if out.aborted:
            written[param] = {"kind": "aborted"}
            continue
        kind, data, mode, n_written = out.final()
        if kind is None:
            if is_inc and out.mode == "modify":
                logs.write(f"output {param} was not written: its incremental transaction is empty (nothing changes)\n")
                continue
            # the output's transaction is committed with nothing in it: an empty snapshot
            path = out_dir / f"out-{i}.parquet"
            pq.write_table(pa.table({}), path)
            written[param] = {"kind": "empty", "mode": "SNAPSHOT", "parquet": str(path), "rows": 0, "written": 0, "columns": []}
            continue
        if kind == "dataframe":
            res = code_expectations.evaluate(t["_checks"][param], data, t["outputs"][param]["name"], "output", datasets) if param in (t.get("_checks") or {}) else []
            checks += res
            failed += [r for r in res if not r["ok"] and r["mode"] == "abort"]
            path = out_dir / f"out-{i}.parquet"
            pq.write_table(data, path)
            written[param] = {"kind": "dataframe", "mode": mode, "parquet": str(path), "rows": int(data.num_rows), "written": int(n_written),
                              "columns": [{"name": f.name, "type": str(f.type)} for f in data.schema]}
            if param == t["output_param"] or primary_df is None:
                primary_df = data.to_pandas()
        else:
            written[param] = {"kind": "files", "mode": mode, "files": data}
    if failed:
        raise CheckFailed("output check failed: " + "; ".join(f"{r['name']} on {r['target']}: {r['message']}" for r in failed), checks)
    for j, (param, out) in enumerate(t_outs.items()):
        # a preview keeps what the transform wrote; a build reads back the job's own (staged) write
        data = out.preview_data
        if data is None and out.written and out._entry:
            with contextlib.suppress(Exception):
                data = code_tables._load(out._entry).scan(limit=int(spec.get("limit") or 100)).to_arrow()
        if not out.written:
            logs.write(f"table output {param} was not written: it is left unchanged\n")
            continue
        TABLE_OUTPUTS[param] = {**out.written, "item_id": (out._entry or {}).get("item_id")}
        if data is not None and spec.get("mode") == "preview":
            path = out_dir / f"table-out-{j}.parquet"
            pq.write_table(data, path)
            written[param] = {"kind": "dataframe", "mode": "preview", "parquet": str(path), "rows": int(out.written.get("rows") or data.num_rows),
                              "written": int(data.num_rows), "columns": [{"name": f.name, "type": str(f.type)} for f in data.schema]}
        if data is not None and (param == t["output_param"] or primary_df is None):
            primary_df = data.to_pandas()
    MULTI_OUTPUTS.clear()
    MULTI_OUTPUTS.update(written)
    info = None
    if inc:
        aborted_some = any(w["kind"] == "aborted" for w in written.values())
        info = {"mode": "incremental" if is_inc else "snapshot", "reason": plan["reason"], "notes": plan["notes"],
                "output_mode": next(iter(outputs.values())).mode if outputs else ("modify" if is_inc else "replace"),
                "output_modes": {p: o.mode for p, o in outputs.items()}, "semantic_version": inc["semantic_version"],
                "added_rows": {k: (int(len(v.arrow("added"))) if v._path else len(list(v.filesystem("added").ls()))) for k, v in inputs.items()},
                "written_rows": sum(w.get("written") or 0 for w in written.values() if w["kind"] == "dataframe") if written else None,
                "state": {"semantic_version": inc["semantic_version"], "inputs": _input_state(t, frames, dict(folders), plan, spec),
                          **({"tables": tplan["read"]} if tplan else {}), **({"inconsistent": True} if aborted_some else {})}}
        if plan.get("ranges"):
            info["ranges"] = {k: {kk: vv for kk, vv in r.items() if kk not in ("last_tx", "view_end")} for k, r in plan["ranges"].items()}
            info["up_to_date"] = all(r["remaining"] == 0 for r in plan["ranges"].values())
        if plan.get("media_modes"):
            info["added_media_items"] = {k: len(m["added"]) for k, m in plan["media_modes"].items()}
    media = {k: {"mode": v.write_mode, "items": list(v.items.values()), "registrations": v.registrations} for k, v in media_out.items()}
    return primary_df, info, media, checks, False


MULTI_OUTPUTS: dict[str, dict] = {}
# Iceberg table outputs a build wrote: {param: {rows, mode, columns, item_id}} (committed by the server with the job)
TABLE_OUTPUTS: dict[str, dict] = {}

# names the debugger (code_debug_worker.py) uses from this module
_api_module = code_pyapi.install_modules
_as_frame = as_frame
TransformMediaSetInput = code_media.TransformMediaSetInput
TransformMediaSetOutput = code_media.TransformMediaSetOutput


def _run_transform(t: dict, spec: dict, frames: dict, logs: io.StringIO, out_dir: Path) -> tuple:
    """The original API's run as the debugger calls it: (output DataFrame or None, incremental info, media outputs)."""
    df, info, media, _checks = _run_legacy(t, spec, frames, logs, out_dir)
    return df, info, media


def _run_java(t: dict, spec: dict, logs: io.StringIO, out_dir: Path) -> tuple:
    """A Java transform on Spark: (primary DataFrame or None, incremental info, media outputs); every output goes to
    MULTI_OUTPUTS (DataFrames as Parquet files, files outputs as files on disk)."""
    res = code_java.build(Path(spec["repo"]), t, spec, out_dir / "java")
    if res["logs"]:
        logs.write(res["logs"] + "\n")
    primary = t["output_param"]
    written: dict[str, dict] = {}
    for i, (param, o) in enumerate(res["outputs"].items()):
        if o["kind"] == "dataframe":
            path = out_dir / f"java-out-{i}.parquet"
            o["frame"].reset_index(drop=True).to_parquet(path, index=False)
            written[param] = {"kind": "dataframe", "mode": o["mode"], "parquet": str(path), "rows": int(len(o["frame"])), "written": o.get("written"),
                              "columns": [{"name": str(c), "type": str(o["frame"][c].dtype)} for c in o["frame"].columns]}
        else:
            d = out_dir / f"java-files-{i}"
            files = []
            for j, f in enumerate(o["files"]):
                local = d / str(j)
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(f["data"])
                files.append({"path": f["path"], "file": str(local), "size": f["size"]})
            written[param] = {"kind": "files", "mode": o["mode"], "files": files}
    MULTI_OUTPUTS.clear()
    MULTI_OUTPUTS.update(written)
    p = res["outputs"].get(primary)
    media = {}
    if p and p["kind"] == "files":
        media = {primary: {"mode": "modify", "items": [{"path": f["path"], "file": f["file"], "size": f["size"]} for f in written[primary]["files"]]}}
    return (p["frame"] if p and p["kind"] == "dataframe" else None), res["incremental"], media


def _apply_resources(spec: dict) -> None:
    """Thread limits for the engines (with_resources(cpu_cores=...)), before user code imports them."""
    cores = code_pyapi.ceil_threads((spec.get("resources") or {}).get("cpu_cores"))
    if cores:
        for var in ("POLARS_MAX_THREADS", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_MAX_THREADS"):
            os.environ[var] = str(cores)


def main() -> None:
    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text("utf-8"))
    result: dict = {"ok": False}
    logs = io.StringIO()
    logging.basicConfig(stream=logs, level=logging.INFO, format="%(levelname)s %(name)s: %(message)s", force=True)
    for noisy in ("py4j", "pyspark", "urllib3", "matplotlib", "PIL"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    try:
        _apply_resources(spec)
        code_pyapi.install_modules()
        repo = Path(spec["repo"])
        try:
            repo_settings = json.loads((repo / "repoSettings.json").read_text("utf-8"))
            engine = repo_settings.get("legacyPythonEngine")
            # custom Transforms profiles (Spark SQL settings) for @configure(profile=[...])
            for problem in code_pyapi.load_custom_profiles(repo_settings):
                logs.write(problem + "\n")
        except (OSError, ValueError, AttributeError):
            engine = None
        code_pyapi.LEGACY_ENGINE["value"] = engine if engine in ("spark", "pandas") else None
        # condaJars / sparkJars (build.gradle) for the Spark session, resolved by code_repos
        if spec.get("spark_jars"):
            code_pyapi.SPARK_CONF.update(jar_packages=list(spec["spark_jars"]), ivy_dir=spec.get("ivy_dir"))
        if spec.get("spark_ui"):
            # a debug job: keep Spark's web UI on, read it back below (the debug job's Spark UI)
            code_pyapi.SPARK_CONF.update(spark_ui=True, app_name=f"debug {spec.get('transform', '')}"[:200])
        # Java: jars of shared code repositories its build.gradle depends on (resolved by code_repos)
        code_java.DEPENDENCIES.update(spec.get("java_deps") or {})
        code_java.DEPENDENCY_ERRORS.update(spec.get("java_dep_errors") or {})
        with contextlib.redirect_stdout(logs):
            errors = _load(repo, spec.get("library_paths"))
            _apply_pipeline(repo, errors)
            if spec["mode"] == "list":
                _logic_versions(repo)
        result["errors"] = errors
        result["transforms"] = [{k: v for k, v in t.items() if not k.startswith("_")} for t in REGISTRY]
        result["java"] = code_java.available()
        keys = [t["key"] for t in REGISTRY]
        dupes = {k for k in keys if keys.count(k) > 1}
        outs = [(o["folder"], o["name"]) for t in REGISTRY for o in ((t.get("outputs") or {}).values() if t.get("outputs") else [t["output"]])]
        clash = {o for o in outs if outs.count(o) > 1}
        if clash:
            errors.append({"file": "", "error": f"two transforms write the same output: {', '.join(n for _, n in clash)}"})
        if spec["mode"] == "test":
            if spec.get("tests_enabled", True):
                result["tests"] = _run_tests(repo, spec.get("file"), logs, spec.get("pytest_workers"), spec.get("library_paths"))
            else:
                # unit tests run only when the project applies the pytest plugin (bluesandai.pytest or Foundry's id)
                result["tests"] = []
                result["tests_disabled"] = True
            if code_java.available() and code_java.has_java(repo) and (not spec.get("file") or not spec["file"].endswith(".py")):
                result["tests"] += code_java.run_tests(repo, spec.get("file"))
            result["tests"] += code_r.check_sources(repo, spec.get("file"))
            result["ok"] = True
        elif spec["mode"] == "list":
            result["ok"] = not dupes
            if dupes:
                result["error"] = f"duplicate transforms: {', '.join(dupes)}"
        elif spec["mode"] == "describe":
            # the functions registry: every @function with its inputs, output, edits and API name
            result["functions"] = code_functions.describe(repo)
            result["ok"] = True
        elif spec["mode"] == "invoke":
            # run one published function with JSON inputs (a query, an Ontology edit function, a Workshop value)
            with contextlib.redirect_stdout(logs):
                result.update(code_functions.invoke(repo, spec))
        elif spec["mode"] == "function":
            # a function-backed time series: call the function, return its points
            with contextlib.redirect_stdout(logs):
                result["points"] = code_foundryts.run_function(repo, spec)
            result["ok"] = True
        else:
            import pandas as pd

            t = next((x for x in REGISTRY if x["key"] == spec["transform"]), None)
            if not t:
                raise LookupError(f"transform {spec['transform']} not found")
            if t["kind"] == "java" and not code_java.available():
                raise RuntimeError(code_java.NO_JDK)
            if spec.get("sidecar"):
                # transforms.sidecar: a container next to the driver now, and one per executor (pyspark_worker.py)
                import sidecar_slot

                os.environ[sidecar_slot.ENV] = json.dumps(spec["sidecar"])
                if spec["sidecar"].get("keepalive"):
                    SIDECAR["keepalive"] = subprocess.Popen(spec["sidecar"]["keepalive"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                SIDECAR["slot"] = sidecar_slot.start(spec["sidecar"], "driver")
            frames: dict = {}
            checks: list = []
            aborted = False
            if t["kind"] == "java":
                df, info, media = _run_java(t, spec, logs, spec_path.parent)
                result["multi_outputs"] = dict(MULTI_OUTPUTS)
            elif t.get("language") == "r":
                frames = {k: pd.read_parquet(p) for k, p in spec["inputs"].items()}
                df, r_outputs = code_r.run_transform(t, spec, frames, logs, spec_path.parent)
                MULTI_OUTPUTS.clear()
                MULTI_OUTPUTS.update(r_outputs)
                result["multi_outputs"] = dict(MULTI_OUTPUTS)
                info, media, checks = None, {}, []
            elif t["kind"] in NEW_KINDS:
                try:
                    df, info, media, checks, aborted = _run_new(t, spec, logs, spec_path.parent)
                except CheckFailed as e:
                    result["expectations"] = e.results
                    raise
                result["multi_outputs"] = dict(MULTI_OUTPUTS)
                result["table_outputs"] = dict(TABLE_OUTPUTS)
            else:
                frames = {k: pd.read_parquet(p) for k, p in spec["inputs"].items()}
                try:
                    df, info, media, checks = _run_legacy(t, spec, frames, logs, spec_path.parent)
                except CheckFailed as e:
                    result["expectations"] = e.results
                    raise
            result["expectations"] = checks
            if aborted:
                result.update(ok=True, aborted=True, rows=0, columns=[], preview=[], dataset_output=False, incremental=None, media_outputs={})
                logs.write("ctx.abort_job(): the job succeeded and committed nothing\n")
            else:
                result["incremental"] = info
                result["media_outputs"] = media
                if df is None:
                    # a media-set-only (or files-only) transform: the preview lists the media items / files it wrote
                    rows = [{"media_set": k, "path": i["path"], "size": i["size"]} for k, m in media.items() for i in m["items"]]
                    rows += [{"media_set": k, "path": f["path"], "size": f["size"]} for k, o in (result.get("multi_outputs") or {}).items()
                             if o["kind"] == "files" and k not in media for f in o["files"]]
                    df = pd.DataFrame(rows, columns=["media_set", "path", "size"])
                    result["dataset_output"] = False
                else:
                    result["dataset_output"] = True
                df = as_frame(df).copy()
                df.columns = [str(c) for c in df.columns]
                if spec["mode"] == "build" and result["dataset_output"] and t["kind"] not in NEW_KINDS and t["kind"] != "java":
                    df.reset_index(drop=True).to_parquet(spec["out"], index=False)
                head = df.head(int(spec.get("limit") or 100))
                result.update(
                    ok=True,
                    rows=int(len(df)),
                    columns=[{"name": c, "type": str(df[c].dtype)} for c in df.columns],
                    preview=[{c: _cell(v) for c, v in r.items()} for r in head.to_dict(orient="records")],
                    input_rows={k: int(len(v)) for k, v in frames.items()} if frames else {k: None for k in spec["inputs"]},
                    media_input_items={k: len(v.get("items", [])) for k, v in (spec.get("media_inputs") or {}).items()},
                )
                if spec["mode"] == "preview" and result.get("multi_outputs"):
                    result["output_previews"] = _output_previews(result["multi_outputs"], int(spec.get("limit") or 100), spec.get("preview_files"))
    except Exception:  # noqa: BLE001
        result["ok"] = False
        result["error"] = traceback.format_exc(limit=6)[-4000:]
    finally:
        if spec.get("spark_ui"):
            try:
                result["spark_ui"] = code_pyapi.spark_ui_snapshot()
            except Exception as e:  # noqa: BLE001 - the snapshot is informative
                result["spark_ui"] = {"error": str(e)}
        if code_pyapi.SPARK_PLANS:
            result["spark_plans"] = list(code_pyapi.SPARK_PLANS)
        code_pyapi.stop_spark()
        if spec.get("sidecar"):
            _stop_sidecars(spec["sidecar"], logs)
        if spec.get("container_models"):
            import model_container

            text = model_container.stop_all()
            if text:
                logs.write("\n" + text[-12000:])
    if model_lib.STATE["outputs"] or model_lib.STATE["evaluation_objects"]:
        try:
            result.update(model_lib.collected())
        except Exception as e:  # noqa: BLE001
            result.update(ok=False, error=f"the model outputs could not be collected: {e}")
    result["logs"] = logs.getvalue()[-20000:]
    (spec_path.parent / "result.json").write_text(json.dumps(result, default=str), "utf-8")


SIDECAR: dict = {}


def _stop_sidecars(sc: dict, logs: io.StringIO) -> None:
    """Stop the driver's sidecar; the logs of every sidecar container (the containers' telemetry) join the build's."""
    import shutil

    import sidecar_slot

    parts = []
    slot = SIDECAR.pop("slot", None)
    if slot:
        try:
            parts.append(f"--- sidecar of the driver ---\n{sidecar_slot.stop(sc, slot)}")
        except Exception as e:  # noqa: BLE001
            parts.append(f"the driver's sidecar did not stop cleanly: {e}")
    keep = SIDECAR.pop("keepalive", None)
    if keep:
        keep.kill()
    log = Path(sc["base_dir"]) / "sidecar-logs.txt"
    if log.exists():
        parts.append(log.read_text("utf-8", errors="replace"))
    shutil.rmtree(sc["base_dir"], ignore_errors=True)
    if parts:
        logs.write(f"\n=== {sc['image']} sidecar containers ===\n" + "\n".join(parts)[-12000:])


def _output_previews(outputs: dict, limit: int, wanted: dict | None = None) -> dict:
    """Every output of a multi-output transform, for the preview's output picker. `wanted`: {output: [file path]}
    whose contents come back too (datasetPreview --outputFiles), base64, up to 1 MB each."""
    import base64

    import pyarrow.parquet as pq

    out = {}
    for param, o in outputs.items():
        if o["kind"] in ("dataframe", "empty"):
            # an output the transform never wrote previews as its empty snapshot
            table = pq.read_table(o["parquet"]).slice(0, limit)
            df = table.to_pandas()
            out[param] = {"kind": "dataframe", "rows": o["rows"], "columns": o["columns"],
                          "preview": [{c: _cell(v) for c, v in r.items()} for r in df.to_dict(orient="records")]}
        elif o["kind"] == "files":
            out[param] = {"kind": "files", "rows": len(o["files"]), "columns": [{"name": "path", "type": "string"}, {"name": "size", "type": "int64"}],
                          "preview": [{"path": f["path"], "size": f["size"]} for f in o["files"][:limit]]}
            asked = (wanted or {}).get(param) or []
            if asked:
                by_path = {f["path"].lstrip("/"): f for f in o["files"]}
                contents = {}
                for p in asked:
                    f = by_path.get(p.lstrip("/"))
                    if f:
                        with open(f["file"], "rb") as fh:
                            data = fh.read(1_000_001)
                        contents[p] = {"size": f["size"], "data": base64.b64encode(data[:1_000_000]).decode(), "truncated": len(data) > 1_000_000}
                out[param]["contents"] = contents
    return out


if __name__ == "__main__":
    main()
