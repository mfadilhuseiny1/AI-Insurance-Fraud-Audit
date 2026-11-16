"""TypeScript v2 functions: a repository's ts-functions/src/**/*.ts, run with Node (ts_runtime/runner.cjs).

A function is an exported function of a file (a default export takes the file's name), like Foundry's TypeScript v2
functions: a first parameter typed Client / PlatformClient is injected (WriteableClient: staged writes), inputs and
outputs use the @osdk/functions types (string, Integer, Double, boolean, Timestamp, arrays, Osdk.Instance<T>,
ObjectSet<T>, custom types), and Ontology edit functions return Edits from createEditBatch (declared by their
Edits.Object<T> type). The functions registry publishes them with the repository's Python functions (`language`
"typescript") and runs them here: the repository's TypeScript files go to a temporary folder, the runner reads the
signatures with the TypeScript compiler (web/node_modules/typescript) and transpiles the files; the SDK imports
resolve to shims that call the platform API with the run's job token. `export const config = { apiName, edits }` names
the file's function as an API-named query (and declares its edited types); a function calls a query with
`client(query).executeFunction({...})` (the query imported from @ontology/sdk, or `$Queries.<name>`): its arguments are
checked against the query's signature and its result decoded (objects, object sets); inside a staged-write run the
query joins the run's transaction. `client(Type).where({...})` takes OSDK where clauses: property conditions ($eq, $ne,
$gt…$lte, $in, $isNull, $startsWith, $contains, $containsAnyTerm / $containsAllTerms / $containsAllTermsInOrder,
$within / $intersects) and $and / $or / $not at any depth (runtime.js: an $or / $not is evaluated as sets of primary keys,
one search per branch). Inside a staged-write run, what a called function writes without staging (an action it applies)
joins the run's edits right after the call (POST /staged-writes/<id>/direct), as in the Python runtime. Interfaces
(TypeScript v2): Osdk.Instance<Interface> inputs read the interface's properties through the implementing type's
mapping ($objectType, $as(Type)); Edits.Interface<I> declares every implementing type, and batch.update(obj, {...}),
batch.create(I, { $objectType, ... }) and batch.delete(obj) edit through the interface (struct fields merged; the
property the primary key implements cannot be updated).

TypeScript v1 functions run on the same runtime (shims/@foundry/v1.js): decorated methods of exported classes —
`@Function()`, `@OntologyEditFunction()` with `@Edits(Type, ...)`, `@Query({ apiName })` from "@foundry/functions-api" —
with `Objects.search()` / `Objects.create()`, `Filters` and the object types from "@foundry/ontology-api". Their reads are
synchronous (`.all()`, `link.get()`: a worker thread, sync_worker.js), property assignments, `Objects.create()`,
`object.delete()` and link changes are recorded as the function's edits, and an edit of a type missing from `@Edits` is
refused. They are published with the same registry entries (`typescript_version` 1, `class`).

v1 filters include `phrasePrefix` / `prefixOnLastToken` (the last word a prefix; v2 where() takes
`$containsAllTermsInOrderPrefixLastTerm`, or the migration guide's
`{ $interval: { $match, $prefixOnLastTerm, $ordered } }`) and link presence (`o.link.isPresent()`, negated with `Filters.not`).
v2 `$interval` rules also take `$maxGaps`, `$fuzzy` / `$fuzziness` (0 / 1 / 2 / "AUTO" edits, a swap of neighbouring
letters one edit, the v1 `Fuzziness` names too), `{ $anyOf: [rules] }` and `{ $allOf: [rules], $ordered, $maxGaps }`
(matches not overlapping) — sent to the Object Explorer search as its `interval` filter, so only matching objects are
loaded (more than 12 terms in any order, which the search refuses, are checked in Node after a narrowing search;
`BLUESANDAI_TS_INTERVAL_LOCAL=1` checks every rule in Node);
a match lies within one value (one element of an array property).
A v2 where() with `$or` / `$not` (nested with `$and`, `$interval` rules among them) goes to that search as one
`and` / `or` / `not` filter tree, so only matching objects are loaded; a branch holding a part checked in Node, or a tree
nested more than 32 levels, is evaluated as sets of primary keys (one search per branch) — as is every `$or` / `$not`
with `BLUESANDAI_TS_TREE_LOCAL=1`.

@osdk/foundry, the platform SDK (shims/@osdk/foundry/platform.js): `Admin.Users` / `Groups`, `Datasets.Datasets` (get,
readTable as CSV, getSchema) / `Files` (list, get, content), `Filesystem.Resources` / `Folders` / `Projects`,
`Ontologies.*` (objects, object types, links, actions, queries over /api/v2) and `Functions.Queries.execute`, in the real
package's shapes (client first; `@osdk/foundry.admin`, `@osdk/foundry.admin/User`, … sub-packages), with the run's job
token; errors are PalantirApiError.

The checks type-check the files (runner.cjs typeCheck) against the shims' declarations (ts_runtime/types/sdk.d.ts), with
lenient compiler options (no strict mode): Ontology values (clients, objects, object sets, the names imported from
@ontology/sdk) are `any`, everything else is typed. BLUESANDAI_TS_TYPECHECK=0 turns the type check off (syntax only).

Not available: npm dependencies of the repository (an import of one is a type error in the checks).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

RUNNER = Path(__file__).resolve().parent / "ts_runtime" / "runner.cjs"
PREFIX = "ts-functions/"
MARK = "__BSAI_RESULT__"
# nested staged writes: a run's job token -> the staged-writes transaction of the run that called it
STAGED_PARENTS: dict[str, str] = {}


def has_ts(files: dict[str, str]) -> bool:
    return any(p.startswith(PREFIX + "src/") and p.endswith(".ts") for p in files)


def _node() -> str:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is not installed: TypeScript functions cannot run")
    return node


def _visible_types() -> Optional[list[dict]]:
    """The object types the caller can see (GET /api/ontology/object-types without its per-type object, action and
    automation counts, which take seconds per call on a large Ontology and the runtime does not read); None when the
    Ontology cannot be read here (the runtime then asks the API)."""
    try:
        import auth
        import ontology

        with ontology._lock:
            types = auth.visible_resources("object_type", ontology._all("object-types"))
            if "discoverable" in ontology.MODEL_HOOKS:
                types = [t for t in types if ontology.MODEL_HOOKS["discoverable"](t)]
        return types
    except Exception:  # noqa: BLE001 - an optimization only: the runtime falls back to the API's listing
        return None


def _run(files: dict[str, str], mode: str, spec: Optional[dict] = None, timeout: int = 120, token: Optional[str] = None,
         types: Optional[list[dict]] = None) -> dict:
    with tempfile.TemporaryDirectory(prefix="tsfn-", ignore_cleanup_errors=True) as d:
        root = Path(d)
        types_file = ""
        if types is not None:
            types_file = str(root / "object-types.json")
            Path(types_file).write_text(json.dumps(types), encoding="utf-8")
        for p, content in files.items():
            if p.startswith(PREFIX):
                f = root / p
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(content, encoding="utf-8")
        spec_file = root / "spec.json"
        spec_file.write_text(json.dumps(spec or {}), encoding="utf-8")
        env = {**os.environ, "BLUESANDAI_API_URL": os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000"),
               "BLUESANDAI_API_TOKEN": token or "", "BLUESANDAI_SNAPSHOT": (spec or {}).get("snapshot") or "",
               "BLUESANDAI_SCENARIO": (spec or {}).get("scenario") or "",
               # nested staged writes: the caller's transaction, joined by a WriteableClient run (with or without a
               # job token: a run without a signed-in user has none)
               "BLUESANDAI_STAGED_PARENT": (spec or {}).get("staged_parent") or "",
               # the caller's object types, read here (runtime.js types())
               "BLUESANDAI_TS_TYPES": types_file}
        try:
            p = subprocess.run([_node(), str(RUNNER), mode, str(root), str(spec_file)], capture_output=True, text=True, encoding="utf-8",
                               timeout=timeout, env=env, cwd=str(root))
        except subprocess.TimeoutExpired:
            return {"ok": False, "category": "resource_limit", "error": f"the function ran longer than {timeout} s"}
    out, _, result = p.stdout.rpartition("\n" + MARK)
    if not result:
        return {"ok": False, "category": "runtime", "error": (p.stderr or p.stdout or "the TypeScript runner failed").strip()[-2000:]}
    res = json.loads(result.strip())
    res["logs"] = (out + ("\n" + p.stderr if p.stderr else "")).strip()[-4000:]
    return res


def describe(files: dict[str, str]) -> list[dict]:
    res = _run(files, "describe")
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or "the TypeScript functions could not be read")
    return _interface_types(res.get("functions") or [])


def _interface_types(fns: list[dict]) -> list[dict]:
    """Osdk.Instance<I> of an Ontology interface I (the runner reads it as object:I) is an interface input or output
    ("interface:I"), so the registry checks that an object given for it implements the interface."""
    try:
        import ontology

        names = {i["api_name"] for i in ontology._all("interfaces")} - {t["api_name"] for t in ontology._all("object-types")}
    except Exception:  # noqa: BLE001 - no Ontology to look at (the runner alone): the types stay as read
        return fns
    if not names:
        return fns
    conv = lambda s: re.sub(r"\bobject:([A-Za-z0-9_]+)", lambda m: f"interface:{m[1]}" if m[1] in names else m[0], s) if isinstance(s, str) else s  # noqa: E731
    for f in fns:
        f["output"] = conv(f.get("output"))
        for i in f.get("inputs") or []:
            i["type"] = conv(i.get("type"))
    return fns


def check(files: dict[str, str], timeout: int = 120) -> dict:
    """A repository's TypeScript checks (code_repos.run_checks): the files' syntax errors, then their type errors against
    the SDK shims' declarations (`diagnostics`: file, line, column, code, message), the functions that would be
    published and the results of the unit tests in ts-functions/src/**/*.test.ts / *.spec.ts (`tests`, in the shape of
    the Python tests: file, name, ok, skipped, error, ms). The tests run without a job token: they test logic, not the
    Ontology."""
    started = time.monotonic()
    try:
        res = _run(files, "check", timeout=timeout)
    except RuntimeError as e:  # Node.js is missing
        res = {"ok": False, "error": str(e)}
    out = {"diagnostics": res.get("diagnostics") or [], "functions": res.get("functions") or [], "tests": res.get("tests") or [],
           "error": None if res.get("ok") else str(res.get("error") or "the TypeScript checks could not run")[:2000],
           "logs": res.get("logs") or "", "ms": int((time.monotonic() - started) * 1000)}
    return out


def check_tasks(res: dict) -> list[dict]:
    """The check's CI tasks: compiling the functions and running their unit tests."""
    diags, tests = res["diagnostics"], res["tests"]
    failed = [t for t in tests if not t["ok"] and not t.get("skipped")]
    n = len(res["functions"])
    compile_task = {"name": ":ts-functions:compileTypeScript", "status": "failed" if diags or res["error"] else "passed", "ms": res["ms"], "problems": len(diags),
                    "detail": res["error"] or (f"{diags[0]['file']}:{diags[0]['line']}: {diags[0]['message']}" if diags else f"{n} function{'s' if n != 1 else ''}")}
    if diags or res["error"]:
        test_task = {"name": ":ts-functions:test", "status": "skipped", "ms": 0, "detail": "the TypeScript files do not compile"}
    else:
        test_task = {"name": ":ts-functions:test", "status": "failed" if failed else "passed", "ms": sum(t.get("ms") or 0 for t in tests), "problems": len(failed),
                     "detail": f"{len(tests)} test{'s' if len(tests) != 1 else ''}" if tests else "no *.test.ts files"}
    return [compile_task, test_task]


def invoke(files: dict[str, str], spec: dict, timeout: int) -> dict:
    """Run one function with the caller's identity (a job token, like the Python runner)."""
    import auth

    token = auth.issue_job_token(None, timeout + 60, f"function {spec.get('function')}")
    if spec.get("staged_parent") and token:
        # called inside a staged-write run: a WriteableClient's transaction joins the caller's (ontology_scenarios);
        # the runtime also names the parent itself (BLUESANDAI_STAGED_PARENT), which covers runs without a token
        STAGED_PARENTS[token] = spec["staged_parent"]
    try:
        return _run(files, "invoke", spec, timeout + 15, token, _visible_types())
    finally:
        STAGED_PARENTS.pop(token, None)
        auth.revoke_job_token(token)
