/** Container-backed models (api/model_assets.py): a model owning a Docker Artifacts repository, versions pairing
 *  images (with their runtime settings) and a container model adapter, test runs. */
import { API_URL } from "./api";
import type { ArtifactsRepoDetail } from "./containers";

export type ModelImage = { image: string; tag: string; digest: string; port: number | null; ports: number[]; env: Record<string, string>; args: string[]; command: string[] | null; memory: string | null; user: string };
export type ModelVersion = {
  id: string;
  rid: string;
  version: string;
  description: string;
  images: ModelImage[];
  adapter: { repo_id: string; file: string; class: string; commit: string | null };
  telemetry: boolean;
  created_at: string;
  created_by: string;
};
export type ModelAsset = {
  id: string; rid: string; name: string; description: string; repo_id: string; created_at: string; created_by: string; versions: number; latest: string | null;
  /** "container": images in a Docker repository; "python": trained in a Python transform (ModelOutput) */
  kind: "container" | "python"; item_id: string | null; path: string[]; updated_at: string;
};
export type ModelAssetDetail = ModelAsset & { versions_detail: ModelVersion[]; repository: ArtifactsRepoDetail };
export type VersionBody = {
  images: { image: string; tag: string; port?: number | null; env?: Record<string, string>; args?: string[]; command?: string[] | null; memory?: string | null }[];
  adapter_repo_id: string;
  adapter_file: string;
  adapter_class: string;
  bump: "major" | "minor" | "patch";
  description?: string;
  telemetry?: boolean;
};
export type PredictResult = { version: string; ok: boolean; outputs: Record<string, unknown>; logs: string };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/model-assets" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      const d = body.detail;
      message = typeof d === "string" ? d : d?.error ? `${d.error}${d.logs ? `\n\n${d.logs}` : ""}` : JSON.stringify(d);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const modelAssets = {
  list: (kind?: "container" | "python") => req<ModelAsset[]>(kind ? `?kind=${kind}` : ""),
  get: (id: string) => req<ModelAssetDetail>(`/${id}`),
  create: (body: { name: string; folder_id: string; description?: string }) => req<ModelAssetDetail>("", { method: "POST", json: body }),
  remove: (id: string) => req<{ deleted: string }>(`/${id}`, { method: "DELETE" }),
  createVersion: (id: string, body: VersionBody) => req<ModelVersion>(`/${id}/versions`, { method: "POST", json: body }),
  predict: (id: string, versionId: string, inputs: Record<string, unknown>) => req<PredictResult>(`/${id}/versions/${versionId}/predict`, { method: "POST", json: { inputs } }),
};

// -- models trained in Python transforms (palantir_models ModelOutput): versions, experiments, evaluations --------

export type ApiColumn = { name: string; type: string; required: boolean };
export type ApiItem = { name: string; type: "tabular" | "parameter" | "filesystem" | "media_reference" | "object" | "object_set"; df_type?: string; columns?: ApiColumn[]; value_type?: string; default?: unknown; object_type?: string };
export type ModelApi = { inputs: ApiItem[]; outputs: ApiItem[] };
export type TrainedVersion = {
  id: string; rid: string; version: string; branch: string; kind: "python"; description: string; api: ModelApi;
  adapter: { module: string; class: string; root: string | null; files: number };
  serializers: Record<string, string> | null; custom_serialization: boolean;
  source: { repo_id?: string; repo: string; transform: string; commit?: string | null; build: string; branch: string; kind?: "model_studio"; studio_id?: string };
  training_datasets: { item_id: string; name: string }[]; size_bytes: number; experiment_id?: string; created_at: string; created_by: string;
  /** externally hosted models: the connection (credentials by name only) */
  external?: { base_url: string; configuration: Record<string, string>; credential_keys: string[] };
  /** made by an adapter upgrade: the version whose model artifacts it keeps */
  upgraded_from?: { id: string; rid: string; version: string }; api_changed?: boolean;
  /** the trained model as a pickle (MLflow's python_model.pkl or a serializer's dill.pkl); none for container/external models */
  pickle?: { file: string; bytes: number } | null;
};
/** What "Upgrade model adapter" would take: the adapter source at the repository branch's latest commit. */
export type AdapterUpgradePlan = {
  repo: { id: string; name: string }; branch: string; commit: string | null; commit_message: string | null; commit_at: string | null; from_commit: string | null;
  module: string; class: string; root: string; adapter_file: string; changed: { path: string; status: "added" | "modified" | "removed" }[];
  adapter_changed: boolean; up_to_date: boolean; files: number;
};
export type TrainedModel = ModelAsset & { versions_detail: TrainedVersion[]; can_edit: boolean; evaluation_sets: string[]; experiments: number };
export type SeriesStat = { last: number; min: number; max: number; count: number };
export type ExperimentSummary = { id: string; name: string; version: string; version_id: string; branch: string; created_at: string; params: Record<string, unknown>; metrics: Record<string, SeriesStat>; images: number; plots: number; tables: number };
export type LoggedTable = { columns: string[]; rows: unknown[][]; description: string };
export type Experiment = Omit<ExperimentSummary, "metrics" | "images" | "plots" | "tables"> & {
  metrics: Record<string, { step: number; value: number; at: string }[]>;
  images: Record<string, { step: number; png: string; caption: string }[]>;
  plots: Record<string, { step: number; figure: unknown; caption: string }[]>;
  tables: Record<string, LoggedTable>;
  /** structured binary-classification evaluations the run logged (components/models/EvalCharts.tsx) */
  evaluations?: Record<string, import("@/components/models/EvalCharts").ModelEval>;
};
export type ModelEvaluation = {
  id: string; rid: string; name: string; set: string; version: string | null; version_id: string | null; branch: string; created_at: string;
  metrics: Record<string, number>; images: Record<string, { png: string; caption: string }>; plots: Record<string, { figure: unknown; description: string }>;
  tables: Record<string, LoggedTable>; source: { repo: string; repo_id: string; transform: string; build: string };
};
export type EvaluationSets = {
  sets: { name: string; evaluations: number; last: string }[]; set: string | null; evaluations: ModelEvaluation[];
  schedules: { set: string; repo_id: string; transform: string; branch: string; on_new_version: boolean }[];
};
/** A span of a test run (the same shape as a deployment's telemetry spans, lib/modelDeployments.ts). */
export type TestSpan = { name: string; span_id: string; parent_id: string | null; trace_id: string; start_ms: number; ms: number; status: "UNSET" | "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>; events: { name: string; ms: number; attributes: Record<string, string> }[]; at: number };
export type TestRun = { version: string; ok: boolean; outputs: Record<string, unknown>; logs: string; ms?: number; spans?: TestSpan[] };

export const trainedModels = {
  get: (id: string) => req<TrainedModel>(`/${id}`),
  byItem: (itemId: string) => req<TrainedModel>(`/by-item/${itemId}`),
  experiments: (id: string) => req<ExperimentSummary[]>(`/${id}/experiments`),
  experiment: (id: string, expId: string) => req<Experiment>(`/${id}/experiments/${expId}`),
  evaluations: (id: string, set?: string | null) => req<EvaluationSets>(`/${id}/evaluations${set ? `?evaluation_set=${encodeURIComponent(set)}` : ""}`),
  runEvaluation: (id: string, set: string, versionId: string | null) =>
    req<{ id: string; status: string; error: string | null }>(`/${id}/evaluations/${encodeURIComponent(set)}/run`, { method: "POST", json: { version_id: versionId } }),
  scheduleEvaluation: (id: string, set: string, onNewVersion: boolean) =>
    req<unknown>(`/${id}/evaluations/${encodeURIComponent(set)}/schedule`, { method: "PUT", json: { on_new_version: onNewVersion } }),
  predict: (id: string, versionId: string, inputs: Record<string, unknown>) => req<TestRun>(`/${id}/versions/${versionId}/predict`, { method: "POST", json: { inputs } }),
  pickleUrl: (id: string, versionId: string) => `${API_URL}/api/model-assets/${id}/versions/${versionId}/pickle`,
  adapterUpgradePlan: (id: string, versionId: string) => req<AdapterUpgradePlan>(`/${id}/versions/${versionId}/adapter-upgrade`),
  adapterUpgrade: (id: string, versionId: string, description: string) =>
    req<TrainedVersion>(`/${id}/versions/${versionId}/adapter-upgrade`, { method: "POST", json: { description } }),
  createExternal: (body: ExternalInput) => req<TrainedModel>("/external", { method: "POST", json: body }),
  externalVersion: (id: string, body: ExternalInput) => req<TrainedModel>(`/${id}/external/versions`, { method: "POST", json: body }),
};

export type ExternalInput = {
  name?: string; folder_id?: string; description?: string; base_url?: string; configuration?: Record<string, string>; credentials?: Record<string, string>;
  adapter_repo_id?: string; adapter_file?: string; adapter_class?: string; note?: string;
};

/** An example request body for a model API: one row per tabular input, defaults for parameters. */
export function exampleInputs(api: ModelApi | null | undefined): Record<string, unknown> {
  const sample = (t: string): unknown => (t === "integer" ? 0 : t === "double" ? 0.0 : t === "boolean" ? false : t === "string" ? "" : null);
  const out: Record<string, unknown> = {};
  for (const i of api?.inputs ?? []) {
    if (i.type === "tabular") out[i.name] = [Object.fromEntries((i.columns ?? []).map((c) => [c.name, sample(c.type)]))];
    else if (i.type === "parameter" && i.default != null) out[i.name] = i.default;
  }
  return out;
}
