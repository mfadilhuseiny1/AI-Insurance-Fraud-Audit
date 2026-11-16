"""AIP JKN · ML Studio: the models of the JKN data in one place — the supervised claim-risk model of the AIP
(aip/ml.py, trained by the Machine Learning agent's jobs) and Model Studio's no-code studios (model_studio.py) — with
their training runs and, for every run, the audit of the code that trained it (code_provenance: the files the training
process loaded, hashed, with their git state, the environment and the input data).

  GET  /api/ml-studio                               models (with their latest version) and training runs, newest first
  GET  /api/ml-studio/runs/{key}/code               a run and its code manifest
  GET  /api/ml-studio/runs/{key}/file?root=&path=   one file as it was trained
  POST /api/ml-studio/runs/{key}/verify             the manifest against the code as it is now (and the stored copies' hashes)
  GET  /api/ml-studio/runs/{key}/diff?root=&path=   from the file as trained to the file now
  GET  /api/ml-studio/runs/{key}/bundle             the audit kit (zip): code, manifest, notebook, Dockerfile, compose, README
  POST /api/ml-studio/runs/{key}/workspace          the audit kit as a JupyterLab (Docker) Code Workspace, in an image of the
                                                    training environment (built here once per environment)
  GET  /api/ml-studio/notebooks                     a notebook per model (ml_notebooks): each technique of the claim-risk
                                                    model, each Model Studio model
  GET  /api/ml-studio/notebooks/{id}                one notebook (.ipynb)
  GET  /api/ml-studio/notebooks/bundle              every notebook, the code they import, their Docker environment (zip, no data)
  POST /api/ml-studio/notebooks/workspace           all of them, with the data, in one JupyterLab (Docker) Code Workspace

A run is visible to whoever can see its model: the AIP's runs need read access to the silver claims (as the model card),
a studio's runs Viewer on its output model.
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import threading
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

import code_provenance as cp
import ml_audit_kit as kit

router = APIRouter(prefix="/api/ml-studio", tags=["ml-studio"])
log = logging.getLogger("ml_studio")
_lock = threading.Lock()
_builds: dict[str, dict] = {}  # image tag → {"status": building|ready|failed, "error"}

AIP_KINDS = {"train": "Training: benchmark teknik + model terpilih", "benchmark": "Benchmark teknik", "bukti": "Kartu bukti model",
             "sintetis": "Aturan 2 (data sintetis)", "produksi": "Pipeline produksi"}
TRAINERS = {"classification": "Klasifikasi", "regression": "Regresi", "time_series": "Peramalan deret waktu"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _external() -> dict[str, Path]:
    from aip import ml as aml

    k = aml.hkeval_dir()
    return {"evaluation-kit": k} if k.is_dir() else {}


def _model_view(m: dict, source: str, **extra: Any) -> dict:
    import model_assets

    versions = m.get("versions") or []
    last = versions[-1] if versions else {}
    return {"id": m["id"], "name": m["name"], "source": source, "path": model_assets._item_path(m), "versions": len(versions), "link": f"/model-assets/{m['id']}",
            "latest": last and {"version": last.get("version"), "id": last.get("id"), "created_at": last.get("created_at"), "code": last.get("code"),
                                "experiment_id": last.get("experiment_id"), "pickle": model_assets.pickle_info(m["id"], last["id"])}, **extra}


def _aip() -> tuple[Optional[dict], list[dict]]:
    from aip import ml as aml

    try:
        src = aml._source()
    except HTTPException:
        return None, []
    cur = aml.current() or {}
    model = None
    if cur.get("model"):
        import model_assets

        try:
            m, _ = model_assets._get(cur["model"]["model_id"])
            model = _model_view(m, "aip", trainer="Klasifikasi (supervised, 9 teknik dibandingkan)", studio_id=None, out_of_date=False,
                                description="Peluang klaim FKRTL dikoreksi verifikator BPJS, per segmen; dipilih dari benchmark teknik ML.")
        except HTTPException:
            model = None
    runs = []
    for f in sorted((aml._dir() / "jobs").glob("mlj-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:80]:
        j = aml._read(f, {})
        if not j:
            continue
        res, p = j.get("result") or {}, j.get("params") or {}
        name = AIP_KINDS.get(j["kind"], j["kind"])
        if j["kind"] == "benchmark":
            name += f" · {p.get('tugas') or ''} · {', '.join(p.get('model') or []) or 'semua teknik'}"
        mv = res.get("model") or {}
        runs.append({"key": j["id"], "source": "aip", "model": aml.MODEL_NAME, "model_id": (cur.get("model") or {}).get("model_id"), "name": name,
                     "kind": j["kind"], "started_at": j.get("created_at"), "finished_at": j.get("finished_at"), "status": j["status"], "config_version": None,
                     "version": mv.get("version"), "version_id": mv.get("version_id"), "experiment_id": mv.get("experiment_id"), "params": p,
                     "resources": {"proses": "subprocess: python -m aip.ml job.json"}, "inputs": [{"name": src["name"], "item_id": src["id"]}],
                     "metrics": res.get("summary"), "code": j.get("code"), "error": j.get("error"), "trigger": "manual", "changelog": None,
                     "aip_version": res.get("version")})
    return model, runs


def _studios() -> tuple[list[dict], list[dict]]:
    import db
    import model_assets
    import model_studio

    models, runs = [], []
    for s in model_studio.list_studios():
        try:
            st = model_studio.get_studio(s["id"])
            m, _ = model_assets._get(st["model_id"])
        except HTTPException:
            continue
        models.append(_model_view(m, "studio", trainer=TRAINERS.get(st["trainer"], st["trainer"]), studio_id=st["id"], studio=st["name"],
                                  out_of_date=st.get("out_of_date"), description=None))
        configs = {c["version"]: c for c in st.get("configs") or []}
        for r in st.get("runs") or []:
            c = configs.get(r.get("config_version")) or {}
            ins = [{"name": (db.drive_get(c[k]) or {}).get("name") or c[k], "item_id": c[k], "role": k.split("_")[0]}
                   for k in ("training_dataset_id", "test_dataset_id") if c.get(k)]
            params = {**(c.get("params") or {}), **{k: c[k] for k in ("target", "timestamp", "item_id") if c.get(k)}}
            if c.get("features"):
                params["features"] = c["features"]
            runs.append({"key": r["id"], "source": "studio", "studio_id": st["id"], "model": m["name"], "model_id": m["id"], "name": r.get("config_name") or st["name"],
                         "kind": st["trainer"], "started_at": r.get("started_at"), "finished_at": r.get("finished_at"), "status": r.get("status"),
                         "config_version": r.get("config_version"), "version": r.get("version"), "version_id": r.get("version_id"),
                         "experiment_id": r.get("experiment_id"), "params": params, "resources": r.get("resources"), "inputs": ins,
                         "metrics": r.get("metrics"), "code": r.get("code"), "error": r.get("error"), "trigger": r.get("trigger"),
                         "changelog": c.get("changelog"), "best_model": r.get("best_model"), "data_read": r.get("data_read")})
    return models, runs


@router.get("")
def overview() -> dict:
    """The models and every training run the caller can see, newest first."""
    import container_runtime as crt

    aip_model, aip_runs = _aip()
    studio_models, studio_runs = _studios()
    runs = sorted(aip_runs + studio_runs, key=lambda r: r.get("started_at") or "", reverse=True)
    return {"models": ([aip_model] if aip_model else []) + studio_models, "runs": runs,
            "docker": {"available": crt.available(), "error": None if crt.available() else crt.runtime().get("error")}}


def _run(key: str) -> dict:
    """The run, when the caller can see it (404 otherwise)."""
    if key.startswith("mlj-"):
        runs = _aip()[1]
    elif key.startswith("run-"):
        runs = _studios()[1]
    else:
        runs = []
    r = next((x for x in runs if x["key"] == key), None)
    if not r:
        raise HTTPException(404, "training run not found")
    return r


def _manifest(key: str) -> tuple[dict, dict]:
    r = _run(key)
    m = cp.load(key)
    if not m:
        raise HTTPException(404, "this run has no recorded training code (it ran before code tracking, or the capture failed)")
    return r, m


@router.get("/runs/{key}/code")
def run_code(key: str) -> dict:
    r = _run(key)
    return {"run": r, "manifest": cp.load(key)}


def _file(m: dict, root: str, path: str) -> dict:
    f = next((x for x in m.get("files") or [] if x["path"] == path and x["root"] == root), None)
    if not f:
        raise HTTPException(404, "no such file in this run's code")
    return f


@router.get("/runs/{key}/file")
def run_file(key: str, path: str, root: str = "repo") -> dict:
    _, m = _manifest(key)
    f = _file(m, root, path)
    body = cp.content(f["sha256"])
    if body is None:
        raise HTTPException(410, "the stored copy of this file is missing")
    return {**f, "content": body}


@router.post("/runs/{key}/verify")
def run_verify(key: str) -> dict:
    _, m = _manifest(key)
    return cp.verify(m, _external())


@router.get("/runs/{key}/diff")
def run_diff(key: str, path: str, root: str = "repo") -> dict:
    _, m = _manifest(key)
    _file(m, root, path)
    return {"path": path, "root": root, "diff": cp.diff(m, path, root, _external())}


@router.get("/runs/{key}/bundle")
def run_bundle(key: str) -> Response:
    """The audit kit without data (the code, the manifest, the notebook, the Docker environment)."""
    r, m = _manifest(key)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in kit.files(m, r).items():
            z.writestr(f"audit-{key}/{name}", body)
    return Response(buf.getvalue(), media_type="application/zip", headers={"content-disposition": f'attachment; filename="audit-kode-{key}.zip"'})


# ------------------------------------------------------------------------------------------------
# the audit kit as a JupyterLab (Docker) Code Workspace
# ------------------------------------------------------------------------------------------------


def _model_files(r: dict) -> Optional[dict]:
    """The AIP model's file and its scored claims (the notebook computes the published scores again)."""
    if r["source"] != "aip" or not r.get("aip_version"):
        return None
    from aip import ml as aml

    d = aml._dir() / "versions" / r["aip_version"]
    names = ("model.pkl", "fitur_klaim.parquet", "klaim.parquet")
    if not all((d / n).is_file() for n in names):
        return None
    return {"rescore": True, "files": {n: (d / n).read_bytes() for n in names}}


def _folder(r: dict) -> str:
    import db
    import model_assets

    if r["source"] == "aip":
        from aip import ml as aml

        return aml._out_folder()
    m, _ = model_assets._get(r["model_id"])
    return (db.drive_get(m["item_id"]) or {})["parent_id"]


def _image_present(tag: str) -> bool:
    import container_runtime as crt

    return crt.docker("image", "inspect", tag, check=False, timeout=60).returncode == 0


def _set_image(tag: str, status: str, error: Optional[str] = None) -> None:
    """Every workspace waiting on this image learns how its build ended."""
    import code_workspaces as cw

    for p in cw.DIR.glob("cws-*.json"):
        with cw._lock:
            try:
                rec = json.loads(p.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            if rec.get("image") != tag:
                continue
            rec["image_status"] = status
            if error:
                rec["image_error"] = error
            else:
                rec.pop("image_error", None)
            cw._event(rec, f"image {tag}: {status}")
            cw._write(rec)


def _build(tag: str, manifest: dict) -> None:
    import container_runtime as crt

    try:
        # the host's network: under WSL the build's own network gets WSL's resolver (10.255.255.254), which answers only
        # in WSL's namespace, and pip waits forever for PyPI; and PyPI's fastest file server for this network
        ip = kit.fastest_files_host(manifest)
        pin = ("--add-host", f"files.pythonhosted.org:{ip}") if ip else ()
        log.info("audit image %s: files.pythonhosted.org → %s", tag, ip or "DNS")
        crt.docker("build", "--network", "host", *pin, "-t", tag, "--label", "bluesandai.sidecar=jupyterlab", "-",
                   input_bytes=kit.dockerfile(manifest, inline=True).encode(), timeout=3600)
        state = ("ready", None)
    except Exception as e:  # noqa: BLE001 - the workspace shows why
        log.exception("audit image %s", tag)
        state = ("failed", str(e)[-1500:])
    with _lock:
        _builds[tag] = {"status": state[0], "error": state[1], "finished_at": _now()}
    _set_image(tag, *state)


def _ensure_image(tag: str, manifest: dict) -> str:
    """"ready", or "building" (a build of the image started now or already running)."""
    with _lock:
        if _image_present(tag):
            return "ready"
        if _builds.get(tag, {}).get("status") != "building":
            _builds[tag] = {"status": "building", "started_at": _now()}
            threading.Thread(target=_build, args=(tag, manifest), daemon=True, name=f"audit-image-{tag[-8:]}").start()
        return "building"


def _name_image(wid: str, tag: str, status: str, event: str, **extra: Any) -> None:
    """The workspace runs `tag`. A build that ended before the record named its image told no workspace (_set_image
    looks for the tag), so its end is applied here."""
    import code_workspaces as cw

    with cw._lock:
        rec = cw._read(wid)
        rec.update(image=tag, image_status=status, **extra)
        rec.pop("image_error", None)
        cw._event(rec, event)
        cw._write(rec)
    done = _builds.get(tag, {})
    if status == "building" and done.get("status") in ("ready", "failed"):
        _set_image(tag, done["status"], done.get("error"))


def _workspaces() -> dict:
    p = cp._store() / "workspaces.json"
    return json.loads(p.read_bytes()) if p.exists() else {}


def _set_workspace(key: str, wid: str) -> None:
    known = _workspaces()
    known[key] = wid
    (cp._store() / "workspaces.json").write_bytes(json.dumps(known).encode())


@router.post("/runs/{key}/workspace")
def run_workspace(key: str) -> dict:
    """The run's audit kit in a JupyterLab (Docker) Code Workspace (made once per run; its files are written again)."""
    import code_workspace_lab as lab
    import code_workspaces as cw
    import container_runtime as crt

    r, m = _manifest(key)
    if not crt.available():
        raise HTTPException(503, f"JupyterLab (Docker) needs a container runtime: {crt.runtime().get('error')}")
    tag = kit.image_tag(m)
    known = _workspaces()
    wid = known.get(key)
    rec = None
    if wid:
        try:
            rec = cw._get(wid, "editor")
        except HTTPException:
            rec = None
    if not rec:
        ws = cw.create_workspace(cw.WorkspaceIn(name=f"Audit kode · {r['model'][:40]} · {key}", folder_id=_folder(r), kind="jupyterlab", idle_minutes=30))
        wid = ws["id"]
        _set_workspace(key, wid)
    files = lab.files_dir(wid)
    shutil.rmtree(files / "code", ignore_errors=True)
    for name, body in kit.files(m, r, _model_files(r)).items():
        p = files / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)
    status = _ensure_image(tag, m)
    _name_image(wid, tag, status, f"audit kit of {key} written ({len(m['files'])} code files)", audit_run=key)
    return {"workspace_id": wid, "url": f"/code-workspaces?id={wid}", "image": tag, "image_status": status,
            "notebook": f"audit_{kit.slug(r['model'])}.ipynb"}


# ------------------------------------------------------------------------------------------------
# a notebook for every model (ml_notebooks): one by one, all in a zip, or all in one JupyterLab (Docker) Code Workspace
# with the data copied in
# ------------------------------------------------------------------------------------------------

NOTEBOOKS = "notebooks"  # the notebooks' workspace in workspaces.json, and what was last written into it (notebooks.json)


class NotebookWsIn(BaseModel):
    open: Optional[str] = None  # a notebook's id: the workspace link opens it
    # also the notebooks changed or run in JupyterLab: the user's copy is moved to arsip/ (dated), the new one written
    segarkan: bool = False


def _aip_context() -> Optional[tuple[Optional[dict], Optional[dict]]]:
    """(the current model card, the current model record), or None when the caller cannot read the claims."""
    from aip import ml as aml

    try:
        aml._source()
    except HTTPException:
        return None
    cur = aml.current()
    report = aml._read(aml._dir() / "versions" / cur["version"] / "report.json", None) if cur else None
    return report, cur


def _studio_entries() -> list[dict]:
    """Every Model Studio model the caller can see, with the configuration of its latest successful run (else the
    latest configuration) and that run."""
    import model_assets
    import model_studio

    out, names = [], set()
    for s in model_studio.list_studios():
        try:
            st = model_studio.get_studio(s["id"])
            model_assets._get(st["model_id"])
        except HTTPException:
            continue
        ok = [r for r in st.get("runs") or [] if r.get("status") == "succeeded"]
        run = max(ok, key=lambda r: r.get("started_at") or "") if ok else None
        configs = {c["version"]: c for c in st.get("configs") or []}
        cfg = (run and configs.get(run.get("config_version"))) or (st.get("configs") or [None])[-1]
        if not cfg or not cfg.get("training_dataset_id"):
            continue
        name = kit.slug(st["name"])
        if name in names:
            name += f"_{st['id'][-6:]}"
        names.add(name)
        out.append({"st": st, "cfg": cfg, "run": run, "file": f"studio_{name}.ipynb", "data": f"data/studio/{name}"})
    return out


def _studio_item(e: dict) -> dict:
    st, run = e["st"], e["run"]
    return {"id": f"studio-{st['id']}", "file": e["file"], "source": "studio", "title": st["name"], "family": TRAINERS.get(st["trainer"], st["trainer"]),
            "studio_id": st["id"], "model_id": st["model_id"], "config_version": e["cfg"].get("version"),
            "run": run and {"id": run["id"], "started_at": run.get("started_at"), "best": run.get("best_model"), "metrics": run.get("metrics")}}


def _studio_data(e: dict) -> dict[str, str]:
    """{"train": path, "test": path} of a studio's datasets in the workspace (relative to its notebooks)."""
    return {k: f"{e['data']}/{name}.parquet" for k, name, key in (("train", "latih", "training_dataset_id"), ("test", "uji", "test_dataset_id"))
            if e["cfg"].get(key)}


def _notebook_set(only: Optional[str] = None) -> tuple[list[dict], dict[str, bytes], list[dict], Optional[tuple]]:
    """(the catalog, {file: ipynb bytes}, the studios' entries, the claim-risk model's context) the caller can see;
    only: one notebook's id."""
    import ml_notebooks as nb

    ctx = _aip_context()
    studios = _studio_entries()
    catalog = (nb.aip_catalog(*ctx) if ctx else []) + [_studio_item(e) for e in studios]
    if only and not any(c["id"] == only for c in catalog):
        raise HTTPException(404, "notebook not found")
    shas = nb.code_shas()
    bodies: dict[str, bytes] = {}
    for c in catalog:
        if c["source"] == "aip" and (not only or c["id"] == only):
            bodies[c["file"]] = nb.dumps(nb.aip_notebook(c["title"], *ctx, shas["ml_klaim.py"]))
    for e in studios:
        if not only or f"studio-{e['st']['id']}" == only:
            bodies[e["file"]] = nb.dumps(nb.studio_notebook(e["st"], e["cfg"], e["run"], _studio_data(e), {f: shas[f] for f in nb.STUDIO_CODE[:2]},
                                                            TRAINERS.get(e["st"]["trainer"], e["st"]["trainer"])))
    return catalog, bodies, studios, ctx


def _notes(catalog: list[dict]) -> list[dict]:
    """The catalog with the README's one-line note per notebook."""
    out = []
    for c in catalog:
        if c["source"] == "aip":
            prod = ", ".join(f"produksi segmen {p['segment']}" for p in c["production"])
            ranks = "; ".join(f"peringkat {t['rank']}/{t['of']} ({t['label']})" for t in c["tasks"].values())
            note = " · ".join(x for x in (c["family"], prod, ranks) if x)
        else:
            note = f"{c['family']} · konfigurasi v{c['config_version']}" + (f" · run {c['run']['id']}" if c.get("run") else "")
        out.append({**c, "note": note})
    return out


@router.get("/notebooks")
def notebooks() -> dict:
    """A notebook per model the caller can see, and the notebooks' workspace (once made)."""
    import container_runtime as crt
    import ml_notebooks as nb

    ctx = _aip_context()
    catalog = (nb.aip_catalog(*ctx) if ctx else []) + [_studio_item(e) for e in _studio_entries()]
    wid = _workspaces().get(NOTEBOOKS)
    with _lock:
        going = dict(_nb_runs[wid]) if wid in _nb_runs else None
    return {"notebooks": catalog, "workspace": wid and {"id": wid, "url": f"/code-workspaces?id={wid}"},
            "jalan": {"sedang": going, "hasil": _ran().get(wid, {}) if wid else {}},
            "docker": {"available": crt.available(), "error": None if crt.available() else crt.runtime().get("error")}}


@router.get("/notebooks/bundle")
def notebooks_bundle() -> Response:
    """Every notebook with the code it imports and its Docker environment (no data)."""
    import ml_notebooks as nb

    catalog, bodies, studios, _ = _notebook_set()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in {**nb.support_files(_notes(catalog), bool(studios)), **bodies}.items():
            z.writestr(f"notebook-tiap-model/{name}", body)
    return Response(buf.getvalue(), media_type="application/zip", headers={"content-disposition": 'attachment; filename="notebook-tiap-model.zip"'})


@router.get("/notebooks/{nid}")
def notebook_file(nid: str) -> Response:
    """One notebook (.ipynb)."""
    catalog, bodies, _, _ = _notebook_set(nid)
    name = next(c["file"] for c in catalog if c["id"] == nid)
    return Response(bodies[name], media_type="application/x-ipynb+json", headers={"content-disposition": f'attachment; filename="{name}"'})


def _copy(src: Path, dst: Path) -> None:
    """src to dst unless dst is already a copy of it (same size, written after it)."""
    if dst.is_file() and dst.stat().st_size == src.stat().st_size and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.copyfile(src, tmp)
    tmp.replace(dst)


def _notebook_data(files: Path, ctx: Optional[tuple], studios: list[dict]) -> list[str]:
    """The notebooks' data into the workspace: the silver claims, the provinces, the production model, each studio's
    datasets. Returns what could not be copied."""
    import tempfile

    import db
    import drive

    missing = []
    if ctx:
        from aip import ml as aml

        with tempfile.TemporaryDirectory(prefix="ml-notebook-") as tmp:
            src, wil = aml._source(), aml._wilayah()
            _copy(aml._local(src, Path(tmp)), files / "data" / "kunjungan_fkrtl.parquet")
            if wil:
                _copy(aml._local(wil, Path(tmp)), files / "data" / "wilayah.parquet")
            else:
                missing.append("data/wilayah.parquet")
        cur = ctx[1]
        model = cur and aml._dir() / "versions" / cur["version"] / "model.pkl"
        if model and model.is_file():
            _copy(model, files / "data" / "model" / "model.pkl")
    for e in studios:
        for key, path in _studio_data(e).items():
            try:
                data = drive.read_bytes(db.drive_get(e["cfg"]["training_dataset_id" if key == "train" else "test_dataset_id"]))
            except Exception as ex:  # noqa: BLE001 - that notebook's data is reported missing
                missing.append(f"{path} ({type(ex).__name__})")
                continue
            p = files / path
            if not (p.is_file() and p.read_bytes() == data):
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
    return missing


def _cells_sha(data: bytes, outputs: bool = False) -> Optional[str]:
    """sha256 of a notebook's cells (type and source), or None when it does not parse or (unless `outputs`) has
    outputs. JupyterLab saves a notebook it only opened in its own layout (other bytes, the same cells): that one is
    still ours to update."""
    import hashlib

    try:
        cells = json.loads(data).get("cells") or []
    except ValueError:
        return None
    if not outputs and any(c.get("outputs") for c in cells):
        return None
    flat = [[c.get("cell_type"), "".join(c.get("source") or []) if isinstance(c.get("source"), list) else c.get("source") or ""] for c in cells]
    return hashlib.sha256(json.dumps(flat, ensure_ascii=False).encode()).hexdigest()


@router.post("/notebooks/workspace")
def notebooks_workspace(body: NotebookWsIn) -> dict:
    """Every notebook, the code and the data in one JupyterLab (Docker) Code Workspace, in an image with the platform's
    library versions. A notebook whose cells were changed, or that was run and saved with outputs, in JupyterLab since
    it was written here stays as it is."""
    import hashlib

    import code_workspace_lab as lab
    import code_workspaces as cw
    import container_runtime as crt
    import ml_notebooks as nb

    if not crt.available():
        raise HTTPException(503, f"JupyterLab (Docker) needs a container runtime: {crt.runtime().get('error')}")
    catalog, bodies, studios, ctx = _notebook_set()
    if not catalog:
        raise HTTPException(404, "no model you can see has a notebook")
    wid = _workspaces().get(NOTEBOOKS)
    try:
        rec = cw._get(wid, "editor") if wid else None
    except HTTPException:
        rec = None
    if not rec:
        if ctx:
            from aip import ml as aml

            folder = aml._out_folder()
        else:
            folder = _folder({"source": "studio", "model_id": catalog[0]["model_id"]})
        wid = cw.create_workspace(cw.WorkspaceIn(name="ML Studio · Notebook tiap model", folder_id=folder, kind="jupyterlab", idle_minutes=30))["id"]
        _set_workspace(NOTEBOOKS, wid)
    files = lab.files_dir(wid)
    state_path = cp._store() / "notebooks.json"
    state = json.loads(state_path.read_bytes()) if state_path.exists() else {}
    written = state.get(wid) or {}
    ran = _ran().get(wid, {})  # notebooks the platform ran (POST /notebooks/jalankan): their outputs are its own
    rewritten = []
    kept, archived = [], []
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for name, data in {**nb.support_files(_notes(catalog), bool(studios)), **bodies}.items():
        p = files / name
        sha = _cells_sha(data) if name.endswith(".ipynb") else hashlib.sha256(data).hexdigest()
        if name.endswith(".ipynb") and p.is_file():
            cur = p.read_bytes()
            mine = hashlib.sha256(cur).hexdigest() == (ran.get(name) or {}).get("sha")  # as the platform's run left it
            if mine and _cells_sha(cur, outputs=True) == sha:
                continue  # the platform ran this very notebook: its outputs (tables, charts) stay
            now = _cells_sha(cur)
            if not mine and (now is None or now not in (sha, written.get(name))):
                if not body.segarkan:
                    kept.append(name)
                    continue
                # the user's copy is kept, beside the new one: arsip/<name> (<date>).ipynb, never overwritten
                dest = files / "arsip" / f"{p.stem} ({day}){p.suffix}"
                n = 2
                while dest.exists():
                    dest = files / "arsip" / f"{p.stem} ({day}, {n}){p.suffix}"
                    n += 1
                dest.parent.mkdir(parents=True, exist_ok=True)
                p.replace(dest)
                archived.append(f"arsip/{dest.name}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        written[name] = sha
        if name in ran:
            rewritten.append(name)
    state[wid] = written
    state_path.write_bytes(json.dumps(state).encode())
    if rewritten:  # a new version of a notebook the platform ran: that run's outputs are gone with the old version
        _forget_runs(wid, rewritten)
    missing = _notebook_data(files, ctx, studios)
    env = nb.environment()
    tag = kit.image_tag(env)
    status = _ensure_image(tag, env)
    _name_image(wid, tag, status, f"notebooks written: {len(bodies) - len(kept)} new or updated, {len(kept)} kept as edited"
                + (f", {len(archived)} edited copies moved to arsip/" if archived else ""))
    opened = next((c["file"] for c in catalog if c["id"] == body.open), None)
    return {"workspace_id": wid, "url": f"/code-workspaces?id={wid}" + (f"&open={opened}" if opened else ""), "image": tag, "image_status": status,
            "notebooks": len(bodies), "kept": kept, "archived": archived, "missing": missing}


# ------------------------------------------------------------------------------------------------
# running the notebooks in their workspace's JupyterLab container: every cell's output — tables, the charts as
# images — saved in the .ipynb itself, so whoever opens it sees the results without running it
# ------------------------------------------------------------------------------------------------

_nb_runs: dict[str, dict] = {}  # workspace id → the run going on: {"antrean", "selesai", "sedang", "mulai"}


class NotebookRunIn(BaseModel):
    ids: list[str] = []  # notebook ids (GET /notebooks); none: every notebook of the workspace


def _ran_path() -> Path:
    return cp._store() / "notebook_runs.json"


def _ran() -> dict:
    p = _ran_path()
    try:
        return json.loads(p.read_bytes()) if p.exists() else {}
    except (OSError, ValueError):
        return {}


def _record_run(wid: str, name: str, rec: dict) -> None:
    with _lock:
        d = _ran()
        d.setdefault(wid, {})[name] = rec
        _ran_path().write_bytes(json.dumps(d).encode())


def _forget_runs(wid: str, names: list[str]) -> None:
    with _lock:
        d = _ran()
        for n in names:
            d.get(wid, {}).pop(n, None)
        _ran_path().write_bytes(json.dumps(d).encode())


def _execute(wid: str, names: list[str]) -> None:
    """Each notebook executed in place (nbconvert, every cell, errors kept in their cells), one after the other."""
    import hashlib
    import time

    import code_workspace_lab as lab
    import code_workspace_vscode as vs
    import container_runtime as crt

    files = lab.files_dir(wid)
    stop = threading.Event()

    def keep_alive() -> None:  # nbconvert's kernels run beside the JupyterLab server: the idle monitor does not see them
        while not stop.wait(60):
            with vs._lock:
                vs._live.setdefault(wid, {"active": 0})["touched"] = time.monotonic()

    threading.Thread(target=keep_alive, daemon=True, name=f"nb-keep-{wid[-6:]}").start()
    try:
        for name in names:
            with _lock:
                _nb_runs[wid]["sedang"] = name
            t = time.time()
            p = crt.docker("exec", "-w", vs.ENGINES["jupyterlab"]["files"], vs._name(wid, "jupyterlab"), "jupyter", "nbconvert", "--to", "notebook",
                           "--execute", "--inplace", "--allow-errors", "--ExecutePreprocessor.timeout=-1", name, check=False, timeout=4 * 3600)
            raw = (files / name).read_bytes() if (files / name).is_file() else b""
            errors = []
            try:
                for c in json.loads(raw).get("cells") or []:
                    errors += [f"sel {c.get('id')}: {o.get('ename')}: {str(o.get('evalue'))[:200]}" for o in c.get("outputs") or [] if o.get("output_type") == "error"]
            except ValueError:
                errors.append("notebook tidak terbaca setelah dijalankan")
            if p.returncode != 0 and not errors:
                errors.append((p.stderr or p.stdout or b"").decode(errors="replace").strip()[-400:])
            _record_run(wid, name, {"pada": _now(), "detik": round(time.time() - t), "status": "galat" if errors else "berhasil", "galat": errors[:5],
                                    "sha": hashlib.sha256(raw).hexdigest()})
            with _lock:
                _nb_runs[wid]["selesai"].append(name)
    except Exception:  # noqa: BLE001 - the run's end is recorded; the reason is in the log
        log.exception("notebook run %s", wid)
    finally:
        stop.set()
        with _lock:
            _nb_runs.pop(wid, None)


@router.post("/notebooks/jalankan")
def notebooks_run(body: NotebookRunIn) -> dict:
    """Run notebooks of the notebooks' workspace in its JupyterLab container (started if stopped), one after the other,
    each saved with its outputs; GET /notebooks shows the run and each notebook's last result."""
    import code_workspace_lab as lab
    import code_workspace_vscode as vs
    import code_workspaces as cw
    import ml_notebooks as nb

    wid = _workspaces().get(NOTEBOOKS)
    if not wid:
        raise HTTPException(409, "workspace notebook belum dibuat: Buka di JupyterLab dulu")
    cw._get(wid, "editor")
    with _lock:
        if wid in _nb_runs:
            raise HTTPException(409, "notebook di workspace ini sedang dijalankan")
    ctx = _aip_context()
    catalog = (nb.aip_catalog(*ctx) if ctx else []) + [_studio_item(e) for e in _studio_entries()]
    files = lab.files_dir(wid)
    names = [c["file"] for c in catalog if (not body.ids or c["id"] in body.ids) and (files / c["file"]).is_file()]
    if not names:
        raise HTTPException(404, "tidak ada notebook itu di workspace (Buka di JupyterLab menulisnya)")
    vs.start(wid)  # the container, started when stopped (a building or failed image answers here)
    vs._keepalive(wid)
    with _lock:
        _nb_runs[wid] = {"antrean": names, "selesai": [], "sedang": None, "mulai": _now()}
    threading.Thread(target=_execute, args=(wid, names), daemon=True, name=f"nb-run-{wid[-6:]}").start()
    return {"workspace_id": wid, "antrean": names}
