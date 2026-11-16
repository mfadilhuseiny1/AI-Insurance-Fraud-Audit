"""ML Studio · a notebook for every model.

* the claim-risk model of the AIP (aip/ml.py): one notebook per technique of its benchmark (ml_klaim.MODELS), which
  trains and evaluates that technique step by step on the real claims with the platform's own engine, repeating the
  benchmark's first repeat exactly so every fold can be checked against the model card; the techniques the production
  model uses are fitted again and compared with the published model, claim by claim;
* every Model Studio model: its configuration trained again with the studio's own trainer, the leaderboard checked
  against its latest run.

    model_<technique>.ipynb   one per technique of the claim-risk model
    studio_<model>.ipynb      one per Model Studio model
    code/repo/api/…           the platform's code the notebooks import (ml_klaim.py; bluesandai_model_studio.py and
                              ml_algorithms.py; model_studio.py for its row filters)
    requirements.txt, Dockerfile, docker-compose.yml, README.md
    data/…                    (in the platform's workspace only: ml_studio.py copies it) the claims, the provinces, the
                              production model, the studios' datasets

Every notebook is made from the platform's state when it is asked for (the current model card, the studios' latest
runs), so its reference numbers are always the published ones.
"""

from __future__ import annotations

import hashlib
import json
import pprint
import re
import sys
from importlib import metadata
from pathlib import Path
from typing import Any, Optional

import ml_audit_kit as kit

HERE = Path(__file__).resolve().parent
# the libraries the notebooks import, pinned at the platform's versions (the environment its models were trained in)
LIBS = ["numpy", "pandas", "duckdb", "pyarrow", "scikit-learn", "scipy", "joblib", "threadpoolctl", "catboost", "xgboost", "lightgbm", "interpret-core",
        "shap", "numba", "llvmlite", "slicer", "cloudpickle", "matplotlib"]
AIP_CODE = ["ml_klaim.py"]
STUDIO_CODE = ["bluesandai_model_studio.py", "ml_algorithms.py", "model_studio.py"]
FOLD_KEYS = ("auprc", "auroc", "presisi_top_0_1pct")
POOLED_KEYS = ("auprc", "auroc", "presisi_top_0_1pct", "lift_top_0_1pct", "recall_top_1pct")
TASK_NAMES = {"rumah_sakit": "klaim rumah sakit", "semua": "semua klaim FKRTL"}
# all cells of a technique's notebook in the platform's JupyterLab workspace (4 CPUs), measured 2026-10-27, rounded up
MINUTES = {"CatBoost": 3, "LightGBM": 3, "XGBoost": 2, "HistGradientBoosting": 3, "Random Forest": 3, "Extra Trees": 3, "Regresi logistik": 2,
           "MLP": 35, "EBM": 6}
# the techniques whose folds the 4-CPU workspace cannot repeat exactly (measured on the v0.6.0 card, 2026-10-28: the
# other seven repeat it to 4 decimals there)
THREADS_NOTE = {"XGBoost": (
    "- **XGBoost bergantung pada jumlah thread CPU.** Diuji 2026-10-27 di mesin platform, lipatan 2 klaim rumah sakit: 20 thread → AUPRC\n"
    "  0,0769 (= kartu), 8 thread → 0,0654, 4 thread → 0,0494. XGBoost membatasi diri ke kuota CPU container (4), jadi angka per lipatan di\n"
    "  sini bisa berbeda dari kartu hingga ±0,03 AUPRC pada lipatan rumah sakit yang positifnya sedikit. XGBoost tidak dipakai model\n"
    "  produksi. Tujuh teknik lain mengulang kartu persis (4 desimal) di workspace ini; LightGBM juga bergantung pada thread.\n"),
    "LightGBM": (
    "- **LightGBM bergantung pada jumlah thread CPU, dan pada pilihan otomatisnya.** Diuji 2026-10-28 di mesin platform, klaim rumah sakit:\n"
    "  tiap pelatihan memilih sendiri histogram per baris atau per kolom dari pengukuran waktu sesaat, sehingga lipatan yang sama bisa\n"
    "  berbeda antar-jalan (lipatan 5: AUROC 0,8709, lalu 0,8570). Dipaksa per baris (`force_row_wise=True`) dengan 20 thread, kelima\n"
    "  lipatan sama persis dengan kartu, dua kali berturut-turut; dengan 4 thread (kuota CPU container ini) berbeda (lipatan 4: AUROC\n"
    "  0,8029 vs 0,7780 di kartu), juga dengan `deterministic=True`. Maka angka per lipatan di sini bisa berbeda dari kartu. LightGBM\n"
    "  tidak dipakai model produksi.\n")}


def slug(name: str) -> str:
    return kit.slug(name)


def libraries() -> dict[str, str]:
    out = {}
    for d in LIBS:
        try:
            out[d] = metadata.version(d)
        except metadata.PackageNotFoundError:
            continue
    return out


def environment() -> dict:
    """The notebooks' environment as a manifest's "environment" (ml_audit_kit builds its image and Dockerfile)."""
    return {"environment": {"python": sys.version.split()[0], "packages": libraries()}}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _idn(x: Optional[float], d: int = 3) -> str:
    return "—" if x is None else f"{x:,.{d}f}".replace(",", "#").replace(".", ",").replace("#", ".")


def _py(x: Any) -> str:
    """A Python literal of x (dicts, lists, str, numbers, None)."""
    return pprint.pformat(x, width=150, sort_dicts=False)


def _fill(text: str, **vals: Any) -> str:
    return re.sub(r"@@(\w+)@@", lambda m: str(vals[m.group(1)]), text)


def _md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n")}


def _code(text: str) -> dict:
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text.strip("\n")}


def _notebook(cells: list[dict], prefix: str) -> dict:
    for i, c in enumerate(cells):  # nbformat 4.5: every cell has an id
        c["id"] = f"{prefix}-{i:02d}"
    return {"nbformat": 4, "nbformat_minor": 5, "cells": cells,
            "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}}}


# ------------------------------------------------------------------------------------------------
# the claim-risk model: one notebook per technique
# ------------------------------------------------------------------------------------------------


def platform_numbers(report: Optional[dict], name: str) -> dict:
    """One technique's numbers in the model card, per task: its row (mean ± sd over repeats × folds, rank among the
    techniques, the corrected t-test against the best), the first repeat's folds and pooled out-of-fold metrics, and
    the first repeat's mean of every technique (what the notebook's own run compares with)."""
    out = {}
    for task, t in ((report or {}).get("tugas") or {}).items():
        row = next((b for b in t.get("papan") or [] if b["model"] == name), None)
        if not row:
            continue
        board = [b["model"] for b in t["papan"] if not b["pembanding"]]
        first = {m: [r for r in rows if r.get("ulangan") == 1] for m, rows in (t.get("lipatan_per_model") or {}).items()}
        out[task] = {"label": t.get("label"), "rank": board.index(name) + 1 if name in board else None, "of": len(board), "terbaik": t.get("terbaik"),
                     "rata": {k: [row["rata"][k]["mean"], row["rata"][k]["sd"]] for k in (*FOLD_KEYS, "lift_top_0_1pct") if k in row["rata"]},
                     "uji": row.get("uji_vs_terbaik"), "ulangan": t.get("ulangan"), "lipatan": t.get("lipatan"),
                     "folds": {str(r["lipatan"]): {k: round(r[k], 4) for k in FOLD_KEYS} for r in first.get(name, [])},
                     "gabungan": {k: round(row["gabungan_oof"][k], 4) for k in POOLED_KEYS if k in row["gabungan_oof"]},
                     "u1": {m: {k: round(sum(r[k] for r in rows) / len(rows), 4) for k in FOLD_KEYS} for m, rows in first.items() if rows}}
    return out


def production(report: Optional[dict], current: Optional[dict]) -> dict:
    """task → [segment, technique, model version] of the production model."""
    version = ((current or {}).get("model") or {}).get("version")
    return {s["tugas"]: [seg, s["model"], version] for seg, s in ((report or {}).get("segmen") or {}).items()}


def _card_table(nums: dict, name: str) -> str:
    if not nums:
        return "_Belum ada kartu model di platform (model ini belum pernah dilatih)._"
    rows = ["| Tugas | Peringkat | AUPRC (rata ± sd) | AUROC | Presisi 0,1% teratas | Dibanding teknik terbaik |", "|---|---|---|---|---|---|"]
    for task, n in nums.items():
        r = n["rata"]
        u = n.get("uji")
        if n["terbaik"] == name:
            vs = "**terbaik**"
        elif u and u.get("p") is not None:
            vs = (f"lebih rendah nyata dari {n['terbaik']} (p = {_idn(u['p'], 3)})" if u.get("berbeda_nyata")
                  else f"setara {n['terbaik']} (p = {_idn(u['p'], 2)} ≥ 0,05)")
        else:
            vs = "—"
        rows.append(f"| {n['label']} | {n['rank']} dari {n['of']} | {_idn(r['auprc'][0])} ± {_idn(r['auprc'][1])} | {_idn(r['auroc'][0])} | "
                    f"{_idn(r['presisi_top_0_1pct'][0])} ({_idn(r.get('lift_top_0_1pct', [0])[0], 0)}× acak) | {vs} |")
    reps = next(iter(nums.values()))
    return "\n".join(rows) + (f"\n\nRata-rata {reps['ulangan']} ulangan × {reps['lipatan']} lipatan, dikelompokkan per profil faskes; "
                              "uji = t-test resampel terkoreksi (Nadeau dan Bengio 2003) atas AUPRC berpasangan per lipatan.")


def _research(refs: list[dict]) -> str:
    if not refs:
        return ""
    lines = []
    for r in refs:
        title = f"[{r['judul']}]({r['url']})" if r.get("url") else r["judul"]
        lines.append(f"- {r['penulis']} ({r['tahun']}). {title}. *{r['venue']}*." + (f" {r['temuan']}" if r.get("temuan") else ""))
    return "**Rujukan riset teknik ini** (dipilih saat benchmark disusun):\n\n" + "\n".join(lines)


C_PARAM = r'''
TUGAS = @@TUGAS@@     # "rumah_sakit" (klaim rumah sakit, tugas sulit) atau "semua" (semua klaim FKRTL)
MODEL = @@MODEL@@     # teknik notebook ini (teknik lain: M.MODELS di sel 2)
LIPATAN = 5                # lipatan validasi silang, dikelompokkan per profil faskes (5 = sama dengan benchmark platform)
KAPASITAS = 0.001          # porsi klaim yang sanggup diaudit (asumsi 0,1%)
PORSI_NEGATIF_LATIH = @@PORSI@@  # porsi klaim tanpa koreksi untuk model akhir, per tugas (hasil ablasi platform)
'''

C_ENV = r'''
import sys, time, hashlib, pathlib, subprocess, tempfile, warnings
from importlib import metadata

PUSTAKA_PLATFORM = @@LIBS@@  # versi di lingkungan platform (Python @@PYTHON@@)

def versi(d):  # xgboost di image workspace adalah build CPU-nya (xgboost-cpu, versi sama)
    for nama in (d, f"{d}-cpu"):
        try:
            return metadata.version(nama)
        except metadata.PackageNotFoundError:
            pass
    return None

kurang = [f"{d}=={v}" for d, v in PUSTAKA_PLATFORM.items() if versi(d) is None]
if kurang:  # di luar workspace platform (mis. Jupyter lokal): pasang yang belum ada, pada versi platform
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *kurang], check=True)

import numpy as np, pandas as pd, duckdb
pd.set_option("display.max_columns", 60)
pk = pd.DataFrame([{"pustaka": d, "platform": v, "di sini": versi(d)} for d, v in PUSTAKA_PLATFORM.items()])
pk["sama"] = pk["platform"] == pk["di sini"]
print(f"Python {sys.version.split()[0]} (platform @@PYTHON@@) · {int(pk['sama'].sum())} / {len(pk)} pustaka pada versi yang sama dengan platform")
pk
'''

C_CODE = r'''
sys.path.insert(0, str(pathlib.Path("code/repo/api").resolve()))
import ml_klaim as M          # mesin ML platform: fitur, model, metrik

sha = hashlib.sha256(pathlib.Path("code/repo/api/ml_klaim.py").read_bytes()).hexdigest()
print("ml_klaim.py sha256", sha[:16], "· sama dengan kode platform saat notebook ini dibuat" if sha == "@@SHA@@" else "· BERBEDA dari kode platform saat notebook ini dibuat")
print(f"{MODEL}: {M.MODELS[MODEL][0]} · {M.MODELS[MODEL][1]} · seed {M.SEED}")
print(f"{len(M.MODELS)} teknik di benchmark:", ", ".join(M.MODELS))
'''

C_MAKE = r'''
# kode yang membuat model ini (M.make_model), dibaca dari ml_klaim.py di atas, lalu hiperparameternya
import inspect

src = inspect.getsource(M.make_model).splitlines()
awal = next(i for i, l in enumerate(src) if f'name == "{MODEL}"' in l)
akhir = next((i for i in range(awal + 1, len(src)) if src[i].lstrip().startswith(("if name ==", "raise "))), len(src))
print("\n".join(src[awal:akhir]))
est = M.make_model(MODEL)
est = est.steps[-1][1] if hasattr(est, "steps") else est
pd.Series({k: v for k, v in est.get_params().items() if v is not None and not callable(v)}, name="hiperparameter", dtype=object).to_frame()
'''

C_DATA = r'''
SUMBER = "data/kunjungan_fkrtl.parquet"
df_klaim = duckdb.sql(f"SELECT * FROM '{SUMBER}' USING SAMPLE 1000 ROWS (reservoir, 42)").df()
print(df_klaim.shape)
df_klaim.head()
'''

C_DATA2 = r'''
duckdb.sql(f"""SELECT jenis_fkrtl, count(*) AS klaim, sum(flag_selisih_verifikasi::INT)::BIGINT AS dikoreksi,
                      round(100.0 * sum(flag_selisih_verifikasi::INT) / count(*), 4) AS persen_dikoreksi
               FROM '{SUMBER}' GROUP BY 1 ORDER BY 2 DESC""").df()
'''

C_FEAT = r'''
kerja = pathlib.Path(tempfile.gettempdir()) / "ml" / "@@SLUG@@"   # tabel fitur sementara milik notebook ini
(kerja / "duckdb").mkdir(parents=True, exist_ok=True)
con = duckdb.connect()
con.execute("SET threads = 4"); con.execute("SET memory_limit = '5GB'"); con.execute(f"SET temp_directory = '{(kerja / 'duckdb').as_posix()}'")
con.execute(f"CREATE VIEW k AS SELECT * FROM read_parquet('{SUMBER}')")
con.execute("CREATE VIEW wilayah AS SELECT kabkota_kode, provinsi_kode, provinsi_nama FROM read_parquet('data/wilayah.parquet')")
t = time.time()
M.prepare(con, "k", spill=str(kerja))
fitur = con.sql("SELECT * FROM fitur USING SAMPLE 1000 ROWS (reservoir, 42)").df()
print(f"{time.time() - t:.0f} s | {len(M.FEATURES)} fitur dipakai model")
fitur.head()
'''

C_LABELS = r'''
# arti tiap fitur
pd.DataFrame({"fitur": M.FEATURES, "arti": [M.LABELS.get(c, c) for c in M.FEATURES]})
'''

C_EVAL = r'''
df = M.evaluation_set(con, TUGAS)
prev = (df.w * df.y).sum() / df.w.sum()
print(f"{len(df):,} klaim di set evaluasi · {int(df.y.sum())} dikoreksi · mewakili {df.w.sum():,.0f} klaim · prevalensi {prev:.4%}")
df.head()
'''

C_FOLDS = r'''
from sklearn.model_selection import GroupShuffleSplit, StratifiedGroupKFold

folds = []
for f, (tr, te) in enumerate(StratifiedGroupKFold(n_splits=LIPATAN, shuffle=True, random_state=M.SEED).split(df, df.y, df.faskes_profil_id)):
    part = df.iloc[tr]
    latih, val = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=f).split(part, part.y, part.faskes_profil_id))
    folds.append((tr[latih], tr[val], te))
pd.DataFrame([{"lipatan": i + 1, "klaim latih": len(a), "klaim validasi": len(v), "klaim uji": len(te), "dikoreksi di uji": int(df.y.iloc[te].sum()),
               "faskes uji": df.faskes_profil_id.iloc[te].nunique()} for i, (a, v, te) in enumerate(folds)])
'''

C_CV = r'''
PLATFORM = @@FOLDS@@  # MODEL, ulangan 1 benchmark platform, per tugas → lipatan → metrik

def validasi_silang(nama):
    rng = np.random.default_rng(M.SEED)
    skor_uji, baris = np.full(len(df), np.nan), []
    for i, (a, v, te) in enumerate(folds):
        t = time.time()
        latih = M._train_part(df.iloc[a], rng)
        enc = M.Encoder().fit(latih)
        _, (s_val, s_uji), _ = M.fit_predict(nama, latih, [df.iloc[v], df.iloc[te]], enc)
        ambang = M.threshold_max_f1(df.y.iloc[v].to_numpy(), s_val, df.w.iloc[v].to_numpy())
        m = M.metrics(df.y.iloc[te].to_numpy(), s_uji, df.w.iloc[te].to_numpy(), ambang)
        skor_uji[te] = pd.Series(s_uji).rank(pct=True).to_numpy()  # peringkat dalam lipatan, seperti platform
        baris.append({"lipatan": i + 1, **{k: round(m[k], 4) for k in ("auprc", "auroc", "presisi_top_0_1pct", "presisi", "recall")}, "detik": round(time.time() - t, 1)})
    return pd.DataFrame(baris), skor_uji

per_lipatan, oof = validasi_silang(MODEL)
ref = PLATFORM.get(TUGAS) if LIPATAN == 5 else None
if ref:
    for k in ("auprc", "auroc", "presisi_top_0_1pct"):
        per_lipatan[f"platform_{k}"] = per_lipatan.lipatan.map(lambda i: ref[str(i)][k])
    selisih = max((per_lipatan[k] - per_lipatan[f"platform_{k}"]).abs().max() for k in ("auprc", "auroc", "presisi_top_0_1pct"))
    print(f"Selisih terbesar dengan laporan platform: {selisih:.4f}" + (" — sama persis (4 desimal)" if selisih == 0 else
          " — berbeda: kartu dibuat dengan data atau kode lain (cek sel 2), atau teknik ini bergantung pada jumlah thread (catatan di akhir)"))

import matplotlib.pyplot as plt

x = np.arange(len(per_lipatan))
fig, ax = plt.subplots(figsize=(7, 3))
ax.bar(x - 0.2 if ref else x, per_lipatan.auprc, width=0.4, color="#3b82f6", label=f"{MODEL} (notebook ini)")
if ref:
    ax.bar(x + 0.2, per_lipatan.platform_auprc, width=0.4, color="#94a3b8", label="laporan platform")
ax.set_xticks(x, [f"lipatan {i}" for i in per_lipatan.lipatan])
ax.set_ylabel("AUPRC")
ax.set_title(f"{MODEL} · {TUGAS}: AUPRC tiap lipatan")
ax.legend()
plt.tight_layout(); plt.show()
per_lipatan
'''

C_POOLED = r'''
PLATFORM_GABUNGAN = @@POOLED@@  # MODEL, ulangan 1, per tugas
y, w, g = df.y.to_numpy(), df.w.to_numpy(), df.faskes_profil_id.to_numpy()
hasil = M.metrics(y, oof, w)
ik = M.bootstrap_ci(y, oof, w, g, n=100)
ref = PLATFORM_GABUNGAN.get(TUGAS) if LIPATAN == 5 else None
pd.DataFrame([{"metrik": k, "notebook": round(v, 4), "IK 95% (per faskes)": " – ".join(f"{x:.4f}" for x in ik[k]) if k in ik else "",
               "platform": (ref or {}).get(k, "")} for k, v in hasil.items()])
'''

C_CAPACITY = r'''
order = np.argsort(-oof)
cw = np.cumsum(w[order])
k = KAPASITAS * w.sum()
top = order[: int(np.searchsorted(cw, k)) + 1]
tertangkap = (w[top] * y[top]).sum()
presisi_k = tertangkap / w[top].sum()
print(f"k = {k:,.0f} klaim diaudit ({KAPASITAS:.1%}) → {tertangkap:,.0f} klaim dikoreksi tertangkap · presisi@k {presisi_k:.3f}")
print(f"pilihan acak → {prev * k:,.1f} tertangkap · lift {presisi_k / prev:,.0f}× · recall@k {tertangkap / (w * y).sum():.1%}")
print("Batas bawah: klaim yang tidak dikoreksi belum tentu benar.")

import matplotlib.pyplot as plt

diaudit = 100 * cw / w.sum()
tangkap = 100 * np.cumsum((w * y)[order]) / (w * y).sum()
acak = np.logspace(-2, 2, 50)
fig, ax = plt.subplots(figsize=(6.5, 4))
ax.plot(diaudit, tangkap, color="#3b82f6", label=MODEL)
ax.plot(acak, acak, color="#94a3b8", ls="--", label="pilihan acak")
ax.axvline(100 * KAPASITAS, color="#f59e0b", ls=":", label=f"kapasitas {KAPASITAS:.1%}")
ax.set_xscale("log")
ax.set_xlim(0.01, 100)
ax.set_xlabel("% klaim yang diaudit (skala log)")
ax.set_ylabel("% klaim dikoreksi yang tertangkap")
ax.set_title(f"{MODEL} · {TUGAS}: kurva tangkapan audit")
ax.legend()
plt.tight_layout(); plt.show()
'''

C_BOARD = r'''
PAPAN_ULANGAN_1 = @@BOARD@@  # rata-rata ulangan 1 tiap teknik di benchmark platform, per tugas
papan = pd.DataFrame.from_dict(PAPAN_ULANGAN_1.get(TUGAS, {}), orient="index", columns=["auprc", "auroc", "presisi_top_0_1pct"])
# aturan pembanding dihitung ulang di sini (instan); MODEL dari sel 6
for nama in ["Aturan (flag ganda / LOS ekstrem)"] + (["Aturan klinik utama rawat inap"] if TUGAS == "semua" else []):
    papan.loc[f"{nama} (notebook)"] = validasi_silang(nama)[0][["auprc", "auroc", "presisi_top_0_1pct"]].mean()
papan.loc[f"{MODEL} (notebook)"] = per_lipatan[["auprc", "auroc", "presisi_top_0_1pct"]].mean()
papan = papan.astype(float).sort_values("auprc", ascending=False).round(4)
papan["lift_0_1pct"] = (papan.presisi_top_0_1pct / prev).round(0)

import matplotlib.pyplot as plt

urut = papan.sort_values("auprc")
warna = ["#3b82f6" if i.startswith(MODEL) else "#cbd5e1" if i.startswith(("Aturan", "Isolation")) else "#64748b" for i in urut.index]
fig, ax = plt.subplots(figsize=(7, 0.35 * len(urut) + 1))
ax.barh(urut.index, urut.auprc, color=warna)
ax.set_xlabel("AUPRC (rata-rata ulangan 1)")
ax.set_title(f"Posisi {MODEL} di antara teknik lain · {TUGAS}")
plt.tight_layout(); plt.show()
papan
'''

C_IMPORTANCE = r'''
import matplotlib.pyplot as plt
from sklearn.metrics import average_precision_score
from sklearn.model_selection import GroupKFold

# dilatih pada 4/5 faskes, diuji pada faskes sisanya (pembagian yang sama dengan kartu model platform)
tr, te = next(GroupKFold(n_splits=5).split(df, df.y, df.faskes_profil_id))
latih = M._train_part(df.iloc[tr], np.random.default_rng(M.SEED))
enc = M.Encoder().fit(latih)
model_uji, _, _ = M.fit_predict(MODEL, latih, [], enc)
uji = df.iloc[te]
if MODEL not in ("Regresi logistik", "MLP"):
    penting = pd.DataFrame(M.global_importance(MODEL, model_uji, enc, uji))   # fungsi yang sama dengan platform
else:  # pipeline linear / MLP menerima tabel mentah: acak satu fitur di tabel mentah
    rng = np.random.default_rng(M.SEED)
    yu, wu = uji.y.to_numpy(), uji.w.to_numpy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        dasar = average_precision_score(yu, model_uji.predict_proba(uji[M.FEATURES])[:, 1], sample_weight=wu)
        baris = []
        for c in M.FEATURES:
            acak = uji[M.FEATURES].copy()
            acak[c] = rng.permutation(acak[c].to_numpy())
            baris.append({"fitur": c, "label": M.LABELS.get(c, c),
                          "penurunan_auprc": dasar - average_precision_score(yu, model_uji.predict_proba(acak)[:, 1], sample_weight=wu)})
    penting = pd.DataFrame(baris).sort_values("penurunan_auprc", ascending=False).head(15)
penting.set_index("label").penurunan_auprc[::-1].plot.barh(figsize=(7, 5), color="#3b82f6", title=f"{MODEL}: penurunan AUPRC bila fitur diacak")
plt.tight_layout(); plt.show()
penting
'''

C_FINAL = r'''
PRODUKSI = @@PRODUCTION@@  # tugas → [segmen, teknik, versi model] model produksi
seg = M.fit_final(con, TUGAS, MODEL, neg_share=PORSI_NEGATIF_LATIH[TUGAS])
print(f"model akhir {MODEL} · {TUGAS}: {seg['train_rows']:,} baris latih, {seg['train_positives']} positif, {seg['fit_seconds']} s")
segmen, teknik, versi_model = PRODUKSI.get(TUGAS) or (None, None, None)
berkas = pathlib.Path("data/model/model.pkl")
if teknik == MODEL and berkas.is_file():
    import pickle
    from scipy.stats import spearmanr

    prod = pickle.loads(berkas.read_bytes())["segments"][segmen]
    kurang = [c for c in prod["enc"].columns if c not in df.columns]
    if kurang:  # model produksi dilatih dengan daftar kolom lain: tambahkan kolomnya dari tabel fitur
        df = df.merge(con.execute(f"SELECT klaim_id, {', '.join(kurang)} FROM fitur WHERE klaim_id IN (SELECT klaim_id FROM df)").df(), on="klaim_id", how="left")
    print(f"kolom input: model produksi {len(prod['enc'].columns)}, notebook {len(seg['enc'].columns)}")
    r_prod, r_nb = M.predict(prod, df), M.predict(seg, df)
    beda = np.abs(r_prod - r_nb)
    print(f"model produksi v{versi_model}, segmen {segmen}: {prod['name']}, {prod['train_rows']:,} baris latih ({prod['train_positives']} positif), "
          f"porsi negatif {prod['neg_share']}")
    print(f"peluang {len(df):,} klaim set evaluasi, notebook vs produksi: selisih terbesar {beda.max():.2e}, rata-rata {beda.mean():.2e}, "
          f"korelasi peringkat {spearmanr(r_prod, r_nb)[0]:.6f}")
    print("→ model produksi dibuat ulang persis oleh notebook ini" if beda.max() < 1e-9 else
          "→ tidak identik bit demi bit: lihat catatan di akhir notebook")
elif teknik == MODEL:
    print("data/model/model.pkl tidak ada di sini: perbandingan dengan model produksi hanya di workspace platform")
else:
    print(f"Model produksi memakai {teknik} untuk tugas ini; model akhir {MODEL} di sini untuk dipelajari, tidak dipublikasikan." if teknik else
          "Belum ada model produksi.")
'''

C_TOP = r'''
df["risiko"] = M.predict(seg, df)
teratas = df.sort_values("risiko", ascending=False).head(15).copy()
teratas["alasan"] = [M.reason_text(r) for r in M.reasons(seg, teratas)]
teratas[["klaim_id", "faskes_profil_id", "inacbg_kode", "dx_primer_icd3", "biaya_tagih", "los", "y", "risiko", "alasan"]]
'''


def aip_notebook(name: str, report: Optional[dict], current: Optional[dict], code_sha: str) -> dict:
    import ml_klaim as M

    nums = platform_numbers(report, name)
    prod = production(report, current)
    used = [f"segmen **{seg}** ({TASK_NAMES.get(task, task)})" for task, (seg, tech, _) in prod.items() if tech == name]
    version = ((current or {}).get("model") or {}).get("version")
    task = next((t for t, (_, tech, _) in prod.items() if tech == name), "rumah_sakit")
    shares = {t: next((s["porsi_negatif_latih"] for s in ((report or {}).get("segmen") or {}).values() if s["tugas"] == t), None) for t in M.TASKS}
    for t in M.TASKS:  # a task no segment uses: the share its ablation chose, else the engine's default
        if shares[t] is None:
            abl = ((report or {}).get("tugas") or {}).get(t, {}).get("ablasi_undersampling") or []
            shares[t] = max(abl, key=lambda r: r["auprc"])["porsi_negatif_latih"] if abl else M.TRAIN_NEG
    family, ref = M.MODELS[name]
    status = (f"**Dipakai model produksi v{version}** untuk {' dan '.join(used)}." if used else
              f"Tidak dipakai model produksi v{version} (produksi memakai {', '.join(sorted({p[1] for p in prod.values()}))})." if prod else
              "Belum ada model produksi.")
    s = slug(name)
    lib = libraries()
    cells = [
        _md(f"""
# {name} — model risiko koreksi klaim FKRTL

**Teknik:** {family} · {ref} · {status}

Notebook ini melatih dan menguji **{name}** langkah demi langkah dengan kode mesin ML platform yang sama (`code/repo/api/ml_klaim.py`)
dan **data nyata** Data Sampel BPJS Kesehatan 2025 (`data/kunjungan_fkrtl.parquet`, tahap Data Bersih). Jalankan dari atas ke bawah
(menu Run → Run All Cells). Tiap langkah menyimpan hasilnya di variabel (`df_klaim`, `fitur`, `df`, `oof`, `papan`, `seg`, `teratas`…)
yang bisa diolah sendiri.

**Label** = klaim yang **dikoreksi verifikator BPJS** (`flag_selisih_verifikasi`: dibayar kurang dari tagihan). Ini *label nyata
parsial*: nyata, tetapi tidak lengkap, karena hanya koreksi yang tertangkap verifikator yang berlabel. Jadi positif ≠ fraud terbukti, dan
klaim tanpa koreksi belum tentu benar. Presisi yang terukur adalah **batas bawah**.

### Kartu model platform{f' (v{version})' if version else ''}

{_card_table(nums, name)}

Notebook ini mengulang **ulangan pertama** benchmark itu persis (pembagian lipatan, sampel latih, dan seed yang sama), jadi angka tiap
lipatan bisa dicocokkan dengan angka platform di sel 6. Lama jalan semua sel di workspace platform (4 CPU): ±{MINUTES.get(name, 5)} menit.{' Model akhirnya dibandingkan klaim demi klaim dengan model produksi di sel 11.' if used else ''}

{_research(M.RESEARCH.get(name) or [])}
"""),
        _md("## 0. Parameter\n\nUbah di sini untuk mencoba tugas lain, lalu jalankan ulang semua sel."),
        _code(_fill(C_PARAM, TUGAS=json.dumps(task), MODEL=json.dumps(name, ensure_ascii=False), PORSI=_py(shares))),
        _md("## 1. Lingkungan\n\nImage JupyterLab workspace ini dibangun dengan pustaka pada versi yang sama dengan lingkungan platform. Di luar workspace "
            "platform, sel ini memasang pustaka yang belum ada pada versi itu."),
        _code(_fill(C_ENV, LIBS=_py(lib), PYTHON=sys.version.split()[0])),
        _md("## 2. Kode mesin ML platform\n\n`ml_klaim.py` adalah file yang sama yang dipakai job training platform. Hash sha256-nya dicocokkan dengan "
            "kode platform saat notebook ini dibuat; di bawahnya potongan kode yang membuat model ini dan hiperparameternya."),
        _code(_fill(C_CODE, SHA=code_sha)),
        _code(C_MAKE),
        _md("## 3. Data: klaim FKRTL (Data Bersih)\n\nSatu baris per klaim per edisi, jutaan baris (data sintetis). `df_klaim` hanya contoh acak 1.000 baris supaya "
            "ringan; hitungan penuh dilakukan lewat DuckDB langsung pada file Parquet."),
        _code(C_DATA),
        _code(C_DATA2),
        _md("## 4. Tabel fitur\n\n`M.prepare` membuat fitur tiap klaim (biaya, tarif, LOS, indeks terhadap kode INA-CBG, kunjungan berulang, dan lain-lain) "
            "serta fitur tiap profil faskes, persis seperti job training platform. Butuh 1–3 menit."),
        _code(_fill(C_FEAT, SLUG=s)),
        _code(C_LABELS),
        _md("## 5. Set evaluasi dan lipatan\n\nSemua klaim yang dikoreksi + 1 dari 10 klaim lain (dipilih tetap lewat hash id klaim), dengan bobot `w` = 10 "
            "untuk klaim tanpa koreksi, sehingga metrik berlaku untuk seluruh populasi klaim.\n\nKlaim dari satu faskes mirip, jadi satu faskes tidak "
            "boleh ada di data latih dan data uji sekaligus. Tiap lipatan juga menyisihkan 20% faskes data latihnya sebagai data validasi (untuk "
            "memilih ambang), persis seperti benchmark platform."),
        _code(C_EVAL),
        _code(C_FOLDS),
        _md(f"## 6. Latih dan uji per lipatan\n\nTiap lipatan: {name} dilatih pada semua positif + 30% klaim tanpa koreksi, lalu menilai klaim faskes yang "
            "tidak pernah dilihatnya. Kolom `platform_*` adalah angka lipatan yang sama di laporan benchmark platform."),
        _code(_fill(C_CV, FOLDS=_py({t: n["folds"] for t, n in nums.items()}))),
        _md("## 7. Hasil gabungan out-of-fold, dengan interval kepercayaan per faskes\n\nSkor uji semua lipatan digabung (sebagai peringkat dalam "
            "lipatan), lalu interval 95% dihitung dengan mengambil ulang **faskes utuh**, bukan klaim per klaim."),
        _code(_fill(C_POOLED, POOLED=_py({t: n["gabungan"] for t, n in nums.items()}))),
        _md("## 8. Presisi pada kapasitas audit\n\nk = kapasitas × jumlah klaim yang diwakili. Berapa klaim dikoreksi yang tertangkap bila tim audit "
            "memeriksa k klaim berskor tertinggi, dibanding memilih acak?"),
        _code(C_CAPACITY),
        _md(f"## 9. Posisi di antara teknik lain\n\nRata-rata ulangan 1 tiap teknik di benchmark platform (lipatan yang sama dengan sel 6), ditambah "
            f"{name} hasil notebook ini dan aturan pembanding yang dihitung ulang di sini. Notebook teknik lain ada di workspace yang sama "
            "(`model_<teknik>.ipynb`)."),
        _code(_fill(C_BOARD, BOARD=_py({t: n["u1"] for t, n in nums.items()}))),
        _md("## 10. Fitur terpenting\n\nPermutation importance: seberapa turun AUPRC pada faskes yang tidak dilihat model bila satu fitur diacak. "
            "Berlaku sama untuk semua teknik, sehingga bisa dibandingkan antar-notebook."),
        _code(C_IMPORTANCE),
        _md("## 11. Model akhir" + (" dan model produksi" if used else "") + "\n\nModel akhir dilatih pada seluruh set evaluasi (porsi negatif dari ablasi), "
            "lalu peluangnya dikembalikan ke skala populasi — persis `fit_final` job training platform."
            + (" Untuk teknik dan tugas yang dipakai produksi, peluang tiap klaim dibandingkan dengan model yang dipublikasikan (`data/model/model.pkl`)."
               if used else "")),
        _code(_fill(C_FINAL, PRODUCTION=_py(prod))),
        _md("## 12. Klaim berisiko tertinggi dan alasannya\n\nModel akhir menilai set evaluasi. Berikut 15 klaim teratas dengan peluang dikoreksi "
            "(skala populasi) dan tiga alasan utamanya (TreeSHAP untuk model pohon, suku EBM untuk EBM, oklusi untuk regresi logistik dan MLP). "
            "Klaim ini ikut dipakai melatih model akhir, jadi ini contoh penjelasan, bukan uji."),
        _code(C_TOP),
        _md(f"""
## Catatan

- Positif = **dikoreksi verifikator**, bukan fraud terbukti; tanpa koreksi ≠ terbukti benar. Angka presisi adalah batas bawah.
- Kartu model platform merata-ratakan semua ulangan × lipatan; notebook ini menjalankan ulangan pertama saja, jadi rata-ratanya bisa
  sedikit berbeda dari kartu, tetapi tiap lipatan sebanding langsung dengan kolom `platform_*` di sel 6.
{THREADS_NOTE.get(name, "")}- `data/kunjungan_fkrtl.parquet` adalah salinan Data Bersih di platform (data sampel BPJS yang dianonimkan). Jangan dibawa keluar.
"""),
    ]
    return _notebook(cells, f"model-{s}"[:40])


def aip_catalog(report: Optional[dict], current: Optional[dict]) -> list[dict]:
    """The notebooks of the claim-risk model's techniques, the production ones first, then by rank on hospital claims."""
    import ml_klaim as M

    prod = production(report, current)
    out = []
    for name in M.MODELS:
        nums = platform_numbers(report, name)
        out.append({"id": f"aip-{slug(name)}", "file": f"model_{slug(name)}.ipynb", "source": "aip", "title": name, "family": M.MODELS[name][0],
                    "model_id": ((current or {}).get("model") or {}).get("model_id"),
                    "reference": M.MODELS[name][1], "production": [{"segment": seg, "task": t, "version": v} for t, (seg, tech, v) in prod.items() if tech == name],
                    "tasks": {t: {"label": n["label"], "rank": n["rank"], "of": n["of"], "auprc": n["rata"]["auprc"][0], "auroc": n["rata"]["auroc"][0],
                                  "presisi_top_0_1pct": n["rata"]["presisi_top_0_1pct"][0], "best": n["terbaik"] == name,
                                  "p": (n.get("uji") or {}).get("p"), "berbeda_nyata": (n.get("uji") or {}).get("berbeda_nyata")} for t, n in nums.items()}})
    out.sort(key=lambda x: (not x["production"], (x["tasks"].get("rumah_sakit") or {}).get("rank") or 99))
    return out


# ------------------------------------------------------------------------------------------------
# Model Studio models: one notebook each
# ------------------------------------------------------------------------------------------------

S_PARAM = r'''
KONFIGURASI = @@CONFIG@@  # konfigurasi v@@VERSION@@ studio ini
PELATIH = "@@TRAINER@@"
'''

S_CODE = r'''
import sys, ast, hashlib, pathlib, subprocess
from importlib import metadata
from typing import Optional

PUSTAKA_PLATFORM = @@LIBS@@

def versi(d):  # xgboost di image workspace adalah build CPU-nya (xgboost-cpu, versi sama)
    for nama in (d, f"{d}-cpu"):
        try:
            return metadata.version(nama)
        except metadata.PackageNotFoundError:
            pass
    return None

kurang = [f"{d}=={v}" for d, v in PUSTAKA_PLATFORM.items() if versi(d) is None]
if kurang:  # di luar workspace platform: pasang yang belum ada, pada versi platform
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *kurang], check=True)

import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path("code/repo/api").resolve()))
import bluesandai_model_studio as ms   # pelatih Model Studio platform

for f, sha in @@SHAS@@.items():
    now = hashlib.sha256(pathlib.Path("code/repo/api", f).read_bytes()).hexdigest()
    print(f, now[:16], "· sama dengan kode platform saat notebook ini dibuat" if now == sha else "· BERBEDA dari kode platform saat notebook ini dibuat")
'''

S_DATA = r'''
latih = pd.read_parquet("@@TRAIN@@")
uji = @@TEST@@
print(f"data latih: {len(latih):,} baris × {latih.shape[1]} kolom" + (f" · data uji: {len(uji):,} baris" if uji is not None else ""))
latih.head()
'''

S_FILTER = r'''
# filter baris konfigurasi, dengan fungsi platform (_apply_filters di model_studio.py, dibaca tanpa mengimpor server platform)
src = pathlib.Path("code/repo/api/model_studio.py").read_text("utf-8")
fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == "_apply_filters")
ns = {"Optional": Optional}
exec(ast.get_source_segment(src, fn), ns)
sebelum = len(latih)
latih = ns["_apply_filters"](latih, KONFIGURASI["filters"])
if uji is not None:
    uji = ns["_apply_filters"](uji, KONFIGURASI["filters"])
print(f"{sebelum:,} → {len(latih):,} baris latih setelah filter:", "; ".join(f"{f['column']} {f['op']} {f.get('value', '')}" for f in KONFIGURASI["filters"]))
'''

S_TRAIN_TAB = r'''
log = []
model, config, laporan = ms.train_tabular(PELATIH, latih, KONFIGURASI["target"], KONFIGURASI["features"], dict(KONFIGURASI.get("params") or {}), uji, log.append)
print("\n".join(log))
print(f"terbaik: {laporan['best']} · {config['eval_metric']} {laporan['score']:.6f} · {laporan['validation_rows']} baris validasi")
papan = pd.DataFrame(laporan["leaderboard"])

import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(6.5, 0.4 * len(papan) + 1))
ax.barh(papan["model"][::-1], papan["score_val"][::-1].abs(), color=["#3b82f6" if m == laporan["best"] else "#94a3b8" for m in papan["model"][::-1]])
ax.set_xlabel(f"{papan['eval_metric'].iloc[0]} (nilai mutlak)")
ax.set_title("Kandidat model (biru: terbaik)")
plt.tight_layout(); plt.show()
papan
'''

S_TRAIN_TS = r'''
log = []
model, config, laporan = ms.train_time_series(latih, KONFIGURASI["target"], KONFIGURASI["timestamp"], KONFIGURASI.get("item_id"), dict(KONFIGURASI.get("params") or {}), log.append)
print("\n".join(log))
print(f"terbaik: {laporan['best']} · MAE backtest {-laporan['score']:.6f} · frekuensi {config['frequency']}")
papan = pd.DataFrame(laporan["leaderboard"])

import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(6.5, 0.4 * len(papan) + 1))
ax.barh(papan["model"][::-1], papan["score_val"][::-1].abs(), color=["#3b82f6" if m == laporan["best"] else "#94a3b8" for m in papan["model"][::-1]])
ax.set_xlabel(f"{papan['eval_metric'].iloc[0]} (nilai mutlak)")
ax.set_title("Kandidat model (biru: terbaik)")
plt.tight_layout(); plt.show()
papan
'''

S_COMPARE = r'''
PLATFORM = @@RUN@@  # run terakhir yang berhasil di platform
if PLATFORM:
    metrik, nilai = next(iter(PLATFORM["metrics"].items()))
    skor = laporan["score"]
    print(f"platform ({PLATFORM['run']}, {PLATFORM['started_at']}): terbaik {PLATFORM['best']}, {metrik} {nilai}")
    print(f"notebook: terbaik {laporan['best']}, {metrik} {round(skor, 6)}")
    print("→ sama" if laporan["best"] == PLATFORM["best"] and abs(round(skor, 6) - nilai) < 1e-6 else
          "→ berbeda: data atau konfigurasi berubah sejak run itu (lihat data_updated_at di Model Studio), atau run itu memakai konfigurasi lain")
else:
    print("Belum ada run yang berhasil di platform untuk dibandingkan.")
'''

S_EVAL_CLS = r'''
val = laporan["validation"]
kelas = config["classes"]
prediksi = np.asarray(val["out"]).argmax(axis=1)
matriks = pd.crosstab(pd.Series([kelas[i] for i in val["y"]], name="sebenarnya"), pd.Series([kelas[i] for i in prediksi], name="prediksi"))
print(f"{laporan['best']} pada {len(prediksi)} baris validasi · akurasi {np.mean(prediksi == val['y']):.4f}")
matriks
'''

S_EVAL_REG = r'''
import matplotlib.pyplot as plt

val = laporan["validation"]
plt.figure(figsize=(5, 5))
plt.scatter(val["y"], val["out"], s=10, alpha=0.6, color="#3b82f6")
lo, hi = float(np.nanmin(val["y"])), float(np.nanmax(val["y"]))
plt.plot([lo, hi], [lo, hi], color="#888", lw=1)
plt.xlabel("sebenarnya"); plt.ylabel(f"prediksi {laporan['best']}"); plt.title("Data validasi")
plt.tight_layout(); plt.show()
'''

S_EVAL_TS = r'''
import matplotlib.pyplot as plt

ramalan = ms.forecast_frame(model, latih, config)
print(f"ramalan {config['prediction_length']} titik ke depan, metode {config['method']}")

ts_col, item, kolom = config["timestamp"], config.get("item_id"), config["prediction_column"]
fig, ax = plt.subplots(figsize=(8, 3.5))
for key, g in (list(latih.groupby(item)) if item else [("semua", latih)])[:3]:
    g = g.sort_values(ts_col).tail(60)
    garis, = ax.plot(pd.to_datetime(g[ts_col]), g[config["target"]], label=f"{key} · riwayat")
    f = ramalan[ramalan[item] == key] if item else ramalan
    ax.plot(pd.to_datetime(f[ts_col]), f[kolom], ls="--", color=garis.get_color(), label=f"{key} · ramalan")
ax.set_title(f"Ramalan {config['method']} ({config['prediction_length']} titik)")
ax.legend(fontsize=7)
plt.tight_layout(); plt.show()
ramalan.head(20)
'''

S_PREDICT = r'''
# inferensi model, persis seperti deployment platform (ms.predict_frame)
ms.predict_frame(model, config, (uji if uji is not None else latih).head(10))
'''


def studio_notebook(st: dict, cfg: dict, run: Optional[dict], data: dict[str, str], shas: dict[str, str], trainer_label: str) -> dict:
    """A Model Studio model's notebook: cfg the configuration its latest successful run trained (else the latest), data
    {"train": path, "test": path?} relative to the notebook."""
    trainer = st["trainer"]
    ts = trainer == "time_series"
    keep = {k: cfg[k] for k in ("name", "target", "features", "timestamp", "item_id", "filters", "params") if cfg.get(k) not in (None, [], {})}
    keep.setdefault("features", cfg.get("features") or [])
    keep.setdefault("filters", [])
    ref = run and {"run": run["id"], "started_at": run.get("started_at"), "best": run.get("best_model"), "metrics": run.get("metrics") or {},
                   "config_version": run.get("config_version")}
    newer = max((c.get("version") or 0 for c in st.get("configs") or []), default=0)
    s = slug(st["name"])
    cells = [
        _md(f"""
# {st['name']} — Model Studio

**Pelatih:** {trainer_label} · **target:** `{cfg.get('target')}` · **konfigurasi:** v{cfg.get('version')} ({cfg.get('name') or '—'})
{f"· **fitur:** {', '.join(f'`{f}`' for f in cfg.get('features') or [])}" if cfg.get('features') else ''}

Notebook ini melatih ulang model Model Studio ini dengan **pelatih yang sama** dengan platform (`code/repo/api/bluesandai_model_studio.py`),
pada dataset yang sama (`{data['train']}`), lalu membandingkan papan peringkat kandidat model dengan run terakhir yang berhasil di platform.
{f"Run pembanding: `{ref['run']}` ({ref['started_at']}), terbaik **{ref['best']}**, {', '.join(f'{k} {v}' for k, v in ref['metrics'].items())}." if ref else
 "Belum ada run yang berhasil di platform."}
{f"Ada konfigurasi yang lebih baru (v{newer}) yang belum dilatih; notebook ini memakai konfigurasi run terakhir." if ref and newer > (cfg.get('version') or 0) else ''}
"""),
        _md("## 0. Konfigurasi\n\nKonfigurasi yang dipakai run platform. Ubah di sini untuk mencoba variasi, lalu jalankan ulang semua sel."),
        _code(_fill(S_PARAM, CONFIG=_py(keep), VERSION=cfg.get("version"), TRAINER=trainer)),
        _md("## 1. Pustaka dan kode pelatih platform"),
        _code(_fill(S_CODE, LIBS=_py({k: v for k, v in libraries().items() if k in ("numpy", "pandas", "pyarrow", "scikit-learn", "scipy", "xgboost", "matplotlib")}),
                    SHAS=_py(shas))),
        _md("## 2. Data"),
        _code(_fill(S_DATA, TRAIN=data["train"], TEST=f'pd.read_parquet("{data["test"]}")' if data.get("test") else "None")),
    ]
    if keep["filters"]:
        cells += [_md("## 3. Filter baris"), _code(S_FILTER)]
    cells += [
        _md("## 4. Training: semua kandidat model\n\n" + ("Tiap metode peramalan diuji mundur (backtest) pada titik-titik terakhir tiap deret." if ts else
            "Tiap kandidat dilatih pada data latih dan dinilai pada data validasi (20% baris, seed 0) atau dataset uji; yang terbaik dilatih ulang "
            "pada semua data.")),
        _code(S_TRAIN_TS if ts else S_TRAIN_TAB),
        _md("## 5. Dibanding run platform"),
        _code(_fill(S_COMPARE, RUN=_py(ref))),
        _md("## 6. " + ("Ramalan" if ts else "Evaluasi pada data validasi")),
        _code(S_EVAL_TS if ts else S_EVAL_CLS if trainer == "classification" else S_EVAL_REG),
    ]
    if not ts:
        cells += [_md("## 7. Inferensi"), _code(S_PREDICT)]
    return _notebook(cells, f"studio-{s}"[:40])


# ------------------------------------------------------------------------------------------------
# the kit around the notebooks
# ------------------------------------------------------------------------------------------------


def code_files(studio: bool) -> dict[str, bytes]:
    return {f"code/repo/api/{f}": (HERE / f).read_bytes() for f in AIP_CODE + (STUDIO_CODE if studio else [])}


def code_shas() -> dict[str, str]:
    return {f: _sha(HERE / f) for f in AIP_CODE + STUDIO_CODE}


def support_files(catalog: list[dict], studio: bool) -> dict[str, bytes]:
    env = environment()
    reqs = kit.requirements(env) + kit.JUPYTER
    lines = "\n".join(f"| `{c['file']}` | {c['title']} | {c['note']} |" for c in catalog)
    readme = f"""# Notebook tiap model — ML Studio BluesandAI

Satu notebook Jupyter per model: tiap teknik model risiko koreksi klaim FKRTL (benchmark 9 teknik) dan tiap model Model Studio.
Setiap notebook melatih modelnya dengan kode platform yang sama (`code/repo/api/`) dan mencocokkan hasilnya dengan angka platform.

| Notebook | Model | Keterangan |
|---|---|---|
{lines}

## Menjalankan

- Di platform: ML Studio → Notebook → **Buka di JupyterLab** (data sudah tersalin ke `data/`, image berisi pustaka pada versi platform).
- Di mesin sendiri: `docker compose up --build`, buka http://localhost:8888. Data tidak ikut dalam paket ini (data sampel BPJS):
  letakkan `kunjungan_fkrtl.parquet` (Data Bersih) dan `wilayah.parquet` (Siap Analisis) di `data/`, dan dataset tiap studio di `data/studio/`.
- Tanpa Docker: `pip install -r requirements.txt && jupyter lab`.

Model risiko klaim butuh ±5 GB RAM; di 4 CPU tiap notebook teknik 2–6 menit, kecuali MLP ±35 menit (tabel fitur semua klaim + 5 lipatan).
"""
    return {"requirements.txt": ("\n".join(reqs) + "\n").encode(), "Dockerfile": kit.dockerfile(env).encode(), "docker-compose.yml": kit.COMPOSE.encode(),
            "README.md": readme.encode(), **code_files(studio)}


def dumps(nb: dict) -> bytes:
    return json.dumps(nb, ensure_ascii=False, indent=1).encode("utf-8")
