/** Slate (api/slate.py): low-code applications as versioned documents of pages, widgets, queries, functions,
 *  variables, events and styles. The document runs in the browser (slateRuntime.ts). */
import type { IconName } from "@/components/Icon";
import { API_URL } from "./api";

export type SlateAppType = "integrated" | "public";

export type SlateWidgetType =
  | "text"
  | "html"
  | "button"
  | "dropdown"
  | "multiselect"
  | "input"
  | "textarea"
  | "checkbox"
  | "radio"
  | "toggle"
  | "slider"
  | "datepicker"
  | "table"
  | "chart"
  | "pie"
  | "container"
  | "dialog"
  | "tabs"
  | "image"
  | "card"
  | "list"
  | "iframe"
  | "action"
  | "objectcard"
  | "codesandbox"
  | "fileimport"
  | "timeline"
  | "toast"
  // SlateWidgetsMore.tsx
  | "segmented"
  | "daterange"
  | "calendar"
  | "gallery"
  | "tree"
  | "graph"
  | "map"
  | "gantt"
  | "heatgrid"
  | "treemap"
  | "resourceselector"
  | "timeseries";

/** A widget: its properties are raw JSON whose strings may hold Handlebars ({{q_rows.name}}). */
export type SlateWidget = {
  id: string;
  type: SlateWidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  props: Record<string, unknown>;
  css?: string;
  classes?: string;
  hidden?: string;
  children?: SlateWidget[];
};
export type SlatePage = { id: string; name: string; widgets: SlateWidget[] };
export type SlateQuery = {
  name: string;
  /** "foundry" (SQL over datasets), "api-gateway" (this platform's REST API), a REST API source id (HTTP JSON) */
  source: string;
  /** SQL, or for HTTP JSON / API Gateway a JSON request template */
  template: string;
  run: "auto" | "manual";
  extractors?: Record<string, string>;
};
export type SlateFunction = { name: string; code: string; run: "auto" | "manual" };
export type SlateObjectSet = {
  name: string;
  object_type_id: string;
  filters: { property: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "is_null" | "not_null"; value: string }[];
  filter_mode: "all" | "any";
  sort?: { property: string; descending: boolean };
  limit: number;
  aggregations: { name: string; metric: "count" | "avg" | "sum" | "max" | "min" | "distinct"; property?: string }[];
};
export type SlateObjectContext = { name: string; object_type_id: string; pk: string };
export type SlateFoundryFunction = { name: string; function_id: string; version?: string; inputs: Record<string, string>; run: "auto" | "manual" };
/** marketplace: a local variable whose value is asked at installation (Marketplace parameter) */
export type SlateVariable = { name: string; scope: "shared" | string; default: string; marketplace?: { type: "string" | "boolean"; description?: string } };
export type SlateLint = { dependencies: Record<string, string[]>; parameters: { name: string; type: "string" | "boolean"; default?: unknown }[]; errors: { kind: string; id: string; message: string }[]; warnings: { kind: string; id: string; message: string }[]; packageable: boolean };
export type SlateEvent = { id: string; trigger: string; action: string; code: string };
export type SlateDocument = {
  schema: 1;
  title?: string;
  pages: SlatePage[];
  toolbar: SlateWidget[];
  queries: SlateQuery[];
  functions: SlateFunction[];
  library: string;
  objectSets: SlateObjectSet[];
  objectContexts: SlateObjectContext[];
  foundryFunctions: SlateFoundryFunction[];
  variables: SlateVariable[];
  events: SlateEvent[];
  styles: { css: string; theme?: "dark" | "light" };
};

export type SlateAppSummary = {
  id: string;
  name: string;
  description: string;
  permalink: string;
  type: SlateAppType;
  item_id: string;
  latest: number;
  published: number | null;
  auto_publish: boolean;
  tags: Record<string, number>;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  sources: string[];
  path?: { id: string; name: string }[] | string[];
};
export type SlateOpened = { app: SlateAppSummary; version: number; document: SlateDocument; can_edit: boolean; saved_at?: string; saved_by_name?: string };
export type SlateVersion = { version: number; saved_at: string; saved_by: string; saved_by_name: string; message: string; published: boolean; tags: string[] };
export type SlateSource = { id: string; name: string; kind: "foundry_sql" | "api_gateway" | "http_json"; domains?: string[] };
export type SlateConflict = { code: "conflict"; message: string; latest_version: number; latest: SlateDocument; base: SlateDocument };

export class SlateError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail: unknown,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/slate" + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      detail = (await res.json()).detail;
    } catch {}
    const message = typeof detail === "string" ? detail : ((detail as { message?: string })?.message ?? JSON.stringify(detail));
    throw new SlateError(message, res.status, detail);
  }
  return res.json();
}

export const slate = {
  list: () => req<SlateAppSummary[]>("/apps"),
  /** Marketplace packaging: what the application needs, the product package, installing one */
  lint: (id: string) => req<SlateLint>(`/apps/${id}/lint`),
  package: (id: string) => req<{ kind: string; name: string; description?: string; dependencies: Record<string, string[]>; names: Record<string, string>; parameters: SlateLint["parameters"] }>(`/apps/${id}/package`),
  install: (body: unknown) => req<SlateOpened>("/install", { method: "POST", json: body }),
  create: (body: { name: string; folder_id: string; type: SlateAppType; permalink?: string; description?: string; document?: SlateDocument }) =>
    req<SlateOpened>("/apps", { method: "POST", json: body }),
  open: (id: string, opts: { version?: number; tag?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.version) q.set("version", String(opts.version));
    if (opts.tag) q.set("tag", opts.tag);
    return req<SlateOpened>(`/apps/${id}${q.size ? `?${q}` : ""}`);
  },
  byPermalink: (permalink: string, tag?: string) => req<SlateOpened>(`/by-permalink/${permalink}${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`),
  save: (id: string, document: SlateDocument, base_version: number, overwrite = false, message = "") =>
    req<{ app: SlateAppSummary; version: number }>(`/apps/${id}`, { method: "PUT", json: { document, base_version, overwrite, message } }),
  versions: (id: string) => req<SlateVersion[]>(`/apps/${id}/versions`),
  publish: (id: string, version: number) => req<SlateAppSummary>(`/apps/${id}/publish`, { method: "POST", json: { version } }),
  unpublish: (id: string) => req<SlateAppSummary>(`/apps/${id}/unpublish`, { method: "POST" }),
  tag: (id: string, tag: string, version: number) => req<SlateAppSummary>(`/apps/${id}/tags/${encodeURIComponent(tag)}`, { method: "PUT", json: { version } }),
  untag: (id: string, tag: string) => req<SlateAppSummary>(`/apps/${id}/tags/${encodeURIComponent(tag)}`, { method: "DELETE" }),
  revert: (id: string, version: number) => req<{ app: SlateAppSummary; version: number }>(`/apps/${id}/revert`, { method: "POST", json: { version } }),
  settings: (id: string, body: Partial<{ name: string; description: string; permalink: string; auto_publish: boolean; sources: string[] }>) =>
    req<SlateAppSummary>(`/apps/${id}/settings`, { method: "PUT", json: body }),
  remove: (id: string) => req<{ trashed: string }>(`/apps/${id}`, { method: "DELETE" }),
  exportJson: (id: string) => req<Record<string, unknown>>(`/apps/${id}/export`),
  importJson: (file: Record<string, unknown>, folder_id?: string) => req<SlateOpened & { created: boolean }>("/import", { method: "POST", json: { file, folder_id } }),
  saveAs: (id: string, body: { name: string; folder_id?: string; target_app_id?: string }) => req<SlateOpened>(`/apps/${id}/save-as`, { method: "POST", json: body }),
  sources: () => req<SlateSource[]>("/sources"),
  runQuery: (id: string, body: { kind: "foundry_sql" | "http_json"; sql?: string; source?: string; request?: unknown }) =>
    req<{ data?: Record<string, unknown[]>; body?: unknown; status?: number; row_count?: number }>(`/apps/${id}/queries/run`, { method: "POST", json: body }),
  saveView: (id: string, state: SlateViewState) => req<{ id: string }>(`/apps/${id}/views`, { method: "POST", json: { state } }),
  getView: (id: string, viewId: string) => req<{ id: string; state: SlateViewState; created_at: string }>(`/apps/${id}/views/${encodeURIComponent(viewId)}`),
  getStorage: (id: string) => req<{ value: unknown }>(`/apps/${id}/user-storage`),
  putStorage: (id: string, value: unknown) => req<{ value: unknown }>(`/apps/${id}/user-storage`, { method: "PUT", json: { value } }),
  publicApp: (permalink: string) => req<{ app: { id: string; name: string; permalink: string; type: string }; version: number; document: SlateDocument }>(`/public/apps/${permalink}`),
  putChannel: (id: string, body: { channel_id: string; folder_id: string; max_blob_size?: number }) => req<Record<string, unknown>>(`/apps/${id}/upload-channels`, { method: "PUT", json: body }),
  createToken: (id: string, body: { channel: string; expiry: string; count: number }) => req<{ token: string; expiry: string; count: number }>(`/apps/${id}/upload-tokens`, { method: "POST", json: body }),
  publicUpload: (token: string, data: unknown) => req<{ stored: string; remaining: number }>(`/public/upload/${token}`, { method: "POST", json: { data } }),
};

export const emptyDocument = (title: string): SlateDocument => ({
  schema: 1,
  title,
  pages: [{ id: "page1", name: "home", widgets: [] }],
  toolbar: [],
  queries: [],
  functions: [],
  library: "",
  objectSets: [],
  objectContexts: [],
  foundryFunctions: [],
  variables: [],
  events: [],
  styles: { css: "", theme: "dark" },
});

type WidgetSpec = { type: SlateWidgetType; label: string; icon: IconName; group: "Text" | "Control" | "Chart" | "Container" | "Platform" | "Visualization" | "Time" | "Advanced"; w: number; h: number; props: Record<string, unknown>; events: string[]; actions: string[]; state: string[] };

/** The widget catalog: default properties, the events each widget fires and the actions it takes. */
export const SLATE_WIDGETS: WidgetSpec[] = [
  { type: "text", label: "Text", icon: "doc", group: "Text", w: 4, h: 2, props: { content: "Text with {{handlebars}}", markdown: true }, events: ["click"], actions: [], state: [] },
  { type: "html", label: "HTML", icon: "code", group: "Text", w: 4, h: 3, props: { html: "<b>{{v_name}}</b>" }, events: [], actions: [], state: [] },
  { type: "button", label: "Button", icon: "bolt", group: "Control", w: 2, h: 1, props: { text: "Button", intent: "primary", disabled: false }, events: ["click"], actions: [], state: [] },
  { type: "dropdown", label: "Dropdown", icon: "down", group: "Control", w: 3, h: 1, props: { values: ["A", "B"], displayValues: null, selectedValue: null, placeholder: "Choose…" }, events: ["changed"], actions: ["clear"], state: ["selectedValue", "selectedDisplayValue"] },
  { type: "multiselect", label: "Multiselect", icon: "list", group: "Control", w: 3, h: 2, props: { values: ["A", "B", "C"], displayValues: null, selectedValues: [] }, events: ["changed"], actions: ["clear"], state: ["selectedValues"] },
  { type: "input", label: "Input box", icon: "edit", group: "Control", w: 3, h: 1, props: { text: "", placeholder: "Type…", inputType: "text" }, events: ["changed", "submitted"], actions: ["clear"], state: ["text"] },
  { type: "textarea", label: "Textarea", icon: "doc", group: "Control", w: 4, h: 2, props: { text: "", placeholder: "" }, events: ["changed"], actions: ["clear"], state: ["text"] },
  { type: "checkbox", label: "Checkbox", icon: "check", group: "Control", w: 3, h: 2, props: { values: ["A", "B"], displayValues: null, selectedValues: [] }, events: ["changed"], actions: ["clear"], state: ["selectedValues"] },
  { type: "radio", label: "Radio buttons", icon: "dots", group: "Control", w: 3, h: 2, props: { values: ["A", "B"], displayValues: null, selectedValue: null }, events: ["changed"], actions: ["clear"], state: ["selectedValue"] },
  { type: "toggle", label: "Toggle", icon: "sliders", group: "Control", w: 2, h: 1, props: { label: "Toggle", value: false }, events: ["changed"], actions: [], state: ["value"] },
  { type: "slider", label: "Slider", icon: "sliders", group: "Control", w: 3, h: 1, props: { min: 0, max: 100, step: 1, value: 50 }, events: ["changed"], actions: [], state: ["value"] },
  { type: "datepicker", label: "Date picker", icon: "clock", group: "Time", w: 3, h: 1, props: { selectedDate: "" }, events: ["changed"], actions: ["clear"], state: ["selectedDate"] },
  { type: "timeline", label: "Timeline", icon: "clock", group: "Time", w: 6, h: 3, props: { labels: "{{q_events.label}}", dates: "{{q_events.date}}" }, events: ["selected"], actions: [], state: ["selectedIndex"] },
  { type: "table", label: "Table", icon: "table", group: "Visualization", w: 6, h: 4, props: { data: { name: ["Ceres", "Pallas"], diameter: [939, 512] }, columns: [], selectionMode: "single", pageSize: 50 }, events: ["selectionChanged"], actions: ["clearSelection"], state: ["selectedRowKeys", "selectedRows", "selectedIndex"] },
  { type: "chart", label: "Chart", icon: "wave", group: "Chart", w: 6, h: 4, props: { renderer: "bar", xValues: ["A", "B", "C"], yValues: [3, 5, 2], seriesName: "Series" }, events: ["selected"], actions: [], state: ["selectedX"] },
  { type: "pie", label: "Pie chart", icon: "globe", group: "Chart", w: 4, h: 4, props: { labels: ["A", "B"], values: [2, 3] }, events: ["selected"], actions: [], state: ["selectedLabel"] },
  { type: "container", label: "Container", icon: "grid", group: "Container", w: 6, h: 4, props: { flow: "column", gap: 8 }, events: [], actions: [], state: [] },
  { type: "tabs", label: "Tabbed container", icon: "layers", group: "Container", w: 6, h: 4, props: { tabs: ["Tab 1", "Tab 2"], selectedTab: 0 }, events: ["changed"], actions: ["select"], state: ["selectedTab"] },
  { type: "dialog", label: "Dialog", icon: "comment", group: "Container", w: 6, h: 4, props: { title: "Dialog", open: false }, events: ["opened", "closed"], actions: ["open", "close"], state: ["open"] },
  { type: "card", label: "Card", icon: "cube", group: "Container", w: 3, h: 2, props: { title: "{{v_title}}", value: "42", subtitle: "" }, events: ["click"], actions: [], state: [] },
  { type: "list", label: "List", icon: "list", group: "Container", w: 3, h: 4, props: { items: ["One", "Two"], selectedIndex: null }, events: ["selected"], actions: [], state: ["selectedIndex", "selectedItem"] },
  { type: "image", label: "Image", icon: "image", group: "Text", w: 3, h: 3, props: { src: "", alt: "", fit: "contain" }, events: ["click"], actions: [], state: [] },
  { type: "iframe", label: "Iframe", icon: "external", group: "Advanced", w: 6, h: 4, props: { src: "" }, events: [], actions: [], state: [] },
  { type: "codesandbox", label: "Code sandbox", icon: "code", group: "Advanced", w: 6, h: 4, props: { html: "<div id='root'></div>", css: "", js: "// slate.state, slate.setState({...}), slate.trigger(value)\ndocument.getElementById('root').textContent = JSON.stringify(slate.state);", state: {} }, events: ["triggered"], actions: [], state: ["state"] },
  { type: "fileimport", label: "File import", icon: "upload", group: "Advanced", w: 4, h: 2, props: { accept: ".csv,.json", parse: "csv" }, events: ["imported"], actions: ["clear"], state: ["data", "fileName"] },
  { type: "action", label: "Action", icon: "bolt", group: "Platform", w: 5, h: 5, props: { actionTypeId: "", showForm: true, parameters: {} }, events: ["succeeded", "failed"], actions: ["submit"], state: ["lastResult"] },
  { type: "objectcard", label: "Object card", icon: "cube", group: "Platform", w: 4, h: 3, props: { objectTypeId: "", primaryKey: "" }, events: ["click"], actions: [], state: [] },
  { type: "toast", label: "Toast", icon: "bell", group: "Container", w: 3, h: 1, props: { message: "Saved", intent: "success", open: false, timeout: 3000 }, events: ["closed"], actions: ["show", "hide"], state: ["open"] },
  { type: "segmented", label: "Segmented control", icon: "sliders", group: "Control", w: 4, h: 1, props: { values: ["day", "week", "month"], displayValues: ["Day", "Week", "Month"], selectedValues: [], multiselectEnabled: false, preselectFirstElement: false, selectionRequired: false, disabled: false, tooltipsEnabled: false, tooltipText: "" }, events: ["changed"], actions: ["clear"], state: ["selectedValues", "hover"] },
  { type: "daterange", label: "Date range picker", icon: "clock", group: "Time", w: 5, h: 2, props: { disabled: false, displayFormat: "YYYY-MM-DD", fromDateValue: null, toDateValue: null, shortcutsEnabled: false, timeEnabled: false, timePickerPrecision: 0 }, events: ["changed"], actions: ["clear"], state: ["fromDateValue", "toDateValue"] },
  { type: "calendar", label: "Calendar", icon: "clock", group: "Time", w: 8, h: 7, props: { eventNames: ["Review", "Audit"], eventStarts: ["2026-10-12T09:00", "2026-10-14"], eventEnds: ["2026-10-12T10:30", "2026-10-15"], eventSeries: [], areEventsAllDay: [false, true], defaultDate: "", viewDefault: "month", viewType: "Time", viewSwitchingEnabled: true, pagingEnabled: true, pagingYearEnabled: false, dateRangeEnabled: true, rangeSelectionEnabled: true, hourStart: 0, hourEnd: 24, slotMinutes: 30, firstDayOfWeek: 0, timeZone: "local", selectedIndex: null, selectedRange: null }, events: ["selected", "rangeSelected"], actions: [], state: ["selectedIndex", "selectedRange"] },
  { type: "gallery", label: "Image gallery", icon: "image", group: "Visualization", w: 6, h: 4, props: { imageUrls: [], captions: [] }, events: ["selected"], actions: [], state: ["selectedIndex"] },
  { type: "tree", label: "Tree", icon: "folder", group: "Visualization", w: 3, h: 5, props: { contents: [{ id: 1, label: "bars", iconName: "folder-close", childNodes: [{ id: 3, label: "bar 1" }, { id: 4, label: "bar 2" }] }, { id: 2, label: "foo" }], searchText: "", searchEnabled: true, selected: [], selectionType: "single" }, events: ["selectionChanged", "searchText.changed"], actions: ["clearSelection"], state: ["selected", "selectedNodes", "searchText"] },
  { type: "graph", label: "Graph", icon: "graph", group: "Visualization", w: 6, h: 6, props: { nodes: { ids: ["a", "b", "c"], labels: ["A", "B", "C"] }, edges: { sourceNodeIds: ["a", "a"], targetNodeIds: ["b", "c"] }, layout: "Force Directed", directedEdgesEnabled: true, nodeDiameter: 22, edgeLength: 90, nodeLabelPosition: "bottom", selectedNodeIds: [], camera: { x: null, y: null, ratio: null }, zoomScaleRange: [0.1, 10], hideLabelsScale: 0 }, events: ["selectionChanged", "nodes.changed", "camera.changed"], actions: ["clearSelection", "fit"], state: ["selectedNodeIds", "camera", "nodes.xPositions", "nodes.yPositions"] },
  { type: "map", label: "Map", icon: "globe", group: "Visualization", w: 8, h: 7, props: { tileLayer: "satellite", interactive: true, layers: [{ type: "location", latitudes: [-6.9147, -6.8915], longitudes: [107.6098, 107.6107], labels: ["A", "B"], ids: ["a", "b"], color: "#3b82f6", radius: 6 }], selection: { layer: null, ids: [] } }, events: ["selectionChanged"], actions: ["clearSelection"], state: ["selection"] },
  { type: "gantt", label: "Gantt chart", icon: "sliders", group: "Chart", w: 8, h: 4, props: { yValues: ["Event 1", "Event 2", "Event 3"], startValues: ["2015-04-01T09:00", "2015-04-02T09:00", "2015-04-04T09:00"], endValues: ["2015-04-03T09:00", "2015-04-05T09:00", "2015-04-07T09:00"], labels: ["Label 1", "Label 2", "Label 3"], seriesValues: ["a", "b", "a"], labelsEnabled: false, legendEnabled: false, dataSelectionEnabled: true, selectedIndex: null }, events: ["selected"], actions: [], state: ["selectedIndex"] },
  { type: "heatgrid", label: "Heat grid", icon: "grid", group: "Chart", w: 6, h: 4, props: { xValues: ["Mon", "Tue", "Mon", "Tue"], yValues: ["AM", "AM", "PM", "PM"], cellValues: [1, 4, 6, 9], colorScale: ["#B9D7EA", "#1F6B9A"], labelsEnabled: true, labelFormat: "", selectionEnabled: true, selectionMode: "single", xAxis: { visible: true, position: "bottom" }, yAxis: { visible: true, position: "left" }, selection: { indices: [], cellValues: [], xValues: [], yValues: [] } }, events: ["selectionChanged"], actions: ["clearSelection"], state: ["selection"] },
  { type: "treemap", label: "Tree map", icon: "grid", group: "Chart", w: 6, h: 5, props: { labels: ["A", "B", "C", "D"], sizes: [10, 20, 5, 45], categories: ["I", "I", "II", "II"], densities: [9, 6, 5, 3], flipGradient: false, selectedIndex: null }, events: ["selected"], actions: [], state: ["selectedIndex", "selectedLabel"] },
  { type: "resourceselector", label: "Resource selector", icon: "folder", group: "Platform", w: 3, h: 1, props: { title: "Select a resource", allowedTypes: [], open: false, selectedRid: null }, events: ["didClose", "selectedRid.changed"], actions: ["open", "close"], state: ["selectedRid", "selectedName", "open"] },
  { type: "timeseries", label: "Time series", icon: "wave", group: "Platform", w: 8, h: 5, props: { syncId: "", seriesIds: [], seriesNames: [], title: "", unit: "", colors: [], timeRange: { start: "", end: "" }, streaming: false, streamingIntervalSeconds: 5 }, events: [], actions: [], state: [] },
];

export const widgetSpec = (type: SlateWidgetType) => SLATE_WIDGETS.find((w) => w.type === type) ?? SLATE_WIDGETS[0];

/** Application-level actions events can run (slate.*). */
export const GLOBAL_ACTIONS = ["slate.navigateTo", "slate.redirectToUrl", "slate.copyToClipboard", "slate.downloadBlob", "slate.setUserStorage", "slate.print", "slate.sendMessage",
  "slate.scrollToId", "slate.setWindowTitle", "slate.exportWidget", "slate.createBroadcastChannel", "slate.closeBroadcastChannel", "slate.broadcastMessage", "slate.showCheckpoint",
  "slate.openAppsPortal", "slate.logout", "slate.saveView", "slate.loadView"] as const;
export const GLOBAL_EVENTS = ["slate.ready", "slate.resize", "slate.userStorageChanged", "slate.getMessage", "slate.onNavigate", "slate.onPrint", "slate.getBroadcast", "slate.onCloseCheckpoint",
  "slate.onChildWindowClosed", "slate.viewSaved", "slate.onExportWidget"] as const;
/** A shareable view: the widgets' interaction properties and the local variables of the home page. */
export type SlateViewState = { widgets: Record<string, Record<string, unknown>>; variables: Record<string, unknown> };

const ids = new Set<string>();
export function freshName(prefix: string, taken: Iterable<string>) {
  const used = new Set(taken);
  ids.clear();
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/** Every name used in a document (widgets, queries, functions, object sets…), for unique names and Ctrl+K. */
export function allNames(doc: SlateDocument): { name: string; kind: string; page?: string }[] {
  const out: { name: string; kind: string; page?: string }[] = [];
  const walk = (ws: SlateWidget[], page?: string) =>
    ws.forEach((w) => {
      out.push({ name: w.id, kind: `widget · ${w.type}`, page });
      walk(w.children ?? [], page);
    });
  doc.pages.forEach((p) => walk(p.widgets, p.name));
  walk(doc.toolbar);
  doc.queries.forEach((q) => out.push({ name: q.name, kind: "query" }));
  doc.functions.forEach((f) => out.push({ name: f.name, kind: "function" }));
  doc.objectSets.forEach((o) => out.push({ name: o.name, kind: "object set" }));
  doc.objectContexts.forEach((o) => out.push({ name: o.name, kind: "object context" }));
  doc.foundryFunctions.forEach((o) => out.push({ name: o.name, kind: "Foundry function" }));
  doc.variables.forEach((v) => out.push({ name: v.name, kind: `variable · ${v.scope === "shared" ? "shared" : "local"}` }));
  return out;
}
