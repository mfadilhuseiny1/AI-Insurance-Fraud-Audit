"""Demo Grid: the synthetic distribution network behind "Grid Management System Intelligence" (demo_grid_e2e.py).

Physically consistent by construction, so the pipeline's energy balance finds what was planted:

- every customer has a *true* daily consumption; theft only lowers what the meter records (or what is billed);
- a distribution transformer (gardu distribusi, DT) delivers Σ true consumption of its customers + illegal
  connections (P4) + the low-voltage network's (JTR) losses; its AMR meter records that;
- a feeder's SCADA meter (NUSAGRID tags DEG.GI01.20KV.Fxx.M.E_IMP, or the city substation's RTU) records Σ DT output
  + transformer losses + true consumption of medium-voltage (TM) customers + the feeder's own line losses;
- P2TL inspections over the past year caught some thefts (they stop on the inspection day and become labels); the
  inspections were mostly chosen by an old "consumption drop" heuristic in residential areas, so the labels are
  biased (TM customers were hardly ever inspected) — the thefts still running in Jul–Sep are the ones not yet caught.

Two substations: "GI Kawasan Demo" is NUSAGRID SCADA's demo estate (6 feeders, 120 industrial tenants, real point
tags and line/transformer parameters from docs/demo-grid/nusagrid_estate_grid.json), "GI Demo Cikarang Kota" is a
synthetic city substation (8 feeders, ~105 DTs, ~5,000 low-voltage customers, ~20 TM customers). All names, people,
companies and numbers are fictional (titled "demo"); the real West Java transmission grid (OpenStreetMap) is context
only and carries no synthetic numbers.

`generate()` returns every raw table (as the source systems would export them) and `truth()` the planted patterns
(kept out of the raw data: the evaluation of the rules and models reads it).
"""

from __future__ import annotations

import json
import math
import random
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "demo-grid"
SEED = 2026
D0, D1 = date(2026, 4, 1), date(2026, 9, 30)
AMI_START = date(2026, 7, 1)  # the AMI rollout reached the pilot on 1 July: 40% of LV customers, every TM customer
DAYS = [D0 + timedelta(days=i) for i in range((D1 - D0).days + 1)]
MONTHS = sorted({d.strftime("%Y-%m") for d in DAYS})
P2TL_FROM = date(2025, 10, 1)

UP3 = ("UP3-DMO", "UP3 Demo Cikarang")
ULP = [("ULP-KWS", "ULP Demo Kawasan Industri"), ("ULP-KTU", "ULP Demo Cikarang Utara"), ("ULP-KTS", "ULP Demo Cikarang Selatan")]
GI_A = {"kode": "GI-KWS", "nama": "GI Kawasan Demo (NUSAGRID)", "lat": -6.3021, "lon": 107.1523, "mva": 120, "ulp": "ULP-KWS",
        "sumber_scada": "NUSAGRID SCADA · IEC 60870-5-104", "rtu": "RTU-GI01"}
GI_B = {"kode": "GI-KTA", "nama": "GI Demo Cikarang Kota", "lat": -6.2585, "lon": 107.1385, "mva": 120, "ulp": "ULP-KTU",
        "sumber_scada": "RTU GI Kota · IEC 60870-5-104", "rtu": "RTU-GIK"}

# tariff (Rp/kWh) per class: the published non-subsidised quarterly tariffs as examples; subsidised S/R1 small classes
TARIF = {
    "R1/450": 415.0, "R1/900-S": 605.0, "R1/900": 1352.0, "R1/1300": 1444.70, "R1/2200": 1444.70, "R2": 1699.53, "R3": 1699.53,
    "B1": 1444.70, "B2": 1444.70, "B3": 1114.74, "I3": 1114.74, "I4": 996.74, "P1": 1699.53, "P2": 1522.88, "P3": 1699.53,
    "S2": 900.0, "S3": 900.0,
}
WBP_FACTOR = 1.5  # TM tariffs: peak hours (WBP 17:00–22:00) cost K × the off-peak (LWBP) price

FIRST = ["Agus", "Budi", "Citra", "Dedi", "Eka", "Fitri", "Gilang", "Hana", "Iwan", "Joko", "Kurnia", "Lina", "Mulyadi", "Nur", "Oktavia",
         "Putra", "Rina", "Slamet", "Tuti", "Udin", "Vina", "Wawan", "Yanti", "Zainal", "Asep", "Dadang", "Euis", "Ujang", "Neneng", "Cecep"]
LAST = ["Contoh", "Saputra", "Hidayat", "Sukmana", "Permana", "Lestari", "Rahmawati", "Kurniawan", "Wibowo", "Nugraha", "Setiawan", "Suryana"]
JALAN = ["Jl. Contoh Raya", "Jl. Melati Demo", "Jl. Kenanga Demo", "Jl. Industri Contoh", "Jl. Pasar Demo", "Jl. Sawo Demo", "Jl. Mangga Demo",
         "Jl. Cempaka Demo", "Perum Contoh Asri", "Perum Demo Indah"]
KEC = {"ULP-KTU": "Cikarang Utara", "ULP-KTS": "Cikarang Selatan", "ULP-KWS": "Cikarang Pusat"}
COMPANY = ["Plastik", "Logam", "Tekstil", "Makanan", "Kimia", "Elektronik", "Otomotif", "Kemasan", "Farmasi", "Kertas", "Keramik", "Mebel"]
COMPANY2 = ["Nusantara", "Jaya", "Abadi", "Mandiri", "Sejahtera", "Perkasa", "Utama", "Prima", "Makmur", "Sentosa"]


def _r(seed_part: Any) -> random.Random:
    return random.Random(f"{SEED}:{seed_part}")


@lru_cache(maxsize=1)
def nusagrid() -> dict:
    return json.loads((ASSETS / "nusagrid_estate_grid.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def osm() -> dict:
    return json.loads((ASSETS / "jabar_transmisi_osm.geojson").read_text(encoding="utf-8"))


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((a[0] - b[0]) * 110.6, (a[1] - b[1]) * 110.6 * math.cos(math.radians(a[0])))


def _move(lat: float, lon: float, bearing_deg: float, km: float) -> tuple[float, float]:
    b = math.radians(bearing_deg)
    return lat + km * math.cos(b) / 110.6, lon + km * math.sin(b) / (110.6 * math.cos(math.radians(lat)))


def nearest_gitet(lat: float, lon: float) -> tuple[str, float]:
    """The nearest real (OpenStreetMap) 500 kV substation: the supply context of a demo substation."""
    best = ("-", 1e9)
    for f in osm()["features"]:
        p = f["properties"]
        if p.get("jenis") != "gardu" or p.get("kelas_kv") != 500 or not p.get("nama"):
            continue
        d = _km((lat, lon), (p["lat"], p["lon"]))
        if d < best[1]:
            best = (p["nama"], d)
    return best[0], round(best[1], 1)


# ------------------------------------------------------------------------------------------------
# load shapes
# ------------------------------------------------------------------------------------------------

# share of a day's energy in the evening peak (WBP 17–22) and at night (22–06), per profile
SHAPE = {
    "rumah": (0.34, 0.33), "bisnis": (0.22, 0.10), "industri_3shift": (0.21, 0.33), "industri_1shift": (0.08, 0.10),
    "gudang": (0.15, 0.18), "komersial": (0.24, 0.12), "lembaga": (0.10, 0.08), "pju": (0.42, 0.58), "kripto": (0.21, 0.33),
}
WEEKEND = {"rumah": 1.08, "bisnis": 0.9, "industri_3shift": 0.88, "industri_1shift": 0.45, "gudang": 0.75, "komersial": 1.1,
           "lembaga": 0.35, "pju": 1.0, "kripto": 1.0}
LOAD_FACTOR = {"rumah": 0.42, "bisnis": 0.38, "industri_3shift": 0.82, "industri_1shift": 0.45, "gudang": 0.5, "komersial": 0.52,
               "lembaga": 0.33, "pju": 0.5, "kripto": 0.96}


def _day_factor(profile: str, d: date, rnd: random.Random) -> float:
    f = WEEKEND[profile] if d.weekday() >= 5 else 1.0
    if d == date(2026, 8, 17) and profile not in ("rumah", "pju", "kripto"):
        f *= 0.3  # Independence Day
    season = 1.0 + 0.04 * math.sin((d.timetuple().tm_yday - 120) / 365 * 2 * math.pi)
    return max(0.0, f * season * (1 + rnd.gauss(0, 0.08 if profile.startswith("industri") else 0.13)))


# ------------------------------------------------------------------------------------------------
# network: substations, feeders, distribution transformers
# ------------------------------------------------------------------------------------------------

def _line(lat: float, lon: float, bearing: float, km: float, steps: int, rnd: random.Random) -> list[tuple[float, float]]:
    pts = [(lat, lon)]
    for _ in range(steps):
        bearing += rnd.uniform(-25, 25)
        lat, lon = _move(lat, lon, bearing, km / steps)
        pts.append((lat, lon))
    return pts


def _geojson_line(pts: list[tuple[float, float]]) -> str:
    return json.dumps({"type": "LineString", "coordinates": [[round(lo, 5), round(la, 5)] for la, lo in pts]})


def _along(pts: list[tuple[float, float]], t: float) -> tuple[float, float]:
    t = min(max(t, 0.0), 1.0) * (len(pts) - 1)
    i = min(int(t), len(pts) - 2)
    f = t - i
    return pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f


@lru_cache(maxsize=1)
def network() -> dict:
    """Substations, feeders (with geometry and line parameters) and distribution transformers."""
    ng = nusagrid()
    eq = ng["equipment"]
    seg = {}
    for e in eq:
        if e["type"] == "ac_line_segment" and e["bay"].startswith("F"):
            s = seg.setdefault(e["bay"], {"km": 0.0, "r": 0.0, "x": 0.0, "amp": 0})
            a = e["attributes"]
            s["km"] += a["lengthKm"]
            s["r"] = a["rOhmPerKm"]
            s["x"] = a["xOhmPerKm"]
            s["amp"] = a["ampacityA"]
    trafo = next(e for e in eq if e["type"] == "power_transformer")["attributes"]
    feeders, dts = [], []
    rnd = _r("network")
    # the estate: six feeders fanning out from the estate substation (NUSAGRID's lengths and conductor)
    for i, fc in enumerate(sorted(seg)):
        s = seg[fc]
        pts = _line(GI_A["lat"], GI_A["lon"], 200 + i * 28, s["km"], 5, rnd)
        feeders.append({"kode": f"KWS-{fc}", "kode_scada": fc, "nama": f"Penyulang {fc} Kawasan Demo", "kode_gi": GI_A["kode"], "kode_ulp": "ULP-KWS",
                        "jenis": "SUTM", "panjang_km": round(s["km"], 3), "r_ohm_km": s["r"], "x_ohm_km": s["x"], "kha_a": s["amp"],
                        "tag_kwh": f"DEG.GI01.20KV.{fc}.M.E_IMP", "tag_p": f"DEG.GI01.20KV.{fc}.M.P", "pts": pts, "segmen": "Kawasan industri"})
    # the city: eight feeders, 11–15 DTs each
    for i in range(8):
        fc = f"K{i + 1:02d}"
        km = rnd.uniform(6.5, 11.5)
        bearing = -40 + i * 45 + rnd.uniform(-8, 8)
        pts = _line(GI_B["lat"], GI_B["lon"], bearing, km, 7, rnd)
        ulp = "ULP-KTU" if i < 4 else "ULP-KTS"
        sktm = i in (1, 5)
        feeders.append({"kode": f"KTA-{fc}", "kode_scada": fc, "nama": f"Penyulang {fc} Cikarang Kota", "kode_gi": GI_B["kode"], "kode_ulp": ulp,
                        "jenis": "SKTM" if sktm else "SUTM", "panjang_km": round(km, 3), "r_ohm_km": 0.125 if sktm else 0.216,
                        "x_ohm_km": 0.10 if sktm else 0.33, "kha_a": 400 if sktm else 425,
                        "tag_kwh": f"DEM.GIK.20KV.{fc}.M.E_IMP", "tag_p": f"DEM.GIK.20KV.{fc}.M.P", "pts": pts,
                        "segmen": "Campuran" if i in (2, 6) else "Perkotaan"})
        for j in range(rnd.randint(11, 15)):
            t = (j + 1) / 16 + rnd.uniform(-0.02, 0.02)
            la, lo = _along(pts, t)
            la, lo = _move(la, lo, rnd.uniform(0, 360), rnd.uniform(0.05, 0.4))
            n_pel = rnd.randint(38, 72)
            kva = 50 if n_pel < 50 else 100  # pole-mounted transformers sized to the houses they serve
            year = rnd.choice([1992, 1996, 2001, 2006, 2009, 2012, 2014, 2016, 2018, 2020, 2022, 2024])
            dts.append({"kode_dt": f"DT-{fc}-{j + 1:02d}", "nama": f"Gardu {fc}-{j + 1:02d}", "kode_penyulang": f"KTA-{fc}", "kode_ulp": ulp,
                        "kva": kva, "tahun_pasang": year,
                        # no-load (iron) and load (copper) losses of an SPLN-class transformer; old units lose more iron
                        "rugi_besi_w": round((kva * 2.6 + 20) * (1.35 if year < 2000 else 1.0) + rnd.uniform(-6, 6)), "rugi_tembaga_w": round(kva * 15.5),
                        "n_pelanggan": n_pel,
                        "panjang_jtr_km": round(rnd.uniform(0.6, 1.6), 2), "r_jtr_ohm_km": rnd.choice([0.443, 0.443, 0.320, 0.253]),
                        "lat": round(la, 6), "lon": round(lo, 6), "pos": t})
    return {"gi": [GI_A, GI_B], "feeders": feeders, "dts": dts, "trafo_gi": trafo}


# ------------------------------------------------------------------------------------------------
# customers
# ------------------------------------------------------------------------------------------------

LV_MIX = [  # (tariff, VA, segment, profile, base kWh/day, weight)
    ("R1/450", 450, "Rumah tangga", "rumah", 1.6, 0.05), ("R1/900-S", 900, "Rumah tangga", "rumah", 2.8, 0.10),
    ("R1/900", 900, "Rumah tangga", "rumah", 3.6, 0.20), ("R1/1300", 1300, "Rumah tangga", "rumah", 5.2, 0.24),
    ("R1/2200", 2200, "Rumah tangga", "rumah", 8.1, 0.15), ("R2", 4400, "Rumah tangga", "rumah", 14.5, 0.06),
    ("R3", 7700, "Rumah tangga", "rumah", 27.0, 0.015), ("B1", 2200, "Bisnis", "bisnis", 7.5, 0.08),
    ("B2", 16500, "Bisnis", "bisnis", 62.0, 0.03), ("P1", 13200, "Pemerintah", "lembaga", 38.0, 0.012),
    ("S2", 5500, "Sosial", "lembaga", 11.0, 0.023),
]
LEMBAGA = {"P1": ["Kantor Desa Demo", "Kantor Kecamatan Demo", "Puskesmas Pembantu Demo", "Kantor UPTD Demo"],
           "S2": ["SD Negeri Demo", "Yayasan Pendidikan Demo", "Panti Asuhan Demo", "Madrasah Demo", "Posyandu Demo"],
           "P2": ["Kantor Dinas Demo", "RSUD Demo Cikarang"], "S3": ["Kampus Demo Cikarang"]}


def _person(rnd: random.Random) -> str:
    return f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"


def _nik(rnd: random.Random) -> str:
    return "3216" + "".join(str(rnd.randint(0, 9)) for _ in range(12))


@lru_cache(maxsize=1)
def customers() -> list[dict]:
    """Every customer with its technical and identity attributes (the identity goes to a separate, PII file)."""
    net = network()
    rnd = _r("customers")
    out: list[dict] = []
    seq = 0

    def new(**kw) -> dict:
        nonlocal seq
        seq += 1
        c = {"id_pelanggan": f"5382{seq:08d}", "no_meter": f"{rnd.randint(10, 99)}{rnd.randint(100000000, 999999999)}", **kw}
        out.append(c)
        return c

    # LV customers on the city DTs
    for dt in net["dts"]:
        for _ in range(dt["n_pelanggan"]):
            tarif, va, seg, prof, base, _w = rnd.choices(LV_MIX, weights=[m[5] for m in LV_MIX])[0]
            la, lo = _move(dt["lat"], dt["lon"], rnd.uniform(0, 360), rnd.uniform(0.02, dt["panjang_jtr_km"] * 0.7))
            nama = _person(rnd)
            if tarif in LEMBAGA:
                nama = f"{rnd.choice(LEMBAGA[tarif])} {rnd.randint(1, 30):02d}"
            elif seg == "Bisnis":
                nama = f"{rnd.choice(['Toko', 'Warung', 'Ruko', 'Bengkel', 'Laundry', 'Apotek'])} {rnd.choice(FIRST)} Demo"
            prabayar = seg == "Rumah tangga" and va <= 2200 and rnd.random() < 0.62
            new(nama=nama, tarif=tarif, daya_va=va, segmen=seg, profil=prof, base_kwh=base * rnd.uniform(0.55, 1.6), tegangan="TR",
                fase=3 if va >= 7700 else 1, kode_dt=dt["kode_dt"], kode_penyulang=dt["kode_penyulang"], kode_ulp=dt["kode_ulp"],
                lat=round(la, 6), lon=round(lo, 6), jenis_meter="prabayar" if prabayar else "pascabayar", ami=False,
                petugas_baca="" if prabayar else f"PB-{dt['kode_penyulang'][-3:]}-{rnd.randint(1, 3)}",
                faktor_kali=1.0, ct_terpasang="", daya_kontrak_kva=round(va / 1000, 1))
        # one street-lighting (PJU) account per DT, billed on a fixed load (abonemen) in this demo
        la, lo = _move(dt["lat"], dt["lon"], rnd.uniform(0, 360), 0.1)
        new(nama=f"PJU Pemkab Demo {dt['kode_dt']}", tarif="P3", daya_va=rnd.choice([3500, 5500, 7700]), segmen="PJU", profil="pju",
            base_kwh=rnd.uniform(18, 40), tegangan="TR", fase=1, kode_dt=dt["kode_dt"], kode_penyulang=dt["kode_penyulang"], kode_ulp=dt["kode_ulp"],
            lat=round(la, 6), lon=round(lo, 6), jenis_meter="pascabayar", ami=False, petugas_baca=f"PB-{dt['kode_penyulang'][-3:]}-1",
            faktor_kali=1.0, ct_terpasang="", daya_kontrak_kva=5.5)
    # the AMI rollout: 40% of LV customers, chosen by DT (whole neighbourhoods at once) plus a few individually
    dts_ami = {dt["kode_dt"] for dt in net["dts"] if rnd.random() < 0.38}
    for c in out:
        if c["kode_dt"] in dts_ami or rnd.random() < 0.04:
            c["ami"] = True
    # TM customers on the city feeders
    city = [f for f in net["feeders"] if f["kode_gi"] == GI_B["kode"]]
    for i in range(22):
        f = city[i % len(city)]
        kind = rnd.choice(["B3", "B3", "I3", "I3", "I3", "P2", "S3"]) if i >= 3 else ["P2", "S3", "B3"][i]
        kva = rnd.choice([345, 555, 865, 1110, 1385, 1730]) if kind != "I3" else rnd.choice([555, 865, 1110, 1730, 2180])
        la, lo = _along(f["pts"], rnd.uniform(0.15, 0.95))
        la, lo = _move(la, lo, rnd.uniform(0, 360), rnd.uniform(0.05, 0.3))
        if kind in LEMBAGA:
            nama, seg, prof = f"{rnd.choice(LEMBAGA[kind])} {i:02d}", "Pemerintah" if kind == "P2" else "Sosial", "lembaga"
        elif kind == "B3":
            nama, seg, prof = f"{rnd.choice(['Mal', 'Hotel', 'Pusat Grosir', 'Gedung Kantor'])} Demo {rnd.choice(COMPANY2)}", "Bisnis", "komersial"
        else:
            nama, seg, prof = f"PT Contoh {rnd.choice(COMPANY)} {rnd.choice(COMPANY2)}", "Industri", rnd.choice(["industri_1shift", "industri_3shift"])
        ct = rnd.choice([50, 75, 100, 150, 200])
        new(nama=nama, tarif=kind, daya_va=kva * 1000, segmen=seg, profil=prof, base_kwh=kva * 24 * LOAD_FACTOR[prof] * rnd.uniform(0.45, 0.7),
            tegangan="TM", fase=3, kode_dt="", kode_penyulang=f["kode"], kode_ulp=f["kode_ulp"], lat=round(la, 6), lon=round(lo, 6),
            jenis_meter="AMR TM", ami=True, petugas_baca="", faktor_kali=float(ct / 5 * 200), ct_terpasang=f"{ct}/5 A",
            daya_kontrak_kva=kva)
    # the estate's 120 tenants (NUSAGRID energy consumers), metered at 20 kV
    prof_map = {"industrial_1shift": "industri_1shift", "industrial_3shift": "industri_3shift", "warehouse": "gudang", "commercial": "komersial"}
    estate = {f["kode_scada"]: f for f in net["feeders"] if f["kode_gi"] == GI_A["kode"]}
    for e in sorted((x for x in nusagrid()["equipment"] if x["type"] == "energy_consumer"), key=lambda x: x["bay"]):
        a = e["attributes"]
        fc = e["bay"][:3]
        f = estate[fc]
        k = int(e["bay"][-2:])
        la, lo = _along(f["pts"], 0.15 + 0.8 * k / 21)
        la, lo = _move(la, lo, rnd.uniform(0, 360), rnd.uniform(0.03, 0.12))
        prof = prof_map.get(a.get("profile"), "industri_1shift")
        kva = round(a["pNominalMw"] * 1000 / 0.85 / 5) * 5
        seg = "Industri" if prof.startswith("industri") or prof == "gudang" else "Bisnis"
        kind = "I3" if seg == "Industri" else "B3"
        pfx = {"industri_1shift": "PT Contoh", "industri_3shift": "PT Contoh", "gudang": "Gudang Demo", "komersial": "Pusat Niaga Demo"}[prof]
        nama = f"{pfx} {rnd.choice(COMPANY)} {rnd.choice(COMPANY2)} ({a.get('tenant')})" if pfx == "PT Contoh" else f"{pfx} {rnd.choice(COMPANY2)} ({a.get('tenant')})"
        ct = rnd.choice([50, 75, 100, 150])
        new(nama=nama, tarif=kind, daya_va=kva * 1000, segmen=seg, profil=prof, base_kwh=a["pNominalMw"] * 1000 * 24 * LOAD_FACTOR[prof] * rnd.uniform(0.62, 0.78),
            tegangan="TM", fase=3, kode_dt="", kode_penyulang=f["kode"], kode_ulp="ULP-KWS", lat=round(la, 6), lon=round(lo, 6),
            jenis_meter="AMR TM", ami=True, petugas_baca="", faktor_kali=float(ct * 200 / 5), ct_terpasang=f"{ct}/5 A",
            daya_kontrak_kva=kva, tag_scada=f"DEG.DIST.20KV.{e['bay']}.MT.E_IMP", tenant=a.get("tenant"))
    for c in out:
        c.setdefault("tag_scada", "")
        c.setdefault("tenant", "")
        r2 = _r("id:" + c["id_pelanggan"])
        c["nik"] = _nik(r2) if c["segmen"] in ("Rumah tangga", "Bisnis") else ""
        c["alamat"] = f"{r2.choice(JALAN)} No. {r2.randint(1, 180)}, Kec. {KEC[c['kode_ulp']]}, Kab. Bekasi (alamat contoh)"
        c["telepon"] = f"08{r2.randint(11, 99)}{r2.randint(10000000, 99999999)}"
        c["tgl_pasang"] = (date(2008, 1, 1) + timedelta(days=r2.randint(0, 6500))).isoformat()
    return out


# ------------------------------------------------------------------------------------------------
# planted patterns (theft, technical-loss causes, confounders)
# ------------------------------------------------------------------------------------------------

PATTERNS = {
    "NTL-01": ("NTL", "Bypass meter (sambungan langsung)", "P-II"),
    "NTL-02": ("NTL", "Magnet / tamper meter", "P-II"),
    "NTL-03": ("NTL", "Sambungan liar bukan pelanggan", "P-IV"),
    "NTL-04": ("NTL", "Pembatas daya prabayar diakali", "P-I"),
    "NTL-05": ("NTL", "Faktor kali CT salah di sistem tagihan", "Administratif"),
    "NTL-06": ("NTL", "Stand meter macet / tagihan estimasi", "Administratif"),
    "NTL-07": ("NTL", "Manipulasi CT/PT pelanggan TM", "P-II"),
    "NTL-08": ("NTL", "Sambungan sebelum kubikel meter", "P-II"),
    "NTL-09": ("NTL", "Tarif sosial/pemerintah dipakai untuk usaha", "Administratif"),
    "NTL-10": ("NTL", "Register WBP/LWBP digeser", "P-II"),
    "NTL-11": ("NTL", "Listrik disalurkan ulang ke penyewa/tetangga", "P-I"),
    "NTL-12": ("NTL", "Pemakaian melebihi daya kontrak", "P-I"),
    "NTL-13": ("NTL", "Kolusi baca meter", "Internal"),
    "NTL-14": ("NTL", "Bypass tiga fasa untuk crypto mining", "P-II"),
    "TL-01": ("TL", "Trafo distribusi overload", "Teknis"),
    "TL-02": ("TL", "Beban fasa tidak seimbang", "Teknis"),
    "TL-03": ("TL", "JTR terlalu panjang / penampang kecil", "Teknis"),
    "TL-04": ("TL", "Faktor daya penyulang rendah", "Teknis"),
    "TL-05": ("TL", "Trafo tua (rugi besi tinggi)", "Teknis"),
    "X-01": ("Pengecoh", "Rumah kosong / musiman", "-"),
    "X-02": ("Pengecoh", "Meter rusak (bukan pelanggaran)", "-"),
    "X-03": ("Pengecoh", "PLTS atap pelanggan", "-"),
    "X-04": ("Pengecoh", "Libur produksi / pengurangan shift", "-"),
    "X-05": ("Pengecoh", "PLTS atap / efisiensi industri", "-"),
}


@lru_cache(maxsize=1)
def plant() -> dict:
    """Which customer / DT / feeder carries which pattern, from when, and how strongly."""
    rnd = _r("plant")
    cs = customers()
    net = network()
    lv = [c for c in cs if c["tegangan"] == "TR" and c["segmen"] != "PJU"]
    tm_city = [c for c in cs if c["tegangan"] == "TM" and c["kode_ulp"] != "ULP-KWS"]
    tm_estate = [c for c in cs if c["kode_ulp"] == "ULP-KWS"]
    used: set[str] = set()
    out: dict[str, list[dict]] = {}

    def pick(pool: list[dict], n: int, cond=lambda c: True) -> list[dict]:
        cand = [c for c in pool if c["id_pelanggan"] not in used and cond(c)]
        got = rnd.sample(cand, min(n, len(cand)))
        used.update(c["id_pelanggan"] for c in got)
        return got

    def start(lo: date, hi: date) -> date:
        return lo + timedelta(days=rnd.randint(0, (hi - lo).days))

    def add(code: str, c: dict, **kw) -> None:
        out.setdefault(code, []).append({"id_pelanggan": c["id_pelanggan"], **kw})

    for c in pick(lv, 55, lambda c: c["segmen"] in ("Rumah tangga", "Bisnis") and c["jenis_meter"] == "pascabayar"):
        add("NTL-01", c, mulai=start(date(2025, 6, 1), date(2026, 8, 20)), porsi=rnd.uniform(0.55, 0.9))
    for c in pick(lv, 30, lambda c: c["segmen"] in ("Rumah tangga", "Bisnis")):
        add("NTL-02", c, mulai=start(date(2025, 9, 1), date(2026, 8, 10)), porsi=rnd.uniform(0.35, 0.65))
    for c in pick(lv, 18, lambda c: c["jenis_meter"] == "prabayar"):
        add("NTL-04", c, mulai=start(date(2025, 10, 1), date(2026, 7, 1)), porsi=0.0, lebih_daya=rnd.uniform(1.4, 2.2))
    for c in pick(lv, 14, lambda c: c["jenis_meter"] == "pascabayar" and not c["ami"]):
        add("NTL-06", c, mulai=start(date(2026, 3, 1), date(2026, 7, 15)), porsi=rnd.uniform(0.4, 0.7))
    for c in pick(lv, 6, lambda c: c["tarif"] == "S2"):
        add("NTL-09", c, mulai=date(2025, 1, 1), porsi=0.0, kali_beban=rnd.uniform(3.0, 5.0), tarif_benar="B2")
    for c in pick(lv, 5, lambda c: c["segmen"] in ("Rumah tangga", "Pemerintah") and c["daya_va"] >= 2200):
        add("NTL-11", c, mulai=date(2025, 12, 1), porsi=0.0, kali_beban=rnd.uniform(2.5, 3.8))
    for c in pick(lv, 3, lambda c: c["segmen"] == "Bisnis" and c["jenis_meter"] == "pascabayar"):
        add("NTL-14", c, mulai=start(date(2026, 6, 10), date(2026, 7, 20)), porsi=0.97, beban_kw=rnd.uniform(6.5, 11.0))
    # collusion: one meter reader under-reads 16 postpaid customers without AMI on his route
    route = "PB-K06-2"  # a new meter reader took this route on 1 July
    for c in pick(lv, 16, lambda c: c["petugas_baca"] == route and not c["ami"]):
        add("NTL-13", c, mulai=date(2026, 7, 1), porsi=rnd.uniform(0.45, 0.6))
    # TM: estate tenants and city TM customers
    for c in pick(tm_estate, 3) + pick(tm_city, 2):
        add("NTL-07", c, mulai=start(date(2026, 1, 15), date(2026, 8, 1)), porsi=1 / 3, fasa=rnd.choice(["L1", "L2", "L3"]),
            cara=rnd.choice(["shunt sekunder CT", "fuse PT dibuka"]))
    for c in pick(tm_estate, 3):
        add("NTL-08", c, mulai=start(date(2025, 11, 1), date(2026, 7, 10)), porsi=rnd.uniform(0.3, 0.45))
    for c in pick(tm_estate, 2) + pick(tm_city, 1):
        add("NTL-05", c, mulai=date(2024, 5, 1), porsi=0.5)  # billing multiplies by half the CT ratio
    for c in pick(tm_estate, 3, lambda c: c["profil"] == "industri_3shift") + pick(tm_city, 1, lambda c: c["segmen"] == "Industri"):
        add("NTL-10", c, mulai=start(date(2025, 12, 1), date(2026, 6, 1)), porsi=0.0, porsi_wbp=rnd.uniform(0.02, 0.05))
    for c in pick(tm_estate, 4) + pick(tm_city, 2):
        add("NTL-12", c, mulai=date(2026, 1, 1), porsi=0.0, kali_dmd=rnd.uniform(1.18, 1.45))
    # confounders
    for c in pick(lv, 30, lambda c: c["segmen"] == "Rumah tangga"):
        add("X-01", c, mulai=start(date(2026, 4, 15), date(2026, 8, 15)), porsi=rnd.uniform(0.75, 0.95))
    for c in pick(lv, 15):
        add("X-02", c, mulai=start(date(2026, 4, 1), date(2026, 8, 25)), porsi=1.0)
    for c in pick(lv, 25, lambda c: c["daya_va"] >= 2200):
        add("X-03", c, mulai=start(date(2025, 6, 1), date(2026, 8, 1)), porsi=rnd.uniform(0.3, 0.55))
    for c in pick(tm_estate, 8):
        add("X-04", c, mulai=start(date(2026, 7, 5), date(2026, 8, 25)), porsi=rnd.uniform(0.45, 0.7), lama_hari=rnd.randint(12, 30))
    for c in pick(tm_estate, 6):
        add("X-05", c, mulai=start(date(2025, 9, 1), date(2026, 7, 15)), porsi=rnd.uniform(0.15, 0.3))
    # DT-level: illegal connections and technical causes
    dts = net["dts"]
    dt_used: set[str] = set()

    def pick_dt(n: int, cond=lambda d: True) -> list[dict]:
        cand = [d for d in dts if d["kode_dt"] not in dt_used and cond(d)]
        got = rnd.sample(cand, min(n, len(cand)))
        dt_used.update(d["kode_dt"] for d in got)
        return got

    dt_out: dict[str, list[dict]] = {}
    for d in pick_dt(7):
        dt_out.setdefault("NTL-03", []).append({"kode_dt": d["kode_dt"], "mulai": start(date(2025, 8, 1), date(2026, 7, 1)), "kwh_hari": rnd.uniform(25, 90)})
    for d in pick_dt(11, lambda d: d["kva"] <= 200):
        dt_out.setdefault("TL-01", []).append({"kode_dt": d["kode_dt"], "kali_beban": rnd.uniform(1.25, 1.6)})
    for d in pick_dt(14):
        dt_out.setdefault("TL-02", []).append({"kode_dt": d["kode_dt"], "rasio_netral": rnd.uniform(0.38, 0.65)})
    for d in pick_dt(10):
        d["panjang_jtr_km"] = round(rnd.uniform(2.1, 3.0), 2)
        dt_out.setdefault("TL-03", []).append({"kode_dt": d["kode_dt"], "panjang_jtr_km": d["panjang_jtr_km"]})
    for d in [d for d in dts if d["tahun_pasang"] < 2000]:
        dt_out.setdefault("TL-05", []).append({"kode_dt": d["kode_dt"], "tahun_pasang": d["tahun_pasang"]})
    fd_out = {"TL-04": [{"kode_penyulang": "KTA-K03", "pf": 0.78}, {"kode_penyulang": "KTA-K07", "pf": 0.8}]}
    return {"pelanggan": out, "gardu": dt_out, "penyulang": fd_out}


def _by_customer() -> dict[str, list[tuple[str, dict]]]:
    m: dict[str, list[tuple[str, dict]]] = {}
    for code, rows in plant()["pelanggan"].items():
        for r in rows:
            m.setdefault(r["id_pelanggan"], []).append((code, r))
    return m


# ------------------------------------------------------------------------------------------------
# P2TL history: which thefts were caught (they stop then) — selection biased toward residential drops
# ------------------------------------------------------------------------------------------------

@lru_cache(maxsize=1)
def p2tl() -> list[dict]:
    rnd = _r("p2tl")
    cs = customers()
    by = _by_customer()
    theft = {"NTL-01", "NTL-02", "NTL-04", "NTL-14", "NTL-07", "NTL-08", "NTL-11"}
    rows = []
    lv_city = [c for c in cs if c["tegangan"] == "TR" and c["segmen"] != "PJU"]
    tm = [c for c in cs if c["tegangan"] == "TM"]
    day = P2TL_FROM
    seq = 0
    while day < D1 - timedelta(days=10):
        for _ in range(rnd.randint(1, 3)):
            r = rnd.random()
            if r < 0.68:
                basis = "Analisa TO (penurunan pemakaian)"
                # the old heuristic: residential/business customers whose postpaid bill dropped — or looked like it
                cand = [c for c in rnd.sample(lv_city, 60) if c["segmen"] == "Rumah tangga" or c["segmen"] == "Bisnis"]
                pool_hit = [c for c in cand if any(code in theft and pr["mulai"] <= day for code, pr in by.get(c["id_pelanggan"], []))]
                c = pool_hit[0] if pool_hit and rnd.random() < 0.55 else cand[0]
            elif r < 0.82:
                basis = "Laporan petugas / masyarakat"
                tips = [x for x in rnd.sample(lv_city, 200) if any(code in theft and pr["mulai"] <= day and not pr.get("ditertibkan")
                                                                    for code, pr in by.get(x["id_pelanggan"], []))]
                c = tips[0] if tips and rnd.random() < 0.35 else rnd.choice(lv_city)
            elif r < 0.9:
                basis, c = "Pemeriksaan rutin TM", rnd.choice(tm)
            else:
                basis, c = "Sampel acak (kendali mutu)", rnd.choice(cs)
            seq += 1
            gol, temuan, kwh_ts = "Tidak ada pelanggaran", "Segel dan meter sesuai.", 0.0
            for code, pr in by.get(c["id_pelanggan"], []):
                if pr["mulai"] > day or pr.get("ditertibkan"):
                    continue
                if code in theft and rnd.random() < (0.88 if c["tegangan"] == "TR" else 0.55):
                    gol = PATTERNS[code][2]
                    temuan = {"NTL-01": "Kabel jumper melewati kWh meter.", "NTL-02": "Ada magnet / segel rusak, putaran meter melambat.",
                              "NTL-04": "Pembatas daya MCB diganti lebih besar.", "NTL-14": "Sambungan tiga fasa langsung ke instalasi; perangkat penambang kripto.",
                              "NTL-07": "Terminal sekunder CT dihubung singkat pada satu fasa.", "NTL-08": "Sambungan kabel sebelum kubikel APP.",
                              "NTL-11": "Instalasi disambung ke bangunan lain (penyaluran ulang)."}[code]
                    months = max(1, min(12, (day - pr["mulai"]).days // 30))
                    kwh_ts = round(c["base_kwh"] * 30 * months * max(pr.get("porsi") or 0.3, 0.3), 0)
                    pr["ditertibkan"] = day
                    break
                if code == "X-02" and rnd.random() < 0.9:
                    gol, temuan = "Kelainan meter (bukan pelanggaran)", "Meter rusak / register tidak berputar; diganti."
                    break
            rows.append({"no_ba": f"BA-P2TL-{seq:05d}", "id_pelanggan": c["id_pelanggan"], "tanggal": day.isoformat(), "dasar_pemilihan": basis,
                         "golongan": gol, "temuan": temuan, "kwh_tagihan_susulan": kwh_ts,
                         "rp_tagihan_susulan": round(kwh_ts * TARIF.get(c["tarif"], 1444.7), -3),
                         "tim": rnd.choice(["Tim P2TL ULP Demo Cikarang Utara", "Tim P2TL ULP Demo Cikarang Selatan", "Tim P2TL UP3 Demo (TM)"])})
        day += timedelta(days=rnd.randint(1, 2))
    return rows


def _active(pr: dict, d: date) -> bool:
    end = pr.get("ditertibkan")
    if pr.get("lama_hari"):
        end = pr["mulai"] + timedelta(days=pr["lama_hari"])
    return pr["mulai"] <= d and (end is None or d < end)


# ------------------------------------------------------------------------------------------------
# simulation: daily true and metered energy per customer, DT and feeder
# ------------------------------------------------------------------------------------------------

def _loss_factor(lf: float) -> float:
    return 0.3 * lf + 0.7 * lf * lf


@lru_cache(maxsize=1)
def simulate() -> dict:
    p2tl()  # marks which thefts were caught
    net = network()
    cs = customers()
    by = _by_customer()
    pl = plant()
    dt_tl = {code: {r["kode_dt"]: r for r in rows} for code, rows in pl["gardu"].items()}
    fd_pf = {r["kode_penyulang"]: r["pf"] for r in pl["penyulang"]["TL-04"]}
    rows_cust: dict[str, list[dict]] = {}
    for c in cs:
        rnd = _r("sim:" + c["id_pelanggan"])
        pats = by.get(c["id_pelanggan"], [])
        out = []
        for d in DAYS:
            f = _day_factor(c["profil"], d, rnd)
            true = c["base_kwh"] * f
            metered, billed_factor = true, 1.0
            events: list[str] = []
            peak_kw = true / 24 / LOAD_FACTOR[c["profil"]]
            wbp_share = SHAPE[c["profil"]][0] * rnd.uniform(0.92, 1.08)
            phase_i = [1.0, 1.0, 1.0]
            for code, pr in pats:
                if not _active(pr, d):
                    continue
                if code in ("NTL-01", "NTL-02", "NTL-06", "NTL-08", "NTL-13", "X-01", "X-03", "X-05"):
                    if code in ("X-01", "X-03", "X-05"):
                        true *= 1 - pr["porsi"]  # real drop (or self-generation): nothing is lost
                        metered = true
                    elif code in ("NTL-06", "NTL-13"):
                        pass  # the meter is right; the billed reading is wrong (handled at billing)
                    else:
                        metered = true * (1 - pr["porsi"])
                    if code == "NTL-02" and rnd.random() < 0.25:
                        events.append(rnd.choice(["MAGNETIC", "COVER_OPEN"]))
                elif code == "NTL-14":
                    true = pr["beban_kw"] * 24 * rnd.uniform(0.95, 1.0) + c["base_kwh"] * f
                    metered = c["base_kwh"] * f * 0.3
                    peak_kw = pr["beban_kw"] * 1.05
                elif code in ("NTL-04", "NTL-11"):
                    true *= pr.get("kali_beban", 1.15)
                    metered = true
                    peak_kw = c["daya_va"] / 1000 * pr.get("lebih_daya", pr.get("kali_beban", 1.5) * 0.55)
                elif code == "NTL-09":
                    true *= pr["kali_beban"]
                    metered = true
                elif code == "NTL-07":
                    i = ["L1", "L2", "L3"].index(pr["fasa"])
                    phase_i[i] = 0.02 if pr["cara"] == "shunt sekunder CT" else 1.0
                    metered = true * (1 - pr["porsi"])
                    if rnd.random() < 0.1:
                        events.append("CURRENT_UNBALANCE" if pr["cara"] == "shunt sekunder CT" else "PHASE_LOSS")
                elif code == "NTL-05":
                    billed_factor = pr["porsi"]
                elif code == "NTL-10":
                    wbp_share = pr["porsi_wbp"]
                elif code == "NTL-12":
                    peak_kw = c["daya_kontrak_kva"] * 0.85 * pr["kali_dmd"] * rnd.uniform(0.97, 1.03)
                elif code == "X-02":
                    metered = 0.0
                elif code == "X-04":
                    true *= 1 - pr["porsi"]
                    metered = true
            if c["tegangan"] == "TM" and not any(code == "NTL-12" and _active(pr, d) for code, pr in pats):
                peak_kw = min(peak_kw, c["daya_kontrak_kva"] * 0.85 * rnd.uniform(0.7, 0.98))
            elif c["tegangan"] == "TR" and not any(code in ("NTL-04", "NTL-11", "NTL-14") and _active(pr, d) for code, pr in pats):
                peak_kw = min(peak_kw, c["daya_va"] / 1000 * rnd.uniform(0.72, 0.98))  # the MCB trips above the contracted VA
            if rnd.random() < 0.006:
                events.append("POWER_OFF")
            out.append({"d": d, "true": true, "metered": metered, "billed_factor": billed_factor, "peak_kw": peak_kw,
                        "wbp_share": wbp_share, "night_share": SHAPE[c["profil"]][1] * rnd.uniform(0.9, 1.1), "events": events, "phase_i": phase_i})
        rows_cust[c["id_pelanggan"]] = out
    # DTs: Σ true LV consumption + illegal connections + JTR losses
    lv_by_dt: dict[str, list[dict]] = {}
    for c in cs:
        if c["kode_dt"]:
            lv_by_dt.setdefault(c["kode_dt"], []).append(c)
    dt_days: dict[str, list[dict]] = {}
    for dt in net["dts"]:
        rnd = _r("dt:" + dt["kode_dt"])
        ill = dt_tl.get("NTL-03", {}).get(dt["kode_dt"])
        over = dt_tl.get("TL-01", {}).get(dt["kode_dt"])
        unb = dt_tl.get("TL-02", {}).get(dt["kode_dt"])
        out = []
        for k, d in enumerate(DAYS):
            load = sum(rows_cust[c["id_pelanggan"]][k]["true"] for c in lv_by_dt.get(dt["kode_dt"], []))
            if over:
                load *= over["kali_beban"]  # growth the network did not follow: many new loads, same transformer
            illegal = ill["kwh_hari"] * rnd.uniform(0.85, 1.15) if ill and ill["mulai"] <= d else 0.0
            night = 0.0
            total_load = load + illegal
            lf = 0.55 * rnd.uniform(0.95, 1.05)
            peak_kva = total_load / 24 / lf / 0.9
            i_avg = peak_kva * 1000 / (math.sqrt(3) * 400) * lf  # mean phase current (A)
            ratio_n = unb["rasio_netral"] if unb else rnd.uniform(0.08, 0.2)
            unbalance = 1 + 1.6 * ratio_n ** 2
            # load spread evenly along the line: an equivalent resistance of a third of the line's; service drops,
            # joints and kWh meters lose another ~1.5% of the energy they pass
            r_jtr = dt["panjang_jtr_km"] * dt["r_jtr_ohm_km"] / 3
            jtr_loss = 3 * i_avg ** 2 * r_jtr * unbalance * 24 / 1000 * (_loss_factor(lf) / lf ** 2) + 0.015 * total_load
            out_kwh = total_load + jtr_loss
            trafo_loss = dt["rugi_besi_w"] * 24 / 1000 + dt["rugi_tembaga_w"] * (peak_kva / dt["kva"]) ** 2 * _loss_factor(lf) * 24 / 1000
            spread = [1 + ratio_n * 0.9, 1 - ratio_n * 0.5, 1 - ratio_n * 0.4]
            v_end = 231 - 1.6 * i_avg * dt["panjang_jtr_km"] * dt["r_jtr_ohm_km"] * 0.5 * (1 + ratio_n) * rnd.uniform(0.95, 1.05)
            night = (sum(rows_cust[c["id_pelanggan"]][k]["true"] * rows_cust[c["id_pelanggan"]][k]["night_share"]
                         for c in lv_by_dt.get(dt["kode_dt"], [])) + illegal * 0.7)
            out.append({"d": d, "kwh_keluar": out_kwh, "kva_puncak": peak_kva, "i": [i_avg * s for s in spread], "i_n": i_avg * ratio_n,
                        "jtr_loss": jtr_loss, "trafo_loss": trafo_loss, "illegal": illegal, "v_ujung_min": v_end,
                        "suhu_minyak": 38 + 52 * min(1.6, peak_kva / dt["kva"]) ** 2 * rnd.uniform(0.92, 1.05), "kwh_malam": night})
        dt_days[dt["kode_dt"]] = out
    # feeders: Σ (DT output + transformer losses) + TM true consumption + line losses
    tm_by_fd: dict[str, list[dict]] = {}
    for c in cs:
        if c["tegangan"] == "TM":
            tm_by_fd.setdefault(c["kode_penyulang"], []).append(c)
    dt_by_fd: dict[str, list[dict]] = {}
    for dt in net["dts"]:
        dt_by_fd.setdefault(dt["kode_penyulang"], []).append(dt)
    fd_days: dict[str, list[dict]] = {}
    for f in net["feeders"]:
        rnd = _r("fd:" + f["kode"])
        pf = fd_pf.get(f["kode"], rnd.uniform(0.89, 0.94))
        out = []
        for k, d in enumerate(DAYS):
            dts_e = sum(dt_days[dt["kode_dt"]][k]["kwh_keluar"] + dt_days[dt["kode_dt"]][k]["trafo_loss"] for dt in dt_by_fd.get(f["kode"], []))
            tm_e = sum(rows_cust[c["id_pelanggan"]][k]["true"] for c in tm_by_fd.get(f["kode"], []))
            e = dts_e + tm_e
            lf = 0.68 if f["kode_gi"] == GI_A["kode"] else 0.6
            p_avg = e / 24
            i_avg = p_avg * 1000 / (math.sqrt(3) * 20000 * pf)
            line_loss = 3 * i_avg ** 2 * f["panjang_km"] * f["r_ohm_km"] * 0.45 * 24 / 1000 * (_loss_factor(lf) / lf ** 2)
            outage_min = 0
            out.append({"d": d, "kwh": e + line_loss, "line_loss": line_loss, "pf": pf * rnd.uniform(0.985, 1.01), "kw_puncak": p_avg / lf,
                        "i": [i_avg * rnd.uniform(0.96, 1.04) for _ in range(3)], "thd_i": rnd.uniform(3.5, 7.5) + (4 if pf < 0.85 else 0),
                        "menit_padam": outage_min})
        fd_days[f["kode"]] = out
    return {"customers": rows_cust, "dts": dt_days, "feeders": fd_days}


# ------------------------------------------------------------------------------------------------
# outages (SOE from SCADA) — reliability per feeder
# ------------------------------------------------------------------------------------------------

@lru_cache(maxsize=1)
def outages() -> list[dict]:
    rnd = _r("outages")
    net = network()
    cs = customers()
    count: dict[str, int] = {}
    for c in cs:
        count[c["kode_penyulang"]] = count.get(c["kode_penyulang"], 0) + 1
    rows = []
    seq = 0
    for f in net["feeders"]:
        n = rnd.randint(3, 6) if f["kode_gi"] == GI_B["kode"] else rnd.randint(1, 3)
        if f["kode"] == "KWS-F03":
            n += 2  # NUSAGRID's own fault scenario: permanent fault on F03 section S2
        for _ in range(n):
            seq += 1
            d = rnd.choice(DAYS)
            cause = rnd.choice(["Pohon / layang-layang", "Petir", "Hewan", "Kabel SKTM terganggu" if f["jenis"] == "SKTM" else "Isolator pecah",
                                "Beban lebih", "Gangguan fasa-fasa permanen"])
            perm = cause in ("Gangguan fasa-fasa permanen", "Kabel SKTM terganggu", "Isolator pecah")
            dur = rnd.randint(45, 240) if perm else rnd.randint(1, 4)
            share = rnd.uniform(0.3, 1.0) if perm else 1.0
            rows.append({"id_gangguan": f"GGN-{seq:04d}", "kode_penyulang": f["kode"], "waktu_trip": f"{d.isoformat()}T{rnd.randint(0, 23):02d}:{rnd.randint(0, 59):02d}:00",
                         "peralatan_trip": rnd.choice(["PMT penyulang", "Recloser"]) if not perm else "PMT penyulang",
                         "tag_trip": f"{f['tag_kwh'].rsplit('.', 2)[0]}.REL.TRIP" if f["kode_gi"] == GI_A["kode"] else f"DEM.GIK.20KV.{f['kode_scada']}.REL.TRIP",
                         "jenis": "Permanen" if perm else "Temporer", "penyebab": cause, "durasi_menit": dur,
                         "pelanggan_padam": int(count.get(f["kode"], 0) * share), "kwh_tidak_tersalur": 0.0})
    for r in rows:
        f = next(x for x in network()["feeders"] if x["kode"] == r["kode_penyulang"])
        sim = simulate()["feeders"][f["kode"]]
        k = DAYS.index(date.fromisoformat(r["waktu_trip"][:10]))
        r["kwh_tidak_tersalur"] = round(sim[k]["kwh"] / 1440 * r["durasi_menit"] * (r["pelanggan_padam"] / max(1, count.get(f["kode"], 1))), 1)
        sim[k]["menit_padam"] += r["durasi_menit"]
    return rows


# ------------------------------------------------------------------------------------------------
# raw tables, as the source systems export them
# ------------------------------------------------------------------------------------------------

def _month(d: date) -> str:
    return d.strftime("%Y-%m")


@lru_cache(maxsize=1)
def generate() -> dict[str, list[dict]]:
    net = network()
    cs = customers()
    sim = simulate()
    by = _by_customer()
    rnd = _r("raw")
    out: dict[str, list[dict]] = {}
    gitet = {g["kode"]: nearest_gitet(g["lat"], g["lon"]) for g in net["gi"]}
    # --- service areas and substations (GIS / master data)
    out["wilayah_layanan"] = [{"kode_wilayah": UP3[0], "nama": UP3[1], "jenis": "UP3", "induk": "UID Demo Jawa Barat"}] + \
        [{"kode_wilayah": k, "nama": n, "jenis": "ULP", "induk": UP3[0]} for k, n in ULP]
    out["gis_gardu_induk"] = [{"kode_gi": g["kode"], "nama": g["nama"], "kode_ulp": g["ulp"], "latitude": g["lat"], "longitude": g["lon"],
                               "kapasitas_mva": g["mva"], "trafo": "2 × 60 MVA 150/20 kV", "rugi_besi_kw_per_trafo": net["trafo_gi"]["noLoadLossKw"],
                               "rugi_tembaga_kw_per_trafo": net["trafo_gi"]["loadLossKw"], "sistem_scada": g["sumber_scada"], "rtu": g["rtu"],
                               "gitet_hulu_osm": gitet[g["kode"]][0], "jarak_gitet_km": gitet[g["kode"]][1]} for g in net["gi"]]
    # switchgear on each feeder, from the asset register (the same reclosers and LBS the NUSAGRID model holds for the
    # estate's distribution substation bays F01–F06, which feed the KWS feeders)
    ng = nusagrid()
    gear: dict[str, dict[str, int]] = {}
    for e in ng["equipment"]:
        if e["station"] == "DIST" and e["bay"] in ("F01", "F02", "F03", "F04", "F05", "F06") and e["type"] in ("recloser", "load_break_switch"):
            g = gear.setdefault("KWS-" + e["bay"], {"recloser": 0, "load_break_switch": 0})
            g[e["type"]] += 1
    out["gis_penyulang"] = [{"kode_penyulang": f["kode"], "nama": f["nama"], "kode_gi": f["kode_gi"], "kode_ulp": f["kode_ulp"], "jenis": f["jenis"],
                             "panjang_km": f["panjang_km"], "r_ohm_km": f["r_ohm_km"], "x_ohm_km": f["x_ohm_km"], "kha_a": f["kha_a"],
                             "tag_scada_kwh": f["tag_kwh"], "tag_scada_daya": f["tag_p"], "karakter_beban": f["segmen"], "geometri": _geojson_line(f["pts"]),
                             "jumlah_recloser": gear.get(f["kode"], {}).get("recloser", 0), "jumlah_lbs": gear.get(f["kode"], {}).get("load_break_switch", 0)}
                            for f in net["feeders"]]
    out["gis_gardu_distribusi"] = [{k: dt[k] for k in ("kode_dt", "nama", "kode_penyulang", "kode_ulp", "kva", "tahun_pasang", "rugi_besi_w", "rugi_tembaga_w",
                                                       "panjang_jtr_km", "r_jtr_ohm_km")} | {"latitude": dt["lat"], "longitude": dt["lon"]} for dt in net["dts"]]
    # --- NUSAGRID SCADA: equipment and point list of the estate (the real demo model)
    out["scada_peralatan_nusagrid"] = [{"id_peralatan": e["id"], "tipe": e["type"], "nama": e["name"], "gardu": e["station"], "bay": e["bay"],
                                        "nama_bay": e["bay_name"] or "", "tegangan": e["voltage_level"],
                                        "panjang_km": float(e["attributes"].get("lengthKm") or 0), "r_ohm_km": float(e["attributes"].get("rOhmPerKm") or 0),
                                        "rating": float(e["attributes"].get("ratedMva") or e["attributes"].get("ratedCurrentA") or e["attributes"].get("ampacityA") or 0),
                                        "p_nominal_mw": float(e["attributes"].get("pNominalMw") or 0), "profil": e["attributes"].get("profile") or "",
                                        "atribut": json.dumps(e["attributes"], ensure_ascii=False)} for e in ng["equipment"]]
    out["scada_titik_ukur_nusagrid"] = [{"tag": p["tag"], "jenis_titik": p["kind"], "satuan": p["unit"] or "", "deskripsi": p["description_id"] or "",
                                         "id_peralatan": p["equipment_id"] or "", "area": p["area"] or "", "historian": p["historize"] or ""} for p in ng["points"]]
    # --- SCADA historian: daily feeder energy and quality (the city substation's RTU follows NUSAGRID's tag pattern)
    soe = outages()  # first: it books each outage's minutes on its feeder-day
    out["scada_penyulang_harian"] = [{"tag_kwh": f["tag_kwh"], "kode_penyulang": f["kode"], "tanggal": r["d"].isoformat(), "kwh_kirim": round(r["kwh"], 1),
                                      "kw_puncak": round(r["kw_puncak"], 1), "pf_rata": round(r["pf"], 3), "i_a": round(r["i"][0], 1), "i_b": round(r["i"][1], 1),
                                      "i_c": round(r["i"][2], 1), "thd_i_pct": round(r["thd_i"], 2), "menit_padam": r["menit_padam"],
                                      "kualitas": "valid" if rnd.random() > 0.01 else "questionable"}
                                     for f in net["feeders"] for r in sim["feeders"][f["kode"]]]
    out["scada_gangguan_soe"] = soe
    # --- AMR at the distribution transformers
    out["amr_gardu_harian"] = [{"kode_dt": dt["kode_dt"], "tanggal": r["d"].isoformat(), "kwh_keluar": round(r["kwh_keluar"], 1), "kwh_malam": round(r["kwh_malam"], 1),
                                "kva_puncak": round(r["kva_puncak"], 1), "i_r": round(r["i"][0], 1), "i_s": round(r["i"][1], 1), "i_t": round(r["i"][2], 1),
                                "i_netral": round(r["i_n"], 1), "tegangan_ujung_min_v": round(r["v_ujung_min"], 1), "suhu_minyak_maks_c": round(r["suhu_minyak"], 1)}
                               for dt in net["dts"] for r in sim["dts"][dt["kode_dt"]]]
    # --- AP2T: technical master (no identity) and identity (PII, separate export)
    tech_cols = ["id_pelanggan", "tarif", "daya_va", "segmen", "tegangan", "fase", "kode_dt", "kode_penyulang", "kode_ulp", "jenis_meter", "ami",
                 "petugas_baca", "faktor_kali", "ct_terpasang", "daya_kontrak_kva", "tag_scada", "tgl_pasang"]
    out["ap2t_pelanggan_teknis"] = [{k: (("Ya" if c[k] else "Tidak") if k == "ami" else c[k]) for k in tech_cols}
                                    | {"latitude": round(c["lat"], 4), "longitude": round(c["lon"], 4)} for c in cs]
    out["ap2t_pelanggan_identitas"] = [{"id_pelanggan": c["id_pelanggan"], "nama": c["nama"], "nik": c["nik"], "alamat": c["alamat"], "telepon": c["telepon"],
                                        "no_meter": c["no_meter"], "latitude_persil": c["lat"], "longitude_persil": c["lon"]} for c in cs]
    out["tarif_tenaga_listrik"] = [{"golongan": k, "rp_per_kwh": v, "rp_per_kwh_wbp": round(v * WBP_FACTOR, 2) if k in ("B3", "I3", "I4", "P2", "S3") else v,
                                    "keterangan": "Tarif contoh (demo): tarif non-subsidi triwulanan; golongan S dan R1 kecil bersubsidi"} for k, v in TARIF.items()]
    # --- AP2T monthly bills (one file per month): postpaid readings, prepaid token kWh, TM AMR with the billing multiplier
    for m in MONTHS:
        rows = []
        for c in cs:
            days = [r for r in sim["customers"][c["id_pelanggan"]] if _month(r["d"]) == m]
            metered = sum(r["metered"] for r in days)
            billed = metered * days[-1]["billed_factor"]
            cara = "AMR" if c["tegangan"] == "TM" else ("AMI" if c["ami"] and m >= "2026-07" else ("token" if c["jenis_meter"] == "prabayar" else "baca"))
            for code, pr in by.get(c["id_pelanggan"], []):
                if code in ("NTL-06", "NTL-13") and _active(pr, days[-1]["d"]):
                    billed = c["base_kwh"] * 30 * (1 - pr["porsi"]) if code == "NTL-13" else c["base_kwh"] * 30 * 0.45
                    cara = "estimasi" if code == "NTL-06" else "baca"
            if c["jenis_meter"] == "prabayar":
                billed = metered * rnd.uniform(0.9, 1.1)  # token purchases lag consumption
            wbp = sum(r["metered"] * r["wbp_share"] for r in days) * days[-1]["billed_factor"]
            tarif = TARIF[c["tarif"]]
            rp = (billed - wbp) * tarif + wbp * tarif * WBP_FACTOR if c["tegangan"] == "TM" else billed * tarif
            rows.append({"id_pelanggan": c["id_pelanggan"], "bulan": m, "kwh": round(billed, 1), "kwh_wbp": round(wbp, 1) if c["tegangan"] == "TM" else 0.0,
                         "kw_maks": round(max(r["peak_kw"] for r in days), 1), "cara_baca": cara, "rp_tagihan": round(rp, -2),
                         "stand_akhir": 0.0})
        out[f"ap2t_tagihan_{m.replace('-', '_')}"] = rows
    # stand meter: cumulative kWh at the reading (a stuck meter repeats its stand)
    stand: dict[str, float] = {c["id_pelanggan"]: _r("stand" + c["id_pelanggan"]).uniform(1000, 40000) for c in cs}
    for m in MONTHS:
        for r in out[f"ap2t_tagihan_{m.replace('-', '_')}"]:
            stuck = r["cara_baca"] == "estimasi"
            if not stuck:
                stand[r["id_pelanggan"]] += r["kwh"]
            r["stand_akhir"] = round(stand[r["id_pelanggan"]], 0)
    # --- AMI head-end: daily LV consumption (Jul–Sep, AMI customers) and meter events
    ami_rows, events = [], []
    for c in cs:
        if not c["ami"]:
            continue
        for r in sim["customers"][c["id_pelanggan"]]:
            if r["d"] < AMI_START:
                continue
            if c["tegangan"] == "TR":
                ami_rows.append({"id_pelanggan": c["id_pelanggan"], "tanggal": r["d"].isoformat(), "kwh": round(r["metered"], 2),
                                 "kwh_malam": round(r["metered"] * r["night_share"], 2), "kw_puncak": round(r["peak_kw"], 2),
                                 "tegangan_min_v": round(_r(f"v{c['id_pelanggan']}{r['d']}").uniform(196, 224), 1)})
            for ev in r["events"]:
                events.append({"id_pelanggan": c["id_pelanggan"], "waktu": f"{r['d'].isoformat()}T{_r(ev + c['id_pelanggan'] + str(r['d'])).randint(0, 23):02d}:15:00",
                               "kode_event": ev, "durasi_menit": _r(ev + str(r["d"])).randint(1, 180)})
    out["ami_konsumsi_harian"] = ami_rows
    out["ami_event_meter"] = events
    # --- AMR TM: three-phase daily summaries (Jul–Sep)
    tm_rows = []
    for c in cs:
        if c["tegangan"] != "TM":
            continue
        rr = _r("tm" + c["id_pelanggan"])
        for r in sim["customers"][c["id_pelanggan"]]:
            if r["d"] < AMI_START:
                continue
            kw_avg = r["metered"] / 24
            i_avg = kw_avg * 1000 / (math.sqrt(3) * 20000 * 0.9) if kw_avg else 0.0
            u = [round(11.55 * rr.uniform(0.985, 1.01), 3) for _ in range(3)]
            iph = [round(i_avg * 3 / max(0.01, sum(r["phase_i"])) * r["phase_i"][j] * rr.uniform(0.96, 1.04), 2) for j in range(3)]
            for code, pr in by.get(c["id_pelanggan"], []):
                if code == "NTL-07" and _active(pr, r["d"]) and pr["cara"] == "fuse PT dibuka":
                    u[["L1", "L2", "L3"].index(pr["fasa"])] = round(rr.uniform(0.2, 0.6), 3)
            tm_rows.append({"id_pelanggan": c["id_pelanggan"], "tanggal": r["d"].isoformat(), "kwh": round(r["metered"], 1),
                            "kwh_wbp": round(r["metered"] * r["wbp_share"], 1), "kw_dmd15_maks": round(r["peak_kw"], 1),
                            "pf_rata": round(rr.uniform(0.86, 0.96), 3), "u_l1_kv": u[0], "u_l2_kv": u[1], "u_l3_kv": u[2],
                            "i_l1_a": iph[0], "i_l2_a": iph[1], "i_l3_a": iph[2], "i_netral_a": round(abs(iph[0] - (iph[1] + iph[2]) / 2) * 0.6, 2)})
    out["amr_tm_tiga_fasa_harian"] = tm_rows
    # --- P2TL results
    out["p2tl_hasil_pemeriksaan"] = p2tl()
    return out


def truth() -> dict:
    """The planted patterns per customer / DT / feeder (for evaluation only; never written to raw/)."""
    pl = plant()
    p2tl()
    rows = []
    for code, items in pl["pelanggan"].items():
        for r in items:
            rows.append({"kode_pola": code, "kelompok": PATTERNS[code][0], "pola": PATTERNS[code][1], "id_pelanggan": r["id_pelanggan"], "kode_dt": "",
                         "kode_penyulang": "", "mulai": r["mulai"].isoformat(), "ditertibkan": r["ditertibkan"].isoformat() if r.get("ditertibkan") else "",
                         "aktif_jul_sep": any(_active(r, d) for d in DAYS if d >= AMI_START)})
    for code, items in pl["gardu"].items():
        for r in items:
            rows.append({"kode_pola": code, "kelompok": PATTERNS[code][0], "pola": PATTERNS[code][1], "id_pelanggan": "", "kode_dt": r["kode_dt"],
                         "kode_penyulang": "", "mulai": r["mulai"].isoformat() if r.get("mulai") else "", "ditertibkan": "", "aktif_jul_sep": True})
    for code, items in pl["penyulang"].items():
        for r in items:
            rows.append({"kode_pola": code, "kelompok": PATTERNS[code][0], "pola": PATTERNS[code][1], "id_pelanggan": "", "kode_dt": "",
                         "kode_penyulang": r["kode_penyulang"], "mulai": "", "ditertibkan": "", "aktif_jul_sep": True})
    return {"patterns": PATTERNS, "rows": rows}
