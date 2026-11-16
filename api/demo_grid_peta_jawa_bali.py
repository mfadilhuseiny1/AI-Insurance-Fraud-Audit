"""Demo Grid: peta Maps jaringan listrik JAWA-BALI (langkah "peta_jawa_bali"), detail di Jabar & Jabodetabek.

Perluasan peta Jabar (`demo_grid_peta_jabar`): aset nyata OpenStreetMap (ODbL) se-Jawa-Bali dari
`docs/demo-grid/jawa_bali_transmisi_osm.geojson` (Overpass API: saluran power=line/cable bergéometri, gardu
power=substation, pembangkit power=plant) dan detail Jabodetabek dari `jabodetabek_detail_osm.geojson`
(power=minor_line + semua substation di bbox metropolitan Jakarta-Bogor-Depok-Tangerang-Bekasi). Jawa Barat
sengaja TIDAK diduplikasi di lapis regional: di sana tampil lapisan super-detail Jabar yang sudah ada (rute
gabungan per kelas, gardu/pembangkit bernama, kawasan industri, batas kab/kota) dan pilot demo Cikarang.
Semua aset OSM konteks nyata tanpa angka demo.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

MAP = "Demo: Peta jaringan listrik Jawa–Bali (OSM + detail Jabar & Jabodetabek)"
JABAR_BBOX = (-7.68, -5.93, 106.49, 108.73)  # lat_min, lat_max, lon_min, lon_max jendela aset Jabar detail
SUMBER_TAMBAHAN = {"wind": "Angin", "biomass": "Biomassa", "waste": "Sampah", "oil": "Minyak", "diesel": "Diesel"}


def _e():
    import demo_grid_e2e as e

    return e


def _feats(nama_file: str) -> list[dict]:
    import demo_grid_data as gd

    return json.loads((gd.ASSETS / nama_file).read_text(encoding="utf-8"))["features"]


def _geometri_wajar(geometry: dict) -> bool:
    """Saring geometri OSM rusak: garis listrik nyata menara-ke-menara <25 km per lompatan titik."""
    import math

    if geometry.get("type") != "LineString":
        return True
    cs = geometry["coordinates"]
    for (lo1, la1), (lo2, la2) in zip(cs, cs[1:]):
        p1, p2 = math.radians(la1), math.radians(la2)
        h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
        if 6371 * 2 * math.asin(min(1.0, math.sqrt(h))) > 25:
            return False
    return True


def _di_jabar(lat: float, lon: float) -> bool:
    return JABAR_BBOX[0] <= lat <= JABAR_BBOX[1] and JABAR_BBOX[2] <= lon <= JABAR_BBOX[3]


def _label_sumber(sumber: str | None) -> str:
    import demo_grid_peta_jabar as pj

    return pj.SUMBER_LABEL.get(sumber or "", SUMBER_TAMBAHAN.get(sumber or "", "Lainnya"))


def _baris(jenis: str, di_luar_jabar: bool = True, tanpa_id: set[str] | None = None) -> list[dict]:
    import demo_grid_peta_jabar as pj

    out = []
    for f in _feats("jawa_bali_transmisi_osm.geojson"):
        p = f["properties"]
        if p.get("jenis") != jenis:
            continue
        if tanpa_id and p["osm_id"] in tanpa_id:
            continue
        if di_luar_jabar and _di_jabar(p["lat"], p["lon"]):
            continue
        row = {"osm_id": p["osm_id"], "nama": p.get("nama") or f"{jenis.capitalize()} (tanpa nama di OSM)",
               "kelas_kv": p.get("kelas_kv") or 0, "operator": p.get("operator"),
               "lokasi": f"{p['lat']:.6f},{p['lon']:.6f}", "latitude": p.get("lat"), "longitude": p.get("lon")}
        if jenis == "saluran":
            if not _geometri_wajar(f["geometry"]):
                continue
            row["geometri"] = json.dumps(f["geometry"])
            row["panjang_km"] = p.get("panjang_km")
        elif jenis == "gardu":
            row["jenis_gardu_osm"] = p.get("substation") or "-"
        elif jenis == "pembangkit":
            row.update(sumber=p.get("sumber") or "lainnya", sumber_label=_label_sumber(p.get("sumber")),
                       kapasitas_mw=pj._parse_mw(p.get("kapasitas")), kapasitas_teks=p.get("kapasitas"))
        out.append(row)
    return out


def _ids_jabar(jenis: str) -> set[str]:
    return {f["properties"]["osm_id"] for f in _feats("jabar_transmisi_osm.geojson")
            if f["properties"].get("jenis") == jenis}


def _baris_detail(jenis: str) -> list[dict]:
    # gardu/saluran yang sudah tampil di lapisan detail Jabar tidak digambar ulang di detail Jabodetabek
    sudah = _ids_jabar("gardu" if jenis == "gardu_detail" else "saluran")
    out = []
    for f in _feats("jabodetabek_detail_osm.geojson"):
        p = f["properties"]
        if p.get("jenis") != jenis or p["osm_id"] in sudah:
            continue
        row = {"osm_id": p["osm_id"], "nama": p.get("nama") or "Gardu (tanpa nama di OSM)",
               "kelas_kv": p.get("kelas_kv") or 0, "operator": p.get("operator"),
               "lokasi": f"{p['lat']:.6f},{p['lon']:.6f}", "latitude": p.get("lat"), "longitude": p.get("lon")}
        if jenis == "saluran_detail":
            if not _geometri_wajar(f["geometry"]):
                continue
            row["geometri"] = json.dumps(f["geometry"])
            row["panjang_km"] = p.get("panjang_km")
            row["nama"] = p.get("nama") or "Saluran distribusi (OSM)"
        else:
            row["jenis_gardu_osm"] = p.get("substation") or "-"
        out.append(row)
    return out


def kpi() -> dict:
    feats = _feats("jawa_bali_transmisi_osm.geojson")
    km: dict[int, float] = {}
    for f in feats:
        p = f["properties"]
        if p.get("jenis") == "saluran":
            km[p.get("kelas_kv") or 0] = km.get(p.get("kelas_kv") or 0, 0.0) + (p.get("panjang_km") or 0)
    import demo_grid_peta_jabar as pj

    kj = pj.kpi()
    return {"saluran_500_km_total": round(km.get(500, 0)), "saluran_150_km_total": round(km.get(150, 0)),
            "saluran_70_km_total": round(km.get(70, 0)),
            "gardu_regional": sum(1 for f in feats if f["properties"].get("jenis") == "gardu"),
            "pembangkit_regional": sum(1 for f in feats if f["properties"].get("jenis") == "pembangkit"),
            "gardu_detail_jabodetabek": len(_baris_detail("gardu_detail")),
            "jabar": {"gardu": kj["gardu_transmisi"], "pembangkit": kj["pembangkit"], "kawasan": kj["kawasan_industri"]}}


def build(state: dict, save) -> dict:
    import geospatial
    import ontology
    import demo_grid_peta_jabar as pj

    e = _e()
    st = state.setdefault("peta_jawa_bali", {})
    project = e._folder(None, e.PROJECT, "project")
    konteks = e._folder(e._folder(project, "raw"), "konteks")
    detail_ids = {r["osm_id"] for r in _baris_detail("gardu_detail")}
    detail_saluran_ids = {r["osm_id"] for r in _baris_detail("saluran_detail")}
    data = {"saluran_jawa_bali_osm": _baris("saluran", tanpa_id=detail_saluran_ids | _ids_jabar("saluran")),
            "gardu_jawa_bali_osm": _baris("gardu", tanpa_id=detail_ids),
            "pembangkit_jawa_bali_osm": _baris("pembangkit"), "saluran_detail_jabodetabek_osm": _baris_detail("saluran_detail"),
            "gardu_detail_jabodetabek_osm": _baris_detail("gardu_detail")}
    ds = {nama: e._put(konteks, nama, rows) for nama, rows in data.items()}
    props_titik = [("osm_id", "OSM id", "string"), ("nama", "Nama", "string"), ("kelas_kv", "Kelas (kV)", "integer"),
                   ("operator", "Operator", "string"), ("lokasi", "Lokasi", "geopoint"),
                   ("latitude", "Latitude", "double"), ("longitude", "Longitude", "double")]
    saluran_id = pj._ensure_type("Transmission Line Java-Bali (OSM)", "SaluranTransmisiJawaBaliOsm", "osm_id", "nama", "route", "#b4123a",
                                 "Konteks nyata: saluran transmisi Jawa-Bali (di luar jendela detail Jabar) dari OpenStreetMap (ODbL). Tanpa angka demo.",
                                 [("osm_id", "OSM id", "string"), ("nama", "Nama", "string"), ("kelas_kv", "Kelas (kV)", "integer"),
                                  ("operator", "Operator", "string"), ("geometri", "Geometri", "geoshape"),
                                  ("panjang_km", "Panjang ruas (km)", "double"), ("lokasi", "Titik tengah", "geopoint"),
                                  ("latitude", "Latitude", "double"), ("longitude", "Longitude", "double")], ds["saluran_jawa_bali_osm"])
    gardu_id = pj._ensure_type("Transmission Substation Java-Bali (OSM)", "GarduTransmisiJawaBaliOsm", "osm_id", "nama", "bolt", "#1e293b",
                               "Konteks nyata: gardu listrik Jawa-Bali (di luar detail Jabar & Jabodetabek) dari OpenStreetMap (ODbL). Tanpa angka demo.",
                               props_titik + [("jenis_gardu_osm", "Jenis gardu (OSM)", "string")], ds["gardu_jawa_bali_osm"])
    pemb_id = pj._ensure_type("Power Plant Java-Bali (OSM)", "PembangkitJawaBaliOsm", "osm_id", "nama", "bolt", "#2563eb",
                              "Konteks nyata: pembangkit listrik Jawa-Bali (di luar jendela detail Jabar) dari OpenStreetMap (ODbL). Tanpa angka demo.",
                              props_titik + [("sumber", "Sumber (OSM)", "string"), ("sumber_label", "Bahan bakar", "string"),
                                             ("kapasitas_mw", "Kapasitas (MW)", "double"), ("kapasitas_teks", "Kapasitas (teks OSM)", "string")],
                              ds["pembangkit_jawa_bali_osm"])
    saluran_det_id = pj._ensure_type("Line Detail Jabodetabek (OSM)", "SaluranDetailJabodetabekOsm", "osm_id", "nama", "route", "#9333ea",
                                     "Konteks nyata: saluran distribusi (power=minor_line) Jabodetabek dari OpenStreetMap (ODbL). Tanpa angka demo.",
                                     [("osm_id", "OSM id", "string"), ("nama", "Nama", "string"), ("kelas_kv", "Kelas (kV)", "integer"),
                                      ("operator", "Operator", "string"), ("geometri", "Geometri", "geoshape"),
                                      ("panjang_km", "Panjang ruas (km)", "double"), ("lokasi", "Titik tengah", "geopoint"),
                                      ("latitude", "Latitude", "double"), ("longitude", "Longitude", "double")], ds["saluran_detail_jabodetabek_osm"])
    gardu_det_id = pj._ensure_type("Substation Detail Jabodetabek (OSM)", "GarduDetailJabodetabekOsm", "osm_id", "nama", "bolt", "#0e7490",
                                   "Konteks nyata: semua gardu (power=substation) di bbox Jabodetabek dari OpenStreetMap (ODbL) — tingkat detail metropolitan. Tanpa angka demo.",
                                   props_titik + [("jenis_gardu_osm", "Jenis gardu (OSM)", "string")], ds["gardu_detail_jabodetabek_osm"])
    by_name = {x["display_name"]: x["id"] for x in ontology._all("object-types")}
    ids = {k: (e._type(k) or {}).get("id") for k in ("saluran_tx", "gardu_tx", "kawasan", "penyulang", "gardu", "gi")}
    Lr = geospatial.Layer

    def saluran(nama: str, kv, color: str, width: float, opacity: float, tipe: str) -> dict:
        nilai = {"op": "eq", "value": kv} if isinstance(kv, int) else {"op": "in", "value": kv}
        return Lr(name=nama, kind="objects", color=color, opacity=opacity,
                  config={"object_type_id": tipe, "property": "geometri", "line_width": width,
                          "filters": [{"property": "kelas_kv", **nilai}]}).model_dump()

    lain = sorted({r["kelas_kv"] for r in data["saluran_jawa_bali_osm"]} - {500, 150, 70})
    layers = [
        Lr(name="Detail Jabar — batas kabupaten/kota (geoBoundaries)", kind="objects", color="#64748b", opacity=0.45,
           config={"object_type_id": by_name.get("Regency/City Boundary West Java (OSM)"), "property": "geometri", "line_width": 1,
                   "label_key": "nama"}).model_dump(),
        saluran("Detail Jabar — SUTET 500 kV (OSM)", 500, "#b4123a", 3, 0.9, ids["saluran_tx"]),
        saluran("Detail Jabar — SUTT 150 kV (OSM)", 150, "#d97706", 1.8, 0.8, ids["saluran_tx"]),
        saluran("Detail Jabar — SUTT 70 kV (OSM)", 70, "#0f766e", 1.2, 0.7, ids["saluran_tx"]),
        saluran("SUTET 500 kV Jawa-Bali (OSM)", 500, "#b4123a", 3, 0.9, saluran_id),
        saluran("SUTT 150 kV Jawa-Bali (OSM)", 150, "#d97706", 1.8, 0.8, saluran_id),
        saluran("SUTT 70 kV Jawa-Bali (OSM)", 70, "#0f766e", 1.2, 0.7, saluran_id),
        saluran("Saluran tegangan lain/tak diketahui Jawa-Bali (OSM)", lain or [0], "#94a3b8", 1, 0.6, saluran_id),
        Lr(name="Gardu Jawa-Bali (OSM)", kind="objects", color="#1e293b", opacity=1.0,
           config={"object_type_id": gardu_id, "property": "lokasi", "radius": 4, "color_by": "kelas_kv",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Power Plant Java-Bali (OSM) — warna bahan bakar", kind="objects", color="#2563eb", opacity=1.0,
           config={"object_type_id": pemb_id, "property": "lokasi", "radius": 6, "color_by": "sumber_label",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        saluran("Detail Jabodetabek — jaringan saluran semua kelas (OSM)", list({r["kelas_kv"] for r in data["saluran_detail_jabodetabek_osm"]} or {0}),
                "#9333ea", 1.6, 0.85, saluran_det_id),
        Lr(name="Detail Jabodetabek — semua gardu (OSM)", kind="objects", color="#0e7490", opacity=0.9,
           config={"object_type_id": gardu_det_id, "property": "lokasi", "radius": 3.5, "color_by": "jenis_gardu_osm",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Detail Jabar — gardu transmisi (OSM)", kind="objects", color="#1e293b", opacity=1.0,
           config={"object_type_id": ids["gardu_tx"], "property": "lokasi", "radius": 5, "color_by": "kelas",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Detail Jabar — pembangkit (OSM)", kind="objects", color="#2563eb", opacity=1.0,
           config={"object_type_id": by_name.get("Power Plant West Java (OSM)"), "property": "lokasi", "radius": 6,
                   "color_by": "sumber_label", "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Detail Jabar — kawasan industri (OSM, konteks)", kind="objects", color="#7c3aed", opacity=0.65,
           config={"object_type_id": ids["kawasan"], "property": "lokasi", "radius": 4, "label_key": "nama"}).model_dump(),
    ]
    k = kpi()
    desc = (f"Jaringan listrik seluruh Jawa-Bali dari OpenStreetMap (ODbL, konteks nyata tanpa angka demo): saluran 500 kV "
            f"±{k['saluran_500_km_total']} km ruas, 150 kV ±{k['saluran_150_km_total']} km, 70 kV ±{k['saluran_70_km_total']} km, "
            f"{k['gardu_regional']} gardu dan {k['pembangkit_regional']} pembangkit regional. Detail diperbesar di dua wilayah: "
            f"Jawa Barat ({k['jabar']['gardu']} gardu, {k['jabar']['pembangkit']} pembangkit, {k['jabar']['kawasan']} kawasan industri, "
            f"batas kab/kota) dan Jabodetabek ({k['gardu_detail_jabodetabek']} gardu tingkat metropolitan + saluran distribusi). "
            f"Peta ini MURNI data riil OpenStreetMap - tanpa data fiktif/sintetis sama sekali. Panjang = km ruas geometri OSM.")
    m = next((x for x in geospatial.list_maps() if x.get("name") == MAP), None)
    view = {"lat": -7.25, "lon": 109.9, "zoom": 7}
    if m:
        geospatial.save_map(m["id"], geospatial.MapIn(name=MAP, description=desc, basemap="streets", view=view, layers=layers))
        mid = m["id"]
    else:
        mid = geospatial.create_map(geospatial.MapIn(name=MAP, description=desc, basemap="streets", view=view, layers=layers))["id"]
    try:
        import agentic_apps

        agentic_apps.register(agentic_apps.AppIn(
            name="Peta jaringan listrik Jawa-Bali (Maps)", kind="page", href=f"/map/{mid}", icon="map",
            collection="Grid Management",
            description="Demo: peta jaringan listrik Jawa-Bali (OSM), detail Jabar & Jabodetabek, pilot Cikarang — Maps.",
            tags=["grid", "maps", "jawa-bali", "demo"]))
    except Exception:  # noqa: BLE001
        pass
    st.update(map_id=mid, kpi=k, layers=len(layers), datasets=ds,
              baris={nama: len(rows) for nama, rows in data.items()}, pada=datetime.now(timezone.utc).isoformat())
    save()
    return {"map": mid, "kpi": k, "layers": len(layers), "baris": st["baris"]}


def overview_numbers() -> dict:
    st = _e().STATE.get("peta_jawa_bali") or {}
    return {"map": st.get("map_id"), "kpi": st.get("kpi")}
