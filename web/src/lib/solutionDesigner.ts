/** Solution Designer (api/solution_designer.py): architecture diagrams, reference library, AIP Architect and AIP Critic. */
import { API_URL } from "./api";
import type { IconName } from "@/components/Icon";

export type ResourceRef = { kind: "file" | "object_type" | "interface" | "action_type"; id: string; name: string };
export type NodeKind = "component" | "resource" | "concept" | "object" | "group" | "text";
export type SDNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  title: string;
  description?: string;
  tags?: string[];
  color?: string | null;
  icon?: IconName | null;
  icon_color?: string | null;
  parent?: string | null;
  z?: number;
  component?: string | null;
  resource?: ResourceRef | null;
  concept?: string | null;
  proposed?: { primary_key?: string; title_property?: string; properties: { name: string; dataType: string; description?: string }[] } | null;
  href?: string | null;
  lineage_id?: string;
  doc_minimized?: boolean;
};
export type SDEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  /** a link type AIP Architect proposed (Generate data model) */
  proposed?: { name: string; cardinality: "one-to-many" | "many-to-many" | "one-to-one" } | null;
  /** the Ontology link type created from the proposal */
  link_type?: { id: string; name: string } | null;
};
export type Settings = { edge_labels: boolean; edge_validity: boolean; flow_animation: boolean; minimap: boolean; dots: boolean; pan_mode: boolean; icons: "color" | "mono" | "none"; aip: boolean; minimized: boolean };
export type Graph = { nodes: SDNode[]; edges: SDEdge[]; description: string; settings: Settings };
export type Component = { id: string; name: string; category: string; icon: IconName; href: string | null; description: string };
export type Catalog = { categories: { id: string; name: string }[]; components: Component[]; concepts: { id: string; name: string; category: string }[] };
export type Version = { version: number; at: string; by: string; manual: boolean; description: string; nodes: number };
export type CriticMessage = { role: "user" | "assistant"; text: string; at: string; by?: string; follow_ups?: string[]; node_ids?: string[] };
export type Plan = {
  title: string;
  overview: string;
  phases: { name: string; goal: string; depends_on: string[]; effort: "small" | "medium" | "large"; estimate: string; tasks: { title: string; component: string; detail: string; node_ids: string[] }[]; best_practices: string[] }[];
  risks: string[];
  generated_at: string;
  by: string;
  version: number;
};
export type Architect = { wizard: Wizard | null; summary: string; title?: string; model?: string | null; generated_at?: string; implemented: Record<string, { pattern: string; at: string }> } | null;
export type Wizard = { artifact: string; summary: string; source: string; frequency: string; scale: string; data_properties: string[]; code_level: "no" | "low" | "pro"; model?: string | null };
export type Summary = { id: string; rid: string; item_id: string; name: string; folder_id: string | null; version: number; nodes: number; edges: number; created_at: string; updated_at: string; can_edit?: boolean };
export type Diagram = Summary & { graph: Graph; previewing: number | null; can_edit: boolean; saved_version: number; architect: Architect; critic: { messages: CriticMessage[]; plan: Plan | null }; versions: Version[] };
export type Pattern = { name: string; summary: string; rationale: string; tradeoffs: string; components: { key: string; component: string; title: string; description: string }[]; edges: { from: string; to: string; label: string }[]; entry: string; exit: string };
export type Section = { id: string; name: string; nodes: { id: string; title: string }[] };
export type Step = { node_id: string; title: string; component: string; description: string; what: string; href: string | null; after: string[] };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/solution-designer" + path, {
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
    const e = new Error(message) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** A streamed route (server-sent events): onPartial gets the answer as far as the model has written it ("reset" sends
 * null: the stream failed and the answer is computed again); resolves with the "result" — what the plain route returns.
 * Aborting the signal closes the stream and the server drops the call (nothing is saved). */
async function stream<T, P>(path: string, json: unknown, onPartial: (p: P | null) => void, signal?: AbortSignal): Promise<T> {
  const res = await fetch(API_URL + "/api/solution-designer" + path, {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(json),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    const e = new Error(message) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || data === undefined) continue;
      const payload = JSON.parse(data);
      if (ev === "partial") onPartial(payload as P);
      else if (ev === "reset") onPartial(null);
      else if (ev === "result") return payload as T;
      else if (ev === "error") {
        const e = new Error(typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail)) as Error & { status?: number };
        e.status = payload.status;
        throw e;
      } else if (ev === "cancelled") throw new DOMException("cancelled", "AbortError");
    }
  }
  throw new Error("the answer stream ended early");
}

export type CriticState = { messages: CriticMessage[]; plan: Plan | null; sections: Section[]; suggested: string[] };
export type AssistTurn = { role: "user" | "assistant"; text: string };
export type AssistAnswer = { node_id: string; component: string; question: string; answer: string };

export const sd = {
  catalog: () => req<Catalog>("/catalog"),
  references: () => req<{ id: string; category: string; name: string; description: string; components: string[] }[]>("/references"),
  reference: (id: string) => req<{ id: string; name: string; graph: Graph }>(`/references/${id}`),
  models: () => req<{ id: string; label: string; default?: boolean }[]>("/models"),
  list: () => req<Summary[]>("/diagrams"),
  create: (body: { name: string; folder_id: string; graph?: Partial<Graph>; reference_id?: string }) => req<Diagram>("/diagrams", { method: "POST", json: body }),
  get: (id: string, version?: number) => req<Diagram>(`/diagrams/${id}${version ? `?version=${version}` : ""}`),
  save: (id: string, body: { graph: Graph; base_version: number; manual?: boolean; description?: string; name?: string }) => req<Diagram>(`/diagrams/${id}`, { method: "PUT", json: body }),
  /** create a proposed object type node's object type in the Ontology; the node becomes a resource node (a new version) */
  createObjectType: (id: string, nodeId: string, base_version: number) =>
    req<{ object_type: { id: string; display_name: string; api_name: string }; diagram: Diagram }>(`/diagrams/${id}/nodes/${encodeURIComponent(nodeId)}/create-object-type`, { method: "POST", json: { base_version } }),
  createLinkType: (id: string, edgeId: string, base_version: number, kind: "auto" | "join_table" = "auto") =>
    req<{ link_type: { id: string; display_name: string; kind: string; cardinality: string; foreign_key?: string | null }; diagram: Diagram }>(
      `/diagrams/${id}/edges/${encodeURIComponent(edgeId)}/create-link-type`,
      { method: "POST", json: { base_version, kind } },
    ),
  restore: (id: string, v: number) => req<Diagram>(`/diagrams/${id}/versions/${v}/restore`, { method: "POST" }),
  remove: (id: string) => req<unknown>(`/diagrams/${id}`, { method: "DELETE" }),
  exportUrl: (id: string) => `${API_URL}/api/solution-designer/diagrams/${id}/export`,
  resources: (kind: ResourceRef["kind"], q: string) => req<(ResourceRef & { subtitle: string; href: string })[]>(`/resources?kind=${kind}&q=${encodeURIComponent(q)}`),
  resolve: (resources: { kind: string; id: string }[]) => req<Record<string, { ok: boolean; name?: string; href?: string; reason?: string }>>("/resolve", { method: "POST", json: { resources } }),
  traversal: (typeId: string) => req<{ link_type_id: string; name: string; cardinality: string; object_type_id: string; object_type: string }[]>(`/object-traversal/${typeId}`),
  lineage: (root?: string, depth = 3) => req<{ nodes: SDNode[]; edges: SDEdge[]; lineage_nodes: { id: string; name: string; kind: string }[] }>(`/lineage${root ? `?root=${encodeURIComponent(root)}&depth=${depth}` : ""}`),
  /** the Data Lineage node ids of the diagram's linked resources (and of nodes imported from Data Lineage) */
  lineageFocus: (resources: { kind: string; id: string; name?: string }[], lineage_ids: string[]) =>
    req<{ ids: string[]; missing: { kind: string; id: string; name?: string }[] }>("/lineage/focus", { method: "POST", json: { resources, lineage_ids } }),
  generate: (id: string, w: Wizard) => req<{ architect: Architect; nodes: SDNode[]; edges: SDEdge[] }>(`/diagrams/${id}/architect/generate`, { method: "POST", json: w }),
  summary: (id: string, summary: string, model?: string) => req<Architect>(`/diagrams/${id}/architect/summary`, { method: "PUT", json: { summary, model } }),
  implement: (id: string, node_id: string, graph: Graph, model?: string) => req<{ node_id: string; patterns: Pattern[] }>(`/diagrams/${id}/architect/implement`, { method: "POST", json: { node_id, graph, model } }),
  implemented: (id: string, node_id: string, pattern: string) => req<Architect>(`/diagrams/${id}/architect/implemented`, { method: "POST", json: { node_id, pattern } }),
  dataModel: (id: string, node_id: string, prompt: string, graph: Graph, model?: string) => req<{ nodes: SDNode[]; edges: SDEdge[] }>(`/diagrams/${id}/architect/data-model`, { method: "POST", json: { node_id, prompt, graph, model } }),
  walkthrough: (id: string) => req<{ summary: string; steps: Step[] }>(`/diagrams/${id}/architect/walkthrough`),
  critic: (id: string) => req<{ messages: CriticMessage[]; plan: Plan | null; sections: Section[]; suggested: string[] }>(`/diagrams/${id}/critic`),
  ask: (id: string, question: string, graph?: Graph, model?: string, focus_node?: string) =>
    req<{ messages: CriticMessage[]; plan: Plan | null; sections: Section[]; suggested: string[] }>(`/diagrams/${id}/critic/ask`, { method: "POST", json: { question, graph, model, focus_node } }),
  /** /critic/ask streamed: the answer grows in onPartial; resolves with the saved critic state */
  askStream: (id: string, body: { question: string; graph?: Graph; model?: string; focus_node?: string }, onPartial: (p: Partial<{ answer: string; follow_ups: string[]; node_ids: string[] }> | null) => void, signal?: AbortSignal) =>
    stream<CriticState, Partial<{ answer: string; follow_ups: string[]; node_ids: string[] }>>(`/diagrams/${id}/critic/ask/stream`, body, onPartial, signal),
  /** /architect/implement streamed: the patterns as far as written (explanations grow); resolves with the patterns */
  implementStream: (id: string, node_id: string, graph: Graph, model: string | undefined, onPartial: (p: { patterns?: Partial<Pattern>[] } | null) => void, signal?: AbortSignal) =>
    stream<{ node_id: string; patterns: Pattern[] }, { patterns?: Partial<Pattern>[] }>(`/diagrams/${id}/architect/implement/stream`, { node_id, graph, model }, onPartial, signal),
  /** AIP Assist on a node's documentation card (not saved with the diagram) */
  assist: (id: string, body: { node_id: string; question: string; history: AssistTurn[]; graph?: Graph; model?: string }) => req<AssistAnswer>(`/diagrams/${id}/assist`, { method: "POST", json: body }),
  assistStream: (id: string, body: { node_id: string; question: string; history: AssistTurn[]; graph?: Graph; model?: string }, onPartial: (text: string | null) => void, signal?: AbortSignal) =>
    stream<AssistAnswer, string>(`/diagrams/${id}/assist/stream`, body, onPartial, signal),
  clearCritic: (id: string) => req<unknown>(`/diagrams/${id}/critic`, { method: "DELETE" }),
  plan: (id: string, graph?: Graph, model?: string) => req<Plan>(`/diagrams/${id}/critic/plan`, { method: "POST", json: { graph, model } }),
  planPdfUrl: (id: string) => `${API_URL}/api/solution-designer/diagrams/${id}/critic/plan.pdf`,
  importImage: async (id: string, file: File, model?: string) => {
    const f = new FormData();
    f.append("file", file);
    const res = await fetch(`${API_URL}/api/solution-designer/diagrams/${id}/import-image${model ? `?model=${encodeURIComponent(model)}` : ""}`, { method: "POST", body: f, credentials: "include" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ detail: res.statusText }))).detail);
    return (await res.json()) as { nodes: SDNode[]; edges: SDEdge[] };
  },
};

export const NODE_W = 220;
export const NODE_H = 74;
export const size = (n: SDNode) =>
  n.kind === "group" ? { w: n.w ?? 400, h: n.h ?? 260 } : n.kind === "text" ? { w: n.w ?? 240, h: n.h ?? 60 } : { w: n.w ?? NODE_W, h: n.h ?? NODE_H };

export const CATEGORY_COLOR: Record<string, string> = {
  external: "#94a3b8",
  sourcing: "#06b6d4",
  processing: "#3b82f6",
  modeling: "#a855f7",
  ontology: "#22c55e",
  analytics: "#f59e0b",
  apps: "#ec4899",
  platform: "#64748b",
  custom: "#78716c",
};

/** The section a node belongs to (AIP Critic's organization; colors the node). */
export function categoryOf(n: SDNode, comps: Record<string, Component>, concepts: Record<string, { category: string }>): string {
  if (n.kind === "component") return comps[n.component ?? ""]?.category ?? "custom";
  if (n.kind === "concept") return concepts[n.concept ?? ""]?.category ?? "custom";
  if (n.kind === "object") return "ontology";
  if (n.kind === "resource") return ["object_type", "interface", "action_type"].includes(n.resource?.kind ?? "") ? "ontology" : comps[n.component ?? "dataset"]?.category ?? "processing";
  return "custom";
}

/** Edge validity: data does not flow back into external systems or sources from the Ontology, analytics or applications. */
export function edgeValid(from: string, to: string): boolean {
  if (["external", "sourcing"].includes(to) && !["external", "sourcing", "processing", "custom", "platform"].includes(from)) return false;
  if (to === "processing" && ["apps", "analytics"].includes(from)) return false;
  return true;
}

/** Layers by longest path from the sources, left to right (the canvas' "Layout nodes automatically"). */
export function autoLayout(nodes: SDNode[], edges: SDEdge[]): SDNode[] {
  const free = nodes.filter((n) => !["group", "text"].includes(n.kind) && !n.parent);
  const ids = new Set(free.map((n) => n.id));
  const inc: Record<string, string[]> = Object.fromEntries(free.map((n) => [n.id, []]));
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) inc[e.to].push(e.from);
  const depth: Record<string, number> = {};
  const d = (i: string, seen: Set<string>): number => {
    if (i in depth) return depth[i];
    if (seen.has(i)) return 0;
    seen.add(i);
    return (depth[i] = Math.max(0, ...inc[i].map((p) => d(p, seen) + 1)));
  };
  const rows: Record<number, number> = {};
  const minX = Math.min(...free.map((n) => n.x), 80);
  const minY = Math.min(...free.map((n) => n.y), 80);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of [...free].sort((a, b) => a.y - b.y)) {
    const k = d(n.id, new Set());
    const r = (rows[k] = (rows[k] ?? -1) + 1);
    pos[n.id] = { x: minX + k * 290, y: minY + r * 120 };
  }
  return nodes.map((n) => (pos[n.id] ? { ...n, ...pos[n.id] } : n));
}
