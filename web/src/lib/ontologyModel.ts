/**
 * Ontology model clients (api/ontology_model.py, ontology_branches.py, ontology_explorer.py): ontologies and roles,
 * link types, interfaces, shared properties, value types, groups, branches and proposals, migration, Object
 * Explorer, Object Views and usage metering.
 */
import { API_URL } from "./api";
import { capture } from "./drillCapture";
import { request, type ActionType, type ObjectType, type OntologyObject, type Property, type PropertyType, type Status, type StructField, type ValueFormatting, type Visibility } from "./ontology";

export type Role = "discoverer" | "viewer" | "editor" | "owner";
export const ROLES: Role[] = ["discoverer", "viewer", "editor", "owner"];
export type Grant = { principal: string; role: Role };

export type Ontology = {
  id: string;
  name: string;
  description: string;
  kind: "default" | "private" | "shared";
  organization_ids: string[];
  roles: Grant[];
  protect_main: boolean;
  created_at: string;
  counts: Record<string, number>;
  your_role: Role | null;
};

/** type_classes: "kind:name" on this side, e.g. vertex:link_primary_direction (Vertex points edge arrows at it) */
export type LinkSide = { object_type_id: string; display_name: string; plural_display_name?: string; api_name: string; visibility?: Visibility; type_classes?: string[] };
export type LinkType = {
  id: string;
  display_name: string;
  description: string;
  kind: "foreign_key" | "join_table" | "object_backed";
  cardinality: "one_to_one" | "many_to_one" | "many_to_many";
  source: LinkSide;
  target: LinkSide;
  foreign_key?: string | null;
  backing?: { object_type_id: string; source_property: string; target_property: string } | null;
  status: Status;
  type_classes: string[];
  ontology_id: string;
  protected?: boolean;
  link_count: number | null;
  created_at: string;
  updated_at: string;
};
export const LINK_KIND_LABEL: Record<LinkType["kind"], string> = { foreign_key: "Foreign key", join_table: "Join table", object_backed: "Backing object type" };
export const CARDINALITY_LABEL: Record<LinkType["cardinality"], string> = { one_to_one: "One to one", many_to_one: "Many to one", many_to_many: "Many to many" };

export type ObjectLinks = {
  link_type_id: string;
  link_type: string;
  direction: "forward" | "reverse";
  name: string;
  api_name: string;
  visibility: Visibility;
  object_type_id: string;
  object_type: string;
  many: boolean;
  editable: boolean;
  count: number;
  objects: OntologyObject[];
};

export type InterfaceProperty = {
  api_name: string;
  display_name?: string;
  description?: string;
  type: PropertyType;
  array?: boolean;
  required?: boolean;
  shared_property_id?: string | null;
  /** must / cannot be mapped to the implementing object type's primary key */
  primary_key_constraint?: "must" | "cannot" | null;
  type_classes?: string[];
  render_hints?: string[];
  visibility?: Visibility;
};
export type LinkConstraint = {
  api_name: string;
  display_name?: string;
  description?: string;
  target_kind?: "interface" | "object_type";
  target_interface_id?: string | null;
  target_object_type_id?: string | null;
  cardinality: "one" | "many";
  required?: boolean;
  inherited_from?: string;
};
export type ActionConstraint = {
  api_name: string;
  display_name?: string;
  description?: string;
  required?: boolean;
  parameters: { api_name: string; display_name?: string; type: string; list?: boolean; required?: boolean }[];
  inherited_from?: string;
};
export type Interface = {
  id: string;
  api_name: string;
  display_name: string;
  description: string;
  icon: string;
  status: Status;
  properties: InterfaceProperty[];
  all_properties: InterfaceProperty[];
  extends: string[];
  link_constraints: LinkConstraint[];
  all_link_constraints?: LinkConstraint[];
  action_type_constraints?: ActionConstraint[];
  all_action_constraints?: ActionConstraint[];
  searchable?: boolean;
  ontology_id: string;
  implemented_by: { object_type_id: string; display_name: string }[];
  created_at: string;
};

export type SharedProperty = {
  id: string;
  api_name: string;
  display_name: string;
  description?: string;
  type: PropertyType;
  array?: boolean;
  struct_fields?: StructField[];
  value_type_id?: string | null;
  value_formatting?: ValueFormatting | null;
  render_hints?: string[];
  type_classes?: string[];
  visibility?: Visibility;
  status: Status;
  ontology_id: string;
  usage: { object_type_id: string; object_type: string; property: string }[];
  interface_ids: string[];
  created_at: string;
};

export type ValueConstraints = {
  enum?: { values: unknown[]; case_sensitive?: boolean };
  range?: { min?: unknown; max?: unknown };
  regex?: { pattern: string; partial?: boolean };
  rid?: boolean;
  uuid?: boolean;
  unique?: boolean;
  element?: ValueConstraints;
  fields?: Record<string, string>;
};
export type ValueType = {
  id: string;
  api_name: string;
  display_name: string;
  description: string;
  base_type: string;
  element_type?: string | null;
  example: string;
  status: Status;
  ontology_id: string;
  version: number;
  constraints: ValueConstraints;
  failure_message: string;
  versions: { version: number; constraints: ValueConstraints; failure_message: string; created_at: string }[];
  consumers: { kind: "property" | "shared_property" | "parameter"; object_type?: string; property?: string; action_type?: string; parameter?: string }[];
  created_at: string;
};
export const VALUE_BASE_TYPES = ["string", "integer", "long", "short", "double", "float", "decimal", "boolean", "date", "timestamp", "array", "struct"];

export type Group = { id: string; name: string; description: string; ontology_id: string; object_type_ids: string[] };

export type ResourceKind = "object_type" | "action_type" | "link_type" | "interface" | "shared_property";
export const KIND_LABEL: Record<ResourceKind, string> = { object_type: "Object type", action_type: "Action type", link_type: "Link type", interface: "Interface", shared_property: "Shared property" };
export type Change = { key: string; kind: ResourceKind; id: string; op: "create" | "modify" | "delete"; name: string; fields: string[]; main_changed: boolean; conflict: boolean };
export type Task = Change & { status: "approved" | "rejected" | "in_progress"; needs: "editor" | "owner"; reviews: { user: string; decision: "approve" | "reject"; at: string; counts_as: string | null }[] };
export type Proposal = {
  id: string;
  title: string;
  description: string;
  reviewers: string[];
  comments: { id: string; key: string | null; user: string; text: string; at: string }[];
  status: "in_review" | "approved" | "merged" | "closed";
  created_at: string;
};
export type Branch = {
  id: string;
  name: string;
  description: string;
  ontology_id: string;
  status: "open" | "merged" | "closed";
  created_by: string;
  created_at: string;
  updated_at: string;
  rebased_at: string | null;
  changes: Record<string, unknown>;
  base: Record<string, unknown>;
  changelog: { at: string; user: string; key: string; op: string; fields: string[] }[];
  proposal: Proposal | null;
  change_list: Change[];
  conflicts: string[];
  main_updates: { key: string; name: string; updated_at: string | null; on_branch: boolean; deleted_on_main?: boolean }[];
  tasks: Task[];
  checks: { conflicts: string[]; errors: { key: string; error: string }[]; unapproved: string[]; design_findings?: { id: string; label: string; anti_pattern: string }[]; has_changes: boolean; mergeable: boolean } | null;
  author?: { username: string; display_name?: string | null } | null;
};
export type BranchRow = Omit<Branch, "base" | "changes" | "changelog" | "change_list" | "conflicts" | "main_updates" | "tasks" | "checks"> & { change_count: number; conflict_count: number };
export type ProposalRow = Proposal & { branch_id: string; branch: string; ontology_id: string; change_count: number; created_by: string; updated_at: string };
export type Conflict = { key: string; name: string; base: Record<string, unknown> | null; main: Record<string, unknown> | null; branch: Record<string, unknown> | null; fields_main: string[]; fields_branch: string[] };

export type MigratePreview = {
  target: Ontology;
  resources: { key: string; name: string; from: string; selected: boolean; required_by: string[] }[];
  missing: string[];
  problems: string[];
  ok: boolean;
};

export type Filter = { property: string; op: FilterOp; value?: unknown };
export type FilterOp = "eq" | "neq" | "contains" | "starts_with" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "is_null" | "not_null" | "regex" | "wildcard" | "any_word" | "phrase" | "within" | "linked" | "geo";
/** a geospatial search region (geopoint / geoshape properties): a box, a radius in km, or a polygon of [lat, lon] points */
export type GeoRegion =
  | { kind: "bbox"; min_lat: number; min_lon: number; max_lat: number; max_lon: number }
  | { kind: "distance"; lat: number; lon: number; km: number }
  | { kind: "polygon"; points: [number, number][] };
export const FILTER_OPS: { id: FilterOp; label: string }[] = [
  { id: "eq", label: "is" },
  { id: "neq", label: "is not" },
  { id: "contains", label: "contains" },
  { id: "starts_with", label: "starts with" },
  { id: "gt", label: ">" },
  { id: "gte", label: "≥" },
  { id: "lt", label: "<" },
  { id: "lte", label: "≤" },
  { id: "between", label: "between" },
  { id: "is_null", label: "is empty" },
  { id: "not_null", label: "has a value" },
  { id: "wildcard", label: "matches (* ?)" },
  { id: "regex", label: "matches regex" },
];
/** A property computed at query time from linked objects (api/ontology_search.py, the OSDK's withProperties). */
export type DerivedMetric = "count" | "sum" | "avg" | "min" | "max" | "exact_distinct" | "approximate_distinct" | "collect_list" | "collect_set" | "select";
export type DerivedSpec = { api_name: string; link_type_id: string; direction: "forward" | "reverse"; metric: DerivedMetric; property?: string | null; filters?: Filter[] };
export type SearchSpec = {
  object_type_id?: string | null;
  interface_id?: string | null;
  q?: string;
  /** search by meaning: the k objects most relevant to the query, in relevance order */
  semantic?: { query: string; property?: string; k?: number; mode?: "semantic" | "keyword" | "hybrid" } | null;
  filters?: Filter[];
  search_around?: { link_type_id: string; direction: "forward" | "reverse"; filters?: Filter[] }[];
  sort?: string | null;
  order?: "asc" | "desc";
  offset?: number;
  limit?: number;
  aggregate?: { metric: "count" | "sum" | "avg" | "min" | "max"; property?: string | null; group_by?: string | null } | null;
  histograms?: boolean;
  /** a chart for every property (the Explore view), not only the aggregatable ones */
  all_charts?: boolean;
  with_properties?: DerivedSpec[];
  resource?: string;
};
export type Histogram =
  | { property: string; display_name: string; kind: "numeric"; min: number; max: number; buckets: { from: number; to: number; count: number }[]; nulls: number }
  | { property: string; display_name: string; kind: "values" | "month"; buckets: { value: string; count: number }[]; distinct: number };
export type SearchResult = {
  object_type_id: string | null;
  interface_id: string | null;
  result_type: { id: string; display_name: string; properties: Property[]; primary_key: string };
  total: number;
  objects: OntologyObject[];
  path: { link_type_id: string; name: string; object_type_id: string; count: number }[];
  histograms: Histogram[];
  aggregation: { metric: string; property: string | null; group_by: string | null; groups: { group: string; value: number | string | null; count: number }[] } | null;
  execution: "in_memory" | "distributed";
  query_types: string[];
  compute_seconds: number;
};
export type Exploration = { id: string; name: string; description: string; spec: SearchSpec; owner: string; created_at: string; updated_at: string };

export type ObjectView = {
  object: OntologyObject;
  object_type: ObjectType;
  links: ObjectLinks[];
  actions: ActionType[];
  interfaces: { id: string; display_name: string; properties: Record<string, unknown> }[];
  automations: { id: string; name: string; enabled: boolean }[];
  history: { at: string; user: string; op: string; primary_key: string; properties: string[] }[];
  breadcrumbs: { object_type_id: string; primary_key: string; title: string }[];
  has_time_series: boolean;
  related: { kind: "workshop" | "quiver" | "url"; id?: string; url?: string; label: string }[];
  header_properties: string[];
};

export type OntologyUsage = {
  days: number;
  query_costs: Record<string, number>;
  compute_seconds: number;
  by_kind: Record<string, number>;
  by_resource: { resource: string; compute_seconds: number }[];
  by_object_type: { object_type_id: string; object_type: string; compute_seconds: number }[];
  by_day: { day: string; query?: number; indexing?: number }[];
  volume: { object_type_id: string; object_type: string; bytes: number; average_gb: number; gb_months: number }[];
  volume_bytes: number;
  gb_months: number;
};

const q = (params: Record<string, string | number | null | undefined>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
};

export const om = {
  ontologies: () => request<Ontology[]>("/ontologies"),
  createOntology: (body: Partial<Ontology>) => request<Ontology>("/ontologies", { method: "POST", json: body }),
  updateOntology: (id: string, body: Partial<Ontology>) => request<Ontology>(`/ontologies/${id}`, { method: "PATCH", json: body }),
  deleteOntology: (id: string) => request<unknown>(`/ontologies/${id}`, { method: "DELETE" }),
  setResourceRoles: (kind: ResourceKind, id: string, roles: Grant[]) => request<unknown>(`/resources/${kind}/${id}/roles`, { method: "PUT", json: { roles } }),

  linkTypes: (p: { object_type_id?: string; ontology_id?: string } = {}) => request<LinkType[]>(`/link-types${q(p)}`),
  linkType: (id: string) => request<LinkType>(`/link-types/${id}`),
  createLinkType: (body: Partial<LinkType>) => request<LinkType>("/link-types", { method: "POST", json: body }),
  updateLinkType: (id: string, body: Partial<LinkType>) => request<LinkType>(`/link-types/${id}`, { method: "PATCH", json: body }),
  deleteLinkType: (id: string) => request<unknown>(`/link-types/${id}`, { method: "DELETE" }),
  editLink: (id: string, op: "add" | "remove", source: string, target: string) =>
    request<{ link_count: number }>(`/link-types/${id}/links`, { method: "POST", json: { op, source, target } }),
  objectLinks: (typeId: string, pk: string) => request<ObjectLinks[]>(`/object-types/${typeId}/objects/${encodeURIComponent(pk)}/links`),

  interfaces: (ontologyId?: string) => request<Interface[]>(`/interfaces${q({ ontology_id: ontologyId })}`),
  interface: (id: string) => request<Interface>(`/interfaces/${id}`),
  createInterface: (body: Partial<Interface>) => request<Interface>("/interfaces", { method: "POST", json: body }),
  updateInterface: (id: string, body: Partial<Interface>) => request<Interface>(`/interfaces/${id}`, { method: "PATCH", json: body }),
  deleteInterface: (id: string) => request<unknown>(`/interfaces/${id}`, { method: "DELETE" }),
  interfaceObjects: (id: string, query = "") =>
    request<{ interface: Interface; total: number; objects: (OntologyObject & { interface_properties: Record<string, unknown> })[] }>(`/interfaces/${id}/objects${q({ q: query })}`),

  sharedProperties: (ontologyId?: string) => request<SharedProperty[]>(`/shared-properties${q({ ontology_id: ontologyId })}`),
  createSharedProperty: (body: Partial<SharedProperty>) => request<SharedProperty>("/shared-properties", { method: "POST", json: body }),
  updateSharedProperty: (id: string, body: Partial<SharedProperty>) => request<SharedProperty>(`/shared-properties/${id}`, { method: "PATCH", json: body }),
  deleteSharedProperty: (id: string) => request<unknown>(`/shared-properties/${id}`, { method: "DELETE" }),

  valueTypes: (ontologyId?: string) => request<ValueType[]>(`/value-types${q({ ontology_id: ontologyId })}`),
  createValueType: (body: Partial<ValueType> & { constraints?: ValueConstraints }) => request<ValueType>("/value-types", { method: "POST", json: body }),
  updateValueType: (id: string, body: Partial<ValueType> & { force?: boolean }) => request<ValueType>(`/value-types/${id}`, { method: "PATCH", json: body }),
  deleteValueType: (id: string) => request<unknown>(`/value-types/${id}`, { method: "DELETE" }),
  validateValue: (id: string, value: unknown) => request<{ valid: boolean; message: string | null }>(`/value-types/${id}/validate`, { method: "POST", json: { value } }),

  groups: () => request<Group[]>("/groups"),
  createGroup: (body: { name: string; description?: string; ontology_id?: string }) => request<Group>("/groups", { method: "POST", json: body }),
  deleteGroup: (id: string) => request<unknown>(`/groups/${id}`, { method: "DELETE" }),

  branches: (p: { ontology_id?: string; status?: string } = {}) => request<BranchRow[]>(`/branches${q(p)}`),
  branch: (id: string) => request<Branch>(`/branches/${id}`),
  createBranch: (body: { name: string; description?: string; ontology_id?: string }) => request<Branch>("/branches", { method: "POST", json: body }),
  branchResource: (id: string, kind: ResourceKind, rid: string) =>
    request<{ record: Record<string, unknown>; main: Record<string, unknown> | null; changed: boolean; conflict: boolean }>(`/branches/${id}/resources/${kind}/${rid}`),
  branchResources: (id: string, kind: ResourceKind) => request<Record<string, unknown>[]>(`/branches/${id}/resources/${kind}`),
  saveBranchResource: (id: string, kind: ResourceKind, rid: string, record: Record<string, unknown>) =>
    request<{ record: Record<string, unknown>; branch: Branch }>(`/branches/${id}/resources/${kind}/${rid}`, { method: "PUT", json: { record } }),
  deleteBranchResource: (id: string, kind: ResourceKind, rid: string, discard = false) =>
    request<Branch>(`/branches/${id}/resources/${kind}/${rid}${discard ? "?discard=true" : ""}`, { method: "DELETE" }),
  rebase: (id: string, resolutions: Record<string, "main" | "branch" | { custom: Record<string, unknown> }> = {}) =>
    request<{ status: "conflicts" | "rebased" | "errors"; conflicts?: Conflict[]; errors?: { key: string; error: string }[]; branch: Branch }>(`/branches/${id}/rebase`, {
      method: "POST",
      json: { resolutions },
    }),
  propose: (id: string, body: { title?: string; description?: string; reviewers?: string[] }) => request<Branch>(`/branches/${id}/proposal`, { method: "POST", json: body }),
  review: (id: string, decision: "approve" | "reject", keys: string[] = [], comment?: string) =>
    request<Branch>(`/branches/${id}/reviews`, { method: "POST", json: { decision, keys, comment } }),
  comment: (id: string, text: string, key?: string | null) => request<Branch>(`/branches/${id}/comments`, { method: "POST", json: { text, key } }),
  merge: (id: string) => request<Branch>(`/branches/${id}/merge`, { method: "POST" }),
  closeBranch: (id: string) => request<Branch>(`/branches/${id}/close`, { method: "POST" }),
  proposals: (tab: string, ontologyId?: string) => request<ProposalRow[]>(`/proposals${q({ tab, ontology_id: ontologyId })}`),

  migratePreview: (target: string, resources: string[]) => request<MigratePreview>("/migrate/preview", { method: "POST", json: { target_ontology_id: target, resources } }),
  migrate: (target: string, resources: string[]) => request<unknown>("/migrate", { method: "POST", json: { target_ontology_id: target, resources } }),

  search: (spec: SearchSpec) => {
    if (spec.object_type_id) capture({ object_type_id: spec.object_type_id, link_type_ids: (spec.search_around ?? []).map((x) => x.link_type_id), q: spec.q ?? "" });
    return request<SearchResult>("/explorer/search", { method: "POST", json: spec });
  },
  checkRegex: (pattern: string, samples: string[] = []) =>
    request<{ valid: boolean; error: string | null; python?: string; matches: string[] }>("/search/regex", { method: "POST", json: { pattern, samples } }),
  exportUrl: `${API_URL}/api/ontology/explorer/export`,
  bulkAction: (actionTypeId: string, primaryKeys: string[], parameters: Record<string, unknown>) =>
    request<{ applied: number }>("/explorer/bulk-action", { method: "POST", json: { action_type_id: actionTypeId, primary_keys: primaryKeys, parameters } }),
  explorations: () => request<Exploration[]>("/explorations"),
  saveExploration: (name: string, spec: SearchSpec) => request<Exploration>("/explorations", { method: "POST", json: { name, spec } }),
  deleteExploration: (id: string) => request<unknown>(`/explorations/${id}`, { method: "DELETE" }),

  objectView: (typeId: string, pk: string) => {
    capture({ object_type_id: typeId, primary_key: pk });
    return request<ObjectView>(`/object-view/${typeId}/${encodeURIComponent(pk)}`);
  },
  saveObjectView: (typeId: string, body: NonNullable<ObjectType["object_view"]>) => request<unknown>(`/object-types/${typeId}/object-view`, { method: "PUT", json: body }),

  usage: (days = 30, ontologyId?: string) => request<OntologyUsage>(`/usage${q({ days, ontology_id: ontologyId })}`),
};

/** Download the search results as CSV. */
export async function exportCsv(spec: SearchSpec): Promise<void> {
  const res = await fetch(om.exportUrl, { method: "POST", body: JSON.stringify(spec), headers: { "content-type": "application/json" }, credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ detail: res.statusText }))).detail);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "objects.csv";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** The ontology Ontology Manager works in (remembered per browser). */
export function storedOntology(): string {
  try {
    return localStorage.getItem("bsai.ontology") || "default";
  } catch {
    return "default";
  }
}
export function storeOntology(id: string) {
  try {
    localStorage.setItem("bsai.ontology", id);
  } catch {}
}

/** Save a change to a protected resource on a new branch (Foundry's "Create and save to branch"). */
export async function saveToNewBranch(name: string, ontologyId: string, kind: ResourceKind, id: string, record: Record<string, unknown>): Promise<Branch> {
  const b = await om.createBranch({ name, ontology_id: ontologyId });
  const r = await om.saveBranchResource(b.id, kind, id, record);
  return r.branch;
}
