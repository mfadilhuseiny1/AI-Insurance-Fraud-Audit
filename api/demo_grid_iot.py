"""Demo Grid: hourly load as time series, sensor object types and Device and Machinery (called by demo_grid_e2e.build).

- Raw (Files raw/iot): hourly load Jul–Sep 2026 as the head-ends export it — feeder active power from the SCADA
  historian (NUSAGRID tags DEG.GI01.20KV.Fxx.M.P and the city RTU's), distribution-transformer apparent power from the
  AMR gateways, TM customers' active power from their AMR meters (what the meter records: a shunted CT shows less).
  Generated from the same simulation as the daily data (demo_grid_data.simulate), shaped by each profile's hourly curve
  (NUSAGRID's load profiles for the estate tenants), illegal connections at night on the transformers.
- "Pipeline beban per jam grid (demo)": cleans the readings (kW/kVA, epoch seconds), derives each transformer's
  loading state per hour (Normal < 80 % kVA ≤ Beban tinggi ≤ 100 % < Overload) and its changes (the Device and
  Machinery changelog), and daily peaks.
- Time Series Catalog: one sync per head-end; Penyulang, Gardu Distribusi and Pelanggan (TM) become sensor object
  types (series id property `seri_beban`, from a second datasource) of their parents.
- Device and Machinery: the transformers' loading states from the changelog, and the loss findings' workflow (from the
  actions' edits).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

PIPELINE = "Pipeline beban per jam grid (demo)"
VERSION = 2  # bump to regenerate the pipeline file from the spec
MACHINERY = "Device and Machinery — gardu distribusi grid (demo)"
SYNCS = {"penyulang": "Beban penyulang per jam (SCADA, demo)", "gardu": "Beban gardu distribusi per jam (AMR, demo)",
         "tm": "Beban pelanggan TM per jam (AMR, demo)"}
WIB = timezone(timedelta(hours=7))


def _smooth(h: float, a: float, b: float, w: float = 0.75) -> float:
    return 1 / (1 + math.exp(-(h - a) / w)) - 1 / (1 + math.exp(-(h - b) / w))


def shape(profile: str, weekday: int) -> list[float]:
    """24 hourly weights (sum 1) per profile; the estate's industrial curves follow NUSAGRID's loadFactor()."""
    wk = weekday >= 5
    out = []
    for hh in range(24):
        h = hh + 0.5
        if profile == "industri_3shift":
            v = 0.82 + 0.05 * math.sin((h - 3) / 24 * 2 * math.pi) - (0.1 if wk else 0)
        elif profile == "industri_1shift":
            v = (0.25 if wk else 0.3) + (0.1 if wk else 0.7) * _smooth(h, 7.5, 17) - 0.08 * _smooth(h, 12, 13)
        elif profile == "komersial":
            v = 0.3 + 0.62 * _smooth(h, 8, 21)
        elif profile == "gudang":
            v = 0.35 + 0.4 * _smooth(h, 6, 22) - (0.15 if wk else 0)
        elif profile == "lembaga":
            v = 0.15 + (0.1 if wk else 0.75) * _smooth(h, 7, 16)
        elif profile == "kripto":
            v = 1.0
        elif profile == "pju":
            v = 1.0 if (h >= 18 or h < 6) else 0.02
        else:  # households and small business on the LV network: evening peak
            v = 0.35 + 0.15 * _smooth(h, 5, 8) + 0.55 * _smooth(h, 17.5, 22) + 0.1 * _smooth(h, 10, 15)
        out.append(max(0.01, v))
    s = sum(out)
    return [v / s for v in out]


def generate() -> dict[str, list[dict]]:
    import demo_grid_data as gd

    sim = gd.simulate()
    net = gd.network()
    cs = gd.customers()
    k0 = gd.DAYS.index(gd.AMI_START)
    days = gd.DAYS[k0:]
    out: dict[str, list[dict]] = {"scada_daya_penyulang_per_jam": [], "amr_beban_gardu_per_jam": [], "amr_daya_tm_per_jam": []}
    for f in net["feeders"]:
        prof = "industri_3shift" if f["kode_gi"] == gd.GI_A["kode"] else "rumah"
        rnd = gd._r("h:" + f["kode"])
        for k, d in enumerate(days):
            sh = shape(prof, d.weekday())
            if f["kode_gi"] == gd.GI_A["kode"]:
                sh = [0.5 * a + 0.5 * b for a, b in zip(sh, shape("industri_1shift", d.weekday()))]
            e = sim["feeders"][f["kode"]][k0 + k]["kwh"]
            for h in range(24):
                ts = int(datetime(d.year, d.month, d.day, h, tzinfo=WIB).timestamp())
                out["scada_daya_penyulang_per_jam"].append({"tag": f["tag_p"], "kode_penyulang": f["kode"], "waktu": f"{d.isoformat()} {h:02d}:00",
                                                            "ts": ts, "p_mw": round(e * sh[h] / 1000 * rnd.uniform(0.97, 1.03), 4), "kualitas": "valid"})
    lv_by_dt: dict[str, list[dict]] = {}
    for c in cs:
        if c["kode_dt"]:
            lv_by_dt.setdefault(c["kode_dt"], []).append(c)
    for dt in net["dts"]:
        rnd = gd._r("h:" + dt["kode_dt"])
        for k, d in enumerate(days):
            r = sim["dts"][dt["kode_dt"]][k0 + k]
            base = shape("rumah", d.weekday())
            illegal = r["illegal"]
            for h in range(24):
                ts = int(datetime(d.year, d.month, d.day, h, tzinfo=WIB).timestamp())
                night = illegal / 12 if (h >= 18 or h < 6) else 0.0
                kw = (r["kwh_keluar"] - illegal) * base[h] + night
                out["amr_beban_gardu_per_jam"].append({"kode_dt": dt["kode_dt"], "waktu": f"{d.isoformat()} {h:02d}:00", "ts": ts,
                                                       "kva": round(kw / 0.9 * rnd.uniform(0.96, 1.04), 2), "kva_terpasang": dt["kva"]})
    for c in cs:
        if c["tegangan"] != "TM":
            continue
        rnd = gd._r("h:" + c["id_pelanggan"])
        for k, d in enumerate(days):
            r = sim["customers"][c["id_pelanggan"]][k0 + k]
            sh = shape(c["profil"], d.weekday())
            for h in range(24):
                ts = int(datetime(d.year, d.month, d.day, h, tzinfo=WIB).timestamp())
                out["amr_daya_tm_per_jam"].append({"id_meter": f"AMR-{c['id_pelanggan']}", "id_pelanggan": c["id_pelanggan"], "waktu": f"{d.isoformat()} {h:02d}:00",
                                                   "ts": ts, "kw": round(r["metered"] * sh[h] * rnd.uniform(0.95, 1.05), 2)})
    return out


SQL_PNY = """-- Daya penyulang per jam dari historian SCADA: MW → kW, hanya bacaan berkualitas valid; seri = kode penyulang.
SELECT kode_penyulang AS seri, kode_penyulang, tag, ts, waktu, ROUND(p_mw * 1000, 1) AS kw
FROM input WHERE kualitas = 'valid'"""

SQL_DT = """-- Beban gardu distribusi per jam (AMR): kVA dan persentase terhadap kVA terpasang, status beban per jam.
SELECT kode_dt AS seri, kode_dt, ts, waktu, kva, kva_terpasang, ROUND(100.0 * kva / kva_terpasang, 1) AS beban_pct,
       CASE WHEN kva > kva_terpasang THEN 'Overload' WHEN kva > 0.8 * kva_terpasang THEN 'Beban tinggi' ELSE 'Normal' END AS status_beban
FROM input"""

SQL_TM = """-- Daya pelanggan TM per jam (AMR): seri = ID pelanggan (meter AMR tercatat di master).
SELECT id_pelanggan AS seri, id_pelanggan, id_meter, ts, waktu, kw FROM input"""

SQL_TRANSISI = """-- Perubahan status beban gardu (changelog Device and Machinery): satu baris tiap status berubah; processId = gardu.
WITH l AS (SELECT *, LAG(status_beban) OVER (PARTITION BY kode_dt ORDER BY ts) AS sebelum FROM input)
SELECT kode_dt || '-' || ts AS id_perubahan, kode_dt AS processId, status_beban AS state, REPLACE(waktu, ' ', 'T') || ':00+07:00' AS timestamp,
       ts, kode_dt, sebelum AS state_sebelum, kva, beban_pct
FROM l WHERE sebelum IS NULL OR sebelum <> status_beban"""

SQL_PUNCAK = """-- Puncak harian per gardu: kVA tertinggi, jam terjadinya, jam overload dan beban tinggi.
WITH r AS (
  SELECT kode_dt, SUBSTR(waktu, 1, 10) AS tanggal, kva, beban_pct, SUBSTR(waktu, 12, 5) AS jam, status_beban,
         ROW_NUMBER() OVER (PARTITION BY kode_dt, SUBSTR(waktu, 1, 10) ORDER BY kva DESC) AS rk
  FROM input)
SELECT kode_dt, tanggal, MAX(CASE WHEN rk = 1 THEN kva END) AS kva_puncak, MAX(CASE WHEN rk = 1 THEN jam END) AS jam_puncak,
       MAX(beban_pct) AS beban_puncak_pct, SUM(CASE WHEN status_beban = 'Overload' THEN 1 ELSE 0 END) AS jam_overload,
       SUM(CASE WHEN status_beban = 'Beban tinggi' THEN 1 ELSE 0 END) AS jam_beban_tinggi
FROM r GROUP BY kode_dt, tanggal ORDER BY kode_dt, tanggal"""

SQL_SERI_PNY = """-- Seri time series penyulang (datasource kedua Penyulang): id seri, nama sensor, satuan.
SELECT DISTINCT kode_penyulang AS kode_objek, kode_penyulang AS seri_beban, 'Daya ' || kode_penyulang AS nama_sensor, 'kW' AS satuan FROM input"""

SQL_SERI_DT = """-- Seri time series gardu distribusi (datasource kedua Gardu Distribusi).
SELECT DISTINCT kode_dt AS kode_objek, kode_dt AS seri_beban, 'Beban ' || kode_dt AS nama_sensor, 'kVA' AS satuan FROM input"""

SQL_SERI_TM = """-- Seri time series pelanggan TM (datasource kedua Pelanggan).
SELECT DISTINCT id_pelanggan AS kode_objek, id_pelanggan AS seri_beban, 'Daya AMR ' || id_pelanggan AS nama_sensor, 'kW' AS satuan FROM input"""


def nodes() -> list[dict]:
    S = lambda i, n, g, d: {"id": i, "kind": "source", "name": n, "group": g, "doc": d}  # noqa: E731
    T = lambda i, n, g, inp, sql: {"id": i, "kind": "sql", "name": n, "group": g, "input": inp, "sql": sql}  # noqa: E731
    return [
        S("s_pny", "scada_daya_penyulang_per_jam", "scada", "Historian SCADA: daya aktif penyulang per jam (NUSAGRID / RTU GI Kota)"),
        S("s_dt", "amr_beban_gardu_per_jam", "amr", "AMR gardu distribusi: kVA per jam"),
        S("s_tm", "amr_daya_tm_per_jam", "amr", "AMR pelanggan TM: kW per jam"),
        T("t_pny", "daya_penyulang_per_jam", "ts", "s_pny", SQL_PNY),
        T("t_dt", "beban_gardu_per_jam", "ts", "s_dt", SQL_DT),
        T("t_tm", "daya_tm_per_jam", "ts", "s_tm", SQL_TM),
        T("t_trans", "perubahan_status_gardu", "mesin", "t_dt", SQL_TRANSISI),
        T("t_puncak", "puncak_harian_gardu", "mesin", "t_dt", SQL_PUNCAK),
        T("t_seri_p", "seri_beban_penyulang", "mesin", "t_pny", SQL_SERI_PNY),
        T("t_seri_d", "seri_beban_gardu", "mesin", "t_dt", SQL_SERI_DT),
        T("t_seri_t", "seri_beban_pelanggan_tm", "mesin", "t_tm", SQL_SERI_TM),
    ]


GROUPS = [("scada", "SCADA historian", "#c05621"), ("amr", "AMR head-end", "#2c9c9c"), ("ts", "Time series bersih", "#0ea5e9"),
          ("mesin", "Status, puncak & seri", "#6b46c1")]
OUTPUTS = [("daya_penyulang_per_jam", "t_pny"), ("beban_gardu_per_jam", "t_dt"), ("daya_tm_per_jam", "t_tm"), ("perubahan_status_gardu", "t_trans"),
           ("puncak_harian_gardu", "t_puncak"),
           ("seri_beban_penyulang", "t_seri_p"), ("seri_beban_gardu", "t_seri_d"), ("seri_beban_pelanggan_tm", "t_seri_t")]


def emulate(raw: dict[str, list[dict]]) -> dict[str, list[dict]]:
    import demo_jkn_pipeline as base

    rows = base.run(raw, nodes())
    by = {n["id"]: n["name"] for n in nodes()}
    return {name: rows[by[node]] for name, node in OUTPUTS}


def content(project: str, items: dict[str, str], previews: dict[str, list[dict]], folder: str, uid, schedule) -> tuple[dict, dict[str, str]]:
    import demo_grid_pipeline as gp
    import demo_jkn_pipeline as base

    now = datetime.now(timezone.utc).isoformat()
    ns = nodes()
    pos = gp.layout(ns, GROUPS)
    datasets, out_nodes = {}, []
    for n in ns:
        x, y = pos[n["id"]]
        b = {"id": n["id"], "name": n["name"], "x": x, "y": y, "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {project} / raw / iot / {n['name']}.parquet", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in base.schema_of(rows)], "rows": rows[:200], "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            out_nodes.append({**b, "kind": "source", "datasetId": ds, "description": n["doc"]})
        else:
            out_nodes.append({**b, "kind": "transform", "input": n["input"], "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}]})
    location = {"id": folder, "name": f"{project} / iot"}
    out_ids = {name: f"o_{node}" for name, node in OUTPUTS}
    xmax = max(x for x, _ in pos.values())
    outputs = [{"id": out_ids[name], "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": [{"id": uid(), "kind": "rowCount", "min": 1}], "x": xmax + 320, "y": pos[node][1]} for name, node in OUTPUTS]
    body = {"type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": out_nodes, "outputs": outputs,
            "legend": [{"id": f"lg-{g}", "name": nm, "hex": h} for g, nm, h in GROUPS], "location": location,
            "textNodes": [{"id": "note_ts", "x": 40, "y": -200, "w": 900, "h": 150, "color": "lg-ts",
                           "text": "Beban per jam Jul–Sep: daya penyulang (SCADA), kVA gardu (AMR), daya pelanggan TM (AMR) → seri time series (Time Series "
                                   "Catalog → objek sensor), status beban gardu per jam dan perubahannya (changelog Device and Machinery), puncak harian."}],
            "schedules": [schedule("iot", list(out_ids.values()))],
            "meta": {"version": VERSION, "description": "Demo: beban per jam penyulang, gardu distribusi dan pelanggan TM sebagai time series dan status mesin."}}
    return body, out_ids


def _sensor(type_id: str, root_id: str, fk: str, sync_id: str, unit: str) -> bool:
    import ontology
    import ts_ontology as tso

    rec = ontology._object_type(type_id)
    if ((rec.get("time_series") or {}).get("properties") or {}).get("seri_beban"):
        return False
    tso.add_tsp(type_id, tso.AddTsp(property="seri_beban", syncs=[sync_id], unit=tso.Formatting(value=unit), interpolation=tso.Formatting(value="LINEAR"),
                                    make_default=True, sensor=tso.SensorConfig(links=[tso.SensorLink(root_object_type_id=root_id, foreign_key=fk,
                                                                                                     sensor_name_property="nama_sensor")])))
    return True


STATUSES = ["Baru", "Diverifikasi", "Target P2TL", "Eskalasi", "Ditindaklanjuti", "Selesai", "Bukan pelanggaran"]


def _machinery(changelog_id: str) -> Any:
    import machinery as mc

    import demo_grid_e2e as e

    if any(r["name"] == MACHINERY for r in mc._all()):
        return None
    import ontology

    gd, tm = e._type("gardu"), e._type("temuan")
    with ontology._lock:
        rec = ontology._object_type(gd["id"])
        if not any(p["api_name"] == "status_beban" for p in rec["properties"]):
            rec["properties"].append({"api_name": "status_beban", "display_name": "Status beban (jam terakhir)", "type": "string", "description": "Dari changelog beban per jam.",
                                      "edit_only": True})
            ontology._put("object-types", rec)
    pos = {"Normal": (80, 160), "Beban tinggi": (340, 60), "Overload": (600, 160)}
    beban = mc.ProcessIn(name="Status beban gardu distribusi", object_type_id=gd["id"], state_property="status_beban",
                         states=[{"id": s, "label": s, "x": x, "y": y} for s, (x, y) in pos.items()],
                         transitions=[{"from": mc.START, "to": s} for s in pos] + [{"from": a, "to": b} for a in pos for b in pos if a != b])
    acts = [a for a in (e._action(n) for n in ("Tetapkan status temuan susut (demo)", "Jadikan target P2TL (demo)", "Eskalasi temuan bernilai besar (demo)")) if a]
    vpos = {s: (80 + 240 * (i % 4), 60 + 160 * (i // 4)) for i, s in enumerate(STATUSES)}
    alur = mc.ProcessIn(name="Alur temuan susut", object_type_id=tm["id"], state_property="status_temuan",
                        states=[{"id": s, "label": s, "x": vpos[s][0], "y": vpos[s][1]} for s in STATUSES],
                        transitions=[*({"from": mc.START, "to": s} for s in STATUSES), *({"from": "Baru", "to": s} for s in STATUSES[1:]),
                                     *({"from": "Diverifikasi", "to": s} for s in ("Target P2TL", "Eskalasi", "Bukan pelanggaran")),
                                     *({"from": "Target P2TL", "to": s} for s in ("Ditindaklanjuti", "Bukan pelanggaran")),
                                     {"from": "Eskalasi", "to": "Ditindaklanjuti"}, {"from": "Ditindaklanjuti", "to": "Selesai"}],
                        actions=[{"action_type_id": a["id"], "inputs": STATUSES[:4], "outputs": STATUSES[1:], "automation": False} for a in acts])
    rec = mc.create_resource(mc.MachineryIn(name=MACHINERY, auto_layout=False, processes=[beban, alur],
                                            description="Demo: gardu distribusi sebagai mesin — Normal / Beban tinggi / Overload dari beban per jam (changelog "
                                                        "pipeline beban per jam), durasi dan jalurnya; dan alur keputusan temuan susut dari action tim susut."))
    mc.setup_log(rec["id"], beban.id, mc.LogSetupIn(changelog_dataset_id=changelog_id, from_edits=False))
    mc.setup_log(rec["id"], alur.id, mc.LogSetupIn(from_edits=True))
    return rec["id"]


def build(state: dict, save) -> dict:
    import uuid

    import ontology
    import ontology_mdo
    import pipeline_datasets
    import pipeline_runtime as rt
    import timeseries

    import demo_grid_e2e as e

    out: dict[str, Any] = {}
    project = e._folder(None, e.PROJECT, "project")
    raw_folder = e._folder(e._folder(project, "raw"), "iot")
    folder = e._folder(project, "iot")
    raw = generate()
    out["raw_rows"] = {k: len(v) for k, v in raw.items()}
    raw_ids = {name: e._put(raw_folder, name, rows, replace=False) for name, rows in raw.items()}
    results = emulate(raw)
    ids = {name: e._put(folder, name, rows, replace=False) for name, rows in results.items()}
    out["rows"] = {k: len(v) for k, v in results.items()}
    import json as _json

    import drive

    pid = state.get("iot_pipeline_id")
    current = None
    if pid:
        try:
            current = _json.loads(drive.read_bytes(pipeline_datasets._pipeline_item(pid)))
        except Exception:  # noqa: BLE001
            current, pid = None, None
    if not pid or (current.get("meta") or {}).get("version") != VERSION:
        body, out_ids = content(e.PROJECT, raw_ids, raw, folder, lambda: uuid.uuid4().hex[:8], e._schedule)
        if pid:
            body["createdAt"] = current.get("createdAt") or body["createdAt"]
            pipeline_datasets.save_pipeline(pid, pipeline_datasets.PipelineFileChange(content=body))
        else:
            pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))["id"]
        for name, oid in out_ids.items():
            if not rt.get_state(pid, f"output:{oid}"):
                rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": folder, "version": 0, "rows": len(results[name]),
                                                    "path": f"{e.PROJECT} / iot / {name}.parquet"})
        state["iot_pipeline_id"] = pid
        save()
    out["pipeline_id"] = pid
    syncs = {}
    for key, dataset, unit in (("penyulang", "daya_penyulang_per_jam", "kw"), ("gardu", "beban_gardu_per_jam", "kva"), ("tm", "daya_tm_per_jam", "kw")):
        s = next((x for x in timeseries.all_syncs("timeseries") if x.get("name") == SYNCS[key]), None)
        if not s:
            s = timeseries.create_catalog_sync(timeseries.CatalogSyncIn(
                name=SYNCS[key], dataset_id=ids[dataset], description=f"Demo: {SYNCS[key]} Jul–Sep 2026, satu seri per objek.",
                mapping=timeseries.Mapping(series_id="seri", timestamp="ts", value=unit, timestamp_unit="SECONDS")))
        syncs[key] = s["id"]
    state["iot_syncs"] = syncs
    save()
    # the series id per object, as a second datasource of each sensor type
    # the first version kept every series in one dataset (a dataset backs one type only): let go of it
    import drive as _drive

    old = next((x["id"] for x in _drive.list_files(folder) if x["name"] == "seri_beban_objek.parquet" and not x.get("trashed_at")), None)
    if old:
        for key in ("penyulang", "gardu", "pelanggan"):
            t = e._type(key)
            if any(d["dataset_id"] == old for d in ontology._object_type(t["id"]).get("additional_datasources") or []):
                ontology_mdo.remove_datasource(t["id"], old)
    for key, dataset in (("penyulang", "seri_beban_penyulang"), ("gardu", "seri_beban_gardu"), ("pelanggan", "seri_beban_pelanggan_tm")):
        t = e._type(key)
        if not any(d["dataset_id"] == ids[dataset] for d in ontology._object_type(t["id"]).get("additional_datasources") or []):
            ontology_mdo.add_datasource(t["id"], ontology_mdo.ExtraIn(dataset_id=ids[dataset], pk_column="kode_objek",
                                                                      columns={"seri_beban": "seri_beban", "nama_sensor": "nama_sensor", "satuan": "satuan"}))
    gi, py, gd, pl = e._type("gi"), e._type("penyulang"), e._type("gardu"), e._type("pelanggan")
    out["sensors"] = [k for k, ok in (("penyulang", _sensor(py["id"], gi["id"], "kode_gi", syncs["penyulang"], "kW")),
                                      ("gardu", _sensor(gd["id"], py["id"], "kode_penyulang", syncs["gardu"], "kVA")),
                                      ("pelanggan", _sensor(pl["id"], py["id"], "kode_penyulang", syncs["tm"], "kW"))) if ok]
    out["machinery"] = _machinery(ids["perubahan_status_gardu"])
    out["syncs"] = syncs
    return out
