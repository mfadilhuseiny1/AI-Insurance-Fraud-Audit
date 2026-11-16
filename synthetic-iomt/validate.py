"""Check that the synthetic dataset is sound, independently of the auditor.

    python synthetic-iomt/validate.py [--data data/synthetic-iomt] [--determinism]

Exit 0 when every check passes. --determinism also regenerates twice into temporary folders and compares file hashes
(the same seed must give byte-identical files).
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit import canon, merkle_root, sha  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BINARY = {"ventilation_active", "icu_bed_occupied", "bed_occupied", "dialysis_active", "heartbeat"}
CADENCE = {"ventilation_active": 3600, "icu_bed_occupied": 3600, "bed_occupied": 3600, "spo2": 7200, "heart_rate": 7200, "dialysis_active": 300}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data" / "synthetic-iomt"))
    ap.add_argument("--determinism", action="store_true")
    a = ap.parse_args()
    d = Path(a.data)
    rd = lambda n: pd.read_csv(d / n, keep_default_na=False)  # noqa: E731
    faskes, dev, claims, r, anch, truth = rd("faskes.csv"), rd("devices.csv"), rd("claims.csv"), rd("iot_readings.csv"), rd("evidence_anchors.csv"), rd("ground_truth.csv")
    r["value"] = r["value"].astype(float)
    bad = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal bad
        bad += 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'}  {name}{(': ' + detail) if detail else ''}")

    print("structure")
    check("exactly 100,000 readings", len(r) == 100_000, f"{len(r):,}")
    check("reading_id unique", r.reading_id.is_unique)
    check("reading_hash unique", r.reading_hash.is_unique)
    check("claim ids unique; truth covers every claim", claims.kunjungan_fkrtl_id.is_unique and set(claims.kunjungan_fkrtl_id) == set(truth.kunjungan_fkrtl_id))
    check("every claim names a known faskes", set(claims.faskes_profil_id) <= set(faskes.faskes_profil_id))
    check("every reading names a known device of the same faskes", r.device_id.isin(dev.device_id).all() and (r.merge(dev, on="device_id", suffixes=("", "_d")).eval("faskes_profil_id == faskes_profil_id_d")).all())
    eps = set(r.episode_id) - {""}
    check("every reading's episode belongs to a claim", eps <= set(claims.episode_id))

    print("values")
    sp, hr = r[r.metric == "spo2"].value, r[r.metric == "heart_rate"].value
    check("SpO2 is 0 (probe off) or 50-100", ((sp == 0) | sp.between(50, 100)).all())
    check("heart rate is 0 (leads off) or 20-250", ((hr == 0) | hr.between(20, 250)).all())
    check("state metrics are 0 or 1", r[r.metric.isin(BINARY)].value.isin([0, 1]).all())
    check("cadence matches the metric", all((g.interval_sec == CADENCE[m]).all() for m, g in r.groupby("metric") if m in CADENCE))
    check("timestamps fall in 2026", r.ts.str[:4].eq("2026").all())

    print("integrity")
    g = r.sort_values(["device_id", "metric", "epoch_ms"])
    inc = g.groupby(["device_id", "metric"]).seq.apply(lambda s: s.is_monotonic_increasing and s.is_unique).all()
    check("sequence numbers rise with time per device and metric", bool(inc))
    n_bad = sum(1 for row in r.itertuples() if sha(canon(row)) != row.reading_hash)
    check("every reading hash recomputes from its own fields", n_bad == 0, f"{n_bad} differ")
    by_ep = {e: x.sort_values(["epoch_ms", "device_id", "metric", "seq"]) for e, x in r[r.episode_id != ""].groupby("episode_id")}
    mismatched = {x.episode_id for x in anch.itertuples() if merkle_root(list(by_ep[x.episode_id].reading_hash)) != x.evidence_root}
    tampered = set(truth[truth.scenario == "tampered_after_anchor"].episode_id)
    check("anchor roots mismatch for exactly the tampered episodes", mismatched == tampered, f"{len(mismatched)} mismatched, {len(tampered)} tampered")
    check("evidence is anchored before submission except where it is the late_anchor scenario", set(anch[anch.anchored_before_claim == 0].kunjungan_fkrtl_id) == set(truth[truth.scenario == "late_anchor"].kunjungan_fkrtl_id) & set(anch.kunjungan_fkrtl_id))
    rev = dev[dev.revoked_at != ""]
    check("two device keys are revoked", len(rev) == 2)

    print("truth")
    fr = truth[truth.is_fraud == 1]
    check("every fraud scenario has at least 4 examples", (fr.groupby("scenario").size() >= 4).all(), f"min {fr.groupby('scenario').size().min()}")
    check("no benign scenario is labelled fraud", truth[truth.scenario.str.startswith("benign") | truth.scenario.isin(["late_anchor"])].is_fraud.eq(0).all())
    def fact(row, key):
        for part in str(row).split(";"):
            if part.startswith(key + "="):
                try:
                    return float(part.split("=")[1])
                except ValueError:
                    return float("nan")
        return float("nan")

    cl = truth.merge(claims[["kunjungan_fkrtl_id", "inacbg_keparahan"]], on="kunjungan_fkrtl_id")
    cl["acuity"] = cl.true_facts.map(lambda x: fact(x, "acuity"))
    sev = cl[cl.scenario == "severity_upcoding"]
    check("severity upcoding: billed III, delivered care low", (sev.inacbg_keparahan == "III").all() and (sev.acuity < 0.5).all(), f"{len(sev)} claims")
    honest_iii = cl[(cl.scenario == "honest") & (cl.inacbg_keparahan == "III") & cl.claim_type.isin(["VENT", "ICU"])]
    check("honest severity III follows the care delivered (acuity >= 0.6)", (honest_iii.acuity >= 0.6).all(), f"{len(honest_iii)} claims")
    over = truth[truth.scenario.isin(["severity_upcoding", "upcoding_vent_hours", "niv_billed_as_invasive", "phantom_vent"])].true_facts.map(lambda x: fact(x, "overbilled_rp"))
    check("every code/tier upcoding claim carries its true overbilling", over.notna().all() and (over >= 0).all(), f"Rp {over.sum() / 1e6:,.0f} M")
    t = truth.merge(claims[["kunjungan_fkrtl_id", "faskes_profil_id"]], on="kunjungan_fkrtl_id", suffixes=("", "_c"))
    gt = rd("ground_truth_faskes.csv")
    hi = gt[gt.risk_tier == "high"]
    check("fraud concentrates in the high-risk faskes", hi.fraud_claims.sum() / max(1, gt.fraud_claims.sum()) > 0.45, f"{hi.fraud_claims.sum()} of {gt.fraud_claims.sum()}")

    if a.determinism:
        print("determinism")
        gen = Path(__file__).resolve().parent / "generate.py"
        hashes = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                subprocess.run([sys.executable, "-I", str(gen), "--out", tmp], check=True, capture_output=True)
                hashes.append({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path(tmp).glob("*.csv"))})
        check("two runs with the same seed give identical files", hashes[0] == hashes[1], f"{len(hashes[0])} files")

    print("PASS" if bad == 0 else f"{bad} check(s) failed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
