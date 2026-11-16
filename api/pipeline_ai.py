"""Pipeline Builder services the browser cannot do itself: LLM calls for the Use LLM node, the evaluation
suite and the AI helpers (explain, generate, regex, notional data); text extraction from media (PDFs and
images) for media set transforms; and calls to registered REST models.

The pipeline engine runs in the browser (and in the web server for builds) and is synchronous, so it asks
for these in batches, keyed by a hash of each request. Answers are kept in a small SQLite cache under
data/pipeline/, which is what "Skip recomputing rows" reuses; errors and nulls are never cached.

Mounted by server.py under /api/pipeline.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import drive
from aip import models as aip_models
from aip import vertex as aip_vertex

log = logging.getLogger("bluesandai.pipeline_ai")
router = APIRouter(prefix="/api/pipeline")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OCR_MODEL = "qwen/qwen3.7-flash"
PAGE_BREAK = chr(10) + chr(12) + chr(10)  # pages of extracted text are separated by a form feed
DEFAULT_TEXT_MODEL = "vertex/openai/gpt-oss-120b-maas"  # open model on Vertex AI (aip/models.py)
# who the platform's assistants are part of: their answers name the platform BluesandAI Hexa, never another vendor
# (its APIs look like Foundry's, so a model otherwise guesses "Palantir Foundry")
PLATFORM = (
    "You are part of BluesandAI Hexa, a data and AI platform (Pipeline Builder, Code Repositories, Code Workspaces, the Nexus "
    "ontology, Model Studio and Modeling Objectives, Workshop apps, Data Lineage). Always call the platform BluesandAI Hexa. "
    "Its APIs — transforms.api, ModelOutput / ModelInput, MLflow models, the Nexus and its object types — are BluesandAI "
    "Hexa's own: never describe the user's code or the platform as Palantir or Foundry."
)


def with_platform(system: Optional[str]) -> str:
    """An assistant's system prompt with the platform's identity first."""
    s = (system or "").strip()
    return PLATFORM if not s else (s if s.startswith(PLATFORM) else f"{PLATFORM}\n\n{s}")
TIMEOUT = 180
ATTEMPTS = 4
MAX_CALLS = 500  # per request; the browser sends batches
PARALLEL = 8

_env: Callable[[str], str] = lambda key: ""
CACHE_PATH: Path = Path()
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=PARALLEL, thread_name_prefix="pipeline-ai")


def configure(data_dir: Path, env: Callable[[str], str]) -> None:
    global _env, CACHE_PATH
    _env = env
    aip_vertex.configure(data_dir, env)
    folder = data_dir / "pipeline"
    folder.mkdir(parents=True, exist_ok=True)
    CACHE_PATH = folder / "cache.sqlite"
    with _db() as con:
        con.execute("CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL)")


def _db() -> sqlite3.Connection:
    con = sqlite3.connect(CACHE_PATH, timeout=30, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    return con


def _cache_get(keys: list[str]) -> dict[str, Any]:
    if not keys:
        return {}
    out: dict[str, Any] = {}
    with _db() as con:
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            rows = con.execute(f"SELECT key, value FROM answers WHERE key IN ({','.join('?' * len(chunk))})", chunk).fetchall()
            for k, v in rows:
                out[k] = json.loads(v)
    return out


def _cache_put(key: str, value: Any) -> None:
    if value is None:
        return
    with _lock, _db() as con:
        con.execute(
            "INSERT OR REPLACE INTO answers (key, value, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(value, ensure_ascii=False), datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )


# ------------------------------------------------------------------------------------------------
# chat calls
# ------------------------------------------------------------------------------------------------


def _gemini_schema(schema: Any) -> Any:
    """JSON Schema → Gemini's OpenAPI subset: upper-case types, ["x", "null"] as nullable."""
    if isinstance(schema, dict):
        out: dict[str, Any] = {}
        for k, v in schema.items():
            if k == "additionalProperties":
                continue
            if k == "type":
                if isinstance(v, list):
                    kinds = [t for t in v if t != "null"]
                    out["type"] = (kinds[0] if kinds else "string").upper()
                    if "null" in v:
                        out["nullable"] = True
                else:
                    out["type"] = str(v).upper()
            else:
                out[k] = _gemini_schema(v)
        if out.get("type") == "OBJECT" and not out.get("properties"):
            # Gemini needs properties on an object; a free-form struct comes back as JSON text instead
            return {"type": "STRING", "description": "a JSON object"}
        return out
    if isinstance(schema, list):
        return [_gemini_schema(v) for v in schema]
    return schema


def parse_ref(ref: str) -> tuple[str, Optional[int], int]:
    """A media reference: Files item id with optional #page=N&rotate=D (degrees clockwise)."""
    from urllib.parse import parse_qs

    item_id, _, frag = ref.partition("#")
    q = parse_qs(frag)
    page = int(q["page"][0]) if "page" in q and q["page"][0].isdigit() else None
    rotate = int(q["rotate"][0]) % 360 if "rotate" in q and q["rotate"][0].lstrip("-").isdigit() else 0
    return item_id, page, rotate


def _rotated(jpeg: bytes, rotate: int) -> bytes:
    if not rotate:
        return jpeg
    from PIL import Image

    img = Image.open(io.BytesIO(jpeg)).rotate(-rotate, expand=True)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def _image_part(image: str) -> tuple[str, bytes | None, str]:
    """A media reference as (mime, bytes, url): a data URL, an http(s) URL, or a Files item id (optionally #page=N&rotate=D)."""
    if image.startswith("data:"):
        head, _, data = image.partition(",")
        return head[5:].split(";")[0] or "image/jpeg", base64.b64decode(data), ""
    if image.startswith(("http://", "https://")):
        return "image/jpeg", None, image
    item_id, page, rotate = parse_ref(image)
    item = drive._item(item_id)
    data = drive.read_bytes(item)
    if item["name"].lower().endswith(".pdf") or data[:4] == b"%PDF":
        return "image/jpeg", _rotated(_render_pdf_page(data, page or 1), rotate), ""
    return "image/jpeg", _rotated(_to_jpeg(data), rotate), ""


def _render_pdf_page(data: bytes, page: int, max_px: int = 1800) -> bytes:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        p = pdf[max(0, min(page - 1, len(pdf) - 1))]
        w, h = p.get_size()
        scale = max(0.3, min(3.0, max_px / max(w, h)))
        img = p.render(scale=scale).to_pil()
        p.close()
    finally:
        pdf.close()
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _registered_chat(fid: str, system: str, user: str, schema: Optional[dict], wrapped: Optional[dict], trace: Optional[dict]) -> Any:
    """A registered model (a function implementing ChatCompletion, functions_registry.py): structured answers are
    asked for in the prompt and parsed from the text."""
    import functions_registry

    if wrapped is not None:
        user = f"{user}\n\nAnswer with JSON only, matching this schema: {json.dumps(wrapped)}"
    error = ""
    for _attempt in range(2 if wrapped else 1):
        text = functions_registry.chat_completion(fid, system, user)
        if trace is not None:
            trace["attempts"].append(text)
        if wrapped is None:
            if trace is not None:
                trace["final"] = text.strip()
            return text.strip()
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
        try:
            parsed = json.loads(cleaned)
            value = parsed["value"] if isinstance(parsed, dict) and "value" in parsed else parsed
            if trace is not None:
                trace["final"] = json.dumps(value, ensure_ascii=False, indent=1)
            return value
        except ValueError:
            error = f"the answer is not the JSON asked for: {cleaned[:200]}"
    raise RuntimeError(f"function:{fid} failed: {error}")


# model usage (requests, tokens, rate limits): callables (model, status, tokens) — workflow_lineage.py records them
USAGE_HOOKS: list = []


def _note_usage(model: str, status: str, tokens: int = 0) -> None:
    for h in USAGE_HOOKS:
        try:
            h(model, status, tokens)
        except Exception:  # noqa: BLE001 - metrics never break a model call
            pass


def chat(
    model: str,
    system: str,
    user: str,
    schema: Optional[dict] = None,
    temperature: float = 0,
    max_tokens: int = 1024,
    stop: Optional[list[str]] = None,
    image: Optional[str] = None,
    trace: Optional[dict] = None,
) -> Any:
    """One call. With a schema the answer is JSON {"value": …} and the value is returned; else the text.
    `trace` (trial runs) collects the prompt sent, every raw answer and what was corrected. A call made outside a
    request (pipelines, parsing, schedules) writes its own llmInference audit line (a request's is written by
    audit3.middleware)."""
    import audit3

    if audit3._req.get() is not None:
        return _chat(model, system, user, schema, temperature, max_tokens, stop, image, trace)
    cut = audit3.LLM_CONTENT_MAX
    inputs = {"model": model, "system": (system or "")[:cut], "prompt": (user or "")[:cut]}
    try:
        out = _chat(model, system, user, schema, temperature, max_tokens, stop, image, trace)
    except Exception as e:
        audit3.emit("BACKGROUND_LLM_INFERENCE", ("llmInference",), {"llmInferenceInputs": inputs}, {"error": str(e)[:500]}, result="ERROR",
                    product="aip", service="aip-background")
        raise
    answer = out if isinstance(out, str) else json.dumps(out, default=str)
    audit3.emit("BACKGROUND_LLM_INFERENCE", ("llmInference",), {"llmInferenceInputs": inputs}, {"llmInferenceOutputs": answer[:cut]},
                product="aip", service="aip-background")
    return out


def _chat(model: str, system: str, user: str, schema: Optional[dict], temperature: float, max_tokens: int, stop: Optional[list[str]],
          image: Optional[str], trace: Optional[dict]) -> Any:
    if trace is not None:
        nl = chr(10)
        parts = [f"[system]{nl}{system}"] if system else []
        parts.append(f"[user]{nl}{user}")
        if image:
            parts.append(f"[image] {image[:80]}")
        if schema is not None:
            parts.append(f"[answer schema]{nl}{json.dumps(schema, indent=1)}")
        trace.update(initial_prompt=(nl * 2).join(parts), attempts=[], corrections=[], final="")
    wrapped = {"type": "object", "properties": {"value": schema}, "required": ["value"]} if schema is not None else None
    stop = [s for s in (stop or []) if s][:4]
    if model.startswith("function:"):
        return _registered_chat(model[len("function:"):], system, user, schema, wrapped, trace)
    vertex = aip_models.is_vertex(model)  # open models on Vertex AI, behind the spend guard (aip/vertex.py)
    if model.startswith("gemini"):
        key = _env("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set in .env.local")
        parts: list[dict] = [{"text": user}]
        if image:
            mime, data, url = _image_part(image)
            if url:
                r = requests.get(url, timeout=60)
                r.raise_for_status()
                data = r.content
            parts.insert(0, {"inline_data": {"mime_type": mime, "data": base64.b64encode(data or b"").decode()}})
        gen: dict[str, Any] = {"temperature": temperature, "maxOutputTokens": max_tokens, "thinkingConfig": {"thinkingLevel": "low"}}
        if stop:
            gen["stopSequences"] = stop
        if wrapped:
            gen["responseMimeType"] = "application/json"
            gen["responseSchema"] = _gemini_schema(wrapped)
        body: dict[str, Any] = {"contents": [{"role": "user", "parts": parts}], "generationConfig": gen}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        url, headers = GEMINI_URL.format(model=model), {"x-goog-api-key": key}
    else:
        key = "" if vertex else _env("OPENROUTER_API_KEY")
        if not vertex and not key:
            raise RuntimeError("OPENROUTER_API_KEY is not set in .env.local")
        content: Any = user
        if image:
            mime, data, url = _image_part(image)
            ref = url or f"data:{mime};base64,{base64.b64encode(data or b'').decode()}"
            content = [{"type": "image_url", "image_url": {"url": ref}}, {"type": "text", "text": user}]
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]
        body = {"model": aip_models.publisher_model(model), "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if stop:
            body["stop"] = stop
        if wrapped:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "strict": False, "schema": wrapped}}
        if "qwen" in model and not vertex:
            body["reasoning"] = {"enabled": False}
        url, headers = (aip_vertex.endpoint(), {}) if vertex else (OPENROUTER_URL, {"Authorization": f"Bearer {key}"})

    error = ""
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(2**attempt)
        try:
            resp = aip_vertex.post(model, body, TIMEOUT) if vertex else requests.post(url, headers=headers, json=body, timeout=TIMEOUT)
        except requests.RequestException as e:
            error = repr(e)
            continue
        if resp.status_code in (408, 429, 500, 502, 503, 504):
            error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            _note_usage(model, "rate_limited" if resp.status_code == 429 else "failed")
            continue
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
        try:
            payload = resp.json()
            if model.startswith("gemini"):
                cand = payload["candidates"][0]
                text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
            else:
                text = payload["choices"][0]["message"].get("content") or ""
            u = payload.get("usageMetadata") or {}
            _note_usage(model, "succeeded", u.get("totalTokenCount") or (payload.get("usage") or {}).get("total_tokens") or 0)
        except (KeyError, IndexError, ValueError) as e:
            error = f"unreadable answer ({e!r})"
            if trace is not None:
                trace["corrections"].append(f"attempt {attempt + 1}: {error} — retried")
            continue
        if trace is not None:
            trace["attempts"].append(text)
        if not wrapped:
            if trace is not None:
                trace["final"] = text.strip()
            return text.strip()
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
        try:
            value = json.loads(cleaned)["value"]
        except (ValueError, KeyError, TypeError):
            error = f"the answer is not the JSON asked for: {cleaned[:200]}"
            if trace is not None:
                trace["corrections"].append(f"attempt {attempt + 1}: {error} — asked again")
            continue
        # Gemini returns free-form structs as JSON text (see _gemini_schema)
        if isinstance(value, str) and schema and schema.get("type") == "object":
            try:
                value = json.loads(value)
            except ValueError:
                pass
        if trace is not None:
            if cleaned != text.strip():
                trace["corrections"].append("removed Markdown code fences around the JSON")
            trace["final"] = json.dumps(value, ensure_ascii=False, indent=1)
        return value
    raise RuntimeError(f"{model} failed after {ATTEMPTS} attempts: {error}")


# ------------------------------------------------------------------------------------------------
# native tool calling (a conversation with tool declarations; Workflow Builder's Use LLM node)
# ------------------------------------------------------------------------------------------------


class ToolsUnsupported(RuntimeError):
    """The model takes no tool declarations (a registered model, or a provider route without tool use): the caller asks
    for tool calls as JSON in the text instead."""


class StreamCancelled(RuntimeError):
    """The reader went away while a streamed answer was being read."""


def _gemini_contents(messages: list[dict]) -> list[dict]:
    """Neutral messages → Gemini contents. The model's own turns are sent back as they came (thought signatures
    included); consecutive tool results go back together in one turn, in the order of the calls."""
    out: list[dict] = []
    for m in messages:
        if m["role"] == "user":
            if out and out[-1]["role"] == "user":
                out[-1]["parts"].append({"text": m.get("text") or ""})  # a note after tool results joins their turn
            else:
                out.append({"role": "user", "parts": [{"text": m.get("text") or ""}]})
        elif m["role"] == "assistant":
            native = (m.get("native") or {}).get("gemini")
            if native:
                out.append(native)
                continue
            parts: list[dict] = [{"text": m["text"]}] if m.get("text") else []
            parts += [{"functionCall": {"name": t["name"], "args": t.get("args") or {}}} for t in m.get("tool_calls") or []]
            out.append({"role": "model", "parts": parts or [{"text": ""}]})
        elif m["role"] == "tool":
            res = m.get("result")
            fr: dict[str, Any] = {"name": m["name"], "response": res if isinstance(res, dict) else {"result": res}}
            if m.get("provider_id"):
                fr["id"] = m["provider_id"]
            if out and out[-1]["role"] == "user" and out[-1]["parts"] and "functionResponse" in out[-1]["parts"][0]:
                out[-1]["parts"].append({"functionResponse": fr})
            else:
                out.append({"role": "user", "parts": [{"functionResponse": fr}]})
    return out


def _openai_messages(system: str, messages: list[dict]) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": system}] if system else []
    for m in messages:
        if m["role"] == "user":
            out.append({"role": "user", "content": m.get("text") or ""})
        elif m["role"] == "assistant":
            native = (m.get("native") or {}).get("openai")
            if native:
                out.append(native)
                continue
            msg: dict[str, Any] = {"role": "assistant", "content": m.get("text") or None}
            if m.get("tool_calls"):
                msg["tool_calls"] = [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t.get("raw_args") or json.dumps(t.get("args") or {})}}
                                     for t in m["tool_calls"]]
            out.append(msg)
        elif m["role"] == "tool":
            out.append({"role": "tool", "tool_call_id": m["id"], "content": json.dumps(m.get("result"), ensure_ascii=False, default=str)})
    return out


def _gemini_turn(parts: list[dict]) -> tuple[str, list[dict], dict]:
    """A model turn's parts (all the streamed pieces, in order) → its text, its function calls and the turn to send back."""
    text: list[str] = []
    calls: list[dict] = []
    keep: list[dict] = []
    sig = None
    for p in parts:
        if p.get("thought"):
            continue
        if "functionCall" in p:
            keep.append(p)
            fc = p["functionCall"] or {}
            calls.append({"provider_id": fc.get("id"), "name": str(fc.get("name") or ""), "args": fc.get("args") if fc.get("args") is not None else {},
                          "raw_args": json.dumps(fc.get("args") if fc.get("args") is not None else {}, ensure_ascii=False)})
        elif "text" in p:
            text.append(p.get("text") or "")
            sig = p.get("thoughtSignature") or sig
        elif p.get("thoughtSignature"):
            sig = p["thoughtSignature"]
    joined = "".join(text)
    native_parts = ([{"text": joined, **({"thoughtSignature": sig} if sig else {})}] if joined else []) + keep
    return joined, calls, {"role": "model", "parts": native_parts or [{"text": ""}]}


def _openai_args(raw: Any) -> tuple[Any, str]:
    """A tool call's arguments as the provider sent them (JSON text) → (parsed or None when unreadable, raw text)."""
    if isinstance(raw, dict):
        return raw, json.dumps(raw, ensure_ascii=False)
    s = str(raw or "").strip()
    if not s:
        return {}, ""
    try:
        return json.loads(s), s
    except ValueError:
        return None, s


def chat_tools(
    model: str,
    system: str,
    messages: list[dict],
    tools: Optional[list[dict]] = None,
    temperature: float = 0,
    max_tokens: int = 2000,
    tool_choice: str = "auto",
    on_text: Optional[Callable[[str], None]] = None,
    cancel: Optional[threading.Event] = None,
    hold: Optional[dict] = None,
) -> dict:
    """One model turn in a conversation with native tool calling: OpenAI-compatible `tools` / `tool_calls` through
    OpenRouter or, for `vertex/…` ids, Vertex AI (aip/vertex.py); function declarations for Gemini.

    messages (neutral): {"role": "user", "text"}, {"role": "assistant", "text", "tool_calls", "native"} (as this function
    returned it) and {"role": "tool", "id", "name", "result", "provider_id"?}. tools: {"name", "description", "parameters"
    (JSON Schema of an object)}. tool_choice "none" asks for the final answer. With on_text the answer streams: on_text gets
    the text so far after every piece ("" when a failed attempt starts again).
    Returns {"text", "tool_calls": [{"id", "name", "args" (None: unreadable arguments), "raw_args", "provider_id"?}], "message"}
    — `message` is the assistant turn to append to messages. A registered model (function:…) raises ToolsUnsupported when
    tools are given; without tools it answers in text (streamed through its chunks)."""
    import audit3

    if audit3._req.get() is not None:
        return _chat_tools(model, system, messages, tools, temperature, max_tokens, tool_choice, on_text, cancel, hold)
    cut = audit3.LLM_CONTENT_MAX
    last_user = next((m.get("text") or "" for m in reversed(messages) if m["role"] == "user"), "")
    inputs = {"model": model, "system": (system or "")[:cut], "prompt": last_user[:cut]}
    try:
        out = _chat_tools(model, system, messages, tools, temperature, max_tokens, tool_choice, on_text, cancel, hold)
    except ToolsUnsupported:
        raise
    except Exception as e:
        audit3.emit("BACKGROUND_LLM_INFERENCE", ("llmInference",), {"llmInferenceInputs": inputs}, {"error": str(e)[:500]}, result="ERROR",
                    product="aip", service="aip-background")
        raise
    answer = out["text"] or json.dumps([{"tool": t["name"], "args": t["raw_args"]} for t in out["tool_calls"]], ensure_ascii=False)
    audit3.emit("BACKGROUND_LLM_INFERENCE", ("llmInference",), {"llmInferenceInputs": inputs}, {"llmInferenceOutputs": answer[:cut]},
                product="aip", service="aip-background")
    return out


def _chat_tools(model: str, system: str, messages: list[dict], tools: Optional[list[dict]], temperature: float, max_tokens: int, tool_choice: str,
                on_text: Optional[Callable[[str], None]], cancel: Optional[threading.Event], hold: Optional[dict]) -> dict:
    if model.startswith("function:"):
        if tools:
            raise ToolsUnsupported(f"{model} is a registered model: it takes no tool declarations")
        import functions_registry

        nl = chr(10)
        flat = (nl * 2).join(f"[{m['role']}]{nl}{m.get('text') or json.dumps(m.get('result'), ensure_ascii=False, default=str)}" for m in messages) \
            if len(messages) > 1 else (messages[0].get("text") or "" if messages else "")
        acc: list[str] = []

        def chunk(piece: str) -> None:
            acc.append(piece)
            if on_text:
                on_text("".join(acc))

        text = functions_registry.chat_completion(model[len("function:"):], system, flat, chunk if on_text else None).strip()
        return {"text": text, "tool_calls": [], "message": {"role": "assistant", "text": text, "tool_calls": []}}
    vertex = aip_models.is_vertex(model)  # open models on Vertex AI, behind the spend guard (aip/vertex.py)
    gemini = model.startswith("gemini")
    if gemini:
        key = _env("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set in .env.local")
        gen: dict[str, Any] = {"temperature": temperature, "maxOutputTokens": max_tokens, "thinkingConfig": {"thinkingLevel": "low"}}
        body: dict[str, Any] = {"contents": _gemini_contents(messages), "generationConfig": gen}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if tools:
            decls = []
            for t in tools:
                d: dict[str, Any] = {"name": t["name"], "description": t.get("description") or ""}
                if (t.get("parameters") or {}).get("properties"):
                    d["parameters"] = _gemini_schema(t["parameters"])
                decls.append(d)
            body["tools"] = [{"functionDeclarations": decls}]
            body["toolConfig"] = {"functionCallingConfig": {"mode": "NONE" if tool_choice == "none" else "AUTO"}}
        url = GEMINI_URL.format(model=model)
        if on_text:
            url = url.replace(":generateContent", ":streamGenerateContent") + "?alt=sse"
        headers = {"x-goog-api-key": key}
    else:
        key = "" if vertex else _env("OPENROUTER_API_KEY")
        if not vertex and not key:
            raise RuntimeError("OPENROUTER_API_KEY is not set in .env.local")
        body = {"model": aip_models.publisher_model(model), "messages": _openai_messages(system, messages), "temperature": temperature, "max_tokens": max_tokens}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t.get("description") or "",
                                                               "parameters": t.get("parameters") or {"type": "object", "properties": {}}}} for t in tools]
            body["tool_choice"] = "none" if tool_choice == "none" else "auto"
        if "qwen" in model and not vertex:
            body["reasoning"] = {"enabled": False}
        if on_text:
            body["stream"] = True
            if vertex:
                body["stream_options"] = {"include_usage": True}  # the last event carries the usage the guard books
        url, headers = (aip_vertex.endpoint(), {}) if vertex else (OPENROUTER_URL, {"Authorization": f"Bearer {key}"})

    error = ""
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(2**attempt)
            if on_text:
                on_text("")
        if cancel is not None and cancel.is_set():
            raise StreamCancelled()
        try:
            resp = aip_vertex.post(model, body, TIMEOUT, stream=bool(on_text)) if vertex \
                else requests.post(url, headers=headers, json=body, timeout=TIMEOUT, stream=bool(on_text))
        except requests.RequestException as e:
            error = repr(e)
            continue
        try:
            if hold is not None:
                hold["resp"] = resp
            if resp.status_code in (408, 429, 500, 502, 503, 504):
                error = f"HTTP {resp.status_code}: {resp.text[:200]}"
                _note_usage(model, "rate_limited" if resp.status_code == 429 else "failed")
                continue
            if resp.status_code != 200:
                detail = resp.text[:300]
                _note_usage(model, "failed")
                if tools and not gemini and resp.status_code in (400, 404) and "tool" in detail.lower():
                    raise ToolsUnsupported(f"{model}: {detail}")
                raise RuntimeError(f"HTTP {resp.status_code}: {detail}")
            try:
                if on_text:
                    usage: dict = {}
                    text, calls, native, tokens = _read_stream(resp, gemini, on_text, cancel, usage)
                    if vertex:
                        aip_vertex.record(model, usage or None)
                else:
                    payload = resp.json()
                    if gemini:
                        cand = payload["candidates"][0]
                        text, calls, native = _gemini_turn((cand.get("content") or {}).get("parts") or [])
                        tokens = (payload.get("usageMetadata") or {}).get("totalTokenCount") or 0
                    else:
                        msg = payload["choices"][0]["message"]
                        text = msg.get("content") or ""
                        calls = []
                        for tc in msg.get("tool_calls") or []:
                            args, raw = _openai_args((tc.get("function") or {}).get("arguments"))
                            calls.append({"provider_id": tc.get("id"), "name": str((tc.get("function") or {}).get("name") or ""), "args": args, "raw_args": raw})
                        native = {"role": "assistant", "content": msg.get("content"), **({"tool_calls": msg["tool_calls"]} if msg.get("tool_calls") else {}),
                                  **({"reasoning_details": msg["reasoning_details"]} if msg.get("reasoning_details") else {})}
                        tokens = (payload.get("usage") or {}).get("total_tokens") or 0
                if vertex:
                    # gpt-oss can leak its raw tool-call tokens into the text: a structured call, or ask again (aip/vertex.py)
                    repaired = aip_vertex.repair_harmony(text, calls, bool(tools) and tool_choice != "none")
                    if repaired != (text, calls):
                        text, calls = repaired
                        native = {"role": "assistant", "content": text or None}
                        if calls:
                            native["tool_calls"] = [{"id": c["provider_id"], "type": "function", "function": {"name": c["name"], "arguments": c["raw_args"]}}
                                                    for c in calls]
            except StreamCancelled:
                raise
            except (KeyError, IndexError, ValueError, requests.RequestException) as e:
                if cancel is not None and cancel.is_set():
                    raise StreamCancelled() from None
                error = f"unreadable answer ({e!r})"
                continue
        finally:
            resp.close()
        _note_usage(model, "succeeded", tokens)
        out_calls = []
        for i, t in enumerate(calls):
            cid = t.get("provider_id") or f"call-{_call_id()}-{i + 1}"
            out_calls.append({**t, "id": cid})
        if not gemini and native.get("tool_calls"):
            # the ids we send back must be the ones in the assistant turn
            for tc, oc in zip(native["tool_calls"], out_calls):
                tc["id"] = oc["id"]
                tc.setdefault("type", "function")
        message = {"role": "assistant", "text": text, "tool_calls": out_calls, "native": {"gemini" if gemini else "openai": native}}
        return {"text": text.strip(), "tool_calls": out_calls, "message": message}
    raise RuntimeError(f"{model} failed after {ATTEMPTS} attempts: {error}")


def _call_id() -> str:
    import uuid

    return uuid.uuid4().hex[:8]


def _read_stream(resp: Any, gemini: bool, on_text: Callable[[str], None], cancel: Optional[threading.Event],
                 usage: Optional[dict] = None) -> tuple[str, list[dict], dict, int]:
    """A streamed turn (server-sent events) → text, tool calls, the turn to send back and the tokens used. `usage`
    (OpenAI-compatible streams) receives the usage the last event reports."""
    parts: list[dict] = []
    text: list[str] = []
    tokens = 0
    oa_calls: dict[int, dict] = {}
    reasoning: list = []
    last = [0.0]
    for raw in resp.iter_lines():
        if cancel is not None and cancel.is_set():
            raise StreamCancelled()
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            ev = json.loads(data)
        except ValueError:
            continue
        piece = ""
        if gemini:
            cand = (ev.get("candidates") or [{}])[0]
            for p in (cand.get("content") or {}).get("parts") or []:
                parts.append(p)
                if "text" in p and not p.get("thought"):
                    piece += p.get("text") or ""
            tokens = (ev.get("usageMetadata") or {}).get("totalTokenCount") or tokens
        else:
            if ev.get("error"):
                raise ValueError(str(ev["error"])[:300])
            delta = ((ev.get("choices") or [{}])[0]).get("delta") or {}
            piece = delta.get("content") or ""
            for tc in delta.get("tool_calls") or []:
                cur = oa_calls.setdefault(int(tc.get("index") or 0), {"id": None, "name": "", "arguments": ""})
                cur["id"] = tc.get("id") or cur["id"]
                fn = tc.get("function") or {}
                cur["name"] += fn.get("name") or ""
                cur["arguments"] += fn.get("arguments") or ""
            reasoning += delta.get("reasoning_details") or []
            tokens = (ev.get("usage") or {}).get("total_tokens") or tokens
            if usage is not None and ev.get("usage"):
                usage.update(ev["usage"])
        if piece:
            text.append(piece)
            now = time.monotonic()
            if now - last[0] >= 0.05:
                last[0] = now
                on_text("".join(text))
    on_text("".join(text))
    if gemini:
        joined, calls, native = _gemini_turn(parts)
        return joined, calls, native, tokens
    calls = []
    for i in sorted(oa_calls):
        c = oa_calls[i]
        args, rawargs = _openai_args(c["arguments"])
        calls.append({"provider_id": c["id"], "name": c["name"], "args": args, "raw_args": rawargs})
    joined = "".join(text)
    native = {"role": "assistant", "content": joined or None}
    if calls:
        native["tool_calls"] = [{"id": c["provider_id"], "type": "function", "function": {"name": c["name"], "arguments": c["raw_args"]}} for c in calls]
    if reasoning:
        native["reasoning_details"] = reasoning
    return joined, calls, native, tokens


class LlmCall(BaseModel):
    key: str
    model: str
    system: str = ""
    prompt: str = ""
    schema_: Optional[dict] = Field(None, alias="schema")
    temperature: float = 0
    max_tokens: int = 1024
    stop: list[str] = []
    image: Optional[str] = None
    # builds without "Skip recomputing rows" ask for a fresh answer (it still refreshes the cache)
    fresh: bool = False

    model_config = {"populate_by_name": True}


class LlmBatch(BaseModel):
    calls: list[LlmCall]


def _run_call(c: LlmCall) -> dict:
    try:
        value = chat(c.model, c.system, c.prompt, c.schema_, c.temperature, max(16, min(c.max_tokens, 16000)), c.stop, c.image)
        if value is not None:
            _cache_put(c.key, value)
        return {"value": value}
    except Exception as e:  # noqa: BLE001 — every failure is reported per row
        return {"error": str(e)[:500]}


@router.post("/ai/llm")
def llm_batch(req: LlmBatch) -> dict:
    """Answers for a batch of rows: cached ones at once, the rest from the model in parallel."""
    if len(req.calls) > MAX_CALLS:
        raise HTTPException(413, f"at most {MAX_CALLS} calls per request")
    cached = _cache_get([c.key for c in req.calls if not c.fresh])
    results: dict[str, dict] = {k: {"value": v} for k, v in cached.items()}
    todo = [c for c in req.calls if c.key not in results]
    for c, r in zip(todo, _pool.map(_run_call, todo)):
        results[c.key] = r
    return {"results": results, "cached": len(cached), "computed": len(todo)}


@router.post("/ai/llm/trial")
def llm_trial(c: LlmCall) -> dict:
    """One trial run of a Use LLM board, with the raw prompt and answers (never cached)."""
    trace: dict = {}
    try:
        value = chat(c.model, c.system, c.prompt, c.schema_, c.temperature, max(16, min(c.max_tokens, 16000)), c.stop, c.image, trace)
        return {"value": value, "trace": trace}
    except Exception as e:  # noqa: BLE001
        trace.setdefault("final", "")
        return {"error": str(e)[:500], "trace": trace}


class TextRequest(BaseModel):
    system: str = ""
    prompt: str
    model: Optional[str] = None
    schema_: Optional[dict] = Field(None, alias="schema")
    temperature: float = 0.2
    max_tokens: int = 4000

    model_config = {"populate_by_name": True}


@router.post("/ai/text")
def ai_text(req: TextRequest) -> dict:
    """One free call for the AI helpers (explain, generate a node, regex, notional data, LLM-as-a-judge)."""
    try:
        # the AI helpers and AIP Assist of every app: the platform's identity first
        value = chat(req.model or DEFAULT_TEXT_MODEL, with_platform(req.system), req.prompt, req.schema_, req.temperature, req.max_tokens)
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from e
    return {"value": value}


# ------------------------------------------------------------------------------------------------
# registered REST models
# ------------------------------------------------------------------------------------------------


class ModelCall(BaseModel):
    key: str
    url: str
    headers: dict[str, str] = {}
    features: dict[str, Any]


class ModelBatch(BaseModel):
    calls: list[ModelCall]


def _run_model(c: ModelCall) -> dict:
    if not c.url.startswith(("http://", "https://")):
        return {"error": "the model URL must be http(s)"}
    try:
        r = requests.post(c.url, json={"features": c.features}, headers=c.headers, timeout=60)
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}: {r.text[:200]}"}
        body = r.json()
        value = body.get("prediction", body) if isinstance(body, dict) else body
        _cache_put(c.key, value)
        return {"value": value}
    except (requests.RequestException, ValueError) as e:
        return {"error": str(e)[:300]}


@router.post("/ai/models")
def model_batch(req: ModelBatch) -> dict:
    if len(req.calls) > MAX_CALLS:
        raise HTTPException(413, f"at most {MAX_CALLS} calls per request")
    cached = _cache_get([c.key for c in req.calls])
    results: dict[str, dict] = {k: {"value": v} for k, v in cached.items()}
    todo = [c for c in req.calls if c.key not in results]
    for c, r in zip(todo, _pool.map(_run_model, todo)):
        results[c.key] = r
    return {"results": results}


# ------------------------------------------------------------------------------------------------
# media sets: text extraction, metadata and thumbnails
# ------------------------------------------------------------------------------------------------


def _pdf_raw(data: bytes) -> list[str]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return [(p.extract_text() or "").strip() for p in reader.pages]


def _pdf_layout(data: bytes) -> list[dict]:
    """Text boxes with their page and bounding box (x0, y0, x1, y1 from the top-left, in points)."""
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTTextContainer

    out = []
    for page_no, page in enumerate(extract_pages(io.BytesIO(data)), start=1):
        height = page.height
        for el in page:
            if isinstance(el, LTTextContainer):
                text = el.get_text().strip()
                if text:
                    x0, y0, x1, y1 = el.bbox
                    out.append({"page": page_no, "text": text, "bbox": [round(x0, 1), round(height - y1, 1), round(x1, 1), round(height - y0, 1)]})
    return out


def _ocr_image(jpeg: bytes) -> str:
    prompt = "Transcribe all the text in this image in reading order. Keep line breaks. Answer with the text only."
    return chat(OCR_MODEL, "", prompt, None, 0, 4000, None, f"data:image/jpeg;base64,{base64.b64encode(jpeg).decode()}")


def _pages(data: bytes) -> int:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        return len(pdf)
    finally:
        pdf.close()


class MediaCall(BaseModel):
    key: str
    item_id: str
    # raw (text layer), ocr (a vision model reads the pages), layout (text with bounding boxes), metadata,
    # pages (page count), image_text (OCR of an image file), transcribe (speech to text: Whisper, code_media.py)
    method: str
    max_pages: int = 50
    # transcribe: the language (None: detected), "text" / "timestamps" / "segments", more_economical / more_performant
    language: Optional[str] = None
    output: str = "text"
    performance_mode: str = "more_economical"


class MediaBatch(BaseModel):
    calls: list[MediaCall]


def _run_media(c: MediaCall) -> dict:
    try:
        item_id, page, rotate = parse_ref(c.item_id)
        item = drive._item(item_id)
        data = drive.read_bytes(item)
        is_pdf = item["name"].lower().endswith(".pdf") or data[:4] == b"%PDF"
        if c.method == "metadata":
            meta: dict[str, Any] = {"name": item["name"], "size": len(data), "mime": item.get("content_type") or ""}
            if is_pdf:
                meta["pages"] = _pages(data)
            else:
                from PIL import Image

                img = Image.open(io.BytesIO(data))
                meta.update(width=img.width, height=img.height, format=img.format)
            value: Any = meta
        elif c.method == "pages":
            value = _pages(data) if is_pdf else 1
        elif c.method == "transcribe":
            import code_media

            fmt = "segments" if c.output == "segments" else "text"
            value = code_media.transcribe_audio(data, c.language or None, c.performance_mode if c.performance_mode in code_media.WHISPER else "more_economical",
                                                fmt, c.output == "timestamps")
        elif c.method == "layout":
            if not is_pdf:
                raise ValueError("layout-aware extraction needs a PDF")
            value = [b for b in _pdf_layout(data) if page is None or b["page"] == page]
        elif c.method == "ocr":
            if is_pdf:
                pages = [page] if page else range(1, min(_pages(data), c.max_pages) + 1)
                value = PAGE_BREAK.join(_ocr_image(_rotated(_render_pdf_page(data, n), rotate)) for n in pages)
            else:
                value = _ocr_image(_rotated(_to_jpeg(data), rotate))
        else:  # raw
            if not is_pdf:
                raise ValueError("raw text extraction needs a PDF with a text layer — use OCR for images")
            texts = _pdf_raw(data)
            value = texts[page - 1] if page and page <= len(texts) else PAGE_BREAK.join(texts)
        _cache_put(c.key, value)
        return {"value": value}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:400]}


def _to_jpeg(data: bytes) -> bytes:
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    img.thumbnail((2000, 2000))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    return buf.getvalue()


@router.post("/media/extract")
def media_batch(req: MediaBatch) -> dict:
    if len(req.calls) > MAX_CALLS:
        raise HTTPException(413, f"at most {MAX_CALLS} calls per request")
    cached = _cache_get([c.key for c in req.calls])
    results: dict[str, dict] = {k: {"value": v} for k, v in cached.items()}
    todo = [c for c in req.calls if c.key not in results]
    for c, r in zip(todo, _pool.map(_run_media, todo)):
        results[c.key] = r
    return {"results": results}


@router.get("/media/{item_id}/thumbnail")
def thumbnail(item_id: str, page: int = 1, size: int = 360) -> Response:
    """A JPEG preview of a media item: a PDF page or an image, at most `size` pixels."""
    drive._require_db()
    item = drive._item(item_id)
    data = drive.read_bytes(item)
    try:
        if item["name"].lower().endswith(".pdf") or data[:4] == b"%PDF":
            jpeg = _render_pdf_page(data, page, max(64, min(size, 2000)))
        else:
            from PIL import Image

            img = Image.open(io.BytesIO(data))
            img.thumbnail((size, size))
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="JPEG", quality=80)
            jpeg = buf.getvalue()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(415, f"no preview for {item['name']}: {e}") from e
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})
