"""Unit tests of the user-defined rules (aip/realtime/aturan_kustom.py): the expression language, the store's status
machine and versions, the engine hook, the backtest on stored events and the AI draft (HTTP mocked: no network).
Everything runs in a temporary data folder; no engine, no API.

    cd api && ..\\.venv\\Scripts\\python.exe -m unittest test_aturan_kustom
"""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from aip import vertex as V
from aip.realtime import aturan_kustom as AK
from aip.realtime import mesin as E
from aip.realtime import ssl as SSL


def baris(**v) -> AK.Baris:
    return AK.Baris(v, set(v.pop("_sinyal", set())) if "_sinyal" in v else set())


def fake_ref() -> SimpleNamespace:
    pair = {("J18", "J-4-16-I"): 900, ("J18", "K-1-10-I"): 2}

    def rare(dx, code):
        n = pair.get((dx, code), 0)
        return (n, 5000) if dx == "J18" and n <= 3 else None
    return SimpleNamespace(kode={"J-4-16-I": {"n": 5000, "dx_sek_p99": 4.0}},
                           topup={("J-4-16-I", "sd_tarif_rp"): {"n": 40, "p95": 1_000_000.0}, ("J-4-16-I", "sa_tarif_rp"): {"n": 0, "p95": 0.0}},
                           pair=pair, dx_total={"J18": 5000}, rare_pair=rare)


class Folder(unittest.TestCase):
    """A temporary data folder for the store, the engine's config and the event store."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old = V.DIR
        V.DIR = Path(self.tmp.name) / "aip" / "vertex_spend"
        V.DIR.mkdir(parents=True, exist_ok=True)
        AK._EFEKTIF.update(nilai=None, tanda=None, cek=0.0)

    def tearDown(self) -> None:
        V.DIR = self.old
        AK._EFEKTIF.update(nilai=None, tanda=None, cek=0.0)
        self.tmp.cleanup()


BODY = {"kode": "TOPUP_OBAT_3X", "label": "Top-up obat > 3x p95", "deskripsi": "uji", "kondisi": 'tingkat_pelayanan == "RITL" and sd_tarif_rp > 2000000',
        "modus": ["M07"], "bobot": 0.9, "menggantikan": None}
UJI = {"versi": 0, "kena": {"normal": 1, "fraud": 1}, "laju_normal": 0.1, "recall": 1.0, "precision": 0.5, "beban_per_hari": 1.0}


def fake_uji(rec, ver):
    return {**UJI, "versi": ver["versi"]}


# =====================================================================================================================
class TestBahasa(unittest.TestCase):
    def bad(self, kondisi: str, what: str = "") -> None:
        r = AK.validasi(kondisi)
        self.assertFalse(r["ok"], kondisi)
        if what:
            self.assertIn(what, r["error"])

    def test_rejects_unsafe_and_unknown(self):
        self.bad('__import__("os")', "fungsi tidak dikenal")
        self.bad('__import__("os").system("dir")', "tanpa titik")
        self.bad("().__class__", "atribut")
        self.bad("tingkat_pelayanan.upper() == 'RITL'", "tanpa titik")
        self.bad("tingkat_pelayanan.real == 'RITL'", "atribut")
        self.bad('prosedur[0] == "9"', "indeks")
        self.bad("(lambda: True)()", "")
        self.bad("lambda: True", "lambda")
        self.bad("[x for x in [1, 2]] == [1]", "comprehension")
        self.bad("any(x > 1 for x in [1, 2])", "")
        self.bad("{1: 2} == {1: 2}", "dict")
        self.bad('eval("1") == 1', "fungsi tidak dikenal")
        self.bad('exec("x = 1")', "fungsi tidak dikenal")
        self.bad("open('x')", "fungsi tidak dikenal")
        self.bad("los_hari ** 2 > 4", "**")
        self.bad("los_hari // 2 > 4", "//")
        self.bad("losx > 1", "field tidak dikenal")
        self.bad("_x > 1", "tidak diizinkan")
        self.bad("medlos() > 1", "fungsi tidak dikenal")
        self.bad("prosedur == None", "kosong")
        self.bad("prosedur is None", "")
        self.bad("p95_topup(sd_tarif_rp) > 1", "konstanta")
        self.bad('p95_topup("biaya_tagih_rp") > 1', "kolom top-up")
        self.bad('p95_topup(kolom="sd_tarif_rp") > 1', "argumen bernama")
        self.bad('sinyal("TIDAK_ADA") ', "tidak dikenal")
        self.bad("los_hari + 1", "benar/salah")
        self.bad('los_hari == "3"', "tipe tidak cocok")
        self.bad("los_hari > 1 if True else False", "if-else")
        self.bad("(x := 1) == 1", ":=")
        self.bad("", "kosong")
        self.bad("los_hari > 1 and " * 80 + "True", "terlalu panjang")
        self.bad("(" * 120 + "True" + ")" * 120, "tidak membaca field")
        self.bad("1 < 2", "tidak membaca field")
        self.bad("not " * 30 + "pbi", "bersarang")
        self.bad("los_hari > 1 >", "sintaks")

    def test_accepts_contract_example_and_reports_fields(self):
        r = AK.validasi('tingkat_pelayanan == "RITL" and sd_tarif_rp > 3 * p95_topup("sd_tarif_rp") and hari_sejak_sebelumnya > 30')
        self.assertTrue(r["ok"], r["error"])
        self.assertEqual(r["field"], ["hari_sejak_sebelumnya", "sd_tarif_rp", "tingkat_pelayanan"])
        self.assertEqual(r["fungsi"], ["p95_topup"])
        self.assertTrue(r["pakai_referensi"])
        for c in AK.CONTOH:
            self.assertTrue(AK.validasi(c)["ok"], c)

    def test_evaluation_and_none(self):
        ex = AK.kompilasi("umur > 60")
        self.assertTrue(ex(baris(umur=61.0)))
        self.assertFalse(ex(baris(umur=None)))
        self.assertTrue(AK.kompilasi("not (umur > 60)")(baris(umur=None)))  # a comparison with None is False
        self.assertFalse(AK.kompilasi("umur != 60")(baris(umur=None)))
        self.assertFalse(AK.kompilasi("los_hari + 1 > 0")(baris(los_hari=None)))  # arithmetic with None gives None
        self.assertFalse(AK.kompilasi("biaya_tagih_rp / tarif_inacbg_rp > 1")(baris(biaya_tagih_rp=5, tarif_inacbg_rp=0)))  # no ZeroDivisionError
        self.assertTrue(AK.kompilasi("biaya_tagih_rp / tarif_inacbg_rp > 1.5")(baris(biaya_tagih_rp=4, tarif_inacbg_rp=2)))
        self.assertTrue(AK.kompilasi("-los_hari < 0")(baris(los_hari=2)))
        self.assertFalse(AK.kompilasi("pbi")(baris(pbi=None)))
        self.assertTrue(AK.kompilasi("not pbi")(baris(pbi=None)))
        self.assertTrue(AK.kompilasi("kode_digit in [1, 2, 3] and not ada_prosedur")(baris(kode_digit=2, ada_prosedur=False)))
        self.assertFalse(AK.kompilasi("kode_digit in [1, 2, 3]")(baris(kode_digit=None)))
        self.assertFalse(AK.kompilasi("kode_digit not in [1, 2, 3]")(baris(kode_digit=None)))
        self.assertTrue(AK.kompilasi('"9304" in prosedur')(baris(prosedur="9304 - Manual testing")))
        self.assertFalse(AK.kompilasi('"9304" in prosedur')(baris(prosedur=None)))
        self.assertTrue(AK.kompilasi('dx_primer_icd3 >= "O00" and dx_primer_icd3 <= "O99"')(baris(dx_primer_icd3="O80")))
        self.assertTrue(AK.kompilasi('1 < los_hari < 5')(baris(los_hari=3)))
        self.assertFalse(AK.kompilasi('1 < los_hari < 5')(baris(los_hari=7)))
        d = baris(tgl_datang=date(2024, 12, 20), tgl_pulang=date(2024, 12, 26))
        self.assertTrue(AK.kompilasi('tgl_datang >= "2024-12-20" and tgl_pulang - tgl_datang > 5')(d))
        self.assertFalse(AK.kompilasi('tgl_datang > "2024-12-20"')(d))
        self.assertTrue(AK.kompilasi('kosong("prosedur")')(baris(prosedur=None)))
        self.assertTrue(AK.kompilasi('sinyal("LOS_DIPERPANJANG")')(AK.Baris({}, {"LOS_DIPERPANJANG"})))
        self.assertFalse(AK.validasi('tgl_datang > "20-12-2024"')["ok"])

    def test_reference_functions(self):
        R = fake_ref()
        los = {"J-4-16-I": (3.0, 6.0)}
        ex = AK.kompilasi('tingkat_pelayanan == "RITL" and sd_tarif_rp > 3 * p95_topup("sd_tarif_rp") and los_hari > p90_los() '
                          'and med_los() == 3 and n_topup("sd_tarif_rp") == 40 and frek_pasangan() == 900 and not rare_pair()')
        v = {"tingkat_pelayanan": "RITL", "sd_tarif_rp": 3_500_000, "los_hari": 7, "inacbg_kode": "J-4-16-I", "dx_primer_icd3": "J18"}
        self.assertTrue(ex(AK.Baris(v, set(), R, los)))
        self.assertFalse(ex(AK.Baris({**v, "sd_tarif_rp": 2_900_000}, set(), R, los)))
        self.assertFalse(ex(AK.Baris(v, set(), None, None)))  # no references: unknown, never an error
        self.assertTrue(AK.kompilasi('rare_pair("J18", "K-1-10-I")')(AK.Baris(v, set(), R, los)))
        self.assertFalse(AK.kompilasi('sd_tarif_rp > p95_topup("sa_tarif_rp")')(AK.Baris(v, set(), R, los)))  # never carried: None

    def test_row_from_claim_object(self):
        c = SimpleNamespace(tingkat_pelayanan="RITL", kelas_rawat="Kelas 1", inacbg_kode="K-1-10-II", inacbg_keparahan="Sedang (rawat inap keparahan 2)",
                            dx_primer_icd3="K35", jumlah_dx_sekunder=2, prosedur="  ", los_hari=4, tarif_inacbg_rp=9_000_000, sa_tarif_rp=0,
                            sp_tarif_rp=500_000, rr_tarif_rp=0, si_tarif_rp=0, sd_tarif_rp=250_000, biaya_tagih_rp=10_000_000, kabkota_fkrtl_kode=3273,
                            jenis_fkrtl="Rumah sakit", tipe_fkrtl="RS Kelas B", kepemilikan_fkrtl="Swasta", poli=None, status_pulang="Sehat",
                            tgl_datang=date(2024, 12, 20), tgl_pulang=date(2024, 12, 24))
        row = {"idx_los": 1.5, "kembar": 1, "hari_sejak_sebelumnya": 9999, "p_berat_dx": float("nan")}
        m = {"jk": "P", "tgl_lahir": date(1980, 12, 20), "hak": float("nan"), "segmen": "PBI APBN", "unit_terdaftar": "3204|PEMERINTAH|PUSKESMAS"}
        b = AK.baris_klaim(c, row, m, [{"kode": "LOS_DIPERPANJANG", "s": 1.0}, {"kode": "SKOR_ML", "s": 0.0}], None, None)
        v = b.v
        self.assertEqual(v["topup_total"], 750_000)
        self.assertEqual((v["kode_digit"], v["sev"], v["kelas_angka"]), (1, "II", 1))
        self.assertFalse(v["ada_prosedur"])
        self.assertIsNone(v["prosedur"])
        self.assertAlmostEqual(v["umur"], 44.0, places=1)
        self.assertIsNone(v["hak_kelas"])
        self.assertTrue(v["pbi"])
        self.assertEqual(v["kab_fktp_terdaftar"], 3204)
        self.assertIsNone(v["p_berat_dx"])
        self.assertEqual(v["hari_sejak_sebelumnya"], 9999.0)
        self.assertEqual(b.sinyal, {"LOS_DIPERPANJANG"})
        self.assertTrue(AK.kompilasi("kabkota_fkrtl_kode != kab_fktp_terdaftar and pbi and kelas_angka < 3")(b))


# =====================================================================================================================
class TestStore(Folder):
    def test_hapus(self):
        a = AK.buat(BODY, "auditor")
        rid = a["id"]
        r = AK.hapus(rid, "auditor", False)
        self.assertEqual((r["dihapus"], r["berjalan_sebelumnya"]), (True, False))
        self.assertEqual(AK.daftar()["kustom"], [])
        with self.assertRaises(HTTPException) as cm:
            AK.ambil(rid)
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(len(list((AK._dir() / "_terhapus").glob(f"{rid}-*.json"))), 1)  # archived, not lost
        self.assertEqual(AK.log_baca()[0]["aksi"], "hapus")
        # a running rule: an admin only, and it stops running
        b = AK.buat({**BODY, "kode": "RULE_KEDUA"}, "auditor")
        with mock.patch.object(AK, "_uji_kustom", fake_uji):
            AK.uji("kustom", b["id"], "auditor")
        AK.ajukan("kustom", b["id"], "auditor")
        AK.setujui("kustom", b["id"], "admin")
        self.assertEqual(len(AK.efektif().aturan), 1)
        with self.assertRaises(HTTPException) as cm:
            AK.hapus(b["id"], "auditor", False)
        self.assertEqual(cm.exception.status_code, 403)
        r = AK.hapus(b["id"], "admin", True)
        self.assertTrue(r["berjalan_sebelumnya"])
        self.assertEqual(len(AK.efektif().aturan), 0)
        # its code is free again
        self.assertEqual(AK.buat({**BODY, "kode": "RULE_KEDUA"}, "auditor")["kode"], "RULE_KEDUA")

    def test_status_machine_versions_and_rollback(self):
        a = AK.buat(BODY, "auditor")
        rid = a["id"]
        self.assertEqual((a["status"], a["versi"], a["versi_aktif"]), ("draf", 1, None))
        with self.assertRaises(HTTPException) as cm:
            AK.ajukan("kustom", rid, "auditor")  # no backtest yet
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIn("uji", cm.exception.detail)
        with self.assertRaises(HTTPException):
            AK.setujui("kustom", rid, "admin")  # not submitted
        with mock.patch.object(AK, "_uji_kustom", fake_uji):
            u = AK.uji("kustom", rid, "auditor")
        self.assertEqual(u["versi"], 1)
        self.assertEqual(AK.ambil(rid)["status"], "diuji")
        self.assertEqual(AK.ajukan("kustom", rid, "auditor")["status"], "menunggu")
        a = AK.setujui("kustom", rid, "admin", "ok")
        self.assertEqual((a["status"], a["versi_aktif"], a["berjalan"]), ("aktif", 1, True))
        # an edit: a new version back to draf, the approved one keeps running
        a = AK.ubah(rid, {**BODY, "kondisi": 'tingkat_pelayanan == "RITL" and sd_tarif_rp > 3000000', "bobot": 1.1}, "auditor")
        self.assertEqual((a["status"], a["versi"], a["versi_aktif"]), ("draf", 2, 1))
        self.assertEqual(len(a["versi_daftar"]), 2)
        self.assertIsNone(a["uji"])
        with self.assertRaises(HTTPException):
            AK.ubah(rid, {**BODY, "kode": "LAIN_KODE"}, "auditor")  # the code is fixed
        with mock.patch.object(AK, "_uji_kustom", fake_uji):
            AK.uji("kustom", rid, "auditor")
        AK.ajukan("kustom", rid, "auditor")
        with self.assertRaises(HTTPException):
            AK.tolak("kustom", rid, "admin", "")  # a reason is required
        a = AK.tolak("kustom", rid, "admin", "terlalu longgar")
        self.assertEqual((a["status"], a["versi_aktif"]), ("ditolak", 1))
        with self.assertRaises(HTTPException):
            AK.ajukan("kustom", rid, "auditor")  # rejected: edit first
        with self.assertRaises(HTTPException):
            AK.rollback("kustom", rid, 2, "admin")  # never approved
        a = AK.nonaktifkan("kustom", rid, "admin")
        self.assertIsNone(a["versi_aktif"])
        with self.assertRaises(HTTPException):
            AK.nonaktifkan("kustom", rid, "admin")
        a = AK.rollback("kustom", rid, 1, "admin", "kembali ke v1")
        self.assertEqual((a["status"], a["versi"], a["versi_aktif"]), ("aktif", 1, 1))
        self.assertEqual(a["kondisi"], BODY["kondisi"])
        aksi = [x["aksi"] for x in AK.log_baca()]
        self.assertEqual(aksi[0], "rollback")
        for x in ("buat", "uji", "ajukan", "setujui", "ubah", "tolak", "nonaktifkan"):
            self.assertIn(x, aksi)
        d = AK.daftar()
        self.assertEqual(d["ringkas"]["aktif"], 1)
        self.assertEqual(len(d["bawaan"]), len(AK.MO.SIGNALS))

    def test_body_checks(self):
        AK.buat(BODY, "a")
        for body, code in (({**BODY}, 409), ({**BODY, "kode": "LOS_DIPERPANJANG"}, 409), ({**BODY, "kode": "ab"}, 400),
                           ({**BODY, "kode": "BARU", "kondisi": "x.y"}, 400), ({**BODY, "kode": "BARU", "bobot": 9}, 400),
                           ({**BODY, "kode": "BARU", "modus": ["M99"]}, 400), ({**BODY, "kode": "BARU", "menggantikan": "KONTAK_SEMU"}, 400)):
            with self.assertRaises(HTTPException) as cm:
                AK.buat(body, "a")
            self.assertEqual(cm.exception.status_code, code, body)

    def test_engine_hook_signals_for_active_rules_only(self):
        a1 = AK.buat(BODY, "a")
        AK.buat({**BODY, "kode": "LOS_PANJANG_X", "kondisi": "los_hari > 2", "modus": ["M12"], "bobot": 0.5}, "a")  # draft only
        c = SimpleNamespace(tingkat_pelayanan="RITL", sd_tarif_rp=2_500_000, los_hari=5, inacbg_kode="J-4-16-I", dx_primer_icd3="J18",
                            tgl_datang=date(2024, 12, 20))
        sigs = [{"kode": "LOS_DIPERPANJANG", "s": 1.0, "w": 0, "mitigasi": []}]
        out, w = AK.terapkan(sigs, {"X": 1.0}, c, {}, None, None, None, "F1")
        self.assertEqual([s["kode"] for s in out], ["LOS_DIPERPANJANG"])  # nothing active yet
        with mock.patch.object(AK, "_uji_kustom", fake_uji):
            AK.uji("kustom", a1["id"], "a")
        AK.ajukan("kustom", a1["id"], "a")
        AK.setujui("kustom", a1["id"], "admin")
        out, w = AK.terapkan(sigs, {"X": 1.0}, c, {}, None, None, None, "F1")
        self.assertEqual(len(sigs), 1)  # the input list is not changed in place
        mine = [s for s in out if s["kode"] == "TOPUP_OBAT_3X"]
        self.assertEqual(len(mine), 1)
        self.assertEqual((mine[0]["w"], mine[0]["label"], mine[0]["modus"], mine[0]["fokus"]), (0.9, BODY["label"], ["M07"], ["faskes", "F1"]))
        self.assertIn("sd_tarif_rp = 2.500.000", mine[0]["bukti"])
        # the engine's own scoring keeps the custom weight and modes
        sc, _, dec, _ = E.score(out, w, 45, 75)
        self.assertGreater(sc, 0)
        self.assertIn("M07", next(s for s in out if s["kode"] == "TOPUP_OBAT_3X")["modus"])
        out, _ = AK.terapkan(sigs, {}, SimpleNamespace(**{**vars(c), "sd_tarif_rp": 100}), {}, None, None, None, "F1")
        self.assertNotIn("TOPUP_OBAT_3X", [s["kode"] for s in out])
        # a built-in switched off and another reweighted (approved changes), mirrored into the engine's config
        AK.ubah_bawaan("LOS_DIPERPANJANG", False, None, "matikan", "a")
        AK.ubah_bawaan("SKOR_ML", None, 0.7, "", "a")
        for k in ("LOS_DIPERPANJANG", "SKOR_ML"):
            with mock.patch.object(AK, "_uji_bawaan", fake_uji):
                AK.uji("bawaan", k, "a")
            AK.ajukan("bawaan", k, "a")
            AK.setujui("bawaan", k, "admin")
        out, w = AK.terapkan(sigs, {"SKOR_ML": 1.4}, c, {}, None, None, None, "F1")
        self.assertNotIn("LOS_DIPERPANJANG", [s["kode"] for s in out])
        self.assertEqual(w["SKOR_ML"], 0.7)
        cfg = E.config()
        self.assertEqual(cfg["bobot"]["LOS_DIPERPANJANG"], 0.0)
        self.assertEqual(cfg["bobot"]["SKOR_ML"], 0.7)
        self.assertEqual(cfg["sinyal_nonaktif"], ["LOS_DIPERPANJANG"])
        b = next(x for x in AK.daftar()["bawaan"] if x["kode"] == "LOS_DIPERPANJANG")
        self.assertFalse(b["aktif"])
        # withdrawn: back to the default, and out of the config again
        AK.nonaktifkan("bawaan", "LOS_DIPERPANJANG", "admin")
        out, _ = AK.terapkan(sigs, {}, c, {}, None, None, None, "F1")
        self.assertIn("LOS_DIPERPANJANG", [s["kode"] for s in out])
        self.assertNotIn("LOS_DIPERPANJANG", E.config()["bobot"])

    def test_hook_reloads_after_another_process_changed_the_store(self):
        a = AK.buat({**BODY, "kondisi": "los_hari > 2"}, "a")
        c = SimpleNamespace(los_hari=5, tgl_datang=date(2024, 12, 20))
        self.assertEqual(AK.terapkan([], {}, c, {}, None, None, None, "F")[0], [])
        # approve by writing the record directly (as another process would) and rewriting the stamp
        p = AK._dir() / f"{a['id']}.json"
        rec = json.loads(p.read_text("utf-8"))
        rec.update(status="aktif", versi_aktif=1)
        p.write_text(json.dumps(rec), "utf-8")
        (AK._dir() / "_stempel").write_text("lain", "utf-8")
        AK._EFEKTIF["cek"] = 0.0  # the stamp is read at most every CEK_DETIK seconds
        self.assertEqual([s["kode"] for s in AK.terapkan([], {}, c, {}, None, None, None, "F")[0]], ["TOPUP_OBAT_3X"])

    def test_hook_errors_never_break_scoring(self):
        a = AK.buat({**BODY, "kondisi": 'sd_tarif_rp > p95_topup("sd_tarif_rp")'}, "a")
        with mock.patch.object(AK, "_uji_kustom", fake_uji):
            AK.uji("kustom", a["id"], "a")
        AK.ajukan("kustom", a["id"], "a")
        AK.setujui("kustom", a["id"], "admin")
        broken = SimpleNamespace(topup=None)  # .get on None raises inside the rule
        c = SimpleNamespace(sd_tarif_rp=5, inacbg_kode="J-4-16-I", tgl_datang=date(2024, 12, 20))
        out, _ = AK.terapkan([{"kode": "SKOR_ML", "s": 1.0}], {}, c, {}, None, broken, None, "F")
        self.assertEqual([s["kode"] for s in out], ["SKOR_ML"])


# =====================================================================================================================
def _event(eid: str, kid: str, sk_topup: int, sinyal: list[dict], dec: str = "LOLOS", tgl: str = "2024-12-20") -> dict:
    x = {c: None for c in SSL.FKRTL.base_cols}
    x.update(tingkat_pelayanan="RITL", kelas_rawat="Kelas 3", jenis_fkrtl="Rumah sakit", tarif_tambahan=float(sk_topup), dx_sekunder=1.0,
             hari_sejak_sebelumnya=9999.0, kembar=1.0, idx_los=1.0)
    return {"id": eid, "jenis": "fkrtl", "klaim": f"reguler:{kid}", "kunjungan": kid, "sumber": "simulator", "versi": 1, "diterima": 1.0, "diputus": 1.1,
            "latensi_ms": 1.0, "skor": 0.0, "keputusan": dec, "faskes": "F1", "faskes_label": "RS Kelas C · Swasta · KOTA X", "peserta": 7, "edisi": "reguler",
            "tgl_datang": tgl, "tgl_pulang": "2024-12-23", "tingkat": "RITL", "kode": "J-4-16-I", "dx3": "J18", "keparahan": "Ringan (rawat inap keparahan 1)",
            "biaya": 5_000_000 + sk_topup, "tarif": 4_000_000, "los": 3, "kasus": None,
            "gi": {"kab": 3273, "tipe": "RS Kelas C", "prosedur": None, "status_pulang": "Sehat", "poli": None, "tarif_total": 4_000_000 + sk_topup},
            "anggota": {"jk": "P", "tahun_lahir": 1970, "hak_kelas": 3, "segmen": "PBPU"},
            "ssl": {"spek": SSL.FKRTL.key(), "x": [x[c] for c in SSL.FKRTL.base_cols]}, "sinyal": sinyal}


class TestBacktest(Folder):
    def setUp(self) -> None:
        super().setUp()
        from aip.realtime.store import Store

        st = Store()
        peer = {"kode": "TOPUP_DI_ATAS_PEER", "s": 1.0, "w": 0.8, "mitigasi": [], "kontribusi": 0.8,
                "bukti": "top-up obat khusus Rp4.500.000 = 4,5× p95 kode J-4-16-I (Rp1.000.000)"}
        evs = [_event("ev-n1", "N1", 0, []), _event("ev-n2", "N2", 0, [], tgl="2024-12-21"),
               _event("ev-n3", "N3", 0, [{"kode": "LOS_DIPERPANJANG", "s": 1.0, "w": 0.5, "mitigasi": [], "kontribusi": 0.5, "bukti": ""}]),
               _event("ev-t1", "SIMTOPUP01", 4_500_000, [peer], dec="PERIKSA"),
               _event("ev-t2", "SIMTOPUP02", 3_000_000, [])]  # a planted top-up the built-ins missed: its column is unknown
        st.add_events(evs)
        st.add_truth([("ev-n1", "reguler:N1", "normal", None, 0, 1.0), ("ev-n2", "reguler:N2", "normal", None, 0, 1.0),
                      ("ev-n3", "reguler:N3", "normal", None, 1, 1.0), ("ev-t1", "reguler:SIMTOPUP01", "topup_inflasi", "topup_inflasi-0001", None, 1.0),
                      ("ev-t2", "reguler:SIMTOPUP02", "topup_inflasi", "topup_inflasi-0002", None, 1.0)])
        st.con.close()
        self.src = {"R": fake_ref(), "los": {"J-4-16-I": (3.0, 6.0)}, "con": None, "window": None}

    def test_custom_rule_backtest(self):
        a = AK.buat({**BODY, "kondisi": 'tingkat_pelayanan == "RITL" and sd_tarif_rp > 3 * p95_topup("sd_tarif_rp")'}, "a")
        with mock.patch.object(AK, "_sumber_mesin", lambda: None), self.assertRaises(HTTPException) as cm:
            AK.uji("kustom", a["id"], "a")  # reference functions need the warm engine
        self.assertEqual(cm.exception.status_code, 409)
        with mock.patch.object(AK, "_sumber_mesin", lambda: self.src):
            u = AK.uji("kustom", a["id"], "a")
        self.assertEqual((u["klaim"], u["normal"], u["fraud"]), (5, 3, 2))
        self.assertEqual(u["kena"], {"normal": 0, "fraud": 1})
        self.assertEqual((u["recall"], u["precision"], u["laju_normal"]), (0.5, 1.0, 0.0))
        self.assertEqual(u["per_skema"], [{"skema": "topup_inflasi", "label": "Top-up obat/alkes digelembungkan", "n": 2, "kena": 1}])
        self.assertEqual(u["unik"], {"fraud_baru_vs_rule": 0, "fraud_baru_vs_keputusan": 0})  # the built-in peer rule caught it too
        self.assertEqual(u["contoh_kode"], ["reguler:SIMTOPUP01"])
        self.assertEqual(u["hari"], 2)
        self.assertEqual(u["beban_per_hari"], 0.5)
        self.assertEqual(u["cakupan"]["sd_tarif_rp"], 0.8)  # SIMTOPUP02's top-up column is not known
        self.assertTrue(any("sd_tarif_rp" in p for p in u["peringatan"]))
        self.assertIn("5 klaim FKRTL berlabel", u["data"])
        self.assertEqual(u["dampak"]["sesudah"]["alert"]["fraud"], 1)
        self.assertEqual(AK.ambil(a["id"])["status"], "diuji")
        self.assertEqual(AK.ajukan("kustom", a["id"], "a")["status"], "menunggu")

    def test_builtin_change_backtest(self):
        AK.ubah_bawaan("TOPUP_DI_ATAS_PEER", None, 1.6, "naikkan", "a")
        with mock.patch.object(AK, "_sumber_mesin", lambda: None):
            u = AK.uji("bawaan", "TOPUP_DI_ATAS_PEER", "a")
        self.assertEqual(u["kena"], {"normal": 0, "fraud": 1})
        self.assertEqual(u["dampak"]["sebelum"]["alert"]["fraud"], 1)  # 0.8 -> score 55: PERIKSA
        self.assertEqual(u["dampak"]["sesudah"]["tahan"], 1)  # 1.6 -> score 80: TAHAN
        AK.ubah_bawaan("TOPUP_DI_ATAS_PEER", False, None, "matikan", "a")
        with mock.patch.object(AK, "_sumber_mesin", lambda: None):
            u = AK.uji("bawaan", "TOPUP_DI_ATAS_PEER", "a")
        self.assertEqual(u["kena"], {"normal": 0, "fraud": 0})
        self.assertEqual(u["dampak"]["berubah"]["fraud_turun"], 1)
        self.assertEqual(u["contoh_kode"], ["reguler:SIMTOPUP01"])


# =====================================================================================================================
def _jawab(obj: dict, cost: float = 0.0004) -> tuple[int, dict]:
    return 200, {"choices": [{"message": {"content": json.dumps(obj)}}], "usage": {"cost": cost}}


class TestAI(Folder):
    def test_draft_retries_once_with_the_parser_error(self):
        sent = []
        answers = [_jawab({"aksi": "aturan_baru", "kode": "topup obat", "label": "Top-up obat", "kondisi": "sd_tarif_rp.real > 1", "modus": ["M07"],
                           "bobot": 0.8}),
                   _jawab({"aksi": "aturan_baru", "kode": "topup obat", "label": "Top-up obat khusus > 3x p95",
                           "kondisi": 'tingkat_pelayanan == "RITL" and sd_tarif_rp > 3 * p95_topup("sd_tarif_rp")', "modus": ["M07", "M99"],
                           "bobot": 5, "menggantikan": "null", "penjelasan": "p", "peringatan": ["ambang 3x dipilih dari permintaan"]}, 0.0006)]

        def post(url, headers, body, timeout):
            sent.append(body)
            self.assertEqual(headers["Authorization"], "Bearer kunci-uji")
            return answers[len(sent) - 1]
        with mock.patch.object(AK, "_kunci_ai", lambda: "kunci-uji"), mock.patch.object(AK, "_http_post", post), \
                mock.patch.object(AK, "_sumber_mesin", lambda: None):
            d = AK.ai_draf("tandai rawat inap yang top-up obat khususnya lebih dari 3 kali p95 kode itu")
        self.assertTrue(d["valid"], d["error"])
        self.assertEqual(len(sent), 2)
        b = sent[0]
        self.assertEqual(b["model"], "deepseek/deepseek-v4.1-flash")
        self.assertEqual(b["reasoning"], {"effort": "low"})
        self.assertEqual(b["provider"], {"data_collection": "deny", "allow_fallbacks": True})
        self.assertEqual(b["usage"], {"include": True})
        self.assertLessEqual(b["max_tokens"], 2500)
        self.assertIn("p95_topup", b["messages"][0]["content"])  # the catalogue and functions
        self.assertIn("M07", b["messages"][0]["content"])  # the modes
        self.assertIn("atribut", sent[1]["messages"][-1]["content"])  # the retry carries the parser's error
        self.assertEqual(d["kode"], "TOPUP_OBAT")
        self.assertEqual(d["modus"], ["M07"])
        self.assertEqual(d["bobot"], 2.0)
        self.assertIsNone(d["menggantikan"])
        self.assertEqual(d["field_dipakai"], ["sd_tarif_rp", "tingkat_pelayanan"])
        self.assertTrue(math.isclose(d["biaya_usd"], 0.001))
        self.assertTrue(any("bobot" in p for p in d["peringatan"]))

    def test_draft_invalid_twice_and_builtin_parameter_edit(self):
        bad = _jawab({"kode": "X", "kondisi": "los_hari ** 2 > 1", "bobot": 1})
        with mock.patch.object(AK, "_kunci_ai", lambda: "k"), mock.patch.object(AK, "_http_post", lambda *a: bad):
            d = AK.ai_draf("aturan aneh")
        self.assertFalse(d["valid"])
        self.assertIn("**", d["error"])
        self.assertTrue(math.isclose(d["biaya_usd"], 0.0008))
        par = _jawab({"aksi": "ubah_parameter", "kode": "LOS_DIPERPANJANG", "parameter": {"bobot": 0.3}, "kondisi": "", "perubahan": "bobot turun"})
        with mock.patch.object(AK, "_kunci_ai", lambda: "k"), mock.patch.object(AK, "_http_post", lambda *a: par):
            d = AK.ai_edit("turunkan bobotnya", kode_bawaan="LOS_DIPERPANJANG")
        self.assertTrue(d["valid"], d["error"])
        self.assertEqual((d["aksi"], d["parameter"], d["kode"]), ("ubah_parameter", {"bobot": 0.3}, "LOS_DIPERPANJANG"))
        self.assertEqual(d["sebelum"], {"kondisi": None, "bobot": 0.5, "aktif": True})
        self.assertEqual(d["perubahan"], "bobot turun")

    def test_no_key_and_no_network(self):
        with mock.patch.object(AK, "_kunci_ai", lambda: ""), self.assertRaises(HTTPException) as cm:
            AK.ai_draf("apa saja")
        self.assertEqual(cm.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
