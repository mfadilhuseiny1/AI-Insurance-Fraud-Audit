/** Developer Console (api/developer_console.py): OSDK applications, their OAuth2 clients, scopes, SDKs and hosting. */
import { API_URL } from "./api";

export type DcApp = {
  id: string;
  rid: string;
  name: string;
  description: string;
  item_id: string;
  kind: "client" | "backend";
  client_id: string;
  has_secret: boolean;
  redirect_uris: string[];
  allowed_origins: string[];
  resources: { object_types: string[]; action_types: string[]; functions: string[] };
  sdk: { version: string; generated_at: string; object_types: number; size: number }[];
  package: string;
  hosting: { slug: string; url?: string; releases: { version: string; files: number; size: number; uploaded_at: string }[]; live: string | null; csp_domains: string[] };
  created_at: string;
  created_by: string;
  client_secret?: string;
  /** tokens carry api:audit-read and may read audit log files (Security auditing) */
  audit_read?: boolean;
  disabled?: boolean;
  project_scope?: string[] | null;
  marking_scope?: string[] | null;
  org_consent?: string[];
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : (b.detail?.message ?? b.error_description ?? JSON.stringify(b.detail));
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

const B = "/api/developer-console";
export type ServiceUser = { id: string; username: string; display_name?: string; disabled: boolean };
export type MyGrant = { app_id: string; name: string; kind: "client" | "backend"; description: string; access_tokens: number; refresh_tokens: number; last_issued: string | null; expires: string; object_types: string[]; action_types: string[]; functions: number };
export const devConsole = {
  list: () => req<DcApp[]>(`${B}/apps`),
  get: (id: string) => req<DcApp>(`${B}/apps/${id}`),
  create: (body: { name: string; folder_id: string; kind: "client" | "backend"; redirect_uris: string[]; description?: string }) => req<DcApp>(`${B}/apps`, { method: "POST", json: body }),
  update: (id: string, body: Partial<Pick<DcApp, "name" | "description" | "redirect_uris" | "allowed_origins">>) => req<DcApp>(`${B}/apps/${id}`, { method: "PUT", json: body }),
  remove: (id: string) => req<unknown>(`${B}/apps/${id}`, { method: "DELETE" }),
  rotateSecret: (id: string) => req<{ client_secret: string }>(`${B}/apps/${id}/secret`, { method: "POST" }),
  resources: (id: string, body: DcApp["resources"]) => req<DcApp>(`${B}/apps/${id}/resources`, { method: "PUT", json: body }),
  generateSdk: (id: string, version?: string) => req<DcApp["sdk"][number]>(`${B}/apps/${id}/sdk`, { method: "POST", json: { version } }),
  sdkFiles: (id: string, version: string) => req<{ version: string; package: string; files: Record<string, string> }>(`${B}/apps/${id}/sdk/${version}`),
  sdkUrl: (id: string, version: string) => `${API_URL}${B}/apps/${id}/sdk/${version}/package.tgz`,
  hosting: (id: string, body: { slug?: string; csp_domains?: string[] }) => req<DcApp>(`${B}/apps/${id}/hosting`, { method: "PUT", json: body }),
  uploadSite: (id: string, version: string, file: File) => {
    const fd = new FormData();
    fd.append("version", version);
    fd.append("file", file);
    return req<DcApp>(`${B}/apps/${id}/hosting/releases`, { method: "POST", body: fd });
  },
  setLive: (id: string, version: string | null) => req<DcApp>(`${B}/apps/${id}/hosting/live`, { method: "PUT", json: { version } }),
  grants: (id: string) => req<{ users: string[]; active_tokens: number; service_user: ServiceUser | null }>(`${B}/apps/${id}/grants`),
  /** a backend application's own service user: its client credentials tokens act as it instead of as the creator */
  setEnablement: (id: string, body: { enabled: boolean; project_scope: string[] | null; marking_scope: string[] | null; org_consent: string[] }) =>
    req<DcApp>(`${B}/apps/${id}/enablement`, { method: "PUT", json: body }),
  setAuditRead: (id: string, enabled: boolean) => req<{ audit_read: boolean }>(`${B}/apps/${id}/audit-read`, { method: "PUT", json: { enabled } }),
  setServiceUser: (id: string, enabled: boolean) => req<{ service_user: ServiceUser | null }>(`${B}/apps/${id}/service-user`, { method: "PUT", json: { enabled } }),
  /** the applications the signed-in user granted, and revoking one's own grant */
  myGrants: () => req<MyGrant[]>("/api/oauth2/my-grants"),
  revokeMyGrant: (appId: string) => req<{ revoked: number }>(`/api/oauth2/my-grants/${appId}`, { method: "DELETE" }),
  revokeGrants: (id: string) => req<unknown>(`${B}/apps/${id}/grants`, { method: "DELETE" }),
  clientInfo: (clientId: string) => req<{ name: string; description: string; kind: string; redirect_uris: string[]; object_types: string[]; action_types: string[]; functions: number }>(`/api/oauth2/clients/${clientId}`),
  approve: (body: { client_id: string; redirect_uri: string; state: string; code_challenge?: string | null; code_challenge_method?: string | null; deny?: boolean }) =>
    req<{ redirect: string }>("/api/oauth2/authorize/approve", { method: "POST", json: body }),
};

export const siteUrl = (slug: string) => `${API_URL}/api/dc-hosting/${slug}/`;
