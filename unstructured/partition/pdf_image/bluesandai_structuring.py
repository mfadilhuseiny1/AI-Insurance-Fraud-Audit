"""The `bluesandai_structuring`, `bluesandai_structuring_lite` and `bluesandai_structuring_os1`
partitioning strategies.

Each page is rendered to an image and sent to a vision model, which transcribes it into typed,
reading-ordered elements (with bounding boxes). The response is mapped onto the standard
unstructured element classes so downstream code (staging, chunking) works unchanged.
The lite strategy is identical but defaults to the cheaper, faster Gemini Flash-Lite model,
which makes occasional harakat mistakes on fully-vowelled Arabic. The os1 strategy uses an
open-weight model on OpenRouter (default qwen/qwen3-vl-30b-a3b-instruct) instead of Gemini.

Configuration (keyword arguments take precedence over environment variables):
    bluesandai_api_key       / GEMINI_API_KEY             -- required (env var or .env.local)
    bluesandai_model         / BLUESANDAI_GEMINI_MODEL    -- default "gemini-3.5-flash"
                             / BLUESANDAI_GEMINI_LITE_MODEL -- lite default "gemini-3.5-flash-lite"
    bluesandai_max_workers   / BLUESANDAI_MAX_WORKERS     -- concurrent page requests, default 4
    bluesandai_instructions                               -- extra prompt text (domain hints)
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import IO, Any, Callable, Iterator, Optional

import requests
from PIL import Image as PILImage
from PIL import ImageSequence

from unstructured.documents.coordinates import PixelSpace
from unstructured.documents.elements import (
    Element,
    ElementMetadata,
    FigureCaption,
    Footer,
    Formula,
    Header,
    Image,
    ListItem,
    NarrativeText,
    PageBreak,
    PageNumber,
    Table,
    Text,
    Title,
)
from unstructured.logger import logger
from unstructured.partition.common.common import exactly_one
from unstructured.partition.pdf_image.pdf_image_utils import convert_pdf_to_images

DEFAULT_MODEL = "gemini-3.5-flash"
DEFAULT_LITE_MODEL = "gemini-3.5-flash-lite"
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DETECTION_ORIGIN = "bluesandai_structuring"
MAX_ATTEMPTS = 5
REQUEST_TIMEOUT = 120  # seconds; a single page never legitimately takes this long
RETRYABLE_STATUS = {429, 500, 502, 503, 504}

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_OPENROUTER_MODEL = "qwen/qwen3-vl-30b-a3b-instruct"

# Cumulative token usage of every Gemini response in this process (including retried ones), for
# cost reporting. Output tokens include thinking tokens, which Gemini bills as output.
USAGE = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
# Same for OpenRouter (os1 strategy or fallback); OpenRouter reports the billed cost itself.
OPENROUTER_USAGE = {"requests": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
_usage_lock = threading.Lock()

DOT_LEADER = re.compile(r"\s*(?:[.·…_]\s*){4,}")
TOC_ENTRY = re.compile(r"(?:[.·…_]\s*){4,}\s*[\divxlcIVXLC]+\s*$")
FOOTNOTE_START = re.compile(r"^[\d¹²³⁰⁴⁵⁶⁷⁸⁹]{1,3}\s+\S")
LETTER = re.compile(r"[^\W\d_]")

ELEMENT_CLASSES: dict[str, type[Text]] = {
    "Title": Title,
    "NarrativeText": NarrativeText,
    "ListItem": ListItem,
    "Table": Table,
    "Footnote": NarrativeText,
    "Header": Header,
    "Footer": Footer,
    "PageNumber": PageNumber,
    "FigureCaption": FigureCaption,
    "Formula": Formula,
    "Image": Image,
}

PROMPT = """\
You are a document-structuring engine. Transcribe this page image into elements in natural \
reading order. The elements feed a retrieval (RAG) pipeline: they are chunked by heading and \
embedded, so every element must be one self-contained semantic unit (a heading, a paragraph, a \
list item, a table, a footnote) and its type must be accurate.

Rules:
- Copy text exactly as printed. Never translate, summarize, correct, or add text.
- In Latin transliteration write 'ain/hamzah as an apostrophe ('), never a backtick.
- Arabic must keep every harakat/diacritic as printed. Keep Arabic-Indic digits as printed.
- Join lines of one paragraph into a single element; remove end-of-line hyphenation.
- Each Arabic passage and each translation paragraph is its own element.
- type: Title (headings), NarrativeText (body paragraphs), ListItem, Table, Footnote, \
Header (running head at the top of the page), Footer (running foot at the bottom), PageNumber, \
FigureCaption, Formula, Image (non-text graphics; text = short description in brackets).
- Table-of-contents entries are always ListItem, never Title.
- Every note below the footnote separator line is a Footnote (keep its number), including \
short ones such as "2 Ibid, no. 39.".
- For Table, also fill text_as_html with an HTML <table>.
- language: ISO 639-3 code of the element's main language. Indonesian is "ind" (never "msa"), \
Arabic is "ara", English is "eng". Short or neutral text (names, numbers, book titles such as \
"JILID 1") takes the main language of the page.
- box_2d: [ymin, xmin, ymax, xmax] normalized to 0-1000.
- Skip decorative borders and ornaments.
"""
BOX_RULE_GEMINI = "- box_2d: [ymin, xmin, ymax, xmax] normalized to 0-1000."
BOX_RULE_QWEN = "- bbox_2d: [x1, y1, x2, y2] in relative coordinates on a 0-1000 grid."

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "elements": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "type": {"type": "STRING", "enum": list(ELEMENT_CLASSES)},
                    "text": {"type": "STRING"},
                    "language": {"type": "STRING"},
                    "text_as_html": {"type": "STRING"},
                    "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                },
                "required": ["type", "text", "language"],
            },
        }
    },
    "required": ["elements"],
}


# Standard JSON Schema for OpenRouter structured outputs (strict mode: every property required).
OPENROUTER_SCHEMA = {
    "type": "object",
    "properties": {
        "elements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": list(ELEMENT_CLASSES)},
                    "text": {"type": "string"},
                    "language": {"type": "string"},
                    "text_as_html": {"type": "string"},
                    "bbox_2d": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["type", "text", "language", "text_as_html", "bbox_2d"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["elements"],
    "additionalProperties": False,
}


class BluesandaiStructuringError(RuntimeError):
    pass


class PageBlockedError(BluesandaiStructuringError):
    """Gemini refused the page (e.g. RECITATION: output resembles a copyrighted work). Retrying
    the same request is not attempted; the page goes to the fallback strategy instead."""

    def __init__(self, page_number: int, reason: str):
        super().__init__(f"Gemini blocked page {page_number}: {reason}")
        self.page_number = page_number
        self.reason = reason


# Finish reasons that mean the model refused to return the content.
BLOCKED_FINISH_REASONS = {"RECITATION", "SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"}

# Pages Gemini blocked in this process: (page_number, reason, handled_by), for reporting.
BLOCKED_PAGES: list[tuple[int, str, str]] = []


def partition_with_bluesandai_structuring(
    filename: str = "",
    file: Optional[bytes | IO[bytes]] = None,
    is_image: bool = False,
    lite: bool = False,
    provider: str = "gemini",
    languages: Optional[list[str]] = None,
    include_page_breaks: bool = False,
    starting_page_number: int = 1,
    metadata_last_modified: Optional[str] = None,
    password: Optional[str] = None,
    bluesandai_api_key: Optional[str] = None,
    bluesandai_model: Optional[str] = None,
    bluesandai_max_workers: Optional[int] = None,
    bluesandai_instructions: Optional[str] = None,
    bluesandai_fallback_strategy: Optional[str] = None,
    **kwargs: Any,
) -> list[Element]:
    """Partition a PDF or image by having a vision model structure each page.

    `provider` is "gemini" (Gemini API) or "openrouter" (OpenRouter, for the os1 strategy).
    A page the provider refuses or keeps failing on (see `PageBlockedError`) goes to
    `bluesandai_fallback_strategy` (env BLUESANDAI_FALLBACK_STRATEGY): "openrouter" sends it to
    an OpenRouter vision model (OPENROUTER_API_KEY; BLUESANDAI_OPENROUTER_MODEL, default
    qwen/qwen3-vl-30b-a3b-instruct), a local strategy such as "hi_res" partitions it locally,
    and without one it is skipped with a warning. Either way it is recorded in `BLOCKED_PAGES`
    and its elements carry `metadata.bluesandai_fallback`.
    """
    exactly_one(filename=filename, file=file)
    if provider == "openrouter":
        key_name = "OPENROUTER_API_KEY"
        default = os.environ.get("BLUESANDAI_OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL)
        call = _call_openrouter
    else:
        key_name = "GEMINI_API_KEY"
        if lite:
            default = os.environ.get("BLUESANDAI_GEMINI_LITE_MODEL", DEFAULT_LITE_MODEL)
        else:
            default = os.environ.get("BLUESANDAI_GEMINI_MODEL", DEFAULT_MODEL)
        call = _call_gemini
    api_key = bluesandai_api_key or os.environ.get(key_name) or _read_env_local().get(key_name)
    if not api_key:
        raise ValueError(
            f"The bluesandai strategy with provider {provider!r} needs {key_name} "
            "(environment or .env.local) or bluesandai_api_key."
        )
    model = bluesandai_model or default
    max_workers = int(bluesandai_max_workers or os.environ.get("BLUESANDAI_MAX_WORKERS", 4))
    fallback = bluesandai_fallback_strategy or os.environ.get("BLUESANDAI_FALLBACK_STRATEGY")
    if provider == "openrouter" and fallback in ("openrouter", f"openrouter:{model}"):
        fallback = None  # falling back to the same model would just repeat the failure
    logger.info(
        f"bluesandai_structuring: provider={provider}, model={model}, "
        f"max_workers={max_workers}, fallback={fallback}"
    )

    prompt = PROMPT
    if languages:
        prompt += f"\nExpected languages: {', '.join(languages)}.\n"
    if bluesandai_instructions:
        prompt += f"\nAdditional instructions:\n{bluesandai_instructions}\n"

    session = requests.Session()
    elements: list[Element] = []

    def process_page(png: str, size: tuple[int, int], page_number: int) -> list[Element]:
        # -- runs in a worker thread, so a slow fallback page does not stall the others --
        try:
            blocks = call(session, api_key, model, prompt, png, page_number)
        except BluesandaiStructuringError as e:
            # -- refused (PageBlockedError) or still failing after retries: fall back rather
            # -- than abort a long run; the page is recorded either way --
            reason = e.reason if isinstance(e, PageBlockedError) else "error"
            if reason == "error":
                logger.warning(f"bluesandai_structuring: page {page_number} failed: {e}")
            return _fallback_page(
                session,
                prompt,
                png,
                size,
                page_number,
                reason,
                fallback,
                languages,
                metadata_last_modified,
            )
        return _to_elements(
            blocks,
            page_number=page_number,
            image_size=size,
            metadata_last_modified=metadata_last_modified,
        )

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        pending: list[Future] = []

        def drain(limit: int) -> None:
            while len(pending) > limit:
                elements.extend(pending.pop(0).result())
                if include_page_breaks:
                    elements.append(PageBreak(text=""))

        for i, image in enumerate(_iter_page_images(filename, file, is_image, password)):
            png = _encode_png(image)
            pending.append(pool.submit(process_page, png, image.size, starting_page_number + i))
            drain(max_workers * 2)  # bound memory: keep only a few pages in flight
        drain(0)

    _normalize_languages(elements)
    return elements


def _fallback_page(
    session: requests.Session,
    prompt: str,
    png_b64: str,
    image_size: tuple[int, int],
    page_number: int,
    reason: str,
    strategy: Optional[str],
    languages: Optional[list[str]],
    metadata_last_modified: Optional[str],
) -> list[Element]:
    """Partition a page the primary model refused. `strategy` is "openrouter" or
    "openrouter:<model>" (same prompt and schema, sent to an OpenRouter vision model), a local
    partition strategy such as "hi_res", or None (skip)."""
    if not strategy:
        logger.warning(f"bluesandai_structuring: page {page_number} blocked ({reason}), skipped")
        BLOCKED_PAGES.append((page_number, reason, "skipped"))
        return []

    if strategy == "openrouter" or strategy.startswith("openrouter:"):
        model = strategy.partition(":")[2] or os.environ.get(
            "BLUESANDAI_OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL
        )
        handled_by = f"openrouter:{model}"
        api_key = os.environ.get("OPENROUTER_API_KEY") or _read_env_local().get(
            "OPENROUTER_API_KEY"
        )
        if not api_key:
            raise ValueError(
                "The openrouter fallback needs OPENROUTER_API_KEY (environment or .env.local)."
            )
        logger.warning(
            f"bluesandai_structuring: page {page_number} blocked ({reason}), using {handled_by}"
        )
        try:
            blocks = _call_openrouter(session, api_key, model, prompt, png_b64, page_number)
        except BluesandaiStructuringError as e:
            logger.warning(f"bluesandai_structuring: page {page_number} fallback failed: {e}")
            BLOCKED_PAGES.append((page_number, reason, f"{handled_by} failed"))
            return []
        elements = _to_elements(
            blocks,
            page_number=page_number,
            image_size=image_size,
            metadata_last_modified=metadata_last_modified,
        )
    else:
        from unstructured.partition.image import partition_image

        handled_by = strategy
        logger.warning(
            f"bluesandai_structuring: page {page_number} blocked ({reason}), using {strategy}"
        )
        elements = partition_image(
            file=io.BytesIO(base64.b64decode(png_b64)),
            strategy=strategy,
            languages=languages,
        )
        for e in elements:
            e.metadata.page_number = page_number

    for e in elements:
        e.metadata.bluesandai_fallback = f"{reason} -> {handled_by}"
    BLOCKED_PAGES.append((page_number, reason, handled_by))
    return elements


def _read_env_local() -> dict[str, str]:
    """Read KEY=VALUE pairs from the first .env.local found in the working directory or the
    repo root."""
    repo_root = Path(__file__).resolve().parents[3]
    for path in (Path.cwd(), repo_root):
        env_file = path / ".env.local"
        if env_file.is_file():
            values = {}
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.strip().strip("\"'")
            return values
    return {}


def _iter_page_images(
    filename: str,
    file: Optional[bytes | IO[bytes]],
    is_image: bool,
    password: Optional[str],
) -> Iterator[PILImage.Image]:
    if not is_image:
        yield from convert_pdf_to_images(filename=filename, file=file, password=password)
        return
    source = io.BytesIO(file) if isinstance(file, bytes) else (file or filename)
    with PILImage.open(source) as img:
        for frame in ImageSequence.Iterator(img):
            yield frame.convert("RGB")


def _encode_png(image: PILImage.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _post_with_retries(
    session: requests.Session,
    provider: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    page_number: int,
    parse: Callable[[dict[str, Any]], list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """POST `body`, retrying transient failures and responses `parse` cannot read. `parse` raises
    PageBlockedError (not retried) when the provider refuses the content."""
    error = ""
    for attempt in range(MAX_ATTEMPTS):
        if attempt:
            time.sleep(2**attempt)
            logger.warning(f"{provider} page {page_number}: retry {attempt} after {error[:200]}")
        try:
            resp = session.post(url, headers=headers, json=body, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as e:
            error = repr(e)
            continue
        if resp.status_code in RETRYABLE_STATUS:
            error = f"HTTP {resp.status_code}: {resp.text[:300]}"
            continue
        if resp.status_code != 200:
            raise BluesandaiStructuringError(
                f"{provider} request for page {page_number} failed with HTTP "
                f"{resp.status_code}: {resp.text[:500]}"
            )
        try:
            return parse(resp.json())
        except (KeyError, IndexError, TypeError, ValueError) as e:
            # Truncated or malformed output; a retry usually succeeds.
            error = f"unparseable response ({e!r}): {resp.text[:300]}"
    raise BluesandaiStructuringError(
        f"{provider} request for page {page_number} failed after {MAX_ATTEMPTS} attempts: {error}"
    )


def _call_gemini(
    session: requests.Session,
    api_key: str,
    model: str,
    prompt: str,
    png_b64: str,
    page_number: int,
) -> list[dict[str, Any]]:
    body = {
        "contents": [
            {
                "parts": [
                    {"inline_data": {"mime_type": "image/png", "data": png_b64}},
                    {"text": prompt},
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
            "thinkingConfig": {"thinkingLevel": "low"},
        },
    }

    def parse(payload: dict[str, Any]) -> list[dict[str, Any]]:
        usage = payload.get("usageMetadata", {})
        _record_usage(
            USAGE,
            usage.get("promptTokenCount", 0),
            usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0),
        )
        block_reason = payload.get("promptFeedback", {}).get("blockReason")
        finish_reason = (payload.get("candidates") or [{}])[0].get("finishReason")
        if block_reason or finish_reason in BLOCKED_FINISH_REASONS:
            raise PageBlockedError(page_number, block_reason or finish_reason)
        return json.loads(payload["candidates"][0]["content"]["parts"][0]["text"])["elements"]

    return _post_with_retries(
        session,
        "Gemini",
        API_URL.format(model=model),
        {"x-goog-api-key": api_key},
        body,
        page_number,
        parse,
    )


def _call_openrouter(
    session: requests.Session,
    api_key: str,
    model: str,
    prompt: str,
    png_b64: str,
    page_number: int,
) -> list[dict[str, Any]]:
    # Qwen-VL grounds boxes natively as [x1, y1, x2, y2] on a 0-1000 grid, so ask for that and
    # convert to Gemini's [ymin, xmin, ymax, xmax] afterwards.
    prompt = prompt.replace(BOX_RULE_GEMINI, BOX_RULE_QWEN)
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "page_elements", "strict": True, "schema": OPENROUTER_SCHEMA},
        },
        "provider": {"require_parameters": True},
        "temperature": 0,
        # A dense page is ~3k output tokens; without a cap a looping model can run for minutes.
        # (repetition_penalty is not used: several providers reject it under require_parameters.)
        "max_tokens": 8192,
    }

    def parse(payload: dict[str, Any]) -> list[dict[str, Any]]:
        usage = payload.get("usage", {})
        _record_usage(
            OPENROUTER_USAGE,
            usage.get("prompt_tokens", 0),
            usage.get("completion_tokens", 0),
            usage.get("cost", 0.0),
        )
        choice = payload["choices"][0]
        if choice.get("finish_reason") == "content_filter":
            raise PageBlockedError(page_number, "content_filter")
        content = choice["message"]["content"].strip()
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
        blocks = json.loads(content)["elements"]
        for b in blocks:
            box = b.pop("bbox_2d", None)
            if isinstance(box, list) and len(box) == 4:
                x1, y1, x2, y2 = box
                b["box_2d"] = [y1, x1, y2, x2]
        return blocks

    return _post_with_retries(
        session,
        "OpenRouter",
        OPENROUTER_URL,
        {"Authorization": f"Bearer {api_key}"},
        body,
        page_number,
        parse,
    )


def _record_usage(usage: dict, input_tokens: int, output_tokens: int, cost: float = 0.0) -> None:
    with _usage_lock:
        usage["requests"] += 1
        usage["input_tokens"] += input_tokens
        usage["output_tokens"] += output_tokens
        if "cost_usd" in usage:
            usage["cost_usd"] += cost or 0.0


def _normalize_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministic fixes for labeling mistakes the model makes inconsistently."""

    def top(b: dict[str, Any]) -> Optional[int]:
        box = b.get("box_2d")
        return box[0] if isinstance(box, list) and len(box) == 4 else None

    for b in blocks:
        text = b.get("text") or ""
        # -- table-of-contents entries: always ListItem, dot leaders collapsed --
        if TOC_ENTRY.search(text):
            b["type"] = "ListItem"
        # -- a backtick used for 'ain/hamzah ("qira`at") would open a Markdown code span --
        b["text"] = DOT_LEADER.sub(" — ", text).replace("`", "'").strip()
        # -- running heads/feet: decide by position, not by the model's guess --
        y = top(b)
        if y is not None:
            if b.get("type") == "Header" and y >= 850:
                b["type"] = "Footer"
            elif b.get("type") == "Footer" and y < 150:
                b["type"] = "Header"

    # -- footnotes: anything body-like below the first footnote on the page is a footnote too;
    # -- without one, a numbered note low on the page ("2 Ibid, no. 39.") is one --
    footnote_tops = [top(b) for b in blocks if b.get("type") == "Footnote" and top(b) is not None]
    first_footnote = min(footnote_tops) if footnote_tops else None
    for b in blocks:
        y = top(b)
        if b.get("type") not in ("NarrativeText", "ListItem") or y is None:
            continue
        if (first_footnote is not None and y >= first_footnote) or (
            first_footnote is None and y >= 800 and FOOTNOTE_START.match(b.get("text") or "")
        ):
            b["type"] = "Footnote"
    return blocks


def _normalize_languages(elements: list[Element]) -> None:
    """Short or language-neutral elements (page numbers, names, "JILID 1") get the document's
    main language instead of the model's frequent "eng" default."""
    counts: dict[str, int] = {}
    for e in elements:
        langs = e.metadata.languages
        if langs and len(e.text) >= 40:
            counts[langs[0]] = counts.get(langs[0], 0) + 1
    if not counts:
        return
    main = max(counts, key=counts.__getitem__)
    for e in elements:
        langs = e.metadata.languages
        neutral = not LETTER.search(e.text)
        short_eng = langs == ["eng"] and len(e.text) < 40
        if main != "eng" and (neutral or short_eng or langs is None):
            e.metadata.languages = [main]


def _to_elements(
    blocks: list[dict[str, Any]],
    page_number: int,
    image_size: tuple[int, int],
    metadata_last_modified: Optional[str],
) -> list[Element]:
    width, height = image_size
    elements: list[Element] = []
    for block in _normalize_blocks(blocks):
        text = (block.get("text") or "").strip()
        cls = ELEMENT_CLASSES.get(block.get("type", ""), NarrativeText)
        if not text and cls is not Image:
            continue
        coordinates = None
        box = block.get("box_2d")
        if isinstance(box, list) and len(box) == 4:
            ymin, xmin, ymax, xmax = (v / 1000 for v in box)
            coordinates = (
                (xmin * width, ymin * height),
                (xmin * width, ymax * height),
                (xmax * width, ymax * height),
                (xmax * width, ymin * height),
            )
        metadata = ElementMetadata(
            page_number=page_number,
            languages=[block["language"]] if block.get("language") else None,
            last_modified=metadata_last_modified,
        )
        if cls is Table and block.get("text_as_html"):
            metadata.text_as_html = block["text_as_html"]
        element = cls(
            text=text,
            coordinates=coordinates,
            coordinate_system=PixelSpace(width=width, height=height) if coordinates else None,
            metadata=metadata,
            detection_origin=DETECTION_ORIGIN,
        )
        if block.get("type") == "Footnote":
            element.metadata.is_footnote = True
        elements.append(element)
    if not elements:
        logger.debug(f"bluesandai_structuring: page {page_number} produced no elements")
    return elements
