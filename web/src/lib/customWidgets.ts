/** Custom widgets (api/custom_widgets.py): widget sets of custom frontend code, their releases and the host bridge. */
import { API_URL } from "./api";

export type ParamType = "boolean" | "date" | "number" | "string" | "timestamp" | "objectSet" | "scenario" | "array";
export type ParamDef = { displayName?: string; type: ParamType; subType?: string; allowedType?: string };
export type EventDef = { displayName?: string; parameterUpdateIds?: string[] };
export type WidgetDef = {
  id: string;
  name: string;
  description: string;
  type: string;
  entrypointJs: string[];
  entrypointCss: string[];
  html: string | null;
  parameters: Record<string, ParamDef>;
  events: Record<string, EventDef>;
  permissions: string[];
  refreshHostDataOnAction: boolean;
};
export type Release = { version: string; manifest: { version: string; widgets: Record<string, WidgetDef> }; files: string[]; size: number; source: "upload" | "editor"; released_at: string; released_by: string };
export type SourceWidget = { name: string; description: string; html: string; css: string; js: string; parameters: Record<string, ParamDef>; events: Record<string, EventDef>; permissions: string[] };
export type Osdk = { object_types: string[]; action_types: string[]; functions: string[]; ontology_apis: boolean };
export type WidgetSetSummary = { id: string; rid: string; name: string; description: string; item_id: string; created_at: string; created_by: string; osdk: Osdk; latest: string | null; versions: string[]; widgets: string[]; path?: unknown };
export type WidgetSetDetail = WidgetSetSummary & { can_edit: boolean; releases: Release[]; drafts: Record<string, SourceWidget>; dev: { url: string; paused: boolean; expires: string } | null };
export type Loaded = {
  widget_set: { id: string; rid: string; name: string };
  version: string;
  widget: WidgetDef;
  document: string;
  dev: ({ url: string; paused: boolean; expires: string; active: boolean; document?: string }) | null;
  osdk: Osdk;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/widget-sets" + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const widgetSets = {
  list: () => req<WidgetSetSummary[]>(""),
  /** Marketplace packaging: a released version with its files and SDK resources; installing one */
  package: (id: string, version?: string) => req<{ kind: string; name: string; description?: string; dependencies: Record<string, string[]>; names: Record<string, string> }>(`/${id}/package${version ? `?version=${encodeURIComponent(version)}` : ""}`),
  install: (body: unknown) => req<WidgetSetDetail>("/install", { method: "POST", json: body }),
  get: (id: string) => req<WidgetSetDetail>(`/${id}`),
  create: (body: { name: string; folder_id: string; description?: string }) => req<WidgetSetDetail>("", { method: "POST", json: body }),
  remove: (id: string) => req<unknown>(`/${id}`, { method: "DELETE" }),
  upload: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<Release>(`/${id}/releases/upload`, { method: "POST", body: fd });
  },
  saveDrafts: (id: string, widgets: Record<string, SourceWidget>) => req<{ drafts: Record<string, SourceWidget> }>(`/${id}/drafts`, { method: "PUT", json: { widgets } }),
  release: (id: string, version: string) => req<Release>(`/${id}/releases`, { method: "POST", json: { version } }),
  osdk: (id: string, body: { object_types: string[]; action_types: string[]; functions: string[] }) => req<Osdk>(`/${id}/osdk`, { method: "PUT", json: body }),
  ontologyApis: (id: string, enabled: boolean) => req<Osdk>(`/${id}/ontology-apis`, { method: "PUT", json: { enabled } }),
  dev: (id: string, url: string | null, paused = false) => req<{ dev: WidgetSetDetail["dev"] }>(`/${id}/dev`, { method: "PUT", json: { url, paused } }),
  load: (id: string, widget: string, version?: string) => req<Loaded>(`/${id}/load?widget=${encodeURIComponent(widget)}${version ? `&version=${encodeURIComponent(version)}` : ""}`),
  call: (id: string, op: string, args: unknown) => req<unknown>(`/${id}/osdk-call`, { method: "POST", json: { op, args } }),
};

export const STARTER_WIDGET: SourceWidget = {
  name: "Counter",
  description: "A counter: a parameter in, an event out",
  html: '<div class="card"><h1 id="title"></h1><p>Count: <b id="count">0</b></p><button id="inc">Increment</button></div>',
  css: ".card{font:14px system-ui;padding:12px;color:#1f2933}h1{font-size:16px;margin:0 0 8px}@media (prefers-color-scheme: dark){.card{color:#e3e8ee}}button{padding:4px 10px}",
  js: `// window.BluesandaiWidget: parameters in, events out, Nexus calls through the host
const w = window.BluesandaiWidget;
let count = 0;
w.onParameters((values) => {
  document.getElementById("title").textContent = "Hello, " + (values.name ?? "World") + "!";
  count = values.count ?? 0;
  document.getElementById("count").textContent = count;
});
document.getElementById("inc").onclick = () => w.emitEvent("updateCount", { parameterUpdates: { count: count + 1 } });`,
  parameters: { name: { displayName: "Name", type: "string" }, count: { displayName: "Count", type: "number" } },
  events: { updateCount: { displayName: "Update count", parameterUpdateIds: ["count"] } },
  permissions: [],
};
