"""The IoMT Audit Report as data (report.json), built from one audit run.

The platform's report view reads this file, and a combined audit report can embed it as a section: it uses the same
fraud-mode groups as the rest of the audit (Permenkes 16/2019) and the same two outcomes, dispute and verify.
It never needs the ground truth; when a scored run is available the score is added, and labelled as such.
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

SLICES = 40
H = 3_600_000

# rule -> mode group
RULE_FAMILY = {
    "vent_run_96": "upcoding", "niv_as_invasive": "upcoding", "severity_vs_acuity": "upcoding", "hd_short": "upcoding", "hd_short_isolated": "upcoding", "imaging_unbundled": "upcoding",
    "vent_standby": "phantom", "vent_no_device": "phantom", "icu_phantom": "phantom", "imaging_count": "phantom", "hd_phantom": "phantom", "hd_duplicate": "phantom",
    "visit_no_checkin": "phantom", "no_device_trace": "phantom",
    "icu_days": "inflated", "drug_units": "inflated", "implant_unscanned": "inflated", "vent_hours": "inflated",
    "los_padding": "stay", "split_stay": "stay",
    "cloned_vitals": "integrity", "implant_serial_reuse": "integrity", "anchor_mismatch": "integrity", "revoked_device": "integrity", "impossible_travel": "integrity",
    "late_anchor": "explain", "faskes_offline": "explain", "evidence_incomplete": "explain",
}
FAMILY = {
    "upcoding": ("Upcoding & unbundling", "A higher tariff, tier or code than the care delivered supports."),
    "phantom": ("Phantom & repeat billing", "A service billed that no device saw, or the same one twice."),
    "inflated": ("Inflated bills", "More days, hours, doses or implants billed than were used."),
    "stay": ("Prolonged stay & readmission", "A stay billed longer than the bed was occupied, or one stay split into two."),
    "integrity": ("Cloning & data integrity", "Evidence that was copied, edited after it was anchored, or made by a revoked key."),
    "explain": ("Needs an explanation", "Not an accusation: evidence is incomplete, late or the faskes was offline."),
}
RULE_TEXT = {
    "vent_run_96": "96.72 billed, but the ventilator never ran 96 h in a row", "niv_as_invasive": "Non-invasive ventilation billed as invasive",
    "vent_standby": "Ventilation billed; the ventilator sat in standby", "vent_no_device": "Ventilation billed; no ventilator stream", "vent_hours": "More ventilator hours billed than recorded",
    "icu_phantom": "ICU days billed; the patient was only in a ward bed", "icu_days": "More ICU days billed than the bed was occupied",
    "los_padding": "Discharge billed later than the bed was emptied", "split_stay": "One continuous stay billed as two claims",
    "drug_units": "More vials billed than the infusion pump delivered", "imaging_count": "More imaging exams billed than the device logged",
    "imaging_unbundled": "Each CT acquisition billed as its own exam", "hd_phantom": "Dialysis billed; the machine ran no session",
    "hd_short": "A dialysis session under 3 h billed in full (a pattern at this faskes)", "hd_short_isolated": "A dialysis session under 3 h: isolated, may be clinical",
    "hd_duplicate": "The same dialysis session billed twice", "implant_unscanned": "Implant serials billed that were never scanned out",
    "implant_serial_reuse": "The same implant serial billed twice", "visit_no_checkin": "Visit billed with no check-in recorded",
    "impossible_travel": "One participant checked in at two faskes at once", "no_device_trace": "Service billed with no device reading at all",
    "cloned_vitals": "Vitals identical to another patient's episode", "anchor_mismatch": "Readings do not match the evidence anchor",
    "revoked_device": "Readings from a revoked device key", "severity_vs_acuity": "Severity III billed; measured intensity of care is low",
    "late_anchor": "Evidence anchored after the claim was submitted", "faskes_offline": "No readings: the faskes's gateway was offline",
    "evidence_incomplete": "Readings are missing: measured counts are lower bounds",
}
NEXT_STEP = {
    "dispute": "Request the device records and hold payment of the disputed item until they are explained.",
    "verify": "Ask the faskes for an explanation or the clinical note before deciding. Not an accusation.",
}
PRICED = {"severity_vs_acuity", "vent_run_96", "niv_as_invasive", "vent_standby"}  # rules whose overbilling can be priced from tariffs
METRIC_LABEL = {"ventilation_active": "Ventilator running", "icu_bed_occupied": "ICU bed occupied", "bed_occupied": "Ward bed occupied", "dialysis_active": "Dialysis running"}


def _py(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if math.isnan(float(o)) else float(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (set, tuple)):
        return list(o)
    raise TypeError(type(o))


def _num(x):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) or x == "" or pd.isna(x) else float(x)


def _ribbons(au, c, ep: str):
    g = au.by_ep.get(ep)
    if g is None or g.empty:
        return None
    t0 = int(pd.Timestamp(c.waktu_datang).timestamp() * 1000)
    t1 = int(pd.Timestamp(c.waktu_pulang).timestamp() * 1000)
    lo = min(t0, int(g.epoch_ms.min()))
    hi = max(t1, int(g.epoch_ms.max())) + H
    span = (hi - lo) / SLICES
    series = []
    for metric, label in METRIC_LABEL.items():
        m = g[g.metric == metric]
        if m.empty:
            continue
        on, seen = np.zeros(SLICES), np.zeros(SLICES)
        idx = ((m.epoch_ms.to_numpy() - lo) // span).clip(0, SLICES - 1).astype(int)
        for i, v, iv in zip(idx, m.value.to_numpy(), m.interval_sec.to_numpy()):
            seen[i] += iv
            on[i] += iv if v == 1 else 0
        note = ""
        if metric == "ventilation_active":
            modes = sorted(set(m.attr) - {""})
            note = "/".join(modes)
        series.append({"metric": metric, "label": label, "note": note, "cells": [round(float(on[i] / seen[i]), 2) if seen[i] else None for i in range(SLICES)]})
    return {"from": lo, "to": hi, "claimedFrom": t0, "claimedTo": t1, "series": series}


def _measures(c, f):
    out = []
    if f is None:
        return out
    v = _num(c.ventilator_jam_diklaim)
    if v is not None and f["vent_rows"]:
        out.append({"label": "Invasive ventilation", "unit": "h", "claimed": v, "measured": float(f["imv_h"])})
    d = _num(c.icu_hari_diklaim)
    if d:
        out.append({"label": "ICU days", "unit": "days", "claimed": d, "measured": float(math.ceil((f["icu_h"] + f["icu_missing"]) / 24))})
    if str(c.tingkat_pelayanan) == "Rawat Inap" and str(c.poli) != "Kardiologi" and (f["icu_rows"] or f["ward_rows"]):
        out.append({"label": "Length of stay", "unit": "days", "claimed": float(c.los_hari), "measured": float(math.ceil((f["icu_h"] + f["ward_h"] + f["icu_missing"] + f["ward_missing"]) / 24))})
    u = _num(c.obat_khusus_unit_diklaim)
    if u is not None:
        out.append({"label": "High-cost drug vials", "unit": "vials", "claimed": u, "measured": round(f["drug_ml"] / 100.0, 1)})
    n = _num(c.radiologi_diklaim_n)
    if n is not None:
        out.append({"label": "Imaging exams", "unit": "exams", "claimed": n, "measured": float(f["img_n"])})
    if str(c.prosedur) == "39.95" and f["hd_rows"]:
        out.append({"label": "Dialysis session", "unit": "min", "claimed": 240.0, "measured": float(f["hd_min"])})
    k = _num(c.implan_diklaim_n)
    if k is not None:
        out.append({"label": "Implants", "unit": "units", "claimed": k, "measured": float(len(f["serials"]))})
    return out


def build_report(au, flags: pd.DataFrame, fnd: pd.DataFrame, out: Path, score: dict | None = None, per_scenario: list | None = None, upcoding: tuple | None = None, seed: int | None = None) -> Path:
    claims = au.claims.set_index("kunjungan_fkrtl_id", drop=False)
    faskes = au.faskes.set_index("faskes_profil_id")
    flag_of = dict(zip(flags.kunjungan_fkrtl_id, flags.flag))
    by_claim = defaultdict(list)
    for r in fnd.itertuples():
        by_claim[r.kunjungan_fkrtl_id].append(r)
    order = list(RULE_FAMILY)

    items = []
    for cid, fl in flag_of.items():
        if fl == "none":
            continue
        c = claims.loc[cid]
        fs = by_claim[cid]
        pool = [x for x in fs if x.flag == fl and x.rule != "evidence_incomplete"] or [x for x in fs if x.flag == fl] or fs
        top = sorted(pool, key=lambda x: order.index(x.rule) if x.rule in order else 99)[0]
        fam = RULE_FAMILY.get(top.rule, "explain")
        ep = c.episode_id if isinstance(c.episode_id, str) else ""
        f = au.ep_feat.get(ep)
        kind = au.stays.get(cid, ("", 0))[0]
        est = 0.0
        if any(x.rule in PRICED for x in fs) and kind in au.ref_tariff:
            est = max(0.0, float(c.tarif_inacbg_rp) - au.ref_tariff[kind])
        items.append({
            "id": cid, "faskes": c.faskes_profil_id, "type": "Inpatient" if str(c.tingkat_pelayanan) == "Rawat Inap" else "Outpatient", "dx": f"{c.dx_primer_kode} {c.dx_primer_nama}",
            "admitted": str(c.tgl_datang), "discharged": str(c.tgl_pulang), "severity": str(c.inacbg_keparahan), "tariffRp": int(c.tarif_inacbg_rp),
            "flag": fl, "family": fam, "headline": RULE_TEXT.get(top.rule, top.rule), "estRp": round(est),
            "findings": [{"rule": x.rule, "flag": x.flag, "title": RULE_TEXT.get(x.rule, x.rule), "claimed": str(x.claimed), "measured": str(x.measured), "evidence": str(x.evidence)} for x in sorted(fs, key=lambda x: (x.flag != fl, order.index(x.rule) if x.rule in order else 99))],
            "measures": _measures(c, f), "timeline": _ribbons(au, c, ep) if ep else None, "next": NEXT_STEP[fl],
        })
    items.sort(key=lambda x: (x["flag"] != "dispute", -x["estRp"], x["id"]))

    modes = []
    for key, (name, blurb) in FAMILY.items():
        g = [x for x in items if x["family"] == key]
        rules = Counter(x["findings"][0]["rule"] for x in g)
        modes.append({"id": key, "name": name, "blurb": blurb, "dispute": sum(x["flag"] == "dispute" for x in g), "verify": sum(x["flag"] == "verify" for x in g),
                      "estRp": sum(x["estRp"] for x in g), "rules": [{"rule": r, "title": RULE_TEXT.get(r, r), "claims": n} for r, n in rules.most_common()]})

    inst = claims[claims.episode_id.notna()]
    per_faskes = []
    for fid, row in faskes.iterrows():
        mine = [x for x in items if x["faskes"] == fid]
        n_all = int((claims.faskes_profil_id == fid).sum())
        n_inst = int((inst.faskes_profil_id == fid).sum())
        per_faskes.append({"id": fid, "name": row["nama"], "coverage": row["iot_coverage"], "province": row["provinsi"], "claims": n_all, "instrumented": n_inst,
                           "dispute": sum(x["flag"] == "dispute" for x in mine), "verify": sum(x["flag"] == "verify" for x in mine), "estRp": sum(x["estRp"] for x in mine)})
    per_faskes.sort(key=lambda x: (-x["dispute"], -x["estRp"], x["id"]))

    rule_n = Counter(x.rule for x in fnd.itertuples()) if len(fnd) else Counter()
    n_disp = sum(x["flag"] == "dispute" for x in items)
    n_ver = sum(x["flag"] == "verify" for x in items)
    held = sum(1 for x in items if x["flag"] == "verify" and x["family"] == "explain")
    instrumented_faskes = int((faskes.iot_coverage != "none").sum())
    workflow = [
        {"id": "ingest", "title": "Ingest device readings", "value": len(au.r), "unit": "readings", "detail": f"{au.r.device_id.nunique():,} devices at {instrumented_faskes} instrumented faskes"},
        {"id": "integrity", "title": "Verify evidence integrity", "value": len(au.anch), "unit": "episodes anchored",
         "detail": f"{rule_n.get('anchor_mismatch', 0)} do not match their anchor, {rule_n.get('late_anchor', 0)} anchored after the claim, {rule_n.get('revoked_device', 0)} on a revoked key"},
        {"id": "reconcile", "title": "Reconcile claims with devices", "value": len(inst), "unit": "claims with device evidence", "detail": f"{len(claims) - len(inst):,} claims no device observes are out of scope"},
        {"id": "guardrails", "title": "Apply guardrails", "value": held, "unit": "held for an explanation",
         "detail": f"{rule_n.get('faskes_offline', 0)} faskes offline, {rule_n.get('late_anchor', 0)} late anchors, {sum(1 for x in items if x['findings'][0]['rule'] == 'hd_short_isolated')} isolated short sessions"},
        {"id": "decide", "title": "Decide", "value": n_disp, "unit": "disputes", "detail": f"{n_ver} to verify; every dispute carries its evidence"},
    ]
    report = {
        "world": "synthetic", "seed": seed,
        "headline": {"claims": len(claims), "instrumented": len(inst), "readings": len(au.r), "faskes": len(faskes), "instrumentedFaskes": instrumented_faskes,
                     "dispute": n_disp, "verify": n_ver, "pricedRp": sum(x["estRp"] for x in items), "faskesWithFindings": sum(1 for x in per_faskes if x["dispute"] or x["verify"])},
        "workflow": workflow, "modes": modes, "faskes": per_faskes, "claims": items,
        "guardrails": [{"rule": r, "title": RULE_TEXT[r], "claims": n} for r, n in rule_n.most_common() if RULE_FAMILY.get(r) == "explain" or r == "hd_short_isolated"],
        "score": None,
        "limits": [
            "A claim is only checked where a device observes it: wards without monitors and faskes without IoMT are out of reach.",
            "Devices measure what ran and for how long, never the diagnosis: severity findings are a request for review, not a dispute.",
            "A device can still be wrong or spoofed; the evidence anchor and the sequence numbers make tampering visible, not impossible.",
            "Missing readings count in the claim's favour, so an outage is never read as fraud.",
        ],
    }
    if score:
        report["score"] = {**score, "perScenario": per_scenario or [], "upcodingEstimatedRp": upcoding[0] if upcoding else None, "upcodingTrueRp": upcoding[1] if upcoding else None,
                           "note": "A synthetic world is cleaner than real data: read this as a demonstration of the mechanism, not a forecast."}
    path = out / "report.json"
    path.write_text(json.dumps(report, default=_py, ensure_ascii=False), encoding="utf-8")
    return path
