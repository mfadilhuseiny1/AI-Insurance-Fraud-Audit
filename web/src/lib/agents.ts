/** AIP Agent Studio (api/agents.py): ontology-grounded chat agents and their sessions. */
import { API_URL } from "./api";

export type AgentContext = { object_type_id: string; mode: "full" | "tools" };
export type SemanticTool = { object_type_id: string; vector_property?: string; k?: number; mode?: "semantic" | "keyword" | "hybrid" };
export type AgentTools = { search: boolean; aggregate: boolean; actions: string[]; logic: string[]; apply_logic_edits: boolean; semantic?: SemanticTool[] };
export type Agent = {
  id: string;
  name: string;
  description: string;
  model: string;
  instructions: string;
  contexts: AgentContext[];
  tools: AgentTools;
  citations: boolean;
  temperature: number;
  starters: string[];
  created_at: string;
  updated_at: string;
  session_count: number;
};

export type Citation = { object_type: string; object_type_id: string; primary_key: string; title: string; type_name: string };
export type AgentStep = { tool: string; arguments: Record<string, unknown>; ok: boolean; result: string };
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
  error?: string | null;
  steps?: AgentStep[];
  citations?: Citation[];
  model?: string;
  ms?: number;
};
export type SessionSummary = { id: string; title: string; created_at: string; updated_at: string; messages: number };
export type Session = { id: string; agent_id: string; title: string; messages: ChatMessage[]; created_at: string; updated_at: string };

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/agents" + path, {
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

export const agentsApi = {
  list: () => request<Agent[]>(""),
  get: (id: string) => request<Agent>(`/${id}`),
  create: (body: Partial<Agent>) => request<Agent>("", { method: "POST", json: body }),
  save: (id: string, body: Partial<Agent>) => request<Agent>(`/${id}`, { method: "PUT", json: body }),
  remove: (id: string) => request<unknown>(`/${id}`, { method: "DELETE" }),
  sessions: (id: string) => request<SessionSummary[]>(`/${id}/sessions`),
  newSession: (id: string) => request<Session>(`/${id}/sessions`, { method: "POST" }),
  session: (id: string, sid: string) => request<Session>(`/${id}/sessions/${sid}`),
  deleteSession: (id: string, sid: string) => request<unknown>(`/${id}/sessions/${sid}`, { method: "DELETE" }),
  send: (id: string, sid: string, content: string, appState?: Record<string, unknown>) =>
    request<ChatMessage>(`/${id}/sessions/${sid}/messages`, { method: "POST", json: appState ? { content, app_state: appState } : { content } }),
};

export const TOOL_LABEL: Record<string, string> = {
  search_objects: "Searched objects",
  aggregate: "Aggregated",
  get_object: "Read object",
  apply_action: "Applied action",
  run_logic: "Ran AIP Logic",
};
