/**
 * Checkpoints (api/checkpoints.py): the API answers a sensitive interaction with 428 "checkpoint_required" when a
 * checkpoint configuration applies. lib/auth.ts's fetch hands that answer to askCheckpoint(); CheckpointHost shows the
 * prompts, records the justification and returns a one-time pass, and the request is retried with it.
 * Nothing here imports lib/auth (auth imports this module).
 */
import { API_URL } from "./api";

export type Justification = {
  kind: "acknowledgment" | "response" | "dropdown" | "reauthentication";
  checkbox_text: string;
  validation: string;
  options: string[];
  multiple: boolean;
  free_text: "none" | "optional" | "required";
  recent: boolean;
};
export type CheckpointPrompt = {
  config_id: string;
  config_rid: string;
  title: string;
  prompt: string;
  description: string;
  justification: Justification;
  recent?: string[];
  type: string;
  type_name: string;
};
export type CheckpointRequired = {
  code: "checkpoint_required";
  context: string;
  checkpoints: CheckpointPrompt[];
  types: string[];
  items: { type?: string; id: string; name?: string }[];
};
export type CheckpointAnswer = { acknowledged?: boolean; response?: string; selected?: string[]; password?: string; code?: string };

/**
 * Before the browser saves data it already shows (query results, a preview, a Slate table): the API applies
 * checkpoints ("Frontend export", "Slate export") and download controls. False: refused or the prompt was cancelled.
 */
export async function allowExport(body: { type?: "frontend_export" | "slate_export"; item_id?: string | null; detail?: string }): Promise<boolean> {
  const res = await fetch(`${API_URL}/api/frontend-exports/export`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, detail: (body.detail ?? "").slice(0, 200) }),
  });
  if (res.ok || res.status === 404) return true;
  if (res.status !== 428) {
    const b = await res.json().catch(() => ({}) as { detail?: string });
    const { alertDialog } = await import("./dialogs");
    void alertDialog(typeof b.detail === "string" ? b.detail : "The export is not allowed");
  }
  return false;
}

type Pending = { id: number; payload: CheckpointRequired; resolve: (pass: string | null) => void };
let queue: Pending[] = [];
let seq = 0;
const listeners = new Set<(q: Pending[]) => void>();
const emit = () => listeners.forEach((l) => l(queue));

/** Ask the user to answer a checkpoint; the pass for retrying, or null when they cancel. */
export function askCheckpoint(payload: CheckpointRequired): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { id: ++seq, payload, resolve }];
    emit();
  });
}

export function subscribeCheckpoints(l: (q: Pending[]) => void): () => void {
  listeners.add(l);
  l(queue);
  return () => {
    listeners.delete(l);
  };
}

export function settleCheckpoint(id: number, pass: string | null) {
  const p = queue.find((x) => x.id === id);
  queue = queue.filter((x) => x.id !== id);
  emit();
  p?.resolve(pass);
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const d = (b as { detail?: unknown }).detail;
    throw new Error(typeof d === "string" ? d : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export type CheckpointType = { id: string; name: string; group: string; application: string; conditions: string[]; resources: boolean };
export type CheckpointCondition = { kind: "location" | "user" | "selected" | "marking" | "action_type" | "object_type"; ids: string[]; negate: boolean; member_groups?: boolean };
export type CheckpointConfig = {
  id: string;
  rid: string;
  name: string;
  description: string;
  types: string[];
  scope: { kind: "organization" | "project"; id: string };
  conditions: CheckpointCondition[];
  title: string;
  prompt: string;
  description_text: string;
  justification: Justification;
  frequency_minutes: number | null;
  enabled: boolean;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
};
export type CheckpointRecord = {
  id: string;
  rid: string;
  config_id: string;
  config_rid: string;
  config_name: string;
  type: string;
  user_id: string;
  username: string;
  org: string;
  created_at: string;
  title: string;
  prompt: string;
  description: string;
  justification: { kind: string; response?: string; selected?: string[]; acknowledged?: boolean; checkbox_text?: string; reauthenticated?: boolean };
  items: { type?: string; id: string; name?: string }[];
  selected: { type: string; id: string; role?: string }[];
  markings: string[];
  action_type: string | null;
  projects: string[];
};

export const checkpointsApi = {
  submit: (context: string, answers: Record<string, CheckpointAnswer>) =>
    call<{ pass: string; records: string[] }>("/api/checkpoints/records", { method: "POST", json: { context, answers } }),
  context: (id: string) => call<{ context: string; checkpoints: CheckpointPrompt[]; items: CheckpointRequired["items"] }>(`/api/checkpoints/context/${id}`),
  types: () => call<CheckpointType[]>("/api/checkpoints/types"),
  configs: () => call<CheckpointConfig[]>("/api/checkpoints/configs"),
  create: (c: Omit<CheckpointConfig, "id" | "rid">) => call<CheckpointConfig>("/api/checkpoints/configs", { method: "POST", json: c }),
  update: (id: string, c: Omit<CheckpointConfig, "id" | "rid">) => call<CheckpointConfig>(`/api/checkpoints/configs/${id}`, { method: "PUT", json: c }),
  remove: (id: string) => call<{ deleted: string }>(`/api/checkpoints/configs/${id}`, { method: "DELETE" }),
  package: (id: string) => call<Record<string, unknown>>(`/api/checkpoints/configs/${id}/package`),
  install: (pkg: Record<string, unknown>, projectId: string, mapping: Record<string, string> = {}) =>
    call<CheckpointConfig>("/api/checkpoints/install", { method: "POST", json: { package: pkg, project_id: projectId, mapping } }),
  records: (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => v && p.set(k, v));
    return call<{ total: number; records: CheckpointRecord[] }>(`/api/checkpoints/records?${p}`);
  },
  evaluate: (body: { type: string; items?: string[]; user_id?: string; action_type?: string; object_type?: string; selected?: string[] }) =>
    call<{ checkpoints: (CheckpointPrompt & { name: string })[] }>("/api/checkpoints/evaluate", { method: "POST", json: body }),
};
