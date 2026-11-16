/** Colors shared by Contour's scatter and map boards: categories (the server's top 10, then "Other") and a scale. */
import type { ColorLegend } from "@/lib/contour";
import { OTHER, SERIES } from "@/lib/workshop";

export const CATEGORY = [...SERIES, "#00a3c4", "#b0793a"];
export { OTHER };
const STOPS = ["#3b2a84", "#2c6fbb", "#1fa187", "#8fd14f", "#fde725"].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

/** A sequential scale color for t in 0..1. */
export function scaleColor(t: number, alpha = 1): string {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const [r, g, b] = STOPS[i].map((v, j) => Math.round(v + (STOPS[i + 1][j] - v) * f));
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

export const SCALE_CSS = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((t) => scaleColor(t)).join(", ")})`;

/** A function giving each value its color under a legend (categories outside the top 10 are "Other"). */
export function colorOf(legend: ColorLegend | undefined, single = CATEGORY[0]): (v: unknown) => string {
  if (!legend) return () => single;
  if (legend.kind === "category") {
    const at = new Map(legend.values.map((v, i) => [v === null ? null : String(v), CATEGORY[i % CATEGORY.length]]));
    return (v) => at.get(v === null || v === undefined ? null : String(v)) ?? OTHER;
  }
  const lo = legend.min ?? 0;
  const span = (legend.max ?? lo) - lo || 1;
  return (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? OTHER : scaleColor((Number(v) - lo) / span));
}

/** About `n` round tick values between lo and hi. */
export function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Short number labels for axes: 1.2k, 3.4M, 0.001. */
export function short(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toPrecision(3)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toPrecision(3)}k`;
  if (a === 0) return "0";
  return String(+v.toPrecision(3));
}
