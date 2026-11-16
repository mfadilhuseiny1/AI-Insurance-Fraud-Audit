"""Code Workbook [Legacy] (Analytics doc 06): workbooks of nodes that run Python and SQL over datasets in Files.

A workbook is a Files item (CODE_WORKBOOK_MIME). Each branch holds the graph: nodes and the global code.
- Nodes: `input` (an imported Parquet dataset, or a Files folder of unstructured files: Python nodes get a read-only
  file system with ls() / open() / path(), like Foundry's filesystem(); 500 files, 200 MB), `python` (a function named after the node whose parameters are its
  inputs' aliases; pandas DataFrames in and out; matplotlib figures are kept as visualizations), `sql` (DuckDB SQL
  over the inputs' aliases), `manual` (rows typed in) and `template` (a workbook template's code with the node's
  values filled in). Node names are the aliases other nodes use.
- Running a node runs whatever it needs upstream (nothing is cached between runs, like a fresh interactive
  session); "Save as dataset" nodes write Parquet datasets to Files on Build (optional data persistence).
- Console: a snippet (Python or SQL) run with every node it can see, by alias; its result can become a node. It runs
  in a session (a process per user, workbook and branch): what a snippet defines stays for the next one, and node
  outputs are recomputed only when the graph or its datasets change; idle sessions stop after 20 minutes.
- Model outputs: a Python node returning a trained model (predict / transform) passes the object downstream; Save
  keeps it in Files as a pickle (MODEL_MIME), which other workbooks import as an input node.
- Contour nodes: a Contour analysis' path (its result, or a board's data) with parameter values, read like an
  imported dataset by the nodes downstream.
- Multi-node templates: a node with everything upstream of it saved under a name in the workbook; every workbook its
  viewers can open offers it, and applying it adds the nodes with each template input bound to a node of the target.
- Session history: each console session (interactive) and each build (batch) is recorded with its compute
  information, requested settings and resolved environment (every installed package and version); two sessions
  compare package by package. Pinning a session cannot reinstall its packages (nodes run on the API's Python), so a
  pinned workbook reports the packages that differ from the pinned session on every run instead.
- Imported datasets on branches: an input node can name a dataset branch; otherwise a workbook branch reads the
  dataset's branch of the same name when it has one, and master when not (Foundry's fallback).
- Branches: copies of the graph made from a branch; merging into master takes each node from the side that changed
  it since the branch was made, and reports nodes changed on both sides as conflicts to resolve.
- Export to Code Repository: a Python transforms repository with one transform per node.
- Spark environment: the workbook lists Spark profiles (the names Python transforms use: code_pyapi.SPARK_PROFILES);
  unknown or contradicting profiles are refused on save, the workbook's Spark session is created with them (driver
  memory, cores, shuffle partitions, adaptive execution, cross joins, ...), changing them restarts the workbook's
  console sessions, and every session in the history records the profiles it ran with.
- SparkR: an R node can ask for an input as a Spark DataFrame; that needs the SparkR package in the platform's R
  (GET environment reports it), and without it the node fails naming what is missing.

Code runs in a subprocess with the API's Python (pandas, DuckDB, matplotlib, scikit-learn when installed), as Code
Repositories' Python does here; Python nodes get a local Spark session for the inputs they ask for as Spark
DataFrames, and R nodes run in the platform's R.

Mounted by server.py under /api/code-workbooks.
"""

from __future__ import annotations

import copy
import hashlib
import json
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/code-workbooks")
CODE_WORKBOOK_MIME = "application/vnd.bluesandai.code-workbook+json"
MODEL_MIME = "application/vnd.bluesandai.model+pickle"
RUNNER = Path(__file__).with_name("code_workbook_runner.py")
TIMEOUT_S = 180
FILES_LIMIT, FILES_BYTES = 500, 200 * 2**20
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
KINDS = ("input", "python", "sql", "r", "manual", "template", "contour")
SUGGESTED_TEMPLATES = [
    {"id": "tpl-filter", "name": "Filter rows", "language": "sql", "description": "Keep the rows where a column compares to a value.",
     "params": [{"name": "dataset", "type": "input"}, {"name": "column", "type": "column"}, {"name": "operator", "type": "string", "default": "="},
                {"name": "value", "type": "string"}],
     "code": "SELECT * FROM {{dataset}} WHERE \"{{column}}\" {{operator}} '{{value}}'"},
    {"id": "tpl-group", "name": "Group and aggregate", "language": "sql", "description": "One row per group with a count and a sum.",
     "params": [{"name": "dataset", "type": "input"}, {"name": "group_by", "type": "column"}, {"name": "measure", "type": "column"}],
     "code": "SELECT \"{{group_by}}\", COUNT(*) AS n, SUM(\"{{measure}}\") AS total FROM {{dataset}} GROUP BY 1 ORDER BY total DESC"},
    {"id": "tpl-join", "name": "Join two datasets", "language": "sql", "description": "Left join on a key column.",
     "params": [{"name": "left", "type": "input"}, {"name": "right", "type": "input"}, {"name": "key", "type": "column"}],
     "code": "SELECT l.*, r.* EXCLUDE (\"{{key}}\") FROM {{left}} l LEFT JOIN {{right}} r USING (\"{{key}}\")"},
    {"id": "tpl-describe", "name": "Describe columns (pandas)", "language": "python", "description": "Summary statistics of every column.",
     "params": [{"name": "dataset", "type": "input"}],
     "code": "def {{__name__}}({{dataset}}):\n    return {{dataset}}.describe(include='all').reset_index().astype(str)"},
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    u = auth.current() or {}
    return u.get("display_name") or u.get("username") or "local"


def _item(item_id: str, need: str = "viewer") -> dict:
    import drive

    item = drive._item(item_id, need=need)
    if item.get("kind") != "file" or item.get("content_type") != CODE_WORKBOOK_MIME:
        raise HTTPException(404, "workbook not found")
    return item


def _load(item: dict) -> dict:
    import drive

    try:
        w = json.loads(drive.read_bytes(item).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(500, "the workbook is not readable") from None
    w.setdefault("branches", {"master": {"nodes": [], "global_code": "", "updated_at": _now()}})
    w.setdefault("templates", [])
    w.setdefault("graph_templates", [])
    w.setdefault("sessions", [])
    w.setdefault("console", [])
    return w


def _store(item: dict, w: dict) -> None:
    import pipeline_datasets

    pipeline_datasets._replace_content(item, json.dumps(w, ensure_ascii=False).encode("utf-8"), CODE_WORKBOOK_MIME)


def _branch(w: dict, name: Optional[str]) -> dict:
    b = w["branches"].get(name or "master")
    if b is None:
        raise HTTPException(404, f"no branch {name}")
    return b


def _check_graph(nodes: list[dict], templates: list[dict]) -> None:
    names, ids = set(), set()
    for n in nodes:
        if n.get("kind") not in KINDS:
            raise HTTPException(400, f"unknown node kind {n.get('kind')}")
        if not NAME_RE.match(n.get("name") or ""):
            raise HTTPException(400, f"node name {n.get('name')!r}: letters, digits and _ (it is the node's alias in code)")
        if n["name"] in names:
            raise HTTPException(400, f"two nodes are named {n['name']}")
        names.add(n["name"])
        ids.add(n["id"])
    for n in nodes:
        for i in n.get("inputs") or []:
            if i not in ids:
                raise HTTPException(400, f"{n['name']}: an input node no longer exists")
        if n["kind"] == "template" and not any(t["id"] == (n.get("template") or {}).get("id") for t in templates + SUGGESTED_TEMPLATES):
            raise HTTPException(400, f"{n['name']}: the template no longer exists")
    _order(nodes, [n["id"] for n in nodes])


def _folder_files(folder: dict) -> list[tuple[str, dict]]:
    """The files under a folder (recursively) that this user can see, by their path inside it."""
    import db
    import drive

    out: list[tuple[str, dict]] = []
    stack = [(folder["id"], "")]
    while stack:
        fid, prefix = stack.pop()
        for it in auth.visible(db.drive_list(fid)):
            if it["kind"] in drive.CONTAINERS:
                stack.append((it["id"], f"{prefix}{it['name']}/"))
            elif it["kind"] == "file":
                out.append((prefix + it["name"], it))
        if len(out) > FILES_LIMIT:
            raise HTTPException(400, f"{folder['name']} holds more than {FILES_LIMIT} files")
    if sum(int(it.get("size_bytes") or 0) for _, it in out) > FILES_BYTES:
        raise HTTPException(400, f"{folder['name']} holds more than {FILES_BYTES // 2**20} MB")
    return sorted(out)


def _order(nodes: list[dict], wanted: list[str]) -> list[dict]:
    """The wanted nodes and everything upstream of them, inputs first (a cycle is an error)."""
    by = {n["id"]: n for n in nodes}
    out: list[dict] = []
    state: dict[str, int] = {}

    def visit(nid: str) -> None:
        if state.get(nid) == 2:
            return
        if state.get(nid) == 1:
            raise HTTPException(400, f"the graph has a cycle through {by[nid]['name']}")
        state[nid] = 1
        for i in by[nid].get("inputs") or []:
            visit(i)
        state[nid] = 2
        out.append(by[nid])

    for nid in wanted:
        if nid in by:
            visit(nid)
    return out


def _template_code(n: dict, by_id: dict, templates: list[dict]) -> tuple[str, str]:
    t = next(x for x in templates + SUGGESTED_TEMPLATES if x["id"] == n["template"]["id"])
    values = dict(n["template"].get("values") or {})
    code = t["code"]
    for p in t.get("params") or []:
        v = values.get(p["name"], p.get("default", ""))
        if p["type"] == "input":
            v = by_id[v]["name"] if v in by_id else str(v)
        elif not re.fullmatch(r"[^'\"`;\\]*", str(v)):
            raise HTTPException(400, f"{n['name']}: the value of {p['name']} may not contain quotes, backslashes or ;")
        code = code.replace("{{" + p["name"] + "}}", str(v))
    return t["language"], code.replace("{{__name__}}", n["name"])


# ------------------------------------------------------------------ Spark environment


def _profiles(w: dict) -> list[str]:
    return list((w.get("environment") or {}).get("spark_profiles") or [])


def check_profiles(profiles: list) -> tuple[list[str], dict]:
    """The profiles (trimmed, once each) and the settings they resolve to; 400 with the reason when one is unknown,
    two contradict each other, or code_pyapi.spark_settings() refuses the combination."""
    import code_pyapi

    names: list[str] = []
    for p in profiles or []:
        if not isinstance(p, str) or not p.strip():
            raise HTTPException(400, "Spark profiles are names (e.g. DRIVER_MEMORY_MEDIUM)")
        if p.strip() not in names:
            names.append(p.strip())
    if len(names) > 20:
        raise HTTPException(400, "at most 20 Spark profiles")
    try:
        settings = code_pyapi.spark_settings(names)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    setter: dict[str, tuple[str, object]] = {}
    for p in names:
        prof = code_pyapi.SPARK_PROFILES[p]
        sets = {**{k: v for k, v in prof.items() if k != "conf"}, **(prof.get("conf") or {})}
        m = re.fullmatch(r"(.+)_(ENABLED|DISABLED)", p)
        if m and not sets:
            sets = {m.group(1).lower(): m.group(2) == "ENABLED"}  # e.g. DYNAMIC_ALLOCATION_ENABLED / _DISABLED
        for k, v in sets.items():
            if k in setter and setter[k][1] != v:
                raise HTTPException(400, f"Spark profiles {setter[k][0]} and {p} contradict each other (both set {k.replace('_', ' ')}): keep one")
            setter.setdefault(k, (p, v))
    return names, settings


def available_profiles() -> list[dict]:
    import code_pyapi

    return [{"name": k, "sets": {**{a: b for a, b in v.items() if a != "conf"}, **(v.get("conf") or {})}} for k, v in sorted(code_pyapi.SPARK_PROFILES.items())]


def _restart_sessions(item_id: str) -> int:
    """Stop every console session of the workbook (its users' and branches'): the next snippet starts a new one."""
    with _sessions_lock:
        keys = [k for k in _sessions if k[1] == item_id]
    return sum(1 for k in keys if stop_session(k))


def _set_profiles(item: dict, w: dict, profiles: list) -> int:
    """Validate and keep the workbook's Spark profiles (not stored yet); changed profiles restart its sessions."""
    names, _ = check_profiles(profiles)
    if names == _profiles(w):
        return 0
    w["environment"] = {**(w.get("environment") or {}), "spark_profiles": names, "updated_at": _now(), "updated_by": _me()}
    return _restart_sessions(item["id"])


# ------------------------------------------------------------------ console sessions

SESSION_IDLE_S = 20 * 60
_sessions: dict[tuple, dict] = {}
_sessions_lock = threading.Lock()


def _reap() -> None:
    """Stop sessions idle for 20 minutes (or whose process ended)."""
    now = time.monotonic()
    with _sessions_lock:
        for k, sess in list(_sessions.items()):
            if sess["proc"].poll() is not None or now - sess["used"] > SESSION_IDLE_S:
                _stop(sess)
                _sessions.pop(k, None)


def _stop(sess: dict) -> None:
    try:
        sess["proc"].kill()
    except Exception:  # noqa: BLE001
        pass


def _live(key: Optional[tuple], profiles: list[str]) -> Optional[dict]:
    """The running session of this key; one started with other Spark profiles is stopped (a restart)."""
    sess = _sessions.get(key) if key else None
    if not sess or sess["proc"].poll() is not None:
        return None
    if sess.get("profiles", []) != profiles:
        stop_session(key)
        return None
    return sess


def _session(key: tuple, profiles: Optional[list[str]] = None) -> dict:
    _reap()
    with _sessions_lock:
        sess = _sessions.get(key)
        if sess and sess["proc"].poll() is None:
            return sess
        proc = subprocess.Popen([sys.executable, str(RUNNER), "--session"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, bufsize=1)
        lines: "queue.Queue[str]" = queue.Queue()

        def pump() -> None:
            for line in proc.stdout:  # type: ignore[union-attr]
                lines.put(line)

        threading.Thread(target=pump, daemon=True).start()
        sess = {"proc": proc, "lines": lines, "lock": threading.Lock(), "used": time.monotonic(), "graph_key": None, "started": _now(),
                "profiles": list(profiles or [])}
        _sessions[key] = sess
        return sess


SESSIONS_KEPT = 50
_ENV: dict = {}


def resolved_environment() -> dict:
    """The resolved environment of this process: Python and every installed distribution's version."""
    if not _ENV:
        from importlib import metadata

        pkgs = {}
        for d in metadata.distributions():
            name = (d.metadata.get("Name") or "").lower()
            if name:
                pkgs[name] = d.version
        _ENV.update(python=sys.version.split()[0], packages=dict(sorted(pkgs.items())))
    return _ENV


def _drift(w: dict) -> list[dict]:
    """With a pinned session: the packages (and Python) that differ now."""
    pin = next((s for s in w.get("sessions") or [] if s["id"] == w.get("pinned_session")), None)
    if not pin:
        return []
    old, cur = pin["resolved"], resolved_environment()
    out = [{"name": "python", "pinned": old.get("python"), "current": cur["python"]}] if old.get("python") != cur["python"] else []
    for name in sorted(set(old.get("packages") or {}) | set(cur["packages"])):
        a, b = (old.get("packages") or {}).get(name), cur["packages"].get(name)
        if a != b:
            out.append({"name": name, "pinned": a, "current": b})
    return out


def record_session(item: dict, kind: str, branch: str) -> Optional[dict]:
    """Add a session to the workbook's history (editors' sessions; viewers' are not kept)."""
    try:
        _item(item["id"], "editor")
    except HTTPException:
        return None
    env = resolved_environment()
    w = _load(item)
    profiles = _profiles(w)
    try:
        settings = check_profiles(profiles)[1]
    except HTTPException:
        settings = {}
    rec = {"id": f"session-{uuid.uuid4().hex[:10]}", "at": _now(), "kind": kind, "by": _me(), "branch": branch, "status": "succeeded",
           "compute": {"isInteractive": kind == "interactive", "moduleLaunchType": "ON_DEMAND_MODULE", "runner": "python subprocess",
                       "timeout_s": TIMEOUT_S, "spark": True, "spark_profiles": profiles, "spark_settings": settings},
           "requested": {"python": f"=={env['python']}", "packages": ["pandas", "numpy", "pyarrow", "duckdb", "matplotlib"], "pinned_session": None,
                         "spark_profiles": profiles},
           "resolved": env}
    rec["requested"]["pinned_session"] = w.get("pinned_session")
    w["sessions"] = (w.get("sessions") or [])[-(SESSIONS_KEPT - 1):] + [rec]
    _store(item, w)
    return rec


def stop_session(key: tuple) -> bool:
    with _sessions_lock:
        sess = _sessions.pop(key, None)
    if sess:
        _stop(sess)
    return bool(sess)


def _session_call(key: tuple, spec_path: Path, profiles: Optional[list[str]] = None) -> None:
    sess = _session(key, profiles)
    with sess["lock"]:
        sess["used"] = time.monotonic()
        sess["proc"].stdin.write(str(spec_path) + "\n")
        sess["proc"].stdin.flush()
        try:
            sess["lines"].get(timeout=TIMEOUT_S)
        except queue.Empty:
            stop_session(key)
            raise HTTPException(408, f"the console took longer than {TIMEOUT_S} seconds: its session was restarted") from None
        sess["used"] = time.monotonic()


def _plain_numbers(t):
    """Decimal columns (DuckDB's SUM of integers) as int64 / float64, so pandas sees numbers."""
    import pyarrow as pa
    import pyarrow.compute as pc

    for i, f in enumerate(t.schema):
        if pa.types.is_decimal(f.type):
            col = t.column(i)
            try:
                new = pc.cast(col, pa.int64()) if f.type.scale == 0 else pc.cast(col, pa.float64())
            except (pa.ArrowInvalid, OverflowError):
                new = pc.cast(col, pa.float64(), safe=False)
            t = t.set_column(i, f.name, new)
    return t


def _dataset_on_branch(item: dict, wanted: Optional[str], fallback: Optional[str]) -> tuple[dict, str]:
    """The imported dataset's item on the node's dataset branch (an error when it has none), else on the workbook's
    branch when the dataset has it, else master."""
    import dataset_preview
    import drive

    if item["kind"] in drive.CONTAINERS or not (wanted or (fallback and fallback != "master")):
        return item, "master"
    found = {b["branch"]: b["item_id"] for b in dataset_preview.branches(item)}
    if wanted and wanted != "master":
        if wanted not in found and wanted.replace("/", "-") not in found:
            raise HTTPException(404, f'{item["name"]} has no branch "{wanted}"')
        return drive._item(found.get(wanted) or found[wanted.replace("/", "-")]), wanted
    if wanted == "master" or not fallback:
        return drive._item(found.get("master", item["id"])), "master"
    hit = found.get(fallback) or found.get(fallback.replace("/", "-"))
    return (drive._item(hit), fallback) if hit else (drive._item(found.get("master", item["id"])), "master")


def run_graph(w: dict, branch: dict, wanted: Optional[list[str]], persist: bool = False, console: Optional[dict] = None, preview_rows: int = 100,
              session: Optional[tuple] = None, branch_name: Optional[str] = None) -> dict:
    """Run the wanted nodes (all when None) and what they need upstream; returns each node's result. With `session`, the
    console's persistent session runs it (node outputs are reused while the graph and its datasets are unchanged)."""
    import drive

    nodes = branch["nodes"]
    by_id = {n["id"]: n for n in nodes}
    order = _order(nodes, wanted if wanted is not None else [n["id"] for n in nodes])
    spec_nodes, inputs = [], {}
    items = {}
    read_from: dict[str, str] = {}
    files: dict[str, list[tuple[str, dict]]] = {}
    for n in order:
        if n["kind"] == "input":
            try:
                items[n["id"]], read_from[n["id"]] = _dataset_on_branch(drive._item(n.get("dataset_id") or n.get("folder_id") or ""),
                                                                        n.get("dataset_branch"), branch_name)
                if items[n["id"]]["kind"] in drive.CONTAINERS:
                    files[n["id"]] = _folder_files(items[n["id"]])
            except HTTPException as e:
                items[n["id"]] = e
    # what this run reads (datasets, folders and their files, Contour paths' sources): a saved dataset carries their
    # markings, as every output of a pipeline carries all its inputs' (marked_outputs.py)
    read_ids: list[str] = [it["id"] for it in items.values() if isinstance(it, dict)]
    read_ids += [it["id"] for fl in files.values() for _, it in fl]
    read_marks: set[str] = set()
    graph_key = None
    if session:
        ident = [(n["id"], n["name"], n["kind"], n.get("code"), n.get("inputs"), n.get("manual"), n.get("template"), n.get("input_types"),
                  str(getattr(items.get(n["id"]), "get", lambda *_: None)("updated_at")) if n["kind"] == "input" else None,
                  [(p, str(it.get("updated_at"))) for p, it in files.get(n["id"], [])],
                  n.get("contour") if n["kind"] == "contour" else None) for n in order]
        graph_key = hashlib.sha256(json.dumps([ident, branch.get("global_code") or "", w.get("templates")], default=str, sort_keys=True).encode()).hexdigest()
    profiles = _profiles(w)
    with tempfile.TemporaryDirectory(prefix="codeworkbook-") as tmp:
        root = Path(tmp)
        early: dict[str, dict] = {}
        live = _live(session, profiles)  # a session started with other Spark profiles is restarted
        reuse = bool(live and live.get("graph_key") == graph_key)
        for n in order:
            if n["kind"] == "contour":
                # a Contour path's result, computed now (with the user's permissions) and read like a dataset
                cfg = n.get("contour") or {}
                try:
                    import contour

                    citem = contour._item(cfg.get("analysis_id") or "")
                    ca = contour._load(citem)
                    t = _plain_numbers(contour.path_table(ca, cfg.get("path_id") or "", cfg.get("params") or {}, cfg.get("board_id")))
                except HTTPException as e:
                    early[n["name"]] = {"error": f"the Contour path cannot be read: {e.detail}"}
                    continue
                if persist:
                    cmarks, cdatasets = contour._input_markings(citem, ca, cfg.get("path_id") or "")
                    read_marks |= cmarks
                    read_ids.extend(cdatasets)
                if not reuse:
                    import pipeline_datasets

                    dest = root / f"in-{n['id']}.parquet"
                    dest.write_bytes(pipeline_datasets._parquet_bytes(t))
                    inputs[n["name"]] = str(dest)
                pname = next((p["name"] for p in ca["paths"] if p["id"] == cfg.get("path_id")), "")
                early[n["name"]] = {"input": True, "dataset": f"Contour: {ca.get('title', '')} / {pname}", "total": t.num_rows,
                                    "columns": list(t.schema.names), "rows": [], "contour": True}
                continue
            if n["kind"] == "input":
                item = items.get(n["id"])
                if isinstance(item, HTTPException):
                    early[n["name"]] = {"error": f"the dataset cannot be read: {item.detail}"}
                    continue
                if n["id"] in files:
                    # unstructured files: copied under their paths, handed to Python as a file system
                    if not reuse:
                        base = root / f"files-{n['id']}"
                        for rel, it in files[n["id"]]:
                            dest = base / rel
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            dest.write_bytes(drive.read_bytes(it))
                        base.mkdir(exist_ok=True)
                        inputs[n["name"]] = {"files": str(base)}
                    early[n["name"]] = {"input": True, "dataset": item["name"], "files": [p for p, _ in files[n["id"]]][:200]}
                    continue
                if item.get("content_type") == MODEL_MIME:
                    # a model saved by a workbook: unpickled for the Python nodes downstream
                    if not reuse:
                        dest = root / f"in-{n['id']}.model.pkl"
                        dest.write_bytes(drive.read_bytes(item))
                        inputs[n["name"]] = {"model": str(dest)}
                    early[n["name"]] = {"input": True, "dataset": item["name"], "model": {"type": "saved model"}}
                    continue
                if not reuse:
                    dest = root / f"in-{n['id']}.parquet"
                    dest.write_bytes(drive.read_bytes(item))
                    inputs[n["name"]] = str(dest)
                early[n["name"]] = {"input": True, "dataset": item["name"], "dataset_branch": read_from.get(n["id"], "master")}
                continue
            kind, code = n["kind"], n.get("code") or ""
            if kind == "template":
                kind, code = _template_code(n, by_id, w["templates"])
            spec_nodes.append({"name": n["name"], "kind": kind, "code": code, "inputs": [by_id[i]["name"] for i in n.get("inputs") or []],
                               "columns": (n.get("manual") or {}).get("columns") or [], "rows": (n.get("manual") or {}).get("rows") or [],
                               "persist": bool(persist and n.get("save")),
                               # Python nodes: each input as a pandas or a Spark DataFrame (Foundry's input types); R nodes: a
                               # data.frame (default) or, with "spark", a SparkR DataFrame
                               "input_types": {by_id[i]["name"]: t for i, t in (n.get("input_types") or {}).items() if i in by_id and t in ("pandas", "spark")}})
        spec = {"nodes": spec_nodes, "inputs": inputs, "global_python": branch.get("global_code") or "", "out_dir": str(root), "preview_rows": preview_rows,
                "console": console, "graph_key": graph_key, "spark_profiles": profiles}
        (root / "spec.json").write_text(json.dumps(spec), "utf-8")
        started = time.monotonic()
        res_path = root / "results.json"
        if session:
            _session_call(session, root / "spec.json", profiles)
            if not res_path.exists():
                stop_session(session)
                raise HTTPException(500, "the console session failed; it was restarted")
            _sessions.get(session, {})["graph_key"] = graph_key
        else:
            try:
                p = subprocess.run([sys.executable, str(RUNNER), str(root / "spec.json")], capture_output=True, text=True, timeout=TIMEOUT_S, cwd=tmp)
            except subprocess.TimeoutExpired:
                raise HTTPException(408, f"the run took longer than {TIMEOUT_S} seconds and was stopped") from None
            if not res_path.exists():
                raise HTTPException(500, "the run failed: " + (p.stderr or p.stdout or "no output")[-2000:])
        res = json.loads(res_path.read_text("utf-8"))
        res["nodes"] = {**early, **res["nodes"]}
        res["ms"] = int((time.monotonic() - started) * 1000)
        if persist:
            res["saved"] = _persist(w, branch, root, res, read_ids, read_marks)
    return res


def _persist(w: dict, branch: dict, root: Path, res: dict, read_ids: Optional[list[str]] = None, read_marks: Optional[set[str]] = None) -> dict:
    """Save as dataset: the built nodes' outputs as Parquet datasets next to the workbook (rewritten in place), each
    carrying the markings of what the run read and of the workbook: created already marked, or marked before its
    contents are replaced (marked_outputs.py)."""
    import drive
    import marked_outputs
    import pipeline_datasets

    saved = {}
    folder = w.get("_folder_id")
    inputs = list(dict.fromkeys(read_ids or []))
    marks = set(read_marks or ()) | marked_outputs.markings_of([w.get("_item_id"), *inputs])
    todo = []
    for n in branch["nodes"]:
        f = root / f"{n['name']}.parquet"
        model = root / f"{n['name']}.model.pkl"
        if not n.get("save") or not (f.exists() or model.exists()):
            continue
        is_model = model.exists()
        live = pipeline_datasets._live_file(n.get("dataset_out"))
        live = live if live and (live.get("content_type") == MODEL_MIME) == is_model else None
        todo.append((n, model if is_model else f, is_model, live))
    if any(live is None for *_, live in todo):
        folder = drive._folder_id(folder)  # a new output: the Editor role on the workbook's folder
    # a Project constraint any output would violate (409) fails the build before any of them is written
    for _n, _p, _m, live in todo:
        marked_outputs.check(live["id"] if live else folder, marks, exists=bool(live))
    for n, path, is_model, live in todo:
        data = path.read_bytes()
        if live:
            marked_outputs.replace(live, data, MODEL_MIME if is_model else pipeline_datasets.PARQUET, marks, inputs)
        else:
            suffix = "" if w.get("_branch_name") in (None, "master") else f" ({w['_branch_name']})"
            ext, mime = (".model.pkl", MODEL_MIME) if is_model else (".parquet", pipeline_datasets.PARQUET)
            n["dataset_out"] = marked_outputs.create(folder, f"{w['title']} - {n['name']}{suffix}{ext}", data, mime, marks, inputs)["id"]
        n["built_at"] = _now()
        saved[n["name"]] = n["dataset_out"]
    return saved


def _view(item: dict, w: dict, branch: str = "master") -> dict:
    import drive

    try:
        drive._item(item["id"], need="editor")
        can_edit = True
    except HTTPException:
        can_edit = False
    b = _branch(w, branch)
    return {"item": drive._with_path(item), "title": w["title"], "description": w.get("description", ""), "branch": branch,
            "branches": [{"name": k, "created_from": v.get("created_from"), "updated_at": v.get("updated_at"), "merged_at": v.get("merged_at")}
                         for k, v in w["branches"].items()],
            "nodes": b["nodes"], "global_code": b.get("global_code") or "", "templates": w["templates"], "suggested_templates": SUGGESTED_TEMPLATES,
            "graph_templates": w.get("graph_templates") or [], "spark_profiles": _profiles(w),
            "console": w["console"][-50:], "can_edit": can_edit}


# ------------------------------------------------------------------ routes


class NewIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    parent_id: Optional[str] = None
    datasets: list[str] = []


@router.get("")
def list_workbooks() -> list[dict]:
    import db
    import drive

    drive._require_db()
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (CODE_WORKBOOK_MIME,), order="updated_at DESC", limit=500)
    return [drive._with_path(i) for i in auth.visible(items)]


@router.post("")
def create_workbook(req: NewIn) -> dict:
    import drive

    nodes = []
    for k, did in enumerate(req.datasets):
        it = drive._item(did)
        alias = re.sub(r"[^A-Za-z0-9_]", "_", it["name"].removesuffix(".parquet"))[:60].strip("_") or f"input_{k + 1}"
        if alias[0].isdigit():
            alias = "d_" + alias
        nodes.append({"id": uuid.uuid4().hex[:10], "name": alias, "kind": "input", "dataset_id": did, "inputs": [], "x": 40, "y": 40 + 110 * k})
    w = {"title": req.title.strip(), "description": "", "branches": {"master": {"nodes": nodes, "global_code": "", "updated_at": _now()}},
         "templates": [], "console": [], "created_by": _me()}
    parent = drive._folder_id(req.parent_id) if req.parent_id else drive.default_folder("documents")
    item = drive.save_bytes(parent, drive._clean_name(req.title.strip())[:230] + ".codeworkbook", json.dumps(w, ensure_ascii=False).encode("utf-8"), CODE_WORKBOOK_MIME)
    return _view(drive._item(item["id"]), w)


@router.get("/graph-templates")
def list_graph_templates() -> list[dict]:
    """The multi-node templates of every workbook this user can open."""
    out = []
    for it in list_workbooks():
        try:
            w = _load(_item(it["id"]))
        except HTTPException:
            continue
        out.extend({**g, "workbook_id": it["id"], "workbook": w.get("title", "")} for g in w.get("graph_templates") or [])
    return out


@router.get("/{item_id}")
def get_workbook(item_id: str, branch: str = "master") -> dict:
    item = _item(item_id)
    return _view(item, _load(item), branch)


class SaveIn(BaseModel):
    branch: str = "master"
    title: Optional[str] = None
    description: Optional[str] = None
    nodes: list[dict]
    global_code: str = ""
    templates: Optional[list[dict]] = None
    # multi-node templates: [{id, name, description, nodes, templates}] (the nodes as copied: a node and its upstream)
    graph_templates: Optional[list[dict]] = None
    # the workbook's Spark profiles (code_pyapi.SPARK_PROFILES names); changing them restarts its console sessions
    spark_profiles: Optional[list[str]] = None


def _check_graph_templates(gts: list[dict]) -> None:
    ids = set()
    for g in gts:
        if not g.get("id") or g["id"] in ids or not (g.get("name") or "").strip():
            raise HTTPException(400, "multi-node templates need a unique id and a name")
        ids.add(g["id"])
        nodes = g.get("nodes") or []
        if not nodes:
            raise HTTPException(400, f"the template {g['name']} has no nodes")
        _check_graph(nodes, (g.get("templates") or []) + SUGGESTED_TEMPLATES)


@router.put("/{item_id}")
def save_workbook(item_id: str, req: SaveIn) -> dict:
    item = _item(item_id, "editor")
    w = _load(item)
    b = _branch(w, req.branch)
    if b.get("merged_at") and req.branch != "master":
        raise HTTPException(400, "this branch was merged: create a new branch to keep working")
    templates = req.templates if req.templates is not None else w["templates"]
    if req.graph_templates is not None:
        _check_graph_templates(req.graph_templates)
        w["graph_templates"] = req.graph_templates
    for n in req.nodes:
        n.setdefault("id", uuid.uuid4().hex[:10])
        n.setdefault("inputs", [])
    _check_graph(req.nodes, templates)
    # keep what builds recorded (the saved datasets) for nodes that still exist
    built = {n["id"]: {k: n[k] for k in ("dataset_out", "built_at") if k in n} for n in b["nodes"]}
    for n in req.nodes:
        n.update(built.get(n["id"], {}))
    if req.spark_profiles is not None:
        _set_profiles(item, w, req.spark_profiles)
    b.update(nodes=req.nodes, global_code=req.global_code, updated_at=_now())
    w["templates"] = templates
    if req.title:
        w["title"] = req.title.strip()
    if req.description is not None:
        w["description"] = req.description
    _store(item, w)
    return _view(item, w, req.branch)


class RunIn(BaseModel):
    branch: str = "master"
    # node IDs to run (with what they need upstream); none: every node
    nodes: Optional[list[str]] = None
    # the editor's unsaved graph (default: the saved branch)
    draft: Optional[dict] = None


def _with_draft(w: dict, branch: str, draft: Optional[dict]) -> dict:
    b = copy.deepcopy(_branch(w, branch))
    if draft:
        b["nodes"] = draft.get("nodes", b["nodes"])
        b["global_code"] = draft.get("global_code", b.get("global_code"))
        if draft.get("templates") is not None:
            w["templates"] = draft["templates"]
        _check_graph(b["nodes"], w["templates"])
    return b


@router.post("/{item_id}/run")
def run(item_id: str, req: RunIn) -> dict:
    """Run nodes interactively: previews (100 rows), logs, figures and errors per node; nothing is written."""
    w = _load(_item(item_id))
    return {**run_graph(w, _with_draft(w, req.branch, req.draft), req.nodes, branch_name=req.branch), "is_interactive": True, "environment_drift": _drift(w)}


@router.post("/{item_id}/build")
def build(item_id: str, req: RunIn) -> dict:
    """Build: run the saved graph and write every "Save as dataset" node (or the chosen ones) to Files."""
    item = _item(item_id, "editor")
    w = _load(item)
    b = _branch(w, req.branch)
    wanted = req.nodes or [n["id"] for n in b["nodes"] if n.get("save")]
    if not wanted:
        raise HTTPException(400, "mark nodes with Save as dataset first")
    w["_folder_id"], w["_branch_name"], w["_item_id"] = item.get("parent_id"), req.branch, item["id"]
    res = run_graph(w, b, wanted, persist=True, branch_name=req.branch)
    w.pop("_folder_id", None)
    w.pop("_branch_name", None)
    w.pop("_item_id", None)
    _store(item, w)
    session = record_session(item, "batch", req.branch)
    return {**res, "is_interactive": False, "session_id": session["id"] if session else None, "environment_drift": _drift(_load(item))}


class ConsoleIn(BaseModel):
    branch: str = "master"
    language: Literal["python", "sql"] = "python"
    code: str = Field(min_length=1, max_length=50_000)
    # the nodes the snippet can see (with what they need); none: every node
    nodes: Optional[list[str]] = None
    draft: Optional[dict] = None
    # run outside the persistent session (a fresh process)
    fresh: bool = False


@router.delete("/{item_id}/console/session")
def restart_session(item_id: str, branch: str = "master") -> dict:
    """Restart the console session: what earlier snippets defined is gone."""
    _item(item_id)
    return {"stopped": stop_session(((auth.current() or {}).get("id") or "local", item_id, branch))}


@router.post("/{item_id}/console")
def console(item_id: str, req: ConsoleIn) -> dict:
    """The console: a Python or SQL snippet with the nodes available by alias, in the user's session for this workbook and
    branch (what earlier snippets defined stays defined); `fresh` runs it outside the session."""
    item = _item(item_id)
    w = _load(item)
    b = _with_draft(w, req.branch, req.draft)
    key = None if req.fresh else ((auth.current() or {}).get("id") or "local", item_id, req.branch)
    if key and not _live(key, _profiles(w)):
        record_session(item, "interactive", req.branch)  # a new console session starts (first, idle, or other Spark profiles)
        w = _load(item)
        b = _with_draft(w, req.branch, req.draft)
    res = run_graph(w, b, req.nodes, console={"language": req.language, "code": req.code}, preview_rows=20, session=key, branch_name=req.branch)
    out = {**(res.get("console") or {}), "session": bool(key), "names": res.get("session_names") or [], "reused": bool(res.get("reused")),
           "spark": res.get("spark"), "environment_drift": _drift(w)}
    entry = {"at": _now(), "by": _me(), "language": req.language, "code": req.code, "ok": "error" not in out}
    try:
        _item(item_id, "editor")
        w = _load(item)
        w["console"] = (w["console"] + [entry])[-200:]
        _store(item, w)
    except HTTPException:
        pass  # viewers can use the console; their history is not kept
    return out


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=60, pattern=r"^[A-Za-z0-9_.\-/]+$")
    source: str = "master"


@router.post("/{item_id}/branches")
def create_branch(item_id: str, req: BranchIn) -> dict:
    item = _item(item_id, "editor")
    w = _load(item)
    if req.name in w["branches"]:
        raise HTTPException(400, f"branch {req.name} exists")
    src = _branch(w, req.source)
    nodes = copy.deepcopy(src["nodes"])
    for n in nodes:
        n.pop("dataset_out", None)  # a branch builds its own datasets
        n.pop("built_at", None)
    w["branches"][req.name] = {"nodes": nodes, "global_code": src.get("global_code") or "", "created_from": req.source, "created_at": _now(),
                               "updated_at": _now(), "base": {"nodes": copy.deepcopy(src["nodes"]), "global_code": src.get("global_code") or ""}}
    _store(item, w)
    return _view(item, w, req.name)


def _strip(n: Optional[dict]) -> Optional[str]:
    if n is None:
        return None
    return json.dumps({k: v for k, v in n.items() if k not in ("x", "y", "dataset_out", "built_at")}, sort_keys=True)


def merge_plan(w: dict, name: str) -> dict:
    """Three-way merge of a branch into the branch it was made from: per node, global code included."""
    b = _branch(w, name)
    target = _branch(w, b.get("created_from") or "master")
    base = {n["id"]: n for n in (b.get("base") or {}).get("nodes") or []}
    mine = {n["id"]: n for n in b["nodes"]}
    theirs = {n["id"]: n for n in target["nodes"]}
    take, conflicts = {}, []
    for nid in set(base) | set(mine) | set(theirs):
        o, m, t = _strip(base.get(nid)), _strip(mine.get(nid)), _strip(theirs.get(nid))
        if m == t or m == o:
            take[nid] = "target"
        elif t == o:
            take[nid] = "branch"
        else:
            conflicts.append({"id": nid, "name": (mine.get(nid) or theirs.get(nid) or base.get(nid))["name"],
                              "branch": "deleted" if m is None else "changed", "target": "deleted" if t is None else "changed"})
    og, mg, tg = (b.get("base") or {}).get("global_code") or "", b.get("global_code") or "", target.get("global_code") or ""
    gconf = mg != tg and mg != og and tg != og
    return {"take": take, "conflicts": conflicts, "global_conflict": gconf, "global": "branch" if (mg != og and not gconf) else "target",
            "target": b.get("created_from") or "master"}


class MergeIn(BaseModel):
    # conflict resolutions: node ID → "branch" | "target"; "__global__" for the global code
    resolutions: dict[str, Literal["branch", "target"]] = {}
    dry_run: bool = False


@router.post("/{item_id}/branches/{name}/merge")
def merge(item_id: str, name: str, req: MergeIn) -> dict:
    item = _item(item_id, "editor")
    w = _load(item)
    if name == "master":
        raise HTTPException(400, "master is not merged into anything")
    plan = merge_plan(w, name)
    if req.dry_run:
        return plan
    open_ = [c["name"] for c in plan["conflicts"] if c["id"] not in req.resolutions]
    if open_ or (plan["global_conflict"] and "__global__" not in req.resolutions):
        raise HTTPException(409, "resolve the conflicts first: " + ", ".join(open_ + (["global code"] if plan["global_conflict"] else [])))
    b, target = _branch(w, name), _branch(w, plan["target"])
    mine = {n["id"]: n for n in b["nodes"]}
    theirs = {n["id"]: n for n in target["nodes"]}
    side = {**plan["take"], **{k: v for k, v in req.resolutions.items() if k != "__global__"}}
    order = [n["id"] for n in target["nodes"]] + [n["id"] for n in b["nodes"] if n["id"] not in theirs]
    merged = []
    for nid in order:
        src = mine if side.get(nid) == "branch" else theirs
        if nid in src:
            n = copy.deepcopy(src[nid])
            if nid in theirs:  # the target keeps its own built datasets
                n.update({k: theirs[nid][k] for k in ("dataset_out", "built_at") if k in theirs[nid]})
            else:
                n.pop("dataset_out", None)
            merged.append(n)
    _check_graph(merged, w["templates"])
    target["nodes"] = merged
    if req.resolutions.get("__global__", plan["global"]) == "branch":
        target["global_code"] = b.get("global_code") or ""
    target["updated_at"] = _now()
    b["merged_at"] = _now()
    _store(item, w)
    return _view(item, w, plan["target"])


_SPARKR: dict = {}


def sparkr() -> dict:
    """Whether the platform's R has SparkR (asked of Rscript once per API process and R executable)."""
    import code_r
    import code_workbook_runner

    exe = code_r.executable() or ""
    if exe not in _SPARKR:
        _SPARKR[exe] = code_workbook_runner.sparkr_status(exe or None)
    return _SPARKR[exe]


def _environment(w: dict) -> dict:
    from importlib import metadata

    pkgs = []
    for name in ("pandas", "numpy", "pyarrow", "duckdb", "polars", "matplotlib", "scikit-learn", "scipy", "statsmodels", "seaborn", "pyspark"):
        try:
            pkgs.append({"name": name, "version": metadata.version(name)})
        except metadata.PackageNotFoundError:
            pass
    profiles = _profiles(w)
    try:
        settings, problem = check_profiles(profiles)[1], None
    except HTTPException as e:
        settings, problem = {}, str(e.detail)
    r = sparkr()
    return {"python": sys.version.split()[0], "packages": pkgs, "spark": any(p["name"] == "pyspark" for p in pkgs), "timeout_s": TIMEOUT_S,
            "spark_profiles": profiles, "spark_settings": settings, "spark_profiles_problem": problem, "available_profiles": available_profiles(),
            "r": r.get("r"), "sparkr": r,
            "notes": "Nodes run in a fresh Python process per run; the console keeps a session. Python nodes get a local Spark session for inputs "
                     "they ask for as Spark DataFrames, sized by the Spark profiles below. R nodes run in the platform's R."}


@router.get("/{item_id}/environment")
def environment(item_id: str) -> dict:
    """View resolved environment: the interpreter and packages nodes run with, the Spark profiles and SparkR."""
    return _environment(_load(_item(item_id)))


class EnvironmentIn(BaseModel):
    spark_profiles: list[str] = []


@router.put("/{item_id}/environment")
def set_environment(item_id: str, req: EnvironmentIn) -> dict:
    """Update the Spark environment: the workbook's Spark profiles (refused with the reason when unknown or
    contradicting). Changed profiles restart the workbook's console sessions; the next one starts with them."""
    item = _item(item_id, "editor")
    w = _load(item)
    before = _profiles(w)
    restarted = _set_profiles(item, w, req.spark_profiles)
    changed = _profiles(w) != before
    if changed:
        _store(item, w)
    return {**_environment(w), "changed": changed, "sessions_restarted": restarted}


@router.get("/{item_id}/sessions")
def sessions(item_id: str) -> dict:
    """Session history (newest first) and the pinned session."""
    w = _load(_item(item_id))
    return {"sessions": list(reversed(w.get("sessions") or [])), "pinned_session": w.get("pinned_session"), "drift": _drift(w),
            "current": resolved_environment()}


@router.get("/{item_id}/sessions/compare")
def compare_sessions(item_id: str, a: str, b: str = "current") -> dict:
    """Compare two sessions (or one with the current environment): compute, requested and resolved differences."""
    w = _load(_item(item_id))
    by = {s["id"]: s for s in w.get("sessions") or []}

    def pick(sid: str) -> dict:
        if sid == "current":
            return {"id": "current", "compute": {"isInteractive": None, "timeout_s": TIMEOUT_S, "spark": True, "spark_profiles": _profiles(w)},
                    "requested": {"spark_profiles": _profiles(w)}, "resolved": resolved_environment()}
        if sid not in by:
            raise HTTPException(404, f"no session {sid}")
        return by[sid]

    x, y = pick(a), pick(b)
    pk = sorted(set(x["resolved"].get("packages") or {}) | set(y["resolved"].get("packages") or {}))
    diff = [{"name": n, "a": (x["resolved"].get("packages") or {}).get(n), "b": (y["resolved"].get("packages") or {}).get(n)} for n in pk
            if (x["resolved"].get("packages") or {}).get(n) != (y["resolved"].get("packages") or {}).get(n)]
    if x["resolved"].get("python") != y["resolved"].get("python"):
        diff.insert(0, {"name": "python", "a": x["resolved"].get("python"), "b": y["resolved"].get("python")})
    compute = [{"key": k, "a": x["compute"].get(k), "b": y["compute"].get(k)} for k in sorted(set(x["compute"]) | set(y["compute"])) if x["compute"].get(k) != y["compute"].get(k)]
    return {"a": a, "b": b, "resolved": diff, "compute": compute}


class PinIn(BaseModel):
    pin: bool = True


@router.post("/{item_id}/sessions/{session_id}/pin")
def pin_session(item_id: str, session_id: str, req: PinIn) -> dict:
    item = _item(item_id, "editor")
    w = _load(item)
    if req.pin and not any(s["id"] == session_id for s in w.get("sessions") or []):
        raise HTTPException(404, f"no session {session_id}")
    w["pinned_session"] = session_id if req.pin else None
    _store(item, w)
    return {"pinned_session": w["pinned_session"], "drift": _drift(w)}


class ExportIn(BaseModel):
    branch: str = "master"
    name: Optional[str] = None
    output_folder: str = Field("", max_length=300)


@router.post("/{item_id}/export")
def export_repository(item_id: str, req: ExportIn) -> dict:
    """Export to a Code Repository: a Python transforms repository with one transform per Python / SQL node."""
    import code_repos
    import drive

    item = _item(item_id)
    w = _load(item)
    b = _branch(w, req.branch)
    by_id = {n["id"]: n for n in b["nodes"]}
    folder = req.output_folder.strip("/") or "/".join([*(p["name"] for p in drive._with_path(item).get("path") or []), f"{w['title']} export"])

    def ds_path(n: dict) -> str:
        if n["kind"] == "contour":
            import contour

            cfg = n.get("contour") or {}
            saved = (contour._load(contour._item(cfg.get("analysis_id") or "")).get("saved") or {}).get(cfg.get("path_id") or "")
            if not saved or cfg.get("board_id"):
                raise HTTPException(400, f"{n['name']}: save the Contour path as a dataset (Save as dataset in Contour) and use its whole result to export")
            n = {"kind": "input", "dataset_id": saved["dataset_id"]}
        if n["kind"] == "input":
            it = drive._item(n.get("dataset_id") or n.get("folder_id") or "")
            return "/".join([*(p["name"] for p in drive._with_path(it).get("path") or []), it["name"]])
        return f"{folder}/{n['name']}"

    parts = ["from transforms.api import Input, Output, transform, LightweightInput, LightweightOutput", "import pandas as pd", ""]
    if b.get("global_code"):
        parts += ["# global code of the workbook", b["global_code"], ""]
    for n in b["nodes"]:
        if n["kind"] in ("input", "contour"):
            continue
        kind, code = n["kind"], n.get("code") or ""
        if kind == "template":
            kind, code = _template_code(n, by_id, w["templates"])
        ins = [by_id[i] for i in n.get("inputs") or []]
        decl = ",\n    ".join([f'out=Output("{ds_path(n)}")'] + [f'{i["name"]}=Input("{ds_path(i)}")' for i in ins])
        args = ", ".join(["out: LightweightOutput"] + [f"{i['name']}: LightweightInput" for i in ins])
        if kind == "python":
            parts += [f"# node {n['name']}", code.replace(f"def {n['name']}(", f"def _{n['name']}("), "",
                      f"@transform.using(\n    {decl},\n)", f"def {n['name']}({args}) -> None:",
                      f"    out.write_pandas(_{n['name']}({', '.join(f'{i}.pandas()' for i in (x['name'] for x in ins))}))", ""]
        elif kind == "sql":
            regs = "".join(f"\n    con.register({i['name']!r}, {i['name']}.pandas())" for i in ins)
            parts += [f"@transform.using(\n    {decl},\n)", f"def {n['name']}({args}) -> None:", "    import duckdb", "",
                      "    con = duckdb.connect()" + regs, f"    out.write_pandas(con.execute({code!r}).df())", ""]
        elif kind == "manual":
            m = n.get("manual") or {}
            parts += [f"@transform.using(\n    {decl},\n)", f"def {n['name']}({args}) -> None:",
                      f"    out.write_pandas(pd.DataFrame({m.get('rows') or []!r}, columns={m.get('columns') or []!r}))", ""]
    name = re.sub(r"[^A-Za-z0-9 _.\-]", "", req.name or f"{w['title']} transforms").strip()[:100] or "workbook-transforms"
    repo = code_repos.create_repo(code_repos.RepoIn(name=name, description=f"Exported from the Code Workbook {w['title']}", template="python"))
    files = dict(repo["files"])
    target = next((p for p in files if p.endswith("datasets/examples.py")), "src/myproject/datasets/examples.py")
    files[target] = "\n".join(parts)
    code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
    code_repos.commit(repo["id"], code_repos.CommitIn(message=f"Export Code Workbook {w['title']} ({req.branch})"))
    return {"repo_id": repo["id"], "file": target, "transforms": [n["name"] for n in b["nodes"] if n["kind"] not in ("input", "contour")]}
