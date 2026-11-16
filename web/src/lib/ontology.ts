/**
 * Ontology Manager, AIP Logic and Automate (api/ontology.py): object types and their objects, action
 * types, Logic functions and automations.
 */
import { API_URL } from "./api";
import type { IconName } from "@/components/Icon";

export type PropertyType =
  | "string"
  | "integer"
  | "double"
  | "boolean"
  | "date"
  | "timestamp"
  | "media"
  | "string_array"
  | "timeseries"
  | "long"
  | "short"
  | "byte"
  | "float"
  | "decimal"
  | "geopoint"
  | "geoshape"
  | "struct"
  | "vector"
  | "attachment"
  | "marking"
  | "cipher"
  | "geotemporal_series_reference";

/** limited: not usable in action types (byte, float, short) or queried by KNN only (vector) */
export const PROPERTY_TYPES: { id: PropertyType; label: string; icon: IconName; limited?: string }[] = [
  { id: "string", label: "String", icon: "doc" },
  { id: "integer", label: "Integer", icon: "list" },
  { id: "long", label: "Long", icon: "list" },
  { id: "short", label: "Short", icon: "list", limited: "Not usable in action types" },
  { id: "byte", label: "Byte", icon: "list", limited: "Not usable in action types" },
  { id: "double", label: "Double", icon: "list" },
  { id: "float", label: "Float", icon: "list", limited: "Not usable in action types" },
  { id: "decimal", label: "Decimal", icon: "list" },
  { id: "boolean", label: "Boolean", icon: "check" },
  { id: "date", label: "Date", icon: "clock" },
  { id: "timestamp", label: "Timestamp", icon: "clock" },
  { id: "geopoint", label: "Geopoint", icon: "globe" },
  { id: "geoshape", label: "Geoshape", icon: "globe" },
  { id: "struct", label: "Struct", icon: "grid" },
  { id: "vector", label: "Vector", icon: "graph", limited: "Queried by KNN only; at most 2,048 dimensions" },
  { id: "media", label: "Media reference", icon: "image" },
  { id: "attachment", label: "Attachment", icon: "doc" },
  { id: "marking", label: "Marking", icon: "eye" },
  { id: "cipher", label: "Cipher text", icon: "eye" },
  { id: "string_array", label: "Array<String> (legacy)", icon: "layers" },
  { id: "timeseries", label: "Time series", icon: "wave" },
  // GTSR: a series of a geotemporal series sync (the property names the sync)
  { id: "geotemporal_series_reference", label: "Geotemporal series reference", icon: "wave" },
];
export const GEO_PROPERTY_TYPES: PropertyType[] = ["geopoint", "geoshape", "geotemporal_series_reference"];
export const STRUCT_FIELD_TYPES: PropertyType[] = ["string", "integer", "long", "short", "byte", "double", "float", "decimal", "boolean", "date", "timestamp", "geopoint"];
export const typeLabel = (t: string, array?: boolean) => {
  const base = PROPERTY_TYPES.find((p) => p.id === t)?.label ?? (t === "object" ? "Object" : t);
  return array ? `Array<${base}>` : base;
};
export const typeIcon = (t: string): IconName => PROPERTY_TYPES.find((p) => p.id === t)?.icon ?? (t === "object" ? "cube" : "doc");

export type Status = "experimental" | "active" | "deprecated" | "example";
export type Visibility = "prominent" | "normal" | "hidden";
export type Deprecation = { reason: string; deadline?: string | null; replaced_by?: string | null };
export type StructField = { api_name: string; display_name?: string; type: PropertyType; main?: boolean };
export type ValueFormatting =
  | { kind: "number"; style?: "standard" | "currency" | "unit" | "percent" | "affix"; currency?: string; unit?: string; prefix?: string; suffix?: string; grouping?: boolean; notation?: "standard" | "compact" | "scientific" | "engineering"; max_fraction?: number | null; min_fraction?: number | null; max_significant?: number | null; min_integer?: number | null }
  | { kind: "date"; format: "date" | "datetime" | "datetime_short" | "iso" | "relative" | "time"; time_zone?: string | null }
  | { kind: "user" }
  | { kind: "resource" };
export type CondRule = {
  /** standard: compare a property; always: fallback; math: a formula over properties ({prop}) */
  when: { kind: "standard" | "always" | "math"; property?: string; op?: "eq" | "contains" | "starts_with" | "ends_with" | "is_null" | "gt" | "gte" | "lt" | "lte" | "between"; value?: unknown; value2?: unknown; value_property?: string; negate?: boolean; expression?: string };
  style: { color?: string; background?: string; align?: "left" | "right" };
};
export type Reducer = { field?: string; order: "asc" | "desc" };
export type Derived = { links: { link_type_id: string; direction: "forward" | "reverse" }[]; aggregation: "none" | "count" | "sum" | "avg" | "min" | "max" | "collect_list" | "collect_set" | "approximate_cardinality"; property?: string; limit?: number };
export const RENDER_HINTS: { id: string; label: string; hint: string }[] = [
  { id: "searchable", label: "Searchable", hint: "Searched and sorted in applications" },
  { id: "sortable", label: "Sortable", hint: "Strings can be sorted (numbers and dates always are)" },
  { id: "selectable", label: "Selectable", hint: "Aggregated in Object Explorer histograms and charts" },
  { id: "low_cardinality", label: "Low cardinality", hint: "Few distinct values (needs Searchable)" },
  { id: "keywords", label: "Keywords", hint: "Its own section in Object Views" },
  { id: "long_text", label: "Long text", hint: "Shown as readable long text" },
  { id: "identifier", label: "Identifier", hint: "A numeric key, not formatted as a number" },
  { id: "disable_formatting", label: "Disable formatting", hint: "No locale number formatting" },
  { id: "leading_wildcards", label: "Leading wildcards", hint: "Leading wildcard queries (needs Searchable)" },
  { id: "regex_queries", label: "Regex queries", hint: "Regex queries (needs Searchable)" },
];
export const KNOWN_TYPE_CLASSES = [
  "hubble:media_url",
  "hubble:icon",
  "hierarchy:parent",
  "hubble-oe:hide-action",
  "actions:generate_uuid",
  "actions:prefill_current_user",
  "actions:view_object_with_type",
  "geo:altitude",
  "vertex:event_value",
  "vertex:event_property",
  "vertex:min",
  "vertex:max",
  "timeseries:parent",
];

/** type_class: what the property holds for an application, e.g. "timeseries:start_time" on an alert object type */
export type Property = {
  api_name: string;
  display_name: string;
  type: PropertyType;
  description?: string;
  type_class?: string | null;
  array?: boolean;
  status?: Status;
  deprecation?: Deprecation;
  visibility?: Visibility;
  required?: boolean;
  allow_empty_array?: boolean;
  edit_only?: boolean;
  mandatory_control?: boolean;
  allowed_markings?: string[];
  allowed_organizations?: string[];
  media_sources?: string[];
  analyzer?: string;
  upload_destination?: string;
  value_type_id?: string | null;
  shared_property_id?: string | null;
  value_formatting?: ValueFormatting | null;
  conditional_formatting?: CondRule[] | null;
  render_hints?: string[];
  type_classes?: string[];
  struct_fields?: StructField[];
  vector_dimension?: number | null;
  /** vector properties: the embedding model and the text property it embeds */
  embedding_model?: string | null;
  embedding_source?: string | null;
  reducers?: Reducer[];
  derived?: Derived | null;
  /** the action type that edits this property in place (Object Explorer, Object Views) */
  inline_edit_action_id?: string | null;
  /** geotemporal series reference: the geotemporal series sync whose series the values name */
  sync_id?: string | null;
};

export type ObjectType = {
  id: string;
  api_name: string;
  display_name: string;
  plural_name: string;
  description: string;
  icon: string;
  /** the icon's color (#rrggbb) */
  color?: string | null;
  status: Status | "promoted";
  deprecation?: Deprecation | null;
  properties: Property[];
  aliases?: string[];
  groups?: string[];
  visibility?: Visibility;
  ontology_id?: string;
  origin_ontology_id?: string;
  implements?: Implementation[];
  protected?: boolean;
  /** only action types with action logs may edit this object type */
  require_action_log?: boolean;
  roles?: { principal: string; role: string }[];
  object_view?: { related: { kind: "workshop" | "quiver" | "url"; id?: string; url?: string; label: string }[]; header_properties: string[] } | null;
  primary_key: string;
  title_property: string;
  generate_primary_key: boolean;
  /** Time series capabilities (Capabilities tab; api/ts_ontology.py) */
  time_series?: { properties: Record<string, unknown>; default_property: string | null; sensor: unknown | null } | null;
  /** a time series object type created from its backing dataset (setup assistant) */
  backing_dataset?: { dataset_id: string; name: string; synced_at: string } | null;
  created_at: string;
  updated_at: string;
  object_count: number;
  action_type_count: number;
  automation_count: number;
};

export type SecurityMarking = { id: string; name: string };
export type OntologyObject = {
  object_type_id: string;
  primary_key: string;
  title: string;
  properties: Record<string, unknown>;
  /** array properties with reducers: the one element shown where a single value is expected */
  reduced?: Record<string, unknown>;
  /** property security markings: what each property's security policy requires (informational) */
  property_markings?: Record<string, SecurityMarking[]>;
  created_at: string | null;
  updated_at: string | null;
};

export type ActionKind = "create" | "modify" | "delete" | "rules";
export type Parameter = {
  id: string;
  display_name: string;
  type: PropertyType | "object";
  required: boolean;
  property: string | null;
  array?: boolean;
  value_type_id?: string | null;
  prefill?: "current_user" | null;
  type_classes?: string[];
};
export type ActionType = {
  id: string;
  display_name: string;
  api_name: string;
  object_type_id: string;
  kind: ActionKind;
  description: string;
  parameters: Parameter[];
  status?: Status;
  type_classes?: string[];
  version?: number;
  interface_id?: string | null;
  rules?: import("./actions").Rule[];
  sections?: import("./actions").Section[];
  submission_criteria?: import("./actions").Condition[];
  capabilities?: { revertible?: boolean; isolation?: string; action_log?: { enabled?: boolean; object_type_id?: string; summary?: string; log_parameters?: boolean } };
  permissions?: { apply?: string[]; notification_permissions?: "all" | "any" };
  authorizations?: { read_markings?: string[]; write_markings?: string[] };
  monitors?: { kind: string; threshold: number; window_minutes: number }[];
  created_at: string;
  updated_at: string;
};
export const ACTION_KIND_LABEL: Record<ActionKind, string> = { create: "Create object", modify: "Modify object", delete: "Delete object", rules: "Rule-based" };

export type Edit = { op: "create" | "modify" | "delete"; object_type_id: string; primary_key: string; properties?: Record<string, unknown> };

/** {var: "inputPdf.PDF"} reads an input or an earlier block; {value: x} is a fixed value. */
export type Expr = { var: string } | { value: unknown };

export type InputType = "object" | "string" | "integer" | "double" | "boolean" | "media";
export type LogicInput = { name: string; type: InputType; object_type_id?: string; required?: boolean };
export type BlockType = "extract_pdf_text" | "join_array" | "text_template" | "use_llm" | "apply_action" | "semantic_search";
export type Block = { id: string; name: string; type: BlockType; description?: string; config: Record<string, unknown> };

export const BLOCKS: { type: BlockType; label: string; icon: IconName; output: string; description: string }[] = [
  { type: "extract_pdf_text", label: "Extract text from PDF", icon: "image", output: "Array<String>", description: "One string per page, from the text layer or OCR." },
  { type: "join_array", label: "Join array", icon: "join", output: "String", description: "Join an array into one string." },
  { type: "text_template", label: "Text template", icon: "doc", output: "String", description: "Write text with {{variables}}." },
  { type: "use_llm", label: "Use LLM", icon: "sparkle", output: "", description: "Prompt a model with {{variables}}." },
  { type: "apply_action", label: "Apply action", icon: "edit", output: "Nexus edits", description: "Create, modify or delete objects." },
  { type: "semantic_search", label: "Semantic search", icon: "search", output: "Array<Object>", description: "Retrieve the objects most relevant to a query (embeddings, keywords or both) as context for a model." },
];
export const blockInfo = (t: BlockType) => BLOCKS.find((b) => b.type === t)!;

export type LogicFunction = {
  id: string;
  name: string;
  description: string;
  inputs: LogicInput[];
  blocks: Block[];
  output: string | null;
  created_at: string;
  updated_at: string;
  run_count: number;
  last_run: LogicRun | null;
};

export type Step = { block_id: string; name: string; type: BlockType; output?: unknown; error?: string; ms: number; truncated?: number };
export type LogicRun = {
  id: string;
  logic_id: string;
  at: string;
  ms: number;
  status: "succeeded" | "failed";
  error: string | null;
  apply: boolean;
  inputs: Record<string, unknown>;
  steps: Step[];
  output?: unknown;
  edits: Edit[];
  applied?: (Edit & { title?: string })[];
  trigger?: { automation_id: string; automation: string } | null;
  /** run inside an Ontology scenario: reads saw it, applied edits went to it */
  scenario?: { id: string; name?: string } | null;
};

export type TimeSeriesCondition = {
  kind: "time_series";
  /** batch: evaluated when the input syncs get new data (or on a schedule); streaming: continuously */
  mode: "batch" | "streaming";
  /** the root object type the logic is templated on */
  object_type_id: string;
  alert_object_type_id: string;
  logic: { cards: { id: string; type: string; title?: string; config: Record<string, unknown> }[]; output?: string | null };
  scope?: { kind: "all" | "filter" | "objects"; property?: string | null; value?: unknown; primary_keys?: string[] };
  /** how often effects run on new alerts (0: after every evaluation) */
  evaluation_minutes?: number;
};
/** An object set: an object type narrowed by filters (automate.py). */
export type SetFilter = { property: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "is_empty" | "not_empty"; value?: unknown };
/** Condition settings shared by object set conditions. */
/** A derived property of an object set condition: an aggregate over linked objects that filters can use. */
export type ConditionDerived = { api_name: string; link_type_id: string; direction: "forward" | "reverse"; metric: "count" | "sum" | "avg" | "min" | "max"; property?: string | null };
export type ConditionSettings = {
  filters?: SetFilter[];
  derived?: ConditionDerived[];
  skip_peering_events?: boolean;
  allow_cycles?: boolean;
  max_objects?: number;
  batch?: { mode: "live" | "scheduled"; every_minutes?: number };
};
export type Condition =
  | ({ kind: "objects_added" | "objects_modified" | "objects_removed"; object_type_id: string; properties?: string[] } & ConditionSettings)
  | ({ kind: "threshold"; object_type_id: string; threshold: SetFilter } & ConditionSettings)
  | ({ kind: "run_on_all"; object_type_id: string; every_minutes?: number; cron?: string[]; timezone?: string } & ConditionSettings)
  | { kind: "schedule"; every_minutes?: number; cron?: string[]; timezone?: string }
  | { kind: "automation_completed"; automation_id: string; only_success?: boolean; pass_objects?: boolean }
  | TimeSeriesCondition;
/** An interface implementation: interface property → local property, link constraint → link type, action constraint → action type and parameters. */
export type Implementation = {
  interface_id: string;
  mapping?: Record<string, string>;
  links?: Record<string, string>;
  actions?: Record<string, { action_type_id: string; parameters?: Record<string, string> }>;
};

/** The object type a condition watches (the alert type for time series), if any. */
export function conditionType(c: Condition): string | undefined {
  if (c.kind === "time_series") return c.alert_object_type_id || c.object_type_id;
  return "object_type_id" in c ? c.object_type_id : undefined;
}
/** One line for an automation's condition and an effect (lists and summaries). */
export function describeCondition(c: Condition, types: Record<string, { display_name: string }>): string {
  const t = (id?: string) => (id && types[id]?.display_name) || "objects";
  const every = (x: { every_minutes?: number; cron?: string[] }) => (x.cron?.length ? `cron ${x.cron.join(" | ")}` : `every ${x.every_minutes ?? 60} min`);
  switch (c.kind) {
    case "schedule":
      return every(c)[0].toUpperCase() + every(c).slice(1);
    case "objects_added":
      return `Added to ${t(c.object_type_id)}${c.filters?.length ? " (filtered)" : ""}`;
    case "objects_removed":
      return `Removed from ${t(c.object_type_id)}${c.filters?.length ? " (filtered)" : ""}`;
    case "objects_modified":
      return `Modified ${t(c.object_type_id)}${c.properties?.length ? ` (${c.properties.join(", ")})` : ""}`;
    case "threshold":
      return `${t(c.object_type_id)}: ${c.threshold.property} ${c.threshold.op} ${String(c.threshold.value ?? "")}`;
    case "run_on_all":
      return `All ${t(c.object_type_id)}, ${every(c)}`;
    case "automation_completed":
      return "After another automation";
    default:
      return `Time series on ${t(c.object_type_id)}`;
  }
}
export function describeEffect(e: Effect, fns: Record<string, { name: string }>): string {
  return e.kind === "logic" ? `Run ${fns[e.logic_id]?.name ?? "Logic"}` : e.kind === "function" ? "Run function" : e.kind === "none" ? "Nothing" : e.kind === "notification" ? "Notify" : "Apply action";
}
export const OBJECT_CONDITIONS = ["objects_added", "objects_removed", "objects_modified", "threshold", "run_on_all"] as const;

/** Every effect may retry and fall back (automate.py). */
export type EffectSettings = {
  retries?: { max: number; backoff_seconds?: number };
  fallback?: Effect;
  continue_on_failure?: boolean;
};
export type Effect = (
  | { kind: "none" }
  | {
      kind: "notification";
      recipients: { principals?: string[]; property?: string };
      grouping?: "once" | "per_group" | "per_object";
      group_by?: string;
      subject: string;
      body?: string;
      email?: boolean;
    }
  | { kind: "logic"; logic_id: string; object_input?: string; inputs?: Record<string, unknown>; apply_edits?: boolean }
  | { kind: "action"; action_type_id: string; parameters: Record<string, Expr> }
  /** a published function (Functions registry); version is an exact version or a range such as ^1.0.0 */
  | { kind: "function"; function_id: string; version?: string; object_input?: string; inputs?: Record<string, unknown> }
) &
  EffectSettings;
export type EffectResult = { kind: string; status: string; attempts: number; edits: number; error: string | null; notified?: number; messages?: number; fallback?: { kind: string; status: string; error?: string } };

export type AutomationRun = {
  id: string;
  at: string;
  trigger: "objects_added" | "objects_modified" | "schedule" | "manual" | string;
  primary_key: string | null;
  primary_keys?: string[] | null;
  effects?: EffectResult[];
  dropped?: number;
  status: "succeeded" | "failed" | "warning" | "skipped";
  error: string | null;
  edits: number;
  ms: number;
  logic_run_id?: string;
  alerts_created?: number;
  alerts_closed?: number;
  objects?: number;
  points_scanned?: number;
};
export type TimeSeriesSummary = {
  mode: "batch" | "streaming";
  version: number;
  alerts_open: number;
  alerts_total: number;
  job: { alert_object_type_id: string; status: string | null; last_run_at: string | null; config: Record<string, unknown> | null };
  evaluations: { at: string; trigger: string; status: string; objects?: number; alerts_created?: number; alerts_closed?: number; points_scanned?: number; errors?: { primary_key: string; error: string }[] }[];
};
export type Automation = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  condition: Condition;
  effect: Effect;
  /** the effects in order (effect is the first) */
  effects?: Effect[];
  settings?: { expires_at?: string | null; administrators?: string[]; execution?: "parallel" | "sequential" };
  muted_by?: string[];
  /** muted for everyone (by an editor, optionally until a time, or by auto-mute): no effect runs */
  muted?: { by: string; at: string; until?: string | null; reason?: string } | null;
  expired?: boolean;
  owner?: string;
  created_at: string;
  updated_at: string;
  run_count: number;
  failed_runs: number;
  last_run: AutomationRun | null;
  /** time series alerting: evaluation status, alerts and recent evaluations */
  time_series?: TimeSeriesSummary;
  ts_version?: number;
};

export type LlmModel = { id: string; label: string; vendor: string; description: string; available: boolean; default: boolean };

let scenarioHeader: string | null = null;
/** Scope this tab's Ontology requests to a scenario (Insight on a branch): reads see its edits, actions write to it. */
export function setOntologyScenario(id: string | null): void {
  scenarioHeader = id;
}

/**
 * The platform branch (the branch taskbar): a scenario kept for this browser tab, so every app's Ontology requests
 * read and act on it until the user exits it. A page's own scenario (setOntologyScenario) wins while it is set.
 */
export type PlatformBranch = { id: string; name: string };
const BRANCH_KEY = "bluesandai.platformBranch";
export const BRANCH_EVENT = "bluesandai-branch";
export function platformBranch(): PlatformBranch | null {
  try {
    return typeof window === "undefined" ? null : (JSON.parse(sessionStorage.getItem(BRANCH_KEY) ?? "null") as PlatformBranch | null);
  } catch {
    return null;
  }
}
export function setPlatformBranch(b: PlatformBranch | null): void {
  try {
    if (b) sessionStorage.setItem(BRANCH_KEY, JSON.stringify(b));
    else sessionStorage.removeItem(BRANCH_KEY);
  } catch {}
  window.dispatchEvent(new Event(BRANCH_EVENT));
}

export async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers: Record<string, string> = {
    ...((rest.headers as Record<string, string> | undefined) ?? {}),
    ...(json !== undefined ? { "content-type": "application/json" } : {}),
    ...((scenarioHeader ?? platformBranch()?.id) ? { "x-bluesandai-scenario": (scenarioHeader ?? platformBranch()?.id) as string } : {}),
  };
  const res = await fetch(API_URL + "/api/ontology" + path, {
    cache: "no-store",
    ...rest,
    headers,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
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

export const ontology = {
  objectTypes: () => request<ObjectType[]>("/object-types"),
  objectType: (id: string) => request<ObjectType>(`/object-types/${id}`),
  createObjectType: (body: Partial<ObjectType>) => request<ObjectType>("/object-types", { method: "POST", json: body }),
  updateObjectType: (id: string, body: Partial<ObjectType> & { apply_status_to_properties?: boolean }) => request<ObjectType>(`/object-types/${id}`, { method: "PATCH", json: body }),
  deleteObjectType: (id: string) => request<unknown>(`/object-types/${id}`, { method: "DELETE" }),
  objects: (typeId: string, q = "") =>
    request<{ total: number; objects: OntologyObject[] }>(`/object-types/${typeId}/objects?q=${encodeURIComponent(q)}`),
  object: (typeId: string, pk: string) => request<OntologyObject>(`/object-types/${typeId}/objects/${encodeURIComponent(pk)}`),
  deleteObject: (typeId: string, pk: string) =>
    request<unknown>(`/object-types/${typeId}/objects/${encodeURIComponent(pk)}`, { method: "DELETE" }),
  mediaFolder: (objectTypeId?: string, property?: string) =>
    request<{ id: string }>(`/media-folder${objectTypeId && property ? `?object_type_id=${objectTypeId}&property=${encodeURIComponent(property)}` : ""}`),

  actionType: (id: string) => request<ActionType>(`/action-types/${id}`),
  actionTypes: (objectTypeId?: string) => request<ActionType[]>(`/action-types${objectTypeId ? `?object_type_id=${objectTypeId}` : ""}`),
  createActionType: (body: Partial<ActionType> & { object_type_id?: string | null; kind: ActionKind }) =>
    request<ActionType>("/action-types", { method: "POST", json: body }),
  updateActionType: (id: string, body: Partial<ActionType>) => request<ActionType>(`/action-types/${id}`, { method: "PATCH", json: body }),
  deleteActionType: (id: string) => request<unknown>(`/action-types/${id}`, { method: "DELETE" }),
  applyAction: (id: string, parameters: Record<string, unknown>) =>
    request<{ edits: Edit[] }>(`/action-types/${id}/apply`, { method: "POST", json: { parameters } }),

  logicList: () => request<LogicFunction[]>("/logic"),
  logic: (id: string) => request<LogicFunction>(`/logic/${id}`),
  createLogic: (body: Partial<LogicFunction>) => request<LogicFunction>("/logic", { method: "POST", json: body }),
  saveLogic: (id: string, body: Partial<LogicFunction>) => request<LogicFunction>(`/logic/${id}`, { method: "PUT", json: body }),
  deleteLogic: (id: string) => request<unknown>(`/logic/${id}`, { method: "DELETE" }),
  runLogic: (id: string, inputs: Record<string, unknown>, apply: boolean, scenarioId?: string | null) =>
    request<LogicRun>(`/logic/${id}/run`, { method: "POST", json: { inputs, apply, scenario_id: scenarioId || null } }),
  logicRuns: (id: string) => request<LogicRun[]>(`/logic/${id}/runs`),
  models: () => request<LlmModel[]>("/models"),

  automations: () => request<Automation[]>("/automations"),
  automation: (id: string) => request<Automation>(`/automations/${id}`),
  createAutomation: (body: Partial<Automation>) => request<Automation>("/automations", { method: "POST", json: body }),
  saveAutomation: (id: string, body: Partial<Automation>) => request<Automation>(`/automations/${id}`, { method: "PUT", json: body }),
  deleteAutomation: (id: string) => request<unknown>(`/automations/${id}`, { method: "DELETE" }),
  runAutomation: (id: string, primaryKey?: string) =>
    request<AutomationRun>(`/automations/${id}/run`, { method: "POST", json: { primary_key: primaryKey ?? null } }),
  automationRuns: (id: string) => request<AutomationRun[]>(`/automations/${id}/runs`),
};

/** A JPEG preview of a media file (first page of a PDF). */
export const mediaThumbUrl = (ref: string, size = 160) => `${API_URL}/api/pipeline/media/${ref.split("#")[0]}/thumbnail?size=${size}`;
// through the media sets endpoint: a reference to an item that was since overwritten or deleted keeps rendering
export const mediaUrl = (ref: string) => `${API_URL}/api/media-sets/items/${ref.split("#")[0]}/content?disposition=inline`;

/** Display text for a property value. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
