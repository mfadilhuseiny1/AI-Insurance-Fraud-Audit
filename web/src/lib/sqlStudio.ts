/** SQL in Foundry (api/sql_studio.py): SQL Studio, the SQL console, worksheets and the AIP panel. */
import { API_URL } from "./api";

export type SqlMode = "data" | "object";
export type SqlColumn = { name: string; type: string; description?: string };
export type SqlResult = {
  columns: SqlColumn[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  limit?: number;
  ms: number;
  statement: "select" | "show_functions";
  resources: { ref: string; kind: string; item_id?: string; name?: string; branch?: string }[];
};
export type SqlResource = {
  kind: "dataset" | "View" | "Iceberg table" | "object type" | "link type";
  name: string;
  ref: string;
  path: string;
  item_id?: string;
  api_name?: string;
  columns?: SqlColumn[];
  count?: number;
};
export type WorksheetVersion = { id: string; at: string; by: string; sql: string; mode: SqlMode };
export type Worksheet = {
  id: string;
  name: string;
  owner: string;
  mode: SqlMode;
  sql: string;
  created_at: string;
  updated_at: string;
  item_id: string | null;
  location: "private" | "project";
  path?: string;
  version_count: number;
  can_edit: boolean;
  versions?: WorksheetVersion[];
  /** unsaved changes kept between sessions */
  draft?: { sql: string; mode: SqlMode; at: string };
};
export type AssistAnswer = { sql: string; explanation: string; schemas: string[] };

export const PREVIEW_LIMITS = [1000, 10000] as const;

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/sql" + path, {
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

export const sqlStudio = {
  query: (sql: string, mode: SqlMode, limit: number = PREVIEW_LIMITS[0]) => request<SqlResult>("/query", { method: "POST", json: { sql, mode, limit } }),
  format: (sql: string) => request<{ sql: string }>("/format", { method: "POST", json: { sql } }),
  resources: (mode: SqlMode, q = "") => request<SqlResource[]>(`/resources?mode=${mode}&q=${encodeURIComponent(q)}`),
  schema: (ref: string, mode: SqlMode) => request<{ ref: string; name?: string; columns: SqlColumn[]; rows?: number }>(`/schema?mode=${mode}&ref=${encodeURIComponent(ref)}`),
  worksheets: () => request<Worksheet[]>("/worksheets"),
  worksheet: (id: string) => request<Worksheet>(`/worksheets/${id}`),
  publishFunction: (id: string, body: { name: string; api_name: string; description?: string }) =>
    request<{ function_id: string; version: string; rid: string; output: string; inputs: { name: string; type: string; required: boolean }[]; breaking: unknown[] }>(
      `/worksheets/${id}/publish-function`,
      { method: "POST", json: body },
    ),
  publishedFunction: (id: string) =>
    request<{ function: { id: string; name: string; api_name: string; version: string; output: string; inputs: { name: string; type: string }[]; at: string; releases: number } | null }>(
      `/worksheets/${id}/function`,
    ),
  worksheetByItem: (itemId: string) => request<Worksheet>(`/worksheets/by-item/${itemId}`),
  createWorksheet: (body: { name: string; sql: string; mode: SqlMode; folder_id?: string | null }) => request<Worksheet>("/worksheets", { method: "POST", json: body }),
  saveWorksheet: (id: string, body: { sql: string; mode: SqlMode; name?: string; folder_id?: string | null }) => request<Worksheet>(`/worksheets/${id}`, { method: "PUT", json: body }),
  restore: (id: string, version: string) => request<Worksheet>(`/worksheets/${id}/restore`, { method: "POST", json: { version } }),
  deleteWorksheet: (id: string) => request<{ deleted: string }>(`/worksheets/${id}`, { method: "DELETE" }),
  saveDraft: (key: string, sql: string, mode: SqlMode) => request<{ ok: boolean }>(`/drafts/${encodeURIComponent(key)}`, { method: "PUT", json: { sql, mode } }),
  scratchpad: () => request<{ sql: string; mode: SqlMode }>("/drafts/scratchpad"),
  assist: (body: { prompt: string; sql: string; mode: SqlMode; refs?: string[]; history?: { role: string; content: string }[]; error?: string | null }) =>
    request<AssistAnswer>("/assist", { method: "POST", json: body }),
};

/** The starter query for a resource (SQL Studio's resource browser, the SQL console). */
export function starterQuery(r: Pick<SqlResource, "ref" | "kind">): string {
  return `SELECT *\nFROM \`${r.ref}\`\nLIMIT 100`;
}

/** Results as CSV (the rows shown in the preview). */
export function resultCsv(r: SqlResult): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [r.columns.map((c) => cell(c.name)).join(","), ...r.rows.map((row) => row.map(cell).join(","))].join("\n");
}
