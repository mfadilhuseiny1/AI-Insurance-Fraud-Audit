"""Demo Grid: NTL detection models, wired through the platform (called by demo_grid_e2e.build).

What the literature benchmark (docs/BENCHMARK_GRID_TL_NTL.md) asked for, end to end:

- Code Repository "Deteksi Susut NTL Grid demo" (Model Training layout):
  1. `fitur.py` — the customer features of the loss pipeline (susut/fitur_pelanggan) with the P2TL labels
     (susut/p2tl_bersih: the last inspection per customer, found / not found, random sample or not) and a value proxy
     per customer (the kWh the evidence says is missing, at the customer's tariff) → ml/fitur_ntl_pelanggan.
  2. `model_training.py` — an unsupervised Isolation Forest (no labels; Glauner et al. 2016 / De Meulemeester et al.
     2025 as in the JKN demo) and a supervised gradient-boosting classifier on the inspected customers (Buzau et al.
     2019, Punmiya & Choe 2019), combined; an experiment logs AUROC on the inspection labels, and — against the demo's
     answer key (ml/kunci_evaluasi_demo, the planted patterns, used only to evaluate) — precision at the P2TL team's
     weekly capacity and rupiah recovered per inspection for four rankings: rules, unsupervised, supervised, and
     value-weighted (probability × value, Massaferro et al. 2020): the value ranking is what lifts the few large
     industrial and institutional cases to the top.
  3. `ml_models/ntl_model.py` — the deployed model (an MLflow PythonModel): per customer the anomaly score, the finding probability, the combined NTL
     score, the expected value and the features behind it.
- A live deployment with a row-wise model function `skorNtlPelangganGridDemo`, called by "Pipeline skor NTL pelanggan
  grid (demo)" in a Python-function step; its SQL ranks customers, flags new patterns (high model score, no rule hit)
  and sums per distribution transformer.
- The scores back extra properties of Pelanggan Grid and Gardu Distribusi Grid (additional datasources).

Synthetic data only. Seeded and idempotent.
"""

from __future__ import annotations

from typing import Any

REPO = "Deteksi Susut NTL Grid demo"
MODEL_PATH = "ml/model_ntl_pelanggan (demo)"
FUNCTION_API = "skorNtlPelangganGridDemo"
SCORING_PIPELINE = "Pipeline skor NTL pelanggan grid (demo)"

FEATURES = ["perubahan_pct", "rasio_vs_peer", "kwh_per_kva_bulan", "rasio_puncak_vs_daya", "bulan_estimasi", "bulan_stand_sama", "hari_nol",
            "porsi_malam", "faktor_beban", "event_tamper", "event_fasa", "porsi_wbp", "rasio_arus_fasa_min", "rasio_tegangan_fasa_min",
            "hari_melebihi_kontrak", "rasio_tagih_vs_amr", "ntl_gardu_pct", "porsi_turun_rute_baca", "is_tm", "is_ami", "is_prabayar", "is_lembaga"]
LABELS = {"perubahan_pct": "perubahan pemakaian Q2→Q3 (%)", "rasio_vs_peer": "pemakaian vs tetangga segolongan", "kwh_per_kva_bulan": "kWh per kVA per bulan",
          "rasio_puncak_vs_daya": "puncak vs daya tersambung", "bulan_estimasi": "bulan ditagih estimasi", "bulan_stand_sama": "bulan stand meter sama",
          "hari_nol": "hari AMI nol", "porsi_malam": "porsi pemakaian malam", "faktor_beban": "faktor beban", "event_tamper": "event magnet/tutup terminal",
          "event_fasa": "event fasa/arus", "porsi_wbp": "porsi WBP (TM)", "rasio_arus_fasa_min": "arus fasa terkecil / terbesar",
          "rasio_tegangan_fasa_min": "tegangan fasa terkecil / terbesar", "hari_melebihi_kontrak": "hari demand > kontrak",
          "rasio_tagih_vs_amr": "kWh ditagih / kWh AMR", "ntl_gardu_pct": "NTL gardu (%)", "porsi_turun_rute_baca": "porsi turun di rute baca",
          "is_tm": "pelanggan TM", "is_ami": "ber-AMI", "is_prabayar": "prabayar", "is_lembaga": "lembaga (P/S)"}

LIB = r'''"""NTL detection for the grid demo: features, an unsupervised + supervised ensemble, value-weighted ranking."""

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, IsolationForest

FEATURES = {features}
LABELS = {labels}
# neutral values for missing features (no AMI, no TM data, no peers)
NEUTRAL = {{"perubahan_pct": 0.0, "rasio_vs_peer": 1.0, "kwh_per_kva_bulan": 80.0, "rasio_puncak_vs_daya": 0.6, "bulan_estimasi": 0.0,
           "bulan_stand_sama": 0.0, "hari_nol": 0.0, "porsi_malam": 0.3, "faktor_beban": 0.45, "event_tamper": 0.0, "event_fasa": 0.0,
           "porsi_wbp": 0.2, "rasio_arus_fasa_min": 0.95, "rasio_tegangan_fasa_min": 0.99, "hari_melebihi_kontrak": 0.0, "rasio_tagih_vs_amr": 1.0,
           "ntl_gardu_pct": 0.0, "porsi_turun_rute_baca": 0.0}}


def matrix(df):
    X = pd.DataFrame(index=df.index)
    for f in FEATURES:
        if f.startswith("is_"):
            X[f] = df[f].astype(float).fillna(0.0)
        else:
            X[f] = pd.to_numeric(df[f], errors="coerce").fillna(NEUTRAL.get(f, 0.0)).astype(float)
    X["perubahan_pct"] = X["perubahan_pct"].clip(-100, 300)
    X["kwh_per_kva_bulan"] = X["kwh_per_kva_bulan"].clip(0, 1500)
    return X


def auroc(score, y):
    score, y = np.asarray(score, float), np.asarray(y, int)
    pos, neg = score[y == 1], score[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(len(order))
    ranks[order] = np.arange(1, len(order) + 1)
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


class NtlModel:
    """Isolation Forest (unsupervised) + gradient boosting on P2TL labels; combined score and explanations."""

    def fit(self, X, y, inspected, seed=26):
        self.cols = list(X.columns)
        self.mu = X.mean().to_numpy()
        self.sd = X.std().replace(0, 1).to_numpy()
        self.iforest = IsolationForest(n_estimators=300, contamination=0.05, random_state=seed).fit(X.to_numpy())
        raw = -self.iforest.score_samples(X.to_numpy())
        self.ref = np.sort(raw)
        m = np.asarray(inspected, bool)
        yy = np.asarray(y, int)[m]
        w = np.where(yy == 1, (len(yy) - yy.sum()) / max(1, yy.sum()), 1.0)
        self.gbm = GradientBoostingClassifier(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.9, random_state=seed)
        self.gbm.fit(X.to_numpy()[m], yy, sample_weight=w)
        self.importance = dict(zip(self.cols, self.gbm.feature_importances_))
        return self

    def score(self, X):
        A = X[self.cols].to_numpy(float)
        raw = -self.iforest.score_samples(A)
        anomaly = np.searchsorted(self.ref, raw, side="right") / len(self.ref)
        prob = self.gbm.predict_proba(A)[:, 1]
        combined = 0.5 * prob + 0.5 * anomaly
        z = (A - self.mu) / self.sd
        imp = np.array([self.importance.get(c, 0.0) for c in self.cols]) + 0.02
        contrib = np.abs(z) * imp
        reasons = []
        for i in range(len(A)):
            top = np.argsort(-contrib[i])[:3]
            reasons.append("; ".join(f"{{LABELS.get(self.cols[j], self.cols[j])}} = {{A[i, j]:.2f}}" for j in top if contrib[i, j] > 0.05))
        return {{"anomaly": anomaly, "prob": prob, "combined": combined, "reasons": reasons}}


def precision_at(rank_score, truth, k):
    order = np.argsort(-np.asarray(rank_score, float))[:k]
    return float(np.asarray(truth, int)[order].mean())


def rupiah_at(rank_score, value, k):
    order = np.argsort(-np.asarray(rank_score, float))[:k]
    return float(np.asarray(value, float)[order].sum() / k)
'''

FITUR = '''import pandas as pd
from transforms.api import transform, Input, Output


@transform.using(
    fitur=Input("{base}/susut/fitur_pelanggan"),
    label=Input("{base}/ml/label_p2tl_gabungan"),
    out=Output("{base}/ml/fitur_ntl_pelanggan"),
)
def fitur_ntl(fitur, label, out):
    """Customer features (loss pipeline) + the training label of the P2TL feedback loop (Pipeline label P2TL gabungan:
    each customer's last inspection, violation proven = 1, inspected clean = 0, random sample or chosen) + a value
    proxy: the kWh the evidence says is missing per month at the customer's tariff. A new inspection result relabels
    the customer, rebuilds this dataset and retrains the model."""
    f = fitur.pandas()
    lab = label.pandas().set_index("id_pelanggan")
    f["diinspeksi"] = f["id_pelanggan"].isin(lab.index).astype(int)
    f["label_p2tl"] = f["id_pelanggan"].map(lab["label_p2tl"]).fillna(0).astype(int)
    f["sampel_acak"] = f["id_pelanggan"].map(lab["basis_terakhir"].astype(str).str.contains("acak")).fillna(False).astype(int)
    f["is_tm"] = (f["tegangan"] == "TM").astype(int)
    f["is_ami"] = (f["ami"] == "Ya").astype(int)
    f["is_prabayar"] = (f["jenis_meter"] == "prabayar").astype(int)
    f["is_lembaga"] = f["segmen"].isin(["Pemerintah", "Sosial"]).astype(int)
    q2, q3 = f["kwh_bulan_q2"].fillna(0), f["kwh_bulan_q3"].fillna(0)
    peer = (q3 / f["rasio_vs_peer"].where(f["rasio_vs_peer"] > 0)).fillna(q3)
    amr = (q3 / f["rasio_tagih_vs_amr"].where(f["rasio_tagih_vs_amr"] > 0)).fillna(q3)
    tm_phase = q3 * ((f["rasio_arus_fasa_min"].fillna(1) < 0.4) | (f["rasio_tegangan_fasa_min"].fillna(1) < 0.5)).astype(float) * 0.5
    gap = pd.concat([(q2 - q3).clip(lower=0), (peer - q3).clip(lower=0) * 0.7, (amr - q3).clip(lower=0), tm_phase], axis=1).max(axis=1)
    f["potensi_kwh_bulan"] = gap.round(1)
    f["potensi_rp_bulan"] = (gap * f["tarif_rp_kwh"].fillna(1444.7)).round(0)
    out.write_pandas(f)
'''

TRAINING = '''import mlflow
import numpy as np
import pandas as pd
from transforms.api import transform, Input, ModelOutput

from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_predict

from ml_models.ntl import FEATURES, NtlModel, auroc, matrix, precision_at, rupiah_at
from ml_models.evaluasi import log_klasifikasi
from ml_models.ntl_model import INPUT_COLUMNS, NtlPelangganModel


@transform.using(
    fitur=Input("{base}/ml/fitur_ntl_pelanggan"),
    kunci=Input("{base}/ml/kunci_evaluasi_demo"),
    aturan=Input("{base}/susut/skrining_aturan_pelanggan"),
    model_output=ModelOutput("{base}/{model}"),
)
def train_model(fitur, kunci, aturan, model_output):
    """Isolation Forest (no labels) + gradient boosting on the P2TL labels of inspected customers, combined. The
    experiment compares four rankings against the demo's answer key (never used in training): rules, unsupervised,
    supervised, and value-weighted (probability x value) — precision and rupiah per inspection at the team's capacity."""
    df = fitur.pandas().reset_index(drop=True)
    X = matrix(df)
    y = df["label_p2tl"].to_numpy()
    inspected = df["diinspeksi"].to_numpy().astype(bool)
    # an MLflow run: its parameters, metrics and tables become the experiment of the model version
    mlflow.start_run(run_name="ntl-pelanggan-grid")
    mlflow.log_params({{"pelanggan": len(df), "fitur": len(FEATURES), "diinspeksi": int(inspected.sum()), "temuan_p2tl": int(y.sum()),
                    "sampel_acak": int(df["sampel_acak"].sum()), "unsupervised": "Isolation Forest (300 pohon)",
                    "supervised": "Gradient boosting (250, kedalaman 3, bobot kelas)", "gabungan": "0,5 probabilitas + 0,5 persentil anomali"}})
    model = NtlModel().fit(X, y, inspected)
    sc = model.score(X)
    key = kunci.pandas().set_index("id_pelanggan")
    truth = df["id_pelanggan"].map(key["pelanggaran_aktif"]).fillna(0).astype(int).to_numpy()
    value = df["id_pelanggan"].map(key["nilai_hilang_rp_bulan"]).fillna(0.0).to_numpy()
    rules = aturan.pandas().groupby("id_pelanggan")["skor"].max()
    rule_score = df["id_pelanggan"].map(rules).fillna(0.0).to_numpy()
    potensi = df["potensi_rp_bulan"].fillna(0.0).to_numpy()
    rankings = {{"Aturan skrining (skor)": rule_score, "Tanpa label (Isolation Forest)": sc["anomaly"], "Berlabel P2TL (gradient boosting)": sc["prob"],
                "Gabungan": sc["combined"], "Gabungan x nilai (prioritas nilai)": sc["combined"] * potensi}}
    rows = []
    for k in (40, 100):
        for name, s in rankings.items():
            rows.append({{"strategi": name, "k": k, "presisi_at_k": round(precision_at(s, truth, k), 3),
                         "rp_pulih_per_inspeksi_bulan": round(rupiah_at(s, value, k), 0), "auroc_kunci": round(auroc(s, truth), 3)}})
    table = pd.DataFrame(rows)
    mlflow.log_table(table, "strategi_pemilihan_target.json")
    # honest AUROC on the inspection labels: 5-fold cross-validated probabilities of the inspected customers
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=26)
    p_cv = cross_val_predict(GradientBoostingClassifier(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.9, random_state=26),
                             X.to_numpy()[inspected], y[inspected], cv=cv, method="predict_proba")[:, 1]
    mlflow.log_metrics({{"auroc/label_p2tl_cv5": auroc(p_cv, y[inspected]),
                     "auroc/kunci_gabungan": auroc(sc["combined"], truth), "auroc/kunci_aturan": auroc(rule_score, truth),
                     "rp_per_inspeksi_k40/nilai": float(table[(table.k == 40) & (table.strategi.str.contains("nilai"))]["rp_pulih_per_inspeksi_bulan"].iloc[0]),
                     "rp_per_inspeksi_k40/aturan": float(table[(table.k == 40) & (table.strategi.str.contains("Aturan"))]["rp_pulih_per_inspeksi_bulan"].iloc[0])}})
    # bias of the labels: TM customers were hardly ever inspected
    tm = df["is_tm"].to_numpy().astype(bool)
    mlflow.log_table(pd.DataFrame([{{"segmen": "TM", "pelanggan": int(tm.sum()), "diinspeksi": int(inspected[tm].sum()), "temuan": int(y[tm].sum())}},
                                                  {{"segmen": "TR", "pelanggan": int((~tm).sum()), "diinspeksi": int(inspected[~tm].sum()), "temuan": int(y[~tm].sum())}}]), "bias_label_p2tl.json")
    order = np.argsort(-rankings["Gabungan x nilai (prioritas nilai)"])[:25]
    mlflow.log_table(pd.DataFrame({{"id_pelanggan": df["id_pelanggan"].to_numpy()[order], "segmen": df["segmen"].to_numpy()[order],
                                                  "skor_ntl": sc["combined"][order].round(3), "potensi_rp_bulan": potensi[order], "kunci": truth[order]}}), "target_teratas.json")
    # evaluation charts (confusion matrix, ROC, precision-recall, calibration, score distribution) and F1 / precision /
    # recall: on the answer key (all customers) at the P2TL team's capacity (top 5 %), and on the inspection labels (CV5)
    threshold = float(np.quantile(sc["combined"], 0.95))
    mlflow.log_param("ambang_prediksi", round(threshold, 4))
    log_klasifikasi(truth, sc["combined"], threshold, "kunci")
    log_klasifikasi(y[inspected], p_cv, 0.5, "p2tl_cv5")
    # the MLflow model (saved with the ml_models package); the example rows give it its input columns
    example = df[INPUT_COLUMNS].head(20).astype({{c: float for c in INPUT_COLUMNS[6:]}})
    model_output.publish(NtlPelangganModel(model, rows, threshold), input_example=example)
    mlflow.end_run()
'''

ADAPTER = '''import mlflow
import numpy as np
import pandas as pd

from ml_models.ntl import FEATURES, matrix

# the columns the deployed model reads (the is_* flags are derived from tegangan / ami / jenis_meter / segmen)
INPUT_COLUMNS = ["id_pelanggan", "potensi_rp_bulan", "tegangan", "ami", "jenis_meter", "segmen"] + [f for f in FEATURES if not f.startswith("is_")]


class NtlPelangganModel(mlflow.pyfunc.PythonModel):
    """How likely a customer is to be stealing or under-billed: the anomaly percentile (Isolation Forest), the P2TL
    finding probability (gradient boosting), their combination, the expected value (score x value proxy x 3 months)
    and the features behind the score. An MLflow model: saved with this package, loadable anywhere."""

    def __init__(self, model, strategi, threshold=0.5):
        self.model = model
        self.strategi = strategi
        self.threshold = threshold

    def predict(self, context, model_input, params=None):
        df = model_input.copy()
        df["is_tm"] = (df["tegangan"] == "TM").astype(int)
        df["is_ami"] = (df["ami"] == "Ya").astype(int)
        df["is_prabayar"] = (df["jenis_meter"] == "prabayar").astype(int)
        df["is_lembaga"] = df["segmen"].isin(["Pemerintah", "Sosial"]).astype(int)
        sc = self.model.score(matrix(df))
        out = pd.DataFrame({{"id_pelanggan": df["id_pelanggan"].astype(str).to_numpy()}})
        out["skor_anomali"] = np.round(sc["anomaly"], 4)
        out["prob_temuan"] = np.round(sc["prob"], 4)
        out["skor_ntl"] = np.round(sc["combined"], 4)
        out["nilai_harapan_ml_rp"] = np.round(sc["combined"] * pd.to_numeric(df["potensi_rp_bulan"], errors="coerce").fillna(0).to_numpy() * 3, 0)
        out["alasan_ml"] = sc["reasons"]
        # the benchmark contract: a probability-like score and the 0/1 prediction at the team's capacity
        out["probabilitas"] = out["skor_ntl"]
        out["prediksi"] = (sc["combined"] >= getattr(self, "threshold", 0.5)).astype(int)
        return out
'''

PIPELINE_PY = '''from transforms.api import Pipeline

from model_training import benchmark, fitur, model_training

my_pipeline = Pipeline()
my_pipeline.add_transforms(fitur.fitur_ntl, model_training.train_model, benchmark.benchmark_models)
'''

EVALUASI = '''"""Evaluation of a binary classifier: scikit-learn metrics and curves logged to the active MLflow run as a structured
evaluation (`<prefix>/evaluation.json`: confusion matrix, ROC and precision-recall curves, calibration, score
distribution) that the app draws, plus the classification report as a table. figures=True also logs matplotlib PNGs."""

import mlflow
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    classification_report,
    confusion_matrix,
    f1_score,
    matthews_corrcoef,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)

LABELS = ["normal", "NTL"]


def _thin(xs, ys, n=200):
    """At most n points of a curve (its shape kept, the ends included)."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    if len(xs) <= n:
        return xs, ys
    idx = np.unique(np.linspace(0, len(xs) - 1, n).round().astype(int))
    return xs[idx], ys[idx]


def _r(a, d=4):
    return [round(float(v), d) for v in a]


def log_klasifikasi(y_true, score, threshold, prefix, figures=False):
    """Metrics (accuracy, precision, recall, F1, ROC AUC, PR AUC, MCC) and the curves of a score against 0/1 labels,
    predicting 1 at score >= threshold. Returns the metrics."""
    y = np.asarray(y_true, dtype=int)
    p = np.asarray(score, dtype=float)
    pred = (p >= threshold).astype(int)
    both = len(np.unique(y)) == 2
    metrics = {
        "accuracy": accuracy_score(y, pred),
        "precision": precision_score(y, pred, zero_division=0),
        "recall": recall_score(y, pred, zero_division=0),
        "f1": f1_score(y, pred, zero_division=0),
        "mcc": matthews_corrcoef(y, pred),
    }
    if both:
        metrics["roc_auc"] = roc_auc_score(y, p)
        metrics["pr_auc"] = average_precision_score(y, p)
    mlflow.log_metrics({f"{prefix}/{k}": float(v) for k, v in metrics.items()})

    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    doc = {"type": "binary_classification", "name": prefix, "labels": LABELS, "threshold": float(threshold), "rows": int(len(y)),
           "prevalence": float(y.mean()), "metrics": {k: float(v) for k, v in metrics.items()},
           "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}}
    if both:
        fpr, tpr, _ = roc_curve(y, p)
        fpr, tpr = _thin(fpr, tpr)
        doc["roc"] = {"x": _r(fpr), "y": _r(tpr)}
        prec, rec, _ = precision_recall_curve(y, p)
        rec, prec = _thin(rec[::-1], prec[::-1])
        doc["pr"] = {"x": _r(rec), "y": _r(prec)}
        frac, mean = calibration_curve(y, np.clip(p, 0, 1), n_bins=10, strategy="quantile")
        doc["calibration"] = {"x": _r(mean), "y": _r(frac)}
    edges = np.linspace(min(p.min(), threshold), max(p.max(), threshold), 31)
    doc["scores"] = {"edges": _r(edges), "negative": np.histogram(p[y == 0], edges)[0].tolist(), "positive": np.histogram(p[y == 1], edges)[0].tolist()}
    mlflow.log_dict(doc, f"{prefix}/evaluation.json")

    report = pd.DataFrame(classification_report(y, pred, labels=[0, 1], target_names=LABELS, output_dict=True, zero_division=0)).T.reset_index()
    mlflow.log_table(report.rename(columns={"index": "kelas"}).round(4), f"{prefix}/classification_report.json")
    if figures:
        _figures(y, p, pred, threshold, prefix, both)
    return metrics


def _figures(y, p, pred, threshold, prefix, both):
    """The same evaluation as matplotlib figures (for MLflow's own UI or a notebook)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from sklearn.metrics import ConfusionMatrixDisplay, PrecisionRecallDisplay, RocCurveDisplay

    def save(fig, name):
        fig.tight_layout()
        mlflow.log_figure(fig, f"{prefix}/{name}.png")
        plt.close(fig)

    fig, ax = plt.subplots(figsize=(4.4, 3.8))
    ConfusionMatrixDisplay.from_predictions(y, pred, labels=[0, 1], display_labels=LABELS, cmap="Blues", colorbar=False, ax=ax)
    save(fig, "confusion_matrix")
    if both:
        fig, ax = plt.subplots(figsize=(4.4, 3.8))
        RocCurveDisplay.from_predictions(y, p, ax=ax, name=prefix)
        save(fig, "roc_curve")
        fig, ax = plt.subplots(figsize=(4.4, 3.8))
        PrecisionRecallDisplay.from_predictions(y, p, ax=ax, name=prefix)
        save(fig, "precision_recall_curve")
'''

KANDIDAT = '''import mlflow
import numpy as np
import pandas as pd

from ml_models.ntl import matrix


def flags(df):
    df = df.copy()
    df["is_tm"] = (df["tegangan"] == "TM").astype(int)
    df["is_ami"] = (df["ami"] == "Ya").astype(int)
    df["is_prabayar"] = (df["jenis_meter"] == "prabayar").astype(int)
    df["is_lembaga"] = df["segmen"].isin(["Pemerintah", "Sosial"]).astype(int)
    return df


class NtlKandidat(mlflow.pyfunc.PythonModel):
    """A benchmark candidate for NTL detection: a scikit-learn classifier (probability of a finding) or an unsupervised
    detector (anomaly percentile), with the same inputs as the deployed model and the same outputs: probabilitas and
    prediksi (1 for the top of the ranking the P2TL team can inspect)."""

    def __init__(self, estimator, kind, threshold, reference=None):
        self.estimator = estimator
        self.kind = kind
        self.threshold = threshold
        self.reference = reference

    def score(self, df):
        X = matrix(flags(df)).to_numpy(float)
        if self.kind == "unsupervised":
            raw = -self.estimator.score_samples(X)
            return np.searchsorted(self.reference, raw, side="right") / len(self.reference)
        return self.estimator.predict_proba(X)[:, 1]

    def predict(self, context, model_input, params=None):
        p = self.score(model_input)
        return pd.DataFrame({"id_pelanggan": model_input["id_pelanggan"].astype(str).to_numpy(), "probabilitas": np.round(p, 4),
                             "prediksi": (p >= self.threshold).astype(int)})
'''

BENCHMARK = '''import mlflow
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, IsolationForest, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from transforms.api import transform, Input, ModelOutput

from ml_models.evaluasi import log_klasifikasi
from ml_models.kandidat import NtlKandidat
from ml_models.ntl import FEATURES, matrix
from ml_models.ntl_model import INPUT_COLUMNS

CAPACITY = 0.95  # the P2TL team inspects the top 5 % of each ranking


@transform.using(
    fitur=Input("{base}/ml/fitur_ntl_pelanggan"),
    kunci=Input("{base}/ml/kunci_evaluasi_demo"),
    random_forest=ModelOutput("{base}/ml/benchmark/rf_taruna2025 (demo)"),
    logistik=ModelOutput("{base}/ml/benchmark/regresi_logistik (demo)"),
    gbm=ModelOutput("{base}/ml/benchmark/gradient_boosting (demo)"),
    isolation_forest=ModelOutput("{base}/ml/benchmark/isolation_forest (demo)"),
)
def benchmark_models(fitur, kunci, random_forest, logistik, gbm, isolation_forest):
    """Four candidate models for the NTL target list, trained the same way and evaluated on the same answer key, for
    the Modeling Objective "Deteksi susut NTL pelanggan (demo)": Random Forest (Taruna et al. 2025, the best model for
    PLN's Target Operation), logistic regression (baseline), gradient boosting on the P2TL labels, and Isolation Forest
    (no labels). Each is an MLflow run with its metrics and charts."""
    df = fitur.pandas().reset_index(drop=True)
    X = matrix(df).to_numpy(float)
    y = df["label_p2tl"].to_numpy().astype(int)
    inspected = df["diinspeksi"].to_numpy().astype(bool)
    key = kunci.pandas().set_index("id_pelanggan")
    truth = df["id_pelanggan"].map(key["pelanggaran_aktif"]).fillna(0).astype(int).to_numpy()
    example = df[INPUT_COLUMNS].head(20).astype({c: float for c in INPUT_COLUMNS[6:]})
    supervised = {
        "Random Forest (Taruna 2025)": (random_forest, RandomForestClassifier(n_estimators=300, min_samples_leaf=3, class_weight="balanced", random_state=26)),
        "Regresi logistik": (logistik, make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, class_weight="balanced"))),
        "Gradient boosting (P2TL)": (gbm, GradientBoostingClassifier(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.9, random_state=26)),
    }
    for name, (output, est) in supervised.items():
        with mlflow.start_run(run_name=name):
            mlflow.log_params({"model": name, "fitur": len(FEATURES), "dilatih_pada": "pelanggan diinspeksi P2TL", "baris_latih": int(inspected.sum()),
                               "ambang": "kapasitas tim (5 % teratas)"})
            est.fit(X[inspected], y[inspected])
            p = est.predict_proba(X)[:, 1]
            threshold = float(np.quantile(p, CAPACITY))
            log_klasifikasi(truth, p, threshold, "kunci")
            output.publish(NtlKandidat(est, "supervised", threshold), input_example=example)
    with mlflow.start_run(run_name="Isolation Forest (tanpa label)"):
        mlflow.log_params({"model": "Isolation Forest", "fitur": len(FEATURES), "dilatih_pada": "semua pelanggan, tanpa label", "ambang": "kapasitas tim (5 % teratas)"})
        iso = IsolationForest(n_estimators=300, contamination=0.05, random_state=26).fit(X)
        reference = np.sort(-iso.score_samples(X))
        model = NtlKandidat(iso, "unsupervised", 0.0, reference)
        p = model.score(df)
        model.threshold = float(np.quantile(p, CAPACITY))
        log_klasifikasi(truth, p, model.threshold, "kunci")
        isolation_forest.publish(model, input_example=example)
'''

README = """# Deteksi Susut NTL Grid demo

Non-technical loss (NTL) detection for the grid demo, after the literature benchmark (docs/BENCHMARK_GRID_TL_NTL.md):

1. `model_training/fitur.py` — customer features from the loss pipeline + P2TL labels (last inspection) + a value proxy.
2. `model_training/model_training.py` — Isolation Forest (unsupervised) + gradient boosting on P2TL labels (inspected
   customers only, class-weighted), combined; the experiment compares five target-selection rankings against the
   demo's answer key: precision and rupiah per inspection at k = 40 and 100, AUROC — and logs the label bias (TM customers
   were hardly ever inspected).
3. `ml_models/ntl_model.py` — the deployed model, an MLflow `PythonModel` (open source): anomaly percentile, finding
   probability, NTL score, expected value, the features behind it. The training is an MLflow run (params, metrics,
   tables), published with `ModelOutput(...).publish(model, input_example=...)`.

The live deployment's function `skorNtlPelangganGridDemo` is called by "Pipeline skor NTL pelanggan grid (demo)".
Reference for the target-list process this feeds: Taruna et al. (2025), "Electricity Theft Detection Using Machine
Learning in Traditional Meter Postpaid Residential Customers: A Case Study on State Electricity Company (PLN)
Indonesia", IEEE Access 13, doi:10.1109/ACCESS.2025.3526764 - PLN's Target Operation (TO) formation from monthly
usage of traditional-meter postpaid customers (Random Forest best; sequential RF+KNN filtering, AUC 0.89). In this
demo the same queue is the value-ranked P2TL target list; the hourly AMI score (demo_grid_ntl_stream.py) is an
early-warning feed into it, not a replacement.
"""


def repo_files(base: str) -> dict[str, str]:
    import json as _json

    import code_model_templates
    import code_repos

    files = dict(code_model_templates.model_training_files(REPO, code_repos.REPO_SETTINGS, ""))
    src = "transforms-python/src"
    files.pop(f"{src}/model_training/run_inference.py", None)
    files.pop(f"{src}/ml_models/linear_model.py", None)
    files.update({
        "README.md": README,
        f"{src}/ml_models/ntl.py": LIB.format(features=_json.dumps(FEATURES), labels=_json.dumps(LABELS, ensure_ascii=False)),
        f"{src}/ml_models/ntl_model.py": ADAPTER.format(),
        f"{src}/model_training/fitur.py": FITUR.format(base=base),
        f"{src}/model_training/model_training.py": TRAINING.format(base=base, model=MODEL_PATH),
        f"{src}/ml_models/evaluasi.py": EVALUASI,
        f"{src}/ml_models/kandidat.py": KANDIDAT,
        f"{src}/model_training/benchmark.py": BENCHMARK.replace("{base}", base),
        f"{src}/model_training/pipeline.py": PIPELINE_PY,
    })
    return files


# ------------------------------------------------------------------------------------------------
# the answer key (planted patterns: evaluation only)
# ------------------------------------------------------------------------------------------------

THEFT = {"NTL-01", "NTL-02", "NTL-04", "NTL-05", "NTL-06", "NTL-07", "NTL-08", "NTL-09", "NTL-10", "NTL-11", "NTL-12", "NTL-13", "NTL-14"}


def answer_key() -> list[dict]:
    """Per customer: is a violation / under-billing active in Jul–Sep, which, and what it loses per month (true energy −
    billed energy at the tariff, or the revenue the pattern loses)."""
    from datetime import date

    import demo_grid_data as gd

    sim = gd.simulate()
    raw = gd.generate()
    k0 = gd.DAYS.index(date(2026, 7, 1))
    billed: dict[str, float] = {}
    for m in ("2026_07", "2026_08", "2026_09"):
        for r in raw[f"ap2t_tagihan_{m}"]:
            billed[r["id_pelanggan"]] = billed.get(r["id_pelanggan"], 0.0) + r["kwh"]
    cs = {c["id_pelanggan"]: c for c in gd.customers()}
    out = []
    for cid, pats in gd._by_customer().items():
        c = cs[cid]
        active = [code for code, pr in pats if code in THEFT and any(gd._active(pr, d) for d in gd.DAYS[k0:])]
        if not active:
            continue
        true = sum(r["true"] for r in sim["customers"][cid][k0:])
        tarif = gd.TARIF[c["tarif"]]
        lost = max(0.0, true - billed.get(cid, 0.0)) / 3 * tarif
        if "NTL-09" in active:
            lost += billed.get(cid, 0.0) / 3 * (gd.TARIF["B2"] - tarif)
        if "NTL-10" in active:
            lost += billed.get(cid, 0.0) / 3 * 0.17 * tarif * (gd.WBP_FACTOR - 1)
        if "NTL-12" in active:
            lost += c["daya_kontrak_kva"] * 0.3 * 45000
        if "NTL-04" in active or "NTL-11" in active:
            lost += c["daya_va"] / 1000 * 40000
        out.append({"id_pelanggan": cid, "pelanggaran_aktif": 1, "pola": ", ".join(sorted(active)), "segmen": c["segmen"], "tegangan": c["tegangan"],
                    "nilai_hilang_rp_bulan": round(lost, 0)})
    return out


# ------------------------------------------------------------------------------------------------
# the scoring pipeline
# ------------------------------------------------------------------------------------------------

SQL_SKOR = """-- Skor NTL per pelanggan dari model (fungsi skorNtlPelangganGridDemo): persentil anomali, probabilitas temuan P2TL,
-- skor gabungan, nilai harapan; dibandingkan dengan skrining aturan — skor tinggi tanpa temuan aturan = pola baru.
WITH m AS (
  SELECT id_pelanggan,
         CAST(get_json_object(hasil_model, '$.skor_anomali') AS DOUBLE) AS skor_anomali,
         CAST(get_json_object(hasil_model, '$.prob_temuan') AS DOUBLE) AS prob_temuan,
         CAST(get_json_object(hasil_model, '$.skor_ntl') AS DOUBLE) AS skor_ntl,
         CAST(get_json_object(hasil_model, '$.nilai_harapan_ml_rp') AS DOUBLE) AS nilai_harapan_ml_rp,
         get_json_object(hasil_model, '$.alasan_ml') AS alasan_ml
  FROM input
),
r AS (SELECT id_pelanggan, MAX(skor) AS skor_aturan FROM skrining_aturan_pelanggan GROUP BY id_pelanggan)
SELECT m.*, RANK() OVER (ORDER BY m.nilai_harapan_ml_rp DESC) AS peringkat_nilai, RANK() OVER (ORDER BY m.skor_ntl DESC) AS peringkat_skor,
       f.segmen, f.tegangan, f.kode_dt, f.kode_penyulang, f.kode_ulp, COALESCE(r.skor_aturan, 0) AS skor_aturan,
       CASE WHEN m.skor_ntl >= 0.75 AND r.skor_aturan IS NULL THEN 'NTL tinggi — pola baru (tanpa temuan aturan)'
            WHEN m.skor_ntl >= 0.75 THEN 'NTL tinggi — dikonfirmasi aturan'
            WHEN r.skor_aturan IS NOT NULL AND m.skor_ntl < 0.4 THEN 'Temuan aturan — skor model rendah (cek pengecoh)'
            WHEN m.skor_ntl >= 0.55 THEN 'Perlu pantau'
            ELSE 'Wajar' END AS status_ml
FROM m
JOIN fitur_ntl_pelanggan f ON f.id_pelanggan = m.id_pelanggan
LEFT JOIN r ON r.id_pelanggan = m.id_pelanggan
ORDER BY peringkat_nilai, m.id_pelanggan"""

SQL_GARDU = """-- Skor NTL per gardu distribusi: pelanggan berskor tinggi, nilai harapan, dan pola baru di bawah tiap gardu.
SELECT kode_dt, COUNT(*) AS pelanggan_dinilai, SUM(CASE WHEN skor_ntl >= 0.75 THEN 1 ELSE 0 END) AS pelanggan_ntl_tinggi,
       SUM(CASE WHEN status_ml LIKE '%pola baru%' THEN 1 ELSE 0 END) AS pelanggan_pola_baru,
       ROUND(MAX(skor_ntl), 3) AS skor_ntl_maks, ROUND(SUM(nilai_harapan_ml_rp), 0) AS nilai_harapan_ml_rp
FROM input WHERE kode_dt <> ''
GROUP BY kode_dt
ORDER BY nilai_harapan_ml_rp DESC"""


def scoring_nodes() -> list[dict]:
    S = lambda i, n, d: {"id": i, "kind": "source", "name": n, "group": "ml", "doc": d}  # noqa: E731
    return [
        S("s_fitur", "fitur_ntl_pelanggan", "Fitur NTL per pelanggan (Code Repository)"),
        S("s_aturan", "skrining_aturan_pelanggan", "Skrining aturan pelanggan (pipeline neraca & susut)"),
        {"id": "t_skor", "kind": "model", "name": "skor_model", "group": "ml", "input": "s_fitur"},
        {"id": "t_ntl", "kind": "sql", "name": "skor_ntl_pelanggan", "group": "ml", "input": "t_skor", "sql": SQL_SKOR},
        {"id": "t_dt", "kind": "sql", "name": "skor_ntl_gardu", "group": "ml", "input": "t_ntl", "sql": SQL_GARDU},
    ]


SCORING_OUTPUTS = [("skor_ntl_pelanggan", "t_ntl"), ("skor_ntl_gardu", "t_dt")]
INPUT_COLS = ["id_pelanggan", "potensi_rp_bulan", "tegangan", "ami", "jenis_meter", "segmen"] + [f for f in FEATURES if not f.startswith("is_")]


def emulate_scoring(fitur: list[dict], aturan: list[dict]) -> dict[str, list[dict]]:
    import json as _json

    import demo_jkn_pipeline as dp
    import model_deployments

    outs = []
    for i in range(0, len(fitur), 500):
        outs += model_deployments.execute_function_rows(FUNCTION_API, [{c: r.get(c) for c in INPUT_COLS} for r in fitur[i:i + 500]])
    skor = [{**r, "hasil_model": _json.dumps(o, ensure_ascii=False)} for r, o in zip(fitur, outs)]
    nodes = [n if n["kind"] != "model" else {"id": "t_skor", "kind": "source", "name": "skor_model", "group": "ml"} for n in scoring_nodes()]
    rows = dp.run({"fitur_ntl_pelanggan": fitur, "skrining_aturan_pelanggan": aturan, "skor_model": skor}, nodes)
    return {name: rows[next(n["name"] for n in nodes if n["id"] == node)] for name, node in SCORING_OUTPUTS}


def scoring_content(project: str, items: dict[str, str], previews: dict[str, list[dict]], ml_folder: str, fn: dict, uid, schedule) -> tuple[dict, dict[str, str]]:
    from datetime import datetime, timezone

    import demo_jkn_pipeline as dp

    now = datetime.now(timezone.utc).isoformat()
    legend = [{"id": "lg-sumber", "name": "Sumber (Code Repository & pipeline susut)", "hex": "#2c9c9c"},
              {"id": "lg-model", "name": "Model (live deployment)", "hex": "#805ad5"}, {"id": "lg-sql", "name": "Peringkat & gardu", "hex": "#d53f8c"}]
    pos = {"s_fitur": (60, 60), "s_aturan": (60, 260), "t_skor": (380, 60), "t_ntl": (700, 140), "t_dt": (1020, 140)}
    datasets, nodes = {}, []
    fn_id = "pyfn-ntl"
    for n in scoring_nodes():
        x, y = pos[n["id"]]
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {project}", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in dp.schema_of(rows)], "rows": rows[:100], "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            nodes.append({"id": n["id"], "name": n["name"], "x": x, "y": y, "color": "lg-sumber", "kind": "source", "datasetId": ds, "description": n["doc"]})
        elif n["kind"] == "model":
            params = {f"pyarg_{i['name']}": i["name"] for i in fn["inputs"]}
            params["output"] = "hasil_model"
            nodes.append({"id": n["id"], "name": n["name"], "x": x, "y": y, "color": "lg-model", "kind": "transform", "input": n["input"],
                          "description": "Model NTL (live deployment) lewat fungsi skorNtlPelangganGridDemo: Isolation Forest + gradient boosting, nilai harapan.",
                          "steps": [{"id": uid(), "kind": f"fn:{fn_id}", "params": params}]})
        else:
            nodes.append({"id": n["id"], "name": n["name"], "x": x, "y": y, "color": "lg-sql", "kind": "transform", "input": n["input"],
                          "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}]})
    location = {"id": ml_folder, "name": f"{project} / ml"}
    out_ids = {name: f"o_{node}" for name, node in SCORING_OUTPUTS}
    outputs = [{"id": out_ids[name], "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": [{"id": uid(), "kind": "rowCount", "min": 1}], "x": 1360, "y": pos[node][1]} for name, node in SCORING_OUTPUTS]
    body = {
        "type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes, "outputs": outputs, "legend": legend, "location": location,
        "functions": [{"id": fn_id, "kind": "pyfn", "name": "skor NTL pelanggan", "description": "Fungsi model dari live deployment model NTL (demo)",
                       "args": [], "fn": {"functionId": fn["id"], "name": fn["name"], "version": fn["version"], "repoName": "model deployment",
                                          "inputs": fn["inputs"], "output": fn["output"]}}],
        "textNodes": [{"id": "note_ml", "x": 40, "y": -200, "w": 900, "h": 150, "color": "lg-model",
                       "text": "Skoring NTL: fitur pelanggan + label P2TL (Code Repository) → fungsi model dari live deployment (Isolation Forest tanpa label + "
                               "gradient boosting berlabel P2TL, gabungan, nilai harapan) → peringkat nilai & pola baru → skor per gardu. Mendukung properti "
                               "Pelanggan dan Gardu Distribusi di Nexus."}],
        "schedules": [schedule("ml", list(out_ids.values()))],
        "meta": {"version": 1, "description": "Demo: skoring NTL pelanggan grid lewat model (live deployment) di Pipeline Builder."},
    }
    return body, out_ids


# ------------------------------------------------------------------------------------------------
# the build (called by demo_grid_e2e.build)
# ------------------------------------------------------------------------------------------------

def build(state: dict, save) -> dict:
    import io
    import uuid

    import code_repos
    import drive
    import functions_registry as fr
    import model_assets
    import model_deployments as md
    import ontology
    import ontology_mdo
    import pipeline_datasets
    import pipeline_runtime as rt
    import pyarrow.parquet as pq

    import demo_grid_e2e as e
    import demo_grid_pipeline as gp

    out: dict[str, Any] = {}
    base = f"/{e.PROJECT}"
    project = e._folder(None, e.PROJECT, "project")
    ml_folder = e._folder(project, "ml")
    # the answer key the experiment evaluates against (never read by the features or the training)
    e._put(ml_folder, "kunci_evaluasi_demo", answer_key())
    # the training labels of the P2TL feedback loop: the features read them, so they exist before the first build
    # (Pipeline label P2TL gabungan keeps them current afterwards)
    import demo_grid_feedback as fb

    if not any(f["name"] == f"{fb.LABEL}.parquet" and not f.get("trashed_at") for f in drive.list_files(ml_folder)):
        e._put(ml_folder, fb.LABEL, fb.label_rows())
    repo = next((r for r in code_repos.list_repos() if r["name"] == REPO), None)
    if not repo:
        repo = code_repos.create_repo(code_repos.RepoIn(name=REPO, template="model-training",
                                                        description="Demo: deteksi susut non-teknis (NTL) pelanggan — Isolation Forest + gradient boosting berlabel P2TL, prioritas nilai."))
    files = repo_files(base)
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    if b["files"] != files:
        code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
        code_repos.commit(repo["id"], code_repos.CommitIn(message="Deteksi NTL grid: fitur + label P2TL, Isolation Forest + gradient boosting, prioritas nilai"))
        state.pop("ml_trained_at", None)
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    F = "transforms-python/src/model_training"
    if not state.get("ml_trained_at"):
        for key in (f"{F}/fitur.py::fitur_ntl", f"{F}/model_training.py::train_model", f"{F}/benchmark.py::benchmark_models"):
            built = code_repos.build_transform(rec, b["files"], b["name"], key, "demo", b.get("head"))
            if built["status"] != "succeeded":
                raise RuntimeError(f"{key}: {(built.get('error') or '')[-1500:]}")
        state["ml_trained_at"] = repo["id"]
        save()
    model = model_assets.find_ref(f"{base}/{MODEL_PATH}")
    out.update(repo_id=repo["id"], model_id=model["id"])
    dep = next((d for d in md.list_deployments(model_id=model["id"]) if d["kind"] == "direct"), None)
    if not dep:
        dep = md.create_direct(md.DirectIn(model_id=model["id"]))
    if not md.find_function(FUNCTION_API):
        md.publish_function(dep["id"], md.FunctionIn(name="Skor NTL pelanggan grid (demo)", api_name=FUNCTION_API, row_wise=True))
    fn = next(f for f in fr.model_functions() if f["id"] == fr.MODEL_PREFIX + FUNCTION_API)
    out.update(deployment_id=dep["id"], function_id=fn["id"])

    def item(folder: str, name: str) -> str:
        return next(f["id"] for f in drive.list_files(folder) if f["name"] == f"{name}.parquet" and not f.get("trashed_at"))

    susut_folder = e._folder(project, "susut")
    items = {"fitur_ntl_pelanggan": item(ml_folder, "fitur_ntl_pelanggan"), "skrining_aturan_pelanggan": item(susut_folder, "skrining_aturan_pelanggan")}
    read = lambda iid: pq.read_table(io.BytesIO(drive.read_bytes(drive._item(iid)))).to_pylist()  # noqa: E731
    fitur = read(items["fitur_ntl_pelanggan"])
    aturan = gp.outputs("susut")["skrining_aturan_pelanggan"]
    results = emulate_scoring(fitur, aturan)
    # the scores follow the current model (unchanged content is not rewritten)
    ids = {name: e._put(ml_folder, name, rows) for name, rows in results.items()}
    pid = state.get("scoring_pipeline_id")
    if not pid:
        body, out_ids = scoring_content(e.PROJECT, items, {"fitur_ntl_pelanggan": fitur, "skrining_aturan_pelanggan": aturan}, ml_folder, fn,
                                        lambda: uuid.uuid4().hex[:8], e._schedule)
        made = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=SCORING_PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))
        pid = made["id"]
        for name, oid in out_ids.items():
            rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": ml_folder, "version": 0, "rows": len(results[name]),
                                                "path": f"{e.PROJECT} / ml / {name}.parquet"})
        state["scoring_pipeline_id"] = pid
        save()
    out.update(scoring_pipeline_id=pid, scored=len(results["skor_ntl_pelanggan"]))
    attached = []
    for key, name, pk, columns in (
        ("pelanggan", "skor_ntl_pelanggan", "id_pelanggan", {"skor_ntl": "skor_ntl", "skor_anomali": "skor_anomali", "prob_temuan": "prob_temuan",
                                                            "nilai_harapan_ml_rp": "nilai_harapan_ml_rp", "peringkat_nilai": "peringkat_nilai_ml",
                                                            "status_ml": "status_ml", "alasan_ml": "alasan_ml"}),
        ("gardu", "skor_ntl_gardu", "kode_dt", {"pelanggan_ntl_tinggi": "pelanggan_ntl_tinggi", "pelanggan_pola_baru": "pelanggan_pola_baru",
                                                "skor_ntl_maks": "skor_ntl_maks", "nilai_harapan_ml_rp": "nilai_harapan_ml_rp"}),
    ):
        t = e._type(key)
        if any(d["dataset_id"] == ids[name] for d in ontology._object_type(t["id"]).get("additional_datasources") or []):
            continue
        ontology_mdo.add_datasource(t["id"], ontology_mdo.ExtraIn(dataset_id=ids[name], pk_column=pk, columns=columns))
        attached.append(key)
    out["attached"] = attached
    try:
        exps = model_assets._experiments(model["id"])
        out["experiment"] = exps[-1] if exps else None
    except Exception:  # noqa: BLE001
        out["experiment"] = None
    state["ml_experiment"] = out.get("experiment")
    try:
        out["benchmark"] = benchmark(base, project, ml_folder, fitur, read(item(ml_folder, "kunci_evaluasi_demo")))
    except Exception as ex:  # noqa: BLE001 - the deployed model and its scoring stand without the benchmark
        out["benchmark"] = {"error": str(getattr(ex, "detail", ex))[:500]}
    return {k: v for k, v in out.items() if k != "experiment"}


BENCHMARK_OBJECTIVE = "Deteksi susut NTL pelanggan (demo)"
# the candidates: the deployed (combined) model and the four the benchmark transform trains
CANDIDATES = [(MODEL_PATH, "Gabungan IF + GBM, prioritas nilai (model produksi)"), ("ml/benchmark/rf_taruna2025 (demo)", "Random Forest (Taruna et al. 2025)"),
              ("ml/benchmark/gradient_boosting (demo)", "Gradient boosting berlabel P2TL"), ("ml/benchmark/regresi_logistik (demo)", "Regresi logistik (baseline)"),
              ("ml/benchmark/isolation_forest (demo)", "Isolation Forest (tanpa label)")]


def benchmark(base: str, project: str, ml_folder: str, fitur: list[dict], kunci: list[dict]) -> dict:
    """The model library for NTL detection: a Modeling Objective comparing the five candidates on the same holdout (every
    customer with the answer key's truth), binary-classification metrics and charts (confusion matrix, ROC, lift) by
    voltage, AMI and segment."""
    import io

    import pandas as pd

    import db
    import drive
    import model_assets
    from fastapi import HTTPException

    import model_evaluation as mev
    import modeling_objectives as mo
    import pipeline_datasets

    import demo_grid_e2e as e

    truth = {r["id_pelanggan"]: int(r.get("pelanggaran_aktif") or 0) for r in kunci}
    df = pd.DataFrame(fitur)
    df["pelanggaran_aktif"] = df["id_pelanggan"].map(truth).fillna(0).astype(int)
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    name = "holdout_benchmark_ntl (demo)"
    ex = next((f for f in db.drive_list(ml_folder) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)
    if ex:
        pipeline_datasets._replace_content(ex, buf.getvalue())
        hold_id = ex["id"]
    else:
        hold_id = drive.save_bytes(ml_folder, f"{name}.parquet", buf.getvalue(), pipeline_datasets.PARQUET)["id"]
    eval_folder = e._folder(ml_folder, "evaluasi_benchmark")

    obj = next((o for o in mo.list_objectives() if o["name"] == BENCHMARK_OBJECTIVE), None)
    if not obj:
        obj = mo.create_objective(mo.ObjectiveIn(
            name=BENCHMARK_OBJECTIVE, success_metric="F1 score", threshold=0.3, project_id=project,
            description="Model mana yang paling tepat menyusun Target Operasi P2TL: lima kandidat dinilai pada pelanggan yang sama dengan kunci "
                        "jawaban demo (pelanggaran aktif Jul–Sep), ambang = kapasitas tim (5 % teratas). Data sintetis."))
    oid = obj["id"]
    submitted = []
    for path, label in CANDIDATES:
        m = model_assets.find_ref(f"{base}/{path}")
        v = m["versions"][-1]
        try:
            mo.submit_model(oid, mo.SubmissionIn(model_id=m["id"], version=v["id"], name=f"{label} v{v['version']}"))
            submitted.append(label)
        except HTTPException as ex:
            if ex.status_code != 409:
                raise
        # one submission per candidate model: earlier versions are archived (kept, out of the comparisons)
        for c in mo._get(oid)["candidates"]:
            if c.get("model_id") == m["id"] and c.get("model_version_rid") != v["rid"] and not c.get("archived"):
                mo.archive_candidate(oid, c["id"])
    mev.save_config(oid, mev.EvalConfig(
        generate="inference_metrics", auto_build=True, datasets=[mev.EvalDataset(id=hold_id, inference_folder_id=eval_folder, metrics_folder_id=eval_folder)],
        libraries=[mev.EvalLibrary(kind="binary_classification", name="Klasifikasi biner (kunci jawaban)",
                                   fields={"inference_field": "prediksi", "actual_field": "pelanggaran_aktif", "probability_field": "probabilitas"})],
        subsets=[mev.EvalSubset(fields=[mev.SubsetField(column="tegangan")]), mev.EvalSubset(fields=[mev.SubsetField(column="ami")]),
                 mev.EvalSubset(fields=[mev.SubsetField(column="segmen")]),
                 mev.EvalSubset(fields=[mev.SubsetField(column="tegangan"), mev.SubsetField(column="ami")])],
        expected_outputs=["prediksi", "probabilitas"],
        pinned_tabs=[mev.PinnedTab(name="Metrik utama", metrics=["F1 score", "Recall", "Precision", "ROC AUC score"]),
                     mev.PinnedTab(name="Bias label", metrics=["Row count", "Prior", "Recall", "Accuracy"])]))
    built = mev.build(oid)
    return {"objective_id": oid, "submitted": submitted, "evaluations": built.get("built"), "failed": built.get("failed"), "errors": built.get("errors")}
