"""The JKN audit team's workspace (GET /api/demo/jkn/workbench…): what the screening rules and the anomaly models say,
facility by facility, on the Ontology the end-to-end demo builds (demo_jkn_e2e.py, demo_jkn_ml.py).

- "" — the work queue: every audited facility with its rule risk score, the anomaly score of its doctors, a combined
  priority (65 % rules, 35 % anomaly models, raised to the top for investigations), its cases, the value at risk and
  the audit team's state; the action types the page offers; the filters.
- /faskes/{kode} — one facility's file: why it scores what it does (the alasan_risiko function), its monthly claims
  trend, its risky cases, its doctors with their anomaly scores and Shapley reasons, the flagged claims behind the
  cases (with rule and ICD-10 context), and the decision history (edit history of the facility and its cases).
- /pola-baru — doctors the anomaly models flag (≥ 5 of 8 detectors) without any audit case: new patterns to look into.
- /kasus — every risky case, for the case queue.
- /export.csv — the work queue as CSV.
- /iot — the IoT pilot (demo_jkn_iot.py): devices, the device × day reconciliation matrix, the findings with their
  verification state, the KPIs and where the pieces live (pipeline, time series sync, Vertex, map, Machinery).
- /iot/temuan/{id} — one finding's evidence chain, from the decision down to the raw data: the decision and its history,
  the reconciliation with the rule applied, each device's power that day (from the Time Series DB) with its cycles,
  the claim lines and their doctors, and the raw meter readings and raw claim lines they were cleaned from.

Read-only; decisions are taken with the action types (the page's forms apply them through the Ontology).
"""

from __future__ import annotations

import csv
import io
import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

import ontology

router = APIRouter(prefix="/api/demo/jkn/workbench")

W_RULES, W_ML = 0.65, 0.35
# IoT evidence raises a facility (up to +15 points at 7 or more days of procedures the devices do not support)
W_IOT, IOT_DAYS = 0.15, 7
_CACHE: dict = {}


def _types() -> dict:
    import demo_jkn_map as jm

    out = {}
    import demo_jkn_iot as iot

    for key, name in (("faskes", jm.FASKES), ("kasus", jm.KASUS), ("dokter", jm.DOKTER), ("klaim", "Klaim JKN (demo)"), ("alat", iot.ALAT),
                      ("temuan", iot.TEMUAN), ("tindakan", iot.TINDAKAN)):
        t = jm._type(name)
        if t:
            out[key] = t
    if not {"faskes", "kasus", "dokter"} <= set(out):
        raise HTTPException(404, "the end-to-end demo has not been built yet")
    return out


def _props(tid: str) -> dict[str, dict]:
    return {pk: (o.get("properties") or {}) for pk, o in ontology.stored_objects(tid).items()}


def _priority(f: dict) -> int:
    rules = float(f.get("skor_risiko") or 0) / 100
    ml = float(f.get("skor_anomali_maks") or 0)
    p = min(1.0, W_RULES * rules + W_ML * ml + W_IOT * min(1.0, float(f.get("iot_hari_temuan") or 0) / IOT_DAYS))
    if f.get("status_audit") == "Dalam Investigasi":
        # under investigation: always on top, ordered among themselves by the same score
        p = 0.9 + 0.1 * p
    return int(round(100 * p))


def _tier(f: dict, prio: int) -> str:
    if f.get("status_audit") == "Selesai Diaudit":
        return "Selesai"
    if f.get("status_audit") == "Dalam Investigasi" or prio >= 70:
        return "P1"
    if prio >= 50 or (f.get("dokter_pola_baru") or 0) > 0:
        return "P2"
    if prio >= 35:
        return "P3"
    return "Pantau"


def _edited() -> dict[str, set]:
    import ontology_edits

    t = _types()
    return {k: {pk for pk, e in ontology_edits.layer(t[k]["id"]).items() if e.get("properties")} for k in ("faskes", "kasus", "dokter")}


def _actions() -> dict[str, list[dict]]:
    t = _types()
    by = {t[k]["id"]: k for k in ("faskes", "kasus", "dokter", "temuan") if k in t}
    out: dict[str, list[dict]] = {"faskes": [], "kasus": [], "dokter": [], "temuan": []}
    for a in ontology._all("action-types"):
        k = by.get(a.get("object_type_id"))
        if k and "(demo)" in a["display_name"]:
            out[k].append({"id": a["id"], "name": a["display_name"].replace(" (demo)", ""), "description": a.get("description") or ""})
    return out


def _apps() -> dict:
    """Where the same objects live in the other apps (the map, Vertex, Workshop, the overview page)."""
    import demo_jkn_e2e as e
    import demo_jkn_map as jm
    import geospatial
    import vertex

    graphs = {g["name"]: g["id"] for g in vertex.list_graphs()}
    maps = {m["name"]: m["id"] for m in geospatial.list_maps()}
    return {"map": maps.get(jm.MAP), "template": graphs.get(jm.G_TEMPLATE), "graph_ops": graphs.get(e.G_OPS), "workshop": e.STATE.get("workshop_id"),
            "pipeline": e.STATE.get("pipeline_id"), "scoring_pipeline": e.STATE.get("scoring_pipeline_id")}


@router.get("")
def queue() -> dict:
    t = _types()
    faskes = _props(t["faskes"]["id"])
    edited = _edited()
    rows = []
    for kode, f in faskes.items():
        prio = _priority(f)
        rows.append({
            "kode": kode, "nama": f.get("nama"), "jenis": f.get("jenis"), "tingkat": f.get("tingkat"), "wilayah": f.get("wilayah"),
            "kantor_cabang": f.get("kantor_cabang"), "status_audit": f.get("status_audit"), "skor_risiko": f.get("skor_risiko"),
            "skor_anomali": f.get("skor_anomali_maks"), "dokter_anomali": f.get("dokter_anomali") or 0, "dokter_pola_baru": f.get("dokter_pola_baru") or 0,
            "prioritas": prio, "tingkat_prioritas": _tier(f, prio), "indikasi_utama": f.get("indikasi_utama"), "jumlah_kasus": f.get("jumlah_kasus") or 0,
            "klaim_berisiko": f.get("klaim_berisiko") or 0, "potensi_kerugian_rp": f.get("potensi_kerugian_rp") or 0, "pengembalian_rp": f.get("pengembalian_rp") or 0,
            "tim_audit": f.get("tim_audit"), "tanggal_audit": f.get("tanggal_audit"), "diputuskan": kode in edited["faskes"],
            "lokasi": f.get("lokasi"), "iot_status": f.get("iot_status"), "iot_hari_temuan": f.get("iot_hari_temuan") or 0,
            "iot_tindakan_tak_didukung": f.get("iot_tindakan_tak_didukung") or 0, "iot_nilai_tak_didukung_rp": f.get("iot_nilai_tak_didukung_rp") or 0,
        })
    # open work first (P1 … Pantau), closed audits last; within a tier by priority
    order = {"P1": 0, "P2": 1, "P3": 2, "Pantau": 3, "Selesai": 4}
    rows.sort(key=lambda r: (order.get(r["tingkat_prioritas"], 5), -r["prioritas"], r["kode"]))
    for i, r in enumerate(rows, 1):
        r["urutan"] = i
    dokter = _props(t["dokter"]["id"])
    kasus = _props(t["kasus"]["id"])
    open_rows = [r for r in rows if r["status_audit"] != "Selesai Diaudit"]
    return {
        "types": {k: v["id"] for k, v in t.items()}, "actions": _actions(), "faskes": rows, "apps": _apps(),
        "kpi": {
            "faskes": len(rows), "p1": sum(1 for r in rows if r["tingkat_prioritas"] == "P1"), "p2": sum(1 for r in rows if r["tingkat_prioritas"] == "P2"),
            "kasus": len(kasus), "kasus_ditindaklanjuti": sum(1 for p in kasus.values() if p.get("tindak_lanjut")),
            "pola_baru": sum(1 for p in dokter.values() if "pola baru" in str(p.get("status_anomali") or "")),
            "potensi_kerugian_rp": sum(r["potensi_kerugian_rp"] for r in open_rows), "pengembalian_rp": sum(r["pengembalian_rp"] for r in rows),
            "keputusan": len(edited["faskes"]) + len(edited["kasus"]) + len(edited["dokter"]),
            "iot_faskes": sum(1 for r in rows if r["iot_hari_temuan"]), "iot_nilai_rp": sum(r["iot_nilai_tak_didukung_rp"] for r in rows),
        },
        "filters": {"kantor_cabang": sorted({r["kantor_cabang"] for r in rows if r["kantor_cabang"]}), "jenis": sorted({r["jenis"] for r in rows if r["jenis"]}),
                    "status": ["Sehat", "Perlu Pemantauan", "Ada Indikasi Fraud", "Dalam Investigasi", "Selesai Diaudit"]},
        "bobot": {"aturan": W_RULES, "anomali": W_ML, "iot": W_IOT, "iot_hari": IOT_DAYS},
    }


def _dataset_item(folder: str, name: str) -> Optional[dict]:
    """A dataset of the demo project by folder path (clean, ml, iot, raw/iot) and name."""
    import demo_jkn_e2e as e
    import drive

    f = e._folder(None, e.PROJECT, "project")
    for part in folder.split("/"):
        f = e._folder(f, part)
    return next((x for x in drive.list_files(f) if x["name"] == f"{name}.parquet" and not x.get("trashed_at")), None)


def _clean_file(folder: str, name: str) -> list[dict]:
    """A dataset of the demo project (clean/, ml/, iot/, raw/iot/), cached by its version."""
    import drive
    import pyarrow.parquet as pq

    item = _dataset_item(folder, name)
    if not item:
        return []
    key = (item["id"], str(item.get("updated_at")))
    hit = _CACHE.get(f"{folder}/{name}")
    if hit and hit[0] == key:
        return hit[1]
    rows = pq.read_table(io.BytesIO(drive.read_bytes(drive._item(item["id"])))).to_pylist()
    _CACHE[f"{folder}/{name}"] = (key, rows)
    return rows


def _explain(kode: str) -> Optional[str]:
    import demo_jkn_e2e as e
    import functions_registry as fr

    rid = e.STATE.get("functions_repo_id")
    fn = next((f for f in fr.all_functions() if f.get("repo_id") == rid and f["name"] == "alasan_risiko"), None)
    if not fn:
        return None
    res = fr.run_function(fn["id"], None, {"faskes": kode}, {"resource": "workbench"})
    return res.get("value") if res.get("ok") else None


def _history(tid: str, pk: str) -> list[dict]:
    """The object's edit history; for decisions taken before history was on, the edit layer's current values."""
    import ontology_edits

    try:
        entries = ontology_edits.edit_history(tid, pk).get("entries") or []
    except HTTPException:
        entries = []
    if not entries:
        e = ontology_edits.layer(tid).get(str(pk)) or {}
        if e.get("properties"):
            entries = [{"at": e.get("at"), "user": None, "op": "modify", "changes": {k: [None, v] for k, v in e["properties"].items()}}]
    return entries


@router.get("/faskes/{kode}")
def facility(kode: str) -> dict:
    t = _types()
    faskes = _props(t["faskes"]["id"])
    f = faskes.get(kode)
    if not f:
        raise HTTPException(404, "facility not found")
    kasus = [{"id_kasus": pk, **p} for pk, p in _props(t["kasus"]["id"]).items() if kode in (p.get("faskes_asal"), p.get("faskes_tujuan"))]
    kasus.sort(key=lambda k: -(k.get("nilai_klaim_rp") or 0))
    in_cases = {k.get("dokter_perujuk") for k in kasus} | {k.get("dokter_dpjp") for k in kasus}
    dokter = []
    for pk, p in _props(t["dokter"]["id"]).items():
        if p.get("faskes_utama") != kode and pk not in in_cases:
            continue
        try:
            reasons = json.loads(p.get("alasan_anomali") or "[]")
        except ValueError:
            reasons = []
        dokter.append({"id_dokter": pk, "nama": p.get("nama"), "spesialisasi": p.get("spesialisasi"), "faskes_utama": p.get("faskes_utama"),
                       "nama_faskes": p.get("nama_faskes"), "di_faskes_ini": p.get("faskes_utama") == kode, "peran": p.get("peran_dalam_kasus"),
                       "jumlah_kasus": p.get("jumlah_kasus") or 0, "skor_anomali": p.get("skor_anomali"), "suara_model": p.get("suara_model"),
                       "peringkat_anomali": p.get("peringkat_anomali"), "status_anomali": p.get("status_anomali"), "alasan": reasons,
                       "status_klarifikasi": p.get("status_klarifikasi"), "praktik_lain": p.get("praktik_lain")})
    dokter.sort(key=lambda d: (-(d["skor_anomali"] or 0), d["id_dokter"]))
    claims = [c for c in _clean_file("clean", "klaim_berisiko_detail") if kode in (c.get("faskes_asal"), c.get("faskes_tujuan"))]
    claims.sort(key=lambda c: -(float(c.get("nilai_klaim") or 0)))
    trend = [r for r in _clean_file("clean", "tren_klaim_bulanan") if r.get("kode_faskes") == kode]
    history = []
    for e in _history(t["faskes"]["id"], kode):
        history.append({**e, "objek": f.get("nama"), "jenis_objek": "Faskes"})
    for k in kasus:
        for e in _history(t["kasus"]["id"], k["id_kasus"]):
            history.append({**e, "objek": k["id_kasus"], "jenis_objek": "Kasus"})
    history.sort(key=lambda e: str(e.get("at") or ""), reverse=True)
    prio = _priority(f)
    # the dataset column rasio_rujukan_pct backs the property rasioRujukanPct
    f = {**f, "rasio_rujukan_pct": f.get("rasio_rujukan_pct", f.get("rasioRujukanPct"))}
    iot = None
    if "alat" in t and "temuan" in t:
        alat = [{"id_alat": pk, **p} for pk, p in _props(t["alat"]["id"]).items() if p.get("kode_faskes") == kode]
        if alat:
            temuan = [{"id_temuan": pk, **p} for pk, p in _props(t["temuan"]["id"]).items() if p.get("kode_faskes") == kode]
            temuan.sort(key=lambda x: (x.get("tingkat") != "Tinggi", str(x.get("tanggal"))))
            iot = {"alat": sorted(alat, key=lambda a: a["id_alat"]), "temuan": temuan}
            for e in (h for x in temuan for h in _history(t["temuan"]["id"], x["id_temuan"])):
                history.append({**e, "objek": "Temuan IoT", "jenis_objek": "Temuan IoT"})
            history.sort(key=lambda e: str(e.get("at") or ""), reverse=True)
    return {
        "faskes": {"kode": kode, **f, "prioritas": prio, "tingkat_prioritas": _tier(f, prio)}, "alasan": _explain(kode), "kasus": kasus, "dokter": dokter,
        "klaim": claims[:150], "klaim_total": len(claims), "tren": trend, "riwayat": history[:40], "iot": iot,
    }


@router.get("/pola-baru")
def new_patterns() -> dict:
    t = _types()
    faskes = _props(t["faskes"]["id"])
    rows = []
    for pk, p in _props(t["dokter"]["id"]).items():
        if p.get("skor_anomali") is None:
            continue
        try:
            reasons = json.loads(p.get("alasan_anomali") or "[]")
        except ValueError:
            reasons = []
        rows.append({"id_dokter": pk, "nama": p.get("nama"), "spesialisasi": p.get("spesialisasi"), "faskes_utama": p.get("faskes_utama"),
                     "nama_faskes": p.get("nama_faskes"), "status_faskes": (faskes.get(p.get("faskes_utama") or "") or {}).get("status_audit"),
                     "skor_anomali": p.get("skor_anomali"), "suara_model": p.get("suara_model"), "peringkat_anomali": p.get("peringkat_anomali"),
                     "status_anomali": p.get("status_anomali"), "jumlah_kasus": p.get("jumlah_kasus") or 0, "alasan": reasons,
                     "status_klarifikasi": p.get("status_klarifikasi")})
    rows.sort(key=lambda r: (r["peringkat_anomali"] or 9999, r["id_dokter"]))
    return {"dokter": [r for r in rows if (r["suara_model"] or 0) >= 5], "semua": len(rows)}


@router.get("/kasus")
def cases() -> dict:
    t = _types()
    rows = [{"id_kasus": pk, **p} for pk, p in _props(t["kasus"]["id"]).items()]
    rows.sort(key=lambda k: -(k.get("nilai_klaim_rp") or 0))
    return {"kasus": [{k: r.get(k) for k in ("id_kasus", "jenis_kasus", "alur", "faskes_asal", "nama_faskes_asal", "faskes_tujuan", "nama_faskes_tujuan",
                                               "nama_dokter_perujuk", "nama_dokter_dpjp", "diagnosa", "jumlah_klaim", "nilai_klaim_rp", "status_kasus",
                                               "tindak_lanjut", "periode")} for r in rows]}


@router.get("/keputusan")
def decisions() -> dict:
    """The latest decisions the audit team took through the actions (facilities, cases, doctors, IoT findings, hospitals)."""
    import demo_jkn_e2e as e

    return {"keputusan": e._decisions()}


# ------------------------------------------------------------------------------------------------
# the anomaly model, explained: what each doctor's numbers mean, against everyone and against peers
# ------------------------------------------------------------------------------------------------

DETECTORS = [
    ("skor_isolation_forest", "Isolation Forest", "Seberapa cepat dokter ini terisolasi oleh potongan acak — profil yang tidak lazim terpisah lebih dulu."),
    ("skor_one_class_svm", "One-class SVM", "Seberapa jauh di luar batas yang membungkus profil dokter pada umumnya."),
    ("skor_lof", "LOF", "Seberapa jarang tetangga di sekitarnya dibanding kepadatan tetangga-tetangganya."),
    ("skor_knn", "KNN", "Jarak ke dokter-dokter yang paling mirip — makin jauh, makin tidak lazim."),
    ("skor_ecod", "ECOD", "Seberapa ekstrem di ujung distribusi tiap fitur, digabung."),
    ("skor_hbos", "HBOS", "Seberapa jarang nilainya di histogram tiap fitur."),
    ("skor_autoencoder", "Autoencoder", "Seberapa sulit jaringan saraf menyusun ulang profilnya — profil umum mudah disusun ulang."),
    ("skor_gan", "GAN (BiGAN/EGBAD)", "Seberapa tidak mirip dengan profil 'palsu' yang dipelajari generator dari data normal."),
]
# what each original feature is, per claim, as a person reads it
FEATURES = {
    "tarif_rs": ("Tarif RS per klaim", "rp"), "tarif_inacbg": ("Tarif INA-CBG per klaim", "rp"),
    "selisih_tarif": ("Selisih tarif RS − INA-CBG per klaim", "rp"), "lama_rawat": ("Lama rawat (hari)", "num"),
    "jumlah_obat": ("Jumlah obat per klaim", "num"), "jam_masuk": ("Jam masuk", "jam"), "jumlah_klaim": ("Jumlah klaim (3 bulan)", "int"),
}
CATEGORICAL = {"jenis_rawat": "Jenis rawat", "disiplin": "Disiplin / poli", "kode_icd": "Diagnosis (ICD-10)", "kode_prosedur": "Prosedur (ICD-9-CM)",
               "kode_inacbg": "Kode INA-CBG", "severity": "Tingkat keparahan", "kelas_rawat": "Kelas rawat", "hari": "Hari layanan",
               "jam_kategori": "Jam masuk", "dirujuk": "Dirujuk", "faskes_perujuk": "Faskes perujuk", "jenis_faskes": "Jenis faskes (lokasi)"}
PLANTED = {
    "upcoding": "Upcoding: tingkat keparahan dinaikkan ke III, tarif ×1,6",
    "phantom": "Phantom billing: klaim dini hari / akhir pekan tanpa rawat inap, prosedur 88.91, tarif ×1,5",
    "los": "Lama rawat diperpanjang ±2,6× (+2 hari), tarif ×1,3",
    "obat": "Tagihan obat digelembungkan (±3× + 6 obat), tarif ×1,25",
    "repeat": "Klaim berulang: diagnosis, prosedur dan grup INA-CBG yang sama berulang-ulang",
    "kelas": "Manipulasi kelas: dirawat di kelas 1, tarif ×1,3",
    "indikasi": "Tindakan tanpa indikasi (36.06 / 88.91 / 88.56), tarif ×1,7",
    "rujukan": "Rujukan tidak sesuai: diagnosis yang bisa ditangani FKTP tetap dirujuk",
    "selfref": "Self-referral: merujuk ke diri sendiri (tidak mengubah pola tagihan)",
    "novel": "POLA BARU (tidak ada di aturan): dokter umum di RS yang sebagian besar menagih bedah ortopedi",
}


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _pct_rank(values: list[float], v: float) -> float:
    """Share of values at or below v (0–1)."""
    return sum(1 for x in values if x <= v) / max(1, len(values))


def _median(values: list[float]) -> float:
    s = sorted(values)
    n = len(s)
    return 0.0 if not n else (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2)


def _ml_frame() -> dict:
    """The ML outputs joined per doctor (cached by the datasets' versions): scores, features, claims and their PCA map."""
    import numpy as np

    scores = _clean_file("ml", "anomali_dokter")
    feats = _clean_file("ml", "fitur_anomali_dokter")
    claims = _clean_file("clean", "klaim_sep_bersih")
    key = tuple(str((_dataset_item(f, n) or {}).get("updated_at")) for f, n in (("ml", "anomali_dokter"), ("ml", "fitur_anomali_dokter"), ("clean", "klaim_sep_bersih")))
    if _CACHE.get("ml_frame", {}).get("key") == key:
        return _CACHE["ml_frame"]["data"]
    by_doc: dict[str, list[dict]] = {}
    for c in claims:
        by_doc.setdefault(c["id_dokter"], []).append(c)
    fe = {r["id_dokter"]: r for r in feats}
    cols = [c for c in (feats[0].keys() if feats else []) if c != "id_dokter"]
    ids = [r["id_dokter"] for r in scores if r["id_dokter"] in fe]
    # the map: the model's whole feature space (standardised) projected on its two main directions
    xy: dict[str, tuple[float, float]] = {}
    if ids and cols:
        X = np.array([[_f(fe[i][c]) for c in cols] for i in ids])
        X = (X - X.mean(axis=0)) / np.where(X.std(axis=0) > 0, X.std(axis=0), 1)
        _, s, vt = np.linalg.svd(X, full_matrices=False)
        P = X @ vt[:2].T
        explained = (s[:2] ** 2 / (s ** 2).sum()).tolist()
        xy = {i: (round(float(P[k, 0]), 3), round(float(P[k, 1]), 3)) for k, i in enumerate(ids)}
    else:
        explained = [0.0, 0.0]
    try:
        import demo_jkn_ml as ml

        _, novel = ml.known_and_novel()
        planted = {**{d: k for d, k in ml.doctors_and_claims()["anomali"].items()}, **{d: "novel" for d in novel}}
    except Exception:  # noqa: BLE001
        planted = {}
    docs = []
    for r in scores:
        did = r["id_dokter"]
        cs = by_doc.get(did, [])
        n = max(1, len(cs))
        inap = sum(1 for c in cs if str(c.get("jenis_rawat")) == "Rawat inap") / n
        disc: dict[str, int] = {}
        for c in cs:
            disc[str(c.get("disiplin"))] = disc.get(str(c.get("disiplin")), 0) + 1
        top_disc = max(disc.items(), key=lambda kv: kv[1]) if disc else ("—", 0)
        docs.append({
            "id": did, "nama": r.get("nama_dokter"), "spesialisasi": r.get("spesialisasi") or "—", "faskes": r.get("nama_faskes"),
            "skor": round(_f(r.get("skor_anomali")), 4), "suara": int(_f(r.get("suara_model"))), "peringkat": int(_f(r.get("peringkat_anomali"))),
            "status": r.get("status_anomali"), "pola_baru": "pola baru" in str(r.get("status_anomali") or ""),
            "x": xy.get(did, (0, 0))[0], "y": xy.get(did, (0, 0))[1],
            "klaim": len(cs), "inap_pct": round(inap * 100, 1), "disiplin_utama": top_disc[0], "disiplin_utama_pct": round(top_disc[1] / n * 100, 1),
            **{k: round(sum(_f(c.get(k)) for c in cs) / n, 1) for k in ("tarif_rs", "tarif_inacbg", "selisih_tarif", "lama_rawat", "jumlah_obat", "jam_masuk")},
            "detektor": {col: round(_f(r.get(col)), 4) for col, _, _ in DETECTORS},
            "alasan": json.loads(r.get("alasan_anomali") or "[]"),
            "tertanam": planted.get(did),
        })
    data = {"docs": docs, "by_doc": by_doc, "explained": explained}
    _CACHE["ml_frame"] = {"key": key, "data": data}
    return data


@router.get("/anomali/peta")
def anomaly_map() -> dict:
    """Every doctor as a point: the model's feature space in 2D (PCA) and the plain per-claim averages, for the scatter."""
    d = _ml_frame()
    keep = ("id", "nama", "spesialisasi", "skor", "suara", "peringkat", "pola_baru", "x", "y", "klaim", "inap_pct", "tarif_rs", "selisih_tarif",
            "lama_rawat", "jumlah_obat", "jam_masuk", "disiplin_utama", "disiplin_utama_pct", "tertanam")
    return {"dokter": [{k: x[k] for k in keep} for x in d["docs"]], "pca_explained": d["explained"],
            "detektor": [{"kolom": c, "nama": n, "intuisi": i} for c, n, i in DETECTORS], "tertanam": PLANTED}


@router.get("/anomali/{id_dokter}")
def anomaly_explained(id_dokter: str) -> dict:
    """Why one doctor is unusual, in numbers a person can check: each Shapley reason with the doctor's value against all
    doctors and against the same specialty (percentile, median, a histogram), the categories that differ most from the
    population, the eight detectors' percentiles, and — demo only — the pattern the synthetic data planted."""
    d = _ml_frame()
    me = next((x for x in d["docs"] if x["id"] == id_dokter), None)
    if not me:
        raise HTTPException(404, f"dokter {id_dokter} tidak punya skor anomali")
    peers = [x for x in d["docs"] if x["spesialisasi"] == me["spesialisasi"]]
    reasons = []
    for r in me["alasan"]:
        f = str(r.get("fitur"))
        item = {"fitur": f, "label": r.get("label") or f, "kontribusi": r.get("kontribusi")}
        if f in FEATURES:
            label, unit = FEATURES[f]
            key = "klaim" if f == "jumlah_klaim" else f
            pop = [x[key] for x in d["docs"]]
            peer = [x[key] for x in peers]
            v = me[key]
            lo, hi = min(pop), max(pop)
            bins = 24
            step = (hi - lo) / bins or 1
            hist = [0] * bins
            for x in pop:
                hist[min(bins - 1, int((x - lo) / step))] += 1
            item.update(jenis="numerik", label=label, satuan=unit, nilai=v, median_semua=_median(pop), median_sejawat=_median(peer),
                        persentil_semua=round(_pct_rank(pop, v) * 100), persentil_sejawat=round(_pct_rank(peer, v) * 100), sejawat=len(peer),
                        hist={"min": lo, "max": hi, "counts": hist})
        elif f in CATEGORICAL:
            mine = d["by_doc"].get(id_dokter, [])
            allc = [c for cs in d["by_doc"].values() for c in cs]
            peer_ids = {x["id"] for x in peers}
            peerc = [c for did, cs in d["by_doc"].items() if did in peer_ids for c in cs]

            def share(rows: list[dict]) -> dict[str, float]:
                out: dict[str, int] = {}
                for c in rows:
                    out[str(c.get(f))] = out.get(str(c.get(f)), 0) + 1
                return {k: v / max(1, len(rows)) for k, v in out.items()}

            sm, sa, sp = share(mine), share(allc), share(peerc)
            cats = sorted(set(sm) | set(sa), key=lambda k: -abs(sm.get(k, 0) - sa.get(k, 0)))[:6]
            item.update(jenis="kategori", label=CATEGORICAL[f], kategori=[{"kategori": k, "dokter": round(sm.get(k, 0), 3), "semua": round(sa.get(k, 0), 3),
                                                                            "sejawat": round(sp.get(k, 0), 3)} for k in cats], sejawat=len(peers))
        reasons.append(item)
    # what the doctor bills most, against everyone (the nomenclature view of the paper)
    mine = d["by_doc"].get(id_dokter, [])
    allc = [c for cs in d["by_doc"].values() for c in cs]
    count: dict[str, int] = {}
    for c in mine:
        count[str(c.get("kode_prosedur"))] = count.get(str(c.get("kode_prosedur")), 0) + 1
    pop_count: dict[str, int] = {}
    for c in allc:
        pop_count[str(c.get("kode_prosedur"))] = pop_count.get(str(c.get("kode_prosedur")), 0) + 1
    procs = [{"kode": k, "dokter": round(v / max(1, len(mine)), 3), "semua": round(pop_count.get(k, 0) / max(1, len(allc)), 3)}
             for k, v in sorted(count.items(), key=lambda kv: -kv[1])[:6]]
    ranked = sorted(d["docs"], key=lambda x: -x["skor"])
    return {
        "dokter": {k: me[k] for k in ("id", "nama", "spesialisasi", "faskes", "skor", "suara", "peringkat", "status", "pola_baru", "klaim", "inap_pct",
                                      "disiplin_utama", "disiplin_utama_pct", "tarif_rs", "selisih_tarif", "lama_rawat", "jumlah_obat")},
        "populasi": {"dokter": len(d["docs"]), "sejawat": len(peers), "median_skor": _median([x["skor"] for x in d["docs"]]),
                     "ambang_10pct": ranked[max(0, len(ranked) // 10 - 1)]["skor"] if ranked else None},
        "detektor": [{"kolom": c, "nama": n, "intuisi": i, "persentil": me["detektor"][c], "suara": me["detektor"][c] >= 0.9} for c, n, i in DETECTORS],
        "alasan": reasons,
        "prosedur": procs,
        "tertanam": {"jenis": me["tertanam"], "keterangan": PLANTED.get(me["tertanam"] or "", None)},
    }


@router.get("/export.csv")
def export_csv() -> Response:
    rows = queue()["faskes"]
    cols = ["urutan", "kode", "nama", "jenis", "kantor_cabang", "status_audit", "tingkat_prioritas", "prioritas", "skor_risiko", "skor_anomali",
            "dokter_anomali", "dokter_pola_baru", "indikasi_utama", "jumlah_kasus", "klaim_berisiko", "potensi_kerugian_rp", "tim_audit", "tanggal_audit"]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in cols})
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="antrian_audit_faskes_jkn.csv"'})


# ------------------------------------------------------------------------------------------------
# IoT: device electricity use against the procedures claimed (demo_jkn_iot.py)
# ------------------------------------------------------------------------------------------------


def _day(v) -> str:
    """A date column as YYYY-MM-DD (the pipeline writes dates; the emulation strings)."""
    return str(v)[:10]


def _iot_apps() -> dict:
    import demo_jkn_e2e as e
    import demo_jkn_iot as iot
    import demo_jkn_map as jm
    import geospatial
    import machinery
    import vertex

    graphs = {g["name"]: g["id"] for g in vertex.list_graphs()}
    mach = next((r for r in machinery._all() if r["name"] == iot.MACHINERY), None)
    procs = {p["name"]: p["id"] for p in (mach or {}).get("processes") or []}
    raw = {n: (_dataset_item("raw/iot", n) or {}).get("id") for n in ("daya_listrik_alat_iot", "klaim_tindakan_penunjang", "registri_alat_iot", "referensi_tindakan_alat")}
    clean = {n: (_dataset_item("iot", n) or {}).get("id") for n, _ in iot.OUTPUTS}
    return {"pipeline": e.STATE.get("iot_pipeline_id"), "sync": e.STATE.get("iot_sync_id"), "graph": graphs.get(iot.G_IOT), "template": graphs.get(iot.G_IOT_TEMPLATE),
            "map": next((m["id"] for m in geospatial.list_maps() if m.get("name") == jm.MAP), None), "machinery": mach and mach["id"],
            "proses_alat": procs.get("Status operasi alat medis"), "proses_verifikasi": procs.get("Verifikasi temuan IoT"), "lineage_graph": e.LINEAGE_GRAPH,
            "raw": raw, "clean": clean}


@router.get("/iot")
def iot_overview() -> dict:
    t = _types()
    if "alat" not in t or "temuan" not in t:
        raise HTTPException(404, "the IoT part of the demo has not been built yet")
    pilot = lambda p: p.get("tier") in (None, "Telemetri penuh")  # noqa: E731 - the national network has its own tab
    alat = {pk: {"id_alat": pk, **p} for pk, p in _props(t["alat"]["id"]).items() if pilot(p)}
    temuan = {pk: {"id_temuan": pk, **p} for pk, p in _props(t["temuan"]["id"]).items() if pilot(p)}
    rekon = [{**r, "tanggal": _day(r["tanggal"])} for r in _clean_file("iot", "rekonsiliasi_iot_klaim")]
    days = sorted({r["tanggal"] for r in rekon})
    rows: dict[tuple, dict] = {}
    for r in rekon:
        key = (r["kode_faskes"], r["jenis_alat"])
        row = rows.setdefault(key, {"kode_faskes": r["kode_faskes"], "nama_faskes": r.get("nama_faskes"), "jenis_alat": r["jenis_alat"], "cells": {},
                                    "alat": [a for a in alat.values() if a.get("kode_faskes") == r["kode_faskes"] and a.get("jenis_alat") == r["jenis_alat"]]})
        tm = temuan.get(r["id_rekon"]) or {}
        row["cells"][r["tanggal"]] = {"id": r["id_rekon"], "klaim": r["klaim_tindakan"], "est": r["estimasi_tindakan_alat"], "status": r["status_rekon"],
                                      "tingkat": r["tingkat"], "keputusan": tm.get("status_temuan") if tm.get("status_temuan") not in (None, "Baru") else None}
    matrix = sorted(rows.values(), key=lambda x: (-sum(1 for c in x["cells"].values() if c["tingkat"] == "Tinggi"), x["kode_faskes"], x["jenis_alat"]))
    for m in matrix:
        by_day = m["cells"]
        m["tak_didukung"] = sum(r["tindakan_tak_didukung"] for r in rekon if r["kode_faskes"] == m["kode_faskes"] and r["jenis_alat"] == m["jenis_alat"] and r["tingkat"] == "Tinggi")
        m["cells"] = [by_day.get(d) for d in days]
    findings = sorted(temuan.values(), key=lambda x: ({"Tinggi": 0, "Sedang": 1, "Info": 2}.get(x.get("tingkat"), 3), -(x.get("nilai_tak_didukung_rp") or 0)))
    tinggi = [x for x in findings if x.get("tingkat") == "Tinggi"]
    metered = [a for a in alat.values() if a.get("id_meter")]
    return {
        "types": {k: t[k]["id"] for k in ("alat", "temuan", "tindakan", "faskes", "dokter") if k in t}, "actions": _actions().get("temuan", []),
        "days": days, "matrix": matrix, "temuan": findings, "alat": sorted(alat.values(), key=lambda a: (a.get("kode_faskes") or "", a["id_alat"])),
        "kpi": {"faskes": len({a.get("kode_faskes") for a in alat.values()}), "alat": len(alat), "alat_bermeter": len(metered), "hari": len(days),
                "kelengkapan_pct": round(sum(a.get("kelengkapan_pct") or 0 for a in metered) / max(1, len(metered)), 1),
                "temuan_tinggi": len(tinggi), "tak_didukung": sum(x.get("tindakan_tak_didukung") or 0 for x in tinggi),
                "nilai_rp": sum(x.get("nilai_tak_didukung_rp") or 0 for x in tinggi),
                "diverifikasi": sum(1 for x in findings if x.get("status_temuan") not in (None, "Baru")),
                "terkonfirmasi": sum(1 for x in findings if str(x.get("status_temuan") or "").startswith(("Terkonfirmasi", "Klaim dikoreksi"))),
                "koreksi_rp": sum(float(x.get("nilai_koreksi_rp") or 0) for x in findings)},
        "apps": _iot_apps(),
    }


def _local_ms(day: str, hours: int = 0) -> int:
    from datetime import datetime, timedelta, timezone

    d = datetime.fromisoformat(day).replace(tzinfo=timezone(timedelta(hours=7))) + timedelta(hours=hours)
    return int(d.timestamp() * 1000)


@router.get("/iot/temuan/{temuan_id}")
def iot_evidence(temuan_id: str) -> dict:
    """The evidence chain of one finding, top (decision) to bottom (raw rows)."""
    import demo_jkn_e2e as e
    import timeseries

    t = _types()
    if "temuan" not in t:
        raise HTTPException(404, "the IoT part of the demo has not been built yet")
    tm = _props(t["temuan"]["id"]).get(temuan_id)
    if not tm:
        raise HTTPException(404, "finding not found")
    day = str(tm.get("tanggal"))[:10]
    alat_all = _props(t["alat"]["id"])
    ids = [x.strip() for x in str(tm.get("alat_terkait") or "").split(",") if x.strip()]
    sync = e.STATE.get("iot_sync_id")
    sesi = _clean_file("iot", "sesi_alat")
    harian = {r["id_pemakaian"]: {**r, "tanggal": _day(r["tanggal"])} for r in _clean_file("iot", "pemakaian_alat_harian")}
    edge = tm.get("tier") == "Ringkasan edge"
    if edge:
        return _iot_evidence_edge(t, temuan_id, tm, day, ids, alat_all)
    devices = []
    for aid in ids:
        a = {"id_alat": aid, **(alat_all.get(aid) or {})}
        meter = a.get("id_meter")
        series: list = []
        if meter and sync:
            try:
                series = [[ms, v] for ms, v in timeseries.read_points(sync, meter, _local_ms(day), _local_ms(day, 24))]
            except HTTPException:
                series = []
        devices.append({**a, "series": series, "pemakaian": harian.get(f"{aid}-{day}"),
                        "sesi": [{**s, "tanggal": _day(s["tanggal"])} for s in sesi if s["id_alat"] == aid and _day(s["tanggal"]) == day]})
    tindakan = [{"id_baris": pk, **p} for pk, p in _props(t["tindakan"]["id"]).items() if p.get("id_rekon") == temuan_id] if "tindakan" in t else []
    tindakan.sort(key=lambda x: (str(x.get("nama_dokter")), x["id_baris"]))
    per_dokter: dict[str, dict] = {}
    for x in tindakan:
        d = per_dokter.setdefault(x.get("id_dokter") or "?", {"id_dokter": x.get("id_dokter"), "nama": x.get("nama_dokter"), "jumlah": 0, "nilai_rp": 0.0})
        d["jumlah"] += 1
        d["nilai_rp"] += float(x.get("tarif_rs") or 0)
    # the raw rows these numbers were cleaned from
    meters = {str(a.get("id_meter")).upper() for a in devices if a.get("id_meter")}
    raw_meter = [r for r in _clean_file("raw/iot", "daya_listrik_alat_iot")
                 if str(r.get("id_meter") or "").strip().upper() in meters and str(r.get("waktu_lokal", "")).startswith(day)]
    raw_meter.sort(key=lambda r: (r["ts"], str(r.get("id_meter"))))
    seen, dup = set(), 0
    for r in raw_meter:
        k = (str(r["id_meter"]).upper(), r["ts"])
        dup += k in seen
        seen.add(k)
    seps = {x.get("no_sep") for x in tindakan}
    raw_claims = [r for r in _clean_file("raw/iot", "klaim_tindakan_penunjang") if str(r.get("no_sep") or "").strip() in seps]
    rekon = next(({**r, "tanggal": _day(r["tanggal"])} for r in _clean_file("iot", "rekonsiliasi_iot_klaim") if r["id_rekon"] == temuan_id), None)
    return {
        "temuan": {"id_temuan": temuan_id, **tm}, "riwayat": _history(t["temuan"]["id"], temuan_id), "rekon": rekon, "alat": devices,
        "referensi": [r for r in _clean_file("raw/iot", "referensi_tindakan_alat") if r.get("jenis_alat") == tm.get("jenis_alat")],
        "tindakan": tindakan, "per_dokter": sorted(per_dokter.values(), key=lambda d: -d["jumlah"]),
        "mentah": {"bacaan": raw_meter[:60], "bacaan_total": len(raw_meter), "bacaan_duplikat": dup,
                   "bacaan_glitch": sum(1 for r in raw_meter if r.get("daya_watt") is None or (r.get("daya_watt") or 0) < 0),
                   "id_huruf_kecil": sum(1 for r in raw_meter if str(r.get("id_meter") or "") != str(r.get("id_meter") or "").upper()),
                   "klaim": raw_claims, "klaim_total": len(raw_claims)},
        "types": {k: t[k]["id"] for k in ("alat", "temuan", "tindakan", "faskes", "dokter") if k in t}, "actions": _actions().get("temuan", []),
        "apps": _iot_apps(), "sumber": {"tier": "Telemetri penuh", "bacaan": "Time Series DB (bacaan 2 menit dari meter)", "klaim": "objek Tindakan Penunjang (e-Klaim)"},
    }


def _iot_evidence_edge(t: dict, temuan_id: str, tm: dict, day: str, ids: list[str], alat_all: dict) -> dict:
    """A national finding: the pipeline only received the gateway's daily summary, so the 2-minute readings come from the
    hospital gateway's archive and the claim lines from e-Klaim — pulled now, for this device-day only."""
    import demo_jkn_iot_nasional as nas

    harian = {r["id_pemakaian"]: {**r, "tanggal": _day(r["tanggal"])} for r in _clean_file("iot_nasional", "pemakaian_harian_jejaring")}
    raw_edge = _clean_file("raw/iot_nasional", "ringkasan_edge_harian")
    devices, raw_rows, edge_rows = [], [], []
    for aid in ids:
        a = {"id_alat": aid, **(alat_all.get(aid) or {})}
        if a.get("id_meter"):
            arc = nas.archive(aid, day)
            raw_rows += arc["rows"]
            edge_rows += [r for r in raw_edge if str(r.get("id_alat") or "").upper() == aid and r.get("tanggal") == day]
            devices.append({**a, "series": arc["series"], "sesi": arc["sesi"], "ambang_aktif_w": arc["ambang_aktif_w"], "pemakaian": harian.get(f"{aid}-{day}")})
        else:
            devices.append({**a, "series": [], "sesi": [], "pemakaian": None})
    lines = nas.claim_lines(tm["kode_faskes"], tm["jenis_alat"], day, int(tm.get("klaim_tindakan") or 0))
    per: dict[str, dict] = {}
    for x in lines:
        d = per.setdefault(x["nama_dokter"], {"id_dokter": x["nama_dokter"], "nama": x["nama_dokter"], "jumlah": 0, "nilai_rp": 0.0})
        d["jumlah"] += 1
        d["nilai_rp"] += x["tarif_rs"]
    rekon = next(({**r, "tanggal": _day(r["tanggal"])} for r in _clean_file("iot_nasional", "rekonsiliasi_jejaring") if r["id_rekon"] == temuan_id), None)
    raw_rows.sort(key=lambda r: (r["ts"], str(r["id_meter"])))
    return {
        "temuan": {"id_temuan": temuan_id, **tm}, "riwayat": _history(t["temuan"]["id"], temuan_id), "rekon": rekon, "alat": devices,
        "referensi": [r for r in _clean_file("raw/iot", "referensi_tindakan_alat") if r.get("jenis_alat") == tm.get("jenis_alat")],
        "tindakan": lines, "per_dokter": sorted(per.values(), key=lambda d: -d["jumlah"]),
        "mentah": {"bacaan": raw_rows[:60], "bacaan_total": len(raw_rows), "bacaan_duplikat": 0, "bacaan_glitch": 0, "id_huruf_kecil": 0,
                   "klaim": [{"no_sep": x["no_sep"], "kode_faskes": tm["kode_faskes"], "kode_icd9": x["kode_icd9_mentah"], "id_dokter": x["nama_dokter"]} for x in lines],
                   "klaim_total": len(lines), "ringkasan_edge": edge_rows},
        "types": {k: t[k]["id"] for k in ("alat", "temuan", "tindakan", "faskes", "dokter") if k in t}, "actions": _actions().get("temuan", []),
        "apps": {**_iot_apps(), **_nas_apps()},
        "sumber": {"tier": "Ringkasan edge", "bacaan": "arsip gateway RS (ditarik saat temuan dibuka)", "klaim": "e-Klaim (baris klaim ditarik saat temuan dibuka)"},
    }


# ------------------------------------------------------------------------------------------------
# national IoT monitoring (demo_jkn_iot_nasional.py): every connected hospital, region by region
# ------------------------------------------------------------------------------------------------


def _nas_types() -> dict:
    import demo_jkn_iot_nasional as nas
    import demo_jkn_map as jm

    w, r = jm._type(nas.WILAYAH), jm._type(nas.RS)
    if not w or not r:
        raise HTTPException(404, "the national IoT layer of the demo has not been built yet")
    return {"wilayah": w, "rs": r}


def _nas_apps() -> dict:
    import demo_jkn_e2e as e
    import demo_jkn_iot as iot
    import demo_jkn_iot_nasional as nas
    import geospatial
    import machinery
    import vertex

    graphs = {g["name"]: g["id"] for g in vertex.list_graphs()}
    mach = next((r for r in machinery._all() if r["name"] == iot.MACHINERY), None)
    procs = {p["name"]: p["id"] for p in (mach or {}).get("processes") or []}
    return {"peta_nasional": next((m["id"] for m in geospatial.list_maps() if m.get("name") == nas.MAP), None), "graph_hotspot": graphs.get(nas.G_HOTSPOT),
            "pipeline_nasional": e.STATE.get("iot_nasional_pipeline_id"), "sync_nasional": e.STATE.get("iot_nasional_sync_id"),
            "machinery": mach and mach["id"], "proses_rs": procs.get("Status pemantauan RS jejaring"), "lineage_graph": e.LINEAGE_GRAPH,
            "raw_edge": (_dataset_item("raw/iot_nasional", "ringkasan_edge_harian") or {}).get("id"),
            "raw_klaim": (_dataset_item("raw/iot_nasional", "klaim_harian_eklaim") or {}).get("id")}


RS_FIELDS = ("kode", "nama", "kelas", "kepemilikan", "id_kabkota", "kabkota", "id_provinsi", "provinsi", "id_kedeputian", "kedeputian", "lokasi", "tier",
             "kode_faskes_audit", "alat_terpasang", "alat_bermeter", "kelengkapan_pct", "klaim_terpantau_14h", "estimasi_alat_14h", "tak_didukung_14h",
             "nilai_tak_didukung_rp", "rasio_tak_didukung_pct", "rasio_jenis_maks_pct", "hari_temuan", "hari_verifikasi", "hari_data_kurang", "alat_bermasalah",
             "skor_risiko_iot", "status_pemantauan", "catatan_pemantauan", "tim_pemeriksa")


def _scale(n_days: int) -> dict:
    """What edge aggregation saves: the rows the pipeline receives against the 2-minute readings they summarise."""
    edge = len(_clean_file("raw/iot_nasional", "ringkasan_edge_harian"))
    return {"hari": n_days, "baris_edge": edge, "bacaan_setara": edge * 720, "faktor": 720}


@router.get("/nasional")
def national(wilayah: str = "ID") -> dict:
    """One region of the national network: its numbers and path, its sub-regions (or, for a city/regency, its hospitals),
    the hospitals that need attention in it, its daily trend, and every city/regency and hospital for the map."""
    t = _nas_types()
    wil = {pk: {"id_wilayah": pk, **p} for pk, p in _props(t["wilayah"]["id"]).items()}
    cur = wil.get(wilayah)
    if not cur:
        raise HTTPException(404, "region not found")
    path, x = [], cur
    while x:
        path.insert(0, {"id_wilayah": x["id_wilayah"], "nama": x.get("nama"), "tingkat": x.get("tingkat")})
        x = wil.get(x.get("induk") or "")
    rs = [{"kode": pk, **{k: p.get(k) for k in RS_FIELDS if k != "kode"}} for pk, p in _props(t["rs"]["id"]).items()]
    level = cur.get("tingkat")
    key = {"Nasional": None, "Kedeputian Wilayah": "id_kedeputian", "Provinsi": "id_provinsi", "Kabupaten/Kota": "id_kabkota"}.get(level)
    inside = [r for r in rs if not key or r.get(key) == wilayah]
    children = sorted((w for w in wil.values() if w.get("induk") == wilayah), key=lambda w: (-(w.get("nilai_tak_didukung_rp") or 0), w.get("nama") or ""))
    order = {"Prioritas audit": 0, "Perhatian": 1, "Data kurang": 2, "Normal": 3, "Belum terhubung": 4}
    attention = sorted((r for r in inside if r.get("status_pemantauan") in ("Prioritas audit", "Perhatian")),
                       key=lambda r: (order.get(r.get("status_pemantauan"), 9), -(r.get("skor_risiko_iot") or 0)))
    tren = sorted(({**r, "tanggal": _day(r["tanggal"])} for r in _clean_file("iot_nasional", "tren_iot_harian") if r["id_wilayah"] == wilayah),
                  key=lambda r: r["tanggal"])
    kab = [{k: w.get(k) for k in ("id_wilayah", "nama", "induk", "lokasi", "status_wilayah", "rs_total", "rs_terhubung", "rs_prioritas", "nilai_tak_didukung_rp",
                                   "tak_didukung_14h", "cakupan_pct")} for w in wil.values() if w.get("tingkat") == "Kabupaten/Kota"]
    status_count: dict[str, int] = {}
    for r in inside:
        status_count[r.get("status_pemantauan") or "?"] = status_count.get(r.get("status_pemantauan") or "?", 0) + 1
    import demo_jkn_iot_nasional as nas

    return {
        "wilayah": cur, "path": path, "anak": children, "rs": sorted(inside, key=lambda r: (order.get(r.get("status_pemantauan"), 9), -(r.get("skor_risiko_iot") or 0)))
        if level == "Kabupaten/Kota" else [], "perhatian": attention[:25], "perhatian_total": len(attention), "tren": tren, "status_rs": status_count,
        "peta": {"kabkota": kab, "rs": [{k: r.get(k) for k in ("kode", "nama", "lokasi", "status_pemantauan", "skor_risiko_iot", "id_kabkota", "id_provinsi",
                                                               "id_kedeputian", "tier")} for r in rs]},
        "hotspot": sorted((w for w in wil.values() if w.get("status_wilayah") == "Hotspot"), key=lambda w: -(w.get("nilai_tak_didukung_rp") or 0)),
        "types": {k: v["id"] for k, v in t.items()}, "actions": [{"id": a["id"], "name": a["display_name"].replace(" (demo)", ""), "description": a.get("description") or ""}
                                                              for a in ontology._all("action-types") if a.get("object_type_id") == t["rs"]["id"]],
        "apps": _nas_apps(), "skala": _scale(len(nas.days())),
    }


@router.get("/nasional/rs/{kode}")
def national_hospital(kode: str) -> dict:
    """One hospital of the network: its numbers, its devices with their 14 days (estimate vs claims per device type), its
    findings and the decisions on it."""
    t = _nas_types()
    tt = _types()
    r = _props(t["rs"]["id"]).get(kode)
    if not r:
        raise HTTPException(404, "hospital not found")
    alat = sorted(({"id_alat": pk, **p} for pk, p in _props(tt["alat"]["id"]).items() if p.get("kode_faskes") == kode), key=lambda a: a["id_alat"])
    temuan = {pk: {"id_temuan": pk, **p} for pk, p in _props(tt["temuan"]["id"]).items() if p.get("kode_faskes") == kode}
    rekon = [{**x, "tanggal": _day(x["tanggal"])} for x in _clean_file("iot_nasional", "rekonsiliasi_jejaring") if x["kode_faskes"] == kode]
    days = sorted({x["tanggal"] for x in rekon})
    rows: dict[str, dict] = {}
    for x in rekon:
        row = rows.setdefault(x["jenis_alat"], {"jenis_alat": x["jenis_alat"], "cells": {}, "alat": [a for a in alat if a.get("jenis_alat") == x["jenis_alat"]]})
        tm = temuan.get(x["id_rekon"]) or {}
        row["cells"][x["tanggal"]] = {"id": x["id_rekon"], "klaim": x["klaim_tindakan"], "est": x["estimasi_tindakan_alat"], "status": x["status_rekon"],
                                      "tingkat": x["tingkat"], "keputusan": tm.get("status_temuan") if tm.get("status_temuan") not in (None, "Baru") else None}
    matrix = []
    for jenis in sorted(rows):
        m = rows[jenis]
        m["tak_didukung"] = sum(x["tindakan_tak_didukung"] for x in rekon if x["jenis_alat"] == jenis and x["tingkat"] == "Tinggi")
        m["cells"] = [m["cells"].get(d) for d in days]
        matrix.append(m)
    history = _history(t["rs"]["id"], kode)
    return {"rs": {"kode": kode, **r}, "alat": alat, "days": days, "matrix": matrix,
            "temuan": sorted(temuan.values(), key=lambda x: ({"Tinggi": 0, "Sedang": 1, "Info": 2}.get(x.get("tingkat"), 3), str(x.get("tanggal")))),
            "riwayat": history, "types": {k: v["id"] for k, v in t.items()},
            "actions": [{"id": a["id"], "name": a["display_name"].replace(" (demo)", "")} for a in ontology._all("action-types") if a.get("object_type_id") == t["rs"]["id"]],
            "apps": _nas_apps()}
