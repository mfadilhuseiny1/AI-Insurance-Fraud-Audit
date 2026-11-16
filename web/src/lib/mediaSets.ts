/** Media sets (api/media_sets.py): Files folders with a schema, formats, transaction and retention policies,
 *  version history, access patterns and usage. */
import { API_URL } from "./api";

export type MediaSchema = "audio" | "dicom" | "document" | "email" | "image" | "spreadsheet" | "video" | "multimodal";
export type TransactionPolicy = "transactionless" | "transactional";
export type MediaSet = {
  id: string;
  name: string;
  path: string[];
  schema: MediaSchema;
  primary_format: string | null;
  additional_formats: string[];
  transaction_policy: TransactionPolicy;
  retention: { max_age_days: number | null; overwritten_days: number | null };
  virtual: { connection_id: string; connection_name: string; folder: string } | null;
  /** "pipeline" / "code" when a build writes it (no manual deletes) */
  built_by: string | null;
  items: number;
  size: number;
  versions: number;
  open_transaction: string | null;
  created_at: string;
  updated_at: string;
};
export type MediaItem = {
  id: string;
  path: string;
  size: number;
  content_type: string | null;
  uploaded_at: string | null;
  schema: MediaSchema | null;
  virtual: boolean;
  overwritten?: boolean;
  /** current / overwritten / deleted (version history) */
  state?: string;
};
export type SchemaInfo = { id: MediaSchema; label: string; formats: string[]; additional: Record<string, string[]> };
export type MediaUsage = {
  total_compute_seconds: number;
  media_sets: { id: string | null; name: string; compute_seconds: number; gb: number; requests: number }[];
  transformations: { id: string; compute_seconds: number; rate: number }[];
  rates: Record<string, number>;
};

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/media-sets" + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

/** persist: computed once and kept; cache: kept for ttl_seconds, then recomputed; recompute: computed at every request */
export type PersistencePolicy = "persist" | "cache" | "recompute";
export type Persistence = { policy: PersistencePolicy; ttl_seconds: number | null };
export type PatternParams = { page?: number; layer?: number; width?: number; channel?: string; format?: string; language?: string; output_format?: "text" | "segments"; mode?: string };
export type AccessPatterns = {
  builtin: { pattern: string; label: string; persistence: Persistence; rate: string | null }[];
  registered: { name: string; pattern: string; params: PatternParams; persistence: Persistence; created_at: string }[];
  available: string[];
};
export type Transcription = { channel: string; language?: string | null; text?: string; duration?: number; segments?: { id: number; start: number; end: number; text: string }[] };

export const mediaContentUrl = (id: string, download = false) => `${API_URL}/api/media-sets/items/${id}/content${download ? "?disposition=attachment" : ""}`;
export const accessUrl = (id: string, pattern: string, params: Record<string, string | number> = {}) => {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return `${API_URL}/api/media-sets/items/${id}/access/${pattern}${q ? `?${q}` : ""}`;
};
/** Where an audio / video access pattern's background job stands (thumbnail / frame, waveform, audio, transcription).
 *  queued: phase "fetching" (the item's shared source copy, fetch_progress 0-1) or "waiting" for a worker. */
export type AccessJob = {
  state: "queued" | "running" | "ready" | "failed" | "cancelled";
  progress: number;
  pattern: string;
  policy: PersistencePolicy;
  /** recompute: this computation's output (pass it back to read the output, its status or to cancel it) */
  token?: string;
  phase?: "fetching" | "waiting";
  fetch_progress?: number;
  step?: string;
  elapsed_seconds?: number;
  eta_seconds?: number;
  error?: string;
  status_code?: number;
  stored?: boolean;
};
type AccessParams = Record<string, string | number>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const accessDetail = async (r: Response) => {
  const body = await r.json().catch(() => ({ detail: r.statusText }));
  return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
};

/** A short progress line for an access job ("Fetching the source… 40%", "Transcribing (piece 2 of 5)… 31%"). */
export const accessJobNote = (s: AccessJob, what = "Computing") =>
  s.state === "queued"
    ? s.phase === "fetching"
      ? `Fetching the source…${s.fetch_progress != null ? ` ${Math.round(s.fetch_progress * 100)}%` : ""}`
      : "Queued…"
    : `${s.step ? s.step[0].toUpperCase() + s.step.slice(1) : what}… ${Math.round(s.progress * 100)}%${s.eta_seconds != null ? ` (about ${Math.max(1, Math.round(s.eta_seconds))} s left)` : ""}`;

/** Poll an access job (every 1.5 s) until its output is ready; returns its token (recompute) or null. Throws on
 *  failure or cancellation; stops when signal aborts (cancelling a recompute computation, which is this caller's own). */
async function waitAccessJob(itemId: string, pattern: string, params: AccessParams, first: AccessJob, onProgress?: (s: AccessJob) => void, signal?: AbortSignal): Promise<string | null> {
  let s = first;
  const token = first.token ?? null;
  for (;;) {
    if (s.state === "ready") return token;
    if (s.state === "failed" || s.state === "cancelled") throw new Error(s.state === "cancelled" ? "the computation was cancelled" : s.error || "the computation failed");
    onProgress?.(s);
    await sleep(1500);
    if (signal?.aborted) {
      if (token) void mediaSets.cancelAccess(itemId, pattern, params, token).catch(() => {});
      throw new DOMException("aborted", "AbortError");
    }
    s = await mediaSets.accessStatus(itemId, pattern, params, token);
  }
}

/** The HLS playlist (.m3u8) of an audio or video item; channel: "all", "mix" or a 0-based index; token: a recompute
 *  playback's rendition (from hlsStatus). Answers 202 until the first segments are rendered — poll hlsStatus until
 *  `playable`; a render still going then gives a growing EVENT playlist the player reloads. */
export const hlsUrl = (id: string, channel = "all", pattern = "hls", token?: string | null) =>
  `${API_URL}/api/media-sets/items/${id}/hls/playlist.m3u8?channel=${encodeURIComponent(channel)}${pattern !== "hls" ? `&pattern=${encodeURIComponent(pattern)}` : ""}${token ? `&token=${token}` : ""}`;
/** Where an item's HLS rendition stands; renders run in the background (queued, then rendering with progress 0-1). */
export type HlsStatus = {
  state: "queued" | "rendering" | "ready" | "failed" | "cancelled";
  progress: number;
  /** a recompute playback's rendition (pass it to hlsUrl and the next hlsStatus) */
  token: string | null;
  channel: string;
  policy: PersistencePolicy;
  /** the first segments are out: the playlist plays them (and grows) while the render goes on */
  playable: boolean;
  segments_ready?: number;
  /** "fetching": the source is still being copied out of storage (fetch_progress 0-1) */
  phase?: "fetching";
  fetch_progress?: number;
  duration_seconds?: number | null;
  elapsed_seconds?: number;
  eta_seconds?: number;
  error?: string;
};
const hlsQuery = (channel: string, pattern: string, token?: string | null) =>
  `channel=${encodeURIComponent(channel)}${pattern !== "hls" ? `&pattern=${encodeURIComponent(pattern)}` : ""}${token ? `&token=${token}` : ""}`;

export const mediaSets = {
  schemas: () => request<{ schemas: SchemaInfo[]; rates: Record<string, number>; limits: { max_path: number; max_item_bytes: number; max_transaction_items: number } }>("/schemas"),
  list: () => request<MediaSet[]>(""),
  get: (id: string) => request<MediaSet>(`/${id}`),
  create: (body: {
    name?: string;
    parent_id?: string | null;
    folder_id?: string;
    schema: MediaSchema;
    primary_format?: string | null;
    additional_formats?: string[];
    transaction_policy?: TransactionPolicy;
    virtual?: { connection_id: string; folder: string };
  }) => request<MediaSet>("", { method: "POST", json: body }),
  saveSettings: (id: string, body: { additional_formats?: string[]; retention?: { max_age_days: number | null; overwritten_days: number | null } }) =>
    request<MediaSet>(`/${id}/settings`, { method: "PUT", json: body }),
  unregister: (id: string) => request<unknown>(`/${id}`, { method: "DELETE" }),
  items: (id: string, opts: { deduplicate?: boolean; q?: string } = {}) =>
    request<{ total: number; items: MediaItem[] }>(`/${id}/items?deduplicate_by_path=${opts.deduplicate !== false}&q=${encodeURIComponent(opts.q ?? "")}&limit=2000`),
  history: (id: string, path: string) => request<MediaItem[]>(`/${id}/history?path=${encodeURIComponent(path)}`),
  upload: async (id: string, file: File, transactionId?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (transactionId) form.append("transaction_id", transactionId);
    return request<MediaItem & { staged?: number }>(`/${id}/items`, { method: "POST", body: form });
  },
  remove: (id: string, itemId: string) => request<unknown>(`/${id}/items/${itemId}`, { method: "DELETE" }),
  openTransaction: (id: string) => request<{ id: string }>(`/${id}/transactions`, { method: "POST" }),
  commit: (id: string, tx: string) => request<{ items: number }>(`/${id}/transactions/${tx}/commit`, { method: "POST" }),
  abort: (id: string, tx: string) => request<{ items: number }>(`/${id}/transactions/${tx}/abort`, { method: "POST" }),
  applyRetention: (id: string) => request<{ deleted: number; versions: number }>(`/${id}/retention/apply`, { method: "POST" }),
  virtualSync: (id: string, extensions: string[] = []) => request<{ registered: number; skipped: number; items: number }>(`/${id}/virtual-sync`, { method: "POST", json: { extensions } }),
  /** Item metadata. Audio / video streams are probed in the background: while the answer says "probe": "pending"
   *  this asks again (up to about a minute), so the stream fields arrive once the source is fetched. */
  metadata: async (itemId: string) => {
    let m = await request<Record<string, unknown>>(`/items/${itemId}/metadata`);
    for (let i = 0; i < 6 && m.probe === "pending"; i++) m = await request<Record<string, unknown>>(`/items/${itemId}/metadata?wait=10`);
    return m;
  },
  /** An access pattern's JSON output. Audio / video patterns may answer 202 while their background job runs: this
   *  then polls the job (onProgress gets its state) and fetches the output once it is ready. */
  access: async <T,>(itemId: string, pattern: string, params: AccessParams = {}, onProgress?: (s: AccessJob) => void, signal?: AbortSignal): Promise<T> => {
    const r = await fetch(accessUrl(itemId, pattern, params), { credentials: "include", signal });
    if (r.status === 202) {
      const token = await waitAccessJob(itemId, pattern, params, (await r.json()) as AccessJob, onProgress, signal);
      const r2 = await fetch(accessUrl(itemId, pattern, token ? { ...params, token } : params), { credentials: "include", signal });
      if (!r2.ok) throw new Error(await accessDetail(r2));
      return r2.json() as Promise<T>;
    }
    if (!r.ok) throw new Error(await accessDetail(r));
    return r.json() as Promise<T>;
  },
  /** A URL of an access pattern's output that answers with the output itself (for <img> / <audio>): an audio / video
   *  pattern's job is awaited first (onProgress gets its state); other patterns are computed inline, their URL at once. */
  accessReadyUrl: async (itemId: string, pattern: string, params: AccessParams = {}, onProgress?: (s: AccessJob) => void, signal?: AbortSignal): Promise<string> => {
    const r = await fetch(`${API_URL}/api/media-sets/items/${itemId}/access/${pattern}/status?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`, {
      credentials: "include",
      cache: "no-store",
      signal,
    });
    if (r.status === 400) return accessUrl(itemId, pattern, params); // computed inline
    if (!r.ok) throw new Error(await accessDetail(r));
    const token = await waitAccessJob(itemId, pattern, params, (await r.json()) as AccessJob, onProgress, signal);
    return accessUrl(itemId, pattern, token ? { ...params, token } : params);
  },
  /** starts the job when there is none (under recompute, without a token: a new computation and its token) */
  accessStatus: (itemId: string, pattern: string, params: AccessParams = {}, token?: string | null) =>
    request<AccessJob>(`/items/${itemId}/access/${pattern}/status?${new URLSearchParams([...Object.entries(params).map(([k, v]) => [k, String(v)]), ...(token ? [["token", token]] : [])])}`),
  cancelAccess: (itemId: string, pattern: string, params: AccessParams = {}, token?: string | null) =>
    request<AccessJob & { cancelled: boolean }>(`/items/${itemId}/access/${pattern}/job?${new URLSearchParams([...Object.entries(params).map(([k, v]) => [k, String(v)]), ...(token ? [["token", token]] : [])])}`, {
      method: "DELETE",
    }),
  /** starts the render when there is none (under recompute, without a token: a new playback) */
  hlsStatus: (itemId: string, channel = "all", pattern = "hls", token?: string | null) => request<HlsStatus>(`/items/${itemId}/hls/status?${hlsQuery(channel, pattern, token)}`),
  cancelHls: (itemId: string, channel = "all", pattern = "hls", token?: string | null) =>
    request<HlsStatus & { cancelled: boolean }>(`/items/${itemId}/hls/render?${hlsQuery(channel, pattern, token)}`, { method: "DELETE" }),
  usage: (days = 30) => request<MediaUsage>(`/usage/summary?days=${days}`),
  accessPatterns: (id: string) => request<AccessPatterns>(`/${id}/access-patterns`),
  registerPattern: (id: string, body: { name: string; pattern: string; params?: PatternParams; persistence?: Persistence }) =>
    request<AccessPatterns["registered"][number]>(`/${id}/access-patterns`, { method: "POST", json: body }),
  updatePattern: (id: string, name: string, body: { params?: PatternParams; persistence?: Persistence }) =>
    request<AccessPatterns>(`/${id}/access-patterns/${encodeURIComponent(name)}`, { method: "PUT", json: body }),
  removePattern: (id: string, name: string) => request<{ deleted: string; outputs_dropped: number }>(`/${id}/access-patterns/${encodeURIComponent(name)}`, { method: "DELETE" }),
};

export const SCHEMA_ICON: Record<MediaSchema, string> = {
  audio: "wave",
  dicom: "eye",
  document: "doc",
  email: "comment",
  image: "image",
  spreadsheet: "table",
  video: "play",
  multimodal: "layers",
};

export const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
