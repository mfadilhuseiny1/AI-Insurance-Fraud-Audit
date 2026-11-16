/** Transforms common (api/transforms_common.py): local preview tasks, runtime versions and build environments,
 *  debug jobs, and the multi-output transforms advisor. */
import { API_URL } from "./api";
import type { BuildRecord } from "./codeRepos";

/** Spark Details → Environment of a build */
export type BuildEnvironment = {
  language: string;
  kind: string;
  sparkModuleVersion: string;
  sparkVersion: string | null;
  javaVersion: string | null;
  scalaVersion: string | null;
  pythonVersion: string | null;
  rVersion?: string | null;
  engine: string;
  /** "platform" (the API's environment) or the repository environment's key */
  environment: string;
  packages?: number | null;
};
export type Runtime = {
  language: string;
  transforms_version: string;
  template_version?: number;
  spark: string | null;
  java: string | null;
  scala: string | null;
  python?: string;
  available?: boolean;
  engines: string[];
};
export type EnvironmentUse = BuildEnvironment & { builds: number; succeeded: number; failed: number; first_at: string; last_at: string };
export type ListedTransform = { id: string; key: string; file: string; language: string; kind: string; inputs: Record<string, string>; outputs: Record<string, string>; incremental: boolean };
export type PreviewFile = {
  alias: string;
  path: string;
  kind: "text" | "table" | "binary" | "missing";
  size?: number;
  truncated?: boolean;
  text?: string;
  error?: string;
  rows?: number;
  columns?: { name: string; type: string }[];
  preview?: Record<string, unknown>[];
};
export type PreviewDataset = { alias: string; name: string; kind: "dataframe" | "files" | "empty"; rows: number | null; columns: { name: string; type: string }[]; preview: Record<string, unknown>[] };
export type PreviewRun = { ok: boolean; error?: string | null; logs: string; preview_id?: string; uri?: string; datasets?: PreviewDataset[]; input_files?: PreviewFile[]; output_files?: PreviewFile[] };
export type StoredPreview = {
  id: string;
  owner: string;
  repo_id: string;
  repo_name: string;
  branch: string;
  transform_id: string;
  created_at: string;
  expires_at: string;
  ok: boolean;
  error: string | null;
  logs: string;
  datasets: PreviewDataset[];
  input_files: PreviewFile[];
  output_files: PreviewFile[];
  environment: BuildEnvironment;
};
export type EnvChange = { key: string; before: unknown; after: unknown };
export type DebugCandidate = { id: string; at: string; commit: string | null; branch?: string; environment: BuildEnvironment | null; changes: EnvChange[] };
type SparkStage = {
  stageId: number;
  attemptId: number;
  name: string;
  status: string;
  numTasks: number;
  numCompleteTasks: number;
  submissionTime?: string;
  completionTime?: string;
  inputBytes?: number;
  shuffleReadBytes?: number;
  shuffleWriteBytes?: number;
  peakExecutionMemory?: number;
  memoryBytesSpilled?: number;
  taskSummary?: Record<string, number[] | unknown>;
};
type Err = { error: string };
/** Spark's web UI of a debug job, captured from its REST API when the job ended. */
export type SparkUi = {
  job: { id: string; transform: string; at: string; ok: boolean; error: string | null };
  app_id: string;
  app_name: string;
  spark_version: string;
  captured_at: string;
  jobs:
    | {
        jobId: number;
        name: string;
        submissionTime?: string;
        completionTime?: string;
        stageIds: number[];
        status: string;
        numTasks: number;
        numCompletedTasks: number;
        numFailedTasks: number;
        numCompletedStages: number;
        numSkippedStages: number;
      }[]
    | Err;
  stages: SparkStage[] | Err;
  sql:
    | {
        id: number;
        status: string;
        description: string;
        planDescription: string;
        duration?: number;
        successJobIds?: number[];
        failedJobIds?: number[];
        nodes?: { nodeId: number; nodeName: string; metrics: { name: string; value: string }[] }[];
      }[]
    | Err;
  executors:
    | {
        id: string;
        hostPort: string;
        isActive: boolean;
        addTime?: string;
        removeTime?: string;
        removeReason?: string;
        totalCores: number;
        totalTasks: number;
        failedTasks: number;
        totalDuration: number;
        totalGCTime: number;
        totalInputBytes: number;
        totalShuffleRead: number;
        totalShuffleWrite: number;
        memoryUsed: number;
        maxMemory: number;
      }[]
    | Err;
  environment: { runtime: Record<string, string>; sparkProperties: [string, string][]; systemProperties: [string, string][] } | Err;
};

export type DebugJob = {
  id: string;
  repo_id: string;
  build_id: string;
  baseline: string;
  transform: string;
  at: string;
  by: string;
  ran_on: string;
  changes: EnvChange[];
  ok: boolean;
  error: string | null;
  logs: string;
  notes: string[];
  verdict: string;
  ms: number;
  /** Spark's web UI was captured (Spark transforms) */
  spark_ui?: boolean;
};
export type OutputsAdvice = {
  repo: { id: string; name: string; branch: string };
  transforms: {
    id: string;
    key: string;
    kind: string;
    language: string;
    inputs: string[];
    outputs: string[];
    multi_output: boolean;
    builds: number;
    failed: number;
    median_ms: number | null;
    max_ms: number | null;
    last_at: string | null;
  }[];
  advice: { kind: "combine" | "split"; transforms: string[]; inputs: string[]; message: string }[];
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/transforms-common" + path, {
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
const qs = (branch?: string) => (branch ? `?branch=${encodeURIComponent(branch)}` : "");

export const transformsCommon = {
  runtimes: () => req<{ runtimes: Runtime[]; adjudication: boolean; note: string }>("/runtimes"),
  environments: (repoId: string) => req<EnvironmentUse[]>(`/repos/${repoId}/environments`),
  transforms: (repoId: string, branch?: string) => req<{ ok: boolean; transforms: ListedTransform[]; logs: string }>(`/repos/${repoId}/transforms-list${qs(branch)}`, { method: "POST" }),
  preview: (repoId: string, body: { branch?: string; transform_id: string; print_mode: "uri" | "table"; input_files: string[]; output_files: string[] }) =>
    req<PreviewRun>(`/repos/${repoId}/dataset-preview`, { method: "POST", json: body }),
  storedPreview: (id: string) => req<StoredPreview>(`/previews/${id}`),
  debugCandidates: (repoId: string, buildId: string) => req<{ build: BuildRecord; candidates: DebugCandidate[] }>(`/repos/${repoId}/builds/${buildId}/debug-candidates`),
  debug: (repoId: string, buildId: string, baseline: string) => req<DebugJob>(`/repos/${repoId}/builds/${buildId}/debug`, { method: "POST", json: { baseline } }),
  debugJobs: (repoId: string) => req<DebugJob[]>(`/repos/${repoId}/debug-jobs`),
  sparkUi: (repoId: string, jobId: string) => req<SparkUi>(`/repos/${repoId}/debug-jobs/${jobId}/spark-ui`),
  outputs: (repoId: string, branch?: string) => req<OutputsAdvice>(`/repos/${repoId}/outputs${qs(branch)}`),
};

const listOf = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The Gradle command line of a dataset preview. */
export function previewCommand(id: string, opts: { printMode: "uri" | "table"; inputFiles: string; outputFiles: string }): string {
  return [
    `./gradlew datasetPreview --transformId=${id || "<transformId>"}`,
    opts.printMode === "table" ? "--printMode=table" : "",
    ...listOf(opts.inputFiles).map((s) => `--inputFiles=${s}`),
    ...listOf(opts.outputFiles).map((s) => `--outputFiles=${s}`),
  ]
    .filter(Boolean)
    .join(" ");
}

export { listOf as fileArgs };

export const ENV_LABELS: [keyof BuildEnvironment, string][] = [
  ["sparkModuleVersion", "sparkModuleVersion (transforms version)"],
  ["sparkVersion", "sparkVersion"],
  ["javaVersion", "Java"],
  ["scalaVersion", "Scala"],
  ["pythonVersion", "Python"],
  ["rVersion", "R"],
  ["engine", "Engine"],
  ["environment", "Environment"],
  ["packages", "Pinned packages"],
];
