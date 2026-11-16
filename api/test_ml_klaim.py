"""The supervised claim-risk engine (ml_klaim.py) and the ML screens: the math the reported numbers rest on.

The weighted metrics must equal the metrics of the population the evaluation sample stands for (every negative kept
1-in-NEG_SAMPLE and weighted back), the threshold must be the one that maximises F1, the prior correction must undo the
negatives' undersampling, the bootstrap must bracket the point estimate, and every technique must carry its research.
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ml_klaim as M  # noqa: E402
from aip.adk_runtime import screens as S  # noqa: E402


def _population(seed: int = 3, n: int = 60_000, prevalence: float = 0.004):
    rng = np.random.default_rng(seed)
    y = (rng.random(n) < prevalence).astype(int)
    s = rng.normal(0, 1, n) + 2.2 * y  # a score that separates the classes, imperfectly
    return y, s


class WeightedMetrics(unittest.TestCase):
    def test_weights_stand_for_the_population(self):
        """Keeping 1 in 10 negatives with weight 10 estimates the population's metrics without bias: averaged over the
        ten disjoint samples (every negative in exactly one), the estimates meet the full-population values. One sample
        alone varies (the reason the card shows bootstrap intervals)."""
        y, s = _population()
        full = M.metrics(y, s, np.ones(len(y)), thr=1.5)
        runs = []
        for k in range(10):
            keep = (y == 1) | (np.arange(len(y)) % 10 == k)
            runs.append(M.metrics(y[keep], s[keep], np.where(y[keep] == 1, 1.0, 10.0), thr=1.5))
        for key, tol in (("auroc", 0.003), ("auprc", 0.015), ("f1", 0.015), ("presisi", 0.02), ("recall", 1e-9), ("prevalensi", 1e-4)):
            self.assertAlmostEqual(full[key], float(np.mean([r[key] for r in runs])), delta=tol, msg=key)

    def test_replicated_rows_equal_weights(self):
        """A weight of 3 is exactly three copies of the row."""
        y, s = _population(n=5000, prevalence=0.05)
        w = np.where(np.arange(len(y)) % 2 == 0, 3.0, 1.0)
        rep = np.repeat(np.arange(len(y)), w.astype(int))
        a, b = M.metrics(y, s, w, thr=0.8), M.metrics(y[rep], s[rep], np.ones(len(rep)), thr=0.8)
        for k in ("auroc", "auprc", "f1", "presisi", "recall", "akurasi"):
            self.assertAlmostEqual(a[k], b[k], places=9, msg=k)

    def test_accuracy_is_reported_but_meaningless(self):
        """Flagging nothing is ~99.6 % accurate here: why the card ranks by AUPRC and F1."""
        y, s = _population()
        m = M.metrics(y, s, np.ones(len(y)), thr=float(s.max()) + 1)
        self.assertGreater(m["akurasi"], 0.99)
        self.assertEqual(m["f1"], 0.0)
        self.assertAlmostEqual(m["akurasi_seimbang"], 0.5, places=6)

    def test_threshold_maximises_f1(self):
        y, s = _population(n=8000, prevalence=0.03)
        w = np.ones(len(y))
        thr = M.threshold_max_f1(y, s, w)
        best = M.metrics(y, s, w, thr)["f1"]
        for t in np.quantile(s, np.linspace(0.5, 0.999, 60)):
            self.assertLessEqual(M.metrics(y, s, w, float(t))["f1"], best + 1e-12)

    def test_lift(self):
        y, s = _population()
        m = M.metrics(y, s, np.ones(len(y)))
        self.assertAlmostEqual(m["lift_top_0_1pct"], m["presisi_top_0_1pct"] / m["prevalensi"], places=9)


class PriorAndBootstrap(unittest.TestCase):
    def test_prior_correction_undoes_undersampling(self):
        """Odds learnt on a beta share of the negatives are beta times too high; the correction divides them back."""
        p = np.array([0.5, 0.2, 0.9])
        q = M.prior_correct(p, 0.03)
        np.testing.assert_allclose(q / (1 - q), 0.03 * p / (1 - p), rtol=1e-9)
        self.assertTrue(np.all(np.diff(M.prior_correct(np.linspace(0.01, 0.99, 50))) > 0))  # the ranking is kept

    def test_bootstrap_brackets_the_estimate(self):
        y, s = _population(n=40_000, prevalence=0.01)
        w = np.ones(len(y))
        groups = np.arange(len(y)) % 300
        ci = M.bootstrap_ci(y, s, w, groups, n=100)
        point = M.metrics(y, s, w)
        for k in ("auroc", "auprc"):
            lo, hi = ci[k]
            self.assertLess(lo, hi)
            self.assertLessEqual(lo, point[k] + 1e-9)
            self.assertGreaterEqual(hi, point[k] - 1e-9)


class CorrectedTTest(unittest.TestCase):
    def test_overlapping_folds_make_it_more_cautious(self):
        """With training sets that overlap (repeated CV), the corrected test needs more evidence than the plain one."""
        from scipy.stats import ttest_1samp

        rng = np.random.default_rng(5)
        d = list(0.01 + rng.normal(0, 0.02, 15))
        t, p = M.corrected_ttest(d, n_train=400_000, n_test=100_000)
        self.assertGreater(p, ttest_1samp(d, 0).pvalue)
        self.assertAlmostEqual(t, np.mean(d) / np.sqrt((1 / 15 + 0.25) * np.var(d, ddof=1)), places=9)

    def test_clear_and_null_differences(self):
        self.assertLess(M.corrected_ttest([0.1 + 0.001 * i for i in range(15)], 400_000, 100_000)[1], 0.05)
        self.assertGreater(M.corrected_ttest([(-1) ** i * 0.02 for i in range(15)], 400_000, 100_000)[1], 0.5)


class EvaluationSetColumns(unittest.TestCase):
    def test_every_benchmark_row_finds_what_it_reads(self):
        """The benchmark runs the techniques and the reference rules on the evaluation set, so each must find its columns
        there: model 0.5.0's card lost its rule baseline when the rules' flags left the features (KeyError, caught and
        skipped by the benchmark, 2026-10-27)."""
        import pandas as pd

        rng = np.random.default_rng(1)
        n = 400
        df = pd.DataFrame({c: rng.normal(size=n) for c in M.eval_columns()})
        for c in M.CAT_ALL + M.CAT_HIGH + ["klaim_id", "faskes_profil_id"]:
            if c in df:
                df[c] = rng.choice(["a", "b", "c"], n)
        df["jenis_fkrtl"] = rng.choice(["Rumah sakit", "Klinik Utama"], n)
        df["tingkat_pelayanan"] = rng.choice(["RITL", "RJTL"], n)
        for c in ("flag_ganda", "flag_los_ekstrem", "y"):
            df[c] = (rng.random(n) < 0.2).astype(int)
        train, test = df.iloc[:300], df.iloc[300:]
        enc = M.Encoder().fit(train)
        for name in ["Regresi logistik", "HistGradientBoosting", *M.REFERENCES]:
            _, (s,), _ = M.fit_predict(name, train, [test], enc)
            self.assertEqual(len(s), len(test), name)
        self.assertTrue(set(M.RULE_COLS) <= set(M.eval_columns()))


class FacilityFolds(unittest.TestCase):
    def test_the_same_seed_deals_the_same_folds(self):
        """The evidence card's out-of-fold scores (and rule 2's) rest on these folds, and the card states its seed: two
        runs of the evidence job on the same data dealt other folds (176 vs 180 hospital corrections in the audit list,
        2026-10-28) because a GROUP BY returns its rows in no fixed order."""
        import duckdb
        import pandas as pd

        rng = np.random.default_rng(2)
        n = 300_000  # enough rows for a parallel GROUP BY to come back in a different order
        con = duckdb.connect()
        con.execute("SET threads = 8")
        con.register("f", pd.DataFrame({"faskes_profil_id": [f"p{i:04d}" for i in rng.integers(0, 2_000, n)], "y": (rng.random(n) < 0.01).astype(int)}))
        con.execute("CREATE TABLE fitur AS SELECT * FROM f")
        first = M.facility_folds(con, 5, M.SEED)
        for _ in range(4):
            self.assertEqual(M.facility_folds(con, 5, M.SEED), first)
        self.assertEqual(sorted(set(first.values())), [0, 1, 2, 3, 4])


class Research(unittest.TestCase):
    def test_every_technique_has_research(self):
        for name in list(M.MODELS) + ["Isolation Forest (unsupervised)"]:
            refs = M.RESEARCH.get(name) or []
            self.assertTrue(refs, name)
            for r in refs:
                self.assertTrue(r["penulis"] and r["judul"] and r["tahun"] >= 1950, (name, r))
                self.assertIn(r["sumber"], ("consensus", "web", "metode"))
                if r["sumber"] == "consensus":
                    self.assertTrue(r["url"].startswith("https://consensus.app/papers/details/"), r["url"])
        # the fraud-detection evidence (not only method papers) behind the gradient boosting and forest families
        for name in ("Random Forest", "XGBoost", "LightGBM", "CatBoost", "MLP", "Regresi logistik"):
            self.assertTrue(any(r["sumber"] == "consensus" for r in M.RESEARCH[name]), name)

    def test_protocol_and_explainers_cited(self):
        self.assertTrue(all(p["rujukan"] for p in M.PROTOCOL_RESEARCH))
        for m in M.EXPLAINERS:
            self.assertTrue(M.EXPLAINER_RESEARCH.get(m), m)


class Features(unittest.TestCase):
    def test_no_label_leak(self):
        """Nothing the verifier decides is a feature."""
        for leak in ("biaya_verifikasi", "biaya_verifikasi_rp", "selisih_rp", "flag_selisih_verifikasi", "y", "pct_selisih"):
            self.assertNotIn(leak, M.FEATURES)

    def test_reason_values_read_like_an_auditor(self):
        enc = M.Encoder()
        enc.maps = {c: {"Klinik Utama": 0, "Rumah sakit": 1} if c == "jenis_fkrtl" else {} for c in M.CAT_LOW}
        self.assertEqual(M._value("jenis_fkrtl", 0.0, enc), "Klinik Utama")
        self.assertEqual(M._value("biaya_tagih", 2_500_000, enc), "Rp 2,5 jt")
        self.assertEqual(M._value("idx_los", 0.5, enc), "0,50×")
        self.assertEqual(M._value("f_pct_kembar", 0.125, enc), "12,5%")


class Screens(unittest.TestCase):
    def _index(self):
        board = [{"model": "CatBoost", "pembanding": False, "auprc": 0.11, "auprc_ci95": [0.05, 0.19], "auroc": 0.93, "f1": 0.12, "presisi": 0.10,
                  "recall": 0.15, "lift_top_0_1pct": 420.0},
                 {"model": "Regresi logistik", "pembanding": False, "auprc": 0.05, "auprc_ci95": [0.02, 0.09], "auroc": 0.9, "f1": 0.06, "presisi": 0.05, "recall": 0.1},
                 {"model": "Isolation Forest (unsupervised)", "pembanding": True, "auprc": 0.002, "auroc": 0.6, "f1": 0.0, "presisi": 0.0, "recall": 0.0}]
        shap = [{"fitur": "jenis_fkrtl", "label": "Jenis faskes", "kontribusi": 2.1, "nilai": "Klinik Utama"},
                {"fitur": "idx_los", "label": "LOS / median kode yang sama", "kontribusi": -0.4, "nilai": "0,50×"}]
        index = [{"rid": "r1", "title": "Benchmark teknik ML · rumah sakit", "meta": {"kind": "ml_board", "agent": "machine_learning"}},
                 {"rid": "r2", "title": "Pendorong risiko klaim x", "meta": {"kind": "ml_shap", "agent": "machine_learning"}}]
        return index, {"r1": board, "r2": shap}

    def test_ml_template_and_insights(self):
        index, rows = self._index()
        spec = S.compose("Seberapa akurat model ML dan teknik mana yang terbaik?", "CatBoost terbaik [r1]", {"r1"}, index, rows)
        self.assertEqual(spec["template"], "ml")
        widgets = {p["widget"] for p in spec["panels"]}
        self.assertIn("leaderboard", widgets)
        self.assertIn("contrib", widgets)
        board = next(p for p in spec["panels"] if p["widget"] == "leaderboard")
        self.assertIn("CatBoost teratas", board["insight"])
        self.assertIn("0,110", board["insight"])
        self.assertIn("Isolation Forest", board["insight"])  # the reference is named beside the winner
        self.assertEqual(board["highlight"], ["CatBoost"])

    def test_evidence_card_template(self):
        head = [{"ukuran": "precision@k", "nilai": 0.05, "ik95": "0.03–0.08"}, {"ukuran": "klaim terkoreksi di daftar audit", "nilai": 265, "ik95": "150–400"},
                {"ukuran": "harapan bila acak", "nilai": 0, "ik95": None}, {"ukuran": "lift vs acak", "nilai": 840.0, "ik95": None}]
        abl = [{"varian": "Aturan yang ada (flag ganda / LOS ekstrem)", "precision_at_k": 0.001, "perubahan": None, "p": None},
               {"varian": "Model ML", "precision_at_k": 0.05, "perubahan": 0.049, "p": 0.001}]
        hard = [{"kelompok": "RS kelas A / tersier", "porsi_jujur_ditandai": 0.0004, "jujur_ditandai": 30, "rasio_vs_rata": 4.0},
                {"kelompok": "Faskes baru atau kecil", "porsi_jujur_ditandai": 0.0001, "jujur_ditandai": 2, "rasio_vs_rata": 1.0}]
        index = [{"rid": "r1", "title": "Kartu bukti model · klaim rumah sakit", "meta": {"kind": "ml_evidence_head"}},
                 {"rid": "r2", "title": "Ablasi vs aturan", "meta": {"kind": "ml_evidence_ablation"}},
                 {"rid": "r3", "title": "Negatif sulit", "meta": {"kind": "ml_evidence_hard"}}]
        spec = S.compose("Apa isi kartu bukti model untuk klaim rumah sakit?", "precision@k [r1] ablasi [r2]", {"r1", "r2"}, index,
                         {"r1": head, "r2": abl, "r3": hard})
        self.assertEqual(spec["template"], "bukti")
        insights = " ".join(p["insight"] for p in spec["panels"])
        self.assertIn("265 klaim terkoreksi", insights)
        self.assertIn("RS kelas A", insights)  # the hard negative flagged most, against the average
        self.assertIn("p = 0,001", insights)


if __name__ == "__main__":
    unittest.main()
