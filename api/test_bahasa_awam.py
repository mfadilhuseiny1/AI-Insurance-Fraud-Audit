"""The plain-language layer's number gate (adk_runtime/orkestrasi.plain_check), on its own (no model): a sentence for
leaders may only use numbers the validated briefing gives, or readings of them code recomputes. Runs in the ADK
runtime's venv:

    ..\\.venv-adk\\Scripts\\python -m unittest test_bahasa_awam -v
"""

from __future__ import annotations

import unittest

from aip.adk_runtime import orkestrasi as O

BRIEFING = """**Model rumah sakit: AUPRC 0,086, jauh di atas pembanding**
- Klaim positif rumah sakit: 315 dari 5.296.605 klaim (0,006%) [r1]
- Lift pada 0,1% teratas: 551× (precision@k 3,2%) [r2]
- Semua klaim FKRTL: AUPRC 0,837, prevalensi 0,071% [r3]
- Estimasi kerugian box karantina Rp 4,79 miliar [r4]"""


class PlainCheck(unittest.TestCase):
    def ok(self, text):
        self.assertEqual(O.plain_check(text, BRIEFING), "", text)

    def bad(self, text):
        self.assertTrue(O.plain_check(text, BRIEFING), text)

    def test_numbers_the_briefing_gives(self):
        self.ok("Dari 5.296.605 klaim rumah sakit, hanya 315 yang dikoreksi verifikator.")
        self.ok("Box karantina menanggung sekitar Rp 4,8 miliar estimasi kerugian.")  # rounded within 5%

    def test_a_share_as_x_in_every_n(self):
        self.ok("Hanya sekitar 6 dari setiap 100.000 klaim rumah sakit yang dikoreksi.")
        self.ok("Di semua klaim, sekitar 7 dari setiap 10.000 klaim dikoreksi.")
        self.ok("Dari setiap 100 klaim yang ditandai model, sekitar 3 memang dikoreksi verifikator.")
        self.ok("Hanya sekitar 6 klaim dari setiap 100.000 klaim rumah sakit yang dikoreksi.")  # a word between (a live run, 2026-10-24)
        self.ok("Dari setiap 100.000 klaim rumah sakit, hanya sekitar 6 yang dikoreksi.")
        self.bad("Hanya sekitar 6 dari setiap 10.000 klaim rumah sakit yang dikoreksi.")  # ten times too many
        self.bad("Hanya sekitar 6 klaim dari setiap 10.000 rumah sakit yang dikoreksi.")

    def test_times_as_given_or_as_a_ratio_of_two(self):
        self.ok("Model sekitar 550 kali lebih jitu daripada memilih acak.")
        self.ok("Klaim rumah sakit sekitar 12 kali lebih jarang dikoreksi.")  # 0,071% / 0,006%
        self.bad("Model 40 kali lebih jitu daripada memilih acak.")

    def test_thousands_read_as_decimals(self):
        source = BRIEFING + "\n- Model rumah sakit 1.447× di atas acak [r1]"
        self.assertEqual(O.plain_check("Model rumah sakit sekitar 1.447 kali lebih baik daripada acak.", source), "")
        self.assertIn("salah baca", O.plain_check("Model rumah sakit 1,447× lebih baik daripada acak.", source))  # a live run, 2026-10-24
        self.assertTrue(O.plain_check("Model menghasilkan 1,45 kali lebih banyak kasus yang tepat.", source))

    def test_a_number_from_nowhere(self):
        self.bad("Ada 3 faskes yang perlu diaudit segera.")
        self.bad("Data tahun 2024 menunjukkan pola serupa.")
        self.ok("1. Konfirmasi tag indikasi terkuat sebelum audit lapangan.")  # list numbering is not a number


class ExhibitFacts(unittest.TestCase):
    """The long report's exhibit commentary against its exhibit's facts (laporan_konsultan.gate_commentary): the ten
    sentences a live run lost though the facts say every number (run-987bda135e66, 2026-10-28) — a rate "per 1.000",
    the facts' own "x dari n", a zero, an INA-CBG code, a month — kept; a number the facts do not say still dropped."""

    FACTS = {
        "wilayah": "Kalimantan Barat, Jawa Barat, Sumatera Utara menanggung 36% estimasi kerugian\n"
                   "Kalimantan Barat: Rp 667,6 juta (13,3%), 3,30 klaim berisiko per 1.000 klaim FKRTL.\n"
                   "DKI Jakarta: Rp 352,7 juta (7,0%), 0,97 klaim berisiko per 1.000 klaim FKRTL.",
        "kelas": "RS kelas A (termasuk swasta setara A dan TNI/Polri I) mencatat 3,10 klaim berisiko per 1.000 klaim, 6,1× kelas terendah\n"
                 "RS kelas A (termasuk swasta setara A dan TNI/Polri I): 3,10 per 1.000 (1.185 klaim berisiko dari 381.817 klaim FKRTL).\n"
                 "RS khusus (jiwa, ibu dan anak, mata, jantung, kanker, paru, bedah …): 2,28 per 1.000 (691 klaim berisiko dari 302.985 klaim FKRTL).\n"
                 "RS kelas D dan swasta setara D: 0,67 per 1.000 (284 klaim berisiko dari 423.848 klaim FKRTL).",
        "kode": "Kode Q-5-44-0 paling sering muncul (459 klaim berisiko); koreksi tertinggi pada A-4-14-I (6,7% tagihan)\n"
                "Q-5-44-0: 459 klaim berisiko, koreksi 2,7% tagihan; diagnosis tersering Follow-up examination after other treatment for other conditions (178 klaim).\n"
                "A-4-14-I: 352 klaim berisiko, koreksi 6,7% tagihan; diagnosis tersering Typhoid fever (212 klaim).",
        "tren": "Klaim berisiko memuncak pada 2024-05 (710 klaim)\n62 bulan, 2015-01 sampai 2025-05; puncak 2024-05 dengan 710 klaim.",
        "keandalan": "QA mempertahankan 15 dari 20 klaim sintesis; red team melemahkan 10 dari 12 indikasi terkuat\n"
                     "QA Agen Klaim & Indikasi Fraud: 4 dari 4.\nQA Agen Peserta & Rujukan: 4 dari 4.\nQA Agen Klinis: 2 dari 4.\n"
                     "QA Agen Faskes & Wilayah: 3 dari 6.\nRed team: indikasi bertahan: 2 dari 12.",
        "audit_terancang": "Audit terancang menunggu hasil auditor: 30 faskes teratas Box dan 30 faskes acak dari 2.482 faskes lain\n"
                           "Hasil tercatat: 0 dari 30 faskes teratas dan 0 dari 30 faskes acak.",
        "rekomendasi": "Penyidik merekomendasikan 24 faskes dibina dan 1 ditindak; 1 memenuhi ketiga unsur TSM\n"
                       "25 faskes diaudit penyidik: 24 dibina, 1 ditindak, 0 dibebaskan; 1 dengan TSM terpenuhi penuh.",
    }

    def ok(self, exhibit, text):
        self.assertEqual(O.plain_check(text, self.FACTS[exhibit]), "", text)

    def bad(self, exhibit, text):
        self.assertTrue(O.plain_check(text, self.FACTS[exhibit]), text)

    def test_the_lost_sentences_are_kept(self):
        self.ok("wilayah", "Tingkat klaim berisiko per 1.000 klaim FKRTL juga bervariasi, di mana Kalimantan Barat mencatat 3,30 klaim berisiko per "
                "1.000 klaim FKRTL, jauh di atas DKI Jakarta yang hanya 0,97 klaim berisiko per 1.000 klaim FKRTL meskipun nilai kerugian DKI "
                "Jakarta mencapai Rp 352,7 juta (7,0%).")
        self.ok("kelas", "Tingkat klaim berisiko sangat dipengaruhi oleh kelas rumah sakit, di mana RS kelas A mencatat 3,10 klaim berisiko per "
                "1.000 dari 381.817 klaim FKRTL, atau 6,1 kali lipat dibandingkan kelas terendah.")
        self.ok("kelas", "Sebagai pembanding, RS khusus mencatat 2,28 per 1.000 dari 302.985 klaim FKRTL, sementara RS kelas D dan swasta setara D "
                "hanya 0,67 per 1.000 dari 423.848 klaim FKRTL.")
        self.ok("kode", "Kode INA-CBG Q-5-44-0 paling sering muncul dengan 459 klaim berisiko, didominasi oleh diagnosis Follow-up examination "
                "after other treatment for other conditions dengan 178 klaim, namun rasio koreksinya hanya 2,7% tagihan.")
        self.ok("kode", "Lakukan tinjauan klinis mendalam pada kode A-4-14-I dan Q-5-44-0 untuk memastikan validitas tagihan dan koreksi yang tepat.")
        self.ok("tren", "Selama periode 62 bulan dari 2015-01 sampai 2025-05, klaim berisiko memuncak pada 2024-05 dengan 710 klaim.")
        self.ok("keandalan", "Sistem deteksi menunjukkan keandalan yang baik pada agen klaim dan peserta dengan QA Agen Klaim & Indikasi Fraud serta "
                "QA Agen Peserta & Rujukan masing-masing lolos 4 dari 4, namun melemah pada aspek klinis dan faskes di mana QA Agen Klinis hanya "
                "lolos 2 dari 4 dan QA Agen Faskes & Wilayah lolos 3 dari 6.")
        self.ok("keandalan", "Uji red team yang melemahkan 10 dari 12 indikasi terkuat menyisakan hanya 2 dari 12 indikasi yang bertahan menunjukkan "
                "bahwa banyak temuan yang masih rentan terhadap bantahan.")
        self.ok("audit_terancang", "Namun, hasil tercatat menunjukkan 0 dari 30 faskes teratas dan 0 dari 30 faskes acak, yang berarti belum ada "
                "temuan terbukti pada rancangan ini.")
        self.ok("rekomendasi", "Dari 25 faskes yang diaudit penyidik, 24 faskes direkomendasikan untuk dibina dan 1 faskes ditindak, dengan 0 faskes dibebaskan.")
        self.ok("tren", "Data sejak 2015 menunjukkan puncak pada 2024-05.")  # a year the facts name

    def test_a_number_the_facts_do_not_say_is_still_dropped(self):
        self.bad("wilayah", "Kalimantan Barat mencatat 4,30 klaim berisiko per 1.000 klaim FKRTL.")
        self.bad("kode", "Kode Q-5-44-0 muncul pada 520 klaim berisiko.")
        self.bad("tren", "Klaim berisiko memuncak pada 2023-05 dengan 710 klaim.")  # a month the facts do not name: 2023 is not 2024 rounded
        self.bad("keandalan", "Uji red team menyisakan 7 dari 12 indikasi yang bertahan.")
        self.bad("audit_terancang", "Hasil tercatat menunjukkan 3 dari 30 faskes teratas terbukti.")
        self.bad("rekomendasi", "Dari 25 faskes yang diaudit penyidik, 2 faskes dibebaskan.")


class BriefingRepair(unittest.TestCase):
    """The writer's briefing with one key written without its colon (GLM, 2026-10-24): the whole briefing, not a fragment."""

    def test_a_missing_colon_is_repaired(self):
        from aip.adk_runtime import agents as A

        raw = ('{"judul": "AUPRC rumah sakit 0,086", "ringkasan": "Jarang, bukan lemah.", "angka_kunci": [{"label": "prevalensi", "nilai": "0,006%", '
               '"satuan "persen", "konteks": "315 dari 5,3 juta", "rujukan": "r1"}], "temuan": [{"judul": "Akurasi tidak bermakna", "isi": "0,9998"}]}')
        b = A.briefing_of(raw)
        self.assertEqual((b["judul"], b["angka_kunci"][0]["satuan"]), ("AUPRC rumah sakit 0,086", "persen"))
        self.assertIsNone(A.briefing_of('{"judul": "Akurasi tidak bermakna", "isi": "0,9998"}'))  # a finding alone is no briefing


if __name__ == "__main__":
    unittest.main()
