"""Only the agents a question needs, on the running API with the real models (no stubs): a question that needs no data
is answered by the orchestrator directly (the fast path: no domain agent, no validator, one model call), and a light
question about the data gets the one agent that owns its objects, then the validator.

    python -m pytest test_aip_jalur.py -q -s          # the API on BLUESANDAI_E2E_API (default http://localhost:8000)
"""

from __future__ import annotations

import json
import re

import requests

from test_aip_e2e import API, answer_of, ask, auditor, receipts  # noqa: F401  (the fixture and helpers of the AIP suite)


def _stages(events: list[dict]) -> list[str]:
    return [str(e.get("stage")) for e in events if e["type"] == "stage"]


def _direct(events: list[dict]) -> bool:
    plan = next((e for e in events if e["type"] == "plan"), {})
    answer = next((e for e in events if e["type"] == "answer"), {})
    return plan.get("jalur") == "langsung" and answer.get("jalur") == "langsung"


def test_questions_that_need_no_data_get_the_orchestrator_alone(auditor: requests.Session):  # noqa: F811
    for q in ("Halo, terima kasih atas bantuannya kemarin!", "Apa kepanjangan INA-CBG dan untuk apa dipakai?", "Siapa presiden Indonesia saat ini?"):
        run, events = ask(auditor, q, timeout=300)
        assert run["status"] == "succeeded", [e for e in events if e["type"] == "error"]
        assert _direct(events), (_stages(events), next((e for e in events if e["type"] == "plan"), None))
        assert _stages(events) == ["plan"] and not receipts(events)  # no domain agent, no validator: nothing read
        text = answer_of(events)
        assert len(text) > 20
        print(f"   langsung: {text[:220]}")
    assert "JKN" in text or "klaim" in text.lower()  # outside JKN: it says what AIP JKN answers instead


def test_a_pasted_claim_goes_through_the_inference_pipeline_first(auditor: requests.Session):  # noqa: F811
    # the user's report (2026-10-23): this claim pasted as a question sent three agents to search the data for it — fifteen
    # failed reads, an agent at its token limit, ten minutes
    claim = {"claim_id": "CLM-2026-9942", "patient_age": 29, "ina_cbg_code": "A-4-13-III", "primary_diagnosis": "A41.9", "claimed_cost": 18450000,
             "real_cost": 3150000, "length_of_stay_days": 2,
             "clinical_notes": "Pasien datang dengan keluhan demam tifoid dan mual. Diberikan infus RL dan obat oral. Hari kedua demam turun dan pasien "
                               "meminta pulang paksa. Tidak ada tindakan pemasangan ventilator atau observasi ICU."}
    run, events = ask(auditor, json.dumps(claim, indent=2), timeout=900)
    assert run["status"] == "succeeded", [e for e in events if e["type"] == "error"]
    assert _stages(events)[:2] == ["verify", "plan"]
    first = next(r for r in receipts(events) if r["tool"] == "verifikasi_klaim_baru")
    assert first["ok"] and first.get("rid"), first
    lost = [r for r in receipts(events) if not r["ok"] and "CLM-2026-9942" in str(r.get("summary"))]
    assert not lost, lost  # nobody searched the data for a claim that is not in it
    text = answer_of(events)
    assert first["rid"] in text and re.search(r"indikasi kuat|perlu diperiksa|wajar", text, re.I), text[:400]
    failed = [r for r in receipts(events) if not r["ok"]]
    print(f"   {len(receipts(events))} langkah tool, {len(failed)} gagal · tahap {_stages(events)}")


def test_a_light_question_about_the_data_gets_only_what_it_needs(auditor: requests.Session):  # noqa: F811
    """A light question about the data: since the audit route (the user, 2026-10-24: read the consultancy's work, do not
    redo it) the audit pack of its scope, read by code, with at most two agent tasks; else the one agent that owns its
    objects. Never the direct path (a number is a fact, and a fact needs a read), and its figure is the pack's."""
    run, events = ask(auditor, "Berapa jumlah klaim berisiko di Provinsi Bali?", timeout=600)
    assert run["status"] == "succeeded", [e for e in events if e["type"] == "error"]
    plan = next(e for e in events if e["type"] == "plan")
    assert plan.get("jalur") != "langsung", plan
    if plan.get("jalur") == "audit":
        assert len(plan["tasks"]) <= 2, plan
    else:
        owners = {t["agen"] for t in plan["tasks"]}
        assert 1 <= len(plan["tasks"]) <= 3 and "klaim_fraud" in owners and len(owners) <= 2, plan
    assert any(e["type"] == "verdict" and e.get("total") for e in events), _stages(events)  # read, then checked
    bali = auditor.post(f"{API}/api/aip/karantina/paket", json={"provinsi": "BALI"}, timeout=300).json()
    n = next(p for p in bali["bagian"] if p["kunci"] == "ringkasan")["baris"][0]["klaim"]
    assert f"{n:,}".replace(",", ".") in answer_of(events), (n, answer_of(events)[:400])
    print(f"   jalur {plan.get('jalur')} · tugas {[t['agen'] for t in plan['tasks']]} · tahap {_stages(events)}")
