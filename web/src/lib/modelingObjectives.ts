import { API_URL } from "./api";
import type { Deployment } from "./modelDeployments";
import type { ModelApi } from "./modelAssets";

export type ModelSource = "in_platform" | "imported_file" | "container" | "external_api";
export type CandidateStatus = "candidate" | "review" | "rejected" | "approved" | "deployed" | "superseded" | "retired";
export type Evaluation = {
  id: string;
  metric: string;
  value: number;
  threshold: number;
  direction: "maximize" | "minimize";
  passed: boolean;
  notes: string;
  dataset_id?: string | null;
  metrics?: Record<string, number>;
  evaluated_at: string;
};
export type ProductionFeedback = { id: string; metric: string; value: number; notes: string; recorded_at: string };
export type Experiment = { id: string; name: string; dataset_id?: string | null; dataset_name?: string | null; parameters: Record<string, unknown>; metrics: Record<string, number>; created_at: string };
export type ModelRelease = { id: string; submission_id: string; version: string; environment_tag: string; release_note: string; created_at: string };
export type ModelDeployment = { id: string; type: "batch" | "live"; status: "configured"; release_id: string; input_dataset_id?: string | null; output_dataset_id?: string | null; endpoint_name?: string | null; recorded_at: string; note: string };
export type ModelFunction = { id: string; name: string; api_name: string; ontology_object_type_id: string; inputs: Record<string, unknown>; outputs: Record<string, unknown>; release_id: string; status: "registered"; created_at: string; note: string };
export type ModelCandidate = {
  id: string;
  name: string;
  version: string;
  source: ModelSource;
  source_uri: string;
  description: string;
  status: CandidateStatus;
  evaluations: Evaluation[];
  experiments?: Experiment[];
  model_artifact?: Record<string, unknown> | null;
  adapter?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  submission_id?: string;
  submitted_at?: string;
  release?: ModelRelease;
  deployments?: ModelDeployment[];
  functions?: ModelFunction[];
  feedback?: ProductionFeedback[];
  created_at: string;
  deployed_at: string | null;
  deployment?: ModelDeployment;
};
export type ModelingObjective = {
  id: string;
  name: string;
  description: string;
  success_metric: string;
  metric_direction: "maximize" | "minimize";
  threshold: number | null;
  ontology_object_type_id: string | null;
  status: "active";
  candidates: ModelCandidate[];
  created_at: string;
  updated_at: string;
};
export type ObjectiveInput = Pick<ModelingObjective, "name" | "description" | "success_metric" | "metric_direction" | "threshold" | "ontology_object_type_id"> & { project_id?: string | null };
export type CandidateInput = Pick<ModelCandidate, "name" | "version" | "source" | "source_uri" | "description"> & { model_artifact?: Record<string, unknown>; adapter?: Record<string, unknown>; metadata?: Record<string, unknown> };
export type DeploymentInput = { version: string; environment_tag: string; release_note: string; deployment_type: "batch" | "live"; input_dataset_id?: string; output_dataset_id?: string; endpoint_name?: string };

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(`${API_URL}/api/modeling-objectives${path}`, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export const modelingObjectivesApi = {
  list: () => request<ModelingObjective[]>(""),
  create: (body: ObjectiveInput) => request<ModelingObjective>("", { method: "POST", json: body }),
  remove: (id: string) => request<unknown>(`/${id}`, { method: "DELETE" }),
  addCandidate: (id: string, body: CandidateInput) => request<ModelingObjective>(`/${id}/candidates`, { method: "POST", json: body }),
  evaluate: (id: string, candidateId: string, body: { value: number; notes: string; dataset_id?: string; metrics?: Record<string, number> }) =>
    request<ModelingObjective>(`/${id}/candidates/${candidateId}/evaluate`, { method: "POST", json: body }),
  experiment: (id: string, candidateId: string, body: { name: string; dataset_id?: string; dataset_name?: string; parameters: Record<string, unknown>; metrics: Record<string, number> }) =>
    request<ModelingObjective>(`/${id}/candidates/${candidateId}/experiments`, { method: "POST", json: body }),
  approve: (id: string, candidateId: string) => request<ModelingObjective>(`/${id}/candidates/${candidateId}/approve`, { method: "POST" }),
  deploy: (id: string, candidateId: string, body: DeploymentInput) => request<ModelingObjective>(`/${id}/candidates/${candidateId}/deploy`, { method: "POST", json: body }),
  publishFunction: (id: string, candidateId: string, body: { name: string; api_name: string; ontology_object_type_id: string; inputs: Record<string, unknown>; outputs: Record<string, unknown> }) =>
    request<ModelingObjective>(`/${id}/candidates/${candidateId}/functions`, { method: "POST", json: body }),
  retire: (id: string, candidateId: string) => request<ModelingObjective>(`/${id}/candidates/${candidateId}/retire`, { method: "POST" }),
  feedback: (id: string, candidateId: string, body: { value: number; notes: string }) =>
    request<ModelingObjective>(`/${id}/candidates/${candidateId}/feedback`, { method: "POST", json: body }),
};

export const MODEL_SOURCE_LABEL: Record<ModelSource, string> = {
  in_platform: "Trained in platform",
  imported_file: "Imported model asset",
  container: "Container",
  external_api: "External API",
};
export const CANDIDATE_STATUS_LABEL: Record<CandidateStatus, string> = {
  candidate: "Candidate",
  review: "Ready for review",
  rejected: "Below threshold",
  approved: "Approved",
  deployed: "Released",
  superseded: "Superseded",
  retired: "Retired",
};

// -- submissions of model versions, custom metadata, checks, staging / production releases, deployments that run,
//    automatic evaluation (api/modeling_objectives.py, api/model_evaluation.py) ---------------------------------------


export type Environment = "staging" | "production";
export type MetadataField = { id: string; name: string; type: "string" | "number" | "boolean" | "date" | "select"; required: boolean; options: string[] };
export type CheckEvaluation = { dataset_id: string; library_id: string; metric: string; op: ">" | ">=" | "<" | "<=" | "=="; value: number; subset?: string };
export type ObjectiveCheck = { id: string; name: string; description: string; approvers: string[]; evaluation: CheckEvaluation | null; archived: boolean; created_at: string };
export type CheckEvent = { at: string; by: string; action: "approve" | "reject" | "comment"; text: string };
export type Release = {
  id: string; submission_id: string; candidate_id: string; model: string; model_version: string | null; version: string; environment: Environment;
  release_note: string; created_at: string; created_by: string; replaces: string | null; promoted_from: string | null; api_changed: boolean;
};
export type Submission = ModelCandidate & {
  model_id?: string; model_rid?: string; model_version_id?: string; model_version_rid?: string; api?: ModelApi; archived?: boolean; submitted_by?: string;
  checks?: Record<string, { status: "pending" | "approved" | "rejected"; events: CheckEvent[] }>; released_in?: Environment[];
  reviews?: SubmissionReview[]; review_gate?: ReviewGate;
};
/** The objective's review requirement for one submission: approving reviewers needed and none requesting changes. */
export type ReviewGate = { required: number; approvals: number; rejections: number; met: boolean; message: string | null };
export type Objective = Omit<ModelingObjective, "candidates"> & {
  candidates: Submission[]; metadata_fields?: MetadataField[]; checks?: ObjectiveCheck[]; releases?: Release[];
  current_releases?: Record<Environment, Release | null>; evaluation?: EvalConfig; required_reviews?: number;
  /** the caller's role on the objective, its Files Project and its grants (api: sharing) */
  my_role?: ShareRole | null; project?: ObjectiveProject | null; project_id?: string | null; roles?: { principal: string; role: ShareRole }[];
};
export type CheckState = { status: "pending" | "approved" | "rejected"; events?: number; message?: string; value?: number };
export type ChecksStatus = Record<string, { checks: Record<string, CheckState>; overall: "none" | "pending" | "approved" | "rejected" }>;

export type EvalDataset = { id: string; name: string; inference_folder_id: string; metrics_folder_id: string };
export type EvalLibrary = { id: string; kind: "binary_classification" | "regression" | "custom"; library_id?: string; name: string; fields: Record<string, string | number> };
export type SubsetField = { column: string; bucket: "categorical" | "fixed_width" | "cutoffs"; start?: number | null; width?: number | null; cutoffs: number[] };
export type EvalSubset = { id: string; fields: SubsetField[] };
export type EvalConfig = {
  generate: "inference_metrics" | "inference"; auto_build: boolean; datasets: EvalDataset[]; libraries: EvalLibrary[]; subsets: EvalSubset[];
  expected_outputs: string[]; pinned_tabs: { name: string; metrics: string[] }[];
};
export type EvalPlot =
  | { type: "bar"; x: string[]; y: number[] }
  | { type: "line"; x: number[]; y: number[]; x_label?: string; y_label?: string }
  | { type: "matrix"; rows: string[]; columns: string[]; values: number[][] };
export type EvalResult = {
  id: string; candidate_id: string; submission: string; model_version: string | null; dataset_id: string; dataset: string; dataset_transaction: string | null;
  library_id: string | null; library?: string; library_kind?: string; status: "succeeded" | "failed"; error?: string; built_at: string; notes?: string[];
  inference?: { item_id: string; name: string; rows: number; columns: string[] }; metrics_dataset?: { item_id: string; name: string };
  subsets?: Record<string, { rows: number; metrics: Record<string, number | null>; plots: Record<string, EvalPlot> }>;
};
export type EvalDashboard = {
  config: EvalConfig; dataset_id: string | null; transaction: string | null; transactions: { id: string; at: string; rows: number | null }[];
  results: EvalResult[]; subsets: string[]; building: boolean; last_error: string | null; columns: string[];
  submissions: { id: string; name: string; version: string | null; status: string; archived: boolean; evaluable: boolean; submitted_by?: string; metadata: Record<string, unknown> }[];
};
export type EvalLibrarySpec = {
  name: string; description: string; metrics: string[]; fields: { id: string; type: "column" | "int" | "value"; required: boolean; description: string; default?: number; value_type?: string }[];
  kind?: "custom"; repo?: string; version?: string | null; published?: boolean;
};
export type ObjectiveDeploymentInput = {
  name: string; description?: string; type: "live" | "batch"; environment: Environment; input_dataset_id?: string; output_folder_id?: string; output_name?: string;
};

export const objectives = {
  list: () => request<Objective[]>(""),
  get: (id: string) => request<Objective>(`/${id}`),
  update: (id: string, body: { name?: string; description?: string; threshold?: number | null; metadata_fields?: MetadataField[]; required_reviews?: number }) =>
    request<Objective>(`/${id}`, { method: "PUT", json: body }),
  submit: (id: string, body: { model_id: string; version?: string | null; name?: string; description?: string; metadata?: Record<string, unknown> }) =>
    request<Objective>(`/${id}/submissions`, { method: "POST", json: body }),
  archive: (id: string, candidateId: string, undo = false) => request<Objective>(`/${id}/candidates/${candidateId}/archive${undo ? "?undo=true" : ""}`, { method: "POST" }),
  addCheck: (id: string, body: { name: string; description?: string; approvers?: string[]; evaluation?: CheckEvaluation | null }) =>
    request<Objective>(`/${id}/checks`, { method: "POST", json: body }),
  updateCheck: (id: string, check: ObjectiveCheck, archived?: boolean) =>
    request<Objective>(`/${id}/checks/${check.id}${archived === undefined ? "" : `?archived=${archived}`}`, {
      method: "PUT", json: { name: check.name, description: check.description, approvers: check.approvers, evaluation: check.evaluation },
    }),
  actOnCheck: (id: string, candidateId: string, checkId: string, action: CheckEvent["action"], text: string) =>
    request<Objective>(`/${id}/candidates/${candidateId}/checks/${checkId}`, { method: "POST", json: { action, text } }),
  checksStatus: (id: string) => request<ChecksStatus>(`/${id}/checks/status`),
  release: (id: string, body: { candidate_id: string; version: string; release_note: string }) => request<Objective>(`/${id}/releases`, { method: "POST", json: body }),
  promote: (id: string, releaseId: string) => request<Objective>(`/${id}/releases/${releaseId}/promote`, { method: "POST" }),
  deployments: (id: string) => request<Deployment[]>(`/${id}/deployments`),
  createDeployment: (id: string, body: ObjectiveDeploymentInput) => request<Deployment>(`/${id}/deployments`, { method: "POST", json: body }),
  evaluation: (id: string, datasetId?: string | null, transaction?: string | null) =>
    request<EvalDashboard>(`/${id}/evaluation?${new URLSearchParams({ ...(datasetId ? { dataset_id: datasetId } : {}), ...(transaction ? { transaction } : {}) })}`),
  saveEvaluation: (id: string, body: unknown) => request<EvalDashboard>(`/${id}/evaluation`, { method: "PUT", json: body }),
  buildEvaluation: (id: string, body: { candidate_ids?: string[]; dataset_ids?: string[] } = {}) =>
    request<{ built: number; failed: number; errors: string[]; dashboard: EvalDashboard }>(`/${id}/evaluation/build`, { method: "POST", json: { ...body, wait: true } }),
  libraries: () => request<Record<string, EvalLibrarySpec>>("/tools/evaluation-libraries"),
  /** the Model Library, an objective's overview page, per-submission meta and reviews */
  library: () => request<ModelLibrary>("/library"),
  favorite: (id: string, favorite: boolean) => request<{ id: string; favorite: boolean }>(`/${id}/favorite`, { method: "PUT", json: { favorite } }),
  overview: (id: string) => request<ObjectiveOverview>(`/${id}/overview`),
  saveOverview: (id: string, body: { overview?: string; relevant?: { kind: RelevantKind; id: string; name?: string }[]; api_mapping?: Record<"inputs" | "outputs", Record<string, { object_type_id: string; property: string }>> }) =>
    request<ObjectiveOverview>(`/${id}/overview`, { method: "PUT", json: body }),
  modelsMeta: (id: string) => request<Record<string, SubmissionMeta>>(`/${id}/models-meta`),
  review: (id: string, candidateId: string, action: SubmissionReview["action"], text: string, attachments: string[] = []) =>
    request<Objective>(`/${id}/candidates/${candidateId}/reviews`, { method: "POST", json: { action, text, attachments } }),
  /** sharing (viewer / editor / owner grants to users, groups or everyone) and the objective's Project */
  sharing: (id: string) => request<ObjectiveSharing>(`/${id}/sharing`),
  saveSharing: (id: string, roles: { principal: string; role: ShareRole }[]) => request<ObjectiveSharing>(`/${id}/sharing`, { method: "PUT", json: { roles } }),
  setProject: (id: string, projectId: string | null) => request<Objective>(`/${id}/project`, { method: "PUT", json: { project_id: projectId } }),
  /** review attachments: images, PDFs and text files up to 10 MB, stored in Files and read through the objective */
  uploadAttachment: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ReviewAttachment>(`/${id}/attachments`, { method: "POST", body: form });
  },
  attachmentUrl: (id: string, attachmentId: string, download = false) =>
    `${API_URL}/api/modeling-objectives/${id}/attachments/${attachmentId}${download ? "?download=true" : ""}`,
  /** whom a review can tag: users and groups that can read the objective */
  mentionable: (id: string) => request<Mentionable>(`/${id}/mentionable`),
  /** link sharing: ask the owners for a role (the same answer whether or not the objective exists), and their decision */
  requestAccess: (id: string, reason: string, role: "viewer" | "editor" = "viewer") =>
    request<{ requested: boolean; message: string }>(`/${encodeURIComponent(id)}/access-requests`, { method: "POST", json: { reason, role } }),
  decideAccess: (id: string, requestId: string, grant: boolean, role?: ShareRole) =>
    request<ObjectiveSharing>(`/${id}/access-requests/${requestId}`, { method: "POST", json: { grant, role } }),
};

/** A link to an objective, one of its submissions or a review: it opens for those with a role on the objective;
 *  everyone else sees "no access" (and may request it), never the content. */
export function objectiveLink(target: { id: string; model?: string | null; review?: string | null }, origin = typeof window === "undefined" ? "" : window.location.origin): string {
  const q = new URLSearchParams({ id: target.id });
  if (target.model) {
    q.set("view", "models");
    q.set("model", target.model);
    if (target.review) q.set("review", target.review);
  }
  return `${origin}/modeling-objectives?${q}`;
}

/** A tag in a review's Markdown: "@[Name](user:<id>)" or "@[Name](group:<id>)" (api: MENTION_RE). */
export const MENTION_RE = /@\[([^\]\n]{1,100})\]\(((?:user|group):[\w.@-]{1,80})\)/g;
export type Mentionable = { users: { id: string; label: string; username: string }[]; groups: { id: string; label: string }[] };
export type ReviewMention = { principal: string; kind: "user" | "group"; name: string };
export type AccessRequest = { id: string; by: string; by_name: string; at: string; reason: string; role: ShareRole };

export type ShareRole = "viewer" | "editor" | "owner";
export type ShareGrant = { principal: string; role: ShareRole; kind: "user" | "group" | "everyone"; name: string };
export type ObjectiveProject = { id: string; name: string | null; missing: boolean };
export type ObjectiveSharing = {
  id: string; name: string; roles: ShareGrant[]; open: boolean; my_role: ShareRole | null; can_share: boolean;
  project: ObjectiveProject | null; project_role: string | null;
  directory: { users: { id: string; label: string }[]; groups: { id: string; label: string }[] } | null;
  /** owners only: pending access requests */
  requests?: AccessRequest[];
};
export type ReviewAttachment = { id: string; name: string; size: number; content_type: string; by?: string; at?: string };
export const ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.csv,.json,.md";
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

// -- the Model Library and the Objective page (api/modeling_objectives.py: /library, /overview, /models-meta, /reviews)

export type ObjectiveStatus = "not_started" | "in_progress" | "deployed";
export type MappedTypes = { object_types: { id: string; name: string; icon?: string | null; color?: string | null }[]; properties: number };
export type LibraryRow = {
  id: string; name: string; description: string; favorite: boolean; project: string | null; path: string[];
  inputs: MappedTypes | null; input_fields: number; outputs: MappedTypes | null; output_fields: number;
  model: { name: string; model_id?: string | null; version?: string | null; release: string | null; environment: Environment | null } | null;
  last_updated: { kind: "released" | "updated"; at: string }; status: ObjectiveStatus; models: number; deployments: number;
  object_type: MappedTypes["object_types"][number] | null; required_reviews: number;
  project_id?: string | null; my_role?: ShareRole | null; shared?: boolean;
};
export type ModelLibrary = { objectives: LibraryRow[]; projects: string[]; object_types: MappedTypes["object_types"] };
export type ApiField = {
  name: string; type: string; of: string | null;
  mapping: { object_type_id: string; object_type: string; icon?: string | null; color?: string | null; property: string; property_name: string; type: string } | null;
};
export type RelevantKind = "file" | "module" | "graph" | "model";
export type RelevantItem = { kind: RelevantKind; id: string; name: string; path?: string[]; missing?: boolean; content_type?: string | null; item_kind?: string; model_kind?: string };
export type ObjectiveOverview = {
  id: string; name: string; description: string; overview: string; favorite: boolean; path: string[]; status: ObjectiveStatus;
  api: { model: { name: string; version?: string | null; release: string | null; environment: Environment | null } | null; inputs: ApiField[]; outputs: ApiField[]; saved: boolean };
  latest_release: { version: string; environments: Environment[]; environment: Environment; at: string; by: string | null; note: string; model: string | null; model_id: string | null; model_version: string | null; deployments: number } | null;
  relevant: RelevantItem[];
};
export type SubmissionMeta = { size_bytes: number | null; owner: string | null; reviews: number; review_status: "accepted" | "rejected" | null };
export type SubmissionReview = { id: string; at: string; by: string; by_name: string; action: "comment" | "accept" | "reject"; text: string; attachments?: ReviewAttachment[];
  /** users and groups tagged in the text, and how many people were notified */
  mentions?: ReviewMention[]; notified?: number;
};
export const OBJECTIVE_STATUS: Record<ObjectiveStatus, { label: string; hint: string; tone: string }> = {
  not_started: { label: "Not Started", hint: "Objectives with no model submissions yet", tone: "bg-panel-2 text-soft" },
  in_progress: { label: "In Progress", hint: "Objectives with models, but no deployments", tone: "bg-ocean/15 text-ocean" },
  deployed: { label: "Deployed", hint: "Objectives that have a running, operational pipeline", tone: "bg-ok/15 text-ok" },
};
