"use client";

/**
 * Contour's Map board (Analytics doc 03): layers on a basemap (the Map app's MapCanvas), computed on the server
 * (api/contour_viz.py):
 * - point: up to 20,000 points on a canvas, one color, by category or on a scale, hover tooltips; click selects.
 *   Size: small / medium / large / extra large, or a numeric column on a linear, log or square root scale.
 * - cluster: the server's cells merged into coarser clusters as the map zooms out (count / sum / avg / min / max);
 *   sized by the aggregate on a linear, log or square root scale, one color or a scaled color; clicking zooms in.
 * - heatmap: the cells' values blurred and colored on a scale.
 * - choropleth: GeoJSON boundary regions (a file in Files) colored by an aggregate per region, or a GeoJSON column
 *   per row; clicking a region or a shape selects its rows.
 * - line: start / end coordinates or a GeoJSON line column; clicking a line selects it.
 * Layers are drawn in the order of the board's `layers` (the first at the bottom; dragged into order in the settings):
 * consecutive point / cluster / heatmap layers share a canvas, placed in the map's SVG (a foreignObject) between the
 * SVG layers, so a later layer covers an earlier one whichever kind it is. Hover and click go to the topmost layer
 * under the pointer: an SVG element on top, else the canvas layers' hit tests from the top down. Every point, cluster,
 * region, shape and line has a hover tooltip.
 * Circles, polygons and boxes drawn on the map select the rows of every current-set point, cluster and heatmap layer;
 * a box or polygon also selects the GeoJSON-column shapes it touches (by their keys). The selection (OR-ed; "remove"
 * mode keeps the other rows) filters the boards below. Format: zoom to fit or an initial viewport, the legend shown
 * or hidden, layer toggles allowed or not, each layer's opacity.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { MapCanvas, type Basemap, type Bounds, type MapHandle, type Projection } from "@/components/map/MapCanvas";
import { inputClass } from "@/components/pipeline/Modal";
import type { BoardConfig, BoardResult, ColorLegend, GeoGeometry, MapLayerResult, MapSizeLegend, SourceRef } from "@/lib/contour";
import { fmt } from "@/lib/workshop";
import { CATEGORY, colorOf, OTHER, SCALE_CSS, scaleColor } from "./vizColors";

const small = `${inputClass} py-1 text-xs`;
const METRICS = ["count", "sum", "avg", "min", "max", "median", "stddev", "distinct"];
export const LAYER_TYPES: [string, string][] = [
  ["point", "Points"],
  ["cluster", "Clusters"],
  ["heatmap", "Heatmap"],
  ["choropleth", "Choropleth"],
  ["line", "Lines"],
];
const LAYER_LABEL = Object.fromEntries(LAYER_TYPES);

type Sel = Record<string, unknown> & { kind: string };
type Cell = { lat: number; lon: number; n: number; value: number | null };

/** The board's layers as configured (a map saved before layers is one point layer), as api/contour_viz.map_layers. */
export function mapLayers(c: BoardConfig): BoardConfig[] {
  if (!c.layers?.length && c.lat && c.lon) return [{ id: "l1", type: "point", lat: c.lat, lon: c.lon, tooltip: c.label }];
  return (c.layers ?? []).filter((l: unknown) => !!l && typeof l === "object");
}

const keyOf = (s: unknown) => JSON.stringify(s);
const isSel = (s: unknown): s is Sel => !!s && typeof s === "object" && typeof (s as Sel).kind === "string";

/** The point size presets (the doc's small / medium / large / extra large), as radii in pixels. */
export const SIZE_PRESETS: [string, string, number][] = [
  ["s", "small", 2.5],
  ["m", "medium", 4],
  ["l", "large", 6],
  ["xl", "extra large", 9],
];
export const SIZE_RANGE: [number, number] = [2.5, 14];
const SCALES: [string, string][] = [
  ["linear", "linear"],
  ["log", "log"],
  ["sqrt", "square root"],
];

/** f(v) of a size scale (api/contour_viz.size_scale_sql); null when the value has no place on it. */
export function scaleF(scale: string | undefined, v: unknown): number | null {
  const x = typeof v === "number" ? v : v === null || v === undefined || v === "" ? NaN : Number(v);
  if (!Number.isFinite(x)) return null;
  if (scale === "log") return x > 0 ? Math.log10(x) : null;
  if (scale === "sqrt") return x >= 0 ? Math.sqrt(x) : null;
  return x;
}

/** A point's radius on the size legend's scale: min..max of the usable rows → SIZE_RANGE; no usable value: smallest. */
export function sizeRadius(s: MapSizeLegend, v: unknown): number {
  const f = scaleF(s.scale, v), f0 = scaleF(s.scale, s.min), f1 = scaleF(s.scale, s.max);
  const [r0, r1] = SIZE_RANGE;
  if (f === null || f0 === null || f1 === null) return r0;
  return f1 === f0 ? (r0 + r1) / 2 : r0 + Math.max(0, Math.min(1, (f - f0) / (f1 - f0))) * (r1 - r0);
}

/** The fixed radius of a point layer: the old free radius, a preset, or the default by point count. */
function fixedRadius(cfg: BoardConfig, n: number): number {
  if (cfg.radius) return Number(cfg.radius);
  const p = SIZE_PRESETS.find((x) => x[0] === cfg.size);
  return p ? p[2] : n > 5000 ? 2.2 : 3.5;
}

/** Cluster radii: the aggregate (count: rows) on the layer's size scaling (default square root) over the cells shown;
 * linear and square root start at 0 when every value is >= 0. */
function clusterRadius(cells: Cell[], cfg: BoardConfig, metric?: string): (c: Cell) => number {
  const scale = cfg.scaling ?? "sqrt";
  const val = (c: Cell) => (!metric || metric === "count" ? c.n : c.value);
  const fs = cells.map((c) => scaleF(scale, val(c))).filter((x): x is number => x !== null);
  if (!fs.length) return () => 5;
  let f0 = Math.min(...fs);
  const f1 = Math.max(...fs);
  if (scale !== "log" && f0 >= 0) f0 = 0;
  return (c) => {
    const f = scaleF(scale, val(c));
    if (f === null) return 5;
    return 5 + 18 * (f1 === f0 ? 0.5 : (f - f0) / (f1 - f0));
  };
}

// --------------------------------------------------- shapes touched by a drawn box / polygon (planar lon / lat)

type XY = [number, number];
function inRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function crosses(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
/** The parts of a geometry: polygons (rings, the first the outer one), lines and points. */
function partsOf(g: GeoGeometry | null | undefined, out: { polys: XY[][][]; lines: XY[][]; points: XY[] } = { polys: [], lines: [], points: [] }) {
  if (!g) return out;
  const cs = g.coordinates as never;
  const xy = (q: number[]): XY => [Number(q[0]), Number(q[1])];
  if (g.type === "Polygon") out.polys.push((cs as number[][][]).map((r) => r.map(xy)));
  else if (g.type === "MultiPolygon") (cs as number[][][][]).forEach((p) => out.polys.push(p.map((r) => r.map(xy))));
  else if (g.type === "LineString") out.lines.push((cs as number[][]).map(xy));
  else if (g.type === "MultiLineString") (cs as number[][][]).forEach((l) => out.lines.push(l.map(xy)));
  else if (g.type === "Point") out.points.push(xy(cs as number[]));
  else if (g.type === "MultiPoint") (cs as number[][]).forEach((p) => out.points.push(xy(p)));
  else if (g.type === "GeometryCollection") (g.geometries ?? []).forEach((x) => partsOf(x, out));
  return out;
}
/** Whether a GeoJSON geometry touches a closed ring (a vertex inside, the ring inside a polygon, or crossing edges). */
export function touchesRing(g: GeoGeometry | null | undefined, ring: number[][]): boolean {
  const R = ring.map((q) => [Number(q[0]), Number(q[1])] as XY);
  if (R.length > 1 && R[0][0] === R[R.length - 1][0] && R[0][1] === R[R.length - 1][1]) R.pop();
  if (R.length < 3) return false;
  const { polys, lines, points } = partsOf(g);
  if (points.some((p) => inRing(p, R))) return true;
  const paths: XY[][] = [...lines, ...polys.flat()];
  if (paths.some((path) => path.some((p) => inRing(p, R)))) return true;
  // the drawn ring inside a polygon (inside its outer ring, outside its holes)
  if (polys.some((p) => inRing(R[0], p[0]) && !p.slice(1).some((h) => inRing(R[0], h)))) return true;
  for (const path of paths)
    for (let i = 1; i < path.length; i++)
      for (let j = 0; j < R.length; j++) if (crosses(path[i - 1], path[i], R[j], R[(j + 1) % R.length])) return true;
  return false;
}

/** The last view of each board's map (board id → lat, lon, zoom), for "use the current view" in the settings. */
export const lastMapView = new Map<string, { lat: number; lon: number; zoom: number }>();

/** Cells of level k merged into level j (2^(k-j) cells per side); count / sum / avg / min / max stay exact. */
function mergeCells(l: MapLayerResult, j: number): Cell[] {
  const c = l.cells;
  if (!c?.gx?.length) return [];
  const k = l.k ?? 0;
  if (!l.mergeable || j >= k) return c.gx.map((_, i) => ({ lat: c.lat[i], lon: c.lon[i], n: c.n[i], value: c.value[i] }));
  const f = 2 ** (k - j);
  const acc = new Map<string, { n: number; la: number; lo: number; s: number; mn: number; mx: number; nv: number }>();
  for (let i = 0; i < c.gx.length; i++) {
    const key = `${Math.floor(c.gx[i] / f)},${Math.floor(c.gy[i] / f)}`;
    let e = acc.get(key);
    if (!e) acc.set(key, (e = { n: 0, la: 0, lo: 0, s: 0, mn: Infinity, mx: -Infinity, nv: 0 }));
    e.n += c.n[i];
    e.la += c.lat[i] * c.n[i];
    e.lo += c.lon[i] * c.n[i];
    if (c.s) {
      const s = c.s[i], mn = c.mn?.[i], mx = c.mx?.[i];
      if (s !== null) e.s += s;
      if (mn !== null && mn !== undefined) e.mn = Math.min(e.mn, mn);
      if (mx !== null && mx !== undefined) e.mx = Math.max(e.mx, mx);
      e.nv += c.nv?.[i] ?? 0;
    }
  }
  const m = l.metric ?? "count";
  return [...acc.values()].map((e) => ({
    lat: e.la / e.n,
    lon: e.lo / e.n,
    n: e.n,
    value: m === "count" ? e.n : !e.nv ? null : m === "sum" ? e.s : m === "avg" ? e.s / e.nv : m === "min" ? e.mn : e.mx,
  }));
}

/** An SVG path for a GeoJSON geometry under the projection (points as small circles). */
function pathOf(g: GeoGeometry | null | undefined, p: Projection): string {
  if (!g) return "";
  const ring = (cs: number[][], close: boolean) =>
    cs.length ? `M${cs.map((q) => `${p.px(q[0]).toFixed(1)},${p.py(q[1]).toFixed(1)}`).join("L")}${close ? "Z" : ""}` : "";
  const dot = (q: number[]) => `M${p.px(q[0]) - 3},${p.py(q[1])}a3,3 0 1,0 6,0a3,3 0 1,0 -6,0`;
  const cs = g.coordinates as never;
  switch (g.type) {
    case "Polygon":
      return (cs as number[][][]).map((r) => ring(r, true)).join("");
    case "MultiPolygon":
      return (cs as number[][][][]).flatMap((poly) => poly.map((r) => ring(r, true))).join("");
    case "LineString":
      return ring(cs as number[][], false);
    case "MultiLineString":
      return (cs as number[][][]).map((r) => ring(r, false)).join("");
    case "Point":
      return dot(cs as number[]);
    case "MultiPoint":
      return (cs as number[][]).map(dot).join("");
    case "GeometryCollection":
      return (g.geometries ?? []).map((x) => pathOf(x, p)).join("");
  }
  return "";
}

function extendGeo(g: GeoGeometry | null | undefined, add: (lon: number, lat: number) => void) {
  if (!g) return;
  if (g.type === "GeometryCollection") return (g.geometries ?? []).forEach((x) => extendGeo(x, add));
  const walk = (v: unknown) => {
    if (Array.isArray(v) && typeof v[0] === "number") add(v[0] as number, v[1] as number);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  walk(g.coordinates);
}

/** The data's bounds over every layer (for "fit"). */
function dataBounds(layers: MapLayerResult[]): Bounds | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (lon: number, lat: number) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    x0 = Math.min(x0, lon);
    x1 = Math.max(x1, lon);
    y0 = Math.min(y0, lat);
    y1 = Math.max(y1, lat);
  };
  for (const l of layers) {
    if (l.error) continue;
    l.points?.lat.forEach((la, i) => add(l.points!.lon[i], la));
    l.cells?.lat?.forEach((la, i) => add(l.cells!.lon[i], la));
    l.lines?.lat.forEach((la, i) => (add(l.lines!.lon[i], la), add(l.lines!.lon2[i], l.lines!.lat2[i])));
    l.regions?.forEach((r) => r.n > 0 && extendGeo(r.geometry, add));
    l.shapes?.forEach((s) => extendGeo(s.geometry, add));
  }
  if (x0 === Infinity) return null;
  const pad = Math.max(0.01, (x1 - x0) * 0.05, (y1 - y0) * 0.05);
  return [Math.max(-180, x0 - pad), Math.max(-85, y0 - pad), Math.min(180, x1 + pad), Math.min(85, y1 + pad)];
}

const singleColor = (cfg: BoardConfig, i: number) => (typeof cfg.color === "string" && cfg.color.startsWith("#") ? cfg.color : CATEGORY[i % CATEGORY.length]);

/** What the pointer is over: a point (its index) or a cluster cell of a canvas layer, or an SVG shape element. */
type Hit = { layer: MapLayerResult; i?: number; cell?: Cell; el?: Element };
type HitTest = (x: number, y: number) => Hit | null;

/** Layers drawn on a canvas (points, clusters, heatmaps); the others (regions, shapes, lines) are SVG. */
export const onCanvas = (l: MapLayerResult) => !l.regions && !l.shapes && !l.lines && (l.type === "point" || l.type === "cluster" || l.type === "heatmap" || !!l.points || !!l.cells);

/** The layers in drawing order (the first at the bottom), consecutive canvas layers sharing one canvas: one stack in
 * the map's SVG, so a layer listed later covers the ones before it whether it is drawn on a canvas or in SVG. */
export function layerStack(layers: MapLayerResult[]): { key: string; canvas: boolean; layers: MapLayerResult[] }[] {
  const out: { key: string; canvas: boolean; layers: MapLayerResult[] }[] = [];
  for (const l of layers) {
    const cv = onCanvas(l);
    const last = out[out.length - 1];
    if (cv && last?.canvas) last.layers.push(l);
    else out.push({ key: l.id, canvas: cv, layers: [l] });
  }
  return out;
}

/** Reports the current projection (for drawing a box in screen pixels). */
function ProjSink({ p, onProj }: { p: Projection; onProj: (p: Projection) => void }) {
  useEffect(() => onProj(p), [p, onProj]);
  return null;
}

/** Points, clusters and heatmaps on one canvas (redrawn on every pan / zoom); registers a hit test per layer. */
function LayerCanvas({ p, layers, cfgs, hidden, onHit }: {
  p: Projection;
  layers: MapLayerResult[];
  cfgs: Map<string, { cfg: BoardConfig; i: number }>;
  hidden: Set<string>;
  /** each layer's hit test: the nearest point / cluster whose drawn disc (plus a few pixels) holds the spot */
  onHit: (id: string, f: HitTest) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const merged = useMemo(() => {
    const out = new Map<string, Cell[]>();
    for (const l of layers) if (l.cells && !l.error) out.set(l.id, mergeCells(l, Math.max(0, Math.round(p.z) + (l.type === "heatmap" ? 5 : 2))));
    return out;
  }, [layers, p.z]);
  const radii = useMemo(() => {
    const out = new Map<string, (c: Cell) => number>();
    for (const l of layers) if (l.type === "cluster" && !l.error) out.set(l.id, clusterRadius(merged.get(l.id) ?? [], cfgs.get(l.id)?.cfg ?? {}, l.metric));
    return out;
  }, [layers, merged, cfgs]);
  // points sized by a column: each one's radius, drawn largest first so small points stay visible on top
  const sizes = useMemo(() => {
    const out = new Map<string, { r: number[]; order: number[] }>();
    for (const l of layers) {
      const S = l.size, P = l.points;
      if (l.error || !S || !P?.size) continue;
      const r = P.size.map((v) => sizeRadius(S, v));
      out.set(l.id, { r, order: r.map((_, i) => i).sort((a, b) => r[b] - r[a]) });
    }
    return out;
  }, [layers]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(p.w * dpr);
    cv.height = Math.round(p.h * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, p.w, p.h);
    const inView = (x: number, y: number, r = 20) => x > -r && y > -r && x < p.w + r && y < p.h + r;
    let drawn = 0;
    for (const l of layers) {
      if (l.error || hidden.has(l.id)) continue;
      const { cfg, i: idx } = cfgs.get(l.id) ?? { cfg: {}, i: 0 };
      const op = Number(cfg.opacity ?? (l.type === "heatmap" ? 0.85 : 0.8));
      if (l.type === "heatmap") {
        const cells = merged.get(l.id) ?? [];
        const vis = cells.filter((c) => inView(p.px(c.lon), p.py(c.lat), 40));
        const max = Math.max(1e-12, ...vis.map((c) => Math.abs(c.value ?? 0)));
        const off = document.createElement("canvas");
        off.width = Math.max(1, Math.round(p.w));
        off.height = Math.max(1, Math.round(p.h));
        const og = off.getContext("2d");
        if (!og) continue;
        const r = Number(cfg.radius ?? 18);
        for (const c of vis) {
          const x = p.px(c.lon), y = p.py(c.lat);
          const a = Math.min(1, Math.abs(c.value ?? 0) / max) * 0.6 + 0.04;
          const gr = og.createRadialGradient(x, y, 0, x, y, r);
          gr.addColorStop(0, `rgba(0,0,0,${a})`);
          gr.addColorStop(1, "rgba(0,0,0,0)");
          og.fillStyle = gr;
          og.fillRect(x - r, y - r, 2 * r, 2 * r);
        }
        const img = og.getImageData(0, 0, off.width, off.height);
        const d = img.data;
        const lut = Array.from({ length: 256 }, (_, k) => scaleColor(k / 255).match(/\d+/g)!.map(Number));
        for (let k = 0; k < d.length; k += 4) {
          const A = d[k + 3];
          if (!A) continue;
          const [rr, gg, bb] = lut[A];
          d[k] = rr;
          d[k + 1] = gg;
          d[k + 2] = bb;
          d[k + 3] = Math.min(255, A * 1.6) * op;
        }
        og.putImageData(img, 0, 0);
        g.drawImage(off, 0, 0, p.w, p.h);
        drawn += vis.length;
      } else if (l.type === "cluster") {
        const cells = merged.get(l.id) ?? [];
        const rad = radii.get(l.id) ?? (() => 5);
        const counted = !l.metric || l.metric === "count";
        const scaled = (cfg.color_mode ?? (counted ? "single" : "scale")) === "scale";
        const v = (c: Cell) => (counted ? c.n : c.value);
        const col = scaled ? colorOf({ kind: "scale", min: Math.min(...cells.map((c) => v(c) ?? Infinity)), max: Math.max(...cells.map((c) => v(c) ?? -Infinity)) }) : () => singleColor(cfg, idx);
        g.font = "10px sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        for (const c of cells) {
          const x = p.px(c.lon), y = p.py(c.lat);
          if (!inView(x, y, 40)) continue;
          const r = rad(c);
          g.globalAlpha = op;
          g.fillStyle = col(v(c));
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
          g.globalAlpha = 1;
          g.strokeStyle = "rgba(255,255,255,0.7)";
          g.lineWidth = 1;
          g.stroke();
          if (c.n > 1) {
            g.fillStyle = "#fff";
            g.fillText(c.n >= 10000 ? `${Math.round(c.n / 1000)}k` : String(c.n), x, y);
          }
          drawn++;
        }
      } else if (l.type === "point" && l.points) {
        const P = l.points;
        const col = l.color ? colorOf(l.color) : () => singleColor(cfg, idx);
        const fixed = fixedRadius(cfg, P.lat.length);
        const S = sizes.get(l.id);
        g.globalAlpha = op;
        for (let k = 0; k < P.lat.length; k++) {
          const i = S ? S.order[k] : k;
          const x = p.px(P.lon[i]), y = p.py(P.lat[i]);
          if (!inView(x, y)) continue;
          g.fillStyle = col(P.color?.[i]);
          g.beginPath();
          g.arc(x, y, S ? S.r[i] : fixed, 0, Math.PI * 2);
          g.fill();
          if (S) {
            g.strokeStyle = "rgba(255,255,255,0.35)";
            g.lineWidth = 0.5;
            g.stroke();
          }
          drawn++;
        }
        g.globalAlpha = 1;
      }
    }
    cv.dataset.drawn = String(drawn);
  }, [p, layers, cfgs, hidden, merged, radii, sizes]);
  useEffect(() => {
    for (const l of layers) onHit(l.id, (x, y) => {
      let best: Hit | null = null;
      let bd = Infinity;
      if (l.error || hidden.has(l.id)) return null;
      if (l.type === "point" && l.points) {
        const P = l.points;
        const S = sizes.get(l.id);
        const fixed = fixedRadius(cfgs.get(l.id)?.cfg ?? {}, P.lat.length);
        for (let i = 0; i < P.lat.length; i++) {
          const d = (p.px(P.lon[i]) - x) ** 2 + (p.py(P.lat[i]) - y) ** 2;
          if (d < bd && d <= Math.max(8, (S ? S.r[i] : fixed) + 3) ** 2) {
            bd = d;
            best = { layer: l, i };
          }
        }
      } else if (l.type === "cluster") {
        const rad = radii.get(l.id) ?? (() => 5);
        for (const c of merged.get(l.id) ?? []) {
          const d = (p.px(c.lon) - x) ** 2 + (p.py(c.lat) - y) ** 2;
          if (d < bd && d <= (rad(c) + 2) ** 2) {
            bd = d;
            best = { layer: l, cell: c };
          }
        }
      }
      return best;
    });
  }, [p, layers, cfgs, hidden, merged, radii, sizes, onHit]);
  return <canvas ref={ref} aria-label="Map layers" data-layers={layers.map((l) => l.id).join(" ")} className="pointer-events-none block" style={{ width: p.w, height: p.h }} />;
}

function Legend({ legend, name }: { legend?: ColorLegend; name?: string }) {
  if (!legend) return null;
  if (legend.kind === "scale")
    return (
      <span className="flex items-center gap-1">
        {name && <span>{name}:</span>}
        {fmt(legend.min)} <span className="inline-block h-2 w-16" style={{ background: SCALE_CSS }} /> {fmt(legend.max)}
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {name && <span>{name}:</span>}
      {legend.values.map((v, i) => (
        <span key={String(v)} className="flex items-center gap-1" title={`${fmt(legend.counts[i])} rows`}>
          <span className="h-2 w-2 rounded-full" style={{ background: CATEGORY[i % CATEGORY.length] }} />
          {v ?? "(empty)"}
        </span>
      ))}
      {legend.distinct > legend.values.length && (
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: OTHER }} />Other ({legend.distinct - legend.values.length})</span>
      )}
    </span>
  );
}

/** A size-by-column legend: the scale's steps as discs of their upper bound's radius, with the rows in each. */
function SizeLegend({ s }: { s: MapSizeLegend }) {
  const scale = SCALES.find((x) => x[0] === s.scale)?.[1] ?? s.scale;
  return (
    <span className="flex flex-wrap items-center gap-x-2" aria-label="Size legend">
      <span>{s.column ?? "size"} ({scale}):</span>
      {s.bins.map((b, i) => {
        const r = sizeRadius(s, b.hi);
        return (
          <span key={i} className="flex items-center gap-1" title={`${fmt(b.n)} rows`}>
            <svg width={2 * r + 2} height={2 * r + 2}><circle cx={r + 1} cy={r + 1} r={r} fill="none" stroke="currentColor" /></svg>
            {fmt(b.lo)}–{fmt(b.hi)} ({fmt(b.n)})
          </span>
        );
      })}
      {s.missing > 0 && <span title={s.scale === "log" ? "empty, not finite or <= 0" : s.scale === "sqrt" ? "empty, not finite or < 0" : "empty or not finite"}>{fmt(s.missing)} without a size (smallest)</span>}
    </span>
  );
}

/** The result of a Quiver card / CSV form (rows of lat, lon, label) as one point layer. */
function rowsAsLayer(rows: Record<string, unknown>[]): MapLayerResult {
  const ok = rows.filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)) && r.lat !== null && r.lon !== null);
  return { id: "l1", type: "point", total: ok.length, points: { lat: ok.map((r) => Number(r.lat)), lon: ok.map((r) => Number(r.lon)), tooltip: ok.map((r) => (r.label === undefined || r.label === null ? null : String(r.label))) } };
}

/** The board's initial viewport when it is set (Format: "initial viewport"), else null (zoom to fit). */
function initialView(c: BoardConfig): { lat: number; lon: number; zoom: number } | null {
  const v = c.view;
  if (c.viewport !== "initial" || !v) return null;
  const lat = Number(v.lat), lon = Number(v.lon), zoom = Number(v.zoom);
  if (![lat, lon, zoom].every(Number.isFinite)) return null;
  return { lat: Math.max(-85, Math.min(85, lat)), lon: Math.max(-180, Math.min(180, lon)), zoom: Math.max(1, Math.min(19, Math.round(zoom))) };
}

export function MapView({ r, config, selection, onSelection, boardId }: {
  r: BoardResult;
  config: BoardConfig;
  selection?: unknown[] | null;
  onSelection?: (s: unknown[] | null) => void;
  /** the board's id: its last view is kept for "use the current view" in the settings */
  boardId?: string;
}) {
  const cfgList = useMemo(() => mapLayers(config), [config]);
  // in the settings' order (the drawing order) right away, before the rerun brings the layers back in that order
  const layers = useMemo(() => {
    const ls = r.map?.layers ?? [rowsAsLayer(r.data ?? [])];
    const order = new Map(cfgList.map((l, i) => [String(l.id), i]));
    return [...ls].sort((a, b) => (order.get(a.id) ?? ls.length + 1e6) - (order.get(b.id) ?? ls.length + 1e6));
  }, [r, cfgList]);
  const cfgs = useMemo(() => new Map(cfgList.map((l, i) => [String(l.id), { cfg: l, i }])), [cfgList]);
  const [basemap, setBasemap] = useState<Basemap>((config.basemap as Basemap) ?? "google-satellite");
  const [hiddenSet, setHidden] = useState<Set<string>>(new Set());
  const [draw, setDraw] = useState<"polygon" | "circle" | "box" | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; w: number; text: string[] } | null>(null);
  const [boxDrag, setBoxDrag] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const handle = useRef<MapHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const proj = useRef<Projection | null>(null);
  // each canvas layer's hit test (layer id → test), registered by its LayerCanvas
  const hits = useRef(new Map<string, HitTest>());
  const stack = useMemo(() => layerStack(layers), [layers]);
  const down = useRef<[number, number] | null>(null);
  const justDrew = useRef(false);
  const bounds = useMemo(() => dataBounds(layers), [layers]);
  const initial = initialView(config);
  const initialKey = initial ? `${initial.lat},${initial.lon},${initial.zoom}` : "fit";
  const sel = (selection ?? []).filter(isSel);
  const selKeys = new Set(sel.map(keyOf));
  // shapes selected by a box / polygon: layer → keys
  const boxed = new Map<string, Set<string>>();
  for (const s of sel)
    if (s.kind === "shapes" && Array.isArray(s.keys)) {
      const k = boxed.get(String(s.layer)) ?? new Set<string>();
      (s.keys as unknown[]).forEach((x) => k.add(String(x)));
      boxed.set(String(s.layer), k);
    }
  const legendShown = config.legend !== "hidden";
  const togglable = config.layer_toggle !== false;
  // without layer toggles (or with the legend hidden) every layer is drawn
  const hidden = useMemo(() => (togglable && legendShown ? hiddenSet : new Set<string>()), [togglable, legendShown, hiddenSet]);
  // fit to the data when its extent changes (after the canvas has measured itself), unless a viewport is set; a rerun
  // with the same extent (a selection on this board reruns it) keeps the user's pan and zoom
  const fitAuto = !initial;
  const boundsKey = bounds ? bounds.join(",") : "";
  const fitTo = useMemo(() => (boundsKey ? (boundsKey.split(",").map(Number) as Bounds) : null), [boundsKey]);
  useEffect(() => {
    if (!fitAuto) return;
    const t = setTimeout(() => handle.current?.fit(fitTo), 60);
    return () => clearTimeout(t);
  }, [fitTo, fitAuto]);

  /** A drawn box / polygon: the ring as a polygon selection (point layers) plus the shapes it touches per shape layer. */
  const selectRing = (ring: number[][]) => {
    if (!onSelection) return;
    const add: Sel[] = [{ kind: "polygon", coordinates: [ring] }];
    for (const l of layers) {
      const cfg = cfgs.get(l.id)?.cfg ?? {};
      if (l.error || !l.shapes || cfg.source || hidden.has(l.id)) continue;
      const keys = [...new Set(l.shapes.filter((s) => s.key && touchesRing(s.geometry, ring)).map((s) => s.key!))];
      if (keys.length) add.push({ kind: "shapes", layer: l.id, keys });
    }
    onSelection([...sel, ...add]);
  };

  const toggle = (s: Sel) => {
    if (!onSelection) return;
    const k = keyOf(s);
    const next = selKeys.has(k) ? sel.filter((x) => keyOf(x) !== k) : [...sel, s];
    onSelection(next.length ? next : null);
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const b = box.current!.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top] as [number, number];
  };
  /** Where the map's own area starts inside the box (its border), for screen → map positions. */
  const mapOffset = (): [number, number] => {
    const b = box.current?.getBoundingClientRect();
    const m = (box.current?.querySelector("g[data-map-root]") as SVGGElement | null)?.ownerSVGElement?.getBoundingClientRect();
    return b && m ? [m.left - b.left, m.top - b.top] : [0, 0];
  };
  /** The topmost layer under the pointer, in drawing order: an SVG element of a shape layer (the element the pointer
   * is on) or a canvas layer's point / cluster; a layer drawn above another covers it for clicks and hovers too. */
  const pick = (e: { target: EventTarget | null; clientX: number; clientY: number }): Hit | null => {
    const [lx, ly] = local(e);
    const [ox, oy] = mapOffset();
    const t = e.target instanceof Element ? e.target : null;
    const dom = t?.closest("[data-lid]")?.getAttribute("data-lid") ?? null;
    for (let k = layers.length - 1; k >= 0; k--) {
      const l = layers[k];
      if (l.error || hidden.has(l.id)) continue;
      if (dom !== null && l.id === dom && !onCanvas(l)) return { layer: l, el: t?.closest("[data-sel], [data-tip]") ?? undefined };
      const h = onCanvas(l) ? hits.current.get(l.id)?.(lx - ox, ly - oy) : null;
      if (h) return h;
    }
    return null;
  };
  const register = useCallback((id: string, f: HitTest) => void hits.current.set(id, f), []);
  const onProj = useCallback((q: Projection) => void (proj.current = q), []);
  const lname = (l: MapLayerResult) => {
    const cfg = cfgs.get(l.id)?.cfg ?? {};
    return cfg.name || `${LAYER_LABEL[l.type] ?? l.type}${cfg.source ? " (other source)" : ""}`;
  };

  /** One SVG layer (regions, GeoJSON shapes or lines): clickable elements carry `data-sel` (the selection item) and
   * `data-tip` (the hover tooltip's lines, as JSON). */
  const shapeLayer = (l: MapLayerResult, p: Projection): ReactNode => {
    const { cfg, i: idx } = cfgs.get(l.id) ?? { cfg: {}, i: 0 };
    const op = Number(cfg.opacity ?? 0.7);
    const selectable = !!onSelection && !cfg.source;
    const tip = (...xs: unknown[]) => {
      const lines = xs.filter((x) => x !== null && x !== undefined && x !== "").map(String);
      return JSON.stringify(lines.length ? lines : [lname(l)]);
    };
    if (l.regions) {
      const col = colorOf({ kind: "scale", min: l.min ?? null, max: l.max ?? null });
      const metric = cfg.metric ?? "count";
      return (
        <g key={l.id} data-lid={l.id}>
          {l.regions.map((g, i) => {
            const item: Sel = { kind: "region", layer: l.id, value: g.id === null || g.id === undefined ? null : String(g.id) };
            const on = selKeys.has(keyOf(item));
            // a region without rows is only a backdrop: it neither selects nor covers the layers below it
            return (
              <path key={i} d={pathOf(g.geometry, p)} fillRule="evenodd" data-sel={selectable && g.n ? keyOf(item) : undefined}
                data-tip={g.n ? tip(g.name ?? g.id, `${metric}${cfg.metric_column && metric !== "count" ? ` of ${cfg.metric_column}` : ""}: ${fmt(g.value)}`, `${fmt(g.n)} rows`) : undefined}
                pointerEvents={g.n ? undefined : "none"}
                fill={g.value === null ? "rgba(148,163,184,0.12)" : col(g.value)} fillOpacity={g.value === null ? 1 : op}
                stroke={on ? "#38bdf8" : "rgba(255,255,255,0.6)"} strokeWidth={on ? 2.5 : 0.8} className={selectable && g.n ? "cursor-pointer" : ""} />
            );
          })}
        </g>
      );
    }
    if (l.shapes) {
      const col = l.color ? colorOf(l.color) : () => singleColor(cfg, idx);
      const inBox = boxed.get(l.id);
      return (
        <g key={l.id} data-lid={l.id}>
          {l.shapes.map((s, i) => {
            const line = /LineString/.test(s.geometry.type);
            const item: Sel = { kind: "shape", layer: l.id, key: s.key };
            const can = selectable && !!s.key;
            const on = !!s.key && (selKeys.has(keyOf(item)) || !!inBox?.has(s.key));
            const d = pathOf(s.geometry, p);
            const t = tip(s.tooltip, s.value === null || s.value === undefined ? null : `${cfg.value_column ?? "value"}: ${fmt(s.value)}`);
            return (
              <g key={i} data-shape={s.key} data-on={on ? "1" : undefined}>
                <path d={d} fillRule="evenodd" fill={line ? "none" : col(s.value)} fillOpacity={op} stroke={on ? "#38bdf8" : line ? col(s.value) : "rgba(255,255,255,0.5)"}
                  strokeWidth={on ? (line ? 3.5 : 2.5) : line ? 2 : 0.6} data-sel={can && !line ? keyOf(item) : undefined} data-tip={t} className={can && !line ? "cursor-pointer" : ""} />
                {/* a line is clicked and hovered on a wider invisible stroke */}
                {line && <path d={d} fill="none" stroke="transparent" strokeWidth={10} data-sel={can ? keyOf(item) : undefined} data-tip={t} className={can ? "cursor-pointer" : ""} />}
              </g>
            );
          })}
        </g>
      );
    }
    if (l.lines) {
      const L = l.lines;
      const col = l.color ? colorOf(l.color) : () => singleColor(cfg, idx);
      return (
        <g key={l.id} data-lid={l.id}>
          {L.lat.map((la, i) => {
            const item: Sel = { kind: "line", layer: l.id, lat: la, lon: L.lon[i], lat2: L.lat2[i], lon2: L.lon2[i] };
            const on = selKeys.has(keyOf(item));
            return (
              <line key={i} x1={p.px(L.lon[i])} y1={p.py(la)} x2={p.px(L.lon2[i])} y2={p.py(L.lat2[i])} stroke={on ? "#38bdf8" : col(L.value?.[i])} strokeOpacity={on ? 1 : op}
                strokeWidth={on ? 3 : 1.5} data-sel={selectable ? keyOf(item) : undefined} className={selectable ? "cursor-pointer" : ""}
                data-tip={tip(L.tooltip?.[i], L.value ? `${cfg.value_column ?? "value"}: ${fmt(L.value[i])}` : null, `${fmt(la)}, ${fmt(L.lon[i])} → ${fmt(L.lat2[i])}, ${fmt(L.lon2[i])}`)} />
            );
          })}
        </g>
      );
    }
    return null;
  };

  const svg = (p: Projection): ReactNode => (
    <g data-map-root="">
      <ProjSink p={p} onProj={onProj} />
      {/* every layer in drawing order: canvas layers (points, clusters, heatmaps) in a foreignObject between the SVG
          layers, so the order holds across both kinds */}
      {stack.map((s) => {
        if (s.canvas)
          return (
            <foreignObject key={`c-${s.key}`} x={0} y={0} width={p.w} height={p.h} pointerEvents="none">
              <LayerCanvas p={p} layers={s.layers} cfgs={cfgs} hidden={hidden} onHit={register} />
            </foreignObject>
          );
        const l = s.layers[0];
        return l.error || hidden.has(l.id) ? null : shapeLayer(l, p);
      })}
      {/* the selection: clicked points, drawn circles, polygons and boxes */}
      {sel.map((s, i) => {
        if (s.kind === "point") return <circle key={i} cx={p.px(Number(s.lon))} cy={p.py(Number(s.lat))} r={7} fill="none" stroke="#38bdf8" strokeWidth={2.5} className="pointer-events-none" />;
        if (s.kind === "circle") {
          const cy = p.py(Number(s.lat));
          const rr = Math.abs(p.py(Number(s.lat) + Number(s.radius_m) / 111320) - cy);
          return <circle key={i} cx={p.px(Number(s.lon))} cy={cy} r={rr} fill="rgba(56,189,248,0.12)" stroke="#38bdf8" strokeWidth={2} className="pointer-events-none" />;
        }
        if (s.kind === "polygon")
          return <path key={i} d={pathOf({ type: "Polygon", coordinates: s.coordinates }, p)} fill="rgba(56,189,248,0.12)" stroke="#38bdf8" strokeWidth={2} className="pointer-events-none" />;
        return null;
      })}
    </g>
  );

  const errors = layers.filter((l) => l.error);
  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        {onSelection && (
          <>
            <span className="text-muted">Select:</span>
            {(["circle", "polygon", "box"] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDraw(draw === d ? null : d)} className={`rounded border px-1.5 py-0.5 ${draw === d ? "border-ocean bg-ocean/20 text-white" : "border-line text-muted hover:text-white"}`}>
                {d === "circle" ? "Draw a circle" : d === "polygon" ? "Draw a polygon" : "Draw a box"}
              </button>
            ))}
            <span className="text-muted">or click points, regions, shapes and lines</span>
          </>
        )}
        <button type="button" onClick={() => handle.current?.fit(bounds)} className="ml-auto rounded border border-line px-1.5 py-0.5 text-muted hover:text-white">Fit to data</button>
      </div>
      {/* the line is kept while empty, so a first selection does not move the map under the pointer */}
      {(sel.length > 0 || onSelection) && (
        <p className="text-ocean" style={{ minHeight: 16 }}>
          {sel.length > 0 && (
            <>
              Selected ({config.selection_mode === "remove" ? "removed below" : "kept below"}):{" "}
              {Object.entries(sel.reduce<Record<string, number>>((a, s) => {
                const k = s.kind === "shapes" ? "shape" : s.kind;
                return { ...a, [k]: (a[k] ?? 0) + (s.kind === "shapes" && Array.isArray(s.keys) ? s.keys.length : 1) };
              }, {})).map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ")}
              {onSelection && <button type="button" onClick={() => onSelection(null)} className="ml-2 underline">clear</button>}
            </>
          )}
        </p>
      )}
      <div
        ref={box}
        className="relative flex h-96 overflow-hidden rounded border border-line"
        onPointerDownCapture={(e) => {
          down.current = local(e);
          if (draw !== "box" || e.button !== 0) return;
          // a box is dragged out here, before the map would pan
          e.stopPropagation();
          box.current?.setPointerCapture?.(e.pointerId);
          setBoxDrag({ a: local(e), b: local(e) });
        }}
        onPointerMoveCapture={(e) => {
          if (!boxDrag) return;
          e.stopPropagation();
          setBoxDrag({ ...boxDrag, b: local(e) });
        }}
        onPointerUpCapture={(e) => {
          if (!boxDrag) return;
          e.stopPropagation();
          const [x1, y1] = local(e);
          const [x0, y0] = boxDrag.a;
          setBoxDrag(null);
          setDraw(null);
          justDrew.current = true;
          const P = proj.current;
          if (!P || Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) return;
          const [ox, oy] = mapOffset();
          const [w, n] = P.unproject(Math.min(x0, x1) - ox, Math.min(y0, y1) - oy);
          const [east, s] = P.unproject(Math.max(x0, x1) - ox, Math.max(y0, y1) - oy);
          selectRing([[w, s], [east, s], [east, n], [w, n], [w, s]]);
        }}
        onClick={(e) => {
          if (justDrew.current) return void (justDrew.current = false);
          if (draw) return;
          const [x, y] = local(e);
          const d = down.current;
          if (d && Math.hypot(d[0] - x, d[1] - y) > 4) return;
          const h = pick(e);
          if (!h) return;
          if (h.el || (!h.cell && h.i === undefined)) {
            // an SVG layer's element is on top: it is clicked (when it selects anything), not what lies below it
            const raw = h.el?.getAttribute("data-sel");
            if (!raw) return;
            const item = JSON.parse(raw) as Sel;
            // a shape selected by a box: clicking it takes it out of the box's shapes
            if (item.kind === "shape" && boxed.get(String(item.layer))?.has(String(item.key)) && onSelection) {
              const next = sel
                .map((s) => (s.kind === "shapes" && s.layer === item.layer && Array.isArray(s.keys) ? { ...s, keys: s.keys.filter((k) => k !== item.key) } : s))
                .filter((s) => !(s.kind === "shapes" && Array.isArray(s.keys) && !s.keys.length) && keyOf(s) !== keyOf(item));
              return onSelection(next.length ? next : null);
            }
            return toggle(item);
          }
          if (h.cell) return h.cell.n > 1 && handle.current?.center(h.cell.lon, h.cell.lat, Math.min(19, handle.current.view().z + 2));
          const cfg = cfgs.get(h.layer.id)?.cfg ?? {};
          if (h.i !== undefined && h.layer.points && !cfg.source) toggle({ kind: "point", layer: h.layer.id, lat: h.layer.points.lat[h.i], lon: h.layer.points.lon[h.i] });
        }}
        onMouseMove={(e) => {
          if (draw) return setHover(null);
          const [x, y] = local(e);
          const w = box.current?.clientWidth ?? 400;
          const h = pick(e);
          if (!h) return setHover(null);
          if (h.el || (!h.cell && h.i === undefined)) {
            // a region, shape or line on top: its tooltip lines
            const raw = h.el?.getAttribute("data-tip");
            return setHover(raw ? { x, y, w, text: JSON.parse(raw) as string[] } : null);
          }
          if (h.cell) return setHover({ x, y, w, text: [`${fmt(h.cell.n)} rows`, ...(h.layer.metric && h.layer.metric !== "count" ? [`${h.layer.metric}: ${fmt(h.cell.value)}`] : [])] });
          const P = h.layer.points!;
          const i = h.i!;
          const S = h.layer.size;
          setHover({ x, y, w, text: [...(P.tooltip?.[i] ? [P.tooltip[i]!] : []), ...(P.color ? [fmt(P.color[i])] : []), ...(S && P.size ? [`${S.column ?? "size"}: ${fmt(P.size[i])}`] : []), `${fmt(P.lat[i])}, ${fmt(P.lon[i])}`] });
        }}
        onMouseLeave={() => setHover(null)}
      >
        <MapCanvas
          key={initialKey}
          basemap={basemap}
          onBasemap={setBasemap}
          handle={handle}
          initial={initial}
          onMove={boardId ? (_b, v) => lastMapView.set(boardId, v) : undefined}
          draw={draw === "box" ? null : draw}
          onDrawn={(d) => {
            setDraw(null);
            if (!d || !onSelection) return;
            if (d.circle) onSelection([...sel, { kind: "circle", ...d.circle }]);
            else if (d.polygon) selectRing(d.polygon.coordinates[0]);
          }}
        >
          {svg}
        </MapCanvas>
        {boxDrag && (
          <div aria-label="Box being drawn" className="pointer-events-none absolute z-10 border-2 border-ocean bg-ocean/10"
            style={{ left: Math.min(boxDrag.a[0], boxDrag.b[0]), top: Math.min(boxDrag.a[1], boxDrag.b[1]), width: Math.abs(boxDrag.b[0] - boxDrag.a[0]), height: Math.abs(boxDrag.b[1] - boxDrag.a[1]) }} />
        )}
        {draw === "box" && !boxDrag && (
          <p className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-panel/90 px-2 py-1 text-muted">Drag out a box: it selects the points inside and the shapes it touches.</p>
        )}
        {hover && (
          <div className="pointer-events-none absolute z-10 rounded border border-line bg-panel/95 px-2 py-1 shadow" style={{ left: Math.min(hover.x + 12, hover.w - 190), top: Math.max(0, hover.y - 10) }}>
            {hover.text.map((t, i) => <div key={i} className={i ? "text-muted" : ""}>{t}</div>)}
          </div>
        )}
      </div>
      <div className="space-y-0.5 text-muted">
        {layers.filter((l) => legendShown || l.error).map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-x-3" data-layer={l.id}>
            {togglable ? (
              <label className="flex items-center gap-1 text-soft">
                <input type="checkbox" checked={!hidden.has(l.id)} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} />
                {lname(l)}
              </label>
            ) : <span className="text-soft">{lname(l)}</span>}
            {l.error ? <span className="text-bad">{l.error}</span> : (
              <>
                {l.points && <span>{l.total !== undefined && l.total > l.points.lat.length ? `${fmt(l.points.lat.length)} of ${fmt(l.total)} points (the limit)` : `${fmt(l.points.lat.length)} points`}</span>}
                {l.size && <SizeLegend s={l.size} />}
                {l.cells && <span>{fmt(l.total ?? 0)} rows in {fmt(l.cells.gx?.length ?? 0)} cells{l.metric && l.metric !== "count" ? ` · ${l.metric}` : ""}{l.mergeable === false ? " (shown per cell: this metric does not merge)" : ""}</span>}
                {l.type === "cluster" && <span>size: {l.metric ?? "count"}, {SCALES.find((x) => x[0] === (cfgs.get(l.id)?.cfg.scaling ?? "sqrt"))?.[1] ?? "square root"}</span>}
                {l.type === "heatmap" && <span className="inline-block h-2 w-16" style={{ background: SCALE_CSS }} />}
                {l.regions && (
                  <>
                    <span>{fmt(l.matched ?? 0)} of {fmt(l.regions.length)} regions have rows</span>
                    <Legend legend={{ kind: "scale", min: l.min ?? null, max: l.max ?? null }} />
                    {!!l.unmatched_count && <span className="text-warn" title={l.unmatched?.join(", ")}>{fmt(l.unmatched_count)} region ids not in the boundaries file ({l.unmatched?.slice(0, 5).join(", ")}{(l.unmatched_count ?? 0) > 5 ? ", …" : ""})</span>}
                  </>
                )}
                {l.shapes && <span>{fmt(l.shapes.length)} shapes{l.invalid ? `, ${fmt(l.invalid)} not GeoJSON` : ""}</span>}
                {l.lines && <span>{fmt(l.lines.lat.length)} lines</span>}
                {!l.regions && <Legend legend={l.color} />}
              </>
            )}
          </div>
        ))}
        {errors.length === layers.length && !layers.length && <p>Add a layer.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ editor

function Col({ value, cols, onChange, empty = "Choose…", free }: { value?: string; cols: string[]; onChange: (v: string | undefined) => void; empty?: string; free?: boolean }) {
  if (free) return <input value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} placeholder={empty} className={`${small} w-32`} />;
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={`${small} w-32`}>
      <option value="">{empty}</option>
      {cols.map((c) => <option key={c}>{c}</option>)}
    </select>
  );
}

/** The Map board's settings: basemap, selection mode, viewport, legend and its layers. `sourcePicker` draws a source
 * choice; `boardId` lets "use the current view" read the board's map. */
export function MapEditor({ c, cols, set, sourcePicker, boardId }: {
  c: BoardConfig;
  cols: string[];
  set: (p: BoardConfig) => void;
  sourcePicker: (value: SourceRef | undefined, onChange: (s: SourceRef) => void) => ReactNode;
  boardId?: string;
}) {
  const [noView, setNoView] = useState(false);
  const view = (c.view ?? {}) as { lat?: number; lon?: number; zoom?: number };
  const setView = (p: { lat?: number; lon?: number; zoom?: number }) => set({ view: { ...view, ...p } });
  const numIn = (k: "lat" | "lon" | "zoom", label: string, min: number, max: number) => (
    <input type="number" aria-label={`Initial ${label}`} min={min} max={max} step={k === "zoom" ? 1 : "any"} value={view[k] ?? ""} placeholder={label}
      onChange={(e) => setView({ [k]: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${small} w-20`} />
  );
  const format = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1" title="The view when the map loads or its data changes">Viewport
        <select aria-label="Viewport" value={c.viewport === "initial" ? "initial" : "fit"} onChange={(e) => set({ viewport: e.target.value === "initial" ? "initial" : undefined })} className={`${small} w-36`}>
          <option value="fit">zoom to fit</option>
          <option value="initial">initial viewport</option>
        </select>
      </label>
      {c.viewport === "initial" && (
        <>
          {numIn("lat", "latitude", -85, 85)}
          {numIn("lon", "longitude", -180, 180)}
          {numIn("zoom", "zoom", 1, 19)}
          <button type="button" className="text-ocean hover:underline" onClick={() => {
            const v = boardId ? lastMapView.get(boardId) : undefined;
            setNoView(!v);
            if (v) set({ view: { lat: Number(v.lat.toFixed(5)), lon: Number(v.lon.toFixed(5)), zoom: Math.round(v.zoom) } });
          }}>Use the map&apos;s current view</button>
          {noView && <span className="text-warn">Run the board and move its map first.</span>}
        </>
      )}
      <label className="flex items-center gap-1"><input type="checkbox" aria-label="Show legend" checked={c.legend !== "hidden"} onChange={(e) => set({ legend: e.target.checked ? undefined : "hidden" })} />Show legend</label>
      <label className="flex items-center gap-1"><input type="checkbox" aria-label="Allow toggling layer visibility" checked={c.layer_toggle !== false} onChange={(e) => set({ layer_toggle: e.target.checked ? undefined : false })} />Allow toggling layer visibility</label>
    </div>
  );
  const layers = mapLayers(c);
  const [picking, setPicking] = useState<number | null>(null);
  const setLayers = (ls: BoardConfig[]) => set({ layers: ls, lat: undefined, lon: undefined, label: undefined });
  const setL = (i: number, p: BoardConfig) => setLayers(layers.map((l, j) => (j === i ? { ...l, ...p } : l)));
  // the drawing order is the layers' order in the board's config (the first at the bottom): dragged or moved here
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= layers.length || to >= layers.length) return;
    const ls = [...layers];
    const [x] = ls.splice(from, 1);
    ls.splice(to, 0, x);
    setLayers(ls);
  };
  const nid = () => {
    let n = layers.length + 1;
    while (layers.some((l) => l.id === `l${n}`)) n++;
    return `l${n}`;
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">Basemap
          <select value={c.basemap ?? "google-satellite"} onChange={(e) => set({ basemap: e.target.value })} className={`${small} w-28`}>
            {["streets", "google-satellite", "google-hybrid", "none"].map((b) => <option key={b} value={b}>{b === "google-satellite" ? "Satellite" : b === "google-hybrid" ? "Hybrid" : b}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1" title="What a selection on the map does to the boards below">Selection
          <select value={c.selection_mode ?? "filter"} onChange={(e) => set({ selection_mode: e.target.value === "remove" ? "remove" : undefined })} className={`${small} w-40`}>
            <option value="filter">keeps the selected rows</option>
            <option value="remove">removes the selected rows</option>
          </select>
        </label>
      </div>
      {format}
      {layers.length > 1 && <p className="text-[11px] text-muted">Layers are drawn in this order, the last one on top (points, clusters and heatmaps as well as shapes): drag a layer by its handle to reorder. A layer on top is the one hovered and clicked.</p>}
      {layers.map((l, i) => {
        const t = l.type ?? "point";
        const free = !!l.source;
        const C = (k: string, empty: string) => <Col value={l[k]} cols={cols} free={free} onChange={(v) => setL(i, { [k]: v })} empty={empty} />;
        const colorMode = (
          <select value={l.color_mode ?? "single"} onChange={(e) => setL(i, { color_mode: e.target.value })} className={`${small} w-28`} aria-label="Color">
            <option value="single">one color</option>
            <option value="value">by category</option>
            <option value="scale">on a scale</option>
          </select>
        );
        const metric = (
          <>
            <select value={l.metric ?? "count"} onChange={(e) => setL(i, { metric: e.target.value })} className={`${small} w-24`} aria-label="Metric">
              {METRICS.map((m) => <option key={m}>{m}</option>)}
            </select>
            {(l.metric ?? "count") !== "count" && C("metric_column", "of column…")}
          </>
        );
        return (
          <div key={l.id ?? i} data-layer-block={l.id} className={`space-y-1 rounded border p-2 ${over === i && dragging !== null && dragging !== i ? "border-ocean" : "border-line"} ${dragging === i ? "opacity-50" : ""}`}
            onDragOver={(e) => {
              if (dragging === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (over !== i) setOver(i);
            }}
            onDrop={(e) => {
              if (dragging === null) return;
              e.preventDefault();
              move(dragging, i);
              setDragging(null);
              setOver(null);
            }}>
            <div className="flex flex-wrap items-center gap-1">
              <span draggable aria-label="Drag to reorder the layer" title={`Layer ${i + 1} of ${layers.length}: drag to change the drawing order`} className="cursor-grab text-muted hover:text-white"
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(l.id ?? i));
                  setDragging(i);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}>
                <Icon name="dots" className="h-3.5 w-3.5 rotate-90" />
              </span>
              <span className="w-4 text-center text-muted" aria-label="Drawing order">{i + 1}</span>
              <select value={t} onChange={(e) => setL(i, { type: e.target.value })} className={`${small} w-28`} aria-label="Layer type">
                {LAYER_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input value={l.name ?? ""} onChange={(e) => setL(i, { name: e.target.value || undefined })} placeholder="layer name" className={`${small} w-32`} />
              <select value={l.source ? "other" : "current"} onChange={(e) => setL(i, { source: e.target.value === "other" ? l.source ?? null : undefined })} className={`${small} w-36`} aria-label="Data">
                <option value="current">the current rows</option>
                <option value="other">another source</option>
              </select>
              {(l.source !== undefined) && <div className="w-48">{sourcePicker(l.source ?? undefined, (s) => setL(i, { source: s }))}</div>}
              <span className="ml-auto flex gap-1">
                <button type="button" disabled={i === 0} onClick={() => move(i, i - 1)} className="text-muted hover:text-white disabled:opacity-30" aria-label="Move layer down (drawn earlier)" title="Move down (drawn earlier, under the next layers)">
                  <Icon name="left" className="h-3.5 w-3.5 rotate-90" />
                </button>
                <button type="button" disabled={i === layers.length - 1} onClick={() => move(i, i + 1)} className="text-muted hover:text-white disabled:opacity-30" aria-label="Move layer up (drawn later)" title="Move up (drawn later, over the layers before it)">
                  <Icon name="left" className="h-3.5 w-3.5 -rotate-90" />
                </button>
                <button type="button" onClick={() => setLayers(layers.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove layer"><Icon name="x" className="h-3.5 w-3.5" /></button>
              </span>
            </div>
            {free && <p className="text-[11px] text-muted">Type the other source&apos;s column names. Layers on another source are drawn but do not filter the boards below.</p>}
            <div className="flex flex-wrap items-center gap-1">
              {(t === "point" || t === "cluster" || t === "heatmap") && (
                <>
                  {C("lat", "latitude…")}
                  {C("lon", "longitude…")}
                </>
              )}
              {t === "point" && (
                <>
                  {colorMode}
                  {(l.color_mode ?? "single") === "single" ? (
                    <input type="color" value={l.color ?? CATEGORY[i % CATEGORY.length]} onChange={(e) => setL(i, { color: e.target.value })} className="h-6 w-8 rounded border border-line bg-transparent" aria-label="Color" />
                  ) : C("color_column", "color by…")}
                  {C("tooltip", "tooltip…")}
                  <select aria-label="Size" value={l.size_mode === "column" ? "column" : l.radius ? "radius" : l.size ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "column") setL(i, { size_mode: "column", radius: undefined });
                      else if (v !== "radius") setL(i, { size_mode: undefined, size: v || undefined, radius: undefined });
                    }} className={`${small} w-32`}>
                    <option value="">size: automatic</option>
                    {SIZE_PRESETS.map(([k, label]) => <option key={k} value={k}>size: {label}</option>)}
                    {!!l.radius && l.size_mode !== "column" && <option value="radius">size: {l.radius} px</option>}
                    <option value="column">size by a column</option>
                  </select>
                  {l.size_mode === "column" && (
                    <>
                      {C("size_column", "size column…")}
                      <select aria-label="Size scale" value={l.size_scale ?? "linear"} onChange={(e) => setL(i, { size_scale: e.target.value })} className={`${small} w-28`}>
                        {SCALES.map(([k, v]) => <option key={k} value={k}>{v} scale</option>)}
                      </select>
                    </>
                  )}
                </>
              )}
              {t === "cluster" && (
                <>
                  {metric}
                  <select aria-label="Size scaling" title="How the clusters' size follows the aggregate" value={l.scaling ?? "sqrt"} onChange={(e) => setL(i, { scaling: e.target.value })} className={`${small} w-32`}>
                    {SCALES.map(([k, v]) => <option key={k} value={k}>size: {v}</option>)}
                  </select>
                  <select aria-label="Cluster color" value={l.color_mode ?? ((l.metric ?? "count") === "count" ? "single" : "scale")} onChange={(e) => setL(i, { color_mode: e.target.value })} className={`${small} w-28`}>
                    <option value="single">one color</option>
                    <option value="scale">scaled color</option>
                  </select>
                  {(l.color_mode ?? ((l.metric ?? "count") === "count" ? "single" : "scale")) === "single" && (
                    <input type="color" value={l.color ?? CATEGORY[i % CATEGORY.length]} onChange={(e) => setL(i, { color: e.target.value })} className="h-6 w-8 rounded border border-line bg-transparent" aria-label="Cluster single color" />
                  )}
                </>
              )}
              {t === "heatmap" && (
                <>
                  {metric}
                  <input type="number" min={4} max={60} value={l.radius ?? ""} onChange={(e) => setL(i, { radius: e.target.value ? Number(e.target.value) : undefined })} placeholder="blur px" className={`${small} w-20`} />
                </>
              )}
              {t === "choropleth" && (
                <>
                  <select value={l.choropleth_kind ?? "boundaries"} onChange={(e) => setL(i, { choropleth_kind: e.target.value })} className={`${small} w-44`} aria-label="Regions">
                    <option value="boundaries">regions from a boundaries file</option>
                    <option value="geojson">a GeoJSON column per row</option>
                  </select>
                  {(l.choropleth_kind ?? "boundaries") === "boundaries" ? (
                    <>
                      <button type="button" onClick={() => setPicking(i)} className={`${small} w-auto max-w-56 truncate text-left`} title="A GeoJSON FeatureCollection in Files">
                        {l.boundaries_name ?? (l.boundaries_item_id ? l.boundaries_item_id : "Boundaries file…")}
                      </button>
                      <input value={l.feature_key ?? ""} onChange={(e) => setL(i, { feature_key: e.target.value || undefined })} placeholder="region id property" className={`${small} w-32`} />
                      {C("region_column", "region id column…")}
                      {metric}
                    </>
                  ) : (
                    <>
                      {C("geometry_column", "GeoJSON column…")}
                      {colorMode}
                      {(l.color_mode ?? "single") !== "single" && C("value_column", "color by…")}
                      {C("tooltip", "tooltip…")}
                    </>
                  )}
                </>
              )}
              {t === "line" && (
                <>
                  <select value={l.line_kind ?? "points"} onChange={(e) => setL(i, { line_kind: e.target.value })} className={`${small} w-36`} aria-label="Lines">
                    <option value="points">start and end points</option>
                    <option value="geojson">a GeoJSON column</option>
                  </select>
                  {(l.line_kind ?? "points") === "points" ? (
                    <>
                      {C("lat", "start latitude…")}
                      {C("lon", "start longitude…")}
                      {C("lat2", "end latitude…")}
                      {C("lon2", "end longitude…")}
                    </>
                  ) : C("geometry_column", "GeoJSON column…")}
                  {colorMode}
                  {(l.color_mode ?? "single") !== "single" && C("value_column", "color by…")}
                  {C("tooltip", "tooltip…")}
                </>
              )}
              <label className="flex items-center gap-1 text-muted" title="Fill opacity, 0 (transparent) to 1 (opaque)">opacity
                <input type="range" min={0} max={1} step={0.05} aria-label="Opacity" value={l.opacity ?? (t === "heatmap" ? 0.85 : t === "point" || t === "cluster" ? 0.8 : 0.7)}
                  onChange={(e) => setL(i, { opacity: Number(e.target.value) })} className="w-20" />
                <span className="w-8">{fmt(l.opacity ?? (t === "heatmap" ? 0.85 : t === "point" || t === "cluster" ? 0.8 : 0.7))}</span>
              </label>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        {LAYER_TYPES.map(([k, v]) => (
          <button key={k} type="button" onClick={() => setLayers([...layers, { id: nid(), type: k }])} className="text-ocean hover:underline">+ {v}</button>
        ))}
      </div>
      {picking !== null && (
        <DrivePicker
          title="A GeoJSON boundaries file"
          canPick={(it) => (/\.(geo)?json$/i.test(it.name) ? null : "Choose a .geojson or .json file")}
          onPick={(it) => {
            setL(picking, { boundaries_item_id: it.id, boundaries_name: it.name });
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
