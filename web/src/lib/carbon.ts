/** Carbon (api/carbon.py): curated workspaces — menu bar, home page, modules in tabs, access and What's New. */
import { API_URL } from "./api";

export type ModuleType = "workshop" | "slate" | "object_explorer" | "object" | "object_type" | "notepad" | "quiver" | "vertex" | "map" | "search" | "url" | "developer_app";
/** params: parameter values of a Workshop module (module interface variables by external ID, or v.<variable>) or a
 * Slate application (URL parameters), added to the module's address */
export type ModuleRef = { type: ModuleType; id?: string; pk?: string; url?: string; query?: string; objectTypeId?: string; title?: string; params?: Record<string, string> };
/** What an embedded module posts to its Carbon workspace to open another module in a tab (outputs to inputs). */
export const CARBON_OPEN = "bluesandai.carbon.open";
export type Shortcut = { title: string; description?: string; icon?: string; color?: string; module: ModuleRef };
export type Section = { title?: string; description?: string; displayAs: "CARD" | "LIST"; contents: { type: "custom"; items: ModuleRef[] } | { type: "objectTypes"; objectTypes: string[] } | { type: "menuItems" } };
export type UpdatePage = { id: string; title: string; description?: string; media?: string; documentation?: string; archived?: boolean };
export type CarbonConfig = {
  displayMetadata: { title: string; description?: string };
  general: { navigationOutOfCarbon: "enabled" | "disabled"; externalLinks: { title: string; url: string }[]; discoverableModules: ModuleRef[] };
  moduleShortcuts: { primary: Shortcut[]; secondary: Shortcut[] };
  homePage: { type: "internal" | "module"; internal: { logo: string | null; welcomeText?: string; hideSearchBar?: boolean; searchObjectTypes: string[]; columns: { sections: Section[] }[] }; module: ModuleRef | null };
  access: { promoted: boolean; defaultForGroups: string[]; landing: boolean };
  updates: UpdatePage[];
};
export type WorkspaceSummary = { id: string; rid: string; item_id: string; title: string; description: string; version: number; updated_at: string; promoted: boolean; can_edit?: boolean };
export type Workspace = WorkspaceSummary & {
  config: CarbonConfig;
  previewing: number | null;
  can_edit: boolean;
  navigation: WorkspaceSummary[];
  org_external_links: { title: string; url: string }[];
  versions: { version: number; at: string; by: string; description: string }[];
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/carbon" + path, {
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
  return (res.headers.get("content-type") ?? "").includes("json") ? res.json() : ((await res.text()) as T);
}

export const carbon = {
  list: () => req<WorkspaceSummary[]>("/workspaces"),
  get: (id: string, version?: number) => req<Workspace>(`/workspaces/${id}${version ? `?version=${version}` : ""}`),
  create: (body: { title: string; folder_id: string; description?: string }) => req<Workspace>("/workspaces", { method: "POST", json: body }),
  save: (id: string, config: CarbonConfig, base_version: number, description = "") => req<Workspace>(`/workspaces/${id}`, { method: "PUT", json: { config, base_version, description } }),
  republish: (id: string, version: number) => req<Workspace>(`/workspaces/${id}/versions/${version}/republish`, { method: "POST" }),
  remove: (id: string) => req<unknown>(`/workspaces/${id}`, { method: "DELETE" }),
  yaml: (id: string) => req<string>(`/workspaces/${id}/yaml`),
  putYaml: (id: string, yaml: string, base_version: number) => req<Workspace>(`/workspaces/${id}/yaml`, { method: "PUT", json: { yaml, base_version } }),
  org: () => req<{ promoted: string[]; external_links: { title: string; url: string }[]; landing: boolean; workspaces: WorkspaceSummary[]; can_admin: boolean }>("/org"),
  putOrg: (body: { promoted?: string[]; external_links?: { title: string; url: string }[]; landing?: boolean }) => req<unknown>("/org", { method: "PUT", json: body }),
  me: () => req<{ default: WorkspaceSummary | null; landing: boolean }>("/me"),
  unseen: (id: string) => req<UpdatePage[]>(`/workspaces/${id}/updates/unseen`),
  seen: (id: string, ids: string[]) => req<unknown>(`/workspaces/${id}/updates/seen`, { method: "POST", json: { ids } }),
  discoverable: (objectTypeId: string) => req<{ workspace: WorkspaceSummary; module: ModuleRef }[]>(`/discoverable?object_type_id=${encodeURIComponent(objectTypeId)}`),
};

/** The URL a module opens at inside a Carbon tab (the platform's own pages, without their sidebar). */
export function moduleUrl(m: ModuleRef): string {
  const p = new URLSearchParams(m.type === "workshop" || m.type === "slate" ? m.params ?? {} : {}).toString();
  const e = `${p ? `${p}&` : ""}embed=1`;
  switch (m.type) {
    case "workshop":
      return `/workshop/${m.id}?${e}`;
    case "slate":
      return `/slate/${m.id}?${e}`;
    case "notepad":
      return `/notepad/${m.id}?${e}`;
    case "quiver":
      return `/quiver/${m.id}?${e}`;
    case "map":
      return `/map/${m.id}?${e}`;
    case "vertex":
      return `/vertex?${m.id ? `id=${m.id}&` : ""}${e}`;
    case "object":
      return `/ontology/objects/${m.objectTypeId}/${encodeURIComponent(m.pk ?? "")}?${e}`;
    case "object_type":
    case "object_explorer":
      return `/object-explorer?${m.objectTypeId || m.id ? `type=${m.objectTypeId || m.id}&` : ""}${e}`;
    case "search":
      return `/object-explorer?q=${encodeURIComponent(m.query ?? "")}${m.objectTypeId ? `&type=${m.objectTypeId}` : ""}&${e}`;
    case "developer_app":
      return m.url ?? "/developer-console";
    case "url":
      return m.url ?? "/";
  }
}

export const MODULE_LABEL: Record<ModuleType, string> = {
  workshop: "Workshop module",
  slate: "Slate application",
  object_explorer: "Object Explorer",
  object: "Object view",
  object_type: "Object type",
  notepad: "Notepad document",
  quiver: "Quiver dashboard",
  vertex: "Vertex graph",
  map: "Map",
  search: "Object Explorer search",
  url: "Link",
  developer_app: "Developer Console application",
};
