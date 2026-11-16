"""Demo: fishers' GPS catch points and predicted fish aggregations on a map (POST /api/demo/nelayan).

Synthetic data (no real vessel or fisher) in WPP-NRI 713 (Selat Makassar, Teluk Bone, Laut Flores):

- object type "Tangkapan Nelayan (demo)": one catch per GPS fix where the haul came up (vessel, gear, species, kg,
  time, the distance to the nearest predicted aggregation and whether the catch fell inside a predicted zone);
- object type "Prediksi Kumpulan Ikan (demo)": the cells a fish-aggregation model flags for tomorrow (point and a
  zone polygon, probability, target species, sea surface temperature, chlorophyll-a, thermal front, depth);
- the map "Demo: Tangkapan nelayan & prediksi kumpulan ikan" with the zones (high probability), the predicted
  points split into high (>= 0.7) and medium probability, and the catches.

Seeded, so the same data every time. Idempotent: what exists is kept, and nothing is ever deleted.
"""

from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter

import geospatial
import ontology

router = APIRouter(prefix="/api/demo/nelayan")

TANGKAPAN = "Tangkapan Nelayan (demo)"
PREDIKSI = "Prediksi Kumpulan Ikan (demo)"
MAP = "Demo: Tangkapan nelayan & prediksi kumpulan ikan"
DAY = datetime(2026, 10, 9, tzinfo=timezone.utc)  # the catches; the predictions are for the next day
ZONE_KM = 12.0

# hotspots of the model (lat, lon, species, peak probability, radius in degrees) — all at sea
HOTSPOTS = [
    (-2.60, 118.40, "Cakalang", 0.88, 0.30, "Selat Makassar tengah"),
    (-4.00, 118.65, "Tongkol", 0.81, 0.25, "Selat Makassar selatan"),
    (-4.25, 121.00, "Tongkol", 0.74, 0.18, "Teluk Bone"),
    (-6.90, 119.65, "Layang", 0.84, 0.28, "Laut Flores barat"),
    (-7.20, 121.20, "Madidihang (tuna sirip kuning)", 0.77, 0.25, "Laut Flores timur"),
]
# open water boxes for scattered predictions and catches away from the hotspots (lat0, lat1, lon0, lon1)
SEA = [(-3.6, -1.4, 117.9, 118.9), (-6.9, -6.2, 119.3, 120.1), (-7.8, -6.6, 120.7, 121.6), (-4.6, -3.4, 120.7, 121.2)]
GEAR = {"Cakalang": "Huhate (pole and line)", "Tongkol": "Pukat cincin mini", "Layang": "Pukat cincin",
        "Madidihang (tuna sirip kuning)": "Pancing ulur", "Kembung": "Jaring insang", "Tenggiri": "Pancing tonda"}
PORTS = ["PPI Paotere (Makassar)", "PPN Untia", "PPI Lappa (Sinjai)", "PPI Bajoe (Bone)", "PPI Benteng (Selayar)", "PPI Mamuju"]


def _type(name: str) -> Optional[dict]:
    return next((t for t in ontology._all("object-types") if t["display_name"] == name), None)


def _p(api: str, name: str, typ: str = "string", **kw: Any) -> ontology.Property:
    return ontology.Property(api_name=api, display_name=name, type=typ, **kw)


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(h))


def _circle(lat: float, lon: float, km: float, n: int = 24) -> dict:
    dlat = km / 111.0
    dlon = km / (111.0 * math.cos(math.radians(lat)))
    ring = [[round(lon + dlon * math.cos(2 * math.pi * i / n), 5), round(lat + dlat * math.sin(2 * math.pi * i / n), 5)] for i in range(n)]
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}


def generate(seed: int = 713) -> tuple[list[dict], list[dict]]:
    """(predictions, catches) as property dicts."""
    rnd = random.Random(seed)
    preds: list[dict] = []
    for h, (lat, lon, fish, peak, r, area) in enumerate(HOTSPOTS):
        for i in range(7):
            d = 0 if i == 0 else rnd.uniform(0.35, 1.0)  # the core, then cells around it
            ang = rnd.uniform(0, 2 * math.pi)
            la, lo = lat + d * r * math.sin(ang), lon + d * r * math.cos(ang)
            prob = max(0.3, min(0.97, peak - 0.25 * d + rnd.uniform(-0.05, 0.05)))
            preds.append({"lat": la, "lon": lo, "fish": fish, "prob": prob, "area": area, "front": d < 0.6})
    for i in range(14):
        la0, la1, lo0, lo1 = SEA[i % len(SEA)]
        preds.append({"lat": rnd.uniform(la0, la1), "lon": rnd.uniform(lo0, lo1), "fish": rnd.choice(["Kembung", "Tenggiri", "Layang"]),
                      "prob": rnd.uniform(0.22, 0.55), "area": "Perairan terbuka", "front": False})
    predictions = []
    for n, p in enumerate(preds, 1):
        pid = f"ZPPI-{n:03d}"
        predictions.append({
            "id_prediksi": pid, "judul": f"{pid} · {p['fish']} · {round(p['prob'] * 100)}%",
            "lokasi": f"{p['lat']:.5f},{p['lon']:.5f}", "zona": _circle(p["lat"], p["lon"], ZONE_KM if p["prob"] >= 0.7 else 7.0),
            "probabilitas": round(p["prob"], 2), "kelas": "Tinggi" if p["prob"] >= 0.7 else "Sedang" if p["prob"] >= 0.45 else "Rendah",
            "spesies_target": p["fish"], "wilayah": p["area"],
            "suhu_permukaan_c": round(29.6 - 1.4 * p["prob"] + rnd.uniform(-0.3, 0.3), 2),  # upwelling: cooler where fish gather
            "klorofil_mg_m3": round(0.12 + 0.55 * p["prob"] + rnd.uniform(-0.05, 0.05), 3),
            "front_termal": "Ya" if p["front"] else "Tidak", "kedalaman_m": int(rnd.uniform(180, 2400)),
            "berlaku_untuk": (DAY + timedelta(days=1)).date().isoformat(), "model": "Demo: model ZPPI (SST + klorofil-a + front)"})
    strong = [(float(x["lokasi"].split(",")[0]), float(x["lokasi"].split(",")[1])) for x in predictions if x["probabilitas"] >= 0.7]
    catches = []
    for n in range(1, 61):
        near = n % 4 != 0  # three of four hauls near a hotspot, the rest anywhere at sea
        if near:
            lat, lon, fish, _, r, _ = HOTSPOTS[rnd.randrange(len(HOTSPOTS))]
            d, ang = rnd.uniform(0, 1.3) * r, rnd.uniform(0, 2 * math.pi)
            la, lo = lat + d * math.sin(ang), lon + d * math.cos(ang)
        else:
            la0, la1, lo0, lo1 = SEA[rnd.randrange(len(SEA))]
            la, lo = rnd.uniform(la0, la1), rnd.uniform(lo0, lo1)
            fish = rnd.choice(["Kembung", "Tenggiri", "Layang", "Tongkol"])
        dist = min(_km((la, lo), s) for s in strong)
        kg = rnd.uniform(40, 900) * (1.6 if dist <= ZONE_KM else 0.7)
        t = DAY + timedelta(hours=rnd.uniform(-10, 8))
        cid = f"TKP-{n:03d}"
        catches.append({
            "id_tangkapan": cid, "judul": f"{cid} · KM Bahari {chr(65 + n % 20)}-{10 + n % 17} · {fish}",
            "lokasi": f"{la:.5f},{lo:.5f}", "kapal": f"KM Bahari {chr(65 + n % 20)}-{10 + n % 17}", "nakhoda": f"Nelayan (demo) {n:02d}",
            "alat_tangkap": GEAR.get(fish, "Jaring insang"), "spesies": fish, "berat_kg": round(kg, 1),
            "waktu": t.isoformat(timespec="minutes"), "pelabuhan": PORTS[n % len(PORTS)],
            "jarak_prediksi_km": round(dist, 1), "dalam_zona_prediksi": "Ya" if dist <= ZONE_KM else "Tidak"})
    return predictions, catches


def _ensure_types() -> tuple[dict, dict, list[str]]:
    made = []
    pr = _type(PREDIKSI)
    if not pr:
        pr = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=PREDIKSI, plural_name=PREDIKSI, api_name="PrediksiKumpulanIkanDemo", primary_key="id_prediksi", title_property="judul",
            icon="sparkle", color="#f97316",
            description="Demo: sel prediksi kumpulan ikan (zona potensi penangkapan ikan) untuk besok, dari suhu permukaan laut, "
                        "klorofil-a dan front termal. Data sintetis WPP-NRI 713.",
            properties=[_p("id_prediksi", "ID prediksi", render_hints=["searchable", "identifier"]), _p("judul", "Judul", render_hints=["searchable"]),
                        _p("lokasi", "Titik prediksi", "geopoint"), _p("zona", "Zona prediksi", "geoshape"),
                        _p("probabilitas", "Probabilitas", "double"), _p("kelas", "Kelas probabilitas", render_hints=["selectable"]),
                        _p("spesies_target", "Spesies target", render_hints=["searchable", "selectable"]),
                        _p("wilayah", "Wilayah", render_hints=["searchable", "selectable"]),
                        _p("suhu_permukaan_c", "Suhu permukaan laut (°C)", "double"), _p("klorofil_mg_m3", "Klorofil-a (mg/m³)", "double"),
                        _p("front_termal", "Front termal", render_hints=["selectable"]), _p("kedalaman_m", "Kedalaman (m)", "integer"),
                        _p("berlaku_untuk", "Berlaku untuk", "date"), _p("model", "Model")]))
        made.append(PREDIKSI)
    tk = _type(TANGKAPAN)
    if not tk:
        tk = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=TANGKAPAN, plural_name=TANGKAPAN, api_name="TangkapanNelayanDemo", primary_key="id_tangkapan", title_property="judul",
            icon="globe", color="#22c55e",
            description="Demo: koordinat GPS tempat nelayan menaikkan tangkapan (kapal, alat tangkap, spesies, berat), dengan jarak "
                        "ke prediksi kumpulan ikan terdekat. Data sintetis; kapal dan nelayan fiktif.",
            properties=[_p("id_tangkapan", "ID tangkapan", render_hints=["searchable", "identifier"]), _p("judul", "Judul", render_hints=["searchable"]),
                        _p("lokasi", "Koordinat GPS", "geopoint"), _p("kapal", "Kapal", render_hints=["searchable", "selectable"]),
                        _p("nakhoda", "Nakhoda", render_hints=["searchable"]), _p("alat_tangkap", "Alat tangkap", render_hints=["selectable"]),
                        _p("spesies", "Spesies", render_hints=["searchable", "selectable"]), _p("berat_kg", "Berat (kg)", "double"),
                        _p("waktu", "Waktu tangkap", "timestamp"), _p("pelabuhan", "Pelabuhan pendaratan", render_hints=["selectable"]),
                        _p("jarak_prediksi_km", "Jarak ke prediksi tinggi terdekat (km)", "double"),
                        _p("dalam_zona_prediksi", "Dalam zona prediksi", render_hints=["selectable"])]))
        made.append(TANGKAPAN)
    return ontology._object_type(pr["id"]), ontology._object_type(tk["id"]), made


def _ensure_objects(pr: dict, tk: dict) -> int:
    predictions, catches = generate()
    edits = []
    for t, rows, key in ((pr, predictions, "id_prediksi"), (tk, catches, "id_tangkapan")):
        have = ontology.stored_objects(t["id"])
        edits += [{"op": "create", "object_type_id": t["id"], "primary_key": r[key], "properties": r} for r in rows if r[key] not in have]
    if edits:
        ontology.apply_edits(edits, source="demo-nelayan")
    return len(edits)


def _ensure_map(pr: dict, tk: dict) -> dict:
    have = next((m for m in geospatial.list_maps() if m.get("name") == MAP), None)
    if have:
        return have
    L = geospatial.Layer
    return geospatial.create_map(geospatial.MapIn(
        name=MAP, basemap="satellite", view={"lat": -4.9, "lon": 119.6, "zoom": 6},
        description="Demo (data sintetis, WPP-NRI 713): titik GPS tangkapan nelayan 9 Okt 2026 (hijau) dan prediksi kumpulan ikan untuk "
                    "10 Okt 2026 — zona dan titik probabilitas tinggi (oranye) dan sedang (kuning). Tangkapan dalam zona prediksi "
                    "membawa berat lebih besar: bandingkan kolom \"Dalam zona prediksi\" dan \"Berat (kg)\".",
        layers=[
            L(name="Zona prediksi kumpulan ikan (probabilitas ≥ 0.7)", kind="objects", color="#f97316", opacity=0.35,
              config={"object_type_id": pr["id"], "property": "zona", "filters": [{"property": "probabilitas", "op": "gte", "value": 0.7}]}),
            L(name="Prediksi kumpulan ikan — tinggi (≥ 0.7)", kind="objects", color="#f97316",
              config={"object_type_id": pr["id"], "property": "lokasi", "filters": [{"property": "probabilitas", "op": "gte", "value": 0.7}]}),
            L(name="Prediksi kumpulan ikan — sedang/rendah (< 0.7)", kind="objects", color="#facc15", opacity=0.8,
              config={"object_type_id": pr["id"], "property": "lokasi", "filters": [{"property": "probabilitas", "op": "lt", "value": 0.7}]}),
            L(name="Koordinat GPS tangkapan nelayan", kind="objects", color="#22c55e",
              config={"object_type_id": tk["id"], "property": "lokasi"}),
        ]))


@router.post("")
def build() -> dict:
    """Build (or complete) the demo; nothing existing is changed or deleted."""
    with ontology._lock:
        pr, tk, made = _ensure_types()
        added = _ensure_objects(pr, tk)
    m = _ensure_map(pr, tk)
    return {"map_id": m["id"], "prediksi_type_id": pr["id"], "tangkapan_type_id": tk["id"], "created": made, "objects_added": added}


@router.get("")
def status() -> dict:
    pr, tk = _type(PREDIKSI), _type(TANGKAPAN)
    m = next((m for m in geospatial.list_maps() if m.get("name") == MAP), None)
    _, catches = generate()
    inside = [c for c in catches if c["dalam_zona_prediksi"] == "Ya"]
    return {"map_id": m and m["id"], "prediksi_type_id": pr and pr["id"], "tangkapan_type_id": tk and tk["id"],
            "tangkapan": len(catches), "dalam_zona": len(inside),
            "rata_kg_dalam_zona": round(sum(c["berat_kg"] for c in inside) / max(1, len(inside)), 1),
            "rata_kg_luar_zona": round(sum(c["berat_kg"] for c in catches if c not in inside) / max(1, len(catches) - len(inside)), 1)}
