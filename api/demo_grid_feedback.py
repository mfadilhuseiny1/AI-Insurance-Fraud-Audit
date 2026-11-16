"""Demo Grid, fase 5 sesi 4: feedback loop P2TL — hasil pemeriksaan menjadi label latih versi berikutnya, retrain
terjadwal, dan metrik hit-rate tanpa PII (dipanggil demo_grid_e2e.build, langkah "feedback"; dipasang server.py di
/api/demo/grid/feedback).

  hasil P2TL (dataset p2tl_hasil_pemeriksaan + Inspeksi dari action "Catat hasil P2TL")
  -> "Pipeline label P2TL gabungan grid (demo)" (batch terjadwal saat data berubah): label per pelanggan
     (terbukti pelanggaran = 1, diperiksa bersih = 0 keras) -> dataset label_p2tl_gabungan di folder ml (berversi)
  -> jadwal transform Code Repository model NTL: cron mingguan + saat label berubah -> experiment baru tercatat,
     AUROC kunci jawaban dibandingkan dengan experiment sebelumnya (kunci tidak pernah dipakai melatih)
  -> hit-rate agregat per ULP dan per basis pemilihan (model/aturan vs manual) untuk dashboard; tanpa identitas
     pelanggan (agregat saja, tidak ada baris per pelanggan di keluaran metrik).

Label awal model berasal dari fungsi hasilP2tl atas dataset yang sama (demo_grid_ml); loop ini membuatnya eksplisit
dan berversi: setiap pembangunan ulang pipeline label menaikkan versi dataset, dan riwayat retrain (waktu, jumlah
label, AUROC) disimpan di state untuk halaman /demo-grid. Fiktif, berlabel "(demo)"; read-only ke SCADA.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth

log = logging.getLogger("bluesandai.demo_grid_feedback")
router = APIRouter(prefix="/api/demo/grid/feedback")

PIPELINE = "Pipeline label P2TL gabungan grid (demo)"
VERSION = 4  # v4: hanya hasil P2TL sebagai input (fitur ML kini membaca label ini: tidak ada siklus)
LABEL = "label_p2tl_gabungan"
SCHEDULE_TRANSFORM = "transforms-python/src/model_training/model_training.py::train_model"
CRON = "0 3 * * 1"  # Senin 03:00 Asia/Jakarta: latih ulang dari label terbaru


def _e():
    import demo_grid_e2e as e

    return e


def _st() -> dict:
    return _e().STATE.setdefault("feedback", {})


# ------------------------------------------------------------------------------------------------
# label dan hit-rate (murni atas dataset hasil P2TL)
# ------------------------------------------------------------------------------------------------

def label_rows() -> list[dict]:
    """Satu baris per pelanggan yang pernah diperiksa: label terakhir (1 terbukti / 0 bersih), pola, basis, tanggal."""
    import demo_grid_data as gd

    cust = {c["id_pelanggan"]: c for c in gd.customers()}
    last: dict[str, dict] = {}
    for r in gd.generate()["p2tl_hasil_pemeriksaan"]:
        cur = last.get(r["id_pelanggan"])
        if cur is None or str(r["tanggal"]) >= str(cur["tanggal"]):
            last[r["id_pelanggan"]] = r
    out = []
    for pid, r in sorted(last.items()):
        c = cust.get(pid) or {}
        terbukti = (r.get("golongan") or "Tidak ada pelanggaran") != "Tidak ada pelanggaran"
        out.append({"id_pelanggan": pid, "kode_ulp": c.get("kode_ulp"), "label_p2tl": 1 if terbukti else 0,
                    "golongan_pelanggaran": r.get("golongan") if terbukti else "",
                    "basis_terakhir": r.get("dasar_pemilihan"), "tanggal_pemeriksaan_terakhir": str(r.get("tanggal")),
                    "sumber": "feedback P2TL (demo)"})
    return out


def hitrate() -> dict:
    """Hit-rate agregat: per ULP dan per basis pemilihan; tanpa identitas pelanggan."""
    import demo_grid_data as gd

    cust = {c["id_pelanggan"]: c for c in gd.customers()}
    rows = gd.generate()["p2tl_hasil_pemeriksaan"]

    def agg(key) -> list[dict]:
        per: dict[str, dict] = {}
        for r in rows:
            k = key(r) or "-"
            a = per.setdefault(k, {"diperiksa": 0, "terbukti": 0})
            a["diperiksa"] += 1
            if (r.get("golongan") or "Tidak ada pelanggaran") != "Tidak ada pelanggaran":
                a["terbukti"] += 1
        return [{"nama": k, **v, "hit_rate": round(v["terbukti"] / v["diperiksa"], 3) if v["diperiksa"] else None}
                for k, v in sorted(per.items(), key=lambda kv: -kv[1]["diperiksa"])]

    return {"per_ulp": agg(lambda r: (cust.get(r["id_pelanggan"]) or {}).get("kode_ulp")),
            "per_basis": agg(lambda r: r.get("dasar_pemilihan")),
            "total": {"diperiksa": len(rows),
                      "terbukti": sum(1 for r in rows if (r.get("golongan") or "Tidak ada pelanggaran") != "Tidak ada pelanggaran")}}


# ------------------------------------------------------------------------------------------------
# pipeline label (batch, terjadwal saat data berubah) + jadwal retrain repo
# ------------------------------------------------------------------------------------------------

SQL_LABEL = """-- Label latih dari hasil P2TL: pemeriksaan terakhir per pelanggan; terbukti pelanggaran = 1, diperiksa bersih = 0 (keras).
SELECT id_pelanggan, tanggal AS tanggal_pemeriksaan_terakhir, dasar_pemilihan AS basis_terakhir,
       CASE WHEN golongan <> 'Tidak ada pelanggaran' THEN 1 ELSE 0 END AS label_p2tl,
       CASE WHEN golongan <> 'Tidak ada pelanggaran' THEN golongan ELSE '' END AS golongan_pelanggaran,
       'feedback P2TL (demo)' AS sumber
FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY id_pelanggan ORDER BY tanggal DESC) AS rn FROM input)
WHERE rn = 1"""


def _content(items: dict, previews: dict, folder: str, project: str, uid) -> dict:
    import demo_jkn_pipeline as base

    now = datetime.now(timezone.utc).isoformat()

    def src(nid: str, name: str, rows: list[dict], x: int, y: int, color: str, desc: str) -> dict:
        ds = f"ds_{nid}"
        return {"node": {"id": nid, "kind": "source", "name": name, "x": x, "y": y, "color": color, "datasetId": ds, "description": desc},
                "ds": (ds, {"id": ds, "name": name, "origin": f"Files · {project}", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in base.schema_of(rows)], "rows": rows[:50],
                            "ref": {"kind": "drive", "itemId": items[nid]}})}

    # the inspection results only: the model's features read this label (fitur_ntl), so it must not read them back
    parts = [src("s_hasil", "p2tl_hasil_pemeriksaan", previews.get("s_hasil") or [], 0, 160, "lg-hasil",
                 "Hasil pemeriksaan P2TL (raw): basis pemilihan, golongan pelanggaran terbukti, tanggal")]
    nodes = [p["node"] for p in parts]
    datasets = dict(p["ds"] for p in parts)
    nodes += [
        {"id": "t_label", "kind": "transform", "name": "label_dari_hasil", "input": "s_hasil", "x": 340, "y": 160, "color": "lg-label",
         "description": "Pemeriksaan terakhir per pelanggan -> label terbukti (1) / bersih (0)",
         "steps": [{"id": uid(), "kind": "sql", "params": {"query": SQL_LABEL}}]},
    ]
    location = {"id": folder, "name": f"{project} / ml"}
    body = {"type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes,
            "outputs": [{"id": "o_label", "name": LABEL, "node": "t_label", "kind": "dataset", "columns": None,
                         "writeMode": "default", "location": location, "x": 680, "y": 160}],
            "legend": [{"id": "lg-hasil", "name": "Hasil P2TL", "hex": "#b45309"}, {"id": "lg-konteks", "name": "Konteks fitur", "hex": "#2c9c9c"},
                       {"id": "lg-label", "name": "Label latih", "hex": "#805ad5"}],
            "location": location, "buildSettings": {},
            "textNodes": [{"id": "note_fb", "x": 0, "y": -120, "w": 950, "h": 110, "color": "lg-label",
                           "text": "Feedback: hasil pemeriksaan P2TL menjadi label latih versi berikutnya (terbukti = 1, diperiksa bersih = 0 keras). "
                                   "Pipeline berjalan saat dataset hasil berubah; transform repo model berjadwal mingguan + saat label berubah. "
                                   "Kunci jawaban demo tidak pernah dipakai melatih."}],
            "schedules": [{"id": "fb-data", "name": "Label ulang saat hasil P2TL berubah (demo)", "enabled": True, "enabledAt": now,
                           "target": "single", "outputs": ["o_label"], "trigger": {"id": "root", "kind": "or", "items": [{"id": "data", "kind": "data"}]},
                           "retries": {"count": 1, "delayMinutes": 5}}],
            "meta": {"version": VERSION, "description": "Demo: feedback loop P2TL -> label latih berversi untuk retrain model NTL."}}
    return body


def _label_step(rows: list[dict]) -> list[dict]:
    return label_rows()


def build(state: dict, save) -> dict:
    import uuid

    import drive
    import pipeline_datasets
    import pipeline_runtime as rt

    e = _e()
    st = state.setdefault("feedback", {})
    out: dict[str, Any] = {}
    project = e._folder(None, e.PROJECT, "project")
    ml = e._folder(project, "ml")
    rows = label_rows()
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()[:12]
    lab_id = e._put(ml, LABEL, rows)
    if st.get("label_hash") != digest:
        st.update(label_hash=digest, label_versi=int(st.get("label_versi") or 0) + 1, label_baris=len(rows),
                  label_positif=sum(r["label_p2tl"] for r in rows), label_pada=datetime.now(timezone.utc).isoformat())
    st["label_id"] = lab_id
    out["label"] = {"versi_data": st["label_versi"], "baris": st["label_baris"], "positif": st["label_positif"]}
    raw_folder = (e.STATE.get("folders") or {}).get("raw") or e._folder(project, "raw")
    hasil_item = next((f["id"] for f in drive.list_files(raw_folder) if f["name"] == "p2tl_hasil_pemeriksaan.parquet"
                       and not f.get("trashed_at")), None)
    pid = st.get("pipeline_id")
    current = None
    if pid:
        try:
            current = json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(pid)))
        except Exception:  # noqa: BLE001
            current, pid = None, None
    if not pid or (current.get("meta") or {}).get("version") != VERSION:
        body = _content({"s_hasil": hasil_item}, {"s_hasil": rows[:50]}, ml, e.PROJECT, lambda: uuid.uuid4().hex[:8])
        if pid:
            body["createdAt"] = current.get("createdAt") or body["createdAt"]
            pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=body))
        else:
            pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(
                name=PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))["id"]
        st["pipeline_id"] = pid
        save()
    rt.set_state(pid, "output:o_label", {"itemId": lab_id, "parentId": ml, "version": 0, "rows": len(rows)})
    if not any(b["status"] in ("queued", "running") for b in rt._builds(pid, 5)):
        b = rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="demo"))
        out["label_build"] = b["id"]
    out["pipeline_id"] = pid
    out["jadwal_retrain"] = _schedule_retrain()
    st.update(hitrate=hitrate(), hitrate_pada=datetime.now(timezone.utc).isoformat())
    out["hitrate"] = st["hitrate"]["total"]
    save()
    return out


def _schedule_retrain() -> dict:
    import code_repos

    import demo_grid_ml as ml

    repo = next((r for r in code_repos.list_repos() if r["name"] == ml.REPO), None)
    repo_id = repo["id"] if repo else None
    if not repo_id:
        return {"error": "repo model belum ada"}
    have = [s for s in code_repos.list_schedules(repo_id) if s.get("cron") == CRON and s.get("transform") == SCHEDULE_TRANSFORM]
    if have:
        return {"schedule_id": have[0]["id"], "existing": True, "next": have[0].get("next_runs")}
    s = code_repos.add_schedule(repo_id, code_repos.ScheduleIn(
        name="Retrain mingguan dari label P2TL (demo)", transform=SCHEDULE_TRANSFORM, cron=CRON,
        timezone="Asia/Jakarta", on_input_update=True, enabled=True, retries=1))
    return {"schedule_id": s["id"], "next": s.get("next_runs")}


def retrain() -> dict:
    """Latih ulang sekarang (tombol/endpoint): experiment baru + AUROC kunci dibandingkan experiment sebelumnya."""
    import demo_grid_ml as ml

    e = _e()
    st = _st()
    before = ((e.STATE.get("ml_experiment") or {}).get("metrics") or {})
    e.STATE.pop("ml_trained_at", None)
    e._save()
    out_ml = ml.build(e.STATE, e._save)
    rec = {"pada": datetime.now(timezone.utc).isoformat(), "label_versi_data": st.get("label_versi"),
           "label_baris": st.get("label_baris"),
           "auroc_sebelum": before.get("auroc_kunci") or before.get("roc_auc") or before.get("auroc"),
           "experiment": e.STATE.get("ml_experiment") or out_ml.get("experiment")}
    st.setdefault("retrains", []).append(rec)
    e._save()
    return {"retrain": rec, "model": out_ml.get("model_id"), "deployment": out_ml.get("deployment_id")}


# ------------------------------------------------------------------------------------------------
# endpoints
# ------------------------------------------------------------------------------------------------

@router.get("")
def overview() -> dict:
    auth.require_user()
    st = _e().STATE.get("feedback") or {}
    return {"built": bool(st.get("pipeline_id")), "pipeline_id": st.get("pipeline_id"), "label_id": st.get("label_id"),
            "label": {"versi_data": st.get("label_versi"), "baris": st.get("label_baris"), "positif": st.get("label_positif"),
                      "pada": st.get("label_pada")},
            "hitrate": st.get("hitrate"), "retrains": (st.get("retrains") or [])[-5:],
            "jadwal": "Senin 03:00 Asia/Jakarta + saat label berubah (transform Code Repository model)"}


def overview_numbers() -> dict:
    st = _e().STATE.get("feedback") or {}
    hr = st.get("hitrate") or {}
    tot = hr.get("total") or {}
    return {"pipeline_id": st.get("pipeline_id"), "label_versi": st.get("label_versi"), "label_baris": st.get("label_baris"),
            "diperiksa": tot.get("diperiksa"), "terbukti": tot.get("terbukti"),
            "hit_rate": round(tot["terbukti"] / tot["diperiksa"], 3) if tot.get("diperiksa") else None,
            "retrain_terakhir": (st.get("retrains") or [{}])[-1].get("pada")}


class RetrainIn(BaseModel):
    pass


@router.post("/retrain")
def post_retrain() -> dict:
    e = _e()
    project = e.STATE.get("project_id")
    p = auth.current()
    if auth.enabled() and not (p and (auth._is_admin(p) or p.get("service") or (project and auth.role_for(project, p) == "owner"))):
        raise HTTPException(403, "Hanya administrator atau Owner Project demo yang dapat melatih ulang model")
    return retrain()
