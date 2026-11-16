"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { machineLabel as podLabel, type Workspace, type WorkspaceOptions } from "@/lib/codeWorkspaces";
import {
  emptyCell, lab, newId, normalizeNotebook, serializeNotebook,
  type Cell, type KernelInfo, type KernelMsg, type MimeBundle, type NotebookJSON, type Output, type Target,
} from "@/lib/jupyterLab";
import { CellEditor, type CellEditorHandle, type CompleteFn, type EditorKeys, type InspectFn } from "./CellEditor";
import { JpIcon } from "./icons";
import { InspectTooltip, MarkdownView, OutputView } from "./render";
import { DialogBox, Menu, useDialogs, type MenuItem } from "./ui";

/** What the compute picker chooses: this platform's machine, a Compute Engine VM (Cloud CPU) or a RunPod pod (Cloud CPU + GPU). */
export type ComputeChoice = { target: "local" } | { target: "cloud"; kind: "cpu"; vcpus: number; spot: boolean } | { target: "cloud"; kind: "gpu"; gpu_type: string };
export type NotebookState = { dirty: boolean; mode: "command" | "edit"; line: number; col: number; kernel: KernelInfo | null; kstate: string; compute: string; cells: number; headings: Heading[]; activeHeading: number };
export type Heading = { level: number; text: string; cell: number; id: string };
export type NotebookHandle = {
  command: (name: string) => void; save: (checkpoint?: boolean) => Promise<void>; content: () => NotebookJSON; focus: () => void; scrollToCell: (i: number) => void;
  /** read the notebook again from disk (after a checkpoint or Git restore, a branch switch) */
  reload: () => Promise<void>;
};

type Props = {
  wid: string;
  path: string;
  active: boolean;
  workspace: Workspace;
  options: WorkspaceOptions | null;
  simple: boolean;
  autosave: boolean;
  theme: string;
  onState: (path: string, s: NotebookState) => void;
  /** Start (or switch to) the workspace's cloud machine for this compute; resolves once its Jupyter answers. */
  startMachine: (c: Extract<ComputeChoice, { target: "cloud" }>, ask?: boolean) => Promise<boolean>;
  onKernelsChanged: () => void;
  onRename: () => void;
  onSaveAs: (content: NotebookJSON) => void;
};

let clipboard: Cell[] = [];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

const stateLabel = (s: string) =>
  ({ idle: "Idle", busy: "Busy", starting: "Starting", restarting: "Restarting", dead: "Dead", none: "No Kernel", connecting: "Connecting", machine: "Starting machine", unknown: "Unknown" })[s] ?? s;

function headingsOf(cells: Cell[]): Heading[] {
  const out: Heading[] = [];
  cells.forEach((c, i) => {
    if (c.cell_type !== "markdown") return;
    let fence = false;
    for (const line of c.source.split("\n")) {
      if (/^\s*```/.test(line)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, ""), cell: i, id: m[2].trim().replace(/\s+/g, "-") });
    }
  });
  return out;
}

export const Notebook = forwardRef<NotebookHandle, Props>(function Notebook(props, ref) {
  const { wid, path, active, workspace, options, onKernelsChanged } = props;
  const dialogs = useDialogs();
  const [meta, setMeta] = useState<NotebookJSON["metadata"] | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const [mode, setMode] = useState<"command" | "edit">("command");
  const [dirty, setDirty] = useState(false);
  const [kernel, setKernel] = useState<KernelInfo | null>(null);
  const [kstate, setKstate] = useState<string>("none");
  const [kmsg, setKmsg] = useState<string | null>(null);
  const [running, setRunning] = useState<Record<string, "queued" | "running">>({});
  const [editingMd, setEditingMd] = useState<Set<string>>(new Set());
  const [stdin, setStdin] = useState<{ cell: string; prompt: string; password: boolean } | null>(null);
  const [lineNumbers, setLineNumbers] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [tooltip, setTooltip] = useState<{ data: MimeBundle; at: { x: number; y: number } } | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const editors = useRef(new Map<string, CellEditorHandle>());
  const cellEls = useRef(new Map<string, HTMLDivElement>());
  const container = useRef<HTMLDivElement>(null);
  const undoStack = useRef<Cell[][]>([]);
  const queue = useRef<string[]>([]);
  const draining = useRef(false);
  const pendingKey = useRef<{ key: string; at: number } | null>(null);
  const pendingFocus = useRef<{ id: string; where?: "start" | "end" | number } | null>(null);
  const clearWait = useRef(new Set<string>());

  // latest state for callbacks that must stay stable
  const S = useRef({ cells, activeIdx, anchor, mode, kernel, meta, dirty, editingMd });
  useLayoutEffect(() => {
    S.current = { cells, activeIdx, anchor, mode, kernel, meta, dirty, editingMd };
  });

  const target: Target = ((meta?.bluesandai as { target?: Target } | undefined)?.target ?? "local") as Target;
  const lo = Math.min(activeIdx, anchor);
  const hi = Math.max(activeIdx, anchor);
  const selectedIds = useMemo(() => new Set(cells.slice(lo, hi + 1).map((c) => c.id)), [cells, lo, hi]);
  const pod = workspace.pod;
  const machineLabel = target === "local" ? "Local CPU" : (pod?.compute?.kind ?? workspace.compute.kind) === "gpu" ? "Cloud CPU + GPU" : "Cloud CPU";

  // ---------------------------------------------------------------- loading and saving
  const pathRef = useRef(path);
  useLayoutEffect(() => {
    pathRef.current = path;
  });
  const load = useCallback(async () => {
    try {
      const m = await lab.get(wid, pathRef.current);
      const nb = normalizeNotebook(m.content);
      setMeta(nb.metadata);
      setCells(nb.cells);
      setEditingMd(new Set(nb.cells.filter((c) => c.cell_type === "markdown" && !c.source.trim()).map((c) => c.id)));
      setActiveIdx((i) => Math.min(i, nb.cells.length - 1));
      setAnchor((i) => Math.min(i, nb.cells.length - 1));
      setDirty(false);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, [wid]);
  // load once per notebook: a rename keeps the content
  useEffect(() => {
    void load();
  }, [load]);

  const content = useCallback((): NotebookJSON => serializeNotebook({ cells: S.current.cells, metadata: S.current.meta ?? {}, nbformat: 4, nbformat_minor: 5 }), []);
  const save = useCallback(async (checkpoint = false) => {
    await lab.save(wid, path, "notebook", content(), checkpoint);
    setDirty(false);
  }, [wid, path, content]);

  // JupyterLab autosaves every 2 minutes while there are changes (also while one keeps typing)
  useEffect(() => {
    if (!props.autosave) return;
    const t = setInterval(() => {
      if (S.current.dirty) void save().catch(() => {});
    }, 120_000);
    return () => clearInterval(t);
  }, [props.autosave, save]);

  const touch = () => setDirty(true);
  const pushUndo = () => {
    undoStack.current.push(clone(S.current.cells));
    if (undoStack.current.length > 30) undoStack.current.shift();
  };
  const updateCell = useCallback((id: string, fn: (c: Cell) => Cell) => setCells((cs) => cs.map((c) => (c.id === id ? fn(c) : c))), []);

  // ---------------------------------------------------------------- kernel
  useEffect(() => {
    if (!kernel || !active) return;
    const t = setInterval(() => {
      lab.kernel(wid, kernel.id).then(
        (k) => {
          if (S.current.kernel?.id !== k.id) return;
          setKernel(k);
          setKstate((s) => (s === "busy" && k.state === "idle" && draining.current ? s : k.state));
        },
        () => {
          setKernel(null);
          setKstate("none");
        },
      );
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll the same kernel
  }, [kernel?.id, active, wid]);

  const startKernel = useCallback(
    async (t: Target): Promise<KernelInfo | null> => {
      setKstate(t === "cloud" ? "connecting" : "starting");
      setKmsg(null);
      try {
        const k = await lab.startKernel(wid, path, t);
        setKernel(k);
        setKstate(k.state);
        onKernelsChanged();
        return k;
      } catch (e) {
        setKernel(null);
        setKstate("none");
        setKmsg((e as Error).message);
        return null;
      }
    },
    [wid, path, onKernelsChanged],
  );

  useEffect(() => {
    let off = false;
    lab.kernels(wid).then((ks) => {
      if (off) return;
      const k = ks.find((x) => x.path === path && x.state !== "dead");
      if (k) {
        setKernel(k);
        setKstate(k.state);
      } else if (target === "local" && meta) void startKernel("local");
    }, () => {});
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the notebook is loaded
  }, [wid, meta === null]);

  /** The notebook's kernel, starting it (and the cloud machine) when there is none. */
  const ensureKernel = useCallback(async (): Promise<KernelInfo | null> => {
    const k = S.current.kernel;
    if (k && k.state !== "dead") return k;
    if (target === "cloud") {
      if (pod?.status !== "running") {
        const kind = (pod?.compute?.kind ?? workspace.compute.kind) as "cpu" | "gpu";
        setKstate("machine");
        const ok = await props.startMachine(kind === "gpu" ? { target: "cloud", kind, gpu_type: workspace.compute.gpu_type } : { target: "cloud", kind, vcpus: workspace.compute.vcpus, spot: workspace.compute.cloud === "COMMUNITY" }, true);
        if (!ok) {
          setKstate("none");
          return null;
        }
      }
      return startKernel("cloud");
    }
    return startKernel("local");
  }, [target, pod, workspace, props, startKernel]);

  const setTarget = (t: Target) => {
    setMeta((m) => ({ ...(m ?? {}), bluesandai: { ...((m?.bluesandai as object) ?? {}), target: t } }));
    touch();
  };

  const chooseCompute = async (c: ComputeChoice) => {
    if (c.target === "local") {
      setTarget("local");
      await startKernel("local");
      return;
    }
    setTarget("cloud");
    setKstate("machine");
    setKmsg(null);
    const ok = await props.startMachine(c);
    if (!ok) {
      setKstate(S.current.kernel ? S.current.kernel.state : "none");
      return;
    }
    await startKernel("cloud");
  };

  const openComputeDialog = () =>
    dialogs.custom((close) => (
      <ComputeDialog
        path={path}
        workspace={workspace}
        options={options}
        current={target === "local" ? "local" : ((pod?.compute?.kind ?? workspace.compute.kind) === "gpu" ? "cloud-gpu" : "cloud-cpu")}
        onClose={close}
        onSelect={(c) => {
          close();
          void chooseCompute(c);
        }}
      />
    ));

  // ---------------------------------------------------------------- running cells
  const applyMsg = useCallback(
    (id: string, m: KernelMsg) => {
      const c = m.content as Record<string, unknown>;
      const push = (o: Output) =>
        updateCell(id, (cell) => {
          let outs = clearWait.current.has(id) ? [] : [...(cell.outputs ?? [])];
          clearWait.current.delete(id);
          const last = outs[outs.length - 1];
          if (o.output_type === "stream" && last?.output_type === "stream" && last.name === o.name) outs = [...outs.slice(0, -1), { ...last, text: last.text + o.text }];
          else outs.push(o);
          return { ...cell, outputs: outs };
        });
      switch (m.msg_type) {
        case "execute_input":
          updateCell(id, (cell) => ({ ...cell, execution_count: (c.execution_count as number) ?? cell.execution_count }));
          break;
        case "stream":
          push({ output_type: "stream", name: c.name as "stdout", text: String(c.text ?? "") });
          break;
        case "display_data":
          push({ output_type: "display_data", data: c.data as MimeBundle, metadata: (c.metadata as Record<string, unknown>) ?? {}, transient: c.transient as { display_id?: string } });
          break;
        case "update_display_data": {
          const did = (c.transient as { display_id?: string } | undefined)?.display_id;
          if (did)
            setCells((cs) =>
              cs.map((cell) =>
                cell.outputs?.some((o) => o.output_type === "display_data" && o.transient?.display_id === did)
                  ? { ...cell, outputs: cell.outputs.map((o) => (o.output_type === "display_data" && o.transient?.display_id === did ? { ...o, data: c.data as MimeBundle, metadata: (c.metadata as Record<string, unknown>) ?? {} } : o)) }
                  : cell,
              ),
            );
          break;
        }
        case "execute_result":
          push({ output_type: "execute_result", data: c.data as MimeBundle, metadata: (c.metadata as Record<string, unknown>) ?? {}, execution_count: (c.execution_count as number) ?? null });
          break;
        case "error":
          push({ output_type: "error", ename: String(c.ename ?? ""), evalue: String(c.evalue ?? ""), traceback: (c.traceback as string[]) ?? [] });
          break;
        case "clear_output":
          if (c.wait) clearWait.current.add(id);
          else updateCell(id, (cell) => ({ ...cell, outputs: [] }));
          break;
        case "input_request":
          setStdin({ cell: id, prompt: String(c.prompt ?? ""), password: !!c.password });
          break;
        case "status":
          setKstate(String(c.execution_state));
          break;
        case "kernel_dead":
          setKstate("dead");
          setKmsg(String(c.reason ?? "The kernel died."));
          break;
      }
    },
    [updateCell],
  );

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      while (queue.current.length) {
        const id = queue.current[0];
        const cell = S.current.cells.find((c) => c.id === id);
        if (!cell) {
          queue.current.shift();
          continue;
        }
        const k = await ensureKernel();
        if (!k) {
          queue.current = [];
          setRunning({});
          break;
        }
        setRunning((r) => ({ ...r, [id]: "running" }));
        updateCell(id, (c) => ({ ...c, outputs: [] }));
        let reply: Record<string, unknown> = {};
        try {
          reply = await lab.execute(wid, k.id, cell.source, (m) => applyMsg(id, m));
        } catch (e) {
          applyMsg(id, { msg_type: "error", content: { ename: "Error", evalue: (e as Error).message, traceback: [`\x1b[31m${(e as Error).message}\x1b[0m`] } });
          reply = { status: "error" };
        }
        setStdin((s) => (s?.cell === id ? null : s));
        queue.current.shift();
        setRunning((r) => {
          const n = { ...r };
          delete n[id];
          return n;
        });
        touch();
        if (reply.status !== "ok") {
          // Jupyter aborts the cells queued after an error
          queue.current = [];
          setRunning({});
          if (reply.status === "dead") setKernel(null);
        }
      }
    } finally {
      draining.current = false;
    }
  }, [ensureKernel, wid, applyMsg, updateCell]);

  const runIds = useCallback(
    (ids: string[]) => {
      const code: string[] = [];
      for (const id of ids) {
        const c = S.current.cells.find((x) => x.id === id);
        if (!c) continue;
        if (c.cell_type === "markdown") {
          setEditingMd((s) => {
            if (!s.has(id) || !c.source.trim()) return s;
            const n = new Set(s);
            n.delete(id);
            return n;
          });
          continue;
        }
        if (c.cell_type === "raw") continue;
        if (!c.source.trim()) {
          updateCell(id, (x) => ({ ...x, outputs: [], execution_count: null }));
          continue;
        }
        if (!queue.current.includes(id)) code.push(id);
      }
      if (!code.length) return;
      queue.current.push(...code);
      setRunning((r) => ({ ...r, ...Object.fromEntries(code.map((id) => [id, r[id] ?? "queued"])) }));
      void drain();
    },
    [drain, updateCell],
  );

  // ---------------------------------------------------------------- selection / focus
  const select = useCallback((i: number, extend = false) => {
    const n = S.current.cells.length;
    const j = Math.max(0, Math.min(n - 1, i));
    setActiveIdx(j);
    if (!extend) setAnchor(j);
    const id = S.current.cells[j]?.id;
    if (id) requestAnimationFrame(() => cellEls.current.get(id)?.scrollIntoView({ block: "nearest" }));
  }, []);

  const commandMode = useCallback(() => {
    setMode("command");
    requestAnimationFrame(() => container.current?.focus({ preventScroll: true }));
  }, []);

  const editMode = useCallback((i?: number, where?: "start" | "end" | number) => {
    const idx = i ?? S.current.activeIdx;
    const c = S.current.cells[idx];
    if (!c) return;
    setActiveIdx(idx);
    setAnchor(idx);
    setMode("edit");
    if (c.cell_type === "markdown") setEditingMd((s) => (s.has(c.id) ? s : new Set(s).add(c.id)));
    pendingFocus.current = { id: c.id, where };
  }, []);

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    const ed = editors.current.get(p.id);
    if (ed) {
      ed.focus(p.where);
      pendingFocus.current = null;
    }
  });

  // ---------------------------------------------------------------- cell operations
  const insert = useCallback((at: number, type: Cell["cell_type"] = "code", source = "") => {
    pushUndo();
    const c = emptyCell(type, source);
    setCells((cs) => [...cs.slice(0, at), c, ...cs.slice(at)]);
    if (type === "markdown") setEditingMd((s) => new Set(s).add(c.id));
    setActiveIdx(at);
    setAnchor(at);
    touch();
    return c;
  }, []);

  /** Insert a cell and edit it (the cell is not in S yet, so focus it by id once it renders). */
  const insertAndEdit = (at: number) => {
    const c = insert(at);
    setMode("edit");
    pendingFocus.current = { id: c.id };
  };

  const selectedRange = () => [Math.min(S.current.activeIdx, S.current.anchor), Math.max(S.current.activeIdx, S.current.anchor)] as const;

  const del = () => {
    const [a, b] = selectedRange();
    pushUndo();
    setCells((cs) => {
      const rest = [...cs.slice(0, a), ...cs.slice(b + 1)];
      return rest.length ? rest : [emptyCell("code")];
    });
    const n = Math.min(a, S.current.cells.length - (b - a + 1) - 1);
    setActiveIdx(Math.max(0, n));
    setAnchor(Math.max(0, n));
    touch();
  };
  const copy = () => {
    const [a, b] = selectedRange();
    clipboard = clone(S.current.cells.slice(a, b + 1));
  };
  const paste = (above = false) => {
    if (!clipboard.length) return;
    pushUndo();
    const at = above ? selectedRange()[0] : selectedRange()[1] + 1;
    const fresh = clipboard.map((c) => ({ ...clone(c), id: newId() }));
    setCells((cs) => [...cs.slice(0, at), ...fresh, ...cs.slice(at)]);
    setActiveIdx(at + fresh.length - 1);
    setAnchor(at + fresh.length - 1);
    touch();
  };
  const move = (dir: -1 | 1) => {
    const [a, b] = selectedRange();
    if ((dir < 0 && a === 0) || (dir > 0 && b >= S.current.cells.length - 1)) return;
    pushUndo();
    setCells((cs) => {
      const n = [...cs];
      const block = n.splice(a, b - a + 1);
      n.splice(a + dir, 0, ...block);
      return n;
    });
    setActiveIdx((i) => i + dir);
    setAnchor((i) => i + dir);
    touch();
  };
  const changeType = (type: Cell["cell_type"], heading?: number) => {
    const [a, b] = selectedRange();
    pushUndo();
    setCells((cs) =>
      cs.map((c, i) => {
        if (i < a || i > b) return c;
        let source = c.source;
        if (heading) source = "#".repeat(heading) + " " + source.replace(/^#+\s*/, "");
        if (c.cell_type === type && !heading) return c;
        const base: Cell = { id: c.id, cell_type: type, source, metadata: c.metadata };
        if (type === "code") Object.assign(base, { outputs: [], execution_count: null });
        return base;
      }),
    );
    if (type === "markdown") setEditingMd((s) => {
      const n = new Set(s);
      S.current.cells.slice(a, b + 1).forEach((c) => (heading ? n.delete(c.id) : c.cell_type !== "markdown" && n.add(c.id)));
      return n;
    });
    touch();
  };
  const merge = (which: "selected" | "above" | "below") => {
    let [a, b] = selectedRange();
    if (which === "above") a = Math.max(0, a - 1);
    if (which === "below") b = Math.min(S.current.cells.length - 1, b + 1);
    if (a === b) return;
    pushUndo();
    setCells((cs) => {
      const parts = cs.slice(a, b + 1);
      const first = parts[0];
      const merged: Cell = { ...first, source: parts.map((p) => p.source).join("\n\n"), ...(first.cell_type === "code" ? { outputs: [], execution_count: null } : {}) };
      return [...cs.slice(0, a), merged, ...cs.slice(b + 1)];
    });
    setActiveIdx(a);
    setAnchor(a);
    touch();
  };
  const split = (pos?: number) => {
    const i = S.current.activeIdx;
    const c = S.current.cells[i];
    const at = pos ?? editors.current.get(c.id)?.cursor().pos ?? c.source.length;
    pushUndo();
    const top: Cell = { ...c, source: c.source.slice(0, at).replace(/\n$/, ""), ...(c.cell_type === "code" ? { outputs: [], execution_count: null } : {}) };
    const bottom: Cell = { ...emptyCell(c.cell_type, c.source.slice(at).replace(/^\n/, "")), metadata: clone(c.metadata) };
    setCells((cs) => [...cs.slice(0, i), top, bottom, ...cs.slice(i + 1)]);
    setActiveIdx(i + 1);
    setAnchor(i + 1);
    setMode("edit");
    pendingFocus.current = { id: bottom.id, where: "start" };
    touch();
  };
  const setHidden = (ids: Set<string>, key: "source_hidden" | "outputs_hidden", v: boolean | "toggle") => {
    setCells((cs) =>
      cs.map((c) => {
        if (!ids.has(c.id)) return c;
        const j = (c.metadata.jupyter as Record<string, boolean> | undefined) ?? {};
        const nv = v === "toggle" ? !j[key] : v;
        const jupyter = { ...j, [key]: nv };
        if (!nv) delete jupyter[key];
        const md: Record<string, unknown> = { ...c.metadata, jupyter };
        if (!Object.keys(jupyter).length) delete md.jupyter;
        if (key === "outputs_hidden") {
          if (nv) md.collapsed = true;
          else delete md.collapsed;
        }
        return { ...c, metadata: md };
      }),
    );
    touch();
  };
  const clearOutputs = (ids: Set<string>) => {
    setCells((cs) => cs.map((c) => (ids.has(c.id) && c.cell_type === "code" ? { ...c, outputs: [], execution_count: null } : c)));
    touch();
  };

  const interrupt = async () => {
    const k = S.current.kernel;
    if (k) await lab.interrupt(wid, k.id).catch(() => {});
  };
  const restart = async (opts: { confirm?: boolean; clear?: boolean; then?: "all" | "to" } = {}) => {
    const k = S.current.kernel;
    if (opts.confirm !== false) {
      const title = opts.clear ? "Restart Kernel and Clear All Outputs?" : opts.then === "all" ? "Restart Kernel and Run All Cells?" : opts.then === "to" ? "Restart Kernel and Run up to Selected Cell?" : "Restart Kernel?";
      const body = opts.then === "all" ? "Do you want to restart the current kernel and run all cells? All variables will be lost." : opts.clear ? "Do you want to restart the current kernel and clear all output? All variables will be lost." : "Do you want to restart the current kernel? All variables will be lost.";
      if (!(await dialogs.confirm(title, body, opts.clear ? "Clear and Restart" : "Restart", true))) return;
    }
    queue.current = [];
    setRunning({});
    if (k) {
      setKstate("restarting");
      try {
        const nk = await lab.restart(wid, k.id);
        setKernel(nk);
        setKstate(nk.state);
      } catch (e) {
        setKmsg((e as Error).message);
        setKernel(null);
        setKstate("none");
      }
    } else await ensureKernel();
    if (opts.clear) clearOutputs(new Set(S.current.cells.map((c) => c.id)));
    if (opts.then === "all") runIds(S.current.cells.map((c) => c.id));
    if (opts.then === "to") runIds(S.current.cells.slice(0, S.current.activeIdx + 1).map((c) => c.id));
  };
  const shutdown = async () => {
    const k = S.current.kernel;
    if (!k) return;
    await lab.shutdown(wid, k.id).catch(() => {});
    setKernel(null);
    setKstate("none");
    props.onKernelsChanged();
  };

  const runSelected = (how: "advance" | "stay" | "insert") => {
    const [a, b] = selectedRange();
    runIds(S.current.cells.slice(a, b + 1).map((c) => c.id));
    if (how === "stay") {
      commandMode();
      return;
    }
    if (how === "insert" || b + 1 >= S.current.cells.length) {
      insertAndEdit(b + 1);
      return;
    }
    // JupyterLab: the next cell is selected in command mode (edit mode only for a cell it inserts)
    select(b + 1);
    commandMode();
  };

  // ---------------------------------------------------------------- commands (menus, toolbar, keys)
  const command = (name: string) => {
    const s = S.current;
    const sel = new Set(s.cells.slice(Math.min(s.activeIdx, s.anchor), Math.max(s.activeIdx, s.anchor) + 1).map((c) => c.id));
    const all = new Set(s.cells.map((c) => c.id));
    switch (name) {
      case "save": void save(true); break;
      case "saveAs": props.onSaveAs(content()); break;
      case "rename": props.onRename(); break;
      case "insertAbove": insert(Math.min(s.activeIdx, s.anchor)); break;
      case "insertBelow": insert(Math.max(s.activeIdx, s.anchor) + 1); break;
      case "cut": copy(); del(); break;
      case "copy": copy(); break;
      case "paste": paste(); break;
      case "pasteAbove": paste(true); break;
      case "delete": del(); break;
      case "duplicate": copy(); paste(); break;
      case "undoCells": {
        const prev = undoStack.current.pop();
        if (prev) { setCells(prev); setActiveIdx((i) => Math.min(i, prev.length - 1)); setAnchor((i) => Math.min(i, prev.length - 1)); touch(); }
        break;
      }
      case "selectAll": setAnchor(0); setActiveIdx(s.cells.length - 1); break;
      case "deselect": setAnchor(s.activeIdx); break;
      case "moveUp": move(-1); break;
      case "moveDown": move(1); break;
      case "split": split(); break;
      case "merge": merge("selected"); break;
      case "mergeAbove": merge("above"); break;
      case "mergeBelow": merge("below"); break;
      case "clearOutput": clearOutputs(sel); break;
      case "clearAllOutputs": clearOutputs(all); break;
      case "toCode": changeType("code"); break;
      case "toMarkdown": changeType("markdown"); break;
      case "toRaw": changeType("raw"); break;
      case "runAdvance": runSelected("advance"); break;
      case "runStay": runSelected("stay"); break;
      case "runInsert": runSelected("insert"); break;
      case "runAll": runIds(s.cells.map((c) => c.id)); break;
      case "runAbove": runIds(s.cells.slice(0, s.activeIdx).map((c) => c.id)); break;
      case "runBelow": runIds(s.cells.slice(s.activeIdx).map((c) => c.id)); break;
      case "renderMarkdown": setEditingMd(new Set([...s.editingMd].filter((id) => !s.cells.find((c) => c.id === id)?.source.trim()))); break;
      case "restartRunAll": void restart({ then: "all" }); break;
      case "restartRunTo": void restart({ then: "to" }); break;
      case "restartClear": void restart({ clear: true }); break;
      case "restart": void restart(); break;
      case "interrupt": void interrupt(); break;
      case "reconnect": void lab.kernels(wid).then((ks) => { const k = ks.find((x) => x.path === path); setKernel(k ?? null); setKstate(k?.state ?? "none"); }); break;
      case "shutdown": void shutdown(); break;
      case "changeKernel": openComputeDialog(); break;
      case "collapseCode": setHidden(sel, "source_hidden", true); break;
      case "expandCode": setHidden(sel, "source_hidden", false); break;
      case "collapseOutputs": setHidden(sel, "outputs_hidden", true); break;
      case "expandOutputs": setHidden(sel, "outputs_hidden", false); break;
      case "collapseAllCode": setHidden(all, "source_hidden", true); break;
      case "expandAllCode": setHidden(all, "source_hidden", false); break;
      case "collapseAllOutputs": setHidden(all, "outputs_hidden", true); break;
      case "expandAllOutputs": setHidden(all, "outputs_hidden", false); break;
      case "toggleLineNumbers": setLineNumbers((v) => !v); break;
      case "toggleScrolled":
        setCells((cs) => cs.map((c) => (sel.has(c.id) ? { ...c, metadata: { ...c.metadata, scrolled: !c.metadata.scrolled } } : c)));
        touch();
        break;
      case "commandMode": commandMode(); break;
      case "editMode": editMode(); break;
      default:
        if (name.startsWith("heading")) changeType("markdown", Number(name.slice(7)));
    }
  };
  const commandRef = useRef(command);
  useLayoutEffect(() => {
    commandRef.current = command;
  });

  useImperativeHandle(ref, () => ({
    command: (n) => commandRef.current(n),
    save,
    content,
    reload: load,
    focus: () => (S.current.mode === "edit" ? editMode() : container.current?.focus({ preventScroll: true })),
    scrollToCell: (i) => {
      select(i);
      const id = S.current.cells[i]?.id;
      if (id) cellEls.current.get(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
  }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (S.current.mode !== "command") return;
    const tgt = e.target as HTMLElement;
    if (tgt.closest(".cm-editor") || tgt.tagName === "INPUT" || tgt.tagName === "SELECT" || tgt.tagName === "TEXTAREA") return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    const double = (key: string, fn: () => void) => {
      const p = pendingKey.current;
      if (p && p.key === key && Date.now() - p.at < 800) {
        pendingKey.current = null;
        fn();
      } else pendingKey.current = { key, at: Date.now() };
    };
    let handled = true;
    if (k === "Enter" && e.shiftKey) runSelected("advance");
    else if (k === "Enter" && mod) runSelected("stay");
    else if (k === "Enter" && e.altKey) runSelected("insert");
    else if (k === "Enter") editMode();
    else if (mod && (k === "s" || k === "S")) void save(true);
    else if (mod && (k === "a" || k === "A")) command("selectAll");
    else if (mod || e.altKey) handled = false;
    else if (k === "ArrowUp" || k === "k" || k === "K") select(S.current.activeIdx - 1, e.shiftKey);
    else if (k === "ArrowDown" || k === "j" || k === "J") select(S.current.activeIdx + 1, e.shiftKey);
    else if (k === "a") command("insertAbove");
    else if (k === "b") command("insertBelow");
    else if (k === "x") command("cut");
    else if (k === "c") command("copy");
    else if (k === "v") command("paste");
    else if (k === "V") command("pasteAbove");
    else if (k === "d") double("d", () => command("delete"));
    else if (k === "z") command("undoCells");
    else if (k === "m") command("toMarkdown");
    else if (k === "M") command("merge");
    else if (k === "y") command("toCode");
    else if (k === "r") command("toRaw");
    else if (/^[1-6]$/.test(k)) command(`heading${k}`);
    else if (k === "i" || k === "I") double("i", () => command("interrupt"));
    else if (k === "0") double("0", () => command("restart"));
    else if (k === "l") command("toggleLineNumbers");
    else if (k === "L") command("toggleLineNumbers");
    else if (k === "o") setHidden(selectedIds, "outputs_hidden", "toggle");
    else if (k === "Escape") setAnchor(S.current.activeIdx);
    else if (k === " ") {
      container.current?.scrollBy({ top: (e.shiftKey ? -1 : 1) * container.current.clientHeight * 0.8, behavior: "smooth" });
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---------------------------------------------------------------- completion / inspection
  const complete: CompleteFn = useCallback(
    async (code, pos) => {
      const k = S.current.kernel;
      if (!k || k.state === "dead") return null;
      const r = await lab.complete(wid, k.id, code, pos).catch(() => null);
      if (!r || r.status !== "ok" || !r.matches) return null;
      return { matches: r.matches, from: r.cursor_start ?? pos, to: r.cursor_end ?? pos };
    },
    [wid],
  );
  const inspect: InspectFn = useCallback(
    async (code, pos, at) => {
      const k = S.current.kernel;
      if (!k) return;
      const r = await lab.inspect(wid, k.id, code, pos).catch(() => null);
      if (r?.found && r.data) setTooltip({ data: r.data, at });
    },
    [wid],
  );

  // ---------------------------------------------------------------- report state to the shell
  const headings = useMemo(() => headingsOf(cells), [cells]);
  const activeHeading = useMemo(() => {
    let h = -1;
    headings.forEach((x, i) => x.cell <= activeIdx && (h = i));
    return h;
  }, [headings, activeIdx]);
  const { onState } = props;
  useEffect(() => {
    onState(path, { dirty, mode, line: cursor.line, col: cursor.col, kernel, kstate, compute: kernel ? kernel.target : target === "local" ? "local" : machineLabel === "Cloud CPU + GPU" ? "cloud-gpu" : "cloud-cpu", cells: cells.length, headings, activeHeading });
  }, [onState, path, dirty, mode, cursor, kernel, kstate, target, machineLabel, cells.length, headings, activeHeading]);

  // ---------------------------------------------------------------- render
  if (loadErr) return <div className="jp-Notebook"><p className="jp-ErrorText">{loadErr}</p></div>;
  if (!meta) return <div className="jp-Notebook"><p className="jp-Muted">Loading notebook…</p></div>;

  const activeCell = cells[activeIdx];
  const kernelCls = kstate === "busy" || kstate === "machine" ? "jp-mod-busy" : kstate === "dead" ? "jp-mod-dead" : ["starting", "restarting", "connecting"].includes(kstate) ? "jp-mod-starting" : "";
  const multi = hi > lo;

  const ctxItems: MenuItem[] = [
    { label: "Cut Cell", onClick: () => command("cut") },
    { label: "Copy Cell", onClick: () => command("copy") },
    { label: "Paste Cell Below", onClick: () => command("paste"), disabled: !clipboard.length },
    "-",
    { label: "Delete Cell", onClick: () => command("delete") },
    "-",
    { label: "Split Cell", onClick: () => command("split") },
    { label: "Merge Selected Cells", onClick: () => command("merge"), disabled: !multi },
    { label: "Merge Cell Above", onClick: () => command("mergeAbove"), disabled: activeIdx === 0 },
    { label: "Merge Cell Below", onClick: () => command("mergeBelow"), disabled: activeIdx >= cells.length - 1 },
    "-",
    { label: "Run Selected Cell and Advance", shortcut: "Shift+Enter", onClick: () => command("runAdvance") },
    { label: "Clear Cell Output", onClick: () => command("clearOutput") },
    { label: "Clear Outputs of All Cells", onClick: () => command("clearAllOutputs") },
    { label: activeCell?.metadata.scrolled ? "Disable Scrolling for Outputs" : "Enable Scrolling for Outputs", onClick: () => command("toggleScrolled") },
    "-",
    { label: "Collapse Selected Code", onClick: () => command("collapseCode") },
    { label: "Collapse Selected Outputs", onClick: () => command("collapseOutputs") },
    { label: "Expand Selected Code", onClick: () => command("expandCode") },
    { label: "Expand Selected Outputs", onClick: () => command("expandOutputs") },
  ];

  return (
    <div className="jp-NotebookPanel">
      <div className="jp-Toolbar" role="toolbar">
        <TB icon="save" title={`Save and create checkpoint (${isMac ? "⌘" : "Ctrl+"}S)`} onClick={() => command("save")} />
        <TB icon="add" title="Insert a cell below (B)" onClick={() => command("insertBelow")} />
        <TB icon="cut" title="Cut the selected cells (X)" onClick={() => command("cut")} />
        <TB icon="copy" title="Copy the selected cells (C)" onClick={() => command("copy")} />
        <TB icon="paste" title="Paste cells from the clipboard (V)" onClick={() => command("paste")} />
        <TB icon="run" title="Run this cell and advance (Shift+Enter)" onClick={() => command("runAdvance")} />
        <TB icon="stop" title="Interrupt the kernel" onClick={() => command("interrupt")} />
        <TB icon="refresh" title="Restart the kernel" onClick={() => command("restart")} />
        <TB icon="fastForward" title="Restart the kernel and run all cells" onClick={() => command("restartRunAll")} />
        <select
          className="jp-HTMLSelect"
          aria-label="Cell type"
          value={multi && new Set(cells.slice(lo, hi + 1).map((c) => c.cell_type)).size > 1 ? "-" : activeCell?.cell_type ?? "code"}
          onChange={(e) => {
            command(e.target.value === "code" ? "toCode" : e.target.value === "markdown" ? "toMarkdown" : "toRaw");
            container.current?.focus({ preventScroll: true });
          }}
        >
          <option value="-" disabled>-</option>
          <option value="code">Code</option>
          <option value="markdown">Markdown</option>
          <option value="raw">Raw</option>
        </select>
        <div className="jp-Toolbar-spacer" />
        <button type="button" className={`jp-ToolbarButton jp-ComputeButton${machineLabel.includes("GPU") ? " jp-mod-gpu" : ""}`} title="Choose where this notebook runs: Local CPU, Cloud CPU or Cloud CPU + GPU (RunPod)" onClick={openComputeDialog}>
          <JpIcon name={target === "local" ? "computer" : machineLabel.includes("GPU") ? "chip" : "cloud"} />
          {machineLabel}
          {target === "cloud" && pod && <span className="jp-Muted">· {pod.status === "running" ? podLabel(pod) : pod.status}</span>}
          <JpIcon name="caretDown" />
        </button>
        <button type="button" className="jp-ToolbarButton" title="Switch kernel" onClick={openComputeDialog}>
          {kernel || kstate !== "none" ? "Python 3 (ipykernel)" : "No Kernel"}
        </button>
        <div className="jp-KernelStatus" title={`Kernel status: ${stateLabel(kstate)}`}>
          <div className={`jp-KernelStatus-circle ${kernelCls}`} />
        </div>
      </div>
      {kstate === "machine" && (
        <div className="jp-Banner">
          <JpIcon name="cloud" /> Starting the {machineLabel.toLowerCase()} machine on {machineLabel.includes("GPU") ? "RunPod" : "Google Cloud"}: it bills by the hour while it runs. The first start takes a few minutes.
        </div>
      )}
      {kmsg && (
        <div className="jp-Banner jp-mod-error">
          <span style={{ flex: 1 }}>{kmsg}</span>
          <button type="button" className="jp-Button jp-mod-small" onClick={() => setKmsg(null)}>Dismiss</button>
        </div>
      )}
      <div
        ref={container}
        className={`jp-Notebook${props.simple ? " jp-mod-simple" : ""}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && S.current.mode === "edit") commandMode();
        }}
      >
        {cells.map((c, i) => (
          <CellView
            key={c.id}
            cell={c}
            index={i}
            active={i === activeIdx}
            selected={selectedIds.has(c.id)}
            multi={multi}
            edit={mode === "edit" && i === activeIdx}
            mdEditing={editingMd.has(c.id)}
            running={running[c.id]}
            lineNumbers={lineNumbers}
            dragTarget={dragOver === i}
            stdin={stdin?.cell === c.id ? stdin : null}
            bindEditor={(h) => (h ? editors.current.set(c.id, h) : editors.current.delete(c.id))}
            bindElement={(el) => (el ? cellEls.current.set(c.id, el) : cellEls.current.delete(c.id))}
            complete={complete}
            inspect={inspect}
            onSelect={(ev) => {
              if (ev.shiftKey) select(i, true);
              else {
                select(i);
                if (S.current.mode === "edit" && !(ev.target as HTMLElement).closest(".cm-editor")) commandMode();
                else if (S.current.mode === "command") container.current?.focus({ preventScroll: true });
              }
            }}
            onContext={(ev) => {
              ev.preventDefault();
              if (!selectedIds.has(c.id)) select(i);
              setCtx({ x: ev.clientX, y: ev.clientY });
            }}
            onChange={(v) => {
              updateCell(c.id, (x) => ({ ...x, source: v }));
              touch();
            }}
            onFocusEditor={() => {
              setActiveIdx(i);
              setAnchor(i);
              setMode("edit");
            }}
            onCursor={(line, col) => setCursor({ line, col })}
            onEditMarkdown={() => editMode(i, "end")}
            onToggle={(key) => setHidden(new Set([c.id]), key, "toggle")}
            onStdin={(v) => {
              setStdin(null);
              updateCell(c.id, (x) => ({ ...x, outputs: [...(x.outputs ?? []), { output_type: "stream", name: "stdout", text: (stdin?.prompt ?? "") + (stdin?.password ? "········" : v) + "\n" }] }));
              if (kernel) void lab.input(wid, kernel.id, v);
            }}
            keys={{
              run: (how) => runSelected(how),
              escape: commandMode,
              edge: (dir) => {
                const j = i + dir;
                if (j < 0 || j >= S.current.cells.length) return false;
                editMode(j, dir < 0 ? "end" : "start");
                return true;
              },
              split: (pos) => split(pos),
              save: () => void save(true),
            }}
            toolbar={
              i === activeIdx && !multi ? (
                <div className="jp-cell-toolbar" onMouseDown={(e) => e.stopPropagation()}>
                  <TB icon="copy" title="Create a duplicate of this cell below" onClick={() => command("duplicate")} />
                  <TB icon="moveUp" title="Move this cell up" onClick={() => command("moveUp")} />
                  <TB icon="moveDown" title="Move this cell down" onClick={() => command("moveDown")} />
                  <TB icon="addAbove" title="Insert a cell above (A)" onClick={() => command("insertAbove")} />
                  <TB icon="addBelow" title="Insert a cell below (B)" onClick={() => command("insertBelow")} />
                  <TB icon="trash" title="Delete this cell (D, D)" onClick={() => command("delete")} />
                </div>
              ) : null
            }
            onDragStart={(ev) => {
              ev.dataTransfer.setData("application/x-jp-cell", String(i));
              ev.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(ev) => {
              if (!ev.dataTransfer.types.includes("application/x-jp-cell")) return;
              ev.preventDefault();
              setDragOver(i);
            }}
            onDrop={(ev) => {
              const from = Number(ev.dataTransfer.getData("application/x-jp-cell"));
              setDragOver(null);
              if (Number.isNaN(from) || from === i) return;
              pushUndo();
              setCells((cs) => {
                const n = [...cs];
                const [m] = n.splice(from, 1);
                n.splice(from < i ? i - 1 : i, 0, m);
                return n;
              });
              select(from < i ? i - 1 : i);
              touch();
            }}
            onDragEnd={() => setDragOver(null)}
          />
        ))}
        <div style={{ height: 1 }} onClick={() => select(cells.length - 1)} />
      </div>
      {ctx && <Menu items={ctxItems} x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} />}
      {tooltip && <InspectTooltip data={tooltip.data} at={tooltip.at} onClose={() => setTooltip(null)} />}
    </div>
  );
});

function TB({ icon, title, onClick, disabled }: { icon: Parameters<typeof JpIcon>[0]["name"]; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="jp-ToolbarButton" title={title} aria-label={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <JpIcon name={icon} />
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ a cell

type CellProps = {
  cell: Cell;
  index: number;
  active: boolean;
  selected: boolean;
  multi: boolean;
  edit: boolean;
  mdEditing: boolean;
  running?: "queued" | "running";
  lineNumbers: boolean;
  dragTarget: boolean;
  stdin: { prompt: string; password: boolean } | null;
  toolbar: React.ReactNode;
  keys: EditorKeys;
  complete: CompleteFn;
  inspect: InspectFn;
  bindEditor: (h: CellEditorHandle | null) => void;
  bindElement: (el: HTMLDivElement | null) => void;
  onSelect: (e: React.MouseEvent) => void;
  onContext: (e: React.MouseEvent) => void;
  onChange: (v: string) => void;
  onFocusEditor: () => void;
  onCursor: (line: number, col: number) => void;
  onEditMarkdown: () => void;
  onToggle: (key: "source_hidden" | "outputs_hidden") => void;
  onStdin: (v: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
};

function CellView({ bindElement, bindEditor, ...p }: CellProps) {
  const { cell } = p;
  const jmeta = (cell.metadata.jupyter as { source_hidden?: boolean; outputs_hidden?: boolean } | undefined) ?? {};
  const srcHidden = !!jmeta.source_hidden;
  const outHidden = !!jmeta.outputs_hidden || cell.metadata.collapsed === true;
  const isCode = cell.cell_type === "code";
  const prompt = isCode ? (p.running ? "[*]:" : `[${cell.execution_count ?? " "}]:`) : "";
  const showRendered = cell.cell_type === "markdown" && !p.mdEditing;
  const outputs = cell.outputs ?? [];
  const cls = [
    "jp-Cell",
    isCode ? "jp-CodeCell" : cell.cell_type === "markdown" ? "jp-MarkdownCell" : "jp-RawCell",
    p.active && "jp-mod-active",
    p.selected && "jp-mod-selected",
    p.multi && "jp-mod-multi",
    p.edit && "jp-mod-editMode",
    p.dragTarget && "jp-mod-dragTarget",
  ].filter(Boolean).join(" ");
  return (
    <div ref={bindElement} className={cls} onMouseDown={p.onSelect} onContextMenu={p.onContext} onDragOver={p.onDragOver} onDrop={p.onDrop} data-index={p.index}>
      {p.toolbar}
      <div className="jp-Cell-inputWrapper">
        <button type="button" className="jp-Collapser jp-mod-input" style={{ top: 0, bottom: 0 }} tabIndex={-1} aria-label="Collapse input" onClick={() => p.onToggle("source_hidden")}>
          <div className="jp-Collapser-child" />
        </button>
        <div className="jp-InputArea" style={{ paddingLeft: "var(--jp-cell-collapser-width)" }}>
          <div className="jp-InputPrompt" draggable onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}>
            {prompt}
          </div>
          {srcHidden ? (
            <button type="button" className="jp-Placeholder" onClick={() => p.onToggle("source_hidden")}>
              <JpIcon name="ellipses" /> {cell.source.split("\n")[0].slice(0, 80)}
            </button>
          ) : showRendered ? (
            <div style={{ flex: 1, minWidth: 0 }}>
              <MarkdownView source={cell.source} attachments={cell.attachments} onDoubleClick={p.onEditMarkdown} />
            </div>
          ) : (
            <div className="jp-InputArea-editor">
              <CellEditor
                ref={bindEditor}
                value={cell.source}
                lang={isCode ? "python" : cell.cell_type === "markdown" ? "markdown" : "text"}
                onChange={p.onChange}
                onFocus={p.onFocusEditor}
                onCursor={p.onCursor}
                keys={p.keys}
                complete={isCode ? p.complete : undefined}
                inspect={isCode ? p.inspect : undefined}
                lineNumbers={p.lineNumbers}
              />
            </div>
          )}
        </div>
      </div>
      {isCode && (outputs.length > 0 || p.stdin) && (
        <div className="jp-Cell-outputWrapper">
          <button type="button" className="jp-Collapser" style={{ top: 0, bottom: 0 }} tabIndex={-1} aria-label="Collapse output" onClick={() => p.onToggle("outputs_hidden")}>
            <div className="jp-Collapser-child" />
          </button>
          {outHidden ? (
            <button type="button" className="jp-OutputPlaceholder" style={{ border: "none", background: "none", paddingLeft: "calc(var(--jp-cell-collapser-width) + 8px)" }} onClick={() => p.onToggle("outputs_hidden")}>
              <JpIcon name="ellipses" />
            </button>
          ) : (
            <div className={`jp-OutputArea${cell.metadata.scrolled ? " jp-mod-scrolled" : ""}`} style={{ paddingLeft: "var(--jp-cell-collapser-width)" }}>
              {outputs.map((o, i) => (
                <div key={i} className="jp-OutputArea-child">
                  <div className="jp-OutputPrompt">{o.output_type === "execute_result" ? `[${o.execution_count ?? " "}]:` : ""}</div>
                  <OutputView output={o} />
                </div>
              ))}
              {p.stdin && (
                <div className="jp-OutputArea-child">
                  <div className="jp-OutputPrompt" />
                  <StdinBox prompt={p.stdin.prompt} password={p.stdin.password} onSubmit={p.onStdin} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StdinBox({ prompt, password, onSubmit }: { prompt: string; password: boolean; onSubmit: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="jp-OutputArea-output jp-OutputArea-stdin">
      <span>{prompt}</span>
      <input
        autoFocus
        type={password ? "password" : "text"}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onSubmit(v);
        }}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the compute picker

const VCPUS = [2, 4, 8, 16, 32];

function ComputeDialog({ path, workspace, options, current, onClose, onSelect }: {
  path: string; workspace: Workspace; options: WorkspaceOptions | null; current: string; onClose: () => void; onSelect: (c: ComputeChoice) => void;
}) {
  const [pick, setPick] = useState(current);
  const [gpu, setGpu] = useState(workspace.compute.gpu_type || options?.gpu_types[0] || "");
  const [vcpus, setVcpus] = useState(workspace.compute.vcpus || 4);
  const [spot, setSpot] = useState(workspace.compute.cloud === "COMMUNITY");
  const pod = workspace.pod;
  const cpuReady = !!options?.cpu_configured;
  const gpuReady = !!options?.gpu_configured;
  const podKind = pod?.compute?.kind ?? (pod ? workspace.compute.kind : null);
  const differs =
    pod && pick !== "local" &&
    ((pick === "cloud-gpu") !== (podKind === "gpu") || (pick === "cloud-gpu" ? (pod.compute?.gpu_type ?? workspace.compute.gpu_type) !== gpu : (pod.compute?.vcpus ?? workspace.compute.vcpus) !== vcpus || (pod.compute?.cloud === "COMMUNITY") !== spot));
  const choice = (): ComputeChoice => (pick === "local" ? { target: "local" } : pick === "cloud-gpu" ? { target: "cloud", kind: "gpu", gpu_type: gpu } : { target: "cloud", kind: "cpu", vcpus, spot });
  const row = (id: string, icon: Parameters<typeof JpIcon>[0]["name"], title: string, desc: React.ReactNode, extra?: React.ReactNode, disabled?: boolean) => (
    <div className={`jp-ComputeChoice${pick === id ? " jp-mod-selected" : ""}${disabled ? " jp-mod-disabled" : ""}`} onClick={() => !disabled && setPick(id)} role="radio" aria-checked={pick === id}>
      <input type="radio" checked={pick === id} disabled={disabled} onChange={() => setPick(id)} style={{ marginTop: 3 }} />
      <JpIcon name={icon} style={{ width: 22, height: 22, marginTop: 1 }} />
      <div style={{ flex: 1 }}>
        <div className="jp-ComputeChoice-title">{title}</div>
        <div className="jp-ComputeChoice-desc">{desc}</div>
        {pick === id && extra}
      </div>
    </div>
  );
  return (
    <DialogBox
      title="Select Kernel"
      width={600}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="jp-Button jp-mod-reject" onClick={onClose}>Cancel</button>
          <button type="button" className="jp-Button jp-mod-accept" autoFocus onClick={() => onSelect(choice())}>Select</button>
        </>
      }
    >
      <p style={{ margin: "0 0 10px" }}>Select kernel for: &quot;{path.split("/").pop()}&quot; — <b>Python 3 (ipykernel)</b>, running on:</p>
      {row("local", "computer", "Local CPU", "On the BluesandAI server. Starts in seconds, nothing to pay. Good for exploring data and light models.")}
      {row(
        "cloud-cpu", "cloud", "Cloud CPU (Google Compute Engine)",
        cpuReady
          ? `An e2-standard VM in ${options?.cpu_zone ?? "your zone"} (4 GB RAM per vCPU), billed by the hour on your Google Cloud project while it runs.`
          : "GCP_COMPUTE_CREDENTIALS is not set on the API.",
        <div className="jp-ComputeChoice-opts">
          <select className="jp-mod-styled" style={{ width: 250 }} value={vcpus} onChange={(e) => setVcpus(Number(e.target.value))} onClick={(e) => e.stopPropagation()}>
            {VCPUS.map((v) => <option key={v} value={v}>e2-standard-{v} · {v} vCPU, {v * 4} GB</option>)}
          </select>
          <select className="jp-mod-styled" style={{ width: 230 }} value={spot ? "spot" : "standard"} onChange={(e) => setSpot(e.target.value === "spot")} onClick={(e) => e.stopPropagation()}>
            <option value="standard">Standard</option>
            <option value="spot">Spot (cheaper; Google may stop it)</option>
          </select>
        </div>,
        !cpuReady,
      )}
      {row(
        "cloud-gpu", "chip", "Cloud CPU + GPU (RunPod)",
        gpuReady ? "A RunPod machine with an NVIDIA GPU (PyTorch, CUDA 12.4), billed by the hour on your RunPod account while it runs." : "RUNPOD_API_KEY is not set on the API.",
        <div className="jp-ComputeChoice-opts">
          <select className="jp-mod-styled" style={{ width: 260 }} value={gpu} onChange={(e) => setGpu(e.target.value)} onClick={(e) => e.stopPropagation()}>
            {(options?.gpu_types ?? []).map((g) => <option key={g}>{g}</option>)}
          </select>
        </div>,
        !gpuReady,
      )}
      {pick !== "local" && (
        <p className="jp-Small jp-Muted" style={{ marginTop: 10 }}>
          The machine stops by itself after {workspace.idle_minutes} idle minutes (a running cell is not idle). The workspace&apos;s files are copied to /workspace on it; notebooks stay saved on the platform.
        </p>
      )}
      {pod && pick !== "local" && (
        <p className={`jp-Small ${differs ? "jp-WarnText" : "jp-Muted"}`} style={{ marginTop: 6 }}>
          Current machine: {podLabel(pod)} · {pod.status}{pod.cost_per_hr != null ? ` · $${pod.cost_per_hr.toFixed(2)}/hour` : ""}.
          {differs && " Selecting this terminates it (its /workspace disk is deleted) and starts a new machine."}
        </p>
      )}
    </DialogBox>
  );
}
