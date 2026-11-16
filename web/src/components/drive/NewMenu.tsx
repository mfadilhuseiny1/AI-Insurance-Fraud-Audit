"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { carbon } from "@/lib/carbon";
import { codeRepos, type RepoTemplate } from "@/lib/codeRepos";
import { codeWorkbooks } from "@/lib/codeWorkbook";
import { codeWorkspaces } from "@/lib/codeWorkspaces";
import { containers } from "@/lib/containers";
import { contour } from "@/lib/contour";
import { widgetSets } from "@/lib/customWidgets";
import { datasetHref, datasetPreview } from "@/lib/datasetPreview";
import { promptDialog } from "@/lib/dialogs";
import { forms } from "@/lib/forms";
import { fusion } from "@/lib/fusion";
import { notepad } from "@/lib/notepad";
import { createPipelineFile } from "@/lib/pipelineFiles";
import { reports } from "@/lib/reports";
import { slate } from "@/lib/slate";
import { sd } from "@/lib/solutionDesigner";
import { wb } from "@/lib/workflowBuilder";
import { workshop } from "@/lib/workshop";

/* Files & Projects → New: every kind of resource the platform makes, searchable and grouped. A resource that lives in
   Files is created right in the open folder (asked for a name, then opened in its app); one that needs more choices
   (a trainer, an input dataset…) opens its app's own creation flow. */

type Ctx = { folderId: string; folderName: string; projectId: string | null };
type Entry = {
  label: string;
  icon: IconName;
  hint: string;
  group: string;
  /** needs an open folder (resources stored in Files) */
  inFolder?: boolean;
  /** asks a name, creates in the folder, returns where to open it */
  create?: (name: string, c: Ctx) => Promise<string>;
  /** the default name offered */
  placeholder?: string;
  /** opens the app's own creation flow */
  href?: string;
  /** a Drive-side action (folder, upload, web link…) */
  action?: () => void;
  /** runs code on the platform: only for accounts allowed to (Control Panel → Security → Code execution) */
  code?: boolean;
};

const GROUPS = ["Structure", "Data", "Analytics", "Applications", "Code & models", "Upload"];

export function NewMenu({
  folderId,
  folderName,
  projectId,
  atRoot,
  onClose,
  onProject,
  onProjectInSpace,
  onFolder,
  onMediaSet,
  onWebLink,
  onUploadFiles,
  onUploadFolder,
  onError,
  canRunCode = true,
}: {
  folderId: string | null;
  folderName: string;
  projectId: string | null;
  /** the top level of Files: only projects (and uploads) can go there */
  atRoot: boolean;
  onClose: () => void;
  onProject: () => void;
  onProjectInSpace: () => void;
  onFolder: () => void;
  onMediaSet: () => void;
  onWebLink: () => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onError: (e: unknown) => void;
  /** false: entries that run code are shown disabled, with why */
  canRunCode?: boolean;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const repo = (template: RepoTemplate) => async (name: string, c: Ctx) => `/code-repositories/${(await codeRepos.create(name, "", template, c.projectId)).id}`;
  const entries: Entry[] = useMemo(
    () => [
      ...(atRoot
        ? [
            { label: "Project", icon: "project", hint: "Group folders and files; roles apply to everything in it", group: "Structure", action: onProject },
            { label: "Project in a space…", icon: "layers", hint: "A space, a template, a portfolio, a classification", group: "Structure", action: onProjectInSpace },
          ] as Entry[]
        : []),
      { label: "Folder", icon: "folderPlus", hint: "An empty folder here", group: "Structure", inFolder: true, action: onFolder },
      { label: "Web link", icon: "link", hint: "A link to a web page, opened from Files", group: "Structure", inFolder: true, action: onWebLink },

      { label: "Dataset", icon: "table", hint: "Tabular data: drop CSV / Excel in; schema, history, Time Travel", group: "Data", inFolder: true,
        create: async (name, c) => datasetHref((await datasetPreview.create(c.folderId, name)).id), placeholder: "New dataset" },
      { label: "Media set", icon: "image", hint: "Images, documents, audio, video…", group: "Data", inFolder: true, action: onMediaSet },
      { label: "Pipeline", icon: "pipeline", hint: "Pipeline Builder: transform and join data visually (batch)", group: "Data", inFolder: true,
        create: async (name, c) => `/pipeline/${(await createPipelineFile(name, "batch", { id: c.folderId, name: c.folderName })).id}`, placeholder: "New pipeline" },
      { label: "Streaming pipeline", icon: "wave", hint: "Pipeline Builder on a stream, rows processed as they arrive", group: "Data", inFolder: true,
        create: async (name, c) => `/pipeline/${(await createPipelineFile(name, "streaming", { id: c.folderId, name: c.folderName })).id}`, placeholder: "New streaming pipeline" },
      { label: "Stream", icon: "signal", hint: "A real-time stream (push, Kafka, MQTT…) — in Streaming", group: "Data", href: "/streaming" },
      { label: "Iceberg table", icon: "database", hint: "An Apache Iceberg table with its columns — in Iceberg tables", group: "Data", href: "/iceberg" },
      { label: "Preparation", icon: "transform", hint: "Clean a dataset with column actions — pick the input dataset", group: "Data", href: "/preparation" },

      { label: "Analysis", icon: "graph", hint: "Contour: point-and-click analysis paths and dashboards", group: "Analytics", inFolder: true,
        create: async (name, c) => `/analytics/${(await contour.create(name, undefined, c.folderId)).item.id}`, placeholder: "New analysis" },
      { label: "Code Workbook", icon: "code", hint: "Python, SQL and R transforms in a notebook-like graph", group: "Analytics", inFolder: true, code: true,
        create: async (name, c) => `/code-workbook/workbooks/${(await codeWorkbooks.create(name, [], c.folderId)).item.id}`, placeholder: "New code workbook" },
      { label: "Fusion Sheet", icon: "grid", hint: "A spreadsheet with formulas over live datasets", group: "Analytics", inFolder: true,
        create: async (name, c) => `/fusion/${(await fusion.create(name, c.folderId)).item.id}`, placeholder: "New sheet" },
      { label: "Notepad", icon: "doc", hint: "A document with live charts, tables and objects", group: "Analytics", inFolder: true,
        create: async (name, c) => `/notepad/${encodeURIComponent((await notepad.create({ name, parent_id: c.folderId, document: { schema_version: 1, blocks: [] } })).item.id)}`, placeholder: "New notepad" },
      { label: "Quiver analysis", icon: "wave", hint: "Time series and object analysis with cards — in Quiver", group: "Analytics", href: "/quiver" },
      { label: "Report", icon: "list", hint: "A report of text, charts and tables, shared as a page or PDF", group: "Analytics", inFolder: true,
        create: async (name, c) => `/reports/${(await reports.create(name, c.folderId)).item.id}?edit=1`, placeholder: "New report" },
      { label: "Graph", icon: "split", hint: "Vertex: a graph of Nexus objects and their links", group: "Analytics", href: "/vertex" },
      { label: "Map", icon: "globe", hint: "Layers of objects, datasets and imagery on a map", group: "Analytics", href: "/map" },

      { label: "Module", icon: "device", hint: "Workshop: an operational app on the Nexus", group: "Applications", inFolder: true,
        create: async (name, c) => `/workshop/${(await workshop.create({ name, folder_id: c.folderId } as Parameters<typeof workshop.create>[0])).id}?edit=1`, placeholder: "New module" },
      { label: "Application", icon: "palette", hint: "Slate: a custom web application (HTML, widgets, queries)", group: "Applications", inFolder: true,
        create: async (name, c) => `/slate/${(await slate.create({ name, folder_id: c.folderId, type: "integrated" })).app.id}?edit=1`, placeholder: "New application" },
      { label: "Form", icon: "edit", hint: "A form whose answers become a dataset or Nexus edits", group: "Applications", inFolder: true,
        create: async (name, c) => `/forms/${(await forms.create(name, c.folderId)).item.id}`, placeholder: "New form" },
      { label: "Carbon workspace", icon: "home", hint: "A curated workspace of modules for operational users", group: "Applications", inFolder: true,
        create: async (name, c) => `/carbon/${(await carbon.create({ title: name, folder_id: c.folderId })).id}?edit=1`, placeholder: "New workspace" },
      { label: "Widget set", icon: "grid", hint: "Custom widgets (HTML, CSS, JavaScript) for Workshop", group: "Applications", inFolder: true,
        create: async (name, c) => `/custom-widgets?id=${(await widgetSets.create({ name, folder_id: c.folderId })).id}`, placeholder: "New widget set" },
      { label: "Workflow", icon: "logic", hint: "Workflow Builder: a process across apps, actions and automations", group: "Applications", inFolder: true,
        create: async (name, c) => `/workflow-builder/${(await wb.create(name, c.folderId)).id}`, placeholder: "New workflow" },
      { label: "Solution diagram", icon: "layers", hint: "Solution Designer: an architecture diagram with AIP Architect", group: "Applications", inFolder: true,
        create: async (name, c) => `/solution-designer/${(await sd.create({ name, folder_id: c.folderId })).id}`, placeholder: "New diagram" },

      { label: "Repository", icon: "code", hint: "Code Repositories: Python transforms (in this folder's project)", group: "Code & models", inFolder: true, code: true, create: repo("python"), placeholder: "new-repository" },
      { label: "Model Training repository", icon: "cpu", hint: "Code Repositories: train and evaluate a model (MLflow), benchmark candidates", group: "Code & models", inFolder: true, code: true,
        create: repo("model-training"), placeholder: "model-training" },
      { label: "Jupyter workspace", icon: "code", hint: "JupyterLab notebooks on Local CPU, Cloud CPU or GPU", group: "Code & models", inFolder: true, code: true,
        create: async (name, c) => {
          await codeWorkspaces.create({ name, folder_id: c.folderId, compute: { kind: "cpu", gpu_type: "NVIDIA RTX A4000", cloud: "SECURE", vcpus: 4, disk_gb: 20 }, idle_minutes: 3 });
          return "/code-workspaces";
        },
        placeholder: "New notebook workspace" },
      { label: "Model Studio", icon: "cpu", hint: "No-code training: pick algorithms and their settings", group: "Code & models", href: "/model-studio?new=1" },
      { label: "Modeling Objective", icon: "split", hint: "Benchmark models, review, release and deploy", group: "Code & models", href: "/modeling-objectives?new=1" },
      { label: "Artifact repository", icon: "server", hint: "Conda, PyPI, Maven and Docker artifacts", group: "Code & models", inFolder: true,
        create: async (name, c) => `/artifact-repositories?repo=${(await containers.create({ name, folder_id: c.folderId })).id}&tab=publish`, placeholder: "shared-libraries" },
      { label: "SQL worksheet", icon: "database", hint: "SQL Studio: query datasets and tables", group: "Code & models", href: "/sql-studio" },
      { label: "Cipher channel", icon: "lock", hint: "Encrypt, decrypt and hash sensitive columns", group: "Code & models", href: "/cipher" },

      { label: "Upload files…", icon: "upload", hint: atRoot ? "Into the top level" : "Into this folder", group: "Upload", action: onUploadFiles },
      { label: "Upload folder…", icon: "folderUp", hint: "Keeps its subfolders", group: "Upload", action: onUploadFolder },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atRoot],
  );

  const run = async (e: Entry) => {
    if (e.action) {
      onClose();
      return e.action();
    }
    if (e.href) {
      onClose();
      return router.push(e.href);
    }
    if (!e.create || !folderId) return;
    const name = await promptDialog(`Name of the ${e.label.toLowerCase()}`, "", { title: `New ${e.label.toLowerCase()} in ${folderName}`, placeholder: e.placeholder });
    if (!name?.trim()) return;
    setBusy(e.label);
    try {
      const href = await e.create(name.trim(), { folderId, folderName, projectId });
      onClose();
      router.push(href);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const term = q.trim().toLowerCase();
  const shown = entries.filter((e) => !term || `${e.label} ${e.hint}`.toLowerCase().includes(term));
  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute left-0 top-full z-40 mt-1 flex max-h-[min(70vh,640px)] w-80 flex-col overflow-hidden rounded-xl border border-line-2 bg-panel-2 text-left shadow-2xl"
    >
      <div className="border-b border-line p-2">
        <div className="flex items-center gap-2 rounded-md border border-line bg-ink px-2">
          <Icon name="search" className="h-3.5 w-3.5 text-muted" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what to create…" className="w-full bg-transparent py-1.5 text-sm outline-none" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {GROUPS.map((g) => {
          const list = shown.filter((e) => e.group === g);
          if (!list.length) return null;
          return (
            <div key={g} className="py-1">
              <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{g}</div>
              {list.map((e) => {
                const noCode = e.code && !canRunCode;
                const blocked = (e.inFolder && !folderId) || noCode;
                return (
                  <button
                    key={e.label}
                    type="button"
                    disabled={blocked || !!busy}
                    title={noCode ? "Running code is limited to administrators and the allowed groups (Control Panel → Security → Code execution)" : blocked ? "Open a project or folder first" : e.hint}
                    onClick={() => run(e)}
                    className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-ocean/15 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon name={busy === e.label ? "refresh" : e.icon} className={`mt-0.5 h-4 w-4 shrink-0 text-ocean ${busy === e.label ? "animate-spin" : ""}`} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-white">
                        {e.label}
                        {e.href && <Icon name="external" className="h-3 w-3 text-muted" />}
                      </span>
                      <span className="block truncate text-[11px] text-muted">{noCode ? "Needs code execution rights (ask an administrator)" : e.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {!shown.length && <p className="px-3 py-4 text-xs text-muted">Nothing matches “{q}”.</p>}
      </div>
      {!folderId && <div className="border-t border-line px-3 py-2 text-[11px] text-muted">Open a project or folder to create resources in it.</div>}
    </div>
  );
}
