/** Preparation [Sunset] (api/preparation.py) and Project references (api/project_references.py). */
import { API_URL } from "./api";

export type ChangeType =
  | "trim"
  | "empty_to_null"
  | "normalize_strings"
  | "change_case"
  | "change_type"
  | "new_value"
  | "extract"
  | "normalize_column_names"
  | "rename"
  | "delete_columns"
  | "remove_rows"
  | "keep_rows"
  | "add_column"
  | "apply_expression"
  | "split";
export type Change = { id?: string; type: ChangeType; params: Record<string, unknown>; at?: string; by?: string };
export type PrepOutput = { item_id: string; mode: "updating" | "one_off"; saved_at: string; rows: number; changes: number; input_updated_at: string | null };
export type Preparation = {
  id: string;
  name: string;
  path: string[];
  autosaved: boolean;
  input: { item_id: string };
  input_item: { id: string; name: string; path: string[]; updated_at: string } | null;
  changes: Change[];
  outputs: PrepOutput[];
  saved_versions: { id: string; at: string; by: string; output_item_id: string; changes: Change[]; branch?: string }[];
  /** the output dataset branch saves go to (branch copies under _branches/<branch>/) */
  branch: string;
  branches: string[];
  project_scoped: boolean;
  can_edit: boolean;
  updated_at?: string;
  scope: { project: { id: string; name: string } | null; input_in_scope: boolean; input_project: { id: string; name: string } | null; problems: string[] };
};
export type PrepPreview = {
  columns: { name: string; type: string }[];
  names: string[];
  rows: unknown[][];
  row_count: number;
  focused_rows: number | null;
  applied: number;
  errors: Record<string, string>;
};
export type Flag = { kind: string; label: string; count: number; action: string | null; change: Change | null };
export type ColumnStats = {
  column: string;
  type: string;
  rows: number;
  nulls: number;
  distinct: number;
  top: { value: string | null; count: number }[];
  flags: Flag[];
  needs_trim?: number;
  empty?: number;
  uppercase?: number;
  lowercase?: number;
  mixed_case?: number;
  numeric_like?: number;
  min?: unknown;
  max?: unknown;
  mean?: number | null;
};
export type Focus = { column: string; values: (string | null)[]; nulls?: boolean } | null;

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
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

const P = "/api/preparation";
export const preparation = {
  list: () => req<{ id: string; name: string; path: string[]; changes: number; outputs: number; updated_at: string; autosaved: boolean }[]>(P),
  create: (input_item_id: string, folder_id?: string) => req<Preparation>(P, { method: "POST", json: { input_item_id, folder_id } }),
  get: (id: string) => req<Preparation>(`${P}/${id}`),
  save: (id: string, body: { changes: Change[]; input_item_id?: string; project_scoped?: boolean }) => req<Preparation>(`${P}/${id}`, { method: "PUT", json: body }),
  saveAs: (id: string, name: string, folder_id: string) => req<Preparation>(`${P}/${id}/save-as`, { method: "POST", json: { name, folder_id } }),
  duplicate: (id: string) => req<Preparation>(`${P}/${id}/duplicate`, { method: "POST" }),
  preview: (id: string, body: { upto?: number | null; focus?: Focus; changes?: Change[] }) => req<PrepPreview>(`${P}/${id}/preview`, { method: "POST", json: body }),
  stats: (id: string, column: string, body: { upto?: number | null; changes?: Change[] }) =>
    req<ColumnStats>(`${P}/${id}/stats?column=${encodeURIComponent(column)}`, { method: "POST", json: body }),
  saveDataset: (id: string, body: { folder_id: string; name: string; mode: "updating" | "one_off" }) =>
    req<Preparation & { saved: { item_id: string; rows: number } }>(`${P}/${id}/save-dataset`, { method: "POST", json: body }),
  update: (id: string, outputId: string) => req<Preparation>(`${P}/${id}/outputs/${outputId}/update`, { method: "POST" }),
  restore: (id: string, version_id: string) => req<Preparation>(`${P}/${id}/restore`, { method: "POST", json: { version_id } }),
  createBranch: (id: string, name: string) => req<Preparation>(`${P}/${id}/branches`, { method: "POST", json: { name } }),
  switchBranch: (id: string, name: string) => req<Preparation>(`${P}/${id}/branch`, { method: "PUT", json: { name } }),
  saveToBranch: (id: string, outputId: string, branch: string) =>
    req<Preparation & { saved: { item_id: string; rows: number; branch: string } }>(`${P}/${id}/outputs/${outputId}/save-branch`, { method: "POST", json: { branch } }),
  addReference: (project_id: string, item_id: string) => req<unknown>("/api/project-references", { method: "POST", json: { project_id, item_id } }),
};

/** A one-line description of a change, for the changelog. */
export function describe(c: Change): string {
  const p = c.params as Record<string, string & string[] & Record<string, string>>;
  switch (c.type) {
    case "trim":
      return `Trim whitespace in ${p.column}`;
    case "empty_to_null":
      return `Set empty values of ${p.column} to null`;
    case "normalize_strings":
      return `Normalize ${p.columns?.length ? p.columns.join(", ") : "all string columns"} (${(p.ops ?? ["trim"]).join(", ")})`;
    case "change_case":
      return `${p.case === "title" ? "Title case" : p.case === "lower" ? "Lowercase" : "Uppercase"} ${p.column}`;
    case "change_type":
      return `Change ${p.column} type to ${p.to}`;
    case "new_value": {
      const vals = (p.values ?? []) as unknown as (string | null)[];
      const v = p.value === "/NULL" ? "null" : JSON.stringify(p.value);
      return vals.length || p.nulls ? `Set ${vals.length + (p.nulls ? 1 : 0)} selected value(s) of ${p.column} to ${v}` : `Set every ${p.column} to ${v}`;
    }
    case "extract":
      return p.kind === "regex" ? `Extract ${p.pattern} from ${p.column}` : `Extract characters ${p.start}–${p.end} of ${p.column}${p.into && p.into !== p.column ? ` into ${p.into}` : ""}`;
    case "normalize_column_names":
      return "Normalize column names (snake case)";
    case "rename":
      return `Rename ${Object.entries(p.renames ?? {})
        .map(([a, b]) => `${a} → ${b}`)
        .join(", ")}`;
    case "delete_columns":
      return `Delete ${(p.columns ?? []).join(", ")}`;
    case "remove_rows":
    case "keep_rows": {
      const vals = (p.values ?? []) as unknown as (string | null)[];
      return `${c.type === "remove_rows" ? "Remove" : "Keep only"} rows where ${p.column} ${p.nulls && !vals.length ? "is null" : `is ${vals.map((v) => (v === null ? "null" : JSON.stringify(v))).join(" or ")}`}`;
    }
    case "add_column":
      return `Add ${p.name} = ${p.expression}`;
    case "apply_expression":
      return `Apply ${p.expression} to ${p.column}`;
    case "split":
      return `Split ${p.column} on ${JSON.stringify(p.delimiter ?? " ")} into ${(p.into ?? []).join(", ")}`;
  }
}

export const TYPES: [string, string][] = [
  ["string", "String"],
  ["integer", "Integer"],
  ["double", "Double"],
  ["date", "Date (whole days)"],
  ["timestamp", "Timestamp"],
  ["boolean", "Boolean"],
];
