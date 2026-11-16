"use client";

import { useEffect, useRef, useState } from "react";
import { BoardEditor, BoardView, type Sources } from "@/components/contour/Boards";
import { Icon } from "@/components/Icon";
import { BOARD_LABEL, TRANSFORM_BOARDS, type Analysis as ContourAnalysis, type Board, type BoardType } from "@/lib/contour";
import { cellText, describeTransform, quiverTables, resolveVega, SERIES_AGGREGATIONS, SERIES_OPS, SERIES_TRANSFORM_DEFAULTS, SERIES_TRANSFORMS, seriesColumnName, sparklinePoints, type SeriesTransform, type SeriesTransformType, type ActionCard, type ChartCard, GROUPED_AGGREGATES, type GroupedPlotCard, type ChartKind, type CrossFilterCard, type QuiverTableCard, type SeriesColumn, type SeriesOp, type TableCard, type TableResult, type ValueCard, type VegaCard } from "@/lib/quiverTables";
import { isChartSingleKind, isObjectSetCardKind, isSingleCard, CARD_KIND_LABEL, SINGLE_CARD_KINDS, type Selection, type SingleCard } from "@/lib/quiverTables";
import { newSingleCard, SingleCardEditor, SingleCardView } from "@/components/quiver/SingleCards";
import { ActionForm } from "@/components/ontology/ActionForm";
import { alertDialog } from "@/lib/dialogs";
import { copyForNotepad } from "@/lib/notepadClip";
import { ontology, type ActionType, type ObjectType } from "@/lib/ontology";

const field = "rounded border border-line-2 bg-panel px-1.5 py-1 text-[11px] text-soft outline-none focus:border-blue-500";
const uid = () => Math.random().toString(36).slice(2, 8);
/** tsps: an object set card's time series properties (its object type's), for a transform table's time series columns;
 * source: a table card's input card */
type CardRef = { id: string; title: string; kind: string; tsps?: { api_name: string; display_name: string }[]; source?: string };

/** The object set card a table's rows come from, following input tables (api/quiver_tables.py _root_object_set). */
function rootObjectSet(refs: CardRef[], from?: string): CardRef | undefined {
  const seen = new Set<string>();
  let ref = refs.find((x) => x.id === from);
  while (ref && !seen.has(ref.id)) {
    if (ref.kind === "object_set") return ref;
    // a filter / status filter keeps its input's object type
    if (!["table", "cross_filter", "object_selector", "filter_object_set", "status_filter"].includes(ref.kind)) return undefined;
    seen.add(ref.id);
    const next: string | undefined = ref.source;
    ref = refs.find((x) => x.id === next);
  }
  return undefined;
}
const CHARTS: [ChartKind, string, BoardType][] = [
  ["bar", "Bar chart", "chart"],
  ["line", "Line chart", "chart"],
  ["pie", "Pie chart", "chart"],
  ["scatter", "Scatter plot", "chart"],
  ["histogram", "Histogram", "histogram"],
  ["distribution", "Distribution", "distribution"],
  ["time_series", "Time series (dates)", "time_series"],
  ["heatmap", "Heat grid", "heatmap"],
  ["pivot", "Pivot table", "pivot"],
];
const VEGA_TEMPLATE = (t: string) => `{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "data": { "values": $${t} },
  "mark": "bar",
  "encoding": {
    "x": { "field": $${t}.column1, "type": "nominal" },
    "y": { "field": $${t}.column2, "type": "quantitative" }
  }
}`;

/** The Contour analysis shape BoardEditor needs: parameters, and the cards a join / set math step can read. */
export function contourShim(refs: CardRef[], params: string[]): ContourAnalysis {
  return {
    title: "",
    parameters: params.map((name) => ({ name, type: "string" })),
    paths: refs.map((r) => ({ id: r.id, name: `${r.title} ($${r.id})`, source: { kind: "path", id: r.id }, boards: [] })),
    dashboard: { tabs: [] },
    saved: {},
  };
}

export type CrossSelect = (crossFilter: string, chart: string, key: unknown) => void;

function Header({ card, label, icon, onChange, onRemove, extra }: { card: QuiverTableCard; label: string; icon: "table" | "graph" | "gauge" | "palette" | "filter" | "play"; onChange: (p: Partial<QuiverTableCard>) => void; onRemove: () => void; extra?: React.ReactNode }) {
  return (
    <header className="flex items-center gap-2 border-b border-line px-3 py-2">
      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-500">${card.id}</span>
      <Icon name={icon} className="h-3.5 w-3.5 text-emerald-500" />
      <input value={card.title} onChange={(e) => onChange({ title: e.target.value })} className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-soft outline-none" />
      {extra}
      <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">{label}</span>
      <button type="button" onClick={onRemove} title="Delete card" className="rounded p-1 text-muted hover:bg-bad/10 hover:text-red-600"><Icon name="trash" className="h-3.5 w-3.5" /></button>
    </header>
  );
}

function SourceSelect({ value, refs, onChange, datasets }: { value: string; refs: CardRef[]; onChange: (v: string) => void; datasets?: Sources["datasets"] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-full`}>
      <option value="">Input…</option>
      <optgroup label="Cards">{refs.map((r) => <option key={r.id} value={`card:${r.id}`}>${r.id} · {r.title}</option>)}</optgroup>
      {datasets && <optgroup label="Datasets">{datasets.map((d) => <option key={d.id} value={`dataset:${d.id}`}>{d.name}</option>)}</optgroup>}
      {datasets && <option value="values:">Manual values</option>}
    </select>
  );
}

/** A time series cell of a transform table: the down-sampled points as a small line. */
export function Sparkline({ points, unit }: { points: [number, number][]; unit?: string | null }) {
  if (!points.length) return <span className="text-muted">—</span>;
  const W = 96;
  const H = 20;
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (t: number) => (t1 === t0 ? W / 2 : 1 + ((t - t0) / (t1 - t0)) * (W - 2));
  const y = (v: number) => (hi === lo ? H / 2 : H - 2 - ((v - lo) / (hi - lo)) * (H - 4));
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const last = points[points.length - 1];
  const u = unit ? ` ${unit}` : "";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Sparkline, last ${fmt(last[1])}${u}`} className="block text-ocean">
      <title>{`${new Date(t0).toISOString().slice(0, 16).replace("T", " ")} → ${new Date(t1).toISOString().slice(0, 16).replace("T", " ")} UTC · min ${fmt(lo)} · max ${fmt(hi)} · last ${fmt(last[1])}${u} · ${points.length} points`}</title>
      {points.length > 1 && <polyline points={points.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />}
      <circle cx={x(last[0])} cy={y(last[1])} r="1.6" fill="currentColor" />
    </svg>
  );
}

export function ResultTable({ r, max = 100 }: { r?: TableResult; max?: number }) {
  if (!r) return <p className="py-6 text-center text-xs text-muted">Running…</p>;
  if (r.error) return <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{r.error}</p>;
  const cols = r.columns ?? [];
  const series = r.series_columns ?? {};
  const cell = (c: string, v: unknown) => {
    if (v === null || v === undefined) return "—";
    const info = series[c];
    if (info?.kind === "sparkline") {
      const pts = sparklinePoints(v);
      if (pts) return <Sparkline points={pts} unit={info.unit} />;
    }
    if (info && info.kind !== "time" && typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    // arrays / structs (array properties stay arrays): "a, b"
    return typeof v === "object" ? cellText(v) : String(v);
  };
  return (
    // printed (a report / Notepad PDF): every row shown, not the scroll box's first screen
    <div className="max-h-72 overflow-auto print:max-h-none print:overflow-visible">
      <table className="w-full border-collapse text-left text-[10px]">
        <thead className="sticky top-0 bg-panel-2 text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap border-b border-line px-2 py-1" title={series[c] ? `Time series column: ${series[c].op} of ${series[c].property}${series[c].transforms?.length ? ` after ${series[c].transforms!.map(describeTransform).join(", then ")}` : ""}` : undefined}>
                {c}
                {series[c]?.unit && series[c].kind === "value" && <span className="ml-1 font-normal">({series[c].unit})</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(r.rows ?? []).slice(0, max).map((row, i) => (
            <tr key={i} className="hover:bg-ocean/10">{cols.map((c) => <td key={c} className="max-w-44 truncate border-b border-line px-2 py-1 text-soft">{cell(c, row[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <p className="py-1 text-center text-[10px] text-muted">
        {(r.total ?? 0).toLocaleString()} rows{(r.total ?? 0) > max ? ` · showing ${max}` : ""}
        {r.series && ` · ${r.series.reads.toLocaleString()} time series read`}
      </p>
      {r.series && r.series.failed > 0 && (
        <p className="pb-1 text-center text-[10px] text-amber-600" title={r.series.errors.join("\n")}>
          {r.series.failed.toLocaleString()} series could not be read (their cells are empty): {r.series.errors[0]}
        </p>
      )}
    </div>
  );
}

/** A time series column's transforms (rolling aggregate, periodic aggregate, …), applied in order before its operation. */
function TransformsEditor({ transforms, onChange }: { transforms: SeriesTransform[]; onChange: (t: SeriesTransform[]) => void }) {
  const set = (i: number, p: Partial<SeriesTransform>) => onChange(transforms.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const text = (i: number, key: "window" | "period" | "by" | "every", placeholder: string, label: string) => (
    <input value={transforms[i][key] ?? ""} onChange={(e) => set(i, { [key]: e.target.value })} placeholder={placeholder} className={`${field} w-16 font-mono`} aria-label={label} title={label} />
  );
  const num = (i: number, key: "min" | "max" | "alpha", label: string) => (
    <input type="number" value={transforms[i][key] ?? ""} onChange={(e) => set(i, { [key]: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder={key} className={`${field} w-16`} aria-label={label} title={label} />
  );
  const agg = (i: number) => (
    <select value={transforms[i].aggregation ?? SERIES_TRANSFORM_DEFAULTS[transforms[i].type].aggregation} onChange={(e) => set(i, { aggregation: e.target.value as SeriesTransform["aggregation"] })} className={field} aria-label="Aggregation">
      {SERIES_AGGREGATIONS.map((a) => <option key={a} value={a}>{a === "std" ? "std dev" : a}</option>)}
    </select>
  );
  const per = (i: number) => (
    <select value={transforms[i].unit ?? "s"} onChange={(e) => set(i, { unit: e.target.value })} className={field} aria-label="Per">
      {[["s", "per second"], ["m", "per minute"], ["h", "per hour"], ["d", "per day"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
  return (
    <div className="space-y-1">
      {transforms.map((t, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1 border-l-2 border-blue-500/40 pl-1.5">
          <select value={t.type} onChange={(e) => onChange(transforms.map((x, j) => (j === i ? { type: e.target.value as SeriesTransformType } : x)))} className={`${field} min-w-0`} aria-label="Transformation">
            {SERIES_TRANSFORMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {t.type === "rolling" && <>{agg(i)}{text(i, "window", "1h", "Window (ends at each point, inclusive): 7d, 1h, 15m")}</>}
          {t.type === "periodic" && <>{agg(i)}{text(i, "period", "1d", "Period: 1h, 1d, 1w, 1mo")}</>}
          {t.type === "cumulative" && agg(i)}
          {(t.type === "derivative" || t.type === "integral") && per(i)}
          {t.type === "shift" && text(i, "by", "0s", "Shift by: 1d, -12h")}
          {t.type === "sample" && text(i, "every", "1h", "Every: 1h, 15m")}
          {t.type === "filter" && <>{num(i, "min", "Keep values ≥")}{num(i, "max", "Keep values ≤")}</>}
          {t.type === "dsp" && (
            <>
              <select value={t.filter ?? "moving_average"} onChange={(e) => set(i, { filter: e.target.value })} className={field} aria-label="Filter">
                {[["moving_average", "Moving average"], ["ema", "Exponential"], ["lowpass", "Low-pass"], ["highpass", "High-pass"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {t.filter === "ema" ? num(i, "alpha", "Smoothing factor α (0–1); empty: a time constant from the window") : null}
              {text(i, "window", "1h", "Window / time constant")}
            </>
          )}
          <span className="sr-only">{describeTransform(t)}</span>
          <button type="button" onClick={() => onChange(transforms.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad" aria-label="Remove transformation"><Icon name="x" className="h-3 w-3" /></button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...transforms, { type: "rolling", window: "7d", aggregation: "mean" }])} className="text-[10px] text-blue-700 hover:underline" title="Transform the series before the operation, e.g. a 7-day rolling average">
        + Add transformation
      </button>
    </div>
  );
}

const rangeKind = (r: SeriesColumn["range"]) => (r === undefined || r === "analysis" ? "analysis" : r === "full" ? "full" : "last" in r ? "relative" : "fixed");

/** The time series columns of a transform table over an object set: a series of each row and an operation on it. */
function SeriesColumnsEditor({ card, tsps, onChange, fromTable }: { card: TableCard; tsps: { api_name: string; display_name: string }[]; onChange: (p: Partial<TableCard>) => void; fromTable?: boolean }) {
  const cols = card.series_columns ?? [];
  const set = (i: number, p: Partial<SeriesColumn>) => onChange({ series_columns: cols.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div className="space-y-1.5">
      <div className="font-medium uppercase tracking-wide text-muted">Time series columns</div>
      {cols.map((col, i) => {
        const sensor = col.property.startsWith("sensor:");
        const rk = rangeKind(col.range);
        const fixed = rk === "fixed" ? (col.range as { start?: string; end?: string }) : {};
        return (
          <div key={i} className="space-y-1 rounded border border-line p-1.5">
            <div className="flex items-center gap-1">
              <select value={sensor ? "sensor:" : col.property} onChange={(e) => set(i, { property: e.target.value })} className={`${field} min-w-0 flex-1`} aria-label="Time series">
                <option value="">Default time series</option>
                {tsps.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
                {!sensor && col.property && !tsps.some((p) => p.api_name === col.property) && <option value={col.property}>{col.property}</option>}
                <option value="sensor:">Linked sensor…</option>
              </select>
              <select value={col.op} onChange={(e) => set(i, { op: e.target.value as SeriesOp })} className={`${field} min-w-0 flex-1`} aria-label="Operation">
                {SERIES_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <button type="button" onClick={() => onChange({ series_columns: cols.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove time series column"><Icon name="x" className="h-3 w-3" /></button>
            </div>
            {sensor && <input value={col.property.slice(7)} onChange={(e) => set(i, { property: `sensor:${e.target.value}` })} placeholder="sensor name" className={`${field} w-full`} aria-label="Sensor name" />}
            <TransformsEditor transforms={col.transforms ?? []} onChange={(transforms) => set(i, { transforms: transforms.length ? transforms : undefined })} />
            <input value={col.name ?? ""} onChange={(e) => set(i, { name: e.target.value })} placeholder={`column name (${seriesColumnName({ ...col, name: "" })})`} className={`${field} w-full font-mono`} aria-label="Column name" />
            {col.op === "value_at" ? (
              <input value={col.at ?? ""} onChange={(e) => set(i, { at: e.target.value })} placeholder="time, e.g. 2026-08-15T12:00:00Z" className={`${field} w-full font-mono`} aria-label="Time" />
            ) : (
              <div className="flex flex-wrap items-center gap-1">
                <select
                  value={rk}
                  onChange={(e) => set(i, { range: e.target.value === "analysis" ? undefined : e.target.value === "full" ? "full" : e.target.value === "relative" ? { last: "30d" } : { start: "", end: "" } })}
                  className={`${field} min-w-0 flex-1`}
                  aria-label={col.op === "sparkline" ? "View range" : "Range"}
                >
                  <option value="analysis">Analysis time range</option>
                  <option value="full">Full extent of the series</option>
                  <option value="fixed">Fixed range</option>
                  <option value="relative">Relative range (to now)</option>
                </select>
                {rk === "relative" && <input value={(col.range as { last: string }).last} onChange={(e) => set(i, { range: { last: e.target.value } })} placeholder="7d, 12h, 2w" className={`${field} w-20 font-mono`} aria-label="Last" />}
                {col.op === "sparkline" && <input type="number" min={2} max={500} value={col.points ?? 60} onChange={(e) => set(i, { points: Number(e.target.value) || 60 })} className={`${field} w-16`} title="Points (the series is down-sampled to at most this many)" aria-label="Points" />}
                {rk === "fixed" && (
                  <>
                    <input value={fixed.start ?? ""} onChange={(e) => set(i, { range: { ...fixed, start: e.target.value } })} placeholder="start, e.g. 2026-08-01" className={`${field} min-w-0 flex-1 font-mono`} aria-label="Range start" />
                    <input value={fixed.end ?? ""} onChange={(e) => set(i, { range: { ...fixed, end: e.target.value } })} placeholder="end" className={`${field} min-w-0 flex-1 font-mono`} aria-label="Range end" />
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      <button type="button" onClick={() => onChange({ series_columns: [...cols, { property: tsps[0]?.api_name ?? "", op: cols.length ? "mean" : "sparkline" }] })} className="text-blue-700 hover:underline">+ Add time series column</button>
      {!tsps.length && <p className="text-[10px] text-muted">This object type has no time series property; a linked sensor can still be read by name.</p>}
      {cols.length > 0 && <p className="text-[10px] text-muted">Computed per row before the transformations (steps can filter, sort and chart them); one read per row and series, at most 2,000.{fromTable ? " The input table must keep its primary_key column." : ""}</p>}
    </div>
  );
}

function TableCardEditor({ card, r, refs, sources, params, aid, onChange }: { card: TableCard; r?: TableResult; refs: CardRef[]; sources: Sources; params: string[]; aid: string; onChange: (p: Partial<TableCard>) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const src = card.source;
  const srcValue = src.kind === "dataset" ? `dataset:${src.id}` : src.kind === "values" ? "values:" : `card:${src.card}`;
  const shim = contourShim(refs.filter((x) => x.id !== card.id && x.kind !== "series"), params);
  const setStep = (i: number, s: Partial<Board>) => onChange({ steps: card.steps.map((x, j) => (j === i ? { ...x, ...s } : x)) });
  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(15rem,22rem)_1fr]">
      <div className="space-y-2 text-[11px]">
        <SourceSelect
          value={srcValue}
          refs={refs.filter((x) => x.id !== card.id && x.kind !== "chart" && x.kind !== "value" && x.kind !== "vega" && (x.kind === "object_selector" || isObjectSetCardKind(x.kind) || !(SINGLE_CARD_KINDS as readonly string[]).includes(x.kind)))}
          datasets={sources.datasets}
          onChange={(v) => {
            const [kind, ...rest] = v.split(":");
            const id = rest.join(":");
            const ref = refs.find((x) => x.id === id);
            onChange({ source: kind === "dataset" ? { kind: "dataset", id } : kind === "values" ? { kind: "values", columns: ["column1", "column2"], rows: [["", ""]] } : { kind: ref?.kind === "object_set" ? "object_set" : ref?.kind === "series" ? "series" : "table", card: id } });
          }}
        />
        {src.kind === "values" && (
          <div className="space-y-1">
            <input value={src.columns.join(", ")} onChange={(e) => onChange({ source: { ...src, columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })} placeholder="columns, comma-separated" className={`${field} w-full`} />
            <textarea rows={4} value={src.rows.map((r) => r.join(", ")).join("\n")} onChange={(e) => onChange({ source: { ...src, rows: e.target.value.split("\n").filter((l) => l.trim()).map((l) => l.split(",").map((s) => { const t = s.trim(); return t !== "" && !Number.isNaN(Number(t)) ? Number(t) : t; })) } })} placeholder="one row per line, values comma-separated" className={`${field} w-full font-mono`} />
          </div>
        )}
        {(src.kind === "object_set" || src.kind === "table") && rootObjectSet(refs, src.card) && (
          <SeriesColumnsEditor card={card} tsps={rootObjectSet(refs, src.card)?.tsps ?? []} onChange={onChange} fromTable={src.kind === "table"} />
        )}
        <div className="font-medium uppercase tracking-wide text-muted">Transformations</div>
        {card.steps.map((s, i) => (
          <div key={s.id} className="rounded border border-line">
            <div className="flex items-center gap-1 px-2 py-1">
              <span className="text-muted">{i + 1}.</span>
              <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} className="flex-1 text-left font-medium">{s.title || BOARD_LABEL[s.type]}</button>
              {r?.step_columns && <span className="text-[10px] text-muted">{r.step_columns[i + 1]?.length ?? "?"} cols</span>}
              <button type="button" onClick={() => onChange({ steps: card.steps.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove step"><Icon name="x" className="h-3 w-3" /></button>
            </div>
            {open === s.id && (
              <div className="border-t border-line p-2">
                <BoardEditor b={s} cols={r?.step_columns?.[i] ?? r?.columns ?? []} a={shim} sources={{ datasets: sources.datasets, object_types: [] }} path={{ id: card.id, name: card.title, source: { kind: "path", id: "" }, boards: [] }} onChange={(c) => setStep(i, { config: c })} />
              </div>
            )}
          </div>
        ))}
        <select value="" onChange={(e) => { if (!e.target.value) return; const s: Board = { id: uid(), type: e.target.value as BoardType, config: {} }; onChange({ steps: [...card.steps, s] }); setOpen(s.id); }} className={`${field} w-full`}>
          <option value="">+ Add transformation…</option>
          {TRANSFORM_BOARDS.map((t) => <option key={t} value={t}>{t === "expression" ? "Derive column / group (expression)" : BOARD_LABEL[t]}</option>)}
        </select>
        <p className="text-[10px] text-muted">Expressions are SQL (DuckDB); parameter cards are $A, $B…; at most 50,000 rows.</p>
      </div>
      <div className="min-w-0 rounded border border-line bg-panel p-2">
        <div className="mb-1 flex justify-end"><a href={quiverTables.csvUrl(aid, card.id)} className="text-[10px] text-blue-700 hover:underline">Export CSV</a></div>
        <ResultTable r={r} />
      </div>
    </div>
  );
}

function ChartCardEditor({ card, r, refs, params, onChange, onCrossSelect }: { card: ChartCard; r?: TableResult; refs: CardRef[]; params: string[]; onChange: (p: Partial<ChartCard>) => void; onCrossSelect?: CrossSelect }) {
  const btype = CHARTS.find((c) => c[0] === card.chart)?.[2] ?? "chart";
  const board: Board = { id: card.id, type: btype, config: card.config, selection: r?.selection ?? null };
  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(15rem,20rem)_1fr]">
      <div className="space-y-2 text-[11px]">
        <SourceSelect value={card.source.card ? `card:${card.source.card}` : ""} refs={refs.filter((x) => x.id !== card.id && (["object_set", "table", "cross_filter", "object_selector"].includes(x.kind) || isObjectSetCardKind(x.kind)))} onChange={(v) => onChange({ source: { card: v.split(":")[1] ?? "" } })} />
        <select value={card.chart} onChange={(e) => onChange({ chart: e.target.value as ChartKind })} className={`${field} w-full`}>
          {CHARTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <BoardEditor b={board} cols={r?.input_columns ?? []} a={contourShim([], params)} sources={{ datasets: [], object_types: [] }} path={{ id: card.id, name: "", source: { kind: "path", id: "" }, boards: [] }} onChange={(c) => onChange({ config: c })} />
      </div>
      <div className="min-w-0 rounded border border-line bg-panel p-2">
        {r?.cross_filter && <p className="mb-1 text-[10px] text-muted">Subscribed to cross filter ${r.cross_filter}: click bars or slices to filter.</p>}
        {r?.error ? <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{r.error}</p> : <BoardView b={board} r={r ? { data: r.data, data_columns: r.data_columns } : undefined} onSelect={r?.cross_filter && onCrossSelect ? (k) => onCrossSelect(r.cross_filter!, card.id, k) : undefined} />}
      </div>
    </div>
  );
}

export function ValueDisplay({ r }: { r?: TableResult }) {
  if (!r) return <span className="text-xs text-muted">…</span>;
  if (r.error) return <span className="text-xs text-bad">{r.error}</span>;
  const v = r.value;
  return <span className="text-2xl font-semibold tabular-nums">{v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : cellText(v)}</span>;
}

/** A Vega or Vega-Lite plot; vega-embed loads on first use. */
export function VegaView({ spec, results }: { spec: string; results: Record<string, TableResult> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = JSON.stringify([spec, results]);
  useEffect(() => {
    let cancelled = false;
    let view: { finalize: () => void } | null = null;
    (async () => {
      try {
        const parsed = resolveVega(spec, results);
        const { default: embed } = await import("vega-embed");
        if (cancelled || !ref.current) return;
        const r = await embed(ref.current, parsed as never, { actions: false, renderer: "svg" });
        view = r.view;
        if (!cancelled) setErr(null);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      view?.finalize();
    };
    // key holds the spec and the data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div>
      {err && <p className="mb-1 rounded bg-bad/10 p-2 text-xs text-red-700">{err}</p>}
      <div ref={ref} className="overflow-auto rounded bg-white p-2" />
    </div>
  );
}

function VegaCardEditor({ card, results, refs, onChange }: { card: VegaCard; results: Record<string, TableResult>; refs: CardRef[]; onChange: (p: Partial<VegaCard>) => void }) {
  const tables = refs.filter((x) => x.kind === "table");
  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(15rem,24rem)_1fr]">
      <div className="space-y-2 text-[11px]">
        <label className="block">Transform tables used ($T for rows, $T.column for a column)
          <select multiple value={card.tables} onChange={(e) => onChange({ tables: [...e.target.selectedOptions].map((o) => o.value) })} className={`${field} h-16 w-full`}>
            {tables.map((t) => <option key={t.id} value={t.id}>${t.id} · {t.title}</option>)}
          </select>
        </label>
        <button type="button" disabled={!card.tables[0]} onClick={() => onChange({ spec: VEGA_TEMPLATE(card.tables[0]) })} className="text-blue-700 hover:underline disabled:opacity-40">Bar chart template</button>
        <textarea rows={14} value={card.spec} onChange={(e) => onChange({ spec: e.target.value })} spellCheck={false} className={`${field} w-full font-mono`} />
      </div>
      <div className="min-w-0 rounded border border-line bg-panel p-2"><VegaView spec={card.spec} results={results} /></div>
    </div>
  );
}

function CrossFilterEditor({ card, r, refs, onChange }: { card: CrossFilterCard; r?: TableResult; refs: (CardRef & { source?: string })[]; onChange: (p: Partial<CrossFilterCard>) => void }) {
  const charts = refs.filter((x) => x.kind === "chart" && x.source === card.id);
  const sel = Object.entries(card.selections ?? {}).filter(([, v]) => v?.length);
  return (
    <div className="grid gap-3 p-3 text-[11px] lg:grid-cols-[minmax(15rem,20rem)_1fr]">
      <div className="space-y-2">
        <SourceSelect value={card.source.card ? `card:${card.source.card}` : ""} refs={refs.filter((x) => x.id !== card.id && (["object_set", "table", "object_selector"].includes(x.kind) || isObjectSetCardKind(x.kind)))} onChange={(v) => onChange({ source: { card: v.split(":")[1] ?? "" } })} />
        <label className="block">Subscribed charts (charts reading from ${card.id})
          <select multiple value={card.subscribed} onChange={(e) => onChange({ subscribed: [...e.target.selectedOptions].map((o) => o.value) })} className={`${field} h-20 w-full`}>
            {charts.map((c) => <option key={c.id} value={c.id}>${c.id} · {c.title}</option>)}
          </select>
        </label>
        {!charts.length && <p className="text-[10px] text-muted">Add charts (bar, line, pie, scatter) whose input is ${card.id}, then subscribe them here.</p>}
        {sel.length > 0 && (
          <div className="space-y-0.5">
            {sel.map(([ch, v]) => <p key={ch}>${ch}: {v.map(String).join(", ")}</p>)}
            <button type="button" onClick={() => onChange({ selections: {} })} className="text-blue-700 hover:underline">Clear selections</button>
          </div>
        )}
      </div>
      <div className="min-w-0 rounded border border-line bg-panel p-2"><ResultTable r={r} /></div>
    </div>
  );
}

const LINE_COLORS = ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#65a30d", "#dc2626", "#4b5563", "#ca8a04"];

/** A grouped time series plot: one line per row of the page, the linear aggregation dashed on top, a legend, a pager. */
function GroupedPlotView({ r, onPage }: { r?: TableResult; onPage?: (page: number) => void }) {
  if (!r) return <p className="py-6 text-center text-xs text-muted">Running…</p>;
  if (r.error) return <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{r.error}</p>;
  const lines = (r.lines ?? []).map((l, i) => ({ ...l, color: LINE_COLORS[i % LINE_COLORS.length] }));
  const agg = r.aggregate;
  const all = [...lines.flatMap((l) => l.points), ...(agg?.points ?? [])];
  if (!all.length) return <p className="py-6 text-center text-xs text-muted">No points in this page&apos;s series.</p>;
  const W = 640;
  const H = 220;
  const L = 44;
  const B = 18;
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  const lo = Math.min(...all.map((p) => p[1]));
  const hi = Math.max(...all.map((p) => p[1]));
  const x = (t: number) => (t1 === t0 ? (L + W) / 2 : L + ((t - t0) / (t1 - t0)) * (W - L - 4));
  const y = (v: number) => (hi === lo ? H / 2 : 4 + (1 - (v - lo) / (hi - lo)) * (H - B - 8));
  const path = (pts: [number, number][]) => pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const page = r.page ?? 0;
  const pages = r.pages ?? 1;
  return (
    <div className="space-y-1 text-[10px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-muted" role="img" aria-label={`Grouped time series plot of ${r.column}: ${lines.length} series`}>
        <line x1={L} y1={H - B} x2={W} y2={H - B} stroke="currentColor" strokeOpacity="0.4" />
        <line x1={L} y1={4} x2={L} y2={H - B} stroke="currentColor" strokeOpacity="0.4" />
        <text x={L - 3} y={10} textAnchor="end" fill="currentColor" fontSize="9">{fmt(hi)}</text>
        <text x={L - 3} y={H - B} textAnchor="end" fill="currentColor" fontSize="9">{fmt(lo)}</text>
        <text x={L} y={H - 4} fill="currentColor" fontSize="9">{day(t0)}</text>
        <text x={W - 2} y={H - 4} textAnchor="end" fill="currentColor" fontSize="9">{day(t1)}</text>
        {lines.map((l) => (
          <polyline key={l.label} points={path(l.points)} fill="none" stroke={l.color} strokeWidth="1.3" strokeLinejoin="round">
            <title>{`${l.label} · ${l.points.length} points${l.points.length ? ` · last ${fmt(l.points[l.points.length - 1][1])}${r.unit ? ` ${r.unit}` : ""}` : ""}`}</title>
          </polyline>
        ))}
        {agg && agg.points.length > 0 && (
          <polyline points={path(agg.points)} fill="none" stroke="currentColor" className="text-soft" strokeWidth="2.2" strokeDasharray="6 3">
            <title>{`${agg.how} of ${agg.series} series`}</title>
          </polyline>
        )}
      </svg>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {lines.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1 text-soft"><span className="inline-block h-0.5 w-3" style={{ background: l.color }} />{l.label}</span>
        ))}
        {agg && <span className="inline-flex items-center gap-1 font-medium text-soft"><span className="inline-block w-3 border-t-2 border-dashed border-current" />{agg.how} of {agg.series} series{agg.points.length ? "" : " (they do not overlap)"}</span>}
      </div>
      <div className="flex items-center gap-2 text-muted">
        <span>{r.column}{r.unit ? ` (${r.unit})` : ""} · rows {(r.total ?? 0) ? page * (r.page_size ?? 10) + 1 : 0}–{Math.min((page + 1) * (r.page_size ?? 10), r.total ?? 0)} of {(r.total ?? 0).toLocaleString()}</span>
        {onPage && pages > 1 && (
          <>
            <button type="button" disabled={page <= 0} onClick={() => onPage(page - 1)} className="rounded border border-line px-1.5 hover:bg-panel-2 disabled:opacity-40">Previous</button>
            <span>page {page + 1} / {pages}</span>
            <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} className="rounded border border-line px-1.5 hover:bg-panel-2 disabled:opacity-40">Next</button>
          </>
        )}
      </div>
    </div>
  );
}

function GroupedPlotEditor({ card, r, refs, onChange }: { card: GroupedPlotCard; r?: TableResult; refs: CardRef[]; onChange: (p: Partial<GroupedPlotCard>) => void }) {
  const sparks = r?.sparkline_columns ?? [];
  return (
    <div className="grid gap-3 p-3 text-[11px] lg:grid-cols-[minmax(15rem,20rem)_1fr]">
      <div className="space-y-2">
        <SourceSelect value={card.source.card ? `card:${card.source.card}` : ""} refs={refs.filter((x) => x.id !== card.id && x.kind === "table")} onChange={(v) => onChange({ source: { card: v.split(":")[1] ?? "" }, column: undefined, page: 0 })} />
        <label className="block">Time series column
          <select value={card.column ?? ""} onChange={(e) => onChange({ column: e.target.value || undefined, page: 0 })} className={`${field} w-full`}>
            <option value="">{sparks[0] ? `First (${sparks[0]})` : "First sparkline column"}</option>
            {sparks.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">Label each line by
          <select value={card.label ?? ""} onChange={(e) => onChange({ label: e.target.value || undefined })} className={`${field} w-full`}>
            <option value="">primary_key</option>
            {(r?.input_columns ?? []).filter((c) => !sparks.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">Series per page
          <input type="number" min={1} max={50} value={card.page_size ?? 10} onChange={(e) => onChange({ page_size: Math.max(1, Math.min(50, Number(e.target.value) || 10)), page: 0 })} className={`${field} w-20`} />
        </label>
        <label className="block">Linear aggregation (across every row&apos;s series)
          <select value={card.aggregate ?? ""} onChange={(e) => onChange({ aggregate: (e.target.value || undefined) as GroupedPlotCard["aggregate"] })} className={`${field} w-full`}>
            <option value="">None</option>
            {GROUPED_AGGREGATES.map((a) => <option key={a} value={a}>{a === "std" ? "std dev" : a}</option>)}
          </select>
        </label>
        <p className="text-[10px] text-muted">Plots a transform table&apos;s Sparkline time series column, one line per row in the table&apos;s order. The aggregation joins the series with linear interpolation and covers the time where they all overlap.</p>
      </div>
      <div className="min-w-0 rounded border border-line bg-panel p-2"><GroupedPlotView r={r} onPage={(page) => onChange({ page })} /></div>
    </div>
  );
}

/** One table-side card on the canvas: editor and result. */
export function TableCardSection({ card, results, refs, sources, params, aid, onChange, onRemove, onCrossSelect }: {
  card: QuiverTableCard;
  results: Record<string, TableResult>;
  refs: (CardRef & { source?: string })[];
  sources: Sources;
  params: string[];
  aid: string;
  onChange: (p: Partial<QuiverTableCard>) => void;
  onRemove: () => void;
  onCrossSelect?: CrossSelect;
}) {
  const r = results[card.id];
  const forNotepad = (
    <button
      type="button"
      onClick={() => copyForNotepad("quiver_chart", { analysis_id: aid, card_id: card.id }, `${card.title || card.id} (Quiver)`) && void alertDialog("Copied: in a Notepad document, Insert → Paste copied widget.")}
      className="rounded px-1 text-muted hover:text-white"
      title="Copy for Notepad"
    >
      <Icon name="copy" className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <section id={`quiver-card-${card.id}`} className="rounded border border-line bg-panel shadow-sm">
      {card.kind === "table" && (
        <>
          <Header card={card} label="Transform table" icon="table" onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <TableCardEditor card={card} r={r} refs={refs} sources={sources} params={params} aid={aid} onChange={onChange} />
        </>
      )}
      {card.kind === "chart" && (
        <>
          <Header card={card} label="Chart" icon="graph" onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <ChartCardEditor card={card} r={r} refs={refs} params={params} onChange={onChange} onCrossSelect={onCrossSelect} />
        </>
      )}
      {card.kind === "value" && (
        <>
          <Header card={card} label="Value" icon="gauge" onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <div className="grid gap-3 p-3 lg:grid-cols-[minmax(15rem,20rem)_1fr] text-[11px]">
            <div className="space-y-2">
              <SourceSelect value={card.source.card ? `card:${card.source.card}` : ""} refs={refs.filter((x) => x.id !== card.id && (["object_set", "table", "object_selector"].includes(x.kind) || isObjectSetCardKind(x.kind)))} onChange={(v) => onChange({ source: { card: v.split(":")[1] ?? "" } } as Partial<ValueCard>)} />
              <input value={card.expr} onChange={(e) => onChange({ expr: e.target.value } as Partial<ValueCard>)} placeholder="SUM(value), MAX(date), COUNT(*) FILTER (WHERE …)" className={`${field} w-full font-mono`} />
              {r?.input_columns && <p className="text-[10px] text-muted">Columns: {r.input_columns.join(", ")}</p>}
            </div>
            <div className="rounded border border-line bg-panel p-3"><ValueDisplay r={r} /></div>
          </div>
        </>
      )}
      {card.kind === "cross_filter" && (
        <>
          <Header card={card} label="Cross filter" icon="filter" onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <CrossFilterEditor card={card} r={r} refs={refs} onChange={onChange as (p: Partial<CrossFilterCard>) => void} />
        </>
      )}
      {card.kind === "action" && (
        <>
          <Header card={card} label="Action button" icon="play" onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <ActionCardEditor card={card} r={r} refs={refs} onChange={onChange as (p: Partial<ActionCard>) => void} />
        </>
      )}
      {card.kind === "grouped_plot" && (
        <>
          <Header card={card} label="Grouped time series plot" icon="graph" onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <GroupedPlotEditor card={card} r={r} refs={refs} onChange={onChange as (p: Partial<GroupedPlotCard>) => void} />
        </>
      )}
      {card.kind === "vega" && (
        <>
          <Header card={card} label="Vega plot" icon="palette" onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <VegaCardEditor card={card} results={results} refs={refs} onChange={onChange} />
        </>
      )}
      {isSingleCard(card) && (
        <>
          <Header card={card} label={CARD_KIND_LABEL[card.kind]} icon={isChartSingleKind(card.kind) ? "graph" : "gauge"} onChange={onChange} onRemove={onRemove} extra={forNotepad} />
          <SingleCardEditor card={card} r={r} refs={refs} params={params} aid={aid} onChange={onChange as (p: Partial<SingleCard>) => void} />
        </>
      )}
    </section>
  );
}

/** A table-side card on a dashboard (read only). */
/** onSelect: a selector card's selection changed by the viewer (without it, a selector shows what is selected). */
export function TableCardDashboard({ card, results, onCrossSelect, onSelect }: { card: QuiverTableCard; results: Record<string, TableResult>; onCrossSelect?: CrossSelect; onSelect?: (cardId: string, v: Selection) => void }) {
  const r = results[card.id];
  return (
    <section className={`rounded-xl border border-line bg-panel p-3 ${card.kind === "value" || card.kind === "object_view" || (isSingleCard(card) && !isChartSingleKind(card.kind) && !isObjectSetCardKind(card.kind) && r?.type !== "array") ? "" : "md:col-span-2"}`}>
      <div className="mb-1 text-xs text-muted">{card.title || `$${card.id}`}</div>
      {(card.kind === "table" || card.kind === "cross_filter") && <ResultTable r={r} max={50} />}
      {card.kind === "chart" && (r?.error ? <p className="text-xs text-bad">{r.error}</p> : <BoardView b={{ id: card.id, type: (CHARTS.find((c) => c[0] === card.chart)?.[2] ?? "chart") as BoardType, config: card.config, selection: r?.selection ?? null }} r={r ? { data: r.data, data_columns: r.data_columns } : undefined} onSelect={r?.cross_filter && onCrossSelect ? (k) => onCrossSelect(r.cross_filter!, card.id, k) : undefined} />)}
      {card.kind === "value" && <ValueDisplay r={r} />}
      {card.kind === "vega" && <VegaView spec={card.spec} results={results} />}
      {card.kind === "action" && <ActionButton card={card} r={r} />}
      {card.kind === "grouped_plot" && <GroupedPlotView r={r} />}
      {isSingleCard(card) && <SingleCardView card={card} r={r} onSelect={onSelect ? (v) => onSelect(card.id, v) : undefined} />}
    </section>
  );
}

/** `series`: the analysis' time series cards (the time series single cards' first input). */
export function newTableCard(kind: QuiverTableCard["kind"], id: string, firstInput?: { id: string; kind: string }, series: string[] = []): QuiverTableCard {
  const src = firstInput?.id ?? "";
  if ((SINGLE_CARD_KINDS as readonly string[]).includes(kind)) return newSingleCard(kind as SingleCard["kind"], id, firstInput, series);
  if (kind === "table") return { id, kind, title: "Transform table", source: firstInput ? { kind: firstInput.kind === "object_set" ? "object_set" : "table", card: src } : { kind: "values", columns: ["column1", "column2"], rows: [["a", 1]] }, steps: [] };
  if (kind === "chart") return { id, kind, title: "Chart", source: { card: src }, chart: "bar", config: {} };
  if (kind === "value") return { id, kind, title: "Value", source: { card: src }, expr: "COUNT(*)" };
  if (kind === "action") return { id, kind, title: "Action", action_id: "", defaults: {} };
  if (kind === "cross_filter") return { id, kind, title: "Cross filter", source: { card: src }, subscribed: [], selections: {} };
  if (kind === "grouped_plot") return { id, kind, title: "Grouped time series plot", source: { card: firstInput?.kind === "table" ? src : "" }, page_size: 10 };
  return { id, kind: "vega", title: "Vega plot", tables: firstInput?.kind === "table" ? [src] : [], spec: firstInput?.kind === "table" ? VEGA_TEMPLATE(src) : "{}" };
}

/** The Action button: opens the action's form with the card's defaults; the action applies to the Ontology. */
function ActionButton({ card, r }: { card: ActionCard; r?: TableResult }) {
  const [open, setOpen] = useState<{ action: ActionType; type: ObjectType } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const start = async () => {
    setNote(null);
    try {
      const action = (await ontology.actionTypes()).find((x) => x.id === card.action_id);
      if (!action) throw new Error("Choose the action");
      const types = await ontology.objectTypes();
      const type = types.find((t) => t.id === action.object_type_id) ?? types[0];
      if (!type) throw new Error("No object types");
      setOpen({ action, type });
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={!card.action_id || !!r?.error} onClick={() => void start()} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {card.title || "Run action"}
      </button>
      {r?.error && <span className="text-xs text-bad">{r.error}</span>}
      {note && <span className="text-xs text-muted">{note}</span>}
      {open && (
        <ActionForm
          action={open.action}
          objectType={open.type}
          defaults={(r?.defaults ?? {}) as Record<string, unknown>}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            setNote(`${open.action.display_name} applied`);
          }}
        />
      )}
    </div>
  );
}

function ActionCardEditor({ card, r, refs, onChange }: { card: ActionCard; r?: TableResult; refs: CardRef[]; onChange: (p: Partial<ActionCard>) => void }) {
  const [list, setList] = useState<ActionType[]>([]);
  useEffect(() => {
    ontology.actionTypes().then(setList, () => setList([]));
  }, []);
  const action = list.find((x) => x.id === card.action_id);
  const values = refs.filter((x) => x.kind === "value");
  return (
    <div className="grid gap-3 p-3 text-[11px] lg:grid-cols-[minmax(15rem,22rem)_1fr]">
      <div className="space-y-2">
        <select value={card.action_id} onChange={(e) => onChange({ action_id: e.target.value, defaults: {} })} className={`${field} w-full`}>
          <option value="">Nexus action…</option>
          {list.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
        </select>
        {(action?.parameters ?? []).map((p) => (
          <label key={p.id} className="block">
            <span className="text-muted">{p.display_name ?? p.id}</span>
            <input
              value={card.defaults[p.id] ?? ""}
              onChange={(e) => onChange({ defaults: { ...card.defaults, [p.id]: e.target.value } })}
              placeholder={values.length ? `a value, or $${values[0].id}` : "default value"}
              className={`${field} w-full font-mono`}
            />
          </label>
        ))}
        <p className="text-[10px] text-muted">Defaults prefill the action form; $V1 takes a value card&apos;s result. Readers of the dashboard can run it.</p>
      </div>
      <div className="rounded border border-line bg-panel p-3"><ActionButton card={card} r={r} /></div>
    </div>
  );
}
