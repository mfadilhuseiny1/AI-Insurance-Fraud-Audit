"""Synthetic IoMT + claim data for fraud-audit exercises (no real data, no BPJS input).

One deterministic run (a seed) writes these tables to data/synthetic-iomt/:

  faskes.csv               36 fictional hospitals and how much of each is instrumented (iot_coverage)
  devices.csv              ~1,000 devices: ventilator, hemodialysis, ICU bed, ward bed, ICU monitor, infusion pump,
                           smart cabinet (implants), imaging device, NFC/QR check-in reader; two keys are revoked
  claims.csv               FKRTL-style claims; column names follow the audit platform's silver layer (kunjungan_fkrtl_id ...)
  iot_readings.csv         exactly 100,000 device readings, one long table (hash per reading, a sequence number per device and metric)
  evidence_anchors.csv     a Merkle root per instrumented episode, as a ledger would hold it (commit before claim)
  metrics.csv, scenarios.csv   data dictionary: what every metric means, and every scenario with the signal that exposes it
  ground_truth.csv         the TRUTH about every claim (scenario, fraud or not, what the devices really show). For scoring only:
                           keep it away from the agents.
  ground_truth_faskes.csv  the hidden risk tier of each faskes

What is in it: honest claims whose devices agree; 21 fraud scenarios that a device stream can expose (see scenarios.csv);
BENIGN anomalies that must NOT be called fraud (a gateway outage, evidence anchored late, correctly billed non-invasive
ventilation); and fraud no device can see (so recall is honest about the limit of IoMT evidence).

Nothing here is derived from BPJS sample data. Distributions come from general clinical knowledge, the codes are public ICD-10 /
ICD-9-CM codes, and every hospital, patient and device is invented. INA-CBG codes are INA-CBG-STYLE and tariffs are illustrative:
do not read them as real tariffs.

    python synthetic-iomt/generate.py [--seed N] [--out DIR]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

SEED = 20261108
TARGET_ROWS = 100_000
WIB = timezone(timedelta(hours=7))
H = 3_600_000  # ms per hour
START = datetime(2026, 1, 5, 6, 0, tzinfo=WIB)
END = datetime(2026, 9, 25, 6, 0, tzinfo=WIB)
LEDGER = "synthetic-sha256-merkle/1"
ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz"

# public BPS region codes: (province code, name, [(kab/kota code, name)])
REGIONS = [
    ("31", "DKI Jakarta", [("3171", "Kota Adm. Jakarta Selatan"), ("3173", "Kota Adm. Jakarta Pusat"), ("3174", "Kota Adm. Jakarta Barat")]),
    ("32", "Jawa Barat", [("3273", "Kota Bandung"), ("3204", "Kab. Bandung"), ("3276", "Kota Depok")]),
    ("33", "Jawa Tengah", [("3374", "Kota Semarang"), ("3326", "Kab. Pekalongan")]),
    ("35", "Jawa Timur", [("3578", "Kota Surabaya"), ("3573", "Kota Malang"), ("3515", "Kab. Sidoarjo")]),
    ("12", "Sumatera Utara", [("1271", "Kota Medan"), ("1275", "Kota Binjai")]),
    ("73", "Sulawesi Selatan", [("7371", "Kota Makassar"), ("7372", "Kota Parepare")]),
]
NAMES = ["Anggrek", "Melati", "Mawar", "Kenanga", "Cempaka", "Dahlia", "Flamboyan", "Kamboja", "Teratai", "Seruni", "Tulip", "Lavender",
         "Nusantara", "Harapan", "Sentosa", "Bakti", "Mulia", "Kasih", "Karya", "Insani", "Medika", "Prima", "Utama", "Citra",
         "Bunda", "Persada", "Cahaya", "Amanah", "Wijaya", "Sejahtera", "Pelita", "Waluya", "Husada", "Mitra", "Asri", "Permata"]

# public ICD-10 pools: (code, name, CMG letter, weight)
DX_VENT = [("J96.0", "Acute respiratory failure", "J", 30), ("J18.9", "Pneumonia, unspecified", "J", 25), ("A41.9", "Sepsis, unspecified", "A", 20),
           ("J44.1", "COPD with acute exacerbation", "J", 10), ("I21.9", "Acute myocardial infarction, unspecified", "I", 5),
           ("S06.9", "Intracranial injury, unspecified", "S", 5), ("I61.9", "Intracerebral haemorrhage, unspecified", "I", 5)]
DX_ICU = [("I21.9", "Acute myocardial infarction, unspecified", "I", 20), ("A41.9", "Sepsis, unspecified", "A", 18), ("I63.9", "Cerebral infarction, unspecified", "I", 15),
          ("K92.2", "Gastrointestinal haemorrhage, unspecified", "K", 12), ("E11.1", "Type 2 diabetes mellitus with ketoacidosis", "E", 10),
          ("N17.9", "Acute kidney failure, unspecified", "N", 12), ("I50.9", "Heart failure, unspecified", "I", 13)]
DX_WARD = [("A09", "Other gastroenteritis and colitis", "A", 14), ("A91", "Dengue haemorrhagic fever", "A", 14), ("A01.0", "Typhoid fever", "A", 10),
           ("J18.9", "Pneumonia, unspecified", "J", 14), ("N39.0", "Urinary tract infection, site not specified", "N", 10),
           ("K35.8", "Acute appendicitis, other and unspecified", "K", 8), ("I50.9", "Heart failure, unspecified", "I", 8),
           ("L03.1", "Cellulitis of other parts of limb", "L", 6), ("E11.9", "Type 2 diabetes mellitus without complications", "E", 8),
           ("K29.7", "Gastritis, unspecified", "K", 8)]
DX_HD = [("N18.5", "Chronic kidney disease, stage 5", "N", 60), ("N18.6", "End stage renal disease", "N", 40)]
DX_PCI = [("I21.9", "Acute myocardial infarction, unspecified", "I", 50), ("I25.1", "Atherosclerotic heart disease", "I", 50)]
DX_OPD = [("I10", "Essential (primary) hypertension", "I", 22), ("E11.9", "Type 2 diabetes mellitus without complications", "E", 16),
          ("J06.9", "Acute upper respiratory infection, unspecified", "J", 14), ("M54.5", "Low back pain", "M", 10),
          ("K30", "Functional dyspepsia", "K", 10), ("H25.9", "Senile cataract, unspecified", "H", 8), ("N40", "Benign prostatic hyperplasia", "N", 8),
          ("L30.9", "Dermatitis, unspecified", "L", 6), ("G43.9", "Migraine, unspecified", "G", 6)]
INFECTION_DX = {"A41.9", "J18.9", "J96.0", "J44.1", "N39.0", "A01.0"}

# how many FRAUD claims of each scenario are planted, and how many honest claims of each type (benign anomalies are drawn
# from the honest ones). A benchmark needs enough positives per scenario, so these are counts, not probabilities; WHERE
# they land is weighted by the faskes's hidden risk tier, so a faskes-level audit has a signal to find too.
TARGET = {
    "VENT": {"upcoding_vent_hours": 9, "phantom_vent": 6, "niv_billed_as_invasive": 8, "icu_days_inflation": 6, "inflated_drug": 7, "cloned_telemetry": 5,
             "tampered_after_anchor": 6, "ghost_no_trace": 4, "severity_upcoding": 7},
    "ICU": {"icu_days_inflation": 8, "phantom_icu": 6, "los_padding": 6, "inflated_drug": 7, "phantom_imaging": 6, "cloned_telemetry": 4,
            "tampered_after_anchor": 5, "ghost_no_trace": 4, "severity_upcoding": 9, "unbundled_imaging": 7},
    "HD": {"hd_phantom_session": 9, "hd_short_session": 9, "hd_duplicate_billing": 9, "ghost_no_trace": 5},
    "WARD": {"los_padding": 12, "split_stay_readmission": 8, "phantom_imaging": 6, "tampered_after_anchor": 6, "ghost_no_trace": 6},
    "PCI": {"inflated_implant": 7, "implant_serial_reuse": 7, "ghost_no_trace": 3},
    "OPD": {"phantom_visit": 14, "impossible_travel": 10},
}
HONEST = {"VENT": 32, "ICU": 26, "HD": 120, "WARD": 90, "PCI": 28, "OPD": 280, "OTHER": 900}
NO_TRACE = {"ghost_no_trace", "benign_gateway_down"}  # scenarios whose episode has no reading at all
TIER_W = {"high": 10.0, "moderate": 4.0, "low": 1.0}

FRAUD = {s for v in TARGET.values() for s in v} | {"revoked_device", "fraud_outside_iomt_scope"}

# scenario -> (Permenkes 16/2019 mode, the claim says, the devices show, where to look, expected audit result)
SCN_DOC = {
    "honest": ("-", "a claim consistent with its devices", "matching readings", "-", "none"),
    "unmonitored_honest": ("-", "a claim of a kind no device here observes", "no readings exist", "-", "none"),
    "benign_sensor_outage": ("-", "an honest claim", "the gateway lost 8-30 h of readings: a sequence gap, so measured hours fall short", "iot_readings.seq gaps; completeness < 90%", "verify"),
    "late_anchor": ("-", "an honest claim", "the evidence was anchored after the claim was submitted", "evidence_anchors.anchored_before_claim = 0", "verify"),
    "benign_hd_early_termination": ("-", "a dialysis session", "the machine stopped early (hypotension, access problem): 100-170 min", "dialysis_active minutes; one isolated short session is not a pattern", "verify"),
    "benign_gateway_down": ("-", "an honest claim", "no reading at all because the faskes's whole gateway was down for days (no daily heartbeat either)", "heartbeat (attr = gateway) missing on the claim's days, for every device of the faskes", "verify"),
    "severity_upcoding": ("Upcoding", "severity level III (the higher tariff)", "low intensity of care: stable vitals, short ICU stay, little or no ventilation, few infusion doses",
                          "acuity index (vitals instability, ICU hours, ventilation, infusion doses) vs claims.inacbg_keparahan; devices show intensity, not the diagnosis", "verify"),
    "unbundled_imaging": ("Unbundling", "each acquisition of a multi-series exam billed as its own exam", "the imaging device logged one exam with several acquisitions",
                          "imaging_exam value (acquisitions) vs count of exams vs claims.radiologi_diklaim_n", "dispute"),
    "upcoding_vent_hours": ("Upcoding", "96.72: invasive ventilation of 96 h or more in a row", "the ventilator ran under 96 h in a row", "ventilation_active runs, claims.prosedur", "dispute"),
    "phantom_vent": ("Phantom billing", "invasive ventilation hours", "the ventilator sat in STANDBY (reads 0) for the whole stay", "ventilation_active = 0, attr = STANDBY", "dispute"),
    "niv_billed_as_invasive": ("Upcoding", "96.7x invasive ventilation", "the ventilator ran, but in NON-invasive mode (CPAP/NIV)", "ventilation_active.attr = NIV vs claims.prosedur 96.7x", "dispute"),
    "icu_days_inflation": ("Inflated bills", "more ICU days than the bed was occupied", "ICU bed occupancy shorter than the days billed", "icu_bed_occupied hours, claims.icu_hari_diklaim", "dispute"),
    "phantom_icu": ("Phantom billing", "ICU days", "no ICU bed was occupied; only a ward bed was", "icu_bed_occupied absent, bed_occupied present", "dispute"),
    "los_padding": ("Prolonged stay", "a later discharge date", "the bed reads empty after the real discharge", "bed_occupied = 0 tail, claims.los_hari", "dispute"),
    "split_stay_readmission": ("Prolonged stay & readmission", "a second admission just after a discharge", "the same bed stayed occupied with no gap: one stay billed twice", "two claims, same peserta + dx; bed_occupied continuous across them", "dispute"),
    "inflated_drug": ("Inflated bills", "more doses/vials of a high-cost drug than were given", "the infusion pump delivered fewer doses", "infusion_ml events vs claims.obat_khusus_unit_diklaim", "dispute"),
    "phantom_imaging": ("Phantom billing", "more imaging exams than were performed", "the imaging device logged fewer exams", "imaging_exam events vs claims.radiologi_diklaim_n", "dispute"),
    "cloned_telemetry": ("Cloning", "a long ICU stay, backed by device data", "the vitals and device states are a copy of an earlier episode", "identical spo2/heart_rate runs across episodes", "dispute"),
    "tampered_after_anchor": ("Cloning / data alteration", "an inflated stay or ventilation, backed by the data as delivered", "the delivered readings no longer hash to the root anchored earlier", "evidence_anchors.evidence_root vs a Merkle root recomputed from iot_readings", "dispute"),
    "revoked_device": ("Data integrity", "ventilation, backed by device data", "the readings come from a key revoked before they were made", "devices.revoked_at < iot_readings.ts", "dispute"),
    "ghost_no_trace": ("Phantom billing", "ICU, ventilation, dialysis or a stent", "no reading at all on a faskes whose devices were reporting", "claims.episode_id with no iot_readings; other episodes at the faskes have readings", "dispute"),
    "hd_phantom_session": ("Phantom billing", "a dialysis session", "the machine was powered but ran no session", "dialysis_active = 0 in the session window", "dispute"),
    "hd_short_session": ("Upcoding", "a full dialysis session", "the machine ran under 3 h (a standard session is 4-5 h)", "dialysis_active minutes", "dispute"),
    "hd_duplicate_billing": ("Repeat billing", "a second session for the same patient and day", "the machine ran one session", "two HD claims, same peserta + faskes + day, one session on the machine", "dispute"),
    "inflated_implant": ("Inflated bills", "more stents than were used", "the smart cabinet scanned fewer stents", "dispense_scan.attr serials vs claims.implan_serial_diklaim", "dispute"),
    "implant_serial_reuse": ("Cloning", "a stent whose serial was already billed", "that serial was scanned out once, for an earlier claim", "the same serial in two claims", "dispute"),
    "phantom_visit": ("Phantom billing", "an outpatient visit", "no check-in at the faskes that day", "claims with no pos_checkin on the day", "dispute"),
    "impossible_travel": ("Identity misuse", "an outpatient visit", "the same participant checked in at two faskes in different provinces at once", "pos_checkin.attr (peserta) at two faskes, overlapping times", "dispute"),
    "fraud_outside_iomt_scope": ("Inflated bills", "a bill far above the package tariff", "nothing: no device here observes this kind of claim", "claims.biaya_tagih_rp / tarif_inacbg_rp (needs peer comparison, not IoMT)", "none"),
}

METRICS = [
    ("ventilation_active", "ventilator", "state", "0/1 each hour; attr = IMV (invasive) | NIV (non-invasive) | STANDBY"),
    ("icu_bed_occupied", "icu-bed", "state", "0/1 each hour"),
    ("bed_occupied", "ward-bed", "state", "0/1 each hour"),
    ("spo2", "icu-monitor", "%", "hourly; 0 = probe off (artefact)"),
    ("heart_rate", "icu-monitor", "bpm", "hourly; 0 = leads off (artefact)"),
    ("dialysis_active", "hemodialysis", "state", "0/1 every 5 minutes"),
    ("infusion_ml", "infusion-pump", "ml", "an infusion event: ml delivered over interval_sec; attr = drug (MEROPENEM-1G: 100 ml = one vial)"),
    ("dispense_scan", "smart-cabinet", "units", "an item scanned out; attr = implant serial (UDI)"),
    ("imaging_exam", "imaging-device", "exams", "one exam; value = acquisitions (series) in it, so a CT has several; attr = modality"),
    ("pos_checkin", "pos-reader", "state", "1 check-in, 0 check-out; attr = the participant (pseudonym)"),
    ("heartbeat", "gateway / idle device", "state", "attr = gateway: one per faskes per day (its absence on a claim's days means the faskes was offline, not that the claim is a ghost); otherwise an idle device saying it is online"),
]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def merkle_root(leaf_hexes: list[str]) -> str:
    """Sorted-pair sha256 Merkle root over the readings' hashes (the faskes ledger's scheme, with sha256)."""
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


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, WIB).isoformat(timespec="milliseconds")


def day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, WIB).strftime("%Y-%m-%d")


def facts(**kv) -> str:
    return ";".join(f"{k}={v}" for k, v in kv.items())


def canon(r: dict, value: float) -> str:
    return f"{r['device_id']}|{r['episode_id']}|{r['metric']}|{r['ms']}|{r['seq']}|{value:g}|{r['interval_sec']}|{r['attr']}"


def span_days(t0_ms: int, hours: float) -> int:
    """ICU days as a ward clerk counts them: calendar days touched, so a stay from 22:00 for 3 h is 2 days."""
    if hours <= 0:
        return 0
    d0 = datetime.fromtimestamp(t0_ms / 1000, WIB).date()
    d1 = datetime.fromtimestamp((t0_ms + int(hours * H) - 1) / 1000, WIB).date()
    return (d1 - d0).days + 1


def max_run(v) -> int:
    best = cur = 0
    for x in v:
        cur = cur + 1 if x == 1 else 0
        best = max(best, cur)
    return best


class Gen:
    def __init__(self, seed: int):
        self.seed = seed
        self.r = np.random.default_rng(seed)
        self.faskes: list[dict] = []
        self.devices: list[dict] = []
        self.claims: list[dict] = []
        self.truth: list[dict] = []
        self.anchors: list[dict] = []
        self.rows: list[dict] = []
        self.free: dict[str, int] = {}
        self.dev_by: dict[tuple[str, str], list[dict]] = defaultdict(list)
        self.sources: dict[tuple[str, str], list[dict]] = defaultdict(list)  # (faskes, kind): honest episodes a clone may copy
        self.billed_serials: list[tuple[str, str]] = []  # (serial, claim id) of honest implant claims, for reuse
        self.protect: set[str] = set()
        self.n_claim = 0
        self.n_episode = 0
        self.n_serial = 0
        self.patients: set[str] = set()

    # ------------------------------------------------------------------ helpers
    def u(self, a: float, b: float) -> float:
        return float(self.r.uniform(a, b))

    def pick(self, items: list[tuple]):
        w = np.array([x[-1] for x in items], dtype=float)
        return items[int(self.r.choice(len(items), p=w / w.sum()))]

    def pid(self) -> str:
        while True:
            p = "PST-" + "".join(ID_CHARS[int(i)] for i in self.r.integers(0, 36, 7))
            if p not in self.patients:
                self.patients.add(p)
                return p

    def new_episode(self) -> str:
        self.n_episode += 1
        return "EP-" + sha(f"{self.seed}|ep|{self.n_episode}")[:6].upper()

    def serial(self) -> str:
        self.n_serial += 1
        return "UDI-" + sha(f"{self.seed}|udi|{self.n_serial}")[:10].upper()

    def fk_with(self, *cov: str) -> list[dict]:
        return [f for f in self.faskes if f["iot_coverage"] in cov]

    def weighted(self, pool: list[dict], by_tier: bool = False) -> dict:
        w = np.array([{"A": 3.0, "B": 2.0, "C": 1.2, "D": 0.8}[f["tipe_fkrtl"]] * (TIER_W[self.tier[f["faskes_profil_id"]]] if by_tier else 1.0) for f in pool])
        return pool[int(self.r.choice(len(pool), p=w / w.sum()))]

    # ------------------------------------------------------------------ the world
    def build_world(self) -> None:
        order = self.r.permutation(36)
        cover = ["full"] * 14 + ["icu_hd"] * 8 + ["ward"] * 6 + ["none"] * 8
        regions = [(p, pn, k, kn) for p, pn, ks in REGIONS for k, kn in ks]
        for i, idx in enumerate(order):
            cov = cover[i]
            p, pn, k, kn = regions[int(self.r.integers(0, len(regions)))]
            tipe = {"full": "A" if self.r.random() < 0.4 else "B", "icu_hd": "B", "ward": "C" if self.r.random() < 0.6 else "D", "none": "C" if self.r.random() < 0.5 else "D"}[cov]
            self.faskes.append({
                "faskes_profil_id": f"FK-{int(idx) + 1:03d}", "nama": f"RSU {NAMES[int(idx)]} [fiktif]", "jenis_fkrtl": "RSU", "tipe_fkrtl": tipe,
                "kepemilikan": str(self.r.choice(["Pemerintah daerah", "Swasta", "TNI/Polri", "Pemerintah pusat"], p=[.4, .45, .08, .07])),
                "provinsi_kode": p, "provinsi": pn, "kabkota_kode": k, "kabkota_fkrtl": kn, "iot_coverage": cov,
                "tempat_tidur": {"A": 400, "B": 250, "C": 120, "D": 60}[tipe] + int(self.r.integers(-20, 40)),
            })
        covered = [f for f in self.faskes if f["iot_coverage"] in ("full", "icu_hd")]
        tiers = {f["faskes_profil_id"]: "low" for f in self.faskes}
        for i in self.r.permutation(len(covered))[:4]:
            tiers[covered[int(i)]["faskes_profil_id"]] = "high"
        rest = [f for f in covered if tiers[f["faskes_profil_id"]] == "low"]
        for i in self.r.permutation(len(rest))[:6]:
            tiers[rest[int(i)]["faskes_profil_id"]] = "moderate"
        self.tier = tiers
        spec = {"full": {"icu-bed": 5, "ventilator": 3, "hemodialysis": 4, "icu-monitor": 6, "ward-bed": 24, "infusion-pump": 8, "smart-cabinet": 2, "imaging-device": 3, "pos-reader": 2, "gateway": 1},
                "icu_hd": {"icu-bed": 4, "ventilator": 2, "hemodialysis": 4, "icu-monitor": 5, "infusion-pump": 6, "smart-cabinet": 2, "imaging-device": 2, "pos-reader": 2, "gateway": 1},
                "ward": {"ward-bed": 18, "smart-cabinet": 1, "imaging-device": 1, "pos-reader": 1, "gateway": 1}, "none": {}}
        short = {"icu-bed": "ICB", "ventilator": "VNT", "hemodialysis": "HDM", "icu-monitor": "MON", "ward-bed": "WRD", "infusion-pump": "INF", "smart-cabinet": "CAB", "imaging-device": "IMG", "pos-reader": "POS", "gateway": "GWY"}
        for f in self.faskes:
            for kind, n in spec[f["iot_coverage"]].items():
                for j in range(1, n + 1):
                    did = f"DV-{f['faskes_profil_id'][3:]}-{short[kind]}-{j:02d}"
                    d = {"device_id": did, "faskes_profil_id": f["faskes_profil_id"], "kind": kind, "label": f"{kind} {j}",
                         "pubkey_address": "0x" + sha(f"{self.seed}|key|{did}")[:40], "registered_at": "2025-11-03T08:00:00.000+07:00", "revoked_at": ""}
                    self.devices.append(d)
                    self.dev_by[(f["faskes_profil_id"], kind)].append(d)
                    self.free[did] = 0
        # two ventilator keys are revoked mid-year, both at high-risk faskes
        self.revoked: dict[str, tuple[dict, int]] = {}
        highs = [f for f in covered if tiers[f["faskes_profil_id"]] == "high"][:2]
        for f, when in zip(highs, [datetime(2026, 5, 18, 9, 0, tzinfo=WIB), datetime(2026, 6, 22, 9, 0, tzinfo=WIB)]):
            d = self.dev_by[(f["faskes_profil_id"], "ventilator")][-1]
            d["revoked_at"] = when.isoformat(timespec="milliseconds")
            self.revoked[f["faskes_profil_id"]] = (d, int(when.timestamp() * 1000))

    def has(self, fid: str, kind: str) -> bool:
        return bool(self.dev_by.get((fid, kind)))

    def any_dev(self, fid: str, kind: str) -> dict:
        ds = [d for d in self.dev_by[(fid, kind)] if not d["revoked_at"]]
        return ds[int(self.r.integers(0, len(ds)))]

    def schedule(self, fid: str, kinds: list[str], start: int, dur: int, forced: dict[str, dict] | None = None) -> tuple[int, dict[str, dict]]:
        """Earliest start >= start at which every kind has a free device. A revoked key is never picked by honest use."""
        forced = forced or {}
        while True:
            chosen: dict[str, dict] = {}
            wait = None
            for k in kinds:
                if k in forced:
                    chosen[k] = forced[k]
                    continue
                ok = [d for d in self.dev_by[(fid, k)] if self.free[d["device_id"]] <= start and not d["revoked_at"]]
                if ok:
                    chosen[k] = ok[int(self.r.integers(0, len(ok)))]
                else:
                    t = min(self.free[d["device_id"]] for d in self.dev_by[(fid, k)] if not d["revoked_at"])
                    wait = max(wait or 0, t)
            if wait is None:
                for d in chosen.values():
                    self.free[d["device_id"]] = start + dur + int(self.u(1, 3) * H)
                return start, chosen
            start = max(start + H, wait)

    # ------------------------------------------------------------------ signals
    def ar1(self, n: int, mu: float, sd: float, phi: float, lo: float, hi: float) -> np.ndarray:
        x = np.empty(n)
        x[0] = mu + sd * self.r.normal()
        eps = self.r.normal(0, sd * math.sqrt(1 - phi * phi), n)
        for i in range(1, n):
            x[i] = mu + phi * (x[i - 1] - mu) + eps[i]
        return np.clip(x, lo, hi)

    def vitals(self, n: int, vent: bool, acuity: float = 0.4) -> tuple[np.ndarray, np.ndarray]:
        """SpO2 and heart rate whose instability grows with the patient's acuity (0 stable ... 1 critical)."""
        spo2 = np.round(self.ar1(n, 96.6 - 3.0 * acuity, 1.2 + 0.8 * acuity, 0.85, 80, 100), 1)
        hr = np.round(self.ar1(n, 80 + 30 * acuity, 8 + 6 * acuity, 0.9, 45, 170))
        if n > 10:  # desaturations: rare in a stable patient, frequent in a critical one
            for _ in range(int(self.r.poisson(0.3 + 4.0 * acuity))):
                i = int(self.r.integers(0, n - 3))
                spo2[i:i + 2] = np.round(spo2[i:i + 2] - self.u(5, 10), 1)
        off = self.r.random(n) < 0.0015  # probe off / leads off: a real cleaning chore
        spo2[off] = 0
        hr[off] = 0
        return spo2, hr

    def emit(self, fid: str, ep: str, dev: dict, metric: str, t0: int, values, interval: int, unit: str, attr: str | list = "", tamper_from: int | None = None, tamper_to: int | None = None) -> None:
        for i, v in enumerate(values):
            a = attr[i] if isinstance(attr, list) else attr
            ms = int(t0 + i * interval * 1000 + int(self.r.integers(0, 4000)))
            self.rows.append({"ms": ms, "device_id": dev["device_id"], "faskes_profil_id": fid, "episode_id": ep, "metric": metric, "value": float(v), "unit": unit,
                              "interval_sec": interval, "attr": a, "dropped": False,
                              "tampered": tamper_from is not None and tamper_from <= i < (tamper_to if tamper_to is not None else 10**9)})

    def event(self, fid: str, ep: str, dev: dict, metric: str, ms: int, value: float, interval: int, unit: str, attr: str = "") -> None:
        self.rows.append({"ms": int(ms), "device_id": dev["device_id"], "faskes_profil_id": fid, "episode_id": ep, "metric": metric, "value": float(value), "unit": unit,
                          "interval_sec": interval, "attr": attr, "dropped": False, "tampered": False})

    # ------------------------------------------------------------------ claims
    def tariff(self, kind: str, sev: int, los: int) -> int:
        base = {"VENT": {2: (22e6, 40e6), 3: (45e6, 85e6)}, "ICU": {2: (14e6, 28e6), 3: (30e6, 55e6)},
                "WARD": {1: (3e6, 6e6), 2: (6e6, 12e6), 3: (12e6, 22e6)}, "HD": {1: (0.85e6, 1.15e6)}, "PCI": {2: (28e6, 48e6)},
                "OPD": {1: (0.15e6, 0.9e6)}, "OTHER": {1: (0.15e6, 0.9e6), 2: (0.5e6, 1.5e6)}}[kind][sev]
        return int(round(self.u(*base) * (1 + 0.03 * max(0, los - 5)), -3))

    def claim(self, *, kind: str, fk: dict, ep: str, dx, proc: list[str], sev: int, admit: int, end: int, inpatient: bool, poli: str, peserta: str,
              claimed: dict | None = None, status: str = "Sembuh", submit_days: float | None = None) -> dict:
        claimed = claimed or {}
        self.n_claim += 1
        los = max(1, math.ceil((end - admit) / (24 * H))) if inpatient else 0
        tariff = self.tariff(kind, sev, los)
        submit = end + int((self.u(1, 12) if submit_days is None else submit_days) * 24 * H)
        row = {
            "kunjungan_fkrtl_id": f"KLM-{self.n_claim:06d}", "peserta_id": peserta, "episode_id": ep, "faskes_profil_id": fk["faskes_profil_id"],
            "provinsi_kode": fk["provinsi_kode"], "kabkota_fkrtl": fk["kabkota_fkrtl"], "jenis_fkrtl": fk["jenis_fkrtl"], "tipe_fkrtl": fk["tipe_fkrtl"],
            "tingkat_pelayanan": "Rawat Inap" if inpatient else "Rawat Jalan", "poli": poli,
            "kelas_rawat": int(self.r.choice([1, 2, 3], p=[.15, .25, .6])) if inpatient else "",
            "waktu_datang": iso(admit), "waktu_pulang": iso(end), "tgl_datang": day(admit), "tgl_pulang": day(end), "los_hari": los, "status_pulang": status,
            "inacbg_kode": f"{dx[2]}-{1 if inpatient else 4}-{int(self.r.integers(10, 20))}-{['I', 'II', 'III'][sev - 1]}", "inacbg_keparahan": ["I", "II", "III"][sev - 1],
            "dx_primer_kode": dx[0], "dx_primer_nama": dx[1], "prosedur": ";".join(proc),
            "icu_hari_diklaim": claimed.get("icu_days", ""), "ventilator_jam_diklaim": claimed.get("vent_hours", ""), "sesi_hd_diklaim": claimed.get("hd_sessions", ""),
            "obat_khusus_unit_diklaim": claimed.get("drug_units", ""), "radiologi_diklaim_n": claimed.get("imaging_n", ""),
            "implan_diklaim_n": claimed.get("implant_n", ""), "implan_serial_diklaim": claimed.get("implant_serials", ""),
            "tarif_inacbg_rp": tariff, "biaya_tagih_rp": int(round(tariff * self.u(0.92, 1.28), -3)), "tgl_ajukan": day(submit), "_submit": submit,
        }
        self.claims.append(row)
        return row

    def record(self, c: dict, kind: str, scn: str, assessable: bool, end_true: int, *, f: str = "", late: bool = False, outage: bool = False, protect: bool = False) -> None:
        """Truth row, outage, anchor. Called once per claim after its readings are emitted."""
        ep = c["episode_id"]
        rows = [r for r in self.rows if r["episode_id"] == ep] if ep else []
        if outage and rows:
            lo = min(r["ms"] for r in rows)
            hi = max(r["ms"] for r in rows)
            if hi - lo > 48 * H:
                a = int(self.u(lo + 6 * H, hi - 32 * H))
                b = a + int(self.u(8, 30) * H)
                for r in rows:
                    if a <= r["ms"] <= b:
                        r["dropped"] = True
        fraud = scn in FRAUD
        flag = SCN_DOC[scn][4]
        self.truth.append({"kunjungan_fkrtl_id": c["kunjungan_fkrtl_id"], "episode_id": ep, "faskes_profil_id": c["faskes_profil_id"], "claim_type": kind, "scenario": scn,
                           "is_fraud": int(fraud), "expected_flag": flag, "iomt_assessable": int(assessable), "true_facts": f, "mechanism": SCN_DOC[scn][2]})
        if protect:
            self.protect.add(c["kunjungan_fkrtl_id"])
        if rows:
            self.anchors.append({"episode_id": ep, "kunjungan_fkrtl_id": c["kunjungan_fkrtl_id"], "ledger": LEDGER, "_end": end_true, "_submit": c["_submit"], "_late": late})

    def draw_honest(self, kind: str) -> str:
        x = self.r.random()
        if kind == "HD" and x < 0.08:
            return "benign_hd_early_termination"
        return "benign_sensor_outage" if (x < 0.06 and kind in ("VENT", "ICU", "WARD")) else "late_anchor" if x < 0.09 else "honest"

    # ------------------------------------------------------------------ ICU / ventilated stays
    def vent_timeline(self, niv: bool) -> dict:
        los = float(np.clip(self.r.lognormal(math.log(6.0 if niv else 8.0), 0.45), 3.5, 28))
        icu_h = int(los * 24 * self.u(0.55, 0.95))
        main = int(icu_h * self.u(0.3 if niv else 0.4, 0.8 if niv else 0.95))
        runs = [(int(self.u(0, 3)), main)]
        if self.r.random() < 0.3 and icu_h - main > 40:  # extubated, then ventilated again
            gap, second = int(self.u(6, 30)), int(max(4, main * self.u(0.1, 0.4)))
            s = runs[0][0] + main + gap
            if s + second < icu_h:
                runs.append((s, second))
        return {"los_h": int(los * 24), "icu_h": icu_h, "runs": runs}

    def state(self, n: int, runs: list[tuple[int, int]]) -> np.ndarray:
        v = np.zeros(n)
        for s, k in runs:
            v[s:min(n, s + k)] = 1
        return v

    def build_icu(self, plan: dict, vent: bool) -> None:
        fk, scn = plan["fk"], plan["scn"]
        fid = fk["faskes_profil_id"]
        kind = "VENT" if vent else "ICU"
        ep = self.new_episode()
        niv = vent and (scn == "niv_billed_as_invasive" or (scn not in ("upcoding_vent_hours", "revoked_device", "phantom_vent") and self.r.random() < 0.18))
        acuity = float(self.r.beta(2, 2))  # 0 stable ... 1 critical: the latent that care intensity, and the honest severity, follow
        if scn == "severity_upcoding":
            acuity = self.u(0.05, 0.5)  # low to moderate intensity of care, billed as severity III (the upper end is hard to tell from honest II)
            niv = False
        if vent and scn == "severity_upcoding":  # e.g. a short post-operative ventilation
            tl = {"los_h": int(self.u(3, 5) * 24), "icu_h": int(self.u(0.8, 1.5) * 24), "runs": [(1, int(self.u(6, 18)))]}
        elif vent:
            tl = self.vent_timeline(niv)
        else:
            los = float(np.clip(self.r.lognormal(math.log(6.0), 0.5), 2.5, 7 if scn == "severity_upcoding" else 24))
            frac = float(np.clip(0.3 + 0.6 * acuity + self.r.normal(0, 0.06), 0.25, 0.95))
            tl = {"los_h": int(los * 24), "icu_h": int(los * 24 * frac), "runs": []}
        source = None
        if scn == "cloned_telemetry":
            pool = self.sources.get((fid, kind), [])
            if not pool:
                scn = "icu_days_inflation"
            else:
                source = pool[int(self.r.integers(0, len(pool)))]
                tl = {"los_h": source["los_h"], "icu_h": source["icu_h"], "runs": source["runs"]}
                niv = source["niv"]
                vent = bool(source["runs"])
                acuity = source["acuity"]
        icu_h, los_h = tl["icu_h"], tl["los_h"]
        ward_h = los_h - icu_h
        ward_ok = ward_h > 0 and self.has(fid, "ward-bed")
        dx = self.pick(DX_VENT if vent else DX_ICU)
        want_drug = scn == "inflated_drug" or dx[0] in INFECTION_DX and self.r.random() < 0.8
        if scn == "phantom_icu":  # the patient was on a ward the whole time: no ICU device is involved
            kinds = ["ward-bed"] + (["infusion-pump"] if want_drug else [])
            ward_h, ward_ok = los_h, True
        else:
            kinds = ["icu-bed", "icu-monitor"] + (["ventilator"] if vent else []) + (["ward-bed"] if ward_ok else []) + (["infusion-pump"] if want_drug else [])
        start = plan["start"]
        forced = {}
        if scn == "revoked_device":
            forced["ventilator"] = self.revoked[fid][0]
            start = max(start, self.revoked[fid][1] + int(self.u(2, 20) * 24 * H))
        t0, dev = self.schedule(fid, kinds, start, los_h * H, forced)
        end_true = t0 + los_h * H

        # what the devices truly saw
        runs = tl["runs"]
        vs = self.state(icu_h, runs) if vent else np.zeros(icu_h)
        true_vent, true_run = int(vs.sum()), max_run(vs)
        icu_shown = scn != "phantom_icu"
        # what the claim says
        claimed_icu_h = icu_h
        claimed_los_h = los_h
        if vent and not niv and scn != "severity_upcoding":
            acuity = max(acuity, 0.7 if true_run >= 96 else 0.55)  # a patient ventilated this long is not stable
        sev_true = 3 if acuity >= 0.62 else 2  # the severity the care actually delivered supports
        sev = 3 if scn == "severity_upcoding" else sev_true
        dev_vs = vs.copy()
        mode_attr = "NIV" if niv else "IMV"
        invasive_claim = vent and not niv
        claimed_vent = true_vent + (int(self.r.integers(-2, 3)) if vent and true_vent > 6 else 0)  # documentation noise
        code_run = true_run
        tamper_from = tamper_to = None
        pad_h = 0
        if scn == "upcoding_vent_hours":
            run = min(int(self.u(24, 95)), icu_h - 1)
            dev_vs = self.state(icu_h, [(int(self.u(0, 3)), run)])
            true_vent, true_run = int(dev_vs.sum()), max_run(dev_vs)
            claimed_vent, sev, invasive_claim = int(self.u(96, 150)), 3, True
            code_run = claimed_vent
            acuity = float(np.clip(acuity, 0.3, 0.6))  # the care actually delivered: a ventilation run under 96 h supports severity II
            sev_true = 2
        elif scn == "phantom_vent":
            dev_vs, true_vent, true_run, mode_attr = np.zeros(icu_h), 0, 0, "STANDBY"
            claimed_vent, sev, invasive_claim = int(self.u(48, 150)), 3, True
            code_run = claimed_vent
            acuity = float(np.clip(acuity, 0.3, 0.6))  # no ventilation was delivered
            sev_true = 2
        elif scn == "niv_billed_as_invasive":
            claimed_vent, sev, invasive_claim = int(max(true_vent, self.u(40, 130))), 3, True
            code_run = claimed_vent
        elif scn == "icu_days_inflation":
            claimed_icu_h = icu_h + int(self.u(1, 5) * 24)
        elif scn == "phantom_icu":
            claimed_icu_h = int(self.u(2, 6) * 24)
            vent = False
            claimed_vent = 0
            invasive_claim = False
        elif scn == "los_padding":
            pad_h = int(self.u(1, 6) * 24)
            claimed_los_h = los_h + pad_h
        elif scn == "tampered_after_anchor":
            last_end = max((s + k for s, k in runs), default=0)
            avail = icu_h - last_end
            if vent and avail >= 30:  # flip the quiet tail of the ventilator stream to "running"
                x = min(avail, int(self.u(30, 72)))
                tamper_from, tamper_to = last_end, last_end + x
                flipped = vs.copy()
                flipped[last_end:last_end + x] = 1
                claimed_vent, code_run = int(flipped.sum()), max_run(flipped)
                sev = 3
                invasive_claim = not niv
            else:  # pad the stay: the empty bed after the real discharge is later flipped to "occupied"
                pad_h = int(self.u(36, 100))
                claimed_los_h = los_h + pad_h
        # drug course (a high-cost antibiotic, q8h, one vial per 100 ml)
        doses = 0
        drug_events: list[int] = []
        if want_drug and icu_shown and icu_h > 16:
            n = min(int(3 + 4 * acuity) * 3, icu_h // 8)
            first = t0 + int(self.u(0, 6)) * H
            drug_events = [first + k * 8 * H for k in range(n)]
            doses = len(drug_events)
        claimed_drug = doses if want_drug else ""
        if scn == "inflated_drug" and doses:
            claimed_drug = int(round(doses * self.u(1.15, 2.3))) + 1
        # imaging
        n_img = max(1, int(self.r.poisson(max(0.3, icu_h / 72)))) if icu_shown else 0
        if scn == "unbundled_imaging":
            n_img = max(n_img, 2)
        exams = []  # (modality, acquisitions)
        for k in range(n_img):
            ct = (scn == "unbundled_imaging" and k < 2) or self.r.random() < 0.15
            exams.append(("CT-HEAD", int(self.u(3, 7))) if ct else ("XRAY-CHEST", 1))
        claimed_img = n_img
        if scn == "phantom_imaging":
            claimed_img = n_img + 1 + int(self.u(0, 3))
        elif scn == "unbundled_imaging":
            claimed_img = sum(a for _, a in exams)

        proc: list[str] = ["87.44"] if claimed_img else []
        if vent:
            if invasive_claim:
                proc.append("96.72" if code_run >= 96 else "96.71")
            else:
                proc.append("93.90")
        ward_dev = dev.get("ward-bed")
        # ---- emit
        if scn not in NO_TRACE:
            if icu_shown:
                spo2, hr = self.vitals(max(2, icu_h // 2), vent, acuity)
                ib = np.ones(icu_h)
                if icu_h > 12 and self.r.random() < 0.3:  # a trip to CT: the bed is empty for an hour or two
                    k = int(self.u(2, icu_h - 4))
                    ib[k:k + int(self.u(1, 3))] = 0
                if source is not None:
                    spo2, hr, ib = source["spo2"].copy(), source["hr"].copy(), source["ib"].copy()
                icu_pad = 0
                if scn == "tampered_after_anchor" and not (vent and tamper_to is not None) and not ward_ok:
                    icu_pad = pad_h
                    ib = np.concatenate([ib, np.zeros(icu_pad)])
                self.emit(fid, ep, dev["icu-bed"], "icu_bed_occupied", t0, ib, 3600, "state", tamper_from=icu_h if icu_pad else None)
                self.emit(fid, ep, dev["icu-monitor"], "spo2", t0, spo2, 7200, "%")
                self.emit(fid, ep, dev["icu-monitor"], "heart_rate", t0, hr, 7200, "bpm")
                if vent:
                    tf, tt = (tamper_from, tamper_to) if (scn == "tampered_after_anchor" and tamper_to is not None) else (None, None)
                    self.emit(fid, ep, dev["ventilator"], "ventilation_active", t0, dev_vs, 3600, "state", attr=mode_attr, tamper_from=tf, tamper_to=tt)
            if ward_ok and (ward_h > 0 or pad_h):
                wstart = t0 + (icu_h if icu_shown else 0) * H
                tail = pad_h if (scn == "los_padding" or (scn == "tampered_after_anchor" and tamper_to is None)) else 0
                wvals = np.concatenate([np.ones(ward_h), np.zeros(tail)])
                self.emit(fid, ep, ward_dev, "bed_occupied", wstart, wvals, 3600, "state", tamper_from=ward_h if (scn == "tampered_after_anchor" and tail) else None)
            elif scn == "los_padding" and pad_h and not ward_ok:  # no ward bed sensor here: the ICU bed shows the empty tail
                self.emit(fid, ep, dev["icu-bed"], "icu_bed_occupied", t0 + icu_h * H, np.zeros(pad_h), 3600, "state")
            if "infusion-pump" in dev:
                for ms in drug_events:
                    self.event(fid, ep, dev["infusion-pump"], "infusion_ml", ms, 100 + int(self.r.integers(-3, 4)), 10800, "ml", "MEROPENEM-1G")
            if n_img and self.has(fid, "imaging-device"):
                for modality, acq in exams:
                    self.event(fid, ep, self.any_dev(fid, "imaging-device"), "imaging_exam", t0 + int(self.u(1, max(2, los_h - 1)) * H), acq, 600, "exams", modality)
            if scn in ("honest", "late_anchor", "benign_sensor_outage") and icu_shown and (runs or not vent):
                self.sources[(fid, kind)].append({"ep": ep, "los_h": los_h, "icu_h": icu_h, "runs": runs, "niv": niv, "spo2": spo2.copy(), "hr": hr.copy(), "ib": ib[:icu_h].copy(), "acuity": acuity})

        claimed_vent_final = claimed_vent
        status = "Meninggal" if (vent and self.r.random() < 0.3) or self.r.random() < 0.08 else "Sembuh"
        claimed = {"icu_days": span_days(t0, claimed_icu_h) if (icu_shown or scn == "phantom_icu") else 0,
                   "vent_hours": claimed_vent_final if (vent and invasive_claim) else "", "drug_units": claimed_drug, "imaging_n": claimed_img}
        if scn == "tampered_after_anchor" and pad_h and tamper_to is None:
            claimed["icu_days"] = span_days(t0, icu_h + (0 if ward_ok else pad_h))
        c = self.claim(kind=kind, fk=fk, ep=ep, dx=dx, proc=proc, sev=sev, admit=t0, end=t0 + claimed_los_h * H, inpatient=True, poli="Rawat Inap",
                       peserta=self.pid(), claimed=claimed, status=status)
        over = ""
        if scn in ("upcoding_vent_hours", "niv_billed_as_invasive", "phantom_vent", "severity_upcoding"):
            over = max(0, c["tarif_inacbg_rp"] - self.tariff(kind, sev_true, c["los_hari"]))  # tariff paid minus the tariff the delivered care supports
        self.record(c, kind, scn, True, end_true, late=scn == "late_anchor", outage=scn == "benign_sensor_outage",
                    f=facts(vent_h=true_vent, max_run_h=true_run, mode=mode_attr if vent else "", icu_h=icu_h if icu_shown else 0, los_d=round(los_h / 24, 1),
                            drug_units=doses, imaging_n=n_img, imaging_acq=sum(a for _, a in exams), acuity=round(acuity, 2), sev_supported=sev_true,
                            overbilled_rp=over, clone_of=source["ep"] if source else "", revoked=int(scn == "revoked_device")))

    # ------------------------------------------------------------------ ward stays
    def build_ward(self, plan: dict) -> None:
        fk, scn = plan["fk"], plan["scn"]
        fid = fk["faskes_profil_id"]
        ep = self.new_episode()
        los_d = float(np.clip(self.r.lognormal(math.log(7.0 if scn == "split_stay_readmission" else 3.6), 0.4 if scn == "split_stay_readmission" else 0.5), 5 if scn == "split_stay_readmission" else 1.2, 16))
        if scn == "benign_gateway_down":
            los_d = self.u(0.8, 1.5)  # short enough to sit inside the dark window
        los_h = int(los_d * 24)
        pad = int(self.u(1, 6) * 24) if scn in ("los_padding", "tampered_after_anchor") else 0
        t0, dev = self.schedule(fid, ["ward-bed"], plan["start"], los_h * H)
        dx = self.pick(DX_WARD)
        end_true = t0 + los_h * H
        n_img = int(self.r.poisson(0.35 * los_d))
        claimed_img = n_img + ((1 + int(self.u(0, 3))) if scn == "phantom_imaging" else 0)
        peserta = self.pid()
        sev = int(self.r.choice([1, 2, 3], p=[.4, .45, .15]))
        proc = ["87.44"] if claimed_img else []
        if scn == "split_stay_readmission":
            k = int(los_h * self.u(0.4, 0.6))
            ep2 = self.new_episode()
            self.emit(fid, ep, dev["ward-bed"], "bed_occupied", t0, np.ones(k), 3600, "state")
            self.emit(fid, ep2, dev["ward-bed"], "bed_occupied", t0 + k * H, np.ones(los_h - k), 3600, "state")
            c1 = self.claim(kind="WARD", fk=fk, ep=ep, dx=dx, proc=proc, sev=sev, admit=t0, end=t0 + k * H, inpatient=True, poli="Rawat Inap", peserta=peserta, status="Sembuh")
            c2 = self.claim(kind="WARD", fk=fk, ep=ep2, dx=dx, proc=[], sev=sev, admit=t0 + k * H + int(self.u(0.1, 3) * H), end=end_true, inpatient=True, poli="Rawat Inap",
                            peserta=peserta, status="Sembuh")
            self.record(c1, "WARD", "honest", True, t0 + k * H, protect=True, f=facts(los_d=round(k / 24, 1), split_partner=c2["kunjungan_fkrtl_id"]))
            self.truth[-1]["mechanism"] = f"honest first half of a stay that {c2['kunjungan_fkrtl_id']} bills again"
            self.record(c2, "WARD", scn, True, end_true, protect=True, f=facts(los_d=round((los_h - k) / 24, 1), continuous_with=c1["kunjungan_fkrtl_id"], gap_h=0))
            return
        if scn not in NO_TRACE:
            vals = np.concatenate([np.ones(los_h), np.zeros(pad)])
            self.emit(fid, ep, dev["ward-bed"], "bed_occupied", t0, vals, 3600, "state", tamper_from=los_h if scn == "tampered_after_anchor" else None)
            if n_img and self.has(fid, "imaging-device"):
                for _ in range(n_img):
                    self.event(fid, ep, self.any_dev(fid, "imaging-device"), "imaging_exam", t0 + int(self.u(1, max(2, los_h - 1)) * H), 1, 600, "exams", "XRAY-CHEST")
        c = self.claim(kind="WARD", fk=fk, ep=ep, dx=dx, proc=proc, sev=sev, admit=t0, end=end_true + pad * H, inpatient=True, poli="Rawat Inap", peserta=peserta,
                       claimed={"imaging_n": claimed_img}, status="Sembuh" if self.r.random() > 0.04 else "Dirujuk")
        self.record(c, "WARD", scn, True, end_true, late=scn == "late_anchor", outage=scn == "benign_sensor_outage", f=facts(los_d=round(los_d, 1), imaging_n=n_img))

    # ------------------------------------------------------------------ hemodialysis
    def build_hd(self, plan: dict) -> None:
        fk, scn = plan["fk"], plan["scn"]
        fid = fk["faskes_profil_id"]
        ep = self.new_episode()
        n = int(self.u(54, 62))
        dur = n * 300 * 1000
        t0, dev = self.schedule(fid, ["hemodialysis"], plan["start"], dur)
        dx = self.pick(DX_HD)
        vals = np.zeros(n)
        vals[2:n - 2] = 1
        if scn == "hd_phantom_session":
            vals = np.zeros(n)
        elif scn == "hd_short_session":
            vals = np.zeros(n)
            vals[2:2 + int(self.u(12, 33))] = 1  # 60-165 minutes
        elif scn == "benign_hd_early_termination":
            vals = np.zeros(n)
            vals[2:2 + int(self.u(20, 34))] = 1  # 100-170 minutes: stopped for hypotension or an access problem
        if scn not in NO_TRACE:
            self.emit(fid, ep, dev["hemodialysis"], "dialysis_active", t0, vals, 300, "state")
        c = self.claim(kind="HD", fk=fk, ep=ep, dx=dx, proc=["39.95"], sev=1, admit=t0, end=t0 + dur, inpatient=False, poli="Hemodialisis", peserta=plan["peserta"],
                       claimed={"hd_sessions": 1}, submit_days=self.u(1, 9))
        self.record(c, "HD", scn, True, t0 + dur, late=scn == "late_anchor", f=facts(hd_minutes=int(vals.sum() * 5)))
        if scn == "hd_duplicate_billing":
            c2 = self.claim(kind="HD", fk=fk, ep=self.new_episode(), dx=dx, proc=["39.95"], sev=1, admit=t0 + int(self.u(0, 20) * 60_000), end=t0 + dur, inpatient=False,
                            poli="Hemodialisis", peserta=plan["peserta"], claimed={"hd_sessions": 1}, submit_days=self.u(2, 12))
            self.truth[-1].update({"scenario": "honest", "is_fraud": 0, "expected_flag": "none", "mechanism": f"honest original; {c2['kunjungan_fkrtl_id']} bills the same session again"})
            self.protect.add(c["kunjungan_fkrtl_id"])
            self.record(c2, "HD", scn, True, t0 + dur, f=facts(hd_minutes=0, duplicate_of=c["kunjungan_fkrtl_id"]))

    # ------------------------------------------------------------------ PCI (stents, smart cabinet)
    def build_pci(self, plan: dict) -> None:
        fk, scn = plan["fk"], plan["scn"]
        fid = fk["faskes_profil_id"]
        ep = self.new_episode()
        n = int(self.r.choice([1, 2, 3], p=[.6, .3, .1]))
        t0 = plan["start"]
        end = t0 + int((self.u(0.5, 1.0) if scn == "benign_gateway_down" else self.u(2, 4)) * 24 * H)
        serials = [self.serial() for _ in range(n)]
        claimed = list(serials)
        scanned = list(serials)
        if scn == "inflated_implant":
            claimed += [self.serial() for _ in range(int(self.u(1, 3)))]  # serials nobody scanned out
        elif scn == "implant_serial_reuse" and self.billed_serials:
            reuse, _ = self.billed_serials[int(self.r.integers(0, len(self.billed_serials)))]
            scanned = scanned[:-1] if len(scanned) > 1 else []
            claimed = scanned + [reuse] if scanned else [reuse]
            claimed = claimed[:max(n, 1)]
            scanned = [s for s in scanned]
        elif scn == "implant_serial_reuse":
            scn = "honest"
        if scn not in NO_TRACE:
            cab = self.any_dev(fid, "smart-cabinet")
            for i, s in enumerate(scanned):
                self.event(fid, ep, cab, "dispense_scan", t0 + int(self.u(0.5, 3) * H) + i * 120_000, 1, 1, "units", s)
        c = self.claim(kind="PCI", fk=fk, ep=ep, dx=self.pick(DX_PCI), proc=["36.07"], sev=2, admit=t0, end=end, inpatient=True, poli="Kardiologi", peserta=self.pid(),
                       claimed={"implant_n": len(claimed), "implant_serials": ";".join(claimed)})
        self.record(c, "PCI", scn, True, end, late=scn == "late_anchor", f=facts(implants_scanned=len(scanned if scn != "ghost_no_trace" else []), implants_claimed=len(claimed)))
        if scn in ("honest", "late_anchor"):
            self.billed_serials += [(s, c["kunjungan_fkrtl_id"]) for s in claimed]

    # ------------------------------------------------------------------ instrumented outpatient (NFC/QR check-in)
    def build_opd(self, plan: dict) -> None:
        fk, scn = plan["fk"], plan["scn"]
        fid = fk["faskes_profil_id"]
        ep = self.new_episode()
        d0 = datetime.fromtimestamp(plan["start"] / 1000, WIB).replace(hour=int(self.u(8, 15)), minute=int(self.u(0, 59)), second=0, microsecond=0)
        t0 = int(d0.timestamp() * 1000)
        mins = int(self.u(30, 120))
        peserta = self.pid()
        poli = str(self.r.choice(["Penyakit Dalam", "Anak", "Bedah", "Saraf", "Mata", "THT", "Jantung"]))
        dx = self.pick(DX_OPD)

        def visit(fk_, ep_, pes, t, with_pos: bool, sc: str) -> dict:
            if with_pos and sc not in NO_TRACE and self.has(fk_["faskes_profil_id"], "pos-reader"):
                dev = self.any_dev(fk_["faskes_profil_id"], "pos-reader")
                self.event(fk_["faskes_profil_id"], ep_, dev, "pos_checkin", t - int(self.u(2, 15)) * 60_000, 1, 1, "state", pes)
                self.event(fk_["faskes_profil_id"], ep_, dev, "pos_checkin", t + mins * 60_000, 0, 1, "state", pes)
            return self.claim(kind="OPD", fk=fk_, ep=ep_, dx=dx, proc=[], sev=1, admit=t, end=t + mins * 60_000, inpatient=False, poli=poli, peserta=pes, submit_days=self.u(1, 9))

        if scn == "impossible_travel":
            others = [f for f in self.fk_with("full", "icu_hd", "ward") if f["provinsi_kode"] != fk["provinsi_kode"]]
            fk2 = self.weighted(others)
            ep2 = self.new_episode()
            c1 = visit(fk, ep, peserta, t0, True, "honest")
            self.record(c1, "OPD", "honest", True, t0 + mins * 60_000, protect=True, f=facts(visit_min=mins))
            self.truth[-1]["mechanism"] = f"honest visit; the same participant also 'visits' {fk2['faskes_profil_id']} at the same time"
            c2 = visit(fk2, ep2, peserta, t0 + int(self.u(-20, 40)) * 60_000, True, scn)
            self.record(c2, "OPD", scn, True, t0 + mins * 60_000, f=facts(visit_min=mins, also_at=c1["kunjungan_fkrtl_id"]))
            return
        c = visit(fk, ep, peserta, t0, scn != "phantom_visit", scn)
        self.record(c, "OPD", scn, True, t0 + mins * 60_000, late=scn == "late_anchor", f=facts(visit_min=mins if scn != "phantom_visit" else 0))

    # ------------------------------------------------------------------ claims no device observes
    def build_other(self, plan: dict) -> None:
        fk = plan["fk"]
        inpatient = bool(self.r.random() < 0.3)
        dx = self.pick(DX_WARD if inpatient else DX_OPD)
        t0 = plan["start"]
        los = int(max(1, self.r.lognormal(math.log(3), 0.5))) if inpatient else 0
        c = self.claim(kind="OTHER", fk=fk, ep="", dx=dx, proc=[], sev=int(self.r.choice([1, 2], p=[.7, .3])), admit=t0, end=t0 + (los * 24 + 4) * H, inpatient=inpatient,
                       poli="Rawat Inap" if inpatient else str(self.r.choice(["Penyakit Dalam", "Anak", "Bedah", "Saraf", "Mata", "THT"])), peserta=self.pid())
        scn = plan["scn"]
        if scn == "fraud_outside_iomt_scope":
            c["biaya_tagih_rp"] = int(c["tarif_inacbg_rp"] * self.u(1.8, 3.0))
        self.record(c, "OTHER", scn, False, t0)

    # ------------------------------------------------------------------ run
    def run(self) -> None:
        self.build_world()
        span = int((END - START).total_seconds() * 1000)
        t_start = int(START.timestamp() * 1000)
        covered = {"VENT": ("full", "icu_hd"), "ICU": ("full", "icu_hd"), "HD": ("full", "icu_hd"), "PCI": ("full", "icu_hd"), "WARD": ("full", "ward"),
                   "OPD": ("full", "icu_hd", "ward"), "OTHER": ("full", "icu_hd", "ward", "none")}
        hd_pool = [(self.pid(), self.weighted(self.fk_with("full", "icu_hd")), int(self.r.integers(0, 3)), int(self.r.choice([6, 12]))) for _ in range(50)]
        plans: list[dict] = []

        def plan(kind: str, scn: str, fk: dict | None = None, start: int | None = None) -> dict:
            pool = ("full",) if scn == "phantom_icu" else covered[kind]
            fk = fk or self.weighted(self.fk_with(*pool), by_tier=scn in FRAUD)
            p = {"kind": kind, "fk": fk, "scn": scn, "start": start if start is not None else t_start + int(self.r.integers(0, span)), "peserta": None}
            if kind == "HD" and start is None:  # dialysis is a weekly routine of ~50 regular patients
                pid, fk2, pat, hr = hd_pool[int(self.r.integers(0, len(hd_pool)))]
                wk = int(self.r.integers(0, 36))
                p.update({"fk": fk2, "peserta": pid, "start": int((START.replace(hour=hr, minute=0) + timedelta(weeks=wk, days=[0, 2, 4][pat])).timestamp() * 1000)})
            plans.append(p)
            return p

        for kind, n in HONEST.items():
            for _ in range(n):
                plan(kind, "unmonitored_honest" if kind == "OTHER" else self.draw_honest(kind))
        honest_by = defaultdict(list)
        for p in plans:
            honest_by[p["kind"]].append(p)
        for kind, scns in TARGET.items():
            for scn, n in scns.items():
                for _ in range(n):
                    if scn == "cloned_telemetry":  # a clone copies an earlier honest episode of the same kind, at the same faskes
                        src = honest_by[kind][int(self.r.integers(0, len(honest_by[kind])))]
                        plan(kind, scn, src["fk"], src["start"] + int(self.u(15, 70) * 24 * H))
                    else:
                        plan(kind, scn)
        for _ in range(44):  # padded bills no device can see, mostly at high-risk faskes
            plan("OTHER", "fraud_outside_iomt_scope", self.weighted(self.fk_with(*covered["OTHER"]), by_tier=True))
        # a whole faskes goes dark for 3 days (gateway down): its honest claims in that window have no reading at all, and neither does anyone else there
        lows = [f for f in self.fk_with("full") if self.tier[f["faskes_profil_id"]] == "low"]  # full: it has dialysis, ward beds, a cabinet and a reader
        self.outages: list[tuple[str, int, int]] = []
        est = {"VENT": 16 * 24 * H, "ICU": 12 * 24 * H, "WARD": 16 * 24 * H, "HD": 8 * H, "PCI": 4 * 24 * H, "OPD": 4 * H}
        for f in [lows[int(i)] for i in self.r.permutation(len(lows))[:3]]:
            w0 = t_start + int(self.u(0.25, 0.8) * span)
            w0 = int(datetime.fromtimestamp(w0 / 1000, WIB).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)  # whole calendar days
            w1 = w0 + 3 * 24 * H
            self.outages.append((f["faskes_profil_id"], w0, w1))
            for kind, n in (("HD", 3), ("WARD", 2), ("PCI", 1), ("OPD", 3)):
                for _ in range(n):
                    plan(kind, "benign_gateway_down", f, w0 + int(self.u(0.15, 1.2) * 24 * H))
            for p in plans:
                if p["fk"]["faskes_profil_id"] != f["faskes_profil_id"] or p["kind"] not in est or p["scn"] == "benign_gateway_down":
                    continue
                if p["start"] + est[p["kind"]] >= w0 and p["start"] <= w1:
                    if p["kind"] in ("HD", "WARD", "PCI", "OPD") and w0 <= p["start"] <= w1 and p["scn"] in ("honest", "late_anchor", "benign_sensor_outage", "benign_hd_early_termination"):
                        p["scn"] = "benign_gateway_down"
                        p["start"] = w0 + int(self.u(0.15, 1.2) * 24 * H)
                    else:  # anything long, fraudulent or starting before the dark window moves to after it
                        p["start"] = w1 + int(self.u(1, 3) * 24 * H)
        for fid, (d, when) in self.revoked.items():  # ventilated episodes on a revoked key
            fk = next(f for f in self.faskes if f["faskes_profil_id"] == fid)
            for _ in range(2):
                plan("VENT", "revoked_device", fk, when + int(self.u(2, 60) * 24 * H))
        plans.sort(key=lambda p: p["start"])
        build = {"VENT": lambda p: self.build_icu(p, True), "ICU": lambda p: self.build_icu(p, False), "HD": self.build_hd, "WARD": self.build_ward,
                 "PCI": self.build_pci, "OPD": self.build_opd, "OTHER": self.build_other}
        for p in plans:
            build[p["kind"]](p)
        self.gateway_heartbeats()
        self.fit_budget()
        self.finalize()

    def gateway_heartbeats(self) -> None:
        """One heartbeat per instrumented faskes per day. A day without one, for every device of a faskes, is an outage."""
        day0 = START.replace(hour=5, minute=30)
        for f in self.faskes:
            fid = f["faskes_profil_id"]
            if not self.has(fid, "gateway"):
                continue
            gw = self.dev_by[(fid, "gateway")][0]
            for k in range(int((END - START).days) + 40):
                ms = int((day0 + timedelta(days=k)).timestamp() * 1000) + int(self.r.integers(0, 600_000))
                if any(o[0] == fid and o[1] <= ms <= o[2] for o in self.outages):
                    continue
                self.event(fid, "", gw, "heartbeat", ms, 1, 86400, "state", "gateway")

    def live(self) -> int:
        return sum(1 for r in self.rows if not r["dropped"])

    def fit_budget(self) -> None:
        """Trim honest ward stays until the readings fit; finalize() tops up with heartbeats to exactly TARGET_ROWS."""
        guard = 0
        while self.live() > TARGET_ROWS and guard < 500:
            guard += 1
            wards = [t for t in self.truth if t["claim_type"] == "WARD" and t["scenario"] == "honest" and t["kunjungan_fkrtl_id"] not in self.protect]
            if not wards:
                break
            t = wards[-1]
            self.rows = [r for r in self.rows if r["episode_id"] != t["episode_id"]]
            self.truth = [x for x in self.truth if x is not t]
            self.claims = [c for c in self.claims if c["kunjungan_fkrtl_id"] != t["kunjungan_fkrtl_id"]]
            self.anchors = [a for a in self.anchors if a["episode_id"] != t["episode_id"]]
        if self.live() > TARGET_ROWS:
            raise SystemExit(f"over budget: {self.live()} rows; lower QUOTA")

    def finalize(self) -> None:
        by: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for r in self.rows:
            by[(r["device_id"], r["metric"])].append(r)
        for lst in by.values():  # numbers run over the FULL stream: a dropped reading keeps its number, so the gap is evidence
            lst.sort(key=lambda r: r["ms"])
            for i, r in enumerate(lst, 1):
                r["seq"] = i
        for r in self.rows:
            r["_orig"] = sha(canon(r, r["value"]))
        per_ep: dict[str, list[dict]] = defaultdict(list)
        for r in self.rows:
            if not r["dropped"] and r["episode_id"]:
                per_ep[r["episode_id"]].append(r)
        kept = []
        for a in self.anchors:  # the anchor commits what reached the gateway, BEFORE any later edit
            rs = sorted(per_ep.get(a["episode_id"], []), key=lambda r: (r["ms"], r["device_id"], r["metric"], r["seq"]))
            if not rs:
                continue
            root = merkle_root([r["_orig"] for r in rs])
            end, sub = a["_end"], a["_submit"]
            at = sub + int(self.u(1, 5) * 24 * H) if a["_late"] else min(end + int(self.u(2, 30) * H), sub - H)
            a.update({"reading_count": len(rs), "evidence_root": root, "anchored_at": iso(at), "anchor_tx": "0x" + sha(f"{self.seed}|tx|{a['episode_id']}|{root}"),
                      "claim_submitted_at": iso(sub), "anchored_before_claim": int(at < sub)})
            kept.append(a)
        self.anchors = kept
        for r in self.rows:  # the edit: values flipped AFTER anchoring, the per-row hash recomputed so only the root betrays it
            if r["tampered"]:
                r["value"] = 1.0
        missing = TARGET_ROWS - self.live()
        if missing > 0:  # idle devices say "I am here" hourly: it also proves a device was online when no episode used it
            spare = [d for d in self.devices if d["kind"] in ("ward-bed", "icu-monitor", "imaging-device") and not d["revoked_at"]]
            seqs: dict[str, int] = defaultdict(int)
            i = 0
            while missing > 0:
                d = spare[i % len(spare)]
                i += 1
                seqs[d["device_id"]] += 1
                r = {"ms": int(START.timestamp() * 1000) + (seqs[d["device_id"]] - 1) * H + int(self.r.integers(0, 4000)), "device_id": d["device_id"],
                     "faskes_profil_id": d["faskes_profil_id"], "episode_id": "", "metric": "heartbeat", "value": 1.0, "unit": "state", "interval_sec": 3600, "attr": "",
                     "dropped": False, "tampered": False, "seq": seqs[d["device_id"]]}
                self.rows.append(r)
                missing -= 1
        for r in self.rows:
            r["reading_hash"] = sha(canon(r, r["value"]))
        self.rows = [r for r in self.rows if not r["dropped"]]
        self.rows.sort(key=lambda r: (r["ms"], r["device_id"], r["metric"]))
        for i, r in enumerate(self.rows, 1):
            r["reading_id"] = f"R-{i:07d}"
            r["ts"] = iso(r["ms"])
            r["epoch_ms"] = r["ms"]
            r["value"] = f"{r['value']:g}"
        if len(self.rows) != TARGET_ROWS:
            raise SystemExit(f"row count {len(self.rows)} != {TARGET_ROWS}")

    # ------------------------------------------------------------------ output
    def write(self, out: Path) -> dict:
        def dump(name: str, rows: list[dict], cols: list[str]) -> None:
            with open(out / name, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
                w.writeheader()
                w.writerows(rows)

        dump("faskes.csv", self.faskes, list(self.faskes[0].keys()))
        dump("devices.csv", self.devices, ["device_id", "faskes_profil_id", "kind", "label", "pubkey_address", "registered_at", "revoked_at"])
        self.claims.sort(key=lambda c: (c["waktu_datang"], c["kunjungan_fkrtl_id"]))
        dump("claims.csv", self.claims, ["kunjungan_fkrtl_id", "peserta_id", "episode_id", "faskes_profil_id", "provinsi_kode", "kabkota_fkrtl", "jenis_fkrtl", "tipe_fkrtl",
                                         "tingkat_pelayanan", "poli", "kelas_rawat", "waktu_datang", "waktu_pulang", "tgl_datang", "tgl_pulang", "los_hari", "status_pulang",
                                         "inacbg_kode", "inacbg_keparahan", "dx_primer_kode", "dx_primer_nama", "prosedur", "icu_hari_diklaim", "ventilator_jam_diklaim",
                                         "sesi_hd_diklaim", "obat_khusus_unit_diklaim", "radiologi_diklaim_n", "implan_diklaim_n", "implan_serial_diklaim",
                                         "tarif_inacbg_rp", "biaya_tagih_rp", "tgl_ajukan"])
        dump("iot_readings.csv", self.rows, ["reading_id", "ts", "epoch_ms", "device_id", "faskes_profil_id", "episode_id", "metric", "value", "unit", "interval_sec", "attr", "seq", "reading_hash"])
        dump("evidence_anchors.csv", self.anchors, ["episode_id", "kunjungan_fkrtl_id", "ledger", "reading_count", "evidence_root", "anchored_at", "anchor_tx", "claim_submitted_at", "anchored_before_claim"])
        self.truth.sort(key=lambda t: t["kunjungan_fkrtl_id"])
        dump("ground_truth.csv", self.truth, ["kunjungan_fkrtl_id", "episode_id", "faskes_profil_id", "claim_type", "scenario", "is_fraud", "expected_flag", "iomt_assessable", "true_facts", "mechanism"])
        cnt, fr = defaultdict(int), defaultdict(int)
        for t in self.truth:
            cnt[t["faskes_profil_id"]] += 1
            fr[t["faskes_profil_id"]] += t["is_fraud"]
        dump("ground_truth_faskes.csv", [{"faskes_profil_id": f["faskes_profil_id"], "risk_tier": self.tier[f["faskes_profil_id"]], "iot_coverage": f["iot_coverage"],
                                           "claims": cnt[f["faskes_profil_id"]], "fraud_claims": fr[f["faskes_profil_id"]]} for f in self.faskes],
             ["faskes_profil_id", "risk_tier", "iot_coverage", "claims", "fraud_claims"])
        dump("metrics.csv", [{"metric": m, "device_kind": k, "unit": u, "meaning": d} for m, k, u, d in METRICS], ["metric", "device_kind", "unit", "meaning"])
        n = defaultdict(int)
        for t in self.truth:
            n[t["scenario"]] += 1
        dump("scenarios.csv", [{"scenario": s, "permenkes_mode": d[0], "claim_says": d[1], "devices_show": d[2], "where_to_look": d[3], "expected_flag": d[4], "is_fraud": int(s in FRAUD), "claims": n.get(s, 0)}
                               for s, d in SCN_DOC.items()], ["scenario", "permenkes_mode", "claim_says", "devices_show", "where_to_look", "expected_flag", "is_fraud", "claims"])
        files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.glob("*.csv"))}
        manifest = {"seed": self.seed, "generator": "synthetic-iomt/generate.py", "rows": {p: sum(1 for _ in open(out / p, encoding="utf-8")) - 1 for p in files},
                    "scenarios": dict(sorted(n.items(), key=lambda kv: -kv[1])), "sha256": files,
                    "note": "Synthetic. No BPJS data was used. ground_truth*.csv is for scoring only: do not show it to the agents."}
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "synthetic-iomt"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    g = Gen(args.seed)
    g.run()
    m = g.write(out)
    print(f"wrote {out}")
    for k, v in m["rows"].items():
        print(f"  {k:26s} {v:>8,d} rows")
    print("scenarios: " + ", ".join(f"{k}={v}" for k, v in m["scenarios"].items()))


if __name__ == "__main__":
    main()
