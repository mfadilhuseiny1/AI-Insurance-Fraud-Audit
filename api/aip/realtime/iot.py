"""Verifikasi IoT: the claim against the hospital's device evidence (bukti perangkat). A current-clamp sensor on each device's power
cable (the device is never opened) records when the device ran, for how long and in which state, read from its current draw. No
vital signs: on-time, duration and state only.

  devices    ventilator      jalan (giving breaths) / siaga (standby) / mati
             hemodialisis    jalan / idle / mati
             icu             (ICU bed / monitor) nyala / mati
             infus           (infusion pump) jalan / idle / mati
             A clamp cannot tell a tube from a mask: it knows whether the ventilator runs, idles or is off. Contract iot-1 values
             invasif / non_invasif (and NIV, CPAP, BiPAP ...) are read as jalan, standby as siaga. The ventilation type is read
             only when the ventilator itself reports it (session `sumber_mode: "ventilator"`, its own data port, not the clamp).
  contract   docs/IOT_KONTRAK.md. Per claim: the device sessions bound device <-> patient <-> visit (sesi_id, device_id, peserta,
             kunjungan, mulai, selesai, mode, jam), the anchors (Merkle root of the sessions, anchor time) and the device registry
             (coverage of the hospital, each device's kind and signing-key status, gateway offline windows).
  rules      periksa_iot(): pure, no I/O, no engine state. Every finding is a signal of the engine (modus.SIGNALS, IOT_*) with its
             evidence in plain words and numbers, plus one row per checked item for the auditor's table (white box):
               IOT_VENTILASI_KURANG_96   96.72 (>= 96 consecutive hours) billed, the longest uninterrupted run < 96 h  (M04, M14)
               IOT_VENTILATOR_STANDBY    ventilation billed, the ventilator was only on standby (siaga), never ran     (M14)
               IOT_MODE_NONINVASIF       invasive ventilation billed, the VENTILATOR ITSELF reported non-invasive only (M04)
                                         (sumber_mode "ventilator"; never from clamp data)
               IOT_HD_SESI_SINGKAT       a dialysis session billed as full ran < 3 h                                   (M14)
               IOT_HD_TANPA_SESI         more dialysis sessions billed than the machines ran                           (M14, M06)
               IOT_HARI_ICU_LEBIH        ICU days billed > days the ICU bed/monitor was on                             (M12, M13)
               IOT_TANPA_JEJAK           device use billed, no session of that device at a covered hospital            (M14, M06)
               IOT_BINDING_TUMPANG       one device bound to two patients at overlapping times                         (M06)
               IOT_TANPA_PASIEN          devices running with no patient bound (facility context, not the claim)       (-)
               IOT_JANGKAR_TIDAK_COCOK   the sessions do not hash to the anchored Merkle root                          (M20)
               IOT_JANGKAR_TERLAMBAT     the evidence was anchored after the claim was submitted                       (M20)
               IOT_KUNCI_DICABUT         the device's signing key was revoked before the session ended                 (M20)
  proof vs review
             BUKTI (proof)  a measured duration or a hash: IOT_VENTILASI_KURANG_96 (when even the powered run is < 96 h),
                            IOT_HD_SESI_SINGKAT, IOT_HARI_ICU_LEBIH, IOT_JANGKAR_TIDAK_COCOK
             TELAAH (review) a state read from the current pattern, a device-reported mode, or an absence: IOT_VENTILATOR_STANDBY,
                            IOT_MODE_NONINVASIF, IOT_HD_TANPA_SESI, IOT_TANPA_JEJAK, IOT_BINDING_TUMPANG, IOT_TANPA_PASIEN,
                            IOT_JANGKAR_TERLAMBAT, IOT_KUNCI_DICABUT (and IOT_VENTILASI_KURANG_96 when the ventilator was powered
                            >= 96 h without a break and only the part read as "jalan" is short)
  mitigation a hospital not covered by the programme, a device kind it does not instrument, or no device evidence at all
             raises nothing; a gateway offline window that could hide the missing time turns a finding into "perlu klarifikasi"
             (mitigation factor), never a fraud finding by itself.

The signals are NOT model features (aktif.CODES is frozen at the 45 pre-RME signals): they enter the rule score, the
explanation and the case. ATURAN_ID maps each code to the rule id of the offline checker (testing/iot_cabang.py).
"""

from __future__ import annotations

import hashlib
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Optional

VERSI = "iot-2"  # iot-1: ventilator modes invasif / non_invasif / standby (still accepted, read as jalan / siaga)
JAM_96 = 96.0  # ICD-9-CM 96.72: continuous invasive mechanical ventilation for 96 consecutive hours or more
JAM_HD_PENUH = 3.0  # a billed haemodialysis session shorter than this is not a full session
CELAH_MENIT = {"ventilator": 60, "hemodialisis": 30, "icu": 120, "infus": 60}  # gaps inside one run (alarm, circuit change)
TUMPANG_MENIT = 15  # an overlap shorter than this is a hand-over between patients, not two patients at once
TANPA_PASIEN_JAM = 6.0  # unbound running time in the visit window before it is reported
ZONA_BAWAAN = timezone(timedelta(hours=7))  # WIB, for timestamps sent without an offset
MAKS_SESI = 5000
JENIS = ("ventilator", "hemodialisis", "icu", "infus")
NAMA_JENIS = {"ventilator": "ventilator", "hemodialisis": "mesin hemodialisis", "icu": "bed/monitor ICU", "infus": "pompa infus"}
MODE = {"ventilator": ("jalan", "siaga", "mati"), "hemodialisis": ("jalan", "idle", "mati"), "icu": ("nyala", "mati"), "infus": ("jalan", "idle", "mati")}
NAMA_MODE = {"jalan": "jalan", "siaga": "siaga", "mati": "mati", "idle": "idle (diam)", "nyala": "menyala"}
_SINONIM_JENIS = {"ventilator": "ventilator", "vent": "ventilator", "hd": "hemodialisis", "hemodialisis": "hemodialisis", "dialisis": "hemodialisis",
                  "dialysis": "hemodialisis", "hemodialysis": "hemodialisis", "mesin_hd": "hemodialisis", "icu": "icu", "bed_icu": "icu", "icu_bed": "icu",
                  "monitor": "icu", "monitor_icu": "icu", "bedside_monitor": "icu", "infus": "infus", "pompa_infus": "infus", "infusion_pump": "infus",
                  "syringe_pump": "infus"}
# a ventilation type (contract iot-1 sent it as the mode): a clamp cannot tell it, so as a mode it reads as "jalan" (running); it is
# kept as the ventilation type only when the ventilator itself reported it (sumber_mode "ventilator")
_TIPE_VENTILASI = {"invasif": "invasif", "invasive": "invasif", "imv": "invasif", "ivm": "invasif", "non_invasif": "non_invasif", "noninvasif": "non_invasif",
                   "non_invasive": "non_invasif", "noninvasive": "non_invasif", "niv": "non_invasif", "cpap": "non_invasif", "bipap": "non_invasif"}
_SINONIM_MODE = {**{k: "jalan" for k in _TIPE_VENTILASI},
                 "jalan": "jalan", "running": "jalan", "aktif": "jalan", "berjalan": "jalan", "standby": "siaga", "siaga": "siaga",
                 "idle": "idle", "diam": "idle", "nyala": "nyala", "on": "nyala", "menyala": "nyala", "mati": "mati", "off": "mati"}
_MODE_PER_JENIS = {"ventilator": {"idle": "siaga"}, "hemodialisis": {"siaga": "idle"}, "infus": {"siaga": "idle"}}  # the same state, the kind's word
_SUMBER_ALAT = ("ventilator", "alat", "device")  # sumber_mode values meaning "reported by the device itself, not the clamp"
# signal -> the offline checker's rule id (testing/iot_cabang.py). No counterpart there: unbound_readings and key_revoked (alerts
# there), and niv_as_invasive (fires only on a device-reported mode; the checker reads clamp data)
ATURAN_ID = {"IOT_VENTILASI_KURANG_96": "vent_run_96", "IOT_MODE_NONINVASIF": "niv_as_invasive", "IOT_VENTILATOR_STANDBY": "vent_standby",
             "IOT_HD_SESI_SINGKAT": "hd_short", "IOT_HD_TANPA_SESI": "hd_phantom", "IOT_HARI_ICU_LEBIH": "icu_days", "IOT_TANPA_JEJAK": "no_device_trace",
             "IOT_BINDING_TUMPANG": "binding_tumpang", "IOT_JANGKAR_TIDAK_COCOK": "anchor_mismatch", "IOT_JANGKAR_TERLAMBAT": "late_anchor",
             "IOT_TANPA_PASIEN": "unbound_readings", "IOT_KUNCI_DICABUT": "key_revoked"}
KODE_DARI_ATURAN = {v: k for k, v in ATURAN_ID.items()}
# proof (a measured duration or a hash) or review (a state read from the current pattern, a device-reported mode, or an absence)
JENIS_BUKTI = {"IOT_VENTILASI_KURANG_96": "bukti", "IOT_MODE_NONINVASIF": "telaah", "IOT_VENTILATOR_STANDBY": "telaah", "IOT_HD_SESI_SINGKAT": "bukti",
               "IOT_HD_TANPA_SESI": "telaah", "IOT_HARI_ICU_LEBIH": "bukti", "IOT_TANPA_JEJAK": "telaah", "IOT_BINDING_TUMPANG": "telaah",
               "IOT_TANPA_PASIEN": "telaah", "IOT_JANGKAR_TIDAK_COCOK": "bukti", "IOT_JANGKAR_TERLAMBAT": "telaah", "IOT_KUNCI_DICABUT": "telaah"}
VENT_KODE = ("9670", "9671", "9672")  # ICD-9-CM 96.7x mechanical ventilation (billed codes; the clamp only says whether the ventilator ran)
HD_KODE = ("3995",)


# =====================================================================================================================
# small helpers
# =====================================================================================================================
def icd9(s: Any) -> Optional[str]:
    """'96.72', '9672', '96.72 - Continuous invasive ...' -> '9672' (the same parser as rme.icd9)."""
    m = re.match(r"^\s*(\d{2})(?:\.?(\d{1,2}))?(?=\D|$)", str(s or ""))
    return (m.group(1) + (m.group(2) or "")) if m else None


def waktu(v: Any, zona: timezone = ZONA_BAWAAN) -> Optional[datetime]:
    """An ISO 8601 timestamp -> an aware datetime (a timestamp without an offset is read in `zona`, WIB by default)."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        d = v
    elif isinstance(v, date):
        d = datetime(v.year, v.month, v.day)
    else:
        try:
            d = datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=zona)


def tanggal(v: Any) -> Optional[date]:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _angka(v: float, nd: int = 1) -> str:
    s = f"{v:.{nd}f}".rstrip("0").rstrip(".") if nd else f"{v:.0f}"
    return s.replace(".", ",")


def _jam(v: float) -> str:
    return f"{_angka(v, 1)} jam"


def _wkt(d: Optional[datetime]) -> str:
    return d.strftime("%Y-%m-%d %H:%M") if d else "?"


def _pilih(d: dict, *keys: str) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return None


def _sig(kode: str, s: float, f: str, bukti: str, mitigasi: Optional[list] = None, ukur: Optional[dict] = None, fokus: Optional[tuple] = None) -> dict:
    """The engine's signal shape (graf.sig), with the rule id, proof/review and the measured numbers beside it."""
    return {"kode": kode, "label": "", "tag": None, "s": round(max(0.0, min(1.0, s)), 3), "w": 0, "fokus": list(fokus or ("faskes", f)),
            "bukti": bukti[:900], "terkait": [], "mitigasi": mitigasi or [], "aturan": ATURAN_ID.get(kode), "jenis_bukti": JENIS_BUKTI.get(kode),
            "ukur": ukur or {}}


def _mit(kode: str, label: str, faktor: float) -> dict:
    return {"kode": kode, "label": label, "faktor": faktor}


# =====================================================================================================================
# input
# =====================================================================================================================
def klaim_umum(k: dict) -> dict:
    """The claim fields the IoT rules read, from any of the accepted shapes (the realtime contract, the hospital submission,
    plain English)."""
    tind = _pilih(k, "tindakan", "prosedur", "procedures") or []
    if isinstance(tind, str):
        tind = [x.strip() for x in tind.replace("|", ";").split(";") if x.strip() and x.strip() != "None"]
    tind = [str(_pilih(x, "kode", "code") or "") if isinstance(x, dict) else str(x) for x in tind]
    ting = _pilih(k, "tingkat", "tingkat_pelayanan")
    if not ting and _pilih(k, "jenis_episode"):
        ting = "RITL" if k["jenis_episode"] == "ri" else "RJTL"
    return {"id": str(_pilih(k, "id", "klaim_id", "kunjungan_fkrtl_id", "claim_id") or ""),
            "kunjungan": str(_pilih(k, "kunjungan", "kunjungan_id", "kunjungan_fkrtl_id", "klaim_id", "id") or ""),
            "peserta": str(_pilih(k, "peserta", "peserta_id", "member_id") or ""),
            "tgl_masuk": tanggal(_pilih(k, "tgl_masuk", "tgl_datang", "tanggal_masuk", "admission_date")),
            "tgl_pulang": tanggal(_pilih(k, "tgl_pulang", "tanggal_pulang", "discharge_date")),
            "tingkat": ting, "inacbg_kode": _pilih(k, "inacbg_kode", "inacbg"), "inacbg_deskripsi": str(_pilih(k, "inacbg_deskripsi") or ""),
            "tindakan": tind,
            "hari_icu": _pilih(k, "hari_icu", "lama_icu_hari", "icu_los", "icu_hari"),
            "jam_ventilator": _pilih(k, "jam_ventilator", "ventilator_hour", "ventilator_jam"),
            "sesi_hd": _pilih(k, "sesi_hd", "sesi_hemodialisis", "dialysis_sessions"),
            "diajukan": waktu(_pilih(k, "diajukan", "diajukan_pada", "tgl_pengajuan", "submitted_at"))}


def _jenis(s: dict, alat: Optional[dict]) -> Optional[str]:
    j = str(s.get("jenis") or s.get("jenis_alat") or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not j and alat:
        j = str(((_perangkat(alat).get(str(s.get("device_id") or ""))) or {}).get("jenis") or "").strip().lower().replace("-", "_").replace(" ", "_")
    return _SINONIM_JENIS.get(j)


def _perangkat(alat: Optional[dict]) -> dict:
    p = (alat or {}).get("perangkat") or {}
    if isinstance(p, list):
        return {str(x.get("device_id")): x for x in p if isinstance(x, dict) and x.get("device_id")}
    return {str(k): v for k, v in p.items() if isinstance(v, dict)} if isinstance(p, dict) else {}


def baca_sesi(sesi: Iterable[dict], alat: Optional[dict] = None) -> tuple[list[dict], list[str]]:
    """The sessions, normalised: kind and mode from their synonyms (a ventilator's iot-1 invasif / non_invasif -> jalan, standby ->
    siaga), times as aware datetimes, hours from the times (the `jam` a gateway sent is kept to compare). A ventilator session whose
    mode the ventilator itself reported (`sumber_mode: "ventilator"`) keeps its ventilation type (`mode_ventilasi`, else the iot-1
    mode value) as `ventilasi`; clamp data never has one. Returns (sessions, problems); an unusable session is left out with its
    reason."""
    out, masalah = [], []
    for i, s in enumerate(list(sesi or [])[:MAKS_SESI]):
        if not isinstance(s, dict):
            masalah.append(f"sesi ke-{i + 1} bukan objek")
            continue
        sid = str(s.get("sesi_id") or f"sesi-{i + 1}")
        j = _jenis(s, alat)
        if not j:
            masalah.append(f"sesi {sid}: jenis alat tidak dikenal ('{s.get('jenis') or ''}')")
            continue
        asli = str(s.get("mode") or "").strip().lower().replace("-", "_").replace(" ", "_")
        mode = _SINONIM_MODE.get(asli)
        mode = _MODE_PER_JENIS.get(j, {}).get(mode, mode)
        if mode not in MODE[j]:
            masalah.append(f"sesi {sid}: mode '{s.get('mode')}' bukan mode {NAMA_JENIS[j]} ({', '.join(MODE[j])})")
            continue
        a = waktu(s.get("mulai"))
        b = waktu(s.get("selesai"))
        jam_kirim = s.get("jam")
        try:
            jam_kirim = float(jam_kirim) if jam_kirim is not None else None
        except (TypeError, ValueError):
            jam_kirim = None
        if a and not b and jam_kirim is not None:
            b = a + timedelta(hours=jam_kirim)
        if not a or not b or b < a:
            masalah.append(f"sesi {sid}: waktu mulai/selesai tidak terbaca atau terbalik")
            continue
        jam = (b - a).total_seconds() / 3600
        if jam_kirim is not None and abs(jam_kirim - jam) > 0.25:
            masalah.append(f"sesi {sid}: jam {jam_kirim:g} berbeda dari selisih waktu {jam:.2f} jam (dipakai selisih waktu)")
        ventilasi = None
        if j == "ventilator" and mode == "jalan" and str(s.get("sumber_mode") or "").strip().lower() in _SUMBER_ALAT:
            ventilasi = _TIPE_VENTILASI.get(str(s.get("mode_ventilasi") or asli).strip().lower().replace("-", "_").replace(" ", "_"))
        out.append({"sesi_id": sid, "device_id": str(s.get("device_id") or ""), "jenis": j, "mode": mode, "mode_asli": asli, "ventilasi": ventilasi,
                    "peserta": str(s.get("peserta") or "").strip(), "kunjungan": str(s.get("kunjungan") or "").strip(),
                    "mulai": a, "selesai": b, "jam": jam, "konteks": bool(s.get("_konteks")), "asli": s})
    return out, masalah


# =====================================================================================================================
# anchors: the Merkle root of the sessions (a hospital gateway anchors what it later sends)
# =====================================================================================================================
_DAUN = ("sesi_id", "device_id", "peserta", "kunjungan", "mulai", "selesai", "mode", "jam")


def hash_daun(s: dict) -> str:
    """One session's leaf: SHA-256 of its eight fields as sent, joined by '|' (jam with three decimals). The gateway hashes
    the same string before anchoring; any change to a session after that changes the leaf."""
    jam = s.get("jam")
    try:
        jam_t = f"{float(jam):.3f}" if jam is not None and jam != "" else ""
    except (TypeError, ValueError):
        jam_t = str(jam)
    teks = "|".join([*(str(s.get(k) if s.get(k) is not None else "") for k in _DAUN[:-1]), jam_t])
    return hashlib.sha256(teks.encode("utf-8")).hexdigest()


def akar_merkle(daun: list[str]) -> Optional[str]:
    """The Merkle root of leaf hashes (hex), in the given order: pairs hashed as SHA-256(left || right) over the raw digests,
    an odd last node paired with itself. None for no leaves."""
    if not daun:
        return None
    lv = [bytes.fromhex(h) for h in daun]
    while len(lv) > 1:
        if len(lv) % 2:
            lv.append(lv[-1])
        lv = [hashlib.sha256(lv[i] + lv[i + 1]).digest() for i in range(0, len(lv), 2)]
    return lv[0].hex()


def akar_sesi(sesi: list[dict]) -> Optional[str]:
    """The root over sessions as sent (raw dicts), ordered by sesi_id: what a gateway anchors for a claim's sessions."""
    return akar_merkle([hash_daun(s) for s in sorted(sesi, key=lambda x: str(x.get("sesi_id") or ""))])


def bukti_inklusi(sesi: list[dict], sesi_id: str) -> list[dict]:
    """The inclusion proof of one session in akar_sesi(sesi): [{"posisi": "kiri"|"kanan", "hash": hex}, ...] from the leaf up."""
    urut = sorted(sesi, key=lambda x: str(x.get("sesi_id") or ""))
    lv = [hash_daun(s) for s in urut]
    idx = next((i for i, s in enumerate(urut) if str(s.get("sesi_id")) == str(sesi_id)), None)
    if idx is None:
        return []
    out = []
    while len(lv) > 1:
        if len(lv) % 2:
            lv.append(lv[-1])
        j = idx ^ 1
        out.append({"posisi": "kiri" if j < idx else "kanan", "hash": lv[j]})
        lv = [hashlib.sha256(bytes.fromhex(lv[i]) + bytes.fromhex(lv[i + 1])).hexdigest() for i in range(0, len(lv), 2)]
        idx //= 2
    return out


def cek_inklusi(daun: str, jalur: list[dict]) -> str:
    """The root a leaf and its inclusion proof lead to."""
    h = bytes.fromhex(daun)
    for p in jalur or []:
        x = bytes.fromhex(str(p.get("hash") or ""))
        h = hashlib.sha256(x + h if str(p.get("posisi")) == "kiri" else h + x).digest()
    return h.hex()


# =====================================================================================================================
# runs
# =====================================================================================================================
def _gabung(xs: list[dict], celah_menit: float, offline: Optional[list[tuple]] = None) -> list[dict]:
    """Sessions merged into runs: consecutive sessions whose gap is <= celah_menit (or, with `offline`, whose gap lies inside a
    gateway offline window: the time the sensor could not report). Each run: mulai, selesai, jam, sesi (ids)."""
    runs: list[dict] = []
    for s in sorted(xs, key=lambda x: x["mulai"]):
        if runs:
            r = runs[-1]
            gap = (s["mulai"] - r["selesai"]).total_seconds() / 60
            tertutup = offline and gap > 0 and any(a <= r["selesai"] and s["mulai"] <= b for a, b in offline)
            if gap <= celah_menit or tertutup:
                r["selesai"] = max(r["selesai"], s["selesai"])
                r["sesi"].append(s["sesi_id"])
                r["devices"].add(s["device_id"])
                continue
        runs.append({"mulai": s["mulai"], "selesai": s["selesai"], "sesi": [s["sesi_id"]], "devices": {s["device_id"]}})
    for r in runs:
        r["jam"] = (r["selesai"] - r["mulai"]).total_seconds() / 3600
    return runs


def _terpanjang(runs: list[dict]) -> Optional[dict]:
    return max(runs, key=lambda r: r["jam"]) if runs else None


def _jam_total(xs: list[dict]) -> float:
    """Total hours covered by sessions (overlaps counted once)."""
    tot, akhir = 0.0, None
    for s in sorted(xs, key=lambda x: x["mulai"]):
        a = s["mulai"] if akhir is None else max(s["mulai"], akhir)
        if s["selesai"] > a:
            tot += (s["selesai"] - a).total_seconds() / 3600
        akhir = s["selesai"] if akhir is None else max(akhir, s["selesai"])
    return tot


def _hari_nyala(xs: list[dict], min_jam: float = 1.0) -> tuple[int, int, float]:
    """(calendar days with >= min_jam of on-time, ceil(total on-hours / 24), total on-hours) — the ICU-day count is the more
    generous of the two, so a stay crossing midnight is never under-counted."""
    per_hari: dict[date, float] = {}
    for s in xs:
        a, b = s["mulai"], s["selesai"]
        while a < b:
            akhir_hari = datetime.combine(a.date() + timedelta(days=1), datetime.min.time(), tzinfo=a.tzinfo)
            c = min(b, akhir_hari)
            per_hari[a.date()] = per_hari.get(a.date(), 0.0) + (c - a).total_seconds() / 3600
            a = c
    tot = _jam_total(xs)
    hari = sum(1 for v in per_hari.values() if v >= min_jam)
    return hari, int(-(-round(tot, 6) // 24)) if tot > 0 else 0, tot


def _offline(alat: Optional[dict]) -> list[tuple[datetime, datetime]]:
    al = alat or {}
    xs = al.get("gateway_offline") or ((al.get("gateway") or {}).get("offline") if isinstance(al.get("gateway"), dict) else None) or []
    out = []
    for x in xs if isinstance(xs, list) else []:
        if isinstance(x, dict):
            a, b = waktu(x.get("mulai")), waktu(x.get("selesai"))
            if a and b and b > a:
                out.append((a, b))
    return out


def _offline_dalam(off: list[tuple], a: datetime, b: datetime) -> float:
    """Hours of gateway offline time inside [a, b]."""
    return sum(max(0.0, (min(y, b) - max(x, a)).total_seconds() / 3600) for x, y in off)


# =====================================================================================================================
# the rules
# =====================================================================================================================
def periksa_iot(klaim: dict, sesi: Optional[list[dict]], jangkar: Optional[dict | list] = None, alat: Optional[dict] = None, f: str = "") -> dict:
    """The claim against its device evidence. Pure: the same inputs give the same result, nothing is read or written.

    klaim    the claim (klaim_umum shapes): kunjungan/id, peserta, tgl_masuk/tgl_datang, tgl_pulang, tindakan (ICD-9-CM, e.g.
             96.70/96.71/96.72, 39.95), inacbg_kode, hari_icu, jam_ventilator, sesi_hd, diajukan (submission time)
    sesi     device sessions: sesi_id, device_id, jenis, peserta, kunjungan, mulai, selesai, mode, jam (and, for a ventilator that
             reports its own mode, sumber_mode "ventilator" + mode_ventilasi). Sessions of other
             patients on the same devices may be included (the binding check reads them); `_konteks: true` marks sessions the
             caller knows from other claims (never counted as this claim's)
    jangkar  one anchor or a list: {akar, waktu, sesi_ids?, bukti?: {sesi_id: [{posisi, hash}]}}
    alat     the registry: {tercakup, cakupan: [kinds], perangkat: {device_id: {jenis, kunci: aktif|dicabut, dicabut_pada}},
             gateway_offline: [{mulai, selesai}]}
    Returns {versi, dicek, sinyal, hasil (auditor table), ukur (measured numbers), nilai, aturan (rule id -> fired), masalah}."""
    k = klaim_umum(klaim or {})
    rows: list[dict] = []
    sigs: list[dict] = []
    ukur: dict[str, Any] = {}

    def row(aspek: str, klaim_: str, iot_: str, status: str, catatan: str = "") -> None:
        rows.append({"aspek": aspek, "klaim": klaim_, "iot": iot_, "status": status, "catatan": catatan})

    semua, masalah = baca_sesi(sesi or [], alat)
    al = alat or {}
    tercakup = bool(al.get("tercakup")) if al else False
    cakupan = {_SINONIM_JENIS.get(str(x).lower(), str(x).lower()) for x in (al.get("cakupan") or JENIS)} if tercakup else set()
    off = _offline(al)
    d0, d1 = k["tgl_masuk"], k["tgl_pulang"] or k["tgl_masuk"]
    zona = next((s["mulai"].tzinfo for s in semua), ZONA_BAWAAN)
    win_a = datetime.combine(d0, datetime.min.time(), tzinfo=zona) - timedelta(hours=12) if d0 else None
    win_b = datetime.combine(d1, datetime.max.time(), tzinfo=zona) + timedelta(hours=12) if d1 else None

    def dalam_jendela(s: dict) -> bool:
        return win_a is None or (s["mulai"] <= win_b and s["selesai"] >= win_a)

    def milik(s: dict) -> bool:
        if s["konteks"]:
            return False
        if s["kunjungan"] and k["kunjungan"] and s["kunjungan"] in (k["kunjungan"], k["id"]):
            return True
        return bool(not s["kunjungan"] and s["peserta"] and s["peserta"] == k["peserta"] and dalam_jendela(s))

    mine = [s for s in semua if milik(s)]
    by = {j: [s for s in mine if s["jenis"] == j] for j in JENIS}
    off_win = _offline_dalam(off, win_a, win_b) if (off and win_a) else 0.0
    mit_off = [_mit("GATEWAY_OFFLINE", f"gateway alat offline {_jam(off_win)} dalam masa rawat: data bisa belum lengkap, perlu klarifikasi", 0.6)] if off_win >= 1 else []
    # what the claim bills
    kode = [c for c in (icd9(x) for x in k["tindakan"]) if c]
    vent_kode = sorted({c for c in kode if c in VENT_KODE})
    try:
        jam_vent_tagih = float(k["jam_ventilator"]) if k["jam_ventilator"] is not None else None
    except (TypeError, ValueError):
        jam_vent_tagih = None
    desk = k["inacbg_deskripsi"].upper()
    perlu_96 = "9672" in vent_kode or (jam_vent_tagih is not None and jam_vent_tagih >= JAM_96) or bool("VENTIL" in desk and re.search(r"[>≥]\s*=?\s*96", desk))
    vent_tagih = bool(vent_kode) or bool(jam_vent_tagih) or bool(perlu_96)
    try:
        hd_tagih = int(k["sesi_hd"]) if k["sesi_hd"] is not None else sum(1 for c in kode if c in HD_KODE)
    except (TypeError, ValueError):
        hd_tagih = sum(1 for c in kode if c in HD_KODE)
    try:
        icu_tagih = int(float(k["hari_icu"])) if k["hari_icu"] is not None else 0
    except (TypeError, ValueError):
        icu_tagih = 0
    ditagih = {"ventilator": vent_tagih, "hemodialisis": hd_tagih > 0, "icu": icu_tagih > 0}
    vent_label = ("ventilasi mekanik " + "/".join(f"{c[:2]}.{c[2:]}" for c in vent_kode)) if vent_kode else "ventilasi mekanik"
    dicek = bool(semua) or tercakup
    if not dicek:
        row("Bukti perangkat", "klaim ini", "tidak ada data sesi alat dan faskes belum tercakup program IoT", "tidak_dicek")
    # ---- coverage and absence (IOT_TANPA_JEJAK) --------------------------------------------------------------------------
    hilang = [j for j, v in ditagih.items() if v and not by[j] and j in cakupan and not (j == "hemodialisis" and mine)]
    for j, v in ditagih.items():
        if v and not by[j] and j not in cakupan:
            row(f"Jejak {NAMA_JENIS[j]}", "ditagih", "alat jenis ini belum tercakup program IoT di faskes ini", "tidak_dicek",
                "celah cakupan: tidak menjadi temuan")
    if hilang:
        bagian = []
        for j in hilang:
            if j == "ventilator":
                bagian.append(f"{vent_label}" + (f" {_angka(jam_vent_tagih, 0)} jam" if jam_vent_tagih else ""))
            elif j == "hemodialisis":
                bagian.append(f"{hd_tagih} sesi hemodialisis")
            else:
                bagian.append(f"{icu_tagih} hari ICU")
        teks = (f"Klaim menagih {', '.join(bagian)} ({d0} s.d. {d1}), tetapi tidak ada satu pun sesi "
                f"{'/'.join(NAMA_JENIS[j] for j in hilang)} yang terikat ke pasien atau kunjungan ini, padahal alat jenis itu di faskes ini "
                "terpasang sensor clamp pada kabel daya.")
        sigs.append(_sig("IOT_TANPA_JEJAK", 1.0, f, teks, list(mit_off), {"jenis_ditagih": hilang, "sesi_terikat": len(mine), "jam_offline": round(off_win, 2)}))
        for j in hilang:
            row(f"Jejak {NAMA_JENIS[j]}", "ditagih", "tidak ada sesi alat", "tidak_ada", "perlu klarifikasi" if mit_off else "")
    # ---- ventilation: the clamp says jalan (giving breaths) / siaga (standby) / mati; the ventilation type only when the
    # ventilator itself reported it ----------------------------------------------------------------------------------------
    v = by["ventilator"]
    if v:
        jl = [s for s in v if s["mode"] == "jalan"]
        sg = [s for s in v if s["mode"] == "siaga"]
        nyala = [s for s in v if s["mode"] != "mati"]
        celah = CELAH_MENIT["ventilator"]
        run_j = _terpanjang(_gabung(jl, celah))
        run_j_off = _terpanjang(_gabung(jl, celah, off))
        run_on = _terpanjang(_gabung(nyala, celah))
        j_jl, j_sg = _jam_total(jl), _jam_total(sg)
        u = {"jam_jalan": round(j_jl, 2), "jam_siaga": round(j_sg, 2),
             "run_jalan_terpanjang_jam": round(run_j["jam"], 2) if run_j else 0.0, "run_menyala_terpanjang_jam": round(run_on["jam"], 2) if run_on else 0.0,
             "sesi": len(v), "device": sorted({s["device_id"] for s in v})}
        # the ventilation type the ventilator reported itself (its data port, never the clamp)
        dev_inv = [s for s in jl if s["ventilasi"] == "invasif"]
        dev_niv = [s for s in jl if s["ventilasi"] == "non_invasif"]
        j_dev_inv, j_dev_niv, j_tanpa_tipe = _jam_total(dev_inv), _jam_total(dev_niv), _jam_total([s for s in jl if not s["ventilasi"]])
        if dev_inv or dev_niv:
            u["mode_dari_ventilator"] = {"invasif": round(j_dev_inv, 2), "non_invasif": round(j_dev_niv, 2)}
        ukur["ventilator"] = u
        dev = ", ".join(u["device"][:3])
        if vent_tagih:
            if j_jl < 1.0 and j_sg > 0:
                sigs.append(_sig("IOT_VENTILATOR_STANDBY", 1.0, f,
                                 f"Klaim menagih {vent_label}, tetapi sensor clamp pada kabel daya ventilator ({dev}) yang terikat ke pasien ini mencatat "
                                 f"alat hanya siaga {_jam(j_sg)} ({len(sg)} sesi) dan tidak pernah jalan memberi napas (jalan {_jam(j_jl)}).",
                                 [_mit("STATUS_DARI_POLA_ARUS", "status jalan/siaga dibaca dari pola arus listrik alat: perlu dicocokkan dengan lembar observasi "
                                                                "ventilator", 0.0)] + mit_off, {**u}))
                row("Status ventilator", vent_label, f"siaga {_jam(j_sg)}, jalan {_jam(j_jl)}", "tidak_ada")
            elif vent_kode and j_dev_niv >= 1.0 and j_dev_inv < 1.0 and j_tanpa_tipe < 1.0:
                sigs.append(_sig("IOT_MODE_NONINVASIF", 1.0 if j_dev_inv == 0 else 0.8, f,
                                 f"Klaim menagih {vent_label}, tetapi ventilator ({dev}) yang terikat ke pasien ini sendiri melaporkan mode non-invasif "
                                 f"{_jam(j_dev_niv)} dan mode invasif hanya {_jam(j_dev_inv)} (mode dari data ventilator, bukan dari sensor clamp)"
                                 + (f"; siaga {_jam(j_sg)}" if j_sg else "") + ". Ventilasi non-invasif dikode 93.90, bukan 96.7x.",
                                 [_mit("MODE_DARI_VENTILATOR", "mode dilaporkan ventilator itu sendiri: perlu dicocokkan dengan lembar observasi ventilator", 0.0)]
                                 + mit_off, {**u}))
                row("Mode ventilasi (data ventilator)", vent_label, f"non-invasif {_jam(j_dev_niv)}, invasif {_jam(j_dev_inv)}", "tidak_ada",
                    "dilaporkan ventilator, bukan sensor clamp; ventilasi non-invasif = 93.90")
            elif perlu_96:
                lr = run_j["jam"] if run_j else 0.0
                lr_on = run_on["jam"] if run_on else 0.0
                if lr < JAM_96:
                    s = 1.0 if lr < 72 else 0.8 if lr < 90 else 0.6
                    mit = []
                    if lr_on >= JAM_96:  # powered long enough without a break: only the part read as "jalan" is short (state from the current)
                        mit.append(_mit("STATUS_DARI_POLA_ARUS", f"ventilator menyala {_jam(lr_on)} tanpa putus; yang kurang hanya bagian yang terbaca jalan "
                                        "(sisanya siaga) dari pola arus: perlu dicocokkan dengan lembar observasi", 0.4))
                    if run_j_off and run_j_off["jam"] >= JAM_96 and run_j_off["jam"] > lr:
                        mit.append(_mit("GATEWAY_OFFLINE", f"bila jeda saat gateway offline dihitung tetap jalan, rangkaian jalan menjadi {_jam(run_j_off['jam'])}: "
                                        "perlu klarifikasi", 0.7))
                    elif mit_off:
                        mit += mit_off
                    n_run = len(_gabung(jl, celah))
                    teks = ("Klaim menagih ventilasi mekanik ≥ 96 jam berturut-turut (96.72"
                            + (f"; jam ventilator di klaim {_angka(jam_vent_tagih, 0)} jam" if jam_vent_tagih else "") + "), tetapi sensor clamp pada "
                            f"kabel daya ventilator ({dev}) mencatat alat jalan paling lama {_jam(lr)} berturut-turut"
                            + (f" ({_wkt(run_j['mulai'])} s.d. {_wkt(run_j['selesai'])})" if run_j else "")
                            + f"; total jalan {_jam(j_jl)} dalam {n_run} rangkaian, kurang {_jam(JAM_96 - lr)} dari syarat 96 jam tanpa putus.")
                    sigs.append(_sig("IOT_VENTILASI_KURANG_96", s, f, teks, mit, {**u, "kurang_jam": round(JAM_96 - lr, 2), "rangkaian_jalan": n_run}))
                    row("Durasi ventilasi", "96.72: ≥ 96 jam berturut-turut", f"jalan terpanjang {_jam(lr)} (total {_jam(j_jl)})", "tidak_ada",
                        f"kurang {_jam(JAM_96 - lr)}")
                else:
                    row("Durasi ventilasi", "96.72: ≥ 96 jam berturut-turut", f"jalan terpanjang {_jam(lr)}", "cocok")
            else:
                row("Ventilasi", vent_label, f"jalan {_jam(j_jl)}, siaga {_jam(j_sg)}", "cocok" if j_jl >= 1 else "info")
        else:
            row("Ventilator", "tidak ditagih", f"jalan {_jam(j_jl)}, siaga {_jam(j_sg)}", "info")
    # ---- haemodialysis ---------------------------------------------------------------------------------------------------
    h = by["hemodialisis"]
    if hd_tagih > 0 and (h or (mine and "hemodialisis" in cakupan)):
        runs = _gabung([s for s in h if s["mode"] == "jalan"], CELAH_MENIT["hemodialisis"])
        penuh = [r for r in runs if r["jam"] >= JAM_HD_PENUH]
        singkat = [r for r in runs if 0 < r["jam"] < JAM_HD_PENUH]
        ukur["hemodialisis"] = {"sesi_ditagih": hd_tagih, "sesi_penuh": len(penuh), "sesi_singkat": len(singkat),
                                "durasi_jam": [round(r["jam"], 2) for r in runs], "jam_idle": round(_jam_total([s for s in h if s["mode"] == "idle"]), 2)}
        kurang = hd_tagih - len(penuh)
        n_singkat = min(len(singkat), max(0, kurang))
        if n_singkat:
            sk = sorted(singkat, key=lambda r: r["jam"])[:n_singkat]
            s = 1.0 if min(r["jam"] for r in sk) < 2.0 else 0.7
            daftar = "; ".join(f"{_wkt(r['mulai'])} {_jam(r['jam'])}" for r in sk[:5])
            sigs.append(_sig("IOT_HD_SESI_SINGKAT", s, f,
                             f"Klaim menagih {hd_tagih} sesi hemodialisis penuh, tetapi mesin hemodialisis yang terikat ke pasien ini hanya berjalan "
                             f"≥ 3 jam pada {len(penuh)} sesi; {n_singkat} sesi berjalan kurang dari 3 jam ({daftar}).",
                             list(mit_off), {**ukur["hemodialisis"]}))
            row("Durasi hemodialisis", f"{hd_tagih} sesi penuh", f"{len(penuh)} sesi ≥ 3 jam, {len(singkat)} sesi < 3 jam", "tidak_ada")
        hantu = max(0, kurang - len(singkat))
        if hantu and mine and "hemodialisis" not in hilang:
            mit = list(mit_off) if "hemodialisis" in cakupan else [
                _mit("CAKUPAN_SEBAGIAN", "tidak tercatat bahwa semua mesin hemodialisis faskes ini bersensor: sesi lain bisa di mesin tanpa sensor, "
                                         "perlu klarifikasi", 0.5)]
            sigs.append(_sig("IOT_HD_TANPA_SESI", min(1.0, 0.6 + 0.2 * hantu), f,
                             f"Klaim menagih {hd_tagih} sesi hemodialisis, tetapi mesin hemodialisis yang terikat ke pasien ini hanya berjalan "
                             f"{len(runs)} sesi ({len(penuh)} penuh, {len(singkat)} singkat): {hantu} sesi tidak punya jejak alat sama sekali.",
                             mit, {**ukur["hemodialisis"], "sesi_tanpa_jejak": hantu}))
            row("Sesi hemodialisis", f"{hd_tagih} sesi", f"{len(runs)} sesi berjalan", "tidak_ada", f"{hantu} sesi tanpa jejak")
        if not n_singkat and not hantu:
            row("Sesi hemodialisis", f"{hd_tagih} sesi", f"{len(penuh)} sesi ≥ 3 jam", "cocok")
    # ---- ICU days ----------------------------------------------------------------------------------------------------------
    icu = [s for s in by["icu"] if s["mode"] == "nyala"]
    if icu_tagih > 0 and by["icu"]:
        hari_tgl, hari_jam, tot = _hari_nyala(icu)
        hari = max(hari_tgl, hari_jam)
        ukur["icu"] = {"hari_ditagih": icu_tagih, "hari_nyala": hari, "hari_kalender": hari_tgl, "jam_nyala": round(tot, 2)}
        lebih = icu_tagih - hari
        if lebih >= 1:
            mit = []
            hari_off = off_win / 24
            if off_win >= 1 and icu_tagih <= hari + int(-(-round(hari_off, 6) // 1)):
                mit.append(_mit("GATEWAY_OFFLINE", f"gateway offline {_jam(off_win)} dalam masa rawat dapat menutupi hari ICU yang hilang: perlu klarifikasi", 0.7))
            sigs.append(_sig("IOT_HARI_ICU_LEBIH", min(1.0, lebih / 2), f,
                             f"Klaim menagih {icu_tagih} hari ICU, tetapi bed/monitor ICU yang terikat ke pasien ini menyala {_jam(tot)} pada "
                             f"{hari_tgl} hari kalender (dihitung {hari} hari): {lebih} hari ICU lebih banyak dari yang tercatat alat.",
                             mit, {**ukur["icu"], "hari_lebih": lebih}))
            row("Hari ICU", f"{icu_tagih} hari", f"{hari} hari ({_jam(tot)} menyala)", "tidak_ada", f"lebih {lebih} hari")
        else:
            row("Hari ICU", f"{icu_tagih} hari", f"{hari} hari ({_jam(tot)} menyala)", "cocok")
    # ---- binding: the same device bound to two patients at the same time ---------------------------------------------------
    tumpang = []
    for s in mine:
        for o in semua:
            if o is s or o["device_id"] != s["device_id"] or not o["peserta"] or o["peserta"] == s["peserta"]:
                continue
            if o["mode"] in ("mati",) or s["mode"] in ("mati",):
                continue
            a, b = max(s["mulai"], o["mulai"]), min(s["selesai"], o["selesai"])
            jam = (b - a).total_seconds() / 3600
            if jam * 60 >= TUMPANG_MENIT:
                tumpang.append({"device_id": s["device_id"], "sesi": s["sesi_id"], "sesi_lain": o["sesi_id"], "peserta_lain": o["peserta"],
                                "mulai": a, "selesai": b, "jam": jam})
    if tumpang:
        tumpang.sort(key=lambda x: -x["jam"])
        maks = tumpang[0]
        s = 1.0 if maks["jam"] >= 2 else 0.6
        mit = [] if maks["jam"] >= 0.5 else [_mit("SERAH_TERIMA", "irisan < 30 menit: bisa serah terima alat antarpasien", 0.7)]
        lain = sorted({x["peserta_lain"] for x in tumpang})
        sigs.append(_sig("IOT_BINDING_TUMPANG", s, f,
                         f"Alat {maks['device_id']} terikat ke pasien ini dan sekaligus ke {len(lain)} pasien lain pada waktu yang sama: irisan terpanjang "
                         f"{_jam(maks['jam'])} ({_wkt(maks['mulai'])} s.d. {_wkt(maks['selesai'])}). Satu alat tidak dapat dipakai dua pasien sekaligus; "
                         "salah satu tagihan pemakaian alat tidak didukung.", mit,
                         {"irisan_jam_terpanjang": round(maks["jam"], 2), "pasangan": len(tumpang), "device": sorted({x["device_id"] for x in tumpang})}))
        row("Binding alat", "alat pasien ini", f"{len(tumpang)} irisan dengan pasien lain, terpanjang {_jam(maks['jam'])}", "tidak_ada")
    # ---- readings with no patient bound (facility context) -----------------------------------------------------------------
    lepas = [s for s in semua if not s["peserta"] and not s["kunjungan"] and not s["konteks"] and s["mode"] not in ("mati", "siaga", "idle")
             and dalam_jendela(s)]
    j_lepas = _jam_total(lepas)
    if lepas:
        ukur["tanpa_pasien"] = {"sesi": len(lepas), "jam": round(j_lepas, 2), "device": sorted({s["device_id"] for s in lepas})[:10]}
    if j_lepas >= TANPA_PASIEN_JAM:
        sigs.append(_sig("IOT_TANPA_PASIEN", min(1.0, j_lepas / 48), f,
                         f"Dalam masa rawat klaim ini, {len({s['device_id'] for s in lepas})} alat di faskes ini berjalan {_jam(j_lepas)} ({len(lepas)} sesi) "
                         "tanpa pasien yang terikat. Ini temuan tingkat faskes (kebersihan binding), bukan bukti atas klaim ini: perlu klarifikasi.",
                         [_mit("TINGKAT_FASKES", "temuan tingkat faskes: tidak menunjuk klaim ini", 0.0)], ukur["tanpa_pasien"], ("faskes", f)))
        row("Pembacaan tanpa pasien", "—", f"{_jam(j_lepas)} di {len(lepas)} sesi", "info", "tingkat faskes")
    # ---- anchors ---------------------------------------------------------------------------------------------------------
    anchors = [jangkar] if isinstance(jangkar, dict) else [x for x in (jangkar or []) if isinstance(x, dict)]
    raw_mine = [s["asli"] for s in mine]
    tidak_cocok, terlambat, ukur_j = [], [], []
    for ja in anchors:
        akar = str(ja.get("akar") or ja.get("merkle_root") or "").lower()
        t_j = waktu(ja.get("waktu") or ja.get("anchored_at"))
        ids = ja.get("sesi_ids")
        bukti = ja.get("bukti") if isinstance(ja.get("bukti"), dict) else None
        info = {"akar": akar[:16], "waktu": _wkt(t_j) if t_j else None}
        if akar:
            if bukti:
                gagal = [sid for sid, jalur in bukti.items()
                         if (src := next((x for x in raw_mine if str(x.get("sesi_id")) == str(sid)), None)) is not None
                         and cek_inklusi(hash_daun(src), jalur) != akar]
                info["dicek"] = "bukti_inklusi"
            else:
                pakai = [x for x in raw_mine if (ids is None or str(x.get("sesi_id")) in {str(i) for i in ids})]
                hit = akar_sesi(pakai) if pakai else None
                gagal = [] if (hit is None or hit == akar) else [str(x.get("sesi_id")) for x in pakai]
                info["dicek"] = "akar_sesi"
                info["akar_hitung"] = (hit or "")[:16]
            info["cocok"] = not gagal
            if gagal:
                tidak_cocok.append((akar, gagal))
        if t_j and k["diajukan"] and t_j > k["diajukan"]:
            terlambat.append((t_j, (t_j - k["diajukan"]).total_seconds() / 3600))
            info["terlambat_jam"] = round((t_j - k["diajukan"]).total_seconds() / 3600, 2)
        ukur_j.append(info)
    if anchors:
        ukur["jangkar"] = ukur_j
    if tidak_cocok:
        akar, gagal = tidak_cocok[0]
        sigs.append(_sig("IOT_JANGKAR_TIDAK_COCOK", 1.0, f,
                         f"Sesi alat yang dikirim untuk klaim ini tidak menghasilkan akar Merkle yang dijangkarkan ({akar[:16]}…): {len(gagal)} sesi "
                         f"({', '.join(gagal[:4])}) telah berubah sejak dijangkarkan, sehingga bukti perangkat ini tidak dapat dipercaya.", [],
                         {"sesi_berubah": gagal[:20], "jangkar_tidak_cocok": len(tidak_cocok)}))
        row("Integritas (jangkar)", "akar Merkle dijangkarkan", f"{len(gagal)} sesi tidak cocok", "tidak_ada")
    elif anchors and any(x.get("cocok") for x in ukur_j):
        row("Integritas (jangkar)", "akar Merkle dijangkarkan", "sesi cocok dengan jangkar", "cocok")
    if terlambat:
        t_j, telat = max(terlambat, key=lambda x: x[1])
        mit = []
        if off and mine and any(a <= max(s["selesai"] for s in mine) and b >= min(s["mulai"] for s in mine) for a, b in off):
            mit.append(_mit("GATEWAY_OFFLINE", "gateway offline saat sesi berlangsung: data dikirim tertunda (simpan-lalu-kirim), perlu klarifikasi", 0.6))
        sigs.append(_sig("IOT_JANGKAR_TERLAMBAT", 1.0 if telat >= 24 else 0.6, f,
                         f"Bukti perangkat dijangkarkan {_wkt(t_j)}, {_jam(telat)} setelah klaim diajukan ({_wkt(k['diajukan'])}): bukti yang dibuat "
                         "setelah klaim tidak dapat membuktikan pemakaian alat saat itu.", mit, {"terlambat_jam": round(telat, 2)}))
        row("Waktu jangkar", f"klaim diajukan {_wkt(k['diajukan'])}", f"dijangkarkan {_wkt(t_j)}", "tidak_ada", f"terlambat {_jam(telat)}")
    # ---- signing keys ------------------------------------------------------------------------------------------------------
    reg = _perangkat(al)
    dicabut = []
    for dev in sorted({s["device_id"] for s in mine}):
        r = reg.get(dev) or {}
        st = str(r.get("kunci") or r.get("status_kunci") or "").lower()
        if st not in ("dicabut", "revoked", "dicabut_paksa"):
            continue
        t_c = waktu(r.get("dicabut_pada") or r.get("revoked_at"))
        akhir = max(s["selesai"] for s in mine if s["device_id"] == dev)
        if t_c is None or t_c <= akhir:
            dicabut.append((dev, t_c))
        else:
            row("Kunci alat", dev, f"dicabut {_wkt(t_c)}, setelah sesi terakhir {_wkt(akhir)}", "info", "sesi ditandatangani saat kunci masih sah")
    if dicabut:
        sigs.append(_sig("IOT_KUNCI_DICABUT", 1.0 if any(t for _, t in dicabut) else 0.6, f,
                         "Sesi alat untuk klaim ini ditandatangani kunci perangkat yang sudah dicabut: "
                         + "; ".join(f"{d} (dicabut {_wkt(t) if t else 'waktu tidak diketahui'})" for d, t in dicabut[:4])
                         + ". Bukti dari alat itu tidak dapat dipercaya sampai faskes menjelaskan pencabutan kuncinya.", [],
                         {"device": [d for d, _ in dicabut]}))
        row("Kunci alat", ", ".join(d for d, _ in dicabut), "dicabut sebelum sesi selesai", "tidak_ada")
    for j in ("ventilator", "hemodialisis", "icu"):
        if not ditagih[j] and by[j]:
            row(NAMA_JENIS[j].capitalize(), "tidak ditagih", f"{len(by[j])} sesi ({_jam(_jam_total(by[j]))})", "info")
    fired = {s["kode"] for s in sigs}
    nilai = {"iot_ada": bool(dicek), "iot_sesi": len(mine), "iot_jam_ventilator_jalan": (ukur.get("ventilator") or {}).get("jam_jalan"),
             "iot_run_ventilator_jalan_jam": (ukur.get("ventilator") or {}).get("run_jalan_terpanjang_jam"),
             "iot_hd_sesi_penuh": (ukur.get("hemodialisis") or {}).get("sesi_penuh"), "iot_hari_icu": (ukur.get("icu") or {}).get("hari_nyala"),
             "iot_jangkar_cocok": (not tidak_cocok) if anchors else None}
    return {"versi": VERSI, "dicek": bool(dicek), "sinyal": sigs, "hasil": rows, "ukur": ukur, "nilai": nilai, "masalah": masalah[:20],
            "aturan": {rid: kode_ in fired for kode_, rid in ATURAN_ID.items()}, "tercakup": tercakup}


# =====================================================================================================================
# the engine's entry, the contract
# =====================================================================================================================
def dari_meta(c: Any, meta: dict, m: Optional[dict], f: str, konteks: Optional[list[dict]] = None) -> Optional[dict]:
    """The engine's entry (mesin._fkrtl): meta['iot'] (the payload that came with the claim) against the claim. None when no
    device evidence came. konteks: sessions of the same devices the engine saw with other claims (binding check)."""
    p = meta.get("iot")
    if not isinstance(p, dict):
        return None
    kk = meta.get("klaim_kode") or {}
    klaim = {"id": meta.get("iot_sep") or getattr(c, "kunjungan_fkrtl_id", None), "kunjungan": meta.get("iot_kunjungan") or getattr(c, "kunjungan_fkrtl_id", None),
             "peserta": meta.get("iot_peserta") or getattr(c, "peserta_id", None), "tgl_datang": getattr(c, "tgl_datang", None),
             "tgl_pulang": getattr(c, "tgl_pulang", None), "tingkat_pelayanan": getattr(c, "tingkat_pelayanan", None),
             "inacbg_kode": getattr(c, "inacbg_kode", None), "inacbg_deskripsi": getattr(c, "inacbg_deskripsi", None),
             "tindakan": kk.get("tindakan") if kk.get("tindakan") is not None else str(getattr(c, "prosedur", None) or ""),
             "hari_icu": kk.get("lama_icu_hari"), "jam_ventilator": kk.get("jam_ventilator"), "sesi_hd": kk.get("sesi_hemodialisis"),
             "diajukan": meta.get("diajukan_pada")}
    sesi = list(p.get("sesi") or []) + [{**x, "_konteks": True} for x in konteks or []]
    return periksa_iot(klaim, sesi, p.get("jangkar"), p.get("alat"), f)


def untuk_peristiwa(hasil: dict) -> dict:
    """What a stored event keeps of the device check (the table, the measured numbers, the custom-rule values)."""
    return {"versi": hasil["versi"], "dicek": hasil.get("dicek"), "hasil": hasil["hasil"][:40], "ukur": hasil.get("ukur") or {},
            "nilai": hasil.get("nilai") or {}, "masalah": (hasil.get("masalah") or [])[:10]}


def validasi(payload: Any) -> dict:
    """What a hospital may be told about its device payload: whether it is readable and what is missing. Never a check result,
    a score or a decision."""
    p = payload if isinstance(payload, dict) else {}
    masalah: list[str] = []
    if not isinstance(payload, dict):
        masalah.append("payload iot harus objek {sesi, jangkar, alat}")
    sesi = p.get("sesi")
    if sesi is not None and not isinstance(sesi, list):
        masalah.append("iot.sesi harus daftar")
        sesi = []
    if isinstance(sesi, list) and len(sesi) > MAKS_SESI:
        masalah.append(f"iot.sesi memuat {len(sesi)} sesi, batasnya {MAKS_SESI} per klaim")
    xs, m2 = baca_sesi(sesi or [], p.get("alat") if isinstance(p.get("alat"), dict) else None)
    masalah += m2
    peringatan = []
    lama = sum(1 for s in xs if s["jenis"] == "ventilator" and s["mode_asli"] in _TIPE_VENTILASI and not s["ventilasi"])
    if lama:
        peringatan.append(f"{lama} sesi ventilator memakai mode cara ventilasi (kontrak iot-1): sensor clamp hanya membedakan jalan/siaga/mati, "
                          "jadi dibaca 'jalan'; kirim cara ventilasi hanya bila dilaporkan ventilator sendiri (sumber_mode: ventilator)")
    if xs and not any(s["peserta"] or s["kunjungan"] for s in xs):
        peringatan.append("tidak ada sesi yang terikat ke pasien/kunjungan (peserta atau kunjungan kosong)")
    anchors = [p.get("jangkar")] if isinstance(p.get("jangkar"), dict) else [x for x in (p.get("jangkar") or []) if isinstance(x, dict)]
    for ja in anchors:
        if not re.match(r"^[0-9a-fA-F]{64}$", str(ja.get("akar") or ja.get("merkle_root") or "")):
            masalah.append("jangkar.akar harus hash SHA-256 heksadesimal 64 karakter")
        if not waktu(ja.get("waktu") or ja.get("anchored_at")):
            masalah.append("jangkar.waktu (waktu penjangkaran, ISO 8601) tidak terbaca")
    if not anchors and xs:
        peringatan.append("tanpa jangkar: integritas sesi tidak dapat diperiksa")
    al = p.get("alat")
    if al is not None and not isinstance(al, dict):
        masalah.append("iot.alat harus objek")
    elif al is None:
        peringatan.append("tanpa iot.alat: cakupan faskes tidak diketahui, aturan 'tanpa jejak' tidak dijalankan")
    return {"diterima": not masalah, "versi_kontrak": VERSI, "masalah": masalah[:20], "peringatan": peringatan[:10],
            "terbaca": {"sesi": len(xs), "per_jenis": {j: sum(1 for s in xs if s["jenis"] == j) for j in JENIS}, "jangkar": len(anchors)}}


def katalog() -> dict:
    """The rules in readable form (the contract document, the schema endpoint)."""
    return {"versi": VERSI, "jenis_alat": {j: {"nama": NAMA_JENIS[j], "mode": list(MODE[j])} for j in JENIS},
            "catatan_mode": "sensor clamp pada kabel daya (tanpa membuka alat) hanya membedakan jalan / siaga / mati; nilai lama ventilator "
                            "(iot-1) invasif / non_invasif dibaca jalan, standby dibaca siaga; cara ventilasi hanya dari data ventilator sendiri "
                            "(sumber_mode: ventilator, mode_ventilasi: invasif | non_invasif)",
            "ambang": {"ventilasi_96_jam": JAM_96, "hemodialisis_sesi_penuh_jam": JAM_HD_PENUH, "celah_menit": CELAH_MENIT,
                       "irisan_binding_menit": TUMPANG_MENIT, "tanpa_pasien_jam": TANPA_PASIEN_JAM},
            "aturan": [{"kode": k, "id": v, "jenis_bukti": JENIS_BUKTI[k]} for k, v in ATURAN_ID.items()],
            "daun_merkle": "SHA-256 dari " + "|".join(_DAUN) + " (jam 3 desimal), sesi diurutkan menurut sesi_id; simpul = SHA-256(kiri || kanan), "
                           "simpul ganjil terakhir dipasangkan dengan dirinya sendiri"}
