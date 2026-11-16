/** Machinery (api/machinery.py): processes over Ontology objects — definition, process log, mining and metrics. */
import { API_URL } from "./api";
import type { OntologyObject } from "./ontology";

export const START = "__start__";
/** x / y: where the state is drawn when the resource's automatic layout is off */
export type State = { id: string; label?: string; x?: number | null; y?: number | null };
export type Transition = { from: string; to: string };
export type ProcessAction = { action_type_id: string; inputs: string[]; outputs: string[]; automation: boolean; automation_id?: string };
export type Process = {
  id: string;
  name: string;
  object_type_id: string;
  state_property: string;
  states: State[];
  transitions: Transition[];
  actions: ProcessAction[];
  log: { object_type_id: string; link_type_id: string; changelog_dataset_id?: string | null; from_edits?: boolean } | null;
  excluded: string[];
  /** a subprocess: its objects are those linked to the parent process' objects through the link type */
  parent?: { process_id: string; link_type_id: string } | null;
};
export type HierarchyRow = { id: string; name: string; parent: string | null; objects: number; children: string[]; by_parent_state?: Record<string, number> };
export type Machinery = { id: string; name: string; description: string; processes: Process[]; auto_layout: boolean };
export type Mined = {
  states: { id: string; count: number; status: "new" | "existing" }[];
  transitions: { from: string; to: string; count: number; status: "new" | "existing" }[];
  unused_states: string[];
  unused_transitions: Transition[];
  transitions_total: number;
  transitions_kept: number;
};
export type Metrics = {
  objects: number;
  conforming: number;
  deviating: number;
  states: ({ id: string; defined: boolean; current_count: number; historical_count: number; current_duration_s: number | null; historical_duration_s: number | null } & MetricExtras)[];
  transitions: ({ from: string; to: string; count: number; mean_duration_s: number | null; defined: boolean } & MetricExtras)[];
  paths: { path: string[]; count: number }[];
  /** per action of the process (in order): the log entries it caused (by action type RID; an entry without one counts
   * for every action covering its transition), per input / output state, and the transitions it stands for */
  actions?: ActionMetric[];
  /** POST …/metrics with skip_invalid: aggregates this process' object type cannot compute, by id, with the reason */
  invalid_aggregates?: Record<string, string>;
};
/** What POST …/metrics adds (the Workshop widget's custom metric views): medians, distinct objects, shares (0..1) and
 * property aggregates by id. States: median_current_duration_s, median_historical_duration_s, ever_count,
 * current_share, historical_share; transitions: median_duration_s, objects, share. */
type MetricExtras = { [k: string]: unknown; aggregates?: Record<string, number | null> };
export type ActionMetric = {
  index: number; action_type_id: string; name: string; automation: boolean; inputs: string[]; outputs: string[];
  count: number; objects: number; mean_duration_s: number | null; median_duration_s: number | null;
  by_input: Record<string, number>; by_output: Record<string, number>; transitions: (Transition & { count: number })[];
};
export type MetricAggregate = { id: string; property: string; fn: "sum" | "mean" | "median" | "min" | "max" | "count" | "distinct"; scope: "current" | "ever" };
/** POST …/paths: the path explorer's variants, the most frequent first (durations from the first log entry to the last). */
export type PathVariant = {
  path: string[]; count: number; share: number; conforming: boolean; logged: number;
  mean_duration_s: number | null; median_duration_s: number | null; min_duration_s: number | null; max_duration_s: number | null;
};
export type PathsResult = { objects: number; variants: number; paths: PathVariant[]; truncated: boolean };
/** POST …/distribution: the durations of a selection (seconds) as equal-width buckets with percentiles. `now`: the time
 * current durations were measured up to — sent back with POST …/output's `duration` range. */
export type DurationDistribution = {
  measure: string; now: string; selected_objects: number; count: number; objects: number;
  min_s: number | null; max_s: number | null; mean_s: number | null;
  percentiles: Record<"p25" | "p50" | "p75" | "p90" | "p95" | "p99", number | null>;
  edges: number[]; buckets: { from_s: number; to_s: number; count: number; objects: number }[];
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api/machinery${path}`, {
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

const P = (mid: string, pid: string) => `/${mid}/processes/${pid}`;
export const machinery = {
  list: () => req<{ id: string; name: string; description: string; processes: number; updated_at: string }[]>(""),
  get: (id: string) => req<Machinery>(`/${id}`),
  create: (body: Omit<Machinery, "id">) => req<Machinery>("", { method: "POST", json: body }),
  save: (id: string, body: Omit<Machinery, "id">) => req<Machinery>(`/${id}`, { method: "PUT", json: body }),
  remove: (id: string) => req<unknown>(`/${id}`, { method: "DELETE" }),
  actions: (mid: string, pid: string) => req<{ action_type_id: string; automation_id?: string; name: string; outputs: string[]; automation: boolean }[]>(`${P(mid, pid)}/actions`),
  setupLog: (mid: string, pid: string, body: { changelog_dataset_id?: string | null; from_edits: boolean }) =>
    req<{ object_type_id: string; log_entries: number }>(`${P(mid, pid)}/log`, { method: "POST", json: body }),
  rebuildLog: (mid: string, pid: string) => req<{ log_entries: number }>(`${P(mid, pid)}/log/rebuild`, { method: "POST" }),
  mine: (mid: string, pid: string, body: { source?: string; elements?: string; keep_percent?: number }) => req<Mined>(`${P(mid, pid)}/mine`, { method: "POST", json: body }),
  accept: (mid: string, pid: string, body: { states: string[]; transitions: Transition[]; exclude: string[] }) => req<Machinery>(`${P(mid, pid)}/mine/accept`, { method: "POST", json: body }),
  hierarchy: (mid: string) => req<HierarchyRow[]>(`/${mid}/hierarchy`),
  metrics: (mid: string, pid: string, deviations = false, parentStates: string[] = []) =>
    req<Metrics>(`${P(mid, pid)}/metrics?include_deviations=${deviations}${parentStates.length ? `&parent_states=${encodeURIComponent(parentStates.join(","))}` : ""}`),
  durations: (mid: string, pid: string, state: string) =>
    req<{ state: string; count: number; buckets: { from_h: number; to_h: number; count: number }[] }>(`${P(mid, pid)}/durations?state=${encodeURIComponent(state)}`),
  output: (mid: string, pid: string, body: { states?: string[]; mode?: "current" | "ever"; transitions?: Transition[]; path?: string[] | null; parent_states?: string[] }) =>
    req<{ object_type_id: string; total: number; objects: OntologyObject[] }>(`${P(mid, pid)}/output`, { method: "POST", json: body }),
};
