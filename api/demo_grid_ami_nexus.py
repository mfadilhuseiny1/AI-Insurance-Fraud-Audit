"""Demo Grid: the AMI streams that ended in nothing, now in the Nexus (called by demo_grid_e2e.build, step "ami_nexus",
and on every detection round of demo_grid_ntl_stream.scan).

  stream ami_bersih (Pipeline AMI streaming: cleaned 15-minute readings of the pilot's meters)
    -> "Grid AMI Meter Health (demo)": one object per meter — last reading, load, power factor, voltage band, phase
       balance, tamper events, data quality and a health status (Healthy / Check / Not reporting) with its reasons;
       links to Grid AMI Meter (1:1) and Grid Customer (N:1).
  stream neraca_gardu_jam (Pipeline NTL per jam: kWh of the pilot's meters per distribution substation per hour)
    -> "Grid Substation Hourly Balance (demo)": one object per substation and hour — kWh, active meters, meters with
       very low kWh and their share, an hourly status (Normal / Watch / Anomaly); links to Grid Distribution Substation.
  stream "Beban AMI pelanggan 15 menit (demo)" already indexes the meters' load time series (Grid AMI Meter); lineage
  shows the stream → time series sync edge.

Both types record the streams they are fed by (fed_by_streams, read by lineage), carry the per-ULP row policy of the
grid demo, and are shown in the cockpit (/pln-cockpit → Loss) and the Workshop "Kokpit susut & keandalan grid".
Simulated, labelled "(demo)"; read-only to SCADA.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

log = logging.getLogger("bluesandai.demo_grid_ami_nexus")
WIB = timezone(timedelta(hours=7))

HEALTH = ("Grid AMI Meter Health (demo)", "Grid AMI Meter Health (demo)", "GridAmiMeterHealthDemo", "no_meter", "judul")
HOURLY = ("Grid Substation Hourly Balance (demo)", "Grid Substation Hourly Balances (demo)", "GridSubstationHourlyBalanceDemo", "id_jam", "judul")

HEALTH_PROPS = [
    ("no_meter", "Meter no.", "string"), ("judul", "Title", "string"), ("id_pelanggan", "Customer ID", "string"),
    ("head_end", "Head-end", "string"), ("kode_dt", "Distribution substation", "string"), ("kode_penyulang", "Feeder", "string"),
    ("kode_ulp", "Service unit (ULP)", "string"), ("tegangan", "Voltage (LV/MV)", "string"),
    ("bacaan", "Readings", "integer"), ("bacaan_terakhir_wib", "Last reading (WIB)", "string"), ("jam_sejak_bacaan", "Hours since last reading", "double"),
    ("kwh_total", "Energy (kWh)", "double"), ("kw_rata", "Average load (kW)", "double"), ("kw_puncak", "Peak load (kW)", "double"),
    ("pf_rata", "Average power factor", "double"), ("v_min", "Min voltage (V)", "double"), ("v_maks", "Max voltage (V)", "double"),
    ("rasio_arus_fasa_min", "Min phase current ratio", "double"), ("event_tamper", "Tamper events", "integer"),
    ("event_terakhir", "Last event", "string"), ("kualitas_baik_pct", "Good-quality readings (%)", "double"),
    ("status_kesehatan", "Health status", "string"), ("alasan", "Reasons", "string"),
]
HOURLY_PROPS = [
    ("id_jam", "ID", "string"), ("judul", "Title", "string"), ("kode_dt", "Distribution substation", "string"),
    ("kode_penyulang", "Feeder", "string"), ("kode_ulp", "Service unit (ULP)", "string"), ("jam_wib", "Hour (WIB)", "string"),
    ("kwh_jam", "Energy (kWh)", "double"), ("meter_aktif", "Active meters", "integer"),
    ("meter_kwh_sangat_rendah", "Meters with very low kWh", "integer"), ("porsi_meter_rendah_pct", "Share of very-low meters (%)", "double"),
    ("porsi_normal_gardu_pct", "Usual share at this hour (%)", "double"),
    ("status_jam", "Hourly status", "string"),
]
LINKS = [
    # (name, from type key, fk, to type (display name), from side, to side, cardinality)
    ("AMI meter health of meter (grid demo)", "health", "no_meter", "Grid AMI Meter (demo)", "Health", "AMI meter", "one_to_one"),
    ("AMI meter health of customer (grid demo)", "health", "id_pelanggan", "Grid Customer (demo)", "AMI meter health", "Customer", "many_to_one"),
    ("Hourly balance of substation (grid demo)", "hourly", "kode_dt", "Grid Distribution Substation (demo)", "Hourly balances", "Distribution substation", "many_to_one"),
]
STREAM_HEALTH = "ami_bersih"
STREAM_HOURLY = "neraca_gardu_jam"
TAMPER = ("magnet", "cover_open")
HOURS_KEPT = 7 * 24  # the hourly balance keeps a week per substation


def _num(v: Any) -> float | None:
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def _stream_id(name: str) -> str | None:
    import streaming

    return next((s["id"] for s in streaming.list_streams() if s.get("name") == name), None)


def _records(stream_id: str) -> list[dict]:
    import streaming

    out, after = [], 0
    while True:
        page = streaming.read_records(stream_id, after=after, limit=5000)
        rows = page.get("rows") or []
        out += rows
        after = int(page.get("last_seq") or after)
        if len(rows) < 5000:
            return out


def _type(spec: tuple, props: list[tuple], icon: str, color: str, description: str) -> dict:
    import ontology

    name, plural, api, pk, title = spec
    t = next((x for x in ontology._all("object-types") if x["display_name"] == name), None)
    if t:
        # a property added in a later version of the demo
        rec = ontology._object_type(t["id"])
        have = {p["api_name"] for p in rec["properties"]}
        missing = [ontology.Property(api_name=a, display_name=d, type=ty) for a, d, ty in props if a not in have]
        if missing:
            ontology.update_object_type(t["id"], ontology.ObjectTypeIn(properties=[ontology.Property(**p) for p in rec["properties"]] + missing))
        return t
    t = ontology.create_object_type(ontology.ObjectTypeIn(
        display_name=name, plural_name=plural, api_name=api, primary_key=pk, title_property=title, icon=icon, color=color,
        description=description, properties=[ontology.Property(api_name=a, display_name=d, type=ty) for a, d, ty in props]))
    ontology.ensure_objects(t["id"])
    return t


# ------------------------------------------------------------------------------------------------
# the objects, computed from the streams (pure functions over records)
# ------------------------------------------------------------------------------------------------

def health_objects(rows: list[dict], register: dict[str, dict]) -> dict[str, dict]:
    acc: dict[str, dict] = {}
    for r in rows:
        m = r.get("no_meter")
        if not m:
            continue
        a = acc.setdefault(m, {"n": 0, "good": 0, "kwh": 0.0, "kw": [], "pf": [], "v": [], "fasa": [], "tamper": 0, "event": "", "ts": 0,
                               "id_pelanggan": r.get("id_pelanggan"), "head_end": r.get("head_end")})
        a["n"] += 1
        a["good"] += 1 if (r.get("kualitas") or "GOOD") != "BAD" else 0
        for key, col in (("kw", "kw"), ("pf", "pf"), ("v", "v_l1"), ("fasa", "rasio_arus_fasa")):
            x = _num(r.get(col))
            if x is not None:
                a[key].append(x)
        a["kwh"] += _num(r.get("kwh")) or 0.0
        ev = r.get("event") or ""
        if ev:
            a["event"] = ev
            a["tamper"] += 1 if ev in TAMPER else 0
        a["ts"] = max(a["ts"], int(_num(r.get("ts")) or 0))
    newest = max((a["ts"] for a in acc.values()), default=0)
    out = {}
    for m, a in acc.items():
        reg = register.get(m) or {}
        since = round((newest - a["ts"]) / 3_600_000, 1) if newest and a["ts"] else None
        vmin, vmax = (min(a["v"]), max(a["v"])) if a["v"] else (None, None)
        pf = round(sum(a["pf"]) / len(a["pf"]), 3) if a["pf"] else None
        fasa = round(min(a["fasa"]), 3) if a["fasa"] else None
        good = round(100 * a["good"] / a["n"], 1) if a["n"] else None
        why = []
        if since is not None and since > 2:
            why.append(f"no reading for {since} h")
        # voltage band: LV meters against 230 V ±10% (SPLN), MV meters (20 kV, CT/VT) against their own median ±10%
        if a["v"]:
            nominal = 230.0 if reg.get("tegangan") != "TM" else sorted(a["v"])[len(a["v"]) // 2]
            if vmin < 0.9 * nominal:
                why.append(f"voltage down to {vmin:.0f} V (< -10% of {nominal:.0f} V)")
            if vmax > 1.1 * nominal:
                why.append(f"voltage up to {vmax:.0f} V (> +10% of {nominal:.0f} V)")
        if pf is not None and pf < 0.7:
            why.append(f"low power factor {pf}")
        if fasa is not None and reg.get("tegangan") == "TM" and fasa < 0.3:
            why.append(f"unbalanced phase currents (min ratio {fasa})")
        if a["tamper"]:
            why.append(f"{a['tamper']} tamper event(s)")
        if good is not None and good < 90:
            why.append(f"only {good}% good-quality readings")
        status = "Not reporting" if since is not None and since > 2 else "Check" if why else "Healthy"
        last = datetime.fromtimestamp(a["ts"] / 1000, WIB).strftime("%Y-%m-%d %H:%M") if a["ts"] else None
        out[m] = {"properties": {
            "no_meter": m, "judul": f"{m} · {status} (demo)", "id_pelanggan": a["id_pelanggan"] or reg.get("id_pelanggan"),
            "head_end": a["head_end"] or reg.get("head_end"), "kode_dt": reg.get("kode_dt"), "kode_penyulang": reg.get("kode_penyulang"),
            "kode_ulp": reg.get("kode_ulp"), "tegangan": reg.get("tegangan"), "bacaan": a["n"], "bacaan_terakhir_wib": last,
            "jam_sejak_bacaan": since, "kwh_total": round(a["kwh"], 2),
            "kw_rata": round(sum(a["kw"]) / len(a["kw"]), 3) if a["kw"] else None, "kw_puncak": round(max(a["kw"]), 3) if a["kw"] else None,
            "pf_rata": pf, "v_min": vmin, "v_maks": vmax, "rasio_arus_fasa_min": fasa, "event_tamper": a["tamper"],
            "event_terakhir": a["event"] or None, "kualitas_baik_pct": good, "status_kesehatan": status,
            "alasan": "; ".join(why) or "all checks within limits"}}
    return out


def hourly_objects(rows: list[dict], dt_info: dict[str, dict]) -> dict[str, dict]:
    by_dt: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("kode_dt") and r.get("jam_wib"):
            by_dt.setdefault(r["kode_dt"], []).append(r)
    out = {}
    for dt, rs in by_dt.items():
        latest: dict[str, dict] = {}
        for r in rs:  # a re-sent hour replaces the earlier record (changelog order)
            latest[r["jam_wib"]] = r
        info = dt_info.get(dt) or {}

        def share_of(r: dict) -> float | None:
            aktif = int(_num(r.get("meter_aktif")) or 0)
            return round(100 * int(_num(r.get("meter_kwh_sangat_rendah")) or 0) / aktif, 1) if aktif else None

        # the substation's own normal at that hour of day: the median share of very-low meters at the same hour on the
        # other days (nights are naturally low; some substations always have many small customers); the substation's
        # overall median while fewer than three days are in
        def median(xs: list[float]) -> float:
            xs = sorted(xs)
            return xs[len(xs) // 2] if xs else 0.0

        by_hour: dict[str, list[float]] = {}
        for j, r in latest.items():
            x = share_of(r)
            if x is not None:
                by_hour.setdefault(j[-5:], []).append(x)
        overall = median([x for xs in by_hour.values() for x in xs])
        for jam in sorted(latest)[-HOURS_KEPT:]:
            r = latest[jam]
            aktif = int(_num(r.get("meter_aktif")) or 0)
            rendah = int(_num(r.get("meter_kwh_sangat_rendah")) or 0)
            share = share_of(r)
            same = by_hour.get(jam[-5:]) or []
            base = median(same) if len(same) >= 3 else overall
            status = "Normal" if share is None else "Anomaly" if share >= base + 25 else "Watch" if share >= base + 12 else "Normal"
            pk = f"{dt} {jam}"
            out[pk] = {"properties": {
                "id_jam": pk, "judul": f"{dt} · {jam} WIB · {status} (demo)", "kode_dt": dt, "kode_penyulang": info.get("kode_penyulang"),
                "kode_ulp": info.get("kode_ulp"), "jam_wib": jam, "kwh_jam": _num(r.get("kwh_pilot_jam")), "meter_aktif": aktif,
                "meter_kwh_sangat_rendah": rendah, "porsi_meter_rendah_pct": share, "porsi_normal_gardu_pct": base, "status_jam": status}}
    return out


# ------------------------------------------------------------------------------------------------
# writing them to the Nexus
# ------------------------------------------------------------------------------------------------

def _st() -> dict:
    import demo_grid_e2e as e

    return e.STATE.setdefault("ami_nexus", {})


def refresh() -> dict:
    """Recompute both types from their streams and save what changed (objects gone from the window are removed)."""
    import ontology

    import demo_grid_ami as ga

    st = _st()
    out: dict[str, Any] = {}
    register = {m["no_meter"]: m for m in ga.meters()}
    dt_info: dict[str, dict] = {}
    for m in register.values():
        dt_info.setdefault(m["kode_dt"], {"kode_penyulang": m["kode_penyulang"], "kode_ulp": m["kode_ulp"]})
    for key, stream, fn, extra in (("health", STREAM_HEALTH, health_objects, register), ("hourly", STREAM_HOURLY, hourly_objects, dt_info)):
        tid, sid = st.get(f"{key}_type"), _stream_id(stream)
        if not tid or not sid:
            out[key] = "not built"
            continue
        new = fn(_records(sid), extra)
        now = datetime.now(timezone.utc).isoformat()
        objs = ontology.load_objects(tid)
        changed = []
        for pk, o in new.items():
            if (objs.get(pk) or {}).get("properties") != o["properties"]:
                objs[pk] = {**o, "created_at": (objs.get(pk) or {}).get("created_at") or now, "updated_at": now}
                changed.append(pk)
        gone = [pk for pk in objs if pk not in new]
        for pk in gone:
            objs.pop(pk)
        if changed or gone:
            ontology.save_objects(tid, objs, changed=changed + gone)
        out[key] = {"objects": len(new), "changed": len(changed), "removed": len(gone)}
    st["refreshed_at"] = datetime.now(timezone.utc).isoformat()
    return out


def build(state: dict, save) -> dict:
    import ontology
    import ontology_model as om
    import ontology_security as osec

    import demo_grid_akses as ak

    st = state.setdefault("ami_nexus", {})
    out: dict[str, Any] = {}
    health = _type(HEALTH, HEALTH_PROPS, "gauge", "#0ea5e9",
                   "Demo: health of each pilot AMI meter from the cleaned AMI stream (ami_bersih) — last reading, load, power factor, "
                   "voltage band, phase balance, tamper events, data quality; status Healthy / Check / Not reporting with reasons.")
    hourly = _type(HOURLY, HOURLY_PROPS, "wave", "#14b8a6",
                   "Demo: the pilot meters' energy per distribution substation and hour (stream neraca_gardu_jam of Pipeline NTL per jam) — "
                   "active meters, meters with very low kWh and their share; status Normal / Watch (≥ usual + 12 pts) / Anomaly (≥ usual + 25 pts).")
    st.update(health_type=health["id"], hourly_type=hourly["id"])
    out["types"] = {"health": health["id"], "hourly": hourly["id"]}
    # the streams each type is fed by (lineage: stream → object type)
    for t, names in ((health, (STREAM_HEALTH,)), (hourly, (STREAM_HOURLY,))):
        fed = sorted(x for x in (_stream_id(n) for n in names) if x)
        rec = ontology._object_type(t["id"])
        if fed and rec.get("fed_by_streams") != fed:
            rec["fed_by_streams"] = fed
            ontology._put("object-types", rec)
    # links to the meters, customers and substations
    have = {x.get("display_name") for x in ontology._all("link-types")}
    by_name = {x["display_name"]: x for x in ontology._all("object-types")}
    src = {"health": health, "hourly": hourly}
    for name, key, fk, to, side_a, side_b, card in LINKS:
        target = by_name.get(to)
        if name in have or not target:
            continue
        om.create_link_type(om.LinkTypeIn(display_name=name, kind="foreign_key", cardinality=card, foreign_key=fk,
                                          source=om.LinkSide(object_type_id=src[key]["id"], display_name=side_a,
                                                             plural_display_name=side_a if card == "many_to_one" else None),
                                          target=om.LinkSide(object_type_id=target["id"], display_name=side_b)))
        out.setdefault("links", []).append(name)
    # rows per ULP, as the grid demo's other operational types
    groups = (state.get("akses") or {}).get("groups") or {}
    if groups.get("up3"):
        for t in (health, hourly):
            sec = ontology._object_type(t["id"]).get("security") or {}
            op = {**(sec.get("object_policy") or {"markings": []}), "granular": ak.policy([groups["up3"]])}
            if (sec.get("object_policy") or {}).get("granular") != op["granular"]:
                osec.set_security(t["id"], osec.SecurityIn(object_policy=op, property_policies=sec.get("property_policies") or []))
    save()
    out["refresh"] = refresh()
    out["workshop"] = _workshop()
    save()
    return out


WS_TITLE = "AMI meter health (stream → Nexus)"


def _workshop() -> str | None:
    """The cockpit Workshop gains a section on the AMI streams' types."""
    import workshop

    import demo_grid_e2e as e

    m = next((x for x in workshop.list_modules() if x.get("name") == e.WORKSHOP), None)
    st = _st()
    if not m or not st.get("health_type"):
        return None
    full = workshop.get_module(m["id"], count=False)
    widgets = list(full.get("widgets") or [])
    if any(w.get("title") == WS_TITLE for w in widgets):
        return "exists"
    y = max((int(w.get("y") or 0) + int(w.get("h") or 0) for w in widgets), default=0)
    hs = {"kind": "object_type", "id": st["health_type"]}
    hb = {"kind": "object_type", "id": st["hourly_type"]}

    def add(kind: str, title: str, x: int, yy: int, wd: int, h: int, config: dict) -> None:
        widgets.append({"id": f"w{len(widgets) + 1}", "type": kind, "title": title, "x": x, "y": y + yy, "w": wd, "h": h, "config": config})

    add("text", "", 0, 0, 12, 2, {"text": "**AMI streaming → Nexus (demo)** — the cleaned 15-minute AMI stream becomes one health object per meter, "
                                          "and the hourly substation balance stream one object per substation-hour. Refreshed on every detection round."})
    add("metric", "Meters to check", 0, 2, 3, 3, {"source": hs, "metric": "count", "label": "status: Check", "filters": [{"column": "status_kesehatan", "op": "eq", "value": "Check"}]})
    add("metric", "Meters not reporting", 3, 2, 3, 3, {"source": hs, "metric": "count", "label": "no reading for > 2 h",
                                                        "filters": [{"column": "status_kesehatan", "op": "eq", "value": "Not reporting"}]})
    add("metric", "Substation-hours in anomaly", 6, 2, 3, 3, {"source": hb, "metric": "count", "label": "very-low-kWh share ≥ usual + 25 pts",
                                                              "filters": [{"column": "status_jam", "op": "eq", "value": "Anomaly"}]})
    add("metric", "Average power factor", 9, 2, 3, 3, {"source": hs, "metric": "avg", "metric_column": "pf_rata", "label": "pilot AMI meters"})
    add("bar", "Meters by health status", 0, 5, 4, 6, {"source": hs, "group_by": "status_kesehatan", "metric": "count"})
    add("table", WS_TITLE, 4, 5, 8, 6, {"source": hs, "sort": "event_tamper", "descending": True, "limit": 300,
                                        "columns": ["no_meter", "kode_dt", "kode_ulp", "status_kesehatan", "alasan", "pf_rata", "v_min", "rasio_arus_fasa_min",
                                                    "event_tamper", "bacaan_terakhir_wib"]})
    add("table", "Substation hourly balance (latest first)", 0, 11, 12, 6, {"source": hb, "sort": "jam_wib", "descending": True, "limit": 300,
                                                                            "columns": ["kode_dt", "jam_wib", "kwh_jam", "meter_aktif", "meter_kwh_sangat_rendah",
                                                                                        "porsi_meter_rendah_pct", "status_jam"]})
    workshop.save_module(m["id"], workshop.ModuleIn(widgets=widgets, settings=full.get("settings") or {},
                                                    version_note="AMI streams in the Nexus: meter health and substation hourly balance"))
    return m["id"]
