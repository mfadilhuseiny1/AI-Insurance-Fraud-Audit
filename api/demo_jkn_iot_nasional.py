"""IoT at national scale for the JKN demo: every connected hospital in Indonesia, monitored region by region.

The pilot (demo_jkn_iot.py) sends 2-minute readings from 16 devices. At national scale (≈ 2,800 JKN hospitals, tens of
thousands of devices) that is tens of millions of rows a day, so the gateway in each hospital computes the pilot
pipeline's per-device metrics itself — readings received, exposure cycles, active energy, powered-on minutes,
machine-minutes, first and last hour on — and sends one row per device per day ("ringkasan edge"). The full readings
stay in the gateway's archive and are pulled only when an auditor opens a finding. The pilot keeps full telemetry
("Telemetri penuh") and is part of the network: the national pipeline reads the pilot pipeline's outputs.

Simulated network (data fiktif; region names real, hospitals and numbers invented): 38 provinces, ≈ 85 cities and
regencies, ≈ 450 hospitals with their ASPAK devices, 13 regional offices (an example split), rollout coverage that is
higher in Java and Bali than in the east, and the patterns a national programme would meet: phantom procedures in a
few hospitals, devices out of order while claims go on, procedures for a device type the hospital does not have,
gateway outages (data incomplete — not evidence), unmetered backup devices (to verify), and two regional hotspots
where several hospitals of one regency show the same pattern.

Pipeline Builder "Pipeline IoT jejaring nasional JKN (demo)": devices with parameters → daily use (edge summaries
+ the pilot's daily use) → daily claims per hospital × device type (e-Klaim warehouse) → reconciliation (same rules
as the pilot; the pilot's rows joined in) → findings, devices, hospitals with an IoT risk score and monitoring
status, regions (city/regency → province → regional office → national) with hotspots, and daily trends. A time series
sync makes each device's daily estimated procedures a time series property.

Ontology: Wilayah JKN (demo) (the hierarchy), RS Jejaring IoT JKN (demo) (hospital, linked to its city/regency and,
for the pilot, to Faskes Audit), and the pilot's Alat Medis IoT / Temuan IoT types now backed by the whole network.
"""

from __future__ import annotations

import functools
import random
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

import demo_jkn_iot as iot

PROJECT = iot.PROJECT
PIPELINE = "Pipeline IoT jejaring nasional JKN (demo)"
SYNC = "Pemakaian harian alat jejaring JKN (demo)"
WILAYAH = "Wilayah JKN (demo)"
RS = "RS Jejaring IoT JKN (demo)"
ACTION = "Tetapkan status pemantauan RS (demo)"
L_INDUK = "Wilayah induk (demo)"
L_RS_WILAYAH = "RS di kabupaten/kota (demo)"
L_RS_FASKES = "RS jejaring = faskes audit (demo)"
L_ALAT_RS = "Alat di RS jejaring (demo)"
L_TEMUAN_RS = "Temuan IoT di RS jejaring (demo)"
L_TEMUAN_WILAYAH = "Temuan IoT di kabupaten/kota (demo)"
MAP = "Demo: Pantauan IoT RS nasional JKN"
G_HOTSPOT = "Demo: Hotspot IoT nasional JKN"
SEED = 2026
TIER_PILOT, TIER_EDGE = "Telemetri penuh", "Ringkasan edge"

# (province, regional office, [(city / regency, lat, lon, weight 1–3)])
PROVINSI: list[tuple[str, str, list[tuple[str, float, float, int]]]] = [
    ("Aceh", "KW I", [("Kota Banda Aceh", 5.55, 95.32, 2), ("Kota Lhokseumawe", 5.18, 97.15, 1)]),
    ("Sumatera Utara", "KW I", [("Kota Medan", 3.59, 98.67, 3), ("Kota Pematangsiantar", 2.96, 99.06, 1), ("Kab. Deli Serdang", 3.55, 98.87, 2)]),
    ("Sumatera Barat", "KW II", [("Kota Padang", -0.95, 100.35, 2), ("Kota Bukittinggi", -0.31, 100.37, 1)]),
    ("Riau", "KW II", [("Kota Pekanbaru", 0.51, 101.45, 2), ("Kota Dumai", 1.67, 101.45, 1)]),
    ("Kepulauan Riau", "KW II", [("Kota Batam", 1.13, 104.05, 2), ("Kota Tanjungpinang", 0.92, 104.45, 1)]),
    ("Jambi", "KW III", [("Kota Jambi", -1.61, 103.61, 2)]),
    ("Sumatera Selatan", "KW III", [("Kota Palembang", -2.99, 104.76, 3), ("Kota Lubuklinggau", -3.30, 102.86, 1)]),
    ("Kepulauan Bangka Belitung", "KW III", [("Kota Pangkalpinang", -2.13, 106.11, 1)]),
    ("Bengkulu", "KW III", [("Kota Bengkulu", -3.80, 102.27, 1)]),
    ("Lampung", "KW III", [("Kota Bandar Lampung", -5.43, 105.26, 2), ("Kota Metro", -5.11, 105.31, 1)]),
    ("DKI Jakarta", "KW IV", [("Kota Jakarta Pusat", -6.19, 106.83, 3), ("Kota Jakarta Selatan", -6.26, 106.81, 3), ("Kota Jakarta Timur", -6.23, 106.90, 3),
                              ("Kota Jakarta Barat", -6.17, 106.76, 2), ("Kota Jakarta Utara", -6.14, 106.88, 2)]),
    ("Banten", "KW V", [("Kota Serang", -6.12, 106.15, 1), ("Kota Tangerang", -6.18, 106.63, 2), ("Kota Tangerang Selatan", -6.29, 106.72, 2), ("Kota Cilegon", -6.00, 106.05, 1)]),
    ("Jawa Barat", "KW V", [("Kota Bandung", -6.91, 107.61, 3), ("Kota Bekasi", -6.24, 106.99, 3), ("Kota Bogor", -6.60, 106.80, 2), ("Kota Depok", -6.40, 106.82, 2),
                            ("Kota Cirebon", -6.73, 108.55, 2), ("Kota Tasikmalaya", -7.33, 108.22, 1), ("Kota Sukabumi", -6.92, 106.93, 1), ("Kab. Karawang", -6.31, 107.30, 1),
                            ("Kab. Garut", -7.22, 107.90, 1)]),
    ("Jawa Tengah", "KW VI", [("Kota Semarang", -6.99, 110.42, 3), ("Kota Surakarta", -7.57, 110.82, 2), ("Kota Tegal", -6.87, 109.14, 1), ("Kota Pekalongan", -6.89, 109.68, 1),
                              ("Kota Magelang", -7.47, 110.22, 1), ("Kab. Banyumas", -7.42, 109.24, 2), ("Kab. Kudus", -6.80, 110.84, 1)]),
    ("DI Yogyakarta", "KW VI", [("Kota Yogyakarta", -7.80, 110.37, 2), ("Kab. Sleman", -7.72, 110.36, 2)]),
    ("Jawa Timur", "KW VII", [("Kota Surabaya", -7.25, 112.75, 3), ("Kota Malang", -7.98, 112.63, 2), ("Kab. Sidoarjo", -7.45, 112.72, 2), ("Kota Kediri", -7.82, 112.01, 1),
                              ("Kab. Jember", -8.17, 113.70, 2), ("Kota Madiun", -7.63, 111.52, 1), ("Kab. Banyuwangi", -8.22, 114.37, 1), ("Kab. Gresik", -7.16, 112.65, 1)]),
    ("Bali", "KW VIII", [("Kota Denpasar", -8.65, 115.22, 2), ("Kab. Badung", -8.58, 115.18, 1), ("Kab. Buleleng", -8.11, 115.09, 1)]),
    ("Nusa Tenggara Barat", "KW VIII", [("Kota Mataram", -8.58, 116.12, 2), ("Kota Bima", -8.46, 118.73, 1)]),
    ("Nusa Tenggara Timur", "KW VIII", [("Kota Kupang", -10.18, 123.61, 2), ("Kab. Ende", -8.84, 121.66, 1)]),
    ("Kalimantan Barat", "KW IX", [("Kota Pontianak", -0.03, 109.33, 2), ("Kota Singkawang", 0.91, 108.98, 1)]),
    ("Kalimantan Tengah", "KW IX", [("Kota Palangka Raya", -2.21, 113.92, 1)]),
    ("Kalimantan Selatan", "KW IX", [("Kota Banjarmasin", -3.32, 114.59, 2), ("Kota Banjarbaru", -3.44, 114.83, 1)]),
    ("Kalimantan Timur", "KW X", [("Kota Samarinda", -0.50, 117.15, 2), ("Kota Balikpapan", -1.27, 116.83, 2)]),
    ("Kalimantan Utara", "KW X", [("Kota Tarakan", 3.30, 117.63, 1), ("Kab. Bulungan", 2.84, 117.37, 1)]),
    ("Sulawesi Utara", "KW XI", [("Kota Manado", 1.47, 124.84, 2), ("Kota Bitung", 1.44, 125.19, 1)]),
    ("Gorontalo", "KW XI", [("Kota Gorontalo", 0.54, 123.06, 1)]),
    ("Sulawesi Tengah", "KW XI", [("Kota Palu", -0.90, 119.87, 1)]),
    ("Sulawesi Barat", "KW XI", [("Kab. Mamuju", -2.68, 118.89, 1)]),
    ("Sulawesi Selatan", "KW XII", [("Kota Makassar", -5.14, 119.42, 3), ("Kota Parepare", -4.01, 119.62, 1), ("Kab. Gowa", -5.31, 119.74, 2), ("Kab. Bone", -4.54, 120.33, 1)]),
    ("Sulawesi Tenggara", "KW XII", [("Kota Kendari", -3.99, 122.51, 1), ("Kota Baubau", -5.47, 122.60, 1)]),
    ("Maluku", "KW XIII", [("Kota Ambon", -3.70, 128.17, 1)]),
    ("Maluku Utara", "KW XIII", [("Kota Ternate", 0.79, 127.38, 1), ("Kota Tidore Kepulauan (Sofifi)", 0.74, 127.56, 1)]),
    ("Papua", "KW XIII", [("Kota Jayapura", -2.53, 140.72, 1)]),
    ("Papua Barat", "KW XIII", [("Kab. Manokwari", -0.86, 134.08, 1)]),
    ("Papua Barat Daya", "KW XIII", [("Kota Sorong", -0.88, 131.25, 1)]),
    ("Papua Tengah", "KW XIII", [("Kab. Nabire", -3.37, 135.50, 1), ("Kab. Mimika", -4.55, 136.89, 1)]),
    ("Papua Pegunungan", "KW XIII", [("Kab. Jayawijaya", -4.10, 138.95, 1)]),
    ("Papua Selatan", "KW XIII", [("Kab. Merauke", -8.49, 140.40, 1)]),
]
KW_NAMA = {"KW I": "Kedeputian Wilayah I", "KW II": "Kedeputian Wilayah II", "KW III": "Kedeputian Wilayah III", "KW IV": "Kedeputian Wilayah IV",
           "KW V": "Kedeputian Wilayah V", "KW VI": "Kedeputian Wilayah VI", "KW VII": "Kedeputian Wilayah VII", "KW VIII": "Kedeputian Wilayah VIII",
           "KW IX": "Kedeputian Wilayah IX", "KW X": "Kedeputian Wilayah X", "KW XI": "Kedeputian Wilayah XI", "KW XII": "Kedeputian Wilayah XII",
           "KW XIII": "Kedeputian Wilayah XIII"}
# rollout: the share of hospitals connected, by region (Java and Bali first)
CAKUPAN = {"KW IV": 0.95, "KW V": 0.85, "KW VI": 0.9, "KW VII": 0.85, "KW VIII": 0.7, "KW I": 0.75, "KW II": 0.7, "KW III": 0.65, "KW IX": 0.6, "KW X": 0.65,
           "KW XI": 0.55, "KW XII": 0.7, "KW XIII": 0.4}
HOTSPOTS = {"Kab. Banyumas": "Hemodialisis", "Kab. Gowa": "CT Scan"}
CODE = {"Rontgen": "RO", "CT Scan": "CT", "USG": "US", "Hemodialisis": "HD"}
NAMA_RS = ["Husada", "Medika", "Mitra Sehat", "Bakti", "Permata", "Sentosa", "Harapan", "Amanah", "Sejahtera", "Mulia", "Citra", "Bunda", "Kasih", "Prima",
           "Insani", "Utama", "Pelita", "Cahaya", "Anugerah", "Sehati"]
DEPAN = ["Andi", "Budi", "Citra", "Dewi", "Eko", "Fajar", "Gita", "Hendra", "Indah", "Joko", "Kartika", "Lukman", "Maya", "Nanda", "Oki", "Putri", "Rizal",
         "Sari", "Taufik", "Wulan", "Yoga", "Zahra"]
BELAKANG = ["Pratama", "Santoso", "Wijaya", "Lestari", "Nugroho", "Rahayu", "Saputra", "Kusuma", "Hidayat", "Permana", "Utami", "Siregar", "Harahap",
            "Tanjung", "Simatupang", "Pangaribuan", "Latuconsina", "Wenda", "Mandagi", "Daeng"]
SPESIALIS = ["Sp.Rad", "Sp.PD", "Sp.OG", "Sp.B", "Sp.JP", "Sp.PD-KGH", "Sp.A"]


def days() -> list[date]:
    return iot._days()


# ------------------------------------------------------------------------------------------------
# the simulated network
# ------------------------------------------------------------------------------------------------


def _kelas_devices(rnd: random.Random, kelas: str) -> list[tuple[str, int]]:
    """(device type, machines) a hospital of this class has."""
    if kelas == "A":
        return [("Rontgen", 1)] * 3 + [("CT Scan", 1)] * 2 + [("USG", 1)] * 3 + [("Hemodialisis", rnd.randint(8, 12))]
    if kelas == "B":
        return [("Rontgen", 1)] * 2 + [("CT Scan", 1)] + [("USG", 1)] * 2 + [("Hemodialisis", rnd.randint(5, 7))]
    if kelas == "C":
        out = [("Rontgen", 1), ("USG", 1)] + ([("USG", 1)] if rnd.random() < 0.4 else [])
        if rnd.random() < 0.5:
            out.append(("CT Scan", 1))
        if rnd.random() < 0.6:
            out.append(("Hemodialisis", rnd.randint(3, 5)))
        return out
    out = [("Rontgen", 1), ("USG", 1)]
    if rnd.random() < 0.2:
        out.append(("Hemodialisis", rnd.randint(2, 3)))
    return out


@functools.lru_cache(maxsize=1)
def world() -> dict:
    """The regions, hospitals (with their devices, doctors and scenarios) — the same every time (seeded)."""
    import demo_jkn_e2e as e

    rnd = random.Random(SEED)
    wilayah: list[dict] = [{"id_wilayah": "ID", "nama": "Indonesia", "tingkat": "Nasional", "urutan_tingkat": 0, "induk": None, "lokasi": "-2.5,118.0"}]
    kw_pts: dict[str, list[tuple[float, float]]] = {}
    cities: list[dict] = []
    for pi, (prov, kw, kabs) in enumerate(PROVINSI, 1):
        pid = f"P-{pi:02d}"
        lat = sum(k[1] for k in kabs) / len(kabs)
        lon = sum(k[2] for k in kabs) / len(kabs)
        wilayah.append({"id_wilayah": pid, "nama": f"Provinsi {prov}", "tingkat": "Provinsi", "urutan_tingkat": 2, "induk": kw.replace(" ", "-"),
                        "lokasi": f"{lat:.4f},{lon:.4f}"})
        kw_pts.setdefault(kw, []).append((lat, lon))
        for ci, (kab, la, lo, w) in enumerate(kabs, 1):
            kid = f"K-{pi:02d}{ci:02d}"
            wilayah.append({"id_wilayah": kid, "nama": kab, "tingkat": "Kabupaten/Kota", "urutan_tingkat": 3, "induk": pid, "lokasi": f"{la:.4f},{lo:.4f}"})
            cities.append({"id": kid, "nama": kab, "lat": la, "lon": lo, "w": w, "prov": prov, "pid": pid, "kw": kw})
    for kw, pts in kw_pts.items():
        wilayah.append({"id_wilayah": kw.replace(" ", "-"), "nama": KW_NAMA[kw], "tingkat": "Kedeputian Wilayah", "urutan_tingkat": 1, "induk": "ID",
                        "lokasi": f"{sum(p[0] for p in pts) / len(pts):.4f},{sum(p[1] for p in pts) / len(pts):.4f}"})
    # the pilot's hospitals, in the cities nearest to them
    core = e.run_sql()
    fk = {f["kode"]: f for f in core["faskes_audit"]}
    pilot_codes = sorted({d[1] for d in iot.DEVICES})
    hospitals: list[dict] = []
    for kode in pilot_codes:
        f = fk[kode]
        la, lo = (float(x) for x in f["lokasi"].split(","))
        c = min(cities, key=lambda c: (c["lat"] - la) ** 2 + (c["lon"] - lo) ** 2)
        kelas = {"RS Tipe A": "A", "RS Tipe B": "B", "RS Tipe C": "C", "RS Tipe D": "D"}.get(f["jenis"], "Klinik Utama")
        devs = [{"id_alat": d[0], "nama_alat": d[2], "jenis_alat": d[3], "merek_model": d[4], "id_meter": d[5], "jumlah_mesin": d[6], "skenario": d[7]}
                for d in iot.DEVICES if d[1] == kode]
        hospitals.append({"kode": kode, "nama": f["nama"], "kelas": kelas, "kepemilikan": f.get("kepemilikan") or "swasta", "city": c, "lat": la, "lon": lo,
                          "tier": TIER_PILOT, "terhubung": True, "terhubung_sejak": "2026-09-01", "devices": devs, "kode_faskes_audit": kode, "skenario": {}})
    # the national network
    for c in cities:
        n = {1: 3, 2: 5, 3: 8}[c["w"]] + rnd.randint(-1, 2)
        if c["nama"] in HOTSPOTS:
            n = max(n, 7)
        used: set[str] = set()
        short = c["nama"].replace("Kota ", "").replace("Kab. ", "").split(" (")[0]
        for i in range(1, n + 1):
            kelas = rnd.choices(["A", "B", "C", "D"], [0.05, 0.27, 0.43, 0.25])[0] if c["w"] > 1 else rnd.choices(["B", "C", "D"], [0.25, 0.45, 0.30])[0]
            milik = rnd.choices(["pemerintah daerah", "swasta", "TNI/Polri", "BUMN", "pemerintah pusat"], [0.35, 0.5, 0.06, 0.04, 0.05])[0]
            if i == 1:
                nama = f"RSUD {short}"
                milik = "pemerintah daerah"
                kelas = "B" if c["w"] >= 2 else "C"
            else:
                nama = f"RS {rnd.choice(NAMA_RS)} {short}"
                while nama in used:
                    nama = f"RS {rnd.choice(NAMA_RS)} {rnd.choice(NAMA_RS)} {short}"
            used.add(nama)
            kode = f"RS-{c['id'][2:]}{i:02d}"
            if c["nama"] in HOTSPOTS and HOTSPOTS[c["nama"]] == "Hemodialisis" and kelas == "D":
                kelas = "C"
            devs = []
            types = _kelas_devices(rnd, kelas)
            if c["nama"] in HOTSPOTS and not any(t == HOTSPOTS[c["nama"]] for t, _m in types):
                types.append((HOTSPOTS[c["nama"]], rnd.randint(4, 6) if HOTSPOTS[c["nama"]] == "Hemodialisis" else 1))
            count: dict[str, int] = {}
            connected = rnd.random() < CAKUPAN[c["kw"]] or c["nama"] in HOTSPOTS
            for jenis, mesin in types:
                count[jenis] = count.get(jenis, 0) + 1
                did = f"ALN-{kode[3:]}-{CODE[jenis]}{count[jenis]}"
                label = {"Rontgen": "Rontgen DR", "CT Scan": "CT scan", "USG": "USG", "Hemodialisis": f"Unit hemodialisis ({mesin} mesin)"}[jenis]
                devs.append({"id_alat": did, "nama_alat": f"{label} {count[jenis]}" if jenis != "Hemodialisis" else label, "jenis_alat": jenis,
                             "merek_model": "contoh", "id_meter": f"MTN-{kode[3:]}-{CODE[jenis]}{count[jenis]}" if connected else None, "jumlah_mesin": mesin,
                             "skenario": "ok"})
            sk: dict[str, Any] = {}
            if connected:
                if c["nama"] in HOTSPOTS:
                    target = HOTSPOTS[c["nama"]]
                    rnd.random()
                    if i % 5 != 0:  # four in five hospitals of a hotspot follow the pattern
                        sk["phantom"] = (target, rnd.uniform(1.35, 1.8) if target != "Hemodialisis" else None)
                elif rnd.random() < 0.04:
                    t = rnd.choice([d["jenis_alat"] for d in devs if d["jenis_alat"] != "Hemodialisis"] or ["Rontgen"])
                    sk["phantom"] = (t, rnd.uniform(1.4, 2.2))
                elif rnd.random() < 0.03 and any(d["jenis_alat"] == "Hemodialisis" for d in devs):
                    sk["phantom"] = ("Hemodialisis", None)
                if rnd.random() < 0.015 and not any(d["jenis_alat"] == "CT Scan" for d in devs):
                    sk["tanpa_alat"] = "CT Scan"
                if rnd.random() < 0.08:
                    start = rnd.randint(0, len(days()) - 3)
                    sk["putus"] = list(range(start, start + rnd.randint(1, 3)))
                if rnd.random() < 0.06:
                    sk["sebagian"] = {rnd.randint(0, len(days()) - 1): rnd.uniform(0.5, 0.85)}
                for d in devs:
                    if rnd.random() < 0.02 and d["jenis_alat"] != "Hemodialisis":
                        start = rnd.randint(0, len(days()) - 6)
                        d["rusak"] = list(range(start, start + rnd.randint(3, 6)))
                if rnd.random() < 0.10:
                    j = rnd.choice(["Rontgen", "USG"])
                    count[j] = count.get(j, 0) + 1
                    devs.append({"id_alat": f"ALN-{kode[3:]}-{CODE[j]}{count[j]}", "nama_alat": f"{'Rontgen mobile' if j == 'Rontgen' else 'USG portabel'} (cadangan)",
                                 "jenis_alat": j, "merek_model": "contoh", "id_meter": None, "jumlah_mesin": 1, "skenario": "cadangan"})
            dr = [f"dr. {rnd.choice(DEPAN)} {rnd.choice(BELAKANG)}, {rnd.choice(SPESIALIS)}" for _ in range(rnd.randint(4, 10))]
            hospitals.append({"kode": kode, "nama": nama, "kelas": kelas, "kepemilikan": milik, "city": c, "lat": c["lat"] + rnd.gauss(0, 0.025),
                              "lon": c["lon"] + rnd.gauss(0, 0.025), "tier": TIER_EDGE, "terhubung": connected,
                              "terhubung_sejak": (date(2026, 8, 1) + timedelta(days=rnd.randint(0, 40))).isoformat() if connected else None,
                              "devices": devs, "kode_faskes_audit": None, "skenario": sk, "dokter": dr})
    return {"wilayah": wilayah, "hospitals": hospitals, "by_kode": {h["kode"]: h for h in hospitals},
            "by_alat": {d["id_alat"]: (h, d) for h in hospitals for d in h["devices"]}}


# daily procedures per device, by class (weekday range; Saturday about half, Sunday a few)
VOLUME = {
    "Rontgen": {"A": (16, 26), "B": (9, 16), "C": (5, 10), "D": (3, 7), "Klinik Utama": (2, 4)},
    "CT Scan": {"A": (10, 16), "B": (6, 10), "C": (3, 6), "D": (2, 4), "Klinik Utama": (1, 2)},
    "USG": {"A": (9, 13), "B": (6, 10), "C": (4, 8), "D": (3, 6), "Klinik Utama": (4, 6)},
}


def _volume(rnd: random.Random, jenis: str, kelas: str, wd: int) -> int:
    lo, hi = VOLUME[jenis].get(kelas, (3, 6))
    if wd == 5:
        lo, hi = max(1, lo // 2), max(2, hi // 2)
    elif wd == 6:
        lo, hi = 1, max(2, hi // 4)
    return rnd.randint(lo, hi)


def device_day(id_alat: str, i: int) -> tuple[list[Optional[float]], int, int]:
    """One national device's power per 2-minute slot on pilot day i (None: no reading reached the gateway), the
    procedures it really did, and the procedures claims would normally show for it (for a device out of order: what
    it would have done). Seeded by device and day, so an auditor pulling the archive later sees the same day."""
    h, d = world()["by_alat"][id_alat]
    j = iot.JENIS[d["jenis_alat"]]
    day = days()[i]
    wd = day.weekday()
    rnd = random.Random(f"{SEED}-{id_alat}-{day.isoformat()}")
    S = iot.SLOTS
    p: list[Optional[float]] = [0.0] * S
    jenis = d["jenis_alat"]
    broken = i in (d.get("rusak") or [])
    if jenis in ("Rontgen", "CT Scan"):
        on0, on1 = (0, S) if jenis == "CT Scan" else (7 * 30, 21 * 30)
        for s in range(on0, on1):
            p[s] = j["standby"] * rnd.uniform(0.96, 1.04)
        n = _volume(rnd, jenis, h["kelas"], wd)
        length = 2 if jenis == "Rontgen" else 5
        starts = iot._starts(rnd, n, 7 * 30 + 15, 20 * 30 + 15, length, 3)
        n = len(starts)
        if jenis == "Rontgen":
            starts = [7 * 30 + 5, *starts]  # the morning QC exposure: a cycle, not a procedure
        for s in starts:
            for k in range(length):
                p[s + k] = j["aktif"] * rnd.uniform(0.95, 1.05)
        normal = n
    elif jenis == "USG":
        n = _volume(rnd, jenis, h["kelas"], wd)
        t = 8 * 30
        done = 0
        for block_start in (8 * 30, 13 * 30, 17 * 30):
            if done >= n:
                break
            t = max(t, block_start)
            for _ in range(min(n - done, 6)):
                dur = rnd.randint(8, 11)
                for k in range(dur):
                    p[t + k] = j["aktif"] * rnd.uniform(0.95, 1.05)
                t += dur
                gap = rnd.randint(1, 3)
                for k in range(gap):
                    p[t + k] = j["aktif"] * rnd.uniform(0.9, 1.0)
                t += gap
                done += 1
        normal = n
    else:
        for s in range(S):
            p[s] = (j["standby"] if 6 * 30 <= s < 23 * 30 else 50.0) * rnd.uniform(0.97, 1.03)
        cap = d["jumlah_mesin"]
        shifts = [rnd.randint(max(1, cap - 2), cap) for _ in range(3)] if wd < 6 else [rnd.randint(1, max(1, cap // 2)), rnd.randint(0, max(1, cap // 2)), 0]
        n = 0
        for si, k in enumerate(shifts):
            s0 = (7 + 5 * si) * 30
            for s in range(s0, s0 + 125):
                p[s] = (p[s] or 0) + j["aktif"] * k * rnd.uniform(0.97, 1.03)
            n += k
        normal = n
    if broken:
        p = [0.0] * S
        n = 0
    # gateway outages: the whole day, or part of it
    if i in (h["skenario"].get("putus") or []):
        p = [None] * S
    part = (h["skenario"].get("sebagian") or {}).get(i)
    if part:
        cut = int(S * (1 - part))
        s0 = rnd.randint(6 * 30, S - cut)
        for s in range(s0, s0 + cut):
            p[s] = None
    return [None if w is None else round(w, 1) for w in p], n, normal


def summarize(d: dict, p: list[Optional[float]]) -> Optional[dict]:
    """What the gateway computes from a device's day — the pilot pipeline's status / cycle / daily-use logic."""
    j = iot.JENIS[d["jenis_alat"]]
    standby, aktif_w, metode = j["standby"], j["aktif"], j["metode"]
    ambang = round(standby + 0.4 * (aktif_w - standby), 1) if metode == "siklus" else 30.0 if metode == "waktu" else round(standby + 0.5 * aktif_w, 1)
    bacaan = menyala_n = aktif_n = siklus = 0
    energi = mesin = total = 0.0
    prev_a: Optional[int] = None
    prev_i = -10
    first = last = None
    for i, w in enumerate(p):
        if w is None:
            continue
        bacaan += 1
        total += w
        a = 1 if w >= ambang else 0
        if w > 20:
            menyala_n += 1
            h = i * iot.STEP // 3600
            first = h if first is None else first
            last = h
        if a:
            aktif_n += 1
            if prev_a in (None, 0) or (i - prev_i) * iot.STEP > 300:
                siklus += 1
            if metode == "siklus":
                energi += round((w - standby) * 120.0 / 3600, 2)
        if metode == "mesin_jam":
            mesin += round(max(w - standby, 0) / aktif_w * 2, 3)
        prev_a, prev_i = a, i
    if not bacaan:
        return None
    return {"bacaan": bacaan, "siklus": siklus, "menit_menyala": menyala_n * 2, "menit_aktif": aktif_n * 2, "energi_aktif_wh": round(energi, 1),
            "mesin_menit": round(mesin, 1), "kwh": round(total * 2 / 60000.0, 2), "jam_nyala_pertama": first, "jam_nyala_terakhir": last}


def generate() -> tuple[dict[str, list[dict]], dict]:
    """The raw files: regions, hospital and device registers, the gateways' daily edge summaries and the e-Klaim
    warehouse's daily procedure counts. The pilot's hospitals send nothing here (their data is the pilot's)."""
    w = world()
    rnd = random.Random(f"{SEED}-klaim")
    rs_rows, alat_rows, edge, klaim = [], [], [], []
    stats = {"device_days": 0, "edge_rows": 0}
    for h in w["hospitals"]:
        c = h["city"]
        rs_rows.append({"kode": h["kode"], "nama": h["nama"], "kelas": h["kelas"], "kepemilikan": h["kepemilikan"], "id_kabkota": c["id"], "kabkota": c["nama"],
                        "id_provinsi": c["pid"], "provinsi": c["prov"], "id_kedeputian": c["kw"].replace(" ", "-"), "kedeputian": KW_NAMA[c["kw"]],
                        "kantor_cabang": f"KC {c['nama'].replace('Kota ', '').replace('Kab. ', '')}", "lokasi": f"{h['lat']:.5f},{h['lon']:.5f}", "tier": h["tier"],
                        "kode_faskes_audit": h["kode_faskes_audit"], "terhubung_sejak": h["terhubung_sejak"]})
        for d in h["devices"]:
            j = iot.JENIS[d["jenis_alat"]]
            alat_rows.append({"id_alat": d["id_alat"], "kode_faskes": h["kode"], "nama_alat": d["nama_alat"], "jenis_alat": d["jenis_alat"],
                              "merek_model": d["merek_model"], "id_meter": d["id_meter"], "id_gateway": f"GW-{h['kode'][3:]}" if d["id_meter"] else None,
                              "jumlah_mesin": d["jumlah_mesin"], "daya_standby_w": j["standby"], "daya_aktif_w": j["aktif"],
                              "sumber": "ASPAK (Aplikasi Sarana, Prasarana dan Alat Kesehatan)", "meter_terpasang": h["terhubung_sejak"] if d["id_meter"] else None})
        if h["tier"] == TIER_PILOT:
            continue
        by_type: dict[tuple[str, int], int] = {}
        for i, day in enumerate(days()):
            for d in h["devices"]:
                if d["id_meter"]:
                    p, n, normal = device_day(d["id_alat"], i)
                    stats["device_days"] += 1
                    s = summarize(d, p)
                    if s:
                        row = {"id_gateway": f"GW-{h['kode'][3:]}", "id_alat": d["id_alat"] if rnd.random() > 0.05 else d["id_alat"].lower(), "tanggal": day.isoformat(),
                               "diterima": f"{(day + timedelta(days=1)).isoformat()}T00:{rnd.randint(5, 55):02d}:00+07:00", **s}
                        edge.append(row)
                        if rnd.random() < 0.01:  # sent again after a reconnect
                            edge.append({**row, "diterima": f"{(day + timedelta(days=1)).isoformat()}T06:{rnd.randint(0, 59):02d}:00+07:00"})
                    real = normal if d.get("rusak") and i in d["rusak"] else n
                else:
                    drnd = random.Random(f"{SEED}-{d['id_alat']}-{day.isoformat()}")
                    if d["jenis_alat"] == "Hemodialisis":
                        real = sum(drnd.randint(max(1, d["jumlah_mesin"] - 2), d["jumlah_mesin"]) for _ in range(3)) if day.weekday() < 6 else d["jumlah_mesin"] // 2
                    else:
                        real = _volume(drnd, d["jenis_alat"], h["kelas"], day.weekday())
                        if d["skenario"] == "cadangan":
                            real = drnd.randint(1, 3)
                by_type[(d["jenis_alat"], i)] = by_type.get((d["jenis_alat"], i), 0) + real
        sk = h["skenario"]
        for i, day in enumerate(days()):
            wd = day.weekday()
            for jenis in sorted({jj for jj, ii in by_type if ii == i} | ({sk["tanpa_alat"]} if sk.get("tanpa_alat") else set())):
                real = by_type.get((jenis, i), 0)
                extra = 0
                ph = sk.get("phantom")
                if ph and ph[0] == jenis and wd < 6 and rnd.random() < 0.75:
                    extra = rnd.randint(3, 6) if jenis == "Hemodialisis" else max(2, round(real * (ph[1] - 1)))
                if sk.get("tanpa_alat") == jenis:
                    extra = rnd.randint(1, 3) if wd < 5 and rnd.random() < 0.6 else 0
                total = real + extra
                if not total:
                    continue
                codes = iot.JENIS[jenis]["kode"]
                split: dict[str, int] = {}
                for _ in range(total):
                    code = rnd.choice(codes)[0]
                    split[code] = split.get(code, 0) + 1
                for code, cnt in split.items():
                    messy = rnd.random()
                    klaim.append({"kode_faskes": h["kode"] if rnd.random() > 0.03 else h["kode"].lower(), "tanggal": day.isoformat(),
                                  "kode_icd9": code.replace(".", "") if messy < 0.15 else code, "jumlah": cnt,
                                  "nilai_rp": float(sum(round(iot.JENIS[jenis]["tarif"] * rnd.uniform(0.92, 1.15), -3) for _ in range(cnt)))})
    stats["edge_rows"] = len(edge)
    wil = w["wilayah"]
    return {"wilayah_jkn": wil, "registri_rs_jejaring": rs_rows, "registri_alat_jejaring": alat_rows, "ringkasan_edge_harian": edge,
            "klaim_harian_eklaim": klaim}, stats


def claim_lines(kode: str, jenis: str, day: str, count: int) -> list[dict]:
    """The claim lines behind a day's count (pulled from e-Klaim when an auditor opens a finding): deterministic."""
    h = world()["by_kode"][kode]
    rnd = random.Random(f"{SEED}-lines-{kode}-{jenis}-{day}")
    ph = (h["skenario"].get("phantom") or (None,))[0]
    suspects = h.get("dokter", ["dr. (tidak diketahui)"])[:2]
    out = []
    for k in range(count):
        code, name = rnd.choice(iot.JENIS[jenis]["kode"])
        doctor = rnd.choice(suspects) if ph == jenis and rnd.random() < 0.6 else rnd.choice(h.get("dokter") or suspects)
        sep = f"0301R{kode[3:].replace('-', '')[:6]}0926V{rnd.randint(100000, 999999)}"
        raw_code = code.replace(".", "") if rnd.random() < 0.15 else code
        out.append({"id_baris": f"{sep}-{code}", "no_sep": sep, "kode_icd9": code, "kode_icd9_mentah": raw_code, "nama_tindakan": name,
                    "nama_dokter": doctor, "id_dokter": doctor, "tarif_rs": float(round(iot.JENIS[jenis]["tarif"] * rnd.uniform(0.92, 1.15), -3))})
    return out


# ------------------------------------------------------------------------------------------------
# the pipeline (sqlite / sql.js with Spark CAST rules: no CAST of text, no CAST inside string building)
# ------------------------------------------------------------------------------------------------

SQL_PARAM = iot.SQL_PARAM.replace("-- Alat dari register ASPAK", "-- Alat jejaring nasional dari register ASPAK")

SQL_HARIAN = """-- Pemakaian harian per alat di seluruh jejaring: ringkasan edge dari gateway tiap RS (dedup kiriman ulang, id
-- diseragamkan) dengan estimasi tindakan yang sama seperti pilot, ditambah pemakaian harian pilot (telemetri penuh).
WITH e AS (
  SELECT UPPER(TRIM(id_alat)) AS id_alat, tanggal, bacaan, siklus, menit_menyala, menit_aktif, energi_aktif_wh, mesin_menit, kwh,
         jam_nyala_pertama, jam_nyala_terakhir,
         ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(id_alat)), tanggal ORDER BY diterima DESC) AS rk
  FROM input),
n AS (
  SELECT e.id_alat || '-' || e.tanggal AS id_pemakaian, e.id_alat, a.id_meter, a.metode, e.tanggal, e.bacaan, e.menit_menyala, e.menit_aktif, e.siklus,
         e.energi_aktif_wh, e.mesin_menit, e.kwh, e.jam_nyala_pertama, e.jam_nyala_terakhir, ROUND(e.bacaan / 720.0, 3) AS kelengkapan,
         a.kode_faskes, a.jenis_alat, a.jumlah_mesin,
         CASE a.metode WHEN 'siklus' THEN MAX(e.siklus, CAST(ROUND(e.energi_aktif_wh / a.energi_per_tindakan_wh) AS INTEGER))
                       WHEN 'waktu' THEN CAST(e.menit_menyala / a.durasi_min_menit AS INTEGER)
                       ELSE CAST(e.mesin_menit / a.durasi_min_menit AS INTEGER) END AS estimasi_tindakan,
         a.jumlah_mesin * a.sesi_per_mesin_per_hari AS kapasitas_maks, 'Ringkasan edge' AS tier
  FROM e JOIN parameter_alat_jejaring a ON a.id_alat = e.id_alat
  WHERE e.rk = 1),
semua AS (
  SELECT * FROM n
  UNION ALL
  SELECT id_pemakaian, id_alat, id_meter, metode, SUBSTR(id_pemakaian, -10) AS tanggal, bacaan, menit_menyala, menit_aktif, siklus, energi_aktif_wh,
         mesin_menit, kwh, jam_nyala_pertama, jam_nyala_terakhir, kelengkapan, kode_faskes, jenis_alat, jumlah_mesin, estimasi_tindakan, kapasitas_maks,
         'Telemetri penuh' AS tier
  FROM pemakaian_alat_harian)
SELECT semua.*, tanggal || 'T12:00:00+07:00' AS waktu_seri FROM semua"""

SQL_KLAIM = """-- Klaim tindakan penunjang per RS × jenis alat × hari dari gudang data e-Klaim (jumlah per kode ICD-9-CM, kode dirapikan).
WITH c AS (
  SELECT UPPER(TRIM(kode_faskes)) AS kode_faskes, tanggal,
         SUBSTR(REPLACE(REPLACE(TRIM(kode_icd9), '.', ''), ' ', ''), 1, 2) || '.' || SUBSTR(REPLACE(REPLACE(TRIM(kode_icd9), '.', ''), ' ', ''), 3) AS kode_icd9,
         jumlah, nilai_rp
  FROM input)
SELECT 'IOT-' || c.kode_faskes || '-' || REPLACE(UPPER(r.jenis_alat), ' ', '') || '-' || c.tanggal AS id_rekon, c.kode_faskes, r.jenis_alat, c.tanggal,
       SUM(c.jumlah) AS klaim_tindakan, ROUND(SUM(c.nilai_rp), 0) AS nilai_klaim_rp
FROM c JOIN referensi_tindakan_alat r ON r.kode_icd9 = c.kode_icd9
GROUP BY c.kode_faskes, r.jenis_alat, c.tanggal"""

REKON_COLS = ("id_rekon, kode_faskes, nama_faskes, jenis_alat, tanggal, klaim_tindakan, estimasi_tindakan_alat, batas_toleransi, siklus, menit_menyala, "
              "mesin_menit, energi_aktif_kwh, kelengkapan, bermeter, tanpa_meter, alat_terkait, alat_utama, kapasitas_maks, status_rekon, tingkat, "
              "tindakan_tak_didukung, nilai_tak_didukung_rp, nilai_klaim_rp, dokter_terbanyak, jumlah_dokter, lokasi")

SQL_REKON = """-- Rekonsiliasi seluruh jejaring dengan aturan yang sama seperti pilot (klaim vs estimasi alat; data meter < 90 % dan
-- alat tanpa meter tidak disimpulkan fraud). RS yang belum terhubung: "Tanpa meter (tidak dinilai)". Baris pilot (telemetri
-- penuh) digabungkan dari pipeline pilot. Tiap baris diberi wilayahnya: kabupaten/kota, provinsi, kedeputian.
WITH pakai AS (
  SELECT kode_faskes, jenis_alat, tanggal, SUM(estimasi_tindakan) AS est, SUM(siklus) AS siklus, SUM(menit_menyala) AS menit_menyala,
         SUM(mesin_menit) AS mesin_menit, ROUND(SUM(energi_aktif_wh) / 1000.0, 2) AS energi_aktif_kwh, MIN(kelengkapan) AS kelengkapan
  FROM pemakaian_harian_jejaring WHERE tier = 'Ringkasan edge' GROUP BY kode_faskes, jenis_alat, tanggal),
terpasang AS (
  SELECT kode_faskes, jenis_alat, SUM(CASE WHEN id_meter IS NULL THEN 1 ELSE 0 END) AS tanpa_meter,
         SUM(CASE WHEN id_meter IS NOT NULL THEN 1 ELSE 0 END) AS bermeter, MIN(CASE WHEN id_meter IS NOT NULL THEN id_alat END) AS alat_utama,
         SUM(jumlah_mesin * sesi_per_mesin_per_hari) AS kapasitas_maks, GROUP_CONCAT(id_alat, ', ') AS semua_alat
  FROM parameter_alat_jejaring GROUP BY kode_faskes, jenis_alat),
pilot AS (SELECT kode FROM registri_rs_jejaring WHERE tier = 'Telemetri penuh'),
hari AS (SELECT DISTINCT tanggal FROM pemakaian_harian_jejaring),
kunci AS (
  SELECT t.kode_faskes, t.jenis_alat, h.tanggal FROM terpasang t CROSS JOIN hari h WHERE t.bermeter > 0
  UNION SELECT kode_faskes, jenis_alat, tanggal FROM input),
r AS (
  SELECT k.kode_faskes, k.jenis_alat, k.tanggal,
         'IOT-' || k.kode_faskes || '-' || REPLACE(UPPER(k.jenis_alat), ' ', '') || '-' || k.tanggal AS id_rekon,
         COALESCE(c.klaim_tindakan, 0) AS klaim, COALESCE(c.nilai_klaim_rp, 0) AS nilai_klaim_rp,
         COALESCE(p.est, 0) AS est, COALESCE(p.siklus, 0) AS siklus, COALESCE(p.menit_menyala, 0) AS menit_menyala,
         COALESCE(p.mesin_menit, 0) AS mesin_menit, COALESCE(p.energi_aktif_kwh, 0) AS energi_aktif_kwh, COALESCE(p.kelengkapan, 0) AS kelengkapan,
         COALESCE(t.bermeter, 0) AS bermeter, COALESCE(t.tanpa_meter, 0) AS tanpa_meter, t.alat_utama, COALESCE(t.kapasitas_maks, 0) AS kapasitas_maks,
         COALESCE(t.semua_alat, '') AS alat_terkait
  FROM kunci k
  LEFT JOIN input c ON c.kode_faskes = k.kode_faskes AND c.jenis_alat = k.jenis_alat AND c.tanggal = k.tanggal
  LEFT JOIN pakai p ON p.kode_faskes = k.kode_faskes AND p.jenis_alat = k.jenis_alat AND p.tanggal = k.tanggal
  LEFT JOIN terpasang t ON t.kode_faskes = k.kode_faskes AND t.jenis_alat = k.jenis_alat
  WHERE k.kode_faskes NOT IN (SELECT kode FROM pilot)),
s AS (
  SELECT *, CAST(est * 1.1 AS INTEGER) + 1 AS batas,
         CASE WHEN bermeter = 0 AND tanpa_meter = 0 AND klaim > 0 THEN 'Klaim tanpa alat terdaftar'
              WHEN bermeter = 0 THEN 'Tanpa meter (tidak dinilai)'
              WHEN kelengkapan < 0.9 THEN 'Data meter tidak lengkap'
              WHEN est = 0 AND klaim > 0 THEN 'Klaim saat alat mati'
              WHEN klaim > CAST(est * 1.1 AS INTEGER) + 1 AND tanpa_meter > 0 THEN 'Perlu verifikasi (alat tanpa meter)'
              WHEN klaim > CAST(est * 1.1 AS INTEGER) + 1 THEN 'Klaim melebihi pemakaian alat'
              ELSE 'Sesuai' END AS status_rekon
  FROM r),
n AS (
  SELECT id_rekon, kode_faskes, NULL AS nama_faskes, jenis_alat, tanggal, klaim AS klaim_tindakan, est AS estimasi_tindakan_alat, batas AS batas_toleransi,
         siklus, menit_menyala, mesin_menit, energi_aktif_kwh, kelengkapan, bermeter, tanpa_meter, alat_terkait, alat_utama, kapasitas_maks, status_rekon,
         CASE WHEN status_rekon IN ('Klaim tanpa alat terdaftar', 'Klaim saat alat mati', 'Klaim melebihi pemakaian alat') THEN 'Tinggi'
              WHEN status_rekon = 'Perlu verifikasi (alat tanpa meter)' THEN 'Sedang'
              WHEN status_rekon = 'Data meter tidak lengkap' THEN 'Info'
              WHEN status_rekon = 'Tanpa meter (tidak dinilai)' THEN 'Tidak dinilai' ELSE 'Sesuai' END AS tingkat,
         CASE WHEN status_rekon IN ('Klaim tanpa alat terdaftar', 'Klaim saat alat mati') THEN klaim
              WHEN status_rekon IN ('Klaim melebihi pemakaian alat', 'Perlu verifikasi (alat tanpa meter)') THEN klaim - est ELSE 0 END AS tindakan_tak_didukung,
         ROUND(CASE WHEN klaim > 0 THEN nilai_klaim_rp * 1.0 / klaim ELSE 0 END
               * CASE WHEN status_rekon IN ('Klaim tanpa alat terdaftar', 'Klaim saat alat mati') THEN klaim
                      WHEN status_rekon IN ('Klaim melebihi pemakaian alat', 'Perlu verifikasi (alat tanpa meter)') THEN klaim - est ELSE 0 END, 0) AS nilai_tak_didukung_rp,
         nilai_klaim_rp, NULL AS dokter_terbanyak, NULL AS jumlah_dokter, NULL AS lokasi
  FROM s),
semua AS (
  SELECT COLS FROM n
  UNION ALL
  SELECT id_rekon, kode_faskes, nama_faskes, jenis_alat, SUBSTR(id_rekon, -10) AS tanggal, klaim_tindakan, estimasi_tindakan_alat, batas_toleransi, siklus,
         menit_menyala, mesin_menit, energi_aktif_kwh, kelengkapan, bermeter, tanpa_meter, alat_terkait, alat_utama, kapasitas_maks, status_rekon, tingkat,
         tindakan_tak_didukung, nilai_tak_didukung_rp, nilai_klaim_rp, dokter_terbanyak, jumlah_dokter, lokasi
  FROM rekonsiliasi_iot_klaim)
SELECT x.id_rekon, x.kode_faskes, COALESCE(x.nama_faskes, h.nama) AS nama_faskes, x.jenis_alat, x.tanggal, x.klaim_tindakan, x.estimasi_tindakan_alat,
       x.batas_toleransi, x.siklus, x.menit_menyala, x.mesin_menit, x.energi_aktif_kwh, x.kelengkapan, x.bermeter, x.tanpa_meter, x.alat_terkait, x.alat_utama,
       x.kapasitas_maks, x.status_rekon, x.tingkat, x.tindakan_tak_didukung, x.nilai_tak_didukung_rp, x.nilai_klaim_rp, x.dokter_terbanyak, x.jumlah_dokter,
       COALESCE(x.lokasi, h.lokasi) AS lokasi, h.tier, h.id_kabkota, h.kabkota, h.id_provinsi, h.provinsi, h.id_kedeputian, h.kedeputian
FROM semua x JOIN registri_rs_jejaring h ON h.kode = x.kode_faskes""".replace("COLS", REKON_COLS)

SQL_TEMUAN = iot.SQL_TEMUAN.replace(
    "-- Temuan IoT: tiap hari yang tidak cocok, dengan penjelasan berangka yang bisa dibacakan ke faskes.",
    "-- Temuan IoT seluruh jejaring (pilot + nasional): tiap hari yang tidak cocok, dengan penjelasan berangka dan wilayahnya.").replace(
    "FROM input\nWHERE status_rekon NOT IN ('Sesuai', 'Tanpa meter (tidak dinilai)')",
    ", tier, id_kabkota, kabkota, id_provinsi, provinsi, id_kedeputian, kedeputian\nFROM input\nWHERE status_rekon NOT IN ('Sesuai', 'Tanpa meter (tidak dinilai)')")

assert "registri_rs_jejaring" not in iot.SQL_TEMUAN and ", tier, id_kabkota" in SQL_TEMUAN, "the pilot's finding SQL changed: update SQL_TEMUAN"

ALAT_COLS = ("id_alat, nama_alat, jenis_alat, merek_model, kode_faskes, nama_faskes, id_meter, id_gateway, seri_daya, nama_sensor, satuan, metode_estimasi, "
             "daya_standby_w, daya_aktif_w, ambang_aktif_w, jumlah_mesin, kapasitas_maks_harian, lokasi, hari_data, kelengkapan_pct, siklus_total, "
             "estimasi_tindakan_total, kwh_total, klaim_total, tak_didukung_total, hari_temuan, status_iot, status_operasi, status_sejak")

SQL_ALAT = """-- Alat medis IoT seluruh jejaring (objek sensor): register + parameter + ringkasan 14 hari pemakaian (ringkasan edge)
-- dan rekonsiliasi jenisnya di RS itu; alat pilot (telemetri penuh) digabung dari pipeline pilot. seri_daya = id seri time
-- series alat: daya 2 menit (pilot, id meter) atau estimasi tindakan harian (jejaring, id alat); satuan = W / tindakan per hari.
WITH u AS (
  SELECT id_alat, COUNT(*) AS hari_data, ROUND(AVG(kelengkapan) * 100, 1) AS kelengkapan_pct, SUM(siklus) AS siklus_total,
         SUM(estimasi_tindakan) AS estimasi_tindakan_total, ROUND(SUM(kwh), 1) AS kwh_total
  FROM pemakaian_harian_jejaring WHERE tier = 'Ringkasan edge' GROUP BY id_alat),
k AS (
  SELECT kode_faskes, jenis_alat, SUM(klaim_tindakan) AS klaim_total, SUM(tindakan_tak_didukung) AS tak_didukung_total,
         SUM(CASE WHEN tingkat = 'Tinggi' THEN 1 ELSE 0 END) AS hari_temuan, SUM(CASE WHEN tingkat = 'Info' THEN 1 ELSE 0 END) AS hari_data_kurang,
         SUM(CASE WHEN tingkat = 'Sedang' THEN 1 ELSE 0 END) AS hari_verifikasi
  FROM rekonsiliasi_jejaring GROUP BY kode_faskes, jenis_alat),
n AS (
  SELECT a.id_alat, a.nama_alat, a.jenis_alat, a.merek_model, a.kode_faskes, h.nama AS nama_faskes, a.id_meter, a.id_gateway,
         CASE WHEN a.id_meter IS NULL THEN NULL ELSE a.id_alat END AS seri_daya,
         'Pemakaian ' || a.nama_alat AS nama_sensor, 'tindakan/hari' AS satuan, a.metode AS metode_estimasi, a.daya_standby_w, a.daya_aktif_w, a.ambang_aktif_w,
         a.jumlah_mesin, a.jumlah_mesin * a.sesi_per_mesin_per_hari AS kapasitas_maks_harian,
         ROUND(CAST(SUBSTR(h.lokasi, 1, INSTR(h.lokasi, ',') - 1) AS DOUBLE) + 0.004 * ROW_NUMBER() OVER (PARTITION BY a.kode_faskes ORDER BY a.id_alat), 5) || ','
           || ROUND(CAST(SUBSTR(h.lokasi, INSTR(h.lokasi, ',') + 1) AS DOUBLE) + 0.005 - 0.0015 * ROW_NUMBER() OVER (PARTITION BY a.kode_faskes ORDER BY a.id_alat), 5) AS lokasi,
         COALESCE(u.hari_data, 0) AS hari_data, COALESCE(u.kelengkapan_pct, 0) AS kelengkapan_pct, COALESCE(u.siklus_total, 0) AS siklus_total,
         COALESCE(u.estimasi_tindakan_total, 0) AS estimasi_tindakan_total, COALESCE(u.kwh_total, 0) AS kwh_total,
         COALESCE(k.klaim_total, 0) AS klaim_total, COALESCE(k.tak_didukung_total, 0) AS tak_didukung_total, COALESCE(k.hari_temuan, 0) AS hari_temuan,
         CASE WHEN a.id_meter IS NULL THEN 'Tanpa meter'
              WHEN COALESCE(k.hari_temuan, 0) > 0 THEN 'Ada temuan'
              WHEN COALESCE(k.hari_verifikasi, 0) > 0 THEN 'Perlu verifikasi'
              WHEN COALESCE(k.hari_data_kurang, 0) > 0 THEN 'Data meter tidak lengkap'
              ELSE 'Sesuai' END AS status_iot,
         NULL AS status_operasi, NULL AS status_sejak
  FROM input a
  JOIN registri_rs_jejaring h ON h.kode = a.kode_faskes
  LEFT JOIN u ON u.id_alat = a.id_alat
  LEFT JOIN k ON k.kode_faskes = a.kode_faskes AND k.jenis_alat = a.jenis_alat
  WHERE h.tier <> 'Telemetri penuh'),
semua AS (SELECT COLS FROM n UNION ALL SELECT COLS FROM alat_iot)
SELECT x.*, h.tier, h.id_kabkota, h.kabkota, h.provinsi, h.kedeputian
FROM semua x JOIN registri_rs_jejaring h ON h.kode = x.kode_faskes""".replace("COLS", ALAT_COLS)

SQL_RS = """-- RS jejaring IoT: alat terpasang & bermeter, kelengkapan data, klaim vs pemakaian 14 hari, skor risiko IoT (0–100) dan
-- status pemantauan. Skor = 100 × (0,5 × min(1, rasio jenis alat terburuk ÷ 25 %) + 0,3 × min(1, hari temuan ÷ 7) + 0,2 × min(1, nilai ÷ Rp 30 jt)).
-- Rasio per jenis alat (bukan total RS), agar fraud di satu alat tidak tenggelam di RS besar; klaim tanpa alat terdaftar = 100 %.
WITH a AS (
  SELECT kode_faskes, COUNT(*) AS alat_terpasang, SUM(CASE WHEN id_meter IS NOT NULL THEN 1 ELSE 0 END) AS alat_bermeter
  FROM parameter_alat_jejaring GROUP BY kode_faskes),
u AS (SELECT kode_faskes, ROUND(AVG(kelengkapan) * 100, 1) AS kelengkapan_pct FROM pemakaian_harian_jejaring GROUP BY kode_faskes),
k AS (
  SELECT kode_faskes, SUM(klaim_tindakan) AS klaim, SUM(CASE WHEN bermeter > 0 THEN klaim_tindakan ELSE 0 END) AS klaim_terpantau,
         SUM(CASE WHEN bermeter > 0 THEN estimasi_tindakan_alat ELSE 0 END) AS est,
         SUM(CASE WHEN tingkat = 'Tinggi' THEN tindakan_tak_didukung ELSE 0 END) AS tak,
         SUM(CASE WHEN tingkat = 'Tinggi' THEN nilai_tak_didukung_rp ELSE 0 END) AS nilai,
         SUM(CASE WHEN tingkat = 'Tinggi' THEN 1 ELSE 0 END) AS hari_tinggi, SUM(CASE WHEN tingkat = 'Sedang' THEN 1 ELSE 0 END) AS hari_sedang,
         SUM(CASE WHEN tingkat = 'Info' THEN 1 ELSE 0 END) AS hari_info, ROUND(SUM(nilai_klaim_rp), 0) AS nilai_klaim,
         COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN tingkat = 'Tinggi' THEN jenis_alat END), '') AS alat_bermasalah
  FROM rekonsiliasi_jejaring GROUP BY kode_faskes),
kj AS (
  SELECT kode_faskes, jenis_alat,
         CASE WHEN SUM(CASE WHEN bermeter > 0 THEN klaim_tindakan ELSE 0 END) > 0
              THEN SUM(CASE WHEN tingkat = 'Tinggi' THEN tindakan_tak_didukung ELSE 0 END) * 1.0 / SUM(CASE WHEN bermeter > 0 THEN klaim_tindakan ELSE 0 END)
              WHEN SUM(CASE WHEN tingkat = 'Tinggi' THEN tindakan_tak_didukung ELSE 0 END) > 0 THEN 1.0 ELSE 0 END AS r
  FROM rekonsiliasi_jejaring GROUP BY kode_faskes, jenis_alat),
km AS (SELECT kode_faskes, MAX(r) AS rasio_maks FROM kj GROUP BY kode_faskes),
s AS (
  SELECT h.*, COALESCE(km.rasio_maks, 0) AS rasio_maks, COALESCE(a.alat_terpasang, 0) AS alat_terpasang, COALESCE(a.alat_bermeter, 0) AS alat_bermeter, u.kelengkapan_pct,
         COALESCE(k.klaim, 0) AS klaim, COALESCE(k.klaim_terpantau, 0) AS klaim_terpantau, COALESCE(k.est, 0) AS est, COALESCE(k.tak, 0) AS tak,
         COALESCE(k.nilai, 0) AS nilai, COALESCE(k.hari_tinggi, 0) AS hari_tinggi, COALESCE(k.hari_sedang, 0) AS hari_sedang,
         COALESCE(k.hari_info, 0) AS hari_info, COALESCE(k.nilai_klaim, 0) AS nilai_klaim, COALESCE(k.alat_bermasalah, '') AS alat_bermasalah,
         CASE WHEN COALESCE(k.klaim_terpantau, 0) > 0 THEN COALESCE(k.tak, 0) * 1.0 / k.klaim_terpantau ELSE 0 END AS rasio
  FROM input h LEFT JOIN a ON a.kode_faskes = h.kode LEFT JOIN u ON u.kode_faskes = h.kode LEFT JOIN k ON k.kode_faskes = h.kode
  LEFT JOIN km ON km.kode_faskes = h.kode),
z AS (
  SELECT *, ROUND(100 * (0.5 * MIN(1.0, rasio_maks / 0.25) + 0.3 * MIN(1.0, hari_tinggi / 7.0) + 0.2 * MIN(1.0, nilai / 30000000.0))) AS skor FROM s)
SELECT kode, nama, nama || ' · ' || kabkota AS judul, kelas, kepemilikan, id_kabkota, kabkota, id_provinsi, provinsi, id_kedeputian, kedeputian,
       kantor_cabang, lokasi, tier, kode_faskes_audit, terhubung_sejak, alat_terpasang, alat_bermeter, kelengkapan_pct,
       klaim AS klaim_tindakan_14h, klaim_terpantau AS klaim_terpantau_14h, est AS estimasi_alat_14h, tak AS tak_didukung_14h,
       nilai AS nilai_tak_didukung_rp, nilai_klaim AS nilai_klaim_rp, ROUND(rasio * 100, 1) AS rasio_tak_didukung_pct,
       ROUND(rasio_maks * 100, 1) AS rasio_jenis_maks_pct, hari_tinggi AS hari_temuan,
       hari_sedang AS hari_verifikasi, hari_info AS hari_data_kurang, alat_bermasalah, skor AS skor_risiko_iot,
       CASE WHEN alat_bermeter = 0 THEN 'Belum terhubung'
            WHEN skor >= 60 THEN 'Prioritas audit'
            WHEN skor >= 25 OR hari_sedang >= 3 THEN 'Perhatian'
            WHEN hari_info >= 3 OR COALESCE(kelengkapan_pct, 0) < 90 THEN 'Data kurang'
            ELSE 'Normal' END AS status_pemantauan
FROM z"""

SQL_WILAYAH = """-- Wilayah: kabupaten/kota → provinsi → kedeputian wilayah → nasional. Cakupan (RS terhubung ÷ RS), klaim terpantau,
-- tindakan & nilai tak didukung, RS per status. Hotspot = kabupaten/kota dengan ≥ 3 RS prioritas audit dan ≥ 40 % RS terhubungnya.
WITH lv AS (
  SELECT id_kabkota AS id_wilayah, COUNT(*) AS rs_total, SUM(CASE WHEN status_pemantauan <> 'Belum terhubung' THEN 1 ELSE 0 END) AS rs_terhubung,
         SUM(alat_bermeter) AS alat_bermeter, SUM(klaim_tindakan_14h) AS klaim, SUM(klaim_terpantau_14h) AS klaim_terpantau, SUM(tak_didukung_14h) AS tak,
         SUM(nilai_tak_didukung_rp) AS nilai, SUM(CASE WHEN status_pemantauan = 'Prioritas audit' THEN 1 ELSE 0 END) AS rs_prioritas,
         SUM(CASE WHEN status_pemantauan = 'Perhatian' THEN 1 ELSE 0 END) AS rs_perhatian, SUM(CASE WHEN status_pemantauan = 'Data kurang' THEN 1 ELSE 0 END) AS rs_data_kurang,
         ROUND(AVG(CASE WHEN alat_bermeter > 0 THEN kelengkapan_pct END), 1) AS kelengkapan_pct
  FROM rs_iot_jejaring GROUP BY id_kabkota
  UNION ALL
  SELECT id_provinsi, COUNT(*), SUM(CASE WHEN status_pemantauan <> 'Belum terhubung' THEN 1 ELSE 0 END), SUM(alat_bermeter), SUM(klaim_tindakan_14h),
         SUM(klaim_terpantau_14h), SUM(tak_didukung_14h), SUM(nilai_tak_didukung_rp), SUM(CASE WHEN status_pemantauan = 'Prioritas audit' THEN 1 ELSE 0 END),
         SUM(CASE WHEN status_pemantauan = 'Perhatian' THEN 1 ELSE 0 END), SUM(CASE WHEN status_pemantauan = 'Data kurang' THEN 1 ELSE 0 END),
         ROUND(AVG(CASE WHEN alat_bermeter > 0 THEN kelengkapan_pct END), 1)
  FROM rs_iot_jejaring GROUP BY id_provinsi
  UNION ALL
  SELECT id_kedeputian, COUNT(*), SUM(CASE WHEN status_pemantauan <> 'Belum terhubung' THEN 1 ELSE 0 END), SUM(alat_bermeter), SUM(klaim_tindakan_14h),
         SUM(klaim_terpantau_14h), SUM(tak_didukung_14h), SUM(nilai_tak_didukung_rp), SUM(CASE WHEN status_pemantauan = 'Prioritas audit' THEN 1 ELSE 0 END),
         SUM(CASE WHEN status_pemantauan = 'Perhatian' THEN 1 ELSE 0 END), SUM(CASE WHEN status_pemantauan = 'Data kurang' THEN 1 ELSE 0 END),
         ROUND(AVG(CASE WHEN alat_bermeter > 0 THEN kelengkapan_pct END), 1)
  FROM rs_iot_jejaring GROUP BY id_kedeputian
  UNION ALL
  SELECT 'ID', COUNT(*), SUM(CASE WHEN status_pemantauan <> 'Belum terhubung' THEN 1 ELSE 0 END), SUM(alat_bermeter), SUM(klaim_tindakan_14h),
         SUM(klaim_terpantau_14h), SUM(tak_didukung_14h), SUM(nilai_tak_didukung_rp), SUM(CASE WHEN status_pemantauan = 'Prioritas audit' THEN 1 ELSE 0 END),
         SUM(CASE WHEN status_pemantauan = 'Perhatian' THEN 1 ELSE 0 END), SUM(CASE WHEN status_pemantauan = 'Data kurang' THEN 1 ELSE 0 END),
         ROUND(AVG(CASE WHEN alat_bermeter > 0 THEN kelengkapan_pct END), 1)
  FROM rs_iot_jejaring)
SELECT w.id_wilayah, w.nama, w.nama || ' · ' || w.tingkat AS judul, w.tingkat, w.urutan_tingkat, w.induk, w.lokasi,
       COALESCE(lv.rs_total, 0) AS rs_total, COALESCE(lv.rs_terhubung, 0) AS rs_terhubung,
       ROUND(CASE WHEN COALESCE(lv.rs_total, 0) > 0 THEN lv.rs_terhubung * 100.0 / lv.rs_total ELSE 0 END, 1) AS cakupan_pct,
       COALESCE(lv.alat_bermeter, 0) AS alat_bermeter, COALESCE(lv.klaim, 0) AS klaim_14h, COALESCE(lv.klaim_terpantau, 0) AS klaim_terpantau_14h,
       COALESCE(lv.tak, 0) AS tak_didukung_14h, COALESCE(lv.nilai, 0) AS nilai_tak_didukung_rp,
       ROUND(CASE WHEN COALESCE(lv.klaim_terpantau, 0) > 0 THEN lv.tak * 100.0 / lv.klaim_terpantau ELSE 0 END, 2) AS rasio_tak_didukung_pct,
       COALESCE(lv.rs_prioritas, 0) AS rs_prioritas, COALESCE(lv.rs_perhatian, 0) AS rs_perhatian, COALESCE(lv.rs_data_kurang, 0) AS rs_data_kurang,
       lv.kelengkapan_pct,
       CASE WHEN COALESCE(lv.rs_terhubung, 0) = 0 THEN 'Belum terhubung'
            WHEN w.tingkat = 'Kabupaten/Kota' AND lv.rs_prioritas >= 3 AND lv.rs_prioritas * 1.0 / lv.rs_terhubung >= 0.4 THEN 'Hotspot'
            WHEN lv.rs_prioritas > 0 THEN 'Ada RS prioritas'
            WHEN lv.rs_perhatian > 0 THEN 'Perhatian'
            ELSE 'Normal' END AS status_wilayah
FROM input w LEFT JOIN lv ON lv.id_wilayah = w.id_wilayah"""

SQL_TREN = """-- Tren harian per wilayah (kabupaten/kota, provinsi, kedeputian, nasional): klaim terpantau, estimasi alat, tindakan
-- tak didukung dan hari temuan — untuk grafik di ruang pantau nasional.
SELECT id_kabkota AS id_wilayah, tanggal, SUM(CASE WHEN bermeter > 0 THEN klaim_tindakan ELSE 0 END) AS klaim_terpantau,
       SUM(CASE WHEN bermeter > 0 THEN estimasi_tindakan_alat ELSE 0 END) AS estimasi_alat,
       SUM(CASE WHEN tingkat = 'Tinggi' THEN tindakan_tak_didukung ELSE 0 END) AS tak_didukung, SUM(CASE WHEN tingkat = 'Tinggi' THEN 1 ELSE 0 END) AS temuan
FROM input GROUP BY id_kabkota, tanggal
UNION ALL
SELECT id_provinsi, tanggal, SUM(CASE WHEN bermeter > 0 THEN klaim_tindakan ELSE 0 END), SUM(CASE WHEN bermeter > 0 THEN estimasi_tindakan_alat ELSE 0 END),
       SUM(CASE WHEN tingkat = 'Tinggi' THEN tindakan_tak_didukung ELSE 0 END), SUM(CASE WHEN tingkat = 'Tinggi' THEN 1 ELSE 0 END)
FROM input GROUP BY id_provinsi, tanggal
UNION ALL
SELECT id_kedeputian, tanggal, SUM(CASE WHEN bermeter > 0 THEN klaim_tindakan ELSE 0 END), SUM(CASE WHEN bermeter > 0 THEN estimasi_tindakan_alat ELSE 0 END),
       SUM(CASE WHEN tingkat = 'Tinggi' THEN tindakan_tak_didukung ELSE 0 END), SUM(CASE WHEN tingkat = 'Tinggi' THEN 1 ELSE 0 END)
FROM input GROUP BY id_kedeputian, tanggal
UNION ALL
SELECT 'ID', tanggal, SUM(CASE WHEN bermeter > 0 THEN klaim_tindakan ELSE 0 END), SUM(CASE WHEN bermeter > 0 THEN estimasi_tindakan_alat ELSE 0 END),
       SUM(CASE WHEN tingkat = 'Tinggi' THEN tindakan_tak_didukung ELSE 0 END), SUM(CASE WHEN tingkat = 'Tinggi' THEN 1 ELSE 0 END)
FROM input GROUP BY tanggal"""


def nodes() -> list[dict]:
    S = lambda i, n, g, d: {"id": i, "kind": "source", "name": n, "group": g, "doc": d}  # noqa: E731
    T = lambda i, n, g, inp, sql: {"id": i, "kind": "sql", "name": n, "group": g, "input": inp, "sql": sql}  # noqa: E731
    return [
        S("s_wilayah", "wilayah_jkn", "referensi", "Wilayah: 13 kedeputian (pembagian contoh), 38 provinsi, kabupaten/kota"),
        S("s_rs", "registri_rs_jejaring", "referensi", "RS mitra JKN: kelas, kepemilikan, wilayah, koordinat, tanggal terhubung IoT"),
        S("s_alat", "registri_alat_jejaring", "referensi", "Alat kesehatan seluruh RS (ASPAK) dan meter IoT-nya"),
        S("s_ref", "referensi_tindakan_alat", "referensi", "ICD-9-CM → jenis alat, metode estimasi, durasi & energi per tindakan"),
        S("s_edge", "ringkasan_edge_harian", "iot", "Ringkasan harian per alat yang dihitung gateway IoT tiap RS (edge)"),
        S("s_klaim", "klaim_harian_eklaim", "klaim", "Gudang data e-Klaim: jumlah tindakan penunjang per RS × kode × hari"),
        S("s_pilot_harian", "pemakaian_alat_harian", "pilot", "Pipeline IoT pilot: pemakaian harian (telemetri penuh 2 menit)"),
        S("s_pilot_rekon", "rekonsiliasi_iot_klaim", "pilot", "Pipeline IoT pilot: rekonsiliasi"),
        S("s_pilot_alat", "alat_iot", "pilot", "Pipeline IoT pilot: alat"),
        T("t_param", "parameter_alat_jejaring", "referensi", "s_alat", SQL_PARAM),
        T("t_harian", "pemakaian_harian_jejaring", "iot", "s_edge", SQL_HARIAN),
        T("t_klaim", "klaim_harian_jejaring", "klaim", "s_klaim", SQL_KLAIM),
        T("t_rekon", "rekonsiliasi_jejaring", "rekon", "t_klaim", SQL_REKON),
        T("t_temuan", "temuan_iot_semua", "ontologi", "t_rekon", SQL_TEMUAN),
        T("t_alat", "alat_iot_semua", "ontologi", "t_param", SQL_ALAT),
        T("t_rs", "rs_iot_jejaring", "ontologi", "s_rs", SQL_RS),
        T("t_wilayah", "wilayah_iot", "ontologi", "s_wilayah", SQL_WILAYAH),
        T("t_tren", "tren_iot_harian", "rekon", "t_rekon", SQL_TREN),
    ]


OUTPUTS = [("pemakaian_harian_jejaring", "t_harian"), ("rekonsiliasi_jejaring", "t_rekon"), ("temuan_iot_semua", "t_temuan"), ("alat_iot_semua", "t_alat"),
           ("rs_iot_jejaring", "t_rs"), ("wilayah_iot", "t_wilayah"), ("tren_iot_harian", "t_tren")]
GROUPS = [("iot", "Ringkasan edge gateway RS", "#0ea5e9"), ("klaim", "Gudang data e-Klaim", "#f97316"), ("referensi", "Referensi (wilayah, RS, ASPAK, ICD-9-CM)", "#64748b"),
          ("pilot", "Pipeline IoT pilot (telemetri penuh)", "#14b8a6"), ("rekon", "Rekonsiliasi & tren", "#ef4444"), ("ontologi", "Mendukung Ontologi", "#22c55e")]


def emulate(raw: dict[str, list[dict]], pilot: dict[str, list[dict]]) -> dict[str, list[dict]]:
    import demo_jkn_pipeline as dp

    rows = dp.run({**raw, **pilot}, nodes())
    return {name: rows[next(n["name"] for n in nodes() if n["id"] == node)] for name, node in OUTPUTS}


def content(items: dict[str, str], previews: dict[str, list[dict]], folder: str, uid) -> tuple[dict, dict[str, str]]:
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
    pos = {nid: (60 + 360 * dep, 60 + 160 * i) for dep, ids in cols.items() for i, nid in enumerate(ids)}
    datasets, out_nodes = {}, []
    where = {"pemakaian_alat_harian": "iot", "rekonsiliasi_iot_klaim": "iot", "alat_iot": "iot", "referensi_tindakan_alat": "raw / iot"}
    for n in ns:
        x, y = pos[n["id"]]
        base = {"id": n["id"], "name": n["name"], "x": x, "y": y, "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {PROJECT} / {where.get(n['name'], 'raw / iot_nasional')} / {n['name']}.parquet",
                            "createdAt": now, "refreshedAt": now, "columns": [{"name": c, "type": t} for c, t in dp.schema_of(rows)], "rows": rows[:200],
                            "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            out_nodes.append({**base, "kind": "source", "datasetId": ds, "description": n["doc"]})
        else:
            out_nodes.append({**base, "kind": "transform", "input": n["input"], "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}],
                              **({"checkpoint": True} if n["id"] in ("t_harian", "t_rekon") else {})})
    location = {"id": folder, "name": f"{PROJECT} / iot_nasional"}
    expect = {
        "pemakaian_harian_jejaring": [{"id": uid(), "kind": "unique", "columns": ["id_pemakaian"]}, {"id": uid(), "kind": "rowCount", "min": 1000}],
        "rekonsiliasi_jejaring": [{"id": uid(), "kind": "unique", "columns": ["id_rekon"]}, {"id": uid(), "kind": "notNull", "columns": ["id_kabkota", "id_provinsi"]}],
        "temuan_iot_semua": [{"id": uid(), "kind": "unique", "columns": ["id_temuan"]}],
        "alat_iot_semua": [{"id": uid(), "kind": "unique", "columns": ["id_alat"]}],
        "rs_iot_jejaring": [{"id": uid(), "kind": "unique", "columns": ["kode"]}],
        "wilayah_iot": [{"id": uid(), "kind": "unique", "columns": ["id_wilayah"]}],
        "tren_iot_harian": [{"id": uid(), "kind": "rowCount", "min": 14}],
    }
    xmax = max(x for x, _ in pos.values())
    out_ids = {name: f"o_{node}" for name, node in OUTPUTS}
    outputs = [{"id": out_ids[name], "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": expect[name], "x": xmax + 360, "y": pos[node][1]} for name, node in OUTPUTS]
    text = [
        {"id": "note_n1", "x": 40, "y": -220, "w": 640, "h": 150, "color": "lg-iot",
         "text": "SKALA NASIONAL — tiap RS mengirim satu ringkasan per alat per hari yang dihitung gateway-nya sendiri (siklus, energi aktif, menit "
                 "menyala, menit-mesin, kelengkapan): ±40× lebih kecil dari bacaan 2 menit. Bacaan penuh tetap di arsip gateway dan ditarik saat temuan diperiksa."},
        {"id": "note_n2", "x": 740, "y": -220, "w": 640, "h": 150, "color": "lg-rekon",
         "text": "SATU ATURAN UNTUK SEMUA — rekonsiliasi seluruh jejaring memakai aturan pilot; baris pilot (telemetri penuh) digabung dari pipeline pilot. "
                 "RS belum terhubung tercatat 'tidak dinilai' (cakupan), bukan 'sesuai'."},
        {"id": "note_n3", "x": 1440, "y": -220, "w": 640, "h": 150, "color": "lg-ontologi",
         "text": "WILAYAH — RS → kabupaten/kota → provinsi → kedeputian → nasional: cakupan, nilai tak didukung, RS prioritas, hotspot (≥ 3 RS prioritas "
                 "dan ≥ 40 % RS terhubung di satu kabupaten/kota). Mendukung objek Wilayah, RS jejaring, Alat dan Temuan."},
    ]
    sched = {"id": "jkn-iot-nasional-data", "name": "Bangun ulang saat ringkasan edge / klaim masuk (demo)", "enabled": True, "enabledAt": now,
             "target": "single", "outputs": list(out_ids.values()), "trigger": {"id": "root", "kind": "or", "items": [{"id": "data", "kind": "data"}]},
             "retries": {"count": 1, "delayMinutes": 5}}
    body = {
        "type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": out_nodes, "outputs": outputs,
        "legend": [{"id": f"lg-{g}", "name": name, "hex": hexc} for g, name, hexc in GROUPS], "location": location, "textNodes": text, "schedules": [sched],
        "meta": {"version": 1, "description": "Demo: pemantauan IoT alat medis seluruh RS jejaring JKN — ringkasan edge, rekonsiliasi, RS, wilayah dan hotspot."},
    }
    return body, out_ids


def sync_sql(pid: str) -> list[str]:
    import json

    import drive
    import pipeline_datasets

    item = pipeline_datasets._pipeline_item(pid)
    content_ = json.loads(drive.read_bytes(item))
    want = {n["name"]: n["sql"] for n in nodes() if n["kind"] == "sql"}
    changed = []
    for n in content_.get("nodes") or []:
        if n.get("kind") == "transform" and n.get("name") in want:
            step = next((st for st in n.get("steps") or [] if st.get("kind") == "sql"), None)
            if step and step["params"].get("query") != want[n["name"]]:
                step["params"]["query"] = want[n["name"]]
                changed.append(n["name"])
    if changed:
        content_["updatedAt"] = datetime.now(timezone.utc).isoformat()
        pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=content_))
    return changed


# ------------------------------------------------------------------------------------------------
# the build (demo_jkn_e2e step "iot_nasional", after "iot")
# ------------------------------------------------------------------------------------------------


def _types(fk: dict, alat: dict, temuan: dict) -> dict:
    import demo_jkn_map as jm
    import ontology

    P = jm._p
    made = []
    wil = jm._type(WILAYAH)
    if not wil:
        wil = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=WILAYAH, plural_name=WILAYAH, api_name="WilayahJknDemo", primary_key="id_wilayah", title_property="judul", icon="globe", color="#6366f1",
            description="Demo: wilayah pemantauan JKN — nasional, kedeputian wilayah (pembagian contoh), provinsi, kabupaten/kota — dengan cakupan IoT, "
                        "klaim terpantau, tindakan & nilai tak didukung pemakaian alat, RS per status dan hotspot.",
            properties=[P("id_wilayah", "ID wilayah", render_hints=["searchable", "identifier"]), P("nama", "Nama", render_hints=["searchable"]),
                        P("judul", "Judul", render_hints=["searchable"]), P("tingkat", "Tingkat", render_hints=["selectable"]),
                        P("urutan_tingkat", "Urutan tingkat", "integer"), P("induk", "Wilayah induk (ID)", render_hints=["searchable"]),
                        P("lokasi", "Titik tengah", "geopoint"), P("rs_total", "RS mitra", "integer"), P("rs_terhubung", "RS terhubung IoT", "integer"),
                        P("cakupan_pct", "Cakupan IoT (%)", "double"), P("alat_bermeter", "Alat bermeter", "integer"), P("klaim_14h", "Tindakan diklaim (14 hari)", "integer"),
                        P("klaim_terpantau_14h", "Klaim terpantau alat (14 hari)", "integer"), P("tak_didukung_14h", "Tindakan tak didukung (14 hari)", "integer"),
                        P("nilai_tak_didukung_rp", "Nilai tak didukung (Rp)", "double"), P("rasio_tak_didukung_pct", "Rasio tak didukung (%)", "double"),
                        P("rs_prioritas", "RS prioritas audit", "integer"), P("rs_perhatian", "RS perhatian", "integer"), P("rs_data_kurang", "RS data kurang", "integer"),
                        P("kelengkapan_pct", "Kelengkapan data meter (%)", "double"), P("status_wilayah", "Status wilayah", render_hints=["searchable", "selectable"])]))
        made.append(WILAYAH)
    rs = jm._type(RS)
    if not rs:
        rs = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=RS, plural_name=RS, api_name="RsJejaringIotJknDemo", primary_key="kode", title_property="nama", icon="device", color="#0ea5e9",
            description="Demo: RS mitra JKN di jejaring pemantauan IoT nasional — alat terpasang & bermeter, kelengkapan data, klaim vs pemakaian alat "
                        "14 hari, skor risiko IoT dan status pemantauan. RS pilot terhubung ke Faskes Audit.",
            properties=[P("kode", "Kode RS", render_hints=["searchable", "identifier"]), P("nama", "Nama RS", render_hints=["searchable"]),
                        P("judul", "Judul", render_hints=["searchable"]), P("kelas", "Kelas", render_hints=["selectable"]),
                        P("kepemilikan", "Kepemilikan", render_hints=["selectable"]), P("id_kabkota", "Kabupaten/kota (ID)", render_hints=["searchable"]),
                        P("kabkota", "Kabupaten/kota", render_hints=["searchable", "selectable"]), P("id_provinsi", "Provinsi (ID)"),
                        P("provinsi", "Provinsi", render_hints=["searchable", "selectable"]), P("id_kedeputian", "Kedeputian (ID)"),
                        P("kedeputian", "Kedeputian wilayah", render_hints=["selectable"]), P("kantor_cabang", "Kantor cabang", render_hints=["selectable"]),
                        P("lokasi", "Lokasi", "geopoint"), P("tier", "Tingkat data IoT", render_hints=["selectable"]),
                        P("kode_faskes_audit", "Faskes audit (kode)"), P("terhubung_sejak", "Terhubung IoT sejak", "date"),
                        P("alat_terpasang", "Alat terdaftar (ASPAK)", "integer"), P("alat_bermeter", "Alat bermeter", "integer"),
                        P("kelengkapan_pct", "Kelengkapan data (%)", "double"), P("klaim_tindakan_14h", "Tindakan diklaim (14 hari)", "integer"),
                        P("klaim_terpantau_14h", "Klaim terpantau (14 hari)", "integer"), P("estimasi_alat_14h", "Estimasi tindakan dari alat (14 hari)", "integer"),
                        P("tak_didukung_14h", "Tindakan tak didukung (14 hari)", "integer"), P("nilai_tak_didukung_rp", "Nilai tak didukung (Rp)", "double"),
                        P("nilai_klaim_rp", "Nilai klaim penunjang (Rp)", "double"), P("rasio_tak_didukung_pct", "Rasio tak didukung (%)", "double"),
                        P("rasio_jenis_maks_pct", "Rasio tak didukung jenis alat terburuk (%)", "double"),
                        P("hari_temuan", "Hari temuan (tinggi)", "integer"), P("hari_verifikasi", "Hari perlu verifikasi", "integer"),
                        P("hari_data_kurang", "Hari data kurang", "integer"), P("alat_bermasalah", "Alat bermasalah"),
                        P("skor_risiko_iot", "Skor risiko IoT (0–100)", "double"),
                        P("status_pemantauan", "Status pemantauan", render_hints=["searchable", "selectable"])]))
        made.append(RS)
    with ontology._lock:  # the score is a rounded double (an earlier version declared it an integer)
        r = ontology._object_type(rs["id"])
        p = next((x for x in r["properties"] if x["api_name"] == "skor_risiko_iot"), None)
        if p and p["type"] != "double":
            p["type"] = "double"
            ontology._put("object-types", r)
    links = {
        "induk": jm._link(L_INDUK, wil, "induk", wil, "Wilayah bawahan", "Wilayah induk", arrow_to_source=True),
        "rs_wilayah": jm._link(L_RS_WILAYAH, rs, "id_kabkota", wil, "RS jejaring", "Kabupaten/kota"),
        "rs_faskes": jm._link(L_RS_FASKES, rs, "kode_faskes_audit", fk, "RS jejaring", "Faskes audit"),
        "alat_rs": jm._link(L_ALAT_RS, alat, "kode_faskes", rs, "Alat medis IoT", "RS jejaring"),
        "temuan_rs": jm._link(L_TEMUAN_RS, temuan, "kode_faskes", rs, "Temuan IoT", "RS jejaring"),
        "temuan_wilayah": jm._link(L_TEMUAN_WILAYAH, temuan, "id_kabkota", wil, "Temuan IoT", "Kabupaten/kota"),
    }
    return {"wilayah": wil, "rs": rs, "links": links, "made": made}


def _extend_props(alat: dict, temuan: dict) -> dict:
    """The pilot's device and finding types cover the network: their region properties (before the links that use them)."""
    import ontology

    out: dict = {}
    extra = {alat["id"]: [("tier", "Tingkat data IoT", "string"), ("id_kabkota", "Kabupaten/kota (ID)", "string"), ("kabkota", "Kabupaten/kota", "string"), ("provinsi", "Provinsi", "string"),
                          ("kedeputian", "Kedeputian wilayah", "string")],
             temuan["id"]: [("tier", "Tingkat data IoT", "string"), ("id_kabkota", "Kabupaten/kota (ID)", "string"), ("kabkota", "Kabupaten/kota", "string"),
                            ("id_provinsi", "Provinsi (ID)", "string"), ("provinsi", "Provinsi", "string"), ("id_kedeputian", "Kedeputian (ID)", "string"),
                            ("kedeputian", "Kedeputian wilayah", "string")]}
    with ontology._lock:
        for tid, props in extra.items():
            rec = ontology._object_type(tid)
            have = {p["api_name"] for p in rec["properties"]}
            new = [(a, lbl, ty) for a, lbl, ty in props if a not in have]
            if new:
                rec["properties"] += [{"api_name": a, "display_name": lbl, "type": ty} for a, lbl, ty in new]
                ontology._put("object-types", rec)
                out[rec["display_name"]] = [a for a, _, _ in new]
    return out


def _extend_ts(alat: dict, rs: dict, sync_id: str) -> dict:
    """The device's one time series property (a sensor object type has exactly one) is backed by both syncs — the pilot's
    2-minute power and the network's daily estimated procedures, whose series ids differ (meter ids / device ids) — with
    the unit from each device's `satuan` property; RS jejaring becomes a second root of the sensor."""
    import ontology
    import ts_ontology as tso

    out: dict = {}
    with ontology._lock:
        r = ontology._object_type(alat["id"])
        cfg = dict(r.get("time_series") or {})
        props = {k: dict(v) for k, v in (cfg.get("properties") or {}).items()}
        tsp = props.get("seri_daya") or {}
        changed = False
        if sync_id not in (tsp.get("syncs") or []):
            tsp["syncs"] = [*(tsp.get("syncs") or []), sync_id]
            tsp["description"] = "Daya listrik 2 menit (pilot, satuan W) atau estimasi tindakan harian dari ringkasan edge (jejaring, satuan tindakan/hari)."
            props["seri_daya"] = tsp
            changed = True
        sensor = dict(cfg.get("sensor") or {})
        if sensor.get("unit_property") != "satuan":
            sensor["unit_property"] = "satuan"
            changed = True
        if not any(link.get("root_object_type_id") == rs["id"] for link in sensor.get("links") or []):
            sensor["links"] = [*(sensor.get("links") or []), {"root_object_type_id": rs["id"], "foreign_key": "kode_faskes", "sensor_name_property": "nama_sensor"}]
            changed = True
        if changed:
            r["time_series"] = tso.validate_config(r, {**cfg, "properties": props, "sensor": sensor})
            ontology._put("object-types", r)
            out = {"syncs": tsp["syncs"], "unit_property": "satuan", "roots": [x["root_object_type_id"] for x in sensor["links"]]}
    return out


def _action(rs: dict) -> Optional[str]:
    import demo_jkn_e2e as e
    import ontology

    if e._action(ACTION):
        return None
    with ontology._lock:
        rec = ontology._object_type(rs["id"])
        for api, label, typ in (("catatan_pemantauan", "Catatan pemantauan", "string"), ("tim_pemeriksa", "Tim pemeriksa", "string")):
            if not any(p["api_name"] == api for p in rec["properties"]):
                rec["properties"].append({"api_name": api, "display_name": label, "type": typ, "description": "Diisi lewat action kantor pusat / kedeputian."})
        ontology._put("object-types", rec)
    ontology.create_action_type(ontology.ActionTypeIn(
        display_name=ACTION, object_type_id=rs["id"], kind="modify", status="active",
        description="Kantor pusat / kedeputian menetapkan status pemantauan RS ('Prioritas audit', 'Perhatian', 'Normal', 'Data kurang') dan menugaskan tim.",
        parameters=[ontology.Parameter(id="object", display_name="RS jejaring", type="object", required=True),
                    ontology.Parameter(id="status_pemantauan", display_name="Status pemantauan", type="string", property="status_pemantauan", required=True),
                    ontology.Parameter(id="catatan_pemantauan", display_name="Catatan", type="string", property="catatan_pemantauan", required=True),
                    ontology.Parameter(id="tim_pemeriksa", display_name="Tim pemeriksa", type="string", property="tim_pemeriksa")]))
    return ACTION


def _map(t: dict) -> Optional[str]:
    import geospatial

    if any(m.get("name") == MAP for m in geospatial.list_maps()):
        return None
    rs, wil = t["rs"]["id"], t["wilayah"]["id"]
    layers = [
        geospatial.Layer(name="Kabupaten/kota — hotspot", kind="objects", color="#be123c", opacity=0.9,
                         config={"object_type_id": wil, "property": "lokasi", "filters": [{"property": "status_wilayah", "op": "eq", "value": "Hotspot"},
                                                                                         {"property": "tingkat", "op": "eq", "value": "Kabupaten/Kota"}]}),
        *(geospatial.Layer(name=f"RS — {s}", kind="objects", color=c, opacity=1.0,
                           config={"object_type_id": rs, "property": "lokasi", "filters": [{"property": "status_pemantauan", "op": "eq", "value": s}]})
          for s, c in (("Prioritas audit", "#ef4444"), ("Perhatian", "#f59e0b"), ("Data kurang", "#94a3b8"), ("Normal", "#22c55e"), ("Belum terhubung", "#475569"))),
    ]
    m = geospatial.create_map(geospatial.MapIn(
        name=MAP, basemap="streets", view={"lat": -2.5, "lon": 118.0, "zoom": 5}, layers=layers,
        description="Demo (data fiktif): RS mitra JKN di jejaring pemantauan IoT nasional menurut status — merah prioritas audit, kuning perhatian, abu-abu "
                    "data kurang, hijau normal, gelap belum terhubung — dan kabupaten/kota hotspot. Klik RS untuk skor risiko IoT dan nilai tak didukung."))
    return m["id"]


def _vertex(t: dict, rs_rows: list[dict], wil_rows: list[dict]) -> Optional[str]:
    import vertex

    if any(g["name"] == G_HOTSPOT for g in vertex.list_graphs()):
        return None
    wil, rs = t["wilayah"]["id"], t["rs"]["id"]
    top_kab = [w for w in sorted(wil_rows, key=lambda w: -(w["nilai_tak_didukung_rp"] or 0)) if w["tingkat"] == "Kabupaten/Kota"][:8]
    keep_kab = {w["id_wilayah"] for w in top_kab}
    keep_prov = {w["induk"] for w in top_kab}
    keep_kw = {w["induk"] for w in wil_rows if w["id_wilayah"] in keep_prov}
    nodes = [{"object_type_id": wil, "primary_key": "ID"}]
    nodes += [{"object_type_id": wil, "primary_key": k} for k in sorted(keep_kw | keep_prov | keep_kab)]
    nodes += [{"object_type_id": rs, "primary_key": r["kode"]} for r in rs_rows if r["id_kabkota"] in keep_kab and r["status_pemantauan"] in ("Prioritas audit", "Perhatian")]
    layers = {
        wil: {"color": "#6366f1", "label_property": "nama", "size_property": "nilai_tak_didukung_rp", "icon": "globe",
              "rules": [{"property": "status_wilayah", "op": "eq", "value": "Hotspot", "color": "#be123c"},
                        {"property": "status_wilayah", "op": "eq", "value": "Ada RS prioritas", "color": "#f97316"}]},
        rs: {"color": "#22c55e", "label_property": "nama", "size_property": "skor_risiko_iot", "icon": "device",
             "rules": [{"property": "status_pemantauan", "op": "eq", "value": "Prioritas audit", "color": "#ef4444"},
                       {"property": "status_pemantauan", "op": "eq", "value": "Perhatian", "color": "#f59e0b"}]},
    }
    g = vertex.create_graph(vertex.GraphIn(
        name=G_HOTSPOT, layout="hierarchy_lr", layers=layers, nodes=nodes,
        description="Demo: dari nasional ke kedeputian, provinsi dan 8 kabupaten/kota dengan nilai tak didukung terbesar, sampai RS prioritas / perhatian di "
                    "dalamnya (merah tua: kabupaten/kota hotspot). Klik wilayah untuk cakupan dan nilainya, RS untuk skor risiko IoT."))
    return g["id"]


def _machinery(rs: dict) -> Optional[str]:
    """A third process in Device and Machinery: hospitals' monitoring status, kept from the action's edits."""
    import machinery as mc

    rec = next((r for r in mc._all() if r["name"] == iot.MACHINERY), None)
    if not rec or any(p["object_type_id"] == rs["id"] for p in rec["processes"]):
        return None
    states = ["Belum terhubung", "Normal", "Data kurang", "Perhatian", "Prioritas audit"]
    proc = mc.ProcessIn(name="Status pemantauan RS jejaring", object_type_id=rs["id"], state_property="status_pemantauan",
                        states=[{"id": s, "label": s, "x": 80 + 220 * i, "y": 120 + (60 if i % 2 else 0)} for i, s in enumerate(states)],
                        transitions=[*({"from": mc.START, "to": s} for s in states), *({"from": a, "to": b} for a in states for b in states if a != b)])
    mc.save_resource(rec["id"], mc.MachineryIn(name=rec["name"], description=rec.get("description") or "", auto_layout=False,
                                               processes=[*(mc.ProcessIn(**p) for p in rec["processes"]), proc]))
    mc.setup_log(rec["id"], proc.id, mc.LogSetupIn(from_edits=True))
    return proc.id


def _pilot_inputs() -> dict[str, list[dict]]:
    """The pilot pipeline's outputs as the national pipeline reads them (dates as text, as the emulation stores them)."""
    import io

    import demo_jkn_e2e as e
    import drive
    import pyarrow.parquet as pq

    folder = e._folder(e._folder(None, PROJECT, "project"), "iot")
    out = {}
    for name in ("pemakaian_alat_harian", "rekonsiliasi_iot_klaim", "alat_iot"):
        item = next(f for f in drive.list_files(folder) if f["name"] == f"{name}.parquet" and not f.get("trashed_at"))
        rows = pq.read_table(io.BytesIO(drive.read_bytes(drive._item(item["id"])))).to_pylist()
        out[name] = [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in r.items()} for r in rows]
    return out


def build(state: dict, save) -> dict:
    import time
    import uuid

    import demo_jkn_e2e as e
    import demo_jkn_map as jm
    import demo_jkn_pipeline as dp
    import drive
    import ontology
    import pipeline_datasets
    import pipeline_runtime as rt
    import timeseries

    t0 = time.time()
    out: dict = {}
    project = e._folder(None, PROJECT, "project")
    raw_folder = e._folder(e._folder(project, "raw"), "iot_nasional")
    folder = e._folder(project, "iot_nasional")
    raw, stats = generate()
    out["generated_s"] = round(time.time() - t0, 1)
    out["raw_rows"] = {k: len(v) for k, v in raw.items()}
    out["stats"] = stats
    # deterministic content: replacing is safe, and a changed file fires the pipeline's data trigger
    raw_ids = {name: e._put(raw_folder, name, e._arrow(rows, dp.schema_of(rows)), replace=True) for name, rows in raw.items()}
    pilot = _pilot_inputs()
    iot_folder = e._folder(project, "iot")
    ref_item = next(f["id"] for f in drive.list_files(e._folder(e._folder(project, "raw"), "iot")) if f["name"] == "referensi_tindakan_alat.parquet" and not f.get("trashed_at"))
    ref_rows = iot.generate({})[0]["referensi_tindakan_alat"]
    items = {**raw_ids, "referensi_tindakan_alat": ref_item,
             **{n: next(f["id"] for f in drive.list_files(iot_folder) if f["name"] == f"{n}.parquet" and not f.get("trashed_at")) for n in pilot}}
    t1 = time.time()
    results = emulate({**raw, "referensi_tindakan_alat": ref_rows}, pilot)
    out["emulated_s"] = round(time.time() - t1, 1)
    out["rows"] = {k: len(v) for k, v in results.items()}
    ids = {name: e._put(folder, name, e._arrow(rows, dp.schema_of(rows)), replace=True) for name, rows in results.items()}
    pid = state.get("iot_nasional_pipeline_id")
    if not pid:
        body, out_ids = content(items, {**raw, "referensi_tindakan_alat": ref_rows, **pilot}, folder, lambda: uuid.uuid4().hex[:8])
        made = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=project, content=body))
        pid = made["id"]
        for name, oid in out_ids.items():
            rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": folder, "version": 0, "rows": len(results[name]),
                                                "path": f"{PROJECT} / iot_nasional / {name}.parquet"})
        state["iot_nasional_pipeline_id"] = pid
        save()
    else:
        out["sql_updated"] = sync_sql(pid)
    out["pipeline_id"] = pid
    sync = next((s for s in timeseries.all_syncs("timeseries") if s.get("name") == SYNC), None)
    if not sync:
        sync = timeseries.create_catalog_sync(timeseries.CatalogSyncIn(
            name=SYNC, dataset_id=ids["pemakaian_harian_jejaring"], description="Demo: estimasi tindakan harian per alat dari ringkasan edge seluruh jejaring.",
            mapping=timeseries.Mapping(series_id="id_alat", timestamp="waktu_seri", value="estimasi_tindakan")))
    state["iot_nasional_sync_id"] = sync["id"]
    save()
    out["sync_id"] = sync["id"]
    fk, alat, temuan = jm._type(jm.FASKES), jm._type(iot.ALAT), jm._type(iot.TEMUAN)
    out["extended"] = _extend_props(alat, temuan)
    with ontology._lock:  # a property an earlier version added
        r = ontology._object_type(alat["id"])
        if any(p["api_name"] == "seri_pemakaian" for p in r["properties"]):
            r["properties"] = [p for p in r["properties"] if p["api_name"] != "seri_pemakaian"]
            ontology._put("object-types", r)
    t = _types(fk, ontology._object_type(alat["id"]), ontology._object_type(temuan["id"]))
    out["made"] = t["made"]
    out["time_series"] = _extend_ts(alat, t["rs"], sync["id"])
    out["attached"] = [e._attach(name, ids[ds]) for name, ds in ((WILAYAH, "wilayah_iot"), (RS, "rs_iot_jejaring"), (iot.ALAT, "alat_iot_semua"),
                                                                 (iot.TEMUAN, "temuan_iot_semua"))]
    # a column the finding SQL gained later (label_singkat): the property, then the datasource maps it by name
    import ontology_datasources as ods

    with ontology._lock:
        r = ontology._object_type(temuan["id"])
        new_prop = not any(p["api_name"] == "label_singkat" for p in r["properties"])
        if new_prop:
            r["properties"].append({"api_name": "label_singkat", "display_name": "Label singkat", "type": "string"})
            ontology._put("object-types", r)
    if new_prop:
        ods.put_datasource(temuan["id"], ods.DatasourceIn(dataset_id=ids["temuan_iot_semua"], columns=None))
        out["label_singkat"] = True
    out["action"] = _action(t["rs"])
    import ontology_edits

    if not ontology_edits.config(ontology._object_type(t["rs"]["id"]))["history"]:
        ontology_edits.set_config(t["rs"]["id"], ontology_edits.EditsConfigIn(history=True))
    out["map"] = _map(t)
    out["vertex"] = _vertex(t, results["rs_iot_jejaring"], results["wilayah_iot"])
    out["machinery"] = _machinery(t["rs"])
    nas = next(w for w in results["wilayah_iot"] if w["id_wilayah"] == "ID")
    out["nasional"] = {k: nas[k] for k in ("rs_total", "rs_terhubung", "cakupan_pct", "alat_bermeter", "klaim_terpantau_14h", "tak_didukung_14h",
                                           "nilai_tak_didukung_rp", "rs_prioritas", "rs_perhatian", "rs_data_kurang")}
    out["hotspot"] = [w["nama"] for w in results["wilayah_iot"] if w["status_wilayah"] == "Hotspot"]
    out["total_s"] = round(time.time() - t0, 1)
    return out


# ------------------------------------------------------------------------------------------------
# drill-down: what an auditor pulls from a hospital's gateway archive and from e-Klaim when opening a finding
# ------------------------------------------------------------------------------------------------


def archive(id_alat: str, day: str) -> dict:
    """A national device's day from the gateway archive: the 2-minute readings (as [epoch ms, W] and as raw rows) and the
    cycles the pipeline's session logic finds in them — the evidence behind the edge summary the pipeline received."""
    h, d = world()["by_alat"][id_alat]
    i = [x.isoformat() for x in days()].index(day)
    p, real, _normal = device_day(id_alat, i)
    j = iot.JENIS[d["jenis_alat"]]
    standby, aktif_w, metode = j["standby"], j["aktif"], j["metode"]
    ambang = round(standby + 0.4 * (aktif_w - standby), 1) if metode == "siklus" else 30.0 if metode == "waktu" else round(standby + 0.5 * aktif_w, 1)
    series, rows, sesi = [], [], []
    cur: Optional[dict] = None
    prev_i = -10
    for s, w in enumerate(p):
        if w is None:
            continue
        ts, local = iot._slot_time(date.fromisoformat(day), s)
        series.append([ts * 1000, w])
        rows.append({"id_gateway": f"GW-{h['kode'][3:]}", "id_meter": d["id_meter"], "ts": ts, "waktu_lokal": local, "daya_watt": w, "tegangan_v": None})
        if w >= ambang:
            if cur is None or (s - prev_i) * iot.STEP > 300:
                cur = {"id_sesi": f"{id_alat}-{day}-S{len(sesi) + 1:03d}", "mulai": local, "bacaan_terakhir": local, "mulai_ts": ts, "selesai_ts": ts + 120,
                       "menit": 0, "energi_wh": 0.0, "puncak_w": w}
                sesi.append(cur)
            cur["bacaan_terakhir"], cur["selesai_ts"] = local, ts + 120
            cur["menit"] += 2
            cur["puncak_w"] = max(cur["puncak_w"], w)
            if metode == "siklus":
                cur["energi_wh"] = round(cur["energi_wh"] + round((w - standby) * 120.0 / 3600, 2), 1)
            prev_i = s
        else:
            cur = None
            prev_i = s
    return {"series": series, "rows": rows, "sesi": sesi, "ambang_aktif_w": ambang, "real": real}
