"""The AIP model registry: open-weight models served by Vertex AI Model Garden (MaaS), their prices and families, and
the role each one plays. The one place model ids live: pipeline_ai routes `vertex/<publisher>/<model>` ids through
aip.vertex, ADK agents build their LiteLlm models from `litellm_id`, and GET /api/aip/models lists `catalogue()`.

Prices are USD per 1M tokens, Vertex AI on-demand list prices read 2026-10-22
(https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing). `cached` is None where Vertex lists
no cached-input price: those models bill cached tokens at the input price. `verified` is the day the model answered on
the project; None means it still needs Enable in Model Garden, and `pick` skips it.
"""

from __future__ import annotations

from typing import Any, Optional

PREFIX = "vertex/"

GPT_OSS = "vertex/openai/gpt-oss-120b-maas"
DEEPSEEK = "vertex/deepseek-ai/deepseek-v4.1-flash-maas"
GLM = "vertex/zai-org/glm-5.2-maas"
GEMMA = "vertex/google/gemma-4-26b-a4b-it-maas"
QWEN_CODER = "vertex/qwen/qwen3-coder-480b-a35b-instruct-maas"
QWEN = "vertex/qwen/qwen3-235b-a22b-instruct-2507-maas"
KIMI = "vertex/moonshotai/kimi-k2-thinking-maas"
LLAMA = "vertex/meta/llama-4-maverick-17b-128e-instruct-maas"
DEEPSEEK_OCR = "vertex/deepseek-ai/deepseek-ocr-maas"
MINIMAX = "vertex/minimaxai/minimax-m2-maas"


def _m(label: str, vendor: str, family: str, inp: float, out: float, cached: Optional[float] = None, batch: Optional[tuple[float, float]] = None,
       tools: bool = False, vision: bool = False, verified: Optional[str] = None, licence: str = "") -> dict[str, Any]:
    return {"label": label, "vendor": vendor, "family": family, "tools": tools, "vision": vision, "verified": verified, "licence": licence,
            "price": {"input": inp, "output": out, "cached": cached, "batch_input": batch[0] if batch else None, "batch_output": batch[1] if batch else None}}


MODELS: dict[str, dict[str, Any]] = {
    GPT_OSS: _m("gpt-oss-120b", "OpenAI", "openai", 0.09, 0.36, batch=(0.045, 0.18), tools=True, verified="2026-10-22", licence="Apache-2.0"),
    DEEPSEEK: _m("DeepSeek-V4.1-Flash", "DeepSeek", "deepseek-ai", 0.30, 1.20, cached=0.03, tools=True, verified="2026-10-22", licence="MIT"),
    GLM: _m("GLM-5.2", "Z.ai", "zai-org", 1.40, 4.40, cached=0.14, tools=True, verified="2026-10-22", licence="MIT"),
    GEMMA: _m("Gemma 4 26B", "Google", "google", 0.15, 0.60, cached=0.015, verified="2026-10-22", licence="Gemma"),
    QWEN_CODER: _m("Qwen3-Coder-480B", "Alibaba", "qwen", 0.22, 1.80, cached=0.022, batch=(0.11, 0.90), tools=True, licence="Apache-2.0"),
    QWEN: _m("Qwen3-235B-Instruct", "Alibaba", "qwen", 0.22, 0.88, batch=(0.11, 0.44), tools=True, licence="Apache-2.0"),
    KIMI: _m("Kimi-K2-Thinking", "Moonshot AI", "moonshotai", 0.60, 2.50, cached=0.06, tools=True, licence="Modified MIT"),
    LLAMA: _m("Llama 4 Maverick", "Meta", "meta", 0.35, 1.15, batch=(0.175, 0.575), tools=True, vision=True, licence="Llama 4"),
    DEEPSEEK_OCR: _m("DeepSeek-OCR", "DeepSeek", "deepseek-ai", 0.30, 1.20, vision=True, licence="MIT"),
    MINIMAX: _m("MiniMax-M2", "MiniMax", "minimaxai", 0.30, 1.20, cached=0.03, tools=True, licence="MIT"),
}

# OpenRouter (the user, 2026-10-29: "ok pake openrouter aja" — the AIP Operator's chat; the same GLM-5.2 answered its first token
# in 0.47 s there against 1.57 s on Vertex MaaS, and Vertex throttles GLM with 429s): reached through aip/gateway.py with
# OPENROUTER_API_KEY, the run's job token and ledger as for Vertex. Prices from openrouter.ai/api/v1/models, read 2026-10-29.
OR_PREFIX = "openrouter/"
OR_GLM = "openrouter/z-ai/glm-5.2"
OR_DEEPSEEK = "openrouter/deepseek/deepseek-v4.1-flash"
MODELS[OR_GLM] = _m("GLM-5.2 (OpenRouter)", "Z.ai", "zai-org", 0.006, 7.0, cached=0.005, tools=True, verified="2026-10-29", licence="MIT")
MODELS[OR_DEEPSEEK] = _m("DeepSeek-V4.1-Flash (OpenRouter)", "DeepSeek", "deepseek-ai", 0.045, 0.5, cached=0.006, tools=True, verified="2026-10-29",
                         licence="MIT")
# the same model on Vertex: the gateway answers with it when OpenRouter does not
VERTEX_TWIN = {OR_GLM: GLM, OR_DEEPSEEK: DEEPSEEK}


def is_openrouter(model: str) -> bool:
    return model.startswith(OR_PREFIX)


# OpenAI's Decisions API (the user, 2026-10-30: Blu 1.3's clinical examination): POST https://api.openai.com/v1/decisions with
# OPENAI_API_KEY, typed answers with a probability per option and no text; gpt-6-luna is its only model. Uncached input
# $0.10/M, cached $0.01/M, output not charged (developers.openai.com/api/docs/guides/decisions and /pricing, read 2026-10-30).
# On the key 2026-10-30: 1.000 claims in 28 s at 12 at once, ~1.130 tokens a claim; 5.000 requests and 2M tokens a minute
OPENAI_PREFIX = "openai/"
DECISIONS = "openai/gpt-6-luna"
MODELS[DECISIONS] = {**_m("GPT-6 Luna · Decisions", "OpenAI", "openai", 0.10, 0.0, cached=0.01, verified="2026-10-30", licence="proprietary"),
                     "decisions": True}


def is_decisions(model: str) -> bool:
    """A model reached through the Decisions API (aip/gateway.py /openai/v1/decisions), never through chat completions."""
    return bool((MODELS.get(model) or {}).get("decisions"))


# role -> (default, escalation); validators are picked with `checks` so they never judge their own family
ROLES: dict[str, tuple[str, Optional[str]]] = {
    "router": (GPT_OSS, None),
    # interactive tool agents: DeepSeek reads a 16k-token prompt in 2.7 s, gpt-oss in 15 s (itb-agentic, 2026-10-22);
    # missions and batch, where latency does not matter, use the cheaper gpt-oss ("batch")
    "tools": (DEEPSEEK, GPT_OSS),
    "sql": (GPT_OSS, QWEN_CODER),
    "medical": (DEEPSEEK, KIMI),
    "writer": (DEEPSEEK, GLM),
    "planner": (GLM, None),
    "scrutiny": (DEEPSEEK, GLM),
    "auditor_sim": (GPT_OSS, GEMMA),
    "batch": (GPT_OSS, QWEN),
    # the plain-language layer for leaders (the user, 2026-10-24: "layer GPT … bahasa yang bisa dimengerti orang awam"):
    # a model other than the writer's retells the validated briefing; code checks every number it uses
    "awam": (GPT_OSS, GLM),
    "ocr": (DEEPSEEK_OCR, None),
    "vision": (LLAMA, GEMMA),
}


def is_vertex(model: str) -> bool:
    return model.startswith(PREFIX)


def publisher_model(model: str) -> str:
    """"vertex/openai/gpt-oss-120b-maas" -> "openai/gpt-oss-120b-maas", the id Vertex's chat completions take."""
    return model[len(PREFIX):] if is_vertex(model) else model


def litellm_id(model: str) -> str:
    return "vertex_ai/" + publisher_model(model)


def family(model: str) -> str:
    spec = MODELS.get(model)
    return spec["family"] if spec else publisher_model(model).split("/", 1)[0]


def ready(model: str) -> bool:
    return bool((MODELS.get(model) or {}).get("verified"))


def failover(model: str) -> Optional[str]:
    """A ready model of another family to answer when `model`'s endpoint stalls or fails (aip/gateway.py)."""
    return next((m for m in (DEEPSEEK, GPT_OSS, GLM) if m != model and family(m) != family(model) and ready(m)), None)


def attempt_timeout(max_tokens: Optional[int]) -> float:
    """Seconds the gateway waits for one whole (unstreamed) answer: a long one needs its writing time. The briefing (GLM,
    thinking, 6000 tokens) took over 60 s every time and was always cut over to another model (seen 2026-10-23)."""
    return max(60.0, min(180.0, (max_tokens or 0) / 35))


def client_timeout(max_tokens: Optional[int]) -> float:
    """The runtime's wait for the gateway: one attempt plus the failover, with room to spare."""
    return 2 * attempt_timeout(max_tokens) + 30


def pick(role: str, strong: bool = False, checks: Optional[str] = None) -> str:
    """The model for a role: the default, or the escalation when `strong`; a model not yet enabled is skipped, and a
    validator (`checks` = the model whose output it judges) never gets a model of that model's family."""
    default, up = ROLES[role]
    order = [m for m in ([up, default] if strong else [default, up]) if m]
    for m in order:
        if ready(m) and not (checks and family(m) == family(checks)):
            return m
    raise ValueError(f"no enabled model for role '{role}'" + (f" outside the {family(checks)} family" if checks else ""))


def cost(model: str, usage: Optional[dict], batch: bool = False) -> float:
    """USD for one call from its OpenAI-style usage ({prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens}),
    or the Decisions API's ({input_tokens, output_tokens, input_tokens_details.cached_tokens})."""
    spec = MODELS.get(model)
    if not spec or not usage:
        return 0.0
    p = spec["price"]
    prompt = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    out = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
    cached = min(prompt, int(details.get("cached_tokens") or 0))
    pin = (p["batch_input"] if batch and p["batch_input"] is not None else p["input"])
    pout = (p["batch_output"] if batch and p["batch_output"] is not None else p["output"])
    pcached = p["cached"] if p["cached"] is not None else pin
    return ((prompt - cached) * pin + cached * pcached + out * pout) / 1_000_000


def catalogue() -> dict[str, Any]:
    """The registry for the API and the web pickers: every model with its price and readiness, and the role table."""
    roles_of: dict[str, list[str]] = {}
    for role, pair in ROLES.items():
        for m in pair:
            if m:
                roles_of.setdefault(m, []).append(role)
    return {"models": [{"id": mid, **spec, "ready": bool(spec["verified"]), "roles": roles_of.get(mid, [])} for mid, spec in MODELS.items()],
            "roles": {r: {"default": d, "escalation": u} for r, (d, u) in ROLES.items()}}
