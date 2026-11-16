/**
 * Ontology scenarios (api/ontology_scenarios.py): what-if sandboxes where actions apply on top of main, compared
 * side by side and merged back through an action type with an Apply scenario rule.
 */
import type { ApplyResult, FormState } from "./actions";
import { request } from "./ontology";
import type { SearchResult, SearchSpec } from "./ontologyModel";

export type ScenarioStatus = "draft" | "in_review" | "approved" | "rejected" | "merged";
export type Scenario = {
  id: string;
  rid: string;
  name: string;
  description: string;
  persisted: boolean;
  status: ScenarioStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  last_used_at: string;
  merged: { at: string; by: string; action_rid: string } | null;
  rebase: { at: string; conflicts: { object_type_id: string; primary_key: string; reason: string }[] } | null;
  object_edits: number;
  link_edits: number;
};
export type ScenarioEdit = {
  object_type_id: string;
  object_type: string;
  primary_key: string;
  op: "create" | "modify" | "delete";
  at: string;
  title: string;
  changed: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  conflict: string | null;
};
export type ScenarioDetail = Scenario & {
  edits: ScenarioEdit[];
  links: { link_type_id: string; link_type: string; op: "add" | "remove"; source: string; target: string }[];
  activity: { at: string; user: string; label: string; edited: { op: string; object_type_id: string; primary_key: string }[]; links: number }[];
  reviewed_by: string | null;
  reviewed_at: string | null;
};
export type Comparison = {
  metric: string;
  property: string | null;
  group_by: string | null;
  groups: string[];
  columns: { scenario_id: string | null; name: string; total: number; values: Record<string, number | string | null> }[];
};

export const scenarios = {
  list: () => request<Scenario[]>("/scenarios"),
  create: (body: { name?: string; description?: string; persisted?: boolean }) => request<Scenario>("/scenarios", { method: "POST", json: body }),
  get: (id: string) => request<ScenarioDetail>(`/scenarios/${id}`),
  update: (id: string, body: Partial<Pick<Scenario, "name" | "description" | "persisted">> & { status?: Exclude<ScenarioStatus, "merged"> }) =>
    request<Scenario>(`/scenarios/${id}`, { method: "PATCH", json: body }),
  remove: (id: string) => request<unknown>(`/scenarios/${id}`, { method: "DELETE" }),
  rebase: (id: string) => request<Scenario>(`/scenarios/${id}/rebase`, { method: "POST" }),
  discard: (id: string, body: { object_type_id?: string; primary_key?: string; link_type_id?: string; source?: string; target?: string }) =>
    request<Scenario>(`/scenarios/${id}/discard`, { method: "POST", json: body }),
  form: (id: string, actionId: string, parameters: Record<string, unknown>, touched?: string[]) =>
    request<FormState>(`/scenarios/${id}/actions/${actionId}/form`, { method: "POST", json: { parameters, touched } }),
  apply: (id: string, actionId: string, parameters: Record<string, unknown>) =>
    request<ApplyResult>(`/scenarios/${id}/actions/${actionId}/apply`, { method: "POST", json: { parameters } }),
  search: (id: string, spec: SearchSpec) => request<SearchResult>(`/scenarios/${id}/search`, { method: "POST", json: spec }),
  compare: (body: { scenario_ids: string[]; include_main?: boolean; object_type_id: string; metric: string; property?: string | null; group_by?: string | null }) =>
    request<Comparison>("/scenarios/compare", { method: "POST", json: body }),
  createMergeAction: (body: { display_name: string; object_type_ids: string[]; link_type_ids?: string[] }) =>
    request<{ id: string; display_name: string }>("/scenarios/merge-action-type", { method: "POST", json: body }),
  merge: (id: string, actionTypeId: string) => request<ApplyResult & { scenario: Scenario }>(`/scenarios/${id}/merge`, { method: "POST", json: { action_type_id: actionTypeId } }),
};
