/**
 * Machinery graph layout (pure: no runtime imports, so it runs in Node for tests).
 *
 * `layoutGraph` places one process: left-to-right layers from the start through the transitions (loops placed by
 * first reach), nodes of any size, and edges routed so that none crosses a node's box — a forward edge runs through
 * the gaps between the columns and, where it skips columns, through a free lane of each column in between; a back
 * edge runs under the columns it spans; a self loop sits on top of its node.
 *
 * `layoutNested` is the compound drawing: every expanded state of the process grows to hold the graph of each
 * direct subprocess (header on top, then one titled graph per subprocess), and the parent level is laid out around
 * the grown boxes. With nothing expanded the node positions are the flat layout's.
 */
import type { Process, Transition } from "./machinery";

/** The same value as `START` in machinery.ts (kept local: this file imports types only). */
const START = "__start__";

export type Box = { x: number; y: number; w: number; h: number };
/** Node size and the gaps between columns (gapX) and between the nodes of a column (gapY). */
export type Dim = { w: number; h: number; gapX: number; gapY: number };
export const DIM: Dim = { w: 150, h: 54, gapX: 70, gapY: 56 };
export const NESTED_DIM: Dim = { w: 124, h: 46, gapX: 56, gapY: 30 };
/** Inside an expanded state: padding around each subprocess graph, and the height of its title row. */
export const GROUP_PAD = 16;
export const GROUP_TITLE = 22;
/** The start node is drawn as a circle this wide at the left of its slot. */
export const START_W = 20;

type Seg = ["M" | "L", number, number] | ["Q", number, number, number, number] | ["C", number, number, number, number, number, number];
export type EdgeRoute = {
  from: string;
  to: string;
  /** SVG path data */
  d: string;
  /** the path as a polyline (curves sampled), for hit and overlap tests */
  pts: [number, number][];
  label: { x: number; y: number };
  kind: "forward" | "back" | "self";
  segs: Seg[];
};
export type GraphLayout = { nodes: Record<string, Box>; edges: EdgeRoute[]; bounds: Box };
export type NestedGroup = {
  /** the subprocess */
  pid: string;
  /** where its title row starts (text baseline) */
  title: { x: number; y: number };
  /** the area of the subprocess inside the parent state's box (title row and graph) */
  box: Box;
  graph: GraphLayout;
};
export type NestedLayout = GraphLayout & { groups: Record<string, NestedGroup[]> };

const r2 = (n: number) => Math.round(n * 100) / 100;

function sample(segs: Seg[]): [number, number][] {
  const pts: [number, number][] = [];
  let cx = 0;
  let cy = 0;
  for (const s of segs) {
    if (s[0] === "M" || s[0] === "L") {
      pts.push([s[1], s[2]]);
      cx = s[1];
      cy = s[2];
    } else if (s[0] === "Q") {
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        const u = 1 - t;
        pts.push([u * u * cx + 2 * u * t * s[1] + t * t * s[3], u * u * cy + 2 * u * t * s[2] + t * t * s[4]]);
      }
      cx = s[3];
      cy = s[4];
    } else {
      const [, ax, ay, bx, by, ex, ey] = s as ["C", number, number, number, number, number, number];
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        pts.push([u * u * u * cx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * ex, u * u * u * cy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * ey]);
      }
      cx = ex;
      cy = ey;
    }
  }
  return pts;
}

function finish(from: string, to: string, kind: EdgeRoute["kind"], segs: Seg[], label: { x: number; y: number }): EdgeRoute {
  const d = segs
    .map((s) => {
      const n = (s.slice(1) as number[]).map(r2);
      if (s[0] === "C") return `C${n[0]},${n[1]} ${n[2]},${n[3]} ${n[4]},${n[5]}`;
      if (s[0] === "Q") return `Q${n[0]},${n[1]} ${n[2]},${n[3]}`;
      return `${s[0]}${n[0]},${n[1]}`;
    })
    .join(" ");
  return { from, to, kind, segs, d, pts: sample(segs), label };
}

/** A horizontal S-curve between two points (the tangents are horizontal at both ends). */
const sCurve = (x1: number, y1: number, x2: number, y2: number): Seg => ["C", (x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2];

/** An orthogonal polyline with rounded corners. */
function rounded(points: [number, number][], r: number): Seg[] {
  const segs: Seg[] = [["M", points[0][0], points[0][1]]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const a = Math.hypot(x - px, y - py);
    const b = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, a / 2, b / 2);
    if (rr <= 0) continue;
    segs.push(["L", x - ((x - px) / a) * rr, y - ((y - py) / a) * rr]);
    segs.push(["Q", x, y, x + ((nx - x) / b) * rr, y + ((ny - y) / b) * rr]);
  }
  const last = points[points.length - 1];
  segs.push(["L", last[0], last[1]]);
  return segs;
}

function boundsOf(nodes: Record<string, Box>, edges: EdgeRoute[]): Box {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [id, b] of Object.entries(nodes)) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + (id === START ? START_W : b.w));
    y2 = Math.max(y2, b.y + b.h);
  }
  for (const e of edges)
    for (const [x, y] of e.pts) {
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x);
      y2 = Math.max(y2, y);
    }
  if (x1 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * One process: `ids` are its states (the start node is added), `sizes` the nodes that are not the default size.
 * Deterministic: the same input gives the same output.
 */
export function layoutGraph(ids: string[], transitions: Transition[], dim: Dim = DIM, sizes: Record<string, { w: number; h: number }> = {}): GraphLayout {
  const all = [START, ...ids.filter((id, i) => id !== START && ids.indexOf(id) === i)];
  const known = new Set(all);
  const edges = transitions.filter((e) => known.has(e.from) && known.has(e.to));
  const level = new Map<string, number>([[START, 0]]);
  const queue = [START];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges)
      if (e.from === cur && !level.has(e.to)) {
        level.set(e.to, level.get(cur)! + 1);
        queue.push(e.to);
      }
  }
  let maxL = Math.max(0, ...level.values());
  for (const id of all) if (!level.has(id)) level.set(id, ++maxL);
  const cols: string[][] = Array.from({ length: maxL + 1 }, () => []);
  for (const id of all) cols[level.get(id)!].push(id);
  const size = (id: string) => (id !== START && sizes[id] ? sizes[id] : { w: dim.w, h: dim.h });
  const colX: number[] = [];
  const colW: number[] = [];
  const colBottom: number[] = [];
  const nodes: Record<string, Box> = {};
  let x = 0;
  cols.forEach((col, l) => {
    colX[l] = x;
    colW[l] = Math.max(dim.w, ...col.map((id) => size(id).w));
    const total = col.reduce((s, id) => s + size(id).h, 0) + (col.length - 1) * dim.gapY;
    let y = dim.h / 2 - total / 2;
    for (const id of col) {
      const s = size(id);
      nodes[id] = { x, y, w: s.w, h: s.h };
      y += s.h + dim.gapY;
    }
    colBottom[l] = y - dim.gapY;
    x += colW[l] + dim.gapX;
  });
  const outX = (id: string) => nodes[id].x + (id === START ? START_W : nodes[id].w);
  /** A height at which a horizontal line crosses column l without touching a node: y itself, or the nearest lane. */
  const freeY = (l: number, y: number, towards: number) => {
    const boxes = cols[l].map((id) => nodes[id]);
    if (!boxes.some((b) => y > b.y - 8 && y < b.y + b.h + 8)) return y;
    const lanes = [boxes[0].y - dim.gapY / 2, ...boxes.map((b) => b.y + b.h + dim.gapY / 2)];
    return lanes.reduce((best, c) => {
      const d = Math.abs(c - y) - Math.abs(best - y);
      if (d < 0) return c;
      if (d > 0) return best;
      return Math.abs(c - towards) < Math.abs(best - towards) ? c : best;
    });
  };
  let backs = 0;
  const routes = edges.map((e): EdgeRoute => {
    const a = nodes[e.from];
    const b = nodes[e.to];
    const la = level.get(e.from)!;
    const lb = level.get(e.to)!;
    if (e.from === e.to) {
      const x1 = a.x + a.w - 50;
      const x2 = a.x + a.w - 14;
      const up = Math.min(30, dim.gapY - 4);
      return finish(e.from, e.to, "self", [["M", x1, a.y], ["C", x1, a.y - up, x2, a.y - up, x2, a.y]], { x: (x1 + x2) / 2, y: a.y - up * 0.75 - 3 });
    }
    if (lb > la) {
      let cx = outX(e.from);
      let cy = a.y + dim.h / 2;
      const ty = b.y + dim.h / 2;
      const segs: Seg[] = [["M", cx, cy]];
      const right = colX[la] + colW[la];
      // a wider node in the same column: leave the column first, level with this node
      if (cols[la].some((id) => id !== e.from && nodes[id].x + nodes[id].w > cx)) {
        segs.push(["L", right, cy]);
        cx = right;
      }
      for (let m = la + 1; m < lb; m++) {
        const yy = freeY(m, cy, ty);
        segs.push(sCurve(cx, cy, colX[m], yy));
        segs.push(["L", colX[m] + colW[m], yy]);
        cx = colX[m] + colW[m];
        cy = yy;
      }
      segs.push(sCurve(cx, cy, b.x, ty));
      return finish(e.from, e.to, "forward", segs, { x: (cx + b.x) / 2, y: (cy + ty) / 2 - 6 });
    }
    const k = backs++;
    const ya = a.y + dim.h * 0.72;
    const yb = b.y + dim.h * 0.72;
    const xr = colX[la] + colW[la] + 18 + (k % 3) * 5;
    const xl = colX[lb] - 18 - (k % 3) * 5;
    const lane = Math.max(...colBottom.slice(lb, la + 1)) + 30 + k * 12;
    const segs = rounded([[outX(e.from), ya], [xr, ya], [xr, lane], [xl, lane], [xl, yb], [b.x, yb]], 8);
    return finish(e.from, e.to, "back", segs, { x: (xr + xl) / 2, y: lane - 5 });
  });
  return { nodes, edges: routes, bounds: boundsOf(nodes, routes) };
}

function shift(g: GraphLayout, dx: number, dy: number): GraphLayout {
  const nodes: Record<string, Box> = {};
  for (const [id, b] of Object.entries(g.nodes)) nodes[id] = { ...b, x: b.x + dx, y: b.y + dy };
  const edges = g.edges.map((e) =>
    finish(
      e.from,
      e.to,
      e.kind,
      e.segs.map((s) => [s[0], ...(s.slice(1) as number[]).map((n, i) => n + (i % 2 === 0 ? dx : dy))] as Seg),
      { x: e.label.x + dx, y: e.label.y + dy },
    ),
  );
  return { nodes, edges, bounds: { ...g.bounds, x: g.bounds.x + dx, y: g.bounds.y + dy } };
}

/** The states of a process as drawn: its own, then the extra ones (mined, not defined yet). */
export function stateIds(p: Pick<Process, "states">, extra: string[] = []): string[] {
  const own = p.states.map((s) => s.id);
  return [...own, ...extra.filter((e) => !own.includes(e))];
}

/**
 * A process with the graphs of its direct subprocesses drawn inside each expanded state.
 * extra / extraTrans: mined states and transitions shown on the parent level. Only defined states expand.
 */
export function layoutNested(p: Process, extra: string[], extraTrans: Transition[], children: Process[], expanded: string[]): NestedLayout {
  const open = children.length ? p.states.map((s) => s.id).filter((id) => expanded.includes(id)) : [];
  const inner = children.map((c) => layoutGraph(stateIds(c), c.transitions, NESTED_DIM));
  const innerW = Math.max(0, ...inner.map((g) => g.bounds.w));
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const id of open) sizes[id] = { w: Math.max(DIM.w, innerW + 2 * GROUP_PAD), h: DIM.h + inner.reduce((s, g) => s + GROUP_TITLE + g.bounds.h + GROUP_PAD, 0) };
  const root = layoutGraph(stateIds(p, extra), [...p.transitions, ...extraTrans], DIM, sizes);
  const groups: Record<string, NestedGroup[]> = {};
  for (const id of open) {
    const b = root.nodes[id];
    let y = b.y + DIM.h;
    groups[id] = children.map((c, i) => {
      const g = inner[i];
      const graph = shift(g, b.x + GROUP_PAD - g.bounds.x, y + GROUP_TITLE - g.bounds.y);
      const group: NestedGroup = { pid: c.id, title: { x: b.x + GROUP_PAD, y: y + 14 }, box: { x: b.x + GROUP_PAD, y, w: b.w - 2 * GROUP_PAD, h: GROUP_TITLE + g.bounds.h }, graph };
      y += GROUP_TITLE + g.bounds.h + GROUP_PAD;
      return group;
    });
  }
  return { ...root, groups };
}

/** Where a line from the centre of `b` towards (tx, ty) leaves the box. */
function borderPoint(b: Box, tx: number, ty: number): [number, number] {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const k = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * k, cy + dy * k];
}

/**
 * A process drawn by hand (the resource's "Auto layout" is off): every state at its stored x / y — a state without
 * one keeps the place the automatic layout gives it — the start node left of the states, and each transition a
 * gentle curve from box to box, bent to its right so that a → b and b → a stay apart.
 */
export function layoutManual(states: { id: string; x?: number | null; y?: number | null }[], extra: string[], transitions: Transition[], dim: Dim = DIM): GraphLayout {
  const ids = [...states.map((s) => s.id), ...extra.filter((e) => !states.some((s) => s.id === e))];
  const auto = layoutGraph(ids, transitions, dim);
  const placed = states.filter((s) => typeof s.x === "number" && typeof s.y === "number");
  const nodes: Record<string, Box> = {};
  // unplaced states go under the placed ones, in the automatic arrangement
  const bottom = placed.length ? Math.max(...placed.map((s) => (s.y as number) + dim.h)) + dim.gapY : 0;
  const left = placed.length ? Math.min(...placed.map((s) => s.x as number)) : 0;
  const free = ids.filter((id) => !placed.some((s) => s.id === id));
  const fx = free.length ? Math.min(...free.map((id) => auto.nodes[id].x)) : 0;
  const fy = free.length ? Math.min(...free.map((id) => auto.nodes[id].y)) : 0;
  for (const s of placed) nodes[s.id] = { x: s.x as number, y: s.y as number, w: dim.w, h: dim.h };
  for (const id of free) nodes[id] = placed.length ? { ...auto.nodes[id], x: auto.nodes[id].x - fx + left, y: auto.nodes[id].y - fy + bottom } : auto.nodes[id];
  const boxes = ids.map((id) => nodes[id]);
  if (!boxes.length) return auto;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  nodes[START] = { x: minX - dim.gapX - START_W, y: (minY + maxY) / 2 - dim.h / 2, w: dim.w, h: dim.h };
  const known = new Set([START, ...ids]);
  const edges = transitions
    .filter((e) => known.has(e.from) && known.has(e.to))
    .map((e): EdgeRoute => {
      const a = nodes[e.from];
      const b = nodes[e.to];
      if (e.from === e.to) {
        const x1 = a.x + a.w - 50;
        const x2 = a.x + a.w - 14;
        return finish(e.from, e.to, "self", [["M", x1, a.y], ["C", x1, a.y - 30, x2, a.y - 30, x2, a.y]], { x: (x1 + x2) / 2, y: a.y - 26 });
      }
      const from: Box = e.from === START ? { x: a.x, y: a.y + dim.h / 2 - 10, w: START_W, h: 20 } : a;
      const ac: [number, number] = [from.x + from.w / 2, from.y + from.h / 2];
      const bc: [number, number] = [b.x + b.w / 2, b.y + b.h / 2];
      const len = Math.hypot(bc[0] - ac[0], bc[1] - ac[1]) || 1;
      // the control point: the middle, pushed to the right of the direction of travel
      const bend = Math.min(40, len * 0.16);
      const mx = (ac[0] + bc[0]) / 2 - ((bc[1] - ac[1]) / len) * bend;
      const my = (ac[1] + bc[1]) / 2 + ((bc[0] - ac[0]) / len) * bend;
      const p1 = borderPoint(from, mx, my);
      const p2 = borderPoint(b, mx, my);
      return finish(e.from, e.to, bc[0] >= ac[0] ? "forward" : "back", [["M", p1[0], p1[1]], ["Q", mx, my, p2[0], p2[1]]], { x: (p1[0] + 2 * mx + p2[0]) / 4, y: (p1[1] + 2 * my + p2[1]) / 4 - 4 });
    });
  return { nodes, edges, bounds: boundsOf(nodes, edges) };
}
