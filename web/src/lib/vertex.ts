/** Vertex (api/vertex.py): system graphs of Ontology objects, Search Arounds, layers, events and graph templates. */
import { API_URL } from "./api";

export type NodeRef = { object_type_id: string; primary_key: string; x?: number; y?: number };
export type VNode = { id: string; object_type_id: string; object_type: string; primary_key: string; title: string; properties: Record<string, unknown> };
/** arrow: where the edge's arrows point (from the link type's Vertex type classes; default the target) */
export type VEdge = { id: string; source: string; target: string; link_type_id: string; label: string; derived?: boolean; arrow?: "source" | "target" | "none" | "both" };
/** per-graph edge styling of a link type; arrows: as the Ontology says (default), reversed, none or both */
export type EdgeStyle = { color?: string; dashed?: boolean; hidden?: boolean; arrows?: "default" | "reverse" | "none" | "both" };
/** an edge a function-backed Search Around added (node ids "type|pk") */
export type FunctionEdge = { source: string; target: string; label: string; function_id: string };
/** a published function that runs from objects of a type: returning objects (Search Around) or a value (derived property) */
export type GraphFunction = { id: string; name: string; doc: string; version: string | null; output: string; param: string; mode: "one" | "many" | "set"; returns: "objects" | "value" };
export type DerivedSpec = { name: string; function_id: string; version?: string | null };
export type VEvent = { id: string; object_type_id: string; object_type: string; primary_key: string; title: string; intent: "primary" | "success" | "warning" | "danger"; at: string | null; node: string };
export type LayerRule = { property: string; op: "eq" | "neq" | "gt" | "lt"; value: string; color: string };
export type Layer = {
  color?: string;
  label_property?: string;
  size_property?: string;
  rules?: LayerRule[];
  hidden?: boolean;
  /** an icon name (components/Icon) drawn in the node; node_style "circle" draws plain circles */
  icon?: string;
  node_style?: "icon" | "circle";
  /** the column of this object type in the System flow layout (0 = leftmost) */
  column?: number;
  /** derived properties: a function's value per object, shown under the name (usable as the label) */
  derived?: DerivedSpec[];
  /** pin this type's objects onto the media layer: properties holding pixel coordinates on the image */
  media_x?: string;
  media_y?: string;
  /** a time series readout on the nodes: a statistic of a time series property, colored by thresholds */
  readout?: { property: string; stat?: "last" | "mean" | "min" | "max" | "first"; thresholds?: { op: "gt" | "lt"; value: number; color: string }[] };
};
export type Readout = { value?: number | null; stat?: string; unit?: string | null; at?: string | null; points?: number; error?: string };
/** transactional objects drawn as edges between the two node types they link (Vertex "group nodes into edge") */
export type EdgeGroup = { id: string; name: string; object_type_id: string; links: [string, string]; label: string; width?: string; format?: "number" | "juta" | "rupiah" };
export type SeriesConfig = { label: string; link_type_id: string; direction: "forward" | "reverse"; date_property: string; metric: string; bucket: "day" | "week" | "month" };
export type GroupedEdge = {
  id: string;
  source: string;
  target: string;
  group_id: string;
  object_type_id: string;
  name: string;
  count: number;
  value: number;
  width_value: number;
  objects: { primary_key: string; title: string }[];
};
export type NodeSeries = { label: string; metric: string; bucket: string; points: { at: string; value: number; count: number }[] };
export type Step = { link_type_id: string; direction: "forward" | "reverse"; filters?: { property: string; op: string; value?: unknown }[] };
export type TemplateParam = { id: string; name: string; object_type_id: string; search_arounds: (Step | { steps: Step[] })[] };
export type Layout = "auto" | "flow" | "hierarchy_lr" | "hierarchy_tb" | "grid" | "circular" | "radial" | "row" | "column";
export type Graph = {
  id?: string;
  name: string;
  description: string;
  nodes: NodeRef[];
  layout: Layout;
  layers: Record<string, Layer>;
  edge_styles: Record<string, EdgeStyle>;
  edge_groups?: EdgeGroup[];
  series?: Record<string, SeriesConfig[]>;
  line_type?: "straight" | "curved" | "orthogonal";
  selections?: SavedSelection[];
  function_edges?: FunctionEdge[];
  /** a media layer: an image from Files under the graph (world coordinates; height follows the image) */
  media?: { item_id: string; name: string; x: number; y: number; width: number; opacity: number } | null;
  annotations?: Annotation[];
  time: { start?: string; end?: string } | null;
  scenario_id: string | null;
  read_only: boolean;
  template: { parameters: TemplateParam[] } | null;
  owner?: string;
};
export type Annotation = { id: string; x: number; y: number; w: number; h: number; text: string; color: string };
export type SavedSelection = { id: string; name: string; nodes: string[] };
export type VStyle = { id: string; name: string; layers: Record<string, Layer>; edge_styles: Graph["edge_styles"]; line_type?: Graph["line_type"] | null; owner?: string };
export type GraphRow = { id: string; name: string; description: string; owner: string; updated_at: string; read_only: boolean; nodes: number; template: boolean; template_types?: string[] };
/** via: a link-merged intermediary type (vertex:link_merge): the far objects are added, the intermediaries drawn as edges */
export type AroundOption = {
  link_type_id: string;
  direction: "forward" | "reverse";
  from_type_id: string;
  to_type_id: string;
  label: string;
  object_type: string;
  count: number;
  via?: { object_type_id: string; object_type: string; link_type_id: string; direction: "forward" | "reverse" };
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api/vertex${path}`, {
    ...init,
    credentials: "include",
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}

export const vertex = {
  graphs: () => req<GraphRow[]>("/graphs"),
  compare: (nodes: NodeRef[], scenario_id: string) =>
    req<{ objects: { id: string; title: string; object_type: string; status: "modified" | "created" | "deleted"; changes: { property: string; baseline: unknown; scenario: unknown }[] }[]; unchanged: number }>(
      "/compare", { method: "POST", json: { nodes, scenario_id } }),
  readouts: (nodes: NodeRef[], readouts: Record<string, NonNullable<Layer["readout"]>>) => req<Record<string, Readout>>("/readouts", { method: "POST", json: { nodes, readouts } }),
  styles: () => req<VStyle[]>("/styles"),
  saveStyle: (body: Omit<VStyle, "id" | "owner">) => req<VStyle>("/styles", { method: "POST", json: body }),
  deleteStyle: (id: string) => req<unknown>(`/styles/${id}`, { method: "DELETE" }),
  graph: (id: string) => req<Graph>(`/graphs/${id}`),
  create: (g: Graph) => req<Graph>("/graphs", { method: "POST", json: g }),
  save: (id: string, g: Graph) => req<Graph>(`/graphs/${id}`, { method: "PUT", json: g }),
  remove: (id: string) => req<unknown>(`/graphs/${id}`, { method: "DELETE" }),
  run: (id: string, parameters: Record<string, string[]>, save = false, name?: string) => req<Graph>(`/graphs/${id}/run`, { method: "POST", json: { parameters, save, name } }),
  functions: (objectTypeId: string) => req<GraphFunction[]>(`/functions?object_type_id=${encodeURIComponent(objectTypeId)}`),
  functionAround: (nodes: NodeRef[], function_id: string, scenario_id?: string | null) =>
    req<{ function: string; nodes: NodeRef[]; edges: FunctionEdge[]; errors: string[] }>("/search-around/function", { method: "POST", json: { nodes, function_id, scenario_id } }),
  derived: (nodes: NodeRef[], derived: Record<string, DerivedSpec[]>, scenario_id?: string | null) =>
    req<{ values: Record<string, Record<string, unknown>>; errors: string[] }>("/derived", { method: "POST", json: { nodes, derived, scenario_id } }),
  resolve: (nodes: NodeRef[], scenario_id?: string | null, time?: { start?: string; end?: string } | null, edge_groups?: EdgeGroup[], function_edges?: FunctionEdge[]) =>
    req<{ nodes: VNode[]; edges: VEdge[]; grouped_edges: GroupedEdge[]; events: VEvent[]; scenario_changed: string[] }>("/resolve", {
      method: "POST",
      json: { nodes, scenario_id, start: time?.start, end: time?.end, edge_groups: edge_groups ?? [], function_edges: function_edges ?? [] },
    }),
  series: (nodes: NodeRef[], series: Record<string, SeriesConfig[]>, scenario_id?: string | null) =>
    req<{ series: Record<string, NodeSeries[]> }>("/series", { method: "POST", json: { nodes, series, scenario_id } }),
  options: (nodes: NodeRef[], scenario_id?: string | null) => req<AroundOption[]>("/search-around/options", { method: "POST", json: { nodes, scenario_id } }),
  /** page: a page of the last step's objects (in primary key order); `reached` then counts them all */
  searchAround: (nodes: NodeRef[], steps: Step[], scenario_id?: string | null, page?: { limit: number; offset?: number }) =>
    req<{ layers: { object_type_id: string; primary_keys: string[] }[]; nodes: NodeRef[]; reached?: number }>("/search-around", { method: "POST", json: { nodes, steps, scenario_id, ...page } }),
};

export const emptyGraph = (): Graph => ({ name: "Untitled graph", description: "", nodes: [], layout: "auto", layers: {}, edge_styles: {}, time: null, scenario_id: null, read_only: false, template: null });
