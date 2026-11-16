"""Transforms common (palantir.com/docs/foundry/transforms-common): what every transforms language shares.

- Local preview: the Gradle tasks `displayTransformsList` and `datasetPreview --transformId=<id> [--printMode=table]
  [--inputFiles=<alias>:<path>] [--outputFiles=<alias>:<path>]` (Code Repositories' Task Runner, or this API with a
  token). The preview runs here on the platform, like Foundry's Gradle-based preview, and returns a link to the
  computed preview, which only its author can open and which expires after a day; `--printMode=table` prints the first
  10 rows of every previewed dataset instead.
- Transforms versions: every build records the environment it ran on (Spark Details → Environment: the transforms
  version as `sparkModuleVersion`, `sparkVersion`, Java, Scala and Python versions, and the repository environment).
  The runtime table lists what this server runs; there is one runtime per language here, so there is no adjudication
  between versions or module pinning.
- Debug jobs: rerun a failed build's code in the environment of an earlier successful build of the same transform
  (when that environment is still installed), as a preview that commits nothing, to see whether a runtime change broke
  it.
- Multi-output transforms: an advisor over a repository's transforms and builds (shared inputs, multi-output
  transforms and their build times), following "Optimize multi-output transforms".
"""

from __future__ import annotations

import base64
import datetime as dt
import importlib.metadata
import io
import json
import os
import re
import sqlite3
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/transforms-common")

DIR = Path("data/transforms-common")
PREVIEW_HOURS = 24
TABLE_ROWS = 10
_lock = threading.Lock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "transforms-common"
    (DIR / "previews").mkdir(parents=True, exist_ok=True)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


def _repos():
    import code_repos

    return code_repos


# ------------------------------------------------------------------------------------------------
# environments and versions
# ------------------------------------------------------------------------------------------------


def _pkg(name: str) -> Optional[str]:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _scala_version() -> Optional[str]:
    """The Scala version of the Spark jars this server runs (pyspark's jars/scala-library-<v>.jar)."""
    try:
        import importlib.util

        spec = importlib.util.find_spec("pyspark")
        if not spec or not spec.origin:
            return None
        jar = next(iter(sorted((Path(spec.origin).parent / "jars").glob("scala-library-*.jar"))), None)
        return jar.stem.rsplit("-", 1)[-1] if jar else None
    except Exception:  # noqa: BLE001
        return None


_static: dict[str, Any] = {}


def _runtime() -> dict:
    """The versions this server runs, read once."""
    if not _static:
        import code_java
        import code_r

        java = code_java.version() if code_java.available() else None
        _static.update(
            python=sys.version.split()[0],
            spark=_pkg("pyspark"),
            scala=_scala_version(),
            java=(re.search(r"\d+(?:\.\d+)*", java.split("·")[0]).group(0) if java and re.search(r"\d", java) else None),
            java_spark=(java.split("Spark", 1)[1].strip() if java and "Spark" in java else None),
            polars=_pkg("polars"),
            duckdb=_pkg("duckdb"),
            pandas=_pkg("pandas"),
            sqlite=sqlite3.sqlite_version,
            r=code_r.version() if code_r.executable() else None,
        )
    return _static


ENGINES = {"spark": "Spark", "java": "Spark", "lightweight": "Polars / DuckDB (single node)", "df": "pandas", "sql": "SQLite", "r": "R"}


def _transforms_version(files: dict[str, str], language: str) -> str:
    """The transforms version (Foundry's sparkModuleVersion): a Python repository's plugin version from its template
    (gradle.properties); the other languages run the platform's built-in runtime."""
    if language != "python":
        return f"{language}-builtin"
    props = _repos()._props(files.get("gradle.properties") or "")
    return props.get("transformsLangPythonPluginVersion") or f"1.{int(props.get('transformsTemplateVersion') or 1)}.0"


def environment_of(rec: dict, files: dict[str, str], t: dict) -> dict:
    """The environment a build of transform `t` runs on, recorded on the build."""
    rt = _runtime()
    language = t.get("language") or "python"
    kind = t.get("kind") or ("java" if language == "java" else language)
    engine_kind = "java" if language == "java" else kind
    out: dict[str, Any] = {
        "language": language,
        "kind": kind,
        "sparkModuleVersion": _transforms_version(files, language),
        "engine": ENGINES.get(engine_kind, kind),
        "javaVersion": rt["java"] if engine_kind in ("spark", "java") else None,
        "pythonVersion": rt["python"] if language == "python" else None,
        "environment": "platform",
    }
    if engine_kind == "spark":
        out["sparkVersion"], out["scalaVersion"] = rt["spark"], rt["scala"]
    elif engine_kind == "java":
        out["sparkVersion"], out["scalaVersion"] = rt["java_spark"] or rt["spark"], rt["scala"]
    else:
        out["sparkVersion"] = out["scalaVersion"] = None
    if engine_kind == "df" and t.get("engine") == "polars":
        out["engine"] = "Polars"
    if language == "r":
        out["rVersion"] = rt["r"]
    if language == "python":
        try:
            import code_envs

            plan = (_repos()._environment(files, rec) or {}).get("dedicated")
            if plan:
                st = code_envs.status(plan)
                out["environment"] = st["key"]
                out["pythonVersion"] = plan.get("python") or out["pythonVersion"]
                pins = {ln.split("==")[0].lower(): ln.split("==", 1)[1] for ln in st.get("lock") or [] if "==" in ln}
                if engine_kind == "spark" and pins.get("pyspark"):
                    out["sparkVersion"] = pins["pyspark"]
                out["packages"] = len(pins) or None
        except Exception:  # noqa: BLE001 - a broken meta.yaml fails Checks, not the record
            pass
    return out


@router.get("/runtimes")
def runtimes() -> dict:
    """What this server runs for each transforms language (Foundry's release tables, for this deployment)."""
    import code_py_templates

    rt = _runtime()
    rows = [
        {"language": "Python", "transforms_version": code_py_templates.PLUGIN_VERSION, "template_version": code_py_templates.TEMPLATE_VERSION,
         "spark": rt["spark"], "java": rt["java"], "scala": rt["scala"], "python": rt["python"],
         "engines": [e for e in (f"Spark {rt['spark']}" if rt["spark"] else None, f"Polars {rt['polars']}" if rt["polars"] else None,
                                 f"DuckDB {rt['duckdb']}" if rt["duckdb"] else None, f"pandas {rt['pandas']}" if rt["pandas"] else None) if e]},
        {"language": "Java", "transforms_version": "java-builtin", "spark": rt["java_spark"], "java": rt["java"], "scala": rt["scala"],
         "available": rt["java"] is not None, "engines": [f"Spark {rt['java_spark']}"] if rt["java_spark"] else []},
        {"language": "SQL", "transforms_version": "sql-builtin", "spark": None, "java": None, "scala": None, "engines": [f"SQLite {rt['sqlite']}"]},
        {"language": "R", "transforms_version": "r-builtin", "spark": None, "java": None, "scala": None, "available": rt["r"] is not None,
         "engines": [f"R {rt['r']}"] if rt["r"] else []},
    ]
    return {"runtimes": rows, "adjudication": False,
            "note": "One runtime per language is installed on this server: builds always run on it, so there is no automatic "
                    "adjudication between versions and no module pinning. Each build records the versions it ran on."}


@router.get("/repos/{repo_id}/environments")
def environments(repo_id: str) -> list[dict]:
    """The environments a repository's builds ran on, newest first, with the builds on each."""
    C = _repos()
    C._repo(repo_id)
    seen: dict[str, dict] = {}
    for b in C._builds(repo_id):
        env = b.get("environment")
        if not env:
            continue
        k = json.dumps({x: env.get(x) for x in sorted(env)}, sort_keys=True)
        e = seen.setdefault(k, {**env, "builds": 0, "succeeded": 0, "failed": 0, "first_at": b["at"], "last_at": b["at"]})
        e["builds"] += 1
        e["succeeded" if b["status"] == "succeeded" else "failed"] += 1
        e["first_at"] = min(e["first_at"], b["at"])
        e["last_at"] = max(e["last_at"], b["at"])
    return sorted(seen.values(), key=lambda e: e["last_at"], reverse=True)


# ------------------------------------------------------------------------------------------------
# local preview: displayTransformsList, datasetPreview
# ------------------------------------------------------------------------------------------------

ROOTS = ("transforms-python/src/", "transforms-java/src/main/java/", "src/main/java/", "src/")


def transform_id(t: dict) -> str:
    """The id `datasetPreview --transformId` takes: <module>:<function> (src/myproject/datasets/x.py::compute →
    myproject.datasets.x:compute)."""
    f = t["file"]
    for root in ROOTS:
        if f.startswith(root):
            f = f[len(root):]
            break
    module = re.sub(r"\.(py|java|sql|R|r|yml|yaml)$", "", f).replace("/", ".")
    fn = t["key"].split("::", 1)[1] if "::" in t["key"] else t.get("function")
    return f"{module}:{fn}" if fn else module


def _outputs_of(t: dict) -> dict[str, str]:
    if t.get("outputs"):
        return {k: v.get("name") for k, v in t["outputs"].items()}
    if t.get("output"):
        return {t.get("output_param") or "output": t["output"].get("name")}
    return {}


def _listed(rec: dict, files: dict[str, str]) -> list[dict]:
    res = _repos()._run(files, {"mode": "list"}, rec)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "the repository does not load: run Checks")
    return res["transforms"]


def display_transforms_list(rec: dict, branch: dict) -> dict:
    ts = _listed(rec, branch["files"])
    rows = [{"id": transform_id(t), "key": t["key"], "file": t["file"], "language": t.get("language", "python"), "kind": t.get("kind"),
             "inputs": dict(t.get("inputs") or {}), "outputs": _outputs_of(t), "incremental": bool(t.get("incremental"))} for t in ts]
    width = max([len(r["id"]) for r in rows] + [10])
    lines = ["> Task :displayTransformsList", f"Transforms in {rec['name']} (branch {branch['name']}):", ""]
    for r in rows:
        lines.append(f"  {r['id']:<{width}}  inputs: {', '.join(r['inputs']) or '—'}  outputs: {', '.join(r['outputs']) or '—'}")
    if not rows:
        lines.append("  (no transforms)")
    lines += ["", f"Run ./gradlew datasetPreview --transformId=<id> to preview one. {len(rows)} transform{'s' if len(rows) != 1 else ''}."]
    return {"ok": True, "transforms": rows, "logs": "\n".join(lines)}


def _pairs(values: list[str], flag: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for v in values:
        for part in [p for p in v.split(",") if p.strip()]:
            alias, sep, path = part.strip().partition(":")
            if not sep or not alias or not path:
                raise HTTPException(400, f"--{flag} takes <datasetAlias>:<path> (got {part.strip()!r})")
            out.setdefault(alias, []).append(path.strip())
    return out


def _file_view(path: str, data: bytes, size: Optional[int] = None, truncated: bool = False) -> dict:
    """A file of a previewed dataset: a table (Parquet / CSV), text, or binary."""
    view: dict[str, Any] = {"path": path, "size": size if size is not None else len(data), "truncated": truncated}
    low = path.lower()
    try:
        if low.endswith(".parquet") and not truncated:
            import pyarrow.parquet as pq

            table = pq.read_table(io.BytesIO(data))
            head = table.slice(0, 100).to_pylist()
            return {**view, "kind": "table", "rows": table.num_rows, "columns": [{"name": f.name, "type": str(f.type)} for f in table.schema],
                    "preview": [{k: _cell(v) for k, v in r.items()} for r in head]}
    except Exception:  # noqa: BLE001 - shown as binary
        pass
    if b"\x00" in data[:8192]:
        return {**view, "kind": "binary"}
    text = data[:65536].decode("utf-8", errors="replace")
    return {**view, "kind": "text", "text": text, "truncated": truncated or len(data) > 65536}


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


def _input_file(item: dict, path: str) -> dict:
    """A file inside an input dataset: a Files folder (a dataset without a schema) by relative path, or the dataset's
    own file."""
    rel = path.strip("/")
    if item.get("kind") == "file":
        if rel not in ("", item["name"]):
            raise HTTPException(400, f"{item['name']} is a single-file dataset: its only file is {item['name']}")
        target = item
    else:
        target = item
        for part in [p for p in rel.split("/") if p]:
            target = next((c for c in db.drive_list(target["id"]) if c["name"] == part and not c.get("trashed_at")), None)
            if not target:
                raise HTTPException(400, f"no file {path} in {item['name']}")
        if target.get("kind") != "file":
            raise HTTPException(400, f"{path} in {item['name']} is a folder, not a file")
    data = drive.read_bytes(target)
    return _file_view(rel or target["name"], data[:1_000_000], len(data), len(data) > 1_000_000)


def _ascii_table(columns: list[str], rows: list[dict]) -> str:
    cells = [[("null" if r.get(c) is None else str(r.get(c)))[:40] for c in columns] for r in rows]
    widths = [max([len(c)] + [len(row[i]) for row in cells]) for i, c in enumerate(columns)]
    line = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    out = [line, "|" + "|".join(f" {c:<{widths[i]}} " for i, c in enumerate(columns)) + "|", line]
    out += ["|" + "|".join(f" {v:<{widths[i]}} " for i, v in enumerate(row)) + "|" for row in cells]
    out.append(line)
    return "\n".join(out)


class PreviewIn(BaseModel):
    branch: Optional[str] = None
    transform_id: str = Field(min_length=1, max_length=500)
    print_mode: str = "uri"
    input_files: list[str] = Field(default_factory=list, max_length=20)
    output_files: list[str] = Field(default_factory=list, max_length=20)


def dataset_preview(rec: dict, branch: dict, req: PreviewIn) -> dict:
    if req.print_mode not in ("uri", "table"):
        raise HTTPException(400, "--printMode is uri (the default) or table")
    ts = _listed(rec, branch["files"])
    t = next((x for x in ts if req.transform_id in (transform_id(x), x["key"])), None)
    if not t:
        raise HTTPException(400, f"unknown transformId {req.transform_id!r}: run displayTransformsList for the ids")
    ins = _pairs(req.input_files, "inputFiles")
    outs = _pairs(req.output_files, "outputFiles")
    aliases_in = set(t.get("inputs") or {}) | set(t.get("media_inputs") or {})
    aliases_out = set(_outputs_of(t))
    for a in ins:
        if a not in aliases_in:
            raise HTTPException(400, f"--inputFiles: {a!r} is not an input of {transform_id(t)} (inputs: {', '.join(sorted(aliases_in)) or 'none'})")
    for a in outs:
        if a not in aliases_out:
            raise HTTPException(400, f"--outputFiles: {a!r} is not an output of {transform_id(t)} (outputs: {', '.join(sorted(aliases_out)) or 'none'})")
    limit = TABLE_ROWS if req.print_mode == "table" else 100
    res, t, items = _repos().run_preview(rec, branch["files"], branch["name"], t["key"], limit, {"preview_files": outs} if outs else None)
    datasets = []
    if res.get("output_previews"):
        for alias, o in res["output_previews"].items():
            datasets.append({"alias": alias, "name": _outputs_of(t).get(alias) or alias, "kind": o["kind"], "rows": o.get("rows"),
                             "columns": o.get("columns") or [], "preview": o.get("preview") or [], "_contents": o.get("contents") or {}})
    elif res.get("ok"):
        alias = t.get("output_param") or next(iter(_outputs_of(t)), "output")
        datasets.append({"alias": alias, "name": _outputs_of(t).get(alias) or alias, "kind": "dataframe", "rows": res.get("rows"),
                         "columns": res.get("columns") or [], "preview": res.get("preview") or [], "_contents": {}})
    output_files = []
    for alias, paths in outs.items():
        d = next((x for x in datasets if x["alias"] == alias), None)
        for p in paths:
            if not d or d["kind"] != "files":
                output_files.append({"alias": alias, "path": p, "kind": "missing", "error": f"{alias} is a tabular output: it has no files to show"})
                continue
            c = d["_contents"].get(p)
            if not c:
                output_files.append({"alias": alias, "path": p, "kind": "missing", "error": f"the preview did not write {p} to {alias}"})
                continue
            output_files.append({"alias": alias, **_file_view(p, base64.b64decode(c["data"]), c["size"], c["truncated"])})
    for d in datasets:
        d.pop("_contents", None)
    input_files = []
    for alias, paths in ins.items():
        for p in paths:
            try:
                input_files.append({"alias": alias, **_input_file(items[alias], p)})
            except HTTPException as e:
                input_files.append({"alias": alias, "path": p, "kind": "missing", "error": e.detail})
    tid = transform_id(t)
    if req.print_mode == "table":
        lines = [f"> Task :datasetPreview --transformId={tid} --printMode=table"]
        if not res.get("ok"):
            lines.append(f"Preview failed:\n{res.get('error')}")
        for d in datasets:
            lines += ["", f"{d['alias']} ({d['name']}): {d['rows'] if d['rows'] is not None else '?'} rows, first {min(TABLE_ROWS, len(d['preview']))}"]
            cols = [c["name"] for c in d["columns"]]
            lines.append(_ascii_table(cols, d["preview"][:TABLE_ROWS]) if cols else "(no columns)")
        for f in input_files + output_files:
            lines += ["", f"{f['alias']}:{f['path']} ({f['kind']})"]
            if f.get("error"):
                lines.append(f["error"])
            elif f["kind"] == "table":
                lines.append(_ascii_table([c["name"] for c in f["columns"]], f["preview"][:TABLE_ROWS]))
            elif f["kind"] == "text":
                lines.append(f["text"][:2000])
            else:
                lines.append(f"{f['size']} bytes (binary)")
        return {"ok": bool(res.get("ok")), "error": res.get("error"), "logs": "\n".join(lines), "datasets": datasets, "input_files": input_files, "output_files": output_files}
    pid = uuid.uuid4().hex[:16]
    now = _now()
    record = {"id": pid, "owner": _me(), "repo_id": rec["id"], "repo_name": rec["name"], "branch": branch["name"], "transform_id": tid, "key": t["key"],
              "created_at": now.isoformat(timespec="seconds"), "expires_at": (now + dt.timedelta(hours=PREVIEW_HOURS)).isoformat(timespec="seconds"),
              "ok": bool(res.get("ok")), "error": res.get("error"), "logs": (res.get("logs") or "")[-8000:], "datasets": datasets,
              "input_files": input_files, "output_files": output_files, "environment": environment_of(rec, branch["files"], t)}
    _sweep()
    (DIR / "previews" / f"{pid}.json").write_text(json.dumps(record, default=str), "utf-8")
    uri = f"{os.environ.get('BLUESANDAI_WEB_URL', 'http://localhost:8888').rstrip('/')}/transforms-common/previews/{pid}"
    summary = ", ".join(f"{d['alias']} ({d['rows']} rows)" for d in datasets) or "no outputs"
    return {"ok": bool(res.get("ok")), "error": res.get("error"), "preview_id": pid, "uri": uri,
            "logs": f"> Task :datasetPreview --transformId={tid}\n{'Preview computed' if res.get('ok') else 'Preview failed'}: {summary}.\n"
                    f"Open it (only you can, for {PREVIEW_HOURS} hours): {uri}"}


def _sweep() -> None:
    now = _now().isoformat(timespec="seconds")
    for p in (DIR / "previews").glob("*.json"):
        try:
            if json.loads(p.read_text("utf-8")).get("expires_at", "") < now:
                p.unlink()
        except (ValueError, OSError):
            pass


@router.post("/repos/{repo_id}/transforms-list")
def transforms_list(repo_id: str, branch: Optional[str] = None) -> dict:
    """./gradlew displayTransformsList"""
    C = _repos()
    rec = C._repo(repo_id)
    return display_transforms_list(rec, C._branch(rec, branch))


@router.post("/repos/{repo_id}/dataset-preview")
def dataset_preview_endpoint(repo_id: str, req: PreviewIn) -> dict:
    """./gradlew datasetPreview --transformId=<id> [--printMode=table] [--inputFiles=a:p] [--outputFiles=a:p]"""
    C = _repos()
    rec = C._repo(repo_id)
    return dataset_preview(rec, C._branch(rec, req.branch), req)


@router.get("/previews/{preview_id}")
def get_preview(preview_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{16}", preview_id):
        raise HTTPException(404, "no such preview")
    p = DIR / "previews" / f"{preview_id}.json"
    if not p.exists():
        raise HTTPException(404, "this preview does not exist or has expired")
    rec = json.loads(p.read_text("utf-8"))
    if rec["expires_at"] < _now().isoformat(timespec="seconds"):
        p.unlink(missing_ok=True)
        raise HTTPException(404, "this preview has expired: run datasetPreview again")
    if rec["owner"] != _me():
        raise HTTPException(403, "only the user who ran this preview can open it")
    return rec


# ------------------------------------------------------------------------------------------------
# debug jobs
# ------------------------------------------------------------------------------------------------


ENV_KEYS = ("sparkModuleVersion", "sparkVersion", "javaVersion", "scalaVersion", "pythonVersion", "rVersion", "engine", "environment", "packages")


def _debug_jobs() -> list[dict]:
    p = DIR / "debug-jobs.json"
    try:
        return json.loads(p.read_text("utf-8")) if p.exists() else []
    except ValueError:
        return []


class DebugIn(BaseModel):
    # the earlier successful build whose environment (version) to run on
    baseline: str


@router.get("/repos/{repo_id}/builds/{build_id}/debug-candidates")
def debug_candidates(repo_id: str, build_id: str) -> dict:
    """The successful builds of the same transform before a failed one, newest first, with what changed since."""
    C = _repos()
    C._repo(repo_id)
    builds = C._builds(repo_id)
    failed = next((b for b in builds if b["id"] == build_id), None)
    if not failed:
        raise HTTPException(404, "no such build")
    ok = [b for b in builds if b["transform"] == failed["transform"] and b["status"] == "succeeded" and b["at"] <= failed["at"]]
    return {"build": failed, "candidates": [{"id": b["id"], "at": b["at"], "commit": b.get("commit"), "branch": b.get("branch"), "environment": b.get("environment"),
                                             "changes": _env_changes(b.get("environment"), failed.get("environment"))} for b in ok[:20]]}


def _env_changes(before: Optional[dict], after: Optional[dict]) -> list[dict]:
    if not before or not after:
        return []
    return [{"key": k, "before": before.get(k), "after": after.get(k)} for k in ENV_KEYS if before.get(k) != after.get(k)]


@router.post("/repos/{repo_id}/builds/{build_id}/debug")
def debug_job(repo_id: str, build_id: str, req: DebugIn) -> dict:
    """Rerun as debug job: the failed build's code, run as a preview (nothing is committed) on the environment of an
    earlier successful build, to confirm whether a change of transforms version broke it."""
    import code_envs

    C = _repos()
    rec = C._repo(repo_id)
    builds = C._builds(repo_id)
    failed = next((b for b in builds if b["id"] == build_id), None)
    base = next((b for b in builds if b["id"] == req.baseline), None)
    if not failed or not base:
        raise HTTPException(404, "no such build")
    if failed["status"] != "failed":
        raise HTTPException(400, "debug jobs rerun failed builds")
    if base["status"] != "succeeded" or base["transform"] != failed["transform"]:
        raise HTTPException(400, "pick an earlier successful build of the same transform")
    branch = C._branch(rec, failed.get("branch"))
    files = C._commit_files(repo_id, failed["commit"]) if failed.get("commit") else None
    notes = []
    if not files:
        files = branch["files"]
        notes.append("The failed build ran uncommitted code: the debug job runs the branch's current working copy.")
    changes = _env_changes(base.get("environment"), failed.get("environment"))
    base_env = (base.get("environment") or {}).get("environment")
    extra: dict[str, Any] = {}
    ran_on = "current"
    if not base.get("environment") or not failed.get("environment"):
        notes.append("One of the builds ran before builds recorded their environment: the debug job runs on the current environment.")
    elif not changes:
        notes.append("Both builds ran on the same environment: the failure is not caused by a transforms version change.")
    elif base_env and base_env != "platform":
        py = code_envs.python_of_key(base_env)
        if py:
            extra["python_executable"] = py
            ran_on = base_env
        else:
            notes.append(f"The earlier environment {base_env} is no longer installed: the debug job runs on the current one.")
    else:
        notes.append("The earlier build ran on the platform environment, which has since changed and cannot be restored: the debug job runs on the current one.")
    started = _now()
    # Spark transforms: Spark's web UI is captured when the job ends (the debug job's Spark UI)
    extra["spark_ui"] = True
    spark_ui = None
    try:
        res, _, _ = C.run_preview(rec, files, branch["name"], failed["transform"], 20, extra)
        ok, error, logs = bool(res.get("ok")), res.get("error"), (res.get("logs") or "")[-8000:]
        spark_ui = res.get("spark_ui")
    except HTTPException as e:
        ok, error, logs = False, str(e.detail), ""
    if ran_on != "current":
        verdict = ("It succeeds on the earlier version: the change of transforms version broke this build. Pin the repository environment "
                   "(meta.yaml) to the earlier versions while you fix the code.") if ok else \
                  "It fails on the earlier version too: the break is not caused by the transforms version (look at the code or the input data)."
    elif not changes and base.get("environment"):
        verdict = "It succeeds now: the failure was transient or came from data that has since changed." if ok else \
                  "It still fails on the same environment: the code or the input data broke it, not a transforms upgrade."
    else:
        verdict = "It succeeds on the current environment now." if ok else "It still fails; the earlier version could not be restored to compare."
    job = {"id": "debug-" + uuid.uuid4().hex[:12], "repo_id": repo_id, "build_id": build_id, "baseline": base["id"], "transform": failed["transform"],
           "at": started.isoformat(timespec="seconds"), "by": _me(), "ran_on": ran_on, "baseline_environment": base.get("environment"),
           "failed_environment": failed.get("environment"), "changes": changes, "ok": ok, "error": error, "logs": logs, "notes": notes, "verdict": verdict,
           "ms": int((_now() - started).total_seconds() * 1000), "spark_ui": bool(spark_ui and "error" not in spark_ui)}
    if spark_ui:
        (DIR / "spark-ui").mkdir(parents=True, exist_ok=True)
        (DIR / "spark-ui" / f"{job['id']}.json").write_text(json.dumps(spark_ui, default=str), "utf-8")
    with _lock:
        jobs = [job, *_debug_jobs()][:200]
        (DIR / "debug-jobs.json").write_text(json.dumps(jobs, default=str), "utf-8")
    return job


@router.get("/repos/{repo_id}/debug-jobs/{job_id}/spark-ui")
def spark_ui(repo_id: str, job_id: str) -> dict:
    """The debug job's Spark UI: Spark's web UI captured when the job ended (jobs, stages, SQL, executors, environment)."""
    _repos()._repo(repo_id)
    job = next((j for j in _debug_jobs() if j["id"] == job_id and j["repo_id"] == repo_id), None)
    if not job:
        raise HTTPException(404, "no such debug job")
    p = DIR / "spark-ui" / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, "this debug job has no Spark UI (it did not run Spark)")
    return {"job": {k: job.get(k) for k in ("id", "transform", "at", "ok", "error")}, **json.loads(p.read_text("utf-8"))}


@router.get("/repos/{repo_id}/debug-jobs")
def list_debug_jobs(repo_id: str) -> list[dict]:
    _repos()._repo(repo_id)
    return [j for j in _debug_jobs() if j["repo_id"] == repo_id]


# ------------------------------------------------------------------------------------------------
# multi-output transforms advisor
# ------------------------------------------------------------------------------------------------


@router.get("/repos/{repo_id}/outputs")
def outputs_advice(repo_id: str, branch: Optional[str] = None) -> dict:
    """"Optimize multi-output transforms" over a repository: its multi-output transforms and groups of single-output
    transforms that read the same inputs, with their recent build times and failures."""
    C = _repos()
    rec = C._repo(repo_id)
    b = C._branch(rec, branch)
    ts = _listed(rec, b["files"])
    builds = C._builds(repo_id)

    def stats(key: str) -> dict:
        mine = [x for x in builds if x["transform"] == key][:20]
        ms = sorted(x.get("ms") or 0 for x in mine)
        return {"builds": len(mine), "failed": sum(1 for x in mine if x["status"] == "failed"), "median_ms": ms[len(ms) // 2] if ms else None,
                "max_ms": ms[-1] if ms else None, "last_at": mine[0]["at"] if mine else None}

    rows = []
    for t in ts:
        outs = _outputs_of(t)
        rows.append({"id": transform_id(t), "key": t["key"], "kind": t.get("kind"), "language": t.get("language", "python"),
                     "inputs": sorted((t.get("inputs") or {}).values()), "outputs": list(outs.values()), "multi_output": len(outs) > 1, **stats(t["key"])})
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        if not r["multi_output"] and r["inputs"]:
            groups.setdefault(tuple(r["inputs"]), []).append(r)
    advice = []
    for inputs, members in groups.items():
        if len(members) > 1:
            advice.append({"kind": "combine", "transforms": [m["id"] for m in members], "inputs": list(inputs),
                           "message": f"{len(members)} single-output transforms read the same inputs ({', '.join(inputs)}). If their logic is similar and "
                                      "parallelizable, one multi-output transform reads the inputs once and pays the job overhead once; keep them "
                                      "separate if they need different schedules, profiles or failure isolation."})
    for r in rows:
        if r["multi_output"]:
            if r["failed"]:
                advice.append({"kind": "split", "transforms": [r["id"]], "inputs": r["inputs"],
                               "message": f"{r['id']} writes {len(r['outputs'])} outputs and failed {r['failed']} of its last {r['builds']} builds: "
                                          "a failure fails every output. Split it if the outputs' logic differs or one output fails on its own."})
            elif r["max_ms"] and r["median_ms"] and r["max_ms"] > 3 * r["median_ms"]:
                advice.append({"kind": "split", "transforms": [r["id"]], "inputs": r["inputs"],
                               "message": f"{r['id']}'s build time varies a lot (median {r['median_ms'] / 1000:.1f}s, max {r['max_ms'] / 1000:.1f}s): "
                                          "the variance of every input adds up in a multi-output transform."})
    return {"repo": {"id": rec["id"], "name": rec["name"], "branch": b["name"]}, "transforms": rows, "advice": advice}
