/** Model deployments that run (api/model_deployments.py): direct model deployments, Modeling Objective live and
 *  batch deployments, model functions, logs, run history and the model inference history. */
import { API_URL } from "./api";
import type { ModelApi } from "./modelAssets";

/** Runtime configuration: the replica range (autoscaling when max is above min; min 0 stops after idle_s without a
 *  request), the autoscaling metric and its targets, vCPUs per replica (applied to a container model's containers). */
export type DeploymentConfig = { min_replicas: number; max_replicas: number; cpu: number; memory_gb: number; env: Record<string, string>; profiles: string[];
  scale_metric?: "in_flight" | "p95_latency"; target_in_flight?: number; target_p95_ms?: number; scale_window_s?: number; cooldown_s?: number; idle_s?: number };
/** One replica of a running live deployment (its own worker process and containers). Requests go to running replicas
 *  (an unhealthy one only when no other is left); one that is starting or stopping takes none (no process id). */
export type DeploymentReplica = { index: number; state?: "running" | "unhealthy" | "stopped" | "starting" | "stopping"; alive: boolean; healthy: boolean;
  pid: number | null; started_at: string; in_flight: number; requests: number; errors: number; failed_checks: number; containers: string[] };
export type ScalingEvent = { at: string; from: number; to: number; reason: string };
export type FunctionSignature = { inputs: Record<string, unknown>; output: Record<string, unknown> };
/** A row-wise function bound to an object type: the object input's properties fill these model columns ({column: property}). */
export type ObjectBinding = { object_type: string; object_type_id?: string; properties: Record<string, string>; input_name?: string };
export type ModelFunction = { name: string; api_name: string; row_wise: boolean; signature: FunctionSignature; model_version: string; version: number; object_binding?: ObjectBinding | null; versions: { version: number; at: string; model_version: string; row_wise: boolean }[] };
export type BatchRun = { id: string; at: string; trigger: string; status: "running" | "succeeded" | "failed"; error?: string; version?: string; rows_in?: number; rows_out?: number; ms?: number; output?: { item_id: string; name: string; transaction: string } };
/** A container of a container-backed model's live deployment, as the health monitor last saw it. */
export type DeploymentContainer = { name: string; image: string; state: string; running: boolean; exit_code: number | null; started_at: string | null;
  restarts: number; ports: Record<string, number>; answering: Record<string, boolean>; ready: boolean; replica?: number; cpus?: number | null; memory_bytes?: number | null };
export type Deployment = {
  id: string; rid: string; kind: "direct" | "objective" | "batch"; name: string; description?: string; status: "running" | "disabled";
  state: "running" | "idle" | "failed" | "disabled" | "restarting"; health?: string | null; error?: string | null;
  containers?: DeploymentContainer[]; containers_checked_at?: string | null; containers_error?: string | null; telemetry?: boolean;
  restart?: { attempts: number; reason: string | null; next_in_s: number }; restarts?: number; last_restart_at?: string; last_restart_reason?: string;
  rebuild_on_input?: boolean;
  replicas?: DeploymentReplica[]; replicas_desired?: number; scaling?: ScalingEvent[]; replica_replacements?: number; last_replacement_at?: string; last_replacement_reason?: string;
  scaling_now?: { desired: number; min: number; max: number; autoscaling: boolean; metric: string; load: number; p95_ms: number | null; last_change_s_ago: number; idle_s: number };
  model_id?: string; branch?: string; objective_id?: string; environment?: "staging" | "production";
  version?: string; loaded_version: string | null; started_at: string | null; config: DeploymentConfig; created_at: string; created_by: string;
  history: { at: string; version: string; from: string | null; by: string }[];
  metrics: { requests_24h: number; errors_24h: number; p50_ms: number | null; p95_ms: number | null; last_request_at: string | null };
  endpoint: string | null; function?: ModelFunction;
  inference_history?: { item_id: string; name: string; enabled: boolean; rows: number; created_at: string; owner?: string | null; error?: string; error_at?: string };
  /** the caller's role on the deployment (on its model / objective): viewer queries, editor configures, owner deletes */
  my_role?: "viewer" | "editor" | "owner";
  input_item_id?: string; input_name?: string; output_folder_id?: string; output_name?: string; output_item_id?: string; runs?: BatchRun[]; state_batch?: string;
  target?: { model_id: string; model: string; model_rid: string; version: string; version_rid: string; api: ModelApi } | null; target_error?: string;
};
export type DeploymentRun = { at: string; request_uuid: string; user: string; ok: boolean; ms: number; version: string; source: string; error: string | null; rows_in: number; replica?: number | null; retried?: number };
export type DeploymentLog = { at: string; level: string; message: string; request_uuid?: string; traceback?: string };
/** A span of one inference call (OpenTelemetry): times are milliseconds from the call's start. */
export type TelemetrySpan = { name: string; span_id: string; parent_id: string | null; trace_id: string; start_ms: number; ms: number; status: "UNSET" | "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>; events: { name: string; ms: number; attributes: Record<string, string> }[]; at: number };
export type DeploymentTrace = { at: string; request_uuid: string; trace_id: string; ok: boolean; ms: number; version: string; source: string; user: string; spans: TelemetrySpan[]; logs?: DeploymentLog[] };
export type QueryResult = { outputs: Record<string, unknown>; ms: number; logs: string; version: string; request_uuid: string };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/model-deployments" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const d = (await res.json()).detail;
      message = typeof d === "string" ? d : d?.error ? `${d.error}${d.stacktrace ? `\n\n${d.stacktrace}` : ""}` : JSON.stringify(d);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const modelDeployments = {
  list: (q: { model_id?: string; objective_id?: string } = {}) => req<Deployment[]>(`?${new URLSearchParams(q as Record<string, string>)}`),
  get: (id: string) => req<Deployment>(`/${id}`),
  createDirect: (modelId: string, branch = "master") => req<Deployment>("", { method: "POST", json: { model_id: modelId, branch } }),
  start: (id: string) => req<Deployment>(`/${id}/start`, { method: "POST" }),
  stop: (id: string) => req<Deployment>(`/${id}/stop`, { method: "POST" }),
  remove: (id: string) => req<{ deleted: string }>(`/${id}`, { method: "DELETE" }),
  config: (id: string, body: DeploymentConfig) => req<Deployment>(`/${id}/config`, { method: "PUT", json: body }),
  query: (id: string, inputs: Record<string, unknown>) => req<QueryResult>(`/${id}/query`, { method: "POST", json: { inputs } }),
  logs: (id: string, q = "") => req<DeploymentLog[]>(`/${id}/logs?limit=400${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  runs: (id: string) => req<DeploymentRun[]>(`/${id}/runs?limit=100`),
  traces: (id: string) => req<DeploymentTrace[]>(`/${id}/traces?limit=100`),
  trace: (id: string, requestUuid: string) => req<DeploymentTrace[]>(`/${id}/traces?request_uuid=${encodeURIComponent(requestUuid)}`),
  publishFunction: (id: string, body: { name: string; api_name: string; row_wise?: boolean | null; object_binding?: ObjectBinding | null }) => req<Deployment>(`/${id}/function`, { method: "POST", json: body }),
  removeFunction: (id: string) => req<Deployment>(`/${id}/function`, { method: "DELETE" }),
  createHistory: (id: string, folderId: string, name: string) => req<Deployment>(`/${id}/inference-history`, { method: "POST", json: { folder_id: folderId, name } }),
  toggleHistory: (id: string, enabled: boolean) => req<Deployment>(`/${id}/inference-history`, { method: "PUT", json: { enabled } }),
  syncHistory: (id: string) => req<Deployment>(`/${id}/inference-history/sync`, { method: "POST" }),
  removeHistory: (id: string) => req<Deployment>(`/${id}/inference-history`, { method: "DELETE" }),
  build: (id: string) => req<Deployment>(`/${id}/build`, { method: "POST" }),
  triggers: (id: string, rebuildOnInput: boolean) => req<Deployment>(`/${id}/triggers`, { method: "PUT", json: { rebuild_on_input: rebuildOnInput } }),
};

export const STATE_LABEL: Record<Deployment["state"], string> = { running: "Running", idle: "Idle (starts on the next request)", failed: "Failed", disabled: "Disabled", restarting: "Restarting" };
export const STATE_TONE: Record<Deployment["state"], string> = { running: "text-ok", idle: "text-warn", failed: "text-bad", disabled: "text-muted", restarting: "text-warn" };
