"""Tests for the architecture-mode evaluation (api/aip/arch_eval.py): the golden set through the full
orchestrator, scored with the golden checks. Pure logic, real files, no model calls and no server.
Run: python -m pytest test_aip_arch_eval.py -q (from api/)."""
import json
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from aip import arch_eval as AE
from aip import vertex as aip_vertex


def _fresh_data() -> Path:
    d = Path(tempfile.mkdtemp(prefix="aip-arch-test-"))
    aip_vertex.configure(d, lambda k: "")
    return d


def test_extract_prefers_answer_over_draft():
    events = [{"type": "draft", "text": "draf awal", "seq": 1},
              {"type": "answer", "text": "jawaban akhir", "seq": 2},
              {"type": "draft", "text": "draf belakangan", "seq": 3}]
    answer, _ = AE.extract_answer_tools(events)
    assert answer == "jawaban akhir"


def test_extract_falls_back_to_last_draft_and_collects_tools_in_order():
    events = [{"type": "tool", "tool": "cari_objek", "ok": True, "seq": 1},
              {"type": "tool", "tool": "rusak", "ok": False, "seq": 2},
              {"type": "tool", "tool": "cari_objek", "ok": True, "seq": 3},
              {"type": "tool", "tool": "agregasi_objek", "ok": True, "seq": 4},
              {"type": "draft", "text": "d1", "seq": 5},
              {"type": "draft", "text": "d2", "seq": 6}]
    answer, tools = AE.extract_answer_tools(events)
    assert answer == "d2"
    assert tools == ["cari_objek", "agregasi_objek"]  # failed calls never count, no duplicates


def test_score_row_uses_the_golden_checks():
    q = {"id": "x", "q": "q", "must_call": ["cari_objek"], "must_say_any": ["majalengka"],
         "truth": [{"pick": "a.b", "value": 5}]}
    ok = AE.score_row(q, "ada 5 klaim di Majalengka", ["cari_objek"], [{"pick": "a.b", "value": 5}])
    assert all(c["ok"] for c in ok)
    bad = AE.score_row(q, "tidak tahu", ["lain"], [{"pick": "a.b", "value": 5}])
    assert not all(c["ok"] for c in bad)


def test_score_row_marks_contractless_questions_unscorable_not_passing():
    checks = AE.score_row({"id": "x", "q": "halo"}, "halo juga", [], [])
    assert len(checks) == 1 and checks[0].get("unscorable") and not checks[0]["ok"]


def test_score_row_checks_sebut_regexes():
    q = {"id": "x", "q": "q", "sebut": ["(kelas|tipe)\\s*a\\b"]}
    assert all(c["ok"] for c in AE.score_row(q, "RS kelas A menonjol", [], []))
    assert not all(c["ok"] for c in AE.score_row(q, "tidak ada info", [], []))


def test_dry_list_reads_the_committed_set():
    dry = AE.dry_list("jkn_audit")
    assert dry["set"] == "jkn_audit" and len(dry["questions"]) == 12
    assert all(q["id"] and q["q"] for q in dry["questions"])


def test_arch_history_lists_saved_runs_newest_first():
    _fresh_data()
    root = aip_vertex.DIR.parent / "arch-eval" / "runs"
    root.mkdir(parents=True)
    specs = (("20261020-000000-orkestrator.json", 9), ("20261022-000000-orkestrator.json", 11))
    for name, passed in specs:
        doc = {"summary": {"mode": "orkestrator", "set": "jkn_audit", "questions": 12, "answered": 12,
                           "passed": passed, "usd": 1.0, "time": "t"}, "rows": []}
        (root / name).write_text(json.dumps(doc), "utf-8")
    runs = AE.list_arch_runs()
    assert [r["passed"] for r in runs] == [11, 9]
    assert AE.latest_arch()["summary"]["passed"] == 11


def test_unknown_job_is_404_not_500():
    with pytest.raises(HTTPException) as e:
        AE.job_status("arch-tidakada12")
    assert e.value.status_code == 404
