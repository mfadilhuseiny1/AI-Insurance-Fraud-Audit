/**
 * Pure geometry of the Workshop Map widget's shapes (no imports, so Node tests can load it): GeoJSON parsing, Web
 * Mercator, rings unwrapped across the antimeridian, antimeridian-safe bounds, SVG paths (simplified to the pixel,
 * culled to a window), hit tests (point in polygon with holes, distance to a line) and color bins.
 *
 * Shapes are "prepared" once: every position in Web Mercator world units (x = 0 at 180°W … 1 at 180°E, y = 0 at
 * 85.05°N … 1 at 85.05°S; x runs past 0 / 1 for a shape that crosses the antimeridian), so drawing and hit testing a
 * shape at a zoom level is a scale and an offset.
 */

export type Geom = { type: string; coordinates?: unknown; geometries?: Geom[] };
/** min lon, min lat, max lon, max lat; max lon is above 180 (or min lon below -180) for a box across the antimeridian */
export type Box = [number, number, number, number];

const LATLON = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const GEOM_TYPES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"]);
const parsed = new WeakMap<object, Geom | null>();

/** A geoshape value as a geometry: a GeoJSON object or its JSON string (a Feature / FeatureCollection is unwrapped;
 * a geopoint "lat,lon" string is a Point), or null. An object parses once (the result is kept per object). */
export function parseShape(v: unknown): Geom | null {
  let g: unknown = v;
  if (typeof g === "string") {
    const s = g.trim();
    const m = LATLON.exec(s);
    if (m) return { type: "Point", coordinates: [Number(m[2]), Number(m[1])] };
    if (!s.startsWith("{")) return null;
    try {
      g = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!g || typeof g !== "object") return null;
  if (parsed.has(g)) return parsed.get(g) ?? null;
  const o = g as { type?: unknown; geometry?: unknown; features?: { geometry?: unknown }[]; coordinates?: unknown; geometries?: unknown[] };
  let out: Geom | null = null;
  if (o.type === "Feature") out = parseShape(o.geometry);
  else if (o.type === "FeatureCollection")
    out = { type: "GeometryCollection", geometries: (Array.isArray(o.features) ? o.features : []).map((f) => parseShape(f?.geometry)).filter((x): x is Geom => !!x) };
  else if (o.type === "GeometryCollection") out = { type: "GeometryCollection", geometries: (Array.isArray(o.geometries) ? o.geometries : []).map(parseShape).filter((x): x is Geom => !!x) };
  else if (typeof o.type === "string" && GEOM_TYPES.has(o.type) && Array.isArray(o.coordinates)) out = { type: o.type, coordinates: o.coordinates };
  parsed.set(g, out);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Web Mercator in world units
// ------------------------------------------------------------------------------------------------

export const MAX_LAT = 85.05;
export const mercX = (lon: number) => (lon + 180) / 360;
export const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const lonOfX = (x: number) => x * 360 - 180;
export const latOfY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

type Pos = number[];
const isPos = (x: unknown): x is Pos => Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "number" && Number.isFinite(x[0]) && Number.isFinite(x[1]);

/**
 * A ring's (or line's) longitudes made continuous: a step of more than 180° between two vertices is taken the short
 * way round (across the antimeridian), so 179 → -179 becomes 179 → 181. A step of a full 360° (-180 → 180, the edge
 * of a box around the world) is not a crossing.
 */
export function unwrapLons(lons: number[]): number[] {
  const out: number[] = [];
  let shift = 0;
  for (let i = 0; i < lons.length; i++) {
    if (i) {
      const d = lons[i] - lons[i - 1];
      if (Math.abs(d) > 180 && Math.abs(d) < 360) shift += d > 0 ? -360 : 360;
    }
    out.push(lons[i] + shift);
  }
  return out;
}

/** The whole turns to add to `x` so it lands nearest to `near` (both in the same unit; `turn` is one world). */
export const turnsTo = (x: number, near: number, turn = 1) => Math.round((near - x) / turn) * turn + 0;

/** A flat run of world positions: x0, y0, x1, y1, … */
export type Run = number[];
export type Prepared = {
  /** polygons: each a list of rings (the exterior first, then its holes) */
  polys: Run[][];
  lines: Run[];
  /** points: x0, y0, x1, y1, … */
  points: Run;
  /** the box in world units (x0, y0, x1, y1; y0 is north), null without positions */
  box: [number, number, number, number] | null;
  /** number of positions */
  n: number;
};

const prepared = new WeakMap<Geom, Prepared>();

/**
 * A geometry in world units. Each ring and line is unwrapped across the antimeridian; holes follow their exterior, and
 * every further part (of a multi-geometry or collection) is moved by whole worlds next to the first part, so the two
 * halves of a shape split at 180° (RFC 7946) sit side by side.
 */
export function prepare(g: Geom): Prepared {
  const hit = prepared.get(g);
  if (hit) return hit;
  const out: Prepared = { polys: [], lines: [], points: [], box: null, n: 0 };
  let anchor: number | null = null;
  const run = (pts: unknown, near: number | null): { r: Run; mid: number } | null => {
    const ps = Array.isArray(pts) ? pts.filter(isPos) : [];
    if (!ps.length) return null;
    const xs = unwrapLons(ps.map((q) => q[0])).map(mercX);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of xs) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    const k = near === null ? 0 : turnsTo((lo + hi) / 2, near);
    const r: Run = [];
    ps.forEach((q, i) => r.push(xs[i] + k, mercY(q[1])));
    return { r, mid: (lo + hi) / 2 + k };
  };
  const grow = (r: Run) => {
    for (let i = 0; i < r.length; i += 2) {
      const b: [number, number, number, number] = out.box ?? [r[i], r[i + 1], r[i], r[i + 1]];
      out.box = [Math.min(b[0], r[i]), Math.min(b[1], r[i + 1]), Math.max(b[2], r[i]), Math.max(b[3], r[i + 1])];
    }
    out.n += r.length / 2;
  };
  const polygon = (rings: unknown) => {
    if (!Array.isArray(rings)) return;
    const ext = run(rings[0], anchor);
    if (!ext) return;
    if (anchor === null) anchor = ext.mid;
    const poly = [ext.r];
    for (const h of rings.slice(1)) {
      const hole = run(h, ext.mid);
      if (hole) poly.push(hole.r);
    }
    poly.forEach(grow);
    out.polys.push(poly);
  };
  const line = (pts: unknown) => {
    const l = run(pts, anchor);
    if (!l) return;
    if (anchor === null) anchor = l.mid;
    grow(l.r);
    out.lines.push(l.r);
  };
  const point = (q: unknown) => {
    const pt = run([q], anchor);
    if (!pt) return;
    if (anchor === null) anchor = pt.mid;
    grow(pt.r);
    out.points.push(pt.r[0], pt.r[1]);
  };
  const add = (x: Geom) => {
    const c = x.coordinates;
    switch (x.type) {
      case "Point":
        point(c);
        break;
      case "MultiPoint":
        if (Array.isArray(c)) c.forEach(point);
        break;
      case "LineString":
        line(c);
        break;
      case "MultiLineString":
        if (Array.isArray(c)) c.forEach(line);
        break;
      case "Polygon":
        polygon(c);
        break;
      case "MultiPolygon":
        if (Array.isArray(c)) c.forEach(polygon);
        break;
      case "GeometryCollection":
        (x.geometries ?? []).forEach(add);
        break;
    }
  };
  add(g);
  prepared.set(g, out);
  return out;
}

/** A single point (longitude, latitude) as a prepared shape. */
export function preparePoint(lon: number, lat: number): Prepared {
  const [x, y] = [mercX(lon), mercY(lat)];
  return { polys: [], lines: [], points: [x, y], box: [x, y, x, y], n: 1 };
}

/** What a geometry mostly is, for the legend swatch. */
export const kindOf = (p: Prepared): "shape" | "line" | "point" => (p.polys.length ? "shape" : p.lines.length ? "line" : "point");

/**
 * The bounds of shapes for "fit to data", safe across the antimeridian: every shape's own box is whole (a ring over
 * 180° is not split into the two edges of the world), and the boxes are joined in the frame where they are closer
 * together — around longitude 0 or around 180 — so objects on both sides of the antimeridian (Fiji, the Bering Strait)
 * give a narrow box with max lon above 180 instead of one around the world.
 */
export function boundsOf(shapes: Prepared[]): Box | null {
  const boxes = shapes.map((s) => s.box).filter((b): b is [number, number, number, number] => !!b);
  if (!boxes.length) return null;
  const join = (center: number) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const b of boxes) {
      const k = turnsTo((b[0] + b[2]) / 2, center);
      x0 = Math.min(x0, b[0] + k);
      x1 = Math.max(x1, b[2] + k);
    }
    return [x0, x1] as const;
  };
  const a = join(0.5); // around longitude 0
  const b = join(1); // around the antimeridian
  const [x0, x1] = b[1] - b[0] < a[1] - a[0] - 1e-12 ? b : a;
  const y0 = Math.min(...boxes.map((q) => q[1]));
  const y1 = Math.max(...boxes.map((q) => q[3]));
  return [lonOfX(x0), latOfY(y1), lonOfX(x1), latOfY(y0)];
}

/** The middle of a shape's box as [lon, lat] (where its label goes). */
export function anchorOf(p: Prepared): [number, number] | null {
  return p.box ? [lonOfX((p.box[0] + p.box[2]) / 2), latOfY((p.box[1] + p.box[3]) / 2)] : null;
}

// ------------------------------------------------------------------------------------------------
// drawing: a frame is a zoom level and where the world's corner is on screen
// ------------------------------------------------------------------------------------------------

/** s: pixels per world; ox, oy: the screen position of world (0, 0); w, h: the box drawn into. */
export type Frame = { s: number; ox: number; oy: number; w: number; h: number };

/** The frame of a projection (px / py from longitude / latitude to screen pixels at zoom z). */
export function frameOf(p: { z: number; w: number; h: number; px: (lon: number) => number; py: (lat: number) => number }): Frame {
  const s = 256 * 2 ** p.z;
  return { s, ox: p.px(-180), oy: p.py(0) - 0.5 * s, w: p.w, h: p.h };
}

/** The world copy (whole worlds to add to x) at which a shape is nearest to the middle of the frame. */
export function copyOf(p: Prepared, f: Frame): number {
  if (!p.box) return 0;
  return turnsTo((p.box[0] + p.box[2]) / 2, (f.w / 2 - f.ox) / f.s);
}

/** A run in screen pixels with vertices closer than `tol` to the last kept one dropped (the ends are kept). */
export function simplify(r: Run, f: Frame, k: number, tol: number): number[] {
  const out: number[] = [];
  const last = r.length - 2;
  for (let i = 0; i <= last; i += 2) {
    const x = (r[i] + k) * f.s + f.ox;
    const y = r[i + 1] * f.s + f.oy;
    const n = out.length;
    if (n && i < last && Math.abs(x - out[n - 2]) < tol && Math.abs(y - out[n - 1]) < tol) continue;
    out.push(x, y);
  }
  return out;
}

const num = (v: number) => String(Math.round(v * 10) / 10);
const pathOf = (pts: number[], close: boolean) => {
  let d = "";
  for (let i = 0; i < pts.length; i += 2) d += `${i ? "L" : "M"}${num(pts[i])},${num(pts[i + 1])}`;
  return d && close ? d + "Z" : d;
};

export type Drawn = { area: string; line: string; points: [number, number][] };

/**
 * A shape as SVG path data in a frame: areas (every ring of every polygon in one path, for the even-odd fill rule that
 * leaves the holes open), lines and points. Null when its box is more than `margin` pixels outside the frame (not
 * drawn). Vertices are simplified to `tol` pixels; a polygon smaller than that stays a one pixel square.
 */
export function drawShape(p: Prepared, f: Frame, opts: { tol?: number; margin?: number } = {}): Drawn | null {
  if (!p.box) return null;
  const tol = opts.tol ?? 0.6;
  const margin = opts.margin ?? 64;
  const k = copyOf(p, f);
  const bx0 = (p.box[0] + k) * f.s + f.ox;
  const bx1 = (p.box[2] + k) * f.s + f.ox;
  const by0 = p.box[1] * f.s + f.oy;
  const by1 = p.box[3] * f.s + f.oy;
  if (bx1 < -margin || bx0 > f.w + margin || by1 < -margin || by0 > f.h + margin) return null;
  const out: Drawn = { area: "", line: "", points: [] };
  for (const poly of p.polys) {
    const ext = simplify(poly[0], f, k, tol);
    if (ext.length < 8) {
      // too small to have three distinct corners at this zoom: a one pixel square where it is
      out.area += `M${num(ext[0])},${num(ext[1])}h1v1h-1Z`;
      continue;
    }
    out.area += pathOf(ext, true);
    for (const hole of poly.slice(1)) {
      const h = simplify(hole, f, k, tol);
      if (h.length >= 8) out.area += pathOf(h, true);
    }
  }
  for (const l of p.lines) out.line += pathOf(simplify(l, f, k, tol), false);
  for (let i = 0; i < p.points.length; i += 2) out.points.push([(p.points[i] + k) * f.s + f.ox, p.points[i + 1] * f.s + f.oy]);
  return out;
}

// ------------------------------------------------------------------------------------------------
// hit tests (in world units; `tol` is the pointer's reach in world units)
// ------------------------------------------------------------------------------------------------

/** Whether (x, y) is inside the rings by the even-odd rule: inside the exterior and not in a hole. */
export function pointInRings(rings: Run[], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i];
      const yi = r[2 * i + 1];
      const xj = r[2 * j];
      const yj = r[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The distance from (x, y) to the segment a–b. */
export function distToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** The distance from (x, y) to a line (Infinity for an empty one). */
export function distToLine(r: Run, x: number, y: number): number {
  if (r.length === 2) return Math.hypot(x - r[0], y - r[1]);
  let d = Infinity;
  for (let i = 0; i + 3 < r.length; i += 2) d = Math.min(d, distToSegment(x, y, r[i], r[i + 1], r[i + 2], r[i + 3]));
  return d;
}

/**
 * What of a shape is at world (x, y): one of its points or lines within `tol`, the inside of one of its polygons (not
 * a hole), or a polygon's outline within `tol`; null when nothing. x is taken at the shape's nearest world copy.
 */
export function hitShape(p: Prepared, x: number, y: number, tol: number): Hit["kind"] | null {
  return probe(p, x, y, tol)?.kind ?? null;
}

type Hit = { kind: "point" | "line" | "area" | "edge"; /** how far the pointer is from it (0 inside an area) */ dist: number };

function probe(p: Prepared, x: number, y: number, tol: number): Hit | null {
  const b = p.box;
  if (!b) return null;
  x += turnsTo(x, (b[0] + b[2]) / 2);
  if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) return null;
  let d = Infinity;
  for (let i = 0; i < p.points.length; i += 2) d = Math.min(d, Math.hypot(x - p.points[i], y - p.points[i + 1]));
  if (d <= tol) return { kind: "point", dist: d };
  d = Infinity;
  for (const l of p.lines) d = Math.min(d, distToLine(l, x, y));
  if (d <= tol) return { kind: "line", dist: d };
  for (const poly of p.polys) if (pointInRings(poly, x, y)) return { kind: "area", dist: 0 };
  d = Infinity;
  for (const poly of p.polys) for (const r of poly) d = Math.min(d, distToLine(r, x, y));
  return d <= tol ? { kind: "edge", dist: d } : null;
}

/** Whether the segment a–b meets the box x0..x1, y0..y1 (Liang–Barsky clipping). */
export function segmentInBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Whether a shape meets a box (world units x0, y0, x1, y1; y0 is north), for box selection: one of its points inside,
 * a line or ring crossing it, or the box wholly inside one of its polygons (not in a hole). The box is taken at the
 * world copy nearest the shape, so a box drawn over the antimeridian reaches shapes on both sides.
 */
export function shapeInBox(p: Prepared, b: Box): boolean {
  if (!p.box) return false;
  const k = turnsTo((b[0] + b[2]) / 2, (p.box[0] + p.box[2]) / 2);
  const [x0, x1] = [Math.min(b[0], b[2]) + k, Math.max(b[0], b[2]) + k];
  const [y0, y1] = [Math.min(b[1], b[3]), Math.max(b[1], b[3])];
  if (p.box[2] < x0 || p.box[0] > x1 || p.box[3] < y0 || p.box[1] > y1) return false;
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  for (let i = 0; i < p.points.length; i += 2) if (inside(p.points[i], p.points[i + 1])) return true;
  for (const r of [...p.lines, ...p.polys.flat()]) {
    if (r.length >= 2 && inside(r[0], r[1])) return true;
    for (let i = 0; i + 3 < r.length; i += 2) if (segmentInBox(r[i], r[i + 1], r[i + 2], r[i + 3], x0, y0, x1, y1)) return true;
  }
  // no outline crosses the box: it is wholly inside a polygon's area or wholly outside
  for (const poly of p.polys) if (pointInRings(poly, (x0 + x1) / 2, (y0 + y1) / 2)) return true;
  return false;
}

const boxArea = (p: Prepared) => (p.box ? (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]) : 0);
const RANK = { point: 0, line: 1, area: 2, edge: 3 } as const;

/**
 * The shape picked at world (x, y) among shapes in drawing order: points and lines before areas (they are small
 * targets drawn over areas), the nearest of them first; then the smallest area the pointer is inside (a district
 * inside a province stays reachable whatever the order); then the nearest outline within reach. Among equals, the one
 * drawn last. -1 when nothing is there.
 */
export function pickShape(shapes: Prepared[], x: number, y: number, tol: number): number {
  let best = -1;
  let bestRank = Infinity;
  let bestScore = Infinity;
  shapes.forEach((p, i) => {
    const h = probe(p, x, y, tol);
    if (!h) return;
    const rank = RANK[h.kind];
    const score = h.kind === "area" ? boxArea(p) : h.dist;
    if (rank < bestRank || (rank === bestRank && score <= bestScore)) {
      best = i;
      bestRank = rank;
      bestScore = score;
    }
  });
  return best;
}

// ------------------------------------------------------------------------------------------------
// color bins (a stepped color scale: choropleth classes)
// ------------------------------------------------------------------------------------------------

const rgb = (c: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

/** The color at t in [0, 1] between two hex colors (another CSS color: the nearer end). */
export function mix(from: string, to: string, t: number): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const [a, b] = [rgb(from), rgb(to)];
  if (!a || !b) return f < 0.5 ? from : to;
  return "#" + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("");
}

export const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export type BinScale = "linear" | "sqrt" | "log" | "quantile";
export type Bin = { min: number; max: number; color: string; label: string; count: number };
export type Bins = { bins: Bin[]; index: (v: unknown) => number; color: (v: unknown) => string | null };

const fmtNum = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 100) / 100));

/**
 * Numeric values in `count` color classes between two colors. The class edges are even on the scale: linear, square
 * root or logarithmic (for skewed values; over the distance from the lowest value when values are not all positive),
 * or quantiles (the same number of values per class; equal edges collapse). A class holds min ≤ v < max, the last one
 * also its max; values outside a fixed min / max go to the first / last class. Not a number: no class (index -1).
 */
export function colorBins(values: unknown[], opts: { count?: number; scale?: BinScale; from?: string; to?: string; min?: number; max?: number } = {}): Bins {
  const nums = values.map(toNumber).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const none: Bins = { bins: [], index: () => -1, color: () => null };
  if (!nums.length) return none;
  const lo = Number.isFinite(opts.min) ? Number(opts.min) : nums[0];
  const hi = Number.isFinite(opts.max) ? Number(opts.max) : nums[nums.length - 1];
  if (!(hi >= lo)) return none;
  const want = Math.max(1, Math.min(12, Math.round(opts.count ?? 5)));
  const scale = opts.scale ?? "linear";
  let edges: number[];
  if (hi === lo) edges = [lo, hi];
  else if (scale === "quantile") {
    const inside = nums.filter((n) => n >= lo && n <= hi);
    const src = inside.length ? inside : nums;
    const qs = Array.from({ length: want + 1 }, (_, i) => src[Math.min(src.length - 1, Math.floor((i * (src.length - 1)) / want))]);
    qs[0] = lo;
    qs[want] = hi;
    edges = qs.filter((e, i) => i === 0 || e > qs[i - 1]);
  } else {
    const off = scale === "log" && lo <= 0 ? 1 - lo : 0;
    const t = scale === "sqrt" ? (v: number) => Math.sqrt(v - lo) : scale === "log" ? (v: number) => Math.log(v + off) : (v: number) => v;
    const inv = scale === "sqrt" ? (u: number) => u * u + lo : scale === "log" ? (u: number) => Math.exp(u) - off : (u: number) => u;
    const [a, b] = [t(lo), t(hi)];
    edges = Array.from({ length: want + 1 }, (_, i) => (i === 0 ? lo : i === want ? hi : inv(a + ((b - a) * i) / want)));
  }
  const n = edges.length - 1;
  const from = opts.from ?? "#fde68a";
  const to = opts.to ?? "#b91c1c";
  const bins: Bin[] = Array.from({ length: n }, (_, i) => ({
    min: edges[i],
    max: edges[i + 1],
    color: mix(from, to, n === 1 ? 0.5 : i / (n - 1)),
    label: edges[i] === edges[i + 1] ? fmtNum(edges[i]) : `${fmtNum(edges[i])} – ${fmtNum(edges[i + 1])}`,
    count: 0,
  }));
  const index = (v: unknown) => {
    const x = toNumber(v);
    if (x === null) return -1;
    if (x <= lo) return 0;
    if (x >= hi) return n - 1;
    let i = 0;
    while (i < n - 1 && x >= edges[i + 1]) i++;
    return i;
  };
  for (const v of values) {
    const i = index(v);
    if (i >= 0) bins[i].count++;
  }
  return { bins, index, color: (v) => (index(v) >= 0 ? bins[index(v)].color : null) };
}
