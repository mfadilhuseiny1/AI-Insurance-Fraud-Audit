"""Demo JKN: the end-to-end architecture of "JKN Healthcare System Intelligence", live.

The page /demo-jkn/arsitektur draws the system as layers — sources, storage, pipelines and transforms, clean data, the
Nexus (ontology), intelligence (screening rules, the anomaly model, IoT reconciliation, the priority score, Bluesand
Orbis) and the applications — with the cross-cutting layers under them (lineage and schedules, security and
governance). Every block names what it does in plain words and the platform application that does it, carries live
numbers read from the platform (rows, builds, objects, findings, vectors…) and links to where it lives. Named flows
(a claim becoming an audit priority, a doctor's billing becoming an anomaly, a device's power becoming IoT evidence,
an identity becoming a pseudonym, everything becoming answerable in Orbis) light up the blocks they pass through.

Read-only. Mounted by server.py under /api/demo/jkn/arsitektur.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Optional

from fastapi import APIRouter

import auth

log = logging.getLogger("bluesandai.demo_jkn_arsitektur")
router = APIRouter(prefix="/api/demo/jkn/arsitektur")

PROJECT = "JKN Healthcare System Intelligence"
_cache: dict[str, Any] = {}

LAYERS = [
    ("sumber", "Sumber data", "Sistem BPJS Kesehatan, faskes dan perangkat yang menghasilkan data"),
    ("simpan", "Penyimpanan & integrasi", "Data mendarat apa adanya; bacaan sensor masuk basis data deret waktu"),
    ("olah", "Pipeline & transform", "Membersihkan, menggabungkan, menghitung — terjadwal saat data baru masuk"),
    ("bersih", "Dataset bersih", "Data siap pakai, tervalidasi, dengan riwayat versi"),
    ("nexus", "BluesandAI Nexus", "Objek operasional, relasi, action dan function — satu bahasa untuk semua aplikasi"),
    ("cerdas", "Kecerdasan", "Aturan, machine learning, IoT, prioritas, dan graf pengetahuan"),
    ("aplikasi", "Aplikasi & keputusan", "Tempat tim audit bekerja dan memutuskan"),
]

# (id, layer, title, plain explanation, platform application)
BLOCKS = [
    ("src_klaim", "sumber", "e-Klaim & SEP", "Klaim INA-CBG per SEP, layanan, rujukan, resep, lab, dana kapitasi.", "Sumber BPJS"),
    ("src_peserta", "sumber", "VClaim kepesertaan", "Identitas peserta di balik tiap SEP (NIK, nomor kartu).", "Sumber BPJS"),
    ("src_faskes", "sumber", "Aplicares & HFIS", "Register faskes, koordinat, dokter dan izin praktik.", "Sumber BPJS"),
    ("src_aspak", "sumber", "ASPAK", "Register alat kesehatan per faskes.", "Sumber Kemenkes"),
    ("src_iot", "sumber", "Gateway IoT RS", "Meter listrik alat medis tiap 2 menit; ringkasan harian dari 444 RS.", "Perangkat edge"),
    ("store_raw", "simpan", "Files · raw/", "Berkas mentah apa adanya, per sumber — dasar penelusuran (lineage).", "Files & Projects"),
    ("store_ts", "simpan", "Time Series DB", "Deret daya listrik per meter untuk grafik dan bukti.", "Time Series"),
    ("pipe_audit", "olah", "Pipeline audit faskes", "Membersihkan klaim, faskes, dokter; skor skrining dan kasus berisiko.", "Pipeline Builder"),
    ("pipe_rules", "olah", "Aturan skrining (Python)", "20 subkategori Efisiensi Risiko sebagai transform yang bisa diaudit.", "Code Repositories"),
    ("pipe_ml", "olah", "Pelatihan & skor anomali", "Profil klaim per dokter → 8 detektor → skor, suara, alasan Shapley.", "Code Repositories · Pipeline Builder"),
    ("pipe_iot", "olah", "Pipeline IoT", "Bacaan → siklus pemakaian → rekonsiliasi dengan klaim (pilot & nasional).", "Pipeline Builder"),
    ("pipe_pseudo", "olah", "Pseudonimisasi (Cipher)", "Identitas peserta dienkripsi/di-hash; penanda PHI tidak diturunkan.", "Code Repositories · Cipher"),
    ("store_clean", "bersih", "clean/ · ml/ · iot/ · governance/", "Dataset bersih yang mendukung objek, model dan aplikasi.", "Datasets"),
    ("nexus_objects", "nexus", "Objek & relasi", "Faskes, dokter, kasus, klaim, alat, temuan, RS jejaring, wilayah — saling terhubung.", "Nexus Manager"),
    ("nexus_actions", "nexus", "Action & function", "Keputusan tim audit (action) dan logika bersama (function), tercatat di riwayat edit.", "Actions · Functions"),
    ("nexus_machinery", "nexus", "Device and Machinery", "Status operasi alat medis sebagai proses: mati, siaga, beroperasi.", "Device and Machinery"),
    ("intel_rules", "cerdas", "Skrining aturan", "Temuan per subkategori risiko → skor risiko faskes.", "Code Repositories"),
    ("intel_ml", "cerdas", "Model anomali dokter", "Tanpa label: mencari dokter yang pola tagihannya tidak lazim.", "Models"),
    ("intel_iot", "cerdas", "Bukti IoT", "Tindakan yang diklaim melebihi pemakaian alat yang terukur.", "Pipeline Builder · Time Series"),
    ("intel_prio", "cerdas", "Skor prioritas", "65% aturan + 35% anomali + bukti IoT → P1, P2, P3.", "Functions"),
    ("intel_orbis", "cerdas", "Bluesand Orbis", "Graf pengetahuan semua data demo + indeks vector orbis-1 untuk tanya-jawab.", "Bluesand Orbis"),
    ("app_audit", "aplikasi", "Ruang Kerja Audit", "Antrean prioritas, berkas faskes, anomali ML, IoT, pantauan nasional, tata kelola.", "Aplikasi OSDK"),
    ("app_workshop", "aplikasi", "Kokpit Workshop", "Metrik, saringan, penjelasan risiko dan keputusan dalam satu layar.", "Workshop"),
    ("app_vertex", "aplikasi", "Vertex & Peta", "Jaringan rujukan dan hotspot di graf; faskes dan RS di peta.", "Vertex · Map"),
    ("app_orbis", "aplikasi", "Tanya Orbis", "Pertanyaan bahasa alami dijawab dari graf, dengan rujukan simpulnya.", "Bluesand Orbis"),
]

FLOWS = [
    ("prioritas", "Klaim → prioritas audit", "#f97316",
     ["src_klaim", "src_faskes", "store_raw", "pipe_audit", "pipe_rules", "store_clean", "nexus_objects", "intel_rules", "intel_prio", "app_audit", "app_workshop", "nexus_actions"],
     "Klaim dan data faskes dibersihkan, diuji 20 aturan skrining, menjadi skor risiko faskes, lalu prioritas audit yang diputuskan tim lewat action."),
    ("anomali", "Pola tagihan dokter → anomali ML", "#a78bfa",
     ["src_klaim", "src_faskes", "store_raw", "pipe_audit", "store_clean", "pipe_ml", "intel_ml", "nexus_objects", "intel_prio", "app_audit"],
     "Klaim per dokter diringkas menjadi profil, dinilai 8 detektor, dan dokter yang tidak lazim — terutama tanpa kasus aturan — naik ke antrean."),
    ("iot", "Listrik alat → bukti IoT", "#14b8a6",
     ["src_iot", "src_aspak", "src_klaim", "store_raw", "pipe_iot", "store_ts", "store_clean", "intel_iot", "nexus_objects", "nexus_machinery", "intel_prio", "app_audit", "app_vertex"],
     "Pemakaian alat dari meter listrik dibandingkan dengan tindakan yang diklaim; selisihnya menjadi temuan yang bisa ditelusuri sampai bacaan mentah."),
    ("identitas", "Identitas → pseudonim", "#ef4444",
     ["src_peserta", "store_raw", "pipe_pseudo", "store_clean", "app_audit"],
     "Identitas peserta ditandai PHI saat mendarat, dipseudonimkan dengan Cipher, dan hanya pseudonim yang dipakai untuk analisis."),
    ("orbis", "Semua data → Tanya Orbis", "#60a5fa",
     ["store_clean", "nexus_objects", "nexus_actions", "intel_ml", "intel_rules", "intel_iot", "intel_orbis", "app_orbis"],
     "Dataset, objek, model, rujukan dan keputusan dirangkai menjadi graf pengetahuan, di-embed ke orbis-1, dan dijawab dalam bahasa alami."),
]

CROSS = [
    ("lineage", "Lineage & jadwal", "Setiap dataset, pipeline, objek dan aplikasi terhubung di Data Lineage; build berjalan otomatis saat data sumber berubah.", "/lineage?graph=jknaudit"),
    ("governance", "Keamanan & tata kelola", "Pemindai data sensitif, penanda akses, Cipher, kebijakan objek, checkpoint, retensi dan log audit — di setiap lapisan.", "/demo-jkn/audit?tab=tata_kelola"),
]


def _safe(fn: Callable[[], Any], default: Any = None) -> Any:
    try:
        return fn()
    except Exception:  # noqa: BLE001 - one missing metric never breaks the page
        log.exception("arsitektur metric failed")
        return default


def _num(v: Any) -> str:
    try:
        return f"{int(v):,}".replace(",", ".")
    except (TypeError, ValueError):
        return str(v)


def _collect() -> dict[str, dict]:
    import db
    import demo_jkn_e2e as e
    import ontology

    st = e.STATE
    project = st.get("project_id") or e._folder(None, PROJECT, "project")
    items = _safe(lambda: db.drive_subtree(project), []) or []
    by_folder: dict[str, list[dict]] = {}
    for it in items:
        if str(it.get("name") or "").endswith(".parquet"):
            top = (it.get("rel") or "").split("/")
            by_folder.setdefault(top[1] if len(top) > 2 else "(akar)", []).append(it)
    out: dict[str, dict] = {b[0]: {"metrics": [], "links": []} for b in BLOCKS}

    def m(block: str, label: str, value: Any) -> None:
        if value not in (None, ""):
            out[block]["metrics"].append([label, value if isinstance(value, str) else _num(value)])

    def link(block: str, label: str, href: Optional[str]) -> None:
        if href:
            out[block]["links"].append([label, href])

    rows = st.get("rows") or {}
    raw = by_folder.get("raw", [])
    m("src_klaim", "berkas klaim & layanan", sum(1 for k in rows if any(w in k for w in ("klaim", "layanan", "rujukan", "resep", "lab", "kapitasi"))))
    m("src_klaim", "baris klaim per SEP", _safe(lambda: len(__import__("demo_jkn_workbench")._clean_file("clean", "klaim_sep_bersih"))))
    m("src_faskes", "faskes", rows.get("faskes_register_aplicares"))
    m("src_faskes", "dokter", rows.get("dokter_hfis"))
    gi = st.get("gov_items") or {}
    m("src_peserta", "SEP dengan identitas", _safe(lambda: len(__import__("demo_jkn_workbench")._clean_file("raw", "peserta_klaim_raw"))))
    link("src_peserta", "Dataset mentah (perlu PHI)", gi.get("raw") and f"/datasets/{gi['raw']}")
    m("src_aspak", "alat pilot", 16)
    m("src_iot", "RS terhubung (nasional)", _safe(lambda: next((o["properties"].get("rs_terhubung") for o in ontology.stored_objects(_type_id("Wilayah JKN (demo)")).values()
                                                               if (o.get("properties") or {}).get("tingkat") == "Nasional"), None)))
    m("store_raw", "dataset mentah", len(raw))
    m("store_raw", "ukuran", f"{sum(int(it.get('size_bytes') or 0) for it in raw) / 1e6:.1f}".replace(".", ",") + " MB")
    link("store_raw", "Buka folder Project", f"/files?folder={project}")
    m("store_ts", "sync deret waktu", sum(1 for k in ("iot_sync_id", "iot_nasional_sync_id") if st.get(k)))
    link("store_ts", "Time Series", "/time-series")

    import pipeline_runtime as rt

    def pipe(block: str, label: str, pid: Optional[str], metric: str = "build terakhir") -> None:
        if not pid:
            return
        b = _safe(lambda: (rt.list_builds(pid, 1) or [None])[0])
        name = _safe(lambda: db.drive_get(pid)["name"].removesuffix(".pipeline"), label)
        m(block, metric, (b or {}).get("status") or "—")
        link(block, name, f"/pipeline/{pid}")

    pipe("pipe_audit", "Pipeline audit", st.get("pipeline_id"))
    pipe("pipe_ml", "Pipeline skor anomali", st.get("scoring_pipeline_id"))
    pipe("pipe_iot", "Pipeline IoT pilot", st.get("iot_pipeline_id"), "build pilot")
    pipe("pipe_iot", "Pipeline IoT nasional", st.get("iot_nasional_pipeline_id"), "build nasional")
    import code_repos

    repos = {r["name"]: r["id"] for r in _safe(code_repos.list_repos, []) or []}
    for block, name in (("pipe_rules", "Deteksi Risiko JKN - demo"), ("pipe_ml", "Deteksi Anomali JKN demo"), ("pipe_pseudo", "Pseudonimisasi peserta JKN demo")):
        link(block, f"Repositori {name}", repos.get(name) and f"/code-repositories/{repos[name]}")
    m("pipe_rules", "subkategori risiko", 20)
    m("pipe_ml", "detektor", 8)
    m("pipe_pseudo", "status build", st.get("gov_pseudo_built"))
    folders = {k: len(v) for k, v in by_folder.items() if k != "raw"}
    m("store_clean", "dataset", sum(folders.values()))
    for k in ("clean", "ml", "iot", "governance"):
        m("store_clean", k + "/", folders.get(k))

    types = [t for t in _safe(ontology.list_object_types, []) or [] if "(demo)" in t["display_name"] and " log " not in t["display_name"]
             and any(w in t["display_name"] for w in ("JKN", "Faskes", "Klaim"))]
    m("nexus_objects", "tipe objek", len(types))
    m("nexus_objects", "objek", sum(int(t.get("object_count") or 0) for t in types))
    tids = {t["id"] for t in types}
    import ontology_model as om

    m("nexus_objects", "tipe relasi", _safe(lambda: sum(1 for lt in om._all("link-types") if lt["source"]["object_type_id"] in tids or lt["target"]["object_type_id"] in tids)))
    fk = _type_id("Faskes Audit JKN (demo)")
    link("nexus_objects", "Faskes Audit di Nexus", fk and f"/ontology/{fk}")
    acts = _safe(lambda: [a for a in ontology._all("action-types") if a.get("object_type_id") in tids], []) or []
    m("nexus_actions", "action", len(acts))
    import functions_registry as fr

    m("nexus_actions", "function", _safe(lambda: sum(1 for f in fr.all_functions() if f.get("repo_id") == st.get("functions_repo_id"))))
    m("nexus_actions", "keputusan tercatat", _safe(lambda: sum(len(__import__("ontology_edits").layer(t)) for t in tids)))
    link("nexus_actions", "Functions", "/functions")
    import machinery

    mach = [x for x in _safe(machinery._all, []) or [] if "JKN" in (x.get("name") or "")]
    m("nexus_machinery", "proses", sum(len(x.get("processes") or []) or 1 for x in mach))
    link("nexus_machinery", "Device and Machinery", mach and f"/machinery?id={mach[0]['id']}")
    kat = _type_id("Kategori Risiko JKN (demo)")
    m("intel_rules", "kategori risiko", 20)
    m("intel_rules", "kasus berisiko", _safe(lambda: len(ontology.stored_objects(_type_id("Kasus Rujukan Berisiko JKN (demo)")))))
    link("intel_rules", "Kategori risiko", kat and f"/ontology/{kat}")
    exp = st.get("ml_experiment") or {}
    auroc = ((exp.get("metrics") or {}).get("auroc/ensembel_embedding") or [{}])
    m("intel_ml", "AUROC ensembel", f"{(auroc[-1] if isinstance(auroc, list) else {}).get('value', 0):.3f}" if auroc else None)
    m("intel_ml", "dokter dinilai", (st.get("ml") or {}).get("scored"))
    link("intel_ml", "Model", (st.get("ml") or {}).get("model_id") and f"/models/{st['ml']['model_id']}")
    link("intel_ml", "Penjelasan anomali", "/demo-jkn/audit?tab=anomali")
    tem = _type_id("Temuan IoT JKN (demo)")
    m("intel_iot", "temuan IoT", _safe(lambda: len(ontology.stored_objects(tem)) if tem else None))
    m("intel_iot", "nilai tak didukung (pilot)", _safe(lambda: "Rp " + f"{(st.get('iot') or {}).get('temuan', {}).get('nilai_rp', 0) / 1e6:.1f}".replace(".", ",") + " jt"))
    link("intel_iot", "IoT alat medis", "/demo-jkn/audit?tab=iot")
    m("intel_prio", "faskes P1", _safe(lambda: __import__("demo_jkn_workbench").queue()["kpi"]["p1"]))
    link("intel_prio", "Antrean prioritas", "/demo-jkn/audit?tab=antrian")
    import orbis

    og = _safe(orbis._graph, {}) or {}
    m("intel_orbis", "simpul", (og.get("stats") or {}).get("nodes"))
    m("intel_orbis", "relasi", (og.get("stats") or {}).get("links"))
    m("intel_orbis", "vector orbis-1", _safe(lambda: orbis.index_status().get("vectors")))
    link("intel_orbis", "Bluesand Orbis", "/orbis")
    link("app_audit", "Ruang Kerja Audit", "/demo-jkn/audit")
    m("app_audit", "halaman", 8)
    link("app_workshop", "Kokpit Workshop", st.get("workshop_id") and f"/workshop/{st['workshop_id']}")
    import geospatial
    import vertex

    graphs = [g for g in _safe(vertex.list_graphs, []) or [] if "JKN" in g.get("name", "") or "faskes" in g.get("name", "").lower() or "Demo:" in g.get("name", "")]
    maps = [x for x in _safe(geospatial.list_maps, []) or [] if "JKN" in x.get("name", "")]
    m("app_vertex", "graf Vertex", len(graphs))
    m("app_vertex", "peta", len(maps))
    for x in maps[:2]:
        link("app_vertex", x["name"].replace("Demo: ", ""), f"/map/{x['id']}")
    link("app_orbis", "Tanya Orbis", "/orbis")
    return out


def _type_id(name: str) -> Optional[str]:
    import demo_jkn_map as jm

    t = jm._type(name)
    return t["id"] if t else None


@router.get("")
def architecture() -> dict:
    auth.require_user()
    if not _cache.get("at") or time.time() - _cache["at"] > 60:
        _cache.update(at=time.time(), live=_collect())
    live = _cache["live"]
    gov = None
    try:
        import demo_jkn_e2e as e
        import governance_center as gc

        gov = sum(1 for p in gc.overview(e.STATE.get("project_id") or e._folder(None, PROJECT, "project"))["posture"] if p["ok"])
    except Exception:  # noqa: BLE001
        log.exception("governance posture")
    edges: set[tuple[str, str]] = set()
    layer_of = {b[0]: b[1] for b in BLOCKS}
    order = [k for k, _, _ in LAYERS]
    for _, _, _, path, _ in FLOWS:
        for a, b in zip(path, path[1:]):
            if order.index(layer_of[a]) < order.index(layer_of[b]):
                edges.add((a, b))
            elif order.index(layer_of[a]) > order.index(layer_of[b]):
                edges.add((a, b))
    return {
        "project": PROJECT,
        "layers": [{"key": k, "title": t, "desc": d} for k, t, d in LAYERS],
        "blocks": [{"id": i, "layer": la, "title": t, "plain": p, "tech": tech, **live.get(i, {"metrics": [], "links": []})} for i, la, t, p, tech in BLOCKS],
        "flows": [{"id": i, "title": t, "color": c, "path": path, "story": s} for i, t, c, path, s in FLOWS],
        "edges": sorted([{"from": a, "to": b} for a, b in edges], key=lambda x: (x["from"], x["to"])),
        "cross": [{"id": i, "title": t, "desc": d, "href": h, **({"metric": f"{gov}/7 kontrol aktif"} if i == "governance" and gov is not None else {})} for i, t, d, h in CROSS],
    }
