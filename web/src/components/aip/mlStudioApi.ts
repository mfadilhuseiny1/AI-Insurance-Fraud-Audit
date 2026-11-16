import { API_URL } from "@/lib/api";
import type { Rec } from "./aipRun";

/* ML Studio of AIP JKN (api/ml_studio.py): the models, their training runs and the audit of the code that trained each
   run (api/code_provenance.py). */

export type CodeSummary = { key: string; fingerprint: string; files: number; lines: number; commit: string | null; branch: string | null; modified: number; captured_at: string };
export type StudioModel = {
  id: string;
  name: string;
  source: "aip" | "studio";
  path: string[] | string;
  versions: number;
  link: string;
  latest: { version: string; id: string; created_at: string; code?: CodeSummary | null; experiment_id?: string; pickle?: { file: string; bytes: number } | null } | null;
  trainer: string;
  studio_id: string | null;
  studio?: string;
  out_of_date?: boolean;
  description?: string | null;
};
export type StudioRun = {
  key: string;
  source: "aip" | "studio";
  studio_id?: string;
  model: string;
  model_id: string | null;
  name: string;
  kind: string;
  started_at: string | null;
  finished_at?: string | null;
  status: string;
  config_version: number | null;
  version: string | null;
  version_id: string | null;
  experiment_id: string | null;
  params: Rec;
  resources: Rec | null;
  inputs: { name: string; item_id: string; role?: string }[];
  metrics: Rec | null;
  code: CodeSummary | null;
  error: string | null;
  trigger: string | null;
  changelog: string | null;
  best_model?: string;
};
/* changed_during_run: saved after the training process started (contents are read at its end), so it may hold other code than what ran */
export type ManifestFile = { path: string; root: string; module: string; sha256: string; bytes: number; lines: number; blob: string; git?: "committed" | "modified" | "untracked";
  changed_during_run?: boolean };
export type Manifest = {
  key: string;
  fingerprint: string;
  captured_at: string;
  entrypoint: string;
  params: Rec;
  seed: unknown;
  git: Record<string, { commit: string; branch?: string }>;
  environment: { python: string; implementation: string; platform: string; packages: Record<string, string> };
  data: Record<string, { file: string; sha256: string; bytes: number; rows?: number; columns?: number }>;
  files: ManifestFile[];
  process_started_at?: string;
  changed_during_run?: string[];
};
export type Verification = {
  checked_at: string;
  counts: { same: number; changed: number; missing: number; unverifiable: number };
  files: { path: string; root: string; state: "same" | "changed" | "missing" | "unverifiable"; stored_intact: boolean }[];
  head_now: string;
  head_then: string | null;
  all_same: boolean;
};
export type Overview = { models: StudioModel[]; runs: StudioRun[]; docker: { available: boolean; error: string | null } };
/* a notebook per model (api/ml_notebooks.py): each technique of the claim-risk model, each Model Studio model */
export type NotebookTask = { label: string; rank: number | null; of: number; auprc: number; auroc: number; presisi_top_0_1pct: number; best: boolean; p: number | null;
  berbeda_nyata: boolean | null };
export type NotebookItem = {
  id: string;
  file: string;
  source: "aip" | "studio";
  title: string;
  family: string;
  model_id: string | null;
  reference?: string;
  production?: { segment: string; task: string; version: string | null }[];
  tasks?: Record<string, NotebookTask>;
  studio_id?: string;
  config_version?: number | null;
  run?: { id: string; started_at: string | null; best: string | null; metrics: Rec | null } | null;
};
/* the platform's runs of the notebooks in their workspace (outputs and charts saved in each .ipynb) */
export type NotebookRunResult = { pada: string; detik: number; status: "berhasil" | "galat"; galat: string[] };
export type NotebookRuns = { sedang: { antrean: string[]; selesai: string[]; sedang: string | null; mulai: string } | null; hasil: Record<string, NotebookRunResult> };
export type NotebookList = { notebooks: NotebookItem[]; workspace: { id: string; url: string } | null; jalan?: NotebookRuns; docker: Overview["docker"] };
export type NotebookWorkspace = { workspace_id: string; url: string; image: string; image_status: "building" | "ready" | "failed"; notebooks: number; kept: string[];
  archived?: string[]; missing: string[] };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const mlStudio = {
  overview: () => req<Overview>("/api/ml-studio"),
  code: (key: string) => req<{ run: StudioRun; manifest: Manifest | null }>(`/api/ml-studio/runs/${key}/code`),
  file: (key: string, root: string, path: string) => req<ManifestFile & { content: string }>(`/api/ml-studio/runs/${key}/file?${q({ root, path })}`),
  verify: (key: string) => req<Verification>(`/api/ml-studio/runs/${key}/verify`, { method: "POST" }),
  diff: (key: string, root: string, path: string) => req<{ diff: string | null }>(`/api/ml-studio/runs/${key}/diff?${q({ root, path })}`),
  bundleUrl: (key: string) => `${API_URL}/api/ml-studio/runs/${key}/bundle`,
  // the trained model of a version as a pickle (api/model_assets.py download_pickle)
  pickleUrl: (modelId: string, versionId: string) => `${API_URL}/api/model-assets/${modelId}/versions/${versionId}/pickle`,
  workspace: (key: string) =>
    req<{ workspace_id: string; url: string; image: string; image_status: "building" | "ready" | "failed"; notebook: string }>(`/api/ml-studio/runs/${key}/workspace`, { method: "POST" }),
  notebooks: () => req<NotebookList>("/api/ml-studio/notebooks"),
  notebookUrl: (id: string) => `${API_URL}/api/ml-studio/notebooks/${id}`,
  notebooksBundleUrl: () => `${API_URL}/api/ml-studio/notebooks/bundle`,
  // run notebooks in the workspace's JupyterLab, each saved with its outputs (ids: none = all)
  notebooksRun: (ids: string[] = []) =>
    req<{ workspace_id: string; antrean: string[] }>("/api/ml-studio/notebooks/jalankan", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }) }),
  // segarkan: also the notebooks changed or run in JupyterLab (the user's copies move to arsip/)
  notebooksWorkspace: (open?: string, segarkan = false) =>
    req<NotebookWorkspace>("/api/ml-studio/notebooks/workspace", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ open: open ?? null, segarkan }) }),
};
