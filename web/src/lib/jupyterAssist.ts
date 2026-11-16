/** The AI assistant beside JupyterLab (Docker): the model's turns (api/code_workspace_assist.py) and the bridge in
 *  JupyterLab's page (api/jupyterlab_bridge/bridge.js) that reads the open notebook and carries out what the user
 *  approved. */
import { API_URL } from "./api";

export type NbOutput = { kind: "stream" | "error" | "result" | "display"; name?: string; text?: string; media?: string[]; ename?: string; evalue?: string; traceback?: string };
export type NbCell = { cell_id: string; n: number; type: "code" | "markdown" | "raw"; source: string; execution_count: number | null; outputs: NbOutput[] };
export type NbSnapshot =
  | {
      kind: "notebook"; path: string; name: string; dirty: boolean; language: string; kernel: string; kernel_status: string; has_kernel: boolean;
      active_cell_id: string | null; selection: string; cells: NbCell[];
    }
  | { kind: "other" | "none"; title: string };
/** what the bridge pushes when the notebook in front, its active cell or its kernel changes */
export type LabContext =
  | { kind: "notebook"; name: string; path: string; cells: number; active: number; errors: number[]; kernel_status: string; selection: boolean }
  | { kind: "other" | "none"; title: string };
export type RunResult = {
  cell_id: string; n: number; status: "ok" | "error" | "abort" | "no-op"; execution_count?: number | null; outputs?: NbOutput[];
  error?: { ename?: string; evalue?: string; traceback?: string }; message?: string;
};
/** the notebook's code cells run top to bottom, stopped at the first error */
export type RunAll = {
  status: "ok" | "error" | "abort"; ran: number; of: number; cells: { n: number; status: string }[];
  failed?: { cell_id: string; n: number; error?: { ename?: string; evalue?: string; traceback?: string }; outputs?: NbOutput[] };
};

/** args null: the model's arguments could not be read (args_error says why); syntax_error: the code it proposes does not
 *  compile (the API checks Python cells) */
export type ToolCall = { id: string; name: string; args: Record<string, unknown> | null; raw_args: string; change: boolean; args_error?: string; syntax_error?: string };
/** the platform's neutral messages (api/pipeline_ai.chat_tools): the assistant turn goes back as the API returned it */
export type AssistantMessage = { role: "assistant"; text: string; tool_calls: unknown[]; native?: Record<string, unknown> };
export type Neutral = { role: "user"; text: string } | AssistantMessage | { role: "tool"; id: string; name: string; result: unknown };
export type TurnResult = { text: string; tool_calls: ToolCall[]; message: AssistantMessage; model: string } | { error: string } | { cancelled: true };
export type AssistInfo = { model: string; label: string; ready: boolean; user: string; tools: string[]; changes: string[] };

const base = (wid: string) => `${API_URL}/api/code-workspaces/${encodeURIComponent(wid)}/assist`;

export async function assistInfo(wid: string): Promise<AssistInfo> {
  const res = await fetch(base(wid), { credentials: "include", cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.statusText);
  return body as AssistInfo;
}

/** inspect_data: a data file of the workspace looked into by the API (columns, rows, first rows) */
export async function assistInspect(wid: string, path: string): Promise<{ path: string; rows: number | null; columns: { name: string; type: string }[]; first_rows: Record<string, string | null>[] }> {
  const res = await fetch(`${base(wid)}/inspect?path=${encodeURIComponent(path)}`, { credentials: "include", cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.statusText);
  return body;
}

/** One model turn: the answer streams to `onText` (the whole text so far), then its result. */
export async function assistTurn(wid: string, body: { messages: Neutral[]; notebook: NbSnapshot | null; nudge?: boolean }, onText: (text: string) => void, signal?: AbortSignal): Promise<TurnResult> {
  const res = await fetch(`${base(wid)}/turn`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({}));
    throw new Error(typeof b.detail === "string" ? b.detail : `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || data === undefined) continue;
      const payload = JSON.parse(data);
      if (ev === "chunk") onText((text += payload as string));
      else if (ev === "reset") onText((text = ""));
      else if (ev === "result") return payload as TurnResult;
    }
  }
  throw new Error("the answer stopped before it was complete");
}

/** postMessage to the bridge in JupyterLab's iframe (the API's origin), answers matched by id; the bridge's context
 *  pushes go to `onContext`. It listens between open() and close() (an effect's setup and cleanup: React may run them
 *  twice on the same instance). */
export class LabBridge {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: number }>();
  private seq = 0;
  readonly origin = new URL(API_URL).origin;

  constructor(
    private frame: () => HTMLIFrameElement | null,
    private onContext: (c: LabContext) => void,
  ) {}

  open() {
    window.addEventListener("message", this.listen);
  }

  close() {
    window.removeEventListener("message", this.listen);
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new Error("the assistant was closed"));
    }
    this.pending.clear();
  }

  private listen = (ev: MessageEvent) => {
    const f = this.frame();
    if (!f || ev.source !== f.contentWindow || ev.origin !== this.origin) return;
    const d = ev.data as { bluesandai?: string; id?: string; ok?: boolean; result?: unknown; error?: string; context?: LabContext };
    if (d?.bluesandai === "assist-reply" && d.id) {
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      window.clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || "JupyterLab could not do it"));
    } else if (d?.bluesandai === "assist-context" && d.context) {
      this.onContext(d.context);
    }
  };

  /** `timeoutMs` 0: no limit (a cell may run for minutes) */
  call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const win = this.frame()?.contentWindow;
    if (!win) return Promise.reject(new Error("JupyterLab is not open"));
    const id = `${Date.now().toString(36)}-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs ? window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("JupyterLab did not answer"));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      win.postMessage({ bluesandai: "assist", id, op, args }, this.origin);
    });
  }
}

export type DiffLine = { t: " " | "+" | "-"; s: string };

/** Line diff by longest common subsequence; very long sources come out as all removed, then all added. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 400_000) return [...x.map((s) => ({ t: "-" as const, s })), ...y.map((s) => ({ t: "+" as const, s }))];
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ t: " ", s: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: x[i++] });
    else out.push({ t: "+", s: y[j++] });
  }
  while (i < n) out.push({ t: "-", s: x[i++] });
  while (j < m) out.push({ t: "+", s: y[j++] });
  return out;
}

/** A markdown answer cut into prose and fenced code blocks (an unclosed block while it streams is code too). */
export function splitFences(md: string): ({ kind: "md"; text: string } | { kind: "code"; lang: string; code: string; open: boolean })[] {
  const out: ({ kind: "md"; text: string } | { kind: "code"; lang: string; code: string; open: boolean })[] = [];
  const lines = md.split("\n");
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang = "";
  let fence = "";
  for (const line of lines) {
    if (code === null) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
      if (m) {
        if (prose.length) out.push({ kind: "md", text: prose.join("\n") });
        prose = [];
        code = [];
        fence = m[1];
        lang = m[2] || "";
      } else prose.push(line);
    } else if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) {
      out.push({ kind: "code", lang, code: code.join("\n"), open: false });
      code = null;
    } else code.push(line);
  }
  if (code !== null) out.push({ kind: "code", lang, code: code.join("\n"), open: true });
  else if (prose.length) out.push({ kind: "md", text: prose.join("\n") });
  return out;
}
