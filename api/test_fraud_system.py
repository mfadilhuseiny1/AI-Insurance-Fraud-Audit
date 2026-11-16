"""The fraud system's own logic, tested on real inputs (the judges' payloads, the real silver claims and feature table when
present): the request contract, the clinical review's number gate and fallback, the data contract, drift, the ONNX
export's parity, the training-serving parity of the online features, the pilot's interval.

    python -m pytest test_fraud_system.py -q
"""

from __future__ import annotations

import json
import pickle
import tempfile
import unittest
from pathlib import Path

import duckdb
import numpy as np

from aip import layanan as L
from aip import medis
from aip import produksi as P
from aip import semantik as S

ROOT = Path(__file__).resolve().parent.parent
MOCK = json.loads((ROOT / "healthkathon" / "inference-api" / "mock_payloads.json").read_text("utf-8"))
SILVER = ROOT / "data" / "drive" / "217f2b804b0c4525"
CURRENT = ROOT / "data" / "aip" / "ml" / "current.json"


def _cache() -> Path | None:
    hits = sorted((ROOT / "data" / "aip" / "ml" / "cache").glob("fitur-*.parquet")) if (ROOT / "data" / "aip" / "ml" / "cache").is_dir() else []
    return hits[-1] if hits else None


class Contract(unittest.TestCase):
    def test_the_judges_payloads_pass_the_flat_contract(self):
        for name in ("legitimate_claim", "fraud_upcoding_claim"):
            c = L.ClaimDataJuri.model_validate(MOCK[name])
            self.assertEqual(c.claim_id, MOCK[name]["claim_id"])

    def test_bad_payloads_are_refused_with_the_field_named(self):
        bad = [{**MOCK["legitimate_claim"], "claimed_cost": -1}, {**MOCK["legitimate_claim"], "length_of_stay_days": 401},
               {**MOCK["legitimate_claim"], "ina_cbg_code": "I410II"}, {**MOCK["legitimate_claim"], "primary_diagnosis": "21.0"},
               {**MOCK["legitimate_claim"], "unknown_field": 1}]
        for body in bad:
            with self.assertRaises(Exception, msg=str(body)[:80]):
                L.ClaimDataJuri.model_validate(body)

    def test_the_claims_contract_refuses_a_discharge_before_admission(self):
        base = {"kunjungan_fkrtl_id": "X1", "peserta_id": 1, "tgl_datang": "2025-03-10", "tgl_pulang": "2025-03-09", "kabkota_fkrtl_kode": 3201,
                "kepemilikan_fkrtl": "Swasta", "jenis_fkrtl": "Rumah sakit", "tingkat_pelayanan": "RITL", "dx_primer_icd3": "I21",
                "inacbg_kode": "I-4-10-II", "biaya_tagih_rp": 1000}
        with self.assertRaises(Exception):
            L.KlaimIn.model_validate(base)
        L.KlaimIn.model_validate({**base, "tgl_pulang": "2025-03-12"})

    def test_a_facility_profile_key_matches_the_batch_definition(self):
        # md5(concat_ws('|', 'FKRTL', kab/kota, ownership, kind, type)) — DuckDB's, as prepare() computes it; missing parts left out
        c = L.KlaimIn.model_validate({"kunjungan_fkrtl_id": "X1", "peserta_id": 1, "tgl_datang": "2025-03-10", "kabkota_fkrtl_kode": 3201,
                                      "kepemilikan_fkrtl": "Swasta", "jenis_fkrtl": "Rumah sakit", "tipe_fkrtl": None, "tingkat_pelayanan": "RJTL",
                                      "dx_primer_icd3": "I21", "inacbg_kode": "Q-5-44-0", "biaya_tagih_rp": 1000})
        want = duckdb.sql("SELECT md5(concat_ws('|', 'FKRTL', 3201, 'Swasta', 'Rumah sakit', NULL))").fetchone()[0]
        self.assertEqual(L.profile_id(c), want)


class NumberGate(unittest.TestCase):
    facts = {"klaim": {"lama_rawat_hari": 182}, "biaya": {"tarif_inacbg_rp": 3150000, "tagihan_rp": 18450000},
             "pembanding": {"los_median_kode": 14.0, "los_p90_kode": 36.0, "rasio_los_terhadap_p90": 5.06, "rasio_tagihan_terhadap_tarif": 5.86},
             "model": {"risiko_pct": 0.0007, "ambang_pct": 9.4353}}

    def test_numbers_from_the_facts_pass_in_indonesian_notation(self):
        text = "Lama rawat 182 hari (5,06× p90, median 14 hari); tagihan Rp 18.450.000 = 5,86 kali tarif Rp 3.150.000; ambang 9,4353%."
        self.assertEqual(medis.unverified(text, self.facts), [])

    def test_scaled_amounts_are_read_with_their_scale(self):
        self.assertEqual(medis.unverified("tagihan Rp 18,45 juta", self.facts), [])

    def test_an_invented_number_is_caught(self):
        self.assertEqual(medis.unverified("tagihan 7,3 kali tarif dan rawat 95 hari", self.facts), ["7,3", "95"])

    def test_codes_and_small_counts_are_not_numbers_to_check(self):
        self.assertEqual(medis.unverified("kode I-4-10-II, diagnosis A41.9 dan K35; 2 diagnosis sekunder", self.facts), [])

    def test_the_deterministic_fallback_passes_its_own_gate(self):
        facts = medis.facts_from_row({"edisi": "reguler", "kunjungan_fkrtl_id": "X", "los_hari": 182, "tarif_inacbg_rp": 3150000, "biaya_tagih_rp": 18450000,
                                      "tingkat_pelayanan": "RITL"}, {"los_median_kode": 14.0, "los_p90_kode": 36.0},
                                     {"model": "CatBoost", "risiko_pct": 12.5, "ambang_pct": 9.44, "kelipatan_ambang": 1.32, "ditandai_model": True,
                                      "alasan_model": [{"fitur": "LOS / median kode", "nilai": "13,00×", "umumnya": "1,00×"}]},
                                     [{"tag": "LOS_DIPERPANJANG", "label": "Lama rawat diperpanjang", "bukti": "LOS 182 hari > 2× p90 kodenya (36 hari)"}])
        r = medis.fallback(facts, "uji")
        self.assertIn(r["kesimpulan"], medis.CONCLUSIONS)
        self.assertEqual(r["kesimpulan"], "mencurigakan")
        self.assertTrue(r["lolos_gerbang_angka"], r["angka_tidak_terverifikasi"])


class Semantic(unittest.TestCase):
    def test_a_measure_on_a_dimension_its_type_lacks_is_refused_with_the_valid_ones(self):
        with self.assertRaisesRegex(ValueError, "dimensi yang berlaku"):
            S.query("klaim_calon_ganda", "segmen_model")

    def test_semantic_filters_become_the_types_own_properties(self):
        q = S.query("berisiko_lolos_verifikasi", "provinsi", [{"dimensi": "tipe_faskes", "op": "eq", "nilai": "RS Kelas B"}])
        self.assertEqual(q["aggregate"]["group_by"], "provinsi")
        self.assertIn({"property": "tipe_fkrtl", "op": "eq", "value": "RS Kelas B"}, q["filters"])

    def test_auditors_words_resolve_to_tags_and_measures(self):
        self.assertEqual(S.resolve("upcoding")[0]["ke"], "UPCODING_KEPARAHAN")
        self.assertIn("KLAIM_GANDA", [h["nama"] for h in S.resolve("klaim ganda")])


@unittest.skipUnless(SILVER.is_file(), "silver claims not on this machine")
class DataContract(unittest.TestCase):
    def setUp(self):
        self.con = duckdb.connect()
        self.con.execute(f"CREATE TABLE src AS SELECT * FROM read_parquet('{SILVER.as_posix()}') USING SAMPLE 20000 ROWS (reservoir, 1)")

    def test_the_real_claims_pass_every_blocking_check(self):
        self.con.execute("CREATE VIEW k AS SELECT * FROM src")
        bad = [c for c in P.validate_source(self.con) if c["status"] == "gagal"]
        self.assertEqual(bad, [])

    def test_corrupted_claims_fail_the_blocking_checks(self):
        self.con.execute("""CREATE VIEW k AS SELECT * REPLACE (CASE WHEN row_number() OVER () % 50 = 0 THEN -biaya_tagih_rp ELSE biaya_tagih_rp END AS biaya_tagih_rp,
                            CASE WHEN row_number() OVER () % 40 = 0 THEN 'Puskesmas' ELSE jenis_fkrtl END AS jenis_fkrtl) FROM src
                            UNION ALL SELECT * FROM (SELECT * FROM src LIMIT 10)""")
        failed = {c["id"] for c in P.validate_source(self.con) if c["status"] == "gagal"}
        self.assertTrue({"kunci_unik", "biaya_non_negatif", "jenis_domain"} <= failed, failed)


@unittest.skipUnless(_cache() is not None, "feature table not on this machine")
class DriftAndParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.con = duckdb.connect()
        cls.con.execute(f"CREATE VIEW fitur AS SELECT * FROM read_parquet('{_cache().as_posix()}')")

    def test_the_same_data_does_not_drift_and_a_shifted_bill_blocks(self):
        ref = P.reference(self.con, ["biaya_tagih", "los"], ["tingkat_pelayanan"])
        self.assertLess(max(r["psi"] for r in P.drift(self.con, ref)), 0.01)
        self.con.execute(f"CREATE OR REPLACE VIEW geser AS SELECT * REPLACE (biaya_tagih * 1.4 AS biaya_tagih) FROM read_parquet('{_cache().as_posix()}')")
        rows = P.drift(self.con, ref, table="geser")
        checks = {c["id"]: c for c in P.drift_checks(rows, {"biaya_tagih"})}
        self.assertEqual(checks["drift_biaya_tagih"]["status"], "gagal")
        self.assertEqual(checks["drift_los"]["status"], "lulus")

    def test_onnx_matches_the_native_model_on_real_claims(self):
        import ml_klaim as M

        df = self.con.execute(f"SELECT {', '.join(M.FEATURES)}, y FROM fitur USING SAMPLE 6000 ROWS (reservoir, 3)").df()
        enc = M.Encoder().fit(df)
        from sklearn.ensemble import HistGradientBoostingClassifier

        y = (df["y"].to_numpy() if df["y"].sum() >= 5 else (df["los"].fillna(0).to_numpy() > df["los"].median()).astype(int))
        model = HistGradientBoostingClassifier(max_iter=40, random_state=0).fit(enc.transform(df), y)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "m.onnx"
            P.to_onnx(model, "HistGradientBoosting", len(M.NUM) + len(M.CAT_LOW), path)
            import onnxruntime as ort

            sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            X = enc.transform(df.head(1000))
            diff = np.max(np.abs(model.predict_proba(X)[:, 1] - P.onnx_proba(sess, X.to_numpy(np.float32))))
        self.assertLess(diff, P.PARITY_TOL)

    @unittest.skipUnless(SILVER.is_file() and CURRENT.is_file(), "silver claims or the model not on this machine")
    def test_online_features_equal_the_batch_features_of_held_out_real_claims(self):
        import ml_klaim as M

        cur = json.loads(CURRENT.read_text("utf-8"))
        segments = pickle.loads((ROOT / "data" / "aip" / "ml" / "versions" / cur["version"] / "model.pkl").read_bytes())["segments"]
        self.con.execute(f"CREATE OR REPLACE VIEW k AS SELECT * FROM read_parquet('{SILVER.as_posix()}')")
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            store = {}
            for name, sql in {"ref_kode": "SELECT inacbg_kode, median(los) AS med_los, quantile_cont(los, 0.9) AS p90_los, median(tarif_inacbg) AS med_tarif, "
                                          "count(*) AS frek_kode FROM fitur GROUP BY 1",
                              "ref_dx": "SELECT dx_primer_icd3, avg((inacbg_keparahan LIKE 'Berat%')::INT) FILTER (WHERE tingkat_pelayanan = 'RITL') AS p_berat_dx, "
                                        "avg((inacbg_tipe_kasus LIKE 'Prosedur%')::INT) AS p_prosedur_dx, count(*) AS frek_dx FROM fitur GROUP BY 1",
                              "faskes": "SELECT faskes_profil_id, " + ", ".join(f"any_value({c}) AS {c}" for c in M.FASKES) +
                                        " FROM fitur GROUP BY 1"}.items():
                path = (work / f"{name}.parquet").as_posix()
                self.con.execute(f"COPY ({sql}) TO '{path}' (FORMAT parquet)")
                store[name] = path
            par = L.online_parity(self.con, store, work, segments, n=150)
        self.assertGreaterEqual(par["dibandingkan"], 140)
        self.assertEqual(par["fitur_cocok_min"], 1.0, par["fitur_terburuk"])
        self.assertLess(par["skor_max_abs"], 1e-9)


class Pilot(unittest.TestCase):
    def test_wilson_intervals(self):
        from aip import karantina

        p, lo, hi = karantina.wilson(0, 30)
        self.assertEqual(p, 0.0)
        self.assertEqual(lo, 0.0)
        self.assertAlmostEqual(hi, 0.1135, places=3)  # the rule of three's neighbour: 0 of 30 still allows ~11%
        p, lo, hi = karantina.wilson(15, 30)
        self.assertAlmostEqual(lo, 0.3315, places=3)
        self.assertAlmostEqual(hi, 0.6685, places=3)


class DesignedAuditExhibit(unittest.TestCase):
    """The report's designed-audit exhibit (laporan_konsultan._designed_audit): before any outcome the design alone; then
    precision and the random slice with Wilson intervals, the no-change rate, the misses weighted by 1/chance of
    selection, lift and recall, all in code-written facts the commentary gate checks against."""

    @staticmethod
    def _pilot(outcomes: dict) -> dict:
        s = [{"faskes_profil_id": f"f{i}", "lengan": "ditandai" if i < 30 else "acak", "kode": f"AUD-{i:03d}", "terbukti": None, "nilai_rp": None} for i in range(60)]
        for i, (t, v) in outcomes.items():
            s[i].update(terbukti=t, nilai_rp=v)
        return {"id": "pilot-uji", "seed": 2026, "ditandai": 30, "acak": 30, "populasi_lain": 2482, "sampel": s}

    def test_design_then_outcomes(self):
        from aip import karantina
        from aip import laporan_konsultan as L

        real, karantina._load = karantina._load, (lambda: {})
        try:
            empty = L._designed_audit(self._pilot({}))
            oc = {i: (i < 12, 50_000_000 if i < 12 else 0) for i in range(30)} | {30 + i: (i < 2, 20_000_000 if i < 2 else 0) for i in range(30)}
            full = L._designed_audit(self._pilot(oc))
        finally:
            karantina._load = real
        self.assertIn("menunggu hasil auditor", empty["judul"])
        self.assertEqual((empty["bab"], empty["jenis"]), ("keandalan", "checks"))
        # before any outcome the chart is the audit's progress, not "0 dari 0 terbukti"
        self.assertEqual([(r["uji"].split(": ")[1], r["lolos"], r["total"]) for r in empty["baris"]], [("sudah diaudit", 0, 30)] * 2)
        self.assertEqual([(r["lolos"], r["total"]) for r in full["baris"]], [(12, 30), (2, 30)])
        text = " ".join(full["fakta"])
        for piece in ("40,0%, IK 95% 24,6–57,7%", "no-change rate 60,0%", "perkiraan 165 faskes", "6,0×", "recall faskes 6,8%", "Horvitz–Thompson"):
            self.assertIn(piece, text)


class BoxRebuild(unittest.TestCase):
    """A rebuild's box is the facilities that qualify now: before 2026-10-28 the old rows stayed (1,400 listed, summary
    1,379), and every reader of the box (its list, Nexus, the report's exhibits, the pilot's draw) saw them."""

    def test_a_facility_no_one_acted_on_leaves_when_it_no_longer_qualifies(self):
        from aip import karantina

        old = {"a": {"status": "karantina"}, "b": {"status": "diaudit"}, "c": {"status": "karantina", "rekomendasi": [{"jalur": "dibina"}]},
               "d": {"status": "karantina", "keputusan": {"jalur": "dibebaskan"}}, "e": {"status": "karantina"}}
        self.assertEqual(karantina._leaving(old, {"e"}), ["a"])

    def test_the_store_drops_and_writes_in_one_go(self):
        import sqlite3

        from aip import karantina

        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE karantina (faskes TEXT PRIMARY KEY, rec TEXT, updated TEXT)")
        con.executemany("INSERT INTO karantina VALUES (?, '{}', 't0')", [("a",), ("b",)])
        real, karantina._db = karantina._db, lambda: con
        try:
            karantina._store([{"faskes_profil_id": "b", "diperbarui_pada": "t1"}, {"faskes_profil_id": "c", "diperbarui_pada": "t1"}], drop=["a"])
        finally:
            karantina._db = real
        self.assertEqual([r for (r,) in con.execute("SELECT faskes FROM karantina ORDER BY 1")], ["b", "c"])


class RejectedTags(unittest.TestCase):
    """A tag a person rejected stays in the ledger with its decision and counts for nothing: before 2026-10-28 the 13
    rejected COVID cloning tags still sized the firm, the box and the tag summary the report quotes."""

    def setUp(self):
        from unittest import mock

        from aip import indikasi as I
        from aip import karantina as K

        recs = {"t1": {"id": "t1", "tag": "KLONING_KLAIM", "entitas": "klaim", "kunci": "k1", "status": "terbuka"},
                "t2": {"id": "t2", "tag": "KLONING_KLAIM", "entitas": "klaim", "kunci": "covid:k2", "status": "ditolak"},
                "t3": {"id": "t3", "tag": "LOS_DIPERPANJANG", "entitas": "klaim", "kunci": "k3", "status": "dikonfirmasi"}}
        for r in recs.values():
            r.update(sumber=[{"agen": "penanda_otomatis", "kekuatan": "sedang", "bukti": "x"}], konteks={}, judul=r["kunci"], diperbarui_pada="t0")
        for p in (mock.patch.object(I, "_all", lambda: recs), mock.patch.object(I, "_state", lambda: {}),
                  mock.patch.object(I, "_viewer_markings", lambda: None), mock.patch.object(K, "_load", lambda: {})):
            p.start()
            self.addCleanup(p.stop)

    def test_the_firm_is_sized_by_the_tags_that_stand(self):
        from aip import konsultan

        per, strong, _ = konsultan._signals()
        self.assertEqual((per, strong), ({"KLONING_KLAIM": 1, "LOS_DIPERPANJANG": 1}, 1))  # the confirmed tag is strong

    def test_the_summary_counts_the_rejected_apart(self):
        from aip import indikasi as I

        s = I.summary()
        self.assertEqual((s["total"], s["ditolak"], {t["tag"]: t["total"] for t in s["per_tag"]}), (2, 1, {"KLONING_KLAIM": 1, "LOS_DIPERPANJANG": 1}))
        self.assertEqual(I.list_tags(status="ditolak")["total"], 1)  # the listing still shows it, with its decision


class ClaimLoss(unittest.TestCase):
    """The box's rule for one tagged claim, shared by the box and the estimate of any set of claims (POST
    /api/aip/karantina/estimasi): a corrected claim is recovered, not lost; else its largest component."""

    PEER = {"peer_klaim": 40, "peer_biaya_p50_rp": 1_000_000}

    def test_a_corrected_claim_is_recovered(self):
        from aip import karantina

        c = karantina.claim_loss("K1", {"flag_selisih_verifikasi": True, "selisih_rp": 250_000, "biaya_tagih_rp": 3_000_000, **self.PEER}, {}, set(), 0.2)
        self.assertEqual((c["dikoreksi"], c["selisih"], c["parts"]), (True, 250_000, {}))

    def test_paid_above_the_peer_band_and_half_a_duplicate(self):
        from aip import karantina

        k = {"biaya_tagih_rp": 3_000_000, "biaya_verifikasi_rp": 2_800_000, **self.PEER}
        c = karantina.claim_loss("K2", k, {}, set(), 0.2)
        self.assertEqual(c["parts"]["di_atas_peer"], 2_800_000 - 1.5 * 1_000_000)  # what was paid, above 1.5x the median
        c = karantina.claim_loss("K2", k, {}, {"KLAIM_GANDA"}, 0.2)
        self.assertEqual(max(c["parts"].values()), 0.5 * 2_800_000)

    def test_the_audit_pack_scope_is_a_claims_filter(self):
        from aip import paket

        f, words, tag = paket.scope_filters({"provinsi": "jawa tengah", "inacbg_kode": "o-6-10-i", "diagnosis": "J18.9", "flag": ["los_ekstrem", "x"],
                                             "modus": "upcoding"}, {}, [])
        self.assertIn({"property": "provinsi", "op": "eq", "value": "JAWA TENGAH"}, f)
        self.assertIn({"property": "inacbg_kode", "op": "eq", "value": "O-6-10-I"}, f)
        self.assertIn({"property": "dx_primer_icd3", "op": "eq", "value": "J18"}, f)  # a code: its ICD-10 category
        self.assertIn({"property": "flag_los_ekstrem", "op": "eq", "value": True}, f)
        self.assertEqual(len(f), 4)  # an unknown flag adds nothing
        self.assertEqual(tag, "UPCODING_KEPARAHAN")
        self.assertIn("LOS ekstrem", words)
        f, _, _ = paket.scope_filters({"diagnosis": "pneumonia"}, {}, [])
        self.assertEqual(f, [{"property": "dx_primer_nama", "op": "contains", "value": "pneumonia"}])

    def test_a_karantina_group_scope(self):
        from aip import paket

        self.assertEqual(paket._groups("a, B/x"), ["A", "B"])  # an unknown group is no group
        self.assertEqual(paket._groups(["z"]), ["Z"])
        _, words, _ = paket.scope_filters({"kelompok": "A"}, {}, [])
        self.assertIn("Box Karantina kelompok A", words)

    def test_an_engagements_result_ids_are_not_this_runs(self):
        from aip import paket

        self.assertEqual(paket._clean("107 klaim [r22/r85] dan 734 [r17], RS Sragen [r31/r37/r36/r19].", 200), "107 klaim dan 734, RS Sragen.")

    def test_no_peer_yardstick_for_a_covid_claim(self):
        from aip import karantina

        c = karantina.claim_loss("ICC-9", {"biaya_tagih_rp": 9_000_000, **self.PEER}, {}, set(), 0.2)
        self.assertEqual(c["parts"]["di_atas_peer"], 0.0)

    def test_billed_beyond_the_ina_cbg_tariff(self):
        from aip import karantina

        # the long psychiatric stay of the sample: package 5,019,500 + sub-acute top-up 13,071,200, billed 28,244,300
        k = {"biaya_tagih_rp": 28_244_300, "biaya_verifikasi_rp": 28_244_300, "peer_klaim": 80, "peer_biaya_p50_rp": 5_807_400,
             "sisa_di_luar_tarif_rp": 10_153_600}
        c = karantina.claim_loss("reguler:180760723V000263", k, {}, set(), 0.2)
        self.assertEqual(c["parts"]["di_atas_tarif"], 10_153_600)
        self.assertEqual(c["parts"]["di_atas_peer"], 28_244_300 - 1.5 * 5_807_400)
        # rounding is no amount beyond the tariff; the COVID scheme has no INA-CBG tariff to be beyond
        self.assertEqual(karantina.claim_loss("K3", {**k, "sisa_di_luar_tarif_rp": 4}, {}, set(), 0.2)["parts"]["di_atas_tarif"], 0.0)
        self.assertEqual(karantina.claim_loss("ICC-3", k, {}, set(), 0.2)["parts"]["di_atas_tarif"], 0.0)


if __name__ == "__main__":
    unittest.main()
