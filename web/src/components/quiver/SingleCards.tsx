"use client";

/** Quiver single cards (api/quiver_cards.py; the time series single cards' settings and charts are in SeriesCards.tsx):
 * numeric aggregation, column values, numeric formula, floor / ceiling,
 * date difference, date part, correlation matrix and waterfall plot; string operations, comparisons, Boolean formula,
 * create / stepped array, array operations, coalesce, ranges and range start / end; the selector parameters (string
 * selector, property value select, object selector, row selector), string / number to date, period to date, object
 * property, Multipass attribute and X/Y range — the editor of each and its result. The object set cards' settings and
 * objects are in ObjectCards.tsx. */
import { useState } from "react";
import {
  AGGREGATIONS,
  ARRAY_CARD_KINDS,
  ARRAY_ELEMENT_TYPES,
  ARRAY_OPS,
  COMPARISONS,
  DATE_AGGREGATIONS,
  DATE_CONVERSIONS,
  DATE_PARTS,
  cellText,
  DATE_UNITS,
  INPUT_CARD_KINDS,
  isChartSingleKind,
  isObjectSetCardKind,
  isSelectorCard,
  isSeriesSingleCard,
  MULTIPASS_ATTRIBUTES,
  NUMBER_DATE_UNITS,
  PERIODS,
  quiverTables,
  RANGE_CARD_KINDS,
  RANGE_OPS,
  RANGE_TYPES,
  STRING_OPS,
  VALUE_CARD_KINDS,
  WATERFALL_METRICS,
  XY_RANGE_TYPES,
  type DateConvertCard,
  type MultipassAttributeCard,
  type ObjectPropertyCard,
  type ObjectSelectorCard,
  type PeriodToDateCard,
  type PropertySelectCard,
  type RowSelectorCard,
  type Selection,
  type StringSelectorCard,
  type XyRangeCard,
  type ArrayOpCard,
  type BooleanFormulaCard,
  type CoalesceCard,
  type ComparisonCard,
  type CreateArrayCard,
  type SteppedArrayCard,
  type StringOpCard,
  type ColumnValuesCard,
  type CorrelationCard,
  type DateDiffCard,
  type DatePartCard,
  type NumericAggCard,
  type NumericFormulaCard,
  type ObjectSetSingleCard,
  type RangeCard,
  type RangeOpCard,
  type RoundCard,
  type SeriesSingleCard,
  type SingleCard,
  type TableResult,
  type WaterfallCard,
} from "@/lib/quiverTables";
import { DistributionView, newSeriesCard, ScatterView, SeriesCardForm, SeriesNote } from "@/components/quiver/SeriesCards";
import { newObjectCard, ObjectCardForm, ObjectSetView, SaveObjectList } from "@/components/quiver/ObjectCards";

const field = "rounded border border-line-2 bg-panel px-1.5 py-1 text-[11px] text-soft outline-none focus:border-blue-500";
type Ref = { id: string; title: string; kind: string };
type ColKind = "number" | "date" | "string" | "boolean";

/** The input columns of the card's last successful run (kept while a draft has an error, so the pickers stay filled). */
function useColumns(r?: TableResult): Record<string, ColKind> {
  const [last, setLast] = useState<Record<string, ColKind>>({});
  // remembered while rendering (React's "storing information from previous renders"), not in an effect
  if (r?.column_types && r.column_types !== last) setLast(r.column_types);
  return r?.column_types ?? last;
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-muted">{text}</span>
      {children}
    </label>
  );
}

function InputSelect({ value, refs, kinds, onChange }: { value: string; refs: Ref[]; kinds: string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-full`} aria-label="Input card">
      <option value="">Input…</option>
      {refs.filter((x) => kinds.includes(x.kind)).map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}
    </select>
  );
}

function ColumnSelect({ value, cols, only, onChange, placeholder = "Column…", label = "Column" }: { value: string; cols: Record<string, ColKind>; only?: ColKind[]; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  const names = Object.keys(cols).filter((c) => !only || only.includes(cols[c]));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-full`} aria-label={label}>
      <option value="">{placeholder}</option>
      {value && !names.includes(value) && <option value={value}>{value}</option>}
      {names.map((c) => <option key={c} value={c}>{c} ({cols[c]})</option>)}
    </select>
  );
}

/** "$ID" / "$ID.name" → [ID, name]; anything else (typed text) → null. */
const refParts = (v: string): [string, string | undefined] | null => {
  const m = /^\$([A-Za-z][\w-]*)(?:\.([\s\S]*))?$/.exec(v);
  return m ? [m[1], m[2]] : null;
};

/** An input of a value card: another card's value ($ID; a row selector's cell $ID.column), a parameter ($P) or a typed
 * value. */
function Operand({ value, refs, params, onChange, placeholder, label }: { value: string; refs: Ref[]; params: string[]; onChange: (v: string) => void; placeholder: string; label: string }) {
  const values = refs.filter((x) => (VALUE_CARD_KINDS as readonly string[]).includes(x.kind));
  const parts = refParts(value);
  const base = parts ? `$${parts[0]}` : "";
  const known = [...values.map((x) => `$${x.id}`), ...params.map((p) => `$${p}`)];
  const isRow = !!parts && refs.find((x) => x.id === parts[0])?.kind === "row_selector";
  return (
    <div className="flex gap-1">
      <select value={base} onChange={(e) => onChange(e.target.value)} className={`${field} min-w-0 flex-1`} aria-label={`${label}: card or parameter`}>
        <option value="">Typed value</option>
        {base && !known.includes(base) && <option value={base}>{base}</option>}
        {values.length > 0 && <optgroup label="Cards">{values.map((x) => <option key={x.id} value={`$${x.id}`}>${x.id} · {x.title}</option>)}</optgroup>}
        {params.length > 0 && <optgroup label="Parameters">{params.map((p) => <option key={p} value={`$${p}`}>${p}</option>)}</optgroup>}
      </select>
      {!parts && <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${field} min-w-0 flex-1 font-mono`} aria-label={label} />}
      {(isRow || parts?.[1] !== undefined) && (
        <input value={parts?.[1] ?? ""} onChange={(e) => onChange(e.target.value ? `${base}.${e.target.value}` : base)} placeholder={isRow ? "column" : "part"} className={`${field} w-24 font-mono`} aria-label={`${label}: column of the selected row`} title="$ID.column reads one cell of the selected row" />
      )}
    </div>
  );
}

/** An array input: a card whose result is an array ($L1, a split, a create array …). */
function ArrayInput({ value, refs, onChange }: { value: string; refs: Ref[]; onChange: (v: string) => void }) {
  const arrays = refs.filter((x) => (ARRAY_CARD_KINDS as readonly string[]).includes(x.kind));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-full`} aria-label="Array">
      <option value="">Array card…</option>
      {value && !arrays.some((x) => `$${x.id}` === value) && <option value={value}>{value}</option>}
      {arrays.map((x) => <option key={x.id} value={`$${x.id}`}>${x.id} · {x.title}</option>)}
    </select>
  );
}

/** A range input: a range card ($RG1 …) or a date / time range parameter. */
function RangeInput({ value, refs, params, onChange }: { value: string; refs: Ref[]; params: string[]; onChange: (v: string) => void }) {
  const ranges = refs.filter((x) => (RANGE_CARD_KINDS as readonly string[]).includes(x.kind));
  // an X/Y range card's two ranges
  const xy = refs.filter((x) => x.kind === "xy_range").flatMap((x) => (["x", "y"] as const).map((p) => ({ v: `$${x.id}.${p}`, label: `$${x.id}.${p} · ${x.title} (${p.toUpperCase()})` })));
  const known = [...ranges.map((x) => `$${x.id}`), ...xy.map((x) => x.v), ...params.map((p) => `$${p}`)];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-full`} aria-label="Range">
      <option value="">Range card or range parameter…</option>
      {value && !known.includes(value) && <option value={value}>{value}</option>}
      {ranges.length > 0 && <optgroup label="Cards">{ranges.map((x) => <option key={x.id} value={`$${x.id}`}>${x.id} · {x.title}</option>)}</optgroup>}
      {xy.length > 0 && <optgroup label="X/Y ranges">{xy.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</optgroup>}
      {params.length > 0 && <optgroup label="Parameters (date / time range)">{params.map((p) => <option key={p} value={`$${p}`}>${p}</option>)}</optgroup>}
    </select>
  );
}

/** A list of inputs (create array, coalesce): each typed or a card / parameter. */
function OperandList({ items, refs, params, onChange, placeholder, label }: { items: string[]; refs: Ref[]; params: string[]; onChange: (v: string[]) => void; placeholder: string; label: string }) {
  return (
    <div className="space-y-1">
      {items.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className="min-w-0 flex-1"><Operand value={s} refs={refs} params={params} onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))} placeholder={placeholder} label={`${label} ${i + 1}`} /></div>
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}>×</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, ""])} className="text-blue-700 hover:underline">+ Add {label.toLowerCase()}</button>
    </div>
  );
}

/** A card still titled after its operation follows the operation when it changes ("To upper case" → "Substring"). */
function retitle(title: string, ops: readonly (readonly [string, string, ...string[]])[], from: string, to: string): { title?: string } {
  const label = (k: string) => ops.find((o) => o[0] === k)?.[1];
  return title === label(from) && label(to) ? { title: label(to) } : {};
}

const isMidnight = (s: string) => /T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s);

export function formatSingle(v: unknown, type?: string): string {
  if (v === null || v === undefined) return "—";
  if (type === "date" && typeof v === "string") return isMidnight(v) ? v.slice(0, 10) : v.replace("T", " ").replace(/(\.\d+)?Z?$/, "");
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return cellText(v); // an array / struct value (e.g. the values of an array column)
  return String(v);
}

/** A value card's result: a number, a date, a string, or an array as chips. */
export function SingleValue({ r }: { r?: TableResult }) {
  if (!r) return <span className="text-xs text-muted">…</span>;
  if (r.error) return <span className="text-xs text-bad">{r.error}</span>;
  if (r.type === "array") {
    const vals = Array.isArray(r.value) ? (r.value as unknown[]) : [];
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-muted">{(r.count ?? vals.length).toLocaleString()} {r.element_type ?? ""} values{r.truncated ? ` · first ${vals.length.toLocaleString()}` : ""}</div>
        <div className="flex max-h-32 flex-wrap gap-1 overflow-auto">
          {vals.slice(0, 200).map((v, i) => <span key={i} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-soft">{formatSingle(v, r.element_type)}</span>)}
          {vals.length > 200 && <span className="text-[10px] text-muted">+{(vals.length - 200).toLocaleString()} more</span>}
        </div>
      </div>
    );
  }
  if (r.type === "range") {
    const v = (r.value ?? {}) as { start?: unknown; end?: unknown };
    const end = (x: unknown) => (x === null || x === undefined ? "open" : formatSingle(x, r.element_type));
    return (
      <div className="space-y-0.5">
        <div className="text-[10px] text-muted">{r.element_type === "date" ? "date / time" : "numeric"} range</div>
        <span className="text-lg font-semibold tabular-nums">{end(v.start)} <span className="font-normal text-muted">→</span> {end(v.end)}</span>
      </div>
    );
  }
  if (r.type === "xy_range") {
    const v = (r.value ?? {}) as Record<string, { start?: unknown; end?: unknown } | undefined>;
    const end = (x: unknown, t?: string) => (x === null || x === undefined ? "open" : formatSingle(x, t));
    return (
      <div className="space-y-1">
        {(["x", "y"] as const).map((axis) => (
          <div key={axis} className="flex items-baseline gap-2">
            <span className="w-4 text-[10px] font-semibold uppercase text-muted">{axis}</span>
            <span className="text-base font-semibold tabular-nums">{end(v[axis]?.start, r.element_types?.[axis])} <span className="font-normal text-muted">→</span> {end(v[axis]?.end, r.element_types?.[axis])}</span>
            <span className="text-[10px] text-muted">{{ number: "numeric", date: "date / time", string: "ordinal" }[r.element_types?.[axis] ?? "number"] ?? ""}</span>
          </div>
        ))}
      </div>
    );
  }
  if (r.type === "row") {
    const row = r.value as Record<string, unknown> | null;
    if (!row) return <span className="text-xs text-muted">No row selected.</span>;
    return (
      <div className="max-h-48 overflow-auto">
        {r.row_index !== undefined && <div className="mb-1 text-[10px] text-muted">row {r.row_index}</div>}
        <table className="w-full text-[11px]">
          <tbody>
            {Object.entries(row).map(([k, v]) => (
              <tr key={k} className="border-t border-line first:border-0">
                <td className="py-0.5 pr-2 font-mono text-muted">{k}</td>
                <td className="break-all py-0.5 text-soft">{typeof v === "object" && v !== null ? cellText(v) : formatSingle(v, r.column_types?.[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (r.type === "boolean" && typeof r.value === "boolean") {
    return <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-lg font-semibold ${r.value ? "bg-ok/15 text-ok" : "bg-panel-2 text-muted"}`}>{r.value ? "✓ true" : "✗ false"}</span>;
  }
  if (r.type === "string" && typeof r.value === "string" && r.value.length > 28) {
    return <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-soft">{r.value}</p>;
  }
  return (
    <span className={`text-2xl font-semibold ${r.type === "string" ? "break-all" : "tabular-nums"}`} title={r.date ? `from ${r.date}` : undefined}>
      {formatSingle(r.value, r.type)}
      {r.unit && r.type === "number" ? <span className="ml-1 text-xs font-normal text-muted">{r.unit}s</span> : null}
      {r.value_unit && r.type === "number" && r.value !== null && r.value !== undefined ? <span className="ml-1 text-xs font-normal text-muted">{r.value_unit}</span> : null}
    </span>
  );
}

/** Correlation matrix: a cell per pair of columns, blue for negative, red for positive, the surface at 0. */
export function CorrelationView({ r }: { r?: TableResult }) {
  if (!r) return <p className="py-6 text-center text-xs text-muted">Running…</p>;
  if (r.error) return <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{r.error}</p>;
  const cols = r.columns ?? [];
  const cells = new Map((r.data ?? []).map((d) => [`${d.x}\u0000${d.y}`, d as { value: number | null; n: number }]));
  const C = 46;
  const L = Math.min(150, 12 + Math.max(...cols.map((c) => c.length)) * 6);
  const W = L + cols.length * C;
  const H = 18 + cols.length * C;
  const fill = (v: number | null) => (v === null ? "transparent" : v >= 0 ? "#e34948" : "#2a78d6");
  return (
    <div className="space-y-1 text-[10px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full max-w-xl text-muted" role="img" aria-label={`${r.method === "spearman" ? "Spearman" : "Pearson"} correlation matrix of ${cols.join(", ")}`}>
        {cols.map((c, i) => (
          <text key={`x${c}`} x={L + i * C + C / 2} y={12} textAnchor="middle" fill="currentColor" fontSize="9">{c.length > 9 ? `${c.slice(0, 8)}…` : c}<title>{c}</title></text>
        ))}
        {cols.map((y, j) => (
          <g key={y}>
            <text x={L - 4} y={18 + j * C + C / 2 + 3} textAnchor="end" fill="currentColor" fontSize="9">{y.length > 22 ? `${y.slice(0, 21)}…` : y}<title>{y}</title></text>
            {cols.map((x, i) => {
              const d = cells.get(`${x}\u0000${y}`);
              const v = d?.value ?? null;
              return (
                <g key={x}>
                  <rect x={L + i * C + 1} y={18 + j * C + 1} width={C - 2} height={C - 2} rx="3" fill={fill(v)} fillOpacity={v === null ? 0 : 0.12 + Math.abs(v) * 0.78} stroke="currentColor" strokeOpacity="0.15">
                    <title>{`${y} × ${x}: ${v === null ? "no value (constant or too few rows)" : v.toFixed(3)} · ${d?.n ?? 0} rows`}</title>
                  </rect>
                  <text x={L + i * C + C / 2} y={18 + j * C + C / 2 + 3} textAnchor="middle" fontSize="10" className="fill-soft" style={{ pointerEvents: "none" }}>{v === null ? "—" : v.toFixed(2)}</text>
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      <div className="flex items-center gap-2 text-muted">
        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: "#2a78d6" }} /> −1
        <span className="inline-block h-2.5 w-4 rounded-sm border border-line" /> 0
        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: "#e34948" }} /> +1
        <span>· {r.method === "spearman" ? "Spearman (rank)" : "Pearson"}, rows where both columns have a value</span>
      </div>
    </div>
  );
}

/** Waterfall plot: each bucket floats from where the previous one ended; increases blue, decreases red, the total gray. */
export function WaterfallView({ r }: { r?: TableResult }) {
  if (!r) return <p className="py-6 text-center text-xs text-muted">Running…</p>;
  if (r.error) return <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{r.error}</p>;
  const data = (r.data ?? []) as { key: string; value: number; start: number; end: number; total: boolean }[];
  if (!data.length) return <p className="py-6 text-center text-xs text-muted">No buckets.</p>;
  const W = 640;
  const H = 220;
  const L = 56;
  const B = 34;
  const vals = data.flatMap((d) => [d.start, d.end, 0]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const y = (v: number) => (hi === lo ? H / 2 : 6 + (1 - (v - lo) / (hi - lo)) * (H - B - 10));
  const step = (W - L) / data.length;
  const bw = Math.max(4, Math.min(48, step - 6));
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2, notation: Math.abs(v) >= 1e6 ? "compact" : "standard" });
  return (
    <div className="space-y-1 text-[10px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full text-muted" role="img" aria-label={`Waterfall plot: ${data.length} buckets, ending at ${fmt(data[data.length - 1].end)}`}>
        <line x1={L} y1={y(0)} x2={W} y2={y(0)} stroke="currentColor" strokeOpacity="0.4" />
        <text x={L - 4} y={y(hi) + 4} textAnchor="end" fill="currentColor" fontSize="9">{fmt(hi)}</text>
        {lo < 0 && <text x={L - 4} y={y(lo)} textAnchor="end" fill="currentColor" fontSize="9">{fmt(lo)}</text>}
        <text x={L - 4} y={y(0) + 3} textAnchor="end" fill="currentColor" fontSize="9">0</text>
        {data.map((d, i) => {
          const x = L + i * step + (step - bw) / 2;
          const top = y(Math.max(d.start, d.end));
          const h = Math.max(1, Math.abs(y(d.start) - y(d.end)));
          const color = d.total ? "currentColor" : d.value >= 0 ? "#2a78d6" : "#e34948";
          return (
            <g key={`${d.key}-${i}`}>
              {i > 0 && !d.total && <line x1={x - (step - bw)} x2={x} y1={y(d.start)} y2={y(d.start)} stroke="currentColor" strokeOpacity="0.35" strokeDasharray="2 2" />}
              <rect x={x} y={top} width={bw} height={h} rx="2" fill={color} fillOpacity={d.total ? 0.55 : 0.9}>
                <title>{`${d.key}: ${d.value >= 0 && !d.total ? "+" : ""}${d.value.toLocaleString()}${d.total ? "" : ` (${d.start.toLocaleString()} → ${d.end.toLocaleString()})`}`}</title>
              </rect>
              <text x={x + bw / 2} y={H - B + 12} textAnchor="middle" fill="currentColor" fontSize="9">{d.key.length > 12 ? `${d.key.slice(0, 11)}…` : d.key}<title>{d.key}</title></text>
              {data.length <= 12 && <text x={x + bw / 2} y={top - 3} textAnchor="middle" fontSize="9" className="fill-soft">{fmt(d.value)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-3 text-muted">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: "#2a78d6" }} />increase</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: "#e34948" }} />decrease</span>
        {data.some((d) => d.total) && <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-3 rounded-sm bg-current opacity-55" />total</span>}
      </div>
    </div>
  );
}

type Opt = { value: string | number; label: string };

/** The options of a selector's result ({value, label}; a boolean is selected as "true" / "false"). */
function optionsOf(r?: TableResult): Opt[] {
  const t = r?.type === "array" ? r.element_type : r?.type;
  return (r?.options ?? []).map((o) => (typeof o === "object" && o !== null ? o : { value: typeof o === "boolean" ? String(o) : o, label: formatSingle(o, t) }));
}

const asList = (v: Selection | undefined): (string | number)[] => (Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v]);

/** A selector card's control: a dropdown, or checkboxes when it is a multiselect. The options of the last run that had
 * them stay while a selection is refused, so the viewer can change it. */
export function SelectorControl({ card, r, onSelect }: { card: StringSelectorCard | PropertySelectCard | ObjectSelectorCard | RowSelectorCard; r?: TableResult; onSelect: (v: Selection) => void }) {
  const [last, setLast] = useState<TableResult | undefined>(undefined);
  const [q, setQ] = useState("");
  if (r?.options && r !== last) setLast(r);
  const src = r?.options ? r : last;
  if (!src) return r?.error ? <span className="text-xs text-bad">{r.error}</span> : <span className="text-xs text-muted">…</span>;
  const opts = optionsOf(src);
  const multiple = card.kind !== "row_selector" && !!card.multiple;
  const chosen = asList(card.value).map(String);
  const byText = new Map(opts.map((o) => [String(o.value), o]));
  const more = (src.options_total ?? opts.length) > opts.length ? <div className="text-[10px] text-muted">first {opts.length.toLocaleString()} of {(src.options_total ?? 0).toLocaleString()}</div> : null;
  const error = r?.error ? <p className="text-[11px] text-bad">{r.error}</p> : null;
  if (!multiple) {
    return (
      <div className="space-y-1">
        <select
          value={chosen[0] ?? ""}
          onChange={(e) => onSelect(e.target.value === "" ? null : byText.get(e.target.value)?.value ?? e.target.value)}
          className={`${field} w-full text-xs`}
          aria-label={card.title || `$${card.id}`}
        >
          <option value="">{card.kind === "row_selector" ? "No row" : "Nothing selected"}</option>
          {chosen[0] !== undefined && !byText.has(chosen[0]) && <option value={chosen[0]}>{chosen[0]}</option>}
          {/* a row selector keyed by a column that repeats lists a value more than once: keys by position */}
          {opts.map((o, i) => <option key={`${i}|${String(o.value)}`} value={String(o.value)}>{o.label}{card.kind === "object_selector" && o.label !== String(o.value) ? ` (${o.value})` : ""}</option>)}
        </select>
        {more}
        {error}
      </div>
    );
  }
  const shown = q ? opts.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(q.toLowerCase())) : opts;
  const toggle = (o: Opt) => {
    const cur = asList(card.value);
    onSelect(chosen.includes(String(o.value)) ? cur.filter((x) => String(x) !== String(o.value)) : [...cur, o.value]);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[10px] text-muted">
        <span>{chosen.length.toLocaleString()} selected</span>
        {chosen.length > 0 && <button type="button" onClick={() => onSelect([])} className="text-blue-700 hover:underline">Clear</button>}
        {opts.length > 8 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className={`${field} ml-auto w-32`} aria-label="Search the options" />}
      </div>
      <div className="max-h-44 space-y-0.5 overflow-auto rounded border border-line p-1">
        {chosen.filter((x) => !byText.has(x)).map((x) => (
          <label key={x} className="flex items-center gap-1.5 text-[11px] text-bad"><input type="checkbox" checked onChange={() => onSelect(asList(card.value).filter((y) => String(y) !== x))} />{x}</label>
        ))}
        {shown.slice(0, 300).map((o, i) => (
          <label key={`${i}|${String(o.value)}`} className="flex items-center gap-1.5 text-[11px] text-soft">
            <input type="checkbox" checked={chosen.includes(String(o.value))} onChange={() => toggle(o)} />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
        {shown.length > 300 && <div className="text-[10px] text-muted">+{(shown.length - 300).toLocaleString()} more: search to narrow</div>}
        {!shown.length && <div className="text-[10px] text-muted">No options.</div>}
      </div>
      {more}
      {error}
    </div>
  );
}

/** A single card's result, on the canvas or a dashboard. A selector shows its control when the selection can be changed
 * here (`onSelect`), else what is selected. */
export function SingleCardView({ card, r, onSelect }: { card: SingleCard; r?: TableResult; onSelect?: (v: Selection) => void }) {
  if (isObjectSetCardKind(card.kind)) return <ObjectSetView card={card as ObjectSetSingleCard} r={r} />;
  if (card.kind === "correlation") return <CorrelationView r={r} />;
  if (card.kind === "waterfall") return <WaterfallView r={r} />;
  if (card.kind === "series_distribution") return <DistributionView r={r} />;
  if (card.kind === "series_scatter") return <ScatterView r={r} />;
  if (isSeriesSingleCard(card)) {
    return (
      <div className="space-y-1">
        <SingleValue r={r} />
        <SeriesNote card={card} r={r} />
      </div>
    );
  }
  if (isSelectorCard(card)) {
    const shown = card.kind === "object_selector" && r && !r.error ? (
      r.objects?.length ? <div className="flex flex-wrap gap-1">{r.objects.map((o) => <span key={o.primary_key} title={o.primary_key} className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-soft">{o.label}</span>)}</div> : <span className="text-xs text-muted">No object selected: the card holds no objects.</span>
    ) : (card.kind === "row_selector" && !(onSelect && r?.error)) || !onSelect ? <SingleValue r={r} /> : null;
    return (
      <div className="space-y-2">
        {onSelect && <SelectorControl card={card} r={r} onSelect={onSelect} />}
        {shown}
      </div>
    );
  }
  return <SingleValue r={r} />;
}

const DESCRIPTION: Record<SingleCard["kind"], string> = {
  numeric_agg: "One number from an object set (Numeric aggregation), a transform table (Transform table aggregation) or a column values card (Number array aggregation). First / last / difference follow the table's row order.",
  column_values: "A column of an object set or transform table as an array (nulls left out); distinct gives its unique values.",
  numeric_formula: "Quiver's formula syntax on single values: $N1 / $N2 * 100, $F1 > $P ? 1 : 0, pow(a, b), round(a, digits), floor, ceil, abs, sqrt, ln, log10, min, max …; on strings and arrays length, contains, starts_with, ends_with, lower, upper, trim, concat. Value cards and parameters are $ID.",
  round: "Floor rounds down, ceiling up; digits 2 keeps two decimals, -3 rounds to thousands.",
  date_diff: "End minus start in the unit (fractional); the dates come from value cards (e.g. a max of a date column), parameters or typed ISO dates.",
  date_part: "A part of a date as a number, in UTC.",
  correlation: "Correlation of every pair of numeric columns (all numeric columns when none are chosen, at most 20), over the rows where both have a value.",
  waterfall: "Buckets from grouping an object set or table, or steps of numbers; each bucket starts where the previous one ended.",
  string_op: "Inputs are typed text (spaces kept) or a card / parameter ($ID). Substring and indexes count from 0; a negative start counts from the end. Regex patterns are Python syntax, replacements use \\1 for a group.",
  comparison: "True or false; empty (null) when an input is empty. Contains treats spaces and characters such as . / @ - as word boundaries (\"I25\" is in \"I25.1\", \"I2\" is not) unless whole words is off; Starts with / Ends with / Is match the text literally. Case-sensitive unless ignored.",
  boolean_formula: "The formula syntax returning true / false: $N1 > $N2 && !$B1, contains($L1, \"I10\"), starts_with($S1, \"RS\"), length($L1) >= 3 … A number is true when it is not 0.",
  create_array: "Values typed or from cards and parameters, in order; an array card's values are spliced in. Auto: numbers when every value is a number.",
  stepped_array: "Numbers from the start to the end by the step (a start above the end counts down), at most 10,000.",
  array_op: "Index 0 is the first value, -1 the last; an index outside the array is empty. Sort puts empty values last; unique keeps the first of each value in order.",
  coalesce: "The first input that is not empty (null) — e.g. a card that may be empty, then a typed fallback.",
  range: "A numeric or a date / time range from typed values, cards or parameters; the start is not after the end, an empty end leaves that side open. Auto: numeric when both ends are numbers.",
  range_op: "The start or the end of a range card or of a date / time range parameter, as a number or a date other cards can read. Numeric range to date range reads the ends as epoch milliseconds (UTC).",
  string_selector: "A parameter: one (or several) of typed options, of a column's distinct values or of an array card's values. Other cards read the selection as $ID; transform tables' expressions and filters too. The selection here is the default; a dashboard viewer's selection applies to their view only.",
  property_select: "A parameter: one (or several) of the values of an object set property, with the property's type ($ID in other cards, expressions and filters). The selection here is the default; dashboard viewers change it for their view.",
  object_selector: "One object (or several) of an object set or table by primary key. The card is itself an object set — the selected objects — that tables, charts and single cards read as their input; its value ($ID) is the primary key. Nothing selected: no objects.",
  row_selector: "One row of a transform table: by the value of a key column (the first row holding it) or, without a key, by its row index (0 first). $ID.column reads one cell of the row.",
  date_convert: "String to date reads ISO (2026-09-07, 2026-09-07T09:30:00Z) or MM/DD/YYYY without a format, else a Day.js format: YYYY MM DD HH mm ss SSS, MMM / MMMM month names, hh with A, Z for a zone; [text] is literal. Strings without a zone are read in the time zone. Number to date reads epoch milliseconds, seconds or days.",
  period_to_date: "The range from 00:00 (UTC) on the first day of the date's day / week / month / year to the date itself; without a date, to now. Range start / Range end read its ends.",
  object_property: "A property of one object: the selected object of an object selector, or of an object set that holds exactly one object (empty when it holds none).",
  multipass_attribute: "An attribute of the user viewing the card (each viewer sees their own), or the ID / username / display name of the user whose ID is the input. Groups are an array.",
  xy_range: "Two ranges (a box): X and Y, each numeric, date / time or ordinal strings. $ID.x and $ID.y are range inputs of Range start / Range end.",
  series_agg: "One number from a numeric time series of the analysis over the range, read for the root object. The standard deviation is the population's, as in the time series columns. Time-weighted average: the area under the curve divided by the time it covers; integral: the area. Without bounds interpolation only the area between the points inside the range counts.",
  series_op: "Value at time reads the series' value at a time — a point's value, else by the series' interpolation (or the one chosen), whatever the analysis' range; Enum value at time for string series. Latest value, unit, start and end date read the range. Backing object: the primary key of the object the series belongs to.",
  regression: "The best-fit coefficients as a number array, lowest power first: y = c0 + c1·x + … (exponential: [a, b] of y = a·e^(b·x), every value above 0). For a time series, x is the time since its first point in the range; for a scatter plot card, its X values. Array cards and a number array aggregation read the coefficients.",
  shift_datetime: "A date / time moved by a number of weeks, days, hours, minutes, seconds or milliseconds; a negative number moves it earlier, an empty date is now. The date and the number are typed, or come from cards and parameters.",
  series_distribution: "How often the series takes its values over the range: equal-width bins between its smallest and largest value (an enum series: a bar per value, the most frequent first).",
  series_scatter: "Two numeric time series against each other: joined on their timestamps by their interpolation, then one point per time bucket (the buckets split the joined points' time evenly). The heat grid shades cells by the number of points; the regression line is the best fit of Y on X.",
  filter_object_set: "The input's objects matching all (or any) of the conditions: on their properties, on a linked object's property (objects linked to at least one matching object), or nested groups. Values are typed (between and is one of: a, b) or $ID — a card's value or a parameter. An empty value does not filter. The card is itself an object set other cards read.",
  set_math: "Object sets of the same type combined: union (in any set), intersection (in every set) or difference (in the first set, not in the others).",
  linked_object_set: "A search around: every object linked to an object of the input by the chosen link (it may hold more or fewer objects than the input). Chain cards to follow several links.",
  status_filter: "Objects open during the range — opened before its end and not closed by it (no end date: still open) — or closed during it (an end date in the range; objects closed before the range are left out).",
  object_view: "One object's properties: the object of an object selector (or of an object set holding one object), or by its type and primary key — typed or a card's value ($ID, e.g. a backing object from time series). Its value ($ID) is the primary key; it is also a one-object set.",
  defined_by_property: "The objects whose property holds one of a set of values: the values of another card's column or property (an object set, a table; or an array card's values), or typed values / $ID — e.g. the identifier of a saved object set, for cohorts tagged by hand. Numbers compare as numbers, dates as dates, the rest as text; an array property matches when any element holds a value. No values: no objects.",
  saved_object_set: "A saved object set imported into the analysis: an Object Explorer exploration (its search run now, with your permissions) or an object list — also one saved from another Quiver analysis' object set card (Save as object list). Shows how many objects it holds and the set's details.",
};

/** The editor of a single card: its settings on the left, the result on the right. */
export function SingleCardEditor({ card, r, refs, params, aid, onChange }: { card: SingleCard; r?: TableResult; refs: Ref[]; params: string[]; aid: string; onChange: (p: Partial<SingleCard>) => void }) {
  const cols = useColumns(r);
  const others = refs.filter((x) => x.id !== card.id);
  const tableInputs: string[] = [...INPUT_CARD_KINDS];
  const multipleToggle = (c: { multiple?: boolean; value?: Selection }) => (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={!!c.multiple} onChange={(e) => onChange({ multiple: e.target.checked, value: e.target.checked ? asList(c.value) : (asList(c.value)[0] ?? null) } as Partial<SingleCard>)} />
      Multiselect (the value is an array)
    </label>
  );
  const csv = card.kind === "column_values" || isChartSingleKind(card.kind) || (isObjectSetCardKind(card.kind) && card.kind !== "object_view") || (r?.type === "array" && !r.error);
  let form: React.ReactNode = null;
  switch (card.kind) {
    case "filter_object_set":
    case "set_math":
    case "linked_object_set":
    case "status_filter":
    case "object_view":
    case "defined_by_property":
    case "saved_object_set":
      form = (
        <ObjectCardForm
          card={card}
          r={r}
          refs={others}
          params={params}
          onChange={onChange as (p: Partial<ObjectSetSingleCard>) => void}
          operand={(value, set, placeholder, label) => <Operand value={value} refs={others} params={params} onChange={set} placeholder={placeholder} label={label} />}
        />
      );
      break;
    case "series_agg":
    case "series_op":
    case "regression":
    case "shift_datetime":
    case "series_distribution":
    case "series_scatter":
      form = (
        <SeriesCardForm
          card={card}
          refs={others}
          params={params}
          onChange={onChange as (p: Partial<SeriesSingleCard>) => void}
          operand={(value, set, placeholder, label) => <Operand value={value} refs={others} params={params} onChange={set} placeholder={placeholder} label={label} />}
        />
      );
      break;
    case "numeric_agg": {
      const c = card as NumericAggCard;
      const src = others.find((x) => x.id === c.source.card);
      const fromArray = (ARRAY_CARD_KINDS as readonly string[]).includes(src?.kind ?? "");
      const kind = c.column ? cols[c.column] : undefined;
      const aggs = AGGREGATIONS.filter(([k]) => (kind === "date" ? DATE_AGGREGATIONS.includes(k) : kind === "string" || kind === "boolean" ? k === "count" || k === "unique_count" : true));
      form = (
        <>
          <InputSelect value={c.source.card} refs={others} kinds={[...tableInputs, ...ARRAY_CARD_KINDS]} onChange={(v) => onChange({ source: { card: v } })} />
          <Label text="Aggregation">
            <select value={c.aggregation} onChange={(e) => onChange({ aggregation: e.target.value as NumericAggCard["aggregation"] })} className={`${field} w-full`}>
              {aggs.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          {!fromArray && (
            <Label text={c.aggregation === "count" ? "Column (empty: count rows; a column: count its values)" : "Column"}>
              <ColumnSelect value={c.column ?? ""} cols={cols} onChange={(v) => onChange({ column: v || undefined })} placeholder={c.aggregation === "count" ? "Rows" : "Column…"} />
            </Label>
          )}
          {c.aggregation === "percentile" && (
            <Label text="Percentile (0–100)">
              <input type="number" min={0} max={100} value={c.percentile ?? 50} onChange={(e) => onChange({ percentile: Number(e.target.value) })} className={`${field} w-24`} />
            </Label>
          )}
        </>
      );
      break;
    }
    case "column_values": {
      const c = card as ColumnValuesCard;
      form = (
        <>
          <InputSelect value={c.source.card} refs={others} kinds={tableInputs} onChange={(v) => onChange({ source: { card: v } })} />
          <Label text="Column"><ColumnSelect value={c.column} cols={cols} onChange={(v) => onChange({ column: v })} /></Label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!c.distinct} onChange={(e) => onChange({ distinct: e.target.checked })} />Unique values only</label>
          <Label text="Order">
            <select value={c.sort ?? ""} onChange={(e) => onChange({ sort: e.target.value as ColumnValuesCard["sort"] })} className={`${field} w-full`}>
              <option value="">The table&apos;s order</option>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </Label>
        </>
      );
      break;
    }
    case "numeric_formula":
    case "boolean_formula": {
      const c = card as NumericFormulaCard | BooleanFormulaCard;
      const values = others.filter((x) => (VALUE_CARD_KINDS as readonly string[]).includes(x.kind));
      form = (
        <>
          <textarea rows={3} value={c.formula} onChange={(e) => onChange({ formula: e.target.value })} placeholder={card.kind === "boolean_formula" ? "$N1 > $N2 && contains($L1, \"I10\")" : "($N1 - $N2) / $N2 * 100"} spellCheck={false} className={`${field} w-full font-mono`} aria-label="Formula" />
          <div className="flex flex-wrap gap-1">
            {[...values.map((x) => ({ id: x.id, title: x.title })), ...params.map((p) => ({ id: p, title: "parameter" }))].map((x) => (
              <button key={x.id} type="button" onClick={() => onChange({ formula: `${c.formula}${c.formula && !c.formula.endsWith(" ") ? " " : ""}$${x.id}` })} title={x.title} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-blue-700 hover:bg-panel-2">${x.id}</button>
            ))}
          </div>
        </>
      );
      break;
    }
    case "round": {
      const c = card as RoundCard;
      form = (
        <>
          <Label text="Number"><Operand value={c.input} refs={others} params={params} onChange={(v) => onChange({ input: v })} placeholder="12.7" label="Number" /></Label>
          <div className="flex gap-2">
            <Label text="Rounding">
              <select value={c.mode} onChange={(e) => onChange({ mode: e.target.value as RoundCard["mode"] })} className={field}>
                <option value="floor">Floor (down)</option>
                <option value="ceil">Ceiling (up)</option>
                <option value="round">Round (nearest)</option>
              </select>
            </Label>
            <Label text="Digits">
              <input type="number" min={-12} max={12} value={c.digits ?? 0} onChange={(e) => onChange({ digits: Number(e.target.value) || 0 })} className={`${field} w-16`} />
            </Label>
          </div>
        </>
      );
      break;
    }
    case "date_diff": {
      const c = card as DateDiffCard;
      form = (
        <>
          <Label text="Start"><Operand value={c.start} refs={others} params={params} onChange={(v) => onChange({ start: v })} placeholder="2026-09-01" label="Start" /></Label>
          <Label text="End"><Operand value={c.end} refs={others} params={params} onChange={(v) => onChange({ end: v })} placeholder="2026-09-30T12:00:00Z" label="End" /></Label>
          <Label text="Unit">
            <select value={c.unit} onChange={(e) => onChange({ unit: e.target.value as DateDiffCard["unit"] })} className={`${field} w-full`}>
              {DATE_UNITS.map((u) => <option key={u} value={u}>{u}s</option>)}
            </select>
          </Label>
        </>
      );
      break;
    }
    case "date_part": {
      const c = card as DatePartCard;
      form = (
        <>
          <Label text="Date"><Operand value={c.input} refs={others} params={params} onChange={(v) => onChange({ input: v })} placeholder="2026-09-07" label="Date" /></Label>
          <Label text="Part">
            <select value={c.part} onChange={(e) => onChange({ part: e.target.value as DatePartCard["part"] })} className={`${field} w-full`}>
              {DATE_PARTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
        </>
      );
      break;
    }
    case "correlation": {
      const c = card as CorrelationCard;
      const numeric = Object.keys(cols).filter((k) => cols[k] === "number");
      form = (
        <>
          <InputSelect value={c.source.card} refs={others} kinds={tableInputs} onChange={(v) => onChange({ source: { card: v }, columns: [] })} />
          <Label text="Numeric columns (none chosen: all)">
            <select multiple value={c.columns ?? []} onChange={(e) => onChange({ columns: [...e.target.selectedOptions].map((o) => o.value) })} className={`${field} h-24 w-full`}>
              {numeric.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Label>
          <Label text="Correlation">
            <select value={c.method} onChange={(e) => onChange({ method: e.target.value as CorrelationCard["method"] })} className={`${field} w-full`}>
              <option value="pearson">Pearson (linear)</option>
              <option value="spearman">Spearman (rank)</option>
            </select>
          </Label>
        </>
      );
      break;
    }
    case "waterfall": {
      const c = card as WaterfallCard;
      const fromValues = !c.source.card;
      form = (
        <>
          <select
            value={fromValues ? "__values" : c.source.card}
            onChange={(e) => onChange(e.target.value === "__values" ? { source: { card: "" }, steps: c.steps?.length ? c.steps : [{ label: "Start", input: "" }] } : { source: { card: e.target.value } })}
            className={`${field} w-full`}
            aria-label="Input"
          >
            <option value="__values">Numbers (typed or from value cards)</option>
            {others.filter((x) => tableInputs.includes(x.kind)).map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}
          </select>
          {fromValues ? (
            <div className="space-y-1">
              {(c.steps ?? []).map((s, i) => (
                <div key={i} className="flex items-center gap-1">
                  <input value={s.label} onChange={(e) => onChange({ steps: (c.steps ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="label" className={`${field} w-24`} aria-label="Bucket label" />
                  <div className="min-w-0 flex-1"><Operand value={s.input} refs={others} params={params} onChange={(v) => onChange({ steps: (c.steps ?? []).map((x, j) => (j === i ? { ...x, input: v } : x)) })} placeholder="-1200" label="Bucket value" /></div>
                  <button type="button" onClick={() => onChange({ steps: (c.steps ?? []).filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove bucket">×</button>
                </div>
              ))}
              <button type="button" onClick={() => onChange({ steps: [...(c.steps ?? []), { label: "", input: "" }] })} className="text-blue-700 hover:underline">+ Add bucket</button>
            </div>
          ) : (
            <>
              <Label text="Group by"><ColumnSelect value={c.group_by ?? ""} cols={cols} onChange={(v) => onChange({ group_by: v })} label="Group by" /></Label>
              <div className="flex gap-1">
                <select value={c.metric ?? "count"} onChange={(e) => onChange({ metric: e.target.value as WaterfallCard["metric"] })} className={`${field} flex-1`} aria-label="Metric">
                  {WATERFALL_METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                {(c.metric ?? "count") !== "count" && (
                  <div className="min-w-0 flex-1"><ColumnSelect value={c.measure ?? ""} cols={cols} only={c.metric === "unique_count" ? undefined : ["number"]} onChange={(v) => onChange({ measure: v })} placeholder="Measure…" label="Measure" /></div>
                )}
              </div>
              <div className="flex gap-1">
                <select value={c.sort ?? ""} onChange={(e) => onChange({ sort: e.target.value as WaterfallCard["sort"] })} className={`${field} flex-1`} aria-label="Order">
                  <option value="">Largest first</option>
                  <option value="value_asc">Smallest first</option>
                  <option value="key">By group</option>
                </select>
                <input type="number" min={1} max={50} value={c.limit ?? 20} onChange={(e) => onChange({ limit: Math.max(1, Math.min(50, Number(e.target.value) || 20)) })} className={`${field} w-16`} title="Buckets (at most 50)" aria-label="Buckets" />
              </div>
            </>
          )}
          <div className="flex items-center gap-1.5">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.total !== false} onChange={(e) => onChange({ total: e.target.checked })} />Compute total</label>
            {c.total !== false && <input value={c.total_label ?? ""} onChange={(e) => onChange({ total_label: e.target.value || undefined })} placeholder="Total" className={`${field} min-w-0 flex-1`} aria-label="Total label" />}
          </div>
        </>
      );
      break;
    }
    case "string_op": {
      const c = card as StringOpCard;
      const text = (k: keyof StringOpCard, label: string, placeholder: string) => (
        <Label text={label}><Operand value={String(c[k] ?? "")} refs={others} params={params} onChange={(v) => onChange({ [k]: v } as Partial<StringOpCard>)} placeholder={placeholder} label={label} /></Label>
      );
      const plain = (k: keyof StringOpCard, label: string, placeholder: string, mono = true) => (
        <Label text={label}><input value={String(c[k] ?? "")} onChange={(e) => onChange({ [k]: e.target.value } as Partial<StringOpCard>)} placeholder={placeholder} className={`${field} w-full ${mono ? "font-mono" : ""}`} aria-label={label} spellCheck={false} /></Label>
      );
      const list = (k: "true_values" | "false_values", label: string) => (
        <Label text={label}><input value={(c[k] ?? []).join(", ")} onChange={(e) => onChange({ [k]: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="ya, y, 1" className={`${field} w-full`} aria-label={label} /></Label>
      );
      form = (
        <>
          <Label text="Operation">
            <select value={c.op} onChange={(e) => onChange({ op: e.target.value as StringOpCard["op"], ...retitle(c.title, STRING_OPS, c.op, e.target.value) })} className={`${field} w-full`}>
              {STRING_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          {text("input", c.op === "date_to_string" ? "Date" : "String", c.op === "date_to_string" ? "2026-09-07" : "text")}
          {c.op === "concatenate" && <>{text("input2", "Second string", "text")}{text("delimiter", "Delimiter (optional)", " - ")}</>}
          {c.op === "substring" && (
            <div className="flex gap-2">
              <div className="flex-1">{text("start", "Start (0 first)", "0")}</div>
              <div className="flex-1">{text("length", "Length (empty: to the end)", "3")}</div>
            </div>
          )}
          {c.op === "find_replace" && (
            <>
              {text("find", c.regex ? "Find (pattern)" : "Find", c.regex ? "(\\d+)" : "text")}
              {text("replace", "Replace with", c.regex ? "<\\1>" : "")}
              <div className="flex gap-3">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!c.regex} onChange={(e) => onChange({ regex: e.target.checked })} />Regex</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!c.ignore_case} onChange={(e) => onChange({ ignore_case: e.target.checked })} />Ignore case</label>
              </div>
            </>
          )}
          {c.op === "regex_extract" && (
            <>
              {plain("pattern", "Pattern", "([A-Z])(\\d+)")}
              <div className="flex items-end gap-3">
                <Label text="Group (0: whole match)"><input type="number" min={0} max={99} value={c.group ?? 0} onChange={(e) => onChange({ group: Math.max(0, Number(e.target.value) || 0) })} className={`${field} w-20`} /></Label>
                <label className="flex items-center gap-1.5 pb-1"><input type="checkbox" checked={!!c.ignore_case} onChange={(e) => onChange({ ignore_case: e.target.checked })} />Ignore case</label>
              </div>
            </>
          )}
          {c.op === "split" && (
            <>
              {text("delimiter", "Delimiter", ",")}
              <div className="flex gap-3">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.trim !== false} onChange={(e) => onChange({ trim: e.target.checked })} />Trim parts</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!c.drop_empty} onChange={(e) => onChange({ drop_empty: e.target.checked })} />Leave out empty parts</label>
              </div>
            </>
          )}
          {c.op === "to_boolean" && (
            <>
              {list("true_values", "Also true (comma-separated)")}
              {list("false_values", "Also false (comma-separated)")}
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!c.default} onChange={(e) => onChange({ default: e.target.checked })} />Other strings are true</label>
            </>
          )}
          {c.op === "date_to_string" && plain("format", "Format (empty: ISO)", "DD MMM YYYY HH:mm")}
        </>
      );
      break;
    }
    case "comparison": {
      const c = card as ComparisonCard;
      const group = COMPARISONS.find((x) => x[0] === c.op)?.[2] ?? "number";
      const ph = group === "date" ? "2026-09-07" : group === "number" ? "100" : "text";
      form = (
        <>
          <Label text="Comparison">
            <select value={c.op} onChange={(e) => onChange({ op: e.target.value as ComparisonCard["op"], ...retitle(c.title, COMPARISONS, c.op, e.target.value) })} className={`${field} w-full`}>
              {(["number", "string", "date"] as const).map((g) => (
                <optgroup key={g} label={{ number: "Numbers", string: "Strings and Booleans", date: "Dates / times" }[g]}>
                  {COMPARISONS.filter((x) => x[2] === g).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </optgroup>
              ))}
            </select>
          </Label>
          <Label text="Input"><Operand value={c.left} refs={others} params={params} onChange={(v) => onChange({ left: v })} placeholder={ph} label="Input" /></Label>
          <Label text={c.op === "between" ? "From" : "Compared with"}><Operand value={c.right} refs={others} params={params} onChange={(v) => onChange({ right: v })} placeholder={ph} label="Compared with" /></Label>
          {c.op === "between" && <Label text="To"><Operand value={c.right2 ?? ""} refs={others} params={params} onChange={(v) => onChange({ right2: v })} placeholder="2026-09-30" label="To" /></Label>}
          {group === "string" && (
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!c.ignore_case} onChange={(e) => onChange({ ignore_case: e.target.checked })} />Ignore case</label>
              {(c.op === "contains" || c.op === "not_contains") && (
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.whole_words ?? c.op === "contains"} onChange={(e) => onChange({ whole_words: e.target.checked })} />Whole words</label>
              )}
            </div>
          )}
        </>
      );
      break;
    }
    case "create_array": {
      const c = card as CreateArrayCard;
      form = (
        <>
          <OperandList items={c.items} refs={others} params={params} onChange={(items) => onChange({ items })} placeholder="value" label="Value" />
          <Label text="Element type">
            <select value={c.element_type ?? "auto"} onChange={(e) => onChange({ element_type: e.target.value as CreateArrayCard["element_type"] })} className={`${field} w-full`}>
              {ARRAY_ELEMENT_TYPES.map((t) => <option key={t} value={t}>{t === "auto" ? "Auto (from the values)" : t}</option>)}
            </select>
          </Label>
        </>
      );
      break;
    }
    case "stepped_array": {
      const c = card as SteppedArrayCard;
      form = (
        <>
          <Label text="Start"><Operand value={c.start} refs={others} params={params} onChange={(v) => onChange({ start: v })} placeholder="0" label="Start" /></Label>
          <Label text="End"><Operand value={c.end} refs={others} params={params} onChange={(v) => onChange({ end: v })} placeholder="100" label="End" /></Label>
          <Label text="Step"><Operand value={c.step} refs={others} params={params} onChange={(v) => onChange({ step: v })} placeholder="10" label="Step" /></Label>
        </>
      );
      break;
    }
    case "array_op": {
      const c = card as ArrayOpCard;
      form = (
        <>
          <Label text="Operation">
            <select value={c.op} onChange={(e) => onChange({ op: e.target.value as ArrayOpCard["op"], ...retitle(c.title, ARRAY_OPS, c.op, e.target.value) })} className={`${field} w-full`}>
              {ARRAY_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          <Label text="Array"><ArrayInput value={c.input} refs={others} onChange={(v) => onChange({ input: v })} /></Label>
          {c.op === "at" && <Label text="Index (0 first, -1 last)"><Operand value={c.index ?? ""} refs={others} params={params} onChange={(v) => onChange({ index: v })} placeholder="0" label="Index" /></Label>}
          {c.op === "contains" && <Label text="Value"><Operand value={c.value ?? ""} refs={others} params={params} onChange={(v) => onChange({ value: v })} placeholder="I10" label="Value" /></Label>}
          {c.op === "join" && <Label text="Delimiter"><Operand value={c.delimiter ?? ", "} refs={others} params={params} onChange={(v) => onChange({ delimiter: v })} placeholder=", " label="Delimiter" /></Label>}
          {c.op === "sort" && (
            <Label text="Order">
              <select value={c.order ?? "asc"} onChange={(e) => onChange({ order: e.target.value as ArrayOpCard["order"] })} className={`${field} w-full`}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </Label>
          )}
        </>
      );
      break;
    }
    case "coalesce": {
      const c = card as CoalesceCard;
      form = <OperandList items={c.inputs} refs={others} params={params} onChange={(inputs) => onChange({ inputs })} placeholder="fallback" label="Input" />;
      break;
    }
    case "range": {
      const c = card as RangeCard;
      form = (
        <>
          <Label text="Start"><Operand value={c.start} refs={others} params={params} onChange={(v) => onChange({ start: v })} placeholder="0 or 2026-09-01" label="Start" /></Label>
          <Label text="End"><Operand value={c.end} refs={others} params={params} onChange={(v) => onChange({ end: v })} placeholder="100 or 2026-09-30" label="End" /></Label>
          <Label text="Range of">
            <select value={c.range_type ?? "auto"} onChange={(e) => onChange({ range_type: e.target.value as RangeCard["range_type"] })} className={`${field} w-full`}>
              {RANGE_TYPES.map((t) => <option key={t} value={t}>{{ auto: "Auto (from the values)", number: "Numbers", date: "Dates / times" }[t]}</option>)}
            </select>
          </Label>
        </>
      );
      break;
    }
    case "range_op": {
      const c = card as RangeOpCard;
      form = (
        <>
          <Label text="Operation">
            <select value={c.op} onChange={(e) => onChange({ op: e.target.value as RangeOpCard["op"], ...retitle(c.title, RANGE_OPS, c.op, e.target.value) })} className={`${field} w-full`}>
              {RANGE_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          <Label text="Range"><RangeInput value={c.input} refs={others} params={params} onChange={(v) => onChange({ input: v })} /></Label>
        </>
      );
      break;
    }
    case "string_selector": {
      const c = card as StringSelectorCard;
      const srcId = c.source.card;
      const src = others.find((x) => x.id === srcId);
      const fromTable = !!src && tableInputs.includes(src.kind);
      form = (
        <>
          <Label text="Options">
            <select value={srcId} onChange={(e) => onChange({ source: { card: e.target.value }, column: undefined, value: c.multiple ? [] : null } as Partial<StringSelectorCard>)} className={`${field} w-full`} aria-label="Options from">
              <option value="">Typed options</option>
              {srcId && !src && <option value={srcId}>${srcId}</option>}
              {others.filter((x) => tableInputs.includes(x.kind) || (ARRAY_CARD_KINDS as readonly string[]).includes(x.kind)).map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}
            </select>
          </Label>
          {!srcId && (
            <Label text="One option per line">
              <textarea rows={4} value={(c.options ?? []).join("\n")} onChange={(e) => onChange({ options: e.target.value.split("\n") } as Partial<StringSelectorCard>)} onBlur={() => onChange({ options: (c.options ?? []).map((x) => x.trim()).filter(Boolean) } as Partial<StringSelectorCard>)} placeholder={"RS Umum\nRS Khusus\nKlinik"} className={`${field} w-full`} aria-label="Options" />
            </Label>
          )}
          {fromTable && <Label text="Column (its distinct values)"><ColumnSelect value={c.column ?? ""} cols={cols} onChange={(v) => onChange({ column: v, value: c.multiple ? [] : null } as Partial<StringSelectorCard>)} /></Label>}
          {multipleToggle(c)}
        </>
      );
      break;
    }
    case "property_select": {
      const c = card as PropertySelectCard;
      form = (
        <>
          <InputSelect value={c.source.card} refs={others} kinds={["object_set", "object_selector"]} onChange={(v) => onChange({ source: { card: v }, value: c.multiple ? [] : null } as Partial<PropertySelectCard>)} />
          <Label text="Property"><ColumnSelect value={c.property} cols={cols} onChange={(v) => onChange({ property: v, value: c.multiple ? [] : null } as Partial<PropertySelectCard>)} label="Property" placeholder="Property…" /></Label>
          {multipleToggle(c)}
        </>
      );
      break;
    }
    case "object_selector": {
      const c = card as ObjectSelectorCard;
      form = (
        <>
          <InputSelect value={c.source.card} refs={others} kinds={tableInputs} onChange={(v) => onChange({ source: { card: v }, value: c.multiple ? [] : null } as Partial<ObjectSelectorCard>)} />
          <Label text="Shown as"><ColumnSelect value={c.label ?? ""} cols={cols} onChange={(v) => onChange({ label: v || undefined } as Partial<ObjectSelectorCard>)} label="Label column" placeholder="The title property" /></Label>
          {multipleToggle(c)}
        </>
      );
      break;
    }
    case "row_selector": {
      const c = card as RowSelectorCard;
      form = (
        <>
          <InputSelect value={c.source.card} refs={others} kinds={tableInputs} onChange={(v) => onChange({ source: { card: v }, key: undefined, label: undefined, value: null } as Partial<RowSelectorCard>)} />
          <Label text="Select rows by"><ColumnSelect value={c.key ?? ""} cols={cols} onChange={(v) => onChange({ key: v || undefined, value: null } as Partial<RowSelectorCard>)} label="Key column" placeholder="Row index (0 first)" /></Label>
          <Label text="Shown as"><ColumnSelect value={c.label ?? ""} cols={cols} onChange={(v) => onChange({ label: v || undefined } as Partial<RowSelectorCard>)} label="Label column" placeholder={c.key ? "The key" : "row number"} /></Label>
        </>
      );
      break;
    }
    case "date_convert": {
      const c = card as DateConvertCard;
      form = (
        <>
          <Label text="Conversion">
            <select value={c.op} onChange={(e) => onChange({ op: e.target.value as DateConvertCard["op"], ...retitle(c.title, DATE_CONVERSIONS, c.op, e.target.value) } as Partial<DateConvertCard>)} className={`${field} w-full`}>
              {DATE_CONVERSIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          <Label text={c.op === "number_to_date" ? "Number" : "String"}><Operand value={c.input} refs={others} params={params} onChange={(v) => onChange({ input: v } as Partial<DateConvertCard>)} placeholder={c.op === "number_to_date" ? "1757203200000" : "07/09/2026"} label={c.op === "number_to_date" ? "Number" : "String"} /></Label>
          {c.op === "number_to_date" ? (
            <Label text="The number counts">
              <select value={c.unit ?? "milliseconds"} onChange={(e) => onChange({ unit: e.target.value as DateConvertCard["unit"] } as Partial<DateConvertCard>)} className={`${field} w-full`}>
                {NUMBER_DATE_UNITS.map((u) => <option key={u} value={u}>{u} since 1970-01-01 (UTC)</option>)}
              </select>
            </Label>
          ) : (
            <div className="flex gap-2">
              <div className="flex-1"><Label text="Format (empty: ISO or MM/DD/YYYY)"><input value={c.format ?? ""} onChange={(e) => onChange({ format: e.target.value || undefined } as Partial<DateConvertCard>)} placeholder="DD/MM/YYYY HH:mm" spellCheck={false} className={`${field} w-full font-mono`} aria-label="Format" /></Label></div>
              <div className="w-28"><Label text="Time zone"><input value={c.timezone ?? ""} onChange={(e) => onChange({ timezone: e.target.value || undefined } as Partial<DateConvertCard>)} placeholder="UTC" spellCheck={false} className={`${field} w-full font-mono`} aria-label="Time zone" title="UTC, an offset such as +07:00, or a name such as Asia/Jakarta" /></Label></div>
            </div>
          )}
        </>
      );
      break;
    }
    case "period_to_date": {
      const c = card as PeriodToDateCard;
      form = (
        <>
          <Label text="Period">
            <select value={c.period} onChange={(e) => onChange({ period: e.target.value as PeriodToDateCard["period"], ...retitle(c.title, PERIODS, c.period, e.target.value) } as Partial<PeriodToDateCard>)} className={`${field} w-full`}>
              {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          <Label text="Date (empty: now)"><Operand value={c.input ?? ""} refs={others} params={params} onChange={(v) => onChange({ input: v || undefined } as Partial<PeriodToDateCard>)} placeholder="now" label="Date" /></Label>
          {c.period === "week" && (
            <Label text="Weeks start on">
              <select value={c.week_start ?? "monday"} onChange={(e) => onChange({ week_start: e.target.value as PeriodToDateCard["week_start"] } as Partial<PeriodToDateCard>)} className={`${field} w-full`}>
                <option value="monday">Monday</option>
                <option value="sunday">Sunday</option>
              </select>
            </Label>
          )}
        </>
      );
      break;
    }
    case "object_property": {
      const c = card as ObjectPropertyCard;
      form = (
        <>
          <InputSelect value={c.source.card} refs={others} kinds={tableInputs} onChange={(v) => onChange({ source: { card: v } } as Partial<ObjectPropertyCard>)} />
          <Label text="Property"><ColumnSelect value={c.property} cols={cols} onChange={(v) => onChange({ property: v } as Partial<ObjectPropertyCard>)} label="Property" placeholder="Property…" /></Label>
        </>
      );
      break;
    }
    case "multipass_attribute": {
      const c = card as MultipassAttributeCard;
      const custom = c.attribute.startsWith("attribute:");
      const label = (k: string) => MULTIPASS_ATTRIBUTES.find((x) => x[0] === k)?.[1];
      form = (
        <>
          <Label text="Attribute">
            <select
              value={custom ? "__custom" : c.attribute}
              onChange={(e) => {
                const v = e.target.value === "__custom" ? "attribute:" : e.target.value;
                onChange({ attribute: v, ...(c.title === (label(c.attribute) ?? "Custom attribute") ? { title: label(v) ?? "Custom attribute" } : {}) } as Partial<MultipassAttributeCard>);
              }}
              className={`${field} w-full`}
            >
              {MULTIPASS_ATTRIBUTES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              <option value="__custom">Custom attribute…</option>
            </select>
          </Label>
          {custom && <Label text="Custom attribute name"><input value={c.attribute.slice("attribute:".length)} onChange={(e) => onChange({ attribute: `attribute:${e.target.value}` } as Partial<MultipassAttributeCard>)} placeholder="region" spellCheck={false} className={`${field} w-full font-mono`} aria-label="Custom attribute name" /></Label>}
          {["id", "username", "display_name"].includes(c.attribute) && (
            <Label text="Of the user whose ID is (empty: the current user)"><Operand value={c.user ?? ""} refs={others} params={params} onChange={(v) => onChange({ user: v || undefined } as Partial<MultipassAttributeCard>)} placeholder="the current user" label="User ID" /></Label>
          )}
        </>
      );
      break;
    }
    case "xy_range": {
      const c = card as XyRangeCard;
      const axis = (a: "x" | "y") => (
        <div className="space-y-1 rounded border border-line p-1.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase text-muted">{a} range</span>
            <select value={c[`${a}_type`] ?? "auto"} onChange={(e) => onChange({ [`${a}_type`]: e.target.value } as Partial<XyRangeCard>)} className={`${field} ml-auto`} aria-label={`${a.toUpperCase()} range type`}>
              {XY_RANGE_TYPES.map((t) => <option key={t} value={t}>{{ auto: "Auto", number: "Numbers", date: "Dates / times", string: "Strings (ordinal)" }[t]}</option>)}
            </select>
          </div>
          <Operand value={c[`${a}_start`]} refs={others} params={params} onChange={(v) => onChange({ [`${a}_start`]: v } as Partial<XyRangeCard>)} placeholder="start" label={`${a.toUpperCase()} start`} />
          <Operand value={c[`${a}_end`]} refs={others} params={params} onChange={(v) => onChange({ [`${a}_end`]: v } as Partial<XyRangeCard>)} placeholder="end" label={`${a.toUpperCase()} end`} />
        </div>
      );
      form = <>{axis("x")}{axis("y")}</>;
      break;
    }
  }
  return (
    <div className="grid gap-3 p-3 text-[11px] lg:grid-cols-[minmax(15rem,20rem)_1fr]">
      <div className="space-y-2">
        {form}
        <p className="text-[10px] text-muted">{DESCRIPTION[card.kind]}</p>
      </div>
      <div className="min-w-0 rounded border border-line bg-panel p-3">
        {csv && (
          <div className="mb-1 flex flex-wrap items-center justify-end gap-3">
            {isObjectSetCardKind(card.kind) && <SaveObjectList aid={aid} cardId={card.id} title={card.title} />}
            <a href={quiverTables.csvUrl(aid, card.id)} className="text-[10px] text-blue-700 hover:underline" title="The saved card's data">Export CSV</a>
          </div>
        )}
        {isSelectorCard(card) && <div className="mb-1 text-[10px] text-muted">{card.kind === "row_selector" ? "Selected row (the default)" : "Selection (the default)"}</div>}
        <SingleCardView card={card} r={r} onSelect={isSelectorCard(card) ? (v) => onChange({ value: v } as Partial<SingleCard>) : undefined} />
      </div>
    </div>
  );
}

/** A new single card with the first sensible input (`series`: the analysis' time series cards, for the time series cards). */
export function newSingleCard(kind: SingleCard["kind"], id: string, input?: { id: string; kind: string }, series: string[] = []): SingleCard {
  const src = input?.id ?? "";
  switch (kind) {
    case "series_agg":
    case "series_op":
    case "regression":
    case "shift_datetime":
    case "series_distribution":
    case "series_scatter":
      return newSeriesCard(kind, id, series);
    case "filter_object_set":
    case "set_math":
    case "linked_object_set":
    case "status_filter":
    case "object_view":
    case "defined_by_property":
    case "saved_object_set":
      return newObjectCard(kind, id, input);
    case "numeric_agg": return { id, kind, title: "Numeric aggregation", source: { card: src }, aggregation: "count" };
    case "column_values": return { id, kind, title: "Column values", source: { card: src }, column: "", distinct: true, sort: "asc" };
    case "numeric_formula": return { id, kind, title: "Numeric formula", formula: "" };
    case "round": return { id, kind, title: "Floor", mode: "floor", input: "" };
    case "date_diff": return { id, kind, title: "Date difference", start: "", end: "", unit: "day" };
    case "date_part": return { id, kind, title: "Day of week", input: "", part: "day_of_week" };
    case "correlation": return { id, kind, title: "Correlation matrix", source: { card: src }, columns: [], method: "pearson" };
    case "waterfall": return { id, kind, title: "Waterfall plot", source: { card: src }, metric: "count", total: true, steps: src ? undefined : [{ label: "Start", input: "" }] };
    case "string_op": return { id, kind, title: "To upper case", op: "upper", input: "" };
    case "comparison": return { id, kind, title: "Greater than", op: "gt", left: "", right: "" };
    case "boolean_formula": return { id, kind, title: "Boolean formula", formula: "" };
    case "create_array": return { id, kind, title: "Create array", items: ["", ""], element_type: "auto" };
    case "stepped_array": return { id, kind, title: "Stepped array", start: "0", end: "10", step: "1" };
    case "array_op": return { id, kind, title: "Array length", op: "length", input: "" };
    case "coalesce": return { id, kind, title: "Coalesce", inputs: ["", ""] };
    case "range": return { id, kind, title: "Range", start: "", end: "", range_type: "auto" };
    case "range_op": return { id, kind, title: "Range start", op: "start", input: "" };
    case "string_selector": return input ? { id, kind, title: "String selector", source: { card: src }, column: "", value: null } : { id, kind, title: "String selector", source: { card: "" }, options: ["A", "B", "C"], value: "A" };
    case "property_select": return { id, kind, title: "Property value select", source: { card: input?.kind === "object_set" ? src : "" }, property: "", value: null };
    case "object_selector": return { id, kind, title: "Object selector", source: { card: src }, value: null };
    case "row_selector": return { id, kind, title: "Row selector", source: { card: input?.kind === "table" ? src : "" }, value: 0 };
    case "date_convert": return { id, kind, title: "String to date", op: "string_to_date", input: "" };
    case "period_to_date": return { id, kind, title: "Month to date", period: "month" };
    case "object_property": return { id, kind, title: "Object property", source: { card: "" }, property: "" };
    case "multipass_attribute": return { id, kind, title: "Username", attribute: "username" };
    case "xy_range": return { id, kind, title: "X/Y range", x_start: "", x_end: "", y_start: "", y_end: "", x_type: "auto", y_type: "auto" };
  }
}
