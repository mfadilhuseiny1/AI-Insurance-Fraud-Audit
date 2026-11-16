"""Demo Grid: peta Maps yang mewakili SELURUH jaringan listrik Jawa Barat (langkah "peta_jabar").

Meniru cakupan peta referensi "Grid Jabar & Benchmark Susut": KPI km rute per kelas tegangan, lapisan SUTET
500 kV / SUTT 150 kV / SUTT 70 kV / tegangan tak diketahui, gardu transmisi, pembangkit berwarna per bahan
bakar, kawasan industri, batas kabupaten/kota, dan lokasi pilot demo (fiktif) di Cikarang.

Semua aset transmisi adalah data nyata OpenStreetMap (ODbL) dari `docs/demo-grid/jabar_transmisi_osm.geojson`
— TANPA angka demo (jumlah gardu/pembangkit/kawasan per kab/kota adalah cacah aset OSM itu sendiri). Angka
demo hanya pada lapisan pilot (GI/penyulang/gardu distribusi/pelanggan fiktif di Cikarang, berlabel demo).
Pembangkit & batas kab/kota belum punya tipe Nexus, jadi modul ini menulis datasetnya dan membuat tipenya
("Power Plant West Java (OSM)", "Regency/City Boundary West Java (OSM)") dengan pola yang sama seperti tipe OSM lain.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

MAP = "Demo: Peta jaringan listrik Jawa Barat menyeluruh (OSM riil)"
MAP_LAMA = "Demo: Peta jaringan listrik Jawa Barat menyeluruh (OSM + pilot demo)"
SUMBER_LABEL = {"coal": "PLTU (batu bara)", "gas": "Gas", "hydro": "Air", "water": "Air",
                "geothermal": "Panas bumi", "solar": "Surya"}


def _e():
    import demo_grid_e2e as e

    return e


def _osm() -> list[dict]:
    import demo_grid_data as gd

    return gd.osm()["features"]


def _parse_mw(kapasitas) -> float | None:
    m = re.search(r"([\d.,]+)", str(kapasitas or ""))
    if not m:
        return None
    s = m.group(1)
    if "." in s and "," in s:  # 1.008,5 -> titik ribuan, koma desimal
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return round(float(s), 1)
    except ValueError:
        return None


def rows_pembangkit() -> list[dict]:
    out = []
    for f in _osm():
        p = f["properties"]
        if p.get("jenis") != "pembangkit":
            continue
        out.append({"osm_id": p["osm_id"], "nama": p.get("nama") or "Pembangkit (tanpa nama di OSM)",
                    "sumber": p.get("sumber") or "lainnya", "sumber_label": SUMBER_LABEL.get(p.get("sumber") or "", "Lainnya"),
                    "kapasitas_mw": _parse_mw(p.get("kapasitas")), "kapasitas_teks": p.get("kapasitas"),
                    "operator": p.get("operator"), "kabkota": p.get("kabkota"),
                    "lokasi": f"{p['lat']:.6f},{p['lon']:.6f}", "latitude": p.get("lat"), "longitude": p.get("lon")})
    return sorted(out, key=lambda r: (r["sumber_label"], -(r["kapasitas_mw"] or 0)))


def _area(ring: list) -> float:
    return sum((ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]) for i in range(len(ring) - 1))


def _fix_winding(geometry: dict) -> dict:
    """geoBoundaries ring searah jarum jam; validator geoshape platform menuntut eksterior CCW (right-hand rule)."""
    def poly(rings: list) -> list:
        out = []
        for i, ring in enumerate(rings):
            a = _area(ring)
            if (i == 0 and a > 0) or (i > 0 and a < 0):
                ring = ring[::-1]
            out.append(ring)
        return out

    if geometry.get("type") == "Polygon":
        return {"type": "Polygon", "coordinates": poly(geometry["coordinates"])}
    if geometry.get("type") == "MultiPolygon":
        return {"type": "MultiPolygon", "coordinates": [poly(p) for p in geometry["coordinates"]]}
    return geometry


def rows_kabkota() -> list[dict]:
    feats = _osm()
    gardu: dict[str, int] = {}
    pemb: dict[str, int] = {}
    kaw: dict[str, int] = {}
    for f in feats:
        p = f["properties"]
        k = p.get("kabkota")
        if not k:
            continue
        if p.get("jenis") == "gardu":
            gardu[k] = gardu.get(k, 0) + 1
        elif p.get("jenis") == "pembangkit":
            pemb[k] = pemb.get(k, 0) + 1
        elif p.get("jenis") == "kawasan_industri":
            kaw[k] = kaw.get(k, 0) + 1
    out = []
    for f in feats:
        p = f["properties"]
        if p.get("jenis") != "kabkota":
            continue
        nama = p.get("nama") or "-"
        out.append({"nama": nama, "geometri": json.dumps(_fix_winding(f["geometry"])),
                    "jumlah_gardu_transmisi_osm": gardu.get(nama, 0), "jumlah_pembangkit_osm": pemb.get(nama, 0),
                    "jumlah_kawasan_industri_osm": kaw.get(nama, 0),
                    "sumber": "Batas administratif geoBoundaries (BPS/OCHA, CC BY 3.0 IGO) via aset OSM demo"})
    return sorted(out, key=lambda r: r["nama"])


def kpi() -> dict:
    feats = _osm()
    km: dict[int, float] = {}
    n: dict[str, int] = {"gardu": 0, "pembangkit": 0, "kawasan_industri": 0, "kabkota": 0}
    mw = 0.0
    for f in feats:
        p = f["properties"]
        j = p.get("jenis")
        if j == "saluran":
            km[p.get("kelas_kv") or 0] = km.get(p.get("kelas_kv") or 0, 0.0) + (p.get("panjang_dalam_jabar_km") or 0)
        elif j in n:
            n[j] += 1
            if j == "pembangkit":
                mw += _parse_mw(p.get("kapasitas")) or 0
    return {"sutet_500_km": round(km.get(500, 0)), "sutt_150_km": round(km.get(150, 0)), "sutt_70_km": round(km.get(70, 0)),
            "tak_diketahui_km": round(km.get(0, 0)), "gardu_transmisi": n["gardu"],
            "gardu_500": sum(1 for f in feats if f["properties"].get("jenis") == "gardu" and f["properties"].get("kelas_kv") == 500),
            "pembangkit": n["pembangkit"], "pembangkit_gw_tercatat": round(mw / 1000, 1),
            "kawasan_industri": n["kawasan_industri"], "kabkota": n["kabkota"]}


def _ensure_type(name: str, api: str, pk: str, title: str, icon: str, color: str, desc: str,
                 props: list[tuple[str, str, str]], dataset_id: str) -> str:
    import ontology
    import ontology_datasources as ods

    t = next((x for x in ontology._all("object-types") if x["display_name"] == name), None)
    if not t:
        t = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=name, plural_name=name, api_name=api, primary_key=pk, title_property=title,
            icon=icon, color=color, description=desc,
            properties=[ontology.Property(api_name=a, display_name=d, type=ty, description="") for a, d, ty in props]))
    # selalu impor ulang: dataset diganti di item yang sama (replace), jadi id tidak berubah walau isinya berubah
    ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=dataset_id, columns=None, map_unmapped=True))
    return t["id"]


def build(state: dict, save) -> dict:
    import geospatial

    e = _e()
    st = state.setdefault("peta_jabar", {})
    project = e._folder(None, e.PROJECT, "project")
    konteks = e._folder(e._folder(project, "raw"), "konteks")
    ds_pemb = e._put(konteks, "pembangkit_jabar_osm", rows_pembangkit())
    ds_kab = e._put(konteks, "batas_kabkota_jabar_osm", rows_kabkota())
    pemb_id = _ensure_type("Power Plant West Java (OSM)", "PembangkitJabarOsm", "osm_id", "nama", "bolt", "#2563eb",
                           "Konteks nyata: pembangkit listrik Jawa Barat dari OpenStreetMap (ODbL). Tanpa angka demo.",
                           [("osm_id", "OSM id", "string"), ("nama", "Nama", "string"), ("sumber", "Sumber (OSM)", "string"),
                            ("sumber_label", "Bahan bakar", "string"), ("kapasitas_mw", "Kapasitas (MW)", "double"),
                            ("kapasitas_teks", "Kapasitas (teks OSM)", "string"), ("operator", "Operator", "string"),
                            ("kabkota", "Kabupaten/kota", "string"), ("lokasi", "Lokasi", "geopoint"),
                            ("latitude", "Latitude", "double"), ("longitude", "Longitude", "double")], ds_pemb)
    kab_id = _ensure_type("Regency/City Boundary West Java (OSM)", "BatasKabKotaJabarOsm", "nama", "nama", "map", "#64748b",
                          "Konteks nyata: batas kabupaten/kota Jawa Barat (geoBoundaries BPS/OCHA). Cacah aset OSM per wilayah.",
                          [("nama", "Kabupaten/kota", "string"), ("geometri", "Geometri", "geoshape"),
                           ("jumlah_gardu_transmisi_osm", "Gardu transmisi (OSM)", "integer"),
                           ("jumlah_pembangkit_osm", "Pembangkit (OSM)", "integer"),
                           ("jumlah_kawasan_industri_osm", "Kawasan industri (OSM)", "integer"),
                           ("sumber", "Sumber", "string")], ds_kab)
    ids = {k: (e._type(k) or {}).get("id") for k in ("saluran_tx", "gardu_tx", "kawasan", "penyulang", "gardu", "gi", "pelanggan")}
    Lr = geospatial.Layer

    def saluran(nama: str, kv: int, color: str, width: float, opacity: float) -> dict:
        return Lr(name=nama, kind="objects", color=color, opacity=opacity,
                  config={"object_type_id": ids["saluran_tx"], "property": "geometri", "line_width": width,
                          "filters": [{"property": "kelas_kv", "op": "eq", "value": kv}]}).model_dump()

    layers = [
        Lr(name="Batas kabupaten/kota Jabar (geoBoundaries)", kind="objects", color="#64748b", opacity=0.45,
           config={"object_type_id": kab_id, "property": "geometri", "line_width": 1, "label_key": "nama"}).model_dump(),
        saluran("SUTET 500 kV (OSM)", 500, "#b4123a", 3, 0.9),
        saluran("SUTT 150 kV (OSM)", 150, "#d97706", 1.8, 0.8),
        saluran("SUTT 70 kV (OSM)", 70, "#0f766e", 1.2, 0.7),
        saluran("Tegangan tak diketahui (OSM, inferensi)", 0, "#94a3b8", 1, 0.6),
        Lr(name="Gardu transmisi Jabar (OSM)", kind="objects", color="#1e293b", opacity=1.0,
           config={"object_type_id": ids["gardu_tx"], "property": "lokasi", "radius": 5, "color_by": "kelas",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Power Plant West Java (OSM) — warna bahan bakar", kind="objects", color="#2563eb", opacity=1.0,
           config={"object_type_id": pemb_id, "property": "lokasi", "radius": 6, "color_by": "sumber_label",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Kawasan industri Jabar (OSM, konteks)", kind="objects", color="#7c3aed", opacity=0.65,
           config={"object_type_id": ids["kawasan"], "property": "lokasi", "radius": 4, "label_key": "nama"}).model_dump(),
    ]
    k = kpi()
    desc = (f"Seluruh jaringan listrik Jawa Barat dari OpenStreetMap (ODbL, konteks nyata tanpa angka demo): "
            f"SUTET 500 kV ±{k['sutet_500_km']} km rute, SUTT 150 kV ±{k['sutt_150_km']} km, SUTT 70 kV ±{k['sutt_70_km']} km, "
            f"{k['gardu_transmisi']} gardu transmisi ({k['gardu_500']} kelas 500 kV), {k['pembangkit']} pembangkit "
            f"(±{k['pembangkit_gw_tercatat']} GW tercatat di OSM), {k['kawasan_industri']} kawasan industri, "
            f"{k['kabkota']} batas kabupaten/kota (geoBoundaries). Peta ini MURNI data riil OpenStreetMap - tanpa data "
            f"fiktif/sintetis sama sekali. Panjang = km rute di dalam Jabar, bukan kms sirkuit.")
    m = next((x for x in geospatial.list_maps() if x.get("name") in (MAP, MAP_LAMA)), None)
    if m:
        geospatial.save_map(m["id"], geospatial.MapIn(name=MAP, description=desc, basemap="streets",
                                                      view={"lat": -6.85, "lon": 107.55, "zoom": 8}, layers=layers))
        mid = m["id"]
    else:
        mid = geospatial.create_map(geospatial.MapIn(name=MAP, description=desc, basemap="streets",
                                                     view={"lat": -6.85, "lon": 107.55, "zoom": 8}, layers=layers))["id"]
    try:
        import agentic_apps

        agentic_apps.register(agentic_apps.AppIn(
            name="Peta jaringan listrik Jawa Barat (Maps)", kind="page", href=f"/map/{mid}", icon="map",
            collection="Grid Management",
            description="Demo: peta seluruh jaringan listrik Jabar (OSM) + pilot demo Cikarang — Maps.",
            tags=["grid", "maps", "jawa-barat", "demo"]))
    except Exception:  # noqa: BLE001 - portal opsional, peta tetap jadi
        pass
    st.update(map_id=mid, kpi=k, layers=len(layers), datasets={"pembangkit": ds_pemb, "kabkota": ds_kab},
              types={"pembangkit": pemb_id, "kabkota": kab_id}, pada=datetime.now(timezone.utc).isoformat())
    save()
    return {"map": mid, "kpi": k, "layers": len(layers)}


def overview_numbers() -> dict:
    st = _e().STATE.get("peta_jabar") or {}
    return {"map": st.get("map_id"), "kpi": st.get("kpi")}
