"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { codeWorkspaces, machineLabel, type Workspace, type WorkspaceDataset, type WorkspaceOptions } from "@/lib/codeWorkspaces";
import { datasetHref } from "@/lib/datasetPreview";
import { when } from "@/lib/format";
import { lab, type Entry, type KernelInfo, type TerminalInfo } from "@/lib/jupyterLab";
import { modelAssets, type ModelAsset } from "@/lib/modelAssets";
import { fileIcon, JpIcon } from "./icons";
import type { Heading } from "./Notebook";
import { Menu, relTime, useDialogs, type MenuItem } from "./ui";

// ------------------------------------------------------------------------------------------------ file browser

export function FileBrowser({ wid, cwd, setCwd, onOpen, onNewLauncher, running, refresh, onChanged, onRenamed, onDeleted }: {
  wid: string; cwd: string; setCwd: (p: string) => void; onOpen: (e: Entry) => void; onNewLauncher: () => void; running: Set<string>;
  refresh: number; onChanged: () => void; onRenamed: (from: string, to: string) => void; onDeleted: (path: string) => void;
}) {
  const dialogs = useDialogs();
  const [items, setItems] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: "name" | "modified"; asc: boolean }>({ key: "name", asc: true });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const load = useCallback(() => {
    lab.dir(wid, cwd).then(
      (d) => {
        setItems(d.content);
        setErr(null);
      },
      (e: Error) => setErr(e.message),
    );
  }, [wid, cwd]);
  useEffect(load, [load, refresh]);
  useEffect(() => {
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    const xs = (items ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
    return xs.sort((a, b) => {
      if ((a.type === "directory") !== (b.type === "directory")) return a.type === "directory" ? -1 : 1;
      const r = sort.key === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.last_modified.localeCompare(b.last_modified);
      return sort.asc ? r : -r;
    });
  }, [items, filter, sort]);

  const create = async (type: "notebook" | "file" | "directory", ext?: string) => {
    try {
      const e = await lab.create(wid, cwd, type, ext);
      load();
      onChanged();
      if (type === "directory") setRenaming(e.path);
      else onOpen(e);
    } catch (e) {
      void dialogs.alert("Could not create", (e as Error).message);
    }
  };
  const uploadFiles = async (files: FileList | File[], dir = cwd) => {
    for (const f of Array.from(files)) {
      const target = dir ? `${dir}/${f.name}` : f.name;
      if (items?.some((e) => e.path === target) && !(await dialogs.confirm("File Overwrite?", `"${f.name}" already exists. Overwrite it?`, "Overwrite", true))) continue;
      try {
        await lab.upload(wid, target, f);
      } catch (e) {
        void dialogs.alert("Upload Error", (e as Error).message);
      }
    }
    load();
    onChanged();
  };
  const rename = async (e: Entry, name: string) => {
    setRenaming(null);
    if (!name || name === e.name) return;
    if (name.includes("/")) return void dialogs.alert("Rename Error", "A name cannot contain “/”.");
    const to = e.path.includes("/") ? `${e.path.slice(0, e.path.lastIndexOf("/"))}/${name}` : name;
    try {
      await lab.rename(wid, e.path, to);
      onRenamed(e.path, to);
      load();
    } catch (err) {
      void dialogs.alert("Rename Error", (err as Error).message);
    }
  };
  const remove = async (paths: string[]) => {
    const what = paths.length === 1 ? `"${paths[0].split("/").pop()}"` : `${paths.length} items`;
    if (!(await dialogs.confirm(paths.length === 1 ? (items?.find((e) => e.path === paths[0])?.type === "directory" ? "Delete directory" : "Delete file") : "Delete", `Are you sure you want to permanently delete: ${what}?`, "Delete", true))) return;
    for (const p of paths) {
      try {
        await lab.remove(wid, p);
        onDeleted(p);
      } catch (err) {
        void dialogs.alert("Delete Error", (err as Error).message);
      }
    }
    setSelected(new Set());
    load();
    onChanged();
  };
  const crumbs = cwd ? cwd.split("/") : [];
  function pickFiles() {
    upload.current?.click();
  }

  const menuItems = (entry: Entry | null): MenuItem[] =>
    entry
      ? [
          { label: "Open", onClick: () => (entry.type === "directory" ? setCwd(entry.path) : onOpen(entry)) },
          "-",
          { label: "Rename", shortcut: "F2", onClick: () => setRenaming(entry.path) },
          { label: "Delete", shortcut: "Del", onClick: () => void remove(selected.has(entry.path) ? [...selected] : [entry.path]) },
          { label: "Duplicate", hidden: entry.type === "directory", onClick: () => void lab.duplicate(wid, entry.path, cwd).then(load, (e: Error) => dialogs.alert("Duplicate Error", e.message)) },
          { label: "Download", hidden: entry.type === "directory", onClick: () => window.open(lab.downloadUrl(wid, entry.path), "_blank") },
          "-",
          { label: "Copy Path", onClick: () => void navigator.clipboard?.writeText(entry.path) },
        ]
      : [
          { label: "New Notebook", onClick: () => void create("notebook") },
          { label: "New Folder", onClick: () => void create("directory") },
          { label: "New File", onClick: () => void create("file", ".txt") },
          { label: "New Markdown File", onClick: () => void create("file", ".md") },
          { label: "New Python File", onClick: () => void create("file", ".py") },
          "-",
          { label: "Upload Files…", onClick: pickFiles },
          { label: "Refresh File List", onClick: load },
        ];

  return (
    <div className="jp-FileBrowser">
      <div className="jp-FileBrowser-toolbar">
        <button type="button" className="jp-ToolbarButton jp-mod-accent" title="New Launcher" onClick={onNewLauncher}><JpIcon name="add" /></button>
        <button type="button" className="jp-ToolbarButton" title="New Folder" onClick={() => void create("directory")}><JpIcon name="newFolder" /></button>
        <button type="button" className="jp-ToolbarButton" title="Upload Files" onClick={() => upload.current?.click()}><JpIcon name="upload" /></button>
        <button type="button" className="jp-ToolbarButton" title="Refresh the file browser" onClick={load}><JpIcon name="refresh" /></button>
        <input ref={upload} type="file" multiple hidden onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ""; }} />
      </div>
      <div className="jp-FileBrowser-filter">
        <input className="jp-mod-styled" placeholder="Filter files by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="jp-BreadCrumbs">
        <button type="button" className="jp-BreadCrumbs-item" title="The workspace's root folder" onClick={() => setCwd("")}><JpIcon name="folder" /></button>
        <span>/</span>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "contents" }}>
            <button type="button" className="jp-BreadCrumbs-item" onClick={() => setCwd(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
            <span>/</span>
          </span>
        ))}
      </div>
      <div
        className={`jp-DirListing${drop === "" ? " jp-DropZone" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          // over the listing itself (a folder row stops the event and names itself)
          if (drop !== "") setDrop("");
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const dir = drop ?? "";
          setDrop(null);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files, dir || cwd);
        }}
      >
        <div className="jp-DirListing-header">
          <button type="button" className="jp-DirListing-headerItem" style={{ flex: 1 }} onClick={() => setSort((s) => ({ key: "name", asc: s.key === "name" ? !s.asc : true }))}>
            Name {sort.key === "name" && <JpIcon name="caretDown" style={{ transform: sort.asc ? undefined : "rotate(180deg)" }} />}
          </button>
          <button type="button" className="jp-DirListing-headerItem" style={{ width: 116, justifyContent: "flex-end" }} onClick={() => setSort((s) => ({ key: "modified", asc: s.key === "modified" ? !s.asc : false }))}>
            Last Modified {sort.key === "modified" && <JpIcon name="caretDown" style={{ transform: sort.asc ? "rotate(180deg)" : undefined }} />}
          </button>
        </div>
        <ul
          ref={list}
          className="jp-DirListing-content"
          tabIndex={0}
          onContextMenu={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            setSelected(new Set());
            setMenu({ x: e.clientX, y: e.clientY, items: menuItems(null) });
          }}
          onMouseDown={(e) => e.target === e.currentTarget && setSelected(new Set())}
          onKeyDown={(e) => {
            const cur = shown.findIndex((x) => selected.has(x.path));
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = shown[Math.max(0, Math.min(shown.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)))];
              if (n) setSelected(new Set([n.path]));
            } else if (e.key === "Enter" && cur >= 0) {
              const x = shown[cur];
              if (x.type === "directory") setCwd(x.path);
              else onOpen(x);
            } else if (e.key === "F2" && cur >= 0) setRenaming(shown[cur].path);
            else if (e.key === "Delete" && selected.size) void remove([...selected]);
            else if (e.key === "Backspace" && cwd) setCwd(cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : "");
          }}
        >
          {err && <li className="jp-DirListing-empty jp-ErrorText">{err}</li>}
          {items && shown.length === 0 && <li className="jp-DirListing-empty">{filter ? "No files match the filter." : "This folder is empty. Create a notebook from the Launcher, or drop files here."}</li>}
          {shown.map((e) => (
            <li
              key={e.path}
              className={`jp-DirListing-item${selected.has(e.path) ? " jp-mod-selected" : ""}${drop === e.path ? " jp-mod-dropTarget" : ""}`}
              title={`Name: ${e.name}\nSize: ${e.size == null ? "-" : `${(e.size / 1024).toFixed(1)} KB`}\nLast Modified: ${new Date(e.last_modified).toLocaleString()}`}
              onMouseDown={(ev) => {
                if (ev.button !== 0) return;
                setSelected((s) => (ev.ctrlKey || ev.metaKey ? new Set(s.has(e.path) ? [...s].filter((x) => x !== e.path) : [...s, e.path]) : new Set([e.path])));
              }}
              onDoubleClick={() => (e.type === "directory" ? setCwd(e.path) : onOpen(e))}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (!selected.has(e.path)) setSelected(new Set([e.path]));
                setMenu({ x: ev.clientX, y: ev.clientY, items: menuItems(e) });
              }}
              onDragOver={(ev) => {
                if (e.type !== "directory" || !ev.dataTransfer.types.includes("Files")) return;
                ev.preventDefault();
                ev.stopPropagation();
                setDrop(e.path);
              }}
            >
              {running.has(e.path) && <span className="jp-DirListing-running" title="A kernel is running for this notebook" />}
              <JpIcon name={fileIcon(e.name, e.type)} />
              <span className="jp-DirListing-itemName">
                {renaming === e.path ? (
                  <input
                    autoFocus
                    defaultValue={e.name}
                    onFocus={(ev) => ev.target.setSelectionRange(0, e.name.lastIndexOf(".") > 0 && e.type !== "directory" ? e.name.lastIndexOf(".") : e.name.length)}
                    onBlur={(ev) => void rename(e, ev.target.value.trim())}
                    onKeyDown={(ev) => {
                      ev.stopPropagation();
                      if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
                      if (ev.key === "Escape") setRenaming(null);
                    }}
                    onMouseDown={(ev) => ev.stopPropagation()}
                  />
                ) : (
                  e.name
                )}
              </span>
              <span className="jp-DirListing-itemModified">{relTime(e.last_modified)}</span>
            </li>
          ))}
        </ul>
      </div>
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ running kernels

export function RunningPanel({ kernels, terminals, openTabs, onOpen, onShutdown, onShutdownAll, onCloseTab, onRefresh, onOpenTerminal, onShutdownTerminal }: {
  kernels: KernelInfo[]; terminals: TerminalInfo[]; openTabs: { id: string; label: string }[]; onOpen: (path: string) => void; onShutdown: (k: KernelInfo) => void;
  onShutdownAll: () => void; onCloseTab: (id: string) => void; onRefresh: () => void; onOpenTerminal: (t: TerminalInfo) => void; onShutdownTerminal: (t: TerminalInfo) => void;
}) {
  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header">Terminals</div>
        {terminals.map((t, i) => (
          <div key={t.id} className="jp-PanelRow" onDoubleClick={() => onOpenTerminal(t)} title={`Runs on: ${t.target === "local" ? "Local (the BluesandAI server)" : "the workspace's cloud machine"}\nStarted: ${new Date(t.created_at).toLocaleString()}`}>
            <JpIcon name="terminal" />
            <span className="jp-PanelRow-label">Terminal {i + 1}</span>
            <span className="jp-PanelRow-muted">{t.target === "local" ? "Local" : "Cloud"}</span>
            <button type="button" className="jp-ToolbarButton" title="Shut Down Terminal" onClick={() => onShutdownTerminal(t)}><JpIcon name="close" /></button>
          </div>
        ))}
        {terminals.length === 0 && <div className="jp-PanelRow jp-PanelRow-muted">No terminals are running.</div>}
      </div>
      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header">
          Open Tabs
        </div>
        {openTabs.map((t) => (
          <div key={t.id} className="jp-PanelRow">
            <JpIcon name={t.id === "launcher" ? "home" : fileIcon(t.label, t.label.endsWith(".ipynb") ? "notebook" : "file")} />
            <span className="jp-PanelRow-label">{t.label}</span>
            <button type="button" className="jp-ToolbarButton" title="Close" onClick={() => onCloseTab(t.id)}><JpIcon name="close" /></button>
          </div>
        ))}
        {openTabs.length === 0 && <div className="jp-PanelRow jp-PanelRow-muted">No open tabs.</div>}
      </div>
      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header">
          Kernels
          <button type="button" className="jp-ToolbarButton" title="Refresh" onClick={onRefresh}><JpIcon name="refresh" /></button>
          <button type="button" className="jp-ToolbarButton" title="Shut Down All" disabled={!kernels.length} onClick={onShutdownAll} style={{ marginLeft: 0 }}><JpIcon name="close" /></button>
        </div>
        {kernels.map((k) => (
          <div key={k.id} className="jp-PanelRow" onDoubleClick={() => onOpen(k.path)} title={`Path: ${k.path}\nKernel: Python 3 (ipykernel)\nRuns on: ${k.target === "local" ? "Local CPU" : k.target === "cloud-gpu" ? "Cloud CPU + GPU (RunPod)" : "Cloud CPU (Google Cloud)"}\nStarted: ${new Date(k.started_at).toLocaleString()}`}>
            <JpIcon name="notebook" />
            <span className="jp-PanelRow-label">{k.path.split("/").pop()}</span>
            <span className="jp-PanelRow-muted">{k.target === "local" ? "Local" : k.target === "cloud-gpu" ? "GPU" : "Cloud"} · {k.state}</span>
            <button type="button" className="jp-ToolbarButton" title="Shut Down Kernel" onClick={() => onShutdown(k)}><JpIcon name="close" /></button>
          </div>
        ))}
        {kernels.length === 0 && <div className="jp-PanelRow jp-PanelRow-muted">No kernels are running.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ table of contents

export function TocPanel({ title, headings, active, onPick }: { title: string | null; headings: Heading[]; active: number; onPick: (h: Heading) => void }) {
  if (!title) return <div className="jp-PanelBody jp-Muted">No notebook is open.</div>;
  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      <div className="jp-PanelRow" style={{ fontWeight: 600 }}>{title}</div>
      {headings.length === 0 && <div className="jp-PanelBody jp-Muted">No headings. Markdown cells with # headings appear here.</div>}
      {headings.map((h, i) => (
        <button key={i} type="button" className={`jp-TOC-item${i === active ? " jp-mod-active" : ""}`} style={{ paddingLeft: 12 + (h.level - 1) * 14, fontWeight: h.level <= 2 ? 600 : 400 }} onClick={() => onPick(h)}>
          {h.text}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the workspace (machine, aliases)

const TONE: Record<string, string> = { running: "jp-OkText", starting: "jp-WarnText", stopped: "jp-Muted", terminated: "jp-Muted" };

export function WorkspacePanel({ w, options, onChanged }: { w: Workspace; options: WorkspaceOptions | null; onChanged: (w: Workspace) => void }) {
  const dialogs = useDialogs();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<Workspace>) => {
    setBusy(true);
    setErr(null);
    try {
      onChanged(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pod = w.pod;
  const live = pod && (pod.status === "running" || pod.status === "starting");
  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header"><JpIcon name="cloud" /> Cloud machine</div>
        <div className="jp-PanelBody">
          {!options?.cpu_configured && <p className="jp-WarnText jp-Small">GCP_COMPUTE_CREDENTIALS is not set on the API: Cloud CPU (Google Compute Engine) is not available.</p>}
          {!options?.gpu_configured && <p className="jp-WarnText jp-Small">RUNPOD_API_KEY is not set on the API: Cloud CPU + GPU (RunPod) is not available.</p>}
          <p>
            <span className={TONE[pod?.status ?? "terminated"]}>{pod ? pod.status : "No machine rented"}</span>
            {pod ? ` · ${machineLabel(pod)}` : ""}
            {pod?.cost_per_hr != null ? ` · $${pod.cost_per_hr.toFixed(2)}/hour` : ""}
          </p>
          {pod?.last_activity && <p className="jp-Muted jp-Small">Last activity {when(pod.last_activity)}</p>}
          <p className="jp-Muted jp-Small">Choose Cloud CPU or Cloud CPU + GPU with the compute button of a notebook&apos;s toolbar to start one.</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            {pod && !live && <button type="button" className="jp-Button jp-mod-accept jp-mod-small" disabled={busy || !(pod.provider === "gce" ? options?.cpu_configured : options?.gpu_configured)} onClick={() => act(() => codeWorkspaces.start(w.id))}>Resume</button>}
            {live && <button type="button" className="jp-Button jp-mod-small" disabled={busy} onClick={() => act(() => codeWorkspaces.stop(w.id))}>Stop</button>}
            {pod && (
              <button type="button" className="jp-Button jp-mod-warn jp-mod-small" disabled={busy}
                onClick={async () => {
                  if (await dialogs.confirm("Terminate the machine?", "The machine and its /workspace disk are deleted. The workspace's notebooks and files stay on the platform.", "Terminate", true)) await act(() => codeWorkspaces.terminate(w.id));
                }}>Terminate</button>
            )}
            {w.jupyter_url && <a className="jp-Button jp-mod-small" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }} href={w.jupyter_url} target="_blank" rel="noreferrer">Machine&apos;s JupyterLab ↗</a>}
          </div>
          <label>
            Stop when idle for (minutes)
            <input key={w.idle_minutes} className="jp-mod-styled" type="number" min={1} max={720} defaultValue={w.idle_minutes} disabled={busy}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 720 && n !== w.idle_minutes) void act(() => codeWorkspaces.update(w.id, { idle_minutes: n })); }} />
          </label>
          {err && <p className="jp-ErrorText jp-Small">{err}</p>}
        </div>
      </div>
      <DatasetsSection w={w} act={act} />
      <ModelsSection w={w} act={act} />
      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header">Activity</div>
        <div className="jp-PanelBody jp-Small">
          {[...w.events].reverse().slice(0, 15).map((e, i) => <p key={i}><span className="jp-Muted">{when(e.at)} · </span>{e.text}</p>)}
          {w.events.length === 0 && <p className="jp-Muted">Nothing yet.</p>}
        </div>
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<Workspace>) => Promise<void>;

type SnippetFormat = "pandas" | "polars" | "arrow" | "files";

/** The code a notebook uses for an alias (Foundry's Data panel snippet), in the chosen format. */
function snippet(d: WorkspaceDataset, fmt: SnippetFormat): string {
  const v = d.alias.replace(/-/g, "_");
  if (d.mode === "write")
    return d.kind === "files"
      ? `from foundry.transforms import Dataset\nout = Dataset.get("${d.alias}")\nout.upload_file("report.pdf")          # one file\nout.upload_directory("results/")       # a folder, subfolders kept`
      : `from foundry.transforms import Dataset\nDataset.get("${d.alias}").write_table(df)`;
  if (fmt === "files")
    return `from foundry.transforms import Dataset\nfiles = Dataset.get("${d.alias}").files()\nfiles.list()                       # [{path, size, modified}]\npaths = files.download()            # {path in the dataset: local path}`;
  return `from foundry.transforms import Dataset\n${v} = Dataset.get("${d.alias}").read_table(format="${fmt}")`;
}

function DatasetsSection({ w, act }: { w: Workspace; act: Act }) {
  const [alias, setAlias] = useState("");
  const [name, setName] = useState("");
  const [outKind, setOutKind] = useState<"table" | "files">("table");
  const [pick, setPick] = useState<"read" | "readFolder" | "write" | null>(null);
  const [formats, setFormats] = useState<Record<string, SnippetFormat>>({});
  const ok = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(alias);
  return (
    <div className="jp-PanelSection">
      <div className="jp-PanelSection-header"><JpIcon name="table" /> Datasets</div>
      <div className="jp-PanelBody">
        {w.datasets.map((d) => {
          const fmt = formats[d.alias] ?? (d.kind === "files" ? "files" : "pandas");
          return (
            <div key={d.alias} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <code className="jp-Code">{d.alias}</code>
                <span className="jp-Muted jp-Small">{d.mode === "read" ? "reads" : "writes"}{d.kind === "files" ? " files" : ""}</span>
                {d.item_id ? <Link href={datasetHref(d.item_id)} className="jp-Small" style={{ color: "var(--jp-content-link-color)" }}>{d.name}</Link> : <span className="jp-Small jp-Muted">{d.name} (on first write)</span>}
                <button type="button" className="jp-ToolbarButton" style={{ marginLeft: "auto" }} title="Remove the alias" onClick={() => act(() => codeWorkspaces.removeDataset(w.id, d.alias))}><JpIcon name="close" /></button>
              </div>
              {d.mode === "read" && (
                <select className="jp-HTMLSelect" style={{ marginTop: 2, height: 20, fontSize: 11 }} value={fmt} onChange={(e) => setFormats((f) => ({ ...f, [d.alias]: e.target.value as SnippetFormat }))}>
                  <option value="pandas">pandas DataFrame</option>
                  <option value="polars">Polars DataFrame</option>
                  <option value="arrow">PyArrow Table</option>
                  <option value="files">Files (non-tabular)</option>
                </select>
              )}
              <div style={{ position: "relative" }}>
                <pre className="jp-Snippet" style={{ paddingRight: 28 }}>{snippet(d, fmt)}</pre>
                <button type="button" className="jp-ToolbarButton" style={{ position: "absolute", top: 2, right: 2 }} title="Copy to the clipboard" onClick={() => void navigator.clipboard?.writeText(snippet(d, fmt))}>
                  <JpIcon name="copy" />
                </button>
              </div>
            </div>
          );
        })}
        {w.datasets.length === 0 && <p className="jp-Muted jp-Small">No dataset aliases. A notebook reads and writes platform datasets through them, on any compute: tables, or files (images, PDFs, any format).</p>}
        <label>Alias<input className="jp-mod-styled" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="training_data" /></label>
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          <button type="button" className="jp-Button jp-mod-small" disabled={!ok} onClick={() => setPick("read")} title="A Parquet, CSV, TSV or JSON dataset">Read a dataset…</button>
          <button type="button" className="jp-Button jp-mod-small" disabled={!ok} onClick={() => setPick("readFolder")} title="A raw dataset: a folder of files of any format">Read a folder of files…</button>
        </div>
        <label>New output dataset<input className="jp-mod-styled" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" /></label>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <select className="jp-mod-styled" style={{ width: 110 }} value={outKind} onChange={(e) => setOutKind(e.target.value as "table" | "files")}>
            <option value="table">Table</option>
            <option value="files">Files</option>
          </select>
          <button type="button" className="jp-Button jp-mod-small" disabled={!ok || !name.trim()} onClick={() => setPick("write")}>Write to a new dataset…</button>
        </div>
      </div>
      {pick === "read" && (
        <DrivePicker title="Dataset to read" onClose={() => setPick(null)} canPick={(it) => (/\.(parquet|csv|tsv|json|jsonl|txt)$/i.test(it.name) ? null : "Not a dataset")}
          onPick={(it) => { setPick(null); void act(() => codeWorkspaces.addDataset(w.id, { alias, item_id: it.id })); setAlias(""); }} />
      )}
      {pick === "readFolder" && (
        <DrivePicker title="Folder of files to read" onClose={() => setPick(null)}
          folder={{ action: "Read this folder", onPick: (f) => { setPick(null); if (f.id) { void act(() => codeWorkspaces.addDataset(w.id, { alias, item_id: f.id as string })); setAlias(""); } } }} />
      )}
      {pick === "write" && (
        <DrivePicker title="Folder of the new dataset" onClose={() => setPick(null)}
          folder={{ action: "Use this folder", onPick: (f) => { setPick(null); if (f.id) { void act(() => codeWorkspaces.addDataset(w.id, { alias, folder_id: f.id as string, name, kind: outKind })); setAlias(""); setName(""); } } }} />
      )}
    </div>
  );
}

function ModelsSection({ w, act }: { w: Workspace; act: Act }) {
  const [alias, setAlias] = useState("");
  const [models, setModels] = useState<ModelAsset[]>([]);
  const [existing, setExisting] = useState("");
  const [pick, setPick] = useState(false);
  useEffect(() => {
    modelAssets.list("python").then(setModels, () => {});
  }, []);
  const ok = /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias);
  return (
    <div className="jp-PanelSection">
      <div className="jp-PanelSection-header"><JpIcon name="cube" /> Models</div>
      <div className="jp-PanelBody">
        {w.models.map((m) => (
          <div key={m.alias} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <code className="jp-Code">{m.alias}</code>
              <Link href={`/model-assets/${m.model_id}`} className="jp-Small" style={{ color: "var(--jp-content-link-color)" }}>{m.name}</Link>
              <button type="button" className="jp-ToolbarButton" style={{ marginLeft: "auto" }} title="Remove the alias" onClick={() => act(() => codeWorkspaces.removeModel(w.id, m.alias))}><JpIcon name="close" /></button>
            </div>
            <p className="jp-Small jp-Muted">MLflow model class in <code className="jp-Code">{m.adapter_file}</code>; train, evaluate and publish a version:</p>
            <pre className="jp-Snippet">{`import mlflow\nfrom bluesandai.workspace import ModelOutput\nfrom bluesandai.evaluation import log_regresi\nfrom ${m.adapter_file.replace(/\.py$/, "")} import ${m.adapter_class}\n\nwith mlflow.start_run():\n    log_regresi(y_test, fitted.predict(X_test), "holdout")\n    ModelOutput("${m.alias}").publish(${m.adapter_class}(fitted, features), input_example=X_test.head(5))`}</pre>
          </div>
        ))}
        {w.models.length === 0 && <p className="jp-Muted jp-Small">No model aliases. Models trained in a notebook are published to the platform through them.</p>}
        <label>Alias<input className="jp-mod-styled" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="risk_model" /></label>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button type="button" className="jp-Button jp-mod-small" disabled={!ok} onClick={() => setPick(true)}>New model…</button>
        </div>
        <label>
          Or an existing model
          <select className="jp-mod-styled" value={existing} onChange={(e) => setExisting(e.target.value)}>
            <option value="">Choose…</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button type="button" className="jp-Button jp-mod-small" disabled={!ok || !existing} onClick={() => { void act(() => codeWorkspaces.addModel(w.id, { alias, model_id: existing })); setAlias(""); setExisting(""); }}>Add</button>
        </div>
      </div>
      {pick && (
        <DrivePicker title="Folder of the new model" onClose={() => setPick(false)}
          folder={{ action: "Create the model here", onPick: (f) => { setPick(false); if (f.id) { void act(() => codeWorkspaces.addModel(w.id, { alias, folder_id: f.id as string, name: alias })); setAlias(""); } } }} />
      )}
    </div>
  );
}
