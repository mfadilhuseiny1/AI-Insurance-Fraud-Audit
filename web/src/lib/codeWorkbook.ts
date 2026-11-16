/** Code Workbook [Legacy] (api/code_workbook.py): workbooks of Python / SQL nodes over datasets in Files. */
import { API_URL, type DriveItem } from "./api";

export type NodeKind = "input" | "python" | "sql" | "r" | "manual" | "template" | "contour";
export type WbNode = {
  id: string;
  name: string;
  kind: NodeKind;
  inputs: string[];
  /** How each input (by node id) arrives. Python nodes: a pandas DataFrame (default) or a PySpark DataFrame. R nodes: a
   *  data.frame (default, stored as absent / "pandas") or, with "spark", a SparkR DataFrame (needs SparkR in the platform's R) */
  input_types?: Record<string, "pandas" | "spark">;
  code?: string;
  dataset_id?: string;
  // an imported folder of unstructured files (instead of a dataset)
  folder_id?: string;
  // the imported dataset's branch (default: the workbook's branch when the dataset has it, else master)
  dataset_branch?: string;
  folder_name?: string;
  // a Contour path's result (or a board's data) with parameter values
  contour?: { analysis_id?: string; path_id?: string; board_id?: string; params?: Record<string, string> };
  manual?: { columns: string[]; rows: unknown[][] };
  template?: { id: string; values: Record<string, string> };
  save?: boolean;
  dataset_out?: string;
  built_at?: string;
  description?: string;
  x?: number;
  y?: number;
};
export type TemplateParam = { name: string; type: "input" | "column" | "string" | "number"; default?: string };
export type WbTemplate = { id: string; name: string; language: "python" | "sql"; description?: string; params: TemplateParam[]; code: string };
/** A multi-node template: a node and its upstream, saved under a name in a workbook. */
export type GraphTemplate = { id: string; name: string; description?: string; nodes: WbNode[]; templates: WbTemplate[]; workbook_id?: string; workbook?: string };
export type WbBranch = { name: string; created_from?: string; updated_at?: string; merged_at?: string };
export type ConsoleEntry = { at: string; by: string; language: "python" | "sql"; code: string; ok: boolean };
export type Workbook = {
  item: DriveItem & { path?: { id: string; name: string }[] };
  title: string;
  description: string;
  branch: string;
  branches: WbBranch[];
  nodes: WbNode[];
  global_code: string;
  templates: WbTemplate[];
  suggested_templates: WbTemplate[];
  graph_templates: GraphTemplate[];
  console: ConsoleEntry[];
  /** the workbook's Spark profiles (the names Python transforms use) */
  spark_profiles?: string[];
  can_edit: boolean;
};
export type Preview = { columns: string[]; dtypes?: Record<string, string>; rows: Record<string, unknown>[]; total: number };
export type NodeResult = Partial<Preview> & { input?: boolean; dataset?: string; files?: string[]; dataset_branch?: string;
  /** a model output (or an imported saved model): its class, parameters and features */
  model?: { type: string; params?: Record<string, string>; feature_names_in?: string[]; classes?: string[] }; error?: string; traceback?: string; logs?: string; figures?: string[]; ms?: number; persisted?: boolean };
/** The Spark session a run or the console used (absent when no node asked for Spark): its profiles and the settings they change. */
export type SparkInfo = { profiles: string[]; conf: Record<string, string | null> };
export type RunResult = { nodes: Record<string, NodeResult>; global_error?: string; ms: number; saved?: Record<string, string>; spark?: SparkInfo | null };
export type ConsoleResult = { table?: Preview; value?: string; error?: string; traceback?: string; logs?: string; figures?: string[]; session?: boolean; names?: string[]; reused?: boolean; spark?: SparkInfo | null };
export type MergePlan = { take: Record<string, "branch" | "target">; conflicts: { id: string; name: string; branch: string; target: string }[]; global_conflict: boolean; target: string };

async function req<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const res = await fetch(API_URL + "/api/code-workbooks" + path, {
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    cache: "no-store",
    ...(init?.json !== undefined ? { body: JSON.stringify(init.json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export type Drift = { name: string; pinned: string | null; current: string | null };
export type WbSession = {
  id: string;
  at: string;
  kind: "interactive" | "batch";
  by: string;
  branch: string;
  status: string;
  compute: Record<string, unknown>;
  requested: { python?: string; packages?: string[]; pinned_session?: string | null; spark_profiles?: string[] };
  resolved: { python: string; packages: Record<string, string> };
};
type Draft = { nodes: WbNode[]; global_code: string; templates?: WbTemplate[] };
/** Whether the platform's R has the SparkR package (R nodes' Spark inputs need it); `problem` says what is missing. */
export type SparkRStatus = { r: string | null; installed: boolean; version?: string | null; library?: string; spark?: string | null; problem?: string };
export type WbEnvironment = {
  python: string;
  packages: { name: string; version: string }[];
  spark: boolean;
  timeout_s: number;
  notes: string;
  spark_profiles: string[];
  /** what the profiles resolve to (driver_memory_mb, executor_cores, shuffle_partitions, ...) */
  spark_settings: Record<string, unknown>;
  spark_profiles_problem: string | null;
  available_profiles: { name: string; sets: Record<string, unknown> }[];
  r: string | null;
  sparkr: SparkRStatus;
};

export const codeWorkbooks = {
  list: () => req<(DriveItem & { path?: { id: string; name: string }[] })[]>(""),
  create: (title: string, datasets: string[], parentId?: string | null) => req<Workbook>("", { json: { title, datasets, parent_id: parentId ?? undefined } }),
  get: (id: string, branch = "master") => req<Workbook>(`/${id}?branch=${encodeURIComponent(branch)}`),
  graphTemplates: () => req<GraphTemplate[]>("/graph-templates"),
  save: (id: string, branch: string, body: Draft & { title?: string; graph_templates?: GraphTemplate[] }) => req<Workbook>(`/${id}`, { method: "PUT", json: { branch, ...body } }),
  run: (id: string, branch: string, nodes: string[] | null, draft: Draft) => req<RunResult>(`/${id}/run`, { json: { branch, nodes, draft } }),
  build: (id: string, branch: string, nodes?: string[]) => req<RunResult>(`/${id}/build`, { json: { branch, nodes } }),
  console: (id: string, branch: string, language: "python" | "sql", code: string, nodes: string[] | null, draft: Draft) =>
    req<ConsoleResult>(`/${id}/console`, { json: { branch, language, code, nodes, draft } }),
  restartSession: (id: string, branch: string) => req<{ stopped: boolean }>(`/${id}/console/session?branch=${encodeURIComponent(branch)}`, { method: "DELETE" }),
  branch: (id: string, name: string, source: string) => req<Workbook>(`/${id}/branches`, { json: { name, source } }),
  mergePlan: (id: string, name: string) => req<MergePlan>(`/${id}/branches/${encodeURIComponent(name)}/merge`, { json: { dry_run: true } }),
  merge: (id: string, name: string, resolutions: Record<string, "branch" | "target">) => req<Workbook>(`/${id}/branches/${encodeURIComponent(name)}/merge`, { json: { resolutions } }),
  sessions: (id: string) => req<{ sessions: WbSession[]; pinned_session: string | null; drift: Drift[] }>(`/${id}/sessions`),
  compareSessions: (id: string, a: string, b = "current") =>
    req<{ resolved: { name: string; a: string | null; b: string | null }[]; compute: { key: string; a: unknown; b: unknown }[] }>(`/${id}/sessions/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  pinSession: (id: string, sid: string, pin: boolean) => req<{ pinned_session: string | null; drift: Drift[] }>(`/${id}/sessions/${sid}/pin`, { json: { pin } }),
  environment: (id: string) => req<WbEnvironment>(`/${id}/environment`),
  /** Update the Spark environment: unknown or contradicting profiles are refused with the reason; a change restarts the console sessions. */
  setEnvironment: (id: string, spark_profiles: string[]) =>
    req<WbEnvironment & { changed: boolean; sessions_restarted: number }>(`/${id}/environment`, { method: "PUT", json: { spark_profiles } }),
  export: (id: string, branch: string, name: string) => req<{ repo_id: string; file: string; transforms: string[] }>(`/${id}/export`, { json: { branch, name } }),
};
