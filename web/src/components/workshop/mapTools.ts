/**
 * Pure helpers of the Workshop Map widget's tools (only mapGeometry.ts imported, so Node tests can load it): lasso /
 * polygon selection (a shape meets a drawn polygon: holes and the antimeridian handled as for the box), drawn shapes as
 * GeoJSON (exterior rings counter-clockwise, longitudes in range, optionally split at the antimeridian), geodesic
 * measures on WGS 84 (Vincenty lengths, areas on the authalic sphere) and the timeline's time window.
 */

import { distToLine, latOfY, lonOfX, mercX, mercY, parseShape, pointInRings, turnsTo, unwrapLons, type Geom, type Prepared, type Run } from "./mapGeometry";

// ------------------------------------------------------------------------------------------------
// lasso / polygon selection (world units: x = 0 at 180°W … 1 at 180°E, y = 0 north)
// ------------------------------------------------------------------------------------------------

/** Whether the segments a–b and c–d meet (touching and collinear overlap count). */
export function segmentsMeet(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => {
    const v = (qx - px) * (ry - py) - (qy - py) * (rx - px);
    return Math.abs(v) < 1e-18 ? 0 : v > 0 ? 1 : -1;
  };
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.min(px, qx) - 1e-15 <= rx && rx <= Math.max(px, qx) + 1e-15 && Math.min(py, qy) - 1e-15 <= ry && ry <= Math.max(py, qy) + 1e-15;
  const o1 = o(ax, ay, bx, by, cx, cy);
  const o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay);
  const o4 = o(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(ax, ay, bx, by, cx, cy)) || (o2 === 0 && on(ax, ay, bx, by, dx, dy)) || (o3 === 0 && on(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && on(cx, cy, dx, dy, bx, by));
}

/** A selection polygon (a lasso or clicked corners) in world units, ready for many tests: its ring closed, its box. */
export type SelPolygon = { ring: Run; box: [number, number, number, number] };

/** A selection polygon from world positions x0, y0, x1, y1, … (closed here; null with fewer than three corners). */
export function selPolygon(pts: Run): SelPolygon | null {
  const r: Run = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const n = r.length;
    if (n && Math.abs(pts[i] - r[n - 2]) < 1e-15 && Math.abs(pts[i + 1] - r[n - 1]) < 1e-15) continue;
    r.push(pts[i], pts[i + 1]);
  }
  if (r.length >= 4 && Math.abs(r[0] - r[r.length - 2]) < 1e-15 && Math.abs(r[1] - r[r.length - 1]) < 1e-15) r.length -= 2;
  if (r.length < 6) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]);
    x1 = Math.max(x1, r[i]);
    y0 = Math.min(y0, r[i + 1]);
    y1 = Math.max(y1, r[i + 1]);
  }
  r.push(r[0], r[1]);
  return { ring: r, box: [x0, y0, x1, y1] };
}

/**
 * Whether a shape meets a selection polygon (lasso or polygon selection): one of its points inside, one of its lines or
 * rings crossing the polygon's outline or lying inside it, or the polygon wholly inside one of the shape's areas (not in
 * a hole). The polygon is taken at the world copy nearest the shape, so one drawn over the antimeridian reaches shapes
 * on both sides.
 */
export function shapeInPolygon(p: Prepared, sel: SelPolygon): boolean {
  if (!p.box) return false;
  const k = turnsTo((sel.box[0] + sel.box[2]) / 2, (p.box[0] + p.box[2]) / 2);
  const [x0, y0, x1, y1] = [sel.box[0] + k, sel.box[1], sel.box[2] + k, sel.box[3]];
  if (p.box[2] < x0 || p.box[0] > x1 || p.box[3] < y0 || p.box[1] > y1) return false;
  const ring = k ? sel.ring.map((v, i) => (i % 2 ? v : v + k)) : sel.ring;
  const rings = [ring];
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && pointInRings(rings, x, y);
  for (let i = 0; i < p.points.length; i += 2) if (inside(p.points[i], p.points[i + 1])) return true;
  for (const r of [...p.lines, ...p.polys.flat()]) {
    if (r.length >= 2 && inside(r[0], r[1])) return true;
    for (let i = 0; i + 3 < r.length; i += 2) {
      const [ax, ay, bx, by] = [r[i], r[i + 1], r[i + 2], r[i + 3]];
      // a segment wholly outside the polygon's box cannot cross it
      if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue;
      for (let j = 0; j + 3 < ring.length; j += 2) if (segmentsMeet(ax, ay, bx, by, ring[j], ring[j + 1], ring[j + 2], ring[j + 3])) return true;
    }
  }
  // no outline crosses: the polygon is wholly inside one of the shape's areas, or apart from the shape
  for (const poly of p.polys) if (pointInRings(poly, ring[0], ring[1])) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------
// drawn shapes → GeoJSON
// ------------------------------------------------------------------------------------------------

export type DrawKind = "point" | "line" | "polygon";
/** [longitude, latitude]; longitudes of one drawn shape are continuous (may run past ±180 across the antimeridian). */
export type LonLat = [number, number];

const r7 = (v: number) => Math.round(v * 1e7) / 1e7 + 0;
const wrapLon = (lon: number) => {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lon > 0 ? 180 : w;
};
/** Signed area of a lon / lat ring (shoelace; > 0 counter-clockwise). */
export const ringSign = (ring: LonLat[]) => {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
};
const sameLL = (a: LonLat, b: LonLat) => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
const dedupe = (pts: LonLat[]) => pts.filter((q, i) => !i || !sameLL(q, pts[i - 1]));

/** Clip a closed ring (first = last) to lo ≤ lon ≤ hi (Sutherland–Hodgman against the two meridians). */
function clipRing(ring: LonLat[], lo: number, hi: number): LonLat[] {
  let pts = ring.slice(0, -1);
  for (const [edge, keep] of [
    [lo, (x: number) => x >= lo],
    [hi, (x: number) => x <= hi],
  ] as const) {
    const out: LonLat[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const [ina, inb] = [keep(a[0]), keep(b[0])];
      if (ina) out.push(a);
      if (ina !== inb) out.push([edge, a[1] + ((b[1] - a[1]) * (edge - a[0])) / (b[0] - a[0])]);
    }
    pts = out;
    if (!pts.length) break;
  }
  pts = dedupe(pts);
  if (pts.length > 1 && sameLL(pts[0], pts[pts.length - 1])) pts.pop();
  return pts.length >= 3 ? [...pts, pts[0]] : [];
}

/** A line's pieces split where it crosses the meridians lo / hi (each piece within one world). */
function splitLine(pts: LonLat[], lo: number, hi: number): LonLat[][] {
  const pieces: LonLat[][] = [];
  let cur: LonLat[] = [];
  const slot = (x: number) => Math.floor((x - lo) / (hi - lo));
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i) {
      const a = pts[i - 1];
      let sa = slot(a[0]);
      const sb = slot(p[0]);
      // every meridian between the two vertices
      while (sa !== sb) {
        const edge = lo + (sb > sa ? sa + 1 : sa) * (hi - lo);
        const q: LonLat = [edge, a[1] + ((p[1] - a[1]) * (edge - a[0])) / (p[0] - a[0])];
        cur.push(q);
        pieces.push(cur);
        cur = [q];
        sa += sb > sa ? 1 : -1;
      }
    }
    cur.push(p);
  }
  pieces.push(cur);
  return pieces.map(dedupe).filter((x) => x.length >= 2);
}

/** Longitudes moved by whole turns into [-180, 180] (a piece on the edge keeps its side: 180 stays 180). */
function intoRange(pts: LonLat[]): LonLat[] {
  const mid = (Math.min(...pts.map((q) => q[0])) + Math.max(...pts.map((q) => q[0]))) / 2;
  const k = -Math.round(mid / 360) * 360;
  return pts.map(([x, y]) => [r7(Math.max(-180, Math.min(180, x + k))), r7(y)]);
}

/**
 * A drawn shape as a GeoJSON geometry (WGS 84, valid as a geoshape): a Point; a LineString; a Polygon with its exterior
 * ring counter-clockwise (RFC 7946) and closed. Longitudes come back into [-180, 180]; a line or polygon crossing the
 * antimeridian is split there into a MultiLineString / MultiPolygon when `split` (else its longitudes run past 180, one
 * continuous shape). Null for too few positions.
 */
export function drawnGeometry(kind: DrawKind, pts: LonLat[], split = true): Geom | null {
  const ps = dedupe(pts.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])).map(([x, y]) => [x, Math.max(-90, Math.min(90, y))] as LonLat));
  if (!ps.length) return null;
  if (kind === "point") return { type: "Point", coordinates: [r7(wrapLon(ps[0][0])), r7(ps[0][1])] };
  // centre the shape in the world [-180, 180] first (its longitudes stay continuous)
  const lons = unwrapLons(ps.map((q) => q[0]));
  const mid = (Math.min(...lons) + Math.max(...lons)) / 2;
  // whole turns only when the middle is outside the world (a shape centred on 180 stays where it was drawn)
  const k = mid > 180 ? -Math.ceil((mid - 180) / 360) * 360 : mid < -180 ? Math.ceil((-180 - mid) / 360) * 360 : 0;
  const c: LonLat[] = ps.map((q, i) => [lons[i] + k, q[1]]);
  const crosses = c.some((q) => q[0] < -180 || q[0] > 180);
  if (kind === "line") {
    if (c.length < 2) return null;
    if (!crosses || !split) return { type: "LineString", coordinates: c.map(([x, y]) => [r7(x), r7(y)]) };
    const parts = splitLine(c, -180, 180).map(intoRange);
    return parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
  }
  let ring = [...c];
  if (ring.length > 1 && sameLL(ring[0], ring[ring.length - 1])) ring.pop();
  if (ring.length < 3) return null;
  ring = [...ring, ring[0]];
  if (ringSign(ring) < 0) ring.reverse();
  if (!crosses || !split) return { type: "Polygon", coordinates: [ring.map(([x, y]) => [r7(x), r7(y)])] };
  const parts: LonLat[][] = [];
  for (let w = -1; w <= 1; w++) {
    const part = clipRing(ring, -180 + 360 * w, 180 + 360 * w);
    if (part.length >= 4 && Math.abs(ringSign(part)) > 1e-14) parts.push(part.map(([x, y]) => [r7(x - 360 * w), r7(y)] as LonLat));
  }
  return parts.length === 1 ? { type: "Polygon", coordinates: [parts[0]] } : { type: "MultiPolygon", coordinates: parts.map((p) => [p]) };
}

/** A drawn shape: its kind, the positions as drawn (continuous longitudes, for measuring) and its GeoJSON geometry. */
export type DrawnShape = { id: string; kind: DrawKind; pts: LonLat[]; geom: Geom };

/** "feature": a FeatureCollection (one Feature per shape); "geometry": a GeometryCollection. */
export type ShapeOutput = "feature" | "geometry";

/** The drawn shapes as the variable's GeoJSON string ("" without shapes). */
export function shapesToString(shapes: DrawnShape[], output: ShapeOutput = "feature"): string {
  if (!shapes.length) return "";
  if (output === "geometry") return JSON.stringify({ type: "GeometryCollection", geometries: shapes.map((s) => s.geom) });
  return JSON.stringify({ type: "FeatureCollection", features: shapes.map((s) => ({ type: "Feature", id: s.id, properties: { kind: s.kind }, geometry: s.geom })) });
}

/** One shape as the selected-shape variable's GeoJSON string: a Feature, or the geometry itself. */
export function shapeToString(s: DrawnShape | null | undefined, output: ShapeOutput = "feature"): string {
  if (!s) return "";
  return JSON.stringify(output === "geometry" ? s.geom : { type: "Feature", id: s.id, properties: { kind: s.kind }, geometry: s.geom });
}

/** Positions of a geometry part for measuring (a MultiPolygon split at 180: each part on its own). */
const kindOfGeom = (t: string): DrawKind => (/Point/.test(t) ? "point" : /Line/.test(t) ? "line" : "polygon");

/**
 * Drawn shapes from a variable's GeoJSON (set from outside): a FeatureCollection / GeometryCollection is one shape per
 * feature / geometry, anything else one shape. Ids from features (else s1, s2, …).
 */
export function shapesFromString(text: unknown): DrawnShape[] {
  if (typeof text !== "string" || !text.trim().startsWith("{")) return [];
  let doc: { type?: string; features?: { id?: unknown; geometry?: unknown }[]; geometries?: unknown[] };
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const list: { id?: unknown; g: unknown }[] =
    doc?.type === "FeatureCollection" ? (doc.features ?? []).map((f) => ({ id: f?.id, g: f?.geometry })) : doc?.type === "GeometryCollection" ? (doc.geometries ?? []).map((g) => ({ g })) : [{ id: (doc as { id?: unknown })?.id, g: doc }];
  const out: DrawnShape[] = [];
  list.forEach(({ id, g }, i) => {
    const geom = parseShape(g);
    if (!geom || geom.type === "GeometryCollection") return;
    const kind = kindOfGeom(geom.type);
    const c = geom.coordinates as unknown;
    // the positions as drawn: a simple shape's own (a Multi* shape: its first part with longitudes made continuous)
    const first = (x: unknown): LonLat[] => (Array.isArray(x) ? (x as LonLat[]) : []);
    const pts: LonLat[] =
      geom.type === "Point" ? [c as LonLat] : geom.type === "LineString" ? first(c) : geom.type === "Polygon" ? first((c as unknown[])[0]) : geom.type === "MultiPoint" ? first(c).slice(0, 1) : geom.type === "MultiLineString" ? first((c as unknown[])[0]) : first(((c as unknown[][])[0] ?? [])[0]);
    out.push({ id: id !== undefined && id !== null && id !== "" ? String(id) : `s${i + 1}`, kind, pts, geom });
  });
  return out;
}

/** The value a drawn shape gives an action parameter: a geopoint "lat,lon" (a point, else the middle of its box) or a
 * geoshape's GeoJSON geometry string. */
export function paramValue(s: DrawnShape, type: string): string {
  if (type === "geopoint") {
    let lon: number;
    let lat: number;
    if (s.geom.type === "Point") [lon, lat] = s.geom.coordinates as LonLat;
    else {
      const lons = unwrapLons(s.pts.map((q) => q[0]));
      lon = wrapLon((Math.min(...lons) + Math.max(...lons)) / 2);
      lat = (Math.min(...s.pts.map((q) => q[1])) + Math.max(...s.pts.map((q) => q[1]))) / 2;
    }
    return `${r7(lat)},${r7(lon)}`;
  }
  return JSON.stringify(s.geom);
}

/** World units (x, y) → [lon, lat] (lon not wrapped: continuous across the antimeridian). */
export const lonLatOf = (x: number, y: number): LonLat => [lonOfX(x), latOfY(y)];
/** [lon, lat] → world units. */
export const worldOf = (q: LonLat): [number, number] => [mercX(q[0]), mercY(q[1])];

// ------------------------------------------------------------------------------------------------
// geodesic measures on WGS 84
// ------------------------------------------------------------------------------------------------

const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const rad = (d: number) => (d * Math.PI) / 180;

/** The great-circle distance (m) on the mean sphere (R = 6,371,008.8 m): the fallback for nearly antipodal points. */
export function haversine(a: LonLat, b: LonLat): number {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The geodesic distance (m) between two positions on the WGS 84 ellipsoid (Vincenty's inverse formula, sub-millimetre;
 * the mean-sphere distance where it does not converge, nearly antipodal points). */
export function geodesicDistance(a: LonLat, b: LonLat): number {
  const L = rad(b[0] - a[0]);
  const U1 = Math.atan((1 - F) * Math.tan(rad(a[1])));
  const U2 = Math.atan((1 - F) * Math.tan(rad(b[1])));
  const [sU1, cU1, sU2, cU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)];
  let lam = L;
  for (let it = 0; it < 200; it++) {
    const sl = Math.sin(lam);
    const cl = Math.cos(lam);
    const sS = Math.hypot(cU2 * sl, cU1 * sU2 - sU1 * cU2 * cl);
    if (sS === 0) return 0;
    const cS = sU1 * sU2 + cU1 * cU2 * cl;
    const sig = Math.atan2(sS, cS);
    const sA = (cU1 * cU2 * sl) / sS;
    const c2A = 1 - sA * sA;
    const c2Sm = c2A ? cS - (2 * sU1 * sU2) / c2A : 0;
    const C = (F / 16) * c2A * (4 + F * (4 - 3 * c2A));
    const prev = lam;
    lam = L + (1 - C) * F * sA * (sig + C * sS * (c2Sm + C * cS * (-1 + 2 * c2Sm * c2Sm)));
    if (Math.abs(lam - prev) < 1e-12) {
      const u2 = (c2A * (A * A - B * B)) / (B * B);
      const AA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
      const BB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
      const dS = BB * sS * (c2Sm + (BB / 4) * (cS * (-1 + 2 * c2Sm * c2Sm) - (BB / 6) * c2Sm * (-3 + 4 * sS * sS) * (-3 + 4 * c2Sm * c2Sm)));
      return B * AA * (sig - dS);
    }
  }
  return haversine(a, b);
}

/** The geodesic length (m) of each segment of a line. */
export const segmentLengths = (pts: LonLat[]) => pts.slice(1).map((q, i) => geodesicDistance(pts[i], q));
/** The geodesic length (m) of a line. */
export const lineLength = (pts: LonLat[]) => segmentLengths(pts).reduce((s, x) => s + x, 0);

// authalic sphere: same surface area as WGS 84; latitudes mapped to authalic latitudes, so areas are kept
const qOf = (phi: number) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const QP = qOf(Math.PI / 2);
/** The radius (m) of the sphere with the WGS 84 ellipsoid's surface area (6,371,007.18 m). */
export const AUTHALIC_R = A * Math.sqrt(QP / 2);
const authalic = (lat: number) => Math.asin(Math.max(-1, Math.min(1, qOf(rad(lat)) / QP)));

/**
 * The area (m², unsigned) of a ring of positions (closed or not), its edges great circles on the authalic sphere
 * (equal-area: within about 0.05 % of the ellipsoidal geodesic area for country-sized polygons). Longitude steps are
 * taken the short way, so a ring across the antimeridian measures as drawn.
 */
export function ringArea(ring: LonLat[]): number {
  const pts = ring.length > 1 && sameLL(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    let d = rad(q[0] - p[0]);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const t1 = Math.tan(authalic(p[1]) / 2);
    const t2 = Math.tan(authalic(q[1]) / 2);
    // the signed area of the triangle the edge makes with the north pole (exact on the sphere)
    sum += 2 * Math.atan2(Math.tan(d / 2) * (t1 + t2), 1 + t1 * t2);
  }
  let s = Math.abs(sum);
  // a ring around a pole: the other side
  if (s > 2 * Math.PI) s = 4 * Math.PI - s;
  return s * AUTHALIC_R * AUTHALIC_R;
}

/** A geometry's measures: the area (m², polygons less their holes), the perimeter of its polygons and the length of its
 * lines (m, geodesic). */
export function measureGeom(g: Geom): { area: number; perimeter: number; length: number } {
  const out = { area: 0, perimeter: 0, length: 0 };
  const poly = (rings: unknown) => {
    if (!Array.isArray(rings)) return;
    (rings as LonLat[][]).forEach((r, i) => {
      out.area += (i ? -1 : 1) * ringArea(r);
      out.perimeter += lineLength(r.length && !sameLL(r[0], r[r.length - 1]) ? [...r, r[0]] : r);
    });
  };
  const walk = (x: Geom) => {
    const c = x.coordinates as unknown[];
    if (x.type === "Polygon") poly(c);
    else if (x.type === "MultiPolygon") c.forEach(poly);
    else if (x.type === "LineString") out.length += lineLength(c as LonLat[]);
    else if (x.type === "MultiLineString") (c as LonLat[][]).forEach((l) => (out.length += lineLength(l)));
    else if (x.type === "GeometryCollection") (x.geometries ?? []).forEach(walk);
  };
  walk(g);
  out.area = Math.max(0, out.area);
  return out;
}

export type Units = "metric" | "imperial";

const fix = (v: number, d: number) => {
  const s = v.toFixed(d);
  return d ? s.replace(/\.?0+$/, "") : s;
};
const digits = (v: number) => (v >= 100 ? 0 : v >= 10 ? 1 : 2);

/** A length for a label: m / km, or ft / mi. */
export function fmtLength(m: number, units: Units = "metric"): string {
  if (units === "imperial") {
    const ft = m / 0.3048;
    if (ft < 5280) return `${Math.round(ft).toLocaleString("en-US")} ft`;
    const mi = m / 1609.344;
    return `${fix(mi, digits(mi))} mi`;
  }
  if (m < 1000) return `${fix(m, m < 10 ? 2 : m < 100 ? 1 : 0)} m`;
  const km = m / 1000;
  return `${km >= 1000 ? Math.round(km).toLocaleString("en-US") : fix(km, digits(km))} km`;
}

/** An area for a label: m² / ha / km², or ft² / acres / mi². */
export function fmtArea(m2: number, units: Units = "metric"): string {
  if (units === "imperial") {
    const ft2 = m2 / 0.09290304;
    if (ft2 < 43560) return `${Math.round(ft2).toLocaleString("en-US")} ft²`;
    const ac = m2 / 4046.8564224;
    if (ac < 640) return `${fix(ac, digits(ac))} acres`;
    const mi2 = m2 / 2589988.110336;
    return `${mi2 >= 1000 ? Math.round(mi2).toLocaleString("en-US") : fix(mi2, digits(mi2))} mi²`;
  }
  if (m2 < 10000) return `${Math.round(m2).toLocaleString("en-US")} m²`;
  if (m2 < 1e6) return `${fix(m2 / 10000, digits(m2 / 10000))} ha`;
  const km2 = m2 / 1e6;
  return `${km2 >= 1000 ? Math.round(km2).toLocaleString("en-US") : fix(km2, digits(km2))} km²`;
}

/** Where a segment's label goes: the middle of the segment in world units (the shorter way round). */
export function midWorld(a: LonLat, b: LonLat): [number, number] {
  const [ax, ay] = worldOf(a);
  const [bx0, by] = worldOf(b);
  const bx = bx0 + turnsTo(bx0, ax);
  return [(ax + bx) / 2, (ay + by) / 2];
}

/** The view's box for the server's geo filter, a tenth wider on each side: [min lon, min lat, max lon, max lat] with
 * longitudes in range (min lon > max lon across the antimeridian; -180 … 180 when the view spans the whole world). The
 * view: centre world pixel cx, cy at zoom z, w × h pixels. */
export function viewBbox(v: { z: number; cx: number; cy: number }, w: number, h: number): [number, number, number, number] {
  const s = 256 * 2 ** v.z;
  const [x0, x1] = [(v.cx - w * 0.6) / s, (v.cx + w * 0.6) / s];
  const [y0, y1] = [Math.max(0, (v.cy - h * 0.6) / s), Math.min(1, (v.cy + h * 0.6) / s)];
  const r = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
  if (x1 - x0 >= 1) return [-180, r(latOfY(y1)), 180, r(latOfY(y0))];
  const [a, b] = [wrapLon(lonOfX(x0)), wrapLon(lonOfX(x1))];
  return [r(a === 180 ? -180 : a), r(latOfY(y1)), r(b === -180 ? 180 : b), r(latOfY(y0))];
}

/** The distance in world units from (x, y) to a drawn shape's outline / points (for picking it); 0 inside one of its
 * areas unless `interior` is false (then only the outline counts). */
export function distToDrawn(p: Prepared, x: number, y: number, interior = true): number {
  if (!p.box) return Infinity;
  x += turnsTo(x, (p.box[0] + p.box[2]) / 2);
  let d = Infinity;
  for (let i = 0; i < p.points.length; i += 2) d = Math.min(d, Math.hypot(x - p.points[i], y - p.points[i + 1]));
  for (const l of [...p.lines, ...p.polys.flat()]) d = Math.min(d, distToLine(l, x, y));
  if (interior) for (const poly of p.polys) if (pointInRings(poly, x, y)) d = 0;
  return d;
}

// ------------------------------------------------------------------------------------------------
// shape editing (Modify): a drawn shape's vertices moved / added / removed, or the whole shape moved
// ------------------------------------------------------------------------------------------------

/**
 * An editable part of a shape: a line, a polygon ring (kept open here: no closing position) or a point, with
 * continuous longitudes. `path`: where it sits in the geometry's coordinates (empty for a shape edited as drawn).
 */
export type EditPart = { path: number[]; ring: boolean; pts: LonLat[] };
/** A shape's editable parts: `asDrawn` (one part, the positions as drawn, the geometry made again from them: split at
 * the antimeridian, rings counter-clockwise) or the geometry's own lines / rings / points, edited in place. */
export type EditShape = { asDrawn: boolean; parts: EditPart[] };

const openRing = (r: LonLat[]) => (r.length > 1 && sameLL(r[0], r[r.length - 1]) ? r.slice(0, -1) : r);
const continuous = (pts: LonLat[]): LonLat[] => {
  const lons = unwrapLons(pts.map((q) => q[0]));
  return pts.map((q, i) => [lons[i], q[1]]);
};
const posList = (x: unknown): LonLat[] => (Array.isArray(x) ? (x as unknown[]).filter((q): q is LonLat => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])).map((q) => [q[0], q[1]]) : []);

/**
 * How a shape is edited. A shape whose geometry is what its drawn positions give (drawn here, or a simple point / line /
 * one-ring polygon set from outside) is edited as drawn; any other (holes, several parts set from outside) part by part.
 */
export function editShapeOf(s: DrawnShape, split = true): EditShape {
  const g = s.geom;
  const simple = g.type === "Point" || g.type === "LineString" || (g.type === "Polygon" && Array.isArray(g.coordinates) && (g.coordinates as unknown[]).length === 1);
  const same = (x: Geom | null) => !!x && JSON.stringify(x) === JSON.stringify(g);
  if (s.pts.length && (simple || same(drawnGeometry(s.kind, s.pts, split)) || same(drawnGeometry(s.kind, s.pts, !split)))) {
    const pts = s.kind === "polygon" ? openRing(s.pts) : s.kind === "point" ? s.pts.slice(0, 1) : s.pts;
    return { asDrawn: true, parts: [{ path: [], ring: s.kind === "polygon", pts: continuous(pts) }] };
  }
  const parts: EditPart[] = [];
  const c = g.coordinates as unknown[];
  if (g.type === "Point") parts.push({ path: [], ring: false, pts: posList([c]) });
  else if (g.type === "MultiPoint") posList(c).forEach((q, i) => parts.push({ path: [i], ring: false, pts: [q] }));
  else if (g.type === "LineString") parts.push({ path: [], ring: false, pts: continuous(posList(c)) });
  else if (g.type === "MultiLineString") c.forEach((l, i) => parts.push({ path: [i], ring: false, pts: continuous(posList(l)) }));
  else if (g.type === "Polygon") c.forEach((r, i) => parts.push({ path: [i], ring: true, pts: continuous(openRing(posList(r))) }));
  else if (g.type === "MultiPolygon") c.forEach((p, i) => (Array.isArray(p) ? p : []).forEach((r, j) => parts.push({ path: [i, j], ring: true, pts: continuous(openRing(posList(r))) })));
  return { asDrawn: false, parts: parts.filter((p) => p.pts.length) };
}

/** The fewest positions a part keeps: a ring 3, a line 2, a point 1. */
export const minVertices = (p: EditPart) => (p.ring ? 3 : p.pts.length === 1 ? 1 : 2);

const withPart = (e: EditShape, i: number, pts: LonLat[]): EditShape => ({ ...e, parts: e.parts.map((p, j) => (j === i ? { ...p, pts } : p)) });

/** A vertex moved to `to` (its longitude taken the short way from where it was, so a shape stays continuous). */
export function moveVertex(e: EditShape, part: number, vertex: number, to: LonLat): EditShape {
  const p = e.parts[part];
  if (!p || !p.pts[vertex]) return e;
  const lon = to[0] + turnsTo(to[0], p.pts[vertex][0], 360);
  return withPart(e, part, p.pts.map((q, i) => (i === vertex ? [lon, Math.max(-90, Math.min(90, to[1]))] : q)));
}

/** A vertex added after `after` (a ring's last edge closes to its first vertex). */
export function insertVertex(e: EditShape, part: number, after: number, at: LonLat): EditShape {
  const p = e.parts[part];
  if (!p || after < 0 || after >= p.pts.length || (!p.ring && after >= p.pts.length - 1)) return e;
  const near = p.pts[after][0];
  const q: LonLat = [at[0] + turnsTo(at[0], near, 360), at[1]];
  return withPart(e, part, [...p.pts.slice(0, after + 1), q, ...p.pts.slice(after + 1)]);
}

/** A vertex removed; null when the part would be left with too few (a ring 3, a line 2). */
export function removeVertex(e: EditShape, part: number, vertex: number): EditShape | null {
  const p = e.parts[part];
  if (!p || !p.pts[vertex] || p.pts.length <= minVertices(p) || p.pts.length === 1) return null;
  return withPart(e, part, p.pts.filter((_, i) => i !== vertex));
}

/** Every part moved by dx, dy world units (the shape keeps its look on the map: positions move in Web Mercator). */
export function translateShape(e: EditShape, dx: number, dy: number): EditShape {
  return {
    ...e,
    parts: e.parts.map((p) => ({
      ...p,
      pts: p.pts.map(([lon, lat]) => {
        const y = mercY(lat) + dy;
        return [lon + dx * 360, latOfY(Math.max(0, Math.min(1, y)))] as LonLat;
      }),
    })),
  };
}

/** The middle of each edge (where a new vertex is dragged out), as [after, lon / lat]. */
export function edgeMiddles(p: EditPart): [number, LonLat][] {
  if (p.pts.length < 2) return [];
  const n = p.ring ? p.pts.length : p.pts.length - 1;
  const out: [number, LonLat][] = [];
  for (let i = 0; i < n; i++) {
    const a = p.pts[i];
    const b = p.pts[(i + 1) % p.pts.length];
    const bx = b[0] + turnsTo(b[0], a[0], 360);
    out.push([i, lonLatOf((mercX(a[0]) + mercX(bx)) / 2, (mercY(a[1]) + mercY(b[1])) / 2)]);
  }
  return out;
}

/** A part's longitudes moved by whole turns so its middle is in [-180, 180], then kept within it. */
function partInRange(pts: LonLat[]): LonLat[] {
  if (!pts.length) return pts;
  const mid = (Math.min(...pts.map((q) => q[0])) + Math.max(...pts.map((q) => q[0]))) / 2;
  const k = turnsTo(mid, 0, 360);
  return pts.map(([x, y]) => [r7(Math.max(-180, Math.min(180, x + k))), r7(Math.max(-90, Math.min(90, y)))]);
}

/**
 * The shape after editing (null when it cannot be made: a drawn line with fewer than two positions). As drawn: its
 * geometry made again from the positions (`split` at the antimeridian, ring counter-clockwise). In place: each line /
 * ring / point written back (longitudes into range, rings closed, exterior rings counter-clockwise and holes clockwise).
 */
export function applyEdit(s: DrawnShape, e: EditShape, split = true): DrawnShape | null {
  if (e.asDrawn) {
    const pts = e.parts[0]?.pts ?? [];
    const geom = drawnGeometry(s.kind, pts, split);
    return geom ? { ...s, pts, geom } : null;
  }
  const at = (path: number[]) => e.parts.find((p) => p.path.length === path.length && p.path.every((v, i) => v === path[i]));
  const ring = (path: number[], exterior: boolean, before: unknown): unknown => {
    const p = at(path);
    if (!p) return before;
    const r = partInRange(p.pts);
    const closed = [...r, r[0]];
    return (ringSign(closed) < 0) === exterior ? closed.reverse() : closed;
  };
  const g = s.geom;
  const c = g.coordinates as unknown[];
  let coordinates: unknown;
  const part = (path: number[], before: unknown) => {
    const p = at(path);
    return p ? partInRange(p.pts) : before;
  };
  if (g.type === "Point") coordinates = (part([], [c]) as unknown[])[0];
  else if (g.type === "MultiPoint") coordinates = c.map((q, i) => (part([i], [q]) as unknown[])[0]);
  else if (g.type === "LineString") coordinates = part([], c);
  else if (g.type === "MultiLineString") coordinates = c.map((l, i) => part([i], l));
  else if (g.type === "Polygon") coordinates = c.map((r, i) => ring([i], i === 0, r));
  else if (g.type === "MultiPolygon") coordinates = c.map((poly, i) => (Array.isArray(poly) ? poly : []).map((r, j) => ring([i, j], j === 0, r)));
  else return null;
  const geom: Geom = { type: g.type, coordinates };
  return { ...s, geom, pts: e.parts[0]?.pts ?? s.pts };
}

// ------------------------------------------------------------------------------------------------
// timeline: a time window over the layers' time property
// ------------------------------------------------------------------------------------------------

/** A time value in epoch ms: a number (seconds below 1e11), a date "YYYY-MM-DD" (UTC midnight) or a timestamp. */
export function timeOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? (Math.abs(v) < 1e11 ? v * 1000 : v) : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return timeOf(Number(s));
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? null : t;
}

export type TimeWindow = [number, number];

/** The smallest window holding every time (null without any). */
export function timeExtent(times: (number | null | undefined)[]): TimeWindow | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of times)
    if (typeof t === "number" && Number.isFinite(t)) {
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  return lo <= hi ? [lo, hi] : null;
}

/** Whether a time is shown: inside the window (both ends included), or at / before its end ("cumulative"). Objects
 * without a time are not shown while the timeline filters. */
export const inWindow = (t: number | null | undefined, w: TimeWindow, mode: "window" | "cumulative" = "window") =>
  typeof t === "number" && t <= w[1] && (mode === "cumulative" || t >= w[0]);

/**
 * The next window of playback: moved forward by `step` (default its own width); past the end of the extent it starts
 * again at the extent's start (keeping its width). A window as wide as the extent stays put.
 */
export function stepWindow(w: TimeWindow, extent: TimeWindow, step?: number): TimeWindow {
  const width = Math.max(0, w[1] - w[0]);
  const by = step && step > 0 ? step : width;
  if (!by || width >= extent[1] - extent[0]) return w;
  if (w[1] >= extent[1]) return [extent[0], extent[0] + width];
  const end = Math.min(extent[1], w[1] + by);
  return [end - width, end];
}

/** Auto pause: the earliest of `times` that playback passes when the window's end moves from `from` to `to` (later
 * than from, at or before to), or null. */
export function pauseBetween(times: unknown, from: number, to: number): number | null {
  if (!(to > from)) return null;
  let best: number | null = null;
  for (const v of Array.isArray(times) ? times : times === undefined || times === null || times === "" ? [] : [times]) {
    const t = timeOf(v);
    if (t !== null && t > from && t <= to && (best === null || t < best)) best = t;
  }
  return best;
}

/** The window playback moves to next, stopping at an auto pause time on the way: the window ends there (its width
 * kept) and `pause` is that time. */
export function playStep(w: TimeWindow, extent: TimeWindow, pauses?: unknown): { win: TimeWindow; pause: number | null } {
  const next = stepWindow(w, extent);
  // a jump back to the start (the end of the extent was reached) passes no pause time
  const at = next[1] > w[1] ? pauseBetween(pauses, w[1], next[1]) : null;
  if (at === null) return { win: next, pause: null };
  const width = w[1] - w[0];
  return { win: [Math.max(extent[0], at - width), at], pause: at };
}

/** The window while "View latest" is on: ending at the newest time there is (the extent's end), its width kept. */
export const latestWindow = (w: TimeWindow, extent: TimeWindow, mode: "window" | "cumulative"): TimeWindow =>
  mode === "cumulative" ? [w[0], extent[1]] : [Math.max(extent[0], extent[1] - Math.max(0, w[1] - w[0])), extent[1]];

export type Clock = "local" | "12h" | "24h";
const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * A time for the timeline: the date (YYYY-MM-DD) in UTC or the viewer's zone, with the time of day when `withTime`.
 * The clock: 24-hour (UTC always), 12-hour ("3:05 PM") or the viewer's locale's own ("local").
 */
export function fmtClock(ms: number, utc: boolean, withTime: boolean, clock: Clock = "24h", seconds = false): string {
  const d = new Date(ms);
  const [y, mo, da, h, mi, s] = utc ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()] : [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  const date = `${y}-${p2(mo + 1)}-${p2(da)}`;
  if (!withTime) return date;
  const sec = seconds ? `:${p2(s)}` : "";
  if (utc || clock === "24h") return `${date} ${p2(h)}:${p2(mi)}${sec}`;
  if (clock === "12h") return `${date} ${h % 12 || 12}:${p2(mi)}${sec} ${h < 12 ? "AM" : "PM"}`;
  return `${date} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) })}`;
}

/** A window kept inside the extent (its width kept where it fits) and at least `min` wide. */
export function clampWindow(w: TimeWindow, extent: TimeWindow, min = 0): TimeWindow {
  let [a, b] = w[0] <= w[1] ? w : [w[1], w[0]];
  const span = extent[1] - extent[0];
  if (b - a > span) [a, b] = extent;
  if (a < extent[0]) [a, b] = [extent[0], extent[0] + (b - a)];
  if (b > extent[1]) [a, b] = [extent[1] - (b - a), extent[1]];
  if (b - a < min) b = Math.min(extent[1], a + min);
  return [a, b];
}

/** A time for a variable of the given type: a date "YYYY-MM-DD" (UTC), a number (epoch ms), else an ISO timestamp. */
export function timeForVariable(ms: number, type: string | undefined): string | number {
  if (type === "number") return ms;
  const iso = new Date(ms).toISOString();
  return type === "date" ? iso.slice(0, 10) : iso;
}

const STEPS = [1e3, 5e3, 15e3, 6e4, 3e5, 9e5, 36e5, 6 * 36e5, 864e5, 7 * 864e5, 30 * 864e5, 61 * 864e5, 91 * 864e5, 182 * 864e5, 365 * 864e5];
/** Tick times between two times (about `n` of them, on a round step). */
export function timeTicks(lo: number, hi: number, n = 6): number[] {
  if (!(hi > lo)) return [lo];
  const want = (hi - lo) / n;
  let step = STEPS.find((s) => s >= want) ?? Math.ceil(want / (365 * 864e5)) * 365 * 864e5;
  if (step >= 30 * 864e5) {
    // months and years on calendar boundaries (UTC)
    const months = step >= 365 * 864e5 ? 12 * Math.max(1, Math.round(step / (365 * 864e5))) : Math.max(1, Math.round(step / (30 * 864e5)));
    const d = new Date(lo);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    m = Math.ceil(m / months) * months;
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
      if (t > hi) break;
      if (t >= lo) out.push(t);
      m += months;
      if (m >= 12) {
        y += Math.floor(m / 12);
        m %= 12;
      }
    }
    return out;
  }
  step = Math.max(step, 1);
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi && out.length < 200; t += step) out.push(t);
  return out;
}
