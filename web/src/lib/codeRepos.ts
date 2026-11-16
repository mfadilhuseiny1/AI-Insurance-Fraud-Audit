/** Code Repositories (api/code_repos.py): Python, SQL and Java transforms, Java UDFs, branches, commits, tags, pull requests and checks. */
import { API_URL } from "./api";
import type { ProjectRole } from "./auth";
import type { ColType, UdfExample, UdfField } from "./pipeline";
import type { BuildEnvironment } from "./transformsCommon";

export type Commit = { id: string; message: string; at: string; hash: string; files: number; branch: string; parents: string[] };
export type Check = {
  id: string;
  commit: string | null;
  branch: string;
  at: string;
  status: "passed" | "failed";
  ms: number;
  transforms: TransformInfo[];
  errors: { file: string; error: string }[];
  error: string | null;
  tests: TestResult[];
  logs: string;
  /** conda_recipe/meta.yaml resolved against this environment and published Python libraries */
  environment?: Environment | null;
  /** CI tasks: condaPackRun (with its stages), pytest, pep8, pylint, antipatternLinter */
  tasks?: CheckTask[];
  /** PEP8 / Pylint messages (errors: they fail checks) and Spark anti-patterns (warnings) */
  lint?: LintProblem[];
  /** the project does not apply the pytest plugin (bluesandai.pytest): tests did not run */
  tests_disabled?: boolean;
  /** code scanning (api/code_scanning.py): the SAST report of the commit */
  code_scan?: CodeScanReport | null;
};
export type CodeScanFinding = { rule: string; rule_type: string; message: string; severity: "INFO" | "WARNING" | "ERROR"; category?: string; cwe?: string; file: string; line: number; column: number; snippet: string };
export type CodeScanReport = { id: string; commit: string | null; at: string; mode: "error" | "warn"; coverage: string; rules: number; files: number; findings: CodeScanFinding[]; counts: Record<string, number> };
export type CheckTask = { name: string; status: "passed" | "failed" | "skipped" | "warnings" | "warning"; ms: number; detail?: string; problems?: number; stages?: { name: string; ms: number }[] };
export type LintProblem = { tool: "pep8" | "pylint" | "antipattern" | "lint"; file: string; line: number; column: number; code: string; message: string; severity: "error" | "warning" };
export type TestResult = { file: string; name: string; line: number; ok: boolean; error: string | null; ms?: number; output?: string; skipped?: boolean };
export type EnvPackage = {
  name: string;
  requested: string;
  section: "build" | "run" | "pip" | "test";
  ok: boolean;
  /** install / dedicated: installed into the repository's own environment (another version, or another Python) */
  source: "runtime" | "environment" | "library" | "install" | "dedicated" | null;
  version: string | null;
  error: string | null;
  repo_id?: string;
  repo_name?: string;
  /** the pip requirement it is installed with */
  pip?: string;
};
export type Environment = {
  file?: string;
  python: string | null;
  packages: EnvPackage[];
  libraries: { name: string; version: string; repo_id: string; repo_name: string }[];
  errors: string[];
  warnings: string[];
  /** a repository environment built with uv (another Python, or packages the platform's environment lacks) */
  dedicated?: { python: string | null; requirements: string[] } | null;
  dedicated_status?: { key: string; ready: boolean; lock: string[] | null; error: string | null };
  /** library versions are locked to what this meta.yaml first resolved to */
  locked?: boolean;
};
export type PythonVersion = { version: string; status: "supported" | "end of life" | "unsupported" | "coming soon" | "in planning"; eol_start: string; discontinued: string; runtime: boolean };
/** A data expectation check's result (Python transforms' Check(...), Pipeline Builder expectations). */
export type ExpectationResult = { id: string; name?: string; ok: boolean; message: string; mode: "abort" | "warn"; kind?: string; target?: string; target_kind?: "input" | "output" };
/** Memory (MB) and CPU (cores) of a build's process over time: [seconds since start, MB, cores]. */
export type BuildMetrics = { interval_s: number; samples: [number, number, number][]; cpu_cores: number; memory_mb_limit: number | null; peak_memory_mb: number; peak_cores: number };
export type BranchInfo = {
  name: string;
  head: Commit | null;
  dirty: boolean;
  protected: boolean;
  default: boolean;
  created_from?: string;
  created_at?: string;
  updated_at?: string;
  check: { id: string; status: "passed" | "failed"; at: string } | null;
  pull_request: { id: string; title: string; status: string; target: string } | null;
};
export type RepoSettings = {
  protected_branches: string[];
  require_approval: boolean;
  require_no_rejections: boolean;
  require_checks: boolean;
  merge_modes: MergeMode[];
  require_commit_message: boolean;
  /** repository upgrades: open upgrade pull requests and merge them once their checks pass */
  auto_merge_upgrades?: boolean;
};
/** A repository upgrade: what bringing a branch to the current Python template version changes. */
export type UpgradePlan = {
  kind: "python" | "python-library" | null;
  current?: number;
  latest?: number;
  available: boolean;
  reason?: string;
  branch: string;
  changes: { path: string; action: "add" | "overwrite" | "merge"; user_changes: boolean; keys?: string[] }[];
  pull_request: { id: string; title: string; upgrade: { version: number; manual: string | null } } | null;
  auto_merge: boolean;
};
export type MergeMode = "squash" | "merge" | "fast_forward";
export const MERGE_LABEL: Record<MergeMode, string> = { squash: "Squash and merge", merge: "Merge", fast_forward: "Merge with fast-forward" };
export type Schedule = {
  id: string;
  transform: string;
  every_minutes: number | null;
  /** five-field cron in `timezone` */
  cron?: string | null;
  timezone?: string;
  on_input_update: boolean;
  enabled: boolean;
  /** a failed build is built again this many times, after the delay */
  retries?: number;
  retry_delay_minutes?: number;
  /** transaction-limited inputs: build again right away until the output is up to date with them */
  retrigger_until_up_to_date?: boolean;
  retriggered?: number;
  /** the last user to change it: scheduled builds run as them (code repository schedules are user-scoped) */
  owner?: string | null;
  owner_user?: { id: string; username: string; display_name: string | null; status: "active" | "deactivated" | "deleted" } | null;
  last_run_at: string | null;
  last_status?: "running" | "retrying" | "succeeded" | "failed";
  last_error?: string | null;
  last_build_id?: string;
  attempt?: number;
  /** from GET schedules */
  running?: boolean;
  next_runs?: string[];
};
export type ScheduleBody = Pick<Schedule, "transform" | "every_minutes" | "cron" | "timezone" | "on_input_update" | "enabled" | "retries" | "retry_delay_minutes" | "retrigger_until_up_to_date">;
/** One batch of a transaction-limited input (Input(..., transaction_limit=N)): the transactions this job read. */
export type TransactionRange = {
  current_view: [string, string];
  processed_batch: [string, string] | null;
  previous_end: string | null;
  last_read: string | null;
  /** unprocessed transactions left after this job */
  remaining: number;
  limit: number;
  rows: [number, number];
};
/** An incremental build: whether it ran incrementally (and why not), the rows each input added and the rows written. */
export type IncrementalInfo = {
  mode: "incremental" | "snapshot";
  reason: string | null;
  output_mode: "modify" | "replace";
  semantic_version: number;
  added_rows: Record<string, number>;
  written_rows: number | null;
  /** Java transforms: how each input changed (APPENDED, UPDATED, NEW_VIEW, UNCHANGED) */
  modification_types?: Record<string, string>;
  /** e.g. rows deleted from an input with allow_retention / allow_user_deletes */
  notes?: string[];
  /** transaction-limited inputs: the batch each read, and whether the output caught up with them */
  ranges?: Record<string, TransactionRange>;
  up_to_date?: boolean;
  /** media set inputs: the new items this build processed (MediaSetInput(..., batch_limit=N)) */
  added_media_items?: Record<string, number>;
};
export type BuildRecord = {
  id: string;
  repo_id: string;
  transform: string;
  at: string;
  ms: number;
  branch?: string;
  trigger?: string;
  commit: string | null;
  uncommitted: boolean;
  status: "succeeded" | "failed";
  error: string | null;
  inputs: { name: string; ref: string; item_id: string; item_name: string; updated_at: string; media?: boolean }[];
  output: { item_id: string; name: string; path: string[]; rows: number; columns: { name: string; type: string }[]; transaction?: string; media_set?: boolean } | null;
  logs: string;
  language?: "python" | "sql" | "java" | "r";
  incremental?: IncrementalInfo;
  media_outputs?: { param: string; item_id: string; name: string; path: string[]; written: number; items: number }[];
  /** the transform wrote no rows and the output dataset aborts empty transactions: nothing was committed */
  aborted_empty?: boolean;
  /** multi-output transforms (Java, Python @transform.using): every output written (files outputs are folders) */
  /** aborted: this build committed nothing to the output (it keeps its last data; Data Lineage keeps the edge) */
  outputs?: { param: string; item_id: string; name: string; path: string[]; rows: number | null; mode: "SNAPSHOT" | "UPDATE" | "ABORTED"; files?: boolean; aborted?: boolean }[];
  /** ctx.abort_job(): the job succeeded and committed nothing */
  aborted?: boolean;
  expectations?: ExpectationResult[];
  metrics?: BuildMetrics | null;
  /** transform logic level version (Python) */
  version?: string | null;
  /** Spark Details → Environment: what the build ran on (transforms_common.py) */
  environment?: BuildEnvironment;
  kind?: TransformInfo["kind"];
  resources?: Resources;
  /** ModelOutput: the model versions this build published (with their training run) */
  model_versions?: { model_id: string; model: string; rid: string; version: string; version_rid: string }[];
};
export type Resources = { cpu_cores?: number; memory_mb?: number; gpu_type?: string };
export type RepoSummary = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  default_branch: string;
  settings: RepoSettings;
  branch_count: number;
  tag_count: number;
  open_prs: number;
  file_count: number;
  build_count: number;
  last_build: BuildRecord | null;
  last_commit: Commit | null;
  dirty: boolean;
  schedules: Schedule[];
  /** the Project whose roles govern the repository: Viewer reads, Editor changes and builds, Owner manages settings and deletes */
  project_id?: string | null;
  project_name?: string | null;
  /** the signed-in user's role on the repository's Project (null: no access) */
  my_role?: ProjectRole | null;
  /** owners recorded on the repository itself (besides the Owners of its Project) */
  owners?: { type: "user" | "group"; id: string; name: string }[];
  /** whether the signed-in user may change its settings, artifacts and external systems (an owner) */
  can_manage?: boolean;
};
export type Repo =RepoSummary & { branch: BranchInfo; branches: BranchInfo[]; files: Record<string, string> };
export type TransformInfo = {
  key: string;
  file: string;
  function: string;
  line: number;
  /** df / transform: the original pandas API; lightweight / spark: @transform.using / @transform.spark.using */
  kind: "df" | "transform" | "sql" | "java" | "r" | "lightweight" | "spark";
  language?: "python" | "sql" | "java" | "r";
  runtime?: { type: "rscript"; identifier: string; filePath: string };
  output: { name: string; folder: string | null; media_set?: boolean };
  output_param?: string | null;
  outputs?: Record<string, { name: string; folder: string | null; description?: string }>;
  inputs: Record<string, string>;
  media_inputs?: Record<string, string>;
  media_outputs?: Record<string, { name: string; folder: string | null }>;
  incremental?: { require_incremental: boolean; semantic_version: number; snapshot_inputs: string[]; strict_append?: boolean; allow_retention?: boolean; allow_user_deletes?: boolean } | null;
  params?: Record<string, { type: string; default: unknown; description: string | null }>;
  checks?: Record<string, { name: string; on_error: "FAIL" | "WARN"; description: string | null }[]>;
  resources?: Resources;
  /** why it cannot be built here (virtual tables, containers, GPUs) */
  blocked?: string;
  version?: string;
  profiles?: string[];
  /** @configure(backend=ComputeBackend.VELOX) */
  backend?: string | null;
  /** the legacy decorator a Spark transform was written with (transform_df / transform) */
  legacy?: string | null;
  transaction_limits?: Record<string, number>;
  media_batch_limits?: Record<string, number>;
  /** palantir_models inputs: language models from the Model Catalog */
  models?: Record<string, { kind: "chat" | "embedding"; rid: string; model: string; class: string }>;
  doc: string;
};
/** A Java repository other repositories can depend on (its compiled code, a jar per default-branch commit). */
export type JavaVersion = { version: string; commit: string; at?: string; message?: string; subprojects: string[]; published: boolean };
export type SharedJavaRepo = {
  repo_id: string;
  name: string;
  /** the group of its Maven coordinate */
  rid: string;
  latest: string | null;
  subprojects: string[];
  /** the build.gradle line referencing its latest version */
  compile: string;
  versions: JavaVersion[];
  missing?: boolean;
  /** Settings → Artifacts: the coordinates this repository's build.gradle files use */
  referenced?: string[];
  /** Artifacts app: repositories that list it as a backing repository */
  consumers?: { repo_id: string; name: string; coordinates: string[] }[];
};
export type ArtifactSettings = {
  /** docker: a Docker Artifacts repository whose images @sidecar transforms run (container_registry.py) */
  backing: (SharedJavaRepo & { builtin?: boolean; description?: string; docker?: boolean; images?: string[]; path?: string; packages?: { conda: number; pypi: number; maven: number } })[];
  available: { repo_id: string; name: string; rid: string }[];
  docker_available?: { repo_id: string; name: string; rid: string; path?: string }[];
  /** libraries the platform provides (transforms-excel-parser-bundle) not added yet */
  libraries?: (SharedJavaRepo & { builtin?: boolean; description?: string; library?: string })[];
  prefix: string;
};
/** A model of the Model Catalog, usable from transforms through palantir_models inputs. */
export type CatalogModel = {
  id: string;
  label?: string;
  vendor?: string | null;
  kind: "chat" | "embedding";
  rid: string;
  inputs: string[];
  available?: boolean;
  dimension?: number | null;
  description?: string;
  /** a registered model: a function implementing ChatCompletion or Embedding (id "function:<function id>") */
  registered?: boolean;
  version?: string;
  function_id?: string;
  repo_id?: string;
  /** a registered chat model whose function streams (Iterator[str]) */
  streaming?: boolean;
};
/** A published version of a Java UDF (a tag whose commit lists it in the lockfile and passed its checks). */
export type PublishedUdf = {
  id: string | null;
  name: string;
  description: string;
  type: "map" | "flat_map" | "keyed_process";
  file: string;
  repo_id: string;
  repo_name: string;
  tag: string;
  commit: string;
  tagged_at?: string;
  published: boolean;
  reason?: string | null;
  input: { name: string; description: string; fields: UdfField[] };
  output: { name: string; description: string; fields: UdfField[] };
  arguments: { name: string; required: boolean; description: string; type: ColType; field_type?: string }[];
  examples: UdfExample[];
  /** keyed process UDFs */
  key_columns?: string[];
  event_time_column?: string | null;
  state?: { name: string; fields: UdfField[] };
};
export type JavaTask = "generateUdfResources" | "generateEddieLockfile" | "test";
export type PythonTask = "install" | "uninstall" | "whoneeds" | "formatCode" | "tasks" | "test" | "displayTransformsList" | "datasetPreview";
export type TaskResult = {
  ok: boolean;
  logs: string;
  error?: string | null;
  generated?: string[];
  problems?: string[];
  added?: string[];
  removed?: string[];
  changed?: string[];
  tests?: TestResult[];
  /** datasetPreview: the computed preview, which only its author can open */
  uri?: string;
};
/** A Python library repository's package: versions are tags whose checks passed. */
export type PythonLibrary = {
  name: string;
  repo_id: string;
  repo_name: string;
  versions: { version: string; commit: string; tagged_at?: string; ok: boolean; reason: string | null; files: number; recalled?: { reason: string; at: string; by: string } | null }[];
  consumers: { repo_id: string; repo_name: string; requested: string }[];
};

export type PreviewResult = {
  ok: boolean;
  error?: string;
  logs: string;
  rows?: number;
  columns?: { name: string; type: string }[];
  preview?: Record<string, unknown>[];
  input_rows?: Record<string, number | null>;
  incremental?: IncrementalInfo | null;
  transform: TransformInfo;
  /** every output of a multi-output transform */
  output_previews?: Record<string, { kind: "dataframe" | "files"; rows: number; columns: { name: string; type: string }[]; preview: Record<string, unknown>[] }>;
  expectations?: ExpectationResult[];
  aborted?: boolean;
};
export type FileDiff = { path: string; status: "added" | "deleted" | "modified"; additions: number; deletions: number; diff: string; old: string | null; new: string | null };
export type Tag = { name: string; commit: string; message: string; at: string; commit_meta: Commit | null };
export type Review = { verdict: "approve" | "reject" | "comment"; comment: string; at: string; path?: string | null; line?: number | null };
export type PrState = {
  approvals: number;
  rejections: number;
  check: Check | null;
  blockers: string[];
  can_merge: boolean;
  fast_forward: boolean;
  conflicts: string[];
};
export type PullRequest = {
  id: string;
  source: string;
  target: string;
  title: string;
  description: string;
  status: "open" | "closed" | "merged";
  reviews: Review[];
  comments: Review[];
  created_at: string;
  updated_at: string;
  merged_at?: string;
  merge_mode?: MergeMode;
  merged_commit?: string;
  state: PrState;
  changes?: FileDiff[];
  commits?: Commit[];
};
export type Impact = {
  changed_files: string[];
  affected: {
    transform: string;
    output: string;
    file: string;
    dataset: BuildRecord["output"];
    stale: boolean;
    ok?: boolean;
    error?: string | null;
    rows?: number;
    schema?: { added: string[]; removed: string[]; changed: string[] } | null;
  }[];
  errors: { file: string; error: string }[];
};
export type SqlResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; ms: number; tables: Record<string, string> };
export type Library = { name: string; version: string; summary: string; source?: "environment" | "library"; repo_id?: string; versions?: string[] };
export type RepoTemplate = "python" | "python-library" | "r" | "java" | "excel" | "udf" | "keyed_udf" | "model-training" | "model-adapter-library" | "model-evaluator-library" | "typescript-functions";

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/code-repos" + path, {
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

const q = (params: Record<string, string | undefined | boolean>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
};

export const codeRepos = {
  list: () => request<RepoSummary[]>(""),
  get: (id: string, branch?: string) => request<Repo>(`/${id}${q({ branch })}`),
  create: (name: string, description = "", template: RepoTemplate = "python", projectId: string | null = null) =>
    request<Repo>("", { method: "POST", json: { name, description, template, project_id: projectId } }),
  /** published Java UDF versions (Pipeline Builder imports them) */
  udfs: (includeUnpublished = false) => request<PublishedUdf[]>(`/tools/udfs${includeUnpublished ? "?include_unpublished=true" : ""}`),
  task: (id: string, branch: string, task: JavaTask | PythonTask, packages: string[] = [], args: Record<string, string> = {}) =>
    request<TaskResult>(`/${id}/tasks`, { method: "POST", json: { branch, task, packages, args } }),
  /** the Libraries panel's settings button: pin a library to a published version in meta.yaml (null: unpin) */
  pinLibrary: (id: string, branch: string, pkg: string, version: string | null) =>
    request<{ ok: boolean; spec: string; file: string }>(`/${id}/libraries/pin`, { method: "POST", json: { branch, package: pkg, version } }),
  environment: (id: string, branch?: string) =>
    request<{ environment: Environment | null; python: string; support: PythonVersion[]; library: string | null; consumers: PythonLibrary["consumers"] }>(`/${id}/environment${q({ branch })}`),
  /** every repository's latest builds (the Builds app) */
  recentBuilds: (params: { limit?: number; since?: string; status?: string } = {}) =>
    request<(BuildRecord & { repo_name: string })[]>(`/tools/builds${q({ limit: params.limit ? String(params.limit) : undefined, since: params.since, status: params.status })}`),
  /** the Artifacts app: published Python libraries and Java UDFs */
  artifacts: () => request<{ python_libraries: PythonLibrary[]; udfs: PublishedUdf[]; python: string; java_repositories: SharedJavaRepo[] }>("/tools/artifacts"),
  recallLibrary: (name: string, version: string, reason: string) =>
    request<{ recalled: boolean }>("/tools/artifacts/recall", { method: "POST", body: JSON.stringify({ name, version, reason }), headers: { "content-type": "application/json" } }),
  unrecallLibrary: (name: string, version: string) =>
    request<{ recalled: boolean }>("/tools/artifacts/unrecall", { method: "POST", body: JSON.stringify({ name, version }), headers: { "content-type": "application/json" } }),
  /** Settings → Artifacts: backing repositories whose shared Java code build.gradle may reference */
  artifactSettings: (id: string) => request<ArtifactSettings>(`/${id}/artifacts`),
  saveArtifactSettings: (id: string, repos: string[]) => request<ArtifactSettings>(`/${id}/artifacts`, { method: "PUT", json: { repos } }),
  remove: (id: string) => request<unknown>(`/${id}`, { method: "DELETE" }),
  /** Projects the user may create a repository in or move one to (Editor or Owner there) */
  projects: () => request<{ projects: { id: string; name: string; my_role: ProjectRole; default: boolean }[]; default_project_id: string | null }>("/tools/projects"),
  /** move to another Project (Owner where it is, Editor where it goes) */
  move: (id: string, projectId: string) => request<RepoSummary>(`/${id}`, { method: "PATCH", json: { project_id: projectId } }),
  saveSettings: (id: string, body: Partial<RepoSettings> & { default_branch?: string }) => request<RepoSummary>(`/${id}/settings`, { method: "PUT", json: body }),
  saveFiles: (id: string, branch: string, files: Record<string, string>) => request<BranchInfo>(`/${id}/files`, { method: "PUT", json: { branch, files } }),
  createBranch: (id: string, name: string, source?: string) => request<BranchInfo>(`/${id}/branches`, { method: "POST", json: { name, source } }),
  deleteBranch: (id: string, name: string) => request<unknown>(`/${id}/branches/${name}`, { method: "DELETE" }),
  reset: (id: string, branch: string) => request<Repo>(`/${id}/reset`, { method: "POST", json: { branch } }),
  merge: (id: string, branch: string, source: string) => request<Repo & { commit: Commit }>(`/${id}/merge`, { method: "POST", json: { branch, source } }),
  commit: (id: string, branch: string, message: string) => request<Commit>(`/${id}/commits`, { method: "POST", json: { branch, message } }),
  commits: (id: string, branch?: string) => request<Commit[]>(`/${id}/commits${q({ branch })}`),
  commitFiles: (id: string, cid: string) => request<{ commit: Commit; files: Record<string, string> }>(`/${id}/commits/${cid}`),
  restore: (id: string, cid: string, branch: string) => request<Repo>(`/${id}/commits/${cid}/restore`, { method: "POST", json: { branch } }),
  changes: (id: string, branch: string) => request<FileDiff[]>(`/${id}/changes${q({ branch })}`),
  diff: (id: string, base: string, head: string, working = false) => request<FileDiff[]>(`/${id}/diff${q({ base, head, working })}`),
  tags: (id: string) => request<Tag[]>(`/${id}/tags`),
  createTag: (id: string, name: string, ref: string, message: string) => request<Tag>(`/${id}/tags`, { method: "POST", json: { name, ref, message } }),
  pulls: (id: string) => request<PullRequest[]>(`/${id}/pulls`),
  upgradePlan: (id: string, branch: string) => request<UpgradePlan>(`/${id}/upgrade${q({ branch })}`),
  /** … → Upgrade: opens the upgrade pull request */
  upgrade: (id: string, branch: string) => request<PullRequest>(`/${id}/upgrade`, { method: "POST", json: { branch } }),
  pull: (id: string, pr: string) => request<PullRequest>(`/${id}/pulls/${pr}`),
  createPull: (id: string, body: { source: string; target?: string; title: string; description: string }) => request<PullRequest>(`/${id}/pulls`, { method: "POST", json: body }),
  review: (id: string, pr: string, body: { verdict: Review["verdict"]; comment: string; path?: string; line?: number }) =>
    request<PullRequest>(`/${id}/pulls/${pr}/reviews`, { method: "POST", json: body }),
  mergePull: (id: string, pr: string, mode: MergeMode, message?: string) => request<PullRequest>(`/${id}/pulls/${pr}/merge`, { method: "POST", json: { mode, message } }),
  setPullState: (id: string, pr: string, status: "open" | "closed") => request<PullRequest>(`/${id}/pulls/${pr}/state`, { method: "POST", json: { status } }),
  impact: (id: string, pr: string) => request<Impact>(`/${id}/pulls/${pr}/impact`),
  runChecks: (id: string, branch: string) => request<Check>(`/${id}/checks`, { method: "POST", json: { branch } }),
  checks: (id: string, branch?: string) => request<Check[]>(`/${id}/checks${q({ branch })}`),
  tests: (id: string, branch: string, file?: string) =>
    request<{ ok: boolean; tests: TestResult[]; error: string | null; logs: string }>(`/${id}/tests`, { method: "POST", json: { branch, file } }),
  preview: (id: string, branch: string, transform: string, limit = 100) => request<PreviewResult>(`/${id}/preview`, { method: "POST", json: { branch, transform, limit } }),
  build: (id: string, branch: string, body: { transform?: string; file?: string; force_snapshot?: boolean }) => request<BuildRecord[]>(`/${id}/build`, { method: "POST", json: { branch, ...body } }),
  builds: (id: string) => request<BuildRecord[]>(`/${id}/builds`),
  schedules: (id: string) => request<Schedule[]>(`/${id}/schedules`),
  addSchedule: (id: string, body: ScheduleBody) => request<Schedule>(`/${id}/schedules`, { method: "POST", json: body }),
  updateSchedule: (id: string, sid: string, body: Partial<ScheduleBody>) => request<Schedule>(`/${id}/schedules/${sid}`, { method: "PUT", json: body }),
  /** Run now: builds the schedule's transform on the default branch's last commit, with its retries */
  runSchedule: (id: string, sid: string) => request<Schedule & { build: BuildRecord | null }>(`/${id}/schedules/${sid}/run`, { method: "POST" }),
  cronPreview: (cron: string, tz: string) => request<{ next: string[] }>(`/tools/cron${q({ cron, timezone_name: tz })}`),
  deleteSchedule: (id: string, sid: string) => request<unknown>(`/${id}/schedules/${sid}`, { method: "DELETE" }),
  sql: (query: string) => request<SqlResult>("/tools/sql", { method: "POST", json: { query } }),
  libraries: () => request<Library[]>("/tools/libraries"),
  models: () => request<{ chat: CatalogModel[]; embedding: CatalogModel[]; prefix: string; aliases: string }>("/tools/models"),
  /** a completion as it is produced: onChunk gets each piece a registered model (a ChatCompletion function returning
   *  Iterator[str]) yields — one piece for other models; resolves with the whole text */
  chatStream: async (model: string, prompt: string, onChunk: (text: string) => void): Promise<string> => {
    const res = await fetch(`${API_URL}/api/functions/llm/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result: { ok: boolean; text?: string; error?: unknown } | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue;
        const payload = JSON.parse(data);
        if (ev === "chunk") onChunk(String(payload));
        else if (ev === "result") result = payload;
      }
    }
    if (!result) throw new Error("the stream ended without a result");
    if (!result.ok) throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
    return result.text ?? "";
  },
  ai: (body: { mode: "explain" | "bugs" | "error" | "ask"; code?: string; path?: string; selection?: string; error?: string; question?: string }) =>
    request<{ answer: string }>("/tools/ai", { method: "POST", json: body }),
};

/* ---------------------------------------------------------------------------------------------
 * Debugger and console (api/code_debug.py): a transform run in preview under a debugger, or a
 * Python console with the transform's inputs preloaded. Each session is its own process.
 * ------------------------------------------------------------------------------------------- */

export type DebugBreakpoint = { file: string; line: number; condition?: string | null; verified?: boolean | null; message?: string | null };
/** A value as the debugger shows it: DataFrames / Series as tables (first rows), containers by length, else a short repr. */
export type DebugValue = {
  name?: string;
  type: string;
  kind: "dataframe" | "series" | "array" | "scalar" | "dict" | "sequence" | "module" | "callable" | "object";
  repr: string;
  shape?: number[];
  length?: number;
  dtype?: string;
  columns?: { name: string; type: string }[];
  index?: unknown[];
  rows?: unknown[][];
  truncated_columns?: boolean;
  note?: string;
};
export type DebugFrame = { index: number; file: string; line: number; function: string };
export type DebugEval = { id: string; code: string; ok: boolean; value: DebugValue | null; output: string; error: string | null };
/** A watch expression's value in the selected frame (ok null: not evaluated yet, i.e. until the next pause). */
export type DebugWatch = { expr: string; ok: boolean | null; value?: DebugValue | null; error?: string | null };
export type DebugStatus = "starting" | "running" | "paused" | "ready" | "finished" | "error" | "stopped";
export type DebugSession = {
  id: string;
  repo_id: string;
  branch: string;
  transform: string;
  file: string;
  function: string;
  mode: "debug" | "console";
  status: DebugStatus;
  reason: "breakpoint" | "step" | "pause" | "entry" | "exception" | null;
  /** an evaluation is running */
  busy: boolean;
  paused: { file: string; line: number; function: string; stack: DebugFrame[]; frame: number; exception: string | null } | null;
  variables: (DebugValue & { name: string })[];
  preloaded: string[];
  inputs: Record<string, string>;
  input_rows: Record<string, number>;
  result: { rows: number; columns: { name: string; type: string }[]; preview: Record<string, unknown>[]; dataset_output: boolean } | null;
  error: string | null;
  breakpoints: DebugBreakpoint[];
  watches: DebugWatch[];
  evals: Record<string, DebugEval>;
  output: string;
  output_from: number;
  output_end: number;
  version: number;
  idle_timeout_s: number;
  alive: boolean;
};
export type DebugAction = "continue" | "step" | "next" | "return" | "pause" | "stop";

const debugBase = (id: string) => `/${id}/debug/sessions`;
export const codeDebug = {
  start: (id: string, body: { branch: string; transform?: string; file?: string; mode: "debug" | "console"; breakpoints: DebugBreakpoint[]; watches?: string[]; stop_on_entry?: boolean }) =>
    request<DebugSession>(debugBase(id), { method: "POST", json: body }),
  list: (id: string) => request<DebugSession[]>(debugBase(id)),
  /** with `version`, waits (long poll, up to `wait` s) until the session changes */
  state: (id: string, sid: string, opts: { version?: number; wait?: number; outputFrom?: number } = {}) =>
    request<DebugSession>(
      `${debugBase(id)}/${sid}${q({ version: opts.version !== undefined ? String(opts.version) : undefined, wait: opts.wait ? String(opts.wait) : undefined, output_from: opts.outputFrom ? String(opts.outputFrom) : undefined })}`,
    ),
  command: (id: string, sid: string, action: DebugAction) => request<DebugSession>(`${debugBase(id)}/${sid}/command`, { method: "POST", json: { action } }),
  evaluate: (id: string, sid: string, code: string, frame = 0) =>
    request<{ id: string; pending: boolean; result: DebugEval | null; state: DebugSession }>(`${debugBase(id)}/${sid}/eval`, { method: "POST", json: { code, frame } }),
  frame: (id: string, sid: string, frame: number) => request<DebugSession>(`${debugBase(id)}/${sid}/frame`, { method: "POST", json: { frame } }),
  setBreakpoints: (id: string, sid: string, breakpoints: DebugBreakpoint[]) =>
    request<DebugSession>(`${debugBase(id)}/${sid}/breakpoints`, { method: "PUT", json: { breakpoints: breakpoints.map(({ file, line, condition }) => ({ file, line, condition: condition || null })) } }),
  setWatches: (id: string, sid: string, watches: string[]) => request<DebugSession>(`${debugBase(id)}/${sid}/watches`, { method: "PUT", json: { watches } }),
  stop: (id: string, sid: string) => request<{ ok: boolean }>(`${debugBase(id)}/${sid}`, { method: "DELETE" }),
};
