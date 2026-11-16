/**
 * Client for Dataset Preview (api/dataset_preview.py): a dataset's summary, preview rows, column statistics, schema
 * (CSV parsing options), uploads, history, branches, compare, Time Travel, custom metadata, issues and health.
 */
import { API_URL } from "./api";

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/dataset-preview" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    let detail: unknown = null;
    try {
      const body = await res.json();
      detail = body.detail;
      message = typeof body.detail === "string" ? body.detail : (body.detail?.message ?? JSON.stringify(body.detail));
    } catch {}
    throw Object.assign(new Error(message), { detail });
  }
  return res.json();
}

export type FoundryType = "STRING" | "BOOLEAN" | "BYTE" | "SHORT" | "INTEGER" | "LONG" | "FLOAT" | "DOUBLE" | "DECIMAL" | "DATE" | "TIMESTAMP";
export const FOUNDRY_TYPES: FoundryType[] = ["STRING", "BOOLEAN", "BYTE", "SHORT", "INTEGER", "LONG", "FLOAT", "DOUBLE", "DECIMAL", "DATE", "TIMESTAMP"];
export const TEXT_READER = "com.palantir.foundry.spark.input.TextDataFrameReader";
export const SOURCE_READER = "com.palantir.foundry.spark.input.DataSourceDataFrameReader";
export const PARQUET_READER = "com.palantir.foundry.spark.input.ParquetDataFrameReader";

export type SchemaField = { type: FoundryType; name: string; nullable: boolean | null; customMetadata: Record<string, unknown>; precision?: number | null; scale?: number | null; [k: string]: unknown };
export type TextParserParams = {
  parser: "CSV_PARSER" | "MULTILINE_CSV_PARSER" | "SIMPLE_PARSER" | "SINGLE_COLUMN_PARSER";
  charsetName: string;
  fieldDelimiter: string;
  recordDelimiter: string;
  quoteCharacter: string;
  dateFormat: Record<string, string>;
  skipLines: number;
  jaggedRowBehavior: "THROW_EXCEPTION" | "DROP_ROW";
  parseErrorBehavior: "THROW_EXCEPTION" | "REPLACE_WITH_NULL";
  addFilePath: boolean;
  addFilePathInsteadOfUri: boolean;
  addImportedAt: boolean;
  addByteOffset?: boolean;
  addRowNumber?: boolean;
  initialReadTimeout: string;
  nullValues: string[];
};
export type DatasetSchema = {
  fieldSchemaList: SchemaField[];
  dataFrameReaderClass: string;
  customMetadata: { textParserParams?: TextParserParams; format?: string; options?: Record<string, unknown>; [k: string]: unknown };
};

export type Column = { name: string; type: FoundryType; description?: string | null };
export type Transaction = { id: string; at: string; kind: string; rows: number | null; columns: string[]; size: number; source: Record<string, unknown>; kept: boolean; rolled_back?: boolean; aborted?: boolean };
export type LineageRef = { id: string; kind: string; kind_label?: string; name: string; link?: string; item_id?: string };
export type DatasetSummary = {
  id: string;
  name: string;
  kind: "parquet" | "file" | "raw" | "iceberg";
  parent_id: string | null;
  path: { id: string; name: string }[];
  size: number;
  files: number;
  created_at: string;
  updated_at: string;
  schema: DatasetSchema | null;
  schema_saved: boolean;
  schema_error?: string;
  reader: string | null;
  rows: number | null;
  columns: Column[];
  preview_error: string | null;
  preview_errors?: { file?: string; row?: number; error: string }[] | null;
  transactions: number;
  last_transaction: Transaction | null;
  custom_metadata: Record<string, string>;
  open_issues: number;
  branch: string;
  branches: { branch: string; item_id: string }[];
  /** set while only the first rows are shown: a big dataset (over 512 MB) whose on-disk copy is still being made (building) */
  partial?: {
    reason: string;
    rows_read: number;
    rows_total?: number;
    total_bytes: number;
    building?: { state: "running" | "done" | "error"; done_bytes: number; total_bytes: number; error?: string | null };
  } | null;
  /** a big dataset read out of core: every query (rows, filters, search, statistics, charts, SQL) covers all its rows */
  out_of_core?: OutOfCore | null;
  // replaced_by: an older writer of the dataset, kept as history (lineage keeps the current producer only)
  producers: { id: string; kind: string; name: string; at?: string; commit?: string; rows?: number; link?: string; replaced_by?: { id: string; name: string; at?: string } }[];
  inputs: LineageRef[];
  outputs: LineageRef[];
  schedules: { name?: string; enabled?: boolean; cron?: string | null; producer?: string; producer_link?: string }[];
  health: { status: "passing" | "failing"; results: { kind: string; ok: boolean; message: string }[] } | null;
  lineage_id?: string;
};
export type ColumnStats = {
  name: string;
  type: FoundryType;
  nulls: number;
  null_pct: number;
  distinct: number;
  description?: string;
  min?: unknown;
  max?: unknown;
  mean?: number | null;
  top: { value: unknown; count: number }[];
  open_issues: number;
};
export type FilterOp = "eq" | "neq" | "in" | "not_in" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "is_null" | "not_null";
export type Filter = { column: string; op: FilterOp; value?: unknown };
export type Sort = { column: string; desc?: boolean };
export type OutOfCore = { engine: "duckdb"; rows: number; row_groups: number; copy: boolean; note: string };
export type Rows = {
  columns: Column[];
  dataset_rows: number;
  total: number;
  offset?: number;
  rows: Record<string, unknown>[];
  partial?: DatasetSummary["partial"];
  out_of_core?: OutOfCore | null;
};
export type Chart =
  | { kind: "histogram"; temporal?: boolean; bins: { from: number | string; to: number | string; count: number }[] }
  | { kind: "values"; values: { value: unknown; count: number }[] };
export type Validation = { ok: boolean; rows: number; failed_rows: number; dropped_rows?: number; errors: { file?: string; row?: number; error: string }[]; problems: string[] };
export type Diff = {
  rows_a: number;
  rows_b: number;
  schema: { column: string; change: "added" | "removed" | "type"; type?: string; from?: string; to?: string }[];
  compared_columns: string[];
  key: string | null;
  key_unique?: boolean;
  added: number;
  removed: number;
  modified: number;
  added_rows: Record<string, unknown>[];
  removed_rows: Record<string, unknown>[];
  modified_rows: { key: unknown; before: Record<string, unknown>; after: Record<string, unknown>; cells: string[] }[];
  base?: string;
  other?: string;
};
export type Issue = { id: string; column: string | null; title: string; description: string; status: "open" | "resolved"; author: string; created_at: string; comments: { author: string; at: string; text: string }[]; assignee?: string | null; watchers?: string[]; author_id?: string };
export type DatasetListing = { id: string; name: string; kind: DatasetSummary["kind"]; size: number | null; updated_at: string; path: string[] };
export type BisectResult = { found: boolean; transaction?: string; index?: number; before?: unknown; after?: unknown; row?: Record<string, unknown>; note?: string; searched?: number };

const q = (o: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));
  return s.size ? `?${s}` : "";
};

export const datasetPreview = {
  list: (search = "") => req<DatasetListing[]>(`/datasets${q({ q: search })}`),
  create: (parentId: string | null, name: string) => req<DatasetSummary>("/datasets", { method: "POST", json: { parent_id: parentId, name } }),
  summary: (id: string) => req<DatasetSummary>(`/${id}`),
  rows: (id: string, body: { transaction?: string | null; filters?: Filter[]; sort?: Sort[]; offset?: number; limit?: number; search?: string }) =>
    req<Rows>(`/${id}/rows`, { method: "POST", json: body }),
  columns: (id: string, transaction?: string | null) => req<ColumnStats[]>(`/${id}/columns${q({ transaction })}`),
  chart: (id: string, body: { column: string; transaction?: string | null; filters?: Filter[]; bins?: number; search?: string }) =>
    req<Chart>(`/${id}/chart`, { method: "POST", json: body }),
  query: (id: string, sql: string, transaction?: string | null) =>
    req<{ columns: Column[]; rows: Record<string, unknown>[]; truncated: boolean }>(`/${id}/query`, { method: "POST", json: { sql, transaction } }),
  schema: (id: string) => req<{ schema: DatasetSchema; saved: boolean; editable: boolean }>(`/${id}/schema`),
  inferSchema: (id: string, options: Record<string, unknown>) => req<{ schema: DatasetSchema }>(`/${id}/schema/infer`, { method: "POST", json: { options } }),
  previewSchema: (id: string, schema: DatasetSchema) =>
    req<{ validation: Validation; columns: Column[]; rows: Record<string, unknown>[] }>(`/${id}/schema/preview`, { method: "POST", json: { schema } }),
  saveSchema: (id: string, schema: DatasetSchema, validate: boolean) => req<{ schema: DatasetSchema }>(`/${id}/schema`, { method: "PUT", json: { schema, validate } }),
  files: (id: string) => req<{ id: string; name: string; size: number; updated_at: string; content_type: string }[]>(`/${id}/files`),
  upload: async (id: string, file: File, opts: { sheet?: string; force?: boolean } = {}) => {
    const form = new FormData();
    form.append("file", file);
    if (opts.sheet) form.append("sheet", opts.sheet);
    if (opts.force) form.append("force", "true");
    return req<{ file: string; mode: "append" | "update"; schema_inferred: boolean }>(`/${id}/upload`, { method: "POST", body: form });
  },
  downloadUrl: (id: string, o: { format?: "csv" | "parquet"; delimiter?: string; bom?: boolean; transaction?: string | null } = {}) =>
    `${API_URL}/api/dataset-preview/${id}/download${q({ format: o.format, delimiter: o.delimiter, bom: o.bom, transaction: o.transaction })}`,
  history: (id: string) =>
    req<{ transactions: Transaction[]; jobs: { at: string; kind: string; status: string; text: string }[]; summary: { transactions: number; by_kind: Record<string, number>; job_statuses: Record<string, number>; kept: number; aborted?: number } }>(
      `/${id}/history`,
    ),
  createBranch: (id: string, name: string, transaction?: string | null) => req<{ branch: string; item_id: string }>(`/${id}/branches`, { method: "POST", json: { name, transaction } }),
  compare: (id: string, body: { base?: { item_id?: string; transaction?: string | null }; other: { item_id?: string; transaction?: string | null }; key?: string | null }) =>
    req<Diff>(`/${id}/compare`, { method: "POST", json: body }),
  range: (id: string, body: { from_transaction: string; to_transaction?: string | null; key?: string | null }) => req<Diff>(`/${id}/time-travel/range`, { method: "POST", json: body }),
  bisect: (id: string, body: { mode: "row_added" | "row_removed" | "value_changed"; key: string; key_value: unknown; column?: string; value?: unknown; transactions: string[] }) =>
    req<BisectResult>(`/${id}/time-travel/bisect`, { method: "POST", json: body }),
  saveMetadata: (id: string, fields: Record<string, string>) => req<Record<string, string>>(`/${id}/metadata`, { method: "PUT", json: { fields } }),
  issues: (id: string) => req<Issue[]>(`/${id}/issues`),
  reportIssue: (id: string, body: { column?: string | null; title: string; description?: string; assignee?: string | null }) => req<Issue>(`/${id}/issues`, { method: "POST", json: body }),
  updateIssue: (id: string, issueId: string, body: { status?: "open" | "resolved"; comment?: string; assignee?: string; watch?: boolean }) =>
    req<Issue>(`/${id}/issues/${issueId}`, { method: "PATCH", json: body }),
  people: () => req<{ id: string; label: string }[]>("/tools/people"),
  health: (id: string) => req<{ rules: { kind: string; enabled?: boolean }[]; evaluation: DatasetSummary["health"]; error?: string }>(`/${id}/health`),
  usage: (id: string) => req<{ points: { at: string; size: number; rows: number | null; kind: string }[]; current_size: number; versions_on_disk: number }>(`/${id}/usage`),
};

export const datasetHref = (id: string) => `/datasets/${id}`;
export const typeShort = (t: string) => ({ STRING: "Str", BOOLEAN: "Bool", BYTE: "Byte", SHORT: "Short", INTEGER: "Int", LONG: "Long", FLOAT: "Float", DOUBLE: "Dbl", DECIMAL: "Dec", DATE: "Date", TIMESTAMP: "Time" })[t] ?? t;
export const formatBytes = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
export const cellText = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
