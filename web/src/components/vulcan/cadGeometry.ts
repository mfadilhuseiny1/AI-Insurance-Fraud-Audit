/**
 * three.js objects for Vulcan's drawings and point clouds, from the loaders written here (no packages):
 * ASCII DXF (`@/lib/vulcanDxf`) as one object per layer (line segments, points and text labels, colored per entity),
 * and uncompressed LAS (`@/lib/vulcanLas`) as one point object per classification, colored by RGB, elevation,
 * intensity or class. Objects are named after their layer or class: that is the "part" Vulcan picks and recolors.
 */

import type * as THREE from "three";
import { decodeDxf, parseDxf, sniffDxf, type DxfDrawing } from "@/lib/vulcanDxf";
import { LAS_CLASSES, LAS_CLASS_COLORS, parseLas, sniffLas, type LasHeader } from "@/lib/vulcanLas";

export type ColorMode = "rgb" | "elevation" | "intensity" | "classification";

export type DrawingInfo = {
  kind: "drawing";
  version: string | null;
  units: string | null;
  layers: { name: string; color: string; segments: number; points: number; labels: number; hidden: boolean }[];
  counts: Record<string, number>;
  skipped: Record<string, number>;
  blocks: number;
  segments: number;
  labelsShown: number;
  labels: number;
  flat: boolean;
  warnings: string[];
};
export type CloudInfo = {
  kind: "point_cloud";
  header: LasHeader;
  loaded: number;
  step: number;
  hasColor: boolean;
  eightBitColor: boolean;
  classes: { code: number; name: string; part: string; count: number; color: string }[];
  warnings: string[];
};
export type MeshInfo = { kind: "mesh"; parts: string[] };
export type ModelInfo = (DrawingInfo | CloudInfo | MeshInfo) & {
  /** bounds in model coordinates */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
};

/** Labels above this are not drawn (each is a sprite with its own texture). */
const MAX_LABELS = 400;

const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
export const classPart = (code: number) => `${LAS_CLASSES[code] ?? `Class ${code}`} (${code})`;

/** The format of model bytes from their content, for files whose name says nothing. */
export function sniffModel(bytes: Uint8Array): "dxf" | "las" | null {
  if (sniffLas(bytes)) return "las";
  const d = sniffDxf(bytes);
  return d === "ascii" || d === "binary" ? "dxf" : null;
}

function labelSprite(three: typeof THREE, text: string, height: number, color: number): THREE.Sprite | null {
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  if (!g) return null;
  const px = 48;
  const lines = text.split("\n").slice(0, 8);
  g.font = `${px}px sans-serif`;
  const w = Math.min(2048, Math.max(...lines.map((l) => g.measureText(l).width)) + 8);
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(px * 1.25 * lines.length);
  g.font = `${px}px sans-serif`;
  g.fillStyle = hex(color);
  g.textBaseline = "top";
  lines.forEach((l, i) => g.fillText(l, 4, i * px * 1.25));
  const tex = new three.CanvasTexture(canvas);
  tex.colorSpace = three.SRGBColorSpace;
  const sprite = new three.Sprite(new three.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const h = height * 1.25 * lines.length;
  sprite.scale.set((h * canvas.width) / canvas.height, h, 1);
  // anchored at the insertion point: text runs to the right and up from it
  sprite.center.set(0, 0);
  return sprite;
}

/** A DXF drawing as a group with one child per layer (line segments + points + labels). */
export function drawingObject(three: typeof THREE, d: DxfDrawing): { object: THREE.Group; info: DrawingInfo } {
  const root = new three.Group();
  let labelsShown = 0;
  const color = new three.Color();
  for (const l of d.layers) {
    if (!l.segments.length && !l.points.length && !l.labels.length) continue;
    const layer = new three.Group();
    layer.name = l.name;
    layer.visible = !l.off && !l.frozen;
    if (l.segments.length) {
      const g = new three.BufferGeometry();
      g.setAttribute("position", new three.Float32BufferAttribute(l.segments, 3));
      const cols = new Float32Array(l.segments.length);
      for (let i = 0; i < l.segmentColors.length; i++) {
        color.setHex(l.segmentColors[i], three.SRGBColorSpace);
        cols.set([color.r, color.g, color.b, color.r, color.g, color.b], i * 6);
      }
      g.setAttribute("color", new three.BufferAttribute(cols, 3));
      const lines = new three.LineSegments(g, new three.LineBasicMaterial({ vertexColors: true }));
      lines.name = l.name;
      layer.add(lines);
    }
    if (l.points.length) {
      const g = new three.BufferGeometry();
      g.setAttribute("position", new three.Float32BufferAttribute(l.points, 3));
      const cols = new Float32Array(l.points.length);
      l.pointColors.forEach((c, i) => {
        color.setHex(c, three.SRGBColorSpace);
        cols.set([color.r, color.g, color.b], i * 3);
      });
      g.setAttribute("color", new three.BufferAttribute(cols, 3));
      const pts = new three.Points(g, new three.PointsMaterial({ vertexColors: true, size: 4, sizeAttenuation: false }));
      pts.name = l.name;
      layer.add(pts);
    }
    for (const lb of l.labels) {
      if (labelsShown >= MAX_LABELS) break;
      const s = labelSprite(three, lb.text, lb.height, lb.color);
      if (!s) continue;
      s.position.set(...lb.position);
      s.name = l.name;
      layer.add(s);
      labelsShown++;
    }
    root.add(layer);
  }
  const warnings = [...d.warnings];
  if (d.labelCount > labelsShown) warnings.push(`${d.labelCount.toLocaleString("en-US")} labels: the first ${labelsShown} are drawn`);
  return {
    object: root,
    info: {
      kind: "drawing",
      version: d.version,
      units: d.units,
      layers: d.layers.map((l) => ({ name: l.name, color: hex(l.color), segments: l.segments.length / 6, points: l.points.length / 3, labels: l.labels.length, hidden: l.off || l.frozen })),
      counts: d.counts,
      skipped: d.skipped,
      blocks: d.blocks,
      segments: d.segmentCount,
      labelsShown,
      labels: d.labelCount,
      flat: d.flat,
      warnings,
    },
  };
}

/** A LAS point cloud as a group placed at its origin, with one Points child per classification. */
export function cloudObject(three: typeof THREE, buffer: ArrayBuffer): { object: THREE.Group; info: CloudInfo } {
  const c = parseLas(buffer);
  const root = new three.Group();
  root.position.set(...c.origin);
  const byClass = new Map<number, number[]>();
  for (let i = 0; i < c.loaded; i++) {
    const k = c.classification[i];
    let a = byClass.get(k);
    if (!a) byClass.set(k, (a = []));
    a.push(i);
  }
  const zMin = c.bounds.min[2] - c.origin[2];
  const zSpan = c.bounds.max[2] - c.bounds.min[2] || 1;
  for (const [code, idx] of [...byClass.entries()].sort((a, b) => a[0] - b[0])) {
    const pos = new Float32Array(idx.length * 3);
    const rgb = c.colors ? new Float32Array(idx.length * 3) : null;
    const inten = new Float32Array(idx.length);
    const elev = new Float32Array(idx.length);
    idx.forEach((i, j) => {
      pos[j * 3] = c.positions[i * 3];
      pos[j * 3 + 1] = c.positions[i * 3 + 1];
      pos[j * 3 + 2] = c.positions[i * 3 + 2];
      if (rgb && c.colors) rgb.set(c.colors.subarray(i * 3, i * 3 + 3), j * 3);
      inten[j] = c.intensity[i];
      elev[j] = (c.positions[i * 3 + 2] - zMin) / zSpan;
    });
    const g = new three.BufferGeometry();
    g.setAttribute("position", new three.BufferAttribute(pos, 3));
    g.setAttribute("color", new three.BufferAttribute(new Float32Array(idx.length * 3), 3));
    const pts = new three.Points(g, new three.PointsMaterial({ vertexColors: true, size: 2, sizeAttenuation: false }));
    pts.name = classPart(code);
    pts.userData = { lasClass: code, rgb, intensity: inten, elevation: elev };
    root.add(pts);
  }
  colorCloud(three, root, c.colors ? "rgb" : "elevation");
  return {
    object: root,
    info: {
      kind: "point_cloud",
      header: c.header,
      loaded: c.loaded,
      step: c.step,
      hasColor: !!c.colors,
      eightBitColor: c.eightBitColor,
      classes: [...byClass.entries()].sort((a, b) => a[0] - b[0]).map(([code, idx]) => ({ code, name: LAS_CLASSES[code] ?? `Class ${code}`, part: classPart(code), count: idx.length, color: hex(LAS_CLASS_COLORS[code] ?? 0x9ca3af) })),
      warnings: c.warnings,
    },
  };
}

/** The elevation ramp: blue → cyan → green → yellow → red. */
const RAMP = [0x2563eb, 0x06b6d4, 0x22c55e, 0xeab308, 0xef4444];
function ramp(stops: THREE.Color[], t: number, out: THREE.Color) {
  const x = Math.max(0, Math.min(1, t)) * 4;
  const i = Math.min(3, Math.floor(x));
  out.copy(stops[i]).lerp(stops[i + 1], x - i);
}

/** Write the color attribute of every class object of a point cloud (intensity: black → white). */
export function colorCloud(three: typeof THREE, root: THREE.Object3D, mode: ColorMode) {
  const c = new three.Color();
  const stops = RAMP.map((h) => new three.Color().setHex(h, three.SRGBColorSpace));
  root.traverse((o) => {
    const p = o as THREE.Points;
    if (!p.isPoints || p.userData.lasClass === undefined) return;
    const attr = p.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const { rgb, intensity, elevation, lasClass } = p.userData as { rgb: Float32Array | null; intensity: Float32Array; elevation: Float32Array; lasClass: number };
    const n = intensity.length;
    if (mode === "rgb" && rgb) arr.set(rgb);
    else if (mode === "classification") {
      c.setHex(LAS_CLASS_COLORS[lasClass] ?? 0x9ca3af, three.SRGBColorSpace);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
    } else if (mode === "intensity") {
      for (let i = 0; i < n; i++) {
        const v = 0.15 + 0.85 * Math.sqrt(intensity[i]);
        arr.set([v, v, v], i * 3);
      }
    } else {
      for (let i = 0; i < n; i++) {
        ramp(stops, elevation[i], c);
        arr.set([c.r, c.g, c.b], i * 3);
      }
    }
    attr.needsUpdate = true;
  });
}

/** Load a drawing or point cloud from its bytes; refusals (binary DXF, DWG, LAZ, …) throw with the reason. */
export function loadCad(three: typeof THREE, fmt: "dxf" | "las" | "laz", buffer: ArrayBuffer): { object: THREE.Group; info: DrawingInfo | CloudInfo } {
  if (fmt === "dxf") return drawingObject(three, parseDxf(decodeDxf(buffer)));
  return cloudObject(three, buffer);
}
