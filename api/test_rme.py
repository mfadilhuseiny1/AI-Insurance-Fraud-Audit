"""The electronic-medical-record cross-check (aip/realtime/rme.py) and its integration. Synthetic data only.

Run: ..\\.venv\\Scripts\\python.exe -I -m pytest -q test_rme.py   (from api/)
"""
from __future__ import annotations

import math
import random
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aip.realtime import aktif as AK  # noqa: E402
from aip.realtime import modus as MO  # noqa: E402
from aip.realtime import rme as R  # noqa: E402
from aip.realtime import rme_batch as RB  # noqa: E402
from aip.realtime import rme_sintetis as RS  # noqa: E402

KATETER = {"id": "T1", "tgl_datang": date(2024, 12, 20), "tgl_pulang": date(2024, 12, 23), "tingkat": "RITL", "poli": None, "dx_utama": "I25.1",
           "dx_sekunder": ["I10"], "tindakan": ["3723 - Combined right and left heart cardiac catheterization", "0066 - PTCA",
                                                "3607 - Insertion of drug-eluting coronary artery stent(s)", "8952 - Electrocardiogram"],
           "sd_tarif_rp": 0, "rr_tarif_rp": 0, "obat": []}
NAPAS = {"id": "T2", "tgl_datang": date(2024, 12, 18), "tgl_pulang": date(2024, 12, 24), "tingkat": "RITL", "dx_utama": "J18.9",
         "dx_sekunder": ["J96.0", "E87.1"], "tindakan": ["9671 - Continuous mechanical ventilation for less than 96 consecutive hours"],
         "sd_tarif_rp": 0, "rr_tarif_rp": 0}
PESERTA = {"jk": "L", "tgl_lahir": "1962-05-01"}


def cek(k: dict, varian: str, seed: int = 1, **kv) -> tuple[set, float, dict]:
    b = RS.bundel(k, varian, random.Random(seed), PESERTA, **kv)
    h = R.periksa(k, R.baca(b), "F", PESERTA)
    sc, _, _ = RB.skor(h["sinyal"])
    return {s["kode"] for s in h["sinyal"]}, sc, h


class Kode(unittest.TestCase):
    def test_icd(self):
        self.assertEqual(R.icd9("3723 - Combined right and left heart"), "3723")
        self.assertEqual(R.icd9("37.23"), "3723")
        self.assertEqual(R.icd9("96.04 Intubasi"), "9604")
        self.assertEqual(R.icd9("740"), "740")
        self.assertIsNone(R.icd9("Intubasi"))
        self.assertEqual(R.icd10("j18.9"), "J189")
        self.assertEqual(R.icd10("I25"), "I25")
        self.assertEqual(R.grup_tindakan("3607"), "pci")
        self.assertEqual(R.grup_tindakan("3722"), "kateterisasi_jantung")
        self.assertTrue(R.bermakna("3723") and R.bermakna("4701") and R.bermakna("9904"))
        self.assertFalse(R.bermakna("8952") or R.bermakna("9319"))  # an ECG and physiotherapy are not checked for absence


class Aturan(unittest.TestCase):
    def test_sesuai_tanpa_temuan(self):
        for k in (KATETER, NAPAS):
            kodes, sc, h = cek(k, "sesuai")
            self.assertEqual(kodes, set(), h["sinyal"])
            self.assertTrue(any(r["status"] == "cocok" for r in h["hasil"]))

    def test_kateter_fiktif_permintaan_bpjs(self):
        """The BPJS example: cardiac catheterisation billed, none in the record, blood pressure and saturation normal."""
        kodes, sc, h = cek(KATETER, "tindakan_fiktif")
        self.assertIn("RME_TINDAKAN_TIDAK_TERCATAT", kodes)
        self.assertIn("RME_KLINIS_TIDAK_MENDUKUNG", kodes)
        self.assertGreaterEqual(sc, 75)
        s = next(x for x in h["sinyal"] if x["kode"] == "RME_KLINIS_TIDAK_MENDUKUNG")
        self.assertIn("saturasi oksigen", s["bukti"])
        self.assertIn("tekanan darah", s["bukti"])
        # three codes of one PCI make one finding, not three
        self.assertEqual(sum(1 for x in h["sinyal"] if x["kode"] == "RME_TINDAKAN_TIDAK_TERCATAT"), 1)
        # every billed procedure is checked (the IG codes even a chest X-ray as a Procedure); a minor one is marked lighter
        ekg = next(r for r in h["hasil"] if "89.52" in r["klaim"])
        self.assertEqual(ekg["status"], "tidak_ada")
        self.assertIn("minor", ekg["catatan"])

    def test_tindakan_minor_saja_lemah(self):
        """Only a minor examination missing: recorded, but not enough to flag the claim alone."""
        k = {**KATETER, "dx_utama": "I25.1", "tindakan": ["8952 - Electrocardiogram"]}
        b = RS.bundel({**k, "tindakan": []}, "sesuai", random.Random(8), PESERTA)
        h = R.periksa(k, R.baca(b), "F", PESERTA)
        s = next(x for x in h["sinyal"] if x["kode"] == "RME_TINDAKAN_TIDAK_TERCATAT")
        self.assertLess(s["s"], 0.5)
        self.assertLess(RB.skor(h["sinyal"])[0], 45)

    def test_dua_kunjungan_hari_sama(self):
        """Two outpatient visits the same day are two encounters: the second claim takes the encounter not yet billed."""
        k = {"id": "A", "tgl_datang": date(2024, 12, 20), "tgl_pulang": date(2024, 12, 20), "tingkat": "RJTL", "dx_utama": "I10", "tindakan": []}
        b1 = RS.bundel(k, "sesuai", random.Random(1), PESERTA)
        b2 = RS.bundel({**k, "id": "B"}, "sesuai", random.Random(2), PESERTA)
        bundle = {"resourceType": "Bundle", "entry": b1["entry"] + [e for e in b2["entry"] if e["resource"]["resourceType"] != "Patient"]}
        r = R.baca(bundle)
        h1 = R.periksa(k, r, "F", PESERTA)
        used = {h1["kunjungan"]["kunci"]}
        h2 = R.periksa({**k, "id": "B"}, r, "F", PESERTA, used)
        self.assertNotEqual(h1["kunjungan"]["kunci"], h2["kunjungan"]["kunci"])

    def test_diagnosis_dibantah(self):
        kodes, sc, h = cek(NAPAS, "dx_tidak_didukung")
        self.assertIn("RME_DIAGNOSIS_TIDAK_DIDUKUNG", kodes)
        s = next(x for x in h["sinyal"] if x["kode"] == "RME_DIAGNOSIS_TIDAK_DIDUKUNG")
        self.assertIn("gagal napas", s["bukti"])

    def test_kunjungan_los_jenis_pasien(self):
        self.assertEqual(cek(KATETER, "kunjungan_fiktif")[0], {"RME_KUNJUNGAN_TIDAK_ADA"})
        self.assertIn("RME_LOS_TIDAK_SESUAI", cek(NAPAS, "los", kurang=3)[0])
        self.assertIn("RME_JENIS_RAWAT_BERBEDA", cek(NAPAS, "rawat_jalan")[0])
        self.assertIn("RME_PASIEN_BERBEDA", cek(NAPAS, "pasien_berbeda")[0])

    def test_kerangka_dimitigasi(self):
        kodes, sc, h = cek(KATETER, "kerangka")
        s = next(x for x in h["sinyal"] if x["kode"] == "RME_TINDAKAN_TIDAK_TERCATAT")
        self.assertIn("RME_KERANGKA", [m["kode"] for m in s["mitigasi"]])

    def test_indikasi_ada_tanpa_temuan_klinis(self):
        """An elective catheterisation for documented angina with normal vital signs is not flagged for indication."""
        k = {**KATETER, "dx_utama": "I20.8"}
        b = RS.bundel(k, "sesuai", random.Random(5), PESERTA)
        b["entry"] = [e for e in b["entry"] if not (e["resource"]["resourceType"] == "Observation"
                                                    and e["resource"]["code"]["coding"][0]["code"] in ("11524-6", "89579-7"))]
        h = R.periksa(k, R.baca(b), "F", PESERTA)
        self.assertNotIn("RME_KLINIS_TIDAK_MENDUKUNG", {s["kode"] for s in h["sinyal"]})

    def test_tanpa_rekam_medis_tanpa_temuan(self):
        self.assertEqual(R.lewati("tidak dikirim")["sinyal"], [])
        r = R.baca({"resourceType": "Bundle", "entry": []})
        self.assertFalse(r["ok"])
        self.assertEqual(R.periksa(KATETER, r, "F")["sinyal"], [])

    def test_format_rs_ai_jkn(self):
        """The hospital-side export (ai-jkn lib/faskes/fhir.ts) links observations by encounter.identifier and uses effectivePeriod."""
        b = {"resourceType": "Bundle", "type": "collection", "entry": [
            {"resource": {"resourceType": "Encounter", "id": "e1", "identifier": [{"system": "urn:ai-jkn:episode", "value": "EP-9"}], "status": "finished",
                          "class": {"code": "IMP"}, "period": {"start": "2024-12-18T08:00:00Z", "end": "2024-12-24T10:00:00Z"}}},
            {"resource": {"resourceType": "Observation", "status": "final", "code": {"coding": [{"system": R.SYS_LOINC, "code": "59408-5"}]},
                          "encounter": {"identifier": {"system": "urn:ai-jkn:episode", "value": "EP-9"}},
                          "effectivePeriod": {"start": "2024-12-18T09:00:00Z"}, "valueQuantity": {"value": 86, "unit": "%"}}},
            {"resource": {"resourceType": "Observation", "status": "final", "code": {"coding": [{"system": "urn:ai-jkn:iomt-metric", "code": "ventilation_active"}]},
                          "encounter": {"identifier": {"value": "EP-9"}}, "effectivePeriod": {"start": "2024-12-18T10:00:00Z"}, "valueBoolean": True}}]}
        r = R.baca(b)
        self.assertTrue(r["ok"])
        self.assertEqual(r["observasi"][0]["enc"], "e1")
        self.assertEqual(r["observasi"][0]["abn"], "L")
        self.assertTrue(any(a["nama"] == "ventilator" for a in r["alat"]))
        h = R.periksa(NAPAS, r, "F")
        tind = [x for x in h["hasil"] if x["aspek"] == "Tindakan"]
        self.assertTrue(tind and tind[0]["status"] == "info", tind)  # ventilation evidenced by the device, no Procedure

    def test_validasi_dan_skema(self):
        b = RS.bundel(KATETER, "sesuai", random.Random(2), PESERTA)
        v = R.validasi(b)
        self.assertTrue(v["diterima"])
        self.assertNotIn("skor", v)
        sch = R.json_schema()
        self.assertEqual(sch["properties"]["resourceType"]["const"], "Bundle")
        self.assertIn("Procedure", sch["$defs"])
        try:
            import jsonschema
        except ImportError:
            return
        jsonschema.validate(b, sch)


class Integrasi(unittest.TestCase):
    def test_ruang_fitur_beku(self):
        """New RME signals must not shift the models' feature vector (ML v7, the adaptive champion)."""
        self.assertEqual(len(AK.CODES), 45)
        self.assertTrue(all(not c.startswith("RME_") for c in AK.CODES))
        self.assertTrue(all(c in MO.SIGNALS for c in AK.CODES))
        self.assertEqual(len(AK.NAMES), 45 + 4 + 7 + AK.EMB)

    def test_sinyal_terdaftar(self):
        for k in MO.RME_SIGNALS:
            modes, tag, w, label = MO.SIGNALS[k]
            self.assertTrue(modes and tag and w > 0 and label)

    def test_aturan_kustom_membaca_rme(self):
        from aip.realtime import aturan_kustom as AKU

        ex = AKU.kompilasi("rme_ada and rme_tindakan_tidak_tercatat >= 1 and rme_vital_normal")
        self.assertIn("rme_vital_normal", ex.field)
        for c in AKU.CONTOH:  # the catalogue's examples, the two medical-record ones included, still compile
            AKU.kompilasi(c)
        _, _, h = cek(KATETER, "tindakan_fiktif")
        v = AKU._nilai_rme({}, h["nilai"])
        self.assertTrue(ex(AKU.Baris(v, set())))
        self.assertFalse(ex(AKU.Baris(AKU._nilai_rme({}, None), set())))  # no record: every rme_ field empty, the rule is false

    def test_batch_bentuk_masukan(self):
        k = {"klaim_id": "B1", "tanggal_masuk": "2024-12-20", "tanggal_pulang": "2024-12-23", "jenis_episode": "ri", "diagnosis_utama": "I25.1",
             "diagnosis_sekunder": "I10;E11.9", "tindakan": [{"kode": "37.23", "nama": "Kateterisasi"}]}
        kk = RB.klaim_umum(k)
        self.assertEqual((kk["tingkat"], kk["dx_sekunder"], kk["tindakan"]), ("RITL", ["I10", "E11.9"], ["37.23 - Kateterisasi"]))
        b = RS.bundel(kk, "tindakan_fiktif", random.Random(3))
        out = RB.nilai_satu({"klaim": k, "rekam_medis": b, "label": {"fraud": True}})
        self.assertNotEqual(out["keputusan"], "LOLOS")
        # a Bundle carrying an ID Core Claim needs no separate claim
        b2 = RS.bundel(kk, "sesuai", random.Random(4))
        b2["entry"].append({"resource": {"resourceType": "Claim", "id": "C9", "billablePeriod": {"start": "2024-12-20", "end": "2024-12-23"},
                                         "diagnosis": [{"sequence": 1, "diagnosisCodeableConcept": {"coding": [{"system": R.SYS_ICD10, "code": "I25.1"}]}}],
                                         "procedure": [{"sequence": 1, "procedureCodeableConcept": {"coding": [{"system": R.SYS_ICD9, "code": "37.23"}]}}]}})
        it = RB._item(b2)
        self.assertEqual(RB.nilai_satu(it)["keputusan"], "LOLOS")


if __name__ == "__main__":
    unittest.main()
