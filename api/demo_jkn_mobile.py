"""JKN mobile apps (demo): one API for the three PWAs at /jkn-mobile — Petugas JKN, Rumah Sakit, Peserta.

Claims, scores and reasons come from the fraud demo engine (demo_jkn_fraud: synthetic data). This module keeps what
the three apps exchange, so one demo runs as a closed loop:

  peserta reports "I did not receive this service"  →  appears in the officer's inbox
  officer decides on a claim (approve / hold / request documents)  →  the hospital sees the status and the request
  hospital uploads the requested document  →  the officer sees it arrive; the patient sees the report followed up

State: <data>/demo-jkn-mobile/state.json; uploaded files beside it. Everything is fictitious demo data.
"""

from __future__ import annotations

import json
import math
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import demo_jkn_fraud as fr

router = APIRouter(prefix="/api/demo/jkn/mobile", tags=["demo-jkn-mobile"])

DIR = Path("data/demo-jkn-mobile")
_lock = threading.Lock()
MAX_UPLOAD = 15 * 1024 * 1024

# example locations for the demo providers (fictitious, around Bandung) — for "faskes terdekat" and visit check-ins
LOKASI = {
    "RS-01": (-6.9175, 107.6191), "RS-02": (-6.8946, 107.6105), "KL-01": (-6.9321, 107.6346), "FKTP-01": (-6.9402, 107.5868),
    "FKTP-02": (-6.9268, 107.6702), "LAB-01": (-6.9046, 107.6239), "APT-01": (-6.9122, 107.6098),
}
DX = {"I10": "Hipertensi", "J18.9": "Pneumonia", "K35.8": "Apendisitis akut", "O82": "Persalinan sesar", "J06.9": "ISPA",
      "N18.5": "Gagal ginjal kronik", "M17.1": "Osteoartritis lutut", "O80": "Persalinan normal", "D64.9": "Anemia"}
JENIS_BERKAS = ["Resume medis", "Hasil lab", "Log tindakan", "Daftar hadir / kehadiran pasien", "Foto / rekaman tindakan"]


def configure(data_dir: Optional[Path] = None) -> None:
    global DIR
    if data_dir is not None:
        DIR = Path(data_dir) / "demo-jkn-mobile"


def _state() -> dict:
    f = DIR / "state.json"
    try:
        st = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    except Exception:  # noqa: BLE001 - a broken file starts the demo fresh
        st = {}
    for k in ("laporan", "keputusan_log", "permintaan", "berkas", "kunjungan"):
        st.setdefault(k, [])
    st.setdefault("keputusan", {})
    return st


def _save(st: dict) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = DIR / "state.tmp"
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(DIR / "state.json")


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M")


def _provider(fid: str) -> dict:
    p = fr.PROVIDER_BY_ID.get(fid)
    if not p:
        raise HTTPException(404, f"Faskes {fid} tidak dikenal")
    return p


def _assess(c: dict) -> dict:
    """The engine's lane for a claim (the same rule as the pre-payment queue) with its reasons."""
    r = fr.risk_score(c)
    issues = fr.validate_billing(c)
    hard = any(i["jenis"] in fr.HARD_STOP for i in issues) or c["no_sep"] in fr.DUP_SEPS
    lane = "hold" if hard or r["skor"] >= 70 else "review" if r["skor"] >= 30 else "otomatis"
    return {"skor": r["skor"], "tier": r["tier"], "jalur": lane,
            "alasan": [i["label"] + (f" — {i['detail']}" if i.get("detail") else "") for i in issues] or [f["penjelasan"] for f in r["factors"]],
            "faktor": [{"faktor": f["faktor"], "kontribusi": f["kontribusi"], "penjelasan": f["penjelasan"]} for f in r["factors"]],
            "nilai_risiko_rp": sum(i.get("nilai_risiko", 0) for i in issues)}


STATUS_JALUR = {"hold": "Ditahan — menunggu verifikasi", "review": "Review verifikator", "otomatis": "Disetujui otomatis"}
STATUS_KEPUTUSAN = {"setujui": "Disetujui petugas", "tahan": "Ditahan petugas", "minta_berkas": "Menunggu berkas tambahan"}


def _claim_view(c: dict, st: dict, mask_peserta: bool = False) -> dict:
    a = _assess(c)
    k = st["keputusan"].get(c["no_sep"])
    proc = fr.PROCEDURES.get(c["prosedur"], ("-", 0, ()))
    if c["status_bayar"] == "sudah_dibayar" and not k:
        status = "Sudah dibayar"
    elif k:
        status = STATUS_KEPUTUSAN.get(k["keputusan"], k["keputusan"])
    else:
        status = STATUS_JALUR[a["jalur"]]
    return {
        "no_sep": c["no_sep"], "tanggal": str(c["tanggal"]), "peserta": (c["peserta"][:4] + "•••" + c["peserta"][-1:]) if mask_peserta else c["peserta"],
        "faskes": c["faskes"], "nama_faskes": fr.PROVIDER_BY_ID.get(c["faskes"], {}).get("nama", c["faskes"]),
        "dokter": fr.DOCTOR_BY_ID.get(c["dokter"], {}).get("nama", c["dokter"]),
        "diagnosa": c["diagnosa"], "diagnosa_nama": DX.get(c["diagnosa"], c["diagnosa"]), "prosedur": c["prosedur"], "prosedur_nama": proc[0],
        "tarif_klaim": c["tarif_klaim"], "status_bayar": c["status_bayar"], "status": status, "keputusan": k,
        "dokumen": c["dokumen"], **a,
        "laporan_peserta": [x for x in st["laporan"] if x["no_sep"] == c["no_sep"]],
        "permintaan": [x for x in st["permintaan"] if x["no_sep"] == c["no_sep"]],
        "berkas": [x for x in st["berkas"] if x["no_sep"] == c["no_sep"]],
    }


def _claim(no_sep: str) -> dict:
    c = fr.CLAIM_BY_SEP.get(no_sep)
    if not c:
        raise HTTPException(404, f"SEP {no_sep} tidak dikenal")
    return c


# ---------------------------------------------------------------- peserta

@router.get("/peserta")
def peserta_list() -> dict:
    ids: dict[str, int] = {}
    for c in fr.CLAIMS:
        ids[c["peserta"]] = ids.get(c["peserta"], 0) + 1
    return {"peserta": [{"id": k, "layanan": v} for k, v in sorted(ids.items())], "default": "PES-204"}


@router.get("/peserta/{pid}")
def peserta(pid: str) -> dict:
    claims = [c for c in fr.CLAIMS if c["peserta"] == pid]
    if not claims:
        raise HTTPException(404, f"Peserta {pid} tidak dikenal")
    st = _state()
    fktp = "FKTP-01" if int("".join(ch for ch in pid if ch.isdigit()) or 0) % 2 else "FKTP-02"
    return {
        "kartu": {"id": pid, "nama": f"Peserta Demo {pid[-3:]}", "no_kartu": f"0001 {sum(map(ord, pid)) * 37 % 10000:04d} •••• {pid[-3:]}",
                  "segmen": "PBPU / Mandiri", "kelas": "Kelas 2", "fktp": fr.PROVIDER_BY_ID[fktp]["nama"], "status": "Aktif"},
        "layanan": sorted((_claim_view(c, st) for c in claims), key=lambda x: x["tanggal"], reverse=True),
        "laporan": [x for x in st["laporan"] if x["peserta"] == pid],
    }


class LaporIn(BaseModel):
    no_sep: str
    alasan: str = Field(min_length=1, max_length=600)
    jenis: str = "Tidak menerima layanan"


@router.post("/peserta/{pid}/lapor")
def lapor(pid: str, body: LaporIn) -> dict:
    c = _claim(body.no_sep)
    if c["peserta"] != pid:
        raise HTTPException(403, "Layanan ini bukan atas nama peserta tersebut")
    with _lock:
        st = _state()
        rec = {"id": f"LPR-{uuid.uuid4().hex[:6].upper()}", "peserta": pid, "no_sep": body.no_sep, "faskes": c["faskes"], "jenis": body.jenis,
               "alasan": body.alasan.strip(), "waktu": _now(), "status": "Baru", "tindak_lanjut": None}
        st["laporan"].append(rec)
        _save(st)
    return rec


@router.get("/faskes")
def faskes(lat: Optional[float] = None, lon: Optional[float] = None) -> dict:
    here = (lat, lon) if lat is not None and lon is not None else (-6.9147, 107.6098)
    out = []
    for p in fr.PROVIDERS:
        if p["id"] not in LOKASI:
            continue
        la, lo = LOKASI[p["id"]]
        km = 6371 * 2 * math.asin(math.sqrt(math.sin(math.radians(la - here[0]) / 2) ** 2 + math.cos(math.radians(here[0])) * math.cos(math.radians(la))
                                            * math.sin(math.radians(lo - here[1]) / 2) ** 2))
        out.append({**p, "lat": la, "lon": lo, "jarak_km": round(km, 2)})
    return {"faskes": sorted(out, key=lambda x: x["jarak_km"]), "dari": {"lat": here[0], "lon": here[1], "gps": lat is not None},
            "catatan": "Lokasi faskes contoh (demo)"}


# ---------------------------------------------------------------- rumah sakit

@router.get("/rs/{fid}")
def rs(fid: str) -> dict:
    p = _provider(fid)
    st = _state()
    claims = [_claim_view(c, st, mask_peserta=True) for c in fr.CLAIMS if c["faskes"] == fid]
    claims.sort(key=lambda x: (x["status_bayar"] == "sudah_dibayar", x["tanggal"]), reverse=False)
    n = len(claims) or 1
    lengkap = sum(1 for c in claims if all(c["dokumen"].values()))
    otomatis = sum(1 for c in claims if c["jalur"] == "otomatis")
    rata = sum(c["skor"] for c in claims) / n
    kepatuhan = round(0.4 * lengkap / n * 100 + 0.4 * otomatis / n * 100 + 0.2 * (100 - rata))
    return {
        "faskes": {**p, "lokasi": LOKASI.get(fid)},
        "kepatuhan": {"skor": kepatuhan, "dokumen_lengkap_pct": round(lengkap / n * 100), "lolos_otomatis_pct": round(otomatis / n * 100),
                      "rata_skor_risiko": round(rata, 1), "rumus": "40% dokumen lengkap + 40% lolos otomatis + 20% (100 − rata skor risiko)"},
        "klaim": claims,
        "permintaan_terbuka": [x for x in st["permintaan"] if x["faskes"] == fid and x["status"] == "Terbuka"],
        "jenis_berkas": JENIS_BERKAS,
    }


@router.get("/rs")
def rs_list() -> dict:
    return {"faskes": [p for p in fr.PROVIDERS if any(c["faskes"] == p["id"] for c in fr.CLAIMS)], "default": "RS-01"}


class CekIn(BaseModel):
    dokter: str = "D-01"
    diagnosa: str = "J18.9"
    prosedur: str = "87.44"
    severity_diklaim: int = Field(1, ge=1, le=3)
    severity_didukung: int = Field(1, ge=1, le=3)
    tarif_klaim: int = Field(3_000_000, ge=0)
    dokumen: dict[str, bool] = {"resume_medis": True, "hasil_lab": True, "log_tindakan": True, "kehadiran": True}


@router.post("/rs/{fid}/cek")
def cek(fid: str, body: CekIn) -> dict:
    """The hospital checks a claim before sending it: the same rules and score, nothing recorded."""
    _provider(fid)
    c = fr._claim(9998, peserta="PES-CEK", faskes=fid, dokter=body.dokter if body.dokter in fr.DOCTOR_BY_ID else "D-01",
                  diagnosa=body.diagnosa, prosedur=body.prosedur if body.prosedur in fr.PROCEDURES else "NONE",
                  severity_diklaim=body.severity_diklaim, severity_didukung=body.severity_didukung, tarif_klaim=body.tarif_klaim,
                  dokumen={**{"resume_medis": True, "hasil_lab": True, "log_tindakan": True, "kehadiran": True}, **body.dokumen})
    a = _assess(c)
    saran = []
    for d, ok in c["dokumen"].items():
        if not ok:
            saran.append(f"Lengkapi {d.replace('_', ' ')} sebelum mengirim")
    tarif = fr.PROCEDURES.get(c["prosedur"], ("", 0, ()))[1]
    if tarif and c["tarif_klaim"] > tarif * 1.1:
        saran.append(f"Tarif melebihi kontrak ({tarif:,} untuk prosedur ini) — sesuaikan atau lampirkan justifikasi".replace(",", "."))
    if c["severity_diklaim"] > c["severity_didukung"]:
        saran.append("Tingkat keparahan diklaim lebih tinggi dari yang didukung hasil lab — sesuaikan atau lampirkan bukti")
    return {**a, "status_perkiraan": STATUS_JALUR[a["jalur"]], "saran": saran or ["Klaim siap dikirim"], "tercatat": False}


@router.post("/rs/{fid}/berkas")
async def unggah_berkas(fid: str, no_sep: str = Form(...), jenis: str = Form(...), catatan: str = Form(""), file: UploadFile = File(...)) -> dict:
    _provider(fid)
    c = _claim(no_sep)
    if c["faskes"] != fid:
        raise HTTPException(403, "Klaim ini bukan milik faskes tersebut")
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Berkas maksimal 15 MB")
    bid = f"BRK-{uuid.uuid4().hex[:8].upper()}"
    name = Path(file.filename or "berkas").name[:120]
    with _lock:
        (DIR / "files").mkdir(parents=True, exist_ok=True)
        (DIR / "files" / bid).write_bytes(data)
        st = _state()
        rec = {"id": bid, "no_sep": no_sep, "faskes": fid, "jenis": jenis, "nama_file": name, "ukuran": len(data),
               "content_type": file.content_type or "application/octet-stream", "catatan": catatan, "waktu": _now(), "dibaca": False}
        st["berkas"].append(rec)
        for r in st["permintaan"]:
            if r["no_sep"] == no_sep and r["status"] == "Terbuka" and (r["jenis"] == jenis or not r.get("jenis")):
                r["status"] = "Dipenuhi"
                r["dipenuhi"] = _now()
        _save(st)
    return rec


@router.get("/berkas/{bid}")
def berkas_file(bid: str) -> FileResponse:
    st = _state()
    rec = next((x for x in st["berkas"] if x["id"] == bid), None)
    f = DIR / "files" / bid
    if not rec or not f.exists():
        raise HTTPException(404, "Berkas tidak ditemukan")
    return FileResponse(f, media_type=rec["content_type"], filename=rec["nama_file"])


# ---------------------------------------------------------------- petugas

@router.get("/petugas")
def petugas() -> dict:
    st = _state()
    unpaid = [c for c in fr.CLAIMS if c["status_bayar"] == "belum_dibayar"]
    views = [_claim_view(c, st, mask_peserta=True) for c in unpaid]
    reported = {x["no_sep"] for x in st["laporan"] if x["status"] == "Baru"}
    # reported by a patient first, then by lane and score
    order = {"hold": 0, "review": 1, "otomatis": 2}
    views.sort(key=lambda v: (v["no_sep"] not in reported, v["keputusan"] is not None, order[v["jalur"]], -v["skor"]))
    lanes = {k: sum(1 for v in views if v["jalur"] == k and not v["keputusan"]) for k in order}
    laporan = sorted(st["laporan"], key=lambda x: x["waktu"], reverse=True)
    for x in laporan:
        c = fr.CLAIM_BY_SEP.get(x["no_sep"])
        if c:
            x.update({"nama_faskes": fr.PROVIDER_BY_ID.get(c["faskes"], {}).get("nama"), "tarif_klaim": c["tarif_klaim"],
                      "prosedur_nama": fr.PROCEDURES.get(c["prosedur"], ("-",))[0]})
    return {
        "ringkasan": {**lanes, "laporan_baru": sum(1 for x in st["laporan"] if x["status"] == "Baru"),
                      "berkas_baru": sum(1 for x in st["berkas"] if not x["dibaca"]),
                      "nilai_ditahan_rp": sum(v["tarif_klaim"] for v in views if (v["keputusan"] or {}).get("keputusan") == "tahan" or (not v["keputusan"] and v["jalur"] == "hold"))},
        "antrian": views,
        "laporan": laporan,
        "berkas": sorted(st["berkas"], key=lambda x: x["waktu"], reverse=True),
        "kasus": [{k: c[k] for k in ("id", "judul", "status", "prioritas", "skor_risiko", "nama_faskes", "jumlah_klaim", "estimasi_kerugian_rp")} for c in fr.CASES],
        "kunjungan": sorted(st["kunjungan"], key=lambda x: x["waktu"], reverse=True),
        "faskes": [{**p, "lokasi": LOKASI.get(p["id"])} for p in fr.PROVIDERS if p["id"] in LOKASI],
        "jenis_berkas": JENIS_BERKAS,
    }


class KeputusanIn(BaseModel):
    no_sep: str
    keputusan: str  # setujui | tahan | minta_berkas
    catatan: str = ""
    jenis_berkas: Optional[str] = None
    petugas: str = "Petugas Verifikasi (demo)"


@router.post("/petugas/keputusan")
def keputusan(body: KeputusanIn) -> dict:
    if body.keputusan not in STATUS_KEPUTUSAN:
        raise HTTPException(400, "keputusan: setujui, tahan atau minta_berkas")
    c = _claim(body.no_sep)
    if body.keputusan == "minta_berkas" and not body.jenis_berkas:
        raise HTTPException(400, "Pilih jenis berkas yang diminta")
    with _lock:
        st = _state()
        rec = {"no_sep": body.no_sep, "keputusan": body.keputusan, "catatan": body.catatan, "petugas": body.petugas, "waktu": _now()}
        st["keputusan"][body.no_sep] = rec
        st["keputusan_log"].append(rec)
        if body.keputusan == "minta_berkas":
            st["permintaan"].append({"id": f"REQ-{uuid.uuid4().hex[:6].upper()}", "no_sep": body.no_sep, "faskes": c["faskes"], "jenis": body.jenis_berkas,
                                     "catatan": body.catatan, "waktu": _now(), "status": "Terbuka"})
        for x in st["laporan"]:
            if x["no_sep"] == body.no_sep and x["status"] == "Baru":
                x["status"] = "Ditindaklanjuti"
                x["tindak_lanjut"] = f"{STATUS_KEPUTUSAN[body.keputusan]} · {_now()}"
        _save(st)
    fr._audit(body.petugas, f"mobile:{body.keputusan}", f"{body.no_sep} {body.catatan}".strip())
    return rec


@router.post("/petugas/berkas/{bid}/dibaca")
def berkas_dibaca(bid: str) -> dict:
    with _lock:
        st = _state()
        for x in st["berkas"]:
            if x["id"] == bid:
                x["dibaca"] = True
        _save(st)
    return {"ok": True}


@router.post("/petugas/kunjungan")
async def kunjungan(faskes: str = Form(...), catatan: str = Form(""), lat: Optional[float] = Form(None), lon: Optional[float] = Form(None),
                    temuan: str = Form("Sesuai"), foto: Optional[UploadFile] = File(None)) -> dict:
    p = _provider(faskes)
    vid = f"KJG-{uuid.uuid4().hex[:6].upper()}"
    foto_id = None
    if foto is not None:
        data = await foto.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "Foto maksimal 15 MB")
        if data:
            foto_id = f"FOTO-{vid}"
            (DIR / "files").mkdir(parents=True, exist_ok=True)
            (DIR / "files" / foto_id).write_bytes(data)
    jarak = None
    if lat is not None and lon is not None and faskes in LOKASI:
        la, lo = LOKASI[faskes]
        jarak = round(math.hypot((la - lat) * 111, (lo - lon) * 111 * math.cos(math.radians(lat))), 2)
    rec = {"id": vid, "faskes": faskes, "nama_faskes": p["nama"], "lat": lat, "lon": lon, "jarak_ke_faskes_km": jarak, "temuan": temuan,
           "catatan": catatan, "foto": foto_id, "foto_type": foto.content_type if foto is not None else None, "waktu": _now()}
    with _lock:
        st = _state()
        st["kunjungan"].append(rec)
        if foto_id:
            st["berkas"].append({"id": foto_id, "no_sep": "-", "faskes": faskes, "jenis": "Foto kunjungan", "nama_file": f"{vid}.jpg", "ukuran": 0,
                                 "content_type": rec["foto_type"] or "image/jpeg", "catatan": catatan, "waktu": _now(), "dibaca": True})
        _save(st)
    return rec
