"""Demo Grid: SATU peta gabungan jaringan listrik Jawa-Bali (langkah "peta_gabungan") — yang paling rapi.

Satu layer per kelas tegangan untuk SELURUH wilayah, tanpa objek dobel dan tanpa layer per-daerah yang
bertumpuk: saluran/gardu/pembangkit digabung dari tiga sumber OSM yang sama seperti peta sebelumnya —
rute gabungan detail Jabar (`jabar_transmisi_osm.geojson`), ruas regional Jawa-Bali, dan detail Jabodetabek —
diunion per osm_id (sumber yang lebih detail menang). Murni data riil OpenStreetMap (ODbL), tanpa fiktif.
Urutan layer disengaja: batas wilayah di dasar, saluran per kelas, lalu titik gardu/pembangkit/kawasan di atas.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

MAP = "Demo: Peta jaringan listrik Jawa–Bali gabungan (OSM riil)"


def _e():
    import demo_grid_e2e as e

    return e


def _saluran_gabungan() -> list[dict]:
    import demo_grid_peta_jawa_bali as jb

    out: dict[str, dict] = {}
    for f in jb._feats("jabar_transmisi_osm.geojson"):
        p = f["properties"]
        if p.get("jenis") != "saluran" or not jb._geometri_wajar(f["geometry"]):
            continue
        cs = f["geometry"]["coordinates"]
        la = sum(c[1] for c in cs) / len(cs)
        lo = sum(c[0] for c in cs) / len(cs)
        out[p["osm_id"]] = {"osm_id": p["osm_id"], "nama": p.get("nama") or "Saluran (tanpa nama di OSM)",
                            "kelas_kv": p.get("kelas_kv") or 0, "operator": p.get("operator"),
                            "geometri": json.dumps(f["geometry"]),
                            "panjang_km": p.get("panjang_dalam_jabar_km") or p.get("panjang_km"),
                            "lokasi": f"{la:.6f},{lo:.6f}", "latitude": round(la, 6), "longitude": round(lo, 6),
                            "cakupan": "Detail Jawa Barat"}
    for r in jb._baris("saluran", tanpa_id=set(out)):
        r["cakupan"] = "Regional Jawa-Bali"
        out[r["osm_id"]] = r
    for r in jb._baris_detail("saluran_detail"):
        if r["osm_id"] not in out:
            r["cakupan"] = "Detail Jabodetabek"
            out[r["osm_id"]] = r
    return sorted(out.values(), key=lambda r: (r["kelas_kv"], r["osm_id"]))


def _gardu_gabungan() -> list[dict]:
    import demo_grid_peta_jawa_bali as jb

    out: dict[str, dict] = {}
    for f in jb._feats("jabar_transmisi_osm.geojson"):
        p = f["properties"]
        if p.get("jenis") != "gardu":
            continue
        out[p["osm_id"]] = {"osm_id": p["osm_id"], "nama": p.get("nama") or "Gardu (tanpa nama di OSM)",
                            "kelas_kv": p.get("kelas_kv") or 0, "operator": p.get("operator"),
                            "jenis_gardu_osm": p.get("substation") or "-", "kabkota": p.get("kabkota"),
                            "lokasi": f"{p['lat']:.6f},{p['lon']:.6f}", "latitude": p.get("lat"), "longitude": p.get("lon"),
                            "cakupan": "Detail Jawa Barat"}
    detail_ids = {r["osm_id"] for r in jb._baris_detail("gardu_detail")}
    for r in jb._baris("gardu"):
        if r["osm_id"] not in out and r["osm_id"] not in detail_ids:
            r["cakupan"] = "Regional Jawa-Bali"
            r.setdefault("kabkota", None)
            out[r["osm_id"]] = r
    return sorted(out.values(), key=lambda r: r["osm_id"])


def _pembangkit_gabungan() -> list[dict]:
    import demo_grid_peta_jabar as pj
    import demo_grid_peta_jawa_bali as jb

    out: dict[str, dict] = {}
    for r in pj.rows_pembangkit():
        r["cakupan"] = "Detail Jawa Barat"
        out[r["osm_id"]] = r
    for r in jb._baris("pembangkit"):
        if r["osm_id"] not in out:
            r["cakupan"] = "Regional Jawa-Bali"
            r.setdefault("kabkota", None)
            out[r["osm_id"]] = r
    return sorted(out.values(), key=lambda r: r["osm_id"])


def _km(a, b) -> float:
    import math

    p1, p2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 6371 * 2 * math.asin(min(1.0, math.sqrt(h)))


def _titik_terdekat(pt, indeks: dict, sel: float = 0.05):
    """Indeks grid titik (lon,lat) -> kandidat dalam sel sendiri + 8 tetangga."""
    cx, cy = int(pt[0] / sel), int(pt[1] / sel)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            yield from indeks.get((cx + dx, cy + dy), [])


def _koneksi(saluran_rows: list[dict], titik_rows: list[dict]):
    """Gardu/pembangkit sebagai simpul jaringan: ujung saluran ditempelkan ke titik terdekat (<=1,5 km) dan
    titik yang belum menempel ke garis diberi garis penghubung turunan ke titik garis terdekat (<=1,5 km).
    Mengembalikan (baris saluran berujung, baris penghubung, statistik keterhubungan)."""
    titik = []
    for r in titik_rows:
        la, lo = (float(x) for x in r["lokasi"].split(","))
        titik.append({"osm_id": r["osm_id"], "nama": r["nama"], "lonlat": (lo, la), "kelas_kv": r.get("kelas_kv") or 0})
    idx_titik: dict = {}
    for t in titik:
        idx_titik.setdefault((int(t["lonlat"][0] / 0.05), int(t["lonlat"][1] / 0.05)), []).append(t)
    # indeks segmen garis per sel 0.05 derajat
    idx_seg: dict = {}
    garis: list[list] = []
    for r in saluran_rows:
        cs = [tuple(c) for c in json.loads(r["geometri"])["coordinates"]]
        garis.append(cs)
        for a, b in zip(cs, cs[1:]):
            kunci = (int(((a[0] + b[0]) / 2) / 0.05), int(((a[1] + b[1]) / 2) / 0.05))
            idx_seg.setdefault(kunci, []).append((a, b, r["osm_id"]))

    def titik_di(pt, batas_km):
        best = (batas_km, None)
        for t in _titik_terdekat(pt, idx_titik):
            d = _km(pt, t["lonlat"])
            if d < best[0]:
                best = (d, t)
        return best

    for r, cs in zip(saluran_rows, garis):
        for sisi, pt in (("a", cs[0]), ("b", cs[-1])):
            _, t = titik_di(pt, 1.5)
            r[f"gardu_ujung_{sisi}"] = t["osm_id"] if t else None
            r[f"nama_ujung_{sisi}"] = t["nama"] if t else None
    penghubung, menempel = [], 0
    for t in titik:
        best = (1.5, None)
        for a, b, oid in _titik_terdekat(t["lonlat"], idx_seg):
            for q in (a, b):
                d = _km(t["lonlat"], q)
                if d < best[0]:
                    best = (d, (q, oid))
        if best[1] is None:
            continue
        (q, oid), d = best[1], best[0]
        if d <= 0.15:
            menempel += 1
            continue
        penghubung.append({"osm_id": f"hub:{t['osm_id']}", "nama": f"Penghubung {t['nama']}", "gardu_osm_id": t["osm_id"],
                           "nama_gardu": t["nama"], "saluran_osm_id": oid, "jarak_km": round(d, 2),
                           "geometri": json.dumps({"type": "LineString", "coordinates": [[t["lonlat"][0], t["lonlat"][1]], [q[0], q[1]]]}),
                           "lokasi": f"{t['lonlat'][1]:.6f},{t['lonlat'][0]:.6f}",
                           "latitude": t["lonlat"][1], "longitude": t["lonlat"][0]})
    # statistik: komponen ruas dengan ujung berklaster <=0,4 km + titik menempel/penghubung sebagai simpul
    induk = list(range(len(saluran_rows)))

    def find(x):
        while induk[x] != x:
            induk[x] = induk[induk[x]]
            x = induk[x]
        return x

    ujung: dict = {}
    for i, cs in enumerate(garis):
        for pt in (cs[0], cs[-1]):
            kunci = (round(pt[0] / 0.004), round(pt[1] / 0.004))
            if kunci in ujung:
                a, b = find(i), find(ujung[kunci])
                if a != b:
                    induk[a] = b
            else:
                ujung[kunci] = i
    # gardu yang sama di ujung dua ruas menyatukan kedua ruas (interkoneksi antar kelas terjadi di gardu)
    per_gardu: dict[str, int] = {}
    for i, r in enumerate(saluran_rows):
        for sisi in ("a", "b"):
            g = r.get(f"gardu_ujung_{sisi}")
            if not g:
                continue
            if g in per_gardu:
                a, b = find(i), find(per_gardu[g])
                if a != b:
                    induk[a] = b
            else:
                per_gardu[g] = i
    from collections import Counter

    hitung = Counter(find(i) for i in range(len(saluran_rows)))
    terbesar = hitung.most_common(1)[0][1] if hitung else 0
    stats = {"ruas": len(saluran_rows), "komponen_ruas": len(hitung),
             "ruas_komponen_terbesar": terbesar,
             "pct_ruas_terhubung": round(terbesar / len(saluran_rows) * 100) if saluran_rows else 0,
             "titik_menempel_langsung": menempel, "penghubung": len(penghubung),
             "ruas_berujung_gardu": sum(1 for r in saluran_rows if r.get("gardu_ujung_a") or r.get("gardu_ujung_b"))}
    return penghubung, stats


def build(state: dict, save) -> dict:
    import geospatial
    import ontology
    import demo_grid_peta_jabar as pj
    import demo_grid_peta_jawa_bali as jb

    e = _e()
    st = state.setdefault("peta_gabungan", {})
    project = e._folder(None, e.PROJECT, "project")
    konteks = e._folder(e._folder(project, "raw"), "konteks")
    saluran_rows = _saluran_gabungan()
    gardu_rows = _gardu_gabungan()
    pemb_rows = _pembangkit_gabungan()
    detail_rows = jb._baris_detail("gardu_detail")
    penghubung_rows, koneksi = _koneksi(saluran_rows, gardu_rows + pemb_rows)
    ds = {"saluran_gabungan_osm": e._put(konteks, "saluran_gabungan_osm", saluran_rows),
          "gardu_gabungan_osm": e._put(konteks, "gardu_gabungan_osm", gardu_rows),
          "pembangkit_gabungan_osm": e._put(konteks, "pembangkit_gabungan_osm", pemb_rows),
          "gardu_detail_jabodetabek_osm": e._put(konteks, "gardu_detail_jabodetabek_osm", detail_rows),
          "penghubung_jaringan_osm": e._put(konteks, "penghubung_jaringan_osm", penghubung_rows)}
    titik = [("osm_id", "OSM id", "string"), ("nama", "Nama", "string"), ("kelas_kv", "Kelas (kV)", "integer"),
             ("operator", "Operator", "string"), ("lokasi", "Lokasi", "geopoint"),
             ("latitude", "Latitude", "double"), ("longitude", "Longitude", "double"), ("cakupan", "Cakupan data", "string")]
    saluran_id = pj._ensure_type("Transmission Line Java-Bali Combined (OSM)", "SaluranGabunganJawaBaliOsm", "osm_id", "nama", "route", "#b4123a",
                                 "Konteks nyata: semua saluran listrik Jawa-Bali dari OpenStreetMap (ODbL), digabung tanpa dobel (detail Jabar menang). Tanpa angka demo.",
                                 [("osm_id", "OSM id", "string"), ("nama", "Nama", "string"), ("kelas_kv", "Kelas (kV)", "integer"),
                                  ("operator", "Operator", "string"), ("geometri", "Geometri", "geoshape"),
                                  ("panjang_km", "Panjang (km)", "double"), ("lokasi", "Titik tengah", "geopoint"),
                                  ("latitude", "Latitude", "double"), ("longitude", "Longitude", "double"),
                                  ("cakupan", "Cakupan data", "string"), ("gardu_ujung_a", "Gardu ujung A (OSM id)", "string"),
                                  ("nama_ujung_a", "Gardu ujung A", "string"), ("gardu_ujung_b", "Gardu ujung B (OSM id)", "string"),
                                  ("nama_ujung_b", "Gardu ujung B", "string")], ds["saluran_gabungan_osm"])
    hub_id = pj._ensure_type("Network Interconnection (OSM-derived)", "PenghubungJaringanOsm", "osm_id", "nama", "route", "#475569",
                             "Turunan OSM: garis penghubung pendek gardu/pembangkit ke saluran terdekat (<=1,5 km) agar titik menempel ke jaringan. Bukan saluran listrik.",
                             [("osm_id", "OSM id", "string"), ("nama", "Nama", "string"), ("gardu_osm_id", "Gardu (OSM id)", "string"),
                              ("nama_gardu", "Nama gardu", "string"), ("saluran_osm_id", "Saluran (OSM id)", "string"),
                              ("jarak_km", "Jarak (km)", "double"), ("geometri", "Geometri", "geoshape"),
                              ("lokasi", "Lokasi gardu", "geopoint"), ("latitude", "Latitude", "double"),
                              ("longitude", "Longitude", "double")], ds["penghubung_jaringan_osm"])
    gardu_id = pj._ensure_type("Substation Java-Bali Combined (OSM)", "GarduGabunganJawaBaliOsm", "osm_id", "nama", "bolt", "#1e293b",
                               "Konteks nyata: gardu transmisi Jawa-Bali dari OpenStreetMap (ODbL), digabung tanpa dobel. Tanpa angka demo.",
                               titik + [("jenis_gardu_osm", "Jenis gardu (OSM)", "string"), ("kabkota", "Kabupaten/kota", "string")],
                               ds["gardu_gabungan_osm"])
    pemb_id = pj._ensure_type("Power Plant Java-Bali Combined (OSM)", "PembangkitGabunganJawaBaliOsm", "osm_id", "nama", "bolt", "#2563eb",
                              "Konteks nyata: pembangkit listrik Jawa-Bali dari OpenStreetMap (ODbL), digabung tanpa dobel. Tanpa angka demo.",
                              titik + [("sumber", "Sumber (OSM)", "string"), ("sumber_label", "Bahan bakar", "string"),
                                       ("kapasitas_mw", "Kapasitas (MW)", "double"), ("kapasitas_teks", "Kapasitas (teks OSM)", "string"),
                                       ("kabkota", "Kabupaten/kota", "string")], ds["pembangkit_gabungan_osm"])
    gardu_det_id = pj._ensure_type("Substation Detail Jabodetabek (OSM)", "GarduDetailJabodetabekOsm", "osm_id", "nama", "bolt", "#0e7490",
                                   "Konteks nyata: semua gardu (power=substation) di bbox Jabodetabek dari OpenStreetMap (ODbL). Tanpa angka demo.",
                                   titik + [("jenis_gardu_osm", "Jenis gardu (OSM)", "string")], ds["gardu_detail_jabodetabek_osm"])
    by_name = {x["display_name"]: x["id"] for x in ontology._all("object-types")}
    ids = {k: (e._type(k) or {}).get("id") for k in ("kawasan",)}
    Lr = geospatial.Layer

    def saluran(nama: str, kv, color: str, width: float, opacity: float) -> dict:
        nilai = {"op": "eq", "value": kv} if isinstance(kv, int) else {"op": "in", "value": kv}
        return Lr(name=nama, kind="objects", color=color, opacity=opacity,
                  config={"object_type_id": saluran_id, "property": "geometri", "line_width": width,
                          "filters": [{"property": "kelas_kv", **nilai}]}).model_dump()

    lain = sorted({r["kelas_kv"] for r in saluran_rows} - {500, 150, 70})
    layers = [
        Lr(name="Batas kabupaten/kota Jawa Barat", kind="objects", color="#64748b", opacity=0.45,
           config={"object_type_id": by_name.get("Regency/City Boundary West Java (OSM)"), "property": "geometri", "line_width": 1,
                   "label_key": "nama"}).model_dump(),
        saluran("SUTET 500 kV", 500, "#b4123a", 3, 0.95),
        saluran("SUTT 150 kV", 150, "#d97706", 1.8, 0.85),
        saluran("SUTT 70 kV", 70, "#0f766e", 1.2, 0.75),
        saluran("Saluran tegangan lain / tak diketahui", lain or [0], "#94a3b8", 1, 0.6),
        Lr(name="Penghubung gardu–saluran (turunan OSM)", kind="objects", color="#475569", opacity=0.55,
           config={"object_type_id": hub_id, "property": "geometri", "line_width": 1, "label_key": "nama_gardu"}).model_dump(),
        Lr(name="Gardu transmisi — warna kelas tegangan", kind="objects", color="#1e293b", opacity=1.0,
           config={"object_type_id": gardu_id, "property": "lokasi", "radius": 5, "color_by": "kelas_kv",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Gardu detail Jabodetabek (semua gardu)", kind="objects", color="#0e7490", opacity=0.9,
           config={"object_type_id": gardu_det_id, "property": "lokasi", "radius": 3.5, "color_by": "jenis_gardu_osm",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Pembangkit — warna bahan bakar", kind="objects", color="#2563eb", opacity=1.0,
           config={"object_type_id": pemb_id, "property": "lokasi", "radius": 6, "color_by": "sumber_label",
                   "color_mode": "category", "label_key": "nama"}).model_dump(),
        Lr(name="Kawasan industri Jawa Barat", kind="objects", color="#7c3aed", opacity=0.65,
           config={"object_type_id": ids["kawasan"], "property": "lokasi", "radius": 4, "label_key": "nama"}).model_dump(),
    ]
    k500 = [r for r in saluran_rows if r["kelas_kv"] == 500]
    desc = (f"Satu peta gabungan jaringan listrik Jawa-Bali, MURNI data riil OpenStreetMap (ODbL) tanpa data fiktif: "
            f"{len(saluran_rows)} saluran tanpa dobel ({len(k500)} ruas 500 kV), {len(gardu_rows)} gardu transmisi, "
            f"{len(detail_rows)} gardu detail Jabodetabek, {len(pemb_rows)} pembangkit, 46 kawasan industri, 28 batas "
            f"kabupaten/kota Jawa Barat. Detail Jabar & Jabodetabek menyatu di layer yang sama per kelas tegangan "
            f"(cakupan data tercatat di tiap objek). Semua titik & garis menyatu sebagai SATU jaringan lewat gardu: "
            f"{koneksi['ruas_berujung_gardu']} ruas berujung gardu/pembangkit bernama, {koneksi['titik_menempel_langsung']} titik "
            f"menempel langsung ke garis, {koneksi['penghubung']} garis penghubung turunan (<=1,5 km, bukan saluran) menempelkan "
            f"sisanya; {koneksi['pct_ruas_terhubung']}% ruas berada di komponen jaringan terbesar ({koneksi['komponen_ruas']} komponen; "
            f"pulau jaringan daerah yang terpisah memang belum tersambung di pemetaan OSM).")
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
            name="Peta gabungan jaringan listrik Jawa-Bali (Maps)", kind="page", href=f"/map/{mid}", icon="map",
            collection="Grid Management",
            description="Satu peta gabungan jaringan listrik Jawa-Bali murni OSM riil, tanpa dobel — Maps.",
            tags=["grid", "maps", "jawa-bali", "gabungan", "demo"]))
    except Exception:  # noqa: BLE001
        pass
    st.update(map_id=mid, layers=len(layers), baris={"saluran": len(saluran_rows), "saluran_500": len(k500),
              "gardu": len(gardu_rows), "gardu_detail_jabodetabek": len(detail_rows), "pembangkit": len(pemb_rows),
              "penghubung": len(penghubung_rows)}, konektivitas=koneksi,
              datasets=ds, pada=datetime.now(timezone.utc).isoformat())
    save()
    return {"map": mid, "layers": len(layers), "baris": st["baris"]}


def overview_numbers() -> dict:
    st = _e().STATE.get("peta_gabungan") or {}
    return {"map": st.get("map_id"), "baris": st.get("baris")}
