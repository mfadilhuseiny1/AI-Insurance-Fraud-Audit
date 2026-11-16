"use client";

/** Small SVG charts for model experiments and evaluations: metric series, bars, a matrix, parallel coordinates. */

export const SERIES_COLORS = ["#4cc2ff", "#f5a524", "#7ee787", "#f778ba", "#c297ff"];

const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : String(Math.round(v * 10000) / 10000));

export type Series = { name: string; color: string; points: [number, number][] };

export function LineChart({ series, height = 150, xLabel, yLabel }: { series: Series[]; height?: number; xLabel?: string; yLabel?: string }) {
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return <div className="py-6 text-center text-xs text-muted">No values</div>;
  if (series.every((s) => s.points.length <= 1)) {
    // logged once: the value itself, not a lone dot on an axis
    return (
      <div className="flex flex-wrap gap-6 py-4">
        {series.filter((s) => s.points.length).map((s) => (
          <div key={s.name}><div className="text-xs" style={{ color: s.color }}>{s.name}</div><div className="font-mono text-2xl text-white">{fmt(s.points[0][1])}</div></div>
        ))}
      </div>
    );
  }
  const W = 420;
  const pad = { l: 46, r: 8, t: 8, b: 22 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
  const sx = (x: number) => pad.l + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (height - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={W - pad.r} y1={pad.t + f * (height - pad.t - pad.b)} y2={pad.t + f * (height - pad.t - pad.b)} stroke="currentColor" className="text-line" strokeWidth={0.5} />
          <text x={pad.l - 4} y={pad.t + f * (height - pad.t - pad.b) + 3} textAnchor="end" className="fill-muted" fontSize={9}>
            {fmt(y1 - f * (y1 - y0))}
          </text>
        </g>
      ))}
      <text x={pad.l} y={height - 6} className="fill-muted" fontSize={9}>{fmt(x0)}</text>
      <text x={W - pad.r} y={height - 6} textAnchor="end" className="fill-muted" fontSize={9}>{fmt(x1)}</text>
      {xLabel && <text x={(W + pad.l) / 2} y={height - 6} textAnchor="middle" className="fill-muted" fontSize={9}>{xLabel}</text>}
      {yLabel && <text x={4} y={pad.t + 6} className="fill-muted" fontSize={9}>{yLabel}</text>}
      {series.map((s) => (
        <g key={s.name}>
          <polyline fill="none" stroke={s.color} strokeWidth={1.5} points={s.points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(" ")} />
          {s.points.length <= 40 && s.points.map((p, i) => (
            <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={2} fill={s.color}>
              <title>{`${s.name}: ${fmt(p[1])} at ${fmt(p[0])}`}</title>
            </circle>
          ))}
        </g>
      ))}
    </svg>
  );
}

export function BarChart({ x, y, color = SERIES_COLORS[0], height = 140 }: { x: string[]; y: number[]; color?: string; height?: number }) {
  if (!y.length) return <div className="py-6 text-center text-xs text-muted">No values</div>;
  const W = 420;
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  const max = Math.max(...y, 1);
  const bw = (W - pad.l - pad.r) / y.length;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
      {y.map((v, i) => {
        const h = (v / max) * (height - pad.t - pad.b);
        return (
          <g key={i}>
            <rect x={pad.l + i * bw + 1} y={height - pad.b - h} width={Math.max(1, bw - 2)} height={h} fill={color} opacity={0.85}>
              <title>{`${x[i]}: ${v}`}</title>
            </rect>
            {y.length <= 12 && <text x={pad.l + i * bw + bw / 2} y={height - pad.b - h - 2} textAnchor="middle" className="fill-soft" fontSize={9}>{v}</text>}
          </g>
        );
      })}
      <text x={pad.l} y={height - 6} className="fill-muted" fontSize={9}>{x[0]}</text>
      <text x={W - pad.r} y={height - 6} textAnchor="end" className="fill-muted" fontSize={9}>{x[x.length - 1]}</text>
    </svg>
  );
}

export function Matrix({ rows, columns, values }: { rows: string[]; columns: string[]; values: number[][] }) {
  const max = Math.max(...values.flat(), 1);
  return (
    <table className="w-full border-separate border-spacing-1 text-xs">
      <thead>
        <tr>
          <th />
          {columns.map((c) => <th key={c} className="px-2 py-1 text-center font-normal text-muted">{c}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r}>
            <th className="whitespace-nowrap px-2 py-1 text-left font-normal text-muted">{r}</th>
            {values[i].map((v, j) => (
              <td key={j} className="rounded px-2 py-3 text-center font-mono text-sm text-white" style={{ background: `rgba(76,194,255,${0.08 + 0.6 * (v / max)})` }}>{v}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One line per row across the axes (hyperparameters, then the output metric): numbers scaled per axis, strings by rank. */
export function ParallelCoordinates({ axes, rows, height = 180 }: { axes: string[]; rows: { label: string; color: string; values: (number | string | boolean | null)[] }[]; height?: number }) {
  if (axes.length < 2 || !rows.length) return <div className="py-6 text-center text-xs text-muted">Choose at least one parameter and a metric</div>;
  const W = 640;
  const pad = { l: 40, r: 40, t: 22, b: 24 };
  const scales = axes.map((_, a) => {
    const vals = rows.map((r) => r.values[a]).filter((v) => v !== null && v !== undefined);
    if (vals.every((v) => typeof v === "number")) {
      const nums = vals as number[];
      const [lo, hi] = [Math.min(...nums), Math.max(...nums)];
      return { pos: (v: unknown) => (hi === lo ? 0.5 : ((v as number) - lo) / (hi - lo)), lo: fmt(lo), hi: fmt(hi) };
    }
    const cats = [...new Set(vals.map(String))].sort();
    return { pos: (v: unknown) => (cats.length <= 1 ? 0.5 : cats.indexOf(String(v)) / (cats.length - 1)), lo: cats[0] ?? "", hi: cats[cats.length - 1] ?? "" };
  });
  const ax = (a: number) => pad.l + (a / (axes.length - 1)) * (W - pad.l - pad.r);
  const ay = (f: number) => pad.t + (1 - f) * (height - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
      {axes.map((name, a) => (
        <g key={name}>
          <line x1={ax(a)} x2={ax(a)} y1={pad.t} y2={height - pad.b} stroke="currentColor" className="text-line-2" />
          <text x={ax(a)} y={12} textAnchor="middle" className="fill-soft" fontSize={10}>{name}</text>
          <text x={ax(a)} y={pad.t - 2} textAnchor="middle" className="fill-muted" fontSize={8}>{scales[a].hi}</text>
          <text x={ax(a)} y={height - 10} textAnchor="middle" className="fill-muted" fontSize={8}>{scales[a].lo}</text>
        </g>
      ))}
      {rows.map((r) => (
        <polyline key={r.label} fill="none" stroke={r.color} strokeWidth={1.5} opacity={0.9}
          points={r.values.map((v, a) => (v === null || v === undefined ? null : `${ax(a)},${ay(scales[a].pos(v))}`)).filter(Boolean).join(" ")}>
          <title>{r.label}</title>
        </polyline>
      ))}
    </svg>
  );
}

/** A logged table (experiments and evaluations). */
export function LoggedTableView({ table, max = 200 }: { table: { columns: string[]; rows: unknown[][]; description?: string }; max?: number }) {
  return (
    <div>
      {table.description && <p className="mb-1 text-xs text-muted">{table.description}</p>}
      <div className="max-h-72 overflow-auto rounded border border-line">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-panel-2 text-muted">
            <tr>{table.columns.map((c) => <th key={c} className="px-2 py-1 text-left font-normal">{c}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.slice(0, max).map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((v, j) => <td key={j} className="px-2 py-1 font-mono text-soft">{typeof v === "number" ? fmt(v) : String(v ?? "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > max && <p className="mt-1 text-[11px] text-muted">First {max} of {table.rows.length} rows</p>}
    </div>
  );
}

export const formatMetric = fmt;
