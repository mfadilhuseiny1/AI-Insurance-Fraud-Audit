"""Custom checks (doc 16 "Create custom checks"): Gradle tasks in a subproject's build.gradle that CI runs.

There is no Gradle here; Checks read the task definitions and run what they do:

    task customTask {                         // also: tasks.register('customTask') { ... },
        doLast {                              //       task lintSql(type: Exec) { commandLine 'python', 'x.py' }
            println "Hello World"             // printed to the check's logs
            exec { commandLine 'python', 'scripts/check.py' }   // run in the repository; non-zero exit fails it
            throw new GradleException("...")  // fails the task
        }
    }
    project.tasks.check.dependsOn customTask             // runs with the checks (also tasks.test.dependsOn …)
    project.tasks.publish.configure { finalizedBy customTask }   // runs at the end of the task list

A task can depend on others (dependsOn), which run first. doFirst blocks run before doLast blocks. Anything else in a
task body (Groovy logic, other plugins' task types) is reported as not supported, and the task fails, rather than
being silently skipped. Commands run in the repository checkout with a timeout; their output goes to the logs.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

TIMEOUT_S = 300
_TASK_HEAD = re.compile(r"(?m)^\s*(?:task\s+([A-Za-z_]\w*)\s*(\([^)]*\))?|tasks\.register\(\s*['\"]([A-Za-z_]\w*)['\"]\s*(?:,\s*([A-Za-z_][\w.]*))?\s*\))\s*\{")
_HOOK = re.compile(r"(?m)^\s*(?:project\.)?tasks\.(check|test|publish)\.dependsOn\s*\(?\s*([^\n)]+)\)?|^\s*(check|test)\.dependsOn\s*\(?\s*([^\n)]+)\)?")
_FINAL = re.compile(r"(?m)^\s*(?:project\.)?tasks\.(publish|check|test)\.configure\s*\{\s*finalizedBy\s+([^\n}]+)\}")


def _block(text: str, start: int) -> tuple[str, int]:
    """The body of the brace block opening at text[start] == '{' (strings and comments respected), and its end."""
    depth, i, n = 0, start, len(text)
    quote: Optional[str] = None
    while i < n:
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if text.startswith(quote, i):
                i += len(quote)
                quote = None
                continue
        elif text.startswith("//", i):
            i = text.find("\n", i) if "\n" in text[i:] else n
            continue
        elif text.startswith("/*", i):
            i = text.find("*/", i) + 2 if "*/" in text[i:] else n
            continue
        elif text.startswith('"""', i) or text.startswith("'''", i):
            quote = text[i:i + 3]
            i += 3
            continue
        elif ch in "\"'":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
        i += 1
    raise ValueError("unbalanced braces")


def _names(expr: str) -> list[str]:
    return [x.strip().strip("'\"") for x in re.split(r"[,\s]+", expr.strip().strip("[]")) if x.strip().strip("'\"")]


def _string(lit: str) -> str:
    lit = lit.strip()
    if len(lit) >= 2 and lit[0] == lit[-1] and lit[0] in "\"'":
        return lit[1:-1].replace("\\n", "\n").replace('\\"', '"').replace("\\'", "'")
    return lit


def _args(expr: str) -> list[str]:
    """commandLine 'a', "b" / commandLine(['a', 'b']) / commandLine 'a b' → argv."""
    expr = expr.strip().removeprefix("(").removesuffix(")").strip().removeprefix("[").removesuffix("]")
    parts = re.findall(r"\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'", expr)
    argv = [_string(p) for p in parts]
    return shlex.split(argv[0]) if len(argv) == 1 and " " in argv[0] else argv


def _actions(body: str, kind: str = "") -> tuple[list[dict], list[str]]:
    """The steps of a task body: println, exec { commandLine }, throw; doFirst before doLast. (steps, unsupported)."""
    first: list[dict] = []
    last: list[dict] = []
    unsupported: list[str] = []
    depends: list[str] = []
    rest = body
    for name, target in (("doFirst", first), ("doLast", last)):
        while True:
            m = re.search(rf"\b{name}\s*\{{", rest)
            if not m:
                break
            inner, end = _block(rest, m.end() - 1)
            steps, bad = _steps(inner)
            target.extend(steps)
            unsupported += bad
            rest = rest[:m.start()] + rest[end:]
    for m in re.finditer(r"(?m)^\s*dependsOn\s*\(?\s*([^\n)]+)\)?\s*$", rest):
        depends += _names(m.group(1))
    rest = re.sub(r"(?m)^\s*dependsOn\s*\(?\s*([^\n)]+)\)?\s*$", "", rest)
    if kind == "Exec":
        m = re.search(r"(?m)^\s*commandLine\s*(.+)$", rest)
        if m:
            last.insert(0, {"op": "exec", "argv": _args(m.group(1))})
            rest = rest[:m.start()] + rest[m.end():]
        rest = re.sub(r"(?m)^\s*(workingDir|ignoreExitValue)\b.*$", "", rest)
    for line in rest.splitlines():
        s = line.strip()
        if s and not s.startswith("//") and not re.match(r"^(group|description)\s*[=\s]", s):
            unsupported.append(s)
    return [{"op": "depends", "tasks": depends}, *first, *last], unsupported


def _steps(body: str) -> tuple[list[dict], list[str]]:
    steps: list[dict] = []
    bad: list[str] = []
    i = 0
    text = body
    while i < len(text):
        m = re.compile(r"\bexec\s*\{").search(text, i)
        chunk = text[i:m.start()] if m else text[i:]
        for line in chunk.splitlines():
            s = line.strip().rstrip(";")
            if not s or s.startswith("//"):
                continue
            pm = re.match(r"^println\s*\(?\s*(.+?)\s*\)?$", s)
            tm = re.match(r"^throw\s+new\s+(?:org\.gradle\.api\.)?GradleException\s*\(\s*(.+?)\s*\)$", s)
            if pm:
                steps.append({"op": "println", "text": _string(pm.group(1))})
            elif tm:
                steps.append({"op": "throw", "text": _string(tm.group(1))})
            else:
                bad.append(s)
        if not m:
            break
        inner, end = _block(text, m.end() - 1)
        cm = re.search(r"(?m)^\s*commandLine\s*(.+)$", inner)
        ignore = bool(re.search(r"ignoreExitValue\s*(=\s*)?true", inner))
        if cm:
            steps.append({"op": "exec", "argv": _args(cm.group(1)), "ignore_exit": ignore})
        else:
            bad.append("exec { … } without commandLine")
        i = end
    return steps, bad


def parse(files: dict[str, str]) -> list[dict]:
    """Custom tasks of every subproject build.gradle wired into CI: [{project, name, hook (check / test / publish),
    steps, unsupported, file}], in the order CI runs them (check and test hooks first, publish finalizers last)."""
    out: list[dict] = []
    for path, text in sorted(files.items()):
        if not path.endswith("build.gradle") or "/" not in path:
            continue
        project = ":" + path.rsplit("/", 1)[0].split("/")[-1]
        clean = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        tasks: dict[str, dict] = {}
        for m in _TASK_HEAD.finditer(clean):
            name = m.group(1) or m.group(3)
            kind = ""
            if m.group(2):
                km = re.search(r"type\s*:\s*([\w.]+)", m.group(2))
                kind = km.group(1).split(".")[-1] if km else ""
            elif m.group(4):
                kind = m.group(4).split(".")[-1]
            try:
                body, _ = _block(clean, m.end() - 1)
            except ValueError:
                tasks[name] = {"steps": [], "unsupported": ["unbalanced braces"], "kind": kind}
                continue
            steps, bad = _actions(body, kind)
            tasks[name] = {"steps": steps, "unsupported": bad, "kind": kind}
        hooks: list[tuple[str, str]] = []
        for m in _HOOK.finditer(clean):
            hook, expr = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
            hooks += [(hook, n) for n in _names(expr)]
        for m in _FINAL.finditer(clean):
            hooks += [("publish-final", n) for n in _names(m.group(2))]
        for hook, name in sorted(hooks, key=lambda h: h[0] == "publish-final"):
            if name not in tasks:
                out.append({"project": project, "name": name, "hook": hook, "steps": [], "unsupported": [f"no task {name} in {path}"], "file": path, "tasks": tasks})
                continue
            out.append({"project": project, "name": name, "hook": hook, "file": path, "tasks": tasks, **tasks[name]})
    return out


def run(files: dict[str, str], repo_dir: Optional[Path] = None) -> tuple[list[dict], str, bool]:
    """Run the custom tasks: (task entries for the check, logs, ok). Without a checkout the files are written to a
    temporary folder."""
    hooked = parse(files)
    if not hooked:
        return [], "", True
    import tempfile

    tmp = None
    if repo_dir is None:
        tmp = tempfile.TemporaryDirectory(prefix="gradle-tasks-")
        repo_dir = Path(tmp.name)
        for p, content in files.items():
            f = repo_dir / p
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(content, "utf-8")
    logs: list[str] = []
    entries: list[dict] = []
    all_ok = True
    try:
        for t in hooked:
            done: set[str] = set()
            started = time.monotonic()
            ok, detail = _run_task(t, t["name"], repo_dir, logs, done, depth=0)
            all_ok &= ok
            entries.append({"name": f"{t['project']}:{t['name']}", "status": "passed" if ok else "failed", "ms": int((time.monotonic() - started) * 1000),
                            "detail": detail or ("runs at the end of the task list" if t["hook"] == "publish-final" else f"{t['hook']} depends on it"),
                            "custom": True})
    finally:
        if tmp:
            tmp.cleanup()
    return entries, "\n".join(logs), all_ok


def _run_task(t: dict, name: str, repo_dir: Path, logs: list[str], done: set[str], depth: int) -> tuple[bool, str]:
    if name in done:
        return True, ""
    if depth > 20:
        return False, "task dependency cycle"
    done.add(name)
    task = t["tasks"].get(name) if name != t["name"] else t
    if task is None:
        return False, f"no task {name}"
    logs.append(f"> Task {t['project']}:{name}")
    if task.get("unsupported"):
        for u in task["unsupported"]:
            logs.append(f"  not supported here: {u}")
        return False, f"not supported here: {task['unsupported'][0][:120]}"
    for step in task["steps"]:
        if step["op"] == "depends":
            for dep in step["tasks"]:
                ok, why = _run_task(t, dep, repo_dir, logs, done, depth + 1)
                if not ok:
                    return False, f"{dep}: {why}"
        elif step["op"] == "println":
            logs.append(step["text"])
        elif step["op"] == "throw":
            logs.append(f"  GradleException: {step['text']}")
            return False, step["text"]
        elif step["op"] == "exec":
            argv = list(step["argv"])
            if not argv:
                return False, "commandLine is empty"
            if argv[0] in ("python", "python3"):
                argv[0] = sys.executable
            try:
                proc = subprocess.run(argv, cwd=repo_dir, capture_output=True, text=True, timeout=TIMEOUT_S,  # noqa: S603 - the repository's own check command
                                      env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            except FileNotFoundError:
                return False, f"{argv[0]}: command not found"
            except subprocess.TimeoutExpired:
                return False, f"{' '.join(argv)} took longer than {TIMEOUT_S} s"
            out = (proc.stdout + proc.stderr).rstrip()
            if out:
                logs.append(out[-20000:])
            if proc.returncode and not step.get("ignore_exit"):
                return False, f"{' '.join(step['argv'])} exited with {proc.returncode}"
    return True, ""
