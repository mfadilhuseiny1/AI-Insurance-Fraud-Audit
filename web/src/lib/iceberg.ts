/**
 * Client for Foundry Iceberg tables (api/iceberg_tables.py and api/iceberg_maintenance.py): the catalog browser, a
 * table's preview, details, snapshots, schema versions, branches, properties, history and maintenance, Control Panel's
 * Iceberg table settings, OAuth2 applications for external clients, and Data Connection syncs into Iceberg tables.
 */
import { API_URL } from "./api";

export const ICEBERG_TYPE = "application/vnd.apache.iceberg+json";

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/iceberg-tables" + path, {
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

export type IcebergListing = {
  id: string;
  rid: string;
  name: string;
  path: string[];
  size: number;
  updated_at: string;
  created_at: string;
  format_version?: number;
  records?: number;
  snapshots?: number;
  branches?: number;
  columns?: number;
  storage?: string;
  protected?: boolean;
  error?: string;
};

export type IcebergColumn = { id: number; name: string; type: string; required: boolean; doc?: string | null };
export type IcebergRef = {
  name: string;
  type: "branch" | "tag";
  snapshot_id: string | null;
  at: string | null;
  schema_id: number | null;
  min_snapshots_to_keep?: number | null;
  max_snapshot_age_ms?: number | null;
  max_ref_age_ms?: number | null;
};

export type IcebergTable = {
  id: string;
  rid: string;
  name: string;
  namespace: string[];
  identifier: string;
  uuid: string;
  location: string;
  metadata_location: string;
  format_version: number;
  branch: string;
  schema_id: number;
  columns: IcebergColumn[];
  identifier_fields: string[];
  partition_spec: { "spec-id"?: number; fields?: { name: string; transform: string; "source-id": number }[] } | null;
  sort_order: { "order-id"?: number; fields?: unknown[] } | null;
  properties: Record<string, string>;
  snapshot_count: number;
  current_snapshot_id: string | null;
  records: number;
  size: number;
  files: number;
  delete_files: number;
  storage: { id: string; name: string; provider: string };
  cse: boolean;
  protected: boolean;
  producer: { kind: string; id: string; name: string; repo?: string; repo_id?: string } | null;
  stop_propagating: string[];
  created_at: string;
  created_by: string;
  updated_at: string;
  branches: IcebergRef[];
  merge_on_read: boolean;
  path: string[];
  can_edit: boolean;
  can_own: boolean;
  markings: string[];
};

export type Snapshot = {
  snapshot_id: string;
  parent_id: string | null;
  timestamp_ms: number;
  at: string;
  operation: "append" | "overwrite" | "delete" | "replace";
  foundry_transactions: string[];
  schema_id: number | null;
  new_schema: boolean;
  total_size: number | null;
  total_records: number | null;
  total_files: number | null;
  total_delete_files: number | null;
  added_size: number | null;
  removed_size: number | null;
  added_records: number | null;
  deleted_records: number | null;
  added_files: number | null;
  deleted_files: number | null;
  user: string | null;
  job: string | null;
  markings: string[];
  marking_names?: string[];
  refs: string[];
};
export type TrendPoint = { at: string; total_size: number | null; total_records: number | null; total_files: number | null; schema_id: number | null; operation: string };
export type SnapshotsView = { snapshots: Snapshot[]; trend: TrendPoint[]; branches: IcebergRef[]; total: number };
export type SchemaVersion = {
  schema_id: number;
  previous_id: number | null;
  columns: IcebergColumn[];
  changes: { change: string; name: string; type?: string; from?: string; required?: boolean }[];
  identifier_fields: string[];
};
export type HistoryEntry = { at: string; user: string; kind: string; label: string; branch: string | null; snapshots: (string | number)[] };
export type Rows = { columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; count: number };

export type Procedure = "rewrite_data_files" | "rewrite_manifests" | "expire_snapshots" | "remove_orphan_files" | "custom_sql";
export type MaintenanceTask = {
  id: string;
  name: string;
  procedure: Procedure;
  params: Record<string, unknown>;
  schedule: { enabled: boolean; cron: string; timezone: string } | null;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
  category: "form" | "sql" | "data-altering";
  operations: string[];
};
export type MaintenanceJob = {
  id: string;
  task_id: string;
  procedure: Procedure;
  status: "running" | "succeeded" | "failed";
  trigger: "manual" | "schedule";
  user: string;
  started_at: string;
  finished_at: string | null;
  seconds?: number;
  result: unknown;
  error: string | null;
};
export type Maintenance = { tasks: MaintenanceTask[]; jobs: MaintenanceJob[]; protected: boolean; can_write: boolean; procedures: Procedure[]; dr_lookback_days: number };

export type Bucket = {
  id: string;
  name: string;
  provider: "local" | "s3" | "abfs" | "gcs";
  uri: string;
  fileio: Record<string, string>;
  access_delegation: "none" | "vended-credentials";
  source_id?: string | null;
  has_credentials?: boolean;
  credentials?: Record<string, string>;
};
export type Override = { target_id: string; scope?: "project" | "namespace"; storage: string | null; cse: boolean | null; name?: string; path?: string[] };
export type IcebergSettings = {
  enabled: boolean;
  allow_all_projects: boolean;
  default_storage: string;
  cse: boolean;
  dr_lookback_days: number;
  buckets: Bucket[];
  overrides: Override[];
  storages: { id: string; name: string; provider: string }[];
  can_edit: boolean;
};
export type ConnectInfo = { uri: string; oauth2_server_uri: string; default_namespace: string; spark_runtime: string; auth_enabled: boolean };
export type OAuthClient = { client_id: string; name: string; owner: string; scopes: string[]; created_at: string; last_used_at: string | null; client_secret?: string };
export type IcebergSync = {
  id: string;
  name: string;
  connection_id: string;
  connection: string;
  kind: string;
  database: string;
  schema: string;
  table: string;
  columns: string[];
  write_mode: "overwrite" | "append" | "update";
  primary_key: string[];
  cursor_column: string | null;
  table_id: string;
  table_name: string | null;
  table_path: string[];
  created_at: string;
  runs: { id: string; status: string; started_at: string; finished_at: string | null; rows: number | null; error: string | null; user: string; seconds?: number }[];
};
export type IcebergUsage = {
  tables: { id: string; name: string; path: string[]; bytes: number | null; byob: boolean; maintenance_compute_seconds: number }[];
  storage_bytes: number;
  gigabytes: number;
  gigabyte_months: number;
  days: number;
  maintenance_compute_seconds: number;
  sync_compute_seconds: number;
};

const q = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "") as [string, string][]).toString();
  return s ? `?${s}` : "";
};

export const iceberg = {
  list: (search = "") => req<IcebergListing[]>(`${q({ q: search })}`),
  create: (body: { parent_id: string | null; name: string; columns: { name: string; type: string; required?: boolean }[]; format_version?: number; partition_by?: string[]; identifier_columns?: string[] }) =>
    req<IcebergTable>("", { method: "POST", json: body }),
  get: (id: string, branch?: string) => req<IcebergTable>(`/${id}${q({ branch })}`),
  rows: (id: string, opts: { branch?: string; snapshot_id?: string; limit?: number; row_filter?: string } = {}) => req<Rows>(`/${id}/rows${q(opts)}`),
  metadata: (id: string, branch?: string) => req<{ metadata_location: string; metadata: Record<string, unknown> }>(`/${id}/metadata${q({ branch })}`),
  snapshots: (id: string, opts: { branch?: string; since?: string; until?: string } = {}) => req<SnapshotsView>(`/${id}/snapshots${q(opts)}`),
  schema: (id: string, schemaId: number) => req<SchemaVersion>(`/${id}/schemas/${schemaId}`),
  history: (id: string) => req<HistoryEntry[]>(`/${id}/history`),
  setProperties: (id: string, set: Record<string, string>, unset: string[] = []) => req<IcebergTable>(`/${id}/properties`, { method: "PUT", json: { set, unset } }),
  createRef: (id: string, name: string, type: "branch" | "tag", snapshotId?: string) =>
    req<SnapshotsView>(`/${id}/branches`, { method: "POST", json: { name, type, snapshot_id: snapshotId ?? null } }),
  deleteRef: (id: string, name: string) => req<SnapshotsView>(`/${id}/branches/${encodeURIComponent(name)}`, { method: "DELETE" }),
  rollback: (id: string, snapshotId: string) => req<SnapshotsView>(`/${id}/rollback`, { method: "POST", json: { snapshot_id: snapshotId } }),
  access: (id: string, change: { protected?: boolean; stop_propagating?: string[] }) => req<IcebergTable>(`/${id}/access`, { method: "PUT", json: change }),
  drop: (id: string) => req<{ deleted: string }>(`/${id}`, { method: "DELETE" }),
  maintenance: (id: string) => req<Maintenance>(`/${id}/maintenance`),
  addTask: (id: string, task: Pick<MaintenanceTask, "name" | "procedure" | "params" | "schedule">) => req<MaintenanceTask>(`/${id}/maintenance/tasks`, { method: "POST", json: task }),
  editTask: (id: string, taskId: string, task: Pick<MaintenanceTask, "name" | "procedure" | "params" | "schedule">) =>
    req<MaintenanceTask>(`/${id}/maintenance/tasks/${taskId}`, { method: "PUT", json: task }),
  deleteTask: (id: string, taskId: string) => req<{ deleted: string }>(`/${id}/maintenance/tasks/${taskId}`, { method: "DELETE" }),
  runTask: (id: string, taskId: string) => req<MaintenanceJob>(`/${id}/maintenance/tasks/${taskId}/run`, { method: "POST" }),
  connect: () => req<ConnectInfo>("/tools/connect"),
  clients: () => req<OAuthClient[]>("/tools/oauth-clients"),
  createClient: (name: string, scopes: string[]) => req<OAuthClient>("/tools/oauth-clients", { method: "POST", json: { name, scopes } }),
  deleteClient: (clientId: string) => req<{ deleted: string }>(`/tools/oauth-clients/${clientId}`, { method: "DELETE" }),
  settings: () => req<IcebergSettings>("/tools/settings"),
  saveSettings: (s: Omit<IcebergSettings, "storages" | "can_edit">) => req<IcebergSettings>("/tools/settings", { method: "PUT", json: s }),
  resolveStorage: (folderId: string | null) =>
    req<{ enabled: boolean; storage: { id: string; name: string; provider: string }; cse: boolean; format_version: number; override: Override | null }>(
      `/tools/resolve-storage${q({ folder_id: folderId })}`,
    ),
  syncs: () => req<IcebergSync[]>("/tools/syncs"),
  createSync: (body: {
    name: string;
    connection_id: string;
    database: string;
    schema: string;
    table: string;
    columns?: string[];
    write_mode: IcebergSync["write_mode"];
    primary_key?: string[];
    cursor_column?: string | null;
    initial_value?: string | null;
    parent_id: string | null;
    output_name?: string;
  }) => req<IcebergSync>("/tools/syncs", { method: "POST", json: body }),
  deleteSync: (id: string) => req<{ deleted: string }>(`/tools/syncs/${id}`, { method: "DELETE" }),
  runSync: (id: string) => req<IcebergSync["runs"][number]>(`/tools/syncs/${id}/run`, { method: "POST" }),
  usage: (days = 30) => req<IcebergUsage>(`/tools/usage${q({ days })}`),
};

export const PROCEDURES: { id: Procedure; label: string; hint: string }[] = [
  { id: "rewrite_data_files", label: "Rewrite data files", hint: "Compaction: rewrite small files (and apply delete files) into files of the target size — a replace snapshot" },
  { id: "rewrite_manifests", label: "Rewrite manifests", hint: "Consolidate manifests so scans plan faster — a replace snapshot with the same data files" },
  { id: "expire_snapshots", label: "Expire snapshots", hint: "Remove old snapshots from the metadata. Irreversible: no rollback or time travel to them" },
  { id: "remove_orphan_files", label: "Remove orphan files", hint: "Delete files no snapshot references, outside the disaster recovery window" },
  { id: "custom_sql", label: "Custom SQL", hint: "Iceberg procedures (CALL system.*), ALTER TABLE, or DML (INSERT, UPDATE, DELETE)" },
];
export const PROCEDURE_LABEL = Object.fromEntries(PROCEDURES.map((p) => [p.id, p.label])) as Record<Procedure, string>;

/** Foundry dataset transaction types for an Iceberg snapshot type. */
export const SNAPSHOT_TYPE_LABEL: Record<Snapshot["operation"], string> = { append: "Append", overwrite: "Overwrite", delete: "Delete", replace: "Replace" };

export const icebergHref = (id: string) => `/datasets/${id}`;

/** Binary (1024-based) units, as Iceberg's total-files-size is shown. */
export function iecBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[i]}`;
}
