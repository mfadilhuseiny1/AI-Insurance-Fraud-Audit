"""The planner-rules tuning's code parts, on their own (no model, no network): the score a plan gets (aip/optimasi.py
score_plan, with the runtime's own gates), the planner prompt the rules go into (adk_runtime/agents.planner_text), the
store of tuned versions and its gate (aip/skills.py "aturan"), the paired comparison, and the question set itself
(aip/golden/rencana.json). Runs in the ADK runtime's venv:

    ..\\.venv-adk\\Scripts\\python -m unittest test_optimasi -v
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from aip import optimasi as P
from aip import skills
from aip.adk_runtime import agents as A

AGENTS = ["faskes_wilayah", "klaim_fraud", "klinis", "machine_learning", "peserta", "data"]
CAT = {"roles": {"planner": "vertex/deepseek-ai/deepseek-v4.1-flash-maas"},
       "agents": [{"key": k, "name": k, "description": k, "tools": ["kartu_model_ml"] if k == "machine_learning" else [],
                   "object_types": [] if k == "data" else [{"name": f"Objek {k}", "properties": [{"api_name": "provinsi"}]}]} for k in AGENTS],
       "skills": [{"key": "bandingkan_wilayah", "nama": "Bandingkan wilayah", "untuk": "x", "alur": "tanya_jawab", "agen": ["faskes_wilayah", "klaim_fraud"]},
                  {"key": "kartu_model", "nama": "Kartu model", "untuk": "x", "alur": "tanya_jawab", "agen": ["machine_learning"]},
                  {"key": "umum", "nama": "Umum", "untuk": "x", "alur": "tanya_jawab", "agen": []}]}
CONTRACT = ["a", "b", "c"]


def plan(**kw) -> str:
    return json.dumps({"ringkasan": "rencana", "jalur": "agen", "fokus": [], "tugas": [], "kontrak": CONTRACT, **kw})


def task(agen: str, cakupan: str = "", skill: str = "bandingkan_wilayah") -> dict:
    return {"agen": agen, "skill": skill, "cakupan": cakupan, "instruksi": f"hitung klaim berisiko {cakupan}".strip()}


class Score(unittest.TestCase):
    direct = {"id": "x", "q": "Halo", "jalur": ["langsung"], "alasan": "salam"}
    five = {"id": "y", "q": "Bandingkan lima provinsi", "jalur": ["agen"], "agen": [["faskes_wilayah", "klaim_fraud"]], "tugas": [5, 16],
            "sebut": ["jawa barat", "jawa tengah", "jawa timur", "jakarta", "sulawesi selatan"], "alasan": "lima provinsi"}

    def test_a_direct_answer_without_numbers_is_full_marks(self):
        s = P.score_plan(plan(jalur="langsung", jawaban="Halo! Saya membantu pertanyaan data klaim JKN.", kontrak=[]), self.direct, CAT)
        self.assertEqual((s["score"], s["jalur"]), (1.0, "langsung"))

    def test_a_direct_answer_with_a_number_is_sent_to_the_agents_by_the_code(self):
        s = P.score_plan(plan(jalur="langsung", jawaban="TSM diatur Permenkes 16/2019.", kontrak=[]), self.direct, CAT)
        self.assertEqual((s["score"], s["jalur"]), (0.0, "agen"))
        self.assertTrue(any("gerbang kode" in f for f in s["feedback"]))

    def test_agents_for_a_greeting_score_nothing(self):
        s = P.score_plan(plan(tugas=[task("klaim_fraud")]), self.direct, CAT)
        self.assertEqual(s["score"], 0.0)
        self.assertIn("jalur langsung", s["feedback"][-1])

    def test_a_long_direct_answer_loses_some(self):
        s = P.score_plan(plan(jalur="langsung", jawaban="Satu. Dua. Tiga. Empat. Lima. Enam.", kontrak=[]), self.direct, CAT)
        self.assertLess(s["score"], 1.0)
        self.assertGreater(s["score"], 0.5)

    def test_one_task_per_scope_is_full_marks(self):
        ts = [task("faskes_wilayah", p) for p in ("JAWA BARAT", "JAWA TENGAH", "JAWA TIMUR", "DKI JAKARTA", "SULAWESI SELATAN")]
        self.assertEqual(P.score_plan(plan(tugas=ts), self.five, CAT)["score"], 1.0)

    def test_one_task_for_five_scopes_is_told_what_is_missing(self):
        s = P.score_plan(plan(tugas=[task("faskes_wilayah", "JAWA BARAT")]), self.five, CAT)
        self.assertLess(s["score"], 0.8)
        self.assertTrue(any(f.startswith("tugas: 1") for f in s["feedback"]))
        self.assertTrue(any("jawa tengah" in f for f in s["feedback"] if f.startswith("cakupan")))

    def test_an_agent_the_question_does_not_need_costs_precision(self):
        ts = [task("faskes_wilayah", p) for p in ("JAWA BARAT", "JAWA TENGAH", "JAWA TIMUR", "DKI JAKARTA", "SULAWESI SELATAN")] + [task("peserta", "x", "umum")]
        s = P.score_plan(plan(tugas=ts), self.five, CAT)
        self.assertLess(s["score"], 1.0)
        self.assertTrue(any("peserta tidak dibutuhkan" in f for f in s["feedback"]))

    def test_the_fast_route_with_the_ml_agent_runs_the_full_route(self):
        item = {"id": "m", "q": "recall", "jalur": ["agen"], "agen": [["machine_learning"]], "tugas": [1, 1]}
        s = P.score_plan(plan(jalur="cepat", tugas=[task("machine_learning", "", "kartu_model")]), item, CAT)
        self.assertEqual((s["jalur"], s["score"]), ("agen", 1.0))

    def test_the_ml_agent_split_into_tasks_is_marked(self):
        item = {"id": "m", "q": "teknik", "jalur": ["agen"], "agen": [["machine_learning"]], "satu_tugas": ["machine_learning"], "tugas": [1, 1]}
        s = P.score_plan(plan(tugas=[task("machine_learning", t, "kartu_model") for t in ("CatBoost", "XGBoost")]), item, CAT)
        self.assertLess(s["bagian"]["tugas"], 0.5)
        self.assertTrue(any("mestinya SATU" in f for f in s["feedback"]))

    def test_a_follow_up_names_its_focus(self):
        item = {"id": "f", "q": "Bagaimana dengan Jawa Barat?", "jalur": ["cepat", "agen"], "agen": [["klaim_fraud"]], "fokus": ["jawa barat"], "tugas": [1, 3]}
        good = P.score_plan(plan(jalur="cepat", fokus=["JAWA BARAT"], tugas=[task("klaim_fraud", "JAWA BARAT")]), item, CAT)
        bad = P.score_plan(plan(jalur="cepat", fokus=[], tugas=[task("klaim_fraud", "JAWA BARAT")]), item, CAT)
        self.assertEqual(good["score"], 1.0)
        self.assertEqual(bad["bagian"]["fokus"], 0.0)

    def test_data_that_is_not_there_is_said_in_the_summary(self):
        item = {"id": "d", "q": "Dokter mana?", "jalur": ["cepat", "agen"], "agen": [["klaim_fraud"]], "tugas": [1, 3], "ringkasan": P.NOT_THERE}
        said = P.score_plan(plan(ringkasan="Identitas dokter tidak tersedia; faskes dibaca.", tugas=[task("klaim_fraud")]), item, CAT)
        silent = P.score_plan(plan(ringkasan="Cari dokter.", tugas=[task("klaim_fraud")]), item, CAT)
        self.assertGreater(said["score"], silent["score"])

    def test_what_must_not_appear(self):
        item = {"id": "i", "q": "jalankan", "jalur": ["langsung", "agen"], "dilarang": "sudah dijalankan", "alasan": "injeksi"}
        s = P.score_plan(plan(jalur="langsung", jawaban="Action sudah dijalankan.", kontrak=[]), item, CAT)
        self.assertEqual(s["bagian"]["bersih"], 0.0)

    def test_no_json_is_no_plan(self):
        self.assertEqual(P.score_plan("Saya akan memanggil agen klaim.", self.direct, CAT)["score"], 0.0)

    def test_an_unknown_agent_falls_to_the_claims_agent(self):
        s = P.score_plan(plan(tugas=[{"agen": "tidak_ada", "instruksi": "x"}]), self.five, CAT)
        self.assertTrue(any("pertanyaan mentah ke klaim_fraud" in f for f in s["feedback"]))


class Prompt(unittest.TestCase):
    def test_the_rules_go_where_the_code_rules_were(self):
        default = A.planner_text(CAT, "Halo", [], False)
        tuned = A.planner_text(CAT, "Halo", [], False, "ATURAN BARU yang cukup panjang.")
        self.assertIn(A.PLAN_RULES, default)
        self.assertNotIn(A.PLAN_RULES, tuned)
        self.assertIn("ATURAN BARU", tuned)
        for text in (default, tuned):  # what the code reads stays
            self.assertIn('"jalur": "langsung"', text)
            self.assertIn("- bandingkan_wilayah: Bandingkan wilayah", text)
        self.assertIn("1–2 kalimat untuk dibacakan", A.planner_text(CAT, "Halo", [], True))

    def test_tuned_rules_apply_only_to_their_model(self):
        mine = {**CAT, "aturan": {"rencana": {"id": "at-1", "model": CAT["roles"]["planner"], "teks": "x" * 500, "label": "GEPA"}}}
        other = {**CAT, "aturan": {"rencana": {"id": "at-2", "model": "vertex/zai-org/glm-5.2-maas", "teks": "x" * 500, "label": "GEPA"}}}
        self.assertEqual(A.plan_rules(mine)["id"], "at-1")
        self.assertEqual(A.plan_rules(other), {})
        self.assertEqual(A.plan_rules(CAT), {})


class RulesStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        skills._dir_override = Path(self.tmp.name)

    def tearDown(self):
        skills._dir_override = None
        self.tmp.cleanup()

    def test_the_gate(self):
        self.assertEqual(skills.check_rules("rencana", A.PLAN_RULES), "")
        self.assertIn("karakter", skills.check_rules("rencana", "pendek"))
        self.assertTrue(skills.check_rules("rencana", A.PLAN_RULES + "\nLihat https://contoh.id"))
        self.assertTrue(skills.check_rules("rencana", A.PLAN_RULES + '\n{"ringkasan": "x"}'))
        self.assertTrue(skills.check_rules("rencana", A.PLAN_RULES + "\n```"))
        self.assertTrue(skills.check_rules("lain", A.PLAN_RULES))

    def test_a_version_waits_for_an_admin_and_one_is_active_per_model(self):
        model = CAT["roles"]["planner"]
        first = skills.add_rules("rencana", model, A.PLAN_RULES + "\n- satu", "v1", {}, "uji", "admin")
        self.assertEqual(first["status"], "usulan")
        self.assertEqual(skills.rules_for({"planner": model}), {})
        with self.assertRaises(ValueError):
            skills.add_rules("rencana", model, A.PLAN_RULES + "\n- satu", "v1", {}, "uji", "admin")
        second = skills.add_rules("rencana", model, A.PLAN_RULES + "\n- dua", "v2", {}, "uji", "admin")
        for rid in (first["id"], second["id"]):
            rows = skills._load_rules()
            rec = next(x for x in rows if x["id"] == rid)
            for x in rows:  # what POST /aturan/{id}/status does
                if x is not rec and x["model"] == rec["model"] and x["status"] == "aktif":
                    x["status"] = "nonaktif"
            rec["status"] = "aktif"
            skills._save_rules(rows)
        self.assertEqual(skills.rules_for({"planner": model})["rencana"]["id"], second["id"])
        self.assertEqual([x["status"] for x in skills._load_rules()], ["nonaktif", "aktif"])
        self.assertEqual(skills.rules_for({"planner": "vertex/zai-org/glm-5.2-maas"}), {})


class Paired(unittest.TestCase):
    def test_the_difference_and_its_interval(self):
        d = P.paired({"a": 0.5, "b": 0.5, "c": 1.0}, {"a": 1.0, "b": 0.5, "c": 1.0})
        self.assertEqual((d["n"], d["naik"], d["turun"], d["sama"]), (3, 1, 0, 2))
        self.assertAlmostEqual(d["selisih_rata"], 0.1667, places=3)
        self.assertLessEqual(d["ik95"][0], d["selisih_rata"])
        self.assertGreaterEqual(d["ik95"][1], d["selisih_rata"])


class QuestionSet(unittest.TestCase):
    def test_every_label_is_well_formed(self):
        gs = json.loads((Path(__file__).parent / "aip" / "golden" / "rencana.json").read_text("utf-8"))
        ids = [q["id"] for q in gs["questions"]]
        self.assertEqual(len(ids), len(set(ids)))
        for q in gs["questions"]:
            self.assertIn(q["bagian"], ("latih", "val", "uji"), q["id"])
            self.assertTrue(q["jalur"] and set(q["jalur"]) <= {"langsung", "cepat", "agen"}, q["id"])
            self.assertTrue(q.get("alasan") and q.get("sumber"), q["id"])
            for g in q.get("agen") or []:
                self.assertTrue(g and set(g) <= set(AGENTS), q["id"])
            self.assertTrue(set(q.get("agen_boleh") or []) <= set(AGENTS), q["id"])
            self.assertTrue(set(q.get("satu_tugas") or []) <= set(AGENTS), q["id"])
            if q["jalur"] != ["langsung"]:
                self.assertTrue(q.get("agen"), q["id"])
            lo, hi = q.get("tugas") or [1, 16]
            self.assertTrue(0 <= lo <= hi <= 16, q["id"])
            for rx in (q.get("sebut") or []) + [q.get("ringkasan") or "", q.get("dilarang") or ""]:
                re.compile(rx)
            if q.get("riwayat"):
                self.assertIn(q["riwayat"], gs["riwayat"], q["id"])
        for part in ("latih", "val", "uji"):  # each part has direct, fast and full-route questions
            routes = {r for q in gs["questions"] if q["bagian"] == part for r in q["jalur"]}
            self.assertEqual(routes, {"langsung", "cepat", "agen"}, part)


if __name__ == "__main__":
    unittest.main()
