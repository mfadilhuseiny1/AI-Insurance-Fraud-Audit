"""Demo: explainable unsupervised anomaly detection on JKN claims, wired through the data pipeline (POST via the
end-to-end demo, demo_jkn_e2e.py). After De Meulemeester et al., "Explainable unsupervised anomaly detection for
healthcare insurance data", BMC Medical Informatics and Decision Making 25:14 (2025), with a GAN detector added.

- Claims per SEP (July–September 2026) for every doctor of the audited facilities (~400, the 86 of the audit demo
  among them): diagnosis, procedure, INA-CBG group and severity, care type and class, length of stay, drugs, admission
  hour and day, referral. Doctors behind the rule-flagged cases bill accordingly (upcoding, phantom billing, prolonged
  stays, inflated drug bills, repeated claims, class manipulation, procedures without indication, self-referral,
  inappropriate referrals) — the known anomalies, like the paper's 38 known GPs. One pattern no rule covers is planted
  too, like the paper's finding: general practitioners at hospitals who mostly perform orthopaedic surgery.
- Pipeline 1 (demo_jkn_pipeline.py) cleans the claims and aggregates the numeric features per doctor (sum, mean,
  median, standard deviation, minimum, maximum — the paper's aggregation).
- Code Repository "Deteksi Anomali JKN demo": categorical embeddings by LSA (the SVD of the category × claim
  co-occurrence matrix, k = 3, l2-normalised, averaged per doctor), then eight unsupervised detectors — Isolation
  Forest, one-class SVM, LOF, KNN, ECOD, HBOS, an autoencoder and a GAN (BiGAN / EGBAD) — trained with an experiment
  that logs the AUROC of each against the known anomalies, for embeddings and for one-hot encoding (the paper's Table
  2), and a model adapter that scores a doctor: each detector's score, the ensemble, how many detectors put the doctor
  in their top 10 %, and Shapley values summed back to the original features (the paper's SHAP step).
- A live deployment of the model with a row-wise model function, which Pipeline 2 ("Pipeline skor anomali dokter JKN
  (demo)") calls in a Python-function step; its SQL ranks doctors, flags new patterns (anomalous without any known
  case) and compares each top doctor's category distributions with the population (the paper's Fig. 6).
- The scores back extra properties of Dokter Audit and Faskes Audit (a second datasource), shown on the overview page.

Synthetic data only. Seeded and idempotent: what exists is kept, and nothing is ever deleted.
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Any, Optional

# ------------------------------------------------------------------------------------------------
# what doctors of each specialty bill: diagnoses, procedures and inpatient INA-CBG groups (base tariff, stay)
# ------------------------------------------------------------------------------------------------

CATALOG: dict[str, dict] = {
    "Sp.PD": {"disiplin": "Penyakit dalam", "dx": ["I10", "E11.9", "J18.9", "N18.5", "K29.7"], "proc": ["none", "none", "99.04", "39.95"],
              "cbg": [("J-4-16", 4.5e6, 5), ("N-4-10", 6.0e6, 6), ("I-4-12", 3.2e6, 4), ("E-4-10", 3.8e6, 4), ("K-4-17", 2.6e6, 3)]},
    "Sp.B": {"disiplin": "Bedah", "dx": ["K35.8", "K40.9", "K80.2"], "proc": ["47.09", "53.00", "51.23"],
             "cbg": [("K-1-12", 7.5e6, 3), ("K-1-30", 6.8e6, 3), ("K-1-21", 12.0e6, 4)]},
    "Sp.OT": {"disiplin": "Ortopedi", "dx": ["S72.0", "M17.1", "S82.2"], "proc": ["81.54", "81.51", "79.35"],
              "cbg": [("M-1-50", 48.0e6, 6), ("M-1-30", 22.0e6, 5), ("M-1-60", 14.0e6, 4)]},
    "Sp.OG": {"disiplin": "Obstetri & ginekologi", "dx": ["O82", "O80", "O14.1"], "proc": ["74.1", "73.59", "none"],
              "cbg": [("O-6-10", 6.5e6, 3), ("O-6-13", 3.0e6, 2), ("O-6-12", 5.0e6, 4)]},
    "Sp.A": {"disiplin": "Anak", "dx": ["A09", "J18.9", "A91"], "proc": ["none", "99.18"],
             "cbg": [("A-4-14", 2.4e6, 3), ("J-4-16", 4.2e6, 4), ("A-4-13", 3.5e6, 4)]},
    "Sp.JP": {"disiplin": "Jantung", "dx": ["I25.1", "I21.9", "I50.0"], "proc": ["36.06", "88.56", "none"],
              "cbg": [("I-1-40", 38.0e6, 4), ("I-4-10", 9.0e6, 5), ("I-4-13", 6.0e6, 5)]},
    "Sp.S": {"disiplin": "Saraf", "dx": ["I63.9", "G40.9", "G43.9"], "proc": ["none", "88.91"],
             "cbg": [("G-4-14", 8.0e6, 6), ("G-4-20", 3.5e6, 3), ("G-4-26", 2.2e6, 2)]},
    "Sp.M": {"disiplin": "Mata", "dx": ["H25.9", "H40.9"], "proc": ["13.41", "none"], "cbg": [("H-1-30", 7.0e6, 1), ("H-3-11", 1.8e6, 1)]},
    "Sp.THT-KL": {"disiplin": "THT", "dx": ["J35.0", "H66.9"], "proc": ["28.2", "none"], "cbg": [("U-1-12", 5.0e6, 2), ("U-3-15", 1.5e6, 1)]},
}
FKTP_DX = ["J06.9", "K30", "I10", "E11.9", "A09", "L30.9", "H10.9", "J45.9", "K29.7", "E78.5"]
RS_SPECIALTIES = ["Sp.PD", "Sp.B", "Sp.OT", "Sp.OG", "Sp.A", "Sp.JP", "Sp.S", "Sp.M", "Sp.THT-KL"]
HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]
FKTP_JENIS = ("Puskesmas", "Klinik Pratama", "Dokter Praktik Perorangan")
# doctors per facility (the audit demo's doctors count towards it)
STAFF = {"RS Tipe A": 14, "RS Tipe B": 10, "RS Tipe C": 7, "RS Tipe D": 5, "Klinik Utama": 3, "Puskesmas": 3, "Klinik Pratama": 2, "Dokter Praktik Perorangan": 1}

# what a risky case makes its DPJP (or, for referral cases, its referring doctor) bill
ANOMALY_OF = {
    "Manipulasi diagnosis dan/atau tindakan (upcoding)": "upcoding", "Manipulasi hasil pemeriksaan penunjang": "upcoding",
    "Phantom billing (klaim palsu)": "phantom", "Menagihkan tindakan yang tidak dilakukan": "phantom", "Klaim fiktif obat/alkes": "phantom",
    "Prolonged length of stay": "los", "Inflated bills (penggelembungan tagihan obat)": "obat", "Inflated bills obat/alkes": "obat",
    "Pengurangan jumlah obat": "obat", "Readmisi": "repeat", "Repeat billing": "repeat", "Cloning (penjiplakan klaim)": "repeat",
    "Pemecahan episode": "repeat", "Unbundling / fragmentation": "repeat", "Manipulasi kelas perawatan": "kelas",
    "Tindakan tidak sesuai indikasi medis": "indikasi", "Self-referral": "selfref",
    "Rujukan tidak sesuai": "rujukan", "Penyalahgunaan dana kapitasi/nonkapitasi": "rujukan", "Manipulasi klaim nonkapitasi": "rujukan",
}
NOVEL = "Dokter umum melakukan operasi ortopedi di RS"


def _spec_code(spesialisasi: str) -> Optional[str]:
    """Sp.XX from "Spesialis (Sp.XX)" / "Spesialis penyakit dalam"; None for a general practitioner."""
    if "(" in spesialisasi:
        return spesialisasi.split("(", 1)[1].rstrip(")")
    if "penyakit dalam" in spesialisasi:
        return "Sp.PD"
    return None


def doctors_and_claims(seed: int = 713) -> dict[str, Any]:
    """{"dokter_tambahan": HFIS rows of the extra doctors, "klaim_fkrtl" / "klaim_fktp": claims per SEP,
    "anomali": id → kind, "novel": [ids]} — built on the audit demo's facilities, doctors and cases."""
    import demo_jkn_map as jm

    rnd = random.Random(seed)
    faskes = jm.generate()
    by = {f["kode"]: f for f in faskes}
    doctors, cases, _ = jm.generate_flow(faskes)
    docs = {d["id_dokter"]: {"id": d["id_dokter"], "faskes": d["faskes_utama"], "spec": _spec_code(d["spesialisasi"]),
                             "praktik_lain": next((k for k, f in by.items() if f["nama"] == d["praktik_lain"]), "") if d["praktik_lain"] else ""}
            for d in doctors}
    # the extra staff, specialists at hospitals and main clinics, GPs in primary care
    extra = []
    n = 100
    for f in faskes:
        have = [d for d in docs.values() if d["faskes"] == f["kode"]]
        rs = f["jenis"] not in FKTP_JENIS
        for i in range(max(0, STAFF[f["jenis"]] - len(have))):
            n += 1
            spec = RS_SPECIALTIES[(i + n) % len(RS_SPECIALTIES)] if rs else None
            if f["jenis"] == "Klinik Utama" and rs:
                spec = ["Sp.PD", "Sp.A", "Sp.M", "Sp.THT-KL", "Sp.OG"][(i + n) % 5]
            did = f"D-{n:03d}"
            name = f"dr. {rnd.choice(jm.FIRST)} {rnd.choice(jm.LAST)}" + (f", {spec}" if spec else "")
            docs[did] = {"id": did, "faskes": f["kode"], "spec": spec, "praktik_lain": ""}
            extra.append({"id_dokter": did, "nama_dokter": name, "spesialisasi": f"Spesialis ({spec})" if spec else "Dokter umum", "kode_faskes_utama": f["kode"]})
    # the new pattern: general practitioners on hospital staff who mostly assist orthopaedic surgery
    novel = []
    hospitals = [f for f in faskes if f["jenis"] in ("RS Tipe C", "RS Tipe D", "RS Tipe B") and f["status_audit"] == "Sehat"][:3]
    for f in hospitals:
        n += 1
        did = f"D-{n:03d}"
        docs[did] = {"id": did, "faskes": f["kode"], "spec": None, "praktik_lain": ""}
        extra.append({"id_dokter": did, "nama_dokter": f"dr. {rnd.choice(jm.FIRST)} {rnd.choice(jm.LAST)}", "spesialisasi": "Dokter umum", "kode_faskes_utama": f["kode"]})
        novel.append(did)
    # who is anomalous how: the DPJP of hospital-side cases, the referring doctor of referral cases
    anomali: dict[str, str] = {}
    weight: dict[str, int] = {}
    for c in cases:
        kind = ANOMALY_OF.get(c["jenis_kasus"], "upcoding")
        who = c["dokter_perujuk"] if kind == "rujukan" else c["dokter_dpjp"]
        if kind == "selfref":
            who = c["dokter_dpjp"]
        anomali.setdefault(who, kind)
        weight[who] = weight.get(who, 0) + c["jumlah_klaim"]
    fktp_near = {k: [g["kode"] for g in faskes if g["jenis"] in FKTP_JENIS and g["kantor_cabang"] == f["kantor_cabang"]] or [g["kode"] for g in faskes if g["jenis"] in FKTP_JENIS]
                 for k, f in by.items()}

    start = date(2026, 7, 1)
    seq = 0
    rtl, tp = [], []
    for did, d in sorted(docs.items()):
        f = by[d["faskes"]]
        rs = f["jenis"] not in FKTP_JENIS
        kind = anomali.get(did)
        p = min(0.65, max(0.3, 0.25 + 0.015 * weight.get(did, 0))) if kind else 0.0
        count = rnd.randint(45, 110) if rs else rnd.randint(30, 80)
        if kind == "repeat":
            count = int(count * 1.4)
        is_novel = did in novel
        for _ in range(count):
            seq += 1
            day = start + timedelta(days=rnd.randint(0, 91))
            hit = rnd.random() < p
            row = {"no_sep": f"SEP26Q3{seq:07d}", "tgl_layanan": day.isoformat(), "kode_faskes": d["faskes"], "id_dokter": did,
                   "faskes_perujuk": "", "dirujuk": "Tidak"}
            if rs and (d["spec"] or is_novel):
                spec = "Sp.OT" if is_novel and rnd.random() < 0.6 else (d["spec"] or rnd.choice(["Sp.PD", "Sp.A"]))
                cat = CATALOG[spec]
                inpatient = rnd.random() < (0.85 if is_novel and spec == "Sp.OT" else 0.35)
                if inpatient:
                    code, base, los = rnd.choice(cat["cbg"])
                    sev = rnd.choices(["I", "II", "III"], weights=[70, 22, 8])[0]
                    stay = max(1, int(round(rnd.gauss(los, 1) * {"I": 1, "II": 1.3, "III": 1.7}[sev])))
                    tarif = base * {"I": 1.0, "II": 1.35, "III": 1.8}[sev] * rnd.uniform(0.95, 1.05)
                    proc = rnd.choice(cat["proc"])
                    row.update(jenis_rawat="Rawat inap", kode_inacbg=f"{code}-{sev}", severity=sev, lama_rawat=stay, jam_masuk=rnd.randint(0, 23),
                               kelas_rawat=rnd.choices([1, 2, 3], weights=[15, 30, 55])[0], jumlah_obat=max(1, int(rnd.gauss(9, 3))))
                else:
                    tarif = rnd.uniform(1.8e5, 6.0e5)
                    proc = "none" if rnd.random() < 0.8 else rnd.choice(cat["proc"])
                    row.update(jenis_rawat="Rawat jalan", kode_inacbg=f"Q-5-{spec[3:].replace('-KL', '')[:3].upper()}-0", severity="0", lama_rawat=0,
                               jam_masuk=rnd.randint(7, 15), kelas_rawat=3, jumlah_obat=max(0, int(rnd.gauss(4, 2))))
                row.update(disiplin=cat["disiplin"], kode_icd=rnd.choice(cat["dx"]), kode_prosedur=proc)
                if rnd.random() < 0.7:
                    row["faskes_perujuk"] = rnd.choice(fktp_near[d["faskes"]])
                if is_novel and spec == "Sp.OT":
                    # billed as orthopaedics by a GP: large joint replacements and fracture fixation
                    row.update(kode_prosedur=rnd.choice(["81.54", "81.51", "80.6"]), kode_icd=rnd.choice(["M17.1", "S72.0"]))
            elif rs:
                # a GP at a main clinic (the self-referral practice)
                tarif = rnd.uniform(1.5e5, 4.0e5)
                row.update(jenis_rawat="Rawat jalan", kode_inacbg="Q-5-UMU-0", severity="0", lama_rawat=0, jam_masuk=rnd.randint(8, 20),
                           kelas_rawat=3, jumlah_obat=max(0, int(rnd.gauss(4, 2))), disiplin="Umum", kode_icd=rnd.choice(FKTP_DX), kode_prosedur="none")
            else:
                tarif = rnd.uniform(8.0e4, 2.5e5)
                row.update(jenis_rawat="Rawat jalan tingkat pertama", kode_inacbg="FKTP-RJ", severity="0", lama_rawat=0, jam_masuk=rnd.randint(7, 14),
                           kelas_rawat=3, jumlah_obat=max(0, int(rnd.gauss(3, 1.5))), disiplin="Umum", kode_icd=rnd.choice(FKTP_DX), kode_prosedur="none")
                row["dirujuk"] = "Ya" if rnd.random() < 0.08 else "Tidak"
            if hit:
                tarif = _distort(rnd, row, kind, tarif, d, by)
            row["tarif_inacbg"] = round(tarif, -3)
            row["tarif_rs"] = round(tarif * (rnd.uniform(0.95, 1.12) if not (hit and kind in ("upcoding", "obat", "phantom")) else rnd.uniform(1.2, 1.5)), -3)
            (rtl if rs else tp).append(row)
            if hit and kind == "selfref" and d["praktik_lain"]:
                # the same patient seen again at the doctor's own clinic, referred there by the doctor
                seq += 1
                (rtl if by[d["praktik_lain"]]["jenis"] not in FKTP_JENIS else tp).append({
                    **row, "no_sep": f"SEP26Q3{seq:07d}", "kode_faskes": d["praktik_lain"], "faskes_perujuk": d["faskes"], "dirujuk": "Ya",
                    "tgl_layanan": (day + timedelta(days=rnd.randint(1, 7))).isoformat()})
    cols = ["no_sep", "tgl_layanan", "kode_faskes", "id_dokter", "jenis_rawat", "disiplin", "kode_icd", "kode_prosedur", "kode_inacbg", "severity",
            "kelas_rawat", "lama_rawat", "jam_masuk", "jumlah_obat", "tarif_inacbg", "tarif_rs", "dirujuk", "faskes_perujuk"]
    order = lambda rows: [{c: r.get(c) for c in cols} for r in rows]  # noqa: E731
    return {"dokter_tambahan": extra, "klaim_fkrtl": order(rtl), "klaim_fktp": order(tp), "anomali": anomali, "novel": novel}


def _distort(rnd: random.Random, row: dict, kind: str, tarif: float, d: dict, by: dict) -> float:
    """One claim of an anomalous doctor, billed the way their case type says."""
    if kind == "upcoding" and row.get("severity") in ("I", "II"):
        row["severity"] = "III"
        row["kode_inacbg"] = row["kode_inacbg"].rsplit("-", 1)[0] + "-III"
        tarif *= 1.6
    elif kind == "phantom":
        row["jam_masuk"] = rnd.randint(0, 4)
        row["tgl_layanan"] = _weekend(row["tgl_layanan"])
        row["lama_rawat"] = 0
        if row["kode_prosedur"] == "none":
            row["kode_prosedur"] = "88.91"
        tarif *= 1.5
    elif kind == "los" and row.get("lama_rawat"):
        row["lama_rawat"] = int(row["lama_rawat"] * 2.6) + 2
        tarif *= 1.3
    elif kind == "obat":
        row["jumlah_obat"] = int(row["jumlah_obat"] * 3) + 6
        tarif *= 1.25
    elif kind == "repeat":
        # the same claim again and again: the doctor's first repeated claim's diagnosis, procedure and group
        fav = d.setdefault("fav", {k: row[k] for k in ("kode_icd", "kode_prosedur", "kode_inacbg", "severity", "jenis_rawat", "lama_rawat")})
        row.update(fav)
    elif kind == "kelas":
        row["kelas_rawat"] = 1
        tarif *= 1.3
    elif kind == "indikasi":
        row["kode_prosedur"] = rnd.choice(["36.06", "88.91", "88.56"])
        tarif *= 1.7
    elif kind == "rujukan":
        row["dirujuk"] = "Ya"
        row["kode_icd"] = rnd.choice(FKTP_DX[:5])
    return tarif


def _weekend(iso: str) -> str:
    d = date.fromisoformat(iso)
    return (d + timedelta(days=(5 - d.weekday()) % 7)).isoformat()


def known_and_novel(seed: int = 713) -> tuple[set[str], list[str]]:
    data = doctors_and_claims(seed)
    return set(data["anomali"]), data["novel"]



# ------------------------------------------------------------------------------------------------
# the Code Repository (Model Training layout): embeddings, training with an experiment, the adapter
# ------------------------------------------------------------------------------------------------

PROJECT = "JKN Healthcare System Intelligence"
REPO = "Deteksi Anomali JKN demo"
MODEL_PATH = "ml/model_anomali_dokter (demo)"
FUNCTION_API = "skorAnomaliDokterDemo"
SCORING_PIPELINE = "Pipeline skor anomali dokter JKN (demo)"
SLUGS = {"Isolation Forest": "skor_isolation_forest", "One-class SVM": "skor_one_class_svm", "LOF": "skor_lof", "KNN": "skor_knn", "ECOD": "skor_ecod",
         "HBOS": "skor_hbos", "Autoencoder": "skor_autoencoder", "GAN (BiGAN/EGBAD)": "skor_gan"}


def feature_columns() -> list[str]:
    import demo_jkn_ml_lib as lib

    return [f"{v}_{s}" for v in lib.NUMERIC for s in lib.STATS] + ["jumlah_klaim"] + [f"emb_{v}_{i}" for v in lib.CATEGORICAL for i in range(3)]


ADAPTER = '''import json

import mlflow
import numpy as np
import pandas as pd

from ml_models.anomali import LABELS, Ensemble

FEATURES = {features}
SLUGS = {slugs}


class AnomaliDokterModel(mlflow.pyfunc.PythonModel):
    """How unusual a doctor's billing is: eight unsupervised detectors on the doctor's claim profile (numeric
    statistics + LSA embeddings of the categorical variables), their ensemble, how many put the doctor in their top
    10 %, and — for the most unusual doctors — the Shapley values of the original features behind the score.
    An MLflow model (open source): saved with this package, loadable anywhere."""

    def __init__(self, model, config):
        self.model = model
        self.config = config

    def predict(self, context, model_input, params=None):
        df_in = model_input
        X = df_in[FEATURES].astype(float).fillna(0.0).to_numpy()
        sc = self.model.score(X)
        out = pd.DataFrame({{"id_dokter": df_in["id_dokter"].astype(str).to_numpy()}})
        out["skor_ensembel"] = np.round(sc["ensemble"], 4)
        out["suara_model"] = sc["votes"].astype(int)
        for name, slug in SLUGS.items():
            out[slug] = np.round(sc["per_model"][name], 4)
        cutoff = self.config.get("explain_from", 0.8)
        reasons = []
        for i in range(len(X)):
            if sc["ensemble"][i] < cutoff:
                reasons.append("[]")
                continue
            phi = self.model.shapley(X[i], permutations=self.config.get("permutations", 40), seed=i)
            top = [{{"fitur": k, "label": LABELS.get(k, k), "kontribusi": round(v, 4)}} for k, v in list(phi.items())[:5] if v > 0]
            reasons.append(json.dumps(top, ensure_ascii=False))
        out["alasan"] = reasons
        return out
'''

FITUR = '''import pandas as pd
from transforms.api import transform, Input, Output

from ml_models.anomali import embedded_features, lsa_embeddings


@transform.using(
    klaim=Input("{base}/clean/klaim_sep_bersih"),
    profil=Input("{base}/clean/profil_numerik_dokter"),
    dokter=Input("{base}/clean/dokter_audit"),
    fitur=Output("{base}/ml/fitur_anomali_dokter"),
    kamus=Output("{base}/ml/embedding_kategori"),
)
def fitur_anomali(klaim, profil, dokter, fitur, kamus):
    """Categorical embeddings (LSA: rank-3 SVD of the binary category x claim co-occurrence matrix, l2-normalised),
    averaged per doctor, joined to the numeric profile Pipeline Builder computed; the audit cases mark the doctors
    already known (used only to evaluate the unsupervised detectors)."""
    claims = klaim.pandas()
    emb = lsa_embeddings(claims, k=3)
    X = profil.pandas().set_index("id_dokter").join(embedded_features(claims, emb), how="inner").reset_index()
    cases = dokter.pandas().set_index("id_dokter")["jumlah_kasus"].fillna(0)
    X["diketahui_berisiko"] = X["id_dokter"].map(lambda i: int(cases.get(i, 0) > 0))
    fitur.write_pandas(X)
    kamus.write_pandas(pd.DataFrame([{{"kategori": k, "dim_1": v[0], "dim_2": v[1], "dim_3": v[2]}} for k, v in sorted(emb.items())]))
'''

TRAINING = '''import mlflow
import numpy as np
import pandas as pd
from transforms.api import transform, Input, ModelOutput

from ml_models.anomali import Ensemble, auroc, onehot_features
from ml_models.anomali_model import FEATURES, SLUGS, AnomaliDokterModel


@transform.using(
    fitur=Input("{base}/ml/fitur_anomali_dokter"),
    klaim=Input("{base}/clean/klaim_sep_bersih"),
    model_output=ModelOutput("{base}/{model}"),
)
def train_model(fitur, klaim, model_output):
    """Eight unsupervised detectors on the embedded profiles (no labels used in training); the experiment records
    each detector's AUROC against the doctors already known from audit cases, with categorical embeddings and with
    one-hot category shares (De Meulemeester et al. 2025, Table 2)."""
    df = fitur.pandas()
    y = df["diketahui_berisiko"].to_numpy()
    # an MLflow run: its parameters, metrics and tables become the experiment of the model version
    mlflow.start_run(run_name="ensembel-anomali-dokter")
    mlflow.log_params({{"dokter": len(df), "fitur": len(FEATURES), "embedding": "LSA k=3", "detektor": ", ".join(Ensemble.NAMES),
                           "epochs_gan": 1500, "suara": "persentil >= 0.9", "diketahui_berisiko": int(y.sum())}})
    model = Ensemble().fit(df[FEATURES].to_numpy(float), FEATURES, epochs=1500, log=lambda k, v, s: mlflow.log_metric(k, v, step=s))
    sc = model.score(df[FEATURES].to_numpy(float))
    # the baseline: the same detectors with one-hot category shares instead of the embeddings
    numeric = [c for c in FEATURES if not c.startswith("emb_")]
    oh = df.set_index("id_dokter")[numeric].join(onehot_features(klaim.pandas()), how="left").fillna(0.0)
    sc_oh = Ensemble().fit(oh.to_numpy(float), list(oh.columns), epochs=1500).score(oh.to_numpy(float))
    y_oh = df.set_index("id_dokter").loc[oh.index, "diketahui_berisiko"].to_numpy()
    rows = []
    for name in Ensemble.NAMES:
        rows.append({{"detektor": name, "auroc_embedding": round(auroc(sc["per_model"][name], y), 3), "auroc_onehot": round(auroc(sc_oh["per_model"][name], y_oh), 3)}})
    rows.append({{"detektor": "Ensembel (rata-rata persentil)", "auroc_embedding": round(auroc(sc["ensemble"], y), 3), "auroc_onehot": round(auroc(sc_oh["ensemble"], y_oh), 3)}})
    table = pd.DataFrame(rows)
    mlflow.log_table(table, "auroc_embedding_vs_onehot.json")
    mlflow.log_metrics({{"auroc/ensembel_embedding": float(table.iloc[-1]["auroc_embedding"]), "auroc/ensembel_onehot": float(table.iloc[-1]["auroc_onehot"]),
                            "fitur/onehot": float(oh.shape[1]), "fitur/embedding": float(len(FEATURES))}})
    order = np.argsort(-sc["ensemble"])[:20]
    mlflow.log_table(pd.DataFrame({{"id_dokter": df["id_dokter"].to_numpy()[order], "skor_ensembel": sc["ensemble"][order].round(3),
                                                          "suara_model": sc["votes"][order], "diketahui_berisiko": y[order]}}), "anomali_teratas.json")
    # the MLflow model (saved with the ml_models package); the example rows give it its input columns
    example = df[["id_dokter"] + FEATURES].head(20).astype({{f: float for f in FEATURES}})
    model_output.publish(AnomaliDokterModel(model, {{"explain_from": 0.8, "permutations": 40, "auroc": rows}}), input_example=example)
    mlflow.end_run()
'''

PIPELINE_PY = '''from transforms.api import Pipeline

from model_training import fitur, model_training

my_pipeline = Pipeline()
my_pipeline.add_transforms(fitur.fitur_anomali, model_training.train_model)
'''

README = """# Deteksi Anomali JKN demo

Explainable unsupervised anomaly detection on JKN claims, after De Meulemeester et al., *Explainable unsupervised
anomaly detection for healthcare insurance data*, BMC Medical Informatics and Decision Making 25:14 (2025), with a GAN
detector added.

1. `model_training/fitur.py` — LSA categorical embeddings of the claims (Pipeline Builder output `klaim_sep_bersih`),
   averaged per doctor and joined to the numeric profile (`profil_numerik_dokter`).
2. `model_training/model_training.py` — eight detectors (Isolation Forest, one-class SVM, LOF, KNN, ECOD, HBOS,
   autoencoder, BiGAN/EGBAD GAN); the experiment logs AUROC for embeddings vs one-hot.
3. `ml_models/anomali_model.py` — the deployed model, an MLflow `PythonModel` (open source): per doctor, each detector's percentile score, the ensemble, the
   votes (top 10 %) and Shapley values summed back to the original features.

The live deployment's function `skorAnomaliDokterDemo` is called by Pipeline Builder ("Pipeline skor anomali dokter
JKN (demo)").
"""


def repo_files(base: str) -> dict[str, str]:
    import json as _json
    from pathlib import Path

    import code_model_templates
    import code_repos

    files = dict(code_model_templates.model_training_files(REPO, code_repos.REPO_SETTINGS, ""))
    lib = (Path(__file__).parent / "demo_jkn_ml_lib.py").read_text(encoding="utf-8")
    src = "transforms-python/src"
    files.pop(f"{src}/model_training/run_inference.py", None)
    files.pop(f"{src}/ml_models/linear_model.py", None)
    # the template's example benchmark and evaluation helper are not part of this repository
    files.pop(f"{src}/model_training/benchmark.py", None)
    files.pop(f"{src}/ml_models/evaluasi.py", None)
    files.update({
        "README.md": README,
        f"{src}/ml_models/anomali.py": lib,
        f"{src}/ml_models/anomali_model.py": ADAPTER.format(features=_json.dumps(feature_columns()), slugs=_json.dumps(SLUGS, ensure_ascii=False)),
        f"{src}/model_training/fitur.py": FITUR.format(base=base),
        f"{src}/model_training/model_training.py": TRAINING.format(base=base, model=MODEL_PATH),
        f"{src}/model_training/pipeline.py": PIPELINE_PY,
    })
    return files


# ------------------------------------------------------------------------------------------------
# Pipeline 2: scoring through the live deployment's model function, then SQL
# ------------------------------------------------------------------------------------------------

SQL_ANOMALI = """-- Skor anomali per dokter dari model (fungsi skorAnomaliDokterDemo): ensembel delapan detektor, berapa detektor
-- menaruh dokter di 10 % teratas, dan alasannya (nilai Shapley) — dibandingkan dengan kasus audit yang sudah diketahui:
-- anomali tanpa kasus adalah pola baru untuk ditelusuri tim audit.
WITH m AS (
  SELECT id_dokter,
         CAST(get_json_object(hasil_model, '$.skor_ensembel') AS DOUBLE) AS skor_anomali,
         CAST(get_json_object(hasil_model, '$.suara_model') AS INT) AS suara_model,
         CAST(get_json_object(hasil_model, '$.skor_isolation_forest') AS DOUBLE) AS skor_isolation_forest,
         CAST(get_json_object(hasil_model, '$.skor_one_class_svm') AS DOUBLE) AS skor_one_class_svm,
         CAST(get_json_object(hasil_model, '$.skor_lof') AS DOUBLE) AS skor_lof,
         CAST(get_json_object(hasil_model, '$.skor_knn') AS DOUBLE) AS skor_knn,
         CAST(get_json_object(hasil_model, '$.skor_ecod') AS DOUBLE) AS skor_ecod,
         CAST(get_json_object(hasil_model, '$.skor_hbos') AS DOUBLE) AS skor_hbos,
         CAST(get_json_object(hasil_model, '$.skor_autoencoder') AS DOUBLE) AS skor_autoencoder,
         CAST(get_json_object(hasil_model, '$.skor_gan') AS DOUBLE) AS skor_gan,
         get_json_object(hasil_model, '$.alasan') AS alasan_anomali
  FROM input
)
SELECT m.*, RANK() OVER (ORDER BY m.skor_anomali DESC) AS peringkat_anomali,
       d.nama AS nama_dokter, d.spesialisasi, d.faskes_utama, d.nama_faskes, COALESCE(d.jumlah_kasus, 0) AS jumlah_kasus,
       CASE WHEN m.suara_model >= 5 AND COALESCE(d.jumlah_kasus, 0) > 0 THEN 'Anomali — sudah ada kasus audit'
            WHEN m.suara_model >= 5 THEN 'Anomali — pola baru (belum ada kasus)'
            WHEN COALESCE(d.jumlah_kasus, 0) > 0 THEN 'Ada kasus audit — profil klaim tidak menonjol'
            ELSE 'Wajar' END AS status_anomali
FROM m
LEFT JOIN dokter_audit d ON d.id_dokter = m.id_dokter
ORDER BY peringkat_anomali, m.id_dokter"""

SQL_DISTRIBUSI = """-- Distribusi kategori 25 dokter teranomali dibanding populasi (seperti Fig. 6 di jurnal): untuk tiap variabel, porsi
-- setiap kategori pada klaim dokter dan pada seluruh klaim.
WITH v AS (
  SELECT id_dokter, 'Disiplin / poli' AS variabel, disiplin AS kategori FROM input
  UNION ALL SELECT id_dokter, 'Prosedur (ICD-9-CM)', kode_prosedur FROM input
  UNION ALL SELECT id_dokter, 'Diagnosis (ICD-10)', kode_icd FROM input
  UNION ALL SELECT id_dokter, 'Kode INA-CBG', kode_inacbg FROM input
  UNION ALL SELECT id_dokter, 'Tingkat keparahan', severity FROM input
  UNION ALL SELECT id_dokter, 'Jam masuk', jam_kategori FROM input
  UNION ALL SELECT id_dokter, 'Hari layanan', hari FROM input
  UNION ALL SELECT id_dokter, 'Kelas rawat', kelas_rawat FROM input
  UNION ALL SELECT id_dokter, 'Jenis rawat', jenis_rawat FROM input
  UNION ALL SELECT id_dokter, 'Dirujuk', dirujuk FROM input
),
pop AS (
  SELECT variabel, kategori, COUNT(*) * 1.0 / (SELECT COUNT(*) FROM input) AS porsi_populasi FROM v GROUP BY variabel, kategori
),
top AS (SELECT id_dokter FROM anomali_dokter WHERE peringkat_anomali <= 25),
doc AS (
  SELECT v.id_dokter, v.variabel, v.kategori, COUNT(*) AS klaim FROM v JOIN top t ON t.id_dokter = v.id_dokter GROUP BY 1, 2, 3
),
tot AS (SELECT id_dokter, variabel, SUM(klaim) AS total FROM doc GROUP BY 1, 2)
SELECT d.id_dokter, d.variabel, d.kategori, d.klaim, ROUND(1.0 * d.klaim / t.total, 4) AS porsi_dokter,
       ROUND(p.porsi_populasi, 4) AS porsi_populasi, ROUND(1.0 * d.klaim / t.total - p.porsi_populasi, 4) AS selisih_porsi
FROM doc d
JOIN tot t ON t.id_dokter = d.id_dokter AND t.variabel = d.variabel
JOIN pop p ON p.variabel = d.variabel AND p.kategori = d.kategori
ORDER BY d.id_dokter, d.variabel, selisih_porsi DESC"""

SQL_FASKES_ANOMALI = """-- Anomali per faskes: skor tertinggi dan rata-rata dokternya, dokter yang dinilai anomali oleh >= 5 detektor, dan yang
-- merupakan pola baru (tanpa kasus audit).
SELECT f.kode, MAX(a.skor_anomali) AS skor_anomali_maks, ROUND(AVG(a.skor_anomali), 4) AS skor_anomali_rata,
       SUM(CASE WHEN a.suara_model >= 5 THEN 1 ELSE 0 END) AS dokter_anomali,
       SUM(CASE WHEN a.status_anomali LIKE '%pola baru%' THEN 1 ELSE 0 END) AS dokter_pola_baru
FROM faskes_audit f
LEFT JOIN input a ON a.faskes_utama = f.kode
GROUP BY f.kode
ORDER BY f.kode"""


def scoring_nodes() -> list[dict]:
    """The scoring pipeline (t_skor is the model-function step; the emulation feeds its rows as a source)."""
    S = lambda i, n, d: {"id": i, "kind": "source", "name": n, "group": "ml", "doc": d}  # noqa: E731
    return [
        S("s_fitur", "fitur_anomali_dokter", "Fitur per dokter dari Code Repository (profil numerik + embedding LSA)"),
        S("s_klaim", "klaim_sep_bersih", "Klaim per SEP yang sudah dibersihkan (pipeline audit)"),
        S("s_dokter", "dokter_audit", "Dokter dan kasus auditnya (pipeline audit)"),
        S("s_faskes", "faskes_audit", "Faskes audit (pipeline audit)"),
        {"id": "t_skor", "kind": "model", "name": "skor_model", "group": "ml", "input": "s_fitur"},
        {"id": "t_anomali", "kind": "sql", "name": "anomali_dokter", "group": "ml", "input": "t_skor", "sql": SQL_ANOMALI},
        {"id": "t_distribusi", "kind": "sql", "name": "distribusi_kategori_anomali", "group": "ml", "input": "s_klaim", "sql": SQL_DISTRIBUSI},
        {"id": "t_faskes", "kind": "sql", "name": "anomali_faskes", "group": "ml", "input": "t_anomali", "sql": SQL_FASKES_ANOMALI},
    ]


SCORING_OUTPUTS = [("anomali_dokter", "t_anomali"), ("distribusi_kategori_anomali", "t_distribusi"), ("anomali_faskes", "t_faskes")]


def emulate_scoring(fitur: list[dict], klaim: list[dict], dokter: list[dict], faskes: list[dict]) -> dict[str, list[dict]]:
    """The scoring pipeline here: the model function on the feature rows (the live deployment), then the SQL."""
    import json as _json

    import demo_jkn_pipeline as dp
    import model_deployments

    cols = ["id_dokter", *feature_columns()]
    outs = []
    for i in range(0, len(fitur), 500):
        outs += model_deployments.execute_function_rows(FUNCTION_API, [{c: r.get(c) for c in cols} for r in fitur[i:i + 500]])
    skor = [{**r, "hasil_model": _json.dumps(o, ensure_ascii=False)} for r, o in zip(fitur, outs)]
    nodes = [n if n["kind"] != "model" else {"id": "t_skor", "kind": "source", "name": "skor_model", "group": "ml"} for n in scoring_nodes()]
    rows = dp.run({"fitur_anomali_dokter": fitur, "klaim_sep_bersih": klaim, "dokter_audit": dokter, "faskes_audit": faskes, "skor_model": skor}, nodes)
    return {name: rows[next(n["name"] for n in nodes if n["id"] == node)] for name, node in SCORING_OUTPUTS}


def scoring_content(items: dict[str, str], previews: dict[str, list[dict]], ml_folder: str, fn: dict, uid, schedule) -> tuple[dict, dict[str, str]]:
    """Pipeline Builder content: sources, the Python-function step calling the model function, the SQL, outputs."""
    from datetime import datetime, timezone

    import demo_jkn_pipeline as dp

    now = datetime.now(timezone.utc).isoformat()
    legend = [{"id": "lg-sumber", "name": "Sumber (pipeline audit & Code Repository)", "hex": "#2c9c9c"},
              {"id": "lg-model", "name": "Model (live deployment)", "hex": "#805ad5"}, {"id": "lg-sql", "name": "Peringkat & penjelasan", "hex": "#d53f8c"}]
    pos = {"s_fitur": (60, 60), "s_klaim": (60, 220), "s_dokter": (60, 380), "s_faskes": (60, 540), "t_skor": (380, 60), "t_anomali": (700, 140),
           "t_distribusi": (1020, 220), "t_faskes": (1020, 460)}
    datasets, nodes = {}, []
    fn_id = "pyfn-anomali"
    for n in scoring_nodes():
        x, y = pos[n["id"]]
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {PROJECT}", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in dp.schema_of(rows)], "rows": rows[:100], "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            nodes.append({"id": n["id"], "name": n["name"], "x": x, "y": y, "color": "lg-sumber", "kind": "source", "datasetId": ds, "description": n["doc"]})
        elif n["kind"] == "model":
            params = {f"pyarg_{i['name']}": i["name"] for i in fn["inputs"]}
            params["output"] = "hasil_model"
            nodes.append({"id": n["id"], "name": n["name"], "x": x, "y": y, "color": "lg-model", "kind": "transform", "input": n["input"],
                          "description": "Model anomali dokter (live deployment) lewat fungsi skorAnomaliDokterDemo: 8 detektor, ensembel, suara, Shapley.",
                          "steps": [{"id": uid(), "kind": f"fn:{fn_id}", "params": params}]})
        else:
            nodes.append({"id": n["id"], "name": n["name"], "x": x, "y": y, "color": "lg-sql", "kind": "transform", "input": n["input"],
                          "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}]})
    location = {"id": ml_folder, "name": f"{PROJECT} / ml"}
    out_ids = {name: f"o_{node}" for name, node in SCORING_OUTPUTS}
    outputs = [{"id": out_ids[name], "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": [{"id": uid(), "kind": "rowCount", "min": 1}], "x": 1360, "y": pos[node][1]} for name, node in SCORING_OUTPUTS]
    body = {
        "type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": nodes, "outputs": outputs, "legend": legend, "location": location,
        "functions": [{"id": fn_id, "kind": "pyfn", "name": "skor anomali dokter", "description": "Fungsi model dari live deployment model anomali dokter (demo)",
                       "args": [], "fn": {"functionId": fn["id"], "name": fn["name"], "version": fn["version"], "repoName": "model deployment",
                                          "inputs": fn["inputs"], "output": fn["output"]}}],
        "textNodes": [{"id": "note_ml", "x": 40, "y": -200, "w": 900, "h": 150, "color": "lg-model",
                       "text": "Skoring anomali: fitur per dokter (Code Repository: profil numerik + embedding LSA) → fungsi model dari live deployment "
                               "(Isolation Forest, OCSVM, LOF, KNN, ECOD, HBOS, autoencoder, GAN BiGAN/EGBAD; ensembel, suara, Shapley) → peringkat dan "
                               "pola baru → distribusi kategori vs populasi → anomali per faskes. Keluaran mendukung properti Dokter dan Faskes di Ontologi."}],
        "schedules": [schedule(list(out_ids.values()))],
        "meta": {"version": 1, "description": "Demo: skoring anomali dokter JKN lewat model (live deployment) di Pipeline Builder, setelah De Meulemeester dkk. 2025."},
    }
    return body, out_ids


# ------------------------------------------------------------------------------------------------
# the build (called by demo_jkn_e2e.build)
# ------------------------------------------------------------------------------------------------


def _schedule(output_ids: list[str]) -> dict:
    from datetime import datetime, timezone

    return {"id": "jkn-ml-data", "name": "Skor ulang saat fitur berubah (demo)", "enabled": True, "enabledAt": datetime.now(timezone.utc).isoformat(),
            "target": "single", "outputs": output_ids, "trigger": {"id": "root", "kind": "or", "items": [{"id": "data", "kind": "data"}]},
            "retries": {"count": 1, "delayMinutes": 5}}


def build(state: dict, save) -> dict:
    """Code Repository (embeddings, training with experiment, adapter) → model asset → live deployment with a row-wise
    function → scoring pipeline (first load emulated with the same function) → Ontology datasources."""
    import uuid

    import code_repos
    import demo_jkn_e2e as e
    import demo_jkn_map as jm
    import functions_registry as fr
    import model_assets
    import model_deployments as md
    import ontology
    import ontology_mdo
    import pipeline_datasets
    import pipeline_runtime as rt

    out: dict = {}
    base = f"/{PROJECT}"
    project = e._folder(None, PROJECT, "project")
    ml_folder = e._folder(project, "ml")
    # -- the repository and its two transforms ------------------------------------------------------------------
    repo = next((r for r in code_repos.list_repos() if r["name"] == REPO), None)
    if not repo:
        repo = code_repos.create_repo(code_repos.RepoIn(name=REPO, template="model-training",
                                                        description="Demo: deteksi anomali tanpa label pada klaim JKN (embedding LSA, 8 detektor termasuk GAN, Shapley)."))
    files = repo_files(base)
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    if b["files"] != files:
        code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
        code_repos.commit(repo["id"], code_repos.CommitIn(message="Deteksi anomali dokter JKN: embedding LSA, ensembel 8 detektor (termasuk GAN), Shapley"))
        state.pop("ml_trained_at", None)
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    F = "transforms-python/src/model_training"
    if not state.get("ml_trained_at"):
        for key in (f"{F}/fitur.py::fitur_anomali", f"{F}/model_training.py::train_model"):
            built = code_repos.build_transform(rec, b["files"], b["name"], key, "demo", b.get("head"))
            if built["status"] != "succeeded":
                raise RuntimeError(f"{key}: {(built.get('error') or '')[-1500:]}")
        state["ml_trained_at"] = repo["id"]
        save()
    model = model_assets.find_ref(f"{base}/{MODEL_PATH}")
    out.update(repo_id=repo["id"], model_id=model["id"])
    # -- the live deployment and its row-wise function ----------------------------------------------------------
    dep = next((d for d in md.list_deployments(model_id=model["id"]) if d["kind"] == "direct"), None)
    if not dep:
        dep = md.create_direct(md.DirectIn(model_id=model["id"]))
    if not md.find_function(FUNCTION_API):
        md.publish_function(dep["id"], md.FunctionIn(name="Skor anomali dokter (demo)", api_name=FUNCTION_API, row_wise=True))
    fn = next(f for f in fr.model_functions() if f["id"] == fr.MODEL_PREFIX + FUNCTION_API)
    out.update(deployment_id=dep["id"], function_id=fn["id"])
    # -- the scoring pipeline -----------------------------------------------------------------------------------
    import drive

    def item(folder: str, name: str) -> str:
        return next(f["id"] for f in drive.list_files(folder) if f["name"] == f"{name}.parquet" and not f.get("trashed_at"))

    clean = e._folder(project, "clean")
    items = {"fitur_anomali_dokter": item(ml_folder, "fitur_anomali_dokter"), "klaim_sep_bersih": item(clean, "klaim_sep_bersih"),
             "dokter_audit": item(clean, "dokter_audit"), "faskes_audit": item(clean, "faskes_audit")}
    import io

    import pyarrow.parquet as pq

    read = lambda iid: pq.read_table(io.BytesIO(drive.read_bytes(drive._item(iid)))).to_pylist()  # noqa: E731
    fitur = read(items["fitur_anomali_dokter"])
    core = e.run_sql()
    results = emulate_scoring(fitur, core["klaim_sep_bersih"], core["dokter_audit"], core["faskes_audit"])
    import demo_jkn_pipeline as dp

    ids = {name: e._put(ml_folder, name, e._arrow(rows, dp.schema_of(rows)), replace=False) for name, rows in results.items()}
    pid = state.get("scoring_pipeline_id")
    if not pid:
        body, out_ids = scoring_content(items, {"fitur_anomali_dokter": fitur, "klaim_sep_bersih": core["klaim_sep_bersih"], "dokter_audit": core["dokter_audit"],
                                                "faskes_audit": core["faskes_audit"]}, ml_folder, fn, lambda: uuid.uuid4().hex[:8], _schedule)
        made = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=SCORING_PIPELINE, parent_id=project, content=body))
        pid = made["id"]
        for name, oid in out_ids.items():
            rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": ml_folder, "version": 0, "rows": len(results[name]),
                                                "path": f"{PROJECT} / ml / {name}.parquet"})
        state["scoring_pipeline_id"] = pid
        save()
    out.update(scoring_pipeline_id=pid, scored=len(results["anomali_dokter"]))
    # -- the Ontology: anomaly properties on Dokter Audit and Faskes Audit (second datasources) ---------------------
    attached = []
    for type_name, name, pk, columns in (
        (jm.DOKTER, "anomali_dokter", "id_dokter", {"skor_anomali": "skor_anomali", "suara_model": "suara_model", "peringkat_anomali": "peringkat_anomali",
                                                    "status_anomali": "status_anomali", "alasan_anomali": "alasan_anomali", "skor_gan": "skor_gan",
                                                    "skor_isolation_forest": "skor_isolation_forest", "skor_autoencoder": "skor_autoencoder"}),
        (jm.FASKES, "anomali_faskes", "kode", {"skor_anomali_maks": "skor_anomali_maks", "dokter_anomali": "dokter_anomali", "dokter_pola_baru": "dokter_pola_baru"}),
    ):
        t = jm._type(type_name)
        if any(d["dataset_id"] == ids[name] for d in ontology._object_type(t["id"]).get("additional_datasources") or []):
            continue
        ontology_mdo.add_datasource(t["id"], ontology_mdo.ExtraIn(dataset_id=ids[name], pk_column=pk, columns=columns))
        attached.append(type_name)
    out["attached"] = attached
    # the experiment's AUROC table, for the overview page
    try:
        exps = model_assets._experiments(model["id"])
        out["experiment"] = exps[-1] if exps else None
    except Exception:  # noqa: BLE001
        out["experiment"] = None
    return out
