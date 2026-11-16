/** Client for builds, deploy state, schedules and streams (api/pipeline_runtime.py, api/pipeline_schedules.py). */
import { API_URL } from "./api";
import type { Schedule } from "./pipeline";

export type BuildLog = { at: string; level: "info" | "warn" | "error"; msg: string };
export type BuildOutput = {
  id: string;
  name: string;
  kind: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  rows?: number;
  columns?: number;
  expectations?: { id: string; ok: boolean; message: string; mode?: "abort" | "warn"; kind?: string }[];
  error?: string;
  path?: string;
  /** an ingest stream written by a streaming job */
  streamId?: string;
  itemId?: string;
  seconds?: number;
};
export type BuildJob = { id: string; name: string; profile: string; status: string; outputs: BuildOutput[]; started_at?: string; finished_at?: string };
export type BuildRecord = {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  branch: string;
  outputs: string[];
  trigger: string;
  schedule_id?: string | null;
  target: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  jobs: BuildJob[];
  logs: BuildLog[];
  validation: { level: string; message: string }[];
  error?: string;
  summary?: { jobs: number; succeeded: number; serviceCalls: number; records?: number; replay?: boolean; regularSnapshot?: string };
  /** a streaming job (runs until stopped) */
  streaming?: boolean;
  /** why it failed: immediate (validation, never ran), transient (retried; streaming jobs restart) or persistent */
  failure_type?: "immediate" | "transient" | "persistent";
  /** streaming jobs restarted by the API after a transient failure */
  restart_of?: string;
  auto_restarts?: number;
  updated_at?: string;
  /** parameter values and the schedule run setup it built */
  parameters?: Record<string, string>;
  run_setup?: { id: string; name: string } | null;
  /** an earlier logic version it was asked to build */
  version_id?: string | null;
  /** what it started from: the logic version and its hash, each input's version, each output's signature */
  logic_hash?: string;
  logic_version?: { id: string; at: string; message?: string; author?: string } | null;
  input_versions?: Record<string, { name: string; kind: string; version: string | null }>;
  /** schedules: the run it belongs to, its attempt and the build it retries */
  schedule_run?: string | null;
  attempt?: number;
  retry_of?: string | null;
  rerun_of?: string | null;
  /** input pre-conditions checked before the jobs ran */
  preconditions?: { id: string; ok: boolean; message: string; mode?: "abort" | "warn"; kind?: string; input: string }[];
};
/** A build in lists (no logs): what it built, with counts. */
export type BuildSummary = Omit<BuildRecord, "logs" | "jobs"> & {
  jobs_count: number;
  /** the first job's compute profile */
  profile?: string;
  outputs_built: { id: string; name: string; status: string; rows?: number }[];
  errors: number;
  seconds: number | null;
};
export type BuildComparison = {
  build: BuildSummary;
  previous: BuildSummary | null;
  logic?: {
    hash?: string;
    previous_hash?: string;
    changed: boolean;
    version: BuildRecord["logic_version"];
    previous_version: BuildRecord["logic_version"];
    changes: { kind: "node" | "output" | "setting"; name: string; change: "added" | "removed" | "changed" }[];
  };
  inputs?: { id: string; name: string; kind?: string; version: string | null; previous: string | null; change: "added" | "removed" | "changed" | "same" }[];
  outputs?: { id: string; name: string; now?: { status: string; rows?: number; seconds?: number; error?: string }; previous?: { status: string; rows?: number; seconds?: number }; rows_delta: number | null }[];
  parameters?: { name: string; value?: string; previous?: string }[];
  seconds?: { now: number | null; previous: number | null };
};
export type LogicVersion = { id: string; at: string; author?: string; message?: string; used_by_build: boolean; latest: boolean };

export type ScheduleRunBuild = { id: string; status: string; trigger?: string; finished_at?: string | null; error?: string | null; run_setup?: { id: string; name: string } | null };
/** One firing of a schedule: started (with its builds), skipped (every output up to date) or ignored (paused, previous run in progress). */
export type ScheduleRun = {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  schedule_id: string;
  schedule_name: string;
  at: string;
  trigger: string;
  /** failed: it did not start (a user-scoped schedule whose owner is deactivated or lost access) */
  outcome: "started" | "skipped" | "ignored" | "failed";
  reason: string | null;
  builds: string[];
  build_status?: ScheduleRunBuild[];
  /** a started run: running until its builds finish, then their result */
  status?: "running" | "succeeded" | "failed" | "cancelled";
  skipped_outputs: { id: string; name: string; setup?: string | null; reason: string }[];
  excluded_outputs?: { id: string; name: string }[];
  /** outputs left out by the build scope, and who the run's builds ran as (user scope) */
  out_of_scope?: { id: string; name: string; reason: string }[];
  scope?: { kind: "project" | "user"; projects: string[]; run_as: string | null };
  warnings: string[];
};
export type ScheduleOwner = { id: string; username: string; display_name: string | null; status: "active" | "deactivated" | "deleted" };
export type ScheduleSummary = {
  pipeline_id: string;
  pipeline_name: string;
  path: string[];
  pipeline_type: string;
  schedule: Schedule;
  trigger: string;
  paused: { at: string; reason: string; build?: string } | null;
  failures_in_row: number;
  latched: Record<string, { at: string; reason: string }>;
  last_run: ScheduleRun | null;
  next_runs: string[];
  warnings: string[];
  scope: "project" | "user";
  scope_projects: { id: string; name: string }[];
  owner: ScheduleOwner | null;
};
export type ScheduleRole = "input" | "intermediate" | "output" | "excluded" | "job";
export type ScheduleVersion = { at: string; schedule: Schedule; changed: string[]; trigger: string };

export type OutputState = { rows: number; columns: number; itemId?: string; parentId?: string | null; path?: string; at: string; version: number; build: string; branch?: string };
/** A pipeline stream (legacy). `token` (the push token) comes only to those who may push (`can_push`), never in listings;
 * `item_id` / `project_id`: the Files item and Project whose roles and markings apply (none: the creator's own). */
export type StreamInfo = {
  id: string;
  name: string;
  schema: { name: string; type: string }[];
  throughput: string;
  created_at: string;
  token?: string;
  records?: number;
  last_record_at?: string | null;
  item_id?: string | null;
  project_id?: string | null;
  created_by?: string | null;
  can_push?: boolean;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_URL + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let msg = await res.text();
    try {
      msg = JSON.parse(msg).detail ?? msg;
    } catch {}
    throw new Error(typeof msg === "string" ? msg.slice(0, 400) : JSON.stringify(msg));
  }
  return res.json() as Promise<T>;
}

export const runtime = {
  build: (pipelineId: string, opts: { outputs?: string[]; branch?: string; trigger?: string; target?: string; replay?: boolean } = {}) =>
    req<BuildRecord>("/api/pipeline/builds", { method: "POST", body: JSON.stringify({ pipeline_id: pipelineId, branch: opts.branch ?? "main", outputs: opts.outputs ?? [], trigger: opts.trigger ?? "manual", target: opts.target ?? "single", replay: !!opts.replay }) }),
  builds: (pipelineId?: string, limit = 50) => req<BuildRecord[]>(`/api/pipeline/builds?${new URLSearchParams({ ...(pipelineId ? { pipeline_id: pipelineId } : {}), limit: String(limit) })}`),
  get: (buildId: string) => req<BuildRecord>(`/api/pipeline/builds/${buildId}`),
  cancel: (buildId: string) => req<BuildRecord>(`/api/pipeline/builds/${buildId}/cancel`, { method: "POST" }),
  state: (pipelineId: string) => req<Record<string, unknown>>(`/api/pipeline/state/${pipelineId}`),
  setState: (pipelineId: string, values: Record<string, unknown>) => req<Record<string, unknown>>(`/api/pipeline/state/${pipelineId}`, { method: "PUT", body: JSON.stringify({ values }) }),
  resetState: (pipelineId: string, key: string) => req<unknown>(`/api/pipeline/state/${pipelineId}/${encodeURIComponent(key)}`, { method: "DELETE" }),
  searchBuilds: (filters: Record<string, string | undefined>) =>
    req<{ builds: BuildSummary[]; pipelines: { id: string; name: string }[]; hidden_tests?: number }>(
      `/api/pipeline/build-search?${new URLSearchParams(Object.entries(filters).filter((e): e is [string, string] => !!e[1]))}`,
    ),
  compare: (buildId: string, withId?: string) => req<BuildComparison>(`/api/pipeline/builds/${buildId}/compare${withId ? `?with_id=${withId}` : ""}`),
  logsUrl: (buildId: string) => `${API_URL}/api/pipeline/builds/${buildId}/logs.txt`,
  logicVersions: (buildId: string) => req<LogicVersion[]>(`/api/pipeline/builds/${buildId}/versions`),
  rerun: (buildId: string, versionId?: string) => req<BuildRecord>(`/api/pipeline/builds/${buildId}/rerun`, { method: "POST", body: JSON.stringify({ version_id: versionId ?? null }) }),
  explain: (buildId: string) => req<{ answer: string }>(`/api/pipeline/builds/${buildId}/explain`, { method: "POST" }),
  /** usage hygiene: duplicate and overlapping schedules */
  schedulesReport: () =>
    req<{ schedules: number; findings: { kind: "duplicate" | "overlapping" | "shared_outputs"; pipeline_id: string; pipeline_name: string; outputs: string; message: string; schedules: { id: string; name: string; trigger: string }[] }[] }>(
      "/api/pipeline/schedules-report",
    ),
  schedules: (pipelineId?: string) => req<ScheduleSummary[]>(`/api/pipeline/schedules${pipelineId ? `?pipeline_id=${pipelineId}` : ""}`),
  runSchedule: (pipelineId: string, scheduleId: string, force?: boolean) =>
    req<ScheduleRun>(`/api/pipeline/schedules/${pipelineId}/${scheduleId}/run`, { method: "POST", body: JSON.stringify(force === undefined ? {} : { force }) }),
  resumeSchedule: (pipelineId: string, scheduleId: string) => req<ScheduleSummary>(`/api/pipeline/schedules/${pipelineId}/${scheduleId}/resume`, { method: "POST" }),
  setScheduleEnabled: (pipelineId: string, scheduleId: string, enabled: boolean) =>
    req<ScheduleSummary>(`/api/pipeline/schedules/${pipelineId}/${scheduleId}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  deleteSchedule: (pipelineId: string, scheduleId: string) => req<unknown>(`/api/pipeline/schedules/${pipelineId}/${scheduleId}`, { method: "DELETE" }),
  scheduleRuns: (pipelineId: string, scheduleId: string) => req<ScheduleRun[]>(`/api/pipeline/schedules/${pipelineId}/${scheduleId}/runs`),
  /** the schedule on the lineage graph: node id → input / intermediate / output / excluded / job */
  resolveSchedule: (pipelineId: string, scheduleId: string) =>
    req<{ roles: Record<string, ScheduleRole>; never_built: string[] }>(`/api/pipeline/schedules/${pipelineId}/${scheduleId}/resolve`),
  scheduleVersions: (pipelineId: string, scheduleId: string) => req<ScheduleVersion[]>(`/api/pipeline/schedules/${pipelineId}/${scheduleId}/versions`),
  nextRuns: (cron: string, tz: string) => req<{ next: string[] }>(`/api/pipeline/schedules/next?${new URLSearchParams({ cron, timezone_name: tz || "UTC" })}`),
  streams: () => req<StreamInfo[]>("/api/pipeline/streams"),
  createStream: (name: string, schema: { name: string; type: string }[], throughput = "normal", parentId?: string) =>
    req<StreamInfo>("/api/pipeline/streams", { method: "POST", body: JSON.stringify({ name, schema, throughput, parent_id: parentId ?? null }) }),
  stream: (id: string) => req<StreamInfo>(`/api/pipeline/streams/${id}`),
  records: (id: string, after = 0, limit = 1000) => req<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; seqs: number[]; last_seq: number }>(`/api/pipeline/streams/${id}/records?after=${after}&limit=${limit}`),
  push: (id: string, records: unknown) => req<{ pushed: number }>(`/api/pipeline/streams/${id}/records`, { method: "POST", body: JSON.stringify(records) }),
};

export const isActive = (b: BuildRecord) => b.status === "queued" || b.status === "running";

/** Deploy state of each output (output id → its last successful deploy), from the runtime state. */
export function outputStates(state: Record<string, unknown>, branch = "main"): Map<string, OutputState> {
  const m = new Map<string, OutputState>();
  const suffix = branch === "main" ? "" : `@${branch}`;
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith("output:")) continue;
    const key = k.slice(7);
    if (suffix ? key.endsWith(suffix) : !key.includes("@")) m.set(suffix ? key.slice(0, -suffix.length) : key, v as OutputState);
  }
  return m;
}
