/**
 * A small Mapbox Vector Tile (MVT 2.1) decoder: protobuf wire reading (varint, zigzag, fixed32/64, length-delimited),
 * the tile's layers, their features, keys / values and geometry commands (MoveTo, LineTo, ClosePath), projected from
 * tile coordinates (0..extent) to lon / lat for a tile z/x/y. Gzip-compressed tiles are inflated with
 * DecompressionStream. No dependencies: used by the Map app's "Vector tiles" layer and the Slate map's vector layer.
 */

export type MvtValue = string | number | boolean | null;
export type MvtGeomType = 0 | 1 | 2 | 3; // UNKNOWN, POINT, LINESTRING, POLYGON
export type MvtFeature = {
  id: number | null;
  type: MvtGeomType;
  properties: Record<string, MvtValue>;
  /** geometry in tile coordinates: parts (MoveTo starts a part), each a list of [x, y] */
  parts: [number, number][][];
};
export type MvtLayer = { name: string; version: number; extent: number; features: MvtFeature[] };
export type MvtTile = { layers: MvtLayer[] };

export type LonLat = [number, number];
export type GeoGeometry =
  | { type: "Point"; coordinates: LonLat }
  | { type: "MultiPoint"; coordinates: LonLat[] }
  | { type: "LineString"; coordinates: LonLat[] }
  | { type: "MultiLineString"; coordinates: LonLat[][] }
  | { type: "Polygon"; coordinates: LonLat[][] }
  | { type: "MultiPolygon"; coordinates: LonLat[][][] };
export type GeoFeature = { type: "Feature"; id: number | null; layer: string; properties: Record<string, MvtValue>; geometry: GeoGeometry };

// ------------------------------------------------------------------------------------------------ protobuf reading

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.end = buf.length;
  }
  /** an unsigned varint up to 64 bits (exact up to 2^53) */
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new Error("varint longer than 10 bytes");
  }
  /** a signed 64-bit int encoded as a two's complement varint (int64) */
  int64(): number {
    let v = BigInt(0);
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      v |= BigInt(b & 0x7f) << BigInt(7 * i);
      if (b < 0x80) return Number(BigInt.asIntN(64, v));
    }
    throw new Error("varint longer than 10 bytes");
  }
  bytes(): Uint8Array {
    const n = this.varint();
    if (this.pos + n > this.end) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  string(): string {
    return new TextDecoder().decode(this.bytes());
  }
  float(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  double(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const n = this.varint(); // read the length before adding: `pos += varint()` would add to the old pos
      this.pos += n;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
    if (this.pos > this.end) throw new Error("truncated field");
  }
  /** each field of the message: (field number, wire type) */
  *fields(): Generator<[number, number]> {
    while (this.pos < this.end) {
      const tag = this.varint();
      yield [Math.floor(tag / 8), tag & 7];
    }
  }
  /** a packed repeated uint32 (or a single unpacked one) */
  packed(wire: number): number[] {
    if (wire !== 2) return [this.varint()];
    const b = this.bytes();
    const r = new Reader(b);
    const out: number[] = [];
    while (r.pos < r.end) out.push(r.varint());
    return out;
  }
}

/** zigzag decoding (sint32 / sint64) */
export const zigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

function readValue(buf: Uint8Array): MvtValue {
  const r = new Reader(buf);
  let v: MvtValue = null;
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) v = r.string();
    else if (f === 2 && w === 5) v = r.float();
    else if (f === 3 && w === 1) v = r.double();
    else if (f === 4 && w === 0) v = r.int64();
    else if (f === 5 && w === 0) v = r.varint();
    else if (f === 6 && w === 0) v = zigzag(r.varint());
    else if (f === 7 && w === 0) v = r.varint() !== 0;
    else r.skip(w);
  }
  return v;
}

/** Geometry commands → parts in tile coordinates. ClosePath closes the current part (the first point is repeated). */
export function decodeGeometry(cmds: number[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++];
    const id = c & 7;
    const count = c >>> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        if (i + 1 >= cmds.length) throw new Error("truncated geometry");
        x += zigzag(cmds[i++]);
        y += zigzag(cmds[i++]);
        if (id === 1) {
          cur = [];
          parts.push(cur);
        }
        if (!cur) throw new Error("LineTo before MoveTo");
        cur.push([x, y]);
      }
    } else if (id === 7) {
      if (cur && cur.length) cur.push([cur[0][0], cur[0][1]]);
    } else throw new Error(`unknown geometry command ${id}`);
  }
  return parts;
}

function readFeature(buf: Uint8Array, keys: string[], values: MvtValue[]): MvtFeature {
  const r = new Reader(buf);
  let id: number | null = null;
  let type: MvtGeomType = 0;
  let tags: number[] = [];
  let geom: number[] = [];
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 0) id = r.varint();
    else if (f === 2) tags = tags.concat(r.packed(w));
    else if (f === 3 && w === 0) type = (r.varint() & 3) as MvtGeomType;
    else if (f === 4) geom = geom.concat(r.packed(w));
    else r.skip(w);
  }
  const properties: Record<string, MvtValue> = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const k = keys[tags[i]];
    if (k !== undefined) properties[k] = values[tags[i + 1]] ?? null;
  }
  return { id, type, properties, parts: decodeGeometry(geom) };
}

function readLayer(buf: Uint8Array): MvtLayer {
  const r = new Reader(buf);
  let name = "";
  let version = 1;
  let extent = 4096;
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const raw: Uint8Array[] = [];
  for (const [f, w] of r.fields()) {
    if (f === 15 && w === 0) version = r.varint();
    else if (f === 1 && w === 2) name = r.string();
    else if (f === 2 && w === 2) raw.push(r.bytes());
    else if (f === 3 && w === 2) keys.push(r.string());
    else if (f === 4 && w === 2) values.push(readValue(r.bytes()));
    else if (f === 5 && w === 0) extent = r.varint() || 4096;
    else r.skip(w);
  }
  // features last: they refer to keys / values that may come after them in the message
  return { name, version, extent, features: raw.map((b) => readFeature(b, keys, values)) };
}

/** Decode an (uncompressed) MVT protobuf. */
export function decodeTile(bytes: Uint8Array | ArrayBuffer): MvtTile {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const r = new Reader(buf);
  const layers: MvtLayer[] = [];
  for (const [f, w] of r.fields()) {
    if (f === 3 && w === 2) layers.push(readLayer(r.bytes()));
    else r.skip(w);
  }
  return { layers };
}

export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Inflate gzip bytes (DecompressionStream); other bytes come back unchanged. */
export async function gunzipIfNeeded(bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isGzip(b)) return b;
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ------------------------------------------------------------------------------------------------ to lon / lat

/** Signed area by the surveyor's formula, in tile coordinates (y down): positive = exterior ring (MVT 2.1 §4.3.4.4). */
export function ringArea(ring: [number, number][]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
}

/** Group polygon rings into polygons: an exterior ring followed by its interior rings. */
export function classifyRings(rings: [number, number][][]): [number, number][][][] {
  const polys: [number, number][][][] = [];
  let poly: [number, number][][] | null = null;
  let exteriorSign = 0;
  for (const ring of rings) {
    const a = ringArea(ring);
    if (a === 0) continue;
    // version 1 tiles may wind the other way: the first ring sets which sign is exterior
    if (!exteriorSign) exteriorSign = Math.sign(a);
    if (Math.sign(a) === exteriorSign) {
      poly = [ring];
      polys.push(poly);
    } else if (poly) poly.push(ring);
  }
  return polys;
}

/** A tile-coordinate projector to [lon, lat] for tile z/x/y of the given extent. */
export function tileProjector(z: number, x: number, y: number, extent: number) {
  const n = 2 ** z;
  return ([px, py]: [number, number]): LonLat => {
    const gx = (x + px / extent) / n;
    const gy = (y + py / extent) / n;
    const lon = gx * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180) / Math.PI;
    return [lon, lat];
  };
}

/** A feature as GeoJSON in lon / lat; null for UNKNOWN or empty geometry. */
export function toGeoJSON(f: MvtFeature, layer: MvtLayer, z: number, x: number, y: number): GeoFeature | null {
  const pr = tileProjector(z, x, y, layer.extent);
  const proj = (part: [number, number][]) => part.map(pr);
  let geometry: GeoGeometry | null = null;
  if (f.type === 1) {
    const pts = f.parts.flat().map(pr);
    if (pts.length) geometry = pts.length === 1 ? { type: "Point", coordinates: pts[0] } : { type: "MultiPoint", coordinates: pts };
  } else if (f.type === 2) {
    const lines = f.parts.filter((p) => p.length >= 2).map(proj);
    if (lines.length) geometry = lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
  } else if (f.type === 3) {
    const polys = classifyRings(f.parts.filter((p) => p.length >= 4)).map((poly) => poly.map(proj));
    if (polys.length) geometry = polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
  }
  return geometry ? { type: "Feature", id: f.id, layer: layer.name, properties: f.properties, geometry } : null;
}

/** Every feature of a decoded tile as GeoJSON; `layers` (source-layer names) narrows it when non-empty. */
export function tileFeatures(tile: MvtTile, z: number, x: number, y: number, layers?: string[] | null): GeoFeature[] {
  const want = layers?.filter(Boolean) ?? [];
  const out: GeoFeature[] = [];
  for (const l of tile.layers) {
    if (want.length && !want.includes(l.name)) continue;
    for (const f of l.features) {
      const g = toGeoJSON(f, l, z, x, y);
      if (g) out.push(g);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tiles in view, loading

/** The tile URL for z/x/y of a template with {z} {x} {y} (and {-y} for TMS, {s} for a/b/c subdomains). */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{-y\}/g, String(2 ** z - 1 - y))
    .replace(/\{s\}/g, "abc"[(x + y) % 3]);
}

/** Whether a URL template can address tiles: http(s), with {z}, {x} and {y} (or {-y}). */
export const validTemplate = (t: string) => /^https?:\/\//i.test(t.trim()) && t.includes("{z}") && t.includes("{x}") && (t.includes("{y}") || t.includes("{-y}"));

/** The tiles (z, x, y) covering lon / lat bounds at zoom z; x wraps around the antimeridian. */
export function tilesFor(bounds: [number, number, number, number], z: number, max = 64): { z: number; x: number; y: number }[] {
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
    return Math.max(0, Math.min(n - 1, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)));
  };
  const [lon0, lat0, lon1, lat1] = bounds;
  const x0 = tx(lon0);
  const x1 = Math.min(tx(lon1), x0 + n - 1);
  const out: { z: number; x: number; y: number }[] = [];
  const seen = new Set<number>();
  for (let x = x0; x <= x1; x++)
    for (let y = ty(lat1); y <= ty(lat0); y++) {
      const wx = ((x % n) + n) % n;
      if (seen.has(wx * n + y)) continue;
      seen.add(wx * n + y);
      out.push({ z, x: wx, y });
      if (out.length >= max) return out;
    }
  return out;
}

const cache = new Map<string, Promise<MvtTile | null>>();
const CACHE_MAX = 400;

/** A tile that could not be loaded: status is the HTTP status (0: the request failed, -1: the tile could not be decoded). */
export class TileLoadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TileLoadError";
    this.status = status;
  }
}

/** Is a failure worth retrying? Network errors, timeouts, rate limits and server errors are; other 4xx and bad tiles are not. */
export const retryable = (e: unknown): boolean => {
  const s = e instanceof TileLoadError ? e.status : 0;
  return s === 0 || s === 408 || s === 425 || s === 429 || s >= 500;
};

/** Retries of a failed tile: at most this many, waiting retryDelay(n) before retry n (1, 2, 4, 8, 16 s; capped at 30 s). */
export const MAX_TILE_RETRIES = 5;
export const retryDelay = (attempt: number, base = 1000, cap = 30000) => Math.min(cap, base * 2 ** Math.max(0, attempt - 1));

/** Fetch and decode one tile (cached by URL; a 204 / 404 is an empty tile, other failures reject with a TileLoadError). */
export function loadTile(url: string, fetcher: typeof fetch = fetch): Promise<MvtTile | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    let r: Response;
    try {
      r = await fetcher(url);
    } catch (e) {
      throw new TileLoadError(`${(e as Error).message || "the request failed"} for ${url}`, 0);
    }
    if (r.status === 204 || r.status === 404) return null;
    if (!r.ok) {
      // the tile proxy says why (JSON detail)
      let why = r.statusText || "error";
      try {
        const j = (await r.json()) as { detail?: unknown };
        if (typeof j.detail === "string") why = j.detail;
      } catch {
        // not JSON
      }
      throw new TileLoadError(`${r.status} ${why} for ${url}`, r.status);
    }
    const bytes = await gunzipIfNeeded(await r.arrayBuffer());
    try {
      return decodeTile(bytes);
    } catch (e) {
      throw new TileLoadError(`not a vector tile (${(e as Error).message}) at ${url}`, -1);
    }
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return p;
}

/** A tile's own square in longitude / latitude: [west, south, east, north] (without the buffer around it). */
export function tileBox(z: number, x: number, y: number): [number, number, number, number] {
  const pr = tileProjector(z, x, y, 1);
  const [[w, n], [e, s]] = [pr([0, 0]), pr([1, 1])];
  return [w, s, e, n];
}

/** A ring clipped to a box (Sutherland–Hodgman; the box is convex), closed again; [] when nothing is left. */
function clipRing(ring: LonLat[], [w, s, e, n]: [number, number, number, number]): LonLat[] {
  let pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  const edges: [0 | 1, number, boolean][] = [[0, w, false], [0, e, true], [1, s, false], [1, n, true]];
  for (const [axis, lim, below] of edges) {
    const inside = (q: LonLat) => (below ? q[axis] <= lim : q[axis] >= lim);
    const cut = (a: LonLat, b: LonLat): LonLat => {
      const t = (lim - a[axis]) / (b[axis] - a[axis]);
      const q: LonLat = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      q[axis] = lim;
      return q;
    };
    const out: LonLat[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return [...pts, pts[0]];
}

/**
 * A polygon piece clipped to its tile's own square (tiles carry a buffer around it, so neighbouring tiles' pieces
 * overlap; clipped, they only meet along the seams). Other geometries come back as they are; null: nothing left.
 */
export function clipToBox(g: GeoGeometry, box: [number, number, number, number]): GeoGeometry | null {
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") return g;
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates)
    .map((poly) => {
      const outer = clipRing(poly[0], box);
      return outer.length ? [outer, ...poly.slice(1).map((h) => clipRing(h, box)).filter((h) => h.length)] : null;
    })
    .filter((p): p is LonLat[][] => !!p);
  if (!polys.length) return null;
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}

/**
 * One feature from the pieces the tiles hold of it (a feature crossing tiles is cut at each tile's edge, plus the
 * tile's buffer — clip the pieces with clipToBox first so they do not overlap): every polygon piece as one
 * MultiPolygon (parts meeting along the tile seams; a geo search unions them), likewise lines (MultiLineString) and
 * points (MultiPoint). A single piece comes back as it is; mixed kinds: the first piece's kind only.
 */
export function mergePieces(pieces: GeoGeometry[]): GeoGeometry | null {
  if (!pieces.length) return null;
  if (pieces.length === 1) return pieces[0];
  const kind = pieces[0].type.replace(/^Multi/, "");
  const same = pieces.filter((g) => g.type.replace(/^Multi/, "") === kind);
  if (same.length === 1) return same[0];
  if (kind === "Polygon")
    return { type: "MultiPolygon", coordinates: same.flatMap((g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [])) };
  if (kind === "LineString")
    return { type: "MultiLineString", coordinates: same.flatMap((g) => (g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [])) };
  // points: the same point in several tiles' buffers counts once
  const pts = new Map<string, LonLat>();
  for (const g of same) for (const q of g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" ? g.coordinates : []) pts.set(`${q[0]},${q[1]}`, q);
  return pts.size === 1 ? { type: "Point", coordinates: [...pts.values()][0] } : { type: "MultiPoint", coordinates: [...pts.values()] };
}
