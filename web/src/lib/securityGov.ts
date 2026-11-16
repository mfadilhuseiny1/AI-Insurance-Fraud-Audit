/**
 * Security & Governance applications: audit.3 logs and monitoring (api/audit3.py, api/audit_monitor.py) and the
 * governance products built on them.
 */
import { API_URL } from "./api";
import "./auth";

export async function sg<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json", ...(rest.headers ?? {}) } } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const d = (body as { detail?: unknown }).detail;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d) : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

// -- audit.3 --

export type AuditLine = {
  categories: string[];
  entities: { type?: string; id: string; name?: string }[];
  eventId: string;
  logEntryId: string;
  name: string;
  orgId: string | null;
  origin: string | null;
  origins: string[];
  product: string;
  service: string;
  requestFields: Record<string, unknown>;
  resultFields: Record<string, unknown>;
  result: "SUCCESS" | "UNAUTHORIZED" | "ERROR";
  sid: string | null;
  time: string;
  tokenId: string | null;
  traceId: string | null;
  uid: string | null;
  userAgent: string | null;
  userName?: string | null;
};
export type AuditCategory = { name: string; request_fields: string[]; result_fields: string[]; description: string };
export type AuditSummary = { total: number; users: number; categories: Record<string, number>; products: Record<string, number>; results: Record<string, number>; days: Record<string, number> };
export type AuditExport = {
  id: string; org: string; schema: "audit.2" | "audit.3"; folder_id: string; name: string; markings: string[]; start_date: string | null;
  retention_days: number | null; paused: boolean; item_id: string | null; created_at: string; created_by: string; last_run: string | null; rows: number; error: string | null;
};
export type AuditOrg = { id: string; name: string; readers: string[] };
export type Detection = { id: string; name: string; description: string; severity: "low" | "medium" | "high"; enabled: boolean; params: Record<string, number | string>; recipients: string[]; email: boolean };
export type Alert = {
  id: string; detection: string; title: string; severity: string; key: string; uid: string | null; userName?: string | null; detail: string; first_at: string; last_at: string;
  count: number; events: string[]; status: "open" | "acknowledged" | "resolved"; assignee: string | null; assigneeName?: string | null; notes: { at: string; by: string; text: string }[];
};
export type Baseline = {
  uid: string; name: string; avg_per_day: number; today: number; login_hours: number[]; top_categories: [string, number][]; exports: number; export_bytes: number;
  origins: string[]; failed_auth: number; flags: string[];
};

export const audit = {
  categories: () => sg<AuditCategory[]>("/api/audit/categories"),
  events: (q: { start?: string; end?: string; categories?: string; uid?: string; product?: string; result?: string; q?: string; resource?: string; org?: string; limit?: number }) =>
    sg<{ total: number; events: AuditLine[]; start: string; end: string }>(`/api/audit/events${qs(q)}`),
  summary: (days = 7) => sg<AuditSummary>(`/api/audit/summary${qs({ days })}`),
  organizations: () => sg<AuditOrg[]>("/api/audit/organizations"),
  setReaders: (org: string, users: string[]) => sg<AuditOrg>(`/api/audit/organizations/${encodeURIComponent(org)}/readers`, { method: "PUT", json: { users } }),
  exports: () => sg<AuditExport[]>("/api/audit/exports"),
  createExport: (body: { org: string; schema: string; folder_id: string; name: string; markings?: string[]; start_date?: string | null; retention_days?: number | null; acknowledged: boolean }) =>
    sg<AuditExport>("/api/audit/exports", { method: "POST", json: body }),
  updateExport: (id: string, body: { paused?: boolean; retention_days?: number }) => sg<AuditExport>(`/api/audit/exports/${id}`, { method: "PATCH", json: body }),
  runExport: (id: string) => sg<AuditExport>(`/api/audit/exports/${id}/run`, { method: "POST" }),
  detections: () => sg<Detection[]>("/api/audit/detections"),
  updateDetection: (id: string, body: Partial<Pick<Detection, "enabled" | "severity" | "params" | "recipients" | "email">>) =>
    sg<Detection>(`/api/audit/detections/${id}`, { method: "PUT", json: body }),
  testDetection: (id: string, days = 7) =>
    sg<{ scanned: number; matches: number; by_user: { key: string; name: string; count: number }[]; examples: { time: string; key: string; detail: string }[] }>(
      `/api/audit/detections/${id}/test${qs({ days })}`,
      { method: "POST" },
    ),
  alerts: (status?: string) => sg<Alert[]>(`/api/audit/alerts${qs({ status })}`),
  updateAlert: (id: string, body: { status?: string; assignee?: string; note?: string }) => sg<Alert>(`/api/audit/alerts/${id}`, { method: "PATCH", json: body }),
  baselines: (days = 14) => sg<Baseline[]>(`/api/audit/baselines${qs({ days })}`),
};

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
export const fmtBytes = (n?: number | null) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

// -- approvals (api/approvals.py) --

export type ApprovalTaskKind = "group_membership" | "project_access" | "marking_access" | "add_reference" | "ontology_proposal";
export type ApprovalStatus = "pending" | "changes_requested" | "action_required" | "completed" | "closed" | "rejected_closed";
export type ApprovalTask = {
  id: string;
  kind: ApprovalTaskKind;
  params: Record<string, string | string[]>;
  label: string;
  state: "review" | "approved" | "rejected";
  reviews: { by: string; by_name: string; decision: string; at: string; comment: string }[];
  reviewers: string[];
  reviewer_names: string[];
  checkpoints: { config_id: string; title: string; type: string; record: string | null }[];
  can_review: boolean;
  invoked_at?: string;
  error?: string;
  /** a group membership task's approval policy (the group's) and the distinct approvals so far */
  policy?: { min_approvals: number; reviewers: string[]; expires_by: string | null; text: string } | null;
  approvals?: number;
};
export type RequestOptions = {
  groups: { id: string; name: string; role: string; categories: Record<string, string>; policy: string; contact?: { kind: string; value: string } | null }[];
  categories: string[];
};
export type ApprovalRequest = {
  id: string;
  rid: string;
  title: string;
  description: string;
  status: ApprovalStatus;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at?: string;
  completed_at?: string;
  tasks: ApprovalTask[];
  invited: string[];
  invited_names: string[];
  comments: { id: string; task_id: string | null; by: string; by_name: string; at: string; text: string; attachments: { id: string; name: string }[] }[];
  history: { at: string; by: string; what: string; task?: string }[];
  can_edit: boolean;
  is_creator: boolean;
  error?: string;
  /** an Ontology proposal, reviewed here: merging applies its changes to main */
  kind?: "ontology_proposal";
  mergeable?: boolean;
  external_link?: string;
};
export type ApprovalSummary = Pick<ApprovalRequest, "id" | "rid" | "title" | "status" | "created_by" | "created_by_name" | "created_at" | "updated_at"> & {
  tasks: { kind: ApprovalTaskKind; label: string; state: string; can_review: boolean }[];
  external?: string;
};
export const TASK_LABEL: Record<ApprovalTaskKind, string> = {
  group_membership: "Group membership", project_access: "Project access request", marking_access: "Marking access request",
  add_reference: "Add reference request", ontology_proposal: "Nexus proposal",
};
export const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: "Pending approval", changes_requested: "Changes requested", action_required: "Action required", completed: "Completed", closed: "Closed",
  rejected_closed: "Rejected and closed",
};

export const STATUS_TONE: Record<string, string> = {
  pending: "text-ocean", changes_requested: "text-warn", action_required: "text-warn", completed: "text-ok", closed: "text-muted", rejected_closed: "text-bad",
};

export const approvals = {
  list: (q: { filter?: string; status?: string; kind?: string; creator?: string; q?: string }) => sg<ApprovalSummary[]>(`/api/approvals/requests${qs(q)}`),
  get: (id: string) => sg<ApprovalRequest>(`/api/approvals/requests/${id}`),
  requestOptions: (projectId: string) => sg<RequestOptions>(`/api/approvals/projects/${projectId}/request-options`),
  create: (body: { title?: string; description?: string; tasks: { kind: string; params: Record<string, unknown> }[] }) =>
    sg<ApprovalRequest>("/api/approvals/requests", { method: "POST", json: body }),
  review: (id: string, body: { decision: "approve" | "reject" | "request_changes" | "reject_and_close"; task_ids?: string[]; comment?: string }) =>
    sg<ApprovalRequest>(`/api/approvals/requests/${id}/review`, { method: "POST", json: body }),
  edit: (id: string, body: { title?: string; description?: string; tasks?: Record<string, Record<string, unknown>> }) =>
    sg<ApprovalRequest>(`/api/approvals/requests/${id}`, { method: "PATCH", json: body }),
  close: (id: string) => sg<ApprovalRequest>(`/api/approvals/requests/${id}/close`, { method: "POST" }),
  merge: (id: string) => sg<ApprovalRequest>(`/api/approvals/requests/${id}/merge`, { method: "POST" }),
  comment: (id: string, body: { text: string; task_id?: string | null; attachments?: string[] }) =>
    sg<ApprovalRequest>(`/api/approvals/requests/${id}/comments`, { method: "POST", json: body }),
  invite: (id: string, users: string[]) => sg<ApprovalRequest>(`/api/approvals/requests/${id}/reviewers`, { method: "POST", json: { users } }),
  nudge: (id: string) => sg<{ nudged: number }>(`/api/approvals/requests/${id}/nudge`, { method: "POST" }),
  answerCheckpoints: (id: string, taskId: string, answers: Record<string, unknown>) =>
    sg<ApprovalRequest>(`/api/approvals/requests/${id}/tasks/${taskId}/checkpoints`, { method: "POST", json: { answers } }),
};

// -- Sensitive Data Scanner (api/sds.py) --

export type SdsCondition = {
  id: string; name: string; kind: "regex" | "overlap" | "llm"; builtin?: boolean; description?: string; content_regex?: string; column_regex?: string;
  logic?: "content" | "column" | "both" | "either"; threshold?: number | null; overlap_dataset?: string | null; overlap_column?: string | null; model?: string; prompt?: string;
  column_prompt?: string; examples?: string[]; counter_examples?: string[];
};
export type SdsAction = {
  id: string; name: string; kind: "apply_markings" | "create_issues" | "obfuscate"; markings: string[]; reapply_removed: boolean; assignees: string[]; issue_text: string;
  label: string; severity: string; notify_creator: boolean; skip_if_archived: boolean; skip_if_closed: boolean; license: string | null; mode: "column" | "row" | "cell" | "segments";
};
export type SdsMatch = { condition_id: string; condition_name: string; columns: string[]; count: number; samples: string[]; items?: { id: string; name: string }[] };
export type SdsResult = { id: string; name: string; type: "dataset" | "media_set"; matches: SdsMatch[]; scanned_rows: number; at: string; error?: string; incremental?: boolean;
  history?: { at: string; scanned: number; conditions: string[]; incremental: boolean }[] };
export type SdsRun = { id: string; started_at: string; finished_at?: string; trigger: string; status: string; resources: number; matched: number; errors: string[]; llm_calls?: number };
export type SdsScan = {
  id: string; name: string; description: string; resource_types: string[]; include: string[]; exclude: string[]; strategy: "source_only" | "all"; source_kinds: string[];
  rows: "all" | "sample"; sample_rows: number | null; schedule: "once" | "daily" | "weekly" | "monthly" | "continuous"; initial_scan: boolean; include_markings: string[];
  exclude_markings: string[]; conditions: string[]; actions: string[]; created_by: string; created_at: string; active: boolean; runs: SdsRun[]; results?: SdsResult[];
  status_detail: string; last_run_at?: string; matched: number; effects: number; adjustable: boolean; can_manage: boolean;
  adjustments?: { at: string; kind: string; actions: string[]; undone?: number; not_reversible?: number; errors?: string[] }[];
};
export type SdsScanIn = Omit<SdsScan, "id" | "created_by" | "created_at" | "active" | "runs" | "results" | "status_detail" | "last_run_at" | "matched" | "effects" | "adjustable" | "can_manage" | "adjustments">;

export const sds = {
  conditions: () => sg<SdsCondition[]>("/api/sds/conditions"),
  createCondition: (c: Partial<SdsCondition>) => sg<SdsCondition>("/api/sds/conditions", { method: "POST", json: c }),
  deleteCondition: (id: string) => sg<{ deleted: string }>(`/api/sds/conditions/${id}`, { method: "DELETE" }),
  testCondition: (condition: Partial<SdsCondition>, values: string[], column = "value") =>
    sg<{ match: boolean; matched?: number; scanned?: number; samples?: string[] }>("/api/sds/conditions/test", { method: "POST", json: { condition, values, column } }),
  generateRegex: (description: string) => sg<{ regex: string; matches: string[]; non_matches: string[] }>("/api/sds/conditions/generate-regex", { method: "POST", json: { description } }),
  actions: () => sg<SdsAction[]>("/api/sds/actions"),
  createAction: (a: Partial<SdsAction>) => sg<SdsAction>("/api/sds/actions", { method: "POST", json: a }),
  deleteAction: (id: string) => sg<{ deleted: string }>(`/api/sds/actions/${id}`, { method: "DELETE" }),
  scans: () => sg<SdsScan[]>("/api/sds/scans"),
  scan: (id: string) => sg<SdsScan>(`/api/sds/scans/${id}`),
  preview: (s: SdsScanIn) => sg<{ resources: { id: string; name: string; type: string }[]; count: number; datasets: number; media_sets: number; virtual_tables?: number; llm_conditions: number }>("/api/sds/scans/preview", { method: "POST", json: s }),
  create: (s: SdsScanIn) => sg<SdsScan>("/api/sds/scans", { method: "POST", json: s }),
  run: (id: string, opts: { full?: boolean; resource?: string } = {}) => sg<{ started: boolean }>(`/api/sds/scans/${id}/run${qs({ full: opts.full ? "true" : undefined, resource: opts.resource })}`, { method: "POST" }),
  cancel: (id: string) => sg<{ cancelling: boolean }>(`/api/sds/scans/${id}/cancel`, { method: "POST" }),
  update: (id: string, body: { active?: boolean; actions?: string[]; name?: string }) => sg<SdsScan>(`/api/sds/scans/${id}`, { method: "PATCH", json: body }),
  applyActions: (id: string, actions: string[]) => sg<{ errors: string[] }>(`/api/sds/scans/${id}/apply-actions`, { method: "POST", json: { actions } }),
  reverseActions: (id: string, actions: string[]) => sg<{ undone: number; not_reversible: number }>(`/api/sds/scans/${id}/reverse-actions`, { method: "POST", json: { actions } }),
  remove: (id: string) => sg<{ deleted: string }>(`/api/sds/scans/${id}`, { method: "DELETE" }),
};

// -- Data Lifetime (api/data_lifetime.py) --

export type LifetimePolicy = {
  id: string; name: string; description: string; type: "fixed" | "latest_view"; deletion_date: string | null; cutoff_date: string | null; branches: string[];
  created_by: string; created_at: string; datasets?: string[] | { id: string; name: string; visible: boolean }[]; overrides?: string[] | { id: string; name: string; visible: boolean }[];
  downstream?: { id: string; name: string; visible: boolean }[]; history?: { at: string; by: string; action: string; dataset: string | null; detail: string }[];
};
export type LifetimeDataset = {
  dataset_id: string;
  application: { policy: string | null; policy_name?: string; override: boolean; at: string; by: string } | null;
  transactions: { id: string; at: string; kind: string; rows: number | null; deletion_date: string | null; policy: string | null; policy_name?: string; inherited_from?: string; deleted_at?: string }[];
  inherited: string[];
};
export type LifetimeDeletion = {
  dataset: string; dataset_name: string; transaction: string; transaction_at: string; deletion_date: string; policy: string | null; inherited_from?: string | null;
  status: "deleted" | "scheduled"; at?: string; emptied_current_view?: boolean;
};

export const lifetime = {
  policies: () => sg<LifetimePolicy[]>("/api/data-lifetime/policies"),
  policy: (id: string) => sg<LifetimePolicy>(`/api/data-lifetime/policies/${id}`),
  create: (p: Partial<LifetimePolicy>) => sg<LifetimePolicy>("/api/data-lifetime/policies", { method: "POST", json: p }),
  update: (id: string, p: Partial<LifetimePolicy>) => sg<LifetimePolicy>(`/api/data-lifetime/policies/${id}`, { method: "PUT", json: p }),
  remove: (id: string) => sg<{ deleted: string }>(`/api/data-lifetime/policies/${id}`, { method: "DELETE" }),
  apply: (id: string, datasetId: string) => sg<LifetimeDataset>(`/api/data-lifetime/policies/${id}/apply`, { method: "POST", json: { dataset_id: datasetId } }),
  unapply: (id: string, datasetId: string) => sg<LifetimeDataset>(`/api/data-lifetime/policies/${id}/datasets/${datasetId}`, { method: "DELETE" }),
  dataset: (id: string) => sg<LifetimeDataset>(`/api/data-lifetime/datasets/${id}`),
  override: (id: string, policyId: string | null) => sg<LifetimeDataset>(`/api/data-lifetime/datasets/${id}/override`, { method: "PUT", json: { policy_id: policyId } }),
  removeOverride: (id: string) => sg<LifetimeDataset>(`/api/data-lifetime/datasets/${id}/override`, { method: "DELETE" }),
  deletions: (q: { policy?: string; transaction?: string; start?: string; end?: string; scheduled?: string }) => sg<{ total: number; rows: LifetimeDeletion[] }>(`/api/data-lifetime/deletions${qs(q)}`),
  run: (dryRun: boolean) => sg<{ due?: unknown[]; deleted?: unknown[]; remaining?: number }>("/api/data-lifetime/run", { method: "POST", json: { dry_run: dryRun } }),
};

// -- Code scanning (api/code_scanning.py) --

export type CodeScanSettings = { enabled: boolean; mode: "error" | "warn"; always_projects: string[]; never_projects: string[]; always_repos: string[]; never_repos: string[]; disabled_builtin: string[] };
export type CodeScanRule = { id: string; type: "builtin" | "custom"; enabled: boolean; definition: string; severity?: string; languages?: string[]; message?: string; category?: string; updated_at?: string };

export const codeScanning = {
  settings: () => sg<CodeScanSettings>("/api/code-scanning/settings"),
  saveSettings: (s: Partial<CodeScanSettings>) => sg<CodeScanSettings>("/api/code-scanning/settings", { method: "PUT", json: s }),
  rules: (q: { type?: string; status?: string; q?: string } = {}) => sg<CodeScanRule[]>(`/api/code-scanning/rules${qs(q)}`),
  create: (definition: string) => sg<CodeScanRule>("/api/code-scanning/rules", { method: "POST", json: { definition } }),
  update: (id: string, definition: string) => sg<CodeScanRule>(`/api/code-scanning/rules/${encodeURIComponent(id)}`, { method: "PUT", json: { definition } }),
  toggle: (id: string, enabled: boolean) => sg<{ enabled: boolean }>(`/api/code-scanning/rules/${encodeURIComponent(id)}/enabled`, { method: "PUT", json: { enabled } }),
  remove: (id: string) => sg<{ deleted: string }>(`/api/code-scanning/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  tryRule: (definition: string, path: string, code: string) =>
    sg<{ findings: { line: number; column: number; message: string; snippet: string }[] }>("/api/code-scanning/rules/try", { method: "POST", json: { definition, path, code } }),
  repositories: () => sg<{ id: string; name: string; scanned: boolean; why: string }[]>("/api/code-scanning/repositories"),
};

// -- Compass (api/compass.py) --

export type CompassTag = { id: string; name: string; category?: string; category_id?: string };
export type TagCategory = { id: string; name: string; orgs: string[]; tags: CompassTag[] };
export type CompassMeta = { item_id: string; tags: CompassTag[]; status: { status: string; by: string; at: string } | null; collections: { id: string; name: string }[]; views: number; can_tag: boolean; can_promote: boolean; can_curate: boolean };
export type SearchResult = {
  group: "apps" | "objects" | "datasets" | "files"; kind: string; id: string; name: string; type_label: string; path: string; updated_at?: string; promoted: boolean; views: number;
  tags: CompassTag[]; columns: string[]; score: number; markings?: number; href?: string; parent_id?: string | null; created_by?: string | null;
};
export type Collection = { id: string; name: string; description: string; items: string[]; hidden?: number; created_by: string; created_at: string };
export type CatalogItem = { id: string; name: string; kind: string; tags: CompassTag[]; collections: string[]; updated_at: string; path: string[] };
export type CompassProject = { id: string; rid: string; name: string; description: string; cover: string; point_of_contact: { id: string; name: string; contact?: { kind: "email" | "issues"; value: string } | null } | null; discoverable: boolean; can_edit: boolean; role: string | null; views: number; created: string; modified: string };

export const compass = {
  search: (q: { q?: string; type?: string; tags?: string; project?: string; path?: string; promoted?: string; jump?: string; limit?: number; creator?: string }) =>
    sg<{ query: string; creator?: string | null; total: number; groups: Record<string, number>; results: SearchResult[] }>(`/api/compass/search${qs(q)}`),
  tags: () => sg<TagCategory[]>("/api/compass/tags"),
  createCategory: (name: string, orgs?: string[]) => sg<TagCategory>("/api/compass/tags/categories", { method: "POST", json: { name, orgs } }),
  deleteCategory: (id: string) => sg<{ deleted: string }>(`/api/compass/tags/categories/${id}`, { method: "DELETE" }),
  addTag: (cid: string, name: string) => sg<CompassTag>(`/api/compass/tags/categories/${cid}/tags`, { method: "POST", json: { name } }),
  deleteTag: (id: string) => sg<{ deleted: string }>(`/api/compass/tags/${id}`, { method: "DELETE" }),
  meta: (id: string) => sg<CompassMeta>(`/api/compass/items/${id}/meta`),
  setTags: (id: string, tags: string[]) => sg<CompassMeta>(`/api/compass/items/${id}/tags`, { method: "PUT", json: { tags } }),
  setStatus: (id: string, status: string | null) => sg<CompassMeta>(`/api/compass/items/${id}/status`, { method: "PUT", json: { status } }),
  view: (id: string) => sg<{ views: number }>(`/api/compass/items/${id}/view`, { method: "POST" }),
  readme: (folder: string) => sg<{ item_id: string | null; text: string | null }>(`/api/compass/folders/${folder}/readme`),
  saveReadme: (folder: string, text: string) => sg<{ item_id: string | null; text: string | null }>(`/api/compass/folders/${folder}/readme`, { method: "PUT", json: { text } }),
  project: (id: string) => sg<CompassProject>(`/api/compass/projects/${id}`),
  autosaved: (id: string) => sg<{ id: string; name: string; content_type?: string; updated_at?: string }[]>(`/api/compass/projects/${id}/autosaved`),
  saveAutosaved: (itemId: string, folderId: string) => sg<{ id: string }>(`/api/compass/autosaved/${itemId}/save`, { method: "POST", json: { folder_id: folderId } }),
  updateProject: (id: string, body: { description?: string; cover?: string; point_of_contact?: string; discoverable?: boolean }) =>
    sg<CompassProject>(`/api/compass/projects/${id}`, { method: "PUT", json: body }),
  activity: (id: string) => sg<{ time: string; user: string; name: string; categories: string[]; resources: { id: string; name: string; type?: string }[]; result: string }[]>(`/api/compass/projects/${id}/activity`),
  accessGraph: (id: string) => sg<{ nodes: { id: string; kind: string; name: string }[]; edges: { from: string; to: string; label: string }[]; open_to_everyone: boolean }>(`/api/compass/projects/${id}/access-graph`),
  collections: () => sg<Collection[]>("/api/compass/collections"),
  createCollection: (name: string, description: string) => sg<Collection>("/api/compass/collections", { method: "POST", json: { name, description } }),
  deleteCollection: (id: string) => sg<{ deleted: string }>(`/api/compass/collections/${id}`, { method: "DELETE" }),
  addToCollection: (id: string, items: string[]) => sg<Collection>(`/api/compass/collections/${id}/items`, { method: "POST", json: { items } }),
  removeFromCollection: (id: string, item: string) => sg<Collection>(`/api/compass/collections/${id}/items/${item}`, { method: "DELETE" }),
  catalog: (q: { collection?: string; tags?: string; kind?: string }) => sg<{ items: CatalogItem[] }>(`/api/compass/catalog${qs(q)}`),
  settings: () => sg<{ curators: string[]; taggers: string[]; catalog_managers: string[] }>("/api/compass/settings"),
  saveSettings: (s: { curators?: string[]; taggers?: string[]; catalog_managers?: string[] }) => sg<{ curators: string[]; taggers: string[]; catalog_managers: string[] }>("/api/compass/settings", { method: "PUT", json: s }),
};

/** Where a search result opens. */
export const resultHref = (r: SearchResult) =>
  r.href ?? (r.kind === "dataset" ? `/datasets/${r.id}` : r.kind === "project" || r.kind === "folder" ? `/files/${r.id}` : r.parent_id ? `/files/${r.parent_id}` : "/files");

// -- Enterprise and Infrastructure security (api/security_posture.py) --

export type PostureCheck = {
  id: string; title: string; status: "pass" | "warn" | "fail" | "manual"; detail: string; section: string;
  action: { kind: string; href?: string; label?: string; id?: string; days?: number } | null;
  items: Record<string, unknown>[]; attestation?: { status: string; note: string; evidence: string | null; by: string; at: string };
};
export type Posture = { checks: PostureCheck[]; counts: Record<string, number>; score: number; at: string };

export const posture = {
  enterprise: () => sg<Posture>("/api/security-posture/enterprise"),
  infrastructure: () => sg<Posture>("/api/security-posture/infrastructure"),
  attest: (id: string, body: { status: "yes" | "partial" | "no"; note: string; evidence?: string | null }) =>
    sg<PostureCheck>(`/api/security-posture/attestations/${id}`, { method: "PUT", json: body }),
  review: (uid: string, note: string) => sg<unknown>(`/api/security-posture/service-accounts/${uid}/review`, { method: "PUT", json: { note } }),
  revokeTokens: (ids: string[]) => sg<{ revoked: number }>("/api/security-posture/tokens/revoke", { method: "POST", json: { token_ids: ids } }),
  disableUsers: (ids: string[]) => sg<{ disabled: number }>("/api/security-posture/users/disable", { method: "POST", json: { user_ids: ids } }),
  setContact: (contact: string) => sg<{ contact: string }>("/api/security-posture/contact", { method: "PUT", json: { contact } }),
  contact: () => sg<{ contact: string }>("/api/security-posture/contact"),
  scanDependencies: () => sg<{ at: string; packages: number; vulnerable: unknown[] }>("/api/security-posture/dependencies/scan", { method: "POST" }),
};
