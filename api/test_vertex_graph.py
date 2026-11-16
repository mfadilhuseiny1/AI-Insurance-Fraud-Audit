"""Graph Search Around (api/vertex.py) over a live object type: 60,000 claims in a Parquet dataset (above SMALL) linked
by foreign key to an indexed type of facilities, in a temporary data directory. A page of the reached objects (limit,
offset) is what the Object Explorer's graph tab adds at a time; every answer is checked against pandas on the same
rows, and a live type's objects are fetched in batches (not one query per object).

    cd api; PYTHONPATH="<repo>;<repo>/api" ../.venv/Scripts/python.exe -m pytest test_vertex_graph.py -q
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("BLUESANDAI_AUTH", "off")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from fastapi import HTTPException  # noqa: E402

N = 60_000
FASKES = 40


class GraphSearchAround(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import drive
        import ontology
        import ontology_live
        import ontology_model as om

        import ontology_actions
        import ontology_edits
        import ontology_security
        import vertex

        cls.tmp = Path(tempfile.mkdtemp(prefix="bsai-graph-"))
        ontology.configure(cls.tmp, lambda k: "")
        for mod in (om, ontology_actions, ontology_security, ontology_edits, vertex):
            mod.configure()
        rng = np.random.default_rng(11)
        cls.df = pd.DataFrame({
            "klaim_id": [f"K{i:06d}" for i in range(N)],
            "faskes_id": [f"F{int(x):02d}" for x in rng.integers(0, FASKES, N)],
            "biaya_tagih_rp": rng.integers(100_000, 30_000_000, N).astype("float64"),
        })
        (cls.tmp / "drive").mkdir()
        drive.LOCAL_DIR = cls.tmp / "drive"
        pq.write_table(pa.Table.from_pandas(cls.df, preserve_index=False), drive.LOCAL_DIR / "ds-klaim", row_group_size=20_000)
        cls._item = drive._item
        drive._item = lambda item_id, *a, **k: {"id": item_id, "name": f"{item_id}.parquet", "stored_in": "local"}

        cls.faskes = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name="Faskes (graph test)", plural_name="Faskes (graph test)", api_name="FaskesGraphTest", primary_key="faskes_id", title_property="nama",
            properties=[ontology.Property(api_name="faskes_id", display_name="Faskes", type="string"),
                        ontology.Property(api_name="nama", display_name="Nama", type="string")], status="active"))
        ontology.save_objects(cls.faskes["id"], {f"F{i:02d}": {"properties": {"faskes_id": f"F{i:02d}", "nama": f"RS {i}"}} for i in range(FASKES)})
        cls.klaim = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name="Klaim (graph test)", plural_name="Klaim (graph test)", api_name="KlaimGraphTest", primary_key="klaim_id", title_property="klaim_id",
            properties=[ontology.Property(api_name="klaim_id", display_name="Klaim", type="string")], status="active"))
        ontology_live.back(cls.klaim["id"], "ds-klaim", None, True)
        cls.lt = om.create_link_type(om.LinkTypeIn(
            display_name="Klaim di faskes (graph test)", kind="foreign_key", cardinality="many_to_one", foreign_key="faskes_id", status="active",
            source=om.LinkSide(object_type_id=cls.klaim["id"], display_name="Klaim", plural_display_name="Klaim"),
            target=om.LinkSide(object_type_id=cls.faskes["id"], display_name="Faskes")))

    @classmethod
    def tearDownClass(cls):
        import drive
        import ontology_model as om

        drive._item = cls._item
        om.flush_usage()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def around(self, start_type, pks, direction, **kw):
        import vertex

        return vertex.search_around(vertex.SearchAroundIn(
            nodes=[{"object_type_id": start_type, "primary_key": pk} for pk in pks],
            steps=[{"link_type_id": self.lt["id"], "direction": direction}], **kw))

    def claims_of(self, *faskes):
        return sorted(self.df[self.df.faskes_id.isin(faskes)].klaim_id)

    def test_pages_of_a_large_fan_out(self):
        want = self.claims_of("F03", "F17")
        self.assertGreater(len(want), 2000)  # more than a graph holds: unpaged, it is refused
        with self.assertRaises(HTTPException):
            self.around(self.faskes["id"], ["F03", "F17"], "reverse")
        first = self.around(self.faskes["id"], ["F03", "F17"], "reverse", limit=50)
        second = self.around(self.faskes["id"], ["F03", "F17"], "reverse", limit=50, offset=50)
        self.assertEqual(first["reached"], len(want))
        self.assertEqual(first["layers"][1]["primary_keys"], want[:50])
        self.assertEqual(second["layers"][1]["primary_keys"], want[50:100])
        # the starting layer: the facilities those 50 claims belong to
        self.assertEqual(set(first["layers"][0]["primary_keys"]), set(self.df[self.df.klaim_id.isin(want[:50])].faskes_id))
        self.assertEqual([n["primary_key"] for n in first["nodes"] if n["object_type_id"] == self.klaim["id"]], want[:50])
        last = self.around(self.faskes["id"], ["F03", "F17"], "reverse", limit=50, offset=len(want) - 7)
        self.assertEqual(last["layers"][1]["primary_keys"], want[-7:])

    def test_unpaged_answer_is_unchanged(self):
        out = self.around(self.faskes["id"], ["F05"], "reverse")
        self.assertEqual(out["layers"][1]["primary_keys"], self.claims_of("F05"))
        self.assertNotIn("reached", out)
        fwd = self.around(self.klaim["id"], ["K000001", "K000002", "K000003"], "forward")
        self.assertEqual(fwd["layers"][1]["primary_keys"], sorted(set(self.df.set_index("klaim_id").loc[["K000001", "K000002", "K000003"], "faskes_id"])))

    def test_live_objects_are_fetched_in_batches(self):
        import ontology_live

        calls = []
        real = ontology_live.get_many

        def counting(type_id, keys, *a, **k):
            calls.append(len(list(keys)) if not isinstance(keys, (list, tuple, set)) else len(keys))
            return real(type_id, keys, *a, **k)

        ontology_live.get_many = counting
        try:
            out = self.around(self.faskes["id"], ["F09"], "reverse")
        finally:
            ontology_live.get_many = real
        n = len(self.claims_of("F09"))
        self.assertEqual(len(out["layers"][1]["primary_keys"]), n)
        self.assertTrue(0 < len(calls) <= -(-n // 500) + 1, calls)  # batches of 500, not one query per claim

    def test_options_and_resolve(self):
        import vertex

        opts = vertex.around_options(vertex.AroundIn(nodes=[{"object_type_id": self.faskes["id"], "primary_key": "F01"}]))
        claim = next(o for o in opts if o["to_type_id"] == self.klaim["id"])
        self.assertEqual((claim["direction"], claim["count"]), ("reverse", len(self.claims_of("F01"))))
        some = self.claims_of("F01")[:5]
        nodes, edges = vertex.resolve_nodes([vertex.NodeRef(object_type_id=self.faskes["id"], primary_key="F01")]
                                            + [vertex.NodeRef(object_type_id=self.klaim["id"], primary_key=pk) for pk in some])
        self.assertEqual(len(nodes), 6)
        self.assertEqual(sorted(e["source"] for e in edges), sorted(f"{self.klaim['id']}|{pk}" for pk in some))
        self.assertTrue(all(e["target"] == f"{self.faskes['id']}|F01" and e["label"] == "Klaim di faskes (graph test)" for e in edges))


if __name__ == "__main__":
    unittest.main()
