/** Data Lineage (api/lineage.py): the graph of sources, datasets, transforms and the apps that use them. */
import { API_URL } from "./api";
import type { IconName } from "@/components/Icon";

export type LineageKind =
  | "connection"
  | "datasource"
  | "dataset"
  | "manual"
  | "virtual"
  | "stream"
  | "pipeline"
  | "transform"
  | "notebook"
  | "studio"
  | "preparation"
  | "sql"
  | "object_type"
  | "logic"
  | "automation"
  | "agent"
  | "module"
  | "action"
  | "function"
  | "model"
  | "vertex"
  | "map"
  | "osdk_app"
  | "ts_sync"
  | "machinery"
  | "restricted_view"
  | "reference";

export type Producer = { kind: "pipeline" | "transform" | "preparation" | "sql"; id: string; name: string; at?: string; rows?: number; commit?: string; output?: string; status?: string };
export type NodeSchedule = { name: string; enabled: boolean; cron?: string | null; on_data_update?: boolean; id?: string };
export type HealthResult = { status: "passing" | "failing"; results: { id?: string; kind: string; ok: boolean; message: string }[] };
export type LineageNode = {
  id: string;
  kind: LineageKind;
  kind_label: string;
  name: string;
  subtitle?: string;
  /** a dataset that backs (defines) object types */
  defines_object_types?: string[];
  path?: string[];
  project?: string;
  folder?: string;
  updated_at?: string;
  size?: number;
  status?: string;
  link?: string;
  /** an OSDK application's Developer Console page, when `link` opens the running app */
  console?: string;
  item_id?: string;
  missing?: boolean;
  stale?: string;
  updated_via?: { kind: string; id: string; name: string };
  producers?: Producer[];
  schedules?: NodeSchedule[];
  schedule?: string;
  schedule_count?: number;
  next_run_at?: string;
  last_build?: { status: string; at?: string; error?: string | null };
  rows?: number;
  columns?: string[];
  transactions?: number;
  health?: HealthResult;
  buildable?: boolean;
  repo_id?: string;
  transform?: string;
  branch?: string;
  /** references (papers): full title, authors, DOI, licence and how the method is used */
  title?: string;
  authors?: string;
  doi?: string;
  note?: string;
  license?: string;
  /** object types: the Nexus type's own icon, colour and primary key */
  icon?: string;
  type_color?: string;
  primary_key?: string;
  object_count?: number;
  /** models: the Code Repositories file and function that trained the latest version */
  /** where the latest version was trained: a repository file, a Jupyter notebook or a Model Studio run (`app`) */
  training?: { repo_id?: string; repo?: string; path: string; function: string; branch?: string; commit?: string; at: string; version?: string; transform: string; link: string; app?: string };
};
export type LineageEdge = { from: string; to: string; label: string };
/** a Nexus link type between two object types — a relation, not data flow (never walked as lineage) */
export type LineageRelation = {
  id: string;
  from: string;
  to: string;
  name: string;
  kind?: string;
  cardinality: "one_to_one" | "many_to_one" | "many_to_many" | string;
  source_label?: string;
  target_label?: string;
  foreign_key?: string | null;
};
export type LineageGraph = { nodes: LineageNode[]; edges: LineageEdge[]; relations?: LineageRelation[]; kinds: Record<string, string>; hidden_tests?: number };
/** "N : 1" from the source's side: many sources point at one target */
export const CARDINALITY: Record<string, string> = { one_to_one: "1 : 1", many_to_one: "N : 1", one_to_many: "1 : N", many_to_many: "M : N" };
/** one side of a relation: objects with at least one link; total = all of them (observed) or a required foreign key */
export type ParticipationSide = { linked: number; objects: number; total: boolean; required: boolean; pct: number | null };
export type Participation = { source: ParticipationSide; target: ParticipationSide; links: number };
/** ERD (Chen) marks at the [source, target] ends of a relation: N : 1 → "N" beside the source, "1" beside the target */
export const ERD_ENDS: Record<string, [string, string]> = { one_to_one: ["1", "1"], many_to_one: ["N", "1"], one_to_many: ["1", "N"], many_to_many: ["M", "N"] };
export type Transaction = {
  id: string;
  at: string;
  kind: "build" | "deploy" | "rollback" | "aborted";
  rows: number | null;
  columns: string[];
  size: number;
  source: { kind: string; id?: string; name?: string; commit?: string | null; branch?: string; to?: string; to_at?: string; mode?: string; transaction?: string; reason?: string };
  kept: boolean;
  rolled_back?: boolean;
  /** a job that succeeded without committing (abort(), abort_job(), an aborted empty write): no data */
  aborted?: boolean;
};
export type LineageDetail = LineageNode & {
  inputs: (LineageNode & { via: string })[];
  outputs: (LineageNode & { via: string })[];
  events: { at?: string; kind: string; status?: string; text: string }[];
  rows?: number;
  columns?: string[] | { name: string; type: string }[];
  created_at?: string;
  shares?: { expires_at?: string; created_at?: string }[];
  read_error?: string;
  transactions_list?: Transaction[];
};
export type CodeView =
  | { kind: "python"; repo_id: string; repo: string; path: string; function: string; content: string; line: number | null; commit: string | null; link: string }
  | { kind: "pipeline"; name: string; steps: { name: string; kind: string; description?: string }[]; outputs: string[]; link: string }
  | { kind: "none"; message: string };
export type BuildStep = { producer: string; kind: "pipeline" | "transform" | "preparation" | "sql"; name: string; datasets: string[]; outputs: string[]; reason?: string; status?: string; error?: string | null };
export type BuildJob = { id: string; status: string; created_at: string; strategy: string; steps: BuildStep[]; finished_at?: string };
export type TimelineEntry = { label: string; kind: string; node: string; start: string; end: string | null; status: string; trigger?: string };
export type HealthRule = {
  id?: string;
  kind: "freshness" | "time_since_updated" | "data_freshness" | "row_count" | "columns" | "schema" | "build_status" | "up_to_date";
  enabled?: boolean;
  hours?: number;
  min?: number;
  max?: number;
  required?: string[];
  /** time since last updated: builds that wrote no rows do not count */
  ignore_empty?: boolean;
  /** data freshness: the timestamp column whose newest value must be within `hours` */
  column?: string;
  /** schema check: exact match, or the columns with additions allowed */
  mode?: "additions" | "exact";
  columns?: { name: string; type: string }[];
};
/** accounts: the accounts this graph is about (View as and Compare list only these, "All accounts" shows the rest) */
export type GraphPermissions = { view_as?: string; compare?: string[]; type?: "read" | "discover"; accounts?: string[] };
export type SavedGraph = {
  id: string;
  name: string;
  nodes: string[];
  colors: Record<string, string>;
  color_by: string;
  /** Permissions colouring: the account viewed as and the accounts compared on each node */
  permissions?: GraphPermissions;
  /** nodes placed by hand (dragged on the canvas) */
  positions?: Record<string, { x: number; y: number }>;
  /** a test / bug-hunting graph (named with "test"): listed apart, opened with test items shown */
  test?: boolean;
  created_at: string;
  updated_at: string;
};

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/lineage" + path, {
    cache: "no-store",
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
const enc = encodeURIComponent;

export const lineage = {
  /** tests: include test and bug-hunting items (left out by default, counted in hidden_tests) */
  graph: (tests = false) => request<LineageGraph>(`/graph${tests ? "?tests=true" : ""}`),
  /** ERD participation of the relations on the canvas (only those whose two object types the caller may see) */
  participation: (ids: string[]) => request<Record<string, Participation>>("/relations/participation", { method: "POST", json: { ids } }),
  permissions: (body: { user_id: string; type: "read" | "discover"; nodes: { id: string; kind: string; item_id?: string; repo_id?: string; size?: number; missing?: boolean }[] }) =>
    request<Permissions>("/permissions", { method: "POST", json: body }),
  node: (id: string) => request<LineageDetail>(`/node?id=${enc(id)}`),
  preview: (id: string, limit = 300) =>
    request<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total_rows: number }>(`/preview?id=${enc(id)}&limit=${limit}`),
  code: (id: string) => request<CodeView>(`/code?id=${enc(id)}`),
  transactions: (id: string) => request<Transaction[]>(`/transactions?id=${enc(id)}`),
  diff: (id: string, a: string, b: string) => request<DatasetDiff>(`/diff?id=${enc(id)}&a=${enc(a)}&b=${enc(b)}`),
  rollback: (id: string, transaction: string) => request<{ history: Transaction[] }>("/rollback", { method: "POST", json: { id, transaction } }),
  healthRules: (itemId: string) => request<HealthRule[]>(`/health?item_id=${enc(itemId)}`),
  saveHealthRules: (itemId: string, rules: HealthRule[]) => request<HealthRule[]>("/health", { method: "PUT", json: { item_id: itemId, rules } }),
  buildPlan: (ids: string[], strategy: string, force: boolean) => request<{ steps: BuildStep[]; skipped: string[] }>("/builds/plan", { method: "POST", json: { ids, strategy, force } }),
  buildRun: (ids: string[], strategy: string, force: boolean) => request<BuildJob>("/builds/run", { method: "POST", json: { ids, strategy, force } }),
  buildJob: (id: string) => request<BuildJob>(`/builds/jobs/${id}`),
  timeline: (hours: number) => request<TimelineEntry[]>(`/timeline?hours=${hours}`),
  graphs: () => request<SavedGraph[]>("/graphs"),
  savedGraph: (id: string) => request<SavedGraph>(`/graphs/${id}`),
  saveGraph: (
    body: { name: string; nodes: string[]; colors: Record<string, string>; color_by: string; permissions?: GraphPermissions; positions?: Record<string, { x: number; y: number }> },
    id?: string,
  ) =>
    request<SavedGraph>(`/graphs${id ? `?id=${id}` : ""}`, { method: "POST", json: body }),
  deleteGraph: (id: string) => request<unknown>(`/graphs/${id}`, { method: "DELETE" }),
};

/** Three families, one validated categorical slot each (all pairs pass on the dark surface); every node
 * also prints its kind and icon, so the finer type never rests on colour alone. */
export const FAMILIES: { id: string; label: string; color: string; kinds: LineageKind[] }[] = [
  { id: "data", label: "Data (sources & datasets)", color: "#3987e5", kinds: ["connection", "datasource", "virtual", "stream", "manual", "dataset", "ts_sync", "restricted_view"] },
  { id: "transform", label: "Pipelines & code transforms", color: "#d95926", kinds: ["pipeline", "transform", "notebook", "studio", "preparation", "sql"] },
  { id: "ontology", label: "Nexus & actions", color: "#199e70", kinds: ["object_type", "action", "logic", "automation", "agent"] },
  { id: "ml", label: "Models & functions", color: "#9b5de5", kinds: ["model", "function"] },
  { id: "apps", label: "Apps", color: "#c88a12", kinds: ["module", "vertex", "map", "machinery", "osdk_app"] },
  { id: "reference", label: "References & papers", color: "#64748b", kinds: ["reference"] },
];
export const familyOf = (k: LineageKind) => FAMILIES.find((f) => f.kinds.includes(k))!;

export const KIND_ICON: Record<LineageKind, IconName> = {
  connection: "plug",
  datasource: "database",
  dataset: "table",
  manual: "edit",
  virtual: "eye",
  stream: "wave",
  pipeline: "pipeline",
  transform: "code",
  notebook: "doc",
  studio: "cpu",
  preparation: "transform",
  sql: "code",
  object_type: "cube",
  logic: "logic",
  automation: "bolt",
  agent: "sparkle",
  module: "device",
  action: "play",
  function: "code",
  model: "cpu",
  vertex: "graph",
  map: "globe",
  osdk_app: "keyboard",
  ts_sync: "wave",
  machinery: "gauge",
  restricted_view: "lock",
  reference: "doc",
};

/** The app each kind of node lives in — "Open in …" on every node, so everything on the graph is traceable to its source. */
export const ROOT_APP: Record<LineageKind, { app: string; icon: IconName }> = {
  connection: { app: "Data Sources", icon: "plug" },
  datasource: { app: "Data Sources", icon: "plug" },
  dataset: { app: "Dataset preview", icon: "table" },
  manual: { app: "Pipeline Builder", icon: "pipeline" },
  virtual: { app: "Data Sources", icon: "plug" },
  stream: { app: "Streaming", icon: "wave" },
  pipeline: { app: "Pipeline Builder", icon: "pipeline" },
  transform: { app: "Code Repositories", icon: "code" },
  notebook: { app: "Code Workspaces (Jupyter)", icon: "doc" },
  studio: { app: "Model Studio", icon: "cpu" },
  preparation: { app: "Data Preparation", icon: "transform" },
  sql: { app: "SQL", icon: "code" },
  object_type: { app: "Nexus Manager", icon: "cube" },
  logic: { app: "AIP Logic", icon: "logic" },
  automation: { app: "Automate", icon: "bolt" },
  agent: { app: "AIP Agent Studio", icon: "sparkle" },
  module: { app: "Workshop", icon: "device" },
  action: { app: "Nexus Manager", icon: "play" },
  function: { app: "Functions", icon: "code" },
  model: { app: "Model Assets", icon: "cpu" },
  vertex: { app: "Vertex", icon: "graph" },
  map: { app: "Map", icon: "globe" },
  osdk_app: { app: "the application", icon: "keyboard" },
  ts_sync: { app: "Time Series", icon: "wave" },
  machinery: { app: "Machinery", icon: "gauge" },
  restricted_view: { app: "Restricted Views", icon: "lock" },
  reference: { app: "the publisher (DOI)", icon: "doc" },
};

/** Node color options → Permissions, viewed as one account (POST /api/lineage/permissions). */
export type PermissionStatus = "view" | "no_access" | "no_data" | "unknown";
export type Permissions = {
  user: { id: string; name: string | null };
  type: "read" | "discover";
  nodes: Record<string, { status: PermissionStatus; detail: string }>;
  counts: Record<PermissionStatus, number>;
};

/** Two transactions of a dataset compared: schema changes, row counts and a sample of rows only in one of them. */
export type DatasetDiff = {
  a: string;
  b: string;
  rows_a: number;
  rows_b: number;
  schema: { column: string; change: "added" | "removed" | "type"; type?: string; from?: string; to?: string }[];
  compared_columns: string[];
  added: number;
  removed: number;
  added_rows: Record<string, unknown>[];
  removed_rows: Record<string, unknown>[];
};
