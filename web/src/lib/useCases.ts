/** Use Cases [Sunset] (api/use_cases.py): a builder's view of a workflow Project. */
import { API_URL } from "./api";

export type Person = { principal: string; name: string };
export type Summary = { id: string; name: string; description: string; status: "active" | "experimental" | "deprecated"; project_id: string; project: string | null; technical_owners: Person[]; business_owners: Person[]; updated_at: string };
export type App = { key: string; item_id?: string; workshop_id?: string; in_project?: boolean; type: string; type_label: string; name: string; updated_at: string; href: string; refs: string[]; description: string };
export type UseCase = Summary & {
  documentation: string;
  my_role: "owner" | "editor" | null;
  can_view_project: boolean;
  roles: { principal: string; name: string; role: "owner" | "editor" }[];
  applications: App[];
  object_types: { id: string; name: string; status: string | null; manual: boolean; used_by: string[]; local: boolean; used_elsewhere: string[]; backing_dataset: string | null; properties: number }[];
  action_types: { id: string; name: string; status: string | null; object_type: string | null; manual: boolean; used_by: string[] }[];
  backing_data: { object_type_id: string; object_type: string; status: string | null; dataset_id: string | null; dataset: string | null; synced_at: string | null; in_project: boolean; writeback: string | null; update_via: { kind: string; name: string }[]; extra: string[] }[];
  other_resources: { item_id: string; name: string; content_type: string | null; updated_at: string; href: string }[];
  status_warning: boolean;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/use-cases" + path, {
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

export const uc = {
  list: (q = "") => req<Summary[]>(q ? `?q=${encodeURIComponent(q)}` : ""),
  create: (body: { name: string; description: string; project_id?: string; new_project?: string }) => req<UseCase>("", { method: "POST", json: body }),
  get: (id: string) => req<UseCase>(`/${id}`),
  update: (id: string, body: Partial<{ name: string; description: string; documentation: string; status: string; technical_owners: string[]; business_owners: string[]; app_description: { key: string; description: string } }>) =>
    req<UseCase>(`/${id}`, { method: "PATCH", json: body }),
  roles: (id: string, roles: { principal: string; role: string }[]) => req<UseCase>(`/${id}/roles`, { method: "PUT", json: { roles } }),
  ontology: (id: string, kind: "object_type" | "action_type", rid: string, add: boolean) => req<UseCase>(`/${id}/ontology`, { method: "POST", json: { kind, id: rid, add } }),
  newApp: (id: string, kind: "workshop" | "slate" | "quiver", name: string) => req<{ href: string; id: string | null }>(`/${id}/applications`, { method: "POST", json: { kind, name } }),
  linkWorkshop: (id: string, workshop_id: string, add = true) => req<UseCase>(`/${id}/applications/workshop`, { method: "POST", json: { workshop_id, add } }),
  remove: (id: string) => req<unknown>(`/${id}`, { method: "DELETE" }),
  objectType: (id: string, tid: string) =>
    req<{ id: string; name: string; description: string; status: string; primary_key: string; properties: { api_name: string; display_name: string; type: string }[]; backing_dataset: { name: string; dataset_id: string } | null; additional_datasources: string[]; applications: App[] }>(
      `/${id}/object-types/${tid}`,
    ),
};

export const STATUS_CLASS: Record<string, string> = { active: "bg-ok/15 text-ok", experimental: "bg-warn/15 text-warn", deprecated: "bg-bad/15 text-bad" };
