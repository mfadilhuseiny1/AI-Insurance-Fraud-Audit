"use client";

import { useEffect, useMemo, useState } from "react";
import { fieldClass } from "@/components/pipeline/Modal";
import { AGGREGATIONS as ROLLING_AGGS, tsOntology, type TsObjectType } from "@/lib/timeseries";
import { fmtWith, ruleFor, workshop, type FormatRule, type TsAggregation, type TsCellData, type TsColorScale, type TsColumn, type TsColumnRequest, type TsMeasure, type TsTransform, type TsValueAtInterpolation, type ValueFormat, type Widget, type WidgetConfig } from "@/lib/workshop";

/** Value and conditional formatting of time series: time series property columns in the Object Table (a summary value
 * and a sparkline per object) and the time series Metric Card, plus the shared value format and rule editors. */

/** The summarizer aggregations of the doc (value: label). */
const AGGS: [TsAggregation, string][] = [
  ["last", "last"], ["first", "first"], ["min", "min"], ["max", "max"], ["mean", "average"], ["sum", "sum"], ["count", "count"],
  ["std", "standard deviation"], ["difference", "difference (last − first)"], ["relative_difference", "relative difference"],
  ["integral", "integral"], ["product", "product"], ["time_weighted_average", "time-weighted average"], ["value_at", "value at a time"],
];
const VALUE_AT_INTERPOLATIONS: [TsValueAtInterpolation, string][] = [
  ["series", "series interpolation"], ["previous", "previous point"], ["next", "next point"], ["nearest", "nearest point"], ["linear", "linear between points"],
];
const TIME_UNITS: [string, string][] = [["s", "second"], ["m", "minute"], ["h", "hour"], ["d", "day"], ["w", "week"]];
const TRANSFORMS: [TsTransform["type"], string][] = [
  ["rolling", "Rolling aggregate"], ["cumulative", "Cumulative aggregate"], ["periodic", "Periodic aggregate"], ["derivative", "Derivative"],
  ["integral", "Integral"], ["formula", "Formula"], ["shift", "Time shift"], ["time_range", "Time range"],
];
const NEW_TRANSFORM: Record<TsTransform["type"], TsTransform> = {
  rolling: { type: "rolling", window: "7d", aggregation: "mean" }, cumulative: { type: "cumulative", aggregation: "sum" },
  periodic: { type: "periodic", period: "1w", aggregation: "sum" }, derivative: { type: "derivative", unit: "d" },
  integral: { type: "integral", unit: "d", method: "linear" }, formula: { type: "formula", formula: "$X * 2 + 5" }, shift: { type: "shift", by: "7d" },
  time_range: { type: "time_range", last: "30d" },
};

/** What a column asks the API: only the options set (original columns send exactly what they did before). */
export function tsColumnRequest(col: TsColumn): TsColumnRequest {
  const vc = col.summarizer === "value_change";
  const r: TsColumnRequest = {
    id: col.id, property: col.property, aggregation: col.aggregation ?? "last", range_last: col.range_last || undefined, buckets: col.buckets ?? 30,
    rolling: col.rolling || undefined, rolling_agg: col.rolling ? col.rolling_agg || "mean" : undefined,
  };
  if (col.transforms?.length) r.transforms = col.transforms.map((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined && v !== "")) as TsTransform);
  if (vc) {
    r.summarizer = "value_change";
    r.change_as = col.change_as ?? "absolute";
    if (col.change_offset) r.change_offset = col.change_offset;
  }
  if (col.aggregation === "integral") r.integral_unit = col.integral_unit ?? "s";
  if (col.range_start) r.range_start = col.range_start;
  if (col.range_end) r.range_end = col.range_end;
  if (col.range_end_offset) r.range_end_offset = col.range_end_offset;
  if (col.aggregation === "value_at") {
    if (col.value_at) r.value_at = col.value_at;
    if (col.value_at_interpolation && col.value_at_interpolation !== "series") r.value_at_interpolation = col.value_at_interpolation;
  }
  return r;
}
const RANGES: [string, string][] = [["", "All time"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["1y", "Last year"]];

/** A time range as the range picker edits it: a preset or relative start (`last`), an exact `start` / `end` (ISO), a
 * relative end (`end_offset`, a signed duration from now). */
export type RangeValue = { last?: string; start?: string; end?: string; end_offset?: string };
type RangeMode = "preset" | "exact" | "relative";
const rangeMode = (r: RangeValue): RangeMode =>
  r.start || r.end ? "exact" : r.end_offset || (r.last && !RANGES.some(([v]) => v === r.last)) ? "relative" : "preset";
/** ISO → the value of a datetime-local input (local time), and back. */
const toLocalInput = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
};
const fmtWhen = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

/** A column's range as the picker edits it, and back. */
const colRange = (c: Pick<TsColumn, "range_last" | "range_start" | "range_end" | "range_end_offset">): RangeValue => ({ last: c.range_last, start: c.range_start, end: c.range_end, end_offset: c.range_end_offset });
const toColRange = (x: RangeValue): Partial<TsColumn> => {
  const out: Partial<TsColumn> = {};
  if ("last" in x) out.range_last = x.last;
  if ("start" in x) out.range_start = x.start;
  if ("end" in x) out.range_end = x.end;
  if ("end_offset" in x) out.range_end_offset = x.end_offset;
  return out;
};

/** A short description of a range (the Metric Card's default label). */
export function rangeLabel(r: RangeValue): string {
  if (r.start || r.end) return r.start && r.end ? `${fmtWhen(r.start)} – ${fmtWhen(r.end)}` : r.start ? `from ${fmtWhen(r.start)}` : `until ${fmtWhen(r.end)}`;
  const end = r.end_offset ? (r.end_offset.startsWith("-") ? ` to ${r.end_offset.slice(1)} ago` : ` to ${r.end_offset.replace(/^\+/, "")} from now`) : "";
  return r.last ? `last ${r.last}${end}` : end ? `all time${end}` : "";
}

/** The doc's time range picker: the presets, or a custom range — exact (start / end, local time; either may be left
 * open) or relative (the last <n><unit> before now, ending now or <n><unit> ago / from now). */
export function RangePicker({ r, set, allowAll = true }: { r: RangeValue; set: (x: RangeValue) => void; allowAll?: boolean }) {
  const [mode, setMode] = useState<RangeMode>(rangeMode(r));
  const off = r.end_offset ?? "";
  const ago = off.startsWith("-");
  const mag = off.replace(/^[+-]/, "");
  const setOff = (m: string, isAgo: boolean) => set({ end_offset: m.trim() ? `${isAgo ? "-" : ""}${m.trim()}` : undefined });
  return (
    <>
      <select
        value={mode === "preset" ? (r.last ?? "") : mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "exact") {
            setMode("exact");
            set({ last: undefined, end_offset: undefined, start: r.start, end: r.end });
          } else if (v === "relative") {
            setMode("relative");
            set({ start: undefined, end: undefined, last: r.last || "30d", end_offset: r.end_offset });
          } else {
            setMode("preset");
            set({ start: undefined, end: undefined, end_offset: undefined, last: v || undefined });
          }
        }}
        className={`${fieldClass} min-w-0 flex-1 text-[11px]`}
        data-range-mode={mode}
      >
        {RANGES.filter(([v]) => allowAll || v).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
        <option value="exact">Custom: exact…</option>
        <option value="relative">Custom: relative…</option>
      </select>
      {mode === "exact" && (
        <div className="order-last flex w-full flex-wrap items-center gap-1" data-range-fields="exact">
          <input type="datetime-local" value={toLocalInput(r.start)} onChange={(e) => set({ start: fromLocalInput(e.target.value) })} title="Start (your local time; empty: open)" className={`${fieldClass} text-[11px]`} data-range-field="start" />
          <span className="text-[10px] text-muted">to</span>
          <input type="datetime-local" value={toLocalInput(r.end)} onChange={(e) => set({ end: fromLocalInput(e.target.value) })} title="End, excluded (your local time; empty: open)" className={`${fieldClass} text-[11px]`} data-range-field="end" />
        </div>
      )}
      {mode === "relative" && (
        <div className="order-last flex w-full flex-wrap items-center gap-1" data-range-fields="relative">
          <span className="text-[10px] text-muted">last</span>
          <input value={r.last ?? ""} onChange={(e) => set({ last: e.target.value.trim() || undefined })} placeholder="30d" title="The start: this long before now (s, m, h, d, w, mo, y)" className={`${fieldClass} w-16 font-mono text-[11px]`} data-range-field="last" />
          <span className="text-[10px] text-muted">ending</span>
          <input value={mag} onChange={(e) => setOff(e.target.value, ago || !off)} placeholder="now" title="The end: now when empty, else this long ago / from now" className={`${fieldClass} w-14 font-mono text-[11px]`} data-range-field="end_offset" />
          <select value={ago || !off ? "ago" : "ahead"} onChange={(e) => setOff(mag, e.target.value === "ago")} disabled={!mag} className={`${fieldClass} text-[11px]`} data-range-end-dir>
            <option value="ago">ago</option>
            <option value="ahead">from now</option>
          </select>
        </div>
      )}
    </>
  );
}

/** The style a rule gives the value text (text / background / all) and the sparkline's color (sparkline / all). */
export function ruleStyle(rule: Pick<FormatRule, "color" | "target"> | undefined): { text?: React.CSSProperties; line?: string } {
  if (!rule) return {};
  const t = rule.target ?? "text";
  return {
    text: t === "background" ? { background: rule.color } : t === "text" || t === "all" ? { color: rule.color } : undefined,
    line: t === "sparkline" || t === "all" ? rule.color : undefined,
  };
}

export const MEASURES: [TsMeasure, string][] = [["value", "summary value"], ["change", "change"], ["change_pct", "change %"], ["trend", "trend / day"]];

/** A measure of a time series cell. The summary value is the cell's (or `value` when given: the metric card's own,
 * rolling windows included); the others come from the sparkline's points over the range: change = last − first,
 * change % = that over |first| × 100 (none when first is 0), trend = the least-squares slope per day (per point when
 * the times do not parse). None with fewer than two points. */
export function tsMeasure(m: TsMeasure | undefined, cell: TsCellData | null | undefined, value?: number | null): number | null {
  if (!m || m === "value") return value !== undefined ? value : (cell?.value ?? null);
  const pts = (cell?.points ?? []).filter((p) => Number.isFinite(p[1]));
  if (pts.length < 2) return null;
  const first = pts[0][1];
  const last = pts[pts.length - 1][1];
  if (m === "change") return last - first;
  if (m === "change_pct") return first === 0 ? null : ((last - first) / Math.abs(first)) * 100;
  const ts = pts.map((p) => Date.parse(p[0]));
  const days = ts.every(Number.isFinite) ? ts.map((t) => (t - ts[0]) / 86_400_000) : pts.map((_, i) => i);
  const n = pts.length;
  const mx = days.reduce((a, b) => a + b, 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  days.forEach((x, i) => {
    sxy += (x - mx) * (pts[i][1] - my);
    sxx += (x - mx) ** 2;
  });
  return sxx === 0 ? null : sxy / sxx;
}

/** The first rule that matches its measure of the cell (rules without a test: the summary value). */
export function tsRuleFor(rules: FormatRule[] | undefined, cell: TsCellData | null | undefined, value?: number | null): FormatRule | undefined {
  return (rules ?? []).find((r) => {
    const v = tsMeasure(r.test, cell, value);
    return v !== null && !!ruleFor([{ ...r, column: undefined }], "", v);
  });
}

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? /^#?([0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return t < 0.5 ? a : b;
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
};

/** The color a scale gives a measure within [lo, hi] (clamped; the mid color at the middle when set). */
export function scaleColor(s: TsColorScale, v: number | null, lo: number | null | undefined, hi: number | null | undefined): string | undefined {
  if (v === null || !Number.isFinite(v)) return undefined;
  const a = s.min ?? lo;
  const b = s.max ?? hi;
  if (a === null || a === undefined || b === null || b === undefined) return undefined;
  const t = b === a ? 0.5 : Math.min(1, Math.max(0, (v - a) / (b - a)));
  if (s.mid_color) return t <= 0.5 ? mix(s.min_color, s.mid_color, t * 2) : mix(s.mid_color, s.max_color, (t - 0.5) * 2);
  return mix(s.min_color, s.max_color, t);
}

/** A column's scale bounds over the rows shown: the min and max of its measure (fixed bounds win). */
export function tsDomain(col: TsColumn, cells: Record<string, TsCellData> | undefined): { lo: number | null; hi: number | null } {
  const s = col.color_scale;
  if (!s || !cells) return { lo: null, hi: null };
  const vs = Object.values(cells).map((c) => tsMeasure(s.by, c)).filter((v): v is number => v !== null && Number.isFinite(v));
  return { lo: vs.length ? Math.min(...vs) : null, hi: vs.length ? Math.max(...vs) : null };
}

/** Every time series column's scale bounds (one pass per column, not per cell). */
export function useTsDomains(cols: TsColumn[], data: Record<string, Record<string, TsCellData>>) {
  return useMemo(() => Object.fromEntries(cols.map((c) => [c.id, tsDomain(c, data[c.id])])), [cols, data]);
}

export type TsStyle = { text?: React.CSSProperties; line?: string; rule?: FormatRule; scaled?: string };
/** The style of a time series value: the first matching rule, else the color scale. */
export function tsStyle(rules: FormatRule[] | undefined, scale: TsColorScale | undefined, cell: TsCellData | null | undefined, domain?: { lo: number | null; hi: number | null }, value?: number | null): TsStyle {
  const rule = tsRuleFor(rules, cell, value);
  if (rule) return { ...ruleStyle(rule), rule };
  if (!scale) return {};
  const color = scaleColor(scale, tsMeasure(scale.by, cell, value), domain?.lo, domain?.hi);
  return color ? { ...ruleStyle({ color, target: scale.target ?? "text" }), scaled: color } : {};
}

/** A small line of a series: its range scaled to the box, the last point marked. */
export function Sparkline({ points, color, width = 88, height = 22 }: { points: [string, number][]; color?: string; width?: number; height?: number }) {
  if (points.length < 2) return <span className="inline-block text-[10px] text-muted" style={{ width }}>—</span>;
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const pad = 2;
  const xy = vs.map((v, i) => [pad + (i / (vs.length - 1)) * (width - 2 * pad), pad + (1 - (v - lo) / span) * (height - 2 * pad)]);
  const last = xy[xy.length - 1];
  const stroke = color ?? "var(--color-ocean)";
  return (
    <svg width={width} height={height} className="shrink-0 overflow-visible" data-sparkline aria-label={`${vs.length} points from ${lo} to ${hi}`}>
      <polyline points={xy.map((p) => p.join(",")).join(" ")} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={stroke} stroke="var(--color-panel)" strokeWidth={1} />
    </svg>
  );
}

/** Rows per time series request (the API's page size). */
export const TS_PAGE = 500;

/** The time series columns of the rows shown: one request for every column per page of 500 rows (the summary — after
 * the column's rolling window when set — and the downsampled series), pages in turn, each shown as it arrives. */
export function useTsColumns(typeId: string | null, pks: string[], cols: TsColumn[] | undefined, version: number, resource: string) {
  const [data, setData] = useState<Record<string, Record<string, TsCellData>>>({});
  const spec = JSON.stringify({ typeId, pks, cols: (cols ?? []).map(tsColumnRequest), version });
  useEffect(() => {
    if (!typeId || !cols?.length || !pks.length) return;
    let stale = false;
    const columns = cols.map(tsColumnRequest);
    const unique = [...new Set(pks)];
    (async () => {
      const acc: Record<string, Record<string, TsCellData>> = Object.fromEntries(cols.map((c) => [c.id, {}]));
      for (let i = 0; i < unique.length && !stale; i += TS_PAGE) {
        const page = unique.slice(i, i + TS_PAGE);
        try {
          const r = await workshop.tsColumnsBatch({ object_type_id: typeId, primary_keys: page, columns, resource });
          for (const c of cols) Object.assign(acc[c.id], r.columns[c.id] ?? {});
        } catch (e) {
          for (const c of cols) for (const pk of page) acc[c.id][pk] = { error: (e as Error).message };
        }
        if (!stale) setData(Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { ...v }])));
      }
    })();
    return () => {
      stale = true;
    };
    // spec holds every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  return data;
}

const signed = (v: number | null | undefined, f: (v: number) => string) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${f(v)}`);

/** One time series cell: the formatted summary (with its unit) colored by the column's rules (on the summary or a
 * measure of the series) or its color scale (over the rows shown: `domain`), and the sparkline. */
export function TsCell({ col, cell, domain }: { col: TsColumn; cell: TsCellData | undefined; domain?: { lo: number | null; hi: number | null } }) {
  if (!cell) return <span className="text-muted">…</span>;
  if (cell.error) return <span className="text-[11px] text-bad" title={cell.error}>error</span>;
  const st = tsStyle(col.rules, col.color_scale, cell, domain);
  // a value change: both periods' summaries and the change in both forms on hover
  const vc = col.summarizer === "value_change" && cell.change !== undefined;
  const title = vc
    ? `previous ${fmtWith(cell.previous ?? null, col.format)}${cell.previous_at ? ` (${fmtWhen(cell.previous_at)})` : ""} → current ${fmtWith(cell.current ?? null, col.format)}${cell.at ? ` (${fmtWhen(cell.at)})` : ""}: ${signed(cell.change, (v) => fmtWith(v, col.format))} (${signed(cell.change_pct, (v) => `${v.toFixed(1)}%`)})`
    : cell.at
      ? `value at ${fmtWhen(cell.at)}`
      : undefined;
  return (
    <span className="flex items-center gap-2" data-ts-cell data-ts-color={st.rule?.color ?? st.scaled ?? ""} title={title}>
      <span className="whitespace-nowrap rounded px-0.5 tabular-nums" style={st.text} data-ts-value>
        {fmtWith(cell.value ?? null, col.format)}
        {cell.unit && !col.format?.suffix ? <span className="ml-0.5 text-[10px] text-muted">{cell.unit}</span> : null}
      </span>
      {col.sparkline !== false && <Sparkline points={cell.points ?? []} color={st.line} />}
    </span>
  );
}

// ------------------------------------------------------------------------------------------------
// editors
// ------------------------------------------------------------------------------------------------

const num = (s: string) => (s === "" ? undefined : Number(s));

/** The full value format: decimals or fraction digits, integer / significant digits, grouping, notation, affixes. */
export function ValueFormatFields({ f, set }: { f: ValueFormat; set: (x: Partial<ValueFormat>) => void }) {
  const n = (k: keyof ValueFormat, label: string, max = 20) => (
    <label className="flex flex-col gap-0.5 text-[10px] text-muted">
      {label}
      <input type="number" min={0} max={max} value={(f[k] as number | undefined) ?? ""} onChange={(e) => set({ [k]: num(e.target.value) })} className={`${fieldClass} w-full text-[11px]`} data-format-field={k} />
    </label>
  );
  return (
    <div className="space-y-1" data-value-format>
      <div className="grid grid-cols-3 gap-1">
        {n("min_fraction", "Min fraction")}
        {n("max_fraction", "Max fraction")}
        {n("min_integer", "Min integer", 21)}
        {n("min_significant", "Min signif.", 21)}
        {n("max_significant", "Max signif.", 21)}
        <label className="flex flex-col gap-0.5 text-[10px] text-muted">
          Notation
          <select value={f.notation ?? "standard"} onChange={(e) => set({ notation: e.target.value as ValueFormat["notation"] })} className={`${fieldClass} text-[11px]`} data-format-field="notation">
            <option value="standard">Standard</option>
            <option value="compact">Compact</option>
            <option value="scientific">Scientific</option>
            <option value="engineering">Engineering</option>
            <option value="percent">Percent</option>
          </select>
        </label>
      </div>
      <div className="flex items-center gap-1">
        <input value={f.prefix ?? ""} onChange={(e) => set({ prefix: e.target.value || undefined })} placeholder="prefix" className={`${fieldClass} w-16 text-[11px]`} />
        <input value={f.suffix ?? ""} onChange={(e) => set({ suffix: e.target.value || undefined })} placeholder="suffix" className={`${fieldClass} w-16 text-[11px]`} />
        <label className="ml-auto flex items-center gap-1 text-[11px] text-muted">
          <input type="checkbox" checked={f.grouping !== false} onChange={(e) => set({ grouping: e.target.checked ? undefined : false })} data-format-field="grouping" /> Grouping
        </label>
      </div>
      <p className="text-[10px] text-muted">Example: {fmtWith(1234567.891, f)} · {fmtWith(0.04567, f)}</p>
    </div>
  );
}

/** Conditional formatting rules on a time series (the first match wins): each tests the summary value or a measure of
 * the sparkline's series (change, change %, trend per day) and colors text, background, sparkline or all. */
export function RulesEditor({ rules, set, sparkline }: { rules: FormatRule[]; set: (r: FormatRule[]) => void; sparkline?: boolean }) {
  return (
    <div className="space-y-1" data-rules>
      {rules.map((r, i) => {
        const setR = (x: Partial<FormatRule>) => set(rules.map((y, j) => (j === i ? { ...y, ...x } : y)));
        return (
          <div key={i} className="flex flex-wrap items-center gap-1" data-rule={r.test ?? "value"}>
            <select value={r.test ?? "value"} onChange={(e) => setR({ test: e.target.value === "value" ? undefined : (e.target.value as TsMeasure) })} className={`${fieldClass} text-[11px]`} title="What the rule tests" data-rule-test>
              {MEASURES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select value={r.op} onChange={(e) => setR({ op: e.target.value as FormatRule["op"] })} className={`${fieldClass} text-[11px]`}>
              {["gt", "gte", "lt", "lte", "eq", "neq", "between"].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <input value={String(r.value ?? "")} onChange={(e) => setR({ value: e.target.value })} className={`${fieldClass} w-14 text-[11px]`} />
            {r.op === "between" && <input value={String(r.value2 ?? "")} onChange={(e) => setR({ value2: e.target.value })} placeholder="and" className={`${fieldClass} w-14 text-[11px]`} />}
            <input type="color" value={r.color} onChange={(e) => setR({ color: e.target.value })} className="h-6 w-7 bg-transparent" />
            <select value={r.target ?? "text"} onChange={(e) => setR({ target: e.target.value as FormatRule["target"] })} className={`${fieldClass} text-[11px]`}>
              <option value="text">text</option>
              <option value="background">fill</option>
              {sparkline && <option value="sparkline">sparkline</option>}
              {sparkline && <option value="all">text + sparkline</option>}
            </select>
            <button type="button" onClick={() => set(rules.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad">
              ✕
            </button>
          </div>
        );
      })}
      <button type="button" onClick={() => set([...rules, { op: "gt", value: 0, color: "#ef4444", target: sparkline ? "all" : "text" }])} className="text-ocean">
        + Rule
      </button>
      <p className="text-[10px] text-muted">Change = last − first point of the range; change % over the first; trend = the least-squares slope per day of the sparkline (above 0: rising).</p>
    </div>
  );
}

/** A color scale on a time series measure: two or three colors, bounds from the rows shown unless fixed. Rules win. */
export function ColorScaleEditor({ scale, set, sparkline, fixedOnly }: { scale: TsColorScale | undefined; set: (s: TsColorScale | undefined) => void; sparkline?: boolean; fixedOnly?: boolean }) {
  if (!scale)
    return (
      <button type="button" onClick={() => set({ by: "value", min_color: "#d95926", max_color: "#199e70", target: sparkline ? "all" : "text" })} className="text-ocean" data-add-color-scale>
        + Color scale
      </button>
    );
  const up = (x: Partial<TsColorScale>) => set({ ...scale, ...x });
  return (
    <div className="space-y-1" data-color-scale={scale.by ?? "value"}>
      <div className="flex flex-wrap items-center gap-1">
        <select value={scale.by ?? "value"} onChange={(e) => up({ by: e.target.value as TsMeasure })} className={`${fieldClass} text-[11px]`} title="The measure the scale colors by" data-scale-by>
          {MEASURES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input type="color" value={scale.min_color} onChange={(e) => up({ min_color: e.target.value })} className="h-6 w-7 bg-transparent" title="Low" />
        <label className="flex items-center gap-0.5 text-[10px] text-muted" title="A middle color (diverging scale)">
          <input type="checkbox" checked={!!scale.mid_color} onChange={(e) => up({ mid_color: e.target.checked ? "#c98500" : undefined })} /> mid
        </label>
        {scale.mid_color && <input type="color" value={scale.mid_color} onChange={(e) => up({ mid_color: e.target.value })} className="h-6 w-7 bg-transparent" title="Middle" />}
        <input type="color" value={scale.max_color} onChange={(e) => up({ max_color: e.target.value })} className="h-6 w-7 bg-transparent" title="High" />
        <select value={scale.target ?? "text"} onChange={(e) => up({ target: e.target.value as TsColorScale["target"] })} className={`${fieldClass} text-[11px]`}>
          <option value="text">text</option>
          <option value="background">fill</option>
          {sparkline && <option value="sparkline">sparkline</option>}
          {sparkline && <option value="all">text + sparkline</option>}
        </select>
        <button type="button" onClick={() => set(undefined)} className="px-1 text-muted hover:text-bad">
          ✕
        </button>
      </div>
      <div className="flex items-center gap-1">
        <input type="number" value={scale.min ?? ""} onChange={(e) => up({ min: num(e.target.value) })} placeholder={fixedOnly ? "min" : "min (auto)"} title="Low bound (empty: the lowest of the rows shown)" className={`${fieldClass} w-24 text-[11px]`} data-scale-min />
        <input type="number" value={scale.max ?? ""} onChange={(e) => up({ max: num(e.target.value) })} placeholder={fixedOnly ? "max" : "max (auto)"} title="High bound (empty: the highest of the rows shown)" className={`${fieldClass} w-24 text-[11px]`} data-scale-max />
      </div>
      {fixedOnly && (scale.min === undefined || scale.max === undefined) && <p className="text-[10px] text-warn">A single value needs both bounds.</p>}
    </div>
  );
}

function useTsTypes() {
  const [types, setTypes] = useState<TsObjectType[]>([]);
  useEffect(() => {
    tsOntology.objectTypes().then(setTypes, () => setTypes([]));
  }, []);
  return types;
}

/** A column's time series transforms after its rolling window, applied in order (the doc's aggregate, derivative,
 * integral, formula and time shift transforms). */
export function TransformsEditor({ transforms, set }: { transforms: TsTransform[]; set: (x: TsTransform[]) => void }) {
  const up = (i: number, x: Partial<TsTransform>) => set(transforms.map((t, j) => (j === i ? { ...t, ...x } : t)));
  const aggSelect = (t: TsTransform, i: number) => (
    <select value={t.aggregation ?? (t.type === "cumulative" || t.type === "periodic" ? "sum" : "mean")} onChange={(e) => up(i, { aggregation: e.target.value })} className={`${fieldClass} text-[11px]`} data-tr-field="aggregation">
      {ROLLING_AGGS.map((a) => (
        <option key={a}>{a}</option>
      ))}
    </select>
  );
  const unitSelect = (t: TsTransform, i: number) => (
    <select value={t.unit ?? "s"} onChange={(e) => up(i, { unit: e.target.value })} className={`${fieldClass} text-[11px]`} title="The time unit (per day, per week …)" data-tr-field="unit">
      {TIME_UNITS.map(([u, l]) => (
        <option key={u} value={u}>
          per {l}
        </option>
      ))}
    </select>
  );
  const text = (t: TsTransform, i: number, k: "window" | "period" | "formula" | "by", placeholder: string, w = "w-20") => (
    <input value={t[k] ?? ""} onChange={(e) => up(i, { [k]: e.target.value })} placeholder={placeholder} className={`${fieldClass} ${w} font-mono text-[11px]`} data-tr-field={k} />
  );
  return (
    <div className="space-y-1" data-ts-transforms>
      {transforms.map((t, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1" data-ts-transform={t.type}>
          <span className="text-[10px] text-muted">{i + 1}.</span>
          <select value={t.type} onChange={(e) => set(transforms.map((x, j) => (j === i ? NEW_TRANSFORM[e.target.value as TsTransform["type"]] : x)))} className={`${fieldClass} text-[11px]`} data-tr-field="type">
            {TRANSFORMS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {t.type === "rolling" && (
            <>
              {text(t, i, "window", "7d")}
              {aggSelect(t, i)}
            </>
          )}
          {t.type === "cumulative" && aggSelect(t, i)}
          {t.type === "periodic" && (
            <>
              {text(t, i, "period", "1w")}
              {aggSelect(t, i)}
              <select value={t.window_type ?? "start"} onChange={(e) => up(i, { window_type: e.target.value === "end" ? "end" : undefined })} className={`${fieldClass} text-[11px]`} title="Window type: start = each point is the start of its period and aggregates the points that follow it; end = the end of its period, aggregating the points that precede it" data-tr-field="window_type">
                <option value="start">at period start</option>
                <option value="end">at period end</option>
              </select>
              <input type="datetime-local" value={toLocalInput(t.align)} onChange={(e) => up(i, { align: fromLocalInput(e.target.value) })} title="Alignment timestamp (your local time): periods start here and at whole periods before / after it; empty: calendar periods (days from midnight UTC, weeks from Monday)" className={`${fieldClass} text-[11px]`} data-tr-field="align" />
            </>
          )}
          {t.type === "time_range" && (
            <RangePicker r={{ last: t.last, start: t.start, end: t.end, end_offset: t.end_offset }} set={(x) => up(i, x)} allowAll={false} />
          )}
          {t.type === "derivative" && unitSelect(t, i)}
          {t.type === "integral" && (
            <>
              {unitSelect(t, i)}
              <select value={t.method ?? "linear"} onChange={(e) => up(i, { method: e.target.value as TsTransform["method"] })} className={`${fieldClass} text-[11px]`} data-tr-field="method">
                <option value="linear">linear</option>
                <option value="left">left hand sum</option>
                <option value="right">right hand sum</option>
              </select>
            </>
          )}
          {t.type === "formula" && text(t, i, "formula", "$X * 2 + 5", "min-w-0 flex-1")}
          {t.type === "shift" && text(t, i, "by", "7d / -7d")}
          {i > 0 && (
            <button type="button" onClick={() => set(transforms.map((x, j) => (j === i - 1 ? transforms[i] : j === i ? transforms[i - 1] : x)))} className="px-1 text-muted hover:text-soft" title="Move up">
              ↑
            </button>
          )}
          <button type="button" onClick={() => set(transforms.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad" title="Remove the transform">
            ✕
          </button>
        </div>
      ))}
      <select value="" onChange={(e) => e.target.value && set([...transforms, NEW_TRANSFORM[e.target.value as TsTransform["type"]]])} className={`${fieldClass} text-[11px] text-ocean`} data-add-ts-transform>
        <option value="">+ Transform…</option>
        {TRANSFORMS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {transforms.some((t) => t.type === "formula") && <p className="text-[10px] text-muted">Formula: $X is the transform&apos;s input, $A the property, @name a property of the row&apos;s object.</p>}
    </div>
  );
}

/** The column's summarizer: a single value, or the value change between the range and the period before it. */
export function SummarizerFields({ col, set }: { col: TsColumn; set: (x: Partial<TsColumn>) => void }) {
  const vc = col.summarizer === "value_change";
  const at = col.aggregation === "value_at";
  return (
    <div className="space-y-1" data-ts-summarizer={vc ? "value_change" : "single"}>
      <div className="flex flex-wrap items-center gap-1">
        <select value={vc ? "value_change" : "single"} onChange={(e) => set(e.target.value === "value_change" ? { summarizer: "value_change", change_as: col.change_as ?? "absolute" } : { summarizer: undefined, change_as: undefined, change_offset: undefined })} className={`${fieldClass} text-[11px]`} title="Single value: the aggregation over the range. Value change: the aggregation over the range minus the same aggregation over the period before it." data-ts-summarizer-select>
          <option value="single">Single value</option>
          <option value="value_change">Value change</option>
        </select>
        {vc && (
          <>
            <select value={col.change_as ?? "absolute"} onChange={(e) => set({ change_as: e.target.value as TsColumn["change_as"] })} className={`${fieldClass} text-[11px]`} data-ts-change-as>
              <option value="absolute">difference</option>
              <option value="percent">percent</option>
            </select>
            <input value={col.change_offset ?? ""} onChange={(e) => set({ change_offset: e.target.value.trim() || undefined })} placeholder={at ? "vs. … earlier" : "vs. previous period"} title={at ? "Compare with the value this long before the time (e.g. 7d); empty: the range's length before it" : "Compare with the range this long before (e.g. 1y: the same period a year earlier); empty: the period just before"} className={`${fieldClass} w-28 font-mono text-[11px]`} data-ts-change-offset />
          </>
        )}
        {col.aggregation === "integral" && (
          <select value={col.integral_unit ?? "s"} onChange={(e) => set({ integral_unit: e.target.value })} className={`${fieldClass} text-[11px]`} title="The integral's time unit (value × time)" data-ts-integral-unit>
            {TIME_UNITS.map(([u, l]) => (
              <option key={u} value={u}>
                × {l}
              </option>
            ))}
          </select>
        )}
      </div>
      {at && <ValueAtFields col={col} set={set} />}
      {vc && !at && !col.range_last && !col.range_start && <p className="text-[10px] text-warn">Value change compares the range with the period before it: pick a range with a start.</p>}
      {vc && at && !col.change_offset && !col.range_last && !col.range_start && <p className="text-[10px] text-warn">Value change of a value at a time: enter how much earlier to compare with (7d), or pick a range.</p>}
    </div>
  );
}

type AtMode = "now" | "relative" | "exact";
const atMode = (v?: string): AtMode => (!v || v === "now" ? "now" : /^[+-]?\d+(\.\d+)?(s|m|min|h|d|w|mo|y)$/i.test(v.trim()) ? "relative" : "exact");

/** Value at a time (Quiver's "Value at time"): now, a time relative to now (this long ago / from now) or an exact time
 * (local), and the interpolation used between points. The range only sets the sparkline. */
function ValueAtFields({ col, set }: { col: TsColumn; set: (x: Partial<TsColumn>) => void }) {
  const v = col.value_at;
  const [mode, setMode] = useState<AtMode>(atMode(v));
  const ahead = !!v && mode === "relative" && !v.startsWith("-");
  const mag = mode === "relative" && v ? v.replace(/^[+-]/, "") : "";
  const setRel = (m: string, isAhead: boolean) => set({ value_at: m.trim() ? `${isAhead ? "" : "-"}${m.trim()}` : undefined });
  return (
    <div className="flex flex-wrap items-center gap-1" data-ts-value-at={mode}>
      <span className="text-[10px] text-muted">at</span>
      <select
        value={mode}
        onChange={(e) => {
          const m = e.target.value as AtMode;
          setMode(m);
          set({ value_at: m === "relative" ? "-7d" : undefined });
        }}
        className={`${fieldClass} text-[11px]`}
        data-ts-value-at-mode
      >
        <option value="now">now</option>
        <option value="relative">relative to now…</option>
        <option value="exact">an exact time…</option>
      </select>
      {mode === "relative" && (
        <>
          <input value={mag} onChange={(e) => setRel(e.target.value, ahead)} placeholder="7d" title="This long ago / from now (s, m, h, d, w, mo, y)" className={`${fieldClass} w-14 font-mono text-[11px]`} data-ts-value-at-offset />
          <select value={ahead ? "ahead" : "ago"} onChange={(e) => setRel(mag || "7d", e.target.value === "ahead")} className={`${fieldClass} text-[11px]`} data-ts-value-at-dir>
            <option value="ago">ago</option>
            <option value="ahead">from now</option>
          </select>
        </>
      )}
      {mode === "exact" && (
        <input type="datetime-local" value={toLocalInput(v)} onChange={(e) => set({ value_at: fromLocalInput(e.target.value) })} title="The time (your local time)" className={`${fieldClass} text-[11px]`} data-ts-value-at-time />
      )}
      <select value={col.value_at_interpolation ?? "series"} onChange={(e) => set({ value_at_interpolation: e.target.value === "series" ? undefined : (e.target.value as TsValueAtInterpolation) })} className={`${fieldClass} text-[11px]`} title="Between points: the series' own interpolation, the previous / next / nearest point, or a straight line between the two points around the time (none outside the points)" data-ts-value-at-interp>
        {VALUE_AT_INTERPOLATIONS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Object table: its time series property columns (object type sources whose type has time series properties). */
export function TsColumnsConfig({ widget, set }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void }) {
  const c = widget.config;
  const types = useTsTypes();
  const t = c.source?.kind === "object_type" ? types.find((x) => x.id === c.source!.id) : undefined;
  if (!t || !t.properties.length) return null;
  const cols = c.ts_columns ?? [];
  const setCol = (i: number, x: Partial<TsColumn>) => set({ ts_columns: cols.map((y, j) => (j === i ? { ...y, ...x } : y)) });
  return (
    <details className="rounded border border-line p-2 text-xs" open={cols.length > 0} data-ts-columns-config>
      <summary className="cursor-pointer text-soft">Time series columns</summary>
      <div className="mt-2 space-y-2">
        {cols.map((col, i) => (
          <div key={col.id} className="space-y-1.5 rounded border border-line-2 p-2" data-ts-column-config={col.id}>
            <div className="flex items-center gap-1">
              <select value={col.property} onChange={(e) => setCol(i, { property: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-[11px]`}>
                {t.properties.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.display_name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => set({ ts_columns: cols.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                ✕
              </button>
            </div>
            <input value={col.label ?? ""} onChange={(e) => setCol(i, { label: e.target.value || undefined })} placeholder="Column title" className={`${fieldClass} w-full text-[11px]`} />
            <div className="flex flex-wrap items-center gap-1" data-ts-range>
              <select value={col.aggregation ?? "last"} onChange={(e) => setCol(i, { aggregation: e.target.value as TsAggregation })} className={`${fieldClass} min-w-0 text-[11px]`} title="Summary value: the aggregation over the range" data-ts-aggregation>
                {AGGS.map(([a, l]) => (
                  <option key={a} value={a}>
                    {l}
                  </option>
                ))}
              </select>
              <RangePicker r={colRange(col)} set={(x) => setCol(i, toColRange(x))} />
              <label className="flex items-center gap-1 text-[11px] text-muted">
                <input type="checkbox" checked={col.sparkline !== false} onChange={(e) => setCol(i, { sparkline: e.target.checked })} /> Sparkline
              </label>
            </div>
            <div className="flex items-center gap-1" title="A rolling aggregate transform before the summary: each point aggregates the window preceding it (e.g. 7d mean: the weekly average); the summary and the sparkline are of that series">
              <span className="text-[11px] text-muted">Rolling</span>
              <input value={col.rolling ?? ""} onChange={(e) => setCol(i, { rolling: e.target.value.trim() || undefined })} placeholder="window, e.g. 7d" className={`${fieldClass} w-24 font-mono text-[11px]`} data-ts-rolling />
              <select value={col.rolling_agg ?? "mean"} onChange={(e) => setCol(i, { rolling_agg: e.target.value })} disabled={!col.rolling} className={`${fieldClass} text-[11px]`} data-ts-rolling-agg>
                {ROLLING_AGGS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </div>
            <TransformsEditor transforms={col.transforms ?? []} set={(x) => setCol(i, { transforms: x.length ? x : undefined })} />
            <SummarizerFields col={col} set={(x) => setCol(i, x)} />
            <div className="text-[10px] uppercase tracking-wide text-muted">Value formatting</div>
            <ValueFormatFields f={col.format ?? {}} set={(x) => setCol(i, { format: { ...col.format, ...x } })} />
            <div className="text-[10px] uppercase tracking-wide text-muted">Conditional formatting (summary value or series)</div>
            <RulesEditor rules={col.rules ?? []} set={(r) => setCol(i, { rules: r })} sparkline={col.sparkline !== false} />
            <ColorScaleEditor scale={col.color_scale} set={(s) => setCol(i, { color_scale: s })} sparkline={col.sparkline !== false} />
          </div>
        ))}
        <button type="button" onClick={() => set({ ts_columns: [...cols, { id: `ts${Date.now().toString(36)}`, property: t.default_property ?? t.properties[0].api_name, aggregation: "last", range_last: "30d" }] })} className="text-ocean" data-add-ts-column>
          + Time series column
        </button>
      </div>
    </details>
  );
}

/** The time series Metric Card's summary as a table column (the same request, server code and editors). */
export function metricColumn(c: WidgetConfig): TsColumn {
  return {
    id: "metric", property: c.tsps?.[0] ?? "", aggregation: c.ts_aggregation, range_last: c.range_last, rolling: c.rolling, rolling_agg: c.rolling_agg,
    transforms: c.ts_transforms, summarizer: c.ts_summarizer, change_as: c.ts_change_as, change_offset: c.ts_change_offset, integral_unit: c.ts_integral_unit,
    range_start: c.range_start, range_end: c.range_end, range_end_offset: c.range_end_offset, value_at: c.ts_value_at, value_at_interpolation: c.ts_value_at_interpolation,
  };
}
const METRIC_KEYS: [keyof TsColumn, keyof WidgetConfig][] = [
  ["aggregation", "ts_aggregation"], ["transforms", "ts_transforms"], ["summarizer", "ts_summarizer"], ["change_as", "ts_change_as"], ["change_offset", "ts_change_offset"],
  ["integral_unit", "ts_integral_unit"], ["range_last", "range_last"], ["range_start", "range_start"], ["range_end", "range_end"], ["range_end_offset", "range_end_offset"],
  ["value_at", "ts_value_at"], ["value_at_interpolation", "ts_value_at_interpolation"],
];
/** A change of the metric's column, as the widget config keys. */
export function metricConfig(x: Partial<TsColumn>): Partial<WidgetConfig> {
  return Object.fromEntries(METRIC_KEYS.filter(([k]) => k in x).map(([k, w]) => [w, x[k]])) as Partial<WidgetConfig>;
}
const METRIC_LEGACY_AGGS = ["last", "first", "mean", "min", "max", "sum"];
/** A Metric Card with only the original options (its value from the time series query, as before). */
export function metricIsLegacy(c: WidgetConfig): boolean {
  return !c.ts_transforms?.length && c.ts_summarizer !== "value_change" && METRIC_LEGACY_AGGS.includes(c.ts_aggregation ?? "last") && !c.range_start && !c.range_end && !c.range_end_offset;
}

/** Time series Metric Card: its summary (the table columns' summarizers, transforms and time ranges) and formatting. */
export function TsMetricFormatConfig({ widget, set }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void }) {
  const c = widget.config;
  const col = metricColumn(c);
  const setCol = (x: Partial<TsColumn>) => set(metricConfig(x));
  return (
    <>
      <details className="rounded border border-line p-2 text-xs" open data-ts-metric-summary>
        <summary className="cursor-pointer text-soft">Value: summarizer, transforms and time range</summary>
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1" data-ts-range>
            <select value={col.aggregation ?? "last"} onChange={(e) => setCol({ aggregation: e.target.value as TsAggregation })} className={`${fieldClass} min-w-0 text-[11px]`} title="The aggregation over the range (every aggregation of the doc)" data-ts-aggregation>
              {AGGS.map(([a, l]) => (
                <option key={a} value={a}>
                  {l}
                </option>
              ))}
            </select>
            <RangePicker r={colRange(col)} set={(x) => setCol(toColRange(x))} />
          </div>
          <TransformsEditor transforms={col.transforms ?? []} set={(x) => setCol({ transforms: x.length ? x : undefined })} />
          <SummarizerFields col={col} set={setCol} />
          <p className="text-[10px] text-muted">Transforms apply after the rolling window, in order; the value and the sparkline are of the transformed series.</p>
        </div>
      </details>
      <TsMetricFormatting widget={widget} set={set} />
    </>
  );
}

function TsMetricFormatting({ widget, set }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void }) {
  const c = widget.config;
  const f = c.formats?.[""] ?? {};
  return (
    <details className="rounded border border-line p-2 text-xs" open={!!(c.formats?.[""] || c.rules?.length || c.ts_color_scale)} data-ts-metric-format>
      <summary className="cursor-pointer text-soft">Formatting</summary>
      <div className="mt-2 space-y-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={c.ts_sparkline !== false} onChange={(e) => set({ ts_sparkline: e.target.checked })} /> Sparkline under the value
        </label>
        <div className="text-[10px] uppercase tracking-wide text-muted">Value formatting</div>
        <ValueFormatFields f={f} set={(x) => set({ formats: { ...c.formats, "": { ...f, ...x } } })} />
        <div className="text-[10px] uppercase tracking-wide text-muted">Conditional formatting</div>
        <RulesEditor rules={c.rules ?? []} set={(r) => set({ rules: r })} sparkline={c.ts_sparkline !== false} />
        <ColorScaleEditor scale={c.ts_color_scale} set={(s) => set({ ts_color_scale: s })} sparkline={c.ts_sparkline !== false} fixedOnly />
      </div>
    </details>
  );
}
