// Pure logic of the Filter List's timeline and distribution charts: pixels <-> buckets, a brushed range <-> filters,
// the from / to inputs <-> filters, labels. No React and no imports at run time (unit-tested in Node).
import type { Filter, HistBucket, Histogram } from "@/lib/workshop";

export type ChartKind = "timeline" | "distribution";
/** The range an item's filters set on its column: the lower end (gte / gt) and the upper end (lt / lte). */
export type RangeEnds = { lo?: Filter; hi?: Filter };

const LOWER = ["gte", "gt"];
const UPPER = ["lt", "lte"];
const has = (v: unknown) => !(v === undefined || v === null || v === "");

/** The bucket under a pixel offset in a chart `width` pixels wide with `n` equal buckets (clamped to the chart). */
export function bucketAt(x: number, width: number, n: number): number {
  if (n <= 0 || !(width > 0) || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(n - 1, Math.floor((x / width) * n)));
}
/** The pixel span [left, right) of bucket i. */
export function bucketSpan(i: number, width: number, n: number): [number, number] {
  if (n <= 0) return [0, 0];
  return [(i / n) * width, ((i + 1) / n) * width];
}
/** The buckets a drag from pixel a to pixel b covers, in order. */
export function brushRange(a: number, b: number, width: number, n: number): [number, number] {
  const i = bucketAt(a, width, n);
  const j = bucketAt(b, width, n);
  return i <= j ? [i, j] : [j, i];
}
/** The filters of a brush over buckets i..j: from ≤ value < to (≤ to on a closed last bucket). */
export function rangeFilters(column: string, buckets: HistBucket[], i: number, j: number): Filter[] {
  const a = buckets[Math.min(i, j)];
  const b = buckets[Math.max(i, j)];
  if (!a || !b) return [];
  return [
    { column, op: "gte", value: a.from },
    { column, op: b.closed ? "lte" : "lt", value: b.to },
  ];
}
/** The ends of the range the filters of a column set. */
export function readRange(filters: Filter[], column: string): RangeEnds {
  const mine = filters.filter((f) => f.column === column && has(f.value));
  return { lo: mine.find((f) => LOWER.includes(f.op)), hi: mine.find((f) => UPPER.includes(f.op)) };
}

const cmp = (kind: ChartKind, a: unknown, b: unknown): number => {
  if (kind === "distribution") return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
/** Whether a bucket holds values the range lets through (its bar is drawn as selected). */
export function bucketInRange(kind: ChartKind, b: HistBucket, r: RangeEnds): boolean {
  if (!r.lo && !r.hi) return false;
  if (r.lo) {
    // the bucket's values are below `to` (or up to it, closed): nothing passes a lower end at or above that
    const c = cmp(kind, b.to, r.lo.value);
    if (b.closed ? c < 0 || (c === 0 && r.lo.op === "gt") : c <= 0) return false;
  }
  if (r.hi) {
    const c = cmp(kind, b.from, r.hi.value);
    if (c > 0 || (c === 0 && r.hi.op === "lt")) return false;
  }
  return true;
}
/** The first and last selected bucket, or null without a range (or one outside every bucket). */
export function selectedSpan(kind: ChartKind, buckets: HistBucket[], r: RangeEnds): [number, number] | null {
  let first = -1;
  let last = -1;
  buckets.forEach((b, i) => {
    if (!bucketInRange(kind, b, r)) return;
    if (first < 0) first = i;
    last = i;
  });
  return first < 0 ? null : [first, last];
}
/** The objects in the selected buckets. */
export const countIn = (buckets: HistBucket[], span: [number, number] | null): number => (span ? buckets.slice(span[0], span[1] + 1).reduce((s, b) => s + b.count, 0) : 0);

const DAY = 86_400_000;
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
/** An ISO date moved by whole days ("" when it is not a date). */
export function shiftDay(day: string, by: number): string {
  const d = day.slice(0, 10);
  if (!isDay(d)) return "";
  return new Date(Date.parse(`${d}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);
}
/** The text of the from / to inputs for a range: a timeline's "to" shows the last day inside the range. */
export function inputValues(kind: ChartKind, r: RangeEnds): { from: string; to: string } {
  const from = r.lo && has(r.lo.value) ? String(r.lo.value) : "";
  const to = r.hi && has(r.hi.value) ? String(r.hi.value) : "";
  if (kind === "distribution") return { from, to };
  return { from: from.slice(0, 10), to: !to ? "" : r.hi!.op === "lt" ? shiftDay(to, -1) : to.slice(0, 10) };
}
/** The filters of typed ends ("" leaves the end open; a text that is not a number / date sets nothing for that end):
 * a distribution from ≤ value ≤ to; a timeline from the start of `from` to the end of `to` (also for timestamps). */
export function inputFilters(kind: ChartKind, column: string, from: string, to: string): Filter[] {
  const out: Filter[] = [];
  const a = from.trim();
  const b = to.trim();
  if (kind === "distribution") {
    if (a !== "" && Number.isFinite(Number(a))) out.push({ column, op: "gte", value: Number(a) });
    if (b !== "" && Number.isFinite(Number(b))) out.push({ column, op: "lte", value: Number(b) });
    return out;
  }
  if (isDay(a)) out.push({ column, op: "gte", value: a });
  if (isDay(b)) out.push({ column, op: "lt", value: shiftDay(b, 1) });
  return out;
}
/** Whether typed ends are the wrong way round (from above to). */
export function endsReversed(kind: ChartKind, from: string, to: string): boolean {
  if (!from.trim() || !to.trim()) return false;
  if (kind === "distribution") return Number.isFinite(Number(from)) && Number.isFinite(Number(to)) && Number(from) > Number(to);
  return isDay(from.trim()) && isDay(to.trim()) && from.trim() > to.trim();
}

const SYMBOL: Record<string, string> = { gte: "≥", gt: ">", lt: "<", lte: "≤" };
/** A range in words (a pill's summary): a timeline's days with "to" included, a distribution's ends with their sign. */
export function rangeSummary(kind: ChartKind, r: RangeEnds): string {
  if (kind === "timeline") {
    const t = inputValues(kind, r);
    const a = t.from && fmtDay(t.from);
    const b = t.to && fmtDay(t.to);
    return a && b ? (a === b ? a : `${a} – ${b}`) : a ? `from ${a}` : b ? `until ${b}` : "";
  }
  return [r.lo, r.hi]
    .filter((f): f is Filter => !!f)
    .map((f) => `${SYMBOL[f.op] ?? f.op} ${fmtNumber(Number(f.value))}`)
    .join(" · ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e15 || (a !== 0 && a < 1e-6)) return v.toExponential(2);
  const [whole, frac] = String(Math.round(v * 1e6) / 1e6).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
}
/** A day as text ("5 Jan 2026"). */
export function fmtDay(day: string): string {
  const d = day.slice(0, 10);
  if (!isDay(d)) return day;
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}
/** What a bucket holds, for its tooltip and the screen reader text. */
export function bucketLabel(h: Pick<Histogram, "kind" | "interval" | "years" | "integer" | "step">, b: HistBucket): string {
  if (h.kind === "distribution") {
    if (b.closed || (h.integer && h.step === 1)) return fmtNumber(Number(b.from));
    return `${fmtNumber(Number(b.from))} – ${fmtNumber(Number(b.to))}`;
  }
  const from = String(b.from);
  if (h.interval === "day") return fmtDay(from);
  if (h.interval === "week") return `Week of ${fmtDay(from)}`;
  if (h.interval === "month") return `${MONTHS[Number(from.slice(5, 7)) - 1] ?? ""} ${from.slice(0, 4)}`;
  if ((h.years ?? 1) > 1) return `${Number(from.slice(0, 4))} – ${Number(String(b.to).slice(0, 4)) - 1}`;
  return String(Number(from.slice(0, 4)));
}
/** The bar height (0..1) of a count: linear, and a bucket with objects never vanishes. */
export function barHeight(count: number, max: number): number {
  if (!(count > 0) || !(max > 0)) return 0;
  return Math.max(0.04, Math.min(1, count / max));
}
/** A selection moved or resized by one bucket with the arrow keys (extend: move only its far end). */
export function nudgeSpan(span: [number, number] | null, n: number, dir: -1 | 1, extend: boolean): [number, number] | null {
  if (n <= 0) return null;
  if (!span) return dir > 0 ? [0, 0] : [n - 1, n - 1];
  const [a, b] = span;
  if (extend) return [a, Math.max(a, Math.min(n - 1, b + dir))];
  if (a + dir < 0 || b + dir > n - 1) return [a, b];
  return [a + dir, b + dir];
}
