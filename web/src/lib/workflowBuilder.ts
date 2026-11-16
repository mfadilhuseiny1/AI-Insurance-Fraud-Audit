/** Workflow Builder (api/workflow_builder.py): Ontology workflows as graphs of nodes. */
import { API_URL } from "./api";

export type NodeType = "trigger" | "subgraph" | "compute" | "llm" | "fork" | "after_fork" | "effect" | "loop" | "after_loop" | "call_subgraph";
export type WBNode = { id: string; type: NodeType; name: string; x: number; y: number; config: Record<string, unknown> };
export type WBEdge = { from: string; to: string; port: string };
export type WBDoc = { nodes: WBNode[]; edges: WBEdge[]; params: { name: string; value: unknown }[]; watchlist: string[] };
/** A Use LLM tool call: args is the raw text when the model's arguments were not a JSON object (the call is refused);
 * turn is the model turn that asked for it, parallel the number of calls asked for in that turn. */
export type ToolCall = { tool: string; args: Record<string, unknown> | string; result?: unknown; error?: string; turn?: number; parallel?: number; ms?: number };
/** A Use LLM model turn: its text and the tools it called. */
export type LlmTurn = { turn: number; text: string; tool_calls: string[] };
export type Step = {
  node: string;
  type: string;
  at: string;
  value?: unknown;
  error?: string;
  ms?: number;
  tool_calls?: ToolCall[];
  /** Use LLM with tool calling: native provider tool calls, or JSON turns (registered models, routes without tool use) */
  tool_mode?: "native" | "json";
  /** why native tool calling fell back to JSON turns */
  fallback?: string;
  /** set when the model still asked for tools after max_tool_calls */
  stopped?: string;
  turns?: LlmTurn[];
};
/** Events of a streamed preview / execution, each with the run's index. */
export type RunEvent =
  | { kind: "run_start"; index: number; inputs: Record<string, unknown> }
  | { kind: "node"; index: number; node: string; type: string; status: "running" }
  | { kind: "step"; index: number; status: "done" | "failed" } & Step
  | { kind: "model"; index: number; node: string; turn: number; text: string }
  | { kind: "tool_call"; index: number; node: string; call: ToolCall }
  | { kind: "run"; index: number; result: RunResult };
export type RunResult = {
  id: string;
  at: string;
  start: string;
  inputs: Record<string, unknown>;
  preview: boolean;
  status: "succeeded" | "failed";
  error: string | null;
  path: Step[];
  edits?: { object_type_id: string; object_type: string; primary_key: string; op: string; changes: Record<string, { from: unknown; to: unknown }> }[];
  ms: number;
  trigger?: string;
  by?: string;
  version?: number;
};
export type Graph = {
  id: string;
  item_id: string;
  name: string;
  version: number;
  doc: WBDoc;
  deployed: Record<string, { enabled: boolean; by: string; at: string; version: number }>;
  can_edit: boolean;
  previewing: number | null;
  versions: { version: number; at: string; by: string; description: string; nodes: number }[];
  updated_at: string;
};
export type Catalog = {
  object_types: { id: string; name: string; properties: { api_name: string; name: string; type: string }[] }[];
  action_types: { id: string; name: string; object_type_id: string; parameters: { id: string; name: string; type: string; required: boolean }[] }[];
  functions: { id: string; name: string; inputs: { name: string; type: string }[]; output: string; version: string }[];
  models: { id: string; label: string; default?: boolean }[];
  users: { id: string; name: string }[];
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/workflow-builder" + path, {
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
    const e = new Error(message) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** POST, then read the server-sent events until "result" (the runs) or "error". */
async function streamRuns(path: string, body: unknown, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<RunResult[]> {
  const res = await fetch(API_URL + "/api/workflow-builder" + path, {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    const e = new Error(message) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const kind = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!kind || data === undefined) continue;
      const payload = JSON.parse(data);
      if (kind === "result") return payload as RunResult[];
      if (kind === "error") {
        const e = new Error(typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail)) as Error & { status?: number };
        e.status = payload.status;
        throw e;
      }
      if (kind === "cancelled") throw new Error("cancelled");
      onEvent({ ...payload, kind } as RunEvent);
    }
  }
  throw new Error("the stream ended without a result");
}

export const wb = {
  catalog: () => req<Catalog>("/catalog"),
  list: () => req<{ id: string; name: string; version: number; workflows: number; deployed: number; updated_at: string }[]>("/graphs"),
  create: (name: string, folder_id: string, doc?: WBDoc) => req<Graph>("/graphs", { method: "POST", json: { name, folder_id, doc } }),
  get: (id: string, version?: number) => req<Graph>(`/graphs/${id}${version ? `?version=${version}` : ""}`),
  save: (id: string, doc: WBDoc, base_version: number, description = "") => req<Graph>(`/graphs/${id}`, { method: "PUT", json: { doc, base_version, description } }),
  restore: (id: string, v: number) => req<Graph>(`/graphs/${id}/versions/${v}/restore`, { method: "POST" }),
  remove: (id: string) => req<unknown>(`/graphs/${id}`, { method: "DELETE" }),
  preview: (id: string, doc: WBDoc, start: string, primary_keys: string[], inputs: Record<string, unknown> = {}) =>
    req<RunResult[]>(`/graphs/${id}/preview`, { method: "POST", json: { doc, start, primary_keys, inputs } }),
  execute: (id: string, start: string, primary_keys: string[], inputs: Record<string, unknown> = {}) => req<RunResult[]>(`/graphs/${id}/execute`, { method: "POST", json: { start, primary_keys, inputs } }),
  /** The preview, streamed: onEvent gets each node, model turn text (so far) and tool call as it happens. Aborting the
   * signal closes the stream and stops the runs at their next node or model turn. */
  previewStream: (id: string, doc: WBDoc, start: string, primary_keys: string[], onEvent: (e: RunEvent) => void, signal?: AbortSignal, inputs: Record<string, unknown> = {}) =>
    streamRuns(`/graphs/${id}/preview/stream`, { doc, start, primary_keys, inputs }, onEvent, signal),
  /** Execution, streamed. A run on main is not stopped by aborting: it finishes and is recorded. */
  executeStream: (id: string, start: string, primary_keys: string[], onEvent: (e: RunEvent) => void, signal?: AbortSignal, inputs: Record<string, unknown> = {}) =>
    streamRuns(`/graphs/${id}/execute/stream`, { start, primary_keys, inputs }, onEvent, signal),
  deploy: (id: string, start: string, enabled: boolean) => req<Graph>(`/graphs/${id}/deploy`, { method: "POST", json: { start, enabled } }),
  runs: (id: string) => req<RunResult[]>(`/graphs/${id}/runs`),
  objects: (id: string, type_id: string, q = "") =>
    req<{ total: number; objects: { primary_key: string; title: string; properties: Record<string, unknown>; last_run: { at: string; status: string; path: string[] } | null }[] }>(
      `/graphs/${id}/objects?type_id=${type_id}&q=${encodeURIComponent(q)}`,
    ),
};

export const TYPE_INFO: Record<NodeType, { label: string; color: string; icon: string }> = {
  trigger: { label: "Trigger", color: "#22c55e", icon: "bolt" },
  subgraph: { label: "Subgraph", color: "#14b8a6", icon: "layers" },
  compute: { label: "Compute", color: "#3b82f6", icon: "code" },
  llm: { label: "Use LLM", color: "#a855f7", icon: "sparkle" },
  fork: { label: "Fork", color: "#f59e0b", icon: "split" },
  after_fork: { label: "After fork", color: "#b45309", icon: "split" },
  effect: { label: "Effect", color: "#ec4899", icon: "edit" },
  loop: { label: "Loop", color: "#06b6d4", icon: "refresh" },
  after_loop: { label: "After loop", color: "#0e7490", icon: "refresh" },
  call_subgraph: { label: "Call subgraph", color: "#0d9488", icon: "layers" },
};

/** The output ports of a node: "next", one per fork case plus "default", or the loop body. */
export function ports(n: WBNode): { port: string; label: string }[] {
  if (n.type === "fork") return [...((n.config.cases as { id: string; name: string }[]) ?? []).map((c) => ({ port: `case:${c.id}`, label: c.name || c.id })), { port: "default", label: "Otherwise" }];
  if (n.type === "loop") return [{ port: "body", label: "For each" }];
  return [{ port: "next", label: "" }];
}

/** A node of a streamed run as it happens (a node in a loop has one entry per visit): its step once it ended; for Use
 * LLM the model's turns so far (each turn's text as the model writes it) and the tool calls as they return. */
export type LiveEntry = { node: string; type: string; status: "running" | "done" | "failed"; step?: Step; turns: LlmTurn[]; calls: ToolCall[] };
/** A streamed run: "stopped" when the stream was closed (Stop) before it ended. */
export type LiveRun = { index: number; inputs: Record<string, unknown>; status: "running" | "succeeded" | "failed" | "stopped"; entries: LiveEntry[]; result?: RunResult };
/** A run to show: a finished one, or a streamed one so far (running: the nodes running now). */
export type ShownRun = Omit<RunResult, "status"> & { status: RunResult["status"] | "running" | "stopped"; running?: string[] };

/** The streamed runs after one event (a new list; the runs and entries it touches are new objects). */
export function foldRunEvent(runs: LiveRun[], e: RunEvent): LiveRun[] {
  if (e.kind === "run_start") return [...runs.filter((r) => r.index !== e.index), { index: e.index, inputs: e.inputs, status: "running", entries: [] }];
  const i = runs.findIndex((r) => r.index === e.index);
  if (i < 0) return runs;
  const run = runs[i];
  const put = (r: LiveRun) => runs.map((x, j) => (j === i ? r : x));
  if (e.kind === "run") return put({ ...run, status: e.result.status, result: e.result, entries: run.entries.map((x) => (x.status === "running" ? { ...x, status: "failed" } : x)) });
  if (e.kind === "node") return put({ ...run, entries: [...run.entries, { node: e.node, type: e.type, status: "running", turns: [], calls: [] }] });
  // the latest visit of the node that is still running
  let k = -1;
  for (let j = run.entries.length - 1; j >= 0; j--)
    if (run.entries[j].node === e.node && run.entries[j].status === "running") {
      k = j;
      break;
    }
  const entries = [...run.entries];
  const cur: LiveEntry = k >= 0 ? entries[k] : { node: e.node, type: e.kind === "step" ? e.type : "llm", status: "running", turns: [], calls: [] };
  let next: LiveEntry = cur;
  if (e.kind === "step") {
    const { kind: _k, index: _i, status, ...step } = e;
    void _k;
    void _i;
    next = { ...cur, status: status === "failed" || step.error ? "failed" : "done", step: step as Step, turns: step.turns ?? cur.turns, calls: step.tool_calls ?? cur.calls };
  } else if (e.kind === "model") {
    const turns = cur.turns.some((t) => t.turn === e.turn) ? cur.turns.map((t) => (t.turn === e.turn ? { ...t, text: e.text } : t)) : [...cur.turns, { turn: e.turn, text: e.text, tool_calls: [] }];
    next = { ...cur, turns };
  } else if (e.kind === "tool_call") {
    const t = e.call.turn;
    const turns = t === undefined ? cur.turns : cur.turns.some((x) => x.turn === t) ? cur.turns.map((x) => (x.turn === t ? { ...x, tool_calls: [...x.tool_calls, e.call.tool] } : x)) : [...cur.turns, { turn: t, text: "", tool_calls: [e.call.tool] }];
    next = { ...cur, turns, calls: [...cur.calls, e.call] };
  }
  if (k >= 0) entries[k] = next;
  else entries.push(next);
  return put({ ...run, entries });
}

/** After Stop: the runs still running are stopped, and so are their running nodes. */
export function stopLive(runs: LiveRun[]): LiveRun[] {
  return runs.map((r) => (r.status !== "running" ? r : { ...r, status: "stopped", entries: r.entries.map((x) => (x.status === "running" ? { ...x, status: "failed", step: { node: x.node, type: x.type, at: "", error: "stopped", turns: x.turns, tool_calls: x.calls } } : x)) }));
}

/** An entry as a step (a running Use LLM node carries its turns and tool calls so far). */
export function liveStep(x: LiveEntry): Step {
  return x.step ? { ...x.step, turns: x.step.turns ?? (x.turns.length ? x.turns : undefined), tool_calls: x.step.tool_calls ?? (x.calls.length ? x.calls : undefined) } : { node: x.node, type: x.type, at: "", turns: x.turns, tool_calls: x.calls };
}

/** A streamed run to show: its result once it ended (unless stopped), else its path so far. */
export function liveShown(r: LiveRun, start: string, preview: boolean): ShownRun {
  if (r.result && r.status !== "stopped") return r.result;
  const path = r.entries.map(liveStep);
  return {
    id: `live-${r.index}`,
    at: "",
    start,
    inputs: r.inputs,
    preview,
    status: r.status,
    error: r.status === "stopped" ? "stopped: the preview was closed" : path.find((s) => s.error)?.error ?? null,
    path,
    ms: path.reduce((a, s) => a + (s.ms ?? 0), 0),
    running: r.entries.filter((x) => x.status === "running").map((x) => x.node),
  };
}

/** A Use LLM step's turns with their tool calls, in the model's order (calls of the same turn together; calls recorded
 * without a turn, from runs before turns were recorded, form one group at the end). */
export function turnGroups(turns: LlmTurn[] | undefined, calls: ToolCall[] | undefined): { turn: number; text: string; calls: ToolCall[] }[] {
  const out = (turns ?? []).map((t) => ({ turn: t.turn, text: t.text, calls: [] as ToolCall[] }));
  for (const c of calls ?? []) {
    const t = c.turn ?? 0;
    let g = out.find((x) => x.turn === t);
    if (!g) {
      g = { turn: t, text: "", calls: [] };
      out.push(g);
    }
    g.calls.push(c);
  }
  return out.sort((a, b) => (a.turn || 1e9) - (b.turn || 1e9));
}
