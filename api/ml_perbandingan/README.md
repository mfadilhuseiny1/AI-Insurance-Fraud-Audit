# ML vs deep learning vs LLM (ML Studio · Perbandingan)

> **AI JKN Synthetic:** dokumen ini disalin dari AI JKN Audit dan menggambarkan pengerjaan di atas Data Sampel BPJS yang asli. Angka agregat data asli sudah dihapus dan diganti `[…]`. Aplikasi ini berjalan di atas data sintetis (lihat `synthetic-gen/METODOLOGI.md` dan `synthetic-gen/laporan/EVALUASI.md`).

Who finds the claims the BPJS verifier corrected (`flag_selisih_verifikasi`)? Built 2026-11-08 at the user's request
for the ML Studio tab "Perbandingan ML · DL · LLM". Every script runs locally on CPU except `jev_run.py` and `jev_v2.py`,
which call JEv on OpenRouter (paid, capped at $5 by the user; the user stated that written BPJS approval exists).

| Script | What it does | Cost |
|---|---|---|
| `bench_dl.py --task semua\|rumah_sakit` | FT-Transformer (PyTorch) plugged into `ml_klaim.benchmark` beside Random Forest and MLP: the same grouped folds, threshold, weights and corrected t-test as the production benchmark | free |
| `compare_screen.py` | the screened claims Blu screened: OpenAI Decisions and DeepSeek verdicts read from `data/aip/telaah/telaah.db` (no new call) against out-of-fold Random Forest and FT-Transformer scores | free |
| `jev_run.py --n 80` | JEv (`typesafe/jev-router`) with Decisions' facts and rubric on 40 corrected + 40 uncorrected screened claims | ~$0.22 |
| `jev_eval.py` | those 80 claims: JEv, Decisions, RF and DL side by side | free |
| `jev_v2.py`, `jev_eval2.py` | prompt v2 (claim value vs INA-CBG tariff vs the code's median, the platform's rule catalogue without label-derived rules, the claim's ontology context) on the same 80 claims | ~$0.90 |
| `gabung.py` | writes `data/aip/ml/perbandingan/perbandingan.json`, the only file the tab reads (aggregates only) | free |

Work files (claim ids with verdicts: row-level, never in git) are in `data/aip/ml/perbandingan/kerja/`. Run with
`.venv\Scripts\python.exe -I api\ml_perbandingan\<script>.py`. OpenAI Decisions is never called: the user's standing rule
is not to use the OpenAI key again.

Caveats the tab repeats: the label is what ML and DL learn and not what the LLMs were asked; the screened set was chosen
by the production model, which had seen every corrected claim; the JEv sample is 80 claims; the FT-Transformer is untuned
and trained on CPU without dropout (dropout masks took 60 % of a step on this build).
