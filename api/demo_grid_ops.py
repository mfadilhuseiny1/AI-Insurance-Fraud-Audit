"""Demo Grid: operations on the Nexus — alerts, automation and field scheduling (called by demo_grid_e2e.build).

- Object Monitors: new P1 findings, transformers turning "Susut NTL tinggi", and the total expected value of open
  findings crossing a threshold — each notifying the loss team.
- Automate: when a finding is escalated, the UP3 manager is notified (per object, with the finding in the message).
- Dynamic Scheduling: the P2TL field visits ("Grid P2TL Field Visit (demo)", one per targeted finding) on a board per
  field team ("Grid Field Crew (demo)") — working hours 08–16, no overlaps, at most four visits a day, TM customers
  only to the TM-certified team — saved through an action, so every move is an audited decision.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

TIM = ("Grid Field Crew (demo)", "TimLapanganGridDemo")
KUNJUNGAN = ("Grid P2TL Field Visit (demo)", "KunjunganP2tlGridDemo")
ACT_JADWAL = "Jadwalkan kunjungan P2TL (demo)"
BOARD = "Demo: Jadwal kunjungan P2TL grid"
WIB = timezone(timedelta(hours=7))
TEAMS = [("TIM-KTU-1", "Tim P2TL ULP Demo Cikarang Utara 1", "ULP-KTU", "TR"), ("TIM-KTU-2", "Tim P2TL ULP Demo Cikarang Utara 2", "ULP-KTU", "TR"),
         ("TIM-KTS-1", "Tim P2TL ULP Demo Cikarang Selatan", "ULP-KTS", "TR"), ("TIM-UP3-TM", "Tim P2TL UP3 Demo (pelanggan TM)", "UP3-DMO", "TM")]


def _type(name: str) -> Optional[dict]:
    import ontology

    return next((t for t in ontology._all("object-types") if t["display_name"] == name), None)


def _types() -> dict:
    import ontology

    import demo_grid_e2e as e

    P = lambda a, n, t="string", **kw: ontology.Property(api_name=a, display_name=n, type=t, **kw)  # noqa: E731
    made = []
    tim = _type(TIM[0])
    if not tim:
        tim = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=TIM[0], plural_name=TIM[0], api_name=TIM[1], primary_key="kode_tim", title_property="nama", icon="users", color="#0ea5e9",
            description="Demo: tim lapangan P2TL per ULP (dan tim TM UP3) — sumber daya papan jadwal kunjungan.",
            properties=[P("kode_tim", "Kode tim", render_hints=["identifier", "searchable"]), P("nama", "Nama tim", render_hints=["searchable"]),
                        P("kode_ulp", "ULP", render_hints=["selectable"]), P("keahlian", "Keahlian (TR/TM)", render_hints=["selectable"]),
                        P("anggota", "Anggota"), P("kendaraan", "Kendaraan")]))
        made.append(TIM[0])
    kj = _type(KUNJUNGAN[0])
    if not kj:
        kj = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=KUNJUNGAN[0], plural_name=KUNJUNGAN[0], api_name=KUNJUNGAN[1], primary_key="id_kunjungan", title_property="judul", icon="calendar",
            color="#f59e0b", description="Demo: kunjungan P2TL terjadwal untuk temuan yang dijadikan target — tim, mulai, selesai; dipindah di papan Dynamic Scheduling.",
            properties=[P("id_kunjungan", "ID kunjungan", render_hints=["identifier", "searchable"]), P("judul", "Judul", render_hints=["searchable"]),
                        P("id_temuan", "Temuan"), P("id_pelanggan", "Pelanggan"), P("kode_dt", "Gardu distribusi"), P("kode_ulp", "ULP", render_hints=["selectable"]),
                        P("tegangan", "Tegangan (TR/TM)", render_hints=["selectable"]), P("pola_dugaan", "Pola dugaan", render_hints=["selectable"]),
                        P("prioritas", "Prioritas", render_hints=["selectable"]), P("nilai_harapan_rp", "Nilai harapan (Rp)", "double"),
                        P("kode_tim", "Tim"), P("mulai", "Mulai", "timestamp"), P("selesai", "Selesai", "timestamp"),
                        P("durasi_jam", "Durasi (jam)", "double"), P("status_kunjungan", "Status", render_hints=["selectable"])]))
        made.append(KUNJUNGAN[0])
    import ontology_model as om

    for name, src, fk, tgt, s_lbl, t_lbl in (("Field visit by crew (grid demo)", kj, "kode_tim", tim, "Kunjungan", "Tim"),
                                             ("Field visit for loss finding (grid demo)", kj, "id_temuan", e._type("temuan"), "Kunjungan P2TL", "Temuan"),
                                             ("Field visit to customer (grid demo)", kj, "id_pelanggan", e._type("pelanggan"), "Kunjungan P2TL", "Pelanggan")):
        if not any(x.get("display_name") == name for x in ontology._all("link-types")):
            om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key=fk,
                                              source=om.LinkSide(object_type_id=src["id"], display_name=s_lbl, plural_display_name=s_lbl),
                                              target=om.LinkSide(object_type_id=tgt["id"], display_name=t_lbl)))
            made.append(name)
    return {"tim": tim, "kunjungan": kj, "made": made}


def _seed(t: dict) -> int:
    """The teams, and a visit for each P1/P2 customer finding (the two weeks from 19 Oct 2026), assigned by ULP and voltage."""
    import ontology

    import demo_grid_pipeline as gp

    edits = []
    have_t = ontology.stored_objects(t["tim"]["id"])
    for code, name, ulp, skill in TEAMS:
        if code not in have_t:
            edits.append({"op": "create", "object_type_id": t["tim"]["id"], "primary_key": code,
                          "properties": {"kode_tim": code, "nama": name, "kode_ulp": ulp, "keahlian": skill, "anggota": "3 petugas + 1 pengawas (contoh)",
                                         "kendaraan": "Mobil P2TL"}})
    have_k = ontology.stored_objects(t["kunjungan"]["id"])
    finds = [r for r in gp.outputs("susut")["temuan_susut"] if r["jenis_objek"] == "Pelanggan" and r["prioritas"] in ("P1", "P2")
             and r["kelompok_susut"] == "Non-teknis (NTL)"]
    finds.sort(key=lambda r: -r["nilai_harapan_rp"])
    slot: dict[str, datetime] = {code: datetime(2026, 10, 19, 8, tzinfo=WIB) for code, *_ in TEAMS}
    for i, r in enumerate(finds[:36]):
        if r["tegangan"] == "TM":
            team = "TIM-UP3-TM"
        elif r["kode_ulp"] == "ULP-KTS":
            team = "TIM-KTS-1"
        else:
            team = "TIM-KTU-1" if i % 2 else "TIM-KTU-2"
        hours = 4.0 if r["tegangan"] == "TM" else 2.0
        start = slot[team]
        if start.hour + hours > 16:
            start = (start + timedelta(days=1)).replace(hour=8)
        while start.weekday() >= 5:
            start = (start + timedelta(days=1)).replace(hour=8)
        end = start + timedelta(hours=hours)
        slot[team] = end
        pk = f"KJ-{r['id_temuan']}"
        if pk in have_k:
            continue
        edits.append({"op": "create", "object_type_id": t["kunjungan"]["id"], "primary_key": pk, "properties": {
            "id_kunjungan": pk, "judul": f"{r['kode_pola_dugaan']} · {r['kode_objek']} · {r['prioritas']}", "id_temuan": r["id_temuan"],
            "id_pelanggan": r["kode_objek"], "kode_dt": r["kode_dt"], "kode_ulp": r["kode_ulp"], "tegangan": r["tegangan"],
            "pola_dugaan": r["kode_pola_dugaan"], "prioritas": r["prioritas"], "nilai_harapan_rp": float(r["nilai_harapan_rp"]), "kode_tim": team,
            "mulai": start.isoformat(), "selesai": end.isoformat(), "durasi_jam": hours, "status_kunjungan": "Terjadwal"}})
    if edits:
        ontology.apply_edits(edits, source="demo-grid-ops")
    return len(edits)


def _board(t: dict) -> Optional[str]:
    import dynamic_scheduling as ds
    import ontology

    if any(b.get("name") == BOARD for b in ds.list_boards()):
        return None
    act = next((a for a in ontology._all("action-types") if a["display_name"] == ACT_JADWAL), None)
    if not act:
        props = {p["api_name"]: p for p in ontology._object_type(t["kunjungan"]["id"])["properties"]}
        act = ontology.create_action_type(ontology.ActionTypeIn(
            display_name=ACT_JADWAL, object_type_id=t["kunjungan"]["id"], kind="modify", status="active",
            description="Pindahkan kunjungan P2TL ke tim dan waktu lain (dari papan jadwal); tercatat di riwayat edit.",
            parameters=[ontology.Parameter(id="object", display_name="Kunjungan", type="object", required=True)]
            + [ontology.Parameter(id=p, display_name=props[p]["display_name"], type=props[p]["type"], property=p, required=p != "status_kunjungan")
               for p in ("kode_tim", "mulai", "selesai", "status_kunjungan")]))
    b = ds.create_board(ds.BoardIn(
        name=BOARD, description="Demo: kunjungan P2TL per tim lapangan, dua minggu mulai 19 Okt 2026. Aturan: jam kerja 08–16, tidak tumpang tindih, maks 4 "
                                "kunjungan/hari, pelanggan TM hanya oleh tim bersertifikat TM. Geser kartu → action tersimpan.",
        schedule_object_type_id=t["kunjungan"]["id"], resource_object_type_id=t["tim"]["id"], resource_property="kode_tim",
        start_property="mulai", end_property="selesai", fixed_duration_property=None, label_property="judul", color_property="prioritas",
        save_action_id=act["id"], timeline_start="2026-10-19T00:00:00+07:00", timeline_end="2026-11-01T00:00:00+07:00", snap_minutes=30,
        rules=[ds.Rule(name="Tidak tumpang tindih", constraint="HARD", kind="no_overlap"),
               ds.Rule(name="Jam kerja 08–16", constraint="HARD", kind="within_hours", start_hour=8, end_hour=16),
               ds.Rule(name="Maks 4 kunjungan per hari", constraint="SOFT", kind="max_per_day", max=4),
               ds.Rule(name="Keahlian tim sesuai tegangan pelanggan", constraint="HARD", kind="property_match", schedule_property="tegangan",
                       resource_property="keahlian")],
        row_properties=["kode_ulp", "keahlian"]))
    return b["id"]


def _monitors() -> list[str]:
    import auth
    import object_monitors as om
    import ontology

    import demo_grid_e2e as e

    uid = (auth.current() or {}).get("id") or "local"
    have = {m["name"] for m in ontology._all("object-monitors")}
    tm, gd = e._type("temuan"), e._type("gardu")
    made = []
    specs = [
        ("Temuan susut P1 baru (grid demo)", "Temuan bernilai harapan ≥ Rp 50 juta muncul (aturan atau model).",
         {"object_type_id": tm["id"], "filters": [{"property": "prioritas", "op": "eq", "value": "P1"}]}, om.Condition(kind="objects_added")),
        ("Gardu distribusi NTL tinggi (grid demo)", "Gardu distribusi masuk status 'Susut NTL tinggi' (NTL > 8% bulan berjalan).",
         {"object_type_id": gd["id"], "filters": [{"property": "status_gardu", "op": "eq", "value": "Susut NTL tinggi"}]}, om.Condition(kind="objects_added")),
        ("Nilai harapan temuan terbuka > Rp 3 miliar (grid demo)", "Jumlah nilai harapan temuan berstatus Baru melewati Rp 3 miliar.",
         {"object_type_id": tm["id"], "filters": [{"property": "status_temuan", "op": "eq", "value": "Baru"}]},
         om.Condition(kind="threshold", threshold=om.Threshold(metric=om.Metric(metric="sum", property="nilai_harapan_rp"), op="gt", value=3_000_000_000))),
    ]
    for name, desc, search, cond in specs:
        if name in have:
            continue
        try:
            om.create_monitor(om.MonitorIn(name=name, description=desc, search=search, condition=cond, subscribers=[om.Subscriber(user=uid)], every_minutes=60))
            made.append(name)
        except Exception as ex:  # noqa: BLE001
            made.append(f"{name}: {getattr(ex, 'detail', ex)}")
    return made


def _automations() -> list[str]:
    import auth
    import ontology

    import demo_grid_e2e as e

    uid = (auth.current() or {}).get("id") or "local"
    name = "Notifikasi eskalasi temuan susut (grid demo)"
    if any(a.get("name") == name for a in ontology._all("automations")):
        return []
    tm = e._type("temuan")
    ontology.create_automation(ontology.AutomationIn(
        name=name, description="Saat tim susut mengeskalasi temuan (action 'Eskalasi temuan bernilai besar'), manajer UP3 menerima notifikasi per temuan.",
        condition={"kind": "objects_modified", "object_type_id": tm["id"], "filters": [{"property": "status_temuan", "op": "eq", "value": "Eskalasi"}],
                   "properties": ["status_temuan"]},
        effects=[{"kind": "notification", "subject": "Temuan susut dieskalasi: {{judul}}", "recipients": {"principals": [f"user:{uid}"]},
                  "body": "Temuan {{id_temuan}} ({{kode_pola_dugaan}}) dinaikkan ke P1. Nilai harapan Rp {{nilai_harapan_rp}}. Catatan: {{catatan_tindak_lanjut}}",
                  "grouping": "per_object"}]))
    return [name]


HEALTH = {  # folder → dataset → rules (Data Health: checked in the background, listed in Data Health and Data Lineage)
    "susut": {
        "neraca_gardu_bulanan": [{"kind": "row_count", "min": 600}, {"kind": "columns", "required": ["susut_pct", "susut_teknis_pct", "susut_non_teknis_pct"]},
                                 {"kind": "build_status"}, {"kind": "up_to_date"}],
        "neraca_penyulang_bulanan": [{"kind": "row_count", "min": 80}, {"kind": "build_status"}, {"kind": "up_to_date"}],
        "temuan_susut": [{"kind": "row_count", "min": 50, "max": 2000}, {"kind": "columns", "required": ["kode_pola_dugaan", "prioritas", "nilai_harapan_rp"]},
                         {"kind": "build_status"}],
        "pelanggan_status": [{"kind": "row_count", "min": 5000}, {"kind": "up_to_date"}],
    },
    "raw": {
        "scada_penyulang_harian": [{"kind": "time_since_updated", "hours": 48}],
        "amr_gardu_harian": [{"kind": "time_since_updated", "hours": 48}],
    },
}


def _health() -> list[str]:
    import drive
    import lineage

    import demo_grid_e2e as e

    project = e._folder(None, e.PROJECT, "project")
    rules = lineage._health_rules()
    done = []
    for folder, sets in HEALTH.items():
        fid = e._folder(project, folder)
        files = {f["name"]: f["id"] for f in drive.list_files(fid) if not f.get("trashed_at")}
        for name, rs in sets.items():
            iid = files.get(f"{name}.parquet")
            if not iid or rules.get(iid):
                continue
            lineage.save_health_rules(lineage.HealthRules(item_id=iid, rules=[dict(r) for r in rs]))
            done.append(name)
    return done


def build(state: dict, save) -> dict:
    out: dict[str, Any] = {}
    t = _types()
    out["made"] = t["made"]
    out["seeded"] = _seed(t)
    try:
        out["board"] = _board(t)
    except Exception as ex:  # noqa: BLE001
        out["board_error"] = str(getattr(ex, "detail", ex))[:400]
    out["monitors"] = _monitors()
    try:
        out["data_health"] = _health()
    except Exception as ex:  # noqa: BLE001
        out["data_health_error"] = str(getattr(ex, "detail", ex))[:400]
    try:
        out["automations"] = _automations()
    except Exception as ex:  # noqa: BLE001
        out["automation_error"] = str(getattr(ex, "detail", ex))[:400]
    return out
