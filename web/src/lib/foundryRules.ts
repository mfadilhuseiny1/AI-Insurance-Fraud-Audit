/** Foundry Rules (api/foundry_rules.py): workflows, rules with logic blocks, proposals and runs. */
import { API_URL } from "./api";

export type Board = "filter" | "expression" | "aggregation" | "join" | "window" | "select" | "union" | "link";
export type Input = { kind: "object_type" | "dataset"; id: string };
export type OutputField = {
  name: string;
  type: "string" | "integer" | "double" | "boolean" | "date" | "timestamp";
  required: boolean;
  column_values: "any" | "none" | "selection";
  columns: string[];
  static_values: "any" | "none" | "selection" | "range" | "users";
  values: unknown[];
  min: number | null;
  max: number | null;
  template: boolean;
  default: Mapping | null;
};
export type WorkflowOutput = { id: string; name: string; object_type_id: string | null; dataset_name: string | null; dataset_id: string | null; fields: OutputField[] };
export type Run = {
  at: string;
  ms: number;
  by: string;
  rules: { rule_id: string; rule: string; rows: number; status: string; error?: string }[];
  outputs: { output: string; object_type_id?: string; dataset_id?: string; objects?: number; rows?: number; created?: number; modified?: number; deleted?: number }[];
};
export type Workflow = {
  id: string;
  name: string;
  description: string;
  inputs: Input[];
  outputs: WorkflowOutput[];
  custom_properties: { name: string; type: string }[];
  boards: Board[];
  editors: string[];
  reviewers: string[];
  require_proposals: boolean;
  schedule_minutes: number | null;
  last_run: Run | null;
  runs?: Run[];
  rules?: number;
  active_rules?: number;
  open_proposals?: number;
};
export type Mapping = { kind: "column"; column: string } | { kind: "static"; value: unknown } | { kind: "template"; value: string };
export type Block = { kind: Board } & Record<string, unknown>;
export type Rule = {
  id?: string;
  workflow_id: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  custom: Record<string, unknown>;
  logic: { input: Input; blocks: Block[]; output: { output_id: string; mapping: Record<string, Mapping> } };
  version?: number;
  author?: string;
};
export type Proposal = {
  id: string;
  workflow_id: string;
  rule_id: string | null;
  kind: "create" | "edit" | "delete";
  author: string;
  created_at: string;
  status: "open" | "approved" | "rejected";
  old: Partial<Rule> | null;
  new: Rule | null;
  diff: { field: string; old: unknown; new: unknown }[];
  reviewer: string | null;
  reviewed_at: string | null;
  review_comment?: string;
  /** the rule version an edit / delete was made against (absent on proposals made before it was recorded) */
  base_version?: number | null;
  /** open edit / delete proposals: the rule changed (or was deleted) since — approving is refused */
  stale?: boolean;
  stale_reason?: string | null;
  current_version?: number | null;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api/foundry-rules${path}`, {
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

export const rulesApi = {
  workflows: () => req<Workflow[]>("/workflows"),
  workflow: (id: string) => req<Workflow>(`/workflows/${id}`),
  createWorkflow: (w: Omit<Workflow, "id" | "last_run">) => req<Workflow>("/workflows", { method: "POST", json: w }),
  saveWorkflow: (id: string, w: Omit<Workflow, "id" | "last_run">) => req<Workflow>(`/workflows/${id}`, { method: "PUT", json: w }),
  rules: (wid: string) => req<Rule[]>(`/workflows/${wid}/rules`),
  propose: (rule: Rule) => (rule.id ? req<Proposal>(`/rules/${rule.id}`, { method: "PUT", json: rule }) : req<Proposal>("/rules", { method: "POST", json: rule })),
  proposeDelete: (id: string) => req<Proposal>(`/rules/${id}`, { method: "DELETE" }),
  proposals: (wid: string, status?: string) => req<Proposal[]>(`/workflows/${wid}/proposals${status ? `?status=${status}` : ""}`),
  review: (id: string, decision: "approve" | "reject", comment = "") => req<Proposal>(`/proposals/${id}/review`, { method: "POST", json: { decision, comment } }),
  preview: (rule: Rule, upto?: number | null) =>
    req<{ rows: Record<string, unknown>[] | { row: Record<string, unknown> }[]; count: number; columns?: string[]; output_id?: string }>("/preview", { method: "POST", json: { rule, upto } }),
  run: (wid: string) => req<Run>(`/workflows/${wid}/run`, { method: "POST" }),
  /** a Contour path as a draft rule's logic, with notes on what was left out */
  importContour: (workflow_id: string, analysis_id: string, path_id: string) =>
    req<{ name: string; description: string; logic: Pick<Rule["logic"], "input" | "blocks">; notes: string[] }>("/import-contour", { method: "POST", json: { workflow_id, analysis_id, path_id } }),
};
