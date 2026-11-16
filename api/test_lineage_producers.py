"""The lineage keeps one producer per dataset — the one that wrote its current version (lineage._current_producers).
The BPJS silver and gold moved from Code Repository transforms and an SQL pipeline into one Pipeline Builder pipeline
(2026-10-26); the old writers stayed drawn beside the new, and an ancestors build could walk into the old code.

    python -m pytest test_lineage_producers.py -q
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # the vendored `unstructured` (as server.py does)

import lineage  # noqa: E402


def _graph() -> lineage._Graph:
    g = lineage._Graph()
    g.node("dataset:bronze", "dataset", "peserta (Data Mentah)")
    g.node("transform:silver_peserta", "transform", "silver_peserta", buildable=True)
    g.node("transform:silver_dimensi", "transform", "silver_dimensi", buildable=True)
    g.node("pipeline:builder", "pipeline", "Pipeline Data Sampel BPJS", buildable=True)
    g.node("dataset:peserta", "dataset", "peserta.parquet")
    g.node("dataset:dim_icd10", "dataset", "dim_icd10.parquet")
    g.node("dataset:dim_wilayah", "dataset", "dim_wilayah.parquet")
    for t in ("transform:silver_peserta", "transform:silver_dimensi", "pipeline:builder"):
        g.edge("dataset:bronze", t, "input")
    writes = [("transform:silver_peserta", "dataset:peserta", "builds", "2026-10-20T13:01:50+00:00"),
              ("pipeline:builder", "dataset:peserta", "deploys", "2026-10-27T10:49:10+00:00"),
              ("transform:silver_dimensi", "dataset:dim_icd10", "builds", "2026-10-20T13:02:00+00:00"),
              ("transform:silver_dimensi", "dataset:dim_wilayah", "builds", "2026-10-20T13:02:00+00:00"),
              ("pipeline:builder", "dataset:dim_wilayah", "deploys", "2026-10-27T10:49:10+00:00")]
    for src, ds, label, at in writes:
        g.edge(src, ds, label)
        g.nodes[ds].setdefault("producers", []).append({"kind": g.nodes[src]["kind"], "id": src, "name": g.nodes[src]["name"], "at": at})
    return g


class CurrentProducers(unittest.TestCase):
    def test_the_older_writer_leaves_the_graph_and_stays_in_the_history(self):
        g = _graph()
        lineage._current_producers(g)
        self.assertNotIn(("transform:silver_peserta", "dataset:peserta"), g.edges)
        self.assertIn(("pipeline:builder", "dataset:peserta"), g.edges)
        old = next(p for p in g.nodes["dataset:peserta"]["producers"] if p["id"] == "transform:silver_peserta")
        self.assertEqual(old["replaced_by"]["name"], "Pipeline Data Sampel BPJS")
        self.assertIn(("dataset:bronze", "transform:silver_peserta"), g.edges)  # what it reads is still true

    def test_a_job_writing_nothing_current_is_not_built_from_the_lineage(self):
        g = _graph()
        lineage._current_producers(g)
        self.assertFalse(g.nodes["transform:silver_peserta"]["buildable"])
        self.assertEqual([r["dataset"] for r in g.nodes["transform:silver_peserta"]["replaced"]], ["peserta.parquet"])
        # a job with one output still its own stays buildable, its replaced output named
        self.assertTrue(g.nodes["transform:silver_dimensi"]["buildable"])
        self.assertEqual([r["dataset"] for r in g.nodes["transform:silver_dimensi"]["replaced"]], ["dim_wilayah.parquet"])
        self.assertIn(("transform:silver_dimensi", "dataset:dim_icd10"), g.edges)

    def test_times_are_instants_and_a_borrowed_time_loses_the_tie(self):
        # the archived SQL pipeline had no record of its own write: the dataset's time (WIB) stood in, and as text
        # "17:51:15+07:00" beat the replacing pipeline's "10:51:15+00:00" — the same moment
        g = lineage._Graph()
        g.node("pipeline:baru", "pipeline", "Pipeline Data Sampel BPJS", buildable=True)
        g.node("pipeline:lama", "pipeline", "Pipeline Gold (lama, SQL)", buildable=True)
        g.node("dataset:profil", "dataset", "profil_faskes.parquet")
        g.edge("pipeline:baru", "dataset:profil", "deploys")
        g.edge("pipeline:lama", "dataset:profil", "deploys")
        g.nodes["dataset:profil"]["producers"] = [
            {"kind": "pipeline", "id": "pipeline:baru", "name": "Pipeline Data Sampel BPJS", "at": "2026-10-27T10:51:15+00:00"},
            {"kind": "pipeline", "id": "pipeline:lama", "name": "Pipeline Gold (lama, SQL)", "at": "2026-10-27T17:51:15+07:00", "at_borrowed": True}]
        g.nodes["dataset:profil"]["producers"].reverse()  # whatever the order
        lineage._current_producers(g)
        self.assertEqual(list(g.edges), [("pipeline:baru", "dataset:profil")])
        self.assertFalse(g.nodes["pipeline:lama"]["buildable"])
        self.assertEqual(lineage._producer(g, "dataset:profil")["id"], "pipeline:baru")

    def test_an_ancestors_build_no_longer_walks_into_the_old_code(self):
        g = _graph()
        lineage._current_producers(g)
        self.assertNotIn("transform:silver_peserta", lineage._walk(g, "dataset:peserta", True))
        self.assertEqual(lineage._producer(g, "dataset:peserta")["id"], "pipeline:builder")


if __name__ == "__main__":
    unittest.main()
