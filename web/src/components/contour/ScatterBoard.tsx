"use client";

/**
 * Contour's scatter plot (a Chart board of kind "scatter", Analytics doc 03): points drawn on a canvas (up to 50,000),
 * or the server's density bins above the point limit; color by a column (categories or a scale), size by a column,
 * log axes, a least-squares trend line, hover tooltips, wheel zoom (double-click resets) and brushing: dragging a
 * rectangle selects the rows inside it (Ctrl / Cmd / Shift adds another rectangle), clicking a legend category selects
 * its rows; the selection filters the boards below (api/contour_viz.py). Without the server's summary (Quiver cards)
 * the legend, ranges and trend are computed here from the rows.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardConfig, ColorLegend, ScatterMeta } from "@/lib/contour";
import { fmt } from "@/lib/workshop";
import { CATEGORY, colorOf, niceTicks, OTHER, SCALE_CSS, scaleColor, short } from "./vizColors";

type Rect = { x0: number; x1: number; y0: number; y1: number };
type Dom = { x0: number; x1: number; y0: number; y1: number };
const M = { l: 52, r: 12, t: 10, b: 30 };
const H = 280;

type Model = {
  mode: "points" | "bins";
  logX: boolean;
  logY: boolean;
  px: Float64Array;
  py: Float64Array;
  color: string[];
  radius: Float32Array;
  raw: Record<string, unknown>[];
  bins: { bx: number; by: number; count: number }[];
  B: number;
  ext: Dom;
  legend?: ColorLegend;
  trend: { slope: number; intercept: number; r2: number | null } | null;
  n: number;
  excluded: number;
  maxCount: number;
  meta?: ScatterMeta;
};

function legendOf(vals: unknown[]): ColorLegend | undefined {
  if (!vals.length) return undefined;
  if (vals.every((v) => v === null || typeof v === "number")) {
    const nums = vals.filter((v): v is number => typeof v === "number");
    return { kind: "scale", min: nums.length ? Math.min(...nums) : null, max: nums.length ? Math.max(...nums) : null };
  }
  const counts = new Map<string | null, number>();
  for (const v of vals) counts.set(v === null || v === undefined ? null : String(v), (counts.get(v === null || v === undefined ? null : String(v)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return { kind: "category", values: top.slice(0, 10).map((e) => e[0]), counts: top.slice(0, 10).map((e) => e[1]), distinct: top.length };
}

function fit(px: Float64Array, py: Float64Array) {
  const n = px.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    sx += px[i];
    sy += py[i];
  }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = px[i] - mx, dy = py[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : null };
}

function model(rows: Record<string, unknown>[], meta: ScatterMeta | undefined, c: BoardConfig): Model {
  const logX = meta ? meta.log_x : !!c.log_x;
  const logY = meta ? meta.log_y : !!c.log_y;
  if (meta?.mode === "bins") {
    const B = meta.bins ?? 80;
    const bins = rows.map((r) => ({ bx: Number(r.bx), by: Number(r.by), count: Number(r.count) }));
    return {
      mode: "bins", logX, logY, px: new Float64Array(), py: new Float64Array(), color: [], radius: new Float32Array(), raw: [], bins, B,
      ext: { x0: meta.x0 ?? 0, x1: meta.x1 ?? 1, y0: meta.y0 ?? 0, y1: meta.y1 ?? 1 }, legend: meta.color, trend: meta.trend, n: meta.n, excluded: meta.excluded,
      maxCount: meta.max_count ?? Math.max(1, ...bins.map((b) => b.count)), meta,
    };
  }
  const keep = rows.filter((r) => {
    const x = Number(r.key), y = Number(r.value);
    return r.key !== null && r.value !== null && Number.isFinite(x) && Number.isFinite(y) && (!logX || x > 0) && (!logY || y > 0);
  });
  const n = keep.length;
  const px = new Float64Array(n), py = new Float64Array(n);
  keep.forEach((r, i) => {
    px[i] = logX ? Math.log10(Number(r.key)) : Number(r.key);
    py[i] = logY ? Math.log10(Number(r.value)) : Number(r.value);
  });
  const legend = meta?.color ?? (c.color ? legendOf(keep.map((r) => r.color ?? null)) : undefined);
  const col = colorOf(legend);
  const color = keep.map((r) => (legend ? col(r.color) : CATEGORY[0]));
  const sizes = keep.map((r) => Number(r.size));
  const s0 = meta?.size?.min ?? Math.min(...sizes.filter(Number.isFinite));
  const s1 = meta?.size?.max ?? Math.max(...sizes.filter(Number.isFinite));
  const radius = new Float32Array(n).map((_, i) => (c.size && Number.isFinite(sizes[i]) && s1 > s0 ? 2 + 7 * Math.sqrt((sizes[i] - s0) / (s1 - s0)) : n > 5000 ? 1.8 : 2.6));
  let ext: Dom;
  if (meta && meta.x0 !== null && meta.y0 !== null) ext = { x0: meta.x0, x1: meta.x1 ?? meta.x0, y0: meta.y0, y1: meta.y1 ?? meta.y0 };
  else {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, px[i]);
      x1 = Math.max(x1, px[i]);
      y0 = Math.min(y0, py[i]);
      y1 = Math.max(y1, py[i]);
    }
    ext = n ? { x0, x1, y0, y1 } : { x0: 0, x1: 1, y0: 0, y1: 1 };
  }
  return { mode: "points", logX, logY, px, py, color, radius, raw: keep, bins: [], B: 0, ext, legend, trend: meta ? meta.trend : fit(px, py), n: meta?.n ?? n,
           excluded: meta?.excluded ?? rows.length - n, maxCount: 0, meta };
}

const padded = (d: Dom): Dom => {
  const px = (d.x1 - d.x0 || Math.abs(d.x0) || 1) * 0.04, py = (d.y1 - d.y0 || Math.abs(d.y0) || 1) * 0.06;
  return { x0: d.x0 - px, x1: d.x1 + px, y0: d.y0 - py, y1: d.y1 + py };
};

function ticks(lo: number, hi: number, log: boolean): { v: number; label: string }[] {
  if (log && hi - lo >= 1.5) {
    const out = [];
    const step = Math.max(1, Math.ceil((hi - lo) / 6));
    for (let k = Math.ceil(lo); k <= hi; k += step) out.push({ v: k, label: short(10 ** k) });
    return out;
  }
  return niceTicks(lo, hi, 5).map((v) => ({ v, label: short(log ? 10 ** v : v) }));
}

const isRect = (s: unknown): s is Rect => !!s && typeof s === "object" && "x0" in (s as object);
const isColor = (s: unknown): s is { color: unknown } => !!s && typeof s === "object" && "color" in (s as object);

export function ScatterView({ rows, meta, config, selection, onSelection }: {
  rows: Record<string, unknown>[];
  meta?: ScatterMeta;
  config: BoardConfig;
  selection?: unknown[] | null;
  onSelection?: (s: unknown[] | null) => void;
}) {
  const m = useMemo(() => model(rows, meta, config), [rows, meta, config]);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  const [zoom, setZoom] = useState<Dom | null>(null);
  const [brush, setBrush] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string[] } | null>(null);
  // a new result shows its whole extent again
  const [seen, setSeen] = useState(m);
  if (seen !== m) {
    setSeen(m);
    setZoom(null);
  }
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const dom = zoom ?? padded(m.ext);
  const pw = w - M.l - M.r, ph = H - M.t - M.b;
  const sx = (v: number) => M.l + ((v - dom.x0) / (dom.x1 - dom.x0 || 1)) * pw;
  const sy = (v: number) => M.t + ph - ((v - dom.y0) / (dom.y1 - dom.y0 || 1)) * ph;
  const ix = (x: number) => dom.x0 + ((x - M.l) / pw) * (dom.x1 - dom.x0);
  const iy = (y: number) => dom.y0 + ((M.t + ph - y) / ph) * (dom.y1 - dom.y0);
  const toData = (v: number, log: boolean) => (log ? 10 ** v : v);
  const toPlot = (v: number, log: boolean) => (log ? Math.log10(v) : v);
  const sel = selection ?? [];
  const rects = sel.filter(isRect);
  const picked = new Set(sel.filter(isColor).map((s) => (s.color === null ? null : String(s.color))));

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    g.font = "10px sans-serif";
    // grid and axes
    g.strokeStyle = "rgba(148,163,184,0.15)";
    g.fillStyle = "rgba(148,163,184,0.9)";
    g.lineWidth = 1;
    for (const t of ticks(dom.x0, dom.x1, m.logX)) {
      const x = Math.round(sx(t.v)) + 0.5;
      g.beginPath();
      g.moveTo(x, M.t);
      g.lineTo(x, M.t + ph);
      g.stroke();
      g.textAlign = "center";
      g.fillText(t.label, x, H - 12);
    }
    for (const t of ticks(dom.y0, dom.y1, m.logY)) {
      const y = Math.round(sy(t.v)) + 0.5;
      g.beginPath();
      g.moveTo(M.l, y);
      g.lineTo(M.l + pw, y);
      g.stroke();
      g.textAlign = "right";
      g.fillText(t.label, M.l - 6, y + 3);
    }
    g.save();
    g.beginPath();
    g.rect(M.l, M.t, pw, ph);
    g.clip();
    let drawn = 0;
    if (m.mode === "bins") {
      const dx = (m.ext.x1 - m.ext.x0) / m.B || 1, dy = (m.ext.y1 - m.ext.y0) / m.B || 1;
      const lmax = Math.log(1 + m.maxCount);
      for (const b of m.bins) {
        const x0 = sx(m.ext.x0 + b.bx * dx), x1 = sx(m.ext.x0 + (b.bx + 1) * dx);
        const y0 = sy(m.ext.y0 + (b.by + 1) * dy), y1 = sy(m.ext.y0 + b.by * dy);
        g.fillStyle = scaleColor(Math.log(1 + b.count) / lmax, 0.9);
        g.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        drawn++;
      }
    } else {
      // categories in the legend's order, so the largest are under the smaller ones
      g.globalAlpha = m.n > 5000 ? 0.55 : 0.75;
      for (let i = 0; i < m.px.length; i++) {
        const x = sx(m.px[i]), y = sy(m.py[i]);
        if (x < M.l - 10 || x > M.l + pw + 10 || y < M.t - 10 || y > M.t + ph + 10) continue;
        g.fillStyle = m.color[i];
        g.beginPath();
        g.arc(x, y, m.radius[i], 0, Math.PI * 2);
        g.fill();
        drawn++;
      }
      g.globalAlpha = 1;
    }
    if (config.trend === "linear" && m.trend) {
      g.strokeStyle = "#f8fafc";
      g.lineWidth = 1.5;
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(sx(dom.x0), sy(m.trend.slope * dom.x0 + m.trend.intercept));
      g.lineTo(sx(dom.x1), sy(m.trend.slope * dom.x1 + m.trend.intercept));
      g.stroke();
      g.setLineDash([]);
    }
    for (const r of rects) {
      const lx = (v: number) => (m.logX ? (v > 0 ? toPlot(v, true) : dom.x0) : v);
      const ly = (v: number) => (m.logY ? (v > 0 ? toPlot(v, true) : dom.y0) : v);
      const x0 = sx(lx(Math.min(r.x0, r.x1))), x1 = sx(lx(Math.max(r.x0, r.x1))), y0 = sy(ly(Math.max(r.y0, r.y1))), y1 = sy(ly(Math.min(r.y0, r.y1)));
      g.fillStyle = "rgba(56,189,248,0.12)";
      g.strokeStyle = "#38bdf8";
      g.lineWidth = 1.5;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    g.restore();
    g.strokeStyle = "rgba(148,163,184,0.5)";
    g.strokeRect(M.l + 0.5, M.t + 0.5, pw, ph);
    cv.dataset.drawn = String(drawn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, w, dom.x0, dom.x1, dom.y0, dom.y1, rects.length, JSON.stringify(rects), config.trend]);

  // wheel zoom around the cursor (a native listener: React's wheel handler is passive)
  const domRef = useRef(dom);
  useEffect(() => {
    domRef.current = dom;
  });
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const d = domRef.current;
      const fx = (e.clientX - r.left - M.l) / pw, fy = (M.t + ph - (e.clientY - r.top)) / ph;
      const k = e.deltaY < 0 ? 0.8 : 1.25;
      const cx = d.x0 + fx * (d.x1 - d.x0), cy = d.y0 + fy * (d.y1 - d.y0);
      setZoom({ x0: cx - (cx - d.x0) * k, x1: cx + (d.x1 - cx) * k, y0: cy - (cy - d.y0) * k, y1: cy + (d.y1 - cy) * k });
    };
    cv.addEventListener("wheel", on, { passive: false });
    return () => cv.removeEventListener("wheel", on);
  }, [pw, ph]);

  const local = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };
  const hoverAt = (x: number, y: number) => {
    if (x < M.l || x > M.l + pw || y < M.t || y > M.t + ph) return setHover(null);
    const xl = (v: number) => fmt(toData(v, m.logX));
    if (m.mode === "bins") {
      const dx = (m.ext.x1 - m.ext.x0) / m.B || 1, dy = (m.ext.y1 - m.ext.y0) / m.B || 1;
      const bx = Math.min(m.B - 1, Math.floor((ix(x) - m.ext.x0) / dx)), by = Math.min(m.B - 1, Math.floor((iy(y) - m.ext.y0) / dy));
      const b = m.bins.find((q) => q.bx === bx && q.by === by);
      return setHover(b ? { x, y, text: [`${fmt(b.count)} points`, `${config.x}: ${xl(m.ext.x0 + bx * dx)} – ${xl(m.ext.x0 + (bx + 1) * dx)}`, `${config.y}: ${fmt(toData(m.ext.y0 + by * dy, m.logY))} – ${fmt(toData(m.ext.y0 + (by + 1) * dy, m.logY))}`] } : null);
    }
    let best = -1, bd = 64;
    for (let i = 0; i < m.px.length; i++) {
      const d = (sx(m.px[i]) - x) ** 2 + (sy(m.py[i]) - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return setHover(null);
    const r = m.raw[best];
    setHover({ x, y, text: [`${config.x}: ${fmt(r.key)}`, `${config.y}: ${fmt(r.value)}`, ...(config.color ? [`${config.color}: ${fmt(r.color)}`] : []), ...(config.size ? [`${config.size}: ${fmt(r.size)}`] : [])] });
  };

  const toggleColor = (v: string | null) => {
    if (!onSelection) return;
    const has = sel.some((s) => isColor(s) && (s.color === null ? null : String(s.color)) === v);
    const next = has ? sel.filter((s) => !(isColor(s) && (s.color === null ? null : String(s.color)) === v)) : [...sel, { color: v }];
    onSelection(next.length ? next : null);
  };

  if (!m.n && m.mode === "points") return <p className="text-xs text-muted">No numeric points{m.excluded ? ` (${fmt(m.excluded)} rows are not numeric${m.logX || m.logY ? " or not above 0 on a log axis" : ""})` : ""}.</p>;
  const lg = m.legend;
  return (
    <div className="space-y-1 text-[11px]">
      {sel.length > 0 && (
        <p className="text-ocean">
          Selected: {[rects.length ? `${rects.length} area${rects.length > 1 ? "s" : ""}` : "", ...[...picked].map((v) => v ?? "(empty)")].filter(Boolean).join(", ")}
          {onSelection && <button type="button" onClick={() => onSelection(null)} className="ml-2 underline">clear</button>}
        </p>
      )}
      <div ref={box} className="relative w-full" style={{ height: H }}>
        <canvas
          ref={canvas}
          aria-label="Scatter plot"
          style={{ width: w, height: H, cursor: onSelection ? "crosshair" : "default", touchAction: "none" }}
          onPointerDown={(e) => {
            if (!onSelection) return;
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            const p = local(e);
            setBrush({ a: p, b: p });
          }}
          onPointerMove={(e) => {
            const p = local(e);
            if (brush) setBrush({ ...brush, b: p });
            else hoverAt(...p);
          }}
          onPointerLeave={() => setHover(null)}
          onPointerUp={(e) => {
            if (!brush || !onSelection) return;
            const p = local(e);
            setBrush(null);
            if (Math.abs(p[0] - brush.a[0]) < 4 || Math.abs(p[1] - brush.a[1]) < 4) return;
            const r: Rect = {
              x0: toData(ix(Math.min(brush.a[0], p[0])), m.logX), x1: toData(ix(Math.max(brush.a[0], p[0])), m.logX),
              y0: toData(iy(Math.max(brush.a[1], p[1])), m.logY), y1: toData(iy(Math.min(brush.a[1], p[1])), m.logY),
            };
            onSelection(e.ctrlKey || e.metaKey || e.shiftKey ? [...sel, r] : [r]);
          }}
          onDoubleClick={() => setZoom(null)}
        />
        {brush && (
          <div className="pointer-events-none absolute border border-ocean bg-ocean/10"
            style={{ left: Math.min(brush.a[0], brush.b[0]), top: Math.min(brush.a[1], brush.b[1]), width: Math.abs(brush.b[0] - brush.a[0]), height: Math.abs(brush.b[1] - brush.a[1]) }} />
        )}
        {hover && !brush && (
          <div className="pointer-events-none absolute z-10 rounded border border-line bg-panel/95 px-2 py-1 text-[11px] shadow" style={{ left: Math.min(hover.x + 12, w - 190), top: Math.max(0, hover.y - 10) }}>
            {hover.text.map((t, i) => <div key={i} className={i ? "text-muted" : ""}>{t}</div>)}
          </div>
        )}
        {zoom && <button type="button" onClick={() => setZoom(null)} className="absolute right-3 top-2 rounded border border-line bg-panel/90 px-2 py-0.5 text-[11px]">Reset zoom</button>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
        <span>{config.x}{m.logX ? " (log)" : ""} × {config.y}{m.logY ? " (log)" : ""}</span>
        {m.mode === "bins" ? (
          <span title="Above the point limit the board shows how many points fall in each cell">
            Density of {fmt(m.n)} points in {m.B} × {m.B} cells (over the limit of {fmt(m.meta?.limit ?? 0)} points)
            <span className="ml-1 inline-block h-2 w-16 align-middle" style={{ background: SCALE_CSS }} /> 1 – {fmt(m.maxCount)}
          </span>
        ) : (
          <span>{fmt(m.n)} points</span>
        )}
        {m.excluded > 0 && <span>{fmt(m.excluded)} rows not plotted (not numeric{m.logX || m.logY ? ", or not above 0 on a log axis" : ""})</span>}
        {config.trend === "linear" && m.trend && (
          <span title="Least squares on the plotted values">
            Trend: {m.logY ? "log y" : "y"} = {short(m.trend.slope)} · {m.logX ? "log x" : "x"} {m.trend.intercept < 0 ? "−" : "+"} {short(Math.abs(m.trend.intercept))}
            {m.trend.r2 !== null && <> (R² {m.trend.r2.toFixed(3)})</>}
          </span>
        )}
        {config.size && m.mode === "points" && <span>size: {config.size}</span>}
      </div>
      {lg?.kind === "category" && m.mode === "points" && (
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          <span className="text-muted">{config.color}:</span>
          {lg.values.map((v, i) => (
            <button key={String(v)} type="button" disabled={!onSelection} onClick={() => toggleColor(v === null ? null : String(v))}
              className={`flex items-center gap-1 rounded px-1 ${picked.has(v === null ? null : String(v)) ? "bg-ocean/20 text-white" : "hover:text-white"}`} title={`${fmt(lg.counts[i])} rows`}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: CATEGORY[i % CATEGORY.length] }} />{v ?? "(empty)"}
            </button>
          ))}
          {lg.distinct > lg.values.length && <span className="flex items-center gap-1 text-muted"><span className="h-2.5 w-2.5 rounded-full" style={{ background: OTHER }} />Other ({lg.distinct - lg.values.length})</span>}
        </div>
      )}
      {lg?.kind === "scale" && m.mode === "points" && (
        <div className="flex items-center gap-2 text-muted">
          {config.color}: {fmt(lg.min)} <span className="inline-block h-2 w-24" style={{ background: SCALE_CSS }} /> {fmt(lg.max)}
        </div>
      )}
      {m.mode === "bins" && config.color && <p className="text-muted">Colors by {config.color} show when the points are drawn one by one (raise the point limit or filter the rows).</p>}
    </div>
  );
}
