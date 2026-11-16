"""PLN Grid Monitoring Cockpit (Transmission & Distribution Operations Intelligence) — backend.

The cockpit computes nothing of its own: every figure is read from the platform —
  - Nexus objects, read AS THE CALLER (markings, per-ULP row policies and property policies apply), from the grid
    demo's types (GI, feeders, transformers, outages, findings, AMI events, work orders) and the operations-analytics
    types built by "Pipeline analitik operasi grid (demo)" and the structural-topology Code Repository transform
    (demo_grid_operasi.py): alarms, asset risk, GI N-1, feeder loading, monthly reliability, OSM corridors & nodes;
  - pipeline output datasets (hourly GI load, daily load curves, hourly feeder power) after a Files access check;
  - pipeline builds and Code Repository builds for freshness, and the saved lineage graph for provenance.
Writes go through Nexus actions (alarm acknowledge/assign/resolve/reopen, AMI event status, work-order status), so the
audit trail is the Nexus edit history — the cockpit keeps no side state and executes no switching (read-only to SCADA).

Data honesty: the real OSM transmission network carries no invented electrical numbers (no conductor ratings or
SCADA telemetry exist for it), so transmission loading and power-flow N-1 stay "unavailable"; what is available for
it is a STRUCTURAL N-1 (graph bridges and articulation points). Electrical analytics run on the fictional demo
distribution network, labelled "(demo)".
"""

from __future__ import annotations

import io
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/pln-cockpit", tags=["pln-cockpit"])

# the Nexus types the cockpit reads, by key (the operations types come from demo_grid_operasi.TYPES)
OSM = {"saluran": "Transmission Line Java-Bali Combined (OSM)", "gardu": "Substation Java-Bali Combined (OSM)",
       "pembangkit": "Power Plant Java-Bali Combined (OSM)"}
DEMO = {"gi": "gi", "penyulang": "penyulang", "gardu_distribusi": "gardu", "pelanggan": "pelanggan", "temuan": "temuan",
        "gangguan": "gangguan", "perintah": "perintah", "inspeksi": "inspeksi", "neraca_penyulang": "neraca_penyulang",
        "neraca_gardu": "neraca_gardu"}
EXTRA = {"peristiwa": "AMI Event (demo)", "kunjungan": "Grid P2TL Field Visit (demo)", "sensor": "Substation Sensor (demo)",
         "ami_kesehatan": "Grid AMI Meter Health (demo)", "neraca_jam": "Grid Substation Hourly Balance (demo)"}
OPS = ("alarm", "risiko", "n1_gi", "pembebanan", "keandalan", "koridor", "simpul")
WIB = timezone(timedelta(hours=7))
MODE = ("DEMONSTRASI — aset transmisi OSM riil (tanpa angka listrik karangan) + jaringan distribusi & telemetri simulasi berlabel demo; "
        "bukan data operasi PLN produksi")
ACTIVE = ("Baru", "Diakui", "Ditugaskan")


def configure(data_dir) -> None:  # noqa: ANN001 - kept for server.py; the cockpit keeps no state of its own
    return None


# ------------------------------------------------------------------------------------------------
# reading the platform as the caller
# ------------------------------------------------------------------------------------------------

def _type_name(key: str) -> Optional[str]:
    import demo_grid_e2e as e
    import demo_grid_operasi as op

    if key in OSM:
        return OSM[key]
    if key in DEMO:
        return e.T[DEMO[key]][0]
    if key in EXTRA:
        return EXTRA[key]
    if key in op.TYPES:
        return op.TYPES[key][0]
    return None


_index: dict[str, tuple[float, dict]] = {}


def _by_name(kind: str) -> dict:
    """display name → record for object or action types; ontology._all reads every file, so keep it a few seconds."""
    import time

    import ontology

    hit = _index.get(kind)
    if hit and time.monotonic() - hit[0] < 5:
        return hit[1]
    idx = {x["display_name"]: x for x in ontology._all(kind)}
    _index[kind] = (time.monotonic(), idx)
    return idx


def _t(key: str) -> Optional[dict]:
    name = _type_name(key)
    return _by_name("object-types").get(name) if name else None


def _see(key: str) -> list[dict]:
    """The objects of a type as the caller sees them (none without the type's markings, rows per object policy,
    hidden properties null), each with `_pk`."""
    import ontology

    t = _t(key)
    if not t:
        return []
    try:
        rec = ontology._object_type(t["id"])
        objs = ontology._objects(t["id"])
    except HTTPException:
        return []
    return [{**(ontology._public_object(rec, pk, o).get("properties") or {}), "_pk": pk} for pk, o in objs.items() if ontology._can_see(rec, o)]


def _ref(key: str, pk: Any) -> Optional[dict]:
    t = _t(key)
    return {"type_id": t["id"], "pk": str(pk)} if t and pk not in (None, "") else None


def _num(v: Any, d: float = 0.0) -> float:
    try:
        return float(v) if v is not None else d
    except (TypeError, ValueError):
        return d


def _type_info(key: str) -> Optional[dict]:
    import ontology

    t = _t(key)
    if not t:
        return None
    rec = ontology._object_type(t["id"])
    b = rec.get("backing_dataset") or {}
    return {"key": key, "type_id": t["id"], "nama": t["display_name"], "dataset_id": b.get("dataset_id"),
            "lineage": f"object_type:{t['id']}"}


def _prov(*keys: str) -> list[dict]:
    return [i for i in (_type_info(k) for k in keys) if i]


_cache: dict[str, tuple[Any, list[dict]]] = {}
_cache_lock = threading.Lock()


def _dataset_rows(item_id: Optional[str]) -> list[dict]:
    """A dataset's current rows, if the caller may open it (Files roles + markings); cached per content version."""
    import auth
    import db
    import drive
    import pyarrow.parquet as pq

    if not item_id or not auth.can_access(item_id):
        return []
    item = db.drive_get(item_id)
    if not item or item.get("trashed_at"):
        return []
    stamp = (item.get("updated_at"), item.get("size"))
    with _cache_lock:
        hit = _cache.get(item_id)
        if hit and hit[0] == stamp:
            return hit[1]
    rows = pq.read_table(io.BytesIO(drive.read_bytes(drive._item(item_id)))).to_pylist()
    with _cache_lock:
        _cache[item_id] = (stamp, rows)
    return rows


def _ops_state() -> dict:
    import demo_grid_e2e as e

    return e.STATE.get("operasi") or {}


def _ops_item(name: str) -> Optional[str]:
    """The dataset a pipeline output currently writes (the pipeline's output state), else the first-load file."""
    import pipeline_runtime as rt

    st = _ops_state()
    pid, oid = st.get("pipeline_id"), (st.get("output_ids") or {}).get(name)
    if pid and oid:
        s = rt.get_state(pid, f"output:{oid}") or {}
        if s.get("itemId"):
            return s["itemId"]
    return (st.get("datasets") or {}).get(name)


def _iot_item(name: str) -> Optional[str]:
    import drive

    import demo_grid_e2e as e

    project = e.STATE.get("project_id")
    if not project:
        return None
    folder = e._folder(project, "iot")
    return next((f["id"] for f in drive.list_files(folder) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)


def _last_build(pid: Optional[str]) -> Optional[dict]:
    import pipeline_runtime as rt

    if not pid:
        return None
    bs = rt._builds(pid, 10)
    if not bs:
        return None
    done = next((b for b in bs if b["status"] == "succeeded"), None)
    b = bs[0]
    return {"id": b["id"], "status": b["status"], "trigger": b.get("trigger"), "at": b.get("finished_at") or b.get("started_at") or b.get("created_at"),
            "error": (b.get("error") or "")[:300] or None,
            "last_success": (done.get("finished_at") or done.get("created_at")) if done else None}


def _status_norm(s: Any) -> str:
    return str(s or "Baru").replace(" (demo)", "").strip() or "Baru"


# ------------------------------------------------------------------------------------------------
# overview
# ------------------------------------------------------------------------------------------------

def _per_kelas(saluran: list[dict]) -> dict:
    per: dict[str, dict] = {}
    for p in saluran:
        k = str(int(_num(p.get("kelas_kv"))))
        a = per.setdefault(k, {"ruas": 0, "km": 0.0})
        a["ruas"] += 1
        a["km"] += _num(p.get("panjang_km"))
    return {k: {"ruas": v["ruas"], "km": round(v["km"])} for k, v in per.items()}


def _system_reliability(rows: list[dict]) -> dict:
    """System indices over the feeders' monthly rows: SAIDI_sys = Σ(SAIDI_f · N_f) / ΣN_f per month, summed over months."""
    months = sorted({r.get("bulan") for r in rows if r.get("bulan")})
    per_month = []
    for m in months:
        rs = [r for r in rows if r.get("bulan") == m]
        n = sum(_num(r.get("jumlah_pelanggan")) for r in rs) or 1
        per_month.append({"bulan": m, "saidi": round(sum(_num(r.get("saidi_menit")) * _num(r.get("jumlah_pelanggan")) for r in rs) / n, 2),
                          "saifi": round(sum(_num(r.get("saifi_kali")) * _num(r.get("jumlah_pelanggan")) for r in rs) / n, 3),
                          "maifi": round(sum(_num(r.get("maifi_kali")) * _num(r.get("jumlah_pelanggan")) for r in rs) / n, 3),
                          "gangguan": int(sum(_num(r.get("gangguan")) for r in rs)),
                          "permanen": int(sum(_num(r.get("gangguan_permanen")) for r in rs)),
                          "ens_kwh": round(sum(_num(r.get("ens_kwh")) for r in rs), 1)})
    tot = {"saidi": round(sum(m["saidi"] for m in per_month), 1), "saifi": round(sum(m["saifi"] for m in per_month), 2),
           "maifi": round(sum(m["maifi"] for m in per_month), 2), "ens_kwh": round(sum(m["ens_kwh"] for m in per_month)),
           "gangguan": sum(m["gangguan"] for m in per_month)}
    tot["caidi"] = round(tot["saidi"] / tot["saifi"], 1) if tot["saifi"] else None
    return {"periode": f"{months[0]} – {months[-1]}" if months else "-", "per_bulan": per_month, "total": tot}


def _alarm_rows() -> list[dict]:
    """Operations alarms (pipeline → Nexus) and live AMI streaming events, one list, as the caller sees them."""
    out = []
    alarm_t, per_t = _t("alarm"), _t("peristiwa")
    for a in _see("alarm"):
        jenis = a.get("jenis_aset")
        key = "gardu_distribusi" if jenis == "Gardu distribusi" else "penyulang" if jenis == "Penyulang" else "gi" if jenis == "Gardu induk" \
            else "pelanggan" if jenis == "Pelanggan" else None
        out.append({"id": a["_pk"], "kind": "alarm", "type_id": alarm_t["id"] if alarm_t else None, "severity": a.get("severity") or "info",
                    "kategori": a.get("kategori"), "sumber": f"Pipeline analitik operasi · {a.get('sumber_data')}", "jenis_aset": jenis,
                    "aset": a.get("kode_aset"), "aset_ref": _ref(key, a.get("kode_aset")) if key else None,
                    "kode_penyulang": a.get("kode_penyulang"), "kode_dt": a.get("kode_dt"), "kode_ulp": a.get("kode_ulp"),
                    "judul": a.get("judul"), "detail": a.get("detail"), "nilai": a.get("nilai"), "ambang": a.get("ambang"), "satuan": a.get("satuan"),
                    "waktu": a.get("waktu") or "", "status": _status_norm(a.get("status_alarm")), "penugasan": a.get("ditugaskan_ke") or "",
                    "catatan": a.get("catatan_operator") or "", "rekomendasi": a.get("rekomendasi") or ""})
    for p in _see("peristiwa"):
        out.append({"id": p["_pk"], "kind": "peristiwa", "type_id": per_t["id"] if per_t else None, "severity": "critical", "kategori": "AMI streaming",
                    "sumber": "Deteksi streaming AMI (skor NTL per jam + CUSUM)", "jenis_aset": "Meter AMI", "aset": p.get("no_meter"),
                    "aset_ref": _ref("pelanggan", p.get("id_pelanggan")), "kode_penyulang": p.get("kode_penyulang"), "kode_dt": p.get("kode_dt"),
                    "kode_ulp": p.get("kode_ulp"), "judul": p.get("judul"), "detail": p.get("bukti") or "", "nilai": p.get("skor_ntl_jam"),
                    "ambang": None, "satuan": "skor", "waktu": p.get("jam_deteksi") or "", "status": _status_norm(p.get("status_peristiwa")),
                    "penugasan": p.get("ditugaskan_ke") or "", "catatan": p.get("catatan_operator") or "",
                    "rekomendasi": "Verifikasi lapangan / jadwalkan P2TL"})
    sev = {"critical": 0, "warning": 1, "info": 2}
    # active first, then severity, then the newest event (alarms without an event time — period findings — last)
    return sorted(out, key=lambda a: (a["status"] not in ACTIVE, sev.get(a["severity"], 3), not a["waktu"], _rev(a["waktu"])))


def _rev(s: str) -> str:
    """Descending sort key for ISO-like timestamps inside an ascending sort."""
    return "".join(chr(0x10FFFF - ord(c)) for c in (s or ""))


@router.get("/overview")
def overview() -> dict:
    import auth
    import demo_grid_ami as ami
    import demo_grid_sensor_gardu as sensor

    auth.require_user()
    saluran = _see("saluran")
    gd = _see("gardu_distribusi")
    per_status: dict[str, int] = {}
    for o in gd:
        s = str(o.get("status_gardu") or "-")
        per_status[s] = per_status.get(s, 0) + 1
    alarms = _alarm_rows()
    aktif = [a for a in alarms if a["status"] in ACTIVE]
    sev = {"critical": 0, "warning": 0, "info": 0}
    kat: dict[str, int] = {}
    for a in aktif:
        sev[a["severity"]] = sev.get(a["severity"], 0) + 1
        kat[a["kategori"] or "-"] = kat.get(a["kategori"] or "-", 0) + 1
    pny = _see("penyulang")
    kirim = sum(_num(p.get("mwh_kirim_q3")) for p in pny) or 1
    susut = {k: round(sum(_num(p.get(f)) * _num(p.get("mwh_kirim_q3")) for p in pny) / kirim, 2)
             for k, f in (("susut_pct", "susut_pct"), ("tl_pct", "susut_teknis_pct"), ("ntl_pct", "susut_non_teknis_pct"))}
    kor = _see("koridor")
    simpul = _see("simpul")
    risiko = _see("risiko")
    pmb = _see("pembebanan")
    top = max(pmb, key=lambda r: _num(r.get("beban_termal_pct")), default=None)
    dt_top = max((r for r in risiko if r.get("jenis_aset") == "Gardu distribusi"), key=lambda r: _num(r.get("beban_pct")), default=None)
    perintah = _see("perintah")
    return {
        "mode": MODE, "dibuat": datetime.now(timezone.utc).isoformat(),
        "transmisi": {"saluran": len(saluran), "gardu": len(_see("gardu")), "pembangkit": len(_see("pembangkit")), "per_kelas_kv": _per_kelas(saluran),
                      "struktural": {"koridor": len(kor), "kritis": sum(1 for k in kor if k.get("kritis_n1")),
                                     "kritis_berdampak": sum(1 for k in kor if k.get("kritis_n1") and (_num(k.get("gardu_terisolasi")) or _num(k.get("pembangkit_terisolasi")))),
                                     "mw_berisiko": round(sum(_num(k.get("mw_terisolasi")) for k in kor if k.get("kritis_n1"))),
                                     "artikulasi": sum(1 for s in simpul if s.get("titik_artikulasi")),
                                     "radial": sum(1 for s in simpul if s.get("koridor") == 1)}},
        "distribusi": {"gi": len(_see("gi")), "penyulang": len(pny), "gardu": len(gd), "per_status": per_status,
                       "pelanggan": int(sum(_num(o.get("jumlah_pelanggan")) for o in gd)) + sum(int(_num(p.get("jumlah_pelanggan_tm"))) for p in pny)},
        "n1_gi": [{k: r.get(k) for k in ("kode_gi", "nama_gi", "status_n1", "beban_firm_puncak_pct", "margin_n1_mva", "puncak_mva", "kapasitas_firm_mva", "waktu_puncak")}
                  | {"ref": _ref("n1_gi", r["_pk"])} for r in sorted(_see("n1_gi"), key=lambda r: r["_pk"])],
        "termal": {"maks_pct": _num(top.get("beban_termal_pct")) if top else None, "penyulang": top.get("kode_penyulang") if top else None,
                   "beban_tinggi": sum(1 for r in pmb if r.get("status_termal") != "Normal"),
                   "dt_maks_pct": _num(dt_top.get("beban_pct")) if dt_top else None, "dt": dt_top.get("kode_dt") if dt_top else None,
                   "dt_overload": sum(1 for r in risiko if r.get("jenis_aset") == "Gardu distribusi" and _num(r.get("beban_pct")) > 100)},
        "keandalan": _system_reliability(_see("keandalan"))["total"] | {"periode": _system_reliability(_see("keandalan"))["periode"]},
        "risiko": {k: sum(1 for r in risiko if r.get("kelas_risiko") == k) for k in ("Tinggi", "Sedang", "Rendah")},
        "susut": susut,
        "alarm": {"total": len(alarms), "aktif": len(aktif), "per_severity": sev, "per_kategori": dict(sorted(kat.items(), key=lambda kv: -kv[1])),
                  "belum_ditangani": sum(1 for a in alarms if a["status"] == "Baru")},
        "pekerjaan": {"perintah_terbuka": sum(1 for o in perintah if str(o.get("status_pekerjaan") or "") not in ("Selesai", "Batal")),
                      "perintah": len(perintah),
                      "kunjungan_terjadwal": sum(1 for o in _see("kunjungan") if o.get("status_kunjungan") == "Terjadwal")},
        "stream": {"ami": ami.sim_status(), "sensor_gardu": sensor.sim_status()},
        "kesegaran": _freshness(),
        "ketersediaan": {
            "loading_transmisi": "Tidak tersedia — rating konduktor & telemetri SCADA transmisi tidak ada di OSM; tidak diasumsikan dari kelas tegangan",
            "n1_transmisi_aliran_daya": "Tidak tersedia — butuh model impedansi tervalidasi + solver; tersedia N-1 STRUKTURAL (jembatan graf) dari topologi riil",
            "n1_gardu_induk": "Tersedia (demo) — puncak koinsiden per jam vs kapasitas firm satu trafo keluar",
            "loading_distribusi": "Tersedia (demo) — daya SCADA per jam penyulang vs KHA GIS; beban AMR per jam gardu",
            "keandalan": "Tersedia (demo) — IEEE 1366 dari SOE SCADA per penyulang per bulan"},
    }


def _freshness() -> list[dict]:
    import demo_grid_e2e as e

    pipes = e.STATE.get("pipelines") or {}
    rows = [("Pipeline aset & topologi", (pipes.get("aset") or {}).get("id")), ("Pipeline neraca energi & susut", (pipes.get("susut") or {}).get("id")),
            ("Pipeline beban per jam", e.STATE.get("iot_pipeline_id")), ("Pipeline analitik operasi", _ops_state().get("pipeline_id")),
            ("AMI streaming", (e.STATE.get("ami") or {}).get("pipeline_id")), ("NTL per jam (streaming)", (e.STATE.get("ntl_stream") or {}).get("pipeline_id")),
            ("Sensor gardu (streaming)", (e.STATE.get("sensor_gardu") or {}).get("pipeline_id"))]
    out = []
    for name, pid in rows:
        b = _last_build(pid)
        out.append({"nama": name, "pipeline_id": pid, "status": (b or {}).get("status") or "belum dibangun", "waktu": (b or {}).get("at"),
                    "sukses_terakhir": (b or {}).get("last_success")})
    return out


# ------------------------------------------------------------------------------------------------
# alarms — writes through Nexus actions
# ------------------------------------------------------------------------------------------------

@router.get("/alarms")
def alarms(severity: Optional[str] = None, status: Optional[str] = None, kategori: Optional[str] = None, q: str = "",
           aktif: bool = False, limit: int = 300) -> dict:
    import auth

    auth.require_user()
    rows = _alarm_rows()
    counts = {"status": {}, "severity": {}, "kategori": {}}
    for a in rows:
        for k, f in (("status", "status"), ("severity", "severity"), ("kategori", "kategori")):
            counts[k][a[f] or "-"] = counts[k].get(a[f] or "-", 0) + 1
    if aktif:
        rows = [a for a in rows if a["status"] in ACTIVE]
    if severity:
        rows = [a for a in rows if a["severity"] == severity]
    if status:
        rows = [a for a in rows if a["status"] == status]
    if kategori:
        rows = [a for a in rows if a["kategori"] == kategori]
    if q:
        ql = q.lower()
        rows = [a for a in rows if ql in f"{a['id']} {a['judul']} {a['aset']} {a['kode_penyulang']} {a['kode_dt']}".lower()]
    return {"events": rows[:limit], "total": len(rows), "counts": counts, "sumber": _prov("alarm", "peristiwa"),
            "actions": {k: (_action(v[0]) or {}).get("id") for k, v in _alarm_actions().items()}}


def _alarm_actions() -> dict:
    import demo_grid_operasi as op

    return op.ALARM_ACTIONS


def _action(name: str) -> Optional[dict]:
    return _by_name("action-types").get(name)


class AlarmAksi(BaseModel):
    aksi: str
    penugasan: str = ""
    catatan: str = ""


STATUS_OF = {"acknowledge": "Diakui", "assign": "Ditugaskan", "resolve": "Selesai", "reopen": "Baru"}


def _apply(action_name: str, params: dict) -> dict:
    import ontology

    a = _action(action_name)
    if not a:
        raise HTTPException(409, f"action '{action_name}' belum ada — jalankan langkah 'operasi' demo grid")
    return ontology.apply_action(a["id"], ontology.ApplyAction(parameters=params))


@router.post("/alarms/{kind}/{pk}/aksi")
def alarm_aksi(kind: str, pk: str, req: AlarmAksi) -> dict:
    """Acknowledge / assign / resolve / reopen an alarm: the matching Nexus action on the alarm's object (the caller's
    permissions and the action's rules apply; the edit history records who did it)."""
    import auth

    import demo_grid_operasi as op

    auth.require_user()
    if req.aksi not in STATUS_OF:
        raise HTTPException(400, "aksi harus acknowledge/assign/resolve/reopen")
    if req.aksi == "assign" and not req.penugasan.strip():
        raise HTTPException(400, "isi petugas/tim yang ditugaskan")
    if kind == "alarm":
        if not any(a["_pk"] == pk for a in _see("alarm")):
            raise HTTPException(404, "alarm tidak ditemukan")
        params = {"object": pk, "status_alarm": STATUS_OF[req.aksi], "catatan_operator": req.catatan}
        if req.aksi == "assign":
            params["ditugaskan_ke"] = req.penugasan.strip()
        _apply(op.ALARM_ACTIONS[req.aksi][0], params)
    elif kind == "peristiwa":
        if not any(a["_pk"] == pk for a in _see("peristiwa")):
            raise HTTPException(404, "peristiwa tidak ditemukan")
        params = {"object": pk, "status_peristiwa": STATUS_OF[req.aksi], "catatan_operator": req.catatan}
        if req.aksi == "assign":
            params["ditugaskan_ke"] = req.penugasan.strip()
        _apply(op.PERISTIWA_ACTION[0], params)
    else:
        raise HTTPException(400, "jenis alarm harus alarm/peristiwa")
    row = next((a for a in _alarm_rows() if a["kind"] == kind and a["id"] == pk), None)
    return {"alarm": row, "riwayat": alarm_riwayat(kind, pk)["entries"]}


@router.get("/alarms/{kind}/{pk}/riwayat")
def alarm_riwayat(kind: str, pk: str) -> dict:
    import auth
    import ontology_edits

    auth.require_user()
    t = _t("alarm" if kind == "alarm" else "peristiwa")
    if not t:
        raise HTTPException(404, "tipe alarm tidak ada")
    try:
        h = ontology_edits.edit_history(t["id"], pk)
    except HTTPException:
        return {"enabled": False, "entries": []}
    return {"enabled": h.get("enabled"), "entries": _named(h.get("entries") or [])}


def _named(entries: list[dict]) -> list[dict]:
    """History entries with the editor's display name next to the user id."""
    import auth

    names: dict[str, str] = {}
    for e in entries:
        uid = e.get("user")
        if uid and uid not in names:
            try:
                u = auth._user(uid) if str(uid).startswith("u-") else None
            except Exception:  # noqa: BLE001
                u = None
            names[uid] = (u or {}).get("display_name") or (u or {}).get("username") or str(uid)
    return [{**e, "user_name": names.get(e.get("user"), e.get("user"))} for e in entries]


# ------------------------------------------------------------------------------------------------
# assets: search and 360° detail, every related record with its Nexus reference
# ------------------------------------------------------------------------------------------------

ASSET_KEYS = ("saluran", "gardu", "pembangkit", "koridor", "gi", "penyulang", "gardu_distribusi")


def _label(key: str, p: dict) -> str:
    return str(p.get("nama") or p.get("judul") or p.get("kode_dt") or p.get("kode_penyulang") or p.get("kode_gi") or p.get("_pk"))


@router.get("/assets")
def assets(jenis: str = "saluran", q: str = "", kelas: Optional[int] = None, kritis: bool = False, limit: int = 25, offset: int = 0) -> dict:
    import auth

    auth.require_user()
    if jenis not in ASSET_KEYS:
        raise HTTPException(400, f"jenis harus salah satu {list(ASSET_KEYS)}")
    t = _t(jenis)
    rows = []
    for p in _see(jenis):
        if kelas is not None and int(_num(p.get("kelas_kv"))) != kelas:
            continue
        if kritis and not p.get("kritis_n1"):
            continue
        label = _label(jenis, p)
        if q and q.lower() not in f"{p['_pk']} {label}".lower():
            continue
        rows.append({"id": p["_pk"], "nama": label, "kelas_kv": p.get("kelas_kv"), "cakupan": p.get("cakupan") or p.get("kode_ulp"),
                     "status": p.get("status_gardu") or p.get("tingkat_susut") or ("KRITIS N-1" if p.get("kritis_n1") else None)})
    rows.sort(key=lambda r: r["nama"])
    return {"total": len(rows), "rows": rows[offset:offset + limit], "type_id": t["id"] if t else None}


def _one(key: str, pk: str) -> dict:
    hit = next((p for p in _see(key) if p["_pk"] == pk), None)
    if not hit:
        raise HTTPException(404, f"{key} {pk} tidak ditemukan atau tidak terlihat oleh akun ini")
    return hit


def _slim(p: dict, drop=("geometri",)) -> dict:
    return {k: v for k, v in p.items() if k not in drop and not k.startswith("_")}


@router.get("/assets/{jenis}/{pk:path}")  # OSM ids contain "/" (way/123)
def asset_detail(jenis: str, pk: str) -> dict:
    import auth

    auth.require_user()
    if jenis not in ASSET_KEYS:
        raise HTTPException(400, "jenis tidak dikenal")
    p = _one(jenis, pk)
    out: dict[str, Any] = {"jenis": jenis, "id": pk, "nama": _label(jenis, p), "ref": _ref(jenis, pk), "properti": _slim(p), "terhubung": [],
                           "risiko": None, "struktural": None, "koridor": [], "terkait": {}, "sumber": _prov(jenis)}
    if jenis == "saluran":
        for side in ("a", "b"):
            tgt = p.get(f"gardu_ujung_{side}")
            if tgt:
                key = "gardu" if any(g["_pk"] == tgt for g in _see("gardu")) else "pembangkit"
                out["terhubung"].append({"jenis": key, "id": tgt, "peran": f"Ujung {side.upper()}", "nama": p.get(f"nama_ujung_{side}"), "ref": _ref(key, tgt)})
        out["koridor"] = [_kor_row(k) for k in _see("koridor") if pk in (k.get("ruas_osm") or "").split(", ")]
        out["sumber"] += _prov("koridor")
    elif jenis in ("gardu", "pembangkit"):
        for s in _see("saluran"):
            if pk in (s.get("gardu_ujung_a"), s.get("gardu_ujung_b")):
                out["terhubung"].append({"jenis": "saluran", "id": s["_pk"], "peran": f"Saluran {int(_num(s.get('kelas_kv')))} kV", "nama": s.get("nama"),
                                         "ref": _ref("saluran", s["_pk"])})
        sp = next((s for s in _see("simpul") if s["_pk"] == pk), None)
        out["struktural"] = _slim(sp) | {"ref": _ref("simpul", pk)} if sp else None
        out["koridor"] = [_kor_row(k) for k in _see("koridor") if pk in (k.get("simpul_a"), k.get("simpul_b"))]
        out["sumber"] += _prov("simpul", "koridor")
    elif jenis == "koridor":
        for side in ("a", "b"):
            sid = p.get(f"simpul_{side}")
            if sid:
                out["terhubung"].append({"jenis": "simpul", "id": sid, "peran": f"Simpul {side.upper()}", "nama": p.get(f"nama_simpul_{side}"), "ref": _ref("simpul", sid)})
        out["terkait"]["ruas"] = [{"id": w, "ref": _ref("saluran", w)} for w in (p.get("ruas_osm") or "").split(", ") if w]
    elif jenis == "gi":
        n1 = next((r for r in _see("n1_gi") if r["_pk"] == pk), None)
        out["terkait"]["n1"] = _slim(n1) | {"ref": _ref("n1_gi", pk)} if n1 else None
        pmb = {r["_pk"]: r for r in _see("pembebanan")}
        out["terhubung"] = [{"jenis": "penyulang", "id": f["_pk"], "peran": "Penyulang", "nama": f.get("nama"), "ref": _ref("penyulang", f["_pk"]),
                             "nilai": f"{_num((pmb.get(f['_pk']) or {}).get('beban_termal_pct')):.1f}% termal · susut {f.get('susut_pct')}%"}
                            for f in _see("penyulang") if f.get("kode_gi") == pk]
        out["sumber"] += _prov("n1_gi", "pembebanan")
    elif jenis == "penyulang":
        risk = {r.get("kode_dt"): r for r in _see("risiko") if r.get("jenis_aset") == "Gardu distribusi"}
        out["terhubung"] = [{"jenis": "gardu_distribusi", "id": g["_pk"], "peran": "Gardu distribusi", "nama": g.get("nama"), "ref": _ref("gardu_distribusi", g["_pk"]),
                             "nilai": f"{g.get('status_gardu')} · risiko {(risk.get(g['_pk']) or {}).get('skor', '-')}"}
                            for g in _see("gardu_distribusi") if g.get("kode_penyulang") == pk]
        gi = p.get("kode_gi")
        if gi:
            out["terhubung"].insert(0, {"jenis": "gi", "id": gi, "peran": "Gardu induk", "nama": p.get("nama_gi"), "ref": _ref("gi", gi)})
        pmb = next((r for r in _see("pembebanan") if r["_pk"] == pk), None)
        out["terkait"]["pembebanan"] = _slim(pmb) | {"ref": _ref("pembebanan", pk)} if pmb else None
        out["terkait"]["keandalan"] = [_slim(r) | {"ref": _ref("keandalan", r["_pk"])} for r in sorted(_see("keandalan"), key=lambda r: r.get("bulan") or "")
                                       if r.get("kode_penyulang") == pk]
        out["terkait"]["gangguan"] = [_slim(g) | {"ref": _ref("gangguan", g["_pk"])} for g in sorted(_see("gangguan"), key=lambda g: g.get("waktu_trip") or "", reverse=True)
                                      if g.get("kode_penyulang") == pk]
        out["risiko"] = next((_slim(r) | {"ref": _ref("risiko", r["_pk"])} for r in _see("risiko") if r["_pk"] == f"PNY:{pk}"), None)
        out["sumber"] += _prov("pembebanan", "keandalan", "gangguan", "risiko")
    elif jenis == "gardu_distribusi":
        pny = p.get("kode_penyulang")
        if pny:
            out["terhubung"].append({"jenis": "penyulang", "id": pny, "peran": "Penyulang", "nama": pny, "ref": _ref("penyulang", pny)})
        out["risiko"] = next((_slim(r) | {"ref": _ref("risiko", r["_pk"])} for r in _see("risiko") if r["_pk"] == f"DT:{pk}"), None)
        out["terkait"]["temuan"] = [_slim(t, ("bukti",)) | {"ref": _ref("temuan", t["_pk"])} for t in _see("temuan") if t.get("kode_dt") == pk][:20]
        sen = next((s for s in _see("sensor") if s["_pk"] == pk), None)
        out["terkait"]["sensor"] = {"ref": _ref("sensor", pk), "seri": sen.get("seri_sensor")} if sen else None
        out["sumber"] += _prov("risiko", "temuan", "sensor")
    alarms_here = [a for a in _alarm_rows() if a["aset"] == pk or a.get("kode_dt") == pk or (jenis == "penyulang" and a.get("kode_penyulang") == pk)]
    out["alarm"] = alarms_here[:20]
    return out


def _kor_row(k: dict) -> dict:
    return {"id": k["_pk"], "nama": k.get("nama"), "kelas_kv": k.get("kelas_kv"), "panjang_km": k.get("panjang_km"), "kritis_n1": bool(k.get("kritis_n1")),
            "dampak": k.get("dampak"), "mw_terisolasi": k.get("mw_terisolasi"), "gardu_terisolasi": k.get("gardu_terisolasi"),
            "pembangkit_terisolasi": k.get("pembangkit_terisolasi"), "nama_simpul_a": k.get("nama_simpul_a"), "nama_simpul_b": k.get("nama_simpul_b"),
            "simpul_a": k.get("simpul_a"), "simpul_b": k.get("simpul_b"), "contoh_terisolasi": k.get("contoh_terisolasi"), "ref": _ref("koridor", k["_pk"])}


# ------------------------------------------------------------------------------------------------
# outages
# ------------------------------------------------------------------------------------------------

def _restore(waktu: Any, menit: Any) -> Optional[str]:
    try:
        return (datetime.fromisoformat(str(waktu)) + timedelta(minutes=_num(menit))).isoformat(timespec="minutes")
    except ValueError:
        return None


@router.get("/outages")
def outages(jenis: Optional[str] = None) -> dict:
    import auth

    auth.require_user()
    rows = []
    for g in _see("gangguan"):
        if jenis and g.get("jenis") != jenis:
            continue
        rows.append({"id": g["_pk"], "kode_penyulang": g.get("kode_penyulang"), "kode_ulp": g.get("kode_ulp"), "mulai": g.get("waktu_trip"),
                     "pulih": _restore(g.get("waktu_trip"), g.get("durasi_menit")), "jenis": g.get("jenis"), "penyebab": g.get("penyebab"),
                     "peralatan": g.get("peralatan_trip"), "durasi_menit": g.get("durasi_menit"), "pelanggan_padam": g.get("pelanggan_padam"),
                     "ens_kwh": g.get("kwh_tidak_tersalur"), "ref": _ref("gangguan", g["_pk"])})
    rows.sort(key=lambda r: r["mulai"] or "", reverse=True)
    per_sebab: dict[str, dict] = {}
    for r in rows:
        a = per_sebab.setdefault(r["penyebab"] or "-", {"penyebab": r["penyebab"] or "-", "gangguan": 0, "pelanggan_menit": 0.0})
        a["gangguan"] += 1
        a["pelanggan_menit"] += _num(r["durasi_menit"]) * _num(r["pelanggan_padam"])
    return {"padam_distribusi_demo": rows, "per_penyebab": sorted(per_sebab.values(), key=lambda a: -a["pelanggan_menit"]), "sumber": _prov("gangguan"),
            "padam_transmisi": {"tersedia": False,
                                "alasan": "Tidak ada data outage transmisi (OMS/SCADA produksi) di platform; daftar padam transmisi tidak dikarang dari geometri OSM"}}


@router.get("/outages/{pk}")
def outage_detail(pk: str) -> dict:
    import auth

    auth.require_user()
    g = _one("gangguan", pk)
    pulih = _restore(g.get("waktu_trip"), g.get("durasi_menit"))
    timeline = [{"waktu": g.get("waktu_trip"), "kejadian": f"{g.get('peralatan_trip')} trip ({g.get('tag_trip')}) — SOE SCADA demo"},
                {"waktu": g.get("waktu_trip"), "kejadian": f"Gangguan {str(g.get('jenis') or '').lower()}: {g.get('penyebab')}"}]
    if pulih:
        timeline.append({"waktu": pulih, "kejadian": f"Pulih setelah {g.get('durasi_menit')} menit (waktu trip + durasi SOE)"})
    kode = g.get("kode_penyulang")
    gardu = [{"id": d["_pk"], "nama": d.get("nama"), "pelanggan": int(_num(d.get("jumlah_pelanggan"))), "status": d.get("status_gardu"),
              "ref": _ref("gardu_distribusi", d["_pk"])} for d in _see("gardu_distribusi") if d.get("kode_penyulang") == kode]
    bulan = str(g.get("tanggal") or "")[:7]
    kd = next((r for r in _see("keandalan") if r["_pk"] == f"{kode} · {bulan}"), None)
    return {"id": pk, "properti": _slim(g), "ref": _ref("gangguan", pk), "timeline": timeline,
            "dampak_topologi": {"penyulang": kode, "penyulang_ref": _ref("penyulang", kode), "gardu": gardu,
                                "pelanggan_total": sum(x["pelanggan"] for x in gardu), "pelanggan_padam_soe": g.get("pelanggan_padam"),
                                "ens_kwh": g.get("kwh_tidak_tersalur"), "pelanggan_jam": g.get("pelanggan_jam_padam"),
                                "catatan": "Dampak dari relasi penyulang → gardu → pelanggan di Nexus (bukan jarak peta); pelanggan padam dari SOE"},
            "keandalan_bulan": _slim(kd) | {"ref": _ref("keandalan", kd["_pk"])} if kd else None}


# ------------------------------------------------------------------------------------------------
# loading & contingency
# ------------------------------------------------------------------------------------------------

@router.get("/beban")
def beban(hari: int = 7) -> dict:
    """GI hourly load (pipeline dataset), N-1 per GI, thermal loading per feeder, daily load curves, the most loaded
    transformers (asset risk)."""
    import auth

    auth.require_user()
    rows = _dataset_rows(_ops_item("beban_gi_per_jam"))
    gi: dict[str, dict] = {}
    for r in rows:
        a = gi.setdefault(r["kode_gi"], {"kode_gi": r["kode_gi"], "nama_gi": r.get("nama_gi"), "kapasitas_mva": r.get("kapasitas_mva"),
                                         "kapasitas_firm_mva": r.get("kapasitas_firm_mva"), "harian": {}, "jam": []})
        d = str(r["waktu"])[:10]
        a["harian"][d] = max(a["harian"].get(d, 0.0), _num(r.get("mva")))
        a["jam"].append(r)
    seri = []
    for a in gi.values():
        a["jam"].sort(key=lambda r: r["ts"])
        last = a["jam"][-24 * max(1, min(hari, 31)):]
        seri.append({"kode_gi": a["kode_gi"], "nama_gi": a["nama_gi"], "kapasitas_mva": a["kapasitas_mva"], "kapasitas_firm_mva": a["kapasitas_firm_mva"],
                     "harian_puncak_mva": [{"t": f"{d}T12:00:00+07:00", "value": round(v, 3)} for d, v in sorted(a["harian"].items())],
                     "per_jam_mva": [{"t": str(r["waktu"]).replace(" ", "T") + ":00+07:00", "value": r.get("mva")} for r in last]})
    profil: dict[str, list] = {}
    for r in _dataset_rows(_ops_item("profil_beban_penyulang")):
        profil.setdefault(r["kode_penyulang"], []).append({k: r.get(k) for k in ("jam", "rata_kw", "min_kw", "maks_kw", "rata_hari_kerja_kw", "rata_akhir_pekan_kw")})
    for v in profil.values():
        v.sort(key=lambda x: x["jam"])
    dt = sorted((r for r in _see("risiko") if r.get("jenis_aset") == "Gardu distribusi"), key=lambda r: -_num(r.get("beban_pct")))
    return {"gi": seri, "n1_gi": [_slim(r) | {"ref": _ref("n1_gi", r["_pk"]), "gi_ref": _ref("gi", r["_pk"])} for r in _see("n1_gi")],
            "penyulang": sorted((_slim(r) | {"ref": _ref("pembebanan", r["_pk"]), "penyulang_ref": _ref("penyulang", r["_pk"])} for r in _see("pembebanan")),
                                key=lambda r: -_num(r.get("beban_termal_pct"))),
            "profil": profil,
            "gardu": [{"kode_dt": r.get("kode_dt"), "kode_penyulang": r.get("kode_penyulang"), "kode_ulp": r.get("kode_ulp"), "beban_pct": r.get("beban_pct"),
                       "jam_overload": r.get("jam_overload"), "suhu_minyak_maks_c": r.get("suhu_minyak_maks_c"), "tegangan_ujung_min_v": r.get("tegangan_ujung_min_v"),
                       "kelas_risiko": r.get("kelas_risiko"), "skor": r.get("skor"), "rekomendasi": r.get("rekomendasi"), "kejadian_terakhir": r.get("kejadian_terakhir"),
                       "ref": _ref("gardu_distribusi", r.get("kode_dt")), "risiko_ref": _ref("risiko", r["_pk"])} for r in dt[:40]],
            "sumber": _prov("n1_gi", "pembebanan", "risiko") + [{"key": "dataset", "nama": n, "dataset_id": _ops_item(n), "lineage": f"dataset:{_ops_item(n)}"}
                                                                 for n in ("beban_gi_per_jam", "profil_beban_penyulang") if _ops_item(n)],
            "transmisi": {"tersedia": False,
                          "alasan": "Rating konduktor per ruas dan telemetri arus/MW transmisi tidak tersedia dari OSM; persentase beban transmisi tidak "
                                    "diasumsikan dari kelas tegangan. Adapter yang dibutuhkan: rating aset tervalidasi + seri waktu SCADA."}}


@router.get("/beban/penyulang/{kode}")
def beban_penyulang(kode: str, hari: int = 14) -> dict:
    import auth

    auth.require_user()
    pmb = _one("pembebanan", kode)
    rows = [r for r in _dataset_rows(_iot_item("daya_penyulang_per_jam")) if r.get("kode_penyulang") == kode]
    rows.sort(key=lambda r: r["ts"])
    last = rows[-24 * max(1, min(hari, 92)):]
    pf = 0.9
    st = next((p for p in _see("penyulang") if p["_pk"] == kode), None)
    if st and st.get("pf_rata"):
        pf = _num(st["pf_rata"], 0.9)
    batas = _num(pmb.get("batas_termal_a"), 1)
    return {"kode": kode, "pembebanan": _slim(pmb), "ref": _ref("penyulang", kode),
            "kw": [{"t": str(r["waktu"]).replace(" ", "T") + ":00+07:00", "value": r.get("kw")} for r in last],
            "termal_pct": [{"t": str(r["waktu"]).replace(" ", "T") + ":00+07:00",
                            "value": round(100 * _num(r.get("kw")) / (1.7320508 * 20.0 * pf) / batas, 2)} for r in last],
            "profil": sorted((x for x in _dataset_rows(_ops_item("profil_beban_penyulang")) if x.get("kode_penyulang") == kode), key=lambda x: x["jam"]),
            "sumber": [{"key": "dataset", "nama": "daya_penyulang_per_jam (pipeline beban per jam)", "dataset_id": _iot_item("daya_penyulang_per_jam"),
                        "lineage": f"dataset:{_iot_item('daya_penyulang_per_jam')}"}] + _prov("pembebanan")}


@router.get("/kontingensi")
def kontingensi() -> dict:
    import auth

    auth.require_user()
    kor = _see("koridor")
    simpul = _see("simpul")
    kritis = [k for k in kor if k.get("kritis_n1")]
    per_kelas: dict[str, dict] = {}
    for k in kor:
        a = per_kelas.setdefault(str(k.get("kelas_kv")), {"koridor": 0, "kritis": 0, "km": 0.0})
        a["koridor"] += 1
        a["kritis"] += 1 if k.get("kritis_n1") else 0
        a["km"] += _num(k.get("panjang_km"))
    st = _ops_state()
    return {
        "gi": [_slim(r) | {"ref": _ref("n1_gi", r["_pk"]), "gi_ref": _ref("gi", r["_pk"])} for r in _see("n1_gi")],
        "struktural": {
            "tersedia": bool(kor),
            "ringkas": {"koridor": len(kor), "kritis": len(kritis), "artikulasi": sum(1 for s in simpul if s.get("titik_artikulasi")),
                        "radial": sum(1 for s in simpul if s.get("koridor") == 1), "simpul": len(simpul),
                        "mw_berisiko": round(sum(_num(k.get("mw_terisolasi")) for k in kritis)),
                        "gardu_berisiko": int(sum(_num(k.get("gardu_terisolasi")) for k in kritis))},
            "per_kelas": {k: {**v, "km": round(v["km"])} for k, v in sorted(per_kelas.items(), key=lambda kv: -int(_num(kv[0])))},
            "kritis_teratas": [_kor_row(k) for k in sorted(kritis, key=lambda k: (-_num(k.get("mw_terisolasi")), -_num(k.get("gardu_terisolasi")),
                                                                                      -_num(k.get("kelas_kv"))))[:30]],
            "artikulasi_teratas": [_slim(s) | {"ref": _ref("simpul", s["_pk"]), "gardu_ref": _ref("gardu", s["_pk"]) if s.get("jenis") == "Gardu" else _ref("pembangkit", s["_pk"])}
                                   for s in sorted((s for s in simpul if s.get("titik_artikulasi")), key=lambda s: (-_num(s.get("koridor_kritis")), -_num(s.get("koridor"))))[:20]],
            "transform": {"repo_id": st.get("repo_id"), "status": st.get("topologi_built")},
            "metode": "Ruas OSM dirangkai menjadi koridor gardu-ke-gardu; koridor kritis = jembatan graf (Tarjan, multigraf: koridor paralel bukan "
                      "jembatan) — lepasnya memisahkan jaringan; titik artikulasi = gardu yang bila lepas memisahkan jaringan. Dampak = gardu, pembangkit "
                      "dan MW (tag kapasitas OSM) di sisi yang terpisah.",
            "batasan": "Konektivitas, bukan aliran daya: tanpa rating/impedansi; satu way OSM bisa memuat dua sirkuit (tag circuits tidak tersedia) "
                       "sehingga 'kritis' berarti satu koridor fisik, bukan pasti satu sirkuit; kelengkapan OSM tidak dijamin.",
        },
        "aliran_daya": {"tersedia": False, "status": "Tidak tersedia — adapter belum terhubung",
                        "alasan": "N-1 aliran daya membutuhkan model jaringan listrik tervalidasi (impedansi, rating, tap trafo, pembangkit & beban bus) "
                                  "dan solver. Data OSM hanya geometri + topologi, sehingga hasil aliran daya tidak dihitung dan tidak direkayasa.",
                        "kebutuhan": ["Model impedansi & parameter listrik per ruas/trafo tervalidasi", "Rating termal operasional per aset dari pemilik aset",
                                      "Snapshot beban/pembangkitan per bus bertanda waktu", "Solver aliran daya (mis. pandapower/OpenDSS) terkalibrasi",
                                      "Validasi hasil oleh insinyur operasi sebelum dipakai operasional"]},
        "sumber": _prov("n1_gi", "koridor", "simpul"),
    }


@router.get("/topologi")
def topologi(kritis: bool = False, kelas: Optional[int] = None, q: str = "", urut: str = "mw", limit: int = 50, offset: int = 0) -> dict:
    import auth

    auth.require_user()
    rows = []
    for k in _see("koridor"):
        if kritis and not k.get("kritis_n1"):
            continue
        if kelas is not None and int(_num(k.get("kelas_kv"))) != kelas:
            continue
        if q and q.lower() not in f"{k['_pk']} {k.get('nama')} {k.get('nama_simpul_a')} {k.get('nama_simpul_b')}".lower():
            continue
        rows.append(_kor_row(k))
    key = {"mw": lambda r: (-_num(r["mw_terisolasi"]), -_num(r["gardu_terisolasi"])), "panjang": lambda r: -_num(r["panjang_km"]),
           "nama": lambda r: r["nama"] or ""}.get(urut, lambda r: -_num(r["mw_terisolasi"]))
    rows.sort(key=key)
    return {"total": len(rows), "rows": rows[offset:offset + limit]}


# ------------------------------------------------------------------------------------------------
# reliability, risk, losses
# ------------------------------------------------------------------------------------------------

@router.get("/keandalan")
def keandalan() -> dict:
    import auth

    auth.require_user()
    rows = _see("keandalan")
    sistem = _system_reliability(rows)
    per: dict[str, dict] = {}
    for r in rows:
        a = per.setdefault(r["kode_penyulang"], {"kode_penyulang": r["kode_penyulang"], "kode_ulp": r.get("kode_ulp"), "pelanggan": r.get("jumlah_pelanggan"),
                                                  "saidi": 0.0, "saifi": 0.0, "maifi": 0.0, "gangguan": 0, "permanen": 0, "ens_kwh": 0.0, "bulan": {},
                                                  "ref": _ref("penyulang", r["kode_penyulang"])})
        a["saidi"] += _num(r.get("saidi_menit"))
        a["saifi"] += _num(r.get("saifi_kali"))
        a["maifi"] += _num(r.get("maifi_kali"))
        a["gangguan"] += int(_num(r.get("gangguan")))
        a["permanen"] += int(_num(r.get("gangguan_permanen")))
        a["ens_kwh"] += _num(r.get("ens_kwh"))
        a["bulan"][r.get("bulan")] = round(_num(r.get("saidi_menit")), 1)
    feeders = []
    for a in per.values():
        feeders.append({**a, "saidi": round(a["saidi"], 1), "saifi": round(a["saifi"], 2), "maifi": round(a["maifi"], 2), "ens_kwh": round(a["ens_kwh"]),
                        "caidi": round(a["saidi"] / a["saifi"], 1) if a["saifi"] else None})
    feeders.sort(key=lambda a: -a["saidi"])
    return {"sistem": sistem, "penyulang": feeders, "sumber": _prov("keandalan", "gangguan"),
            "definisi": {"SAIDI": "Σ(durasi × pelanggan padam) / total pelanggan — gangguan permanen", "SAIFI": "Σ pelanggan padam / total pelanggan — permanen",
                         "MAIFI": "Σ pelanggan terdampak gangguan temporer / total pelanggan", "CAIDI": "SAIDI / SAIFI — rata-rata lama pemulihan",
                         "ENS": "Energi tidak tersalur selama padam (kWh)"}}


@router.get("/risiko")
def risiko(jenis: Optional[str] = None, kelas: Optional[str] = None, limit: int = 200) -> dict:
    import auth

    auth.require_user()
    rows = []
    for r in _see("risiko"):
        if jenis and r.get("jenis_aset") != jenis:
            continue
        if kelas and r.get("kelas_risiko") != kelas:
            continue
        key = "gardu_distribusi" if r.get("jenis_aset") == "Gardu distribusi" else "penyulang"
        rows.append(_slim(r) | {"ref": _ref("risiko", r["_pk"]), "aset_ref": _ref(key, r.get("kode_aset")), "aset_jenis": key})
    rows.sort(key=lambda r: (-_num(r.get("skor")), r.get("kode_aset") or ""))
    faktor: dict[str, int] = {}
    for r in rows:
        if r.get("kelas_risiko") != "Rendah":
            faktor[r.get("faktor_utama") or "-"] = faktor.get(r.get("faktor_utama") or "-", 0) + 1
    return {"rows": rows[:limit], "total": len(rows), "per_kelas": {k: sum(1 for r in rows if r.get("kelas_risiko") == k) for k in ("Tinggi", "Sedang", "Rendah")},
            "per_faktor": dict(sorted(faktor.items(), key=lambda kv: -kv[1])), "sumber": _prov("risiko"),
            "metode": "Skor aturan deterministik dari keluaran pipeline (beban per jam AMR, suhu minyak, umur, tegangan ujung, NTL, temuan; penyulang: "
                      "beban termal, SAIDI, gangguan, susut) — bukan prediksi model; setiap poin punya bukti tertulis."}


@router.get("/ami")
def ami() -> dict:
    """AMI streaming in the Nexus (read as the caller): each pilot meter's health and the substations' hourly balance."""
    import auth

    auth.require_user()
    meters = _see("ami_kesehatan")
    hours = _see("neraca_jam")
    if not meters and not hours:
        return {"tersedia": False, "alasan": "Tipe Nexus AMI belum dibangun atau tidak terlihat oleh akun ini."}
    status: dict[str, int] = {}
    for m in meters:
        status[m.get("status_kesehatan") or "-"] = status.get(m.get("status_kesehatan") or "-", 0) + 1
    order = {"Not reporting": 0, "Check": 1, "Healthy": 2}
    cek = sorted((m for m in meters if m.get("status_kesehatan") != "Healthy"),
                 key=lambda m: (order.get(m.get("status_kesehatan"), 3), -_num(m.get("event_tamper"))))[:12]
    latest = max((h.get("jam_wib") or "" for h in hours), default="")
    jam_akhir = sorted((h for h in hours if h.get("jam_wib") == latest), key=lambda h: -_num(h.get("porsi_meter_rendah_pct")))
    per_jam: dict[str, dict] = {}
    for h in hours:
        a = per_jam.setdefault(h.get("jam_wib") or "", {"jam": h.get("jam_wib"), "kwh": 0.0, "anomali": 0})
        a["kwh"] += _num(h.get("kwh_jam"))
        a["anomali"] += 1 if h.get("status_jam") == "Anomaly" else 0
    tren = [{"jam": k, "kwh": round(v["kwh"], 1), "anomali": v["anomali"]} for k, v in sorted(per_jam.items())][-24:]
    pf = [_num(m.get("pf_rata")) for m in meters if m.get("pf_rata") is not None]
    return {
        "tersedia": True, "meter": len(meters), "status": status, "pf_rata": round(sum(pf) / len(pf), 3) if pf else None,
        "perlu_dicek": [{"no_meter": m.get("no_meter"), "kode_dt": m.get("kode_dt"), "kode_ulp": m.get("kode_ulp"), "status": m.get("status_kesehatan"),
                         "alasan": m.get("alasan"), "terakhir": m.get("bacaan_terakhir_wib"), "ref": _ref("ami_kesehatan", m.get("_pk"))} for m in cek],
        "jam_terakhir": latest, "gardu_jam_terakhir": [{"kode_dt": h.get("kode_dt"), "kwh": h.get("kwh_jam"), "aktif": h.get("meter_aktif"),
                                                       "rendah": h.get("meter_kwh_sangat_rendah"), "porsi": h.get("porsi_meter_rendah_pct"),
                                                       "status": h.get("status_jam"), "ref": _ref("neraca_jam", h.get("_pk"))} for h in jam_akhir[:10]],
        "tren_jam": tren, "sumber": _prov("ami_kesehatan", "neraca_jam"),
    }


@router.get("/loss")
def loss() -> dict:
    """Loss Intelligence from the Nexus energy balances (read as the caller): technical losses computed by physics in the
    loss pipeline vs non-technical residual scored by ML."""
    import auth

    auth.require_user()
    pny = _see("neraca_penyulang")
    gdu = _see("neraca_gardu")
    if not pny:
        return {"tersedia": False, "alasan": "Neraca energi penyulang tidak terlihat oleh akun ini atau pipeline susut belum dibangun."}

    def agg(rows, key, fields):
        acc: dict[str, dict] = {}
        for r in rows:
            a = acc.setdefault(r.get(key), {key: r.get(key), **{f: 0.0 for f in fields}})
            for f in fields:
                a[f] += _num(r.get(f))
        return acc

    bulan = sorted({r["bulan"] for r in pny if r.get("bulan")})
    per_bulan = agg(pny, "bulan", ["kwh_kirim", "susut_teknis_kwh", "susut_non_teknis_kwh"])
    tren = []
    for b in bulan:
        a = per_bulan[b]
        k = a["kwh_kirim"] or 1
        tren.append({"bulan": b, "kwh_kirim": round(a["kwh_kirim"]), "tl_kwh": round(a["susut_teknis_kwh"]), "ntl_kwh": round(a["susut_non_teknis_kwh"]),
                     "tl_pct": round(100 * a["susut_teknis_kwh"] / k, 2), "ntl_pct": round(100 * a["susut_non_teknis_kwh"] / k, 2)})
    akhir = bulan[-3:]
    pny_a = [r for r in pny if r.get("bulan") in akhir]
    gdu_a = [r for r in gdu if r.get("bulan") in akhir]
    trafo_gardu = sum(_num(r.get("rugi_trafo_kwh")) for r in gdu_a)
    komponen = [
        {"komponen": "Saluran TM 20 kV (I²R)", "kwh": round(sum(_num(r.get("rugi_saluran_kwh")) for r in pny_a)), "metode": "dihitung (fisika)"},
        {"komponen": "Trafo distribusi (besi+tembaga)", "kwh": round(trafo_gardu), "metode": "dihitung (fisika)"},
        {"komponen": "JTR 400 V (I²R Buller-Woodrow)", "kwh": round(max(0.0, sum(_num(r.get("susut_teknis_kwh")) for r in gdu_a) - trafo_gardu)), "metode": "dihitung (fisika)"},
        {"komponen": "Trafo gardu induk (di penyulang)", "kwh": round(sum(_num(r.get("rugi_trafo_kwh")) for r in pny_a)), "metode": "dihitung (fisika)"},
    ]
    hp = agg(pny_a, "kode_penyulang", ["kwh_kirim", "susut_teknis_kwh", "susut_non_teknis_kwh"])
    ulp_of = {r.get("kode_penyulang"): r.get("kode_ulp") for r in pny}
    hotspot_penyulang = sorted(({"kode": k, "ulp": ulp_of.get(k), "tl_kwh": round(v["susut_teknis_kwh"]),
                                 "tl_pct": round(100 * v["susut_teknis_kwh"] / (v["kwh_kirim"] or 1), 2), "ntl_kwh": round(v["susut_non_teknis_kwh"]),
                                 "ntl_pct": round(100 * v["susut_non_teknis_kwh"] / (v["kwh_kirim"] or 1), 2), "ref": _ref("penyulang", k)} for k, v in hp.items()),
                               key=lambda x: -x["tl_kwh"])[:10]
    hg = agg(gdu_a, "kode_dt", ["kwh_keluar", "susut_teknis_kwh", "susut_non_teknis_kwh", "hari_overload"])
    pny_of = {r.get("kode_dt"): r.get("kode_penyulang") for r in gdu}
    hotspot_gardu = sorted(({"kode": k, "penyulang": pny_of.get(k), "tl_kwh": round(v["susut_teknis_kwh"]),
                             "tl_pct": round(100 * v["susut_teknis_kwh"] / (v["kwh_keluar"] or 1), 2),
                             "ntl_pct": round(100 * v["susut_non_teknis_kwh"] / (v["kwh_keluar"] or 1), 2), "hari_overload": int(v["hari_overload"]),
                             "ref": _ref("gardu_distribusi", k)} for k, v in hg.items()), key=lambda x: -x["tl_kwh"])[:10]
    feeders = _see("penyulang")
    temuan = _see("temuan")
    per_ulp: dict[str, dict] = {}
    for f in feeders:
        u = per_ulp.setdefault(f.get("kode_ulp") or "-", {"kode_ulp": f.get("kode_ulp") or "-", "mwh_kirim_q3": 0.0, "_s": 0.0, "_t": 0.0, "_n": 0.0,
                                                           "nilai_susut_rp_q3": 0.0, "temuan_p1": 0, "nilai_harapan_rp": 0.0})
        m = _num(f.get("mwh_kirim_q3"))
        u["mwh_kirim_q3"] += m
        u["_s"] += m * _num(f.get("susut_pct"))
        u["_t"] += m * _num(f.get("susut_teknis_pct"))
        u["_n"] += m * _num(f.get("susut_non_teknis_pct"))
        u["nilai_susut_rp_q3"] += 3 * _num(f.get("nilai_susut_rp_bulan"))
    for t in temuan:
        u = per_ulp.get(t.get("kode_ulp") or "-")
        if u:
            u["temuan_p1"] += 1 if t.get("prioritas") == "P1" else 0
            u["nilai_harapan_rp"] += _num(t.get("nilai_harapan_rp"))
    ulp = []
    for u in per_ulp.values():
        m = u["mwh_kirim_q3"] or 1
        ulp.append({"kode_ulp": u["kode_ulp"], "mwh_kirim_q3": round(u["mwh_kirim_q3"], 1), "susut_pct": round(u["_s"] / m, 2),
                    "susut_teknis_pct": round(u["_t"] / m, 2), "susut_non_teknis_pct": round(u["_n"] / m, 2),
                    "nilai_susut_rp_q3": round(u["nilai_susut_rp_q3"]), "temuan_p1": u["temuan_p1"], "nilai_harapan_rp": round(u["nilai_harapan_rp"])})
    ulp.sort(key=lambda u: u["kode_ulp"])
    tk = sum(u["mwh_kirim_q3"] for u in ulp) or 1
    return {
        "tersedia": True, "periode_bulan": bulan, "per_ulp": ulp,
        "total": {"mwh_kirim_q3": round(tk, 1), "susut_pct": round(sum(u["susut_pct"] * u["mwh_kirim_q3"] for u in ulp) / tk, 2),
                  "tl_pct": round(sum(u["susut_teknis_pct"] * u["mwh_kirim_q3"] for u in ulp) / tk, 2),
                  "ntl_pct": round(sum(u["susut_non_teknis_pct"] * u["mwh_kirim_q3"] for u in ulp) / tk, 2),
                  "nilai_susut_rp_q3": round(sum(u["nilai_susut_rp_q3"] for u in ulp)), "temuan_p1": sum(u["temuan_p1"] for u in ulp),
                  "nilai_harapan_rp": round(sum(u["nilai_harapan_rp"] for u in ulp))},
        "tren": tren, "komponen_tl": komponen, "hotspot_penyulang": hotspot_penyulang, "hotspot_gardu": hotspot_gardu,
        "sumber": _prov("neraca_penyulang", "neraca_gardu", "penyulang", "temuan"),
        "metode": {
            "teknis": "Dihitung (fisika rekayasa demo): I²R saluran TM & JTR (faktor rugi Buller-Woodrow, faktor ketidakseimbangan fasa), rugi besi (tanpa beban) + "
                      "rugi tembaga (sebanding kuadrat beban) trafo. Parameter dari register aset demo — bukan impedansi terukur SCADA.",
            "non_teknis": "Residu neraca (kirim − tagih − teknis) lalu diberi skor ML (Isolation Forest + gradient boosting P2TL + aturan). Prediksi adalah "
                          "petunjuk investigasi, bukan vonis pencurian.",
            "terukur": "Tidak ada pengukuran SCADA/AMI produksi; AMI/sensor adalah simulasi berlabel demo.",
            "transmisi": "Tidak tersedia: impedansi & rating ruas transmisi OSM tidak ada, jadi TL transmisi tidak dihitung dan tidak diasumsikan dari kelas tegangan.",
        },
    }


@router.get("/lingkungan")
def lingkungan() -> dict:
    import auth

    auth.require_user()
    lapis = [
        {"nama": "Vegetasi & perambahan ROW", "status": "Tidak tersedia", "kebutuhan": "Observasi citra/drone bertanda waktu + batas ROW resmi per koridor dari pemilik aset"},
        {"nama": "Aktivitas konstruksi di koridor", "status": "Tidak tersedia", "kebutuhan": "Laporan inspeksi lapangan atau deteksi citra terverifikasi dengan waktu observasi"},
        {"nama": "Banjir & genangan", "status": "Tidak tersedia", "kebutuhan": "Umpan hidrologi/curah hujan resmi (mis. BMKG) bertanda waktu"},
        {"nama": "Longsor", "status": "Tidak tersedia", "kebutuhan": "Peta kerentanan gerakan tanah resmi + observasi lapangan"},
        {"nama": "Kebakaran & cuaca ekstrem", "status": "Tidak tersedia", "kebutuhan": "Umpan cuaca/kejadian resmi bertanda waktu"},
    ]
    return {"overlay": lapis,
            "catatan": "Tidak ada deteksi satelit, observasi cuaca, atau kejadian lingkungan yang dikarang; koridor transmisi tampil di peta gabungan "
                       "(termasuk layer koridor kritis N-1) dan inspeksi koridor dilakukan lewat kunjungan/inspeksi"}


# ------------------------------------------------------------------------------------------------
# field operations — work-order status through a Nexus action
# ------------------------------------------------------------------------------------------------

class WorkStatus(BaseModel):
    status: str
    pelaksana: str = ""


@router.post("/work-orders/{pk}/status")
def work_order_status(pk: str, req: WorkStatus) -> dict:
    import auth

    import demo_grid_operasi as op

    auth.require_user()
    if req.status not in ("Terbuka", "Dikerjakan", "Ditunda", "Selesai"):
        raise HTTPException(400, "status harus Terbuka/Dikerjakan/Ditunda/Selesai")
    _one("perintah", pk)
    params = {"object": pk, "status_pekerjaan": req.status}
    if req.pelaksana.strip():
        params["pelaksana"] = req.pelaksana.strip()
    _apply(op.PERINTAH_ACTION[0], params)
    return {"id": pk, "perintah": _slim(_one("perintah", pk)), "riwayat": _history("perintah", pk)}


def _history(key: str, pk: str) -> list[dict]:
    import ontology_edits

    t = _t(key)
    if not t:
        return []
    try:
        return _named(ontology_edits.edit_history(t["id"], pk).get("entries") or [])
    except HTTPException:
        return []


@router.get("/field")
def field() -> dict:
    import auth

    auth.require_user()
    perintah = [{"id": o["_pk"], "ref": _ref("perintah", o["_pk"]), "riwayat": _history("perintah", o["_pk"])[:5],
                 **{k: o.get(k) for k in ("id_perintah", "judul", "jenis_pekerjaan", "status_pekerjaan", "kode_dt", "kode_penyulang", "id_temuan", "uraian",
                                          "estimasi_biaya_rp", "tanggal_target", "pelaksana")}} for o in _see("perintah")]
    kunjungan = sorted(({"id": o["_pk"], "ref": _ref("kunjungan", o["_pk"]),
                         **{k: o.get(k) for k in ("id_kunjungan", "judul", "id_temuan", "id_pelanggan", "kode_dt", "kode_ulp", "kode_tim", "mulai", "selesai",
                                                  "prioritas", "pola_dugaan", "nilai_harapan_rp", "status_kunjungan")}} for o in _see("kunjungan")),
                       key=lambda r: r.get("mulai") or "")
    inspeksi = sorted(({"id": o["_pk"], "ref": _ref("inspeksi", o["_pk"]),
                        **{k: o.get(k) for k in ("no_ba", "id_pelanggan", "tanggal", "dasar_pemilihan", "golongan", "temuan", "tim", "rp_tagihan_susulan",
                                                 "ditemukan_pelanggaran", "kode_ulp")}} for o in _see("inspeksi")),
                      key=lambda r: r.get("tanggal") or "", reverse=True)[:60]
    return {"perintah_kerja": perintah, "kunjungan": kunjungan, "inspeksi": inspeksi,
            "actions": {"ubah_status": (_action(__import__("demo_grid_operasi").PERINTAH_ACTION[0]) or {}).get("id"),
                        "buat": (_action("Buat perintah kerja teknis (demo)") or {}).get("id")},
            "sumber": _prov("perintah", "kunjungan", "inspeksi"),
            "catatan": "Perubahan status lewat action Nexus 'Ubah status perintah kerja (demo)' (riwayat edit per objek); pembuatan perintah lewat action "
                       "'Buat perintah kerja teknis (demo)'. Cockpit tidak mengeksekusi switching/isolasi apa pun."}


# ------------------------------------------------------------------------------------------------
# data integration: pipelines → datasets → Nexus → apps, with freshness and lineage
# ------------------------------------------------------------------------------------------------

@router.get("/integrasi")
def integrasi() -> dict:
    import auth
    import code_repos
    import db
    import ontology
    import pipeline_runtime as rt

    import demo_grid_e2e as e
    import demo_grid_operasi as op

    auth.require_user()
    st = _ops_state()
    pipes = e.STATE.get("pipelines") or {}

    def ds(item_id: Optional[str], name: str) -> dict:
        it = db.drive_get(item_id) if item_id else None
        return {"nama": name, "dataset_id": item_id, "lineage": f"dataset:{item_id}" if item_id else None, "akses": bool(item_id and auth.can_access(item_id)),
                "diperbarui": (it or {}).get("updated_at"), "ukuran": (it or {}).get("size")}

    def out_state(pid: Optional[str], ids: dict) -> list[dict]:
        rows = []
        for name, oid in (ids or {}).items():
            s = (rt.get_state(pid, f"output:{oid}") or {}) if pid else {}
            rows.append({**ds(s.get("itemId"), name), "baris": s.get("rows"), "versi": s.get("version")})
        return rows

    def pipe(key: str, nama: str, pid: Optional[str], tipe: str, ids: Optional[dict] = None, sumber: Optional[list] = None) -> dict:
        return {"key": key, "nama": nama, "pipeline_id": pid, "tipe": tipe, "lineage": f"pipeline:{pid}" if pid else None,
                "build": _last_build(pid), "output": out_state(pid, ids or {}), "sumber": sumber or []}

    srcs = [ds(i, n) for n, i in (st.get("sources") or {}).items()]
    chain = [
        pipe("aset", "Pipeline aset & topologi jaringan grid (demo)", (pipes.get("aset") or {}).get("id"), "batch", (pipes.get("aset") or {}).get("output_ids")),
        pipe("susut", "Pipeline neraca energi & susut grid (demo)", (pipes.get("susut") or {}).get("id"), "batch", (pipes.get("susut") or {}).get("output_ids")),
        pipe("iot", "Pipeline beban per jam grid (demo)", e.STATE.get("iot_pipeline_id"), "batch",
             {n: f"o_{node}" for n, node in __import__("demo_grid_iot").OUTPUTS}),
        pipe("ami", "Pipeline AMI streaming grid (demo)", (e.STATE.get("ami") or {}).get("pipeline_id"), "streaming"),
        pipe("ntl", "Pipeline NTL per jam grid (demo)", (e.STATE.get("ntl_stream") or {}).get("pipeline_id"), "streaming"),
        pipe("sensor", "Pipeline sensor gardu grid (demo)", (e.STATE.get("sensor_gardu") or {}).get("pipeline_id"), "streaming"),
        pipe("operasi", op.PIPELINE, st.get("pipeline_id"), "batch", st.get("output_ids"), srcs),
    ]
    builds = [b for b in code_repos.all_builds() if b.get("repo_id") == st.get("repo_id")] if st.get("repo_id") else []
    last = max(builds, key=lambda b: b["at"]) if builds else None
    transform = {"nama": op.REPO, "repo_id": st.get("repo_id"), "transform": "topologi_struktural", "status": st.get("topologi_built"),
                 "build": {"status": last["status"], "at": last["at"]} if last else None,
                 "output": [ds((st.get("datasets") or {}).get(n), n) for n in ("koridor_transmisi_n1", "simpul_transmisi_struktural")],
                 "sumber": [ds(i, n) for n, i in (st.get("osm_sources") or {}).items()]}
    keys = ["alarm", "risiko", "n1_gi", "pembebanan", "keandalan", "koridor", "simpul", "gi", "penyulang", "gardu_distribusi", "pelanggan", "temuan",
            "gangguan", "neraca_penyulang", "neraca_gardu", "perintah", "kunjungan", "inspeksi", "peristiwa", "sensor", "saluran", "gardu", "pembangkit"]
    links = ontology._all("link-types")
    acts = ontology._all("action-types")
    nexus = []
    for k in keys:
        info = _type_info(k)
        if not info:
            continue
        rec = ontology._object_type(info["type_id"])
        nexus.append({**info, "objek_terlihat": len(_see(k)), "properti": len(rec.get("properties") or []),
                      "tautan": sum(1 for lt in links if info["type_id"] in (lt["source"]["object_type_id"], lt["target"]["object_type_id"])),
                      "actions": [{"id": a["id"], "nama": a["display_name"]} for a in acts if a.get("object_type_id") == info["type_id"]],
                      "riwayat": bool((rec.get("edits_config") or {}).get("history")),
                      "kebijakan_baris": bool(((rec.get("security") or {}).get("object_policy") or {}).get("granular")),
                      "grup": "operasi" if k in OPS else "osm" if k in OSM else "distribusi"})
    ids = {n["type_id"]: n["key"] for n in nexus}
    import lineage

    def part(lt: dict) -> Optional[dict]:
        try:
            return lineage.participation(lt)
        except Exception:  # noqa: BLE001 - shown as unknown
            return None

    relasi = [{"id": lt["id"], "nama": lt.get("display_name"), "dari": ids[lt["source"]["object_type_id"]], "ke": ids[lt["target"]["object_type_id"]],
               "kardinalitas": lt.get("cardinality"), "jenis": lt.get("kind"), "kunci": lt.get("foreign_key"), "partisipasi": part(lt)}
              for lt in links if lt["source"]["object_type_id"] in ids and lt["target"]["object_type_id"] in ids]
    return {"pipeline": chain, "transform": transform, "nexus": nexus, "relasi": relasi,
            "aplikasi": {"lineage_graph": op.LINEAGE_GRAPH, "lineage_grid": e.LINEAGE_GRAPH, "peta_gabungan": (e.STATE.get("peta_gabungan") or {}).get("map_id"),
                         "peta_susut": e.STATE.get("map_id"), "workshop": e.STATE.get("workshop_id"), "orbis": "/orbis/grid", "project_id": e.STATE.get("project_id"),
                         "monitor_ami": (e.STATE.get("ntl_stream") or {}).get("monitor")},
            "dibangun": st.get("built_at")}
