/** Client for dataset and schedule health checks and expectation results (api/health_checks.py). */
import { API_URL } from "./api";

export type CheckResult = { id?: string; kind: string; ok: boolean; value: number | null; message: string; failing_since?: string | null };
export type DatasetHealth = { item_id: string; name: string; path: string[]; status: "passing" | "failing"; results: CheckResult[]; checked_at: string };
export type ExpectationRow = {
  build_id: string;
  /** null for Code Repositories transforms (source "code") */
  pipeline_id: string | null;
  source?: "code";
  repo_id?: string;
  transform?: string;
  pipeline_name: string;
  at: string;
  branch: string;
  build_status: string;
  /** the output, or the input of a pre-condition */
  target: string;
  target_kind: "output" | "input";
  id: string;
  ok: boolean;
  message: string;
  mode?: "abort" | "warn";
  kind?: string;
};
export type HealthResources = {
  datasets: { id: string; name: string; path: string }[];
  schedules: { id: string; name: string }[];
  /** Data Connection syncs ("source:<id>") and exports ("export:<id>") */
  syncs?: { id: string; name: string }[];
};

export type SyncCheckKind = "sync_status" | "sync_freshness" | "sync_row_count";
/** A check set on a Data Connection sync ("source:<id>") or export ("export:<id>"); subscribers hear in the app when it fails or passes again. */
export type SyncCheck = {
  id: string;
  resource_id: string;
  kind: SyncCheckKind;
  label: string;
  /** freshness: {hours}; row count: {min, max, measure: "run" (last successful run) | "total" (dataset / export target)} */
  config: { hours?: number; min?: number | null; max?: number | null; measure?: "run" | "total" };
  enabled: boolean;
  subscribed: boolean;
  subscribers: number;
  created_at: string;
  status: "passing" | "failing" | "disabled" | "unknown";
  ok: boolean | null;
  value: number | null;
  message: string | null;
  failing_since: string | null;
  checked_at: string | null;
};
export type SyncCheckStatus = { resource_id: string; checks: number; failing: SyncCheckKind[]; status: "passing" | "failing"; checked_at: string | null };
export type SyncCheckInput = { resource_id: string; kind: SyncCheckKind; hours?: number; min?: number; max?: number; measure?: "run" | "total" };
export type SyncCheckChange = {
  hours?: number;
  min?: number;
  max?: number;
  clear_min?: boolean;
  clear_max?: boolean;
  measure?: "run" | "total";
  enabled?: boolean;
  subscribed?: boolean;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_URL + path, init ? { cache: "no-store", ...init } : undefined);
  if (!res.ok) {
    let msg = await res.text();
    try {
      msg = JSON.parse(msg).detail ?? msg;
    } catch {}
    throw new Error(typeof msg === "string" ? msg.slice(0, 400) : JSON.stringify(msg));
  }
  return res.json() as Promise<T>;
}

export const health = {
  datasets: (refresh = false) => req<DatasetHealth[]>(`/api/health/datasets${refresh ? "?refresh_now=true" : ""}`),
  expectations: (limit = 200) => req<ExpectationRow[]>(`/api/health/expectations?limit=${limit}`),
  resources: () => req<HealthResources>("/api/health/resources"),
};

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Checks set on Data Connection syncs and exports (api/health_checks.py, /api/health/syncs). */
export const syncChecks = {
  /** the checks of one sync or export, evaluated now */
  list: (resourceId: string) => req<{ resource_id: string; name: string; checks: SyncCheck[] }>(`/api/health/syncs/checks?resource_id=${encodeURIComponent(resourceId)}`, { cache: "no-store" }),
  /** per sync / export with checks: passing or failing as last evaluated */
  status: () => req<SyncCheckStatus[]>("/api/health/syncs/status", { cache: "no-store" }),
  create: (input: SyncCheckInput) => req<SyncCheck>("/api/health/syncs/checks", json("POST", input)),
  update: (id: string, change: SyncCheckChange) => req<SyncCheck>(`/api/health/syncs/checks/${encodeURIComponent(id)}`, json("PUT", change)),
  remove: (id: string) => req<{ deleted: string }>(`/api/health/syncs/checks/${encodeURIComponent(id)}`, json("DELETE")),
};
