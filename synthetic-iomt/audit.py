"""A baseline IoMT claim auditor for the synthetic dataset: try an audit, then score it.

    python synthetic-iomt/audit.py [--data data/synthetic-iomt] [--out data/synthetic-iomt/audit_out] [--no-score]

It reads ONLY what an auditor would have: faskes, devices, claims, iot_readings, evidence_anchors. It never opens
ground_truth*.csv while auditing; scoring against the truth is a separate last step (skip it with --no-score).

For each claim it compares what the claim says with what the devices recorded and writes:
  findings.csv     one row per finding: claim, rule, claimed vs measured, the evidence, dispute or verify
  claim_flags.csv  one row per claim: the strongest flag and every reason
  report.md        the scorecard (per scenario) and the findings that need a person

Two flags only. DISPUTE: the devices contradict the claim and the evidence is sound. VERIFY: something needs an explanation
but is not an accusation (evidence is incomplete, or was anchored late). The baseline is deliberately conservative: where
readings are missing it gives the claim the benefit of the doubt, because a gateway outage is not fraud.

These are plain rules, a floor to beat, not a model. An agent swarm should do better by reading the same tables.
"""
from __future__ import annotations

import argparse
import hashlib
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I drops the script's folder from the path
TOL_H = 2  # hours of slack on measured durations
# the pump delivers 100 ml per vial; a claim is accepted up to measured * 1.15 + 1
SEV = {"none": 0, "verify": 1, "dispute": 2}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def merkle_root(leaf_hexes: list[str]) -> str:
    if not leaf_hexes:
        return "0x" + "00" * 32
    layer = [hashlib.sha256(bytes.fromhex(h)).digest() for h in leaf_hexes]
    while len(layer) > 1:
        nxt = []
        for i in range(0, len(layer), 2):
            if i + 1 < len(layer):
                a, b = layer[i], layer[i + 1]
                nxt.append(hashlib.sha256(a + b if a <= b else b + a).digest())
            else:
                nxt.append(layer[i])
        layer = nxt
    return "0x" + layer[0].hex()


def canon(row) -> str:
    return f"{row.device_id}|{row.episode_id if isinstance(row.episode_id, str) else ''}|{row.metric}|{row.epoch_ms}|{row.seq}|{float(row.value):g}|{row.interval_sec}|{row.attr if isinstance(row.attr, str) else ''}"


class Audit:
    def __init__(self, data: Path):
        rd = lambda n, **k: pd.read_csv(data / n, **k)  # noqa: E731
        self.faskes = rd("faskes.csv", dtype=str)
        self.devices = rd("devices.csv")
        self.claims = rd("claims.csv", dtype={"kelas_rawat": "string", "implan_serial_diklaim": "string"})
        self.r = rd("iot_readings.csv", keep_default_na=False)
        self.r["value"] = self.r["value"].astype(float)
        self.anch = rd("evidence_anchors.csv")
        self.findings: list[dict] = []
        self.short_hd: list[tuple] = []
        self.prov = dict(zip(self.faskes.faskes_profil_id, self.faskes.provinsi_kode))

    # ------------------------------------------------------------------ plumbing
    def add(self, c, rule: str, flag: str, claimed, measured, why: str) -> None:
        self.findings.append({"kunjungan_fkrtl_id": c.kunjungan_fkrtl_id, "episode_id": c.episode_id if isinstance(c.episode_id, str) else "", "faskes_profil_id": c.faskes_profil_id,
                              "rule": rule, "flag": flag, "claimed": claimed, "measured": measured, "evidence": why})

    def features(self) -> None:
        """Per-episode facts from the readings, with missing readings counted from the sequence numbers."""
        r = self.r[self.r.episode_id != ""].copy()
        self.by_ep = {ep: g.sort_values("epoch_ms") for ep, g in r.groupby("episode_id")}
        self.ep_feat: dict[str, dict] = {}
        for ep, g in self.by_ep.items():
            f: dict = {"rows": len(g)}
            miss = tot = 0
            for (_, _), s in g.groupby(["device_id", "metric"]):
                if s.metric.iloc[0] in ("pos_checkin", "dispense_scan", "imaging_exam", "infusion_ml") and s.metric.iloc[0] != "infusion_ml":
                    continue  # events: no cadence to judge a gap by
                lo, hi = s.seq.min(), s.seq.max()
                miss += int(hi - lo + 1 - len(s))
                tot += int(hi - lo + 1)
            f["missing"], f["completeness"] = miss, (1 - miss / tot) if tot else 1.0
            v = g[g.metric == "ventilation_active"]
            f["vent_rows"] = len(v)
            f["imv_h"] = float(((v.attr == "IMV") & (v.value == 1)).sum())
            f["niv_h"] = float(((v.attr == "NIV") & (v.value == 1)).sum())
            f["standby"] = int((v.attr == "STANDBY").sum())
            f["max_imv_run"] = self.max_run(v[v.attr == "IMV"])
            f["vent_missing"] = int(v.seq.max() - v.seq.min() + 1 - len(v)) if len(v) else 0
            ib = g[g.metric == "icu_bed_occupied"]
            f["icu_rows"], f["icu_h"] = len(ib), float((ib.value == 1).sum())
            f["icu_missing"] = int(ib.seq.max() - ib.seq.min() + 1 - len(ib)) if len(ib) else 0
            wb = g[g.metric == "bed_occupied"]
            f["ward_rows"], f["ward_h"] = len(wb), float((wb.value == 1).sum())
            f["ward_missing"] = int(wb.seq.max() - wb.seq.min() + 1 - len(wb)) if len(wb) else 0
            f["empty_tail_h"] = self.tail_empty(pd.concat([ib, wb]).sort_values("epoch_ms"))
            inf = g[g.metric == "infusion_ml"]
            f["drug_ml"], f["drug_events"] = float(inf.value.sum()), len(inf)
            f["img_n"] = int((g.metric == "imaging_exam").sum())
            hd = g[g.metric == "dialysis_active"]
            f["hd_rows"], f["hd_min"] = len(hd), float((hd.value == 1).sum() * 5)
            f["serials"] = set(g[g.metric == "dispense_scan"].attr)
            f["pos"] = int((g.metric == "pos_checkin").sum())
            sp = g[g.metric == "spo2"].value
            sp = sp[sp > 0]  # 0 is a probe-off artefact, not a reading
            hrv = g[g.metric == "heart_rate"].value
            hrv = hrv[hrv > 0]
            f["instab"] = float(np.mean([(sp < 92).mean() if len(sp) else 0.0, ((hrv > 110) | (hrv < 50)).mean() if len(hrv) else 0.0]))
            f["img_acq"] = float(g[g.metric == "imaging_exam"].value.sum())
            f["first_ms"], f["last_ms"] = int(g.epoch_ms.min()), int(g.epoch_ms.max())
            self.ep_feat[ep] = f

    @staticmethod
    def max_run(v: pd.DataFrame) -> float:
        """Longest unbroken run of 'on' hours; readings that are missing inside it count as on (benefit of the doubt)."""
        best, start, last = 0, None, None
        for val, seq in zip(v.value.to_numpy(), v.seq.to_numpy()):
            if val == 1:
                start = seq if start is None else start
                last = seq
                best = max(best, last - start + 1)
            else:
                start = last = None
        return float(best)

    @staticmethod
    def tail_empty(bed: pd.DataFrame) -> float:
        n = 0
        for val in bed.value.to_numpy()[::-1]:
            if val == 0:
                n += 1
            else:
                break
        return float(n)

    # ------------------------------------------------------------------ rules
    def run(self) -> None:
        self.features()
        self.integrity()
        feats = self.ep_feat
        no_rows = []
        for c in self.claims.itertuples():
            ep = c.episode_id if isinstance(c.episode_id, str) else ""
            if not ep:
                continue  # no device observes this claim at all
            f = feats.get(ep)
            if f is None:
                no_rows.append(c)
                continue
            self.vent_rules(c, f)
            self.stay_rules(c, f)
            self.drug_imaging_rules(c, f)
            self.hd_rules(c, f)
            self.implant_rules(c, f)
            if f["completeness"] < 0.9:
                self.add(c, "evidence_incomplete", "verify", "", f"{f['completeness']:.0%} of expected readings", f"{f['missing']} readings are missing by the devices' own sequence numbers; counts below are lower bounds")
        self.ghost_rules(no_rows)
        self.split_stays()
        self.cross_claim()
        self.severity_rules()

    def integrity(self) -> None:
        dev_rev = {d.device_id: pd.Timestamp(d.revoked_at).value // 10**6 for d in self.devices.itertuples() if isinstance(d.revoked_at, str)}
        claim_of = {c.episode_id: c for c in self.claims.itertuples() if isinstance(c.episode_id, str)}
        self.row_hash_bad = 0
        for a in self.anch.itertuples():
            g = self.by_ep.get(a.episode_id)
            c = claim_of.get(a.episode_id)
            if g is None or c is None:
                continue
            g = g.sort_values(["epoch_ms", "device_id", "metric", "seq"])
            bad = sum(1 for row in g.itertuples() if sha(canon(row)) != row.reading_hash)
            self.row_hash_bad += bad
            root = merkle_root(list(g.reading_hash))
            if root != a.evidence_root or len(g) != a.reading_count or bad:
                self.add(c, "anchor_mismatch", "dispute", f"anchored {a.reading_count} readings", f"delivered {len(g)}, root differs" if root != a.evidence_root else f"{bad} rows fail their hash",
                         "the readings delivered with the claim do not hash to the root the faskes anchored before submitting it")
            if not a.anchored_before_claim:
                self.add(c, "late_anchor", "verify", f"claim submitted {a.claim_submitted_at[:10]}", f"anchored {a.anchored_at[:10]}", "the evidence was anchored after the claim was submitted: needs an explanation")
            rv = [d for d in set(g.device_id) if d in dev_rev]
            for d in rv:
                n = int(((g.device_id == d) & (g.epoch_ms >= dev_rev[d])).sum())
                if n:
                    self.add(c, "revoked_device", "dispute", "", f"{n} readings after revocation", f"device {d} was revoked at {self.devices.set_index('device_id').revoked_at[d][:10]}; its later readings are inadmissible")

    def vent_rules(self, c, f) -> None:
        proc = str(c.prosedur)
        invasive = any(p in proc for p in ("96.70", "96.71", "96.72"))
        if not invasive:
            return
        claimed = float(c.ventilator_jam_diklaim) if pd.notna(c.ventilator_jam_diklaim) and c.ventilator_jam_diklaim != "" else 0.0
        if f["vent_rows"] == 0:
            self.add(c, "vent_no_device", "dispute", f"{claimed:.0f} h invasive", "no ventilator readings", "invasive ventilation billed, no ventilator stream for the episode")
            return
        if f["standby"] and f["imv_h"] == 0 and f["niv_h"] == 0:
            self.add(c, "vent_standby", "dispute", f"{claimed:.0f} h invasive", "ventilator in STANDBY, 0 h running", "the ventilator never ran during the billed stay")
            return
        if f["imv_h"] == 0 and f["niv_h"] > 0:
            self.add(c, "niv_as_invasive", "dispute", f"{claimed:.0f} h invasive", f"{f['niv_h']:.0f} h non-invasive (NIV)", "the ventilator ran in non-invasive mode; invasive ventilation (96.7x) is not supported")
            return
        ub = f["imv_h"] + f["vent_missing"]
        if "96.72" in proc and f["max_imv_run"] < 96:
            self.add(c, "vent_run_96", "dispute", "96.72 (>= 96 h in a row)", f"longest run {f['max_imv_run']:.0f} h", "96.72 needs 96 consecutive hours of invasive ventilation; the ventilator never ran that long in a row")
        elif claimed > ub * 1.15 + TOL_H:
            self.add(c, "vent_hours", "dispute", f"{claimed:.0f} h", f"{f['imv_h']:.0f} h (+{f['vent_missing']} missing)", "more ventilator hours billed than the device recorded")

    def stay_rules(self, c, f) -> None:
        icu_c = c.icu_hari_diklaim if pd.notna(c.icu_hari_diklaim) and c.icu_hari_diklaim != "" else 0
        icu_c = float(icu_c)
        if icu_c > 0:
            if f["icu_rows"] == 0 and f["ward_rows"] > 0:
                self.add(c, "icu_phantom", "dispute", f"{icu_c:.0f} ICU days", "no ICU bed occupancy; ward bed only", "ICU days billed, but the patient was only ever recorded in a ward bed")
            elif f["icu_rows"]:
                days = math.ceil((f["icu_h"] + f["icu_missing"]) / 24)
                if icu_c > days + 1:
                    self.add(c, "icu_days", "dispute", f"{icu_c:.0f} days", f"{days} days ({f['icu_h']:.0f} h occupied)", "more ICU days billed than the ICU bed was occupied")
        occ = f["icu_h"] + f["ward_h"] + f["icu_missing"] + f["ward_missing"]
        if (f["icu_rows"] or f["ward_rows"]) and str(c.tingkat_pelayanan) == "Rawat Inap" and not str(c.poli) == "Kardiologi":
            days = math.ceil(occ / 24)
            if c.los_hari > days + 1 and f["empty_tail_h"] >= 24:
                self.add(c, "los_padding", "dispute", f"{c.los_hari} days", f"{days} days occupied, bed empty the last {f['empty_tail_h']:.0f} h", "the bed read empty after the patient left; the billed discharge is later")

    def drug_imaging_rules(self, c, f) -> None:
        if pd.notna(c.obat_khusus_unit_diklaim) and c.obat_khusus_unit_diklaim != "":
            claimed = float(c.obat_khusus_unit_diklaim)
            measured = f["drug_ml"] / 100.0
            lost = f["missing"] / 4  # a coarse allowance for dropped events
            if claimed > (measured + lost) * 1.15 + 1:
                self.add(c, "drug_units", "dispute", f"{claimed:.0f} vials", f"{measured:.1f} vials infused ({f['drug_events']} doses)", "more doses of a high-cost drug billed than the infusion pump delivered")
        if pd.notna(c.radiologi_diklaim_n) and c.radiologi_diklaim_n != "":
            claimed = float(c.radiologi_diklaim_n)
            slack = 2 if f["missing"] > 0 else 0  # a gateway outage can swallow an exam or two
            if claimed > f["img_n"] + slack:
                if f["img_acq"] > f["img_n"] and claimed <= f["img_acq"] + slack:
                    self.add(c, "imaging_unbundled", "dispute", f"{claimed:.0f} exams", f"{f['img_n']} exam(s) with {f['img_acq']:.0f} acquisitions", "every acquisition of a multi-series exam was billed as its own exam: unbundling")
                else:
                    self.add(c, "imaging_count", "dispute", f"{claimed:.0f} exams", f"{f['img_n']} exams logged", "more imaging exams billed than the imaging device recorded")

    def hd_rules(self, c, f) -> None:
        if str(c.prosedur) != "39.95":
            return
        if f["hd_rows"] and f["hd_min"] == 0:
            self.add(c, "hd_phantom", "dispute", "1 session", "machine powered, 0 min dialysis", "a dialysis session billed; the machine ran no session")
        elif f["hd_rows"] and f["hd_min"] < 180:
            self.short_hd.append((c, f["hd_min"]))  # decided per faskes in cross_claim: one early stop is clinical, a pattern is not

    def implant_rules(self, c, f) -> None:
        if pd.notna(c.implan_serial_diklaim) and str(c.implan_serial_diklaim):
            claimed = set(str(c.implan_serial_diklaim).split(";"))
            extra = claimed - f["serials"]
            if extra:
                self.add(c, "implant_unscanned", "dispute", f"{len(claimed)} stents", f"{len(f['serials'])} scanned out", f"{len(extra)} billed serial(s) were never scanned out of the smart cabinet")

    def ghost_rules(self, no_rows: list) -> None:
        hb = self.r[(self.r.metric == "heartbeat") & (self.r.attr == "gateway")]
        up = defaultdict(set)
        for fk, ms in zip(hb.faskes_profil_id, hb.epoch_ms):
            up[fk].add(pd.Timestamp(ms, unit="ms", tz="UTC").tz_convert("Asia/Jakarta").strftime("%Y-%m-%d"))
        for c in no_rows:
            fk = c.faskes_profil_id
            if fk not in up:
                continue  # an uninstrumented faskes: nothing to compare
            days = pd.date_range(c.tgl_datang, c.tgl_pulang).strftime("%Y-%m-%d")
            alive = sum(1 for d in days if d in up[fk])
            if alive < max(1, math.ceil(len(days) / 2)):
                self.add(c, "faskes_offline", "verify", "", f"gateway silent on {len(days) - alive} of {len(days)} day(s)", "no reading, but the faskes's gateway sent no heartbeat on those days either: an outage, not a ghost; ask for the data after it reconnects")
                continue
            outpatient = str(c.tingkat_pelayanan) == "Rawat Jalan" and str(c.prosedur) != "39.95"
            rule = "visit_no_checkin" if outpatient else "no_device_trace"
            why = "an outpatient visit billed, with no check-in recorded; the faskes was online" if outpatient else "ICU, ventilation, dialysis, stent or ward stay billed with no reading at all, while the faskes's gateway was reporting"
            self.add(c, rule, "dispute", "1 visit" if outpatient else "billed service", "no readings for the episode", why)

    def split_stays(self) -> None:
        c = self.claims[(self.claims.tingkat_pelayanan == "Rawat Inap") & self.claims.episode_id.notna()].copy()
        c["t0"] = pd.to_datetime(c.waktu_datang)
        c["t1"] = pd.to_datetime(c.waktu_pulang)
        for _, g in c.groupby(["peserta_id", "faskes_profil_id", "dx_primer_kode"]):
            if len(g) < 2:
                continue
            g = g.sort_values("t0")
            rows = list(g.itertuples())
            for a, b in zip(rows, rows[1:]):
                gap = (b.t0 - a.t1).total_seconds() / 3600
                if not -1 <= gap <= 6:
                    continue
                fa, fb = self.ep_feat.get(a.episode_id), self.ep_feat.get(b.episode_id)
                if not fa or not fb:
                    continue
                ga, gb = self.by_ep[a.episode_id], self.by_ep[b.episode_id]
                wa, wb = ga[ga.metric == "bed_occupied"], gb[gb.metric == "bed_occupied"]
                if len(wa) and len(wb) and wa.device_id.iloc[-1] == wb.device_id.iloc[0]:
                    d = (wb.epoch_ms.iloc[0] - wa.epoch_ms.iloc[-1]) / 3.6e6
                    if d <= 1.5 and wa.value.iloc[-1] == 1:
                        self.add(b, "split_stay", "dispute", f"a new admission {gap:.1f} h after discharge", f"the same bed stayed occupied, {d:.1f} h between readings",
                                 f"one continuous stay billed as two (previous claim {a.kunjungan_fkrtl_id})")

    @staticmethod
    def acuity_index(f: dict) -> float:
        """0 (stable) to 1 (critical), from what the devices measured: vitals instability, ICU hours, invasive ventilation, infusion doses."""
        return (0.45 * min(1, f["instab"] / 0.2) + 0.25 * min(1, (f["icu_h"] + f["icu_missing"]) / 120)
                + 0.20 * min(1, f["imv_h"] / 96) + 0.10 * min(1, f["drug_events"] / 15))

    def severity_rules(self) -> None:
        """Severity III pays far more than II. Devices cannot confirm a diagnosis, but they measure the intensity of care that a
        severity level implies. A stay billed III whose measured acuity is no higher than the typical stay billed II is sent for review."""
        stays = []
        for c in self.claims.itertuples():
            f = self.ep_feat.get(c.episode_id if isinstance(c.episode_id, str) else "")
            if f and (f["icu_rows"] or f["vent_rows"]) and str(c.tingkat_pelayanan) == "Rawat Inap" and str(c.poli) != "Kardiologi":
                stays.append((c, f, "VENT" if f["vent_rows"] else "ICU", self.acuity_index(f)))
        self.stays = {c.kunjungan_fkrtl_id: (kind, idx) for c, f, kind, idx in stays}
        self.ref_tariff: dict[str, float] = {}
        for kind in ("VENT", "ICU"):
            ii = [(c, idx) for c, f, k, idx in stays if k == kind and c.inacbg_keparahan == "II"]
            if len(ii) < 8:
                continue
            ref = float(np.percentile([i for _, i in ii], 60))
            self.ref_tariff[kind] = float(np.median([c.tarif_inacbg_rp for c, _ in ii]))
            for c, f, k, idx in stays:
                if k == kind and c.inacbg_keparahan == "III" and idx <= ref and f["completeness"] >= 0.9:
                    self.add(c, "severity_vs_acuity", "verify", "severity III", f"acuity index {idx:.2f}; typical severity II stay: {ref:.2f}",
                             f"the measured intensity of care ({f['icu_h']:.0f} ICU h, {f['imv_h']:.0f} h ventilated, {f['drug_events']} infusion doses, {f['instab']:.0%} unstable vitals) is no higher than a typical severity II stay: review the severity coding")

    def clones(self) -> None:
        """Vitals do not repeat: a run of eight identical 2-hourly SpO2 values AND heart rates in two episodes is a copy."""
        seen: dict[str, str] = {}
        starts = {c.episode_id: c.waktu_datang for c in self.claims.itertuples() if isinstance(c.episode_id, str)}
        claim_of = {c.episode_id: c for c in self.claims.itertuples() if isinstance(c.episode_id, str)}
        for ep in sorted(self.by_ep, key=lambda e: starts.get(e, "")):
            g = self.by_ep[ep]
            sp = g[g.metric == "spo2"].value.round(1).to_numpy()
            hr = g[g.metric == "heart_rate"].value.round(0).to_numpy()
            if len(sp) < 8 or len(hr) < 8:
                continue
            hits = set()
            for i in range(0, len(sp) - 7, 4):
                key = "|".join(map(str, sp[i:i + 8])) + "#" + "|".join(map(str, hr[i:i + 8]))
                if len(set(sp[i:i + 8])) > 2:  # a flat stretch (all 98) proves nothing
                    if key in seen and seen[key] != ep:
                        hits.add(seen[key])
                    seen.setdefault(key, ep)
            for src in hits:
                self.add(claim_of[ep], "cloned_vitals", "dispute", "a stay backed by device data", f"identical SpO2 + heart-rate runs as episode {src}", "vitals do not repeat to the decimal across patients: this episode's readings are a copy of an earlier one")

    def cross_claim(self) -> None:
        self.clones()
        hd_all = self.claims[self.claims.prosedur.astype(str) == "39.95"].groupby("faskes_profil_id").size()
        short_by = defaultdict(list)
        for c, m in self.short_hd:
            short_by[c.faskes_profil_id].append((c, m))
        for fk, lst in short_by.items():
            pattern = len(lst) >= 3 and len(lst) / hd_all.get(fk, 1) >= 0.12
            for c, m in lst:
                if pattern:
                    self.add(c, "hd_short", "dispute", "1 full session", f"{m:.0f} min", f"a standard session is 4-5 h; {len(lst)} of this faskes's {hd_all.get(fk, 0)} dialysis claims ran under 3 h: a pattern, not an isolated clinical event")
                else:
                    self.add(c, "hd_short_isolated", "verify", "1 full session", f"{m:.0f} min", "the machine ran under 3 h; isolated, so plausibly clinical (hypotension, access): ask for the session note")
        c = self.claims
        # the same participant, facility and day billed twice for dialysis
        hd = c[c.prosedur.astype(str) == "39.95"]
        for _, g in hd.groupby(["peserta_id", "faskes_profil_id", "tgl_datang"]):
            if len(g) < 2:
                continue
            ran = [(self.ep_feat.get(e, {}).get("hd_min", 0), x) for x, e in zip(g.itertuples(), g.episode_id)]
            sessions = sum(1 for m, _ in ran if m > 0)
            if sessions < len(g):
                for m, x in ran:
                    if m == 0:
                        self.add(x, "hd_duplicate", "dispute", "a second session the same day", f"{sessions} session(s) on the machine", "the same participant billed twice at one faskes on one day; the machine ran fewer sessions")
        # the same implant serial billed in two claims
        seen: dict[str, str] = {}
        for x in c[c.implan_serial_diklaim.notna()].sort_values("waktu_datang").itertuples():
            for s in str(x.implan_serial_diklaim).split(";"):
                if s in seen and seen[s] != x.kunjungan_fkrtl_id:
                    self.add(x, "implant_serial_reuse", "dispute", f"serial {s}", f"already billed in {seen[s]}", "the same implant serial billed in two claims")
                seen.setdefault(s, x.kunjungan_fkrtl_id)
        # one participant checking in at two faskes in different provinces at the same time
        pos = self.r[self.r.metric == "pos_checkin"]
        pos = pos[pos.value == 1]
        by_claim = {e: x for x, e in zip(c.itertuples(), c.episode_id) if isinstance(e, str)}
        for who, g in pos.groupby("attr"):
            if g.faskes_profil_id.nunique() < 2:
                continue
            g = g.sort_values("epoch_ms")
            rows = list(g.itertuples())
            for a, b in zip(rows, rows[1:]):
                if a.faskes_profil_id != b.faskes_profil_id and self.prov[a.faskes_profil_id] != self.prov[b.faskes_profil_id] and (b.epoch_ms - a.epoch_ms) < 3 * 3.6e6:
                    for t in (a, b):
                        x = by_claim.get(t.episode_id)
                        if x is not None:
                            self.add(x, "impossible_travel", "dispute", f"check-in at {t.faskes_profil_id}", f"the same participant at {a.faskes_profil_id if t is b else b.faskes_profil_id} {abs(b.epoch_ms - a.epoch_ms) / 6e4:.0f} min apart", "one participant checked in at two faskes in different provinces at the same time")

    # ------------------------------------------------------------------ output
    def flags(self) -> pd.DataFrame:
        f = pd.DataFrame(self.findings)
        rows = []
        for cid in self.claims.kunjungan_fkrtl_id:
            g = f[f.kunjungan_fkrtl_id == cid] if len(f) else f
            top = "none"
            for x in g.flag:
                top = x if SEV[x] > SEV[top] else top
            rows.append({"kunjungan_fkrtl_id": cid, "flag": top, "rules": ";".join(sorted(set(g.rule))) if len(g) else "", "n_findings": len(g)})
        return pd.DataFrame(rows)


def score(flags: pd.DataFrame, truth: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    t = truth.merge(flags, on="kunjungan_fkrtl_id")
    partners = set()
    for r in t.itertuples():
        for key in ("split_partner", "also_at", "duplicate_of", "continuous_with"):
            for part in str(r.true_facts).split(";"):
                if part.startswith(key + "="):
                    partners.add(part.split("=")[1])
                    partners.add(r.kunjungan_fkrtl_id)
    t["partner_of_fraud"] = t.kunjungan_fkrtl_id.isin(partners)
    # right = a dispute where one was due; anything but an accusation where none was (the honest partner of a fraudulent pair may be flagged with it)
    review = (t.expected_flag == "verify") & (t.is_fraud == 1)  # fraud devices can only send for review (severity upcoding)
    t["hit"] = np.where(t.expected_flag == "dispute", t.flag == "dispute", np.where(review, t.flag != "none", (t.flag != "dispute") | t.partner_of_fraud))
    out = []
    for scn, g in t.groupby("scenario"):
        exp = g.expected_flag.iloc[0]
        out.append({"scenario": scn, "claims": len(g), "expected": exp, "flagged_dispute": int((g.flag == "dispute").sum()), "flagged_verify": int((g.flag == "verify").sum()),
                    "ok": int(g.hit.sum()), "rate": g.hit.mean()})
    sc = pd.DataFrame(out).sort_values(["expected", "rate"], ascending=[True, False])
    fraud = t[(t.expected_flag == "dispute")]
    disputed = t[t.flag == "dispute"]
    related = disputed.partner_of_fraud & (disputed.is_fraud == 0)
    summary = {
        "claims": len(t), "fraud_assessable": len(fraud), "caught": int((fraud.flag == "dispute").sum()), "recall": float((fraud.flag == "dispute").mean()),
        "disputed": len(disputed), "true_disputes": int((disputed.is_fraud == 1).sum()), "partner_disputes": int(related.sum()),
        "false_disputes": int(((disputed.is_fraud == 0) & ~disputed.partner_of_fraud).sum()),
        "precision": float((disputed.is_fraud == 1).mean() if len(disputed) else 0),
        "benign_accused": int(((t.expected_flag == "verify") & (t.flag == "dispute")).sum()),
        "honest_accused": int(((t.scenario.isin(["honest", "unmonitored_honest"])) & (t.flag == "dispute") & ~t.partner_of_fraud).sum()),
        "out_of_scope_fraud": int(((t.scenario == "fraud_outside_iomt_scope")).sum()),
        "review_fraud": int(review.sum()), "review_flagged": int((review & (t.flag != "none")).sum()),
    }
    return sc, summary


FAMILIES = [
    ("Severity tier (III billed instead of II)", ["severity_upcoding"], "acuity index from vitals, ICU hours, ventilation, infusions", "VERIFY: devices show intensity of care, not the diagnosis"),
    ("Ventilation code (96.7x)", ["upcoding_vent_hours", "niv_billed_as_invasive", "phantom_vent"], "ventilator runs, mode (IMV / NIV / STANDBY)", "DISPUTE: the device states what ran"),
    ("Dialysis session", ["hd_short_session", "hd_phantom_session"], "dialysis_active minutes", "DISPUTE on a faskes pattern; VERIFY when isolated"),
    ("Imaging unbundling", ["unbundled_imaging"], "imaging_exam acquisitions vs billed exams", "DISPUTE: one exam, several acquisitions"),
]


def fact(s: str, key: str) -> float:
    for part in str(s).split(";"):
        if part.startswith(key + "="):
            try:
                return float(part.split("=")[1])
            except ValueError:
                return 0.0
    return 0.0


def upcoding_report(au: "Audit", flags: pd.DataFrame, truth: pd.DataFrame, out: Path) -> tuple[float, float]:
    """Upcoding on its own: what device evidence answers it, how well, and what it is worth in rupiah."""
    t = truth.merge(flags, on="kunjungan_fkrtl_id").merge(au.claims[["kunjungan_fkrtl_id", "tarif_inacbg_rp", "inacbg_keparahan"]], on="kunjungan_fkrtl_id")
    t["over_true"] = t.true_facts.map(lambda x: fact(x, "overbilled_rp"))
    L = ["# Upcoding and the IoMT evidence that answers it", "",
         "Upcoding is billing a higher tariff than the care delivered supports. It hides in four places, and each has a device signal.", "",
         "| where it hides | what the claim says | what the devices measure | outcome |", "|---|---|---|---|"]
    for name, scns, signal, outcome in FAMILIES:
        L.append(f"| {name} | a higher code, tier or count | {signal} | {outcome} |")
    L += ["", "## Results on this data", "", "| family | claims | disputed | to review | missed | overbilling, ground truth (Rp million) | overbilling, auditor estimate (Rp million) |", "|---|---|---|---|---|---|---|"]
    tot_true = tot_est = 0.0
    for name, scns, _, _ in FAMILIES:
        g = t[t.scenario.isin(scns)]
        if g.empty:
            continue
        true_rp = g.over_true.sum()
        flagged = g[g.flag != "none"]
        est = 0.0
        for r in flagged.itertuples():
            kind = au.stays.get(r.kunjungan_fkrtl_id, ("", 0))[0]
            if kind in au.ref_tariff and name.startswith(("Severity", "Ventilation")):
                est += max(0.0, r.tarif_inacbg_rp - au.ref_tariff[kind])
        tot_true += true_rp
        tot_est += est
        L.append(f"| {name} | {len(g)} | {(g.flag == 'dispute').sum()} | {(g.flag == 'verify').sum()} | {(g.flag == 'none').sum()} | {true_rp / 1e6:,.0f} million | {est / 1e6:,.0f} million |" if true_rp or est else
                 f"| {name} | {len(g)} | {(g.flag == 'dispute').sum()} | {(g.flag == 'verify').sum()} | {(g.flag == 'none').sum()} | n/a | n/a |")
    L += ["", f"For the severity and ventilation families the auditor prices each flagged claim as its tariff minus the median tariff of a severity II stay of the same kind: **Rp {tot_est / 1e6:,.0f} million estimated against Rp {tot_true / 1e6:,.0f} million true overbilling**.", ""]
    st = [(cid, k, i) for cid, (k, i) in au.stays.items()]
    if st:
        df = pd.DataFrame(st, columns=["kunjungan_fkrtl_id", "kind", "acuity"]).merge(t[["kunjungan_fkrtl_id", "inacbg_keparahan", "scenario"]], on="kunjungan_fkrtl_id")
        df["acuity_third"] = pd.qcut(df.acuity, 3, labels=["lowest third", "middle third", "highest third"])
        L += ["## Billed severity against measured acuity (ICU and ventilated stays)", "",
              "If severity followed the care delivered, III would sit in the highest third. Stays billed III in the lowest third are the severity upcoding.", "",
              "| measured acuity | billed II | billed III | of which upcoded (ground truth) |", "|---|---|---|---|"]
        up = ["severity_upcoding", "upcoding_vent_hours", "niv_billed_as_invasive", "phantom_vent"]
        for third, g in df.groupby("acuity_third", observed=True):
            L.append(f"| {third} | {(g.inacbg_keparahan == 'II').sum()} | {(g.inacbg_keparahan == 'III').sum()} | {g.scenario.isin(up).sum()} |")
        L.append("")
    L += ["## What IoMT does not do here", "",
          "- It measures the intensity of care, never the diagnosis. A stable patient can still have documented comorbidities that justify severity III: that stays with the clinical verifier, so severity upcoding is a VERIFY, not a DISPUTE.",
          "- A claim is only checked where a device observes it. Upcoding on a ward with no vitals monitor, or at a faskes with no IoMT coverage, is out of reach.",
          "- Missing readings count in the claim's favour, so a gateway outage is never read as upcoding."]
    (out / "upcoding_report.md").write_text("\n".join(L), encoding="utf-8")
    print(f"wrote {out / 'upcoding_report.md'}")
    return tot_est, tot_true


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=str(ROOT / "data" / "synthetic-iomt"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-score", action="store_true")
    a = ap.parse_args()
    data = Path(a.data)
    out = Path(a.out) if a.out else data / "audit_out"
    out.mkdir(parents=True, exist_ok=True)
    au = Audit(data)
    au.run()
    fnd = pd.DataFrame(au.findings)
    fnd.to_csv(out / "findings.csv", index=False)
    flags = au.flags()
    flags.to_csv(out / "claim_flags.csv", index=False)
    lines = ["# Audit of the synthetic IoMT + claims data", "",
             f"{len(au.claims):,} claims, {len(au.r):,} device readings, {len(au.anch):,} anchored episodes. {int((flags.flag == 'dispute').sum())} claims disputed, {int((flags.flag == 'verify').sum())} to verify.", ""]
    by_rule = fnd.groupby(["rule", "flag"]).size().reset_index(name="findings").sort_values("findings", ascending=False)
    lines += ["## Findings by rule", "", "| rule | flag | findings |", "|---|---|---|"] + [f"| {r.rule} | {r.flag} | {r.findings} |" for r in by_rule.itertuples()] + [""]
    sm = sc = upc = None
    if not a.no_score:
        truth = pd.read_csv(data / "ground_truth.csv", keep_default_na=False)
        sc, sm = score(flags, truth)
        sc.to_csv(out / "scorecard.csv", index=False)
        lines += ["## Scorecard against the ground truth", "",
                  f"- Fraud the devices can see: **{sm['caught']} of {sm['fraud_assessable']} caught ({sm['recall']:.0%})**.",
                  f"- Of {sm['disputed']} disputes: {sm['true_disputes']} are fraud, {sm['partner_disputes']} are the honest partner of a fraudulent pair (to be reviewed together), **{sm['false_disputes']} are wrong**. Precision {sm['precision']:.0%}.",
                  f"- Benign anomalies wrongly accused (a gateway outage, late anchoring): **{sm['benign_accused']}**. Honest claims accused: **{sm['honest_accused']}**.",
                  f"- Fraud the devices can only send for review (severity upcoding): **{sm['review_flagged']} of {sm['review_fraud']} flagged**.",
                  f"- Fraud no device can see ({sm['out_of_scope_fraud']} padded bills) is out of reach of this evidence by construction.", "",
                  "| scenario | claims | expected | disputed | to verify | right | |", "|---|---|---|---|---|---|---|"]
        lines += [f"| {r.scenario} | {r.claims} | {r.expected} | {r.flagged_dispute} | {r.flagged_verify} | {r.ok} | {r.rate:.0%} |" for r in sc.itertuples()]
        lines.append("")
        print(f"fraud caught {sm['caught']}/{sm['fraud_assessable']} ({sm['recall']:.0%}); disputes {sm['disputed']} (fraud {sm['true_disputes']}, partner {sm['partner_disputes']}, wrong {sm['false_disputes']}); benign accused {sm['benign_accused']}; honest accused {sm['honest_accused']}")
        print(sc.to_string(index=False))
        upc = upcoding_report(au, flags, truth, out)
    from report import build_report

    seed = None
    try:
        import json as _json

        seed = _json.loads((data / "manifest.json").read_text(encoding="utf-8")).get("seed")
    except OSError:
        pass
    path = build_report(au, flags, fnd, out, score=sm, per_scenario=sc.to_dict("records") if sc is not None else None, upcoding=upc, seed=seed)
    print(f"wrote {path} ({path.stat().st_size / 1024:,.0f} KB)")
    top = fnd[fnd.flag == "dispute"].groupby("rule", sort=False).head(1)
    lines += ["## One dispute per rule, with its evidence", ""] + [f"- **{r.kunjungan_fkrtl_id}** ({r.faskes_profil_id}, {r.rule}): claimed {r.claimed}; measured {r.measured}. {r.evidence}." for r in top.itertuples()]
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
