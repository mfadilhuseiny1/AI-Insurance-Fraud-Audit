"""The AI calls of the /testing service.

First choice: OpenRouter, DeepSeek V4.1 Flash for text and Muse Glimmer 30B for reading images, only providers that keep
no prompts (data_collection: deny). Fallback when it fails or has no key: AWS Bedrock, DeepSeek V3.2 (deepseek.v3.2, the
newest DeepSeek Bedrock lists for this account on 2026-11-11) and Amazon Nova Lite for images, with the AWS keys of
.env.local (region AWS_BEDROCK_REGION, else AWS_REGION). TESTING_LLM=bedrock makes Bedrock the first choice (AWS credits).
On four flagged claims (2026-11-11) both gave valid answers; V4.1 Flash was a little more precise and about half the cost.
A hard cap per call from the listed prices (Bedrock prices are estimates); keys are read from the environment and never
logged or returned. The page shows no provider or model name."""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
from typing import Any, Optional

import httpx

log = logging.getLogger("testing.llm")
URL = "https://openrouter.ai/api/v1/chat/completions"
TEKS = "deepseek/deepseek-v4.1-flash"
VISI = "meta/muse-glimmer-30b"
BEDROCK = {TEKS: "deepseek.v3.2", VISI: "us.amazon.nova-lite-v1:0"}
# USD per million tokens (input, output): OpenRouter list prices (upper bounds); Bedrock estimates
HARGA = {TEKS: (0.15, 0.60), VISI: (0.30, 1.20), "deepseek.v3.2": (0.62, 1.85), "us.amazon.nova-lite-v1:0": (0.06, 0.24)}
BATAS_PER_PANGGILAN = 0.05
_LOCK = threading.Lock()
TOTAL = {"panggilan": 0, "usd": 0.0}
_BR: dict[str, Any] = {}


def _env(name: str) -> str:
    from mailer import env

    return (os.environ.get(name) or env(name) or "").strip()


def _key() -> str:
    return _env("OPENROUTER_API_KEY")


def _aws_siap() -> bool:
    return bool(_env("AWS_ACCESS_KEY_ID") and _env("AWS_SECRET_ACCESS_KEY"))


def penyedia() -> list[str]:
    """The providers in the order they are tried."""
    urut = ["bedrock", "openrouter"] if _env("TESTING_LLM").lower() == "bedrock" else ["openrouter", "bedrock"]
    return [p for p in urut if (p == "bedrock" and _aws_siap()) or (p == "openrouter" and _key())]


def siap() -> bool:
    return bool(penyedia())


def _cek_biaya(model: str, messages: list[dict], max_tokens: int) -> None:
    pin, pout = HARGA[model]
    terburuk = (len(json.dumps(messages, default=str)) / 3) * pin / 1e6 + max_tokens * pout / 1e6
    if terburuk > BATAS_PER_PANGGILAN:
        raise RuntimeError(f"permintaan terlalu besar untuk batas ${BATAS_PER_PANGGILAN} per panggilan")


def _catat(usd: float) -> None:
    with _LOCK:
        TOTAL["panggilan"] += 1
        TOTAL["usd"] += usd


# ---------------------------------------------------------------------------------------------------------- Bedrock
def _bedrock_client() -> Any:
    if "c" not in _BR:
        import boto3
        from botocore.config import Config

        _BR["c"] = boto3.client("bedrock-runtime", region_name=_env("AWS_BEDROCK_REGION") or _env("AWS_REGION") or "us-east-1",
                                aws_access_key_id=_env("AWS_ACCESS_KEY_ID"), aws_secret_access_key=_env("AWS_SECRET_ACCESS_KEY"),
                                config=Config(read_timeout=150, connect_timeout=15, retries={"max_attempts": 3, "mode": "adaptive"}))
    return _BR["c"]


def _ke_converse(messages: list[dict]) -> tuple[list[dict], list[dict]]:
    system, out = [], []
    for m in messages:
        if m["role"] == "system":
            system.append({"text": m["content"]})
            continue
        isi = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
        parts = []
        for c in isi:
            if c.get("type") == "text":
                parts.append({"text": c["text"]})
            elif c.get("type") == "image_url":
                mt = re.match(r"data:image/(\w+);base64,(.*)$", c["image_url"]["url"], re.S)
                if mt:
                    fmt = {"jpg": "jpeg"}.get(mt.group(1).lower(), mt.group(1).lower())
                    parts.append({"image": {"format": fmt, "source": {"bytes": base64.b64decode(mt.group(2))}}})
        out.append({"role": m["role"], "content": parts})
    return system, out


def _bedrock(messages: list[dict], model: str, max_tokens: int) -> dict:
    mid = BEDROCK[model]
    _cek_biaya(mid, messages, max_tokens)
    system, msgs = _ke_converse(messages)
    t0 = time.time()
    kw: dict[str, Any] = {"modelId": mid, "messages": msgs, "inferenceConfig": {"maxTokens": max_tokens, "temperature": 0.2}}
    if system:
        kw["system"] = system
    r = _bedrock_client().converse(**kw)
    teks = "".join(c.get("text", "") for c in r["output"]["message"]["content"] if isinstance(c, dict))
    u = r.get("usage") or {}
    pin, pout = HARGA[mid]
    usd = (u.get("inputTokens", 0) * pin + u.get("outputTokens", 0) * pout) / 1e6
    _catat(usd)
    return {"teks": teks, "usd": usd, "model": f"bedrock/{mid}", "detik": round(time.time() - t0, 1)}


# ---------------------------------------------------------------------------------------------------------- OpenRouter
def _openrouter(messages: list[dict], model: str, max_tokens: int, reasoning: Optional[str], timeout: float, json_mode: bool) -> dict:
    key = _key()
    if not key:
        raise RuntimeError("penyedia AI cadangan belum dikonfigurasi")
    _cek_biaya(model, messages, max_tokens)
    body: dict[str, Any] = {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens,
                            "provider": {"data_collection": "deny", "allow_fallbacks": True}, "usage": {"include": True}}
    if reasoning:
        body["reasoning"] = {"effort": reasoning}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    t0 = time.time()
    last = None
    for attempt in range(3):
        try:
            r = httpx.post(URL, headers={"Authorization": f"Bearer {key}", "X-Title": "AI JKN Synthetic testing"}, json=body, timeout=timeout)
        except httpx.HTTPError as e:
            last = f"{type(e).__name__}"
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code in (429, 500, 502, 503, 504):
            last = f"HTTP {r.status_code}"
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 400 and "response_format" in body:
            body.pop("response_format")  # a provider without JSON mode: the prompt asks for JSON anyway
            continue
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        msg = ((d.get("choices") or [{}])[0].get("message") or {})
        teks = msg.get("content") or ""
        if not teks.strip() and isinstance(msg.get("reasoning"), str) and "{" in msg["reasoning"]:
            teks = msg["reasoning"]  # an answer left in the reasoning field: json_dari takes the object out of it
        usd = float((d.get("usage") or {}).get("cost") or 0.0)
        _catat(usd)
        return {"teks": teks, "usd": usd, "model": d.get("model") or model, "detik": round(time.time() - t0, 1)}
    raise RuntimeError(f"tidak ada jawaban ({last})")


def panggil(messages: list[dict], model: str = TEKS, max_tokens: int = 4000, reasoning: Optional[str] = "low", timeout: float = 150,
            json_mode: bool = False) -> dict:
    """One chat call through the first provider that answers; returns {teks, usd, model, detik}. Raises RuntimeError."""
    galat = []
    for p in penyedia():
        try:
            if p == "bedrock":
                return _bedrock(messages, model, max_tokens)
            return _openrouter(messages, model, max_tokens, reasoning, timeout, json_mode)
        except Exception as e:  # noqa: BLE001 - try the next provider
            log.warning("testing.llm: %s failed: %s", p, str(e)[:300])
            galat.append(f"{p}: {type(e).__name__}")
    raise RuntimeError("penyedia AI tidak menjawab (" + "; ".join(galat or ["belum dikonfigurasi"]) + ")")


def json_dari(teks: str) -> Optional[dict]:
    """The first JSON object in a model's answer (a fenced block or bare)."""
    if not teks:
        return None
    teks = re.sub(r"<think>.*?</think>", "", teks, flags=re.S)
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", teks, re.S)
    cand = m.group(1) if m else None
    if cand is None:
        a, b = teks.find("{"), teks.rfind("}")
        cand = teks[a:b + 1] if a >= 0 and b > a else None
    if not cand:
        return None
    for c in (cand, re.sub(r",\s*([}\]])", r"\1", cand)):
        try:
            return json.loads(c)
        except ValueError:
            continue
    return None
