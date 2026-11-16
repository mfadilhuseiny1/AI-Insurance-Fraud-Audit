"""AIP Machine Learning: the supervised claim-risk models (engine: ml_klaim.py) as a platform capability, and what the
"Agen Machine Learning (BPJS)" calls.

  GET  /api/aip/ml                 the model card: version, segments, the benchmarks (leaderboards with intervals,
                                   explainers, temporal check, global importance), the protocol and its caveats
  POST /api/aip/ml/train           a training run: the benchmark, the chosen model per segment, every claim scored,
                                   an MLflow run published as a model version, two datasets in Files, the Nexus types
  POST /api/aip/ml/benchmark       a benchmark only (models, task, folds, a province): "benchmark across techniques"
  GET  /api/aip/ml/jobs/{id}       a job: status, log, result
  POST /api/aip/ml/klaim           the riskiest claims of a scope, with their reasons
  POST /api/aip/ml/faskes          facilities by expected corrections
  POST /api/aip/ml/jelaskan        one claim explained by several methods (TreeSHAP, KernelSHAP, LIME, occlusion, EBM)

Jobs run in a subprocess (`python -m aip.ml job.json`, as Model Studio's runs): MLflow's tracking URI is process-wide,
and a benchmark holds a few GB. The caller must be able to read the silver claims (Files) for every endpoint; the
datasets written inherit their markings. State: <data>/aip/ml (current.json, versions/<id>/, jobs/<id>.json).
"""

from __future__ import annotations

import contextvars
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip/ml")
log = logging.getLogger("aip.ml")

API_DIR = Path(__file__).resolve().parent.parent
PROJECT = "Data Sampel BPJS 2025"
OUT_FOLDER = "ml"
MODEL_NAME = "Model Risiko Koreksi Klaim BPJS (ML)"
DS_KLAIM = "skor_risiko_klaim_ml.parquet"
DS_FASKES = "risiko_faskes_ml.parquet"
KEEP_TOP = 20_000  # riskiest claims kept per segment in the claims dataset
GROUP = ("Agen Machine Learning (BPJS)",
         "Agen ML AIP: model supervised (dilatih dengan label hasil verifikasi BPJS) yang menilai risiko klaim FKRTL dikoreksi "
         "verifikator, per segmen (rumah sakit; klinik utama). Menjalankan model untuk cakupan tertentu, menjelaskan tiap klaim "
         "dengan beberapa metode (TreeSHAP, KernelSHAP, LIME, oklusi), membandingkan teknik ML (benchmark: regresi logistik, "
         "random forest, extra trees, gradient boosting, XGBoost, LightGBM, CatBoost, MLP, EBM) dengan validasi silang per faskes, "
         "dan melaporkan akurasi, presisi, recall, F1, AUROC, AUPRC beserta interval kepercayaannya.")
TYPES = {
    "klaim": ("Skor Risiko Klaim ML (BPJS)", "SkorRisikoKlaimMlBpjs", DS_KLAIM, "klaim_id", "judul", "gauge", "#7961db",
              "Klaim FKRTL berisiko tertinggi menurut model ML (per segmen), klaim yang memang dikoreksi verifikator, dan klaim "
              "berisiko tinggi yang lolos verifikasi; dengan peluang koreksi dan alasan (TreeSHAP)."),
    "faskes": ("Risiko Faskes ML (BPJS)", "RisikoFaskesMlBpjs", DS_FASKES, "faskes_profil_id", "nama_profil", "gauge", "#7961db",
               "Profil faskes menurut model ML: ekspektasi koreksi verifikasi (jumlah peluang), koreksi aktual, klaim ditandai, "
               "klaim berisiko tinggi yang lolos verifikasi, dan rasio aktual/ekspektasi."),
}
LINKS = [("Skor ML klaim di profil faskes (BPJS)", "klaim", "faskes_profil_id", "Profil Faskes (BPJS)", "Skor risiko klaim ML", "Profil faskes"),
         ("Risiko ML untuk profil faskes (BPJS)", "faskes", "faskes_profil_id", "Profil Faskes (BPJS)", "Risiko faskes ML", "Profil faskes")]
_lock = threading.Lock()
_cache: dict[str, Any] = {}
_jobs: dict[str, dict] = {}


def _dir() -> Path:
    from aip import vertex as aip_vertex

    d = aip_vertex.DIR.parent / "ml"
    (d / "jobs").mkdir(parents=True, exist_ok=True)
    (d / "versions").mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write(path: Path, data: Any) -> None:
    from aip.runs import _write as atomic

    atomic(path, data)


def _read(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return default


# ------------------------------------------------------------------------------------------------
# the data, as the caller
# ------------------------------------------------------------------------------------------------


def _child(parent: Optional[str], name: str) -> Optional[dict]:
    import db

    return next((c for c in db.drive_list(parent) if c["name"] == name and not c.get("trashed_at")), None)


def _source() -> dict:
    """The silver claims (Files), checked as the caller: every model and score comes from them."""
    import drive

    project = _child(None, PROJECT)
    silver = project and _child(project["id"], "silver")
    item = silver and _child(silver["id"], "kunjungan_fkrtl.parquet")
    if not item:
        raise HTTPException(404, f"dataset Data Bersih kunjungan_fkrtl tidak ditemukan di {PROJECT}")
    return drive._item(item["id"])  # 403/404 for a caller without access


def _wilayah() -> Optional[dict]:
    """The gold dimension kab/kota → province in the data's 38-province coding (Files, as the caller), or None when it is
    not there or the caller cannot read it: the provinces of the scores come from it (the model's feature provinsi_kode
    stays the BPS prefix of the kab/kota, the 34-province coding it was trained on)."""
    import drive

    project = _child(None, PROJECT)
    gold = project and _child(project["id"], "gold")
    item = gold and _child(gold["id"], "wilayah.parquet")
    if not item:
        return None
    try:
        return drive._item(item["id"])
    except HTTPException:
        return None


def _local(item: dict, tmp: Path) -> Path:
    import drive
    import storage

    if item.get("stored_in") == "s3":
        dest = tmp / f"{item['id']}.parquet"
        storage._s3().download_file(storage._bucket(), f"drive/{item['id']}", str(dest))
        return dest
    return drive.LOCAL_DIR / item["id"]


def _out_folder() -> str:
    import drive

    project = _child(None, PROJECT)
    have = _child(project["id"], OUT_FOLDER)
    return have["id"] if have else drive.create_folder(drive.NewFolder(name=OUT_FOLDER, parent_id=project["id"], kind="folder"))["id"]


# ------------------------------------------------------------------------------------------------
# the current model (loaded once per version)
# ------------------------------------------------------------------------------------------------


def current() -> Optional[dict]:
    return _read(_dir() / "current.json")


def _loaded() -> dict:
    import pickle

    import pandas as pd

    cur = current()
    if not cur:
        raise HTTPException(409, "model ML belum dilatih: jalankan POST /api/aip/ml/train")
    with _lock:
        if _cache.get("version") != cur["version"]:
            d = _dir() / "versions" / cur["version"]
            _cache.clear()
            _cache.update({"version": cur["version"], "bundle": pickle.loads((d / "model.pkl").read_bytes()),
                           "klaim": pd.read_parquet(d / "klaim.parquet"), "faskes": pd.read_parquet(d / "faskes.parquet"),
                           "fitur": pd.read_parquet(d / "fitur_klaim.parquet"), "report": _read(d / "report.json", {})})
        return _cache


# ------------------------------------------------------------------------------------------------
# jobs (subprocess)
# ------------------------------------------------------------------------------------------------


def _job_path(jid: str) -> Path:
    if not re.fullmatch(r"mlj-[0-9a-f]{10}", jid):
        raise HTTPException(400, "id job tidak sah")
    return _dir() / "jobs" / f"{jid}.json"


def _save_job(job: dict) -> None:
    _write(_job_path(job["id"]), job)


HEAVY = ("train", "bukti", "sintetis", "produksi")  # one at a time: each holds the whole claims table


def _start(kind: str, params: dict, extra: Optional[dict] = None) -> dict:
    import auth

    src = _source()
    p = auth.current() or {}
    if kind == "train":
        _out_folder()  # the caller must be able to write the outputs: checked before the run
    with _lock:
        running = [j for j in _jobs.values() if j["status"] == "running"]
        heavy = [j for j in running if j["kind"] in HEAVY]
        if kind in HEAVY and (heavy or len(running) >= 4):
            raise HTTPException(429, "job ML berat lain sedang berjalan: tunggu sampai selesai")
        if len(running) >= 10 or len(heavy) and len(running) >= 6:
            raise HTTPException(429, "terlalu banyak job ML berjalan: tunggu salah satunya selesai")
        job = {"id": f"mlj-{uuid.uuid4().hex[:10]}", "kind": kind, "params": params, "status": "running", "created_at": _now(),
               "user_id": p.get("id"), "log": [], "result": None, "error": None, "extra": extra or {}}
        _jobs[job["id"]] = job
    _save_job(job)
    threading.Thread(target=contextvars.copy_context().run, args=(_run, job, src, _wilayah()), daemon=True, name=f"ml-{job['id']}").start()
    return job


def _run(job: dict, src: dict, wilayah: Optional[dict] = None) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="aip-ml-"))
    try:
        spec = {"kind": job["kind"], "params": job["params"], "source": str(_local(src, tmp)), "out": str(tmp / "out"), "stage": str(tmp / "stage"),
                "cache": str(_dir() / "cache"), "source_key": f"{src['id']}-{src.get('size_bytes') or 0}",
                "wilayah": str(_local(wilayah, tmp)) if wilayah else None, **(job.get("extra") or {})}
        (tmp / "job.json").write_text(json.dumps(spec), "utf-8")
        env = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL", k)}
        env.update({"PYTHONUTF8": "1", "MLFLOW_DISABLE_AGENT_HINT": "1"})
        proc = subprocess.Popen([sys.executable, "-u", "-m", "aip.ml", str(tmp / "job.json")], cwd=str(API_DIR), env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        job["pid"] = proc.pid
        last = time.time()
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.rstrip()
            if line.startswith("[") or "gagal" in line or "Error" in line:
                job["log"] = (job["log"] + [line])[-200:]
            if time.time() - last > 3:
                _save_job(job)
                last = time.time()
        proc.wait()
        res = _read(tmp / "out" / "result.json")
        if proc.returncode != 0 or not res or not res.get("ok"):
            raise RuntimeError((res or {}).get("error") or "\n".join(job["log"][-8:]) or f"proses keluar dengan kode {proc.returncode}")
        manifest = _read(tmp / "out" / "code_manifest.json")
        if manifest:
            import code_provenance

            job["code"] = code_provenance.summary(code_provenance.store(job["id"], manifest))
        if job["kind"] == "train":
            res = _register(job, src, tmp / "out", tmp / "stage", res)
        elif job["kind"] == "bukti":
            res = _register_evidence(job, tmp / "out", res)
        elif job["kind"] == "sintetis":
            dest = _dir() / "aturan2"
            shutil.rmtree(dest, ignore_errors=True)
            shutil.copytree(tmp / "out" / "aturan2", dest, ignore=shutil.ignore_patterns("work"))
        elif job["kind"] == "produksi":
            from aip import produksi

            full = produksi.register(job, src, tmp / "out", res)
            produksi.on_job_end(job, tmp / "out", full, None)
            res = {"ringkasan": produksi._summary(full["laporan"]), "deploy": full["deploy"]}
        job.update(status="succeeded", result=res, finished_at=_now())
    except Exception as e:  # noqa: BLE001 - the job records why it failed
        log.exception("ML job %s failed", job["id"])
        job.update(status="failed", error=str(e)[:3000], finished_at=_now())
        if job["kind"] == "produksi":
            from aip import produksi

            produksi.on_job_end(job, tmp / "out", None, str(e)[:3000])
    finally:
        _save_job(job)
        shutil.rmtree(tmp, ignore_errors=True)


def _register(job: dict, src: dict, out: Path, stage: Path, res: dict) -> dict:
    """A finished training: the version kept, the model version in the registry, the datasets in Files, the Nexus."""
    version = f"mlv-{uuid.uuid4().hex[:8]}"
    d = _dir() / "versions" / version
    d.mkdir(parents=True)
    for f in ("model.pkl", "klaim.parquet", "faskes.parquet", "fitur_klaim.parquet", "report.json"):
        shutil.copyfile(out / f, d / f)
    folder = _out_folder()
    items = {"klaim": _put_dataset(folder, DS_KLAIM, (out / "klaim.parquet").read_bytes(), src),
             "faskes": _put_dataset(folder, DS_FASKES, (out / "faskes.parquet").read_bytes(), src)}
    model = _publish_model(folder, stage, job, src, items)
    try:
        nexus = ensure_nexus(items)
    except Exception as e:  # noqa: BLE001 - the card and the agent's tools work from the version's files; the Nexus is a view
        log.exception("ML: Nexus types not updated")
        nexus = {"error": str(getattr(e, "detail", None) or e)[:500]}
    cur = {"version": version, "trained_at": _now(), "job": job["id"], "user_id": job.get("user_id"), "source_item": src["id"],
           "datasets": items, "model": model, "nexus": nexus, "summary": res.get("summary")}
    _write(_dir() / "current.json", cur)
    return {**res, "version": version, "datasets": items, "model": model, "nexus": nexus}


def _put_dataset(folder: str, name: str, data: bytes, src: dict) -> str:
    """A dataset written (new or replaced) with the source's markings, and a dataset version."""
    import auth
    import dataset_versions
    import drive
    import pipeline_datasets as pd_

    marks = set(auth.effective_markings(src["id"]))
    have = _child(folder, name)
    if have:
        pd_.widen_before_write(have["id"], marks)
        pd_._replace_content(have, data)
        item = drive._item(have["id"])
    else:
        item = drive._item(pd_.store_marked(folder, name, data, pd_.PARQUET, marks)["id"])
    dataset_versions.record(item["id"], data, "deploy", {"kind": "model", "id": "aip-ml", "name": MODEL_NAME, "mode": "snapshot"})
    return item["id"]


def _publish_model(folder: str, stage: Path, job: dict, src: dict, items: dict) -> dict:
    """The MLflow model staged by the job becomes the next version of the registry's model (Model registry, lineage)."""
    import db
    import drive
    import model_assets as ma

    name = drive._clean_name(MODEL_NAME)
    item = next((c for c in db.drive_list(folder) if c["name"] == name and not c.get("trashed_at")), None)
    rec = ma._by_item(item["id"]) if item else None
    if not rec:
        hexid = uuid.uuid4().hex[:12]
        body = json.dumps({"model_id": f"mdl-{hexid}"}).encode()
        item = item or drive._store(folder, name, io.BytesIO(body), len(body), ma.MODEL_TYPE)
        rec = {"id": f"mdl-{hexid}", "rid": ma.MODEL_RID + hexid, "name": name, "kind": "python", "item_id": item["id"], "created_at": _now(),
               "created_by": ma._me(), "versions": [], "source": {"kind": "aip", "repo": "AIP JKN · Agen Machine Learning"},
               "description": "Peluang klaim FKRTL dikoreksi verifikator BPJS, per segmen; dipilih dari benchmark teknik ML."}
        with ma._lock:
            ma._write(rec)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted((stage / "model").rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(stage / "model").as_posix())
    v = ma.add_version(rec, buf.getvalue(), "master", {"kind": "aip", "repo": "AIP JKN · Agen Machine Learning", "transform": "ml_klaim: benchmark + model terpilih",
                                                       "build": job["id"], "branch": "master"},
                       [{"item_id": src["id"], "name": src["name"]}], code=job.get("code"))
    with ma._lock:
        r = ma._read(rec["id"])
        for x in r.get("versions") or []:
            if x["id"] == v["id"]:
                x["outputs"] = [{"item_id": i, "name": n} for n, i in ((DS_KLAIM, items["klaim"]), (DS_FASKES, items["faskes"]))]
        ma._write(r)
    return {"model_id": rec["id"], "version": v["version"], "version_id": v["id"], "experiment_id": v.get("experiment_id"), "link": f"/model-assets/{rec['id']}"}


def ensure_nexus(items: dict) -> dict:
    """The group (the agent), the two types backed by the datasets (re-imported), their links to Profil Faskes."""
    import ontology
    import ontology_datasources as ods
    import ontology_model as om

    have = {g["name"]: g["id"] for g in om._groups()}
    gid = have.get(GROUP[0]) or om.create_group(om.GroupIn(name=GROUP[0], description=GROUP[1]))["id"]
    types = {}
    for key, (display, api, _ds, pk, title, icon, color, desc) in TYPES.items():
        t = next((x for x in ontology._all("object-types") if x["display_name"] == display), None)
        if not t:
            props = [ontology.Property(api_name=pk, display_name=pk.replace("_", " ").capitalize(), type="string", render_hints=["searchable", "identifier"]),
                     ontology.Property(api_name=title, display_name=title.replace("_", " ").capitalize(), type="string", render_hints=["searchable"])]
            t = ontology.create_object_type(ontology.ObjectTypeIn(display_name=display, plural_name=display, api_name=api, primary_key=pk, title_property=title,
                                                                   icon=icon, color=color, description=desc, properties=props, groups=[gid], status="active"))
        types[key] = t["id"]
        ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=items[key], columns=None, map_unmapped=True))
    names = {x.get("display_name") for x in ontology._all("link-types")}
    for name, src, fk, target, src_label, tgt_label in LINKS:
        tgt = next((x for x in ontology._all("object-types") if x["display_name"] == target), None)
        if name in names or not tgt:
            continue
        om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key=fk, status="active",
                                          source=om.LinkSide(object_type_id=types[src], display_name=src_label, plural_display_name=src_label),
                                          target=om.LinkSide(object_type_id=tgt["id"], display_name=tgt_label)))
    return {"group_id": gid, "types": types}


# ------------------------------------------------------------------------------------------------
# the job itself (python -m aip.ml job.json)
# ------------------------------------------------------------------------------------------------


def _main(path: str) -> None:
    spec = json.loads(Path(path).read_text("utf-8"))
    out = Path(spec["out"])
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    def say(m: str) -> None:
        print(f"[{time.time() - t0:6.0f}s] {m}", flush=True)

    try:
        run = {"train": _train, "bukti": _evidence, "sintetis": _rule2, "produksi": _production}.get(spec["kind"])
        res = run(spec, out, say) if run else _benchmark_only(spec, say)
        _capture_code(spec, out, say)
        (out / "result.json").write_text(json.dumps({"ok": True, **res}, default=float), "utf-8")
    except Exception as e:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        (out / "result.json").write_text(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"[:3000]}), "utf-8")


def _capture_code(spec: dict, out: Path, say: Any) -> None:
    """The code this job ran (code_provenance.capture: every source file loaded, with its hash and git state), the data
    it read and the environment, for the audit of the model; a failure here never fails the training."""
    try:
        import code_provenance

        kit = hkeval_dir()
        manifest = code_provenance.capture(f"python -m aip.ml job.json  (kind={spec['kind']})", params=spec.get("params"),
                                           data={"klaim_fkrtl (Data Bersih)": spec.get("source"), "wilayah": spec.get("wilayah")},
                                           seed=getattr(sys.modules.get("ml_klaim"), "SEED", None),
                                           external={"evaluation-kit": kit} if kit.is_dir() else None)
        code_provenance.write(manifest, out / "code_manifest.json")
        say(f"kode training dicatat: {len(manifest['files'])} file, sidik {manifest['fingerprint'][:12]}")
    except Exception as e:  # noqa: BLE001
        say(f"kode training tidak tercatat: {type(e).__name__}: {e}")


HKEVAL_COMMIT = "336bf7b4e46dae2e0e4495684c0aad037f0e1f56"  # github.com/Luche/healthkathon-eval-kit (Healthkathon 2026)
CAPACITY_NOTE = ("asumsi (bukan dari sumber publik): 0,1% klaim diaudit ulang secara mendalam; kapasitas = verifikator × kasus per "
                 "verifikator per hari × hari kerja, belum diisi dengan angka BPJS")


def hkeval_dir() -> Path:
    """The external evaluation kit, a checkout at HKEVAL_COMMIT (its source is named there; it has no license file, so it is used where it is,
    never copied into this repository)."""
    return Path(os.environ.get("BLUESANDAI_HKEVAL_DIR") or (_dir() / "hkeval-kit"))


# honest claims that look like fraud to a simple detector (the kit's checklist for health facilities), found in the
# real data; each is reported with how often it is flagged
HARD_NEGATIVES = [
    ("RS kelas A / tersier (keparahan dan LOS memang lebih tinggi)",
     lambda d, c: d["tipe_fkrtl"].isin(["RS Kelas A", "RS Swasta Setara Type A", "RS TNI Polri Kelas I"])),
    ("Rawat ulang yang sah: dialisis dan kemoterapi", lambda d, c: d["inacbg_kode"].isin(c["ulang"])),
    ("Diagnosis langka berbiaya tinggi", lambda d, c: (d["frek_dx"] < 50) & (d["biaya_tagih"] > c["p95"])),
    ("Faskes baru atau kecil (< 100 klaim)", lambda d, c: d["f_jumlah_klaim"] < 100),
    ("Masa wabah (edisi kontekstual COVID)", lambda d, c: d["edisi"] == "covid"),
]
# the targets registered before the kit ran on the full data (for the model of commit 511e022, v0.3.0): every card is
# checked against them by code, with the registered thresholds, and a missed one is reported as it is
PREREG = {"berkas": "docs/healthkathon/PRAREGISTRASI.md", "commit": "78c67c7", "detektor_saat_itu": "511e022 (model v0.3.0)"}


def _intervals(y: Any, s: Any, excess: Any, groups: Any, cap: float, n: int, seed: int = 0, level: float = 0.95) -> dict:
    """95% intervals for the headline numbers the kit's card prints without one (its evidence-slide template asks for
    them: lift, rupiah recall@k, the share of honest facility profiles audited; and recall@k), resampling whole facility
    profiles with the kit's own draws (metrics.bootstrap_distribution: same seed, same picks, so precision@k here equals
    the card's interval). A profile drawn twice counts as two profiles. All five from one pass per draw."""
    import numpy as np
    import pandas as pd
    from hkeval import metrics as HM

    y, s, e = np.asarray(y, int), np.asarray(s, float), np.asarray(excess, float)
    codes, _ = pd.factorize(np.asarray(groups))
    order = np.argsort(codes, kind="stable")
    counts = np.bincount(codes)
    starts = np.cumsum(counts) - counts
    rng = np.random.default_rng(seed)
    draws = {k: np.full(n, np.nan) for k in ("precision", "lift", "recall_at_k", "rupiah_recall", "honest_audit")}
    for b in range(n):
        picks = rng.integers(0, len(counts), len(counts))
        lengths = counts[picks]
        first = np.cumsum(lengths) - lengths
        idx = order[np.repeat(starts[picks] - first, lengths) + np.arange(lengths.sum())]
        yb, sb, eb = y[idx], s[idx], e[idx]
        top = HM.top_k(sb, cap)
        hit, pos = yb[top], yb.sum()
        draws["precision"][b] = hit.mean()
        if pos:
            draws["lift"][b] = hit.mean() / yb.mean()
            draws["recall_at_k"][b] = hit.sum() / pos
        if eb.sum() > 0:
            draws["rupiah_recall"][b] = eb[top].sum() / eb.sum()
        honest = np.maximum.reduceat(yb, first) == 0  # per drawn profile: its claims are one block
        flagged = np.zeros(len(picks), bool)
        flagged[np.searchsorted(first, top, side="right") - 1] = True
        if honest.any():
            draws["honest_audit"][b] = (flagged & honest).sum() / honest.sum()
    est = {"precision": HM.precision_at_k(y, s, cap), "lift": HM.lift_at_k(y, s, cap), "recall_at_k": HM.recall_at_k(y, s, cap),
           "rupiah_recall": HM.rupiah_recall_at_k(e, s, cap) if e.sum() > 0 else None,
           "honest_audit": HM.honest_group_audit_rate(y, s, np.asarray(groups), cap)["rate"]}
    alpha = (1.0 - level) / 2.0
    out: dict = {}
    for key, v in est.items():
        if v is None or np.isnan(draws[key]).all():
            out[key] = None
            continue
        lo, hi = np.nanquantile(draws[key], [alpha, 1.0 - alpha])
        out[key] = {"nilai": float(v), "bawah": float(lo), "atas": float(hi)}
    return out


def _leakage(con: Any, HS: Any) -> dict:
    """The kit's leakage scan (single-feature AUC of every column the models see, the id and the row order) on each
    task's evaluation sample. A column above the threshold is explained in numbers, not words, by the two patterns of
    where corrections happen: inpatient claims of a Klinik Utama (most corrections; gone on hospital claims) and, within
    hospitals, inpatient claims (gone within hospital inpatient claims). Explained = at most the threshold where the
    pattern is gone; `dijelaskan_klinik` keeps the first test alone (the preregistered target names only that one)."""
    import pandas as pd

    import ml_klaim as M

    T = HS.LEAK_THRESHOLD
    f3 = lambda v: f"{v:.3f}".replace(".", ",")  # noqa: E731

    def scan(ev: Any, label: Any) -> Any:
        feats = ev[["klaim_id", *M.FEATURES]].rename(columns={"klaim_id": "entity_id"})
        return HS.leakage_scan(feats, pd.DataFrame({"entity_id": ev["klaim_id"], "label": label}))

    ev = M.evaluation_set(con, "semua")
    klinik = ((ev["jenis_fkrtl"] != "Rumah sakit") & (ev["tingkat_pelayanan"] == "RITL")).astype(int)
    scans = {"semua": scan(ev, ev["y"])}
    rule = scan(ev, klinik).set_index("feature")["auc"]
    share_k = float(klinik[ev["y"] == 1].mean())
    rs = M.evaluation_set(con, "rumah_sakit")
    scans["rumah_sakit"] = scan(rs, rs["y"])
    inap = rs["tingkat_pelayanan"] == "RITL"
    inner = scan(rs[inap], rs.loc[inap, "y"]).set_index("feature")["auc"]
    share_i, claims_i = float(inap[rs["y"] == 1].mean()), float((rs["w"] * inap).sum() / rs["w"].sum())
    pattern_i = f"pola rawat inap ({share_i:.0%} koreksi rumah sakit adalah rawat inap, padahal rawat inap {claims_i:.0%} klaimnya), bukan kebocoran label"

    def why(r: float, i: float) -> str:
        if r <= T:
            return f"di klaim rumah sakit {f3(r)}: pola rawat inap klinik utama ({share_k:.0%} koreksi), bukan kebocoran label"
        if i <= T:
            return f"di klaim rumah sakit {f3(r)}, di rawat inap rumah sakit {f3(i)}: {pattern_i}"
        return f"di rawat inap rumah sakit pun {f3(i)}: belum dijelaskan"

    t = scans["semua"]
    t["auc_pola_klinik"] = t["feature"].map(rule)
    t["auc_rumah_sakit"] = t["feature"].map(scans["rumah_sakit"].set_index("feature")["auc"])
    t["auc_rs_rawat_inap"] = t["feature"].map(inner)
    t["dijelaskan_klinik"] = ~t["flagged"] | (t["auc_rumah_sakit"] <= T)
    t["dijelaskan"] = t["dijelaskan_klinik"] | (t["auc_rs_rawat_inap"] <= T)
    t["penjelasan"] = ["" if not f else f"AUC terhadap penanda rawat inap klinik utama {f3(a)}, " + why(r, i)
                       for f, a, r, i in zip(t["flagged"], t["auc_pola_klinik"], t["auc_rumah_sakit"], t["auc_rs_rawat_inap"])]
    h = scans["rumah_sakit"]
    h["auc_rs_rawat_inap"] = h["feature"].map(inner)
    h["dijelaskan"] = ~h["flagged"] | (h["auc_rs_rawat_inap"] <= T)
    h["penjelasan"] = ["" if not f else f"di rawat inap rumah sakit {f3(i)}: {pattern_i}" if i <= T else f"di rawat inap rumah sakit pun {f3(i)}: belum dijelaskan"
                       for f, i in zip(h["flagged"], h["auc_rs_rawat_inap"])]
    return scans


def _prereg_check(cards: dict, scans: dict, klinik: dict) -> list[dict]:
    """Every preregistered target (PREREG) against this evidence, by code, with its registered threshold."""
    rows: list[dict] = []

    def add(metrik: str, kartu: str, ambang: str, nilai: Any, lulus: Optional[bool], catatan: str = "") -> None:
        rows.append({"metrik": metrik, "kartu": kartu, "ambang": ambang, "nilai": nilai, "lulus": None if lulus is None else bool(lulus), "catatan": catatan})

    for name, p_min, lift_min, rp_min in (("semua", 0.40, 100, 0.25), ("rumah_sakit", 0.01, 50, 0.10)):
        c = cards[name]["kartu"]
        h = c["headline"]
        add("precision@k, batas bawah IK 95%", name, f"≥ {p_min:g}".replace(".", ","), h["precision_low"], h["precision_low"] >= p_min)
        add("lift dibanding acak pada k", name, f"≥ {lift_min}×", h["lift"], h["lift"] >= lift_min)
        rp = h.get("rupiah_recall")
        add("recall rupiah@k", name, f"≥ {rp_min:.0%}", rp, rp is not None and rp >= rp_min)
        rate = h["honest_audit"]["rate"]
        add("profil faskes tanpa koreksi yang ikut diaudit", name, "≤ 5%", rate, rate <= 0.05)
        over = sorted((s for s in c.get("strata") or [] if s["rate"] > 3 * rate), key=lambda s: -s["honest_groups"])
        add("strata dengan porsi diaudit > 3× rata-rata", name, "tidak ada", len(over), not over,
            "; ".join(f"{s['stratum']} {s['value']}: {s['flagged']} dari {s['honest_groups']}" for s in over[:5]) + (f"; +{len(over) - 5} lagi" if len(over) > 5 else ""))
        perm = c.get("permutation") or {}
        add("uji permutasi label (PR-AUC)", name, "p < 0,01", perm.get("p_value"), perm.get("p_value") is not None and perm["p_value"] < 0.01)
    add("ablasi: model vs aturan klinik utama rawat inap", "semua", "Δ precision@k ≥ 0, atau p ≥ 0,05 bila negatif", klinik["diff"],
        klinik["diff"] >= 0 or klinik["p_value"] >= 0.05, f"p = {klinik['p_value']:.3f}, uji berpasangan per faskes")
    m = next(r for r in cards["rumah_sakit"]["ablasi"] if r["variant"] == "Model ML")
    add("ablasi: model vs aturan yang ada (flag ganda / LOS ekstrem)", "rumah_sakit", "Δ precision@k > 0, p < 0,05", m["diff"],
        m["diff"] > 0 and m["p_value"] < 0.05, f"p = {m['p_value']:.3f}")
    t, r = scans["semua"], scans["rumah_sakit"]
    bad = t[t["flagged"] & ~t["dijelaskan_klinik"]]["feature"].tolist()  # (the registered target names the Klinik Utama pattern only)
    add("kebocoran: fitur AUC > 0,80 yang tidak dijelaskan pola klinik utama", "semua", "tidak ada", len(bad), not bad, ", ".join(bad))
    hit = r[r["flagged"]]["feature"].tolist()
    left = r[r["flagged"] & ~r["dijelaskan"]]["feature"].tolist()
    add("kebocoran: fitur AUC > 0,80", "rumah_sakit", "tidak ada", len(hit), not hit,
        ", ".join(hit) + (f"; setelah pola rawat inap masih belum dijelaskan: {', '.join(left)}" if left else "; semuanya dijelaskan pola rawat inap" if hit else ""))
    add("tinjauan ahli buta: % mencurigakan, ditandai − acak", "rumah_sakit", "≥ 20 poin persentase", None, None, "lembar dibuat, menunggu peninjau BPJS")
    add("recall@k per modus", "-", "tidak berlaku", None, None, "label nyata tanpa modus; per modus diuji di benchmark aturan 2")
    return rows


def _evidence(spec: dict, out: Path, say: Any) -> dict:
    """The model evidence: out-of-fold scores of the deployed setup for every claim, the kit's evidence card
    (Bahasa Indonesia) for all claims and for hospital claims, with the ablation against the rules (and the model ranked
    by expected value) and the permutation test, facility-resampled intervals for every headline number, ROC-AUC next to
    PR-AUC, the leakage scan per task, the hard negatives, the blind review sheet, and the preregistered targets checked."""
    import numpy as np
    import pandas as pd

    import ml_klaim as M

    sys.path.insert(0, spec["hkeval"])
    from hkeval import metrics as HM, report as HR, review as HV, stress as HS

    p = spec["params"]
    cap = float(p.get("kapasitas") or 0.001)
    n_boot = int(p.get("n_boot") or 1000)
    con = _features(spec, say)
    df = M.oof_population(con, spec["segments"], log=say)
    df["kelas"] = df["jenis_fkrtl"].astype(str) + " · " + df["tipe_fkrtl"].astype(str)
    df["wilayah"] = df["provinsi_nama"].fillna("tidak tercatat").astype(str)
    ulang = {c for (c,) in con.execute("SELECT DISTINCT inacbg_kode FROM k WHERE inacbg_deskripsi ILIKE '%DIALISIS%' "
                                       "OR inacbg_deskripsi ILIKE '%HEMODIALISA%' OR inacbg_deskripsi ILIKE '%KEMOTERAPI%'").fetchall()}
    p95 = float(df["biaya_tagih"].quantile(0.95))
    # (the kit adds a "synthetic data" limitation when the source text contains that word, so it is not used here)
    conditions = {"data_source": "sampel publik: Data Sampel BPJS Kesehatan 2025, data klaim nyata yang dianonimkan",
                  "benchmark": "label nyata 'dikoreksi verifikator BPJS' (flag_selisih_verifikasi) - positif berarti dikoreksi, bukan fraud "
                               "terbukti; skor out-of-fold, model tidak pernah melihat faskes yang dinilainya",
                  "generator_author": "tidak ada generator (data sampel BPJS)", "calibration_sources": "tidak berlaku: data nyata",
                  "seed": "0 (lipatan faskes)"}
    (out / "bukti").mkdir(parents=True, exist_ok=True)
    cards = {}
    for name, mask in (("semua", np.ones(len(df), bool)), ("rumah_sakit", (df["jenis_fkrtl"] == "Rumah sakit").to_numpy())):
        d = df[mask].reset_index(drop=True)
        rule = ((d["jenis_fkrtl"] != "Rumah sakit") & (d["tingkat_pelayanan"] == "RITL")).astype(float)
        flags = (d["flag_ganda"] + d["flag_los_ekstrem"]).astype(float)
        base = d[["klaim_id", "faskes_profil_id"]].rename(columns={"klaim_id": "entity_id", "faskes_profil_id": "group_id"})
        scores = base.assign(score=d["score"].to_numpy(), kelas=d["kelas"].to_numpy(), wilayah=d["wilayah"].to_numpy())
        truth = pd.DataFrame({"entity_id": d["klaim_id"], "label": d["y"].astype(int), "excess_rupiah": d["excess_rp"]})
        variants = {"Aturan yang ada (flag ganda / LOS ekstrem)": base.assign(score=flags + 1e-9 * d["score"].rank(pct=True))}
        if name == "semua":
            variants["Aturan klinik utama rawat inap"] = base.assign(score=rule + 1e-9 * flags)
            variants["Aturan + model"] = base.assign(score=rule + d["score"].to_numpy())
        variants["Model ML"] = scores[["entity_id", "group_id", "score"]]
        # what the queue ranks by is a policy choice (the kit's deck, slide 23): the same model, ranked by expected value
        variants["Model, urut nilai harapan (skor × tagihan)"] = base.assign(score=d["score"].to_numpy() * d["biaya_tagih"].fillna(0).to_numpy())
        say(f"bukti {name}: {len(d):,} klaim, {int(d['y'].sum())} terkoreksi, ablasi {len(variants)} varian")
        abl = HS.ablation(variants, truth, capacity=cap, n_boot=max(200, n_boot // 2))
        perm = HS.permutation_test(truth["label"].to_numpy(), scores["score"].to_numpy(), n=1000)
        perm.pop("null", None)
        card = HR.build_card(scores, truth, capacity=cap, strata=["kelas", "wilayah"], conditions=conditions, ablation=abl, permutation=perm,
                             entity_noun="klaim", group_noun="profil faskes", n_boot=n_boot)
        (out / "bukti" / f"bukti_{name}.html").write_text(HR.render_html(card, "id"), "utf-8")
        (out / "bukti" / f"bukti_{name}.md").write_text(HR.render_markdown(card, "id"), "utf-8")
        k = int(card["conditions"]["k"])
        flagged = np.zeros(len(d), bool)
        flagged[np.argsort(-d["score"].to_numpy(), kind="mergesort")[:k]] = True
        hard = []
        for label, pick in HARD_NEGATIVES:
            sel = pick(d, {"ulang": list(ulang), "p95": p95}).fillna(False).to_numpy(bool)
            if not sel.any():
                continue
            honest = sel & (d["y"].to_numpy() == 0)
            hard.append({"kelompok": label, "klaim": int(sel.sum()), "jujur": int(honest.sum()), "jujur_ditandai": int((honest & flagged).sum()),
                         "porsi_jujur_ditandai": float((honest & flagged).sum() / max(honest.sum(), 1)),
                         "porsi_ditandai_keseluruhan": float(flagged.mean())})
        y, s, g = d["y"].astype(int).to_numpy(), d["score"].to_numpy(), base["group_id"].astype(str).to_numpy()
        # the audit list itself, to count by hand: the k claims the card counts (the kit's own top_k) with their label
        audit = d.iloc[HM.top_k(s, cap)][["klaim_id", "faskes_profil_id", "kelas", "wilayah", "tingkat_pelayanan", "inacbg_kode", "biaya_tagih", "score", "y", "excess_rp"]]
        audit = audit.sort_values("score", ascending=False, kind="mergesort").rename(columns={"score": "skor", "y": "dikoreksi_verifikator", "excess_rp": "selisih_rp"})
        audit.insert(0, "peringkat", range(1, len(audit) + 1))
        audit.to_csv(out / "bukti" / f"daftar_audit_{name}.csv", index=False)
        say(f"bukti {name}: interval per faskes untuk lift, recall, recall rupiah dan faskes tanpa koreksi")
        cards[name] = {"kartu": HR.card_to_json(card), "kalimat_juri": HR.jury_sentence(card, "id"), "negatif_sulit": hard,
                       "ablasi": json.loads(abl.to_json(orient="records")),
                       "interval": _intervals(y, s, d["excess_rp"].fillna(0).to_numpy(), g, cap, n_boot),
                       "auc": {"roc_auc": HM.roc_auc(y, s), "pr_auc": HM.pr_auc(y, s)},
                       "daftar_audit": {"file": f"daftar_audit_{name}.csv", "klaim": len(audit), "dikoreksi": int(audit["dikoreksi_verifikator"].sum())}}
        if name == "semua":  # the registered target compares the model with the Klinik Utama rule directly
            klinik = HS.paired_test(y, (rule + 1e-9 * flags).to_numpy(), s, g, cap, n_boot=max(200, n_boot // 2))
        say(f"bukti {name}: {cards[name]['kalimat_juri'][:240]}")
    # the leakage scan: every column the models see, on each task's evaluation sample (AUC does not depend on the class balance)
    scans = _leakage(con, HS)
    leak, leak_rs = scans["semua"], scans["rumah_sakit"]
    # the blind review: top 20 flagged and 20 random hospital claims, case details only
    d = df[df["jenis_fkrtl"] == "Rumah sakit"].reset_index(drop=True)
    cases = d[["klaim_id", "tingkat_pelayanan", "kelas", "wilayah", "inacbg_kode", "dx_primer_icd3", "biaya_tagih"]].rename(columns={"klaim_id": "entity_id"})
    HV.make_review_sheet(cases, d[["klaim_id", "score"]].rename(columns={"klaim_id": "entity_id"}), k=20, n_random=20, seed=0, out_dir=out / "bukti" / "review")
    res = {"kapasitas": cap, "catatan_kapasitas": CAPACITY_NOTE, "kartu": cards, "kebocoran": json.loads(leak.head(15).to_json(orient="records")),
           "kebocoran_di_atas_0_8": json.loads(leak[leak["flagged"]].to_json(orient="records")),
           "kebocoran_rumah_sakit": json.loads(leak_rs.head(12).to_json(orient="records")),
           "praregistrasi": {**PREREG, "target": _prereg_check(cards, scans, klinik)}, "hkeval_commit": HKEVAL_COMMIT,
           "tidak_berlaku": {"placebo": "data nyata tidak punya versi tanpa fraud (tidak ada generator); plasebo dijalankan di benchmark aturan 2, "
                                        "pada klaim yang sama sebelum fraud ditanam",
                             "aturan_2_tahan_modus": "label nyata hanya 'dikoreksi verifikator', tanpa modus; modus yang ditahan dari pelatihan diuji di benchmark aturan 2"}}
    (out / "bukti" / "bukti.json").write_text(json.dumps(res, default=float, ensure_ascii=False), "utf-8")
    return {"bukti": {k: {"kalimat_juri": v["kalimat_juri"]} for k, v in cards.items()}}


def _production(spec: dict, out: Path, say: Any) -> dict:
    """The production pipeline's job stages (aip/produksi.py)."""
    from aip import produksi

    return produksi.run_job(spec, out, say)


def _rule2(spec: dict, out: Path, say: Any) -> dict:
    """The kit's benchmark rule 2: fraud planted in real hospital claims (ml_sintetis, its spec committed before any
    detector output was seen), one dial at a time, each type held out once; evidence card per condition."""
    import ml_sintetis as G

    con = _con(spec["source"], Path(spec["out"]).parent / "work", spec.get("wilayah"))
    res = G.run(con, spec["hkeval"], out / "aturan2", say, n_boot=int(spec["params"].get("n_boot") or 300))
    return {"aturan2": {c: {"frekuensi": r["frekuensi"], "precision_at_k": r["kartu"]["headline"]["precision"], "lift": r["kartu"]["headline"]["lift"],
                            "pr_auc": r["pr_auc"]} for c, r in res["kondisi"].items()},
            "tahan": {m: {"recall_at_k": r["recall_at_k"], "acak": r["acak_k_per_n"]} for m, r in res["tahan"].items()}}


def _features(spec: dict, say: Any) -> Any:
    """A DuckDB connection with `k` (the silver claims) and `fitur` (every claim's features). The feature table comes
    from the cache when a job already built it for this version of the source; otherwise this job builds it under a
    lock (parallel technique jobs wait for it instead of each building their own)."""
    import ml_klaim as M

    work = Path(spec["out"]).parent / "work"
    con = _con(spec["source"], work, spec.get("wilayah"))
    if not spec.get("cache"):
        M.prepare(con, "k", say, spill=str(work))
        return con
    cache = Path(spec["cache"])
    cache.mkdir(parents=True, exist_ok=True)
    f = cache / f"fitur-{spec['source_key']}-v{M.FEATURES_VERSION}.parquet"
    lock = f.with_suffix(".lock")
    while not f.exists():
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            if time.time() - lock.stat().st_mtime > 1800:  # a job that died while building
                lock.unlink(missing_ok=True)
            say("menunggu tabel fitur yang sedang dibuat job lain")
            time.sleep(5)
            continue
        try:
            M.prepare(con, "k", say, spill=str(work))
            tmp = f.with_name(f.name + f".{os.getpid()}.tmp")
            shutil.copyfile(work / "fitur.parquet", tmp)
            tmp.replace(f)
            say("tabel fitur disimpan ke cache")
            return con
        finally:
            lock.unlink(missing_ok=True)
    con.execute(f"CREATE OR REPLACE VIEW fitur AS SELECT * FROM read_parquet('{f.as_posix()}')")
    say(f"fitur dari cache ({f.name})")
    return con


def _con(source: str, work: Path, wilayah: Optional[str] = None) -> Any:
    """DuckDB with a memory ceiling and a spill folder: the job shares the machine with the API. `k` is the silver
    claims, `wilayah` kab/kota → province (code, name): the gold dimension in the 38-province coding, or without it
    the BPS prefix of the kab/kota and the claims' own names (34 provinces)."""
    import duckdb

    (work / "duckdb").mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET memory_limit = '6GB'")
    con.execute(f"SET temp_directory = '{(work / 'duckdb').as_posix()}'")
    con.execute(f"CREATE VIEW k AS SELECT * FROM read_parquet('{Path(source).as_posix()}')")
    if wilayah:
        con.execute(f"CREATE VIEW wilayah AS SELECT kabkota_kode, provinsi_kode, provinsi_nama FROM read_parquet('{Path(wilayah).as_posix()}')")
    else:
        con.execute("""CREATE VIEW wilayah AS SELECT kabkota_fkrtl_kode AS kabkota_kode, any_value(kabkota_fkrtl_kode // 100) AS provinsi_kode,
                       mode(provinsi_fkrtl) AS provinsi_nama FROM k GROUP BY 1""")
    return con


def _board_summary(res: dict) -> list[dict]:
    """The leaderboard without the per-fold rows: what the card, the agent and MLflow show."""
    return [{**{k: r.get(k) for k in ("model", "keluarga", "rujukan", "pembanding", "rata", "gabungan_oof", "detik_latih", "riset", "menang", "dari",
                                      "uji_vs_terbaik")},
             "auprc_lipatan": [[f["ulangan"], f["lipatan"], f["auprc"]] for f in r.get("lipatan") or [] if "ulangan" in f]} for r in res["papan"]]


def _benchmark_only(spec: dict, say: Any) -> dict:
    import ml_klaim as M

    p = spec["params"]
    con = _features(spec, say)
    task = p.get("tugas") or "rumah_sakit"
    data = M.evaluation_set(con, task)
    if p.get("provinsi_kode"):  # the facilities of a province (38-province coding: by the kab/kota of the facility profile)
        ids = con.execute(f"SELECT DISTINCT {M.PROFILE_ID} FROM k JOIN wilayah w ON w.kabkota_kode = k.kabkota_fkrtl_kode WHERE w.provinsi_kode = ?",
                          [int(p["provinsi_kode"])]).fetchall()
        data = data[data["faskes_profil_id"].isin({r[0] for r in ids})]
    say(f"set evaluasi: {len(data):,} klaim, {int(data['y'].sum())} terkoreksi, {data['faskes_profil_id'].nunique()} profil faskes")
    if data["y"].sum() < 20:
        raise ValueError(f"hanya {int(data['y'].sum())} klaim terkoreksi di cakupan ini: terlalu sedikit untuk benchmark yang andal (minimal 20)")
    refs = [r for r in M.REFERENCES if task == "semua" or "klinik" not in r] if p.get("pembanding", True) else []
    res = M.benchmark(data, models=p.get("model") or None, folds=int(p.get("lipatan") or 3), log=say, references=refs,
                      repeats=int(p.get("ulangan") or 1))
    oof = res.pop("oof", None) or {}
    out = {"tugas": task, "tugas_label": M.TASKS[task][0], "papan": _board_summary(res), "evaluasi": res["evaluasi"], "lipatan": res["lipatan"],
           "riset_protokol": M.PROTOCOL_RESEARCH, "ulangan": res["ulangan"], "n_latih": int(len(data) * (1 - 1 / res["lipatan"])),
           "n_uji": int(len(data) / res["lipatan"]), "detik": res["detik"], "cakupan": {"provinsi_kode": p.get("provinsi_kode")}}
    if int(p.get("faskes_teratas") or 0):
        out["faskes_teratas"] = {n: _top_facilities(data, s, int(p["faskes_teratas"])) for n, s in oof.items() if n not in M.REFERENCES}
    return out


def _top_facilities(data: Any, score: Any, n: int, share: float = 0.01, min_claims: int = 200) -> list[dict]:
    """The facilities a technique flags most: its out-of-fold scores' top `share` of the (weighted) population is
    flagged, and facilities (>= min_claims weighted claims) are ranked by their weighted flagged claims."""
    import numpy as np
    import pandas as pd

    s = np.asarray(score, float)
    ok = ~np.isnan(s)
    w = data["w"].to_numpy(float)
    order = np.argsort(-np.where(ok, s, -np.inf), kind="mergesort")
    cw = np.cumsum(w[order])
    flagged = np.zeros(len(s), bool)
    flagged[order[cw <= cw[-1] * share]] = True
    df = pd.DataFrame({"f": data["faskes_profil_id"].to_numpy(), "w": w, "fw": w * flagged, "y": data["y"].to_numpy()})
    agg = df.groupby("f").agg(klaim=("w", "sum"), ditandai=("fw", "sum"), koreksi=("y", "sum"))
    agg = agg[(agg["klaim"] >= min_claims) & (agg["ditandai"] > 0)]
    agg["per_1000"] = agg["ditandai"] / agg["klaim"] * 1000
    top = agg.sort_values(["ditandai", "per_1000"], ascending=False).head(n)
    return [{"faskes_profil_id": str(f), "ditandai": round(float(r["ditandai"]), 1), "klaim": int(round(r["klaim"])), "per_1000": round(float(r["per_1000"]), 2),
             "koreksi": int(r["koreksi"])} for f, r in top.iterrows()]


def _train(spec: dict, out: Path, say: Any) -> dict:
    import pickle

    import numpy as np

    import ml_klaim as M

    p = spec["params"]
    con = _features(spec, say)
    report: dict[str, Any] = {"tugas": {}, "protokol": M.__doc__.split("The benchmark (benchmark()):")[1].strip() if M.__doc__ else "",
                              "dibuat": _now(), "label": {"nama": "flag_selisih_verifikasi", "keterangan": "klaim yang dibayar kurang dari tagihan oleh verifikator BPJS"},
                              "riset_protokol": M.PROTOCOL_RESEARCH, "riset_model": M.RESEARCH, "riset_penjelas": M.EXPLAINER_RESEARCH,
                              "fitur": {"jumlah": len(M.FEATURES), "numerik": M.NUM, "kategori": M.CAT_LOW,
                                        "arti": {c: M.LABELS.get(c, c) for c in M.FEATURES}}}
    segments: dict[str, dict] = {}
    for task in ("rumah_sakit", "semua"):
        data = M.evaluation_set(con, task)
        say(f"[{task}] set evaluasi: {len(data):,} klaim, {int(data['y'].sum())} terkoreksi")
        refs = [r for r in M.REFERENCES if task == "semua" or "klinik" not in r]
        res = M.benchmark(data, models=p.get("model") or None, folds=int(p.get("lipatan") or 5), log=lambda m, t=task: say(f"[{t}] {m}"), references=refs,
                          repeats=int(p.get("ulangan") or 3))
        res.pop("oof", None)
        best = next(r["model"] for r in res["papan"] if not r["pembanding"])
        temporal = M.temporal_check(data, [best, "Regresi logistik"], log=lambda m, t=task: say(f"[{t}] {m}"))
        ablation = M.ablation_undersampling(data, best, log=lambda m, t=task: say(f"[{t}] {m}"))
        # explainers and global importance on the chosen model, on facilities it never trained on
        from sklearn.model_selection import GroupKFold

        tr, te = next(GroupKFold(n_splits=5).split(data, data["y"], data["faskes_profil_id"]))
        fit_df = M._train_part(data.iloc[tr], np.random.default_rng(M.SEED))
        enc = M.Encoder().fit(fit_df)
        model, (s_te,), _ = M.fit_predict(best, fit_df, [data.iloc[te]], enc)
        test = data.iloc[te].assign(s=s_te)
        cases = test[test["y"] == 1].sort_values("s", ascending=False).head(30)
        expl = M.explainer_benchmark(best, model, enc, fit_df, cases, log=say) if best not in ("Regresi logistik", "MLP") else None
        importance = M.global_importance(best, model, enc, test) if best not in ("Regresi logistik", "MLP") else []
        # the operating point: the share of claims the validated thresholds flagged (median over folds), kept between
        # 0.01 % and 1 % of claims (a fold with almost no positives can choose a threshold of zero)
        flag_share = float(np.clip(np.median([f["ditandai_per_1jt"] for f in next(r for r in res["papan"] if r["model"] == best)["lipatan"]]) / 1e6,
                                   1e-4, 1e-2))
        report["tugas"][task] = {"label": M.TASKS[task][0], "papan": _board_summary(res), "lipatan_per_model": {r["model"]: r["lipatan"] for r in res["papan"]},
                                 "ulangan": res["ulangan"], "lipatan": res["lipatan"], "uji": res["uji"],
                                 "evaluasi": res["evaluasi"], "terbaik": best, "temporal": temporal, "penjelas": expl, "kepentingan_global": importance,
                                 "ablasi_undersampling": ablation,
                                 "porsi_ditandai": flag_share}
        say(f"[{task}] terbaik: {best}")
    for seg, (task, _sql) in M.SEGMENTS.items():
        best = report["tugas"][task]["terbaik"]
        abl = report["tugas"][task].get("ablasi_undersampling") or []
        share = max(abl, key=lambda r: r["auprc"])["porsi_negatif_latih"] if abl else M.TRAIN_NEG
        segments[seg] = M.fit_final(con, task, best, neg_share=share)
        segments[seg]["share"] = report["tugas"][task]["porsi_ditandai"]
        say(f"model akhir {seg}: {best}, {segments[seg]['train_rows']:,} baris latih")

    klaim, fas, fitur_top = score_all(con, segments, say)

    klaim.to_parquet(out / "klaim.parquet", index=False)
    fas.to_parquet(out / "faskes.parquet", index=False)
    fitur_top.to_parquet(out / "fitur_klaim.parquet", index=False)
    bundle = {"segments": segments, "labels": M.LABELS, "features": M.FEATURES}
    (out / "model.pkl").write_bytes(pickle.dumps(bundle))
    report["segmen"] = {s: {"model": v["name"], "tugas": v["task"], "ambang": v["threshold"], "porsi_ditandai": v["share"], "porsi_negatif_latih": v["neg_share"],
                            "baris_latih": v["train_rows"], "positif_latih": v["train_positives"]} for s, v in segments.items()}
    report["keluaran"] = {"klaim": len(klaim), "ditandai": int(klaim["ditandai"].sum()), "lolos_verifikasi_berisiko": int(klaim["lolos_verifikasi_berisiko"].sum()),
                          "faskes": len(fas)}
    (out / "report.json").write_text(json.dumps(report, default=float, ensure_ascii=False), "utf-8")
    _mlflow(spec, report, bundle, fitur_top, say)
    summary = {t: {"terbaik": r["terbaik"], **{k: next(x for x in r["papan"] if x["model"] == r["terbaik"])["rata"][k]["mean"]
                                               for k in ("auroc", "auprc", "f1", "presisi", "recall")}} for t, r in report["tugas"].items()}
    return {"summary": summary, "keluaran": report["keluaran"]}


def score_all(con: Any, segments: dict, say: Any, fixed: bool = False, dist: Optional[dict] = None) -> tuple[Any, Any, Any]:
    """Every claim of `fitur` scored, segment by segment: (claims kept for the dataset, facilities, the riskiest claims'
    features). Training sets each segment's threshold so the validated share of claims is above it; production
    (`fixed`) keeps the deployed threshold. `dist` receives each segment's scores (the production pipeline's drift check)."""
    import numpy as np
    import pandas as pd

    import ml_klaim as M

    dist = {} if dist is None else dist
    # every claim scored, segment by segment; thresholds put the validated share of claims above them
    cols = list(dict.fromkeys(M.ID_COLS + M.SHOWN + M.columns_of(segments)))  # each model its own columns (production: the deployed one)
    keep_cols = ["klaim_id", "faskes_profil_id", "tgl_datang", "dx_primer_icd3", "inacbg_kode", "y", "tingkat_pelayanan", "jenis_fkrtl", "tipe_fkrtl",
                 "provinsi_kode", "biaya_tagih", "tarif_inacbg", "los", "inacbg_keparahan", "segmen", "segmen_model"]
    tops, aggs, feats_top = [], [], []
    for seg, (task, sql) in M.SEGMENTS.items():
        reader = con.execute(f"SELECT {', '.join(cols)} FROM fitur WHERE {sql}").to_arrow_reader(500_000)
        scores, parts = [], []
        for batch in reader:
            df = batch.to_pandas()
            df["risiko"] = M.predict(segments[seg], df)
            df["segmen_model"] = seg  # ("segmen" is the patient's segment, a feature)
            scores.append(df["risiko"].to_numpy())
            parts.append(df[keep_cols + ["risiko"]].nlargest(20_000, "risiko"))
            parts.append(df.loc[df["y"] == 1, keep_cols + ["risiko"]])
            aggs.append(df.groupby("faskes_profil_id").agg(klaim=("y", "size"), koreksi_aktual=("y", "sum"), ekspektasi_koreksi=("risiko", "sum"),
                                                           jenis_fkrtl=("jenis_fkrtl", "first"), tipe_fkrtl=("tipe_fkrtl", "first"),
                                                           provinsi_kode=("provinsi_kode", "first")).reset_index().assign(segmen_model=seg))
            feats_top.append(df.nlargest(5_000, "risiko")[cols + ["risiko", "segmen_model"]])
        allp = np.concatenate(scores)
        if fixed:  # production: the threshold the model was deployed with
            thr = segments[seg]["threshold"]
        else:  # training: the validated share of claims above it
            thr = float(np.quantile(allp, 1 - max(segments[seg]["share"], 1e-5)))
            segments[seg]["threshold"] = thr
        dist[seg] = allp
        say(f"{seg}: {len(allp):,} klaim dinilai, ambang {thr:.4f} (porsi ditandai {segments[seg]['share'] * 100:.3f}%), {int((allp >= thr).sum()):,} ditandai")
        cand = pd.concat(parts).drop_duplicates("klaim_id").sort_values("risiko", ascending=False)
        cand["peringkat_segmen"] = np.arange(1, len(cand) + 1)
        # kept: the segment's 20,000 riskiest claims, every flagged one and every corrected one (a Nexus type indexes
        # at most 50,000 objects)
        top = cand[(cand["peringkat_segmen"] <= KEEP_TOP) | (cand["risiko"] >= thr) | (cand["y"] == 1)]
        tops.append(top)
    klaim = pd.concat(tops, ignore_index=True)
    thr_of = {s: segments[s]["threshold"] for s in segments}
    klaim["ditandai"] = klaim["risiko"] >= klaim["segmen_model"].map(thr_of)
    klaim["tingkat_risiko"] = np.where(klaim["ditandai"], "tinggi", np.where(klaim["peringkat_segmen"] <= KEEP_TOP, "sedang", "rendah"))
    klaim["sudah_dikoreksi"] = klaim["y"] == 1
    klaim["lolos_verifikasi_berisiko"] = klaim["ditandai"] & ~klaim["sudah_dikoreksi"]
    klaim["risiko_pct"] = (100 * klaim["risiko"]).round(3)
    # reasons for the claims a person will read first (TreeSHAP of the segment's model)
    fitur_top = pd.concat(feats_top, ignore_index=True).drop_duplicates("klaim_id")
    klaim["alasan_utama"] = ""
    klaim["alasan_json"] = ""
    for seg in segments:
        rows = fitur_top[fitur_top["segmen_model"] == seg].nlargest(2000, "risiko")
        if not len(rows):
            continue
        rs = M.reasons(segments[seg], rows)
        txt = dict(zip(rows["klaim_id"], [M.reason_text(r) for r in rs]))
        js = dict(zip(rows["klaim_id"], [json.dumps(r, ensure_ascii=False) for r in rs]))
        m = klaim["klaim_id"].isin(txt)
        klaim.loc[m, "alasan_utama"] = klaim.loc[m, "klaim_id"].map(txt)
        klaim.loc[m, "alasan_json"] = klaim.loc[m, "klaim_id"].map(js)
    klaim["judul"] = klaim["klaim_id"] + " · " + klaim["inacbg_kode"].astype(str)
    klaim = klaim.drop(columns=["y"])
    say(f"skor klaim: {len(klaim):,} baris ({int(klaim['ditandai'].sum()):,} ditandai, {int(klaim['lolos_verifikasi_berisiko'].sum()):,} berisiko tinggi lolos verifikasi)")

    fas = pd.concat(aggs).groupby(["faskes_profil_id", "segmen_model"], as_index=False).agg(
        klaim=("klaim", "sum"), koreksi_aktual=("koreksi_aktual", "sum"), ekspektasi_koreksi=("ekspektasi_koreksi", "sum"),
        jenis_fkrtl=("jenis_fkrtl", "first"), tipe_fkrtl=("tipe_fkrtl", "first"), provinsi_kode=("provinsi_kode", "first"))
    flagged = klaim[klaim["ditandai"]].groupby("faskes_profil_id").agg(klaim_ditandai=("klaim_id", "size"),
                                                                        berisiko_lolos_verifikasi=("lolos_verifikasi_berisiko", "sum"))
    fas = fas.join(flagged, on="faskes_profil_id").fillna({"klaim_ditandai": 0, "berisiko_lolos_verifikasi": 0})
    fas["ekspektasi_koreksi"] = fas["ekspektasi_koreksi"].round(2)
    fas["rasio_aktual_ekspektasi"] = (fas["koreksi_aktual"] / fas["ekspektasi_koreksi"].where(fas["ekspektasi_koreksi"] > 0)).round(2)
    fas["risiko_per_1000_klaim"] = (1000 * fas["ekspektasi_koreksi"] / fas["klaim"]).round(3)
    # the facility's province from `wilayah` (38-province coding): the provinsi_kode carried so far is the model's feature
    names = con.execute(f"""SELECT {M.PROFILE_ID} AS faskes_profil_id,
        any_value(concat_ws(' · ', 'FKRTL', jenis_fkrtl, tipe_fkrtl, kepemilikan_fkrtl, kabkota_fkrtl)) AS nama_profil,
        any_value(w.provinsi_nama) AS provinsi, any_value(kabkota_fkrtl) AS kabkota, any_value(w.provinsi_kode) AS provinsi_kode
        FROM k LEFT JOIN wilayah w ON w.kabkota_kode = k.kabkota_fkrtl_kode GROUP BY 1""").df()
    prov = names.set_index("faskes_profil_id")["provinsi_kode"]
    fas["provinsi_kode"] = fas["faskes_profil_id"].map(prov).astype("Int32")
    klaim["provinsi_kode"] = klaim["faskes_profil_id"].map(prov).astype("Int32")
    names = names.drop(columns="provinsi_kode")
    fas = fas.merge(names, on="faskes_profil_id", how="left").sort_values("ekspektasi_koreksi", ascending=False)
    fas["peringkat"] = np.arange(1, len(fas) + 1)
    klaim = klaim.merge(names[["faskes_profil_id", "nama_profil", "provinsi"]], on="faskes_profil_id", how="left")
    return klaim, fas, fitur_top


def _mlflow(spec: dict, report: dict, bundle: dict, fitur_top: Any, say: Any) -> None:
    """The run's parameters, metrics and tables in MLflow, and the model published (staged for the registry)."""
    import pandas as pd

    import ml_klaim as M
    import model_lib

    model_lib.STATE.update({"stage": spec["stage"], "mode": "build", "outputs": []})
    model_lib._mlflow_build_store()
    import mlflow

    with mlflow.start_run(run_name="benchmark-dan-model-risiko-klaim"):
        mlflow.log_params({"label": "flag_selisih_verifikasi", "validasi": "5-fold dikelompokkan per profil faskes", "sampel_negatif": f"1/{M.NEG_SAMPLE}",
                           "latih_negatif": M.TRAIN_NEG, "fitur": len(M.FEATURES),
                           **{f"model_{s}": v["model"] for s, v in report["segmen"].items()}})
        for task, r in report["tugas"].items():
            for row in r["papan"]:
                slug = re.sub(r"[^a-z0-9]+", "_", row["model"].lower()).strip("_")
                for k in ("auroc", "auprc", "f1", "presisi", "recall", "akurasi", "akurasi_seimbang", "presisi_top_0_1pct", "lift_top_0_1pct"):
                    if k in row["rata"]:
                        mlflow.log_metric(f"{task}/{slug}/{k}", float(row["rata"][k]["mean"]))
            mlflow.log_table(pd.DataFrame([{"model": x["model"], **{k: v["mean"] for k, v in x["rata"].items()}} for x in r["papan"]]), f"papan_{task}.json")
            if r.get("penjelas"):
                mlflow.log_table(pd.DataFrame(r["penjelas"]["metode"]), f"penjelas_{task}.json")
            if r.get("kepentingan_global"):
                mlflow.log_table(pd.DataFrame(r["kepentingan_global"]), f"kepentingan_{task}.json")
        example = fitur_top[M.FEATURES + ["jenis_fkrtl"]].head(20)
        model_lib.WritableModel("model", model_lib.ModelOutput(f"{OUT_FOLDER}/{MODEL_NAME}")).publish(M.RisikoKlaimModel(bundle["segments"]), input_example=example)
    say("MLflow: run dan model dicatat")


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


@router.get("")
def card() -> dict:
    """The model card (needs read access to the silver claims)."""
    _source()
    cur = current()
    if not cur:
        return {"status": "belum dilatih", "jobs": _recent_jobs()}
    rep = _read(_dir() / "versions" / cur["version"] / "report.json", {})
    for t in (rep.get("tugas") or {}).values():
        t.pop("lipatan_per_model", None)
    bukti = _read(_dir() / "versions" / cur["version"] / "bukti" / "bukti.json")
    return {"status": "siap", **cur, "laporan": rep, "bukti": bukti, "aturan2": _read(_dir() / "aturan2" / "aturan2.json"), "jobs": _recent_jobs()}


def _recent_jobs() -> list[dict]:
    out = []
    for f in sorted((_dir() / "jobs").glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:8]:
        j = _read(f, {})
        out.append({k: j.get(k) for k in ("id", "kind", "status", "created_at", "finished_at", "error")})
    return out


class TrainIn(BaseModel):
    model: Optional[list[str]] = None
    lipatan: int = Field(5, ge=3, le=10)
    ulangan: int = Field(3, ge=1, le=5)


@router.post("/train")
def train(req: TrainIn) -> dict:
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "melatih model ML dan menulis datasetnya butuh admin")
    _check_models(req.model)
    return _public(_start("train", req.model_dump()))


class BenchIn(BaseModel):
    tugas: str = Field("rumah_sakit", pattern="^(rumah_sakit|semua)$")
    model: Optional[list[str]] = None
    lipatan: int = Field(3, ge=2, le=10)
    ulangan: int = Field(1, ge=1, le=5)
    provinsi_kode: Optional[int] = Field(None, ge=11, le=99)
    pembanding: bool = True  # the reference rows (rules, Isolation Forest); a sub-agent's single-technique job leaves them out
    faskes_teratas: int = Field(0, ge=0, le=50)  # also the facilities each technique flags most out-of-fold (the consultancy's consensus)


def _check_models(names: Optional[list[str]]) -> None:
    import ml_klaim as M

    bad = [n for n in names or [] if n not in M.MODELS]
    if bad:
        raise HTTPException(400, f"model tidak dikenal: {', '.join(bad)}; pilihan: {', '.join(M.MODELS)}")


@router.post("/benchmark")
def benchmark(req: BenchIn) -> dict:
    _check_models(req.model)
    return _public(_start("benchmark", req.model_dump()))


def _public(job: dict) -> dict:
    return {k: job.get(k) for k in ("id", "kind", "status", "params", "created_at", "finished_at", "log", "result", "error", "code")}


def _register_evidence(job: dict, out: Path, res: dict) -> dict:
    """The evidence files go next to the model version they were computed for."""
    cur = current()
    if not cur or cur["version"] != job["extra"]["version"]:
        raise RuntimeError("versi model berganti selama job bukti berjalan; jalankan ulang")
    dest = _dir() / "versions" / cur["version"] / "bukti"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(out / "bukti", dest)
    return res


class EvidenceIn(BaseModel):
    kapasitas: float = Field(0.001, gt=0, le=0.2)
    n_boot: int = Field(1000, ge=200, le=5000)


@router.post("/bukti")
def evidence(req: EvidenceIn) -> dict:
    """The evidence card (the external evaluation kit at HKEVAL_COMMIT) for the current model: admin only."""
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "membuat kartu bukti butuh admin")
    cur = current()
    if not cur:
        raise HTTPException(409, "model ML belum dilatih")
    kit = hkeval_dir()
    if not (kit / "hkeval" / "report.py").is_file():
        raise HTTPException(503, f"kit evaluasi eksternal belum ada di {kit} (checkout commit {HKEVAL_COMMIT[:7]}; sumbernya di aip/ml.py HKEVAL_COMMIT)")
    rep = _read(_dir() / "versions" / cur["version"] / "report.json", {})
    segments = {s: {"task": v["tugas"], "name": v["model"], "neg_share": v.get("porsi_negatif_latih", 0.3)} for s, v in (rep.get("segmen") or {}).items()}
    return _public(_start("bukti", req.model_dump(), {"segments": segments, "hkeval": str(kit), "version": cur["version"]}))


class CompareIn(BaseModel):
    job_ids: list[str] = Field(..., min_length=2, max_length=12)


@router.post("/bandingkan")
def compare(req: CompareIn) -> dict:
    """Techniques benchmarked in separate jobs (an ML agent's sub-agents), compared as one leaderboard: the jobs must
    share task, folds, repeats and scope, so their splits are the same and the per-fold AUPRCs pair up; the best is
    tested against each other with the corrected resampled t-test, and each technique's wins are counted."""
    import numpy as np

    import ml_klaim as M

    jobs = [get_job(j) for j in req.job_ids]
    bad = [j["id"] for j in jobs if j["kind"] != "benchmark" or j["status"] != "succeeded"]
    if bad:
        raise HTTPException(409, f"job belum selesai atau bukan benchmark: {', '.join(bad)}")
    keys = {(j["params"].get("tugas"), j["params"].get("lipatan"), j["params"].get("ulangan"), j["params"].get("provinsi_kode")) for j in jobs}
    if len(keys) > 1:
        raise HTTPException(400, "job dijalankan dengan tugas, lipatan, ulangan atau cakupan berbeda: lipatannya tidak berpasangan")
    rows = {}
    for j in jobs:
        for r in j["result"]["papan"]:
            if not r.get("pembanding"):
                rows[r["model"]] = {**r, "job": j["id"], "folds": {(u, f): a for u, f, a in r.get("auprc_lipatan") or []}}
    if len(rows) < 2:
        raise HTTPException(400, "perlu setidaknya dua teknik")
    board = sorted(rows.values(), key=lambda r: -r["rata"]["auprc"]["mean"])
    best = board[0]
    splits = sorted(set().union(*(r["folds"] for r in board)))
    wins = {r["model"]: 0 for r in board}
    for s in splits:
        have = [r for r in board if s in r["folds"]]
        if have:
            wins[max(have, key=lambda r: r["folds"][s])["model"]] += 1
    res0 = jobs[0]["result"]
    for r in board:
        r["menang"], r["dari"] = wins[r["model"]], len(splits)
        if r is not best:
            common = [s for s in splits if s in best["folds"] and s in r["folds"]]
            diffs = [best["folds"][s] - r["folds"][s] for s in common]
            t, pv = M.corrected_ttest(diffs, res0.get("n_latih") or 1, res0.get("n_uji") or 1)
            r["uji_vs_terbaik"] = {"selisih_auprc": float(np.mean(diffs)) if diffs else None, "t": t, "p": pv, "berbeda_nyata": bool(pv < 0.05),
                                   "pasangan": len(common)}
    for r in board:  # (only now: the best one's folds are read by every comparison above)
        r.pop("folds", None)
    task, folds, repeats, prov = next(iter(keys))
    return {"tugas": task, "tugas_label": M.TASKS[task][0], "lipatan": folds, "ulangan": repeats, "cakupan": {"provinsi_kode": prov},
            "evaluasi": res0.get("evaluasi"), "papan": board, "uji": "t-test resampel terkoreksi (Nadeau dan Bengio 2003) atas AUPRC berpasangan per lipatan"}


EVIDENCE_FILES = {"bukti_semua.html", "bukti_semua.md", "bukti_rumah_sakit.html", "bukti_rumah_sakit.md", "bukti.json", "review/review_sheet.csv",
                  "daftar_audit_semua.csv", "daftar_audit_rumah_sakit.csv"}


@router.get("/bukti/{name:path}")
def evidence_file(name: str):
    """An evidence file of the current version; the review key (which cases were flagged) only for an admin."""
    from fastapi.responses import FileResponse
    import auth

    _source()
    p = auth.current() or {}
    if name == "review/review_key.csv" and (not auth.enabled() or p.get("role") == "admin"):
        pass
    elif name not in EVIDENCE_FILES:
        raise HTTPException(404, "berkas bukti tidak dikenal")
    cur = current()
    f = _dir() / "versions" / (cur or {}).get("version", "-") / "bukti" / name
    if not f.is_file():
        raise HTTPException(404, "kartu bukti belum dibuat untuk versi ini (POST /api/aip/ml/bukti)")
    media = {".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json", ".csv": "text/csv; charset=utf-8"}
    return FileResponse(f, media_type=media[f.suffix], headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"})


class Rule2In(BaseModel):
    n_boot: int = Field(300, ge=100, le=2000)


@router.post("/aturan2")
def rule2(req: Rule2In) -> dict:
    """The kit's benchmark rule 2 (planted fraud, three dials, held-out types): admin only, about an hour."""
    import auth

    p = auth.current() or {}
    if auth.enabled() and p.get("role") != "admin":
        raise HTTPException(403, "benchmark aturan 2 butuh admin")
    kit = hkeval_dir()
    if not (kit / "hkeval" / "report.py").is_file():
        raise HTTPException(503, f"kit evaluasi eksternal belum ada di {kit} (commit {HKEVAL_COMMIT[:7]})")
    return _public(_start("sintetis", req.model_dump(), {"hkeval": str(kit)}))


@router.get("/aturan2/{name}")
def rule2_file(name: str):
    """A rule-2 file: the summary, or one condition's evidence card."""
    from fastapi.responses import FileResponse
    import ml_sintetis as G

    _source()
    allowed = {"aturan2.json"} | {f"aturan2_{c}.{x}" for c in G.CONDITIONS for x in ("html", "md")}
    if name not in allowed:
        raise HTTPException(404, "berkas aturan 2 tidak dikenal")
    f = _dir() / "aturan2" / name
    if not f.is_file():
        raise HTTPException(404, "benchmark aturan 2 belum dijalankan (POST /api/aip/ml/aturan2)")
    media = {".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json"}
    return FileResponse(f, media_type=media[f.suffix], headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"})


@router.get("/tangga")
def ladder() -> dict:
    """The evidence ladder (the jury's "each step supports a broader claim, and none shows everything"): every kind of
    evidence the team has or plans, what it supports, what it does not show, and where it stands with its numbers."""
    from aip import karantina, produksi

    _source()
    cur = current() or {}
    ev = _read(_dir() / "versions" / cur.get("version", "-") / "bukti" / "bukti.json") or {}
    r2 = _read(_dir() / "aturan2" / "aturan2.json")
    pil = karantina._pilot_load()
    runs = produksi.status()["runs"]
    rs = ((ev.get("kartu") or {}).get("rumah_sakit") or {}).get("kartu") or {}
    head = rs.get("headline") or {}
    review = _dir() / "versions" / cur.get("version", "-") / "bukti" / "review" / "review_sheet.csv"
    est = karantina.estimates(pil) if pil else None
    done = (est["presisi"]["diaudit"] + est["acak"]["diaudit"]) if est else 0
    # in the order of the evaluation kit's slide 27; a pilot is evidence only once auditors record what they found (the
    # swarm's own audit is what it measures, never its truth)
    rungs = [
        {"langkah": "Benchmark sintetis (aturan 2)", "sumber": "fraud ditanam di klaim nyata: 7 modus, 3 dial, modus ditahan",
         "mendukung": "deteksi tiap modus yang ditanam, termasuk yang tidak pernah dilatih, pada kesulitan, frekuensi dan klaster berbeda",
         "tidak_menunjukkan": "kinerja pada fraud nyata (generatornya buatan tim sendiri)",
         "status": "selesai" if r2 else "dijadwalkan (uji asap 5% lulus)", "angka": {c: {"precision_at_k": v["kartu"]["headline"]["precision"], "pr_auc": v["pr_auc"]}
                                                                                       for c, v in (r2 or {}).get("kondisi", {}).items()} or None},
        {"langkah": "Benchmark independen terkalibrasi", "sumber": "data uji dari generator yang tidak ditulis tim ini, dikalibrasi ke statistik publik",
         "mendukung": "kinerja pada kondisi yang dinyatakan", "tidak_menunjukkan": "kinerja pada klaim nyata",
         "status": "belum ada: butuh benchmark dari pihak lain", "angka": None},
        {"langkah": "Tinjauan ahli buta", "sumber": "20 klaim teratas + 20 acak, diacak, tanpa skor (lembar kit)",
         "mendukung": "kasus pilihan model tampak lebih mencurigakan bagi ahli daripada kasus acak",
         "tidak_menunjukkan": "fraud terbukti: kecurigaan ahli bukan putusan",
         "status": "lembar siap, menunggu ahli" if review.exists() else "belum", "angka": None},
        {"langkah": "Label nyata parsial", "sumber": "klaim yang dikoreksi verifikator BPJS (label nyata, sebagian)",
         "mendukung": "peringkat model mengalahkan acak pada indikasi yang sudah tertangkap",
         "tidak_menunjukkan": "berapa banyak fraud yang belum tertangkap terlewat (data positif-tak-berlabel)",
         "status": "selesai" if head else "belum", "angka": {"precision_at_k_rs": head.get("precision"), "lift_rs": head.get("lift"),
                                                              "permutasi_p": (rs.get("permutation") or {}).get("p_value")} if head else None},
        {"langkah": "Audit terancang dalam pilot", "sumber": "daftar teratas box + sampel acak faskes lain, buta lengan; hasil dari auditor manusia",
         "mendukung": "presisi dan recall nyata, dengan interval",
         "tidak_menunjukkan": "bahwa hasil bertahan saat data bergeser dan pelaku beradaptasi",
         "status": ("belum dirancang" if not pil else f"dirancang, menunggu hasil auditor (0 dari {len(pil['sampel'])})" if not done
                    else f"selesai: {done} dari {len(pil['sampel'])} hasil tercatat" if done >= len(pil["sampel"])
                    else f"berjalan: {done} dari {len(pil['sampel'])} hasil tercatat"), "angka": est if done else None},
        {"langkah": "Pemantauan produksi", "sumber": "pipeline produksi: kontrak data, drift, kinerja out-of-time, paritas",
         "mendukung": "data dan skor stabil, degradasi model terdeteksi dan menghentikan pipeline",
         "tidak_menunjukkan": "dampak nyata pada penurunan fraud (butuh evaluasi kebijakan)",
         "status": f"{len(runs)} run, terakhir {runs[0]['status']}" if runs else "belum", "angka": None},
    ]
    return {"tangga": rungs, "pesan": "Tiap langkah mendukung klaim yang lebih luas, dan tidak satu pun menunjukkan semuanya."}


@router.get("/jobs/{jid}")
def get_job(jid: str) -> dict:
    import auth

    job = _jobs.get(jid) or _read(_job_path(jid))
    if not job:
        raise HTTPException(404, "job tidak ada")
    p = auth.current() or {}
    if auth.enabled() and job.get("user_id") not in (p.get("id"), None) and p.get("role") != "admin":
        raise HTTPException(404, "job tidak ada")
    return _public(job)


class ScopeIn(BaseModel):
    provinsi: Optional[str] = None
    kabkota: Optional[str] = None
    faskes_profil_id: Optional[str] = None
    segmen: Optional[str] = Field(None, pattern="^(rumah_sakit|klinik_utama)$")
    hanya_lolos_verifikasi: bool = False
    hanya_ditandai: bool = False
    batas: int = Field(20, ge=1, le=200)


def _scope(df: Any, req: ScopeIn) -> Any:
    if req.provinsi:
        want = req.provinsi.strip().lower()
        df = df[df["provinsi"].fillna("").str.lower().str.contains(re.escape(want)) | (df["provinsi_kode"].astype(str) == want)]
    if req.kabkota and "kabkota" in df:
        df = df[df["kabkota"].fillna("").str.lower().str.contains(re.escape(req.kabkota.strip().lower()))]
    if req.faskes_profil_id:
        df = df[df["faskes_profil_id"] == req.faskes_profil_id]
    if req.segmen:
        df = df[df["segmen_model"] == req.segmen]
    return df


@router.post("/klaim")
def klaim(req: ScopeIn) -> dict:
    _source()
    c = _loaded()
    df = _scope(c["klaim"], req)
    if req.hanya_lolos_verifikasi:
        df = df[df["lolos_verifikasi_berisiko"]]
    if req.hanya_ditandai:
        df = df[df["ditandai"]]
    n_flag, n_pass = int(df["ditandai"].sum()), int(df["lolos_verifikasi_berisiko"].sum())
    df = df.sort_values("risiko", ascending=False).head(req.batas)
    cols = ["klaim_id", "nama_profil", "provinsi", "segmen_model", "risiko_pct", "tingkat_risiko", "ditandai", "sudah_dikoreksi", "lolos_verifikasi_berisiko",
            "inacbg_kode", "dx_primer_icd3", "tingkat_pelayanan", "biaya_tagih", "los", "alasan_utama", "faskes_profil_id", "tgl_datang"]
    rows = json.loads(df[cols].to_json(orient="records", date_format="iso", force_ascii=False))
    return {"versi": c["version"], "cakupan": req.model_dump(exclude_none=True), "ditandai_dalam_cakupan": n_flag, "lolos_verifikasi_berisiko": n_pass,
            "klaim": rows, "ambang": {s: v["threshold"] for s, v in c["bundle"]["segments"].items()}}


class FaskesIn(BaseModel):
    provinsi: Optional[str] = None
    segmen: Optional[str] = Field(None, pattern="^(rumah_sakit|klinik_utama)$")
    urut: str = Field("ekspektasi_koreksi", pattern="^(ekspektasi_koreksi|risiko_per_1000_klaim|berisiko_lolos_verifikasi|rasio_aktual_ekspektasi|koreksi_aktual)$")
    batas: int = Field(15, ge=1, le=100)


@router.post("/faskes")
def faskes(req: FaskesIn) -> dict:
    _source()
    c = _loaded()
    df = _scope(c["faskes"], ScopeIn(provinsi=req.provinsi, segmen=req.segmen))
    total = {"faskes": len(df), "ekspektasi_koreksi": round(float(df["ekspektasi_koreksi"].sum()), 1), "koreksi_aktual": int(df["koreksi_aktual"].sum()),
             "klaim": int(df["klaim"].sum())}
    df = df.sort_values(req.urut, ascending=False).head(req.batas)
    rows = json.loads(df.to_json(orient="records", force_ascii=False))
    return {"versi": c["version"], "total": total, "faskes": rows}


class ExplainIn(BaseModel):
    klaim_id: str = Field(..., max_length=80)
    metode: Optional[list[str]] = None


@router.post("/jelaskan")
def jelaskan(req: ExplainIn) -> dict:
    """One stored claim explained by each method, with the model's own risk and the values behind the top features."""
    import ml_klaim as M

    _source()
    c = _loaded()
    rows = c["fitur"][c["fitur"]["klaim_id"] == req.klaim_id]
    if rows.empty:
        raise HTTPException(404, "klaim ini tidak termasuk klaim berisiko tertinggi yang disimpan model; penjelasan rinci tersedia untuk klaim teratas")
    row = rows.iloc[[0]]
    seg = c["bundle"]["segments"][row["segmen_model"].iloc[0]]
    methods = [m for m in (req.metode or ["treeshap", "kernelshap", "lime", "oklusi", "ebm"]) if m in M.EXPLAINERS]
    if seg["name"] == "EBM":
        methods = [m for m in methods if m != "treeshap"]
    else:
        methods = [m for m in methods if m != "ebm"]
    with _lock:
        ex = M.Explainer(seg["name"], seg["model"], seg["enc"], rows, typical=seg["typical"])
        x = seg["enc"].transform(row).to_numpy(float)[0]
        out = {}
        for m in methods:
            t = time.time()
            phi = ex.attribute(m, x)
            order = list(map(int, sorted(range(len(phi)), key=lambda j: -phi[j])[:8]))
            out[m] = {"keterangan": M.EXPLAINERS[m], "detik": round(time.time() - t, 2),
                      "fitur": [{"fitur": ex.columns[j], "label": M.LABELS.get(ex.columns[j], ex.columns[j]), "kontribusi": round(float(phi[j]), 5),
                                 "nilai": M._value(ex.columns[j], x[j], seg["enc"])} for j in order]}
    risk = float(M.predict(seg, row)[0])
    agree = {}
    import numpy as np

    tops = {m: [f["fitur"] for f in v["fitur"][:3]] for m, v in out.items()}
    for m, t in tops.items():
        agree[m] = {o: len(set(t) & set(u)) for o, u in tops.items() if o != m}
    return {"klaim_id": req.klaim_id, "model": seg["name"], "segmen_model": row["segmen_model"].iloc[0], "risiko_pct": round(100 * risk, 3),
            "ditandai": bool(risk >= seg["threshold"]), "metode": out, "irisan_top3": agree, "versi": c["version"],
            "catatan": "Kontribusi TreeSHAP/KernelSHAP/LIME/oklusi berskala peluang atau log-odds model; bandingkan urutannya, bukan besarnya."
            if len(out) > 1 else None, "_np": bool(np.isfinite(risk))}


if __name__ == "__main__":
    _main(sys.argv[1])
