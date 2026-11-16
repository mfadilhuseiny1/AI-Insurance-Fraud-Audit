"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { LocationField, missingText, type PickedLocation } from "@/components/LocationField";
import { Icon } from "@/components/Icon";
import { Lab } from "@/components/jupyter/Lab";
import { EditorWorkspace } from "@/components/code/VsCodeWorkspace";
import { AppHome } from "@/components/AppHome";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { codeWorkspaces, providerName, type Compute, type Workspace, type WorkspaceOptions } from "@/lib/codeWorkspaces";

/** Jupyter Code Workspaces (palantir.com/docs/foundry/code-workspaces): a JupyterLab in the page (components/jupyter)
 *  whose kernels run on the platform's machine (Local CPU), a Compute Engine VM (Cloud CPU) or a RunPod pod (Cloud CPU + GPU), with
 *  dataset and model aliases; notebooks read and write datasets and publish model versions to the platform.
 *  api/code_workspaces.py, api/code_workspace_lab.py */
export default function CodeWorkspacesPage() {
  return (
    <Suspense fallback={null}>
      <Workspaces />
    </Suspense>
  );
}

const TONE: Record<string, "ok" | "warn" | "muted"> = { running: "ok", starting: "warn", stopped: "muted", terminated: "muted" };

function Workspaces() {
  const router = useRouter();
  const params = useSearchParams();
  const [list, setList] = useState<Workspace[] | null>(null);
  const [options, setOptions] = useState<WorkspaceOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?new opens the dialog; ?new=vscode (Platform Apps → VS Code) with VS Code chosen
  const [creating, setCreating] = useState<null | "jupyter" | "vscode" | "nodered">(() => {
    const n = params.get("new");
    return n === null || n === "nodered" ? null : n === "vscode" ? n : "jupyter";
  });
  // Node-RED flows are Device stream pipelines (one kind of Node-RED): older links go there
  useEffect(() => {
    if (params.get("new") === "nodered") router.replace("/pipeline?new=device");
  }, [params, router]);
  const item = params.get("item");
  const id = params.get("id");
  const load = useCallback(() => { codeWorkspaces.list().then(setList, (e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  useEffect(() => { codeWorkspaces.options().then(setOptions, () => {}); }, []);
  useEffect(() => { if (item) codeWorkspaces.byItem(item).then((w) => router.replace(`/code-workspaces?id=${w.id}`), () => {}); }, [item, router]);
  if (id) return <LabPage key={`${id}:${params.get("editor") ?? ""}`} id={id} options={options} open={params.get("open")} editor={params.get("editor")} />;
  const running = list?.filter((w) => w.pod?.status === "running").length ?? 0;
  return (
    <>
      <AppHome
        app="Code Workspaces"
        icon="code"
        accent="#d946ef"
        href="/code-workspaces"
        tagline="JupyterLab connected to your datasets and models, on Local CPU, Cloud CPU or GPU — or VS Code in the browser."
        description={
          <>
            A workspace is a JupyterLab with its own notebooks and files, connected to your datasets and models. Each notebook runs on Local CPU, Cloud CPU or Cloud CPU + GPU (RunPod)
            {options && !options.configured ? " — RUNPOD_API_KEY is not set on the API, so only Local CPU is available" : ""}.
          </>
        }
        headerActions={
          <Link href="/model-assets" className={buttonClass.ghost}>
            <Icon name="cube" className="h-3.5 w-3.5" /> Models
          </Link>
        }
        noun={["workspace", "workspaces"]}
        items={
          list?.map((w) => ({
            id: w.id,
            href: w.pipeline_id ? `/pipeline/${w.pipeline_id}` : `/code-workspaces?id=${w.id}`,
            title: w.name,
            path: w.path,
            updated_at: w.created_at,
            icon: w.kind === "vscode" ? ("keyboard" as const) : w.kind === "nodered" ? ("signal" as const) : undefined,
            badges: w.kind === "vscode"
              ? [{ label: "VS Code", tone: "ocean" as const }]
              : w.kind === "nodered"
              ? [{ label: w.pipeline_id ? "Node-RED · Device stream" : "Node-RED", tone: "bad" as const }]
              : [w.pod ? { label: `${providerName(w.pod)} ${w.pod.status}`, tone: TONE[w.pod.status] ?? ("muted" as const) } : { label: "Local CPU ready", tone: "ok" as const }],
          })) ?? null
        }
        stats={
          list
            ? [
                { label: "Workspaces", value: list.length.toLocaleString() },
                { label: "Cloud running", value: running.toLocaleString() },
                { label: "Projects", value: new Set(list.map((w) => w.path[0]).filter(Boolean)).size.toLocaleString() },
              ]
            : undefined
        }
        error={error}
        empty={{
          title: "Open your first JupyterLab",
          hint: "Create a workspace to open JupyterLab with your datasets and models.",
          steps: ["Name it and choose a folder", "Add dataset and model aliases", "Pick Local CPU, Cloud CPU or GPU per notebook"],
        }}
        create={
          <>
            <button type="button" onClick={() => setCreating("jupyter")} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New Jupyter workspace
            </button>
            <button type="button" onClick={() => setCreating("vscode")} className={buttonClass.secondary} data-new-vscode>
              <Icon name="keyboard" className="h-3.5 w-3.5" /> New VS Code workspace
            </button>
            <Link href="/pipeline?new=device" className={buttonClass.secondary} data-new-nodered title="A Node-RED flow is a Device stream pipeline">
              <Icon name="signal" className="h-3.5 w-3.5" /> New Node-RED flow
            </Link>
          </>
        }
      />
      {creating && options && <Create kind={creating} options={options} onClose={() => setCreating(null)} onCreated={(w) => { setCreating(null); load(); router.replace(`/code-workspaces?id=${w.id}`); }} />}
    </>
  );
}

// editor "lab": a JupyterLab (Docker) workspace's files in the platform's own notebook editor instead, kernels on this
// machine (Local CPU by default): no container needed to read, edit or run its notebooks
function LabPage({ id, options, open, editor }: { id: string; options: WorkspaceOptions | null; open: string | null; editor: string | null }) {
  const [w, setW] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { codeWorkspaces.get(id).then(setW, (e: Error) => setErr(e.message)); }, [id]);
  if (err) return <ApiError message={err} />;
  if (!w) return <Loading />;
  if (w.kind === "jupyterlab" && editor === "lab") return <Lab workspace={w} options={options} openPath={open} />;
  if (w.kind === "vscode" || w.kind === "nodered" || w.kind === "jupyterlab") return <EditorWorkspace workspace={w} engine={w.kind} open={open} />;
  return <Lab workspace={w} options={options} openPath={open} />;
}

function Create({ kind, options, onClose, onCreated }: { kind: "jupyter" | "vscode" | "nodered"; options: WorkspaceOptions; onClose: () => void; onCreated: (w: Workspace) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [compute, setCompute] = useState<Compute>({ kind: "gpu", gpu_type: options.gpu_types[0], cloud: "SECURE", vcpus: 4, disk_gb: 20 });
  const [idle, setIdle] = useState(kind === "vscode" ? 30 : 3);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a location"])];
  const create = async () => {
    setTried(true);
    if (missing.length || !folder) return;
    setBusy(true);
    setErr(null);
    try {
      onCreated(
        await codeWorkspaces.create(
          kind === "vscode" ? { name, folder_id: folder.id, idle_minutes: idle, kind } : kind === "nodered" ? { name, folder_id: folder.id, kind } : { name, folder_id: folder.id, compute, idle_minutes: idle },
        ),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const nameInvalid = tried && !name.trim();
  return (
    <Modal title={kind === "vscode" ? "New VS Code workspace" : kind === "nodered" ? "New Node-RED workspace" : "New Jupyter workspace"} icon={kind === "vscode" ? "keyboard" : kind === "nodered" ? "signal" : "code"} onClose={onClose}>
      <form className="space-y-4 p-5 text-sm" onSubmit={(e) => (e.preventDefault(), void create())} data-new-vscode-dialog={kind === "vscode" ? "" : undefined}>
        <label className="block">
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Name <span className="text-bad" aria-hidden>*</span></span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "vscode" ? "e.g. Audit scripts" : kind === "nodered" ? "e.g. Factory sensors" : "e.g. Anomaly model training"} aria-invalid={nameInvalid}
            className={`${inputClass} ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give the workspace a name.</span>}
        </label>
        <LocationField value={folder} onChange={setFolder} invalid={tried} hint="The Project or folder the workspace is saved in; it gets that Project's access." />
        {kind === "vscode" ? (
          <>
            <label className="block text-xs text-muted">Stop when idle for (minutes)<input type="number" min={1} max={720} value={idle} onChange={(e) => setIdle(Number(e.target.value))} className={`${inputClass} mt-1`} /></label>
            <p className="text-[11px] text-muted">VS Code runs on the platform&apos;s machine (2 CPUs, up to 4 GB of memory) only while you use it: nothing runs until you press Start, and it stops after the idle minutes. Files and VS Code settings are kept.</p>
          </>
        ) : kind === "nodered" ? (
          <p className="text-[11px] text-muted">Node-RED (the official node-red/node-red) runs on the platform&apos;s machine (1 CPU, up to 1 GB of memory) from Start until Stop, so your flows keep running. Add nodes from Menu → Manage palette (node-red-contrib plugins such as InfluxDB, MQTT or Modbus). Flows, credentials and installed nodes are kept; it follows the platform&apos;s light or dark theme.</p>
        ) : (
          <>
            <p className="text-xs text-muted">Each notebook chooses where it runs (Local CPU, Cloud CPU or Cloud CPU + GPU) from its toolbar. For the cloud machine:</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">Disk for /workspace (GB)<input type="number" min={5} max={500} value={compute.disk_gb} onChange={(e) => setCompute({ ...compute, disk_gb: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label>
              <label className="text-xs text-muted">Stop when idle for (minutes)<input type="number" min={1} max={720} value={idle} onChange={(e) => setIdle(Number(e.target.value))} className={`${inputClass} mt-1`} /></label>
              <label className="text-xs text-muted">Machine tier
                <select value={compute.cloud} onChange={(e) => setCompute({ ...compute, cloud: e.target.value as "SECURE" | "COMMUNITY" })} className={`${inputClass} mt-1`}><option value="SECURE">Standard (on-demand VM / RunPod Secure Cloud)</option><option value="COMMUNITY">Cheaper (Google Spot VM / RunPod Community Cloud)</option></select>
              </label>
            </div>
            <p className="text-[11px] text-muted">Nothing is rented until a notebook selects Cloud CPU or Cloud CPU + GPU. Cloud CPU bills on your Google Cloud project, Cloud CPU + GPU on your RunPod account while it runs.</p>
          </>
        )}
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-3">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
          <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}
