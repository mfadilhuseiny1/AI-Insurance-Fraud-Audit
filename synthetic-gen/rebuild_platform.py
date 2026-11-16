"""Rebuild everything the app derives from the BPJS source, now from the SYNTHETIC source, with the app's own code:
bronze (Code Repository transforms) -> pipeline "Data Mentah -> Siap Analisis" (silver + gold) -> pipeline "Fakta Klaim"
-> Nexus types -> empty AI Agent Swarm outputs (no Swarm run has happened on the synthetic data yet).

Run in-process as the data's owner while the API of AI JKN Synthetic is running (it executes pipeline builds), from
PowerShell (Bash hangs on `import server`):
  cd api; ..\\.venv\\Scripts\\python.exe -I ..\\synthetic-gen\\rebuild_platform.py [bronze] [pipeline] [fakta] [nexus] [swarm]
`notes` (text only: pipeline notes, data dictionary, Nexus descriptions) needs no build and can run with the API stopped.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

API = Path(__file__).resolve().parents[1] / "api"
os.chdir(API)
sys.path.insert(0, str(API))
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

import server  # noqa: E402

import auth  # noqa: E402
import db  # noqa: E402

db.init(server._env("BLUESANDAI_DATABASE_URL"))
server._init_storage()
auth._principal.set(auth.principal_of("u-075eb58af4"))

import drive  # noqa: E402
import pipeline_datasets  # noqa: E402
import pipeline_runtime as rt  # noqa: E402
import pyarrow as pa  # noqa: E402
import pyarrow.dataset as pads  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

from bpjs_sampel import builder_pipeline, fakta_pipeline, nexus  # noqa: E402
from bpjs_sampel.platform_upload import PROJECT, folder  # noqa: E402

REPO_ID = "repo-dca599c6dc10"  # Code Repository "Pipeline Data Sampel BPJS"
PY = "transforms-python/src/myproject/datasets"
BRONZE = [f"{PY}/bronze.py::bronze_{t}" for t in ("kepesertaan", "fktpkapitasi", "fkrtl_bagian_1", "fkrtl_bagian_2", "nonkapitasi", "diagnosissekunder")]
SILVER = [f"{PY}/silver.py::silver_{t}" for t in ("peserta", "kunjungan_fktp", "diagnosis_sekunder", "tindakan_nonkapitasi", "kunjungan_fkrtl", "rujukan",
                                                    "dimensi", "laporan_kualitas")]
AUDIT_DRIVE = Path(r"D:\BluesandAI\ai-jkn-audit\data\drive")  # read for Parquet SCHEMAS only (no rows)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def step_bronze(keys: list[str] | None = None, reset: bool = True) -> None:
    import code_repos as cr

    cr.TIMEOUT = max(cr.TIMEOUT, 1200)  # the largest silver transform runs past the default 300 s when the machine is busy
    if reset:
        with cr._lock:  # the history of builds made on the real data leaves with it
            cr._write(REPO_ID, "builds.json", [])
    rec = cr._repo(REPO_ID)
    br = cr._branch(rec, None)
    head_files = cr._commit_files(REPO_ID, br["head"])
    commit_id = br["head"] if cr._files_hash(head_files) == cr._files_hash(br["files"]) else None
    listed = cr._run(br["files"], {"mode": "list"}, rec)
    if not listed.get("ok"):
        raise SystemExit(f"repository does not load: {listed.get('error')}")
    for key in keys or (BRONZE + SILVER):
        t0 = time.time()
        b = cr.build_transform(rec, br["files"], br["name"], key, "manual", commit_id, listed, False)
        log(f"{key.split('::')[1]}: {b['status']} in {time.time() - t0:.0f} s {('- ' + str(b.get('error'))[:300]) if b['status'] != 'succeeded' else ''}")
        if b["status"] != "succeeded":
            raise SystemExit("build failed")


def _wait(build_id: str, wait: float = 3600) -> dict:
    t0 = time.time()
    while time.time() - t0 < wait:
        b = rt._build(build_id)
        if b["status"] in ("succeeded", "failed", "cancelled"):
            return b
        time.sleep(5)
    return {"status": "still running"}


def _ibukota(ids: dict) -> None:
    """The province-capital reference (bronze/_meta/ibukota_provinsi): defined in code (builder_pipeline.IBUKOTA), written
    again when its file is missing."""
    meta = folder(ids["bronze"], "_meta")
    item = nexus._files(meta).get("ibukota_provinsi")
    if item and not (drive.LOCAL_DIR / item["id"]).exists():
        sink = pa.BufferOutputStream()
        pq.write_table(builder_pipeline.ibukota_table(), sink)
        pipeline_datasets._replace_content(item, sink.getvalue().to_pybytes())
        log("ibukota_provinsi written from code")


def step_pipeline() -> None:
    ids = nexus.layout()
    _ibukota(ids)
    st = nexus._state()
    pid = st["builder_pipeline_id"]
    folders = {layer: {"id": ids[layer], "name": f"{PROJECT} / {layer}"} for layer in ("silver", "gold")}
    body, _ = builder_pipeline.content(nexus._sources(ids), folders, PROJECT, nexus._catalog(ids), nexus._upstream(ids))
    item = pipeline_datasets._pipeline_item(pid)
    pipeline_datasets._replace_content(item, json.dumps(body).encode(), pipeline_datasets.PIPELINE)  # the editor's sample rows: synthetic now
    seeded = nexus._seed_outputs(pid, ids)
    log(f"pipeline 1 content rewritten ({len(body['nodes'])} nodes), outputs seeded: {len(seeded)}; building ...")
    t0 = time.time()
    b = _wait(rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="manual"))["id"])
    log(f"pipeline 1: {b['status']} in {time.time() - t0:.0f} s {b.get('error') or ''}")
    if b["status"] != "succeeded":
        raise SystemExit("pipeline 1 failed")


def _fakta_item(ids: dict) -> dict:
    for c in db.drive_list(ids["pipelines"]):
        if c["name"] == fakta_pipeline.PIPELINE and c["kind"] == "folder":
            for f in db.drive_list(c["id"]):
                if f["name"].endswith(pipeline_datasets.PIPELINE_EXT) and not f.get("trashed_at"):
                    return f
    raise SystemExit("fakta pipeline item not found")


def step_fakta() -> None:
    ids = nexus.layout()
    gold, silver = nexus._files(ids["gold"]), nexus._files(ids["silver"])
    sources = {}
    for key, fold, _, _ in fakta_pipeline.SOURCES:
        item = (gold if fold == "gold" else silver)[key]
        ds = pads.dataset(str(drive.LOCAL_DIR / item["id"]), format="parquet")
        sources[key] = {"item_id": item["id"], "table": ds.head(builder_pipeline.SAMPLE), "rows": ds.count_rows(), "folder": fold}
    item = _fakta_item(ids)
    body = fakta_pipeline.content(sources, {"id": ids["gold"], "name": f"{PROJECT} / gold"}, nexus._state()["builder_pipeline_id"])
    pipeline_datasets._replace_content(item, json.dumps(body).encode(), pipeline_datasets.PIPELINE)
    log("fakta pipeline content rewritten; building ...")
    t0 = time.time()
    b = _wait(rt.queue_build(rt.NewBuild(pipeline_id=item["id"], trigger="manual"))["id"])
    log(f"fakta pipeline: {b['status']} in {time.time() - t0:.0f} s {b.get('error') or ''}")
    if b["status"] != "succeeded":
        raise SystemExit("fakta pipeline failed")


def step_nexus() -> None:
    out = nexus.build(rebuild_gold=False)
    log("nexus:", json.dumps({k: (v if k in ("attach", "live", "lineage") else "ok") for k, v in out.items()}, default=str)[:2000])


def step_reindex() -> None:
    """Every BPJS object type re-imported from its rebuilt dataset (nexus.attach skips a type already backed by the same
    Files item, which would keep objects of an earlier build), and the AI Agent Swarm / ML types from their ml/ datasets.
    The synthetic data spreads over more groups than the real one (indikator_inacbg: 97k rows), hence the higher cap."""
    os.environ["BLUESANDAI_ONTOLOGY_MAX_ROWS"] = "150000"
    import ontology
    import ontology_datasources as ods

    ids = nexus.layout()
    type_ids = nexus._state()["types"]
    gold, silver = nexus._files(ids["gold"]), nexus._files(ids["silver"])
    for key, spec in nexus.TYPES.items():
        ds = spec[2]
        item = silver[ds.split(":", 1)[1]] if ds.startswith("silver:") else gold[ds]
        r = ods.put_datasource(type_ids[key], ods.DatasourceIn(dataset_id=item["id"], columns=None, map_unmapped=True))
        log(f"reindexed {key}: {r.get('imported')} objects from {item['name']}")
    ml_items = {c["id"]: c["name"] for c in db.drive_list(folder(ids["project"], "ml")) if c["kind"] == "file"}
    for t in ontology._all("object-types"):
        ds = (t.get("backing_dataset") or {}).get("dataset_id")
        if ds in ml_items:
            r = ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=ds, columns=None, map_unmapped=True))
            log(f"reindexed {t['display_name']}: {r.get('imported')} objects from ml/{ml_items[ds]}")


def step_swarm() -> None:
    """The AI Agent Swarm's outputs (indications, quarantine, semantic tags) and the ML scores exist only after runs on
    THIS data: empty tables with the same schema (schema read from the original files' footers, no rows)."""
    ids = nexus.layout()
    ml = folder(ids["project"], "ml")
    done = []
    for c in db.drive_list(ml):
        if c["kind"] != "file" or not c["name"].endswith(".parquet") or c.get("trashed_at"):
            continue
        src = AUDIT_DRIVE / c["id"]
        if not src.exists():
            continue
        schema = pq.read_schema(src)
        sink = pa.BufferOutputStream()
        pq.write_table(schema.empty_table(), sink)
        pipeline_datasets._replace_content(c, sink.getvalue().to_pybytes())
        done.append(c["name"])
    log("empty Swarm/ML outputs:", done)


def step_notes() -> None:
    """Text only, no build: the pipeline's node/output notes and data dictionary rewritten from builder_notes, and the
    Nexus type descriptions from nexus.TYPES / LIVE_TYPES (after the real-data figures the copied notes quoted were taken
    out, 2026-11-09). The pipeline's graph is the same, so its built outputs stay valid."""
    import ontology

    ids = nexus.layout()
    pid = nexus._state()["builder_pipeline_id"]
    folders = {layer: {"id": ids[layer], "name": f"{PROJECT} / {layer}"} for layer in ("silver", "gold")}
    body, _ = builder_pipeline.content(nexus._sources(ids), folders, PROJECT, nexus._catalog(ids), nexus._upstream(ids))
    pipeline_datasets._replace_content(pipeline_datasets._pipeline_item(pid), json.dumps(body).encode(), pipeline_datasets.PIPELINE)
    log(f"pipeline 1 notes rewritten ({len(body['nodes'])} nodes, {len(body['dictionary'])} dictionary entries)")
    nexus.ensure_types(nexus.ensure_groups())
    for display, *_rest, desc in nexus.LIVE_TYPES.values():
        t = nexus._type(display)
        if t and t.get("description") != desc:
            with ontology._lock:
                rec = ontology._object_type(t["id"])
                rec["description"] = desc
                ontology._put("object-types", rec)
    log("Nexus type descriptions applied")


STEPS = {"bronze": step_bronze, "pipeline": step_pipeline, "fakta": step_fakta, "nexus": step_nexus, "swarm": step_swarm, "reindex": step_reindex,
         "silver2": lambda: step_bronze(SILVER[4:], reset=False),  # the silver transforms from kunjungan_fkrtl on (after a timeout)
         "notes": step_notes}

if __name__ == "__main__":
    for name in sys.argv[1:] or [s for s in STEPS if s not in ("silver2", "notes")]:
        log(f"== {name}")
        STEPS[name]()
    log("done")
