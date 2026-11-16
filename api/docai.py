"""Google Document AI (Enterprise Document OCR) for the Cost Effective tier.

Configuration, from the environment or the repo's .env.local:
    GOOGLE_APPLICATION_CREDENTIALS   path to a service-account JSON key ("Document AI API User" role)
    GOOGLE_DOCAI_PROJECT_ID          Google Cloud project id
    GOOGLE_DOCAI_LOCATION            processor region: "us" or "eu" (default "us")
    GOOGLE_DOCAI_PROCESSOR_ID        id of a "Document OCR" processor
    GOOGLE_DOCAI_PROCESSOR_VERSION   optional, e.g. "pretrained-ocr-v2.1-2024-08-07"

The response is mapped onto unstructured-style element dicts (same shape as the other tiers).
Document OCR only returns paragraphs, so structure is recovered here: headings and list items
from text shape and type size (`_classify`), running heads/feet and page numbers from position
and repetition across pages (`refine_document`, run once per job). Tables are kept if the
processor returns them (the OCR processor does not; Agentic tiers handle tables).
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import threading
from pathlib import Path
from typing import Any, Callable, Optional

import requests

ENV_KEYS = (
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_DOCAI_PROJECT_ID",
    "GOOGLE_DOCAI_LOCATION",
    "GOOGLE_DOCAI_PROCESSOR_ID",
    "GOOGLE_DOCAI_PROCESSOR_VERSION",
)
# Document AI returns BCP-47 codes; the rest of the pipeline uses ISO 639-3. It regularly labels
# Indonesian as Malay ("ms"), and this service is for Indonesian texts, so "ms" maps to "ind".
LANGUAGES = {"ar": "ara", "id": "ind", "ms": "ind", "en": "eng", "fa": "fas", "ur": "urd", "tr": "tur"}
ARABIC_LETTER = re.compile(r"[ء-يٱ-ۓ]")
LATIN_LETTER = re.compile(r"[A-Za-z]")
TIMEOUT = 180

_token_lock = threading.Lock()
_credentials: Any = None


def settings(read_env_file: Callable[[], dict[str, str]]) -> dict[str, str]:
    file_values = read_env_file()
    return {k: (os.environ.get(k) or file_values.get(k) or "").strip() for k in ENV_KEYS}


def is_configured(s: dict[str, str]) -> bool:
    creds = s["GOOGLE_APPLICATION_CREDENTIALS"]
    return bool(s["GOOGLE_DOCAI_PROJECT_ID"] and s["GOOGLE_DOCAI_PROCESSOR_ID"] and creds and Path(creds).is_file())


def _access_token(credentials_path: str) -> str:
    """OAuth token for the service account (Document AI does not accept API keys)."""
    global _credentials
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    with _token_lock:
        if _credentials is None:
            _credentials = service_account.Credentials.from_service_account_file(
                credentials_path, scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
        if not _credentials.valid:
            _credentials.refresh(Request())
        return _credentials.token


def process(
    s: dict[str, str],
    content: bytes,
    mime_type: str,
    first_page_number: int,
    filename: str,
) -> list[dict]:
    """OCR one document (≤15 pages) and return element dicts numbered from first_page_number."""
    location = s["GOOGLE_DOCAI_LOCATION"] or "us"
    name = f"projects/{s['GOOGLE_DOCAI_PROJECT_ID']}/locations/{location}/processors/{s['GOOGLE_DOCAI_PROCESSOR_ID']}"
    if s["GOOGLE_DOCAI_PROCESSOR_VERSION"]:
        name += f"/processorVersions/{s['GOOGLE_DOCAI_PROCESSOR_VERSION']}"
    resp = requests.post(
        f"https://{location}-documentai.googleapis.com/v1/{name}:process",
        headers={"Authorization": f"Bearer {_access_token(s['GOOGLE_APPLICATION_CREDENTIALS'])}"},
        json={"rawDocument": {"content": base64.b64encode(content).decode(), "mimeType": mime_type}},
        timeout=TIMEOUT,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Document AI HTTP {resp.status_code}: {resp.text[:500]}")
    return to_elements(resp.json()["document"], first_page_number, filename, mime_type)


HEADING_NUMBERED = re.compile(r"^\d+(\.\d+)+\.?\s+\S")  # "1.1 Latar Belakang", "2.2.1 ..."
HEADING_WORD = re.compile(r"^(BAB|Bab|CHAPTER|Chapter|BAGIAN|Bagian|PART|Part|LAMPIRAN|Lampiran)\s+([IVXLCDM]+|\d+)\b")
LIST_MARK = re.compile(r"^([•●○◦▪■\-–*]|\(?\d{1,2}[.)]|\(?[a-zA-Z][.)])\s+\S")
TOC_TITLE = re.compile(
    r"^(daftar\s+(isi|gambar|tabel|lampiran|singkatan)\b.*|table\s+of\s+contents|contents|"
    r"list\s+of\s+(figures|tables)|fihris|الفهرس|فهرس.*)$",
    re.IGNORECASE,
)
BARE_PAGE_REF = re.compile(r"[\dIVXLCDMivxlcdm]{1,5}")
FURNITURE = ("Header", "Footer", "PageNumber")
PAGE_NUMBER = re.compile(
    r"^(\d{1,4}|[ivxlcdmIVXLCDM]{1,6}|(halaman|hal\.?|page|p\.)\s*\d+(\s*(dari|of|/)\s*\d+)?|\d+\s*/\s*\d+|-\s*\d+\s*-)$",
    re.IGNORECASE,
)


def _classify(content: str, n_lines: int, height_ratio: float) -> str:
    """Element type from text shape and size. Document OCR returns plain paragraphs; headings and
    list items matter for RAG chunking (chunks are split at headings)."""
    short = n_lines <= 2 and len(content) <= 120 and not content.rstrip().endswith((".", ",", ";", ":"))
    letters = [c for c in content if c.isalpha()]
    all_caps = len(letters) >= 3 and sum(c.isupper() for c in letters) / len(letters) >= 0.9
    if short and (
        HEADING_WORD.match(content)
        or HEADING_NUMBERED.match(content)
        or (all_caps and len(content) <= 80)
        or height_ratio >= 1.25
    ):
        return "Title"
    if LIST_MARK.match(content):
        return "ListItem"
    return "NarrativeText"


def refine_document(elements: list[dict]) -> list[dict]:
    """Document-level pass: running heads/feet and page numbers, recognised by position (top or
    bottom band of the page) and repetition across pages, so RAG chunks don't carry them."""

    def band(e: dict) -> Optional[str]:
        c = e["metadata"].get("coordinates")
        if not c or not c.get("layout_height"):
            return None
        ys = [p[1] / c["layout_height"] for p in c["points"]]
        if max(ys) <= 0.08:
            return "top"
        if min(ys) >= 0.92:
            return "bottom"
        return None

    def norm(text: str) -> str:
        return re.sub(r"\d+", "#", text.lower()).strip()

    pages = {e["metadata"]["page_number"] for e in elements}
    repeats: dict[tuple[str, str], set[int]] = {}
    for e in elements:
        b = band(e)
        if b:
            repeats.setdefault((b, norm(e["text"])), set()).add(e["metadata"]["page_number"])
    needed = 2 if len(pages) < 6 else 3
    for e in elements:
        b = band(e)
        if not b or e["type"] == "Table":
            continue
        if PAGE_NUMBER.match(e["text"].strip()):
            e["type"] = "PageNumber"
        elif len(repeats.get((b, norm(e["text"])), ())) >= needed:
            e["type"] = "Header" if b == "top" else "Footer"

    by_page: dict[int, list[dict]] = {}
    for e in elements:
        if e["type"] not in FURNITURE:
            by_page.setdefault(e["metadata"]["page_number"], []).append(e)

    def is_heading(text: str) -> bool:
        return bool(HEADING_NUMBERED.match(text) or HEADING_WORD.match(text))

    # -- tables of contents: entries are list items, not headings (each heading starts a RAG
    # -- chunk); a TOC continues onto following pages full of heading-like lines and no prose --
    toc_pages: set[int] = set()
    for p in sorted(by_page):
        body = by_page[p]
        prose = sum(len(e["text"]) >= 200 for e in body)
        headingish = sum(is_heading(e["text"]) for e in body)
        if any(TOC_TITLE.match(e["text"].strip()) for e in body) or (
            p - 1 in toc_pages and headingish >= 5 and prose == 0
        ):
            toc_pages.add(p)
    dropped: set[int] = set()
    for p in toc_pages:
        for e in by_page[p]:
            text = e["text"].strip()
            if TOC_TITLE.match(text):
                e["type"] = "Title"
            elif BARE_PAGE_REF.fullmatch(text):
                dropped.add(id(e))  # a page number OCR'd as its own paragraph
            else:
                e["type"] = "ListItem"

    # -- diagram/table pages: labels inside figures come out as short all-caps fragments; they
    # -- are not section headings --
    for p, body in by_page.items():
        if p in toc_pages:
            continue
        fragments = [e for e in body if len(e["text"]) <= 40]
        prose = sum(len(e["text"]) >= 200 for e in body)
        if len(fragments) >= 8 and len(fragments) >= 2 * max(1, prose):
            for e in fragments:
                if e["type"] == "Title" and not is_heading(e["text"]):
                    e["type"] = "UncategorizedText"

    return [e for e in elements if id(e) not in dropped]


def to_elements(document: dict, first_page_number: int, filename: str, mime_type: str) -> list[dict]:
    text = document.get("text", "")
    elements: list[dict] = []
    for i, page in enumerate(document.get("pages", [])):
        page_number = first_page_number + i
        dim = page.get("dimension", {})
        width, height = dim.get("width", 0), dim.get("height", 0)
        page_lang = _language(page.get("detectedLanguages"))
        # line spans and heights, to know each paragraph's line count and type size
        lines = [(_span(ln.get("layout", {})), _box_height(ln.get("layout", {}))) for ln in page.get("lines", [])]
        heights = sorted(h for _, h in lines if h > 0)
        body_height = heights[len(heights) // 2] if heights else 0.0
        table_spans = []
        for table in page.get("tables", []):
            span = _span(table.get("layout", {}))
            table_spans.append(span)
            html = _table_html(table, text)
            elements.append(
                _element("Table", _plain(html), page_number, page_lang, table.get("layout", {}), width, height,
                         filename, mime_type, text_as_html=html)
            )
        for para in page.get("paragraphs", []):
            layout = para.get("layout", {})
            start, end = _span(layout)
            if any(s <= start and end <= e for s, e in table_spans):
                continue  # already part of a table
            content = _clean(_anchor_text(layout, text))
            if content:
                # paragraphs often carry no language of their own and inherit the page's, which
                # would mark an Arabic passage on an Indonesian page as Indonesian: go by script
                if len(ARABIC_LETTER.findall(content)) > len(LATIN_LETTER.findall(content)):
                    lang = "ara"
                else:
                    lang = _language(para.get("detectedLanguages")) or page_lang
                para_lines = [h for (ls, le), h in lines if ls >= start and le <= end]
                n_lines = max(1, len(para_lines))
                ratio = (sorted(para_lines)[len(para_lines) // 2] / body_height) if para_lines and body_height else 1.0
                kind = _classify(content, n_lines, ratio)
                elements.append(_element(kind, content, page_number, lang, layout, width, height, filename, mime_type))
    # identical text can repeat on a page (e.g. a label used twice in a diagram): include the
    # element's position so every id is unique
    for seq, e in enumerate(elements):
        key = f"{filename}|{e['metadata']['page_number']}|{seq}|{e['type']}|{e['text']}"
        e["element_id"] = hashlib.sha256(key.encode()).hexdigest()[:32]
    return elements


def _element(
    kind: str,
    text: str,
    page_number: int,
    language: Optional[str],
    layout: dict,
    width: float,
    height: float,
    filename: str,
    mime_type: str,
    text_as_html: Optional[str] = None,
) -> dict:
    metadata: dict[str, Any] = {"page_number": page_number, "filename": filename, "filetype": mime_type}
    if language:
        metadata["languages"] = [language]
    vertices = layout.get("boundingPoly", {}).get("normalizedVertices")
    if vertices and width and height:
        metadata["coordinates"] = {
            "points": [[v.get("x", 0) * width, v.get("y", 0) * height] for v in vertices],
            "system": "PixelSpace",
            "layout_width": width,
            "layout_height": height,
        }
    if text_as_html:
        metadata["text_as_html"] = text_as_html
    element_id = hashlib.sha256(f"{filename}|{page_number}|{kind}|{text}".encode()).hexdigest()[:32]
    return {"type": kind, "element_id": element_id, "text": text, "metadata": metadata}


def _span(layout: dict) -> tuple[int, int]:
    segments = layout.get("textAnchor", {}).get("textSegments", [])
    if not segments:
        return (0, 0)
    return int(segments[0].get("startIndex", 0)), int(segments[-1].get("endIndex", 0))


def _box_height(layout: dict) -> float:
    ys = [v.get("y", 0) for v in layout.get("boundingPoly", {}).get("normalizedVertices", [])]
    return (max(ys) - min(ys)) if ys else 0.0


def _anchor_text(layout: dict, text: str) -> str:
    return "".join(
        text[int(s.get("startIndex", 0)) : int(s.get("endIndex", 0))]
        for s in layout.get("textAnchor", {}).get("textSegments", [])
    )


def _clean(s: str) -> str:
    s = re.sub(r"-\n(?=\w)", "", s)  # join words hyphenated across lines
    return re.sub(r"\s+", " ", s).strip()


def _language(detected: Optional[list]) -> Optional[str]:
    if not detected:
        return None
    best = max(detected, key=lambda d: d.get("confidence", 0))
    code = best.get("languageCode", "").split("-")[0].lower()
    return LANGUAGES.get(code, code or None)


def _table_html(table: dict, text: str) -> str:
    def rows(kind: str, cell_tag: str) -> str:
        out = []
        for row in table.get(kind, []):
            cells = []
            for cell in row.get("cells", []):
                attrs = ""
                if cell.get("colSpan", 1) > 1:
                    attrs += f' colspan="{cell["colSpan"]}"'
                if cell.get("rowSpan", 1) > 1:
                    attrs += f' rowspan="{cell["rowSpan"]}"'
                value = _clean(_anchor_text(cell.get("layout", {}), text))
                cells.append(f"<{cell_tag}{attrs}>{_escape(value)}</{cell_tag}>")
            out.append("<tr>" + "".join(cells) + "</tr>")
        return "".join(out)

    head, body = rows("headerRows", "th"), rows("bodyRows", "td")
    return f"<table>{f'<thead>{head}</thead>' if head else ''}<tbody>{body}</tbody></table>"


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _plain(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()
