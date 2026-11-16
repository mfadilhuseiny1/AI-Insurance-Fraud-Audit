/** Model Integration overviews (api/model_overview.py): live counts, adapters in use, the foundry_ml migration helper. */
import { API_URL } from "./api";
import type { ModelApi } from "./modelAssets";
import type { Release } from "./modelingObjectives";

export type Overview = {
  models: { total: number; trained: number; external: number; container: number };
  versions: number; experiments: number; evaluation_sets: number; evaluations: number; studios: number;
  deployments: { total: number; running: number; live: number; batch: number; functions: number };
  objectives: { id: string; name: string; submissions: number; staging: Release | null; production: Release | null; evaluation_datasets: number; evaluation_libraries: number;
    evaluation_results: number; evaluation_failures: number; last_built: string | null; updated_at: string }[];
  latest_versions: { model_id: string; model: string; kind: string; version: string; branch: string | null; created_at: string; source: string | null }[];
  evaluation_sets_by_model: { model_id: string; model: string; sets: string[]; last: string | null }[];
};
export type AdapterUse = {
  adapter: string; class: string; module: string; kinds: string[]; serializers: string[]; repo_id: string | null; last_used: string; api?: ModelApi;
  models: { model_id: string; model: string; kind: string; versions: string[] }[];
};
export type MigrationFinding = {
  key: string; resource: "Code Repository" | "Code Workbook"; resource_id: string; resource_name: string; file: string | null;
  hits: { line: number; kind: string; what: string; code: string; node?: string }[]; suggestion: string;
  status: "needs_migration" | "completed" | "ignored"; replacement: { id: string; name: string; kind: string | null } | null; note: string; updated_at: string | null;
};
export type ExperimentRow = { model_id: string; model: string; id: string; name: string; version: string | null; created_at: string; params: Record<string, unknown>; metrics: Record<string, number> };
export type EvaluationRow = { model_id: string; model: string; id: string; name: string; set: string; version: string | null; created_at: string; metrics: Record<string, number> };
export type Migration = { findings: MigrationFinding[]; counts: Record<MigrationFinding["status"], number>; dataset_backed_models: number; note: string };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/model-overview" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const d = (await res.json()).detail;
      message = typeof d === "string" ? d : JSON.stringify(d);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

/** A model's way through Model Integration (GET /api/model-overview/lifecycle). */
export type LifecycleRow = {
  id: string; name: string; kind: string; path: string[]; test: boolean; updated_at?: string;
  trained: { versions: number; latest: string | null; at: string | null; app: string | null; link: string | null };
  evaluated: { charts: boolean; evaluation_sets: number };
  benchmarks: { id: string; name: string; evaluated: boolean; released: boolean }[];
  deployed: { live: number; running: number; batch: number; functions: string[] };
};

export const modelOverview = {
  get: () => req<Overview>(""),
  lifecycle: () => req<LifecycleRow[]>("/lifecycle"),
  adapters: () => req<AdapterUse[]>("/adapters"),
  experiments: () => req<{ experiments: ExperimentRow[]; evaluations: EvaluationRow[] }>("/experiments"),
  migration: () => req<Migration>("/migration"),
  setMigration: (key: string, body: { status: MigrationFinding["status"]; replacement_model_id?: string | null; note?: string }) =>
    req<Migration>(`/migration/${key}`, { method: "PUT", json: body }),
};
