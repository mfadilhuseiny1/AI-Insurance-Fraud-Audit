"""Tests for Evaluasi Swarm (api/aip/evaluasi_swarm.py): an AI Agent Swarm engagement scored from its own trail.
Real files in a temporary data directory, no model calls and no server; the last test reads the platform's real trail
of the 24 October report rewrite, when this computer has it, and checks the numbers docs/healthkathon/UJI_KESIAPAN_SWARM.md
measured. Run: python -m pytest test_evaluasi_swarm.py -q (from api/)."""
import json
import tempfile
from pathlib import Path

import pytest

from aip import evaluasi_swarm as E
from aip import laporan_konsultan as L
from aip import vertex as aip_vertex

REAL_DATA = Path(__file__).resolve().parent.parent / "data"


@pytest.fixture
def data():
    before = aip_vertex.DIR
    d = Path(tempfile.mkdtemp(prefix="aip-evalswarm-test-"))
    aip_vertex.configure(d, lambda k: "")
    E._cache.clear()
    yield d
    aip_vertex.DIR = before
    E._cache.clear()


def _jsonl(p: Path, rows: list[dict]) -> None:
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), "utf-8")


def _verdict(validator: str, passed: int, total: int, **extra) -> dict:
    checks = [{"klaim": f"cek {i}", "ok": i < passed, "bukti": f"r{i}"} for i in range(total)]
    return {"type": "verdict", "validator": validator, "passed": passed, "total": total, "checks": checks, **extra}


def _engagement(data: Path, run_id: str, *, status: str = "succeeded", qa=(3, 4), final=(2, 2), frozen: bool = True,
                rek: list[dict] | None = None, extra_events: list[dict] | None = None, tracebacks: int = 0) -> dict:
    d = data / "aip" / "runs" / run_id
    d.mkdir(parents=True)
    rec = {"id": run_id, "kind": "konsultan", "status": status, "user_id": "u-1", "username": "uji",
           "created_at": "2026-10-28T09:00:00+00:00", "finished_at": "2026-10-28T10:30:00+00:00" if status != "running" else None,
           "spent_usd": 1.5, "nama": "Uji (test) · penugasan 1", "proyek": None}
    (d / "run.json").write_text(json.dumps(rec), "utf-8")
    tim = [{"key": "partner", "name": "Orkestrator", "lini": "pimpinan"}, {"key": "klaim_fraud", "name": "Agen Klaim & Indikasi", "lini": "kasus"},
           {"key": "prov_11", "name": "Analis Aceh", "lini": "wilayah"}]
    parts = sorted({p for _, _, ps in L.CHAPTERS for p in ps})
    ev = [
        {"t": "2026-10-28T09:00:05", "type": "firm", "tim": tim},
        {"t": "2026-10-28T09:00:05", "type": "phase", "phase": "lapangan", "label": "Kerja lapangan", "status": "mulai"},
        {"t": "2026-10-28T09:20:00", "type": "phase", "phase": "lapangan", "label": "Kerja lapangan", "status": "mulai"},  # resumed
        {"t": "2026-10-28T09:40:05", "type": "phase", "phase": "lapangan", "label": "Kerja lapangan", "status": "selesai", "tag": 3},
        {"t": "2026-10-28T09:40:05", "type": "phase", "phase": "investigasi", "label": "Investigasi", "status": "mulai"},
        {"t": "2026-10-28T09:50:05", "type": "phase", "phase": "investigasi", "label": "Investigasi", "status": "selesai", "kasus": 2},
        {"t": "2026-10-28T09:20:00", "type": "lanjut", "fase": "lapangan"},
        {"type": "instances", "role": "penyidik_kasus", "agents": [{"key": "penyidik_01", "lini": "kasus"}, {"key": "penyidik_02", "lini": "kasus"}]},
        # tags: the last word on an id wins; a bulk count is not a tag of its own
        {"type": "tag", "id": "ind-a", "kekuatan": "lemah", "keluarga_model": ["openai"]},
        {"type": "tag", "id": "ind-a", "kekuatan": "kuat", "keluarga_model": ["openai", "zai"]},
        {"type": "tag", "id": "ind-b", "kekuatan": "sedang", "keluarga_model": ["deepseek"], "baru": True},
        {"type": "tag", "bulk": True, "jumlah": 40},
        {"type": "red_team", "hasil": "bertahan"}, {"type": "red_team", "hasil": "melemah"},
        {"type": "handoff", "handoff": {"procedures_followed": {"ok": True}, "dinyatakan_agen": True, "issues_found": ["x", "y"]}},
        {"type": "handoff", "handoff": {"procedures_followed": {"ok": False}, "issues_found": []}},
        {"type": "tool", "tool": "ukur", "ok": True}, {"type": "tool", "tool": "ukur", "ok": False, "summary": "dimensi tidak ada"},
        {"type": "error", "agent": "prov_11", "message": "laporan tanpa tool ditolak: giliran diulang"},
        {"type": "pelajaran", "skill": "analis_wilayah", "teks": "periksa dimensi dulu"},
        _verdict("scrutiny", 2, 2, milestone="lapangan"),
        _verdict("qa_klaim_fraud", qa[0], qa[1], lini="klaim_fraud", sintesis="Agen Klaim & Indikasi"),
        _verdict("validator", final[0], final[1], kontrak=[{"id": "d1", "teks": "setiap faskes A punya rekomendasi", "ok": True, "bukti": "r9"},
                                                           {"id": "d2", "teks": "ditindak hanya bila T+S+M", "ok": False, "bukti": "r10"},
                                                           {"id": "k1", "teks": "tidak dinilai", "ok": None}]),
        *[{"type": "bagian", "id": p, "judul": p, "status": "selesai", "teks": f"teks {p}"} for p in parts],
        *(rek if rek is not None else [{"type": "rekomendasi", "faskes": "f1", "nama": "RS A", "jalur": "ditindak",
                                        "tsm": {"terstruktur": "terpenuhi", "sistematis": "terpenuhi", "masif": "terpenuhi"}},
                                       {"type": "rekomendasi", "faskes": "f2", "nama": "RS B", "jalur": "dibina", "tsm": {}}]),
        *(extra_events or []),
    ]
    _jsonl(d / "events.jsonl", ev)
    _jsonl(d / "usage.jsonl", [{"agent": "partner", "model": "vertex/zai-org/glm-5.2-maas", "prompt": 100, "output": 10, "usd": 0.5},
                               {"agent": "penyidik_01", "model": "vertex/zai-org/glm-5.2-maas", "prompt": 50, "output": 5, "usd": 0.25},
                               {"agent": "orkestrator", "model": "vertex/openai/gpt-oss-120b-maas", "prompt": 10, "output": 1, "usd": 0.01}])
    (d / "runtime.log").write_text("ok\n" + "Traceback (most recent call last):\n  boom\n" * tracebacks, "utf-8")
    if frozen:
        exhibits = [{"id": f"x{i}", "bab": cid} for i, (cid, _, _) in enumerate(c for c in L.CHAPTERS if c[0] != "kasus")]
        exhibits += [{"id": f"y{i}", "bab": "skala"} for i in range(13 - len(exhibits))]
        L._frozen_path(run_id).write_text(json.dumps({"run": run_id, "pada": "2026-10-28T10:31:00+00:00", "exhibit": exhibits,
                                                      "berkas": [{"faskes": f"f{i}"} for i in range(25)]}), "utf-8")
        L._path(run_id).write_text(json.dumps({"run": run_id, "narasi": {"x0": {"makna": "a"}}, "dibuang": ["kalimat"]}), "utf-8")
    return rec


def _crit(e: dict) -> dict:
    return {k["id"]: k["lulus"] for k in e["kriteria"]}


def test_a_full_engagement_that_meets_every_criterion(data):
    e = E.evaluate(_engagement(data, "run-aaaaaaaaaaa1"))
    assert all(v is True for v in _crit(e).values()), e["kriteria"]
    assert (e["lulus"], e["terukur"]) == (9, 9)
    assert e["skor"]["qa"] == [3, 4] and e["skor"]["validator"] == [2, 2]
    assert e["skor"]["kontrak"] == [1, 2, 3]  # met, judged, items
    assert e["laporan"]["bab_berisi"] == e["laporan"]["bab_total"] == len(L.CHAPTERS)
    assert e["laporan"]["bab_firma"] == e["laporan"]["bab_firma_maks"]
    assert next(k for k in e["kriteria"] if k["id"] == "status")["nilai"] == "berhasil"


def test_results_and_orchestration_are_read_from_the_trail(data):
    e = E.evaluate(_engagement(data, "run-aaaaaaaaaaa2", tracebacks=2))
    h, o = e["hasil"], e["orkestrasi"]
    assert h["tag_tersimpan"] == 3 and h["tag_agen"] == 2  # the phase's count; agent tags by id, the bulk count left out
    assert h["kekuatan"] == {"kuat": 1, "sedang": 1} and h["lintas_keluarga"] == 1 and h["tag_baru"] == 1
    assert h["kasus"] == 2 and h["jalur"] == {"ditindak": 1, "dibina": 1} and h["ditindak_tanpa_tsm"] == []
    assert h["red_team"] == {"bertahan": 1, "melemah": 1}
    lap = next(f for f in o["fase"] if f["fase"] == "lapangan")
    assert lap["kali"] == 2 and lap["detik"] == 40 * 60 and lap["hasil"] == {"tag": 3}
    assert (o["agen"], o["instans"]) == (3, 2)
    assert (o["serah_terima"], o["prosedur_diikuti"], o["diisi_agen"], o["masalah_dilaporkan"]) == (2, 1, 1, 2)
    assert (o["tool"], o["tool_gagal"]) == (2, 1) and o["tool_gagal_teratas"][0] == {"tool": "ukur", "gagal": 1, "contoh": "dimensi tidak ada"}
    assert (o["galat_total"], o["giliran_diulang"], o["dilanjutkan"], o["traceback"]) == (1, 1, 1, 2)
    assert o["pelajaran"] == [{"skill": "analis_wilayah", "teks": "periksa dimensi dulu"}]
    assert e["qa"][0]["nama"] == "Agen Klaim & Indikasi"
    models = {m["model"]: m for m in e["biaya"]["model"]}
    assert models["vertex/zai-org/glm-5.2-maas"]["panggilan"] == 2 and models["vertex/zai-org/glm-5.2-maas"]["usd"] == 0.75
    assert {x["lini"]: x["usd"] for x in e["biaya"]["lini"]} == {"Pimpinan": 0.51, "Penyidik kasus": 0.25}  # the orchestrator books as the lead


def test_weak_qa_a_failed_validator_and_ditindak_without_tsm_fail_their_criteria(data):
    rek = [{"type": "rekomendasi", "faskes": "f1", "nama": "RS A", "jalur": "dibina", "tsm": {}},
           {"type": "rekomendasi", "faskes": "f1", "nama": "RS A", "jalur": "ditindak",  # the investigator's last word counts
            "tsm": {"terstruktur": "sebagian", "sistematis": "terpenuhi", "masif": "terpenuhi"}}]
    e = E.evaluate(_engagement(data, "run-aaaaaaaaaaa3", qa=(2, 4), final=(1, 2), rek=rek))
    c = _crit(e)
    assert c["qa"] is False and c["validator"] is False
    assert e["hasil"]["ditindak_tanpa_tsm"] == ["RS A"] and e["hasil"]["rekomendasi"] == 1
    assert e["lulus"] == 7 and e["terukur"] == 9


def test_a_report_never_frozen_is_unmeasured_not_passed(data):
    e = E.evaluate(_engagement(data, "run-aaaaaaaaaaa4", frozen=False))
    c = _crit(e)
    assert c["exhibit"] is None and c["berkas"] is None and c["bab"] is None
    assert c["beku"] is False and c["narasi"] is False
    assert e["laporan"]["exhibit"] is None and e["terukur"] == 6


def test_a_running_engagement_is_not_judged_yet(data):
    e = E.evaluate(_engagement(data, "run-aaaaaaaaaaa5", status="running"))
    assert all(k["lulus"] is None for k in e["kriteria"]) and e["terukur"] == 0


def test_the_cache_follows_the_trail(data):
    rec = _engagement(data, "run-aaaaaaaaaaa6")
    first = E._cached(rec)
    assert E._cached(rec) is first
    p = data / "aip" / "runs" / rec["id"] / "events.jsonl"
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"type": "red_team", "hasil": "gugur"}) + "\n")
    again = E._cached(rec)
    assert again is not first and again["hasil"]["red_team"]["gugur"] == 1


def test_the_real_24_october_rewrite_scores_as_the_readiness_test_measured():
    run_id = "run-4383c7191db1"
    if not (REAL_DATA / "aip" / "runs" / run_id / "events.jsonl").exists():
        pytest.skip("this computer has no trail of the 24 October rewrite")
    before = aip_vertex.DIR
    aip_vertex.DIR = REAL_DATA / "aip" / "vertex_spend"  # read only: evaluate() writes nothing
    try:
        rec = json.loads((REAL_DATA / "aip" / "runs" / run_id / "run.json").read_text("utf-8"))
        e = E.evaluate(rec)
    finally:
        aip_vertex.DIR = before
    # docs/healthkathon/UJI_KESIAPAN_SWARM.md §1, column "Tulis ulang laporannya (run-4383c7191db1, beku)"
    assert e["skor"]["validator"] == [5, 5] and e["skor"]["qa"] == [15, 20]
    assert (e["laporan"]["exhibit"], e["laporan"]["berkas"], e["laporan"]["beku"]) == (13, 25, True)
    assert e["laporan"]["bab_berisi"] == 9 and e["laporan"]["bab_firma"] == 8
    assert e["orkestrasi"]["traceback"] == 0 and e["tulis_ulang_dari"] == "run-328344d8c6e4"
    assert (e["lulus"], e["terukur"]) == (9, 9)
