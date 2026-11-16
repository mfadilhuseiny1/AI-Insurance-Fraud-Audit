"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cloneNodes, fitWires, importNodes, newNode, type FlowNode } from "@/lib/flow";
import { FlowRuntime, type DebugEntry, type NodeStatus } from "@/lib/flowRuntime";
import type { Pipeline } from "@/lib/pipeline";
import { savePipelineFile } from "@/lib/pipelineFiles";
import { Icon, type IconName } from "../Icon";
import { buttonClass, Modal } from "../pipeline/Modal";
import { FlowCanvas, type WireRef } from "./FlowCanvas";
import { FlowPalette } from "./FlowPalette";
import { FlowSidebar, type Reading, type SidebarTab } from "./FlowSidebar";
import { NodeTray } from "./NodeTray";

const MAX_DEBUG = 500;
const MAX_POINTS = 60;

const typingIn = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

/** What a deploy depends on: positions, debug on/off and the dataset file a run wrote do not need a redeploy. */
const deployKey = (n: FlowNode) => {
  const { x: _x, y: _y, active: _a, itemId: _i, parentId: _p, ...rest } = n;
  void [_x, _y, _a, _i, _p];
  return JSON.stringify(rest);
};

type Alert = { id: number; text: string; level: string };

/** A device stream pipeline: Node-RED's editor — palette, canvas, sidebar — over the pipeline file. */
export function FlowBuilder({ initial }: { initial: Pipeline }) {
  const [pipeline, setPipeline] = useState<Pipeline>(() => ({ ...initial, flow: initial.flow ?? { nodes: [] } }));
  const [past, setPast] = useState<Pipeline[]>([]);
  const [future, setFuture] = useState<Pipeline[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [wire, setWire] = useState<WireRef | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<SidebarTab>("info");
  const [clipboard, setClipboard] = useState<{ nodes: FlowNode[]; pastes: number }>({ nodes: [], pastes: 0 });
  const [dialog, setDialog] = useState<"import" | "export" | null>(null);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok?: boolean } | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  // runtime: the deploy keys of the running flow (null = stopped), and what it reports
  const runtime = useRef<FlowRuntime | null>(null);
  const [deployed, setDeployed] = useState<Map<string, string> | null>(null);
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [debug, setDebug] = useState<DebugEntry[]>([]);
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const [delivered, setDelivered] = useState(0);
  const pending = useRef<{ debug: DebugEntry[]; statuses: Record<string, NodeStatus>; readings: boolean }>({ debug: [], statuses: {}, readings: false });
  // every device reading seen, kept across deploys; copied into state when it changes
  const readingStore = useRef(new Map<string, Reading>());
  const debugId = useRef(0);

  // the version last written to the pipeline file, or the one that failed to save
  const [persisted, setPersisted] = useState<{ version: Pipeline; failed: boolean }>({ version: pipeline, failed: false });
  const [writing, setWriting] = useState(false);
  const saveState = persisted.failed && persisted.version === pipeline ? "error" : persisted.version === pipeline ? "saved" : "saving";

  useEffect(() => {
    if (pipeline === persisted.version || writing) return;
    const t = setTimeout(async () => {
      setWriting(true);
      try {
        await savePipelineFile(pipeline);
        setPersisted({ version: pipeline, failed: false });
      } catch (e) {
        setPersisted({ version: pipeline, failed: true });
        setNotice({ text: `Not saved: ${(e as Error).message}` });
      } finally {
        setWriting(false);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [pipeline, persisted.version, writing]);

  useEffect(() => {
    if (saveState === "saved" && !deployed) return;
    // unsaved changes, or a running flow that stops with the tab
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState, deployed]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.ok ? 4000 : 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // runtime reports arrive in bursts: folded into state a few times a second
  useEffect(() => {
    const t = setInterval(() => {
      const p = pending.current;
      if (p.debug.length) {
        const add = p.debug.splice(0);
        setDebug((d) => [...d, ...add].slice(-MAX_DEBUG));
      }
      if (Object.keys(p.statuses).length) {
        const s = p.statuses;
        p.statuses = {};
        setStatuses((old) => ({ ...old, ...s }));
      }
      if (p.readings) {
        p.readings = false;
        setReadings(Object.fromEntries(readingStore.current));
      }
      if (runtime.current) setDelivered(runtime.current.delivered);
    }, 250);
    return () => clearInterval(t);
  }, []);

  // the flow stops with the page
  useEffect(() => () => void runtime.current?.stop(), []);

  const nodes = useMemo(() => pipeline.flow?.nodes ?? [], [pipeline.flow]);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const change = (fn: (p: Pipeline) => Pipeline, record = true) => {
    if (record) {
      setPast((h) => [...h.slice(-49), pipeline]);
      setFuture([]);
    }
    setPipeline((p) => fn(p));
  };
  const setNodes = (fn: (ns: FlowNode[]) => FlowNode[], record = true) => change((p) => ({ ...p, flow: { nodes: fn(p.flow?.nodes ?? []) } }), record);

  const undo = () => {
    if (!past.length) return;
    setFuture([pipeline, ...future]);
    setPipeline(past[past.length - 1]);
    setPast(past.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast([...past, pipeline]);
    setPipeline(future[0]);
    setFuture(future.slice(1));
  };

  const changed = useMemo(() => {
    if (!deployed) return new Set<string>();
    return new Set(nodes.filter((n) => deployed.get(n.id) !== deployKey(n)).map((n) => n.id));
  }, [nodes, deployed]);
  const removedSinceDeploy = !!deployed && [...deployed.keys()].some((id) => !nodes.some((n) => n.id === id));
  const dirty = !deployed || changed.size > 0 || removedSinceDeploy;

  // ---------------------------------------------------------------- editing

  const addNode = (type: string, x?: number, y?: number) => {
    const n = newNode(type, x ?? 160 + (nodes.length % 6) * 30, y ?? 100 + (nodes.length % 10) * 40);
    setNodes((ns) => [...ns, n]);
    setSelected([n.id]);
    setWire(null);
  };

  const removeNodes = (ids: string[]) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    setNodes((ns) => ns.filter((n) => !gone.has(n.id)).map((n) => ({ ...n, wires: n.wires.map((p) => p.filter((t) => !gone.has(t))) })));
    setSelected([]);
  };

  const removeWire = (w: WireRef) => {
    setNodes((ns) => ns.map((n) => (n.id === w.from ? { ...n, wires: n.wires.map((p, i) => (i === w.port ? p.filter((t) => t !== w.to) : p)) } : n)));
    setWire(null);
  };

  const connect = (w: WireRef) =>
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== w.from) return n;
        const f = fitWires(n);
        return { ...f, wires: f.wires.map((p, i) => (i === w.port && !p.includes(w.to) ? [...p, w.to] : p)) };
      }),
    );

  const paste = (copies: FlowNode[], offset: number) => {
    if (!copies.length) return;
    const fresh = cloneNodes(copies, offset, offset);
    setNodes((ns) => [...ns, ...fresh]);
    setSelected(fresh.map((n) => n.id));
  };

  const reveal = (id: string) => {
    setSelected([id]);
    const n = byId.get(id);
    const el = document.getElementById("flow-canvas")?.firstElementChild as HTMLElement | null;
    if (n && el) el.scrollTo({ left: n.x * zoom - el.clientWidth / 2, top: n.y * zoom - el.clientHeight / 2, behavior: "smooth" });
  };

  // ---------------------------------------------------------------- runtime

  const deploy = useCallback(async () => {
    await runtime.current?.stop();
    pending.current = { debug: [], statuses: {}, readings: false };
    setStatuses({});
    const flow = { nodes };
    const rt = new FlowRuntime(flow, {
      location: pipeline.location,
      debug: (e) => pending.current.debug.push({ ...e, id: ++debugId.current }),
      status: (id, s) => (pending.current.statuses[id] = s),
      alert: (text, level) => {
        const id = ++debugId.current;
        setAlerts((a) => [...a.slice(-4), { id, text, level }]);
        setTimeout(() => setAlerts((a) => a.filter((x) => x.id !== id)), 8000);
      },
      telemetry: (device, metric, value, unit) => {
        const key = `${device}\u0000${metric}`;
        const r = readingStore.current.get(key) ?? { device, metric, unit, values: [] };
        readingStore.current.set(key, { ...r, unit: unit ?? r.unit, values: [...r.values, { t: Date.now(), v: value }].slice(-MAX_POINTS) });
        pending.current.readings = true;
      },
      datasetWritten: (nodeId, itemId, parentId) =>
        setPipeline((p) => ({ ...p, flow: { nodes: (p.flow?.nodes ?? []).map((n) => (n.id === nodeId ? { ...n, itemId, parentId } : n)) } })),
    });
    runtime.current = rt;
    rt.start();
    setDeployed(new Map(nodes.map((n) => [n.id, deployKey(n)])));
    setNotice({ text: "Deployed — the flow runs in this tab while it is open.", ok: true });
  }, [nodes, pipeline.location]);

  const stop = async () => {
    await runtime.current?.stop();
    runtime.current = null;
    setDeployed(null);
    setStatuses({});
    setNotice({ text: "Flow stopped.", ok: true });
  };

  const nodeButton = (id: string) => {
    const n = byId.get(id);
    if (!n) return;
    if (n.type === "debug") {
      const on = n.active === false;
      runtime.current?.setDebugActive(id, on);
      setNodes((ns) => ns.map((x) => (x.id === id ? { ...x, active: on } : x)), false);
    } else if (!runtime.current || changed.has(id)) setNotice({ text: runtime.current ? "This node has changes — deploy them first." : "Deploy the flow first." });
    else runtime.current.trigger(id);
  };

  // ---------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e) || editing || dialog) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (mod && key === "a") {
        e.preventDefault();
        setSelected(nodes.map((n) => n.id));
      } else if (mod && (key === "c" || key === "x") && selected.length) {
        setClipboard({ nodes: nodes.filter((n) => selected.includes(n.id)), pastes: 0 });
        if (key === "x") removeNodes(selected);
      } else if (mod && key === "v" && clipboard.nodes.length) {
        e.preventDefault();
        paste(clipboard.nodes, 20 * (clipboard.pastes + 1));
        setClipboard((c) => ({ ...c, pastes: c.pastes + 1 }));
      } else if (mod && key === "d") {
        e.preventDefault();
        void deploy();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (wire) removeWire(wire);
        else removeNodes(selected);
      } else if (e.key === "Enter" && selected.length === 1) setEditing(selected[0]);
      else if (e.key === "Escape") {
        setSelected([]);
        setWire(null);
        setMenu(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const editNode = editing ? byId.get(editing) : undefined;
  const readingList = Object.values(readings);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-5 text-sm">
        <Link href="/pipeline" className="text-muted hover:text-white">
          Pipeline Builder
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <input
          value={pipeline.name}
          onChange={(e) => change((p) => ({ ...p, name: e.target.value }), false)}
          onBlur={(e) => !e.target.value.trim() && change((p) => ({ ...p, name: "Pipeline" }), false)}
          className="w-56 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-medium outline-none hover:border-line-2 focus:border-ocean"
        />
        <span className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-xs text-soft ring-1 ring-line-2">
          <Icon name="signal" className="h-3 w-3 text-ocean" /> Device stream
        </span>
        {pipeline.location && (
          <Link
            href={pipeline.location.id ? `/files/${pipeline.location.id}` : "/files"}
            title="The pipeline's folder in Files & Projects: dataset nodes write here"
            className="flex min-w-0 items-center gap-1 truncate text-xs text-muted hover:text-ocean"
          >
            <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-sand" />
            <span className="truncate">{pipeline.location.name}</span>
          </Link>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span
            className={`flex items-center gap-1.5 text-xs ${saveState === "error" ? "text-bad" : "text-muted"}`}
            title={`Saved to ${pipeline.name.trim() || "Pipeline"}.pipeline in Files & Projects`}
          >
            <Icon name={saveState === "error" ? "alert" : saveState === "saving" ? "refresh" : "check"} className="h-3.5 w-3.5" />
            {saveState === "error" ? "Not saved" : saveState === "saving" ? "Saving…" : "Saved"}
          </span>
          <HeaderButton icon="left" label="Undo" onClick={undo} disabled={!past.length} />
          <HeaderButton icon="right" label="Redo" onClick={redo} disabled={!future.length} />
          <span
            className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ${deployed ? "text-ok ring-ok/40" : "text-muted ring-line-2"}`}
            title={deployed ? `${delivered.toLocaleString()} messages delivered` : "Not running"}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${deployed ? "animate-pulse bg-ok" : "bg-muted"}`} />
            {deployed ? `Running · ${delivered.toLocaleString()} msgs` : "Stopped"}
          </span>
          {deployed && (
            <button type="button" onClick={stop} className={buttonClass.secondary} title="Stop the flow">
              <Icon name="stop" className="h-3.5 w-3.5" /> Stop
            </button>
          )}
          <div className="relative flex">
            <button
              type="button"
              onClick={() => void deploy()}
              disabled={!nodes.length}
              title="Deploy and run the flow (Ctrl+D)"
              className={`${buttonClass.primary} rounded-r-none ${dirty ? "" : "bg-ocean/60"}`}
            >
              <Icon name="upload" className="h-3.5 w-3.5" />
              Deploy
              {deployed && dirty && <span className="h-1.5 w-1.5 rounded-full bg-sand" title="Changes not deployed" />}
            </button>
            <button type="button" onClick={() => setMenu((m) => !m)} className={`${buttonClass.primary} rounded-l-none border-l border-ink/30 px-1.5`} title="Menu">
              <Icon name="down" className="h-3.5 w-3.5" />
            </button>
            {menu && (
              <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-line-2 bg-panel py-1 text-sm shadow-xl" onMouseLeave={() => setMenu(false)}>
                <MenuItem icon="download" label="Import…" onClick={() => (setDialog("import"), setMenu(false))} />
                <MenuItem icon="upload" label={selected.length ? "Export selected…" : "Export flow…"} onClick={() => (setDialog("export"), setMenu(false))} />
                <MenuItem icon="trash" label="Clear debug" onClick={() => (setDebug([]), setMenu(false))} />
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <FlowPalette onAdd={(type) => addNode(type)} />

        <div className="relative flex min-w-0 flex-1 flex-col">
          <div id="flow-canvas" className="flex min-h-0 flex-1">
            <FlowCanvas
              nodes={nodes}
              selected={selected}
              wire={wire}
              zoom={zoom}
              statuses={deployed ? statuses : {}}
              changed={changed}
              onSelect={(ids) => setSelected(ids)}
              onSelectWire={setWire}
              onMoveStart={() => change((p) => p)}
              onMove={(pos) => setNodes((ns) => ns.map((n) => (pos[n.id] ? { ...n, ...pos[n.id] } : n)), false)}
              onConnect={connect}
              onOpen={setEditing}
              onDrop={(type, x, y) => addNode(type, x, y)}
              onButton={nodeButton}
            />
          </div>
          <div className="flex h-8 shrink-0 items-center gap-1 border-t border-line bg-panel px-3 text-xs text-muted">
            <span className="truncate">
              {wire ? "Wire selected — Delete removes it" : selected.length ? `${selected.length} selected — Enter edits, Delete removes` : "Drag nodes from the palette · drag from an output port to wire"}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <HeaderButton icon="minus" label="Zoom out" onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(1)))} />
              <button type="button" onClick={() => setZoom(1)} className="w-10 text-center tabular-nums hover:text-white">
                {Math.round(zoom * 100)}%
              </button>
              <HeaderButton icon="plus" label="Zoom in" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(1)))} />
            </div>
          </div>

          {(notice || alerts.length > 0) && (
            <div className="pointer-events-none absolute right-3 top-3 z-10 flex w-80 flex-col gap-2">
              {alerts.map((a) => (
                <div
                  key={a.id}
                  className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg ${
                    a.level === "critical" ? "border-bad bg-bad/20 text-white" : a.level === "info" ? "border-ocean/50 bg-panel text-soft" : "border-warn/60 bg-panel text-warn"
                  }`}
                >
                  <Icon name="bell" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{a.text}</span>
                </div>
              ))}
              {notice && (
                <div className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-panel px-3 py-2 text-xs shadow-lg ${notice.ok ? "border-ok/40 text-ok" : "border-bad/40 text-bad"}`}>
                  <Icon name={notice.ok ? "check" : "alert"} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{notice.text}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="relative flex">
          <FlowSidebar
            tab={tab}
            onTab={setTab}
            nodes={nodes}
            selected={selected}
            debug={debug}
            readings={readingList}
            running={!!deployed}
            onClearDebug={() => setDebug([])}
            onReveal={reveal}
          />
          {editNode && (
            <NodeTray
              key={editNode.id}
              node={editNode}
              onCancel={() => setEditing(null)}
              onDelete={() => {
                removeNodes([editNode.id]);
                setEditing(null);
              }}
              onDone={(n) => {
                setNodes((ns) => ns.map((x) => (x.id === n.id ? n : x)));
                setEditing(null);
              }}
            />
          )}
        </div>
      </div>

      {dialog === "import" && (
        <ImportDialog
          onClose={() => setDialog(null)}
          onImport={(text) => {
            const { nodes: imported, skipped } = importNodes(text);
            if (!imported.length) throw new Error("No nodes found in that JSON");
            paste(imported, 0);
            setDialog(null);
            setNotice({ text: `Imported ${imported.length} node${imported.length > 1 ? "s" : ""}${skipped ? ` (${skipped} tabs / config nodes left out)` : ""}.`, ok: true });
          }}
        />
      )}
      {dialog === "export" && <ExportDialog nodes={selected.length ? nodes.filter((n) => selected.includes(n.id)) : nodes} name={pipeline.name} onClose={() => setDialog(null)} />}
    </div>
  );
}

function HeaderButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} className="rounded p-1.5 text-soft hover:bg-panel-2 hover:text-white disabled:opacity-30">
      <Icon name={icon} className="h-3.5 w-3.5" />
    </button>
  );
}

function MenuItem({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-soft hover:bg-panel-2 hover:text-white">
      <Icon name={icon} className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (text: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Import nodes" icon="download" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted">Paste a flow exported from Node-RED (Menu → Export) or from another device pipeline. Credentials are not part of a Node-RED export — re-enter broker passwords after importing.</p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={14}
          placeholder='[{"id":"…","type":"inject","x":120,"y":80,"wires":[["…"]]}]'
          className="w-full rounded-md border border-line-2 bg-ink p-2.5 font-mono text-xs outline-none focus:border-ocean"
        />
        <label className={`${buttonClass.ghost} cursor-pointer`}>
          <Icon name="upload" className="h-3.5 w-3.5" /> Choose a .json file
          <input type="file" accept=".json,application/json" className="hidden" onChange={async (e) => e.target.files?.[0] && setText(await e.target.files[0].text())} />
        </label>
        {error && (
          <p className="flex items-center gap-2 text-sm text-bad">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => {
              try {
                onImport(text);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ExportDialog({ nodes, name, onClose }: { nodes: FlowNode[]; name: string; onClose: () => void }) {
  // credentials stay out of exports, as in Node-RED
  const text = JSON.stringify(
    nodes.map(({ password: _p, itemId: _i, parentId: _pa, ...n }) => (void [_p, _i, _pa], n)),
    null,
    2,
  );
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={`Export ${nodes.length} node${nodes.length === 1 ? "" : "s"}`} icon="upload" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted">Node-RED JSON — import it into another device pipeline, or into Node-RED for the node types both have. Passwords are left out.</p>
        <pre className="max-h-[50vh] overflow-auto rounded-md border border-line-2 bg-ink p-2.5 font-mono text-xs text-soft">{text}</pre>
        <div className="flex justify-end gap-2">
          <a href={`data:application/json;charset=utf-8,${encodeURIComponent(text)}`} download={`${name || "flow"}.json`} className={buttonClass.secondary}>
            <Icon name="download" className="h-3.5 w-3.5" /> Download
          </a>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            }}
            className={buttonClass.primary}
          >
            <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy to clipboard"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
