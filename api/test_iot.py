"""The device-evidence check (aip/realtime/iot.py): every IOT_* rule positive, negative and at its edges; the anchors; the
contract; the engine entry and the registration. Synthetic data only.

Run: ..\\.venv\\Scripts\\python.exe -I -m pytest -q test_iot.py   (from api/)
"""
from __future__ import annotations

import re
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aip import semantik as S  # noqa: E402
from aip.realtime import aktif as AK  # noqa: E402
from aip.realtime import iot as I  # noqa: E402
from aip.realtime import modus as MO  # noqa: E402

WITA = timezone(timedelta(hours=8))
T0 = datetime(2025, 3, 10, 8, 0, tzinfo=WITA)
ALAT = {"tercakup": True, "perangkat": {"V1": {"jenis": "ventilator", "kunci": "aktif"}, "H1": {"jenis": "hemodialisis", "kunci": "aktif"},
                                        "B1": {"jenis": "icu", "kunci": "aktif"}}}


def klaim(**kv) -> dict:
    k = {"kunjungan": "K1", "peserta": "RM-1", "tgl_masuk": "2025-03-10", "tgl_pulang": "2025-03-20", "tingkat": "RITL", "tindakan": []}
    k.update(kv)
    return k


def sesi(sid: str, dev: str, jenis: str, mode: str, mulai_jam: float, jam: float, peserta: str = "RM-1", kunjungan: str = "K1") -> dict:
    a = T0 + timedelta(hours=mulai_jam)
    return {"sesi_id": sid, "device_id": dev, "jenis": jenis, "peserta": peserta, "kunjungan": kunjungan, "mode": mode,
            "mulai": a.isoformat(), "selesai": (a + timedelta(hours=jam)).isoformat(), "jam": jam}


def kode(h: dict) -> set:
    return {s["kode"] for s in h["sinyal"]}


def sig(h: dict, k: str) -> dict:
    return next(s for s in h["sinyal"] if s["kode"] == k)


class Ventilasi(unittest.TestCase):
    def test_96_jam_kurang(self):
        h = I.periksa_iot(klaim(tindakan=["96.72 - Continuous invasive mechanical ventilation for 96 consecutive hours or more"]),
                          [sesi("s1", "V1", "ventilator", "jalan", 0, 60)], None, ALAT)
        self.assertIn("IOT_VENTILASI_KURANG_96", kode(h))
        s = sig(h, "IOT_VENTILASI_KURANG_96")
        self.assertEqual(s["s"], 1.0)
        self.assertEqual(s["aturan"], "vent_run_96")
        self.assertEqual(s["jenis_bukti"], "bukti")
        self.assertIn("60 jam", s["bukti"])
        self.assertIn("sensor clamp", s["bukti"])
        self.assertEqual(s["ukur"]["run_jalan_terpanjang_jam"], 60.0)
        self.assertTrue(h["aturan"]["vent_run_96"])

    def test_tepat_96_jam_tidak_menandai(self):
        h = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 96)], None, ALAT)
        self.assertNotIn("IOT_VENTILASI_KURANG_96", kode(h))
        self.assertTrue(any(r["aspek"] == "Durasi ventilasi" and r["status"] == "cocok" for r in h["hasil"]))
        h2 = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 95.9)], None, ALAT)
        self.assertEqual(sig(h2, "IOT_VENTILASI_KURANG_96")["s"], 0.6)

    def test_celah_antar_rangkaian(self):
        # 50 h + 50 h with a 30-minute break (circuit change): one run of 100.5 h
        h = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 50), sesi("s2", "V1", "ventilator", "jalan", 50.5, 50)],
                          None, ALAT)
        self.assertNotIn("IOT_VENTILASI_KURANG_96", kode(h))
        # with a 5-hour break: two runs of 50 h, not 96 consecutive hours
        h2 = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 50), sesi("s2", "V1", "ventilator", "jalan", 55, 50)],
                           None, ALAT)
        s = sig(h2, "IOT_VENTILASI_KURANG_96")
        self.assertEqual(s["ukur"]["rangkaian_jalan"], 2)
        self.assertIn("100 jam", s["bukti"])  # the total is stated beside the longest run

    def test_celah_saat_gateway_offline_mitigasi(self):
        al = {**ALAT, "gateway_offline": [{"mulai": (T0 + timedelta(hours=50)).isoformat(), "selesai": (T0 + timedelta(hours=55)).isoformat()}]}
        h = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 50), sesi("s2", "V1", "ventilator", "jalan", 55, 50)],
                          None, al)
        s = sig(h, "IOT_VENTILASI_KURANG_96")
        self.assertTrue(any(m["kode"] == "GATEWAY_OFFLINE" and m["faktor"] >= 0.6 for m in s["mitigasi"]))

    def test_menyala_cukup_tetapi_jalan_kurang_telaah(self):
        # powered 110 h without a break, 70 h of it read as running and 40 h as standby: the state comes from the current pattern
        h = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 70), sesi("s2", "V1", "ventilator", "siaga", 70, 40)],
                          None, ALAT)
        s = sig(h, "IOT_VENTILASI_KURANG_96")
        self.assertTrue(any(m["kode"] == "STATUS_DARI_POLA_ARUS" for m in s["mitigasi"]))

    def test_mode_lama_dibaca_jalan(self):
        # contract iot-1 sent the ventilation type as the mode: a clamp cannot tell it, so it is read as running
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "non_invasif", 0, 30)], None, ALAT)
        self.assertEqual(kode(h), set())
        self.assertEqual(h["ukur"]["ventilator"]["jam_jalan"], 30.0)
        h2 = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "invasif", 0, 50), sesi("s2", "V1", "ventilator", "noninvasif", 50, 50)],
                           None, ALAT)
        self.assertEqual(kode(h2), set())  # one uninterrupted run of 100 h: the 96-hour code is supported
        self.assertEqual(h2["ukur"]["ventilator"]["run_jalan_terpanjang_jam"], 100.0)
        h3 = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "standby", 0, 48)], None, ALAT)
        self.assertEqual(kode(h3), {"IOT_VENTILATOR_STANDBY"})
        v = I.validasi({"sesi": [sesi("s1", "V1", "ventilator", "invasif", 0, 5)], "alat": ALAT})
        self.assertTrue(v["diterima"])
        self.assertTrue(any("iot-1" in p for p in v["peringatan"]))

    def test_mode_dari_ventilator_sendiri(self):
        # only a mode the ventilator itself reported (its data port, not the clamp) can say non-invasive
        x = {**sesi("s1", "V1", "ventilator", "jalan", 0, 30), "sumber_mode": "ventilator", "mode_ventilasi": "non_invasif"}
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [x], None, ALAT)
        self.assertEqual(kode(h), {"IOT_MODE_NONINVASIF"})
        self.assertIn("93.90", sig(h, "IOT_MODE_NONINVASIF")["bukti"])
        self.assertIn("bukan dari sensor clamp", sig(h, "IOT_MODE_NONINVASIF")["bukti"])
        # an iot-1 payload that marks its mode as the ventilator's own
        y = {**sesi("s1", "V1", "ventilator", "NIV", 0, 30), "sumber_mode": "ventilator"}
        self.assertEqual(kode(I.periksa_iot(klaim(tindakan=["96.71"]), [y], None, ALAT)), {"IOT_MODE_NONINVASIF"})
        # the ventilator reports invasive time: no mode finding
        z = {**sesi("s1", "V1", "ventilator", "jalan", 0, 30), "sumber_mode": "ventilator", "mode_ventilasi": "invasif"}
        self.assertEqual(kode(I.periksa_iot(klaim(tindakan=["96.71"]), [z], None, ALAT)), set())
        # the same values from the clamp: never a mode finding
        w = {**sesi("s1", "V1", "ventilator", "jalan", 0, 30), "mode_ventilasi": "non_invasif"}
        self.assertEqual(kode(I.periksa_iot(klaim(tindakan=["96.71"]), [w], None, ALAT)), set())
        # running hours without a reported type beside it: the type of the whole use is unknown, no mode finding
        self.assertEqual(kode(I.periksa_iot(klaim(tindakan=["96.71"]), [x, sesi("s2", "V1", "ventilator", "jalan", 30, 10)], None, ALAT)), set())

    def test_standby(self):
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "siaga", 0, 48)], None, ALAT)
        self.assertEqual(kode(h), {"IOT_VENTILATOR_STANDBY"})
        s = sig(h, "IOT_VENTILATOR_STANDBY")
        self.assertEqual(s["jenis_bukti"], "telaah")
        self.assertIn("siaga 48 jam", s["bukti"])
        # standby while ventilating for real: not a standby finding
        h2 = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "siaga", 0, 10), sesi("s2", "V1", "ventilator", "jalan", 10, 20)],
                           None, ALAT)
        self.assertNotIn("IOT_VENTILATOR_STANDBY", kode(h2))

    def test_teks_tanpa_invasif_untuk_data_clamp(self):
        # every text a clamp session produces speaks of running / standby / off only
        kasus = [(["9672"], [sesi("s1", "V1", "ventilator", "jalan", 0, 60)]), (["96.71"], [sesi("s1", "V1", "ventilator", "siaga", 0, 48)]),
                 (["96.71"], [sesi("s1", "V1", "ventilator", "invasif", 0, 30)]), (["96.72"], []), (["9672"], [sesi("s1", "V1", "ventilator", "jalan", 0, 100)])]
        for tind, ss in kasus:
            h = I.periksa_iot(klaim(tindakan=tind, hari_icu=0), ss, None, ALAT)
            teks = " ".join([x["bukti"] for x in h["sinyal"]] + [m["label"] for x in h["sinyal"] for m in x["mitigasi"]]
                            + [" ".join(str(v) for v in r.values()) for r in h["hasil"]]).lower()
            self.assertNotIn("invasif", teks, (tind, teks))
            self.assertIsNone(re.search(r"niv|cpap|masker|selang", teks), (tind, teks))


class Hemodialisis(unittest.TestCase):
    def test_sesi_singkat(self):
        h = I.periksa_iot(klaim(tindakan=["39.95", "39.95"], sesi_hd=2),
                          [sesi("h1", "H1", "hemodialisis", "jalan", 0, 4), sesi("h2", "H1", "hemodialisis", "jalan", 48, 1.5)], None, ALAT)
        self.assertEqual(kode(h), {"IOT_HD_SESI_SINGKAT"})
        self.assertEqual(sig(h, "IOT_HD_SESI_SINGKAT")["s"], 1.0)
        self.assertEqual(sig(h, "IOT_HD_SESI_SINGKAT")["ukur"]["sesi_penuh"], 1)

    def test_tepat_3_jam_penuh(self):
        h = I.periksa_iot(klaim(tindakan=["39.95"]), [sesi("h1", "H1", "hemodialisis", "jalan", 0, 3)], None, ALAT)
        self.assertEqual(kode(h), set())

    def test_sesi_terputus_alarm_digabung(self):
        # 1.5 h + 20-minute alarm + 1.6 h: one session of 3.43 h
        h = I.periksa_iot(klaim(tindakan=["39.95"]), [sesi("h1", "H1", "hemodialisis", "jalan", 0, 1.5), sesi("h2", "H1", "hemodialisis", "jalan", 1.83, 1.6)],
                          None, ALAT)
        self.assertEqual(kode(h), set())

    def test_sesi_tanpa_jejak(self):
        # three billed, one ran (full), the visit has ICU sessions: two without any trace
        h = I.periksa_iot(klaim(tindakan=["39.95"], sesi_hd=3, hari_icu=1),
                          [sesi("h1", "H1", "hemodialisis", "jalan", 0, 4), sesi("b1", "B1", "icu", "nyala", 0, 20)], None, ALAT)
        self.assertIn("IOT_HD_TANPA_SESI", kode(h))
        self.assertEqual(sig(h, "IOT_HD_TANPA_SESI")["ukur"]["sesi_tanpa_jejak"], 2)
        self.assertEqual(sig(h, "IOT_HD_TANPA_SESI")["aturan"], "hd_phantom")

    def test_idle_bukan_sesi(self):
        h = I.periksa_iot(klaim(tindakan=["39.95"]), [sesi("h1", "H1", "hemodialisis", "idle", 0, 4)], None, ALAT)
        self.assertIn("IOT_HD_TANPA_SESI", kode(h))


class Icu(unittest.TestCase):
    def test_hari_icu_lebih(self):
        # 10:00 day 1 to 02:00 day 3 = 40 h on three calendar dates (each >= 1 h): counted 3 days, the generous count
        h = I.periksa_iot(klaim(hari_icu=5), [sesi("b1", "B1", "icu", "nyala", 2, 40)], None, ALAT)
        self.assertEqual(kode(h), {"IOT_HARI_ICU_LEBIH"})
        s = sig(h, "IOT_HARI_ICU_LEBIH")
        self.assertEqual((s["ukur"]["hari_kalender"], s["ukur"]["hari_nyala"], s["ukur"]["jam_nyala"]), (3, 3, 40.0))
        self.assertEqual(s["ukur"]["hari_lebih"], 2)
        self.assertEqual(s["s"], 1.0)
        # an ICU bed that was off the whole time: every billed day is missing
        h2 = I.periksa_iot(klaim(hari_icu=2), [sesi("b1", "B1", "icu", "mati", 2, 40)], None, ALAT)
        self.assertEqual(sig(h2, "IOT_HARI_ICU_LEBIH")["ukur"]["hari_nyala"], 0)

    def test_hari_icu_sama_tidak_menandai(self):
        h = I.periksa_iot(klaim(hari_icu=3), [sesi("b1", "B1", "icu", "nyala", 2, 60)], None, ALAT)
        self.assertEqual(kode(h), set())

    def test_lebih_satu_hari_lemah(self):
        h = I.periksa_iot(klaim(hari_icu=4), [sesi("b1", "B1", "icu", "nyala", 2, 60)], None, ALAT)
        self.assertEqual(sig(h, "IOT_HARI_ICU_LEBIH")["s"], 0.5)


class Jejak(unittest.TestCase):
    def test_tanpa_jejak_di_faskes_tercakup(self):
        h = I.periksa_iot(klaim(tindakan=["96.71"], hari_icu=3), [], None, ALAT)
        self.assertEqual(kode(h), {"IOT_TANPA_JEJAK"})
        self.assertEqual(set(sig(h, "IOT_TANPA_JEJAK")["ukur"]["jenis_ditagih"]), {"ventilator", "icu"})

    def test_faskes_tidak_tercakup_tidak_menandai(self):
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [], None, {"tercakup": False})
        self.assertEqual(kode(h), set())
        self.assertFalse(h["dicek"])
        h2 = I.periksa_iot(klaim(tindakan=["96.71"]), [], None, None)
        self.assertEqual(kode(h2), set())

    def test_jenis_alat_belum_tercakup(self):
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [], None, {"tercakup": True, "cakupan": ["icu"]})
        self.assertEqual(kode(h), set())
        self.assertTrue(any("belum tercakup" in r["iot"] for r in h["hasil"]))

    def test_gateway_offline_perlu_klarifikasi(self):
        al = {**ALAT, "gateway_offline": [{"mulai": "2025-03-11T00:00:00+08:00", "selesai": "2025-03-12T00:00:00+08:00"}]}
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [], None, al)
        self.assertTrue(any(m["kode"] == "GATEWAY_OFFLINE" for m in sig(h, "IOT_TANPA_JEJAK")["mitigasi"]))

    def test_hd_saja_tanpa_sesi_apa_pun_satu_temuan(self):
        h = I.periksa_iot(klaim(tindakan=["39.95"]), [], None, ALAT)
        self.assertEqual(kode(h), {"IOT_TANPA_JEJAK"})


class Binding(unittest.TestCase):
    def test_satu_alat_dua_pasien(self):
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 30),
                                                      sesi("x1", "V1", "ventilator", "jalan", 10, 30, peserta="RM-2", kunjungan="K9")], None, ALAT)
        self.assertIn("IOT_BINDING_TUMPANG", kode(h))
        self.assertEqual(sig(h, "IOT_BINDING_TUMPANG")["ukur"]["irisan_jam_terpanjang"], 20.0)

    def test_serah_terima_singkat_bukan_tumpang(self):
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 30),
                                                      sesi("x1", "V1", "ventilator", "jalan", 29.9, 30, peserta="RM-2", kunjungan="K9")], None, ALAT)
        self.assertNotIn("IOT_BINDING_TUMPANG", kode(h))

    def test_konteks_dari_klaim_lain(self):
        x = {**sesi("x1", "V1", "ventilator", "invasif", 5, 10, peserta="RM-2", kunjungan="K9"), "_konteks": True}  # an iot-1 session the engine remembered
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 30), x], None, ALAT)
        self.assertIn("IOT_BINDING_TUMPANG", kode(h))
        # the same patient's own session from another claim is context only, never this claim's
        y = {**sesi("y1", "V1", "ventilator", "jalan", 0, 200), "_konteks": True}
        h2 = I.periksa_iot(klaim(tindakan=["9672"]), [y], None, ALAT)
        self.assertIn("IOT_TANPA_JEJAK", kode(h2))

    def test_tanpa_pasien_tingkat_faskes(self):
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 30),
                                                      sesi("u1", "V2", "ventilator", "jalan", 0, 30, peserta="", kunjungan="")], None, ALAT)
        self.assertIn("IOT_TANPA_PASIEN", kode(h))
        s = sig(h, "IOT_TANPA_PASIEN")
        self.assertEqual(s["fokus"], ["faskes", ""])
        self.assertEqual(MO.SIGNALS["IOT_TANPA_PASIEN"][1], None)  # never a ledger tag on the claim
        h2 = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 30),
                                                       sesi("u1", "V2", "ventilator", "jalan", 0, 2, peserta="", kunjungan="")], None, ALAT)
        self.assertNotIn("IOT_TANPA_PASIEN", kode(h2))


class Jangkar(unittest.TestCase):
    def setUp(self):
        self.s = [sesi("s1", "V1", "ventilator", "jalan", 0, 50), sesi("s2", "V1", "ventilator", "jalan", 50.5, 50)]
        self.akar = I.akar_sesi(self.s)

    def test_cocok(self):
        h = I.periksa_iot(klaim(tindakan=["9672"], diajukan="2025-03-25T10:00:00+08:00"), self.s, {"akar": self.akar, "waktu": "2025-03-15T00:00:00+08:00"}, ALAT)
        self.assertEqual(kode(h), set())
        self.assertTrue(h["nilai"]["iot_jangkar_cocok"])

    def test_sesi_diubah_tidak_cocok(self):
        ubah = [dict(self.s[0], selesai=(T0 + timedelta(hours=52)).isoformat(), jam=52), self.s[1]]
        h = I.periksa_iot(klaim(tindakan=["9672"]), ubah, {"akar": self.akar, "waktu": "2025-03-15T00:00:00+08:00"}, ALAT)
        self.assertIn("IOT_JANGKAR_TIDAK_COCOK", kode(h))
        self.assertEqual(sig(h, "IOT_JANGKAR_TIDAK_COCOK")["jenis_bukti"], "bukti")

    def test_bukti_inklusi(self):
        semua = self.s + [sesi("z9", "V7", "ventilator", "jalan", 0, 5, peserta="RM-7", kunjungan="K7")]
        akar = I.akar_sesi(semua)
        bukti = {x["sesi_id"]: I.bukti_inklusi(semua, x["sesi_id"]) for x in self.s}
        h = I.periksa_iot(klaim(tindakan=["9672"]), self.s, {"akar": akar, "waktu": "2025-03-15T00:00:00+08:00", "bukti": bukti}, ALAT)
        self.assertNotIn("IOT_JANGKAR_TIDAK_COCOK", kode(h))
        palsu = [dict(self.s[0], mode="siaga"), self.s[1]]
        h2 = I.periksa_iot(klaim(tindakan=["9672"]), palsu, {"akar": akar, "waktu": "2025-03-15T00:00:00+08:00", "bukti": bukti}, ALAT)
        self.assertIn("IOT_JANGKAR_TIDAK_COCOK", kode(h2))

    def test_terlambat(self):
        h = I.periksa_iot(klaim(tindakan=["9672"], diajukan="2025-03-21T10:00:00+08:00"), self.s, {"akar": self.akar, "waktu": "2025-03-23T10:00:00+08:00"}, ALAT)
        self.assertEqual(kode(h), {"IOT_JANGKAR_TERLAMBAT"})
        self.assertEqual(sig(h, "IOT_JANGKAR_TERLAMBAT")["ukur"]["terlambat_jam"], 48.0)
        # anchored at the very moment of submission: not late
        h2 = I.periksa_iot(klaim(tindakan=["9672"], diajukan="2025-03-21T10:00:00+08:00"), self.s, {"akar": self.akar, "waktu": "2025-03-21T10:00:00+08:00"}, ALAT)
        self.assertEqual(kode(h2), set())

    def test_terlambat_gateway_offline_mitigasi(self):
        al = {**ALAT, "gateway_offline": [{"mulai": (T0 + timedelta(hours=10)).isoformat(), "selesai": (T0 + timedelta(hours=20)).isoformat()}]}
        h = I.periksa_iot(klaim(tindakan=["9672"], diajukan="2025-03-21T10:00:00+08:00"), self.s, {"akar": self.akar, "waktu": "2025-03-22T10:00:00+08:00"}, al)
        self.assertTrue(any(m["kode"] == "GATEWAY_OFFLINE" for m in sig(h, "IOT_JANGKAR_TERLAMBAT")["mitigasi"]))


class Kunci(unittest.TestCase):
    def test_dicabut_sebelum_sesi_selesai(self):
        al = {**ALAT, "perangkat": {**ALAT["perangkat"], "V1": {"jenis": "ventilator", "kunci": "dicabut", "dicabut_pada": "2025-03-11T00:00:00+08:00"}}}
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 30)], None, al)
        self.assertEqual(kode(h), {"IOT_KUNCI_DICABUT"})

    def test_dicabut_setelah_sesi_tidak_menandai(self):
        al = {**ALAT, "perangkat": {**ALAT["perangkat"], "V1": {"jenis": "ventilator", "kunci": "dicabut", "dicabut_pada": "2025-04-01T00:00:00+08:00"}}}
        h = I.periksa_iot(klaim(tindakan=["96.71"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 30)], None, al)
        self.assertEqual(kode(h), set())
        self.assertTrue(any(r["aspek"] == "Kunci alat" and r["status"] == "info" for r in h["hasil"]))


class Masukan(unittest.TestCase):
    def test_data_hilang_dan_rusak(self):
        h = I.periksa_iot(klaim(tindakan=["96.72"]), [{"sesi_id": "a", "device_id": "V1", "jenis": "ventilator", "mode": "terbang"},
                                                      {"sesi_id": "b", "device_id": "V1", "jenis": "ventilator", "mode": "jalan", "mulai": "kemarin"},
                                                      "bukan objek"], None, None)
        self.assertEqual(len(h["masalah"]), 3)
        self.assertEqual(kode(h), set())  # unusable sessions are left out; no coverage: no absence finding
        h2 = I.periksa_iot({}, None, None, None)
        self.assertEqual(h2["sinyal"], [])

    def test_sinonim_dan_jenis_dari_registri(self):
        # kind from the registry; "standby" -> siaga, "idle" on a ventilator -> siaga, "siaga" on a dialysis machine -> idle
        x = [{"sesi_id": "s1", "device_id": "V1", "peserta": "RM-1", "kunjungan": "K1", "mode": "Standby", "mulai": T0.isoformat(), "jam": 20}]
        h = I.periksa_iot(klaim(tindakan=["9671"]), x, None, ALAT)
        self.assertEqual(kode(h), {"IOT_VENTILATOR_STANDBY"})
        x2 = [dict(x[0], mode="idle")]
        self.assertEqual(kode(I.periksa_iot(klaim(tindakan=["9671"]), x2, None, ALAT)), {"IOT_VENTILATOR_STANDBY"})
        hd, _ = I.baca_sesi([{"sesi_id": "h1", "device_id": "H1", "mode": "siaga", "mulai": T0.isoformat(), "jam": 1}], ALAT)
        self.assertEqual(hd[0]["mode"], "idle")
        x3 = [dict(x[0], mode="NIV")]  # iot-1 clamp data: read as running
        self.assertEqual(kode(I.periksa_iot(klaim(tindakan=["9671"]), x3, None, ALAT)), set())

    def test_terikat_lewat_peserta_dan_jendela(self):
        x = [sesi("s1", "V1", "ventilator", "jalan", 0, 30, kunjungan="")]
        self.assertEqual(kode(I.periksa_iot(klaim(tindakan=["9671"]), x, None, ALAT)), set())
        y = [sesi("s1", "V1", "ventilator", "jalan", -400, 30, kunjungan="")]  # weeks before the stay: not this visit's
        self.assertIn("IOT_TANPA_JEJAK", kode(I.periksa_iot(klaim(tindakan=["9671"]), y, None, ALAT)))

    def test_validasi(self):
        v = I.validasi({"sesi": [sesi("s1", "V1", "ventilator", "jalan", 0, 5)], "jangkar": {"akar": "ab", "waktu": "x"}, "alat": ALAT})
        self.assertFalse(v["diterima"])
        self.assertEqual(v["terbaca"]["per_jenis"]["ventilator"], 1)
        ok = I.validasi({"sesi": [sesi("s1", "V1", "ventilator", "jalan", 0, 5)], "jangkar": {"akar": "a" * 64, "waktu": "2025-03-11T00:00:00+08:00"},
                         "alat": ALAT})
        self.assertTrue(ok["diterima"])
        self.assertFalse(any("iot-1" in p for p in ok["peringatan"]))
        self.assertFalse(I.validasi("bukan")["diterima"])


class Integrasi(unittest.TestCase):
    def test_terdaftar_dan_tidak_masuk_fitur_model(self):
        self.assertEqual(len(I.ATURAN_ID), len(MO.IOT_SIGNALS))
        self.assertEqual(set(I.ATURAN_ID), set(MO.IOT_SIGNALS))
        for k in MO.IOT_SIGNALS:
            modes, tag, w, label = MO.SIGNALS[k]
            self.assertTrue(w > 0 and label)
            self.assertTrue(tag is None or tag in S.TAG)
            self.assertNotIn(k, AK.CODES)
            self.assertIn(I.JENIS_BUKTI[k], ("bukti", "telaah"))
        self.assertEqual(len(AK.CODES), 45)
        self.assertIn("DURASI_ALAT_TIDAK_SESUAI", S.TAG)
        self.assertEqual(set(I.KODE_DARI_ATURAN), {"vent_run_96", "niv_as_invasive", "vent_standby", "hd_short", "hd_phantom", "icu_days", "no_device_trace",
                                                   "binding_tumpang", "anchor_mismatch", "late_anchor", "unbound_readings", "key_revoked"})

    def test_katalog_mode_ventilator(self):
        k = I.katalog()
        self.assertEqual(k["jenis_alat"]["ventilator"]["mode"], ["jalan", "siaga", "mati"])
        self.assertIn("sensor clamp", k["catatan_mode"])
        self.assertNotIn("invasif", str(MO.SIGNALS["IOT_VENTILASI_KURANG_96"]) + str(MO.SIGNALS["IOT_VENTILATOR_STANDBY"]))

    def test_tanpa_nama_vendor(self):
        teks = Path(I.__file__).read_text("utf-8").lower() + str(MO.SIGNALS).lower()
        for w in ("google", "vertex", "deepseek", " adk"):
            self.assertNotIn(w, teks)

    def test_dari_meta_mesin(self):
        c = SimpleNamespace(kunjungan_fkrtl_id="ai-jkn.KLM1", peserta_id=7, tgl_datang=date(2025, 3, 10), tgl_pulang=date(2025, 3, 20),
                            tingkat_pelayanan="RITL", inacbg_kode="J-1-10-III", inacbg_deskripsi=None, prosedur="96.72")
        meta = {"iot": {"sesi": [sesi("s1", "V1", "ventilator", "jalan", 0, 60, kunjungan="KLM1")], "alat": ALAT},
                "iot_kunjungan": "KLM1", "iot_peserta": "RM-1", "klaim_kode": {"tindakan": ["96.72"], "jam_ventilator": 120}}
        h = I.dari_meta(c, meta, None, "F1")
        self.assertIn("IOT_VENTILASI_KURANG_96", kode(h))
        self.assertIsNone(I.dari_meta(c, {}, None, "F1"))
        ev = I.untuk_peristiwa(h)
        self.assertIn("ukur", ev)
        # an earlier claim's session of the same device, another patient, overlapping: binding finding from the engine's state
        kx = [dict(sesi("x1", "V1", "ventilator", "jalan", 10, 5, peserta="RM-2", kunjungan="KLM0"))]
        h2 = I.dari_meta(c, meta, None, "F1", kx)
        self.assertIn("IOT_BINDING_TUMPANG", kode(h2))

    def test_kiriman_faskes_ke_meta(self):
        from aip.realtime import integrasi as X

        src = {"kabkota_fkrtl_kode": 7371, "kepemilikan_fkrtl": "Swasta", "jenis_fkrtl": "Rumah sakit", "tipe_fkrtl": "RS Kelas B", "nama": "RS Uji"}
        resolver = SimpleNamespace(resolve=lambda *a: {"peserta_id": 99, "entitas": "E1"})
        body = {"sumber": "ai-jkn", "klaim_id": "KLM00001", "no_rm": "RM-1", "jenis_episode": "ri", "tanggal_masuk": "2025-03-10", "tanggal_pulang": "2025-03-20",
                "diagnosis_utama": "J96.0", "tindakan": ["96.72"], "inacbg_kode": "J-1-10-III", "biaya_tagih_rp": 1000, "jam_ventilator": 120, "lama_icu_hari": 5,
                "iot": {"sesi": [sesi("s1", "V1", "ventilator", "jalan", 0, 60, kunjungan="KLM00001")], "alat": ALAT}}
        asli = X.sources
        X.sources = lambda: {"ai-jkn": src}
        try:
            k, meta = X.map_faskes(X.FaskesKlaimIn.model_validate(body), resolver, {})
        finally:
            X.sources = asli
        self.assertEqual((meta["iot_kunjungan"], meta["iot_peserta"]), ("KLM00001", "RM-1"))
        self.assertTrue(meta["iot_validasi"]["diterima"])
        self.assertEqual((meta["klaim_kode"]["jam_ventilator"], meta["klaim_kode"]["lama_icu_hari"]), (120.0, 5))
        h = I.dari_meta(k, meta, None, "F1")
        self.assertIn("IOT_VENTILASI_KURANG_96", kode(h))
        self.assertIn("IOT_TANPA_JEJAK", kode(h))  # 5 ICU days billed, no ICU bed session at a hospital covering ICU beds

    def test_skor_mesin(self):
        from aip.realtime import mesin as E

        h = I.periksa_iot(klaim(tindakan=["9672"]), [sesi("s1", "V1", "ventilator", "jalan", 0, 60)], None, ALAT)
        sc, _, dec, _ = E.score(h["sinyal"], {}, 45, 75)
        self.assertGreaterEqual(sc, 45)
        self.assertEqual(h["sinyal"][0]["tag"], "DURASI_ALAT_TIDAK_SESUAI")
        self.assertEqual(h["sinyal"][0]["modus"], ["M04", "M14"])


if __name__ == "__main__":
    unittest.main()
