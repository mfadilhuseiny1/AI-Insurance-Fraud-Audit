"""The report desk's gate on the editor (adk_runtime/firm.py _edit_refused): an edit may change the words of a section,
never its numbers, its result ids or its tag codes. Run with the ADK venv: .venv-adk/Scripts/python -m unittest test_laporan_redaksi"""
import unittest

from aip.adk_runtime.firm import NOT_DOMAIN, SECTIONS, SOURCED, _edit_refused

OLD = ("- Sepuluh faskes kelompok A menanggung Rp 2,70 miliar (52,2%) estimasi kerugian [r1331].\n"
       "- 905 klaim calon ganda (KLAIM_GANDA) terkonsentrasi di Kota Padang (68) [r1334].")


class EditGate(unittest.TestCase):
    def test_a_language_edit_is_kept(self):
        new = ("- Sepuluh faskes di kelompok A menanggung Rp 2,70 miliar (52,2%) dari estimasi kerugian [r1331].\n"
               "- Sebanyak 905 klaim calon ganda (KLAIM_GANDA) terkumpul di Kota Padang (68) [r1334].")
        self.assertEqual(_edit_refused(OLD, new), "")

    def test_a_changed_number_is_refused(self):
        self.assertIn("angka berubah", _edit_refused(OLD, OLD.replace("52,2%", "52%")))
        self.assertIn("angka berubah", _edit_refused(OLD, OLD.replace("905", "sekitar 900")))

    def test_a_dropped_or_new_result_id_is_refused(self):
        # a result id's digits count as numbers too, so the number check already refuses it
        self.assertTrue(_edit_refused(OLD, OLD.replace(" [r1334]", "")))
        self.assertTrue(_edit_refused(OLD, OLD.replace("[r1334]", "[r1335]")))

    def test_a_dropped_tag_code_is_refused(self):
        self.assertIn("kode tag hilang", _edit_refused(OLD, OLD.replace("(KLAIM_GANDA) ", "")))

    def test_an_empty_or_much_shorter_edit_is_refused(self):
        self.assertEqual(_edit_refused(OLD, "  "), "suntingan kosong")
        short = "Kelompok A: Rp 2,70 miliar 52,2% [r1331]; 905 KLAIM_GANDA Padang 68 [r1334]."
        self.assertIn("panjang berubah", _edit_refused(OLD, short))


class Desk(unittest.TestCase):
    def test_the_report_desk_is_not_a_domain_lead(self):
        self.assertIn("redaksi", NOT_DOMAIN)
        self.assertIn("validator", NOT_DOMAIN)

    def test_where_and_how_are_sections_with_sources(self):
        ids = [s[0] for s in SECTIONS]
        self.assertLess(ids.index("temuan"), ids.index("wilayah"))
        self.assertLess(ids.index("wilayah"), ids.index("modus"))
        self.assertTrue({"wilayah", "modus"} <= SOURCED)


if __name__ == "__main__":
    unittest.main()
