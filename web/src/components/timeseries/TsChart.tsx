"use client";

import { useMemo, useState } from "react";
import { useSize } from "@/components/workshop/Charts";
import { fmtValue, type Interval, type SeriesPoint } from "@/lib/timeseries";
import { SERIES } from "@/lib/workshop";

export type ChartSeries = { key: string; label: string; unit?: string | null; points: SeriesPoint[]; categorical?: boolean; color?: string };

type Num = { x: number; y: number; lo?: number; hi?: number };

/**
 * Time series on a shared time axis: numeric series as lines (a min–max band where points were bucketed), one
 * y-axis per unit (left, then right), categorical series as coloured state strips under the plot, and search
 * intervals shaded. Hover shows every series' value at that time.
 */
export function TsChart({ series, intervals = [], height = 240, empty = "No points in this range." }: { series: ChartSeries[]; intervals?: Interval[]; height?: number; empty?: string }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const numeric = series.filter((s) => !s.categorical);
  const cats = series.filter((s) => s.categorical);
  const data = useMemo(
    () =>
      numeric.map((s) => ({
        s,
        pts: s.points.filter((p) => typeof p.value === "number").map((p) => ({ x: Date.parse(p.t), y: p.value as number, lo: p.min, hi: p.max }) as Num),
      })),
    [numeric],
  );
  const catData = useMemo(() => cats.map((s) => ({ s, pts: s.points.map((p) => ({ x: Date.parse(p.t), v: String(p.value) })) })), [cats]);
  const xs = [...data.flatMap((d) => d.pts.map((p) => p.x)), ...catData.flatMap((d) => d.pts.map((p) => p.x)), ...intervals.flatMap((i) => [Date.parse(i.start), ...(i.end ? [Date.parse(i.end)] : [])])];
  if (!xs.length)
    return (
      <div ref={ref} className="flex items-center justify-center rounded-md border border-line bg-ink text-xs text-muted" style={{ height }}>
        {empty}
      </div>
    );
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const units = [...new Set(data.map((d) => d.s.unit ?? ""))];
  const axisOf = (u: string | null | undefined) => Math.min(1, units.indexOf(u ?? ""));
  const stripH = 14;
  const pad = { l: 52, r: units.length > 1 ? 52 : 12, t: 8, b: 22 + cats.length * (stripH + 4) };
  const W = Math.max(w, 200);
  const plotH = Math.max(40, height - pad.t - pad.b);
  const ranges = [0, 1].map((ax) => {
    const vals = data.filter((d) => axisOf(d.s.unit) === ax).flatMap((d) => d.pts.flatMap((p) => [p.lo ?? p.y, p.hi ?? p.y]));
    if (!vals.length) return null;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const span = hi - lo || Math.abs(hi) || 1;
    lo -= span * 0.05;
    hi += span * 0.05;
    return { lo, hi };
  });
  const sx = (x: number) => pad.l + (x1 === x0 ? (W - pad.l - pad.r) / 2 : ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r));
  const sy = (y: number, ax: number) => {
    const r = ranges[ax] ?? ranges[0] ?? { lo: 0, hi: 1 };
    return pad.t + (1 - (y - r.lo) / (r.hi - r.lo)) * plotH;
  };
  const color = (i: number, s: ChartSeries) => s.color ?? SERIES[i % SERIES.length];
  const label = (ms: number) => {
    const d = new Date(ms).toISOString();
    return x1 - x0 > 2 * 86_400_000 ? d.slice(0, 10) : d.slice(5, 16).replace("T", " ");
  };
  const catColors = new Map<string, string>();
  const catColor = (v: string) => {
    if (!catColors.has(v)) catColors.set(v, SERIES[(catColors.size + 3) % SERIES.length]);
    return catColors.get(v)!;
  };
  const near = (pts: { x: number }[], x: number) => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].x - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const hoverX = hover !== null ? x0 + ((hover - pad.l) / Math.max(1, W - pad.l - pad.r)) * (x1 - x0) : null;
  return (
    <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg
          width={W}
          height={height}
          className="rounded-md border border-line bg-ink"
          role="img"
          aria-label={`Time series: ${series.map((s) => s.label).join(", ")}`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left;
            setHover(x >= pad.l && x <= W - pad.r ? x : null);
          }}
        >
          {intervals.map((iv, i) => {
            const a = sx(Date.parse(iv.start));
            const b = sx(iv.end ? Date.parse(iv.end) : x1);
            return <rect key={i} x={a} y={pad.t} width={Math.max(2, b - a)} height={plotH} className="fill-warn/15" />;
          })}
          {[0, 1].map((ax) => {
            const r = ranges[ax];
            if (!r || (ax === 1 && units.length < 2)) return null;
            return [0, 0.25, 0.5, 0.75, 1].map((f) => {
              const v = r.lo + f * (r.hi - r.lo);
              const y = sy(v, ax);
              return (
                <g key={`${ax}-${f}`}>
                  {ax === 0 && <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="stroke-line" strokeWidth={1} />}
                  <text x={ax === 0 ? pad.l - 6 : W - pad.r + 6} y={y + 3} textAnchor={ax === 0 ? "end" : "start"} className="fill-muted text-[10px]">
                    {fmtValue(v)}
                  </text>
                </g>
              );
            });
          })}
          {units.slice(0, 2).map((u, ax) =>
            u ? (
              <text key={u} x={ax === 0 ? 4 : W - 4} y={pad.t + 8} textAnchor={ax === 0 ? "start" : "end"} className="fill-soft text-[10px]">
                {u}
              </text>
            ) : null,
          )}
          {data.map(({ s, pts }, i) => {
            const ax = axisOf(s.unit);
            const band = pts.some((p) => p.lo !== undefined)
              ? [...pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.hi ?? p.y, ax).toFixed(1)}`), ...[...pts].reverse().map((p) => `${sx(p.x).toFixed(1)},${sy(p.lo ?? p.y, ax).toFixed(1)}`)].join(" ")
              : null;
            return (
              <g key={s.key}>
                {band && <polygon points={band} fill={color(i, s)} opacity={0.15} />}
                <polyline points={pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y, ax).toFixed(1)}`).join(" ")} fill="none" stroke={color(i, s)} strokeWidth={1.75} strokeLinejoin="round" />
                {pts.length <= 40 && pts.map((p) => <circle key={p.x} cx={sx(p.x)} cy={sy(p.y, ax)} r={2.25} fill={color(i, s)} />)}
              </g>
            );
          })}
          {catData.map(({ s, pts }, i) => {
            const y = pad.t + plotH + 18 + i * (stripH + 4);
            return (
              <g key={s.key}>
                {pts.map((p, j) => {
                  const a = sx(p.x);
                  const b = j + 1 < pts.length ? sx(pts[j + 1].x) : W - pad.r;
                  return (
                    <rect key={p.x} x={a} y={y} width={Math.max(1, b - a)} height={stripH} fill={catColor(p.v)} opacity={0.75}>
                      <title>{`${s.label}: ${p.v}`}</title>
                    </rect>
                  );
                })}
                <text x={pad.l - 6} y={y + 10} textAnchor="end" className="fill-muted text-[9px]">
                  {s.label.slice(0, 10)}
                </text>
              </g>
            );
          })}
          <text x={pad.l} y={height - 6} className="fill-muted text-[10px]">
            {label(x0)}
          </text>
          <text x={W - pad.r} y={height - 6} textAnchor="end" className="fill-muted text-[10px]">
            {label(x1)}
          </text>
          {hover !== null && <line x1={hover} x2={hover} y1={pad.t} y2={pad.t + plotH} className="stroke-soft" strokeDasharray="3 3" />}
        </svg>
      )}
      {hover !== null && hoverX !== null && (
        <div className="pointer-events-none absolute z-20 rounded-md border border-line-2 bg-panel px-2.5 py-1.5 text-xs shadow-xl" style={{ left: Math.min(hover + 12, W - 180), top: 8 }}>
          <div className="mb-1 text-muted">{new Date(hoverX).toISOString().slice(0, 19).replace("T", " ")}</div>
          {data.map(({ s, pts }, i) => {
            const k = near(pts, hoverX);
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: color(i, s) }} />
                <span className="max-w-40 truncate text-soft">{s.label}</span>
                <span className="ml-auto pl-2 tabular-nums">{k >= 0 ? `${fmtValue(pts[k].y)}${s.unit ? ` ${s.unit}` : ""}` : "—"}</span>
              </div>
            );
          })}
          {catData.map(({ s, pts }) => {
            let k = -1;
            for (let j = 0; j < pts.length && pts[j].x <= hoverX; j++) k = j;
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="max-w-40 truncate text-soft">{s.label}</span>
                <span className="ml-auto pl-2">{k >= 0 ? pts[k].v : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-soft">
          {data.map(({ s }, i) => (
            <span key={s.key} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: color(i, s) }} />
              {s.label}
              {s.unit ? <span className="text-muted">({s.unit})</span> : null}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Presets for a query's time range; "All" reads every point. */
export const RANGE_PRESETS: [string, string | null][] = [
  ["1 hour", "1h"],
  ["1 day", "1d"],
  ["7 days", "7d"],
  ["30 days", "30d"],
  ["All", null],
];

export function RangePicker({
  value,
  onChange,
}: {
  value: { start?: string | null; end?: string | null; last?: string | null };
  onChange: (v: { start?: string | null; end?: string | null; last?: string | null }) => void;
}) {
  const custom = !value.last && (value.start || value.end);
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {RANGE_PRESETS.map(([label, last]) => {
        const on = last ? value.last === last : !value.last && !value.start && !value.end;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChange(last ? { last } : {})}
            className={`rounded-md px-2 py-0.5 ${on ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
          >
            {label}
          </button>
        );
      })}
      <span className={`ml-1 flex items-center gap-1 rounded-md px-1 ${custom ? "ring-1 ring-ocean/40" : ""}`}>
        <input
          type="datetime-local"
          value={value.start ? value.start.slice(0, 16) : ""}
          onChange={(e) => onChange({ start: e.target.value ? new Date(e.target.value).toISOString() : null, end: value.end ?? null })}
          className="rounded border border-line-2 bg-ink px-1 py-0.5 text-[11px]"
          aria-label="Start"
        />
        →
        <input
          type="datetime-local"
          value={value.end ? value.end.slice(0, 16) : ""}
          onChange={(e) => onChange({ start: value.start ?? null, end: e.target.value ? new Date(e.target.value).toISOString() : null })}
          className="rounded border border-line-2 bg-ink px-1 py-0.5 text-[11px]"
          aria-label="End"
        />
      </span>
    </div>
  );
}
