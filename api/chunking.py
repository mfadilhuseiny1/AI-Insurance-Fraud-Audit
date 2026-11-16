"""RAG chunking, shared by the API and the Fast worker on Cloud Run (deploy-fast-worker.ps1 copies
this file and semantic.py into the worker image).

Fast jobs are split by topic on the worker (semantic.py, multilingual-e5-small), the other tiers at
headings (chunk_by_title). Either way each chunk has the same shape and carries the pages and
languages it came from.
"""

from __future__ import annotations

import logging
import re

from unstructured.chunking.basic import chunk_elements
from unstructured.chunking.title import chunk_by_title
from unstructured.staging.base import elements_from_dicts, elements_to_md

log = logging.getLogger("bluesandai.chunking")

# hard max, soft max, and merge threshold, in characters
RAG_CHUNK_MAX_CHARS = 2000
RAG_CHUNK_SOFT_MAX_CHARS = 1500
RAG_CHUNK_COMBINE_UNDER = 300


def rag_chunks(
    elements: list[dict],
    semantic_split: bool = False,
    max_chars: int = RAG_CHUNK_MAX_CHARS,
    soft_max_chars: int = RAG_CHUNK_SOFT_MAX_CHARS,
    combine_under: int = RAG_CHUNK_COMBINE_UNDER,
    overlap: int = 0,
) -> tuple[list[dict], str]:
    """Retrieval-ready chunks of public element dicts, page furniture left out; returns (chunks,
    "semantic" | "heading"). `semantic_split` splits by topic; if that fails, at headings. The sizes
    and `overlap` (characters repeated from the end of the previous chunk) apply to heading-based
    chunks; the defaults are what parse jobs use, other values are for re-chunking when embedding."""
    body = [e for e in elements_from_dicts(elements) if e.category not in ("Header", "Footer", "PageNumber", "PageBreak")]
    if not body:
        return [], "semantic" if semantic_split else "heading"
    chunks = _semantic_chunks(body) if semantic_split else None
    method = "semantic" if chunks is not None else "heading"
    if chunks is None:
        chunks = chunk_by_title(
            body,
            max_characters=max_chars,
            new_after_n_chars=soft_max_chars,
            combine_text_under_n_chars=combine_under,
            multipage_sections=True,
            overlap=overlap,
            overlap_all=overlap > 0,
        )
    items = _carry_headings(
        [
            {"id": c.id, "text": c.text, "sources": c.metadata.orig_elements or [], "filename": c.metadata.filename,
             "page": c.metadata.page_number}
            for c in chunks
        ]
    )
    out = []
    for i, c in enumerate(items):
        sources = c["sources"]
        pages = sorted({o.metadata.page_number for o in sources if o.metadata.page_number})
        langs = sorted({lang for o in sources for lang in (o.metadata.languages or [])})
        out.append(
            {
                "chunk_id": f"{c['id']}",
                "index": i,
                "text": c["text"],
                # the same chunk as Markdown (headings, tables, right-to-left Arabic), for display
                "markdown": elements_to_md(sources, exclude_binary_image_data=True, rtl_aware=True)
                if sources
                else c["text"],
                "metadata": {
                    "filename": c["filename"],
                    "page_numbers": pages or ([c["page"]] if c["page"] else []),
                    "languages": langs,
                    "element_types": sorted({o.category for o in sources}),
                    "element_ids": [o.id for o in sources],
                },
            }
        )
    return out, method


def _carry_headings(items: list[dict]) -> list[dict]:
    """Move headings that end a chunk to the start of the next one, so a heading is always embedded
    with its section's text. This happens where a heading is followed by a table or by text too long
    for one chunk, which the chunkers then start in a chunk of their own."""
    for prev, nxt in zip(items, items[1:]):
        src = prev["sources"]
        k = len(src)
        # a "Title" that finishes the sentence before it is a split line, not a heading
        while k > 0 and src[k - 1].category == "Title" and not (k > 1 and continues(src[k - 2].text, src[k - 1].text)):
            k -= 1
        moved = prev["sources"][k:]
        heading = "\n\n".join(o.text for o in moved)
        # the Fast tier labels some table rows and list lines as Title: move real heading runs only
        if not moved or len(moved) > 3 or len(heading) > 300 or not prev["text"].endswith(heading):
            continue
        prev["sources"] = prev["sources"][:k]
        prev["text"] = prev["text"][: len(prev["text"]) - len(heading)].rstrip()
        nxt["sources"] = moved + nxt["sources"]
        nxt["text"] = f"{heading}\n\n{nxt['text']}"
    return [c for c in items if c["text"]]


def _semantic_chunks(body: list) -> list | None:
    """Topic-coherent groups of elements, each made into chunks under the hard max (an oversized
    element or a table is still split). None when the model is unavailable, so the job falls back
    to heading-based chunks instead of failing."""
    try:
        import semantic

        groups = semantic.group_elements(body, RAG_CHUNK_MAX_CHARS, RAG_CHUNK_COMBINE_UNDER)
    except Exception:
        log.exception("semantic chunking failed: using heading-based chunks")
        return None
    return [
        c
        for g in groups
        for c in chunk_elements(g, max_characters=RAG_CHUNK_MAX_CHARS, new_after_n_chars=RAG_CHUNK_MAX_CHARS)
    ]


_SENTENCE_GOES_ON = re.compile(r"[,;\-–(]\s*$")
_LOWER_START = re.compile(r"^\s*[(\[]?[a-z]")


def continues(text: str, next_text: str) -> bool:
    """True where the PDF split one sentence over two elements: the next element starts in lowercase
    (or with an opening bracket and lowercase), or this one ends mid-clause on a comma or hyphen."""
    return bool(_LOWER_START.match(next_text) or _SENTENCE_GOES_ON.search(text))
