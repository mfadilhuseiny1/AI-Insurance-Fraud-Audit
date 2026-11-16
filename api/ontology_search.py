"""Ontology search syntax and derived properties, modelled on Foundry's "Search syntax" and "Derived properties" pages.

Search syntax (Object Explorer, Workshop filter lists, the Ontology search app):
- Keyword search: the query is split into terms (whitespace) and quoted phrases; every term must match the title,
  the primary key or a searchable property (case-insensitive). A term with `*` (any characters) or `?` (one
  character) is a wildcard matched against each word of a value. A term starting with a wildcard is a leading
  wildcard: it only searches properties with the "Leading wildcards" render hint.
- Regular expressions (filter op "regex") use Lucene's regex syntax, as the Ontology does: the pattern matches the
  whole value (`cat` matches only "cat"; `.*cat.*` finds it anywhere), `^` and `$` are not supported, `"..."` is a
  literal string, and `. ? + * {n,m} | () [] \\d \\D \\s \\S \\w \\W` work as usual. A string property needs the
  "Regex queries" render hint (Properties → Interaction → Enable regex queries).
- Wildcard filters (op "wildcard") match a whole value with `*` and `?`, case-insensitively.

Derived properties (Beta in Foundry, the OSDK's `withProperties`): properties computed at query time from an object's
linked objects — an aggregation over a link type (count, sum, avg, min, max, exact / approximate distinct count,
collect list / set) or a property of the one linked object (select). They can then be filtered, sorted and aggregated
in the same request, and only see linked objects the user can see. As in Foundry, they cannot be used in text search.

Used by ontology_explorer.py (POST /api/ontology/explorer/search); POST /api/ontology/search/regex checks a pattern.
"""

from __future__ import annotations

import functools
import re
import unicodedata
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import ontology

router = APIRouter(prefix="/api/ontology")

DERIVED_METRICS = ("count", "sum", "avg", "min", "max", "exact_distinct", "approximate_distinct", "collect_list", "collect_set", "select")
COLLECT_LIMIT = 100
NUMERIC = ("integer", "long", "short", "byte", "double", "float", "decimal")
_SHORTHAND = set("dDsSwW")


# ------------------------------------------------------------------------------------------------
# regular expressions (Lucene syntax)
# ------------------------------------------------------------------------------------------------


def lucene_to_python(pattern: str) -> str:
    """Translate a Lucene regular expression to a Python one (matched with fullmatch)."""
    out: list[str] = []
    i, n = 0, len(pattern)
    depth = 0
    while i < n:
        c = pattern[i]
        if c == '"':
            end = pattern.find('"', i + 1)
            if end < 0:
                raise ValueError('an opening " has no closing "')
            out.append("(?:" + re.escape(pattern[i + 1:end]) + ")")
            i = end + 1
            continue
        if c == "\\":
            if i + 1 >= n:
                raise ValueError("the pattern ends with \\")
            nxt = pattern[i + 1]
            out.append("\\" + nxt if nxt in _SHORTHAND else re.escape(nxt))
            i += 2
            continue
        if c in "^$":
            raise ValueError(f"the {c} anchor is not supported: a pattern always matches the whole value")
        if c == "[":
            end = i + 1
            if end < n and pattern[end] == "^":
                end += 1
            if end < n and pattern[end] == "]":
                end += 1
            while end < n and pattern[end] != "]":
                end += 2 if pattern[end] == "\\" else 1
            if end >= n:
                raise ValueError("a [ has no closing ]")
            body = pattern[i + 1:end]
            neg = body.startswith("^")
            body = body[1:] if neg else body
            # a literal [ inside a class needs escaping in Python
            body = body.replace("[", "\\[")
            out.append("[" + ("^" if neg else "") + body + "]")
            i = end + 1
            continue
        if c == "(":
            if pattern[i + 1:i + 2] == "?":
                raise ValueError("(? groups are not supported")
            depth += 1
            out.append("(")
        elif c == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("a ) has no opening (")
            out.append(")")
        elif c in ".?+*|":
            out.append(c)
        elif c == "{":
            m = re.match(r"\{(\d+)(,(\d*))?\}", pattern[i:])
            if not m:
                raise ValueError("{ must be {n}, {n,} or {n,m}")
            out.append(m.group(0))
            i += len(m.group(0))
            continue
        else:
            out.append(re.escape(c))
        i += 1
    if depth:
        raise ValueError("a ( has no closing )")
    return "".join(out)


@functools.lru_cache(maxsize=256)
def compile_regex(pattern: str) -> re.Pattern:
    try:
        return re.compile(lucene_to_python(pattern), re.DOTALL)
    except (ValueError, re.error) as e:
        raise HTTPException(400, f"Invalid regular expression {pattern!r}: {e}") from None


def regex_match(pattern: str, value: Any) -> bool:
    if value is None:
        return False
    return compile_regex(str(pattern)).fullmatch(str(value)) is not None


# ------------------------------------------------------------------------------------------------
# wildcards and keyword queries
# ------------------------------------------------------------------------------------------------


@functools.lru_cache(maxsize=256)
def _glob(term: str) -> re.Pattern:
    return re.compile("".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in term), re.IGNORECASE | re.DOTALL)


def wildcard_match(pattern: str, value: Any) -> bool:
    return value is not None and _glob(str(pattern)).fullmatch(str(value)) is not None


def leading(term: str) -> bool:
    return term[:1] in ("*", "?")


def parse_query(q: str) -> list[dict]:
    """Terms of a keyword query: {"text", "phrase", "wildcard"}."""
    terms = []
    for m in re.finditer(r'"([^"]*)"|(\S+)', q or ""):
        if m.group(1) is not None:
            if m.group(1).strip():
                terms.append({"text": m.group(1).strip(), "phrase": True, "wildcard": False})
        else:
            text = m.group(2)
            terms.append({"text": text, "phrase": False, "wildcard": "*" in text or "?" in text})
    return terms


_WORD = re.compile(r"[^\s,;:()\[\]{}\"']+")


# Language analyzers (Foundry's Language analyzer: english, french, german, japanese, korean, arabic,
# combined_arabic_english; and a few more Lucene ships) are below, after the Indonesian one.
LANGUAGE_ANALYZERS = ("french", "german", "spanish", "portuguese", "italian", "dutch", "russian", "arabic",
                      "combined_arabic_english", "japanese", "korean", "chinese")
ANALYZERS = ("not_analyzed", "not_indexed", "whitespace", "simple", "standard", "english", "indonesian") + LANGUAGE_ANALYZERS
_SUFFIXES = ("ing", "edly", "ed", "es", "s", "ly")


def analyzer(p: Optional[dict]) -> Optional[str]:
    """A property's analyzer: the Interaction setting, or the (deprecated) analyzer:<name> type class."""
    if not p:
        return None
    if p.get("analyzer"):
        return p["analyzer"]
    for tc in p.get("type_classes") or []:
        if tc.startswith("analyzer:") and tc.split(":", 1)[1] in ANALYZERS:
            return tc.split(":", 1)[1]
    return None


def _stem(w: str) -> str:
    for s in _SUFFIXES:
        if len(w) > len(s) + 2 and w.endswith(s):
            return w[: -len(s)]
    return w


# Indonesian: without a root dictionary affixes are ambiguous ("perawatan" is pe-rawat-an, "berobat" ber-obat,
# "diagnosa" no affix at all), so a word gives every plausible root — particles (-lah, -kah, -tah, -pun), possessives
# (-ku, -mu, -nya), up to two prefixes (di-, ke-, se-, ber-/be-, ter-/te-, per-/pe-, me(N)-/pe(N)- with the root's
# first consonant restored or not) and a suffix (-kan, -an, -i) — and a query word matches when its roots and the
# text's overlap (or, as with the standard analyzer, the text word starts with it).
_ID_PARTICLES = ("lah", "kah", "tah", "pun")
_ID_POSSESSIVES = ("nya", "ku", "mu")
_ID_SUFFIXES = ("kan", "an", "i")
_ID_PREFIXES = (("meng", ("", "k")), ("meny", ("s",)), ("mem", ("p", "")), ("men", ("t", "")), ("me", ("",)), ("peng", ("", "k")), ("peny", ("s",)),
                ("pem", ("p", "")), ("pen", ("t", "")), ("per", ("",)), ("pe", ("",)), ("ber", ("",)), ("be", ("",)), ("ter", ("",)), ("te", ("",)),
                ("di", ("",)), ("ke", ("",)), ("se", ("",)))
_ID_MIN = 3


def _roots_id(word: str) -> set[str]:
    """Every plausible Indonesian root of a word (the word itself included)."""
    def ends(ws: set[str], tails: tuple) -> set[str]:
        return ws | {w[: -len(t)] for w in ws for t in tails if w.endswith(t) and len(w) - len(t) >= _ID_MIN}

    out = ends(ends({word}, _ID_PARTICLES), _ID_POSSESSIVES)
    frontier = set(out)
    for _ in range(2):  # at most two prefixes (memper-, diper-, keber-)
        nxt = set()
        for w in frontier:
            for pre, restores in _ID_PREFIXES:
                if w.startswith(pre) and len(w) - len(pre) >= _ID_MIN:
                    rest = w[len(pre):]
                    nxt |= {r + rest for r in restores if not r or rest[0] in "aiueo"}
        nxt -= out
        out |= nxt
        frontier = nxt
    return ends(out, _ID_SUFFIXES)


def _id_match(q: str, toks: list[str]) -> bool:
    roots = _roots_id(q)
    return any(t.startswith(q) or roots & _roots_id(t) for t in toks)


# ------------------------------------------------------------------------------------------------
# language analyzers
# ------------------------------------------------------------------------------------------------
#
# Lucene's language analyzers, in Python (no stemming library is installed): width folding (NFKC), lower case,
# elisions (French l' d' qu'…, Italian dell' all'…), the language's stop words, then a light stemmer — Jacques
# Savoy's light stemmers as Lucene ships them for French, German, Spanish, Portuguese, Italian and Russian (the
# Spanish and Italian ones also on four- and five-letter words, which Lucene's leave alone: casa = casas), and a
# light suffix stripper for Dutch (plural -en / -s, final -e, z→s and v→f, doubled consonants and open-syllable
# vowels). Latin letters are folded to plain ones (médecin = medecin, Krankenhäuser = krankenhauser), Russian ё = е.
# Arabic: ArabicNormalizer (harakat and tatweel removed, آ أ إ → ا, ى → ي, ة → ه, Arabic-Indic digits) and
# ArabicStemmer (one prefix of ال وال بال كال فال لل و, then the suffixes ها ان ات ون ين يه ه ي).
# combined_arabic_english stems Arabic words as Arabic and Latin words as English.
# Japanese, Korean, Chinese (and CJK text under any language analyzer): CJKAnalyzer's overlapping bigrams of each
# run of Han / kana / Hangul characters — no dictionary, unlike Kuromoji or Nori — and a run in the query must
# appear as one run of bigrams in the text ("病院" finds "大学病院で", not "病気の院長").
# The same analysis runs on the stored value and on the query. A query word matches a word of the text with the same
# stem, or one that the word as typed starts (search as you type: "hôpit" finds "hôpitaux") — not every word sharing
# the stem's letters, so "Hände" finds "Hand" but not "Handel". A quoted phrase is consecutive stems. A query made
# only of stop words keeps them (rather than matching nothing). Known limits: light stemmers leave verb conjugation
# and irregular plurals alone (French mangent ≠ manger, travaux ≠ travail; Dutch glazen ≠ glas), German compounds are
# not split (Haus does not find Krankenhaus), accents are not significant (Spanish año = ano), and CJK bigrams find a
# pair of characters wherever it stands (京都 inside 東京都).

_CJK = "ᄀ-ᇿ々-〇぀-ヿ㄰-㆏ㇰ-ㇿ㐀-䶿一-鿿가-힯豈-﫿"
_LANG_TOKEN = re.compile(f"([{_CJK}]+)|([^\\W_{_CJK}]+)")
_ELISION = {
    "french": re.compile(r"\b(?:l|d|m|t|n|s|j|c|qu|jusqu|quoiqu|lorsqu|puisqu)['’]"),
    "italian": re.compile(r"\b(?:c|l|all|dall|dell|nell|sull|coll|pell|gl|agl|dagl|degl|negl|sugl|un|m|t|s|v|d|quest|quell|po)['’]"),
}
_STOP_TEXT = {
    "english": "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with",
    "french": "a au aux avec ce ces dans de des du elle en et eux il ils je la le les leur lui ma mais me même mes moi mon ne nos notre "
              "nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous y à été est sont était être ont",
    "german": "aber alle als also am an auch auf aus bei bin bis bist da damit dann das dass dem den der des die dies diese dieser doch dort "
              "du durch ein eine einem einen einer eines er es für hat hatte ich ihr im in ist ja kein mit nach nicht noch nur oder sich "
              "sie sind so über um und uns unter vom von vor war wie wir wird wo zu zum zur",
    "spanish": "a al algo como con cuando de del el ella ellos en entre es esta este esto está están fue ha han la las le les lo los más "
               "mi muy no nos o para pero por que se ser si sin sobre son su sus también un una uno unos y ya yo",
    "portuguese": "a ao aos as com como da das de do dos e ela ele eles em entre era foi mais mas na nas no nos o os ou para pela pelo "
                  "por que se sem seu sua são também um uma é",
    "italian": "a ad agli ai al alla alle che chi col come con da dal dalla dei del della delle degli di e ed gli i il in la le lo ma ne "
               "nel nella non o per più se si sono su sul sulla tra un una uno è",
    "dutch": "aan al als bij dat de der deze die dit door een en er had heb hebben heeft het hij hoe ik in is je kan maar met naar niet "
             "nog of om ook op over s te tot uit van voor was wat we wel wie wij zal ze zich zij zijn",
    "russian": "а без более бы был была были было быть в вам вас ведь во вот все всех вы где да для до его ее ей если есть еще же за "
               "здесь и из или им их к как когда кто ли между мне может мы на над нам нас не него нее нет ни них но ну о об однако "
               "он она они оно от по под после при про с со так также там то того тоже только том ты у уже чем что чтобы эта эти "
               "этим это этого этой этот я",
    "arabic": "في من على إلى عن مع هذا هذه ذلك تلك التي الذي الذين اللذين كان كانت يكون هو هي هم هما ما لا لم لن قد ثم أو أن إن كل "
              "بعد قبل بين حتى عند غير وقد ولا وهو وهي و او ان كما لكن بل",
}
_STOP_TEXT["combined_arabic_english"] = _STOP_TEXT["arabic"] + " " + _STOP_TEXT["english"]
_VOWELS = set("aeiouy")


def _fold_latin(w: str) -> str:
    """Latin letters without their diacritics (é → e, ä → a, ç → c, œ → oe); other scripts unchanged."""
    if w.isascii():
        return w
    w = w.replace("œ", "oe").replace("æ", "ae").replace("ø", "o")
    out: list[str] = []
    for ch in unicodedata.normalize("NFD", w):
        if unicodedata.combining(ch) and out and out[-1] < "ɐ":
            continue
        out.append(ch)
    return unicodedata.normalize("NFC", "".join(out))


_AR_NORM = str.maketrans({"آ": "ا", "أ": "ا", "إ": "ا", "ى": "ي", "ة": "ه", "ـ": None,
                          **{chr(c): None for c in range(0x064B, 0x0653)}, "ٰ": None,
                          **{chr(0x0660 + i): str(i) for i in range(10)}, **{chr(0x06F0 + i): str(i) for i in range(10)}})


def _ar_normalize(text: str) -> str:
    return text.translate(_AR_NORM)


_AR_PREFIXES = ("ال", "وال", "بال", "كال", "فال", "لل", "و")
_AR_SUFFIXES = ("ها", "ان", "ات", "ون", "ين", "يه", "ية", "ه", "ة", "ي")


def _ar_stem(s: str) -> str:
    for p in _AR_PREFIXES:
        if s.startswith(p) and (len(s) >= 4 if len(p) == 1 else len(s) >= len(p) + 2):
            s = s[len(p):]
            break
    for x in _AR_SUFFIXES:
        if s.endswith(x) and len(s) >= len(x) + 2:
            s = s[: -len(x)]
    return s


def _fr_norm(s: str) -> str:
    if len(s) > 4:
        out = s[0]
        for ch in s[1:]:
            if not (ch == out[-1] and ch.isalpha()):
                out += ch
        s = out
    if len(s) > 4 and s.endswith("ie"):
        s = s[:-2]
    if len(s) > 4:
        if s[-1] == "r":
            s = s[:-1]
        if s[-1] == "e":
            s = s[:-1]
        if s[-1] == "e":
            s = s[:-1]
        if s[-1] == s[-2] and s[-1].isalpha():
            s = s[:-1]
    return s


def _fr_stem(s: str) -> str:
    """Lucene's FrenchLightStemmer on a folded word (è, é, ê already e)."""
    if len(s) > 5 and s[-1] == "x":
        if s[-3] == "a" and s[-2] == "u" and s[-4] != "e":
            s = s[:-2] + "l" + s[-1]
        s = s[:-1]
    if len(s) > 3 and s[-1] == "x":
        s = s[:-1]
    if len(s) > 3 and s[-1] == "s":
        s = s[:-1]
    n, e = len(s), s.endswith
    if n > 9 and e("issement"):
        return _fr_norm(s[:-7] + "r")
    if n > 8 and e("issant"):
        return _fr_norm(s[:-5] + "r")
    if n > 6 and e("ement"):
        s = s[:-4]
        if len(s) > 3 and s.endswith("ive"):
            s = s[:-2] + "f"
        return _fr_norm(s)
    if n > 11 and e("ficatrice"):
        return _fr_norm(s[:-7] + "er")
    if n > 10 and e("ficateur"):
        return _fr_norm(s[:-6] + "er")
    if n > 9 and e("catrice"):
        return _fr_norm(s[:-7] + "quer")
    if n > 8 and e("cateur"):
        return _fr_norm(s[:-6] + "quer")
    if n > 8 and e("atrice"):
        return _fr_norm(s[:-6] + "er")
    if n > 7 and e("ateur"):
        return _fr_norm(s[:-5] + "er")
    if n > 6 and e("trice"):
        s = s[:-5] + "teur"
        n, e = len(s), s.endswith
    if n > 5 and e("ieme"):
        return _fr_norm(s[:-4])
    if n > 7 and e("teuse"):
        return _fr_norm(s[:-3] + "r")
    if n > 6 and e("teur"):
        return _fr_norm(s[:-2] + "r")
    if n > 5 and e("euse"):
        return _fr_norm(s[:-2])
    if n > 8 and e("ere"):
        return _fr_norm(s[:-1])
    if n > 7 and e("ive"):
        return _fr_norm(s[:-2] + "f")
    if n > 4 and (e("folle") or e("molle")):
        return _fr_norm(s[:-3] + "u")
    if n > 9 and e("nnelle"):
        return _fr_norm(s[:-5])
    if n > 9 and e("nnel"):
        return _fr_norm(s[:-3])
    if n > 4 and e("ete"):
        s = s[:-1]
        n = len(s)
    if n > 8 and s.endswith("ique"):
        s = s[:-4]
        n = len(s)
    if n > 8 and s.endswith("esse"):
        return _fr_norm(s[:-3])
    if n > 7 and s.endswith("inage"):
        return _fr_norm(s[:-3])
    if n > 9 and s.endswith("isation"):
        s = s[:-7]
        if len(s) > 5 and s.endswith("ual"):
            s = s[:-2] + "el"
        return _fr_norm(s)
    if n > 9 and s.endswith("isateur"):
        return _fr_norm(s[:-7])
    if n > 8 and (s.endswith("ation") or s.endswith("ition")):
        return _fr_norm(s[:-5])
    return _fr_norm(s)


_DE_ST = set("bdfghklmnt")


def _de_stem(s: str) -> str:
    """Lucene's GermanLightStemmer on a folded word (ä → a, ß → ss)."""
    if len(s) > 5 and s.endswith("ern"):
        s = s[:-3]
    elif len(s) > 4 and s[-2] == "e" and s[-1] in "mnrs":
        s = s[:-2]
    elif len(s) > 3 and s[-1] == "e":
        s = s[:-1]
    elif len(s) > 3 and s[-1] == "s" and s[-2] in _DE_ST:
        s = s[:-1]
    if len(s) > 5 and s.endswith("est"):
        s = s[:-3]
    elif len(s) > 4 and s[-2] == "e" and s[-1] in "rn":
        s = s[:-2]
    elif len(s) > 4 and s.endswith("st") and s[-3] in _DE_ST:
        s = s[:-2]
    return s


def _es_stem(s: str) -> str:
    """Lucene's SpanishLightStemmer on a folded word; unlike Lucene's, a four-letter word loses its final vowel too
    (casa = casas, niño = niñas)."""
    if len(s) < 4:
        return s
    if s[-1] in "oae":
        return s[:-1]
    if s[-1] == "s" and len(s) > 4:
        if s.endswith("eses"):
            return s[:-2]
        if s.endswith("ces"):
            return s[:-3] + "z"
        if s[-2] in "oae":
            return s[:-2]
    return s


def _pt_stem(s: str) -> str:
    """Lucene's PortugueseLightStemmer (on the word with its accents; folded at the end)."""
    if len(s) < 4:
        return _fold_latin(s)
    e = s.endswith
    if len(s) > 4 and e("es") and s[-3] in "rslz":
        s = s[:-2]
    elif len(s) > 3 and e("ns"):
        s = s[:-2] + "m"
    elif len(s) > 4 and (e("eis") or e("éis")):
        s = s[:-3] + "el"
    elif len(s) > 4 and e("ais"):
        s = s[:-2] + "l"
    elif len(s) > 4 and e("óis"):
        s = s[:-3] + "ol"
    elif len(s) > 4 and e("is"):
        s = s[:-1] + "l"
    elif len(s) > 3 and (e("ões") or e("ães")):
        s = s[:-3] + "ão"
    elif len(s) > 6 and e("mente"):
        s = s[:-5]
    elif len(s) > 3 and s[-1] == "s":
        s = s[:-1]
    e = s.endswith
    if len(s) > 3 and s[-1] == "a":
        if len(s) > 7 and (e("inha") or e("iaca") or e("eira")):
            s = s[:-1] + "o"
        elif len(s) > 6:
            if e("osa") or e("ica") or e("ida") or e("ada") or e("iva") or e("ama"):
                s = s[:-1] + "o"
            elif e("ona"):
                s = s[:-3] + "ão"
            elif e("ora"):
                s = s[:-1]
            elif e("esa"):
                s = s[:-3] + "ês"
            elif e("na"):
                s = s[:-1] + "o"
    if len(s) > 4 and s[-1] in "eao":
        s = s[:-1]
    return _fold_latin(s)


def _it_stem(s: str) -> str:
    """Lucene's ItalianLightStemmer on a folded word; unlike Lucene's (six letters and more), from four letters on,
    as long as three remain (casa = case, amica = amiche)."""
    if len(s) < 4:
        return s
    last, prev = s[-1], s[-2]
    cut = 0
    if last == "e":
        cut = 2 if prev in "ih" else 1
    elif last == "i":
        cut = 2 if prev in "hi" else 1
    elif last in "ao":
        cut = 2 if prev == "i" else 1
    while cut and len(s) - cut < 3:
        cut -= 1
    return s[:-cut] if cut else s


def _nl_stem(s: str) -> str:
    """Dutch, light: plural -en / -heden / -s (after -el -em -en -er -je), final -e; z → s and v → f, doubled
    consonants undoubled, an open syllable's a / o / u doubled (bomen → boom, jaren → jaar) and its e when it is the
    stem's only vowel (benen → been, but wandelen → wandel)."""
    def settle(w: str) -> str:
        if len(w) > 2 and w[-1] == w[-2] and w[-1] not in _VOWELS:
            return w[:-1]
        if w[-1:] == "z":
            w = w[:-1] + "s"
        elif w[-1:] == "v":
            w = w[:-1] + "f"
        if len(w) >= 3 and w[-1] not in _VOWELS and w[-3] not in _VOWELS and (
                w[-2] in "aou" or (w[-2] == "e" and not any(c in _VOWELS for c in w[:-2]))):
            w = w[:-1] + w[-2] + w[-1]
        return w

    if len(s) > 6 and s.endswith("heden"):
        return s[:-5] + "heid"
    if len(s) > 4 and s.endswith("en") and s[-3] not in _VOWELS:
        return settle(s[:-2])
    if len(s) > 4 and s[-1] == "s" and s[-3:-1] in ("el", "em", "en", "er", "je"):
        s = s[:-1]
    if len(s) > 3 and s[-1] == "e" and s[-2] not in _VOWELS:
        return settle(s[:-1])
    return s


_RU_3 = ("иям", "иях", "оях", "ями", "оям", "оьв", "ами", "его", "ему", "ери", "ими", "ого", "ому", "ыми", "оев")
_RU_2 = ("ая", "яя", "ях", "юю", "ах", "ею", "их", "ия", "ию", "ьв", "ою", "ую", "ям", "ых", "ея", "ам", "ем", "ей", "ём", "ев",
         "ий", "им", "ое", "ой", "ом", "ов", "ые", "ый", "ым", "ми")


def _ru_stem(s: str) -> str:
    """Lucene's RussianLightStemmer (ё read as е)."""
    s = s.replace("ё", "е")
    if len(s) > 6 and s.endswith(("иями", "оями")):
        s = s[:-4]
    elif len(s) > 5 and s.endswith(_RU_3):
        s = s[:-3]
    elif len(s) > 4 and s.endswith(_RU_2):
        s = s[:-2]
    elif len(s) > 3 and s[-1] in "аеиоуйыяь":
        s = s[:-1]
    if len(s) > 3 and (s[-1] in "ьи" or s.endswith("нн")):
        s = s[:-1]
    return s


_STEMMERS = {"french": lambda w: _fr_stem(_fold_latin(w)), "german": lambda w: _de_stem(_fold_latin(w)),
             "spanish": lambda w: _es_stem(_fold_latin(w)), "portuguese": _pt_stem, "italian": lambda w: _it_stem(_fold_latin(w)),
             "dutch": lambda w: _nl_stem(_fold_latin(w)), "russian": _ru_stem}
_ARABIC_LETTER = re.compile(r"[؀-ۿݐ-ݿ]")


def _stop_words(how: str) -> frozenset:
    return frozenset(_fold_latin(_ar_normalize(w)).replace("ё", "е") for w in _STOP_TEXT.get(how, "").split())


_STOPS = {how: _stop_words(how) for how in _STOP_TEXT}


def _lang_word(w: str, how: str) -> str:
    if how in ("arabic", "combined_arabic_english") and _ARABIC_LETTER.search(w):
        return _ar_stem(w)
    if how == "combined_arabic_english":
        return _stem(_fold_latin(w)) if w.isalpha() else w
    stem = _STEMMERS.get(how)
    if stem and w.isalpha():
        return stem(w)
    return _fold_latin(w)


@functools.lru_cache(maxsize=8192)
def analyze(text: str, how: str, keep_stops: bool = False) -> tuple[tuple[str, int, str], ...]:
    """A language analyzer's tokens of a text: (token, run, word) — run is 0 for words, the same number for the
    bigrams of one CJK run; word is the folded word before stemming (the token itself for a bigram)."""
    text = unicodedata.normalize("NFKC", text).casefold()
    if how in ("arabic", "combined_arabic_english"):
        text = _ar_normalize(text)
    if how in _ELISION:
        text = _ELISION[how].sub("", text)
    stops = () if keep_stops else _STOPS.get(how, ())
    out: list[tuple[str, int, str]] = []
    run = 0
    for m in _LANG_TOKEN.finditer(text):
        cjk = m.group(1)
        if cjk:
            run += 1
            out += [(cjk, run, cjk)] if len(cjk) == 1 else [(cjk[i:i + 2], run, cjk[i:i + 2]) for i in range(len(cjk) - 1)]
            continue
        w = _fold_latin(m.group(2)).replace("ё", "е")
        if stops and w in stops:
            continue
        out.append((_lang_word(m.group(2), how), 0, w))
    return tuple(out)


def _groups(toks: tuple[tuple[str, int, str], ...]) -> list[tuple[list[str], bool, str]]:
    """Query tokens as groups: a word alone (its token and the word as typed), or the bigrams of one CJK run (which
    must appear together)."""
    out: list[tuple[list[str], bool, str]] = []
    prev = 0
    for tok, run, word in toks:
        if run and run == prev:
            out[-1][0].append(tok)
        else:
            out.append(([tok], bool(run), word))
        prev = run
    return out


def _seq_at(toks: list[str], seq: list[str]) -> bool:
    n = len(seq)
    return any(toks[i:i + n] == seq for i in range(len(toks) - n + 1))


def _lang_hits(term: dict, text: str, how: str) -> bool:
    q = analyze(term["text"], how)
    keep = not q
    if keep:
        q = analyze(term["text"], how, True)
    if not q:
        return False
    found = analyze(text, how, keep)
    toks = [t[0] for t in found]
    if term["phrase"]:
        return _seq_at(toks, [t[0] for t in q])
    for group, cjk, word in _groups(q):
        if not cjk:
            # the same stem, or the word as typed starts a word of the text (or its stem: an Arabic word after its article)
            if not any(t == group[0] or w.startswith(word) or t.startswith(word) for t, _, w in found):
                return False
        elif len(group) == 1 and len(group[0]) == 1:
            if not any(group[0] in t for t in toks):
                return False
        elif not _seq_at(toks, group):
            return False
    return True


def _tokens(text: str, how: str) -> list[str]:
    if how == "whitespace":
        return text.split()
    words = [w.lower() for w in re.findall(r"[A-Za-z0-9]+", text)]
    if how == "english":
        return [_stem(w) for w in words]
    return words


def _term_hits(term: dict, value: Any, how: Optional[str] = None) -> bool:
    if value is None or how == "not_indexed":
        return False
    text = " ".join(str(v) for v in value) if isinstance(value, list) else str(value)
    if term["wildcard"]:
        g = _glob(term["text"])
        return g.fullmatch(text) is not None or any(g.fullmatch(w) for w in _WORD.findall(text))
    if how == "not_analyzed":
        # identifiers: the whole value matches (case-insensitive), not a part of it
        return term["text"].lower() == text.lower()
    if how == "whitespace":
        return term["text"] in _tokens(text, how)
    if how in LANGUAGE_ANALYZERS:
        return _lang_hits(term, text, how)
    if how == "indonesian":
        q = _tokens(term["text"], "simple")
        toks = _tokens(text, "simple")
        if term["phrase"]:
            return bool(q) and any(all(_id_match(x, [toks[i + k]]) for k, x in enumerate(q)) for i in range(len(toks) - len(q) + 1))
        return bool(q) and all(_id_match(x, toks) for x in q)
    if how in ("simple", "standard", "english"):
        q = _tokens(term["text"], how)
        toks = _tokens(text, how)
        return bool(q) and all(any(t.startswith(x) for t in toks) for x in q) if not term["phrase"] else " ".join(q) in " ".join(toks)
    return term["text"].lower() in text.lower()


def keyword_filter(t: dict, rows: list[dict], q: str, searchable: list[str]) -> list[dict]:
    """Rows matching every term of the query (see the module docstring)."""
    terms = parse_query(q)
    if not terms:
        return rows
    leading_ok = [p["api_name"] for p in t["properties"] if p["api_name"] in searchable and "leading_wildcards" in (p.get("render_hints") or [])]
    for term in terms:
        if term["wildcard"] and leading(term["text"]) and not leading_ok:
            raise HTTPException(400, f'"{term["text"]}" starts with a wildcard: enable "Leading wildcards" on a searchable property of '
                                     f'{t["display_name"]} in Ontology Manager (Properties → Interaction)')

    how = {p["api_name"]: analyzer(p) for p in t["properties"]}

    def hit(r: dict, term: dict) -> bool:
        if term["wildcard"] and leading(term["text"]):
            return any(_term_hits(term, r["properties"].get(n), how.get(n)) for n in leading_ok)
        return _term_hits(term, r["title"]) or _term_hits(term, r["primary_key"]) or any(_term_hits(term, r["properties"].get(n), how.get(n)) for n in searchable)

    return [r for r in rows if all(hit(r, term) for term in terms)]


def check_filter(t: dict, prop: str, op: str, value: Any) -> None:
    """A regex or wildcard filter on a property that is not indexed for it."""
    if op not in ("regex", "wildcard"):
        return
    p = next((x for x in t["properties"] if x["api_name"] == prop), None)
    if p is None or p.get("runtime_derived"):
        return
    hints = p.get("render_hints") or []
    if op == "regex":
        if p["type"] not in ("string", "string_array"):
            raise HTTPException(400, f"Regex search needs a string property: {p['display_name']} is {p['type']}")
        if "regex_queries" not in hints:
            raise HTTPException(400, f'{p["display_name"]} is not indexed for regex search: enable "Regex queries" in Ontology Manager '
                                     f"(Properties → Interaction)")
        compile_regex(str(value or ""))
    elif leading(str(value or "")) and "leading_wildcards" not in hints:
        raise HTTPException(400, f'{p["display_name"]} does not allow leading wildcards: enable "Leading wildcards" in Ontology Manager')


class RegexIn(BaseModel):
    pattern: str = Field(max_length=2000)
    samples: list[str] = Field([], max_length=200)


@router.post("/search/regex")
def check_regex(req: RegexIn) -> dict:
    """Check a pattern and show which sample values it matches."""
    try:
        translated = lucene_to_python(req.pattern)
        compiled = re.compile(translated, re.DOTALL)
    except (ValueError, re.error) as e:
        return {"valid": False, "error": str(e), "matches": []}
    return {"valid": True, "error": None, "python": translated, "matches": [s for s in req.samples if compiled.fullmatch(s)]}


# ------------------------------------------------------------------------------------------------
# derived properties
# ------------------------------------------------------------------------------------------------


class DerivedFilter(BaseModel):
    property: str
    op: str = "eq"
    value: Any = None


class DerivedProperty(BaseModel):
    api_name: str = Field(min_length=1, max_length=100)
    link_type_id: str
    direction: Literal["forward", "reverse"] = "forward"
    metric: Literal["count", "sum", "avg", "min", "max", "exact_distinct", "approximate_distinct", "collect_list", "collect_set", "select"] = "count"
    property: Optional[str] = None
    # filters on the linked objects before aggregating
    filters: list[DerivedFilter] = []


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def derived_definitions(t: dict, specs: list[DerivedProperty]) -> list[tuple[DerivedProperty, dict, dict, dict]]:
    """Validate the specs: (spec, link type, linked object type, property definition)."""
    import ontology_model as om

    names = {p["api_name"] for p in t["properties"]}
    out = []
    for s in specs:
        ontology.check_api_name(s.api_name, "derived property")
        if s.api_name in names:
            raise HTTPException(400, f"{t['display_name']} already has a property {s.api_name}")
        names.add(s.api_name)
        lt = ontology._get("link-types", s.link_type_id, "link type")
        start, reach = om.side_of(lt, s.direction)
        if start["object_type_id"] != t["id"]:
            raise HTTPException(400, f"{lt['display_name']} does not start from {t['display_name']}")
        other = ontology._object_type(reach["object_type_id"])
        by = {p["api_name"]: p for p in other["properties"]}
        if s.metric != "count" and s.property not in by:
            raise HTTPException(400, f"{s.api_name}: pick a property of {other['display_name']}")
        if s.metric in ("sum", "avg") and by[s.property]["type"] not in NUMERIC:
            raise HTTPException(400, f"{s.api_name}: {s.metric} needs a numeric property")
        to_one = lt.get("cardinality") == "one_to_one" or (lt.get("cardinality") == "many_to_one" and s.direction == "forward")
        if s.metric == "select" and not to_one:
            raise HTTPException(400, f"{s.api_name}: select needs a link to one object (use collect_list for many)")
        src = by.get(s.property) if s.property else None
        ptype = ("long" if s.metric in ("count", "exact_distinct", "approximate_distinct")
                 else "double" if s.metric in ("sum", "avg")
                 else (src or {}).get("type", "string"))
        prop = {"api_name": s.api_name, "display_name": s.api_name, "type": ptype, "runtime_derived": True,
                "array": s.metric in ("collect_list", "collect_set"), "render_hints": ["selectable"] if ptype == "string" else [],
                "description": f"{s.metric}{'(' + s.property + ')' if s.property else ''} over {reach['display_name']}"}
        out.append((s, lt, other, prop))
    return out


def apply_derived(t: dict, rows: list[dict], specs: list[DerivedProperty]) -> dict:
    """Compute derived properties onto the rows; returns the object type with them added (for filters, sorts and
    aggregations)."""
    if not specs:
        return t
    import ontology_explorer as ox
    import ontology_model as om

    defs = derived_definitions(t, specs)
    pks = {r["primary_key"] for r in rows}
    for s, lt, other, prop in defs:
        linked = om.linked_map(lt, s.direction, pks)
        objs = ontology._objects(other["id"])
        flt = [ox.Filter(property=f.property, op=f.op, value=f.value) for f in s.filters]
        for r in rows:
            reached = [ontology._public_object(other, pk, objs[pk]) for pk in linked.get(r["primary_key"], [])
                       if pk in objs and ontology._can_see(other, objs[pk])]
            if flt:
                reached = ox._filter_rows(other, reached, flt)
            vals = [x["properties"].get(s.property) for x in reached] if s.property else []
            vals = [v for v in vals if v is not None]
            if s.metric == "count":
                v: Any = len(reached)
            elif s.metric in ("sum", "avg"):
                nums = [n for x in vals if (n := _num(x)) is not None]
                v = (sum(nums) if s.metric == "sum" else sum(nums) / len(nums)) if nums else None
            elif s.metric in ("min", "max"):
                v = (min if s.metric == "min" else max)(vals, key=lambda x: (_num(x) is None, _num(x) or 0, str(x))) if vals else None
            elif s.metric in ("exact_distinct", "approximate_distinct"):
                v = len({str(x) for x in vals})
            elif s.metric == "collect_list":
                v = vals[:COLLECT_LIMIT]
            elif s.metric == "collect_set":
                v = list(dict.fromkeys(str(x) if isinstance(x, (dict, list)) else x for x in vals))[:COLLECT_LIMIT]
            else:  # select
                v = vals[0] if vals else None
            r["properties"] = {**r["properties"], s.api_name: v}
            r.setdefault("derived_properties", []).append(s.api_name)
    return {**t, "properties": t["properties"] + [d[3] for d in defs]}
