import { API_URL, type DriveItem } from "./api";

/** Extraction and Knowledge Graph tabs (api/knowledge.py). */

export type KgModel = {
  id: string;
  label: string;
  vendor: string;
  description: string;
  cost: "low" | "medium" | "high";
  /** false while its API key is missing from .env.local */
  available: boolean;
  default: boolean;
};

export type KgStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type KgStats = { nodes: number; links: number; classes: number; properties: number };

export type Extraction = {
  id: string;
  name: string;
  title?: string;
  source: { type: "job" | "drive"; id: string; name: string };
  model: string;
  model_label: string;
  instructions: string | null;
  schema_from: string | null;
  dedupe: boolean;
  status: KgStatus;
  stage: "queued" | "reading" | "converting" | "schema" | "extracting" | "merging" | "deduplicating" | "stopping" | "done" | "failed" | "cancelled";
  windows_total: number;
  windows_done: number;
  windows_failed: number;
  schema_summary?: { classes: number; properties: number };
  /** how the source became the Markdown the model reads, e.g. "Parse result JSON → Markdown" */
  source_format?: string;
  markdown_chars?: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  stats: KgStats | null;
};

export type KnowledgeGraph = {
  id: string;
  name: string;
  description: string | null;
  extraction_ids: string[];
  resolve_model: string | null;
  status: KgStatus;
  stage: string;
  /** AI de-duplication progress: [batches done, batches] */
  progress?: [number, number] | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  stats: KgStats | null;
};

export type KgKind = { label: string; color: string; group: string; description: string; count: number };
export type KgPredicate = {
  label: string;
  color: string;
  desc: string;
  domain: string;
  range: string;
  count: number;
};
export type KgClass = { id: string; label: string; parent: string; description: string };
export type KgProperty = { id: string; label: string; domain: string; range: string; description: string };

export type KgNode = {
  id: string;
  kind: string;
  label: string;
  definition: string;
  aliases: string[];
  facts: [string, string][];
  pages: number[];
  mentions: number;
  /** extraction ids the node was merged from (knowledge graphs only) */
  sources?: string[];
  degree: number;
};

export type KgEvidence = { quote: string; page: number | null; from?: string };

export type KgLink = {
  source: string;
  target: string;
  predicate: string;
  evidence: KgEvidence[];
  count: number;
};

export type KgGraph = {
  meta: {
    kind: "extraction" | "graph";
    id: string;
    name: string;
    title: string;
    domain: string;
    model?: string;
    modelLabel?: string;
    source?: { type: string; id: string; name: string };
    extractions?: { id: string; name: string; title: string }[];
    generatedAt: string;
  };
  kinds: Record<string, KgKind>;
  predicates: Record<string, KgPredicate>;
  classes: KgClass[];
  properties: KgProperty[];
  nodes: KgNode[];
  links: KgLink[];
  stats: KgStats;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : message;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export type NewExtraction = {
  source: { type: "job" | "drive"; id: string };
  model: string;
  name?: string;
  instructions?: string;
  schema_from?: string | null;
  dedupe: boolean;
};

export const kg = {
  models: () => request<KgModel[]>("/api/kg/models"),
  extractions: () => request<Extraction[]>("/api/kg/extractions"),
  extraction: (id: string) => request<Extraction>(`/api/kg/extractions/${id}`),
  extractionGraph: (id: string) => request<KgGraph>(`/api/kg/extractions/${id}/graph`),
  createExtraction: (body: NewExtraction) => request<Extraction>("/api/kg/extractions", send("POST", body)),
  renameExtraction: (id: string, name: string) =>
    request<Extraction>(`/api/kg/extractions/${id}`, send("PATCH", { name })),
  stopExtraction: (id: string) => request<Extraction>(`/api/kg/extractions/${id}/stop`, send("POST")),
  continueExtraction: (id: string) => request<Extraction>(`/api/kg/extractions/${id}/continue`, send("POST")),
  rerunExtraction: (id: string) => request<Extraction>(`/api/kg/extractions/${id}/rerun`, send("POST")),
  deleteExtraction: (id: string) => request<{ deleted: string }>(`/api/kg/extractions/${id}`, send("DELETE")),
  /** copy a finished extraction's graph into a Files folder (null = top level) */
  saveExtractionToFiles: (id: string, formats: ("json" | "ttl")[], parentId: string | null) =>
    request<DriveItem[]>(`/api/kg/extractions/${id}/save-to-files`, send("POST", { formats, parent_id: parentId })),

  graphs: () => request<KnowledgeGraph[]>("/api/kg/graphs"),
  graph: (id: string) => request<KnowledgeGraph>(`/api/kg/graphs/${id}`),
  graphData: (id: string) => request<KgGraph>(`/api/kg/graphs/${id}/graph`),
  createGraph: (body: { name: string; extraction_ids: string[]; resolve_model: string | null; description?: string }) =>
    request<KnowledgeGraph>("/api/kg/graphs", send("POST", body)),
  updateGraph: (
    id: string,
    change: { name?: string; extraction_ids?: string[]; resolve_model?: string | null; description?: string },
  ) => request<KnowledgeGraph>(`/api/kg/graphs/${id}`, send("PATCH", change)),
  stopGraph: (id: string) => request<KnowledgeGraph>(`/api/kg/graphs/${id}/stop`, send("POST")),
  continueGraph: (id: string) => request<KnowledgeGraph>(`/api/kg/graphs/${id}/continue`, send("POST")),
  rebuildGraph: (id: string) => request<KnowledgeGraph>(`/api/kg/graphs/${id}/rebuild`, send("POST")),
  deleteGraph: (id: string) => request<{ deleted: string }>(`/api/kg/graphs/${id}`, send("DELETE")),
};

/** LLM tokens and cost per extraction / knowledge graph (web/src/app/api/kg-usage/route.ts). */
export type KgUsage = { calls: number; input_tokens: number; output_tokens: number; cost_usd: number };

export async function kgUsage(): Promise<{ extractions: Record<string, KgUsage>; graphs: Record<string, KgUsage> }> {
  const res = await fetch("/api/kg-usage", { cache: "no-store" });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export const usd = (v: number) => `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(v < 10 ? 3 : 2)}`;
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString());

/** The Markdown an extraction's model read (its source after conversion). */
export const kgMarkdownUrl = (id: string, download = false) =>
  `${API_URL}/api/kg/extractions/${id}/markdown${download ? "?download=true" : ""}`;

export const kgDownloadUrl = (what: "extractions" | "graphs", id: string, format: "json" | "ttl") =>
  `${API_URL}/api/kg/${what}/${id}/graph?format=${format}&download=true`;

export const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  reading: "Reading the document",
  converting: "Converting to Markdown",
  schema: "Designing the ontology",
  extracting: "Extracting entities and relations",
  merging: "Merging",
  deduplicating: "AI de-duplication",
  done: "Done",
  stopping: "Stopping",
  failed: "Failed",
  cancelled: "Stopped",
};

/** Share of the work done, 0-1, for a progress bar. */
export function extractionProgress(e: Extraction): number {
  if (e.status === "completed") return 1;
  if (e.stage === "extracting" && e.windows_total) return 0.1 + 0.8 * (e.windows_done / e.windows_total);
  return { queued: 0, reading: 0.02, converting: 0.04, schema: 0.06, merging: 0.9, deduplicating: 0.94 }[e.stage as string] ?? 0;
}
