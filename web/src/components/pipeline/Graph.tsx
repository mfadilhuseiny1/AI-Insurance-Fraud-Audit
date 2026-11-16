"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { pseudocode } from "@/lib/describe";
import { bridgedInputs, snap } from "@/lib/graphLayout";
import { renderMarkdown } from "@/lib/markdown";
import {
  FALSE_PORT,
  inputsOf,
  isFalsePort,
  joinKeys,
  referencedNodes,
  refNode,
  type CustomFunction,
  type JoinHow,
  type SetMode,
  type InputMode,
  type LegendColor,
  type NodeResult,
  type OutputKind,
  type PipelineNode,
  type Subgraph,
  type TextNode,
  type UserPreferences,
} from "@/lib/pipeline";
import { Icon, type IconName } from "../Icon";

export const NODE_W = 220;
/** dataTransfer type of a dataset dragged from the Data panel (DataPanel.DATASET_MIME) */
const DATASET_DRAG = "application/x-bluesandai-dataset";
export const NODE_H = 64;
/** joins show a port per input (and splits a port per output) below the usual two rows */
const PORT_ROWS_H = 48;
const PORT_Y = NODE_H / 2;
const PSEUDO_LINE = 15;
const MAX_PSEUDO = 6;

/** Output nodes are drawn with ids prefixed so they never clash with pipeline node ids. */
export const OUT = "out:";
/** Text nodes, likewise. */
export const TXT = "txt:";
/** A collapsed colour group drawn as one node. */
export const GRP = "grp:";

export type OutputNodeView = {
  id: string;
  name: string;
  node: string;
  kind: OutputKind;
  x: number;
  y: number;
  status: "deployed" | "pending" | "error";
  detail: string;
};

export const NODE_ICON: Record<PipelineNode["kind"], IconName> = {
  source: "table",
  transform: "transform",
  join: "join",
  union: "union",
  split: "split",
  subgraph: "layers",
  input: "download",
  llm: "sparkle",
  model: "cpu",
};

export const OUTPUT_ICON: Record<OutputKind, IconName> = {
  dataset: "table",
  icebergTable: "layers",
  virtualTable: "database",
  mediaSet: "image",
  file: "doc",
  objectType: "graph",
  linkType: "link",
  timeSeries: "wave",
  geotemporal: "globe",
};

/** A join's kind as Pipeline Builder names its join transforms (Left join, Inner join, Anti join …). */
export const joinLabel = (how: JoinHow) =>
  ({ inner: "Inner join", left: "Left join", right: "Right join", outer: "Outer join", "left semi": "Semi join", "left anti": "Anti join", cross: "Cross join" })[how] ?? "Join";

/** A union's set operation as Pipeline Builder names it (Union by name, Intersect …). */
export const unionLabel = (mode: SetMode | undefined) =>
  ({ "union all": "Union by name", "union distinct": "Union distinct", intersect: "Intersect", "intersect all": "Intersect all", except: "Except", "except all": "Except all" })[mode ?? "union all"];

export function nodeHeight(n: PipelineNode, prefs?: UserPreferences): number {
  if (n.kind === "join" || n.kind === "split") return NODE_H + PORT_ROWS_H;
  if (prefs?.collapsedStyle === "pseudocode" && n.kind === "transform" && n.steps.length)
    return NODE_H + Math.min(n.steps.length, MAX_PSEUDO) * PSEUDO_LINE + 8;
  return NODE_H;
}

/** y (relative to the node) where an output reference leaves: a split's True / False rows. */
const outPortY = (n: PipelineNode, ref: string) => (n.kind === "split" ? NODE_H + 12 + (isFalsePort(ref) ? 24 : 0) : PORT_Y);
/** y (relative) where the i-th input enters: joins have one port per side. */
const inPortY = (n: PipelineNode, i: number) => (n.kind === "join" ? NODE_H + 12 + Math.min(i, 1) * 24 : PORT_Y);

type Drag =
  | { kind: "move"; ids: string[]; start: Map<string, { x: number; y: number }>; px: number; py: number; moved: boolean; clicked: string }
  | { kind: "select"; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: "pan"; sx: number; sy: number; left: number; top: number; moved: boolean }
  | { kind: "connect"; from: string; x0: number; y0: number; x1: number; y1: number; moved: boolean }
  | { kind: "resize"; id: string; w: number; h: number; px: number; py: number };

export type GraphBadge = { icon: IconName; title: string; tone?: "warn" | "ok" | "bad" | "info" };

export function Graph({
  nodes,
  outputs,
  textNodes = [],
  legend,
  result,
  selected,
  zoom,
  setZoom,
  hidden,
  prefs,
  mode = "pan",
  functions,
  subgraphs,
  badges,
  readOnly,
  diff,
  toolbar,
  onSelect,
  onSelectMany,
  onClear,
  onMoveStart,
  onMove,
  onOpen,
  onContextMenu,
  onPort,
  onConnect,
  onPortDrop,
  onDropDataset,
  onTextChange,
  onShowInputs,
  onSourceMode,
}: {
  nodes: PipelineNode[];
  outputs: OutputNodeView[];
  textNodes?: TextNode[];
  legend: LegendColor[];
  result: (id: string) => NodeResult;
  /** node ids, OUT + output id, TXT + text id */
  selected: string[];
  zoom: number;
  setZoom?: (z: number) => void;
  /** ids not drawn (nodes and OUT ids) */
  hidden?: Set<string>;
  prefs?: UserPreferences;
  /** pan: dragging the background scrolls; select: it draws a selection box (shift always selects) */
  mode?: "pan" | "select";
  functions?: CustomFunction[];
  subgraphs?: Subgraph[];
  badges?: Map<string, GraphBadge[]>;
  readOnly?: boolean;
  /** proposals / history: nodes added, removed or changed */
  diff?: Map<string, "added" | "removed" | "changed">;
  toolbar: ReactNode;
  onSelect: (id: string, additive: boolean) => void;
  onSelectMany?: (ids: string[], additive: boolean) => void;
  onClear: () => void;
  onMoveStart: () => void;
  onMove: (moves: { id: string; x: number; y: number }[]) => void;
  onOpen: (id: string) => void;
  onContextMenu: (id: string, clientX: number, clientY: number) => void;
  /** the output port of a node was clicked: add an output */
  onPort: (id: string) => void;
  /** an output port was dragged onto an input port: `to` is a node id or OUT + output id */
  onConnect?: (fromRef: string, to: string, port: number) => void;
  /** an output port was dragged onto empty canvas: offer the next step there (graph and screen coordinates) */
  onPortDrop?: (fromRef: string, x: number, y: number, clientX: number, clientY: number) => void;
  /** datasets dragged from the Data panel were dropped on the canvas at (x, y) */
  onDropDataset?: (payload: string, x: number, y: number) => void;
  onTextChange?: (id: string, patch: Partial<TextNode>, record: boolean) => void;
  /** the "show node inputs" arrow of a node with hidden inputs */
  onShowInputs?: (id: string) => void;
  /** the computation mode of an input: shown as a Snapshot | Incremental toggle under a selected input node */
  onSourceMode?: (id: string, mode: InputMode) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [editingText, setEditingText] = useState<{ id: string; original: string } | null>(null);
  const hide = useMemo(() => hidden ?? new Set<string>(), [hidden]);
  const colors = new Map(legend.map((c) => [c.id, c]));

  // collapsed colour groups: their nodes are drawn as one group node
  const groups = useMemo(() => {
    const out = new Map<string, { color: LegendColor; members: PipelineNode[]; x: number; y: number }>();
    for (const c of legend)
      if (c.collapsed && !c.hidden) {
        const members = nodes.filter((n) => n.color === c.id && !hide.has(n.id));
        if (members.length > 1)
          out.set(GRP + c.id, { color: c, members, x: Math.min(...members.map((m) => m.x)), y: Math.min(...members.map((m) => m.y)) });
      }
    return out;
  }, [legend, nodes, hide]);
  const groupOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const [gid, g] of groups) for (const n of g.members) m.set(n.id, gid);
    return m;
  }, [groups]);

  const visible = nodes.filter((n) => !hide.has(n.id) && !groupOf.has(n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const height = (n: PipelineNode) => nodeHeight(n, prefs);
  const width = Math.max(1600, ...[...visible, ...outputs, ...textNodes].map((n) => n.x + ("w" in n ? n.w : NODE_W) + 400));
  const graphH = Math.max(900, ...visible.map((n) => n.y + height(n) + 300), ...outputs.map((o) => o.y + NODE_H + 300), ...textNodes.map((t) => t.y + t.h + 300));
  const single = selected.length === 1 ? byId.get(selected[0]) : undefined;

  /** where an edge from `ref` starts: its node, or the group it is collapsed into */
  const from = (ref: string): { x: number; y: number } | null => {
    const id = refNode(ref);
    const g = groupOf.get(id);
    if (g) {
      const grp = groups.get(g)!;
      return { x: grp.x + NODE_W, y: grp.y + PORT_Y };
    }
    const n = byId.get(id);
    if (!n || hide.has(id)) return null;
    return { x: n.x + NODE_W, y: n.y + outPortY(n, ref) };
  };

  const toGraph = (clientX: number, clientY: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return { x: (clientX - r.left + scroller.current!.scrollLeft) / zoom, y: (clientY - r.top + scroller.current!.scrollTop) / zoom };
  };

  // ctrl / cmd + wheel zooms
  useEffect(() => {
    const el = scroller.current;
    if (!el || !setZoom) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(Math.min(1.6, Math.max(0.2, +(zoom * (e.deltaY > 0 ? 0.9 : 1.1)).toFixed(2))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, setZoom]);

  const begin = (d: Drag, e: React.PointerEvent) => {
    dragRef.current = d;
    setDrag(d);
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      let next: Drag = cur;
      if (cur.kind === "move") {
        const dx = (ev.clientX - cur.px) / zoom;
        const dy = (ev.clientY - cur.py) / zoom;
        if (!cur.moved && Math.abs(dx) + Math.abs(dy) < 4 / zoom) return;
        if (!cur.moved) onMoveStart();
        next = { ...cur, moved: true };
        onMove(
          cur.ids.map((id) => {
            const s = cur.start.get(id)!;
            const x = Math.max(0, Math.round(s.x + dx));
            const y = Math.max(0, Math.round(s.y + dy));
            return { id, x: prefs?.snapToGrid ? snap(x) : x, y: prefs?.snapToGrid ? snap(y) : y };
          }),
        );
      } else if (cur.kind === "select") {
        const p = toGraph(ev.clientX, ev.clientY);
        next = { ...cur, x1: p.x, y1: p.y };
      } else if (cur.kind === "pan") {
        const el = scroller.current!;
        el.scrollLeft = cur.left - (ev.clientX - cur.sx);
        el.scrollTop = cur.top - (ev.clientY - cur.sy);
        next = { ...cur, moved: cur.moved || Math.abs(ev.clientX - cur.sx) + Math.abs(ev.clientY - cur.sy) > 4 };
      } else if (cur.kind === "connect") {
        const p = toGraph(ev.clientX, ev.clientY);
        next = { ...cur, x1: p.x, y1: p.y, moved: cur.moved || Math.abs(p.x - cur.x0) + Math.abs(p.y - cur.y0) > 6 };
      } else if (cur.kind === "resize") {
        const dw = (ev.clientX - cur.px) / zoom;
        const dh = (ev.clientY - cur.py) / zoom;
        onTextChange?.(cur.id, { w: Math.max(140, Math.round(cur.w + dw)), h: Math.max(60, Math.round(cur.h + dh)) }, false);
      }
      dragRef.current = next;
      setDrag(next);
    };
    const up = (ev: PointerEvent) => {
      const cur = dragRef.current;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragRef.current = null;
      setDrag(null);
      if (!cur) return;
      if (cur.kind === "move" && !cur.moved) onSelect(cur.clicked, ev.shiftKey || ev.metaKey || ev.ctrlKey);
      if (cur.kind === "select") {
        const [x0, x1] = [Math.min(cur.x0, cur.x1), Math.max(cur.x0, cur.x1)];
        const [y0, y1] = [Math.min(cur.y0, cur.y1), Math.max(cur.y0, cur.y1)];
        if (x1 - x0 < 4 && y1 - y0 < 4) return onClear();
        const hit = (x: number, y: number, w: number, h: number) => x < x1 && x + w > x0 && y < y1 && y + h > y0;
        const ids = [
          ...visible.filter((n) => hit(n.x, n.y, NODE_W, height(n))).map((n) => n.id),
          ...[...groups.values()].filter((g) => hit(g.x, g.y, NODE_W, NODE_H)).flatMap((g) => g.members.map((m) => m.id)),
          ...outputs.filter((o) => !hide.has(OUT + o.id) && hit(o.x, o.y, NODE_W, NODE_H)).map((o) => OUT + o.id),
        ];
        onSelectMany?.(ids, cur.additive);
      }
      if (cur.kind === "pan" && !cur.moved) onClear();
      if (cur.kind === "connect") {
        if (!cur.moved) return onPort(refNode(cur.from));
        const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const target = hit?.closest("[data-in-node]") as HTMLElement | null;
        if (target) onConnect?.(cur.from, target.dataset.inNode!, Number(target.dataset.inPort ?? 0));
        else if (hit && scroller.current?.contains(hit)) {
          const p = toGraph(ev.clientX, ev.clientY);
          onPortDrop?.(cur.from, p.x, p.y, ev.clientX, ev.clientY);
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  const startMove = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || readOnly) {
      if (e.button === 0) {
        e.stopPropagation();
        onSelect(id, e.shiftKey || e.metaKey || e.ctrlKey);
      }
      return;
    }
    e.stopPropagation();
    // dragging a selected node moves the whole selection
    const group = groups.get(id);
    const ids = group ? group.members.map((m) => m.id) : selected.includes(id) ? selected : [id];
    const start = new Map<string, { x: number; y: number }>();
    for (const i of ids) {
      const n = byId.get(i);
      const o = outputs.find((x) => OUT + x.id === i);
      const t = textNodes.find((x) => TXT + x.id === i);
      const p = n ?? o ?? t;
      if (p) start.set(i, { x: p.x, y: p.y });
    }
    begin({ kind: "move", ids: [...start.keys()], start, px: e.clientX, py: e.clientY, moved: false, clicked: group ? group.members[0].id : id }, e);
  };

  const startBackground = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (mode === "select" || e.shiftKey) {
      const p = toGraph(e.clientX, e.clientY);
      begin({ kind: "select", x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey && mode === "pan" ? false : e.shiftKey || e.ctrlKey || e.metaKey }, e);
    } else {
      const el = scroller.current!;
      begin({ kind: "pan", sx: e.clientX, sy: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false }, e);
    }
  };

  const startConnect = (e: React.PointerEvent, ref: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (readOnly) return;
    const p = from(ref);
    if (!p) return;
    begin({ kind: "connect", from: ref, x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false }, e);
  };

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const c = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
  };

  const edges: ReactNode[] = [];
  const drawn = new Set<string>();
  const addEdge = (key: string, ref: string, toId: string, x2: number, y2: number, dotted = false) => {
    const p = from(ref);
    if (!p) return;
    const fromDisplay = groupOf.get(refNode(ref)) ?? ref;
    const dedupe = `${fromDisplay}>${toId}:${y2}`;
    if (drawn.has(dedupe) || fromDisplay === toId) return;
    drawn.add(dedupe);
    const hot = selected.includes(toId) || selected.includes(refNode(ref));
    edges.push(
      <path
        key={key}
        d={curve(p.x, p.y, x2, y2)}
        fill="none"
        stroke={hot ? "var(--color-ocean)" : "var(--color-line-2)"}
        strokeWidth={hot ? 2 : 1.5}
        strokeDasharray={dotted ? "5 5" : undefined}
      />,
    );
  };
  // nodes a step reads by table name: dotted edges, as they are not inputs. A Mapping join's lookup table always
  // (it is a second input); a SQL query's tables only while it or the table is selected (a graph of SQL steps would
  // otherwise be a web of lines)
  const references = referencedNodes(nodes);
  for (const n of nodes) {
    if (hide.has(n.id)) continue;
    const g = groupOf.get(n.id);
    const target = g ? groups.get(g)! : n;
    const toId = g ?? n.id;
    inputsOf(n).forEach((ref, i) => {
      if (!ref) return;
      if (hide.has(refNode(ref))) return;
      if (g && groupOf.get(refNode(ref)) === g) return; // inside the group
      addEdge(`${ref}-${n.id}-${i}`, ref, toId, target.x, target.y + (g ? PORT_Y : inPortY(n, i)));
    });
    if (!g) for (const ref of bridgedInputs(nodes, hide, n.id).refs) addEdge(`bridge-${ref}-${n.id}`, ref, n.id, n.x, n.y + inPortY(n, 0), true);
    for (const { id: ref, via } of references.get(n.id) ?? []) {
      if (hide.has(ref) || (g && groupOf.get(ref) === g)) continue;
      if (via === "sql" && !selected.includes(n.id) && !selected.includes(ref)) continue;
      addEdge(`uses-${ref}-${n.id}`, ref, toId, target.x, target.y + (g ? PORT_Y : inPortY(n, 0)), true);
    }
  }
  for (const o of outputs) {
    if (hide.has(OUT + o.id)) continue;
    addEdge(`${o.node}-${OUT}${o.id}`, o.node, OUT + o.id, o.x, o.y + PORT_Y);
  }

  const portDot = (cls = "") => `h-2.5 w-2.5 rounded-full border-2 border-line-2 bg-ink ${cls}`;
  const inPort = (target: string, port: number, top: number, partial?: number) => (
    <span
      key={`in-${port}`}
      data-in-node={target}
      data-in-port={port}
      title={partial ? `${partial} hidden input${partial > 1 ? "s" : ""}` : "Input — drag an output here to connect"}
      className="absolute left-0 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
      style={{ top }}
    >
      <span
        className={portDot()}
        style={partial ? { background: "linear-gradient(90deg, var(--color-line-2) 50%, var(--color-ink) 50%)" } : undefined}
      />
    </span>
  );
  const outPort = (ref: string, top: number, label?: string) => (
    <button
      key={ref}
      type="button"
      title={readOnly ? undefined : `${label ? `${label} output — ` : ""}Click to add an output · drag to an input to connect`}
      aria-label="Output port"
      onPointerDown={(e) => startConnect(e, ref)}
      className="group/port absolute right-0 flex h-4 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full"
      style={{ top }}
    >
      <span className="flex h-2.5 w-2.5 items-center justify-center rounded-full border-2 border-line-2 bg-ink transition-all group-hover/port:h-4 group-hover/port:w-4 group-hover/port:border-sand group-hover/port:bg-sand">
        <Icon name="plus" className="hidden h-3 w-3 text-ink group-hover/port:block" />
      </span>
    </button>
  );

  const diffRing = (id: string) => {
    const d = diff?.get(id);
    return d === "added" ? "ring-2 ring-ok/70" : d === "removed" ? "ring-2 ring-bad/70 opacity-60" : d === "changed" ? "ring-2 ring-warn/70" : "";
  };

  const sel = drag?.kind === "select" ? drag : null;

  return (
    <div
      ref={scroller}
      className={`dot-grid relative min-h-0 flex-1 overflow-auto ${mode === "select" ? "cursor-crosshair" : drag?.kind === "pan" ? "cursor-grabbing" : ""}`}
      onPointerDown={startBackground}
      onDragOver={(e) => {
        if (onDropDataset && !readOnly && e.dataTransfer.types.includes(DATASET_DRAG)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const payload = e.dataTransfer.getData(DATASET_DRAG);
        if (!payload || !onDropDataset || readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        const p = toGraph(e.clientX, e.clientY);
        onDropDataset(payload, p.x, p.y);
      }}
    >
      <div style={{ width: width * zoom, height: graphH * zoom }}>
        <div className="relative origin-top-left" style={{ width, height: graphH, transform: `scale(${zoom})` }}>
          {/* text nodes sit behind everything else */}
          {textNodes.map((t) => {
            const color = t.color ? colors.get(t.color)?.hex : undefined;
            const isSel = selected.includes(TXT + t.id);
            const editing = editingText?.id === t.id;
            return (
              <div
                key={TXT + t.id}
                data-text-node={t.id}
                onPointerDown={(e) => !editing && startMove(e, TXT + t.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (!readOnly) setEditingText({ id: t.id, original: t.text });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenu(TXT + t.id, e.clientX, e.clientY);
                }}
                className={`absolute z-0 flex flex-col overflow-hidden rounded-md border ${isSel ? "border-ocean ring-2 ring-ocean/40" : "border-line-2/70"} ${editing ? "" : "cursor-grab"}`}
                style={{ left: t.x, top: t.y, width: t.w, height: t.h, background: color ? `${color}33` : "color-mix(in srgb, var(--color-panel) 70%, transparent)" }}
              >
                {editing ? (
                  <>
                    <textarea
                      autoFocus
                      value={t.text}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => onTextChange?.(t.id, { text: e.target.value }, false)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
                          e.preventDefault();
                          setEditingText(null);
                        }
                      }}
                      onBlur={() => setEditingText(null)}
                      placeholder="Write Markdown…"
                      className="min-h-0 flex-1 resize-none bg-ink/80 p-2 font-mono text-xs text-white outline-none"
                    />
                    <div className="flex items-center justify-between border-t border-line bg-panel px-2 py-1 text-[11px] text-muted">
                      <span>Markdown · Mod+Enter or Esc to finish</span>
                      <button
                        type="button"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => {
                          onTextChange?.(t.id, { text: editingText.original }, false);
                          setEditingText(null);
                        }}
                        className="text-soft hover:text-bad"
                      >
                        Discard
                      </button>
                    </div>
                  </>
                ) : (
                  <div
                    className="md-body min-h-0 flex-1 overflow-auto p-2 text-xs text-soft"
                    onWheel={(e) => e.stopPropagation()}
                    dangerouslySetInnerHTML={{ __html: t.text.trim() ? renderMarkdown(t.text) : '<p class="italic text-muted">Double-click to write Markdown</p>' }}
                  />
                )}
                {!readOnly && (
                  <span
                    title="Resize"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onMoveStart();
                      begin({ kind: "resize", id: t.id, w: t.w, h: t.h, px: e.clientX, py: e.clientY }, e);
                    }}
                    className="absolute bottom-0 right-0 cursor-nwse-resize px-1 text-[10px] leading-none text-muted"
                  >
                    ≡
                  </span>
                )}
              </div>
            );
          })}

          <svg className="pointer-events-none absolute inset-0 z-[1]" width={width} height={graphH}>
            {edges}
            {drag?.kind === "connect" && drag.moved && (
              <path d={curve(drag.x0, drag.y0, drag.x1, drag.y1)} fill="none" stroke="var(--color-sand)" strokeWidth={2} strokeDasharray="4 4" />
            )}
          </svg>

          {[...groups].map(([gid, g]) => {
            const isSel = g.members.every((m) => selected.includes(m.id));
            return (
              <div
                key={gid}
                onPointerDown={(e) => startMove(e, gid)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenu(g.members[0].id, e.clientX, e.clientY);
                }}
                title={g.members.map((m) => m.name).join(", ")}
                className={`absolute z-10 cursor-grab select-none rounded-md border bg-panel shadow-lg ${isSel ? "border-ocean ring-2 ring-ocean/40" : "border-line-2"}`}
                style={{ left: g.x, top: g.y, width: NODE_W, height: NODE_H }}
              >
                <div className="flex h-8 items-center gap-2 rounded-t-md px-2.5 text-sm font-medium" style={{ background: g.color.hex, color: "#0d131d" }}>
                  <Icon name="layers" className="h-4 w-4 shrink-0" />
                  <span className="truncate">{g.color.name}</span>
                </div>
                <div className="flex h-8 items-center px-2.5 text-xs text-muted">{g.members.length} nodes collapsed</div>
                <span className={`absolute left-0 -translate-x-1/2 -translate-y-1/2 ${portDot()}`} style={{ top: PORT_Y }} />
                <span className={`absolute right-0 translate-x-1/2 -translate-y-1/2 ${portDot()}`} style={{ top: PORT_Y }} />
              </div>
            );
          })}

          {visible.map((n) => {
            const r = result(n.id);
            const isSelected = selected.includes(n.id);
            const color = n.color ? colors.get(n.color)?.hex : undefined;
            const h = height(n);
            const bridged = bridgedInputs(nodes, hide, n.id);
            const lines = prefs?.collapsedStyle === "pseudocode" && n.kind === "transform" ? pseudocode(n, nodes, functions, subgraphs) : [];
            const nodeBadges = badges?.get(n.id) ?? [];
            return (
              <div
                key={n.id}
                data-pipeline-node={n.name}
                onPointerDown={(e) => startMove(e, n.id)}
                onDoubleClick={() => onOpen(n.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenu(n.id, e.clientX, e.clientY);
                }}
                className={`absolute ${isSelected ? "z-20" : "z-10"} select-none rounded-md border bg-panel shadow-lg ${readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} ${
                  isSelected ? "border-ocean ring-2 ring-ocean/40" : "border-line-2 hover:border-ocean/50"
                } ${diffRing(n.id)}`}
                style={{ left: n.x, top: n.y, width: NODE_W, height: h }}
              >
                <div
                  className="flex h-8 items-center gap-2 overflow-hidden rounded-t-md px-2.5 text-sm font-medium"
                  style={color ? { background: color, color: "#0d131d" } : { background: "var(--color-panel-2)" }}
                >
                  <Icon name={NODE_ICON[n.kind]} className={`h-4 w-4 shrink-0 ${color ? "" : "text-ocean"}`} />
                  <span className="truncate">{n.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {n.checkpoint && <Icon name="star" className="h-3.5 w-3.5" aria-label="Checkpoint" />}
                    {nodeBadges.map((b, i) => (
                      <span key={i} title={b.title}>
                        <Icon
                          name={b.icon}
                          className={`h-3.5 w-3.5 ${b.tone === "bad" ? "text-bad" : b.tone === "warn" ? "text-warn" : b.tone === "ok" ? "text-ok" : color ? "" : "text-soft"}`}
                        />
                      </span>
                    ))}
                  </span>
                </div>
                <div className="flex h-8 items-center gap-1.5 px-2.5 text-xs">
                  {r.error !== undefined ? (
                    <span className="flex min-w-0 items-center gap-1 text-bad" title={r.error}>
                      <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{r.error}</span>
                    </span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1 truncate text-muted">
                      {r.pending ? <Icon name="refresh" className="h-3 w-3 shrink-0 animate-spin text-ocean" /> : null}
                      {(n.kind === "join" || n.kind === "union") && (
                        <span className="shrink-0 rounded bg-ocean/15 px-1 font-medium text-ocean" title={n.kind === "join" ? `${joinLabel(n.how)}: ${joinKeys(n).map((k) => `${k.left} ${k.op ?? "="} ${k.right}`).join(", ") || "no keys"}` : undefined}>
                          {n.kind === "join" ? joinLabel(n.how) : unionLabel(n.mode)}
                        </span>
                      )}
                      <span className="truncate">
                        {r.table.files
                          ? `No schema · ${r.table.files.length} file${r.table.files.length === 1 ? "" : "s"}`
                          : `${r.table.columns.length} columns · ${(r.table.totalRows ?? r.table.rows.length).toLocaleString()} rows${r.pending ? ` · ${r.pending} computing` : ""}`}
                      </span>
                    </span>
                  )}
                </div>
                {lines.length > 0 && (
                  <div className="border-t border-line px-2.5 py-1 font-mono text-[10.5px] leading-[15px] text-soft">
                    {lines.slice(0, MAX_PSEUDO).map((l, i) => (
                      <div key={i} className="truncate" title={l}>
                        {i === MAX_PSEUDO - 1 && lines.length > MAX_PSEUDO ? `… ${lines.length - MAX_PSEUDO + 1} more` : l}
                      </div>
                    ))}
                  </div>
                )}
                {n.kind === "join" && (
                  <div className="border-t border-line text-[11px] text-muted">
                    {["Left dataset", "Right dataset"].map((label) => (
                      <div key={label} className="flex h-6 items-center px-2.5">
                        {label}
                      </div>
                    ))}
                  </div>
                )}
                {n.kind === "split" && (
                  <div className="border-t border-line text-right text-[11px] text-muted">
                    {["True", "False"].map((label) => (
                      <div key={label} className="flex h-6 items-center justify-end px-2.5">
                        {label}
                      </div>
                    ))}
                  </div>
                )}
                {n.kind === "join"
                  ? [0, 1].map((i) => inPort(n.id, i, inPortY(n, i), i === 0 ? bridged.hiddenCount : 0))
                  : inputsOf(n).length > 0 || n.kind === "union" || n.kind === "subgraph"
                    ? inPort(n.id, 0, PORT_Y, bridged.hiddenCount)
                    : null}
                {bridged.hiddenCount > 0 && onShowInputs && (
                  <button
                    type="button"
                    title={`Show node inputs (${bridged.hiddenCount} hidden)`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onShowInputs(n.id)}
                    className="absolute -left-9 flex h-5 items-center gap-0.5 rounded bg-panel-2 px-1 text-[10px] text-soft ring-1 ring-line-2 hover:text-white"
                    style={{ top: PORT_Y - 10 }}
                  >
                    <Icon name="left" className="h-3 w-3" />
                    {bridged.hiddenCount}
                  </button>
                )}
                {n.kind === "split"
                  ? [outPort(n.id, outPortY(n, n.id), "True"), outPort(n.id + FALSE_PORT, outPortY(n, n.id + FALSE_PORT), "False")]
                  : outPort(n.id, PORT_Y)}
                {n.kind === "source" && isSelected && selected.length === 1 && onSourceMode && !readOnly && (
                  <div
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="absolute left-0 flex cursor-default items-center gap-0.5 rounded-md border border-line-2 bg-panel p-0.5 text-xs shadow-lg"
                    style={{ top: h + 6 }}
                    role="radiogroup"
                    aria-label="Computation mode"
                  >
                    {(
                      [
                        ["snapshot", "Snapshot", "Each build reads every row of the input"],
                        ["incremental", "Incremental", "Each build reads only the rows added since the last build (APPEND transactions)"],
                      ] as const
                    ).map(([mode, label, hint]) => {
                      const on = (n.mode ?? "snapshot") === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          title={hint}
                          onClick={() => !on && onSourceMode(n.id, mode)}
                          className={`rounded px-2.5 py-1 font-medium ${on ? "bg-ocean text-white" : "text-muted hover:bg-panel-2 hover:text-white"}`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {outputs
            .filter((o) => !hide.has(OUT + o.id))
            .map((o) => {
              const isSelected = selected.includes(OUT + o.id);
              return (
                <div
                  key={OUT + o.id}
                  onPointerDown={(e) => startMove(e, OUT + o.id)}
                  onDoubleClick={() => onOpen(OUT + o.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onContextMenu(OUT + o.id, e.clientX, e.clientY);
                  }}
                  className={`absolute z-10 cursor-grab select-none rounded-md border bg-panel shadow-lg active:cursor-grabbing ${
                    isSelected ? "border-ocean ring-2 ring-ocean/40" : "border-line-2 hover:border-ocean/50"
                  } ${diffRing(OUT + o.id)}`}
                  style={{ left: o.x, top: o.y, width: NODE_W, height: NODE_H }}
                >
                  <div className="flex h-8 items-center gap-2 overflow-hidden rounded-t-md bg-ocean px-2.5 text-sm font-medium text-white">
                    <Icon name={OUTPUT_ICON[o.kind]} className="h-4 w-4 shrink-0" />
                    <span className="truncate">{o.name || "Unnamed output"}</span>
                    {(badges?.get(OUT + o.id) ?? []).map((b, i) => (
                      <span key={i} title={b.title} className="ml-auto">
                        <Icon name={b.icon} className="h-3.5 w-3.5" />
                      </span>
                    ))}
                  </div>
                  <div
                    className={`flex h-8 items-center gap-1.5 px-2.5 text-xs ${o.status === "error" ? "text-bad" : o.status === "deployed" ? "text-ok" : "text-muted"}`}
                    title={o.detail}
                  >
                    {o.status === "error" ? (
                      <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <span className={`h-2 w-2 shrink-0 rounded-full ${o.status === "deployed" ? "bg-ok" : "border border-muted"}`} />
                    )}
                    <span className="truncate">{o.detail}</span>
                  </div>
                  {inPort(OUT + o.id, 0, PORT_Y)}
                </div>
              );
            })}

          {sel && (
            <div
              className="pointer-events-none absolute z-20 border border-ocean bg-ocean/10"
              style={{ left: Math.min(sel.x0, sel.x1), top: Math.min(sel.y0, sel.y1), width: Math.abs(sel.x1 - sel.x0), height: Math.abs(sel.y1 - sel.y0) }}
            />
          )}

          {single && !hide.has(single.id) && !groupOf.has(single.id) && !readOnly && (
            <div className="absolute z-30" style={{ left: single.x + NODE_W + 12, top: single.y - 4 }} onPointerDown={(e) => e.stopPropagation()}>
              {toolbar}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The zoom that fits these boxes into the visible area of the graph. */
export function fitZoom(boxes: { x: number; y: number; w: number; h: number }[], viewW: number, viewH: number): { zoom: number; left: number; top: number } {
  if (!boxes.length) return { zoom: 1, left: 0, top: 0 };
  const x0 = Math.min(...boxes.map((b) => b.x)) - 40;
  const y0 = Math.min(...boxes.map((b) => b.y)) - 40;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 60;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 60;
  const zoom = Math.max(0.2, Math.min(1.4, Math.min(viewW / (x1 - x0), viewH / (y1 - y0))));
  return { zoom: +zoom.toFixed(2), left: x0 * zoom, top: y0 * zoom };
}
