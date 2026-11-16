# Synthetic IoMT + claims data for fraud audit practice

Fictional FKRTL claims and 100,000 fictional medical-device readings, with the ground truth in separate files. Made for trying
a "claim vs device evidence" audit before it is wired into the AI Agent Swarm.

**Tidak ada data BPJS di sini.** Every hospital, participant, device and number is generated from scratch by `generate.py`.
Distributions come from general clinical knowledge, and the codes are public ICD-10 / ICD-9-CM codes. INA-CBG codes are only
INA-CBG-*style* and tariffs are illustrative: do not read them as real tariffs. `data/` is in `.gitignore`; only the scripts
and this README are in the repo.

## Three commands

```powershell
.venv\Scripts\python.exe -I synthetic-iomt\generate.py     # writes data/synthetic-iomt/*.csv (5 seconds, fixed seed)
.venv\Scripts\python.exe -I synthetic-iomt\validate.py     # 20 data health checks (--determinism: two runs are identical)
.venv\Scripts\python.exe -I synthetic-iomt\audit.py        # baseline auditor -> data/synthetic-iomt/audit_out/report.md
```

`--seed N` builds another world with the same structure. `audit.py --no-score` audits without ever opening the ground truth.

## What is in `data/synthetic-iomt/`

| file | rows | contents |
|---|---|---|
| `iot_readings.csv` | 100,000 | one long table: `ts`, `device_id`, `episode_id`, `metric`, `value`, `attr`, `seq`, `reading_hash` |
| `claims.csv` | ~1,800 | columns follow the platform's silver layer (`kunjungan_fkrtl_id`, `tgl_datang`, `inacbg_kode`, ...) plus quantity claims (`icu_hari_diklaim`, `ventilator_jam_diklaim`, `obat_khusus_unit_diklaim`, `radiologi_diklaim_n`, `implan_serial_diklaim`, ...) |
| `devices.csv` | ~1,170 | ventilator, hemodialysis machine, ICU bed, ward bed, ICU monitor, infusion pump, smart cabinet, imaging device, check-in reader (NFC/QR), gateway; two device keys are revoked (`revoked_at`) |
| `evidence_anchors.csv` | ~760 | one Merkle root per episode, as a ledger would hold it (commit before claim) |
| `faskes.csv` | 36 | fictional hospitals and their `iot_coverage` (full / icu_hd / ward / none) |
| `metrics.csv`, `scenarios.csv` | | data dictionary: what each metric means, and each scenario with the signal that exposes it |
| `ground_truth.csv`, `ground_truth_faskes.csv` | | **ground truth. Never give it to the agents.** |

Join keys: `claims.episode_id` = `iot_readings.episode_id`; `iot_readings.device_id` = `devices.device_id`;
`claims.faskes_profil_id` = `faskes.faskes_profil_id`. A claim with no `episode_id` is not observed by any device.

## 29 scenarios

Per scenario (what the claim says, what the devices show, where to look): see `scenarios.csv`.

| group | scenarios |
|---|---|
| Upcoding & unbundling | `severity_upcoding` (severity III billed, low intensity of care measured), `upcoding_vent_hours` (96.72 billed, but never 96 hours in a row), `niv_billed_as_invasive` (NIV mode billed as invasive), `hd_short_session`, `unbundled_imaging` (each CT acquisition billed as its own exam) |
| Phantom / repeat billing | `phantom_vent`, `phantom_icu`, `phantom_imaging`, `phantom_visit`, `hd_phantom_session`, `hd_duplicate_billing`, `ghost_no_trace` |
| Inflated bills | `icu_days_inflation`, `inflated_drug` (infusion pump), `inflated_implant` (smart cabinet) |
| Prolonged stay & readmission | `los_padding`, `split_stay_readmission` (one stay billed as two claims; the bed was never empty: bed continuity) |
| Cloning / integrity | `cloned_telemetry`, `implant_serial_reuse`, `tampered_after_anchor` (evidence anchor mismatch), `revoked_device`, `impossible_travel` |
| Out of IoMT scope | `fraud_outside_iomt_scope`: a padded bill that no device can see |
| **Benign look-alikes** | `benign_sensor_outage`, `benign_gateway_down`, `benign_hd_early_termination`, `late_anchor` |

The benign look-alikes are the guardrail test: one faskes' whole gateway goes down for three days, a dialysis session is
stopped for hypotension, 8-30 hours of readings are lost. The right answer is **verify**, not an accusation.

The *referral & self-referral* mode of Permenkes 16/2019 is **not modelled**: it needs FKTP device status and ambulance
telemetry, which are not in this data.

Fraud is planted as a count per scenario (4-17 examples), not a probability, so every mode has enough examples. Where it
lands is weighted by each faskes' hidden risk tier (`ground_truth_faskes.csv`), so a faskes-level audit has a signal too.

## Baseline auditor results

`audit.py` is plain rules and deliberately conservative: missing readings count in the claim's favour.

- Fraud the devices can see: **210 of 218 caught (96%)**; severity upcoding, which devices can only send for review, **16 of 16 flagged**.
- 224 disputes: 210 fraud, 10 are the honest partner of a paired claim, **4 are wrong**.
- Honest claims disputed: 0 (4 honest severity III stays were sent for review). Benign anomalies disputed: 4 (short dialysis sessions at a faskes that really has that pattern).
- Missed: 8 subtle frauds (a 1-day ICU or stay overbilling, short dialysis sessions that look clinical), plus 44 padded bills out of IoMT scope.

A number this high is **not** an estimate of performance on real data. The synthetic data is clean and each scenario is
clear-cut; real data is messy. What it does show: device evidence is informative, and what is left for the swarm is what a
single-claim rule cannot answer: faskes-level patterns, peer comparison, bills outside device scope, and threshold cases.

## Upcoding, in depth

`audit.py` also writes `upcoding_report.md`. Upcoding hides in four places, and each has its own device signal:

| where it hides | device signal | result |
|---|---|---|
| Severity tier (III instead of II) | **acuity index**: vitals instability, ICU hours, invasive ventilation, infusion doses | verify: devices measure intensity of care, not the diagnosis |
| Ventilation code (96.72 / NIV as invasive / no ventilation) | ventilator runs and mode (IMV / NIV / STANDBY) | dispute: the device states what ran |
| Dialysis session | `dialysis_active` minutes | dispute on a faskes pattern, verify when isolated |
| Imaging unbundling | acquisitions per exam vs exams billed | dispute: one exam, several acquisitions |

The money is in the tier, not the code: here a severity III stay is paid ~Rp 38 million more than II on a ventilated stay and
~Rp 18 million more in the ICU. Ground truth carries the true overbilling per claim (`overbilled_rp`); the auditor, pricing each
flagged claim against the median severity II stay of the same kind, estimates Rp 1,409 million against Rp 1,319 million true.

## IoMT Audit Report (the BPJS demo)

`audit.py` also writes `audit_out/report.json`: the whole audit as one report (headline, workflow, fraud modes, faskes, 319
claims with their evidence timelines, guardrails, score). In the audit app it is the **IoMT Audit Report** view, inside the
"IoT · IoMT · Blockchain" tab. It is a workflow of its own: it reads only this synthetic world, never the swarm's BPJS data.

A combined audit report is the swarm's report plus this one as a section: the JSON uses the same fraud-mode groups
(Permenkes 16/2019) and the same two outcomes, dispute and verify. Embedding it in a real engagement's report is not done.

A six-minute demo:

1. **The workflow strip**: 100,000 readings, integrity check, reconcile claims with devices, guardrails, decide.
2. **Fraud modes**: click *Upcoding & unbundling*, open the top claim: 146 h of ventilation billed, 66 h measured, with the device timeline.
3. **Guardrails**: 30 faskes offline and 30 late evidence anchors are held back as "verify". No honest faskes is accused.
4. **Where**: one faskes carries 52 findings in 85 instrumented claims, a faskes-level signal for the swarm.
5. **How we know**: the synthetic ground truth, and the caveat that a clean synthetic world is not a forecast.
6. **Verifier Desk**: drop a faskes evidence bundle, and show it checked independently against the ledger, including a forgery with every hash recomputed.

Refresh after changing the data: `generate.py`, then `audit.py`, then reload the view. The UI served by `next start` is a
production build: run `build-web.ps1` after pulling these UI changes.

## From here to the AI Agent Swarm (not done)

The swarm reads Nexus objects (`Klaim Berisiko`, `Profil Faskes`, ...). Suggested mapping: `claims.csv` -> a claim type with
device-evidence columns; `devices.csv` and `iot_readings.csv` -> a sensor object type and a time series sync, like the
existing IoT demo (`api/demo_jkn_iot.py`); `evidence_anchors.csv` -> integrity properties; `ground_truth*.csv` stays outside
the swarm and is only used to score it. `scenarios.csv` can serve as the list of fraud modes for the agents. None of this is wired.

## Technical notes

- Reading hashes and Merkle roots use sha256 for portability; the real faskes ledger uses keccak256 and a signature per
  device. This dataset has no signatures, only hashes and roots.
- `seq` runs per device and metric over the whole stream, including lost readings, so a gap in the sequence is evidence.
- `imaging_exam` carries its acquisitions in `value`: a CT has several, billed once as one exam. Honest severity III follows the care delivered (acuity >= 0.6 in the ground truth).
- Vitals every 2 hours, bed state every hour, dialysis every 5 minutes; an SpO2 or HR of 0 is a probe-off artefact (deliberate, to be cleaned).
- Claimed ICU days are counted by calendar date (as a ward clerk does), so they can exceed occupied hours by 1; the auditor allows +1.
