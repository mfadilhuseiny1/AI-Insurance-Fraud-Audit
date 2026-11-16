/** Model Studio (api/model_studio.py): studios with a trainer and an output model, configuration versions, training runs. */
import { API_URL } from "./api";

export type Trainer = "regression" | "classification" | "time_series";
/** A setting of an algorithm template (api/ml_algorithms.py). */
export type AlgoParam = { key: string; label?: string; kind: "int" | "float" | "select" | "layers" | "bool"; default: unknown; min?: number; max?: number; options?: string[]; help?: string; optional?: boolean };
export type AlgorithmSpec = { key: string; name: string; description: string; library: string; params: AlgoParam[] };
/** A candidate of a configuration: an algorithm template and its settings (params.algorithms). */
export type AlgorithmChoice = { algorithm: string; params: Record<string, unknown>; label?: string };
export type TrainerSpec = { name: string; description: string; metrics: string[]; models: string[]; algorithms?: AlgorithmSpec[] };
export type StudioFilter = { column: string; op: "==" | "!=" | ">" | ">=" | "<" | "<=" | "is_null" | "not_null" | "in"; value?: unknown };
export type StudioConfig = {
  version: number; name: string; changelog: string; training_dataset_id: string; test_dataset_id: string | null; target: string; features: string[]; ignored: string[];
  timestamp: string | null; item_id: string | null; filters: StudioFilter[]; params: Record<string, unknown>; cpu: number; memory_gb: number; created_at: string; created_by: string;
};
export type ConfigInput = Omit<StudioConfig, "version" | "created_at" | "created_by">;
export type TrainingRun = {
  id: string; status: "running" | "succeeded" | "failed"; started_at: string; started_by: string; config_version: number; config_name: string; resources: { cpu: number; memory_gb: number };
  trigger?: string; version?: string; version_id?: string; experiment_id?: string; best_model?: string; metrics?: Record<string, number>; logs?: string; error?: string; ms?: number;
  data_read?: Record<string, DataRead>;
};
/** What a run read of a dataset: the rows / columns its scan returned with the pushed filters (a superset of the rows kept), and the rows left after every
 *  filter ran in the job. `source` says how it was read ("copied whole": nothing was pushed). Absent on runs from before filter pushdown. */
export type DataRead = {
  rows_total: number; rows_read: number; rows_kept?: number; columns_read: string[]; columns_total: number; filters_pushed: string[]; filters_after_read: string[];
  /** bytes_columns: compressed bytes of the columns read (an upper bound of the column data read; absent when copied whole). */
  bytes_total: number; bytes_columns?: number; source: string;
};
export type Studio = {
  id: string; name: string; trainer: Trainer; model_id: string; created_at: string; created_by: string; configs: StudioConfig[]; runs: TrainingRun[]; out_of_date: boolean;
  retrain_on_update?: boolean;
  model: { id: string; rid: string; name: string; path: string[]; versions: number; latest: string | null };
};
export type StudioSummary = Pick<Studio, "id" | "name" | "trainer" | "model_id" | "created_at"> & { configs: number; last_run: { status: string; started_at: string; version?: string } | null };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/model-studio" + path, {
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

export const modelStudio = {
  trainers: () => req<Record<Trainer, TrainerSpec>>("/trainers"),
  list: () => req<StudioSummary[]>(""),
  get: (id: string) => req<Studio>(`/${id}`),
  create: (body: { name: string; trainer: Trainer; folder_id: string; model_name: string }) => req<Studio>("", { method: "POST", json: body }),
  remove: (id: string) => req<{ deleted: string }>(`/${id}`, { method: "DELETE" }),
  saveConfig: (id: string, body: ConfigInput) => req<Studio>(`/${id}/config`, { method: "PUT", json: body }),
  run: (id: string) => req<Studio>(`/${id}/runs`, { method: "POST" }),
  schedule: (id: string, retrainOnUpdate: boolean) => req<Studio>(`/${id}/schedule`, { method: "PUT", json: { retrain_on_update: retrainOnUpdate } }),
};
