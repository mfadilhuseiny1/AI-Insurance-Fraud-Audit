"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, iconPath, type IconName } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { foldRunEvent, liveShown, ports, stopLive, TYPE_INFO, wb, type Catalog, type Graph, type LiveRun, type NodeType, type RunResult, type ShownRun, type Step, type WBDoc, type WBEdge, type WBNode } from "@/lib/workflowBuilder";
import { copyClip, pasteClip, readClip } from "@/lib/workflowBuilderClip";
import { LlmTranscript } from "./LlmTranscript";

const W = 210;
const H = 58;
type Side = "overview" | "params" | "preview" | "execution" | "runs" | "versions";
/** The preview: its start node and objects, the finished runs, and while a streamed preview runs (or after Stop) the
 * runs as they happen; error: the preview's own error (a run's errors are in the run). */
type PvState = { start: string; pks: string[]; results: RunResult[] | null; live: boolean; busy: boolean; open: number; stream: LiveRun[] | null; error: string | null };
const fmt = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const nid = () => `n${Math.random().toString(36).slice(2, 8)}`;

export function WorkflowBuilderEditor({ id }: { id: string }) {
  const [g, setG] = useState<Graph | null>(null);
  const [doc, setDoc] = useState<WBDoc | null>(null);
  const [past, setPast] = useState<WBDoc[]>([]);
  const [future, setFuture] = useState<WBDoc[]>([]);
  const [dirty, setDirty] = useState(false);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState({ x: 60, y: 140, k: 1 });
  const [side, setSide] = useState<Side>("overview");
  const [bottom, setBottom] = useState<null | "objects" | "watchlist">(null);
  const [pv, setPv] = useState<PvState>({ start: "", pks: [], results: null, live: true, busy: false, open: 0, stream: null, error: null });
  const streamCtl = useRef<AbortController | null>(null);
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [shownRun, setShownRun] = useState<RunResult | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<null | { kind: "pan" | "move" | "connect"; sx: number; sy: number; vx: number; vy: number; id?: string; port?: string; ox?: number; oy?: number; before?: WBDoc; moved?: boolean }>(null);
  const [wire, setWire] = useState<null | { from: string; port: string; x: number; y: number }>(null);

  useEffect(() => {
    wb.get(id).then(
      (x) => {
        setG(x);
        setDoc(x.doc);
      },
      (e: Error) => setErr(e.message),
    );
    wb.catalog().then(setCat, () => {});
    wb.runs(id).then(setRuns, () => {});
  }, [id]);
  // open zoomed to the whole graph (once the canvas is mounted)
  const fitted = useRef(false);
  useEffect(() => {
    const el = svgRef.current;
    if (fitted.current || !el || !doc?.nodes.length || !cat) return;
    fitted.current = true;
    const xs = doc.nodes.map((n) => n.x);
    const ys = doc.nodes.map((n) => n.y);
    const w = Math.max(...xs) + W - Math.min(...xs);
    const h = Math.max(...ys) + H - Math.min(...ys);
    const k = Math.min(1.2, Math.max(0.25, Math.min((el.clientWidth - 80) / w, (el.clientHeight - 80) / h)));
    const t = setTimeout(() => setView({ k, x: (el.clientWidth - w * k) / 2 - Math.min(...xs) * k, y: (el.clientHeight - h * k) / 2 - Math.min(...ys) * k }), 0);
    return () => clearTimeout(t);
  }, [doc, cat, g]);
  const change = useCallback((d: WBDoc, record = true) => {
    setDoc((cur) => {
      if (record && cur) {
        setPast((p) => [...p.slice(-80), cur]);
        setFuture([]);
      }
      return d;
    });
    setDirty(true);
  }, []);
  const byId = useMemo(() => Object.fromEntries((doc?.nodes ?? []).map((n) => [n.id, n])), [doc]);
  const starts = (doc?.nodes ?? []).filter((n) => n.type === "trigger" || n.type === "subgraph");
  const pvStart = pv.start || starts[0]?.id || "";
  const startNode = byId[pvStart];
  const pvType = (startNode?.config.object_type_id as string) || "";

  // previews stream: each node, the model's text and every tool call show as they happen; a new preview (or Stop)
  // closes the previous stream, which stops its runs on the server at their next node or model turn
  const runPreview = useCallback(async () => {
    if (!doc || !pvStart) return;
    streamCtl.current?.abort();
    const ctl = new AbortController();
    streamCtl.current = ctl;
    setPv((p) => ({ ...p, busy: true, stream: [], error: null }));
    try {
      const r = await wb.previewStream(id, doc, pvStart, pv.pks, (e) => {
        if (streamCtl.current === ctl) setPv((p) => ({ ...p, stream: foldRunEvent(p.stream ?? [], e) }));
      }, ctl.signal);
      if (streamCtl.current !== ctl) return;
      streamCtl.current = null;
      setPv((p) => ({ ...p, results: r, stream: null, busy: false, open: Math.min(p.open, Math.max(0, r.length - 1)) }));
    } catch (e) {
      if (streamCtl.current !== ctl) return; // replaced by a newer preview
      streamCtl.current = null;
      if (ctl.signal.aborted) {
        // Stop: what ran so far stays shown; previews no longer re-run on edits until started again
        setPv((p) => ({ ...p, busy: false, results: null, stream: p.stream ? stopLive(p.stream) : null }));
      } else {
        setPv((p) => ({ ...p, busy: false, error: (e as Error).message || "the preview failed", stream: p.stream?.length ? stopLive(p.stream) : null }));
      }
    }
  }, [doc, id, pvStart, pv.pks]);
  const stopPreview = useCallback(() => streamCtl.current?.abort(), []);
  useEffect(() => () => streamCtl.current?.abort(), []);
  const liveKey = pv.results && pv.live ? JSON.stringify(doc) : "";
  useEffect(() => {
    if (!liveKey) return;
    const t = setTimeout(() => void runPreview(), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  const save = async () => {
    if (!g || !doc) return;
    try {
      const x = await wb.save(id, doc, g.version);
      setG(x);
      setDirty(false);
      setMsg(`Saved v${x.version}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
      else if (mod && e.key.toLowerCase() === "z" && past.length && doc) {
        e.preventDefault();
        setFuture((f) => [doc, ...f]);
        setDoc(past[past.length - 1]);
        setPast((p) => p.slice(0, -1));
      } else if (mod && e.key.toLowerCase() === "y" && future.length && doc) {
        e.preventDefault();
        setPast((p) => [...p, doc]);
        setDoc(future[0]);
        setFuture((f) => f.slice(1));
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel && doc) {
        e.preventDefault();
        removeNode(sel);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
  // copy: the selected node, or the whole workflow of a selected trigger / subgraph (with the subgraphs it calls);
  // paste: into this graph (the clip travels on the system clipboard, so it can come from another graph)
  useEffect(() => {
    const inField = (t: EventTarget | null) => t instanceof Element && !!t.closest("input, textarea, select");
    const onCopy = (e: ClipboardEvent) => {
      if (inField(e.target) || !sel || !doc) return;
      const clip = copyClip(doc, sel);
      if (!clip) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", JSON.stringify(clip));
      setMsg(`Copied ${clip.label}`);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e.target) || !doc || readOnly) return;
      const clip = readClip(e.clipboardData?.getData("text/plain") ?? "");
      if (!clip) return;
      e.preventDefault();
      const r = pasteClip(doc, clip, nid);
      change(r.doc);
      setSel(r.ids[0] ?? null);
      setMsg(`Pasted ${clip.label}`);
    };
    window.addEventListener("copy", onCopy);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("paste", onPaste);
    };
  });

  if (err && !doc) return <p className="p-8 text-sm text-bad">{err}</p>;
  if (!g || !doc || !cat) return <p className="p-8 text-sm text-muted">Loading…</p>;
  const readOnly = !g.can_edit;

  function removeNode(nidToGo: string) {
    if (!doc) return;
    const n = doc.nodes.find((x) => x.id === nidToGo);
    if (!n || n.type === "after_fork" || n.type === "after_loop") return;
    const gone = new Set([nidToGo, ...doc.nodes.filter((x) => (x.type === "after_fork" || x.type === "after_loop") && x.config.of === nidToGo).map((x) => x.id)]);
    change({ ...doc, nodes: doc.nodes.filter((x) => !gone.has(x.id)), edges: doc.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)) });
    setSel(null);
  }
  const add = (type: NodeType) => {
    const from = sel ? byId[sel] : null;
    const at = from ? { x: from.x + W + 70, y: from.y } : { x: (-view.x + 200) / view.k, y: (-view.y + 200) / view.k };
    const defaults: Partial<Record<NodeType, Record<string, unknown>>> = {
      trigger: { mode: "manual", on: ["added", "modified"] },
      compute: { mode: "transform", assignments: [{ name: "value", expr: "" }], output: "" },
      llm: { model: cat.models.find((m) => m.default)?.id ?? cat.models[0]?.id, output_type: "string", prompt: "", tools: [] },
      fork: { cases: [{ id: "c1", name: "Case 1", condition: "" }] },
      effect: { mode: "nothing" },
      loop: { list: "", element: "item", index: "index" },
      subgraph: { inputs: [] },
      call_subgraph: { subgraph: "", inputs: {} },
    };
    const n: WBNode = { id: nid(), type, name: TYPE_INFO[type].label, x: Math.round(at.x), y: Math.round(at.y), config: defaults[type] ?? {} };
    const extra: WBNode[] = [];
    if (type === "fork" || type === "loop") extra.push({ id: nid(), type: type === "fork" ? "after_fork" : "after_loop", name: type === "fork" ? "After fork" : "After loop", x: n.x + 2 * (W + 70), y: n.y, config: { of: n.id } });
    const edges = [...doc.edges];
    if (from && type !== "trigger" && type !== "subgraph") {
      const port = from.type === "fork" || from.type === "loop" ? ports(from)[0].port : "next";
      const src = from.type === "fork" || from.type === "loop" ? from.id : from.id;
      if (!edges.some((e) => e.from === src && e.port === port)) edges.push({ from: src, to: n.id, port });
    }
    change({ ...doc, nodes: [...doc.nodes, n, ...extra], edges });
    setSel(n.id);
  };
  const setNode = (n: WBNode) => change({ ...doc, nodes: doc.nodes.map((x) => (x.id === n.id ? n : x)) });

  // the path of the shown run (a preview or a run from history) is drawn on the graph
  const liveRun = pv.stream?.find((r) => r.index === pv.open) ?? pv.stream?.[0];
  const shown: ShownRun | null = shownRun ?? (liveRun ? liveShown(liveRun, pvStart, true) : null) ?? pv.results?.[pv.open] ?? null;
  const running = new Set(shown?.running ?? []);
  const onPath = new Set([...(shown?.path.map((s) => s.node) ?? []), ...(shown ? [shown.start] : [])]);
  const failedAt = shown?.path.find((s) => s.error)?.node;
  // a node's latest step in the shown run (a node in a loop runs once per element)
  const stepOf = (node: string) => {
    for (let i = (shown?.path.length ?? 0) - 1; i >= 0; i--) if (shown!.path[i].node === node) return shown!.path[i];
    return undefined;
  };

  const world = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  const portPos = (n: WBNode, port: string) => {
    const ps = ports(n);
    const i = Math.max(0, ps.findIndex((p) => p.port === port));
    return { x: n.x + W, y: n.y + (ps.length === 1 ? H / 2 : 14 + i * 16) };
  };
  const nodeH = (n: WBNode) => Math.max(H, 14 + ports(n).length * 16);
  const down = (e: React.PointerEvent, n?: WBNode, port?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = world(e.clientX, e.clientY);
    if (n && port && !readOnly) {
      drag.current = { kind: "connect", sx: p.x, sy: p.y, vx: 0, vy: 0, id: n.id, port };
      setWire({ from: n.id, port, x: p.x, y: p.y });
      return;
    }
    if (n) {
      setSel(n.id);
      if (!readOnly) drag.current = { kind: "move", sx: p.x, sy: p.y, vx: 0, vy: 0, id: n.id, ox: n.x, oy: n.y, before: doc };
      return;
    }
    setSel(null);
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") return setView({ ...view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
    const p = world(e.clientX, e.clientY);
    if (d.kind === "connect") return setWire((w) => (w ? { ...w, x: p.x, y: p.y } : w));
    if (!d.moved && Math.abs(p.x - d.sx) + Math.abs(p.y - d.sy) < 3) return;
    d.moved = true;
    setDoc((cur) => (cur ? { ...cur, nodes: cur.nodes.map((x) => (x.id === d.id ? { ...x, x: Math.round(d.ox! + p.x - d.sx), y: Math.round(d.oy! + p.y - d.sy) } : x)) } : cur));
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "connect") {
      setWire(null);
      const p = world(e.clientX, e.clientY);
      const t = doc.nodes.find((n) => p.x >= n.x && p.x <= n.x + W && p.y >= n.y && p.y <= n.y + nodeH(n) && n.id !== d.id && n.type !== "trigger" && n.type !== "subgraph");
      if (t) change({ ...doc, edges: [...doc.edges.filter((x) => !(x.from === d.id && x.port === d.port)), { from: d.id!, to: t.id, port: d.port! }] });
    }
    if (d?.kind === "move" && d.moved && d.before) {
      setPast((pp) => [...pp.slice(-80), d.before!]);
      setFuture([]);
      setDirty(true);
    }
  };

  return (
    <div className="flex h-full flex-col" data-workflow-builder>
      <AppHeader app="Workflow Builder" icon="play" href="/workflow-builder" crumbs={[{ label: g.name }]}>
        <span className="text-[11px] text-muted">{err ?? msg ?? (dirty ? "Unsaved changes" : `v${g.version}`)}</span>
        {sel && (
          <button type="button" className={buttonClass.ghost} title="Copy the node, or the whole workflow of a trigger / subgraph (Ctrl+C); paste with Ctrl+V here or in another graph" data-copy
            onClick={async () => {
              const clip = copyClip(doc, sel);
              if (!clip) return;
              await navigator.clipboard?.writeText(JSON.stringify(clip)).catch(() => {});
              setMsg(`Copied ${clip.label}`);
            }}>
            <Icon name="copy" className="h-3.5 w-3.5" /> Copy
          </button>
        )}
        {!readOnly && (
          <button type="button" onClick={save} className={buttonClass.primary}>
            <Icon name="save" className="h-3.5 w-3.5" /> Save
          </button>
        )}
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel text-xs">
          <div className="flex flex-wrap gap-0.5 border-b border-line p-1">
            {(
              [
                ["overview", "Overview"],
                ["params", "Parameters"],
                ["preview", "Preview"],
                ["execution", "Execution"],
                ["runs", "Run history"],
                ["versions", "Versions"],
              ] as const
            ).map(([s, t]) => (
              <button key={s} type="button" onClick={() => setSide(s)} className={`rounded px-2 py-1 ${side === s ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`} data-side={s}>
                {t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {side === "overview" && (
              <div className="space-y-2">
                {starts.map((s) => {
                  const reach = new Set<string>();
                  const walk = (x: string) => {
                    for (const e of doc.edges.filter((e) => e.from === x)) if (!reach.has(e.to)) {
                      reach.add(e.to);
                      walk(e.to);
                    }
                    for (const a of doc.nodes.filter((n) => (n.type === "after_fork" || n.type === "after_loop") && n.config.of === x)) if (!reach.has(a.id)) {
                      reach.add(a.id);
                      walk(a.id);
                    }
                  };
                  walk(s.id);
                  const dep = g.deployed[s.id];
                  return (
                    <div key={s.id} className="rounded border border-line p-2">
                      <button type="button" onClick={() => setSel(s.id)} className="font-medium text-white hover:underline">
                        {s.name}
                      </button>
                      <div className="text-muted">
                        {s.type === "subgraph" ? "Subgraph" : `Trigger · ${s.config.mode}`} · {reach.size} nodes · {doc.nodes.filter((n) => reach.has(n.id) && n.type === "fork").length} forks
                      </div>
                      {s.type === "trigger" && <div className={dep?.enabled ? "text-ok" : "text-muted"}>{dep?.enabled ? `Deployed (v${dep.version}) ${when(dep.at)}` : "Not deployed"}</div>}
                    </div>
                  );
                })}
                {!starts.length && <p className="text-muted">Add a Trigger to start a workflow.</p>}
              </div>
            )}
            {side === "params" && (
              <div className="space-y-1.5">
                <p className="text-muted">Reusable values, referenced as params.name.</p>
                {doc.params.map((p, i) => (
                  <div key={i} className="flex gap-1">
                    <input value={p.name} readOnly={readOnly} onChange={(e) => change({ ...doc, params: doc.params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }, false)} className={`${fieldClass} w-28 text-xs`} />
                    <input value={fmt(p.value)} readOnly={readOnly} onChange={(e) => change({ ...doc, params: doc.params.map((x, j) => (j === i ? { ...x, value: isNaN(Number(e.target.value)) || e.target.value === "" ? e.target.value : Number(e.target.value) } : x)) }, false)} className={`${fieldClass} flex-1 text-xs`} />
                    {!readOnly && (
                      <button type="button" onClick={() => change({ ...doc, params: doc.params.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {!readOnly && (
                  <button type="button" onClick={() => change({ ...doc, params: [...doc.params, { name: `param${doc.params.length + 1}`, value: "" }] })} className="text-ocean">
                    + Parameter
                  </button>
                )}
              </div>
            )}
            {(side === "preview" || side === "execution") && (
              <PreviewPanel
                mode={side}
                g={g}
                starts={starts}
                start={pvStart}
                pvType={pvType}
                pv={pv}
                setPv={setPv}
                onRun={runPreview}
                onStop={stopPreview}
                byId={byId}
                onFocus={setSel}
                onShow={(r) => setShownRun(r)}
                onExecuted={async (r) => (setRuns(await wb.runs(id)), setShownRun(r[0] ?? null), setMsg(`Executed: ${r.map((x) => x.status).join(", ")}`))}
                onDeploy={async (s, on) => {
                  try {
                    if (dirty) await save();
                    setG(await wb.deploy(id, s, on));
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
                dirty={dirty}
              />
            )}
            {side === "runs" && (
              <div className="space-y-1">
                <button type="button" onClick={async () => setRuns(await wb.runs(id))} className="text-ocean">
                  Refresh
                </button>
                {runs.map((r) => (
                  <div key={r.id} className={`rounded border p-1.5 ${shownRun?.id === r.id ? "border-ocean" : "border-line"}`}>
                    <button type="button" onClick={() => setShownRun(shownRun?.id === r.id ? null : r)} className="w-full text-left">
                      <span className={r.status === "failed" ? "text-bad" : "text-ok"}>{r.status}</span> · {r.trigger} · {when(r.at)}
                      <div className="text-muted">
                        {byId[r.start]?.name ?? r.start} · {fmt(r.inputs.object ?? "")} · {r.ms} ms
                      </div>
                      {r.error && <div className="text-bad">{r.error}</div>}
                    </button>
                    {r.inputs.object !== undefined && (
                      <button type="button" onClick={() => (setPv((p) => ({ ...p, start: r.start, pks: [...new Set([...p.pks, String(r.inputs.object)])] })), setSide("preview"))} className="text-ocean">
                        Send to preview
                      </button>
                    )}
                  </div>
                ))}
                {!runs.length && <p className="text-muted">No runs yet.</p>}
              </div>
            )}
            {side === "versions" && (
              <div className="space-y-1">
                {g.versions.map((v) => (
                  <div key={v.version} className="flex items-center gap-2 border-b border-line py-1">
                    <span className="font-mono">v{v.version}</span>
                    <span className="flex-1">
                      {v.description || "Saved"} <span className="text-muted">· {v.by} · {when(v.at)}</span>
                    </span>
                    {!readOnly && v.version !== g.version && (
                      <button type="button" onClick={async () => { const x = await wb.restore(id, v.version); setG(x); setDoc(x.doc); setDirty(false); }} className="text-ocean">
                        Revert
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <svg ref={svgRef} className="h-full w-full touch-none select-none bg-ink" onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up}
              onWheel={(e) => {
                const r = svgRef.current!.getBoundingClientRect();
                const k = Math.min(2, Math.max(0.2, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
                const mx = e.clientX - r.left;
                const my = e.clientY - r.top;
                setView({ k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k });
              }} data-wb-canvas>
              <defs>
                <marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-muted)" />
                </marker>
              </defs>
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {doc.nodes.filter((n) => n.type === "after_fork" || n.type === "after_loop").map((a) => {
                  const o = byId[a.config.of as string];
                  if (!o) return null;
                  return <path key={`own-${a.id}`} d={`M ${o.x + W / 2} ${o.y + nodeH(o)} C ${o.x + W / 2} ${o.y + nodeH(o) + 70}, ${a.x + W / 2} ${a.y + H + 70}, ${a.x + W / 2} ${a.y + H}`} fill="none" stroke="var(--color-line-2)" strokeDasharray="3 4" />;
                })}
                {doc.edges.map((e: WBEdge, i) => {
                  const a = byId[e.from];
                  const b = byId[e.to];
                  if (!a || !b) return null;
                  const p1 = portPos(a, e.port);
                  const x2 = b.x;
                  const y2 = b.y + H / 2;
                  const c = Math.max(40, Math.abs(x2 - p1.x) / 2);
                  const hot = onPath.has(e.from) && onPath.has(e.to);
                  return <path key={i} d={`M ${p1.x} ${p1.y} C ${p1.x + c} ${p1.y}, ${x2 - c} ${y2}, ${x2} ${y2}`} fill="none" stroke={hot ? "var(--color-ok)" : "var(--color-muted)"} strokeWidth={hot ? 2.4 : 1.4} markerEnd="url(#wb-arrow)" />;
                })}
                {doc.nodes.filter((n) => n.type === "after_fork" || n.type === "after_loop").map((a) => {
                  // branches that end continue at the after node
                  const o = byId[a.config.of as string];
                  if (!o) return null;
                  const inside = new Set<string>();
                  const walk = (x: string) => {
                    for (const e of doc.edges.filter((e) => e.from === x)) if (!inside.has(e.to) && e.to !== a.id) {
                      inside.add(e.to);
                      walk(e.to);
                    }
                  };
                  walk(o.id);
                  const ends = [...inside].filter((x) => !doc.edges.some((e) => e.from === x) && byId[x] && byId[x].type !== "after_fork" && byId[x].type !== "after_loop");
                  return ends.map((x) => {
                    const n = byId[x];
                    return <path key={`end-${a.id}-${x}`} d={`M ${n.x + W} ${n.y + H / 2} L ${a.x} ${a.y + H / 2}`} fill="none" stroke={onPath.has(x) ? "var(--color-ok)" : "var(--color-line-2)"} strokeDasharray="5 4" markerEnd="url(#wb-arrow)" />;
                  });
                })}
                {wire && byId[wire.from] && (() => {
                  const p = portPos(byId[wire.from], wire.port);
                  return <path d={`M ${p.x} ${p.y} L ${wire.x} ${wire.y}`} stroke="var(--color-ocean)" strokeDasharray="4 3" fill="none" />;
                })()}
                {doc.nodes.map((n) => {
                  const info = TYPE_INFO[n.type];
                  const h = nodeH(n);
                  const step = stepOf(n.id);
                  const dep = g.deployed[n.id]?.enabled;
                  const busyHere = running.has(n.id);
                  return (
                    <g key={n.id} transform={`translate(${n.x},${n.y})`} onPointerDown={(e) => down(e, n)} className="cursor-pointer" data-wb-node={n.id} data-type={n.type} data-running={busyHere || undefined}>
                      <rect width={W} height={h} rx={8} fill="var(--color-panel-2)" stroke={sel === n.id || busyHere ? "var(--color-ocean)" : failedAt === n.id ? "var(--color-bad)" : onPath.has(n.id) ? "var(--color-ok)" : "var(--color-line-2)"} strokeWidth={sel === n.id || onPath.has(n.id) ? 2 : 1.2} strokeDasharray={busyHere ? "6 4" : undefined} />
                      <rect width={5} height={h} rx={2} fill={info.color} />
                      <g transform="translate(12,10) scale(0.7)">
                        <path d={iconPath(info.icon as IconName)} fill="none" stroke={info.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                      </g>
                      <text x={34} y={22} fontSize={12.5} fontWeight={600} fill="var(--color-strong)">
                        {n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name}
                      </text>
                      <text x={12} y={42} fontSize={10} fill={step?.error ? "var(--color-bad)" : "var(--color-muted)"}>
                        {busyHere ? (step?.turns?.length ? `turn ${step.turns[step.turns.length - 1].turn} · ${step.tool_calls?.length ?? 0} tool calls…` : "running…") : step ? (step.error ? `✗ ${step.error}`.slice(0, 34) : `= ${fmt(step.value)}`.slice(0, 34)) : `${info.label}${dep ? " · deployed" : ""}`}
                      </text>
                      {ports(n).map((p, i) => {
                            const y = ports(n).length === 1 ? H / 2 : 14 + i * 16;
                            return (
                              <g key={p.port} onPointerDown={(e) => down(e, n, p.port)} className="cursor-crosshair" data-port={p.port}>
                                {p.label && (
                                  <text x={W - 10} y={y + 3} textAnchor="end" fontSize={9} fill="var(--color-soft)">
                                    {p.label.slice(0, 18)}
                                  </text>
                                )}
                                <circle cx={W} cy={y} r={5} fill="var(--color-panel)" stroke="var(--color-ocean)" />
                              </g>
                            );
                          })}
                      {n.type !== "trigger" && n.type !== "subgraph" && <circle cx={0} cy={H / 2} r={4} fill="var(--color-panel)" stroke="var(--color-line-2)" />}
                    </g>
                  );
                })}
              </g>
            </svg>
            {shown && (
              <div className="absolute right-3 top-3 z-10 max-w-sm rounded border border-line bg-panel px-3 py-1.5 text-xs shadow">
                {shown.preview ? "Preview" : "Run"} {shown.status} · {shown.path.length} steps
                {pv.busy && !shownRun && (
                  <button type="button" onClick={stopPreview} className="ml-2 text-bad" data-stop-top title="Stop the preview: close the stream (the runs stop at their next node or model turn)">
                    Stop
                  </button>
                )}
                <button type="button" onClick={() => (stopPreview(), setShownRun(null), setPv((p) => ({ ...p, results: null, stream: null, error: null })))} className="ml-2 text-ocean">
                  Clear path
                </button>
              </div>
            )}
          </div>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-1 border-t border-line bg-panel px-2 py-1 text-xs" data-palette>
              {(["trigger", "subgraph", "compute", "llm", "fork", "effect", "loop", "call_subgraph"] as NodeType[]).map((t) => (
                <button key={t} type="button" onClick={() => add(t)} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-panel-2" data-add={t}>
                  <span className="h-2 w-2 rounded-full" style={{ background: TYPE_INFO[t].color }} /> {TYPE_INFO[t].label}
                </button>
              ))}
              <span className="ml-2 text-muted">{sel ? "adds after the selected node" : "select a node to add after it"}</span>
              <span className="ml-auto flex gap-1">
                <button type="button" onClick={() => setBottom(bottom === "objects" ? null : "objects")} className={`rounded px-2 py-1 ${bottom === "objects" ? "text-ocean" : "text-muted"}`}>
                  Workflow objects
                </button>
                <button type="button" onClick={() => setBottom(bottom === "watchlist" ? null : "watchlist")} className={`rounded px-2 py-1 ${bottom === "watchlist" ? "text-ocean" : "text-muted"}`}>
                  Object watchlist ({doc.watchlist.length})
                </button>
              </span>
            </div>
          )}
          {bottom && <ObjectsPanel id={id} doc={doc} cat={cat} watch={bottom === "watchlist"} onWatch={(pks) => change({ ...doc, watchlist: pks }, false)} onPreview={(pk) => (setPv((p) => ({ ...p, pks: [...new Set([...p.pks, pk])] })), setSide("preview"))} defaultType={pvType} />}
        </div>
        {sel && byId[sel] && <NodePanel node={byId[sel]} doc={doc} cat={cat} readOnly={readOnly} onChange={setNode} onDelete={() => removeNode(sel)} onClose={() => setSel(null)} step={stepOf(sel)} streaming={running.has(sel)} />}
      </div>
    </div>
  );
}

/** A run's path in the side panel: each step with its value or error; Use LLM steps with their turns and tool calls
 * (open while the node runs, so the model's text is seen as it streams). */
function PathRows({ run, byId, onFocus }: { run: ShownRun; byId: Record<string, WBNode>; onFocus: (id: string) => void }) {
  const running = new Set(run.running ?? []);
  return (
    <div className="mt-1 space-y-0.5" data-path>
      {run.path.map((s, j) => {
        const live = running.has(s.node) && j === run.path.map((x) => x.node).lastIndexOf(s.node);
        const llm = s.type === "llm" && (!!s.turns?.length || !!s.tool_calls?.length || live);
        return (
          <div key={j} data-path-step={s.node} data-status={live ? "running" : s.error ? "failed" : "done"}>
            <button type="button" onClick={() => onFocus(s.node)} title={fmt(s.value)} className="block w-full truncate text-left hover:text-white">
              <span className={live ? "text-ocean" : s.error ? "text-bad" : "text-ok"}>{live ? "◌" : s.error ? "✗" : "●"}</span> {byId[s.node]?.name ?? s.node}:{" "}
              <span className={s.error ? "text-bad" : "text-muted"}>{live ? "running…" : s.error ?? fmt(s.value)}</span>
              {!!s.tool_calls?.length && <span className="ml-1 text-sand">· {s.tool_calls.length} tool call{s.tool_calls.length === 1 ? "" : "s"}</span>}
            </button>
            {llm && (
              <details open={live || s.error === "stopped" || undefined} className="ml-3 border-l border-line pl-2">
                <summary className="cursor-pointer text-[10px] text-muted">Model turns</summary>
                <LlmTranscript step={s} streaming={live} compact />
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RunEdits({ edits }: { edits: RunResult["edits"] }) {
  return (
    <>
      <div className="mt-1 font-medium text-soft">Outputs ({edits?.length ?? 0} objects)</div>
      {edits?.map((e, k) => (
        <details key={k} className="rounded bg-ink px-1.5 py-0.5">
          <summary className="cursor-pointer">
            {e.op} · {e.object_type} · <span className="font-mono">{e.primary_key}</span>
          </summary>
          {Object.entries(e.changes).map(([p, c]) => (
            <div key={p} className="font-mono text-[10px]">
              {p}: <span className="text-bad line-through">{fmt(c.from)}</span> → <span className="text-ok">{fmt(c.to)}</span>
            </div>
          ))}
        </details>
      ))}
    </>
  );
}

const statusClass = (s: ShownRun["status"]) => (s === "failed" ? "text-bad" : s === "succeeded" ? "text-ok" : s === "stopped" ? "text-warn" : "text-ocean");

function PreviewPanel({ mode, g, starts, start, pvType, pv, setPv, onRun, onStop, byId, onFocus, onShow, onExecuted, onDeploy, dirty }: {
  mode: "preview" | "execution"; g: Graph; starts: WBNode[]; start: string; pvType: string; pv: PvState;
  setPv: React.Dispatch<React.SetStateAction<PvState>>; onRun: () => void; onStop: () => void; byId: Record<string, WBNode>;
  onFocus: (id: string) => void; onShow: (r: RunResult | null) => void; onExecuted: (r: RunResult[]) => void; onDeploy: (start: string, on: boolean) => void; dirty: boolean;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ primary_key: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false);
  // a streamed execution: its runs as they happen (closing the stream does not stop a run on main, so no Stop here)
  const [exec, setExec] = useState<LiveRun[] | null>(null);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [execOpen, setExecOpen] = useState(0);
  // the runs to list: the streamed ones (running, or stopped) while there are any, else the finished preview
  const runs: ShownRun[] = pv.stream ? pv.stream.map((r) => liveShown(r, start, true)) : (pv.results ?? []);
  useEffect(() => {
    if (!pvType) return;
    let stale = false;
    const t = setTimeout(() => wb.objects(g.id, pvType, q).then((r) => !stale && setFound(r.objects.slice(0, 12)), () => {}), 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, pvType, g.id]);
  const node = byId[start];
  const dep = g.deployed[start];
  return (
    <div className="space-y-2" data-preview-panel={mode}>
      <select value={start} onChange={(e) => setPv((p) => ({ ...p, start: e.target.value, results: null }))} className={inputClass}>
        {starts.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {pvType ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="+ Add objects to run" className={inputClass} />
          {found.filter((f) => !pv.pks.includes(f.primary_key)).slice(0, 6).map((f) => (
            <button key={f.primary_key} type="button" onClick={() => setPv((p) => ({ ...p, pks: [...p.pks, f.primary_key] }))} className="block w-full truncate text-left text-ocean hover:underline">
              + {f.title} <span className="text-muted">{f.primary_key}</span>
            </button>
          ))}
          <div className="flex flex-wrap gap-1">
            {pv.pks.map((pk) => (
              <span key={pk} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px]">
                {pk}
                <button type="button" onClick={() => setPv((p) => ({ ...p, pks: p.pks.filter((x) => x !== pk) }))} className="ml-1 text-muted">
                  ✕
                </button>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="text-muted">{node?.type === "trigger" && node.config.mode === "schedule" ? "A scheduled workflow runs without input objects." : "This workflow has no object input."}</p>
      )}
      {mode === "preview" ? (
        <>
          <div className="flex items-center gap-2">
            {pv.busy ? (
              <button type="button" onClick={onStop} className={buttonClass.secondary} data-stop title="Stop: close the stream; the runs stop at their next node or model turn, their sandboxes are dropped">
                <Icon name="x" className="h-3.5 w-3.5" /> Stop
              </button>
            ) : (
              <button type="button" disabled={!!pvType && !pv.pks.length} onClick={onRun} className={buttonClass.primary} data-start-preview>
                <Icon name="play" className="h-3.5 w-3.5" /> Start preview
              </button>
            )}
            {(pv.results || pv.stream) && (
              <button type="button" onClick={() => (onStop(), setPv((p) => ({ ...p, results: null, stream: null, error: null })), onShow(null))} className={buttonClass.secondary} title="Stop preview mode" data-exit-preview>
                <Icon name="pause" className="h-3.5 w-3.5" />
              </button>
            )}
            <label className="flex items-center gap-1 text-muted">
              <input type="checkbox" checked={pv.live} onChange={(e) => setPv((p) => ({ ...p, live: e.target.checked }))} /> live
            </label>
            {pv.busy && <span className="text-ocean" data-streaming>Streaming…</span>}
          </div>
          <p className="text-muted">Previews run in a sandbox: actions run, their edits are listed, nothing is written.</p>
          {pv.error && (
            <div className="whitespace-pre-wrap rounded border border-bad/50 bg-bad/10 p-2 text-bad" data-preview-error>
              {pv.error}
            </div>
          )}
          {!pv.busy && pv.stream && (!pv.stream.length || pv.stream.some((r) => r.status === "stopped")) && <p className="text-warn" data-stopped>Stopped: the runs ended at their next node or model turn; nothing was written.</p>}
          {runs.map((r, i) => (
            <div key={r.id} className={`rounded border p-2 ${pv.open === i ? "border-ocean" : "border-line"}`} data-run-card={r.status}>
              <button type="button" onClick={() => setPv((p) => ({ ...p, open: i }))} className="w-full text-left">
                <span className={statusClass(r.status)}>{r.status}</span> · {fmt(r.inputs.object ?? "inputs")}
                {r.status !== "running" && r.status !== "stopped" && ` · ${r.ms} ms`}
              </button>
              {pv.open === i && (
                <>
                  <PathRows run={r} byId={byId} onFocus={onFocus} />
                  {r.error && <div className="text-bad" data-run-error>{r.error}</div>}
                  {r.status !== "running" && r.status !== "stopped" && <RunEdits edits={r.edits} />}
                </>
              )}
            </div>
          ))}
        </>
      ) : (
        <div className="space-y-2">
          <button type="button" disabled={busy || !g.can_edit || dirty || (!!pvType && !pv.pks.length)}
            onClick={async () => {
              if (!window.confirm("Run the saved workflow for real? Its actions write to the Nexus.")) return;
              setBusy(true);
              setExec([]);
              setExecErr(null);
              setExecOpen(0);
              try {
                const r = await wb.executeStream(g.id, start, pv.pks, (e) => setExec((x) => foldRunEvent(x ?? [], e)));
                setExec(null);
                onExecuted(r);
              } catch (e) {
                setExecErr((e as Error).message || "the run failed");
              } finally {
                setBusy(false);
              }
            }}
            className={buttonClass.secondary} data-run-now>
            {busy ? "Running…" : `Run now${pv.pks.length ? ` on ${pv.pks.length} object${pv.pks.length === 1 ? "" : "s"}` : ""}`}
          </button>
          {busy && <p className="text-muted">A run on main finishes and is recorded even if you leave this page.</p>}
          {execErr && <div className="whitespace-pre-wrap rounded border border-bad/50 bg-bad/10 p-2 text-bad" data-exec-error>{execErr}</div>}
          {exec?.map((x, i) => {
            const r = liveShown(x, start, false);
            return (
              <div key={r.id} className={`rounded border p-2 ${execOpen === i ? "border-ocean" : "border-line"}`} data-exec-card={r.status}>
                <button type="button" onClick={() => setExecOpen(i)} className="w-full text-left">
                  <span className={statusClass(r.status)}>{r.status}</span> · {fmt(r.inputs.object ?? "inputs")}
                </button>
                {execOpen === i && <PathRows run={r} byId={byId} onFocus={onFocus} />}
                {r.error && <div className="text-bad">{r.error}</div>}
              </div>
            );
          })}
          {dirty && <p className="text-warn">Save first: execution runs the saved version.</p>}
          {node?.type === "trigger" && (
            <div className="rounded border border-line p-2">
              <div className="font-medium text-soft">Deployment</div>
              <div className="text-muted">
                {node.config.mode === "object" ? `Runs when ${String((node.config.on as string[] | undefined)?.join(" or ") ?? "added or modified")} objects${node.config.property ? ` (when ${node.config.property} changes)` : ""}` : node.config.mode === "schedule" ? `Runs every ${node.config.every_minutes ?? 60} minutes` : "Manual: run it from here"}
              </div>
              <div className={dep?.enabled ? "text-ok" : "text-muted"}>{dep?.enabled ? `Deployed v${dep.version} · runs as the deployer` : "Not deployed"}</div>
              {g.can_edit && node.config.mode !== "manual" && (
                <button type="button" onClick={() => onDeploy(start, !dep?.enabled)} className={`${dep?.enabled ? buttonClass.secondary : buttonClass.primary} mt-1`}>
                  {dep?.enabled ? "Undeploy" : "Deploy"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodePanel({ node, doc, cat, readOnly, onChange, onDelete, onClose, step, streaming }: { node: WBNode; doc: WBDoc; cat: Catalog; readOnly: boolean; onChange: (n: WBNode) => void; onDelete: () => void; onClose: () => void; step?: Step; streaming?: boolean }) {
  const c = node.config;
  const set = (k: string, v: unknown) => onChange({ ...node, config: { ...c, [k]: v } });
  const lab = "block text-[11px] text-muted";
  const ot = cat.object_types.find((t) => t.id === c.object_type_id);
  const act = cat.action_types.find((a) => a.id === c.action_type_id);
  const fn = cat.functions.find((f) => f.id === c.function_id);
  const sub = doc.nodes.find((n) => n.id === c.subgraph);
  return (
    <aside className="w-96 shrink-0 space-y-2 overflow-auto border-l border-line bg-panel p-3 text-xs" data-node-panel={node.type}>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE_INFO[node.type].color }} />
        <input value={node.name} readOnly={readOnly} onChange={(e) => onChange({ ...node, name: e.target.value })} className={`${fieldClass} flex-1 text-xs`} />
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <fieldset disabled={readOnly} className="space-y-2">
        {node.type === "trigger" && (
          <>
            <label className={lab}>
              Start when
              <select value={String(c.mode ?? "manual")} onChange={(e) => set("mode", e.target.value)} className={inputClass}>
                <option value="object">An Nexus object changes</option>
                <option value="schedule">On a schedule</option>
                <option value="manual">Manually</option>
              </select>
            </label>
            {(c.mode === "object" || c.mode === "manual") && (
              <label className={lab}>
                Object type (its object is `object`)
                <select value={String(c.object_type_id ?? "")} onChange={(e) => set("object_type_id", e.target.value)} className={inputClass}>
                  <option value="">None</option>
                  {cat.object_types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {c.mode === "object" && (
              <>
                <div className="flex gap-3">
                  {["added", "modified"].map((k) => (
                    <label key={k} className="flex items-center gap-1">
                      <input type="checkbox" checked={((c.on as string[]) ?? []).includes(k)} onChange={(e) => set("on", e.target.checked ? [...((c.on as string[]) ?? []), k] : ((c.on as string[]) ?? []).filter((x) => x !== k))} /> {k}
                    </label>
                  ))}
                </div>
                <label className={lab}>
                  Only when this property changes (optional)
                  <select value={String(c.property ?? "")} onChange={(e) => set("property", e.target.value || null)} className={inputClass}>
                    <option value="">Any change</option>
                    {ot?.properties.map((p) => (
                      <option key={p.api_name} value={p.api_name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {c.mode === "schedule" && (
              <label className={lab}>
                Every (minutes)
                <input type="number" min={1} value={Number(c.every_minutes ?? 60)} onChange={(e) => set("every_minutes", Number(e.target.value))} className={inputClass} />
              </label>
            )}
          </>
        )}
        {node.type === "subgraph" && (
          <label className={lab}>
            Inputs (comma-separated names; callers pass them)
            <input value={((c.inputs as string[]) ?? []).join(", ")} onChange={(e) => set("inputs", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} className={inputClass} />
          </label>
        )}
        {node.type !== "trigger" && node.type !== "subgraph" && node.type !== "fork" && node.type !== "loop" && node.type !== "after_fork" && node.type !== "after_loop" && (
          <label className={lab}>
            Output name (later nodes use it)
            <input value={String(c.output ?? "")} placeholder={node.name} onChange={(e) => set("output", e.target.value)} className={inputClass} />
          </label>
        )}
        {node.type === "compute" && (
          <>
            <select value={String(c.mode ?? "transform")} onChange={(e) => set("mode", e.target.value)} className={inputClass}>
              <option value="transform">Build a transform</option>
              <option value="function">Run a function</option>
            </select>
            {c.mode === "function" ? (
              <>
                <select value={String(c.function_id ?? "")} onChange={(e) => set("function_id", e.target.value)} className={inputClass}>
                  <option value="">Choose a function</option>
                  {cat.functions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} · {f.version}
                    </option>
                  ))}
                </select>
                {fn?.inputs.map((i) => (
                  <label key={i.name} className={lab}>
                    {i.name} <span className="text-muted">({i.type})</span>
                    <input value={fmt((c.inputs as Record<string, unknown>)?.[i.name] ?? "")} onChange={(e) => set("inputs", { ...((c.inputs as object) ?? {}), [i.name]: e.target.value })} placeholder="{{object.__pk}} or = expression" className={inputClass} />
                  </label>
                ))}
              </>
            ) : (
              <>
                {((c.assignments as { name: string; expr: string }[]) ?? []).map((a, i, all) => (
                  <div key={i} className="flex gap-1">
                    <input value={a.name} onChange={(e) => set("assignments", all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${fieldClass} w-24 text-xs`} />
                    <span className="pt-1">=</span>
                    <input value={a.expr} onChange={(e) => set("assignments", all.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)))} placeholder="object.tarif_rs - object.tarif_inacbg" className={`${fieldClass} flex-1 font-mono text-xs`} />
                  </div>
                ))}
                <button type="button" onClick={() => set("assignments", [...((c.assignments as object[]) ?? []), { name: `v${((c.assignments as object[]) ?? []).length + 1}`, expr: "" }])} className="text-ocean">
                  + Value
                </button>
                <p className="text-muted">One value: the node outputs it; several: an object of them.</p>
              </>
            )}
          </>
        )}
        {node.type === "llm" && (
          <>
            <select value={String(c.model ?? "")} onChange={(e) => set("model", e.target.value)} className={inputClass}>
              {cat.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <label className={lab}>
              Prompt
              <textarea value={String(c.prompt ?? "")} onChange={(e) => set("prompt", e.target.value)} rows={5} placeholder="Summarize {{object.no_sep}} …" className={`${inputClass} text-xs`} />
            </label>
            <label className={lab}>
              Output type
              <select value={String(c.output_type ?? "string")} onChange={(e) => set("output_type", e.target.value)} className={inputClass}>
                {["string", "boolean", "integer", "double", "string_array", "struct"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            {c.output_type === "struct" && (
              <label className={lab}>
                Fields (name:type, comma-separated)
                <input value={((c.fields as { name: string; type: string }[]) ?? []).map((f) => `${f.name}:${f.type}`).join(", ")} onChange={(e) => set("fields", e.target.value.split(",").map((x) => x.trim()).filter(Boolean).map((x) => ({ name: x.split(":")[0], type: x.split(":")[1] || "string" })))} className={inputClass} />
              </label>
            )}
            <div className="font-medium text-soft">Tools</div>
            <label className="flex items-center gap-2" data-tool-calling>
              <input type="checkbox" checked={!!c.tool_calling} onChange={(e) => set("tool_calling", e.target.checked)} /> The model calls the tools (in a loop, up to
              <input type="number" min={1} max={20} value={Number(c.max_tool_calls ?? 6)} onChange={(e) => set("max_tool_calls", Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className={`${fieldClass} w-14 text-xs`} /> calls)
            </label>
            <p className="text-[10px] text-muted">{c.tool_calling ? "The model decides which tools to call and with which arguments; fixed values below are always passed. Actions really apply (in previews: in the sandbox)." : "Off: object queries and functions run before the call and their results go in the prompt."}</p>
            {!!c.tool_calling && (
              <label className={lab}>
                Tool calling mode
                <select value={String(c.tool_mode ?? "auto")} onChange={(e) => set("tool_mode", e.target.value)} className={inputClass} data-tool-mode>
                  <option value="auto">Auto: native, else JSON-in-text</option>
                  <option value="native">Native tool calls only</option>
                  <option value="json">JSON-in-text</option>
                </select>
                <span className="mt-0.5 block text-[10px]">
                  {c.tool_mode === "native"
                    ? "The provider's tool calling (OpenRouter tools, Gemini function declarations); the node fails if the model or route has none."
                    : c.tool_mode === "json"
                      ? "The model answers in JSON text: a tool call, several calls, or the answer. Works with any model, registered models too."
                      : "Native tool calls where the model has them; registered models and routes without tool use fall back to JSON-in-text."}
                </span>
              </label>
            )}
            {((c.tools as { kind: string; object_type_id?: string; query?: string; limit?: number; name?: string; function_id?: string; action_type_id?: string; inputs?: Record<string, unknown>; parameters?: Record<string, unknown> }[]) ?? []).map((t, i, all) => {
              const put = (x: Record<string, unknown>) => set("tools", all.map((y, j) => (j === i ? { ...y, ...x } : y)));
              const tf = cat.functions.find((f) => f.id === t.function_id);
              const ta = cat.action_types.find((a) => a.id === t.action_type_id);
              return (
                <div key={i} className="space-y-1 rounded border border-line p-1.5" data-tool={t.kind}>
                  <div className="flex gap-1">
                    <select value={t.kind} onChange={(e) => put({ kind: e.target.value, object_type_id: undefined, function_id: undefined, action_type_id: undefined, inputs: undefined, parameters: undefined })} className={`${fieldClass} text-xs`}>
                      <option value="object_query">Object query</option>
                      <option value="function">Function</option>
                      {!!c.tool_calling && <option value="action">Action</option>}
                    </select>
                    <input value={t.name ?? ""} placeholder="tool name" onChange={(e) => put({ name: e.target.value })} className={`${fieldClass} w-24 text-xs`} />
                    <button type="button" onClick={() => set("tools", all.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
                      ✕
                    </button>
                  </div>
                  {t.kind === "object_query" && (
                    <>
                      <select value={t.object_type_id ?? ""} onChange={(e) => put({ object_type_id: e.target.value })} className={`${fieldClass} w-full text-xs`}>
                        {cat.object_types.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                      <input value={t.query ?? ""} placeholder={c.tool_calling ? "default search text (the model gives its own)" : "search text, e.g. {{object.faskes}}"} onChange={(e) => put({ query: e.target.value })} className={`${inputClass} text-xs`} />
                    </>
                  )}
                  {t.kind === "function" && (
                    <>
                      <select value={t.function_id ?? ""} onChange={(e) => put({ function_id: e.target.value, inputs: {} })} className={`${fieldClass} w-full text-xs`}>
                        <option value="">Choose a function…</option>
                        {cat.functions.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name} ({f.version}) → {f.output}
                          </option>
                        ))}
                      </select>
                      {tf?.inputs.map((inp) => (
                        <input key={inp.name} value={String(t.inputs?.[inp.name] ?? "")} placeholder={`${inp.name} (${inp.type})${c.tool_calling ? ": empty, the model gives it" : ""}`}
                          onChange={(e) => {
                            const next = { ...t.inputs };
                            if (e.target.value === "") delete next[inp.name];
                            else next[inp.name] = e.target.value;
                            put({ inputs: next });
                          }}
                          className={`${inputClass} text-xs`} />
                      ))}
                    </>
                  )}
                  {t.kind === "action" && (
                    <>
                      <select value={t.action_type_id ?? ""} onChange={(e) => put({ action_type_id: e.target.value, parameters: {} })} className={`${fieldClass} w-full text-xs`}>
                        <option value="">Choose an action…</option>
                        {cat.action_types.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      {ta?.parameters.map((pm) => (
                        <input key={pm.id} value={String(t.parameters?.[pm.id] ?? "")} placeholder={`${pm.name} (${pm.type}): empty, the model gives it`}
                          onChange={(e) => {
                            const next = { ...t.parameters };
                            if (e.target.value === "") delete next[pm.id];
                            else next[pm.id] = e.target.value;
                            put({ parameters: next });
                          }}
                          className={`${inputClass} text-xs`} />
                      ))}
                    </>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => set("tools", [...((c.tools as object[]) ?? []), { kind: "object_query", object_type_id: cat.object_types[0]?.id, name: `tool_${((c.tools as object[]) ?? []).length + 1}`, limit: 20 }])} className="text-ocean" data-add-tool>
              + Tool
            </button>
          </>
        )}
        {node.type === "fork" && (
          <>
            {((c.cases as { id: string; name: string; condition: string }[]) ?? []).map((cs, i, all) => (
              <div key={cs.id} className="space-y-1 rounded border border-line p-1.5">
                <div className="flex gap-1">
                  <input value={cs.name} onChange={(e) => set("cases", all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${fieldClass} flex-1 text-xs`} />
                  <button type="button" onClick={() => set("cases", all.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
                    ✕
                  </button>
                </div>
                <input value={cs.condition} onChange={(e) => set("cases", all.map((x, j) => (j === i ? { ...x, condition: e.target.value } : x)))} placeholder="hitung >= params.ambang" className={`${inputClass} font-mono text-xs`} />
              </div>
            ))}
            <button type="button" onClick={() => set("cases", [...((c.cases as object[]) ?? []), { id: `c${Date.now().toString(36)}`, name: `Case ${((c.cases as object[]) ?? []).length + 1}`, condition: "" }])} className="text-ocean">
              + Case
            </button>
            <p className="text-muted">The first true case is taken, else Otherwise; every branch continues at After fork.</p>
          </>
        )}
        {node.type === "effect" && (
          <>
            <select value={String(c.mode ?? "nothing")} onChange={(e) => set("mode", e.target.value)} className={inputClass}>
              <option value="action">Apply an action</option>
              <option value="notification">Send a notification</option>
              <option value="nothing">Do nothing</option>
            </select>
            {c.mode === "action" && (
              <>
                <select value={String(c.action_type_id ?? "")} onChange={(e) => set("action_type_id", e.target.value)} className={inputClass}>
                  <option value="">Choose an action</option>
                  {cat.action_types.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {act?.parameters.map((p) => (
                  <label key={p.id} className={lab}>
                    {p.name} {p.required && "*"} <span className="text-muted">({p.type})</span>
                    <input value={fmt((c.parameters as Record<string, unknown>)?.[p.id] ?? "")} onChange={(e) => set("parameters", { ...((c.parameters as object) ?? {}), [p.id]: e.target.value })} placeholder={p.type === "object" ? "{{object.__pk}}" : "value, {{template}} or = expression"} className={inputClass} />
                  </label>
                ))}
              </>
            )}
            {c.mode === "notification" && (
              <>
                <label className={lab}>
                  To
                  <select multiple value={(c.to as string[]) ?? []} onChange={(e) => set("to", [...e.target.selectedOptions].map((o) => o.value))} className={`${inputClass} h-20`}>
                    {cat.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <input value={String(c.subject ?? "")} onChange={(e) => set("subject", e.target.value)} placeholder="Subject {{object.no_sep}}" className={inputClass} />
                <textarea value={String(c.body ?? "")} onChange={(e) => set("body", e.target.value)} rows={3} placeholder="Body" className={`${inputClass} text-xs`} />
              </>
            )}
          </>
        )}
        {node.type === "loop" && (
          <>
            <label className={lab}>
              List
              <input value={String(c.list ?? "")} onChange={(e) => set("list", e.target.value)} placeholder="= split(object.tags)" className={`${inputClass} font-mono`} />
            </label>
            <div className="flex gap-1">
              <label className={lab}>
                Element variable
                <input value={String(c.element ?? "item")} onChange={(e) => set("element", e.target.value)} className={inputClass} />
              </label>
              <label className={lab}>
                Index variable
                <input value={String(c.index ?? "index")} onChange={(e) => set("index", e.target.value)} className={inputClass} />
              </label>
            </div>
          </>
        )}
        {node.type === "call_subgraph" && (
          <>
            <select value={String(c.subgraph ?? "")} onChange={(e) => set("subgraph", e.target.value)} className={inputClass}>
              <option value="">Choose a subgraph</option>
              {doc.nodes.filter((n) => n.type === "subgraph").map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
            {((sub?.config.inputs as string[]) ?? []).map((i) => (
              <label key={i} className={lab}>
                {i}
                <input value={fmt((c.inputs as Record<string, unknown>)?.[i] ?? "")} onChange={(e) => set("inputs", { ...((c.inputs as object) ?? {}), [i]: e.target.value })} className={inputClass} />
              </label>
            ))}
          </>
        )}
      </fieldset>
      <p className="text-[10px] text-muted">Values: text with {"{{templates}}"} or “= expression” over object, params, earlier outputs and loop variables.</p>
      {step && (
        <div className="rounded border border-line p-2" data-node-value>
          <div className="font-medium text-soft">{streaming ? "Running in the shown preview" : "Value in the shown run"}</div>
          {!streaming && <pre className={`whitespace-pre-wrap font-mono text-[10px] ${step.error ? "text-bad" : ""}`}>{step.error ?? JSON.stringify(step.value, null, 1)}</pre>}
          {(!!step.tool_calls?.length || !!step.turns?.length || (streaming && node.type === "llm")) && (
            <div className="mt-1 space-y-1" data-tool-calls>
              <div className="font-medium text-soft">{step.tool_calls?.length ? "Model turns and tool calls" : "Model"}</div>
              <LlmTranscript step={{ ...step, error: streaming ? step.error : undefined }} streaming={streaming} />
            </div>
          )}
        </div>
      )}
      {!readOnly && node.type !== "after_fork" && node.type !== "after_loop" && (
        <button type="button" onClick={onDelete} className="text-bad">
          Delete node
        </button>
      )}
    </aside>
  );
}

function ObjectsPanel({ id, doc, cat, watch, onWatch, onPreview, defaultType }: { id: string; doc: WBDoc; cat: Catalog; watch: boolean; onWatch: (pks: string[]) => void; onPreview: (pk: string) => void; defaultType: string }) {
  const [type, setType] = useState(defaultType || cat.object_types[0]?.id || "");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof wb.objects>>["objects"]>([]);
  const [props, setProps] = useState<string[]>([]);
  useEffect(() => {
    if (!type) return;
    let stale = false;
    wb.objects(id, type, q).then((r) => !stale && setRows(r.objects), () => {});
    return () => {
      stale = true;
    };
  }, [id, type, q]);
  const t = cat.object_types.find((x) => x.id === type);
  const cols = props.length ? props : (t?.properties ?? []).slice(0, 5).map((p) => p.api_name);
  const shown = watch ? rows.filter((r) => doc.watchlist.includes(r.primary_key)) : rows;
  return (
    <div className="h-60 shrink-0 overflow-auto border-t border-line bg-panel p-2 text-xs" data-objects-panel={watch ? "watchlist" : "objects"}>
      <div className="mb-1 flex items-center gap-1">
        <select value={type} onChange={(e) => setType(e.target.value)} className={`${fieldClass} text-xs`}>
          {cat.object_types.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className={`${fieldClass} w-40 text-xs`} />
        <select multiple value={props} onChange={(e) => setProps([...e.target.selectedOptions].map((o) => o.value))} className={`${fieldClass} h-7 w-48 text-xs`} title="Properties to show">
          {t?.properties.map((p) => (
            <option key={p.api_name} value={p.api_name}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="text-muted">{watch ? `${doc.watchlist.length} watched` : `${rows.length} objects`}</span>
      </div>
      <table className="w-full">
        <thead className="text-left text-muted">
          <tr>
            <th className="font-normal">Object</th>
            {cols.map((c) => (
              <th key={c} className="font-normal">
                {c}
              </th>
            ))}
            <th className="font-normal">Last run</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.primary_key} className="border-t border-line">
              <td className="max-w-40 truncate py-0.5">{r.title}</td>
              {cols.map((c) => (
                <td key={c} className="max-w-32 truncate">
                  {fmt(r.properties[c])}
                </td>
              ))}
              <td className={r.last_run?.status === "failed" ? "text-bad" : "text-muted"}>{r.last_run ? `${r.last_run.status} ${when(r.last_run.at)}` : "—"}</td>
              <td className="whitespace-nowrap">
                <button type="button" onClick={() => onWatch(doc.watchlist.includes(r.primary_key) ? doc.watchlist.filter((x) => x !== r.primary_key) : [...doc.watchlist, r.primary_key])} className="text-ocean">
                  {doc.watchlist.includes(r.primary_key) ? "Unwatch" : "Watch"}
                </button>
                <button type="button" onClick={() => onPreview(r.primary_key)} className="ml-2 text-ocean">
                  Preview
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
