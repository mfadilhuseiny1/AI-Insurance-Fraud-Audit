/**
 * Data Connection beyond syncs: connection settings and diagnostics, table exports, REST API sources
 * and webhooks, HTTPS listeners, Views and HyperAuto (the API's exports.py, webhooks.py,
 * listeners.py, views.py and hyperauto.py).
 */
import { API_URL, type DbConnection, type Frequency } from "./api";

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      const d = body.detail ?? message;
      message = typeof d === "string" ? d : (d.message ?? JSON.stringify(d));
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

// ---------------------------------------------------------------- connections

export type DiagnoseStep = { step: string; ok: boolean; detail: string; ms: number };
export type Diagnosis = { ok: boolean; host: string | null; port: number | null; steps: DiagnoseStep[]; hint: string | null };

export const connections = {
  settings: (id: string, change: { exports_enabled?: boolean; code_imports?: boolean }) =>
    req<DbConnection>(`/api/datasources/connections/${id}/settings`, { method: "PUT", json: change }),
  diagnose: (id: string) => req<Diagnosis>(`/api/datasources/connections/${id}/diagnose`, { method: "POST" }),
};

// ---------------------------------------------------------------- OAuth 2.0 sign-in (connector_oauth.py)

export const oauth = {
  start: (kind: string, values: Record<string, unknown>, connectionId?: string) =>
    req<{ url: string; state: string; redirect_uri: string }>("/api/datasources/oauth/start", {
      method: "POST",
      json: { kind, values, connection_id: connectionId ?? null },
    }),
  result: (state: string) => req<{ status: "pending" | "done" | "error"; ref?: string; refresh?: boolean; message?: string }>(`/api/datasources/oauth/result/${state}`),
  redirectUri: () => req<{ redirect_uri: string }>("/api/datasources/oauth/redirect-uri"),
};

// ---------------------------------------------------------------- media sets and file exports (file_transfers.py)

export type MediaRunFile = { path: string; reason: string };

export type MediaRun = {
  at: string;
  folder: string;
  copied: number;
  failed: number;
  remaining: number;
  target_folder_id: string | null;
  /** set when the run wrote into a media set (its schema / formats checked, its transaction policy kept) */
  target_media_set_id?: string | null;
  transaction_policy?: "transactionless" | "transactional";
  transaction_id?: string | null;
  /** media set runs. failed: nothing more is written (a transactional run is aborted); partial: a transactionless run with files that failed */
  status?: "succeeded" | "partial" | "failed";
  error?: string | null;
  accepted?: number;
  rejected?: number;
  written?: number;
  skipped?: number;
  unchanged?: number;
  deleted?: number;
  /** files staged in the transaction of a run that was aborted */
  aborted?: number;
  /** files left out by "Path matches" / "File size limit" */
  filtered?: number;
  skipped_files?: MediaRunFile[];
  failed_files?: MediaRunFile[];
};

/** The sync filters of a media set sync, and deletion propagation (media set targets only). */
export type MediaSyncOptions = {
  exclude_already_synced?: boolean;
  path_matches?: string | null;
  file_size_limit?: number | null;
  ignore_items_not_matching_schema?: boolean;
  propagate_deletions?: boolean;
};

export type MediaSyncResult = MediaRun & { files: string[]; deleted_files?: string[]; errors: { path: string; error: string; rejected?: boolean; remembered?: boolean }[] };

/** A media set sync run that failed as a whole: the API answers 400 with the run (recorded in the history too). */
export class MediaSyncFailed extends Error {
  run: MediaSyncResult;
  constructor(message: string, run: MediaSyncResult) {
    super(message);
    this.name = "MediaSyncFailed";
    this.run = run;
  }
}

export const fileTransfers = {
  mediaState: (connId: string) =>
    req<{
      synced: number;
      runs: MediaRun[];
      extensions: string[];
      media_sets?: Record<string, { synced: number; rejected: number; skipped_files?: MediaRunFile[] }>;
    }>(`/api/datasources/connections/${connId}/media-sync`),
  mediaSync: async (
    connId: string,
    body: { folder: string; extensions?: string[]; target_folder_id?: string | null; target_media_set_id?: string | null } & MediaSyncOptions,
  ): Promise<MediaSyncResult> => {
    const res = await fetch(`${API_URL}/api/datasources/connections/${connId}/media-sync`, {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    if (res.ok) return res.json();
    let message = res.statusText;
    let run: MediaSyncResult | null = null;
    try {
      const d = (await res.json()).detail ?? message;
      message = typeof d === "string" ? d : (d.message ?? JSON.stringify(d));
      if (typeof d === "object" && d.run) run = d.run as MediaSyncResult;
    } catch {}
    throw run ? new MediaSyncFailed(message, run) : new Error(message);
  },
  fileExport: (connId: string, body: { dataset: DatasetRef; path: string; format: "parquet" | "csv" | "jsonl" }) =>
    req<{ path: string; rows: number; bytes: number; dataset: string }>(`/api/datasources/connections/${connId}/file-export`, { method: "POST", json: body }),
};

// ---------------------------------------------------------------- SAP tools (sap_tools.py, Palantir SAP add-on)

export type SapCallResult = { function: string; result: unknown; messages: Record<string, number> };
export type SapBulkResult = {
  function: string;
  dataset: string;
  rows: number;
  calls: number;
  messages: Record<string, number>;
  errors: { rows: string; error: string }[];
  results: unknown[];
};

export const sapTools = {
  resources: (connId: string) => req<{ type: string; message: string }[]>(`/api/datasources/connections/${connId}/sap/resources`),
  metadata: (connId: string, fn: string) => req<unknown>(`/api/datasources/connections/${connId}/sap/functions/${encodeURIComponent(fn)}/metadata`),
  call: (connId: string, fn: string, body: { input: Record<string, unknown>; output: string[]; commit: boolean }) =>
    req<SapCallResult>(`/api/datasources/connections/${connId}/sap/functions/${encodeURIComponent(fn)}/call`, { method: "POST", json: body }),
  bulk: (
    connId: string,
    fn: string,
    body: { dataset: DatasetRef; template: Record<string, unknown>; output: string[]; commit: boolean; parallel: boolean; jobs: number; per_job: number },
  ) => req<SapBulkResult>(`/api/datasources/connections/${connId}/sap/functions/${encodeURIComponent(fn)}/bulk`, { method: "POST", json: body }),
  dmsSync: (connId: string, body: { documenttype?: string; fileformat?: string; path_matches?: string; max_bytes?: number | null; exclude_synced?: boolean }) =>
    req<MediaRun & { skipped: number; files: string[]; errors: { document: string; error: string }[] }>(`/api/datasources/connections/${connId}/sap/dms-sync`, {
      method: "POST",
      json: body,
    }),
};

// ---------------------------------------------------------------- datasets

export type DatasetRef = { kind: "file"; item_id: string } | { kind: "source"; id: string } | { kind: "view"; item_id: string };
export type DescribedRef = DatasetRef & { name: string; path: string };

// ---------------------------------------------------------------- exports

export const EXPORT_MODES = [
  { id: "mirror", label: "Efficiently mirror dataset to external table", hint: "Recommended. The table always matches the dataset: rows appended since the last export are added; a new dataset view (a SNAPSHOT) truncates the table first." },
  { id: "full", label: "Full dataset without truncation", hint: "Exports the whole dataset every run without truncating — almost always duplicates rows." },
  { id: "full_truncate", label: "Full dataset with truncation", hint: "Truncates the table, then exports the whole dataset. Overwrites edits made to the table between exports." },
  { id: "incremental", label: "Export incrementally", hint: "Only rows not exported yet, without truncating. A new dataset view (SNAPSHOT) is exported in full and may duplicate rows." },
  { id: "incremental_truncate", label: "Export incrementally with truncation", hint: "Truncates, then exports only rows not exported yet — the table as a message queue." },
  { id: "incremental_append_only", label: "Export incrementally and fail if not APPEND", hint: "Only rows not exported yet; fails if the dataset view was replaced, so nothing is ever exported twice." },
] as const;
export type ExportMode = (typeof EXPORT_MODES)[number]["id"];
/** exports into applications (Salesforce, HubSpot, …): no truncation */
export const RECORD_EXPORT_MODES: ExportMode[] = ["full", "incremental", "incremental_append_only"];
export type ExportRun = { id: string; trigger: string; status: "running" | "completed" | "failed"; rows: number; truncated: boolean; detail: string | null; error: string | null; started_at: string; finished_at: string | null };
export type TableExport = {
  id: string;
  name: string;
  connection: { id: string; name: string; kind: string; export_kind?: "table" | "records" | null };
  dataset: DescribedRef;
  database: string;
  schema: string;
  table: string;
  mode: ExportMode;
  /** exports into applications: records are created or updated by this column (an upsert) */
  key: string | null;
  frequency: Frequency;
  state: { exported_rows: number; view_id: string | null; runs: number };
  status: "idle" | "running" | "failed";
  next_run_at: string | null;
  last_run: ExportRun | null;
  runs?: ExportRun[];
  created_at: string;
  updated_at: string;
};

export const exportsApi = {
  list: () => req<TableExport[]>("/api/exports"),
  get: (id: string) => req<TableExport>(`/api/exports/${id}`),
  create: (body: { name: string; connection_id: string; dataset: DatasetRef; database: string; schema: string; table: string; mode: ExportMode; frequency: Frequency; key?: string }) =>
    req<TableExport>("/api/exports", { method: "POST", json: body }),
  update: (id: string, change: { name?: string; mode?: ExportMode; frequency?: Frequency }) => req<TableExport>(`/api/exports/${id}`, { method: "PUT", json: change }),
  remove: (id: string) => req<{ deleted: string }>(`/api/exports/${id}`, { method: "DELETE" }),
  run: (id: string) => req<ExportRun>(`/api/exports/${id}/run`, { method: "POST" }),
};

// ---------------------------------------------------------------- REST API sources and webhooks

export type DomainAuth = "none" | "bearer" | "basic" | "api_key_header" | "api_key_query";
export type RestDomain = { url: string; auth: DomainAuth; key_name?: string | null };
export type RestSource = {
  id: string;
  name: string;
  api_name: string | null;
  domains: RestDomain[];
  credentials_set: Record<string, string[]>;
  secrets: string[];
  code_imports: boolean;
  export_controls?: { allow_foundry_inputs: boolean };
  webhooks: { id: string; name: string; api_name: string }[];
  created_at: string;
  updated_at: string;
};
export type RestSourceIn = {
  name: string;
  api_name?: string | null;
  domains: RestDomain[];
  credentials?: Record<string, Record<string, string>>;
  secrets?: Record<string, string>;
  remove_secrets?: string[];
};

export const INPUT_TYPES = ["String", "Integer", "Long", "Double", "Boolean", "Date", "Timestamp", "List", "Record"] as const;
export const OUTPUT_TYPES = ["String", "Integer", "Long", "Double", "Boolean", "List", "Record"] as const;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export const BODY_TYPES = [
  { id: "none", label: "No body" },
  { id: "json", label: "Raw JSON" },
  { id: "form", label: "Form data" },
  { id: "form_urlencoded", label: "Form URL encoded" },
  { id: "text", label: "Plain text" },
  { id: "xml", label: "XML" },
  { id: "html", label: "HTML" },
] as const;
export type WebhookInput = { id: string; type: (typeof INPUT_TYPES)[number]; required: boolean; options: string[]; description: string };
export type WebhookCall = {
  id: string;
  method: (typeof METHODS)[number];
  domain: number;
  path: string;
  query: [string, string][];
  headers: [string, string][];
  body_type: (typeof BODY_TYPES)[number]["id"];
  body: string;
  form: [string, string][];
  read_only: boolean | null;
};
export type WebhookOutput = { id: string; type: (typeof OUTPUT_TYPES)[number]; call: string; path: string[] };
export type WebhookLimits = { timeout_s: number; concurrency: number | null; rate_count: number | null; rate_per: "second" | "minute" | "hour" | "day" };
export type WebhookDef = {
  source_id: string;
  name: string;
  api_name: string;
  description: string;
  inputs: WebhookInput[];
  calls: WebhookCall[];
  outputs: WebhookOutput[];
  limits: WebhookLimits;
  store_responses: boolean;
  function: boolean;
  retryable_status_codes: number[];
};
export type Webhook = Omit<WebhookDef, "source_id"> & {
  id: string;
  kind: "read" | "write";
  source: { id: string; name: string; api_name: string | null; domains: RestDomain[] };
  last: { status: string; at: string } | null;
  created_at: string;
  updated_at: string;
};
export type CallTrace = { id: string; method: string; url: string; status: number; ms: number; response: unknown };
export type WebhookResult = { outputs: Record<string, unknown>; calls: CallTrace[]; kind: string; ms: number };
export type WebhookHistory = {
  id: string;
  status: "succeeded" | "failed";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  calls: (Omit<CallTrace, "response"> & { response: string | null })[];
  error: string | null;
  changed_external: boolean | null;
  duration_ms: number;
  at: string;
};

export const restSources = {
  list: () => req<RestSource[]>("/api/rest-sources"),
  create: (body: RestSourceIn) => req<RestSource>("/api/rest-sources", { method: "POST", json: body }),
  update: (id: string, body: RestSourceIn) => req<RestSource>(`/api/rest-sources/${id}`, { method: "PUT", json: body }),
  settings: (id: string, change: { code_imports?: boolean }) => req<RestSource>(`/api/rest-sources/${id}/settings`, { method: "PUT", json: change }),
  remove: (id: string) => req<{ deleted: string }>(`/api/rest-sources/${id}`, { method: "DELETE" }),
  test: (id: string) => req<{ ok: boolean; domains: { url: string; ok: boolean; status?: number; error?: string; ms: number }[] }>(`/api/rest-sources/${id}/test`, { method: "POST" }),
};

/** Runs a webhook; failures carry the calls made and whether the external system may have changed. */
export async function executeWebhook(id: string, inputs: Record<string, unknown>): Promise<WebhookResult> {
  const res = await fetch(`${API_URL}/api/webhooks/${id}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inputs }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    const err = new Error(typeof d === "string" ? d : (d?.message ?? res.statusText)) as Error & { calls?: CallTrace[]; changed?: boolean };
    if (d && typeof d === "object") {
      err.calls = d.calls;
      err.changed = d.external_system_changed;
    }
    throw err;
  }
  return body as WebhookResult;
}

export const webhooks = {
  list: (sourceId?: string) => req<Webhook[]>(`/api/webhooks${sourceId ? `?source_id=${sourceId}` : ""}`),
  get: (id: string) => req<Webhook>(`/api/webhooks/${id}`),
  create: (def: WebhookDef) => req<Webhook>("/api/webhooks", { method: "POST", json: def }),
  update: (id: string, def: WebhookDef) => req<Webhook>(`/api/webhooks/${id}`, { method: "PUT", json: def }),
  duplicate: (id: string) => req<Webhook>(`/api/webhooks/${id}/duplicate`, { method: "POST" }),
  remove: (id: string) => req<{ deleted: string }>(`/api/webhooks/${id}`, { method: "DELETE" }),
  history: (id: string) => req<WebhookHistory[]>(`/api/webhooks/${id}/history`),
  importCurl: (sourceId: string, command: string) => req<WebhookCall>("/api/webhooks/import-curl", { method: "POST", json: { source_id: sourceId, command } }),
};

// ---------------------------------------------------------------- listeners

export const LISTENER_KINDS = [
  { id: "custom", label: "Custom", hint: "Basic authentication, or a shared secret in a header or the token query parameter." },
  { id: "github", label: "GitHub", hint: "Verifies X-Hub-Signature-256 (HMAC-SHA256 of the body with the webhook secret)." },
  { id: "gitlab", label: "GitLab", hint: "Verifies the X-Gitlab-Token header against the secret token." },
  { id: "jira", label: "Jira", hint: "Verifies X-Hub-Signature when the webhook has a secret (optional)." },
  { id: "slack", label: "Slack", hint: "Verifies X-Slack-Signature with the app's signing secret and answers Slack's URL verification." },
  { id: "stripe", label: "Stripe", hint: "Verifies the Stripe-Signature header (HMAC-SHA256, 5-minute tolerance)." },
  { id: "shopify", label: "Shopify", hint: "Verifies X-Shopify-Hmac-Sha256 (base64 HMAC-SHA256 of the body)." },
  { id: "google_pubsub", label: "Google Cloud Pub/Sub", hint: "Push subscriptions: add ?token=<shared secret> to the endpoint URL." },
  { id: "hmac", label: "Generic HMAC", hint: "Any system that signs the body with HMAC-SHA256 or SHA1 in a header (hex or base64)." },
] as const;
export type ListenerKind = (typeof LISTENER_KINDS)[number]["id"];
/** `token` / `url` (the inbound credential) only for those who may change the listener, and never in listings. */
export type ListenerEndpoint = { token: string | null; url: string | null; created_at: string; expires_at: string | null; expired: boolean };
/** A listener has the access model of its stream: `item_id` / `project_id` are the Files folder and Project whose
 * roles and markings apply (none: the creator's own); Viewer reads its events, Editor changes it (`can_edit`). */
export type Listener = {
  id: string;
  name: string;
  kind: ListenerKind;
  config: { auth?: string; header_name?: string; algorithm?: string; encoding?: string; prefix?: string };
  secret_set: boolean;
  username: string | null;
  stream_id: string;
  status: "active" | "inactive";
  endpoints: ListenerEndpoint[];
  stats: { events?: number; last_event_at?: string };
  item_id: string | null;
  project_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  can_edit: boolean;
  markings_resource: string;
  created_at: string;
  updated_at: string;
};
export type ListenerIn = {
  name: string;
  kind: ListenerKind;
  auth?: "basic" | "header" | "query" | "none";
  header_name?: string;
  algorithm?: "sha256" | "sha1";
  encoding?: "hex" | "base64";
  prefix?: string;
  secret?: string;
  username?: string;
  /** creating: the folder / Project it lives in (none: the creator's own) */
  parent_id?: string | null;
};
export type ListenerEvent = { seq: number; at: string; event_id: string; received_at: string; headers: string; query: string; body: string };

export const listeners = {
  list: () => req<Listener[]>("/api/listeners"),
  get: (id: string) => req<Listener>(`/api/listeners/${id}`),
  move: (id: string, parentId: string) => req<Listener>(`/api/listeners/${id}/home`, { method: "PUT", json: { parent_id: parentId } }),
  create: (body: ListenerIn) => req<Listener>("/api/listeners", { method: "POST", json: body }),
  update: (id: string, body: ListenerIn) => req<Listener>(`/api/listeners/${id}`, { method: "PUT", json: body }),
  setActive: (id: string, active: boolean) => req<Listener>(`/api/listeners/${id}/status`, { method: "POST", json: { active } }),
  rotate: (id: string, expireInHours: number) => req<Listener>(`/api/listeners/${id}/rotate`, { method: "POST", json: { expire_in_hours: expireInHours } }),
  setExpiry: (id: string, token: string, expiresAt: string) => req<Listener>(`/api/listeners/${id}/endpoints/${token}`, { method: "PUT", json: { expires_at: expiresAt } }),
  deleteEndpoint: (id: string, token: string) => req<Listener>(`/api/listeners/${id}/endpoints/${token}`, { method: "DELETE" }),
  remove: (id: string, deleteStream: boolean) => req<{ deleted: string }>(`/api/listeners/${id}?delete_stream=${deleteStream}`, { method: "DELETE" }),
  events: (id: string) => req<{ stream_id: string; events: ListenerEvent[] }>(`/api/listeners/${id}/events`),
};

// ---------------------------------------------------------------- views

export type ViewDef = { backing: DatasetRef[]; primary_key: string[]; ordering: string[]; deletion_column: string | null; schema_evolution: boolean };
export type ViewInfo = { item: { id: string; name: string; parent_id: string | null; path?: { name: string }[] }; definition: Omit<ViewDef, "backing"> & { backing: DescribedRef[] } };
export type ViewPreview = { columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total_rows: number };

export const views = {
  list: () => req<{ id: string; name: string; parent_id: string | null; updated_at: string; path?: { name: string }[] }[]>("/api/views"),
  create: (name: string, parentId: string | null, definition: ViewDef) => req<ViewInfo>("/api/views", { method: "POST", json: { name, parent_id: parentId, definition } }),
  get: (itemId: string) => req<ViewInfo>(`/api/views/${itemId}`),
  update: (itemId: string, definition: ViewDef) => req<ViewInfo>(`/api/views/${itemId}`, { method: "PUT", json: definition }),
  preview: (definition: ViewDef) => req<ViewPreview>("/api/views/preview", { method: "POST", json: definition }),
  table: (itemId: string) => req<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; name: string }>(`/api/views/${itemId}/table`),
};

// ---------------------------------------------------------------- HyperAuto

export type HaSource = { kind: "connection"; connection_id: string; database: string; schema: string } | { kind: "folder"; folder_id: string };
export type HaTable = { name: string; role: "object" | "enrichment"; sync_id?: string | null; ordering?: string | null };
export type HaOptions = {
  automatic_joins: boolean;
  readable_columns: boolean;
  readable_names: boolean;
  primary_keys: boolean;
  foreign_keys: boolean;
  deduplicate: boolean;
  cleaning: boolean;
  incremental: boolean;
  ontology: boolean;
  language_column?: string | null;
  language_value?: string | null;
};
export const HA_DEFAULT_OPTIONS: HaOptions = {
  automatic_joins: true,
  readable_columns: true,
  readable_names: true,
  primary_keys: true,
  foreign_keys: true,
  deduplicate: true,
  cleaning: true,
  incremental: false,
  ontology: false,
  language_column: null,
  language_value: null,
};
export type HaConfig = { tables: HaTable[]; options: HaOptions };
export type HaListedTable = { name: string; comment: string | null; rows: number | null; role: "object" | "enrichment"; syncs?: { id: string; name: string; mode: string }[] };
export type HaMetaTable = HaListedTable & { columns: { name: string; type: string; comment: string | null }[]; primary_key: string[]; ordering: string | null };
export type HaForeignKey = { table: string; name: string; columns: string[]; ref_table: string; ref_columns: string[] };
export type HaSummary = {
  objects?: { table: string; key: string | null; renamed: number }[];
  enrichment?: string[];
  joins?: { object: string; enrichment: string; on: [string, string][] }[];
  foreign_keys?: { table: string; column: string; references: string }[];
  links?: { from: string; to: string; key: string }[];
  outputs?: { table: string; output: string; key: string | null }[];
};
export type HyperAutoPipeline = {
  id: string;
  name: string;
  source: HaSource & { connection_name?: string; connection_kind?: string | null; folder_name?: string };
  config: HaConfig;
  pending: { config: HaConfig; branch?: string; proposal_id?: string; proposal?: { id: string; branch: string; status: string } | null } | null;
  pipeline: { id: string; name: string; path: string } | null;
  status: "generating" | "ready" | "failed";
  progress: { at: string; msg: string }[];
  summary: HaSummary;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export const hyperauto = {
  list: () => req<HyperAutoPipeline[]>("/api/hyperauto"),
  get: (id: string) => req<HyperAutoPipeline>(`/api/hyperauto/${id}`),
  listTables: (source: HaSource) => req<{ tables: HaListedTable[]; foreign_keys: HaForeignKey[]; modules: Record<string, string[]> }>("/api/hyperauto/explore", { method: "POST", json: { source } }),
  metadata: (source: HaSource, tables: string[]) =>
    req<{ tables: HaMetaTable[]; foreign_keys: HaForeignKey[]; modules: Record<string, string[]> }>("/api/hyperauto/explore", { method: "POST", json: { source, tables } }),
  suggest: (source: HaSource, workflow: string) => req<{ tables: { name: string; why: string }[]; method: string }>("/api/hyperauto/suggest", { method: "POST", json: { source, workflow } }),
  create: (body: { name: string; source: HaSource; config: HaConfig; parent_id: string | null }) => req<HyperAutoPipeline>("/api/hyperauto", { method: "POST", json: body }),
  propose: (id: string, config: HaConfig) => req<HyperAutoPipeline>(`/api/hyperauto/${id}/proposal`, { method: "POST", json: config }),
  retry: (id: string) => req<HyperAutoPipeline>(`/api/hyperauto/${id}/retry`, { method: "POST" }),
  remove: (id: string) => req<{ deleted: string }>(`/api/hyperauto/${id}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------- network (egress policies, private links, ingress)

export type EgressPolicy = {
  id: string;
  name: string;
  kind: "direct" | "private_link" | "agent_proxy";
  provider: "aws" | "azure" | "gcp" | "other" | null;
  host: string;
  ports: number[];
  target: string | null;
  endpoint_id: string | null;
  description: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};
export type EgressPolicyIn = Omit<EgressPolicy, "id" | "created_at" | "updated_at">;
export type NetworkSettings = {
  enforce_egress: boolean;
  enforce_ingress: boolean;
  ingress_cidrs: string[];
  enforce_listener_ingress: boolean;
  listener_cidrs: string[];
  trusted_proxies: string[];
  your_ip: string;
  routes: number;
};
export type RouteCheck = {
  host: string;
  port: number;
  policy: EgressPolicy | null;
  route: "direct" | "private_link" | "agent_proxy";
  target: string | null;
  allowed: boolean;
  enforced: boolean;
  addresses?: string[];
  reachable?: boolean;
  error?: string;
  ms?: number;
};

export const network = {
  policies: () => req<EgressPolicy[]>("/api/network/policies"),
  createPolicy: (body: EgressPolicyIn) => req<EgressPolicy>("/api/network/policies", { method: "POST", json: body }),
  updatePolicy: (id: string, body: EgressPolicyIn) => req<EgressPolicy>(`/api/network/policies/${id}`, { method: "PUT", json: body }),
  deletePolicy: (id: string) => req<{ deleted: string }>(`/api/network/policies/${id}`, { method: "DELETE" }),
  settings: () => req<NetworkSettings>("/api/network/settings"),
  saveSettings: (change: Partial<Omit<NetworkSettings, "your_ip" | "routes">>) => req<NetworkSettings>("/api/network/settings", { method: "PUT", json: change }),
  check: (host: string, port: number) => req<RouteCheck>("/api/network/check", { method: "POST", json: { host, port } }),
};
