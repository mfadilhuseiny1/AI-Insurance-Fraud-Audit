// Geometry of the Image annotation widget (ImageAnnotation.tsx): what the annotation object's box property stores (a
// JSON string, fractions of the image or PDF page) and the pure functions drawing, picking and editing it.
//   rectangle  {"x", "y", "w", "h"[, "page"]}            (no type: the format rectangles always had)
//   polygon    {"type": "polygon", "points": [[x, y], …][, "page"]}
//   point      {"type": "point", "x", "y"[, "page"]}
//   text span  {"type": "text", "page", "start", "end", "quote", "boxes": [{"x", "y", "w", "h"}, …]}
//   cells      {"sheet", "range": "B2:C4"}               (spreadsheets)

/** a box as fractions of the image (or of the PDF page, zero-based) */
export type Box = { x: number; y: number; w: number; h: number; page?: number };
export type Rect = { type: "rect" } & Box;
export type Poly = { type: "polygon"; points: [number, number][]; page?: number };
export type Pt = { type: "point"; x: number; y: number; page?: number };
/** a text span on a PDF page: pdfium character offsets [start, end), the quoted text and its line boxes */
export type Span = { type: "text"; page: number; start: number; end: number; quote: string; boxes?: { x: number; y: number; w: number; h: number }[] };
export type Shape = Rect | Poly | Pt | Span;
export type XY = { x: number; y: number };

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const clamp = (n: number) => Math.min(1, Math.max(0, n));
/** the smallest side a resized rectangle keeps (fractions) */
export const MIN_SIDE = 0.005;

/** Any stored annotation geometry: rectangles keep their {x, y, w, h} format; polygons, points and text spans carry a type. */
export const parseShape = (v: unknown): Shape | null => {
  try {
    const b = typeof v === "string" ? JSON.parse(v) : v;
    if (!b || typeof b !== "object") return null;
    const page = num(b.page) ? { page: b.page } : {};
    if (b.type === "polygon")
      return Array.isArray(b.points) && b.points.length >= 3 && b.points.every((p: unknown) => Array.isArray(p) && num(p[0]) && num(p[1]))
        ? { type: "polygon", points: b.points.map((p: number[]) => [p[0], p[1]]), ...page }
        : null;
    if (b.type === "point") return num(b.x) && num(b.y) ? { type: "point", x: b.x, y: b.y, ...page } : null;
    if (b.type === "text")
      return num(b.page) && num(b.start) && num(b.end)
        ? {
            type: "text",
            page: b.page,
            start: b.start,
            end: b.end,
            quote: typeof b.quote === "string" ? b.quote : "",
            boxes: Array.isArray(b.boxes) ? b.boxes.filter((x: Box) => x && [x.x, x.y, x.w, x.h].every(num)).map((x: Box) => ({ x: x.x, y: x.y, w: x.w, h: x.h })) : undefined,
          }
        : null;
    if (b.type !== undefined && b.type !== "rect") return null;
    return [b.x, b.y, b.w, b.h].every(num) ? { type: "rect", x: b.x, y: b.y, w: b.w, h: b.h, ...page } : null;
  } catch {
    return null;
  }
};

/** what the box property stores (rectangles exactly as before: {x, y, w, h[, page]}) */
export const serialize = (s: Shape): string => {
  const page = s.page !== undefined ? { page: s.page } : {};
  if (s.type === "rect") return JSON.stringify({ x: r4(s.x), y: r4(s.y), w: r4(s.w), h: r4(s.h), ...page });
  if (s.type === "polygon") return JSON.stringify({ type: "polygon", points: s.points.map(([x, y]) => [r4(x), r4(y)]), ...page });
  if (s.type === "point") return JSON.stringify({ type: "point", x: r4(s.x), y: r4(s.y), ...page });
  return JSON.stringify({ type: "text", page: s.page, start: s.start, end: s.end, quote: s.quote, boxes: (s.boxes ?? []).map((b) => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) })) });
};

export const pageOf = (s: Shape) => s.page ?? 0;

/** the shape moved by (dx, dy), kept whole inside the image (text spans do not move: they follow their text) */
export const moved = (s: Shape, dx: number, dy: number): Shape => {
  if (s.type === "rect") return { ...s, x: clamp(Math.min(1 - s.w, s.x + dx)), y: clamp(Math.min(1 - s.h, s.y + dy)) };
  if (s.type === "point") return { ...s, x: clamp(s.x + dx), y: clamp(s.y + dy) };
  if (s.type === "polygon") {
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    const ddx = Math.min(Math.max(dx, -Math.min(...xs)), 1 - Math.max(...xs));
    const ddy = Math.min(Math.max(dy, -Math.min(...ys)), 1 - Math.max(...ys));
    return { ...s, points: s.points.map(([x, y]) => [clamp(x + ddx), clamp(y + ddy)]) };
  }
  return s;
};

/** a rectangle with the edges named by the handle ("nw", "e", …) dragged to p: inside the image, at least MIN_SIDE wide
 * and tall; dragging an edge past the opposite one flips the rectangle */
export const resized = (s: Rect, handle: string, p: XY): Rect => {
  let [x1, y1, x2, y2] = [s.x, s.y, s.x + s.w, s.y + s.h];
  if (handle.includes("w")) x1 = clamp(p.x);
  if (handle.includes("e")) x2 = clamp(p.x);
  if (handle.includes("n")) y1 = clamp(p.y);
  if (handle.includes("s")) y2 = clamp(p.y);
  const w = Math.max(MIN_SIDE, Math.abs(x2 - x1));
  const h = Math.max(MIN_SIDE, Math.abs(y2 - y1));
  return { ...s, x: Math.min(Math.min(x1, x2), 1 - w), y: Math.min(Math.min(y1, y2), 1 - h), w, h };
};

/** a polygon with one vertex moved to p (inside the image) */
export const vertexMoved = (s: Poly, index: number, p: XY): Poly => ({ ...s, points: s.points.map((q, i) => (i === index ? [clamp(p.x), clamp(p.y)] : q)) });

/** a polygon without one vertex (a polygon keeps at least three) */
export const vertexRemoved = (s: Poly, index: number): Poly => (s.points.length <= 3 ? s : { ...s, points: s.points.filter((_, i) => i !== index) });

/** where a shape's label goes (fractions) */
export const anchor = (s: Shape, located?: Box[]): XY | null => {
  if (s.type === "rect" || s.type === "point") return { x: s.x, y: s.y };
  if (s.type === "polygon") {
    const top = s.points.reduce((a, b) => (b[1] < a[1] ? b : a));
    return { x: top[0], y: top[1] };
  }
  const b = (s.boxes?.length ? s.boxes : located ?? [])[0];
  return b ? { x: b.x, y: b.y } : null;
};

const inBox = (b: { x: number; y: number; w: number; h: number }, p: XY, tol: XY) => p.x >= b.x - tol.x && p.x <= b.x + b.w + tol.x && p.y >= b.y - tol.y && p.y <= b.y + b.h + tol.y;

/** even-odd ray casting: p inside the polygon */
export const inPolygon = (points: [number, number][], p: XY): boolean => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Is p on the shape? tol is the pointer's reach as fractions of the width and height (a few pixels): points are hit
 * within 2 × tol, rectangles and text boxes within tol of their edges, polygons inside or within tol of a vertex. A text
 * span without stored boxes is tested on the ones found for it (located). */
export const hitTest = (s: Shape, p: XY, tol: XY = { x: 0, y: 0 }, located?: Box[]): boolean => {
  if (s.type === "rect") return inBox(s, p, tol);
  if (s.type === "point") {
    const [rx, ry] = [tol.x * 2, tol.y * 2];
    if (!rx || !ry) return p.x === s.x && p.y === s.y;
    return ((p.x - s.x) / rx) ** 2 + ((p.y - s.y) / ry) ** 2 <= 1;
  }
  if (s.type === "polygon") return inPolygon(s.points, p) || s.points.some(([x, y]) => Math.abs(p.x - x) <= tol.x && Math.abs(p.y - y) <= tol.y);
  return (s.boxes?.length ? s.boxes : located ?? []).some((b) => inBox(b, p, tol));
};

/** the area a shape covers (fractions²): what decides which of several shapes under the pointer is picked */
export const areaOf = (s: Shape, located?: Box[]): number => {
  if (s.type === "rect") return s.w * s.h;
  if (s.type === "point") return 0;
  if (s.type === "polygon") return Math.abs(s.points.reduce((sum, [x, y], i) => sum + x * s.points[(i + 1) % s.points.length][1] - s.points[(i + 1) % s.points.length][0] * y, 0)) / 2;
  return (s.boxes?.length ? s.boxes : located ?? []).reduce((sum, b) => sum + b.w * b.h, 0);
};

/** The annotation under p: of the ones hit, the smallest (so a point or a small box inside a large one stays reachable). */
export const pickAt = <T extends { pk: string; shape: Shape }>(items: T[], p: XY, tol: XY, located: Record<string, Box[]> = {}): T | null => {
  let best: T | null = null;
  let bestArea = Infinity;
  for (const it of items) {
    if (!hitTest(it.shape, p, tol, located[it.pk])) continue;
    const a = areaOf(it.shape, located[it.pk]);
    if (a < bestArea) [best, bestArea] = [it, a];
  }
  return best;
};

/** A browser text selection's rectangles (client pixels, one per selected run) as a text span's line boxes: fractions of
 * the page area, clipped to it, rectangles on the same line merged, top to bottom. */
export const selectionBoxes = (
  rects: { left: number; top: number; width: number; height: number }[],
  area: { left: number; top: number; width: number; height: number },
): { x: number; y: number; w: number; h: number }[] => {
  if (!(area.width > 0) || !(area.height > 0)) return [];
  return lineBoxes(
    rects
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({ x1: clamp((r.left - area.left) / area.width), y1: clamp((r.top - area.top) / area.height), x2: clamp((r.left + r.width - area.left) / area.width), y2: clamp((r.top + r.height - area.top) / area.height) })),
  );
};

/** rectangles (fractions, corners) merged into one box per line, top to bottom */
const lineBoxes = (rects: { x1: number; y1: number; x2: number; y2: number }[]): { x: number; y: number; w: number; h: number }[] => {
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const sorted = rects.filter((r) => r.x2 > r.x1 && r.y2 > r.y1).sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  for (const r of sorted) {
    const mid = (r.y1 + r.y2) / 2;
    const line = lines.find((l) => mid >= l.y1 && mid <= l.y2);
    if (line) Object.assign(line, { x1: Math.min(line.x1, r.x1), x2: Math.max(line.x2, r.x2), y1: Math.min(line.y1, r.y1), y2: Math.max(line.y2, r.y2) });
    else lines.push({ ...r });
  }
  return lines.map((l) => ({ x: r4(l.x1), y: r4(l.y1), w: r4(l.x2 - l.x1), h: r4(l.y2 - l.y1) }));
};

// ------------------------------------------------------------------------------------------------
// Changing a text span's range: its ends dragged over the page's text layer (runs from GET /pdf/{ref}/text/{n})
// ------------------------------------------------------------------------------------------------

/** a text-layer run: characters [s, e) on one line and their box (fractions of the page) */
export type Run = { s: number; e: number; x: number; y: number; w: number; h: number };

/** The character boundary nearest p: the run on p's line (else the nearest one, lines weighing more than columns), and
 * in it the boundary at p's share of the run's width. Null without runs. */
export const offsetAtPoint = (runs: Run[], p: XY): number | null => {
  let best: Run | null = null;
  let bestD = Infinity;
  for (const r of runs) {
    if (!(r.w > 0) || r.e <= r.s) continue;
    const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.h ? p.y - r.y - r.h : 0;
    const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.w ? p.x - r.x - r.w : 0;
    const d = dy * 4 + dx;
    if (d < bestD) [best, bestD] = [r, d];
  }
  if (!best) return null;
  return best.s + Math.round(clamp((p.x - best.x) / best.w) * (best.e - best.s));
};

/** the line boxes of characters [start, end) on the text layer: of each run the share it covers, one box per line */
export const spanBoxes = (runs: Run[], start: number, end: number): { x: number; y: number; w: number; h: number }[] =>
  lineBoxes(
    runs
      .filter((r) => r.e > start && r.s < end && r.e > r.s)
      .map((r) => {
        const n = r.e - r.s;
        const a = (Math.max(start, r.s) - r.s) / n;
        const b = (Math.min(end, r.e) - r.s) / n;
        return { x1: r.x + r.w * a, y1: r.y, x2: r.x + r.w * b, y2: r.y + r.h };
      }),
  );

/** A span with one end ("start" or "end") dragged to offset `at`: at least one character, within [0, length]; dragged
 * past the other end, the two swap. */
export const spanResized = (s: { start: number; end: number }, which: "start" | "end", at: number, length: number): { start: number; end: number } => {
  const other = which === "start" ? s.end : s.start;
  let to = Math.max(0, Math.min(length, Math.round(at)));
  if (to === other) to = which === "start" ? (other > 0 ? other - 1 : other + 1) : other < length ? other + 1 : other - 1;
  return { start: Math.min(to, other), end: Math.max(to, other) };
};

/** a span's quoted text as the server quotes it: whitespace collapsed, trimmed */
export const quoteOf = (text: string, start: number, end: number) => text.slice(start, end).replace(/\x00/g, " ").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------------------------------------
// Spreadsheet annotations: a sheet and an A1 range ("B2:C4")
// ------------------------------------------------------------------------------------------------

export type CellRange = { sheet: string; range: string };
export type Cells = { sheet: string; r1: number; c1: number; r2: number; c2: number };
export const colName = (i: number): string => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));
const colIndex = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const toRange = (x: Cells): CellRange => ({ sheet: x.sheet, range: `${colName(x.c1)}${x.r1 + 1}:${colName(x.c2)}${x.r2 + 1}` });
export const parseCells = (v: unknown): Cells | null => {
  try {
    const b = typeof v === "string" ? JSON.parse(v) : v;
    const m = typeof b?.range === "string" && typeof b?.sheet === "string" ? /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(b.range.toUpperCase()) : null;
    if (!m) return null;
    const [c1, r1, c2, r2] = [colIndex(m[1]), Number(m[2]) - 1, colIndex(m[3] ?? m[1]), Number(m[4] ?? m[2]) - 1];
    return { sheet: b.sheet, r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  } catch {
    return null;
  }
};

export const sameCells = (a: Cells, b: Cells) => a.sheet === b.sheet && a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
export const inCells = (x: Cells, sheet: string, r: number, c: number) => x.sheet === sheet && r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2;

/** the annotated range under a cell: of the ones containing it, the smallest (so a range inside a larger one stays reachable) */
export const pickCells = <T extends { pk: string; cells: Cells }>(items: T[], sheet: string, r: number, c: number): T | null => {
  let best: T | null = null;
  let bestArea = Infinity;
  for (const it of items) {
    if (!inCells(it.cells, sheet, r, c)) continue;
    const a = (it.cells.r2 - it.cells.r1 + 1) * (it.cells.c2 - it.cells.c1 + 1);
    if (a < bestArea) [best, bestArea] = [it, a];
  }
  return best;
};

/** a range moved by (dr, dc) rows and columns, kept whole inside a sheet of `rows` × `cols` cells */
export const cellsMoved = (x: Cells, dr: number, dc: number, rows: number, cols: number): Cells => {
  const h = x.r2 - x.r1;
  const w = x.c2 - x.c1;
  const r1 = Math.max(0, Math.min(Math.max(0, rows - 1 - h), x.r1 + dr));
  const c1 = Math.max(0, Math.min(Math.max(0, cols - 1 - w), x.c1 + dc));
  return { ...x, r1, c1, r2: r1 + h, c2: c1 + w };
};

/** a range with the corner named by the handle ("nw", "ne", "sw", "se") dragged to cell (r, c): past the opposite corner it flips */
export const cellsResized = (x: Cells, corner: string, r: number, c: number): Cells => {
  const rr = corner.includes("n") ? [r, x.r2] : [x.r1, r];
  const cc = corner.includes("w") ? [c, x.c2] : [x.c1, c];
  return { ...x, r1: Math.max(0, Math.min(rr[0], rr[1])), r2: Math.max(0, rr[0], rr[1]), c1: Math.max(0, Math.min(cc[0], cc[1])), c2: Math.max(0, cc[0], cc[1]) };
};
