"use client";

/** Quiver time series single cards (api/quiver_cards.py): time series numeric aggregation (with the time-weighted
 * average and the integral), value / enum value at time, latest enum value, unit, start / end date, backing object,
 * regression coefficients, shift date/time, time series distribution and scatter plot / heat grid — their settings
 * and what they show. Their input is a time series card of the analysis' logic (refs of kind "series"). */
import { useId } from "react";
import {
  BOUNDS_INTERPOLATIONS,
  BUCKET_VALUES,
  DATE_UNITS,
  INTEGRATION_METHODS,
  RANGE_CARD_KINDS,
  REGRESSION_FITS,
  SERIES_CARD_AGGREGATIONS,
  SERIES_CARD_OPS,
  SERIES_INTERPOLATIONS,
  TIME_UNITS,
  type CardRange,
  type RegressionCard,
  type ScatterFit,
  type SeriesAggCard,
  type SeriesDistributionCard,
  type SeriesOpCard,
  type SeriesScatterCard,
  type SeriesSingleCard,
  type ShiftDatetimeCard,
  type TableResult,
} from "@/lib/quiverTables";

const field = "rounded border border-line-2 bg-panel px-1.5 py-1 text-[11px] text-soft outline-none focus:border-blue-500";
type Ref = { id: string; title: string; kind: string };
/** An input that is a card's value, a parameter or typed (SingleCards' Operand, with the editor's cards and parameters). */
export type OperandField = (value: string, onChange: (v: string) => void, placeholder: string, label: string) => React.ReactNode;

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-muted">{text}</span>
      {children}
    </label>
  );
}

/** A time series card of the analysis (and, for regression coefficients, a time series scatter plot card). */
function SeriesSelect({ value, refs, onChange, label = "Time series", scatter = false }: { value: string; refs: Ref[]; onChange: (v: string) => void; label?: string; scatter?: boolean }) {
  const series = refs.filter((x) => x.kind === "series");
  const plots = scatter ? refs.filter((x) => x.kind === "series_scatter") : [];
  const known = [...series, ...plots].some((x) => x.id === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-full`} aria-label={label}>
      <option value="">{series.length || plots.length ? `${label}…` : "Add a time series first (Time Series, above)"}</option>
      {value && !known && <option value={value}>${value}</option>}
      {scatter ? (
        <>
          {series.length > 0 && <optgroup label="Time series (against time)">{series.map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}</optgroup>}
          {plots.length > 0 && <optgroup label="Time series scatter plots (y against x)">{plots.map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}</optgroup>}
        </>
      ) : series.map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}
    </select>
  );
}

const rangeMode = (v: CardRange | undefined): string =>
  v === undefined || v === "" || v === "analysis" ? "analysis" : v === "full" ? "full" : typeof v === "string" ? v : "last" in v ? "last" : "fixed";

/** The range a time series card reads: the analysis' time range, the whole series, a fixed or a relative range, a range
 * card or a date / time range parameter. */
export function RangeSelect({ value, refs, params, onChange, fullLabel = "The whole series" }: { value: CardRange | undefined; refs: Ref[]; params: string[]; onChange: (v: CardRange | undefined) => void; fullLabel?: string }) {
  const mode = rangeMode(value);
  const ranges = refs.filter((x) => (RANGE_CARD_KINDS as readonly string[]).includes(x.kind));
  const known = ["analysis", "full", "fixed", "last", ...ranges.map((x) => `$${x.id}`), ...params.map((p) => `$${p}`)];
  const fixed = typeof value === "object" && !("last" in value) ? value : null;
  const pick = (m: string) => onChange(m === "analysis" ? undefined : m === "full" ? "full" : m === "fixed" ? { start: "", end: "" } : m === "last" ? { last: "7d" } : (m as CardRange));
  return (
    <Label text="Time range">
      <select value={mode} onChange={(e) => pick(e.target.value)} className={`${field} w-full`} aria-label="Time range">
        <option value="analysis">The analysis&apos; time range</option>
        <option value="full">{fullLabel}</option>
        <option value="fixed">A fixed range…</option>
        <option value="last">The last … (relative to now)</option>
        {!known.includes(mode) && <option value={mode}>{mode}</option>}
        {ranges.length > 0 && <optgroup label="Range cards">{ranges.map((x) => <option key={x.id} value={`$${x.id}`}>${x.id} · {x.title}</option>)}</optgroup>}
        {params.length > 0 && <optgroup label="Parameters (date / time range)">{params.map((p) => <option key={p} value={`$${p}`}>${p}</option>)}</optgroup>}
      </select>
      {fixed && (
        <div className="mt-1 flex gap-1">
          {(["start", "end"] as const).map((k) => (
            <input key={k} type="datetime-local" value={String(fixed[k] ?? "").slice(0, 16)} onChange={(e) => onChange({ ...fixed, [k]: e.target.value })} className={`${field} min-w-0 flex-1`} aria-label={`Range ${k} (UTC)`} title={`${k === "start" ? "Start" : "End"} (UTC; empty: open)`} />
          ))}
        </div>
      )}
      {typeof value === "object" && "last" in value && (
        <input value={value.last} onChange={(e) => onChange({ last: e.target.value })} placeholder="7d" spellCheck={false} className={`${field} mt-1 w-24 font-mono`} aria-label="Relative range" title="A duration: 30m, 12h, 7d, 4w" />
      )}
    </Label>
  );
}

/** A card still titled after its operation follows the operation when it changes. */
function retitle(title: string, ops: readonly (readonly [string, string])[], from: string, to: string): { title?: string } {
  const label = (k: string) => ops.find((o) => o[0] === k)?.[1];
  return title === label(from) && label(to) ? { title: label(to) } : {};
}

function NumberInput({ value, min, max, fallback, label, onChange }: { value: number | undefined; min: number; max: number; fallback: number; label: string; onChange: (v: number) => void }) {
  return (
    <input type="number" min={min} max={max} value={value ?? fallback} onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value)) || fallback)))} className={`${field} w-20`} aria-label={label} />
  );
}

/** Fit and degree of a regression (a scatter plot may have none). */
function FitFields({ fit, degree, none, onChange }: { fit: string; degree: number | undefined; none?: boolean; onChange: (p: { fit?: string; degree?: number }) => void }) {
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Label text={none ? "Regression line" : "Fit"}>
          <select value={fit} onChange={(e) => onChange({ fit: e.target.value })} className={`${field} w-full`} aria-label="Fit">
            {none && <option value="">None</option>}
            {REGRESSION_FITS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Label>
      </div>
      {fit === "polynomial" && (
        <Label text="Degree">
          <input type="number" min={0} max={13} value={degree ?? 2} onChange={(e) => onChange({ degree: Math.max(0, Math.min(13, Math.round(Number(e.target.value)) || 0)) })} className={`${field} w-16`} aria-label="Degree" />
        </Label>
      )}
    </div>
  );
}

/** The settings of a time series single card. */
export function SeriesCardForm({ card, refs, params, operand, onChange }: { card: SeriesSingleCard; refs: Ref[]; params: string[]; operand: OperandField; onChange: (p: Partial<SeriesSingleCard>) => void }) {
  const range = (value: CardRange | undefined) => <RangeSelect value={value} refs={refs} params={params} onChange={(v) => onChange({ range: v } as Partial<SeriesSingleCard>)} />;
  switch (card.kind) {
    case "series_agg": {
      const c: SeriesAggCard = card;
      const weighted = c.aggregation === "time_weighted_average" || c.aggregation === "integral";
      return (
        <>
          <SeriesSelect value={c.source.card} refs={refs} onChange={(v) => onChange({ source: { card: v } })} />
          <Label text="Aggregation">
            <select value={c.aggregation} onChange={(e) => onChange({ aggregation: e.target.value as SeriesAggCard["aggregation"] })} className={`${field} w-full`} aria-label="Aggregation">
              {SERIES_CARD_AGGREGATIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          {c.aggregation === "percentile" && (
            <Label text="Percentile (0–100)">
              <input type="number" min={0} max={100} value={c.percentile ?? 50} onChange={(e) => onChange({ percentile: Number(e.target.value) })} className={`${field} w-24`} aria-label="Percentile" />
            </Label>
          )}
          {weighted && (
            <>
              <Label text="Integration method">
                <select value={c.method ?? "linear"} onChange={(e) => onChange({ method: e.target.value as SeriesAggCard["method"] })} className={`${field} w-full`} aria-label="Integration method">
                  {INTEGRATION_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Label>
              <Label text="Bounds interpolation (the curve at the range's ends)">
                <select value={c.bounds ?? "none"} onChange={(e) => onChange({ bounds: e.target.value as SeriesAggCard["bounds"] })} className={`${field} w-full`} aria-label="Bounds interpolation">
                  {BOUNDS_INTERPOLATIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Label>
              {c.aggregation === "integral" && (
                <Label text="Area per">
                  <select value={c.time_unit ?? "s"} onChange={(e) => onChange({ time_unit: e.target.value as SeriesAggCard["time_unit"] })} className={`${field} w-full`} aria-label="Integral time unit">
                    {TIME_UNITS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Label>
              )}
            </>
          )}
          {range(c.range)}
        </>
      );
    }
    case "series_op": {
      const c: SeriesOpCard = card;
      const at = c.op === "value_at" || c.op === "enum_value_at";
      return (
        <>
          <Label text="Operation">
            <select value={c.op} onChange={(e) => onChange({ op: e.target.value as SeriesOpCard["op"], ...retitle(c.title, SERIES_CARD_OPS, c.op, e.target.value) })} className={`${field} w-full`} aria-label="Operation">
              {SERIES_CARD_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          <SeriesSelect value={c.source.card} refs={refs} onChange={(v) => onChange({ source: { card: v } })} />
          {at && (
            <>
              <Label text="Time">{operand(c.at ?? "", (v) => onChange({ at: v }), "2026-08-15T12:00:00Z", "Time")}</Label>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Label text="Between points">
                    <select value={c.interpolation ?? ""} onChange={(e) => onChange({ interpolation: e.target.value as SeriesOpCard["interpolation"] })} className={`${field} w-full`} aria-label="Interpolation">
                      <option value="">The series&apos; own</option>
                      {SERIES_INTERPOLATIONS.filter((k) => c.op !== "enum_value_at" || k !== "LINEAR").map((k) => <option key={k} value={k}>{k.charAt(0) + k.slice(1).toLowerCase()}</option>)}
                    </select>
                  </Label>
                </div>
                <div className="min-w-0 flex-1">
                  <Label text="Before / after the series">
                    <select value={c.external ?? ""} onChange={(e) => onChange({ external: e.target.value as SeriesOpCard["external"] })} className={`${field} w-full`} aria-label="Interpolation before and after the series">
                      <option value="">The series&apos; own</option>
                      <option value="NEAREST">Nearest point</option>
                      <option value="NONE">None</option>
                    </select>
                  </Label>
                </div>
              </div>
            </>
          )}
          {!at && c.op !== "backing_object" && range(c.range)}
        </>
      );
    }
    case "regression": {
      const c: RegressionCard = card;
      const fromScatter = refs.find((x) => x.id === c.source.card)?.kind === "series_scatter";
      return (
        <>
          <SeriesSelect value={c.source.card} refs={refs} scatter label="Time series or scatter plot" onChange={(v) => onChange({ source: { card: v } })} />
          <FitFields fit={c.fit} degree={c.degree} onChange={(p) => onChange(p as Partial<RegressionCard>)} />
          {!fromScatter && (
            <>
              <Label text="x: the time since the first point, in">
                <select value={c.x_unit ?? "d"} onChange={(e) => onChange({ x_unit: e.target.value as RegressionCard["x_unit"] })} className={`${field} w-full`} aria-label="Time unit of x">
                  {TIME_UNITS.map(([k, l]) => <option key={k} value={k}>{l}s</option>)}
                </select>
              </Label>
              {range(c.range)}
            </>
          )}
        </>
      );
    }
    case "shift_datetime": {
      const c: ShiftDatetimeCard = card;
      return (
        <>
          <Label text="Date (empty: now)">{operand(c.input ?? "", (v) => onChange({ input: v || undefined }), "now", "Date")}</Label>
          <Label text="Shift by (negative: earlier)">{operand(c.amount, (v) => onChange({ amount: v }), "-7", "Amount")}</Label>
          <Label text="Unit">
            <select value={c.unit} onChange={(e) => onChange({ unit: e.target.value as ShiftDatetimeCard["unit"] })} className={`${field} w-full`} aria-label="Unit">
              {DATE_UNITS.map((u) => <option key={u} value={u}>{u}s</option>)}
            </select>
          </Label>
        </>
      );
    }
    case "series_distribution": {
      const c: SeriesDistributionCard = card;
      return (
        <>
          <SeriesSelect value={c.source.card} refs={refs} onChange={(v) => onChange({ source: { card: v } })} />
          <Label text="Bins (1–200; an enum series: one per value)"><NumberInput value={c.bins} min={1} max={200} fallback={20} label="Bins" onChange={(v) => onChange({ bins: v })} /></Label>
          {range(c.range)}
        </>
      );
    }
    case "series_scatter": {
      const c: SeriesScatterCard = card;
      return (
        <>
          <Label text="X"><SeriesSelect value={c.x.card} refs={refs} label="X time series" onChange={(v) => onChange({ x: { card: v } })} /></Label>
          <Label text="Y"><SeriesSelect value={c.y.card} refs={refs} label="Y time series" onChange={(v) => onChange({ y: { card: v } })} /></Label>
          <Label text="Shown as">
            <select value={c.view ?? "scatter"} onChange={(e) => onChange({ view: e.target.value as SeriesScatterCard["view"], ...(c.title === "Time series scatter plot" && e.target.value === "heat_grid" ? { title: "Time series heat grid" } : c.title === "Time series heat grid" && e.target.value === "scatter" ? { title: "Time series scatter plot" } : {}) })} className={`${field} w-full`} aria-label="View">
              <option value="scatter">Scatter plot (a point per time bucket)</option>
              <option value="heat_grid">Heat grid (the density of the points)</option>
            </select>
          </Label>
          <div className="flex gap-2">
            <Label text="Time buckets"><NumberInput value={c.buckets} min={1} max={5000} fallback={1000} label="Time buckets" onChange={(v) => onChange({ buckets: v })} /></Label>
            <div className="min-w-0 flex-1">
              <Label text="Bucket value">
                <select value={c.bucket_value ?? "mean"} onChange={(e) => onChange({ bucket_value: e.target.value as SeriesScatterCard["bucket_value"] })} className={`${field} w-full`} aria-label="Bucket value">
                  {BUCKET_VALUES.map((k) => <option key={k} value={k}>{k === "mean" ? "average" : k}</option>)}
                </select>
              </Label>
            </div>
            {c.view === "heat_grid" && <Label text="Grid"><NumberInput value={c.grid} min={2} max={100} fallback={20} label="Grid cells per axis" onChange={(v) => onChange({ grid: v })} /></Label>}
          </div>
          <FitFields fit={c.fit ?? ""} degree={c.degree} none onChange={(p) => onChange(p as Partial<SeriesScatterCard>)} />
          {range(c.range)}
        </>
      );
    }
  }
}

const num = (v: number, digits = 4) => v.toLocaleString(undefined, { maximumFractionDigits: digits, notation: Math.abs(v) >= 1e9 ? "compact" : "standard" });
const day = (s: string | null | undefined) => (s ? (/T00:00:00(\.000)?Z$/.test(s) ? s.slice(0, 10) : s.replace("T", " ").replace(/(:00)?(\.000)?Z$/, "")) : "…");
const duration = (ms: number) => (ms >= 86_400_000 ? `${num(ms / 86_400_000, 2)} d` : ms >= 3_600_000 ? `${num(ms / 3_600_000, 2)} h` : ms >= 60_000 ? `${num(ms / 60_000, 2)} min` : `${num(ms / 1000, 2)} s`);

/** What a time series value card read, under its value: the series, its points and range; the time and interpolation
 * of a value at time; a regression's equation and R²; a backing object's title and type. */
export function SeriesNote({ card, r }: { card: SeriesSingleCard; r?: TableResult }) {
  if (!r || r.error) return null;
  const parts: string[] = [];
  if (card.kind === "regression") {
    return (
      <div className="space-y-0.5 text-[10px] text-muted">
        {r.equation && <div className="break-all font-mono text-[11px] text-soft">{r.equation}</div>}
        <div>
          {typeof r.r_squared === "number" ? `R² ${r.r_squared.toFixed(4)}` : "R² —"} · {(r.n ?? 0).toLocaleString()} points
          {r.input === "scatter" ? ` · y: ${r.y_label ?? ""}, x: ${r.x_label ?? ""}` : r.origin ? ` · x: ${TIME_UNITS.find((u) => u[0] === r.x_unit)?.[1] ?? r.x_unit}s since ${day(r.origin)}` : ""}
        </div>
      </div>
    );
  }
  if (card.kind === "shift_datetime") return r.date ? <div className="text-[10px] text-muted">from {day(r.date)}</div> : null;
  if (card.kind === "series_op" && card.op === "backing_object") {
    return <div className="text-[10px] text-muted">{r.label && r.label !== r.value ? `${r.label} · ` : ""}{r.object_type ?? ""}</div>;
  }
  if (r.label) parts.push(r.label);
  if (r.at) parts.push(`at ${day(r.at)}${r.exact === undefined ? "" : r.exact ? " (a point)" : ` (${(r.interpolation ?? "").toLowerCase()} interpolation)`}`);
  else if (r.points !== undefined) parts.push(`${r.points.toLocaleString()} point${r.points === 1 ? "" : "s"}`);
  if (r.range && !r.at) parts.push(r.range[0] || r.range[1] ? `${day(r.range[0])} → ${day(r.range[1])}` : "the whole series");
  if (r.covered_ms !== undefined) parts.push(`area over ${duration(r.covered_ms)}`);
  return parts.length ? <div className="text-[10px] text-muted">{parts.join(" · ")}</div> : null;
}

/** Time series distribution: a bar per bin (an enum series: per value). */
export function DistributionView({ r }: { r?: TableResult }) {
  if (!r) return <p className="py-6 text-center text-xs text-muted">Running…</p>;
  if (r.error) return <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{r.error}</p>;
  const note = `${r.label ?? ""}${r.label ? " · " : ""}${(r.points ?? 0).toLocaleString()} points${r.range && (r.range[0] || r.range[1]) ? ` · ${day(r.range[0])} → ${day(r.range[1])}` : ""}`;
  if (!r.data?.length) return <p className="py-6 text-center text-xs text-muted">No points in the range.</p>;
  if (r.categorical) {
    const rows = r.data as { value: string; count: number }[];
    const max = Math.max(1, ...rows.map((d) => d.count));
    return (
      <div className="space-y-1.5 text-[10px]" role="img" aria-label={`Distribution of ${rows.length} values`}>
        {rows.map((d) => (
          <div key={d.value} className="grid grid-cols-[minmax(5rem,1fr)_3fr_3rem] items-center gap-2">
            <span className="truncate text-soft" title={d.value}>{d.value}</span>
            <span className="h-2 overflow-hidden rounded bg-panel-2"><span className="block h-full rounded" style={{ width: `${Math.max(1, (d.count / max) * 100)}%`, background: "#2a78d6" }} /></span>
            <span className="text-right tabular-nums text-muted">{d.count.toLocaleString()}</span>
          </div>
        ))}
        <div className="text-muted">{note}{r.truncated ? ` · the ${rows.length} most frequent of ${(r.total ?? rows.length).toLocaleString()} values` : ""}</div>
      </div>
    );
  }
  const data = r.data as { start: number; end: number; count: number }[];
  const W = 640;
  const H = 220;
  const L = 44;
  const B = 30;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = (W - L) / data.length;
  const unit = r.value_unit ? ` ${r.value_unit}` : "";
  return (
    <div className="space-y-1 text-[10px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-muted" role="img" aria-label={`Distribution: ${data.length} bins from ${num(data[0].start)} to ${num(data[data.length - 1].end)}`}>
        <line x1={L} y1={H - B} x2={W} y2={H - B} stroke="currentColor" strokeOpacity="0.4" />
        <text x={L - 4} y={12} textAnchor="end" fill="currentColor" fontSize="9">{max.toLocaleString()}</text>
        <text x={L - 4} y={H - B + 3} textAnchor="end" fill="currentColor" fontSize="9">0</text>
        {data.map((d, i) => {
          const h = (d.count / max) * (H - B - 8);
          return (
            <rect key={i} x={L + i * step + 0.5} y={H - B - h} width={Math.max(1, step - 1)} height={h} rx="1" fill="#2a78d6" fillOpacity="0.9">
              <title>{`${num(d.start)} – ${num(d.end)}${unit}: ${d.count.toLocaleString()} point${d.count === 1 ? "" : "s"}`}</title>
            </rect>
          );
        })}
        <text x={L} y={H - B + 14} textAnchor="start" fill="currentColor" fontSize="9">{num(data[0].start)}</text>
        {data.length > 3 && <text x={L + (W - L) / 2} y={H - B + 14} textAnchor="middle" fill="currentColor" fontSize="9">{num((data[0].start + data[data.length - 1].end) / 2)}</text>}
        <text x={W} y={H - B + 14} textAnchor="end" fill="currentColor" fontSize="9">{num(data[data.length - 1].end)}{unit}</text>
      </svg>
      <div className="text-muted">{note}</div>
    </div>
  );
}

const fitOf = (r: TableResult): ScatterFit | null => (r.fit && typeof r.fit === "object" ? r.fit : null);

/** Time series scatter plot (a point per time bucket) or heat grid (cells shaded by how many points they hold), with the
 * regression line when the card has a fit. */
export function ScatterView({ r }: { r?: TableResult }) {
  const clip = useId();
  if (!r) return <p className="py-6 text-center text-xs text-muted">Running…</p>;
  if (r.error) return <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{r.error}</p>;
  const fit = fitOf(r);
  if (!r.data?.length || !r.extent) return <p className="py-6 text-center text-xs text-muted">No points: the two series share no time in the range.</p>;
  const W = 640;
  const H = 300;
  const L = 60;
  const B = 36;
  const T = 8;
  const [x0, x1] = r.extent.x;
  const [y0, y1] = r.extent.y;
  // the line may leave the points' y extent: the plot keeps to the points
  const sx = (v: number) => (x1 === x0 ? (L + W) / 2 : L + ((v - x0) / (x1 - x0)) * (W - L - 8));
  const sy = (v: number) => (y1 === y0 ? (H - B + T) / 2 : H - B - ((v - y0) / (y1 - y0)) * (H - B - T));
  const xl = `${r.x_label ?? "x"}${r.x_unit ? ` (${r.x_unit})` : ""}`;
  const yl = `${r.y_label ?? "y"}${r.y_unit ? ` (${r.y_unit})` : ""}`;
  const heat = r.view === "heat_grid";
  const cells = heat ? (r.data as { x0: number; x1: number; y0: number; y1: number; count: number }[]) : [];
  const pts = heat ? [] : (r.data as { t: string; x: number; y: number }[]);
  const most = Math.max(1, ...cells.map((d) => d.count));
  const line = (fit?.line ?? []).filter(([, y]) => y >= y0 - (y1 - y0) && y <= y1 + (y1 - y0));
  return (
    <div className="space-y-1 text-[10px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full max-w-3xl text-muted" role="img" aria-label={`${heat ? "Heat grid" : "Scatter plot"} of ${yl} against ${xl}: ${(r.points ?? 0).toLocaleString()} points`}>
        <clipPath id={clip}><rect x={L} y={0} width={W - L} height={H - B} /></clipPath>
        <line x1={L} y1={H - B} x2={W} y2={H - B} stroke="currentColor" strokeOpacity="0.4" />
        <line x1={L} y1={0} x2={L} y2={H - B} stroke="currentColor" strokeOpacity="0.4" />
        <text x={L - 4} y={sy(y1) + 6} textAnchor="end" fill="currentColor" fontSize="9">{num(y1, 2)}</text>
        <text x={L - 4} y={sy(y0)} textAnchor="end" fill="currentColor" fontSize="9">{num(y0, 2)}</text>
        <text x={sx(x0)} y={H - B + 12} textAnchor="start" fill="currentColor" fontSize="9">{num(x0, 2)}</text>
        <text x={sx(x1)} y={H - B + 12} textAnchor="end" fill="currentColor" fontSize="9">{num(x1, 2)}</text>
        <text x={(L + W) / 2} y={H - 6} textAnchor="middle" fill="currentColor" fontSize="9">{xl.length > 70 ? `${xl.slice(0, 69)}…` : xl}</text>
        <text x={10} y={(H - B) / 2} textAnchor="middle" fill="currentColor" fontSize="9" transform={`rotate(-90 10 ${(H - B) / 2})`}>{yl.length > 44 ? `${yl.slice(0, 43)}…` : yl}</text>
        <g clipPath={`url(#${clip})`}>
          {cells.map((d, i) => (
            <rect key={i} x={sx(d.x0)} y={sy(d.y1)} width={Math.max(1, sx(d.x1) - sx(d.x0))} height={Math.max(1, sy(d.y0) - sy(d.y1))} fill="#2a78d6" fillOpacity={0.15 + 0.8 * (d.count / most)}>
              <title>{`${xl}: ${num(d.x0)} – ${num(d.x1)}, ${yl}: ${num(d.y0)} – ${num(d.y1)}: ${d.count.toLocaleString()} point${d.count === 1 ? "" : "s"}`}</title>
            </rect>
          ))}
          {pts.map((d, i) => (
            <circle key={i} cx={sx(d.x)} cy={sy(d.y)} r="2.6" fill="#2a78d6" fillOpacity="0.75">
              <title>{`${day(d.t)}: ${xl} ${num(d.x)}, ${yl} ${num(d.y)}`}</title>
            </circle>
          ))}
          {line.length > 1 && <polyline points={line.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ")} fill="none" stroke="#e34948" strokeWidth="1.6" />}
        </g>
      </svg>
      <div className="text-muted">
        {(r.points ?? 0).toLocaleString()} point{r.points === 1 ? "" : "s"}{r.joined !== undefined && r.joined !== r.points ? ` from ${r.joined.toLocaleString()} joined timestamps` : ""}
        {heat ? ` · ${r.grid} × ${r.grid} cells, the darkest holds ${most.toLocaleString()}` : ""}
        {r.range && (r.range[0] || r.range[1]) ? ` · ${day(r.range[0])} → ${day(r.range[1])}` : ""}
      </div>
      {fit?.error && <div className="text-bad">No regression line: {fit.error}</div>}
      {fit?.equation && (
        <div className="text-muted">
          <span className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: "#e34948" }} />
          <span className="font-mono text-soft">{fit.equation}</span> · {typeof fit.r_squared === "number" ? `R² ${fit.r_squared.toFixed(4)}` : "R² —"}
        </div>
      )}
    </div>
  );
}

/** A new time series single card on the first time series card(s) of the analysis. */
export function newSeriesCard(kind: SeriesSingleCard["kind"], id: string, series: string[] = []): SeriesSingleCard {
  const first = series[0] ?? "";
  switch (kind) {
    case "series_agg": return { id, kind, title: "Time series numeric aggregation", source: { card: first }, aggregation: "mean" };
    case "series_op": return { id, kind, title: "Value at time", op: "value_at", source: { card: first }, at: "" };
    case "regression": return { id, kind, title: "Time series regression coefficients", source: { card: first }, fit: "linear", x_unit: "d" };
    case "shift_datetime": return { id, kind, title: "Shift date/time", amount: "-7", unit: "day" };
    case "series_distribution": return { id, kind, title: "Time series distribution", source: { card: first }, bins: 20 };
    case "series_scatter": return { id, kind, title: "Time series scatter plot", x: { card: first }, y: { card: series[1] ?? "" }, view: "scatter", fit: "linear" };
  }
}
