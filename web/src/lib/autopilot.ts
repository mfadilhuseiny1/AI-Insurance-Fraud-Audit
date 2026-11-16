/** Autopilot (api/autopilot.py): Automate workflows as states, a dependency graph, events and object timelines. */
import { API_URL } from "./api";

export type State = { id: string; name: string; object_type_id: string; property: string; value: string; op?: "eq" | "contains" | "is_null"; color: string; icon: string | null; card_properties: string[] };
export type Workbench = {
  id: string;
  name: string;
  item_id: string;
  object_type_ids: string[];
  automation_ids: string[];
  removed_nodes: string[];
  states: State[];
  alerts: { kind: string; key: string; text: string; automation_ids?: string[]; object_type_id?: string }[];
  /** saved graph positions (node id → top-left corner): for everyone, and the viewer's own (which wins) */
  layout: { shared: Positions | null; mine: Positions | null; can_save_mine: boolean };
  /** who is notified when an alert appears */
  subscribers: { user_id: string; name: string; email: boolean; me: boolean }[];
  subscribed: boolean;
  created_at: string;
  updated_at: string;
};
export type Positions = Record<string, { x: number; y: number }>;
export type Card = { pk: string; title: string; properties: Record<string, unknown>; last: { at: string; action: string; user: string; automated: string | null } | null; live: boolean };
export type Board = { columns: (State & { object_type: string; count: number; cards: Card[] })[]; unassigned: Record<string, number>; live_automations: string[] };
export type GraphNode = { id: string; kind: "state" | "automation" | "action" | "logic" | "workshop"; label: string; color?: string; enabled?: boolean; runs?: number; failed?: number; live?: boolean; manual_runs?: number; automated_runs?: number; trigger?: string; tokens?: number | null };
export type Graph = { nodes: GraphNode[]; edges: { from: string; to: string; kind: string; automated?: boolean }[] };
export type AutoEvent = { id: string; at: string; trigger: string; primary_key: string | null; status: string; error: string | null; edits: number; logic_run_id?: string; ms?: number; automation_id: string; automation: string; tokens: number | null };
export type Timeline = {
  object: { title: string; primary_key: string; properties: Record<string, unknown> };
  items: ({ at: string; kind: "edit"; action: string; status: string; user: string; automation: string | null; ms?: number; changes: Record<string, { from: unknown; to: unknown }> } | { at: string; kind: "execution"; automation: string; automation_id: string; status: string; error: string | null; ms?: number; tokens?: number | null; tokens_by_model?: Record<string, number> | null })[];
  summary: { edits: number; executions: number; agentic_coverage: number | null; runtime_s: number; waiting_s: number; tokens: number | null; actors: string[] };
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/autopilot" + path, {
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

export const autopilot = {
  list: () => req<(Pick<Workbench, "id" | "name" | "item_id" | "object_type_ids" | "automation_ids" | "created_at" | "updated_at"> & { states: number })[]>("/workbenches"),
  get: (id: string) => req<Workbench>(`/workbenches/${id}`),
  create: (body: { name: string; folder_id: string; object_type_ids: string[]; automation_ids: string[] }) => req<Workbench>("/workbenches", { method: "POST", json: body }),
  update: (id: string, body: Partial<Pick<Workbench, "name" | "automation_ids" | "object_type_ids" | "states" | "removed_nodes">>) => req<Workbench>(`/workbenches/${id}`, { method: "PUT", json: body }),
  infer: (id: string) => req<Workbench>(`/workbenches/${id}/infer`, { method: "POST" }),
  board: (id: string, linkedTo?: string) => req<Board>(`/workbenches/${id}/board${linkedTo ? `?linked_to=${encodeURIComponent(linkedTo)}` : ""}`),
  graph: (id: string) => req<Graph>(`/workbenches/${id}/graph`),
  activity: (id: string, rid: string) => req<{ at: string; user: string; status: string; error: string | null; edits: { op: string; object_type_id: string; primary_key: string }[] }[]>(`/workbenches/${id}/resources/${rid}/activity`),
  events: (id: string, q: { status?: string; automation_id?: string; hours?: number } = {}) => {
    const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return req<{ events: AutoEvent[]; total: number; by_status: Record<string, number>; failing_objects: [string, number][]; tokens: number | null }>(`/workbenches/${id}/events${s.size ? `?${s}` : ""}`);
  },
  saveLayout: (id: string, positions: Positions, scope: "mine" | "shared") => req<Workbench["layout"]>(`/workbenches/${id}/layout`, { method: "PUT", json: { positions, scope } }),
  resetLayout: (id: string, scope: "mine" | "shared") => req<Workbench["layout"]>(`/workbenches/${id}/layout?scope=${scope}`, { method: "DELETE" }),
  subscribe: (id: string, email: boolean) => req<Workbench>(`/workbenches/${id}/subscribe`, { method: "POST", json: { email } }),
  unsubscribe: (id: string) => req<Workbench>(`/workbenches/${id}/subscribe`, { method: "DELETE" }),
  setSubscribers: (id: string, subscribers: { user_id: string; email: boolean }[]) => req<Workbench>(`/workbenches/${id}`, { method: "PUT", json: { subscribers } }),
  retry: (id: string, automation_id: string, primary_keys: string[]) => req<{ runs: { pk: string; status: string; error: string | null }[]; succeeded: number }>(`/workbenches/${id}/retry`, { method: "POST", json: { automation_id, primary_keys } }),
  timeline: (id: string, typeId: string, pk: string) => req<Timeline>(`/workbenches/${id}/objects/${typeId}/${encodeURIComponent(pk)}/timeline`),
};
