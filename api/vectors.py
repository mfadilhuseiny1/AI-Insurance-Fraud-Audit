"""Vector Storage tab: indexes in the Amazon S3 Vectors bucket (AWS_S3_VECTOR_STORE_BUCKET_NAME),
and embedding parsed jobs into them.

An index has a fixed dimension and distance metric (cosine or euclidean), chosen when it is
created, and is tied to one embedding model: vectors from two models can't be compared even at the
same dimension. The model is stored on the index as the AWS tag `bluesandai:embedding-model`, so
it travels with the index. An index made elsewhere has no tag; it gets one when a model is chosen
for it in the UI (only models that can produce its dimension are offered).

What gets embedded is a job's RAG chunks (chunks.json.gz, the same chunks the result viewer
shows), or the job re-chunked at another size and overlap: one vector per chunk, key
"<job_id>:<n>" (n counts the vectors stored for the job, so a job's keys are always 0..vectors-1).
Filterable metadata: job_id, file_id, file_name, tier, chunk_index, page_start, page_end, language,
plus the run's own tags (e.g. tenant, department, access_level) for filtering searches. Indexes
created here declare "text" non-filterable and carry the chunk text in it; for other indexes the
text is read back from the job's chunks (so re-chunking needs an index that stores the text).
A run can also prefix each chunk with the document's name and pages before embedding (contextual
headers; the stored text stays the chunk itself), leave out short chunks and repeated boilerplate,
and skip documents already in the index (EmbedOptions). Embeddings come from OpenRouter and are L2-normalized before they are stored
(shortened Matryoshka vectors, e.g. Gemini's, are not unit length).

Embedding runs in the background; each run (index, job) is a row in PostgreSQL `vector_ingests`.

Each index also has settings, all off until turned on (data/vectors/settings.json, keyed by bucket
and index): auto-embed (newly parsed jobs, optionally of some tiers only, are embedded with saved
options), a spending limit in USD (checked against an estimate before a run and between batches;
spend is the OpenRouter cost of embedding and re-ranking), auto-retry of failed runs, and search
keys: bearer tokens for /api/vectors/v1/search, each bound to a metadata filter (e.g. tenant=acme)
that the server applies and the caller cannot widen. Only the keys' SHA-256 hashes are kept.

Search can be vector-only or hybrid: vector hits fused (reciprocal rank) with BM25 keyword hits
over the parse chunks of the index's documents (tokens cached per job); either can be re-ranked by an LLM
(BLUESANDAI_RERANK_MODEL on OpenRouter).

Mounted by server.py under /api/vectors.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import re
import secrets
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Optional

import requests
from botocore.exceptions import ClientError
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import auth
import chunking
import db
import storage

log = logging.getLogger("bluesandai.vectors")

router = APIRouter(prefix="/api/vectors")

MODEL_TAG = "bluesandai:embedding-model"
DEFAULT_MODEL = "baai/bge-m3"
EMBED_BATCH = 64
PUT_MAX_VECTORS = 500  # PutVectors limit
PUT_MAX_BYTES = 4_000_000  # keep each PutVectors request well under the API's payload limit
GET_MAX_KEYS = 100  # GetVectors limit
TEXT_MAX_BYTES = 30_000  # metadata is capped at 40 KB per vector
MAX_DIMENSION = 4096  # S3 Vectors limit
INDEX_NAME = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
COUNT_TTL = 600
CHARS_PER_TOKEN = 3  # conservative, for estimates (Latin script runs ~4 characters a token, Arabic ~2-3)
BUDGET_REACHED = "spending limit reached"

QWEN_QUERY = "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: "

# The embedding models offered when creating an index (all on OpenRouter). `dimension` is the
# model's native size; `dimensions` are the sizes offered; `range` (Matryoshka models) allows any
# size in it. Prefixes are what each model was trained with for queries and passages.
MODELS: list[dict[str, Any]] = [
    {
        "id": "baai/bge-m3", "label": "BGE-M3", "vendor": "BAAI", "dimension": 1024, "dimensions": [1024],
        "context": 8192, "multilingual": True,
        "note": "Multilingual (100+ languages incl. Indonesian and Arabic), 8K context. Default.",
    },
    {
        "id": "qwen/qwen3-embedding-8b", "label": "Qwen3 Embedding 8B", "vendor": "Qwen", "dimension": 4096,
        "dimensions": [256, 512, 1024, 2048, 4096], "range": [32, 4096], "context": 32768, "multilingual": True,
        "note": "Top of the MTEB multilingual leaderboard; 32K context.", "query_prefix": QWEN_QUERY,
    },
    {
        "id": "qwen/qwen3-embedding-4b", "label": "Qwen3 Embedding 4B", "vendor": "Qwen", "dimension": 2560,
        "dimensions": [256, 512, 1024, 2048, 2560], "range": [32, 2560], "context": 32768, "multilingual": True,
        "note": "Smaller Qwen3 embedder, close in quality to 8B.", "query_prefix": QWEN_QUERY,
    },
    {
        "id": "google/gemini-embedding-2", "label": "Gemini Embedding 2", "vendor": "Google", "dimension": 3072,
        "dimensions": [768, 1536, 3072], "range": [128, 3072], "context": 8192, "multilingual": True,
        "note": "Google's newest embedder; multilingual and multimodal.",
    },
    {
        "id": "google/gemini-embedding-001", "label": "Gemini Embedding 001", "vendor": "Google",
        "dimension": 3072, "dimensions": [768, 1536, 3072], "range": [128, 3072], "context": 20000,
        "multilingual": True, "note": "Strong multilingual retrieval; 20K context.",
    },
    {
        "id": "openai/text-embedding-3-large", "label": "text-embedding-3-large", "vendor": "OpenAI",
        "dimension": 3072, "dimensions": [256, 1024, 1536, 3072], "range": [1, 3072], "context": 8192,
        "multilingual": True, "note": "OpenAI's best embedder.",
    },
    {
        "id": "openai/text-embedding-3-small", "label": "text-embedding-3-small", "vendor": "OpenAI",
        "dimension": 1536, "dimensions": [512, 1536], "range": [1, 1536], "context": 8192, "multilingual": True,
        "note": "Cheap and fast; good for English.",
    },
    {
        "id": "voyageai/voyage-4", "label": "Voyage 4", "vendor": "Voyage AI", "dimension": 1024,
        "dimensions": [256, 512, 1024, 2048], "context": 32000, "multilingual": True,
        "note": "General-purpose retrieval; 32K context.",
    },
    {
        "id": "voyageai/voyage-4-large", "label": "Voyage 4 Large", "vendor": "Voyage AI", "dimension": 1024,
        "dimensions": [256, 512, 1024, 2048], "context": 32000, "multilingual": True,
        "note": "Voyage's most accurate retrieval model.",
    },
    {
        "id": "intfloat/multilingual-e5-large", "label": "Multilingual E5 Large", "vendor": "Microsoft",
        "dimension": 1024, "dimensions": [1024], "context": 512, "multilingual": True,
        "note": "Multilingual; 512-token context (long chunks are cut).",
        "query_prefix": "query: ", "doc_prefix": "passage: ",
    },
]
REGISTERED_PREFIX = "function:"


def _registered(model: str, probe: bool = True) -> Optional[dict]:
    """A registered embedding model: a function implementing the Embedding function interface (functions_registry)."""
    if not isinstance(model, str) or not model.startswith(REGISTERED_PREFIX):
        return None
    try:
        import functions_registry

        return functions_registry.embedding_spec(model[len(REGISTERED_PREFIX):], probe)
    except Exception:  # noqa: BLE001 - the functions registry is optional here
        return None


class _ModelsById(dict):
    """The provider models by id; "function:<id>" resolves a registered embedding model (visible to the caller), so
    every lookup of an embedding model (semantic search, vector properties, indexes) accepts registered ones."""

    def __contains__(self, model: object) -> bool:
        return dict.__contains__(self, model) or (isinstance(model, str) and _registered(model, probe=False) is not None)

    def get(self, model: Any, default: Any = None) -> Any:  # type: ignore[override]
        if dict.__contains__(self, model):
            return dict.__getitem__(self, model)
        spec = _registered(model)
        return spec if spec is not None else default

    def __missing__(self, model: Any) -> dict:
        spec = _registered(model)
        if spec is None:
            raise KeyError(model)
        return spec


MODELS_BY_ID: dict[str, dict[str, Any]] = _ModelsById({m["id"]: m for m in MODELS})


def embedding_models() -> list[dict[str, Any]]:
    """The provider models, then the registered embedding models the caller can see (dimension None until known)."""
    out = list(MODELS)
    try:
        import functions_registry

        out += functions_registry.registered_embedding_models()
    except Exception:  # noqa: BLE001 - the functions registry is optional here
        pass
    return out

_env: Callable[[str], str]
_load_job: Callable[[str], dict]  # job.json of a completed job (404 otherwise)
_load_chunks: Callable[[dict], list[dict]]  # a completed job's RAG chunks
_load_elements: Callable[[dict], list[dict]]  # a completed job's public elements
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="vector-ingest")
_progress: dict[tuple[str, str], dict] = {}  # (index, job_id) -> live row while running
_progress_lock = threading.Lock()
_counts: dict[str, dict] = {}


def configure(
    env: Callable[[str], str],
    load_job: Callable[[str], dict],
    load_chunks: Callable[[dict], list],
    load_elements: Callable[[dict], list],
    data_dir: Path,
) -> None:
    global _env, _load_job, _load_chunks, _load_elements, _settings_path
    _env, _load_job, _load_chunks, _load_elements = env, load_job, load_chunks, load_elements
    _settings_path = data_dir / "vectors" / "settings.json"


def startup() -> None:
    """Embedding runs cut off by a restart are marked failed; the auto-retry loop starts."""
    try:
        db.ingest_interrupted(_now())
    except Exception:
        log.exception("could not mark interrupted vector ingests")
    threading.Thread(target=_retry_loop, name="vector-retry", daemon=True).start()


def _usd(x: float) -> str:
    return f"${x:,.2f}" if x >= 1 else f"${x:.6f}".rstrip("0").rstrip(".") if x else "$0"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _bucket() -> str:
    return _env("AWS_S3_VECTOR_STORE_BUCKET_NAME")


def _problem() -> Optional[str]:
    if not storage.enabled():
        return "AWS is not configured (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET_NAME)"
    if not _bucket():
        return "AWS_S3_VECTOR_STORE_BUCKET_NAME is not set in .env.local"
    if not _env("OPENROUTER_API_KEY"):
        return "OPENROUTER_API_KEY is not set in .env.local"
    return None


def _s3v():
    problem = _problem()
    if problem:
        raise HTTPException(503, problem)
    return storage.s3vectors()


def _aws_error(e: ClientError, what: str) -> HTTPException:
    code = e.response.get("Error", {}).get("Code", "")
    message = e.response.get("Error", {}).get("Message", str(e))
    status = {"NotFoundException": 404, "ConflictException": 409, "ValidationException": 400,
              "AccessDeniedException": 403, "ServiceQuotaExceededException": 409}.get(code, 502)
    return HTTPException(status, f"{what}: {message}")


# ------------------------------------------------------------------------------------------------
# embedding
# ------------------------------------------------------------------------------------------------


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n else v


def embed(texts: list[str], model: str, dimension: int, kind: Literal["query", "doc"] = "doc") -> tuple[list[list[float]], float]:
    """Embeddings through OpenRouter (unit length); returns (vectors, cost in USD). A registered model ("function:<id>")
    runs its function; its vectors must have `dimension` entries (any one dimension when dimension is 0)."""
    if model.startswith(REGISTERED_PREFIX):
        import functions_registry

        vecs = functions_registry.embed_texts(model[len(REGISTERED_PREFIX):], texts, kind, dimension or None) if texts else []
        return [_normalize(v) for v in vecs], 0.0
    spec = MODELS_BY_ID.get(model, {})
    prefix = spec.get("query_prefix" if kind == "query" else "doc_prefix", "")
    vectors: list[list[float]] = []
    cost = 0.0
    for i in range(0, len(texts), EMBED_BATCH):
        batch = [prefix + t for t in texts[i : i + EMBED_BATCH]]
        payload: dict[str, Any] = {"model": model, "input": batch}
        if dimension != spec.get("dimension", dimension):
            payload["dimensions"] = dimension
        for attempt in range(4):
            resp = requests.post(
                "https://openrouter.ai/api/v1/embeddings",
                headers={"Authorization": f"Bearer {_env('OPENROUTER_API_KEY')}"},
                json=payload,
                timeout=180,
            )
            if resp.status_code not in (429, 500, 502, 503, 504) or attempt == 3:
                break
            time.sleep(2 ** attempt * 2)
        try:
            body = resp.json()
        except ValueError:
            body = {"error": resp.text[:300]}
        if not resp.ok or not body.get("data"):
            message = (body.get("error") or {}).get("message") if isinstance(body.get("error"), dict) else body.get("error")
            raise RuntimeError(f"embedding with {model} failed ({resp.status_code}): {str(message or body)[:300]}")
        data = sorted(body["data"], key=lambda d: d["index"])
        if len(data) != len(batch) or any(len(d["embedding"]) != dimension for d in data):
            got = len(data[0]["embedding"]) if data else 0
            raise RuntimeError(f"{model} returned {got}-dimensional vectors; the index needs {dimension}")
        vectors.extend(_normalize(d["embedding"]) for d in data)
        cost += float((body.get("usage") or {}).get("cost") or 0.0)
    return vectors, cost


def _check_model_dimension(model: str, dimension: int) -> None:
    spec = MODELS_BY_ID.get(model)
    if not spec:
        raise HTTPException(400, f"unknown embedding model {model!r}")
    lo, hi = spec.get("range", (0, 0))
    if dimension not in spec["dimensions"] and not (lo <= dimension <= hi):
        allowed = ", ".join(map(str, spec["dimensions"])) + (f" or any size {lo}–{hi}" if hi else "")
        raise HTTPException(400, f"{spec['label']} cannot produce {dimension} dimensions (allowed: {allowed})")


def _models_for(dimension: int) -> list[str]:
    out = []
    for m in embedding_models():
        lo, hi = m.get("range", (0, 0))
        if dimension in m["dimensions"] or lo <= dimension <= hi:
            out.append(m["id"])
    return out


# ------------------------------------------------------------------------------------------------
# indexes
# ------------------------------------------------------------------------------------------------


def _index(name: str) -> dict:
    """GetIndex plus the embedding model tag, as the UI shows it (the caller needs the index's markings: also when it
    is the target of a copy)."""
    auth.check_resource("vector_index", name)
    s3v = _s3v()
    try:
        info = s3v.get_index(vectorBucketName=_bucket(), indexName=name)["index"]
    except ClientError as e:
        raise _aws_error(e, f"index {name}")
    try:
        tags = s3v.list_tags_for_resource(resourceArn=info["indexArn"]).get("tags", {})
    except ClientError:
        tags = {}
    model = tags.get(MODEL_TAG)
    return {
        "name": info["indexName"],
        "arn": info["indexArn"],
        "dimension": info["dimension"],
        "metric": info["distanceMetric"],
        "data_type": info.get("dataType"),
        "mode": info.get("indexMode"),
        "created_at": info["creationTime"].isoformat(),
        "non_filterable_keys": (info.get("metadataConfiguration") or {}).get("nonFilterableMetadataKeys", []),
        "model": model,
        # models that can fill this index, for choosing one when the index has no model yet
        "compatible_models": _models_for(info["dimension"]),
    }


def _index_with_model(name: str) -> dict:
    index = _index(name)
    if not index["model"]:
        raise HTTPException(409, f"index {name} has no embedding model yet; choose one first")
    return index


@router.get("/config")
def config() -> dict:
    return {
        "bucket": _bucket() or None,
        "region": _env("AWS_REGION") or None,
        "problem": _problem(),
        "models": [{**m, "price_per_mtok": _price_per_mtok(m["id"]) if not m.get("registered") else None} for m in embedding_models() if m.get("dimension")],
        "default_model": DEFAULT_MODEL,
        "rerank_model": _rerank_model(),
        "max_dimension": MAX_DIMENSION,
        "database": db.enabled(),
    }


@router.get("/indexes")
def list_indexes() -> list[dict]:
    s3v = _s3v()
    names: list[str] = []
    token = None
    try:
        while True:
            kwargs = {"vectorBucketName": _bucket(), "maxResults": 500}
            if token:
                kwargs["nextToken"] = token
            res = s3v.list_indexes(**kwargs)
            names += [i["indexName"] for i in res.get("indexes", [])]
            token = res.get("nextToken")
            if not token:
                break
    except ClientError as e:
        raise _aws_error(e, f"vector bucket {_bucket()}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        indexes = list(pool.map(_index, names))
    jobs: dict[str, int] = {}
    for r in db.ingest_list(_bucket()) if db.enabled() else []:
        if r["status"] == "completed":
            jobs[r["index_name"]] = jobs.get(r["index_name"], 0) + 1
    for i in indexes:
        i["documents"] = jobs.get(i["name"], 0)
        i["vectors"] = (_counts.get(i["name"]) or {}).get("total")
    return sorted(auth.visible_resources("vector_index", indexes, key="name"), key=lambda i: i["created_at"])


class CreateIndex(BaseModel):
    name: str
    model: str = DEFAULT_MODEL
    dimension: int = Field(ge=1, le=MAX_DIMENSION)
    metric: Literal["cosine", "euclidean"] = "cosine"


@router.post("/indexes")
def create_index(body: CreateIndex) -> dict:
    name = body.name.strip()
    if not INDEX_NAME.match(name) or ".." in name:
        raise HTTPException(
            400, "index names are 3–63 characters: lowercase letters, numbers, hyphens and dots, "
            "starting and ending with a letter or number"
        )
    _check_model_dimension(body.model, body.dimension)
    try:
        _s3v().create_index(
            vectorBucketName=_bucket(),
            indexName=name,
            dataType="float32",
            dimension=body.dimension,
            distanceMetric=body.metric,
            # chunk text is too long for filterable metadata (2 KB), so it is stored non-filterable
            metadataConfiguration={"nonFilterableMetadataKeys": ["text"]},
            tags={MODEL_TAG: body.model},
        )
    except ClientError as e:
        raise _aws_error(e, f"could not create index {name}")
    return _index(name)


class UpdateIndex(BaseModel):
    model: str


@router.patch("/indexes/{name}")
def set_index_model(name: str, body: UpdateIndex) -> dict:
    """Choose the embedding model of an index that has none yet (one made outside this app)."""
    index = _index(name)
    if index["model"] and index["model"] != body.model:
        raise HTTPException(409, f"index {name} already holds {index['model']} vectors; create a new index for another model")
    _check_model_dimension(body.model, index["dimension"])
    try:
        _s3v().tag_resource(resourceArn=index["arn"], tags={MODEL_TAG: body.model})
    except ClientError as e:
        raise _aws_error(e, f"could not set the model of {name}")
    return _index(name)


@router.delete("/indexes/{name}")
def delete_index(name: str) -> dict:
    with _progress_lock:
        if any(k[0] == name for k in _progress):
            raise HTTPException(409, "documents are still being embedded into this index")
    try:
        _s3v().delete_index(vectorBucketName=_bucket(), indexName=name)
    except ClientError as e:
        raise _aws_error(e, f"could not delete index {name}")
    db.ingest_delete(_bucket(), name)
    _counts.pop(name, None)
    _drop_settings(name)
    return {"deleted": name}


# ------------------------------------------------------------------------------------------------
# embedding parsed jobs (ingests)
# ------------------------------------------------------------------------------------------------

# metadata keys every vector gets; a run's own tags can't use them
BASE_METADATA_KEYS = {"job_id", "file_id", "file_name", "tier", "chunk_index", "page_start", "page_end", "language", "text"}
TAG_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_TAGS = 10
TAG_VALUE_MAX = 100  # filterable metadata is capped at 2 KB per vector


class EmbedOptions(BaseModel):
    """How a run turns a parsed job into vectors. The defaults embed the parse chunks as they are."""

    # "parsed": the job's RAG chunks; "custom": the job's elements chunked again at these sizes
    chunking: Literal["parsed", "custom"] = "parsed"
    max_chars: int = Field(default=1500, ge=200, le=8000)
    overlap: int = Field(default=0, ge=0, le=2000)
    combine_under: int = Field(default=300, ge=0, le=4000)
    # prefix "Document: <name> · pages a–b" to the text that is embedded (the stored text is unchanged)
    context_header: bool = False
    # leave out chunks shorter than this (page debris, lone headings)
    min_chars: int = Field(default=0, ge=0, le=4000)
    # leave out chunks whose text (case and spacing ignored) already came earlier in the document
    dedupe: bool = False
    # filterable tags on every vector of the run, e.g. {"tenant": "acme", "access_level": "internal"}
    metadata: dict[str, str] = Field(default_factory=dict)
    # documents already embedded into the index: embed again (replacing their vectors) or skip them
    on_existing: Literal["replace", "skip"] = "replace"

    def check(self, index: Optional[dict] = None) -> None:
        if self.chunking == "custom":
            if self.overlap >= self.max_chars:
                raise HTTPException(400, "the overlap must be smaller than the chunk size")
            if self.combine_under >= self.max_chars:
                raise HTTPException(400, "the merge threshold must be smaller than the chunk size")
            if index is not None and "text" not in index["non_filterable_keys"]:
                raise HTTPException(
                    400, f"index {index['name']} does not store chunk text, so it can only hold the parse chunks; "
                    "create an index here to re-chunk"
                )
        if len(self.metadata) > MAX_TAGS:
            raise HTTPException(400, f"at most {MAX_TAGS} metadata tags")
        for k, v in self.metadata.items():
            if not TAG_KEY.match(k):
                raise HTTPException(400, f"tag {k!r}: lowercase letters, numbers and _, starting with a letter, max 40")
            if k in BASE_METADATA_KEYS:
                raise HTTPException(400, f"tag {k!r} is set by the app; choose another name")
            if not v.strip() or len(v) > TAG_VALUE_MAX:
                raise HTTPException(400, f"tag {k!r}: the value must be 1–{TAG_VALUE_MAX} characters")


def _pages_label(pages: list[int]) -> str:
    lo, hi = min(pages), max(pages)
    return f"page {lo}" if lo == hi else f"pages {lo}–{hi}"


def _prepare(job: dict, opts: EmbedOptions) -> tuple[list[dict], dict]:
    """The chunks a run embeds, in order, each {chunk_index, text, embed_text, pages, language};
    and counts of what was left out."""
    if opts.chunking == "custom":
        chunks, _ = chunking.rag_chunks(
            _load_elements(job),
            max_chars=opts.max_chars,
            soft_max_chars=max(opts.combine_under + 1, opts.max_chars * 3 // 4),
            combine_under=opts.combine_under,
            overlap=opts.overlap,
        )
    else:
        chunks = _load_chunks(job)
    stats = {"chunks": len(chunks), "empty": 0, "short": 0, "duplicate": 0}
    title = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", job["file_name"])
    seen: set[str] = set()
    items = []
    for c in chunks:
        text = c.get("text") or ""
        if not text.strip():
            stats["empty"] += 1
            continue
        if len(text.strip()) < opts.min_chars:
            stats["short"] += 1
            continue
        if opts.dedupe:
            digest = hashlib.sha1(" ".join(text.lower().split()).encode("utf-8")).hexdigest()
            if digest in seen:
                stats["duplicate"] += 1
                continue
            seen.add(digest)
        pages = c["metadata"].get("page_numbers") or []
        langs = c["metadata"].get("languages") or []
        header = f"Document: {title}" + (f" · {_pages_label(pages)}" if pages else "")
        items.append({
            "chunk_index": c["index"],
            "text": text,
            "embed_text": f"{header}\n\n{text}" if opts.context_header else text,
            "pages": pages,
            "language": langs[0] if langs else "",
        })
    return items, stats


def _public_ingest(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "bucket"}


def _save_ingest(row: dict) -> None:
    with _progress_lock:
        key = (row["index_name"], row["job_id"])
        if row["status"] in ("queued", "running"):
            _progress[key] = dict(row)
        else:
            _progress.pop(key, None)
    try:
        db.ingest_upsert(row)
    except Exception:
        log.exception("could not record vector ingest %s/%s", row["index_name"], row["job_id"])


def _truncate_utf8(text: str, limit: int) -> str:
    raw = text.encode("utf-8")
    return text if len(raw) <= limit else raw[:limit].decode("utf-8", "ignore")


def _key_span(job_id: str, rows: list[dict]) -> int:
    """How many keys "<job_id>:0.." may hold the job's vectors: what earlier runs stored, or the job's
    chunk count (earlier runs keyed vectors by chunk index, which can skip numbers)."""
    span = max([r["vectors"] for r in rows] + [0])
    try:
        span = max(span, _load_job(job_id).get("chunks") or 0)
    except HTTPException:
        pass
    return span


def _run_ingest(index: dict, job: dict, row: dict, previous: int, opts: EmbedOptions) -> None:
    """Embed one job into an index; `previous` is how many keys earlier runs may have used."""
    name = index["name"]
    try:
        row.update(status="running")
        _save_ingest(row)
        items, stats = _prepare(job, opts)
        row["total"] = len(items)
        row["skipped"] = stats["empty"] + stats["short"] + stats["duplicate"]
        _save_ingest(row)
        # a re-run replaces the job's vectors: drop keys a previous, longer run left behind
        if previous > len(items):
            _delete_keys(name, [f"{job['id']}:{i}" for i in range(len(items), previous)])
        with_text = "text" in index["non_filterable_keys"]
        base = {
            "job_id": job["id"],
            "file_id": job["file_id"],
            "file_name": job["file_name"][:200],
            "tier": job.get("tier") or "",
            **opts.metadata,
        }
        for i in range(0, len(items), EMBED_BATCH):
            settings = _settings(name)
            if settings["budget_usd"] is not None and _spent(name, settings) >= settings["budget_usd"]:
                raise RuntimeError(
                    f"{BUDGET_REACHED}: {_usd(_spent(name, settings))} of {_usd(settings['budget_usd'])} spent; "
                    f"{row['vectors']} of {len(items)} chunks embedded"
                )
            batch = items[i : i + EMBED_BATCH]
            vectors, cost = embed([it["embed_text"] for it in batch], index["model"], index["dimension"])
            row["cost_usd"] = round(row["cost_usd"] + cost, 6)
            _add_spend(name, cost)
            put = []
            for n, (it, vec) in enumerate(zip(batch, vectors), start=i):
                metadata: dict[str, Any] = {
                    **base,
                    "chunk_index": it["chunk_index"],
                    "page_start": min(it["pages"] or [0]),
                    "page_end": max(it["pages"] or [0]),
                    "language": it["language"],
                }
                if with_text:
                    metadata["text"] = _truncate_utf8(it["text"], TEXT_MAX_BYTES)
                put.append({"key": f"{job['id']}:{n}", "data": {"float32": vec}, "metadata": metadata})
            _put(name, put)
            row["vectors"] += len(put)
            _save_ingest(row)
        row.update(status="completed", finished_at=_now(), error=None)
    except Exception as e:
        log.exception("embedding %s into %s failed", job["id"], name)
        row.update(status="failed", finished_at=_now(), error=str(e)[:1000])
    _counts.pop(name, None)
    _save_ingest(row)


def _put(index_name: str, items: list[dict]) -> None:
    """PutVectors in requests of at most 500 vectors and a few MB."""
    batch: list[dict] = []
    size = 0
    for item in items:
        n = len(item["data"]["float32"]) * 12 + len(item["metadata"].get("text", "").encode("utf-8")) + 500
        if batch and (len(batch) >= PUT_MAX_VECTORS or size + n > PUT_MAX_BYTES):
            storage.s3vectors().put_vectors(vectorBucketName=_bucket(), indexName=index_name, vectors=batch)
            batch, size = [], 0
        batch.append(item)
        size += n
    if batch:
        storage.s3vectors().put_vectors(vectorBucketName=_bucket(), indexName=index_name, vectors=batch)


def _delete_keys(index_name: str, keys: list[str]) -> None:
    for i in range(0, len(keys), PUT_MAX_VECTORS):
        storage.s3vectors().delete_vectors(vectorBucketName=_bucket(), indexName=index_name, keys=keys[i : i + PUT_MAX_VECTORS])


def _with_live(rows: list[dict], index_name: Optional[str] = None) -> list[dict]:
    """Stored ingest rows with the running ones' live progress, newest first."""
    by = {(r["index_name"], r["job_id"]): r for r in rows}
    with _progress_lock:
        for key, live in _progress.items():
            if index_name is None or key[0] == index_name:
                by[key] = live
    return [_public_ingest(r) for r in sorted(by.values(), key=lambda r: r["created_at"], reverse=True)]


@router.get("/ingests")
def list_all_ingests() -> list[dict]:
    """Every embedding run in every index of the bucket (the Parse tab shows where each job is)."""
    if _problem():
        return []
    rows = db.ingest_list(_bucket()) if db.enabled() else []
    # runs of indexes the caller lacks the markings of are left out
    allowed = {i["name"] for i in auth.visible_resources("vector_index", [{"name": n} for n in {r["index_name"] for r in rows}], key="name")}
    return _with_live([r for r in rows if r["index_name"] in allowed])


@router.get("/indexes/{name}/ingests")
def list_ingests(name: str) -> list[dict]:
    return _with_live(db.ingest_list(_bucket(), name) if db.enabled() else [], name)


class StartIngest(BaseModel):
    job_ids: list[str] = Field(min_length=1, max_length=200)
    options: EmbedOptions = Field(default_factory=EmbedOptions)


@router.post("/indexes/{name}/ingests")
def start_ingest(name: str, body: StartIngest) -> list[dict]:
    """Embed completed parse jobs' chunks into the index (in the background). With on_existing
    "skip", a job already embedded into the index is returned as it is, not started."""
    index = _index_with_model(name)
    body.options.check(index)
    return _start(index, [_load_job(job_id) for job_id in dict.fromkeys(body.job_ids)], body.options)


def _estimate_usd(model: str, jobs: list[dict], opts: EmbedOptions) -> Optional[float]:
    """What embedding the jobs would cost, from OpenRouter's price (None when it is unknown)."""
    price = _price_per_mtok(model)
    if price is None:
        return None
    chars = sum(len(it["embed_text"]) for job in jobs for it in _prepare(job, opts)[0])
    return chars / CHARS_PER_TOKEN * price / 1e6


def _start(index: dict, jobs: list[dict], opts: EmbedOptions, trigger: str = "manual", attempts: int = 0) -> list[dict]:
    """Queue embedding runs. A spending limit is checked against an estimate first: a manual run
    over the limit is refused (409); an automatic one is recorded as failed, so it shows."""
    name = index["name"]
    todo, out = [], []
    for job in jobs:
        with _progress_lock:
            if (name, job["id"]) in _progress:
                out.append(_public_ingest(_progress[(name, job["id"])]))
                continue
        earlier = db.ingest_list(_bucket(), name, job["id"]) if db.enabled() else []
        if opts.on_existing == "skip" and any(r["status"] == "completed" for r in earlier):
            out.append(_public_ingest(earlier[0]))
            continue
        todo.append((job, earlier))
    if not todo:
        return out

    over = None
    settings = _settings(name)
    if settings["budget_usd"] is not None:
        estimate = _estimate_usd(index["model"], [j for j, _ in todo], opts) or 0.0
        spent = _spent(name, settings)
        if spent + estimate > settings["budget_usd"]:
            over = (
                f"{BUDGET_REACHED}: this run would cost about {_usd(estimate)}; {_usd(spent)} of the "
                f"{_usd(settings['budget_usd'])} limit is spent"
            )
            if trigger == "manual":
                raise HTTPException(409, over)

    for job, earlier in todo:
        row = {
            "bucket": _bucket(), "index_name": name, "job_id": job["id"], "file_name": job["file_name"],
            "model": index["model"], "dimension": index["dimension"], "status": "queued", "vectors": 0,
            "total": job.get("chunks") or 0, "skipped": 0, "cost_usd": 0.0, "error": None, "created_at": _now(),
            "finished_at": None, "options": opts.model_dump(), "trigger": trigger, "attempts": attempts,
        }
        if over:
            row.update(status="failed", error=over, finished_at=_now())
            _save_ingest(row)
        else:
            _save_ingest(row)
            _pool.submit(_run_ingest, index, job, row, _key_span(job["id"], earlier) if earlier else 0, opts)
        out.append(_public_ingest(row))
    return out


class Preview(BaseModel):
    job_ids: list[str] = Field(min_length=1, max_length=200)
    options: EmbedOptions = Field(default_factory=EmbedOptions)
    # the target index's model, to count chunks longer than it reads
    model: Optional[str] = None


@router.post("/preview")
def preview(body: Preview) -> dict:
    """A dry run of an embedding run: what each job would become (vectors, what is left out, size
    in characters and estimated tokens) and the first chunks of the first job exactly as they would
    be embedded. Nothing is embedded or stored."""
    opts = body.options
    opts.check()
    context = (MODELS_BY_ID.get(body.model or "") or {}).get("context")
    jobs = [_load_job(job_id) for job_id in dict.fromkeys(body.job_ids)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        prepared = list(pool.map(lambda j: _prepare(j, opts), jobs))
    per_job = []
    for job, (items, stats) in zip(jobs, prepared):
        chars = sum(len(it["embed_text"]) for it in items)
        per_job.append({
            "job_id": job["id"],
            "vectors": len(items),
            **stats,
            "chars": chars,
            # a conservative 3 characters a token (Latin script runs ~4, Arabic ~2-3)
            "tokens": round(chars / CHARS_PER_TOKEN),
            "longest": max((len(it["embed_text"]) for it in items), default=0),
            # at a conservative 3 characters a token, chunks the model would cut off
            "over_context": sum(1 for it in items if context and len(it["embed_text"]) // 3 > context),
        })
    keys = ("vectors", "chunks", "empty", "short", "duplicate", "chars", "tokens", "over_context")
    first = prepared[0][0]
    price = _price_per_mtok(body.model) if body.model else None
    totals = {k: sum(p[k] for p in per_job) for k in keys}
    return {
        "per_job": per_job,
        "totals": {**totals, "longest": max(p["longest"] for p in per_job)},
        "model_context": context,
        "price_per_mtok": price,
        "cost_usd": None if price is None else round(totals["tokens"] * price / 1e6, 6),
        "samples": [
            {"key": f"{jobs[0]['id']}:{n}", "chunk_index": it["chunk_index"], "pages": it["pages"],
             "embed_text": it["embed_text"][:2000], "chars": len(it["embed_text"])}
            for n, it in enumerate(first[:3])
        ],
    }


@router.delete("/indexes/{name}/ingests/{job_id}")
def remove_ingest(name: str, job_id: str) -> dict:
    """Delete a job's vectors from the index."""
    with _progress_lock:
        if (name, job_id) in _progress:
            raise HTTPException(409, "this document is still being embedded")
    _s3v()
    rows = db.ingest_list(_bucket(), name, job_id) if db.enabled() else []
    try:
        _delete_keys(name, [f"{job_id}:{i}" for i in range(_key_span(job_id, rows))])
    except ClientError as e:
        raise _aws_error(e, "could not delete vectors")
    db.ingest_delete(_bucket(), name, job_id)
    _counts.pop(name, None)
    return {"deleted": job_id, "vectors": max([r["vectors"] for r in rows] + [0])}


def forget_job(job_id: str) -> None:
    """A deleted parse job's vectors are removed from every index they were embedded into."""
    if _problem() or not db.enabled():
        return
    for r in db.ingest_list(_bucket(), job_id=job_id):
        try:
            _delete_keys(r["index_name"], [f"{job_id}:{i}" for i in range(_key_span(job_id, [r]))])
        except ClientError:
            log.exception("could not delete vectors of %s from %s", job_id, r["index_name"])
        db.ingest_delete(_bucket(), r["index_name"], job_id)


# ------------------------------------------------------------------------------------------------
# browsing and search
# ------------------------------------------------------------------------------------------------


def _chunk_text(metadata: dict) -> Optional[str]:
    """The embedded text: from metadata, or from the job's chunks if the index doesn't store it."""
    if metadata.get("text"):
        return metadata["text"]
    try:
        job = _load_job(str(metadata["job_id"]))
        index = int(metadata["chunk_index"])
        return next((c["text"] for c in _load_chunks(job) if c["index"] == index), None)
    except Exception:
        return None


def _row(key: str, metadata: dict, distance: Optional[float] = None, metric: str = "cosine") -> dict:
    text = _chunk_text(metadata)
    pages = (metadata.get("page_start"), metadata.get("page_end"))
    out = {
        "key": key,
        "job_id": metadata.get("job_id"),
        "file_name": metadata.get("file_name"),
        "chunk_index": metadata.get("chunk_index"),
        "pages": [p for p in pages if p is not None],
        "language": metadata.get("language") or None,
        "preview": text[:280] if text else None,
        "metadata": {k: v for k, v in metadata.items() if k != "text"},
        "text": text,
    }
    if distance is not None:
        out["distance"] = distance
        # cosine distance is 1 − similarity; euclidean has no similarity, so the distance is shown
        out["score"] = 1 - distance if metric == "cosine" else distance
    return out


@router.get("/indexes/{name}/vectors")
def list_vectors(name: str, limit: int = 50, next_token: Optional[str] = None) -> dict:
    """One page of ListVectors (index order), without the vector data."""
    kwargs: dict[str, Any] = {
        "vectorBucketName": _bucket(), "indexName": name, "maxResults": max(1, min(limit, 100)), "returnMetadata": True,
    }
    if next_token:
        kwargs["nextToken"] = next_token
    try:
        res = _s3v().list_vectors(**kwargs)
    except ClientError as e:
        raise _aws_error(e, "could not list vectors")
    vectors = res.get("vectors", [])
    # previews come from metadata, or for indexes without text, from the (cached) job chunks
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda v: _row(v["key"], v.get("metadata") or {}), vectors))
    return {"rows": [_strip(r) for r in rows], "next_token": res.get("nextToken")}


def _get_vector(name: str, key: str) -> Optional[dict]:
    try:
        res = _s3v().get_vectors(vectorBucketName=_bucket(), indexName=name, keys=[key], returnData=True, returnMetadata=True)
    except ClientError as e:
        raise _aws_error(e, "could not read the vector")
    found = res.get("vectors", [])
    return found[0] if found else None


@router.get("/indexes/{name}/vector")
def get_vector(name: str, key: str) -> dict:
    """One vector in full: metadata, embedded text, values and their statistics."""
    v = _get_vector(name, key)
    if not v:
        raise HTTPException(404, f"no vector {key} in {name}")
    data = [float(x) for x in v["data"]["float32"]]
    n = len(data)
    mean = sum(data) / n
    metadata = v.get("metadata") or {}
    return {
        **_row(key, metadata),
        "text": _chunk_text(metadata),
        "data": data,
        "stats": {
            "dimension": n,
            "norm": round(math.sqrt(sum(x * x for x in data)), 5),
            "min": round(min(data), 5),
            "max": round(max(data), 5),
            "mean": round(mean, 6),
            "std": round(math.sqrt(sum((x - mean) ** 2 for x in data) / n), 6),
            "zeros": sum(1 for x in data if x == 0),
        },
    }


def _query(index: dict, vector: list[float], top_k: int, job_id: Optional[str] = None, where: Optional[dict[str, str]] = None) -> list[dict]:
    kwargs: dict[str, Any] = {
        "vectorBucketName": _bucket(), "indexName": index["name"], "queryVector": {"float32": vector},
        "topK": top_k, "returnDistance": True, "returnMetadata": True,
    }
    # metadata equality filters (job, and tags such as tenant or access_level), all must match
    conditions = [{k: {"$eq": v}} for k, v in {**(where or {}), **({"job_id": job_id} if job_id else {})}.items()]
    if conditions:
        kwargs["filter"] = conditions[0] if len(conditions) == 1 else {"$and": conditions}
    try:
        hits = _s3v().query_vectors(**kwargs).get("vectors", [])
    except ClientError as e:
        raise _aws_error(e, "query failed")
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(lambda h: _row(h["key"], h.get("metadata") or {}, h.get("distance", 0.0), index["metric"]), hits))


@router.get("/indexes/{name}/neighbors")
def neighbors(name: str, key: str, k: int = 10) -> dict:
    """The stored vectors closest to one key (queried with that key's own vector)."""
    index = _index(name)
    v = _get_vector(name, key)
    if not v:
        raise HTTPException(404, f"no vector {key} in {name}")
    k = max(1, min(k, 50))
    rows = [r for r in _query(index, list(v["data"]["float32"]), k + 1) if r["key"] != key][:k]
    return {"rows": [_strip(r) for r in rows], "metric": index["metric"]}


class Search(BaseModel):
    q: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=10, ge=1, le=100)
    job_id: Optional[str] = None
    # metadata that must match exactly, e.g. {"tenant": "acme"}
    filter: dict[str, str] = Field(default_factory=dict, max_length=20)
    # "hybrid": vector hits fused with full-text hits over the documents' parse chunks
    mode: Literal["vector", "hybrid"] = "vector"
    # re-order the best candidates with an LLM judging relevance to the query
    rerank: bool = False


RRF_K = 60  # reciprocal rank fusion constant (the usual value)
RERANK_MAX = 40  # candidates an LLM re-ranks
RERANK_CHARS = 1500  # characters of each candidate it reads
DEFAULT_RERANK_MODEL = "qwen/qwen3.7-flash"
# metadata keys that are the same for every chunk of a job, so full-text hits can be filtered by them
JOB_LEVEL_KEYS = {"job_id", "file_id", "file_name", "tier"}


def _rerank_model() -> str:
    return _env("BLUESANDAI_RERANK_MODEL") or DEFAULT_RERANK_MODEL


def _strip(row: dict) -> dict:
    """A row as served: without the full chunk text (the preview stays)."""
    return {k: v for k, v in row.items() if k != "text"}


_bm25_cache: dict[str, list[tuple[dict, Counter, int]]] = {}  # job_id -> (chunk, term counts, length)
_bm25_lock = threading.Lock()
BM25_K1, BM25_B = 1.2, 0.75
_WORD = re.compile(r"\w+")


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _bm25_docs(job: dict) -> list[tuple[dict, Counter, int]]:
    with _bm25_lock:
        cached = _bm25_cache.get(job["id"])
    if cached is None:
        cached = []
        for c in _load_chunks(job):
            toks = _tokens(c.get("text") or "")
            if toks:
                cached.append((c, Counter(toks), len(toks)))
        with _bm25_lock:
            if len(_bm25_cache) > 2000:
                _bm25_cache.clear()
            _bm25_cache[job["id"]] = cached
    return cached


def _keyword_rows(index: dict, q: str, job_id: Optional[str], where: dict[str, str], limit: int) -> tuple[list[dict], set[str]]:
    """BM25 keyword hits over the parse chunks of the documents in the index that the filter allows,
    and the jobs whose vectors are those parse chunks (so a vector and a keyword hit of the same
    chunk count as one). Re-chunked jobs aren't searched by keyword: their chunks are made at
    embedding time and not kept. A filter on a per-chunk key other than language leaves keywords
    out altogether, since it can't be checked here."""
    if not db.enabled():
        return [], set()
    rows = [r for r in db.ingest_list(_bucket(), index["name"]) if r["status"] == "completed"]
    parsed = {r["job_id"] for r in rows if not r.get("options") or r["options"].get("chunking", "parsed") == "parsed"}
    chunk_keys = set(where) - JOB_LEVEL_KEYS - {"language"}
    tag_keys = chunk_keys - BASE_METADATA_KEYS
    terms = list(dict.fromkeys(_tokens(q)))
    if chunk_keys - tag_keys or not terms:
        return [], parsed
    docs: list[tuple[dict, dict, Counter, int]] = []  # (ingest row, chunk, term counts, length)
    for r in rows:
        if r["job_id"] not in parsed or (job_id and r["job_id"] != job_id):
            continue
        tags = (r.get("options") or {}).get("metadata") or {}
        if any(tags.get(k) != where[k] for k in tag_keys):
            continue
        try:
            job = _load_job(r["job_id"])
        except HTTPException:
            continue
        values = {"job_id": job["id"], "file_id": job["file_id"], "file_name": job["file_name"][:200], "tier": job.get("tier") or ""}
        if any(values[k] != where[k] for k in JOB_LEVEL_KEYS & set(where)):
            continue
        min_chars = (r.get("options") or {}).get("min_chars") or 0
        for c, tf, n in _bm25_docs(job):
            langs = c["metadata"].get("languages") or []
            if len(c["text"].strip()) < min_chars or ("language" in where and (langs[0] if langs else "") != where["language"]):
                continue
            docs.append((r, c, tf, n))
    if not docs:
        return [], parsed
    avg = sum(d[3] for d in docs) / len(docs)
    idf = {}
    for t in terms:
        df = sum(1 for d in docs if t in d[2])
        idf[t] = math.log(1 + (len(docs) - df + 0.5) / (df + 0.5))
    scored = []
    for r, c, tf, n in docs:
        score = sum(
            idf[t] * tf[t] * (BM25_K1 + 1) / (tf[t] + BM25_K1 * (1 - BM25_B + BM25_B * n / avg)) for t in terms if t in tf
        )
        if score > 0:
            scored.append((score, r, c))
    scored.sort(key=lambda x: -x[0])
    out = []
    for score, r, c in scored[:limit]:
        pages = c["metadata"].get("page_numbers") or []
        langs = c["metadata"].get("languages") or []
        out.append({
            "key": None,  # the vector's key isn't known from the chunk; set when the vector search found it too
            "job_id": r["job_id"],
            "file_name": r["file_name"],
            "chunk_index": c["index"],
            "pages": [min(pages), max(pages)] if pages else [],
            "language": langs[0] if langs else None,
            "preview": c["text"][:280],
            "metadata": {"job_id": r["job_id"], "chunk_index": c["index"]},
            "text": c["text"],
        })
    return out, parsed


def _fuse(vector_rows: list[dict], keyword_rows: list[dict], parsed: set[str]) -> list[dict]:
    """Reciprocal rank fusion: each list contributes 1 / (60 + rank); a chunk found by both adds up."""
    fused: dict[Any, dict] = {}
    for rank, r in enumerate(vector_rows, 1):
        ident = (r["job_id"], r["chunk_index"]) if r["job_id"] in parsed else r["key"]
        fused[ident] = {**r, "fused": 1 / (RRF_K + rank), "signals": {"vector_rank": rank, "vector_score": r.get("score")}}
    for rank, r in enumerate(keyword_rows, 1):
        ident = (r["job_id"], r["chunk_index"])
        if ident in fused:
            fused[ident]["fused"] += 1 / (RRF_K + rank)
            fused[ident]["signals"]["keyword_rank"] = rank
        else:
            fused[ident] = {**r, "fused": 1 / (RRF_K + rank), "signals": {"keyword_rank": rank}}
    out = sorted(fused.values(), key=lambda r: -r["fused"])
    for r in out:
        r["score"] = round(r.pop("fused"), 6)
        r.pop("distance", None)
    return out


def _rerank(q: str, rows: list[dict]) -> tuple[list[float], float]:
    """Relevance of each row to the query, 0–10, judged by an LLM; returns (scores, cost in USD)."""
    passages = "\n\n".join(f"[{i}]\n{(r.get('text') or r.get('preview') or '')[:RERANK_CHARS]}" for i, r in enumerate(rows))
    schema = {
        "type": "object",
        "properties": {
            "scores": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"id": {"type": "integer"}, "score": {"type": "number"}},
                    "required": ["id", "score"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["scores"],
        "additionalProperties": False,
    }
    resp = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {_env('OPENROUTER_API_KEY')}"},
        json={
            "model": _rerank_model(),
            "messages": [
                {
                    "role": "system",
                    "content": "You rank passages for a search engine. For every passage give a score from 0 (irrelevant) "
                    "to 10 (directly answers the query). Judge meaning, not word overlap; passages and query may be in "
                    "different languages. Return a score for every passage id.",
                },
                {"role": "user", "content": f"Query: {q}\n\nPassages:\n\n{passages}"},
            ],
            "response_format": {"type": "json_schema", "json_schema": {"name": "scores", "strict": True, "schema": schema}},
            "reasoning": {"enabled": False},
            "temperature": 0,
            "max_tokens": 4000,
        },
        timeout=90,
    )
    try:
        body = resp.json()
        content = body["choices"][0]["message"]["content"]
        # models without structured output may wrap the JSON in prose or a code fence
        parsed = json.loads(content[content.index("{") : content.rindex("}") + 1])
        scores = {int(s["id"]): float(s["score"]) for s in parsed["scores"]}
    except Exception:
        raise RuntimeError(f"re-ranking with {_rerank_model()} failed ({resp.status_code}): {resp.text[:300]}")
    cost = float((body.get("usage") or {}).get("cost") or 0.0)
    return [scores.get(i, 0.0) for i in range(len(rows))], cost


def _search(index: dict, body: Search) -> dict:
    t0 = time.perf_counter()
    try:
        [vector], cost = embed([body.q.strip()], index["model"], index["dimension"], kind="query")
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    _add_spend(index["name"], cost)
    t1 = time.perf_counter()
    wide = body.mode == "hybrid" or body.rerank
    n = min(100, max(body.top_k * 4, 40)) if wide else body.top_k
    rows = _query(index, vector, n, body.job_id or None, body.filter)
    t2 = time.perf_counter()
    out: dict[str, Any] = {"metric": index["metric"], "model": index["model"], "mode": body.mode, "reranked": False,
                           "score_kind": index["metric"], "embed_ms": round((t1 - t0) * 1000), "query_ms": round((t2 - t1) * 1000)}
    if body.mode == "hybrid":
        keyword, parsed = _keyword_rows(index, body.q, body.job_id or None, body.filter, n)
        rows = _fuse(rows, keyword, parsed)
        out.update(score_kind="rrf", keyword_ms=round((time.perf_counter() - t2) * 1000), keyword_hits=len(keyword))
    else:
        for rank, r in enumerate(rows, 1):
            r["signals"] = {"vector_rank": rank, "vector_score": r.get("score")}
    if body.rerank and rows:
        t3 = time.perf_counter()
        head = rows[: min(RERANK_MAX, max(body.top_k * 2, 20))]
        try:
            scores, cost = _rerank(body.q, head)
        except (RuntimeError, requests.RequestException) as e:
            raise HTTPException(502, str(e))
        _add_spend(index["name"], cost)
        for r, sc in zip(head, scores):
            r["signals"]["rerank"] = sc
            r["score"] = round(sc / 10, 4)
        head.sort(key=lambda r: -r["signals"]["rerank"])  # stable: ties keep their earlier order
        rows = head + rows[len(head):]
        out.update(reranked=True, score_kind="rerank", rerank_model=_rerank_model(), rerank_ms=round((time.perf_counter() - t3) * 1000))
    out["rows"] = [_strip(r) for r in rows[: body.top_k]]
    return out


@router.post("/indexes/{name}/search")
def search(name: str, body: Search) -> dict:
    """Semantic search: the query is embedded with the index's model, then QueryVectors; with
    mode "hybrid" fused with full-text hits, and optionally re-ranked by an LLM."""
    return _search(_index_with_model(name), body)


@router.post("/v1/search")
def scoped_search(body: Search, authorization: str = Header(default="")) -> dict:
    """Search for other applications, with a search key (Authorization: Bearer bsk_...). The key
    picks the index, and its filter is applied on top of the request's: the request can narrow
    the results but never see past the key's scope (its keys always win)."""
    token = authorization.removeprefix("Bearer ").strip()
    found = _find_key(token) if token else None
    if not found:
        raise HTTPException(401, "a valid search key is required (Authorization: Bearer <key>)")
    name, key = found
    body.filter = {**body.filter, **key["filter"]}
    if body.job_id and "job_id" in key["filter"] and body.job_id != key["filter"]["job_id"]:
        raise HTTPException(403, "this key can't search that document")
    result = _search(_index_with_model(name), body)
    _touch_key(name, key["id"])
    return {**result, "index": name}


@router.get("/indexes/{name}/count")
def count(name: str, refresh: bool = False) -> dict:
    """Every key in the index counted per job, with segmented ListVectors in parallel. Kept for a
    few minutes, since it scans the whole index."""
    cached = _counts.get(name)
    if cached and not refresh and time.time() - cached["at"] < COUNT_TTL:
        return cached["result"]
    s3v = _s3v()
    segments = 8

    def scan(segment: int) -> dict[str, int]:
        by: dict[str, int] = {}
        token = None
        while True:
            kwargs: dict[str, Any] = {
                "vectorBucketName": _bucket(), "indexName": name, "maxResults": 1000,
                "segmentCount": segments, "segmentIndex": segment,
            }
            if token:
                kwargs["nextToken"] = token
            res = s3v.list_vectors(**kwargs)
            for v in res.get("vectors", []):
                job = v["key"].rsplit(":", 1)[0]
                by[job] = by.get(job, 0) + 1
            token = res.get("nextToken")
            if not token:
                return by

    t0 = time.perf_counter()
    try:
        with ThreadPoolExecutor(max_workers=segments) as pool:
            parts = list(pool.map(scan, range(segments)))
    except ClientError as e:
        raise _aws_error(e, "could not count vectors")
    by_job: dict[str, int] = {}
    for p in parts:
        for job, n in p.items():
            by_job[job] = by_job.get(job, 0) + n
    result = {
        "total": sum(by_job.values()),
        "by_job": by_job,
        "counted_at": _now(),
        "ms": round((time.perf_counter() - t0) * 1000),
    }
    _counts[name] = {"at": time.time(), "result": result, "total": result["total"]}
    return result


# ------------------------------------------------------------------------------------------------
# prices (OpenRouter publishes them per token; kept for an hour)
# ------------------------------------------------------------------------------------------------

_prices_cache: dict[str, Any] = {"at": 0.0, "prices": {}}
_prices_lock = threading.Lock()


def _price_per_mtok(model: str) -> Optional[float]:
    """USD per million input tokens of an embedding model, or None when OpenRouter doesn't say."""
    with _prices_lock:
        if time.time() - _prices_cache["at"] > 3600 and _env("OPENROUTER_API_KEY"):
            try:
                resp = requests.get(
                    "https://openrouter.ai/api/v1/embeddings/models",
                    headers={"Authorization": f"Bearer {_env('OPENROUTER_API_KEY')}"},
                    timeout=15,
                )
                resp.raise_for_status()
                _prices_cache["prices"] = {
                    m["id"]: float(m["pricing"]["prompt"]) * 1e6 for m in resp.json().get("data", []) if (m.get("pricing") or {}).get("prompt")
                }
                _prices_cache["at"] = time.time()
            except Exception:
                log.exception("could not read embedding prices from OpenRouter")
                _prices_cache["at"] = time.time() - 3000  # try again in 10 minutes
        return _prices_cache["prices"].get(model)


# ------------------------------------------------------------------------------------------------
# per-index settings: auto-embed, spending limit, auto-retry, search keys (all off by default)
# ------------------------------------------------------------------------------------------------

_settings_path: Path
_settings_lock = threading.RLock()
MAX_KEYS = 50
RETRY_EVERY = 600  # seconds between auto-retry passes
MAX_AUTO_RETRIES = 3


def _defaults() -> dict:
    return {
        "auto_embed": False,
        "auto_embed_options": None,  # EmbedOptions as a dict; None = the defaults
        "auto_embed_tiers": [],  # empty = every tier
        "budget_usd": None,  # None = no limit
        "spent_usd": None,  # set when the index first gets settings, from its runs so far
        "auto_retry": False,
        "keys": [],
    }


def _read_all() -> dict:
    try:
        return json.loads(_settings_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def _write_all(data: dict) -> None:
    _settings_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _settings_path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(_settings_path)


def _skey(name: str) -> str:
    return f"{_bucket()}/{name}"


def _settings(name: str) -> dict:
    with _settings_lock:
        return {**_defaults(), **_read_all().get(_skey(name), {})}


def _update_settings(name: str, change: Callable[[dict], None]) -> dict:
    with _settings_lock:
        data = _read_all()
        s = {**_defaults(), **data.get(_skey(name), {})}
        if s["spent_usd"] is None:
            s["spent_usd"] = _runs_cost(name)
        change(s)
        data[_skey(name)] = s
        _write_all(data)
        return s


def _drop_settings(name: str) -> None:
    with _settings_lock:
        data = _read_all()
        if data.pop(_skey(name), None) is not None:
            _write_all(data)


def _runs_cost(name: str) -> float:
    """What the index's recorded runs cost (each job's latest run only)."""
    return round(sum(r["cost_usd"] for r in db.ingest_list(_bucket(), name)), 6) if db.enabled() else 0.0


def _spent(name: str, settings: Optional[dict] = None) -> float:
    """Everything spent on the index: embedding (every run, re-runs included), queries and re-ranking."""
    s = settings or _settings(name)
    return s["spent_usd"] if s["spent_usd"] is not None else _runs_cost(name)


def _add_spend(name: str, cost: float) -> None:
    if cost:
        _update_settings(name, lambda s: s.update(spent_usd=round(s["spent_usd"] + cost, 6)))


def _public_settings(name: str, s: dict) -> dict:
    return {
        **{k: v for k, v in s.items() if k not in ("keys", "spent_usd")},
        "spent_usd": round(_spent(name, s), 6),
        "keys": [{k: v for k, v in key.items() if k != "hash"} for key in s["keys"]],
    }


@router.get("/settings")
def all_settings() -> dict:
    """Settings of every index that has any (the Parse tab shows which indexes auto-embed)."""
    if _problem():
        return {}
    prefix = f"{_bucket()}/"
    return {
        k[len(prefix):]: _public_settings(k[len(prefix):], {**_defaults(), **v})
        for k, v in _read_all().items()
        if k.startswith(prefix)
    }


@router.get("/indexes/{name}/settings")
def get_settings(name: str) -> dict:
    return _public_settings(name, _settings(name))


class UpdateSettings(BaseModel):
    auto_embed: Optional[bool] = None
    auto_embed_options: Optional[EmbedOptions] = None
    auto_embed_tiers: Optional[list[str]] = None
    budget_usd: Optional[float] = Field(default=None, ge=0)
    auto_retry: Optional[bool] = None
    # start counting spend from zero again
    reset_spent: bool = False


@router.patch("/indexes/{name}/settings")
def update_settings(name: str, body: UpdateSettings) -> dict:
    """Change some settings; fields left out stay as they are (budget_usd: null removes the limit)."""
    changes = body.model_dump(exclude_unset=True)
    index = _index(name)
    if changes.get("auto_embed") and not index["model"]:
        raise HTTPException(409, f"index {name} has no embedding model yet; choose one first")
    if body.auto_embed_options is not None:
        body.auto_embed_options.check(index)
        changes["auto_embed_options"] = body.auto_embed_options.model_dump()
    reset = changes.pop("reset_spent", False)

    def apply(s: dict) -> None:
        s.update(changes)
        if reset:
            s["spent_usd"] = 0.0

    return _public_settings(name, _update_settings(name, apply))


# ---------------------------------------------------------------- search keys


class CreateKey(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    # applied to every search made with the key, e.g. {"tenant": "acme"}
    filter: dict[str, str] = Field(default_factory=dict, max_length=10)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post("/indexes/{name}/keys")
def create_key(name: str, body: CreateKey) -> dict:
    """A search key for /api/vectors/v1/search. The token is returned once; only its hash is kept."""
    _index_with_model(name)
    for k, v in body.filter.items():
        if not re.match(r"^[a-z][a-z0-9_]{0,39}$", k) or not v.strip():
            raise HTTPException(400, f"filter {k}={v!r}: keys are lowercase letters, numbers and _, values not empty")
    token = "bsk_" + secrets.token_urlsafe(32)
    key = {
        "id": secrets.token_hex(6), "name": body.name.strip(), "filter": {k: v.strip() for k, v in body.filter.items()},
        "hash": _hash(token), "prefix": token[:10], "created_at": _now(), "last_used_at": None,
    }

    def add(s: dict) -> None:
        if len(s["keys"]) >= MAX_KEYS:
            raise HTTPException(409, f"at most {MAX_KEYS} keys per index")
        s["keys"].append(key)

    _update_settings(name, add)
    return {"key": {k: v for k, v in key.items() if k != "hash"}, "token": token}


@router.delete("/indexes/{name}/keys/{key_id}")
def revoke_key(name: str, key_id: str) -> dict:
    def drop(s: dict) -> None:
        before = len(s["keys"])
        s["keys"] = [k for k in s["keys"] if k["id"] != key_id]
        if len(s["keys"]) == before:
            raise HTTPException(404, "no such key")

    _update_settings(name, drop)
    return {"revoked": key_id}


def _find_key(token: str) -> Optional[tuple[str, dict]]:
    digest = _hash(token)
    prefix = f"{_bucket()}/"
    for skey, s in _read_all().items():
        if not skey.startswith(prefix):
            continue
        for key in s.get("keys", []):
            if hmac.compare_digest(key["hash"], digest):
                return skey[len(prefix):], key
    return None


def _touch_key(name: str, key_id: str) -> None:
    def touch(s: dict) -> None:
        for k in s["keys"]:
            if k["id"] == key_id:
                k["last_used_at"] = _now()

    try:
        _update_settings(name, touch)
    except Exception:
        log.exception("could not record the use of a search key")


# ---------------------------------------------------------------- auto-embed


def job_completed(job_id: str) -> None:
    """Called by server.py when a parse job completes: embed it into every index with auto-embed
    on (and, if the index names tiers, only for those tiers), with the index's saved options."""
    if _problem():
        return
    prefix = f"{_bucket()}/"
    for skey, s in _read_all().items():
        if not skey.startswith(prefix) or not s.get("auto_embed"):
            continue
        name = skey[len(prefix):]
        try:
            job = _load_job(job_id)
            if not job.get("chunks") or (s.get("auto_embed_tiers") and job.get("tier") not in s["auto_embed_tiers"]):
                continue
            opts = EmbedOptions(**(s.get("auto_embed_options") or {}))
            index = _index_with_model(name)
            opts.check(index)
            _start(index, [job], opts, trigger="auto")
            log.info("auto-embedding %s into %s", job_id, name)
        except Exception:
            log.exception("auto-embedding %s into %s failed to start", job_id, name)


# ---------------------------------------------------------------- re-running


def _rerun(index: dict, rows: list[dict], trigger: str, attempts: Callable[[dict], int] = lambda r: 0) -> list[dict]:
    """Embed the rows' jobs into `index` again, each with the options its run used."""
    out = []
    for r in rows:
        try:
            job = _load_job(r["job_id"])
        except HTTPException:
            continue  # the parse job was deleted
        opts = EmbedOptions(**{**(r.get("options") or {}), "on_existing": "replace"})
        opts.check(index)
        out += _start(index, [job], opts, trigger=trigger, attempts=attempts(r))
    return out


@router.post("/indexes/{name}/retry")
def retry_failed(name: str) -> list[dict]:
    """Run every failed embedding run of the index again, with its own options."""
    index = _index_with_model(name)
    failed = [r for r in db.ingest_list(_bucket(), name) if r["status"] == "failed"] if db.enabled() else []
    return _rerun(index, failed, "retry", lambda r: r["attempts"] + 1)


class CopyTo(BaseModel):
    target: str


@router.post("/indexes/{name}/copy-to")
def copy_to(name: str, body: CopyTo) -> dict:
    """Embed every document of this index into another index (e.g. one with a newer model), each
    with the options it was embedded with here. This index is left as it is."""
    if body.target == name:
        raise HTTPException(400, "choose another index")
    target = _index_with_model(body.target)
    rows = [r for r in db.ingest_list(_bucket(), name) if r["status"] == "completed"] if db.enabled() else []
    if not rows:
        raise HTTPException(409, f"{name} has no embedded documents to copy")
    custom = [r for r in rows if (r.get("options") or {}).get("chunking") == "custom"]
    if custom and "text" not in target["non_filterable_keys"]:
        raise HTTPException(400, f"{len(custom)} documents were re-chunked, which needs an index that stores chunk text")
    started = _rerun(target, rows, "copy")
    return {"target": body.target, "started": len(started), "rows": started}


def _retry_loop() -> None:
    """Every 10 minutes, retry failed runs of indexes with auto-retry on, up to 3 times each.
    Runs stopped by the spending limit are left alone."""
    while True:
        time.sleep(RETRY_EVERY)
        try:
            if _problem() or not db.enabled():
                continue
            prefix = f"{_bucket()}/"
            for skey, s in _read_all().items():
                if not skey.startswith(prefix) or not s.get("auto_retry"):
                    continue
                name = skey[len(prefix):]
                failed = [
                    r for r in db.ingest_list(_bucket(), name)
                    if r["status"] == "failed" and r["attempts"] < MAX_AUTO_RETRIES and BUDGET_REACHED not in (r["error"] or "")
                ]
                if failed:
                    log.info("auto-retrying %d failed embedding runs in %s", len(failed), name)
                    _rerun(_index_with_model(name), failed, "retry", lambda r: r["attempts"] + 1)
        except Exception:
            log.exception("auto-retry pass failed")
