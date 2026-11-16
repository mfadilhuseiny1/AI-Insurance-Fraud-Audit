"""Demo: models for the JKN facility risk problem ("Efisiensi Risiko pada Fasilitas Kesehatan", Program JKN).

POST /api/demo/jkn-models builds (or refreshes) the Model Integration demo, all titled "(demo)" and kept:
* Project "Audit Risiko Faskes JKN (demo)": synthetic facility-month indicators for the 20 risk subcategories
  (per 1,000 claims: upcoding, cloning, phantom billing, readmisi, …) with the audit outcome `perlu_audit` (training,
  holdout and the current month to score). No real facilities or patients.
* A Code Repository "risiko-faskes-jkn demo" (Model Training layout, MLflow): a logistic model over the 20 indicators
  as an MLflow PythonModel, trained in an MLflow run (the version's experiment), and an evaluation set "audit_holdout"
  (scikit-learn metrics, overall and by type of facility).
* A Model Studio "Risiko faskes JKN (demo)" training a competing classifier (best of LR / KNN / GBM).
* A modeling objective "Prioritas audit faskes JKN (demo)": both models submitted, a review check and an
  evaluation-based check (Recall ≥ 0.6), automatic evaluation on the holdout (binary classification; subsets by
  facility type and by claim volume), the better model released to staging and production, a live deployment
  "Skor risiko faskes (demo)" with the function `skorRisikoFaskesDemo` (row-wise), and a batch deployment scoring the
  current month into "skor_risiko_faskes_bulan_ini (demo)".
GET /api/demo/jkn-models: what exists.
"""

from __future__ import annotations

import io
import json
import threading
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/demo/jkn-models", tags=["demo"])
DIR = Path("data/demo-jkn-models")
_lock = threading.Lock()
PROJECT = "Audit Risiko Faskes JKN (demo)"
REPO = "risiko-faskes-jkn demo"
OBJECTIVE = "Prioritas audit faskes JKN (demo)"
STUDIO = "Risiko faskes JKN (demo)"

# the 20 subcategories, as indicator rates per 1,000 claims, with how strongly each raises the audit risk
INDICATORS = [
    ("penyalahgunaan_dana_kapitasi", 0.5), ("manipulasi_klaim_nonkapitasi", 0.6), ("rujukan_tidak_sesuai", 0.4), ("upcoding", 1.1),
    ("cloning", 0.7), ("phantom_billing", 1.3), ("inflated_bills", 0.8), ("pemecahan_episode", 0.9), ("unbundling", 0.8),
    ("self_referral", 0.5), ("repeat_billing", 0.9), ("prolonged_los", 0.6), ("manipulasi_kelas_perawatan", 0.7),
    ("tindakan_tidak_dilakukan", 1.2), ("tindakan_tidak_sesuai_indikasi", 0.6), ("readmisi", 0.7), ("klaim_fiktif_obat_alkes", 1.0),
    ("pengurangan_jumlah_obat", 0.5), ("inflated_bills_obat_alkes", 0.7), ("manipulasi_hasil_pemeriksaan", 0.9),
]
FEATURES = [k for k, _ in INDICATORS]


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "demo-jkn-models"
    DIR.mkdir(parents=True, exist_ok=True)


def facilities(n: int, seed: int, month: str, labelled: bool = True) -> pd.DataFrame:
    r = np.random.default_rng(seed)
    jenis = r.choice(["RS", "Puskesmas", "Klinik Pratama"], n, p=[0.3, 0.45, 0.25])
    provinsi = r.choice(["Jawa Barat", "Jawa Timur", "Sumatera Utara", "Sulawesi Selatan", "Kalimantan Timur"], n)
    risky = r.random(n) < 0.3
    df = pd.DataFrame({"kode_faskes": [f"FKS-{seed}{i:04d}" for i in range(n)], "bulan": month, "jenis_faskes": jenis, "provinsi": provinsi,
                       "klaim_per_bulan": np.where(jenis == "RS", r.gamma(6, 220, n), r.gamma(4, 80, n)).round(0)})
    z = np.full(n, -3.2)
    for k, w in INDICATORS:
        base = r.gamma(1.5, 1.2, n)
        v = base + np.where(risky & (r.random(n) < 0.35), r.gamma(3, 2.0, n), 0)
        df[k] = v.round(2)
        z += w * (v - 1.8) / 2.5
    if labelled:
        df["perlu_audit"] = (r.random(n) < 1 / (1 + np.exp(-z))).astype(int)
    return df


def _status() -> dict:
    p = DIR / "state.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


@router.get("")
def status() -> dict:
    return _status()


@router.post("")
def create() -> dict:
    """Build or refresh the demo (a few minutes: two training runs, evaluation, deployments)."""
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, "the demo is being built")
    try:
        return _create()
    finally:
        _lock.release()


def _save(state: dict) -> dict:
    DIR.mkdir(parents=True, exist_ok=True)
    (DIR / "state.json").write_text(json.dumps(state, indent=1), "utf-8")
    return state


def _create() -> dict:
    import code_model_templates
    import code_repos
    import db
    import drive
    import model_assets
    import model_deployments
    import model_evaluation
    import model_studio
    import modeling_objectives as mo
    import pipeline_datasets

    def folder(parent: Optional[str], name: str, kind: str = "folder") -> str:
        found = next((c for c in db.drive_list(parent) if c["name"] == name and c["kind"] in drive.CONTAINERS and not c.get("trashed_at")), None)
        return found["id"] if found else drive._insert_container(parent, kind, name)

    def dataset(folder_id: str, name: str, df: pd.DataFrame) -> str:
        buf = io.BytesIO()
        df.to_parquet(buf, index=False)
        ex = next((f for f in db.drive_list(folder_id) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)
        if ex:
            pipeline_datasets._replace_content(ex, buf.getvalue())
            return ex["id"]
        return drive.save_bytes(folder_id, f"{name}.parquet", buf.getvalue(), pipeline_datasets.PARQUET)["id"]

    state: dict = {"steps": []}
    proj = folder(None, PROJECT, "project")
    data_f, models_f, eval_f = folder(proj, "data"), folder(proj, "models"), folder(proj, "evaluasi")
    train_id = dataset(data_f, "indikator_risiko_faskes_latih (demo)", facilities(1200, 11, "2026-06"))
    hold_id = dataset(data_f, "indikator_risiko_faskes_holdout (demo)", facilities(400, 12, "2026-07"))
    now_id = dataset(data_f, "indikator_risiko_faskes_bulan_ini (demo)", facilities(300, 13, "2026-09", labelled=False))
    state["steps"].append("datasets")
    base = f"/{PROJECT}"

    # -- the Code Repository: adapter, training with an experiment, an evaluation set ----------------------------
    repo = next((r for r in code_repos.list_repos() if r["name"] == REPO), None)
    if not repo:
        repo = code_repos.create_repo(code_repos.RepoIn(name=REPO, template="model-training", description="(demo) Model risiko faskes JKN: logistic regression over the 20 risk indicators"))
    rec = code_repos._repo(repo["id"])
    files = {k: v for k, v in code_model_templates.model_training_files(REPO, code_repos.REPO_SETTINGS, "").items()}
    files.pop("transforms-python/src/ml_models/linear_model.py", None)
    # the template's example benchmark and evaluation helper are not part of this repository
    files.pop("transforms-python/src/model_training/benchmark.py", None)
    files.pop("transforms-python/src/ml_models/evaluasi.py", None)
    files["transforms-python/src/ml_models/risiko_faskes.py"] = ADAPTER.replace("{features}", json.dumps(FEATURES))
    files["transforms-python/src/model_training/model_training.py"] = TRAINING.replace("{base}", base)
    files["transforms-python/src/model_training/run_inference.py"] = EVALUATION.replace("{base}", base)
    files["transforms-python/src/model_training/pipeline.py"] = PIPELINE
    b = code_repos._branch(rec, None)
    if b["files"] != files:
        code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
        code_repos.commit(repo["id"], code_repos.CommitIn(message="(demo) facility risk model"))
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    F = "transforms-python/src/model_training"
    built = code_repos.build_transform(rec, b["files"], b["name"], f"{F}/model_training.py::train_model", "demo", b.get("head"))
    if built["status"] != "succeeded":
        raise HTTPException(500, f"the demo training build failed: {built['error']}")
    ev = code_repos.build_transform(rec, b["files"], b["name"], f"{F}/run_inference.py::evaluate_model", "demo", b.get("head"))
    if ev["status"] != "succeeded":
        raise HTTPException(500, f"the demo evaluation build failed: {ev['error']}")
    m_repo = model_assets.find_ref(f"{base}/models/model_risiko_faskes (demo)")
    state["steps"].append("code repository model")

    # -- Model Studio: a competing model ---------------------------------------------------------------------------
    studio = next((s for s in model_studio.list_studios() if s["name"] == STUDIO), None)
    if not studio:
        studio = model_studio.create_studio(model_studio.StudioIn(name=STUDIO, trainer="classification", folder_id=models_f, model_name="model_risiko_faskes_studio (demo)"))
    model_studio.save_config(studio["id"], model_studio.ConfigIn(
        name="20 indikator", changelog="(demo) all risk indicators, facility type and claim volume", training_dataset_id=train_id, test_dataset_id=hold_id,
        target="perlu_audit", features=[*FEATURES, "jenis_faskes", "klaim_per_bulan"], params={"eval_metric": "f1", "predict_probabilities": True, "prediction_column": "prediksi"}))
    s = model_studio.start_run(studio["id"], wait=True)
    if s["runs"][0]["status"] != "succeeded":
        raise HTTPException(500, f"the demo Model Studio run failed: {s['runs'][0].get('error')}")
    m_studio, _ = model_assets._get(s["model_id"])
    state["steps"].append("model studio model")

    # -- the modeling objective ------------------------------------------------------------------------------------
    obj = next((o for o in mo.list_objectives() if o["name"] == OBJECTIVE), None)
    if obj:
        for d in model_deployments.list_deployments(objective_id=obj["id"]):
            model_deployments.delete(d["id"])
        mo.delete_objective(obj["id"])
    obj = mo.create_objective(mo.ObjectiveIn(name=OBJECTIVE, description="Facilities to audit first: the probability that an audit finds significant losses, from the 20 risk "
                                             "indicators of the Efisiensi Risiko pada Fasilitas Kesehatan list (synthetic data).", success_metric="Recall", threshold=0.6))
    oid = obj["id"]
    mo.update_objective(oid, mo.SettingsIn(metadata_fields=[mo.MetadataField(id="tiket", name="Nomor tiket audit", type="string", required=True),
                                                            mo.MetadataField(id="tim", name="Tim pengusul", type="select", options=["Tim Audit", "Tim Data"])]))
    m_repo_v = m_repo["versions"][-1]
    m_studio_v = model_assets._read(m_studio["id"])["versions"][-1]
    mo.submit_model(oid, mo.SubmissionIn(model_id=m_repo["id"], version=m_repo_v["id"], name="Logistik 20 indikator (demo)", metadata={"tiket": "AUD-2026-001", "tim": "Tim Data"}))
    mo.submit_model(oid, mo.SubmissionIn(model_id=m_studio["id"], version=m_studio_v["id"], name="Model Studio terbaik (demo)", metadata={"tiket": "AUD-2026-002", "tim": "Tim Audit"}))
    model_evaluation.save_config(oid, model_evaluation.EvalConfig(
        generate="inference_metrics", auto_build=True, datasets=[model_evaluation.EvalDataset(id=hold_id, inference_folder_id=eval_f)],
        libraries=[model_evaluation.EvalLibrary(kind="binary_classification", name="Klasifikasi biner",
                                                fields={"inference_field": "prediksi", "actual_field": "perlu_audit", "probability_field": "probabilitas"})],
        subsets=[model_evaluation.EvalSubset(fields=[model_evaluation.SubsetField(column="jenis_faskes")]),
                 model_evaluation.EvalSubset(fields=[model_evaluation.SubsetField(column="klaim_per_bulan", bucket="cutoffs", cutoffs=[300, 1000])])],
        expected_outputs=["prediksi", "probabilitas"], pinned_tabs=[model_evaluation.PinnedTab(name="Metrik utama", metrics=["Recall", "Precision", "ROC AUC score"])]))
    built_eval = model_evaluation.build(oid)
    if built_eval["failed"]:
        raise HTTPException(500, f"the demo evaluation failed: {built_eval['errors']}")
    dash = model_evaluation.dashboard(oid)
    lib = dash["config"]["libraries"][0]["id"]
    mo.add_check(oid, mo.CheckIn(name="Tinjauan tim audit", description="Tim audit menyetujui sebelum rilis produksi"))
    mo.add_check(oid, mo.CheckIn(name="Recall minimal 0,6", description="Fasilitas berisiko tidak boleh banyak terlewat",
                                 evaluation={"dataset_id": hold_id, "library_id": lib, "metric": "Recall", "op": ">=", "value": 0.6}))
    rec_o = mo._get(oid)
    best, best_recall = None, -1.0
    for c in rec_o["candidates"]:
        r = next((x for x in dash["results"] if x["candidate_id"] == c["id"]), None)
        recall = ((r or {}).get("subsets") or {}).get("Overall", {}).get("metrics", {}).get("Recall") or 0
        if recall > best_recall:
            best, best_recall = c, recall
    review = next(x for x in rec_o["checks"] if not x.get("evaluation"))
    mo.act_on_check(oid, best["id"], review["id"], mo.CheckAction(action="comment", text="Recall dan presisi sudah dibandingkan di dashboard evaluasi."))
    mo.act_on_check(oid, best["id"], review["id"], mo.CheckAction(action="approve", text="Disetujui untuk uji coba di staging."))
    mo.create_release(oid, mo.ReleaseIn(candidate_id=best["id"], version="1.0", release_note=f"Recall {best_recall:.2f} pada holdout Juli 2026"))
    rel = mo._current_release(mo._get(oid), "staging")
    mo.promote_release(oid, rel["id"])
    live = mo.create_deployment(oid, mo.ObjectiveDeploymentIn(name="Skor risiko faskes (demo)", type="live", environment="production",
                                                              description="Skor risiko per faskes untuk prioritas audit"))
    model_deployments.publish_function(live["id"], model_deployments.FunctionIn(name="Skor risiko faskes (demo)", api_name="skorRisikoFaskesDemo", row_wise=True))
    batch = mo.create_deployment(oid, mo.ObjectiveDeploymentIn(name="Skor bulanan faskes (demo)", type="batch", environment="production", input_dataset_id=now_id,
                                                               output_folder_id=data_f, output_name="skor_risiko_faskes_bulan_ini (demo)"))
    state.update(project_id=proj, repo_id=repo["id"], repo_model_id=m_repo["id"], studio_id=studio["id"], studio_model_id=m_studio["id"], objective_id=oid,
                 released=best["name"], recall=best_recall, live_deployment_id=live["id"], batch_deployment_id=batch["id"])
    state["steps"].append("objective, evaluation, release, deployments")
    return _save(state)


ADAPTER = '''import mlflow
import numpy as np

FEATURES = {features}


class LogisticModel:
    """Logistic regression with standardized indicators, fitted by gradient descent."""

    def fit(self, X, y, epochs=400, lr=0.3, on_epoch=None):
        X = np.asarray(X, dtype=float)
        self.mean, self.std = X.mean(axis=0), X.std(axis=0) + 1e-9
        Z = np.c_[np.ones(len(X)), (X - self.mean) / self.std]
        self.w = np.zeros(Z.shape[1])
        for e in range(epochs):
            p = 1 / (1 + np.exp(-Z @ self.w))
            self.w -= lr * (Z.T @ (p - y) / len(y) + 1e-3 * self.w)
            if on_epoch and e % 40 == 0:
                on_epoch(e, float(-np.mean(y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12))), float(((p >= 0.5) == y).mean()))
        return self

    def predict_proba(self, X):
        Z = np.c_[np.ones(len(X)), (np.asarray(X, dtype=float) - self.mean) / self.std]
        return 1 / (1 + np.exp(-Z @ self.w))


class RisikoFaskesModel(mlflow.pyfunc.PythonModel):
    """Probability that an audit finds significant losses at a facility, from its 20 risk indicators. An MLflow
    model (open source): saved with this package, loadable anywhere."""

    def __init__(self, model, threshold=0.4):
        self.model = model
        self.threshold = threshold

    def predict(self, context, model_input, params=None):
        df = model_input.copy()
        p = self.model.predict_proba(df[FEATURES].fillna(0))
        df["probabilitas"] = p
        df["prediksi"] = (p >= self.threshold).astype(int)
        return df
'''

TRAINING = '''import mlflow
import pandas as pd
from transforms.api import transform, Input, ModelOutput

from ml_models.risiko_faskes import FEATURES, LogisticModel, RisikoFaskesModel


@transform.using(
    training=Input("{base}/data/indikator_risiko_faskes_latih (demo)"),
    model_output=ModelOutput("{base}/models/model_risiko_faskes (demo)"),
)
def train_model(training, model_output):
    df = training.pandas()
    # an MLflow run: its parameters, stepped metrics and tables become the experiment of the model version
    with mlflow.start_run(run_name="logistik-20-indikator"):
        mlflow.log_params({"model": "logistic regression", "epochs": 400, "learning_rate": 0.3, "threshold": 0.4, "rows": len(df)})
        model = LogisticModel().fit(df[FEATURES], df["perlu_audit"].to_numpy(), 400, 0.3,
                                    lambda e, loss, acc: mlflow.log_metrics({"train/loss": loss, "train/accuracy": acc}, step=e))
        mlflow.log_table(pd.DataFrame({"indikator": ["intercept"] + FEATURES, "bobot": model.w}).sort_values("bobot", ascending=False), "bobot_indikator.json")
        model_output.publish(RisikoFaskesModel(model, 0.4), input_example=df[FEATURES].head(20).astype(float))
'''

EVALUATION = '''import pandas as pd
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from transforms.api import transform, Input, Output, ModelInput, evaluation


def classification_metrics(group):
    y, yhat, p = group["perlu_audit"], group["prediksi"], group["probabilitas"]
    out = {"example_count": len(group), "accuracy": accuracy_score(y, yhat), "precision": precision_score(y, yhat, zero_division=0),
           "recall": recall_score(y, yhat, zero_division=0), "f1": f1_score(y, yhat, zero_division=0)}
    if y.nunique() == 2:
        out["roc_auc"] = roc_auc_score(y, p)
    return out


@evaluation("audit_holdout")
@transform.using(
    holdout=Input("{base}/data/indikator_risiko_faskes_holdout (demo)"),
    model=ModelInput("{base}/models/model_risiko_faskes (demo)"),
    evaluated=Output("{base}/evaluasi/holdout_dinilai (demo)"),
)
def evaluate_model(holdout, model, evaluated):
    """scikit-learn metrics on the holdout, overall and per facility type, logged to the evaluation set."""
    df = holdout.pandas()
    scored = model.predict(df)
    df["probabilitas"], df["prediksi"] = scored["probabilitas"].to_numpy(), scored["prediksi"].to_numpy()
    result = model.create_evaluation()
    result.log_metrics({k: float(v) for k, v in classification_metrics(df).items()})
    for jenis, group in df.groupby("jenis_faskes"):
        result.log_metrics({f"{jenis}/{k}": float(v) for k, v in classification_metrics(group).items()})
    evaluated.write_pandas(df)
'''

PIPELINE = '''from transforms.api import Pipeline

from model_training import model_training, run_inference

my_pipeline = Pipeline()
my_pipeline.add_transforms(model_training.train_model, run_inference.evaluate_model)
'''
