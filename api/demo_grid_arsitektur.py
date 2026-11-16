"""Demo Grid: the end-to-end architecture of "Grid Management System Intelligence", live.

The page /demo-grid/arsitektur (components/demo/ArchitectureView.tsx, shared with the JKN demo) draws the system as
layers — sources (NUSAGRID SCADA, AMR/AMI, AP2T billing, P2TL, GIS, OpenStreetMap), storage, pipelines, clean data,
the Nexus, intelligence (physics of technical losses, screening rules, the NTL model, Foundry Rules, what-if scenarios,
Orbis) and the applications — with lineage and security across every layer. Every block carries live numbers read
from the platform and links to where it lives. Named flows light up the blocks they pass through: telemetry →
reliability, kWh → energy balance, meter → P2TL target → label, transformer load → work order, identity → pseudonym,
OT → IT one way.

Read-only. Mounted by server.py under /api/demo/grid/arsitektur.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Optional

from fastapi import APIRouter

import auth

log = logging.getLogger("bluesandai.demo_grid_arsitektur")
router = APIRouter(prefix="/api/demo/grid/arsitektur")

PROJECT = "Grid Management System Intelligence"
_cache: dict[str, Any] = {}

LAYERS = [
    ("sumber", "Sumber data", "Sistem OT (SCADA, meter) dan IT (tagihan, P2TL, GIS) yang menghasilkan data"),
    ("simpan", "Penyimpanan & integrasi", "Data mendarat apa adanya lewat zona antara OT→IT; beban per jam masuk deret waktu"),
    ("olah", "Pipeline & transform", "Membersihkan, menggabungkan, menghitung neraca dan susut — terjadwal saat data berubah"),
    ("bersih", "Dataset bersih", "Data siap pakai, tervalidasi (Data Health), dengan riwayat versi"),
    ("nexus", "BluesandAI Nexus", "Objek jaringan, relasi, action dan function — satu bahasa untuk semua aplikasi"),
    ("cerdas", "Kecerdasan", "Fisika susut teknis, aturan, model NTL, what-if, dan graf pengetahuan"),
    ("aplikasi", "Aplikasi & keputusan", "Tempat tim susut, P2TL dan operasi jaringan bekerja dan memutuskan"),
]

# (id, layer, title, plain explanation, platform application)
BLOCKS = [
    ("src_scada", "sumber", "NUSAGRID SCADA", "Model aset GI/penyulang/peralatan, titik ukur, kWh & daya penyulang harian, SOE trip PMT/recloser.", "Sistem OT"),
    ("src_meter", "sumber", "AMR / AMI", "kVA gardu harian (AMR), konsumsi & event meter pelanggan (AMI), tiga fasa pelanggan TM.", "Sistem OT · meter"),
    ("src_ap2t", "sumber", "AP2T", "Data teknis pelanggan, tarif, tagihan bulanan Apr–Sep.", "Sistem IT"),
    ("src_p2tl", "sumber", "Hasil P2TL", "Berita acara pemeriksaan: dasar pemilihan, golongan pelanggaran, tagihan susulan.", "Sistem IT"),
    ("src_ami", "sumber", "Meter AMI pilot (MQTT)", "Meter pintar TR dan AMR TM (fiktif) mengirim bacaan 15 menit, topik Sparkplug B, langsung saat terjadi.",
     "Sistem OT · MQTT"),
    ("src_gis", "sumber", "GIS & OpenStreetMap", "Wilayah layanan, penyulang, gardu distribusi; transmisi Jawa Barat nyata dari OSM.", "GIS · OSM (ODbL)"),
    ("store_raw", "simpan", "Files · raw/", "Berkas mentah apa adanya per sumber; berkas SCADA bertanda CEII, identitas pelanggan PII.", "Files & Projects"),
    ("store_stream", "simpan", "MQTT Broker & ingest stream", "Broker platform menerima pesan meter; streaming sync menulisnya ke ingest stream yang diarsip.",
     "MQTT Broker · Streaming"),
    ("store_ts", "simpan", "Time Series", "Beban per jam penyulang (SCADA), gardu (AMR) dan pelanggan TM sebagai seri.", "Time Series Catalog"),
    ("pipe_aset", "olah", "Pipeline aset & topologi", "GI → penyulang → gardu → pelanggan, titik ukur, konektivitas, transmisi OSM.", "Pipeline Builder"),
    ("pipe_susut", "olah", "Pipeline neraca & susut", "Neraca energi, susut teknis fisika, residu NTL, 20 aturan, temuan bernilai.", "Pipeline Builder"),
    ("pipe_iot", "olah", "Pipeline beban per jam", "Seri beban, status beban gardu per jam (changelog), puncak harian.", "Pipeline Builder"),
    ("pipe_stream", "olah", "Pipeline AMI streaming", "Job streaming: validasi bacaan, seri kW per meter, peristiwa meter dan arus fasa timpang.",
     "Pipeline Builder (streaming)"),
    ("pipe_ntl", "olah", "Pipeline NTL per jam", "Streaming: agregasi per jam per meter, fitur per jam (adaptor atas model siklus tagihan), skor lewat fungsi model live deployment.",
     "Pipeline Builder (streaming) · Models"),
    ("pipe_sensor", "olah", "Pipeline sensor gardu", "Streaming: meter trafo per fasa + suhu minyak (IEC 60076-7 sederhana) menjadi seri kVA gardu dan stream bersih.",
     "Pipeline Builder (streaming)"),
    ("pipe_ml", "olah", "Pelatihan & skor NTL", "Fitur pelanggan + label P2TL → model; skor lewat live deployment di pipeline.", "Code Repositories · Pipeline Builder"),
    ("pipe_pseudo", "olah", "Pseudonimisasi (Cipher)", "Identitas pelanggan dienkripsi/di-hash; penanda PII tidak diturunkan.", "Code Repositories · Cipher"),
    ("pipe_akses", "olah", "Pipeline akses per ULP", "Dataset per ULP di balik restricted view untuk tim P2TL tiap ULP.", "Pipeline Builder · Restricted views"),
    ("store_clean", "bersih", "susut/ · ml/ · iot/ · akses/", "Dataset bersih yang mendukung objek, model dan aplikasi, diawasi Data Health.", "Datasets · Data Health"),
    ("nexus_objects", "nexus", "Objek & relasi jaringan", "GI, penyulang, gardu, pelanggan, neraca, temuan, inspeksi, gangguan, transmisi — saling terhubung.", "Nexus Manager"),
    ("nexus_actions", "nexus", "Action & function", "Status temuan, target P2TL, perintah kerja, jadwal kunjungan; alasan susut dan simulasi (function).", "Actions · Functions"),
    ("nexus_machinery", "nexus", "Device and Machinery", "Status beban gardu sebagai proses dan alur temuan susut.", "Device and Machinery"),
    ("intel_fisika", "cerdas", "Susut teknis (fisika)", "I²R JTR dengan ketidakseimbangan, rugi besi & tembaga trafo, rugi saluran TM.", "Pipeline Builder"),
    ("intel_rules", "cerdas", "Aturan & Foundry Rules", "13 aturan pelanggan + 7 aturan jaringan; aturan analis tanpa kode lewat proposal.", "Pipeline Builder · Foundry Rules"),
    ("intel_ml", "cerdas", "Model NTL", "Isolation Forest + gradient boosting; prioritas = skor × potensi Rp per bulan.", "Models · Live deployment"),
    ("intel_deteksi", "cerdas", "Deteksi bypass per jam", "CUSUM penurunan mendadak + event tamper + arus fasa timpang + skor per jam → Peristiwa AMI di Nexus, Object Monitor, notifikasi ULP.",
     "Object Monitors · Notifikasi"),
    ("intel_sensor", "cerdas", "TL & risiko overload sensor", "TL per jam dari sensor gardu (trafo + I²R JTR), hotspot & laju penuaan → rekomendasi L2 sebagai Perintah Kerja usulan (tanpa kendali SCADA).",
     "Nexus Actions · Device and Machinery"),
    ("intel_feedback", "cerdas", "Feedback P2TL → label v2", "Hasil pemeriksaan menjadi label latih berversi; retrain mingguan tercatat (experiment + AUROC kunci); hit-rate per ULP/basis tanpa PII.",
     "Pipeline Builder · Code Repositories · Models"),
    ("intel_scenario", "cerdas", "Skenario what-if", "Penyeimbangan beban, uprating trafo, rekonduktor JTR — dibanding data utama.", "Nexus Scenarios"),
    ("intel_orbis", "cerdas", "Bluesand Orbis — Grid", "Graf pengetahuan seluruh demo + indeks vector orbis-grid-1 untuk tanya-jawab.", "Bluesand Orbis"),
    ("app_overview", "aplikasi", "Ringkasan susut & akses", "KPI per ULP, penyulang, temuan bernilai, strategi ML, matriks akses per akun.", "Halaman demo"),
    ("app_workshop", "aplikasi", "Kokpit & portal Workshop", "Temuan berprioritas nilai, penjelasan, keputusan; portal per ULP lewat restricted view.", "Workshop"),
    ("app_map", "aplikasi", "Peta, Vertex & analitik", "Peta transmisi Jabar + susut; topologi di Vertex; Quiver beban; Contour susut & P2TL.", "Map · Vertex · Quiver · Contour"),
    ("app_ops", "aplikasi", "Jadwal P2TL & monitor", "Kunjungan per tim, object monitor, notifikasi eskalasi.", "Dynamic Scheduling · Object Monitors · Automate"),
    ("app_orbis", "aplikasi", "Tanya Orbis", "Pertanyaan bahasa alami dijawab dari graf, dengan rujukan simpulnya.", "Bluesand Orbis"),
]

FLOWS = [
    ("keandalan", "Telemetri → keandalan", "#38bdf8",
     ["src_scada", "store_raw", "pipe_aset", "pipe_susut", "store_clean", "nexus_objects", "app_overview", "app_map"],
     "Trip PMT/recloser dari SOE SCADA menjadi gangguan penyulang, lalu SAIDI/SAIFI per penyulang di samping susutnya."),
    ("neraca", "kWh → neraca energi", "#22c55e",
     ["src_scada", "src_meter", "src_ap2t", "store_raw", "pipe_susut", "intel_fisika", "store_clean", "nexus_objects", "app_overview", "app_workshop"],
     "kWh kirim penyulang (SCADA) dan keluaran trafo (AMR) dikurangi kWh tagihan; fisika memisahkan susut teknis, residunya NTL."),
    ("p2tl", "Meter → target P2TL → label", "#ef4444",
     ["src_meter", "src_ap2t", "src_p2tl", "store_raw", "pipe_susut", "intel_rules", "pipe_ml", "intel_ml", "nexus_objects", "nexus_actions", "app_ops", "src_p2tl"],
     "Fitur meter dan tagihan dinilai aturan dan model NTL, diprioritaskan menurut nilai, dijadwalkan ke tim P2TL; hasil pemeriksaan kembali menjadi label."),
    ("perintah", "Beban trafo → perintah kerja", "#f59e0b",
     ["src_meter", "store_ts", "pipe_iot", "nexus_machinery", "intel_fisika", "intel_scenario", "nexus_actions", "app_workshop"],
     "Beban per jam gardu memperlihatkan overload dan fasa tak seimbang; skenario what-if menimbang perbaikan sebelum perintah kerja dibuat."),
    ("identitas", "Identitas → pseudonim", "#a855f7",
     ["src_ap2t", "store_raw", "pipe_pseudo", "pipe_akses", "store_clean", "app_workshop"],
     "Identitas pelanggan ditandai PII saat mendarat, dipseudonimkan dengan Cipher; tim P2TL hanya melihat baris ULP-nya lewat restricted view."),
    ("ot_it", "OT → IT satu arah", "#64748b",
     ["src_scada", "src_meter", "store_raw", "store_ts", "store_clean"],
     "Data OT disalin keluar lewat zona antara ke penyimpanan IT; tidak ada jalur balik ke SCADA — keputusan kembali sebagai perintah kerja, bukan kendali."),
    ("ami", "AMI → time series (streaming)", "#14b8a6",
     ["src_ami", "store_stream", "pipe_stream", "store_ts", "nexus_objects", "app_overview"],
     "Bacaan 15 menit meter pilot lewat MQTT, streaming sync dan pipeline streaming menjadi seri kW per meter di objek Meter AMI dalam hitungan detik."),
    ("ntl_jam", "NTL per jam → dugaan bypass", "#dc2626",
     ["src_ami", "store_stream", "pipe_ntl", "intel_ml", "intel_deteksi", "nexus_objects", "app_ops", "app_overview"],
     "Agregasi per jam dinilai model NTL (adaptor per jam) dan CUSUM; bypass, magnet atau shunt CT menjadi Peristiwa AMI di Nexus dalam hitungan jam, diteruskan Object Monitor ke tim ULP."),
    ("sensor_tl", "Sensor gardu → TL & overload", "#d97706",
     ["src_ami", "store_stream", "pipe_sensor", "intel_sensor", "intel_fisika", "nexus_actions", "app_workshop"],
     "Beban per fasa dan suhu minyak gardu menjadi TL per jam dan risiko overload/penuaan mendekati real-time; usulan penyeimbangan/uprating masuk sebagai Perintah Kerja (rekomendasi L2, operator memutuskan)."),
    ("feedback", "Hasil P2TL → label → retrain", "#805ad5",
     ["src_ap2t", "pipe_susut", "intel_feedback", "intel_ml", "nexus_objects", "app_overview"],
     "Setiap hasil pemeriksaan (terbukti/bersih) menjadi label versi berikutnya; model dilatih ulang terjadwal dan experiment-nya tercatat, sementara hit-rate per ULP/basis mengawasi mutu pemilihan target."),
]

CROSS = [
    ("lineage", "Lineage, jadwal & Data Health", "Setiap dataset, pipeline, objek dan aplikasi terhubung di Data Lineage; build berantai saat data sumber berubah, "
                                                 "Data Health memeriksa jumlah baris, kolom, status build dan kesegaran.", "/lineage?graph=gridsusut"),
    ("governance", "Keamanan & tata kelola", "Penanda PII, CEII dan investigasi, pemindai data sensitif, Cipher, kebijakan objek per ULP, restricted view, "
                                             "checkpoint ekspor, retensi dan log audit.", "/lineage?graph=gridakses"),
]


def _safe(fn: Callable[[], Any], default: Any = None) -> Any:
    try:
        return fn()
    except Exception:  # noqa: BLE001 - one missing metric never breaks the page
        log.exception("grid arsitektur metric failed")
        return default


def _num(v: Any) -> str:
    try:
        return f"{int(v):,}".replace(",", ".")
    except (TypeError, ValueError):
        return str(v)


def _collect() -> dict[str, dict]:
    import db
    import ontology
    import pipeline_runtime as rt

    import demo_grid_e2e as e

    st = e.STATE
    out: dict[str, dict] = {b[0]: {"metrics": [], "links": []} for b in BLOCKS}

    def m(block: str, label: str, value: Any) -> None:
        if value not in (None, ""):
            out[block]["metrics"].append([label, value if isinstance(value, str) else _num(value)])

    def link(block: str, label: str, href: Optional[str]) -> None:
        if href:
            out[block]["links"].append([label, href])

    rows = st.get("rows") or {}
    folders = st.get("folders") or {}
    m("src_scada", "titik ukur", rows.get("scada_titik_ukur_nusagrid"))
    m("src_scada", "peralatan", rows.get("scada_peralatan_nusagrid"))
    m("src_scada", "gangguan SOE", rows.get("scada_gangguan_soe"))
    m("src_meter", "baris AMI harian", rows.get("ami_konsumsi_harian"))
    m("src_meter", "event meter", rows.get("ami_event_meter"))
    m("src_ap2t", "pelanggan", rows.get("ap2t_pelanggan_teknis"))
    m("src_ap2t", "bulan tagihan", sum(1 for k in rows if k.startswith("ap2t_tagihan_")))
    m("src_p2tl", "pemeriksaan", rows.get("p2tl_hasil_pemeriksaan"))
    m("src_gis", "gardu distribusi", rows.get("gis_gardu_distribusi"))
    m("src_gis", "elemen transmisi OSM", rows.get("osm_jaringan_transmisi_jabar"))
    raw = _safe(lambda: [f for f in __import__("drive").list_files(folders["raw"]) if not f.get("trashed_at")], []) or []
    m("store_raw", "berkas mentah", len(raw))
    m("store_raw", "ukuran", f"{sum(int(it.get('size_bytes') or 0) for it in raw) / 1e6:.1f}".replace(".", ",") + " MB" if raw else None)
    link("store_raw", "Buka folder raw", folders.get("raw") and f"/files?folder={folders['raw']}")
    syncs = st.get("iot_syncs") or {}
    m("store_ts", "sync deret waktu", len(syncs))
    link("store_ts", "Beban gardu", syncs.get("gardu") and f"/time-series/{syncs['gardu']}")
    ami = st.get("ami") or {}
    amis = _safe(lambda: __import__("demo_grid_ami").overview_numbers(), {}) or {}
    m("src_ami", "meter pilot", amis.get("meters"))
    m("src_ami", "bacaan terkirim", amis.get("published"))
    m("store_stream", "record stream", amis.get("stream_records"))
    m("store_stream", "sync", amis.get("sync_status"))
    link("store_stream", "MQTT Broker", "/mqtt-broker")
    link("store_stream", "Ingest stream", ami.get("stream_id") and f"/streaming/streams/{ami['stream_id']}")
    m("store_ts", "titik AMI kW", amis.get("points"))
    link("store_ts", "Beban AMI 15 menit", ami.get("ts_sync_id") and f"/time-series/{ami['ts_sync_id']}")


    def pipe(block: str, label: str, pid: Optional[str], metric: str = "build terakhir") -> None:
        if not pid:
            return
        b = _safe(lambda: (rt.list_builds(pid, 1) or [None])[0])
        name = _safe(lambda: db.drive_get(pid)["name"].removesuffix(".pipeline"), label)
        m(block, metric, (b or {}).get("status") or "—")
        link(block, name, f"/pipeline/{pid}")

    pipes = st.get("pipelines") or {}
    pipe("pipe_aset", "Pipeline aset", (pipes.get("aset") or {}).get("id"))
    pipe("pipe_susut", "Pipeline susut", (pipes.get("susut") or {}).get("id"))
    pipe("pipe_iot", "Pipeline beban per jam", st.get("iot_pipeline_id"))
    pipe("pipe_ml", "Pipeline skor NTL", st.get("scoring_pipeline_id"))
    pipe("pipe_stream", "Pipeline AMI streaming", (st.get("ami") or {}).get("pipeline_id"), "job")
    ntl = _safe(lambda: __import__("demo_grid_ntl_stream").overview_numbers(), {}) or {}
    pipe("pipe_ntl", "Pipeline NTL per jam", ntl.get("pipeline_id"), "job")
    m("intel_deteksi", "peristiwa dugaan bypass", ntl.get("peristiwa"))
    m("intel_deteksi", "false positive terakhir", ntl.get("false_positive"))
    lat = ntl.get("latensi") or []
    done = [x["latensi_jam"] for x in lat if x.get("latensi_jam") is not None]
    m("intel_deteksi", "latensi terburuk (jam data)", max(done) if done else None)
    link("intel_deteksi", "Object Monitors", "/object-monitors")
    sen = _safe(lambda: __import__("demo_grid_sensor_gardu").overview_numbers(), {}) or {}
    pipe("pipe_sensor", "Pipeline sensor gardu", sen.get("pipeline_id"), "job")
    m("intel_sensor", "gardu tersensor", sen.get("gardu"))
    m("intel_sensor", "TL jam terakhir (kWh)", sen.get("tl_kwh"))
    m("intel_sensor", "gardu berisiko", sen.get("risiko"))
    link("intel_sensor", "Sensor gardu di /demo-grid", "/demo-grid")
    fb = _safe(lambda: __import__("demo_grid_feedback").overview_numbers(), {}) or {}
    pipe("intel_feedback", "Pipeline label P2TL (demo)", fb.get("pipeline_id"))
    m("intel_feedback", "versi dataset label", fb.get("label_versi"))
    m("intel_feedback", "hit-rate keseluruhan", fb.get("hit_rate"))
    link("intel_feedback", "Feedback di /demo-grid", "/demo-grid")
    pipe("pipe_akses", "Pipeline akses per ULP", (st.get("akses") or {}).get("pipeline_id"))
    m("pipe_aset", "pelanggan", rows.get("pelanggan"))
    m("pipe_susut", "temuan", rows.get("temuan_susut"))
    m("pipe_susut", "neraca gardu-bulan", rows.get("neraca_gardu_bulanan"))
    import code_repos

    repos = {r["name"]: r["id"] for r in _safe(code_repos.list_repos, []) or []}
    for block, name in (("pipe_ml", "Deteksi Susut NTL Grid demo"), ("pipe_pseudo", "Pseudonimisasi pelanggan grid demo"),
                        ("nexus_actions", e.FUNCTIONS_REPO)):
        link(block, f"Repositori {name}", repos.get(name) and f"/code-repositories/{repos[name]}")
    m("pipe_pseudo", "build pseudonim", "ya" if st.get("gov_pseudo_built") else None)
    m("pipe_akses", "restricted view", len((st.get("akses") or {}).get("views") or {}))
    clean = {k: _safe(lambda k=k: sum(1 for f in __import__("drive").list_files(folders[k]) if f["name"].endswith(".parquet") and not f.get("trashed_at")), 0)
             for k in ("susut", "ml") if folders.get(k)}
    m("store_clean", "dataset susut/", clean.get("susut"))
    m("store_clean", "dataset ml/", clean.get("ml"))
    link("store_clean", "Data Health", "/data-health")

    types = {k: t for k in list(e.T) if (t := _safe(lambda k=k: e._type(k)))}
    m("nexus_objects", "tipe objek", len(types))
    m("nexus_objects", "objek", _safe(lambda: sum(len(ontology.stored_objects(t["id"])) for t in types.values())))
    tids = {t["id"] for t in types.values()}
    import ontology_model as om

    m("nexus_objects", "tipe relasi", _safe(lambda: sum(1 for lt in om._all("link-types") if lt["source"]["object_type_id"] in tids and lt["target"]["object_type_id"] in tids)))
    gd = types.get("gardu")
    link("nexus_objects", "Gardu Distribusi di Nexus", gd and f"/ontology/{gd['id']}")
    acts = _safe(lambda: [a for a in ontology._all("action-types") if a.get("object_type_id") in tids], []) or []
    m("nexus_actions", "action", len(acts))
    import functions_registry as fr

    m("nexus_actions", "function", _safe(lambda: sum(1 for f in fr.all_functions() if f.get("repo_id") == st.get("functions_repo_id"))))
    m("nexus_actions", "keputusan tercatat", _safe(lambda: sum(len(__import__("ontology_edits").layer(t)) for t in tids)))
    import machinery

    mach = [x for x in _safe(machinery._all, []) or [] if "grid" in (x.get("name") or "").lower()]
    m("nexus_machinery", "proses", sum(len(x.get("processes") or []) or 1 for x in mach) if mach else None)
    link("nexus_machinery", "Device and Machinery", mach and f"/machinery?id={mach[0]['id']}")

    over = _safe(e.overview, {}) or {}
    ulp = over.get("ulp") or []
    if ulp:
        kirim = sum(u.get("mwh_kirim") or 0 for u in ulp)
        if kirim:
            m("intel_fisika", "susut teknis", f"{sum((u.get('tl_pct') or 0) * (u.get('mwh_kirim') or 0) for u in ulp) / kirim:.2f}".replace(".", ",") + "%")
            m("intel_fisika", "susut non-teknis", f"{sum((u.get('ntl_pct') or 0) * (u.get('mwh_kirim') or 0) for u in ulp) / kirim:.2f}".replace(".", ",") + "%")
    m("intel_rules", "aturan skrining", 20)
    an = st.get("analitik") or {}
    import foundry_rules as frr

    wf = _safe(lambda: next((w for w in frr.list_workflows() if w["name"].startswith("Aturan susut grid")), None))
    m("intel_rules", "aturan Foundry Rules", (wf or {}).get("active_rules"))
    link("intel_rules", "Foundry Rules", wf and "/foundry-rules")
    exp = st.get("ml_experiment") or {}
    met = exp.get("metrics") or {}

    def last(k: str) -> Optional[float]:
        v = met.get(k)
        return (v[-1].get("value") if isinstance(v, list) and v else v) if v is not None else None

    a = last("auroc/kunci_gabungan")
    m("intel_ml", "AUROC kunci", f"{a:.3f}".replace(".", ",") if a is not None else None)
    rp = last("rp_per_inspeksi_k40/nilai") or last("rp_per_inspeksi@40/nilai")
    rr = last("rp_per_inspeksi_k40/aturan") or last("rp_per_inspeksi@40/aturan")
    m("intel_ml", "Rp/inspeksi (nilai)", f"{rp / 1e6:.1f}".replace(".", ",") + " jt" if rp else None)
    m("intel_ml", "Rp/inspeksi (aturan)", f"{rr / 1e6:.1f}".replace(".", ",") + " jt" if rr else None)
    link("intel_ml", "Eksperimen", "/models")
    m("intel_scenario", "skenario", len(an.get("scenarios") or {}) or None)
    link("intel_scenario", "Nexus Scenarios", "/ontology/scenarios")
    import orbis_grid as og

    g = _safe(lambda: _orbis_graph(og), {}) or {}
    m("intel_orbis", "simpul", (g.get("stats") or {}).get("nodes"))
    m("intel_orbis", "relasi", (g.get("stats") or {}).get("links"))
    m("intel_orbis", "vector orbis-grid-1", _safe(lambda: len(__import__("orbis")._read(og.DIR / "vectors.json", {}))))
    link("intel_orbis", "Bluesand Orbis — Grid", "/orbis/grid")
    link("app_overview", "Ringkasan /demo-grid", "/demo-grid")
    m("app_overview", "ULP", len(ulp) or None)
    m("app_overview", "akun demo", len((st.get("akses") or {}).get("users") or {}) or None)
    link("app_workshop", "Kokpit Workshop", st.get("workshop_id") and f"/workshop/{st['workshop_id']}")
    link("app_workshop", "Portal per ULP", (st.get("akses") or {}).get("workshop_id") and f"/workshop/{st['akses']['workshop_id']}")
    link("app_map", "Peta susut Jabar", st.get("map_id") and f"/map/{st['map_id']}")
    q = an.get("quiver") or {}
    link("app_map", "Quiver beban gardu", q.get("gardu") and f"/quiver/{q['gardu']}")
    link("app_map", "Contour susut & P2TL", an.get("contour") and f"/analytics/{an['contour']}")
    link("app_ops", "Dynamic Scheduling", "/dynamic-scheduling")
    link("app_ops", "Object Monitors", "/object-monitors")
    link("app_orbis", "Tanya Orbis", "/orbis/grid")
    return out


def _orbis_graph(og: Any) -> dict:  # the cached graph, without building it here
    import orbis

    p = og.DIR / "graph.json"
    return orbis._read(p, {}) if p.exists() else {}


@router.get("")
def architecture() -> dict:
    me = auth.require_user()
    # some numbers depend on what the caller may see (the overview's ULP figures): cached per user
    hit = _cache.get(me.get("id") or "")
    if not hit or time.time() - hit[0] > 60:
        hit = _cache[me.get("id") or ""] = (time.time(), _collect())
    live = hit[1]
    edges: set[tuple[str, str]] = set()
    for _, _, _, path, _ in FLOWS:
        for a, b in zip(path, path[1:]):
            if a != b:
                edges.add((a, b))
    return {
        "project": PROJECT,
        "layers": [{"key": k, "title": t, "desc": d} for k, t, d in LAYERS],
        "blocks": [{"id": i, "layer": la, "title": t, "plain": p, "tech": tech, **live.get(i, {"metrics": [], "links": []})} for i, la, t, p, tech in BLOCKS],
        "flows": [{"id": i, "title": t, "color": c, "path": path, "story": s} for i, t, c, path, s in FLOWS],
        "edges": sorted([{"from": a, "to": b} for a, b in edges], key=lambda x: (x["from"], x["to"])),
        "cross": [{"id": i, "title": t, "desc": d, "href": h} for i, t, d, h in CROSS],
    }
