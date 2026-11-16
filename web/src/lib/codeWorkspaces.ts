/** Jupyter Code Workspaces on RunPod (api/code_workspaces.py). */
import { API_URL } from "./api";

export type Compute = { kind: "gpu" | "cpu"; gpu_type: string; cloud: "SECURE" | "COMMUNITY"; vcpus: number; disk_gb: number };
/** kind: "table" (read_table / write_table) or "files" (a folder of files of any format: files(), upload_file) */
export type WorkspaceDataset = { alias: string; mode: "read" | "write"; item_id: string | null; name: string; folder_id?: string; kind?: "table" | "files"; dataset_kind?: string };
export type WorkspaceModel = { alias: string; model_id: string; name: string; adapter_file: string; adapter_class: string };
export type Pod = {
  id: string; status: "starting" | "running" | "stopped" | "terminated"; started_at: string; stopped_at?: string; cost_per_hr: number | null; gpu?: string | null;
  last_activity?: string | null; kernels?: number | null; checked_at?: string; compute?: Compute;
  /** "gce": a Compute Engine VM (Cloud CPU); absent / "runpod": a RunPod pod (Cloud CPU + GPU) */
  provider?: "runpod" | "gce"; zone?: string; machine_type?: string; spot?: boolean; ip?: string | null;
};
export type Workspace = {
  /** "jupyter" (JupyterLab), "vscode" (VS Code in the browser) or "nodered" (Node-RED) — the last two on the platform's machine */
  kind?: "jupyter" | EditorEngine;
  /** a Device stream's Node-RED: the pipeline it belongs to (its Files item is the pipeline file) */
  pipeline_id?: string | null;
  id: string; name: string; item_id: string; path: string[]; compute: Compute; idle_minutes: number; datasets: WorkspaceDataset[]; models: WorkspaceModel[];
  pod: Pod | null; jupyter_url: string | null; public_url: string; created_at: string; created_by: string; events: { at: string; by: string; text: string }[];
};
export type WorkspaceOptions = {
  gpu_types: string[]; image: string; configured: boolean; public_url: string;
  /** Cloud CPU runs on Google Compute Engine (GCP_COMPUTE_*), Cloud CPU + GPU on RunPod (RUNPOD_API_KEY) */
  cpu_configured?: boolean; gpu_configured?: boolean; cpu_provider?: "gce"; cpu_zone?: string | null;
};

/** Where a machine runs, for labels: "Google Cloud e2-standard-4 (Spot)", "RunPod NVIDIA RTX A4000". */
export function machineLabel(pod: Pod | null | undefined): string {
  if (!pod) return "";
  if (pod.provider === "gce") return `Google Cloud ${pod.machine_type ?? `${pod.compute?.vcpus ?? ""} vCPU`}${pod.spot ? " (Spot)" : ""}`;
  return `RunPod ${pod.gpu || pod.compute?.gpu_type || (pod.compute?.kind === "cpu" ? `${pod.compute.vcpus} vCPU` : "")}`.trim();
}
export const providerName = (pod: Pod | null | undefined) => (pod?.provider === "gce" ? "Google Cloud" : "RunPod");

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/code-workspaces" + path, {
    cache: "no-store",
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

export const codeWorkspaces = {
  options: () => req<WorkspaceOptions>("/options"),
  list: () => req<Workspace[]>(""),
  get: (id: string) => req<Workspace>(`/${id}`),
  byItem: (itemId: string) => req<Workspace>(`/by-item/${itemId}`),
  create: (body: { name: string; folder_id?: string; pipeline_id?: string; compute?: Compute; idle_minutes?: number; kind?: "jupyter" | EditorEngine }) =>
    req<Workspace>("", { method: "POST", json: body }),
  /** Replaces a running Node-RED's flows (and deploys them), through the editor relay. */
  noderedSetFlows: async (id: string, nodes: unknown[]) => {
    const res = await fetch(`${API_URL}/api/code-workspaces/${id}/nodered/flows`, {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(nodes),
      headers: { "content-type": "application/json", "Node-RED-API-Version": "v1", "Node-RED-Deployment-Type": "full" },
    });
    if (!res.ok) throw new Error(`Node-RED did not take the flow: ${(await res.text()).slice(0, 300) || res.statusText}`);
  },
  editor: (engine: EditorEngine, id: string) => req<VsCodeState>(`/${id}/${engine}-server`),
  editorStart: (engine: EditorEngine, id: string) => req<VsCodeState>(`/${id}/${engine}-server/start`, { method: "POST" }),
  editorStop: (engine: EditorEngine, id: string) => req<VsCodeState>(`/${id}/${engine}-server/stop`, { method: "POST" }),
  vscode: (id: string) => req<VsCodeState>(`/${id}/vscode-server`),
  vscodeStart: (id: string) => req<VsCodeState>(`/${id}/vscode-server/start`, { method: "POST" }),
  vscodeStop: (id: string) => req<VsCodeState>(`/${id}/vscode-server/stop`, { method: "POST" }),
  update: (id: string, body: { compute?: Compute; idle_minutes?: number }) => req<Workspace>(`/${id}`, { method: "PUT", json: body }),
  remove: (id: string) => req<{ deleted: string }>(`/${id}`, { method: "DELETE" }),
  start: (id: string) => req<Workspace>(`/${id}/start`, { method: "POST" }),
  stop: (id: string) => req<Workspace>(`/${id}/stop`, { method: "POST" }),
  terminate: (id: string) => req<Workspace>(`/${id}/terminate`, { method: "POST" }),
  addDataset: (id: string, body: { alias: string; item_id?: string; folder_id?: string; name?: string; kind?: "table" | "files" }) => req<Workspace>(`/${id}/datasets`, { method: "POST", json: body }),
  removeDataset: (id: string, alias: string) => req<Workspace>(`/${id}/datasets/${alias}`, { method: "DELETE" }),
  addModel: (id: string, body: { alias: string; model_id?: string; folder_id?: string; name?: string }) => req<Workspace>(`/${id}/models`, { method: "POST", json: body }),
  removeModel: (id: string, alias: string) => req<Workspace>(`/${id}/models/${alias}`, { method: "DELETE" }),
};

/** A VS Code workspace's editor (api/code_workspace_vscode.py): running on the platform's machine or stopped. */
export type VsCodeState = { status: "running" | "stopped"; port?: number | null; started_at?: string; stopped_at?: string; reachable?: boolean; heartbeat?: number; idle_minutes: number; can_run_code: boolean;
  /** JupyterLab (Docker): the image it runs and how its build went */
  image?: string; image_status?: "building" | "ready" | "failed"; image_error?: string };
/** where the page embeds the editor: relayed by the API under the platform's sign-in */
export const vscodeUrl = (id: string) => `${API_URL}/api/code-workspaces/${id}/vscode/?folder=/home/coder/project`;
/** the editors that run in a container on the platform's machine */
export type EditorEngine = "vscode" | "nodered" | "jupyterlab";
/** where the page embeds an editor; Node-RED gets the platform's theme (the relay styles its editor page); JupyterLab
 *  opens `open` (a file in the workspace) when given */
export const editorUrl = (engine: EditorEngine, id: string, theme: "dark" | "light", open?: string | null) =>
  engine === "vscode"
    ? vscodeUrl(id)
    : engine === "jupyterlab"
      ? `${API_URL}/api/code-workspaces/${id}/jupyterlab/lab${open ? `/tree/${open.split("/").map(encodeURIComponent).join("/")}` : ""}`
      : `${API_URL}/api/code-workspaces/${id}/nodered/?theme=${theme}`;
