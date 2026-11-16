"""Tests for the deterministic layer of the AIP agents: mission budgets and approvers, the run budget gate, runs and
missions left without their process, the gates found in the security review (the model gateway, the runtime's API
address, ids as paths, the agents' function and action tools), the tool filters. Plain code, real files and real
processes, no model calls. Run: python -m pytest test_aip_missions.py -q (from api/)."""
import json
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException

from aip import missions, runs
from aip import vertex as aip_vertex

RUN = "run-0123456789ab"


def _rid(n: int) -> str:
    return f"run-{n:012x}"


def _fresh_data() -> None:
    aip_vertex.configure(Path(tempfile.mkdtemp(prefix="aip-runs-test-")), lambda k: "")


def test_estimate_is_computed_not_guessed():
    tasks = [{"id": f"t{i}"} for i in range(6)]
    assert missions.estimate(tasks, 3) == pytest.approx(missions.EST_PLAN_USD + 6 * missions.EST_TASK_USD + 3 * missions.EST_VALIDATION_USD)


@pytest.mark.parametrize("cap,who", [(0.15, "auditor"), (2.0, "auditor"), (2.01, "team_lead"), (20.0, "team_lead"), (25.0, "branch_head")])
def test_who_may_approve_depends_on_the_cap(cap, who):
    assert missions.approver_for(cap) == who


@pytest.mark.parametrize("cap,role,aip_roles,ok", [(2.0, "user", [], True), (5.0, "user", [], False), (5.0, "user", ["team_lead"], True),
                                                   (25.0, "user", ["team_lead"], False), (25.0, "admin", [], True)])
def test_the_same_gate_for_approving_and_extending_a_cap(cap, role, aip_roles, ok):
    p = {"role": role, "aip_roles": aip_roles}
    if ok:
        missions._check_approver(p, cap)
    else:
        with pytest.raises(HTTPException):
            missions._check_approver(p, cap)


def _t(i: str, ms: str, status: str) -> dict:
    return {"id": i, "milestone": ms, "status": status}


def test_a_finished_milestone_is_validated_before_the_next_task():
    done = [_t("t1", "M1", "completed"), _t("t2", "M1", "failed"), _t("t3", "M2", "pending")]
    assert missions.next_step(done, set()) == ("M1", None)  # also when its validation was cut short earlier
    assert missions.next_step(done, {"M1"}) == (None, done[2])
    halfway = [_t("t1", "M1", "completed"), _t("t2", "M1", "pending")]
    assert missions.next_step(halfway, set()) == (None, halfway[1])
    assert missions.next_step([_t("t1", "M1", "completed")], {"M1"}) == (None, None)


def test_run_budget_refuses_a_call_that_would_pass_it():
    _fresh_data()
    d = runs._dir() / RUN
    d.mkdir(parents=True)
    rec = {"id": RUN, "budget_usd": 0.05, "spent_usd": 0.049}
    (d / "run.json").write_text(json.dumps(rec), "utf-8")  # a run record on disk, as the run manager writes it
    runs.check_budget(RUN, 0.0005)
    with pytest.raises(runs.RunBudgetExceeded):
        runs.check_budget(RUN, 0.002)
    (d / "run.json").write_text(json.dumps({**rec, "budget_usd": None}), "utf-8")  # a question: only the Vertex caps apply
    runs.check_budget(RUN, 5.0)


def test_daily_share_counts_only_todays_questions_of_that_user():
    _fresh_data()
    today = runs._now()
    for n, (user, spent, created, mission) in enumerate([("u-a", 0.2, today, None), ("u-a", 0.1, today, None), ("u-b", 0.4, today, None),
                                                         ("u-a", 0.3, "2026-01-01T00:00:00+00:00", None), ("u-a", 0.5, today, "mis-00000000a1")]):
        (runs._dir() / _rid(n)).mkdir(parents=True)
        (runs._dir() / _rid(n) / "run.json").write_text(json.dumps({"id": _rid(n), "user_id": user, "spent_usd": spent, "created_at": created,
                                                                    "mission_id": mission}), "utf-8")
    assert runs._spent_today("u-a") == pytest.approx(0.3)


def test_a_write_waits_for_a_reader_holding_the_file():
    # the e2e mission test died here: the page's poll had tasks.json open while the mission thread replaced it
    _fresh_data()
    path = runs._dir() / "tasks.json"
    runs._write(path, [{"id": "t1", "status": "pending"}])
    reader = open(path, encoding="utf-8")  # noqa: SIM115 - held open on purpose, as a concurrent reader does
    threading.Timer(0.3, reader.close).start()
    runs._write(path, [{"id": "t1", "status": "running"}])
    assert json.loads(path.read_text("utf-8")) == [{"id": "t1", "status": "running"}]
    assert not list(path.parent.glob("*.tmp"))


# ---------------------------------------------------------------- runs and missions left without their process


def _dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def test_a_run_nobody_follows_is_interrupted_and_its_orphan_runtime_stopped():
    _fresh_data()
    script = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])  # a script that started a run
    orphan = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "aip.adk_runtime.main"])  # a runtime left behind
    try:
        cases = {_rid(1): {"pid": _dead_pid()}, _rid(2): {"pid": None}, _rid(3): {"pid": orphan.pid, "host_pid": _dead_pid()},
                 _rid(4): {"pid": orphan.pid, "host_pid": script.pid}}
        for rid, rec in cases.items():
            (runs._dir() / rid).mkdir(parents=True)
            (runs._dir() / rid / "run.json").write_text(json.dumps({"id": rid, "status": "running", **rec}), "utf-8")
        assert runs._rec(_rid(4))["status"] == "running"  # another live process follows it
        assert orphan.poll() is None
        assert runs._rec(_rid(1))["status"] == "interrupted"
        assert json.loads((runs._dir() / _rid(1) / "run.json").read_text("utf-8"))["status"] == "interrupted"
        assert runs._rec(_rid(2))["status"] == "interrupted"  # written before runs kept their pid
        assert runs._rec(_rid(3))["status"] == "interrupted"
        orphan.wait(timeout=10)  # the runtime holding the user's token is stopped
    finally:
        script.kill()
        orphan.kill()


def test_a_mission_whose_loop_is_gone_pauses_for_a_person():
    _fresh_data()
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])  # another process running a mission
    ids = {"gone": "mis-00000000a1", "plan": "mis-00000000a2", "elsewhere": "mis-00000000a3"}
    try:
        for key, status, host in (("gone", "running", _dead_pid()), ("plan", "planning", _dead_pid()), ("elsewhere", "running", other.pid)):
            d = missions._dir() / ids[key]
            d.mkdir(parents=True)
            (d / "mission.json").write_text(json.dumps({"id": ids[key], "status": status, "host_pid": host}), "utf-8")
            (d / "tasks.json").write_text(json.dumps([{"id": "t1", "status": "completed"}, {"id": "t2", "status": "running"}]), "utf-8")
        m = missions._settle(missions._load(ids["gone"]))
        assert m["status"] == "paused"
        assert [t["status"] for t in json.loads((missions._dir() / ids["gone"] / "tasks.json").read_text("utf-8"))] == ["completed", "pending"]
        assert missions._read_jsonl(missions._dir() / ids["gone"] / "log.jsonl")[-1]["what"] == "interrupted"
        assert missions._settle(missions._load(ids["plan"]))["status"] == "failed"
        assert missions._settle(missions._load(ids["elsewhere"]))["status"] == "running"
    finally:
        other.kill()


# ---------------------------------------------------------------- gates from the security review


def test_run_and_mission_ids_never_reach_the_filesystem_as_paths():
    for bad in ("../missions/x", "run-..", "run-0123456789ab/../../x", "RUN-0123456789AB"):
        with pytest.raises(HTTPException):
            runs._rec(bad)
        assert runs._events(bad) == []
    with pytest.raises(HTTPException):
        missions._load("../runs/run-0123456789ab")


class _Req:
    """A request as Starlette builds it: the socket it came in on, and the Host header the client chose."""

    def __init__(self, host_header: str, server: tuple):
        self.scope = {"server": server, "headers": [(b"host", host_header.encode())]}
        self.headers = {"host": host_header}


def test_the_runtime_never_calls_the_host_a_client_names(monkeypatch):
    monkeypatch.delenv("BLUESANDAI_INTERNAL_API_URL", raising=False)
    assert runs.internal_api(_Req("evil.example", ("127.0.0.1", 8000))) == "http://localhost:8000"
    assert runs.internal_api(_Req("evil.example", ("10.0.0.5", 9000))) == "http://10.0.0.5:9000"
    monkeypatch.setenv("BLUESANDAI_INTERNAL_API_URL", "http://api.internal:8000/")
    assert runs.internal_api(_Req("evil.example", ("127.0.0.1", 8000))) == "http://api.internal:8000"


class _GatewayReq:
    def __init__(self, headers: dict):
        self.headers = {k.lower(): v for k, v in headers.items()}


def test_the_model_gateway_serves_only_a_live_run_with_its_own_token():
    from aip import gateway

    runs._live[RUN] = {"rec": {"id": RUN}, "events": [], "proc": None, "token": "bsai_job_right"}
    try:
        for headers in ({}, {"X-AIP-Run": "run-ffffffffffff", "Authorization": "Bearer bsai_job_right"},
                        {"X-AIP-Run": RUN}, {"X-AIP-Run": RUN, "Authorization": "Bearer bsai_job_wrong"},
                        {"X-AIP-Run": RUN, "Authorization": "bsai_job_right"}):
            with pytest.raises(HTTPException) as e:
                gateway._live_run(_GatewayReq(headers))
            assert e.value.status_code == 403
        assert gateway._live_run(_GatewayReq({"X-AIP-Run": RUN, "Authorization": "Bearer bsai_job_right"})) == RUN
    finally:
        runs._live.pop(RUN, None)


AGG = {"type": "function", "function": {"name": "agregasi_objek", "parameters": {"type": "object", "required": ["tipe", "metrik", "properti", "kelompok", "filter_json"],
                                                                                  "properties": {k: {"type": "string"} for k in ("tipe", "metrik", "properti", "kelompok", "filter_json", "batas", "urut_berdasarkan", "urutan")}}}}
SEARCH = {"type": "function", "function": {"name": "cari_objek", "parameters": {"type": "object", "required": ["tipe", "filter_json"],
                                                                             "properties": {k: {"type": "string"} for k in ("tipe", "filter_json", "batas")}}}}


def test_a_tool_call_leaked_without_tokens_becomes_a_call():
    from aip import gateway

    # the validator's last message on 2026-10-22: reasoning, then the call as plain text, its verdict lost
    leaked = ("We need verify answer... Let's query counts per province for each flag.commentary "
              '{"tipe": "Klaim Berisiko (BPJS)", "metrik": "count", "properti": "flag_los_ekstrem", "kelompok": "provinsi", '
              '"filter_json": "", "batas": 0, "urut_berdasarkan": "", "urutan": ""}')
    payload = {"choices": [{"message": {"role": "assistant", "content": leaked}, "finish_reason": "stop"}]}
    out = gateway._repair(payload, True, [SEARCH, AGG])
    call = out["choices"][0]["message"]["tool_calls"][0]["function"]
    assert call["name"] == "agregasi_objek" and json.loads(call["arguments"])["properti"] == "flag_los_ekstrem"
    assert out["choices"][0]["finish_reason"] == "tool_calls" and out["choices"][0]["message"]["content"] is None
    # an answer that only mentions JSON, or arguments that fit no tool, stay text
    plain = {"choices": [{"message": {"role": "assistant", "content": 'Hasilnya {"checks": []}'}, "finish_reason": "stop"}]}
    assert gateway._repair(plain, True, [SEARCH, AGG])["choices"][0]["message"]["content"] == 'Hasilnya {"checks": []}'
    assert gateway._bare_call('commentary {"x": 1}', [SEARCH, AGG]) == []


def test_failover_goes_to_another_family():
    from aip import models as M

    for m in (M.DEEPSEEK, M.GPT_OSS, M.GLM):
        alt = M.failover(m)
        assert alt and M.family(alt) != M.family(m) and M.ready(alt)


# the agents' tools on a catalogue and platform data as the API returns them (no network: the refusals come first)
CLAIMS = {"id": "ot-claims", "name": "Klaim Berisiko (BPJS)", "api_name": "KlaimBerisikoBpjs", "primary_key": "klaim_id", "properties": []}
REGIONS = {"id": "ot-prov", "name": "Provinsi (BPJS)", "api_name": "ProvinsiBpjs", "primary_key": "provinsi_kode", "properties": []}
CATALOGUE = {"agents": [{"key": "klaim_fraud", "name": "Agen Klaim & Fraud (BPJS)", "object_types": [CLAIMS]},
                        {"key": "faskes_wilayah", "name": "Agen Faskes & Wilayah (BPJS)", "object_types": [REGIONS]}]}


def _tool(name: str, functions: list | None = None, actions: list | None = None):
    from aip.adk_runtime import tools as T

    box = T.Toolbox(None, CATALOGUE)
    box._functions = functions or []
    box._actions = actions or []
    return next(f for f in T.object_tools(box, "klaim_fraud") if f.__name__ == name)


def test_agents_run_only_reading_functions_of_their_own_types():
    run = _tool("jalankan_fungsi", functions=[
        {"id": "f-edit", "name": "tutup_klaim", "kind": "edit", "edits": ["KlaimBerisikoBpjs"], "inputs": [{"name": "k", "type": "object:KlaimBerisikoBpjs"}]},
        {"id": "f-other", "name": "ringkas", "kind": "function", "inputs": [{"name": "p", "type": "object:ProvinsiBpjs"}]},
    ])
    for name, typ in (("tutup_klaim", "Klaim Berisiko (BPJS)"), ("ringkas", "Klaim Berisiko (BPJS)"), ("tidak_ada", "Klaim Berisiko (BPJS)")):
        assert "tidak ada fungsi baca" in run(nama_fungsi=name, tipe=typ, kunci="K1")["error"]
    assert "milik" in run(nama_fungsi="ringkas", tipe="Provinsi (BPJS)", kunci="73")["error"]  # another agent's type


def test_proposals_name_the_exact_action_and_keep_the_object(capsys):
    hold = {"id": "act-hold", "display_name": "Tahan klaim untuk verifikasi (BPJS)", "api_name": "tahanKlaim", "object_type_id": "ot-claims",
            "status": "active", "parameters": [{"id": "object", "type": "object", "required": True},
                                                {"id": "catatan_verifikasi", "display_name": "Alasan penahanan", "type": "string", "required": True}]}
    elsewhere = {**hold, "id": "act-other", "object_type_id": "ot-prov"}
    propose = _tool("usulkan_action", actions=[elsewhere, hold])
    assert "tidak ada" in propose(action="Hapus semua klaim", tipe="Klaim Berisiko (BPJS)", kunci="K1", parameter_json="{}", alasan="x")["error"]
    out = propose(action="Tahan klaim untuk verifikasi (BPJS)", tipe="Klaim Berisiko (BPJS)", kunci="K1",
                  parameter_json='{"object": "K999", "catatan_verifikasi": "x"}', alasan="x")
    assert "parameter tidak dikenal" in out["error"]  # the agent cannot point the action at another object
    out = propose(action="Tahan klaim untuk verifikasi (BPJS)", tipe="Klaim Berisiko (BPJS)", kunci="K1",
                  parameter_json='{"catatan_verifikasi": "LOS ekstrem"}', alasan="LOS 3x median peer")
    assert "error" not in out
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    proposal = next(e for e in events if e["type"] == "proposal")
    assert proposal["action_id"] == "act-hold" and proposal["object_param"] == "object" and proposal["pk"] == "K1"
    assert [d["id"] for d in proposal["parameter_defs"]] == ["catatan_verifikasi"]


def test_filters_accept_the_aliases_models_write():
    from aip.adk_runtime.tools import _filters  # the tools module needs httpx only, not ADK

    assert _filters('[{"field": "provinsi", "value": "SULAWESI SELATAN"}]') == [{"property": "provinsi", "op": "eq", "value": "SULAWESI SELATAN"}]
    assert _filters('{"properti": "skor_risiko", "operator": "gte", "nilai": 50}') == [{"property": "skor_risiko", "op": "gte", "value": 50}]
    assert _filters("") == []
