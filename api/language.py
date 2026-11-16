"""Element languages: Indonesian, English, or Arabic (by script).

langdetect, which unstructured uses per element, is unreliable here: it labels much Indonesian prose
as Afrikaans and short headings as anything. The documents are Indonesian or English (with Arabic
passages), so the label is decided from frequent function words instead, and short or unclear text
takes the document's language.
"""

from __future__ import annotations

import collections
import re

INDONESIAN_WORDS = frozenset(
    "yang dan dengan untuk dalam ini itu pada adalah dari tidak akan atau juga oleh sebagai karena "
    "dapat serta telah tersebut secara bagi ke di".split()
)
ENGLISH_WORDS = frozenset(
    "the and of to in is for with that this are be as on by from an or it was which at not can".split()
)
_ARABIC_LETTER = re.compile(r"[ء-يٱ-ۓ]")
_LATIN_LETTER = re.compile(r"[A-Za-z]")
_WORD = re.compile(r"[a-z]+")
# function-word hits needed before an element's own text decides its language
MIN_HITS = 3

NAMES = {"ind": "Indonesian", "eng": "English", "ara": "Arabic"}


def _counts(text: str) -> tuple[int, int]:
    words = _WORD.findall(text.lower())
    return sum(w in INDONESIAN_WORDS for w in words), sum(w in ENGLISH_WORDS for w in words)


def is_arabic(text: str) -> bool:
    return len(_ARABIC_LETTER.findall(text)) > len(_LATIN_LETTER.findall(text))


def document_language(texts: list[str]) -> str:
    """"ind" or "eng" for a document's Latin-script text (Indonesian when unclear)."""
    ind = eng = 0
    for t in texts:
        i, e = _counts(t)
        ind, eng = ind + i, eng + e
    return "eng" if eng > ind else "ind"


def element_language(text: str, main: str) -> str:
    """"ara" for Arabic script; else "ind" or "eng" when the text clearly says so; else `main`."""
    if is_arabic(text):
        return "ara"
    ind, eng = _counts(text)
    if max(ind, eng) >= MIN_HITS and max(ind, eng) >= 2 * min(ind, eng):
        return "ind" if ind > eng else "eng"
    return main


def label(elements: list[dict]) -> None:
    """Set every element's metadata.languages to ["ind"], ["eng"] or ["ara"], in place."""
    main = document_language([e.get("text") or "" for e in elements if not is_arabic(e.get("text") or "")])
    for e in elements:
        e["metadata"]["languages"] = [element_language(e.get("text") or "", main)]


def counts_summary(elements: list[dict]) -> dict[str, int]:
    return dict(collections.Counter((e["metadata"].get("languages") or ["-"])[0] for e in elements))
