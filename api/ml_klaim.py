"""Supervised claim-risk models on the real BPJS sample claims: which FKRTL claims will the BPJS verifier correct (pay
less than was billed)? The label is the data's own verification outcome, flag_selisih_verifikasi: 3,843 of 5.4 M claims.
It is not a rule: 3,842 of them were billed at or below their tariff plus top-ups, so the correction cannot be computed
from the bill. (The other two flags, duplicate candidate and LOS above the code's p99, are rules; they are features.)
Unsupervised detectors were dropped (the user, 2026-10-23): their consensus was no better than one Isolation Forest,
which stays in the benchmark as a reference row.

Features, pre-verification only (never biaya_verifikasi, selisih_rp or the flag):
  claim     billed amount, INA-CBG tariff, special-CMG top-ups, bill against tariff, LOS and its index against the same
            INA-CBG code (median, p90), the code's tariff index, how often severity III / a procedure goes with the
            diagnosis nationally, secondary diagnoses, case type, severity, CMG, class, poli, segment, discharge status,
            month and weekday, the two rule flags;
  patient   the same patient's visits (overall, at this facility, same day and code) and days since the last visit;
  facility  type, ownership, regional tariff, province, and its case-mix indices (severity share, LOS index,
            procedure share, special-CMG share, same-day twins, one-visit patients, code concentration).
Reference statistics (medians per code, rates per diagnosis) use no labels.

The benchmark (benchmark()): logistic regression, random forest, extra trees, histogram gradient boosting
(scikit-learn), XGBoost, LightGBM, CatBoost, an MLP and an Explainable Boosting Machine (InterpretML); Isolation Forest
(unsupervised) and the rule flags as reference rows. The evaluation set is every corrected claim plus a fixed 10 % of
the others, weighted back (inverse sampling weights), so every metric is the population's. Protocol: 5-fold
cross-validation grouped by faskes profile (no facility's claims in both train and test); inside each training part,
20 % of the facilities are held out to choose the decision threshold (max F1), which is then applied unchanged to the
test fold. Models train on all positives and 30 % of the sampled negatives (3 % of all), unweighted; no tuning on test.
A temporal check trains on the earlier 80 % of claims and tests on the latest 20 %. Explainers (explainer_benchmark()):
TreeSHAP, KernelSHAP, LIME, occlusion, the EBM's own terms and permutation importance, compared by faithfulness
(deletion curve: how fast the risk falls when the top-ranked features are reset), stability across seeds and time.
"""

from __future__ import annotations

import math
from pathlib import Path
import time
import warnings
from typing import Any, Callable, Optional

import numpy as np
import pandas as pd

PROFILE_ID = "md5(concat_ws('|', 'FKRTL', kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl))"  # as gold profil_faskes
FEATURES_VERSION = 1  # bump when prepare() changes: cached feature tables (aip/ml.py) are keyed by it
NEG_SAMPLE = 10  # the evaluation set keeps 1 in NEG_SAMPLE uncorrected claims (weight NEG_SAMPLE)
TRAIN_NEG = 0.3  # share of the evaluation set's negatives a model trains on
SEED = 0
BERAT = "Berat (rawat inap keparahan 3)"

# every column prepare() makes for a claim (the feature table, and the columns of the models up to 0.4.0)
CAT_ALL = ["tingkat_pelayanan", "poli", "kelas_rawat", "inacbg_cmg", "inacbg_tipe_kasus", "inacbg_keparahan", "segmen", "status_pulang",
           "jenis_fkrtl", "tipe_fkrtl", "kepemilikan_fkrtl", "regional_tarif", "edisi"]
CAT_HIGH = ["dx_primer_icd3", "inacbg_kode"]  # as their frequency and reference statistics, not as one-hot
NUM_ALL = ["biaya_tagih", "tarif_inacbg", "tarif_tambahan", "komponen_tambahan", "rasio_tagih_tarif", "selisih_tagih_tarif", "los", "idx_los",
           "los_di_atas_p90", "idx_tarif_kode", "frek_kode", "p_berat_dx", "p_prosedur_dx", "frek_dx", "dx_sekunder", "ada_prosedur",
           "flag_ganda", "flag_los_ekstrem", "bulan", "hari", "provinsi_kode", "kunjungan_peserta", "kunjungan_peserta_faskes", "kembar",
           "hari_sejak_sebelumnya", "f_jumlah_klaim", "f_pct_rawat_inap", "f_pct_keparahan_berat", "f_idx_los", "f_pct_prosedur_rj",
           "f_pct_tarif_tambahan", "f_pct_kembar", "f_pct_peserta_sekali", "f_hhi_inacbg", "f_hhi_dx", "f_rata_dx_sekunder", "f_idx_tarif_kode"]
FASKES = [c for c in NUM_ALL if c.startswith("f_")]  # the facility profile (the serving feature store keeps it)
# the model's columns since model 0.5.0 (2026-10-27): 23 of the 50. An ablation on the benchmark protocol (3 x 5 grouped
# folds, corrected paired t-test) found them as good as all 50 (no significant AUPRC difference, hospitals with CatBoost
# and all claims with LightGBM; measured before this copy) — and the others should not score a claim: context (edisi: how the
# sample was cut; bulan, hari; provinsi_kode: a model that learns a province's lenient verifiers scores its claims low,
# the very claims to find), duplicates (biaya_tagih ~ tarif_inacbg, komponen_tambahan ~ tarif_tambahan,
# selisih ~ rasio, los_di_atas_p90 and flag_los_ekstrem ~ idx_los, flag_ganda ~ kembar), and the facility profile (the
# claim is scored, not its facility: facility patterns are the tagger's rules)
NUM = ["tarif_inacbg", "tarif_tambahan", "rasio_tagih_tarif", "los", "idx_los", "idx_tarif_kode", "frek_kode", "p_berat_dx", "p_prosedur_dx",
       "frek_dx", "dx_sekunder", "ada_prosedur", "hari_sejak_sebelumnya", "kembar", "kunjungan_peserta"]
CAT_LOW = ["tingkat_pelayanan", "inacbg_cmg", "inacbg_tipe_kasus", "inacbg_keparahan", "poli", "kelas_rawat", "jenis_fkrtl", "tipe_fkrtl"]
FEATURES = NUM + CAT_LOW
# carried with the features to read a scored claim (the bill, the patient's segment, the province): never a feature
SHOWN = ["biaya_tagih", "segmen", "provinsi_kode"]
# what the reference rules read (fit_predict's "Aturan …" rows): carried in the evaluation set, never a feature (model
# 0.5.0's card lost the rule baseline when its flags left the features, 2026-10-27)
RULE_COLS = ["flag_ganda", "flag_los_ekstrem", "jenis_fkrtl", "tingkat_pelayanan"]
LABELS = {
    "biaya_tagih": "Biaya ditagih", "tarif_inacbg": "Tarif INA-CBG", "tarif_tambahan": "Tarif tambahan (special CMG)",
    "komponen_tambahan": "Jumlah komponen special CMG", "rasio_tagih_tarif": "Tagih / (tarif + tambahan)",
    "selisih_tagih_tarif": "Tagih − (tarif + tambahan)", "los": "Lama rawat (hari)", "idx_los": "LOS / median kode yang sama",
    "los_di_atas_p90": "LOS di atas p90 kodenya", "idx_tarif_kode": "Tarif / median tarif kodenya", "frek_kode": "Seberapa umum kode INA-CBG",
    "p_berat_dx": "Peluang keparahan berat untuk diagnosis ini", "p_prosedur_dx": "Peluang berprosedur untuk diagnosis ini",
    "frek_dx": "Seberapa umum diagnosis", "dx_sekunder": "Jumlah diagnosis sekunder", "ada_prosedur": "Ada prosedur",
    "flag_ganda": "Flag calon klaim ganda", "flag_los_ekstrem": "Flag LOS ekstrem", "bulan": "Bulan layanan", "hari": "Hari dalam pekan",
    "provinsi_kode": "Provinsi faskes", "kunjungan_peserta": "Kunjungan peserta (edisi)", "kunjungan_peserta_faskes": "Kunjungan peserta di faskes ini",
    "kembar": "Klaim kembar (peserta, tanggal, kode sama)", "hari_sejak_sebelumnya": "Hari sejak kunjungan sebelumnya di faskes ini",
    "f_jumlah_klaim": "Volume klaim faskes", "f_pct_rawat_inap": "Porsi rawat inap faskes", "f_pct_keparahan_berat": "Porsi keparahan berat faskes",
    "f_idx_los": "Indeks LOS faskes", "f_pct_prosedur_rj": "Porsi rawat jalan berprosedur faskes", "f_pct_tarif_tambahan": "Porsi special CMG faskes",
    "f_pct_kembar": "Porsi klaim kembar faskes", "f_pct_peserta_sekali": "Porsi peserta sekali datang di faskes",
    "f_hhi_inacbg": "Konsentrasi kode INA-CBG faskes", "f_hhi_dx": "Konsentrasi diagnosis faskes", "f_rata_dx_sekunder": "Rata-rata dx sekunder faskes",
    "f_idx_tarif_kode": "Indeks tarif faskes", "tingkat_pelayanan": "Tingkat pelayanan", "poli": "Poli", "kelas_rawat": "Kelas rawat",
    "inacbg_cmg": "CMG INA-CBG", "inacbg_tipe_kasus": "Tipe kasus INA-CBG", "inacbg_keparahan": "Keparahan INA-CBG", "segmen": "Segmen peserta",
    "status_pulang": "Status pulang", "jenis_fkrtl": "Jenis faskes", "tipe_fkrtl": "Tipe faskes", "kepemilikan_fkrtl": "Kepemilikan faskes",
    "regional_tarif": "Regional tarif", "edisi": "Edisi data",
}
ID_COLS = ["klaim_id", "faskes_profil_id", "tgl_datang", "dx_primer_icd3", "inacbg_kode", "y"]


# ------------------------------------------------------------------------------------------------
# features (DuckDB)
# ------------------------------------------------------------------------------------------------


def prepare(con: Any, table: str = "k", log: Callable[[str], None] = print, spill: Optional[str] = None) -> None:
    """`fitur` on `con`: every claim of `table` (silver kunjungan_fkrtl) with its features and label. With `spill` (a
    folder) the table is written there as Parquet and read back as a view, and the intermediate tables are dropped:
    three in-memory copies of 5.4 M claims made a training job page itself to a halt (2026-10-23)."""
    t0 = time.time()
    topup = "coalesce(sa_tarif_rp, 0) + coalesce(sp_tarif_rp, 0) + coalesce(rr_tarif_rp, 0) + coalesce(si_tarif_rp, 0) + coalesce(sd_tarif_rp, 0)"
    parts = " + ".join(f"(coalesce({c}_tarif_rp, 0) > 0)::INT" for c in ("sa", "sp", "rr", "si", "sd"))
    con.execute(f"""CREATE OR REPLACE TEMP TABLE kl AS
SELECT {PROFILE_ID} AS faskes_profil_id, edisi || ':' || kunjungan_fkrtl_id AS klaim_id, peserta_id, tgl_datang,
       coalesce(flag_selisih_verifikasi, false)::INT AS y,
       -- evaluation only, never a feature (not in FEATURES): what the verifier cut, and the province's name
       CASE WHEN coalesce(flag_selisih_verifikasi, false) THEN (biaya_tagih_rp - biaya_verifikasi_rp)::DOUBLE ELSE 0 END AS excess_rp,
       provinsi_fkrtl AS provinsi_nama,
       biaya_tagih_rp::DOUBLE AS biaya_tagih, tarif_inacbg_rp::DOUBLE AS tarif_inacbg, ({topup})::DOUBLE AS tarif_tambahan,
       {parts} AS komponen_tambahan, los_hari::DOUBLE AS los, jumlah_dx_sekunder::DOUBLE AS dx_sekunder,
       (prosedur IS NOT NULL)::INT AS ada_prosedur, coalesce(flag_calon_klaim_ganda, false)::INT AS flag_ganda,
       coalesce(flag_los_ekstrem, false)::INT AS flag_los_ekstrem, month(tgl_datang) AS bulan, dayofweek(tgl_datang) AS hari,
       kabkota_fkrtl_kode // 100 AS provinsi_kode,
       {', '.join(f"coalesce({c}::VARCHAR, 'tidak tercatat') AS {c}" for c in CAT_ALL + CAT_HIGH if c != 'edisi')}, edisi
FROM {table}""")
    con.execute("""CREATE OR REPLACE TEMP TABLE ref_kode AS SELECT inacbg_kode, median(los) AS med_los, quantile_cont(los, 0.9) AS p90_los,
                   median(tarif_inacbg) AS med_tarif, count(*) AS frek_kode FROM kl GROUP BY 1""")
    con.execute("""CREATE OR REPLACE TEMP TABLE ref_dx AS SELECT dx_primer_icd3,
                   avg((inacbg_keparahan LIKE 'Berat%')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL') AS p_berat_dx,
                   avg((inacbg_tipe_kasus LIKE 'Prosedur%')::INT) AS p_prosedur_dx, count(*) AS frek_dx FROM kl GROUP BY 1""")
    con.execute("""CREATE OR REPLACE TEMP TABLE kc AS
SELECT kl.*, biaya_tagih / nullif(tarif_inacbg + tarif_tambahan, 0) AS rasio_tagih_tarif,
       biaya_tagih - tarif_inacbg - tarif_tambahan AS selisih_tagih_tarif,
       los / nullif(r.med_los, 0) AS idx_los, (los > r.p90_los)::INT AS los_di_atas_p90, tarif_inacbg / nullif(r.med_tarif, 0) AS idx_tarif_kode,
       r.frek_kode, d.p_berat_dx, d.p_prosedur_dx, d.frek_dx,
       count(*) OVER (PARTITION BY edisi, peserta_id) AS kunjungan_peserta,
       count(*) OVER (PARTITION BY edisi, peserta_id, faskes_profil_id) AS kunjungan_peserta_faskes,
       count(*) OVER (PARTITION BY edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode) AS kembar,
       coalesce(date_diff('day', lag(tgl_datang) OVER (PARTITION BY edisi, peserta_id, faskes_profil_id ORDER BY tgl_datang, klaim_id),
                          tgl_datang), 9999) AS hari_sejak_sebelumnya
FROM kl LEFT JOIN ref_kode r USING (inacbg_kode) LEFT JOIN ref_dx d USING (dx_primer_icd3)""")
    log(f"fitur klaim: {con.execute('SELECT count(*) FROM kc').fetchone()[0]:,} klaim, {time.time() - t0:.1f} s")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE fk AS
WITH pp AS (SELECT faskes_profil_id, avg((n = 1)::INT)::DOUBLE AS f_pct_peserta_sekali
            FROM (SELECT faskes_profil_id, edisi, peserta_id, count(*) AS n FROM kc GROUP BY ALL) GROUP BY 1)
SELECT faskes_profil_id, count(*)::DOUBLE AS f_jumlah_klaim, avg((tingkat_pelayanan = 'RITL')::INT)::DOUBLE AS f_pct_rawat_inap,
       (avg((inacbg_keparahan = '{BERAT}')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL'))::DOUBLE AS f_pct_keparahan_berat,
       avg(idx_los) FILTER (WHERE tingkat_pelayanan = 'RITL') AS f_idx_los,
       (avg((inacbg_tipe_kasus LIKE 'Prosedur%')::INT) FILTER (WHERE tingkat_pelayanan = 'RJTL'))::DOUBLE AS f_pct_prosedur_rj,
       avg((tarif_tambahan > 0)::INT)::DOUBLE AS f_pct_tarif_tambahan, avg((kembar > 1)::INT)::DOUBLE AS f_pct_kembar,
       any_value(pp.f_pct_peserta_sekali) AS f_pct_peserta_sekali, avg(dx_sekunder) AS f_rata_dx_sekunder, avg(idx_tarif_kode) AS f_idx_tarif_kode
FROM kc JOIN pp USING (faskes_profil_id) GROUP BY faskes_profil_id""")
    for var, col in (("inacbg_kode", "f_hhi_inacbg"), ("dx_primer_icd3", "f_hhi_dx")):
        con.execute(f"""CREATE OR REPLACE TEMP TABLE h AS SELECT faskes_profil_id, sum(s * s) AS {col} FROM (
            SELECT faskes_profil_id, count(*) * 1.0 / sum(count(*)) OVER (PARTITION BY faskes_profil_id) AS s FROM kc GROUP BY faskes_profil_id, {var})
            GROUP BY 1""")
        con.execute(f"CREATE OR REPLACE TEMP TABLE fk AS SELECT fk.*, h.{col} FROM fk LEFT JOIN h USING (faskes_profil_id)")
    if spill:
        path = (Path(spill) / "fitur.parquet").as_posix()
        con.execute(f"COPY (SELECT kc.*, fk.* EXCLUDE (faskes_profil_id) FROM kc LEFT JOIN fk USING (faskes_profil_id)) TO '{path}' (FORMAT parquet)")
        for t in ("kc", "kl", "fk", "h"):
            con.execute(f"DROP TABLE IF EXISTS {t}")
        con.execute(f"CREATE OR REPLACE VIEW fitur AS SELECT * FROM read_parquet('{path}')")
    else:
        con.execute("CREATE OR REPLACE TEMP TABLE fitur AS SELECT kc.*, fk.* EXCLUDE (faskes_profil_id) FROM kc LEFT JOIN fk USING (faskes_profil_id)")
    log(f"fitur faskes digabung, {time.time() - t0:.1f} s")


# the two tasks: all claims, where 92 % of corrections are inpatient claims of a Klinik Utama (87.8 % of those are
# corrected: a rule, the baseline to beat), and hospital claims only (315 corrections in 5.29 M), the hard one
TASKS = {"semua": ("Semua klaim FKRTL", "TRUE"), "rumah_sakit": ("Klaim rumah sakit saja (tanpa klinik utama)", "jenis_fkrtl = 'Rumah sakit'")}


def eval_columns() -> list[str]:
    """The evaluation set's columns: ids and label, what a reader is shown, what the reference rules read, the features."""
    return list(dict.fromkeys(ID_COLS + SHOWN + RULE_COLS + FEATURES))


def evaluation_set(con: Any, task: str = "semua") -> pd.DataFrame:
    """Every corrected claim of the task and a fixed 1 in NEG_SAMPLE of the others (by a hash of the claim id), with
    weight w."""
    df = con.execute(f"""SELECT {', '.join(eval_columns())},
                                CASE WHEN y = 1 THEN 1.0 ELSE {float(NEG_SAMPLE)} END AS w
                         FROM fitur WHERE ({TASKS[task][1]}) AND (y = 1 OR hash(klaim_id) % {NEG_SAMPLE} = 0)
                         ORDER BY klaim_id""").df()
    return df


class Encoder:
    """Categories as integer codes (trees) — the same codes every time for the same category; unknown → −1. It keeps
    the columns it was fitted on, so a model scores with its own columns whatever NUM and CAT_LOW say now (an encoder
    pickled before it kept them, models up to 0.4.0, used NUM_ALL and the categories of its maps)."""

    def fit(self, df: pd.DataFrame) -> "Encoder":
        self.num, self.cat = list(NUM), list(CAT_LOW)
        self.maps = {c: {v: i for i, v in enumerate(df[c].value_counts().index)} for c in self.cat}
        return self

    @property
    def num_cols(self) -> list[str]:
        return list(getattr(self, "num", NUM_ALL))

    @property
    def cat_cols(self) -> list[str]:
        return list(getattr(self, "cat", self.maps))

    @property
    def columns(self) -> list[str]:
        return self.num_cols + self.cat_cols

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        X = df[self.num_cols].astype("float32").copy()
        for c in self.cat_cols:
            X[c] = df[c].map(self.maps[c]).fillna(-1).astype("float32")
        return X


def columns_of(segments: dict) -> list[str]:
    """Every column the segments' models read, each model its own (the models up to 0.4.0 read 50)."""
    return list(dict.fromkeys(c for s in segments.values() for c in s["enc"].columns))


# ------------------------------------------------------------------------------------------------
# models
# ------------------------------------------------------------------------------------------------

MODELS: dict[str, tuple[str, str]] = {
    "Regresi logistik": ("linear", "baseline klasik"),
    "Random Forest": ("bagging pohon", "Breiman 2001"),
    "Extra Trees": ("bagging pohon acak", "Geurts dkk. 2006"),
    "HistGradientBoosting": ("gradient boosting (scikit-learn)", "Ke dkk. 2017 (gaya LightGBM)"),
    "XGBoost": ("gradient boosting", "Chen & Guestrin 2016"),
    "LightGBM": ("gradient boosting", "Ke dkk. 2017"),
    "CatBoost": ("gradient boosting (ordered)", "Prokhorenkova dkk. 2018"),
    "MLP": ("jaringan saraf", "multilayer perceptron"),
    "EBM": ("glassbox (GAM + interaksi)", "Lou dkk. 2013; Nori dkk. 2019 (InterpretML)"),
}
# The research behind each technique and each protocol choice. "consensus": found with Consensus (peer-reviewed search,
# 2026-10-23, the month's quota ran out after two searches); "web": web search; "metode": the method's own paper.
def _ref(penulis: str, tahun: int, judul: str, venue: str, url: str = "", sumber: str = "metode", temuan: str = "", sitasi: Optional[int] = None) -> dict:
    return {"penulis": penulis, "tahun": tahun, "judul": judul, "venue": venue, "url": url, "sumber": sumber, "temuan": temuan, "sitasi": sitasi}


C = "https://consensus.app/papers/details/"
R_HANCOCK_AUPRC = _ref("Hancock, Khoshgoftaar & Johnson", 2023, "Evaluating classifier performance with highly imbalanced Big Data", "Journal of Big Data",
                       C + "56edd00b52fc5610a0fc142b8ec64b3f/", "consensus", "Pada klaim Medicare yang sangat timpang, AUPRC mengungkap presisi dan "
                       "positif palsu yang disembunyikan AUC; undersampling acak (RUS) merugikan AUPRC.", 115)
R_JOHNSON_NN = _ref("Johnson & Khoshgoftaar", 2019, "Medicare fraud detection using neural networks", "Journal of Big Data",
                    C + "f9872500dfac58fd80709d06012a1c02/", "consensus", "Jaringan saraf pada kelas minoritas yang sangat kecil; ambang keputusan harus dioptimalkan "
                    "di set validasi (ambang optimal bergantung pada ukuran kelas minoritas).", 114)
R_BAUDER_RF = _ref("Bauder & Khoshgoftaar", 2018, "Medicare Fraud Detection Using Random Forest with Class Imbalanced Big Data", "IEEE IRI",
                   C + "75b91705aa5b545ebb9232d3d8ada652/", "consensus", "Random Forest, validasi silang 5-lipatan, label fraud nyata (LEIE); rasio kelas 90:10 "
                   "terbaik (AUC 0,873).", 64)
R_HERLAND = _ref("Herland, Bauder & Khoshgoftaar", 2019, "The effects of class rarity on the evaluation of supervised healthcare fraud detection models",
                 "Journal of Big Data", C + "62500b0d40735cd1945608aa7b31c003/", "consensus", "Kinerja deteksi turun saat fraud makin langka; evaluasi harus "
                 "memperhitungkan kelangkaan kelas.", 56)
R_NABRAWI = _ref("Nabrawi & Alanazi", 2023, "Fraud Detection in Healthcare Insurance Claims Using Machine Learning", "Risks",
                 C + "07bd9cf55a2753868aae464496545277/", "consensus", "Random forest, regresi logistik dan ANN pada klaim asuransi kesehatan Arab Saudi; "
                 "RF terbaik (AUC 0,90), regresi logistik AUC 0,80.", 96)
R_FARAH = _ref("Farahmandazad dkk.", 2025, "Application of Standard Machine Learning Models for Medicare Fraud Detection with Imbalanced Data", "Risks",
               C + "bbb00031f5245900aaf76223c11ff2ea/", "consensus", "Random Forest terbaik di antara RF, KNN, LDA, Decision Tree, AdaBoost pada klaim Medicare.", 4)
R_HANCOCK_CB_XGB = _ref("Hancock & Khoshgoftaar", 2020, "Performance of CatBoost and XGBoost in Medicare Fraud Detection", "IEEE ICMLA",
                        C + "aecdb336d61f5a6f8f944686a3285b98/", "consensus", "CatBoost dan XGBoost pada data Medicare besar dan timpang; CatBoost unggul "
                        "signifikan bila fitur kategorikal dipakai.", 54)
R_HANCOCK_GBDT = _ref("Hancock & Khoshgoftaar", 2021, "Gradient Boosted Decision Tree Algorithms for Medicare Fraud Detection", "SN Computer Science",
                      C + "45a0ce805c2857a0b8d3e706e2d41f7f/", "consensus", "CatBoost (AUC 0,882) mengungguli LightGBM (0,851) secara signifikan dengan "
                      "fitur kategorikal berkardinalitas tinggi.", 58)
R_HANCOCK_CB = _ref("Hancock & Khoshgoftaar", 2020, "Medicare Fraud Detection using CatBoost", "IEEE IRI", C + "fbc2072fe098576eaff59efc543ff687/", "consensus",
                    "CatBoost AUC 0,890 vs XGBoost 0,762 (p < 0,01) dengan negara bagian penyedia sebagai fitur kategorikal.", 50)
R_SAKIL = _ref("Sakil dkk.", 2025, "Enhancing Medicare Fraud Detection With a CNN-Transformer-XGBoost Framework and Explainable AI", "IEEE Access",
               C + "818256dd3e2b5b458c2b3ea4ddad9cd6/", "consensus", "XGBoost dengan representasi CNN-Transformer dan penjelasan SHAP; AUC 0,97 pada "
               "Medicare Provider Fraud, mengungguli LightGBM dan CatBoost.", 15)
R_BENTEJAC = _ref("Bentéjac, Csörgő & Martínez-Muñoz", 2021, "A comparative analysis of gradient boosting algorithms", "Artificial Intelligence Review",
                  C + "c3be7a8bb964590488d56f7b829a39ab/", "consensus", "Perbandingan XGBoost, LightGBM, CatBoost, random forest dan gradient boosting: "
                  "selisih kecil; CatBoost sedikit unggul, LightGBM tercepat.", 2707)
R_LIANG = _ref("Liang dkk.", 2025, "An Interpretable and Efficient Random Undersampling-enhanced SHAP Framework for Medicare Fraud Detection", "IEEE CIC",
               C + "413d5129b0b7548eac0b7e6acd516810/", "consensus", "Seleksi fitur berbasis SHAP (LightGBM, XGBoost, CatBoost) pada Medicare Part B/D, "
               "dievaluasi dengan AUPRC.", 0)
R_GRINSZTAJN = _ref("Grinsztajn, Oyallon & Varoquaux", 2022, "Why do tree-based models still outperform deep learning on typical tabular data?",
                    "NeurIPS (Datasets & Benchmarks)", "https://arxiv.org/abs/2207.08815", "web", "Pada 45 dataset tabular, model pohon (XGBoost, random "
                    "forest) tetap mengungguli deep learning.")
R_CARUANA = _ref("Caruana dkk.", 2015, "Intelligible Models for HealthCare: Predicting Pneumonia Risk and Hospital 30-day Readmission", "KDD",
                 "https://doi.org/10.1145/2783258.2788613", "web", "GA²M/EBM di layanan kesehatan: akurasi setara model kotak hitam dan bisa dibaca dokter.")
R_DEMEUL = _ref("De Meulemeester dkk.", 2025, "Explainable unsupervised anomaly detection for healthcare insurance data", "BMC Medical Informatics and "
                "Decision Making 25:14", "", "metode", "Makalah acuan awal (tanpa label); di data ini konsensus detektornya tidak lebih baik dari satu "
                "Isolation Forest, sehingga diganti model supervised.")
METHOD = {
    "Regresi logistik": _ref("Cox", 1958, "The Regression Analysis of Binary Sequences", "Journal of the Royal Statistical Society B"),
    "Random Forest": _ref("Breiman", 2001, "Random Forests", "Machine Learning 45", "https://doi.org/10.1023/A:1010933404324"),
    "Extra Trees": _ref("Geurts, Ernst & Wehenkel", 2006, "Extremely randomized trees", "Machine Learning 63", "https://doi.org/10.1007/s10994-006-6226-1"),
    "HistGradientBoosting": _ref("Ke dkk.", 2017, "LightGBM: A Highly Efficient Gradient Boosting Decision Tree", "NeurIPS"),
    "XGBoost": _ref("Chen & Guestrin", 2016, "XGBoost: A Scalable Tree Boosting System", "KDD", "https://doi.org/10.1145/2939672.2939785"),
    "LightGBM": _ref("Ke dkk.", 2017, "LightGBM: A Highly Efficient Gradient Boosting Decision Tree", "NeurIPS"),
    "CatBoost": _ref("Prokhorenkova dkk.", 2018, "CatBoost: unbiased boosting with categorical features", "NeurIPS", "https://arxiv.org/abs/1706.09516"),
    "MLP": _ref("Rumelhart, Hinton & Williams", 1986, "Learning representations by back-propagating errors", "Nature 323"),
    "EBM": _ref("Nori dkk.", 2019, "InterpretML: A Unified Framework for Machine Learning Interpretability", "arXiv", "https://arxiv.org/abs/1909.09223"),
    "Isolation Forest (unsupervised)": _ref("Liu, Ting & Zhou", 2008, "Isolation Forest", "IEEE ICDM", "https://doi.org/10.1109/ICDM.2008.17"),
}
RESEARCH: dict[str, list[dict]] = {
    "Regresi logistik": [R_NABRAWI, METHOD["Regresi logistik"]],
    "Random Forest": [R_BAUDER_RF, R_NABRAWI, R_FARAH, METHOD["Random Forest"]],
    "Extra Trees": [R_BENTEJAC, METHOD["Extra Trees"]],
    "HistGradientBoosting": [R_BENTEJAC, R_HANCOCK_GBDT, METHOD["HistGradientBoosting"]],
    "XGBoost": [R_HANCOCK_CB_XGB, R_SAKIL, R_BENTEJAC, METHOD["XGBoost"]],
    "LightGBM": [R_HANCOCK_GBDT, R_BENTEJAC, METHOD["LightGBM"]],
    "CatBoost": [R_HANCOCK_CB, R_HANCOCK_GBDT, R_HANCOCK_CB_XGB, METHOD["CatBoost"]],
    "MLP": [R_JOHNSON_NN, R_NABRAWI, R_GRINSZTAJN, METHOD["MLP"]],
    "EBM": [R_CARUANA, METHOD["EBM"]],
    "Isolation Forest (unsupervised)": [R_DEMEUL, METHOD["Isolation Forest (unsupervised)"]],
}
EXPLAINER_RESEARCH: dict[str, list[dict]] = {
    "treeshap": [_ref("Lundberg dkk.", 2020, "From local explanations to global understanding with explainable AI for trees", "Nature Machine Intelligence 2",
                      "https://doi.org/10.1038/s42256-019-0138-9"), R_SAKIL, R_LIANG],
    "kernelshap": [_ref("Lundberg & Lee", 2017, "A Unified Approach to Interpreting Model Predictions", "NeurIPS", "https://arxiv.org/abs/1705.07874")],
    "lime": [_ref("Ribeiro, Singh & Guestrin", 2016, "\"Why Should I Trust You?\": Explaining the Predictions of Any Classifier", "KDD",
                  "https://doi.org/10.1145/2939672.2939778")],
    "oklusi": [_ref("Zeiler & Fergus", 2014, "Visualizing and Understanding Convolutional Networks", "ECCV")],
    "ebm": [R_CARUANA, METHOD["EBM"], _ref("Lou, Caruana, Gehrke & Hooker", 2013, "Accurate intelligible models with pairwise interactions", "KDD")],
    "deletion": [_ref("Petsiuk, Das & Saenko", 2018, "RISE: Randomized Input Sampling for Explanation of Black-box Models", "BMVC",
                      "https://arxiv.org/abs/1806.07421")],
}
PROTOCOL_RESEARCH: list[dict] = [
    {"keputusan": "AUPRC sebagai metrik utama (bukan akurasi atau AUC saja)", "rujukan": [R_HANCOCK_AUPRC]},
    {"keputusan": "Ambang keputusan dipilih di set validasi, lalu diterapkan apa adanya pada data uji", "rujukan": [R_JOHNSON_NN]},
    {"keputusan": "Validasi silang 5-lipatan; kelangkaan kelas dilaporkan dan diperhitungkan (bobot sampel)", "rujukan": [R_BAUDER_RF, R_HERLAND]},
    {"keputusan": "Validasi silang diulang (3 x 5 lipatan, bertingkat per kelas, dikelompokkan per faskes); teknik dibandingkan dengan t-test "
                  "resampel terkoreksi, bukan dengan satu angka",
     "rujukan": [_ref("Nadeau & Bengio", 2003, "Inference for the Generalization Error", "Machine Learning 52", "https://doi.org/10.1023/A:1024068626366"),
                 R_HERLAND]},
    {"keputusan": "Undersampling negatif saat melatih diuji dengan ablasi (bisa merugikan AUPRC)", "rujukan": [R_HANCOCK_AUPRC, R_BAUDER_RF]},
    {"keputusan": "Model pohon gradient boosting dibandingkan dengan deep learning (MLP), bukan diasumsikan", "rujukan": [R_GRINSZTAJN, R_BENTEJAC]},
    {"keputusan": "Model tanpa label (Isolation Forest) hanya sebagai pembanding", "rujukan": [R_DEMEUL]},
]

REFERENCES = {"Aturan klinik utama rawat inap": "pembanding: satu aturan (jenis = Klinik Utama dan rawat inap)",
              "Isolation Forest (unsupervised)": "pembanding: tanpa label", "Aturan (flag ganda / LOS ekstrem)": "pembanding: aturan yang ada"}


def signed_log(a: Any) -> Any:
    """Money and counts on a log scale, sign kept (a module-level function: the fitted pipeline is pickled)."""
    return np.sign(a) * np.log1p(np.abs(a))


def _linear_prep() -> Any:
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import FunctionTransformer, OneHotEncoder, StandardScaler

    return ColumnTransformer([
        ("num", make_pipeline(SimpleImputer(strategy="median"), FunctionTransformer(signed_log, feature_names_out="one-to-one"), StandardScaler()), NUM),
        ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=20, sparse_output=True), CAT_LOW),
    ])


def make_model(name: str, seed: int = SEED) -> Any:
    from sklearn.pipeline import make_pipeline

    if name == "Regresi logistik":
        from sklearn.linear_model import LogisticRegression
        return make_pipeline(_linear_prep(), LogisticRegression(C=0.5, max_iter=3000))
    if name == "MLP":
        from sklearn.neural_network import MLPClassifier
        return make_pipeline(_linear_prep(), MLPClassifier(hidden_layer_sizes=(128, 64), alpha=1e-4, early_stopping=True, max_iter=200,
                                                           random_state=seed))
    if name == "Random Forest":
        from sklearn.ensemble import RandomForestClassifier
        return RandomForestClassifier(n_estimators=300, min_samples_leaf=10, max_features="sqrt", n_jobs=-1, random_state=seed)
    if name == "Extra Trees":
        from sklearn.ensemble import ExtraTreesClassifier
        return ExtraTreesClassifier(n_estimators=300, min_samples_leaf=10, max_features="sqrt", n_jobs=-1, random_state=seed)
    if name == "HistGradientBoosting":
        from sklearn.ensemble import HistGradientBoostingClassifier
        return HistGradientBoostingClassifier(max_iter=500, learning_rate=0.05, max_leaf_nodes=31, l2_regularization=1.0, early_stopping=False,
                                              random_state=seed)
    if name == "XGBoost":
        from xgboost import XGBClassifier
        return XGBClassifier(n_estimators=600, learning_rate=0.05, max_depth=6, subsample=0.8, colsample_bytree=0.8, tree_method="hist",
                             eval_metric="aucpr", n_jobs=-1, random_state=seed)
    if name == "LightGBM":
        from lightgbm import LGBMClassifier
        return LGBMClassifier(n_estimators=600, learning_rate=0.05, num_leaves=63, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                              n_jobs=-1, random_state=seed, verbose=-1)
    if name == "CatBoost":
        from catboost import CatBoostClassifier
        return CatBoostClassifier(iterations=600, learning_rate=0.08, depth=6, verbose=0, thread_count=-1, random_seed=seed)
    if name == "EBM":
        from interpret.glassbox import ExplainableBoostingClassifier
        return ExplainableBoostingClassifier(interactions=5, outer_bags=4, max_bins=128, n_jobs=-1, random_state=seed)
    raise ValueError(f"model tidak dikenal: {name}")


def _matrix(name: str, df: pd.DataFrame, enc: Encoder) -> Any:
    """Linear models and the MLP take the raw frame (their pipeline encodes it); the others the coded matrix."""
    return df[enc.columns] if name in ("Regresi logistik", "MLP") else enc.transform(df)


def fit_predict(name: str, train: pd.DataFrame, others: list[pd.DataFrame], enc: Encoder, seed: int = SEED) -> tuple[Any, list[np.ndarray], float]:
    """Fit `name` on `train` (labels y), return the model, its scores for each frame in `others`, and the fit time."""
    t = time.time()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if name == "Isolation Forest (unsupervised)":
            from sklearn.ensemble import IsolationForest
            m = IsolationForest(n_estimators=300, random_state=seed, n_jobs=-1).fit(enc.transform(train).fillna(-1))
            return m, [-m.score_samples(enc.transform(o).fillna(-1)) for o in others], time.time() - t
        if name == "Aturan (flag ganda / LOS ekstrem)":
            return None, [(o["flag_ganda"] + o["flag_los_ekstrem"]).to_numpy(float) for o in others], 0.0
        if name == "Aturan klinik utama rawat inap":
            return None, [((o["jenis_fkrtl"] == "Klinik Utama") & (o["tingkat_pelayanan"] == "RITL")).to_numpy(float) for o in others], 0.0
        m = make_model(name, seed)
        m.fit(_matrix(name, train, enc), train["y"].to_numpy())
        return m, [m.predict_proba(_matrix(name, o, enc))[:, 1] for o in others], time.time() - t


# ------------------------------------------------------------------------------------------------
# metrics (weighted: the evaluation set stands for every claim)
# ------------------------------------------------------------------------------------------------


def threshold_max_f1(y: np.ndarray, s: np.ndarray, w: np.ndarray) -> float:
    order = np.argsort(-s)
    ys, ws, ss = y[order], w[order], s[order]
    tp = np.cumsum(ws * ys)
    fp = np.cumsum(ws * (1 - ys))
    pos = (w * y).sum()
    prec, rec = tp / np.maximum(tp + fp, 1e-12), tp / max(pos, 1e-12)
    f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-12)
    # only where the next score differs: a threshold separates distinct scores
    cut = np.r_[ss[1:] != ss[:-1], True]
    i = int(np.argmax(np.where(cut, f1, -1)))
    return float(ss[i])


def metrics(y: np.ndarray, s: np.ndarray, w: np.ndarray, thr: Optional[float] = None) -> dict[str, float]:
    from sklearn.metrics import average_precision_score, roc_auc_score

    out = {"auroc": float(roc_auc_score(y, s, sample_weight=w)), "auprc": float(average_precision_score(y, s, sample_weight=w))}
    prev = float((w * y).sum() / w.sum())
    out["prevalensi"] = prev
    order = np.argsort(-s)
    cw = np.cumsum(w[order])
    for frac, key in ((0.001, "0_1pct"), (0.01, "1pct")):
        top = order[: int(np.searchsorted(cw, frac * w.sum())) + 1]
        p = float((w[top] * y[top]).sum() / w[top].sum())
        out[f"presisi_top_{key}"] = p
        out[f"recall_top_{key}"] = float((w[top] * y[top]).sum() / (w * y).sum())
        out[f"lift_top_{key}"] = p / prev if prev else float("nan")
    if thr is not None:
        pred = s >= thr
        tp, fp = float((w * (pred & (y == 1))).sum()), float((w * (pred & (y == 0))).sum())
        fn, tn = float((w * (~pred & (y == 1))).sum()), float((w * (~pred & (y == 0))).sum())
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        out.update({"presisi": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0, "akurasi": (tp + tn) / (tp + fp + fn + tn),
                    "akurasi_seimbang": (r + tn / (tn + fp)) / 2 if tn + fp else r / 2, "ditandai_per_1jt": 1e6 * (tp + fp) / (tp + fp + fn + tn)})
    return out


def calibration(y: np.ndarray, p: np.ndarray, w: np.ndarray, bins: int = 10) -> dict[str, float]:
    """Whether the probabilities are probabilities, out of fold and weighted to the population: the corrections seen
    over those the scores expect (kalibrasi_ae, 1 = calibrated in the large: the facility table's ekspektasi_koreksi is
    their sum), the Brier score, and the expected calibration error over `bins` bins of equal weight (2026-10-29: the
    benchmark ranked models but never said whether ekspektasi_koreksi could be read as an expectation)."""
    p = np.clip(np.asarray(p, float), 0.0, 1.0)
    e = float((w * p).sum())
    order = np.argsort(p)
    cw = np.cumsum(w[order]) / w.sum()
    ece = 0.0
    for b in np.array_split(order, [int(np.searchsorted(cw, q)) for q in np.linspace(0, 1, bins + 1)[1:-1]]):
        if len(b):
            wb = w[b].sum()
            ece += wb / w.sum() * abs(float((w[b] * y[b]).sum() / wb) - float((w[b] * p[b]).sum() / wb))
    return {"kalibrasi_ae": float((w * y).sum() / e) if e else float("nan"), "brier": float((w * (p - y) ** 2).sum() / w.sum()), "ece": float(ece)}


# ------------------------------------------------------------------------------------------------
# benchmark
# ------------------------------------------------------------------------------------------------


def _train_part(df: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    """All positives and TRAIN_NEG of the negatives (unweighted: the ranking is learnt on a less extreme balance)."""
    neg = df[df["y"] == 0]
    return pd.concat([df[df["y"] == 1], neg.sample(frac=TRAIN_NEG, random_state=int(rng.integers(1 << 30)))])


def bootstrap_ci(y: np.ndarray, s: np.ndarray, w: np.ndarray, groups: np.ndarray, n: int = 100, seed: int = SEED) -> dict[str, list[float]]:
    """95 % intervals of the pooled metrics, resampling whole facilities (claims of one facility move together)."""
    # a resample of facilities is the same claims reweighted by how often their facility was drawn: one sort serves all
    rng = np.random.default_rng(seed)
    codes, inv = np.unique(groups, return_inverse=True)
    order = np.argsort(-s, kind="stable")
    ys, ws, gs = y[order].astype(float), w[order].astype(float), inv[order]
    out: dict[str, list[float]] = {k: [] for k in ("auroc", "auprc", "presisi_top_0_1pct", "lift_top_0_1pct", "recall_top_1pct")}
    for _ in range(n):
        wb = ws * np.bincount(rng.integers(0, len(codes), len(codes)), minlength=len(codes))[gs]
        tp, fp = np.cumsum(wb * ys), np.cumsum(wb * (1 - ys))
        P, N = tp[-1], fp[-1]
        if P <= 0 or N <= 0:
            continue
        prec = tp / np.maximum(tp + fp, 1e-12)
        fpr, tpr = np.r_[0, fp / N], np.r_[0, tp / P]
        out["auroc"].append(float(np.sum(np.diff(fpr) * (tpr[1:] + tpr[:-1]) / 2)))
        out["auprc"].append(float(np.sum(prec * wb * ys) / P))
        cw, W = np.cumsum(wb), wb.sum()
        prev = P / W
        for frac, key in ((0.001, "0_1pct"), (0.01, "1pct")):
            i = int(np.searchsorted(cw, frac * W))
            p_top = tp[i] / max(cw[i], 1e-12)
            if key == "0_1pct":
                out["presisi_top_0_1pct"].append(float(p_top))
                out["lift_top_0_1pct"].append(float(p_top / prev))
            else:
                out["recall_top_1pct"].append(float(tp[i] / P))
    return {k: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] for k, v in out.items() if v}


def corrected_ttest(diffs: list[float], n_train: int, n_test: int) -> tuple[float, float]:
    """The corrected resampled t-test (Nadeau and Bengio 2003) on paired per-fold differences: the folds of a repeated
    cross-validation overlap in their training data, so the plain t-test is too confident. Returns (t, two-sided p)."""
    from scipy.stats import t as tdist

    d = np.asarray(diffs, float)
    k = len(d)
    if k < 2 or np.isclose(d.var(ddof=1), 0):
        return (float("inf") if d.mean() > 0 else 0.0), (0.0 if d.mean() > 0 else 1.0)
    t = d.mean() / np.sqrt((1 / k + n_test / n_train) * d.var(ddof=1))
    return float(t), float(2 * tdist.sf(abs(t), k - 1))


def benchmark(data: pd.DataFrame, models: Optional[list[str]] = None, folds: int = 5, log: Callable[[str], None] = print,
              references: Optional[list[str]] = None, repeats: int = 1) -> dict[str, Any]:
    """Repeated cross-validation of every model (see the module docstring): `repeats` x `folds` splits, each grouped by
    faskes profile and stratified so every fold gets its share of the rare corrected claims, reshuffled per repeat.
    Returns per-model fold metrics, their mean and spread over all splits, the pooled out-of-fold metrics of the first
    repeat (with facility-bootstrap intervals), how often each model ranked first, a corrected paired t-test of the
    best model against each other, fit times, and the first repeat's out-of-fold scores."""
    from sklearn.model_selection import GroupShuffleSplit, StratifiedGroupKFold

    names = list(models or MODELS) + list(references if references is not None else REFERENCES)
    t0 = time.time()
    groups = data["faskes_profil_id"].to_numpy()
    oof = {n: np.full(len(data), np.nan) for n in names}
    per_fold: dict[str, list[dict]] = {n: [] for n in names}
    secs: dict[str, list[float]] = {n: [] for n in names}
    sizes: list[tuple[int, int]] = []
    for r in range(repeats):
        rng = np.random.default_rng(SEED + r)
        splitter = StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=SEED + r)
        for f, (tr, te) in enumerate(splitter.split(data, data["y"], groups)):
            part = data.iloc[tr]
            inner_tr, inner_val = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=100 * r + f).split(part, part["y"], part["faskes_profil_id"]))
            fit_df = _train_part(part.iloc[inner_tr], rng)
            val, test = part.iloc[inner_val], data.iloc[te]
            sizes.append((len(tr), len(te)))
            enc = Encoder().fit(fit_df)
            for n in names:
                try:
                    _, (s_val, s_test), sec = fit_predict(n, fit_df, [val, test], enc, seed=SEED + r)
                except Exception as e:  # noqa: BLE001 - a model that fails is reported, the benchmark goes on
                    log(f"ulangan {r + 1} lipatan {f + 1}: {n} gagal: {type(e).__name__}: {str(e)[:200]}")
                    continue
                thr = threshold_max_f1(val["y"].to_numpy(), s_val, val["w"].to_numpy())
                m = metrics(test["y"].to_numpy(), s_test, test["w"].to_numpy(), thr)
                if n not in REFERENCES:  # a model's probabilities, on the population's scale as deployed (predict)
                    m.update(calibration(test["y"].to_numpy(), prior_correct(s_test, TRAIN_NEG / NEG_SAMPLE), test["w"].to_numpy()))
                per_fold[n].append({"ulangan": r + 1, "lipatan": f + 1, **m, "detik_latih": round(sec, 1), "positif_uji": int(test["y"].sum())})
                secs[n].append(sec)
                if r == 0:
                    # out-of-fold scores, as ranks within the fold (folds' models are not on one scale)
                    oof[n][te] = pd.Series(s_test).rank(pct=True).to_numpy()
            done = [n for n in names if per_fold[n] and (per_fold[n][-1]["ulangan"], per_fold[n][-1]["lipatan"]) == (r + 1, f + 1)]
            log(f"ulangan {r + 1}/{repeats} lipatan {f + 1}/{folds} selesai: {len(test):,} klaim uji ({int(test['y'].sum())} terkoreksi), "
                f"{time.time() - t0:.0f} s; " + ", ".join(f"{n.split(' (')[0]} {per_fold[n][-1]['auprc']:.3f}" for n in done))
    y, w = data["y"].to_numpy(), data["w"].to_numpy()
    # how often each technique was the best of a split (reference rows excluded)
    split_keys = sorted({(x["ulangan"], x["lipatan"]) for n in names for x in per_fold[n]})
    auprc = {n: {(x["ulangan"], x["lipatan"]): x["auprc"] for x in per_fold[n]} for n in names}
    wins = {n: 0 for n in names}
    for key in split_keys:
        cands = [n for n in names if n not in REFERENCES and key in auprc[n]]
        if cands:
            wins[max(cands, key=lambda n: auprc[n][key])] += 1
    board = []
    for n in names:
        if not per_fold[n]:
            continue
        keys = [k for k in per_fold[n][0] if k not in ("lipatan", "ulangan")]
        agg = {k: {"mean": float(np.mean([x[k] for x in per_fold[n]])), "sd": float(np.std([x[k] for x in per_fold[n]], ddof=1))
                   if len(per_fold[n]) > 1 else 0.0} for k in keys}
        ok = ~np.isnan(oof[n])
        pooled = metrics(y[ok], oof[n][ok], w[ok])
        pooled["ci95"] = bootstrap_ci(y[ok], oof[n][ok], w[ok], groups[ok])
        board.append({"model": n, "keluarga": (MODELS.get(n) or ("pembanding",))[0], "rujukan": (MODELS.get(n) or (None, REFERENCES.get(n)))[1],
                      "pembanding": n in REFERENCES, "lipatan": per_fold[n], "rata": agg, "gabungan_oof": pooled,
                      "menang": wins[n], "dari": len(split_keys),
                      "detik_latih": float(np.mean(secs[n])) if secs[n] else 0.0, "riset": RESEARCH.get(n, [])})
    board.sort(key=lambda b: -b["rata"]["auprc"]["mean"])
    best = next((b for b in board if not b["pembanding"]), None)
    n_train = int(np.mean([a for a, _ in sizes])) if sizes else 1
    n_test = int(np.mean([b for _, b in sizes])) if sizes else 1
    for b in board:
        if best is None or b is best:
            continue
        common = [k for k in split_keys if k in auprc[best["model"]] and k in auprc[b["model"]]]
        diffs = [auprc[best["model"]][k] - auprc[b["model"]][k] for k in common]
        t, pval = corrected_ttest(diffs, n_train, n_test)
        b["uji_vs_terbaik"] = {"selisih_auprc": float(np.mean(diffs)) if diffs else None, "t": t, "p": pval,
                               "berbeda_nyata": bool(pval < 0.05), "pasangan": len(common)}
    return {"papan": board, "lipatan": folds, "ulangan": repeats, "evaluasi": {"klaim": len(data), "positif": int(y.sum()), "bobot_negatif": NEG_SAMPLE,
                                                                               "latih_negatif": TRAIN_NEG}, "detik": round(time.time() - t0, 1),
            "uji": "t-test resampel terkoreksi (Nadeau dan Bengio 2003) atas AUPRC berpasangan per lipatan", "oof": {n: v for n, v in oof.items()}}


def facility_folds(con: Any, folds: int = 5, seed: int = SEED) -> dict[str, int]:
    """Every facility profile in one of `folds` folds, the corrected claims spread evenly: facilities sorted by their
    corrections (random order among equals) and dealt round-robin. The seed's draws go to the facilities in id order: a
    GROUP BY returns its rows in no fixed order, so without ORDER BY the same seed dealt other folds on every call."""
    f = con.execute("SELECT faskes_profil_id, sum(y) AS pos, count(*) AS n FROM fitur GROUP BY 1 ORDER BY 1").df()
    f["r"] = np.random.default_rng(seed).random(len(f))
    f = f.sort_values(["pos", "r"], ascending=[False, True]).reset_index(drop=True)
    return dict(zip(f["faskes_profil_id"], np.arange(len(f)) % folds))


def oof_population(con: Any, segments: dict[str, dict], folds: int = 5, seed: int = SEED, log: Callable[[str], None] = print) -> pd.DataFrame:
    """Every claim of the population scored by a model that never saw its facility, at the real correction rate (no
    balancing): per fold of facilities, each segment's model ({"task", "name", "neg_share"}) is fit on the other
    facilities' claims of its task's evaluation sample and scores every claim of the held-out facilities in its segment.
    Returns one row per claim: klaim_id, faskes_profil_id, segmen_model, score (probability on the population's
    scale), y, excess_rp and the descriptive columns the evaluation reports by."""
    global TRAIN_NEG
    fold_of = facility_folds(con, folds, seed)
    values = ", ".join(f"('{k}', {v})" for k, v in fold_of.items())
    con.execute(f"CREATE OR REPLACE TEMP TABLE lipatan AS SELECT * FROM (VALUES {values}) t(faskes_profil_id, lipatan)")
    data = {task: evaluation_set(con, task) for task in {s["task"] for s in segments.values()}}
    for d in data.values():
        d["lipatan"] = d["faskes_profil_id"].map(fold_of)
    keep = ["klaim_id", "faskes_profil_id", "y", "excess_rp", "tingkat_pelayanan", "jenis_fkrtl", "tipe_fkrtl", "provinsi_kode", "provinsi_nama",
            "edisi", "inacbg_kode", "dx_primer_icd3", "biaya_tagih", "frek_dx", "f_jumlah_klaim", "flag_ganda", "flag_los_ekstrem"]
    cols = list(dict.fromkeys(keep + FEATURES))
    out = []
    t0 = time.time()
    for seg, cfg in segments.items():
        sql = SEGMENTS[seg][1]
        for f in range(folds):
            d = data[cfg["task"]]
            old, TRAIN_NEG = TRAIN_NEG, cfg.get("neg_share", TRAIN_NEG)
            try:
                train = _train_part(d[d["lipatan"] != f], np.random.default_rng(seed + f))
            finally:
                TRAIN_NEG = old
            enc = Encoder().fit(train)
            model, _, _ = fit_predict(cfg["name"], train, [], enc, seed)
            m = {"model": model, "enc": enc, "name": cfg["name"], "beta": cfg.get("neg_share", TRAIN_NEG) / NEG_SAMPLE}
            reader = con.execute(f"SELECT {', '.join(cols)} FROM fitur JOIN lipatan USING (faskes_profil_id) "
                                 f"WHERE lipatan = {f} AND ({sql})").to_arrow_reader(500_000)
            for batch in reader:
                df = batch.to_pandas()
                df["score"] = predict(m, df)
                df["segmen_model"] = seg
                out.append(df[keep + ["score", "segmen_model"]])
            log(f"oof {seg} lipatan {f + 1}/{folds}: {cfg['name']} dilatih {len(train):,} baris ({int(train['y'].sum())} terkoreksi), "
                f"{time.time() - t0:.0f} s")
    # in claim order: the batches arrive in no fixed order, and a top-k among equal scores follows the input's order
    return pd.concat(out, ignore_index=True).sort_values("klaim_id", kind="mergesort", ignore_index=True)


def ablation_undersampling(data: pd.DataFrame, name: str, shares: tuple[float, ...] = (0.3, 1.0), folds: int = 3,
                           log: Callable[[str], None] = print) -> list[dict]:
    """The chosen model trained on different shares of the sampled negatives (random undersampling vs none), same grouped
    folds and thresholds as the benchmark: Hancock et al. (2023) found undersampling hurts AUPRC on Medicare data."""
    from sklearn.model_selection import GroupKFold, GroupShuffleSplit

    global TRAIN_NEG
    keep = TRAIN_NEG
    out = []
    try:
        for share in shares:
            TRAIN_NEG = share
            rng = np.random.default_rng(SEED)
            rows = []
            for f, (tr, te) in enumerate(GroupKFold(n_splits=folds).split(data, data["y"], data["faskes_profil_id"])):
                part = data.iloc[tr]
                itr, ival = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=f).split(part, part["y"], part["faskes_profil_id"]))
                fit_df = _train_part(part.iloc[itr], rng)
                enc = Encoder().fit(fit_df)
                _, (s_val, s_test), sec = fit_predict(name, fit_df, [part.iloc[ival], data.iloc[te]], enc)
                thr = threshold_max_f1(part.iloc[ival]["y"].to_numpy(), s_val, part.iloc[ival]["w"].to_numpy())
                rows.append({**metrics(data.iloc[te]["y"].to_numpy(), s_test, data.iloc[te]["w"].to_numpy(), thr), "detik": sec, "baris_latih": len(fit_df)})
            res = {"porsi_negatif_latih": share, "porsi_semua_negatif": share / NEG_SAMPLE,
                   **{k: float(np.mean([r[k] for r in rows])) for k in ("auprc", "auroc", "f1", "presisi", "recall", "detik", "baris_latih")}}
            out.append(res)
            log(f"ablasi undersampling {name}: negatif {share:.0%} dari sampel → AUPRC {res['auprc']:.3f}, F1 {res['f1']:.3f}")
    finally:
        TRAIN_NEG = keep
    return out


def temporal_check(data: pd.DataFrame, models: list[str], log: Callable[[str], None] = print) -> dict[str, Any]:
    """Train on the earlier 80 % of claims (by date), choose the threshold on the last 20 % of that, test on the latest 20 %."""
    d = data.sort_values("tgl_datang")
    cut, cut_val = d["tgl_datang"].quantile(0.8), d["tgl_datang"].quantile(0.64)
    train, val, test = d[d["tgl_datang"] < cut_val], d[(d["tgl_datang"] >= cut_val) & (d["tgl_datang"] < cut)], d[d["tgl_datang"] >= cut]
    rng = np.random.default_rng(SEED + 1)
    fit_df = _train_part(train, rng)
    enc = Encoder().fit(fit_df)
    out = {"batas_uji": str(pd.Timestamp(cut).date()), "positif_uji": int(test["y"].sum()), "model": {}}
    for n in models:
        _, (s_val, s_test), _ = fit_predict(n, fit_df, [val, test], enc)
        thr = threshold_max_f1(val["y"].to_numpy(), s_val, val["w"].to_numpy())
        out["model"][n] = metrics(test["y"].to_numpy(), s_test, test["w"].to_numpy(), thr)
        log(f"temporal {n}: AUPRC {out['model'][n]['auprc']:.3f}, F1 {out['model'][n]['f1']:.3f}")
    return out


# ------------------------------------------------------------------------------------------------
# explanations
# ------------------------------------------------------------------------------------------------

EXPLAINERS: dict[str, str] = {
    "treeshap": "TreeSHAP (Lundberg dkk. 2020): nilai Shapley eksak untuk model pohon",
    "kernelshap": "KernelSHAP (Lundberg & Lee 2017): Shapley model-agnostik dari sampel koalisi",
    "lime": "LIME (Ribeiro dkk. 2016): regresi linear lokal tertimbang atas fitur yang diganti nilai acuan",
    "oklusi": "Oklusi: turunnya risiko bila satu fitur diganti nilai acuan",
    "ebm": "Suku EBM: kontribusi tiap fitur langsung dari model glassbox",
}


class Explainer:
    """Local explanations of one fitted model on the coded matrix: each method gives one attribution per feature."""

    def __init__(self, name: str, model: Any, enc: Encoder, background: pd.DataFrame, seed: int = SEED, typical: Optional[dict] = None):
        self.name, self.model, self.enc = name, model, enc
        Xb = enc.transform(background)
        self.columns = list(Xb.columns)
        self.seed = seed
        if typical:
            # the segment's typical uncorrected claim (fit_final): the reference every attribution is measured from
            row = pd.DataFrame([{c: typical.get(c) for c in enc.columns}])
            self.base = enc.transform(row).to_numpy(float)[0]
            self.bg = self.base[None, :]
            return
        # the reference profile: the median claim (numbers) and the commonest category
        self.base = Xb.median().to_numpy(float)
        for j, c in enumerate(Xb.columns):
            if c in enc.maps:
                self.base[j] = float(Xb[c].mode().iloc[0])
        self.bg = Xb.sample(n=min(len(Xb), 200), random_state=seed).to_numpy(float)

    def proba(self, X: np.ndarray) -> np.ndarray:
        if self.name in ("Regresi logistik", "MLP"):
            raise ValueError("penjelasan memakai matriks berkode; model linear/MLP memakai pipeline-nya sendiri")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return self.model.predict_proba(pd.DataFrame(X, columns=self.columns).astype("float32"))[:, 1]

    def treeshap(self, x: np.ndarray, **_: Any) -> np.ndarray:
        import shap

        e = shap.TreeExplainer(self.model)
        v = e.shap_values(pd.DataFrame(x[None, :], columns=self.columns).astype("float32"))
        v = v[1] if isinstance(v, list) else v
        v = np.asarray(v)
        return (v[0, :, 1] if v.ndim == 3 else v[0]).astype(float)

    def kernelshap(self, x: np.ndarray, seed: int = 0, samples: int = 300, **_: Any) -> np.ndarray:
        import shap

        np.random.seed(seed)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            e = shap.KernelExplainer(self.proba, shap.kmeans(self.bg, 10) if len(self.bg) > 10 else self.bg)
            return np.asarray(e.shap_values(x[None, :], nsamples=samples, silent=True)).reshape(-1).astype(float)

    def lime(self, x: np.ndarray, seed: int = 0, samples: int = 1000, **_: Any) -> np.ndarray:
        """LIME's tabular procedure on a binary representation: each sample replaces a random subset of the features
        with the reference profile's; samples weighted by an exponential kernel on their distance (width 0.75·√d);
        the attribution is a weighted ridge regression's coefficient."""
        from sklearn.linear_model import Ridge

        rng = np.random.default_rng(seed)
        d = len(x)
        Zm = (rng.random((samples, d)) < 0.7).astype(float)
        Zm[0] = 1
        X = np.where(Zm == 1, x[None, :], self.base[None, :])
        y = self.proba(X)
        dist = np.sqrt(((1 - Zm) ** 2).sum(axis=1))
        w = np.exp(-(dist ** 2) / (0.75 * math.sqrt(d)) ** 2)
        return Ridge(alpha=1.0).fit(Zm, y, sample_weight=w).coef_.astype(float)

    def oklusi(self, x: np.ndarray, **_: Any) -> np.ndarray:
        X = np.repeat(x[None, :], len(x) + 1, axis=0)
        X[np.arange(1, len(x) + 1), np.arange(len(x))] = self.base
        p = self.proba(X)
        return p[0] - p[1:]

    def ebm(self, x: np.ndarray, **_: Any) -> np.ndarray:
        e = self.model.explain_local(pd.DataFrame(x[None, :], columns=self.columns).astype("float32"))
        data = e.data(0)
        by = dict(zip(data["names"], data["scores"]))
        # the EBM's terms are features and pairs; a pair's score is split between its two features
        out = np.zeros(len(self.columns))
        for term, sc in by.items():
            parts = [p.strip() for p in str(term).split(" & ")]
            for p in parts:
                if p in self.columns:
                    out[self.columns.index(p)] += float(sc) / len(parts)
        return out

    def attribute(self, method: str, x: np.ndarray, seed: int = 0) -> np.ndarray:
        return getattr(self, method)(x, seed=seed)

    def deletion(self, x: np.ndarray, phi: np.ndarray, k: int = 8) -> float:
        """The deletion curve's area: the risk left as the top-k features (by this attribution) are reset to the
        reference one by one, relative to the claim's own risk. Lower = the attribution found what drives the risk."""
        order = np.argsort(-phi)[:k]
        X = np.repeat(x[None, :], k + 1, axis=0)
        for i in range(1, k + 1):
            X[i:, order[i - 1]] = self.base[order[i - 1]]
        p = self.proba(X)
        return float(np.mean(p[1:]) / max(p[0], 1e-12))


def explainer_benchmark(name: str, model: Any, enc: Encoder, train: pd.DataFrame, cases: pd.DataFrame, methods: Optional[list[str]] = None,
                        log: Callable[[str], None] = print) -> dict[str, Any]:
    """Each method on the same claims: faithfulness (deletion curve area, lower is better; a random order as the
    floor), stability (Spearman between two seeds, for the sampling methods), agreement with TreeSHAP, and time."""
    from scipy.stats import spearmanr

    ex = Explainer(name, model, enc, train)
    methods = methods or [m for m in EXPLAINERS if (m != "ebm" or name == "EBM") and (m != "treeshap" or name != "EBM")]
    X = enc.transform(cases).to_numpy(float)
    rng = np.random.default_rng(SEED)
    res: dict[str, dict[str, list[float]]] = {m: {"deletion": [], "detik": [], "stabil": [], "setuju": []} for m in methods}
    res["acak"] = {"deletion": [], "detik": [], "stabil": [], "setuju": []}
    for i, x in enumerate(X):
        ref = None
        for m in methods:
            t = time.time()
            try:
                phi = ex.attribute(m, x, seed=0)
            except Exception as e:  # noqa: BLE001
                log(f"penjelas {m} gagal: {type(e).__name__}: {str(e)[:160]}")
                continue
            res[m]["detik"].append(time.time() - t)
            res[m]["deletion"].append(ex.deletion(x, phi))
            if m in ("kernelshap", "lime") and i < 10:
                res[m]["stabil"].append(float(spearmanr(phi, ex.attribute(m, x, seed=1)).correlation))
            if m == "treeshap":
                ref = phi
            elif ref is not None:
                res[m]["setuju"].append(float(spearmanr(phi, ref).correlation))
        res["acak"]["deletion"].append(ex.deletion(x, rng.random(len(x))))
    out = []
    for m, r in res.items():
        if not r["deletion"]:
            continue
        out.append({"metode": m, "keterangan": EXPLAINERS.get(m, "urutan acak (lantai pembanding)"),
                    "deletion_auc": float(np.mean(r["deletion"])), "detik_per_klaim": float(np.mean(r["detik"])) if r["detik"] else 0.0,
                    "stabilitas": float(np.mean(r["stabil"])) if r["stabil"] else None,
                    "kesepakatan_treeshap": float(np.mean(r["setuju"])) if r["setuju"] else None, "klaim": len(r["deletion"]),
                    "riset": EXPLAINER_RESEARCH.get(m, [])})
    out.sort(key=lambda r: r["deletion_auc"])
    return {"model": name, "metode": out, "metrik_rujukan": EXPLAINER_RESEARCH["deletion"]}


def global_importance(name: str, model: Any, enc: Encoder, data: pd.DataFrame, top: int = 15) -> list[dict]:
    """Permutation importance (the drop in weighted AUPRC when a feature is shuffled) on held-out claims."""
    from sklearn.metrics import average_precision_score

    X = enc.transform(data)
    y, w = data["y"].to_numpy(), data["w"].to_numpy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        base = average_precision_score(y, model.predict_proba(X)[:, 1], sample_weight=w)
        rng = np.random.default_rng(SEED)
        out = []
        for c in X.columns:
            Xp = X.copy()
            Xp[c] = rng.permutation(Xp[c].to_numpy())
            out.append({"fitur": c, "label": LABELS.get(c, c), "penurunan_auprc": float(base - average_precision_score(y, model.predict_proba(Xp)[:, 1], sample_weight=w))})
    out.sort(key=lambda r: -r["penurunan_auprc"])
    return out[:top]


# ------------------------------------------------------------------------------------------------
# the deployed model: one per segment, probabilities on the population's scale, reasons in words
# ------------------------------------------------------------------------------------------------

BETA = TRAIN_NEG / NEG_SAMPLE  # the share of uncorrected claims a model trains on (3 %)
# segment → (the task whose benchmark chose its model, which claims it scores)
SEGMENTS = {"rumah_sakit": ("rumah_sakit", "jenis_fkrtl = 'Rumah sakit'"), "klinik_utama": ("semua", "jenis_fkrtl <> 'Rumah sakit'")}
MONEY = {"biaya_tagih", "tarif_inacbg", "tarif_tambahan", "selisih_tagih_tarif"}
RATIO = {"rasio_tagih_tarif", "idx_los", "idx_tarif_kode", "f_idx_los", "f_idx_tarif_kode"}
SHARE = {"p_berat_dx", "p_prosedur_dx"} | {c for c in NUM_ALL if c.startswith("f_pct_")} | {"f_hhi_inacbg", "f_hhi_dx"}


def prior_correct(p: np.ndarray, beta: float = BETA) -> np.ndarray:
    """A model trained on a share `beta` of the negatives over-states the risk; this puts it back on the population's
    scale (odds × beta)."""
    p = np.clip(np.asarray(p, float), 1e-9, 1 - 1e-9)
    return beta * p / (beta * p + 1 - p)


def fit_final(con: Any, task: str, name: str, seed: int = SEED, neg_share: float = TRAIN_NEG) -> dict[str, Any]:
    """The deployed model: `name` fit on the task's positives and `neg_share` of its sampled negatives (the share the
    undersampling ablation found better), its probabilities put back on the population's scale."""
    global TRAIN_NEG
    data = evaluation_set(con, task)
    keep, TRAIN_NEG = TRAIN_NEG, neg_share
    try:
        train = _train_part(data, np.random.default_rng(seed))
    finally:
        TRAIN_NEG = keep
    enc = Encoder().fit(train)
    model, _, sec = fit_predict(name, train, [], enc, seed)
    typical = train[train["y"] == 0][NUM].median(numeric_only=True).to_dict()
    typical.update({c: train.loc[train["y"] == 0, c].mode().iloc[0] for c in CAT_LOW})
    return {"model": model, "enc": enc, "name": name, "task": task, "beta": neg_share / NEG_SAMPLE, "neg_share": neg_share, "typical": typical,
            "fit_seconds": round(sec, 1), "train_rows": len(train), "train_positives": int(train["y"].sum())}


def predict(seg: dict, df: pd.DataFrame) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        raw = seg["model"].predict_proba(_matrix(seg["name"], df, seg["enc"]))[:, 1]
    return prior_correct(raw, seg["beta"])


def _value(col: str, v: Any, enc: Encoder) -> str:
    if col in enc.maps:
        if isinstance(v, str):
            return v
        inv = {i: k for k, i in enc.maps[col].items()}
        return str(inv.get(int(v), "lainnya")) if v == v else "—"
    if v is None or v != v:
        return "—"
    v = float(v)
    if col in MONEY:
        return f"Rp {v / 1e6:,.1f} jt".replace(",", "#").replace(".", ",").replace("#", ".") if abs(v) >= 1e6 else f"Rp {v:,.0f}".replace(",", ".")
    if col in RATIO:
        return f"{v:.2f}×".replace(".", ",")
    if col in SHARE:
        return f"{100 * v:.1f}%".replace(".", ",")
    return f"{v:,.0f}".replace(",", ".") if abs(v) >= 100 or v.is_integer() else f"{v:.2f}".replace(".", ",")


def contributions(seg: dict, df: pd.DataFrame) -> np.ndarray:
    """Per-claim, per-feature contributions to the risk (log-odds): TreeSHAP for tree models, the EBM's own terms, else
    occlusion on the coded matrix."""
    X = seg["enc"].transform(df)
    if seg["name"] == "EBM":
        ex = Explainer("EBM", seg["model"], seg["enc"], df.head(50))
        return np.vstack([ex.ebm(x) for x in X.to_numpy(float)])
    if seg["name"] in ("Regresi logistik", "MLP"):
        # occlusion on the raw frame (their pipeline encodes it): the risk lost when a feature takes its typical value
        p0 = predict(seg, df)
        out = np.zeros((len(df), len(X.columns)))
        for j, col in enumerate(X.columns):
            alt = df.copy()
            alt[col] = seg["typical"].get(col)
            out[:, j] = p0 - predict(seg, alt)
        return out
    import shap

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        v = shap.TreeExplainer(seg["model"]).shap_values(X)
    v = v[1] if isinstance(v, list) else np.asarray(v)
    return v[:, :, 1] if v.ndim == 3 else v


def reasons(seg: dict, df: pd.DataFrame, top: int = 3) -> list[list[dict]]:
    """For each claim, the features that raised its risk most, with the claim's value and the typical one."""
    phi = contributions(seg, df)
    X = seg["enc"].transform(df)
    cols = list(X.columns)
    out = []
    for i in range(len(df)):
        order = [j for j in np.argsort(-phi[i]) if phi[i, j] > 0][:top]
        items = []
        for j in order:
            c = cols[j]
            typ = seg["typical"].get(c)
            items.append({"fitur": c, "label": LABELS.get(c, c), "nilai": _value(c, X.iloc[i, j], seg["enc"]),
                          "umumnya": _value(c, typ, seg["enc"]) if typ is not None and c not in seg["enc"].maps else None,
                          "kontribusi": round(float(phi[i, j]), 4)})
        out.append(items)
    return out


def reason_text(items: list[dict]) -> str:
    return " · ".join(f"{r['label']}: {r['nilai']}" + (f" (umumnya {r['umumnya']})" if r.get("umumnya") else "") for r in items)


def _pyfunc_class() -> type:
    from mlflow.pyfunc import PythonModel

    class RisikoKlaimModel(PythonModel):
        """The risk that the BPJS verifier corrects an FKRTL claim: a supervised model per segment (hospitals; Klinik
        Utama), its probability on the population's scale. Input: claims with the feature columns (ml_klaim.FEATURES)
        and jenis_fkrtl."""

        def __init__(self, segments: dict):
            self.segments = segments

        def predict(self, context, model_input: pd.DataFrame, params: Optional[dict] = None) -> pd.DataFrame:  # noqa: ANN001
            df = model_input.reset_index(drop=True)
            out = pd.DataFrame({"risiko": np.zeros(len(df)), "segmen_model": ""})
            for name, seg in self.segments.items():
                m = (df["jenis_fkrtl"] == "Rumah sakit") == (name == "rumah_sakit")
                if m.any():
                    out.loc[m, "risiko"] = predict(seg, df[m])
                    out.loc[m, "segmen_model"] = name
            out["ditandai"] = [r >= self.segments[s]["threshold"] if s else False for r, s in zip(out["risiko"], out["segmen_model"])]
            return out

    RisikoKlaimModel.__module__ = __name__
    RisikoKlaimModel.__qualname__ = "RisikoKlaimModel"
    return RisikoKlaimModel


def __getattr__(name: str) -> Any:
    """RisikoKlaimModel is made on first use: the engine never loads MLflow, while pickles of the published model still
    find the class here by name."""
    if name == "RisikoKlaimModel":
        globals()[name] = _pyfunc_class()
        return globals()[name]
    raise AttributeError(name)
