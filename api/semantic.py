"""Semantic chunking for the Fast tier: chunk boundaries fall where the topic changes, not only at headings.

Uses LangChain's SemanticChunker breakpoint logic with multilingual-e5-small embeddings computed
in-process (Arabic, Indonesian and English documents split the same way). The unit is the parsed
element rather than a regex-split sentence, so every chunk still knows which elements and pages it
came from. The embeddings only measure the distance between neighbouring elements; nothing is stored.

Runs in the Fast worker on Cloud Run (deploy-fast-worker.ps1 copies this file there and bakes the
model into the image), so it needs sentence-transformers and langchain-experimental only there.
On a real 88-page report, e5-small put 93% of its breaks where BGE-M3 did, at a fifth of the size.
"""

from __future__ import annotations

import logging
import re
import threading
import warnings
from typing import Any

from chunking import continues
from langchain_core.embeddings import Embeddings

with warnings.catch_warnings():
    # langchain-experimental warns on import that it is no longer maintained
    warnings.simplefilter("ignore", DeprecationWarning)
    from langchain_experimental.text_splitter import SemanticChunker

EMBED_MODEL = "intfloat/multilingual-e5-small"
# E5 is trained with task prefixes; "query: " is the one for symmetric comparisons like ours
# (it beat "passage: " and no prefix: 93% vs 90-92% of BGE-M3's breaks)
EMBED_PREFIX = "query: "
# tokens embedded per element: enough to tell topics apart (512 gave the same breaks, slower)
EMBED_MAX_TOKENS = 256
# a distance above this percentile of the document's neighbour distances starts a new chunk.
# At 90 most breaks were forced by the size cap rather than by a topic change.
BREAKPOINT_PERCENTILE = 70.0
# neighbours on either side embedded with each element. 0 keeps topic shifts sharp: on a real
# 88-page report it put 57% of breaks right before a heading, against 46% with 1 and 36% with 2
BUFFER_SIZE = 0
# added to the break score before a heading, so chunks start at section boundaries (distances run
# about 0.1-0.3, so a heading break wins unless the text runs on one topic across it)
HEADING_BONUS = 0.1

_model_lock = threading.Lock()
_model: Any = None


def _get_model() -> Any:
    """The embedding model, loaded on first use and kept for the life of the process."""
    global _model
    with _model_lock:
        if _model is None:
            from sentence_transformers import SentenceTransformer

            model = SentenceTransformer(EMBED_MODEL, device="cpu")
            model.max_seq_length = EMBED_MAX_TOKENS
            # the first encode is slow (allocations, kernel selection): pay it here, under the lock
            model.encode([EMBED_PREFIX + "warm up"], normalize_embeddings=True)
            _model = model
        return _model


def warm_up() -> None:
    """Load the model ahead of the first request (the Fast worker calls this at startup)."""
    try:
        _get_model()
    except Exception:
        logging.getLogger("bluesandai.semantic").exception("could not load %s", EMBED_MODEL)


class E5Embeddings(Embeddings):
    """multilingual-e5-small in-process, L2-normalised, with E5's task prefix."""

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vectors = _get_model().encode(
            [EMBED_PREFIX + t for t in texts], batch_size=32, normalize_embeddings=True, convert_to_numpy=True
        )
        return vectors.tolist()

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


def group_elements(
    elements: list, max_chars: int, min_chars: int, percentile: float = BREAKPOINT_PERCENTILE
) -> list[list]:
    """Split consecutive elements into topic-coherent groups."""
    if len(elements) < 3:
        return [elements] if elements else []
    chunker = SemanticChunker(
        E5Embeddings(),
        buffer_size=BUFFER_SIZE,
        breakpoint_threshold_type="percentile",
        breakpoint_threshold_amount=percentile,
    )
    # images and tables without text still need a unit to embed
    texts = [(e.text or "").strip() or e.category for e in elements]
    distances, _ = chunker._calculate_sentence_distances(texts)
    threshold, _ = chunker._calculate_breakpoint_threshold(distances)
    cuts = split_points(texts, [e.category == "Title" for e in elements], distances, threshold, max_chars, min_chars)
    bounds = [0, *[c + 1 for c in cuts], len(elements)]
    return [elements[a:b] for a, b in zip(bounds, bounds[1:])]


def split_points(
    texts: list[str],
    is_title: list[bool],
    distances: list[float],
    threshold: float,
    max_chars: int,
    min_chars: int,
    heading_bonus: float = HEADING_BONUS,
) -> list[int]:
    """Indices i after which a group ends. A break scores the embedding distance to the next element,
    plus `heading_bonus` when the next element is a heading, so chunks follow the document's sections
    and topic shifts split them further. A group ends where the score is above `threshold`; when it
    would pass `max_chars` first, it ends at its best-scoring point instead of wherever the limit
    falls. No break leaves a group under `min_chars`, separates a heading from the text after it, or
    falls inside a sentence the PDF split across elements."""
    n = len(texts)
    no_break = [
        (is_title[i] and not (is_title[i + 1] and starts_section(texts[i + 1], texts[i])))
        or continues(texts[i], texts[i + 1])
        for i in range(n - 1)
    ]
    # chunk text joins elements with a blank line: count it, or a group can pass the limit
    lengths = [len(t) + 2 for t in texts]
    score = [distances[i] + (heading_bonus if is_title[i + 1] else 0.0) for i in range(n - 1)]
    cuts: list[int] = []
    start = 0
    size = 0
    for i in range(n - 1):
        size += lengths[i]
        if not no_break[i] and size >= min_chars and score[i] > threshold:
            cuts.append(i)
            start, size = i + 1, 0
        elif size + lengths[i + 1] > max_chars:
            prefix, candidates = 0, []
            for j in range(start, i + 1):
                prefix += lengths[j]
                if not no_break[j] and prefix >= min_chars:
                    candidates.append(j)
            if not candidates:
                # a short group before a long element, or one long sentence: end it where it least hurts
                candidates = [j for j in range(start, i + 1) if not is_title[j]] or [i]
            cut = max(candidates, key=lambda j: score[j])
            cuts.append(cut)
            start, size = cut + 1, sum(lengths[cut + 1 : i + 1])
    return cuts


_SECTION_HEADING = re.compile(r"^\s*(?:(?:BAB|Bab|CHAPTER|Chapter|PART|Part)\b|\d+(?:\.\d+)*\.?\s+\S|[IVXLC]+\.\s+\S)")


def starts_section(heading: str, previous_heading: str) -> bool:
    """A numbered section heading ("BAB II", "3.2 Metode", "IV. Hasil") after a heading that is not
    one: the Fast tier also labels table rows and list lines as Title, and a section can start right
    after them. Two numbered headings in a row ("BAB I" then "1.1 Latar Belakang") stay together."""
    return bool(_SECTION_HEADING.match(heading)) and not _SECTION_HEADING.match(previous_heading)
