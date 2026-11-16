"""Demo Grid, fase 5 sesi 5 (penutup): peta Nexus di Vertex, layer Maps fase 5, Orbis & lineage diperbarui.
(dipanggil demo_grid_e2e.build, langkah "penutup"; tanpa router sendiri — angkanya dibaca demo_grid_arsitektur).

  - Vertex "Demo: Peta Nexus grid — objek, relasi, fungsi, aksi": contoh objek nyata dari semua lapis Nexus grid
    (GI -> penyulang -> gardu -> pelanggan -> temuan -> perintah kerja; meter AMI & peristiwanya; sensor gardu)
    dengan relasinya, agar pembaca paham: simpul = objek, sisi = link Nexus, dan fungsi/aksi yang bekerja di atasnya
    (dijelaskan di deskripsi graf; buka Functions / Actions / Nexus Manager dari Portal).
  - Maps: peta susut yang ada ditambah layer "AMI Event (demo)" (titik lokasi pelanggan, dari properti lokasi
    baru di tipe Peristiwa) dan "Sensor gardu (demo)" (titik gardu dari register sensor ber-lokasi).
  - Orbis grid dibangun ulang (simpul metode fase 5 + jurnal Taruna 2025) dan indeks vektornya diperbarui;
    graf lineage tersimpan "gridsusut" dihitung ulang agar pipeline & tipe fase 5 masuk.

Fiktif, berlabel "(demo)"; aset OSM nyata tanpa angka demo; read-only ke SCADA.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("bluesandai.demo_grid_penutup")

GRAPH = "Demo: Peta Nexus grid — objek, relasi, fungsi, aksi"
LAYER_PERISTIWA = "Peristiwa AMI dugaan bypass (demo)"
LAYER_SENSOR = "Sensor gardu distribusi (demo)"


def _e():
    import demo_grid_e2e as e

    return e


def _st() -> dict:
    return _e().STATE.setdefault("penutup", {})


def _add_prop(type_id: str, api_name: str, display: str) -> bool:
    import ontology

    rec = ontology._object_type(type_id)
    props = rec.get("properties") or []
    if any(p["api_name"] == api_name for p in props):
        return False
    props = [{k: p.get(k) for k in ("api_name", "display_name", "type", "description", "required", "primary_key",
                                    "value_type_id", "time_series_sync_id", "media_reference_set_id", "classification")}
             for p in props]
    props.append({"api_name": api_name, "display_name": display, "type": "geopoint", "description": "Lokasi (demo)",
                  "required": False, "primary_key": False, "value_type_id": None, "time_series_sync_id": None,
                  "media_reference_set_id": None, "classification": None})
    ontology.update_object_type(type_id, ontology.ObjectTypeIn(
        display_name=rec["display_name"], plural_name=rec.get("plural_name") or rec["display_name"], api_name=rec["api_name"],
        primary_key=rec["primary_key"], title_property=rec.get("title_property"), icon=rec.get("icon"), color=rec.get("color"),
        description=rec.get("description") or "", properties=[ontology.Property(**p) for p in props],
        generate_primary_key=bool(rec.get("generate_primary_key"))))
    return True


def _lokasi_pelanggan() -> dict[str, str]:
    import demo_grid_data as gd

    return {c["id_pelanggan"]: f"{c['lat']:.4f},{c['lon']:.4f}" for c in gd.customers()}


def _backfill_lokasi() -> dict:
    import ontology

    e = _e()
    out: dict[str, Any] = {}
    ntl = e.STATE.get("ntl_stream") or {}
    if ntl.get("type_id"):
        out["prop_peristiwa"] = _add_prop(ntl["type_id"], "lokasi", "Lokasi pelanggan")
        loc = _lokasi_pelanggan()
        objs = ontology.load_objects(ntl["type_id"])
        changed = []
        for pk, o in objs.items():
            p = o.get("properties") or {}
            if not p.get("lokasi") and loc.get(p.get("id_pelanggan") or ""):
                p["lokasi"] = loc[p["id_pelanggan"]]
                changed.append(pk)
        if changed:
            ontology.save_objects(ntl["type_id"], objs, changed=changed)
        out["peristiwa_berlokasi"] = sum(1 for o in objs.values() if (o.get("properties") or {}).get("lokasi"))
    sen = e.STATE.get("sensor_gardu") or {}
    if sen.get("type_id"):
        out["prop_sensor"] = _add_prop(sen["type_id"], "lokasi", "Lokasi gardu")
        import demo_grid_sensor_gardu as sg
        import ontology_datasources as ods

        rows = sg._register_rows()
        net = {d["kode_dt"]: d for d in __import__("demo_grid_data").network()["dts"]}
        for r in rows:
            d = net.get(r["kode_dt"]) or {}
            r["lokasi"] = f"{d['lat']:.6f},{d['lon']:.6f}" if d.get("lat") else None
        folder = e._folder(e._folder(e._folder(None, e.PROJECT, "project"), "iot"), "gardu")
        reg = e._put(folder, sg.REGISTER, rows)
        ods.put_datasource(sen["type_id"], ods.DatasourceIn(dataset_id=reg, columns=None, map_unmapped=True))
        out["register_sensor"] = reg
    return out


def _vertex_nexus() -> dict:
    import ontology
    import vertex

    e = _e()
    if any(g["name"] == GRAPH for g in vertex.list_graphs()):
        return {"graph": GRAPH, "existing": True}
    t = {k: e._type(k) for k in ("gi", "penyulang", "gardu", "pelanggan", "temuan", "perintah")}
    ami_t = next((x for x in ontology._all("object-types") if x["display_name"] == "Grid AMI Meter (demo)"), None)
    per_t = next((x for x in ontology._all("object-types") if x["display_name"] == "AMI Event (demo)"), None)
    sen_t = next((x for x in ontology._all("object-types") if x["display_name"] == "Substation Sensor (demo)"), None)
    if not all(t.values()):
        return {"graph": None}
    layers = e._vertex_layers()
    nodes: list[dict] = []

    def add(rec: dict | None, pk: str | None) -> None:
        if rec and pk:
            nodes.append({"object_type_id": rec["id"], "primary_key": pk})

    gardu_objs = ontology._objects(t["gardu"]["id"])
    g06 = next((pk for pk in gardu_objs if pk == "DT-K06-07"), None) or next(iter(gardu_objs), None)
    add(t["gardu"], g06)
    if g06:
        gp = (gardu_objs[g06].get("properties") or {})
        add(t["penyulang"], gp.get("kode_penyulang"))
        if gp.get("kode_penyulang"):
            po = ontology._objects(t["penyulang"]["id"]).get(gp["kode_penyulang"]) or {}
            add(t["gi"], (po.get("properties") or {}).get("kode_gi"))
    pel = ontology._objects(t["pelanggan"]["id"])
    p1 = next((pk for pk, o in pel.items() if (o.get("properties") or {}).get("kode_dt") == g06
               and (o.get("properties") or {}).get("prioritas") in ("P1", "P2")), None) \
        or next((pk for pk, o in pel.items() if (o.get("properties") or {}).get("kode_dt") == g06), None)
    add(t["pelanggan"], p1)
    tem = ontology._objects(t["temuan"]["id"])
    add(t["temuan"], next((pk for pk, o in tem.items() if (o.get("properties") or {}).get("kode_objek") in (p1, g06)), None))
    per = ontology._objects(t["perintah"]["id"])
    add(t["perintah"], next((pk for pk in per if pk.startswith("PK-SENSOR-")), None)
             or next(iter(per), None))
    truth = __import__("demo_grid_ami")._sim_state().get("events") or []
    if ami_t and truth:
        add(ami_t, truth[0]["no_meter"])
        reg = {m["no_meter"]: m for m in __import__("demo_grid_ami").meters()}
        add(t["pelanggan"], (reg.get(truth[0]["no_meter"]) or {}).get("id_pelanggan"))
    if per_t:
        objs = ontology.stored_objects(per_t["id"])
        add(per_t, next(iter(objs), None))
    if sen_t:
        add(sen_t, g06)
    for rec, color in ((ami_t, "#2c9c9c"), (per_t, "#dc2626"), (sen_t, "#d97706")):
        if rec:
            layers[rec["id"]] = {"color": color, "label_property": "judul", "column": 3}
    desc = ("Cara membaca Nexus di graf ini: SIMPUL adalah objek nyata (satu baris satu aset/pelanggan/temuan); SISI adalah relasi (link type) "
            "Nexus di antaranya — telusuri GI -> penyulang -> gardu -> pelanggan -> temuan -> perintah kerja, dan sensor (meter AMI, sensor gardu) "
            "yang menempel ke pelanggan/gardu. FUNGSI (Functions, 7 fungsi demo: penjelasan susut & temuan, pelanggan berisiko, tetangga segolongan, "
            "nilai Rp gardu, what-if teknis, hitung susut) menghitung jawaban dari objek; AKSI (Actions, 8 aksi: buat perintah kerja, catat hasil P2TL, "
            "eskalasi, ganti meter, jadwal kunjungan, dsb.) mengubah objek dengan izin & audit. Semua simpul di sini contoh dari tipe aslinya — buka "
            "tipe penuhnya di Nexus Manager, fungsinya di Functions, aksinya di Actions.")
    g = vertex.create_graph(vertex.GraphIn(name=GRAPH, layout="flow", line_type="curved", layers=layers, nodes=nodes, description=desc))
    return {"graph": g["id"], "nodes": len(nodes)}


def _map_layers() -> dict:
    import geospatial

    e = _e()
    mid = e.STATE.get("map_id")
    if not mid:
        return {"map": None}
    rec = geospatial._get_map(mid)
    names = {l["name"] for l in rec.get("layers") or []}
    layers = list(rec.get("layers") or [])
    added = []
    ntl = e.STATE.get("ntl_stream") or {}
    sen = e.STATE.get("sensor_gardu") or {}
    if LAYER_PERISTIWA not in names and ntl.get("type_id"):
        layers.append(geospatial.Layer(name=LAYER_PERISTIWA, kind="objects", color="#dc2626", opacity=1.0,
                                       config={"object_type_id": ntl["type_id"], "property": "lokasi", "radius": 6,
                                               "color_by": "status_peristiwa", "color_mode": "category", "label_key": "judul"}).model_dump())
        added.append(LAYER_PERISTIWA)
    if LAYER_SENSOR not in names and sen.get("type_id"):
        layers.append(geospatial.Layer(name=LAYER_SENSOR, kind="objects", color="#d97706", opacity=0.9,
                                       config={"object_type_id": sen["type_id"], "property": "lokasi", "radius": 5,
                                               "color_by": "kva_rating", "color_mode": "range", "color_from": "#22c55e",
                                               "color_to": "#dc2626", "label_key": "kode_dt"}).model_dump())
        added.append(LAYER_SENSOR)
    if added:
        geospatial.save_map(mid, geospatial.MapIn(name=rec["name"], description=rec.get("description") or "",
                                                   basemap=rec.get("basemap") or "streets", view=rec.get("view"), layers=layers))
    return {"map": mid, "added": added, "layers": len(layers)}


def _portal() -> list[str]:
    import agentic_apps

    out = []
    for name, href, desc in (
        ("Peta Nexus grid (Vertex)", "/vertex", "Demo: graf penjelasan Nexus grid — simpul objek, relasi, fungsi dan aksi (Vertex)."),
        ("Peta susut & peristiwa AMI (Maps)", "/map", "Demo: peta jaringan Jabar (OSM) + penyulang/gardu/pelanggan demo + peristiwa AMI & sensor gardu fase 5."),
        ("Fungsi Nexus grid", "/functions", "Demo: fungsi atas objek Nexus grid (penjelasan, risiko, what-if) — dipakai Workshop, AIP Logic dan pipeline."),
        ("Keamanan enterprise (demo grid)", "/enterprise-security", "Kontrol keamanan platform yang berlaku ke demo grid: penanda, kebijakan baris, audit, persetujuan."),
    ):
        out.append(agentic_apps.register(agentic_apps.AppIn(
            name=name, kind="page", href=href, icon="shield", collection="Grid Management", description=desc,
            tags=["grid", "nexus", "demo"]))["id"])
    return out


def build(state: dict, save) -> dict:
    e = _e()
    st = state.setdefault("penutup", {})
    out: dict[str, Any] = {}
    out["lokasi"] = _backfill_lokasi()
    out["vertex"] = _vertex_nexus()
    out["maps"] = _map_layers()
    out["portal"] = _portal()
    st.update(vertex=out["vertex"], maps=out["maps"], pada=datetime.now(timezone.utc).isoformat())
    save()
    try:
        import orbis_grid

        out["orbis"] = orbis_grid.build()
        st["orbis"] = {"nodes": out["orbis"].get("nodes"), "pada": st["pada"]}
    except Exception as ex:  # noqa: BLE001
        out["orbis"] = {"error": str(ex)[:300]}
    save()
    try:
        out["lineage"] = e._ensure_lineage_graph()
        st["lineage"] = out["lineage"]
    except Exception as ex:  # noqa: BLE001
        out["lineage"] = {"error": str(ex)[:300]}
    save()
    return out


def overview_numbers() -> dict:
    st = _e().STATE.get("penutup") or {}
    return {"vertex": (st.get("vertex") or {}).get("graph"), "map_layers": (st.get("maps") or {}).get("layers"),
            "orbis_nodes": (st.get("orbis") or {}).get("nodes")}
