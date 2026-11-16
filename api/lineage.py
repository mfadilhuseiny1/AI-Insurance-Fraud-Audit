"""Data Lineage: where every dataset came from and what uses it, across the platform.

The graph is derived on request from what each app already records, so it is never out of step:
- Data Connection: connections → data source syncs → the datasets they ingest (datasources.py)
- Pipeline Builder: each pipeline's inputs (Files datasets, data sources, virtual tables, streams, manual
  data) → the pipeline → the datasets its outputs deployed (the .pipeline files)
- Code Repositories: each built transform's inputs → the transform → its output dataset (code_repos.py)
- Ontology: backing datasets → object types (and additional datasources); action types → the object types they
  edit; object types → AIP Logic functions (inputs) and the object types their actions write, automations (watched
  type → Logic or action), agents (context), Workshop modules (sources, function and action widgets)
- Models and functions: training transforms → models (the model versions a build published) → model functions;
  object types → Python/TypeScript functions (object inputs); functions → the pipelines that call them
- Apps on the Ontology: Vertex graphs and maps (the object types they draw), Device and Machinery processes (their
  object types and changelog datasets) and OSDK applications (Developer Console scopes: object types, actions,
  functions)
- Time series: the dataset a time series sync indexes → the sync → the object types whose time series properties
  read it (sensor object types included)

A node's detail adds what answers the audit questions: where it came from (inputs, "updated via"),
who can see it (share links; the API has no user accounts), whether it is out of date (an input changed
after it was last built), and its builds, schedules and history.

Mounted by server.py under /api/lineage.
"""

from __future__ import annotations

import contextvars
import io
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional
from urllib.parse import quote

import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import agents
import auth
import code_repos
import dataset_versions
import datasources
import db
import drive
import ontology
import pipeline_datasets
import pipeline_schedules
import pipeline_runtime
import workshop

log = logging.getLogger("bluesandai.lineage")
router = APIRouter(prefix="/api/lineage")

KINDS = {
    "connection": "Data connection",
    "datasource": "Data source",
    "dataset": "Dataset",
    "manual": "Manual data",
    "virtual": "Virtual table",
    "stream": "Stream",
    "pipeline": "Pipeline",
    "transform": "Code transform",
    "notebook": "Jupyter notebook",
    "studio": "Model Studio",
    "preparation": "Preparation",
    "sql": "SQL definitions",
    "object_type": "Nexus object type",
    "logic": "AIP Logic",
    "automation": "Automation",
    "agent": "AIP Agent",
    "module": "Workshop module",
    "action": "Nexus action type",
    "function": "Function",
    "model": "Model",
    "vertex": "Vertex graph",
    "map": "Map",
    "osdk_app": "OSDK application",
    "ts_sync": "Time series sync",
    "machinery": "Device and Machinery",
    "restricted_view": "Restricted view",
    "reference": "Reference / paper",
}


def _ts(v: Any) -> Optional[str]:
    if v is None:
        return None
    return v.isoformat() if isinstance(v, datetime) else str(v)


def _newer(a: Optional[str], b: Optional[str]) -> bool:
    """a is later than b (ISO strings, possibly with different offsets)."""
    if not a or not b:
        return False
    try:
        return datetime.fromisoformat(a.replace("Z", "+00:00")) > datetime.fromisoformat(b.replace("Z", "+00:00"))
    except ValueError:
        return a > b


class _Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.edges: dict[tuple[str, str], dict] = {}
        # Nexus link types between object types (not data flow: builds and lineage walks never follow them)
        self.relations: list[dict] = []
        # test items left out of a graph built without them (test_space.py)
        self.hidden_tests = 0

    def node(self, nid: str, kind: str, name: str, **extra: Any) -> str:
        cur = self.nodes.get(nid)
        if cur:
            cur.update({k: v for k, v in extra.items() if v is not None})
        else:
            self.nodes[nid] = {"id": nid, "kind": kind, "kind_label": KINDS[kind], "name": name, **extra}
        return nid

    def edge(self, a: str, b: str, label: str = "") -> None:
        if a != b:
            self.edges.setdefault((a, b), {"from": a, "to": b, "label": label})

    def dataset(self, item_id: str) -> str:
        nid = f"dataset:{item_id}"
        if nid not in self.nodes:
            item = db.drive_get(item_id) if db.enabled() else None
            if item and not item.get("trashed_at"):
                path = [p["name"] for p in db.drive_path(item_id)[:-1]]
                size = item.get("size_bytes")
                if item.get("kind") in drive.CONTAINERS:
                    # a folder read as a dataset (raw files, e.g. the Arsip Sumber .dta files): its files are its data
                    size = sum(c.get("size_bytes") or 0 for c in db.drive_subtree(item_id) if c.get("kind") == "file")
                self.node(nid, "dataset", item["name"], item_id=item_id, path=path, updated_at=_ts(item.get("updated_at")),
                          size=size, link=f"/datasets/{item['id']}")
            else:
                self.node(nid, "dataset", "(deleted dataset)", item_id=item_id, missing=True)
        return nid


# pipeline file contents by item id, kept until the file changes (each graph build read every file from storage).
# Kept without the copies of the inputs' rows (megabytes per file, never drawn) and on disk, so a restarted API does
# not download every pipeline file again before it can draw the lineage (~20 s from S3).
_pipeline_cache: dict[str, tuple[str, dict]] = {}
_pipeline_cache_lock = threading.Lock()
_pipeline_cache_loaded = False


def _pipeline_cache_file():
    return dataset_versions.DIR.parent / "lineage_pipelines.json"


def _summary(content: dict) -> dict:
    """What the lineage reads of a pipeline file: all but the rows kept for its inputs (their count stays)."""
    datasets = {k: ({**d, "rows": [], "rowCount": len(d.get("rows") or [])} if isinstance(d, dict) else d)
                for k, d in (content.get("datasets") or {}).items()}
    return {**content, "datasets": datasets}


def _load_pipeline_cache() -> None:
    global _pipeline_cache_loaded
    with _pipeline_cache_lock:
        if _pipeline_cache_loaded:
            return
        _pipeline_cache_loaded = True
        try:
            data = json.loads(_pipeline_cache_file().read_text("utf-8"))
            for k, (stamp, content) in data.items():
                _pipeline_cache.setdefault(k, (stamp, content))
        except (OSError, ValueError, TypeError):
            pass


def _save_pipeline_cache() -> None:
    path = _pipeline_cache_file()
    with _pipeline_cache_lock:
        data = json.dumps(_pipeline_cache)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
            tmp.write_text(data, "utf-8")
            tmp.replace(path)
        except OSError:
            log.warning("could not save the lineage pipeline cache")


def _pipelines(include_tests: bool = True, skipped: Optional[list] = None) -> list[tuple[dict, dict]]:
    _load_pipeline_cache()
    out = []
    changed = 0
    for item in pipeline_datasets.list_pipelines():
        if not include_tests and item.get("test"):
            if skipped is not None:
                skipped.append(item["id"])
            continue
        stamp = f"{item.get('updated_at')}|{item.get('size_bytes')}"
        hit = _pipeline_cache.get(item["id"])
        if hit and hit[0] == stamp:
            out.append((item, hit[1]))
            continue
        try:
            content = _summary(pipeline_datasets.read_pipeline(item["id"])["content"] or {})
            _pipeline_cache[item["id"]] = (stamp, content)
            changed += 1
            if changed % 20 == 0:
                _save_pipeline_cache()  # a long first read (hundreds of files) is kept as it goes
            out.append((item, content))
        except Exception as e:  # noqa: BLE001 - e.g. a Files row whose bytes are gone: drawn without its steps
            log.warning("could not read pipeline %s: %s", item["id"], getattr(e, "detail", e))
    if changed:
        _save_pipeline_cache()
    return out


def startup() -> None:
    """Read every pipeline file once in the background (as the platform), so the first lineage after a restart does
    not wait for them."""
    def warm() -> None:
        try:
            auth._principal.set({"id": "system", "username": "system", "role": "service", "markings": None, "service": True})
            t = time.monotonic()
            import preparation

            # what the canvas draws (test pipelines left out: reading those hundreds of files here slowed the first
            # lineage threefold, competing for storage; they are read when someone shows test items)
            n = len(_pipelines(False))
            m = len(preparation.all_preparations())
            log.info("lineage: %d pipeline files and %d preparations ready in %.1f s", n, m, time.monotonic() - t)
        except Exception:  # noqa: BLE001
            log.exception("lineage: could not read the pipeline files ahead")

    threading.Thread(target=warm, daemon=True, name="lineage-warm").start()


def build_graph(include_tests: bool = True) -> _Graph:
    """The whole lineage. include_tests=False leaves out test and bug-hunting items (test_space.py): their pipelines are
    not even read (most pipelines in a workspace that tests against the live app are tests), and nodes named or placed
    as tests go with their edges and relations; `g.hidden_tests` counts what was left out."""
    # thousands of items are placed and access-checked: each one's folder path is read once per build
    with db.drive_path_memo():
        return _build_graph(include_tests)


def _build_graph(include_tests: bool) -> _Graph:
    g = _Graph()

    # -- Data Connection -------------------------------------------------------------------------
    sources: list[dict] = []
    try:
        for c in datasources.list_connections():
            g.node(f"connection:{c['id']}", "connection", c["name"], subtitle=c.get("kind"), link="/sources")
        sources = datasources.list_sources()
    except Exception:  # noqa: BLE001 - data sources need the database
        pass
    for s in sources:
        sid = g.node(f"datasource:{s['id']}", "datasource", s["name"], subtitle=f"{s['schema']}.{s['table']}" if s.get("table") else None,
                     updated_at=s.get("updated_at"), status=s.get("status"), link="/sources",
                     schedule=s.get("config", {}).get("frequency") if isinstance(s.get("config"), dict) else None,
                     next_run_at=s.get("next_run_at"))
        g.edge(f"connection:{s['connection']['id']}", sid, "syncs")
        if s["connection"]["id"] and f"connection:{s['connection']['id']}" not in g.nodes:
            g.node(f"connection:{s['connection']['id']}", "connection", s["connection"]["name"], subtitle=s["connection"]["kind"], link="/sources")
        item_id = (s.get("state") or {}).get("item_id")
        if item_id:
            g.edge(sid, g.dataset(item_id), "ingests")

    # -- Pipeline Builder --------------------------------------------------------------------------
    deploy_log = pipeline_datasets.deploys()
    # dataset item id -> [(pipeline node, output name, recorded deploy)]
    claimed: dict[str, list] = {}
    folders: dict[Optional[str], list[dict]] = {}
    skipped: list[str] = []
    pipes = _pipelines(include_tests, skipped)
    g.hidden_tests = len(skipped)
    for item, p in pipes:
        pid = g.node(f"pipeline:{item['id']}", "pipeline", item["name"].removesuffix(".pipeline"), item_id=item["id"],
                     path=[x["name"] for x in item.get("path") or []], updated_at=_ts(item.get("updated_at")),
                     subtitle=p.get("type", "batch"), link=f"/pipeline/{item['id']}", buildable=True,
                     last_build=_last_pipeline_build(item["id"]),
                     schedules=[{"name": s.get("name"), "enabled": s.get("enabled"), "id": s.get("id"), "pipeline_id": item["id"],
                                 "cron": pipeline_schedules.describe_trigger(pipeline_schedules.trigger_of(s))} for s in p.get("schedules") or []])
        for ds in (p.get("datasets") or {}).values():
            ref = ds.get("ref") or {}
            kind = ref.get("kind")
            if kind == "drive" and ref.get("itemId"):
                src = g.dataset(ref["itemId"])
            elif kind == "datasource" and ref.get("id"):
                src = f"datasource:{ref['id']}"
                if src not in g.nodes:
                    g.node(src, "datasource", ds.get("name") or "Data source", link="/sources")
            elif kind == "virtual":
                src = g.node(f"virtual:{ref.get('connectionId')}:{ref.get('database')}.{ref.get('schema')}.{ref.get('table')}", "virtual",
                             ref.get("table") or ds.get("name"), subtitle=f"{ref.get('connectionName', '')} · {ref.get('schema')}", link="/sources")
                if ref.get("connectionId"):
                    g.edge(f"connection:{ref['connectionId']}", src, "reads")
                    g.node(f"connection:{ref['connectionId']}", "connection", ref.get("connectionName") or "Connection", link="/sources")
            elif kind == "stream":
                src = g.node(f"stream:{ref.get('streamId')}", "stream", ds.get("name") or "Stream", link="/pipeline/streams")
            else:
                # data typed or pasted into the pipeline lives in the pipeline file: its app is that pipeline
                src = g.node(f"manual:{item['id']}:{ds.get('id')}", "manual", ds.get("name") or "Manual data", subtitle=ds.get("origin"),
                             rows=ds.get("rowCount", len(ds.get("rows") or [])), columns=[c.get("name") for c in ds.get("columns") or []], link=f"/pipeline/{item['id']}")
            g.edge(src, pid, "input")
        # outputs: what the pipeline file recorded, else a dataset named after the output in its folder
        for o in p.get("outputs") or []:
            if (o.get("kind") or "dataset") != "dataset":
                continue
            dep = o.get("deployed") or {}
            target = dep.get("itemId")
            folder_id = (o.get("location") or {}).get("id") or item.get("parent_id")
            if folder_id not in folders:
                folders[folder_id] = db.drive_list(folder_id) if folder_id else []
            folder = folders[folder_id]
            if not target and o.get("name"):
                want = f"{o['name'].strip()}.parquet".lower()
                found = next((c for c in folder if c["kind"] == "file" and c["name"].lower() == want), None)
                target = found["id"] if found else None
            if target and not any(w[0] == pid for w in claimed.get(target, [])):
                claimed.setdefault(target, []).append((pid, o.get("name"), {**dep, "output_id": o.get("id")}))
    out_streams: dict[tuple[str, str], str] = {}  # (pipeline node, stream name) -> stream node
    g.out_streams = out_streams  # read by _ontology_extras (time-series syncs)
    # a streaming pipeline's outputs are streams (no dataset in its folder): each stream records the pipeline writing
    # it (origin.pipeline_id), so the pipeline → stream edge is certain; its readers already link stream → pipeline
    try:
        import streaming

        with streaming._db() as con:
            stream_recs = [json.loads(r) for (r,) in con.execute("SELECT record FROM streams").fetchall()]
        for s in auth.visible_resources("stream", stream_recs):
            origin = s.get("origin") or {}
            pid = f"pipeline:{origin.get('pipeline_id')}"
            if origin.get("pipeline_id") and pid in g.nodes:
                sid = f"stream:{s['id']}"
                if sid not in g.nodes:
                    g.node(sid, "stream", s.get("name") or "Stream", link="/pipeline/streams")
                g.edge(pid, sid, "writes")
                out_streams[(pid, s.get("name") or "")] = sid
    except Exception as exc:  # noqa: BLE001 - the streams are one part of the graph
        log.warning("lineage: pipeline output streams skipped: %s", exc)
    for item_id, recs in deploy_log.items():
        for d in recs:
            pid = f"pipeline:{d.get('pipeline_id')}"
            if pid in g.nodes and not any(w[0] == pid for w in claimed.get(item_id, [])):
                claimed.setdefault(item_id, []).append((pid, d.get("output"), {"output_id": d.get("output_id")}))
    for item_id, writers in claimed.items():
        if not writers:
            continue
        nid = g.dataset(item_id)
        for pid, out_name, dep in writers:
            g.edge(pid, nid, "deploys")
            log_ = [d for d in deploy_log.get(item_id, []) if f"pipeline:{d.get('pipeline_id')}" == pid]
            # no record of its own write: the dataset's own time stands in (and loses to a writer that recorded one)
            borrowed = not log_ and not dep.get("at")
            for d in (log_ or [{"at": dep.get("at") or g.nodes[nid].get("updated_at"), "rows": dep.get("rows"), "output": out_name}])[:1]:
                g.nodes[nid].setdefault("producers", []).append({"kind": "pipeline", "id": pid, "name": g.nodes[pid]["name"],
                                                                   "at": d.get("at"), "rows": d.get("rows"), "output": d.get("output") or out_name,
                                                                   "output_id": d.get("output_id") or dep.get("output_id"),
                                                                   "status": (g.nodes[pid].get("last_build") or {}).get("status"),
                                                                   **({"at_borrowed": True} if borrowed else {})})

    # -- Code Repositories --------------------------------------------------------------------------
    latest: dict[str, dict] = {}
    attempt: dict[str, dict] = {}
    for b in sorted(code_repos.all_builds(), key=lambda b: b["at"]):
        key = f"{b['repo_id']}::{b['transform']}::{b.get('branch') or b.get('default_branch', 'master')}"
        attempt[key] = b
        if b["status"] == "succeeded" and (b.get("output") or b.get("outputs") or b.get("media_outputs") or b.get("model_versions")):
            latest[key] = b
    repos = code_repos.all_repos()
    schedules = {f"{r['id']}::{s_['transform']}": s_ for r in repos for s_ in r.get("schedules", [])}
    # a transform whose file was deleted from its branch leaves the lineage; its old builds stay in the repository's
    # build history. (Only the file is checked: transforms generated from config have no name in their file.)
    branch_files = {(r["id"], name): br.get("files") or {} for r in repos for name, br in (r.get("branches") or {}).items()}

    def in_code(b: dict, branch: str) -> bool:
        files = branch_files.get((b["repo_id"], branch))
        return files is None or b["transform"].partition("::")[0] in files

    for key, b in latest.items():
        branch = key.rsplit("::", 1)[1]
        if not in_code(b, branch):
            continue
        default = branch == b.get("default_branch", "master")
        sched = schedules.get(f"{b['repo_id']}::{b['transform']}") if default else None
        tid = g.node(f"transform:{key}", "transform", b["transform"].split("::")[-1] + ("" if default else f" @{branch}"),
                     subtitle=f"{b['repo_name']} · {b['transform'].split('::')[0]}", repo_id=b["repo_id"], transform=b["transform"],
                     branch=branch, buildable=default, link=f"/code-repositories/{b['repo_id']}", updated_at=b["at"],
                     last_build={"status": attempt[key]["status"], "at": attempt[key]["at"], "error": attempt[key].get("error")},
                     schedules=[{"name": "Code schedule", "enabled": sched["enabled"], "cron": f"every {sched['every_minutes']} min" if sched.get("every_minutes") else None,
                                 "on_data_update": sched.get("on_input_update"), "id": sched["id"]}] if sched else [])
        for i in b["inputs"]:
            g.edge(g.dataset(i["item_id"]), tid, "input")
        # every output of a multi-output transform (Java, Python @transform.using): datasets, file outputs (folders),
        # media sets, and outputs whose transaction this build aborted (still produced by it); else the one output
        outputs: list[dict] = []
        for o in [*(b.get("outputs") or []), *({**m, "rows": m.get("items"), "media_set": True} for m in b.get("media_outputs") or []),
                  *([b["output"]] if b.get("output") else [])]:
            if o.get("item_id") and all(x["item_id"] != o["item_id"] for x in outputs):
                outputs.append(o)
        for o in outputs:
            out = g.dataset(o["item_id"])
            g.nodes[out].setdefault("producers", []).append({"kind": "transform", "id": tid, "name": g.nodes[tid]["name"], "at": b["at"],
                                                             "commit": b.get("commit"), "rows": o.get("rows"), "branch": branch,
                                                             "status": attempt[key]["status"], "last_attempt": attempt[key]["at"],
                                                             "output": o.get("param"), "aborted": bool(o.get("aborted")),
                                                             "kind_of_output": "files" if o.get("files") else "media_set" if o.get("media_set") else "dataset",
                                                             "inputs": [{"item_id": i["item_id"], "updated_at": i.get("updated_at")} for i in b["inputs"]]})
            g.edge(tid, out, "builds")
        # a model training transform publishes model versions (ModelOutput) instead of datasets
        for mv in b.get("model_versions") or []:
            mid = g.node(f"model:{mv['model_id']}", "model", mv.get("model") or mv["model_id"], subtitle=f"v{mv.get('version')}" if mv.get("version") else None,
                         link=f"/model-assets/{mv['model_id']}", updated_at=b["at"])
            g.edge(tid, mid, "trains")
            # the training code: the repository file and function that published this version (latest build wins)
            path, _, fn = b["transform"].partition("::")
            training = {"repo_id": b["repo_id"], "repo": b.get("repo_name"), "path": path, "function": fn, "branch": branch,
                        "commit": b.get("commit"), "at": b["at"], "version": mv.get("version"), "transform": tid,
                        "link": f"/code-repositories/{b['repo_id']}?file={quote(path)}" + ("" if default else f"&branch={quote(branch)}")}
            prev = g.nodes[mid].get("training")
            if default and (not prev or not prev.get("default") or prev["at"] <= b["at"]):
                g.nodes[mid]["training"] = {**training, "default": True}
            elif not prev:
                g.nodes[mid]["training"] = training

    # -- models trained outside Code Repositories: a Jupyter Code Workspace or a Model Studio run -----------------
    # the training datasets feed the notebook / studio, which trains the model (its latest such version)
    try:
        import model_assets

        for summary in model_assets.list_models(kind="python"):
            mrec, _ = model_assets._get(summary["id"])
            for v in reversed(mrec.get("versions") or []):
                src = v.get("source") or {}
                if src.get("kind") == "code_workspace" and src.get("workspace_id"):
                    pid = g.node(f"notebook:{src['workspace_id']}", "notebook", src.get("repo") or "Notebook", link=f"/code-workspaces?id={src['workspace_id']}",
                                 subtitle="Jupyter Code Workspace")
                    app, link = "Jupyter", f"/code-workspaces?id={src['workspace_id']}"
                elif src.get("kind") == "model_studio" and src.get("studio_id"):
                    pid = g.node(f"studio:{src['studio_id']}", "studio", src.get("repo") or "Model Studio", link=f"/model-studio?id={src['studio_id']}",
                                 subtitle="Model Studio (no-code training)")
                    app, link = "Model Studio", f"/model-studio?id={src['studio_id']}"
                elif src.get("kind") == "aip":
                    # trained by an AIP agent's job (aip/ml.py): the job reads the training data, the model scores the datasets it wrote
                    pid = g.node("aip:ml", "studio", src.get("repo") or "AIP Machine Learning", link="/aip-jkn", subtitle="AIP · benchmark + pelatihan")
                    app, link = "AIP JKN", "/aip-jkn"
                else:
                    continue
                mid = g.node(f"model:{mrec['id']}", "model", mrec.get("name") or mrec["id"], link=f"/model-assets/{mrec['id']}",
                             subtitle=f"v{v.get('version')}" if v.get("version") else None)
                for d in v.get("training_datasets") or []:
                    if d.get("item_id"):
                        g.edge(g.dataset(d["item_id"]), pid, "input")
                g.edge(pid, mid, "trains")
                for d in v.get("outputs") or []:
                    if d.get("item_id"):
                        g.edge(mid, g.dataset(d["item_id"]), "scores")
                prev = g.nodes[mid].get("training")
                # a repository's training (with its source file) stays the model's training code
                if not prev or (prev.get("app") and prev.get("at", "") <= (v.get("created_at") or "")):
                    g.nodes[mid]["training"] = {"app": app, "repo": src.get("repo"), "link": link, "at": v.get("created_at") or "", "version": v.get("version"),
                                                "transform": pid, "path": "", "function": src.get("transform") or ""}
                break
    except Exception:  # noqa: BLE001 - model assets not configured
        log.exception("lineage: models trained in notebooks / Model Studio")

    # -- Ontology and the apps on it ------------------------------------------------------------------
    types = {t["id"]: t for t in ontology.list_object_types()}
    for t in types.values():
        g.node(f"object_type:{t['id']}", "object_type", t["display_name"], subtitle=f"{t['object_count']} objects",
               updated_at=t.get("updated_at"), link=f"/ontology/{t['id']}", status=t.get("status"),
               icon=t.get("icon"), type_color=t.get("color"), primary_key=t.get("primary_key"), object_count=t.get("object_count"))
    # Nexus relations (link types) between object types: drawn apart from the data flow, never walked as lineage
    for lt in ontology._all("link-types"):
        a, b = f"object_type:{lt['source']['object_type_id']}", f"object_type:{lt['target']['object_type_id']}"
        if a in g.nodes and b in g.nodes:
            g.relations.append({"id": lt["id"], "from": a, "to": b, "name": lt.get("display_name") or "", "kind": lt.get("kind"),
                                "cardinality": lt.get("cardinality") or "many_to_one", "source_label": (lt.get("source") or {}).get("display_name"),
                                "target_label": (lt.get("target") or {}).get("display_name"), "foreign_key": lt.get("foreign_key")})
    actions = {a["id"]: a for a in ontology.list_action_types()}
    for f in ontology.list_logic():
        lid = g.node(f"logic:{f['id']}", "logic", f["name"], updated_at=f.get("updated_at"), link=f"/logic/{f['id']}",
                     subtitle=f"{len(f['blocks'])} blocks")
        for i in f["inputs"]:
            if i.get("type") == "object" and f"object_type:{i.get('object_type_id')}" in g.nodes:
                g.edge(f"object_type:{i['object_type_id']}", lid, "input")
        for b in f["blocks"]:
            a = actions.get((b.get("config") or {}).get("action_type_id") or "")
            if b["type"] == "apply_action" and a and f"object_type:{a['object_type_id']}" in g.nodes:
                g.edge(lid, f"object_type:{a['object_type_id']}", f"{a['display_name']}")
    for a in ontology.list_automations():
        aid = g.node(f"automation:{a['id']}", "automation", a["name"], link=f"/automate/{a['id']}", status="enabled" if a["enabled"] else "paused",
                     updated_at=a.get("updated_at"),
                     schedule=f"every {a['condition'].get('every_minutes')} min" if a["condition"].get("kind") == "schedule" else None)
        if a["condition"].get("object_type_id"):
            g.edge(f"object_type:{a['condition']['object_type_id']}", aid, "watches")
        e = a["effect"]
        if e.get("kind") == "logic" and f"logic:{e.get('logic_id')}" in g.nodes:
            g.edge(aid, f"logic:{e['logic_id']}", "runs")
        elif e.get("kind") == "action" and e.get("action_type_id") in actions:
            g.edge(aid, f"object_type:{actions[e['action_type_id']]['object_type_id']}", actions[e["action_type_id"]]["display_name"])
    for ag in agents.list_agents():
        gid = g.node(f"agent:{ag['id']}", "agent", ag["name"], link=f"/agents/{ag['id']}", updated_at=ag.get("updated_at"), subtitle=ag.get("model"))
        for c in ag["contexts"]:
            if f"object_type:{c['object_type_id']}" in g.nodes:
                g.edge(f"object_type:{c['object_type_id']}", gid, "context")
        for fid in ag["tools"].get("logic", []):
            if f"logic:{fid}" in g.nodes:
                g.edge(gid, f"logic:{fid}", "tool")
    # -- restricted views: a dataset's rows filtered per user (granular policy); object types they back ---------
    try:
        import restricted_views

        for rv in restricted_views._all():
            vid = g.node(f"restricted_view:{rv['id']}", "restricted_view", rv["name"], link=f"/restricted-views?view={rv['id']}",
                         updated_at=rv.get("updated_at") or rv.get("created_at"), subtitle="row policy" + (" · protected" if rv.get("protected") else ""),
                         project_id=rv.get("project_id"))
            g.edge(g.dataset(rv["backing_item_id"]), vid, "filters")
            for tid in rv.get("object_types") or []:
                if f"object_type:{tid}" in g.nodes:
                    g.edge(vid, f"object_type:{tid}", "row policy")
    except Exception:  # noqa: BLE001
        log.exception("lineage: restricted views")
    for m in workshop.list_modules():
        mid = g.node(f"module:{m['id']}", "module", m["name"], link=f"/workshop/{m['id']}", updated_at=m.get("updated_at"),
                     subtitle=f"{len(m['widgets'])} widgets", item_id=m.get("item_id"))
        for w in m["widgets"]:
            s = (w.get("config") or {}).get("source")
            if not s:
                continue
            src = (g.dataset(s["id"]) if s["kind"] == "dataset" else f"restricted_view:{str(s['id']).rsplit('.', 1)[-1]}" if s["kind"] == "restricted_view"
                   else f"object_type:{s['id']}")
            if src in g.nodes:
                g.edge(src, mid, "displays")

    # -- what an object type is built from, what writes it, and the functions, models and apps on it -----
    try:
        _ontology_extras(g, types, pipes)
    except Exception:  # noqa: BLE001 - lineage never fails because one app's records cannot be read
        log.exception("lineage: ontology extras")

    # -- Preparation [Sunset]: a starting dataset, a changelog, the datasets saved from it --------------
    try:
        import preparation

        for item, prep in preparation.all_preparations():
            nid = g.node(f"preparation:{item['id']}", "preparation", item["name"].removesuffix(".preparation"), item_id=item["id"],
                         path=[x["name"] for x in db.drive_path(item["id"])[:-1]], updated_at=_ts(prep.get("updated_at")),
                         subtitle=f"{len(prep.get('changes') or [])} changes", link=f"/preparation/{item['id']}", buildable=True)
            if (prep.get("input") or {}).get("item_id"):
                g.edge(g.dataset(prep["input"]["item_id"]), nid, "input")
            for o in prep.get("outputs") or []:
                out = g.dataset(o["item_id"])
                g.nodes[out].setdefault("producers", []).append({"kind": "preparation", "id": nid, "name": g.nodes[nid]["name"], "at": o.get("saved_at"),
                                                                 "rows": o.get("rows"), "status": "succeeded", "last_attempt": o.get("saved_at"),
                                                                 "inputs": [{"item_id": prep["input"]["item_id"]}]})
                g.edge(nid, out, "builds")
    except Exception:  # noqa: BLE001 - preparations need the database
        pass

    # -- SQL definitions (SQL Studio writes): every retained definition's inputs, active or not ------------
    try:
        import sql_writes

        for item_id, defs in sql_writes.all_definitions().items():
            item = db.drive_get(item_id)
            if not item or item.get("trashed_at") or not defs:
                continue
            active = next((d for d in defs if d["active"]), defs[-1])
            nid = g.node(f"sql:{item_id}", "sql", f"SQL: {item['name']}", item_id=item_id, path=[x["name"] for x in db.drive_path(item_id)[:-1]],
                         updated_at=active.get("last_run_at"), subtitle=f"{len(defs)} definition{'s' if len(defs) != 1 else ''} · {active['operation']}",
                         link=f"/datasets/{item_id}?tab=details", buildable=True)
            out = g.dataset(item_id)
            for i in sorted({i for d in defs for i in d.get("inputs") or []}):
                if db.drive_get(i):
                    g.edge(g.dataset(i), nid, "input")
            g.nodes[out].setdefault("producers", []).append({"kind": "sql", "id": nid, "name": g.nodes[nid]["name"], "at": active.get("last_run_at"),
                                                             "status": "succeeded", "last_attempt": active.get("last_run_at"),
                                                             "inputs": [{"item_id": i} for i in active.get("inputs") or []]})
            g.edge(nid, out, "builds")
    except Exception:  # noqa: BLE001 - definitions need the database
        pass

    # -- every dataset in Files, connected or not, so any can be looked up ------------------------------
    for d in workshop.datasets():
        g.dataset(d["id"])

    # -- references: papers and standards a pipeline, model or object type is built on (provenance of the method) --
    for r in references():
        rid = g.node(f"reference:{r['id']}", "reference", r.get("short") or r["title"], subtitle=f"{r.get('venue') or ''} {r.get('year') or ''}".strip(),
                     link=r.get("url") or (f"https://doi.org/{r['doi']}" if r.get("doi") else None), item_id=r.get("item_id"),
                     updated_at=r.get("updated_at"), title=r.get("title"), authors=r.get("authors"), doi=r.get("doi"), note=r.get("note"),
                     license=r.get("license"))
        for target in r.get("informs") or []:
            if target.get("node") in g.nodes:
                g.edge(rid, target["node"], target.get("relation") or "informs")

    # -- object types written by a process reading streams (a detector, not an indexed datasource): the type records
    #    the streams it is fed by (fed_by_streams), so the stream → object type edge closes the lineage to the Nexus
    for t in ontology._all("object-types"):
        oid = f"object_type:{t['id']}"
        for sid in t.get("fed_by_streams") or []:
            if oid in g.nodes and f"stream:{sid}" in g.nodes:
                g.edge(f"stream:{sid}", oid, "feeds")

    # -- the AIP fraud system: production pipeline, model package, online service, tags (aip/produksi.py) --------
    try:
        from aip import produksi

        produksi.lineage(g)
    except Exception:  # noqa: BLE001 - the fraud pipeline not set up, or not readable by the caller
        log.exception("lineage: AIP fraud pipeline")

    _current_producers(g)

    # -- health: a built dataset is out of date when an input changed after its last build ----------------
    for n in g.nodes.values():
        if n["kind"] != "dataset" or not n.get("producers"):
            continue
        last = max(n["producers"], key=_written)
        n["updated_via"] = {"kind": last["kind"], "id": last["id"], "name": last["name"]}
        stale = []
        for e in g.edges.values():
            if e["to"] != last["id"]:
                continue
            src = g.nodes.get(e["from"])
            if src and src["kind"] == "dataset" and _newer(src.get("updated_at"), last.get("at")):
                stale.append(src["name"])
        if stale:
            n["stale"] = f"{', '.join(stale)} changed after the last build"
        n["last_build"] = {"status": last.get("status") or "succeeded", "at": last.get("last_attempt") or last.get("at")}
    rules = _health_rules()
    for n in g.nodes.values():
        if n.get("path"):
            n["project"] = n["path"][0]
            n["folder"] = " / ".join(n["path"])
        if n["kind"] == "dataset" and not n.get("missing"):
            meta = _schema(n["item_id"], n.get("updated_at"), n.get("size"))
            if meta:
                n["rows"], n["columns"] = meta["rows"], meta["columns"]
            n["transactions"] = len(dataset_versions.history(n["item_id"]))
            if n.get("producers"):
                p = g.nodes.get((n.get("updated_via") or {}).get("id"))  # the current producer's schedules
                n["schedule_count"] = len([s_ for s_ in (p or {}).get("schedules") or [] if s_.get("enabled")])
            if rules.get(n["item_id"]):
                n["health"] = evaluate_health(n, rules[n["item_id"]])
        elif n.get("schedules") is not None:
            n["schedule_count"] = len([s_ for s_ in n["schedules"] if s_.get("enabled")])
    _save_schemas(force=True)
    if not include_tests:
        _drop_tests(g)
    return g


def _written(p: dict) -> tuple:
    """When a producer last wrote its dataset, as an instant: the times mix UTC and WIB offsets, and compared as text
    "17:51:15+07:00" beat the same moment written "10:51:15+00:00" (the archived SQL pipeline won over the pipeline that
    replaced it, 2026-10-28). A time borrowed from the dataset itself loses a tie to a recorded write."""
    return (_parse(p.get("at")) or datetime.min.replace(tzinfo=timezone.utc), not p.get("at_borrowed"))


def _current_producers(g: _Graph) -> None:
    """One producer per dataset: the one that wrote its current version. The BPJS silver and gold moved from Code
    Repository transforms and an SQL pipeline into one Pipeline Builder pipeline (2026-10-26): 26 datasets drew the old
    writers beside the new, and an ancestors build walked into the old code (whose build would overwrite the data with
    older logic). An older writer stays in the dataset's history (`producers`, marked `replaced_by`), not as an edge;
    a job left writing nothing current is not built from the lineage (`replaced`, not buildable)."""
    replaced: dict[str, list[dict]] = {}
    for nid, n in g.nodes.items():
        ps = n.get("producers") or []
        if n["kind"] != "dataset" or len({p["id"] for p in ps}) < 2:
            continue
        cur = max(ps, key=_written)
        for p in ps:
            if p["id"] != cur["id"]:
                p["replaced_by"] = {"id": cur["id"], "name": cur["name"], "at": cur.get("at")}
                g.edges.pop((p["id"], nid), None)
                replaced.setdefault(p["id"], []).append({"dataset": n["name"], "by": cur["name"], "at": cur.get("at")})
    writing = {e["from"] for e in g.edges.values() if e["label"] in ("builds", "deploys", "writes", "trains", "scores", "packages")}
    for pid, outs in replaced.items():
        if pid in g.nodes:
            g.nodes[pid]["replaced"] = outs
            if pid not in writing:
                g.nodes[pid]["buildable"] = False


# a built graph, briefly reused: clicking nodes (properties, code) used to rebuild the whole graph — every pipeline of
# the workspace, tests included — on each click. Keyed by account (listings follow its access) and by test mode.
GRAPH_TTL = 90.0  # long enough to browse a graph's nodes without rebuilding; changes show within 1.5 min
_built: dict[tuple[bool, Optional[str]], tuple[float, "_Graph"]] = {}
_build_locks: dict[tuple[bool, Optional[str]], threading.Lock] = {}
_build_locks_guard = threading.Lock()


_refreshing: set[tuple[bool, Optional[str]]] = set()


def cached_graph(include_tests: bool = False) -> "_Graph":
    """build_graph(include_tests) for the caller, reused for GRAPH_TTL seconds; concurrent callers wait for one build.
    Past GRAPH_TTL the graph already built is still answered at once while a fresh one is built in the background
    (a build takes seconds: every app's records), so only an account's first lineage waits for one."""
    key = (include_tests, (auth.current() or {}).get("id"))
    with _build_locks_guard:
        lock = _build_locks.setdefault(key, threading.Lock())
        hit = _built.get(key)
        if hit and time.monotonic() - hit[0] >= GRAPH_TTL and key not in _refreshing:
            _refreshing.add(key)

            def refresh() -> None:
                try:
                    with lock:
                        _built[key] = (time.monotonic(), build_graph(include_tests=include_tests))
                except Exception:  # noqa: BLE001 - the stale graph stays; the next call tries again
                    log.exception("lineage: background rebuild failed")
                finally:
                    with _build_locks_guard:
                        _refreshing.discard(key)

            # as the caller: the graph follows its access
            threading.Thread(target=contextvars.copy_context().run, args=(refresh,), daemon=True, name="lineage-refresh").start()
        if hit:
            return hit[1]
    with lock:
        hit = _built.get(key)
        if hit:
            return hit[1]
        g = build_graph(include_tests=include_tests)
        _built[key] = (time.monotonic(), g)
        return g


def _graph_with(nid: str) -> "_Graph":
    """The graph a node's panels read: the one without test items (as the canvas), the full one for a test node."""
    g = cached_graph(False)
    return g if nid in g.nodes else cached_graph(True)


def _drop_tests(g: "_Graph") -> None:
    """Remove the test nodes still in the graph (datasets in test projects, test object types, repositories…)."""
    import test_space

    gone = {nid for nid, n in g.nodes.items()
            if test_space.is_test_name(n.get("name")) or test_space.is_test_path(n.get("path")) or test_space.is_test_name(n.get("subtitle"))}
    for nid in gone:
        g.nodes.pop(nid, None)
    g.edges = {k: e for k, e in g.edges.items() if e["from"] not in gone and e["to"] not in gone}
    g.relations = [r for r in g.relations if r["from"] not in gone and r["to"] not in gone]
    g.hidden_tests += len(gone)


def _ontology_extras(g: _Graph, types: dict[str, dict], pipes: list[tuple[dict, dict]]) -> None:
    by_api = {t.get("api_name"): tid for tid, t in types.items()}

    # backing datasets (Data Lineage: a dataset "defines an object type") and additional datasources
    for t in ontology._all("object-types"):
        tnode = f"object_type:{t['id']}"
        if tnode not in g.nodes:
            continue
        for d, label in [(t.get("backing_dataset"), "backs"), *((x, "backs (additional)") for x in t.get("additional_datasources") or [])]:
            if d and d.get("dataset_id"):
                ds = g.dataset(d["dataset_id"])
                g.nodes[ds]["defines_object_types"] = sorted({*g.nodes[ds].get("defines_object_types", []), t["display_name"]})
                g.edge(ds, tnode, label)

    # action types write the object type they edit
    actions = {a["id"]: a for a in ontology.list_action_types()}
    for a in actions.values():
        if f"object_type:{a.get('object_type_id')}" in g.nodes:
            aid = g.node(f"action:{a['id']}", "action", a["display_name"], link=f"/ontology/action-types/{a['id']}",
                         updated_at=a.get("updated_at"), subtitle=f"{len(a.get('parameters') or [])} parameters")
            g.edge(aid, f"object_type:{a['object_type_id']}", "edits")

    # functions: object inputs, ontology edits, the code repository that publishes them
    import functions_registry

    def obj_types(sig: str) -> list[str]:
        return [by_api[m] for m in re.findall(r"object:(\w+)", sig or "") if m in by_api]

    for f in functions_registry.all_functions():
        ins = [tid for i in f.get("inputs") or [] for tid in obj_types(str(i.get("type")))]
        edits = [by_api.get(e if isinstance(e, str) else e.get("object_type") or e.get("api_name")) for e in f.get("edits") or []]
        fid = g.node(f"function:{f['id']}", "function", f["name"], link=f"/functions/{f['id']}", repo_id=f.get("repo_id"),
                     updated_at=f.get("released_at"), subtitle=f"v{f.get('version')} · {f.get('output') or 'void'}")
        for tid in dict.fromkeys(ins):
            g.edge(f"object_type:{tid}", fid, "input")
        for tid in filter(None, edits):
            if f"object_type:{tid}" in g.nodes:
                g.edge(fid, f"object_type:{tid}", "edits")

    # model functions: a deployed model published as a function
    try:
        import model_deployments

        for m in model_deployments.list_functions():
            dep = model_deployments.find_function(m["api_name"]) or {}
            fid = g.node(f"function:mf-{m['api_name']}", "function", m.get("name") or m["api_name"], link=f"/functions/mf-{m['api_name']}",
                         subtitle="model function" + (" · row-wise" if m.get("row_wise") else ""))
            if dep.get("model_id"):
                mid = g.node(f"model:{dep['model_id']}", "model", dep.get("name") or dep["model_id"], link=f"/model-assets/{dep['model_id']}")
                g.edge(mid, fid, "serves")
    except Exception:  # noqa: BLE001 - model deployments not configured
        pass

    # pipelines that call a function (Pipeline Builder "Use function" / model function steps)
    for item, p in pipes:
        for fn in p.get("functions") or []:
            ref = (fn.get("fn") or {}).get("functionId") or fn.get("functionId")
            if ref and f"function:{ref}" in g.nodes and f"pipeline:{item['id']}" in g.nodes:
                g.edge(f"function:{ref}", f"pipeline:{item['id']}", "used by")

    # Workshop widgets that run a function or submit actions
    for m in workshop.list_modules():
        for w in m["widgets"]:
            c = w.get("config") or {}
            if c.get("function_id") and f"function:{c['function_id']}" in g.nodes:
                g.edge(f"function:{c['function_id']}", f"module:{m['id']}", "displays")
            for a in c.get("action_ids") or ([c["action_type_id"]] if c.get("action_type_id") else []):
                if f"action:{a}" in g.nodes:
                    g.edge(f"action:{a}", f"module:{m['id']}", "button")

    # Vertex graphs and maps: the object types they draw
    import vertex

    for vg in vertex._graphs():
        tids = {n.get("object_type_id") for n in vg.get("nodes") or []}
        tids |= {p_.get("object_type_id") for p_ in (vg.get("template") or {}).get("parameters") or []}
        tids = {t for t in tids if f"object_type:{t}" in g.nodes}
        if tids:
            vid = g.node(f"vertex:{vg['id']}", "vertex", vg["name"], link=f"/vertex?graph={vg['id']}", updated_at=vg.get("updated_at"),
                         subtitle="template" if vg.get("template") else f"{len(vg.get('nodes') or [])} objects")
            for t in tids:
                g.edge(f"object_type:{t}", vid, "displays")
    import geospatial

    for mp in geospatial.list_maps():
        tids = {la.get("object_type_id") or (la.get("config") or {}).get("object_type_id") for la in mp.get("layers") or [] if la.get("kind") in ("objects", "dropped")}
        tids = {t for t in tids if f"object_type:{t}" in g.nodes}
        if tids:
            mid = g.node(f"map:{mp['id']}", "map", mp.get("name") or mp["id"], link=f"/map/{mp['id']}", updated_at=mp.get("updated_at"),
                         subtitle=f"{mp.get('layer_count', 0)} layers")
            for t in tids:
                g.edge(f"object_type:{t}", mid, "displays")

    # time series syncs: the dataset they index → the object types whose time series properties read them
    import timeseries

    syncs: dict[str, str] = {}
    for s_ in timeseries.all_syncs("timeseries"):
        src = None
        if s_.get("dataset_id"):
            item = db.drive_get(s_["dataset_id"]) if db.enabled() else None
            src = g.dataset(s_["dataset_id"]) if item and not item.get("trashed_at") else None
        elif s_.get("pipeline_id") and f"pipeline:{s_['pipeline_id']}" in g.nodes:
            src = f"pipeline:{s_['pipeline_id']}"
        if not src:
            continue
        sid = g.node(f"ts_sync:{s_['id']}", "ts_sync", s_["name"], link=f"/time-series/{s_['id']}", updated_at=s_.get("updated_at"),
                     subtitle=f"{s_.get('points_total') or 0:,} points")
        g.edge(src, sid, "indexes")
        # a pipeline's time-series output is also a stream of the same name: the stream feeds the sync
        out_streams = getattr(g, "out_streams", {})
        if s_.get("pipeline_id") and (src, s_["name"]) in out_streams:
            g.edge(out_streams[(src, s_["name"])], sid, "indexes")
        syncs[s_["id"]] = sid
    for t in ontology._all("object-types"):
        for prop, cfg in ((t.get("time_series") or {}).get("properties") or {}).items():
            for ref in cfg.get("syncs") or []:
                sid = syncs.get(timeseries.sync_id_of(str(ref)))
                if sid and f"object_type:{t['id']}" in g.nodes:
                    g.edge(sid, f"object_type:{t['id']}", f"time series · {prop}")

    # Device and Machinery: processes over object types, their changelog datasets
    import machinery

    for r in machinery._all():
        tids = [p["object_type_id"] for p in r.get("processes") or [] if f"object_type:{p['object_type_id']}" in g.nodes]
        if not tids:
            continue
        mid = g.node(f"machinery:{r['id']}", "machinery", r["name"], link=f"/machinery?id={r['id']}", updated_at=r.get("updated_at") or r.get("created_at"),
                     subtitle=f"{len(r.get('processes') or [])} processes")
        for t in dict.fromkeys(tids):
            g.edge(f"object_type:{t}", mid, "process")
        for p in r.get("processes") or []:
            ds = (p.get("log") or {}).get("changelog_dataset_id")
            if ds:
                g.edge(g.dataset(ds), mid, "changelog")

    # OSDK applications (Developer Console): their scopes
    import agentic_apps
    import developer_console as dc

    # where an application runs, when it is listed in the Applications Portal (e.g. /demo-jkn/audit); else its Developer
    # Console page
    try:
        running = {a.get("resource_id"): agentic_apps._href(a) for a in agentic_apps._read() if a.get("kind") == "osdk" and a.get("resource_id")}
    except Exception:  # noqa: BLE001
        running = {}
    for app in dc._all():
        if not dc._alive(app):
            continue
        r = app.get("resources") or {}
        uses = [*(f"object_type:{t}" for t in r.get("object_types") or []), *(f"action:{a}" for a in r.get("action_types") or []),
                *(f"function:{f}" for f in r.get("functions") or [])]
        uses = [u for u in uses if u in g.nodes]
        if uses:
            oid = g.node(f"osdk_app:{app['id']}", "osdk_app", app["name"], link=running.get(app["id"]) or f"/developer-console?id={app['id']}",
                         console=f"/developer-console?id={app['id']}", item_id=app.get("item_id"),
                         updated_at=app.get("updated_at") or app.get("created_at"), subtitle=f"{app.get('kind', 'client')} application")
            for u in uses:
                g.edge(u, oid, "scope")


def _visible(nid: str, n: dict) -> bool:
    """Whether the caller may see a node: markings (and Project roles) on Files items, markings on code repositories,
    object types and streams."""
    import auth

    if n.get("item_id") and not auth.can_access(n["item_id"]):
        return False
    resource = ("code_repo", n["repo_id"]) if n.get("repo_id") else ("object_type", nid.split(":", 1)[1]) if n.get("kind") == "object_type"         else ("stream", nid.split(":", 1)[1]) if n.get("kind") == "stream" else ("restricted_view", nid.split(":", 1)[1]) if n.get("kind") == "restricted_view" else None
    return not resource or bool(auth.visible_resources(resource[0], [{"id": resource[1]}]))


def _hidden(g: "_Graph") -> set[str]:
    return {nid for nid, n in g.nodes.items() if not _visible(nid, n)}


def _visible_node(g: "_Graph", nid: str) -> dict:
    n = g.nodes.get(nid)
    if not n or not _visible(nid, n):
        raise HTTPException(404, "node not found")
    return n


# ------------------------------------------------------------------------------------------------
# Node color options → Permissions: what one account can do with each node ("View as")
# ------------------------------------------------------------------------------------------------


def _resource_ok(kind: str, rid: str, p: dict, op: str) -> bool:
    import auth

    if auth.missing_markings(auth.resource_effective(kind, rid), p.get("markings") or []):
        return False
    project = auth.resource_project(kind, rid)
    return not project or op in auth.operations_for(project, p)


def _policy_user(p: dict) -> dict:
    return {"id": p.get("id"), "groups": sorted(p.get("groups") or []), "organization_id": p.get("organization_id"),
            "markings": sorted(p.get("markings") or []), "attributes": p.get("attributes") or {}}


NO_OWN_PERMISSION = "no data permission for this kind of resource"


def access_of(nid: str, n: dict, p: dict, op: str, cache: Optional[dict] = None) -> tuple[str, str]:
    """(status, detail) of a node for a principal: view (blue) · no_access (red) · no_data (an empty or deleted
    dataset, or a row policy that leaves the account no rows) · unknown (kinds without a data permission)."""
    import auth

    kind = n.get("kind")
    if kind == "dataset" and n.get("missing"):
        return "no_data", "the dataset was deleted"
    if n.get("item_id"):
        if not auth.has_operation(n["item_id"], op, p):
            need = auth.missing_markings(auth.effective_markings(n["item_id"]), p.get("markings") or [])
            return "no_access", (f"missing marking {', '.join(auth._marking_names(sorted(need)))}" if need else "no role with this permission on its Project or folder")
        # reached through a role granted on a folder or a file rather than on the Project: say which
        why = ""
        if not auth._is_admin(p) and op not in auth.operations_for(auth.project_of(n["item_id"]), p):
            g = auth.grant_source(n["item_id"], op, p)
            why = f"{g['role_label']} on {g['item']}" if g else ""
        if kind == "dataset" and not n.get("size"):
            return "no_data", "the dataset has no data" + (f" ({why})" if why else "")
        return "view", why
    rid = nid.split(":", 1)[1]
    if kind == "restricted_view":
        if not _resource_ok("restricted_view", rid, p, op):
            return "no_access", "no role on the view's Project, or a marking it carries"
        if op == "discover":
            return "view", ""
        import restricted_views

        import ontology_security as osec

        rec = restricted_views._read(rid)
        try:
            # the backing rows, read once per call (several accounts are checked against the same view)
            key = f"rv:{rid}"
            if cache is None or key not in cache:
                rows_ = restricted_views._backing_table(rec).to_pylist() if rec else []
                if cache is not None:
                    cache[key] = rows_
            else:
                rows_ = cache[key]
            u = _policy_user(p)
            seen = sum(1 for r in rows_ if osec.evaluate(rec.get("policy"), u, r))
            total = len(rows_)
        except Exception:  # noqa: BLE001
            return "unknown", "the backing dataset cannot be read"
        return ("view", f"{seen} of {total} rows") if seen else ("no_access", f"the row policy leaves 0 of {total} rows")
    if kind == "object_type":
        if not _resource_ok("object_type", rid, p, "read"):
            return "no_access", "missing a marking of its backing data"
        import ontology_security as osec

        t = ontology._read(ontology._path("object-types", rid)) or {}
        key = f"ot:{rid}"
        if cache is None or key not in cache:
            objs = ontology.stored_objects(rid)
            if cache is not None:
                cache[key] = objs
        else:
            objs = cache[key]
        if (t.get("security") or {}).get("object_policy") and op != "discover":
            u = {**p, **_policy_user(p)}
            seen = sum(1 for o in objs.values() if osec.object_visible(t, o, u))
            return ("view", f"{seen} of {len(objs)} objects") if seen else ("no_access", f"the object policy leaves 0 of {len(objs)} objects")
        return ("view", f"{len(objs)} objects") if objs else ("no_data", "no objects")
    if kind == "stream" or n.get("repo_id"):
        k, r = ("code_repo", n["repo_id"]) if n.get("repo_id") else ("stream", rid)
        return ("view", "") if _resource_ok(k, r, p, op) else ("no_access", "missing a marking or a role")
    return "unknown", NO_OWN_PERMISSION


def seen_as(nid: str, n: dict, p: dict, op: str, cache: dict) -> tuple[str, str]:
    """Data Lineage → Permissions: blue or red for every node, whether the account can view it (access_of, settled).
    A dataset it may open but that holds no data is viewable; a deleted one is not. A node without a data permission
    of its own (an action, an agent, a model, a map…) shows what it reads: viewable when every input it is built from
    can be viewed (an action: the object type it edits), as a marking reaches every output. A reference is public."""
    status, detail = access_of(nid, n, p, op, cache)
    if status == "no_data":
        return ("no_access", detail) if n.get("missing") else ("view", detail)
    if status != "unknown" or detail != NO_OWN_PERMISSION:
        return status, detail
    if n.get("kind") == "reference":
        return "view", "a published reference"
    if "graph" not in cache:
        g = cache["graph"] = cached_graph(False)
        cache["parents"], cache["writes"] = {}, {}
        for e in g.edges.values():
            cache["parents"].setdefault(e["to"], []).append(e["from"])
            if e["label"] in ("edits", "writes"):
                cache["writes"].setdefault(e["from"], []).append(e["to"])
    g = cache["graph"]
    if nid not in g.nodes:
        return status, detail
    key = ("seen", p.get("id"), op, nid)
    if key in cache:
        return cache[key]
    cache[key] = ("view", "")  # a cycle back to this node adds nothing
    deps = [d for d in cache["parents"].get(nid, []) if d in g.nodes and g.nodes[d]["kind"] != "reference"]
    verb = "reads"
    if not deps:
        deps, verb = [d for d in cache["writes"].get(nid, []) if d in g.nodes], "edits"
    closed, unknown = [], []
    for d in deps:
        s, _ = seen_as(d, g.nodes[d], p, op, cache)
        (closed if s == "no_access" else unknown if s == "unknown" else []).append(g.nodes[d]["name"])
    if closed:
        out = ("no_access", f"cannot view {closed[0]}" + (f" and {len(closed) - 1} more of what it {verb}" if len(closed) > 1 else f", what it {verb}"))
    elif unknown:
        out = ("unknown", f"the access to {unknown[0]} is unknown")
    elif deps:
        out = ("view", f"can view all {len(deps)} of what it {verb}" if len(deps) > 1 else f"can view {g.nodes[deps[0]]['name']}, what it {verb}")
    else:
        out = ("view", "holds no data of its own")
    cache[key] = out
    return out


class PermissionsIn(BaseModel):
    user_id: str
    # read: "Data access in datasets" · discover: "Discover (see that it exists)"
    type: str = Field("read", pattern="^(read|discover)$")
    # the nodes on the canvas: {id, kind, item_id?, repo_id?, size?, missing?} as the graph gave them (every access
    # is checked on the real resources, the caller's own included, so nothing is learnt about what they cannot see)
    nodes: list[dict] = Field(default_factory=list, max_length=3000)


NODE_KEYS = ("kind", "item_id", "repo_id", "size", "missing")


@router.post("/permissions")
def permissions(req: PermissionsIn) -> dict:
    """Color by permissions, viewed as an account: for each node, whether that account can view its data. You only
    see an account's access where you have that access yourself (administrators see all)."""
    import auth

    me = auth.require_user()
    target = auth.principal_of(req.user_id)
    if target is None:
        raise HTTPException(404, "user not found")
    out: dict[str, dict] = {}
    cache: dict = {}
    for raw in req.nodes:
        nid = str(raw.get("id") or "")
        if raw.get("kind") not in KINDS or ":" not in nid:
            continue
        n = {k: raw.get(k) for k in NODE_KEYS}
        if not _visible(nid, n):
            out[nid] = {"status": "unknown", "detail": "you do not have this access yourself"}
            continue
        try:
            if not auth._is_admin(me):
                mine, _ = seen_as(nid, n, me, req.type, cache)
                if mine != "view":
                    out[nid] = {"status": "unknown", "detail": "you do not have this access yourself"}
                    continue
            status, detail = seen_as(nid, n, target, req.type, cache)
        except HTTPException as e:
            # one node that cannot be checked (an id the canvas made up, a resource deleted meanwhile) leaves the others
            status, detail = "unknown", str(e.detail)
        out[nid] = {"status": status, "detail": detail}
    counts = {s: sum(1 for v in out.values() if v["status"] == s) for s in ("view", "no_access", "no_data", "unknown")}
    u = auth.user_label(req.user_id) or {}
    return {"user": {"id": req.user_id, "name": u.get("display_name") or u.get("username")}, "type": req.type, "nodes": out, "counts": counts}


@router.get("/graph")
def graph(tests: bool = False) -> dict:
    """The lineage for the canvas — without test and bug-hunting items unless tests=true (`hidden_tests` counts them)."""
    g = cached_graph(tests)
    # markings: nodes the caller cannot access (datasets, pipelines, transforms of marked repositories, object types,
    # streams) are left out, with their edges
    hidden = _hidden(g)
    nodes = [n for nid, n in g.nodes.items() if nid not in hidden]
    edges = [e for e in g.edges.values() if e["from"] not in hidden and e["to"] not in hidden]
    relations = [r for r in g.relations if r["from"] not in hidden and r["to"] not in hidden]
    return {"nodes": nodes, "edges": edges, "relations": relations, "kinds": KINDS, "hidden": len(hidden), "hidden_tests": g.hidden_tests}


# -- Nexus relation participation (ERD: total = every object of a side takes part in the relation) ----------------

_participation: dict[tuple[str, str], tuple[float, list, dict]] = {}
# kept while the stamp holds (both types' objects and definitions, the join table): a safety net, not a refresh rate —
# a 2-minute life counted every object of both types again each time the relation was looked at (~2 s each)
PARTICIPATION_TTL = 1800.0


def _participation_stamp(lt: dict) -> list:
    import ontology

    try:
        links = (ontology.DIR / "links" / f"{lt['id']}.json").stat().st_mtime_ns
    except OSError:
        links = None
    ends = [lt[s]["object_type_id"] for s in ("source", "target")]
    return [lt.get("updated_at"), links, *([ontology._object_type(t).get("updated_at"), ontology.objects_stat(t)] for t in ends)]


def participation(lt: dict) -> dict:
    """Per side of a link type: how many of its objects have at least one link, and whether participation is total —
    every object linked (observed in the data) or the foreign key is required (the schema demands it). Counted over the
    objects the caller may see (row policies), so two accounts can get different answers; cached per account."""
    import ontology
    import ontology_live
    import ontology_model as om

    if lt.get("kind") == "foreign_key" and (ontology_live.is_live(lt["source"]["object_type_id"]) or ontology_live.is_live(lt["target"]["object_type_id"])):
        # a live side (millions of objects, no row policies): counted with queries
        return ontology_live.participation(lt)
    # per account as its row policies see it (groups, markings and attributes in the key: a change of access is a miss)
    key = (lt["id"], json.dumps(_policy_user(auth.current() or {}), sort_keys=True, default=str))
    stamp = _participation_stamp(lt)
    hit = _participation.get(key)
    if hit and hit[1] == stamp and time.monotonic() - hit[0] < PARTICIPATION_TTL:
        return hit[2]

    def visible(type_id: str) -> dict:
        rec = ontology._object_type(type_id)
        return {pk: o for pk, o in ontology.stored_objects(type_id).items() if ontology._can_see(rec, o)}

    src = visible(lt["source"]["object_type_id"])
    tgt = visible(lt["target"]["object_type_id"])
    pairs = [(s, t) for s, t in om._pairs(lt) if s in src and t in tgt]
    s_linked, t_linked = {s for s, _ in pairs}, {t for _, t in pairs}
    required = False
    if lt.get("kind") == "foreign_key" and lt.get("foreign_key"):
        props = ontology._object_type(lt["source"]["object_type_id"]).get("properties") or []
        required = any(p.get("api_name") == lt["foreign_key"] and p.get("required") for p in props)

    def side(linked: set, objs: dict, schema: bool) -> dict:
        n = len(objs)
        k = len(linked)
        return {"linked": k, "objects": n, "total": schema or (n > 0 and k == n), "required": schema,
                "pct": round(100 * k / n, 1) if n else None}

    out = {"source": side(s_linked, src, required), "target": side(t_linked, tgt, False), "links": len(pairs)}
    _participation[key] = (time.monotonic(), stamp, out)
    return out


class ParticipationIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=500)


@router.post("/relations/participation")
def relations_participation(req: ParticipationIn) -> dict:
    """Participation of the relations on the canvas; a relation is answered only when the caller may see both object
    types (as the graph leaves out the hidden ones)."""
    import ontology

    auth.require_user()
    by_id = {lt["id"]: lt for lt in ontology._all("link-types")}
    out: dict[str, dict] = {}
    for rid in req.ids:
        lt = by_id.get(rid)
        if not lt:
            continue
        ends = [{"id": lt[s]["object_type_id"]} for s in ("source", "target")]
        if len(auth.visible_resources("object_type", ends)) < len({e["id"] for e in ends}):
            continue
        try:
            out[rid] = participation(lt)
        except Exception as e:  # noqa: BLE001 - one broken link type leaves the others answered
            log.warning("participation of %s failed: %s", rid, e)
    return out


def _dataset_detail(n: dict) -> dict:
    out: dict[str, Any] = {}
    item = db.drive_get(n["item_id"]) if n.get("item_id") else None
    if not item or item.get("trashed_at"):
        return {"missing": True}
    out["created_at"] = _ts(item.get("created_at"))
    out["content_type"] = item.get("content_type")
    if item.get("content_type") == pipeline_datasets.PARQUET or item["name"].endswith(".parquet"):
        try:
            meta = pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).metadata
            schema = meta.schema.to_arrow_schema()
            out["rows"] = meta.num_rows
            out["columns"] = [{"name": f.name, "type": pipeline_datasets._column_type(f.type)} for f in schema]
        except Exception as e:  # noqa: BLE001
            out["read_error"] = str(e)[:200]
    out["shares"] = [{"expires_at": _ts(s.get("expires_at")), "created_at": _ts(s.get("created_at"))} for s in db.share_list(item["id"])]
    return out


@router.get("/node")
def node(id: str) -> dict:
    """One node with its inputs, outputs, history, health and access."""
    g = _graph_with(id)
    n = _visible_node(g, id)
    hidden = _hidden(g)
    detail: dict[str, Any] = {**n}
    detail["inputs"] = [g.nodes[e["from"]] | {"via": e["label"]} for e in g.edges.values() if e["to"] == id and e["from"] in g.nodes and e["from"] not in hidden]
    detail["outputs"] = [g.nodes[e["to"]] | {"via": e["label"]} for e in g.edges.values() if e["from"] == id and e["to"] in g.nodes and e["to"] not in hidden]
    if detail.get("producers"):
        detail["producers"] = [p for p in detail["producers"] if p.get("id") not in hidden]
    events: list[dict] = []
    kind = n["kind"]
    try:
        if kind == "dataset":
            detail.update(_dataset_detail(n))
            detail["transactions_list"] = dataset_versions.history(n["item_id"], aborted=True) if n.get("item_id") else []
            for p in n.get("producers") or []:
                events.append({"at": p.get("at"), "kind": "build", "status": "succeeded",
                               "text": f"Written by {KINDS[p['kind']].lower()} {p['name']}" + (f" (commit {p['commit'][:7]})" if p.get("commit") else "")
                               + (f", {p['rows']:,} rows" if isinstance(p.get("rows"), int) else "")})
        elif kind == "pipeline":
            for b in pipeline_runtime.list_builds(n["item_id"], 50):
                events.append({"at": b.get("created_at"), "kind": "build", "status": b.get("status"),
                               "text": f"Build ({b.get('trigger') or 'manual'})" + (f": {b['error']}" if b.get("error") else "")})
        elif kind == "transform":
            repo_id, rest = id.removeprefix("transform:").split("::", 1)
            transform, branch = rest.rsplit("::", 1)
            for b in code_repos.list_builds(repo_id):
                if b["transform"] == transform and (b.get("branch") or branch) == branch:
                    events.append({"at": b["at"], "kind": "build", "status": b["status"],
                                   "text": f"[{b.get('trigger', 'manual')}] " + (f"Built on commit {b['commit'][:7]}" if b.get("commit") else "Built from uncommitted code")
                                   + (f", {b['output']['rows']:,} rows" if b.get("output") and isinstance(b["output"].get("rows"), int) else "")
                                   + (f": {b['error'][:200]}" if b.get("error") else "")})
        elif kind == "datasource":
            s = datasources.get_source(id.removeprefix("datasource:"))
            for r in s.get("runs") or []:
                events.append({"at": r.get("started_at"), "kind": "sync", "status": r.get("status"),
                               "text": f"Sync: {r.get('rows', 0)} rows" + (f": {r['error']}" if r.get("error") else "")})
        elif kind == "logic":
            for r in ontology.logic_runs(id.removeprefix("logic:")):
                events.append({"at": r["at"], "kind": "run", "status": r["status"],
                               "text": ("Automate · " + r["trigger"]["automation"] if r.get("trigger") else "Applied run" if r.get("apply") else "Preview run")
                               + (f": {r['error']}" if r.get("error") else "")})
        elif kind == "automation":
            for r in ontology.automation_runs(id.removeprefix("automation:")):
                events.append({"at": r["at"], "kind": "run", "status": r["status"],
                               "text": f"{r['trigger']}: {r.get('edits', 0)} edits" + (f": {r['error']}" if r.get("error") else "")})
        elif kind == "object_type":
            t = ontology.get_object_type(id.removeprefix("object_type:"))
            detail["columns"] = [{"name": p["api_name"], "type": p["type"]} for p in t["properties"]]
            detail["rows"] = t["object_count"]
            detail["created_at"] = t.get("created_at")
    except HTTPException:
        pass
    events.sort(key=lambda e: e.get("at") or "", reverse=True)
    detail["events"] = events[:100]
    return detail


@router.get("/preview")
def preview(id: str, limit: int = 50) -> dict:
    """First rows of a dataset or object type node."""
    if id.startswith("dataset:"):
        return pipeline_datasets.read_table(id.removeprefix("dataset:"), max(1, min(limit, 500)))
    if id.startswith("object_type:"):
        import auth

        auth.check_resource("object_type", id.removeprefix("object_type:"))
        r = workshop.query(workshop.Query(source=workshop.Source(kind="object_type", id=id.removeprefix("object_type:")), limit=limit))
        return {"name": id, "columns": r["columns"], "rows": [{k: v for k, v in row.items() if k != "__pk"} for row in r["rows"]], "total_rows": r["total"]}
    raise HTTPException(400, "only datasets and object types have a preview")


# ------------------------------------------------------------------------------------------------
# helpers for the graph
# ------------------------------------------------------------------------------------------------

_schema_cache: dict[str, tuple[str, Optional[dict]]] = {}
MAX_SCHEMA_BYTES = 200 * 1024 * 1024


_schema_disk = {"loaded": False, "dirty": 0, "saved": 0.0}


def _schema_file():
    return dataset_versions.DIR.parent / "lineage-schemas.json"


def _load_schemas() -> None:
    """The schema cache survives restarts: reading every dataset's file again took minutes on a cold start."""
    if _schema_disk["loaded"]:
        return
    _schema_disk["loaded"] = True
    try:
        for k, v in json.loads(_schema_file().read_text("utf-8")).items():
            _schema_cache.setdefault(k, (v[0], v[1]))
    except (OSError, ValueError, TypeError, IndexError):
        pass


def _save_schemas(force: bool = False) -> None:
    if not _schema_disk["dirty"] or (not force and time.time() - _schema_disk["saved"] < 10):
        return
    try:
        tmp = _schema_file().with_suffix(".tmp")
        tmp.write_text(json.dumps({k: [v[0], v[1]] for k, v in _schema_cache.items()}), "utf-8")
        tmp.replace(_schema_file())
        _schema_disk.update(dirty=0, saved=time.time())
    except OSError:
        log.exception("lineage: schema cache not saved")


def _schema(item_id: str, stamp: Optional[str], size: Optional[int]) -> Optional[dict]:
    """Row count and columns of a Parquet dataset, cached until the file changes (also on disk)."""
    _load_schemas()
    hit = _schema_cache.get(item_id)
    if hit and hit[0] == (stamp or ""):
        return hit[1]
    meta: Optional[dict] = None
    if (size or 0) <= MAX_SCHEMA_BYTES:
        try:
            item = db.drive_get(item_id)
            if item and (item.get("content_type") == pipeline_datasets.PARQUET or item["name"].endswith(".parquet")):
                md = pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).metadata
                meta = {"rows": md.num_rows, "columns": [f.name for f in md.schema.to_arrow_schema()]}
        except Exception:  # noqa: BLE001
            meta = None
    _schema_cache[item_id] = (stamp or "", meta)
    _schema_disk["dirty"] += 1
    _save_schemas()
    return meta


def _last_pipeline_build(pipeline_id: str) -> Optional[dict]:
    try:
        b = pipeline_runtime._builds(pipeline_id, 1)
    except Exception:  # noqa: BLE001
        return None
    if not b:
        return None
    ok = b[0]["status"] in ("succeeded", "completed", "success")
    return {"status": "succeeded" if ok else b[0]["status"], "at": b[0].get("finished_at") or b[0].get("created_at"), "error": b[0].get("error")}


# ------------------------------------------------------------------------------------------------
# data health: rules per dataset
# ------------------------------------------------------------------------------------------------

HEALTH_KINDS = ("freshness", "time_since_updated", "data_freshness", "row_count", "columns", "schema", "build_status", "up_to_date")


def _health_path():
    return dataset_versions.DIR.parent / "health.json"


def _health_rules() -> dict[str, list[dict]]:
    try:
        return json.loads(_health_path().read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def evaluate_health(n: dict, rules: list[dict]) -> dict:
    """{status: passing | failing, results: [{kind, ok, message}]} for a dataset node (checks: health_checks.py)."""
    import health_checks

    results = [health_checks.check_node(n, r) for r in rules if r.get("enabled", True)]
    return {"status": "failing" if any(not x["ok"] for x in results) else "passing", "results": results}


class HealthRules(BaseModel):
    item_id: str
    rules: list[dict]


@router.get("/health")
def health_rules(item_id: str) -> list[dict]:
    auth.check_item_id(item_id, "viewer")  # seen with the dataset (markings, a role on its Project)
    return _health_rules().get(item_id, [])


@router.put("/health")
def save_health_rules(req: HealthRules) -> list[dict]:
    auth.check_item_id(req.item_id, "editor")
    for r in req.rules:
        if r.get("kind") not in HEALTH_KINDS:
            raise HTTPException(400, f"unknown rule {r.get('kind')}")
        r.setdefault("id", uuid.uuid4().hex[:8])
        r.setdefault("enabled", True)
    data = _health_rules()
    data[req.item_id] = req.rules
    _health_path().parent.mkdir(parents=True, exist_ok=True)
    _health_path().write_text(json.dumps(data), "utf-8")
    return req.rules


# ------------------------------------------------------------------------------------------------
# code, transactions and rollback
# ------------------------------------------------------------------------------------------------


@router.get("/code")
def code(id: str) -> dict:
    """The logic behind a node: a transform's source file, or a pipeline's steps."""
    g = _graph_with(id)
    n = _visible_node(g, id)
    commit = None
    if n["kind"] == "dataset":
        if not n.get("producers"):
            return {"kind": "none", "message": "This dataset was uploaded or ingested: no code produced it."}
        last = max(n["producers"], key=_written)
        n = _visible_node(g, last["id"])
        commit = last.get("commit")
    if n["kind"] == "model":
        t = n.get("training")
        if not t:
            return {"kind": "none", "message": "This model was registered or imported: no training code on the platform produced it."}
        if not t.get("repo_id"):
            return {"kind": "none", "message": f"Trained in {t.get('app') or 'another app'} ({t.get('repo') or ''}): open it from the model's panel."}
        src = code_repos.transform_source(t["repo_id"], f"{t['path']}::{t['function']}", t.get("commit"))
        return {"kind": "python", **src, "link": t["link"]}
    if n["kind"] == "transform":
        src = code_repos.transform_source(n["repo_id"], n["transform"], commit)
        return {"kind": "python", **src, "link": f"{n['link']}?file={quote(src['path'])}" if src.get("path") else n["link"]}
    if n["kind"] == "preparation":
        import preparation

        _, prep = preparation._load(n["item_id"])
        steps = [{"name": c["type"].replace("_", " "), "kind": c["type"], "description": json.dumps(c.get("params") or {})} for c in prep.get("changes") or []]
        return {"kind": "pipeline", "name": n["name"], "steps": steps, "outputs": [], "link": n["link"]}
    if n["kind"] == "sql":
        import sql_writes

        defs = sql_writes.definitions(n["item_id"])
        steps = [{"name": f"{d['operation']}{' (active)' if d['active'] else ''}{' · ad hoc' if d.get('adhoc') else ''}", "kind": "sql", "description": d["sql"]}
                 for d in reversed(defs)]
        return {"kind": "pipeline", "name": n["name"], "steps": steps, "outputs": [], "link": n["link"]}
    if n["kind"] == "pipeline":
        p = pipeline_datasets.read_pipeline(n["item_id"])["content"] or {}
        steps = [{"name": x.get("name") or x.get("kind"), "kind": x.get("kind"), "description": x.get("description")} for x in p.get("nodes") or []]
        return {"kind": "pipeline", "name": n["name"], "steps": steps, "outputs": [o.get("name") for o in p.get("outputs") or []], "link": n["link"]}
    return {"kind": "none", "message": f"{n['kind_label']} nodes have no code."}


@router.get("/transactions")
def transactions(id: str) -> list[dict]:
    if not id.startswith("dataset:"):
        raise HTTPException(400, "only datasets have transactions")
    drive._item(id.removeprefix("dataset:"))  # markings check
    return dataset_versions.history(id.removeprefix("dataset:"), aborted=True)


@router.get("/diff")
def diff(id: str, a: str, b: str, limit: int = 50) -> dict:
    """Compare two transactions of a dataset: schema changes, row counts, and rows only in one of them (a sample)."""
    item_id = id.removeprefix("dataset:")
    drive._item(item_id)  # markings check
    tables = []
    for tx in (a, b):
        raw = dataset_versions.data(item_id, tx)
        if raw is None:
            raise HTTPException(404, f"transaction {tx} has no kept data (older copies are removed by retention)")
        tables.append(pq.read_table(io.BytesIO(raw)))
    ta, tb = tables
    sa = {f.name: str(f.type) for f in ta.schema}
    sb = {f.name: str(f.type) for f in tb.schema}
    schema = ([{"column": c, "change": "added", "type": sb[c]} for c in sb if c not in sa]
              + [{"column": c, "change": "removed", "type": sa[c]} for c in sa if c not in sb]
              + [{"column": c, "change": "type", "from": sa[c], "to": sb[c]} for c in sa if c in sb and sa[c] != sb[c]])
    common = [c for c in sa if c in sb]
    key = lambda r: json.dumps([r.get(c) for c in common], default=str)  # noqa: E731
    ra, rb = ta.to_pylist(), tb.to_pylist()
    count_a: dict[str, int] = {}
    for r in ra:
        count_a[key(r)] = count_a.get(key(r), 0) + 1
    added, seen = [], dict(count_a)
    for r in rb:
        k = key(r)
        if seen.get(k):
            seen[k] -= 1
        else:
            added.append(r)
    removed_keys = {k: n for k, n in seen.items() if n}
    removed = [r for r in ra if removed_keys.get(key(r), 0) > 0 and not removed_keys.__setitem__(key(r), removed_keys[key(r)] - 1)]
    clean = lambda rows: [{k: (v if isinstance(v, (int, float, str, bool)) or v is None else str(v)) for k, v in r.items()} for r in rows[:limit]]  # noqa: E731
    return {"a": a, "b": b, "rows_a": len(ra), "rows_b": len(rb), "schema": schema, "compared_columns": common,
            "added": len(added), "removed": sum(1 for _ in removed), "added_rows": clean(added), "removed_rows": clean(removed),
            "columns_a": list(sa), "columns_b": list(sb)}


class Rollback(BaseModel):
    id: str
    transaction: str


@router.post("/rollback")
def rollback(req: Rollback) -> dict:
    """Write an earlier transaction's data back as a new "rollback" transaction. The logic is unchanged:
    the next build writes from the current code again."""
    item_id = req.id.removeprefix("dataset:")
    drive._item(item_id, need="editor")  # rolling back writes the dataset: markings and Editor on its Project
    data = dataset_versions.data(item_id, req.transaction)
    if data is None:
        raise HTTPException(404, "that transaction's data is no longer kept")
    item = db.drive_get(item_id)
    if not item or item.get("trashed_at"):
        raise HTTPException(404, "dataset not found")
    old = next((t for t in dataset_versions.history(item_id) if t["id"] == req.transaction), {})
    pipeline_datasets._replace_content(item, data)
    tx = dataset_versions.record(item_id, data, "rollback", {"kind": "rollback", "to": req.transaction, "to_at": old.get("at")})
    dataset_versions.mark_rolled_back(item_id, req.transaction, tx)
    return {"transaction": tx, "history": dataset_versions.history(item_id)}


# ------------------------------------------------------------------------------------------------
# building from lineage
# ------------------------------------------------------------------------------------------------

_jobs: dict[str, dict] = {}
_job_owner: dict[str, Optional[str]] = {}


class BuildPlanIn(BaseModel):
    ids: list[str]
    # selected: only these; ancestors: these and their out-of-date ancestors; between: everything between them
    strategy: Literal["selected", "ancestors", "between"] = "selected"
    # ancestors: rebuild up-to-date ones too
    force: bool = False


def _producer(g: _Graph, nid: str) -> Optional[dict]:
    n = g.nodes.get(nid)
    if not n:
        return None
    if n["kind"] in ("transform", "pipeline"):
        return n if n.get("buildable") else None
    if n["kind"] == "dataset" and n.get("producers"):
        last = max(n["producers"], key=_written)
        p = g.nodes.get(last["id"])
        return p if p and p.get("buildable") else None
    return None


def _walk(g: _Graph, nid: str, up: bool) -> set[str]:
    seen: set[str] = set()
    stack = [nid]
    while stack:
        x = stack.pop()
        for e in g.edges.values():
            nxt = e["from"] if up and e["to"] == x else e["to"] if not up and e["from"] == x else None
            if nxt and nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return seen


def plan_build(g: _Graph, req: BuildPlanIn) -> list[dict]:
    # markings: only what the caller can see is planned (a hidden node or producer is left out, never named)
    hidden = _hidden(g)
    targets = set(i for i in req.ids if i in g.nodes and i not in hidden)
    if req.strategy == "ancestors":
        for i in list(targets):
            targets |= {x for x in _walk(g, i, True) if req.force or g.nodes[x].get("stale")}
    elif req.strategy == "between" and targets:
        ups = set().union(*(_walk(g, i, True) for i in targets))
        downs = set().union(*(_walk(g, i, False) for i in targets))
        targets |= ups & downs
    targets -= hidden
    # one step per producer (a pipeline writing several of the datasets runs once), upstream first
    steps: dict[str, dict] = {}
    for t in targets:
        p = _producer(g, t)
        if not p or p["id"] in hidden:
            continue
        step = steps.setdefault(p["id"], {"producer": p["id"], "kind": p["kind"], "name": p["name"], "datasets": [], "outputs": []})
        if g.nodes[t]["kind"] == "dataset":
            step["datasets"].append(g.nodes[t]["name"])
            for pr in g.nodes[t].get("producers") or []:
                if pr["id"] == p["id"] and pr.get("output_id") and pr["output_id"] not in step["outputs"]:
                    step["outputs"].append(pr["output_id"])
            if g.nodes[t].get("stale"):
                step["reason"] = "out of date"
    depth = {nid: len(_walk(g, nid, True)) for nid in steps}
    return sorted(steps.values(), key=lambda s: depth[s["producer"]])


@router.post("/builds/plan")
def build_plan(req: BuildPlanIn) -> dict:
    g = build_graph()
    steps = plan_build(g, req)
    hidden = _hidden(g)
    skipped = [g.nodes[i]["name"] for i in req.ids if i in g.nodes and i not in hidden and not _producer(g, i)]
    return {"steps": steps, "skipped": skipped}


def _check_can_build(g: _Graph, steps: list[dict]) -> None:
    """The job runs in the background as the platform: the caller must be allowed to build every step themselves —
    the Editor role on a pipeline, SQL dataset or preparation (and, for a pipeline, read its inputs and write its
    outputs), Editor on a code repository (403 otherwise)."""
    import auth

    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return
    for step in steps:
        n = g.nodes[step["producer"]]
        try:
            if n["kind"] == "transform":
                auth.check_resource("code_repo", n["repo_id"], "editor")
                # building a transform runs its code on this machine (Control Panel → Security → Code execution)
                if not auth.can_run_code(p):
                    raise HTTPException(403, "running code on the BluesandAI host is limited (Control Panel → Security → Code execution)")
            else:
                auth.check_item_id(n.get("item_id"), "editor")
                if n["kind"] == "pipeline":
                    pipeline_runtime.check_starter(n["item_id"], "main", step.get("outputs") or [])
        except HTTPException as e:
            raise HTTPException(403, f"You cannot build {n['name']}: {e.detail}") from None


def _run_job(job: dict, g: Optional[_Graph] = None) -> None:
    # the graph the request planned on (as the caller sees it); rebuilding it here, as the platform, reads everything
    g = g if g is not None else build_graph()
    for step in job["steps"]:
        step.update(status="running", started_at=ontology._now())
        try:
            p = g.nodes[step["producer"]]
            if p["kind"] == "transform":
                rec = code_repos._repo(p["repo_id"])
                head = rec["branches"][rec["default_branch"]]["head"]
                b = code_repos.build_transform(rec, code_repos._commit_files(rec["id"], head), rec["default_branch"], p["transform"], "lineage", head)
                step.update(status=b["status"], error=b.get("error"))
            elif p["kind"] == "sql":
                import sql_writes

                sql_writes.rebuild(p["item_id"])
                step.update(status="succeeded", error=None)
            elif p["kind"] == "preparation":
                # a preparation's updating outputs are rebuilt from its changelog (one-off outputs are left alone)
                import preparation

                _, prep = preparation._load(p["item_id"], "editor")
                for o in prep.get("outputs") or []:
                    if o.get("mode") == "updating":
                        preparation.update_output(p["item_id"], o["item_id"])
                step.update(status="succeeded", error=None)
            else:
                # the build runs as the user who started the job (this thread has no request): their markings and
                # Project roles are checked at every read and write of the build
                queued = pipeline_runtime.queue_build(pipeline_runtime.NewBuild(pipeline_id=p["item_id"], outputs=step.get("outputs") or [],
                                                                                trigger="lineage", run_as=_job_owner.get(job["id"])))
                step["build_id"] = queued["id"]
                deadline = time.monotonic() + 1800
                cur = queued
                while time.monotonic() < deadline:
                    cur = pipeline_runtime._build(queued["id"])
                    if cur["status"] not in ("queued", "running"):
                        break
                    time.sleep(2)
                ok = cur["status"] in ("succeeded", "completed", "success")
                step.update(status="succeeded" if ok else cur["status"], error=cur.get("error"))
        except HTTPException as e:
            step.update(status="failed", error=str(e.detail))
        except Exception as e:  # noqa: BLE001
            step.update(status="failed", error=str(e)[:500])
        step["finished_at"] = ontology._now()
        if step["status"] != "succeeded":
            for rest in job["steps"]:
                if rest.get("status") == "pending":
                    rest["status"] = "skipped"
            break
    job.update(status="succeeded" if all(s["status"] == "succeeded" for s in job["steps"]) else "failed", finished_at=ontology._now())


@router.post("/builds/run")
def build_run(req: BuildPlanIn) -> dict:
    g = build_graph()
    steps = plan_build(g, req)
    if not steps:
        raise HTTPException(400, "nothing to build: the selection has no pipelines or code transforms behind it")
    _check_can_build(g, steps)
    job = {"id": uuid.uuid4().hex[:10], "status": "running", "created_at": ontology._now(), "strategy": req.strategy,
           "steps": [{**s, "status": "pending"} for s in steps]}
    import auth

    # who started it: only they (and administrators) follow the job
    _job_owner[job["id"]] = auth.actor_id()
    _jobs[job["id"]] = job
    threading.Thread(target=_run_job, args=(job, g), daemon=True, name=f"lineage-build-{job['id']}").start()
    return job


@router.get("/builds/jobs/{job_id}")
def build_job(job_id: str) -> dict:
    import auth

    job = _jobs.get(job_id)
    p = auth.current()
    mine = not auth.enabled() or p is None or p.get("service") or p.get("role") == "admin" or _job_owner.get(job_id) == auth.actor_id()
    if not job or not mine:
        raise HTTPException(404, "build job not found (jobs are kept until the API restarts)")
    return job


# ------------------------------------------------------------------------------------------------
# build timeline
# ------------------------------------------------------------------------------------------------


def _parse(at: Optional[str]) -> Optional[datetime]:
    try:
        d = datetime.fromisoformat(str(at).replace("Z", "+00:00")) if at else None
    except ValueError:
        return None
    return d.replace(tzinfo=timezone.utc) if d and d.tzinfo is None else d


@router.get("/timeline")
def timeline(hours: int = 24) -> list[dict]:
    """Builds and runs in the last `hours`: [{label, kind, node, start, end, status, trigger}]."""
    since = datetime.now(timezone.utc) - timedelta(hours=max(1, min(hours, 240)))
    out: list[dict] = []
    for b in code_repos.all_builds():
        st = _parse(b["at"])
        if st and st >= since:
            out.append({"label": f"{b['transform'].split('::')[-1]} ({b['repo_name']})", "kind": "transform", "status": b["status"],
                        "node": f"transform:{b['repo_id']}::{b['transform']}::{b.get('branch') or b.get('default_branch', 'master')}",
                        "start": st.isoformat(), "end": (st + timedelta(milliseconds=b.get("ms") or 0)).isoformat(), "trigger": b.get("trigger")})
    try:
        readable: dict[str, bool] = {}
        for b in pipeline_runtime._builds(None, 500):
            # builds are seen with their pipeline (markings, a role on its Project), as in the Builds app
            if b["pipeline_id"] not in readable:
                readable[b["pipeline_id"]] = auth.can_access(b["pipeline_id"])
            if not readable[b["pipeline_id"]]:
                continue
            st = _parse(b.get("started_at") or b.get("created_at"))
            if st and st >= since:
                end = _parse(b.get("finished_at"))
                out.append({"label": b.get("pipeline_name") or b["pipeline_id"], "kind": "pipeline", "status": b["status"],
                            "node": f"pipeline:{b['pipeline_id']}", "start": st.isoformat(), "end": end.isoformat() if end else None,
                            "trigger": b.get("trigger")})
    except Exception:  # noqa: BLE001
        pass
    for a in ontology.list_automations():
        for r in ontology.automation_runs(a["id"]):
            st = _parse(r["at"])
            if st and st >= since:
                out.append({"label": a["name"], "kind": "automation", "status": r["status"], "node": f"automation:{a['id']}",
                            "start": st.isoformat(), "end": (st + timedelta(milliseconds=r.get("ms") or 0)).isoformat(), "trigger": r.get("trigger")})
    return sorted(out, key=lambda x: x["start"])


# ------------------------------------------------------------------------------------------------
# saved graphs
# ------------------------------------------------------------------------------------------------


class SavedGraph(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    nodes: list[str]
    colors: dict[str, str] = {}
    color_by: str = "type"
    # Permissions colouring: {view_as: user id (one account; none = gray), type: read|discover, accounts: [user ids] listed}
    permissions: dict[str, Any] = {}
    # nodes placed by hand (dragged): {node id: {x, y}}; the others are laid out automatically
    positions: dict[str, dict[str, float]] = {}


def _references_file():
    return dataset_versions.DIR.parent / "references.json"


def references() -> list[dict]:
    """Registered references: {id, short, title, authors, venue, year, doi, url, license, item_id (the PDF in Files, which
    also decides who sees the node), note, informs: [{node, relation}]}."""
    return ontology._read(_references_file()) or []


def save_reference(ref: dict) -> dict:
    """Add or replace a reference (by id) — for solution builds that cite the papers their methods follow."""
    refs = [r for r in references() if r.get("id") != ref["id"]]
    rec = {**ref, "updated_at": datetime.now(timezone.utc).isoformat()}
    ontology._write(_references_file(), [*refs, rec])
    return rec


def _graphs_dir():
    d = dataset_versions.DIR.parent / "graphs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _graph_for_caller(rec: dict) -> dict:
    """A saved graph as the caller may see it: nodes on Files items they cannot access (markings, Project roles) are
    left out, with their colours and positions — a saved graph never names what the caller cannot see."""
    if not auth.enabled():
        return rec
    hidden: set[str] = set()
    for nid in rec.get("nodes") or []:
        ref = str(nid).split(":", 1)[1] if ":" in str(nid) else ""
        if ref and ":" not in ref and db.drive_get(ref) and not auth.can_access(ref):
            hidden.add(nid)
    if not hidden:
        return rec
    return {**rec, "nodes": [n for n in rec.get("nodes") or [] if n not in hidden],
            "colors": {k: v for k, v in (rec.get("colors") or {}).items() if k not in hidden},
            "positions": {k: v for k, v in (rec.get("positions") or {}).items() if k not in hidden}}


def _check_graph_owner(old: dict) -> None:
    """Changing or deleting a saved graph: the user who saved it first (and administrators); graphs saved before
    owners were recorded stay open to everyone."""
    p = auth.current()
    if not old or not old.get("owner") or not auth.enabled() or p is None or p.get("service") or p.get("role") == "admin":
        return
    if old["owner"] != auth.actor_id():
        raise HTTPException(403, "Only the user who saved this graph (or an administrator) can change or delete it")


@router.get("/graphs")
def list_graphs() -> list[dict]:
    import test_space

    out = [ontology._read(p) for p in _graphs_dir().glob("*.json")]
    rows = [{**g, "test": test_space.is_test_name(g.get("name"))} for g in (_graph_for_caller(x) for x in out if x)]
    return sorted(rows, key=lambda x: x["updated_at"], reverse=True)


@router.post("/graphs")
def save_graph(req: SavedGraph, id: Optional[str] = None) -> dict:
    gid = id if id and id.isalnum() else uuid.uuid4().hex[:10]
    path = _graphs_dir() / f"{gid}.json"
    old = ontology._read(path) or {}
    _check_graph_owner(old)
    rec = {"id": gid, **req.model_dump(), "created_at": old.get("created_at") or ontology._now(), "updated_at": ontology._now()}
    if old:
        # nodes the caller was not shown stay in the graph (with their colours and positions)
        kept = set(_graph_for_caller(old).get("nodes") or [])
        for nid in [n for n in old.get("nodes") or [] if n not in kept]:
            if nid not in rec["nodes"]:
                rec["nodes"].append(nid)
            for key in ("colors", "positions"):
                if nid in (old.get(key) or {}):
                    rec[key][nid] = old[key][nid]
    owner = old.get("owner") if old else auth.actor_id()
    if owner:
        rec["owner"] = owner
    ontology._write(path, rec)
    return _graph_for_caller(rec)


@router.get("/graphs/{gid}")
def get_graph(gid: str) -> dict:
    rec = ontology._read(_graphs_dir() / f"{gid}.json") if gid.isalnum() else None
    if not rec:
        raise HTTPException(404, "graph not found")
    return _graph_for_caller(rec)


@router.delete("/graphs/{gid}")
def delete_graph(gid: str) -> dict:
    if gid.isalnum():
        path = _graphs_dir() / f"{gid}.json"
        _check_graph_owner(ontology._read(path) or {})
        path.unlink(missing_ok=True)
    return {"deleted": gid}
