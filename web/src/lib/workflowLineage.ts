/** Workflow Lineage (api/workflow_lineage.py): the graph of resources behind applications. */
import { API_URL } from "./api";

export type WKind = "object_type" | "interface" | "action_type" | "function" | "logic" | "automation" | "workshop" | "slate" | "widget_set" | "osdk_app" | "vertex" | "notepad" | "machinery" | "language_model";
export type WNode = {
  key: string;
  kind: WKind;
  id: string;
  name: string;
  api_name?: string | null;
  status?: string | null;
  updated_at?: string | null;
  item_id?: string | null;
  rule?: string;
  failure_rate?: number | null;
  runs_30d?: number;
  failed_30d?: number;
  firing?: number;
  monitors?: number;
  out_of_date?: boolean;
  views_4w?: number;
  users_4w?: number;
  requests?: number;
  tokens?: number;
  expires_at?: string | null;
  enabled?: boolean;
  ontology_id?: string;
  properties?: string[];
  property_names?: string[];
  [k: string]: unknown;
};
export type WEdge = { from: string; to: string; kind: string; name?: string; version?: string; latest?: string; out_of_date?: boolean; cardinality?: string };
export type Index = { nodes: WNode[]; edges: WEdge[]; kinds: Record<WKind, string> };
export type Placed = { key: string; x: number; y: number; color?: string | null };
export type TextNode = { id: string; x: number; y: number; w: number; h: number; text: string; color?: string | null };
export type Frame = { id: string; name: string; state: { nodes: Placed[]; texts: TextNode[]; color_mode: string; view: { x: number; y: number; k: number } } };
export type GraphState = { nodes: Placed[]; texts: TextNode[]; color_mode: string; frames: Frame[]; groups: { id: string; name: string; color: string }[]; node_width?: number };
export type SavedGraph = { id: string; name: string; item_id: string; state: GraphState; can_edit: boolean; updated_at: string };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/workflow-lineage" + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export type Details = {
  node: WNode;
  href: string | null;
  upstream: { key: string; name: string; kind: string }[];
  downstream: { key: string; name: string; kind: string }[];
  properties?: { api_name: string; display_name: string; type: string; usages: { kind: string; id: string; name: string; how: string }[] }[];
  links?: { name: string; other: string; key: string; cardinality: string }[];
  backing_dataset?: string | null;
  preview?: Record<string, unknown>[];
  security?: { markings: string[]; policies: number };
  action?: { api_name: string; kind: string; parameters: { id: string; display_name: string; type: string; property?: string | null }[]; rules?: { kind: string; function_id?: string; version?: string }[]; submission_criteria?: unknown[]; status?: string };
  recent_runs?: { at: string; status: string; error?: string | null; user?: string; trigger?: string; primary_key?: string }[];
  function_code?: { language: string; code: string | null; file?: string } | null;
  function?: Record<string, unknown>;
  code?: { language: string; code: string | null; file?: string } | null;
  usages?: { kind: string; id: string; name: string; version?: string }[];
  metrics?: { succeeded: number; failed: number; p95_ms: number | null };
  logic?: { inputs: unknown[]; blocks: { name: string; type: string; model?: string }[]; description?: string };
  automation?: { condition: Record<string, unknown>; effect: Record<string, unknown>; enabled: boolean; description?: string };
  condition_properties?: string[];
  widgets?: { id: string; type: string; title: string; x: number; y: number; w: number; h: number; uses: string[] }[];
  entities?: { key: string; name: string; widgets: { widget: string; type: string; title: string }[] }[];
  usage?: { attempted: number; succeeded: number; rate_limited: number; tokens: number };
  interface?: { properties: { api_name: string; type: string }[]; implemented_by: { object_type_id: string; display_name: string }[] };
};

export const wl = {
  index: (fresh = false) => req<Index>(`/index${fresh ? "?fresh=true" : ""}`),
  search: (q: string) => req<(WNode & { match: string })[]>(`/search?q=${encodeURIComponent(q)}`),
  folder: (id: string) => req<string[]>(`/folder/${id}`),
  node: (key: string) => req<Details>(`/node?key=${encodeURIComponent(key)}`),
  organization: (keys: string[]) => req<Record<string, { project: string; folder: string; project_id: string; folder_id: string }>>("/organization", { method: "POST", json: { keys } }),
  permissions: (keys: string[], user_id: string) => req<Record<string, { resource?: string; view_definition?: boolean; edit_definition?: boolean; view_data?: boolean; execute?: boolean }>>("/permissions", { method: "POST", json: { keys, user_id } }),
  users: () => req<{ id: string; name: string; username: string }[]>("/users"),
  debug: (action_id: string, user_id: string) =>
    req<{ user: string; can_submit: boolean; checks: { name: string; ok: boolean; detail?: string }[]; criteria: { message: string; result: string; ok: boolean | null }[] }>("/debug-action", { method: "POST", json: { action_id, user_id } }),
  copyCriteria: (source: string, targets: string[]) => req<{ updated: string[]; failed: { id: string; error: string }[] }>("/bulk/submission-criteria", { method: "POST", json: { source, targets } }),
  upgrades: (keys: string[]) => req<{ resource: string; function: string; from: string; to: string; status: "upgradable" | "breaking" | "error"; breaking: string[] }[]>("/upgrades", { method: "POST", json: { keys } }),
  applyUpgrades: (items: unknown[], mode: "partial" | "all_or_nothing") => req<{ upgraded: string[]; skipped: string[]; reason?: string }>("/upgrades/apply", { method: "POST", json: { items, mode } }),
  replaceModel: (source: string, target: string, logic_ids: string[]) => req<{ replaced: string[]; skipped: { id: string; reason: string }[] }>("/bulk/replace-model", { method: "POST", json: { source, target, logic_ids } }),
  move: (keys: string[], folder_id?: string, dry_run = true) =>
    req<{ move?: { key: string; name: string }[]; moved?: string[]; skipped: { key: string; name?: string; reason: string }[] }>("/bulk/move", { method: "POST", json: { keys, folder_id, dry_run } }),
  publishWorkshop: (module_ids: string[], dry_run = true) =>
    req<{ publish?: { id: string; name: string; from: number | null; to: number }[]; published?: { id: string; name: string; from: number | null; to: number }[]; skipped: { id: string; name?: string; reason: string }[] }>(
      "/bulk/publish-workshop", { method: "POST", json: { module_ids, dry_run } }),
  weekly: (ids: string[]) => req<Record<string, { week_start: string; total: number; unique: number }[]>>(`/usage/workshop?ids=${ids.join(",")}`),
  modelUsage: () => req<Record<string, { attempted: number; succeeded: number; rate_limited: number; tokens: number; by_day: { day: string; attempted: number; tokens: number }[] }>>("/usage/models"),
  graphs: () => req<{ id: string; name: string; nodes: number; frames: number; updated_at: string }[]>("/graphs"),
  graph: (id: string) => req<SavedGraph>(`/graphs/${id}`),
  createGraph: (name: string, folder_id: string, state: GraphState) => req<SavedGraph>("/graphs", { method: "POST", json: { name, folder_id, state } }),
  saveGraph: (id: string, state: GraphState) => req<SavedGraph>(`/graphs/${id}`, { method: "PUT", json: { state } }),
  removeGraph: (id: string) => req<unknown>(`/graphs/${id}`, { method: "DELETE" }),
};

export const KIND_COLOR: Record<WKind, string> = {
  object_type: "#22c55e",
  interface: "#14b8a6",
  action_type: "#f59e0b",
  function: "#3b82f6",
  logic: "#a855f7",
  automation: "#8b5cf6",
  workshop: "#ec4899",
  slate: "#f43f5e",
  widget_set: "#06b6d4",
  osdk_app: "#64748b",
  vertex: "#0ea5e9",
  notepad: "#d97706",
  machinery: "#84cc16",
  language_model: "#eab308",
};
export const KIND_ICON: Record<WKind, string> = {
  object_type: "cube",
  interface: "layers",
  action_type: "edit",
  function: "code",
  logic: "logic",
  automation: "bolt",
  workshop: "device",
  slate: "palette",
  widget_set: "grid",
  osdk_app: "keyboard",
  vertex: "graph",
  notepad: "doc",
  machinery: "pipeline",
  language_model: "sparkle",
};

export const COLOR_MODES: { id: string; name: string; group: string }[] = [
  { id: "node_type", name: "Node type", group: "General" },
  { id: "custom", name: "Custom color", group: "General" },
  { id: "permissions_ontology", name: "Nexus permissions", group: "Permissions" },
  { id: "permissions_resource", name: "Resource permissions", group: "Permissions" },
  { id: "failure_rate", name: "Failure rate", group: "Health" },
  { id: "monitoring", name: "Monitoring status", group: "Health" },
  { id: "usage", name: "Application views", group: "Usage" },
  { id: "model_usage", name: "Model usage", group: "Usage" },
  { id: "out_of_date", name: "Out of date functions", group: "Usage" },
  { id: "ontology_status", name: "Nexus status", group: "Usage" },
  { id: "action_rule", name: "Action rule", group: "Usage" },
  { id: "automation_expiration", name: "Automation expiration", group: "Usage" },
  { id: "last_modified", name: "Last modified", group: "Usage" },
  { id: "project", name: "Project", group: "Organization" },
  { id: "folder", name: "Folder", group: "Organization" },
];
const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#a855f7", "#06b6d4", "#ef4444", "#84cc16", "#f97316", "#14b8a6"];
const GRAY = "#475569";

/** The header color and legend label of a node in a color mode. */
export function colorFor(
  n: WNode,
  mode: string,
  extra: { org?: Record<string, { project: string; folder: string }>; perms?: Record<string, { resource?: string; view_definition?: boolean; edit_definition?: boolean; view_data?: boolean; execute?: boolean }>; custom?: string | null; maxViews?: number; maxTokens?: number },
): { color: string; label: string } {
  const days = n.updated_at ? (Date.now() - new Date(n.updated_at).getTime()) / 86400000 : null;
  switch (mode) {
    case "custom":
      return extra.custom ? { color: extra.custom, label: "Custom" } : { color: GRAY, label: "No color" };
    case "ontology_status": {
      const c: Record<string, string> = { active: "#22c55e", experimental: "#f59e0b", deprecated: "#ef4444", example: "#06b6d4", promoted: "#a855f7" };
      return n.status ? { color: c[n.status] ?? GRAY, label: n.status } : { color: GRAY, label: "No status" };
    }
    case "action_rule": {
      const c: Record<string, string> = { function: "#3b82f6", create: "#22c55e", modify: "#f59e0b", delete: "#ef4444", combination: "#a855f7", other: "#64748b" };
      return n.kind === "action_type" ? { color: c[n.rule ?? "other"] ?? GRAY, label: n.rule ?? "other" } : { color: GRAY, label: "Not an action" };
    }
    case "failure_rate": {
      if (!["action_type", "function", "logic", "automation"].includes(n.kind)) return { color: GRAY, label: "No runs tracked" };
      const r = n.failure_rate;
      if (r === null || r === undefined) return { color: "#64748b", label: "No runs in 30 days" };
      return r === 0 ? { color: "#22c55e", label: "0%" } : r < 0.1 ? { color: "#eab308", label: "< 10%" } : r < 0.5 ? { color: "#f97316", label: "10–50%" } : { color: "#ef4444", label: "≥ 50%" };
    }
    case "monitoring":
      if (n.kind !== "action_type") return { color: GRAY, label: "Not monitorable here" };
      return n.firing ? { color: "#ef4444", label: "Firing" } : n.monitors ? { color: "#22c55e", label: "Healthy" } : { color: "#94a3b8", label: "Eligible, no monitors" };
    case "usage": {
      if (n.kind !== "workshop") return { color: GRAY, label: "Not an application" };
      const v = n.views_4w ?? 0;
      const t = v / Math.max(1, extra.maxViews ?? 1);
      return v === 0 ? { color: "#334155", label: "No views" } : t < 0.34 ? { color: "#1d4ed8", label: "Low" } : t < 0.67 ? { color: "#2563eb", label: "Medium" } : { color: "#60a5fa", label: "High" };
    }
    case "model_usage": {
      if (n.kind !== "language_model") return { color: GRAY, label: "Not a model" };
      const t = n.tokens ?? 0;
      return !n.requests ? { color: "#334155", label: "No requests" } : t / Math.max(1, extra.maxTokens ?? 1) < 0.5 ? { color: "#ca8a04", label: "Some tokens" } : { color: "#fde047", label: "Most tokens" };
    }
    case "out_of_date":
      return n.out_of_date ? { color: "#ef4444", label: "Out of date" } : ["action_type", "automation", "workshop"].includes(n.kind) ? { color: "#22c55e", label: "Up to date" } : { color: GRAY, label: "No functions" };
    case "automation_expiration": {
      if (n.kind !== "automation") return { color: GRAY, label: "Not an automation" };
      if (!n.expires_at) return { color: "#22c55e", label: "No expiration" };
      const left = (new Date(n.expires_at).getTime() - Date.now()) / 86400000;
      return left < 0 ? { color: "#ef4444", label: "Expired" } : left < 30 ? { color: "#f59e0b", label: "< 30 days" } : { color: "#22c55e", label: "> 30 days" };
    }
    case "last_modified":
      if (days === null) return { color: GRAY, label: "Unknown" };
      return days < 1 ? { color: "#22c55e", label: "Past day" } : days < 7 ? { color: "#84cc16", label: "Past week" } : days < 31 ? { color: "#eab308", label: "Past month" } : days < 366 ? { color: "#f97316", label: "Past year" } : { color: "#ef4444", label: "Older" };
    case "project":
    case "folder": {
      const o = extra.org?.[n.key];
      if (!o) return { color: GRAY, label: "Not in Files" };
      const name = mode === "project" ? o.project : o.folder;
      return { color: PALETTE[hash(name) % PALETTE.length], label: name };
    }
    case "permissions_ontology": {
      const p = extra.perms?.[n.key];
      if (!p || (p.view_definition === undefined && p.execute === undefined)) return { color: GRAY, label: "No ontology permissions" };
      if (n.kind === "action_type") return p.execute ? { color: "#22c55e", label: "Can execute" } : p.view_definition ? { color: "#f59e0b", label: "Can view, cannot execute" } : { color: "#ef4444", label: "No access" };
      return p.edit_definition ? { color: "#22c55e", label: "Can edit definition" } : p.view_data ? { color: "#3b82f6", label: "Can view data" } : { color: "#ef4444", label: "No access" };
    }
    case "permissions_resource": {
      const p = extra.perms?.[n.key];
      if (!p?.resource) return { color: GRAY, label: "Not a Files resource" };
      const c: Record<string, string> = { owner: "#22c55e", editor: "#3b82f6", viewer: "#eab308", none: "#ef4444" };
      return { color: c[p.resource] ?? GRAY, label: p.resource === "none" ? "No access" : p.resource };
    }
    default:
      return { color: KIND_COLOR[n.kind] ?? GRAY, label: n.kind };
  }
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Layouts: left-to-right layers (L), vertical layers (V), grid (G), horizontal row (H). */
export function layoutNodes(placed: Placed[], edges: WEdge[], mode: "layers" | "vertical" | "grid" | "horizontal", width: number): Placed[] {
  const keys = new Set(placed.map((p) => p.key));
  const flow = edges.filter((e) => e.kind !== "link" && keys.has(e.from) && keys.has(e.to));
  if (mode === "grid") {
    const cols = Math.ceil(Math.sqrt(placed.length));
    return placed.map((p, i) => ({ ...p, x: (i % cols) * (width + 60), y: Math.floor(i / cols) * 110 }));
  }
  if (mode === "horizontal") return placed.map((p, i) => ({ ...p, x: i * (width + 50), y: 0 }));
  const depth: Record<string, number> = {};
  const inc: Record<string, string[]> = Object.fromEntries(placed.map((p) => [p.key, []]));
  for (const e of flow) inc[e.to].push(e.from);
  const d = (k: string, seen: Set<string>): number => {
    if (k in depth) return depth[k];
    if (seen.has(k)) return 0;
    seen.add(k);
    return (depth[k] = Math.max(0, ...inc[k].map((p) => d(p, seen) + 1)));
  };
  const rows: Record<number, number> = {};
  return [...placed]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => {
      const l = d(p.key, new Set());
      const r = (rows[l] = (rows[l] ?? -1) + 1);
      return mode === "vertical" ? { ...p, x: r * (width + 50), y: l * 140 } : { ...p, x: l * (width + 90), y: r * 96 };
    });
}
