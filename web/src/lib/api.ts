const JSON_HEADERS = { "content-type": "application/json" };

/* the API lives on the same machine as the web server: call it at the host the page itself was opened
   with (localhost stays localhost; the LAN "Network:" address or another device reaches the server's LAN
   address, not its own localhost). The public build sets NEXT_PUBLIC_API_URL empty (same origin). AI JKN Synthetic runs
   its own API beside the platform's: NEXT_PUBLIC_API_PORT (web/.env.local) is 8300 there. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ??
  `http://${typeof window === "undefined" ? "localhost" : window.location.hostname}:${process.env.NEXT_PUBLIC_API_PORT ?? "8000"}`;

export type Tier = {
  id: string;
  label: string;
  /** document types the tier is strongest at, e.g. "Scientific Document, Academic Paper" */
  best_for: string;
  description: string;
  /** selling price per page (a plain number); null while the tier is not priced yet */
  price_per_page: number | null;
  available: boolean;
  unavailable_reason: string | null;
};

export type AppConfig = {
  tiers: Tier[];
};

export type FileMeta = {
  id: string;
  name: string;
  kind: "pdf" | "image";
  pages: number;
  size: number;
  uploaded_at: string;
};

export type JobStatus = "queued" | "running" | "paused" | "stopped" | "completed" | "failed";

export type Job = {
  id: string;
  file_id: string;
  file_name: string;
  tier: string;
  tier_label: string;
  languages: string[];
  instructions: string | null;
  page_from: number;
  page_to: number;
  pages_total: number;
  pages_done: number;
  status: JobStatus;
  /** the batch this job was started in, if any */
  batch_id?: string | null;
  /** set while a running job winds down after Pause or Stop (chunks in progress finish first) */
  halt?: "pause" | "stop" | null;
  /** completed from the pages parsed before Stop; the rest are in pages_not_parsed */
  partial?: boolean;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  price_per_page: number;
  estimated_price: number;
  /** charged so far: pages done × price per page */
  price: number;
  elements: number;
  pages_not_parsed: number[];
  /** pages that produced elements; null for jobs from before this was recorded */
  content_pages: number[] | null;
  chunks: number | null;
  /** how the chunks were split: "semantic" (by topic) or "heading"; null for older jobs */
  chunking?: "semantic" | "heading" | null;
};

export type ParseElement = {
  type: string;
  element_id: string;
  text: string;
  metadata: {
    page_number: number;
    languages?: string[];
    is_footnote?: boolean;
    text_as_html?: string;
    parent_id?: string;
    [key: string]: unknown;
  };
};

/** A retrieval (RAG) chunk: the unit that gets embedded; shown so users see where text is split. */
export type Chunk = {
  index: number;
  text: string;
  markdown: string;
  page_numbers: number[];
  languages: string[];
  element_types: string[];
  /** the chunk's elements, whose coordinates place it on the page preview */
  element_ids: string[];
};

export type Usage = {
  jobs: number;
  completed: number;
  pages: number;
  price: number;
  by_day: { day: string; pages: number; price: number }[];
};

export type JobRequest = {
  file_id: string;
  tier: string;
  page_from?: number;
  page_to?: number;
  languages: string[];
  instructions?: string;
};

/** Many files parsed with one tier and settings: one job per file, followed together. */
export type Batch = {
  id: string;
  name: string;
  tier: string;
  tier_label: string;
  created_at: string;
  job_ids: string[];
  jobs: Job[];
  totals: {
    files: number;
    completed: number;
    active: number;
    /** paused or stopped */
    paused: number;
    failed: number;
    pages_done: number;
    pages_total: number;
    price: number;
    estimated_price: number;
  };
};

export type BatchRequest = {
  file_ids: string[];
  tier: string;
  languages: string[];
  instructions?: string;
  name?: string;
};

/** A folder or file in the Files tab. */
export type DriveItem = {
  id: string;
  parent_id: string | null;
  kind: "project" | "folder" | "file";
  name: string;
  size: number;
  content_type: string | null;
  /** number of children (projects and folders in a listing only) */
  items: number | null;
  /** the default project and its folders, which cannot be renamed, moved or deleted */
  default: boolean;
  starred: boolean;
  /** a folder that is a media set: its schema (Media sets app) */
  media_set?: string | null;
  /** when it was put in the trash (trash listing only) */
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
  /** folders above this item, root-most first (single-item and cross-folder responses) */
  path?: { id: string; name: string }[];
};

export type DriveUsage = { bytes: number; files: number; folders: number; trash_bytes: number; trash_items: number };

/** A link that lets anyone who has it view and download an item. */
export type DriveShare = {
  token: string;
  item_id: string;
  name: string | null;
  kind: DriveItem["kind"] | null;
  created_at: string;
  expires_at: string | null;
  expired: boolean;
};

/** What a share-link visitor sees. */
export type SharedItem = Pick<DriveItem, "id" | "kind" | "name" | "size" | "content_type" | "items" | "updated_at">;
export type SharedView = {
  expires_at: string | null;
  root: SharedItem;
  current: SharedItem;
  /** from the shared item down to the current folder */
  path: { id: string; name: string }[];
  items: SharedItem[];
};

/** projects and folders hold other items */
export const isContainer = (item: Pick<DriveItem, "kind">) => item.kind !== "file";

export type DriveFolder = {
  /** null at the top level */
  folder: DriveItem | null;
  items: DriveItem[];
};

/** An embedding model offered for vector indexes (OpenRouter). */
export type EmbeddingModel = {
  id: string;
  label: string;
  vendor: string;
  /** native size */
  dimension: number;
  /** sizes offered when creating an index */
  dimensions: number[];
  /** Matryoshka models: any size in this range works too */
  range?: [number, number];
  context: number;
  multilingual: boolean;
  note: string;
  /** USD per million input tokens on OpenRouter; null when unknown */
  price_per_mtok?: number | null;
};

export type VectorConfig = {
  bucket: string | null;
  region: string | null;
  /** why vectors can't be used right now (missing settings), or null */
  problem: string | null;
  models: EmbeddingModel[];
  default_model: string;
  max_dimension: number;
  /** without the database, embedded documents are not remembered across restarts */
  database: boolean;
  /** the LLM that re-ranks search results */
  rerank_model: string;
};

/** A bearer token for /api/vectors/v1/search, bound to a metadata filter (the token itself is shown once). */
export type SearchKey = {
  id: string;
  name: string;
  filter: Record<string, string>;
  /** the token's first characters, to recognise it */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
};

/** Per-index settings; everything is off until turned on. */
export type VectorSettings = {
  /** embed newly parsed documents into this index automatically */
  auto_embed: boolean;
  auto_embed_options: EmbedOptions | null;
  /** tier ids; empty = every tier */
  auto_embed_tiers: string[];
  /** spending limit in USD; null = none */
  budget_usd: number | null;
  /** spent on embedding, queries and re-ranking (USD) */
  spent_usd: number;
  /** retry failed runs every 10 minutes, up to 3 times */
  auto_retry: boolean;
  keys: SearchKey[];
};

export type SearchMode = "vector" | "hybrid";

export type VectorMetric = "cosine" | "euclidean";

export type VectorIndex = {
  name: string;
  arn: string;
  dimension: number;
  metric: VectorMetric;
  data_type: string | null;
  mode: string | null;
  created_at: string;
  non_filterable_keys: string[];
  /** embedding model; null for an index made outside this app until one is chosen */
  model: string | null;
  compatible_models: string[];
  /** parse jobs embedded into it */
  documents?: number;
  /** from the last count, if any */
  vectors?: number | null;
};

export type VectorIngest = {
  index_name: string;
  job_id: string;
  file_name: string;
  model: string;
  dimension: number;
  status: "queued" | "running" | "completed" | "failed";
  vectors: number;
  total: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** chunks left out by the run's options (empty, short, duplicate) */
  skipped?: number;
  /** how the run prepared the chunks; null for runs from before options existed */
  options?: EmbedOptions | null;
  /** OpenRouter cost of the run, USD */
  cost_usd?: number;
  /** what started it */
  trigger?: "manual" | "auto" | "retry" | "copy";
  /** retries so far (auto-retry stops at 3) */
  attempts?: number;
};

/** How an embedding run turns a parse job into vectors (vectors.EmbedOptions in the API). */
export type EmbedOptions = {
  /** "parsed": the chunks shown in the result viewer; "custom": the job chunked again at these sizes */
  chunking: "parsed" | "custom";
  max_chars: number;
  overlap: number;
  combine_under: number;
  /** embed "Document: <name> · pages a–b" ahead of each chunk (the stored text stays the chunk) */
  context_header: boolean;
  /** leave out chunks shorter than this many characters */
  min_chars: number;
  /** leave out chunks whose text already came earlier in the document */
  dedupe: boolean;
  /** filterable tags on every vector, e.g. tenant, department, access_level */
  metadata: Record<string, string>;
  on_existing: "replace" | "skip";
};

export const DEFAULT_EMBED_OPTIONS: EmbedOptions = {
  chunking: "parsed",
  max_chars: 1500,
  overlap: 0,
  combine_under: 300,
  context_header: false,
  min_chars: 0,
  dedupe: false,
  metadata: {},
  on_existing: "replace",
};

type PreviewCounts = {
  vectors: number;
  chunks: number;
  empty: number;
  short: number;
  duplicate: number;
  chars: number;
  /** estimated (~4 characters a token) */
  tokens: number;
  longest: number;
  /** chunks probably longer than the model reads */
  over_context: number;
};

/** A dry run of an embedding run: nothing is embedded. */
export type EmbedPreview = {
  per_job: (PreviewCounts & { job_id: string })[];
  totals: PreviewCounts;
  model_context: number | null;
  /** USD per million tokens of the model, and the estimated cost of the run (null when the price is unknown) */
  price_per_mtok: number | null;
  cost_usd: number | null;
  samples: { key: string; chunk_index: number; pages: number[]; embed_text: string; chars: number }[];
};

export type VectorRow = {
  /** null for a keyword-only hit in hybrid search (its vector wasn't among the vector hits) */
  key: string | null;
  job_id: string | null;
  file_name: string | null;
  chunk_index: number | null;
  pages: number[];
  language: string | null;
  preview: string | null;
  metadata: Record<string, unknown>;
  /** search and neighbor results only */
  distance?: number;
  /** cosine: similarity (1 − distance); euclidean: the distance itself; hybrid: fused (RRF); re-ranked: 0–1 */
  score?: number;
  /** search only: where the row ranked in each list */
  signals?: { vector_rank?: number; vector_score?: number; keyword_rank?: number; rerank?: number };
};

export type VectorDetail = VectorRow & {
  text: string | null;
  data: number[];
  stats: { dimension: number; norm: number; min: number; max: number; mean: number; std: number; zeros: number };
};

export type VectorCount = { total: number; by_job: Record<string, number>; counted_at: string; ms: number };

export type VectorSearch = {
  rows: VectorRow[];
  metric: VectorMetric;
  model: string;
  mode: SearchMode;
  reranked: boolean;
  /** what `score` is: the index's metric, "rrf" (hybrid) or "rerank" */
  score_kind: VectorMetric | "rrf" | "rerank";
  embed_ms: number;
  query_ms: number;
  keyword_ms?: number;
  keyword_hits?: number;
  rerank_ms?: number;
  rerank_model?: string;
};

export type SearchRequest = {
  q: string;
  top_k: number;
  job_id?: string | null;
  filter?: Record<string, string>;
  mode?: SearchMode;
  rerank?: boolean;
};

// ---------------------------------------------------------------- data sources (external databases)

export type ConnectorField = {
  name: string;
  label: string;
  kind: "text" | "number" | "password" | "bool" | "textarea" | "select";
  required: boolean;
  default: string | number | boolean | null;
  placeholder: string;
  help: string;
  /** kept encrypted on the server and never sent back */
  secret: boolean;
  options: string[];
};

export type ConnectorGroup = "sql" | "warehouse" | "timeseries" | "nosql" | "storage" | "apps" | "erp" | "sap";

/** A capability from the connector catalog: its release status in Foundry and whether this server supports it. */
export type ConnectorCapability = { name: string; status: "ga" | "beta" | "unavailable" | "other"; note?: string; supported: boolean };

export type ConnectorSpec = {
  id: string;
  name: string;
  group: ConnectorGroup;
  description: string;
  fields: ConnectorField[];
  available: boolean;
  unavailable: string;
  /** databases hold schemas (PostgreSQL) or are the schema (MySQL) */
  schemas: boolean;
  /** reference from the connector catalog ("" / empty for connectors not in it) */
  docs_url: string;
  beta: boolean;
  capabilities: ConnectorCapability[];
  properties: { name: string; required: boolean; requirement: string; description: string; default: string }[];
  networking: { domain: string; when: string }[];
  /** OAuth 2.0 sign-in: the form field the Sign in button fills */
  oauth: { token_field: string; client_id_field: string } | null;
  /** table exports: SQL INSERTs ("table"), records through an application's write API ("records") */
  export_kind?: "table" | "records" | null;
};

export type DbConnection = {
  id: string;
  name: string;
  kind: string;
  kind_name: string;
  /** the non-secret settings */
  config: Record<string, string | number | boolean | null>;
  /** secret fields that hold a value (never the values) */
  secrets_set: string[];
  version: string | null;
  /** exports to this source are enabled (Data Connection → Exports) */
  exports_enabled?: boolean;
  /** the source can be imported into code repositories */
  code_imports?: boolean;
  tested_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SourceTable = { name: string; kind: "table" | "view"; rows: number | null; comment: string | null };

export type SourceColumn = {
  name: string;
  db_type: string;
  /** the pipeline column type */
  type: string;
  nullable: boolean;
  comment: string | null;
  identity?: boolean;
  /** usable as an incremental cursor */
  cursor: boolean;
  recommended: boolean;
  /** a cursor bound as something other than its column type (MongoDB ObjectId) */
  cursor_kind?: string | null;
};

export type TablePreview = {
  columns: SourceColumn[];
  rows: Record<string, unknown>[];
  rows_estimate: number | null;
  /** the table tracks changes: a delta-token incremental sync is possible (OData change tracking, SAP ODP) */
  delta?: boolean;
  comment: string | null;
};

export type BatchPreview = {
  from: string | null;
  from_inclusive: boolean;
  to: string | null;
  rows_found: number;
  columns: SourceColumn[];
  rows: Record<string, unknown>[];
};

export type IngestMode = "snapshot" | "incremental";
export type Frequency = "manual" | "15m" | "hourly" | "6h" | "daily";

export type IngestConfig = {
  mode: IngestMode;
  cursor_column?: string | null;
  start_from?: string | null;
  batch_size: number;
  frequency: Frequency;
  snapshot_behavior: "replace" | "new";
  /** timestamps without a time zone: "utc", "string", "long" (epoch ms) or an IANA zone */
  naive_timestamps?: string;
  /** runs longer than this stop and commit nothing */
  max_duration_minutes?: number | null;
  /** follow column type changes (snapshot sources) instead of failing */
  allow_schema_changes?: boolean;
  /** delta-token sources: "log" appends each delta's changes (default), "upsert" writes the current rows by key */
  delta_write?: DeltaWrite;
  /** upsert: keep the ODQ_CHANGEMODE column (each key's last change) in the current rows */
  keep_change_mode?: boolean;
};

export type DeltaWrite = "log" | "upsert";

export type SourceRun = {
  id: string;
  trigger: string;
  /** the dataset transaction the run committed (null: nothing new, no transaction) */
  transaction: "SNAPSHOT" | "APPEND" | "UPDATE" | null;
  status: "running" | "completed" | "failed";
  rows: number;
  from: string | null;
  to: string | null;
  item_id: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type DataSource = {
  id: string;
  name: string;
  connection: { id: string; name: string; kind: string };
  database: string;
  schema: string;
  table: string;
  columns: { name: string; type: string; db_type: string }[];
  mode: IngestMode;
  config: IngestConfig & { cursor_type?: string; start_from?: unknown; delta_key?: string[] };
  state: {
    last_cursor: string | null;
    rows_total: number;
    item_id: string | null;
    /** Parquet files in the current dataset view */
    view_files: number;
    /** the next run re-syncs from the initial value as a SNAPSHOT */
    resync: boolean;
    /** delta-token upsert: the next run rewrites the current rows (write mode or kept columns changed) */
    compact?: boolean;
    /** the source gained the ODQ_CHANGEMODE column: the next run rewrites the dataset so far in the new schema */
    widen?: boolean;
  };
  folder: { id: string; path: string[] } | null;
  status: "idle" | "running" | "failed";
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  last_run: SourceRun | null;
  runs?: SourceRun[];
};

export type NewDataSource = {
  name: string;
  connection_id: string;
  database: string;
  schema: string;
  table: string;
  columns: string[] | null;
  config: IngestConfig;
  run_now: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_URL + path, { cache: "no-store", ...init });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.detail ?? message;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  config: () => request<AppConfig>("/api/config"),
  file: (id: string) => request<FileMeta>(`/api/files/${id}`),
  /** use a file from the Files tab for parsing (instead of uploading one) */
  fileFromDrive: (itemId: string) =>
    request<FileMeta>("/api/files/from-drive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: itemId }),
    }),
  jobs: () => request<Job[]>("/api/jobs"),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  result: (id: string) => request<ParseElement[]>(`/api/jobs/${id}/result`),
  page: (id: string, page: number) => request<ParseElement[]>(`/api/jobs/${id}/pages/${page}`),
  chunks: (id: string, page?: number) =>
    request<Chunk[]>(`/api/jobs/${id}/chunks${page === undefined ? "" : `?page=${page}`}`),
  usage: () => request<Usage>("/api/usage"),
  createJob: (body: JobRequest) =>
    request<Job>("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteJob: (id: string) => request<{ deleted: string }>(`/api/jobs/${id}`, { method: "DELETE" }),
  createBatch: (body: BatchRequest) =>
    request<Batch>("/api/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  batches: () => request<Batch[]>("/api/batches"),
  batch: (id: string) => request<Batch>(`/api/batches/${id}`),
  /** pause, resume or finish (keep what is parsed) every job of a batch it applies to */
  batchAction: (id: string, action: "pause" | "resume" | "finish") =>
    request<Batch>(`/api/batches/${id}/${action}`, { method: "POST" }),
  /** halt between chunks; parsed chunks stay in the buffer */
  pauseJob: (id: string) => request<Job>(`/api/jobs/${id}/pause`, { method: "POST" }),
  /** continue a paused or stopped job: only pages not in the buffer are parsed */
  resumeJob: (id: string) => request<Job>(`/api/jobs/${id}/resume`, { method: "POST" }),
  /** stop; with keepPartial the pages parsed so far become the job's result */
  stopJob: (id: string, keepPartial: boolean) =>
    request<Job>(`/api/jobs/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keep_partial: keepPartial }),
    }),
  /** AI suggestion of date formats (Java DateTimeFormatter patterns) for sample values */
  suggestDatetimeFormats: (samples: string[], type: "Date" | "Timestamp") =>
    request<{ formats: string[]; timezone: string | null }>("/api/pipeline/datetime-formats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samples, type }),
    }),
  /** copy a completed job's results into a Files folder (null = top level) */
  saveToFiles: (id: string, formats: ResultFormat[], parentId: string | null) =>
    request<DriveItem[]>(`/api/jobs/${id}/save-to-files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ formats, parent_id: parentId }),
    }),
  vectors: {
    config: () => request<VectorConfig>("/api/vectors/config"),
    indexes: () => request<VectorIndex[]>("/api/vectors/indexes"),
    createIndex: (body: { name: string; model: string; dimension: number; metric: VectorMetric }) =>
      request<VectorIndex>("/api/vectors/indexes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    /** choose the embedding model of an index made outside this app */
    setModel: (name: string, model: string) =>
      request<VectorIndex>(`/api/vectors/indexes/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      }),
    deleteIndex: (name: string) =>
      request<{ deleted: string }>(`/api/vectors/indexes/${encodeURIComponent(name)}`, { method: "DELETE" }),
    ingests: (name: string) => request<VectorIngest[]>(`/api/vectors/indexes/${encodeURIComponent(name)}/ingests`),
    /** every embedding run in every index */
    allIngests: () => request<VectorIngest[]>("/api/vectors/ingests"),
    /** embed completed parse jobs' chunks into the index (runs in the background) */
    ingest: (name: string, jobIds: string[], options?: EmbedOptions) =>
      request<VectorIngest[]>(`/api/vectors/indexes/${encodeURIComponent(name)}/ingests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_ids: jobIds, options }),
      }),
    /** what an embedding run would produce, without embedding anything */
    preview: (jobIds: string[], options: EmbedOptions, model?: string | null) =>
      request<EmbedPreview>("/api/vectors/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_ids: jobIds, options, model }),
      }),
    /** delete a job's vectors from the index */
    removeIngest: (name: string, jobId: string) =>
      request<{ deleted: string; vectors: number }>(
        `/api/vectors/indexes/${encodeURIComponent(name)}/ingests/${encodeURIComponent(jobId)}`,
        { method: "DELETE" },
      ),
    list: (name: string, nextToken: string | null, signal?: AbortSignal) =>
      request<{ rows: VectorRow[]; next_token: string | null }>(
        `/api/vectors/indexes/${encodeURIComponent(name)}/vectors?limit=50${nextToken ? `&next_token=${encodeURIComponent(nextToken)}` : ""}`,
        { signal },
      ),
    vector: (name: string, key: string, signal?: AbortSignal) =>
      request<VectorDetail>(`/api/vectors/indexes/${encodeURIComponent(name)}/vector?key=${encodeURIComponent(key)}`, {
        signal,
      }),
    neighbors: (name: string, key: string, k = 10) =>
      request<{ rows: VectorRow[]; metric: VectorMetric }>(
        `/api/vectors/indexes/${encodeURIComponent(name)}/neighbors?key=${encodeURIComponent(key)}&k=${k}`,
      ),
    search: (name: string, body: SearchRequest) =>
      request<VectorSearch>(`/api/vectors/indexes/${encodeURIComponent(name)}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    settings: (name: string) => request<VectorSettings>(`/api/vectors/indexes/${encodeURIComponent(name)}/settings`),
    /** settings of every index that has any, by index name */
    allSettings: () => request<Record<string, VectorSettings>>("/api/vectors/settings"),
    updateSettings: (
      name: string,
      patch: Partial<Omit<VectorSettings, "spent_usd" | "keys">> & { reset_spent?: boolean },
    ) =>
      request<VectorSettings>(`/api/vectors/indexes/${encodeURIComponent(name)}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    createKey: (name: string, keyName: string, filter: Record<string, string>) =>
      request<{ key: SearchKey; token: string }>(`/api/vectors/indexes/${encodeURIComponent(name)}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyName, filter }),
      }),
    revokeKey: (name: string, id: string) =>
      request<{ revoked: string }>(`/api/vectors/indexes/${encodeURIComponent(name)}/keys/${id}`, { method: "DELETE" }),
    /** run every failed embedding run again, each with its own options */
    retry: (name: string) => request<VectorIngest[]>(`/api/vectors/indexes/${encodeURIComponent(name)}/retry`, { method: "POST" }),
    /** embed every document of the index into another index, with the same options */
    copyTo: (name: string, target: string) =>
      request<{ target: string; started: number; rows: VectorIngest[] }>(`/api/vectors/indexes/${encodeURIComponent(name)}/copy-to`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      }),
    /** scans the whole index; the result is kept on the server for a few minutes */
    count: (name: string, refresh = false) =>
      request<VectorCount>(`/api/vectors/indexes/${encodeURIComponent(name)}/count${refresh ? "?refresh=true" : ""}`),
  },
  /** Pipeline Builder datasets stored as Parquet in the Files tab */
  pipelineData: {
    deploy: (body: {
      name: string;
      parent_id: string | null;
      item_id: string | null;
      columns: { name: string; type: string }[];
      rows: Record<string, unknown>[];
    } & Pick<import("./pipeline").DeployModeFields, "mode"> & Partial<import("./pipeline").DeployModeFields>) =>
      request<{ item: DriveItem; rows: number; columns: number }>("/api/pipeline/datasets/deploy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    /** pipelines are .pipeline files in the Files tab */
    files: () => request<DriveItem[]>("/api/pipeline/files"),
    /** My Project / Datapipeline: where each new pipeline gets its own folder by default */
    defaultFolder: () => request<DriveItem>("/api/pipeline/default-folder"),
    createFile: (name: string, parentId: string | null, content: unknown) =>
      request<DriveItem>("/api/pipeline/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parent_id: parentId, content }),
      }),
    readFile: (itemId: string) => request<{ item: DriveItem; content: unknown }>(`/api/pipeline/files/${itemId}`),
    /** `base`: the file's updated_at when it was read — the API refuses (409) a save over a newer version */
    saveFile: (itemId: string, content: unknown, name?: string, base?: string) =>
      request<DriveItem>(`/api/pipeline/files/${itemId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, name, base_updated_at: base }),
      }),
    /**
     * a DuckDB local pipeline's preview of a node: its compiled statement's first rows, over every input row. One that
     * takes longer (a checkpoint it reads is computed first) comes back as a run, polled here until it is done.
     */
    duckdbPreview: async (body: {
      pipeline_id: string;
      sql: string;
      inputs: Record<string, string>;
      checkpoints?: { table: string; sql: string }[];
      limit?: number;
      /** the rows after the first `offset` (Next pages) */
      offset?: number;
      /** false: no totalRows (a next page of a query already counted) */
      count?: boolean;
      /** the page's ORDER BY (the count stays unordered) */
      order?: string;
    }) => {
      type Preview = { columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; totalRows?: number };
      const first = await request<Preview | { run_id: string }>("/api/pipeline/duckdb/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!("run_id" in first)) return first;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await request<{ status: string; result?: Preview; error?: string }>(`/api/pipeline/duckdb/runs/${first.run_id}`);
        if (r.status === "succeeded" && r.result) return r.result;
        if (r.status === "failed") throw new Error(r.error ?? "the preview failed");
      }
    },
    /** with `limit`, only the first rows (total_rows has the file's count) */
    table: (itemId: string, limit?: number) =>
      request<{ name: string; columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total_rows: number }>(
        `/api/pipeline/datasets/${itemId}/table${limit === undefined ? "" : `?limit=${limit}`}`,
      ),
  },
  drive: {
    folder: (id: string | null) => request<DriveFolder>(`/api/drive/folders/${id ?? "root"}`),
    item: (id: string) => request<DriveItem>(`/api/drive/items/${id}`),
    /** a folder, or (kind "project", top level only) a project */
    createFolder: (name: string, parentId: string | null, kind: "folder" | "project" = "folder") =>
      request<DriveItem>("/api/drive/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parent_id: parentId, kind }),
      }),
    /** rename (name) and/or move (moveTo: a folder id, or null for the top level) */
    update: (id: string, change: { name?: string; moveTo?: string | null }) =>
      request<DriveItem>(`/api/drive/items/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: change.name,
          move_to: change.moveTo === undefined ? undefined : (change.moveTo ?? "root"),
        }),
      }),
    /** delete for good (also from the trash) */
    remove: (id: string) => request<{ deleted: string; files: number }>(`/api/drive/items/${id}`, { method: "DELETE" }),
    trash: (id: string) => request<{ trashed: string }>(`/api/drive/items/${id}/trash`, { method: "POST" }),
    restore: (id: string) => request<DriveItem>(`/api/drive/items/${id}/restore`, { method: "POST" }),
    trashList: () => request<DriveItem[]>("/api/drive/trash"),
    emptyTrash: () => request<{ deleted: number; files: number }>("/api/drive/trash", { method: "DELETE" }),
    star: (id: string, starred: boolean) =>
      request<DriveItem>(`/api/drive/items/${id}/star`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starred }),
      }),
    /** copy into parentId (default: next to the original, as "Copy of …") */
    copy: (id: string, parentId?: string | null) =>
      request<DriveItem>(`/api/drive/items/${id}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent_id: parentId ?? null }),
      }),
    starred: () => request<DriveItem[]>("/api/drive/starred"),
    recent: () => request<DriveItem[]>("/api/drive/recent"),
    search: (q: string) => request<DriveItem[]>(`/api/drive/search?q=${encodeURIComponent(q)}`),
    usage: () => request<DriveUsage>("/api/drive/usage"),
    shares: (itemId?: string) => request<DriveShare[]>(itemId ? `/api/drive/items/${itemId}/shares` : "/api/drive/shares"),
    /** expiresDays: 1, 7 or 30; null = never */
    share: (itemId: string, expiresDays: number | null) =>
      request<DriveShare>(`/api/drive/items/${itemId}/shares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expires_days: expiresDays }),
      }),
    revokeShare: (token: string) => request<{ revoked: string }>(`/api/drive/shares/${token}`, { method: "DELETE" }),
    shared: (token: string, folder?: string) =>
      request<SharedView>(`/api/drive/shared/${token}${folder ? `?folder=${folder}` : ""}`),
  },
  /** external databases: connections, browsing, previews, data sources and their runs */
  dataSources: {
    connectors: () => request<ConnectorSpec[]>("/api/datasources/connectors"),
    connections: () => request<DbConnection[]>("/api/datasources/connections"),
    testConnection: (kind: string, values: Record<string, unknown>, connectionId?: string) =>
      request<{ ok: true; version?: string }>("/api/datasources/connections/test", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ kind, values, connection_id: connectionId ?? null }),
      }),
    createConnection: (kind: string, name: string, values: Record<string, unknown>) =>
      request<DbConnection>("/api/datasources/connections", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind, name, values }) }),
    deleteConnection: (id: string) => request<{ deleted: string }>(`/api/datasources/connections/${id}`, { method: "DELETE" }),
    databases: (id: string) => request<string[]>(`/api/datasources/connections/${id}/databases`),
    schemas: (id: string, database: string) =>
      request<string[]>(`/api/datasources/connections/${id}/schemas?${new URLSearchParams({ database })}`),
    tables: (id: string, database: string, schema: string, search = "") =>
      request<SourceTable[]>(`/api/datasources/connections/${id}/tables?${new URLSearchParams({ database, schema, search })}`),
    preview: (id: string, database: string, schema: string, table: string) =>
      request<TablePreview>(`/api/datasources/connections/${id}/preview?${new URLSearchParams({ database, schema, table })}`),
    incrementalPreview: (
      id: string,
      body: { database: string; schema: string; table: string; cursor_column: string; start_from: string | null; columns: string[] | null },
    ) => request<BatchPreview>(`/api/datasources/connections/${id}/incremental-preview`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }),
    sources: () => request<DataSource[]>("/api/datasources/sources"),
    source: (id: string) => request<DataSource>(`/api/datasources/sources/${id}`),
    createSource: (body: NewDataSource) =>
      request<DataSource>("/api/datasources/sources", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }),
    updateSource: (
      id: string,
      change: {
        name?: string;
        frequency?: Frequency;
        snapshot_behavior?: "replace" | "new";
        batch_size?: number;
        naive_timestamps?: string;
        max_duration_minutes?: number;
        allow_schema_changes?: boolean;
      },
    ) =>
      request<DataSource>(`/api/datasources/sources/${id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(change) }),
    deleteSource: (id: string, deleteData: boolean) =>
      request<{ deleted: string }>(`/api/datasources/sources/${id}?delete_data=${deleteData}`, { method: "DELETE" }),
    run: (id: string) => request<SourceRun>(`/api/datasources/sources/${id}/run`, { method: "POST" }),
    /** delta-token sources: append the change log, or upsert by key (each run's version holds the current rows) */
    changeDeltaWrite: (id: string, body: { delta_write: DeltaWrite; keep_change_mode?: boolean }) =>
      request<DataSource>(`/api/datasources/sources/${id}/delta-write`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) }),
    /** snapshot ↔ incremental; the next run re-syncs (a SNAPSHOT), later incremental runs APPEND */
    changeMode: (id: string, body: { mode: IngestMode; cursor_column?: string | null; start_from?: string | null }) =>
      request<DataSource>(`/api/datasources/sources/${id}/mode`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) }),
    resetCursor: (id: string) => request<DataSource>(`/api/datasources/sources/${id}/reset`, { method: "POST" }),
    nextBatch: (id: string) => request<BatchPreview>(`/api/datasources/sources/${id}/incremental-preview`, { method: "POST" }),
    /** the ingested dataset as pipeline columns and rows */
    table: (id: string) => request<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; name: string }>(`/api/datasources/sources/${id}/table`),
  },
};

/** POST a form with upload progress (fetch cannot report upload progress). */
export function postWithProgress<T>(path: string, form: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API_URL + path);
    // the session cookie (fetch gets it from the auth interceptor; XHR needs it asked for)
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        let message = xhr.statusText || "Upload failed";
        try {
          message = JSON.parse(xhr.responseText).detail ?? message;
        } catch {}
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("Could not reach the BluesandAI API at " + API_URL));
    xhr.send(form);
  });
}

export function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<FileMeta> {
  const form = new FormData();
  form.append("file", file);
  return postWithProgress("/api/files", form, onProgress);
}

/** Upload a file into a Files-tab folder (null = top level). */
export function uploadDriveFile(
  file: File,
  parentId: string | null,
  onProgress: (fraction: number) => void,
  /** "Folder/Sub/file.pdf" from a folder upload: the server recreates the subfolders */
  relativePath?: string,
): Promise<DriveItem> {
  const form = new FormData();
  form.append("file", file);
  if (parentId) form.append("parent_id", parentId);
  if (relativePath) form.append("relative_path", relativePath);
  return postWithProgress("/api/drive/files", form, onProgress);
}

export const pageImageUrl = (fileId: string, page: number, width: number) =>
  `${API_URL}/api/files/${fileId}/pages/${page}?width=${width}`;
export const sourceUrl = (fileId: string) => `${API_URL}/api/files/${fileId}/download`;
export type ResultFormat = "json" | "md" | "txt";
export const downloadUrl = (jobId: string, fmt: ResultFormat) =>
  `${API_URL}/api/jobs/${jobId}/download/${fmt}`;
export const driveContentUrl = (itemId: string, inline = false) =>
  `${API_URL}/api/drive/items/${itemId}/content${inline ? "?disposition=inline" : ""}`;
/** one zip of several items (folders included, with their contents) */
export const driveZipUrl = (ids: string[]) => `${API_URL}/api/drive/zip?ids=${ids.join(",")}`;
/** the page a share link opens (in this app) */
export const shareLinkUrl = (token: string) =>
  `${typeof window === "undefined" ? "" : window.location.origin}/s/${token}`;
export const sharedContentUrl = (token: string, itemId: string, inline = false) =>
  `${API_URL}/api/drive/shared/${token}/items/${itemId}/content${inline ? "?disposition=inline" : ""}`;
export const sharedZipUrl = (token: string, folder?: string) =>
  `${API_URL}/api/drive/shared/${token}/zip${folder ? `?folder=${folder}` : ""}`;
