"""The realtime system inside the audit system, and its connection to the hospitals that send claims.

Into the audit system (Quantexa: "send signals to other tools"):
- write_tags: every alerted claim's signals become tags in the indikasi ledger at once (aip/indikasi.py, the ledger
  the AI Agent Swarm and Box Karantina read), as the source "deteksi_realtime": on the claim, and for the facility-level
  signals (a ring, a severity burst, cloning) on the facility too. A TAHAN decision writes them "sedang", a PERIKSA one
  "lemah"; the ledger computes the shown strength as for any source. A tag a person rejected before is not raised again
  (indikasi.refused).
- decide_tags: a person's verdict on a case decides its tags in the ledger (dikonfirmasi / ditolak), the same gate
  as the ledger's own decision; a tag another source also raised is only rejected by the ledger's own reviewers.

From the hospitals (ai-jkn's Kodifikasi "Submit klaim"):
- a source registry (sumber.json): the insurer's own record of each connected hospital's profile (kab/kota,
  ownership, kind, type, tariff region) — the claim's facility comes from here, not from the hospital's declaration
- an ingest token per deployment, kept only as its SHA-256 (POST /token shows it once)
- map_faskes: the hospital's submission → the claims contract (aip/layanan.KlaimIn), the patient resolved to an
  entity first (entitas.Resolver). The hospital gets a receipt, never the score (no tipping-off: the decision is the
  insurer's).
"""

from __future__ import annotations

import hashlib
import re
import secrets
from datetime import date, datetime
from typing import Any, Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from aip.realtime.store import data_dir

AGENT = "deteksi_realtime"
ROLE = "Deteksi fraud realtime (stream: entity resolution, graf, model, aturan)"
# signals about a facility's pattern, not one claim: tagged on the facility (and every ring member) too
FACILITY_SIGNALS = {"CINCIN_FASKES", "LONJAKAN_KEPARAHAN", "KLONING_LINTAS_PESERTA", "LOS_FASKES_BERGESER", "RRNS_FKTP_NAIK", "RRNS_PUSKESMAS_NAIK",
                    "KONSENTRASI_RUJUKAN", "KONTAK_SEMU", "KONTAK_RENDAH", "NONKAP_LONJAKAN"}


# ------------------------------------------------------------------------------------------------
# into the audit system: the indikasi ledger
# ------------------------------------------------------------------------------------------------


def write_tags(evs: list[dict], graf: Any, fstate: Any = None) -> tuple[int, int]:
    """The alerted events' signals as tags (one bulk write); returns (tags written, of which new). An FKRTL claim is
    tagged as a claim (and its facility for facility-level signals); an FKTP visit, a non-capitation claim or a periodic
    facility finding is tagged on its facility (the ledger's claim entity is the FKRTL claim), the visit in the evidence."""
    from aip import indikasi as I

    recs: dict[str, dict] = {}
    sources: list[tuple[str, dict]] = []
    new = 0

    def put(entitas: str, kunci: str, tag: str, src: dict, judul: str, ctx: dict) -> None:
        nonlocal new
        if I.refused(entitas, kunci, tag):
            return
        rec, is_new = I.upsert(entitas, kunci, tag, src, judul, ctx, save=False)
        new += is_new
        recs[rec["id"]] = rec
        sources.append((rec["id"], rec["sumber"][-1]))

    for e in evs:
        level = "sedang" if e["keputusan"] == "TAHAN" else "lemah"
        fkrtl = e.get("jenis", "fkrtl") == "fkrtl"
        ctx = {"faskes_profil_id": e["faskes"], "provinsi": e.get("provinsi"), "kabkota": e.get("kab"), "nama_profil": e["faskes_label"],
               "bulan": (e.get("tgl_datang") or "")[:7]}
        if fkrtl:
            ctx.update(klaim_id=e["klaim"], inacbg_kode=e["kode"], biaya_tagih_rp=e["biaya"])
        done: set[str] = set()
        for s in e["sinyal"]:
            tag = s.get("tag")
            if not tag or s["kontribusi"] <= 0:
                continue
            what = "" if fkrtl else f" ({'kunjungan FKTP' if e['jenis'] == 'fktp' else 'klaim nonkapitasi' if e['jenis'] == 'nonkap' else 'pemantauan'} {e['kunjungan']})"
            src = {"agen": AGENT, "peran": ROLE, "model": "aturan", "aturan": s["kode"], "kekuatan": level,
                   "bukti": f"[realtime {e['keputusan']} skor {e['skor']:.0f}{', ' + ', '.join(s.get('modus') or []) if s.get('modus') else ''}] "
                            f"{s['label']}{what}: {s['bukti']}"[:1990],
                   "realtime": {"peristiwa": e["id"], "kasus": e.get("kasus"), "skor": e["skor"], "sumber": e["sumber"], "modus": s.get("modus")}}
            if fkrtl and tag not in done:
                put("klaim", e["klaim"], tag, src, f"{e['faskes_label']} · {e['kode']} · {e['tgl_datang']}", ctx)
                done.add(tag)
            if not fkrtl and tag not in done:
                put("faskes", e["faskes"], tag, src, e["faskes_label"], ctx)
                done.add(tag)
                continue
            if s["kode"] in FACILITY_SIGNALS:
                fids = s["fokus"][1].split("|") if s["fokus"][0] == "jaringan" else [e["faskes"]]
                for fid in fids:
                    meta = (graf.meta.get(fid) if graf else None) or (fstate.meta.get(fid) if fstate else None) or {}
                    put("faskes", fid, tag, src, meta.get("label") or e["faskes_label"],
                        {"faskes_profil_id": fid, "provinsi": meta.get("prov") or e.get("provinsi"), "kabkota": meta.get("kab_nama") or e.get("kab"),
                         "nama_profil": meta.get("label") or e["faskes_label"]})
    if recs:
        I._save(list(recs.values()), sources)
        I._schedule_sync()
    return len(recs), new


def decide_tags(case: dict, status: str, catatan: str) -> dict:
    """A person's verdict on a realtime case → its tags in the ledger: confirmed, or (only where this detector was the
    sole source) rejected as a false positive."""
    import auth

    from aip import indikasi as I

    p = auth.current() or {}
    who = p.get("username") or p.get("id") or "admin"
    ev_ids = set(case.get("peristiwa") or [])
    changed, kept = [], 0
    with I._lock:
        for iid, rec in I._all().items():
            mine = [s for s in rec.get("sumber") or [] if s.get("agen") == AGENT and (s.get("realtime") or {}).get("kasus") == case["id"]
                    or s.get("agen") == AGENT and (s.get("realtime") or {}).get("peristiwa") in ev_ids]
            if not mine:
                continue
            if status == "false_positive" and any(s.get("agen") != AGENT for s in rec["sumber"]):
                kept += 1  # another source raised it too: the ledger's reviewers decide it
                continue
            rec["status"] = "dikonfirmasi" if status == "dikonfirmasi" else "ditolak"
            rec["keputusan"] = {"oleh": who, "pada": I._now(), "catatan": f"kasus realtime {case['id']}: {catatan}".strip()}
            rec["diperbarui_pada"] = I._now()
            changed.append(rec)
        if changed:
            I._save(changed, [(r["id"], {"agen": f"manusia:{who}", "keputusan": r["status"], "bukti": f"kasus realtime {case['id']}", "t": I._now()})
                              for r in changed])
    if changed:
        I._schedule_sync()
    return {"diputus": len(changed), "dibiarkan_sumber_lain": kept, "status_tag": "dikonfirmasi" if status == "dikonfirmasi" else "ditolak"}


def remove_tags() -> dict:
    """Reset of the stream: the realtime detector's sources leave the ledger (a tag only it raised, and no person
    decided, goes; others keep their other sources)."""
    from aip import indikasi as I

    gone, trimmed = [], []
    with I._lock:
        tags = I._all()
        for iid, rec in list(tags.items()):
            rest = [s for s in rec.get("sumber") or [] if s.get("agen") != AGENT]
            if len(rest) == len(rec.get("sumber") or []):
                continue
            if not rest and rec.get("status") == "terbuka":
                gone.append(iid)
                tags.pop(iid, None)
            else:
                rec["sumber"] = rest
                rec["dukungan_total"] = len({s["agen"] for s in rest})
                rec["diperbarui_pada"] = I._now()
                trimmed.append(rec)
        con = I._db()
        if gone:
            con.executemany("DELETE FROM tags WHERE id = ?", [(i,) for i in gone])
            con.commit()
        if trimmed:
            I._save(trimmed, [])
    if gone or trimmed:
        I._schedule_sync()
    return {"tag_dihapus": len(gone), "tag_dirapikan": len(trimmed)}


# ------------------------------------------------------------------------------------------------
# from the hospitals: the source registry, the ingest token, the submission contract
# ------------------------------------------------------------------------------------------------


def sources() -> dict[str, dict]:
    import json

    try:
        return json.loads((data_dir() / "sumber.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def put_source(sid: str, rec: dict) -> dict:
    from aip.runs import _write

    all_ = sources()
    all_[sid] = rec
    _write(data_dir() / "sumber.json", all_)
    return rec


def token_hash() -> Optional[str]:
    try:
        return (data_dir() / "ingest_token.sha256").read_text("utf-8").strip() or None
    except OSError:
        return None


def new_token() -> str:
    tok = "rtk_" + secrets.token_urlsafe(32)
    (data_dir() / "ingest_token.sha256").write_text(hashlib.sha256(tok.encode()).hexdigest(), "utf-8")
    return tok


def check_token(tok: Optional[str]) -> None:
    want = token_hash()
    if not want:
        raise HTTPException(503, "token ingest realtime belum dibuat (admin: POST /api/aip/realtime/v1/token)")
    if not tok or not secrets.compare_digest(hashlib.sha256(tok.encode()).hexdigest(), want):
        raise HTTPException(401, "token ingest tidak sah")


class BuktiPerangkat(BaseModel):
    """What a hospital's device evidence (the faskes ledger's IoMT bundle) supports, after the insurer verified it."""
    model_config = ConfigDict(extra="ignore")
    terverifikasi: bool = False
    mendukung: list[Literal["los", "keparahan"]] = []
    bundel_sha256: Optional[str] = Field(None, max_length=80)


class BarisObat(BaseModel):
    """One dispensing line: prescribed, billed and actually handed over (from the hospital's pharmacy system)."""
    model_config = ConfigDict(extra="ignore")
    kode: str = Field("", max_length=40)
    nama: str = Field("", max_length=200)
    diresepkan: float = Field(0, ge=0, le=100_000)
    ditagih: float = Field(0, ge=0, le=100_000)
    diserahkan: float = Field(0, ge=0, le=100_000)


class BarisPemeriksaan(BaseModel):
    """One examination result: the value written on the claim and the value the device or the LIS recorded."""
    model_config = ConfigDict(extra="ignore")
    parameter: str = Field(min_length=1, max_length=120)
    satuan: str = Field("", max_length=40)
    nilai_klaim: float
    nilai_alat: float
    toleransi: float = Field(0.15, gt=0, le=1)


class PencegahanFaskes(BaseModel):
    """What the hospital's own prevention layer decided before this claim was submitted (its declaration: recorded and
    shown to the auditor, never scored). Finding codes only, no detail of other patients."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    gerbang: Literal["fix", "hold", "check", "pass", "tidak-tersedia"] = "tidak-tersedia"
    keputusan: str = Field("", max_length=40)
    temuan_jaringan: list[str] = Field(default_factory=list, max_length=12)
    risiko_pct: Optional[float] = Field(None, ge=0, le=100)
    ditelaah_oleh: Optional[str] = Field(None, max_length=120)
    catatan: Optional[str] = Field(None, max_length=600)
    precheck: int = Field(0, ge=0, le=1000)


class FaskesKlaimIn(BaseModel):
    """A hospital system's claim submission (ai-jkn Kodifikasi "Submit klaim")."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    sumber: str = Field("ai-jkn", pattern=r"^[a-z0-9-]{2,40}$")
    klaim_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$")
    versi: int = Field(1, ge=1, le=10_000)
    nama_faskes: str = Field("", max_length=300)
    no_rm: str = Field("", max_length=64)
    no_sep: str = Field("", max_length=64)
    nama_pasien: str = Field("", max_length=200)
    jenis_episode: Literal["ri", "rj", "igd"]
    tanggal_masuk: date
    tanggal_pulang: Optional[date] = None
    diagnosis_utama: str = Field(min_length=3, max_length=16)
    diagnosis_sekunder: list[str] = Field(default_factory=list, max_length=60)
    tindakan: list[str] = Field(default_factory=list, max_length=80)
    inacbg_kode: Optional[str] = Field(None, max_length=20)
    tarif_inacbg_rp: Optional[int] = Field(None, ge=0, le=10_000_000_000)
    biaya_tagih_rp: int = Field(ge=0, le=10_000_000_000)
    kelas_rawat: Optional[int] = Field(None, ge=1, le=3)
    hak_kelas: Optional[int] = Field(None, ge=1, le=3)
    # what the hospital declares about itself: recorded, never used (the registry decides)
    kelas_rs: Optional[str] = Field(None, max_length=4)
    milik: Optional[str] = Field(None, max_length=4)
    regional: Optional[int] = Field(None, ge=1, le=5)
    bukti_perangkat: Optional[BuktiPerangkat] = None
    # dispensing and result lines (M17, M18, M20): optional, the sample holds none
    obat: list[BarisObat] = Field(default_factory=list, max_length=200)
    pemeriksaan: list[BarisPemeriksaan] = Field(default_factory=list, max_length=200)
    # the hospital's own prevention layer (ai-jkn gate): a declaration, shown to the auditor, not scored
    pencegahan_faskes: Optional[PencegahanFaskes] = None
    # the electronic medical record of this episode: one FHIR R4 Bundle of SATUSEHAT ID Core resources (rme.py, contract
    # docs/RME_SATUSEHAT_KONTRAK.md). Optional: a hospital not yet connected sends none and nothing is raised for it
    rekam_medis: Optional[dict] = None
    # device duration billed (the E-Klaim fields): ICU days, ventilator hours, dialysis sessions; read by the medical-record and
    # the device checks
    lama_icu_hari: Optional[int] = Field(None, ge=0, le=400)
    jam_ventilator: Optional[float] = Field(None, ge=0, le=10_000)
    sesi_hemodialisis: Optional[int] = Field(None, ge=0, le=400)
    # when the claim was first submitted in the hospital's system (the late-anchor check); else the receipt time
    diajukan_pada: Optional[datetime] = None
    # the device evidence of this episode (iot.py, contract docs/IOT_KONTRAK.md): {sesi, jangkar, alat}. Optional: a hospital
    # not covered by the IoT programme sends none and nothing is raised for it
    iot: Optional[dict] = None


def map_faskes(s: FaskesKlaimIn, resolver: Any, code_ref: dict[str, dict], tarif_ref: Optional[dict[str, int]] = None) -> tuple[Any, dict]:
    """The submission → (KlaimIn, meta) or HTTPException(422) with the reason the hospital can act on. A submission
    without its tariff gets the insurer's reference tariff of the code (the median of its claims), marked as such."""
    from aip import layanan as L

    src = sources().get(s.sumber)
    if not src:
        raise HTTPException(422, f"sumber '{s.sumber}' belum terdaftar di registri faskes sistem audit")
    dx = re.sub(r"[^A-Z0-9]", "", s.diagnosis_utama.upper())
    if not re.match(r"^[A-Z][0-9]{2}", dx):
        raise HTTPException(422, f"diagnosis utama '{s.diagnosis_utama}' bukan kode ICD-10")
    code = (s.inacbg_kode or "").strip().upper()
    if not re.match(r"^[A-Z]-[0-9]-[0-9]{2}-[0IV]+$", code):
        raise HTTPException(422, "kode INA-CBG belum ada atau bukan format grouper (mis. J-4-16-I): klaim dicatat, belum dapat dinilai")
    ent = resolver.resolve(s.sumber, s.no_rm, s.nama_pasien, s.no_sep)
    ritl = s.jenis_episode == "ri"
    pulang = s.tanggal_pulang if (s.tanggal_pulang and s.tanggal_pulang >= s.tanggal_masuk) else None
    los = (pulang - s.tanggal_masuk).days if (ritl and pulang) else (0 if not ritl else None)
    ref = code_ref.get(code) or {}
    tarif = s.tarif_inacbg_rp
    tarif_dari_ref = tarif is None and code in (tarif_ref or {})
    if tarif_dari_ref:
        tarif = tarif_ref[code]
    body = {"kunjungan_fkrtl_id": f"{s.sumber}.{s.klaim_id}", "edisi": "faskes", "peserta_id": ent["peserta_id"], "tgl_datang": s.tanggal_masuk,
            "tgl_pulang": pulang, "kabkota_fkrtl_kode": src["kabkota_fkrtl_kode"], "kepemilikan_fkrtl": src["kepemilikan_fkrtl"],
            "jenis_fkrtl": src["jenis_fkrtl"], "tipe_fkrtl": src.get("tipe_fkrtl"), "tingkat_pelayanan": "RITL" if ritl else "RJTL",
            "poli": "IGD" if s.jenis_episode == "igd" else None, "kelas_rawat": f"Kelas {s.kelas_rawat}" if s.kelas_rawat else None,
            "dx_primer_icd3": dx[:3], "dx_primer_kode": dx[:5], "inacbg_kode": code, "inacbg_cmg": ref.get("inacbg_cmg"),
            "inacbg_tipe_kasus": ref.get("inacbg_tipe_kasus"), "inacbg_keparahan": ref.get("inacbg_keparahan"), "inacbg_deskripsi": ref.get("inacbg_deskripsi"),
            "regional_tarif": src.get("regional_tarif"), "prosedur": ";".join(s.tindakan)[:8000] or None, "tarif_inacbg_rp": tarif,
            "biaya_tagih_rp": s.biaya_tagih_rp, "los_hari": los, "jumlah_dx_sekunder": len(s.diagnosis_sekunder),
            "kabkota_fkrtl": src.get("kabkota_fkrtl"), "provinsi_fkrtl": src.get("provinsi_fkrtl")}
    try:
        k = L.KlaimIn.model_validate(body)
    except Exception as e:  # noqa: BLE001 - the hospital sees which field
        raise HTTPException(422, f"klaim tidak lolos kontrak: {str(e)[:300]}") from e
    iomt = {}
    if s.bukti_perangkat and s.bukti_perangkat.terverifikasi:
        iomt = {m: True for m in s.bukti_perangkat.mendukung}
    meta = {"faskes_nama": s.nama_faskes or src.get("nama"), "entitas": ent, "iomt": iomt, "tarif_dari_referensi": tarif_dari_ref,
            "deklarasi_faskes": {"kelas_rs": s.kelas_rs, "milik": s.milik, "regional": s.regional}, "hak_kelas": s.hak_kelas,
            "obat": [o.model_dump() for o in s.obat], "pemeriksaan": [p.model_dump() for p in s.pemeriksaan],
            # the codes the claim contract keeps only as a count and a text: the medical-record cross-check needs them
            "klaim_kode": {"dx_utama": s.diagnosis_utama, "dx_sekunder": list(s.diagnosis_sekunder), "tindakan": list(s.tindakan),
                           "lama_icu_hari": s.lama_icu_hari, "jam_ventilator": s.jam_ventilator, "sesi_hemodialisis": s.sesi_hemodialisis}}
    if s.iot is not None:
        from aip.realtime import iot as IOT

        sesi = s.iot.get("sesi") if isinstance(s.iot, dict) else None
        if isinstance(sesi, list) and len(sesi) > IOT.MAKS_SESI:
            raise HTTPException(422, f"iot.sesi memuat {len(sesi)} sesi, batasnya {IOT.MAKS_SESI} per klaim")
        meta["iot"] = s.iot if isinstance(s.iot, dict) else {}
        meta["iot_validasi"] = IOT.validasi(s.iot)
        # the hospital binds a session to its own visit id (klaim_id or the SEP number) and its own patient id (no_rm)
        meta["iot_kunjungan"] = s.klaim_id
        meta["iot_peserta"] = s.no_rm or None
        meta["iot_sep"] = s.no_sep or None
    meta["diajukan_pada"] = (s.diajukan_pada or datetime.now().astimezone()).isoformat()
    if s.rekam_medis is not None:
        from aip.realtime import rme as RME

        meta["rme"] = RME.baca(s.rekam_medis)
    from aip.realtime import precheck as PC

    meta["lapis_faskes"] = {"sumber": s.sumber, "kunci_draf": PC.draft_key(s.sumber, s.no_rm, s.tanggal_masuk, s.klaim_id),
                            "pencegahan": s.pencegahan_faskes.model_dump() if s.pencegahan_faskes else None}
    return k, meta
