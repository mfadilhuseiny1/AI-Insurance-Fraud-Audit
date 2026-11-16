/**
 * Label placement for vector tile features (no imports, so Node tests can load it): an anchor per feature in screen
 * pixels (a point, the middle of a line, a point inside a polygon) and a greedy, collision-avoiding placement —
 * candidates by priority (points, then larger polygons, then longer lines), each tried at a few positions around its
 * anchor and dropped when every position overlaps a label already placed or leaves the view.
 */

export type Pt = [number, number];
export type LabelCandidate = {
  id: string;
  text: string;
  /** point: the label goes beside the symbol (radius r); area / line: centred on the anchor */
  kind: "point" | "area" | "line";
  x: number;
  y: number;
  r?: number;
  /** larger first (ties keep their order) */
  priority: number;
  /** area / line: the room the feature has on screen (width of a polygon, length of a line); the label must fit loosely */
  room?: number;
};
export type PlacedLabel = { id: string; text: string; x: number; y: number; w: number; h: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** Signed area (shoelace) of a closed ring in screen pixels. */
export function ringArea(r: Pt[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return s / 2;
}

/** Is p inside the ring (even-odd)? */
export function inRing(p: Pt, r: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A point inside a polygon (outer ring + holes) for its label: the centroid when it is inside (and not in a hole),
 * else the middle of the widest inside span on the horizontal line through the centroid (then through the middle of
 * the bounding box). Also the polygon's area and width in pixels. Null for degenerate rings.
 */
export function polygonAnchor(rings: Pt[][]): { x: number; y: number; area: number; width: number } | null {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;
  const a = ringArea(outer);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of outer) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const area = Math.abs(a) - rings.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);
  if (!(Math.abs(a) > 0)) return null;
  const width = x1 - x0;
  let cx = 0, cy = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const f = outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1];
    cx += (outer[j][0] + outer[i][0]) * f;
    cy += (outer[j][1] + outer[i][1]) * f;
  }
  cx /= 6 * a;
  cy /= 6 * a;
  const inside = (p: Pt) => inRing(p, outer) && !rings.slice(1).some((h) => inRing(p, h));
  if (Number.isFinite(cx) && Number.isFinite(cy) && inside([cx, cy])) return { x: cx, y: cy, area, width };
  for (const y of [cy, (y0 + y1) / 2]) {
    if (!Number.isFinite(y)) continue;
    const xs: number[] = [];
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i];
        const [xj, yj] = r[j];
        if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    xs.sort((p, q) => p - q);
    let best: [number, number] | null = null;
    for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
    if (best) return { x: (best[0] + best[1]) / 2, y, area, width };
  }
  return null;
}

/** The point half-way along a polyline, and its length (pixels). */
export function lineAnchor(pts: Pt[]): { x: number; y: number; length: number } | null {
  if (pts.length < 2) return null;
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const length = seg.reduce((s, d) => s + d, 0);
  if (!(length > 0)) return null;
  let left = length / 2;
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i]) {
      const t = seg[i] ? left / seg[i] : 0;
      return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, length };
    }
    left -= seg[i];
  }
  const last = pts[pts.length - 1];
  return { x: last[0], y: last[1], length };
}

export const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** A rough text width when no canvas is around (Node, tests): 0.6 em per character. */
export const roughWidth = (text: string, fontSize = 11) => text.length * fontSize * 0.6;

/**
 * Place labels without overlaps: candidates by priority, each at its first free position (points: right, left,
 * above, below their symbol; areas: centred, else a line above / below; lines: centred; areas / lines only when the
 * label is no wider than twice the feature's room).
 * Labels must lie inside the view (width × height). At most `max` labels.
 */
export function placeLabels(
  cands: LabelCandidate[],
  opts: { width: number; height: number; fontSize?: number; padding?: number; max?: number; measure?: (text: string) => number; obstacles?: Box[] },
): PlacedLabel[] {
  const fs = opts.fontSize ?? 11;
  const pad = opts.padding ?? 2;
  const max = opts.max ?? 400;
  const measure = opts.measure ?? ((t: string) => roughWidth(t, fs));
  const h = Math.ceil(fs * 1.3);
  const placed: PlacedLabel[] = [];
  const boxes: Box[] = [];
  // a coarse grid of the placed boxes, so each test looks at a few neighbours only
  const CELL = 64;
  const grid = new Map<string, number[]>();
  const cells = (b: Box) => {
    const out: string[] = [];
    for (let gx = Math.floor(b.x0 / CELL); gx <= Math.floor(b.x1 / CELL); gx++) for (let gy = Math.floor(b.y0 / CELL); gy <= Math.floor(b.y1 / CELL); gy++) out.push(`${gx},${gy}`);
    return out;
  };
  // point symbols are obstacles too: a label never covers another feature's point
  for (const b of opts.obstacles ?? []) {
    const i = boxes.push(b) - 1;
    for (const k of cells(b)) grid.set(k, [...(grid.get(k) ?? []), i]);
  }
  const free = (b: Box) => {
    if (b.x0 < 0 || b.y0 < 0 || b.x1 > opts.width || b.y1 > opts.height) return false;
    for (const c of cells(b)) for (const i of grid.get(c) ?? []) if (overlaps(b, boxes[i])) return false;
    return true;
  };
  const order = cands.map((c, i) => [c, i] as const).sort((a, b) => b[0].priority - a[0].priority || a[1] - b[1]);
  const seen = new Set<string>();
  for (const [c] of order) {
    if (placed.length >= max) break;
    if (!c.text || seen.has(c.id) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const w = Math.ceil(measure(c.text)) + 2 * pad;
    if ((c.kind === "area" || c.kind === "line") && c.room !== undefined && w > c.room * 2) continue;
    const gap = (c.r ?? 0) + 3;
    const centres: Pt[] =
      c.kind === "point"
        ? [
            [c.x + gap + w / 2, c.y],
            [c.x - gap - w / 2, c.y],
            [c.x, c.y - gap - h / 2],
            [c.x, c.y + gap + h / 2],
          ]
        : c.kind === "area"
          ? [
              [c.x, c.y],
              [c.x, c.y - h * 1.5],
              [c.x, c.y + h * 1.5],
            ]
          : [[c.x, c.y]];
    for (const [x, y] of centres) {
      const b = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
      if (!free(b)) continue;
      const i = boxes.push(b) - 1;
      for (const k of cells(b)) grid.set(k, [...(grid.get(k) ?? []), i]);
      placed.push({ id: c.id, text: c.text, x, y, w, h });
      seen.add(c.id);
      break;
    }
  }
  return placed;
}
