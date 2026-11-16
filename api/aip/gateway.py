"""The model gateway of the AIP agents: OpenAI-compatible chat completions for the AIP model registry.

The ADK runtime (aip/adk_runtime) reaches every model through here, with LiteLLM pointed at this API and the run's
job token as the key, so the platform stays the one gateway: each call goes through the Vertex spend guard (aip/vertex.py),
the platform's model usage hooks (Data Lineage usage, Logic token counts) and the run's own ledger, which Mission
Control shows per agent. A run with a budget (a mission) is refused once its spend would pass it.

    POST /api/aip/openai/v1/chat/completions   body: OpenAI chat completions; model = a registry id (vertex/…)
    POST /api/aip/openai/v1/decisions          body: {model, items: [{input, questions}]}, OpenAI Decisions requests in one
                                               batch; model = openai/gpt-6-luna
    headers: X-AIP-Run (run id), X-AIP-Agent (the agent calling), Authorization: Bearer <that run's job token>

Only a run that is running in this API process, called with its own job token, is served: a signed-in user cannot
use the gateway as free model access, and a finished run's id books nothing more.
"""

from __future__ import annotations

import hmac
import json
import logging
import re
import time
from typing import Any

import requests
from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from aip import models as aip_models
from aip import runs as aip_runs
from aip import vertex as aip_vertex

router = APIRouter(prefix="/api/aip")

# the OpenAI parameters passed on to Vertex (LiteLLM adds others Vertex does not take)
FORWARD = ("messages", "tools", "tool_choice", "temperature", "top_p", "max_tokens", "stop", "response_format", "seed", "stream", "reasoning_effort",
           "chat_template_kwargs")
TIMEOUT = 180  # a streamed answer
RETRY_ELSEWHERE = {429, 500, 502, 503, 504}
MAX_OUTPUT = 16384  # the briefing writer reasons before it writes (adk_runtime/agents.py think="deep")
log = logging.getLogger("aip.gateway")


def _error(status: int, message: str, code: str) -> JSONResponse:
    # 400, not 429: LiteLLM retries a 429, and a budget refusal must not be retried
    return JSONResponse({"error": {"message": message, "type": code, "code": code}}, status_code=status)


def _book(model: str, run_id: str, agent: str, usage: dict | None, calls: int = 1) -> None:
    import pipeline_ai

    total = int((usage or {}).get("total_tokens") or 0)
    pipeline_ai._note_usage(model, "succeeded", total)
    if run_id:
        aip_runs.book(run_id, agent, model, usage, calls)


_BARE_CALL = re.compile(r"commentary(?:\s+to=functions\.([A-Za-z0-9_\-]+))?\s*(?:json)?\s*(\{.*\})\s*$", re.S)


def _bare_call(text: str, tools: list[dict]) -> list[dict]:
    """gpt-oss also leaks a tool call without its control tokens: reasoning, then `commentary {"tipe": …}` at the end
    (seen 2026-10-22: the validator's verdict was lost to it). The tool is the one named, else the one whose
    parameters the arguments fit; nothing is guessed when no tool fits exactly one way."""
    m = _BARE_CALL.search(text or "")
    if not m:
        return []
    try:
        args = json.loads(m.group(2))
    except ValueError:
        return []
    if not isinstance(args, dict):
        return []
    specs = [t.get("function") or {} for t in tools or []]
    fits = [s for s in specs if s.get("name") == m.group(1)] if m.group(1) else [
        s for s in specs if set(args) <= set((s.get("parameters") or {}).get("properties") or {})
        and set((s.get("parameters") or {}).get("required") or []) <= set(args)]
    return [{"name": fits[0]["name"], "raw_args": json.dumps(args, ensure_ascii=False)}] if len(fits) == 1 else []


def _repair(payload: dict, may_call: bool, tools: list[dict] | None = None) -> dict:
    msg = ((payload.get("choices") or [{}])[0]).get("message") or {}
    text = msg.get("content") or ""
    if "</think>" in text:  # GLM writes its reasoning into the answer (seen 2026-10-23: a plan lost behind it); the answer follows it
        thought, text = text.rsplit("</think>", 1)
        msg["reasoning_content"] = ((msg.get("reasoning_content") or "") + thought.replace("<think>", "")).strip()
        text = text.strip()
        msg["content"] = text or None
    calls = [{"name": (c.get("function") or {}).get("name"), "raw_args": (c.get("function") or {}).get("arguments")} for c in msg.get("tool_calls") or []]
    if may_call and not calls and "<|" not in text and (bare := _bare_call(text, tools or [])):
        msg["content"] = None
        msg["tool_calls"] = [{"id": "call_0", "type": "function", "function": {"name": bare[0]["name"], "arguments": bare[0]["raw_args"]}}]
        payload["choices"][0]["finish_reason"] = "tool_calls"
        return payload
    fixed_text, fixed_calls = aip_vertex.repair_harmony(text, calls, may_call)
    if may_call and not calls and not fixed_calls and (bare := _bare_call(fixed_text, tools or [])):
        # the same bare call inside control tokens (`commentary {…}<|call|>`, `<|channel|>commentary {…}`): once the tokens are
        # gone it was left as the agent's final text (Audit Nasional 1.1, 2026-10-29: four agents stopped on it, among them
        # QA Faskes & Wilayah, whose 3 unchecked claims then counted as failed)
        msg["content"] = None
        msg["tool_calls"] = [{"id": "call_0", "type": "function", "function": {"name": bare[0]["name"], "arguments": bare[0]["raw_args"]}}]
        payload["choices"][0]["finish_reason"] = "tool_calls"
        return payload
    if (fixed_text, fixed_calls) != (text, calls):
        msg["content"] = fixed_text or None
        if fixed_calls and not msg.get("tool_calls"):
            msg["tool_calls"] = [{"id": f"call_{i}", "type": "function", "function": {"name": c["name"], "arguments": c["raw_args"] or "{}"}}
                                 for i, c in enumerate(fixed_calls)]
            payload["choices"][0]["finish_reason"] = "tool_calls"
    return payload


def _live_run(request: Request) -> str:
    """The calling run: running here, and the bearer is its own job token."""
    run_id = request.headers.get("x-aip-run", "")
    live = aip_runs._live.get(run_id)
    if not live:
        raise HTTPException(403, "the model gateway serves running AIP runs only")
    bearer = request.headers.get("authorization", "")
    bearer = bearer[7:].strip() if bearer[:7].lower() == "bearer " else ""
    if live["token"] and not hmac.compare_digest(bearer, live["token"]):
        raise HTTPException(403, "the model gateway takes the run's own job token")
    return run_id


@router.post("/openai/v1/chat/completions")
def chat_completions(request: Request, body: dict = Body(...)) -> Any:
    model = str(body.get("model") or "")
    if model not in aip_models.MODELS:
        raise HTTPException(400, f"{model!r} is not in the AIP model registry")
    if aip_models.is_decisions(model):
        raise HTTPException(400, f"{model} answers typed decisions, not chat: POST /api/aip/openai/v1/decisions")
    run_id, agent = _live_run(request), request.headers.get("x-aip-agent", "")[:60]
    fwd = {k: body[k] for k in FORWARD if k in body}
    fwd["model"] = aip_models.publisher_model(model)
    # every call has a bounded output, so its worst case (what the budgets reserve) is bounded too
    fwd["max_tokens"] = max(1, min(int(fwd.get("max_tokens") or body.get("max_completion_tokens") or 2048), MAX_OUTPUT))
    may_call = bool(fwd.get("tools")) and fwd.get("tool_choice") != "none"
    try:
        aip_runs.check_budget(run_id, aip_vertex.worst_case(model, fwd))
    except aip_runs.RunBudgetExceeded as e:
        return _error(400, str(e), "run_budget_exceeded")
    stream = bool(fwd.get("stream"))
    if stream:
        fwd["stream_options"] = {"include_usage": True}
    if aip_models.is_openrouter(model):
        answered = _openrouter(model, fwd, stream, run_id, agent, may_call)
        if answered is not None:
            return answered
        # OpenRouter did not answer: the same model on Vertex, through the path below (its retries and failover)
        model = aip_models.VERTEX_TWIN[model]
        fwd["model"] = aip_models.publisher_model(model)
    # Blu 1.1's examiners ask for no failover: an answer of another family is refused there (paid, not used), and a 429
    # passed on lets them pause their seat instead of spending the other family's quota
    may_fail_over = request.headers.get("x-aip-failover", "").lower() != "off"
    for attempt in range(2):  # a leaked raw tool call is asked once more
        try:
            used, r = (model, aip_vertex.post(model, fwd, TIMEOUT, stream=True)) if stream else _upstream(model, fwd, may_fail_over)
        except aip_vertex.BudgetExceeded as e:
            return _error(400, str(e), "budget_exceeded")
        except requests.RequestException as e:
            return _error(504, f"no model answered: {type(e).__name__}: {e}"[:500], "upstream_timeout")
        if r.status_code != 200:
            return JSONResponse(r.json() if r.headers.get("content-type", "").startswith("application/json") else {"error": {"message": r.text[:500]}},
                                status_code=r.status_code)
        if stream:
            return StreamingResponse(_relay(r, model, run_id, agent), media_type="text/event-stream")
        payload = r.json()
        _book(used, run_id, agent, payload.get("usage"))
        try:
            # the model that answered (the failover may have): Blu 1.1's re-check refuses an answer of the screen's family
            return JSONResponse(_repair(payload, may_call, fwd.get("tools")), headers={"x-aip-model": used})
        except ValueError:
            if attempt:
                return _error(502, "the model answered with raw tool-call markup twice", "bad_model_output")


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DECISIONS_URL = "https://api.openai.com/v1/decisions"
DECISIONS_TIMEOUT = 60  # an answer takes ~0.3 s (p90 0.4 s on 1.000 claims, 2026-10-30)
DECISIONS_BATCH = 20  # requests one gateway call may carry (an examiner takes ten claims)
# one kept-alive pool to OpenAI: a new TLS connection per claim cost ~0.5 s from here (2026-10-30)
_decisions_http = requests.Session()
_decisions_http.mount("https://", requests.adapters.HTTPAdapter(pool_connections=2, pool_maxsize=64))


def _key(name: str) -> str:
    import os

    key = os.environ.get(name, "").strip()
    if not key:  # as the API reads its other settings: .env.local beside the environment
        try:
            import unstructured.partition.pdf_image.bluesandai_structuring as bs

            key = (bs._read_env_local().get(name) or "").strip()
        except Exception:  # noqa: BLE001 - no key: the caller says what it does without one
            key = ""
    return key


def _openrouter_key() -> str:
    return _key("OPENROUTER_API_KEY")  # none: the Vertex twin answers


def decisions_ready() -> bool:
    """OPENAI_API_KEY is set (Blu 1.3's screen cannot start without it)."""
    return bool(_key("OPENAI_API_KEY"))


@router.post("/openai/v1/decisions")
def decisions(request: Request, body: dict = Body(...)) -> Any:
    """OpenAI Decisions for Blu 1.3's clinical examination (aip/telaah.py): an examiner's claims in one call, {model, items:
    [{input, questions}]}, asked one after another over one kept-alive connection and booked once for the batch (the run's
    ledger and the platform's spend file: one lock each, not one per claim). Refused past the run's budget. No failover:
    a Decisions answer has no twin; a 429 or an outage ends the batch, its results so far returned with the refusal last
    ({status, error, retry_after}) for the examiner to pause and ask the rest again."""
    model = str(body.get("model") or "")
    if not aip_models.is_decisions(model):
        raise HTTPException(400, f"{model!r} is not a Decisions model of the AIP registry")
    items = body.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= DECISIONS_BATCH:
        raise HTTPException(400, f"items: 1–{DECISIONS_BATCH} Decisions requests")
    run_id, agent = _live_run(request), request.headers.get("x-aip-agent", "")[:60]
    fwd = [{"model": model[len(aip_models.OPENAI_PREFIX):], "input": (it or {}).get("input"), "questions": (it or {}).get("questions")} for it in items]
    try:  # its worst case: every request read whole as input (output is not charged)
        aip_runs.check_budget(run_id, sum(aip_models.cost(model, {"prompt_tokens": len(json.dumps(f, ensure_ascii=False)) // 3 + 1}) for f in fwd))
    except aip_runs.RunBudgetExceeded as e:
        return _error(400, str(e), "run_budget_exceeded")
    key = _key("OPENAI_API_KEY")
    if not key:
        return _error(503, "OPENAI_API_KEY is not set in the environment or .env.local", "no_key")
    results: list[dict] = []
    used = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}
    for f in fwd:
        t0 = time.time()
        try:
            r = _decisions_http.post(DECISIONS_URL, headers={"Authorization": f"Bearer {key}"}, json=f, timeout=DECISIONS_TIMEOUT)
        except (requests.Timeout, requests.ConnectionError) as e:
            results.append({"status": 504, "error": {"message": f"{model} did not answer: {type(e).__name__}"}})
            break
        if r.status_code != 200:
            log.warning("AIP gateway: %s did not answer (HTTP %s)", model, r.status_code)
            try:
                err = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            except ValueError:
                err = {}
            results.append({"status": r.status_code, "error": err.get("error") or {"message": r.text[:300]}, "retry_after": r.headers.get("retry-after")})
            break
        payload = r.json()
        u = payload.get("usage") or {}
        used["prompt_tokens"] += int(u.get("input_tokens") or 0)
        used["completion_tokens"] += int(u.get("output_tokens") or 0)
        used["total_tokens"] += int(u.get("total_tokens") or 0)
        used["prompt_tokens_details"]["cached_tokens"] += int((u.get("input_tokens_details") or {}).get("cached_tokens") or 0)
        results.append({"status": 200, "ms": int((time.time() - t0) * 1000), **payload})
    answered = sum(1 for x in results if x["status"] == 200)
    if answered:
        aip_vertex.record(model, used, calls=answered)
        _book(model, run_id, agent, used, calls=answered)
    return JSONResponse({"model": model, "results": results}, headers={"x-aip-model": model})


def _openrouter(model: str, fwd: dict, stream: bool, run_id: str, agent: str, may_call: bool) -> Any:
    """One call of an OpenRouter model (aip/models.py OR_*), booked like a Vertex one: the run's ledger and the platform's
    spend file. GLM's "no thinking" switch (chat_template_kwargs on Vertex) is OpenRouter's `reasoning`. None when OpenRouter
    does not answer (no key, a refusal after one retry, a timeout): the caller asks the Vertex twin."""
    key = _openrouter_key()
    if not key:
        log.warning("AIP gateway: %s asked, but OPENROUTER_API_KEY is not set; the Vertex twin answers", model)
        return None
    body = {k: v for k, v in fwd.items() if k not in ("chat_template_kwargs", "reasoning_effort")}
    body["model"] = model[len(aip_models.OR_PREFIX):]
    if (fwd.get("chat_template_kwargs") or {}).get("enable_thinking") is False:
        body["reasoning"] = {"enabled": False}
    elif fwd.get("reasoning_effort"):
        body["reasoning"] = {"effort": fwd["reasoning_effort"]}
    body["usage"] = {"include": True}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-Title": "BluesandAI AIP JKN"}
    wait = TIMEOUT if stream else aip_models.attempt_timeout(fwd.get("max_tokens"))
    for attempt in range(2):
        try:
            r = requests.post(OPENROUTER_URL, headers=headers, json=body, timeout=wait, stream=stream)
        except (requests.Timeout, requests.ConnectionError) as e:
            log.warning("AIP gateway: %s did not answer (%s)", model, type(e).__name__)
            return None
        if r.status_code == 200:
            break
        log.warning("AIP gateway: %s did not answer (HTTP %s)", model, r.status_code)
        r.close()
        if r.status_code not in RETRY_ELSEWHERE or attempt:
            return None
        time.sleep(2)
    if stream:
        return StreamingResponse(_relay(r, model, run_id, agent), media_type="text/event-stream")
    payload = r.json()
    aip_vertex.record(model, payload.get("usage"))
    _book(model, run_id, agent, payload.get("usage"))
    try:
        return JSONResponse(_repair(payload, may_call, fwd.get("tools")))
    except ValueError:
        return None


def _upstream(model: str, fwd: dict, may_fail_over: bool = True) -> tuple[str, Any]:
    """(the model that answered, its response): `model`, or — when its endpoint stalls or fails (seen 2026-10-22:
    DeepSeek on Vertex hung for 180 s twice and took a whole run down) — once a ready model of another family. The run's
    ledger books the model that answered, so a failover shows per agent. Without `may_fail_over`, `model` alone (a 429
    still waited out)."""
    wait = aip_models.attempt_timeout(fwd.get("max_tokens"))
    alt = aip_models.failover(model) if may_fail_over else None
    alt_body = None
    if alt:
        alt_body = {k: v for k, v in fwd.items() if k not in ("reasoning_effort", "chat_template_kwargs")}  # per-model settings
        alt_body["model"] = aip_models.publisher_model(alt)
        if aip_models.family(alt) == "openai":
            alt_body["reasoning_effort"] = "low"
    # the model, then once another family; when both refused for quota (429) — a burst that passes in seconds — waited
    # out, alternating (a 20-minute consultancy engagement died on one validator call's 429, 2026-10-23). A stall or a
    # 5xx is not retried past the failover: each try costs its whole timeout
    tries = [(model, fwd, 0.0), (alt, alt_body, 0.0), (model, fwd, 4.0), (alt, alt_body, 8.0), (model, fwd, 15.0)]
    reason, last = "", None
    for who, body, pause in tries:
        if not who:
            continue
        if pause:
            if "429" not in reason:
                break
            time.sleep(pause)
        if last is not None:
            last[1].close()
            last = None
        try:
            r = aip_vertex.post(who, body, wait)
        except (requests.Timeout, requests.ConnectionError) as e:
            reason = type(e).__name__
            log.warning("AIP gateway: %s did not answer (%s)", who, reason)
            continue
        if r.status_code not in RETRY_ELSEWHERE:
            return who, r
        reason, last = f"HTTP {r.status_code}", (who, r)
        log.warning("AIP gateway: %s did not answer (%s)", who, reason)
    if last is not None:  # the refusal as it came, for the caller to pass on
        return last
    raise requests.Timeout(f"{model}: {reason}" + ("" if alt else ", and no other model is ready"))


def _relay(r: Any, model: str, run_id: str, agent: str):
    """Pass a streamed answer through as it arrives; book its usage (the last event) at the end."""
    usage: dict = {}
    try:
        for raw in r.iter_lines():
            line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            if line.startswith("data:") and line[5:].strip() not in ("", "[DONE]"):
                try:
                    ev = json.loads(line[5:])
                    usage = ev.get("usage") or usage
                except ValueError:
                    pass
            yield (line + "\n").encode("utf-8")
    finally:
        r.close()
        aip_vertex.record(model, usage or None)
        _book(model, run_id, agent, usage or None)
