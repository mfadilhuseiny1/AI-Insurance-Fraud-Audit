/** Dynamic Scheduling (api/dynamic_scheduling.py): scheduling boards, pucks, rules, suggestions and staged sessions. */
import { API_URL } from "./api";
import type { OntologyObject } from "./ontology";

export type SchedRule = {
  id: string;
  name: string;
  constraint: "HARD" | "SOFT";
  kind: "no_overlap" | "within_hours" | "max_per_day" | "property_match" | "function";
  start_hour?: number | null;
  end_hour?: number | null;
  max?: number | null;
  schedule_property?: string | null;
  resource_property?: string | null;
  function_id?: string | null;
  /** property_match: the resource section compared with (an extra resource's foreign key; default the first) */
  dimension?: string | null;
  enabled: boolean;
};
export const LAYER_OPERATORS = ["=", "!=", ">", "<", "contains", "empty", "not_empty", "violation"] as const;
/** Puck styling layer: the first enabled layer (top first) whose condition a puck meets colors it. */
export type StyleLayer = { id: string; name: string; operator: (typeof LAYER_OPERATORS)[number]; property?: string | null; value?: unknown; color: string; enabled: boolean };
/** A row: a resource object; `key` names it across sections (the primary key in the first section). */
export type Row = OntologyObject & { key: string; dimension: string; section: string };
export type Board = {
  id: string;
  name: string;
  description: string;
  schedule_object_type_id: string;
  resource_object_type_id: string;
  resource_property: string;
  start_property: string;
  end_property: string;
  fixed_duration_property: string | null;
  label_property: string | null;
  color_property: string | null;
  save_action_id: string;
  merge_action_id: string | null;
  timeline_start: string;
  timeline_end: string;
  snap_minutes: number;
  rules: SchedRule[];
  row_properties: string[];
  /** further resource object types a schedule object is assigned to, each through its own foreign key */
  extra_resources?: { object_type_id: string; resource_property: string; label: string }[];
  style_layers?: StyleLayer[];
};
export type Puck = {
  id: string;
  title: string;
  resource: string | null;
  /** the extra sections' rows: foreign key property -> primary key */
  resources?: Record<string, string | null>;
  style?: { layer: string; name: string; color: string } | null;
  start: string | null;
  end: string | null;
  fixed: boolean;
  color: unknown;
  properties: Record<string, unknown>;
  violations: { rule: string; name: string; constraint: "HARD" | "SOFT"; details: string }[];
};
export type BoardData = {
  board: Board;
  rows: Row[];
  pucks: Puck[];
  unassigned: string[];
  metrics: { row_utilization: Record<string, number>; per_day: Record<string, number> };
  hard_violations: number;
};
export type Slot = { start: string; end: string; rating: number; breaks: string[] };
/** A search function's result (Dynamic Scheduling's ISearchResult): a search group of rows with highlighted slots / pucks. */
export type Highlight = {
  type: "SLOT" | "PUCK";
  /** epoch milliseconds */
  domain?: { start: number; end: number };
  /** a row key */
  containerId?: string | null;
  schedulableObjectPrimaryKey?: string;
  schedulableObjectTypeId?: string;
  comment?: string | null;
};
export type SearchResult = { rowGroup: { title: string; containerIds: string[]; highlights: Highlight[] } | null; sourcePuckIds: string[]; error: string | null };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api/scheduling${path}`, {
    ...init,
    credentials: "include",
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}

export const scheduling = {
  boards: () => req<Board[]>("/boards"),
  save: (id: string, b: Omit<Board, "id">) => req<Board>(`/boards/${id}`, { method: "PUT", json: b }),
  data: (id: string, scenarioId?: string | null) => req<BoardData>(`/boards/${id}/data${scenarioId ? `?scenario_id=${scenarioId}` : ""}`),
  /** `exact`: restore a recorded state (times as given, empty ones cleared, nothing snapped) */
  move: (id: string, body: { primary_key: string; resource?: string | null; dimension?: string | null; start?: string | null; end?: string | null; scenario_id?: string | null; exact?: boolean }) =>
    req<BoardData>(`/boards/${id}/move`, { method: "POST", json: body }),
  /** a search function: on a row at a time, or on a puck (built in, or a function returning an ISearchResult) */
  recommend: (id: string, body: { kind: "row" | "puck"; row?: string; time?: string; primary_key?: string; scenario_id?: string | null; function_id?: string | null }) =>
    req<SearchResult>(`/boards/${id}/recommend`, { method: "POST", json: body }),
  suggest: (id: string, primaryKey: string, scenarioId?: string | null) => req<{ slots: Record<string, Slot[]> }>(`/boards/${id}/suggest`, { method: "POST", json: { primary_key: primaryKey, scenario_id: scenarioId } }),
  search: (id: string, apply: boolean, scenarioId?: string | null) =>
    req<{ placements: { primary_key: string; placed: boolean; row?: string; start?: string; end?: string; rating?: number }[] }>(`/boards/${id}/search`, { method: "POST", json: { apply, scenario_id: scenarioId } }),
  session: (id: string) => req<{ id: string; name: string }>(`/boards/${id}/session`, { method: "POST" }),
  submit: (id: string, scenarioId: string) => req<unknown>(`/boards/${id}/submit`, { method: "POST", json: { scenario_id: scenarioId } }),
};
