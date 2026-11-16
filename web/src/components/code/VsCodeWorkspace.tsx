"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { JupyterAssist } from "@/components/code/JupyterAssist";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { codeWorkspaces, editorUrl, type EditorEngine, type VsCodeState, type Workspace } from "@/lib/codeWorkspaces";
import { readTheme, type Theme } from "@/lib/theme";

const ENGINE: Record<EditorEngine, { label: string; icon: IconName; accent: string; blurb: string; frameBg: string }> = {
  vscode: {
    label: "VS Code",
    icon: "code",
    accent: "#d946ef",
    blurb: "VS Code with this workspace's files, running on the platform's machine. It uses no memory until you start it, and stops by itself after the idle minutes without editing. Files and VS Code settings are kept between sessions.",
    frameBg: "#1e1e1e",
  },
  nodered: {
    label: "Node-RED",
    icon: "signal",
    accent: "#8f0000",
    blurb: "Node-RED with its flows, wires, deploy and debug, and the palette manager for node-red-contrib plugins (Menu → Manage palette). It runs on the platform's machine and keeps running your flows until you press Stop. Flows, credentials and installed nodes are kept between sessions; this workspace's files are at /data/files.",
    frameBg: "#f3f3f3",
  },
  jupyterlab: {
    label: "JupyterLab (Docker)",
    icon: "code",
    accent: "#f37626",
    blurb: "JupyterLab in a Docker container on the platform's machine, in an image built from the training environment it audits (the same Python and library versions). It stops by itself after the idle minutes; the files are kept.",
    frameBg: "#ffffff",
  },
};

/** The platform's theme, followed live (the html data-theme attribute ThemeToggle sets). */
function usePlatformTheme(): Theme {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the theme the boot script applied
    setTheme(readTheme());
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/** An editor Code Workspace — VS Code (code-server) or Node-RED — running on the platform's machine, embedded in the
 *  page and relayed by the API under the platform's sign-in (api/code_workspace_vscode.py). Nothing runs until Start;
 *  VS Code stops by itself after the idle minutes, Node-RED keeps its flows running until Stop. Node-RED follows the
 *  platform's dark / light theme. */
export function EditorWorkspace({
  workspace,
  engine,
  header,
  beforeShow,
  intro,
  open,
}: {
  workspace: Workspace;
  engine: EditorEngine;
  /** JupyterLab: the file it opens (ML Studio → Notebook) */
  open?: string | null;
  /** the app it is shown in (a Device stream: Pipeline Builder) */
  header?: { app: string; icon: IconName; href: string; crumbs: { label: string; href?: string }[] };
  /** runs once the editor is up, before it is shown (a Device stream's first flow goes in) */
  beforeShow?: () => Promise<void>;
  /** replaces the engine's description on the start screen */
  intro?: string;
}) {
  const e = ENGINE[engine];
  const back = header?.href ?? "/code-workspaces";
  const theme = usePlatformTheme();
  const [st, setSt] = useState<VsCodeState | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => codeWorkspaces.editor(engine, workspace.id).then(setSt, (x: Error) => setErr(x.message)), [engine, workspace.id]);
  useEffect(() => {
    void load();
    // a stopped editor (idle, or stopped elsewhere) shows as stopped without a reload
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (what: "start" | "stop") => {
    setBusy(what);
    setErr(null);
    try {
      setSt(await (what === "start" ? codeWorkspaces.editorStart(engine, workspace.id) : codeWorkspaces.editorStop(engine, workspace.id)));
      await load();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const up = st?.status === "running";
  // beforeShow: done (or nothing to do) for the editor started at this time
  const [shownFor, setShownFor] = useState<string | null>(null);
  const startedAt = st?.started_at ?? "";
  useEffect(() => {
    if (!up || !beforeShow || shownFor === startedAt) return;
    let live = true;
    beforeShow().then(
      () => live && setShownFor(startedAt),
      (x: Error) => live && (setErr(x.message), setShownFor(startedAt)),
    );
    return () => {
      live = false;
    };
  }, [up, beforeShow, shownFor, startedAt]);
  const running = up && (!beforeShow || shownFor === startedAt);
  // JupyterLab (Docker): its image is built once per training environment before it can start
  const building = !up && st?.image_status === "building";
  useEffect(() => {
    if (!building) return;
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [building, load]);
  const idleText = st && st.idle_minutes > 0 ? ` · stops after ${st.idle_minutes} idle min` : " · runs until stopped";
  // JupyterLab's AI assistant beside the frame (JupyterAssist): open unless closed before, in this browser
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [loads, setLoads] = useState(0);
  const [assist, setAssist] = useState(true);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the choice kept in this browser
      setAssist(localStorage.getItem("bluesandai.jupyter-assist.open") !== "0");
    } catch {
      /* no storage: open */
    }
  }, []);
  const toggleAssist = () =>
    setAssist((o) => {
      try {
        localStorage.setItem("bluesandai.jupyter-assist.open", o ? "0" : "1");
      } catch {
        /* no storage: for this page only */
      }
      return !o;
    });
  const withAssist = engine === "jupyterlab" && running;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-vscode-workspace={engine === "vscode" ? workspace.id : undefined} data-editor-workspace={engine}>
      <AppHeader app={header?.app ?? "Code Workspaces"} icon={header?.icon ?? "code"} href={back} crumbs={header?.crumbs ?? [{ label: workspace.name }]}>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
          <span className={`h-2 w-2 rounded-full ${running ? "bg-ok" : "bg-line-2"}`} />
          {st ? (running ? `${e.label} running${idleText}` : up ? `Setting up ${e.label}…` : "Stopped") : "…"}
        </span>
        {withAssist && (
          <button type="button" onClick={toggleAssist} aria-pressed={assist} data-editor-assist title="The AI assistant beside the notebook: write, edit, run and explain code"
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${assist ? "border-violet-400/70 bg-violet-500/20 text-violet-100" : "border-violet-400/40 bg-violet-500/10 text-violet-200 hover:border-violet-300"}`}>
            <Icon name="sparkle" className="h-3.5 w-3.5" /> AI Assistant
          </button>
        )}
        <Link href={back} className={buttonClass.secondary} data-editor-back
          title={running ? `Back to ${header?.app ?? "Code Workspaces"} — ${e.label} keeps running` : `Back to ${header?.app ?? "Code Workspaces"}`}>
          <Icon name="left" className="h-3.5 w-3.5" /> Back
        </Link>
        {up ? (
          <button type="button" disabled={!!busy} onClick={() => act("stop")} className={buttonClass.secondary} data-vscode-stop data-editor-stop>
            <Icon name="stop" className="h-3.5 w-3.5" /> {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button type="button" disabled={!!busy || building || st?.image_status === "failed" || st?.can_run_code === false} onClick={() => act("start")} className={buttonClass.primary} data-vscode-start data-editor-start
            title={st?.can_run_code === false ? "Running code on the platform's machine is limited (Control Panel → Security → Code execution)" : undefined}>
            <Icon name="play" className="h-3.5 w-3.5" /> {busy === "start" ? "Starting…" : `Start ${e.label}`}
          </button>
        )}
      </AppHeader>
      {err && <p className="border-b border-bad/30 bg-bad/10 px-5 py-2 text-xs text-bad">{err}</p>}
      {running ? (
        <div className="flex min-h-0 flex-1">
          <iframe
            // a new theme reloads Node-RED's editor in it (VS Code keeps its own)
            key={`${st?.started_at}-${engine === "nodered" ? theme : ""}`}
            ref={frame}
            onLoad={() => setLoads((n) => n + 1)}
            src={editorUrl(engine, workspace.id, theme, open)}
            title={`${e.label} · ${workspace.name}`}
            className="min-h-0 min-w-0 flex-1 border-0"
            style={{ background: engine === "nodered" && theme === "dark" ? "#1e1e1e" : e.frameBg }}
            allow="clipboard-read; clipboard-write"
            data-vscode-frame={engine === "vscode" ? "" : undefined}
            data-editor-frame={engine}
          />
          {withAssist && assist && <JupyterAssist workspaceId={workspace.id} frame={frame} loads={loads} onClose={toggleAssist} />}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: `${e.accent}26`, color: e.accent }}>
              <Icon name={e.icon} className="h-7 w-7" />
            </span>
            <h1 className="mt-4 text-lg font-semibold text-strong">{workspace.name}</h1>
            <p className="mt-1 text-sm text-muted">{intro ?? e.blurb}</p>
            {st?.can_run_code === false && <p className="mt-3 text-xs text-warn">Your account may not run code on this machine (Control Panel → Security → Code execution).</p>}
            {building && <p className="mt-3 text-xs text-muted" data-editor-image="building">Building the image of the training environment ({st?.image}) — a few minutes the first time.</p>}
            {st?.image_status === "failed" && <p className="mt-3 whitespace-pre-wrap text-left font-mono text-[11px] text-bad" data-editor-image="failed">The image could not be built: {st.image_error}</p>}
            <button type="button" disabled={!!busy || up || building || st?.image_status === "failed" || st?.can_run_code === false} onClick={() => act("start")} className={`${buttonClass.primary} mt-5`}>
              <Icon name="play" className="h-3.5 w-3.5" /> {busy === "start" ? "Starting… (up to a minute)" : up ? "Setting up…" : `Start ${e.label}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function VsCodeWorkspace({ workspace }: { workspace: Workspace }) {
  return <EditorWorkspace workspace={workspace} engine="vscode" />;
}
