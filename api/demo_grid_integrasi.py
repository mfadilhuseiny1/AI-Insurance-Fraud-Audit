"""Demo Grid: langkah "integrasi" — memastikan seluruh demo SATU sistem yang saling terkait.

Menutup celah antar-app yang tidak terlihat dari cek per-app:
  - Lineage: graf tersimpan `gridsusut` dihitung ulang dengan biji yang diperluas — semua tipe grid & OSM
    (termasuk tipe peta Jabar/Jawa-Bali/gabungan/penghubung, Meter AMI, Peristiwa AMI, Sensor Gardu), keempat
    peta grid, dan seluruh hulu (dataset, pipeline, stream, model) & hilirnya (fungsi, aksi, vertex).
  - Nexus: link type nyata dari objek Saluran Gabungan ke Gardu Gabungan lewat gardu_ujung_a/b, dan dari
    Penghubung ke Saluran — koneksi jaringan bisa ditelusuri sebagai relasi objek, bukan hanya kolom teks.
  - Portal: entri Lineage, Nexus (Ontology), Orbis, dan Cipher untuk demo grid agar semua permukaan tertaut.
  - Orbis: dibangun ulang agar simpul metode/dokumen terbaru ikut terindeks.
"""

from __future__ import annotations

from datetime import datetime, timezone

BIJI_TAMBAHAN = ("Jabar (OSM)", "Jawa-Bali (OSM)", "Gabungan Jawa-Bali (OSM)", "Network Interconnection (OSM-derived)",
                 "Grid AMI Meter (demo)", "AMI Event (demo)", "Substation Sensor (demo)")


def _e():
    import demo_grid_e2e as e

    return e


def _lineage_luas() -> dict:
    import lineage
    import ontology

    e = _e()
    g = lineage.graph()
    nodes = {n["id"]: n for n in g["nodes"]}
    up: dict[str, set] = {}
    down: dict[str, set] = {}
    for ed in g["edges"]:
        down.setdefault(ed["from"], set()).add(ed["to"])
        up.setdefault(ed["to"], set()).add(ed["from"])

    def walk(start, nbrs):
        seen, todo = set(), list(start)
        while todo:
            for w in nbrs.get(todo.pop(), ()):
                if w not in seen:
                    seen.add(w)
                    todo.append(w)
        return seen

    nama_tipe = {t["display_name"] for t in ontology._all("object-types")}
    biji_nama = {v[0] for v in e.T.values()} | {n for n in BIJI_TAMBAHAN if n in nama_tipe}
    seeds = [nid for nid, n in nodes.items() if n["kind"] == "object_type" and n["name"] in biji_nama]
    peta = [nid for nid, n in nodes.items() if n["kind"] == "map" and
            any(k in (n["name"] or "") for k in ("grid", "Jawa Barat", "Jawa–Bali", "Jawa-Bali"))]
    seeds += peta
    desc = walk(seeds, down)
    case = set(seeds) | walk(seeds, up) | desc
    for v in list(desc):
        case |= {w for w in up.get(v, ()) if nodes[w]["kind"] in ("model", "function", "action", "transform")}
    rec = lineage.save_graph(lineage.SavedGraph(name="Lineage susut jaringan grid (demo)", nodes=sorted(case), color_by="type"),
                             id=e.LINEAGE_GRAPH)
    kinds: dict[str, int] = {}
    for v in case:
        kinds[nodes[v]["kind"]] = kinds.get(nodes[v]["kind"], 0) + 1
    return {"graph": rec["id"], "nodes": len(case), "kinds": kinds}


def _links() -> list[str]:
    import ontology
    import ontology_model as om

    made = []
    have = {x.get("display_name") for x in ontology._all("link-types")}
    by_name = {t["display_name"]: t for t in ontology._all("object-types")}
    saluran = by_name.get("Transmission Line Java-Bali Combined (OSM)")
    gardu = by_name.get("Substation Java-Bali Combined (OSM)")
    hub = by_name.get("Network Interconnection (OSM-derived)")
    for nama, src, fk, tgt, sn, tn in (
        ("Line from-end at substation (OSM combined)", saluran, "gardu_ujung_a", gardu, "Saluran ujung A", "Gardu ujung A"),
        ("Line to-end at substation (OSM combined)", saluran, "gardu_ujung_b", gardu, "Saluran ujung B", "Gardu ujung B"),
        ("Interconnection tapped onto line (OSM combined)", hub, "saluran_osm_id", saluran, "Penghubung", "Saluran ditempeli"),
    ):
        if nama in have or not src or not tgt:
            continue
        om.create_link_type(om.LinkTypeIn(display_name=nama, kind="foreign_key", cardinality="many_to_one", foreign_key=fk,
                                          source=om.LinkSide(object_type_id=src["id"], display_name=sn, plural_display_name=sn),
                                          target=om.LinkSide(object_type_id=tgt["id"], display_name=tn, plural_display_name=tn)))
        made.append(nama)
    return made


def _portal() -> list[str]:
    import agentic_apps

    out = []
    for name, href, desc in (
        ("Lineage demo grid (Data Lineage)", "/lineage", "Demo: graf lineage tersimpan gridsusut — pipeline, dataset, Nexus, fungsi, model, peta demo grid."),
        ("Nexus demo grid (Ontology)", "/ontology", "Demo: tipe objek, link, aksi Nexus demo grid — dari gardu & pelanggan sampai saluran OSM gabungan."),
        ("Pengetahuan grid (Orbis)", "/orbis", "Demo: basis pengetahuan Orbis grid — metode susut/NTL, jurnal (termasuk Taruna 2025), dan konteks jaringan."),
        ("Cipher & keamanan data grid", "/cipher", "Demo: penanda dan penyandian PII pelanggan grid di Cipher; kebijakan baris per ULP."),
        ("Peta gabungan Jawa-Bali (Maps)", "/map/map-06d3c34412", "Demo: satu peta gabungan jaringan listrik Jawa-Bali murni OSM riil, terhubung lewat gardu."),
        ("PLN Grid Monitoring Cockpit", "/pln-cockpit", "Analitik operasi jaringan di atas pipeline, Nexus & lineage: pusat alarm (actions Nexus), N-1 trafo GI, "
                                                        "pembebanan termal, keandalan IEEE 1366, risiko aset, N-1 struktural transmisi OSM, Loss Intelligence, integrasi data."),
    ):
        out.append(agentic_apps.register(agentic_apps.AppIn(
            name=name, kind="page", href=href, icon="gauge" if href == "/pln-cockpit" else "map", collection="Grid Management", description=desc,
            tags=["grid", "integrasi", "demo"]))["id"])
    return out


def build(state: dict, save) -> dict:
    st = state.setdefault("integrasi", {})
    out = {"lineage": _lineage_luas(), "links": _links(), "portal": _portal()}
    try:
        import orbis_grid

        out["orbis"] = {"nodes": orbis_grid.build().get("nodes")}
    except Exception as ex:  # noqa: BLE001
        out["orbis"] = {"error": str(ex)[:200]}
    st.update(lineage=out["lineage"], links=out["links"], orbis=out.get("orbis"),
              pada=datetime.now(timezone.utc).isoformat())
    save()
    return out


def overview_numbers() -> dict:
    st = _e().STATE.get("integrasi") or {}
    return {"lineage_nodes": (st.get("lineage") or {}).get("nodes"), "links": st.get("links")}
