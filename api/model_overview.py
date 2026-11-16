"""Model Integration overviews: the hub's live counts, the adapters in use, the evaluation overview and the
foundry_ml migration helper (palantir.com/docs/foundry/migrate-models).

* GET /api/model-overview: models by kind, versions, experiments, evaluation sets, running deployments, objectives,
  studios, the latest versions and each objective's release and evaluation state.
* GET /api/model-overview/adapters: every model adapter class in use (module.class), the models and versions using it.
* GET /api/model-overview/migration: the migration helper. `foundry_ml` (dataset-backed models) never existed on this
  platform, so there are no dataset-backed models to migrate; the helper scans Code Repositories (default branch) and
  Code Workbooks for code that still uses `foundry_ml` / `foundry_ml_metrics` (imports, `Model(...).save`,
  `Model.load`, `MetricSet`), and suggests the palantir_models equivalent (an adapter and a ModelOutput / ModelInput
  skeleton built from what the code uses). A finding can be given a replacement model or be ignored
  (PUT /migration/<key>), as in Upgrade Assistant.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/model-overview", tags=["model-overview"])
DIR = Path("data/model-overview")
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "model-overview"
    DIR.mkdir(parents=True, exist_ok=True)


def _models() -> list[dict]:
    import model_assets

    out = []
    for p in sorted(model_assets.DIR.glob("mdl-*.json")):
        try:
            rec, _ = model_assets._get(p.stem)
        except HTTPException:
            continue
        out.append(rec)
    return out


@router.get("")
def overview() -> dict:
    import model_assets
    import model_deployments
    import model_studio
    import modeling_objectives

    models = _models()
    versions = [(m, v) for m in models for v in m.get("versions") or []]
    deps = model_deployments.list_deployments()
    objectives = modeling_objectives.list_objectives()
    try:
        studios = model_studio.list_studios()
    except Exception:  # noqa: BLE001
        studios = []
    evals = {m["id"]: model_assets._evaluations(m["id"]) for m in models if m.get("kind") == "python"}
    import model_evaluation

    obj_rows = []
    for o in objectives:
        rows = model_evaluation._results(o["id"])
        cfg = o.get("evaluation") or {}
        obj_rows.append({"id": o["id"], "name": o["name"], "submissions": len([c for c in o["candidates"] if not c.get("archived")]),
                         "staging": (o.get("current_releases") or {}).get("staging"), "production": (o.get("current_releases") or {}).get("production"),
                         "evaluation_datasets": len(cfg.get("datasets") or []), "evaluation_libraries": len(cfg.get("libraries") or []),
                         "evaluation_results": len([r for r in rows if r["status"] == "succeeded"]), "evaluation_failures": len([r for r in rows if r["status"] == "failed"]),
                         "last_built": max((r["built_at"] for r in rows), default=None), "updated_at": o.get("updated_at")})
    latest = sorted(versions, key=lambda mv: mv[1]["created_at"], reverse=True)[:8]
    return {
        "models": {"total": len(models), "trained": sum(1 for m in models if m.get("kind") == "python" and not m.get("external")),
                   "external": sum(1 for m in models if m.get("external")), "container": sum(1 for m in models if m.get("kind", "container") == "container")},
        "versions": len(versions), "experiments": sum(len(model_assets._experiments(m["id"])) for m in models if m.get("kind") == "python"),
        "evaluation_sets": sum(len({e["set"] for e in v}) for v in evals.values()), "evaluations": sum(len(v) for v in evals.values()),
        "deployments": {"total": len(deps), "running": sum(1 for d in deps if d["state"] == "running"), "live": sum(1 for d in deps if d["kind"] != "batch"),
                        "batch": sum(1 for d in deps if d["kind"] == "batch"), "functions": sum(1 for d in deps if d.get("function"))},
        "objectives": obj_rows, "studios": len(studios),
        "latest_versions": [{"model_id": m["id"], "model": m["name"], "kind": m.get("kind", "container"), "version": v["version"], "branch": v.get("branch"),
                             "created_at": v["created_at"], "source": (v.get("source") or {}).get("repo") or (v.get("adapter") or {}).get("class")} for m, v in latest],
        "evaluation_sets_by_model": [{"model_id": mid, "model": next(m["name"] for m in models if m["id"] == mid), "sets": sorted({e["set"] for e in ev}),
                                      "last": max((e["created_at"] for e in ev), default=None)} for mid, ev in evals.items() if ev],
    }


@router.get("/lifecycle")
def lifecycle() -> list[dict]:
    """Every model's way through the four steps of Model Integration — trained (where), evaluated (charts with its
    latest version), benchmarked (the objectives it is submitted to, with results), deployed (live, batch, functions) —
    for the hub's guide. Test models (api/test_space.py naming) are flagged."""
    import model_assets
    import model_deployments
    import model_evaluation
    import modeling_objectives
    import test_space

    models = _models()
    deps = model_deployments.list_deployments()
    objectives = modeling_objectives.list_objectives()
    # an objective's deployments serve its current releases: the models of those submissions
    released: dict[str, set[str]] = {}
    for o in objectives:
        for env, rel in (o.get("current_releases") or {}).items():
            c = next((c for c in o["candidates"] if rel and c.get("submission_id") == rel.get("submission_id")), None)
            if c and c.get("model_id"):
                released.setdefault(o["id"], set()).add(c["model_id"])
    results = {o["id"]: model_evaluation._results(o["id"]) for o in objectives}
    apps = {"code_workspace": ("Jupyter", "/code-workspaces?id={workspace_id}"), "model_studio": ("Model Studio", "/model-studio?id={studio_id}")}
    out = []
    for m in models:
        versions = m.get("versions") or []
        latest = versions[-1] if versions else None
        src = (latest or {}).get("source") or {}
        if m.get("kind", "container") == "container":
            app, link = "Container image", f"/container-models?id={m['id']}"
        elif m.get("external"):
            app, link = "Externally hosted", f"/model-assets/{m['id']}"
        elif src.get("kind") in apps:
            app, tpl = apps[src["kind"]]
            link = tpl.format(**{k: src.get(k, "") for k in ("workspace_id", "studio_id")})
        elif src.get("repo_id"):
            app, link = "Code Repositories", f"/code-repositories/{src['repo_id']}"
        else:
            app, link = None, None
        evaluated = False
        if latest and latest.get("experiment_id") and m.get("kind") == "python":
            exp = next((e for e in model_assets._experiments(m["id"]) if e["id"] == latest["experiment_id"]), None)
            evaluated = bool(exp and (exp.get("evaluations") or exp.get("images")))
        eval_sets = len({e["set"] for e in model_assets._evaluations(m["id"])}) if m.get("kind") == "python" else 0
        bench = []
        for o in objectives:
            cands = [c for c in o["candidates"] if c.get("model_id") == m["id"] and not c.get("archived")]
            if cands:
                ids = {c["id"] for c in cands}
                bench.append({"id": o["id"], "name": o["name"], "evaluated": any(r["candidate_id"] in ids and r["status"] == "succeeded" for r in results[o["id"]]),
                              "released": m["id"] in released.get(o["id"], set())})
        mine = [d for d in deps if d.get("model_id") == m["id"] or (d.get("objective_id") and m["id"] in released.get(d["objective_id"], set()))]
        out.append({
            "id": m["id"], "name": m["name"], "kind": m.get("kind", "container"), "path": model_assets._item_path(m),
            "test": test_space.is_test_name(m["name"]) or any(test_space.is_test_name(p) for p in model_assets._item_path(m)),
            "trained": {"versions": len(versions), "latest": latest and latest.get("version"), "at": latest and latest.get("created_at"), "app": app, "link": link},
            "evaluated": {"charts": evaluated, "evaluation_sets": eval_sets},
            "benchmarks": bench,
            "deployed": {"live": sum(1 for d in mine if d["kind"] != "batch"), "running": sum(1 for d in mine if d["state"] == "running"),
                         "batch": sum(1 for d in mine if d["kind"] == "batch"), "functions": sorted({d["function"]["api_name"] for d in mine if d.get("function")})},
            "updated_at": (latest or {}).get("created_at") or m.get("updated_at"),
        })
    return sorted(out, key=lambda r: r.get("updated_at") or "", reverse=True)


@router.get("/adapters")
def adapters() -> list[dict]:
    """Each adapter class in use and where: models, versions, kinds."""
    out: dict[str, dict] = {}
    for m in _models():
        for v in m.get("versions") or []:
            a = v.get("adapter") or {}
            key = f"{a.get('module') or a.get('file')}.{a.get('class')}"
            row = out.setdefault(key, {"adapter": key, "class": a.get("class"), "module": a.get("module") or a.get("file"), "kinds": set(), "models": {},
                                       "serializers": set(), "repo_id": a.get("repo_id") or (v.get("source") or {}).get("repo_id"), "last_used": ""})
            kind = "external" if m.get("external") else m.get("kind", "container")
            row["kinds"].add(kind)
            row["models"].setdefault(m["id"], {"model_id": m["id"], "model": m["name"], "kind": kind, "versions": []})["versions"].append(v["version"])
            for s in (v.get("serializers") or {}).values():
                row["serializers"].add(s)
            if v.get("custom_serialization"):
                row["serializers"].add("custom save() / load()")
            row["last_used"] = max(row["last_used"], v["created_at"])
            if v.get("api"):
                row["api"] = v["api"]
    return sorted(({**r, "kinds": sorted(r["kinds"]), "serializers": sorted(r["serializers"]), "models": list(r["models"].values())} for r in out.values()),
                  key=lambda r: r["last_used"], reverse=True)


# ------------------------------------------------------------------------------------------------
# foundry_ml migration helper
# ------------------------------------------------------------------------------------------------

PATTERNS = [
    (re.compile(r"^\s*(from\s+foundry_ml(\.\w+)*\s+import|import\s+foundry_ml\b)"), "import", "imports foundry_ml"),
    (re.compile(r"^\s*(from\s+foundry_ml_metrics|import\s+foundry_ml_metrics)"), "metricset_import", "imports foundry_ml_metrics (MetricSets)"),
    (re.compile(r"\bModel\s*\(\s*Stage\s*\("), "model_stages", "builds a foundry_ml Model from Stages"),
    (re.compile(r"\.save\(\s*\w*output\w*\s*\)"), "save", "saves a model to a dataset output (dataset-backed model)"),
    (re.compile(r"\bModel\.load\("), "load", "loads a dataset-backed model (Model.load)"),
    (re.compile(r"\bMetricSet\s*\("), "metricset", "writes a MetricSet"),
]


def _state() -> dict:
    p = DIR / "migration.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def _scan() -> list[dict]:
    import code_repos

    findings: dict[str, dict] = {}
    for rec in code_repos.list_repos():
        try:
            full = code_repos._repo(rec["id"])
            b = code_repos._branch(full, None)
            files = code_repos._commit_files(rec["id"], b.get("head")) if b.get("head") else dict(b.get("files") or {})
        except HTTPException:
            continue
        for path, text in files.items():
            if not path.endswith(".py") or ("foundry_ml" not in text and "MetricSet" not in text):
                continue
            hits = []
            for i, line in enumerate(text.splitlines(), 1):
                for rx, kind, what in PATTERNS:
                    if rx.search(line):
                        hits.append({"line": i, "kind": kind, "what": what, "code": line.strip()[:200]})
            if not any(h["kind"] in ("import", "metricset_import") for h in hits):
                continue
            key = f"repo:{rec['id']}:{path}"
            findings[key] = {"key": key, "resource": "Code Repository", "resource_id": rec["id"], "resource_name": rec["name"], "file": path, "hits": hits,
                             "suggestion": _suggest(text, hits)}
    findings.update(_scan_workbooks())
    return list(findings.values())


def _scan_workbooks() -> dict[str, dict]:
    """Code Workbooks (master branch): Python nodes and the global code."""
    out: dict[str, dict] = {}
    try:
        import code_workbook

        items = code_workbook.list_workbooks()
    except Exception:  # noqa: BLE001
        return out
    for item in items:
        try:
            w = code_workbook._load(item)
        except Exception:  # noqa: BLE001
            continue
        b = (w.get("branches") or {}).get("master") or {}
        sources = [("global code", b.get("global_code") or "")] + [(n.get("name") or n.get("id"), str(n.get("code") or "")) for n in b.get("nodes") or []]
        if not any("foundry_ml" in code for _, code in sources):
            continue
        hits = []
        for node, code in sources:
            for i, line in enumerate(code.splitlines(), 1):
                for rx, kind, what in PATTERNS:
                    if rx.search(line):
                        hits.append({"line": i, "kind": kind, "what": what, "code": line.strip()[:200], "node": node})
        if hits:
            key = f"workbook:{item['id']}"
            out[key] = {"key": key, "resource": "Code Workbook", "resource_id": item["id"], "resource_name": item["name"], "file": None, "hits": hits,
                        "suggestion": _suggest("\n".join(code for _, code in sources), hits)}
    return out


def _suggest(text: str, hits: list[dict]) -> str:
    """A palantir_models version of what the code does: an adapter (the model kept with Dill), a training transform
    publishing to a ModelOutput, and inference with a ModelInput; MetricSets become evaluations."""
    kinds = {h["kind"] for h in hits}
    outputs = re.findall(r'(\w+)\s*=\s*Output\(\s*"([^"]+)"', text)
    inputs = re.findall(r'(\w+)\s*=\s*Input\(\s*"([^"]+)"', text)
    model_out = next((p for n, p in outputs if "model" in n.lower() or "model" in p.lower()), outputs[0][1] if outputs else "/path/to/model")
    train_in = next((p for n, p in inputs if "model" not in n.lower()), "/path/to/training_data")
    parts = ['''# model_adapters/adapter.py
import palantir_models as pm


class MigratedModelAdapter(pm.ModelAdapter):
    @pm.auto_serialize
    def __init__(self, model):
        self.model = model  # the fitted model or pipeline that the foundry_ml Stage wrapped

    @classmethod
    def api(cls):
        # list the feature columns (and types) the model expects
        return {"df_in": pm.Pandas()}, {"df_out": pm.Pandas()}

    def predict(self, df_in):
        df_in["prediction"] = self.model.predict(df_in[...])  # the feature columns
        return df_in
''']
    if kinds & {"import", "model_stages", "save"}:
        parts.append(f'''# model_training/model_training.py
from transforms.api import transform, Input
from palantir_models.transforms import ModelOutput
from model_adapters.adapter import MigratedModelAdapter


@transform.using(
    training_data=Input("{train_in}"),
    model_output=ModelOutput("{re.sub(r'(_foundry_ml)$', '', model_out)}"),
)
def train(training_data, model_output):
    df = training_data.pandas()
    model = ...  # the training code, unchanged
    model_output.publish(model_adapter=MigratedModelAdapter(model))
''')
    if "load" in kinds:
        parts.append('''# inference: Model.load(input) becomes a ModelInput
from transforms.api import transform, Input, Output
from palantir_models.transforms import ModelInput


@transform.using(data=Input("/path/to/data"), model=ModelInput("/path/to/model"), out=Output("/path/to/predictions"))
def predict(data, model, out):
    out.write_pandas(model.transform(data).df_out)
''')
    if kinds & {"metricset", "metricset_import"}:
        parts.append('''# MetricSet(...).add(name, value) becomes an evaluation of the model version
import palantir_models as pm
from palantir_models.transforms import ModelInput


@pm.transforms.evaluation("metrics")
@transform.using(test=Input("/path/to/test"), model=ModelInput("/path/to/model"), out=Output("/path/to/evaluated"))
def evaluate(test, model, out):
    evaluation = model.create_evaluation()
    evaluation.log_metrics({"Accuracy": ..., "F1": ...})
''')
    return "\n\n".join(parts)


@router.get("/migration")
def migration() -> dict:
    import model_assets

    state = _state()
    rows = []
    for f in _scan():
        s = state.get(f["key"]) or {}
        status = "ignored" if s.get("ignored") else "completed" if s.get("replacement_model_id") else "needs_migration"
        repl = None
        if s.get("replacement_model_id"):
            try:
                m, _ = model_assets._get(s["replacement_model_id"])
                repl = {"id": m["id"], "name": m["name"], "kind": m.get("kind", "container")}
            except HTTPException:
                repl = {"id": s["replacement_model_id"], "name": "(no longer available)", "kind": None}
        rows.append({**f, "status": status, "replacement": repl, "note": s.get("note", ""), "updated_at": s.get("updated_at")})
    return {"findings": rows, "counts": {k: sum(1 for r in rows if r["status"] == k) for k in ("needs_migration", "completed", "ignored")},
            "dataset_backed_models": 0, "note": "foundry_ml dataset-backed models never existed on this platform: only code that still uses foundry_ml is listed."}


class MigrationIn(BaseModel):
    status: Literal["needs_migration", "ignored", "completed"]
    replacement_model_id: Optional[str] = None
    note: str = Field(default="", max_length=2000)


@router.put("/migration/{key:path}")
def set_migration(key: str, req: MigrationIn) -> dict:
    import model_assets

    if req.status == "completed":
        if not req.replacement_model_id:
            raise HTTPException(400, "choose the model that replaces it")
        model_assets._get(req.replacement_model_id)
    with _lock:
        state = _state()
        state[key] = {"ignored": req.status == "ignored", "replacement_model_id": req.replacement_model_id if req.status == "completed" else None,
                      "note": req.note.strip(), "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        DIR.mkdir(parents=True, exist_ok=True)
        (DIR / "migration.json").write_text(json.dumps(state, indent=1), "utf-8")
    return migration()


@router.get("/experiments")
def experiments() -> dict:
    """Every experiment and evaluation of the models the caller may see (newest first)."""
    import model_assets

    exps, evs = [], []
    for m in _models():
        if m.get("kind") != "python":
            continue
        for e in model_assets._experiments(m["id"]):
            exps.append({"model_id": m["id"], "model": m["name"], "id": e["id"], "name": e["name"], "version": e.get("version"), "created_at": e["created_at"],
                         "params": e.get("params") or {}, "metrics": {k: s[-1]["value"] for k, s in (e.get("metrics") or {}).items() if s}})
        for e in model_assets._evaluations(m["id"]):
            evs.append({"model_id": m["id"], "model": m["name"], "id": e["id"], "name": e["name"], "set": e["set"], "version": e.get("version"),
                        "created_at": e["created_at"], "metrics": e.get("metrics") or {}})
    return {"experiments": sorted(exps, key=lambda x: x["created_at"], reverse=True), "evaluations": sorted(evs, key=lambda x: x["created_at"], reverse=True)}
