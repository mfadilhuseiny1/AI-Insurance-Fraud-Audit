"""Semantic search over the Ontology (Palantir's Semantic search docs: overview, document processing, embedding models,
ontology-augmented generation, Palantir-provided and custom model workflows).

* Embeddings live on vector properties. A vector property may name its embedding model and the text property it embeds
  (`embedding_model`, `embedding_source`): the query is embedded with the same model (asymmetric models get their query
  prefix), and "Embed objects" fills the vector property from the source property, re-embedding only changed text.
* KNN (k nearest neighbors, 1–500) ranks objects by cosine similarity to the query text or a query vector, ordered by
  relevance. Ranked keyword search scores objects with BM25 over their text properties (any query token matches;
  relevance is relative to the other objects, so it adapts to a domain's vocabulary). Hybrid search fuses both lists
  with reciprocal rank fusion (RRF: score = Σ 1 / (k + rank)). Object types with ANN_MIN (5000) or more objects use
  an approximate nearest neighbour (IVF) index kept next to the objects (vector_ann.py); `exact` scans every vector.
  With a current index the search / KNN routes read only the top candidates' records, not the whole type (knn_fast).
* Advanced retrieval: HyDE (a language model writes a hypothetical passage answering the query, which is embedded
  instead), query enriching (search terms with synonyms, stop words removed: for keyword search) and query extraction
  (the core ask: for semantic search). Prompts can be replaced.
* Chunking setup: from an object type and a text property, create a chunk object type (chunk_id = object id + "_" +
  position, the object id linked back with a foreign key link type, the chunk text, its position and an embedding
  vector), split recursively on prioritized separators with a chunk size and overlap, and embed every chunk.
* Used by Object Explorer (semantic search box), Workshop (KNN object tables fed by a text input), AIP Agent Studio (the
  "Ontology semantic search" tool), AIP Logic (the semantic search block), Python functions (`nearest_neighbors`,
  `keyword_search`, `hybrid_search`) and the Semantic Search app. Each search is metered as an advanced Ontology query.
"""
from __future__ import annotations

import hashlib
import math
import re
import threading
import time
from collections import Counter, OrderedDict
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import ontology
import ontology_model as om
import vector_ann

router = APIRouter(prefix="/api/ontology")

MAX_K = 500
DEFAULT_PROMPTS = {
    "hyde": "You are a domain specialist assistant helping colleagues find relevant documents for their queries.\n"
            "Given the following user query:\n{query}\n\nWrite one short hypothetical passage, in the style of the documents being "
            "searched, that answers it. Answer with the passage only.",
    "enrich": "You help users find relevant documents with keyword search in an internal database.\nGiven the following user query: "
              "{query}\nGive a list of search terms that would find relevant results. Remove stop words and filler phrases, and add "
              "synonyms and related terms for the most important terms. Answer with comma-separated values only.",
    "extract": "You are preparing a user-given query for a semantic search. Extract what the user is looking for: the key actions "
               "with their subjects, conditions and qualifiers, removing filler words and requests such as 'please find'. Keep every "
               "subject and qualifier; a query that is already a search phrase stays as it is.\nGiven the following user query: "
               "{query}\nReturn the extracted phrases only, in the query's language, delimited by full stops.",
}
STOP_WORDS = set("""a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our
please should so than that the their them then there these they this to us was we were what when where which who why will with
would you your help find show tell give me""".split())
_TOKEN = re.compile(r"[\w']+", re.UNICODE)

_cache: "OrderedDict[tuple, list[float]]" = OrderedDict()
_cache_lock = threading.Lock()


# ------------------------------------------------------------------------------------------------
# embeddings
# ------------------------------------------------------------------------------------------------


def _vectors() -> Any:
    import vectors

    return vectors


def model_of(p: dict) -> tuple[str, int]:
    """(embedding model, dimension) of a vector property."""
    v = _vectors()
    model = p.get("embedding_model") or v.DEFAULT_MODEL
    dim = int(p.get("vector_dimension") or v.MODELS_BY_ID.get(model, {}).get("dimension") or 1024)
    return model, dim


def embed(texts: list[str], model: str, dim: int, kind: Literal["query", "doc"]) -> list[list[float]]:
    out: list[Optional[list[float]]] = [None] * len(texts)
    todo: list[int] = []
    with _cache_lock:
        for i, t in enumerate(texts):
            hit = _cache.get((model, dim, kind, t))
            if hit is not None:
                out[i] = hit
                _cache.move_to_end((model, dim, kind, t))
            else:
                todo.append(i)
    if todo:
        try:
            vecs, _cost = _vectors().embed([texts[i] for i in todo], model, dim, kind)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"the embedding model failed: {e}") from None
        with _cache_lock:
            for i, v in zip(todo, vecs):
                out[i] = v
                # a registered model (a published function) is not cached: its next release may answer differently,
                # and whether the caller may run it is checked on each call
                if kind == "query" and not str(model).startswith("function:"):
                    _cache[(model, dim, kind, texts[i])] = v
                    while len(_cache) > 512:
                        _cache.popitem(last=False)
    return [x or [] for x in out]


def _cos(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return -2.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def vector_property(t: dict, name: Optional[str]) -> dict:
    vecs = [p for p in t["properties"] if p["type"] == "vector"]
    if not vecs:
        raise HTTPException(400, f"{t['display_name']} has no vector (embedding) property")
    if not name:
        return vecs[0]
    p = next((x for x in vecs if x["api_name"] == name), None)
    if not p:
        raise HTTPException(400, f"{name} is not a vector property of {t['display_name']}")
    return p


def text_properties(t: dict, names: Optional[list[str]] = None) -> list[str]:
    if names:
        return [n for n in names if any(p["api_name"] == n for p in t["properties"])]
    strings = [p for p in t["properties"] if p["type"] == "string" and p.get("visibility") != "hidden" and not p.get("array")]
    hinted = [p["api_name"] for p in strings if "searchable" in (p.get("render_hints") or [])]
    return hinted or [p["api_name"] for p in strings]


# ------------------------------------------------------------------------------------------------
# ranking
# ------------------------------------------------------------------------------------------------


RESCORE_MARGIN = 16  # candidates beyond k re-scored exactly, so float32 rounding cannot change the top k


def knn(t: dict, rows: list[dict], query: Any, prop: Optional[str], k: int, exact: bool = False,
        scan_rows: bool = False) -> list[tuple[dict, float]]:
    """The k rows nearest the query (text or vector), most relevant first. Large object types use the ANN index
    (vector_ann.py) unless `exact` (then the index's matrix is scanned exactly, or the rows' own vectors when there is
    no current index); candidates are always re-scored with the exact cosine on the rows' vectors."""
    p = vector_property(t, prop)
    if isinstance(query, str):
        if not query.strip():
            return []
        model, dim = model_of(p)
        qv = embed([query], model, dim, "query")[0]
    else:
        qv = [float(x) for x in query or []]
    k = max(1, min(k, MAX_K))
    name = p["api_name"]
    picked: Optional[list[dict]] = None
    from_index = False
    if qv and len(rows) >= vector_ann.NUMPY_MIN:
        at = {r["primary_key"]: i for i, r in enumerate(rows) if r.get("object_type_id") == t["id"]}
        found = None if scan_rows else vector_ann.candidates(t["id"], name, qv, len(rows), at, k + RESCORE_MARGIN, exact)
        if found is not None:
            picked, from_index = [rows[i] for i in sorted(at[pk] for pk in found[0])], True
        if picked is None:
            top = vector_ann.exact_top(qv, [r["properties"].get(name) for r in rows], k + RESCORE_MARGIN)
            if top is not None:
                picked = [rows[i] for i in top]
    scored = [(r, _cos(qv, r["properties"].get(name) or [])) for r in (rows if picked is None else picked)]
    scored = [x for x in scored if x[1] > -2]
    scored.sort(key=lambda x: x[1], reverse=True)
    if from_index and len(scored) < min(k, len(rows)):
        # the index found too few (filters, or vectors hidden from this user): scan the rows themselves
        return knn(t, rows, qv, prop, k, exact=True, scan_rows=True)
    return scored[:k]


def query_vector(t: dict, query: Any, prop: Optional[str]) -> list[float]:
    """The query as a vector: a text embedded with the vector property's model (as a query), or the vector given."""
    if isinstance(query, str):
        if not query.strip():
            return []
        model, dim = model_of(vector_property(t, prop))
        return embed([query], model, dim, "query")[0]
    return [float(x) for x in query or []]


def _row_secured(t: dict) -> bool:
    """Objects of the type may be hidden from some users (an object security policy or mandatory controls)."""
    return bool(t.get("security")) or any(p.get("mandatory_control") for p in t["properties"])


def knn_fast(t: dict, qv: list[float], prop: Optional[str], k: int, exact: bool = False,
             pks: Optional[list[str]] = None) -> Optional[tuple[list[tuple[dict, float]], Optional[int]]]:
    """KNN without loading the object type: the ANN index (vector_ann.current) ranks the vectors and only the
    candidates' records are read (ontology_store.get_many), checked like every object read (the type's markings, row
    visibility, property security: a hidden vector drops the object) and re-scored with the exact cosine. Candidates
    left short by those checks are fetched again, more of them each round, from an exact scan of the index's matrix.
    Returns (the k nearest rows with their cosines, how many objects were searched: None for a type whose objects may
    be hidden from the user, where that count is not known without loading them), or None when there is no current
    index (none, stale after a write, a scenario, a function run snapshot) or a write raced the query: the caller then
    loads the rows."""
    if not qv or ontology.SCENARIO.get() or ontology.SNAPSHOT.get():
        return None
    p = vector_property(t, prop)
    name = p["api_name"]
    idx = vector_ann.current(t["id"], name, len(qv))
    if idx is None:
        return None
    import auth
    import ontology_store

    auth.check_resource("object_type", t["id"])  # as ontology._objects does for every object read
    allowed = None if pks is None else {str(x) for x in pks if str(x) in idx.pos}
    k = max(1, min(k, MAX_K))
    m = k + RESCORE_MARGIN
    rows: dict[str, Optional[dict]] = {}
    exact_now = exact
    while True:
        got = vector_ann.ranked(idx, qv, m, allowed, exact_now)
        if got is None:
            return None
        cands, from_ann, complete = got
        need = [pk for pk in cands if pk not in rows]
        if need:
            objs = ontology_store.get_many(t["id"], need)
            for pk in need:
                o = objs.get(pk)
                rows[pk] = ontology._public_object(t, pk, o) if o is not None and ontology._can_see(t, o) else None
        scored = [(r, _cos(qv, r["properties"].get(name) or [])) for r in (rows[pk] for pk in cands) if r is not None]
        scored = [x for x in scored if x[1] > -2]
        if complete or len(scored) >= k + RESCORE_MARGIN or (from_ann and len(scored) >= k):
            break
        # too few left (objects or vectors hidden from this user): scan the index exactly, four times as deep
        if not from_ann:
            m *= 4
        exact_now = True
    if idx.stat != vector_ann._stat(t["id"]):
        return None  # written while we read: the records may be newer than the index
    scored.sort(key=lambda x: x[1], reverse=True)
    searched = None if _row_secured(t) else (idx.n if allowed is None else len(allowed))
    return scored[:k], searched


def rank_type(t: dict, query: str, mode: str, k: int, vector: Optional[str] = None, text: Optional[list[str]] = None,
              n_vector: Optional[int] = None, n_keyword: Optional[int] = None, rrf_k: int = 60, prepared: Optional[dict] = None,
              exact: bool = False, pks: Optional[list[str]] = None, query_vec: Optional[list[float]] = None) -> tuple[list[dict], Optional[int]]:
    """rank() over an object type's objects (or the primary keys given): (ranked rows, how many were searched).
    Semantic ranking with a current ANN index reads only the candidates (knn_fast); keyword and hybrid ranking, and
    every case knn_fast declines, load the visible rows."""
    prepared = prepared or {"semantic": query, "keyword": query}
    if mode == "semantic":
        qv = query_vec if query_vec is not None else query_vector(t, prepared["semantic"], vector)
        fast = knn_fast(t, qv, vector, n_vector or k, exact, pks) if qv else None
        if fast is not None:
            sem, searched = fast
            out = [{**r, "relevance": round(s, 6), "ranks": {"semantic": {"rank": i + 1, "score": round(s, 4)}}}
                   for i, (r, s) in enumerate(sem[: max(1, min(k, MAX_K))])]
            return out, searched
        prepared = {**prepared, "semantic": qv}  # not embedded twice
    rows = _rows(t, pks)
    return rank(t, rows, query, mode, k, vector, text, n_vector, n_keyword, rrf_k, prepared, exact), len(rows)


def tokens(text: str) -> list[str]:
    return [w for w in (m.lower() for m in _TOKEN.findall(text or "")) if w not in STOP_WORDS and len(w) > 1]


def keyword(t: dict, rows: list[dict], query: str, props: Optional[list[str]], k: int) -> list[tuple[dict, float]]:
    """Ranked keyword search (BM25): any query token matches; rarer tokens weigh more."""
    q = list(dict.fromkeys(tokens(query)))
    if not q:
        return []
    names = text_properties(t, props)
    docs = [tokens(" ".join([r.get("title") or ""] + [str(r["properties"].get(n) or "") for n in names])) for r in rows]
    n = len(docs) or 1
    avg = sum(len(d) for d in docs) / n or 1.0
    df = Counter(w for d in docs for w in set(d))
    k1, b = 1.2, 0.75
    scored = []
    for r, d in zip(rows, docs):
        tf = Counter(d)
        s = 0.0
        for w in q:
            if tf[w]:
                idf = math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * tf[w] * (k1 + 1) / (tf[w] + k1 * (1 - b + b * len(d) / avg))
        if s > 0:
            scored.append((r, s))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[: max(1, min(k, MAX_K))]


def rrf(lists: list[list[dict]], k: int = 60) -> list[tuple[dict, float]]:
    """Reciprocal rank fusion of ranked lists of rows (by object type and primary key)."""
    scores: dict[tuple, float] = {}
    rows: dict[tuple, dict] = {}
    for lst in lists:
        for rank, r in enumerate(lst):
            key = (r["object_type_id"], r["primary_key"])
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            rows.setdefault(key, r)
    return sorted(((rows[x], s) for x, s in scores.items()), key=lambda x: x[1], reverse=True)


def _llm(prompt: str, model: Optional[str]) -> str:
    import pipeline_ai

    try:
        return str(pipeline_ai.chat(model or ontology.DEFAULT_LLM, "", prompt, None, 0, 600)).strip()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"the language model failed: {e}") from None


def prepare(query: str, hyde: bool, augmentation: str, prompts: Optional[dict], model: Optional[str]) -> dict:
    """The queries each search runs with: HyDE passage (semantic), enriched terms (keyword) or extracted ask (semantic)."""
    prompts = {**DEFAULT_PROMPTS, **(prompts or {})}
    out = {"semantic": query, "keyword": query}
    if augmentation == "extract":
        out["semantic"] = out["extracted"] = _llm(prompts["extract"].replace("{query}", query), model)
    if augmentation == "enrich":
        out["keyword"] = out["enriched"] = _llm(prompts["enrich"].replace("{query}", query), model)
    if hyde:
        out["semantic"] = out["hypothetical"] = _llm(prompts["hyde"].replace("{query}", out["semantic"]), model)
    return out


def _rows(t: dict, pks: Optional[list[str]] = None) -> list[dict]:
    objs = ontology._objects(t["id"])
    keys = [str(x) for x in pks] if pks is not None else list(objs)
    return [ontology._public_object(t, pk, objs[pk]) for pk in keys if pk in objs and ontology._can_see(t, objs[pk])]


def rank(t: dict, rows: list[dict], query: str, mode: str, k: int, vector: Optional[str] = None, text: Optional[list[str]] = None,
         n_vector: Optional[int] = None, n_keyword: Optional[int] = None, rrf_k: int = 60, prepared: Optional[dict] = None,
         exact: bool = False) -> list[dict]:
    """Rows ranked by the mode, each with `relevance` and the rank it got from each method."""
    prepared = prepared or {"semantic": query, "keyword": query}
    sem = knn(t, rows, prepared["semantic"], vector, n_vector or k, exact) if mode in ("semantic", "hybrid") else []
    kw = keyword(t, rows, prepared["keyword"], text, n_keyword or k) if mode in ("keyword", "hybrid") else []
    ranks: dict[tuple, dict] = {}
    for name, lst in (("semantic", sem), ("keyword", kw)):
        for i, (r, s) in enumerate(lst):
            ranks.setdefault((r["object_type_id"], r["primary_key"]), {})[name] = {"rank": i + 1, "score": round(s, 4)}
    if mode == "semantic":
        ordered = sem
    elif mode == "keyword":
        ordered = kw
    else:
        ordered = rrf([[r for r, _ in sem], [r for r, _ in kw]], rrf_k)
    out = []
    for r, s in ordered[: max(1, min(k, MAX_K))]:
        out.append({**r, "relevance": round(s, 6), "ranks": ranks.get((r["object_type_id"], r["primary_key"]), {})})
    return out


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


class SearchIn(BaseModel):
    object_type_id: str
    query: str = Field(min_length=1, max_length=4000)
    mode: Literal["semantic", "keyword", "hybrid"] = "semantic"
    k: int = Field(10, ge=1, le=MAX_K)
    vector_property: Optional[str] = None
    text_properties: Optional[list[str]] = None
    # hybrid: how many results each search contributes before fusion, and RRF's k
    n_vector: Optional[int] = Field(None, ge=1, le=MAX_K)
    n_keyword: Optional[int] = Field(None, ge=1, le=MAX_K)
    rrf_k: int = Field(60, ge=1, le=1000)
    hyde: bool = False
    augmentation: Literal["none", "enrich", "extract"] = "none"
    prompts: Optional[dict[str, str]] = None
    model: Optional[str] = None  # the language model for HyDE and query augmentation
    primary_keys: Optional[list[str]] = None  # search within these objects only
    exact: bool = False  # scan every vector instead of the ANN index
    resource: Optional[str] = None


def _for_build(request: Optional[Request], type_id: str) -> Any:
    """A semantic search / KNN made for a build (service token + X-Bsai-Build): the object type checked as the build's
    identity, then the call runs as that user (build_calls.acting_for), so object / property security, restricted
    views and hidden objects apply to the ranking as to a request of their own. Other calls: unchanged."""
    import build_calls

    build_calls.enforce(request, ("read", "object_type", type_id, None))
    return build_calls.acting_for(request)


@router.post("/semantic/search")
def search(req: SearchIn, request: Request = None) -> dict:  # type: ignore[assignment]
    with _for_build(request, req.object_type_id):
        return _search(req)


def _search(req: SearchIn) -> dict:
    token = om.RESOURCE.set(req.resource or "semantic-search")
    try:
        started = time.monotonic()
        t = ontology._object_type(req.object_type_id)
        prepared = prepare(req.query, req.hyde and req.mode != "keyword", req.augmentation, req.prompts, req.model)
        prepared_ms = int((time.monotonic() - started) * 1000)
        out, searched = rank_type(t, req.query, req.mode, req.k, req.vector_property, req.text_properties, req.n_vector, req.n_keyword,
                                  req.rrf_k, prepared, req.exact, req.primary_keys)
        om.record_query("advanced", [t["id"]], searched if searched is not None else len(out))
        return {"query": prepared, "mode": req.mode, "searched": searched, "results": out,
                "timings": {"prepare_ms": prepared_ms, "total_ms": int((time.monotonic() - started) * 1000)}}
    finally:
        om.RESOURCE.reset(token)


class KnnIn(BaseModel):
    object_type_id: str
    query: Optional[str] = None
    vector: Optional[list[float]] = None
    property: Optional[str] = None
    k: int = Field(10, ge=1, le=MAX_K)
    mode: Literal["semantic", "keyword", "hybrid"] = "semantic"
    text_properties: Optional[list[str]] = None
    primary_keys: Optional[list[str]] = None
    exact: bool = False
    resource: Optional[str] = None


@router.post("/semantic/knn")
def knn_route(req: KnnIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Nearest neighbors (or keyword / hybrid ranking) for SDKs: the objects, most relevant first."""
    with _for_build(request, req.object_type_id):
        return _knn(req)


def _knn(req: KnnIn) -> dict:
    token = om.RESOURCE.set(req.resource or "function")
    try:
        t = ontology._object_type(req.object_type_id)
        if req.vector is not None:
            qv = [float(x) for x in req.vector]
            fast = knn_fast(t, qv, req.property, req.k, req.exact, req.primary_keys) if qv else None
            if fast is not None:
                found, searched = fast
            else:
                rows = _rows(t, req.primary_keys)
                found, searched = knn(t, rows, qv, req.property, req.k, req.exact), len(rows)
            res = [{**r, "relevance": round(s, 6)} for r, s in found]
        else:
            if not req.query:
                raise HTTPException(400, "give a query text or a query vector")
            res, searched = rank_type(t, req.query, req.mode, req.k, req.property, req.text_properties, exact=req.exact, pks=req.primary_keys)
        om.record_query("advanced", [t["id"]], searched if searched is not None else len(res))
        return {"objects": res}
    finally:
        om.RESOURCE.reset(token)


@router.get("/semantic/config")
def config() -> dict:
    """Embedding models, default prompts and the object types with vector properties."""
    v = _vectors()
    types = []
    for t in ontology.list_object_types():
        vecs = [p for p in t["properties"] if p["type"] == "vector"]
        if vecs:
            types.append({"id": t["id"], "display_name": t["display_name"], "object_count": t.get("object_count"),
                          "vector_properties": [{"api_name": p["api_name"], "display_name": p["display_name"], "dimension": p.get("vector_dimension"),
                                                 "model": model_of(p)[0], "source": p.get("embedding_source")} for p in vecs],
                          "text_properties": text_properties(t), "media_properties": [p["api_name"] for p in t["properties"] if p["type"] == "media"]})
    # provider models, then the registered ones the caller can see (functions implementing the Embedding interface)
    return {"models": [{"id": m["id"], "label": m["label"], "dimension": m.get("dimension"), "dimensions": m.get("dimensions"), "note": m.get("note"),
                        "query_prefix": bool(m.get("query_prefix"))} for m in v.embedding_models()],
            "default_model": v.DEFAULT_MODEL, "prompts": DEFAULT_PROMPTS, "object_types": types, "max_k": MAX_K}


def _hash(text: str, model: str, dim: int) -> str:
    return hashlib.sha1(f"{model}|{dim}|{text}".encode()).hexdigest()[:16]


class EmbedIn(BaseModel):
    source_property: str
    vector_property: Optional[str] = None  # created when missing (name: <source>Embedding)
    model: Optional[str] = None
    dimension: Optional[int] = Field(None, ge=1, le=4096)
    only_changed: bool = True


@router.post("/object-types/{type_id}/embed")
def embed_objects(type_id: str, req: EmbedIn) -> dict:
    """Fill a vector property with embeddings of a text property (only objects whose text changed)."""
    v = _vectors()
    with ontology._lock:
        t = ontology._object_type(type_id)
        src = next((p for p in t["properties"] if p["api_name"] == req.source_property), None)
        if not src or src["type"] not in ("string",):
            raise HTTPException(400, "embed a string property")
        model = req.model or v.DEFAULT_MODEL
        if model not in v.MODELS_BY_ID:
            raise HTTPException(400, f"unknown embedding model {model}")
        dim = req.dimension or v.MODELS_BY_ID[model]["dimension"]
        name = req.vector_property or f"{req.source_property}Embedding"
        vp = next((p for p in t["properties"] if p["api_name"] == name), None)
        if vp and vp["type"] != "vector":
            raise HTTPException(400, f"{name} is not a vector property")
        if not vp:
            vp = {"api_name": name, "display_name": f"{src['display_name']} embedding", "type": "vector", "description": f"Embedding of {src['api_name']} ({model})",
                  "vector_dimension": dim, "visibility": "hidden"}
            t["properties"].append(vp)
        vp.update(embedding_model=model, embedding_source=src["api_name"], vector_dimension=dim)
        ontology._check_properties(t["properties"], t["primary_key"], t["title_property"])
        ontology._put("object-types", t)
        objs = ontology.load_objects(type_id)
        todo = []
        for pk, o in objs.items():
            text = str((o.get("properties") or {}).get(src["api_name"]) or "")
            h = _hash(text, model, dim)
            if text and (not req.only_changed or (o.get("embedded") or {}).get(name) != h or not (o.get("properties") or {}).get(name)):
                todo.append((pk, text, h))
    vecs = embed([x[1] for x in todo], model, dim, "doc") if todo else []
    with ontology._lock:
        objs = ontology.load_objects(type_id)
        for (pk, _text, h), vec in zip(todo, vecs):
            if pk in objs:
                objs[pk].setdefault("properties", {})[name] = vec
                objs[pk].setdefault("embedded", {})[name] = h
        ontology.save_objects(type_id, objs, {pk for pk, _t, _h in todo if pk in objs})
        om.record_indexing(type_id, len(todo))
    if todo and len(objs) >= vector_ann.ANN_MIN:
        vector_ann.schedule(type_id, name, dim)  # update the ANN index now rather than at the next search
    return {"vector_property": name, "model": model, "dimension": dim, "embedded": len(todo), "objects": len(objs)}


def chunk_text(text: str, size: int, overlap: int, separators: list[str]) -> list[str]:
    """Recursive chunking: split on the highest-priority separator, and only move to the next separator for pieces still
    larger than the chunk size; then merge pieces up to the size, with the overlap carried into the next chunk."""
    seps = [s.replace("\\n", "\n").replace("\\t", "\t") for s in separators] or ["\n\n", "\n", ". ", " ", ""]

    def split(s: str, level: int) -> list[str]:
        if len(s) <= size:
            return [s]
        if level >= len(seps) or seps[level] == "":
            return [s[i:i + size] for i in range(0, len(s), size)]
        sep = seps[level]
        raw = s.split(sep)
        parts = [x + sep for x in raw[:-1]] + [raw[-1]]
        out: list[str] = []
        for x in parts:
            out.extend(split(x, level + 1) if len(x) > size else [x])
        return out

    pieces = [p for p in split(text or "", 0) if p]
    chunks: list[str] = []
    cur = ""
    for p in pieces:
        if cur and len(cur) + len(p) > size:
            chunks.append(cur.strip())
            cur = cur[-overlap:] if overlap else ""
        cur += p
    if cur.strip():
        chunks.append(cur.strip())
    return [c for c in chunks if c]


class ChunkSetupIn(BaseModel):
    object_type_id: str
    text_property: str
    display_name: Optional[str] = None  # the chunk object type (default: "<Type> chunk")
    chunk_size: int = Field(1000, ge=50, le=20000)
    overlap: int = Field(100, ge=0, le=5000)
    separators: list[str] = ["\n\n", "\n", ". ", " ", ""]
    model: Optional[str] = None
    embed: bool = True


def _free_link_name(type_id: str, wanted: list[str]) -> str:
    """The first API name the object type does not yet reach another type by (link API names are unique per type, so a
    second chunk setup on the same type gets another name), else the first one numbered."""
    taken = {x[xs]["api_name"].lower() for x in om._all("link-types") for xs, xo in (("source", "target"), ("target", "source"))
             if x[xo]["object_type_id"] == type_id}
    for w in wanted:
        if w and w.lower() not in taken:
            return w
    n = 2
    while f"{wanted[0]}{n}".lower() in taken:
        n += 1
    return f"{wanted[0]}{n}"


@router.post("/semantic/chunk-setup")
def chunk_setup(req: ChunkSetupIn) -> dict:
    """Chunk a text property into a new chunk object type linked back to its objects, and embed the chunks."""
    src = ontology._object_type(req.object_type_id)
    if not any(p["api_name"] == req.text_property and p["type"] == "string" for p in src["properties"]):
        raise HTTPException(400, f"{req.text_property} is not a string property of {src['display_name']}")
    if req.overlap >= req.chunk_size:
        raise HTTPException(400, "the overlap must be smaller than the chunk size")
    name = (req.display_name or f"{src['display_name']} chunk").strip()
    # the source document's media (a PDF) carried onto each chunk, so a PDF viewer opens it at the chunk
    media = [p for p in src["properties"] if p["type"] == "media" and not p.get("array") and p["api_name"] not in ("chunkId", "objectId", "chunk", "position", "embedding")]
    created = ontology.create_object_type(ontology.ObjectTypeIn(
        display_name=name, description=f"Chunks of {src['display_name']}.{req.text_property} ({req.chunk_size} characters, {req.overlap} overlap) for semantic search",
        icon="layers", ontology_id=src.get("ontology_id"), generate_primary_key=False, primary_key="chunkId", title_property="chunk",
        properties=[ontology.Property(api_name="chunkId", display_name="Chunk ID", type="string"),
                    ontology.Property(api_name="objectId", display_name=f"{src['display_name']} ID", type=("integer" if any(p["api_name"] == src["primary_key"] and p["type"] == "integer" for p in src["properties"]) else "string")),
                    ontology.Property(api_name="chunk", display_name="Chunk", type="string", render_hints=["searchable", "long_text"]),
                    ontology.Property(api_name="position", display_name="Position", type="integer"),
                    *[ontology.Property(api_name=p["api_name"], display_name=p["display_name"], type="media", media_sources=p.get("media_sources")) for p in media]]))
    edits = []
    for pk, o in ontology._objects(src["id"]).items():
        text = str((o.get("properties") or {}).get(req.text_property) or "")
        for i, c in enumerate(chunk_text(text, req.chunk_size, req.overlap, req.separators)):
            edits.append({"op": "create", "object_type_id": created["id"], "primary_key": f"{pk}_{i}",
                          "properties": {"chunkId": f"{pk}_{i}", "objectId": pk, "chunk": c, "position": i,
                                         **{p["api_name"]: (o.get("properties") or {}).get(p["api_name"]) for p in media
                                            if (o.get("properties") or {}).get(p["api_name"]) not in (None, "")}}})
    if edits:
        ontology.apply_edits(edits, None)
    # each side named for its own object type (how the other side reaches it): the document reaches its chunks as
    # "chunks" (or the chunk type's name / a numbered one when the document type already has chunks), a chunk its document
    lt = om.create_link_type(om.LinkTypeIn(kind="foreign_key", cardinality="many_to_one", foreign_key="objectId",
                                           source=om.LinkSide(object_type_id=created["id"], display_name="Chunks", plural_display_name="Chunks",
                                                              api_name=_free_link_name(src["id"], ["chunks", ontology._api_name(name, False)])),
                                           target=om.LinkSide(object_type_id=src["id"], display_name=src["display_name"], api_name=ontology._api_name(src["display_name"], False))))
    result = {"object_type": ontology.get_object_type(created["id"]), "link_type_id": lt["id"], "chunks": len(edits)}
    if req.embed and edits:
        result["embedding"] = embed_objects(created["id"], EmbedIn(source_property="chunk", vector_property="embedding", model=req.model))
    return result


class PreviewChunksIn(BaseModel):
    text: str = Field(max_length=200_000)
    chunk_size: int = Field(1000, ge=10, le=20000)
    overlap: int = Field(100, ge=0, le=5000)
    separators: list[str] = ["\n\n", "\n", ". ", " ", ""]


@router.post("/semantic/chunk-preview")
def chunk_preview(req: PreviewChunksIn) -> dict:
    chunks = chunk_text(req.text, req.chunk_size, req.overlap, req.separators)
    return {"chunks": chunks, "count": len(chunks)}
