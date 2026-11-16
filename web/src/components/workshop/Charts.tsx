"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, OTHER, SERIES } from "@/lib/workshop";

type Datum = { key: unknown; value: number | null; count: number };

/** The element's size, kept current with a ResizeObserver. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md border border-line-2 bg-panel px-2.5 py-1.5 text-xs shadow-xl"
      style={{ left: x + 12, top: Math.max(0, y - 10) }}
    >
      {children}
    </div>
  );
}

const label = (k: unknown) => (k === null || k === undefined || k === "" ? "(empty)" : String(k));

/** Horizontal bars, one hue: categories down the side, values from a zero baseline. */
export function BarChart({ data, metricLabel, onSelect }: { data: Datum[]; metricLabel: string; onSelect?: (key: unknown) => void }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const rows = data.slice(0, 30);
  const labelW = Math.min(160, Math.max(60, w * 0.3));
  const valueW = 64;
  const plotW = Math.max(10, w - labelW - valueW - 8);
  const rowH = rows.length ? Math.max(14, Math.min(36, (h - 8) / rows.length)) : 20;
  const barH = Math.max(6, rowH - 6);
  const max = Math.max(0, ...rows.map((d) => d.value ?? 0));
  const min = Math.min(0, ...rows.map((d) => d.value ?? 0));
  const scale = (v: number) => ((v - min) / (max - min || 1)) * plotW;
  const zero = scale(0);
  return (
    <div ref={ref} className="relative h-full w-full overflow-y-auto" onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={Math.max(h, rows.length * rowH)} role="img" aria-label={`${metricLabel} by category`}>
          <line x1={labelW + zero} x2={labelW + zero} y1={0} y2={rows.length * rowH} stroke="var(--color-line-2)" />
          {rows.map((d, i) => {
            const v = d.value ?? 0;
            const x0 = labelW + Math.min(zero, scale(v));
            const bw = Math.max(1, Math.abs(scale(v) - zero));
            const y = i * rowH + (rowH - barH) / 2;
            return (
              <g
                key={i}
                onClick={() => onSelect?.(d.key)}
                className={onSelect ? "cursor-pointer" : undefined}
                onMouseMove={(e) => {
                  const r = ref.current!.getBoundingClientRect();
                  setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top + ref.current!.scrollTop });
                }}
              >
                {/* a hit target the full row tall, bigger than the bar */}
                <rect x={0} y={i * rowH} width={w} height={rowH} fill={hover?.i === i ? "rgba(255,255,255,0.04)" : "transparent"} />
                <text x={labelW - 8} y={i * rowH + rowH / 2} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--color-soft)">
                  {label(d.key).length > 22 ? `${label(d.key).slice(0, 21)}…` : label(d.key)}
                </text>
                <path
                  d={roundedEnd(x0, y, bw, barH, v >= 0)}
                  fill={SERIES[0]}
                />
                <text x={labelW + plotW + 6} y={i * rowH + rowH / 2} dominantBaseline="middle" fontSize={11} fill="var(--color-muted)">
                  {fmt(d.value)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && rows[hover.i] && (
        <Tooltip x={hover.x} y={hover.y}>
          <div className="font-medium">{label(rows[hover.i].key)}</div>
          <div className="text-soft">
            {metricLabel}: <span className="tabular-nums">{fmt(rows[hover.i].value)}</span>
          </div>
          <div className="text-muted">{rows[hover.i].count.toLocaleString()} rows</div>
        </Tooltip>
      )}
      {data.length > rows.length && <div className="px-2 text-[11px] text-muted">Top {rows.length} of {data.length}</div>}
    </div>
  );
}

/** A bar with a 4px rounded data end and a square end on the baseline. */
function roundedEnd(x: number, y: number, w: number, h: number, positive: boolean) {
  const r = Math.min(4, w / 2, h / 2);
  return positive
    ? `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`
    : `M${x + w},${y} H${x + r} Q${x},${y} ${x},${y + r} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w} Z`;
}

/** Share of a whole: at most 6 slices in fixed hue order, the rest folded into "Other". */
export function PieChart({ data, metricLabel, onSelect }: { data: Datum[]; metricLabel: string; onSelect?: (key: unknown) => void }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const positive = data.filter((d) => (d.value ?? 0) > 0);
  const top = positive.slice(0, 6);
  const rest = positive.slice(6);
  const slices = [
    ...top.map((d, i) => ({ label: label(d.key), value: d.value ?? 0, count: d.count, color: SERIES[i] })),
    ...(rest.length ? [{ label: `Other (${rest.length})`, value: rest.reduce((s, d) => s + (d.value ?? 0), 0), count: rest.reduce((s, d) => s + d.count, 0), color: OTHER }] : []),
  ];
  const total = slices.reduce((s, d) => s + d.value, 0);
  const legendW = w > 360 ? 170 : 0;
  const size = Math.max(40, Math.min(w - legendW - 16, h - (legendW ? 8 : 70)));
  const r = size / 2;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const a0 = angle;
    angle += total ? (s.value / total) * Math.PI * 2 : 0;
    return { ...s, a0, a1: angle };
  });
  const pt = (a: number, rad = r) => [r + Math.cos(a) * rad, r + Math.sin(a) * rad];
  return (
    <div ref={ref} className={`relative flex h-full w-full items-center justify-center gap-4 ${legendW ? "" : "flex-col"}`} onMouseLeave={() => setHover(null)}>
      {w > 0 && total > 0 && (
        <svg width={size} height={size} role="img" aria-label={`${metricLabel} share`}>
          {arcs.map((a, i) => {
            const [x0, y0] = pt(a.a0);
            const [x1, y1] = pt(a.a1);
            const large = a.a1 - a.a0 > Math.PI ? 1 : 0;
            const d = arcs.length === 1 ? `M${r},0 A${r},${r} 0 1 1 ${r - 0.01},0 Z` : `M${r},${r} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`;
            const share = a.value / total;
            const [lx, ly] = pt((a.a0 + a.a1) / 2, r * 0.62);
            return (
              <g
                key={i}
                onClick={() => i < top.length && onSelect?.(top[i].key)}
                className={onSelect && i < top.length ? "cursor-pointer" : undefined}
                onMouseMove={(e) => {
                  const rect = ref.current!.getBoundingClientRect();
                  setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
              >
                {/* a 2px surface gap between slices */}
                <path d={d} fill={a.color} stroke="var(--color-panel)" strokeWidth={2} opacity={hover && hover.i !== i ? 0.55 : 1} />
                {share >= 0.08 && size > 140 && (
                  <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="#fff" fontWeight={600} pointerEvents="none">
                    {Math.round(share * 100)}%
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {total > 0 && (
        <ul className={`space-y-1 text-xs ${legendW ? "w-[170px]" : "flex flex-wrap justify-center gap-x-3"}`}>
          {slices.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="truncate text-soft" title={s.label}>
                {s.label}
              </span>
              {legendW > 0 && <span className="ml-auto tabular-nums text-muted">{Math.round((s.value / total) * 100)}%</span>}
            </li>
          ))}
        </ul>
      )}
      {total === 0 && <span className="text-xs text-muted">No positive values to show</span>}
      {hover && slices[hover.i] && (
        <Tooltip x={hover.x} y={hover.y}>
          <div className="font-medium">{slices[hover.i].label}</div>
          <div className="text-soft">
            {metricLabel}: {fmt(slices[hover.i].value)} · {((slices[hover.i].value / total) * 100).toFixed(1)}%
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/** A measure over ordered keys (usually dates): 2px line, crosshair + tooltip on hover. */
export function LineChart({ data, metricLabel, onSelect }: { data: Datum[]; metricLabel: string; onSelect?: (key: unknown) => void }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = data.filter((d) => d.value !== null);
  const pad = { l: 52, r: 12, t: 10, b: 22 };
  const pw = Math.max(10, w - pad.l - pad.r);
  const ph = Math.max(10, h - pad.t - pad.b);
  const vals = pts.map((d) => d.value as number);
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const x = (i: number) => pad.l + (pts.length > 1 ? (i / (pts.length - 1)) * pw : pw / 2);
  const y = (v: number) => pad.t + ph - ((v - min) / (max - min || 1)) * ph;
  const ticks = [min, (min + max) / 2, max];
  const path = pts.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.value as number)}`).join(" ");
  const step = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(pw / 80))));
  return (
    <div
      ref={ref}
      className={`relative h-full w-full ${onSelect ? "cursor-crosshair" : ""}`}
      onMouseMove={(e) => {
        if (!pts.length) return;
        const r = ref.current!.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left - pad.l) / pw) * (pts.length - 1));
        setHover(Math.max(0, Math.min(pts.length - 1, i)));
      }}
      onClick={() => hover !== null && onSelect?.(pts[hover].key)}
      onMouseLeave={() => setHover(null)}
    >
      {w > 0 && pts.length > 0 && (
        <svg width={w} height={h} role="img" aria-label={`${metricLabel} over time`}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" />
              <text x={pad.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--color-muted)">
                {fmt(Math.round(t * 100) / 100)}
              </text>
            </g>
          ))}
          {pts.map((d, i) =>
            i % step === 0 ? (
              <text key={i} x={x(i)} y={h - 6} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
                {label(d.key)}
              </text>
            ) : null,
          )}
          <path d={path} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" />
          {hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ph} stroke="var(--color-line-2)" />
              <circle cx={x(hover)} cy={y(pts[hover].value as number)} r={4.5} fill={SERIES[0]} stroke="var(--color-panel)" strokeWidth={2} />
            </>
          )}
        </svg>
      )}
      {hover !== null && pts[hover] && (
        <Tooltip x={x(hover)} y={y(pts[hover].value as number)}>
          <div className="font-medium">{label(pts[hover].key)}</div>
          <div className="text-soft">
            {metricLabel}: <span className="tabular-nums">{fmt(pts[hover].value)}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}
