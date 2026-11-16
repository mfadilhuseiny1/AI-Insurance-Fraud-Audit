/**
 * LAS point clouds for Vulcan, read here without a package: LAS 1.0–1.4, point data formats 0–10 (the coordinates with
 * the header's scale and offset, intensity, classification, return number and, in formats 2, 3, 5, 7, 8 and 10, the
 * RGB color). LAZ (LASzip-compressed LAS) is refused with the reason: no LASzip decoder is installed here.
 *
 * Big clouds are thinned to `maxPoints` by keeping every k-th point (the header says how many there are). Positions
 * are kept relative to `origin` (the center of the header bounds) as 32-bit floats, so large map coordinates (UTM)
 * keep their precision: place the points at `origin` to get the file's coordinates back.
 */

export type LasHeader = {
  version: string;
  /** the point data format id (0–10), compression bits cleared */
  pointFormat: number;
  recordLength: number;
  pointCount: number;
  headerSize: number;
  offsetToPoints: number;
  vlrCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  systemId: string;
  software: string;
  /** "day/year" of creation, as in the header */
  created: string | null;
  /** LASzip: the point format has the compression bit, or a "laszip encoded" VLR is present */
  compressed: boolean;
  /** WKT or GeoTIFF keys are present (the coordinate system is not interpreted here) */
  crs: "wkt" | "geotiff" | null;
};

export type LasCloud = {
  header: LasHeader;
  /** the file coordinates of position (0, 0, 0) */
  origin: [number, number, number];
  /** x, y, z per loaded point, relative to origin */
  positions: Float32Array;
  /** r, g, b in 0–1 per loaded point when the format has colors, else null */
  colors: Float32Array | null;
  /** intensity per loaded point, 0–1 of the largest intensity in the loaded points */
  intensity: Float32Array;
  classification: Uint8Array;
  /** points loaded (after thinning) and the step between them */
  loaded: number;
  step: number;
  /** loaded points by classification code */
  classes: Record<number, number>;
  /** bounds of the loaded points in file coordinates */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** colors were stored as 8-bit values (0–255) in the 16-bit fields */
  eightBitColor: boolean;
  warnings: string[];
};

export const LAS_MAX_POINTS = 3_000_000;

/** The ASPRS standard classes (LAS 1.4, codes 0–18). */
export const LAS_CLASSES: Record<number, string> = {
  0: "Created, never classified",
  1: "Unclassified",
  2: "Ground",
  3: "Low vegetation",
  4: "Medium vegetation",
  5: "High vegetation",
  6: "Building",
  7: "Low point (noise)",
  8: "Model key-point",
  9: "Water",
  10: "Rail",
  11: "Road surface",
  12: "Overlap",
  13: "Wire guard",
  14: "Wire conductor",
  15: "Transmission tower",
  16: "Wire connector",
  17: "Bridge deck",
  18: "High noise",
};

/** One color per class for "color by classification". */
export const LAS_CLASS_COLORS: Record<number, number> = {
  0: 0x9ca3af, 1: 0xd1d5db, 2: 0xa16207, 3: 0x86efac, 4: 0x22c55e, 5: 0x15803d, 6: 0xef4444, 7: 0xf0abfc, 8: 0xfacc15,
  9: 0x3b82f6, 10: 0x78716c, 11: 0x64748b, 12: 0xfde68a, 13: 0xfb923c, 14: 0xf97316, 15: 0xc2410c, 16: 0xfdba74, 17: 0x14b8a6, 18: 0xd946ef,
};

/** Bytes of each standard point record (a file may add extra bytes per point). */
const RECORD_MIN = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
/** Byte offset of the RGB triple in the formats that have one. */
const RGB_AT: Record<number, number> = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

const LAZ_HELP = "Convert it to uncompressed LAS first (for example `pdal translate in.laz out.las` or `las2las -i in.laz -o out.las`), then point the CAD object at the LAS file.";

/** "las" for a LAS file (compressed or not), else null: from the "LASF" signature. */
export function sniffLas(bytes: Uint8Array): "las" | null {
  return bytes.length >= 4 && bytes[0] === 0x4c && bytes[1] === 0x41 && bytes[2] === 0x53 && bytes[3] === 0x46 ? "las" : null;
}

function ascii(bytes: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = at; i < at + len && i < bytes.length; i++) {
    if (!bytes[i]) break;
    s += String.fromCharCode(bytes[i]);
  }
  return s.trim();
}

/** The public header block and the VLR scan (for LASzip and the coordinate system). */
export function readLasHeader(buffer: ArrayBuffer): LasHeader {
  const bytes = new Uint8Array(buffer);
  if (!sniffLas(bytes)) throw new Error("This is not a LAS file: a LAS file starts with the signature LASF.");
  if (bytes.length < 227) throw new Error("This LAS file is cut short: its header is incomplete.");
  const v = new DataView(buffer);
  const major = v.getUint8(24);
  const minor = v.getUint8(25);
  const headerSize = v.getUint16(94, true);
  const offsetToPoints = v.getUint32(96, true);
  const vlrCount = v.getUint32(100, true);
  const rawFormat = v.getUint8(104);
  const recordLength = v.getUint16(105, true);
  let pointCount = v.getUint32(107, true);
  if (major === 1 && minor >= 4 && headerSize >= 375 && bytes.length >= 255) {
    const big = Number(v.getBigUint64(247, true));
    if (big) pointCount = big;
  }
  const f64 = (at: number) => v.getFloat64(at, true);
  let compressed = (rawFormat & 0x80) !== 0;
  let crs: LasHeader["crs"] = null;
  // variable length records: 54-byte headers after the public header block
  let at = headerSize;
  for (let i = 0; i < vlrCount && at + 54 <= Math.min(bytes.length, offsetToPoints); i++) {
    const user = ascii(bytes, at + 2, 16).toLowerCase();
    const record = v.getUint16(at + 18, true);
    const len = v.getUint16(at + 20, true);
    if (user === "laszip encoded" && record === 22204) compressed = true;
    if (user === "lasf_projection") crs = record === 2112 ? "wkt" : record === 34735 ? "geotiff" : crs;
    at += 54 + len;
  }
  const day = v.getUint16(90, true);
  const year = v.getUint16(92, true);
  return {
    version: `${major}.${minor}`,
    pointFormat: rawFormat & 0x3f,
    recordLength,
    pointCount,
    headerSize,
    offsetToPoints,
    vlrCount,
    scale: [f64(131), f64(139), f64(147)],
    offset: [f64(155), f64(163), f64(171)],
    max: [f64(179), f64(195), f64(211)],
    min: [f64(187), f64(203), f64(219)],
    systemId: ascii(bytes, 26, 32),
    software: ascii(bytes, 58, 32),
    created: year ? `${day}/${year}` : null,
    compressed,
    crs,
  };
}

/** Read an uncompressed LAS file. LAZ, unknown point formats and cut-short files are refused with the reason. */
export function parseLas(buffer: ArrayBuffer, opts: { maxPoints?: number } = {}): LasCloud {
  const h = readLasHeader(buffer);
  const warnings: string[] = [];
  if (h.compressed) throw new Error(`This is a LAZ (LASzip-compressed) point cloud: it is not decoded here, because no LASzip decoder is installed. ${LAZ_HELP}`);
  const major = Number(h.version.split(".")[0]);
  if (major !== 1) throw new Error(`LAS version ${h.version} is not read here (versions 1.0 to 1.4 are).`);
  const fmt = h.pointFormat;
  if (fmt > 10) throw new Error(`Point data format ${fmt} is not a LAS format (0 to 10 are).`);
  if (h.recordLength < RECORD_MIN[fmt]) throw new Error(`The point records are ${h.recordLength} bytes, too short for point data format ${fmt} (${RECORD_MIN[fmt]} bytes).`);
  if (!h.scale.every((s) => Number.isFinite(s) && s !== 0)) throw new Error("The header's scale factors are not valid numbers.");
  const fits = Math.max(0, Math.floor((buffer.byteLength - h.offsetToPoints) / h.recordLength));
  let total = h.pointCount;
  if (fits < total) {
    warnings.push(`the header says ${total.toLocaleString("en-US")} points, the file holds ${fits.toLocaleString("en-US")}: the file is cut short`);
    total = fits;
  }
  if (!h.pointCount && fits) {
    warnings.push("the header's point count is 0: the points are counted from the file size");
    total = fits;
  }
  const max = Math.max(1, opts.maxPoints ?? LAS_MAX_POINTS);
  const step = Math.max(1, Math.ceil(total / max));
  const loaded = Math.ceil(total / step) || 0;
  if (step > 1) warnings.push(`${total.toLocaleString("en-US")} points: every ${step}th is shown (${loaded.toLocaleString("en-US")})`);

  const v = new DataView(buffer);
  const hasHeaderBounds = h.min.every(Number.isFinite) && h.max.every(Number.isFinite) && h.max[0] >= h.min[0];
  const origin: [number, number, number] = hasHeaderBounds ? [(h.min[0] + h.max[0]) / 2, (h.min[1] + h.max[1]) / 2, (h.min[2] + h.max[2]) / 2] : [h.offset[0], h.offset[1], h.offset[2]];
  const positions = new Float32Array(loaded * 3);
  const rgbAt = RGB_AT[fmt];
  const raw = rgbAt !== undefined ? new Uint16Array(loaded * 3) : null;
  const intensityRaw = new Uint16Array(loaded);
  const classification = new Uint8Array(loaded);
  const classes: Record<number, number> = {};
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let maxIntensity = 0;
  let maxColor = 0;
  const [sx, sy, sz] = h.scale;
  const [ox, oy, oz] = h.offset;
  for (let i = 0, k = 0; k < loaded; i += step, k++) {
    const p = h.offsetToPoints + i * h.recordLength;
    const x = v.getInt32(p, true) * sx + ox;
    const y = v.getInt32(p + 4, true) * sy + oy;
    const z = v.getInt32(p + 8, true) * sz + oz;
    positions[k * 3] = x - origin[0];
    positions[k * 3 + 1] = y - origin[1];
    positions[k * 3 + 2] = z - origin[2];
    if (x < lo[0]) lo[0] = x;
    if (y < lo[1]) lo[1] = y;
    if (z < lo[2]) lo[2] = z;
    if (x > hi[0]) hi[0] = x;
    if (y > hi[1]) hi[1] = y;
    if (z > hi[2]) hi[2] = z;
    const it = v.getUint16(p + 12, true);
    intensityRaw[k] = it;
    if (it > maxIntensity) maxIntensity = it;
    // formats 0–5 keep the class in the low 5 bits of byte 15; formats 6–10 in byte 16
    const cls = fmt < 6 ? v.getUint8(p + 15) & 0x1f : v.getUint8(p + 16);
    classification[k] = cls;
    classes[cls] = (classes[cls] ?? 0) + 1;
    if (raw) {
      const r = v.getUint16(p + rgbAt, true);
      const g = v.getUint16(p + rgbAt + 2, true);
      const b = v.getUint16(p + rgbAt + 4, true);
      raw[k * 3] = r;
      raw[k * 3 + 1] = g;
      raw[k * 3 + 2] = b;
      if (r > maxColor) maxColor = r;
      if (g > maxColor) maxColor = g;
      if (b > maxColor) maxColor = b;
    }
  }
  // colors are 16-bit by the specification; some writers store 0–255 in them
  const eightBitColor = !!raw && maxColor > 0 && maxColor <= 255;
  let colors: Float32Array | null = null;
  if (raw && maxColor > 0) {
    const d = eightBitColor ? 255 : 65535;
    colors = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) colors[i] = raw[i] / d;
  } else if (raw) warnings.push("the point format has colors, but every color is black: shown by elevation instead");
  const intensity = new Float32Array(loaded);
  for (let i = 0; i < loaded; i++) intensity[i] = maxIntensity ? intensityRaw[i] / maxIntensity : 0;
  if (hasHeaderBounds && loaded && (lo[0] < h.min[0] - 1e-6 * Math.abs(h.min[0] || 1) - h.scale[0] || hi[0] > h.max[0] + 1e-6 * Math.abs(h.max[0] || 1) + h.scale[0])) {
    warnings.push("some points lie outside the header's bounds");
  }
  return {
    header: h,
    origin,
    positions,
    colors,
    intensity,
    classification,
    loaded,
    step,
    classes,
    bounds: loaded ? { min: lo, max: hi } : { min: [0, 0, 0], max: [0, 0, 0] },
    eightBitColor,
    warnings,
  };
}
