"""Live object types (ontology_live): a type backed by a Parquet dataset of 120,000 claims (above SMALL) and linked to an
indexed type of facilities, in a temporary data directory. The Files lookup of the dataset is the only seam (no Files
row in Postgres); every read, edit, search, Search Around and link runs through the real ontology modules and DuckDB,
and every answer is checked against pandas on the same rows.

    cd api; PYTHONPATH="<repo>;<repo>/api" ../.venv/Scripts/python.exe -m pytest test_ontology_live.py -q
    (the repo root on the path: ontology imports knowledge, which needs the vendored unstructured package)
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

N = 120_000
FASKES = 40


class LiveTypes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import drive
        import ontology
        import ontology_live
        import ontology_model as om

        import ontology_actions
        import ontology_edits
        import ontology_security

        cls.tmp = Path(tempfile.mkdtemp(prefix="bsai-live-"))
        ontology.configure(cls.tmp, lambda k: "")
        for mod in (om, ontology_actions, ontology_security, ontology_edits):  # as server.py does, in its order
            mod.configure()
        rng = np.random.default_rng(7)
        cls.df = pd.DataFrame({
            "klaim_id": [f"K{i:06d}" for i in range(N)],
            "faskes_id": [f"F{int(x):02d}" for x in rng.integers(0, FASKES, N)],
            "inacbg_kode": rng.choice(["F-4-10-I", "Q-5-44-0", "O-6-10-I", "J-4-16-II"], N),
            "biaya_tagih_rp": rng.integers(100_000, 30_000_000, N).astype("float64"),
            "los_hari": rng.integers(0, 60, N),
            "tgl_pulang": pd.to_datetime("2024-01-01") + pd.to_timedelta(rng.integers(0, 365, N), unit="D"),
            "rawat_inap": rng.random(N) < 0.3,
        })
        cls.df.loc[::97, "faskes_id"] = None  # claims without a facility
        (cls.tmp / "drive").mkdir()
        drive.LOCAL_DIR = cls.tmp / "drive"
        tbl = pa.Table.from_pandas(cls.df, preserve_index=False).cast(pa.schema([
            ("klaim_id", pa.string()), ("faskes_id", pa.string()), ("inacbg_kode", pa.string()), ("biaya_tagih_rp", pa.float64()),
            ("los_hari", pa.int64()), ("tgl_pulang", pa.date32()), ("rawat_inap", pa.bool_())]))
        pq.write_table(tbl, drive.LOCAL_DIR / "ds-klaim", row_group_size=20_000)
        dup = pa.concat_tables([tbl.slice(0, 1000), tbl.slice(0, 5)])
        pq.write_table(dup, drive.LOCAL_DIR / "ds-dup")
        cls._item = drive._item
        drive._item = lambda item_id, *a, **k: {"id": item_id, "name": f"{item_id}.parquet", "stored_in": "local"}

        cls.faskes = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name="Faskes (test)", plural_name="Faskes (test)", api_name="FaskesTest", primary_key="faskes_id", title_property="nama",
            properties=[ontology.Property(api_name="faskes_id", display_name="Faskes", type="string"),
                        ontology.Property(api_name="nama", display_name="Nama", type="string")], status="active"))
        ontology.save_objects(cls.faskes["id"], {f"F{i:02d}": {"properties": {"faskes_id": f"F{i:02d}", "nama": f"RS {i}"}} for i in range(FASKES)})
        cls.klaim = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name="Klaim (test)", plural_name="Klaim (test)", api_name="KlaimTest", primary_key="klaim_id", title_property="klaim_id",
            properties=[ontology.Property(api_name="klaim_id", display_name="Klaim", type="string"),
                        ontology.Property(api_name="status_verifikasi", display_name="Status", type="string")], status="active"))
        cls.backed = ontology_live.back(cls.klaim["id"], "ds-klaim", None, True)
        cls.lt = om.create_link_type(om.LinkTypeIn(
            display_name="Klaim di faskes (test)", kind="foreign_key", cardinality="many_to_one", foreign_key="faskes_id", status="active",
            source=om.LinkSide(object_type_id=cls.klaim["id"], display_name="Klaim", plural_display_name="Klaim"),
            target=om.LinkSide(object_type_id=cls.faskes["id"], display_name="Faskes")))

    @classmethod
    def tearDownClass(cls):
        import drive
        import ontology_model as om

        drive._item = cls._item
        om.flush_usage()  # the query meter, written now (its exit flush would find the directory gone)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def search(self, **kw):
        import ontology_explorer as ex

        return ex.search(ex.SearchIn(**kw))

    def test_backing_maps_columns_and_counts_rows(self):
        import ontology
        import ontology_live

        self.assertEqual(self.backed["rows"], N)
        props = {p["api_name"]: p["type"] for p in ontology._object_type(self.klaim["id"])["properties"]}
        self.assertEqual((props["biaya_tagih_rp"], props["los_hari"], props["tgl_pulang"], props["rawat_inap"]), ("double", "long", "date", "boolean"))
        self.assertEqual(ontology.object_count(self.klaim["id"]), N)
        self.assertEqual(ontology_live.describe(self.klaim["id"])["rows"], N)

    def test_a_repeated_primary_key_is_refused(self):
        import ontology
        import ontology_live

        t = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name="Dup (test)", plural_name="Dup (test)", api_name="DupTest", primary_key="klaim_id", title_property="klaim_id",
            properties=[ontology.Property(api_name="klaim_id", display_name="Klaim", type="string")], status="active"))
        with self.assertRaises(HTTPException) as e:
            ontology_live.back(t["id"], "ds-dup", None, False)
        self.assertIn("DuplicatePrimaryKey: 5 rows", e.exception.detail)

    def test_point_reads_and_no_whole_load(self):
        import ontology

        objs = ontology.load_objects(self.klaim["id"])
        self.assertEqual(len(objs), N)
        self.assertIn("K000123", objs)
        self.assertNotIn("nope", objs)
        row = self.df.iloc[123]
        self.assertEqual(objs["K000123"]["properties"]["biaya_tagih_rp"], row.biaya_tagih_rp)
        self.assertEqual(objs["K000123"]["properties"]["tgl_pulang"], row.tgl_pulang.date().isoformat())
        with self.assertRaises(HTTPException) as e:
            list(objs.items())
        self.assertIn("loading every object is not supported", e.exception.detail)

    def test_edits_are_kept_apart_and_seen_by_searches(self):
        import ontology

        ontology.apply_edits([{"op": "modify", "object_type_id": self.klaim["id"], "primary_key": "K000007",
                               "properties": {"status_verifikasi": "Ditahan", "los_hari": 99}}], source=None)
        o = ontology.load_objects(self.klaim["id"])["K000007"]["properties"]
        self.assertEqual((o["status_verifikasi"], o["los_hari"]), ("Ditahan", 99))
        r = self.search(object_type_id=self.klaim["id"], filters=[{"property": "status_verifikasi", "op": "eq", "value": "ditahan"}], histograms=False)
        self.assertEqual((r["total"], r["objects"][0]["primary_key"]), (1, "K000007"))
        r = self.search(object_type_id=self.klaim["id"], filters=[{"property": "los_hari", "op": "gte", "value": 99}], histograms=False)
        self.assertEqual(r["total"], 1)  # the edited value, not the dataset's
        with self.assertRaises(HTTPException):
            ontology.apply_edits([{"op": "create", "object_type_id": self.klaim["id"], "primary_key": "NEW", "properties": {}}], source=None)
        with self.assertRaises(HTTPException):
            ontology.apply_edits([{"op": "delete", "object_type_id": self.klaim["id"], "primary_key": "K000008"}], source=None)
        # back to the dataset's value: the edit of that property is gone, the other stays
        ontology.apply_edits([{"op": "modify", "object_type_id": self.klaim["id"], "primary_key": "K000007",
                               "properties": {"los_hari": int(self.df.iloc[7].los_hari)}}], source=None)
        import ontology_live

        self.assertEqual(ontology_live.edits(self.klaim["id"])["K000007"][0], {"status_verifikasi": "Ditahan"})

    def test_participation_counted_once_until_the_data_changes(self):
        import ontology
        import ontology_live

        calls = []
        orig = ontology_live._participation
        ontology_live._participation = lambda *a: calls.append(1) or orig(*a)
        try:
            p = ontology_live.participation(self.lt)
            linked = int(self.df.faskes_id.notna().sum())
            self.assertEqual((p["source"]["linked"], p["source"]["objects"], p["target"]["objects"]), (linked, N, FASKES))
            self.assertEqual(ontology_live.participation(self.lt), p)
            self.assertEqual(len(calls), 1)  # asked again: the answer kept
            ontology.save_objects(self.faskes["id"], ontology.stored_objects(self.faskes["id"]))  # the target's objects written again
            self.assertEqual(ontology_live.participation(self.lt), p)
            self.assertEqual(len(calls), 2)
        finally:
            ontology_live._participation = orig

    def test_charts_are_kept_until_an_edit(self):
        import ontology
        import ontology_live

        status = lambda r: {b["value"]: b["count"] for b in next(h for h in r["histograms"] if h["property"] == "status_verifikasi")["buckets"]}  # noqa: E731
        first = self.search(object_type_id=self.klaim["id"], histograms=True, all_charts=True, limit=1)
        calls = []
        orig = ontology_live._Rel.histograms
        ontology_live._Rel.histograms = lambda rel, *a: calls.append(1) or orig(rel, *a)
        try:
            again = self.search(object_type_id=self.klaim["id"], histograms=True, all_charts=True, offset=50, limit=1)
            self.assertEqual((calls, again["histograms"]), ([], first["histograms"]))  # another page: the charts kept
            ontology.apply_edits([{"op": "modify", "object_type_id": self.klaim["id"], "primary_key": "K000011",
                                   "properties": {"status_verifikasi": "Diuji cache"}}], source=None)
            after = self.search(object_type_id=self.klaim["id"], histograms=True, all_charts=True, limit=1)
            self.assertEqual(len(calls), 1)  # an edit: counted again, and the edit is in the chart
            self.assertEqual(status(after).get("Diuji cache"), 1)
        finally:
            ontology_live._Rel.histograms = orig

    def test_filters_sort_page_and_aggregation_match_pandas(self):
        df = self.df
        r = self.search(object_type_id=self.klaim["id"], histograms=True, sort="biaya_tagih_rp", order="desc", limit=5,
                        filters=[{"property": "inacbg_kode", "op": "in", "value": ["F-4-10-I", "O-6-10-I"]},
                                 {"property": "los_hari", "op": "between", "value": [10, 30]},
                                 {"op": "or", "property": "", "value": [{"property": "rawat_inap", "op": "eq", "value": True},
                                                                        {"property": "biaya_tagih_rp", "op": "gt", "value": 25_000_000}]}],
                        aggregate={"metric": "sum", "property": "biaya_tagih_rp", "group_by": "inacbg_kode"})
        want = df[df.inacbg_kode.isin(["F-4-10-I", "O-6-10-I"]) & df.los_hari.between(10, 30) & (df.rawat_inap | (df.biaya_tagih_rp > 25_000_000))]
        self.assertEqual(r["total"], len(want))
        self.assertEqual(r["execution"], "live")
        self.assertEqual([o["primary_key"] for o in r["objects"]], want.sort_values(["biaya_tagih_rp", "klaim_id"], ascending=[False, True]).klaim_id.head(5).tolist())
        sums = {g["group"]: g["value"] for g in r["aggregation"]["groups"]}
        self.assertAlmostEqual(sums["F-4-10-I"], want[want.inacbg_kode == "F-4-10-I"].biaya_tagih_rp.sum(), places=2)
        kode = next(h for h in r["histograms"] if h["property"] == "inacbg_kode")
        self.assertEqual(sum(b["count"] for b in kode["buckets"]), len(want))
        r = self.search(object_type_id=self.klaim["id"], q="Q-5-44-0", histograms=False, limit=1)
        self.assertEqual(r["total"], int((df.inacbg_kode == "Q-5-44-0").sum()))
        # a keyword is a whole word or code: J-4-16-I is not J-4-16-II; a trailing * extends it
        self.assertEqual(self.search(object_type_id=self.klaim["id"], q="J-4-16-I", histograms=False, limit=1)["total"], 0)
        self.assertEqual(self.search(object_type_id=self.klaim["id"], q="J-4-16-I*", histograms=False, limit=1)["total"], int((df.inacbg_kode == "J-4-16-II").sum()))
        los = next(h for h in r["histograms"] if h["property"] == "los_hari") if r["histograms"] else None
        self.assertIsNone(los)  # (histograms off)
        h = {x["property"]: x for x in self.search(object_type_id=self.klaim["id"], histograms=True, limit=1)["histograms"]}
        self.assertEqual(sum(b["count"] for b in h["los_hari"]["buckets"]), N)
        self.assertEqual({b["value"]: b["count"] for b in h["inacbg_kode"]["buckets"]}, df.inacbg_kode.value_counts().to_dict())
        self.assertEqual(sum(b["count"] for b in h["tgl_pulang"]["buckets"]), N)
        r = self.search(object_type_id=self.klaim["id"], filters=[{"property": "faskes_id", "op": "is_null"}], histograms=False)
        self.assertEqual(r["total"], int(df.faskes_id.isna().sum()))

    def test_search_arounds_both_ways(self):
        df = self.df
        # indexed facilities → their live claims (reverse of the claims' foreign key)
        r = self.search(object_type_id=self.faskes["id"], filters=[{"property": "faskes_id", "op": "in", "value": ["F01", "F02"]}],
                        search_around=[{"link_type_id": self.lt["id"], "direction": "reverse",
                                        "filters": [{"property": "rawat_inap", "op": "eq", "value": True}]}], histograms=False)
        self.assertEqual(r["total"], int((df.faskes_id.isin(["F01", "F02"]) & df.rawat_inap).sum()))
        self.assertEqual(r["result_type"]["id"], self.klaim["id"])
        # live claims → the facilities they name (forward)
        r = self.search(object_type_id=self.klaim["id"], filters=[{"property": "los_hari", "op": "eq", "value": 59}, {"property": "inacbg_kode", "op": "eq", "value": "F-4-10-I"}],
                        search_around=[{"link_type_id": self.lt["id"], "direction": "forward"}], histograms=False)
        self.assertEqual(r["total"], df[(df.los_hari == 59) & (df.inacbg_kode == "F-4-10-I")].faskes_id.dropna().nunique())

    def test_object_links_and_linked_map(self):
        import ontology_model as om

        links = om._object_links(self.faskes["id"], "F03", limit=10)
        claims = next(x for x in links if x["object_type_id"] == self.klaim["id"])
        self.assertEqual(claims["count"], int((self.df.faskes_id == "F03").sum()))
        self.assertEqual(len(claims["objects"]), 10)
        fwd = om.linked_map(self.lt, "forward", {"K000001", "K000097"})
        self.assertEqual(fwd.get("K000001"), [self.df.iloc[1].faskes_id])
        self.assertNotIn("K000097", fwd)  # no facility on that claim
        with self.assertRaises(HTTPException):
            om._pairs(self.lt)  # every pair of 120,000 claims: refused, not loaded


if __name__ == "__main__":
    unittest.main()
