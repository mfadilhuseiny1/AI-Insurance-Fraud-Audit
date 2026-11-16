"""Demo: the JKN facility risk audit on the Ontology (POST /api/demo/jkn/ontology).

Builds, from the same fictitious records as demo_jkn.py (no real patient, doctor or facility), an Ontology for BPJS
Kesehatan's "Efisiensi Risiko pada Fasilitas Kesehatan" problem and a demo for each Ontology app:

- object types "Faskes JKN (demo)" and "Klaim JKN (demo)" (one claim per SEP, with the planted risk category of
  the 20 subcategories where there is one) linked by "Klaim di faskes (demo)", and the action types
  "Ubah status verifikasi klaim (demo)" and "Koreksi tarif INA-CBG (demo)";
- Ontology search: SEP numbers, ICD-10 codes and INA-CBG codes are indexed for regex and leading wildcards (e.g.
  regex `.*-(II|III)` on the INA-CBG code, or derived properties "klaim berisiko per faskes");
- Ontology scenarios: "Demo: Tunda pembayaran klaim berisiko" (every flagged claim set to "ditunda") and "Demo:
  Koreksi upcoding ke severity I", with the merge action "Demo: Terapkan skenario verifikasi klaim";
- object edits: edit history is tracked on the claims and they are materialized (automatically, after every edit)
  to the Files dataset "Klaim JKN (demo) materialized"; one claim gets a demo verification edit on main;
- semantic search: the medical resumes are embedded (resumeEmbedding, the default embedding model) so claims can be
  found by meaning ("pasien sesak napas dirawat lama"); the vectors are patient data, so the PII policy covers them;
- Vertex: event object type "Peringatan Risiko JKN (demo)" (one alert per flagged claim, intent danger / warning
  by category), the graph "Demo: Klaim berisiko RSUD Contoh Sejahtera" and the template "Demo: Template investigasi
  faskes" (a facility → its flagged claims → their alerts);
- Machinery: the Files dataset "Log verifikasi klaim (demo)" (an e-Klaim style changelog: diajukan → dalam
  verifikasi → layak bayar / ditunda / ditolak, some through "perlu konfirmasi"), the claims' status set to their
  latest state, and the resource "Demo: Proses verifikasi klaim JKN" with its process log; the "perlu konfirmasi"
  loop is left out of the definition so process mining finds it;
- Foundry Rules: the workflow "Demo: Aturan skrining klaim JKN" (input Klaim JKN (demo), output alert objects in
  "Temuan Aturan JKN (demo)" linked to the claims, and the Files dataset "Temuan aturan JKN (demo)") with approved
  rules (prolonged LOS, RS tariff far above INA-CBG, readmission within 30 days, facilities with 5 or more flagged
  claims) and one open proposal waiting for review;
- Dynamic Scheduling: "Verifikator JKN (demo)" (resources) and "Jadwal Audit Klaim (demo)" (one audit per flagged
  claim; some scheduled, with one clash and one outside working hours; the rest unassigned) on the board
  "Demo: Jadwal audit klaim JKN" with hard and soft rules;
- Object Views: a configured view of Klaim JKN (demo) in two versions (claim summary, a "Detail risiko" tab shown
  only while the claim is not "layak bayar", facility, rule findings, alerts, timeline, edit history, comments), the
  object set panel aggregates, and a demo comment on the upcoding claim;
- Object Monitors (sunset): "Demo: Klaim baru bertarif di atas Rp 10 juta" (objects added, realtime) and
  "Demo: Total klaim ditunda di atas Rp 40 juta" (a threshold) on saved explorations;
- Vulcan: "Model 3D Ruang Rawat (demo)", a synthetic OBJ of a 6-bed class III ward (Files), with an annotation on
  the bed of a claim billed as class I (subcategory 13), a passing check, a measurement and a section plane;
- join table datasets: "Rujukan antar faskes (demo)", a many-to-many link between facilities backed by the referral
  records (Files dataset), for referral patterns such as self-referral;
- multi-datasource object types: "Tarif INA-CBG (demo)" also takes "Bobot kasus INA-CBG (demo)" (case weight and
  average length of stay per base code) as a second datasource;
- indexing: "Tarif INA-CBG (demo)" is backed by the Files dataset "Tarif INA-CBG (demo)" (Ontology folder), so
  its re-indexes run as Funnel-style pipelines with their run log;
- Ontology design: the validation drill "Validasi ontologi klaim JKN (demo)" — questions a verifier asks (the
  facility with the most flagged claims, prolonged stays, the excess over INA-CBG tariffs) with expected answers
  computed from the demo data, ready for a team race (path capture) or an AI agent run;
- object security: claims under investigation are visible only to the group jkn-tim-investigasi, and patient data
  (name, card number, medical resume) only to jkn-tim-medis and jkn-tim-investigasi.

Everything is idempotent (what exists is kept) and nothing is ever deleted: the demo stays in the apps for the user.
Scenarios follow Foundry's 30-day time to live; building again recreates the demo scenarios that expired.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter

import ontology
import ontology_model as om

router = APIRouter(prefix="/api/demo/jkn/ontology")

FASKES = "Faskes JKN (demo)"
TARIF = "Tarif INA-CBG (demo)"
ALERT = "Peringatan Risiko JKN (demo)"
ALERT_LINK = "Peringatan untuk klaim (demo)"
GRAPH = "Demo: Klaim berisiko RSUD Contoh Sejahtera"
TEMPLATE = "Demo: Template investigasi faskes"
# categories whose alerts are "danger" (fabricated or copied claims); the others are "warning"
DANGER = {5, 6, 14, 17, 20}
MACHINERY = "Demo: Proses verifikasi klaim JKN"
RULES_WF = "Demo: Aturan skrining klaim JKN"
TEMUAN = "Temuan Aturan JKN (demo)"
VERIFIKATOR = "Verifikator JKN (demo)"
AUDIT = "Jadwal Audit Klaim (demo)"
SAVE_AUDIT = "Simpan jadwal audit (demo)"
BOARD = "Demo: Jadwal audit klaim JKN"
MON_HIGH = "Demo: Klaim baru bertarif di atas Rp 10 juta"
CAD = "Model 3D Ruang Rawat (demo)"
RUJUKAN = "Rujukan antar faskes (demo)"
MON_HELD = "Demo: Total klaim ditunda di atas Rp 40 juta"
DRILL = "Validasi ontologi klaim JKN (demo)"
CHANGELOG = "Log verifikasi klaim (demo)"
KLAIM = "Klaim JKN (demo)"
LINK = "Klaim di faskes (demo)"
ACT_STATUS = "Ubah status verifikasi klaim (demo)"
ACT_TARIF = "Koreksi tarif INA-CBG (demo)"
MERGE = "Demo: Terapkan skenario verifikasi klaim"
SC_TUNDA = "Demo: Tunda pembayaran klaim berisiko"
SC_UPCODING = "Demo: Koreksi upcoding ke severity I"
KANTOR = {"RS-01": "KC Contoh Kota", "RS-02": "KC Contoh Kota", "KLU-07": "KC Contoh Kota",
          "PKM-01": "KC Contoh Kabupaten", "PKM-02": "KC Contoh Kabupaten", "KLP-03": "KC Contoh Kabupaten"}
# categories whose claims are under investigation (restricted rows in the security demo)
INVESTIGASI = {5, 6, 17}


def _type(name: str) -> Optional[dict]:
    return next((t for t in ontology._all("object-types") if t["display_name"] == name), None)


def _action(name: str) -> Optional[dict]:
    return next((a for a in ontology._all("action-types") if a["display_name"] == name), None)


def _p(api: str, name: str, typ: str = "string", **kw: Any) -> dict:
    return {"api_name": api, "display_name": name, "type": typ, **kw}


def _ensure_types() -> tuple[dict, dict, dict]:
    created = []
    fk = _type(FASKES)
    if not fk:
        fk = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=FASKES, plural_name="Faskes JKN (demo)", api_name="FaskesJknDemo", primary_key="kode", title_property="nama",
            description="Demo: fasilitas kesehatan fiktif (FKTP dan FKRTL) dalam audit risiko JKN.",
            properties=[ontology.Property(**_p("kode", "Kode faskes", render_hints=["searchable", "identifier"])),
                        ontology.Property(**_p("nama", "Nama", render_hints=["searchable"])),
                        ontology.Property(**_p("jenis", "Jenis", render_hints=["searchable", "selectable"])),
                        ontology.Property(**_p("kepemilikan", "Kepemilikan", render_hints=["searchable", "selectable"])),
                        ontology.Property(**_p("kantor_cabang", "Kantor cabang", render_hints=["searchable", "selectable"]))]))
        created.append(FASKES)
    kl = _type(KLAIM)
    if not kl:
        kl = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=KLAIM, plural_name="Klaim JKN (demo)", api_name="KlaimJknDemo", primary_key="no_sep", title_property="no_sep",
            description="Demo: klaim INA-CBG fiktif per SEP, dengan kategori risiko (20 subkategori Efisiensi Risiko pada Fasilitas "
                        "Kesehatan) untuk kasus yang ditanam. Data peserta hanya terlihat oleh jkn-tim-medis / jkn-tim-investigasi; "
                        "klaim dalam investigasi hanya oleh jkn-tim-investigasi.",
            properties=[ontology.Property(**_p("no_sep", "No. SEP", render_hints=["searchable", "identifier", "regex_queries", "leading_wildcards"])),
                        ontology.Property(**_p("nama_peserta", "Nama peserta", render_hints=["searchable"])),
                        ontology.Property(**_p("no_kartu", "No. kartu JKN", render_hints=["searchable", "regex_queries"])),
                        ontology.Property(**_p("faskes", "Faskes", render_hints=["searchable", "selectable"])),
                        ontology.Property(**_p("kantor_cabang", "Kantor cabang", render_hints=["searchable", "selectable"])),
                        ontology.Property(**_p("jenis", "Jenis rawat", render_hints=["selectable"])),
                        ontology.Property(**_p("tgl_masuk", "Tanggal masuk", "date")),
                        ontology.Property(**_p("tgl_pulang", "Tanggal pulang", "date")),
                        ontology.Property(**_p("lama_rawat", "Lama rawat (hari)", "integer")),
                        ontology.Property(**_p("kelas_rawat", "Kelas rawat", "integer")),
                        ontology.Property(**_p("diag_utama", "Diagnosis utama (ICD-10)", render_hints=["searchable", "regex_queries", "selectable"])),
                        ontology.Property(**_p("prosedur", "Prosedur (ICD-9-CM)", render_hints=["searchable"])),
                        ontology.Property(**_p("kode_inacbg", "Kode INA-CBG", render_hints=["searchable", "regex_queries", "leading_wildcards"])),
                        ontology.Property(**_p("tarif_inacbg", "Tarif INA-CBG", "double")),
                        ontology.Property(**_p("tarif_rs", "Tarif RS", "double")),
                        ontology.Property(**_p("status_verifikasi", "Status verifikasi", render_hints=["searchable", "selectable"])),
                        ontology.Property(**_p("kategori_risiko", "Kategori risiko", render_hints=["searchable", "selectable"])),
                        ontology.Property(**_p("akses_terbatas", "Akses terbatas", render_hints=["selectable"])),
                        ontology.Property(**_p("catatan_verifikasi", "Catatan verifikasi", render_hints=["searchable", "long_text"])),
                        ontology.Property(**_p("resume", "Resume medis", render_hints=["searchable", "long_text"]))]))
        created.append(KLAIM)
    lt = next((x for x in ontology._all("link-types") if x.get("display_name") == LINK), None)
    if not lt:
        lt = om.create_link_type(om.LinkTypeIn(
            display_name=LINK, kind="foreign_key", cardinality="many_to_one", foreign_key="faskes",
            source=om.LinkSide(object_type_id=kl["id"], display_name="Klaim", plural_display_name="Klaim"),
            target=om.LinkSide(object_type_id=fk["id"], display_name="Faskes")))
        created.append(LINK)
    return ontology._object_type(fk["id"]), ontology._object_type(kl["id"]), lt


def _ensure_objects(fk: dict, kl: dict) -> int:
    import demo_jkn

    tables = demo_jkn.generate()
    expected = {ref: i for i, refs in demo_jkn.EXPECTED.items() for ref in refs}
    names = {r["no_kartu"]: r["nama"] for r in tables["peserta"].to_pylist()}
    have_f = ontology.stored_objects(fk["id"])
    have_k = ontology.stored_objects(kl["id"])
    edits = []
    for r in tables["faskes"].to_pylist():
        if r["kode"] not in have_f:
            edits.append({"op": "create", "object_type_id": fk["id"], "primary_key": r["kode"],
                          "properties": {**r, "kantor_cabang": KANTOR.get(r["kode"], "KC Contoh Kota")}})
    for r in tables["kunjungan"].to_pylist():
        if r["no_sep"] in have_k:
            continue
        cat = expected.get(r["no_sep"])
        los = (r["tgl_pulang"] - r["tgl_masuk"]).days if r["tgl_pulang"] and r["tgl_masuk"] else None
        edits.append({"op": "create", "object_type_id": kl["id"], "primary_key": r["no_sep"], "properties": {
            "no_sep": r["no_sep"], "nama_peserta": names.get(r["no_kartu"], ""), "no_kartu": r["no_kartu"], "faskes": r["faskes"],
            "kantor_cabang": KANTOR.get(r["faskes"], "KC Contoh Kota"), "jenis": r["jenis"],
            "tgl_masuk": r["tgl_masuk"].isoformat() if r["tgl_masuk"] else None, "tgl_pulang": r["tgl_pulang"].isoformat() if r["tgl_pulang"] else None,
            "lama_rawat": los, "kelas_rawat": r["kelas_rawat"], "diag_utama": r["diag_utama"], "prosedur": r["prosedur"],
            "kode_inacbg": r["kode_inacbg"], "kode_dasar_inacbg": r["kode_dasar"], "tarif_inacbg": r["tarif_inacbg"], "tarif_rs": r["tarif_rs"],
            "status_verifikasi": "diajukan",
            "kategori_risiko": f"{cat}. {demo_jkn.CATEGORIES[cat - 1]}" if cat else "", "akses_terbatas": "investigasi" if cat in INVESTIGASI else "",
            "catatan_verifikasi": "", "resume": r["resume"]}})
    if edits:
        ontology.apply_edits(edits, source="demo-jkn-ontology")
    return len(edits)


def _ensure_actions(kl: dict) -> dict:
    out = {}
    for name, params in ((ACT_STATUS, [("status_verifikasi", "Status verifikasi", True), ("catatan_verifikasi", "Catatan verifikasi", False)]),
                         (ACT_TARIF, [("kode_inacbg", "Kode INA-CBG", True), ("tarif_inacbg", "Tarif INA-CBG", True), ("catatan_verifikasi", "Catatan verifikasi", False)])):
        a = _action(name)
        if not a:
            a = ontology.create_action_type(ontology.ActionTypeIn(
                display_name=name, object_type_id=kl["id"], kind="modify", status="active",
                parameters=[ontology.Parameter(id="object", display_name="Klaim", type="object", required=True)]
                + [ontology.Parameter(id=pid, display_name=label, type="string", property=pid, required=req) for pid, label, req in params]))
        out[name] = a
    merge = _action(MERGE)
    if not merge:
        import ontology_scenarios

        merge = ontology_scenarios.create_merge_action(ontology_scenarios.MergeActionIn(display_name=MERGE, object_type_ids=[kl["id"]]))
    out[MERGE] = merge
    return out


def _ensure_scenarios(kl: dict, acts: dict) -> list[str]:
    import ontology_scenarios as sc

    have = {s["name"] for s in sc.list_scenarios()}
    made = []
    objs = ontology.stored_objects(kl["id"])
    if SC_TUNDA not in have:
        s = sc.create_scenario(sc.ScenarioIn(name=SC_TUNDA, persisted=True, description=(
            "Apa dampaknya bila semua klaim yang terindikasi salah satu dari 20 subkategori risiko ditunda sebelum dibayar? "
            "Bandingkan total Tarif INA-CBG per Status verifikasi antara main dan skenario ini.")))
        for pk, o in sorted(objs.items()):
            cat = (o.get("properties") or {}).get("kategori_risiko")
            if cat:
                sc.apply_in_scenario(s["id"], acts[ACT_STATUS]["id"], sc.ApplyIn(parameters={
                    "object": pk, "status_verifikasi": "ditunda", "catatan_verifikasi": f"Ditunda: terindikasi {cat}"}))
        made.append(SC_TUNDA)
    if SC_UPCODING not in have:
        s = sc.create_scenario(sc.ScenarioIn(name=SC_UPCODING, persisted=True, description=(
            "Klaim dengan severity II/III tanpa diagnosis sekunder yang mendukung dikoreksi ke severity I (tarif klaim sejenis "
            "dengan severity I di kelas yang sama). Bandingkan jumlah Tarif INA-CBG per faskes.")))
        normal: dict[tuple, float] = {}
        for o in objs.values():
            p = o.get("properties") or {}
            code = str(p.get("kode_inacbg") or "")
            if code.endswith("-I") and not p.get("kategori_risiko"):
                normal[(code[:-2], p.get("kelas_rawat"))] = p.get("tarif_inacbg")
        for pk, o in sorted(objs.items()):
            p = o.get("properties") or {}
            code = str(p.get("kode_inacbg") or "")
            if p.get("kategori_risiko", "").startswith("4.") and code.rsplit("-", 1)[-1] in ("II", "III"):
                base = code.rsplit("-", 1)[0]
                tarif = normal.get((base, p.get("kelas_rawat"))) or round(float(p.get("tarif_inacbg") or 0) * 0.6, -3)
                sc.apply_in_scenario(s["id"], acts[ACT_TARIF]["id"], sc.ApplyIn(parameters={
                    "object": pk, "kode_inacbg": f"{base}-I", "tarif_inacbg": str(tarif),
                    "catatan_verifikasi": f"Koreksi upcoding: {code} → {base}-I"}))
        made.append(SC_UPCODING)
    return made


def _ensure_security(kl: dict) -> bool:
    import ontology_security as sec

    if kl.get("security"):
        return False
    rec = ontology._object_type(kl["id"])
    rec["security"] = sec.check_security(rec, {
        "object_policy": {"markings": [], "granular": {"kind": "or", "children": [
            {"kind": "condition", "left": {"kind": "property", "property": "akses_terbatas"}, "op": "is_empty"},
            {"kind": "condition", "left": {"kind": "user_groups"}, "op": "intersects", "right": {"kind": "static", "value": ["jkn-tim-investigasi"]}}]}},
        "property_policies": [{"name": "Data peserta (PII)", "properties": ["nama_peserta", "no_kartu", "resume"], "markings": [],
                               "granular": {"kind": "or", "children": [
                                   {"kind": "condition", "left": {"kind": "user_groups"}, "op": "intersects",
                                    "right": {"kind": "static", "value": ["jkn-tim-medis", "jkn-tim-investigasi"]}}]}}]})
    ontology._put("object-types", rec)
    return True


def _ensure_edits(kl: dict, acts: dict) -> bool:
    import ontology_edits as oe

    c = oe.config(ontology._object_type(kl["id"]))
    changed = False
    if not c["history"]:
        oe.set_config(kl["id"], oe.EditsConfigIn(history=True))
        changed = True
    if not _has_history(kl["id"]):
        pk = next((pk for pk, o in sorted(ontology.stored_objects(kl["id"]).items())
                   if str((o.get("properties") or {}).get("kategori_risiko", "")).startswith("12.")), None)
        if pk:
            ontology.apply_action(acts[ACT_STATUS]["id"], ontology.ApplyAction(parameters={
                "object": pk, "status_verifikasi": "dalam verifikasi", "catatan_verifikasi": "Demo: telaah lama rawat terhadap resume dan log kamar"}))
            changed = True
    if not (c["materialization"] or {}).get("dataset_id"):
        try:
            oe.set_materialization(kl["id"], oe.MaterializationIn(mode="automatic"))
            changed = True
        except Exception:  # noqa: BLE001 - Files may be unavailable (no database): the rest of the demo stands
            pass
    return changed


def _has_history(tid: str) -> bool:
    import ontology_edits as oe

    return bool(ontology._read(oe._history_path(tid), {}))


def _ensure_tarif() -> bool:
    """A dataset-backed object type (indexing demo): the INA-CBG base tariffs per class."""
    if _type(TARIF):
        return False
    import demo_jkn
    import drive
    import ontology_datasources
    import pipeline_datasets

    table = demo_jkn.generate()["tarif_inacbg"]
    item = drive.save_bytes(drive.default_folder("ontology"), f"{TARIF}.parquet", pipeline_datasets._parquet_bytes(table), pipeline_datasets.PARQUET)
    ontology_datasources.create_from_dataset(ontology_datasources.FromDatasetIn(
        dataset_id=item["id"], display_name=TARIF, description="Demo: tarif dasar INA-CBG per kelas rawat, didukung dataset Files (indexing).",
        primary_key="kode_dasar", title_property="deskripsi",
        columns=[ontology_datasources.ColumnIn(column=c, api_name=c, display_name=label) for c, label in
                 (("kode_dasar", "Kode dasar"), ("deskripsi", "Deskripsi"), ("tarif_i", "Tarif kelas I"), ("tarif_ii", "Tarif kelas II"), ("tarif_iii", "Tarif kelas III"))]))
    return True


def _ensure_embeddings(kl: dict) -> Any:
    import ontology_semantic

    t = ontology._object_type(kl["id"])
    if not any(p["api_name"] == "resumeEmbedding" for p in t["properties"]):
        out: Any = ontology_semantic.embed_objects(kl["id"], ontology_semantic.EmbedIn(source_property="resume", vector_property="resumeEmbedding"))
    else:
        out = False
    with ontology._lock:
        t = ontology._object_type(kl["id"])
        pii = next((pp for pp in ((t.get("security") or {}).get("property_policies") or []) if pp.get("name") == "Data peserta (PII)"), None)
        if pii and "resumeEmbedding" not in pii["properties"] and any(p["api_name"] == "resumeEmbedding" for p in t["properties"]):
            pii["properties"].append("resumeEmbedding")
            ontology._put("object-types", t)
    return out


def _ensure_vertex(fk: dict, kl: dict, lt_faskes: dict) -> list[str]:
    import vertex

    made = []
    al = _type(ALERT)
    if not al:
        al = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=ALERT, api_name="PeringatanRisikoJknDemo", primary_key="id_peringatan", title_property="judul",
            description="Demo: peringatan (event) per klaim yang terindikasi salah satu dari 20 subkategori risiko; intent danger untuk klaim fiktif/jiplakan.",
            properties=[ontology.Property(**_p("id_peringatan", "ID peringatan", type_classes=["vertex:event_intent.warning"])),
                        ontology.Property(**_p("judul", "Judul", render_hints=["searchable"])),
                        ontology.Property(**_p("no_sep", "No. SEP", render_hints=["searchable"])),
                        ontology.Property(**_p("kategori_risiko", "Kategori risiko", render_hints=["selectable"])),
                        ontology.Property(**_p("tingkat", "Tingkat", render_hints=["selectable"], type_classes=["vertex:event_intent"])),
                        ontology.Property(**_p("waktu", "Waktu", "timestamp"))]))
        made.append(ALERT)
    else:
        rec = ontology._object_type(al["id"])
        tp = next((p for p in rec["properties"] if p["api_name"] == "tingkat"), None)
        if tp is not None and "vertex:event_intent" not in (tp.get("type_classes") or []):
            tp["type_classes"] = (tp.get("type_classes") or []) + ["vertex:event_intent"]
            ontology._put("object-types", rec)
    lt = next((x for x in ontology._all("link-types") if x.get("display_name") == ALERT_LINK), None)
    if not lt:
        lt = om.create_link_type(om.LinkTypeIn(
            display_name=ALERT_LINK, kind="foreign_key", cardinality="many_to_one", foreign_key="no_sep",
            source=om.LinkSide(object_type_id=al["id"], display_name="Peringatan", plural_display_name="Peringatan"),
            target=om.LinkSide(object_type_id=kl["id"], display_name="Klaim")))
        made.append(ALERT_LINK)
    have = ontology.stored_objects(al["id"])
    edits = []
    for pk, o in sorted(ontology.stored_objects(kl["id"]).items()):
        p = o.get("properties") or {}
        cat = str(p.get("kategori_risiko") or "")
        if not cat or f"PR-{pk}" in have:
            continue
        no = int(cat.split(".", 1)[0])
        edits.append({"op": "create", "object_type_id": al["id"], "primary_key": f"PR-{pk}", "properties": {
            "id_peringatan": f"PR-{pk}", "judul": cat.split(". ", 1)[-1], "no_sep": pk, "kategori_risiko": cat,
            "tingkat": "danger" if no in DANGER else "warning", "waktu": f"{p.get('tgl_pulang') or p.get('tgl_masuk')}T08:00:00+00:00"}})
    if edits:
        ontology.apply_edits(edits, source="demo-jkn-ontology")
    graphs = {g["name"]: g for g in vertex.list_graphs()}
    risky = [pk for pk, o in sorted(ontology.stored_objects(kl["id"]).items())
             if (o.get("properties") or {}).get("kategori_risiko") and (o.get("properties") or {}).get("faskes") == "RS-01"]
    layers = {fk["id"]: {"color": "#38bdf8", "label_property": "nama"},
              kl["id"]: {"color": "#a78bfa", "label_property": "no_sep", "size_property": "tarif_inacbg",
                         "rules": [{"property": "status_verifikasi", "op": "eq", "value": "ditunda", "color": "#f59e0b"}]},
              al["id"]: {"color": "#ef4444", "label_property": "judul", "rules": [{"property": "tingkat", "op": "eq", "value": "warning", "color": "#f59e0b"}]}}
    if GRAPH not in graphs:
        nodes = [{"object_type_id": fk["id"], "primary_key": "RS-01"}] + [{"object_type_id": kl["id"], "primary_key": pk} for pk in risky]             + [{"object_type_id": al["id"], "primary_key": f"PR-{pk}"} for pk in risky]
        vertex.create_graph(vertex.GraphIn(name=GRAPH, description="Demo: RSUD Contoh Sejahtera, klaimnya yang terindikasi risiko, dan peringatannya.",
                                           nodes=nodes, layout="hierarchy_lr", layers=layers))
        made.append(GRAPH)
    if TEMPLATE not in graphs:
        vertex.create_graph(vertex.GraphIn(
            name=TEMPLATE, description="Demo: pilih faskes → klaimnya yang terindikasi risiko → peringatan.", layout="hierarchy_lr", layers=layers,
            template={"parameters": [{"id": "faskes", "name": "Faskes", "object_type_id": fk["id"], "search_arounds": [{"steps": [
                {"link_type_id": lt_faskes["id"], "direction": "reverse", "filters": [{"property": "kategori_risiko", "op": "not_null"}]},
                {"link_type_id": lt["id"], "direction": "reverse"}]}]}]}))
        made.append(TEMPLATE)
    return made


def _changelog(kl: dict) -> list[dict]:
    """A synthetic verification changelog (processId, state, timestamp) for every claim; seeded, so stable."""
    import random
    from datetime import datetime, timedelta, timezone

    rnd = random.Random(26)
    rows = []
    for pk, o in sorted(ontology.stored_objects(kl["id"]).items()):
        p = o.get("properties") or {}
        base = datetime.fromisoformat(str(p.get("tgl_pulang") or p.get("tgl_masuk") or "2026-09-15")).replace(tzinfo=timezone.utc) + timedelta(days=1, hours=8)
        t = base
        steps = ["diajukan"]
        risky = bool(p.get("kategori_risiko"))
        steps.append("dalam verifikasi")
        if risky or rnd.random() < 0.15:
            steps += ["perlu konfirmasi", "dalam verifikasi"]
        roll = rnd.random()
        if risky:
            steps.append("ditolak" if str(p["kategori_risiko"]).split(".")[0] in {"5", "6", "17"} else "ditunda")
        elif roll < 0.85:
            steps.append("layak bayar")
        # else: still being verified
        for i, st in enumerate(steps):
            if i:
                t += timedelta(hours=rnd.randint(4, 30) * (3 if st == "ditunda" else 1))
            rows.append({"processId": pk, "state": st, "timestamp": t})
    return rows


def _ensure_machinery(kl: dict, acts: dict) -> Any:
    import drive
    import machinery
    import pipeline_datasets
    import pyarrow as pa

    if any(r["name"] == MACHINERY for r in machinery.list_resources()):
        return False
    rows = _changelog(kl)
    latest: dict[str, str] = {}
    for r in rows:
        latest[r["processId"]] = r["state"]
    table = pa.Table.from_pylist(rows, schema=pa.schema([("processId", pa.string()), ("state", pa.string()), ("timestamp", pa.timestamp("s", tz="UTC"))]))
    item = drive.save_bytes(drive.default_folder("ontology"), f"{CHANGELOG}.parquet", pipeline_datasets._parquet_bytes(table), pipeline_datasets.PARQUET)
    objs = ontology.stored_objects(kl["id"])
    edits = [{"op": "modify", "object_type_id": kl["id"], "primary_key": pk, "properties": {"status_verifikasi": st}}
             for pk, st in latest.items() if pk in objs and (objs[pk].get("properties") or {}).get("status_verifikasi") != st]
    if edits:
        ontology.apply_edits(edits, source="demo-jkn-ontology")
    states = ["diajukan", "dalam verifikasi", "layak bayar", "ditunda", "ditolak"]
    rec = machinery.create_resource(machinery.MachineryIn(
        name=MACHINERY, description="Demo: alur verifikasi klaim JKN dari pengajuan sampai keputusan bayar, dengan log dari e-Klaim (changelog) dan edit di platform.",
        processes=[machinery.ProcessIn(
            id="verifikasi", name="Verifikasi klaim", object_type_id=kl["id"], state_property="status_verifikasi",
            states=[{"id": s, "label": s.capitalize()} for s in states],
            transitions=[{"from": machinery.START, "to": "diajukan"}, {"from": "diajukan", "to": "dalam verifikasi"},
                         {"from": "dalam verifikasi", "to": "layak bayar"}, {"from": "dalam verifikasi", "to": "ditunda"},
                         {"from": "dalam verifikasi", "to": "ditolak"}],
            actions=[{"action_type_id": acts[ACT_STATUS]["id"], "inputs": ["diajukan", "dalam verifikasi"], "outputs": ["dalam verifikasi", "layak bayar", "ditunda", "ditolak"],
                      "automation": False}])]))
    return machinery.setup_log(rec["id"], "verifikasi", machinery.LogSetupIn(changelog_dataset_id=item["id"], from_edits=True))


def _ensure_rules(kl: dict) -> Any:
    import foundry_rules as fr

    if any(w["name"] == RULES_WF for w in fr.list_workflows()):
        return False
    tm = _type(TEMUAN)
    if not tm:
        tm = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=TEMUAN, api_name="TemuanAturanJknDemo", primary_key="id_temuan", title_property="alasan",
            description="Demo: temuan dari Foundry Rules (alert per baris keluaran aturan), tertaut ke klaim.",
            properties=[ontology.Property(**_p("id_temuan", "ID temuan")), ontology.Property(**_p("rule_id", "ID aturan")),
                        ontology.Property(**_p("rule_name", "Aturan", render_hints=["selectable"])),
                        ontology.Property(**_p("no_sep", "No. SEP", render_hints=["searchable"])),
                        ontology.Property(**_p("faskes", "Faskes", render_hints=["selectable"])),
                        ontology.Property(**_p("tingkat", "Tingkat", render_hints=["selectable"], type_classes=["vertex:event_intent"])),
                        ontology.Property(**_p("nilai", "Nilai klaim", "double")),
                        ontology.Property(**_p("alasan", "Alasan", render_hints=["searchable"]))]))
        om.create_link_type(om.LinkTypeIn(
            display_name="Temuan aturan untuk klaim (demo)", kind="foreign_key", cardinality="many_to_one", foreign_key="no_sep",
            source=om.LinkSide(object_type_id=tm["id"], display_name="Temuan aturan", plural_display_name="Temuan aturan"),
            target=om.LinkSide(object_type_id=kl["id"], display_name="Klaim")))
    fields = [{"name": "no_sep", "type": "string", "column_values": "selection", "columns": ["no_sep"], "static_values": "none"},
              {"name": "faskes", "type": "string", "required": True, "static_values": "none"},
              {"name": "tingkat", "type": "string", "required": True, "column_values": "none", "static_values": "selection", "values": ["warning", "danger"],
               "default": {"kind": "static", "value": "warning"}},
              {"name": "nilai", "type": "double"},
              {"name": "alasan", "type": "string", "required": True, "template": True}]
    w = fr.create_workflow(fr.WorkflowIn(
        name=RULES_WF, description="Demo: aturan point-and-click atas klaim JKN untuk sebagian dari 20 subkategori risiko; temuan menjadi objek alert.",
        inputs=[{"kind": "object_type", "id": kl["id"]}],
        outputs=[fr.WorkflowOutput(id="temuan", name="Temuan", object_type_id=tm["id"], dataset_name="Temuan aturan JKN (demo)", fields=[fr.OutputField(**f) for f in fields])],
        custom_properties=[{"name": "subkategori", "type": "string"}, {"name": "pemilik", "type": "string"}], require_proposals=True))
    inp = {"kind": "object_type", "id": kl["id"]}

    def col(c: str) -> dict:
        return {"kind": "column", "column": c}

    def out(tingkat: str, alasan: str, nilai: Optional[str] = "tarif_inacbg", sep: bool = True) -> dict:
        mapping = {"faskes": col("faskes"), "tingkat": {"kind": "static", "value": tingkat}, "alasan": {"kind": "template", "value": alasan}}
        if sep:
            mapping["no_sep"] = col("no_sep")
        if nilai:
            mapping["nilai"] = col(nilai)
        return {"output_id": "temuan", "mapping": mapping}

    rules = [
        ("Demo: Prolonged length of stay (> 7 hari)", "12. Prolonged length of stay",
         [{"kind": "filter", "combine": "all", "conditions": [{"column": "jenis", "op": "eq", "value": "RI"}, {"column": "lama_rawat", "op": "gt", "value": 7}]}],
         out("warning", "Rawat inap {lama_rawat} hari untuk {diag_utama} ({kode_inacbg})")),
        ("Demo: Tarif RS jauh di atas INA-CBG (> 12%)", "7. Inflated bills",
         [{"kind": "expression", "expression": "round((tarif_rs - tarif_inacbg) / tarif_inacbg * 100, 1)", "as": "selisih_pct"},
          {"kind": "filter", "conditions": [{"column": "selisih_pct", "op": "gt", "value": 12}]}],
         out("warning", "Tarif RS {selisih_pct}% di atas tarif INA-CBG {kode_inacbg}")),
        ("Demo: Readmisi dalam 30 hari", "16. Readmisi (admisi berulang)",
         [{"kind": "filter", "conditions": [{"column": "jenis", "op": "eq", "value": "RI"}]},
          {"kind": "window", "partition_by": ["no_kartu"], "order_by": "tgl_masuk", "fn": "lag", "column": "tgl_pulang", "as": "pulang_sebelumnya"},
          {"kind": "expression", "expression": "days_between(pulang_sebelumnya, tgl_masuk)", "as": "jeda_hari"},
          {"kind": "filter", "conditions": [{"column": "jeda_hari", "op": "not_null"}, {"column": "jeda_hari", "op": "lte", "value": 30}]}],
         out("danger", "Masuk lagi {jeda_hari} hari setelah pulang ({diag_utama})")),
        ("Demo: Faskes dengan 5 atau lebih klaim berisiko", "Pola per faskes",
         [{"kind": "filter", "conditions": [{"column": "kategori_risiko", "op": "not_null"}]},
          {"kind": "aggregation", "group_by": ["faskes"], "aggregations": [{"fn": "count", "as": "jumlah"}, {"fn": "sum", "column": "tarif_inacbg", "as": "total_tarif"}]},
          {"kind": "filter", "conditions": [{"column": "jumlah", "op": "gte", "value": 5}]}],
         out("danger", "{jumlah} klaim terindikasi risiko di {faskes}", nilai="total_tarif", sep=False)),
    ]
    with ontology._lock:
        for name, sub, blocks, output in rules:
            p = fr._propose("create", w, None, {"workflow_id": w["id"], "name": name, "description": f"Demo: subkategori {sub}.", "status": "active",
                                                  "custom": {"subkategori": sub, "pemilik": "Tim anti-fraud (demo)"}, "logic": {"input": inp, "blocks": blocks, "output": output}})
            if p["status"] == "open":
                fr._apply(p)
                p.update(status="approved", reviewer="Reviewer (demo)", reviewed_at=ontology._now(), review_comment="Demo: disetujui saat demo dibuat")
                ontology._put("foundry-rules-proposals", p)
        fr._propose("create", w, None, {
            "workflow_id": w["id"], "name": "Demo: Kelas 1 rawat inap dengan tarif RS tinggi", "description": "Demo: usulan, menunggu review.", "status": "active",
            "custom": {"subkategori": "13. Manipulasi kelas perawatan", "pemilik": "Tim anti-fraud (demo)"},
            "logic": {"input": inp, "blocks": [{"kind": "filter", "conditions": [{"column": "kelas_rawat", "op": "eq", "value": 1}, {"column": "jenis", "op": "eq", "value": "RI"},
                                                                                  {"column": "tarif_rs", "op": "gt", "value": 5000000}]}],
                      "output": out("warning", "Kelas 1, tarif RS {tarif_rs}")}})
    return fr.run_workflow(w["id"])


def _ensure_scheduling(kl: dict) -> Any:
    import dynamic_scheduling as ds
    from datetime import datetime, timedelta, timezone

    if any(b["name"] == BOARD for b in ds.list_boards()):
        return False
    vt = _type(VERIFIKATOR)
    if not vt:
        vt = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=VERIFIKATOR, api_name="VerifikatorJknDemo", primary_key="id_verifikator", title_property="nama",
            description="Demo: verifikator klaim fiktif per kantor cabang, dengan keahlian jenis faskes.",
            properties=[ontology.Property(**_p("id_verifikator", "ID verifikator")), ontology.Property(**_p("nama", "Nama", render_hints=["searchable"])),
                        ontology.Property(**_p("kantor_cabang", "Kantor cabang", render_hints=["selectable"])),
                        ontology.Property(**_p("keahlian", "Keahlian (jenis faskes)", render_hints=["selectable"]))]))
        ontology.apply_edits([{"op": "create", "object_type_id": vt["id"], "primary_key": v[0], "properties": dict(zip(("id_verifikator", "nama", "kantor_cabang", "keahlian"), v))}
                              for v in (("V-01", "dr. Ayu Lestari", "KC Contoh Kota", "FKRTL"), ("V-02", "Bima Saputra", "KC Contoh Kota", "FKRTL"),
                                        ("V-03", "Citra Wulandari", "KC Contoh Kota", "FKTP"), ("V-04", "Dedi Kurniawan", "KC Contoh Kabupaten", "FKRTL"),
                                        ("V-05", "Eka Pratiwi", "KC Contoh Kabupaten", "FKTP"), ("V-06", "Fajar Hidayat", "KC Contoh Kabupaten", "FKTP"))],
                             source="demo-jkn-ontology")
    at = _type(AUDIT)
    if not at:
        at = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=AUDIT, api_name="JadwalAuditKlaimDemo", primary_key="id_audit", title_property="judul",
            description="Demo: jadwal audit / verifikasi lapangan per klaim berisiko, dialokasikan ke verifikator (Dynamic Scheduling).",
            properties=[ontology.Property(**_p("id_audit", "ID audit")), ontology.Property(**_p("judul", "Judul", render_hints=["searchable"])),
                        ontology.Property(**_p("no_sep", "No. SEP")), ontology.Property(**_p("faskes", "Faskes", render_hints=["selectable"])),
                        ontology.Property(**_p("kantor_cabang", "Kantor cabang", render_hints=["selectable"])),
                        ontology.Property(**_p("jenis_faskes", "Jenis faskes", render_hints=["selectable"])),
                        ontology.Property(**_p("kategori_risiko", "Kategori risiko", render_hints=["selectable"])),
                        ontology.Property(**_p("id_verifikator", "Verifikator")),
                        ontology.Property(**_p("mulai", "Mulai", "timestamp", type_classes=["schedules:schedulable-start-time"])),
                        ontology.Property(**_p("selesai", "Selesai", "timestamp", type_classes=["schedules:schedulable-end-time"])),
                        ontology.Property(**_p("durasi_tetap", "Durasi tetap", "boolean"))]))
        om.create_link_type(om.LinkTypeIn(
            display_name="Audit oleh verifikator (demo)", kind="foreign_key", cardinality="many_to_one", foreign_key="id_verifikator",
            source=om.LinkSide(object_type_id=at["id"], display_name="Jadwal audit", plural_display_name="Jadwal audit"),
            target=om.LinkSide(object_type_id=vt["id"], display_name="Verifikator")))
        faskes_type = _type(FASKES)
        jenis = {pk: (o.get("properties") or {}).get("jenis") for pk, o in ontology.stored_objects(faskes_type["id"]).items()} if faskes_type else {}
        day = datetime(2026, 10, 12, tzinfo=timezone.utc)
        # (verifikator, day offset, start hour, hours) for the first claims; None: not assigned yet
        plan = [("V-01", 0, 8, 3), ("V-01", 0, 10, 2), ("V-02", 0, 9, 3), ("V-02", 1, 13, 3), ("V-01", 1, 9, 4), ("V-04", 1, 8, 2),
                ("V-02", 2, 15, 4), ("V-04", 2, 10, 3)]
        edits = []
        risky = [(pk, o.get("properties") or {}) for pk, o in sorted(ontology.stored_objects(kl["id"]).items()) if (o.get("properties") or {}).get("kategori_risiko")]
        for i, (pk, p) in enumerate(risky):
            props = {"id_audit": f"AUD-{pk[-6:]}", "judul": f"Audit {p['kategori_risiko'].split('. ', 1)[-1]} · {pk[-6:]}", "no_sep": pk, "faskes": p.get("faskes"),
                     "kantor_cabang": p.get("kantor_cabang"), "jenis_faskes": jenis.get(p.get("faskes"), "FKRTL"), "kategori_risiko": p["kategori_risiko"],
                     "durasi_tetap": i % 3 == 0}
            if i < len(plan):
                v, d, h, hrs = plan[i]
                s = day + timedelta(days=d, hours=h)
                props.update({"id_verifikator": v, "mulai": s.isoformat(), "selesai": (s + timedelta(hours=hrs)).isoformat()})
            else:
                props.update({"mulai": (day + timedelta(days=3, hours=9)).isoformat(), "selesai": (day + timedelta(days=3, hours=11)).isoformat()})
            edits.append({"op": "create", "object_type_id": at["id"], "primary_key": props["id_audit"], "properties": props})
        ontology.apply_edits(edits, source="demo-jkn-ontology")
    save = _action(SAVE_AUDIT) or ontology.create_action_type(ontology.ActionTypeIn(
        display_name=SAVE_AUDIT, object_type_id=at["id"], kind="modify", status="active",
        parameters=[ontology.Parameter(id="object", display_name="Jadwal audit", type="object", required=True),
                    ontology.Parameter(id="id_verifikator", display_name="Verifikator", type="string", property="id_verifikator"),
                    ontology.Parameter(id="mulai", display_name="Mulai", type="timestamp", property="mulai"),
                    ontology.Parameter(id="selesai", display_name="Selesai", type="timestamp", property="selesai")]))
    rules = [ds.Rule(name="Tidak ada jadwal bentrok", constraint="HARD", kind="no_overlap"),
             ds.Rule(name="Jam kerja 08.00-17.00", constraint="HARD", kind="within_hours", start_hour=8, end_hour=17),
             ds.Rule(name="Keahlian sesuai jenis faskes", constraint="HARD", kind="property_match", schedule_property="jenis_faskes", resource_property="keahlian"),
             ds.Rule(name="Maksimal 2 audit per hari", constraint="SOFT", kind="max_per_day", max=2),
             ds.Rule(name="Verifikator dari kantor cabang yang sama", constraint="SOFT", kind="property_match", schedule_property="kantor_cabang", resource_property="kantor_cabang")]
    b = ds.create_board(ds.BoardIn(
        name=BOARD, description="Demo: alokasi audit klaim berisiko ke verifikator selama satu minggu kerja; perubahan di-stage di skenario lalu disubmit.",
        schedule_object_type_id=at["id"], resource_object_type_id=vt["id"], resource_property="id_verifikator", start_property="mulai", end_property="selesai",
        fixed_duration_property="durasi_tetap", label_property="judul", color_property="kantor_cabang", save_action_id=save["id"],
        timeline_start="2026-10-12T00:00:00+00:00", timeline_end="2026-10-17T00:00:00+00:00", snap_minutes=30, rules=rules,
        row_properties=["kantor_cabang", "keahlian"]))
    d = ds.data(b["id"])
    return {"board_id": b["id"], "pucks": len(d["pucks"]), "unassigned": len(d["unassigned"]), "hard_violations": d["hard_violations"]}


def _ensure_object_view(kl: dict) -> Any:
    import object_views as ov

    if ov.summary(kl["id"])["configured"]:
        return False
    links = {x.get("display_name"): x for x in ontology._all("link-types")}
    tabs = [{"title": "Ringkasan klaim", "kind": "properties", "properties": ["no_sep", "faskes", "jenis", "tgl_masuk", "tgl_pulang", "lama_rawat", "kelas_rawat",
                                                                                  "diag_utama", "prosedur", "kode_inacbg", "tarif_inacbg", "tarif_rs", "status_verifikasi"]},
            {"title": "Detail risiko", "kind": "properties", "properties": ["kategori_risiko", "catatan_verifikasi", "akses_terbatas"],
             "visibility": {"kind": "property", "property": "status_verifikasi", "op": "neq", "value": "layak bayar"}}]
    for name, title, direction in ((LINK, "Faskes", "forward"), ("Temuan aturan untuk klaim (demo)", "Temuan aturan", "reverse"),
                                   (ALERT_LINK, "Peringatan", "reverse")):
        if name in links:
            tabs.append({"title": title, "kind": "links", "link_type_id": links[name]["id"], "direction": direction})
    tabs += [{"title": "Timeline", "kind": "timeline"}, {"title": "Riwayat edit", "kind": "edit_history"}, {"title": "Komentar", "kind": "comments"}]
    base = {"tabs": tabs, "header_properties": ["faskes", "status_verifikasi", "kategori_risiko", "tarif_inacbg"],
            "panel_properties": ["no_sep", "faskes", "status_verifikasi", "tarif_inacbg"],
            "set_panel_aggregates": [{"metric": "count"}, {"metric": "sum", "property": "tarif_inacbg"}, {"metric": "avg", "property": "lama_rawat"}],
            "sidebar": [{"label": "Vertex", "app": "vertex"}, {"label": "Object Explorer", "app": "object-explorer"}]}
    ov.save_view(kl["id"], ov.SaveIn(config=ov.ViewConfig(**{**base, "tabs": tabs[:1] + tabs[2:]}), description="Demo: versi awal tanpa tab risiko", auto_publish=False))
    ov.publish(kl["id"], ov.PublishIn(version=1))
    ov.save_view(kl["id"], ov.SaveIn(config=ov.ViewConfig(**base), description="Demo: tambah tab Detail risiko (tampil bila status bukan layak bayar)"))
    ov.publish(kl["id"], ov.PublishIn(version=2))
    risky = next((pk for pk, o in sorted(ontology.stored_objects(kl["id"]).items()) if str((o.get("properties") or {}).get("kategori_risiko", "")).startswith("4.")), None)
    if risky:
        ov.add_comment(kl["id"], risky, ov.CommentIn(text="Demo: kode INA-CBG severity III tidak didukung diagnosis sekunder di resume. Mohon telaah rekam medis sebelum dibayar."))
    return {"versions": 2, "commented": risky}


def _ensure_monitors(kl: dict) -> Any:
    import object_monitors as mo
    import ontology_explorer as ox

    names = {m["name"] for m in mo.list_monitors()}
    made = []
    exps = {e["name"]: e for e in ox.list_explorations()}

    def exploration(name: str, filters: list[dict]) -> dict:
        return exps.get(name) or ox.create_exploration(ox.ExplorationIn(name=name, description="Demo: input monitor", spec={"object_type_id": kl["id"], "filters": filters}))

    if MON_HIGH not in names:
        e = exploration("Demo: Klaim tarif di atas Rp 10 juta", [{"property": "tarif_inacbg", "op": "gt", "value": 10_000_000}])
        mo.create_monitor(mo.MonitorIn(name=MON_HIGH, description="Demo: beri tahu tim verifikasi saat ada klaim bertarif tinggi baru (event, realtime).",
                                       exploration_id=e["id"], condition=mo.Condition(kind="objects_added"), every_minutes=60))
        made.append(MON_HIGH)
    if MON_HELD not in names:
        e = exploration("Demo: Klaim berstatus ditunda", [{"property": "status_verifikasi", "op": "eq", "value": "ditunda"}])
        mo.create_monitor(mo.MonitorIn(name=MON_HELD, description="Demo: status benar saat total tarif klaim ditunda melewati Rp 40 juta (threshold, terjadwal).",
                                       exploration_id=e["id"], every_minutes=60,
                                       condition=mo.Condition(kind="threshold", threshold=mo.Threshold(metric=mo.Metric(metric="sum", property="tarif_inacbg"), op="gt", value=40_000_000))))
        made.append(MON_HELD)
    return made


def _ward_obj() -> bytes:
    """A synthetic 3D model (OBJ, metres, Z up) of a 6-bed class III ward: floor, walls, beds and a nurse station."""
    lines = ["# Ruang rawat kelas III Lt. 3 RSUD Contoh (demo), synthetic", "mtllib none"]
    count = 0

    def box(name: str, x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> None:
        nonlocal count
        lines.append(f"g {name}")
        for x, y, z in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)):
            lines.append(f"v {x:.3f} {y:.3f} {z:.3f}")
        b = count
        for f in ((1, 2, 3, 4), (5, 8, 7, 6), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 8, 4), (4, 8, 5, 1)):
            lines.append("f " + " ".join(str(b + i) for i in f))
        count += 8

    box("Lantai", 0, 0, -0.1, 12, 8, 0)
    box("Dinding-utara", 0, 7.9, 0, 12, 8, 3)
    box("Dinding-selatan", 0, 0, 0, 12, 0.1, 3)
    box("Dinding-barat", 0, 0, 0, 0.1, 8, 3)
    for i in range(6):
        x = 1 + (i % 3) * 3.6
        y = 1 if i < 3 else 5.6
        box(f"Bed-30{i + 1}", x, y, 0, x + 2.0, y + 0.9, 0.6)
    box("Nurse-station", 10.2, 3.2, 0, 11.6, 4.8, 1.1)
    return ("\n".join(lines) + "\n").encode()


def _ensure_vulcan() -> Any:
    import drive
    import vulcan

    if _type(CAD):
        return False
    item = drive.save_bytes(drive.default_folder("ontology"), "Ruang Rawat Kelas III Lt3 RSUD Contoh (demo).obj", _ward_obj(), "model/obj")
    cad = ontology.create_object_type(ontology.ObjectTypeIn(
        display_name=CAD, api_name="ModelRuangRawatDemo", primary_key="id_ruang", title_property="nama",
        description="Demo: model 3D ruang rawat untuk verifikasi lapangan kelas perawatan (subkategori 13).",
        properties=[ontology.Property(**_p("id_ruang", "ID ruang")), ontology.Property(**_p("nama", "Nama")),
                    ontology.Property(**_p("berkas", "Berkas model", "media", type_classes=["vulcan:cad_media_reference"])),
                    ontology.Property(**_p("up_axis", "Up axis", type_classes=["vulcan:up_axis"])),
                    ontology.Property(**_p("satuan", "Satuan model", type_classes=["vulcan:model_unit"])),
                    ontology.Property(**_p("faskes", "Faskes")), ontology.Property(**_p("kelas_ruang", "Kelas ruang", "integer")),
                    ontology.Property(**_p("jumlah_bed", "Jumlah tempat tidur", "integer"))]))
    ontology.apply_edits([{"op": "create", "object_type_id": cad["id"], "primary_key": "RS01-L3-K3", "properties": {
        "id_ruang": "RS01-L3-K3", "nama": "Ruang Rawat Kelas III Lt. 3, RSUD Contoh Sejahtera (demo)", "berkas": item["id"], "up_axis": "Z", "satuan": "m",
        "faskes": "RS-01", "kelas_ruang": 3, "jumlah_bed": 6}}], source="demo-jkn-ontology")
    vulcan.setup(vulcan.SetupIn(cad_object_type_id=cad["id"], suffix=" (demo)"))
    vulcan.save("annotation", vulcan.SaveIn(cad_object_type_id=cad["id"], cad_primary_key="RS01-L3-K3", values={
        "annotation_title": "Klaim kelas I di ruang kelas III", "part_instance_id": "Bed-303", "annotation_intent": "danger",
        "annotation_content": "Demo: SEP 0301R0010926V000124 ditagih kelas I, log kamar menunjukkan Bed-303 (kelas III).",
        "annotation_attachment_x": 9.2, "annotation_attachment_y": 1.45, "annotation_attachment_z": 0.6, "annotation_sphere_size": 0.25}))
    vulcan.save("annotation", vulcan.SaveIn(cad_object_type_id=cad["id"], cad_primary_key="RS01-L3-K3", values={
        "annotation_title": "Kapasitas sesuai", "part_instance_id": "Nurse-station", "annotation_intent": "success",
        "annotation_content": "Demo: 6 tempat tidur, sesuai data kapasitas faskes.", "annotation_attachment_x": 10.9, "annotation_attachment_y": 4.0,
        "annotation_attachment_z": 1.1, "annotation_sphere_size": 0.2}))
    vulcan.save("measurement", vulcan.SaveIn(cad_object_type_id=cad["id"], cad_primary_key="RS01-L3-K3", values={"measurement_points": [0, 4, 0.05, 12, 4, 0.05]}))
    vulcan.save("section_plane", vulcan.SaveIn(cad_object_type_id=cad["id"], cad_primary_key="RS01-L3-K3", values={
        "section_plane_position": [6, 4, 1.5], "section_plane_quaternion": [0, 0, 0, 1]}))
    return {"cad_object_type_id": cad["id"], "file": item["id"]}


def _ensure_rujukan(fk: dict) -> Any:
    """A many-to-many link between facilities backed by the referral records (join table dataset)."""
    import demo_jkn
    import drive
    import ontology_link_datasets as lds
    import pipeline_datasets

    if any(x.get("display_name") == RUJUKAN for x in ontology._all("link-types")):
        return False
    lt = om.create_link_type(om.LinkTypeIn(
        display_name=RUJUKAN, kind="join_table", cardinality="many_to_many",
        source=om.LinkSide(object_type_id=fk["id"], display_name="Faskes tujuan rujukan", plural_display_name="Faskes tujuan rujukan", api_name="faskesTujuan"),
        target=om.LinkSide(object_type_id=fk["id"], display_name="Faskes perujuk", plural_display_name="Faskes perujuk", api_name="faskesPerujuk")))
    table = demo_jkn.generate()["rujukan"].select(["dari_faskes", "ke_faskes", "no_rujukan", "alasan_rujuk"])
    item = drive.save_bytes(drive.default_folder("ontology"), "Rujukan antar faskes (demo).parquet", pipeline_datasets._parquet_bytes(table), pipeline_datasets.PARQUET)
    return lds.set_datasource(lt["id"], lds.DatasourceIn(dataset_id=item["id"], source_column="dari_faskes", target_column="ke_faskes"))


def _ensure_drill(kl: dict) -> Any:
    """A validation drill with questions from the claim verification work, expected answers from the demo data."""
    import ontology_design as od

    if any(d["name"] == DRILL for d in od.list_drills()):
        return "kept"
    claims = [o.get("properties") or {} for o in ontology.stored_objects(kl["id"]).values()]
    flagged = [c for c in claims if c.get("kategori_risiko")]
    per = {}
    for c in flagged:
        per[c.get("faskes")] = per.get(c.get("faskes"), 0) + 1
    top = max(per, key=lambda k: per[k]) if per else ""
    long_stay = sum(1 for c in claims if (c.get("lama_rawat") or 0) > 10)
    excess = sum(max(0.0, (c.get("tarif_rs") or 0) - (c.get("tarif_inacbg") or 0)) for c in flagged if c.get("faskes") == top)
    d = od.create_drill(od.DrillIn(
        name=DRILL, format="quiz", time_limit_minutes=20, allowed_apps=["Object Explorer", "Object Views"],
        description="Uji apakah verifikator, tim medis dan agen AI bisa menemukan jawaban pertanyaan audit klaim FKRTL di ontologi "
                    "(masalah: Efisiensi Risiko pada Fasilitas Kesehatan). Mulai Team race di tab ini; data fiktif.",
        questions=[
            od.QuestionIn(text="Faskes mana (kode faskes) yang punya klaim berisiko (kategori risiko terisi) paling banyak?", step="situation", points=3,
                          expected_answer=str(top or ""), source="Rapat mingguan tim anti-fraud"),
            od.QuestionIn(text="Berapa klaim dengan lama rawat lebih dari 10 hari?", step="factors", points=2,
                          expected_answer=str(long_stay), source="Indikasi prolonged LOS (subkategori lama rawat)"),
            od.QuestionIn(text=f"Berapa total selisih tarif RS di atas tarif INA-CBG untuk klaim berisiko di {top or 'faskes itu'} (Rp, dibulatkan)?",
                          step="impact", points=5, expected_answer=f"{round(excess):,}".replace(",", "."), source="Estimasi potensi kerugian"),
        ]))
    return d["id"]


DERET_WAKTU = "Faskes JKN – deret waktu (demo)"
LINK_KLAIM_TARIF = "Klaim dibayar per tarif INA-CBG (demo)"
LINK_DERET_WAKTU = "Deret waktu faskes (demo)"


def _ensure_relasi_tarif() -> dict:
    """Connect the two isolated types: every INA-CBG base code a claim is paid under has a Tarif INA-CBG object (the
    outpatient groups and the caesarean group of case 15 were missing: added to its backing datasets from the demo's
    own constants — never to the rules' tariff table), each claim carries its base code (kode_dasar_inacbg = kode_inacbg
    without the severity suffix), and two link types join them: Klaim → Tarif INA-CBG (N:1) and Faskes JKN – deret waktu
    → Faskes JKN (1:1)."""
    import io

    import drive
    import ontology_datasources
    import ontology_model as om
    import pipeline_datasets
    import pyarrow as pa
    import pyarrow.parquet as pq

    import demo_jkn

    out: dict[str, Any] = {}
    kl, tf, fk, dw = _type(KLAIM), _type(TARIF), _type(FASKES), _type(DERET_WAKTU)
    # 1. the claims' base code
    if kl:
        with ontology._lock:
            rec = ontology._object_type(kl["id"])
            if not any(p["api_name"] == "kode_dasar_inacbg" for p in rec["properties"]):
                props = [ontology.Property(**p) for p in rec["properties"]] + [ontology.Property(**_p("kode_dasar_inacbg", "Kode dasar INA-CBG"))]
                ontology.update_object_type(kl["id"], ontology.ObjectTypeIn(properties=props))
                out["property"] = "kode_dasar_inacbg"
        objs = ontology.load_objects(kl["id"])
        changed = []
        for pk, o in objs.items():
            props = o.setdefault("properties", {})
            base = str(props.get("kode_inacbg") or "").rsplit("-", 1)[0] or None
            if base and props.get("kode_dasar_inacbg") != base:
                props["kode_dasar_inacbg"] = base
                changed.append(pk)
        if changed:
            ontology.save_objects(kl["id"], objs, changed=changed)
        out["claims_coded"] = len(changed)
        used = sorted({str((o.get("properties") or {}).get("kode_dasar_inacbg")) for o in objs.values() if (o.get("properties") or {}).get("kode_dasar_inacbg")})
    else:
        used = []
    # 2. a Tarif INA-CBG object for every base code the claims use (from the demo's constants)
    if tf and (tf.get("backing_dataset") or {}).get("dataset_id"):
        known = {g[0]: g for g in demo_jkn.RI_GROUPS + [demo_jkn.SC_GROUP]}
        known_rj = {g[0]: g for g in demo_jkn.RJ_GROUPS}
        item = drive._item(tf["backing_dataset"]["dataset_id"])
        rows = pq.read_table(io.BytesIO(drive.read_bytes(item))).to_pylist()
        have = {r["kode_dasar"] for r in rows}
        add = []
        for code in used:
            if code in have:
                continue
            if code in known:
                g = known[code]
                add.append({"kode_dasar": code, "deskripsi": g[1], "tarif_i": float(g[3]), "tarif_ii": float(g[4]), "tarif_iii": float(g[5])})
            elif code in known_rj:  # outpatient: one tariff whatever the class
                g = known_rj[code]
                add.append({"kode_dasar": code, "deskripsi": f"{g[1]} (rawat jalan)", "tarif_i": float(g[2]), "tarif_ii": float(g[2]), "tarif_iii": float(g[2])})
        if add:
            table = pa.Table.from_pylist(rows + add, schema=pq.read_table(io.BytesIO(drive.read_bytes(item))).schema)
            pipeline_datasets._replace_content(item, pipeline_datasets._parquet_bytes(table))
            # the case-weight datasource (multi-datasource type) gets the new codes too, by the same formula
            for extra in tf.get("additional_datasources") or []:
                xitem = drive._item(extra["dataset_id"])
                xt = pq.read_table(io.BytesIO(drive.read_bytes(xitem)))
                xrows = xt.to_pylist()
                xhave = {r["kode"] for r in xrows}
                xrows += [{"kode": r["kode_dasar"], "bobot_kasus": round(1 + (sum(map(ord, r["kode_dasar"])) % 17) / 10, 2),
                           # outpatient groups have no length of stay
                           "rata_rata_los": 0 if r["kode_dasar"] in known_rj else 3 + (sum(map(ord, r["kode_dasar"])) % 5)} for r in add if r["kode_dasar"] not in xhave]
                pipeline_datasets._replace_content(xitem, pipeline_datasets._parquet_bytes(pa.Table.from_pylist(xrows, schema=xt.schema)))
            ontology_datasources.reindex(tf["id"])
        out["tarif_added"] = [r["kode_dasar"] for r in add]
    # 3. the link types
    have_links = {x.get("display_name") for x in ontology._all("link-types")}
    if kl and tf and LINK_KLAIM_TARIF not in have_links:
        om.create_link_type(om.LinkTypeIn(
            display_name=LINK_KLAIM_TARIF, kind="foreign_key", cardinality="many_to_one", foreign_key="kode_dasar_inacbg",
            description="Klaim dibayar menurut kelompok INA-CBG dasarnya (kode INA-CBG tanpa sufiks tingkat keparahan).",
            source=om.LinkSide(object_type_id=kl["id"], display_name="Klaim", plural_display_name="Klaim"),
            target=om.LinkSide(object_type_id=tf["id"], display_name="Tarif INA-CBG")))
        out.setdefault("links", []).append(LINK_KLAIM_TARIF)
    if dw and fk and LINK_DERET_WAKTU not in have_links:
        om.create_link_type(om.LinkTypeIn(
            display_name=LINK_DERET_WAKTU, kind="foreign_key", cardinality="one_to_one", foreign_key="kode",
            description="Deret waktu klaim harian dan selisih tarif milik satu faskes (kode faskes yang sama).",
            source=om.LinkSide(object_type_id=dw["id"], display_name="Deret waktu"),
            target=om.LinkSide(object_type_id=fk["id"], display_name="Faskes")))
        out.setdefault("links", []).append(LINK_DERET_WAKTU)
    return out


def _ensure_mdo() -> Any:
    """Tarif INA-CBG (demo) as a multi-datasource object type: case weights and average length of stay per base code."""
    import drive
    import ontology_mdo
    import pipeline_datasets
    import pyarrow as pa

    t = _type(TARIF)
    if not t or t.get("additional_datasources"):
        return False
    rows = ontology.stored_objects(t["id"])
    codes = sorted(rows)
    weights = {c: round(1 + (sum(map(ord, c)) % 17) / 10, 2) for c in codes}
    table = pa.table({"kode": codes, "bobot_kasus": [weights[c] for c in codes], "rata_rata_los": [3 + (sum(map(ord, c)) % 5) for c in codes]})
    item = drive.save_bytes(drive.default_folder("ontology"), "Bobot kasus INA-CBG (demo).parquet", pipeline_datasets._parquet_bytes(table), pipeline_datasets.PARQUET)
    return ontology_mdo.add_datasource(t["id"], ontology_mdo.ExtraIn(dataset_id=item["id"], pk_column="kode",
                                                                     columns={"bobot_kasus": "bobot_kasus", "rata_rata_los": "rata_rata_los"}))["reindex"]


@router.post("")
def build() -> dict:
    """Build (or complete) the Ontology demo; nothing existing is changed or deleted."""
    with ontology._lock:
        fk, kl, lt = _ensure_types()
        added = _ensure_objects(fk, kl)
        acts = _ensure_actions(kl)
    scenarios = _ensure_scenarios(kl, acts)
    edits = _ensure_edits(kl, acts)
    with ontology._lock:
        vertex_made = _ensure_vertex(fk, kl, lt)
    try:
        mach = _ensure_machinery(kl, acts)
    except Exception as e:  # noqa: BLE001 - Files may be unavailable: the rest of the demo stands
        mach = f"not created: {getattr(e, 'detail', e)}"
    try:
        rules = _ensure_rules(kl)
    except Exception as e:  # noqa: BLE001 - Files may be unavailable: the rest of the demo stands
        rules = f"not created: {getattr(e, 'detail', e)}"
    try:
        sched = _ensure_scheduling(kl)
    except Exception as e:  # noqa: BLE001 - the rest of the demo stands
        sched = f"not created: {getattr(e, 'detail', e)}"
    try:
        views = _ensure_object_view(kl)
    except Exception as e:  # noqa: BLE001 - the rest of the demo stands
        views = f"not created: {getattr(e, 'detail', e)}"
    try:
        monitors = _ensure_monitors(kl)
    except Exception as e:  # noqa: BLE001 - the rest of the demo stands
        monitors = f"not created: {getattr(e, 'detail', e)}"
    try:
        vul = _ensure_vulcan()
    except Exception as e:  # noqa: BLE001 - Files may be unavailable: the rest of the demo stands
        vul = f"not created: {getattr(e, 'detail', e)}"
    try:
        rujukan = _ensure_rujukan(fk)
    except Exception as e:  # noqa: BLE001 - Files may be unavailable: the rest of the demo stands
        rujukan = f"not created: {getattr(e, 'detail', e)}"
    try:
        tarif = _ensure_tarif()
    except Exception as e:  # noqa: BLE001 - Files may be unavailable (no database): the rest of the demo stands
        tarif = f"not created: {e}"
    with ontology._lock:
        secured = _ensure_security(kl)
    try:
        embedded = _ensure_embeddings(kl)
    except Exception as e:  # noqa: BLE001 - no embedding key: the rest of the demo stands
        embedded = f"not embedded: {getattr(e, 'detail', e)}"
    try:
        drill = _ensure_drill(kl)
    except Exception as e:  # noqa: BLE001 - the rest of the demo stands
        drill = f"not created: {getattr(e, 'detail', e)}"
    try:
        mdo = _ensure_mdo()
    except Exception as e:  # noqa: BLE001 - Files may be unavailable: the rest of the demo stands
        mdo = f"not created: {getattr(e, 'detail', e)}"
    try:
        relasi = _ensure_relasi_tarif()
    except Exception as e:  # noqa: BLE001 - the rest of the demo stands
        relasi = f"not created: {getattr(e, 'detail', e)}"
    try:
        described = __import__("demo_jkn_descriptions").apply()
    except Exception as e:  # noqa: BLE001 - the rest of the demo stands
        described = f"not described: {getattr(e, 'detail', e)}"
    return {**status(), "relasi_tarif": relasi, "property_descriptions": described, "drill": drill, "mdo": mdo, "added_objects": added, "created_scenarios": scenarios, "security_added": secured, "edits_configured": edits, "tarif_created": tarif, "embedded": embedded, "vertex": vertex_made, "machinery": mach, "foundry_rules": rules, "scheduling": sched, "object_views": views, "monitors": monitors, "vulcan": vul, "rujukan": rujukan}


@router.get("")
def status() -> dict:
    import ontology_scenarios as sc

    fk, kl = _type(FASKES), _type(KLAIM)
    return {
        "faskes_type_id": fk and fk["id"], "klaim_type_id": kl and kl["id"],
        "objects": {"faskes": len(ontology.stored_objects(fk["id"])) if fk else 0, "klaim": len(ontology.stored_objects(kl["id"])) if kl else 0},
        "scenarios": [{"id": s["id"], "name": s["name"]} for s in sc.list_scenarios() if s["name"].startswith("Demo:")],
        "merge_action_id": (_action(MERGE) or {}).get("id"),
        "secured": bool(kl and kl.get("security")),
        "tarif_type_id": (_type(TARIF) or {}).get("id"),
        "materialized_dataset_id": ((kl or {}).get("edits_config") or {}).get("materialization", {}) and kl["edits_config"]["materialization"].get("dataset_id"),
    }
