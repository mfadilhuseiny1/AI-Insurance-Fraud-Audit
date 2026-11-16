"""Checks' style checks and linters for Python repositories (palantir.com/docs/foundry/transforms-python/unit-tests).

A Python project (a build.gradle applying bluesandai.python or bluesandai.python-library — Foundry's
com.palantir.transforms.lang.* / com.palantir.conda.* ids are read as these, see PLUGIN_ALIASES: transforms-python/
in a transforms repository, the root of a library) turns its CI tasks on with Gradle plugins:

  bluesandai.pytest                 unit tests (tasks.pytest { numProcesses "N" }: pytest-xdist)
  bluesandai.pep8                   PEP8 with pycodestyle (setup.cfg / tox.ini [pycodestyle] apply)
  bluesandai.pylint                 Pylint with src/.pylintrc
  bluesandai.antipattern-linter     the Spark anti-pattern linter (warnings)

PEP8 and Pylint messages fail Checks, as their Gradle tasks do; anti-patterns are warnings. Linting runs in the API's
own Python on a copy of the files, so it works whatever environment the repository builds in; the transforms runtime
modules (transforms, foundry, ...) are ignored by Pylint's import checks, as they are provided by the platform.
"""

from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

PLUGIN_PYTHON = "bluesandai.python"
PLUGIN_LIBRARY = "bluesandai.python-library"
PLUGIN_TESTS = "bluesandai.pytest"
PLUGIN_PEP8 = "bluesandai.pep8"
PLUGIN_PYLINT = "bluesandai.pylint"
PLUGIN_ANTIPATTERN = "bluesandai.antipattern-linter"
# the Gradle plugin ids of repositories written for Foundry, read as the platform's own (both work)
PLUGIN_ALIASES = {
    "com.palantir.transforms.lang.python": PLUGIN_PYTHON,
    "com.palantir.transforms.lang.python-defaults": "bluesandai.python-defaults",
    "com.palantir.transforms.lang.python-library": PLUGIN_LIBRARY,
    "com.palantir.transforms.lang.python-library-defaults": "bluesandai.python-library-defaults",
    "com.palantir.transforms.lang.pytest-defaults": PLUGIN_TESTS,
    "com.palantir.conda.pep8": PLUGIN_PEP8,
    "com.palantir.conda.pylint": PLUGIN_PYLINT,
    "com.palantir.transforms.lang.antipattern-linter": PLUGIN_ANTIPATTERN,
}


def plugins_of(gradle: str) -> set[str]:
    """The plugins a build.gradle applies (apply plugin: '…' or id '…'), Foundry ids read as the platform's."""
    found = set(re.findall(r"apply\s+plugin\s*:\s*['\"]([^'\"]+)['\"]", gradle)) | set(re.findall(r"\bid\s*\(?\s*['\"]([^'\"]+)['\"]", gradle))
    return {PLUGIN_ALIASES.get(p, p) for p in found}
PLATFORM_MODULES = "transforms,foundry,palantir_models,geospatial_tools,foundry_ts,ontology_sdk"
TIMEOUT_S = 300


def projects(files: dict[str, str]) -> list[dict]:
    """The repository's Python projects: {dir ("" for the root), name (":transforms-python"), plugins, num_processes}."""
    out = []
    for path, text in sorted(files.items()):
        if not path.endswith("build.gradle"):
            continue
        plugins = plugins_of(text)
        if not any(p in plugins for p in (PLUGIN_PYTHON, PLUGIN_LIBRARY)):
            continue
        d = path[: -len("build.gradle")].rstrip("/")
        m = re.search(r"tasks\.pytest\s*\{[^}]*?numProcesses\s*\(?\s*['\"]?(\d+)", text, re.S)
        out.append({"dir": d, "name": f":{d}" if d else ":", "plugins": sorted(plugins), "num_processes": int(m.group(1)) if m else None})
    return out


def tests_enabled(files: dict[str, str]) -> tuple[bool, Optional[int]]:
    """(run unit tests, pytest workers): tests run when a Python project applies pytest-defaults (Foundry); a
    repository without a Python build.gradle (a plain layout) always runs them."""
    ps = projects(files)
    if not ps:
        return True, None
    on = [p for p in ps if PLUGIN_TESTS in p["plugins"]]
    return bool(on), max((p["num_processes"] or 0 for p in on), default=0) or None


def _write(files: dict[str, str], root: Path) -> None:
    for path, content in files.items():
        p = root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, "utf-8")


def _rel(root: Path, path: str) -> str:
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.replace("\\", "/")


PEP8_MAX_LINE = 120


def _pep8_config(project: Path) -> bool:
    for d in (project, project / "src"):
        for name in ("setup.cfg", "tox.ini", ".pycodestyle"):
            f = d / name
            if f.is_file() and re.search(r"^\[(pycodestyle|pep8)\]", f.read_text("utf-8", "replace"), re.M):
                return True
    return False


def _pep8(root: Path, project: Path) -> list[dict]:
    src = project / "src" if (project / "src").is_dir() else project
    # without a [pycodestyle] section (setup.cfg / tox.ini) lines may be up to PEP8_MAX_LINE long
    extra = [] if _pep8_config(project) else [f"--max-line-length={PEP8_MAX_LINE}"]
    p = subprocess.run([sys.executable, "-m", "pycodestyle", *extra, "--format=%(path)s|%(row)d|%(col)d|%(code)s|%(text)s", str(src)],
                       cwd=str(project), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT_S)
    out = []
    for line in p.stdout.splitlines():
        parts = line.split("|", 4)
        if len(parts) == 5 and parts[1].isdigit():
            out.append({"tool": "pep8", "file": _rel(root, parts[0]), "line": int(parts[1]), "column": int(parts[2]), "code": parts[3],
                        "message": parts[4], "severity": "error"})
    return out


def _pylint(root: Path, project: Path) -> list[dict]:
    src = project / "src" if (project / "src").is_dir() else project
    targets = sorted({str(p.parent) for p in src.glob("*/__init__.py")} | {str(p) for p in src.glob("*.py") if p.name != "setup.py"})
    if not targets:
        return []
    cmd = [sys.executable, "-m", "pylint", "--output-format=json", "--persistent=n", "--score=n", f"--ignored-modules={PLATFORM_MODULES}"]
    rc = src / ".pylintrc"
    if rc.exists():
        cmd.append(f"--rcfile={rc}")
    p = subprocess.run([*cmd, *targets], cwd=str(src), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT_S)
    try:
        messages = json.loads(p.stdout or "[]")
    except ValueError:
        return [{"tool": "pylint", "file": "", "line": 0, "column": 0, "code": "fatal", "message": (p.stderr or p.stdout)[-1500:], "severity": "error"}]
    return [{"tool": "pylint", "file": _rel(root, str(src / m["path"]) if not Path(m["path"]).is_absolute() else m["path"]), "line": m.get("line") or 0,
             "column": m.get("column") or 0, "code": f"{m.get('message-id')} {m.get('symbol')}", "message": m.get("message"), "severity": "error",
             "kind": m.get("type")} for m in messages]


# -- the Spark anti-pattern linter ----------------------------------------------------------------

ANTIPATTERNS = {
    "SPARK001": "collect() brings every row to the driver: keep the work in Spark, or limit() first",
    "SPARK002": "toPandas() brings every row to the driver as pandas: keep the work in Spark, or limit() first",
    "SPARK003": "count() only to test for rows scans the whole DataFrame: use df.isEmpty() or df.limit(1).count()",
    "SPARK004": "a Python UDF sends every row through Python: use a built-in pyspark.sql.functions expression where one exists",
    "SPARK005": "withColumn() in a loop builds a deep plan: build the columns in one select() (or withColumns())",
    "SPARK006": "repartition(1) / coalesce(1) puts all the data on one executor",
    "SPARK007": "crossJoin() multiplies the rows of both sides: check that a join condition is not missing",
    "SPARK008": "SQL built from strings (f-string, format, +) can be injected: pass values as columns or parameters",
}


def _is_spark_file(text: str) -> bool:
    return "pyspark" in text or "transform.spark" in text or "transform_df" in text or ".dataframe(" in text


def _antipatterns(rel: str, text: str) -> list[dict]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    out: list[dict] = []

    def add(node: ast.AST, code: str) -> None:
        out.append({"tool": "antipattern", "file": rel, "line": getattr(node, "lineno", 0), "column": getattr(node, "col_offset", 0) + 1,
                    "code": code, "message": ANTIPATTERNS[code], "severity": "warning"})

    def attr_call(node: ast.AST, name: str) -> bool:
        return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == name

    loops: list[ast.AST] = []

    class V(ast.NodeVisitor):
        def visit_For(self, node):  # noqa: N802
            loops.append(node)
            self.generic_visit(node)
            loops.pop()

        visit_While = visit_For  # noqa: N815

        def visit_Call(self, node):  # noqa: N802
            if attr_call(node, "collect") and not node.args:
                add(node, "SPARK001")
            elif attr_call(node, "toPandas"):
                add(node, "SPARK002")
            elif attr_call(node, "withColumn") and loops:
                add(node, "SPARK005")
            elif (attr_call(node, "repartition") or attr_call(node, "coalesce")) and len(node.args) == 1 and isinstance(node.args[0], ast.Constant) and node.args[0].value == 1:
                add(node, "SPARK006")
            elif attr_call(node, "crossJoin"):
                add(node, "SPARK007")
            elif attr_call(node, "sql") and node.args and isinstance(node.args[0], (ast.JoinedStr, ast.BinOp)) or (
                attr_call(node, "sql") and node.args and attr_call(node.args[0], "format")
            ):
                add(node, "SPARK008")
            name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ""
            if name in ("udf", "pandas_udf") and node.args:
                add(node, "SPARK004")
            self.generic_visit(node)

        def visit_Compare(self, node):  # noqa: N802
            # df.count() == 0 / > 0 / >= 1 / != 0
            sides = [node.left, *node.comparators]
            if any(attr_call(s, "count") and not s.args for s in sides) and any(isinstance(s, ast.Constant) and s.value in (0, 1) for s in sides):
                add(node, "SPARK003")
            self.generic_visit(node)

        def visit_If(self, node):  # noqa: N802
            # if df.count(): / if not df.count():
            test = node.test.operand if isinstance(node.test, ast.UnaryOp) and isinstance(node.test.op, ast.Not) else node.test
            if attr_call(test, "count") and not test.args:
                add(node, "SPARK003")
            self.generic_visit(node)

        def visit_FunctionDef(self, node):  # noqa: N802
            for d in node.decorator_list:
                target = d.func if isinstance(d, ast.Call) else d
                name = target.attr if isinstance(target, ast.Attribute) else target.id if isinstance(target, ast.Name) else ""
                if name in ("udf", "pandas_udf"):
                    add(d, "SPARK004")
            self.generic_visit(node)

    V().visit(tree)
    return out


def run(files: dict[str, str]) -> dict:
    """{tasks: [{name, status, ms, problems}], problems: [...]} of the plugins the Python projects apply."""
    tasks: list[dict] = []
    problems: list[dict] = []
    ps = projects(files)
    if not ps:
        return {"tasks": [], "problems": []}
    with tempfile.TemporaryDirectory(prefix="codelint-") as tmp:
        root = Path(tmp)
        _write(files, root)
        for p in ps:
            pdir = root / p["dir"] if p["dir"] else root
            prefix = f"{p['dir']}/" if p["dir"] else ""
            for plugin, task, fn in ((PLUGIN_PEP8, "pep8", _pep8), (PLUGIN_PYLINT, "pylint", _pylint)):
                if plugin not in p["plugins"]:
                    continue
                started = time.monotonic()
                try:
                    found = fn(root, pdir)
                    status = "failed" if found else "passed"
                except subprocess.TimeoutExpired:
                    found, status = [{"tool": task, "file": "", "line": 0, "column": 0, "code": "timeout", "message": f"{task} took longer than {TIMEOUT_S} s", "severity": "error"}], "failed"
                problems += found
                tasks.append({"name": f"{p['name']}:{task}", "status": status, "ms": int((time.monotonic() - started) * 1000), "problems": len(found)})
            if PLUGIN_ANTIPATTERN in p["plugins"]:
                started = time.monotonic()
                found = []
                for path, text in sorted(files.items()):
                    if path.startswith(prefix) and path.endswith(".py") and "/test" not in f"/{path}" and _is_spark_file(text):
                        found += _antipatterns(path, text)
                problems += found
                tasks.append({"name": f"{p['name']}:antipatternLinter", "status": "warnings" if found else "passed",
                              "ms": int((time.monotonic() - started) * 1000), "problems": len(found)})
    return {"tasks": tasks, "problems": problems}
