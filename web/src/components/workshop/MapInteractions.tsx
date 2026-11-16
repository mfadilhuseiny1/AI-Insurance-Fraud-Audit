"use client";

/**
 * The Workshop Map widget's interactions: the toolbar (box / lasso / polygon selection, drawing points, lines and
 * polygons, deleting drawn shapes, selecting the objects a drawn shape meets), drawn shapes and the shape being drawn
 * (with geodesic measurements), the lasso layer, the timeline panel (a time window over the layers' time property,
 * playback) and their configuration. The geometry is in mapTools.ts / mapGeometry.ts (pure).
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import type { Module, WidgetConfig } from "@/lib/workshop";
import { ShapePath } from "./MapShapes";
import { prepare, turnsTo, type Frame } from "./mapGeometry";
import {
  applyEdit,
  edgeMiddles,
  editShapeOf,
  fmtArea,
  fmtClock,
  fmtLength,
  geodesicDistance,
  insertVertex,
  measureGeom,
  midWorld,
  moveVertex,
  removeVertex,
  ringArea,
  timeTicks,
  translateShape,
  worldOf,
  lonLatOf,
  type Clock,
  type DrawKind,
  type DrawnShape,
  type EditShape,
  type LonLat,
  type TimeWindow,
  type Units,
} from "./mapTools";

export type MapTool = "box" | "lasso" | "polygon" | "draw_point" | "draw_line" | "draw_polygon" | "modify";
export const DRAW_KINDS: DrawKind[] = ["point", "line", "polygon"];
export type MapMeasure = NonNullable<WidgetConfig["map_measure"]>;
const LABEL_STYLE = { paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 } as const;

// ------------------------------------------------------------------------------------------------
// toolbar
// ------------------------------------------------------------------------------------------------

const TOOL_LABEL: Record<MapTool, [string, string]> = {
  box: ["Box", "Box select: drag a box to select the objects it meets (shift adds). Esc to pan."],
  lasso: ["Lasso", "Lasso select: drag around the objects to select (shift adds). Esc to pan."],
  polygon: ["Polygon", "Polygon select: click the corners, double-click / Enter or click the first corner to select (shift adds). Esc cancels."],
  draw_point: ["Point", "Draw a point: click the map"],
  draw_line: ["Line", "Draw a line: click its points, double-click / Enter to finish, Backspace removes the last point, Esc cancels"],
  draw_polygon: ["Area", "Draw a polygon: click its corners, double-click / Enter or click the first corner to finish, Backspace removes the last corner, Esc cancels"],
  modify: ["Modify", "Modify a drawn shape: click it, then drag a corner to move it, drag a middle handle to add a corner, double-click a corner to remove it, or drag the shape to move it. Esc cancels a drag."],
};

const btn = (on: boolean) =>
  `shrink-0 rounded-md border px-2 py-1 text-[11px] leading-tight ${on ? "border-ocean bg-ocean/30 text-white" : "border-line bg-panel/90 text-muted hover:text-white"} disabled:opacity-40 disabled:hover:text-muted`;

export function MapToolbar({
  tools,
  tool,
  setTool,
  shapes,
  selectedShape,
  onDelete,
  onClear,
  onSelectIntersecting,
  canIntersect,
  onSearchWithin,
  canSearch,
  searching,
}: {
  tools: MapTool[];
  tool: MapTool | null;
  setTool: (t: MapTool | null) => void;
  shapes: number;
  selectedShape: boolean;
  onDelete: () => void;
  onClear: () => void;
  onSelectIntersecting?: () => void;
  canIntersect: boolean;
  /** geospatial object search on the server (Search within) */
  onSearchWithin?: () => void;
  canSearch?: boolean;
  searching?: boolean;
}) {
  if (!tools.length && !onSearchWithin) return null;
  const sel = tools.filter((t) => !t.startsWith("draw_") && t !== "modify");
  const draw = tools.filter((t) => t.startsWith("draw_") || t === "modify");
  const b = (t: MapTool) => (
    <button key={t} type="button" onClick={() => setTool(tool === t ? null : t)} className={btn(tool === t)} title={TOOL_LABEL[t][1]} aria-pressed={tool === t} data-map-tool={t} {...(t === "box" ? { "data-map-box-select": true } : {})}>
      {TOOL_LABEL[t][0]}
    </button>
  );
  return (
    // a short map: the toolbar scrolls inside it instead of running past its bottom
    <div className="absolute right-3 top-24 z-10 flex max-h-[calc(100%-7rem)] w-[4.5rem] flex-col gap-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none]" data-map-ui data-map-toolbar onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {sel.length > 0 && <div className="text-center text-[9px] uppercase tracking-wide text-muted">Select</div>}
      {sel.map(b)}
      {(draw.length > 0 || onSearchWithin) && <div className="mt-1 text-center text-[9px] uppercase tracking-wide text-muted">{draw.some((t) => t.startsWith("draw_")) ? "Draw" : "Shapes"}</div>}
      {draw.map(b)}
      {(draw.length > 0 || onSearchWithin) && (
        <>
          <button type="button" onClick={onDelete} disabled={!selectedShape} className={btn(false)} title="Delete the selected drawn shape (Delete key)" data-map-shape-delete>
            Delete
          </button>
          <button type="button" onClick={onClear} disabled={!shapes} className={btn(false)} title="Remove every drawn shape" data-map-shape-clear>
            Clear
          </button>
          {onSelectIntersecting && (
            <button type="button" onClick={onSelectIntersecting} disabled={!canIntersect} className={btn(false)} title="Select the objects that meet the selected drawn polygon (else every drawn polygon); shift adds" data-map-select-intersecting>
              Select within
            </button>
          )}
          {onSearchWithin && (
            <button
              type="button"
              onClick={onSearchWithin}
              disabled={!canSearch || searching}
              className={btn(!!searching)}
              title="Search the layers' objects that meet the selected drawn shape (else every drawn shape) on the server — all of them, not only the ones loaded on the map — and select them"
              data-map-search-within
            >
              {searching ? "Searching…" : "Search within"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// drawn shapes and the sketch, with measurements (in a ShapeFrame)
// ------------------------------------------------------------------------------------------------

type Label = { x: number; y: number; text: string; strong?: boolean };

/** Measurement labels of a line or polygon (positions in world units). `geomMeasure`: the drawn geometry's own totals
 * (a shape split at the antimeridian measures as its parts). */
export function measureLabels(kind: DrawKind, pts: LonLat[], m: MapMeasure | undefined, totals?: { area: number; perimeter: number; length: number }): Label[] {
  if (!m || kind === "point" || pts.length < 2) return [];
  const units: Units = m.units ?? "metric";
  const out: Label[] = [];
  const ring = kind === "polygon" && pts.length >= 3 ? [...pts, pts[0]] : pts;
  const mode = kind === "line" ? m.line : m.perimeter;
  if (mode === "segments")
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x, y] = midWorld(ring[i], ring[i + 1]);
      out.push({ x, y, text: fmtLength(geodesicDistance(ring[i], ring[i + 1]), units) });
    }
  if (kind === "line" && mode === "total") {
    const [x, y] = worldOf(pts[pts.length - 1]);
    let len = totals?.length;
    if (len === undefined) {
      len = 0;
      for (let i = 0; i + 1 < pts.length; i++) len += geodesicDistance(pts[i], pts[i + 1]);
    }
    out.push({ x, y, text: fmtLength(len, units), strong: true });
  }
  if (kind === "polygon" && pts.length >= 3 && (m.area || mode === "total")) {
    const ws = pts.map(worldOf);
    // the middle of its box (longitudes are continuous)
    const xs = ws.map((w) => w[0]);
    const ys = ws.map((w) => w[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const lines: string[] = [];
    if (m.area) lines.push(fmtArea(totals?.area ?? ringArea(pts), units));
    if (mode === "total") {
      let per = totals?.perimeter;
      if (per === undefined) {
        per = 0;
        for (let i = 0; i + 1 < ring.length; i++) per += geodesicDistance(ring[i], ring[i + 1]);
      }
      lines.push(`perimeter ${fmtLength(per, units)}`);
    }
    out.push({ x: cx, y: cy, text: lines.join("\n"), strong: true });
  }
  return out;
}

function Labels({ labels, f }: { labels: Label[]; f: Frame }) {
  const mid = (f.w / 2 - f.ox) / f.s;
  return (
    <>
      {labels.map((l, i) => {
        const x = (l.x + turnsTo(l.x, mid)) * f.s + f.ox;
        const y = l.y * f.s + f.oy;
        const rows = l.text.split("\n");
        return (
          <text key={i} x={x} y={y - ((rows.length - 1) * 13) / 2} textAnchor="middle" dominantBaseline="middle" className={`pointer-events-none fill-white ${l.strong ? "text-[12px] font-semibold" : "text-[10px]"}`} style={LABEL_STYLE} data-map-measure>
            {rows.map((r, j) => (
              <tspan key={j} x={x} dy={j ? 13 : 0}>
                {r}
              </tspan>
            ))}
          </text>
        );
      })}
    </>
  );
}

/** The drawn shapes (the selected one highlighted) and their measurements. */
export const DrawnShapes = memo(function DrawnShapes({ shapes, selected, f, color, opacity, measure }: { shapes: DrawnShape[]; selected: string | null; f: Frame; color: string; opacity: number; measure?: MapMeasure }) {
  return (
    <g data-map-drawn>
      {shapes.map((s) => {
        const p = prepare(s.geom);
        return (
          <g key={s.id} data-map-drawn-shape={s.id} data-kind={s.kind} data-selected={s.id === selected ? "true" : undefined} className="cursor-pointer">
            <ShapePath shape={p} f={f} color={color} fillOpacity={opacity} width={2} radius={6} selected={s.id === selected} />
            <Labels labels={measureLabels(s.kind, s.pts, measure, measureGeom(s.geom))} f={f} />
          </g>
        );
      })}
    </g>
  );
});

/**
 * The shape being drawn (a line, a polygon, or a selection polygon): its points so far, the rubber band to the pointer
 * and the live measurements. The pointer is followed here (over `host`), so the widget is not drawn again per move.
 */
export function Sketch({ kind, pts, f, host, toWorld, color, measure }: { kind: DrawKind; pts: [number, number][]; f: Frame; host: React.RefObject<HTMLElement | null>; toWorld: (e: { clientX: number; clientY: number }) => [number, number] | null; color: string; measure?: MapMeasure }) {
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const conv = useRef(toWorld);
  useEffect(() => {
    conv.current = toWorld;
  });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const move = (e: PointerEvent) => setCursor(conv.current(e));
    const leave = () => setCursor(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [host]);
  if (!pts.length) return null;
  // the sketch in one world copy: the one nearest the view's middle for the first point, the rest continuous from it
  const k = turnsTo(pts[0][0], (f.w / 2 - f.ox) / f.s);
  const all = cursor ? [...pts, [cursor[0] + turnsTo(cursor[0], pts[pts.length - 1][0]), cursor[1]] as [number, number]] : pts;
  const sx = (x: number) => (x + k) * f.s + f.ox;
  const sy = (y: number) => y * f.s + f.oy;
  const d = all.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("") + (kind === "polygon" && all.length > 2 ? "Z" : "");
  const lonlats = all.map(([x, y]) => lonLatOf(x, y));
  return (
    <g className="pointer-events-none" data-map-sketch={kind} data-points={pts.length}>
      <path d={d} fill={kind === "polygon" ? color : "none"} fillOpacity={0.15} stroke={color} strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round" />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={sx(x)} cy={sy(y)} r={i === 0 && kind === "polygon" ? 6 : 4} fill={i === 0 ? "#fff" : color} stroke="#0b1220" strokeWidth={1.5} />
      ))}
      <Labels labels={measureLabels(kind, lonlats, measure)} f={f} />
    </g>
  );
}

// ------------------------------------------------------------------------------------------------
// shape editing (the Modify tool): handles on the selected drawn shape
// ------------------------------------------------------------------------------------------------

type EditDrag = { kind: "vertex" | "mid" | "body"; part: number; index: number; start: [number, number]; base: EditShape; moved: boolean };

/**
 * The Modify tool's handles on a drawn shape: a corner handle per vertex (drag to move, double-click to remove), a
 * smaller handle in the middle of each edge (drag to add a vertex there) and the shape itself (drag to move it). While a
 * handle is dragged the shape is shown as it would be (`onPreview`); on release `onCommit` gets the edited shape; Esc
 * cancels the drag. Handles are not drawn for a shape with more than 2,000 vertices (it can still be moved).
 */
export function ShapeEditor({
  shape,
  f,
  toWorld,
  split,
  onPreview,
  onCommit,
}: {
  shape: DrawnShape;
  f: Frame;
  toWorld: (e: { clientX: number; clientY: number }) => [number, number] | null;
  split: boolean;
  onPreview: (s: DrawnShape | null) => void;
  onCommit: (s: DrawnShape) => void;
}) {
  const [live, setLive] = useState<EditShape | null>(null);
  const base = useMemo(() => editShapeOf(shape, split), [shape, split]);
  const cur = live ?? base;
  const drag = useRef<EditDrag | null>(null);
  const latest = useRef({ shape, split, toWorld, onPreview, onCommit });
  useEffect(() => {
    latest.current = { shape, split, toWorld, onPreview, onCommit };
  });
  // the edit as the pointer is now
  const editAt = (d: EditDrag, w: [number, number]): EditShape => {
    if (d.kind === "body") return translateShape(d.base, w[0] - d.start[0], w[1] - d.start[1]);
    const to = lonLatOf(w[0], w[1]);
    if (d.kind === "mid") return moveVertex(insertVertex(d.base, d.part, d.index, to), d.part, d.index + 1, to);
    return moveVertex(d.base, d.part, d.index, to);
  };
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  const begin = (e: React.PointerEvent, kind: EditDrag["kind"], part: number, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const w = toWorld(e);
    if (!w) return;
    drag.current = { kind, part, index, start: w, base: cur, moved: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      const p = latest.current.toWorld(ev);
      if (!d || !p) return;
      // a few pixels before a press becomes a drag
      if (!d.moved && Math.hypot((p[0] - d.start[0]) * f.s, (p[1] - d.start[1]) * f.s) < 3) return;
      d.moved = true;
      const next = editAt(d, p);
      setLive(next);
      latest.current.onPreview(applyEdit(latest.current.shape, next, latest.current.split));
    };
    const end = (ev: PointerEvent | null) => {
      const d = drag.current;
      drag.current = null;
      stop.current();
      setLive(null);
      latest.current.onPreview(null);
      if (!d || !d.moved || !ev) return;
      const p = latest.current.toWorld(ev);
      const done = p && applyEdit(latest.current.shape, editAt(d, p), latest.current.split);
      if (done) latest.current.onCommit(done);
    };
    const up = (ev: PointerEvent) => end(ev);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      stop.current = () => {};
    };
  };
  const remove = (e: React.MouseEvent, part: number, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    const next = removeVertex(base, part, index);
    const done = next && applyEdit(shape, next, split);
    if (done) onCommit(done);
  };
  // the shape at the world copy nearest the view's middle
  const first = cur.parts[0]?.pts[0];
  const k = first ? turnsTo(worldOf(first)[0], (f.w / 2 - f.ox) / f.s) : 0;
  const sx = (q: LonLat) => (worldOf(q)[0] + k) * f.s + f.ox;
  const sy = (q: LonLat) => worldOf(q)[1] * f.s + f.oy;
  const many = cur.parts.reduce((n, p) => n + p.pts.length, 0) > 2000;
  const stopClick = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <g data-map-editor={shape.id} data-vertices={cur.parts.map((p) => p.pts.length).join(",")} data-as-drawn={cur.asDrawn ? "true" : undefined}>
      {/* the body: drag to move the shape */}
      {cur.parts.map((p, i) =>
        p.pts.length > 1 ? (
          <path
            key={`b${i}`}
            d={p.pts.map((q, j) => `${j ? "L" : "M"}${sx(q).toFixed(1)},${sy(q).toFixed(1)}`).join("") + (p.ring ? "Z" : "")}
            fill={p.ring ? "rgba(255,255,255,0.01)" : "none"}
            stroke="rgba(255,255,255,0.01)"
            strokeWidth={14}
            className="cursor-move"
            onPointerDown={(e) => begin(e, "body", i, 0)}
            onClick={stopClick}
            onDoubleClick={stopClick}
            data-map-edit-body={i}
          />
        ) : null,
      )}
      {!many &&
        cur.parts.map((p, i) =>
          edgeMiddles(p).map(([after, q]) => (
            <circle
              key={`m${i}-${after}`}
              cx={sx(q)}
              cy={sy(q)}
              r={4}
              fill="#0b1220"
              fillOpacity={0.7}
              stroke="#fff"
              strokeWidth={1.5}
              className="cursor-copy"
              onPointerDown={(e) => begin(e, "mid", i, after)}
              onClick={stopClick}
              onDoubleClick={stopClick}
              data-map-edit-mid={`${i}:${after}`}
            >
              <title>Drag to add a corner</title>
            </circle>
          )),
        )}
      {!many &&
        cur.parts.map((p, i) =>
          p.pts.map((q, j) => (
            <circle
              key={`v${i}-${j}`}
              cx={sx(q)}
              cy={sy(q)}
              r={6}
              fill="#fff"
              stroke="#0b1220"
              strokeWidth={2}
              className="cursor-grab"
              onPointerDown={(e) => begin(e, p.pts.length === 1 && cur.parts.length === 1 ? "body" : "vertex", i, j)}
              onClick={stopClick}
              onDoubleClick={(e) => remove(e, i, j)}
              data-map-edit-vertex={`${i}:${j}`}
            >
              <title>Drag to move · double-click to remove</title>
            </circle>
          )),
        )}
    </g>
  );
}

// ------------------------------------------------------------------------------------------------
// lasso: a free-hand outline dragged over the map (screen pixels)
// ------------------------------------------------------------------------------------------------

export function LassoLayer({ onDone }: { onDone: (pts: [number, number][], rect: DOMRect, additive: boolean) => void }) {
  const [pts, setPts] = useState<[number, number][] | null>(null);
  return (
    <div
      className="absolute inset-0 z-[5] cursor-crosshair select-none"
      data-map-lasso-layer
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const r = e.currentTarget.getBoundingClientRect();
        setPts([[e.clientX - r.left, e.clientY - r.top]]);
      }}
      onPointerMove={(e) => {
        if (!pts) return;
        const r = e.currentTarget.getBoundingClientRect();
        const q: [number, number] = [e.clientX - r.left, e.clientY - r.top];
        const last = pts[pts.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 3) setPts([...pts, q]);
      }}
      onPointerUp={(e) => {
        if (!pts) return;
        const r = e.currentTarget.getBoundingClientRect();
        const done = [...pts, [e.clientX - r.left, e.clientY - r.top] as [number, number]];
        setPts(null);
        if (done.length >= 3) onDone(done, r, e.shiftKey || e.metaKey || e.ctrlKey);
      }}
    >
      {pts && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" data-map-lasso={pts.length}>
          <path d={pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("") + "Z"} fill="rgba(56,189,248,0.15)" stroke="#38bdf8" strokeWidth={2} strokeDasharray="5 3" />
        </svg>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// timeline panel
// ------------------------------------------------------------------------------------------------

/** A time for the timeline's labels, in UTC or the viewer's zone; with the time of day for spans under a few days (on
 * the 24-hour, 12-hour or the locale's clock). */
export function fmtTime(ms: number, utc: boolean, span: number, clock: Clock = "24h"): string {
  return fmtClock(ms, utc, span < 3 * 864e5, clock);
}

export function MapTimeline({
  extent,
  win,
  setWin,
  times,
  utc,
  locked,
  playing,
  setPlaying,
  mode,
  shown,
  onClose,
  clock = "24h",
  selectedTime = false,
  live,
  setLive,
  pauses = [],
}: {
  extent: TimeWindow;
  win: TimeWindow;
  setWin: (w: TimeWindow) => void;
  times: number[];
  utc: boolean;
  locked: boolean;
  playing: boolean;
  setPlaying: (on: boolean) => void;
  mode: "window" | "cumulative";
  shown: number;
  onClose?: () => void;
  /** the local time zone's clock */
  clock?: Clock;
  /** a selected time cursor (the window's end) on the track */
  selectedTime?: boolean;
  /** View latest (live mode): shown when setLive is given */
  live?: boolean;
  setLive?: (on: boolean) => void;
  /** auto pause times (marked on the track) */
  pauses?: number[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const span = Math.max(1, extent[1] - extent[0]);
  const pct = (t: number) => ((t - extent[0]) / span) * 100;
  const BINS = 60;
  const hist = useMemo(() => {
    const h = new Array(BINS).fill(0);
    for (const t of times) h[Math.min(BINS - 1, Math.max(0, Math.floor(((t - extent[0]) / span) * BINS)))]++;
    return h;
  }, [times, extent, span]);
  const top = Math.max(1, ...hist);
  const ticks = useMemo(() => timeTicks(extent[0], extent[1], 6), [extent]);
  const drag = useRef<{ kind: "move" | "start" | "end"; x: number; w: TimeWindow } | null>(null);
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return extent[0] + ((clientX - r.left) / Math.max(1, r.width)) * span;
  };
  const minW = span / 500;
  const clampW = (w: TimeWindow): TimeWindow => {
    let [a, b] = w;
    if (b - a < minW) b = a + minW;
    if (a < extent[0]) [a, b] = [extent[0], extent[0] + (b - a)];
    if (b > extent[1]) [a, b] = [extent[1] - (b - a), extent[1]];
    return [Math.max(extent[0], a), Math.min(extent[1], b)];
  };
  // a change made by the viewer leaves View latest
  const userWin = (w: TimeWindow) => {
    if (live) setLive?.(false);
    setWin(w);
  };
  const down = (kind: "move" | "start" | "end", e: React.PointerEvent) => {
    if (locked) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { kind, x: e.clientX, w: win };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !track.current) return;
    const r = track.current.getBoundingClientRect();
    const dt = ((e.clientX - d.x) / Math.max(1, r.width)) * span;
    if (d.kind === "move") userWin(clampW([d.w[0] + dt, d.w[1] + dt]));
    else if (d.kind === "start") userWin([Math.max(extent[0], Math.min(d.w[1] - minW, d.w[0] + dt)), d.w[1]]);
    else userWin([d.w[0], Math.min(extent[1], Math.max(d.w[0] + minW, d.w[1] + dt))]);
  };
  const up = () => (drag.current = null);
  const left = mode === "cumulative" ? 0 : pct(win[0]);
  const fmt = (t: number) => fmtTime(t, utc, span, clock);
  return (
    <div className="shrink-0 border-t border-line bg-panel/95 px-3 pb-2 pt-1.5 text-[11px]" data-map-timeline onClick={(e) => e.stopPropagation()}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!playing && live) setLive?.(false);
            setPlaying(!playing);
          }}
          disabled={locked}
          className={btn(playing)}
          aria-pressed={playing}
          data-map-play
          title={playing ? "Pause" : "Play: move the window through time"}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        {setLive && (
          <button
            type="button"
            onClick={() => {
              if (!live) setPlaying(false);
              setLive(!live);
            }}
            disabled={locked}
            className={btn(!!live)}
            aria-pressed={!!live}
            data-map-live
            title={live ? "Viewing the latest time: move the window to leave" : "View latest: keep the window at the newest time as data arrives"}
          >
            {live ? "● Live" : "View latest"}
          </button>
        )}
        <span className="text-soft" data-map-window>
          {mode === "cumulative" ? `up to ${fmt(win[1])}` : `${fmt(win[0])} – ${fmt(win[1])}`}
        </span>
        <span className="text-muted" data-map-shown={shown}>
          {shown.toLocaleString()} shown · {utc ? "UTC" : "local time"}
        </span>
        <span className="flex-1" />
        {!locked && (
          <button type="button" onClick={() => (setPlaying(false), userWin(extent))} className="text-muted hover:text-white" data-map-window-all title="The whole time range">
            Whole range
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} className="text-muted hover:text-white" title="Close the timeline (the window stays applied)" data-map-timeline-close>
            ✕
          </button>
        )}
      </div>
      <div
        ref={track}
        className={`relative h-10 select-none rounded bg-ink/60 ${locked ? "" : "cursor-pointer"}`}
        onPointerMove={move}
        onPointerUp={up}
        onPointerDown={(e) => {
          // a press outside the window centres the window there
          if (locked) return;
          const t = timeAt(e.clientX);
          const w = win[1] - win[0];
          userWin(clampW([t - w / 2, t + w / 2]));
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          drag.current = { kind: "move", x: e.clientX, w: clampW([t - w / 2, t + w / 2]) };
        }}
        data-map-track
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-8 items-end gap-px px-px">
          {hist.map((n, i) => {
            const t0 = extent[0] + (i / BINS) * span;
            const t1 = extent[0] + ((i + 1) / BINS) * span;
            const inside = t1 >= (mode === "cumulative" ? extent[0] : win[0]) && t0 <= win[1];
            return <div key={i} className={`flex-1 rounded-t-sm ${inside ? "bg-ocean/80" : "bg-line-2/60"}`} style={{ height: `${n ? Math.max(8, (n / top) * 100) : 0}%` }} />;
          })}
        </div>
        <div
          className="absolute inset-y-0 rounded border-2 border-ocean bg-ocean/15"
          style={{ left: `${left}%`, width: `${Math.max(0.4, pct(win[1]) - left)}%`, cursor: locked ? "default" : "grab" }}
          onPointerDown={(e) => down("move", e)}
          data-map-window-box
        >
          {!locked && mode !== "cumulative" && <div className="absolute inset-y-0 -left-1 w-2 cursor-ew-resize" onPointerDown={(e) => down("start", e)} data-map-window-start />}
          {!locked && <div className="absolute inset-y-0 -right-1 w-2 cursor-ew-resize" onPointerDown={(e) => down("end", e)} data-map-window-end />}
        </div>
        {pauses
          .filter((t) => t >= extent[0] && t <= extent[1])
          .map((t) => (
            <div key={t} className="pointer-events-none absolute -top-0.5 h-0 w-0 -translate-x-1/2 border-x-4 border-t-[6px] border-x-transparent border-t-warn" style={{ left: `${pct(t)}%` }} title={`Pauses at ${fmt(t)}`} data-map-pause-mark={t} />
          ))}
        {selectedTime && (
          // the selected time: the window's end; dragging it moves the window (cumulative: its end)
          <div className="pointer-events-none absolute inset-y-[-3px] w-0.5 -translate-x-1/2 bg-white" style={{ left: `${pct(win[1])}%` }} data-map-selected-time={win[1]}>
            {/* the knob on top: drag it to move the selected time (the window's end handle stays below it) */}
            <div
              className={`absolute -left-[5px] -top-1.5 h-3 w-3 rounded-full border-2 border-ink bg-white ${locked ? "" : "pointer-events-auto cursor-ew-resize"}`}
              onPointerDown={(e) => down(mode === "cumulative" ? "end" : "move", e)}
              title={`Selected time ${fmt(win[1])}`}
              data-map-selected-knob
            />
          </div>
        )}
      </div>
      <div className="relative mt-0.5 h-3 text-[9px] text-muted">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(t)}%` }}>
            {span < 3 * 864e5 ? fmt(t) : fmtClock(t, utc, false).slice(0, span > 2 * 365 * 864e5 ? 4 : 10)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

type VarSelect = (value: string | undefined, onChange: (v: string | undefined) => void, types: string[], empty?: string) => ReactNode;

export function MapInteractionsConfig({ c, set, varSelect, events }: { c: WidgetConfig; set: (x: Partial<WidgetConfig>) => void; mod: Module; varSelect: VarSelect; events: ReactNode }) {
  const kinds = c.map_draw_kinds ?? [];
  const m = c.map_measure;
  const chk = (label: string, on: boolean, change: (v: boolean) => void, attr: string, title?: string) => (
    <label key={attr} className="flex items-center gap-1" title={title}>
      <input type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} {...{ [attr]: true }} /> {label}
    </label>
  );
  const shapesOn = kinds.length > 0 || !!c.map_shape_edit || !!c.map_geo_search;
  return (
    <>
      <Field label="Drawing (shapes drawn on the map, as a GeoJSON string variable)">
        <div className="space-y-1.5 text-xs" data-map-draw-config>
          <div className="flex flex-wrap gap-3">
            {DRAW_KINDS.map((k) =>
              chk(k === "polygon" ? "Polygons" : k === "line" ? "Lines" : "Points", kinds.includes(k), (on) => set({ map_draw_kinds: on ? DRAW_KINDS.filter((x) => x === k || kinds.includes(x)) : kinds.filter((x) => x !== k).length ? kinds.filter((x) => x !== k) : undefined }), `data-map-draw-${k}`),
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            {chk("Shape editing tools", !!c.map_shape_edit, (v) => set({ map_shape_edit: v || undefined }), "data-map-shape-edit", "A Modify tool: move, reshape, add or remove the corners of drawn shapes (also shapes set in the drawn shapes variable)")}
            {chk("Geospatial object search", !!c.map_geo_search, (v) => set({ map_geo_search: v || undefined }), "data-map-geo-search", "A Search within button: every object of the layers' sources that meets a drawn shape (searched on the server, not only the loaded objects) is shown and selected")}
          </div>
          {shapesOn && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-muted">Color</span>
                <input type="color" value={c.map_draw_color ?? "#f97316"} onChange={(e) => set({ map_draw_color: e.target.value })} className="h-6 w-7 bg-transparent" />
                <span className="text-muted">Fill</span>
                <input type="range" min={0} max={0.9} step={0.05} value={c.map_draw_opacity ?? 0.25} onChange={(e) => set({ map_draw_opacity: Number(e.target.value) })} className="min-w-0 flex-1" />
              </div>
              <div className="grid grid-cols-2 gap-1">
                <div>
                  <div className="text-muted">Drawn shapes (both ways)</div>
                  {varSelect(c.map_draw_variable, (v) => set({ map_draw_variable: v }), ["string"], "Not stored")}
                </div>
                <div>
                  <div className="text-muted">Selected shape</div>
                  {varSelect(c.map_draw_selected_variable, (v) => set({ map_draw_selected_variable: v }), ["string"], "None")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted">Shape output</span>
                <select value={c.map_draw_output ?? "feature"} onChange={(e) => set({ map_draw_output: e.target.value === "geometry" ? "geometry" : undefined })} className={inputClass} data-map-draw-output>
                  <option value="feature">GeoJSON features (FeatureCollection / Feature)</option>
                  <option value="geometry">GeoJSON geometries (GeometryCollection / geometry)</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-3">
                {chk("Single draw mode", !!c.map_draw_single, (v) => set({ map_draw_single: v || undefined }), "data-map-draw-single", "A new shape replaces the drawn one")}
                {chk("Split at the antimeridian", c.map_draw_split !== false, (v) => set({ map_draw_split: v ? undefined : false }), "data-map-draw-split", "Shapes drawn across 180° become MultiPolygons / MultiLineStrings split there")}
                {chk("Shape-based selection", !!c.map_shape_selection, (v) => set({ map_shape_selection: v || undefined }), "data-map-shape-selection", "A Select within button: the objects that meet a drawn polygon")}
                {(c.map_shape_selection || c.map_geo_search) && chk("Clear shapes after selecting / searching", !!c.map_draw_clear_after, (v) => set({ map_draw_clear_after: v || undefined }), "data-map-draw-clear-after")}
              </div>
              {events}
            </>
          )}
        </div>
      </Field>
      <Field label="Loading">
        <div className="text-xs">
          {chk("Load only the objects in view", !!c.map_load_in_view, (v) => set({ map_load_in_view: v || undefined }), "data-map-load-in-view", "Each layer asks the server for the objects inside the map's view (again after each move), so a zoomed-in view shows all of its objects instead of the first 2,000 of the layer")}
        </div>
      </Field>
      <Field label="Measurements (geodesic, WGS 84)">
        <div className="space-y-1.5 text-xs" data-map-measure-config>
          {chk("Show measurements of drawn shapes", !!m, (v) => set({ map_measure: v ? { line: "total", perimeter: "total", area: true } : undefined }), "data-map-measure")}
          {m && (
            <div className="grid grid-cols-2 gap-1">
              <label className="text-muted">
                Lines
                <select value={m.line ?? ""} onChange={(e) => set({ map_measure: { ...m, line: (e.target.value || undefined) as MapMeasure["line"] } })} className={inputClass}>
                  <option value="">Off</option>
                  <option value="total">Total length</option>
                  <option value="segments">Each segment</option>
                </select>
              </label>
              <label className="text-muted">
                Polygon perimeter
                <select value={m.perimeter ?? ""} onChange={(e) => set({ map_measure: { ...m, perimeter: (e.target.value || undefined) as MapMeasure["perimeter"] } })} className={inputClass}>
                  <option value="">Off</option>
                  <option value="total">Total perimeter</option>
                  <option value="segments">Each edge</option>
                </select>
              </label>
              <label className="flex items-center gap-1 text-muted">
                <input type="checkbox" checked={!!m.area} onChange={(e) => set({ map_measure: { ...m, area: e.target.checked || undefined } })} /> Polygon area
              </label>
              <select value={m.units ?? "metric"} onChange={(e) => set({ map_measure: { ...m, units: e.target.value === "imperial" ? "imperial" : undefined } })} className={inputClass} data-map-units>
                <option value="metric">Metric (m, km, ha, km²)</option>
                <option value="imperial">Imperial (ft, mi, acres)</option>
              </select>
            </div>
          )}
        </div>
      </Field>
      <Field label="Timeline (a time window over the layers' time property)">
        <div className="space-y-1.5 text-xs" data-map-timeline-config>
          {chk("Enable timeline", !!c.map_timeline, (v) => set({ map_timeline: v || undefined }), "data-map-timeline-enable", "Set each layer's time property; objects outside the window are hidden")}
          {c.map_timeline && (
            <>
              <div className="flex flex-wrap gap-3">
                {chk("Open by default", c.map_timeline_open !== false, (v) => set({ map_timeline_open: v ? undefined : false }), "data-map-timeline-open")}
                {chk("Users can change the time", !c.map_timeline_locked, (v) => set({ map_timeline_locked: v ? undefined : true }), "data-map-timeline-user")}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <select value={c.map_time_mode ?? "window"} onChange={(e) => set({ map_time_mode: e.target.value === "cumulative" ? "cumulative" : undefined })} className={inputClass} data-map-time-mode>
                  <option value="window">Objects in the window</option>
                  <option value="cumulative">Everything up to the window&apos;s end</option>
                </select>
                <select value={c.map_time_zone ?? "local"} onChange={(e) => set({ map_time_zone: e.target.value === "utc" ? "utc" : undefined })} className={inputClass} data-map-time-zone>
                  <option value="local">Local time zone</option>
                  <option value="utc">UTC</option>
                </select>
                {c.map_time_zone !== "utc" && (
                  <select value={c.map_time_format ?? "24h"} onChange={(e) => set({ map_time_format: e.target.value === "12h" ? "12h" : e.target.value === "local" ? "local" : undefined })} className={inputClass} data-map-time-format title="The clock of the local time zone">
                    <option value="24h">24-hour clock</option>
                    <option value="12h">12-hour clock</option>
                    <option value="local">The viewer&apos;s locale</option>
                  </select>
                )}
                {chk("View latest toggle", !!c.map_time_live, (v) => set({ map_time_live: v || undefined }), "data-map-time-live", "A live mode in the timeline: the window stays at the newest time as data arrives")}
                <div>
                  <div className="text-muted">Selected time (the window&apos;s end)</div>
                  {varSelect(c.map_selected_time_variable, (v) => set({ map_selected_time_variable: v }), ["timestamp", "date", "number"], "Not stored")}
                </div>
                <div>
                  <div className="text-muted">Auto pause at (timestamps)</div>
                  {varSelect(c.map_auto_pause_variable, (v) => set({ map_auto_pause_variable: v }), ["array"], "None")}
                </div>
                <div>
                  <div className="text-muted">Window start</div>
                  {varSelect(c.map_time_start_variable, (v) => set({ map_time_start_variable: v }), ["timestamp", "date", "number"], "Not stored")}
                </div>
                <div>
                  <div className="text-muted">Window end</div>
                  {varSelect(c.map_time_end_variable, (v) => set({ map_time_end_variable: v }), ["timestamp", "date", "number"], "Not stored")}
                </div>
                <div>
                  <div className="text-muted">Playback state</div>
                  {varSelect(c.map_play_variable, (v) => set({ map_play_variable: v }), ["boolean"], "Not stored")}
                </div>
                <div>
                  <div className="text-muted">Playback position (ms)</div>
                  {varSelect(c.map_play_position_variable, (v) => set({ map_play_position_variable: v }), ["number"], "Not stored")}
                </div>
              </div>
              <label className="flex items-center gap-2 text-muted">
                Step every
                <input type="number" min={100} step={100} value={c.map_play_interval ?? 1000} onChange={(e) => set({ map_play_interval: Math.max(100, Number(e.target.value) || 1000) })} className={`${inputClass} w-20`} data-map-play-interval />
                ms (each step moves the window by its width)
              </label>
            </>
          )}
        </div>
      </Field>
    </>
  );
}
