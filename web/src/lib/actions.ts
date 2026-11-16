/**
 * Action types (api/ontology_actions.py), notifications and the functions registry (api/functions_registry.py).
 */
import { API_URL } from "./api";
import { request, type Edit } from "./ontology";

export type ValueRef =
  | { kind: "parameter"; parameter: string }
  | { kind: "object_property"; parameter: string; property: string }
  | { kind: "static"; value: unknown }
  | { kind: "current_user" }
  | { kind: "current_time" }
  | { kind: "writeback_response"; field?: string }
  | { kind: "schedule_run" }
  | { kind: "new_object"; rule: number };

export type Condition =
  | { kind: "and" | "or" | "not"; children: Condition[]; failure_message?: string }
  | {
      kind: "condition";
      left: { kind: "current_user_id" | "current_user_groups" | "current_user_attribute" | "parameter" | "execution_context"; parameter?: string; property?: string; attribute?: string; length?: boolean };
      op: string;
      value?: { kind: "static" | "parameter" | "no_value"; value?: unknown; parameter?: string; property?: string };
      failure_message?: string;
    };

export type ActionParam = {
  id: string;
  display_name: string;
  description?: string;
  type: string;
  required?: boolean;
  array?: boolean;
  object_type_id?: string | null;
  interface_id?: string | null;
  property?: string | null;
  visibility?: "normal" | "hidden" | "disabled";
  default?: { kind: "static" | "current_user" | "current_time" | "object_property" | "parameter"; value?: unknown; parameter?: string; property?: string } | null;
  allowed?: { kind: "values"; values: unknown[] } | { kind: "object_set_property"; object_type_id: string; property: string } | null;
  object_filter?: { starting?: { kind: "all" | "parameter"; parameter?: string; object_type_id?: string }; search_around?: { link_type_id: string; direction: string }[]; filters?: { property: string; values: { kind: "static" | "parameter"; value?: unknown; parameter?: string; property?: string }[] }[] } | null;
  overrides?: { name?: string; conditions: Condition[]; then: { visibility?: "normal" | "hidden" | "disabled"; required?: boolean; default?: ActionParam["default"]; allowed?: ActionParam["allowed"] } }[];
  value_type_id?: string | null;
  struct_fields?: { api_name: string; display_name?: string; type: string }[];
};

export type FnRef = { function_id: string; version?: string; inputs?: Record<string, ValueRef> };
export type Rule = {
  kind: string;
  object_type_id?: string;
  object_param?: string;
  primary_key?: ValueRef | null;
  properties?: Record<string, ValueRef>;
  links?: { link_type_id: string; target: ValueRef }[];
  link_type_id?: string;
  source?: ValueRef;
  target?: ValueRef;
  interface_id?: string;
  object_type_param?: string;
  interface_param?: string;
  link_constraint?: string;
  function_id?: string;
  version?: string;
  batched?: boolean;
  inputs?: Record<string, ValueRef>;
  recipients?: { kind: "static" | "parameter" | "object_property" | "current_user"; users?: string[]; groups?: string[]; parameter?: string; property?: string }[];
  /** a function returning a Notification (heading, content, links) for each recipient */
  content_function?: FnRef | null;
  /** a function returning the recipients (Principals: users and groups) */
  recipients_function?: FnRef | null;
  subject?: string;
  body?: string;
  email_html?: string;
  link?: { kind: "object_param" | "new_object" | "url"; parameter?: string; url?: string; label?: string } | null;
  mode?: "writeback" | "side_effect";
  webhook_id?: string;
  pipeline_id?: string;
  schedule_id?: string;
  /** apply_scenario: the string parameter holding the scenario RID, and the types the scenario may change */
  scenario_param?: string;
  object_type_ids?: string[];
  link_type_ids?: string[];
};

export type Section = { id: string; title: string; description?: string; columns: 1 | 2; collapsible?: boolean; collapsed?: boolean; hidden?: boolean; parameters: string[] };

export const RULE_INFO: { kind: string; label: string; group: "Nexus" | "Interface" | "Logic" | "Side effect"; description: string }[] = [
  { kind: "create_object", label: "Create object", group: "Nexus", description: "Create an object of a type; optionally add many-to-many links." },
  { kind: "modify_object", label: "Modify object(s)", group: "Nexus", description: "Change properties of objects from an object parameter." },
  { kind: "create_or_modify_object", label: "Create or modify object(s)", group: "Nexus", description: "Modify the selected object, or create one when none is selected." },
  { kind: "delete_object", label: "Delete object(s)", group: "Nexus", description: "Delete objects from an object parameter." },
  { kind: "create_link", label: "Create link(s)", group: "Nexus", description: "Add many-to-many links between objects." },
  { kind: "delete_link", label: "Delete link(s)", group: "Nexus", description: "Remove many-to-many links between objects." },
  { kind: "create_interface_object", label: "Create object(s) of interface", group: "Interface", description: "Create an object of any type implementing an interface." },
  { kind: "modify_interface_object", label: "Modify object(s) of interface", group: "Interface", description: "Change interface properties of objects." },
  { kind: "delete_interface_object", label: "Delete object(s) of interface", group: "Interface", description: "Delete objects of any implementing type." },
  { kind: "create_interface_link", label: "Create link(s) on object(s) of interface", group: "Interface", description: "Link through an interface link type constraint." },
  { kind: "delete_interface_link", label: "Delete link(s) on object(s) of interface", group: "Interface", description: "Unlink through an interface link type constraint." },
  { kind: "function", label: "Function", group: "Logic", description: "An Nexus edit function computes the edits (no other Nexus rules)." },
  { kind: "apply_scenario", label: "Apply scenario", group: "Logic", description: "Merge an Nexus scenario's edits (the Scenario parameter holds its RID) as one transaction." },
  { kind: "notification", label: "Notification", group: "Side effect", description: "Notify users in the platform and by email." },
  { kind: "webhook", label: "Webhook", group: "Side effect", description: "Call an external system before (writeback) or after the edits." },
  { kind: "schedule", label: "Schedule build", group: "Side effect", description: "Trigger a build schedule; its run ID can be written to a property." },
];
export const ruleLabel = (k: string) => RULE_INFO.find((r) => r.kind === k)?.label ?? k;

export type ParamState = {
  id: string;
  visible: boolean;
  disabled: boolean;
  required: boolean;
  value: unknown;
  options?: { value: unknown; label: string; object_type_id?: string }[];
  missing?: boolean;
  override?: string | boolean;
};
export type FormState = {
  parameters: ParamState[];
  sections: (Section & { hidden: boolean })[];
  errors: Record<string, string>;
  criteria: { passed: boolean; failures: string[] };
  revertible: boolean;
};
export type ApplyResult = {
  action_rid: string;
  edits: (Edit & { title?: string })[];
  links: { op: string; link_type_id: string; source: string; target: string }[];
  notifications?: { user: string; id: string }[];
  notification_error?: string;
  webhooks?: { webhook_id: string; status: string }[];
  schedule_run?: string;
  revertible: boolean;
};
export type TestResult = { valid: boolean; error?: string; category?: string; criteria?: FormState["criteria"]; edits?: Edit[]; links?: ApplyResult["links"]; side_effects?: { kind: string; mode?: string }[]; ms?: number };
export type ActionRun = {
  rid: string;
  at: string;
  user: string;
  status: "succeeded" | "failed";
  category: string | null;
  error: string | null;
  ms: number;
  version: number;
  edited: { op: string; object_type_id: string; primary_key: string }[];
  links?: unknown[];
  parameters?: Record<string, unknown>;
  reverted_at?: string;
  notified?: string[];
  webhooks?: { webhook_id: string; status: string }[];
};
export type Alert = { id?: string; monitor: string; value: number | null; threshold: number; at: string; resolved_at: string | null };
export type Metrics = {
  succeeded: number;
  failed: number;
  failures_by_category: Record<string, number>;
  p95_ms: number | null;
  by_day: { day: string; succeeded: number; failed: number }[];
  alerts: Alert[];
};
export type Notification = { id: string; at: string; subject: string; body: string; link: string | null; link_label: string; action_type_id: string; from: string; read: boolean };

export const actions = {
  form: (id: string, parameters: Record<string, unknown>, touched?: string[]) =>
    request<FormState>(`/action-types/${id}/form`, { method: "POST", json: { parameters, touched } }),
  /** justification: Submit action checkpoint answers given in the form ({config id: answer}), sent with the request */
  apply: (id: string, parameters: Record<string, unknown>, justification?: Record<string, unknown>) =>
    request<ApplyResult>(`/action-types/${id}/apply`, {
      method: "POST",
      json: { parameters },
      // header values are Latin-1: other characters travel as JSON \u escapes
      ...(justification ? { headers: { "x-bluesandai-justification": JSON.stringify(justification).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`) } } : {}),
    }),
  test: (id: string, parameters: Record<string, unknown>) => request<TestResult>(`/action-types/${id}/test`, { method: "POST", json: { parameters } }),
  batch: (id: string, requests: Record<string, unknown>[]) =>
    request<{ applied: number; edits: number }>(`/action-types/${id}/apply-batch`, { method: "POST", json: { requests } }),
  inlineEdit: (object_type_id: string, primary_key: string, property: string, value: unknown) =>
    request<ApplyResult>("/actions/inline-edit", { method: "POST", json: { object_type_id, primary_key, property, value } }),
  revert: (rid: string) => request<{ reverted: string; objects: number }>(`/actions/runs/${encodeURIComponent(rid)}/revert`, { method: "POST" }),
  metrics: (id: string, days = 30) => request<Metrics>(`/action-types/${id}/metrics?days=${days}`),
  runs: (id: string, days = 7) => request<ActionRun[]>(`/action-types/${id}/runs?days=${days}`),
  log: (id: string) => request<{ status: string; config: Record<string, unknown>; objects: { primary_key: string; title: string; properties: Record<string, unknown> }[] }>(`/action-types/${id}/log`),
  generateLog: (id: string) => request<{ object_type: { id: string } }>(`/action-types/${id}/log/generate`, { method: "POST" }),
  logFor: (typeId: string, pk: string) =>
    request<{ action_type_id: string; action_type: string; rid: string; at: string; user: string; reverted: boolean }[]>(`/actions/log-for/${typeId}/${encodeURIComponent(pk)}`),
};

async function plain<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
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

export const notifications = {
  list: () => plain<{ unread: number; notifications: Notification[] }>("/api/notifications"),
  read: (id: string) => plain<unknown>(`/api/notifications/${id}/read`, { method: "POST" }),
};

export type FnInput = { name: string; type: string; required: boolean; default?: unknown };
export type FnSignature = {
  id: string;
  name: string;
  file: string;
  doc: string;
  line: number;
  inputs: FnInput[];
  output: string;
  api_name: string | null;
  edits: string[] | null;
  kind: "function" | "query" | "edit";
  sources?: string[];
  errors?: { name: string; doc: string }[];
  /** "sql": an Ontology SQL function published from a SQL Studio worksheet; "model": the function of a live model deployment */
  source?: "sql" | "model";
  deployment?: string;
  deployment_href?: string | null;
  sql?: string;
  worksheet_id?: string;
};
export type Telemetry = {
  calls: { path: string; method: string; ms: number; status: string; at_ms: number }[];
  log_records: { level: string; logger: string; message: string; at_ms: number }[];
  spans: { name: string; attributes: Record<string, unknown>; start_ms: number; ms: number; error: boolean }[];
  peak_memory_mb?: number;
  logs?: string;
};
export type FnRun = { id?: string; at: string; version: string; ms: number; status: string; category: string | null; error: string | null; resource: string | null; user: string; calls?: number; call_ms?: number; warnings?: number; error_name?: string };
export type FunctionRow = FnSignature & { repo_id: string; version: string; released_at: string; rid: string; succeeded?: number; failed?: number };
export type FunctionDetail = FunctionRow & {
  repository: string;
  versions: { version: string; commit: string; at: string; by?: string; breaking: { function: string; change: string }[]; signature: FnSignature }[];
  config: Record<string, { timeout_s?: number; memory_mb?: number; snapshots?: string }>;
  monitors: { kind: string; threshold: number; window_minutes: number }[];
  usage: { kind: "action_type" | "automation" | "workshop"; id: string; name: string; version?: string }[];
  metrics: Metrics;
};
export type FnResult = {
  ok: boolean;
  version: string;
  ms: number;
  value?: unknown;
  edits?: Edit[];
  applied?: boolean;
  error?: string;
  user_facing?: boolean;
  category?: string;
  logs?: string;
  run_id?: string;
  telemetry?: Telemetry;
  error_name?: string;
  error_params?: Record<string, unknown>;
};
/** A function implementing a function interface, usable as a model ("function:<function id>"); an embedding model's
 *  dimension is the declared one, else the one recorded from its first answer (null until then). */
export type RegisteredModel = {
  id: string;
  label: string;
  vendor: string;
  description?: string;
  note?: string;
  version: string;
  function_id: string;
  repo_id: string;
  registered: true;
  dimension?: number | null;
  dimension_source?: "declared" | "observed" | null;
  streaming?: boolean;
};
export type BranchRelease = { version: string; target: string; branch: string; branch_name?: string; commit: string; at: string; by?: string; functions: string[] };
export type Release = { version: string; commit: string; at: string; by?: string; functions: FnSignature[]; breaking: { function: string; change: string }[]; warning: boolean };

export const functions = {
  list: (q = "", kind?: string) => plain<FunctionRow[]>(`/api/functions?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}`),
  get: (id: string) => plain<FunctionDetail>(`/api/functions/${id}`),
  execute: (id: string, inputs: Record<string, unknown>, version?: string, resource?: string) =>
    plain<FnResult>(`/api/functions/${id}/execute`, { method: "POST", json: { inputs, version, resource } }),
  /** global branches: publish towards a version target on an Ontology branch, and the branched pre-releases */
  publishBranch: (body: { repo_id: string; version_target: string; branch_id: string; ref?: string }) => plain<BranchRelease>("/api/functions/publish-branch", { method: "POST", json: body }),
  branchReleases: (repoId: string, branchId?: string) => plain<BranchRelease[]>(`/api/functions/repos/${repoId}/branch-releases${branchId ? `?branch_id=${branchId}` : ""}`),
  /** functions usable as Pipeline Builder UDFs (no Ontology types in their signature) */
  pipelineUdfs: () => plain<FunctionRow[]>("/api/functions/tools/pipeline-udf/functions"),
  /** registered models: functions implementing ChatCompletion (language models) and Embedding (embedding models) */
  registeredModels: () => plain<{ chat: RegisteredModel[]; embedding: RegisteredModel[] }>("/api/functions/models/registered"),
  queries: () => plain<{ api_name: string; id: string; name: string; version: string; inputs: FnInput[]; output: string }[]>("/api/functions/queries"),
  publish: (repo_id: string, version: string, ref?: string, strict = false) => plain<Release>("/api/functions/publish", { method: "POST", json: { repo_id, version, ref, strict } }),
  releases: (repoId: string) => plain<Release[]>(`/api/functions/repos/${repoId}/releases`),
  aliases: (repoId: string) => plain<{ custom: Record<string, string>; model: Record<string, string> }>(`/api/functions/repos/${repoId}/aliases`),
  saveAliases: (repoId: string, body: { custom: Record<string, string>; model: Record<string, string> }) =>
    plain<unknown>(`/api/functions/repos/${repoId}/aliases`, { method: "PUT", json: body }),
  config: (id: string, version: string, body: { timeout_s?: number | null; memory_mb?: number | null; snapshots?: string | null }) =>
    plain<unknown>(`/api/functions/${id}/config`, { method: "PUT", json: { version, ...body } }),
  monitors: (id: string, monitors: FunctionDetail["monitors"]) => plain<unknown>(`/api/functions/${id}/monitors`, { method: "PUT", json: { monitors } }),
  runs: (id: string) => plain<FnRun[]>(`/api/functions/${id}/runs`),
  runDetail: (id: string, runId: string) => plain<FnRun & { telemetry: Telemetry | null }>(`/api/functions/${id}/runs/${runId}`),
  repoSources: (repoId: string) =>
    plain<{ imported: string[]; available: { id: string; name: string; api_name: string | null; code_imports: boolean; domains: string[] }[] }>(`/api/functions/repos/${repoId}/sources`),
  setRepoSources: (repoId: string, sources: string[]) => plain<unknown>(`/api/functions/repos/${repoId}/sources`, { method: "PUT", json: { sources } }),
  /** a streaming function: calls onChunk for each chunk as it is yielded, resolves with the result */
  stream: async (id: string, inputs: Record<string, unknown>, version: string | undefined, onChunk: (c: unknown) => void): Promise<FnResult> => {
    const res = await fetch(`${API_URL}/api/functions/${id}/execute/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs, version }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let result: FnResult | null = null;
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
        if (ev === "chunk") onChunk(payload.chunk);
        else if (ev === "result") result = payload;
      }
    }
    if (!result) throw new Error("the stream ended without a result");
    return result;
  },
  preview: (body: { repo_id: string; branch?: string; file?: string; function?: string; inputs?: Record<string, unknown> }) =>
    plain<{ functions?: FnSignature[]; ok?: boolean; value?: unknown; edits?: Edit[]; error?: string; logs?: string }>("/api/functions/preview", { method: "POST", json: body }),
};

export const FAILURE_LABEL: Record<string, string> = {
  invalid_parameter: "Invalid parameter",
  scale_limit: "Scale limit",
  authentication: "Authentication / submission criteria",
  side_effect: "Side effect",
  function: "Function",
  user_facing_function: "User-facing function error",
  conflict: "Conflict",
  unclassified: "Unclassified",
  runtime_failure: "Runtime failure",
  resource_limit_exceeded: "Resource limit exceeded",
  user_facing_error: "User-facing error",
  invalid_inputs_error: "Invalid inputs",
  invalid_output_error: "Invalid output",
  undeclared_object_types_edited: "Undeclared object types edited",
};
