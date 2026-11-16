/** Pilot (api/pilot.py): applications and custom widgets built from prompts by AI agents. */
import { API_URL } from "./api";

export type PlanType = {
  apiName: string;
  displayName: string;
  existingId?: string;
  primaryKey: string;
  titleProperty?: string;
  description?: string;
  properties: { apiName: string; displayName: string; type: string }[];
  added?: string[];
  status: "existing" | "proposed";
};
export type PlanAction = { apiName: string; displayName: string; objectType: string; kind: string; existingId?: string; status: "existing" | "proposed" };
export type Plan = { rationale?: string; object_types: PlanType[]; action_types: PlanAction[]; link_types: { from: string; to: string; foreignKey: string; displayName?: string }[] };
export type Message = { at: string; role: "user" | "assistant"; agent?: string; text: string; entities?: string[]; awaiting_approval?: boolean; error?: boolean };
export type Session = {
  id: string;
  name: string;
  kind: "application" | "widget";
  item_id: string;
  folder_id: string;
  model: string;
  mode: "act" | "plan";
  status: "idle" | "running" | "failed";
  permissions: { allow_create: boolean; default: "allow" | "deny"; entities: Record<string, "allow" | "deny"> };
  attachments: { kind: string; id?: string; name: string; text?: string }[];
  messages: Message[];
  plan: Plan;
  design: { summary: string; palette: Record<string, string>; typography?: Record<string, string>; layout: string; patterns?: string[] } | null;
  seed: Record<string, Record<string, unknown>[]>;
  files: Record<string, string>;
  widget: { name: string; description: string; html: string; css: string; js: string; parameters: Record<string, unknown>; events: Record<string, unknown> } | null;
  versions: { n: number; at: string; label: string }[];
  logs: { at: string; agent: string; text: string }[];
  pending_plan?: { prompt: string; plan: string } | null;
  deployment: (Record<string, unknown> & { steps?: string[]; checks?: Check[]; url?: string; module_id?: string; widget_set_id?: string }) | null;
  preview_url: string;
  existing: { id: string; apiName: string; displayName: string; primaryKey: string; properties: { apiName: string; type: string }[]; actions: { id: string; displayName: string; kind: string }[] }[];
  created_at: string;
  updated_at: string;
};
export type SessionSummary = Pick<Session, "id" | "name" | "kind" | "item_id" | "model" | "mode" | "status" | "created_at" | "updated_at" | "deployment"> & { versions: number; messages: number };
export type Check = { check: string; ok: boolean; detail: string };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/pilot" + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : b.detail?.checks ? `${b.detail.message}: ${b.detail.checks.filter((c: Check) => !c.ok).map((c: Check) => `${c.check} (${c.detail})`).join("; ")}` : JSON.stringify(b.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const pilot = {
  models: () => req<{ id: string; label: string; vendor: string; default?: boolean }[]>("/models"),
  list: () => req<SessionSummary[]>("/sessions"),
  get: (id: string) => req<Session>(`/sessions/${id}`),
  create: (body: { prompt: string; folder_id: string; kind: "application" | "widget"; model?: string; mode: "act" | "plan"; allow_create: boolean; default_edit: "allow" | "deny"; attachments: Session["attachments"] }) =>
    req<Session>("/sessions", { method: "POST", json: body }),
  prompt: (id: string, body: { prompt: string; mode?: "act" | "plan"; model?: string; attachments?: Session["attachments"] }) => req<Session>(`/sessions/${id}/prompt`, { method: "POST", json: body }),
  approve: (id: string) => req<Session>(`/sessions/${id}/approve`, { method: "POST" }),
  permissions: (id: string, body: Session["permissions"]) => req<Session>(`/sessions/${id}/permissions`, { method: "PUT", json: body }),
  saveFiles: (id: string, files: Record<string, string>) => req<Session>(`/sessions/${id}/files`, { method: "PUT", json: { files } }),
  restore: (id: string, n: number) => req<Session>(`/sessions/${id}/versions/${n}/restore`, { method: "POST" }),
  checks: (id: string) => req<Check[]>(`/sessions/${id}/checks`, { method: "POST" }),
  deploy: (id: string, body: { load_seed: boolean; slug?: string; workshop_module?: boolean }) => req<NonNullable<Session["deployment"]>>(`/sessions/${id}/deploy`, { method: "POST", json: body }),
  remove: (id: string) => req<unknown>(`/sessions/${id}`, { method: "DELETE" }),
};
