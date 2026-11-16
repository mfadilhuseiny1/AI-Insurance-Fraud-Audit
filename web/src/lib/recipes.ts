/** Recipes [Sunset] (api/recipes.py). */
import { API_URL } from "./api";

export type RecipeFilter = { column: string; op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "is null" | "is not null"; value?: string | null };
export type RecipeSchedule = { kind: "hours" | "weekly" | "on_update"; every_hours: number; days: number[]; time: string; timezone: string };
export type RecipeSource = "dataset" | "object_type" | "time_series" | "report";
export type RecipeBody = {
  name: string;
  source?: RecipeSource;
  item_id: string;
  series_id?: string | null;
  lookback_hours?: number;
  attachment?: "pdf" | "image";
  message: string;
  columns: string[];
  filters: RecipeFilter[];
  when: "always" | "condition";
  schedule: RecipeSchedule;
  channels: ("notification" | "email")[];
  recipients: string[];
  expires_in_days?: number;
};
export type RecipeRun = {
  id: string;
  at: string;
  trigger: string;
  status: "success" | "success_with_exceptions" | "skipped" | "failed";
  matched?: number;
  total?: number;
  reason?: string;
  error: string | null;
  delivered: { user: string; web: boolean; email: boolean; preview: boolean }[];
  exceptions: { user: string; reason: string }[];
};
export type Recipe = RecipeBody & {
  id: string;
  author: string;
  created_at: string;
  expires_at: string;
  paused: boolean;
  muted: string[];
  status: "active" | "paused" | "expired";
  muted_by_me: boolean;
  expiring_soon: boolean;
  can_manage: boolean;
  runs: RecipeRun[];
  last_run?: { id: string; at: string; status: string };
  resource: { id: string; name: string; path: string[]; link?: string };
  recipient_labels: Record<string, string>;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/recipes" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const recipes = {
  list: (scope: "mine" | "all", q = "") => req<Recipe[]>(`?scope=${scope}&q=${encodeURIComponent(q)}`),
  get: (id: string) => req<Recipe>(`/${id}`),
  columns: (itemId: string, source: RecipeSource = "dataset") => req<{ name: string; type: string }[]>(`/columns/${itemId}?source=${source}`),
  sources: (source: Exclude<RecipeSource, "dataset">) => req<{ id: string; name: string; series_id?: string }[]>(`/sources/${source}`),
  create: (body: RecipeBody) => req<Recipe>("", { method: "POST", json: body }),
  update: (id: string, body: RecipeBody) => req<Recipe>(`/${id}`, { method: "PUT", json: body }),
  status: (id: string, action: "mute" | "unmute" | "pause" | "resume" | "extend", days = 90) => req<Recipe>(`/${id}/status`, { method: "POST", json: { action, days } }),
  run: (id: string) => req<RecipeRun>(`/${id}/run`, { method: "POST" }),
  test: (id: string) => req<{ matched: number; total: number; columns: string[]; rows: (string | null)[][] }>(`/${id}/test`, { method: "POST" }),
  remove: (id: string) => req<{ deleted: string }>(`/${id}`, { method: "DELETE" }),
  preference: () => req<{ channel: "email" | "web" | "none" }>("/preferences/me"),
  setPreference: (channel: "email" | "web" | "none") => req<{ channel: string }>("/preferences/me", { method: "PUT", json: { channel } }),
  people: () => req<{ id: string; label: string }[]>("/people/all"),
};

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function describeSchedule(s: RecipeSchedule): string {
  if (s.kind === "on_update") return "When the dataset updates";
  if (s.kind === "hours") return `Every ${s.every_hours} hour${s.every_hours > 1 ? "s" : ""}`;
  return `Every ${s.days.map((d) => DAYS[d]).join(", ")} at ${s.time} (${s.timezone})`;
}

export function describeTrigger(r: Pick<RecipeBody, "when" | "filters">): string {
  if (r.when === "always") return "Always send";
  return `When ${r.filters.map((f) => `${f.column} ${f.op}${f.op.startsWith("is") ? "" : ` ${f.value ?? ""}`}`).join(" and ")}`;
}
