"""The medical-record rules added 2026-11-15 (aip/realtime/rme.py): ventilation hours, ICU days, drug quantities, and the stay in
the context of the patient's other encounters (planned readmission, readmission after an unstable discharge, referral without
reason, one doctor across hospitals); and the negation-aware reading of written findings. Positive, negative, edges.
Synthetic data only.

Run: ..\\.venv\\Scripts\\python.exe -I -m pytest -q test_rme_konteks.py   (from api/)
"""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aip import semantik as S  # noqa: E402
from aip.realtime import aktif as AK  # noqa: E402
from aip.realtime import modus as MO  # noqa: E402
from aip.realtime import rme as R  # noqa: E402

PESERTA = {"jk": "L", "tgl_lahir": "1960-01-01"}
BARU = ["RME_VENTILASI_TIDAK_SESUAI", "RME_HARI_ICU_LEBIH", "RME_OBAT_JUMLAH_KURANG", "RME_READMISI_TERENCANA", "RME_READMISI_PULANG_DINI",
        "RME_RUJUKAN_TANPA_INDIKASI", "RME_DOKTER_PASIEN_DIPUTAR"]


class B:
    """A small SATUSEHAT-like Bundle builder."""

    def __init__(self) -> None:
        self.e = [{"resource": {"resourceType": "Patient", "id": "p1", "gender": "male", "birthDate": "1960-01-01",
                                "identifier": [{"system": R.SYS_IHS, "value": "P1"}]}}]
        self.n = 0

    def add(self, r: dict) -> dict:
        self.n += 1
        r.setdefault("id", f"r{self.n}")
        r.setdefault("subject", {"reference": "Patient/p1"})
        self.e.append({"resource": r})
        return r

    def enc(self, eid: str, kelas: str, a: str, b: str, org: str = "Organization/RS-A", dokter: str = "Practitioner/D1", dx: str = "I21.4", **hos) -> str:
        r = {"resourceType": "Encounter", "id": eid, "status": "finished", "class": {"system": R.SYS_ACT, "code": kelas},
             "period": {"start": a, "end": b}, "serviceProvider": {"reference": org}, "participant": [{"individual": {"reference": dokter}}],
             "identifier": [{"value": eid.upper()}]}
        lok = hos.pop("location", None)
        if lok:
            r["location"] = lok
        if hos.pop("reason", False):
            r["reasonCode"] = [{"coding": [{"system": R.SYS_ICD10, "code": dx}]}]
        if hos:
            r["hospitalization"] = hos
        self.add(r)
        self.add({"resourceType": "Condition", "code": {"coding": [{"system": R.SYS_ICD10, "code": dx}]}, "encounter": {"reference": f"Encounter/{eid}"}})
        return eid

    def vital(self, eid: str, t: str, sbp=120, dbp=78, hr=80, rr=16, temp=36.8, spo2=98) -> None:
        self.add({"resourceType": "Observation", "code": {"coding": [{"system": R.SYS_LOINC, "code": "85354-9"}]}, "encounter": {"reference": f"Encounter/{eid}"},
                  "effectiveDateTime": t, "component": [{"code": {"coding": [{"system": R.SYS_LOINC, "code": "8480-6"}]}, "valueQuantity": {"value": sbp}},
                                                        {"code": {"coding": [{"system": R.SYS_LOINC, "code": "8462-4"}]}, "valueQuantity": {"value": dbp}}]})
        for code, v in (("8867-4", hr), ("9279-1", rr), ("8310-5", temp), ("59408-5", spo2)):
            self.add({"resourceType": "Observation", "code": {"coding": [{"system": R.SYS_LOINC, "code": code}]}, "encounter": {"reference": f"Encounter/{eid}"},
                      "effectiveDateTime": t, "valueQuantity": {"value": v}})

    def obs(self, eid: str, t: str, code: str, **v) -> None:
        self.add({"resourceType": "Observation", "code": {"coding": [{"system": R.SYS_LOINC, "code": code}]}, "encounter": {"reference": f"Encounter/{eid}"},
                  "effectiveDateTime": t, **v})

    def proc(self, eid: str, code: str, a: str | None = None, b: str | None = None, status: str = "completed") -> None:
        r = {"resourceType": "Procedure", "status": status, "code": {"coding": [{"system": R.SYS_ICD9, "code": code}]}, "encounter": {"reference": f"Encounter/{eid}"}}
        if a and b:
            r["performedPeriod"] = {"start": a, "end": b}
        elif a:
            r["performedDateTime"] = a
        self.add(r)

    def resume(self, eid: str, teks: str, t: str) -> None:
        self.add({"resourceType": "Composition", "status": "final", "encounter": {"reference": f"Encounter/{eid}"}, "date": t,
                  "section": [{"title": "Rencana", "text": {"div": f"<div>{teks}</div>"}}]})

    def bundle(self) -> dict:
        return {"resourceType": "Bundle", "type": "collection", "entry": self.e}


def klaim(d0: str, d1: str, **kv) -> dict:
    k = {"id": "C1", "tgl_datang": date.fromisoformat(d0), "tgl_pulang": date.fromisoformat(d1), "tingkat": "RITL", "dx_utama": "I21.4", "dx_sekunder": [],
         "tindakan": [], "sd_tarif_rp": 0, "rr_tarif_rp": 0, "obat": [], "status_pulang": "Sehat"}
    k.update(kv)
    return k


def cek(k: dict, b: B, riwayat=None) -> tuple[set, dict]:
    h = R.periksa(k, R.baca(b.bundle()), "F", PESERTA, None, riwayat)
    return {s["kode"] for s in h["sinyal"]}, h


def sig(h: dict, kode: str) -> dict:
    return next(s for s in h["sinyal"] if s["kode"] == kode)


class TeksTemuan(unittest.TestCase):
    def test_negasi(self):
        self.assertEqual(R.teks_abn("Irama sinus normal, tidak ada perubahan iskemik"), "N")  # was read as ischaemic before 2026-11-15
        self.assertEqual(R.teks_abn("Sinus rhythm, no ST elevation"), "N")
        self.assertEqual(R.teks_abn("tanpa kelainan"), "N")
        self.assertEqual(R.teks_abn("ST elevasi V1-V4 (infark anterior)"), "A")
        self.assertEqual(R.teks_abn("Irama sinus, Q patologis inferior"), "A")
        self.assertEqual(R.teks_abn("EKG tidak normal"), "A")
        self.assertIsNone(R.teks_abn("hasil terlampir"))

    def test_ekg_normal_tidak_jadi_indikasi(self):
        b = B()
        b.enc("e1", "IMP", "2025-03-10T08:00:00+08:00", "2025-03-12T10:00:00+08:00", dx="I25.1")
        b.vital("e1", "2025-03-10T08:30:00+08:00")
        b.obs("e1", "2025-03-10T08:45:00+08:00", "11524-6", valueString="Irama sinus normal, tidak ada perubahan iskemik")
        r = R.baca(b.bundle())
        self.assertEqual([o["abn"] for o in r["observasi"] if o["p"] == "ekg"], ["N"])
        kd, _ = cek(klaim("2025-03-10", "2025-03-12", dx_utama="I25.1", tindakan=["0066 - PTCA", "3607 - Insertion of drug-eluting stent"]), b)
        self.assertIn("RME_TINDAKAN_TIDAK_TERCATAT", kd)


class Ventilasi(unittest.TestCase):
    def rec(self, *periode, kode="9672") -> B:
        b = B()
        b.enc("e1", "IMP", "2025-03-10T08:00:00+08:00", "2025-03-20T10:00:00+08:00", dx="J96.0")
        b.vital("e1", "2025-03-10T08:30:00+08:00", spo2=85)
        for a, z in periode:
            b.proc("e1", kode, a, z)
        return b

    def test_kurang_dari_96(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.72"]), self.rec(("2025-03-10T10:00:00+08:00", "2025-03-12T22:00:00+08:00")))
        self.assertIn("RME_VENTILASI_TIDAK_SESUAI", kd)
        self.assertIn("60 jam", sig(h, "RME_VENTILASI_TIDAK_SESUAI")["bukti"])
        self.assertEqual(sig(h, "RME_VENTILASI_TIDAK_SESUAI")["s"], 1.0)

    def test_tepat_96_tidak_menandai(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.72"]), self.rec(("2025-03-10T10:00:00+08:00", "2025-03-14T10:00:00+08:00")))
        self.assertNotIn("RME_VENTILASI_TIDAK_SESUAI", kd)
        self.assertTrue(any(r["aspek"] == "Durasi ventilasi" and r["status"] == "cocok" for r in h["hasil"]))

    def test_celah_antar_rangkaian(self):
        dekat = self.rec(("2025-03-10T10:00:00+08:00", "2025-03-12T12:00:00+08:00"), ("2025-03-12T12:30:00+08:00", "2025-03-14T14:00:00+08:00"))
        self.assertNotIn("RME_VENTILASI_TIDAK_SESUAI", cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.72"]), dekat)[0])
        jauh = self.rec(("2025-03-10T10:00:00+08:00", "2025-03-12T12:00:00+08:00"), ("2025-03-12T18:00:00+08:00", "2025-03-14T20:00:00+08:00"))
        kd, h = cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.72"]), jauh)
        self.assertIn("RME_VENTILASI_TIDAK_SESUAI", kd)
        self.assertIn("2 rangkaian", sig(h, "RME_VENTILASI_TIDAK_SESUAI")["bukti"])

    def test_periode_singkat_waktu_tindakan_bukan_durasi(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.72"]), self.rec(("2025-03-10T10:00:00+08:00", "2025-03-10T11:00:00+08:00")))
        self.assertNotIn("RME_VENTILASI_TIDAK_SESUAI", kd)
        self.assertTrue(any(r["aspek"] == "Durasi ventilasi" and r["status"] == "tidak_dicek" for r in h["hasil"]))

    def test_rekam_medis_mengode_96_71(self):
        b = self.rec()
        b.proc("e1", "9671", "2025-03-10T10:00:00+08:00")
        kd, _ = cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.72"]), b)
        self.assertIn("RME_VENTILASI_TIDAK_SESUAI", kd)

    def test_jam_ventilator_klaim_dan_alat(self):
        b = self.rec()
        b.add({"resourceType": "DeviceUseStatement", "device": {"display": "Ventilator ICU"}, "context": {"reference": "Encounter/e1"},
               "timingPeriod": {"start": "2025-03-10T10:00:00+08:00", "end": "2025-03-12T10:00:00+08:00"}})
        kd, _ = cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.71"], jam_ventilator=120), b)
        self.assertIn("RME_VENTILASI_TIDAK_SESUAI", kd)

    def test_tanpa_data_durasi_tidak_dicek(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-20", dx_utama="J96.0", tindakan=["96.72"]), self.rec())
        self.assertNotIn("RME_VENTILASI_TIDAK_SESUAI", kd)


class HariIcu(unittest.TestCase):
    def rec(self, lokasi) -> B:
        b = B()
        b.add({"resourceType": "Location", "id": "L-ICU", "name": "Ruang Intensif", "type": [{"coding": [{"code": "ICU"}], "text": "Intensive care unit"}]})
        b.add({"resourceType": "Location", "id": "L-W", "name": "Bangsal Mawar"})
        b.enc("e1", "IMP", "2025-03-10T08:00:00+08:00", "2025-03-16T10:00:00+08:00", location=lokasi)
        b.vital("e1", "2025-03-10T08:30:00+08:00", spo2=89)
        return b

    ICU2 = [{"location": {"reference": "Location/L-ICU"}, "period": {"start": "2025-03-10T09:00:00+08:00", "end": "2025-03-11T20:00:00+08:00"}},
            {"location": {"reference": "Location/L-W"}, "period": {"start": "2025-03-11T20:00:00+08:00", "end": "2025-03-16T10:00:00+08:00"}}]

    def test_lebih(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-16", hari_icu=5), self.rec(self.ICU2))
        self.assertIn("RME_HARI_ICU_LEBIH", kd)
        self.assertEqual(h["nilai"]["rme_hari_icu"], 2)
        self.assertIn("3 hari ICU lebih", sig(h, "RME_HARI_ICU_LEBIH")["bukti"])

    def test_sama(self):
        kd, _ = cek(klaim("2025-03-10", "2025-03-16", hari_icu=2), self.rec(self.ICU2))
        self.assertNotIn("RME_HARI_ICU_LEBIH", kd)

    def test_tanpa_icu_sama_sekali(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-16", hari_icu=3), self.rec([self.ICU2[1]]))
        self.assertIn("tidak ada periode di ICU", sig(h, "RME_HARI_ICU_LEBIH")["bukti"])

    def test_lokasi_tanpa_periode_tidak_dicek(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-16", hari_icu=3), self.rec([{"location": {"reference": "Location/L-ICU"}}]))
        self.assertNotIn("RME_HARI_ICU_LEBIH", kd)
        self.assertTrue(any(r["aspek"] == "Hari ICU" and r["status"] == "tidak_dicek" for r in h["hasil"]))


class JumlahObat(unittest.TestCase):
    def rec(self, *obat) -> B:
        b = B()
        b.enc("e1", "IMP", "2025-03-10T08:00:00+08:00", "2025-03-13T10:00:00+08:00")
        b.vital("e1", "2025-03-10T08:30:00+08:00", hr=120)
        for o in obat:
            b.add({"medicationCodeableConcept": {"coding": [{"code": "ENOX"}], "text": "Enoxaparin 60 mg injeksi"}, "context": {"reference": "Encounter/e1"},
                   "status": "completed", **o})
        return b

    LINE = [{"kode": "ENOX", "nama": "Enoxaparin 60 mg", "ditagih": 10}]

    def test_diserahkan_kurang(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-13", obat=self.LINE), self.rec({"resourceType": "MedicationDispense", "quantity": {"value": 4}}))
        self.assertIn("RME_OBAT_JUMLAH_KURANG", kd)
        self.assertIn("ditagih 10, tercatat 4", sig(h, "RME_OBAT_JUMLAH_KURANG")["bukti"])
        self.assertNotIn("RME_OBAT_ALKES_TIDAK_TERCATAT", kd)

    def test_sesuai(self):
        kd, _ = cek(klaim("2025-03-10", "2025-03-13", obat=self.LINE), self.rec({"resourceType": "MedicationDispense", "quantity": {"value": 10}}))
        self.assertNotIn("RME_OBAT_JUMLAH_KURANG", kd)

    def test_dari_pemberian_dengan_mitigasi(self):
        kd, h = cek(klaim("2025-03-10", "2025-03-13", obat=self.LINE), self.rec(*[{"resourceType": "MedicationAdministration"}] * 3))
        self.assertIn("RME_OBAT_JUMLAH_KURANG", kd)
        self.assertTrue(any(m["kode"] == "SATUAN_PEMBERIAN" for m in sig(h, "RME_OBAT_JUMLAH_KURANG")["mitigasi"]))

    def test_tidak_ada_di_rekam_medis_aturan_lain(self):
        kd, _ = cek(klaim("2025-03-10", "2025-03-13", obat=self.LINE), self.rec())
        self.assertIn("RME_OBAT_ALKES_TIDAK_TERCATAT", kd)
        self.assertNotIn("RME_OBAT_JUMLAH_KURANG", kd)


class RawatUlangTerencana(unittest.TestCase):
    def rec(self, **kv) -> B:
        b = B()
        b.enc("e0", "IMP", "2025-04-01T08:00:00+08:00", "2025-04-04T10:00:00+08:00", dx="I20.0")
        b.vital("e0", "2025-04-01T08:30:00+08:00", sbp=170, hr=105)
        b.vital("e0", "2025-04-04T09:00:00+08:00")
        b.resume("e0", "Rencana masuk kembali tanggal 2025-04-12 untuk tindakan lanjutan (terjadwal).", "2025-04-04T10:00:00+08:00")
        b.enc("e1", "IMP", "2025-04-12T08:00:00+08:00", "2025-04-14T10:00:00+08:00", dx="I20.0", **kv)
        b.vital("e1", "2025-04-12T08:30:00+08:00", dbp=85)
        b.vital("e1", "2025-04-14T09:00:00+08:00")
        b.obs("e1", "2025-04-12T09:00:00+08:00", "11524-6", valueString="Irama sinus normal, tidak ada perubahan iskemik")
        return b

    def test_terencana_tanpa_kebutuhan(self):
        kd, h = cek(klaim("2025-04-12", "2025-04-14", dx_utama="I20.0"), self.rec())
        self.assertIn("RME_READMISI_TERENCANA", kd)
        self.assertNotIn("RME_RAWAT_INAP_TANPA_INDIKASI", kd)  # one fact, one finding
        self.assertIn("2025-04-12", sig(h, "RME_READMISI_TERENCANA")["bukti"])
        self.assertTrue(any(m["kode"] == "PERLU_TELAAH" for m in sig(h, "RME_READMISI_TERENCANA")["mitigasi"]))

    def test_ada_tindakan_lanjutan_sah(self):
        b = self.rec()
        b.proc("e1", "3607", "2025-04-13T10:00:00+08:00")
        kd, _ = cek(klaim("2025-04-12", "2025-04-14", dx_utama="I20.0", tindakan=["3607"]), b)
        self.assertNotIn("RME_READMISI_TERENCANA", kd)

    def test_temuan_akut_sah(self):
        b = self.rec()
        b.obs("e1", "2025-04-12T09:00:00+08:00", "10839-9", valueQuantity={"value": 2.5, "unit": "ng/mL"}, interpretation=[{"coding": [{"code": "H"}]}])
        kd, _ = cek(klaim("2025-04-12", "2025-04-14", dx_utama="I20.0"), b)
        self.assertNotIn("RME_READMISI_TERENCANA", kd)

    def test_tanda_readmisi_di_encounter(self):
        b = B()
        b.enc("e1", "IMP", "2025-04-12T08:00:00+08:00", "2025-04-14T10:00:00+08:00", dx="I20.0", reAdmission={"coding": [{"code": "R"}]})
        b.vital("e1", "2025-04-12T08:30:00+08:00")
        kd, _ = cek(klaim("2025-04-12", "2025-04-14", dx_utama="I20.0"), b)
        self.assertIn("RME_READMISI_TERENCANA", kd)

    def test_tanpa_rencana_tidak_menandai(self):
        b = B()
        b.enc("e1", "IMP", "2025-04-12T08:00:00+08:00", "2025-04-14T10:00:00+08:00", dx="I20.0")
        b.vital("e1", "2025-04-12T08:30:00+08:00")
        self.assertNotIn("RME_READMISI_TERENCANA", cek(klaim("2025-04-12", "2025-04-14", dx_utama="I20.0"), b)[0])


class PulangDini(unittest.TestCase):
    def rec(self, selesai="2025-05-05T10:00:00+08:00", pulang_vital=None, pulang_ke="home", dua_set=True, org0="Organization/RS-A") -> B:
        b = B()
        b.enc("e0", "IMP", "2025-05-01T08:00:00+08:00", selesai, org=org0, dx="I50.0", dischargeDisposition={"coding": [{"code": pulang_ke}]})
        b.vital("e0", "2025-05-01T08:30:00+08:00", hr=118, rr=28, spo2=88)
        if dua_set:
            b.vital("e0", selesai[:10] + "T09:00:00+08:00", **(pulang_vital if pulang_vital is not None else {"hr": 112, "spo2": 89}))
        b.enc("e1", "IMP", "2025-05-08T08:00:00+08:00", "2025-05-12T10:00:00+08:00", dx="I50.0")
        b.vital("e1", "2025-05-08T08:30:00+08:00", hr=115, spo2=90)
        return b

    def test_masuk_lagi_setelah_pulang_belum_stabil(self):
        kd, h = cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), self.rec())
        self.assertIn("RME_READMISI_PULANG_DINI", kd)
        s = sig(h, "RME_READMISI_PULANG_DINI")
        self.assertEqual(s["s"], 1.0)
        self.assertIn("denyut nadi 112", s["bukti"])
        self.assertIn("3 hari", s["bukti"])

    def test_pulang_stabil(self):
        kd, _ = cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), self.rec(pulang_vital={}))
        self.assertNotIn("RME_READMISI_PULANG_DINI", kd)

    def test_lebih_dari_7_hari(self):
        kd, _ = cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), self.rec(selesai="2025-04-30T10:00:00+08:00"))
        self.assertNotIn("RME_READMISI_PULANG_DINI", kd)

    def test_hanya_satu_set_vital_bukan_vital_pulang(self):
        kd, _ = cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), self.rec(dua_set=False))
        self.assertNotIn("RME_READMISI_PULANG_DINI", kd)

    def test_aps_dan_rs_lain_mitigasi(self):
        kd, h = cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), self.rec(pulang_ke="aadvice", org0="Organization/RS-B"))
        mit = {m["kode"] for m in sig(h, "RME_READMISI_PULANG_DINI")["mitigasi"]}
        self.assertEqual(mit, {"PULANG_APS", "RS_LAIN"})

    def test_dirujuk_bukan_pulang_dini(self):
        kd, _ = cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), self.rec(pulang_ke="hosp"))
        self.assertNotIn("RME_READMISI_PULANG_DINI", kd)

    def test_dari_riwayat_mesin(self):
        b0 = self.rec()
        jj = [j for j in R.jejak(R.baca(b0.bundle())) if j["id"] == "e0"]
        b = B()
        b.enc("e1", "IMP", "2025-05-08T08:00:00+08:00", "2025-05-12T10:00:00+08:00", dx="I50.0")
        b.vital("e1", "2025-05-08T08:30:00+08:00", hr=115)
        kd, _ = cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), b, riwayat=[{**jj[0], "id": "faskes:x:e0"}])
        self.assertIn("RME_READMISI_PULANG_DINI", kd)
        self.assertNotIn("RME_READMISI_PULANG_DINI", cek(klaim("2025-05-08", "2025-05-12", dx_utama="I50.0"), b)[0])


class Rujukan(unittest.TestCase):
    def rec(self, **kv) -> B:
        b = B()
        b.enc("e1", "AMB", "2025-06-03T09:00:00+08:00", "2025-06-03T11:00:00+08:00", org="Organization/RS-B", dx="I10",
              admitSource={"coding": [{"code": "hosp-trans"}]}, **kv)
        b.vital("e1", "2025-06-03T09:30:00+08:00", dbp=86)
        return b

    def test_tanpa_alasan(self):
        kd, h = cek(klaim("2025-06-03", "2025-06-03", tingkat="RJTL", dx_utama="I10"), self.rec())
        self.assertIn("RME_RUJUKAN_TANPA_INDIKASI", kd)

    def test_ada_alasan(self):
        kd, _ = cek(klaim("2025-06-03", "2025-06-03", tingkat="RJTL", dx_utama="I10"), self.rec(reason=True))
        self.assertNotIn("RME_RUJUKAN_TANPA_INDIKASI", kd)

    def test_temuan_akut(self):
        b = self.rec()
        b.vital("e1", "2025-06-03T10:00:00+08:00", sbp=200, dbp=125)
        kd, _ = cek(klaim("2025-06-03", "2025-06-03", tingkat="RJTL", dx_utama="I10"), b)
        self.assertNotIn("RME_RUJUKAN_TANPA_INDIKASI", kd)

    def test_penunjang_di_rs_tujuan_mitigasi(self):
        b = self.rec()
        b.proc("e1", "8872", "2025-06-03T10:00:00+08:00")
        kd, h = cek(klaim("2025-06-03", "2025-06-03", tingkat="RJTL", dx_utama="I10", tindakan=["8872"]), b)
        self.assertTrue(any(m["kode"] == "PENUNJANG_DI_RS_TUJUAN" for m in sig(h, "RME_RUJUKAN_TANPA_INDIKASI")["mitigasi"]))

    def test_rujukan_fktp_bukan_antar_rs(self):
        b = B()
        b.enc("e1", "AMB", "2025-06-03T09:00:00+08:00", "2025-06-03T11:00:00+08:00", dx="I10", admitSource={"coding": [{"code": "gp"}]})
        b.vital("e1", "2025-06-03T09:30:00+08:00")
        self.assertNotIn("RME_RUJUKAN_TANPA_INDIKASI", cek(klaim("2025-06-03", "2025-06-03", tingkat="RJTL", dx_utama="I10"), b)[0])


class DokterLintasRs(unittest.TestCase):
    def rec(self, *kunjungan) -> B:
        b = B()
        for i, (tgl, org, dok, dx) in enumerate(kunjungan):
            b.enc(f"e{i}", "AMB", f"{tgl}T09:00:00+08:00", f"{tgl}T10:00:00+08:00", org=org, dokter=dok, dx=dx)
            b.vital(f"e{i}", f"{tgl}T09:30:00+08:00")
        return b

    def test_tiga_rs(self):
        b = self.rec(("2025-09-01", "Organization/A", "Practitioner/X", "I25.1"), ("2025-09-05", "Organization/B", "Practitioner/X", "I25.1"),
                     ("2025-09-10", "Organization/C", "Practitioner/X", "I25.1"))
        kd, h = cek(klaim("2025-09-10", "2025-09-10", tingkat="RJTL", dx_utama="I25.1"), b)
        self.assertEqual(sig(h, "RME_DOKTER_PASIEN_DIPUTAR")["s"], 1.0)

    def test_dua_rs_dekat_dx_sama(self):
        b = self.rec(("2025-09-05", "Organization/B", "Practitioner/X", "I25.1"), ("2025-09-10", "Organization/C", "Practitioner/X", "I25.1"))
        kd, h = cek(klaim("2025-09-10", "2025-09-10", tingkat="RJTL", dx_utama="I25.1"), b)
        self.assertEqual(sig(h, "RME_DOKTER_PASIEN_DIPUTAR")["s"], 0.8)
        # more than 14 days apart: weaker
        b2 = self.rec(("2025-08-20", "Organization/B", "Practitioner/X", "I25.1"), ("2025-09-10", "Organization/C", "Practitioner/X", "I25.1"))
        self.assertEqual(sig(cek(klaim("2025-09-10", "2025-09-10", tingkat="RJTL", dx_utama="I25.1"), b2)[1], "RME_DOKTER_PASIEN_DIPUTAR")["s"], 0.6)

    def test_kunjungan_masa_depan_tidak_dihitung(self):
        b = self.rec(("2025-09-05", "Organization/B", "Practitioner/X", "I25.1"), ("2025-09-10", "Organization/C", "Practitioner/X", "I25.1"))
        b.enc("e9", "AMB", "2025-09-01T09:00:00+08:00", "2025-09-01T10:00:00+08:00", org="Organization/A", dokter="Practitioner/Y", dx="I25.1")
        kd, _ = cek(klaim("2025-09-05", "2025-09-05", tingkat="RJTL", dx_utama="I25.1"), b)
        self.assertNotIn("RME_DOKTER_PASIEN_DIPUTAR", kd)

    def test_dokter_lain(self):
        b = self.rec(("2025-09-05", "Organization/B", "Practitioner/Y", "I25.1"), ("2025-09-10", "Organization/C", "Practitioner/X", "I25.1"))
        self.assertNotIn("RME_DOKTER_PASIEN_DIPUTAR", cek(klaim("2025-09-10", "2025-09-10", tingkat="RJTL", dx_utama="I25.1"), b)[0])


class Registrasi(unittest.TestCase):
    def test_sinyal_baru(self):
        for k in BARU:
            modes, tag, w, label = MO.SIGNALS[k]
            self.assertTrue(modes and tag in S.TAG and w > 0 and label, k)
            self.assertIn(k, MO.RME_SIGNALS)
            self.assertNotIn(k, AK.CODES)
        self.assertEqual(len(AK.CODES), 45)

    def test_basis_pengetahuan_episodik(self):
        self.assertEqual(R.DX_KLINIS["I200"]["kontra"], ())  # unstable angina: troponin normal by definition
        self.assertEqual(R.DX_KLINIS["I48"]["min"], 2)


if __name__ == "__main__":
    unittest.main()
