/**
 * Client for streaming (api/streaming.py): ingest streams and push-based ingestion, streaming
 * syncs, streaming profiles (Control Panel) and stream monitoring (Data Health), following
 * Foundry's streaming resource guide.
 */
import { API_URL } from "./api";

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json", ...(rest.headers ?? {}) } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      const d = body.detail ?? message;
      message = typeof d === "string" ? d : (d.message ?? JSON.stringify(d));
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export type StreamColumn = { name: string; type: string };
/** partition key columns keep their records in order; a primary key makes the stream a CDC changelog */
export type StreamKeys = { partition: string[]; primary: { columns: string[]; deleted: string | null } | null };
export type IngestStream = {
  id: string;
  name: string;
  schema: StreamColumn[];
  throughput: "normal" | "high";
  configuration: Record<string, string>;
  keys: StreamKeys;
  /** what writes the stream: a pipeline's output, or nothing (push / syncs) */
  origin?: { kind: "pipeline"; pipeline_id: string; pipeline_name?: string; output_id: string; branch?: string } | null;
  view_id: string;
  views: { view_id: string; replaced_at: string }[];
  push_path: string;
  records: number;
  last_record_at: string | null;
  created_at: string;
  updated_at: string;
  token?: string;
  syncs?: { id: string; name: string; kind: string }[];
};
export type StreamRecords = { columns: StreamColumn[]; rows: Record<string, unknown>[]; seqs: number[]; last_seq: number; view_id: string };

export type SyncKind = "kafka" | "kinesis" | "sqs" | "pubsub" | "pi" | "mqtt" | "rabbitmq" | "ibmmq";
export type ProfileSettings = {
  parallelism: number;
  batch_records: number;
  max_record_bytes: number;
  buffer_records: number;
  checkpoint_interval_s: number;
  poll_timeout_s: number;
};
export type StreamingSync = {
  id: string;
  name: string;
  kind: SyncKind;
  config: Record<string, unknown>;
  secrets_set: string[];
  stream_id: string;
  profiles: string[];
  advanced: Partial<ProfileSettings>;
  project_id: string;
  // queued: waiting for room in its Project's resource queue (api/resource_queues.py)
  status: "queued" | "starting" | "running" | "retrying" | "stopped" | "failed";
  queue?: { name: string; ahead: number; in_use: number; vcpu_limit: number; vcpus: number; message: string } | null;
  desired: "running" | "stopped";
  error?: string | null;
  started_at?: string;
  last_checkpoint_at?: string;
  last_checkpoint_ms?: number;
  last_checkpoint_records?: number;
  settings: ProfileSettings;
  records_5m: number;
  lag: number | null;
  running: boolean;
  created_at: string;
  updated_at: string;
  checkpoint?: Record<string, unknown>;
};
export type SyncMetric = { minute: string; records: number; bytes: number; checkpoints: number; cp_failures: number; cp_ms_max: number; busy_ms: number; dropped: number; lag: number | null };

export type StreamingProfile = {
  id: string;
  name: string;
  description: string;
  settings: Partial<ProfileSettings>;
  restricted: boolean;
  projects: { id: string; name: string }[];
};
export type ProfilesInfo = { defaults: ProfileSettings; profiles: StreamingProfile[]; projects: { id: string; name: string }[]; default_project: string };

export type Severity = "low" | "medium" | "high" | "critical";
export type MonitorRule =
  | "records_ingested"
  | "checkpoint_liveness"
  | "last_checkpoint_duration"
  | "checkpoint_trigger_failures"
  | "consecutive_checkpoint_failures"
  | "total_lag"
  | "total_throughput"
  | "utilization"
  // dataset checks (api/health_checks.py)
  | "freshness"
  | "time_since_updated"
  | "data_freshness"
  | "row_count"
  | "columns"
  | "schema"
  | "build_status"
  | "up_to_date"
  // schedule checks
  | "schedule_status"
  | "schedule_duration"
  // Data Connection sync and export checks
  | "sync_status"
  | "sync_freshness"
  | "sync_row_count"
  // output monitors (api/timeseries.py)
  | "points_written"
  | "geotemporal_observations_sent";
/** dc_sync: a Data Connection sync ("source:<id>") or export ("export:<id>") */
export type MonitorResource = "stream" | "sync" | "dataset" | "schedule" | "dc_sync" | "timeseries_sync" | "geotemporal";
/** Settings of dataset checks beyond the threshold. */
export type MonitorConfig = {
  required?: string[];
  mode?: "additions" | "exact";
  columns?: { name: string; type: string }[];
  ignore_empty?: boolean;
  /** data freshness: the timestamp column whose newest value is checked */
  column?: string;
  /** sync row count: rows of the last successful run ("run", the default) or in the synced dataset / export target ("total") */
  measure?: "run" | "total";
};
export type Monitor = {
  id: string;
  view_id: string;
  name: string;
  /** dataset: a Files item id; schedule: "pipeline id/schedule id" */
  resource_type: MonitorResource;
  resource_id: string;
  resource_name: string;
  rule: MonitorRule;
  window_minutes: 5 | 30;
  threshold: number;
  threshold_max: number | null;
  severity: Severity;
  enabled: boolean;
  state: "ok" | "firing";
  value: number | null;
  checked_at: string | null;
  config?: MonitorConfig;
  /** resolve the alert when the check passes again (else by hand) */
  auto_resolve?: boolean;
  /** dataset and schedule checks: what the last check found */
  message?: string | null;
  /** passing again, its alert waiting to be resolved by hand */
  recovered?: boolean;
};
/** immediate: one notification per alert; hourly / daily: one digest of the alerts in between */
export type NotificationFrequency = "immediate" | "hourly" | "daily";
export type Subscription = {
  id: string;
  kind: "email" | "pagerduty" | "webhook";
  name: string;
  target: string;
  severities: Severity[];
  frequency: NotificationFrequency;
  digest_hour: number;
  digest_timezone: string;
  notify_resolved: boolean;
  last_digest_at?: string | null;
  next_digest_at?: string | null;
  /** alerts waiting for the next digest */
  queued?: number;
};
export type SubscriptionDelivery = Pick<Subscription, "frequency" | "digest_hour" | "digest_timezone" | "notify_resolved">;
export type Alert = {
  id: string;
  monitor_id: string;
  monitor: string;
  rule: MonitorRule;
  severity: Severity;
  value: number | null;
  threshold: number;
  state: "firing" | "resolved";
  fired_at: string;
  resolved_at: string | null;
  resource: string;
  resource_type?: MonitorResource;
  message?: string | null;
  resolved_by?: "hand";
};
export type MonitoringView = { id: string; name: string; description: string; created_at: string; monitors: number; firing: number };
export type MonitoringViewDetail = Omit<MonitoringView, "monitors" | "firing"> & { monitors: Monitor[]; subscriptions: Subscription[]; alerts: Alert[] };

export const RULE_LABEL: Record<MonitorRule, string> = {
  records_ingested: "Records ingested",
  checkpoint_liveness: "Checkpoint liveness",
  last_checkpoint_duration: "Last checkpoint duration",
  checkpoint_trigger_failures: "Checkpoint trigger failures",
  consecutive_checkpoint_failures: "Consecutive checkpoint failures",
  total_lag: "Total lag",
  total_throughput: "Total throughput",
  utilization: "Utilization",
  freshness: "Freshness",
  time_since_updated: "Time since last updated",
  data_freshness: "Data freshness (timestamp column)",
  row_count: "Row count",
  columns: "Required columns",
  schema: "Schema check",
  build_status: "Build status",
  up_to_date: "Up to date with inputs",
  schedule_status: "Schedule status",
  schedule_duration: "Schedule duration",
  sync_status: "Sync status",
  sync_freshness: "Sync freshness",
  sync_row_count: "Sync row count",
  points_written: "Points written to Time Series DB",
  geotemporal_observations_sent: "Geotemporal observations sent",
};

/** A stream archived into a dataset (api/stream_datasets.py). */
/** One archive run: an APPEND of the records above the last archived offset, or a full rewrite (SNAPSHOT) and why. */
export type StreamArchiveRun = {
  at: string;
  transaction: "APPEND" | "SNAPSHOT";
  written: number;
  rows: number;
  view_id: string;
  from_offset: number | null;
  to_offset: number;
  watermark: string | null;
  reason?: string;
  transaction_id?: string;
};
export type StreamArchive = {
  stream_id: string;
  folder_id: string;
  every_minutes: number;
  name: string;
  item_id?: string;
  last_seq?: number;
  last_at?: string;
  rows?: number;
  watermark?: string | null;
  history?: StreamArchiveRun[];
  path?: string[] | null;
  missing?: boolean;
  /** the user the scheduled archive runs as (who set it up) */
  owner?: string;
  /** the last scheduled run did not run as its owner (gone, deactivated, lost access): nothing was written */
  blocked?: { at: string; reason: string };
};
/** The streaming pipeline job writing a pipeline output stream (sampled from its checkpoints). */
export type StreamPipelineJob = {
  pipeline_id: string;
  pipeline_name: string;
  branch: string;
  build_id: string | null;
  status: string;
  running: boolean;
  started_at: string | null;
  error: string | null;
  last_checkpoint_at: string | null;
  checkpoint_age_s: number | null;
  lag: number | null;
  inputs: { id: string; name: string; kind: "stream" | "ingest"; offset: number; head: number; lag: number }[];
  records_out_build: number | null;
  records_in_total: number;
  records_in_5m: number;
  records_out_5m: number;
  events: { at: string; status: string; error: string | null; build_id: string; trigger?: string }[];
};
export type StreamDataset = { stream: IngestStream; archive: StreamArchive | null };
export type StreamJobs = {
  stream_id: string;
  since: string;
  syncs: {
    id: string;
    name: string;
    kind: string;
    status: StreamingSync["status"];
    desired: string;
    error: string | null;
    started_at?: string;
    last_checkpoint_at?: string;
    records_5m: number;
    lag: number | null;
    parallelism?: number;
    events: { at: string; status: string; error: string | null }[];
  }[];
  pipeline: { id: string; name: string } | null;
  pipeline_job: StreamPipelineJob | null;
  push: boolean;
};
export type StreamMetricKey = "records" | "throughput" | "lag" | "checkpoints" | "cp_failures" | "cp_ms_max" | "utilization" | "dropped" | "records_in" | "cp_age";
export type StreamMetrics = {
  metrics: { key: StreamMetricKey; label: string; unit: string; recommended: boolean; threshold: number | null; direction: "above" | "below" | null }[];
  series: ({ minute: string } & Partial<Record<StreamMetricKey, number | null>>)[];
  jobs: number;
  pipeline?: boolean;
};
export type TroubleshootStep = { key: string; title: string; state: "pass" | "fail" | "warn" | "info"; detail: string; metric: StreamMetricKey | null };

export const streaming = {
  byItem: (itemId: string) => req<StreamDataset>(`/api/streaming/streams/by-item/${itemId}`),
  archive: (id: string) => req<StreamDataset>(`/api/streaming/streams/${id}/archive`),
  setArchive: (id: string, body: { folder_id: string; every_minutes: number; name?: string }) => req<StreamDataset>(`/api/streaming/streams/${id}/archive`, { method: "PUT", json: body }),
  runArchive: (id: string) => req<StreamDataset>(`/api/streaming/streams/${id}/archive/run`, { method: "POST" }),
  jobs: (id: string, hours = 24) => req<StreamJobs>(`/api/streaming/streams/${id}/jobs?hours=${hours}`),
  streamMetrics: (id: string, minutes = 60) => req<StreamMetrics>(`/api/streaming/streams/${id}/metrics?minutes=${minutes}`),
  troubleshoot: (id: string) => req<{ steps: TroubleshootStep[]; healthy: boolean }>(`/api/streaming/streams/${id}/troubleshoot`),
  streams: () => req<IngestStream[]>("/api/streaming/streams"),
  stream: (id: string, revealToken = false) => req<IngestStream>(`/api/streaming/streams/${id}${revealToken ? "?reveal_token=true" : ""}`),
  createStream: (body: { name: string; schema: StreamColumn[]; throughput: string; configuration?: Record<string, string>; keys?: StreamKeys }) =>
    req<IngestStream>("/api/streaming/streams", { method: "POST", json: body }),
  records: (id: string, after = 0, limit = 1000, view: "changelog" | "current" = "changelog") =>
    req<StreamRecords>(`/api/streaming/streams/${id}/records?after=${after}&limit=${limit}${view === "current" ? "&view=current" : ""}`),
  setKeys: (id: string, keys: StreamKeys) => req<IngestStream>(`/api/streaming/streams/${id}/keys`, { method: "PUT", json: keys }),
  reset: (id: string, body: { schema?: StreamColumn[]; throughput?: string; configuration?: Record<string, string> }) =>
    req<IngestStream & { previous_view_id: string; restarted_syncs: string[]; not_restarted_syncs?: { id: string; reason: string }[] }>(`/api/streaming/streams/${id}/reset`, { method: "POST", json: body }),
  deleteStream: (id: string) => req<{ deleted: string }>(`/api/streaming/streams/${id}`, { method: "DELETE" }),
  push: (path: string, token: string, records: unknown) =>
    req<{ pushed: number }>(path, { method: "POST", json: records, headers: { Authorization: `Bearer ${token}` } }),

  syncs: () => req<StreamingSync[]>("/api/streaming/syncs"),
  sync: (id: string) => req<StreamingSync>(`/api/streaming/syncs/${id}`),
  createSync: (body: {
    name: string;
    kind: SyncKind;
    config: Record<string, unknown>;
    stream_id?: string | null;
    new_stream_name?: string | null;
    profiles: string[];
    advanced: Partial<ProfileSettings>;
    project_id?: string | null;
    start: boolean;
    /** markings for the sync and its stream, set before either exists (the caller holds them and may apply them) */
    markings?: string[];
  }) => req<StreamingSync>("/api/streaming/syncs", { method: "POST", json: body }),
  startSync: (id: string) => req<StreamingSync>(`/api/streaming/syncs/${id}/start`, { method: "POST" }),
  stopSync: (id: string) => req<StreamingSync>(`/api/streaming/syncs/${id}/stop`, { method: "POST" }),
  resetCheckpoint: (id: string) => req<StreamingSync>(`/api/streaming/syncs/${id}/reset-checkpoint`, { method: "POST" }),
  deleteSync: (id: string) => req<{ deleted: string }>(`/api/streaming/syncs/${id}`, { method: "DELETE" }),
  syncMetrics: (id: string, minutes = 60) => req<SyncMetric[]>(`/api/streaming/syncs/${id}/metrics?minutes=${minutes}`),

  profiles: () => req<ProfilesInfo>("/api/streaming/profiles"),
  addReference: (profile: string, projectId: string, controlPanel = false) =>
    req<ProfilesInfo>(`/api/streaming/profiles/${profile}/references`, { method: "POST", json: { project_id: projectId, control_panel: controlPanel } }),
  removeReference: (profile: string, projectId: string) => req<ProfilesInfo>(`/api/streaming/profiles/${profile}/references/${projectId}`, { method: "DELETE" }),
  resolveProfiles: (profiles: string[], advanced: Partial<ProfileSettings>, projectId?: string) =>
    req<{ project_id: string; settings: ProfileSettings }>("/api/streaming/profiles/resolve", { method: "POST", json: { profiles, advanced, project_id: projectId ?? null } }),

  rules: () => req<{ rules: { id: MonitorRule; resource_types: MonitorResource[]; unit: string; description: string }[]; severities: Severity[] }>("/api/streaming/monitoring/rules"),
  views: () => req<MonitoringView[]>("/api/streaming/monitoring/views"),
  view: (id: string) => req<MonitoringViewDetail>(`/api/streaming/monitoring/views/${id}`),
  createView: (name: string, description = "") => req<MonitoringView>("/api/streaming/monitoring/views", { method: "POST", json: { name, description } }),
  deleteView: (id: string) => req<{ deleted: string }>(`/api/streaming/monitoring/views/${id}`, { method: "DELETE" }),
  createMonitor: (viewId: string, body: Omit<Monitor, "id" | "view_id" | "resource_name" | "state" | "value" | "checked_at" | "message" | "recovered">) =>
    req<Monitor>(`/api/streaming/monitoring/views/${viewId}/monitors`, { method: "POST", json: body }),
  deleteMonitor: (id: string) => req<{ deleted: string }>(`/api/streaming/monitoring/monitors/${id}`, { method: "DELETE" }),
  monitorMetrics: (id: string, minutes = 120) => req<{ metric: string; points: { minute: string; value: number | null }[] }>(`/api/streaming/monitoring/monitors/${id}/metrics?minutes=${minutes}`),
  createSubscription: (viewId: string, body: { kind: Subscription["kind"]; name: string; target: string; severities: Severity[] } & Partial<SubscriptionDelivery>) =>
    req<Subscription>(`/api/streaming/monitoring/views/${viewId}/subscriptions`, { method: "POST", json: body }),
  updateSubscription: (id: string, body: Partial<SubscriptionDelivery> & { severities?: Severity[]; name?: string }) =>
    req<Subscription>(`/api/streaming/monitoring/subscriptions/${id}`, { method: "PUT", json: body }),
  sendDigest: (id: string) => req<{ sent: number }>(`/api/streaming/monitoring/subscriptions/${id}/send-digest`, { method: "POST" }),
  deleteSubscription: (id: string) => req<{ deleted: string }>(`/api/streaming/monitoring/subscriptions/${id}`, { method: "DELETE" }),
  evaluate: () => req<{ changes: Alert[] }>("/api/streaming/monitoring/evaluate", { method: "POST" }),
  resolveAlert: (id: string) => req<Alert>(`/api/streaming/monitoring/alerts/${id}/resolve`, { method: "POST" }),
};

export const pushUrl = (s: Pick<IngestStream, "push_path">) => API_URL + s.push_path;

export const curlPush = (s: Pick<IngestStream, "push_path" | "schema">, token = "<stream token>") =>
  `curl -X POST "${pushUrl(s)}" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '[{"value": ${JSON.stringify(
    Object.fromEntries((s.schema.length ? s.schema : [{ name: "message", type: "String" }]).map((c) => [c.name, c.type === "String" ? "text" : c.type === "Boolean" ? true : 1])),
  )}}]'`;
