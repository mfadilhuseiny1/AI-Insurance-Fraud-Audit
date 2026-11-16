"use client";

import { useRef, useState } from "react";
import { iconPath, type IconName } from "@/components/Icon";
import { CATEGORY_COLOR, categoryOf, edgeValid, size, type Component, type Graph, type SDEdge, type SDNode } from "@/lib/solutionDesigner";

export type View = { x: number; y: number; k: number };
export type Sel = { nodes: string[]; edge: string | null };
type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "move"; sx: number; sy: number; start: Record<string, { x: number; y: number }>; moved: boolean }
  | { kind: "resize"; id: string; dir: Dir; sx: number; sy: number; x: number; y: number; w: number; h: number }
  | { kind: "connect"; from: string; x: number; y: number }
  | { kind: "box"; sx: number; sy: number; x: number; y: number; add: string[] };

const KIND_LABEL: Record<string, string> = { file: "File", object_type: "Object type", interface: "Interface", action_type: "Action type" };

/** A resize handle: an edge (n, e, s, w) or a corner (ne, nw, se, sw) of the node. */
type Dir = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
const MIN_W = 120;
const MIN_H = 40;
const CURSOR: Record<Dir, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

/** The node's box after dragging handle `dir` by (dx, dy): the opposite edge stays put; never below the minimum size. */
export function resized(start: { x: number; y: number; w: number; h: number }, dir: Dir, dx: number, dy: number) {
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = Math.max(MIN_W, Math.round(start.w + dx));
  if (dir.includes("s")) h = Math.max(MIN_H, Math.round(start.h + dy));
  if (dir.includes("w")) {
    w = Math.max(MIN_W, Math.round(start.w - dx));
    x = start.x + start.w - w;
  }
  if (dir.includes("n")) {
    h = Math.max(MIN_H, Math.round(start.h - dy));
    y = start.y + start.h - h;
  }
  return { x, y, w, h };
}

export function Canvas({
  graph,
  onChange,
  sel,
  onSel,
  view,
  setView,
  comps,
  concepts,
  locked,
  resolved,
  preview,
  svgRef,
  onContext,
  onOpen,
  onEditLabel,
}: {
  graph: Graph;
  onChange: (g: Graph, record?: boolean, prev?: Graph) => void;
  sel: Sel;
  onSel: (s: Sel) => void;
  view: View;
  setView: (v: View) => void;
  comps: Record<string, Component>;
  concepts: Record<string, { category: string; name: string }>;
  locked: boolean;
  resolved: Record<string, { ok: boolean; reason?: string }>;
  preview?: { nodes: SDNode[]; edges: SDEdge[] } | null;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onContext: (e: { x: number; y: number; node?: string; edge?: string; wx: number; wy: number }) => void;
  onOpen: (id: string) => void;
  onEditLabel: (edgeId: string, sx: number, sy: number) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const before = useRef<Graph | null>(null);
  const [ghost, setGhost] = useState<Drag | null>(null);
  const s = graph.settings;
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const world = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  const members = (gid: string): string[] => graph.nodes.filter((n) => n.parent === gid).flatMap((n) => [n.id, ...(n.kind === "group" ? members(n.id) : [])]);
  const cat = (n: SDNode) => categoryOf(n, comps, concepts);
  /** The box as drawn: a minimized node shows 40 high (edges, connecting and selecting go by what is on screen). */
  const drawn = (n: SDNode) => {
    const z = size(n);
    return s.minimized && n.kind !== "group" && n.kind !== "text" ? { w: z.w, h: 40 } : z;
  };
  const order = [...graph.nodes].sort((a, b) => (a.kind === "group" ? -1 : 0) - (b.kind === "group" ? -1 : 0) || (a.z ?? 0) - (b.z ?? 0));

  const down = (e: React.PointerEvent, node?: SDNode, handle?: Dir | "connect") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {}
    const p = world(e.clientX, e.clientY);
    if (!node) {
      if (e.shiftKey && !locked) drag.current = { kind: "box", sx: p.x, sy: p.y, x: p.x, y: p.y, add: sel.nodes };
      else {
        drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
        onSel({ nodes: [], edge: null });
      }
      setGhost(drag.current);
      return;
    }
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;
    const picked = multi ? (sel.nodes.includes(node.id) ? sel.nodes.filter((x) => x !== node.id) : [...sel.nodes, node.id]) : sel.nodes.includes(node.id) ? sel.nodes : [node.id];
    onSel({ nodes: picked, edge: null });
    if (locked || s.pan_mode) {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      return;
    }
    before.current = graph;
    if (handle && handle !== "connect") {
      const z = size(node);
      drag.current = { kind: "resize", id: node.id, dir: handle, sx: p.x, sy: p.y, x: node.x, y: node.y, w: z.w, h: z.h };
    } else if (handle === "connect") {
      drag.current = { kind: "connect", from: node.id, x: p.x, y: p.y };
      setGhost(drag.current);
    } else {
      const ids = new Set(picked.flatMap((i) => [i, ...(byId[i]?.kind === "group" ? members(i) : [])]));
      drag.current = { kind: "move", sx: p.x, sy: p.y, start: Object.fromEntries([...ids].map((i) => [i, { x: byId[i].x, y: byId[i].y }])), moved: false };
    }
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView({ ...view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
      return;
    }
    const p = world(e.clientX, e.clientY);
    if (d.kind === "move") {
      const dx = Math.round(p.x - d.sx);
      const dy = Math.round(p.y - d.sy);
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      d.moved = true;
      onChange({ ...graph, nodes: graph.nodes.map((n) => (d.start[n.id] ? { ...n, x: d.start[n.id].x + dx, y: d.start[n.id].y + dy } : n)) }, false);
    } else if (d.kind === "resize") {
      const b = resized(d, d.dir, p.x - d.sx, p.y - d.sy);
      onChange({ ...graph, nodes: graph.nodes.map((n) => (n.id === d.id ? { ...n, ...b } : n)) }, false);
    } else if (d.kind === "connect" || d.kind === "box") {
      d.x = p.x;
      d.y = p.y;
      setGhost({ ...d });
    }
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setGhost(null);
    if (!d) return;
    const p = world(e.clientX, e.clientY);
    if (d.kind === "connect") {
      const target = [...graph.nodes].reverse().find((n) => n.kind !== "group" && n.kind !== "text" && n.id !== d.from && inside(n, p.x, p.y, drawn(n)));
      if (target && !graph.edges.some((x) => x.from === d.from && x.to === target.id)) {
        onChange({ ...graph, edges: [...graph.edges, { id: `e-${Math.random().toString(36).slice(2, 10)}`, from: d.from, to: target.id, label: "" }] });
      }
    } else if (d.kind === "box") {
      const x0 = Math.min(d.sx, d.x);
      const x1 = Math.max(d.sx, d.x);
      const y0 = Math.min(d.sy, d.y);
      const y1 = Math.max(d.sy, d.y);
      const hit = graph.nodes.filter((n) => {
        const z = drawn(n);
        return n.x >= x0 && n.y >= y0 && n.x + z.w <= x1 && n.y + z.h <= y1;
      });
      onSel({ nodes: [...new Set([...d.add, ...hit.map((n) => n.id)])], edge: null });
    } else if ((d.kind === "move" && d.moved) || d.kind === "resize") {
      // the box at the release point: `graph` may not have rendered the last pointer moves yet
      let g: Graph;
      if (d.kind === "resize") {
        const b = resized(d, d.dir, p.x - d.sx, p.y - d.sy);
        g = { ...graph, nodes: graph.nodes.map((n) => (n.id === d.id ? { ...n, ...b } : n)) };
      } else {
        const dx = Math.round(p.x - d.sx);
        const dy = Math.round(p.y - d.sy);
        const moved = graph.nodes.map((n) => (d.start[n.id] ? { ...n, x: d.start[n.id].x + dx, y: d.start[n.id].y + dy } : n));
        // group membership follows where the node is dropped
        const groups = moved.filter((n) => n.kind === "group");
        g = {
          ...graph,
          nodes: moved.map((n) => {
            if (!d.start[n.id] || (n.parent && d.start[n.parent])) return n;
            const z = drawn(n);
            const cx = n.x + z.w / 2;
            const cy = n.y + z.h / 2;
            const into = [...groups].reverse().find((gr) => gr.id !== n.id && !(n.kind === "group" && members(n.id).includes(gr.id)) && inside(gr, cx, cy));
            return (into?.id ?? null) === (n.parent ?? null) ? n : { ...n, parent: into?.id ?? null };
          }),
        };
      }
      if (before.current) onChange(g, true, before.current);
    }
    before.current = null;
  };
  const wheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = Math.min(2.5, Math.max(0.15, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    setView({ k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k });
  };

  const edgePath = (a: SDNode, b: SDNode) => {
    const za = drawn(a);
    const zb = drawn(b);
    const x1 = a.x + za.w;
    const y1 = a.y + za.h / 2;
    const x2 = b.x;
    const y2 = b.y + zb.h / 2;
    const c = Math.max(40, Math.abs(x2 - x1) / 2);
    return { d: `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  };
  /** Resize handles on every edge (invisible strips) and corner (squares) of a selected node. With `connector` the east
   * strip leaves the middle of the edge to the outgoing-connection handle (drag there to connect, elsewhere to resize).
   * With `widthOnly` (a minimized node: its height is fixed) there are no north / south strips and the corners resize
   * the width only, keeping the node's full height for when it is maximized again. */
  const handles = (n: SDNode, w: number, h: number, connector = false, widthOnly = false) => {
    const t = Math.min(16, Math.max(8, 8 / view.k)); // about 8 screen pixels when zoomed out (never more than 16 world units)
    const act = (dir: Dir): Dir => (widthOnly ? (dir.includes("e") ? "e" : "w") : dir);
    const strip = (dir: Dir, x: number, y: number, sw: number, sh: number, key: string = dir) => (
      <rect key={key} x={x} y={y} width={sw} height={sh} fill="transparent" style={{ cursor: CURSOR[dir] }} data-resize={dir} onPointerDown={(e) => down(e, n, dir)} />
    );
    const gap = 9; // half the connector's hit area
    const east = connector
      ? [strip("e", w - t / 2, t / 2, t, Math.max(0, h / 2 - gap - t / 2), "e1"), strip("e", w - t / 2, h / 2 + gap, t, Math.max(0, h / 2 - gap - t / 2), "e2")]
      : strip("e", w - t / 2, t / 2, t, Math.max(0, h - t));
    const corner = (dir: Dir, x: number, y: number) => (
      <rect key={dir} x={x - t / 2} y={y - t / 2} width={t} height={t} rx={1.5} fill="var(--color-panel)" stroke="var(--color-ocean)" strokeWidth={1.5}
        style={{ cursor: CURSOR[act(dir)] }} data-resize={dir} onPointerDown={(e) => down(e, n, act(dir))} />
    );
    return (
      <g className="sd-handle" data-resize-handles={widthOnly ? "width" : "all"}>
        {!widthOnly && strip("n", t / 2, -t / 2, Math.max(0, w - t), t)}
        {!widthOnly && strip("s", t / 2, h - t / 2, Math.max(0, w - t), t)}
        {strip("w", -t / 2, t / 2, t, Math.max(0, h - t))}
        {east}
        {corner("nw", 0, 0)}
        {corner("ne", w, 0)}
        {corner("sw", 0, h)}
        {corner("se", w, h)}
      </g>
    );
  };
  const renderNode = (n: SDNode, isPreview = false) => {
    const z = size(n);
    const selected = sel.nodes.includes(n.id);
    const color = CATEGORY_COLOR[cat(n)];
    if (n.kind === "group") {
      return (
        <g key={n.id} data-node={n.id} transform={`translate(${n.x},${n.y})`} onPointerDown={(e) => down(e, n)} onDoubleClick={() => onOpen(n.id)}
          onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), onContext({ x: e.clientX, y: e.clientY, node: n.id, wx: 0, wy: 0 }))}>
          <rect width={z.w} height={z.h} rx={10} fill={n.color ?? "var(--color-panel)"} fillOpacity={n.color ? 0.18 : 0.5} stroke={selected ? "var(--color-ocean)" : "var(--color-line-2)"} strokeWidth={selected ? 2 : 1.2} strokeDasharray="6 4" />
          <text x={12} y={20} fontSize={13} fontWeight={600} fill="var(--color-soft)">
            {n.title || "Group"}
          </text>
          {selected && !locked && handles(n, z.w, z.h)}
        </g>
      );
    }
    if (n.kind === "text") {
      const lines = wrap(n.title || "Text", Math.max(10, Math.floor(z.w / 7.2)));
      return (
        <g key={n.id} data-node={n.id} transform={`translate(${n.x},${n.y})`} onPointerDown={(e) => down(e, n)} onDoubleClick={() => onOpen(n.id)}
          onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), onContext({ x: e.clientX, y: e.clientY, node: n.id, wx: 0, wy: 0 }))}>
          <rect width={z.w} height={Math.max(z.h, lines.length * 17 + 12)} rx={4} fill={n.color ?? "transparent"} fillOpacity={0.25} stroke={selected ? "var(--color-ocean)" : "transparent"} strokeDasharray="3 3" />
          {lines.map((l, i) => (
            <text key={i} x={8} y={20 + i * 17} fontSize={13} fill="var(--color-soft)">
              {l}
            </text>
          ))}
          {selected && !locked && handles(n, z.w, z.h)}
        </g>
      );
    }
    const res = n.resource ? resolved[`${n.resource.kind}:${n.resource.id}`] : null;
    const broken = n.kind === "resource" && (!n.resource || (res && !res.ok));
    const mini = s.minimized;
    const h = mini ? 40 : z.h;
    const icon = (n.icon ?? (n.kind === "component" ? comps[n.component ?? ""]?.icon : n.kind === "resource" ? RES_ICON[n.resource?.kind ?? "file"] : n.kind === "concept" ? "sparkle" : "cube")) as IconName;
    const sub =
      n.kind === "component"
        ? comps[n.component ?? ""]?.name
        : n.kind === "resource"
          ? broken
            ? n.resource ? `${KIND_LABEL[n.resource.kind]} · ${res?.reason ?? "missing"}` : "No resource linked"
            : `${KIND_LABEL[n.resource!.kind]}${n.resource!.name && n.resource!.name !== n.title ? ` · ${n.resource!.name}` : ""}`
          : n.kind === "concept"
            ? `Concept · ${concepts[n.concept ?? ""]?.name ?? ""}`
            : `Proposed object type · ${n.proposed?.properties.length ?? 0} properties`;
    const iconCol = s.icons === "mono" ? "var(--color-soft)" : (n.icon_color ?? color);
    return (
      <g key={n.id} data-node={n.id} data-kind={n.kind} transform={`translate(${n.x},${n.y})`} opacity={isPreview ? 0.75 : 1}
        onPointerDown={isPreview ? undefined : (e) => down(e, n)} onDoubleClick={isPreview ? undefined : () => onOpen(n.id)}
        onContextMenu={isPreview ? undefined : (e) => (e.preventDefault(), e.stopPropagation(), onContext({ x: e.clientX, y: e.clientY, node: n.id, wx: 0, wy: 0 }))}>
        <rect width={z.w} height={h} rx={n.kind === "concept" ? 22 : 8} fill={n.color ?? "var(--color-panel-2)"}
          stroke={isPreview ? "var(--color-ocean)" : selected ? "var(--color-ocean)" : broken ? "var(--color-bad)" : "var(--color-line-2)"}
          strokeWidth={selected || isPreview ? 2 : 1.2} strokeDasharray={isPreview || n.kind === "concept" || n.kind === "object" ? "5 4" : broken ? "3 3" : undefined} />
        {n.kind !== "concept" && <rect width={4} height={h} rx={2} fill={color} />}
        {s.icons !== "none" && (
          <g transform={`translate(12,${mini ? 10 : 12}) scale(0.8)`}>
            <path d={iconPath(icon) ?? iconPath("info")} fill="none" stroke={iconCol} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        )}
        <text x={s.icons === "none" ? 14 : 38} y={mini ? 25 : 26} fontSize={13} fontWeight={600} fill="var(--color-strong)">
          {clip(n.title || sub || n.kind, Math.floor((z.w - 46) / 7.4))}
        </text>
        {!mini && (
          <text x={14} y={48} fontSize={11} fill={broken ? "var(--color-bad)" : "var(--color-muted)"}>
            {clip(sub ?? "", Math.floor((z.w - 20) / 6.2))}
          </text>
        )}
        {!mini && z.h >= 70 && (n.tags?.length ?? 0) > 0 && (
          <text x={14} y={64} fontSize={10} fill="var(--color-ocean)">
            {clip(n.tags!.map((t) => `#${t}`).join(" "), Math.floor((z.w - 20) / 5.8))}
          </text>
        )}
        {selected && !locked && !isPreview && handles(n, z.w, h, !s.pan_mode, mini)}
        {!isPreview && !locked && !s.pan_mode && (
          <>
            {/* the incoming side's marker is drawn only: the west resize strip under it stays usable */}
            <circle cx={0} cy={h / 2} r={5} fill="var(--color-panel)" stroke="var(--color-line-2)" className="sd-handle" pointerEvents="none" />
            <circle cx={z.w} cy={h / 2} r={6} fill="var(--color-panel)" stroke="var(--color-ocean)" className="sd-handle cursor-crosshair" onPointerDown={(e) => down(e, n, "connect")} data-handle="out" />
          </>
        )}
      </g>
    );
  };
  const edges = [...graph.edges, ...(preview?.edges ?? [])];
  const all = { ...byId, ...Object.fromEntries((preview?.nodes ?? []).map((n) => [n.id, n])) };
  const g = ghost;
  return (
    <svg ref={svgRef} className={`h-full w-full touch-none select-none ${s.pan_mode || locked ? "cursor-grab" : ""}`} onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onWheel={wheel}
      onContextMenu={(e) => {
        e.preventDefault();
        const p = world(e.clientX, e.clientY);
        onContext({ x: e.clientX, y: e.clientY, wx: p.x, wy: p.y });
      }} data-sd-canvas>
      <defs>
        <pattern id="sd-dots" width={24 * view.k} height={24 * view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
          <circle cx={1} cy={1} r={1} fill="var(--color-line-2)" />
        </pattern>
        <marker id="sd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-muted)" />
        </marker>
        <marker id="sd-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-bad)" />
        </marker>
      </defs>
      <rect width="100%" height="100%" fill="var(--color-ink)" />
      {s.dots && <rect width="100%" height="100%" fill="url(#sd-dots)" data-sd-dots />}
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`} data-sd-world>
        {order.filter((n) => n.kind === "group").map((n) => renderNode(n))}
        {edges.map((e) => {
          const a = all[e.from];
          const b = all[e.to];
          if (!a || !b) return null;
          const p = edgePath(a, b);
          const bad = s.edge_validity && !edgeValid(cat(a), cat(b));
          const on = sel.edge === e.id;
          const isPrev = !!preview?.edges.includes(e);
          return (
            <g key={e.id} data-edge={e.id}>
              <path d={p.d} fill="none" stroke="transparent" strokeWidth={14} className="cursor-pointer"
                onPointerDown={(x) => (x.stopPropagation(), onSel({ nodes: [], edge: e.id }))}
                onContextMenu={(x) => (x.preventDefault(), x.stopPropagation(), onContext({ x: x.clientX, y: x.clientY, edge: e.id, wx: 0, wy: 0 }))} />
              <path d={p.d} fill="none" stroke={on ? "var(--color-ocean)" : bad ? "var(--color-bad)" : "var(--color-muted)"} strokeOpacity={bad && !on ? 0.8 : 1} strokeWidth={on ? 2.4 : 1.5}
                markerEnd={bad ? "url(#sd-arrow-bad)" : "url(#sd-arrow)"} strokeDasharray={s.flow_animation || isPrev ? "6 5" : bad ? "4 3" : undefined} pointerEvents="none">
                {s.flow_animation && <animate attributeName="stroke-dashoffset" from="22" to="0" dur="0.9s" repeatCount="indefinite" />}
              </path>
              {s.edge_labels && (e.label || on) && (
                <g transform={`translate(${p.mx},${p.my})`} className="cursor-text" onPointerDown={(x) => x.stopPropagation()}
                  onClick={(x) => !locked && onEditLabel(e.id, x.clientX, x.clientY)}>
                  <rect x={-(Math.max(e.label.length, 8) * 3.3) - 6} y={-10} width={Math.max(e.label.length, 8) * 6.6 + 12} height={20} rx={4} fill="var(--color-panel)" stroke="var(--color-line-2)" />
                  <text textAnchor="middle" y={4} fontSize={11} fill={e.label ? "var(--color-soft)" : "var(--color-muted)"}>
                    {e.label || "Click to edit"}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {order.filter((n) => n.kind !== "group").map((n) => renderNode(n))}
        {preview?.nodes.map((n) => renderNode(n, true))}
        {g?.kind === "connect" && byId[g.from] && (
          <path d={`M ${byId[g.from].x + drawn(byId[g.from]).w} ${byId[g.from].y + drawn(byId[g.from]).h / 2} L ${g.x} ${g.y}`} stroke="var(--color-ocean)" strokeWidth={1.5} strokeDasharray="4 3" fill="none" />
        )}
        {g?.kind === "box" && <rect x={Math.min(g.sx, g.x)} y={Math.min(g.sy, g.y)} width={Math.abs(g.x - g.sx)} height={Math.abs(g.y - g.sy)} fill="var(--color-ocean)" fillOpacity={0.08} stroke="var(--color-ocean)" strokeDasharray="4 3" />}
      </g>
    </svg>
  );
}

const RES_ICON: Record<string, IconName> = { file: "doc", object_type: "cube", interface: "layers", action_type: "edit" };

function inside(n: SDNode, x: number, y: number, z = size(n)) {
  return x >= n.x && x <= n.x + z.w && y >= n.y && y <= n.y + z.h;
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + "…" : t);

function wrap(t: string, n: number): string[] {
  const out: string[] = [];
  for (const para of t.split("\n")) {
    let line = "";
    for (const w of para.split(" ")) {
      if ((line + " " + w).trim().length > n && line) {
        out.push(line);
        line = w;
      } else line = (line + " " + w).trim();
    }
    out.push(line);
  }
  return out.slice(0, 30);
}

/** The diagram's bounding box (for fit to view, the mini-map and PNG export). */
export function bounds(nodes: SDNode[]) {
  if (!nodes.length) return { x: 0, y: 0, w: 800, h: 500 };
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const x2 = nodes.map((n) => n.x + size(n).w);
  const y2 = nodes.map((n) => n.y + size(n).h);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...x2) - x, h: Math.max(...y2) - y };
}

export function MiniMap({ graph, view, box, onJump }: { graph: Graph; view: View; box: { w: number; h: number }; onJump: (x: number, y: number) => void }) {
  const b = bounds(graph.nodes);
  const pad = 80;
  const W = 200;
  const H = 130;
  const k = Math.min(W / (b.w + pad * 2), H / (b.h + pad * 2));
  const tx = (x: number) => (x - b.x + pad) * k;
  const ty = (y: number) => (y - b.y + pad) * k;
  return (
    <svg width={W} height={H} className="absolute bottom-3 right-3 z-10 rounded border border-line bg-panel/90" data-minimap
      onPointerDown={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onJump((e.clientX - r.left) / k + b.x - pad, (e.clientY - r.top) / k + b.y - pad);
      }}>
      {graph.nodes.map((n) => (
        <rect key={n.id} x={tx(n.x)} y={ty(n.y)} width={size(n).w * k} height={size(n).h * k} fill={n.kind === "group" ? "none" : "var(--color-line-2)"} stroke={n.kind === "group" ? "var(--color-line-2)" : "none"} />
      ))}
      <rect x={tx(-view.x / view.k)} y={ty(-view.y / view.k)} width={(box.w / view.k) * k} height={(box.h / view.k) * k} fill="var(--color-ocean)" fillOpacity={0.12} stroke="var(--color-ocean)" />
    </svg>
  );
}

/** A PNG of the diagram (or of the selected nodes) at 2x, with the theme's colors resolved. */
export async function exportPng(svg: SVGSVGElement, graph: Graph, only?: string[]): Promise<Blob> {
  const nodes = only?.length ? graph.nodes.filter((n) => only.includes(n.id)) : graph.nodes;
  const b = bounds(nodes);
  const pad = 40;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const world = clone.querySelector("[data-sd-world]");
  world?.setAttribute("transform", `translate(${-b.x + pad},${-b.y + pad})`);
  if (only?.length) clone.querySelectorAll("[data-node]").forEach((el) => !only.includes(el.getAttribute("data-node")!) && el.remove());
  clone.querySelectorAll(".sd-handle").forEach((el) => el.remove());
  clone.querySelectorAll("[data-sd-dots]").forEach((el) => el.remove());
  const w = b.w + pad * 2;
  const h = b.h + pad * 2;
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("font-family", getComputedStyle(document.body).fontFamily);
  let markup = new XMLSerializer().serializeToString(clone);
  const css = getComputedStyle(document.documentElement);
  markup = markup.replace(/var\((--[a-z0-9-]+)\)/g, (_, v: string) => css.getPropertyValue(v).trim() || "#888");
  const img = new Image();
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  await new Promise<void>((ok, bad) => {
    img.onload = () => ok();
    img.onerror = () => bad(new Error("could not render the diagram"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = w * 2;
  canvas.height = h * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  return await new Promise<Blob>((ok, bad) => canvas.toBlob((x) => (x ? ok(x) : bad(new Error("PNG export failed"))), "image/png"));
}
