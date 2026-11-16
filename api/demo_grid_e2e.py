"""Demo Grid: "Grid Management System Intelligence" end to end, from raw data to decisions (POST /api/demo/grid/e2e).

The chain, every step a real resource of the platform (the JKN demo's pattern, demo_jkn_e2e.py, for electricity
distribution: technical (TL) and non-technical (NTL) losses):

1. Raw data (Files, project "Grid Management System Intelligence" / raw): what the source systems export — GIS,
   NUSAGRID SCADA (equipment, point list, the feeder historian, SOE), AMR at the distribution transformers and at TM
   customers, AMI head-end (daily consumption, meter events), AP2T (technical master, identity — PII, separate —,
   six monthly bill files, tariffs), P2TL inspection reports, and the real West Java transmission grid (OpenStreetMap,
   context only). Synthetic and physically consistent (demo_grid_data.py).
2. Pipelines (Pipeline Builder, demo_grid_pipeline.py): "Pipeline aset & topologi jaringan grid (demo)" → clean/,
   then "Pipeline neraca energi & susut grid (demo)" (reading pipeline 1's outputs) → susut/: energy balances, physics
   TL, residual NTL, reliability, features, rule screening, findings with value and priority. Both rebuild when their
   inputs change.
3. Nexus: substations, feeders, distribution transformers, customers (no identity), energy balances, loss findings,
   P2TL inspections, work orders, outages, SCADA points, and the transmission context — backed by the datasets, linked.
4. Actions: the loss team's decisions (finding status, P2TL target, P2TL result, technical work order, meter check,
   escalation). Edit history on.
5. Functions (Code Repository "Fungsi Susut Jaringan Grid demo", 1.0.0): explainable losses and findings, the
   customers behind a transformer's losses, a feeder's findings, same-class neighbours, technical what-ifs.
6. Apps: the map (real transmission + demo distribution), Vertex graphs and template, the Workshop cockpit, a saved
   lineage graph, the Applications Portal entry.

Seeded and idempotent: what exists is kept, nothing is deleted. All names, people, companies and numbers are fictional
and titled "demo"; real places (OSM) carry no demo numbers.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

import ontology

log = logging.getLogger("bluesandai.demo_grid_e2e")
router = APIRouter(prefix="/api/demo/grid/e2e")

PROJECT = "PLN Grid Project"
FUNCTIONS_REPO = "Fungsi Susut Jaringan Grid demo"
FUNCTIONS_VERSION = "1.0.0"
DIR: Path = Path()
_lock = threading.RLock()
STATE: dict = {}

# object types: key → (display name, api name, primary key, title, dataset (pipeline, output) | None, icon, color, description)
T: dict[str, tuple] = {
    "gi": ("Grid Primary Substation (demo)", "GarduIndukGridDemo", "kode_gi", "nama", ("aset", "gardu_induk"), "bolt", "#4c78c4",
           "Demo: gardu induk 150/20 kV — GI Kawasan (model NUSAGRID SCADA) dan GI Cikarang Kota (sintetis), dengan GITET hulu nyata (OSM)."),
    "penyulang": ("Grid Feeder (demo)", "PenyulangGridDemo", "kode_penyulang", "judul", ("susut", "penyulang_status"), "route", "#d97706",
                  "Demo: penyulang 20 kV dengan geometri, tag SCADA kWh, neraca energi Jul–Sep (susut, TL, NTL), keandalan (SAIDI/SAIFI) dan temuan."),
    "gardu": ("Grid Distribution Substation (demo)", "GarduDistribusiGridDemo", "kode_dt", "judul", ("susut", "gardu_distribusi_status"), "box", "#0f766e",
              "Demo: gardu distribusi 20 kV/400 V dengan neraca AMR vs tagihan pelanggan TR, susut teknis (I²R, trafo) dan non-teknis, beban dan status."),
    "pelanggan": ("Grid Customer (demo)", "PelangganGridDemo", "id_pelanggan", "judul", ("susut", "pelanggan_status"), "user", "#805ad5",
                  "Demo: pelanggan (tanpa identitas — nama, NIK, alamat ada di dataset ber-marking PII) dengan golongan, meter, fitur pemakaian, "
                  "temuan dan riwayat P2TL."),
    "neraca_gardu": ("Grid Substation Energy Balance (demo)", "NeracaEnergiGarduGridDemo", "id_neraca", "id_neraca", ("susut", "neraca_gardu_bulanan"), "scale",
                     "#2f855a", "Demo: neraca energi bulanan per gardu distribusi: kWh keluar trafo, kWh ditagih, susut, susut teknis, non-teknis."),
    "neraca_penyulang": ("Grid Feeder Energy Balance (demo)", "NeracaEnergiPenyulangGridDemo", "id_neraca", "id_neraca", ("susut", "neraca_penyulang_bulanan"),
                         "scale", "#2c9c9c", "Demo: neraca energi bulanan per penyulang: kWh kirim SCADA, kWh ditagih, rugi saluran & trafo, NTL."),
    "temuan": ("Grid Loss Finding (demo)", "TemuanSusutGridDemo", "id_temuan", "judul", ("susut", "temuan_susut"), "alert", "#c53030",
               "Demo: temuan susut per pelanggan atau aset — pola dugaan (NTL-xx / TL-xx), skor aturan, bukti, nilai harapan dan prioritas P1/P2/P3."),
    "inspeksi": ("Grid Meter Inspection P2TL (demo)", "InspeksiP2tlGridDemo", "no_ba", "no_ba", ("susut", "p2tl_bersih"), "check", "#b7791f",
                 "Demo: berita acara P2TL — dasar pemilihan, golongan pelanggaran (P-I..P-IV), tagihan susulan. Label model; hasil baru lewat action."),
    "gangguan": ("Grid Feeder Outage (demo)", "GangguanPenyulangGridDemo", "id_gangguan", "judul", ("susut", "gangguan_penyulang"), "zap", "#e53e3e",
                 "Demo: gangguan dari SOE SCADA (trip PMT/recloser), penyebab, durasi, pelanggan padam — dasar SAIDI/SAIFI."),
    "titik": ("Titik Ukur SCADA Grid (demo)", "TitikUkurScadaGridDemo", "tag", "tag", ("scada", "titik_ukur_scada"), "activity", "#c05621",
              "Demo: daftar titik ukur NUSAGRID SCADA (tag SITE.GARDU.TEGANGAN.BAY.PERALATAN.SINYAL) dengan peralatan dan penyulangnya."),
    "perintah": ("Grid Work Order (demo)", "PerintahKerjaGridDemo", "id_perintah", "judul", None, "wrench", "#6b46c1",
                 "Demo: perintah kerja teknis dari temuan susut (penyeimbangan beban, uprating trafo, rekonduktor JTR, kapasitor) — dibuat lewat action."),
    "saluran_tx": ("Transmission Line West Java (OSM)", "SaluranTransmisiJabarOsm", "osm_id", "nama", ("aset", "saluran_transmisi_jabar"), "route", "#b4123a",
                   "Konteks nyata: saluran transmisi Jawa Barat dari OpenStreetMap (ODbL), kelas tegangan dari tag atau inferensi. Tanpa data demo."),
    "gardu_tx": ("Transmission Substation West Java (OSM)", "GarduTransmisiJabarOsm", "osm_id", "nama", ("aset", "gardu_transmisi_jabar"), "bolt", "#1e293b",
                 "Konteks nyata: GITET dan GI Jawa Barat dari OpenStreetMap (ODbL). Tanpa data demo."),
    "kawasan": ("Industrial Estate West Java (OSM)", "KawasanIndustriJabarOsm", "osm_id", "nama", ("aset", "kawasan_industri_jabar"), "factory", "#7c3aed",
                "Konteks nyata: kawasan industri Jawa Barat dari OpenStreetMap (ODbL). Tidak ada pelanggan atau kasus demo yang dikaitkan."),
}
# properties with a type the dataset cannot tell (geo) and the ones only actions write
GEO = {"gi": {"lokasi": "geopoint"}, "penyulang": {"geometri": "geoshape"}, "gardu": {"lokasi": "geopoint"}, "pelanggan": {"lokasi": "geopoint"},
       "saluran_tx": {"geometri": "geoshape"}, "gardu_tx": {"lokasi": "geopoint"}, "kawasan": {"lokasi": "geopoint"}}
EDIT_PROPS = {
    "temuan": [("catatan_tindak_lanjut", "Catatan tindak lanjut", "string"), ("tim_p2tl", "Tim P2TL", "string"),
               ("tanggal_rencana", "Tanggal rencana pemeriksaan", "date"), ("ditetapkan_oleh", "Ditetapkan oleh", "string")],
    "pelanggan": [("status_meter", "Status meter", "string"), ("catatan_meter", "Catatan meter", "string")],
    "gardu": [("catatan_teknis", "Catatan teknis", "string")],
}
# the work-order type has no dataset: its properties are declared here
PERINTAH_PROPS = [("id_perintah", "ID perintah kerja", "string"), ("judul", "Judul", "string"), ("kode_dt", "Gardu distribusi", "string"),
                  ("kode_penyulang", "Penyulang", "string"), ("id_temuan", "Temuan asal", "string"), ("jenis_pekerjaan", "Jenis pekerjaan", "string"),
                  ("uraian", "Uraian", "string"), ("estimasi_biaya_rp", "Estimasi biaya (Rp)", "double"),
                  ("estimasi_penghematan_kwh_bulan", "Estimasi penghematan (kWh/bln)", "double"), ("tanggal_target", "Tanggal target", "date"),
                  ("status_pekerjaan", "Status pekerjaan", "string"), ("pelaksana", "Pelaksana", "string")]
LABELS = {  # display names for columns (the rest: "Column name")
    "kode_gi": "Kode GI", "nama": "Nama", "judul": "Judul", "lokasi": "Lokasi", "geometri": "Geometri", "kode_penyulang": "Kode penyulang",
    "kode_dt": "Kode gardu distribusi", "id_pelanggan": "ID pelanggan", "kode_ulp": "ULP", "susut_pct": "Susut (%)", "susut_teknis_pct": "Susut teknis (%)",
    "susut_non_teknis_pct": "Susut non-teknis (%)", "nilai_harapan_rp": "Nilai harapan (Rp)", "prioritas": "Prioritas", "skor": "Skor aturan",
    "kode_pola_dugaan": "Pola dugaan", "status_temuan": "Status temuan", "bukti": "Bukti", "kelompok_susut": "Kelompok susut",
    "status_gardu": "Status gardu", "tingkat_susut": "Tingkat susut", "saidi_menit": "SAIDI (menit)", "saifi_kali": "SAIFI (kali)",
    "tarif": "Golongan tarif", "daya_va": "Daya (VA)", "segmen": "Segmen", "tegangan": "Tegangan (TR/TM)", "golongan": "Golongan",
    "pola_dugaan": "Pola dugaan", "skor_aturan": "Skor aturan", "no_ba": "No. berita acara", "golongan_pelanggaran_lalu": "Pelanggaran P2TL lalu",
    "kwh_hilang_bulan": "kWh hilang per bulan", "nilai_rp_bulan": "Nilai per bulan (Rp)", "tindak_lanjut_usulan": "Tindak lanjut usulan",
}
SEARCHABLE = {"nama", "judul", "kode_gi", "kode_penyulang", "kode_dt", "id_pelanggan", "id_temuan", "no_ba", "tag", "osm_id", "id_gangguan"}
SELECTABLE = {"kode_ulp", "segmen", "tarif", "tegangan", "prioritas", "kode_pola_dugaan", "status_temuan", "kelompok_susut", "status_gardu",
              "tingkat_susut", "jenis", "golongan", "dasar_pemilihan", "penyebab", "kelas", "jenis_meter", "ami", "pola_dugaan", "kode_pola"}

# links: (name, source key, foreign key, target key, source side label, target side label)
L: list[tuple[str, str, str, str, str, str]] = [
    ("Feeder from primary substation (grid demo)", "penyulang", "kode_gi", "gi", "Penyulang", "Gardu induk"),
    ("Distribution substation on feeder (grid demo)", "gardu", "kode_penyulang", "penyulang", "Gardu distribusi", "Penyulang"),
    ("Customer on distribution substation (grid demo)", "pelanggan", "kode_dt", "gardu", "Pelanggan TR", "Gardu distribusi"),
    ("Customer on feeder (grid demo)", "pelanggan", "kode_penyulang", "penyulang", "Pelanggan", "Penyulang"),
    ("Substation energy balance (grid demo)", "neraca_gardu", "kode_dt", "gardu", "Neraca bulanan", "Gardu distribusi"),
    ("Feeder energy balance (grid demo)", "neraca_penyulang", "kode_penyulang", "penyulang", "Neraca bulanan", "Penyulang"),
    ("Loss finding for customer (grid demo)", "temuan", "kode_objek", "pelanggan", "Temuan", "Pelanggan"),
    ("Loss finding at substation (grid demo)", "temuan", "kode_dt", "gardu", "Temuan", "Gardu distribusi"),
    ("Loss finding on feeder (grid demo)", "temuan", "kode_penyulang", "penyulang", "Temuan", "Penyulang"),
    ("P2TL meter inspection of customer (grid demo)", "inspeksi", "id_pelanggan", "pelanggan", "Inspeksi P2TL", "Pelanggan"),
    ("Feeder outage (grid demo)", "gangguan", "kode_penyulang", "penyulang", "Gangguan", "Penyulang"),
    ("Feeder SCADA measurement point (grid demo)", "titik", "kode_penyulang", "penyulang", "Titik ukur SCADA", "Penyulang"),
    ("Work order at substation (grid demo)", "perintah", "kode_dt", "gardu", "Perintah kerja", "Gardu distribusi"),
    ("Work order from loss finding (grid demo)", "perintah", "id_temuan", "temuan", "Perintah kerja", "Temuan asal"),
    ("Primary substation supplied by EHV substation (grid demo)", "gi", "gitet_hulu_osm_id", "gardu_tx", "GI demo yang dipasok", "GITET hulu (OSM)"),
]


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "demo-grid-e2e"
    DIR.mkdir(parents=True, exist_ok=True)
    try:
        STATE.update(json.loads((DIR / "state.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass


def _save() -> None:
    (DIR / "state.json").write_text(json.dumps(STATE, indent=1, default=str), encoding="utf-8")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uid() -> str:
    return uuid.uuid4().hex[:8]


def _type(key: str) -> Optional[dict]:
    name = T[key][0]
    return next((t for t in ontology._all("object-types") if t["display_name"] == name), None)


# ------------------------------------------------------------------------------------------------
# Files: the project and its folders
# ------------------------------------------------------------------------------------------------

def _folder(parent: Optional[str], name: str, kind: str = "folder") -> str:
    import db
    import drive

    live = [c for c in db.drive_list(parent) if c["kind"] in drive.CONTAINERS and not c.get("trashed_at")]
    found = next((c for c in live if c["name"] == name), None)
    return found["id"] if found else drive._insert_container(parent, kind, name)


def _arrow(rows: list[dict]):
    import pyarrow as pa

    import demo_jkn_pipeline as base

    kinds = {"String": pa.string(), "Integer": pa.int64(), "Double": pa.float64(), "Boolean": pa.bool_()}
    cast = {"String": lambda v: None if v is None else str(v), "Integer": lambda v: None if v is None else int(v),
            "Double": lambda v: None if v is None else float(v), "Boolean": lambda v: None if v is None else bool(v)}
    schema = base.schema_of(rows)
    return pa.table({c: pa.array([cast[t](r.get(c)) for r in rows], type=kinds[t]) for c, t in schema})


def _put(folder_id: str, name: str, rows: list[dict], replace: bool = True) -> str:
    """Write (or replace) <name>.parquet in the folder; returns the item id. Unchanged content is not rewritten (so a
    rebuild does not fire the pipelines' data triggers for nothing)."""
    import drive
    import pipeline_datasets

    data = pipeline_datasets._parquet_bytes(_arrow(rows))
    existing = next((f for f in drive.list_files(folder_id) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)
    if existing:
        if replace:
            try:
                same = drive.read_bytes(drive._item(existing["id"])) == data
            except Exception:  # noqa: BLE001
                same = False
            if not same:
                pipeline_datasets._replace_content(existing, data)
        return existing["id"]
    return drive.save_bytes(folder_id, f"{name}.parquet", data, pipeline_datasets.PARQUET)["id"]


def _ensure_files() -> dict:
    """raw/ (every source export, rewritten when it changes), clean/ and susut/ (the pipelines' outputs, computed by the
    emulation on the first load only — the pipelines own them afterwards)."""
    import demo_grid_data as gd
    import demo_grid_pipeline as gp

    project = _folder(None, PROJECT, "project")
    folders = {k: _folder(project, k) for k in ("raw", "clean", "susut", "ml", "governance", "pipelines", "apps")}
    raw = dict(gd.generate())
    raw.pop("ap2t_pelanggan_identitas", None)  # identity (PII) is written by the governance step, marked, into governance/
    raw["osm_jaringan_transmisi_jabar"] = gp.osm_rows()
    raw_ids = {name: _put(folders["raw"], name, rows) for name, rows in raw.items()}
    clean = {**gp.outputs("aset"), **gp.outputs("scada")}
    clean_ids = {name: _put(folders["clean"], name, rows, replace=False) for name, rows in clean.items()}
    susut = gp.outputs("susut")
    susut_ids = {name: _put(folders["susut"], name, rows, replace=False) for name, rows in susut.items()}
    rows = {**{k: len(v) for k, v in raw.items()}, **{k: len(v) for k, v in clean.items()}, **{k: len(v) for k, v in susut.items()}}
    return {"project_id": project, "folders": folders, "raw": raw_ids, "clean": clean_ids, "susut": susut_ids, "rows": rows}


# ------------------------------------------------------------------------------------------------
# Pipeline Builder: the two pipelines, their schedules and first builds
# ------------------------------------------------------------------------------------------------

def _schedule(key: str, output_ids: list[str]) -> dict:
    return {"id": f"grid-{key}-updated", "name": "Bangun ulang saat data masuk (demo)", "enabled": True, "enabledAt": _now(), "target": "single",
            "outputs": output_ids, "trigger": {"id": "root", "kind": "or", "items": [{"id": "data", "kind": "data"},
                                                                                       {"id": "pagi", "kind": "time", "cron": "30 5 * * *", "timezone": "Asia/Jakarta"}]},
            "retries": {"count": 1, "delayMinutes": 5}}


def _ensure_pipelines(files: dict) -> dict:
    import db
    import drive
    import pipeline_datasets
    import pipeline_runtime as rt

    import demo_grid_pipeline as gp

    out: dict[str, Any] = {}
    pipes = STATE.setdefault("pipelines", {})
    for key, p in gp.PIPELINES.items():
        sources = {n["name"]: (files["clean"] if n["group"] == "aset" else files["raw"])[n["name"]] for n in p["spec"]() if n["kind"] == "source"}
        out_folder = files["folders"][p["folder"]]
        out_files = files["clean"] if p["folder"] == "clean" else files["susut"]
        pid = (pipes.get(key) or {}).get("id")
        item = None
        if pid:
            try:
                item = db.drive_get(pid)
            except Exception:  # noqa: BLE001
                item = None
        if item and not item.get("trashed_at"):
            cur = json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(pid)))
            if (cur.get("meta") or {}).get("version") == p["version"]:
                out[key] = {"id": pid, "created": False}
                continue
            body, out_ids = gp.content(key, sources, out_folder, PROJECT, _uid, _schedule)
            body["createdAt"] = cur.get("createdAt") or body["createdAt"]
            pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=body))
            out[key] = {"id": pid, "upgraded_to": p["version"]}
        else:
            body, out_ids = gp.content(key, sources, out_folder, PROJECT, _uid, _schedule)
            item = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=p["name"], parent_id=files["folders"]["pipelines"], content=body))
            pid = item["id"]
            out[key] = {"id": pid, "created": True}
        # the outputs write into the files the emulation computed (the Nexus already reads them)
        for name, oid in out_ids.items():
            if not rt.get_state(pid, f"output:{oid}"):
                rt.set_state(pid, f"output:{oid}", {"itemId": out_files[name], "parentId": out_folder, "version": 0, "rows": files["rows"][name],
                                                    "path": f"{PROJECT} / {p['folder']} / {name}.parquet"})
        pipes[key] = {"id": pid, "output_ids": out_ids}
        if out[key].get("created"):
            try:
                b = rt.queue_build(rt.NewBuild(pipeline_id=pid, trigger="demo"))
                out[key]["build"] = b.get("id")
            except Exception as e:  # noqa: BLE001
                log.info("demo grid: the first build of %s was not queued (%s)", key, e)
    _save()
    return out


# ------------------------------------------------------------------------------------------------
# Nexus: object types backed by the datasets, edit-only properties, links, history
# ------------------------------------------------------------------------------------------------

def _prop(col: str, typ: str, key: str) -> dict:
    hints = (["searchable"] if col in SEARCHABLE else []) + (["selectable"] if col in SELECTABLE else []) + \
            (["identifier"] if col == T[key][2] else []) + (["long_text"] if col in ("bukti", "temuan", "uraian") else [])
    return {"api_name": col, "display_name": LABELS.get(col, col.replace("_", " ").capitalize()), "type": typ, "description": "",
            **({"render_hints": hints} if hints else {})}


PTYPE = {"String": "string", "Integer": "integer", "Double": "double", "Boolean": "boolean"}


def _ensure_types(files: dict) -> dict:
    import demo_jkn_pipeline as base
    import ontology_datasources as ods

    import demo_grid_pipeline as gp

    made, attached = [], []
    outs = {"aset": gp.outputs("aset"), "susut": gp.outputs("susut")}
    for key, (name, api, pk, title, ds, icon, color, desc) in T.items():
        t = _type(key)
        if not t:
            if ds:
                rows = outs[ds[0]][ds[1]]
                props = [_prop(c, GEO.get(key, {}).get(c) or PTYPE[ty], key) for c, ty in base.schema_of(rows)]
            else:
                props = [{**_prop(c, ty, key), "display_name": lbl} for c, lbl, ty in PERINTAH_PROPS]
            t = ontology.create_object_type(ontology.ObjectTypeIn(
                display_name=name, plural_name=name, api_name=api, primary_key=pk, title_property=title, icon=icon, color=color,
                description=desc, properties=[ontology.Property(**p) for p in props],
                **({"generate_primary_key": True} if key == "perintah" else {})))
            made.append(name)
        with ontology._lock:
            rec = ontology._object_type(t["id"])
            new = [(a, lbl, ty) for a, lbl, ty in EDIT_PROPS.get(key, []) if not any(p["api_name"] == a for p in rec["properties"])]
            if new:
                rec["properties"] += [{"api_name": a, "display_name": lbl, "type": ty, "description": "Diisi lewat action tim susut.", "edit_only": True}
                                      for a, lbl, ty in new]
                ontology._put("object-types", rec)
        if ds:
            item = (files["clean"] if ds[0] in ("aset", "scada") else files["susut"])[ds[1]]
            if (ontology._object_type(t["id"]).get("backing_dataset") or {}).get("dataset_id") != item:
                r = ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=item, columns=None, map_unmapped=True))
                attached.append(f"{name}: {r.get('imported')}")
    return {"made": made, "attached": attached}


def _ensure_links() -> list[str]:
    import ontology_model as om

    made = []
    have = {x.get("display_name") for x in ontology._all("link-types")}
    for name, src, fk, tgt, sname, tname in L:
        if name in have:
            continue
        s, t = _type(src), _type(tgt)
        if not s or not t:
            continue
        om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key=fk,
                                          source=om.LinkSide(object_type_id=s["id"], display_name=sname, plural_display_name=sname),
                                          target=om.LinkSide(object_type_id=t["id"], display_name=tname)))
        made.append(name)
    return made


def _enable_history() -> list[str]:
    import ontology_edits

    done = []
    for key in ("temuan", "pelanggan", "gardu", "inspeksi", "perintah"):
        t = _type(key)
        if t and not ontology_edits.config(ontology._object_type(t["id"]))["history"]:
            ontology_edits.set_config(t["id"], ontology_edits.EditsConfigIn(history=True))
            done.append(T[key][0])
    return done


# ------------------------------------------------------------------------------------------------
# actions
# ------------------------------------------------------------------------------------------------

def _action(name: str) -> Optional[dict]:
    return next((a for a in ontology._all("action-types") if a["display_name"] == name), None)


# (name, kind, type key, object label, description, [(parameter, label, required)])
ACTIONS = [
    ("Tetapkan status temuan susut (demo)", "modify", "temuan", "Temuan",
     "Tim susut menetapkan status temuan (Baru, Diverifikasi, Target P2TL, Ditindaklanjuti, Selesai, Bukan pelanggaran) dengan catatan.",
     [("status_temuan", "Status temuan", True), ("catatan_tindak_lanjut", "Catatan", False), ("ditetapkan_oleh", "Ditetapkan oleh", False)]),
    ("Jadikan target P2TL (demo)", "modify", "temuan", "Temuan",
     "Masukkan temuan ke operasi P2TL: tim dan tanggal rencana pemeriksaan (status Target P2TL).",
     [("status_temuan", "Status (Target P2TL)", True), ("tim_p2tl", "Tim P2TL", True), ("tanggal_rencana", "Tanggal rencana", True),
      ("catatan_tindak_lanjut", "Alasan pemilihan", False)]),
    ("Eskalasi temuan bernilai besar (demo)", "modify", "temuan", "Temuan",
     "Naikkan temuan bernilai besar (pelanggan TM, lembaga) ke P1 dan ke manajemen UP3 / bagian hukum, dengan alasan.",
     [("status_temuan", "Status (Eskalasi)", True), ("prioritas", "Prioritas (P1)", True), ("catatan_tindak_lanjut", "Alasan eskalasi", True)]),
    ("Catat hasil P2TL (demo)", "create", "inspeksi", "Inspeksi",
     "Catat berita acara pemeriksaan: golongan pelanggaran (P-I..P-IV / tidak ada / kelainan meter), temuan, kWh dan Rp tagihan susulan. "
     "Hasilnya menjadi label model deteksi NTL.",
     [("no_ba", "No. berita acara", True), ("id_pelanggan", "ID pelanggan", True), ("tanggal", "Tanggal", True), ("dasar_pemilihan", "Dasar pemilihan", True),
      ("golongan", "Golongan", True), ("temuan", "Temuan", True), ("kwh_tagihan_susulan", "kWh tagihan susulan", False),
      ("rp_tagihan_susulan", "Rp tagihan susulan", False), ("tim", "Tim", True)]),
    ("Buat perintah kerja teknis (demo)", "create", "perintah", "Perintah kerja",
     "Perintah kerja untuk susut teknis: penyeimbangan beban, uprating/sisip trafo, rekonduktor JTR, perbaikan faktor daya — dengan biaya dan "
     "penghematan yang diperkirakan.",
     [("judul", "Judul", True), ("kode_dt", "Gardu distribusi", False), ("kode_penyulang", "Penyulang", False), ("id_temuan", "Temuan asal", False),
      ("jenis_pekerjaan", "Jenis pekerjaan", True), ("uraian", "Uraian", False), ("estimasi_biaya_rp", "Estimasi biaya (Rp)", False),
      ("estimasi_penghematan_kwh_bulan", "Estimasi penghematan (kWh/bln)", False), ("tanggal_target", "Tanggal target", False),
      ("status_pekerjaan", "Status", True), ("pelaksana", "Pelaksana", False)]),
    ("Tandai meter rusak / ganti meter (demo)", "modify", "pelanggan", "Pelanggan",
     "Kelainan meter yang bukan pelanggaran (register macet, AMI nol): jadwalkan penggantian meter.",
     [("status_meter", "Status meter", True), ("catatan_meter", "Catatan", False)]),
]


def _ensure_actions() -> list[str]:
    made = []
    for name, kind, key, label, desc, params in ACTIONS:
        if _action(name):
            continue
        t = _type(key)
        if not t:
            continue
        props = {p["api_name"]: p for p in ontology._object_type(t["id"])["properties"]}
        first = [ontology.Parameter(id="object", display_name=label, type="object", required=True)] if kind == "modify" else []
        ontology.create_action_type(ontology.ActionTypeIn(
            display_name=name, object_type_id=t["id"], kind=kind, status="active", description=desc,
            parameters=first + [ontology.Parameter(id=pid, display_name=plabel, type=props[pid]["type"], property=pid, required=req)
                                for pid, plabel, req in params if pid in props]))
        made.append(name)
    return made


# ------------------------------------------------------------------------------------------------
# functions (Python, published to the functions registry)
# ------------------------------------------------------------------------------------------------

FUNCTIONS_PY = '''"""Fungsi susut jaringan grid (demo).

Functions on the grid Nexus (Gardu Distribusi, Penyulang, Pelanggan, Temuan Susut). Each takes one object, so Vertex runs
it from a selected node (those returning objects are function-backed Search Arounds, the others derived values), and
the Workshop cockpit shows the explanations next to the decision form.
"""

from functions.api import Integer, String, function
from ontology_sdk import FoundryClient
from ontology_sdk.ontology.objects import (GarduDistribusiGridDemo, PelangganGridDemo, PenyulangGridDemo,
                                           TemuanSusutGridDemo)

POLA = {
    "NTL-01": "bypass meter", "NTL-02": "magnet / tamper meter", "NTL-03": "sambungan liar bukan pelanggan", "NTL-04": "pembatas daya diakali",
    "NTL-05": "faktor kali CT salah di tagihan", "NTL-06": "stand macet / tagihan estimasi", "NTL-07": "manipulasi CT/PT",
    "NTL-08": "sambungan sebelum kubikel meter", "NTL-09": "tarif sosial/pemerintah untuk usaha", "NTL-10": "register WBP/LWBP digeser",
    "NTL-11": "penyaluran ulang", "NTL-12": "demand melebihi kontrak", "NTL-13": "kolusi baca meter", "NTL-14": "bypass tiga fasa (crypto mining)",
    "TL-01": "trafo overload", "TL-02": "fasa tidak seimbang", "TL-03": "JTR panjang / tegangan ujung rendah", "TL-04": "faktor daya rendah",
    "TL-05": "trafo tua (rugi besi)", "X-02": "meter rusak (bukan pelanggaran)",
}


def _o():
    return FoundryClient().ontology.objects


def _rp(v) -> str:
    return "Rp " + f"{float(v or 0):,.0f}".replace(",", ".")


def _temuan_gardu(kode_dt: str) -> list:
    t = _o().TemuanSusutGridDemo
    return sorted(t.where(TemuanSusutGridDemo.object_type.kode_dt == kode_dt).iterate(), key=lambda x: -(x.nilai_harapan_rp or 0))


@function
def alasan_susut_gardu(gardu: GarduDistribusiGridDemo) -> String:
    """Mengapa susut gardu ini sebesar itu: neraca Jul–Sep, porsi teknis vs non-teknis, beban, dan temuan di bawahnya."""
    lines = [f"Susut {gardu.susut_pct}% dari {float(gardu.kwh_keluar_q3 or 0):,.0f} kWh keluar trafo (Jul–Sep): "
             f"teknis {gardu.susut_teknis_pct}% + non-teknis {gardu.susut_non_teknis_pct}% → {gardu.status_gardu}."]
    lines.append(f"Trafo {gardu.kva} kVA (pasang {gardu.tahun_pasang}), beban puncak {gardu.beban_puncak_pct}%, arus netral "
                 f"{round(100 * float(gardu.rasio_arus_netral or 0))}% arus fasa, tegangan ujung terendah {gardu.tegangan_ujung_min_v} V, "
                 f"JTR {gardu.panjang_jtr_km} km.")
    ts = _temuan_gardu(gardu.kode_dt)
    if ts:
        lines.append(f"{len(ts)} temuan, nilai harapan {_rp(sum(float(t.nilai_harapan_rp or 0) for t in ts))}:")
        for t in ts[:6]:
            lines.append(f"• {t.id_temuan} {t.kode_pola_dugaan} ({POLA.get(t.kode_pola_dugaan, t.judul)}) {t.prioritas}: {t.bukti}")
    else:
        lines.append("Tidak ada temuan aturan di gardu ini.")
    return "\\n".join(lines)


@function
def alasan_temuan(temuan: TemuanSusutGridDemo) -> String:
    """Penjelasan temuan: pola dugaan, aturan yang menandai, bukti, nilai, dan tindak lanjut yang diusulkan."""
    lines = [f"{temuan.id_temuan} · {temuan.kelompok_susut} · dugaan {temuan.kode_pola_dugaan} ({POLA.get(temuan.kode_pola_dugaan, temuan.judul)})."]
    lines.append(f"Skor aturan {temuan.skor} dari {temuan.jumlah_aturan} aturan ({temuan.semua_aturan}). Bukti: {temuan.bukti}.")
    lines.append(f"Perkiraan hilang {float(temuan.kwh_hilang_bulan or 0):,.0f} kWh/bln = {_rp(temuan.nilai_rp_bulan)}/bln; nilai harapan "
                 f"(skor × nilai × 3 bulan) {_rp(temuan.nilai_harapan_rp)} → {temuan.prioritas}.")
    lines.append(f"Usulan: {temuan.tindak_lanjut_usulan}. Status: {temuan.status_temuan}.")
    if temuan.jenis_objek == "Pelanggan":
        try:
            p = _o().PelangganGridDemo.get(temuan.kode_objek)
            lines.append(f"Pelanggan {p.golongan}, meter {p.jenis_meter}, AMI {p.ami}; pemakaian Q2 {p.kwh_bulan_q2} → Q3 {p.kwh_bulan_q3} kWh/bln"
                         + (f"; P2TL terakhir {p.p2tl_terakhir} ({p.golongan_pelanggaran_lalu or 'tidak ada pelanggaran'})." if p.p2tl_terakhir else "."))
        except Exception:  # noqa: BLE001
            pass
    return "\\n".join(lines)


@function
def pelanggan_berisiko_di_gardu(gardu: GarduDistribusiGridDemo) -> list[PelangganGridDemo]:
    """Pelanggan TR di gardu ini yang punya temuan (urut nilai harapan)."""
    o = _o().PelangganGridDemo
    out = [p for p in o.where(PelangganGridDemo.object_type.kode_dt == gardu.kode_dt).iterate() if p.id_temuan]
    return sorted(out, key=lambda p: -(p.nilai_harapan_rp or 0))


@function
def temuan_di_penyulang(penyulang: PenyulangGridDemo) -> list[TemuanSusutGridDemo]:
    """Semua temuan susut di penyulang ini (pelanggan TR/TM, gardu, penyulang)."""
    t = _o().TemuanSusutGridDemo
    return sorted(t.where(TemuanSusutGridDemo.object_type.kode_penyulang == penyulang.kode_penyulang).iterate(), key=lambda x: -(x.nilai_harapan_rp or 0))


@function
def tetangga_segolongan(pelanggan: PelangganGridDemo) -> list[PelangganGridDemo]:
    """Pelanggan lain dengan golongan tarif yang sama di gardu yang sama (pembanding pemakaian)."""
    o = _o().PelangganGridDemo
    if not pelanggan.kode_dt:
        return []
    return [p for p in o.where(PelangganGridDemo.object_type.kode_dt == pelanggan.kode_dt).iterate()
            if p.tarif == pelanggan.tarif and p.id_pelanggan != pelanggan.id_pelanggan]


@function
def nilai_susut_gardu_rp(gardu: GarduDistribusiGridDemo) -> Integer:
    """Nilai susut gardu per bulan (Rp), dengan harga rata-rata TR."""
    return int(float(gardu.nilai_susut_rp_bulan or 0))


@function
def simulasi_perbaikan_teknis(gardu: GarduDistribusiGridDemo) -> String:
    """What-if susut teknis: penyeimbangan beban (arus netral → 10%), sisip/uprating trafo (beban → 60%), rekonduktor JTR (R → 55%)."""
    kwh_q3 = float(gardu.kwh_keluar_q3 or 0)
    tl = kwh_q3 * float(gardu.susut_teknis_pct or 0) / 100 / 3
    n = float(gardu.rasio_arus_netral or 0)
    load = float(gardu.beban_puncak_pct or 0) / 100
    jtr = tl * 0.75
    bal = jtr * (1 - (1 + 1.6 * 0.01) / (1 + 1.6 * n * n)) if n > 0.1 else 0.0
    upr = jtr * (1 - (0.6 / load) ** 2) if load > 0.6 else 0.0
    rek = jtr * 0.45 if float(gardu.panjang_jtr_km or 0) > 1.8 or float(gardu.tegangan_ujung_min_v or 230) < 198 else 0.0
    best = max((bal, "penyeimbangan beban"), (upr, "sisip / uprating trafo"), (rek, "rekonduktor JTR"))
    lines = [f"Susut teknis sekarang ±{tl:,.0f} kWh/bln ({gardu.susut_teknis_pct}%)."]
    for v, label in ((bal, "Penyeimbangan beban"), (upr, "Sisip / uprating trafo"), (rek, "Rekonduktor JTR")):
        lines.append(f"• {label}: hemat ±{v:,.0f} kWh/bln ≈ {_rp(v * 1444.70)}/bln" if v > 0 else f"• {label}: tidak relevan untuk gardu ini")
    if best[0] > 0:
        lines.append(f"Usulan pertama: {best[1]}.")
    return "\\n".join(lines)
'''

FUNCTIONS_README = """# Fungsi Susut Jaringan Grid demo

Functions on the grid Nexus, published as release 1.0.0:

| Function | Input | Output | In Vertex / Workshop |
|---|---|---|---|
| alasan_susut_gardu | Gardu Distribusi | String | derived value: why the losses |
| alasan_temuan | Temuan Susut | String | derived value: explainable finding |
| pelanggan_berisiko_di_gardu | Gardu Distribusi | Pelanggan[] | function Search Around |
| temuan_di_penyulang | Penyulang | Temuan Susut[] | function Search Around |
| tetangga_segolongan | Pelanggan | Pelanggan[] | function Search Around (peer comparison) |
| nilai_susut_gardu_rp | Gardu Distribusi | Integer | derived value |
| simulasi_perbaikan_teknis | Gardu Distribusi | String | what-if for technical losses |
"""


def _ensure_functions() -> dict:
    import code_repos as cr
    import functions_registry as fr

    repo = next((r for r in cr.list_repos() if r["name"] == FUNCTIONS_REPO), None)
    if not repo:
        repo = cr.create_repo(cr.RepoIn(name=FUNCTIONS_REPO, description="Demo: functions on the grid loss Nexus (explainable losses and findings, "
                                                                          "customers behind a transformer's losses, technical what-ifs)."))
    d = fr._repo_data(repo["id"])
    if any(r["version"] == FUNCTIONS_VERSION for r in d["releases"]):
        return {"repo_id": repo["id"], "published": False}
    with cr._lock:
        rec = cr._repo(repo["id"])
        branch = rec["default_branch"]
        files = dict(rec["branches"][branch]["files"])
        files["README.md"] = FUNCTIONS_README
        files["python-functions/src/grid_fungsi/__init__.py"] = ""
        files["python-functions/src/grid_fungsi/susut.py"] = FUNCTIONS_PY
        commit = cr._commit(rec, branch, "Fungsi susut jaringan grid", files=files)
    release = fr.publish(repo["id"], FUNCTIONS_VERSION, commit["id"])
    return {"repo_id": repo["id"], "published": True, "functions": [f["name"] for f in release["functions"]]}


def _fn(name: str) -> Optional[dict]:
    import functions_registry as fr

    rid = STATE.get("functions_repo_id")
    return next((f for f in fr.all_functions() if f.get("repo_id") == rid and f["name"] == name), None)


# ------------------------------------------------------------------------------------------------
# the map: real transmission context + the demo distribution network
# ------------------------------------------------------------------------------------------------

MAP = "Demo: Peta susut jaringan grid Jawa Barat"


def _ensure_map() -> Optional[str]:
    import geospatial

    m = next((x for x in geospatial.list_maps() if x.get("name") == MAP), None)
    if m:
        return m["id"]
    ids = {k: (_type(k) or {}).get("id") for k in T}
    Lr = geospatial.Layer
    layers = [
        Lr(name="Kawasan industri Jabar (OSM, konteks)", kind="objects", color="#7c3aed", opacity=0.6,
           config={"object_type_id": ids["kawasan"], "property": "lokasi", "radius": 4, "label_key": "nama"}),
        Lr(name="SUTT 70 kV (OSM)", kind="objects", color="#0f766e", opacity=0.7,
           config={"object_type_id": ids["saluran_tx"], "property": "geometri", "line_width": 1.2, "filters": [{"property": "kelas_kv", "op": "eq", "value": 70}]}),
        Lr(name="SUTT 150 kV (OSM)", kind="objects", color="#d97706", opacity=0.8,
           config={"object_type_id": ids["saluran_tx"], "property": "geometri", "line_width": 1.8, "filters": [{"property": "kelas_kv", "op": "eq", "value": 150}]}),
        Lr(name="SUTET 500 kV (OSM)", kind="objects", color="#b4123a", opacity=0.9,
           config={"object_type_id": ids["saluran_tx"], "property": "geometri", "line_width": 3, "filters": [{"property": "kelas_kv", "op": "eq", "value": 500}]}),
        Lr(name="Gardu transmisi (OSM)", kind="objects", color="#1e293b", opacity=1.0,
           config={"object_type_id": ids["gardu_tx"], "property": "lokasi", "radius": 5, "color_by": "kelas", "color_mode": "category", "label_key": "nama"}),
        Lr(name="Penyulang 20 kV demo — warna = susut %", kind="objects", color="#22c55e", opacity=0.95,
           config={"object_type_id": ids["penyulang"], "property": "geometri", "line_width": 4.5, "color_by": "susut_pct", "color_mode": "range",
                   "color_from": "#22c55e", "color_to": "#dc2626", "label_key": "kode_penyulang"}),
        Lr(name="Gardu distribusi demo — status", kind="objects", color="#0f766e", opacity=1.0,
           config={"object_type_id": ids["gardu"], "property": "lokasi", "radius": 6, "color_by": "status_gardu", "color_mode": "category", "label_key": "kode_dt"}),
        Lr(name="Pelanggan dengan temuan P1/P2", kind="objects", color="#dc2626", opacity=1.0,
           config={"object_type_id": ids["pelanggan"], "property": "lokasi", "radius": 5, "color_by": "prioritas", "color_mode": "category",
                   "filters": [{"property": "prioritas", "op": "in", "value": ["P1", "P2"]}]}),
        Lr(name="GI demo", kind="objects", color="#1d4ed8", opacity=1.0,
           config={"object_type_id": ids["gi"], "property": "lokasi", "radius": 10, "label_key": "nama"}),
    ]
    m = geospatial.create_map(geospatial.MapIn(
        name=MAP, basemap="streets", view={"lat": -6.28, "lon": 107.15, "zoom": 12}, layers=layers,
        description="Demo: jaringan transmisi Jawa Barat yang nyata (OpenStreetMap, konteks: SUTET/SUTT, GITET/GI, kawasan industri) dan jaringan "
                    "distribusi demo di bawah GI Kawasan (model NUSAGRID) dan GI Cikarang Kota: penyulang diwarnai susut (hijau → merah), gardu "
                    "distribusi menurut status, pelanggan dengan temuan P1/P2. Angka susut hanya ada di aset demo yang fiktif."))
    return m["id"]


# ------------------------------------------------------------------------------------------------
# Vertex: the network as a graph (GI → feeder → transformer → customer → finding) and a template
# ------------------------------------------------------------------------------------------------

G_TOPO = "Demo: Topologi & susut jaringan grid — GI Cikarang Kota"
G_KAWASAN = "Demo: Penyulang kawasan & pelanggan TM berisiko"
G_TEMPLATE = "Demo: Telusuri gardu distribusi (grid)"


def _link_id(name: str) -> Optional[str]:
    return next((x["id"] for x in ontology._all("link-types") if x.get("display_name") == name), None)


def _vertex_layers() -> dict:
    ids = {k: (_type(k) or {}).get("id") for k in T}
    return {
        ids["gi"]: {"color": "#4c78c4", "label_property": "nama", "column": 0},
        ids["penyulang"]: {"color": "#22c55e", "label_property": "kode_penyulang", "size_property": "mwh_kirim_q3", "column": 1,
                           "rules": [{"property": "tingkat_susut", "op": "eq", "value": v, "color": c} for v, c in
                                     (("Kritis", "#dc2626"), ("Tinggi", "#f97316"), ("Sedang", "#facc15"))]},
        ids["gardu"]: {"color": "#22c55e", "label_property": "kode_dt", "size_property": "kwh_keluar_q3", "column": 2,
                       "rules": [{"property": "status_gardu", "op": "eq", "value": v, "color": c} for v, c in
                                 (("Susut NTL tinggi", "#dc2626"), ("Overload", "#a855f7"), ("Susut tinggi", "#f97316"), ("Perlu perhatian", "#facc15"))]},
        ids["pelanggan"]: {"color": "#94a3b8", "label_property": "id_pelanggan", "size_property": "nilai_harapan_rp", "column": 3,
                           "rules": [{"property": "prioritas", "op": "eq", "value": v, "color": c} for v, c in (("P1", "#dc2626"), ("P2", "#f97316"), ("P3", "#facc15"))]},
        ids["temuan"]: {"color": "#c53030", "label_property": "kode_pola_dugaan", "size_property": "nilai_harapan_rp", "column": 4},
        ids["inspeksi"]: {"color": "#b7791f", "label_property": "golongan", "column": 5},
    }


def _ensure_vertex() -> list[str]:
    import vertex

    import demo_grid_pipeline as gp

    s = gp.outputs("susut")
    ids = {k: (_type(k) or {}).get("id") for k in T}
    graphs = {g["name"] for g in vertex.list_graphs()}
    layers = _vertex_layers()
    made = []
    if G_TOPO not in graphs:
        nodes, seen = [], set()

        def add(k: str, pk: str) -> None:
            if pk and (k, pk) not in seen:
                seen.add((k, pk))
                nodes.append({"object_type_id": ids[k], "primary_key": pk})

        add("gi", "GI-KTA")
        hot = sorted((r for r in s["penyulang_status"] if r["kode_gi"] == "GI-KTA"), key=lambda r: -r["susut_pct"])
        for f in hot:
            add("penyulang", f["kode_penyulang"])
        top2 = {f["kode_penyulang"] for f in hot[:2]}
        for d in s["gardu_distribusi_status"]:
            if d["kode_penyulang"] in top2:
                add("gardu", d["kode_dt"])
        for t in s["temuan_susut"]:
            if t["kode_penyulang"] in top2 and t["jenis_objek"] == "Pelanggan" and t["prioritas"] in ("P1", "P2"):
                add("pelanggan", t["kode_objek"])
                add("temuan", t["id_temuan"])
        vertex.create_graph(vertex.GraphIn(
            name=G_TOPO, layout="flow", line_type="curved", layers=layers, nodes=nodes[:400],
            description="Demo: GI Cikarang Kota → 8 penyulang (merah = susut kritis) → gardu distribusi dua penyulang terparah (merah = NTL tinggi, "
                        "ungu = overload) → pelanggan dengan temuan P1/P2 → temuannya. Pilih gardu lalu jalankan function alasan_susut_gardu atau "
                        "pelanggan_berisiko_di_gardu dari Search Around."))
        made.append(G_TOPO)
    if G_KAWASAN not in graphs:
        nodes = [{"object_type_id": ids["gi"], "primary_key": "GI-KWS"}]
        nodes += [{"object_type_id": ids["penyulang"], "primary_key": r["kode_penyulang"]} for r in s["penyulang_status"] if r["kode_gi"] == "GI-KWS"]
        for t in s["temuan_susut"]:
            if t["kode_ulp"] == "ULP-KWS":
                if t["jenis_objek"] == "Pelanggan":
                    nodes.append({"object_type_id": ids["pelanggan"], "primary_key": t["kode_objek"]})
                nodes.append({"object_type_id": ids["temuan"], "primary_key": t["id_temuan"]})
        vertex.create_graph(vertex.GraphIn(
            name=G_KAWASAN, layout="flow", line_type="curved", layers=layers, nodes=nodes,
            description="Demo: GI Kawasan (model NUSAGRID SCADA) → 6 penyulang 20 kV → tenant TM dengan temuan (CT/PT, faktor kali, WBP, demand) "
                        "dan temuan penyulang (NTL tak terjelaskan). Sedikit kasus, nilai besar: bandingkan ukuran node (nilai harapan)."))
        made.append(G_KAWASAN)
    if G_TEMPLATE not in graphs:
        pg, tg, ng, pi, gp_ = (_link_id("Customer on distribution substation (grid demo)"), _link_id("Loss finding at substation (grid demo)"), _link_id("Substation energy balance (grid demo)"),
                               _link_id("P2TL meter inspection of customer (grid demo)"), _link_id("Distribution substation on feeder (grid demo)"))
        tp = _link_id("Loss finding for customer (grid demo)")
        chains = [[(gp_, "forward")], [(tg, "reverse")], [(ng, "reverse")],
                  [(pg, "reverse")], [(pg, "reverse"), (tp, "reverse")], [(pg, "reverse"), (pi, "reverse")]]
        vertex.create_graph(vertex.GraphIn(
            name=G_TEMPLATE, layout="flow", line_type="curved", layers=layers,
            description="Demo: pilih gardu distribusi → penyulangnya, neraca bulanan, temuan gardu, pelanggan TR (dengan temuan dan riwayat P2TL).",
            template={"parameters": [{"id": "gardu", "name": "Gardu distribusi", "object_type_id": ids["gardu"],
                                      "search_arounds": [{"steps": [{"link_type_id": x, "direction": dr} for x, dr in ch]} for ch in chains if all(x for x, _ in ch)]}]}))
        made.append(G_TEMPLATE)
    return made


# ------------------------------------------------------------------------------------------------
# Workshop: the loss team's cockpit
# ------------------------------------------------------------------------------------------------

WORKSHOP = "Demo: Kokpit susut & keandalan grid"
RP = {"": {"prefix": "Rp ", "notation": "compact", "max_fraction": 1}}


def _ensure_workshop() -> Optional[str]:
    import workshop

    if any(m.get("name") == WORKSHOP for m in workshop.list_modules()):
        return None
    tm, gd, py = _type("temuan"), _type("gardu"), _type("penyulang")
    src = {"kind": "object_type", "id": tm["id"]}
    gsrc = {"kind": "object_type", "id": gd["id"]}
    psrc = {"kind": "object_type", "id": py["id"]}
    fn = _fn("alasan_temuan")
    acts = [a["id"] for a in (_action(n) for n in ("Jadikan target P2TL (demo)", "Tetapkan status temuan susut (demo)", "Eskalasi temuan bernilai besar (demo)")) if a]
    w: list[dict] = []

    def add(kind: str, title: str, x: int, y: int, wd: int, h: int, config: dict) -> None:
        w.append({"id": f"w{len(w) + 1}", "type": kind, "title": title, "x": x, "y": y, "w": wd, "h": h, "config": config})

    add("text", "", 0, 0, 12, 2, {"text": "**Kokpit susut & keandalan grid (demo)** — pilih temuan di tabel: penjelasannya (function `alasan_temuan`) dan "
                                          "keputusan tim susut (actions) mengikuti pilihan itu. Prioritas = nilai harapan (skor × nilai × 3 bulan), bukan skor saja. "
                                          "Data: pipeline neraca energi & susut grid (demo)."})
    add("metric", "Temuan P1", 0, 2, 3, 3, {"source": src, "metric": "count", "label": "temuan prioritas P1", "filters": [{"column": "prioritas", "op": "eq", "value": "P1"}]})
    add("metric", "Nilai harapan (Rp)", 3, 2, 3, 3, {"source": src, "metric": "sum", "metric_column": "nilai_harapan_rp", "label": "jumlah nilai harapan semua temuan", "formats": RP})
    add("metric", "Susut penyulang rata-rata (%)", 6, 2, 3, 3, {"source": psrc, "metric": "avg", "metric_column": "susut_pct", "label": "rata-rata 14 penyulang, Jul–Sep"})
    add("metric", "Gardu NTL tinggi", 9, 2, 3, 3, {"source": gsrc, "metric": "count", "label": "status gardu: Susut NTL tinggi",
                                                   "filters": [{"column": "status_gardu", "op": "eq", "value": "Susut NTL tinggi"}]})
    add("filter", "ULP", 0, 5, 4, 2, {"source": src, "column": "kode_ulp", "label": "ULP"})
    add("filter", "Kelompok susut", 4, 5, 4, 2, {"source": src, "column": "kelompok_susut", "label": "kelompok"})
    add("filter", "Prioritas", 8, 5, 4, 2, {"source": src, "column": "prioritas", "label": "prioritas"})
    add("bar", "Nilai harapan per pola dugaan", 0, 7, 4, 6, {"source": src, "group_by": "kode_pola_dugaan", "metric": "sum", "metric_column": "nilai_harapan_rp"})
    add("table", "Temuan (urut nilai harapan)", 4, 7, 8, 6, {"source": src, "sort": "nilai_harapan_rp", "descending": True, "limit": 200,
                                                             "columns": ["id_temuan", "kode_objek", "kode_pola_dugaan", "judul", "skor", "nilai_harapan_rp", "prioritas", "status_temuan"]})
    if fn:
        add("function", "Mengapa temuan ini? (ƒ alasan_temuan)", 0, 13, 7, 6, {"function_id": fn["id"], "object_type_id": tm["id"], "object_input": "temuan", "function_inputs": {}})
    if acts:
        add("inline_action", "Keputusan tim susut", 7, 13, 5, 6, {"action_ids": acts, "action_type_id": acts[0]})
    add("bar", "Susut per penyulang (%)", 0, 19, 6, 6, {"source": psrc, "group_by": "kode_penyulang", "metric": "max", "metric_column": "susut_pct"})
    add("table", "Gardu distribusi (urut susut)", 6, 19, 6, 6, {"source": gsrc, "sort": "susut_pct", "descending": True, "limit": 102,
                                                                "columns": ["kode_dt", "status_gardu", "susut_pct", "susut_teknis_pct", "susut_non_teknis_pct", "beban_puncak_pct"]})
    m = workshop.create_module(workshop.ModuleIn(
        name=WORKSHOP, widgets=w, folder_id=STATE.get("folders", {}).get("apps") or STATE.get("project_id"),
        description="Demo: kokpit tim susut di atas Nexus grid — temuan berprioritas nilai, penjelasan (function), keputusan (actions), susut per "
                    "penyulang dan gardu."))
    STATE["workshop_id"] = m["id"]
    _save()
    return m["id"]


ML_WIDGET = "Pelanggan berskor NTL tertinggi (model, urut nilai harapan)"


def _workshop_ml() -> Optional[str]:
    """The cockpit gains the model's view once the scores back the customers: who the model would visit first."""
    import workshop

    m = next((x for x in workshop.list_modules() if x.get("name") == WORKSHOP), None)
    pl = _type("pelanggan")
    if not m or not pl or not any(p["api_name"] == "nilai_harapan_ml_rp" for p in ontology._object_type(pl["id"])["properties"]):
        return None
    full = workshop.get_module(m["id"], count=False)
    widgets = list(full.get("widgets") or [])
    if any(w.get("title") == ML_WIDGET for w in widgets):
        return None
    widgets.append({"id": f"w{len(widgets) + 1}", "type": "table", "title": ML_WIDGET, "x": 0, "y": 25, "w": 12, "h": 7,
                    "config": {"source": {"kind": "object_type", "id": pl["id"]}, "sort": "nilai_harapan_ml_rp", "descending": True, "limit": 100,
                               "columns": ["id_pelanggan", "segmen", "tegangan", "golongan", "skor_ntl", "prob_temuan", "skor_anomali",
                                           "nilai_harapan_ml_rp", "status_ml", "pola_dugaan", "alasan_ml"]}})
    workshop.save_module(m["id"], workshop.ModuleIn(widgets=widgets, settings=full.get("settings") or {},
                                                    version_note="Skor model NTL: pelanggan urut nilai harapan model"))
    return ML_WIDGET


# ------------------------------------------------------------------------------------------------
# lineage: the case as a saved graph
# ------------------------------------------------------------------------------------------------

LINEAGE_GRAPH = "gridsusut"


def _ensure_lineage_graph() -> dict:
    import lineage

    g = lineage.graph()
    nodes = {n["id"]: n for n in g["nodes"]}
    up: dict[str, set] = {}
    down: dict[str, set] = {}
    for e in g["edges"]:
        down.setdefault(e["from"], set()).add(e["to"])
        up.setdefault(e["to"], set()).add(e["from"])

    def walk(start: list[str], nbrs: dict[str, set]) -> set[str]:
        seen: set[str] = set()
        todo = list(start)
        while todo:
            for w in nbrs.get(todo.pop(), ()):
                if w not in seen:
                    seen.add(w)
                    todo.append(w)
        return seen

    names = {v[0] for v in T.values()}
    seeds = [nid for nid, n in nodes.items() if n["kind"] == "object_type" and n["name"] in names]
    desc = walk(seeds, down)
    case = set(seeds) | walk(seeds, up) | desc
    for v in list(desc):
        case |= {w for w in up.get(v, ()) if nodes[w]["kind"] in ("model", "function", "action", "transform")}
    rec = lineage.save_graph(lineage.SavedGraph(name="Lineage susut jaringan grid (demo)", nodes=sorted(case), color_by="type"), id=LINEAGE_GRAPH)
    kinds: dict[str, int] = {}
    for v in case:
        kinds[nodes[v]["kind"]] = kinds.get(nodes[v]["kind"], 0) + 1
    return {"graph": rec["id"], "nodes": len(case), "kinds": kinds}


def _ensure_portal_apps() -> dict:
    import agentic_apps

    listed = []
    if STATE.get("workshop_id"):
        listed.append(agentic_apps.register(agentic_apps.AppIn(
            name="Kokpit Susut & Keandalan Grid", kind="workshop", resource_id=STATE["workshop_id"], icon="gauge", collection="Grid Management",
            description="Kokpit Workshop: temuan susut berprioritas nilai, penjelasan (function), keputusan tim susut (actions), susut per penyulang dan gardu.",
            tags=["grid", "susut", "demo"]))["id"])
    return {"listed": listed}


# ------------------------------------------------------------------------------------------------
# build and status
# ------------------------------------------------------------------------------------------------

@router.post("")
def build() -> dict:
    """Build (or complete) the grid demo; nothing existing is changed or deleted."""
    with _lock:
        steps: list[dict] = []

        def step(key: str, fn) -> Any:
            try:
                out = fn()
                steps.append({"step": key, "ok": True, "result": out})
                return out
            except Exception as e:  # noqa: BLE001
                log.exception("demo grid: %s failed", key)
                steps.append({"step": key, "ok": False, "error": str(getattr(e, "detail", e))[:500]})
                return None

        files = step("files", _ensure_files)
        if files:
            STATE.update(project_id=files["project_id"], folders=files["folders"], rows=files["rows"])
            _save()
            step("pipelines", lambda: _ensure_pipelines(files))
            step("nexus", lambda: _ensure_types(files))
        step("links", _ensure_links)
        step("edit_history", _enable_history)
        step("actions", _ensure_actions)
        fn = step("functions", _ensure_functions)
        if fn:
            STATE.update(functions_repo_id=fn["repo_id"])
        step("ml", lambda: __import__("demo_grid_ml").build(STATE, _save))
        step("iot", lambda: __import__("demo_grid_iot").build(STATE, _save))
        step("ami", lambda: __import__("demo_grid_ami").build(STATE, _save))
        step("ntl_stream", lambda: __import__("demo_grid_ntl_stream").build(STATE, _save))
        step("ami_nexus", lambda: __import__("demo_grid_ami_nexus").build(STATE, _save))
        step("sensor_gardu", lambda: __import__("demo_grid_sensor_gardu").build(STATE, _save))
        step("feedback", lambda: __import__("demo_grid_feedback").build(STATE, _save))
        step("penutup", lambda: __import__("demo_grid_penutup").build(STATE, _save))
        step("konteks", lambda: __import__("demo_grid_konteks").build(STATE, _save))
        step("peta_jabar", lambda: __import__("demo_grid_peta_jabar").build(STATE, _save))
        step("peta_jawa_bali", lambda: __import__("demo_grid_peta_jawa_bali").build(STATE, _save))
        step("peta_gabungan", lambda: __import__("demo_grid_peta_gabungan").build(STATE, _save))
        step("integrasi", lambda: __import__("demo_grid_integrasi").build(STATE, _save))
        step("governance", lambda: __import__("demo_grid_governance").build(STATE, _save))
        step("ops", lambda: __import__("demo_grid_ops").build(STATE, _save))
        step("akses", lambda: __import__("demo_grid_akses").build(STATE, _save))
        step("analitik", lambda: __import__("demo_grid_analitik").build(STATE.setdefault("analitik", {}), _save))
        step("operasi", lambda: __import__("demo_grid_operasi").build(STATE, _save))
        step("referensi", lambda: __import__("demo_grid_referensi").build(STATE, _save))
        step("descriptions", lambda: __import__("demo_grid_descriptions").apply())
        step("map",lambda: STATE.update(map_id=_ensure_map()) or STATE.get("map_id"))
        step("vertex", _ensure_vertex)
        step("workshop", _ensure_workshop)
        step("workshop_ml", _workshop_ml)
        step("portal_apps", _ensure_portal_apps)
        step("lineage_graph", _ensure_lineage_graph)
        STATE.update(built_at=_now(), steps=steps)
        _save()
    return status()


@router.get("")
def status() -> dict:
    return {**{k: v for k, v in STATE.items() if k != "steps"}, "steps": [{k: v for k, v in s.items() if k != "result"} for s in STATE.get("steps") or []]}


# ------------------------------------------------------------------------------------------------
# the overview page (/demo-grid): live numbers from the Nexus, the pipelines' graphs, the apps
# ------------------------------------------------------------------------------------------------

EXTRA_TYPES = ("Grid Field Crew (demo)", "Grid P2TL Field Visit (demo)")


def _objs(key: str) -> list[dict]:
    """The objects of a type as the caller sees them: none without the type's markings, only the rows its object policy
    lets through (per ULP), properties its property policies hide read as null."""
    from fastapi import HTTPException

    t = _type(key)
    if not t:
        return []
    try:
        rec = ontology._object_type(t["id"])
        objs = ontology._objects(t["id"])
    except HTTPException:
        return []
    return [{**(ontology._public_object(rec, pk, o).get("properties") or {}), "_pk": pk} for pk, o in objs.items() if ontology._can_see(rec, o)]


def _nexus_part() -> dict:
    from fastapi import HTTPException

    import functions_registry as fr

    types = [t for t in (_type(k) for k in T) if t] + [t for t in ontology._all("object-types") if t["display_name"] in EXTRA_TYPES]
    ids = {t["id"] for t in types}
    nodes = []
    for t in types:
        try:
            rec = ontology._object_type(t["id"])
            count = sum(1 for o in ontology._objects(t["id"]).values() if ontology._can_see(rec, o))
        except HTTPException:  # a type the caller may not open (its markings): listed, without its objects
            rec, count = {**t, "properties": t.get("properties") or []}, 0
        b = rec.get("backing_dataset") or {}
        nodes.append({"id": t["id"], "name": t["display_name"], "api_name": t["api_name"], "color": t.get("color"), "description": t.get("description") or "",
                      "objects": count, "properties": len(rec["properties"]), "dataset": b.get("name"),
                      "extra_datasources": len(rec.get("additional_datasources") or []),
                      "time_series": sorted(((rec.get("time_series") or {}).get("properties") or {}).keys())})
    links = [{"id": lt["id"], "name": lt.get("display_name") or "", "source": lt["source"]["object_type_id"], "target": lt["target"]["object_type_id"]}
             for lt in ontology._all("link-types") if lt["source"]["object_type_id"] in ids and lt["target"]["object_type_id"] in ids]
    actions = [{"id": a["id"], "name": a["display_name"], "object_type_id": a.get("object_type_id"), "kind": a.get("kind"), "description": a.get("description") or ""}
               for a in ontology._all("action-types") if a.get("object_type_id") in ids]
    rid = STATE.get("functions_repo_id")
    fns = [{"id": f["id"], "name": f["name"], "doc": f.get("doc") or "", "output": str(f.get("output") or "")} for f in fr.all_functions() if f.get("repo_id") == rid]
    return {"object_types": nodes, "link_types": links, "action_types": actions, "functions": fns}


def _ulp(pny: list[dict]) -> list[dict]:
    names = {"ULP-KWS": "ULP Demo Kawasan Industri", "ULP-KTU": "ULP Demo Cikarang Utara", "ULP-KTS": "ULP Demo Cikarang Selatan"}
    ulp: dict[str, dict] = {}
    for p in pny:
        k = p.get("kode_ulp") or "-"
        u = ulp.setdefault(k, {"kode_ulp": k, "nama": names.get(k, k), "mwh_kirim": 0.0, "susut_mwh": 0.0, "tl_mwh": 0.0, "ntl_mwh": 0.0, "penyulang": 0})
        mwh = float(p.get("mwh_kirim_q3") or 0)
        u["mwh_kirim"] += mwh
        u["susut_mwh"] += mwh * float(p.get("susut_pct") or 0) / 100
        u["tl_mwh"] += mwh * float(p.get("susut_teknis_pct") or 0) / 100
        u["ntl_mwh"] += mwh * float(p.get("susut_non_teknis_pct") or 0) / 100
        u["penyulang"] += 1
    for u in ulp.values():
        k = max(u["mwh_kirim"], 1e-9)
        u.update(susut_pct=round(100 * u["susut_mwh"] / k, 2), tl_pct=round(100 * u["tl_mwh"] / k, 2), ntl_pct=round(100 * u["ntl_mwh"] / k, 2))
    return sorted(ulp.values(), key=lambda u: u["kode_ulp"])


@router.get("/overview")
def overview() -> dict:
    import auth
    import dynamic_scheduling as dsch
    import machinery as mc
    import vertex

    import demo_grid_pipeline as gp

    auth.require_user()
    pny, gardu, temuan, insp = _objs("penyulang"), _objs("gardu"), _objs("temuan"), _objs("inspeksi")
    per_pola: dict[str, dict] = {}
    for t in temuan:
        r = per_pola.setdefault(t.get("kode_pola_dugaan") or "-", {"pola": t.get("kode_pola_dugaan"), "judul": t.get("judul"), "kelompok": t.get("kelompok_susut"),
                                                                    "temuan": 0, "nilai_harapan_rp": 0.0})
        r["temuan"] += 1
        r["nilai_harapan_rp"] += float(t.get("nilai_harapan_rp") or 0)
    top = sorted(temuan, key=lambda t: -float(t.get("nilai_harapan_rp") or 0))[:15]
    eff: dict[str, dict] = {}
    for i in insp:
        r = eff.setdefault(i.get("dasar_pemilihan") or "-", {"dasar": i.get("dasar_pemilihan"), "pemeriksaan": 0, "temuan": 0, "rp": 0.0})
        r["pemeriksaan"] += 1
        r["temuan"] += int(i.get("ditemukan_pelanggaran") or 0)
        r["rp"] += float(i.get("rp_tagihan_susulan") or 0)
    exp = STATE.get("ml_experiment") or {}
    tables = exp.get("tables") or {}

    def rows(name: str) -> list[dict]:
        tb = tables.get(name) or {}
        return [dict(zip(tb.get("columns") or [], r)) for r in tb.get("rows") or []]

    backed = {v[4][1] for v in T.values() if v[4]}
    pipes = {}
    for k in gp.PIPELINES:
        g = gp.lineage(k)
        for o in g["outputs"]:
            o["backs"] = o["name"] in backed
        spec = gp.PIPELINES[k]["spec"]()
        pipes[k] = {"id": (STATE.get("pipelines") or {}).get(k, {}).get("id"), **g, "sql": {n["name"]: n["sql"] for n in spec if n["kind"] == "sql"},
                    "rows": {n: c for n, c in (STATE.get("rows") or {}).items()},
                    "backs": {v[4][1]: v[0] for v in T.values() if v[4] and v[4][0] == k}}
    graphs = {g["name"]: g["id"] for g in vertex.list_graphs()}
    board = next((b["id"] for b in dsch.list_boards() if b.get("name") == "Demo: Jadwal kunjungan P2TL grid"), None)
    mach = next((r["id"] for r in mc._all() if r["name"] == "Device and Machinery — gardu distribusi grid (demo)"), None)
    keep = ("id_temuan", "kode_objek", "jenis_objek", "kelompok_susut", "kode_pola_dugaan", "judul", "skor", "bukti", "nilai_harapan_rp", "prioritas",
            "status_temuan", "segmen", "tegangan", "kode_penyulang")
    return {
        "project": PROJECT, "project_id": STATE.get("project_id"), "built_at": STATE.get("built_at"),
        "steps": [{k: v for k, v in s.items() if k != "result"} for s in STATE.get("steps") or []],
        "ulp": _ulp(pny),
        "penyulang": sorted(({k: p.get(k) for k in ("kode_penyulang", "nama", "kode_ulp", "jenis", "mwh_kirim_q3", "susut_pct", "susut_teknis_pct",
                                                    "susut_non_teknis_pct", "saidi_menit", "saifi_kali", "tingkat_susut", "jumlah_temuan", "nilai_harapan_rp")}
                             for p in pny), key=lambda p: p["kode_penyulang"] or ""),
        "gardu": {"total": len(gardu), "per_status": {s: sum(1 for g in gardu if g.get("status_gardu") == s) for s in sorted({g.get("status_gardu") for g in gardu if g.get("status_gardu")})}},
        "temuan": {"total": len(temuan), "per_prioritas": {p: sum(1 for t in temuan if t.get("prioritas") == p) for p in ("P1", "P2", "P3")},
                   "per_status": {s: sum(1 for t in temuan if t.get("status_temuan") == s) for s in sorted({t.get("status_temuan") for t in temuan if t.get("status_temuan")})},
                   "nilai_harapan_rp": sum(float(t.get("nilai_harapan_rp") or 0) for t in temuan),
                   "per_pola": sorted(per_pola.values(), key=lambda r: -r["nilai_harapan_rp"]),
                   "top": [{k: t.get(k) for k in keep} for t in top]},
        "p2tl": sorted(eff.values(), key=lambda r: -r["pemeriksaan"]),
        "ml": {"strategi": rows("strategi_pemilihan_target"), "bias": rows("bias_label_p2tl"), "target": rows("target_teratas"), "params": exp.get("params"),
               "metrics": exp.get("metrics")},
        "pipelines": pipes,
        "nexus": _nexus_part(),
        "object_counts": {n["name"]: n["objects"] for n in _nexus_part()["object_types"]},
        "apps": {"map": STATE.get("map_id"), "workshop": STATE.get("workshop_id"), "lineage_graph": LINEAGE_GRAPH,
                 "vertex": {"topologi": graphs.get(G_TOPO), "kawasan": graphs.get(G_KAWASAN), "template": graphs.get(G_TEMPLATE)},
                 "functions_repo": STATE.get("functions_repo_id"), "ml_pipeline": STATE.get("scoring_pipeline_id"), "iot_pipeline": STATE.get("iot_pipeline_id"),
                 "syncs": STATE.get("iot_syncs"), "board": board, "machinery": mach, "governance": STATE.get("gov_items"), "markings": STATE.get("gov_markings"),
                 "analitik": {k: v for k, v in (STATE.get("analitik") or {}).items() if k in ("rules_workflow", "scenarios", "quiver", "contour")}},
    }
