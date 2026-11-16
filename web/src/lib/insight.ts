import { request } from "./ontology";
import type { SearchSpec } from "./ontologyModel";

export type InsightFilterStep = {
  id: string;
  property: string;
  op: NonNullable<SearchSpec["filters"]>[number]["op"];
  value?: unknown;
  enabled: boolean;
};

export type InsightLinkStep = {
  id: string;
  link_type_id: string;
  direction: "forward" | "reverse";
  filters: InsightFilterStep[];
  enabled: boolean;
};

export type InsightPath = {
  id: string;
  name: string;
  /** object_set: a reference to a saved object set (read-only start); list: a static list of objects */
  source_kind: "object_type" | "interface" | "object_set" | "list";
  source_id: string;
  /** the object type a referenced object set or list starts the path with */
  start_type_id?: string | null;
  /** the object set this path was published as */
  published_id?: string | null;
  query: string;
  filters: InsightFilterStep[];
  links: InsightLinkStep[];
  transform: {
    enabled: boolean;
    metric: "count" | "sum" | "avg" | "min" | "max";
    property: string | null;
    group_by: string | null;
    set_math?: { operation: "union" | "intersect" | "subtract"; other_path_id: string } | null;
  } | null;
};

export type InsightLayout = {
  id: string;
  name: string;
  tab: "table" | "charts" | "map";
  visible_columns: string[];
  chart_columns: string[];
};

export type InsightDocument = {
  version: 1;
  paths: InsightPath[];
  active_path_id: string | null;
  tab: "table" | "charts" | "map" | "sql";
  visible_columns: string[];
  chart_columns: string[];
  layouts: InsightLayout[];
};

export type InsightWorkbook = {
  id: string;
  name: string;
  description: string;
  spec: InsightDocument;
  owner: string;
  shared: boolean;
  share_role: "viewer" | "editor";
  can_edit: boolean;
  can_manage_sharing: boolean;
  created_at: string;
  updated_at: string;
};

export type ObjectList = { id: string; name: string; description: string; object_type_id: string; count: number; owner: string; shared: boolean; created_at: string; updated_at: string };
export type Scenario = { id: string; name: string; persisted?: boolean; status?: string; merged?: boolean };

const ROOT = "/insight/workbooks";

export const insightApi = {
  list: () => request<InsightWorkbook[]>(ROOT),
  get: (id: string) => request<InsightWorkbook>(`${ROOT}/${encodeURIComponent(id)}`),
  create: (name: string, description: string, spec: InsightDocument) =>
    request<InsightWorkbook>(ROOT, { method: "POST", json: { name, description, spec } }),
  save: (id: string, name: string, description: string, spec: InsightDocument) =>
    request<InsightWorkbook>(`${ROOT}/${encodeURIComponent(id)}`, { method: "PUT", json: { name, description, spec } }),
  setSharing: (id: string, enabled: boolean, role: "viewer" | "editor") =>
    request<InsightWorkbook>(`${ROOT}/${encodeURIComponent(id)}/sharing`, { method: "POST", json: { enabled, role } }),
  delete: (id: string) => request<unknown>(`${ROOT}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  objectLists: () => request<ObjectList[]>("/object-lists"),
  objectList: (id: string) => request<ObjectList & { primary_keys: string[] }>(`/object-lists/${encodeURIComponent(id)}`),
  createList: (name: string, objectTypeId: string, primaryKeys: string[]) =>
    request<ObjectList>("/object-lists", { method: "POST", json: { name, object_type_id: objectTypeId, primary_keys: primaryKeys } }),
  changeList: (id: string, add: string[], remove: string[] = []) => request<ObjectList>(`/object-lists/${encodeURIComponent(id)}`, { method: "PUT", json: { add, remove } }),
  publish: (name: string, spec: unknown, from: { workbook_id: string | null; path_id: string }, existing?: string | null) =>
    existing
      ? request<{ id: string }>(`/explorations/${encodeURIComponent(existing)}`, { method: "PUT", json: { spec, published_from: from } })
      : request<{ id: string }>("/explorations", { method: "POST", json: { name, spec, published_from: from } }),
  scenarios: () => request<Scenario[]>("/scenarios"),
};
