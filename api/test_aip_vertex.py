"""Tests for the AIP model registry and the Vertex AI route with its spend guard. No fakes: the route tests call the
real Vertex endpoint of the configured project with tiny prompts and book into the real spend ledger (<data>/aip/
vertex_spend), so their cost counts against the budget caps in .env.local. A full run costs under $0.01.
Run: python -m pytest test_aip_vertex.py -q (from api/). Needs `gcloud auth application-default login`."""
import os
from pathlib import Path

import pytest

import pipeline_ai
from aip import models as M
from aip import vertex as V
from mailer import env as real_env

DATA = Path(os.environ.get("BLUESANDAI_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
CHECK_CLAIM = [{"name": "check_claim", "description": "Periksa satu klaim JKN dengan aturan dan skor fraud.",
                "parameters": {"type": "object", "properties": {"prosedur": {"type": "string", "description": "kode ICD-9"},
                                                                "diagnosa": {"type": "string", "description": "kode ICD-10"},
                                                                "tarif_klaim": {"type": "integer"}},
                               "required": ["prosedur", "diagnosa", "tarif_klaim"]}}]
ASK_CLAIM = [{"role": "user", "text": "Periksa klaim dengan prosedur 87.44, diagnosa J18.9, tarif Rp 3.000.000. Panggil tool yang tepat."}]


@pytest.fixture
def live():
    """The real project, credentials and ledger; `overrides` changes a setting for one test."""
    overrides: dict[str, str] = {}
    V.configure(DATA, lambda k: overrides.get(k) or real_env(k))
    if not V._credentials_file().is_file():
        pytest.skip("no Google application-default credentials on this machine")
    yield overrides
    V.configure(DATA, real_env)


def spent() -> float:
    return V.spend()["total_usd"]


# ---------------------------------------------------------------- the registry (plain logic, no network)


def test_pick_keeps_validators_off_the_family_they_check():
    assert M.pick("scrutiny", checks=M.GPT_OSS) == M.DEEPSEEK
    assert M.pick("auditor_sim", checks=M.DEEPSEEK) == M.GPT_OSS
    assert M.pick("tools", checks=M.GPT_OSS) == M.DEEPSEEK  # default is the same family: the escalation takes over
    with pytest.raises(ValueError):
        M.pick("planner", checks=M.GLM)


def test_pick_skips_models_not_yet_enabled():
    assert not M.ready(M.QWEN_CODER)
    assert M.pick("sql", strong=True) == M.GPT_OSS  # Qwen3-Coder needs Enable in Model Garden first


def test_cost_uses_list_prices_cache_and_batch():
    mtok = {"prompt_tokens": 1_000_000, "completion_tokens": 1_000_000}
    assert M.cost(M.GPT_OSS, mtok) == pytest.approx(0.09 + 0.36)
    assert M.cost(M.GPT_OSS, mtok, batch=True) == pytest.approx(0.045 + 0.18)
    cached = {**mtok, "prompt_tokens_details": {"cached_tokens": 600_000}}
    assert M.cost(M.DEEPSEEK, cached) == pytest.approx(0.4 * 0.30 + 0.6 * 0.03 + 1.20)
    assert M.cost(M.GPT_OSS, cached) == pytest.approx(0.09 + 0.36)  # no cached price on Vertex: billed as input
    assert M.cost("vertex/unknown/model", mtok) == 0.0


def test_catalogue_lists_every_model_with_its_roles():
    cat = M.catalogue()
    assert {m["id"] for m in cat["models"]} == set(M.MODELS)
    gpt = next(m for m in cat["models"] if m["id"] == M.GPT_OSS)
    assert gpt["ready"] and "tools" in gpt["roles"] and gpt["price"]["input"] == 0.09
    assert cat["roles"]["planner"]["default"] == M.GLM


# ---------------------------------------------------------------- the guard (refuses before any request is sent)


def test_guard_refuses_before_spending(live):
    live["BLUESANDAI_VERTEX_DAILY_USD"] = "0.000001"
    before = spent()
    with pytest.raises(V.BudgetExceeded):
        pipeline_ai._chat(M.GLM, "", "x" * 3000, None, 0, 4000, None, None, None)
    assert spent() == before and V._inflight == 0.0


def test_total_budget_ceiling_refuses(live):
    live["BLUESANDAI_VERTEX_TOTAL_USD"] = str(spent())  # the ceiling already reached
    with pytest.raises(V.BudgetExceeded, match="budget used up"):
        V.post(M.GPT_OSS, {"model": "openai/gpt-oss-120b-maas", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}, 30)


def test_unpriced_model_is_refused(live):
    with pytest.raises(V.BudgetExceeded):
        V.post("vertex/unknown/model", {"messages": [], "max_tokens": 10}, 10)


def test_rejected_request_is_not_booked_and_releases_its_reservation(live):
    live["BLUESANDAI_VERTEX_LOCATION"] = "nowhere-1"  # a region that does not exist: Google answers with an error
    before = spent()
    r = V.post(M.GPT_OSS, {"model": "openai/gpt-oss-120b-maas", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}, 30)
    assert r.status_code != 200
    assert spent() == before and V._inflight == 0.0


# ---------------------------------------------------------------- real calls through pipeline_ai (books real spend)


def test_chat_answers_and_books_its_cost(live):
    seen = []
    hook = lambda m, s, t: seen.append((m, s, t))  # noqa: E731
    pipeline_ai.USAGE_HOOKS.append(hook)
    before = spent()
    try:
        out = pipeline_ai._chat(M.GPT_OSS, "", "Reply with exactly: OK", None, 0, 300, None, None, None)
    finally:
        pipeline_ai.USAGE_HOOKS.remove(hook)
    assert "OK" in out.upper()
    assert 0 < spent() - before < 0.001
    assert any(m == M.GPT_OSS and s == "succeeded" and t > 0 for m, s, t in seen)


def test_structured_answer_follows_the_schema(live):
    schema = {"type": "object", "properties": {"jalur": {"type": "string", "enum": ["otomatis", "review", "ditahan"]}}, "required": ["jalur"]}
    out = pipeline_ai._chat(M.GPT_OSS, "Anda verifikator klaim JKN.", "Klaim tanpa dokumen pendukung, tarif tiga kali rata-rata peer. Pilih jalur.",
                            schema, 0, 600, None, None, None)
    assert out["jalur"] in ("otomatis", "review", "ditahan")


def test_tool_call(live):
    out = pipeline_ai._chat_tools(M.GPT_OSS, "", ASK_CLAIM, CHECK_CLAIM, 0, 600, "auto", None, None, None)
    call = out["tool_calls"][0]
    assert call["name"] == "check_claim" and call["args"]["prosedur"] == "87.44"


def test_streamed_tool_call_books_its_usage(live):
    before = spent()
    pieces = []
    out = pipeline_ai._chat_tools(M.GPT_OSS, "", ASK_CLAIM, CHECK_CLAIM, 0, 600, "auto", pieces.append, None, None)
    assert out["tool_calls"][0]["name"] == "check_claim"
    assert spent() > before  # the stream's last event carried usage (stream_options.include_usage)


@pytest.mark.parametrize("model", [m for m in M.MODELS if M.ready(m) and m != M.GPT_OSS])
def test_every_ready_model_answers(live, model):
    before = spent()
    out = pipeline_ai._chat(model, "", "Reply with exactly: OK", None, 0, 600, None, None, None)
    assert "OK" in out.upper(), f"{model} answered {out!r}"
    assert spent() > before


# ---------------------------------------------------------------- gpt-oss leaking raw tool-call tokens (seen in the golden run)

LEAKED = '<|start|>assistant<|channel|>commentary to=functions.search_nexus <|constrain|>json<|message|>{"query": "999", "k": 10}<|call|>'


def test_leaked_tool_call_becomes_a_structured_call():
    text, calls = V.repair_harmony(LEAKED, [], may_call=True)
    assert text == "" and calls[0]["name"] == "search_nexus" and calls[0]["args"] == {"query": "999", "k": 10}


def test_leaked_tool_call_without_tools_is_asked_again():
    with pytest.raises(ValueError):
        V.repair_harmony(LEAKED, [], may_call=False)
    assert V.repair_harmony("Faskes itu tidak ditemukan.", [], may_call=False) == ("Faskes itu tidak ditemukan.", [])
