"use client";

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { iconPath, type IconName } from "@/components/Icon";
import type { GroupedEdge, Layer, Layout, VEdge, VEvent, VNode } from "@/lib/vertex";

export type Pos = Record<string, { x: number; y: number }>;
export const PALETTE = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#60a5fa", "#fb7185", "#4ade80"];

/** A node's color: the first matching layer rule, else the layer's color, else the type's palette color. */
export function nodeColor(node: VNode, layer: Layer | undefined, fallback: string): string {
  for (const r of layer?.rules ?? []) {
    const v = node.properties[r.property];
    const num = Number(v);
    const hit = r.op === "eq" ? String(v ?? "") === r.value : r.op === "neq" ? String(v ?? "") !== r.value : r.op === "gt" ? num > Number(r.value) : num < Number(r.value);
    if (hit) return r.color;
  }
  return layer?.color ?? fallback;
}
const INTENT: Record<string, string> = { primary: "#60a5fa", success: "#34d399", warning: "#f59e0b", danger: "#ef4444" };
const BOX = 40;

/**
 * System flow layout: object types as columns (a layer's `column`, else derived from the type graph so linked types
 * sit side by side), nodes in a column ordered by the average position of their neighbors to reduce crossings.
 */
export function flowLayout(nodes: VNode[], edges: { source: string; target: string }[], layers: Record<string, Layer>): Pos {
  const pos: Pos = {};
  if (!nodes.length) return pos;
  const typeOf = new Map(nodes.map((n) => [n.id, n.object_type_id]));
  const types = [...new Set(nodes.map((n) => n.object_type_id))];
  // the type graph: which types are linked
  const adj = new Map<string, Set<string>>(types.map((t) => [t, new Set<string>()]));
  for (const e of edges) {
    const a = typeOf.get(e.source);
    const b = typeOf.get(e.target);
    if (a && b && a !== b) {
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }
  }
  const col = new Map<string, number>();
  for (const t of types) if (layers[t]?.column !== undefined) col.set(t, Number(layers[t].column));
  // unplaced types: BFS from placed (or leaf) types, one column further each step
  const pending = types.filter((t) => !col.has(t));
  while (pending.length) {
    const start = pending.find((t) => [...adj.get(t)!].some((x) => col.has(x))) ?? pending.sort((a, b) => adj.get(a)!.size - adj.get(b)!.size)[0];
    const placedNb = [...adj.get(start)!].filter((x) => col.has(x)).map((x) => col.get(x)!);
    col.set(start, placedNb.length ? Math.max(...placedNb) + 1 : Math.max(-1, ...col.values()) + 1);
    pending.splice(pending.indexOf(start), 1);
  }
  const columns = new Map<number, VNode[]>();
  for (const n of nodes) {
    const c = col.get(n.object_type_id) ?? 0;
    columns.set(c, [...(columns.get(c) ?? []), n]);
  }
  const order = [...columns.keys()].sort((a, b) => a - b);
  const nb = new Map<string, string[]>();
  for (const e of edges) {
    nb.set(e.source, [...(nb.get(e.source) ?? []), e.target]);
    nb.set(e.target, [...(nb.get(e.target) ?? []), e.source]);
  }
  const rank = new Map<string, number>();
  for (const c of order) columns.get(c)!.forEach((n, i) => rank.set(n.id, i));
  // a few sweeps: each column sorted by the mean rank of its neighbors in the other columns
  for (let sweep = 0; sweep < 4; sweep++) {
    const seq = sweep % 2 ? [...order].reverse() : order;
    for (const c of seq) {
      const list = columns.get(c)!;
      const score = (n: VNode) => {
        const r = (nb.get(n.id) ?? []).filter((x) => (col.get(typeOf.get(x) ?? "") ?? -1) !== c).map((x) => rank.get(x) ?? 0);
        return r.length ? r.reduce((a, b) => a + b, 0) / r.length : rank.get(n.id) ?? 0;
      };
      list.sort((a, b) => score(a) - score(b));
      list.forEach((n, i) => rank.set(n.id, i));
    }
  }
  // tall columns (more than 12 nodes) are drawn as two staggered sub-columns so the graph stays readable when fitted
  const rowsOf = (len: number) => (len > 12 ? Math.ceil(len / 2) : len);
  const tallest = Math.max(...order.map((c) => rowsOf(columns.get(c)!.length)));
  order.forEach((c, ci) => {
    const list = columns.get(c)!;
    const split = list.length > 12;
    const rows = rowsOf(list.length);
    const gap = Math.max(84, Math.min(150, (tallest * 84) / rows));
    list.forEach((n, i) => {
      const r = split ? i / 2 : i;
      pos[n.id] = { x: ci * 380 + (split ? (i % 2 ? 100 : -100) : 0), y: (r - (list.length - 1) / (split ? 4 : 2)) * gap };
    });
  });
  return pos;
}

export const LAYOUTS: [Layout, string][] = [
  ["auto", "Auto"],
  ["flow", "System flow (left to right)"],
  ["hierarchy_lr", "Hierarchy (left to right)"],
  ["hierarchy_tb", "Hierarchy (top to bottom)"],
  ["grid", "Grid"],
  ["circular", "Circular"],
  ["radial", "Radial"],
  ["row", "Horizontal row"],
  ["column", "Vertical column"],
];

/** Positions for a layout (Vertex's predefined layouts). */
export function layoutOf(nodes: VNode[], edges: VEdge[], layout: Layout, center?: string | null): Pos {
  const pos: Pos = {};
  const n = nodes.length;
  if (!n) return pos;
  if (layout === "auto") {
    const sim = nodes.map((x) => ({ id: x.id, x: 0, y: 0 })) as { id: string; x: number; y: number }[];
    const links = edges.map((e) => ({ source: e.source, target: e.target }));
    const s = forceSimulation(sim)
      .force("link", forceLink(links).id((d) => (d as { id: string }).id).distance(110))
      .force("charge", forceManyBody().strength(-320))
      .force("collide", forceCollide(38))
      .force("center", forceCenter(0, 0))
      .stop();
    for (let i = 0; i < 300; i++) s.tick();
    for (const p of sim) pos[p.id] = { x: p.x, y: p.y };
    return pos;
  }
  if (layout === "hierarchy_lr" || layout === "hierarchy_tb") {
    const incoming = new Map<string, number>();
    const out = new Map<string, string[]>();
    for (const e of edges) {
      incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
      out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    }
    // links point from many to one (a claim → its facility), so the "one" side is the root: walk edges backwards
    const back = new Map<string, string[]>();
    for (const e of edges) back.set(e.target, [...(back.get(e.target) ?? []), e.source]);
    const roots = nodes.filter((x) => !out.has(x.id)).map((x) => x.id);
    const level = new Map<string, number>();
    const queue = roots.length ? [...roots] : [nodes[0].id];
    for (const r of queue) level.set(r, 0);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of back.get(cur) ?? []) {
        if (!level.has(nb)) {
          level.set(nb, level.get(cur)! + 1);
          queue.push(nb);
        }
      }
    }
    const rows = new Map<number, string[]>();
    for (const x of nodes) {
      const l = level.get(x.id) ?? 0;
      rows.set(l, [...(rows.get(l) ?? []), x.id]);
    }
    // order each level by the mean position of its neighbours in the previous level (fewer crossings), then wrap
    // levels of more than 12 nodes into side-by-side sub-columns so a fitted graph keeps readable labels
    const nbs = new Map<string, string[]>();
    for (const e of edges) {
      nbs.set(e.source, [...(nbs.get(e.source) ?? []), e.target]);
      nbs.set(e.target, [...(nbs.get(e.target) ?? []), e.source]);
    }
    const rank = new Map<string, number>();
    const levels = [...rows.keys()].sort((a, b) => a - b);
    for (const l of levels) rows.get(l)!.forEach((id, i) => rank.set(id, i));
    for (let sweep = 0; sweep < 4; sweep++) {
      for (const l of sweep % 2 ? [...levels].reverse() : levels) {
        const ids = rows.get(l)!;
        const score = (id: string) => {
          const r = (nbs.get(id) ?? []).filter((x) => (level.get(x) ?? 0) !== l).map((x) => rank.get(x) ?? 0);
          return r.length ? r.reduce((a, b) => a + b, 0) / r.length : (rank.get(id) ?? 0);
        };
        ids.sort((a, b) => score(a) - score(b));
        ids.forEach((id, i) => rank.set(id, i));
      }
    }
    const MAX = 12;
    let offset = 0;
    for (const l of levels) {
      const ids = rows.get(l)!;
      const subs = Math.ceil(ids.length / MAX);
      const per = Math.ceil(ids.length / subs);
      ids.forEach((id, i) => {
        const sub = Math.floor(i / per);
        const r = i % per;
        const a = offset + sub * 230;
        const b = (r - (per - 1) / 2) * 92;
        pos[id] = layout === "hierarchy_lr" ? { x: a, y: b } : { x: b * 2.2, y: a * 0.7 };
      });
      offset += subs * 230 + 160;
    }
    return pos;
  }
  if (layout === "grid") {
    const cols = Math.ceil(Math.sqrt(n));
    nodes.forEach((x, i) => (pos[x.id] = { x: (i % cols) * 170, y: Math.floor(i / cols) * 110 }));
    return pos;
  }
  if (layout === "row" || layout === "column") {
    nodes.forEach((x, i) => (pos[x.id] = layout === "row" ? { x: i * 150, y: 0 } : { x: 0, y: i * 70 }));
    return pos;
  }
  if (layout === "radial" && center && nodes.some((x) => x.id === center)) {
    pos[center] = { x: 0, y: 0 };
    const rest = nodes.filter((x) => x.id !== center);
    const nb = new Set(edges.flatMap((e) => (e.source === center ? [e.target] : e.target === center ? [e.source] : [])));
    const inner = rest.filter((x) => nb.has(x.id));
    const outer = rest.filter((x) => !nb.has(x.id));
    inner.forEach((x, i) => (pos[x.id] = { x: Math.cos((2 * Math.PI * i) / inner.length) * 220, y: Math.sin((2 * Math.PI * i) / inner.length) * 220 }));
    outer.forEach((x, i) => (pos[x.id] = { x: Math.cos((2 * Math.PI * i) / outer.length) * 420, y: Math.sin((2 * Math.PI * i) / outer.length) * 420 }));
    return pos;
  }
  const r = Math.max(160, n * 22);
  nodes.forEach((x, i) => (pos[x.id] = { x: Math.cos((2 * Math.PI * i) / n) * r, y: Math.sin((2 * Math.PI * i) / n) * r }));
  return pos;
}

function fmtValue(v: number, format?: string): string {
  if (format === "juta") return `${(v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} jt`;
  if (format === "rupiah") return `Rp${Math.round(v).toLocaleString()}`;
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** The edge's path: straight, a horizontal S-curve (flows read left to right) or orthogonal. */
function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, line: string, bend = 0): string {
  if (line === "straight") return `M${a.x},${a.y} L${b.x},${b.y}`;
  if (line === "orthogonal") {
    const mx = (a.x + b.x) / 2 + bend;
    return `M${a.x},${a.y} L${mx},${a.y} L${mx},${b.y} L${b.x},${b.y}`;
  }
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5);
  if (Math.abs(b.x - a.x) < 40) {
    // same column (e.g. referrals between facilities): bow out to the side
    const off = 90 + Math.abs(b.y - a.y) * 0.25;
    return `M${a.x},${a.y} C${a.x + off},${a.y} ${b.x + off},${b.y} ${b.x},${b.y}`;
  }
  const s = b.x >= a.x ? 1 : -1;
  return `M${a.x},${a.y + bend} C${a.x + s * dx},${a.y + bend} ${b.x - s * dx},${b.y + bend} ${b.x},${b.y}`;
}

export type FlowCanvasProps = {
  nodes: VNode[];
  edges: VEdge[];
  grouped: GroupedEdge[];
  groupFormat: (g: GroupedEdge) => string | undefined;
  pos: Pos;
  setPos: (p: Pos) => void;
  onDragEnd?: () => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  selectedEdge: string | null;
  setSelectedEdge: (id: string | null) => void;
  color: (n: VNode) => string;
  icon: (n: VNode) => IconName | null;
  label: (n: VNode) => string;
  size: (n: VNode) => number;
  changed: Set<string>;
  events: Map<string, VEvent[]>;
  edgeStyle: (e: VEdge) => { color?: string; dashed?: boolean; arrows?: "default" | "reverse" | "none" | "both" } | undefined;
  line: "straight" | "curved" | "orthogonal";
  /** drawn under the graph in world coordinates (a media layer), and the area it covers for fitting the view */
  underlay?: React.ReactNode;
  underlayBounds?: { x: number; y: number; w: number; h: number } | null;
  /** changes when the nodes are laid out afresh, so the view fits the new positions */
  fitToken?: string | number;
  /** zoom to these nodes (once they have positions) whenever the token changes: a paired window's selection or command */
  focus?: { ids: string[]; token: number } | null;
  /** link names on direct edges: on every edge of a small graph, else on the edges of the selection */
  edgeLabels?: boolean;
};

/** The Vertex canvas: icon nodes with label tags, curved flow edges with arrows, grouped edges labelled and sized by value. */
/** Above this many grouped edges, their labels show only when highlighted. */
const GROUP_LABELS_MAX = 30;
/** Above this many direct edges, link names (edgeLabels) show only on the selection's edges. */
const EDGE_LABELS_MAX = 40;

export function FlowCanvas(p: FlowCanvasProps) {
  const { nodes, edges, grouped, pos, selected } = p;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id?: string; edge?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const ub = p.underlayBounds;
  const fitKey = `${nodes.map((n) => n.id).join(",")}#${Object.keys(pos).length}#${p.fitToken ?? ""}#${ub ? `${ub.x},${ub.y},${ub.w},${ub.h}` : ""}`;
  const fitted = useMemo(() => {
    const ps = [...nodes.map((n) => pos[n.id]).filter(Boolean), ...(ub ? [{ x: ub.x, y: ub.y }, { x: ub.x + ub.w, y: ub.y + ub.h }] : [])];
    if (!ps.length) return { x: -400, y: -300, w: 800, h: 600 };
    const xs = ps.map((q) => q.x);
    const ys = ps.map((q) => q.y);
    const pad = 110;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(500, Math.max(...xs) - Math.min(...xs) + pad * 2), h: Math.max(320, Math.max(...ys) - Math.min(...ys) + pad * 2) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  const [manual, setManual] = useState<{ key: string; v: typeof fitted } | null>(null);
  const view = manual && manual.key === fitKey ? manual.v : fitted;
  const setView = (v: typeof fitted) => setManual({ key: fitKey, v });
  // focus: zoom to the asked nodes once they have positions (they may have just been added)
  const focused = useRef<number | null>(null);
  useEffect(() => {
    const focusPts = (p.focus?.ids ?? []).map((id) => pos[id]).filter(Boolean);
    if (!p.focus || focused.current === p.focus.token || !focusPts.length) return;
    focused.current = p.focus.token;
    const xs = focusPts.map((q) => q.x);
    const ys = focusPts.map((q) => q.y);
    const w = Math.max(500, Math.max(...xs) - Math.min(...xs) + 220);
    const h = Math.max(320, Math.max(...ys) - Math.min(...ys) + 220);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setManual({ key: fitKey, v: { x: cx - w / 2, y: cy - h / 2, w, h } });
    // the token and the layout (fitKey: node ids and positions) decide when to zoom
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus?.token, fitKey]);
  const toWorld = (cx: number, cy: number) => {
    const r = svg.current!.getBoundingClientRect();
    const s = Math.max(view.w / r.width, view.h / r.height);
    return { x: view.x + (cx - r.left) * s, y: view.y + (cy - r.top) * s, s };
  };
  const maxW = Math.max(1, ...grouped.map((g) => Math.abs(g.width_value)));
  // many grouped edges: their labels only when highlighted (selected node or edge), or they pile up on each other
  const groupLabels = grouped.length <= GROUP_LABELS_MAX;
  const focus = selected.size > 0 || !!p.selectedEdge;
  const near = (a: string, b: string) => selected.has(a) || selected.has(b);
  const anchor = (id: string, toward: { x: number; y: number }) => {
    const q = pos[id];
    const half = (p.size(nodes.find((n) => n.id === id)!) / 14) * (BOX / 2);
    if (!q) return q;
    if (Math.abs(toward.x - q.x) < 40) return { x: q.x + half, y: q.y };
    return { x: q.x + (toward.x > q.x ? half : -half), y: q.y };
  };
  return (
    <div className="relative min-h-0 flex-1">
      <svg
        ref={svg}
        className="h-full w-full cursor-grab select-none"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onWheel={(e) => {
          const q = toWorld(e.clientX, e.clientY);
          const f = e.deltaY > 0 ? 1.12 : 0.89;
          setView({ x: q.x - (q.x - view.x) * f, y: q.y - (q.y - view.y) * f, w: view.w * f, h: view.h * f });
        }}
        onPointerDown={(e) => {
          const el = e.target as Element;
          const id = el.closest("[data-node]")?.getAttribute("data-node") ?? undefined;
          const edge = el.closest("[data-edge]")?.getAttribute("data-edge") ?? undefined;
          drag.current = { id, edge, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
          el.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
          if (!d.moved) return;
          if (d.id) {
            const q = toWorld(e.clientX, e.clientY);
            p.setPos({ ...pos, [d.id]: { x: q.x, y: q.y } });
          } else {
            const s = toWorld(0, 0).s;
            setView({ ...view, x: d.vx - (e.clientX - d.sx) * s, y: d.vy - (e.clientY - d.sy) * s });
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.moved) {
            if (d.id) p.onDragEnd?.();
            return;
          }
          if (d.edge) {
            p.setSelected(new Set());
            return p.setSelectedEdge(d.edge);
          }
          p.setSelectedEdge(null);
          if (!d.id) return p.setSelected(new Set());
          const next = new Set(e.shiftKey ? selected : []);
          if (e.shiftKey && next.has(d.id)) next.delete(d.id);
          else next.add(d.id);
          p.setSelected(next);
        }}
      >
        <defs>
          {["dim", "hl"].map((k) => (
            <marker key={k} id={`vx-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={k === "hl" ? "fill-sky-300" : "fill-slate-500"} />
            </marker>
          ))}
          {/* grouped edges are up to ~10px wide: their arrows are sized in world units, not by stroke width */}
          {["dim", "hl"].map((k) => (
            <marker key={`g-${k}`} id={`vx-garrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={k === "hl" ? "fill-sky-300" : "fill-slate-500"} />
            </marker>
          ))}
        </defs>
        {p.underlay}
        {/* direct links */}
        {edges.map((e) => {
          const a0 = pos[e.source];
          const b0 = pos[e.target];
          if (!a0 || !b0) return null;
          const a = anchor(e.source, b0)!;
          const b = anchor(e.target, a0)!;
          const st = p.edgeStyle(e);
          const hl = near(e.source, e.target);
          const marker = `url(#vx-arrow-${hl ? "hl" : "dim"})`;
          const arrow = arrowOf(e.arrow ?? "target", st?.arrows);
          return (
            <path key={e.id} d={edgePath(a, b, p.line)} fill="none" stroke={st?.color ?? (hl ? "#7dd3fc" : "#64748b")} strokeOpacity={focus && !hl ? 0.18 : hl ? 0.95 : 0.55}
              strokeWidth={hl ? 2 : 1.3} strokeDasharray={st?.dashed ? "5 4" : undefined} vectorEffect="non-scaling-stroke"
              markerEnd={arrow === "target" || arrow === "both" ? marker : undefined} markerStart={arrow === "source" || arrow === "both" ? marker : undefined}>
              <title>{e.label}</title>
            </path>
          );
        })}
        {/* transactional objects grouped into edges: width and label from their value */}
        {grouped.map((g) => {
          const a0 = pos[g.source];
          const b0 = pos[g.target];
          if (!a0 || !b0) return null;
          const a = anchor(g.source, b0)!;
          const b = anchor(g.target, a0)!;
          const hl = near(g.source, g.target) || p.selectedEdge === g.id;
          const w = 1.4 + 9 * Math.sqrt(Math.abs(g.width_value) / maxW);
          const d = edgePath(a, b, p.line);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const text = `${g.count > 1 ? `${g.count} ${g.name}` : g.name} · ${fmtValue(g.value, p.groupFormat(g))}`;
          return (
            <g key={g.id} data-edge={g.id} className="cursor-pointer">
              <path d={d} fill="none" stroke="transparent" strokeWidth={14} vectorEffect="non-scaling-stroke" />
              <path d={d} fill="none" stroke={hl ? "#7dd3fc" : "#94a3b8"} strokeOpacity={focus && !hl ? 0.15 : hl ? 0.9 : 0.5} strokeWidth={w} strokeLinecap="round"
                vectorEffect="non-scaling-stroke" markerEnd={`url(#vx-garrow-${hl ? "hl" : "dim"})`} />
              {(hl || (!focus && groupLabels)) && (
                <g transform={`translate(${mx},${my})`}>
                  <rect x={-text.length * 2.9 - 6} y={-9} width={text.length * 5.8 + 12} height={18} rx={4} className={hl ? "fill-sky-950 stroke-sky-400" : "fill-panel stroke-line"} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <text textAnchor="middle" y={4} fontSize={10} className={hl ? "fill-sky-200" : "fill-soft"}>{text}</text>
                </g>
              )}
              <title>{`${g.name}: ${g.count} object(s) · ${fmtValue(g.value, p.groupFormat(g))}`}</title>
            </g>
          );
        })}
        {p.edgeLabels &&
          edges.map((e) => {
            const a = pos[e.source];
            const b = pos[e.target];
            const hl = near(e.source, e.target);
            if (!a || !b || !e.label || (focus ? !hl : edges.length > EDGE_LABELS_MAX)) return null;
            const text = e.label.length > 28 ? `${e.label.slice(0, 26)}…` : e.label;
            return (
              <g key={`l-${e.id}`} transform={`translate(${(a.x + b.x) / 2},${(a.y + b.y) / 2})`} className="pointer-events-none">
                <rect x={-text.length * 2.6 - 5} y={-8} width={text.length * 5.2 + 10} height={15} rx={7.5} className={hl ? "fill-sky-950 stroke-sky-500" : "fill-panel-2 stroke-line"} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <text textAnchor="middle" y={3.5} fontSize={9} className={hl ? "fill-sky-200" : "fill-muted"}>{text}</text>
              </g>
            );
          })}
        {nodes.map((n) => {
          const q = pos[n.id];
          if (!q) return null;
          const c = p.color(n);
          const ic = p.icon(n);
          const scale = p.size(n) / 14;
          const half = (BOX / 2) * scale;
          const evs = p.events.get(n.id) ?? [];
          const worst = evs.find((x) => x.intent === "danger") ?? evs.find((x) => x.intent === "warning") ?? evs[0];
          const isSel = selected.has(n.id);
          const dim = focus && !isSel && ![...edges, ...grouped].some((e) => (e.source === n.id && selected.has(e.target)) || (e.target === n.id && selected.has(e.source)));
          const text = p.label(n);
          const shown = text.length > 26 ? `${text.slice(0, 24)}…` : text;
          return (
            <g key={n.id} data-node={n.id} transform={`translate(${q.x},${q.y})`} className="cursor-pointer" opacity={dim ? 0.45 : 1}>
              {isSel && <rect x={-half - 9} y={-half - 9} width={2 * half + 18} height={2 * half + 40} rx={10} fill="#38bdf8" opacity={0.18} />}
              {p.changed.has(n.id) && <rect x={-half - 5} y={-half - 5} width={2 * half + 10} height={2 * half + 10} rx={9} fill="none" stroke="#fbbf24" strokeWidth={2} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
              {ic ? (
                <>
                  <rect x={-half} y={-half} width={2 * half} height={2 * half} rx={8 * scale} fill={c} stroke="#0b1220" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <g transform={`translate(${-12 * scale * 0.95},${-12 * scale * 0.95}) scale(${scale * 0.95})`}>
                    <path d={iconPath(ic)} fill="none" stroke="#0b1220" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                </>
              ) : (
                <circle r={half * 0.7} fill={c} stroke="#0b1220" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              )}
              {worst && <circle cx={half} cy={-half} r={6} fill={INTENT[worst.intent]} stroke="#0b1220" strokeWidth={1} />}
              <g transform={`translate(0,${half + 14})`}>
                <rect x={-shown.length * 3.1 - 7} y={-9} width={shown.length * 6.2 + 14} height={17} rx={4} className={isSel ? "fill-sky-900 stroke-sky-400" : "fill-panel stroke-line"} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <text textAnchor="middle" y={4} fontSize={10.5} fontWeight={600} className="fill-white">{shown}</text>
              </g>
              <title>{`${n.object_type}: ${n.title}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="absolute bottom-3 left-3 flex flex-col gap-1">
        <button type="button" onClick={() => setManual(null)} title="Zoom to fit" className="grid h-8 w-8 place-items-center rounded border border-line bg-panel text-soft hover:text-white">⤢</button>
        <button type="button" onClick={() => setView({ x: view.x + view.w * 0.1, y: view.y + view.h * 0.1, w: view.w * 0.8, h: view.h * 0.8 })} title="Zoom in" className="grid h-8 w-8 place-items-center rounded border border-line bg-panel text-soft hover:text-white">+</button>
        <button type="button" onClick={() => setView({ x: view.x - view.w * 0.125, y: view.y - view.h * 0.125, w: view.w * 1.25, h: view.h * 1.25 })} title="Zoom out" className="grid h-8 w-8 place-items-center rounded border border-line bg-panel text-soft hover:text-white">−</button>
      </div>
    </div>
  );
}

/** The arrows an edge shows: the Ontology's direction, changed by the graph's edge style. */
export function arrowOf(ontology: "source" | "target" | "none" | "both", style?: "default" | "reverse" | "none" | "both"): "source" | "target" | "none" | "both" {
  if (style === "none" || style === "both") return style;
  if (style === "reverse") return ontology === "source" ? "target" : ontology === "target" ? "source" : ontology;
  return ontology;
}
