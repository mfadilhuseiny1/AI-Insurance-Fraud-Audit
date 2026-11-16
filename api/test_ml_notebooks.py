"""ML Studio's notebook per model (ml_notebooks.py).

A technique notebook must carry the model card's own numbers (the first repeat's folds of that technique, per task),
start on the task its technique serves in production, and compare with the production model only where production
uses it. A Model Studio notebook must run as written: its cells, executed in order on a small dataset, train with the
studio's trainer and reproduce a run made by that trainer on the same data.
"""

from __future__ import annotations

import ast
import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import bluesandai_model_studio as ms  # noqa: E402
import ml_klaim as M  # noqa: E402
import ml_notebooks as nb  # noqa: E402


def _folds(seed: float, n: int = 5) -> list[dict]:
    return [{"ulangan": u, "lipatan": f, "auprc": seed + f / 100 + u / 1000, "auroc": 0.9 + f / 1000, "presisi_top_0_1pct": seed / 2} for u in (1, 2) for f in range(1, n + 1)]


def _row(model: str, auprc: float, ref: bool = False, best: bool = False) -> dict:
    agg = {k: {"mean": auprc, "sd": 0.01} for k in ("auprc", "auroc", "presisi_top_0_1pct", "lift_top_0_1pct")}
    return {"model": model, "pembanding": ref, "rata": agg, "gabungan_oof": {k: auprc for k in nb.POOLED_KEYS},
            "uji_vs_terbaik": None if best else {"p": 0.4, "berbeda_nyata": False}}


def _report() -> dict:
    """A model card in the shape aip/ml.py writes: CatBoost best on hospital claims, LightGBM on all claims."""
    def task(label: str, order: list[str]) -> dict:
        return {"label": label, "terbaik": order[0], "ulangan": 2, "lipatan": 5, "ablasi_undersampling": [],
                "papan": [_row(m, 0.5 - i / 10, best=i == 0) for i, m in enumerate(order)] + [_row("Aturan (flag ganda / LOS ekstrem)", 0.001, ref=True)],
                "lipatan_per_model": {m: _folds(0.5 - i / 10) for i, m in enumerate(order + ["Aturan (flag ganda / LOS ekstrem)"])}}

    return {"tugas": {"rumah_sakit": task("Klaim rumah sakit", ["CatBoost", "XGBoost", "LightGBM"]), "semua": task("Semua klaim", ["LightGBM", "CatBoost", "XGBoost"])},
            "segmen": {"rumah_sakit": {"model": "CatBoost", "tugas": "rumah_sakit", "porsi_negatif_latih": 1.0},
                       "klinik_utama": {"model": "LightGBM", "tugas": "semua", "porsi_negatif_latih": 0.3}}}


# as ml_studio passes them: the two studio files a studio notebook imports
STUDIO_SHAS = {f: nb.code_shas()[f] for f in nb.STUDIO_CODE[:2]}
CURRENT = {"version": "mlv-test", "model": {"model_id": "mdl-test", "version": "9.9.9"}}


def _assigned(cell: str, name: str):
    """The value a cell assigns to `name` (a literal)."""
    for node in ast.parse(cell).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not assigned")


class TechniqueNotebooks(unittest.TestCase):
    def setUp(self):
        self.report = _report()
        self.books = {n: nb.aip_notebook(n, self.report, CURRENT, "0" * 64) for n in M.MODELS}

    def test_valid_notebooks(self):
        for name, book in self.books.items():
            ids = [c["id"] for c in book["cells"]]
            self.assertEqual(len(ids), len(set(ids)), name)
            self.assertTrue(all(len(i) <= 64 for i in ids))
            for c in book["cells"]:
                if c["cell_type"] == "code":
                    compile(c["source"], f"{name}:{c['id']}", "exec")

    def test_card_numbers_are_the_first_repeat_of_that_technique(self):
        cell = next(c["source"] for c in self.books["XGBoost"]["cells"] if c["source"].startswith("PLATFORM = "))
        got = _assigned(cell.split("def validasi_silang")[0], "PLATFORM")
        for task, t in self.report["tugas"].items():
            want = {str(r["lipatan"]): {k: round(r[k], 4) for k in nb.FOLD_KEYS} for r in t["lipatan_per_model"]["XGBoost"] if r["ulangan"] == 1}
            self.assertEqual(got[task], want)

    def test_starts_on_the_production_task(self):
        params = {n: next(c["source"] for c in b["cells"] if c["source"].startswith("TUGAS = ")) for n, b in self.books.items()}
        self.assertEqual(_assigned(params["CatBoost"], "TUGAS"), "rumah_sakit")
        self.assertEqual(_assigned(params["LightGBM"], "TUGAS"), "semua")
        self.assertEqual(_assigned(params["XGBoost"], "TUGAS"), "rumah_sakit")
        self.assertEqual(_assigned(params["CatBoost"], "PORSI_NEGATIF_LATIH"), {"semua": 0.3, "rumah_sakit": 1.0})

    def test_production_comparison_only_where_production_uses_it(self):
        head = {n: b["cells"][0]["source"] for n, b in self.books.items()}
        self.assertIn("Dipakai model produksi v9.9.9", head["CatBoost"])
        self.assertIn("klinik_utama", head["LightGBM"])
        self.assertIn("Tidak dipakai model produksi", head["XGBoost"])
        catalog = {c["title"]: c for c in nb.aip_catalog(self.report, CURRENT)}
        self.assertEqual([p["segment"] for p in catalog["CatBoost"]["production"]], ["rumah_sakit"])
        self.assertEqual(catalog["XGBoost"]["production"], [])
        self.assertEqual(list(catalog)[:2], ["CatBoost", "LightGBM"])  # production first

    def test_without_a_model_card(self):
        book = nb.aip_notebook("CatBoost", None, None, "0" * 64)
        self.assertIn("Belum ada kartu model", book["cells"][0]["source"])


class KeepEdited(unittest.TestCase):
    """The workspace refresh updates a notebook JupyterLab only re-saved, and keeps one whose cells changed or ran."""

    def test_resaved_is_ours_edited_or_run_is_theirs(self):
        import json

        import ml_studio

        book = nb.aip_notebook("CatBoost", _report(), CURRENT, "0" * 64)
        written = nb.dumps(book)
        # JupyterLab's own layout: sources as lists of lines, its metadata, other indentation
        resaved = json.loads(written)
        for c in resaved["cells"]:
            c["source"] = c["source"].splitlines(keepends=True)
        resaved["metadata"]["language_info"]["version"] = "3.12.12"
        resaved = json.dumps(resaved, indent=2).encode()
        self.assertNotEqual(resaved, written)
        self.assertEqual(ml_studio._cells_sha(resaved), ml_studio._cells_sha(written))
        edited = json.loads(written)
        edited["cells"][2]["source"] += "\nLIPATAN = 3"
        self.assertNotEqual(ml_studio._cells_sha(json.dumps(edited).encode()), ml_studio._cells_sha(written))
        ran = json.loads(written)
        ran["cells"][4]["outputs"] = [{"output_type": "stream", "name": "stdout", "text": "ok"}]
        self.assertIsNone(ml_studio._cells_sha(json.dumps(ran).encode()))


@contextlib.contextmanager
def _workdir():
    old = os.getcwd()
    d = Path(tempfile.mkdtemp(prefix="nbtest-"))
    try:
        (d / "code" / "repo" / "api").mkdir(parents=True)
        for f in nb.STUDIO_CODE:
            shutil.copyfile(HERE / f, d / "code" / "repo" / "api" / f)
        os.chdir(d)
        yield d
    finally:
        os.chdir(old)
        shutil.rmtree(d, ignore_errors=True)


def _run(book: dict) -> dict:
    """Every code cell in order, in one namespace (as a kernel runs them)."""
    import matplotlib

    matplotlib.use("Agg")
    ns: dict = {"__name__": "__main__"}
    for c in book["cells"]:
        if c["cell_type"] == "code":
            exec(compile(c["source"], c["id"], "exec"), ns)  # noqa: S102 - the notebook under test
    return ns


class StudioNotebooks(unittest.TestCase):
    def _studio(self, trainer: str, cfg: dict) -> dict:
        return {"id": "ms-test", "name": "Uji notebook (test)", "trainer": trainer, "configs": [cfg]}

    def test_classification_with_filters_reproduces_the_run(self):
        rng = np.random.default_rng(1)
        df = pd.DataFrame({"a": rng.normal(size=300), "b": rng.normal(size=300), "kota": rng.choice(["x", "y", "z"], 300)})
        df["kelas"] = np.where(df.a + 0.5 * df.b + rng.normal(scale=0.5, size=300) > 0, "ya", "tidak")
        cfg = {"version": 2, "name": "v2", "target": "kelas", "features": ["a", "b", "kota"], "filters": [{"column": "b", "op": ">", "value": -1.5}],
               "params": {"eval_metric": "accuracy", "predict_probabilities": True}}
        # the platform's run: the studio's trainer on the filtered rows
        _, _, rep = ms.train_tabular("classification", df[df.b > -1.5].reset_index(drop=True), "kelas", cfg["features"], dict(cfg["params"]), None, lambda _: None)
        run = {"id": "run-test", "started_at": "2026-10-27T00:00:00+00:00", "best_model": rep["best"], "metrics": {"accuracy": round(rep["score"], 6)},
               "config_version": 2}
        with _workdir() as d:
            (d / "data" / "studio" / "uji").mkdir(parents=True)
            df.to_parquet(d / "data" / "studio" / "uji" / "latih.parquet")
            book = nb.studio_notebook(self._studio("classification", cfg), cfg, run, {"train": "data/studio/uji/latih.parquet"}, STUDIO_SHAS, "Klasifikasi")
            with contextlib.redirect_stdout(io.StringIO()):
                ns = _run(book)
        self.assertEqual(len(ns["latih"]), int((df.b > -1.5).sum()))
        self.assertEqual(ns["laporan"]["best"], rep["best"])
        self.assertAlmostEqual(ns["laporan"]["score"], rep["score"], places=9)
        self.assertIn("prediksi", ns["matriks"].columns.names)

    def test_time_series(self):
        days = pd.date_range("2026-01-01", periods=60, freq="D")
        df = pd.DataFrame({"tanggal": np.tile(days, 2), "faskes": np.repeat(["A", "B"], 60), "klaim": np.r_[np.arange(60) % 7, 10 + np.arange(60) % 7].astype(float)})
        cfg = {"version": 1, "name": "v1", "target": "klaim", "timestamp": "tanggal", "item_id": "faskes", "params": {"prediction_length": 7, "seasonal_period": 7}}
        with _workdir() as d:
            (d / "data" / "studio" / "ts").mkdir(parents=True)
            df.to_parquet(d / "data" / "studio" / "ts" / "latih.parquet")
            book = nb.studio_notebook(self._studio("time_series", cfg), cfg, None, {"train": "data/studio/ts/latih.parquet"}, STUDIO_SHAS, "Peramalan")
            with contextlib.redirect_stdout(io.StringIO()):
                ns = _run(book)
        self.assertEqual(ns["laporan"]["best"], "seasonal_naive")  # a weekly pattern, repeated exactly
        self.assertEqual(len(ns["ramalan"]), 14)


if __name__ == "__main__":
    unittest.main()
