"use client";

import "./jupyterlab.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { codeWorkspaces, machineLabel, providerName, type Workspace, type WorkspaceOptions } from "@/lib/codeWorkspaces";
import { lab, type Entry, type KernelInfo, type NotebookJSON } from "@/lib/jupyterLab";
import { FileEditor, type FileEditorHandle, type FileEditorState } from "./FileEditor";
import { fileIcon, JpIcon, type IconName } from "./icons";
import { Notebook, type ComputeChoice, type NotebookHandle, type NotebookState } from "./Notebook";
import { FileBrowser, RunningPanel, TocPanel, WorkspacePanel } from "./Panels";
import { CheckpointsDialog, GitPanel } from "./Versions";
import { PackagesPanel } from "./Packages";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import type { TerminalInfo } from "@/lib/jupyterLab";
import { DialogHost, MenuBar, useDialogs, type MenuItem } from "./ui";

type Tab = { id: string; kind: "launcher" | "notebook" | "file" | "terminal"; path: string };
type Panel = "files" | "running" | "git" | "packages" | "toc" | "workspace";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const K = (s: string) => (isMac ? s.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : s);
const store = {
  get: <T,>(k: string, d: T): T => {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set: (k: string, v: unknown) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
const baseName = (p: string) => p.split("/").pop() || p;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Jupyter Code Workspace editor: a JupyterLab (menu bar, side panels, tabbed notebooks and files, status bar)
 *  whose kernels run locally, on a Compute Engine VM (Cloud CPU) or on a RunPod pod (Cloud CPU + GPU). */
export function Lab({ workspace: initial, options, openPath }: { workspace: Workspace; options: WorkspaceOptions | null; openPath?: string | null }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the theme remembered in this browser
    setTheme(store.get("jp-theme", "light"));
  }, []);
  return (
    <div className="jp-Lab" data-jp-theme={theme}>
      <DialogHost theme={theme}>
        <LabShell initial={initial} options={options} openPath={openPath} theme={theme} setTheme={(t) => { setTheme(t); store.set("jp-theme", t); }} />
      </DialogHost>
    </div>
  );
}

function LabShell({ initial, options, openPath, theme, setTheme }: { initial: Workspace; options: WorkspaceOptions | null; openPath?: string | null; theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void }) {
  const wid = initial.id;
  const dialogs = useDialogs();
  const router = useRouter();
  const [w, setW] = useState<Workspace>(initial);
  const [panel, setPanel] = useState<Panel | null>("files");
  const [panelWidth, setPanelWidth] = useState(256);
  const [tabs, setTabs] = useState<Tab[]>([{ id: "launcher", kind: "launcher", path: "" }]);
  const [current, setCurrent] = useState("launcher");
  const [cwd, setCwd] = useState("");
  const [kernels, setKernels] = useState<KernelInfo[]>([]);
  const [nbStates, setNbStates] = useState<Record<string, NotebookState>>({});
  const [fileStates, setFileStates] = useState<Record<string, FileEditorState>>({});
  const [refresh, setRefresh] = useState(0);
  const [statusBar, setStatusBar] = useState(true);
  const [simple, setSimple] = useState(false);
  const [autosave, setAutosave] = useState(true);
  const handles = useRef(new Map<string, NotebookHandle | FileEditorHandle | TerminalHandle>());
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const restored = useRef(false);

  // ---------------------------------------------------------------- layout persistence
  useEffect(() => {
    const saved = store.get<{ tabs?: Tab[]; current?: string; panel?: Panel | null; width?: number; cwd?: string; simple?: boolean; statusBar?: boolean; autosave?: boolean }>(`jp-layout-${wid}`, {});
    /* eslint-disable react-hooks/set-state-in-effect -- the layout remembered in this browser */
    if (saved.tabs?.length) setTabs(saved.tabs);
    if (saved.current) setCurrent(saved.current);
    if (saved.panel !== undefined) setPanel(saved.panel);
    if (saved.width) setPanelWidth(saved.width);
    if (saved.cwd) setCwd(saved.cwd);
    if (saved.simple !== undefined) setSimple(saved.simple);
    if (saved.statusBar !== undefined) setStatusBar(saved.statusBar);
    if (saved.autosave !== undefined) setAutosave(saved.autosave);
    /* eslint-enable react-hooks/set-state-in-effect */
    restored.current = true;
  }, [wid]);
  useEffect(() => {
    if (restored.current) store.set(`jp-layout-${wid}`, { tabs, current, panel, width: panelWidth, cwd, simple, statusBar, autosave });
  }, [wid, tabs, current, panel, panelWidth, cwd, simple, statusBar, autosave]);

  // ---------------------------------------------------------------- the workspace and its kernels
  const loadKernels = useCallback(() => {
    lab.kernels(wid).then(setKernels, () => {});
    lab.terminals(wid).then(setTerminals, () => {});
  }, [wid]);
  useEffect(() => {
    loadKernels();
    const t = setInterval(loadKernels, 10_000);
    return () => clearInterval(t);
  }, [loadKernels]);
  const reloadWorkspace = useCallback(async () => {
    const nw = await codeWorkspaces.get(wid);
    setW(nw);
    return nw;
  }, [wid]);
  useEffect(() => {
    const t = setInterval(() => void reloadWorkspace().catch(() => {}), w.pod?.status === "starting" ? 5000 : 30_000);
    return () => clearInterval(t);
  }, [reloadWorkspace, w.pod?.status]);

  /** Start the workspace's machine with this compute (switching machines when it differs); true once Jupyter answers. */
  const startMachine = useCallback(
    async (c: Extract<ComputeChoice, { target: "cloud" }>, ask = false): Promise<boolean> => {
      try {
        let cur = await reloadWorkspace();
        const pod = cur.pod;
        const podCompute = pod?.compute ?? cur.compute;
        const same = podCompute.kind === c.kind && (c.kind === "gpu" ? podCompute.gpu_type === c.gpu_type : podCompute.vcpus === c.vcpus && (podCompute.cloud === "COMMUNITY") === c.spot);
        if (pod && !same) {
          cur = await codeWorkspaces.terminate(wid);
          setW(cur);
        }
        if (!cur.pod) {
          const compute = { ...cur.compute, kind: c.kind, ...(c.kind === "gpu" ? { gpu_type: c.gpu_type } : { vcpus: c.vcpus, cloud: c.spot ? ("COMMUNITY" as const) : ("SECURE" as const) }) };
          if (ask && !(await dialogs.confirm("Start the machine?", `This rents a ${c.kind === "gpu" ? c.gpu_type : `${compute.vcpus} vCPU`} machine on your ${c.kind === "gpu" ? "RunPod account" : "Google Cloud project"}, billed by the hour until it stops (by itself after ${cur.idle_minutes} idle minutes).`, "Start"))) return false;
          cur = await codeWorkspaces.update(wid, { compute });
          cur = await codeWorkspaces.start(wid);
          setW(cur);
        } else if (cur.pod.status !== "running" && cur.pod.status !== "starting") {
          if (ask && !(await dialogs.confirm("Resume the machine?", `The workspace's ${providerName(cur.pod)} machine is ${cur.pod.status}. Resuming bills by the hour until it stops again.`, "Resume"))) return false;
          cur = await codeWorkspaces.start(wid);
          setW(cur);
        }
        const until = Date.now() + 20 * 60_000;
        while (Date.now() < until) {
          if (cur.pod?.status === "running") return true;
          if (!cur.pod || cur.pod.status === "stopped" || cur.pod.status === "terminated") break;
          await sleep(5000);
          cur = await reloadWorkspace();
        }
        await dialogs.alert("The machine did not start", cur.pod ? `The machine is ${cur.pod.status}. Check the workspace panel, or try again.` : "The cloud provider has no machine for this workspace.");
        return false;
      } catch (e) {
        await dialogs.alert("The machine did not start", (e as Error).message);
        return false;
      }
    },
    [wid, dialogs, reloadWorkspace],
  );

  // ---------------------------------------------------------------- tabs
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  });
  const open = useCallback((e: Pick<Entry, "path" | "type">) => {
    if (e.type === "directory") return;
    const existing = tabsRef.current.find((t) => t.path === e.path && t.kind !== "launcher");
    if (existing) return setCurrent(existing.id);
    const t: Tab = { id: `t-${Math.random().toString(36).slice(2, 9)}`, kind: e.type === "notebook" ? "notebook" : "file", path: e.path };
    setTabs((ts) => [...ts, t]);
    setCurrent(t.id);
  }, []);
  // a link straight to one file (?open=<path>, e.g. ML Studio's notebook per model): opened once, on arrival
  useEffect(() => {
    if (openPath) open({ path: openPath, type: openPath.endsWith(".ipynb") ? "notebook" : "file" });
  }, [openPath, open]);
  const tabDirty = (t: Tab) => (t.kind === "notebook" ? nbStates[t.path]?.dirty : t.kind === "file" ? fileStates[t.path]?.dirty : false);
  const closeTab = useCallback(
    async (id: string, opts: { shutdown?: boolean; force?: boolean } = {}) => {
      const t = tabs.find((x) => x.id === id);
      if (!t) return;
      if (!opts.force && tabDirty(t)) {
        const r = await dialogs.show({
          title: "Save your work",
          body: `Save changes in "${baseName(t.path)}" before closing?`,
          buttons: [{ label: "Cancel", kind: "reject", value: "cancel" }, { label: "Discard", kind: "warn", value: "discard" }, { label: "Save", kind: "accept", value: "save" }],
        });
        if (r.button === "cancel") return;
        if (r.button === "save") await handles.current.get(id)?.save(true);
      }
      if (opts.shutdown && t.kind === "notebook") {
        const k = kernels.find((x) => x.path === t.path);
        if (k) await lab.shutdown(wid, k.id).catch(() => {});
        loadKernels();
      }
      setTabs((ts) => {
        const i = ts.findIndex((x) => x.id === id);
        const rest = ts.filter((x) => x.id !== id);
        if (current === id) setCurrent(rest[Math.min(i, rest.length - 1)]?.id ?? "");
        return rest;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, nbStates, fileStates, current, kernels, wid, dialogs, loadKernels],
  );
  /** a terminal tab: "terminal:<id>" (a new terminal on that target, or an existing one) */
  const openTerminal = async (target: "local" | "cloud" | TerminalInfo) => {
    try {
      const t = typeof target === "string" ? await lab.newTerminal(wid, target) : target;
      const existing = tabsRef.current.find((x) => x.kind === "terminal" && x.path === t.id);
      if (existing) return setCurrent(existing.id);
      const tab: Tab = { id: `term-${t.id}`, kind: "terminal", path: t.id };
      const cur = tabsRef.current.find((x) => x.id === current);
      setTabs((ts) => [...ts.filter((x) => !(typeof target === "string" && cur?.kind === "launcher" && x.id === cur.id)), tab]);
      setCurrent(tab.id);
      loadKernels();
    } catch (e) {
      void dialogs.alert("The terminal did not start", (e as Error).message);
    }
  };
  const terminalLabel = (tid: string) => `Terminal ${Math.max(1, terminals.findIndex((x) => x.id === tid) + 1)}`;
  const tabLabel = (t: Tab) => (t.kind === "launcher" ? "Launcher" : t.kind === "terminal" ? terminalLabel(t.path) : baseName(t.path));
  const newLauncher = () => {
    const l = tabs.find((t) => t.kind === "launcher");
    if (l) setCurrent(l.id);
    else {
      setTabs((ts) => [...ts, { id: "launcher", kind: "launcher", path: "" }]);
      setCurrent("launcher");
    }
  };
  const create = async (type: "notebook" | "file", ext?: string) => {
    try {
      const e = await lab.create(wid, cwd, type, ext);
      setRefresh((r) => r + 1);
      // the launcher becomes the new document, as in JupyterLab
      const cur = tabs.find((t) => t.id === current);
      if (cur?.kind === "launcher") setTabs((ts) => ts.filter((t) => t.id !== cur.id));
      open(e);
    } catch (err) {
      void dialogs.alert("Could not create the file", (err as Error).message);
    }
  };
  const renamed = useCallback((from: string, to: string) => {
    setTabs((ts) => ts.map((t) => (t.path === from ? { ...t, path: to } : t.path.startsWith(from + "/") ? { ...t, path: to + t.path.slice(from.length) } : t)));
    setNbStates((s) => (s[from] ? { ...s, [to]: s[from] } : s));
    loadKernels();
  }, [loadKernels]);
  const deleted = useCallback((path: string) => {
    setTabs((ts) => ts.filter((t) => t.path !== path && !t.path.startsWith(path + "/")));
  }, []);

  const tab = tabs.find((t) => t.id === current) ?? null;
  /** the current notebook's handle (read in event handlers, never while rendering) */
  const nbOf = () => (tab?.kind === "notebook" ? (handles.current.get(tab.id) as NotebookHandle | undefined) : undefined);
  const nbState = tab?.kind === "notebook" ? nbStates[tab.path] : undefined;
  const fileState = tab?.kind === "file" ? fileStates[tab.path] : undefined;
  const run = (name: string) => nbOf()?.command(name);

  const renameCurrent = async () => {
    if (!tab || tab.kind === "launcher") return;
    const name = await dialogs.prompt("Rename File", baseName(tab.path), "Rename", "New Name");
    if (!name || name === baseName(tab.path)) return;
    const to = tab.path.includes("/") ? `${tab.path.slice(0, tab.path.lastIndexOf("/"))}/${name}` : name;
    try {
      await handles.current.get(tab.id)?.save(true);
      await lab.rename(wid, tab.path, to);
      renamed(tab.path, to);
      setRefresh((r) => r + 1);
    } catch (e) {
      void dialogs.alert("Rename Error", (e as Error).message);
    }
  };
  const saveAs = async (content: NotebookJSON) => {
    if (!tab) return;
    const to = await dialogs.prompt("Save File As…", tab.path.replace(/\.ipynb$/, "-Copy.ipynb"), "Save", "New Path");
    if (!to) return;
    try {
      await lab.save(wid, to, "notebook", content);
      setRefresh((r) => r + 1);
      open({ path: to, type: "notebook" });
    } catch (e) {
      void dialogs.alert("Save Error", (e as Error).message);
    }
  };
  /** after a restore or a branch switch the files on disk changed: the open tabs read them again */
  const reloadPath = (p: string) => {
    for (const t of tabsRef.current) if (t.path === p) void handles.current.get(t.id)?.reload();
  };
  const reloadAll = () => {
    for (const t of tabsRef.current) if (t.kind !== "launcher") void handles.current.get(t.id)?.reload();
  };
  const openCheckpoints = (t: Tab) =>
    dialogs.custom((close) => (
      <CheckpointsDialog wid={wid} path={t.path} onClose={close} onRestored={() => { void handles.current.get(t.id)?.reload(); setRefresh((r) => r + 1); }} />
    ));
  const saveAll = async () => {
    for (const t of tabs) if (t.kind !== "launcher" && tabDirty(t)) await handles.current.get(t.id)?.save(true);
  };
  const shutdownAll = async () => {
    if (!(await dialogs.confirm("Shut Down All?", "Shut down all kernels?", "Shut Down All", true))) return;
    for (const k of kernels) await lab.shutdown(wid, k.id).catch(() => {});
    loadKernels();
  };
  const showShortcuts = () =>
    dialogs.show({
      title: "Keyboard Shortcuts",
      wide: true,
      buttons: [{ label: "Close", kind: "accept", value: "ok" }],
      body: (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {[
              ["Command mode (Esc)", ""],
              ["Enter", "Edit the selected cell"], ["Shift+Enter", "Run the cell and select the next"], ["Ctrl+Enter", "Run the selected cells"], ["Alt+Enter", "Run the cell and insert one below"],
              ["A / B", "Insert a cell above / below"], ["X / C / V", "Cut / copy / paste cells"], ["D, D", "Delete the selected cells"], ["Z", "Undo the cell operation"],
              ["M / Y / R", "Markdown / code / raw cell"], ["1 … 6", "Markdown heading"], ["Shift+M", "Merge the selected cells"], ["↑ ↓ (K J)", "Select the cell above / below"],
              ["Shift+↑ ↓", "Extend the selection"], ["I, I", "Interrupt the kernel"], ["0, 0", "Restart the kernel"], ["L", "Toggle line numbers"], ["O", "Toggle the output"], ["Ctrl+S", "Save"],
              ["Edit mode (Enter)", ""],
              ["Tab", "Complete (or indent)"], ["Shift+Tab", "Tooltip: signature and docstring"], ["Ctrl+Shift+-", "Split the cell at the cursor"], ["Esc", "Command mode"],
              ["Anywhere", ""],
              ["Ctrl+B", "Toggle the left sidebar"], ["Alt+W", "Close the tab"], ["Ctrl+Shift+[ / ]", "Previous / next tab"],
            ].map(([k, v], i) => (
              <tr key={i} style={v ? undefined : { fontWeight: 600 }}>
                <td style={{ padding: "3px 8px 3px 0", whiteSpace: "nowrap", fontFamily: v ? "var(--jp-code-font-family)" : undefined, paddingTop: v ? 3 : 10 }}>{K(k)}</td>
                <td style={{ padding: 3 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    });

  // ---------------------------------------------------------------- global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".jp-Dialog")) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setPanel((p) => (p ? null : "files"));
      } else if (mod && e.key.toLowerCase() === "s" && !(e.target as HTMLElement).closest?.(".jp-Notebook, .cm-editor")) {
        e.preventDefault();
        const t = tabs.find((x) => x.id === current);
        if (t) void handles.current.get(t.id)?.save(true);
      } else if (e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (current) void closeTab(current);
      } else if (mod && e.shiftKey && (e.key === "]" || e.key === "}" || e.key === "[" || e.key === "{")) {
        e.preventDefault();
        const i = tabs.findIndex((x) => x.id === current);
        const n = tabs[(i + (e.key === "]" || e.key === "}" ? 1 : -1) + tabs.length) % tabs.length];
        if (n) setCurrent(n.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, current, closeTab]);

  // focus the document of the tab that becomes current
  useEffect(() => {
    const h = handles.current.get(current);
    if (h) requestAnimationFrame(() => h.focus());
  }, [current]);

  // ---------------------------------------------------------------- menus
  const isNb = tab?.kind === "notebook";
  const isDoc = tab?.kind === "notebook" || tab?.kind === "file";
  const menus: { label: string; items: () => MenuItem[] }[] = [
    {
      label: "File",
      items: () => [
        {
          label: "New",
          submenu: [
            { label: "Notebook", onClick: () => void create("notebook") },
            { label: "Text File", onClick: () => void create("file", ".txt") },
            { label: "Markdown File", onClick: () => void create("file", ".md") },
            { label: "Python File", onClick: () => void create("file", ".py") },
            "-",
            { label: "Terminal", onClick: () => void openTerminal("local") },
            { label: "Terminal on the Cloud Machine", disabled: w.pod?.status !== "running", onClick: () => void openTerminal("cloud") },
          ],
        },
        { label: "New Launcher", shortcut: K("Ctrl+Shift+L"), onClick: newLauncher },
        "-",
        { label: isNb ? "Save Notebook" : "Save", shortcut: K("Ctrl+S"), disabled: !isDoc, onClick: () => tab && void handles.current.get(tab.id)?.save(true) },
        { label: isNb ? "Save Notebook As…" : "Save As…", shortcut: K("Ctrl+Shift+S"), disabled: !isNb, onClick: () => { const nb = nbOf(); if (nb) void saveAs(nb.content()); } },
        { label: "Save All", disabled: !tabs.some((t) => tabDirty(t)), onClick: () => void saveAll() },
        "-",
        { label: isNb ? "Revert Notebook to Checkpoint…" : "Revert File to Checkpoint…", disabled: !isDoc, onClick: () => tab && openCheckpoints(tab) },
        { label: isNb ? "Rename Notebook…" : "Rename File…", disabled: !isDoc, onClick: () => void renameCurrent() },
        { label: "Download", disabled: !isDoc, onClick: () => tab && window.open(lab.downloadUrl(wid, tab.path), "_blank") },
        "-",
        { label: "Close Tab", shortcut: K("Alt+W"), disabled: !tab, onClick: () => tab && void closeTab(tab.id) },
        { label: "Close and Shut Down Notebook", shortcut: K("Ctrl+Shift+Q"), disabled: !isNb, onClick: () => tab && void closeTab(tab.id, { shutdown: true }) },
        { label: "Close All Tabs", disabled: !tabs.length, onClick: async () => { for (const t of [...tabs]) await closeTab(t.id); } },
        "-",
        { label: "Print…", shortcut: K("Ctrl+P"), disabled: !isNb, onClick: () => window.print() },
        "-",
        { label: "Back to Code Workspaces", onClick: () => router.push("/code-workspaces") },
      ],
    },
    {
      label: "Edit",
      items: () => [
        { label: "Undo Cell Operation", shortcut: "Z", disabled: !isNb, onClick: () => run("undoCells") },
        "-",
        { label: "Cut Cells", shortcut: "X", disabled: !isNb, onClick: () => run("cut") },
        { label: "Copy Cells", shortcut: "C", disabled: !isNb, onClick: () => run("copy") },
        { label: "Paste Cells Below", shortcut: "V", disabled: !isNb, onClick: () => run("paste") },
        { label: "Paste Cells Above", shortcut: "Shift+V", disabled: !isNb, onClick: () => run("pasteAbove") },
        "-",
        { label: "Delete Cells", shortcut: "D, D", disabled: !isNb, onClick: () => run("delete") },
        "-",
        { label: "Select All Cells", shortcut: K("Ctrl+A"), disabled: !isNb, onClick: () => run("selectAll") },
        { label: "Deselect All Cells", disabled: !isNb, onClick: () => run("deselect") },
        "-",
        { label: "Move Cells Up", disabled: !isNb, onClick: () => run("moveUp") },
        { label: "Move Cells Down", disabled: !isNb, onClick: () => run("moveDown") },
        "-",
        { label: "Split Cell", shortcut: K("Ctrl+Shift+-"), disabled: !isNb, onClick: () => run("split") },
        { label: "Merge Selected Cells", shortcut: "Shift+M", disabled: !isNb, onClick: () => run("merge") },
        { label: "Merge Cell Above", disabled: !isNb, onClick: () => run("mergeAbove") },
        { label: "Merge Cell Below", disabled: !isNb, onClick: () => run("mergeBelow") },
        "-",
        { label: "Clear Cell Output", disabled: !isNb, onClick: () => run("clearOutput") },
        { label: "Clear Outputs of All Cells", disabled: !isNb, onClick: () => run("clearAllOutputs") },
      ],
    },
    {
      label: "View",
      items: () => [
        { label: "Show Left Sidebar", shortcut: K("Ctrl+B"), checked: panel !== null, onClick: () => setPanel((p) => (p ? null : "files")) },
        { label: "Show Status Bar", checked: statusBar, onClick: () => setStatusBar((v) => !v) },
        { label: "Simple Interface", shortcut: K("Ctrl+Shift+D"), checked: simple, onClick: () => setSimple((v) => !v) },
        "-",
        { label: "File Browser", onClick: () => setPanel("files") },
        { label: "Running Terminals and Kernels", onClick: () => setPanel("running") },
        { label: "Git", onClick: () => setPanel("git") },
        { label: "Table of Contents", onClick: () => setPanel("toc") },
        { label: "BluesandAI Workspace", onClick: () => setPanel("workspace") },
        "-",
        { label: "Show Line Numbers", shortcut: "Shift+L", disabled: !isNb, onClick: () => run("toggleLineNumbers") },
        "-",
        { label: "Collapse Selected Code", disabled: !isNb, onClick: () => run("collapseCode") },
        { label: "Collapse Selected Outputs", disabled: !isNb, onClick: () => run("collapseOutputs") },
        { label: "Collapse All Code", disabled: !isNb, onClick: () => run("collapseAllCode") },
        { label: "Collapse All Outputs", disabled: !isNb, onClick: () => run("collapseAllOutputs") },
        "-",
        { label: "Expand Selected Code", disabled: !isNb, onClick: () => run("expandCode") },
        { label: "Expand Selected Outputs", disabled: !isNb, onClick: () => run("expandOutputs") },
        { label: "Expand All Code", disabled: !isNb, onClick: () => run("expandAllCode") },
        { label: "Expand All Outputs", disabled: !isNb, onClick: () => run("expandAllOutputs") },
        "-",
        { label: "Show Markdown Preview", disabled: !(tab?.kind === "file" && tab.path.endsWith(".md")), onClick: () => tab && (handles.current.get(tab.id) as FileEditorHandle | undefined)?.togglePreview() },
      ],
    },
    {
      label: "Run",
      items: () => [
        { label: "Run Selected Cell and Advance", shortcut: "Shift+Enter", disabled: !isNb, onClick: () => run("runAdvance") },
        { label: "Run Selected Cell and Do not Advance", shortcut: K("Ctrl+Enter"), disabled: !isNb, onClick: () => run("runStay") },
        { label: "Run Selected Cell and Insert Below", shortcut: K("Alt+Enter"), disabled: !isNb, onClick: () => run("runInsert") },
        "-",
        { label: "Run All Above Selected Cell", disabled: !isNb, onClick: () => run("runAbove") },
        { label: "Run Selected Cell and All Below", disabled: !isNb, onClick: () => run("runBelow") },
        "-",
        { label: "Render All Markdown Cells", disabled: !isNb, onClick: () => run("renderMarkdown") },
        { label: "Run All Cells", disabled: !isNb, onClick: () => run("runAll") },
        { label: "Restart Kernel and Run All Cells…", disabled: !isNb, onClick: () => run("restartRunAll") },
      ],
    },
    {
      label: "Kernel",
      items: () => [
        { label: "Interrupt Kernel", shortcut: "I, I", disabled: !isNb, onClick: () => run("interrupt") },
        { label: "Restart Kernel…", shortcut: "0, 0", disabled: !isNb, onClick: () => run("restart") },
        { label: "Restart Kernel and Clear Outputs of All Cells…", disabled: !isNb, onClick: () => run("restartClear") },
        { label: "Restart Kernel and Run up to Selected Cell…", disabled: !isNb, onClick: () => run("restartRunTo") },
        { label: "Restart Kernel and Run All Cells…", disabled: !isNb, onClick: () => run("restartRunAll") },
        "-",
        { label: "Reconnect to Kernel", disabled: !isNb, onClick: () => run("reconnect") },
        "-",
        { label: "Shut Down Kernel", disabled: !isNb, onClick: () => run("shutdown") },
        { label: "Shut Down All Kernels…", disabled: !kernels.length, onClick: () => void shutdownAll() },
        "-",
        { label: "Change Kernel… (Local CPU / Cloud CPU / CPU + GPU)", disabled: !isNb, onClick: () => run("changeKernel") },
      ],
    },
    {
      label: "Tabs",
      items: () => [
        { label: "Activate Next Tab", shortcut: K("Ctrl+Shift+]"), disabled: tabs.length < 2, onClick: () => setCurrent(tabs[(tabs.findIndex((t) => t.id === current) + 1) % tabs.length].id) },
        { label: "Activate Previous Tab", shortcut: K("Ctrl+Shift+["), disabled: tabs.length < 2, onClick: () => setCurrent(tabs[(tabs.findIndex((t) => t.id === current) - 1 + tabs.length) % tabs.length].id) },
        "-",
        ...tabs.map((t): MenuItem => ({ label: tabLabel(t), checked: t.id === current, onClick: () => setCurrent(t.id) })),
      ],
    },
    {
      label: "Settings",
      items: () => [
        {
          label: "Theme",
          submenu: [
            { label: "JupyterLab Light", checked: theme === "light", onClick: () => setTheme("light") },
            { label: "JupyterLab Dark", checked: theme === "dark", onClick: () => setTheme("dark") },
          ],
        },
        "-",
        { label: "Autosave Documents", checked: autosave, onClick: () => setAutosave((v) => !v) },
      ],
    },
    {
      label: "Help",
      items: () => [
        { label: "Keyboard Shortcuts", onClick: () => void showShortcuts() },
        "-",
        { label: "Jupyter Reference", onClick: () => window.open("https://jupyter.org/documentation", "_blank") },
        { label: "JupyterLab Reference", onClick: () => window.open("https://jupyterlab.readthedocs.io/en/stable/", "_blank") },
        { label: "IPython Reference", onClick: () => window.open("https://ipython.readthedocs.io/en/stable/", "_blank") },
        { label: "Markdown Reference", onClick: () => window.open("https://commonmark.org/help/", "_blank") },
        "-",
        {
          label: "About",
          onClick: () =>
            void dialogs.alert(
              "About this editor",
              <div>
                <p style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 8px" }}><JpIcon name="jupyter" style={{ width: 36, height: 42 }} /> A JupyterLab for BluesandAI Code Workspaces.</p>
                <p style={{ margin: 0 }}>Kernels: Python 3 (ipykernel), on the BluesandAI server (Local CPU) on a Google Compute Engine VM (Cloud CPU) or on a RunPod pod (Cloud CPU + GPU). Notebooks are nbformat 4 files saved on the platform.</p>
              </div>,
            ),
        },
      ],
    },
  ];

  // ---------------------------------------------------------------- sidebar resize
  const drag = (e: React.MouseEvent) => {
    const x0 = e.clientX;
    const w0 = panelWidth;
    const move = (ev: MouseEvent) => setPanelWidth(Math.max(180, Math.min(600, w0 + ev.clientX - x0)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onNbState = useCallback((path: string, s: NotebookState) => setNbStates((m) => ({ ...m, [path]: s })), []);
  const onFileState = useCallback((path: string, s: FileEditorState) => setFileStates((m) => ({ ...m, [path]: s })), []);
  const runningPaths = useMemo(() => new Set(kernels.filter((k) => k.state !== "dead").map((k) => k.path)), [kernels]);

  const sideTabs: { id: Panel; icon: IconName; title: string }[] = [
    { id: "files", icon: "folder", title: "File Browser (Ctrl+Shift+F)" },
    { id: "running", icon: "running", title: "Running Terminals and Kernels" },
    { id: "git", icon: "git", title: "Git: changes, commits, history and branches" },
    { id: "packages", icon: "package", title: "Packages: the workspace's Python environment (PyPI)" },
    { id: "toc", icon: "toc", title: "Table of Contents" },
    { id: "workspace", icon: "database", title: "BluesandAI Workspace: machine, datasets, models" },
  ];
  const kstate = nbState?.kstate ?? "none";
  const kernelText = !isNb ? null : `Python 3 (ipykernel) | ${({ idle: "Idle", busy: "Busy", starting: "Starting", restarting: "Restarting", dead: "Dead", none: "No Kernel", connecting: "Connecting", machine: "Starting machine" } as Record<string, string>)[kstate] ?? kstate}`;

  return (
    <>
      <div className="jp-TopPanel">
        <div className="jp-Logo" title="Jupyter"><JpIcon name="jupyter" style={{ width: 22, height: 26 }} /></div>
        <MenuBar menus={menus} />
        <div className="jp-TopPanel-right">
          <span title={w.path.join(" / ")}>{w.name}</span>
          <span>·</span>
          <Link href="/code-workspaces" title="All Jupyter workspaces"><JpIcon name="back" style={{ width: 14, height: 14 }} /> Workspaces</Link>
          <button type="button" title={theme === "light" ? "Switch to JupyterLab Dark" : "Switch to JupyterLab Light"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            {theme === "light" ? "☾" : "☀"}
          </button>
        </div>
      </div>
      <div className="jp-MainArea">
        <div className="jp-SideBar" role="tablist" aria-orientation="vertical">
          {sideTabs.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={panel === s.id} className={`jp-SideBar-tab${panel === s.id ? " jp-mod-current" : ""}`} title={s.title} onClick={() => setPanel((p) => (p === s.id ? null : s.id))}>
              <JpIcon name={s.icon} />
            </button>
          ))}
        </div>
        {panel && (
          <>
            <div className="jp-SidePanel" style={{ width: panelWidth }}>
              {panel === "files" && (
                <FileBrowser wid={wid} cwd={cwd} setCwd={setCwd} onOpen={open} onNewLauncher={newLauncher} running={runningPaths} refresh={refresh}
                  onChanged={() => setRefresh((r) => r + 1)} onRenamed={renamed} onDeleted={deleted} />
              )}
              {panel === "running" && (
                <>
                  <div className="jp-SidePanel-header">Running Terminals and Kernels</div>
                  <RunningPanel kernels={kernels} terminals={terminals} openTabs={tabs.map((t) => ({ id: t.id, label: tabLabel(t) }))}
                    onOpenTerminal={(t) => void openTerminal(t)}
                    onShutdownTerminal={async (t) => { await lab.shutdownTerminal(wid, t.id).catch(() => {}); setTabs((ts) => ts.filter((x) => !(x.kind === "terminal" && x.path === t.id))); loadKernels(); }}
                    onOpen={(p) => open({ path: p, type: "notebook" })} onShutdown={async (k) => { await lab.shutdown(wid, k.id).catch(() => {}); loadKernels(); }}
                    onShutdownAll={() => void shutdownAll()} onCloseTab={(id) => void closeTab(id)} onRefresh={loadKernels} />
                </>
              )}
              {panel === "git" && (
                <>
                  <div className="jp-SidePanel-header">Git</div>
                  <GitPanel wid={wid} refresh={refresh} isDirty={() => tabs.some((t) => tabDirty(t))} onOpen={(p) => open({ path: p, type: p.endsWith(".ipynb") ? "notebook" : "file" })}
                    onRestored={(p) => { reloadPath(p); setRefresh((r) => r + 1); }} onSwitched={() => { reloadAll(); setRefresh((r) => r + 1); void lab.syncPackages(wid).catch(() => {}); }} />
                </>
              )}
              {panel === "packages" && (
                <>
                  <div className="jp-SidePanel-header">Packages</div>
                  <PackagesPanel wid={wid} />
                </>
              )}
              {panel === "toc" && (
                <>
                  <div className="jp-SidePanel-header">Table of Contents</div>
                  <TocPanel title={isNb && tab ? baseName(tab.path) : null} headings={nbState?.headings ?? []} active={nbState?.activeHeading ?? -1} onPick={(h) => nbOf()?.scrollToCell(h.cell)} />
                </>
              )}
              {panel === "workspace" && (
                <>
                  <div className="jp-SidePanel-header">BluesandAI Workspace</div>
                  <WorkspacePanel w={w} options={options} onChanged={setW} />
                </>
              )}
            </div>
            <div className="jp-Splitter" onMouseDown={drag} />
          </>
        )}
        <div className="jp-DockArea">
          {tabs.length > 0 && (
            <div className="jp-TabBar" role="tablist">
              {tabs.map((t) => {
                const dirty = tabDirty(t);
                const label = tabLabel(t);
                return (
                  <div key={t.id} role="tab" aria-selected={t.id === current} className={`jp-TabBar-tab${t.id === current ? " jp-mod-current" : ""}`} title={t.kind === "launcher" ? "Launcher" : `Name: ${label}\nPath: ${t.path}`}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        void closeTab(t.id);
                      } else setCurrent(t.id);
                    }}>
                    <JpIcon name={t.kind === "launcher" ? "home" : t.kind === "terminal" ? "terminal" : fileIcon(t.path, t.kind === "notebook" ? "notebook" : "file")} />
                    <span className="jp-TabBar-tabLabel">{label}</span>
                    <button type="button" className={`jp-TabBar-tabClose${dirty ? " jp-mod-dirty" : ""}`} title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(t.id)}>
                      {dirty && <span className="jp-TabBar-dirty" />}
                      <JpIcon name="close" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="jp-DockPanel">
            {tabs.length === 0 && <div className="jp-DockPanel-widget" style={{ background: "var(--jp-layout-color3)" }} />}
            {tabs.map((t) => (
              <div key={t.id} className="jp-DockPanel-widget" style={{ display: t.id === current ? "flex" : "none" }}>
                {t.kind === "launcher" && <Launcher cwd={cwd} onCreate={create} onTerminal={(x) => void openTerminal(x)} cloudReady={w.pod?.status === "running"} />}
                {t.kind === "terminal" && (
                  <TerminalView ref={(h) => { if (h) handles.current.set(t.id, h); else handles.current.delete(t.id); }} wid={wid} tid={t.path} active={t.id === current} theme={theme} />
                )}
                {t.kind === "notebook" && (
                  <Notebook
                    ref={(h) => { if (h) handles.current.set(t.id, h); else handles.current.delete(t.id); }}
                    wid={wid} path={t.path} active={t.id === current} workspace={w} options={options} simple={simple} autosave={autosave} theme={theme}
                    onState={onNbState} startMachine={startMachine} onKernelsChanged={loadKernels} onRename={() => void renameCurrent()} onSaveAs={(c) => void saveAs(c)}
                  />
                )}
                {t.kind === "file" && (
                  <FileEditor ref={(h) => { if (h) handles.current.set(t.id, h); else handles.current.delete(t.id); }} wid={wid} path={t.path} active={t.id === current} onState={onFileState} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      {statusBar && (
        <div className="jp-StatusBar">
          <button type="button" className="jp-StatusBar-item" title="Simple Interface (Ctrl+Shift+D)" onClick={() => setSimple((v) => !v)}>
            Simple <span className={`jp-Switch${simple ? " jp-mod-on" : ""}`} />
          </button>
          <button type="button" className="jp-StatusBar-item" title={`${kernels.length} kernel${kernels.length === 1 ? "" : "s"} running`} onClick={() => setPanel("running")}>
            {terminals.length} <JpIcon name="terminal" style={{ width: 14, height: 14 }} /> {kernels.length} <JpIcon name="running" style={{ width: 14, height: 14 }} />
          </button>
          {isNb && (
            <button type="button" className="jp-StatusBar-item" title="Change kernel / compute" onClick={() => run("changeKernel")}>
              {kernelText}
              <span className="jp-Muted">· {nbState?.compute === "local" ? "Local CPU" : nbState?.compute === "cloud-gpu" ? "Cloud CPU + GPU" : "Cloud CPU"}</span>
            </button>
          )}
          {w.pod && <span className="jp-StatusBar-item jp-Muted"><JpIcon name="cloud" style={{ width: 14, height: 14 }} /> {machineLabel(w.pod)}: {w.pod.status}{w.pod.cost_per_hr != null && w.pod.status === "running" ? ` · $${w.pod.cost_per_hr.toFixed(2)}/h` : ""}</span>}
          <div className="jp-StatusBar-right">
            {isNb && <span className="jp-StatusBar-item">Mode: {nbState?.mode === "edit" ? "Edit" : "Command"}</span>}
            {(isNb || tab?.kind === "file") && <span className="jp-StatusBar-item">Ln {(nbState ?? fileState)?.line ?? 1}, Col {(nbState ?? fileState)?.col ?? 1}</span>}
            {tab && tab.kind !== "launcher" && <span className="jp-StatusBar-item">{tabLabel(tab)}</span>}
          </div>
        </div>
      )}
    </>
  );
}

function Launcher({ cwd, onCreate, onTerminal, cloudReady }: { cwd: string; onCreate: (type: "notebook" | "file", ext?: string) => void; onTerminal: (target: "local" | "cloud") => void; cloudReady: boolean }) {
  const card = (icon: IconName, label: string, onClick: () => void) => (
    <button type="button" className="jp-LauncherCard" title={label} onClick={onClick}>
      <div className="jp-LauncherCard-icon"><JpIcon name={icon} /></div>
      <div className="jp-LauncherCard-label">{label}</div>
    </button>
  );
  return (
    <div className="jp-Launcher">
      <div className="jp-Launcher-section">
        <div className="jp-Launcher-sectionHeader"><JpIcon name="notebook" /> Notebook</div>
        <div className="jp-Launcher-cardContainer">{card("python", "Python 3 (ipykernel)", () => onCreate("notebook"))}</div>
      </div>
      <div className="jp-Launcher-section">
        <div className="jp-Launcher-sectionHeader"><JpIcon name="file" style={{ fill: "var(--jp-icon-color)" }} /> Other</div>
        <div className="jp-Launcher-cardContainer">
          {card("file", "Text File", () => onCreate("file", ".txt"))}
          {card("markdown", "Markdown File", () => onCreate("file", ".md"))}
          {card("python", "Python File", () => onCreate("file", ".py"))}
          {card("terminal", "Terminal", () => onTerminal("local"))}
          {cloudReady && card("terminal", "Terminal (cloud machine)", () => onTerminal("cloud"))}
        </div>
      </div>
      <p className="jp-Launcher-note">New files go in /{cwd}. A notebook runs on Local CPU by default; switch to Cloud CPU (Google Cloud) or Cloud CPU + GPU (RunPod) with the compute button in its toolbar.</p>
    </div>
  );
}
