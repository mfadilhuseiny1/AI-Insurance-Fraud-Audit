"""Workshop Filter List keyword search beyond a plain substring (Workshop doc "Filter List", "Advanced filtering";
Ontology doc "Ontology search", regular expressions; "Object set filter variables", supported starting filters).

- Advanced syntax (a keyword filter switched to "Advanced"): terms, "quoted phrases", brackets and the operators AND,
  OR and NOT (upper case; two terms side by side mean AND). Precedence as documented: quotations, parentheses, NOT,
  AND, OR. A term (or phrase) matches a value through the property's full-text analyzer, as Object Explorer's keyword
  search does (see "advanced keyword syntax" below); a term with `*` or `?` is a wildcard matched against the value or
  each of its words. Bounded: at most 500 characters, 64 terms and 16 nested brackets; a query that does not parse is
  refused with the reason.
- Filters on linked objects (has link / has no link / filters on the linked objects) on an object type or a union of
  object types: each object type resolves the link on its own (link_keep, at the end).
- Regex search (filter op "regex", or a keyword switched to "Regex"): Lucene syntax as in the Ontology (the pattern
  matches a whole value; `"..."` is literal; no `^` / `$`), translated by ontology_search.lucene_to_python and run
  with the `regex` package under a time budget (2 s per query in all, values cut at 10,000 characters, patterns at
  300), so a catastrophic pattern is stopped and refused instead of hanging the API. On an object type (or a union
  of object types) only string properties with the "Regex queries" render hint are searched, as in Foundry.
- CONTAIN as a prefix match (an object set filter value with `contains_prefix`): "contains" filters match the start
  of the value or of one of its words (`id0001` finds `id000123`, `d0001` does not), Foundry's starting-filter rule.
"""

from __future__ import annotations

import contextvars
import functools
import re
import time
from typing import Any, Optional

from fastapi import HTTPException

import ontology
import ontology_search

try:  # pinned in requirements.txt; matching with a timeout is what makes user patterns safe
    import regex as _rx
except ImportError:  # pragma: no cover
    _rx = None

MAX_QUERY = 500
MAX_TERMS = 64
MAX_DEPTH = 16
MAX_PATTERN = 300
MAX_VALUE = 10_000
REGEX_BUDGET = 2.0
OPERATORS = ("AND", "OR", "NOT")

# ------------------------------------------------------------------------------------------------
# advanced keyword syntax
# ------------------------------------------------------------------------------------------------


def _tokens(q: str) -> list[tuple[str, str]]:
    """("term" | "phrase" | "op" | "(" | ")", text)"""
    out: list[tuple[str, str]] = []
    i, n = 0, len(q)
    while i < n:
        ch = q[i]
        if ch.isspace():
            i += 1
        elif ch == '"':
            end = q.find('"', i + 1)
            if end < 0:
                raise ValueError('a " has no closing "')
            text = q[i + 1:end].strip()
            if not text:
                raise ValueError('empty quotes ""')
            out.append(("phrase", text))
            i = end + 1
        elif ch in "()":
            out.append((ch, ch))
            i += 1
        else:
            j = i
            while j < n and not q[j].isspace() and q[j] not in '()"':
                j += 1
            word = q[i:j]
            out.append(("op", word) if word in OPERATORS else ("term", word))
            i = j
    return out


class _Parser:
    def __init__(self, toks: list[tuple[str, str]]):
        self.toks, self.i, self.depth = toks, 0, 0

    def peek(self) -> Optional[tuple[str, str]]:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self) -> tuple[str, str]:
        t = self.toks[self.i]
        self.i += 1
        return t

    def parse(self) -> tuple:
        if not self.toks:
            raise ValueError("the query is empty")
        node = self.or_()
        t = self.peek()
        if t is not None:
            raise ValueError("a ) has no opening (" if t[0] == ")" else f'unexpected "{t[1]}"')
        return node

    def or_(self) -> tuple:
        parts = [self.and_()]
        while (t := self.peek()) is not None and t == ("op", "OR"):
            self.take()
            parts.append(self.and_())
        return parts[0] if len(parts) == 1 else ("or", tuple(parts))

    def and_(self) -> tuple:
        parts = [self.not_()]
        while (t := self.peek()) is not None and (t == ("op", "AND") or t[0] in ("term", "phrase", "(") or t == ("op", "NOT")):
            if t == ("op", "AND"):
                self.take()
            parts.append(self.not_())
        return parts[0] if len(parts) == 1 else ("and", tuple(parts))

    def not_(self) -> tuple:
        t = self.peek()
        if t == ("op", "NOT"):
            self.take()
            return ("not", self.not_())
        return self.atom()

    def atom(self) -> tuple:
        t = self.peek()
        if t is None:
            raise ValueError("the query ends with an operator: a term is missing")
        kind, text = self.take()
        if kind == "(":
            self.depth += 1
            if self.depth > MAX_DEPTH:
                raise ValueError(f"more than {MAX_DEPTH} nested brackets")
            if self.peek() is not None and self.peek()[0] == ")":
                raise ValueError("empty brackets ()")
            node = self.or_()
            if self.peek() is None or self.peek()[0] != ")":
                raise ValueError("a ( has no closing )")
            self.take()
            self.depth -= 1
            return node
        if kind == ")":
            raise ValueError("a ) has no opening (")
        if kind == "op":
            raise ValueError(f"{text} needs a term before and after it" if text != "NOT" else "NOT needs a term after it")
        # as typed: the analyzer lower-cases (whitespace is case-sensitive, as in Object Explorer)
        return ("term", text, kind == "phrase", kind == "term" and ("*" in text or "?" in text))


@functools.lru_cache(maxsize=256)
def parse(q: str) -> tuple:
    """The query's tree: ("term", text, phrase, wildcard) | ("and" | "or", parts) | ("not", node)."""
    if len(q) > MAX_QUERY:
        raise HTTPException(400, f"the search is longer than {MAX_QUERY} characters")
    try:
        toks = _tokens(q)
        if sum(1 for k, _ in toks if k in ("term", "phrase")) > MAX_TERMS:
            raise ValueError(f"more than {MAX_TERMS} terms")
        return _Parser(toks).parse()
    except ValueError as e:
        raise HTTPException(400, f"Invalid search {q!r}: {e}") from None


def _eval(node: tuple, hits: Any) -> bool:
    """The query tree over one row (or value): `hits(term)` says whether a term matches it."""
    kind = node[0]
    if kind == "term":
        return hits(node)
    if kind == "not":
        return not _eval(node[1], hits)
    if kind == "and":
        return all(_eval(x, hits) for x in node[1])
    return any(_eval(x, hits) for x in node[1])


def _term(node: tuple) -> dict:
    """A parsed term as ontology_search reads one (its keyword search and Object Explorer's)."""
    return {"text": node[1], "phrase": node[2], "wildcard": node[3]}


# Terms are matched through each property's full-text analyzer, the same code as the simple keyword search in Object
# Explorer (ontology_search._term_hits): standard / simple / english tokenize and lower-case (english stems), whitespace
# splits on spaces, the language analyzers (indonesian, french, …) stem, not_analyzed matches the whole value only,
# not_indexed never matches; a property without an analyzer (and any dataset or restricted view column) is matched as a
# case-insensitive substring, as before. A wildcard matches the whole value or one of its words. On an object type a
# leading wildcard ("*rawat") only searches the properties with the "Leading wildcards" hint (refused when none has
# it), as in Object Explorer. On a union each object is read with its own object type's analyzers.

_source: contextvars.ContextVar[Optional[tuple[str, str]]] = contextvars.ContextVar("workshop_search_source", default=None)
_analysis: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("workshop_search_analysis", default=None)


def use_source(kind: Optional[str], source_id: Optional[str]) -> None:
    """The object set a query (or a link filter's linked objects) reads: property keyword filters find their analyzers
    there."""
    _source.set((kind, source_id) if kind else None)
    _analysis.set({})


def _type_analysis(t: dict, names: Optional[dict[str, str]] = None) -> tuple[dict[str, Optional[str]], set[str]]:
    """({column: analyzer}, the columns a leading wildcard may search) of an object type (names: interface property →
    the type's own property)."""
    by = {p["api_name"]: p for p in t["properties"]}
    cols = names or {n: n for n in by}
    how = {c: ontology_search.analyzer(by.get(local.split(".", 1)[0])) for c, local in cols.items()}
    lead = {c for c, local in cols.items() if "leading_wildcards" in ((by.get(local.split(".", 1)[0]) or {}).get("render_hints") or [])}
    return how, lead


def analysis(kind: Optional[str], source_id: Optional[str]) -> dict:
    """{type id (None: the source's only type): ({column: analyzer}, leading-wildcard columns)}; {} for a dataset or a
    restricted view (plain substring matching, leading wildcards anywhere)."""
    if not kind or kind not in ("object_type", "object_types", "interface"):
        return {}
    cache = _analysis.get()
    key = (kind, source_id)
    if cache is not None and key in cache:
        return cache[key]
    out: dict = {}
    if kind == "object_type":
        out[None] = _type_analysis(ontology._object_type(source_id))
    elif kind == "object_types":
        for tid in [x.strip() for x in str(source_id).split(",") if x.strip()]:
            out[tid] = _type_analysis(ontology._object_type(tid))
    else:
        import ontology_model as om

        for t, imp in om.implementations(source_id):
            try:
                t = ontology._object_type(t["id"])
            except HTTPException:
                continue
            out[t["id"]] = _type_analysis(t, imp.get("mapping") or {})
    if cache is not None:
        cache[key] = out
    return out


def _of_row(maps: dict, row: dict) -> tuple[dict[str, Optional[str]], Optional[set[str]]]:
    if not maps:
        return {}, None
    return maps.get(row.get("__type")) or maps.get(None) or ({}, set())


def _check_leading(maps: dict, node: tuple) -> None:
    """A leading wildcard needs a property with the "Leading wildcards" hint (object types; Object Explorer's rule)."""
    if not maps:
        return
    bad = next((t[1] for t in _terms_of(node) if t[3] and ontology_search.leading(t[1])), None)
    if bad is not None and not any(lead for _, lead in maps.values()):
        raise HTTPException(400, f'"{bad}" starts with a wildcard: enable "Leading wildcards" on a searchable property in Ontology Manager '
                                 "(Properties → Interaction)")


def _terms_of(node: tuple) -> list[tuple]:
    if node[0] == "term":
        return [node]
    if node[0] == "not":
        return _terms_of(node[1])
    return [y for x in node[1] for y in _terms_of(x)]


def _value_hits(node: tuple, value: Any, how: Optional[str], lead_ok: bool) -> bool:
    if node[3] and ontology_search.leading(node[1]) and not lead_ok:
        return False
    if value is None or value == "" or value == []:
        return False
    if isinstance(value, dict):
        value = " ".join(str(v) for v in value.values() if v is not None)
    return ontology_search._term_hits(_term(node), value, how)


def row_hits(maps: dict, row: dict) -> Any:
    """hits(term) for a row: some column matches the term through its analyzer."""
    how, lead = _of_row(maps, row)

    def hits(node: tuple) -> bool:
        return any(_value_hits(node, v, how.get(k), lead is None or k in lead) for k, v in row.items() if not k.startswith("__"))
    return hits


def advanced_match(q: str, value: Any, column: Optional[str] = None, row: Optional[dict] = None) -> bool:
    """A property keyword filter in advanced syntax (filter op "search"), through the property's analyzer (the object
    set from use_source; on a union, the row's own object type)."""
    if not str(q or "").strip():
        return False
    node = parse(str(q).strip())
    src = _source.get()
    maps = analysis(*src) if src and column else {}
    how, lead = _of_row(maps, row or {})
    lead_ok = lead is None or column in lead
    return _eval(node, lambda t: _value_hits(t, value, how.get(column or ""), lead_ok))


# ------------------------------------------------------------------------------------------------
# regular expressions, under a time budget
# ------------------------------------------------------------------------------------------------

_deadline: contextvars.ContextVar[Optional[float]] = contextvars.ContextVar("workshop_regex_deadline", default=None)


def start_budget(kind: Optional[str] = None, source_id: Optional[str] = None) -> None:
    """A query's regex budget starts now (one per /query call); the query reads this object set (use_source)."""
    _deadline.set(time.monotonic() + REGEX_BUDGET)
    use_source(kind, source_id)


@functools.lru_cache(maxsize=256)
def compile_regex(pattern: str) -> Any:
    if _rx is None:
        raise HTTPException(400, "regex search needs the regex package (requirements.txt)")
    if len(pattern) > MAX_PATTERN:
        raise HTTPException(400, f"the regular expression is longer than {MAX_PATTERN} characters")
    try:
        return _rx.compile(ontology_search.lucene_to_python(pattern), _rx.DOTALL)
    except (ValueError, _rx.error) as e:
        raise HTTPException(400, f"Invalid regular expression {pattern!r}: {e}") from None


def regex_match(pattern: str, value: Any) -> bool:
    """The whole value (or one element of a list) matches the Lucene pattern."""
    if value is None or value == "":
        return False
    if isinstance(value, (list, tuple)):
        return any(regex_match(pattern, x) for x in value)
    rx = compile_regex(str(pattern))
    deadline = _deadline.get()
    left = (deadline - time.monotonic()) if deadline is not None else REGEX_BUDGET
    if left <= 0:
        raise _too_slow(pattern)
    try:
        return rx.fullmatch(str(value)[:MAX_VALUE], timeout=left) is not None
    except TimeoutError:
        raise _too_slow(pattern) from None


def _too_slow(pattern: str) -> HTTPException:
    return HTTPException(400, f"the regular expression {pattern!r} took longer than {REGEX_BUDGET:g} s on this object set and was "
                              "stopped: make it more specific (avoid nested repeats such as (a+)+)")


def regex_columns(kind: str, source_id: str) -> Optional[set[str]]:
    """The properties regex search may use: on object types the string properties with the "Regex queries" render
    hint (None: any column, a dataset or an interface)."""
    if kind not in ("object_type", "object_types"):
        return None
    out: set[str] = set()
    for tid in [x.strip() for x in source_id.split(",") if x.strip()] if kind == "object_types" else [source_id]:
        t = ontology._object_type(tid)
        out |= {p["api_name"] for p in t["properties"]
                if p["type"] in ("string", "string_array") and "regex_queries" in (p.get("render_hints") or [])}
    return out


def check_regex_column(allowed: Optional[set[str]], column: str) -> None:
    if allowed is not None and column not in allowed:
        raise HTTPException(400, f'{column} is not indexed for regex search: enable "Regex queries" on the string property in Ontology '
                                 "Manager (Properties → Interaction)")


def keyword_rows(kind: str, source_id: str, rows: list[dict], keyword: str, syntax: str) -> list[dict]:
    """The rows matching an object set filter's keyword in advanced syntax or as a regular expression."""
    q = keyword.strip()
    if syntax == "advanced":
        node = parse(q)
        maps = analysis(kind, source_id)
        _check_leading(maps, node)
        return [r for r in rows if _eval(node, row_hits(maps, r))]
    allowed = regex_columns(kind, source_id)
    if allowed is not None and not allowed:
        raise HTTPException(400, 'no property of this object set is indexed for regex search: enable "Regex queries" on a string '
                                 "property in Ontology Manager (Properties → Interaction)")
    compile_regex(q)
    return [r for r in rows if any(regex_match(q, v) for k, v in r.items() if k not in ("__pk", "__type") and (allowed is None or k in allowed))]


# ------------------------------------------------------------------------------------------------
# CONTAIN as a prefix match
# ------------------------------------------------------------------------------------------------

_SPLIT = re.compile(r"\W+")


def prefix_match(needle: Any, value: Any) -> bool:
    """The value, or one of its words, starts with the needle (case-insensitive)."""
    n = str(needle if needle is not None else "").strip().lower()
    if value is None:
        return False
    if isinstance(value, (list, tuple)):
        return any(prefix_match(n, x) for x in value)
    s = str(value).lower()
    return s.startswith(n) or any(w.startswith(n) for w in _SPLIT.split(s) if w)


# ------------------------------------------------------------------------------------------------
# filters on linked objects (has link / has no link / filters on the linked objects), also on unions
# ------------------------------------------------------------------------------------------------
#
# A link filter's value: {link_type_id, direction} (one link type), or {links: [{link_type_id, direction}, ...]} (one
# per object type of a union), or {target_type_id} (every link type from each object type to that object type), with
# {filters: [...], negate}. Each object type of the object set resolves the link on its own: the link types (and
# directions) that start from it. An object type of a union that has none of the links has no linked objects: "has
# link" drops its objects and "has no link" (negate) keeps them all, the way a union's single properties are empty on
# the other types' objects (Workshop's doc only recommends filtering a union on what every type shares; it does not
# say what happens otherwise, so this is our rule). Refused: a link that starts from none of the object set's types,
# and a filter on a property none of the linked object types has.


def _members(source: Any) -> list[str]:
    if source.kind == "object_type":
        return [source.id]
    if source.kind == "object_types":
        return list(dict.fromkeys(x.strip() for x in source.id.split(",") if x.strip()))
    if source.kind == "interface":
        # the implementing object types the reader can see (as the interface's rows: workshop._interface_rows)
        import ontology_model as om

        out = []
        for t, _imp in om.implementations(source.id):
            try:
                out.append(ontology._object_type(t["id"])["id"])
            except HTTPException:
                continue
        return list(dict.fromkeys(out))
    raise HTTPException(400, "filters on linked objects need an object type, a union of object types or an interface as the object set")


def _interface_link(spec: dict, members: list[str], iface_id: Optional[str]) -> dict[str, list[tuple[dict, str]]]:
    """An interface link type (constraint api name): each implementing type's concrete link type for it (a type without
    one has no linked objects)."""
    import ontology_model as om

    if not iface_id:
        raise HTTPException(400, "an interface link needs an interface as the object set")
    name = str(spec.get("interface_link"))
    iface = ontology._get("interfaces", iface_id, "interface")
    if not any(c.get("api_name") == name for c in om.interface_link_constraints(iface)):
        raise HTTPException(400, f'the interface {iface.get("display_name") or iface_id} has no link type "{name}"')
    out: dict[str, list[tuple[dict, str]]] = {m: [] for m in members}
    for t, imp in om.implementations(iface_id):
        lt_id = (imp.get("links") or {}).get(name)
        if t["id"] not in out or not lt_id:
            continue
        lt = ontology._get("link-types", lt_id, "link type")
        out[t["id"]].append((lt, "forward" if lt["source"]["object_type_id"] == t["id"] else "reverse"))
    return out


def _resolve_links(spec: dict, members: list[str], iface_id: Optional[str] = None) -> dict[str, list[tuple[dict, str]]]:
    """{member type id: [(link type, direction) starting from it]}."""
    import ontology_model as om

    out: dict[str, list[tuple[dict, str]]] = {m: [] for m in members}
    if spec.get("interface_link"):
        return _interface_link(spec, members, iface_id)
    if spec.get("target_type_id"):
        target = ontology._object_type(str(spec["target_type_id"]))
        for m in members:
            out[m] = [(lt, d) for lt, d in om.links_of(m) if om.side_of(lt, d)[1]["object_type_id"] == target["id"]]
        if not any(out.values()):
            raise HTTPException(400, f"no object type of this object set links to {target['display_name']}")
        return out
    wanted = spec.get("links") if isinstance(spec.get("links"), list) else [{"link_type_id": spec.get("link_type_id"), "direction": spec.get("direction")}]
    if not wanted:
        raise HTTPException(400, "choose the link type of the linked-object filter")
    for w in wanted:
        w = w if isinstance(w, dict) else {}
        lt = ontology._get("link-types", str(w.get("link_type_id") or ""), "link type")
        direction = w.get("direction") or "forward"
        if direction not in ("forward", "reverse"):
            raise HTTPException(400, "a link's direction is forward or reverse")
        start = om.side_of(lt, direction)[0]["object_type_id"]
        if start not in out:
            what = "this object type" if len(members) == 1 else "any object type of this object set"
            raise HTTPException(400, f'the link type {lt.get("display_name") or lt["id"]} does not start from {what}')
        out[start].append((lt, direction))
    return out


def link_keep(source: Any, rows: list[dict], f: Any) -> set[str]:
    """The __pk of the rows with at least one linked object passing the link filter's own filters (or none, negated)."""
    import ontology_model as om
    import workshop as w

    spec = f.value if isinstance(f.value, dict) else {}
    members = _members(source)
    # a union's and an interface's rows carry "type:pk" primary keys
    union = source.kind in ("object_types", "interface")
    per_type = _resolve_links(spec, members, source.id if source.kind == "interface" else None)
    subs = [x for x in (w.Filter(**y) for y in spec.get("filters") or []) if w._set_active(x)]
    reached: dict[str, tuple[list[str], list[dict]]] = {}
    for links in per_type.values():
        for lt, d in links:
            tid = om.side_of(lt, d)[1]["object_type_id"]
            if tid not in reached:
                cols, _, objs = w._object_rows(tid)
                reached[tid] = (cols, objs)
    for s in subs:
        if s.column != "__pk" and not any(s.column in cols for cols, _ in reached.values()):
            raise HTTPException(400, f'the linked objects have no property "{s.column}"')
    # the linked objects passing the filters, per object type (property keyword filters read that type's analyzers)
    passing: dict[str, set[str]] = {}
    outer = (_source.get(), _analysis.get())
    try:
        for tid, (_, objs) in reached.items():
            use_source("object_type", tid)
            passing[tid] = {str(r["__pk"]) for r in objs if all(w._keep(r, x) for x in subs)}
    finally:
        _source.set(outer[0])
        _analysis.set(outer[1])
    # the rows' own primary keys, per object type
    by_type: dict[str, dict[str, str]] = {m: {} for m in members}
    for r in rows:
        key = str(r["__pk"])
        if union:
            tid, _, pk = key.partition(":")
            if tid in by_type:
                by_type[tid][pk] = key
        else:
            by_type[members[0]][key] = key
    keep: set[str] = set()
    for tid, links in per_type.items():
        pks = by_type.get(tid) or {}
        if not pks or not links:
            continue
        for lt, d in links:
            ok = passing[om.side_of(lt, d)[1]["object_type_id"]]
            for pk, targets in om.linked_map(lt, d, set(pks)).items():
                if pk in pks and set(map(str, targets)) & ok:
                    keep.add(pks[pk])
    every = {str(r["__pk"]) for r in rows}
    return every - keep if spec.get("negate") else keep
