"""The outline-first report's code parts (adk_runtime/firm.py), on their own (no model, no network): which sections a
validator's notes send back for rewriting, a section body without the writer's own heading or preamble, and the
assembly. Runs in the ADK runtime's venv:

    ..\\.venv-adk\\Scripts\\python -m unittest test_firm_laporan -v
"""

from __future__ import annotations

import unittest

from aip.adk_runtime import firm as F

SECTIONS = [{"id": "ringkasan", "judul": "Ringkasan eksekutif", "teks": "- Total kerugian Rp 4.792.222.234 [r864]"},
            {"id": "lingkup", "judul": "Lingkup & metode", "teks": "69 agen dan 29 instans dinamis bekerja."},
            {"id": "temuan", "judul": "Temuan utama", "teks": "Kota Padang 68 klaim calon ganda [r774]."},
            {"id": "box", "judul": "Box karantina dan kasus prioritas", "teks": "Kelompok A 9 faskes."},
            {"id": "keandalan", "judul": "Keandalan", "teks": "QA 4/5 lolos."},
            {"id": "keputusan", "judul": "Keputusan yang dibutuhkan dari manusia", "teks": "Konfirmasi tag."}]
EVERY = {s["id"] for s in SECTIONS}


class Implicated(unittest.TestCase):
    def test_a_wrong_number_sends_back_the_section_holding_it(self):
        fix = [{"klaim": "Total estimasi kerugian nasional = Rp 4.792.222.234", "ok": False, "bukti": "4.789.222.234"}]
        self.assertEqual(F._implicated(SECTIONS, fix), {"ringkasan"})

    def test_a_contract_statement_about_the_summary_sends_back_the_summary(self):
        fix = [{"kontrak": "d3", "pernyataan": "Setiap angka di ringkasan eksekutif menyebut hasil_id dan cocok dengan buku besar", "bukti": "x"}]
        self.assertEqual(F._implicated(SECTIONS, fix), {"ringkasan"})

    def test_a_statement_about_recommendations_sends_back_the_box(self):
        fix = [{"kontrak": "d1", "pernyataan": "Setiap faskes kelompok A dan B yang diaudit punya rekomendasi jalur dari penyidiknya", "bukti": "x"}]
        self.assertEqual(F._implicated(SECTIONS, fix), {"box"})

    def test_a_result_id_that_is_not_there_sends_back_the_section_citing_it(self):
        fix = [{"scrutiny": "setiap rujukan [rN] di laporan adalah hasil penugasan ini", "bukti": "2 rujukan; tidak ada: r774"}]
        self.assertEqual(F._implicated(SECTIONS, fix), {"temuan"})

    def test_a_note_that_points_nowhere_sends_back_every_section(self):
        self.assertEqual(F._implicated(SECTIONS, [{"scrutiny": "laporan memakai kata indikasi, bukan fraud terbukti", "bukti": ""}]), EVERY)
        self.assertEqual(F._implicated(SECTIONS, [{"klaim": "jumlah tidak cocok", "ok": False, "bukti": "-"}]), EVERY)
        self.assertEqual(F._implicated(SECTIONS, [{"kontrak": "k2", "pernyataan": "Perbandingan peer sebelum menyebut tidak wajar", "bukti": "x"}]), EVERY)

    def test_notes_add_up(self):
        fix = [{"kontrak": "d3", "pernyataan": "angka di ringkasan eksekutif", "bukti": ""}, {"klaim": "Kota Padang 68", "ok": False, "bukti": "67"}]
        self.assertEqual(F._implicated(SECTIONS, fix), {"ringkasan", "temuan"})


class Sections(unittest.TestCase):
    def test_the_body_without_its_heading_or_preamble(self):
        self.assertEqual(F._section_only("## Ringkasan eksekutif\n\nBerikut ringkasan eksekutif:\n- satu [r1]"), "- satu [r1]")
        self.assertEqual(F._section_only("Baik, berikut isinya.\nIsi bagian."), "Isi bagian.")
        self.assertEqual(F._section_only("Berikut ini tidak dibuang karena satu-satunya baris"), "Berikut ini tidak dibuang karena satu-satunya baris")

    def test_assembly_names_an_empty_section(self):
        text = F._assemble("Judul", [{"judul": "A", "teks": "isi"}, {"judul": "B", "teks": ""}])
        self.assertTrue(text.startswith("# Judul\n\n## A\n\nisi"))
        self.assertIn("## B\n\n_(tidak ada poin bersumber", text)


if __name__ == "__main__":
    unittest.main()
