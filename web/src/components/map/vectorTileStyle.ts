/**
 * Styling vector tile features by a property (no imports, so Node tests can load it): a categorical palette (or an
 * explicit value → color map), or a numeric range on a color gradient, with a default color for missing values.
 * Used by VectorTileLayer (Map app "Vector tiles" layers, Slate map vector / vector-tile choropleth layers).
 */

export type VectorColorBy = {
  /** the feature property to color by (ignored when the caller supplies values per feature id) */
  property?: string;
  /** "category": a color per distinct value; "range": numbers on a gradient. Default: range when every value is a number. */
  mode?: "category" | "range";
  /** range: two or more gradient stops */
  colors?: string[];
  /** category: the palette (a value's color is picked by a hash of the value, so it is stable) */
  palette?: string[];
  /** category: explicit colors for values (checked before the palette) */
  categories?: Record<string, string>;
  /** range: the domain (defaults to the min / max of the features in view) */
  min?: number;
  max?: number;
  /** null, missing or (for a range) non-numeric values */
  defaultColor?: string;
};

export const CATEGORY_PALETTE = ["#38bdf8", "#f97316", "#a3e635", "#f472b6", "#facc15", "#34d399", "#c084fc", "#fb7185", "#60a5fa", "#fbbf24"];
export const RANGE_COLORS = ["#dbeafe", "#1d4ed8"];

export type ColorLegend = { kind: "range"; min: number; max: number; colors: string[] } | { kind: "category"; items: [string, string][] };
export type ColorScale = { color: (v: unknown) => string | null; legend: ColorLegend | null };

const hex = (c: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

/** A color on a gradient through `colors` at t in [0, 1]; hex stops are interpolated, other CSS colors snap to the nearest stop. */
export function gradient(colors: string[], t: number): string {
  const cs = colors.length >= 2 ? colors : RANGE_COLORS;
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (cs.length - 1);
  const i = Math.min(cs.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [hex(cs[i]), hex(cs[i + 1])];
  if (!a || !b) return f < 0.5 ? cs[i] : cs[i + 1];
  return "#" + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("");
}

/** FNV-1a, unsigned */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const numeric = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * A color scale for `by` over the values of the features in view (used for the automatic range domain and the order of
 * categories). Returns null colors for values the scale does not cover, so the caller keeps its base color.
 */
export function buildColorScale(by: VectorColorBy | null | undefined, values: unknown[]): ColorScale {
  if (!by) return { color: () => null, legend: null };
  const present = values.filter((v) => v !== null && v !== undefined && v !== "");
  const mode = by.mode ?? (present.length && present.every((v) => typeof v === "number") ? "range" : "category");
  const dflt = by.defaultColor || null;
  if (mode === "range") {
    const nums = present.map(numeric).filter((n): n is number => n !== null);
    const lo = Number.isFinite(by.min) ? Number(by.min) : nums.length ? Math.min(...nums) : NaN;
    const hi = Number.isFinite(by.max) ? Number(by.max) : nums.length ? Math.max(...nums) : NaN;
    const colors = by.colors && by.colors.length >= 2 ? by.colors : RANGE_COLORS;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { color: () => dflt, legend: null };
    return {
      color: (v) => {
        const n = numeric(v);
        if (n === null) return dflt;
        return gradient(colors, hi === lo ? 0.5 : (n - lo) / (hi - lo));
      },
      legend: { kind: "range", min: lo, max: hi, colors },
    };
  }
  const palette = by.palette && by.palette.length ? by.palette : CATEGORY_PALETTE;
  const explicit = by.categories ?? {};
  // a value's palette color comes from a hash of the value, so it stays the same as tiles load and the map pans
  const pick = (k: string) => explicit[k] ?? palette[hashString(k) % palette.length];
  const order = new Map<string, string>();
  for (const v of present) if (!order.has(String(v))) order.set(String(v), pick(String(v)));
  return {
    color: (v) => (v === null || v === undefined || v === "" ? dflt : pick(String(v))),
    legend: { kind: "category", items: [...order.entries()].slice(0, 12) },
  };
}
