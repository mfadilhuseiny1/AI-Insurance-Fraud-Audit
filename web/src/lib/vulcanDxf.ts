/**
 * ASCII DXF for Vulcan: engineering drawings as line segments, points and labels, by layer.
 *
 * Read: LINE, LWPOLYLINE and POLYLINE / VERTEX (2D with bulges, 3D, polygon meshes and polyface meshes as their edges),
 * CIRCLE, ARC, ELLIPSE, SPLINE (evaluated from its knots and control points, else a polyline through its fit or
 * control points), POINT, 3DFACE, SOLID / TRACE (outlines), LEADER, TEXT / MTEXT / ATTRIB (as labels: text, position
 * and height; the rotation and the font are not drawn), INSERT of BLOCKs (position, scale, rotation, arrays, nesting,
 * BYBLOCK colors and layer "0" inheritance), DIMENSION (through its anonymous block), extrusion directions (OCS), the
 * LAYER table (ACI and true colors, off and frozen) and $ACADVER / $INSUNITS. Other entities (HATCH, XLINE, RAY, IMAGE,
 * 3DSOLID, …) and paper space are counted as skipped. Binary DXF and DWG are refused (`sniffDxf`, `decodeDxf`).
 */

export type Vec3 = [number, number, number];
export type DxfLabel = { text: string; position: Vec3; height: number; rotation: number; color: number };
export type DxfLayer = {
  name: string;
  /** 0xRRGGBB */
  color: number;
  off: boolean;
  frozen: boolean;
  /** x1, y1, z1, x2, y2, z2 per segment (drawing coordinates) */
  segments: number[];
  /** one 0xRRGGBB per segment */
  segmentColors: number[];
  /** x, y, z per POINT */
  points: number[];
  pointColors: number[];
  labels: DxfLabel[];
};
export type DxfDrawing = {
  version: string | null;
  units: string | null;
  layers: DxfLayer[];
  /** model space entities by type (block contents are drawn through their INSERTs and not counted here) */
  counts: Record<string, number>;
  /** entities that are not drawn, by type ("paper space" for entities outside model space) */
  skipped: Record<string, number>;
  blocks: number;
  segmentCount: number;
  pointCount: number;
  labelCount: number;
  bounds: { min: Vec3; max: Vec3 } | null;
  /** all geometry lies in one Z plane (a 2D drawing) */
  flat: boolean;
  warnings: string[];
};

/** Segments above this are not kept (the drawing is cut there, with a warning). */
export const DXF_MAX_SEGMENTS = 6_000_000;
const ARC_STEPS = 72; // per full turn
const MAX_DEPTH = 16;

const UNITS: Record<number, string> = { 1: "in", 2: "ft", 3: "mi", 4: "mm", 5: "cm", 6: "m", 7: "km", 8: "µin", 9: "mil", 10: "yd", 14: "dm" };

/** The AutoCAD Color Index as 0xRRGGBB (7 is white here: the viewer is dark). */
export function aciColor(index: number): number {
  const i = Math.abs(Math.trunc(index));
  if (i < 1 || i > 255) return 0xffffff;
  if (i < 10) return [0, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0][i];
  if (i >= 250) return [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff][i - 250];
  // 10–249: 24 hues of 15°, each in five values, full (even) and half (odd) saturation
  const hue = Math.floor((i - 10) / 10) * 15;
  const shade = i % 10;
  const v = [1, 0.8, 0.6, 0.5, 0.3][shade >> 1];
  const s = shade & 1 ? 0.5 : 1;
  const c = v * s;
  const h = hue / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

/** What a file is from its first bytes: ASCII DXF, binary DXF, DWG, or something else. */
export function sniffDxf(bytes: Uint8Array): "ascii" | "binary" | "dwg" | "unknown" {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 22)));
  if (head.startsWith("AutoCAD Binary DXF")) return "binary";
  if (/^AC1[0-9.]{3}/.test(head) || head.startsWith("MC0.0") || head.startsWith("AC2.")) return "dwg";
  // ASCII DXF starts with group code 0 (or 999, a comment) on its own line
  const text = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 2048))).replace(/^﻿|^\xEF\xBB\xBF/, "");
  return /^\s*(0|999)\s*\r?\n/.test(text) ? "ascii" : "unknown";
}

/** The text of an ASCII DXF file; binary DXF and DWG are refused with the reason. */
export function decodeDxf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const kind = sniffDxf(bytes);
  if (kind === "binary") throw new Error("This is a binary DXF file: only ASCII DXF is read here. Save it as ASCII DXF (in AutoCAD: Save As → DXF, format ASCII).");
  if (kind === "dwg") throw new Error("This is a DWG file (the name says DXF): DWG is not read here. Export it as ASCII DXF.");
  if (kind === "unknown") throw new Error("This is not a DXF file: an ASCII DXF starts with group code 0.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes); // older drawings are in an ANSI code page
  }
}

type Ent = { type: string; codes: number[]; vals: string[]; children: Ent[] };
type Block = { base: Vec3; ents: Ent[] };
/** Affine transform, row-major 3 × 4. */
type Mat = number[];
type Frame = { m: Mat; layer: string | null; color: number | null; depth: number; stack: string[] };

const IDENT: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function mul(a: Mat, b: Mat): Mat {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  }
  return o;
}
const apply = (m: Mat, x: number, y: number, z: number): Vec3 => [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
const translate = (x: number, y: number, z: number): Mat => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const scaleOf = (m: Mat) => Math.cbrt(Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]))) || 1;

/** The object coordinate system of an extrusion direction (the arbitrary axis algorithm), as OCS → WCS. */
function ocs(nx: number, ny: number, nz: number): Mat | null {
  const l = Math.hypot(nx, ny, nz);
  if (!l) return null;
  nx /= l;
  ny /= l;
  nz /= l;
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null;
  let ax: Vec3 = Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64 ? [nz, 0, -nx] : [-ny, nx, 0]; // Wy × N, else Wz × N
  const al = Math.hypot(ax[0], ax[1], ax[2]);
  ax = [ax[0] / al, ax[1] / al, ax[2] / al];
  const ay: Vec3 = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
  return [ax[0], ay[0], nx, 0, ax[1], ay[1], ny, 0, ax[2], ay[2], nz, 0];
}

function num(e: Ent, code: number, fallback = 0): number {
  const i = e.codes.indexOf(code);
  if (i < 0) return fallback;
  const v = Number(e.vals[i]);
  return Number.isFinite(v) ? v : fallback;
}
const has = (e: Ent, code: number) => e.codes.indexOf(code) >= 0;
function str(e: Ent, code: number, fallback = ""): string {
  const i = e.codes.indexOf(code);
  return i < 0 ? fallback : e.vals[i];
}
function nums(e: Ent, code: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < e.codes.length; i++) if (e.codes[i] === code) out.push(Number(e.vals[i]) || 0);
  return out;
}

/** Plain text of a TEXT or MTEXT value: control codes and inline formatting removed. */
export function dxfPlainText(raw: string, mtext: boolean): string {
  let s = raw.replace(/%%[dD]/g, "°").replace(/%%[cC]/g, "⌀").replace(/%%[pP]/g, "±").replace(/%%[uUoOkK]/g, "");
  s = s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (!mtext) return s.trim();
  s = s
    .replace(/\\\\/g, "\u0001")
    .replace(/\\\{/g, "\u0002")
    .replace(/\\\}/g, "\u0003")
    .replace(/\\P/g, "\n")
    .replace(/\\~/g, " ")
    .replace(/\\S([^;]*);/g, (_, f: string) => f.replace(/[\^#]/g, "/"))
    .replace(/\\[ACcFfHQTWp][^;]*;/g, "")
    .replace(/\\[LlOoKkNX]/g, "")
    .replace(/[{}]/g, "");
  return s.replace(/\u0001/g, "\\").replace(/\u0002/g, "{").replace(/\u0003/g, "}").trim();
}

/** Parse the text of an ASCII DXF file. */
export function parseDxf(text: string): DxfDrawing {
  const lines = text.split(/\r\n|\r|\n/);
  const n = lines.length >> 1;
  let pos = 0; // index of the next pair
  const codeAt = (i: number) => parseInt(lines[i * 2], 10);
  const valAt = (i: number) => lines[i * 2 + 1];
  const warnings: string[] = [];
  const layers = new Map<string, DxfLayer>();
  const layerOf = (name: string): DxfLayer => {
    let l = layers.get(name);
    if (!l) {
      l = { name, color: 0xffffff, off: false, frozen: false, segments: [], segmentColors: [], points: [], pointColors: [], labels: [] };
      layers.set(name, l);
    }
    return l;
  };
  const blocks = new Map<string, Block>();
  const counts: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  let version: string | null = null;
  let units: string | null = null;
  let sections = 0;

  /** The entity starting at `pos` (a 0 group): its pairs up to the next 0 group. */
  const readEnt = (): Ent => {
    const e: Ent = { type: valAt(pos).trim().toUpperCase(), codes: [], vals: [], children: [] };
    pos++;
    while (pos < n) {
      const c = codeAt(pos);
      if (c === 0) break;
      if (!Number.isNaN(c)) {
        e.codes.push(c);
        // text values keep their spaces; everything else is trimmed
        e.vals.push(c === 1 || c === 3 ? valAt(pos).replace(/^\s+/, "") : valAt(pos).trim());
      }
      pos++;
    }
    return e;
  };
  /** Entities up to ENDSEC / ENDBLK, with VERTEX and ATTRIB runs folded into their owner. */
  const readEnts = (end: string): Ent[] => {
    const out: Ent[] = [];
    let owner: Ent | null = null;
    while (pos < n) {
      if (codeAt(pos) !== 0) {
        pos++;
        continue;
      }
      const t = valAt(pos).trim().toUpperCase();
      if (t === end || t === "ENDSEC" || t === "EOF") break;
      const e = readEnt();
      if (e.type === "SEQEND") owner = null;
      else if (owner && (e.type === "VERTEX" || e.type === "ATTRIB")) owner.children.push(e);
      else {
        out.push(e);
        owner = e.type === "POLYLINE" || (e.type === "INSERT" && num(e, 66) === 1) ? e : null;
      }
    }
    return out;
  };

  let entities: Ent[] = [];
  while (pos < n) {
    if (codeAt(pos) !== 0 || valAt(pos).trim().toUpperCase() !== "SECTION") {
      pos++;
      continue;
    }
    pos++;
    const name = pos < n && codeAt(pos) === 2 ? valAt(pos).trim().toUpperCase() : "";
    pos++;
    sections++;
    if (name === "HEADER") {
      let variable = "";
      while (pos < n && !(codeAt(pos) === 0 && valAt(pos).trim().toUpperCase() === "ENDSEC")) {
        const c = codeAt(pos);
        if (c === 9) variable = valAt(pos).trim().toUpperCase();
        else if (variable === "$ACADVER" && c === 1) version = valAt(pos).trim();
        else if (variable === "$INSUNITS" && c === 70) units = UNITS[parseInt(valAt(pos), 10)] ?? null;
        pos++;
      }
    } else if (name === "TABLES") {
      while (pos < n && !(codeAt(pos) === 0 && valAt(pos).trim().toUpperCase() === "ENDSEC")) {
        if (codeAt(pos) === 0 && valAt(pos).trim().toUpperCase() === "LAYER") {
          const e = readEnt();
          const l = layerOf(str(e, 2, "0"));
          const c = num(e, 62, 7);
          l.color = has(e, 420) ? num(e, 420) & 0xffffff : aciColor(c);
          l.off = c < 0;
          l.frozen = (num(e, 70) & 1) === 1;
        } else pos++;
      }
    } else if (name === "BLOCKS") {
      while (pos < n && !(codeAt(pos) === 0 && valAt(pos).trim().toUpperCase() === "ENDSEC")) {
        if (codeAt(pos) === 0 && valAt(pos).trim().toUpperCase() === "BLOCK") {
          const head = readEnt();
          const ents = readEnts("ENDBLK");
          blocks.set(str(head, 2).toUpperCase(), { base: [num(head, 10), num(head, 20), num(head, 30)], ents });
        } else pos++;
      }
    } else if (name === "ENTITIES") {
      entities = entities.concat(readEnts("ENDSEC"));
    }
  }
  if (!sections) throw new Error("This is not a DXF file: it has no SECTION.");

  let segmentCount = 0;
  let pointCount = 0;
  let labelCount = 0;
  let full = false;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const grow = (p: Vec3) => {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  };
  const seg = (l: DxfLayer, color: number, a: Vec3, b: Vec3) => {
    if (segmentCount >= DXF_MAX_SEGMENTS) {
      full = true;
      return;
    }
    if (!(Number.isFinite(a[0] + a[1] + a[2] + b[0] + b[1] + b[2]))) return;
    l.segments.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    l.segmentColors.push(color);
    segmentCount++;
    grow(a);
    grow(b);
  };
  const path = (l: DxfLayer, color: number, m: Mat, pts: Vec3[], closed: boolean) => {
    const w = pts.map((p) => apply(m, p[0], p[1], p[2]));
    for (let i = 1; i < w.length; i++) seg(l, color, w[i - 1], w[i]);
    if (closed && w.length > 2) seg(l, color, w[w.length - 1], w[0]);
  };
  /** Points of an arc about (cx, cy) at height z: from angle a0 over `sweep` radians (signed). */
  const arcPts = (cx: number, cy: number, z: number, r: number, a0: number, sweep: number): Vec3[] => {
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * ARC_STEPS));
    const out: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (sweep * i) / steps;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
    }
    return out;
  };
  /** A 2D polyline's points with its bulges as arcs. */
  const bulged = (v: { x: number; y: number; b: number }[], z: number, closed: boolean): Vec3[] => {
    const out: Vec3[] = [];
    const count = closed ? v.length : v.length - 1;
    for (let i = 0; i < count; i++) {
      const p = v[i];
      const q = v[(i + 1) % v.length];
      if (!out.length) out.push([p.x, p.y, z]);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      if (p.b && (dx || dy)) {
        const k = (1 - p.b * p.b) / (4 * p.b);
        const cx = (p.x + q.x) / 2 - dy * k;
        const cy = (p.y + q.y) / 2 + dx * k;
        const arc = arcPts(cx, cy, z, Math.hypot(p.x - cx, p.y - cy), Math.atan2(p.y - cy, p.x - cx), 4 * Math.atan(p.b));
        for (let j = 1; j < arc.length - 1; j++) out.push(arc[j]);
      }
      out.push([q.x, q.y, z]);
    }
    if (!count && v.length) out.push([v[0].x, v[0].y, z]);
    return out;
  };

  const draw = (e: Ent, f: Frame) => {
    if (full) return;
    const own = str(e, 8, "0");
    const layer = layerOf(f.layer !== null && own === "0" ? f.layer : own);
    const c62 = has(e, 62) ? num(e, 62) : 256;
    const color = has(e, 420) ? num(e, 420) & 0xffffff : c62 === 0 ? (f.color ?? layer.color) : c62 === 256 ? layer.color : aciColor(c62);
    const o = has(e, 210) || has(e, 220) || has(e, 230) ? ocs(num(e, 210), num(e, 220), num(e, 230, 1)) : null;
    const mo = o ? mul(f.m, o) : f.m; // for entities in object coordinates
    switch (e.type) {
      case "LINE":
        seg(layer, color, apply(f.m, num(e, 10), num(e, 20), num(e, 30)), apply(f.m, num(e, 11), num(e, 21), num(e, 31)));
        break;
      case "POINT": {
        const p = apply(f.m, num(e, 10), num(e, 20), num(e, 30));
        layer.points.push(p[0], p[1], p[2]);
        layer.pointColors.push(color);
        pointCount++;
        grow(p);
        break;
      }
      case "CIRCLE":
        path(layer, color, mo, arcPts(num(e, 10), num(e, 20), num(e, 30), num(e, 40), 0, 2 * Math.PI), false);
        break;
      case "ARC": {
        const a0 = (num(e, 50) * Math.PI) / 180;
        let sweep = ((num(e, 51) - num(e, 50)) * Math.PI) / 180;
        while (sweep <= 0) sweep += 2 * Math.PI;
        path(layer, color, mo, arcPts(num(e, 10), num(e, 20), num(e, 30), num(e, 40), a0, sweep), false);
        break;
      }
      case "ELLIPSE": {
        // center and major axis in world coordinates; the minor axis is normal × major × ratio
        const c: Vec3 = [num(e, 10), num(e, 20), num(e, 30)];
        const a: Vec3 = [num(e, 11), num(e, 21), num(e, 31)];
        let nv: Vec3 = [num(e, 210), num(e, 220), num(e, 230, 1)];
        const nl = Math.hypot(nv[0], nv[1], nv[2]) || 1;
        nv = [nv[0] / nl, nv[1] / nl, nv[2] / nl];
        const ratio = num(e, 40, 1);
        const b: Vec3 = [(nv[1] * a[2] - nv[2] * a[1]) * ratio, (nv[2] * a[0] - nv[0] * a[2]) * ratio, (nv[0] * a[1] - nv[1] * a[0]) * ratio];
        const t0 = num(e, 41, 0);
        let sweep = num(e, 42, 2 * Math.PI) - t0;
        while (sweep <= 0) sweep += 2 * Math.PI;
        const steps = Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * ARC_STEPS));
        const pts: Vec3[] = [];
        for (let i = 0; i <= steps; i++) {
          const t = t0 + (sweep * i) / steps;
          const ct = Math.cos(t);
          const st = Math.sin(t);
          pts.push([c[0] + a[0] * ct + b[0] * st, c[1] + a[1] * ct + b[1] * st, c[2] + a[2] * ct + b[2] * st]);
        }
        path(layer, color, f.m, pts, false);
        break;
      }
      case "LWPOLYLINE": {
        const v: { x: number; y: number; b: number }[] = [];
        for (let i = 0; i < e.codes.length; i++) {
          const c = e.codes[i];
          if (c === 10) v.push({ x: Number(e.vals[i]) || 0, y: 0, b: 0 });
          else if (c === 20 && v.length) v[v.length - 1].y = Number(e.vals[i]) || 0;
          else if (c === 42 && v.length) v[v.length - 1].b = Number(e.vals[i]) || 0;
        }
        path(layer, color, mo, bulged(v, num(e, 38), (num(e, 70) & 1) === 1), false);
        break;
      }
      case "POLYLINE": {
        const flags = num(e, 70);
        const vs = e.children.filter((c) => c.type === "VERTEX");
        if (flags & 64) {
          // polyface mesh: coordinate vertices, then face records with 1-based indices (negative: an invisible edge)
          const pts = vs.filter((v) => num(v, 70) & 64).map((v): Vec3 => [num(v, 10), num(v, 20), num(v, 30)]);
          for (const face of vs.filter((v) => (num(v, 70) & 128) === 128 && !(num(v, 70) & 64))) {
            const ix = [num(face, 71), num(face, 72), num(face, 73), num(face, 74)].filter((i) => i !== 0);
            for (let i = 0; i < ix.length; i++) {
              const a = pts[Math.abs(ix[i]) - 1];
              const b = pts[Math.abs(ix[(i + 1) % ix.length]) - 1];
              if (ix[i] > 0 && a && b && ix.length > 1) seg(layer, color, apply(f.m, a[0], a[1], a[2]), apply(f.m, b[0], b[1], b[2]));
            }
          }
        } else if (flags & 16) {
          // polygon mesh: M × N vertices, drawn as its grid lines
          const mCount = num(e, 71);
          const nCount = num(e, 72);
          const pts = vs.map((v): Vec3 => [num(v, 10), num(v, 20), num(v, 30)]);
          if (mCount * nCount <= pts.length) {
            for (let i = 0; i < mCount; i++) path(layer, color, f.m, pts.slice(i * nCount, (i + 1) * nCount), (flags & 32) === 32);
            for (let j = 0; j < nCount; j++) path(layer, color, f.m, Array.from({ length: mCount }, (_, i) => pts[i * nCount + j]), (flags & 1) === 1);
          }
        } else if (flags & 8) {
          path(layer, color, f.m, vs.filter((v) => !(num(v, 70) & 16)).map((v): Vec3 => [num(v, 10), num(v, 20), num(v, 30)]), (flags & 1) === 1);
        } else {
          const v = vs.filter((x) => !(num(x, 70) & 16)).map((x) => ({ x: num(x, 10), y: num(x, 20), b: num(x, 42) }));
          path(layer, color, mo, bulged(v, num(e, 30), (flags & 1) === 1), false);
        }
        break;
      }
      case "SPLINE":
        path(layer, color, f.m, splinePoints(e), false);
        break;
      case "LEADER": {
        const xs = nums(e, 10);
        const ys = nums(e, 20);
        const zs = nums(e, 30);
        path(layer, color, f.m, xs.map((x, i): Vec3 => [x, ys[i] ?? 0, zs[i] ?? 0]), false);
        break;
      }
      case "3DFACE": {
        const p: Vec3[] = [0, 1, 2, 3].map((k): Vec3 => [num(e, 10 + k), num(e, 20 + k), num(e, 30 + k)]);
        const tri = !has(e, 13) || (p[2][0] === p[3][0] && p[2][1] === p[3][1] && p[2][2] === p[3][2]);
        const hidden = num(e, 70);
        const corners = tri ? [p[0], p[1], p[2]] : p;
        for (let i = 0; i < corners.length; i++) {
          if (hidden & (1 << (tri && i === 2 ? 3 : i)) && !(tri && i === 2 && !(hidden & 8))) continue;
          const a = corners[i];
          const b = corners[(i + 1) % corners.length];
          seg(layer, color, apply(f.m, a[0], a[1], a[2]), apply(f.m, b[0], b[1], b[2]));
        }
        break;
      }
      case "SOLID":
      case "TRACE": {
        const p: Vec3[] = [0, 1, 3, 2].filter((k) => k < 3 || has(e, 13)).map((k): Vec3 => [num(e, 10 + k), num(e, 20 + k), num(e, 30 + k)]);
        path(layer, color, mo, p, true);
        break;
      }
      case "TEXT":
      case "ATTRIB":
      case "MTEXT": {
        const mtext = e.type === "MTEXT";
        const raw = mtext ? e.vals.filter((_, i) => e.codes[i] === 3).join("") + str(e, 1) : str(e, 1);
        const t = dxfPlainText(raw, mtext);
        if (!t) break;
        const aligned = !mtext && (num(e, 72) !== 0 || num(e, 73) !== 0 || num(e, 74) !== 0) && has(e, 11);
        const p = aligned ? apply(mo, num(e, 11), num(e, 21), num(e, 31)) : apply(mtext ? f.m : mo, num(e, 10), num(e, 20), num(e, 30));
        layer.labels.push({ text: t, position: p, height: (num(e, 40, 1) || 1) * scaleOf(f.m), rotation: num(e, 50), color });
        labelCount++;
        grow(p);
        break;
      }
      case "INSERT":
      case "DIMENSION": {
        const name = str(e, 2).toUpperCase();
        const b = blocks.get(name);
        if (!b) {
          if (e.type === "INSERT") warnings.push(`INSERT of the block ${str(e, 2) || "(no name)"}, which is not defined`);
          else skipped.DIMENSION = (skipped.DIMENSION ?? 0) + 1;
          break;
        }
        if (f.depth >= MAX_DEPTH || f.stack.includes(name)) {
          warnings.push(`the block ${str(e, 2)} is nested in itself or too deep: not drawn there`);
          break;
        }
        const next = { layer: layer.name, color, depth: f.depth + 1, stack: [...f.stack, name] };
        if (e.type === "DIMENSION") {
          // the dimension's picture is an anonymous block in world coordinates
          for (const c of b.ents) draw(c, { m: f.m, ...next });
          break;
        }
        const rot = (num(e, 50) * Math.PI) / 180;
        const cs = Math.cos(rot);
        const sn = Math.sin(rot);
        const sx = num(e, 41, 1) || 1;
        const sy = num(e, 42, 1) || 1;
        const sz = num(e, 43, 1) || 1;
        const cols = Math.max(1, num(e, 70, 1));
        const rows = Math.max(1, num(e, 71, 1));
        const place = mul(mo, mul(translate(num(e, 10), num(e, 20), num(e, 30)), [cs, -sn, 0, 0, sn, cs, 0, 0, 0, 0, 1, 0]));
        const inner = mul([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0], translate(-b.base[0], -b.base[1], -b.base[2]));
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const m = mul(place, mul(translate(c * num(e, 44), r * num(e, 45), 0), inner));
            for (const child of b.ents) draw(child, { m, ...next });
          }
        }
        for (const a of e.children) draw(a, f); // attributes are in world coordinates
        break;
      }
      default:
        skipped[e.type] = (skipped[e.type] ?? 0) + 1;
    }
  };

  for (const e of entities) {
    if (num(e, 67) === 1) {
      skipped["paper space"] = (skipped["paper space"] ?? 0) + 1;
      continue;
    }
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    draw(e, { m: IDENT, layer: null, color: null, depth: 0, stack: [] });
  }
  for (const t of Object.keys(skipped)) if (t !== "paper space" && counts[t]) delete counts[t];
  if (full) warnings.push(`the drawing has more than ${DXF_MAX_SEGMENTS.toLocaleString("en-US")} segments: the rest is not drawn`);
  const any = min[0] !== Infinity;
  const size = any ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  return {
    version,
    units,
    layers: [...layers.values()],
    counts,
    skipped,
    blocks: blocks.size,
    segmentCount,
    pointCount,
    labelCount,
    bounds: any ? { min, max } : null,
    flat: any && max[2] - min[2] <= 1e-9 * (size || 1),
    warnings,
  };
}

/** A SPLINE as points: the NURBS curve where the knots and control points allow it, else its fit or control points. */
function splinePoints(e: Ent): Vec3[] {
  const degree = num(e, 71, 3);
  const knots = nums(e, 40);
  const cx = nums(e, 10);
  const cy = nums(e, 20);
  const cz = nums(e, 30);
  const ctrl = cx.map((x, i): Vec3 => [x, cy[i] ?? 0, cz[i] ?? 0]);
  const fx = nums(e, 11);
  const fy = nums(e, 21);
  const fz = nums(e, 31);
  const fit = fx.map((x, i): Vec3 => [x, fy[i] ?? 0, fz[i] ?? 0]);
  const count = ctrl.length;
  if (degree < 1 || count <= degree || knots.length !== count + degree + 1) return fit.length > 1 ? fit : ctrl;
  const w = nums(e, 41);
  const weights = w.length === count ? w : null;
  const lo = knots[degree];
  const hi = knots[count];
  if (!(hi > lo)) return fit.length > 1 ? fit : ctrl;
  const steps = Math.max(16, (count - degree) * 12);
  const out: Vec3[] = [];
  for (let s = 0; s <= steps; s++) {
    const u = s === steps ? hi : lo + ((hi - lo) * s) / steps;
    // the knot span holding u, then de Boor in homogeneous coordinates
    let k = degree;
    while (k < count - 1 && u >= knots[k + 1]) k++;
    const d: number[][] = [];
    for (let j = 0; j <= degree; j++) {
      const p = ctrl[k - degree + j];
      const wt = weights ? weights[k - degree + j] : 1;
      d.push([p[0] * wt, p[1] * wt, p[2] * wt, wt]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den ? (u - knots[i]) / den : 0;
        for (let q = 0; q < 4; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
      }
    }
    const h = d[degree];
    out.push([h[0] / (h[3] || 1), h[1] / (h[3] || 1), h[2] / (h[3] || 1)]);
  }
  return out;
}
