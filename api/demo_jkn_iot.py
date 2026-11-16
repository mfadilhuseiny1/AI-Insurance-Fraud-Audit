"""IoT in the JKN audit demo: medical devices' electricity use as evidence against the procedures hospitals claim.

A smart meter (smart plug / clamp-on CT sensor) on each device sends its power every 2 minutes through the
hospital's IoT gateway. If an X-ray machine went through 8 exposure cycles on a day the hospital claimed 20 X-rays,
12 of the claimed X-rays have no physical trace on the machine. The demo builds that end to end on the platform:

1. Files (JKN Healthcare System Intelligence / raw / iot): the device register (ASPAK, Kemenkes' equipment register), the
   procedure reference (ICD-9-CM → device type, minutes / energy per procedure), the meters' power readings, and the
   supporting-procedure claim lines (e-Klaim) — with the problems real exports have (retransmitted readings, glitches,
   lower-case ids, procedure codes as "8744" / " 87.44 ", resubmitted claim lines).
2. Pipeline Builder ("Pipeline IoT alat medis JKN (demo)"): clean readings → per-reading device state → on/off
   cycles (sessions) → daily use per device, estimated procedures by device type → clean claim lines → claims per
   facility × device type × day → reconciliation → findings, devices, a facility summary.
   Estimated procedures from a device, by how its power behaves:
     X-ray, CT (cycle):       max(exposure cycles, active energy ÷ energy per procedure)
     Ultrasound (time):       powered-on minutes ÷ minimum minutes per exam (scanning barely changes the power)
     Haemodialysis (machine-hours): Σ (power − water-treatment base) ÷ power per machine ÷ 240 minutes per session
   A day is flagged when claims exceed the estimate by more than 10 % + 1; it is *not* flagged as fraud when the meter
   sent < 90 % of its readings ("Data meter tidak lengkap") and only "to verify" when the facility also has a device of
   that type without a meter (a mobile X-ray in the wards). Claims for a device type the facility does not have at all
   are flagged separately.
3. Time Series: the clean readings back a time series sync (series = meter id) — the device's power is a time series
   property, and the device object type is a sensor object type of the facility (Palantir "Sensor object types").
4. Ontology: Alat Medis IoT JKN (demo) (sensor), Temuan IoT JKN (demo) (one per facility × device type × day that does
   not reconcile), Tindakan Penunjang Diklaim JKN (demo) (the claim lines), links to the facility, the device, the
   finding and the doctor; the facility gets iot_* properties; "Verifikasi temuan IoT (demo)" records the decision.
5. Vertex (findings → devices with their power readout → claim lines grouped per doctor), the audit map (devices by
   IoT status), Data Lineage (raw → pipeline → sync → sensor object type → apps) and the audit workspace's IoT tab,
   where a decision drills down to the readings and claim lines it rests on.

Called by demo_jkn_e2e.build (step "iot"); everything is idempotent.
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

PROJECT = "JKN Healthcare System Intelligence"
PIPELINE = "Pipeline IoT alat medis JKN (demo)"
SYNC = "Daya listrik alat medis JKN (demo)"
ALAT = "Alat Medis IoT JKN (demo)"
TEMUAN = "Temuan IoT JKN (demo)"
TINDAKAN = "Tindakan Penunjang Diklaim JKN (demo)"
ACTION = "Verifikasi temuan IoT (demo)"
L_ALAT = "Alat medis IoT di faskes (demo)"
L_TEMUAN_FASKES = "Temuan IoT di faskes (demo)"
L_TEMUAN_ALAT = "Temuan IoT pada alat (demo)"
L_TINDAKAN = "Tindakan diklaim pada temuan IoT (demo)"
L_DOKTER = "Tindakan penunjang oleh dokter (demo)"
G_IOT = "Demo: Bukti IoT — alat medis vs klaim (pilot 6 faskes)"
G_IOT_TEMPLATE = "Demo: Telusuri temuan IoT"

START = date(2026, 9, 14)
DAYS = 14
STEP = 120  # seconds between two meter readings
SLOTS = 24 * 3600 // STEP
WIB = timezone(timedelta(hours=7))

# device type → estimation method, minutes per procedure, energy per procedure (Wh), procedures per device (or machine)
# per day at most, standby / active power (W), procedure codes (ICD-9-CM) and an estimated tariff effect per procedure
JENIS: dict[str, dict[str, Any]] = {
    "Rontgen": {"metode": "siklus", "durasi": 4, "energi": 148.0, "maks": 40, "standby": 180.0, "aktif": 2400.0, "tarif": 150_000,
                "kode": [("87.44", "Foto thorax rutin"), ("88.26", "Foto pelvis"), ("88.33", "Foto tulang / ekstremitas")]},
    "CT Scan": {"metode": "siklus", "durasi": 10, "energi": 3667.0, "maks": 30, "standby": 3000.0, "aktif": 25000.0, "tarif": 1_250_000,
                "kode": [("87.03", "CT scan kepala"), ("88.01", "CT scan abdomen")]},
    "USG": {"metode": "waktu", "durasi": 15, "energi": None, "maks": 30, "standby": 0.0, "aktif": 250.0, "tarif": 200_000,
            "kode": [("88.76", "USG abdomen"), ("88.78", "USG obstetri")]},
    "Hemodialisis": {"metode": "mesin_jam", "durasi": 240, "energi": None, "maks": 3, "standby": 400.0, "aktif": 1300.0, "tarif": 950_000,
                     "kode": [("39.95", "Hemodialisis")]},
}

# the pilot: (id, facility, name, type, make/model, meter (None: no meter), machines, scenario)
DEVICES = [
    ("ALT-RS01-RO1", "RS-01", "Rontgen DR ruang 1", "Rontgen", "DR 50 kW (contoh)", "MTR-0101", 1, "phantom"),
    ("ALT-RS01-CT1", "RS-01", "CT scan 64 slice", "CT Scan", "CT 64 slice (contoh)", "MTR-0102", 1, "ok"),
    ("ALT-RS01-US1", "RS-01", "USG poli kebidanan", "USG", "USG 4D (contoh)", "MTR-0103", 1, "ok"),
    ("ALT-RS01-HD", "RS-01", "Unit hemodialisis (6 mesin)", "Hemodialisis", "Mesin HD (contoh) × 6", "MTR-0104", 6, "ok"),
    ("ALT-RS134-RO1", "RS-134", "Rontgen DR", "Rontgen", "DR 32 kW (contoh)", "MTR-1341", 1, "ok"),
    ("ALT-RS134-US1", "RS-134", "USG radiologi", "USG", "USG 2D (contoh)", "MTR-1342", 1, "rusak"),
    ("ALT-RS134-HD", "RS-134", "Unit hemodialisis (4 mesin)", "Hemodialisis", "Mesin HD (contoh) × 4", "MTR-1343", 4, "kapasitas"),
    ("ALT-RS123-RO1", "RS-123", "Rontgen DR", "Rontgen", "DR 50 kW (contoh)", "MTR-1231", 1, "ok"),
    ("ALT-RS123-RO2", "RS-123", "Rontgen mobile (bangsal)", "Rontgen", "Mobile X-ray (contoh)", None, 1, "tanpa_meter"),
    ("ALT-RS123-CT1", "RS-123", "CT scan 16 slice", "CT Scan", "CT 16 slice (contoh)", "MTR-1232", 1, "offline"),
    ("ALT-RS150-RO1", "RS-150", "Rontgen DR", "Rontgen", "DR 50 kW (contoh)", "MTR-1501", 1, "ok"),
    ("ALT-RS150-CT1", "RS-150", "CT scan 32 slice", "CT Scan", "CT 32 slice (contoh)", "MTR-1502", 1, "ok"),
    ("ALT-RS150-US1", "RS-150", "USG", "USG", "USG 3D (contoh)", "MTR-1503", 1, "ok"),
    ("ALT-RS02-RO1", "RS-02", "Rontgen DR", "Rontgen", "DR 32 kW (contoh)", "MTR-0201", 1, "ok"),
    ("ALT-RS02-US1", "RS-02", "USG", "USG", "USG 2D (contoh)", "MTR-0202", 1, "ok"),
    ("ALT-KLU07-US1", "KLU-07", "USG kebidanan", "USG", "USG 3D (contoh)", "MTR-0701", 1, "berlebih"),
]
GATEWAY = {"RS-01": "GW-RS01", "RS-134": "GW-RS134", "RS-123": "GW-RS123", "RS-150": "GW-RS150", "RS-02": "GW-RS02", "KLU-07": "GW-KLU07"}
# days the planted scenarios happen (day index 0 = 14 Sep 2026)
RUSAK = range(3, 8)  # RS-134's ultrasound is out of order 17–21 Sep (the meter keeps reporting 0 W)
OFFLINE = (8, 9)  # RS-123's CT meter / gateway is down 22–23 Sep (no readings at all)


def _days() -> list[date]:
    return [START + timedelta(days=i) for i in range(DAYS)]


def _slot_time(d: date, slot: int) -> tuple[int, str]:
    t = datetime(d.year, d.month, d.day, tzinfo=WIB) + timedelta(seconds=slot * STEP)
    return int(t.timestamp()), t.strftime("%Y-%m-%d %H:%M")


def _starts(rnd: random.Random, n: int, first: int, last: int, length: int, gap: int) -> list[int]:
    """n procedure start slots in [first, last), each `length` slots long with at least `gap` free slots between."""
    out: list[int] = []
    tries = 0
    while len(out) < n and tries < 5000:
        tries += 1
        s = rnd.randrange(first, last - length)
        if all(abs(s - o) >= length + gap for o in out):
            out.append(s)
    return sorted(out)


def _device_day(rnd: random.Random, dev: tuple, day_i: int, d: date) -> tuple[list[float], int, int]:
    """One device's power per 2-minute slot for a day (None slots: no reading), the procedures it really did, and the
    extra cycles that are not procedures (an X-ray's morning QC exposure)."""
    _id, kode, _nama, jenis, _merek, _meter, mesin, scen = dev
    j = JENIS[jenis]
    wd = d.weekday()
    p = [0.0] * SLOTS
    qc = 0
    if jenis in ("Rontgen", "CT Scan"):
        on0, on1 = (0, SLOTS) if jenis == "CT Scan" else (7 * 30, 21 * 30)
        for s in range(on0, on1):
            p[s] = j["standby"] * rnd.uniform(0.96, 1.04)
        base = {"RS-01": (6, 9), "RS-123": (5, 8), "RS-150": (6, 9), "RS-134": (4, 7), "RS-02": (4, 6)}[kode]
        if jenis == "CT Scan":
            base = {"RS-01": (6, 9), "RS-123": (4, 7), "RS-150": (5, 8)}[kode]
        lo, hi = base if wd < 5 else ((base[0] // 2, base[0]) if wd == 5 else (1, 3))
        n = rnd.randint(lo, hi)
        if kode == "RS-01" and jenis == "Rontgen" and d == date(2026, 9, 15):
            n = 7  # the walk-through: 7 X-rays + the QC exposure = 8 cycles on the machine, 20 X-rays claimed
        length = 2 if jenis == "Rontgen" else 5
        starts = _starts(rnd, n, 7 * 30 + 15, 20 * 30 + 15, length, 3)
        if jenis == "Rontgen":
            qc = 1
            starts = [7 * 30 + 5, *starts]
        for s in starts:
            for k in range(length):
                p[s + k] = j["aktif"] * rnd.uniform(0.95, 1.05)
        return p, n, qc
    if jenis == "USG":
        if scen == "rusak" and day_i in RUSAK:
            return p, 0, 0  # unplugged / out of order: the meter reports 0 W all day
        lo, hi = {"RS-01": (6, 9), "RS-134": (4, 6), "RS-150": (5, 8), "RS-02": (3, 6), "KLU-07": (4, 6)}[kode]
        n = rnd.randint(lo, hi) if wd < 6 else rnd.randint(0, 2)
        t = 8 * 30  # the clinic switches the machine on at 08:00 and off after the last exam
        done = 0
        while done < n:
            block = min(n - done, 6)
            for _ in range(block):
                dur = rnd.randint(8, 11)  # 16–22 minutes
                for k in range(dur):
                    p[t + k] = j["aktif"] * rnd.uniform(0.95, 1.05)
                t += dur
                gap = rnd.randint(1, 3)
                for k in range(gap):
                    p[t + k] = j["aktif"] * rnd.uniform(0.9, 1.0)  # idle between patients: still on
                t += gap
            done += block
            t = max(t, 13 * 30)  # afternoon session
        return p, n, 0
    # haemodialysis unit: one panel meter — water treatment (RO) base load plus 1.3 kW per running machine
    for s in range(SLOTS):
        p[s] = (j["standby"] if 6 * 30 <= s < 23 * 30 else 50.0) * rnd.uniform(0.97, 1.03)
    cap = mesin
    shifts = [rnd.randint(max(1, cap - 2), cap) for _ in range(3)] if wd < 6 else [rnd.randint(1, max(1, cap // 2)), rnd.randint(0, max(1, cap // 2)), 0]
    if scen == "kapasitas":
        shifts = [min(cap, x) for x in (rnd.randint(3, 4), rnd.randint(3, 4), rnd.randint(2, 3))] if wd < 6 else [2, 1, 0]
    n = 0
    for i, k in enumerate(shifts):
        s0 = (7 + 5 * i) * 30
        for s in range(s0, s0 + 125):  # 250 minutes: priming, 4 hours of dialysis, rinsing
            p[s] += j["aktif"] * k * rnd.uniform(0.97, 1.03)
        n += k
    return p, n, 0


def generate(doctors: dict[str, list[dict]], seed: int = 911) -> tuple[dict[str, list[dict]], dict]:
    """The raw files and what really happened (procedures done per device and day, the planted claims)."""
    rnd = random.Random(seed)
    registri, bacaan, klaim = [], [], []
    truth: dict = {"real": {}, "claimed": {}}
    for dev in DEVICES:
        did, kode, nama, jenis, merek, meter, mesin, _scen = dev
        j = JENIS[jenis]
        registri.append({"id_alat": did, "kode_faskes": kode if rnd.random() > 0.3 else f" {kode.lower()} ", "nama_alat": nama, "jenis_alat": jenis,
                         "merek_model": merek, "id_meter": (meter if rnd.random() > 0.3 else meter.lower()) if meter else None,
                         "id_gateway": GATEWAY[kode] if meter else None, "jumlah_mesin": mesin, "daya_standby_w": j["standby"], "daya_aktif_w": j["aktif"],
                         "sumber": "ASPAK (Aplikasi Sarana, Prasarana dan Alat Kesehatan)", "meter_terpasang": "2026-09-01" if meter else None})
    # mobile X-ray procedures in RS-123's wards: real, but no meter sees them
    mobile = {d: rnd.randint(2, 4) for d in _days()}
    for dev in DEVICES:
        did, kode, nama, jenis, merek, meter, mesin, scen = dev
        drnd = random.Random(f"{seed}-{did}")
        for i, d in enumerate(_days()):
            p, n, _qc = _device_day(drnd, dev, i, d)
            if scen == "tanpa_meter":
                n = mobile[d]
            truth["real"][(did, d.isoformat())] = n
            if not meter or (scen == "offline" and i in OFFLINE):
                continue
            for s in range(SLOTS):
                if drnd.random() < 0.004:
                    continue  # packet lost
                ts, local = _slot_time(d, s)
                w: Any = round(p[s], 1)
                if drnd.random() < 0.0004:
                    w = None if drnd.random() < 0.5 else -1.0  # sensor glitch
                row = {"id_gateway": GATEWAY[kode], "id_meter": meter if drnd.random() > 0.1 else meter.lower(), "ts": ts, "waktu_lokal": local,
                       "daya_watt": w, "tegangan_v": round(drnd.uniform(216, 224), 1)}
                bacaan.append(row)
                if drnd.random() < 0.008:
                    bacaan.append(dict(row))  # the gateway retransmitted it
    # claims: per facility × device type × day — what was done, plus the planted extra claims
    seq = 0
    crnd = random.Random(f"{seed}-klaim")
    types_at: dict[tuple[str, str], int] = {}
    for dev in DEVICES:
        types_at[(dev[1], dev[3])] = types_at.get((dev[1], dev[3]), 0)
    for i, d in enumerate(_days()):
        iso = d.isoformat()
        for (kode, jenis) in list(types_at) + [("KLU-07", "Rontgen")]:
            real = sum(truth["real"].get((dev[0], iso), 0) for dev in DEVICES if dev[1] == kode and dev[3] == jenis)
            wd = d.weekday()
            extra, phantom_by = 0, None
            if kode == "RS-01" and jenis == "Rontgen" and wd < 6 and i not in (2, 9):
                extra = 13 if iso == "2026-09-15" else crnd.randint(9, 13)
                phantom_by = ["D-04", "D-04", "D-04", "D-03", "D-03"]
            elif kode == "RS-134" and jenis == "USG" and i in RUSAK:
                extra = crnd.randint(4, 6)  # the machine is out of order; the claims go on
            elif kode == "RS-134" and jenis == "Hemodialisis" and wd < 6 and i % 3 != 2:
                extra = crnd.randint(4, 6)
            elif kode == "KLU-07" and jenis == "USG" and wd < 6 and i % 4 != 3:
                extra = crnd.randint(5, 7)
                phantom_by = ["D-114", "D-114", "D-114", "D-115"]
            elif kode == "KLU-07" and jenis == "Rontgen":
                extra = crnd.randint(1, 2) if wd < 5 and i % 2 == 0 else 0  # the clinic has no X-ray machine
                phantom_by = ["D-114", "D-116"]
            staff = [x["id_dokter"] for x in doctors.get(kode, [])] or ["D-01"]
            if not phantom_by:
                phantom_by = staff[:2]
            truth["claimed"][(kode, jenis, iso)] = (real, extra)
            j = JENIS[jenis]
            for k in range(real + extra):
                seq += 1
                code, _name = crnd.choice(j["kode"])
                messy = crnd.random()
                code_raw = code.replace(".", "") if messy < 0.2 else f" {code} " if messy < 0.3 else code
                row = {"no_sep": f"0301R{''.join(ch for ch in kode if ch.isdigit()).zfill(3)}0926V{seq:06d}", "tgl_pelayanan": iso,
                       "kode_faskes": kode if crnd.random() > 0.05 else kode.lower(), "kode_icd9": code_raw,
                       "id_dokter": crnd.choice(phantom_by) if k >= real else crnd.choice(staff),
                       "jenis_rawat": "Rawat inap" if jenis == "Hemodialisis" and crnd.random() < 0.1 or crnd.random() < 0.3 else "Rawat jalan",
                       "kelas_rawat": crnd.choice(["1", "2", "3", "3", "3"]),
                       "tarif_rs": float(round(j["tarif"] * crnd.uniform(0.92, 1.15), -3))}
                klaim.append(row)
                if crnd.random() < 0.01:
                    klaim.append(dict(row))  # resubmitted claim line
    ref = [{"kode_icd9": code, "nama_tindakan": name, "jenis_alat": jenis, "metode": j["metode"], "durasi_min_menit": j["durasi"],
            "energi_per_tindakan_wh": j["energi"], "sesi_per_mesin_per_hari": j["maks"], "tarif_estimasi_rp": float(j["tarif"])}
           for jenis, j in JENIS.items() for code, name in j["kode"]]
    return {"registri_alat_iot": registri, "referensi_tindakan_alat": ref, "daya_listrik_alat_iot": bacaan, "klaim_tindakan_penunjang": klaim}, truth


# ------------------------------------------------------------------------------------------------
# the pipeline (sqlite / sql.js SQL, as Pipeline Builder's SQL step runs it)
# ------------------------------------------------------------------------------------------------

SQL_DAYA = """-- Bacaan meter bersih: id meter diseragamkan, bacaan yang dikirim ulang gateway digabung, glitch sensor (kosong /
-- negatif / di luar rentang) dibuang. Dataset ini juga sumber time series sync (seri = id meter).
SELECT UPPER(TRIM(id_meter)) AS id_meter, CAST(ts AS INTEGER) AS ts, waktu_lokal, SUBSTR(waktu_lokal, 1, 10) AS tanggal,
       CAST(SUBSTR(waktu_lokal, 12, 2) AS INTEGER) AS jam, ROUND(MAX(CAST(daya_watt AS DOUBLE)), 1) AS daya_watt
FROM input
WHERE id_meter IS NOT NULL AND daya_watt IS NOT NULL AND CAST(daya_watt AS DOUBLE) >= 0 AND CAST(daya_watt AS DOUBLE) < 200000
GROUP BY UPPER(TRIM(id_meter)), CAST(ts AS INTEGER), waktu_lokal"""

SQL_PARAM = """-- Alat dari register ASPAK dengan parameter jenisnya: metode estimasi, durasi & energi per tindakan, kapasitas,
-- dan ambang daya "sedang melakukan tindakan" (Rontgen/CT: standby + 40 % selisih ke daya aktif; USG: menyala > 30 W).
SELECT r.id_alat, UPPER(TRIM(r.kode_faskes)) AS kode_faskes, TRIM(r.nama_alat) AS nama_alat, r.jenis_alat, r.merek_model,
       UPPER(TRIM(r.id_meter)) AS id_meter, r.id_gateway, CAST(r.jumlah_mesin AS INTEGER) AS jumlah_mesin,
       CAST(r.daya_standby_w AS DOUBLE) AS daya_standby_w, CAST(r.daya_aktif_w AS DOUBLE) AS daya_aktif_w,
       p.metode, p.durasi_min_menit, p.energi_per_tindakan_wh, p.sesi_per_mesin_per_hari,
       CASE p.metode WHEN 'siklus' THEN ROUND(r.daya_standby_w + 0.4 * (r.daya_aktif_w - r.daya_standby_w), 1)
                     WHEN 'waktu' THEN 30.0
                     ELSE ROUND(r.daya_standby_w + 0.5 * r.daya_aktif_w, 1) END AS ambang_aktif_w
FROM input r
JOIN (SELECT jenis_alat, MIN(metode) AS metode, MIN(durasi_min_menit) AS durasi_min_menit, MIN(energi_per_tindakan_wh) AS energi_per_tindakan_wh,
             MIN(sesi_per_mesin_per_hari) AS sesi_per_mesin_per_hari
      FROM referensi_tindakan_alat GROUP BY jenis_alat) p ON p.jenis_alat = r.jenis_alat"""

SQL_STATUS = """-- Status alat per bacaan: menyala (> 20 W), sedang tindakan (≥ ambang), awal siklus (baru naik ke ambang, atau
-- jeda > 5 menit), energi di atas standby, dan menit-mesin unit HD ((daya − beban RO) ÷ daya per mesin × 2 menit).
WITH b AS (
  SELECT d.id_meter, a.id_alat, a.metode, d.ts, d.waktu_lokal, d.tanggal, d.jam, d.daya_watt, a.daya_standby_w, a.daya_aktif_w,
         CASE WHEN d.daya_watt >= a.ambang_aktif_w THEN 1 ELSE 0 END AS aktif,
         CASE WHEN d.daya_watt > 20 THEN 1 ELSE 0 END AS menyala
  FROM input d JOIN parameter_alat a ON a.id_meter = d.id_meter),
l AS (
  SELECT *, LAG(aktif) OVER (PARTITION BY id_meter ORDER BY ts) AS aktif_sebelum, LAG(ts) OVER (PARTITION BY id_meter ORDER BY ts) AS ts_sebelum FROM b)
SELECT id_meter, id_alat, metode, ts, waktu_lokal, tanggal, jam, daya_watt, aktif, menyala,
       CASE WHEN aktif = 1 AND (aktif_sebelum IS NULL OR aktif_sebelum = 0 OR ts - ts_sebelum > 300) THEN 1 ELSE 0 END AS mulai_siklus,
       CASE WHEN aktif = 1 AND metode = 'siklus' THEN ROUND((daya_watt - daya_standby_w) * 120.0 / 3600, 2) ELSE 0 END AS energi_aktif_wh,
       CASE WHEN metode = 'mesin_jam' THEN ROUND(MAX(daya_watt - daya_standby_w, 0) / daya_aktif_w * 2, 3) ELSE 0 END AS mesin_menit
FROM l"""

SQL_SESI = """-- Siklus pemakaian (sesi) per alat: bacaan berturut-turut di atas ambang = satu siklus (eksposur Rontgen/CT,
-- satu blok menyala USG, satu blok mesin HD). Mulai, selesai, durasi, energi dan daya puncak.
WITH s AS (
  SELECT *, SUM(mulai_siklus) OVER (PARTITION BY id_meter ORDER BY ts ROWS UNBOUNDED PRECEDING) AS nomor FROM input WHERE aktif = 1)
SELECT id_alat || '-S' || SUBSTR('00000' || nomor, -5) AS id_sesi, id_alat, id_meter, metode, MIN(tanggal) AS tanggal,
       MIN(waktu_lokal) AS mulai, MAX(waktu_lokal) AS bacaan_terakhir, MIN(ts) AS mulai_ts, MAX(ts) + 120 AS selesai_ts,
       COUNT(*) * 2 AS menit, ROUND(SUM(energi_aktif_wh), 1) AS energi_wh, MAX(daya_watt) AS puncak_w
FROM s
GROUP BY id_alat, id_meter, metode, nomor"""

SQL_HARIAN = """-- Pemakaian harian per alat dan estimasi jumlah tindakan menurut cara alatnya bekerja:
--   siklus (Rontgen, CT):  maks(jumlah siklus, energi aktif ÷ energi per tindakan)
--   waktu (USG):           menit menyala ÷ durasi minimum pemeriksaan
--   mesin_jam (HD):        menit-mesin ÷ 240 menit per sesi
-- Kelengkapan = bacaan diterima ÷ 720 (satu bacaan tiap 2 menit).
WITH h AS (
  SELECT id_alat, id_meter, metode, tanggal, COUNT(*) AS bacaan, SUM(menyala) * 2 AS menit_menyala, SUM(aktif) * 2 AS menit_aktif,
         SUM(mulai_siklus) AS siklus, ROUND(SUM(energi_aktif_wh), 1) AS energi_aktif_wh, ROUND(SUM(mesin_menit), 1) AS mesin_menit,
         ROUND(SUM(daya_watt) * 2 / 60000.0, 2) AS kwh,
         MIN(CASE WHEN menyala = 1 THEN jam END) AS jam_nyala_pertama, MAX(CASE WHEN menyala = 1 THEN jam END) AS jam_nyala_terakhir
  FROM input GROUP BY id_alat, id_meter, metode, tanggal)
SELECT h.id_alat || '-' || h.tanggal AS id_pemakaian, h.*, ROUND(h.bacaan / 720.0, 3) AS kelengkapan, a.kode_faskes, a.jenis_alat, a.jumlah_mesin,
       CASE h.metode WHEN 'siklus' THEN MAX(h.siklus, CAST(ROUND(h.energi_aktif_wh / a.energi_per_tindakan_wh) AS INTEGER))
                     WHEN 'waktu' THEN CAST(h.menit_menyala / a.durasi_min_menit AS INTEGER)
                     ELSE CAST(h.mesin_menit / a.durasi_min_menit AS INTEGER) END AS estimasi_tindakan,
       a.jumlah_mesin * a.sesi_per_mesin_per_hari AS kapasitas_maks
FROM h JOIN parameter_alat a ON a.id_alat = h.id_alat"""

SQL_TRANSISI = """-- Perubahan status operasi alat (changelog Device and Machinery): Mati (≤ 20 W), Siaga (menyala di bawah ambang),
-- Tindakan (≥ ambang). Satu baris tiap status berubah; processId = alat, timestamp WIB.
WITH s AS (
  SELECT id_alat, ts, waktu_lokal, daya_watt, CASE WHEN menyala = 0 THEN 'Mati' WHEN aktif = 1 THEN 'Tindakan' ELSE 'Siaga' END AS state FROM input),
l AS (SELECT *, LAG(state) OVER (PARTITION BY id_alat ORDER BY ts) AS state_sebelum FROM s)
SELECT id_alat || '-' || ts AS id_perubahan, id_alat AS processId, state, REPLACE(waktu_lokal, ' ', 'T') || ':00+07:00' AS timestamp,
       ts, id_alat, state_sebelum, daya_watt
FROM l
WHERE state_sebelum IS NULL OR state_sebelum <> state"""

SQL_TINDAKAN = """-- Klaim tindakan penunjang bersih: kode faskes diseragamkan, kode ICD-9-CM dirapikan ("8744", " 87.44 " → 87.44),
-- baris yang dikirim ulang (SEP + kode sama) didedup, dipetakan ke jenis alat, dokter dan faskes. id_rekon = kunci
-- faskes × jenis alat × hari untuk dicocokkan dengan pemakaian alat.
WITH c AS (
  SELECT TRIM(no_sep) AS no_sep, tgl_pelayanan AS tanggal, UPPER(TRIM(kode_faskes)) AS kode_faskes,
         REPLACE(REPLACE(TRIM(kode_icd9), '.', ''), ' ', '') AS kode_digit, id_dokter, jenis_rawat, kelas_rawat, CAST(tarif_rs AS DOUBLE) AS tarif_rs
  FROM input WHERE no_sep IS NOT NULL),
n AS (SELECT *, SUBSTR(kode_digit, 1, 2) || '.' || SUBSTR(kode_digit, 3) AS kode_icd9 FROM c),
d AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY no_sep, kode_icd9 ORDER BY tarif_rs DESC) AS rk FROM n)
SELECT d.no_sep || '-' || d.kode_icd9 AS id_baris, r.nama_tindakan || ' · ' || d.no_sep AS judul, d.no_sep, d.tanggal, d.kode_faskes,
       f.nama AS nama_faskes, d.kode_icd9, r.nama_tindakan, r.jenis_alat, d.id_dokter, k.nama AS nama_dokter, d.jenis_rawat, d.kelas_rawat, d.tarif_rs,
       'IOT-' || d.kode_faskes || '-' || REPLACE(UPPER(r.jenis_alat), ' ', '') || '-' || d.tanggal AS id_rekon
FROM d
JOIN referensi_tindakan_alat r ON r.kode_icd9 = d.kode_icd9
LEFT JOIN faskes_audit f ON f.kode = d.kode_faskes
LEFT JOIN dokter_audit k ON k.id_dokter = d.id_dokter
WHERE d.rk = 1"""

SQL_KLAIM_HARIAN = """-- Klaim per faskes × jenis alat × hari: jumlah tindakan, nilainya, dan dokter yang paling banyak mengajukan.
SELECT id_rekon, kode_faskes, jenis_alat, tanggal, COUNT(*) AS klaim_tindakan, ROUND(SUM(tarif_rs), 0) AS nilai_klaim_rp,
       COUNT(DISTINCT id_dokter) AS jumlah_dokter,
       (SELECT x.nama_dokter FROM input x WHERE x.id_rekon = input.id_rekon GROUP BY x.nama_dokter ORDER BY COUNT(*) DESC, x.nama_dokter LIMIT 1) AS dokter_terbanyak
FROM input
GROUP BY id_rekon, kode_faskes, jenis_alat, tanggal"""

SQL_REKON = """-- Rekonsiliasi: tiap faskes × jenis alat × hari (hari berklaim, dan setiap hari pilot untuk alat bermeter)
-- membandingkan klaim dengan estimasi tindakan dari alat.
--   Klaim tanpa alat terdaftar          : tidak ada alat jenis itu di register ASPAK faskes
--   Data meter tidak lengkap             : meter mengirim < 90 % bacaan — bukan bukti, jangan disimpulkan
--   Klaim saat alat mati                 : alat tidak dipakai sama sekali, klaim tetap ada
--   Perlu verifikasi (alat tanpa meter)  : klaim > estimasi, tapi ada alat jenis sama tanpa meter (mis. Rontgen mobile)
--   Klaim melebihi pemakaian alat        : klaim > estimasi × 1,1 + 1
WITH pakai AS (
  SELECT kode_faskes, jenis_alat, tanggal, SUM(estimasi_tindakan) AS est, SUM(siklus) AS siklus, SUM(menit_menyala) AS menit_menyala,
         SUM(mesin_menit) AS mesin_menit, ROUND(SUM(energi_aktif_wh) / 1000.0, 2) AS energi_aktif_kwh, MIN(kelengkapan) AS kelengkapan,
         GROUP_CONCAT(id_alat, ', ') AS alat
  FROM pemakaian_alat_harian GROUP BY kode_faskes, jenis_alat, tanggal),
terpasang AS (
  SELECT kode_faskes, jenis_alat, SUM(CASE WHEN id_meter IS NULL THEN 1 ELSE 0 END) AS tanpa_meter,
         SUM(CASE WHEN id_meter IS NOT NULL THEN 1 ELSE 0 END) AS bermeter, MIN(CASE WHEN id_meter IS NOT NULL THEN id_alat END) AS alat_utama,
         SUM(jumlah_mesin * sesi_per_mesin_per_hari) AS kapasitas_maks, GROUP_CONCAT(id_alat, ', ') AS semua_alat
  FROM parameter_alat GROUP BY kode_faskes, jenis_alat),
hari AS (SELECT DISTINCT tanggal FROM pemakaian_alat_harian),
kunci AS (
  SELECT t.kode_faskes, t.jenis_alat, h.tanggal FROM terpasang t CROSS JOIN hari h WHERE t.bermeter > 0
  UNION SELECT kode_faskes, jenis_alat, tanggal FROM input),
r AS (
  SELECT k.kode_faskes, k.jenis_alat, k.tanggal,
         'IOT-' || k.kode_faskes || '-' || REPLACE(UPPER(k.jenis_alat), ' ', '') || '-' || k.tanggal AS id_rekon,
         COALESCE(c.klaim_tindakan, 0) AS klaim, COALESCE(c.nilai_klaim_rp, 0) AS nilai_klaim_rp, c.dokter_terbanyak, c.jumlah_dokter,
         COALESCE(p.est, 0) AS est, COALESCE(p.siklus, 0) AS siklus, COALESCE(p.menit_menyala, 0) AS menit_menyala,
         COALESCE(p.mesin_menit, 0) AS mesin_menit, COALESCE(p.energi_aktif_kwh, 0) AS energi_aktif_kwh, COALESCE(p.kelengkapan, 0) AS kelengkapan,
         COALESCE(t.bermeter, 0) AS bermeter, COALESCE(t.tanpa_meter, 0) AS tanpa_meter, t.alat_utama, COALESCE(t.kapasitas_maks, 0) AS kapasitas_maks,
         COALESCE(t.semua_alat, '') AS alat_terkait
  FROM kunci k
  LEFT JOIN input c ON c.kode_faskes = k.kode_faskes AND c.jenis_alat = k.jenis_alat AND c.tanggal = k.tanggal
  LEFT JOIN pakai p ON p.kode_faskes = k.kode_faskes AND p.jenis_alat = k.jenis_alat AND p.tanggal = k.tanggal
  LEFT JOIN terpasang t ON t.kode_faskes = k.kode_faskes AND t.jenis_alat = k.jenis_alat),
s AS (
  SELECT *, CAST(est * 1.1 AS INTEGER) + 1 AS batas,
         CASE WHEN bermeter = 0 AND tanpa_meter = 0 AND klaim > 0 THEN 'Klaim tanpa alat terdaftar'
              WHEN bermeter = 0 THEN 'Tanpa meter (tidak dinilai)'
              WHEN kelengkapan < 0.9 THEN 'Data meter tidak lengkap'
              WHEN est = 0 AND klaim > 0 THEN 'Klaim saat alat mati'
              WHEN klaim > CAST(est * 1.1 AS INTEGER) + 1 AND tanpa_meter > 0 THEN 'Perlu verifikasi (alat tanpa meter)'
              WHEN klaim > CAST(est * 1.1 AS INTEGER) + 1 THEN 'Klaim melebihi pemakaian alat'
              ELSE 'Sesuai' END AS status_rekon
  FROM r)
SELECT s.id_rekon, s.kode_faskes, f.nama AS nama_faskes, s.jenis_alat, s.tanggal, s.klaim AS klaim_tindakan, s.est AS estimasi_tindakan_alat,
       s.batas AS batas_toleransi, s.siklus, s.menit_menyala, s.mesin_menit, s.energi_aktif_kwh, s.kelengkapan, s.bermeter, s.tanpa_meter,
       s.alat_terkait, s.alat_utama, s.kapasitas_maks, s.status_rekon,
       CASE WHEN s.status_rekon IN ('Klaim tanpa alat terdaftar', 'Klaim saat alat mati', 'Klaim melebihi pemakaian alat') THEN 'Tinggi'
            WHEN s.status_rekon = 'Perlu verifikasi (alat tanpa meter)' THEN 'Sedang'
            WHEN s.status_rekon = 'Data meter tidak lengkap' THEN 'Info' ELSE 'Sesuai' END AS tingkat,
       CASE WHEN s.status_rekon IN ('Klaim tanpa alat terdaftar', 'Klaim saat alat mati') THEN s.klaim
            WHEN s.status_rekon IN ('Klaim melebihi pemakaian alat', 'Perlu verifikasi (alat tanpa meter)') THEN s.klaim - s.est ELSE 0 END AS tindakan_tak_didukung,
       ROUND(CASE WHEN s.klaim > 0 THEN s.nilai_klaim_rp * 1.0 / s.klaim ELSE 0 END
             * CASE WHEN s.status_rekon IN ('Klaim tanpa alat terdaftar', 'Klaim saat alat mati') THEN s.klaim
                    WHEN s.status_rekon IN ('Klaim melebihi pemakaian alat', 'Perlu verifikasi (alat tanpa meter)') THEN s.klaim - s.est ELSE 0 END, 0) AS nilai_tak_didukung_rp,
       s.nilai_klaim_rp, s.dokter_terbanyak, s.jumlah_dokter, f.lokasi
FROM s LEFT JOIN faskes_audit f ON f.kode = s.kode_faskes"""

SQL_TEMUAN = """-- Temuan IoT: tiap hari yang tidak cocok, dengan penjelasan berangka yang bisa dibacakan ke faskes.
SELECT id_rekon AS id_temuan, nama_faskes || ' · ' || jenis_alat || ' · ' || tanggal AS judul,
       jenis_alat || ' ' || SUBSTR(tanggal, 9, 2) || '/' || SUBSTR(tanggal, 6, 2)
         || CASE WHEN tindakan_tak_didukung > 0 THEN ' · +' || tindakan_tak_didukung ELSE '' END AS label_singkat, kode_faskes, nama_faskes, jenis_alat, tanggal,
       status_rekon AS jenis_temuan, tingkat, klaim_tindakan, estimasi_tindakan_alat, batas_toleransi, siklus, menit_menyala, mesin_menit,
       energi_aktif_kwh, kelengkapan, tanpa_meter, alat_terkait, alat_utama AS id_alat_utama, kapasitas_maks, tindakan_tak_didukung,
       nilai_tak_didukung_rp, nilai_klaim_rp, dokter_terbanyak, lokasi, 'Baru' AS status_temuan,
       CASE status_rekon
         WHEN 'Klaim melebihi pemakaian alat' THEN 'Meter listrik ' || jenis_alat || ' mencatat ' || estimasi_tindakan_alat || ' tindakan'
              || CASE WHEN jenis_alat IN ('Rontgen', 'CT Scan') THEN ' (' || siklus || ' siklus, ' || energi_aktif_kwh || ' kWh aktif)'
                      WHEN jenis_alat = 'USG' THEN ' (menyala ' || menit_menyala || ' menit)'
                      ELSE ' (' || REPLACE(ROUND(mesin_menit), '.0', '') || ' menit-mesin; kapasitas ' || kapasitas_maks || ' sesi/hari)' END
              || ', tetapi diklaim ' || klaim_tindakan || ' tindakan: ' || tindakan_tak_didukung || ' tidak didukung data pemakaian alat.'
         WHEN 'Klaim saat alat mati' THEN jenis_alat || ' tidak dipakai sama sekali hari itu (meter online, 0 siklus), tetapi diklaim '
              || klaim_tindakan || ' tindakan.'
         WHEN 'Klaim tanpa alat terdaftar' THEN 'Faskes tidak punya ' || jenis_alat || ' di register ASPAK, tetapi mengklaim '
              || klaim_tindakan || ' tindakan ' || jenis_alat || '.'
         WHEN 'Perlu verifikasi (alat tanpa meter)' THEN 'Klaim ' || klaim_tindakan || ' melebihi estimasi alat bermeter ('
              || estimasi_tindakan_alat || '); faskes juga punya ' || tanpa_meter || ' ' || jenis_alat || ' tanpa meter — verifikasi log alat itu.'
         ELSE 'Meter hanya mengirim ' || ROUND(kelengkapan * 100, 1) || ' % bacaan hari itu: data tidak cukup untuk menilai '
              || klaim_tindakan || ' klaim — periksa gateway / meter.' END AS penjelasan
FROM input
WHERE status_rekon NOT IN ('Sesuai', 'Tanpa meter (tidak dinilai)')"""

SQL_ALAT = """-- Alat medis IoT (objek sensor): register + parameter + ringkasan 14 hari pemakaian dan rekonsiliasi jenisnya di
-- faskes itu. seri_daya = id seri time series daya listrik (kosong untuk alat tanpa meter).
WITH u AS (
  SELECT id_alat, COUNT(*) AS hari_data, ROUND(AVG(kelengkapan) * 100, 1) AS kelengkapan_pct, SUM(siklus) AS siklus_total,
         SUM(estimasi_tindakan) AS estimasi_tindakan_total, ROUND(SUM(kwh), 1) AS kwh_total
  FROM pemakaian_alat_harian GROUP BY id_alat),
z AS (
  SELECT processId, state AS status_operasi, timestamp AS status_sejak FROM perubahan_status_alat p
  WHERE ts = (SELECT MAX(q.ts) FROM perubahan_status_alat q WHERE q.processId = p.processId)),
k AS (
  SELECT kode_faskes, jenis_alat, SUM(klaim_tindakan) AS klaim_total, SUM(tindakan_tak_didukung) AS tak_didukung_total,
         SUM(CASE WHEN tingkat = 'Tinggi' THEN 1 ELSE 0 END) AS hari_temuan, SUM(CASE WHEN tingkat = 'Info' THEN 1 ELSE 0 END) AS hari_data_kurang,
         SUM(CASE WHEN tingkat = 'Sedang' THEN 1 ELSE 0 END) AS hari_verifikasi
  FROM rekonsiliasi_iot_klaim GROUP BY kode_faskes, jenis_alat)
SELECT a.id_alat, a.nama_alat, a.jenis_alat, a.merek_model, a.kode_faskes, f.nama AS nama_faskes, a.id_meter, a.id_gateway, a.id_meter AS seri_daya,
       'Daya ' || a.nama_alat AS nama_sensor, 'W' AS satuan, a.metode AS metode_estimasi, a.daya_standby_w, a.daya_aktif_w, a.ambang_aktif_w,
       a.jumlah_mesin, a.jumlah_mesin * a.sesi_per_mesin_per_hari AS kapasitas_maks_harian,
       -- devices drawn on a small arc north-east of their facility (the n-th device of the facility, n = 1, 2, …)
       ROUND(CAST(SUBSTR(f.lokasi, 1, INSTR(f.lokasi, ',') - 1) AS DOUBLE) + 0.0045 * ROW_NUMBER() OVER (PARTITION BY a.kode_faskes ORDER BY a.id_alat), 5) || ','
         || ROUND(CAST(SUBSTR(f.lokasi, INSTR(f.lokasi, ',') + 1) AS DOUBLE) + 0.006 - 0.0015 * ROW_NUMBER() OVER (PARTITION BY a.kode_faskes ORDER BY a.id_alat), 5) AS lokasi,
       COALESCE(u.hari_data, 0) AS hari_data, COALESCE(u.kelengkapan_pct, 0) AS kelengkapan_pct, COALESCE(u.siklus_total, 0) AS siklus_total,
       COALESCE(u.estimasi_tindakan_total, 0) AS estimasi_tindakan_total, COALESCE(u.kwh_total, 0) AS kwh_total,
       COALESCE(k.klaim_total, 0) AS klaim_total, COALESCE(k.tak_didukung_total, 0) AS tak_didukung_total, COALESCE(k.hari_temuan, 0) AS hari_temuan,
       CASE WHEN a.id_meter IS NULL THEN 'Tanpa meter'
            WHEN COALESCE(k.hari_temuan, 0) > 0 THEN 'Ada temuan'
            WHEN COALESCE(k.hari_verifikasi, 0) > 0 THEN 'Perlu verifikasi'
            WHEN COALESCE(k.hari_data_kurang, 0) > 0 THEN 'Data meter tidak lengkap'
            ELSE 'Sesuai' END AS status_iot,
       -- only a metered device has an operating state (Device and Machinery tracks it); a device without a meter has none
       CASE WHEN a.id_meter IS NULL THEN NULL ELSE COALESCE(z.status_operasi, 'Mati') END AS status_operasi, z.status_sejak
FROM input a
LEFT JOIN faskes_audit f ON f.kode = a.kode_faskes
LEFT JOIN u ON u.id_alat = a.id_alat
LEFT JOIN k ON k.kode_faskes = a.kode_faskes AND k.jenis_alat = a.jenis_alat
LEFT JOIN z ON z.processId = a.id_alat"""

SQL_RINGKASAN = """-- Ringkasan IoT per faskes (properti tambahan Faskes Audit): alat terpantau, hari & tindakan tak didukung, nilainya.
WITH a AS (SELECT kode_faskes, COUNT(*) AS iot_alat_terpasang, SUM(CASE WHEN id_meter IS NOT NULL THEN 1 ELSE 0 END) AS iot_alat_bermeter
           FROM parameter_alat GROUP BY kode_faskes)
SELECT i.kode_faskes AS kode, a.iot_alat_terpasang, a.iot_alat_bermeter,
       SUM(CASE WHEN i.tingkat = 'Tinggi' THEN 1 ELSE 0 END) AS iot_hari_temuan,
       SUM(CASE WHEN i.tingkat = 'Tinggi' THEN i.tindakan_tak_didukung ELSE 0 END) AS iot_tindakan_tak_didukung,
       SUM(CASE WHEN i.tingkat = 'Tinggi' THEN i.nilai_tak_didukung_rp ELSE 0 END) AS iot_nilai_tak_didukung_rp,
       CASE WHEN SUM(CASE WHEN i.tingkat = 'Tinggi' THEN 1 ELSE 0 END) > 0 THEN 'Klaim tidak didukung alat'
            WHEN SUM(CASE WHEN i.tingkat = 'Sedang' THEN 1 ELSE 0 END) > 0 THEN 'Perlu verifikasi'
            WHEN SUM(CASE WHEN i.tingkat = 'Info' THEN 1 ELSE 0 END) > 0 THEN 'Data meter tidak lengkap'
            ELSE 'Sesuai' END AS iot_status,
       COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN i.tingkat = 'Tinggi' THEN i.jenis_alat END), '') AS iot_alat_bermasalah
FROM input i LEFT JOIN a ON a.kode_faskes = i.kode_faskes
GROUP BY i.kode_faskes, a.iot_alat_terpasang, a.iot_alat_bermeter"""


def nodes() -> list[dict]:
    S = lambda i, n, g, d: {"id": i, "kind": "source", "name": n, "group": g, "doc": d}  # noqa: E731
    T = lambda i, n, g, inp, sql: {"id": i, "kind": "sql", "name": n, "group": g, "input": inp, "sql": sql}  # noqa: E731
    return [
        S("s_registri", "registri_alat_iot", "referensi", "Register alat kesehatan (ASPAK) di faskes pilot, dengan meter IoT-nya"),
        S("s_ref", "referensi_tindakan_alat", "referensi", "ICD-9-CM → jenis alat, metode estimasi, durasi & energi per tindakan, kapasitas"),
        S("s_daya", "daya_listrik_alat_iot", "iot", "Ekspor gateway IoT: daya listrik tiap alat per 2 menit (smart meter / CT clamp)"),
        S("s_klaim", "klaim_tindakan_penunjang", "klaim", "Baris tindakan penunjang dari e-Klaim (Rontgen, CT, USG, hemodialisis)"),
        S("s_faskes", "faskes_audit", "referensi", "Faskes audit (pipeline audit)"),
        S("s_dokter", "dokter_audit", "referensi", "Dokter audit (pipeline audit)"),
        T("t_daya", "daya_alat_bersih", "iot", "s_daya", SQL_DAYA),
        T("t_param", "parameter_alat", "referensi", "s_registri", SQL_PARAM),
        T("t_status", "status_bacaan_alat", "iot", "t_daya", SQL_STATUS),
        T("t_sesi", "sesi_alat", "iot", "t_status", SQL_SESI),
        T("t_harian", "pemakaian_alat_harian", "iot", "t_status", SQL_HARIAN),
        T("t_transisi", "perubahan_status_alat", "iot", "t_status", SQL_TRANSISI),
        T("t_tindakan", "tindakan_penunjang_bersih", "klaim", "s_klaim", SQL_TINDAKAN),
        T("t_klaim_harian", "klaim_tindakan_harian", "klaim", "t_tindakan", SQL_KLAIM_HARIAN),
        T("t_rekon", "rekonsiliasi_iot_klaim", "rekon", "t_klaim_harian", SQL_REKON),
        T("t_temuan", "temuan_iot", "ontologi", "t_rekon", SQL_TEMUAN),
        T("t_alat", "alat_iot", "ontologi", "t_param", SQL_ALAT),
        T("t_ringkasan", "ringkasan_iot_faskes", "ontologi", "t_rekon", SQL_RINGKASAN),
    ]


OUTPUTS = [("daya_alat_bersih", "t_daya"), ("sesi_alat", "t_sesi"), ("pemakaian_alat_harian", "t_harian"), ("perubahan_status_alat", "t_transisi"), ("tindakan_penunjang_bersih", "t_tindakan"),
           ("rekonsiliasi_iot_klaim", "t_rekon"), ("temuan_iot", "t_temuan"), ("alat_iot", "t_alat"), ("ringkasan_iot_faskes", "t_ringkasan")]
GROUPS = [("iot", "Data IoT (meter listrik alat)", "#0ea5e9"), ("klaim", "Klaim tindakan penunjang", "#f97316"),
          ("referensi", "Referensi (ASPAK, ICD-9-CM, faskes, dokter)", "#64748b"), ("rekon", "Rekonsiliasi alat × klaim", "#ef4444"),
          ("ontologi", "Mendukung Ontologi", "#22c55e")]


def emulate(raw: dict[str, list[dict]], faskes: list[dict], dokter: list[dict]) -> dict[str, list[dict]]:
    import demo_jkn_pipeline as dp

    rows = dp.run({**raw, "faskes_audit": faskes, "dokter_audit": dokter}, nodes())
    return {name: rows[next(n["name"] for n in nodes() if n["id"] == node)] for name, node in OUTPUTS}


def content(items: dict[str, str], previews: dict[str, list[dict]], folder: str, uid, schedule) -> tuple[dict, dict[str, str]]:
    """Pipeline Builder content: the sources in Files, the SQL transforms by stage, outputs into iot/ with checks."""
    import demo_jkn_pipeline as dp

    now = datetime.now(timezone.utc).isoformat()
    ns = nodes()
    d = dp.deps(ns)
    depth: dict[str, int] = {}
    for n in dp.order(ns):
        depth[n["id"]] = 0 if not d[n["id"]] else 1 + max(depth[x] for x in d[n["id"]])
    cols: dict[int, list[str]] = {}
    for n in ns:
        cols.setdefault(depth[n["id"]], []).append(n["id"])
    pos = {nid: (60 + 340 * dep, 60 + 170 * i) for dep, ids in cols.items() for i, nid in enumerate(ids)}
    datasets, out_nodes = {}, []
    for n in ns:
        x, y = pos[n["id"]]
        base = {"id": n["id"], "name": n["name"], "x": x, "y": y, "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            where = "clean" if n["name"] in ("faskes_audit", "dokter_audit") else "raw / iot"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {PROJECT} / {where} / {n['name']}.parquet", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in dp.schema_of(rows)], "rows": rows[:200], "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            out_nodes.append({**base, "kind": "source", "datasetId": ds, "description": n["doc"]})
        else:
            out_nodes.append({**base, "kind": "transform", "input": n["input"], "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}],
                              **({"checkpoint": True} if n["id"] in ("t_status", "t_rekon") else {})})
    location = {"id": folder, "name": f"{PROJECT} / iot"}
    expect = {
        "daya_alat_bersih": [{"id": uid(), "kind": "notNull", "columns": ["id_meter", "ts", "daya_watt"]}, {"id": uid(), "kind": "rowCount", "min": 1000}],
        "sesi_alat": [{"id": uid(), "kind": "unique", "columns": ["id_sesi"]}],
        "perubahan_status_alat": [{"id": uid(), "kind": "unique", "columns": ["id_perubahan"]}, {"id": uid(), "kind": "notNull", "columns": ["processId", "state", "timestamp"]}],
        "pemakaian_alat_harian": [{"id": uid(), "kind": "unique", "columns": ["id_pemakaian"]}],
        "tindakan_penunjang_bersih": [{"id": uid(), "kind": "unique", "columns": ["id_baris"]}, {"id": uid(), "kind": "notNull", "columns": ["jenis_alat", "id_rekon"]}],
        "rekonsiliasi_iot_klaim": [{"id": uid(), "kind": "unique", "columns": ["id_rekon"]}],
        "temuan_iot": [{"id": uid(), "kind": "unique", "columns": ["id_temuan"]}, {"id": uid(), "kind": "notNull", "columns": ["penjelasan", "tingkat"]}],
        "alat_iot": [{"id": uid(), "kind": "unique", "columns": ["id_alat"]}],
        "ringkasan_iot_faskes": [{"id": uid(), "kind": "unique", "columns": ["kode"]}],
    }
    xmax = max(x for x, _ in pos.values())
    out_ids = {name: f"o_{node}" for name, node in OUTPUTS}
    outputs = [{"id": out_ids[name], "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": expect[name], "x": xmax + 340, "y": pos[node][1]} for name, node in OUTPUTS]
    text = [
        {"id": "note_iot_1", "x": 40, "y": -220, "w": 600, "h": 150, "color": "lg-iot",
         "text": "1 · SUMBER — meter listrik tiap alat (Rontgen, CT, USG, unit HD) lewat gateway IoT RS, tiap 2 menit; register alat ASPAK; "
                 "referensi ICD-9-CM → jenis alat; baris tindakan penunjang dari e-Klaim."},
        {"id": "note_iot_2", "x": 700, "y": -220, "w": 620, "h": 150, "color": "lg-iot",
         "text": "2 · PEMAKAIAN ALAT — bacaan dibersihkan (dedup gateway, glitch) → status per bacaan → siklus (sesi) → pemakaian harian & "
                 "estimasi tindakan: siklus/energi (Rontgen, CT), menit menyala (USG), menit-mesin (HD). daya_alat_bersih → time series sync."},
        {"id": "note_iot_3", "x": 1380, "y": -220, "w": 640, "h": 150, "color": "lg-rekon",
         "text": "3 · REKONSILIASI — klaim per faskes × jenis alat × hari vs estimasi alat: melebihi pemakaian, alat mati, tanpa alat terdaftar; "
                 "data meter < 90 % dan alat tanpa meter tidak disimpulkan fraud. Temuan, alat dan ringkasan faskes mendukung Ontologi."},
    ]
    body = {
        "type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": out_nodes, "outputs": outputs,
        "legend": [{"id": f"lg-{g}", "name": name, "hex": hexc} for g, name, hexc in GROUPS], "location": location, "textNodes": text,
        "schedules": [schedule(list(out_ids.values()))],
        "meta": {"version": 1, "description": "Demo: integrasi IoT — pemakaian listrik alat medis dicocokkan dengan klaim tindakan penunjang JKN."},
    }
    return body, out_ids


def sync_sql(pid: str) -> list[str]:
    """An existing pipeline's SQL transforms get the spec's current SQL (a logic change: the next build uses it)."""
    import json

    import drive
    import pipeline_datasets

    item = pipeline_datasets._pipeline_item(pid)
    content = json.loads(drive.read_bytes(item))
    want = {n["name"]: n["sql"] for n in nodes() if n["kind"] == "sql"}
    changed = []
    for n in content.get("nodes") or []:
        if n.get("kind") == "transform" and n.get("name") in want:
            step = next((st for st in n.get("steps") or [] if st.get("kind") == "sql"), None)
            if step and step["params"].get("query") != want[n["name"]]:
                step["params"]["query"] = want[n["name"]]
                changed.append(n["name"])
    if changed:
        content["updatedAt"] = datetime.now(timezone.utc).isoformat()
        pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=content))
    return changed


def _schedule(output_ids: list[str]) -> dict:
    return {"id": "jkn-iot-data", "name": "Bangun ulang saat data IoT / klaim berubah (demo)", "enabled": True,
            "enabledAt": datetime.now(timezone.utc).isoformat(), "target": "single", "outputs": output_ids,
            "trigger": {"id": "root", "kind": "or", "items": [{"id": "data", "kind": "data"}]}, "retries": {"count": 1, "delayMinutes": 5}}


# ------------------------------------------------------------------------------------------------
# the build (called by demo_jkn_e2e.build)
# ------------------------------------------------------------------------------------------------


def _types_and_links(fk: dict, dk: dict) -> dict:
    import demo_jkn_map as jm
    import ontology

    P = jm._p
    made = []
    alat = jm._type(ALAT)
    if not alat:
        alat = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=ALAT, plural_name=ALAT, api_name="AlatMedisIotJknDemo", primary_key="id_alat", title_property="nama_alat", icon="cpu", color="#14b8a6",
            description="Demo: alat kesehatan di faskes pilot dengan meter listrik IoT (objek sensor faskes). Time series 'Daya listrik' (W, tiap 2 "
                        "menit) dari gateway RS; estimasi tindakan per hari dari pola dayanya dicocokkan dengan klaim tindakan penunjang.",
            properties=[P("id_alat", "ID alat", render_hints=["searchable", "identifier"]), P("nama_alat", "Nama alat", render_hints=["searchable"]),
                        P("jenis_alat", "Jenis alat", render_hints=["searchable", "selectable"]), P("merek_model", "Merek / model"),
                        P("kode_faskes", "Faskes (kode)", render_hints=["searchable"]), P("nama_faskes", "Faskes", render_hints=["searchable", "selectable"]),
                        P("id_meter", "ID meter IoT", render_hints=["searchable"]), P("id_gateway", "Gateway IoT"),
                        P("seri_daya", "Daya listrik (time series)"), P("nama_sensor", "Nama sensor"), P("satuan", "Satuan"),
                        P("metode_estimasi", "Metode estimasi", render_hints=["selectable"]), P("daya_standby_w", "Daya standby / beban dasar (W)", "double"),
                        P("daya_aktif_w", "Daya saat tindakan / per mesin (W)", "double"), P("ambang_aktif_w", "Ambang tindakan (W)", "double"),
                        P("jumlah_mesin", "Jumlah mesin", "integer"), P("kapasitas_maks_harian", "Kapasitas maks (tindakan/hari)", "integer"),
                        P("lokasi", "Lokasi", "geopoint"), P("hari_data", "Hari dengan data", "integer"), P("kelengkapan_pct", "Kelengkapan data (%)", "double"),
                        P("siklus_total", "Siklus (14 hari)", "integer"), P("estimasi_tindakan_total", "Estimasi tindakan dari alat (14 hari)", "integer"),
                        P("kwh_total", "Energi (kWh, 14 hari)", "double"), P("klaim_total", "Tindakan diklaim (14 hari)", "integer"),
                        P("tak_didukung_total", "Tindakan tak didukung (14 hari)", "integer"), P("hari_temuan", "Hari dengan temuan", "integer"),
                        P("status_iot", "Status IoT", render_hints=["searchable", "selectable"]),
                        P("status_operasi", "Status operasi (Mati / Siaga / Tindakan)", render_hints=["selectable"]),
                        P("status_sejak", "Status sejak", "timestamp")]))
        made.append(ALAT)
    temuan = jm._type(TEMUAN)
    if not temuan:
        temuan = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=TEMUAN, plural_name=TEMUAN, api_name="TemuanIotJknDemo", primary_key="id_temuan", title_property="judul", icon="bolt", color="#f43f5e",
            description="Demo: satu faskes × jenis alat × hari yang klaim tindakannya tidak cocok dengan pemakaian alat menurut meter listrik IoT "
                        "(melebihi pemakaian, alat mati, tanpa alat terdaftar; data meter kurang dan alat tanpa meter diberi tingkat lebih rendah).",
            properties=[P("id_temuan", "ID temuan", render_hints=["searchable", "identifier"]), P("judul", "Judul", render_hints=["searchable"]),
                        P("label_singkat", "Label singkat"),
                        P("kode_faskes", "Faskes (kode)", render_hints=["searchable"]), P("nama_faskes", "Faskes", render_hints=["searchable", "selectable"]),
                        P("jenis_alat", "Jenis alat", render_hints=["selectable"]), P("tanggal", "Tanggal", "date"),
                        P("jenis_temuan", "Jenis temuan", render_hints=["searchable", "selectable"]), P("tingkat", "Tingkat", render_hints=["selectable"]),
                        P("klaim_tindakan", "Tindakan diklaim", "integer"), P("estimasi_tindakan_alat", "Estimasi tindakan dari alat", "integer"),
                        P("batas_toleransi", "Batas toleransi (estimasi × 1,1 + 1)", "integer"), P("siklus", "Siklus alat", "integer"),
                        P("menit_menyala", "Menit menyala", "integer"), P("mesin_menit", "Menit-mesin (HD)", "double"),
                        P("energi_aktif_kwh", "Energi aktif (kWh)", "double"), P("kelengkapan", "Kelengkapan data meter (0–1)", "double"),
                        P("tanpa_meter", "Alat sejenis tanpa meter", "integer"), P("alat_terkait", "Alat terkait"),
                        P("id_alat_utama", "Alat utama (ID)", render_hints=["searchable"]), P("kapasitas_maks", "Kapasitas maks (tindakan/hari)", "integer"),
                        P("tindakan_tak_didukung", "Tindakan tak didukung", "integer"), P("nilai_tak_didukung_rp", "Nilai tak didukung (Rp)", "double"),
                        P("nilai_klaim_rp", "Nilai klaim hari itu (Rp)", "double"), P("dokter_terbanyak", "Dokter pengaju terbanyak", render_hints=["searchable"]),
                        P("lokasi", "Lokasi faskes", "geopoint"), P("status_temuan", "Status verifikasi", render_hints=["searchable", "selectable"]),
                        P("penjelasan", "Penjelasan", render_hints=["long_text"])]))
        made.append(TEMUAN)
    tindakan = jm._type(TINDAKAN)
    if not tindakan:
        tindakan = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=TINDAKAN, plural_name=TINDAKAN, api_name="TindakanPenunjangJknDemo", primary_key="id_baris", title_property="judul", icon="doc",
            color="#fb923c",
            description="Demo: baris tindakan penunjang (Rontgen, CT, USG, hemodialisis) yang diklaim faskes pilot, dengan dokter pengaju dan kunci "
                        "rekonsiliasi ke pemakaian alat (id_rekon).",
            properties=[P("id_baris", "ID baris", render_hints=["searchable", "identifier"]), P("judul", "Judul", render_hints=["searchable"]),
                        P("no_sep", "No. SEP", render_hints=["searchable"]), P("tanggal", "Tanggal pelayanan", "date"),
                        P("kode_faskes", "Faskes (kode)", render_hints=["searchable"]), P("nama_faskes", "Faskes", render_hints=["selectable"]),
                        P("kode_icd9", "Kode ICD-9-CM", render_hints=["searchable"]), P("nama_tindakan", "Tindakan", render_hints=["selectable"]),
                        P("jenis_alat", "Jenis alat", render_hints=["selectable"]), P("id_dokter", "Dokter (ID)", render_hints=["searchable"]),
                        P("nama_dokter", "Dokter", render_hints=["searchable", "selectable"]), P("jenis_rawat", "Jenis rawat", render_hints=["selectable"]),
                        P("kelas_rawat", "Kelas rawat"), P("tarif_rs", "Tarif RS (Rp)", "double"), P("id_rekon", "Kunci rekonsiliasi", render_hints=["searchable"])]))
        made.append(TINDAKAN)
    links = {
        "alat": jm._link(L_ALAT, alat, "kode_faskes", fk, "Alat medis IoT", "Faskes"),
        "temuan_faskes": jm._link(L_TEMUAN_FASKES, temuan, "kode_faskes", fk, "Temuan IoT", "Faskes"),
        "temuan_alat": jm._link(L_TEMUAN_ALAT, temuan, "id_alat_utama", alat, "Temuan IoT", "Alat"),
        "tindakan": jm._link(L_TINDAKAN, tindakan, "id_rekon", temuan, "Tindakan diklaim", "Temuan IoT"),
        "dokter": jm._link(L_DOKTER, tindakan, "id_dokter", dk, "Tindakan penunjang", "Dokter pengaju"),
    }
    return {"alat": alat, "temuan": temuan, "tindakan": tindakan, "links": links, "made": made}


def _sensor(alat: dict, fk: dict, sync_id: str) -> Optional[str]:
    """The device type as a sensor object type of the facility: seri_daya becomes its default time series property."""
    import ontology
    import ts_ontology as tso

    rec = ontology._object_type(alat["id"])
    if ((rec.get("time_series") or {}).get("properties") or {}).get("seri_daya"):
        return None
    tso.add_tsp(alat["id"], tso.AddTsp(property="seri_daya", syncs=[sync_id], unit=tso.Formatting(value="W"),
                                       interpolation=tso.Formatting(value="LINEAR"), make_default=True,
                                       sensor=tso.SensorConfig(links=[tso.SensorLink(root_object_type_id=fk["id"], foreign_key="kode_faskes",
                                                                                     sensor_name_property="nama_sensor")])))
    return "seri_daya"


def _action(temuan: dict) -> Optional[str]:
    import demo_jkn_e2e as e
    import ontology

    if e._action(ACTION):
        return None
    with ontology._lock:
        rec = ontology._object_type(temuan["id"])
        for api, label, typ in (("catatan_verifikasi", "Catatan verifikasi", "string"), ("nilai_koreksi_rp", "Nilai koreksi klaim (Rp)", "double")):
            if not any(p["api_name"] == api for p in rec["properties"]):
                rec["properties"].append({"api_name": api, "display_name": label, "type": typ, "description": "Diisi lewat action tim audit."})
        ontology._put("object-types", rec)
    ontology.create_action_type(ontology.ActionTypeIn(
        display_name=ACTION, object_type_id=temuan["id"], kind="modify", status="active",
        description="Hasil verifikasi temuan IoT: 'Terkonfirmasi — klaim tidak didukung', 'Bukan fraud — alat cadangan / tanpa meter', "
                    "'Bukan fraud — gangguan meter', 'Klarifikasi ke faskes' atau 'Klaim dikoreksi', dengan catatan dan nilai koreksi.",
        parameters=[ontology.Parameter(id="object", display_name="Temuan IoT", type="object", required=True),
                    ontology.Parameter(id="status_temuan", display_name="Hasil verifikasi", type="string", property="status_temuan", required=True),
                    ontology.Parameter(id="catatan_verifikasi", display_name="Catatan (bukti yang diperiksa)", type="string", property="catatan_verifikasi", required=True),
                    ontology.Parameter(id="nilai_koreksi_rp", display_name="Nilai koreksi klaim (Rp)", type="double", property="nilai_koreksi_rp")]))
    return ACTION


def _vertex(fk: dict, dk: dict, t: dict, temuan_rows: list[dict], tindakan_rows: list[dict]) -> list[str]:
    import vertex

    lk = t["links"]
    layers = {
        fk["id"]: {"color": "#22c55e", "label_property": "nama", "column": 0,
                   "rules": [{"property": "status_audit", "op": "eq", "value": s, "color": c} for s, c in
                             (("Perlu Pemantauan", "#facc15"), ("Ada Indikasi Fraud", "#f97316"), ("Dalam Investigasi", "#ef4444"), ("Selesai Diaudit", "#a78bfa"))]},
        t["alat"]["id"]: {"color": "#14b8a6", "label_property": "nama_alat", "icon": "cpu", "column": 1,
                          "readout": {"property": "seri_daya", "stat": "max", "thresholds": [{"op": "gt", "value": 2000, "color": "#f59e0b"}]},
                          "rules": [{"property": "status_iot", "op": "eq", "value": "Ada temuan", "color": "#ef4444"},
                                    {"property": "status_iot", "op": "eq", "value": "Perlu verifikasi", "color": "#f59e0b"},
                                    {"property": "status_iot", "op": "eq", "value": "Tanpa meter", "color": "#64748b"}]},
        t["temuan"]["id"]: {"color": "#f43f5e", "label_property": "label_singkat", "icon": "bolt", "column": 2, "size_property": "tindakan_tak_didukung",
                            "rules": [{"property": "tingkat", "op": "eq", "value": "Sedang", "color": "#f59e0b"},
                                      {"property": "tingkat", "op": "eq", "value": "Info", "color": "#64748b"}]},
        dk["id"]: {"color": "#38bdf8", "label_property": "nama", "column": 3},
    }
    graphs = {g["name"] for g in vertex.list_graphs()}
    made = []
    # findings labelled by their short label ("Rontgen 15/09 · +12"): the title was cut to "RSUD Contoh Sejahtera · …"
    for g in vertex.list_graphs():
        if g["name"] in (G_IOT, G_IOT_TEMPLATE):
            full = vertex.get_graph(g["id"])
            layer = (full.get("layers") or {}).get(t["temuan"]["id"]) or {}
            if layer and layer.get("label_property") != "label_singkat":
                full["layers"][t["temuan"]["id"]] = {**layer, "label_property": "label_singkat"}
                vertex.save_graph(g["id"], vertex.GraphIn(**{k: full[k] for k in vertex.GraphIn.model_fields if k in full}))
                made.append(f"{g['name']}: label singkat")
    if G_IOT not in graphs:
        keep = [r for r in temuan_rows if r["tingkat"] != "Info" or r["kode_faskes"] == "RS-123"]
        nodes = [{"object_type_id": fk["id"], "primary_key": k} for k in sorted({d[1] for d in DEVICES})]
        nodes += [{"object_type_id": t["alat"]["id"], "primary_key": d[0]} for d in DEVICES]
        nodes += [{"object_type_id": t["temuan"]["id"], "primary_key": r["id_temuan"]} for r in keep]
        ids = {r["id_temuan"] for r in keep}
        nodes += [{"object_type_id": dk["id"], "primary_key": d} for d in sorted({r["id_dokter"] for r in tindakan_rows if r["id_rekon"] in ids and r.get("id_dokter")})]
        vertex.create_graph(vertex.GraphIn(
            name=G_IOT, layout="flow", layers=layers, nodes=nodes, line_type="curved",
            edge_styles={lk["alat"]["id"]: {"color": "#14b8a6"}, lk["temuan_alat"]["id"]: {"color": "#f43f5e"}},
            edge_groups=[{"id": "tindakan", "name": "Tindakan diklaim", "object_type_id": t["tindakan"]["id"], "links": [lk["tindakan"]["id"], lk["dokter"]["id"]],
                          "label": "count", "width": "sum:tarif_rs", "format": "juta"}],
            description="Demo: pilot IoT di 6 faskes — faskes → alat medis bermeter (readout daya maksimum) → temuan per hari (merah: klaim tidak didukung "
                        "pemakaian alat; kuning: perlu verifikasi; abu-abu: data meter kurang) → dokter yang mengajukan tindakannya (panah = jumlah "
                        "tindakan, tebal = nilai). Klik temuan untuk penjelasannya, alat untuk grafik dayanya."))
        made.append(G_IOT)
    if G_IOT_TEMPLATE not in graphs:
        chains = [[(lk["temuan_alat"]["id"], "forward")], [(lk["temuan_faskes"]["id"], "forward")], [(lk["tindakan"]["id"], "reverse")],
                  [(lk["tindakan"]["id"], "reverse"), (lk["dokter"]["id"], "forward")]]
        vertex.create_graph(vertex.GraphIn(
            name=G_IOT_TEMPLATE, layout="flow", layers=layers, line_type="curved",
            description="Demo: pilih temuan IoT → alat (dengan time series daya), faskes, tindakan yang diklaim, dan dokter pengajunya.",
            template={"parameters": [{"id": "temuan", "name": "Temuan IoT", "object_type_id": t["temuan"]["id"],
                                      "search_arounds": [{"steps": [{"link_type_id": x, "direction": dr} for x, dr in ch]} for ch in chains]}]}))
        made.append(G_IOT_TEMPLATE)
    return made


def _map_layers(t: dict) -> list[str]:
    import demo_jkn_map as jm
    import geospatial

    m = next((x for x in geospatial.list_maps() if x.get("name") == jm.MAP), None)
    if not m:
        return []
    pilot = {"property": "tier", "op": "eq", "value": "Telemetri penuh"}
    mine = [layer for layer in m.get("layers") or [] if (layer.get("config") or {}).get("object_type_id") == t["alat"]["id"]]
    if mine:
        # the audit map shows the pilot's devices only (the device type covers the national network since the national layer)
        if all(pilot in ((layer.get("config") or {}).get("filters") or []) for layer in mine):
            return []
        rec = geospatial.get_map(m["id"])
        layers = []
        for layer in rec.get("layers") or []:
            c = dict(layer.get("config") or {})
            if c.get("object_type_id") == t["alat"]["id"] and pilot not in (c.get("filters") or []):
                c["filters"] = [*(c.get("filters") or []), pilot]
            layers.append(geospatial.Layer(**{**layer, "config": c}))
        geospatial.save_map(m["id"], geospatial.MapIn(name=rec["name"], basemap=rec.get("basemap") or "streets", view=rec.get("view"), layers=layers,
                                                      description=rec.get("description") or ""))
        return ["pilot filter on the device layers"]
    rec = geospatial.get_map(m["id"])
    new = [
        geospatial.Layer(name="Alat medis IoT — klaim tidak didukung", kind="objects", color="#e11d48", opacity=1.0,
                         config={"object_type_id": t["alat"]["id"], "property": "lokasi", "filters": [{"property": "status_iot", "op": "eq", "value": "Ada temuan"},
                                                                                                         {"property": "tier", "op": "eq", "value": "Telemetri penuh"}]}),
        geospatial.Layer(name="Alat medis IoT — perlu verifikasi / data kurang", kind="objects", color="#f59e0b", opacity=1.0,
                         config={"object_type_id": t["alat"]["id"], "property": "lokasi",
                                 "filters": [{"property": "status_iot", "op": "in", "value": ["Perlu verifikasi", "Data meter tidak lengkap", "Tanpa meter"]},
                                             {"property": "tier", "op": "eq", "value": "Telemetri penuh"}]}),
        geospatial.Layer(name="Alat medis IoT — sesuai klaim", kind="objects", color="#14b8a6", opacity=1.0,
                         config={"object_type_id": t["alat"]["id"], "property": "lokasi", "filters": [{"property": "status_iot", "op": "eq", "value": "Sesuai"},
                                                                                                         {"property": "tier", "op": "eq", "value": "Telemetri penuh"}]}),
    ]
    geospatial.save_map(m["id"], geospatial.MapIn(
        name=rec["name"], basemap=rec.get("basemap") or "streets", view=rec.get("view"), layers=[*new, *(geospatial.Layer(**x) for x in rec.get("layers") or [])],
        description=(rec.get("description") or "") + " Titik kecil di sekitar RS = alat medis bermeter IoT (merah: klaim tindakan tidak didukung "
                    "pemakaian alat; kuning: perlu verifikasi / data kurang; hijau toska: sesuai)."))
    return [x.name for x in new]


MACHINERY = "Device and Machinery — alat medis JKN (demo)"
VERDICTS = ["Baru", "Klarifikasi ke faskes", "Terkonfirmasi — klaim tidak didukung", "Klaim dikoreksi", "Bukan fraud — alat cadangan / tanpa meter",
            "Bukan fraud — gangguan meter"]
# the decisions the demo starts with (the audit team takes the others in the workspace)
DECISIONS = [
    ("IOT-RS-01-RONTGEN-2026-09-15", "Klarifikasi ke faskes", "Surat klarifikasi ke RSUD Contoh Sejahtera: minta log RIS/PACS Rontgen 15 Sep.", None),
    ("IOT-RS-01-RONTGEN-2026-09-15", "Terkonfirmasi — klaim tidak didukung",
     "Log PACS hanya berisi 7 studi pasien + 1 eksposur QC; 13 dari 20 klaim tanpa citra. Klaim dikoreksi 13 tindakan.", 2_040_000.0),
    ("IOT-RS-123-CTSCAN-2026-09-22", "Bukan fraud — gangguan meter", "Gateway IoT RS Permata Raya mati 22–23 Sep (tiket IT #4471); log CT normal.", None),
    ("IOT-RS-123-RONTGEN-2026-09-16", "Bukan fraud — alat cadangan / tanpa meter", "Selisih dikerjakan Rontgen mobile di bangsal; log alat mobile cocok.", None),
]


def _machinery(t: dict, changelog_id: str) -> Optional[str]:
    """Device and Machinery: the devices' operating states mined from the IoT changelog, and the verification of findings
    (kept from the action's edits)."""
    import demo_jkn_e2e as e
    import machinery as mc

    have = next((r for r in mc._all() if r["name"] == MACHINERY), None)
    if have:
        # a finding's log starts at its first decision (its "Baru" came from the dataset): any state may follow the start
        ver = next((p for p in have["processes"] if p["state_property"] == "status_temuan"), None)
        starts = {tr["to"] for tr in (ver or {}).get("transitions") or [] if tr.get("from") == mc.START}
        if ver and set(VERDICTS) - starts:
            ver["transitions"] += [{"from": mc.START, "to": v} for v in VERDICTS if v not in starts]
            mc.save_resource(have["id"], mc.MachineryIn(name=have["name"], description=have.get("description") or "", auto_layout=False,
                                                        processes=[mc.ProcessIn(**p) for p in have["processes"]]))
        return None
    act = e._action(ACTION)
    op = ["Mati", "Siaga", "Tindakan"]
    pos = {"Mati": (80, 160), "Siaga": (340, 60), "Tindakan": (600, 160)}
    alat = mc.ProcessIn(name="Status operasi alat medis", object_type_id=t["alat"]["id"], state_property="status_operasi",
                        states=[{"id": x, "label": x, "x": pos[x][0], "y": pos[x][1]} for x in op],
                        transitions=[{"from": mc.START, "to": "Mati"}, {"from": "Mati", "to": "Siaga"}, {"from": "Siaga", "to": "Tindakan"},
                                     {"from": "Tindakan", "to": "Siaga"}, {"from": "Siaga", "to": "Mati"}, {"from": "Mati", "to": "Tindakan"},
                                     {"from": "Tindakan", "to": "Mati"}])
    vpos = {v: (80 + 260 * (i % 3), 60 + 150 * (i // 3)) for i, v in enumerate(VERDICTS)}
    final = VERDICTS[2:]
    ver = mc.ProcessIn(name="Verifikasi temuan IoT", object_type_id=t["temuan"]["id"], state_property="status_temuan",
                       states=[{"id": v, "label": v, "x": vpos[v][0], "y": vpos[v][1]} for v in VERDICTS],
                       transitions=[*({"from": mc.START, "to": v} for v in VERDICTS), *({"from": "Baru", "to": v} for v in VERDICTS[1:]),
                                    *({"from": "Klarifikasi ke faskes", "to": v} for v in final),
                                    {"from": "Terkonfirmasi — klaim tidak didukung", "to": "Klaim dikoreksi"}],
                       actions=[{"action_type_id": act["id"], "inputs": ["Baru", "Klarifikasi ke faskes", "Terkonfirmasi — klaim tidak didukung"],
                                 "outputs": VERDICTS[1:], "automation": False}] if act else [])
    rec = mc.create_resource(mc.MachineryIn(name=MACHINERY, auto_layout=False, processes=[alat, ver],
                                   description="Demo: alat medis bermeter IoT sebagai mesin — status Mati / Siaga / Tindakan dari daya listrik (changelog "
                                               "pipeline IoT), jalur dan durasinya; dan alur verifikasi temuan IoT dari action tim audit."))
    mc.setup_log(rec["id"], alat.id, mc.LogSetupIn(changelog_dataset_id=changelog_id, from_edits=False))
    mc.setup_log(rec["id"], ver.id, mc.LogSetupIn(from_edits=True))
    return rec["id"]


def _seed(state: dict, save) -> Optional[list[str]]:
    import demo_jkn_e2e as e
    import ontology

    if state.get("iot_decisions_seeded"):
        return None
    a = e._action(ACTION)
    if not a:
        return None
    done = []
    for pk, verdict, note, koreksi in DECISIONS:
        values = {"object": pk, "status_temuan": verdict, "catatan_verifikasi": note, **({"nilai_koreksi_rp": koreksi} if koreksi else {})}
        hook = ontology.MODEL_HOOKS.get("apply_action")
        try:
            hook(a, values) if hook else ontology.run_action(a, values, source="demo-jkn-iot")
            done.append(f"{pk} → {verdict}")
        except Exception as ex:  # noqa: BLE001 - a planted finding the data no longer produces
            done.append(f"{pk}: {getattr(ex, 'detail', ex)}")
    state["iot_decisions_seeded"] = datetime.now(timezone.utc).isoformat()
    save()
    return done


def build(state: dict, save) -> dict:
    """Files → Pipeline Builder (first build emulated with the same SQL) → time series sync → sensor object type, findings,
    claim lines, links, the facility's iot_* properties, the verification action, edit history → Vertex and the map."""
    import uuid

    import demo_jkn_e2e as e
    import demo_jkn_map as jm
    import demo_jkn_pipeline as dp
    import drive
    import ontology
    import ontology_edits
    import ontology_mdo
    import pipeline_datasets
    import pipeline_runtime as rt
    import timeseries

    out: dict = {}
    project = e._folder(None, PROJECT, "project")
    raw_folder = e._folder(e._folder(project, "raw"), "iot")
    folder = e._folder(project, "iot")
    core = e.run_sql()
    doctors: dict[str, list[dict]] = {}
    for d in core["dokter_audit"]:
        doctors.setdefault(d["faskes_utama"], []).append(d)
    raw, truth = generate(doctors)
    out["raw_rows"] = {k: len(v) for k, v in raw.items()}
    raw_ids = {name: e._put(raw_folder, name, e._arrow(rows, dp.schema_of(rows)), replace=False) for name, rows in raw.items()}
    clean = e._folder(project, "clean")

    def item(f: str, name: str) -> str:
        return next(x["id"] for x in drive.list_files(f) if x["name"] == f"{name}.parquet" and not x.get("trashed_at"))

    items = {**raw_ids, "faskes_audit": item(clean, "faskes_audit"), "dokter_audit": item(clean, "dokter_audit")}
    results = emulate(raw, core["faskes_audit"], core["dokter_audit"])
    ids = {name: e._put(folder, name, e._arrow(rows, dp.schema_of(rows)), replace=False) for name, rows in results.items()}
    out["rows"] = {k: len(v) for k, v in results.items()}
    # -- Pipeline Builder ---------------------------------------------------------------------------------------
    pid = state.get("iot_pipeline_id")
    if not pid:
        body, out_ids = content(items, {**raw, "faskes_audit": core["faskes_audit"], "dokter_audit": core["dokter_audit"]}, folder,
                                lambda: uuid.uuid4().hex[:8], _schedule)
        made = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=project, content=body))
        pid = made["id"]
        for name, oid in out_ids.items():
            rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": folder, "version": 0, "rows": len(results[name]),
                                                "path": f"{PROJECT} / iot / {name}.parquet"})
        state["iot_pipeline_id"] = pid
        save()
    else:
        out["sql_updated"] = sync_sql(pid)
    out["pipeline_id"] = pid
    # -- the time series sync: the clean readings, one series per meter ------------------------------------------
    sync = next((s for s in timeseries.all_syncs("timeseries") if s.get("name") == SYNC), None)
    if not sync:
        sync = timeseries.create_catalog_sync(timeseries.CatalogSyncIn(
            name=SYNC, dataset_id=ids["daya_alat_bersih"], description="Demo: daya listrik alat medis (W) per 2 menit dari meter IoT faskes pilot JKN.",
            mapping=timeseries.Mapping(series_id="id_meter", timestamp="ts", value="daya_watt", timestamp_unit="SECONDS")))
    state["iot_sync_id"] = sync["id"]
    save()
    out["sync_id"] = sync["id"]
    # -- the Ontology --------------------------------------------------------------------------------------------
    fk, dk = jm._type(jm.FASKES), jm._type(jm.DOKTER)
    t = _types_and_links(fk, dk)
    out["made"] = t["made"]
    # once the national layer backs the device and finding types with the whole network, they stay on it
    national = {ALAT: "alat_iot_semua.parquet", TEMUAN: "temuan_iot_semua.parquet"}
    out["attached"] = [e._attach(name, ids[ds]) for name, ds in ((ALAT, "alat_iot"), (TEMUAN, "temuan_iot"), (TINDAKAN, "tindakan_penunjang_bersih"))
                       if (ontology._object_type(jm._type(name)["id"]).get("backing_dataset") or {}).get("name") != national.get(name)]
    out["sensor"] = _sensor(ontology._object_type(t["alat"]["id"]), fk, sync["id"])
    if not any(d["dataset_id"] == ids["ringkasan_iot_faskes"] for d in ontology._object_type(fk["id"]).get("additional_datasources") or []):
        ontology_mdo.add_datasource(fk["id"], ontology_mdo.ExtraIn(dataset_id=ids["ringkasan_iot_faskes"], pk_column="kode", columns={
            c: c for c in ("iot_alat_terpasang", "iot_alat_bermeter", "iot_hari_temuan", "iot_tindakan_tak_didukung", "iot_nilai_tak_didukung_rp",
                           "iot_status", "iot_alat_bermasalah")}))
        out["faskes_iot_properties"] = True
    out["action"] = _action(t["temuan"])
    if not ontology_edits.config(ontology._object_type(t["temuan"]["id"]))["history"]:
        ontology_edits.set_config(t["temuan"]["id"], ontology_edits.EditsConfigIn(history=True))
    out["decisions"] = _seed(state, save)
    out["machinery"] = _machinery(t, ids["perubahan_status_alat"])
    out["vertex"] = _vertex(fk, dk, t, results["temuan_iot"], results["tindakan_penunjang_bersih"])
    out["map"] = _map_layers(t)
    tinggi = [r for r in results["temuan_iot"] if r["tingkat"] == "Tinggi"]
    out["temuan"] = {"total": len(results["temuan_iot"]), "tinggi": len(tinggi), "tak_didukung": sum(r["tindakan_tak_didukung"] for r in tinggi),
                     "nilai_rp": sum(r["nilai_tak_didukung_rp"] for r in tinggi)}
    return out
