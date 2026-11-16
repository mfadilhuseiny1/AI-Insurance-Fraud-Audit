# v4 work: status and how to resume (2026-11-12, ~21:30)

Synthetic data only. The plan, criteria and rules are fixed in `testing/kriteria_v4.json` (written before any v4 result). Its
addenda are appended by scripts, and its earlier text is never edited.

## Runs without Claude
`testing/pipa_otomatis.sh` runs as a detached Windows process, started 21:27.
- Status, one line per step: `.tmp/pipa_status.log`. Full output: `.tmp/pipa_otomatis.out`.
- Order:
  1. wait for `.tmp/data_v4` (10 chunks + `stream_x4.npz`), restarting the build if it stopped;
  2. `testing/pilih_aturan_v4.py`: new rules chosen on validation chunks 8–9 only, writes `.tmp/data_v4/aturan_v4.json` and appends
     an addendum to kriteria_v4.json;
  3. test C2 (`UJI100K_SET=C2 UJI100K_FITUR=1 uji100k.py jalankan` → `.tmp/uji100k_c2`, X1/X2/XR/X4);
  4. gen2 seed 3 (`GEN2_SEED3=1 uji_gen2.py jalankan` → `.tmp/gen2_seed3`);
  5. generator 3 (`GEN3=1 uji_gen2.py jalankan` → `.tmp/gen3_uji`), once `testing/generator3.py contoh 0` succeeds; it waits up to 3 h.
- Every heavy step takes `.tmp/BERAT.lock` (one line "owner time"; never delete someone else's lock).
- Re-running the script is safe; the builders skip finished chunks.
- To check: `cat .tmp/pipa_status.log`. To restart: `bash testing/pipa_otomatis.sh` from the repo root.

## Update 2026-11-13 04:20
- Pipeline results:
  - steps 1–4 done: data_v4, rule selection, test C2 (10 chunks), gen2 seed 3 (8 chunks);
  - step 5 (generator 3) failed. The generator was incomplete, and the runner needed `G.SPECIALS`; the runner is fixed now (getattr).
  - Rerun step 5 once generator3 is finished: `bash testing/pipa_otomatis.sh` skips the finished steps.
- Rules chosen on validation (`.tmp/data_v4/aturan_v4.json`):

| Rule | Fires on training normals | Validation precision |
|---|---|---|
| KLON_MIRIP ≥ 2 | 0.20% | 75% |
| KLON_MIRIP_14H ≥ 2 | 0.39% | 66% |
| KARTU_DI_RS_LAIN_HARI_SAMA ≥ 2 | 0.02% | 100% |
| TOPUP_JAUH_DI_ATAS_KODE ≥ 2 | 0.12% | 77% |
| DX_SEKUNDER_DI_ATAS_P90 ≥ 3 | 0.37% | 61% |

  - Not chosen: premature discharge, readmission after a short stay (precision 14–27%), hospital drift (< 10%). They stay as model features.
- All four subagents (rule backend, generator 3, graph/DL variants, hospital layer) hit the 5-hour usage limit at ~22:00. Their partial
  files are on disk, and they were resumed at 04:16.

## Needs Claude (work in progress when this was written)

| Item | Files | State |
|---|---|---|
| Rule-engine backend + AI assist (DeepSeek/OpenRouter) | `api/aip/realtime/aturan_kustom.py`, `routes.py` endpoints, hook in `mesin.py`, `api/test_aturan_kustom.py` | subagent running; contract `docs/RULE_ENGINE_KONTRAK.md`. Goes live only after an **API restart (8300)** |
| System Architecture tab | `web/src/components/aip/SystemArchitectureView.tsx` + `SysArch*.tsx`, tab "arsitektur" in `app/aip-jkn/page.tsx` | done, tsc clean. Needs `build-web.ps1`, then check on screen |
| Generator 3 (independent; HEADLINE out-of-distribution test) | `testing/generator3.py` | subagent running |
| Hospital × period layer (variant C) | `testing/fitur_rs_v4.py` + `testing/test_fitur_rs_v4.py` | subagent running |
| Variants A/B/D/E/F (GraphSAGE, R-GCN, GNN embeddings + LightGBM, MLP/FT-Transformer), shared evaluator | `testing/varian_graf_dl.py` → `data/aip/ml/sistem_terbaru/varian_v4_graf_dl.json` | subagent running; adds C when fitur_rs_v4 exists |
| Final assembly | fusion + two-tier decision on the winning variant, frozen on validation, then ONE scoring on generator 3 / gen2 seed 3 / test C2 | not started |
| Report | ML Studio and System Architecture | not started; must read from data |

## Constraints that still hold
- `/testing` (pid 13664) still serves model_v3 with the old fitur.py. Restart it only with a model swap the user decides on.
- `fitur.py` has one feature path; `testing/test_fitur_satu_jalur.py` must stay green. X4 (`testing/fitur_v4.py`) is computed per
  claim only.
- LOS under INA-CBG: the abuse is the SHORT stay (premature discharge, then a readmission billed as a second CBG), not the prolonged
  one.
- Generator 3 is the headline. gen2 seed 3 and test C2 are supporting only, because data_v4 was shaped by what generator 2 showed.
- Test C was rebuilt once (the invalid build is kept in `.tmp/uji100k_c_ongeldig`; its addendum is in `testing/kriteria_langkah4.json`).

## Update 2026-11-13 ~04:50
- Variants (validation, 3 seeds; `data/aip/ml/sistem_terbaru/varian_v4_graf_dl.json`):
  - A: recall@FPR1% 69.2%;
  - **B (X1 + X4): 75.4%**, prec@FPR0.1%/2% 90.5%, AUPRC 0.857 → winner so far;
  - C pending (hospital layer);
  - D/E/F deferred (user's decision, recorded in kriteria_v4.json).
- `testing/v4_final.py latih --varian B` froze `testing/model_v4`:
  - route components were chosen greedily on validation, and none adds recall at FPR 1% (the model already uses X4), so the route is empty;
  - PERIKSA recall 76.1% at FPR 0.99%; TAHAN recall 46.4% at FPR 0.093%.
  - If C beats B on validation, re-run `latih --varian C`.
- Next: when generator 3 is ready, run `bash testing/pipa_otomatis.sh` (it builds .tmp/gen3_uji), then `python testing/v4_final.py uji` ONCE.

## FINAL 2026-11-13 ~05:05 (v4 = variant B, frozen, scored ONCE; data/aip/ml/sistem_terbaru/v4_final.json; ML Studio → Sistem ML terbaru → v4)

| Test | PERIKSA recall / FPR / prec @2% | TAHAN recall / prec @2% | AUPRC | v3 bersih recall |
|---|---|---|---|---|
| generator 3 (headline) | 30.5% / 1.27% / 33% | 13% / 70% | 0.29 | 23.5% |
| test C2 | 87.9% / 0.57% / 76% | 54% / 95% | 0.94 | 72.5% |
| gen2 seed 3 | 48.0% / 1.57% / 38% | 20% / 67% | 0.43 | 38.5% |

- Cross-generator K1, K2, K4, K5: tidak konsisten; K3: sebagian. First-visit FPR is about 5× returning on every test.
- Variant C (hospital layer) was not better on validation (74.3% vs B 75.4%). D/E/F were deferred by the user.
- Still open:
  - API restart (8300) to activate the rule engine (the user must run it; the auto-mode classifier refused it);
  - batch-audit API endpoint (the user's plan; real data is batch).

## Graph / DL variants 2026-11-13 ~05:40 (RunPod GPU; report: ML Studio → Sistem ML terbaru → "Arsitektur & sistem terbaru")
- D/E/F trained on a RunPod RTX 4090 pod (synthetic data only; key RUNPOD_API_KEY_2; pod deleted): 1.3 min, about $0.18.
  Code: `testing/varian_graf_dl_model.py` now uses CUDA when available and saves CPU weights (`.tmp/varian_graf_dl/model_*.pt`).
  CPU load check: identical scores (max diff 3e-6), 100% same flags, R-GCN inference 0.18 s for 97k nodes (`cek_cpu_load.json`).
- Validation, recall at FPR 1% (3 seeds): B 75.4% (selected), E_sage 74.7% (tie → simpler B), C 74.3%, E_rgcn 74.3%, A 69.2%,
  D_sage 67.8%, D_rgcn 66.4%, F_mlp 62.6%, F_ft 45.3%. Selection unchanged: v4 = B.
- Generator 3, SECOND use (exploratory, `testing/varian_graf_dl_gen3.py` → `v4_graf_gen3.json`; thresholds from validation):
  PERIKSA recall / FPR: B 30.5% / 1.27% (reproduced), D_sage 36.3% / 1.32%, D_rgcn 31.5% / 1.55%, E_sage 36.7% / 1.49%,
  E_rgcn 35.8% / 1.30%. Gains on billing-inflation schemes (topup/tagihan gelembung), not on network schemes. GraphSAGE lowers
  first-visit FPR (3.3% → 2.1%) but raises returning-patient FPR (0.6% → 1.1%).
- To adopt a graph hybrid: register it, then score ONCE on fresh data (a new generator 3 seed), since generator 3 is now used twice.
- `testing/laporan_graf.py` builds `arsitektur_graf.json` and injects it into sistem.json.

## v4 + rule engine (exploratory) 2026-11-13 (`testing/v4_rule_tambah.py` → `v4_rule_tambah.json`; ML Studio → "Arsitektur & sistem terbaru" → "v4 + rule engine")
- Rules: the 5 v4 rules + v3's 23 built-in rule signals + the network rule; rule hit → PERIKSA only (TAHAN unchanged). On the validation
  normals they fire on 0.97 % of claims: almost the whole FPR 1 % budget.
- Rules added on top of the frozen threshold (recall / FPR / precision at 2 % fraud):

| Set (use) | B | B + rule |
|---|---|---|
| validation | 76.1% / 0.99% / 61% | 77.0% / 1.73% / 48% |
| test C2 (2nd) | 87.9% / 0.57% / 76% | 88.7% / 1.02% / 64% |
| gen2 seed 3 (2nd) | 48.0% / 1.57% / 38% | 53.9% / 2.13% / 34% |
| generator 3 (3rd) | 30.5% / 1.27% / 33% | 38.1% / 2.09% / 27% |

- Precision drops in every set (CIs all below 0). Holding FPR at 1 % (model threshold raised) drops recall to 24–48 %.
- Useful on generator 3: the network rule (rujukan_semu 8 % → 42 %), TOPUP_JAUH_DI_ATAS_KODE, READMISI_DX_SAMA. Noise: KLAIM_GANDA_RIWAYAT
  (0–1 % precision), DX_SEKUNDER_DI_ATAS_P90 on generator 3 (3 %).
- v4 stays B. A pruned rule route would have to be chosen on validation and scored once on a fresh set.

## v5 = v4 + rule engine + AI Agent Swarm (Google ADK, Vertex AI) — 2026-11-13 (`testing/v5.py`, `testing/swarm_v5_adk.py`, `testing/kriteria_v5.json`)
- **Swarm:** Google ADK 2.12 in `.venv-adk`, built as `SequentialAgent(ParallelAgent(koding, tagihan, episode), hakim)`.
  - Model: DeepSeek V4.1 Flash on Vertex MaaS, global endpoint, the platform's Google credentials. No OpenRouter (the user's request).
  - Prompt p2: Permenkes modes, how to read the dossier, innocent explanations, a p scale, evidence first. It was written before any accuracy was seen.
  - Dossier: facts from features only (`testing/swarm_v5.py`): no score, no label, no scheme.
  - Run: batches of 8, paralel 2 (Vertex 429 at 6), cache `.tmp/swarm_v5/cache_adk.jsonl`.
- **Zones:**
  - TAHAN: s ≥ v4 TAHAN.
  - RAGU: s ≥ the score at FPR 3% on validation, OR a rule hit. The swarm reads only these.
  - The rest is LOLOS.
  - Picked on validation: V5b, (p + percentile of s)/2 ≥ 0.72, total FPR ≤ 1%.
- **Validation (in distribution): v5 is WORSE.**
  - Recall 64.2% vs v4 76.1% at FPR 0.99%.
  - In the RAGU zone, AUROC is 0.60 for the judge vs 0.84 for model B.
- **Fresh generator 3 seed (GEN3_GARAM=gen3-v5, 40,259 claims, 798 fraud), scored ONCE:**

| | Recall | FPR | Precision at 2% fraud |
|---|---|---|---|
| v4 | 33.5% | 1.22% | 35.9% |
| v4 + rule | 40.5% | 2.04% | 28.9% |
| **v5** | **37.2%** | **0.91%** | **45.6%** |

  - v5 − v4: recall CI [+1.4, +6.2]; precision CI [+6.6, +12.7].
  - The pre-registered adoption rule PASSES.
  - In the RAGU zone, AUROC is 0.77 for the judge vs 0.65 for the model: the swarm generalises better out of distribution.
  - Gains: top-up / billing inflation, planned readmission, fictitious drugs and devices.
  - Loss: upcoding keparahan 23% → 8%.
  - First-visit FPR 3.3% → 1.8%.
- **Spend (Vertex, from tokens):**
  - validation $0.66;
  - fresh set $2.08;
  - smoke tests $0.04;
  - the cut p1 run $0.17;
  - total ≈ $2.95.
- **Report:** ML Studio → Sistem ML terbaru → "v5".
- /testing still runs v3. A model swap is the user's decision.

## AI Agent Swarm Branch tab — 2026-11-13 (tab "cabang" in /aip-jkn)
- **Purpose:** the audit as a BPJS branch office (Kantor Cabang) runs it, because in practice the branch verifies the claims.
  - Each branch's batch goes through v5 (model + rule engine + ADK swarm).
  - The report is grouped by clinical theme, in the national swarm report's style: cover, contents, chapters, numbered exhibits, case files with all 4 agents' evidence.
  - The tab opens with a multi-agent animation that shows the agents' real answers.
- **Data:** `testing/laporan_cabang.py` → `data/aip/cabang/index.json` + `kc_<id>.json` (44 demo branches), served by `/api/swarm-cabang`.
  - Branch areas are a DEMO: a province's kab/kota are grouped in code order into areas of ≥ 1,200 claims.
  - Themes come from the primary diagnosis's ICD-10 chapter. Z codes go to their organ or to the INA-CBG CMG. Non-specific themes are listed last.
  - Diagnoses were recovered by regenerating generator 3 (`testing/gen3_dx.py`), because the runner kept none.
    - Generator 3 is NOT deterministic across processes: set order depends on PYTHONHASHSEED. The script tries several hash seeds per chunk.
    - Coverage 96.4% (chunk 4: 72%). Unaligned claims fall back to the CMG.
  - Per-agent answers come from the swarm cache (`swarm_v5_adk.py ekspor`, no model call).
- **UI:** `SwarmCabangView.tsx`, `SwarmAnimasi.tsx`. `ExhibitCard` is now exported from `LaporanLengkap.tsx`.
- **Run 2026-11-13 10:27 (the user: "coba run sekali, save hasilnya, cap $20"):**
  - Batch 2 = a new generator 3 seed (`gen3-kc1`, 40,292 claims, 879 fraud), run end to end by `.tmp/run_kc1.sh`; the runner now saves `dx`/`dx_nama`.
  - Swarm (Vertex): $2.20, 830 calls, 20 throttles, paralel 3.
  - Writer agent (ADK, "Mengapa penting"/"Implikasi" per exhibit): $0.13 for batch 2 and $0.14 for batch 1. Sentences whose numbers are not in the facts are dropped by code (2 and 1 dropped).
  - Batch 2, v4 → v5: recall 31.3% → 33.7%, FPR 1.22% → 0.97%, precision at 2% fraud 34% → 42%. Same direction as batch 1.
  - Saved under `data/aip/cabang/<run>/`, listed in `runs.json`. The tab has a run selector.
  - Branch areas are now stable across runs: built from the hospitals' historical volume, 3% of national claims each, 45 branches.
- **Operational report redesign (2026-11-13, after a reviewer's notes; the user: "metrik yang gaada di real audit gausah"):**
  - The audit report answers three questions only: what the system found, why each claim needs review, what the verifier should do.
  - Operational measures only: claims analysed, queued (%), billed value flagged, and the verifiers' results (terbukti bermasalah / sesuai / perlu investigasi / belum).
  - Per claim:
    - indikasi modus, indicators (rules + model SHAP), supporting evidence, confidence;
    - the swarm's 3 specialists + judge, with how far they disagree and the judge's final reason;
    - a recommended action, and a priority = risk score × bill value (P1/P2/P3).
  - Verifier decisions are saved by `POST /api/swarm-cabang` into `data/aip/cabang/<run>/verifikasi.json`.
  - Narrator sentences that mention "fraud" are dropped.
  - Model evaluation moved to "Lampiran A" (collapsed, internal, `testing/cabang_analisis.py`): design of the splits, confusion matrices, LightGBM / +rule / fair test / v5, rupiah, and where fraud is lost per theme.
  - Batch 2 fair test: v5 − model-only filter with the same queue size gives recall CI [+2.3, +6.6] points.
  - Most missed fraud never reached the uncertain zone (paru: 41 of 51), so the model and the zone threshold are what to improve, not the swarm.
- **Real BPJS data (ai-jkn-audit `data/bpjs-sampel/silver`, read-only):**
  - 5.4 M FKRTL claims, 2015–2024 (Dec 2024: 363k).
  - Label proxy `flag_selisih_verifikasi` at 0.1%. No branch column.
  - v4 on real data needs the real history/peers feature pipeline. No swarm (pakta integritas). Waiting on the user's decisions.

## ML v5 (2026-11-13; `testing/ml_v5.py`, `testing/kriteria_ml_v5.json`, model `testing/model_ml_v5`)
- **Training data:** generator 1 (stream + data_v4 0–7) plus a new generator 2 seed on "latih" members (`gen2_ml5_latih`, 8 chunks); 129,127 claims.
- **Dev:** data_v4 8–9 plus generator 2 on "validasi" members (`gen2_ml5_dev`).
- **Candidates:** K1/K2 (+X5 `testing/fitur_v5.py`), each with a global or per-segment threshold.
  - Chosen: **K1g**, i.e. v4's features retrained on generator 1+2 with one global threshold.
  - X5 and per-segment thresholds added nothing on dev.
- **Overfit check:** AUPRC 0.933 in-sample vs 0.887 member-grouped CV; seed spread ≤ 1.3 points; no feature above 30% of gain. No warning.
- **Benchmark** (frozen thresholds; v4 → ML v5):

| Set | Recall | Precision at 2% fraud |
|---|---|---|
| Generator 1 (test C2) | 87.9% → **84.1%** (CI −5.1/−2.4) | 76% → 71% |
| Generator 2 (seed 3) | 48.0% → **65.1%** (CI +14.7/+19.6) | 38% → 47% |
| **Generator 3** (new seed `gen3-ml5`, scored once) | 32.1% → **40.3%** (CI +6.0/+10.4) | 32.5% → 36.4% |

  - Generator 3 AUPRC 0.258 → 0.321.
  - Generators 1 and 2 had been seen before, but not used to choose.
- **UI:** ML Studio top shows the v5 summary, the architecture visual (`ArsitekturV5Visual.tsx`, clickable details), precision vs fraud rate per generator, and the benchmark (`BenchmarkMlV5.tsx`).

## Gaps fixed 2026-11-13
- **API 8300 restarted** (watchdog started first). Custom rules are live: 21 rule routes.
- **AI Agent Swarm Branch → ledger:** `api/aip/realtime/cabang_tag.py`, routes `/api/aip/realtime/v1/cabang/{tag,putusan}`.
  - Batch 2 wrote 677 tags.
  - Verifier decisions are forwarded by the Next route.
- **Box Karantina rebuild (13:02) replaced the 10 Nov numbers:** 2,235 hospitals / Rp 17.6 B before, 1,807 hospitals / Rp 5.9 B after.
  - Not recoverable: the ontology copy re-synced and the snapshot tables were empty.
  - Statuses and decisions were kept.
  - The drop comes from the ledger changing since 10 Nov, plus `rasio_koreksi_median` = 0 (screening objects carry no corrections); not from the branch tags.
  - **Back up the Box before any rebuild.**

## ML v6 (2026-11-13): Quantexa-style network features, no LLM cost
- **Features and rules:** X6 network features in `testing/fitur_v6.py`:
  - hospital–hospital graph from shared members (30 days);
  - PageRank and communities;
  - rule-score propagation;
  - referral motifs.
  
  Pre-registration: `testing/kriteria_ml_v6.json`. Rule: L2 (+X6) only if it beats L1 by ≥ 1 point mean dev recall.
- **Dev result:** L1 70.01% vs L2 70.04%, so **ML v6 = ML v5**. X6 holds about 1% of L2's gain. The L2 model is kept as exploratory (`testing/model_ml_v6/model_l2_eksplorasi.joblib`).
- **Benchmark** (`data/aip/ml/sistem_terbaru/ml_v6_benchmark.json`; generator 3 = fresh seed `gen3-ml6`, scored once). L2 vs ML v5:

  | Generator | Recall | prec@2% |
  |---|---|---|
  | 1 | 83.5 vs 84.1% | 72 vs 71% |
  | 2 | 63.5 vs 65.1% (CI −2.5/−0.5) | 48 vs 47% (CI +0.8/+2.8) |
  | 3 | 39.3 vs 39.4% (CI −1.0/+0.7) | 37 vs 37% |

  It moves along the curve and does not improve it. The ML Studio section is `BenchmarkMlV6.tsx`.

## Distribution-shift diagnosis (2026-11-13, reviewer note)
- **What it is:** `testing/diagnosa_shift.py` writes `shift_diagnosis.json`, shown in ML Studio by `DiagnosaShift.tsx`.
  - Model: ML v5, frozen.
  - Data: G1 = C2, G2 = seed3, G3 = gen3_ml5 + gen3_ml6. **Those G3 labels are now used; any later G3 claim needs a new seed.**
- **Normals barely shift:**
  - FPR at the frozen threshold: 0.70% / 1.52% / 1.41%.
  - Median normal score ≈ 0.002 in all three.
  - KS on the top features for normals is ≤ 0.2, about the same as G1 vs G2.
- **Fraud claims carry the shift:**
  - Median fraud score: 0.84 (G1), 0.53 (G2), 0.12 (G3).
  - Model AUROC: 0.984 / 0.959 / 0.879.
- **No flipped signals:** 0 of 54 training signals flip in G3; 49 hold, 4 vanish, 1 weakens. The Spearman correlation of signal direction is 0.87 for G2–G3 and 0.76 for G1–G2.
- **The 4 vanished signals are G1/G2 fingerprints** and hold 10.5% of ML v5 gain:
  - domicile distance to the FKTP and to the home;
  - days since the previous claim;
  - the same-hospital neighbour version of that.

  G1/G2 plant fraud on far-away members with odd timing; G3 does not. Rule score (42% of gain) has a fraud median of 48.7 in G1 and 0 in G2/G3.
- **Scheme mix is not the cause:** G3 recall under G2's family mix is 37.2% vs 39.8% actual. Recall drops inside every family:

  | Family | G2 → G3 recall |
  |---|---|
  | Coding | 48 → 17% |
  | Network | 72 → 8% |
  | Identity | 83 → 50% |
  | Billing | 85 → 67% |
  | Episode | 45 → 36% |

- **Domain classifier:** every generator pair is very separable (AUC 0.88–0.99; G1 vs G2 = 0.97).
- **Proposed next steps** (reviewer order), not started:
  1. remove the fingerprints in the G1/G2 generators;
  2. leave-one-generator-out validation, selecting on the worst generator;
  3. domain generalization or group DRO, plus "subtle fraud" augmentation.

  **Caveat:** the fingerprints were found with G3 labels. Shaping G1/G2 after them makes new G3 seeds less foreign, so an honest test then needs a separately written generator 4.

## ML v7 (2026-11-13): reviewer-order fix for distribution shift, ADOPTED
- **Pre-registration:** `testing/kriteria_ml_v7.json`.
- **Step 1, data:**
  - `GEN2_HALUS=1` in generator2.py (backup `.tmp/generator2.py.bak_ml7`). Phantom billing, borrowed card and the ring use local members with history.
  - New sets `.tmp/gen2_ml7h_latih` (seed 555000) and `.tmp/gen2_ml7h_dev` (seed 666000).
  - These subtle sets are harder: v3 recall 32.5% vs 39% on regular G2.
- **Steps 2–3:** candidates A1 (data), A2 (equal weight per generator), A3 (group DRO), A4 (context randomisation), in `testing/ml_v7.py`.
  - Generator-out worst direction: A1 = A2 = A4 41.5%, A3 37.3%. The tie goes to the simplest, so **A1** is chosen.
  - A4 equalled A1 in the generator-out runs, because the G3-blind instability check found 0 features within a generator.
  - Pooled dev: A1 65.8% vs ML v5 63.75%.
  - Overfit check: clean.
- **Generator 4:** `testing/generator4.py`, written blind by a separate agent (it read no model, feature, rule-engine or diagnosis files).
  - 20 schemes in 5 families, about 1.8% fraud.
  - Normal claims come from generator 3's world.
  - The runner hook is `GEN4=1`, `GEN4_GARAM`, `GEN4_KERJA` in uji_gen2.py. Test set: `.tmp/gen4_ml7` (seed gen4-ml7).
- **Benchmark, scored once** (`data/aip/ml/sistem_terbaru/ml_v7_benchmark.json`). ML v5 → ML v7 (A1):

  | Generator | Recall | prec@2% | FPR |
  |---|---|---|---|
  | 1 | 84.1 → 84.8% | 71 → 69% | |
  | 2 | 65.1 → 65.6% | 47 → 47% | |
  | 3 (fresh gen3-ml7) | 39.2 → 40.7% (CI +0.5/+2.6) | 38 → 38% | |
  | 4 (blind) | **12.4 → 14.2% (CI +0.9/+2.8)** | 16.0 → 16.9% | 1.33 → 1.43% |

  **The adoption rule passed.**
- **Generator 4 limits:**
  - Every model catches little: v4 10%, ML v7 14%, v3 bersih 16%.
  - v3 catches `poli_dipecah_sehari` 100% through its rule route; every ML-only model gets 0%.
  - 6 of 20 schemes are missed by every model (calo_katarak, kartu_almarhum, kemo_batal_ditagih, kontrol_tambahan, operator_dua_rs, rajal_naik_prosedur).
  - The rule engine and swarm layers matter there.
- **Not re-scorable:** generator 3 seeds now used are v5, kc1, ml5, ml6, ml7; generator 4 seed gen4-ml7 is used. A new claim needs a new seed (and, for generator 4, ideally a new blind generator).
- **Where it shows:**
  - ML Studio: `BenchmarkMlV7.tsx`, shown at the TOP of Sistem ML terbaru ("show v7 on top of ML Studio").
  - Hackathon report: `testing/laporan_hackathon.py` + `testing/laporan_hackathon.html` → `docs/laporan_hackathon.html`, published as a private artifact at https://claude.ai/artifact/8c7kPJrPzURQo3QFhoAVPA.
- **Gen 1 report (2026-11-13):** the user scopes the hackathon claim to G1-like data.
  - Built by `testing/laporan_gen1.py`, using `testing/laporan_gen1_body.html` plus the shared CSS assembled into `laporan_gen1.html`. Outputs: `docs/laporan_gen1.html` and `gen1_report.json`.
  - Published privately at https://claude.ai/artifact/E4pLwWTjsySxxUncAfcMj2.
  - Headline: v4 on C2, recall 87.9% (CI 85.4–90.3), prec@2% 76% (72–81), FPR 0.57%, TAHAN 54% at FPR 0.05%.

## ML v7 end-to-end trial: swarm + Box Karantina, one branch (2026-11-13)
- **Integration:**
  - `v5.py siapkan --model ml_v7`: zones from `testing/zona_ml_v7.py`, computed on ML v7 pooled dev normals. TAHAN = FPR 0.1% (0.783), PERIKSA = 1% (0.293), RAGU = 3% (0.121). τ = 0.72 from v5, not re-chosen.
  - `laporan_cabang.py --kc <id>`:
    - one branch per run;
    - per-claim estimated loss (`taksir_kerugian`, mode = ledger tag);
    - cover values: nilai transaksi dianalisis / nilai klaim terindikasi fraud / estimasi kerugian;
    - a "Estimasi kerugian" chapter with exhibits per mode, hospital and theme, plus writer-agent commentary (makna/implikasi) in the national style;
    - appendix check of the loss against labels.
  - `cabang_tag.tulis` carries `estimasi_kerugian_rp`; `karantina.claim_loss` adds part `estimasi_cabang`; `jejak_data` shows it. Backups are `.tmp/*.bak_kc2`.
- **Loss rule per mode:**

  | Mode | Estimated loss |
  |---|---|
  | Upcoding | tariff gap to one severity lower |
  | Billing | bill above 1.5× code median (Box's band), or top-up above code median |
  | Fictitious | 100% of the bill |
  | Duplicate / clone / split / readmission / sham referral | 50% (Box's DUPLICATE_SHARE) |
  | No mode | above 1.5× median |

- **Trial run:** fresh batch `gen3_kc2` (generator 3, seed gen3-kc2, 40,274 claims). Branch **KC Makassar** (`sul-7371`): 1,664 claims, 90 hospitals.
- **Cost:** swarm on 86 uncertain claims $0.115, writer agent about $0.01, smoke $0.01. Total ≈ $0.13 (ceiling $15).
- **Results:**
  - Nilai transaksi Rp 1.46 B; nilai klaim terindikasi Rp 176.0 M (37 claims: 7 TAHAN, 30 PERIKSA); estimasi kerugian **Rp 115.6 M**.
  - Labels (appendix only): 9 of 37 queued claims are fraud; Rp 49.8 M (43%) of the estimate sits on real fraud, so the cover value is an upper bound before verification.
  - Branch metrics: ML v7 alone recall 31.8%, FPR 1.95%; full flow recall 40.9%, FPR 1.7%, prec@2% 33%. Only 22 fraud claims, so the CIs are wide.
- **Ledger and Box:** 37 tags written (`POST /cabang/tag`).
  - Box backed up at `.tmp/box_backup_20261113_1538`, then rebuilt: 1,807 → 1,810 facilities, Rp 5.91 B → Rp 6.03 B.
  - All 21 hospitals of the branch are in the Box, with `estimasi_cabang` summing to Rp 115,605,200, the same as the report.
  - API restarted via the watchdog.

## Real-sample trial, one branch (2026-11-13; `testing/uji_riil.py`)
- The user asked for ML v7 + the swarm on the real BPJS sample, one KC, and confirmed that the written approval covers Vertex.
- **Code paths (env, defaults unchanged):**
  - `PLATFORM_DRIVE` (platform_lokal), `FITUR_V4_DRIVE` / `FITUR_V4_CACHE` (fitur_v4);
  - `SWARM_V5_KERJA` / `UJI_SET_ROOT` (v5, swarm_v5_adk, laporan_cabang);
  - `CABANG_BASIS`, `UJI_RIIL_RS` / `UJI_RIIL_FKRTL` (laporan_cabang real mode: no labels, appendix = verifier-correction proxy);
  - `CABANG_DIR` (web route; no ledger calls).
- **Where things live:**
  - Everything derived from real data is under `ai-jkn-audit/data/aip/uji_riil` (git-ignored); summary in `RINGKASAN.md` there. No numbers here.
  - Viewed on a separate local UI instance: port 9310, build copy `web/.next-riil`, started by hand. The 9300 app never lists the run.
- **Gotcha:** `ENGINE.wait()` keeps only recent results, so a 56k batch hangs there. `uji_riil` polls the store and builds features from the stored events (`fitur`).
- **Result direction:** ML v7's zone shares on real data sit far below the synthetic dev calibration, so thresholds need re-calibration on real data before any real use.

## Claim network in the AI Agent Swarm Branch case file (2026-11-14)
- **What:** every case file in the branch tab now has a "Jaringan klaim" panel (`web/src/components/aip/GrafKlaim.tsx`): the claim, its four Model 1 relations (same member / hospital + code / hospital / code) and the earlier claims the model averaged (last 10/10/10/5), the ±14-day ring, and the ties a verifier checks by hand (same day + code, overlapping stay, readmission ≤3 days, same card at another hospital ±3 days, clone-like inpatient bill).
- **Data:** `testing/graf_cabang.py --set <run> [--kc <id>]` writes `data/aip/cabang/<run>/graf_<kc>.json`, served by `/api/swarm-cabang?run=&kc=&graf=1`. `laporan_cabang.py` now calls it at the end (synthetic runs only).
  - The stream is rebuilt as `uji_gen2.py` built it per chunk (`.tmp/testing-data` stream + the chunk's claims appended in saved order), and each network is read right after its claim is appended.
  - Check: rebuilt neighbour counts vs the X1 degree columns and the ±14-day ring vs XR. gen3_kc2 93/93, gen3_kc1 1,765/1,765, gen3_v5 1,711/1,711 match.
  - No model or LLM call; no labels written. Needs `.tmp/<run>/hasil_*.npz` and `.tmp/testing-data` unchanged since the run.
- **Vendor names removed from the branch tab** (the user, 2026-11-14): no Google ADK / Vertex AI / DeepSeek / ADK class names in the diagram (`SwarmCabangBagan.tsx`), the report view, or exhibit captions (`laporan_cabang.py`; existing `kc_*.json` captions patched). The model endpoint node reads "Model AI (LLM)".

## White-box case explanation, /testing layout (2026-11-14)
- **Asked:** every flagged claim explained in one paragraph, like /testing; "semuanya whitebox, ga ada blackbox"; understandable by executives without technical background; evidence-based reasoning for each case.
- **Text:** `testing/penjelasan_cabang.py`, called by `graf_cabang.py`, writes `penjelasan` per case into `graf_<kc>.json`. It is written by code from the case's own facts, with no LLM:
  - findings in order: ties in the claim network, then engine signals (`penjelas.TEMUAN_AWAM`), then review rules with the claim's value vs threshold (`aturan_v4.json`, network rule), then figures vs code medians;
  - the Permenkes code comes from the engine's mapping for signals (`aip.realtime.modus`), else from the kind of evidence.
  - Outputs: `paragraf`, `jenis_fraud` (code, name, confidence, evidence), `bukti`, `langkah`, `catatan` (false-positive case), `alur`, `dorongan`, and `jejak` (the technical trail with every threshold).
  - `dorongan` = the screening model's positive SHAP split klaim 0–124 / graph 124–624 / mekanisme 624–646, as `testing/app.py` BLOK_V7.
  - Plain parts carry no internal codes or shorthand. The swarm judge's notes pass through `awam()` (LOS, stream, pNN, dx); checked over all 3,569 cases.
- **UI:** `PenjelasanKlaim.tsx` lays out the case file as /testing does.
  - Header: mode, claim, score with ragu/tahan marks.
  - Tab "Graph dan penjelasan": `GrafKlaim.tsx`, now the /testing document + entity graph (d3-force, Semua / Klaim ini / Pembanding / Jaringan RS, label klaim, zoom, drag, node detail with "Buka berkas"), beside the plain panel and the verifier buttons.
  - Tab "Detail teknis": the trail plus indicators, SHAP and agent opinions.
- **graf JSON** now carries `peserta_id` / `faskes_id` per claim and the ring's claims (`relasi` "cincin").

## Theme dataset: cardiology, KC Makassar, 100k claims + FHIR medical records (2026-11-14)
- **Asked:** 100,000 synthetic cardiology claims for one branch, for a single-theme audit (value, flagged value, loss). Also a medical record per patient, for a rule engine (built in another session) that checks claims against records. No ML or swarm run yet.
- **Design (the user's choice, "ulangan setahun"):** 62 independent one-year replicas of KC Makassar's cardiology claims, each at the branch's real yearly volume (1,606 claims; silver 2024 = 1,632/yr).
  - Tooling: `testing/gen_tema.py` (generator 3 with `GEN3_W1` = a 1-year window); otherwise generator 3 is unchanged.
  - History members continue their journeys. New members replay the branch's 2024 patient sequences (hospital, care level, dx, INA-CBG group, gaps; sex/age matched), and generator 3 derives each episode.
  - Generator 3's national journey model alone made the follow-ups 61% Q-5-44. Its world holds about 13% of the sample, so only 174 cardiology members sit at KC.
  - Scenario: KC Makassar is given one dishonest hospital per hospital-level scheme (none fell there in the world draw), using mid-volume general hospitals.
- **Records:** `testing/rekam_medis.py` writes FHIR R4 on the ID Core profiles, from the true episode (the `_asli` snapshot taken before the schemes).
  - Each scheme gets its own mismatch, e.g. a fake procedure is absent from the record and vitals/labs are normal.
  - Noise on honest claims: missing dispense 5%, missing vitals 3%, missing summary 4%.
  - KFA codes are empty (ATC used). The medication-type code system is unverified.
- **Package:** `testing/paket_tema.py` writes `Data Sintetis/tema_jantung_kc_sul-7371/`: unlabelled claims, members, records, `kunci/` (labels with the true loss; planted mismatches), examples, README.
  - FHIR check: 2,103,629 resources, 0 problems.
  - Reproduce with `PYTHONHASHSEED=0`.
- **Numbers (truth):**
  - 101,604 claims, Rp336.65 B.
  - Planted fraud: 5,132 claims (5.05%), Rp32.99 B billed, true loss Rp17.51 B.
  - Per year: Rp5.43 B, of which loss Rp0.28 B (range 0.14–0.67).
- **Next (not run):** the audit pipeline per replica (uji_gen2-style chunk per replica, zones, swarm under the $20 cap, `laporan_cabang --kc`). Each replica is its own stream; do not merge replicas.

## Branch report in the national report's shape + KC map with synthetic hospital coordinates (2026-11-14)
The user: "can you make audit report like this, + our current graph for each case" (the national AI Agent Swarm long report) and
"so we can add synthetic data for hospital coordinate".
- `testing/laporan_cabang.py` now writes the national chapter order: 1 Ringkasan eksekutif (skala, alur 5 tahap) · 2 Skala dan
  konsentrasi kerugian (per modus, Pareto RS, per tema) · 3 Di mana risikonya berada (kab/kota with map, kelas RS) · 4 Bagaimana
  indikasi terjadi (tag aturan + model by strength, kode INA-CBG) · 5 Temuan per tema klinis (one section per theme) · 6 RS
  prioritas (table, groups A/B/C = cumulative estimated loss 50 % / 80 %, as Box Karantina) · 7 Berkas kasus per RS (`berkas_rs`)
  · 8 Seberapa andal (cross-checks without labels: second source, rule tag, specialists agree, repeated pattern, swarm completed)
  · 9 Keputusan (P1/P2/P3 value, decisions, verifier worklist + decision dashboard) · 10 Lampiran (scope, method, cost, Appendix A).
  Empty exhibits (a branch without recommendations, e.g. KC Tarakan in gen3-kc1) are dropped and the text says so plainly.
- Hospital names are unique (`nama_rs`: class · ownership · kab/kota, short id when two profiles share it); `label_rs` is
  unchanged for the theme dataset scripts.
- Each hospital's "Indikasi utama" comes from its claims' white-box explanations (`graf_cabang.modus_rs_ke_laporan`, Permenkes
  M-code), so the hospital summary says what its claim files say; loss tables keep the ledger tag (basis of the estimate).
- `testing/geo_rs.py`: geoBoundaries IDN ADM2 (CC BY 3.0 IGO) matched to all 490 BPJS kab/kota codes (Papua 2022 provinces by
  unique name, Pasangkayu = Mamuju Utara) -> `web/public/geo/kabkota/<province>.json` (2.1 MB in 34 files; unmatched shapes kept as
  dim context); SYNTHETIC coordinates for all 1,892 hospital profiles (fixed seed per profile, inside its own kab/kota; not an
  address) -> `data/aip/cabang/rs_koordinat.json`.
- UI: `web/src/components/aip/PetaCabang.tsx` (kab/kota shaded by estimated loss or recommendations per 1,000 claims, hospitals as
  points coloured by group, click -> case file); `SwarmCabangView.tsx` renders the chapters, the per-hospital case files (tiles,
  findings, profile, tag strength, every claim with its explanation and claim network; the first claim opens with the hospital)
  and a per-RS / per-theme switch; `LaporanLengkap.tsx` gained exhibit columns (`kolom`), the branch map and paired-bar specs.
- Rebuilt: gen3-kc2 (KC Makassar), gen3-kc1 and gen3-v5 (45 branches each). Browser checks (scratchpad pw/): report 13/13,
  other branches 5/5, system chart 9/9, claim network 17/17.

## Branch audit with IoT + medical records, end to end; first full real run (2026-11-15)
- Report: Box Karantina (A–D/Z) + TSM per hospital with the user's path rule (ditindak = T+S+M met, dibina = ≥ 1 met, dibebaskan = none);
  thresholds scale with batch size (volume linear, variety log2/sqrt); unread RAGU claims are BELUM_DIBACA, never "cleared";
  `--tema` audits; case ids collision-proof (8–12 hex + internal key); claim graphs one file per case (`graf_<kc>/`).
- IoT (synthetic; current clamp on the device power cable: on-time, duration, mode — no vitals): `testing/iot_cabang.py`
  (generate + periksa, input format `docs/IOT_FORMAT_MASUKAN.md`), engine rules `api/aip/realtime/iot.py` (12 IOT_*, contract
  `docs/IOT_KONTRAK.md`), report chapter "Verifikasi IoT alat medis", IoT tab per claim, IoT Monitoring dashboard
  (`/api/iot-monitoring`), device ↔ patient ↔ visit binding, Merkle anchors. ≥ 96 h vs < 96 h priced J-1-02 vs J-1-20.
- Medical-record rules: 7 new RME rules + parser/knowledge-base fixes; held-out recall 56.8% → 74.8%, false alerts 0.16% → 0.18%.
- Swarm integration (`testing/jalan_kc_tema.py`, stages fitur → zona → iot → aturan → swarm → laporan → narasi): RME/IoT findings in the
  dossier (prompt v5-adk-p3), routed to the owning specialist, the judge accepts/rejects each; rule-evidence lane at the τ gate.
- App: projects + "Buat audit baru" (themes, IoT source, cost cap) launching the runner; Jejak data tab; API v1 design
  (`docs/API_CABANG_V1.md`, `docs/openapi_cabang_v1.json`, 72 endpoints, IoT lane) in API Documentation.
- First full real run `jantung_iot_5r` (KC Makassar, cardiology dataset, 5 replicas, all themes, synthetic IoT): 56,593 claims,
  3,562 read by the swarm, 1,390 recommended (20 via the rule-evidence lane, 12 of them ML had passed), estimated loss Rp 4.59 bn,
  IoT 831 device claims / 14 mismatches, Box 88 RS (2 ditindak, 40 dibina, 46 dibebaskan); cost $5.91 of a $15 cap; 80 min.
