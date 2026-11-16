/** Geometry of a Fusion chart cell (chart.bar / chart.line / chart.chart): pure numbers, drawn as SVG by components/fusion/Chart.tsx. */
import type { ChartValue } from "./fusion";

export const CHART_COLORS = ["#3d8bfd", "#e2b866", "#34c38f", "#c084fc", "#f0616d", "#22d3ee"];

export type ChartGeometry = {
  width: number;
  height: number;
  /** the plotting area */
  area: { x0: number; y0: number; x1: number; y1: number };
  /** bars lie along the y axis (every plot is a bar and one asks for orientation 'horizontal') */
  horizontal: boolean;
  /** x is a number or time axis (only line plots, all of the same kind); otherwise categories in the order given */
  continuous: boolean;
  categories: string[];
  /** the value axis: from lo to hi */
  lo: number;
  hi: number;
  bars: { x: number; y: number; w: number; h: number; color: string; value: number; category: string; label: string | null; title: string | null }[];
  lines: { d: string; color: string; markers: boolean; points: { x: number; y: number; value: number; title: string | null }[] }[];
  valueTicks: { at: number; label: string }[];
  xTicks: { at: number; label: string }[];
  /** where value 0 is on the value axis (bars start there) */
  zero: number;
  legend: { label: string; color: string }[];
  axes: boolean;
};

export const chartNumber = (n: number) => (n !== 0 && (Math.abs(n) >= 1e6 || Math.abs(n) < 1e-3) ? n.toExponential(1) : String(Math.round(n * 100) / 100));

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

const dateLabel = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
};

/**
 * Where everything goes in a width × height box. `compact` is the chart inside an ordinary cell: no axes, legend or
 * labels, the marks fill the box.
 */
export function chartGeometry(chart: ChartValue, width: number, height: number, compact = false): ChartGeometry {
  const plots = chart.plots;
  const opt = chart.options ?? {};
  const axes = !compact && opt.showAxes !== false;
  const withLegend = !compact && (opt.showLegend ?? plots.length > 1);
  const tips = opt.tooltip !== false;
  const horizontal = plots.length > 0 && plots.every((p) => p.type === "bar") && plots.some((p) => p.options.orientation === "horizontal");
  const continuous = plots.length > 0 && plots.every((p) => p.type === "line" && p.x_num !== null && p.x_kind !== "category" && p.x_kind === plots[0].x_kind);
  const pad = compact ? 2 : 6;
  const area = {
    x0: axes ? (horizontal ? 70 : 44) : pad,
    y0: pad + (withLegend ? 16 : 0),
    x1: width - (compact ? 2 : 10),
    y1: height - (axes ? 20 : pad),
  };
  const key = (v: string | number | null) => (v === null ? "" : String(v));
  const categories: string[] = [];
  if (!continuous) for (const p of plots) for (const v of p.x) if (!categories.includes(key(v))) categories.push(key(v));

  // the value axis
  const ys = plots.flatMap((p) => p.y.filter((v): v is number => typeof v === "number"));
  let lo = ys.length ? Math.min(...ys) : 0;
  let hi = ys.length ? Math.max(...ys) : 1;
  const anyBar = plots.some((p) => p.type === "bar");
  if (anyBar) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (hi === lo) {
    hi += 1;
    lo -= anyBar ? 0 : 1;
  } else if (!anyBar) {
    const m = (hi - lo) * 0.05;
    lo -= m;
    hi += m;
  }
  if (plots.some((p) => p.type === "bar" && p.options.drawLabels) && !compact) hi += (hi - lo) * 0.12;
  const vAt = (v: number) => (horizontal ? area.x0 + ((v - lo) / (hi - lo)) * (area.x1 - area.x0) : area.y1 - ((v - lo) / (hi - lo)) * (area.y1 - area.y0));
  const zero = vAt(Math.min(Math.max(0, lo), hi));

  // the x axis (the category axis of horizontal bars runs down the left side)
  const span = horizontal ? area.y1 - area.y0 : area.x1 - area.x0;
  const start = horizontal ? area.y0 : area.x0;
  const band = span / Math.max(1, categories.length);
  const xs = continuous ? plots.flatMap((p) => p.x_num ?? []) : [];
  const xlo = xs.length ? Math.min(...xs) : 0;
  const xhi = xs.length ? Math.max(...xs) : 1;
  const xAt = (x: number) => (xhi > xlo ? start + ((x - xlo) / (xhi - xlo)) * span : start + span / 2);
  const center = (cat: string) => start + (categories.indexOf(cat) + 0.5) * band;

  const bars: ChartGeometry["bars"] = [];
  const lines: ChartGeometry["lines"] = [];
  const barPlots = plots.filter((p) => p.type === "bar");
  const thick = (band * 0.8) / Math.max(1, barPlots.length);
  plots.forEach((p, pi) => {
    const color = (p.type === "line" && p.options.color) || CHART_COLORS[pi % CHART_COLORS.length];
    if (p.type === "bar") {
      const bi = barPlots.indexOf(p);
      p.y.forEach((v, i) => {
        if (typeof v !== "number") return;
        const cat = key(p.x[i]);
        const along = center(cat) - (band * 0.8) / 2 + bi * thick;
        const end = vAt(v);
        const from = Math.min(zero, end);
        const len = Math.abs(end - zero);
        bars.push({
          ...(horizontal ? { x: from, y: along, w: len, h: thick } : { x: along, y: from, w: thick, h: len }),
          color,
          value: v,
          category: cat,
          label: p.options.drawLabels && !compact ? chartNumber(v) : null,
          title: tips ? `${cat}: ${chartNumber(v)}` : null,
        });
      });
    } else {
      const points: ChartGeometry["lines"][number]["points"] = [];
      p.y.forEach((v, i) => {
        if (typeof v !== "number") return;
        const x = continuous ? xAt((p.x_num as number[])[i]) : center(key(p.x[i]));
        points.push({ x, y: vAt(v), value: v, title: tips ? `${key(p.x[i])}: ${chartNumber(v)}` : null });
      });
      lines.push({ d: points.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(" "), color, markers: !!p.options.dataMarkers, points });
    }
  });

  const valueTicks: ChartGeometry["valueTicks"] = [];
  const xTicks: ChartGeometry["xTicks"] = [];
  if (axes) {
    const step = niceStep(hi - lo, 4);
    for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + step * 1e-9; t += step) valueTicks.push({ at: vAt(t), label: chartNumber(Math.abs(t) < step * 1e-9 ? 0 : t) });
    if (continuous) {
      const n = xhi > xlo ? 4 : 0;
      for (let i = 0; i <= n; i++) {
        const x = xlo + ((xhi - xlo) * i) / Math.max(1, n);
        xTicks.push({ at: xAt(x), label: plots[0].x_kind === "date" ? dateLabel(x) : chartNumber(x) });
      }
    } else {
      // as many category labels as fit
      const every = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(span / (horizontal ? 14 : 56)))));
      categories.forEach((c, i) => {
        if (i % every === 0) xTicks.push({ at: center(c), label: c.length > 12 ? `${c.slice(0, 11)}…` : c });
      });
    }
  }
  const legend = withLegend
    ? plots.map((p, pi) => ({ label: `Series ${pi + 1} (${p.type})`, color: (p.type === "line" && p.options.color) || CHART_COLORS[pi % CHART_COLORS.length] }))
    : [];
  return { width, height, area, horizontal, continuous, categories, lo, hi, bars, lines, valueTicks, xTicks, zero, legend, axes };
}

/** The size a chart cell asks for with chart.options('width', …, 'height', …); null = it stays inside its cell. */
export function chartSize(chart: ChartValue): { width: number; height: number } | null {
  const { width, height } = chart.options ?? {};
  if (!width && !height) return null;
  return { width: width ?? 320, height: height ?? 200 };
}
