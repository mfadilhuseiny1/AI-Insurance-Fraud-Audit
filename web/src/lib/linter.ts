/** Linter (api/linter.py): rules, sweep schedules, recommendations, fixes and impact tracking. */
import { API_URL } from "./api";

export type LinterMode = "resource_savings" | "pipeline_resilience";
export type LinterRule = {
  id: string;
  name: string;
  mode: LinterMode;
  resource: string;
  logic: string;
  why: string;
  recommendation: string;
  presets: string[];
  savings: string;
  fix: string | null;
  applicable: boolean;
  not_applicable: string | null;
};
export type Recommendation = {
  id: string;
  rule: string;
  mode: LinterMode;
  title: string;
  resource: { type: string; id: string; name: string; subtitle?: string; href?: string };
  projects: { id: string; name: string }[];
  detail: string;
  evidence: string[];
  impact: { compute_hours_month: number } | null;
  first_seen: string;
  last_seen: string;
  status: "open" | "under_investigation" | "resolved";
  state: "default" | "snoozed" | "snooze_expired";
  snooze: { until: string; reason: string; by: string; at: string } | null;
  assignee: string | null;
  fix: string | null;
  fixed?: { at: string; by: string; result: string };
  investigated_at?: string;
  resolved_at?: string;
  snapshot?: { impact: { compute_hours_month: number } | null };
  verified?: { before_hours: number; after_hours: number; monthly_hours: number; at: string };
};
export type Sweep = {
  id: string;
  schedule_id: string;
  trigger: string;
  status: "running" | "succeeded" | "failed";
  queued_at: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  found: number;
  new: number;
  removed: number;
  resolved: number;
  rule_errors: Record<string, string>;
};
export type SweepSchedule = {
  id: string;
  name: string;
  description: string;
  projects: string[];
  presets: string[];
  rules: string[];
  exclude: string[];
  interval_hours: number;
  paused: boolean;
  last_sweep?: { id: string; status: string; finished_at: string; found: number };
  recent_sweeps?: Sweep[];
  rule_scope?: string[];
};
export type Impact = { resolved: number; under_investigation: number; estimated_hours: number; verified_hours: number; pending_verification: number; recommendations: Recommendation[] };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/linter" + path, {
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

export type ScheduleBody = Pick<SweepSchedule, "name" | "description" | "projects" | "presets" | "rules" | "exclude" | "interval_hours" | "paused">;

export const linter = {
  rules: () => req<{ rules: LinterRule[]; presets: Record<string, string>; modes: Record<LinterMode, string> }>("/rules"),
  recommendations: (mode?: LinterMode) => req<Recommendation[]>(`/recommendations${mode ? `?mode=${mode}` : ""}`),
  open: (id: string) => req<Recommendation & { rule_info: LinterRule }>(`/recommendations/${id}/open`, { method: "POST" }),
  bulk: (body: { ids: string[]; action: "snooze" | "unsnooze" | "assign"; until?: string; reason?: string; assignee?: string | null }) =>
    req<Recommendation[]>("/recommendations/bulk", { method: "POST", json: body }),
  fix: (id: string) => req<{ applied: string; recommendation: Recommendation }>(`/recommendations/${id}/fix`, { method: "POST" }),
  assignees: () => req<{ id: string; label: string }[]>("/assignees"),
  impact: (q: { days?: number; rule?: string; project?: string } = {}) =>
    req<Impact>(`/impact?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString()}`),
  schedules: () => req<SweepSchedule[]>("/sweep-schedules"),
  createSchedule: (body: ScheduleBody) => req<SweepSchedule>("/sweep-schedules", { method: "POST", json: body }),
  updateSchedule: (id: string, body: ScheduleBody) => req<SweepSchedule>(`/sweep-schedules/${id}`, { method: "PUT", json: body }),
  deleteSchedule: (id: string) => req<{ deleted: string }>(`/sweep-schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) => req<{ queued: string }>(`/sweep-schedules/${id}/run`, { method: "POST" }),
};

export const MODES: [LinterMode, string][] = [
  ["resource_savings", "Resource Savings"],
  ["pipeline_resilience", "Pipeline Resilience"],
];

export const RESOURCE_LABEL: Record<string, string> = { schedule: "Schedule", code_repository: "Code repository", transform: "Code transform", pipeline: "Pipeline", dataset: "Dataset" };
