"""Extraction and Knowledge Graph tabs: turn parsed documents into an ontology-shaped knowledge
graph with an LLM, and merge several extractions into one unified graph.

An extraction runs in three stages, in the background:

1. schema  -- the model designs a compact OWL-style ontology for the document (classes with a
              hierarchy, object properties with domain and range), or the schema of an earlier
              extraction is reused so that graphs built from several documents line up;
2. extract -- the text is cut into windows of ~WINDOW_CHARS characters and each window is read
              for entities and relations, constrained to the schema (class and property names are
              JSON-schema enums), every relation carrying a verbatim evidence quote and page;
3. merge   -- mentions are folded into nodes by normalised name and alias, then (optionally) the
              model groups remaining duplicates (spelling variants, abbreviations, transliterations).

A knowledge graph is a named set of extractions merged with the same folding (and optional AI
pass); its nodes and evidence keep which extraction they came from. Changing the set rebuilds it.

Records and graphs are JSON files under data/kg/. The graph payload follows the shape of the
ai-muhammadiyah knowledge-graph explorer: meta, kinds, predicates, classes, properties, nodes,
links, stats. GET .../graph?format=ttl exports it as Turtle.

Mounted by server.py under /api/kg.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import random
import re
import tempfile
import threading
import time
import unicodedata
import uuid
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Optional

import requests
from fastapi import APIRouter, HTTPException

from aip import models as aip_models
from aip import vertex as aip_vertex
from fastapi.responses import Response
from pydantic import BaseModel, Field

import drive
from unstructured.staging.base import elements_from_dicts, elements_to_md

log = logging.getLogger("bluesandai.knowledge")

router = APIRouter(prefix="/api/kg")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# The models offered in the UI. `cost` is a relative hint only; prices stay server-side. The open-weight models run on
# Vertex AI (aip/vertex.py) behind the platform's spend guard; the default is the cheapest that follows the schema.
MODELS: dict[str, dict[str, Any]] = {
    aip_models.GPT_OSS: {
        "provider": "vertex",
        "label": "gpt-oss-120b (open, Vertex AI)",
        "vendor": "OpenAI · open weights",
        "description": "Open model, lowest cost, follows the schema well. The default for large books.",
        "cost": "low",
    },
    aip_models.DEEPSEEK: {
        "provider": "vertex",
        "label": "DeepSeek V4.1 Flash (open, Vertex AI)",
        "vendor": "DeepSeek · open weights",
        "description": "Open model, fast on long windows and strong in Indonesian.",
        "cost": "low",
    },
    "gemini-3.5-flash": {
        "provider": "gemini",
        "label": "Gemini 3.5 Flash",
        "vendor": "Google",
        "description": "Fast and strong on multilingual text. A good default.",
        "cost": "medium",
    },
    "anthropic/claude-sonnet-5.5": {
        "provider": "openrouter",
        "label": "Claude Sonnet 5.5",
        "vendor": "Anthropic",
        "description": "Highest quality: precise entities, careful relations and evidence.",
        "cost": "high",
    },
    "deepseek/deepseek-v4-pro-0813": {
        "provider": "openrouter",
        "label": "DeepSeek V4 Pro",
        "vendor": "DeepSeek",
        "description": "Strong reasoning at a moderate price.",
        "cost": "medium",
    },
    "openai/gpt-6-luna": {
        "provider": "openrouter",
        "label": "GPT-6 Luna",
        "vendor": "OpenAI",
        "description": "Fast and inexpensive, follows the schema well.",
        "cost": "low",
        # no provider serves it with a temperature under require_parameters
        "params": {},
    },
    "qwen/qwen3.8-flash": {
        "provider": "openrouter",
        "label": "Qwen 3.8 Flash",
        "vendor": "Alibaba",
        "description": "Lowest cost, for very large books.",
        "cost": "low",
        # its long reasoning makes a call ~10x slower without improving the extraction
        "params": {"temperature": 0, "reasoning": {"enabled": False}},
    },
}
DEFAULT_MODEL = aip_models.GPT_OSS

WINDOW_CHARS = 12000  # text per extraction call
WINDOW_PARALLEL = 6  # extraction calls in flight per extraction
SCHEMA_SAMPLE_CHARS = 30000  # text the schema is designed from (spread over the document)
RESOLVE_BATCH = 250  # entities per AI de-duplication call
MAX_ATTEMPTS = 4
REQUEST_TIMEOUT = 300
RETRYABLE_STATUS = {408, 500, 502, 504}
RATE_LIMIT_STATUS = {429, 503}  # waited out (up to RATE_LIMIT_WAIT) instead of counted as failures
RATE_LIMIT_WAIT = 300  # seconds one call keeps waiting out a provider's rate limit
_cooldown: dict[str, float] = {}  # model -> time before which no call to it starts (shared by all threads)
MAX_EVIDENCE = 5

PALETTE = [
    "#3d8bfd", "#e2b866", "#34c38f", "#f0616d", "#a78bfa", "#2dd4bf", "#f0a843", "#f472b6",
    "#60a5fa", "#a3e635", "#fb923c", "#c084fc", "#22d3ee", "#facc15", "#4ade80", "#e879f9",
    "#94a3b8", "#fca5a5", "#86efac", "#93c5fd",
]

_env: Callable[[str], str] = lambda key: ""
_job_source: Callable[[str], tuple[str, list[dict]]] = lambda job_id: ("", [])
_job_name: Callable[[str], str] = lambda job_id: ""
EXTRACTIONS: Path = Path()
GRAPHS: Path = Path()
_lock = threading.Lock()
_runner = ThreadPoolExecutor(max_workers=3, thread_name_prefix="kg")
_stopping: set[str] = set()  # running extractions and graph builds asked to stop


class Stopped(Exception):
    """The user stopped the extraction."""


class Truncated(RuntimeError):
    """The model hit its output limit; the answer is cut off (retrying the same input won't help)."""


def configure(
    data_dir: Path,
    env: Callable[[str], str],
    job_name: Callable[[str], str],
    job_source: Callable[[str], tuple[str, list[dict]]],
) -> None:
    """`job_name(job_id)` checks a parse job is completed and returns its file name;
    `job_source(job_id)` returns that name and the job's parse-result elements."""
    global _env, _job_name, _job_source, EXTRACTIONS, GRAPHS
    _env, _job_name, _job_source = env, job_name, job_source
    EXTRACTIONS = data_dir / "kg" / "extractions"
    GRAPHS = data_dir / "kg" / "graphs"
    EXTRACTIONS.mkdir(parents=True, exist_ok=True)
    GRAPHS.mkdir(parents=True, exist_ok=True)


def resume() -> None:
    """Continue work interrupted by an API restart (saved parts are reused)."""
    for rec in _records(EXTRACTIONS):
        if rec["stage"] == "stopping":
            _save(EXTRACTIONS, rec["id"], status="cancelled", stage="cancelled", finished_at=_now())
        elif rec["status"] in ("queued", "running"):
            _save(EXTRACTIONS, rec["id"], status="queued", stage="queued", windows_done=0)
            _runner.submit(_run_extraction, rec["id"])
    for rec in _records(GRAPHS):
        if rec["stage"] == "stopping":
            _save(GRAPHS, rec["id"], status="cancelled", stage="cancelled", finished_at=_now())
        elif rec["status"] in ("queued", "running"):
            _save(GRAPHS, rec["id"], status="queued")
            _runner.submit(_build_graph, rec["id"])


# ------------------------------------------------------------------------------------------------
# records
# ------------------------------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write(path: Path, data: Any) -> None:
    """Atomic write. On Windows the final rename fails with "Access is denied" while any process
    (the UI polling records, the web app's usage route) has the file open, so it is retried."""
    tmp = path.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for attempt in range(50):  # up to ~5 s
        try:
            tmp.replace(path)
            return
        except PermissionError:
            if attempt == 49:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.1)


def _load(folder: Path, rec_id: str) -> dict:
    if not re.fullmatch(r"[a-z]+-[0-9a-f]{12}", rec_id):
        raise HTTPException(404, "not found")
    path = folder / f"{rec_id}.json"
    if not path.is_file():
        raise HTTPException(404, "not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _save(folder: Path, rec_id: str, **changes: Any) -> dict:
    with _lock:
        rec = _load(folder, rec_id)
        rec.update(changes)
        _write(folder / f"{rec_id}.json", rec)
        return rec


def _records(folder: Path) -> list[dict]:
    out = []
    for p in folder.glob("*.json"):
        if p.name.endswith(".graph.json"):
            continue
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            log.warning("unreadable record %s", p)
    return sorted(out, key=lambda r: r["created_at"], reverse=True)


def _graph_path(folder: Path, rec_id: str) -> Path:
    return folder / f"{rec_id}.graph.json"


def _public(rec: dict) -> dict:
    """What the client sees: no token usage or internal error text."""
    return {k: v for k, v in rec.items() if k not in ("usage", "error_internal")}


# Checkpoints: every LLM result (ontology, each window, each de-duplication batch) is saved in
# <record>.parts/ under a hash of its model, prompt and text as soon as it returns. Continuing a
# stopped, failed or interrupted run re-runs it: saved results load instantly and only the missing
# calls go to the model. Changed input hashes differently, so a stale result is never reused.


def _parts(folder: Path, rec_id: str) -> Path:
    return folder / f"{rec_id}.parts"


def _digest(*parts: str) -> str:
    return hashlib.sha1("\u0000".join(parts).encode("utf-8")).hexdigest()[:20]


def _cached(parts: Optional[Path], key: str, compute: Callable[[], Any]) -> Any:
    if parts is None:
        return compute()
    path = parts / f"{key}.json"
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            pass  # cut off by a crash mid-write: compute again
    value = compute()
    parts.mkdir(parents=True, exist_ok=True)
    _write(path, value)
    return value


def _markdown_path(rec_id: str) -> Path:
    return EXTRACTIONS / f"{rec_id}.source.md"


def _drop_parts(folder: Path, rec_id: str) -> None:
    shutil.rmtree(_parts(folder, rec_id), ignore_errors=True)


# ------------------------------------------------------------------------------------------------
# LLM calls
# ------------------------------------------------------------------------------------------------


def _gemini_schema(schema: Any) -> Any:
    """Standard JSON Schema -> the OpenAPI subset Gemini's responseSchema takes."""
    if isinstance(schema, dict):
        out = {}
        for k, v in schema.items():
            if k == "additionalProperties":
                continue
            out[k] = v.upper() if k == "type" and isinstance(v, str) else _gemini_schema(v)
        return out
    if isinstance(schema, list):
        return [_gemini_schema(v) for v in schema]
    return schema


def _call_llm(
    model: str,
    system: str,
    user: str,
    schema: dict,
    name: str,
    usage: dict,
    stop: Optional[Callable[[], bool]] = None,
) -> dict:
    """One structured-output call; retries transient failures and unreadable answers. Raises
    Truncated when the answer hit the output limit, Stopped when `stop()` turns true."""
    spec = MODELS[model]
    if spec["provider"] == "gemini":
        key = _env("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set in .env.local")
        url, headers = GEMINI_URL.format(model=model), {"x-goog-api-key": key}
        body: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": _gemini_schema(schema),
                "thinkingConfig": {"thinkingLevel": "low"},
                "maxOutputTokens": 32768,
                "temperature": 0,
            },
        }
    elif spec["provider"] == "vertex":
        url, headers = aip_vertex.endpoint(), {}
        body = {
            "model": aip_models.publisher_model(model),
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}},
            "max_tokens": 16000,
            "temperature": 0,
        }
    else:
        key = _env("OPENROUTER_API_KEY")
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY is not set in .env.local")
        url, headers = OPENROUTER_URL, {"Authorization": f"Bearer {key}"}
        body = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}},
            "provider": {"require_parameters": True},
            # a window's graph is ~5-10k tokens; an answer past this is runaway output, better split
            "max_tokens": 16000,
            **spec.get("params", {"temperature": 0}),
        }

    error = ""
    attempt = 0  # failures other than rate limits
    limited = 0  # rate-limit answers in a row
    give_up = time.time() + RATE_LIMIT_WAIT
    while True:
        if stop and stop():
            raise Stopped()
        _pause(_cooldown.get(model, 0.0) - time.time(), stop)  # another call hit a rate limit
        if attempt:
            _pause(2 ** (attempt + 1), stop)
        try:
            resp = aip_vertex.post(model, body, REQUEST_TIMEOUT) if spec["provider"] == "vertex"                 else requests.post(url, headers=headers, json=body, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as e:
            error = repr(e)
            attempt += 1
            if attempt >= MAX_ATTEMPTS:
                break
            continue
        if resp.status_code in RATE_LIMIT_STATUS:
            error = f"HTTP {resp.status_code}: {resp.text[:300]}"
            if time.time() >= give_up:
                raise RuntimeError(
                    f"{spec['label']} is rate-limited by its provider (waited {RATE_LIMIT_WAIT // 60} min). "
                    f"Continue later or pick another model. {error}"
                )
            # back off every call to this model together, as long as the provider asks
            try:
                wait = float(resp.headers.get("Retry-After") or 0)
            except ValueError:
                wait = 0
            wait = max(wait, min(60.0, 5.0 * 2**limited)) + random.uniform(0, 3)
            limited += 1
            with _lock:
                _cooldown[model] = max(_cooldown.get(model, 0.0), time.time() + wait)
            continue
        limited = 0
        if resp.status_code in RETRYABLE_STATUS:
            error = f"HTTP {resp.status_code}: {resp.text[:300]}"
            attempt += 1
            if attempt >= MAX_ATTEMPTS:
                break
            continue
        if resp.status_code != 200:
            raise RuntimeError(f"{spec['label']} HTTP {resp.status_code}: {resp.text[:500]}")
        try:
            payload = resp.json()
            if spec["provider"] == "gemini":
                meta = payload.get("usageMetadata", {})
                _add_usage(usage, meta.get("promptTokenCount", 0),
                           meta.get("candidatesTokenCount", 0) + meta.get("thoughtsTokenCount", 0))
                if payload["candidates"][0].get("finishReason") == "MAX_TOKENS":
                    raise Truncated(f"{spec['label']} answer hit the output limit")
                text = "".join(p.get("text", "") for p in payload["candidates"][0]["content"]["parts"])
            else:
                meta = payload.get("usage", {})
                _add_usage(usage, meta.get("prompt_tokens", 0), meta.get("completion_tokens", 0), meta.get("cost", 0.0))
                if payload["choices"][0].get("finish_reason") == "length":
                    raise Truncated(f"{spec['label']} answer hit the output limit")
                text = payload["choices"][0]["message"]["content"]
            if not text:
                raise ValueError("empty answer")
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
            return json.loads(text)
        except (KeyError, IndexError, TypeError, ValueError) as e:
            error = f"unreadable answer ({e!r}): {resp.text[:300]}"
            attempt += 1
            if attempt >= MAX_ATTEMPTS:
                break
    raise RuntimeError(f"{spec['label']} failed after {MAX_ATTEMPTS} attempts: {error}")


def _pause(seconds: float, stop: Optional[Callable[[], bool]]) -> None:
    """Sleep, waking every second to honour a stop."""
    end = time.time() + seconds
    while (left := end - time.time()) > 0:
        if stop and stop():
            raise Stopped()
        time.sleep(min(1.0, left))


def _add_usage(usage: dict, tokens_in: int, tokens_out: int, cost: float = 0.0) -> None:
    with _lock:
        usage["calls"] = usage.get("calls", 0) + 1
        usage["input_tokens"] = usage.get("input_tokens", 0) + int(tokens_in or 0)
        usage["output_tokens"] = usage.get("output_tokens", 0) + int(tokens_out or 0)
        usage["openrouter_cost"] = usage.get("openrouter_cost", 0.0) + float(cost or 0.0)


# ------------------------------------------------------------------------------------------------
# prompts and response schemas
# ------------------------------------------------------------------------------------------------

SCHEMA_PROMPT = """You are an ontology engineer. From the document excerpts, design a compact OWL-style
ontology that captures the knowledge in this kind of document, to be filled by extracting entities
and relations from the full text.

Rules:
- 6 to 25 classes. Identifiers in UpperCamelCase ASCII, singular (e.g. Person, LegalRuling).
  Use a hierarchy where it helps: `parent` is another class identifier from your list, or "".
- 8 to 35 object properties. Identifiers in lowerCamelCase ASCII, read as "<domain> <property>
  <range>" (e.g. authoredBy, citesVerse, partOf). Domain and range must be class identifiers
  from your list. Prefer specific, meaningful relations over generic "relatedTo".
- `label` is the human name in the document's main language; `description` one sentence in
  that language saying what belongs in the class / what the relation means.
- Identifiers may follow the document's language (e.g. Indonesian Masalah, hasHukum) when that
  is clearer for the domain; follow the user's instructions on this if given.
- Model what the document is ABOUT (people, works, concepts, rulings, places, events, evidence,
  ...), not its layout (no Page, Chapter-heading, Paragraph classes unless the structure itself
  is knowledge, as in a book of chapters of hadith).
- title: a short name for the ontology; domain: one sentence on the subject area."""

EXTRACT_PROMPT = """You extract a knowledge graph from a document, conforming to the ontology given.

Entities:
- name: the canonical, complete name as written in the text (expand an abbreviation if the text
  defines it). The same thing must always get the same name.
- type: one class identifier from the ontology (the most specific that fits).
- description: one sentence, grounded in this text, in the text's language.
- aliases: other names of it in the text (abbreviations, transliterations, Arabic or
  other-script forms, alternate spellings). Only names that identify this entity on their own,
  never generic words or descriptions ("the system", "device", "crab", "the author"). [] if none.
- attributes: literal facts stated in the text (dates, numbers, codes, titles) as key/value. [] if none.
- page: the page number (from the [page N] markers) where it is first mentioned; 0 if unknown.

Relations:
- source and target: entity names exactly as in your entities list (every endpoint must be listed).
- predicate: one property identifier from the ontology; respect its domain and range.
- evidence: a short verbatim quote (at most 200 characters) from the text that states it.
- page: the page of the evidence; 0 if unknown.

Extract only what the text states, never outside knowledge. Skip page furniture, the document's
own headings as such, and generic words that are not real things. Be thorough: every meaningful
entity and every relation the text supports."""

RESOLVE_PROMPT = """You de-duplicate entities of a knowledge graph. Group the ids that refer to the
same real-world thing: spelling variants, abbreviations, transliterations, translations, with or
without honorifics or titles. Only group when you are confident they are the same thing; distinct
things with similar names stay apart. Return only groups of two or more ids. Return {"groups": []}
if there are no duplicates."""

SCHEMA_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "domain": {"type": "string"},
        "classes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "label": {"type": "string"},
                    "parent": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["id", "label", "parent", "description"],
                "additionalProperties": False,
            },
        },
        "properties": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "label": {"type": "string"},
                    "domain": {"type": "string"},
                    "range": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["id", "label", "domain", "range", "description"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "domain", "classes", "properties"],
    "additionalProperties": False,
}


def _extract_schema(classes: list[str], properties: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "entities": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "type": {"type": "string", "enum": classes},
                        "description": {"type": "string"},
                        "aliases": {"type": "array", "items": {"type": "string"}},
                        "attributes": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {"key": {"type": "string"}, "value": {"type": "string"}},
                                "required": ["key", "value"],
                                "additionalProperties": False,
                            },
                        },
                        "page": {"type": "integer"},
                    },
                    "required": ["name", "type", "description", "aliases", "attributes", "page"],
                    "additionalProperties": False,
                },
            },
            "relations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string"},
                        "predicate": {"type": "string", "enum": properties},
                        "target": {"type": "string"},
                        "evidence": {"type": "string"},
                        "page": {"type": "integer"},
                    },
                    "required": ["source", "predicate", "target", "evidence", "page"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["entities", "relations"],
        "additionalProperties": False,
    }


RESOLVE_SCHEMA = {
    "type": "object",
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"ids": {"type": "array", "items": {"type": "string"}}},
                "required": ["ids"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["groups"],
    "additionalProperties": False,
}


# ------------------------------------------------------------------------------------------------
# source text
# ------------------------------------------------------------------------------------------------


# The model reads Markdown, not JSON: structure (headings, lists, tables) survives and no tokens go
# to keys and quoting. Every source is turned into Markdown pages ({text, page_numbers}) first.

FURNITURE = {"Header", "Footer", "PageNumber", "PageBreak"}  # left out, as in RAG chunking


def _is_elements(data: Any) -> bool:
    return isinstance(data, list) and bool(data) and all(isinstance(x, dict) and "type" in x and "metadata" in x for x in data)


def _is_chunks(data: Any) -> bool:
    return isinstance(data, list) and bool(data) and all(isinstance(x, dict) and "text" in x for x in data)


def _elements_markdown(elements: list[dict]) -> list[dict]:
    """Parse-result elements -> one Markdown page per page, rendered exactly like a job's result.md
    (elements_to_md), so the [page N] markers can still be given to the model."""
    pages: dict[int, list[dict]] = {}
    for e in elements:
        if e.get("type") in FURNITURE:
            continue
        pages.setdefault((e.get("metadata") or {}).get("page_number") or 0, []).append(e)
    out = []
    for p, els in pages.items():
        md = elements_to_md(elements_from_dicts(els), exclude_binary_image_data=True, rtl_aware=True).strip()
        if md:
            out.append({"text": md, "page_numbers": [p] if p else []})
    return out


def _scalar(v: Any) -> str:
    return "" if v is None else str(v).replace("\n", " ").strip()


def _json_markdown(data: Any, title: str = "", depth: int = 1) -> str:
    """Any JSON -> readable Markdown: objects as headed sections with **key:** value lines, lists of
    flat records as tables, other lists as bullets."""
    head = f"{'#' * min(depth, 6)} {title}\n\n" if title else ""
    if isinstance(data, dict):
        lines, sections = [], []
        for k, v in data.items():
            if isinstance(v, (dict, list)) and v:
                sections.append(_json_markdown(v, str(k), depth + 1))
            elif _scalar(v):
                lines.append(f"- **{k}:** {_scalar(v)}")
        return head + "\n".join(lines) + ("\n\n" if lines else "") + "\n\n".join(sections)
    if isinstance(data, list):
        if all(not isinstance(v, (dict, list)) for v in data):
            return head + "\n".join(f"- {_scalar(v)}" for v in data if _scalar(v))
        flat = all(isinstance(v, dict) and all(not isinstance(x, (dict, list)) for x in v.values()) for v in data)
        cols = list(dict.fromkeys(k for v in data if isinstance(v, dict) for k in v))
        if flat and 0 < len(cols) <= 10:
            cell = lambda v: _scalar(v).replace("|", "\\|")[:300]  # noqa: E731
            rows = [f"| {' | '.join(cols)} |", f"|{'---|' * len(cols)}"]
            rows += [f"| {' | '.join(cell(v.get(c)) for c in cols)} |" for v in data]
            return head + "\n".join(rows)
        parts = []
        for i, v in enumerate(data, 1):
            name = next((_scalar(v[k]) for k in ("title", "name", "label", "id") if isinstance(v, dict) and _scalar(v.get(k))), "")
            parts.append(_json_markdown(v, name or f"{title or 'Item'} {i}", depth + 1))
        return head + "\n\n".join(parts)
    return head + _scalar(data)


def _source_markdown(source: dict) -> tuple[str, list[dict], str]:
    """(name, Markdown pages, how the source was converted) of a parse job or a Files-tab file."""
    if source["type"] == "job":
        name, elements = _job_source(source["id"])
        return name, _elements_markdown(elements), "Parse result JSON → Markdown"
    item = drive.get_file(source["id"])
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "source"
        drive.copy_content(item, path)
        raw = path.read_text(encoding="utf-8", errors="replace")
    name = item["name"]
    if not name.lower().endswith(".json"):
        kind = "Markdown" if name.lower().endswith(".md") else "Text"
        return name, [{"text": raw, "page_numbers": []}], kind
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise HTTPException(400, f"{name} is not valid JSON") from e
    inner = data.get("elements") or data.get("chunks") if isinstance(data, dict) else data
    if _is_elements(inner):
        return name, _elements_markdown(inner), "Parse result JSON → Markdown"
    if _is_chunks(inner):  # RAG chunks: they carry their own Markdown rendering
        pages = [{"text": c.get("markdown") or c["text"],
                  "page_numbers": c.get("page_numbers") or (c.get("metadata") or {}).get("page_numbers") or []}
                 for c in inner]
        return name, pages, "Chunks JSON → Markdown"
    return name, [{"text": _json_markdown(data, Path(name).stem), "page_numbers": []}], "JSON → Markdown"


def _pieces(text: str) -> list[str]:
    """A page longer than a window, cut at paragraph breaks (a lone huge paragraph hard-cut)."""
    out, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        while len(para) > WINDOW_CHARS:
            if cur:
                out.append(cur)
                cur = ""
            out.append(para[:WINDOW_CHARS])
            para = para[WINDOW_CHARS:]
        if cur and len(cur) + len(para) + 2 > WINDOW_CHARS:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    if cur.strip():
        out.append(cur)
    return out


def _windows(pages: list[dict]) -> list[str]:
    """Pack Markdown pages into windows of about WINDOW_CHARS, with [page N] markers where pages change."""
    windows, parts, size, page = [], [], 0, None
    for pg in pages:
        text = (pg.get("text") or "").strip()
        if not text:
            continue
        nums = pg.get("page_numbers") or []
        for piece in [text] if len(text) <= WINDOW_CHARS else _pieces(text):
            if size and size + len(piece) > WINDOW_CHARS:
                windows.append("\n\n".join(parts))
                parts, size, page = [], 0, None
            if nums and nums[0] != page:
                page = nums[0]
                parts.append(f"[page {page}]")
            parts.append(piece)
            size += len(piece)
    if parts:
        windows.append("\n\n".join(parts))
    return windows


def _sample(windows: list[str]) -> str:
    """Text spread over the whole document, for designing the schema."""
    if sum(len(w) for w in windows) <= SCHEMA_SAMPLE_CHARS:
        return "\n\n".join(windows)
    take = max(1, SCHEMA_SAMPLE_CHARS // WINDOW_CHARS)
    step = len(windows) / take
    picked = [windows[int(i * step)] for i in range(take)]
    per = SCHEMA_SAMPLE_CHARS // len(picked)
    return "\n\n[...]\n\n".join(w[:per] for w in picked)


# ------------------------------------------------------------------------------------------------
# ontology schema
# ------------------------------------------------------------------------------------------------


def _ident(text: str, upper: bool) -> str:
    words = re.findall(r"[A-Za-z0-9]+", unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode())
    if not words:
        return ""
    out = "".join(w[:1].upper() + w[1:] for w in words)
    out = out[:1].upper() + out[1:] if upper else out[:1].lower() + out[1:]
    return out if not out[:1].isdigit() else ("C" if upper else "p") + out


def _clean_schema(raw: dict) -> dict:
    """Valid identifiers, no duplicates, parents and domain/range that exist."""
    classes: dict[str, dict] = {}
    for c in raw.get("classes") or []:
        cid = _ident(c.get("id") or c.get("label") or "", True)
        if cid and cid not in classes:
            classes[cid] = {
                "id": cid,
                "label": (c.get("label") or cid).strip(),
                "parent": _ident(c.get("parent") or "", True),
                "description": (c.get("description") or "").strip(),
            }
    if not classes:
        classes["Thing"] = {"id": "Thing", "label": "Thing", "parent": "", "description": ""}
    for c in classes.values():
        if c["parent"] not in classes or c["parent"] == c["id"]:
            c["parent"] = ""
    props: dict[str, dict] = {}
    for p in raw.get("properties") or []:
        pid = _ident(p.get("id") or p.get("label") or "", False)
        if pid and pid not in props:
            dom, rng = _ident(p.get("domain") or "", True), _ident(p.get("range") or "", True)
            props[pid] = {
                "id": pid,
                "label": (p.get("label") or pid).strip(),
                "domain": dom if dom in classes else "",
                "range": rng if rng in classes else "",
                "description": (p.get("description") or "").strip(),
            }
    if not props:
        props["relatedTo"] = {"id": "relatedTo", "label": "related to", "domain": "", "range": "", "description": ""}
    return {
        "title": (raw.get("title") or "").strip(),
        "domain": (raw.get("domain") or "").strip(),
        "classes": list(classes.values()),
        "properties": list(props.values()),
    }


def _schema_text(schema: dict) -> str:
    lines = [f"Ontology: {schema['title']} -- {schema['domain']}", "", "Classes:"]
    for c in schema["classes"]:
        parent = f" (subclass of {c['parent']})" if c["parent"] else ""
        lines.append(f"- {c['id']}{parent}: {c['label']}. {c['description']}")
    lines += ["", "Properties (domain -> range):"]
    for p in schema["properties"]:
        lines.append(f"- {p['id']} ({p['domain'] or 'any'} -> {p['range'] or 'any'}): {p['description']}")
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------
# folding mentions into a graph
# ------------------------------------------------------------------------------------------------


def _norm(text: str) -> str:
    """Key for matching names: no diacritics, case, punctuation or extra spaces."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[\u2018\u2019\u02bb\u02bc'`\u00b4\"\u201c\u201d]", "", text.casefold())
    return re.sub(r"[\W_]+", " ", text).strip()


def _merges_on(alias: str) -> bool:
    """Whether an alias is specific enough to merge entities on: a name with a capital, digit or
    non-Latin letter, or several words -- not a lone lowercase word like "crab" or "device"."""
    alias = alias.strip()
    if len(_norm(alias)) < 3:
        return False
    return (
        len(alias.split()) >= 2
        or any(ch.isupper() or ch.isdigit() for ch in alias)
        or any(ch.isalpha() and ord(ch) > 0x24F for ch in alias)
    )


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[Any, Any] = {}

    def find(self, x: Any) -> Any:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: Any, b: Any) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _fold(entities: list[dict], relations: list[dict]) -> tuple[list[dict], list[dict], dict[int, int]]:
    """Group entity mentions that share a normalised name or alias.

    entities: {name, type, description, aliases, attributes, pages, from?}
    relations: {source, target (entity mention indexes), predicate, evidence, page, from?}
    Returns (nodes, links, mention index -> node index)."""
    uf = _UnionFind()
    for i, e in enumerate(entities):
        uf.find(("m", i))
        uf.union(("m", i), ("k", _norm(e["name"])))
        for a in e.get("aliases") or []:
            if a.startswith("\u0000") or (_merges_on(a) and _norm(a) != _norm(e["name"])):
                uf.union(("m", i), ("k", _norm(a)))
    groups: dict[Any, list[int]] = defaultdict(list)
    for i in range(len(entities)):
        groups[uf.find(("m", i))].append(i)

    nodes, index = [], {}
    for members in groups.values():
        names = Counter(entities[i]["name"].strip() for i in members)
        # most used name; on a tie, not an identifier-like "CamelCase" form, then the shorter
        label = max(names, key=lambda n: (names[n], not re.fullmatch(r"[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+", n), -len(n)))
        kinds = Counter(entities[i]["type"] for i in members)
        aliases: dict[str, str] = {}
        for i in members:
            for a in [entities[i]["name"], *(entities[i].get("aliases") or [])]:
                a = (a or "").strip()
                if a and _norm(a) != _norm(label):
                    aliases.setdefault(_norm(a), a)
        descriptions = [entities[i].get("description", "").strip() for i in members if entities[i].get("description")]
        facts: dict[tuple[str, str], list[str]] = {}
        for i in members:
            for f in entities[i].get("attributes") or []:
                k, v = (f.get("key") or "").strip(), (f.get("value") or "").strip()
                if k and v:
                    facts.setdefault((k.casefold(), v.casefold()), [k, v])
        pages = sorted({p for i in members for p in entities[i].get("pages") or [] if p})
        sources = list(dict.fromkeys(entities[i]["from"] for i in members if entities[i].get("from")))
        node = {
            "label": label,
            "kind": kinds.most_common(1)[0][0],
            "definition": max(descriptions, key=len)[:600] if descriptions else "",
            "aliases": list(aliases.values())[:20],
            "facts": list(facts.values())[:30],
            "pages": pages,
            "mentions": len(members),
        }
        if sources:
            node["sources"] = sources
        for i in members:
            index[i] = len(nodes)
        nodes.append(node)

    links: dict[tuple[int, str, int], dict] = {}
    for r in relations:
        s, t = index.get(r["source"]), index.get(r["target"])
        if s is None or t is None or s == t:
            continue
        link = links.setdefault((s, r["predicate"], t), {"source": s, "target": t, "predicate": r["predicate"], "evidence": []})
        quote = (r.get("evidence") or "").strip()[:300]
        if quote and len(link["evidence"]) < MAX_EVIDENCE and all(q["quote"] != quote for q in link["evidence"]):
            ev = {"quote": quote, "page": r.get("page") or None}
            if r.get("from"):
                ev["from"] = r["from"]
            link["evidence"].append(ev)
        link["count"] = link.get("count", 0) + 1
    return nodes, list(links.values()), index


def _ai_merge(
    nodes: list[dict],
    links: list[dict],
    model: str,
    usage: dict,
    on_progress: Callable[[int, int], None],
    stop: Optional[Callable[[], bool]] = None,
    parts: Optional[Path] = None,
) -> tuple[list[dict], list[dict]]:
    """Ask the model which nodes (per class) are duplicates, then merge them."""
    by_kind: dict[str, list[int]] = defaultdict(list)
    for i, n in enumerate(nodes):
        by_kind[n["kind"]].append(i)
    batches = []
    for ids in by_kind.values():
        if len(ids) < 2:
            continue
        ids = sorted(ids, key=lambda i: _norm(nodes[i]["label"]))
        batches += [ids[k : k + RESOLVE_BATCH] for k in range(0, len(ids), RESOLVE_BATCH)]
    if not batches:
        return nodes, links

    uf = _UnionFind()
    done = 0

    def resolve(batch: list[int]) -> list[list[int]]:
        lines = []
        for i in batch:
            n = nodes[i]
            extra = f" (also: {', '.join(n['aliases'][:4])})" if n["aliases"] else ""
            lines.append(f"n{i}: {n['label']}{extra} -- {n['definition'][:120]}")
        user = f"Class: {nodes[batch[0]]['kind']}\n\n" + "\n".join(lines)
        data = _cached(parts, "dedupe-" + _digest(model, RESOLVE_PROMPT, user),
                       lambda: _call_llm(model, RESOLVE_PROMPT, user, RESOLVE_SCHEMA, "duplicate_groups", usage, stop))
        allowed = set(batch)
        out = []
        for g in data.get("groups") or []:
            ids = [int(x[1:]) for x in g.get("ids") or [] if re.fullmatch(r"n\d+", str(x)) and int(x[1:]) in allowed]
            if len(set(ids)) >= 2:
                out.append(ids)
        return out

    pool = ThreadPoolExecutor(max_workers=WINDOW_PARALLEL)
    try:
        futures = [pool.submit(resolve, b) for b in batches]
        for f in as_completed(futures):
            if stop and stop():
                raise Stopped()
            try:
                for group in f.result():
                    for i in group[1:]:
                        uf.union(group[0], i)
            except Stopped:
                raise
            except Exception:
                log.exception("de-duplication batch failed; leaving it as is")
            done += 1
            on_progress(done, len(batches))
    finally:
        # on a stop, calls already in flight finish in the background and are discarded
        pool.shutdown(wait=False, cancel_futures=True)

    # Re-fold: each node becomes one mention, duplicate groups share a key.
    entities = []
    for i, n in enumerate(nodes):
        entities.append({
            "name": n["label"],
            "type": n["kind"],
            "description": n["definition"],
            "aliases": n["aliases"] + [f"\u0000kgdupgroup{uf.find(i)}"],
            "attributes": [{"key": k, "value": v} for k, v in n["facts"]],
            "pages": n["pages"],
            "sources": n.get("sources") or [],
            "weight": n["mentions"],
        })
    relations = []
    for link in links:
        for ev in link["evidence"] or [{"quote": "", "page": None}]:
            relations.append({"source": link["source"], "target": link["target"], "predicate": link["predicate"],
                              "evidence": ev["quote"], "page": ev.get("page"), "from": ev.get("from")})
    merged, merged_links, index = _fold(entities, relations)
    # _fold counts mentions; carry the original counts and sources instead
    for node in merged:
        node["aliases"] = [a for a in node["aliases"] if not a.startswith("\u0000")]
    totals: dict[int, int] = defaultdict(int)
    srcs: dict[int, list] = defaultdict(list)
    for i, e in enumerate(entities):
        totals[index[i]] += e["weight"]
        srcs[index[i]] += e["sources"]
    for j, node in enumerate(merged):
        node["mentions"] = totals[j]
        if srcs[j]:
            node["sources"] = list(dict.fromkeys(srcs[j]))
    return merged, merged_links


def _prefixes(class_ids: list[str]) -> dict[str, str]:
    """Three-letter id prefixes per class (Person -> PER), unique."""
    used, out = set(), {}
    for cid in class_ids:
        letters = re.sub(r"[^A-Za-z]", "", cid).upper() or "X"
        consonants = letters[0] + re.sub(r"[AEIOU]", "", letters[1:])
        for cand in (letters[:3], consonants[:3], letters[0] + letters[-2:], letters[:2] + letters[-1:]):
            if len(cand) == 3 and cand not in used:
                break
        else:
            n = 0
            while (cand := f"{letters[:1]}{n:02d}") in used:
                n += 1
        used.add(cand)
        out[cid] = cand
    return out


def _payload(schema: dict, nodes: list[dict], links: list[dict], meta: dict) -> dict:
    """The graph as served: ids assigned, classes and predicates with colours, degree counted."""
    class_ids = [c["id"] for c in schema["classes"]]
    for n in nodes:  # a class the model used that the schema lost (e.g. from an older extraction)
        if n["kind"] not in class_ids:
            class_ids.append(n["kind"])
            schema["classes"].append({"id": n["kind"], "label": n["kind"], "parent": "", "description": ""})
    prop_ids = [p["id"] for p in schema["properties"]]
    for link in links:
        if link["predicate"] not in prop_ids:
            prop_ids.append(link["predicate"])
            schema["properties"].append({"id": link["predicate"], "label": link["predicate"], "domain": "", "range": "", "description": ""})

    degree = Counter()
    for link in links:
        degree[link["source"]] += 1
        degree[link["target"]] += 1
    order = sorted(range(len(nodes)), key=lambda i: (class_ids.index(nodes[i]["kind"]), -degree[i], _norm(nodes[i]["label"])))
    prefix = _prefixes(class_ids)
    counters: Counter = Counter()
    ids: dict[int, str] = {}
    out_nodes = []
    for i in order:
        n = nodes[i]
        counters[n["kind"]] += 1
        nid = f"{prefix[n['kind']]}{counters[n['kind']]:03d}"
        ids[i] = nid
        out_nodes.append({"id": nid, **n, "degree": degree[i]})
    out_links = [
        {**link, "source": ids[link["source"]], "target": ids[link["target"]]}
        for link in sorted(links, key=lambda l: (prop_ids.index(l["predicate"]), ids[l["source"]], ids[l["target"]]))
    ]

    kind_count = Counter(n["kind"] for n in out_nodes)
    pred_count = Counter(l["predicate"] for l in out_links)
    kinds = {
        c["id"]: {"label": c["label"], "color": PALETTE[k % len(PALETTE)], "group": c["parent"],
                  "description": c["description"], "count": kind_count[c["id"]]}
        for k, c in enumerate(schema["classes"])
    }
    predicates = {
        p["id"]: {"label": p["label"], "color": PALETTE[(k + 3) % len(PALETTE)], "desc": p["description"],
                  "domain": p["domain"], "range": p["range"], "count": pred_count[p["id"]]}
        for k, p in enumerate(schema["properties"])
    }
    return {
        "meta": {**meta, "title": schema["title"] or meta.get("title", ""), "domain": schema["domain"], "generatedAt": _now()},
        "kinds": kinds,
        "predicates": predicates,
        "classes": schema["classes"],
        "properties": schema["properties"],
        "nodes": out_nodes,
        "links": out_links,
        "stats": {"nodes": len(out_nodes), "links": len(out_links), "classes": len(kinds), "properties": len(predicates)},
    }


# ------------------------------------------------------------------------------------------------
# extraction worker
# ------------------------------------------------------------------------------------------------


def _split(text: str) -> tuple[str, str]:
    """Two halves of a window, cut at the paragraph break nearest the middle."""
    mid = len(text) // 2
    cut = text.rfind("\n\n", 0, mid)
    if cut < len(text) // 4:
        cut = text.find("\n\n", mid)
    if cut == -1 or cut > len(text) * 3 // 4:
        cut = mid
    return text[:cut], text[cut:]


def _extract_window(model: str, system: str, header: str, text: str, schema: dict, usage: dict,
                    stop: Callable[[], bool], parts: Optional[Path], depth: int = 0) -> dict:
    """Entities and relations of one window. A window whose answer outgrows the output limit is
    read again as two halves (twice at most) rather than retried as is."""
    try:
        return _cached(parts, "window-" + _digest(model, system, header, text),
                       lambda: _call_llm(model, system, f"{header}\n\n{text}", schema, "knowledge_graph", usage, stop))
    except Truncated:
        if depth >= 2 or len(text) < 2000:
            raise
        out: dict = {"entities": [], "relations": []}
        for half in _split(text):
            part = _extract_window(model, system, header, half, schema, usage, stop, parts, depth + 1)
            out["entities"] += part.get("entities") or []
            out["relations"] += part.get("relations") or []
        return out


def _run_extraction(rec_id: str) -> None:
    if _load(EXTRACTIONS, rec_id)["status"] == "cancelled":  # stopped while queued
        return
    rec = _save(EXTRACTIONS, rec_id, status="running", stage="reading", started_at=_now(), error=None)
    usage: dict = dict(rec.get("usage") or {})  # total spent on this record, across stops and continues
    stop = lambda: rec_id in _stopping  # noqa: E731
    parts = _parts(EXTRACTIONS, rec_id)
    try:
        _save(EXTRACTIONS, rec_id, stage="converting")
        name, pages, conversion = _source_markdown(rec["source"])
        windows = _windows(pages)
        if not windows:
            raise ValueError("the document has no text to extract from")
        # the exact Markdown the model reads, for GET /extractions/{id}/markdown
        _markdown_path(rec_id).write_text("\n\n".join(windows), encoding="utf-8")
        _save(EXTRACTIONS, rec_id, windows_total=len(windows), windows_done=0, source_format=conversion,
              markdown_chars=sum(len(w) for w in windows))
        model = rec["model"]
        hint = f"\n\nUser instructions: {rec['instructions']}" if rec.get("instructions") else ""

        if rec.get("schema_from"):
            schema = json.loads(_graph_path(EXTRACTIONS, rec["schema_from"]).read_text(encoding="utf-8"))
            schema = _clean_schema({"title": schema["meta"].get("title"), "domain": schema["meta"].get("domain"),
                                    "classes": schema["classes"], "properties": schema["properties"]})
        else:
            _save(EXTRACTIONS, rec_id, stage="schema")
            user = f"Document: {name}\n\nExcerpts:\n\n{_sample(windows)}"
            raw = _cached(parts, "schema-" + _digest(model, SCHEMA_PROMPT + hint, user),
                          lambda: _call_llm(model, SCHEMA_PROMPT + hint, user, SCHEMA_SCHEMA, "ontology_schema", usage, stop))
            schema = _clean_schema(raw)

        _save(EXTRACTIONS, rec_id, stage="extracting", usage=usage,
              schema_summary={"classes": len(schema["classes"]), "properties": len(schema["properties"])})
        response_schema = _extract_schema([c["id"] for c in schema["classes"]], [p["id"] for p in schema["properties"]])
        system = EXTRACT_PROMPT + hint + "\n\n" + _schema_text(schema)
        results: list[Optional[dict]] = [None] * len(windows)
        failed = 0
        pool = ThreadPoolExecutor(max_workers=WINDOW_PARALLEL)
        try:
            futures = {
                pool.submit(_extract_window, model, system, f"Document: {name} (part {i + 1} of {len(windows)})",
                            w, response_schema, usage, stop, parts): i
                for i, w in enumerate(windows)
            }
            for done, f in enumerate(as_completed(futures), 1):
                if stop():
                    raise Stopped()
                try:
                    results[futures[f]] = f.result()
                except Stopped:
                    raise
                except Exception:
                    failed += 1
                    log.exception("extraction %s: window %d failed", rec_id, futures[f])
                _save(EXTRACTIONS, rec_id, windows_done=done, windows_failed=failed, usage=usage)
        finally:
            # on a stop, calls already in flight finish in the background and are discarded
            pool.shutdown(wait=False, cancel_futures=True)
        if failed == len(windows):
            raise RuntimeError("every extraction call failed")

        _save(EXTRACTIONS, rec_id, stage="merging")
        entities, relations = [], []
        for res in results:
            if not res:
                continue
            local: dict[str, int] = {}
            for e in res.get("entities") or []:
                if not (e.get("name") or "").strip():
                    continue
                local.setdefault(_norm(e["name"]), len(entities))
                for a in e.get("aliases") or []:
                    local.setdefault(_norm(a), len(entities))
                entities.append({**e, "pages": [e.get("page")] if e.get("page") else []})
            for r in res.get("relations") or []:
                s, t = local.get(_norm(r.get("source", ""))), local.get(_norm(r.get("target", "")))
                if s is None or t is None:  # endpoint not listed: add it, typed from the property
                    prop = next((p for p in schema["properties"] if p["id"] == r.get("predicate")), None)
                    for end, cls in (("source", prop and prop["domain"]), ("target", prop and prop["range"])):
                        if local.get(_norm(r.get(end, ""))) is None and (r.get(end) or "").strip() and cls:
                            local[_norm(r[end])] = len(entities)
                            entities.append({"name": r[end], "type": cls, "description": "", "aliases": [], "attributes": [],
                                             "pages": [r.get("page")] if r.get("page") else []})
                    s, t = local.get(_norm(r.get("source", ""))), local.get(_norm(r.get("target", "")))
                if s is not None and t is not None:
                    relations.append({**r, "source": s, "target": t})
        nodes, links, _ = _fold(entities, relations)

        if rec.get("dedupe", True):
            _save(EXTRACTIONS, rec_id, stage="deduplicating", usage=usage)
            nodes, links = _ai_merge(nodes, links, model, usage,
                                     lambda d, t: _save(EXTRACTIONS, rec_id, usage=usage, dedupe_progress=[d, t]), stop, parts)

        meta = {"kind": "extraction", "id": rec_id, "name": rec["name"], "model": model,
                "modelLabel": MODELS[model]["label"], "source": {**rec["source"], "name": name}, "title": name}
        graph = _payload(schema, nodes, links, meta)
        _write(_graph_path(EXTRACTIONS, rec_id), graph)
        _save(EXTRACTIONS, rec_id, status="completed", stage="done", finished_at=_now(), stats=graph["stats"],
              title=graph["meta"]["title"], usage=usage)
        _save_extraction_to_files(rec_id)
    except Stopped:
        log.warning("extraction %s stopped by the user", rec_id)
        _save(EXTRACTIONS, rec_id, status="cancelled", stage="cancelled", finished_at=_now(), usage=usage)
    except Exception as e:
        log.exception("extraction %s failed", rec_id)
        message = e.detail if isinstance(e, HTTPException) else str(e)
        _save(EXTRACTIONS, rec_id, status="failed", stage="failed", finished_at=_now(), usage=usage,
              error=message[:300], error_internal=f"{type(e).__name__}: {e}"[:4000])
    finally:
        _stopping.discard(rec_id)


# ------------------------------------------------------------------------------------------------
# knowledge graph builder
# ------------------------------------------------------------------------------------------------


def _merge_schemas(graphs: list[dict]) -> dict:
    classes: dict[str, dict] = {}
    props: dict[str, dict] = {}
    titles = []
    for g in graphs:
        titles.append(g["meta"].get("title") or "")
        for c in g["classes"]:
            cur = classes.setdefault(c["id"], dict(c))
            if not cur.get("parent") and c.get("parent"):
                cur["parent"] = c["parent"]
        for p in g["properties"]:
            cur = props.setdefault(p["id"], dict(p))
            if not cur.get("domain") and p.get("domain"):
                cur["domain"] = p["domain"]
            if not cur.get("range") and p.get("range"):
                cur["range"] = p["range"]
    return {"title": "", "domain": "; ".join(dict.fromkeys(t for t in titles if t))[:400],
            "classes": list(classes.values()), "properties": list(props.values())}


def _build_graph(rec_id: str) -> None:
    if _load(GRAPHS, rec_id)["status"] == "cancelled":  # stopped while queued
        return
    rec = _save(GRAPHS, rec_id, status="running", stage="merging", started_at=_now(), error=None, progress=None)
    usage: dict = dict(rec.get("usage") or {})
    stop = lambda: rec_id in _stopping  # noqa: E731
    try:
        graphs = []
        for eid in rec["extraction_ids"]:
            path = _graph_path(EXTRACTIONS, eid)
            if path.is_file():
                graphs.append(json.loads(path.read_text(encoding="utf-8")))
        if not graphs:
            raise ValueError("none of the chosen extractions has a finished graph")
        schema = _merge_schemas(graphs)
        entities, relations = [], []
        for g in graphs:
            eid = g["meta"]["id"]
            local = {}
            for n in g["nodes"]:
                local[n["id"]] = len(entities)
                entities.append({"name": n["label"], "type": n["kind"], "description": n.get("definition", ""),
                                 "aliases": n.get("aliases") or [], "pages": [],
                                 "attributes": [{"key": k, "value": v} for k, v in n.get("facts") or []], "from": eid})
            for link in g["links"]:
                for ev in link.get("evidence") or [{"quote": "", "page": None}]:
                    relations.append({"source": local[link["source"]], "target": local[link["target"]],
                                      "predicate": link["predicate"], "evidence": ev.get("quote", ""),
                                      "page": ev.get("page"), "from": eid})
        nodes, links, _ = _fold(entities, relations)
        if rec.get("resolve_model"):
            _save(GRAPHS, rec_id, stage="deduplicating")
            nodes, links = _ai_merge(nodes, links, rec["resolve_model"], usage,
                                     lambda d, t: _save(GRAPHS, rec_id, progress=[d, t], usage=usage), stop,
                                     _parts(GRAPHS, rec_id))
        meta = {"kind": "graph", "id": rec_id, "name": rec["name"], "title": rec["name"],
                "extractions": [{"id": g["meta"]["id"], "name": g["meta"]["name"], "title": g["meta"].get("title", "")} for g in graphs]}
        graph = _payload(schema, nodes, links, meta)
        graph["meta"]["title"] = rec["name"]
        _write(_graph_path(GRAPHS, rec_id), graph)
        _save(GRAPHS, rec_id, status="completed", stage="done", finished_at=_now(), stats=graph["stats"], usage=usage, progress=None)
    except Stopped:
        log.warning("knowledge graph %s stopped by the user", rec_id)
        _save(GRAPHS, rec_id, status="cancelled", stage="cancelled", finished_at=_now(), usage=usage)
    except Exception as e:
        log.exception("knowledge graph %s failed", rec_id)
        _save(GRAPHS, rec_id, status="failed", stage="failed", finished_at=_now(), usage=usage,
              error=str(e)[:300], error_internal=f"{type(e).__name__}: {e}"[:4000])
    finally:
        _stopping.discard(rec_id)


# ------------------------------------------------------------------------------------------------
# Turtle export
# ------------------------------------------------------------------------------------------------


def _ttl_str(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "") + '"'


def _turtle(graph: dict) -> str:
    base = f"urn:bluesandai:kg:{graph['meta']['id']}#"
    out = [
        f"@prefix : <{base}> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .",
        "@prefix prov: <http://www.w3.org/ns/prov#> .",
        "",
        f"<{base[:-1]}> a owl:Ontology ; rdfs:label {_ttl_str(graph['meta'].get('title') or graph['meta'].get('name', ''))}"
        + (f" ; rdfs:comment {_ttl_str(graph['meta']['domain'])}" if graph["meta"].get("domain") else "") + " .",
        "",
        "# classes",
    ]
    for c in graph["classes"]:
        parts = [f":{c['id']} a owl:Class", f"rdfs:label {_ttl_str(c['label'])}"]
        if c.get("parent"):
            parts.append(f"rdfs:subClassOf :{c['parent']}")
        if c.get("description"):
            parts.append(f"rdfs:comment {_ttl_str(c['description'])}")
        out.append(" ;\n    ".join(parts) + " .")
    out += ["", "# object properties"]
    for p in graph["properties"]:
        parts = [f":{p['id']} a owl:ObjectProperty", f"rdfs:label {_ttl_str(p['label'])}"]
        if p.get("domain"):
            parts.append(f"rdfs:domain :{p['domain']}")
        if p.get("range"):
            parts.append(f"rdfs:range :{p['range']}")
        if p.get("description"):
            parts.append(f"rdfs:comment {_ttl_str(p['description'])}")
        out.append(" ;\n    ".join(parts) + " .")
    out += ["", ":fact a owl:DatatypeProperty ; rdfs:label \"fact\" .", "", "# individuals"]
    outgoing: dict[str, list[dict]] = defaultdict(list)
    for link in graph["links"]:
        outgoing[link["source"]].append(link)
    for n in graph["nodes"]:
        parts = [f":{n['id']} a :{n['kind']}", f"rdfs:label {_ttl_str(n['label'])}"]
        parts += [f"skos:altLabel {_ttl_str(a)}" for a in n.get("aliases") or []]
        if n.get("definition"):
            parts.append(f"skos:definition {_ttl_str(n['definition'])}")
        parts += [f":fact {_ttl_str(f'{k}: {v}')}" for k, v in n.get("facts") or []]
        parts += [f"prov:wasDerivedFrom <urn:bluesandai:extraction:{s}>" for s in n.get("sources") or []]
        parts += [f":{l['predicate']} :{l['target']}" for l in outgoing[n["id"]]]
        out.append(" ;\n    ".join(parts) + " .")
    return "\n".join(out) + "\n"


def _graph_body(folder: Path, rec_id: str, fmt: str) -> tuple[str, str]:
    """A finished graph as (body, media type); fmt "json" or "ttl"."""
    path = _graph_path(folder, rec_id)
    if not path.is_file():
        raise HTTPException(404, "the graph is not ready yet")
    if fmt == "ttl":
        return _turtle(json.loads(path.read_text(encoding="utf-8"))), "text/turtle"
    return path.read_text(encoding="utf-8"), "application/json"


def _graph_response(folder: Path, rec_id: str, fmt: str, download: bool) -> Response:
    rec = _load(folder, rec_id)
    body, media = _graph_body(folder, rec_id, fmt)
    filename = re.sub(r"[^\w.-]+", "_", rec["name"]).strip("_") or rec_id
    filename = f"{filename}.ttl" if fmt == "ttl" else f"{filename}.json"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'} if download else {}
    return Response(body, media_type=f"{media}; charset=utf-8", headers=headers)


def _files_name(rec: dict, fmt: str) -> str:
    """Name of an extraction's graph in Files: "<document>.graph.json" / ".graph.ttl"."""
    base = re.sub(r"\.(pdf|png|jpe?g|tiff?|webp|bmp|gif|md|txt|json)$", "", rec["name"], flags=re.I) or rec["id"]
    return f"{base}.graph.{fmt}"


def _save_extraction_to_files(rec_id: str) -> None:
    """Copy a finished extraction's graph (JSON) into My Project / Extracted Document."""
    try:
        body, media = _graph_body(EXTRACTIONS, rec_id, "json")
        drive.save_to_default("extracted", _files_name(_load(EXTRACTIONS, rec_id), "json"), body.encode("utf-8"),
                              f"{media}; charset=utf-8")
    except Exception:
        log.exception("could not copy extraction %s to Files", rec_id)


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


@router.get("/models")
def models() -> list[dict]:
    out = []
    for mid, m in MODELS.items():
        if m["provider"] == "vertex":
            available = aip_models.ready(mid) and aip_vertex._credentials_file().is_file()
        else:
            available = bool(_env("GEMINI_API_KEY" if m["provider"] == "gemini" else "OPENROUTER_API_KEY"))
        out.append({"id": mid, "label": m["label"], "vendor": m["vendor"], "description": m["description"],
                    "cost": m["cost"], "available": available, "default": mid == DEFAULT_MODEL})
    try:
        # registered models: functions implementing the ChatCompletion function interface
        import functions_registry

        out.extend(functions_registry.registered_models())
    except Exception:  # noqa: BLE001 - the functions registry is optional here
        pass
    return out


class Source(BaseModel):
    type: str = Field(pattern="^(job|drive)$")
    id: str


class NewExtraction(BaseModel):
    source: Source
    model: str = DEFAULT_MODEL
    name: Optional[str] = Field(None, max_length=200)
    instructions: Optional[str] = Field(None, max_length=4000)
    schema_from: Optional[str] = None
    dedupe: bool = True


@router.post("/extractions")
def create_extraction(req: NewExtraction) -> dict:
    if req.model not in MODELS:
        raise HTTPException(400, "unknown model")
    if req.schema_from:
        src = _load(EXTRACTIONS, req.schema_from)
        if src["status"] != "completed":
            raise HTTPException(400, "the extraction to reuse the schema from has not finished")
    name = _job_name(req.source.id) if req.source.type == "job" else drive.get_file(req.source.id)["name"]
    rec_id = f"ext-{uuid.uuid4().hex[:12]}"
    rec = {
        "id": rec_id,
        "name": (req.name or "").strip() or name,
        "source": {**req.source.model_dump(), "name": name},
        "model": req.model,
        "model_label": MODELS[req.model]["label"],
        "instructions": (req.instructions or "").strip() or None,
        "schema_from": req.schema_from,
        "dedupe": req.dedupe,
        "status": "queued",
        "stage": "queued",
        "windows_total": 0,
        "windows_done": 0,
        "windows_failed": 0,
        "created_at": _now(),
        "started_at": None,
        "finished_at": None,
        "error": None,
        "stats": None,
    }
    _write(EXTRACTIONS / f"{rec_id}.json", rec)
    _runner.submit(_run_extraction, rec_id)
    return _public(rec)


@router.get("/extractions")
def list_extractions() -> list[dict]:
    return [_public(r) for r in _records(EXTRACTIONS)]


@router.get("/extractions/{rec_id}")
def get_extraction(rec_id: str) -> dict:
    return _public(_load(EXTRACTIONS, rec_id))


@router.get("/extractions/{rec_id}/markdown")
def extraction_markdown(rec_id: str, download: bool = False) -> Response:
    """The Markdown the model read (the source after conversion), with its [page N] markers."""
    rec = _load(EXTRACTIONS, rec_id)
    path = _markdown_path(rec_id)
    if not path.is_file():
        raise HTTPException(404, "the document has not been converted yet")
    filename = (re.sub(r"[^\w.-]+", "_", Path(rec["name"]).stem).strip("_") or rec_id) + ".md"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'} if download else {}
    return Response(path.read_text(encoding="utf-8"), media_type="text/markdown; charset=utf-8", headers=headers)


@router.get("/extractions/{rec_id}/graph")
def extraction_graph(rec_id: str, format: str = "json", download: bool = False) -> Response:
    return _graph_response(EXTRACTIONS, rec_id, format, download)


class SaveToFiles(BaseModel):
    formats: list[Literal["json", "ttl"]] = Field(min_length=1)
    # a Files folder or project id; None is the top level
    parent_id: Optional[str] = None


@router.post("/extractions/{rec_id}/save-to-files")
def save_extraction_to_files(rec_id: str, req: SaveToFiles) -> list[dict]:
    """Copy a finished extraction's graph into a Files folder."""
    rec = _load(EXTRACTIONS, rec_id)
    saved = []
    for fmt in dict.fromkeys(req.formats):
        body, media = _graph_body(EXTRACTIONS, rec_id, fmt)
        saved.append(drive.save_bytes(req.parent_id, _files_name(rec, fmt), body.encode("utf-8"), f"{media}; charset=utf-8"))
    return saved


class Rename(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.patch("/extractions/{rec_id}")
def rename_extraction(rec_id: str, req: Rename) -> dict:
    _load(EXTRACTIONS, rec_id)
    return _public(_save(EXTRACTIONS, rec_id, name=req.name.strip()))


@router.post("/extractions/{rec_id}/continue")
def continue_extraction(rec_id: str) -> dict:
    """Continue a stopped or failed extraction, or retry the parts a finished one could not read:
    finished parts are kept, only the rest is extracted."""
    rec = _load(EXTRACTIONS, rec_id)
    gaps = rec["status"] == "completed" and rec.get("windows_failed", 0) > 0
    if rec["status"] not in ("cancelled", "failed") and not gaps:
        raise HTTPException(409, "only a stopped or failed extraction, or one with failed parts, can be continued")
    rec = _save(EXTRACTIONS, rec_id, status="queued", stage="queued", windows_done=0, windows_failed=0, error=None)
    _runner.submit(_run_extraction, rec_id)
    return _public(rec)


@router.post("/extractions/{rec_id}/rerun")
def rerun_extraction(rec_id: str) -> dict:
    """Run again from scratch: saved parts are discarded (the cost so far stays in the total)."""
    rec = _load(EXTRACTIONS, rec_id)
    if rec["status"] in ("queued", "running"):
        raise HTTPException(409, "the extraction is still running")
    _drop_parts(EXTRACTIONS, rec_id)
    rec = _save(EXTRACTIONS, rec_id, status="queued", stage="queued", windows_done=0, windows_failed=0, error=None)
    _runner.submit(_run_extraction, rec_id)
    return _public(rec)


@router.post("/extractions/{rec_id}/stop")
def stop_extraction(rec_id: str) -> dict:
    """Stop a queued or running extraction. A running one stops after its current calls (no new
    calls start); the tokens already used stay recorded. Run it again with /rerun."""
    rec = _load(EXTRACTIONS, rec_id)
    if rec["status"] == "queued":
        return _public(_save(EXTRACTIONS, rec_id, status="cancelled", stage="cancelled", finished_at=_now()))
    if rec["status"] != "running":
        raise HTTPException(409, "the extraction is not running")
    _stopping.add(rec_id)
    return _public(_save(EXTRACTIONS, rec_id, stage="stopping"))


@router.delete("/extractions/{rec_id}")
def delete_extraction(rec_id: str) -> dict:
    rec = _load(EXTRACTIONS, rec_id)
    if rec["status"] in ("queued", "running"):
        raise HTTPException(409, "wait for the extraction to finish before deleting it")
    used = [g["name"] for g in _records(GRAPHS) if rec_id in g["extraction_ids"]]
    if used:
        raise HTTPException(409, f"used by the knowledge graph {', '.join(used)}; remove it there first")
    (EXTRACTIONS / f"{rec_id}.json").unlink(missing_ok=True)
    _graph_path(EXTRACTIONS, rec_id).unlink(missing_ok=True)
    _drop_parts(EXTRACTIONS, rec_id)
    _markdown_path(rec_id).unlink(missing_ok=True)
    return {"deleted": rec_id}


class GraphRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    extraction_ids: list[str] = Field(min_length=1, max_length=200)
    resolve_model: Optional[str] = None
    description: Optional[str] = Field(None, max_length=2000)


class GraphChange(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    extraction_ids: Optional[list[str]] = Field(None, min_length=1, max_length=200)
    resolve_model: Optional[str] = ""  # "" keeps the current setting, null turns it off
    description: Optional[str] = Field(None, max_length=2000)


def _check_extractions(ids: list[str]) -> list[str]:
    ids = list(dict.fromkeys(ids))
    for eid in ids:
        if _load(EXTRACTIONS, eid)["status"] != "completed":
            raise HTTPException(400, "only finished extractions can be merged")
    return ids


@router.post("/graphs")
def create_graph(req: GraphRequest) -> dict:
    if req.resolve_model and req.resolve_model not in MODELS:
        raise HTTPException(400, "unknown model")
    rec_id = f"kg-{uuid.uuid4().hex[:12]}"
    rec = {
        "id": rec_id,
        "name": req.name.strip(),
        "description": (req.description or "").strip() or None,
        "extraction_ids": _check_extractions(req.extraction_ids),
        "resolve_model": req.resolve_model or None,
        "status": "queued",
        "stage": "queued",
        "created_at": _now(),
        "updated_at": _now(),
        "started_at": None,
        "finished_at": None,
        "error": None,
        "stats": None,
    }
    _write(GRAPHS / f"{rec_id}.json", rec)
    _runner.submit(_build_graph, rec_id)
    return _public(rec)


@router.get("/graphs")
def list_graphs() -> list[dict]:
    return [_public(r) for r in _records(GRAPHS)]


@router.get("/graphs/{rec_id}")
def get_graph(rec_id: str) -> dict:
    return _public(_load(GRAPHS, rec_id))


@router.get("/graphs/{rec_id}/graph")
def graph_graph(rec_id: str, format: str = "json", download: bool = False) -> Response:
    return _graph_response(GRAPHS, rec_id, format, download)


@router.patch("/graphs/{rec_id}")
def update_graph(rec_id: str, req: GraphChange) -> dict:
    rec = _load(GRAPHS, rec_id)
    changes: dict[str, Any] = {"updated_at": _now()}
    rebuild = False
    if req.name is not None:
        changes["name"] = req.name.strip()
    if req.description is not None:
        changes["description"] = req.description.strip() or None
    if req.extraction_ids is not None:
        ids = _check_extractions(req.extraction_ids)
        rebuild |= ids != rec["extraction_ids"]
        changes["extraction_ids"] = ids
    if req.resolve_model != "":
        if req.resolve_model and req.resolve_model not in MODELS:
            raise HTTPException(400, "unknown model")
        rebuild |= (req.resolve_model or None) != rec.get("resolve_model")
        changes["resolve_model"] = req.resolve_model or None
    if rebuild:
        if rec["status"] in ("queued", "running"):
            raise HTTPException(409, "the knowledge graph is still being built")
        changes.update(status="queued", stage="queued")
    rec = _save(GRAPHS, rec_id, **changes)
    path = _graph_path(GRAPHS, rec_id)
    if req.name is not None and not rebuild and path.is_file():
        with _lock:
            graph = json.loads(path.read_text(encoding="utf-8"))
            graph["meta"].update(name=rec["name"], title=rec["name"])
            _write(path, graph)
    if changes.get("status") == "queued":
        _runner.submit(_build_graph, rec_id)
    return _public(rec)


@router.post("/graphs/{rec_id}/rebuild")
def rebuild_graph(rec_id: str) -> dict:
    rec = _load(GRAPHS, rec_id)
    if rec["status"] in ("queued", "running"):
        raise HTTPException(409, "the knowledge graph is still being built")
    rec = _save(GRAPHS, rec_id, status="queued", stage="queued", updated_at=_now())
    _runner.submit(_build_graph, rec_id)
    return _public(rec)


@router.post("/graphs/{rec_id}/stop")
def stop_graph(rec_id: str) -> dict:
    """Stop a queued or running build; finished AI resolution batches are kept for /continue."""
    rec = _load(GRAPHS, rec_id)
    if rec["status"] == "queued":
        return _public(_save(GRAPHS, rec_id, status="cancelled", stage="cancelled", finished_at=_now()))
    if rec["status"] != "running":
        raise HTTPException(409, "the knowledge graph is not being built")
    _stopping.add(rec_id)
    return _public(_save(GRAPHS, rec_id, stage="stopping"))


@router.post("/graphs/{rec_id}/continue")
def continue_graph(rec_id: str) -> dict:
    """Continue a stopped or failed build: finished AI resolution batches are reused."""
    rec = _load(GRAPHS, rec_id)
    if rec["status"] not in ("cancelled", "failed"):
        raise HTTPException(409, "only a stopped or failed build can be continued")
    rec = _save(GRAPHS, rec_id, status="queued", stage="queued", updated_at=_now())
    _runner.submit(_build_graph, rec_id)
    return _public(rec)


@router.delete("/graphs/{rec_id}")
def delete_graph(rec_id: str) -> dict:
    rec = _load(GRAPHS, rec_id)
    if rec["status"] in ("queued", "running"):
        raise HTTPException(409, "wait for the build to finish before deleting it")
    (GRAPHS / f"{rec_id}.json").unlink(missing_ok=True)
    _graph_path(GRAPHS, rec_id).unlink(missing_ok=True)
    _drop_parts(GRAPHS, rec_id)
    return {"deleted": rec_id}
