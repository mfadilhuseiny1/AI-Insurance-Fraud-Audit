"""Object Explorer and Object Views, modelled on the Foundry apps of the same names.

Object Explorer searches the Ontology: pick an object type (or an interface, across its implementations), search
its text, add property filters, follow Search Arounds through link types (one after the other, as an object set
moves from type to type), sort and page the results, and look at the exploration view: a histogram of each
aggregatable property (selectable or low-cardinality properties, booleans, dates and numbers) and one chosen
aggregation (count, sum, average, min or max, optionally grouped by a property). Explorations can be saved,
results exported to CSV, opened in Workshop and edited in bulk with an action type (unless it is hidden from
Object Explorer with the `hubble-oe:hide-action` type class). Each search is metered as Ontology query compute
and checked against the Object Set Service limits: in-memory execution up to 100,000 objects, a Search Around
result of at most 10 million objects and 30 million objects loaded per query.

An Object View is the hub of one object: its properties (prominent first, hidden ones left out, keywords and long
text in their own sections), the objects linked to it by every link type, the interfaces its type implements, the
actions that apply to it, its time series, the automations watching its type, its edit history and related
resources (Workshop modules, Quiver analyses and links) configured on the object type's view.

Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_live
import ontology_model as om
import ontology_search
from ontology import _all, _get, _lock, _new_id, _now, _path, _put, _read

router = APIRouter(prefix="/api/ontology")

IN_MEMORY_LIMIT = 100_000
EXPORT_LIVE = 1_000_000  # rows a CSV export of a live object set holds at most
SEARCH_AROUND_LIMIT = 10_000_000
TOTAL_LOADED_LIMIT = 30_000_000
NUMERIC = ("integer", "long", "short", "byte", "double", "float", "decimal")


class Filter(BaseModel):
    property: str
    # regex: Lucene syntax on a whole value; wildcard: * and ? on a whole value (ontology_search.py)
    # any_word / phrase / within: token searches (Insight's "contains any word from", "contains phrase", "matches terms
    # within": value {terms, gap, ordered, negate}); property "__link" with op "linked": objects with a linked object
    # matching filters (value {link_type_id, direction, filters, negate}), without moving to the linked type
    # geo: geospatial search on a geopoint / geoshape property — value {kind: bbox, min_lat, min_lon, max_lat, max_lon} |
    # {kind: distance, lat, lon, km} | {kind: polygon, points: [[lat, lon], …]}; shapes match when they intersect
    # interval: Elasticsearch-style interval rules on the analyzed tokens (_interval_spans): {match: {query, ordered,
    # max_gaps, fuzziness, prefix_last}} | {prefix: {prefix}} | {fuzzy: {term, fuzziness}} | {any_of: {intervals}} |
    # {all_of: {intervals, ordered, max_gaps}}
    # and / or / not: a boolean filter tree evaluated in the same pass (_tree_filter); value is a list of filters (each
    # may be a tree again) — and: all match, or: at least one, not: not all of them (one filter: the filter negated);
    # property is ignored ("" or "__tree")
    op: Literal["eq", "neq", "contains", "starts_with", "gt", "gte", "lt", "lte", "between", "in", "is_null", "not_null", "regex", "wildcard",
                "any_word", "phrase", "within", "linked", "geo", "interval", "and", "or", "not"] = "eq"
    value: Any = None


class SearchAround(BaseModel):
    link_type_id: str
    direction: Literal["forward", "reverse"] = "forward"
    # filters on the objects reached
    filters: list[Filter] = []


class Aggregate(BaseModel):
    metric: Literal["count", "sum", "avg", "min", "max"] = "count"
    property: Optional[str] = None
    group_by: Optional[str] = None


class Semantic(BaseModel):
    """Search by meaning: rank the objects by the query (k nearest neighbors on a vector property, ranked keyword
    search, or both fused with RRF); the result keeps the relevance order unless a sort is chosen."""
    query: str = Field(min_length=1, max_length=4000)
    property: Optional[str] = None
    k: int = Field(20, ge=1, le=500)
    mode: Literal["semantic", "keyword", "hybrid"] = "semantic"
    exact: bool = False  # compare the query with every vector instead of the ANN index (5,000+ objects)


class SearchIn(BaseModel):
    semantic: Optional[Semantic] = None
    object_type_id: Optional[str] = None
    interface_id: Optional[str] = None
    q: str = ""
    filters: list[Filter] = []
    search_around: list[SearchAround] = []
    sort: Optional[str] = None
    order: Literal["asc", "desc"] = "asc"
    offset: int = Field(0, ge=0)
    limit: int = Field(50, ge=1, le=1000)
    aggregate: Optional[Aggregate] = None
    histograms: bool = True
    # a chart for every property (Object Explorer's Explore view): high-cardinality strings and the primary key get
    # their top values too, and there is no cap on the number of charts
    all_charts: bool = False
    # derived properties computed at query time (ontology_search.DerivedProperty), usable in filters, sorts and aggregations
    with_properties: list[ontology_search.DerivedProperty] = []
    # the resource the query runs for (usage attribution)
    resource: Optional[str] = None


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _cmp(a: Any, b: Any) -> Optional[int]:
    x, y = _num(a), _num(b)
    if x is not None and y is not None:
        return (x > y) - (x < y)
    if a is None or b is None:
        return None
    sa, sb = str(a), str(b)
    return (sa > sb) - (sa < sb)


def _tokens(text: Any) -> list[str]:
    """The standard analyzer: lower case; underscores and periods belong to a token, dashes and spaces separate."""
    return [t.strip(".") for t in re.findall(r"[\w.]+", str(text if text is not None else "").lower()) if t.strip(".")]


def _phrase_at(tokens: list[str], phrase: list[str]) -> list[int]:
    n = len(phrase)
    return [i for i in range(len(tokens) - n + 1) if tokens[i:i + n] == phrase] if n else []


def _within(tokens: list[str], spec: dict) -> bool:
    """Every term (a phrase) appears with at most `gap` words between consecutive terms (in order when asked)."""
    terms = [_tokens(t) for t in (spec.get("terms") or []) if _tokens(t)]
    if not terms:
        return True
    gap = max(0, int(spec.get("gap") or 0))
    starts = [_phrase_at(tokens, t) for t in terms]
    if any(not s for s in starts):
        return False
    import itertools

    for combo in itertools.product(*starts):
        spans = sorted(((s, s + len(terms[i]) - 1, i) for i, s in enumerate(combo)), key=lambda x: x[0])
        if spec.get("ordered") and [x[2] for x in spans] != list(range(len(terms))):
            continue
        if all(spans[k + 1][0] - spans[k][1] - 1 <= gap and spans[k + 1][0] > spans[k][1] for k in range(len(spans) - 1)):
            return True
    return False


# ------------------------------------------------------------------ interval rules (Elasticsearch-style intervals)
#
# A rule yields the spans (first, last token position) where it matches in a value's analyzed tokens; a value matches when
# the rule has a span. match: its terms as one span — in order or in any order (distinct positions), with at most
# max_gaps positions inside the span not taken by a term (-1: any); each term within `fuzziness` edits (0, 1, 2 or
# "auto": 0 for 1-2 letters, 1 for 3-5, 2 for more; Damerau-Levenshtein, a transposition is one edit) and the last term a
# prefix with prefix_last. any_of: the spans of any of its rules. all_of: one span of each rule, not overlapping, in the
# rules' order when ordered, with at most max_gaps positions between them.

MAX_UNORDERED = 12


def _interval_error(msg: str) -> HTTPException:
    return HTTPException(400, f"interval filter: {msg}")


def _edit_distance(a: str, b: str, limit: int) -> int:
    """Optimal string alignment distance of a and b, or limit + 1 once it exceeds limit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    before: list[int] = []
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], before[j - 2] + 1)
        if min(cur) > limit:
            return limit + 1
        before, prev = prev, cur
    return prev[-1]


def _fuzziness(spec: Any, term: str) -> int:
    if spec in (None, False, 0, "0"):
        return 0
    if spec is True or str(spec).strip().lower() == "auto":
        return 0 if len(term) <= 2 else 1 if len(term) <= 5 else 2
    try:
        n = int(spec)
    except (TypeError, ValueError):
        raise _interval_error(f"fuzziness is 0, 1, 2 or \"auto\", got {spec!r}") from None
    if not 0 <= n <= 2:
        raise _interval_error(f"fuzziness is 0, 1, 2 or \"auto\", got {spec!r}")
    return n


def _term_spans(tokens: list[str], term: str, fuzz: int = 0, prefix: bool = False) -> set:
    if prefix:
        return {(i, i) for i, w in enumerate(tokens) if w.startswith(term)}
    return {(i, i) for i, w in enumerate(tokens) if w == term or (fuzz and _edit_distance(term, w, fuzz) <= fuzz)}


def _max_gaps(spec: dict) -> int:
    try:
        n = int(spec.get("max_gaps", -1))
    except (TypeError, ValueError):
        raise _interval_error("max_gaps is a whole number (-1: any)") from None
    return -1 if n < 0 else n


def _combine_spans(subs: list, ordered: bool, max_gaps: int) -> set:
    """Spans holding one span of each sub-rule, not overlapping (in the given order when ordered), gaps <= max_gaps."""
    if any(not s for s in subs):
        return set()
    if len(subs) == 1:
        return set(subs[0])
    n = len(subs)
    if not ordered and n > MAX_UNORDERED:
        raise _interval_error(f"at most {MAX_UNORDERED} terms or rules in any order")
    full = n if ordered else (1 << n) - 1
    # partial sequences, by (rules taken: a count when ordered, else a bit mask; first position; last position) -> the
    # most positions covered (fewest gaps); sub-spans taken in order of their first position
    states: dict = {}
    done: set = set()
    for s, e, r in sorted((s, e, r) for r, spans in enumerate(subs) for s, e in spans):
        new: dict = {}
        if not ordered or r == 0:
            new[(1 if ordered else 1 << r, s, e)] = e - s + 1
        for (k, s0, e0), cov in states.items():
            if e0 >= s or (k != r if ordered else k >> r & 1):
                continue
            cov2 = cov + e - s + 1
            if max_gaps >= 0 and (e - s0 + 1) - cov2 > max_gaps:
                continue
            key = (k + 1 if ordered else k | 1 << r, s0, e)
            if new.get(key, -1) < cov2:
                new[key] = cov2
        for key, cov in new.items():
            if key[0] == full:
                done.add((key[1], key[2]))
            elif states.get(key, -1) < cov:
                states[key] = cov
    return done


def _interval_spans(tokens: list[str], rule: Any) -> set:
    if not isinstance(rule, dict) or len(rule) != 1:
        raise _interval_error("a rule is one of {match}, {prefix}, {fuzzy}, {any_of}, {all_of}")
    kind, spec = next(iter(rule.items()))
    if not isinstance(spec, dict):
        raise _interval_error(f"{kind} takes an object")
    if kind == "match":
        terms = _tokens(spec.get("query"))
        if not terms:
            return set()
        prefix = bool(spec.get("prefix_last"))
        subs = [_term_spans(tokens, t, 0 if prefix and i == len(terms) - 1 else _fuzziness(spec.get("fuzziness"), t),
                            prefix and i == len(terms) - 1) for i, t in enumerate(terms)]
        return _combine_spans(subs, bool(spec.get("ordered")), _max_gaps(spec))
    if kind == "prefix":
        term = str(spec.get("prefix") or "").strip().lower()
        return _term_spans(tokens, term, prefix=True) if term else set()
    if kind == "fuzzy":
        terms = _tokens(spec.get("term"))
        if len(terms) != 1:
            raise _interval_error("fuzzy takes one term")
        return _term_spans(tokens, terms[0], _fuzziness(spec.get("fuzziness", "auto"), terms[0]))
    if kind in ("any_of", "all_of"):
        rules = spec.get("intervals")
        if not isinstance(rules, list) or not rules:
            raise _interval_error(f"{kind} takes a non-empty list of intervals")
        subs = [_interval_spans(tokens, r) for r in rules]
        if kind == "any_of":
            return set().union(*subs)
        return _combine_spans(subs, bool(spec.get("ordered")), _max_gaps(spec))
    raise _interval_error(f"unknown rule {kind}")


def _geometry(v: Any) -> Any:
    """A shapely geometry (lon / lat) of a geopoint ("lat,lon", {lat, lon}) or a geoshape (GeoJSON); None if unreadable."""
    from shapely.geometry import Point, shape

    try:
        if isinstance(v, str):
            if v.strip().startswith("{"):
                v = json.loads(v)
            else:
                lat, lon = (float(x) for x in v.split(",")[:2])
                return Point(lon, lat)
        if isinstance(v, dict):
            if "type" in v and "coordinates" in v:
                return shape(v)
            if v.get("type") == "Feature" and v.get("geometry"):
                return shape(v["geometry"])
            lat, lon = v.get("lat", v.get("latitude")), v.get("lon", v.get("lng", v.get("longitude")))
            if lat is not None and lon is not None:
                return Point(float(lon), float(lat))
    except (ValueError, TypeError, AttributeError, KeyError):
        return None
    return None


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math

    p1, p2 = math.radians(lat1), math.radians(lat2)
    d = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(d)))


def _geo_region(spec: Any) -> Any:
    """The searched region: a shapely geometry, or ("distance", lat, lon, km)."""
    from shapely.geometry import Polygon, box

    if not isinstance(spec, dict):
        raise HTTPException(400, "a geospatial filter needs a bounding box, a distance or a polygon")
    try:
        k = spec.get("kind")
        if k == "bbox":
            return box(float(spec["min_lon"]), float(spec["min_lat"]), float(spec["max_lon"]), float(spec["max_lat"]))
        if k == "distance":
            return ("distance", float(spec["lat"]), float(spec["lon"]), float(spec["km"]))
        if k == "polygon":
            pts = [(float(lon), float(lat)) for lat, lon in spec.get("points") or []]
            if len(pts) < 3:
                raise HTTPException(400, "a polygon needs at least three points")
            return Polygon(pts)
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "the geospatial filter's coordinates are not numbers") from None
    raise HTTPException(400, "a geospatial filter is a bbox, a distance or a polygon")


def _geo_match(value: Any, region: Any) -> bool:
    g = _geometry(value)
    if g is None or g.is_empty:
        return False
    if isinstance(region, tuple):
        _, lat, lon, km = region
        if g.geom_type == "Point":
            return _km(lat, lon, g.y, g.x) <= km
        from shapely.geometry import Point
        from shapely.ops import nearest_points

        near = nearest_points(g, Point(lon, lat))[0]
        return _km(lat, lon, near.y, near.x) <= km
    return g.intersects(region)


def _match(value: Any, f: Filter) -> bool:
    if f.op == "geo":
        region = _geo_region(f.value)
        if isinstance(value, list):
            return any(_geo_match(v, region) for v in value)
        return _geo_match(value, region)
    if f.op == "is_null":
        return value in (None, "", [])
    if f.op == "not_null":
        return value not in (None, "", [])
    if isinstance(value, list):
        # arrays: any element matches
        return any(_match(v, f) for v in value)
    if isinstance(value, dict):
        value = " ".join(str(v) for v in value.values() if v is not None)
    if f.op == "any_word":
        return bool(set(_tokens(f.value)) & set(_tokens(value)))
    if f.op == "phrase":
        return bool(_phrase_at(_tokens(value), _tokens(f.value)))
    if f.op == "interval":
        return bool(_interval_spans(_tokens(value), f.value))
    if f.op == "within":
        spec = f.value if isinstance(f.value, dict) else {"terms": [f.value]}
        return _within(_tokens(value), spec) != bool(spec.get("negate"))
    if f.op == "eq":
        c = _cmp(value, f.value)
        return c == 0 if c is not None else str(value).lower() == str(f.value).lower()
    if f.op == "neq":
        return not _match(value, Filter(property=f.property, op="eq", value=f.value))
    if f.op == "contains":
        return str(f.value or "").lower() in str(value if value is not None else "").lower()
    if f.op == "regex":
        return ontology_search.regex_match(f.value, value)
    if f.op == "wildcard":
        return ontology_search.wildcard_match(f.value, value)
    if f.op == "starts_with":
        return str(value if value is not None else "").lower().startswith(str(f.value or "").lower())
    if f.op == "in":
        vals = f.value if isinstance(f.value, list) else [f.value]
        return any(_match(value, Filter(property=f.property, op="eq", value=v)) for v in vals)
    if f.op == "between":
        lo, hi = (f.value[0] if len(f.value) > 0 else None, f.value[1] if len(f.value) > 1 else None) if isinstance(f.value, list) else (None, None)
        return (lo in (None, "") or (_cmp(value, lo) or 0) >= 0) and (hi in (None, "") or (_cmp(value, hi) or 0) <= 0) and value is not None
    c = _cmp(value, f.value)
    if c is None:
        return False
    return {"gt": c > 0, "gte": c >= 0, "lt": c < 0, "lte": c <= 0}[f.op]


def _searchable(t: dict) -> list[str]:
    out = []
    for p in t["properties"]:
        hints = p.get("render_hints")
        if p.get("visibility") == "hidden" or p["type"] in ("vector", "media", "attachment", "timeseries", "geoshape", "cipher"):
            continue
        if hints is not None and hints and "searchable" not in hints:
            continue
        out.append(p["api_name"])
    return out


def _filter_rows(t: dict, rows: list[dict], filters: list[Filter]) -> list[dict]:
    names = {p["api_name"] for p in t["properties"]}
    for f in filters:
        if f.op in TREE_OPS:
            rows = _tree_filter(t, rows, f)
            continue
        if f.property == "__link":
            rows = _linked_filter(t, rows, f)
            continue
        if f.property not in names and f.property != "__title":
            raise HTTPException(400, f"{t['display_name']} has no property {f.property}")
        ontology_search.check_filter(t, f.property, f.op, f.value)
        if f.op == "geo":
            prop = next((p for p in t["properties"] if p["api_name"] == f.property), None)
            if not prop or prop["type"] not in ("geopoint", "geoshape"):
                raise HTTPException(400, f"geospatial search needs a geopoint or geoshape property: {f.property} is not one")
            _geo_region(f.value)
        if f.op == "interval":
            # a malformed rule is refused even when no object is left to check
            _interval_spans([], f.value)
        rows = [r for r in rows if _match(r["title"] if f.property == "__title" else r["properties"].get(f.property), f)]
    return rows


TREE_OPS = ("and", "or", "not")
TREE_DEPTH = 32


def _tree_kids(f: Filter, depth: int) -> list[Filter]:
    if depth > TREE_DEPTH:
        raise HTTPException(400, f"a filter tree nests at most {TREE_DEPTH} levels")
    raw = f.value if isinstance(f.value, list) else [f.value] if isinstance(f.value, (dict, Filter)) else None
    if raw is None:
        raise HTTPException(400, f"an {f.op} filter takes a list of filters")
    kids = []
    for x in raw:
        if isinstance(x, Filter):
            kids.append(x)
            continue
        if not isinstance(x, dict):
            raise HTTPException(400, f"an {f.op} filter takes a list of filters, got {x!r}")
        try:
            kids.append(Filter(**x))
        except Exception as e:  # pydantic ValidationError: a malformed filter inside the tree
            raise HTTPException(400, f"a filter inside {f.op}: {e}") from None
    return kids


def _tree_filter(t: dict, rows: list[dict], f: Filter, depth: int = 1) -> list[dict]:
    """A boolean filter tree (op and / or / not over a list of filters), evaluated on the rows in this pass: and keeps
    the rows every filter keeps, or the rows any keeps (each filter checks only the rows not kept yet), not the rows
    the filters (ANDed) drop. Every filter of the tree is validated, even when no row is left to check."""
    kids = _tree_kids(f, depth)

    def run(rs: list[dict], fs: list[Filter]) -> list[dict]:
        # nested trees carry their depth; plain filters go through _filter_rows (validation, linked, geo, interval)
        for k in fs:
            rs = _tree_filter(t, rs, k, depth + 1) if k.op in TREE_OPS else _filter_rows(t, rs, [k])
        return rs

    if f.op == "and":
        return run(rows, kids)
    if f.op == "not":
        hit = {id(r) for r in run(rows, kids)}
        return [r for r in rows if id(r) not in hit]
    hit: set = set()
    for k in kids:
        left = [r for r in rows if id(r) not in hit]
        hit.update(id(r) for r in run(left, [k]))
    return [r for r in rows if id(r) in hit]


def _linked_filter(t: dict, rows: list[dict], f: Filter) -> list[dict]:
    """Filter on a linked property: keep the objects with at least one linked object that matches (or none, negated)."""
    spec = f.value if isinstance(f.value, dict) else {}
    lt = _get("link-types", spec.get("link_type_id") or "", "link type")
    direction = spec.get("direction") or "forward"
    start, reach = om.side_of(lt, direction)
    if start["object_type_id"] != t.get("id"):
        raise HTTPException(400, f"{lt['display_name']} does not start from {t.get('display_name')}")
    other = ontology._object_type(reach["object_type_id"])
    links = om.linked_map(lt, direction, {r["primary_key"] for r in rows})
    reached = {x for v in links.values() for x in v}
    objs = ontology._objects(other["id"])
    cand = [ontology._public_object(other, pk, objs[pk]) for pk in reached if pk in objs and ontology._can_see(other, objs[pk])]
    ok = {r["primary_key"] for r in _filter_rows(other, cand, [Filter(**x) for x in spec.get("filters") or []])}
    keep = [r for r in rows if bool(set(links.get(r["primary_key"]) or []) & ok) != bool(spec.get("negate"))]
    return keep


def _rows(t: dict) -> list[dict]:
    return [ontology._public_object(t, pk, o) for pk, o in ontology._objects(t["id"]).items() if ontology._can_see(t, o)]


def _aggregatable(p: dict) -> bool:
    hints = set(p.get("render_hints") or [])
    if p.get("visibility") == "hidden":
        return False
    if p["type"] in ("boolean", "date", "timestamp") or p["type"] in NUMERIC:
        return True
    return p["type"] in ("string", "geopoint", "marking") and (not p.get("render_hints") or bool(hints & {"selectable", "low_cardinality"}))


def _histograms(t: dict, rows: list[dict], every: bool = False) -> list[dict]:
    out = []
    for p in t["properties"]:
        if every:
            if p.get("visibility") == "hidden" or p["type"] in ("vector", "media", "attachment", "timeseries", "geoshape", "cipher", "struct"):
                continue
        elif not _aggregatable(p) or p["api_name"] == t["primary_key"] or p.get("type") == "timeseries":
            continue
        values = [r["properties"].get(p["api_name"]) for r in rows]
        if p["type"] in NUMERIC:
            nums = [n for v in values if (n := _num(v)) is not None]
            if not nums:
                continue
            lo, hi = min(nums), max(nums)
            n = 8 if hi > lo else 1
            width = (hi - lo) / n if hi > lo else 1
            buckets = [0] * n
            for x in nums:
                buckets[min(n - 1, int((x - lo) / width)) if hi > lo else 0] += 1
            out.append({"property": p["api_name"], "display_name": p["display_name"], "kind": "numeric", "min": lo, "max": hi,
                        "buckets": [{"from": lo + i * width, "to": lo + (i + 1) * width, "count": c} for i, c in enumerate(buckets)],
                        "nulls": len(values) - len(nums)})
        else:
            counter: Counter = Counter()
            for v in values:
                for x in (v if isinstance(v, list) else [v]):
                    key = "—" if x in (None, "") else (str(x)[:7] if p["type"] in ("date", "timestamp") else str(x))
                    counter[key] += 1
            if not counter or (not every and len(counter) > 50 and p["type"] == "string" and not p.get("render_hints")):
                continue
            out.append({"property": p["api_name"], "display_name": p["display_name"], "kind": "month" if p["type"] in ("date", "timestamp") else "values",
                        "buckets": [{"value": k, "count": c} for k, c in (sorted(counter.items()) if p["type"] in ("date", "timestamp") else counter.most_common(12))],
                        "distinct": len(counter)})
    return out if every else out[:12]


def _aggregate(t: dict, rows: list[dict], a: Aggregate) -> dict:
    by = {p["api_name"]: p for p in t["properties"]}
    if a.metric != "count" and a.property not in by:
        raise HTTPException(400, "pick the property to aggregate")
    if a.metric in ("sum", "avg") and by[a.property]["type"] not in NUMERIC:
        raise HTTPException(400, f"{a.metric} needs a numeric property")
    if a.group_by and a.group_by not in by:
        raise HTTPException(400, f"{t['display_name']} has no property {a.group_by}")
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        key = r["properties"].get(a.group_by) if a.group_by else "all"
        for k in (key if isinstance(key, list) else [key]):
            groups["—" if k in (None, "") else str(k)].append(r)

    def metric(rs: list[dict]) -> Any:
        if a.metric == "count":
            return len(rs)
        vals = [r["properties"].get(a.property) for r in rs]
        vals = [v for v in vals if v is not None]
        if a.metric in ("min", "max"):
            return (min if a.metric == "min" else max)(vals, key=lambda v: (_num(v) is None, _num(v) or 0, str(v))) if vals else None
        nums = [n for v in vals if (n := _num(v)) is not None]
        if not nums:
            return None
        return sum(nums) if a.metric == "sum" else sum(nums) / len(nums)

    out = [{"group": k, "value": metric(v), "count": len(v)} for k, v in groups.items()]
    out.sort(key=lambda g: -(g["value"] if isinstance(g["value"], (int, float)) else g["count"]))
    return {"metric": a.metric, "property": a.property, "group_by": a.group_by, "groups": out[:100]}


def run_search(req: SearchIn) -> dict:
    """The whole result set of a search (before paging) and what it cost. A search that starts at or reaches a live
    object type runs as DuckDB statements (ontology_live.run): its result is r["live"], not r["rows"]."""
    if ontology_live.involves(req):
        return ontology_live.run(req)
    kinds = ["base"]
    loaded = 0
    if req.interface_id:
        iface = _get("interfaces", req.interface_id, "interface")
        t = None
        rows = []
        type_ids = []
        for it, imp in om.implementations(iface["id"]):
            try:
                it = ontology._object_type(it["id"])
            except HTTPException:
                continue
            type_ids.append(it["id"])
            mapping = imp.get("mapping") or {}
            for r in _rows(it):
                r["interface_properties"] = {ip: om.iface_value(r["properties"], local) for ip, local in mapping.items()}
                rows.append(r)
        props = om.interface_properties(iface)
        # filters run on interface property names
        t = {"id": iface["id"], "display_name": iface["display_name"], "primary_key": "", "properties": props}
        for r in rows:
            r["properties"] = r.pop("interface_properties")
    else:
        if not req.object_type_id:
            raise HTTPException(400, "pick an object type or an interface")
        t = ontology._object_type(req.object_type_id)
        rows = _rows(t)
        type_ids = [t["id"]]
    loaded += len(rows)
    if req.q.strip():
        names = _searchable(t) if not req.interface_id else [p["api_name"] for p in t["properties"]]
        rows = ontology_search.keyword_filter(t, rows, req.q, names)
    if req.with_properties:
        if req.interface_id:
            raise HTTPException(400, "Derived properties start from an object type")
        t = ontology_search.apply_derived(t, rows, req.with_properties)
        kinds.append("derived")
    rows = _filter_rows(t, rows, req.filters)
    if req.semantic and not req.interface_id:
        import ontology_semantic

        rows = ontology_semantic.rank(t, rows, req.semantic.query, req.semantic.mode, req.semantic.k, req.semantic.property,
                                     exact=req.semantic.exact)
        kinds.append("advanced")
    path = []
    for sa in req.search_around:
        if req.interface_id:
            raise HTTPException(400, "Search Arounds start from an object type")
        lt = _get("link-types", sa.link_type_id, "link type")
        start, reach = om.side_of(lt, sa.direction)
        if start["object_type_id"] != t["id"]:
            raise HTTPException(400, f"{lt['display_name']} does not start from {t['display_name']}")
        nxt = ontology._object_type(reach["object_type_id"])
        reached = sorted({x for v in om.linked_map(lt, sa.direction, {r["primary_key"] for r in rows}).values() for x in v})
        if len(reached) > SEARCH_AROUND_LIMIT:
            raise HTTPException(400, f"The Search Around to {nxt['display_name']} reaches {len(reached):,} objects: the limit is 10,000,000. Filter first.")
        objs = ontology._objects(nxt["id"])
        rows = [ontology._public_object(nxt, pk, objs[pk]) for pk in reached if pk in objs and ontology._can_see(nxt, objs[pk])]
        loaded += len(rows)
        if loaded > TOTAL_LOADED_LIMIT:
            raise HTTPException(400, "The query loads more than 30,000,000 objects in total: filter earlier")
        rows = _filter_rows(nxt, rows, sa.filters)
        path.append({"link_type_id": lt["id"], "name": reach["display_name"], "object_type_id": nxt["id"], "count": len(rows)})
        kinds.append("search_around")
        t = nxt
        type_ids.append(nxt["id"])
    if not req.sort:
        # hubble:default_sort_descending: Object Explorer sorts by that property, descending, unless asked otherwise
        dflt = next((p["api_name"] for p in t.get("properties", []) if "hubble:default_sort_descending" in (p.get("type_classes") or [])), None)
        if dflt:
            req = req.model_copy(update={"sort": dflt, "order": "desc"})
    if req.sort and req.sort != "__title":
        sp = next((p for p in t.get("properties", []) if p["api_name"] == req.sort), None)
        hints = (sp or {}).get("render_hints")
        # string properties sort only with the Sortable hint (when the hints were set; numbers and dates always sort)
        if sp and sp["type"] == "string" and hints and "sortable" not in hints:
            raise HTTPException(400, f"{sp['display_name']} is not sortable: enable the Sortable render hint in Ontology Manager")
    if req.sort:
        key = req.sort

        def sort_key(r: dict) -> tuple:
            v = r["title"] if key == "__title" else r["properties"].get(key)
            n = _num(v)
            return (v is None, n if n is not None else float("inf"), "" if v is None else str(v))
        rows.sort(key=sort_key, reverse=req.order == "desc")
        if req.order == "desc":
            # nulls last either way
            rows = [r for r in rows if (r["title"] if key == "__title" else r["properties"].get(key)) is not None] + \
                   [r for r in rows if (r["title"] if key == "__title" else r["properties"].get(key)) is None]
    if req.aggregate:
        kinds.append("aggregation")
    if any(p.get("derived") for p in t.get("properties", [])) and "derived" not in kinds:
        kinds.append("derived")
    return {"type": t, "rows": rows, "path": path, "kinds": kinds, "type_ids": type_ids, "loaded": loaded}


def _for_build(request: Optional[Request], type_id: Optional[str]) -> Any:
    """A search / Object View made for a build (service token + X-Bsai-Build): the object type checked as the
    build's identity (its markings and the ontology role, worded for the build), then the call runs as that user
    (build_calls.acting_for) so linked / interface types, object and property security and restricted views apply
    to them as to a request of their own. Other calls: unchanged."""
    import build_calls

    if type_id:
        build_calls.enforce(request, ("read", "object_type", type_id, None))
    return build_calls.acting_for(request)


@router.post("/explorer/search")
def search(req: SearchIn, request: Request = None) -> dict:  # type: ignore[assignment]
    token = om.RESOURCE.set(req.resource or "object-explorer")
    try:
        with _for_build(request, req.object_type_id):
            with _lock:
                r = run_search(req)
            t, rows = r["type"], r["rows"]
            if r.get("live"):
                # a live set: paged, charted and aggregated by DuckDB, outside the ontology lock
                got = ontology_live.finish(r, req)
            else:
                got = {"total": len(rows), "objects": rows[req.offset: req.offset + req.limit],
                       "histograms": _histograms(t, rows, req.all_charts) if req.histograms else [],
                       "aggregation": _aggregate(t, rows, req.aggregate) if req.aggregate else None}
        cost = sum(om.record_query(k, r["type_ids"][-1:] if k != "base" else r["type_ids"][:1], got["total"]) for k in r["kinds"])
    finally:
        om.RESOURCE.reset(token)
    return {
        "object_type_id": None if req.interface_id else t["id"],
        "interface_id": req.interface_id,
        "result_type": {"id": t["id"], "display_name": t["display_name"], "properties": t["properties"], "primary_key": t.get("primary_key")},
        "total": got["total"],
        "objects": got["objects"],
        "path": r["path"],
        "histograms": got["histograms"],
        "aggregation": got["aggregation"],
        "execution": "live" if r.get("live") else "in_memory" if r["loaded"] <= IN_MEMORY_LIMIT else "distributed",
        "query_types": r["kinds"],
        "compute_seconds": cost,
    }


def _cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


@router.post("/explorer/export")
def export(req: SearchIn, request: Request = None) -> Response:  # type: ignore[assignment]
    """The search results as CSV (every row, title and properties)."""
    token = om.RESOURCE.set(req.resource or "object-explorer")
    try:
        with _for_build(request, req.object_type_id):
            with _lock:
                r = run_search(req)
            if r.get("live"):
                # a live set: at most EXPORT_LIVE rows, read by DuckDB
                r["rows"] = ontology_live.export_rows(r, EXPORT_LIVE)
        om.record_query("base", r["type_ids"][-1:], len(r["rows"]))
    finally:
        om.RESOURCE.reset(token)
    t = r["type"]
    props = [p for p in t["properties"] if p.get("visibility") != "hidden"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["primary_key", "title", *[p["api_name"] for p in props]])
    for row in r["rows"]:
        w.writerow([row["primary_key"], row["title"], *[_cell(row["properties"].get(p["api_name"])) for p in props]])
    name = f"{t.get('api_name') or t['display_name']}-{date.today().isoformat()}.csv"
    return Response(buf.getvalue(), media_type="text/csv", headers={"content-disposition": f'attachment; filename="{name}"'})


class BulkIn(BaseModel):
    action_type_id: str
    primary_keys: list[str] = Field(min_length=1, max_length=10_000)
    # the same values for every object (the object parameter is filled per object)
    parameters: dict[str, Any] = {}


@router.post("/explorer/bulk-action")
def bulk_action(req: BulkIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Apply a modify or delete action to every selected object; metered as one action editing them all. Every object
    is validated first as a single application would be (the action's permissions and submission criteria, for the
    caller — for a build, its user), so a bulk run cannot do what one by one would be refused."""
    import build_calls

    build_calls.enforce(request, ("write", "action_type", req.action_type_id, None))
    with build_calls.acting_for(request):
        return _bulk_action(req)


def _bulk_action(req: BulkIn) -> dict:
    with _lock:
        action = ontology._action_type(req.action_type_id)
    if "apply_action" in ontology.MODEL_HOOKS:
        import ontology_actions

        obj_param = next((p["id"] for p in action["parameters"] if p["type"] == "object"), None)
        if obj_param and action["kind"] != "create":
            for pk in req.primary_keys:
                ontology_actions.execute(action, {**req.parameters, obj_param: pk}, "validate")
    with _lock:
        action = ontology._action_type(req.action_type_id)
        if action["kind"] == "create":
            raise HTTPException(400, "bulk actions modify or delete the selected objects")
        if any(tc.split(":", 1)[-1] == "hide-action" for tc in action.get("type_classes") or []):
            raise HTTPException(400, "this action type is hidden from Object Explorer")
        obj_param = next(p["id"] for p in action["parameters"] if p["type"] == "object")
        edits = []
        for pk in req.primary_keys:
            edits += ontology.action_edits(action, {**req.parameters, obj_param: pk})
    token = om.RESOURCE.set("object-explorer")
    try:
        om.record_query("action", [action["object_type_id"]], len(edits))
    finally:
        om.RESOURCE.reset(token)
    written = ontology.apply_edits(edits, source=None)
    return {"applied": len(written)}


# ------------------------------------------------------------------------------------------------
# saved explorations
# ------------------------------------------------------------------------------------------------


class ExplorationIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    spec: Optional[dict] = None
    # an object set published from an Insight path: {workbook_id, path_id} (publishing again updates it)
    published_from: Optional[dict] = None


def _not_on_branch(what: str) -> None:
    """Saving resources is not branch-aware: refused while the request works in a scenario (Insight on a branch)."""
    if ontology.SCENARIO.get():
        raise HTTPException(400, f"{what} is not available on a branch: switch back to main")


@router.get("/explorations")
def list_explorations() -> list[dict]:
    me = (auth.current() or {}).get("id") or "local"
    with _lock:
        return [e for e in reversed(_all("explorations")) if e.get("owner") in (me, None) or e.get("shared")]


@router.post("/explorations")
def create_exploration(req: ExplorationIn) -> dict:
    if not req.name or req.spec is None:
        raise HTTPException(400, "name the exploration")
    _not_on_branch("Publishing an object set")
    with _lock:
        rec = {"id": _new_id("exp"), "name": req.name.strip(), "description": (req.description or "").strip(), "spec": req.spec,
               "owner": (auth.current() or {}).get("id") or "local", "created_at": _now(), "published_from": req.published_from}
        return _put("explorations", rec)


@router.put("/explorations/{exp_id}")
def save_exploration(exp_id: str, req: ExplorationIn) -> dict:
    _not_on_branch("Publishing an object set")
    with _lock:
        rec = _get("explorations", exp_id, "exploration")
        for k, v in req.model_dump(exclude_unset=True).items():
            if v is not None:
                rec[k] = v
        return _put("explorations", rec)


@router.delete("/explorations/{exp_id}")
def delete_exploration(exp_id: str) -> dict:
    with _lock:
        _get("explorations", exp_id, "exploration")
        _path("explorations", exp_id).unlink(missing_ok=True)
        return {"deleted": exp_id}


# ------------------------------------------------------------------------------------------------
# Insight workbooks (kept separate from Object Explorer's saved search specifications)
# ------------------------------------------------------------------------------------------------


class InsightWorkbookIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)
    spec: dict


class InsightSharingIn(BaseModel):
    enabled: bool
    role: Literal["viewer", "editor"] = "viewer"


def _insight_user() -> str:
    return (auth.current() or {}).get("id") or "local"


def _insight_view(rec: dict, user: str) -> dict:
    out = dict(rec)
    out["can_manage_sharing"] = rec.get("owner") == user
    out["can_edit"] = out["can_manage_sharing"] or bool(rec.get("shared") and rec.get("share_role") == "editor")
    return out


@router.get("/insight/workbooks")
def list_insight_workbooks() -> list[dict]:
    user = _insight_user()
    with _lock:
        return [_insight_view(w, user) for w in reversed(_all("insight-workbooks"))
                if w.get("owner") == user or w.get("shared")]


@router.get("/insight/workbooks/{workbook_id}")
def get_insight_workbook(workbook_id: str) -> dict:
    user = _insight_user()
    with _lock:
        rec = _get("insight-workbooks", workbook_id, "Insight workbook")
        if rec.get("owner") != user and not rec.get("shared"):
            raise HTTPException(404, "Insight workbook not found")
        return _insight_view(rec, user)


@router.post("/insight/workbooks")
def create_insight_workbook(req: InsightWorkbookIn) -> dict:
    _not_on_branch("Saving a workbook")
    user = _insight_user()
    with _lock:
        rec = {"id": _new_id("insight"), "name": req.name.strip(), "description": req.description.strip(),
               "spec": req.spec, "owner": user, "shared": False, "share_role": "viewer", "created_at": _now()}
        return _insight_view(_put("insight-workbooks", rec), user)


@router.put("/insight/workbooks/{workbook_id}")
def save_insight_workbook(workbook_id: str, req: InsightWorkbookIn) -> dict:
    _not_on_branch("Saving a workbook")
    user = _insight_user()
    with _lock:
        rec = _get("insight-workbooks", workbook_id, "Insight workbook")
        if rec.get("owner") != user and not (rec.get("shared") and rec.get("share_role") == "editor"):
            raise HTTPException(403, "you do not have edit access to this Insight workbook")
        rec.update({"name": req.name.strip(), "description": req.description.strip(), "spec": req.spec})
        return _insight_view(_put("insight-workbooks", rec), user)


@router.post("/insight/workbooks/{workbook_id}/sharing")
def share_insight_workbook(workbook_id: str, req: InsightSharingIn) -> dict:
    user = _insight_user()
    with _lock:
        rec = _get("insight-workbooks", workbook_id, "Insight workbook")
        if rec.get("owner") != user:
            raise HTTPException(403, "only the workbook owner can change sharing")
        rec["shared"] = req.enabled
        rec["share_role"] = req.role
        return _insight_view(_put("insight-workbooks", rec), user)


@router.delete("/insight/workbooks/{workbook_id}")
def delete_insight_workbook(workbook_id: str) -> dict:
    user = _insight_user()
    with _lock:
        rec = _get("insight-workbooks", workbook_id, "Insight workbook")
        if rec.get("owner") != user:
            raise HTTPException(403, "only the workbook owner can delete it")
        _path("insight-workbooks", workbook_id).unlink(missing_ok=True)
        return {"deleted": workbook_id}


# ------------------------------------------------------------------------------------------------
# Object Views
# ------------------------------------------------------------------------------------------------


class ObjectViewConfig(BaseModel):
    # [{kind: workshop|quiver|url, id?, url?, label}]
    related: list[dict] = []
    # property API names shown first in the header card
    header_properties: list[str] = []


@router.put("/object-types/{type_id}/object-view")
def save_object_view(type_id: str, req: ObjectViewConfig) -> dict:
    """The related resources and header properties of the object type's Object View."""
    with _lock:
        t = ontology._object_type(type_id)
        om.require_role(t.get("ontology_id"), "editor", t, "configure Object Views")
        for r in req.related:
            if r.get("kind") not in ("workshop", "quiver", "url") or not r.get("label"):
                raise HTTPException(400, "a related resource is a Workshop module, a Quiver analysis or a link, with a label")
        t["object_view"] = req.model_dump()
        _put("object-types", t)
        return t["object_view"]


@router.get("/object-view/{type_id}/{pk:path}")
def object_view(type_id: str, pk: str, request: Request = None) -> dict:  # type: ignore[assignment]
    """Everything an Object View shows about one object."""
    token = om.RESOURCE.set(f"object-view:{type_id}")
    try:
        with _for_build(request, type_id), _lock:
            t = ontology._object_type(type_id)
            key, obj = ontology._find(t, pk)
            pub = ontology._public_object(t, key, obj)
            links = om.object_links(type_id, key, limit=25)
            actions = [a for a in _all("action-types") if a["object_type_id"] == type_id and a["kind"] != "create"
                       and not any(tc.split(":", 1)[-1] == "hide-action" for tc in a.get("type_classes") or [])]
            interfaces = []
            for imp in t.get("implements") or []:
                iface = _read(_path("interfaces", imp.get("interface_id", "")))
                if iface:
                    interfaces.append({"id": iface["id"], "display_name": iface["display_name"],
                                       "properties": {ip: om.iface_value(pub["properties"], local) for ip, local in (imp.get("mapping") or {}).items()}})
            automations = [{"id": a["id"], "name": a["name"], "enabled": a.get("enabled", True)} for a in _all("automations")
                           if (a.get("condition") or {}).get("object_type_id") == type_id]
            # hierarchy breadcrumbs: a link type classed hierarchy:parent points from a child (source) to its parent (target)
            crumbs = []
            cur_t, cur_pk = t, key
            seen = {(t["id"], key)}
            for _ in range(6):
                parent = None
                for lt, direction in om.links_of(cur_t["id"]):
                    if direction == "forward" and "hierarchy:parent" in (lt.get("type_classes") or []):
                        got = om.linked_map(lt, direction, {cur_pk}).get(cur_pk) or []
                        if got:
                            pt = _read(_path("object-types", om.side_of(lt, direction)[1]["object_type_id"]))
                            parent = (pt, got[0])
                            break
                if not parent or not parent[0]:
                    break
                pt, ppk = parent
                if (pt["id"], ppk) in seen:
                    break
                seen.add((pt["id"], ppk))
                pobj = ontology.load_objects(pt["id"]).get(ppk)
                if not pobj:
                    break
                crumbs.insert(0, {"object_type_id": pt["id"], "primary_key": ppk, "title": ontology._public_object(pt, ppk, pobj)["title"]})
                cur_t, cur_pk = pt, ppk
        history = om.object_history(type_id, key)
    finally:
        om.RESOURCE.reset(token)
    return {
        "object": pub,
        "object_type": ontology._type_summary(t),
        "links": links,
        "actions": actions,
        "interfaces": interfaces,
        "automations": automations,
        "history": history,
        "breadcrumbs": crumbs,
        "has_time_series": any(p["type"] == "timeseries" for p in t["properties"]) or bool(t.get("time_series")),
        "related": (t.get("object_view") or {}).get("related", []),
        "header_properties": (t.get("object_view") or {}).get("header_properties", []),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


# ------------------------------------------------------------------------------------------------
# static lists (Insight "Save as list"): a point-in-time snapshot of object IDs
# ------------------------------------------------------------------------------------------------


class ObjectListIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    object_type_id: Optional[str] = None
    primary_keys: Optional[list[str]] = Field(None, max_length=200_000)
    shared: Optional[bool] = None


class ListChangeIn(BaseModel):
    add: list[str] = Field(default_factory=list, max_length=200_000)
    remove: list[str] = Field(default_factory=list, max_length=200_000)


def _list_rec(list_id: str, write: bool = False) -> dict:
    me = _insight_user()
    rec = _get("object-lists", list_id, "list")
    if rec.get("owner") != me and not rec.get("shared"):
        raise HTTPException(404, "list not found")
    if write and rec.get("owner") != me:
        raise HTTPException(403, "only the list's owner can change it")
    auth.check_resource("object_type", rec["object_type_id"])
    return rec


def _list_view(rec: dict) -> dict:
    return {**{k: v for k, v in rec.items() if k != "primary_keys"}, "count": len(rec.get("primary_keys") or [])}


@router.get("/object-lists")
def list_object_lists(request: Request = None) -> list[dict]:  # type: ignore[assignment]
    import build_calls

    with build_calls.acting_for(request):
        return _list_object_lists()


def _list_object_lists() -> list[dict]:
    me = _insight_user()
    with _lock:
        rows = [r for r in reversed(_all("object-lists")) if r.get("owner") == me or r.get("shared")]
    out = []
    for r in rows:
        try:
            auth.check_resource("object_type", r["object_type_id"])
        except HTTPException:
            continue  # lists of object types the user may not see
        out.append(_list_view(r))
    return out


@router.post("/object-lists")
def create_object_list(req: ObjectListIn, request: Request = None) -> dict:  # type: ignore[assignment]
    import build_calls

    if req.object_type_id:
        build_calls.enforce(request, ("read", "object_type", req.object_type_id, None))
    with build_calls.acting_for(request):
        return _create_object_list(req)


def _create_object_list(req: ObjectListIn) -> dict:
    _not_on_branch("Saving a list")
    if not req.name or not req.object_type_id:
        raise HTTPException(400, "name the list and choose its object type")
    with _lock:
        ontology._object_type(req.object_type_id)
        auth.check_resource("object_type", req.object_type_id)
        (ontology.DIR / "object-lists").mkdir(parents=True, exist_ok=True)
        keys = list(dict.fromkeys(str(k) for k in req.primary_keys or []))
        rec = {"id": _new_id("list"), "name": req.name.strip(), "description": (req.description or "").strip(), "object_type_id": req.object_type_id,
               "primary_keys": keys, "owner": _insight_user(), "shared": bool(req.shared), "created_at": _now(), "updated_at": _now()}
        return _list_view(_put("object-lists", rec))


@router.get("/object-lists/{list_id}")
def get_object_list(list_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    import build_calls

    with build_calls.acting_for(request), _lock:
        return _list_rec(list_id)


@router.put("/object-lists/{list_id}")
def change_object_list(list_id: str, req: ListChangeIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Add or remove objects (by primary key)."""
    import build_calls

    _not_on_branch("Changing a list")
    with build_calls.acting_for(request), _lock:
        rec = _list_rec(list_id, write=True)
        gone = set(req.remove)
        rec["primary_keys"] = [k for k in dict.fromkeys([*rec["primary_keys"], *map(str, req.add)]) if k not in gone]
        rec["updated_at"] = _now()
        return _list_view(_put("object-lists", rec))


@router.patch("/object-lists/{list_id}")
def update_object_list(list_id: str, req: ObjectListIn, request: Request = None) -> dict:  # type: ignore[assignment]
    import build_calls

    _not_on_branch("Changing a list")
    with build_calls.acting_for(request), _lock:
        rec = _list_rec(list_id, write=True)
        for k in ("name", "description", "shared"):
            v = getattr(req, k)
            if v is not None:
                rec[k] = v.strip() if isinstance(v, str) else v
        rec["updated_at"] = _now()
        return _list_view(_put("object-lists", rec))


@router.delete("/object-lists/{list_id}")
def delete_object_list(list_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    import build_calls

    with build_calls.acting_for(request), _lock:
        _list_rec(list_id, write=True)
        _path("object-lists", list_id).unlink(missing_ok=True)
        return {"deleted": list_id}


# ---- Object Explorer home: one search across object types, and the landing page ("Discover your Nexus") ----

class KeywordIn(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    # the object types to search ("Search across"); empty: every object type the user can see
    object_type_ids: list[str] = []
    # results of one object type only (the "Filter results by type" list)
    only_type: Optional[str] = None
    offset: int = Field(0, ge=0)
    limit: int = Field(50, ge=1, le=200)


def _plain_terms(q: str) -> list[str]:
    """The words of a query, for highlighting the properties that matched (quotes and operators dropped)."""
    return [w.lower() for w in re.findall(r"[\w\-./@]+", q) if w.upper() not in ("AND", "OR", "NOT") and len(w.strip("*?")) > 0]


def _matches(t: dict, r: dict, terms: list[str], names: list[str]) -> list[dict]:
    """Up to three properties whose value holds a word of the query: what the result list shows under the title."""
    out = []
    by = {p["api_name"]: p for p in t["properties"]}
    for n in names:
        v = r["properties"].get(n)
        if v is None or isinstance(v, (dict,)):
            continue
        text = " ".join(str(x) for x in v) if isinstance(v, list) else str(v)
        low = text.lower()
        if any(w.strip("*?") in low for w in terms):
            out.append({"property": n, "display_name": by[n].get("display_name") or n, "value": text[:200]})
            if len(out) >= 3:
                break
    return out


def _rank(r: dict, terms: list[str]) -> tuple:
    title = str(r.get("title") or "").lower()
    whole = " ".join(terms)
    return (0 if title == whole else 1 if title.startswith(whole) else 2 if all(w.strip("*?") in title for w in terms) else 3, title)


# "All object types": a keyword scan of every object type would read millions of objects, so it skips test object types
# and the largest ones (searched when picked in "Search across") and stops at a time budget; what was left out is told
KEYWORD_ALL_MAX_OBJECTS = 100_000
KEYWORD_BUDGET_S = 6.0


@router.post("/explorer/keyword")
def keyword_search(req: KeywordIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """A keyword search across object types: the matching objects (best first, with the properties that matched), the
    count per object type, and the object types whose name matches."""
    import time

    import test_space

    token = om.RESOURCE.set("object-explorer")
    terms = _plain_terms(req.q)
    started = time.monotonic()
    try:
        with _for_build(request, None):
            with _lock:
                visible = auth.visible_resources("object_type", _all("object-types"))
                counts = {t["id"]: ontology.object_count(t["id"]) for t in visible}
            wanted = set(req.object_type_ids)
            types = [t for t in visible if (t["id"] in wanted) if wanted] if wanted else                 [t for t in visible if t.get("visibility") != "hidden" and not test_space.is_test_name(t.get("display_name"))]
            skipped = []
            if not wanted:
                big = [t for t in types if (counts.get(t["id"]) or 0) > KEYWORD_ALL_MAX_OBJECTS]
                skipped = [{"id": t["id"], "display_name": t["display_name"], "object_count": counts.get(t["id"]), "reason": "large"} for t in big]
                types = [t for t in types if (counts.get(t["id"]) or 0) <= KEYWORD_ALL_MAX_OBJECTS]
                # promoted / prominent first, then small to large: the budget covers the most object types
                types.sort(key=lambda t: (0 if t.get("status") == "promoted" or t.get("visibility") == "prominent" else 1, counts.get(t["id"]) or 0))
            by_type, hits, searched = [], [], []
            for i, meta in enumerate(types):
                if not wanted and time.monotonic() - started > KEYWORD_BUDGET_S:
                    skipped += [{"id": t["id"], "display_name": t["display_name"], "object_count": counts.get(t["id"]), "reason": "time"} for t in types[i:]]
                    break
                try:
                    with _lock:
                        t = ontology._object_type(meta["id"])
                        names = _searchable(t)
                        rows = ontology_search.keyword_filter(t, _rows(t), req.q, names)
                except HTTPException:
                    continue
                searched.append(t["id"])
                if not rows:
                    continue
                by_type.append({"id": t["id"], "display_name": t["display_name"], "count": len(rows), "icon": t.get("icon"), "color": t.get("color")})
                if req.only_type and req.only_type != t["id"]:
                    continue
                for r in rows:
                    hits.append((_rank(r, terms), t, r, names))
            hits.sort(key=lambda h: h[0])
            page = hits[req.offset: req.offset + req.limit]
            objects = [{"object_type_id": t["id"], "type_name": t["display_name"], "icon": t.get("icon"), "color": t.get("color"),
                        "primary_key": r["primary_key"], "title": r["title"], "matches": _matches(t, r, terms, names)}
                       for _, t, r, names in page]
            q = req.q.strip().lower()
            type_hits = [{"id": t["id"], "display_name": t["display_name"], "description": t.get("description") or "", "object_count": counts.get(t["id"])}
                         for t in visible if t.get("visibility") != "hidden" and not test_space.is_test_name(t.get("display_name"))
                         and (q in t["display_name"].lower() or q in (t.get("api_name") or "").lower() or any(q in str(a).lower() for a in t.get("aliases") or []))]
        cost = om.record_query("base", searched[:1], len(hits))
    finally:
        om.RESOURCE.reset(token)
    by_type.sort(key=lambda x: -x["count"])
    total = len(hits) if not req.only_type else sum(x["count"] for x in by_type)
    return {"q": req.q, "total": total, "by_type": by_type, "objects": objects, "object_types": type_hits[:50],
            "searched": len(searched), "skipped": skipped[:50], "skipped_count": len(skipped), "compute_seconds": cost}


@router.get("/explorer/home")
def explorer_home(request: Request = None) -> dict:  # type: ignore[assignment]
    """The landing page's "Discover your Nexus": object type groups, the applications built on each object type
    (Workshop modules, Slate apps, Object Views) and the link types touching it."""
    import test_space

    with _for_build(request, None), _lock:
        visible = [t for t in auth.visible_resources("object_type", _all("object-types"))
                   if t.get("visibility") != "hidden" and not test_space.is_test_name(t.get("display_name"))]
        ids = {t["id"] for t in visible}
        groups = [{"id": g["id"], "name": g["name"], "description": g.get("description") or "",
                   "object_type_ids": [t["id"] for t in visible if g["id"] in (t.get("groups") or [])]} for g in om._groups()]
        links: Counter = Counter()
        for lt in _all("link-types"):
            for side in ("source", "target"):
                tid = (lt.get(side) or {}).get("object_type_id")
                if tid in ids:
                    links[tid] += 1
    apps: dict[str, list[dict]] = defaultdict(list)
    app_list = []
    try:
        import workshop

        for p in workshop.DIR.glob("*.json"):
            m = _read(p) or {}
            if not m.get("id"):
                continue
            text = json.dumps(m.get("widgets") or m.get("pages") or m, ensure_ascii=False)
            used = [tid for tid in ids if tid in text]
            if used:
                entry = {"kind": "workshop", "id": m["id"], "name": m.get("name") or m["id"], "href": f"/workshop/{m['id']}"}
                app_list.append({**entry, "object_type_ids": used})
                for tid in used:
                    apps[tid].append(entry)
    except Exception:  # noqa: BLE001 - the applications column is a convenience
        pass
    return {"groups": [g for g in groups if g["object_type_ids"]],
            "applications": sorted(app_list, key=lambda a: a["name"].lower()),
            "object_types": {tid: {"applications": len(apps.get(tid, [])), "links": links.get(tid, 0)} for tid in ids}}
