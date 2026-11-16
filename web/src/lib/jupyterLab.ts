/** The notebook editor of a Jupyter Code Workspace: its files and kernels (api/code_workspace_lab.py). */
import { API_URL } from "./api";

export type Entry = { name: string; path: string; type: "directory" | "notebook" | "file"; size: number | null; last_modified: string };
export type DirModel = Entry & { type: "directory"; content: Entry[] };
export type FileModel = Entry & { content: unknown; format?: "text" | "binary" };

export type MimeBundle = Record<string, unknown>;
export type Output =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | { output_type: "display_data"; data: MimeBundle; metadata: Record<string, unknown>; transient?: { display_id?: string } }
  | { output_type: "execute_result"; data: MimeBundle; metadata: Record<string, unknown>; execution_count: number | null }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] };
export type Cell = {
  id: string;
  cell_type: "code" | "markdown" | "raw";
  source: string;
  metadata: Record<string, unknown>;
  outputs?: Output[];
  execution_count?: number | null;
  attachments?: Record<string, MimeBundle>;
};
export type NotebookJSON = { cells: Cell[]; metadata: Record<string, unknown>; nbformat: number; nbformat_minor: number };

/** "local" runs on the platform's machine; "cloud" on the workspace's RunPod pod (CPU, or CPU + GPU). */
export type Target = "local" | "cloud";
export type KernelInfo = {
  id: string; path: string; target: "local" | "cloud-cpu" | "cloud-gpu"; state: string; execution_count: number; started_at: string;
  error: string | null; name: string; display_name: string;
};
export type Checkpoint = { id: string; at: string; kind: "save" | "auto" | "original" | "before-restore" | "before-upload" | "before-delete"; size: number; by?: string };
export type Diff = { binary: boolean; lines: string[]; added: number; removed: number; truncated?: boolean };
export type GitChange = { path: string; status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict" };
export type GitStatus = { branch: string; branches: string[]; has_commits: boolean; changes: GitChange[] };
export type GitCommit = { sha: string; short: string; author: string; at: string; message: string };
export type Package = { name: string; version: string; installed?: string | null; base?: string | null };
export type PypiProject = { name: string; summary: string; latest: string | null; versions: string[]; home?: string | null; base?: string | null };
export type TerminalInfo = { id: string; target: "local" | "cloud"; created_at: string; name: string };
export type KernelMsg = { channel?: string; msg_type: string; content: Record<string, unknown>; metadata?: Record<string, unknown> };

async function req<T>(wid: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${API_URL}/api/code-workspaces/${wid}/lab${path}`, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const d = (await res.json()).detail;
      message = typeof d === "string" ? d : JSON.stringify(d);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

const q = (path: string) => `?path=${encodeURIComponent(path)}`;

/** nbformat stores multiline strings as either a string or a list of lines. */
export const joinSource = (s: unknown): string => (Array.isArray(s) ? s.join("") : typeof s === "string" ? s : "");

export function normalizeNotebook(raw: unknown): NotebookJSON {
  const nb = (raw ?? {}) as Partial<NotebookJSON> & { cells?: Record<string, unknown>[] };
  const cells: Cell[] = (nb.cells ?? []).map((c) => {
    const type = (c.cell_type as Cell["cell_type"]) ?? "code";
    const cell: Cell = { id: (c.id as string) || newId(), cell_type: type, source: joinSource(c.source), metadata: (c.metadata as Record<string, unknown>) ?? {} };
    if (type === "code") {
      cell.execution_count = (c.execution_count as number | null) ?? null;
      cell.outputs = ((c.outputs as Record<string, unknown>[]) ?? []).map(normalizeOutput);
    }
    if (c.attachments) cell.attachments = c.attachments as Record<string, MimeBundle>;
    return cell;
  });
  return { cells: cells.length ? cells : [emptyCell("code")], metadata: nb.metadata ?? {}, nbformat: 4, nbformat_minor: Math.max(5, nb.nbformat_minor ?? 5) };
}

function normalizeBundle(d: unknown): MimeBundle {
  const out: MimeBundle = {};
  for (const [k, v] of Object.entries((d ?? {}) as Record<string, unknown>)) out[k] = k.includes("json") ? v : joinSource(v);
  return out;
}

export function normalizeOutput(o: Record<string, unknown>): Output {
  switch (o.output_type) {
    case "stream":
      return { output_type: "stream", name: (o.name as "stdout") ?? "stdout", text: joinSource(o.text) };
    case "error":
      return { output_type: "error", ename: String(o.ename ?? ""), evalue: String(o.evalue ?? ""), traceback: (o.traceback as string[]) ?? [] };
    case "execute_result":
      return { output_type: "execute_result", data: normalizeBundle(o.data), metadata: (o.metadata as Record<string, unknown>) ?? {}, execution_count: (o.execution_count as number) ?? null };
    default:
      return { output_type: "display_data", data: normalizeBundle(o.data), metadata: (o.metadata as Record<string, unknown>) ?? {} };
  }
}

export const newId = () => Math.random().toString(16).slice(2, 10);
export const emptyCell = (cell_type: Cell["cell_type"], source = ""): Cell =>
  cell_type === "code" ? { id: newId(), cell_type, source, metadata: {}, outputs: [], execution_count: null } : { id: newId(), cell_type, source, metadata: {} };

/** What is written to disk: nbformat 4.5 (sources as lists of lines, like Jupyter writes them). */
export function serializeNotebook(nb: NotebookJSON): NotebookJSON {
  const lines = (s: string) => (s ? s.split(/(?<=\n)/) : []);
  const bundle = (d: MimeBundle) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "string" && !k.includes("json") ? lines(v) : v]));
  return {
    ...nb,
    nbformat: 4,
    nbformat_minor: 5,
    cells: nb.cells.map((c) => {
      const base: Record<string, unknown> = { cell_type: c.cell_type, id: c.id, metadata: c.metadata, source: lines(c.source) };
      if (c.attachments) base.attachments = c.attachments;
      if (c.cell_type === "code") {
        base.execution_count = c.execution_count ?? null;
        base.outputs = (c.outputs ?? []).map((o) => {
          if (o.output_type === "stream") return { ...o, text: lines(o.text) };
          if (o.output_type === "error") return o;
          const { transient: _t, ...rest } = o as Output & { transient?: unknown };
          void _t;
          return { ...rest, data: bundle(o.data) };
        });
      }
      return base as unknown as Cell;
    }),
  };
}

export const lab = {
  dir: (wid: string, path = "") => req<DirModel>(wid, `/contents${q(path)}`),
  get: (wid: string, path: string) => req<FileModel>(wid, `/contents${q(path)}`),
  /** checkpoint: an explicit save (Ctrl+S, the Save button) always keeps a checkpoint; autosaves one every few minutes */
  save: (wid: string, path: string, type: "notebook" | "file", content: unknown, checkpoint = false) =>
    req<Entry>(wid, "/contents", { method: "PUT", json: { path, type, content, checkpoint } }),
  mkdir: (wid: string, path: string) => req<Entry>(wid, "/contents", { method: "PUT", json: { path, type: "directory" } }),
  create: (wid: string, path: string, type: "notebook" | "file" | "directory", ext?: string) =>
    req<Entry>(wid, "/contents/new", { method: "POST", json: { path, type, ...(ext ? { ext } : {}) } }),
  rename: (wid: string, path: string, new_path: string) => req<Entry>(wid, "/contents/rename", { method: "POST", json: { path, new_path } }),
  duplicate: (wid: string, path: string, folder: string) => req<Entry>(wid, "/contents/copy", { method: "POST", json: { path, new_path: folder } }),
  remove: (wid: string, path: string) => req<{ deleted: string }>(wid, `/contents${q(path)}`, { method: "DELETE" }),
  upload: (wid: string, path: string, file: Blob) => req<Entry>(wid, `/contents/raw${q(path)}`, { method: "PUT", body: file }),
  downloadUrl: (wid: string, path: string) => `${API_URL}/api/code-workspaces/${wid}/lab/contents/raw${q(path)}`,

  checkpoints: (wid: string, path: string) => req<Checkpoint[]>(wid, `/checkpoints${q(path)}`),
  checkpointDiff: (wid: string, path: string, id: string) => req<{ path: string; diff: Diff }>(wid, `/checkpoints-diff/${id}${q(path)}`),
  restoreCheckpoint: (wid: string, path: string, id: string) => req<{ restored: string }>(wid, `/checkpoints/${id}/restore${q(path)}`, { method: "POST" }),

  gitStatus: (wid: string) => req<GitStatus>(wid, "/git/status"),
  gitCommit: (wid: string, message: string, paths?: string[]) => req<GitCommit>(wid, "/git/commit", { method: "POST", json: { message, ...(paths ? { paths } : {}) } }),
  gitLog: (wid: string, path?: string) => req<GitCommit[]>(wid, `/git/log${path ? q(path) : ""}`),
  gitCommitFiles: (wid: string, sha: string) => req<{ sha: string; author: string; at: string; message: string; files: { status: string; path: string }[] }>(wid, `/git/commits/${sha}`),
  gitDiff: (wid: string, path: string, sha?: string) => req<{ path: string; diff: Diff }>(wid, `/git/diff${q(path)}${sha ? `&sha=${sha}` : ""}`),
  gitRestore: (wid: string, path: string, sha = "HEAD") => req<{ path: string; deleted?: boolean }>(wid, "/git/restore", { method: "POST", json: { path, sha } }),
  gitCheckout: (wid: string, name: string, create = false) => req<GitStatus>(wid, "/git/checkout", { method: "POST", json: { name, create } }),

  packages: (wid: string) => req<{ packages: Package[]; manager: string; uv: boolean }>(wid, "/packages"),
  searchPackage: (wid: string, q: string) => req<PypiProject>(wid, `/packages/search?q=${encodeURIComponent(q)}`),
  addPackage: (wid: string, name: string, version = "") => req<{ installed: string; log: string; cloud_kernels: number }>(wid, "/packages", { method: "POST", json: { name, version } }),
  removePackage: (wid: string, name: string) => req<{ removed: string }>(wid, `/packages/${encodeURIComponent(name)}`, { method: "DELETE" }),
  syncPackages: (wid: string) => req<{ installed: string[]; log: string }>(wid, "/packages/sync", { method: "POST" }),
  lockfile: (wid: string) => req<{ lock: string; spec: string[] }>(wid, "/packages/lock"),

  terminals: (wid: string) => req<TerminalInfo[]>(wid, "/terminals"),
  newTerminal: (wid: string, target: Target) => req<TerminalInfo>(wid, "/terminals", { method: "POST", json: { target } }),
  shutdownTerminal: (wid: string, tid: string) => req<{ shutdown: string }>(wid, `/terminals/${tid}`, { method: "DELETE" }),

  kernels: (wid: string) => req<KernelInfo[]>(wid, "/kernels"),
  startKernel: (wid: string, path: string, target: Target) => req<KernelInfo>(wid, "/kernels", { method: "POST", json: { path, target } }),
  kernel: (wid: string, kid: string) => req<KernelInfo>(wid, `/kernels/${kid}`),
  interrupt: (wid: string, kid: string) => req<KernelInfo>(wid, `/kernels/${kid}/interrupt`, { method: "POST" }),
  restart: (wid: string, kid: string) => req<KernelInfo>(wid, `/kernels/${kid}/restart`, { method: "POST" }),
  shutdown: (wid: string, kid: string) => req<{ shutdown: string }>(wid, `/kernels/${kid}`, { method: "DELETE" }),
  input: (wid: string, kid: string, value: string) => req<{ ok: boolean }>(wid, `/kernels/${kid}/input`, { method: "POST", json: { value } }),
  complete: (wid: string, kid: string, code: string, cursor_pos: number) =>
    req<{ status: string; matches?: string[]; cursor_start?: number; cursor_end?: number }>(wid, `/kernels/${kid}/complete`, { method: "POST", json: { code, cursor_pos } }),
  inspect: (wid: string, kid: string, code: string, cursor_pos: number) =>
    req<{ status: string; found?: boolean; data?: MimeBundle }>(wid, `/kernels/${kid}/inspect`, { method: "POST", json: { code, cursor_pos } }),

  /** Run code: onMsg gets each of the kernel's messages for it; resolves with the execute_reply's content. */
  async execute(wid: string, kid: string, code: string, onMsg: (m: KernelMsg) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await fetch(`${API_URL}/api/code-workspaces/${wid}/lab/kernels/${kid}/execute`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }), signal,
    });
    if (!res.ok || !res.body) {
      let message = res.statusText;
      try {
        const d = (await res.json()).detail;
        message = typeof d === "string" ? d : JSON.stringify(d);
      } catch {}
      throw new Error(message);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let reply: Record<string, unknown> = { status: "aborted" };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as KernelMsg;
        if (m.msg_type === "execute_reply") reply = m.content;
        if (m.msg_type === "kernel_dead") reply = { status: "dead", reason: m.content.reason };
        onMsg(m);
      }
    }
    return reply;
  },
};
