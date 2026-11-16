"""Demo Grid: analytics apps on the grid Nexus and datasets (called by demo_grid_e2e.build).

- Foundry Rules: "Aturan susut grid — analis bisnis (demo)": point-and-click rules over Pelanggan and Gardu Distribusi
  objects that a loss analyst maintains without code (billing multiplier, a lost CT phase, a consumption drop with
  tamper events, a transformer with high non-technical losses); running the workflow writes their hits to a dataset.
  Rule changes go through proposals afterwards.
- Nexus Scenarios: three technical what-ifs on distribution transformers — load balancing (neutral current to 10%),
  transformer uprating (peak load to 60%), LV reconductoring (resistance to 55%) — each a persisted scenario in which an
  action rewrites the affected transformers' technical losses; compared with main (monthly loss value).
- Quiver: hourly load of the transformer with the highest non-technical losses against its feeder (SCADA), daily means
  and a 24-hour rolling mean; and a TM customer whose CT was tampered with (the drop in recorded power).
- Contour: losses per ULP and feeder (pivot, monthly trend), P2TL effectiveness by selection basis, findings' value by
  pattern — pinned to a dashboard.
"""

from __future__ import annotations

from typing import Any, Optional

RULES_WF = "Aturan susut grid — analis bisnis (demo)"
ACT_SIM = "Simulasikan perbaikan teknis gardu (demo)"
QUIVER_DT = "Demo: Beban gardu NTL tertinggi vs penyulang (grid)"
QUIVER_TM = "Demo: Daya pelanggan TM dengan CT dimanipulasi (grid)"
CONTOUR = "Demo: Analisis susut per ULP & efektivitas P2TL (grid)"
SCENARIOS = [
    ("balancing", "Skenario: penyeimbangan beban gardu fasa tak seimbang (demo)", "TL-02",
     "Arus netral diturunkan ke 10% arus fasa di gardu dengan temuan TL-02 (penyeimbangan beban antar-fasa)."),
    ("uprating", "Skenario: sisip / uprating trafo overload (demo)", "TL-01",
     "Beban puncak diturunkan ke 60% kVA di gardu overload (TL-01) dengan sisip trafo atau uprating."),
    ("rekonduktor", "Skenario: rekonduktor JTR panjang (demo)", "TL-03",
     "Resistansi JTR menjadi 55% (penampang lebih besar) di gardu dengan tegangan ujung rendah (TL-03)."),
]


def _objs(key: str) -> dict[str, dict]:
    import ontology

    import demo_grid_e2e as e

    t = e._type(key)
    return {pk: (o.get("properties") or {}) for pk, o in ontology.stored_objects(t["id"]).items()} if t else {}


# ------------------------------------------------------------------------------------------------
# Foundry Rules
# ------------------------------------------------------------------------------------------------

def _rules(state: dict) -> dict:
    import foundry_rules as fr
    import ontology

    import demo_grid_e2e as e

    pl, gd = e._type("pelanggan"), e._type("gardu")
    wf = next((w for w in ontology._all("foundry-rules") if w.get("name") == RULES_WF), None)
    fields = [fr.OutputField(name="kode_objek", required=True), fr.OutputField(name="kode_pola", static_values="selection",
                                                                                values=["NTL-02", "NTL-03", "NTL-05", "NTL-07"]),
              fr.OutputField(name="judul", template=True), fr.OutputField(name="skor", type="integer", static_values="range", min=0, max=100),
              fr.OutputField(name="bukti", template=True), fr.OutputField(name="kode_ulp")]
    spec = fr.WorkflowIn(name=RULES_WF, description="Demo: aturan susut yang dirawat analis tanpa kode, di atas objek Pelanggan dan Gardu Distribusi Nexus. "
                                                    "Hasil ditulis ke dataset; perubahan aturan lewat proposal dan review.",
                         inputs=[{"kind": "object_type", "id": pl["id"]}, {"kind": "object_type", "id": gd["id"]}],
                         outputs=[fr.WorkflowOutput(id="hasil", name="Hasil aturan susut", dataset_name="hasil_aturan_susut_foundry (demo)", fields=fields)],
                         custom_properties=[{"name": "tingkat", "type": "string", "values": ["Tinggi", "Sedang"]}],
                         require_proposals=False, schedule_minutes=1440)
    if not wf:
        wf = fr.create_workflow(spec)
    have = {r["name"] for r in ontology._all("foundry-rules-rules") if r.get("workflow_id") == wf["id"]}

    def out(pola: str, judul: str, skor: int, bukti: str, key: str) -> dict:
        return {"output_id": "hasil", "mapping": {"kode_objek": {"kind": "column", "column": key}, "kode_pola": {"kind": "static", "value": pola},
                                                  "judul": {"kind": "template", "value": judul}, "skor": {"kind": "static", "value": skor},
                                                  "bukti": {"kind": "template", "value": bukti}, "kode_ulp": {"kind": "column", "column": "kode_ulp"}}}

    P = {"kind": "object_type", "id": pl["id"]}
    G = {"kind": "object_type", "id": gd["id"]}
    rules = [
        ("FR-01 Faktor kali CT salah (TM)", "Pelanggan TM yang kWh tagihannya < 85% kWh AMR.", "Tinggi",
         {"input": P, "blocks": [{"kind": "filter", "combine": "all", "conditions": [{"column": "tegangan", "op": "eq", "value": "TM"},
                                                                                     {"column": "rasio_tagih_vs_amr", "op": "lt", "value": 0.85}]}],
          "output": out("NTL-05", "{id_pelanggan}: tagihan di bawah AMR", 90, "Tagihan = {rasio_tagih_vs_amr} × kWh AMR ({golongan})", "id_pelanggan")}),
        ("FR-02 Satu fasa CT hilang (TM)", "Pelanggan TM dengan rasio arus fasa terkecil < 0,4.", "Tinggi",
         {"input": P, "blocks": [{"kind": "filter", "combine": "all", "conditions": [{"column": "tegangan", "op": "eq", "value": "TM"},
                                                                                     {"column": "rasio_arus_fasa_min", "op": "lt", "value": 0.4}]}],
          "output": out("NTL-07", "{id_pelanggan}: arus satu fasa hilang", 85, "Rasio arus fasa terkecil {rasio_arus_fasa_min}", "id_pelanggan")}),
        ("FR-03 Turun tajam + event tamper (TR)", "Pelanggan TR yang pemakaiannya turun ≥ 40% dan punya event magnet/tutup terminal.", "Tinggi",
         {"input": P, "blocks": [{"kind": "filter", "combine": "all", "conditions": [{"column": "tegangan", "op": "eq", "value": "TR"},
                                                                                     {"column": "perubahan_pct", "op": "lte", "value": -40},
                                                                                     {"column": "event_tamper", "op": "gte", "value": 1}]}],
          "output": out("NTL-02", "{id_pelanggan}: turun {perubahan_pct}% dengan event tamper", 80, "{event_tamper} event tamper; Q2 {kwh_bulan_q2} → Q3 {kwh_bulan_q3} kWh/bln",
                        "id_pelanggan")}),
        ("FR-04 Gardu dengan NTL > 8%", "Gardu distribusi yang susut non-teknisnya di atas 8% (Jul–Sep).", "Sedang",
         {"input": G, "blocks": [{"kind": "filter", "combine": "all", "conditions": [{"column": "susut_non_teknis_pct", "op": "gt", "value": 8}]}],
          "output": out("NTL-03", "{kode_dt}: NTL {susut_non_teknis_pct}%", 70, "Susut {susut_pct}% (teknis {susut_teknis_pct}%), {jumlah_temuan} temuan pelanggan", "kode_dt")}),
    ]
    made = []
    for name, desc, tingkat, logic in rules:
        if name in have:
            continue
        fr.propose_create(fr.RuleIn(workflow_id=wf["id"], name=name, description=desc, custom={"tingkat": tingkat}, logic=logic))
        made.append(name)
    run = fr.run_workflow(wf["id"])
    # from now on a rule change is a proposal a reviewer approves
    if not wf.get("require_proposals"):
        fr.save_workflow(wf["id"], fr.WorkflowIn(**{**spec.model_dump(), "require_proposals": True}))
    # FR-03 finds nothing: the magnets went on before Q2, so the drop Q2 → Q3 is small; the analyst proposes repeated
    # tamper events instead, which waits for a reviewer
    r3 = next((r for r in fr.list_rules(wf["id"]) if r["name"].startswith("FR-03")), None)
    open_ = {p.get("rule_id") for p in fr.list_proposals(wf["id"], "open")}
    if r3 and r3["id"] not in open_ and any(c.get("column") == "perubahan_pct" for b in r3["logic"]["blocks"] for c in b.get("conditions") or []):
        logic = {**r3["logic"], "blocks": [{"kind": "filter", "combine": "all", "conditions": [{"column": "tegangan", "op": "eq", "value": "TR"},
                                                                                              {"column": "event_tamper", "op": "gte", "value": 3}]}]}
        logic["output"]["mapping"]["judul"] = {"kind": "template", "value": "{id_pelanggan}: {event_tamper} event magnet / tutup terminal"}
        fr.propose_edit(r3["id"], fr.RuleIn(workflow_id=wf["id"], name="FR-03 Event tamper berulang (TR)", custom=r3.get("custom") or {},
                                            description="Pelanggan TR dengan ≥ 3 event magnet / tutup terminal (AMI), apa pun perubahan pemakaiannya.",
                                            logic=logic, version=r3.get("version")))
    state["rules_workflow"] = wf["id"]
    return {"workflow": wf["id"], "made": made, "run": {"rules": [(r["rule"], r["rows"], r["status"]) for r in run["rules"]], "outputs": run["outputs"]}}


# ------------------------------------------------------------------------------------------------
# Nexus Scenarios: technical what-ifs on distribution transformers
# ------------------------------------------------------------------------------------------------

def _what_if(kind: str, g: dict) -> dict:
    """New technical-loss figures of a transformer after the intervention (the same physics as the losses pipeline:
    I²R with the unbalance factor 1 + 1,6·(In/I)², the copper loss with the square of the loading; ~75% of TL in the LV)."""
    kwh = float(g.get("kwh_keluar_q3") or 0)
    tl, s = float(g.get("susut_teknis_pct") or 0), float(g.get("susut_pct") or 0)
    n, load = float(g.get("rasio_arus_netral") or 0.15), float(g.get("beban_puncak_pct") or 60) / 100
    jtr = tl * 0.75
    if kind == "balancing":
        save = jtr * (1 - (1 + 1.6 * 0.01) / (1 + 1.6 * n * n))
        extra = {"rasio_arus_netral": 0.1}
    elif kind == "uprating":
        save = (jtr + tl * 0.25) * max(0.0, 1 - (0.6 / load) ** 2) if load > 0.6 else 0.0
        extra = {"beban_puncak_pct": 60.0}
    else:
        save = jtr * 0.45
        extra = {}
    new_tl, new_s = round(max(0.0, tl - save), 2), round(max(0.0, s - save), 2)
    return {"susut_teknis_pct": new_tl, "susut_pct": new_s, "nilai_susut_rp_bulan": round(new_s / 100 * kwh / 3 * 1444.70, 0), **extra,
            "catatan_teknis": f"Skenario {kind}: susut teknis {tl}% → {new_tl}% (hemat {round(save, 2)} poin, ±{round(save / 100 * kwh / 3):,} kWh/bln)"}


def _scenarios(state: dict) -> dict:
    import ontology
    import ontology_scenarios as osc

    import demo_grid_e2e as e

    gd = e._type("gardu")
    props = {p["api_name"]: p for p in ontology._object_type(gd["id"])["properties"]}
    act = e._action(ACT_SIM)
    if not act:
        params = ["susut_teknis_pct", "susut_pct", "nilai_susut_rp_bulan", "rasio_arus_netral", "beban_puncak_pct", "catatan_teknis"]
        act = ontology.create_action_type(ontology.ActionTypeIn(
            display_name=ACT_SIM, object_type_id=gd["id"], kind="modify", status="active",
            description="Untuk Nexus Scenarios: tulis angka susut gardu setelah perbaikan teknis (penyeimbangan, uprating, rekonduktor) — dipakai di skenario, "
                        "bukan di data utama.",
            parameters=[ontology.Parameter(id="object", display_name="Gardu distribusi", type="object", required=True)]
            + [ontology.Parameter(id=p, display_name=props[p]["display_name"], type=props[p]["type"], property=p, required=False) for p in params if p in props]))
    temuan = _objs("temuan")
    gardu = _objs("gardu")
    have = {s["name"]: s for s in osc.list_scenarios()}
    ids = dict(state.get("scenarios") or {})
    out = {}
    for kind, name, pola, desc in SCENARIOS:
        targets = sorted({t.get("kode_dt") for t in temuan.values() if t.get("kode_pola_dugaan") == pola and t.get("kode_dt")}
                         | {t.get("kode_objek") for t in temuan.values() if pola in (t.get("semua_aturan") or "") and t.get("jenis_objek") == "Gardu distribusi"})
        targets = [k for k in targets if k in gardu]
        sid = ids.get(kind) or (have.get(name) or {}).get("id")
        if not sid:
            sc = osc.create_scenario(osc.ScenarioIn(name=name, description=desc, persisted=True))
            sid = sc["id"]
            for pk in targets:
                vals = {k: v for k, v in _what_if(kind, gardu[pk]).items() if k in props}
                osc.apply_in_scenario(sid, act["id"], osc.ApplyIn(parameters={"object": pk, **vals}))
            ids[kind] = sid
        out[kind] = {"id": sid, "gardu": len(targets)}
    state["scenarios"] = ids
    cmp = osc.compare(osc.CompareIn(scenario_ids=list(ids.values()), include_main=True, object_type_id=gd["id"], metric="sum", property="nilai_susut_rp_bulan"))
    state["scenario_compare"] = [{"name": c["name"], "scenario_id": c["scenario_id"], "nilai_susut_rp_bulan": (c["aggregation"].get("value")
                                  if isinstance(c.get("aggregation"), dict) else None) or sum((c.get("values") or {}).values())} for c in cmp["columns"]]
    return {"scenarios": out, "compare": state["scenario_compare"]}


# ------------------------------------------------------------------------------------------------
# Quiver
# ------------------------------------------------------------------------------------------------

def _quiver(state: dict) -> dict:
    import ts_derived as tsd

    import demo_grid_e2e as e

    have = {a["name"]: a["id"] for a in tsd.list_analyses()}
    out = {}
    gd, py, pl = e._type("gardu"), e._type("penyulang"), e._type("pelanggan")
    gardu = _objs("gardu")
    worst = max(gardu.items(), key=lambda kv: float(kv[1].get("susut_non_teknis_pct") or 0))
    rng = {"start": "2026-07-01T00:00:00+07:00", "end": "2026-09-30T23:00:00+07:00"}
    if QUIVER_DT not in have:
        dt_obj = {"object_type_id": gd["id"], "primary_key": worst[0]}
        fd_obj = {"object_type_id": py["id"], "primary_key": worst[1]["kode_penyulang"]}
        cards = [
            {"id": "A", "type": "tsp", "title": f"Beban {worst[0]} (kVA, AMR)", "config": {"property": "seri_beban", "object": dt_obj}},
            {"id": "B", "type": "rolling", "title": "Rata-rata 24 jam", "config": {"input": "A", "aggregation": "mean", "window": "24h"}},
            {"id": "C", "type": "periodic", "title": "Puncak harian", "config": {"input": "A", "aggregation": "max", "period": "1d"}},
            {"id": "D", "type": "tsp", "title": f"Daya penyulang {worst[1]['kode_penyulang']} (kW, SCADA)", "config": {"property": "seri_beban", "object": fd_obj}},
            {"id": "E", "type": "periodic", "title": "Rata-rata harian penyulang", "config": {"input": "D", "aggregation": "mean", "period": "1d"}},
        ]
        a = tsd.create_analysis(tsd.AnalysisIn(
            name=QUIVER_DT, description=f"Demo: gardu dengan susut non-teknis tertinggi ({worst[0]}, NTL {worst[1].get('susut_non_teknis_pct')}%) — beban per jam, "
                                        "rata-rata 24 jam dan puncak harian, dibanding daya penyulangnya dari SCADA. Beban malam yang tetap tinggi = sambungan liar.",
            logic={"cards": cards}, root=tsd.T.ObjRef(**dt_obj), range=rng,
            plots=[{"id": "p1", "title": "Beban gardu", "cards": ["A", "B", "C"]}, {"id": "p2", "title": "Penyulang (SCADA)", "cards": ["E"]}],
            dashboard={"cards": ["p1", "p2"], "inputs": []}))
        have[QUIVER_DT] = a["id"]
    out["gardu"] = have[QUIVER_DT]
    if QUIVER_TM not in have:
        temuan = _objs("temuan")
        tm = next((t["kode_objek"] for t in sorted(temuan.values(), key=lambda t: -float(t.get("nilai_harapan_rp") or 0))
                   if t.get("kode_pola_dugaan") == "NTL-07"), None)
        if tm:
            obj = {"object_type_id": pl["id"], "primary_key": tm}
            cards = [{"id": "A", "type": "tsp", "title": f"Daya AMR {tm} (kW)", "config": {"property": "seri_beban", "object": obj}},
                     {"id": "B", "type": "periodic", "title": "Energi harian (rata-rata kW)", "config": {"input": "A", "aggregation": "mean", "period": "1d"}}]
            a = tsd.create_analysis(tsd.AnalysisIn(
                name=QUIVER_TM, description=f"Demo: pelanggan TM {tm} dengan temuan NTL-07 (CT/PT) — daya yang tercatat AMR per jam dan per hari; "
                                            "penurunan ±⅓ sejak manipulasi.", logic={"cards": cards}, root=tsd.T.ObjRef(**obj), range=rng,
                plots=[{"id": "p1", "title": "Daya tercatat AMR", "cards": ["A", "B"]}], dashboard={"cards": ["p1"], "inputs": []}))
            have[QUIVER_TM] = a["id"]
    out["tm"] = have.get(QUIVER_TM)
    state["quiver"] = out
    return out


# ------------------------------------------------------------------------------------------------
# Contour
# ------------------------------------------------------------------------------------------------

def _contour(state: dict) -> Optional[str]:
    import contour
    import drive

    import demo_grid_e2e as e

    project = e._folder(None, e.PROJECT, "project")
    apps = e._folder(project, "apps")
    item = next((f for f in drive.list_files(apps) if f["name"] == f"{CONTOUR}.contour" and not f.get("trashed_at")), None)
    view = contour.get_analysis(item["id"]) if item else contour.create_analysis(contour.NewIn(title=CONTOUR, parent_id=apps))
    a = {**view["analysis"], "id": view["item"]["id"]}
    state["contour"] = a["id"]
    if a.get("paths"):
        return a["id"]
    susut = e._folder(project, "susut")
    files = {f["name"]: f["id"] for f in drive.list_files(susut) if not f.get("trashed_at")}
    paths = [
        {"id": "p_neraca", "name": "Neraca penyulang bulanan", "source": {"kind": "dataset", "id": files["neraca_penyulang_bulanan.parquet"]}, "boards": [
            {"id": "b_pivot", "type": "pivot", "title": "Susut per ULP (kWh, Apr–Sep)",
             "config": {"rows": ["kode_ulp"], "values": [{"metric": "sum", "column": "kwh_kirim", "name": "kwh_kirim"},
                                                         {"metric": "sum", "column": "susut_teknis_kwh", "name": "susut_teknis_kwh"},
                                                         {"metric": "sum", "column": "susut_non_teknis_kwh", "name": "susut_non_teknis_kwh"}]}},
            {"id": "b_tren", "type": "chart", "title": "Susut (%) per bulan per ULP", "config": {"kind": "line", "x": "bulan", "series": "kode_ulp",
                                                                                                   "metric": "avg", "metric_column": "susut_pct"}},
            {"id": "b_tabel", "type": "table", "title": "Penyulang", "config": {"columns": ["kode_penyulang", "bulan", "susut_pct", "susut_teknis_pct",
                                                                                            "susut_non_teknis_pct", "pf_rata"], "sort": "susut_pct", "descending": True}}]},
        {"id": "p_p2tl", "name": "Efektivitas P2TL", "source": {"kind": "dataset", "id": files["p2tl_bersih.parquet"]}, "boards": [
            {"id": "b_p2tl", "type": "pivot", "title": "Pemeriksaan, temuan dan tagihan susulan per dasar pemilihan",
             "config": {"rows": ["dasar_pemilihan"], "values": [{"metric": "count", "name": "pemeriksaan"},
                                                                {"metric": "sum", "column": "ditemukan_pelanggaran", "name": "temuan"},
                                                                {"metric": "sum", "column": "rp_tagihan_susulan", "name": "rp_tagihan_susulan"}]}},
            {"id": "b_seg", "type": "chart", "title": "Temuan P2TL per segmen", "config": {"kind": "bar", "x": "segmen", "metric": "sum",
                                                                                            "metric_column": "ditemukan_pelanggaran"}}]},
        {"id": "p_temuan", "name": "Temuan susut", "source": {"kind": "dataset", "id": files["temuan_susut.parquet"]}, "boards": [
            {"id": "b_pola", "type": "histogram", "title": "Nilai harapan per pola dugaan", "config": {"column": "kode_pola_dugaan", "metric": "sum",
                                                                                                         "metric_column": "nilai_harapan_rp"}}]},
    ]
    body = {**{k: v for k, v in a.items() if k in ("title", "parameters", "rev")}, "paths": paths,
            "dashboard": {"tabs": [{"id": "tab1", "name": "Susut & P2TL", "items": [{"kind": "board", "path": p["id"], "board": b["id"], "width": "half"}
                                                                                   for p in paths for b in p["boards"] if b["type"] != "table"]}]}}
    contour.save_analysis(a["id"], contour.SaveIn(analysis=body))
    state["contour"] = a["id"]
    return a["id"]


def build(state: dict, save) -> dict:
    out: dict[str, Any] = {}
    for key, fn in (("rules", lambda: _rules(state)), ("scenarios", lambda: _scenarios(state)), ("quiver", lambda: _quiver(state)), ("contour", lambda: _contour(state))):
        try:
            out[key] = fn()
        except Exception as ex:  # noqa: BLE001
            out[f"{key}_error"] = str(getattr(ex, "detail", ex))[:500]
        save()
    return out
