"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { BASEMAPS, MapCanvas, type Basemap, type MapHandle, type Projection } from "@/components/map/MapCanvas";
import { Field } from "@/components/ontology/parts";
import { TypeIcon } from "@/components/ontology/Datasources";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import {
  filterSets,
  fmt,
  resolveVar,
  ruleFor,
  sourceKey,
  workshop,
  type Column,
  type Filter,
  type FormatRule,
  type GanttLayer,
  type MapLayer,
  type OsFilter,
  type TimelineLayer,
  type Module,
  type QueryBody,
  type QueryResult,
  type SourceRef,
  type Sources,
  type Step,
  type VegaInput,
  type Widget,
  type WidgetConfig,
} from "@/lib/workshop";
import { useSize } from "./Charts";
import type { ModuleState } from "./WidgetView";
import { timed } from "@/lib/workshopProfiler";
import { dragObjectSet } from "./CrossApp";
import { EventsEditor } from "./WorkshopConfig";
import { VegaAipGenerator } from "./VegaAip";
import { buildColorScale, CATEGORY_PALETTE, type ColorLegend } from "@/components/map/vectorTileStyle";
import { geoApi, type Feature as GeoFeature } from "@/lib/geo";
import {
  HoverCard,
  MapLegend,
  MapOverlaysConfig,
  MapTemplateConfig,
  ObjectLayer,
  OverlayImages,
  OverlayShapes,
  OverlayTiles,
  PickCard,
  ShapeFrame,
  useOverlayData,
  useOverlays,
  type LayerStyle,
  type LegendRow,
  type MapItem,
  type OverlayPick,
} from "./MapShapes";
import { boundsOf, colorBins, frameOf, parseShape, pickShape, prepare, preparePoint, shapeInBox, type Bin, type Prepared } from "./mapGeometry";
import { DrawnShapes, LassoLayer, MapInteractionsConfig, MapTimeline, MapToolbar, ShapeEditor, Sketch, type MapTool } from "./MapInteractions";
import {
  distToDrawn,
  drawnGeometry,
  inWindow,
  latestWindow,
  lonLatOf,
  playStep,
  selPolygon,
  shapeInPolygon,
  shapesFromString,
  shapesToString,
  shapeToString,
  timeExtent,
  timeForVariable,
  timeOf,
  viewBbox,
  type DrawnShape,
  type TimeWindow,
} from "./mapTools";

const NO_ITEMS: MapItem[] = [];
const NO_SELECTION = new Set<string>();

// ------------------------------------------------------------------------------------------------
// data: the same query path as the other widgets (filters with $var:, other widgets' filters, module derived properties)
// ------------------------------------------------------------------------------------------------

function queryFor(source: SourceRef, filters: Filter[] | undefined, state: ModuleState, body: Partial<QueryBody> & { filter_variables?: string[] }): QueryBody {
  const key = sourceKey(source);
  return {
    source,
    filters: (filters ?? []).map((f) => ({ ...f, value: resolveVar(f.value, state.variables) })),
    additional_filters: Object.entries(state.filters[key] ?? {})
      .filter(([col, v]) => !col.startsWith("__") && v !== undefined && v !== "")
      .map(([column, value]) => ({ column, op: "eq" as const, value })),
    filter_sets: filterSets(body as { filter_variables?: string[] }, state.variables),
    derived: (state.derived ?? [])
      .filter((d) => source.kind === "object_type" && d.object_type_id === source.id && d.name && d.column)
      .map((d) => ({ name: d.name, op: d.op, column: d.column, other_column: d.other_column, value: d.value })),
    limit: 2000,
    ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== "filter_variables")),
  };
}

/** Several queries at once (one per layer or data input); reruns when any input, filter or the module version changes. */
function useQueries(queries: (QueryBody | null)[], state: ModuleState, who?: Widget) {
  const [out, setOut] = useState<{ results: (QueryResult | null)[]; error: string | null }>({ results: [], error: null });
  // scenarios [Legacy]: "Load data from scenario" reads every layer / input as it is in the scenario
  const sv = who?.config.scenario_variable;
  const scenarioId = sv ? String(state.variables[sv] ?? "") || undefined : undefined;
  const key = JSON.stringify([queries, state.version, scenarioId]);
  useEffect(() => {
    let stale = false;
    const all = Promise.all(queries.map((q) => (q ? workshop.query(scenarioId ? { ...q, scenario_id: scenarioId } : q) : Promise.resolve(null))));
    (who ? timed("widget", who.id, who.title || who.type, who.parent ?? "", all) : all)
      .then((results) => !stale && setOut({ results, error: null }))
      .catch((e: Error) => !stale && setOut((o) => ({ ...o, error: e.message })));
    return () => {
      stale = true;
    };
    // key holds the queries and the version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return out;
}

const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
const toMs = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
};
const day = 86_400_000;
const when = (ms: number, withTime = false) =>
  new Date(ms).toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
function span(ms: number): string {
  const a = Math.abs(ms);
  if (a < 3_600_000) return `${Math.round(a / 60_000)} min`;
  if (a < day) return `${Math.round(a / 3_600_000)} h`;
  if (a < 60 * day) return `${Math.round(a / day)} d`;
  return `${Math.round(a / (30 * day))} mo`;
}
const Msg = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted">{children}</div>;

function selectRow(widget: Widget, state: ModuleState, source: SourceRef | undefined, pk: string | undefined) {
  if (!source || !pk) return;
  const key = sourceKey(source);
  const on = state.selection[key] === pk;
  state.select(key, on ? undefined : pk);
  if (!on && widget.config.on_select?.length) void state.runEvents?.(widget.config.on_select);
}

let sourcesOnce: Promise<Sources> | null = null;
const allSources = () => (sourcesOnce ??= workshop.sources());

// ------------------------------------------------------------------------------------------------
// Object Set Title
// ------------------------------------------------------------------------------------------------

export function ObjectSetTitleWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const [typeName, setTypeName] = useState<string>("");
  useEffect(() => {
    if (!c.source) return;
    allSources().then((s) => setTypeName((c.source?.kind === "object_type" ? s.object_types : c.source?.kind === "dataset" ? s.datasets : s.interfaces ?? []).find((x) => x.id === c.source?.id)?.name ?? ""), () => {});
  }, [c.source]);
  const fv = c.filter_variables?.length ? { filter_variables: c.filter_variables } : {};
  const q = c.source ? queryFor(c.source, c.filters, state, c.single_object ? { columns: uniq([c.label_column]), limit: 5000, ...fv } : { limit: 0, metric: "count", ...fv }) : null;
  const { results, error } = useQueries([q], state, widget);
  const r = results[0];
  if (!c.source) return <Msg>Choose the object set (a source) in the panel</Msg>;
  if (error) return <Msg>{error}</Msg>;
  if (!r) return <Msg>Loading…</Msg>;
  if (!r.total && !c.render_empty) return null;
  let title: string;
  if (c.single_object) {
    const sel = state.selection[sourceKey(c.source)];
    const row = (r.rows ?? []).find((x) => x.__pk === sel) ?? (r.total === 1 ? r.rows?.[0] : undefined);
    title = row ? String((c.label_column ? row[c.label_column] : undefined) ?? row.__pk ?? "") : r.total ? `${r.total.toLocaleString()} objects — select one` : "No object";
  } else title = c.title_override ? c.title_override.replace(/\{\{\s*count\s*\}\}/g, r.total.toLocaleString()) : `${typeName || "Objects"} · ${r.total.toLocaleString()}`;
  return (
    <div
      className={`flex h-full items-center gap-2 px-3 ${c.enable_drag ? "cursor-grab" : ""}`}
      draggable={!!c.enable_drag && !!c.source}
      onDragStart={(e) => {
        if (!c.source) return;
        // the set as the title counts it: the widget's filters, the module's filters on the source and the filter
        // variables (a ranked or "any" set travels as its keys / is left out)
        const qq = queryFor(c.source, c.filters, state, { ...fv });
        const sets = (qq.filter_sets ?? []).flatMap((s) => (s.order ? [{ column: "__pk", op: "in" as const, value: s.order }] : (s.mode ?? "all") === "all" && !s.keyword ? s.filters : []));
        dragObjectSet(e, c.source, [...(qq.filters ?? []), ...(qq.additional_filters ?? []), ...sets]);
      }}
      data-object-set-title
    >
      {c.show_icon !== false && <Icon name="cube" className="h-5 w-5 shrink-0 text-ocean" />}
      <span className="truncate text-lg font-semibold">{title}</span>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Vega Chart
// ------------------------------------------------------------------------------------------------

function vegaTheme(): Record<string, unknown> {
  const css = typeof window === "undefined" ? null : getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => css?.getPropertyValue(n).trim() || d;
  const text = v("--color-soft", "#8b949e");
  const grid = v("--color-line", "#30363d");
  return {
    background: "transparent",
    font: "inherit",
    axis: { labelColor: text, titleColor: text, gridColor: grid, domainColor: grid, tickColor: grid },
    legend: { labelColor: text, titleColor: text },
    title: { color: text },
    view: { stroke: "transparent" },
    range: { category: ["#1f6feb", "#f0883e", "#3fb950", "#a371f7", "#db61a2", "#e3b341", "#39c5cf", "#8b949e"] },
  };
}

/** The complete spec: the data inputs injected by name, the theme merged into its config. */
export function vegaSpec(c: WidgetConfig, specText: string, data: Record<string, unknown[]>): Record<string, unknown> {
  const spec = JSON.parse(specText || "{}") as Record<string, unknown>;
  const names = Object.keys(data);
  if ((c.vega_mode ?? "vega-lite") === "vega-lite") {
    spec.datasets = { ...(spec.datasets as object), ...data };
    if (!spec.data && names.length && !spec.layer && !spec.vconcat && !spec.hconcat) spec.data = { name: names[0] };
  } else {
    const list = Array.isArray(spec.data) ? [...(spec.data as Record<string, unknown>[])] : [];
    for (const n of names) {
      const i = list.findIndex((d) => d.name === n);
      if (i >= 0) {
        const { url: _u, ...rest } = list[i];
        void _u;
        list[i] = { ...rest, values: data[n] };
      } else list.unshift({ name: n, values: data[n] });
    }
    spec.data = list;
  }
  if ((c.vega_theme ?? "default") === "default") spec.config = { ...vegaTheme(), ...(spec.config as object) };
  if (!spec.$schema) spec.$schema = (c.vega_mode ?? "vega-lite") === "vega-lite" ? "https://vega.github.io/schema/vega-lite/v5.json" : "https://vega.github.io/schema/vega/v5.json";
  return spec;
}

/** A selection parameter's type in the spec (top level, layers, concatenations): point or interval. */
export function vegaParamType(spec: unknown, name: string): "point" | "interval" | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, unknown>;
  for (const p of Array.isArray(s.params) ? (s.params as Record<string, unknown>[]) : []) {
    if (p?.name !== name || !p.select) continue;
    const t = typeof p.select === "string" ? p.select : (p.select as { type?: string }).type;
    return t === "interval" ? "interval" : "point";
  }
  for (const k of ["layer", "vconcat", "hconcat", "concat", "spec"]) {
    const sub = s[k];
    for (const x of Array.isArray(sub) ? sub : sub ? [sub] : []) {
      const t = vegaParamType(x, name);
      if (t) return t;
    }
  }
  return null;
}

const nextBucket = (key: string, bucket: "day" | "month" | "year"): string => {
  const [y, m = 1, d = 1] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (bucket === "day") t.setUTCDate(t.getUTCDate() + 1);
  else if (bucket === "month") t.setUTCMonth(t.getUTCMonth() + 1);
  else t.setUTCFullYear(t.getUTCFullYear() + 1);
  return t.toISOString().slice(0, 10);
};
const bucketStart = (key: string) => (key.length === 4 ? `${key}-01-01` : key.length === 7 ? `${key}-01` : key.slice(0, 10));

/**
 * A Vega-Lite selection as an object set filter on the widget's source. A selection's value maps each field to its
 * values (point) or its [low, high] ends (interval); a field is a property when it is an objects input's column (or
 * __pk) or an aggregation's group by. Point → "is any of", interval → a range; an aggregation bucketed by day / month /
 * year → the range from the first bucket's start to the last one's end. Fields that are not properties (a measure, an
 * internal id) are listed in unmapped.
 */
export function vegaSelectionFilter(value: unknown, type: "point" | "interval", inputs: VegaInput[], colTypes: Record<string, string>): { filter: OsFilter; unmapped: string[] } {
  const filters: Filter[] = [];
  const unmapped: string[] = [];
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  for (const [field, raw] of Object.entries(o)) {
    if (field === "vlPoint" || field === "vlMulti" || field === "_vgsid_") {
      if (field === "_vgsid_") unmapped.push(field);
      continue;
    }
    const vals = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== undefined);
    const agg = inputs.find((i) => i.kind === "aggregation" && (i.group_by ?? "key") === field && i.group_by);
    const obj = inputs.some((i) => i.kind === "objects" && (field === "__pk" || (i.columns ?? []).includes(field)));
    if (!agg && !obj) {
      unmapped.push(field);
      continue;
    }
    if (!vals.length) continue;
    const ctype = colTypes[field] ?? "";
    const time = /date|time/i.test(ctype);
    const norm = (v: unknown): unknown => {
      const d = v instanceof Date ? v : time && typeof v === "number" ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) return v;
      return /^date$/i.test(ctype) ? d.toISOString().slice(0, 10) : d.toISOString();
    };
    if (agg?.bucket) {
      const keys = vals.map((v) => (v instanceof Date || typeof v === "number" ? new Date(v as number).toISOString() : String(v))).filter(Boolean).sort();
      filters.push({ column: field, op: "gte", value: bucketStart(keys[0]) }, { column: field, op: "lt", value: nextBucket(bucketStart(keys[keys.length - 1]).slice(0, agg.bucket === "day" ? 10 : agg.bucket === "month" ? 7 : 4), agg.bucket) });
    } else if (type === "interval" && vals.length === 2 && vals.every((v) => typeof v === "number" || v instanceof Date)) {
      const [a, b] = vals.map((v) => (v instanceof Date ? v.getTime() : (v as number))).sort((x, y) => x - y);
      filters.push({ column: field, op: "gte", value: norm(a) }, { column: field, op: "lte", value: norm(b) });
    } else filters.push({ column: field, op: "in", value: vals.map(norm) });
  }
  return { filter: { filters, mode: "all" }, unmapped };
}

function vegaInputQuery(input: VegaInput, c: WidgetConfig, state: ModuleState): QueryBody | null {
  if (!c.source || input.kind === "variable") return null;
  if (input.kind === "objects") return queryFor(c.source, c.filters, state, { columns: input.columns ?? [] });
  return queryFor(c.source, c.filters, state, { group_by: input.group_by, bucket: input.bucket, metric: input.metric ?? "count", metric_column: input.metric_column, limit: 500 });
}

/** A data input's rows as the spec reads them: the objects (columns + __pk), one row per group (group by, metric, count)
 * or a struct array variable's value. */
export function vegaInputRows(inp: VegaInput, result: QueryResult | null | undefined, variables: Record<string, unknown>): unknown[] {
  if (inp.kind === "variable") {
    const v = inp.variable ? variables[inp.variable] : undefined;
    return Array.isArray(v) ? v : [];
  }
  if (inp.kind === "objects") return (result?.rows ?? []).map(({ __pk, ...r }) => ({ ...r, __pk }));
  return (result?.groups ?? []).map((g) => ({ [inp.group_by ?? "key"]: g.key, [inp.metric ?? "count"]: g.value, count: g.count }));
}

export function VegaWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const inputs = useMemo(() => c.vega_inputs ?? [], [c.vega_inputs]);
  const { results, error } = useQueries(inputs.map((i) => vegaInputQuery(i, c, state)), state, widget);
  const data = useMemo(() => Object.fromEntries(inputs.map((inp, k) => [inp.name, vegaInputRows(inp, results[k], state.variables)])), [inputs, results, state.variables]);
  const specText = c.spec_variable ? String(state.variables[c.spec_variable] ?? "") : c.spec ?? "";
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const setVariable = state.setVariable;
  const variableTypes = state.variableTypes;
  const [note, setNote] = useState<string | null>(null);
  const key = JSON.stringify([specText, data, c.vega_mode, c.vega_theme, c.vega_params, (c.vega_params ?? []).map((p) => variableTypes?.[p.variable])]);
  useEffect(() => {
    if (!specText.trim()) return;
    let cancelled = false;
    let view: { finalize: () => void } | null = null;
    (async () => {
      try {
        const spec = vegaSpec(c, specText, data);
        const { default: embed } = await import("vega-embed");
        if (cancelled || !ref.current) return;
        const r = await embed(ref.current, spec as never, { actions: false, renderer: "svg", mode: (c.vega_mode ?? "vega-lite") === "vega" ? "vega" : "vega-lite" });
        view = r.view;
        // selection parameters → object set filter variables (the selection as a filter on the widget's source) or
        // string variables (the selection in Vega-Lite's JSON form)
        const params = (c.vega_params ?? []).filter((p) => p.name && p.variable);
        const toFilter = params.some((p) => variableTypes?.[p.variable] === "object_set_filter");
        const colTypes: Record<string, string> = {};
        if (toFilter && c.source?.kind === "object_type") {
          const s = await allSources().catch(() => null);
          for (const p of s?.object_types.find((t) => t.id === c.source?.id)?.properties ?? []) colTypes[p.name] = p.type;
        }
        if (cancelled) return;
        for (const p of params)
          try {
            const kind = vegaParamType(spec, p.name) ?? "point";
            r.view.addSignalListener(p.name, (_: string, v: unknown) => {
              const empty = !v || !Object.keys(v as object).length;
              if (variableTypes?.[p.variable] !== "object_set_filter") return setVariable(p.variable, empty ? "" : JSON.stringify(v));
              const out = vegaSelectionFilter(empty ? {} : v, kind, inputs, colTypes);
              setVariable(p.variable, out.filter);
              setNote(!empty && !out.filter.filters.length && out.unmapped.length ? `Selection "${p.name}" is on ${out.unmapped.join(", ")}, not on a property: it does not filter` : null);
            });
          } catch {
            setErr(`Selection parameter "${p.name}" is not in the spec`);
          }
        if (!cancelled) setErr(null);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      view?.finalize();
    };
    // key holds the spec, the data and the settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!specText.trim()) return <Msg>Write a Vega-Lite or Vega spec in the panel</Msg>;
  return (
    <div className="relative flex h-full flex-col" data-vega>
      {(err || error) && <p className="m-2 rounded bg-bad/10 p-2 text-xs text-bad">{err || error}</p>}
      {note && !err && !error && <p className="mx-2 mt-1 rounded bg-warn/10 px-2 py-1 text-[11px] text-warn" data-vega-note>{note}</p>}
      <div ref={ref} className="min-h-0 flex-1 overflow-auto p-2" />
      {editing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            // the preview: the complete spec, data truncated to 5 rows per input
            const short = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.slice(0, 5)]));
            void navigator.clipboard?.writeText(JSON.stringify(vegaSpec(c, specText, short), null, 2));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="absolute right-2 top-2 rounded border border-line-2 bg-panel px-1.5 py-0.5 text-[10px] text-muted hover:text-white"
          title="Copy the complete spec (data injected, 5 rows each) for the Vega editor"
        >
          {copied ? "Copied" : "Copy full spec"}
        </button>
      )}
    </div>
  );
}

export const VEGA_TEMPLATE = (input: VegaInput) =>
  JSON.stringify(
    input.kind === "aggregation"
      ? { mark: { type: "bar", cornerRadiusEnd: 4 }, encoding: { x: { field: input.group_by ?? "key", type: "nominal", sort: "-y" }, y: { field: input.metric ?? "count", type: "quantitative" }, tooltip: [{ field: input.group_by ?? "key" }, { field: input.metric ?? "count" }] }, params: [{ name: "pick", select: { type: "point", fields: [input.group_by ?? "key"] } }] }
      : { mark: { type: "point", filled: true }, encoding: { x: { field: input.columns?.[0] ?? "x", type: "quantitative" }, y: { field: input.columns?.[1] ?? "y", type: "quantitative" }, tooltip: (input.columns ?? []).map((f) => ({ field: f })) } },
    null,
    2,
  );

// ------------------------------------------------------------------------------------------------
// Map
// ------------------------------------------------------------------------------------------------

type Hover = { x: number; y: number; text: string };
/** A layer's colors by a property: a color per value, and what the legend shows (categories, a gradient, or classes). */
type LayerScale = { color: (v: unknown) => string | null; legend: ColorLegend | null; bins?: Bin[] };
const SEP = "\u0001";

/** An object set / array / comma-separated string variable's primary keys. */
const pkList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];

/** A row's id on the map: its primary key; dataset rows have none, so their label (or row number) identifies them. */
const rowPk = (l: MapLayer, r: Record<string, unknown>, idx: number): string =>
  r.__pk !== undefined && r.__pk !== null ? String(r.__pk) : l.label_column ? String(r[l.label_column] ?? idx) : String(idx);

type Row = Record<string, unknown>;
const rowKey = (r: Row) => (r.__pk !== undefined && r.__pk !== null ? `pk:${String(r.__pk)}` : JSON.stringify(r));
/** The loaded rows and, after them, the other rows (found by Search within) that are not among them. */
function mergeRows(rows: Row[], more: Row[] | undefined): Row[] {
  if (!more?.length) return rows;
  const have = new Set(rows.map(rowKey));
  return [...rows, ...more.filter((r) => !have.has(rowKey(r)))];
}

/** A layer's geo filter for the server (geospatial search, objects in view): on its geoshape, else its geopoint, else
 * its latitude / longitude columns; null for a layer without a location. */
function geoFilter(l: MapLayer, region: { geometry: unknown } | { bbox: [number, number, number, number] }): Filter | null {
  if (l.shape) return { column: l.shape, op: "geo", value: region };
  if (l.point) return { column: l.point, op: "geo", value: region };
  if (l.lat && l.lon) return { column: l.lat, op: "geo", value: { ...region, lon_column: l.lon } };
  return null;
}

export function MapWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  // Import map template: the saved map's layers stand in for the object layers
  const tpl = c.map_template?.map_id ? c.map_template : null;
  const layers = useMemo(() => (tpl ? [] : c.map_layers?.length ? c.map_layers : [{ label: "Objects" } as MapLayer]), [tpl, c.map_layers]);
  const srcOf = (l: MapLayer) => l.source ?? c.source;
  // load the objects in view: the box of the view once the map has been fitted (then after each move)
  const [inView, setInView] = useState<[number, number, number, number] | null>(null);
  const layerQuery = (l: MapLayer, limit?: number, extra?: Filter | null, inViewOnly = true) => {
    const src = srcOf(l);
    const fv = l.input_variable ? [l.input_variable] : l.source ? undefined : c.filter_variables;
    if (!src) return null;
    const q = queryFor(src, l.source ? l.filters : c.filters, state, {
      columns: uniq([l.lat, l.lon, l.point, l.shape, l.label_column, l.color_by, ...(l.hover ?? []), ...(l.rules ?? []).map((r) => r.column), ...(c.map_timeline && l.time_column ? [l.time_column] : [])]),
      ...(fv?.length ? { filter_variables: fv } : {}),
      ...(limit ? { limit } : {}),
    });
    const view = inViewOnly && c.map_load_in_view && inView ? geoFilter(l, { bbox: inView }) : null;
    const add = [view, extra].filter((f): f is Filter => !!f);
    return add.length ? { ...q, additional_filters: [...(q.additional_filters ?? []), ...add] } : q;
  };
  const { results, error } = useQueries(
    layers.map((l) => layerQuery(l)),
    state,
    widget,
  );
  // Search within (geospatial object search on the server): each layer's objects that meet the drawn shapes, shown
  // with the loaded ones and selected
  // (tpl: a map template's object layers' found objects, by overlay entry key)
  const [found, setFound] = useState<{ rows: Record<string, unknown>[][]; tpl?: Record<string, GeoFeature[]>; count: number; error?: string; busy?: boolean } | null>(null);
  const searched = !!found;
  const inViewMode = !!c.map_load_in_view && !tpl;
  // the viewer's pick, else a template's base map (once loaded), else the widget's
  const [userBasemap, setBasemap] = useState<Basemap | null>(null);
  const handle = useRef<MapHandle>(null);
  // color by a property: categories (a color per value), a numeric range on a gradient, or color classes (bins)
  const scales: LayerScale[] = useMemo(
    () =>
      layers.map((l, k): LayerScale => {
        const values = l.color_by ? (results[k]?.rows ?? []).map((r) => r[l.color_by!]) : [];
        const [from, to] = [l.color_from || "#fde68a", l.color_to || "#b91c1c"];
        if (l.color_by && l.color_mode === "bins") {
          const b = colorBins(values, { count: l.color_bins, scale: l.color_scale, from, to, min: l.color_min, max: l.color_max });
          return { color: b.color, legend: null, bins: b.bins };
        }
        // categories: every value is known here, so each gets its own palette color (in sorted order) instead of the
        // Map app's hash of the value, which can give two of a few values the same color
        const distinct = [...new Set(values.filter((v) => v !== null && v !== undefined && v !== "").map(String))].sort();
        const categories = distinct.length <= CATEGORY_PALETTE.length ? Object.fromEntries(distinct.map((v, i) => [v, CATEGORY_PALETTE[i]])) : undefined;
        return buildColorScale(l.color_by ? { property: l.color_by, mode: l.color_mode === "bins" ? undefined : l.color_mode, colors: [from, to], min: l.color_min, max: l.color_max, categories } : null, values);
      }),
    [layers, results],
  );
  // each layer's objects: a shape (the geoshape property, prepared once) and / or a point; the objects Search within
  // found that are not loaded join them
  const layerRows = useMemo(
    () =>
      layers.map((_, k) => mergeRows(results[k]?.rows ?? [], found?.rows[k])),
    [layers, results, found],
  );
  const items: MapItem[][] = useMemo(
    () =>
      layers.map((l, k) =>
        (layerRows[k] ?? []).flatMap((r, idx) => {
          let lat = l.lat ? Number(r[l.lat]) : NaN;
          let lon = l.lon ? Number(r[l.lon]) : NaN;
          if (l.point && typeof r[l.point] === "string") [lat, lon] = String(r[l.point]).split(",").map(Number);
          const geom = l.shape ? parseShape(r[l.shape]) : null;
          const shape = geom ? prepare(geom) : null;
          const dot = Number.isFinite(lat) && Number.isFinite(lon);
          if (!shape?.box && !dot) return [];
          const rule = (l.rules ?? []).map((x) => (x.column ? ruleFor([x], x.column, r[x.column]) : undefined)).find(Boolean);
          const color = rule?.color ?? (l.color_by ? scales[k]?.color(r[l.color_by]) : null) ?? l.color ?? "#1f6feb";
          // dataset rows have no primary key: their label (or row number) identifies them for selection
          return [{ pk: rowPk(l, r, idx), lat, lon, shape: shape?.box ? shape : null, dot, label: l.label_column ? fmt(r[l.label_column]) : "", color, hover: [l.label_column, ...(l.hover ?? [])].filter(Boolean).map((h) => `${h}: ${fmt(r[h!])}`).join("\n"), t: l.time_column ? timeOf(r[l.time_column]) : undefined }];
        }),
      ),
    [layers, layerRows, scales],
  );
  const styles: LayerStyle[] = useMemo(
    () => layers.map((l) => ({ fillOpacity: l.fill_opacity, width: l.line_width, radius: l.radius ?? 5, dotRadius: l.radius ?? 6, outline: l.outline_color, locked: l.locked })),
    [layers],
  );
  // timeline: a time window over the layers' time property; a layer's objects outside it are hidden (objects without a
  // time too), layers without a time property stay as they are. The window: its variables (both ways), else the
  // viewer's, else the whole range.
  const timeOn = !!c.map_timeline && layers.some((l) => l.time_column);
  const timeMode = c.map_time_mode ?? "window";
  const allTimes = useMemo(
    () => (timeOn ? items.flatMap((qs, k) => (layers[k]?.time_column ? qs.map((q) => q.t).filter((t): t is number => typeof t === "number") : [])) : []),
    [timeOn, items, layers],
  );
  const extent = useMemo(() => timeExtent(allTimes), [allTimes]);
  const [localWin, setLocalWin] = useState<TimeWindow | null>(null);
  const vStart = c.map_time_start_variable ? timeOf(state.variables[c.map_time_start_variable]) : null;
  const vEnd = c.map_time_end_variable ? timeOf(state.variables[c.map_time_end_variable]) : null;
  // the selected time is the window's end: set from outside (without an end variable) it moves the window there, its
  // width kept (cumulative: only the end)
  const vSel = c.map_selected_time_variable ? timeOf(state.variables[c.map_selected_time_variable]) : null;
  const base = localWin ?? extent;
  let winA = extent && base ? (vStart ?? base[0]) : NaN;
  let winB = extent && base ? (vEnd ?? base[1]) : NaN;
  if (extent && base && vSel !== null && vEnd === null) {
    if (timeMode === "window" && vStart === null) winA = vSel - (base[1] - base[0]);
    winB = vSel;
  }
  winB = Math.max(winA, winB);
  const win: TimeWindow | null = extent ? [winA, winB] : null;
  // the time variables' values as the widget last wrote them (or found them when View latest was turned on): a value
  // that differs from these while View latest is on was set from outside
  const [knownTimes, setKnownTimes] = useState<{ start: number | null; end: number | null; sel: number | null }>({ start: null, end: null, sel: null });
  const setWin = (w: TimeWindow) => {
    const [a, b] = [Math.round(w[0]), Math.round(w[1])];
    setLocalWin([a, b]);
    const out = (v: string | undefined, ms: number) => {
      if (!v) return null;
      const value = timeForVariable(ms, state.variableTypes?.[v]);
      state.setVariable(v, value);
      return timeOf(value);
    };
    setKnownTimes({ start: out(c.map_time_start_variable, a), end: out(c.map_time_end_variable, b), sel: out(c.map_selected_time_variable, b) });
    if (c.map_play_position_variable) state.setVariable(c.map_play_position_variable, b);
  };
  // View latest (live mode): the window ends at the newest time, again whenever newer data arrives. A selected time
  // (or window) set from outside through its variable turns View latest off and stays where it was set, as moving the
  // time cursor on the timeline does
  const [live, setLiveState] = useState(false);
  const movedOutside =
    live &&
    (
      [
        [c.map_selected_time_variable, vSel, knownTimes.sel],
        [c.map_time_start_variable, vStart, knownTimes.start],
        [c.map_time_end_variable, vEnd, knownTimes.end],
      ] as const
    ).some(([v, now, known]) => !!v && now !== null && now !== known);
  useEffect(() => {
    if (movedOutside) setLiveState(false);
  }, [movedOutside]);
  const liveOn = timeOn && !!c.map_time_live && live && !movedOutside;
  const liveTo = liveOn && extent && win ? latestWindow(win, extent, timeMode) : null;
  const liveSig = liveTo && win && (Math.round(liveTo[0]) !== Math.round(win[0]) || Math.round(liveTo[1]) !== Math.round(win[1])) ? liveTo.join() : "";
  const liveSet = useRef(setWin);
  useEffect(() => {
    liveSet.current = setWin;
  });
  useEffect(() => {
    if (liveSig) liveSet.current(liveSig.split(",").map(Number) as TimeWindow);
  }, [liveSig]);
  const setLive = (on: boolean) => {
    // the variables' values now are not changes from outside
    if (on) setKnownTimes({ start: vStart, end: vEnd, sel: vSel });
    setLiveState(on);
  };
  // auto pause: the times (an array variable) at which playback stops
  const pauseRaw = c.map_auto_pause_variable ? state.variables[c.map_auto_pause_variable] : undefined;
  const pauseTimes = useMemo(
    () => (Array.isArray(pauseRaw) ? pauseRaw : pauseRaw === undefined || pauseRaw === null || pauseRaw === "" ? [] : [pauseRaw]).map(timeOf).filter((t): t is number => t !== null),
    [pauseRaw],
  );
  const [localPlay, setLocalPlay] = useState(false);
  const playing = timeOn && (c.map_play_variable ? state.variables[c.map_play_variable] === true : localPlay);
  const setPlaying = (on: boolean) => {
    // playing the whole range: start with a tenth of it
    if (on && extent && win && win[1] - win[0] >= extent[1] - extent[0]) setWin([extent[0], extent[0] + (extent[1] - extent[0]) / 10]);
    setLocalPlay(on);
    if (c.map_play_variable) state.setVariable(c.map_play_variable, on);
  };
  // each step of playback; at an auto pause time the window stops there and playback pauses
  const tick = useRef<() => void>(() => {});
  useEffect(() => {
    tick.current = () => {
      if (!win || !extent) return;
      const next = playStep(win, extent, c.map_auto_pause_variable ? state.variables[c.map_auto_pause_variable] : undefined);
      setWin(next.win);
      if (next.pause !== null) setPlaying(false);
    };
  });
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => tick.current(), Math.max(100, c.map_play_interval ?? 1000));
    return () => clearInterval(id);
  }, [playing, c.map_play_interval]);
  const [timelineOpen, setTimelineOpen] = useState(c.map_timeline_open !== false);
  const shown: MapItem[][] = useMemo(
    () => (!timeOn || Number.isNaN(winA) ? items : items.map((qs, k) => (layers[k]?.time_column ? qs.filter((q) => inWindow(q.t, [winA, winB], timeMode)) : qs))),
    [items, layers, timeOn, winA, winB, timeMode],
  );
  // drawn shapes: kept here, and in the drawn shapes variable (GeoJSON, both ways) when one is set. The text last
  // written is kept with the shapes, so they keep their positions as drawn (a shape split at 180° measures as drawn)
  const output = c.map_draw_output ?? "feature";
  const drawVar = c.map_draw_variable;
  const drawText = drawVar ? state.variables[drawVar] : undefined;
  const [drawnLocal, setDrawnLocal] = useState<{ shapes: DrawnShape[]; text: string }>({ shapes: [], text: "" });
  const varShapes = useMemo(() => (drawVar ? shapesFromString(drawText) : null), [drawVar, drawText]);
  const shapes = !varShapes || (typeof drawText === "string" ? drawText : "") === drawnLocal.text ? drawnLocal.shapes : varShapes;
  const [selShape, setSelShape] = useState<string | null>(null);
  const selectedShape = shapes.find((s) => s.id === selShape) ?? null;
  const selectShape = (s: DrawnShape | null) => {
    setSelShape(s?.id ?? null);
    if (c.map_draw_selected_variable) state.setVariable(c.map_draw_selected_variable, shapeToString(s, output));
  };
  const setShapes = (next: DrawnShape[]) => {
    const text = shapesToString(next, output);
    setDrawnLocal({ shapes: next, text });
    if (drawVar) state.setVariable(drawVar, text);
    if (selectedShape && !next.some((s) => s.id === selectedShape.id)) selectShape(null);
  };
  const addShape = (kind: DrawnShape["kind"], world: [number, number][]) => {
    const pts = world.map(([x, y]) => lonLatOf(x, y));
    const geom = drawnGeometry(kind, pts, c.map_draw_split !== false);
    if (!geom) return;
    const s: DrawnShape = { id: `d${Date.now().toString(36)}${shapes.length}`, kind, pts, geom };
    const next = c.map_draw_single ? [s] : [...shapes, s];
    const text = shapesToString(next, output);
    setDrawnLocal({ shapes: next, text });
    if (drawVar) state.setVariable(drawVar, text);
    selectShape(s);
    if (c.map_on_draw?.length) void state.runEvents?.(c.map_on_draw);
  };
  // overlay layers (saved maps' layers or the widget's own) and the template's layers
  const { entries, template } = useOverlays(c.map_overlays, tpl, state.variables);
  const tplBase = tpl && tpl.use_view !== false && template?.basemap && (template.basemap in BASEMAPS || template.basemap === "none") ? (template.basemap as Basemap) : null;
  const basemap: Basemap = userBasemap ?? tplBase ?? ((c.basemap as Basemap) || "google-satellite");
  const loadedOverlays = useOverlayData(entries);
  // a map template's object layers (objects of a type, or of its input variable) that Search within searches
  const tplSearch = entries.filter((e) => e.key.startsWith("tpl/") && !e.error && e.layer.visible && (e.layer.kind === "objects" || e.layer.kind === "dropped") && !!e.layer.config.object_type_id);
  // the objects Search within found on template layers join the layers' loaded features
  const foundTpl = found?.tpl;
  const overlayData = useMemo(() => {
    if (!foundTpl) return loadedOverlays;
    const out = { ...loadedOverlays };
    for (const [key, more] of Object.entries(foundTpl)) {
      const d = out[key];
      if (!d || !more.length) continue;
      const have = new Set((d.features ?? []).map((f) => `${f.object_type_id}:${f.primary_key}`));
      out[key] = { ...d, features: [...(d.features ?? []), ...more.filter((f) => !have.has(`${f.object_type_id}:${f.primary_key}`))] };
    }
    return out;
  }, [loadedOverlays, foundTpl]);
  const [picked, setPicked] = useState<OverlayPick | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // fit once the box has a size (a fit against a zero-sized box zooms all the way out): a template's own view, else
  // the objects (points and shapes), else the overlays' features
  const [box, size] = useSize<HTMLDivElement>();
  const fitted = useRef("");
  useEffect(() => {
    if (size.w < 50 || size.h < 50) return;
    if (tpl && template && tpl.use_view !== false) {
      const sig = `tpl:${template.id}`;
      if (fitted.current === sig) return;
      fitted.current = sig;
      if (template.view) handle.current?.center(template.view.lon, template.view.lat, template.view.zoom);
      return;
    }
    const all = items.flat();
    const shapes: Prepared[] = all.flatMap((q) => [...(q.shape ? [q.shape] : []), ...(q.dot ? [preparePoint(q.lon, q.lat)] : [])]);
    const drawn = shapes.length > 0;
    if (!drawn)
      for (const d of Object.values(overlayData))
        for (const g of [...(d.features ?? []).map((f) => f.geometry), ...(d.regions?.features ?? []).map((r) => r.geometry)]) {
          const geom = parseShape(g);
          if (geom) shapes.push(prepare(geom));
        }
    // across the antimeridian the box runs past 180° instead of around the world
    const b = boundsOf(shapes);
    const sig = JSON.stringify(b);
    if (!b || fitted.current === sig) return;
    // objects loaded for the view (or found by Search within) do not move the view again
    if (fitted.current && (inViewMode || searched)) return;
    fitted.current = sig;
    // points only: the margin they always had; with shapes: a tenth of the extent
    const pad = drawn && !all.some((q) => q.shape) ? 0.2 : Math.max(0.02, Math.min(0.2, Math.max(b[2] - b[0], b[3] - b[1]) * 0.1));
    handle.current?.fit([b[0] - pad, Math.max(-85, b[1] - pad), b[2] + pad, Math.min(85, b[3] + pad)]);
  }, [items, overlayData, size.w, size.h, tpl, template, inViewMode, searched]);
  // load the objects in view: after the first fit, each settled move asks for the view's box
  const onMove = () => {
    const v = handle.current?.view();
    if (!inViewMode || !fitted.current || !v || size.w < 50 || size.h < 50) return;
    const bb = viewBbox(v, size.w, size.h);
    if (JSON.stringify(bb) !== JSON.stringify(inView)) setInView(bb);
  };
  const visible = (l: MapLayer) => !l.visible_variable || state.variables[l.visible_variable] !== false;
  // selection: the layer's selected objects variable (both ways), else the module's selected object of the source
  const selSig = layers
    .map((l) => {
      const src = srcOf(l);
      return (l.selected_variable ? pkList(state.variables[l.selected_variable]) : src && state.selection[sourceKey(src)] ? [state.selection[sourceKey(src)]!] : []).join(SEP);
    })
    .join("\u0002");
  const selected = useMemo(() => selSig.split("\u0002").map((s) => new Set(s ? s.split(SEP) : [])), [selSig]);
  // a drag that pans the map is not a click on a shape
  const down = useRef<[number, number]>([0, 0]);
  const dragged = (e: { clientX: number; clientY: number }) => Math.hypot(e.clientX - down.current[0], e.clientY - down.current[1]) > 4;
  const pick = (k: number, pk: string | undefined, additive: boolean) => {
    const l = layers[k];
    if (!l || l.locked || !pk) return;
    const src = srcOf(l);
    if (!l.selected_variable) return selectRow(widget, state, src, pk);
    const cur = pkList(state.variables[l.selected_variable]);
    const has = cur.includes(pk);
    const next = additive ? (has ? cur.filter((x) => x !== pk) : [...cur, pk]) : has && cur.length === 1 ? [] : [pk];
    state.setVariable(l.selected_variable, state.variableTypes?.[l.selected_variable] === "string" ? next.join(",") : next);
    if (src) state.select(sourceKey(src), next.includes(pk) ? pk : next[next.length - 1]);
    if (next.includes(pk) && c.on_select?.length) void state.runEvents?.(c.on_select);
  };
  const pickOverlay = (f: OverlayPick, e: { clientX: number; clientY: number; shiftKey?: boolean } | null) => {
    if (e && dragged(e)) return;
    const same = picked?.layer === f.layer && picked.primary_key === f.primary_key;
    setPicked(same ? null : f);
    // an object on an overlay (or template) layer is the module's selected object of its type
    if (f.object_type_id) {
      state.select(`object_type:${f.object_type_id}`, same ? undefined : f.primary_key);
      const out = tpl?.selected_variable;
      if (out && f.layer.startsWith("tpl/")) {
        const cur = pkList(state.variables[out]);
        const next = same ? cur.filter((x) => x !== f.primary_key) : e?.shiftKey ?[...new Set([...cur, f.primary_key])] : [f.primary_key];
        state.setVariable(out, state.variableTypes?.[out] === "string" ? next.join(",") : next);
      }
      if (!same && c.on_select?.length) void state.runEvents?.(c.on_select);
    }
  };
  // the layers are drawn again only when they change (not while the map pans), so what they call stays the same
  const hoverAt = useCallback(
    (e: { clientX: number; clientY: number } | null, text: string) => {
      const r = box.current?.getBoundingClientRect();
      setHover(e && text && r ? { x: e.clientX - r.left, y: e.clientY - r.top, text } : null);
    },
    [box, setHover],
  );
  const latest = useRef({ pick, pickOverlay });
  useEffect(() => {
    latest.current = { pick, pickOverlay };
  });
  const onDot = useCallback((k: number, pk: string | undefined, additive: boolean) => latest.current.pick(k, pk, additive), []);
  const onOverlay = useCallback((f: OverlayPick, e: { clientX: number; clientY: number; shiftKey?: boolean } | null) => latest.current.pickOverlay(f, e), []);
  /**
   * A click on the object layers' shapes: the shape picked at the pointer among the visible, unlocked layers (points
   * and lines first, then the smallest area, so a shape under a larger one stays reachable). A polygon's hole is not
   * part of it.
   */
  const clickShapes = (e: React.MouseEvent<SVGGElement>, p: Projection) => {
    if (dragged(e) || (e.target as Element).closest?.("[data-map-point]")) return;
    const r = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!r) return;
    const f = frameOf(p);
    const at: { k: number; q: MapItem }[] = [];
    layers.forEach((l, k) => {
      if (visible(l) && !l.locked) for (const q of shown[k] ?? []) if (q.shape) at.push({ k, q });
    });
    const i = pickShape(at.map((x) => x.q.shape!), (e.clientX - r.left - f.ox) / f.s, (e.clientY - r.top - f.oy) / f.s, 7 / f.s);
    if (i >= 0) pick(at[i].k, at[i].q.pk, e.shiftKey || e.metaKey || e.ctrlKey);
  };
  // the toolbar's tools: box / lasso / polygon selection (advanced selection tools) and drawing; one at a time, the
  // map still pans and zooms under the click tools (polygon, drawing). Keys (on the focused map): Esc cancels the shape
  // being drawn, then leaves the tool; Enter finishes it; Backspace removes its last point; Delete removes the selected
  // drawn shape.
  const tools: MapTool[] = [
    ...(c.map_selection_tools ? (["box", "lasso", "polygon"] as const) : []),
    ...(c.map_draw_kinds ?? []).map((k) => `draw_${k}` as MapTool),
    ...(c.map_shape_edit ? (["modify"] as const) : []),
  ];
  const [toolState, setToolState] = useState<MapTool | null>(null);
  const tool = toolState && tools.includes(toolState) ? toolState : null;
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [sketch, setSketch] = useState<[number, number][]>([]);
  const additiveClick = useRef(false);
  const setTool = (t: MapTool | null) => {
    setBand(null);
    setSketch([]);
    setToolState(t);
  };
  const clickTool = tool === "polygon" || !!tool?.startsWith("draw_");
  const sketchKind = tool === "draw_line" ? "line" : "polygon";
  /** Screen (a pointer event) → world units: the map's view centre is world pixel cx, cy at zoom z. */
  const worldAt = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] | null => {
      const r = box.current?.getBoundingClientRect();
      const v = handle.current?.view();
      if (!r || !v) return null;
      const s = 256 * 2 ** v.z;
      return [(v.cx + e.clientX - r.left - r.width / 2) / s, (v.cy + e.clientY - r.top - r.height / 2) / s];
    },
    [box],
  );
  /** A layer's selection set to these objects (added to it when additive): its selected objects variable, else the
   * module's selected object of the source. */
  const selectHits = (k: number, hits: string[], additive: boolean) => {
    const l = layers[k];
    const src = srcOf(l);
    if (l.selected_variable) {
      const next = additive ? uniq([...pkList(state.variables[l.selected_variable]), ...hits]) : hits;
      state.setVariable(l.selected_variable, state.variableTypes?.[l.selected_variable] === "string" ? next.join(",") : next);
      if (src && hits.length) state.select(sourceKey(src), hits[hits.length - 1]);
    } else if (src && hits.length) state.select(sourceKey(src), hits[0]);
  };
  /** Select the objects (shapes and points of the visible, unlocked layers, within the timeline's window) that pass. */
  const selectWhere = (test: (p: Prepared) => boolean, additive: boolean) => {
    let any = false;
    layers.forEach((l, k) => {
      if (!visible(l) || l.locked) return;
      const hits = uniq((shown[k] ?? []).filter((q) => (q.shape && test(q.shape)) || (q.dot && test(preparePoint(q.lon, q.lat)))).map((q) => q.pk));
      if (hits.length) any = true;
      selectHits(k, hits, additive);
    });
    if (any && c.on_select?.length) void state.runEvents?.(c.on_select);
  };
  const selectInPolygon = (world: [number, number][], additive: boolean) => {
    const sp = selPolygon(world.flat());
    if (sp) selectWhere((p) => shapeInPolygon(p, sp), additive);
  };
  /** Finish the shape being drawn: a selection polygon selects, a line / polygon becomes a drawn shape. */
  const finishSketch = () => {
    const pts = sketch;
    setSketch([]);
    if (tool === "polygon") selectInPolygon(pts, additiveClick.current);
    else if (tool === "draw_line" || tool === "draw_polygon") addShape(sketchKind, pts);
  };
  const onToolClick = (e: React.MouseEvent) => {
    if (!clickTool || (e.target as Element).closest?.("button, input, select, a, [data-map-ui], [data-map-legend], [data-map-pick], [data-map-timeline]")) return;
    e.stopPropagation();
    if (dragged(e)) return;
    const w = worldAt(e);
    const v = handle.current?.view();
    if (!w || !v) return;
    additiveClick.current = e.shiftKey || e.metaKey || e.ctrlKey;
    if (tool === "draw_point") return addShape("point", [w]);
    // a click on the first corner closes a polygon
    const s = 256 * 2 ** v.z;
    if (sketchKind === "polygon" && sketch.length >= 3 && Math.hypot((w[0] - sketch[0][0]) * s, (w[1] - sketch[0][1]) * s) < 9) return finishSketch();
    // a click on the last point (a double-click's second click) adds nothing
    const last = sketch[sketch.length - 1];
    if (last && Math.hypot((w[0] - last[0]) * s, (w[1] - last[1]) * s) < 3) return;
    setSketch([...sketch, w]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
    if (e.key === "Escape") {
      if (sketch.length) setSketch([]);
      else if (tool) setTool(null);
      else if (selectedShape) selectShape(null);
    } else if (e.key === "Enter" && sketch.length) finishSketch();
    else if (e.key === "Backspace" && sketch.length) setSketch(sketch.slice(0, -1));
    else if ((e.key === "Delete" || e.key === "Backspace") && selectedShape && !sketch.length) setShapes(shapes.filter((s) => s.id !== selectedShape.id));
    else return;
    e.preventDefault();
  };
  /** In pan mode, a click near a drawn shape's outline (or point) selects it (with Modify: inside it too); elsewhere it
   * clears that selection. */
  const onMapClick = (e: React.MouseEvent) => {
    if (clickTool || !shapes.length || dragged(e) || (e.target as Element).closest?.("button, input, select, a, [data-map-ui], [data-map-legend], [data-map-pick], [data-map-timeline]")) return;
    const w = worldAt(e);
    const v = handle.current?.view();
    if (!w || !v) return;
    const tol = 8 / (256 * 2 ** v.z);
    let best: DrawnShape | null = null;
    let bd = tol;
    for (const s of shapes) {
      const d = distToDrawn(prepare(s.geom), w[0], w[1], tool === "modify");
      if (d <= bd) [best, bd] = [s, d];
    }
    // Modify: a click on the shape being modified keeps it
    if (best) selectShape(best.id === selectedShape?.id && tool !== "modify" ? null : best);
    else if (selectedShape) selectShape(null);
  };
  // Modify: the selected drawn shape as it is while a handle is dragged; the edit is written back on release
  const [editPreview, setEditPreview] = useState<DrawnShape | null>(null);
  const commitEdit = (s: DrawnShape) => {
    setShapes(shapes.map((x) => (x.id === s.id ? s : x)));
    if (c.map_draw_selected_variable && s.id === selectedShape?.id) state.setVariable(c.map_draw_selected_variable, shapeToString(s, output));
  };
  const shapesShown = editPreview ? shapes.map((s) => (s.id === editPreview.id ? editPreview : s)) : shapes;
  // Search within: the drawn shape selected (else every drawn shape) sent to the server's geo filter for each visible,
  // unlocked layer with a location; what it finds is shown with the loaded objects and selected
  const searchShapes = selectedShape ? [selectedShape] : shapes;
  const searchWithin = async (additive: boolean) => {
    if (!searchShapes.length) return;
    const geometry = searchShapes.length === 1 ? searchShapes[0].geom : { type: "GeometryCollection", geometries: searchShapes.map((s) => s.geom) };
    const sv = c.scenario_variable;
    const scenarioId = sv ? String(state.variables[sv] ?? "") || undefined : undefined;
    setFound((f) => ({ rows: f?.rows ?? [], tpl: f?.tpl, count: f?.count ?? 0, busy: true }));
    try {
      // a map template's object layers: the Map app's object search with the drawn shapes as its area (the layer's
      // keyword, property and time filters and its input variable's objects kept; its own area replaced)
      const tplFound = Object.fromEntries(
        await Promise.all(
          tplSearch.map(async (e) => {
            const cfg = e.layer.config as Record<string, unknown>;
            const r = await geoApi.searchObjects({
              object_type_id: String(cfg.object_type_id),
              property: (cfg.property as string) || null,
              area: { mode: "draw", polygon: geometry as never },
              time: (cfg.time as never) ?? null,
              q: (cfg.q as string) ?? "",
              filters: (cfg.filters as never) ?? [],
              primary_keys: e.layer.kind === "dropped" ? ((cfg.primary_keys as string[]) ?? []) : null,
              limit: 5000,
            });
            return [e.key, r.features] as const;
          }),
        ),
      ) as Record<string, GeoFeature[]>;
      const rows = await Promise.all(
        layers.map((l) => {
          const g = visible(l) && !l.locked ? geoFilter(l, { geometry }) : null;
          // the whole source, not only the view
          const q = g ? layerQuery(l, 5000, g, false) : null;
          return q ? workshop.query(scenarioId ? { ...q, scenario_id: scenarioId } : q).then((r) => r.rows ?? []) : Promise.resolve([]);
        }),
      );
      const tplCount = Object.values(tplFound).reduce((n, fs) => n + fs.length, 0);
      setFound({ rows, tpl: tplFound, count: rows.reduce((n, r) => n + r.length, 0) + tplCount });
      let any = false;
      // the template's found objects: its selected objects variable (when set) and the module's selected object of
      // each type
      if (tplCount) {
        any = true;
        const out = tpl?.selected_variable;
        const pks = uniq(Object.values(tplFound).flatMap((fs) => fs.map((f) => f.primary_key)));
        if (out) {
          const next = additive ? uniq([...pkList(state.variables[out]), ...pks]) : pks;
          state.setVariable(out, state.variableTypes?.[out] === "string" ? next.join(",") : next);
        }
        for (const fs of Object.values(tplFound)) if (fs.length) state.select(`object_type:${fs[0].object_type_id}`, fs[0].primary_key);
      }
      rows.forEach((rs, k) => {
        if (!geoFilter(layers[k], { geometry }) || !visible(layers[k]) || layers[k].locked) return;
        // ids as the map gives them once the found objects join the loaded ones
        const merged = mergeRows(results[k]?.rows ?? [], rs);
        const at = new Map(merged.map((r, i) => [rowKey(r), i]));
        const hits = uniq(rs.map((r) => rowPk(layers[k], r, at.get(rowKey(r)) ?? 0)));
        if (hits.length) any = true;
        selectHits(k, hits, additive);
      });
      if (any && c.on_select?.length) void state.runEvents?.(c.on_select);
      if (c.map_draw_clear_after) setShapes([]);
    } catch (err) {
      setFound((f) => ({ rows: f?.rows ?? [], tpl: f?.tpl, count: f?.count ?? 0, error: (err as Error).message }));
    }
  };
  // Select within: the objects meeting the selected drawn polygon (else every drawn polygon)
  const withinShapes = (selectedShape?.kind === "polygon" ? [selectedShape] : shapes.filter((s) => s.kind === "polygon")).filter(Boolean);
  const selectWithin = (additive: boolean) => {
    const sels = withinShapes.flatMap((s) => prepare(s.geom).polys.map((rings) => selPolygon(rings[0]))).filter((x): x is NonNullable<typeof x> => !!x);
    if (!sels.length) return;
    selectWhere((p) => sels.some((sp) => shapeInPolygon(p, sp)), additive);
    if (c.map_draw_clear_after) setShapes([]);
  };
  const selectInBox = (b: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number, additive: boolean) => {
    const v = handle.current?.view();
    if (!v) return;
    // screen → world units (the map's view centre is world pixel cx, cy at zoom z)
    const s = 256 * 2 ** v.z;
    const wx = (x: number) => (v.cx + x - w / 2) / s;
    const wy = (y: number) => (v.cy + y - h / 2) / s;
    const wb: [number, number, number, number] = [wx(Math.min(b.x0, b.x1)), wy(Math.min(b.y0, b.y1)), wx(Math.max(b.x0, b.x1)), wy(Math.max(b.y0, b.y1))];
    selectWhere((p) => shapeInBox(p, wb), additive);
  };
  const selectInLasso = (pts: [number, number][], r: DOMRect, additive: boolean) =>
    selectInPolygon(pts.map(([x, y]) => worldAt({ clientX: x + r.left, clientY: y + r.top })).filter((x): x is [number, number] => !!x), additive);
  const legendRows: LegendRow[] = [
    ...layers.flatMap((l, k): LegendRow[] =>
      l.hide_in_legend
        ? []
        : [
            {
              label: l.label,
              color: l.color ?? "#1f6feb",
              count: shown[k]?.length ?? 0,
              hidden: !visible(l),
              legend: scales[k]?.legend,
              bins: scales[k]?.bins,
              by: l.color_by,
              kind: items[k]?.some((q) => q.shape?.polys.length) ? "shape" : items[k]?.some((q) => q.shape?.lines.length) ? "line" : "point",
            },
          ],
    ),
    ...entries.map(
      (e): LegendRow => ({
        label: e.label,
        color: e.layer.color,
        count: overlayData[e.key]?.features?.length ?? overlayData[e.key]?.regions?.features.length,
        hidden: !e.layer.visible,
        kind: e.layer.kind === "tiles" || e.layer.kind === "raster" ? "tiles" : "shape",
        note: e.error ?? overlayData[e.key]?.error ?? (overlayData[e.key]?.loading ? "loading…" : e.layer.kind === "tracks" ? "tracks are not drawn in Workshop" : undefined),
      }),
    ),
  ];
  return (
    <div className="relative flex h-full flex-col" data-map={widget.id} onPointerDownCapture={(e) => (down.current = [e.clientX, e.clientY])}>
      <div
        ref={box}
        className={`relative flex min-h-0 flex-1 outline-none ${clickTool ? "[&_.cursor-grab]:cursor-crosshair" : ""}`}
        tabIndex={-1}
        onKeyDown={onKey}
        onClickCapture={onToolClick}
        onClick={onMapClick}
        onDoubleClickCapture={(e) => {
          if (!clickTool || (e.target as Element).closest?.("button, input, select, a, [data-map-ui], [data-map-legend], [data-map-pick]")) return;
          // a double-click finishes the shape being drawn (and does not zoom)
          e.stopPropagation();
          e.preventDefault();
          if (tool !== "draw_point") finishSketch();
        }}
        onPointerLeave={() => setHover(null)}
        data-map-tool-active={tool ?? undefined}
      >
        <MapCanvas handle={handle} basemap={basemap} onBasemap={setBasemap} onMove={inViewMode ? onMove : undefined} overlays={(p) => <OverlayImages entries={entries} data={overlayData} p={p} />}>
          {(p) => (
            // drawing order: overlays under the objects (in their order), the object layers (in theirs), overlays above,
            // then the drawn shapes and the shape being drawn
            <>
              <OverlayTiles entries={entries} p={p} picked={picked} onPick={onOverlay} above={false} />
              <ShapeFrame p={p}>
                {(f) => (
                  <>
                    <OverlayShapes entries={entries} data={overlayData} f={f} picked={picked} onPick={onOverlay} onHover={hoverAt} above={false} />
                    <g data-map-objects onClick={(e) => clickShapes(e, p)}>
                      {layers.map((l, k) =>
                        visible(l) ? <ObjectLayer key={k} index={k} items={shown[k] ?? NO_ITEMS} f={f} style={styles[k]} selected={selected[k] ?? NO_SELECTION} onHover={hoverAt} onDot={onDot} /> : null,
                      )}
                    </g>
                    <OverlayShapes entries={entries} data={overlayData} f={f} picked={picked} onPick={onOverlay} onHover={hoverAt} above />
                    {shapes.length > 0 && (
                      <g className="pointer-events-none">
                        <DrawnShapes shapes={shapesShown} selected={selectedShape?.id ?? null} f={f} color={c.map_draw_color ?? "#f97316"} opacity={c.map_draw_opacity ?? 0.25} measure={c.map_measure} />
                      </g>
                    )}
                    {tool === "modify" && selectedShape && (
                      <ShapeEditor key={selectedShape.id} shape={selectedShape} f={f} toWorld={worldAt} split={c.map_draw_split !== false} onPreview={setEditPreview} onCommit={commitEdit} />
                    )}
                    {clickTool && sketch.length > 0 && (
                      <Sketch kind={sketchKind} pts={sketch} f={f} host={box} toWorld={worldAt} color={tool === "polygon" ? "#38bdf8" : (c.map_draw_color ?? "#f97316")} measure={tool === "polygon" ? undefined : c.map_measure} />
                    )}
                  </>
                )}
              </ShapeFrame>
              <OverlayTiles entries={entries} p={p} picked={picked} onPick={onOverlay} above />
            </>
          )}
        </MapCanvas>
        {tool === "box" && (
          <div
            className="absolute inset-0 z-[5] cursor-crosshair select-none"
            data-map-box-layer
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              const r = e.currentTarget.getBoundingClientRect();
              const [x, y] = [e.clientX - r.left, e.clientY - r.top];
              setBand({ x0: x, y0: y, x1: x, y1: y });
            }}
            onPointerMove={(e) => {
              if (!band) return;
              const r = e.currentTarget.getBoundingClientRect();
              setBand({ ...band, x1: e.clientX - r.left, y1: e.clientY - r.top });
            }}
            onPointerUp={(e) => {
              if (!band) return;
              const r = e.currentTarget.getBoundingClientRect();
              const b = { ...band, x1: e.clientX - r.left, y1: e.clientY - r.top };
              setBand(null);
              if (Math.abs(b.x1 - b.x0) > 3 && Math.abs(b.y1 - b.y0) > 3) selectInBox(b, r.width, r.height, e.shiftKey || e.metaKey || e.ctrlKey);
            }}
          >
            {band && (
              <div
                className="pointer-events-none absolute border-2 border-dashed border-sky-400 bg-sky-400/15"
                style={{ left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }}
                data-map-box-band
              />
            )}
          </div>
        )}
        {tool === "lasso" && <LassoLayer onDone={selectInLasso} />}
        <MapToolbar
          tools={tools}
          tool={tool}
          setTool={setTool}
          shapes={shapes.length}
          selectedShape={!!selectedShape}
          onDelete={() => selectedShape && setShapes(shapes.filter((s) => s.id !== selectedShape.id))}
          onClear={() => setShapes([])}
          onSelectIntersecting={c.map_shape_selection ? () => selectWithin(false) : undefined}
          canIntersect={withinShapes.length > 0}
          onSearchWithin={c.map_geo_search ? () => void searchWithin(false) : undefined}
          canSearch={searchShapes.length > 0 && (tplSearch.length > 0 || layers.some((l) => !!srcOf(l) && !!geoFilter(l, { bbox: [0, 0, 0, 0] })))}
          searching={!!found?.busy}
        />
        {tool === "modify" && !selectedShape && shapes.length > 0 && (
          <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-ocean/50 bg-panel/95 px-3 py-1 text-[11px] text-soft" data-map-ui data-map-modify-hint>
            Click a drawn shape to modify it
          </div>
        )}
        {found && !found.busy && (
          <div className="absolute bottom-14 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-ocean/50 bg-panel/95 px-3 py-1 text-[11px] text-soft" data-map-ui data-map-search-result={found.count}>
            {found.error ? <span className="text-bad">{found.error}</span> : <span>Search within: {found.count.toLocaleString()} found{found.count >= 5000 ? " (the first 5,000 per layer)" : ""}</span>}
            <button type="button" onClick={() => setFound(null)} className="text-muted hover:text-white" title="Remove the found objects that were not loaded (the selection stays)" data-map-search-clear>
              ✕
            </button>
          </div>
        )}
        {clickTool && sketch.length > 0 && (
          <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-ocean/50 bg-panel/95 px-3 py-1 text-[11px] text-soft" data-map-ui data-map-sketch-hint>
            {sketchKind === "line" ? "Double-click or Enter to finish the line" : "Double-click, Enter or click the first corner to finish"} · Backspace undoes · Esc cancels
          </div>
        )}
        {c.map_legend !== false && <MapLegend rows={legendRows} collapsed={c.map_legend_collapsed} error={error} />}
        {c.map_legend === false && error && <div className="absolute bottom-6 left-3 rounded bg-panel/90 p-1.5 text-[11px] text-bad">{error}</div>}
        {picked && <PickCard pick={picked} onClose={() => setPicked(null)} />}
        {timeOn && extent && !timelineOpen && (
          <button type="button" onClick={() => setTimelineOpen(true)} className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-md border border-line bg-panel/90 px-2 py-1 text-[11px] text-muted hover:text-white" data-map-timeline-open>
            Timeline
          </button>
        )}
        <HoverCard hover={hover} width={size.w} />
      </div>
      {timeOn && extent && win && timelineOpen && (
        <MapTimeline
          extent={extent}
          win={win}
          setWin={setWin}
          times={allTimes}
          utc={c.map_time_zone === "utc"}
          locked={!!c.map_timeline_locked}
          playing={playing}
          setPlaying={setPlaying}
          mode={timeMode}
          shown={shown.reduce((s, qs, k) => s + (layers[k]?.time_column ? qs.length : 0), 0)}
          onClose={() => setTimelineOpen(false)}
          clock={c.map_time_format ?? "24h"}
          selectedTime={!!c.map_selected_time_variable || !!c.map_time_live}
          live={liveOn}
          setLive={c.map_time_live ? setLive : undefined}
          pauses={pauseTimes}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Gantt Chart
// ------------------------------------------------------------------------------------------------

type Ev = { k: number; pk?: string; start: number; end: number | null; label: string; group: string; color: string; hover: string; row: number };

// time zones: a zone's offset from Intl, the axis ticks on the zone's wall clock
const HOUR = 3_600_000;
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
/** The zone when it is a valid IANA name (or UTC), else null. */
export function validZone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz.trim()) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
const tzFormats = new Map<string, Intl.DateTimeFormat>();
/** The zone's offset from UTC (ms) at an instant. */
export function tzOffset(t: number, tz: string): number {
  let f = tzFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    tzFormats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - (t - (((t % 1000) + 1000) % 1000));
}
/** The instant of a wall-clock time in the zone (the wall clock as UTC ms). */
export const fromWall = (w: number, tz: string) => w - tzOffset(w - tzOffset(w, tz), tz);
/** A date / timestamp value as ms: dates (no time) and timestamps without an offset are the zone's wall clock. */
export function toMsIn(v: unknown, tz: string): number | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(s)) {
    const w = Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}Z`);
    return Number.isNaN(w) ? null : fromWall(w, tz);
  }
  return toMs(v);
}
const inZone = (t: number, tz: string, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleString(undefined, { ...o, timeZone: tz });

/** Axis ticks over [min, max] on the zone's wall clock: hours, 6 hours, days, weeks, months or years. */
export function ticks(min: number, max: number, tz: string = localZone()): { at: number; label: string }[] {
  const s = max - min;
  const out: { at: number; label: string }[] = [];
  const d = new Date(min + tzOffset(min, tz)); // the wall clock, read and moved with the UTC getters / setters
  const wmax = max + tzOffset(max, tz);
  const push = (w: number, o: Intl.DateTimeFormatOptions) => {
    const t = fromWall(w, tz);
    if (t >= min && t <= max && out.length < 400) out.push({ at: t, label: inZone(t, tz, o) });
  };
  if (s <= 12 * HOUR) {
    d.setUTCMinutes(0, 0, 0);
    const step = s <= 4 * HOUR ? 1 : 2;
    for (let w = d.getTime(); w <= wmax; w += step * HOUR) push(w, { hour: "2-digit", minute: "2-digit" });
  } else if (s <= 3 * day) {
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(d.getUTCHours() - (d.getUTCHours() % 6));
    for (let w = d.getTime(); w <= wmax; w += 6 * HOUR) push(w, { day: "numeric", hour: "2-digit" });
  } else if (s <= 70 * day) {
    d.setUTCHours(0, 0, 0, 0);
    const step = s <= 14 * day ? 1 : 7;
    for (let w = d.getTime(); w <= wmax; w += step * day) push(w, { day: "numeric", month: "short" });
  } else if (s <= 800 * day) {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    for (; d.getTime() <= wmax; d.setUTCMonth(d.getUTCMonth() + 1)) push(d.getTime(), { month: "short", year: "2-digit" });
  } else {
    d.setUTCMonth(0, 1);
    d.setUTCHours(0, 0, 0, 0);
    for (; d.getTime() <= wmax; d.setUTCFullYear(d.getUTCFullYear() + 1)) push(d.getTime(), { year: "numeric" });
  }
  return out;
}

/** The Gantt chart's layers: its own, else the widget's source and columns as one layer. */
export function ganttLayersOf(c: WidgetConfig): GanttLayer[] {
  if (c.gantt_layers?.length) return c.gantt_layers;
  return [{ label: "Events", start_column: c.start_column, end_column: c.end_column, no_end: c.no_end, label_column: c.label_column, group_column: c.group_column, color: c.color, rules: c.rules, hover_columns: c.hover_columns }];
}
/** A time as a variable's value: a date variable gets the zone's calendar day, others an ISO timestamp. */
const timeValue = (t: number, type: string | undefined, tz: string) => (type === "date" ? new Date(t + tzOffset(t, tz)).toISOString().slice(0, 10) : new Date(t).toISOString());
/** The chart's time zone: local, static or from a string variable (an unknown zone falls back to local, with a note). */
function chartZone(c: WidgetConfig, vars: Record<string, unknown>): { tz: string; bad?: string } {
  const want = c.tz_mode === "static" ? c.time_zone : c.tz_mode === "dynamic" && c.time_zone_variable ? vars[c.time_zone_variable] : undefined;
  if (want === undefined || want === null || want === "") return { tz: localZone() };
  return validZone(want) ? { tz: validZone(want)! } : { tz: localZone(), bad: String(want) };
}

export function GanttWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  // the "now" line, moved each minute
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const layers = useMemo(() => ganttLayersOf(c), [c]);
  const srcOf = (l: GanttLayer) => l.source ?? c.source;
  const { results, error } = useQueries(
    layers.map((l) => {
      const src = srcOf(l);
      const fv = l.input_variable ? [l.input_variable] : l.source ? undefined : c.filter_variables;
      return src && l.start_column
        ? queryFor(src, l.source ? l.filters : c.filters, state, {
            columns: uniq([l.start_column, l.end_column, l.label_column, l.group_column, ...(l.hover_columns ?? []), ...(l.rules ?? []).map((r) => r.column)]),
            ...(fv?.length ? { filter_variables: fv } : {}),
          })
        : null;
    }),
    state,
    widget,
  );
  const { tz, bad: badZone } = chartZone(c, state.variables);
  // the end of events without one, per layer ("use a specific timestamp as the end time")
  const endVars = layers.map((l) => (l.no_end === "variable" && l.end_variable ? toMsIn(state.variables[l.end_variable], tz) : null)).join(",");
  const model = useMemo(() => {
    const evs: Ev[] = [];
    const ends = endVars.split(",").map((x) => (x === "" || x === "null" ? null : Number(x)));
    const many = layers.length > 1;
    layers.forEach((l, k) => {
      (results[k]?.rows ?? []).forEach((row) => {
        const start = toMsIn(row[l.start_column ?? ""], tz);
        if (start === null) return;
        let end = l.end_column ? toMsIn(row[l.end_column], tz) : null;
        if (l.end_column && end === null) {
          if ((l.no_end ?? "point") === "exclude") return;
          if (l.no_end === "variable") end = ends[k];
        }
        if (end !== null && end < start) end = start;
        // dates without a time span the whole day
        if (end !== null && end === start && typeof row[l.end_column ?? ""] === "string" && String(row[l.end_column ?? ""]).length <= 10) end = start + day;
        const rule = (l.rules ?? []).map((x) => (x.column ? ruleFor([x], x.column, row[x.column]) : undefined)).find(Boolean);
        const timeOf = (h: string) => {
          const t = toMsIn(row[h], tz);
          return t === null ? fmt(row[h]) : inZone(t, tz, String(row[h]).length <= 10 ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" });
        };
        evs.push({
          k, pk: row.__pk, start, end, label: l.label_column ? fmt(row[l.label_column]) : String(row.__pk ?? ""), group: l.group_column ? fmt(row[l.group_column]) : "",
          color: rule?.color ?? l.color ?? "#1f6feb",
          hover: [
            ...(many ? [l.label] : []),
            ...(l.label_column ? [`${l.label_column}: ${fmt(row[l.label_column])}`] : []),
            ...[l.start_column, l.end_column].filter((h): h is string => !!h).map((h) => `${h}: ${timeOf(h)}`),
            ...(l.hover_columns ?? []).filter((h) => h !== l.label_column && h !== l.start_column && h !== l.end_column).map((h) => `${h}: ${fmt(row[h])}`),
          ].join("\n"),
          row: 0,
        });
      });
    });
    // groups (rows) across the layers: by name, or by their first event's start
    const first: Record<string, number> = {};
    for (const e of evs) first[e.group] = Math.min(first[e.group] ?? Infinity, e.start);
    const groups = Object.keys(first).sort((a, b) => (c.row_order === "start" ? first[a] - first[b] || a.localeCompare(b) : a.localeCompare(b)));
    const rowsPer: Record<string, number> = {};
    for (const g of groups) {
      const mine = evs.filter((e) => e.group === g).sort((a, b) => a.start - b.start);
      const lanes: number[] = [];
      mine.forEach((e, i) => {
        const stop = e.end ?? e.start;
        if ((c.stacking ?? "smart") === "overlap") e.row = 0;
        else if (c.stacking === "new_rows") e.row = i;
        else {
          let lane = lanes.findIndex((t) => t <= e.start);
          if (lane < 0) lane = lanes.length;
          lanes[lane] = stop;
          e.row = lane;
        }
      });
      rowsPer[g] = Math.max(1, ...mine.map((e) => e.row + 1));
    }
    const min = Math.min(...evs.map((e) => e.start));
    const max = Math.max(...evs.map((e) => e.end ?? e.start));
    const pad = Math.max((max - min) * 0.03, HOUR);
    return { evs, groups, rowsPer, min: min - pad, max: max + pad };
  }, [layers, results, tz, endVars, c.stacking, c.row_order]);
  // the window: the timeline start / end variables (both ways), else the viewer's pan / zoom, else every event
  const [view, setView] = useState<[number, number] | null>(null);
  const startVar = c.window_start_variable;
  const endVar = c.window_end_variable;
  const vStart = startVar ? toMsIn(state.variables[startVar], tz) : null;
  const vEnd = endVar ? toMsIn(state.variables[endVar], tz) : null;
  let min = vStart ?? view?.[0] ?? model.min;
  let max = vEnd ?? view?.[1] ?? model.max;
  if (!(max > min)) [min, max] = [model.min, model.max];
  const setWindow = (a: number, b: number | null) => {
    if (b === null) {
      setView(null);
      if (startVar) state.setVariable(startVar, undefined);
      if (endVar) state.setVariable(endVar, undefined);
      return;
    }
    setView([a, b]);
    if (startVar) state.setVariable(startVar, timeValue(a, state.variableTypes?.[startVar], tz));
    if (endVar) state.setVariable(endVar, timeValue(b, state.variableTypes?.[endVar], tz));
  };
  const zoom = (f: number) => {
    const mid = (min + max) / 2;
    const half = Math.max(((max - min) * f) / 2, HOUR / 2);
    setWindow(mid - half, mid + half);
  };
  const pan = (f: number) => setWindow(min + (max - min) * f, max + (max - min) * f);
  // selection: the layer's selected objects variable (both ways), else the module's selected object of its source
  const selSig = layers.map((l) => {
    const src = srcOf(l);
    return (l.selected_variable ? pkList(state.variables[l.selected_variable]) : src && state.selection[sourceKey(src)] ? [state.selection[sourceKey(src)]!] : []).join(SEP);
  }).join("\u0002");
  const selected = useMemo(() => selSig.split("\u0002").map((s) => new Set(s ? s.split(SEP) : [])), [selSig]);
  const anySelected = selected.some((s) => s.size > 0);
  const pick = (e: Ev, additive: boolean) => {
    const l = layers[e.k];
    const src = srcOf(l);
    if (!l || l.selectable === false || !e.pk || !src) return;
    const events = l.on_select?.length ? l.on_select : c.on_select;
    if (!l.selected_variable) {
      const on = state.selection[sourceKey(src)] === e.pk;
      state.select(sourceKey(src), on ? undefined : e.pk);
      if (!on && events?.length) void state.runEvents?.(events);
      return;
    }
    const cur = pkList(state.variables[l.selected_variable]);
    const has = cur.includes(e.pk);
    const next = additive && l.multiselect ? (has ? cur.filter((x) => x !== e.pk) : [...cur, e.pk]) : has && cur.length === 1 ? [] : [e.pk];
    state.setVariable(l.selected_variable, state.variableTypes?.[l.selected_variable] === "string" ? next.join(",") : next);
    state.select(sourceKey(src), next.includes(e.pk) ? e.pk : next[next.length - 1]);
    if (next.includes(e.pk) && events?.length) void state.runEvents?.(events);
  };
  if (!layers.some((l) => srcOf(l))) return <Msg>Choose a source in the panel</Msg>;
  if (!layers.some((l) => l.start_column)) return <Msg>Choose the start date property</Msg>;
  if (error) return <Msg>{error}</Msg>;
  if (layers.some((l, k) => srcOf(l) && l.start_column && !results[k])) return <Msg>Loading…</Msg>;
  if (!model.evs.length) return <Msg>No events with a start date</Msg>;
  const LANE = 22;
  const x = (t: number) => `${((t - min) / (max - min)) * 100}%`;
  const now = clock;
  const labelW = layers.some((l) => l.group_column) ? Math.max(60, Math.min(400, c.group_width ?? 140)) : 0;
  const axis = ticks(min, max, tz);
  const shown = (e: Ev) => (e.end ?? e.start) >= min && e.start <= max;
  const btn = "rounded border border-line-2 px-1.5 leading-4 text-muted hover:text-white";
  return (
    <div className="flex h-full flex-col overflow-auto text-[11px]" data-gantt data-gantt-tz={tz} data-gantt-window={`${new Date(min).toISOString()}/${new Date(max).toISOString()}`}>
      <div className="flex shrink-0 items-center gap-1 border-b border-line/60 px-2 py-0.5 text-[10px]">
        <button type="button" className={btn} onClick={(e) => (e.stopPropagation(), pan(-0.25))} title="Earlier" data-gantt-pan="-1">
          ‹
        </button>
        <button type="button" className={btn} onClick={(e) => (e.stopPropagation(), pan(0.25))} title="Later" data-gantt-pan="1">
          ›
        </button>
        <button type="button" className={btn} onClick={(e) => (e.stopPropagation(), zoom(0.5))} title="Zoom in" data-gantt-zoom="in">
          +
        </button>
        <button type="button" className={btn} onClick={(e) => (e.stopPropagation(), zoom(2))} title="Zoom out" data-gantt-zoom="out">
          −
        </button>
        <button type="button" className={btn} onClick={(e) => (e.stopPropagation(), setWindow(0, null))} title="Show every event" data-gantt-fit>
          Fit
        </button>
        <span className="ml-auto truncate text-muted" title={badZone ? `Unknown time zone "${badZone}": local time is used` : "Time zone"}>
          {badZone ? `⚠ ${badZone} → ` : ""}
          {tz}
        </span>
      </div>
      <div className="sticky top-0 z-10 flex shrink-0 border-b border-line bg-panel" style={{ height: 22 }}>
        <div style={{ width: labelW }} className="shrink-0" />
        <div className="relative flex-1 overflow-hidden">
          {axis.map((t) => (
            <span key={t.at} className="absolute top-1 -translate-x-1/2 whitespace-nowrap text-muted" style={{ left: x(t.at) }} data-gantt-tick={t.label}>
              {t.label}
            </span>
          ))}
        </div>
      </div>
      {model.groups.map((g) => (
        <div key={g} className="flex border-b border-line/60" style={{ minHeight: model.rowsPer[g] * LANE + 6 }} data-gantt-group={g}>
          {labelW > 0 && <div style={{ width: labelW }} className="shrink-0 truncate border-r border-line px-2 py-1 font-semibold text-soft">{g || "—"}</div>}
          <div className="relative flex-1 overflow-hidden">
            {axis.map((t) => (
              <span key={t.at} className="absolute inset-y-0 w-px bg-line/50" style={{ left: x(t.at) }} />
            ))}
            {c.show_now !== false && now >= min && now <= max && <span className="absolute inset-y-0 w-0.5 bg-warn" style={{ left: x(now) }} title="Now" />}
            {model.evs
              .filter((e) => e.group === g && shown(e))
              .map((e, i) => {
                const on = !!e.pk && !!selected[e.k]?.has(e.pk);
                const top = 3 + e.row * LANE;
                const click = (ev: React.MouseEvent) => (ev.stopPropagation(), pick(e, ev.ctrlKey || ev.metaKey || ev.shiftKey));
                if (e.end === null)
                  return (
                    <button key={i} type="button" onClick={click} title={e.hover} className="absolute h-3 w-3 -translate-x-1/2 rotate-45 rounded-sm" style={{ left: x(e.start), top: top + 4, background: e.color, outline: on ? "2px solid white" : undefined }} data-gantt-event={e.pk} data-gantt-layer={e.k} />
                  );
                const a = Math.max(e.start, min);
                const b = Math.min(e.end, max);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={click}
                    title={e.hover}
                    className="absolute truncate rounded px-1 text-left text-[10px] leading-[18px] text-white"
                    style={{ left: x(a), width: `max(4px, calc(${x(b)} - ${x(a)}))`, top, height: 18, background: e.color, outline: on ? "2px solid white" : undefined, opacity: anySelected && !on ? 0.6 : 1 }}
                    data-gantt-event={e.pk}
                    data-gantt-layer={e.k}
                    data-selected={on || undefined}
                  >
                    {e.label}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Timeline
// ------------------------------------------------------------------------------------------------

/** The timeline's layers: its own, else the widget's source and columns as one layer (a dot, the static color). */
export function timelineLayersOf(c: WidgetConfig): TimelineLayer[] {
  if (c.timeline_layers?.length) return c.timeline_layers;
  return [{ label: "Events", date_column: c.start_column, title_mode: "property", title_column: c.label_column, props_mode: "specific", props: c.hover_columns, color_mode: "static", color: c.color ?? "#1f6feb", rules: c.rules, icon_mode: "none" }];
}
const DEFAULT_TYPE_COLOR = "#4f8cff";
/** Custom timeline / Gantt icons (the Icon set's names that read as objects and events). */
export const EVENT_ICONS: IconName[] = ["cube", "bolt", "doc", "globe", "device", "database", "folder", "image", "wave", "graph", "layers", "check", "table", "sparkle", "clock", "project"];
const placeholders = (s: string | undefined) => [...(s ?? "").matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);

/** Object type details from the sources (icon, color, title property, prominent properties). */
function useTypes() {
  const [s, setS] = useState<Sources | null>(null);
  useEffect(() => {
    allSources().then(setS, () => setS({ datasets: [], object_types: [] }));
  }, []);
  return s;
}

type TlItem = { k: number; pk?: string; t: number; title: string; props: (readonly [string, string])[]; color: string; icon: { kind: "type"; name?: string } | { kind: "none" } | { kind: "custom"; name: string }; timed: boolean };

export function TimelineWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const layers = useMemo(() => timelineLayersOf(c), [c]);
  const types = useTypes();
  const srcOf = (l: TimelineLayer) => l.source ?? c.source;
  const typeOf = (l: TimelineLayer) => {
    const src = srcOf(l);
    return src?.kind === "object_type" ? types?.object_types.find((t) => t.id === src.id) : undefined;
  };
  const titleCol = (l: TimelineLayer) => (l.title_mode === "property" ? l.title_column : (l.title_mode ?? "object") === "object" ? typeOf(l)?.title_property : undefined);
  const propCols = (l: TimelineLayer) => ((l.props_mode ?? "prominent") === "prominent" ? (typeOf(l)?.properties ?? []).filter((p) => p.prominent).map((p) => p.name) : l.props ?? []);
  // the layers wait for the object types (their title property and prominent properties decide the columns)
  const { results, error } = useQueries(
    layers.map((l) => {
      const src = srcOf(l);
      const fv = l.input_variable ? [l.input_variable] : l.source ? undefined : c.filter_variables;
      return types && src && l.date_column
        ? queryFor(src, l.source ? l.filters : c.filters, state, {
            columns: uniq([l.date_column, titleCol(l), ...(l.title_mode === "custom" ? placeholders(l.title_text) : []), ...propCols(l), ...(l.rules ?? []).map((r) => r.column)]),
            ...(fv?.length ? { filter_variables: fv } : {}),
          })
        : null;
    }),
    state,
    widget,
  );
  // the legend hides layers (the viewer's choice, not saved)
  const [hidden, setHidden] = useState<number[]>([]);
  const items = useMemo(() => {
    const out: TlItem[] = [];
    layers.forEach((l, k) => {
      if (hidden.includes(k)) return;
      const ot = typeOf(l);
      const tc = titleCol(l);
      const pc = propCols(l);
      for (const row of results[k]?.rows ?? []) {
        const t = toMs(row[l.date_column ?? ""]);
        if (t === null) continue;
        const rule = (l.color_mode ?? "default") !== "default" || l.rules?.length ? (l.rules ?? []).map((x) => (x.column ? ruleFor([x], x.column, row[x.column]) : undefined)).find(Boolean) : undefined;
        const title =
          l.title_mode === "custom" ? (l.title_text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => fmt(row[p])) : tc ? fmt(row[tc]) : String(row.__pk ?? "");
        const color = rule?.color ?? ((l.color_mode ?? "default") === "default" ? ot?.color || DEFAULT_TYPE_COLOR : l.color ?? "#1f6feb");
        const mode = l.icon_mode ?? "default";
        out.push({
          k, pk: row.__pk, t, title: title || String(row.__pk ?? ""), props: pc.map((h) => [h, fmt(row[h])] as const), color,
          icon: mode === "none" ? { kind: "none" } : mode === "custom" && l.icon ? { kind: "custom", name: l.icon } : { kind: "type", name: ot?.icon },
          timed: String(row[l.date_column ?? ""]).length > 10,
        });
      }
    });
    return out.sort((a, b) => ((c.order ?? "newest") === "newest" ? b.t - a.t : a.t - b.t));
    // typeOf / titleCol / propCols read layers and types
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, results, types, hidden, c.order]);
  if (!layers.some((l) => srcOf(l))) return <Msg>Choose a source in the panel</Msg>;
  if (!layers.some((l) => l.date_column)) return <Msg>Choose the date or timestamp property</Msg>;
  if (error) return <Msg>{error}</Msg>;
  if (!types || layers.some((l, k) => srcOf(l) && l.date_column && !hidden.includes(k) && !results[k])) return <Msg>Loading…</Msg>;
  const highlight = c.highlight_selection !== false;
  const isOn = (it: TlItem) => {
    const src = srcOf(layers[it.k]);
    return highlight && !!it.pk && !!src && state.selection[sourceKey(src)] === it.pk;
  };
  const pick = (it: TlItem) => {
    const l = layers[it.k];
    const src = srcOf(l);
    if (!src || !it.pk) return;
    const on = state.selection[sourceKey(src)] === it.pk;
    state.select(sourceKey(src), on ? undefined : it.pk);
    // the active object (an object set variable; a string variable gets the primary key)
    if (c.active_variable) state.setVariable(c.active_variable, state.variableTypes?.[c.active_variable] === "string" ? (on ? "" : it.pk) : on ? [] : [it.pk]);
    const events = l.on_select?.length ? l.on_select : c.on_select;
    if (!on && events?.length) void state.runEvents?.(events);
  };
  const horizontal = c.orientation === "horizontal";
  const marker = (it: TlItem, cls: string) =>
    it.icon.kind === "none" ? (
      <span className={`${cls} h-3 w-3 rounded-full`} style={{ background: it.color }} />
    ) : it.icon.kind === "custom" ? (
      <span className={`${cls} rounded-md p-0.5`} style={{ color: it.color, background: `${it.color}26` }} data-timeline-icon={it.icon.name}>
        <Icon name={it.icon.name as IconName} className="h-3.5 w-3.5" />
      </span>
    ) : (
      <span className={cls} data-timeline-icon={it.icon.name ?? "cube"}>
        <TypeIcon t={{ icon: it.icon.name, color: it.color }} className="h-3.5 w-3.5" box="rounded-md p-0.5 block" />
      </span>
    );
  const legend = c.show_legend && (
    <div className={`flex flex-wrap gap-1 ${horizontal ? "mb-2 w-full" : "mb-2"}`} data-timeline-legend>
      {layers.map((l, k) => {
        const off = hidden.includes(k);
        const ot = typeOf(l);
        const col = (l.color_mode ?? "default") === "default" ? ot?.color || DEFAULT_TYPE_COLOR : l.color ?? "#1f6feb";
        return (
          <button key={k} type="button" onClick={(e) => (e.stopPropagation(), setHidden(off ? hidden.filter((x) => x !== k) : [...hidden, k]))} className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${off ? "border-line text-muted line-through opacity-60" : "border-line-2 text-soft"}`} aria-pressed={!off} data-timeline-legend-layer={k}>
            <span className="h-2 w-2 rounded-full" style={{ background: col }} />
            {l.label || ot?.name || `Layer ${k + 1}`}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className={`h-full p-3 text-xs ${horizontal ? "overflow-x-auto" : "overflow-y-auto"}`} data-timeline={horizontal ? "horizontal" : "vertical"}>
      {legend}
      {!items.length && <Msg>No events</Msg>}
      <div className={horizontal ? "flex items-start gap-0" : ""}>
        {items.map((it, i) => {
          const on = isOn(it);
          const gap = c.show_gaps !== false && i > 0 ? span(it.t - items[i - 1].t) : null;
          const card = (
            <button type="button" onClick={(e) => (e.stopPropagation(), pick(it))} className={`w-full rounded-md border px-2 py-1.5 text-left ${on ? "border-ocean bg-ocean/10" : "border-line hover:border-line-2"}`} data-timeline-event={it.pk} data-timeline-layer={it.k} data-selected={on || undefined}>
              <div className="text-[10px] text-muted">{when(it.t, it.timed)}</div>
              <div className="font-semibold" style={{ color: it.color }}>
                {it.title}
              </div>
              {it.props.map(([k, v]) => (
                <div key={k} className="truncate text-muted">
                  {k}: <span className="text-soft">{v}</span>
                </div>
              ))}
            </button>
          );
          if (horizontal)
            return (
              <div key={i} className="flex shrink-0 items-start">
                {gap && <div className="mt-6 w-16 border-t border-dashed border-line-2 pt-0.5 text-center text-[10px] text-muted">{gap}</div>}
                <div className="w-48">
                  <div className="mb-1 flex justify-center">{marker(it, "")}</div>
                  {card}
                </div>
              </div>
            );
          return (
            <div key={i}>
              {gap && <div className="ml-[5px] border-l border-dashed border-line-2 py-1 pl-4 text-[10px] text-muted">{gap}</div>}
              <div className="flex gap-3">
                {marker(it, it.icon.kind === "none" ? "mt-2 shrink-0" : "mt-1 shrink-0")}
                {card}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Stepper
// ------------------------------------------------------------------------------------------------

export function StepperWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const steps = c.steps ?? [];
  const [local, setLocal] = useState(0);
  const active = c.step_variable ? Number(state.variables[c.step_variable] ?? 0) || 0 : local;
  // steps without an "is completed" variable count as completed once visited
  const [visited, setVisited] = useState<number[]>([]);
  const done = (s: Step, i: number) => (s.completed_variable ? state.variables[s.completed_variable] === true : visited.includes(i) && i !== active);
  const linear = (c.stepper_type ?? "linear") === "linear";
  const reachable = (i: number) => !linear || i <= active || steps.slice(0, i).every((s, j) => done(s, j) || j === active);
  const go = (i: number) => {
    if (editing || !reachable(i)) return;
    setVisited((v) => (v.includes(active) ? v : [...v, active]));
    if (c.step_variable) state.setVariable(c.step_variable, i);
    else setLocal(i);
    if (steps[i]?.events?.length) void state.runEvents?.(steps[i].events!);
  };
  if (!steps.length) return <Msg>Add steps in the panel</Msg>;
  const doneColor = c.completed_color ?? "#3fb950";
  const activeColor = c.active_color ?? "#1f6feb";
  return (
    <div className="flex h-full items-center px-3" data-stepper>
      {steps.map((s, i) => {
        const isDone = done(s, i);
        const isActive = i === active;
        const color = isActive ? activeColor : isDone ? doneColor : undefined;
        return (
          <div key={i} className={`flex items-center ${i < steps.length - 1 ? "flex-1" : ""}`}>
            <button type="button" onClick={(e) => (e.stopPropagation(), go(i))} disabled={!reachable(i)} className="flex shrink-0 items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50" data-step={i} data-step-state={isActive ? "active" : isDone ? "done" : "todo"}>
              <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold" style={{ borderColor: color ?? "var(--color-line-2)", background: isDone ? doneColor : "transparent", color: isDone ? "#fff" : color }}>
                {isDone && !c.step_icons ? <Icon name="check" className="h-3.5 w-3.5" /> : c.step_icons && s.icon ? <Icon name={s.icon as IconName} className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={`text-sm ${isActive ? "font-semibold text-white" : "text-soft"}`}>{(s.label && (state.tr?.(s.label) ?? s.label)) || `Step ${i + 1}`}</span>
            </button>
            {i < steps.length - 1 && <span className="mx-3 h-0.5 min-w-4 flex-1 rounded" style={{ background: isDone ? doneColor : "var(--color-line-2)" }} />}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

export const VIZ_TYPES = new Set(["object_set_title", "vega", "map", "gantt", "stepper", "timeline"]);

function ColSelect({ value, cols, onChange, empty = "Choose…" }: { value?: string; cols: Column[]; onChange: (v: string | undefined) => void; empty?: string }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{empty}</option>
      {cols.map((x) => (
        <option key={x.name} value={x.name}>
          {x.name} · {x.type}
        </option>
      ))}
    </select>
  );
}
function MultiCols({ value, cols, onChange }: { value?: string[]; cols: Column[]; onChange: (v: string[]) => void }) {
  const v = value ?? [];
  return (
    <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
      {cols.map((x) => (
        <button key={x.name} type="button" onClick={() => onChange(v.includes(x.name) ? v.filter((y) => y !== x.name) : [...v, x.name])} className={`rounded border px-1.5 py-0.5 text-[11px] ${v.includes(x.name) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
          {x.name}
        </button>
      ))}
    </div>
  );
}
const timeCols = (cols: Column[]) => cols.filter((x) => /date|time/i.test(x.type));

export function VizWidgetConfig({ widget, set, mod, cols, sources }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[]; sources: Sources }) {
  const c = widget.config;
  const t = widget.type;
  const vars = mod.variables ?? [];
  const varSelect = (value: string | undefined, onChange: (v: string | undefined) => void, types: string[], empty = "None") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{empty}</option>
      {vars.filter((v) => types.includes(v.type)).map((v) => (
        <option key={v.name}>{v.name}</option>
      ))}
    </select>
  );
  const selectionEvents = <EventsEditor events={c.on_select ?? []} mod={mod} onChange={(ev) => set({ on_select: ev })} label="When an object is selected" />;
  if (t === "object_set_title")
    return (
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.single_object} onChange={(e) => set({ single_object: e.target.checked })} /> Contains a single object (the selected one)
        </label>
        {c.single_object ? (
          <Field label="Title property">
            <ColSelect value={c.label_column} cols={cols} onChange={(v) => set({ label_column: v })} empty="The primary key" />
          </Field>
        ) : (
          <Field label="Title override ({{count}} for the count)">
            <input value={c.title_override ?? ""} onChange={(e) => set({ title_override: e.target.value || undefined })} placeholder="Object type · count" className={inputClass} />
          </Field>
        )}
        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={c.show_icon !== false} onChange={(e) => set({ show_icon: e.target.checked })} /> Show icon
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!c.render_empty} onChange={(e) => set({ render_empty: e.target.checked })} /> Render when the set is empty
          </label>
        </div>
      </div>
    );
  if (t === "vega") {
    const inputs = c.vega_inputs ?? [];
    const setIn = (i: number, x: Partial<VegaInput>) => set({ vega_inputs: inputs.map((y, j) => (j === i ? { ...y, ...x } : y)) });
    const params = c.vega_params ?? [];
    return (
      <div className="space-y-3">
        <div className="flex gap-2">
          <select value={c.vega_mode ?? "vega-lite"} onChange={(e) => set({ vega_mode: e.target.value as "vega" })} className={inputClass}>
            <option value="vega-lite">Vega-Lite</option>
            <option value="vega">Vega</option>
          </select>
          <select value={c.vega_theme ?? "default"} onChange={(e) => set({ vega_theme: e.target.value as "none" })} className={inputClass}>
            <option value="default">Default theme</option>
            <option value="none">No theme</option>
          </select>
        </div>
        <Field label="Data inputs (referenced by name in the spec)">
          <div className="space-y-2">
            {inputs.map((inp, i) => (
              <div key={i} className="space-y-1 rounded border border-line p-2 text-xs">
                <div className="flex gap-1">
                  <input value={inp.name} onChange={(e) => setIn(i, { name: e.target.value })} className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} />
                  <select value={inp.kind} onChange={(e) => setIn(i, { kind: e.target.value as VegaInput["kind"] })} className={`${fieldClass} text-xs`}>
                    <option value="objects">Objects</option>
                    <option value="aggregation">Aggregation</option>
                    <option value="variable">Variable</option>
                  </select>
                  <button type="button" onClick={() => set({ vega_inputs: inputs.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                    ✕
                  </button>
                </div>
                {inp.kind === "objects" && <MultiCols value={inp.columns} cols={cols} onChange={(v) => setIn(i, { columns: v })} />}
                {inp.kind === "aggregation" && (
                  <div className="grid grid-cols-2 gap-1">
                    <ColSelect value={inp.group_by} cols={cols} onChange={(v) => setIn(i, { group_by: v })} empty="Group by…" />
                    <select value={inp.bucket ?? ""} onChange={(e) => setIn(i, { bucket: (e.target.value || undefined) as VegaInput["bucket"] })} className={inputClass}>
                      <option value="">Exact values</option>
                      <option value="day">By day</option>
                      <option value="month">By month</option>
                      <option value="year">By year</option>
                    </select>
                    <select value={inp.metric ?? "count"} onChange={(e) => setIn(i, { metric: e.target.value as "count" })} className={inputClass}>
                      {["count", "sum", "avg", "min", "max", "distinct"].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                    {(inp.metric ?? "count") !== "count" && <ColSelect value={inp.metric_column} cols={cols} onChange={(v) => setIn(i, { metric_column: v })} empty="Of…" />}
                  </div>
                )}
                {inp.kind === "variable" && varSelect(inp.variable, (v) => setIn(i, { variable: v }), ["struct_array", "array"], "A struct array variable…")}
                <button type="button" onClick={() => set({ spec: VEGA_TEMPLATE(inp) })} className="text-[11px] text-ocean">
                  Start the spec from a template for “{inp.name}”
                </button>
              </div>
            ))}
            <button type="button" onClick={() => set({ vega_inputs: [...inputs, { name: `data${inputs.length + 1}`, kind: "aggregation", metric: "count" }] })} className="text-xs text-ocean">
              + Data input
            </button>
          </div>
        </Field>
        <VegaAipGenerator widget={widget} set={set} mod={mod} cols={cols} />
        <Field label="Spec from a string variable (instead of inline)">{varSelect(c.spec_variable, (v) => set({ spec_variable: v }), ["string"])}</Field>
        {!c.spec_variable && (
          <Field label="Spec (JSON)" hint="Data inputs are injected as datasets (Vega-Lite) or data values (Vega)">
            <textarea rows={12} value={c.spec ?? ""} onChange={(e) => set({ spec: e.target.value })} spellCheck={false} className={`${inputClass} font-mono text-[11px]`} data-vega-spec />
          </Field>
        )}
        <Field label="Selection parameters (Vega-Lite) → object set filter variables (a filter on the source's properties) or string variables (the selection as JSON)">
          <div className="space-y-1">
            {params.map((p, i) => (
              <div key={i} className="flex gap-1">
                <input value={p.name} onChange={(e) => set({ vega_params: params.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) })} placeholder="param name" className={`${fieldClass} w-24 font-mono text-xs`} />
                <div className="min-w-0 flex-1">{varSelect(p.variable, (v) => set({ vega_params: params.map((y, j) => (j === i ? { ...y, variable: v ?? "" } : y)) }), ["object_set_filter", "string"], "Variable…")}</div>
                <button type="button" onClick={() => set({ vega_params: params.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
            ))}
            <button type="button" onClick={() => set({ vega_params: [...params, { name: "pick", variable: "" }] })} className="text-xs text-ocean">
              + Selection parameter
            </button>
          </div>
        </Field>
      </div>
    );
  }
  if (t === "map") {
    const layers = c.map_layers?.length ? c.map_layers : [{ label: "Objects" }];
    const setL = (i: number, x: Partial<MapLayer>) => set({ map_layers: layers.map((y, j) => (j === i ? { ...y, ...x } : y)) });
    const tplMode = !!c.map_template;
    return (
      <div className="space-y-3">
        <Field label="Layers">
          <div className="flex gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input type="radio" checked={!tplMode} onChange={() => set({ map_template: undefined })} /> Local configuration
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={tplMode} onChange={() => set({ map_template: { map_id: "" } })} data-map-template-mode /> Import map template
            </label>
          </div>
        </Field>
        {tplMode && <MapTemplateConfig template={c.map_template!} onChange={(x) => set({ map_template: x })} mod={mod} />}
        <Field label="Base map">
          <select value={c.basemap ?? "google-satellite"} onChange={(e) => set({ basemap: e.target.value })} className={inputClass}>
            <option value="streets">Streets</option>
            <option value="google-satellite">Satellite</option>
            <option value="google-hybrid">Hybrid</option>
            <option value="none">None</option>
          </select>
        </Field>
        {!tplMode && layers.map((l, i) => {
          const own = l.source;
          const lcols: Column[] = own ? (own.kind === "object_type" ? sources.object_types.find((x) => x.id === own.id)?.properties.map((p) => ({ name: p.name, type: p.type })) ?? [] : []) : cols;
          const colIn = (value: string | undefined, onChange: (v: string | undefined) => void, empty: string) =>
            lcols.length ? <ColSelect value={value} cols={lcols} onChange={onChange} empty={empty} /> : <input value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} placeholder={empty} className={inputClass} />;
          return (
            <div key={i} className="space-y-1 rounded border border-line p-2 text-xs" data-map-layer-config={i}>
              <div className="flex gap-1">
                <input value={l.label} onChange={(e) => setL(i, { label: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                <input type="color" value={l.color ?? "#1f6feb"} onChange={(e) => setL(i, { color: e.target.value })} className="h-6 w-7 bg-transparent" />
                {layers.length > 1 && (
                  <button type="button" onClick={() => set({ map_layers: layers.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                    ✕
                  </button>
                )}
              </div>
              <select
                value={own ? `${own.kind}:${own.id}` : ""}
                onChange={(e) => {
                  const [kind, ...id] = e.target.value.split(":");
                  setL(i, { source: e.target.value ? ({ kind, id: id.join(":") } as SourceRef) : undefined, lat: undefined, lon: undefined, point: undefined });
                }}
                className={inputClass}
              >
                <option value="">The widget&apos;s source</option>
                {sources.object_types.map((x) => (
                  <option key={x.id} value={`object_type:${x.id}`}>
                    {x.name}
                  </option>
                ))}
                {sources.datasets.map((x) => (
                  <option key={x.id} value={`dataset:${x.id}`}>
                    {x.name} (dataset)
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-1">
                {colIn(l.lat, (v) => setL(i, { lat: v }), "Latitude…")}
                {colIn(l.lon, (v) => setL(i, { lon: v }), "Longitude…")}
                {colIn(l.point, (v) => setL(i, { point: v }), "or “lat,lon”…")}
                {colIn(l.label_column, (v) => setL(i, { label_column: v }), "Label…")}
              </div>
              <div className="text-muted">Shape (a geoshape property: polygons, lines, multi-geometries)</div>
              {lcols.length ? (
                <ColSelect value={l.shape} cols={lcols.some((x) => /geoshape/i.test(x.type)) ? lcols.filter((x) => /geo/i.test(x.type)) : lcols} onChange={(v) => setL(i, { shape: v })} empty="No shapes (points only)" />
              ) : (
                <input value={l.shape ?? ""} onChange={(e) => setL(i, { shape: e.target.value || undefined })} placeholder="Geoshape column…" className={inputClass} />
              )}
              <div className="text-muted">Color by property (the legend shows the colors)</div>
              <div className="grid grid-cols-2 gap-1">
                {colIn(l.color_by, (v) => setL(i, { color_by: v }), "Static color")}
                <select value={l.color_mode ?? ""} onChange={(e) => setL(i, { color_mode: (e.target.value || undefined) as MapLayer["color_mode"] })} className={inputClass} disabled={!l.color_by}>
                  <option value="">Automatic</option>
                  <option value="category">Categories</option>
                  <option value="range">Numeric range (gradient)</option>
                  <option value="bins">Color classes (choropleth)</option>
                </select>
              </div>
              {l.color_by && l.color_mode !== "category" && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted">Range</span>
                  <input type="color" value={l.color_from ?? "#fde68a"} onChange={(e) => setL(i, { color_from: e.target.value })} className="h-6 w-7 bg-transparent" />
                  →
                  <input type="color" value={l.color_to ?? "#b91c1c"} onChange={(e) => setL(i, { color_to: e.target.value })} className="h-6 w-7 bg-transparent" />
                  <input type="number" value={l.color_min ?? ""} onChange={(e) => setL(i, { color_min: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="min (auto)" title="The low end of the scale (blank: the lowest value shown)" className={`${fieldClass} w-20 text-xs`} data-map-color-min />
                  <input type="number" value={l.color_max ?? ""} onChange={(e) => setL(i, { color_max: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="max (auto)" title="The high end of the scale (blank: the highest value shown)" className={`${fieldClass} w-20 text-xs`} data-map-color-max />
                </div>
              )}
              {l.color_by && l.color_mode === "bins" && (
                <div className="flex items-center gap-1">
                  <span className="text-muted">Classes</span>
                  <input type="number" min={2} max={12} value={l.color_bins ?? 5} onChange={(e) => setL(i, { color_bins: Math.max(2, Math.min(12, Number(e.target.value) || 5)) })} className={`${fieldClass} w-12 text-xs`} data-map-color-bins />
                  <select value={l.color_scale ?? "linear"} onChange={(e) => setL(i, { color_scale: e.target.value as MapLayer["color_scale"] })} className={`${inputClass} min-w-0 flex-1`} data-map-color-scale>
                    <option value="linear">Linear (equal steps)</option>
                    <option value="sqrt">Square root</option>
                    <option value="log">Logarithmic</option>
                    <option value="quantile">Quantiles (equal counts)</option>
                  </select>
                </div>
              )}
              {l.shape && (
                <div className="flex items-center gap-2">
                  <span className="text-muted">Fill</span>
                  <input type="range" min={0} max={0.9} step={0.05} value={l.fill_opacity ?? 0.3} onChange={(e) => setL(i, { fill_opacity: Number(e.target.value) })} className="min-w-0 flex-1" />
                  <span className="text-muted">Line</span>
                  <input type="number" min={1} max={8} value={l.line_width ?? 2} onChange={(e) => setL(i, { line_width: Number(e.target.value) || undefined })} className={`${fieldClass} w-12 text-xs`} />
                  <label className="flex items-center gap-1 text-muted" title="The outline's own color (unticked: the fill color)">
                    <input type="checkbox" checked={!!l.outline_color} onChange={(e) => setL(i, { outline_color: e.target.checked ? "#0b1220" : undefined })} data-map-outline /> Outline
                  </label>
                  {l.outline_color && <input type="color" value={l.outline_color} onChange={(e) => setL(i, { outline_color: e.target.value })} className="h-6 w-7 bg-transparent" />}
                </div>
              )}
              {lcols.length > 0 && (
                <>
                  <div className="text-muted">Properties on hover</div>
                  <MultiCols value={l.hover} cols={lcols} onChange={(v) => setL(i, { hover: v })} />
                </>
              )}
              {c.map_timeline && (
                <div className="flex items-center gap-1" data-map-time-column>
                  <span className="shrink-0 text-muted">Time (timeline)</span>
                  <div className="min-w-0 flex-1">
                    {lcols.length ? (
                      <ColSelect value={l.time_column} cols={timeCols(lcols).length ? timeCols(lcols) : lcols} onChange={(v) => setL(i, { time_column: v })} empty="Not on the timeline" />
                    ) : (
                      <input value={l.time_column ?? ""} onChange={(e) => setL(i, { time_column: e.target.value || undefined })} placeholder="Date / timestamp column…" className={inputClass} />
                    )}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-1">
                <div>
                  <div className="text-muted">Input object set</div>
                  {varSelect(l.input_variable, (v) => setL(i, { input_variable: v }), ["object_set", "object_set_filter", "array"], "All objects")}
                </div>
                <div>
                  <div className="text-muted">Selected objects</div>
                  {varSelect(l.selected_variable, (v) => setL(i, { selected_variable: v }), ["object_set", "array", "string"], "Module selection")}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={!!l.locked} onChange={(e) => setL(i, { locked: e.target.checked })} /> Lock (no selection)
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={!l.hide_in_legend} onChange={(e) => setL(i, { hide_in_legend: !e.target.checked || undefined })} /> In legend
                </label>
                <div className="min-w-0 flex-1">{varSelect(l.visible_variable, (v) => setL(i, { visible_variable: v }), ["boolean"], "Always visible")}</div>
              </div>
            </div>
          );
        })}
        {!tplMode && (
          <button type="button" onClick={() => set({ map_layers: [...layers, { label: `Layer ${layers.length + 1}`, color: "#f0883e" }] })} className="text-xs text-ocean">
            + Object layer
          </button>
        )}
        <Field label="Overlay layers (saved maps' layers, tile / WMS / vector tile servers, GeoJSON)">
          <MapOverlaysConfig overlays={c.map_overlays ?? []} onChange={(v) => set({ map_overlays: v.length ? v : undefined })} mod={mod} />
        </Field>
        <div className="flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={c.map_legend !== false} onChange={(e) => set({ map_legend: e.target.checked ? undefined : false })} /> Legend
          </label>
          {c.map_legend !== false && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={!!c.map_legend_collapsed} onChange={(e) => set({ map_legend_collapsed: e.target.checked || undefined })} /> Collapsed at first
            </label>
          )}
          <label className="flex items-center gap-1" title="Box, lasso and polygon select tools in the map's toolbar: the objects a box, a free-hand outline or clicked corners meet (shift adds to the selection)">
            <input type="checkbox" checked={!!c.map_selection_tools} onChange={(e) => set({ map_selection_tools: e.target.checked || undefined })} data-map-selection-tools /> Advanced selection tools (box, lasso, polygon)
          </label>
        </div>
        <MapInteractionsConfig c={c} set={set} mod={mod} varSelect={varSelect} events={<EventsEditor events={c.map_on_draw ?? []} mod={mod} onChange={(ev) => set({ map_on_draw: ev.length ? ev : undefined })} label="On drawn shape" />} />
        {selectionEvents}
      </div>
    );
  }
  if (t === "gantt") return <GanttConfig widget={widget} set={set} mod={mod} cols={cols} sources={sources} varSelect={varSelect} selectionEvents={selectionEvents} />;
  if (t === "timeline") return <TimelineConfig widget={widget} set={set} mod={mod} cols={cols} sources={sources} varSelect={varSelect} selectionEvents={selectionEvents} />;
  if (t === "stepper") {
    const steps = c.steps ?? [];
    const setS = (i: number, x: Partial<Step>) => set({ steps: steps.map((y, j) => (j === i ? { ...y, ...x } : y)) });
    return (
      <div className="space-y-3">
        <Field label="Type">
          <select value={c.stepper_type ?? "linear"} onChange={(e) => set({ stepper_type: e.target.value as "linear" })} className={inputClass}>
            <option value="linear">Linear (complete the steps in order)</option>
            <option value="non_linear">Non-linear (any order)</option>
          </select>
        </Field>
        <Field label="Active step variable (a number, the step index; optional)">{varSelect(c.step_variable, (v) => set({ step_variable: v }), ["number"])}</Field>
        {steps.map((s, i) => (
          <div key={i} className="space-y-1 rounded border border-line p-2 text-xs" data-step-config={i}>
            <div className="flex gap-1">
              <input value={s.label} onChange={(e) => setS(i, { label: e.target.value })} placeholder={`Step ${i + 1}`} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
              <input value={s.icon ?? ""} onChange={(e) => setS(i, { icon: e.target.value || undefined })} placeholder="icon" className={`${fieldClass} w-16 text-xs`} />
              <button type="button" onClick={() => set({ steps: steps.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                ✕
              </button>
            </div>
            {varSelect(s.completed_variable, (v) => setS(i, { completed_variable: v }), ["boolean"], "Completed when… (a boolean variable)")}
            <EventsEditor events={s.events ?? []} mod={mod} onChange={(ev) => setS(i, { events: ev })} label="On click" />
          </div>
        ))}
        <button type="button" onClick={() => set({ steps: [...steps, { label: `Step ${steps.length + 1}` }] })} className="text-xs text-ocean">
          + Step
        </button>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!c.step_icons} onChange={(e) => set({ step_icons: e.target.checked })} /> Use icons
          </label>
          <span className="text-muted">Completed</span>
          <input type="color" value={c.completed_color ?? "#3fb950"} onChange={(e) => set({ completed_color: e.target.value })} className="h-5 w-6 bg-transparent" />
          <span className="text-muted">Active</span>
          <input type="color" value={c.active_color ?? "#1f6feb"} onChange={(e) => set({ active_color: e.target.value })} className="h-5 w-6 bg-transparent" />
        </div>
      </div>
    );
  }
  return null;
}

type VarSelect = (value: string | undefined, onChange: (v: string | undefined) => void, types: string[], empty?: string) => React.ReactNode;
type LayerConfigProps = { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[]; sources: Sources; varSelect: VarSelect; selectionEvents: React.ReactNode };

/** A layer's columns: its object type's properties, else (the widget's source) the widget's columns. */
function layerCols(src: SourceRef | undefined, cols: Column[], sources: Sources): Column[] {
  if (!src) return cols;
  if (src.kind === "object_type") return sources.object_types.find((x) => x.id === src.id)?.properties.map((p) => ({ name: p.name, type: p.type })) ?? [];
  return [];
}
function LayerSource({ value, onChange, sources }: { value?: SourceRef; onChange: (v: SourceRef | undefined) => void; sources: Sources }) {
  return (
    <select
      value={value ? `${value.kind}:${value.id}` : ""}
      onChange={(e) => {
        const [kind, ...id] = e.target.value.split(":");
        onChange(e.target.value ? ({ kind, id: id.join(":") } as SourceRef) : undefined);
      }}
      className={inputClass}
      data-layer-source
    >
      <option value="">The widget&apos;s source</option>
      {sources.object_types.map((x) => (
        <option key={x.id} value={`object_type:${x.id}`}>
          {x.name}
        </option>
      ))}
      {sources.datasets.map((x) => (
        <option key={x.id} value={`dataset:${x.id}`}>
          {x.name} (dataset)
        </option>
      ))}
    </select>
  );
}
/** A column chooser, or a text box when the columns are unknown (a dataset layer). */
function ColIn({ value, cols, onChange, empty }: { value?: string; cols: Column[]; onChange: (v: string | undefined) => void; empty: string }) {
  return cols.length ? <ColSelect value={value} cols={cols} onChange={onChange} empty={empty} /> : <input value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} placeholder={empty} className={inputClass} />;
}
/** Conditional color rules: the first matching rule colors the event. */
function RulesRows({ rules, cols, onChange }: { rules: FormatRule[]; cols: Column[]; onChange: (r: FormatRule[]) => void }) {
  const setR = (i: number, x: Partial<FormatRule>) => onChange(rules.map((y, j) => (j === i ? { ...y, ...x } : y)));
  return (
    <div className="space-y-1" data-layer-rules>
      {rules.map((r, i) => (
        <div key={i} className="flex gap-1">
          <div className="min-w-0 flex-1">
            <ColIn value={r.column} cols={cols} onChange={(v) => setR(i, { column: v })} empty="Property…" />
          </div>
          <select value={r.op} onChange={(e) => setR(i, { op: e.target.value as FormatRule["op"] })} className={`${fieldClass} w-16 text-xs`}>
            {(["eq", "neq", "gt", "gte", "lt", "lte", "contains"] as const).map((o) => (
              <option key={o} value={o}>
                {{ eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "has" }[o]}
              </option>
            ))}
          </select>
          <input value={String(r.value ?? "")} onChange={(e) => setR(i, { value: e.target.value })} className={`${fieldClass} w-20 text-xs`} />
          <input type="color" value={r.color} onChange={(e) => setR(i, { color: e.target.value })} className="h-6 w-7 bg-transparent" />
          <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad">
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rules, { op: "eq", value: "", color: "#ef4444" }])} className="text-[11px] text-ocean">
        + Color rule
      </button>
    </div>
  );
}
const ZONES = ["UTC", "Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];

function GanttConfig({ widget, set, mod, cols, sources, varSelect, selectionEvents }: LayerConfigProps) {
  const c = widget.config;
  const layers = ganttLayersOf(c);
  // the first edit turns the widget's own columns into its first layer
  const setLayers = (ls: GanttLayer[]) => set({ gantt_layers: ls });
  const setL = (i: number, x: Partial<GanttLayer>) => setLayers(layers.map((y, j) => (j === i ? { ...y, ...x } : y)));
  const TIME_VARS = ["timestamp", "date"];
  return (
    <div className="space-y-3">
      <Field label="Data layers (several object types on one chart)">
        <div className="space-y-2">
          {layers.map((l, i) => {
            const lc = layerCols(l.source, cols, sources);
            const tc = timeCols(lc).length ? timeCols(lc) : lc;
            return (
              <details key={i} open={layers.length === 1 || undefined} className="rounded border border-line p-2 text-xs" data-gantt-layer-config={i}>
                <summary className="flex cursor-pointer items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: l.color ?? "#1f6feb" }} />
                  <span className="min-w-0 flex-1 truncate">{l.label || `Layer ${i + 1}`}</span>
                  {layers.length > 1 && (
                    <button type="button" onClick={(e) => (e.preventDefault(), setLayers(layers.filter((_, j) => j !== i)))} className="px-1 text-muted hover:text-bad" title="Remove the layer">
                      ✕
                    </button>
                  )}
                </summary>
                <div className="mt-2 space-y-1">
                  <div className="flex gap-1">
                    <input value={l.label} onChange={(e) => setL(i, { label: e.target.value })} placeholder="Layer name (not shown on the chart)" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                    <input type="color" value={l.color ?? "#1f6feb"} onChange={(e) => setL(i, { color: e.target.value })} className="h-6 w-7 bg-transparent" title="Event color" />
                  </div>
                  <LayerSource value={l.source} sources={sources} onChange={(v) => setL(i, { source: v, filters: undefined, start_column: undefined, end_column: undefined, label_column: undefined, group_column: undefined, hover_columns: undefined, rules: undefined })} />
                  <div className="text-muted">Input object set</div>
                  {varSelect(l.input_variable, (v) => setL(i, { input_variable: v }), ["object_set", "object_set_filter", "array"], "All objects")}
                  <div className="grid grid-cols-2 gap-1">
                    <ColIn value={l.start_column} cols={tc} onChange={(v) => setL(i, { start_column: v })} empty="Start…" />
                    <ColIn value={l.end_column} cols={tc} onChange={(v) => setL(i, { end_column: v })} empty="End (none: discrete)" />
                    <ColIn value={l.label_column} cols={lc} onChange={(v) => setL(i, { label_column: v })} empty="Label: primary key" />
                    <ColIn value={l.group_column} cols={lc} onChange={(v) => setL(i, { group_column: v })} empty="No grouping" />
                  </div>
                  {l.end_column && (
                    <div className="flex gap-1">
                      <select value={l.no_end ?? "point"} onChange={(e) => setL(i, { no_end: e.target.value as GanttLayer["no_end"] })} className={inputClass} title="Events with no end time">
                        <option value="point">No end: draw as a point</option>
                        <option value="exclude">No end: exclude</option>
                        <option value="variable">No end: a timestamp variable</option>
                      </select>
                      {l.no_end === "variable" && <div className="min-w-0 flex-1">{varSelect(l.end_variable, (v) => setL(i, { end_variable: v }), TIME_VARS, "Variable…")}</div>}
                    </div>
                  )}
                  {lc.length > 0 && (
                    <>
                      <div className="text-muted">Properties on hover</div>
                      <MultiCols value={l.hover_columns} cols={lc} onChange={(v) => setL(i, { hover_columns: v })} />
                    </>
                  )}
                  <div className="text-muted">Color rules (dynamic; the static color otherwise)</div>
                  <RulesRows rules={l.rules ?? []} cols={lc} onChange={(r) => setL(i, { rules: r.length ? r : undefined })} />
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={l.selectable !== false} onChange={(e) => setL(i, { selectable: e.target.checked ? undefined : false })} /> Selection
                    </label>
                    {l.selectable !== false && (
                      <label className="flex items-center gap-1" title="Ctrl / Cmd + click adds to the selection (needs a selected objects variable)">
                        <input type="checkbox" checked={!!l.multiselect} onChange={(e) => setL(i, { multiselect: e.target.checked || undefined })} /> Multiselect
                      </label>
                    )}
                  </div>
                  {l.selectable !== false && (
                    <>
                      <div className="text-muted">Selected objects</div>
                      {varSelect(l.selected_variable, (v) => setL(i, { selected_variable: v }), ["object_set", "array", "string"], "Module selection")}
                      <EventsEditor events={l.on_select ?? []} mod={mod} onChange={(ev) => setL(i, { on_select: ev.length ? ev : undefined })} label="On selection (this layer; none: the widget's)" />
                    </>
                  )}
                </div>
              </details>
            );
          })}
          <button type="button" onClick={() => setLayers([...layers, { label: `Layer ${layers.length + 1}`, color: CATEGORY_PALETTE[layers.length % CATEGORY_PALETTE.length] }])} className="text-xs text-ocean" data-gantt-add-layer>
            + Data layer
          </button>
        </div>
      </Field>
      <Field label="Stacking">
        <select value={c.stacking ?? "smart"} onChange={(e) => set({ stacking: e.target.value as "smart" })} className={inputClass}>
          <option value="smart">Smart rows (no overlaps)</option>
          <option value="new_rows">New rows (one per event)</option>
          <option value="overlap">Overlap (one row)</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Row ordering">
          <select value={c.row_order ?? "alpha"} onChange={(e) => set({ row_order: e.target.value === "start" ? "start" : undefined })} className={inputClass}>
            <option value="alpha">Alphabetical</option>
            <option value="start">First event start</option>
          </select>
        </Field>
        <Field label="Group column width">
          <input type="number" min={60} max={400} value={c.group_width ?? 140} onChange={(e) => set({ group_width: Number(e.target.value) || undefined })} className={inputClass} />
        </Field>
      </div>
      <Field label="Time zone">
        <div className="space-y-1">
          <select value={c.tz_mode ?? "local"} onChange={(e) => set({ tz_mode: e.target.value === "local" ? undefined : (e.target.value as "static") })} className={inputClass} data-gantt-tz-mode>
            <option value="local">Local (the viewer&apos;s)</option>
            <option value="static">Static</option>
            <option value="dynamic">Dynamic (a string variable)</option>
          </select>
          {c.tz_mode === "static" && (
            <>
              <input list="gantt-zones" value={c.time_zone ?? ""} onChange={(e) => set({ time_zone: e.target.value || undefined })} placeholder="Asia/Jakarta" className={inputClass} data-gantt-tz />
              <datalist id="gantt-zones">
                {ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              {c.time_zone && !validZone(c.time_zone) && <div className="text-[11px] text-bad">Unknown time zone: local time is used</div>}
            </>
          )}
          {c.tz_mode === "dynamic" && varSelect(c.time_zone_variable, (v) => set({ time_zone_variable: v }), ["string"], "Variable…")}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Timeline start (variable)">{varSelect(c.window_start_variable, (v) => set({ window_start_variable: v }), TIME_VARS, "Auto")}</Field>
        <Field label="Timeline end (variable)">{varSelect(c.window_end_variable, (v) => set({ window_end_variable: v }), TIME_VARS, "Auto")}</Field>
      </div>
      <p className="text-[11px] text-muted">The variables set the chart&apos;s window; panning and zooming write them back.</p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={c.show_now !== false} onChange={(e) => set({ show_now: e.target.checked })} /> Show the current time
      </label>
      {selectionEvents}
    </div>
  );
}

function TimelineConfig({ widget, set, mod, cols, sources, varSelect, selectionEvents }: LayerConfigProps) {
  const c = widget.config;
  const layers = timelineLayersOf(c);
  const setLayers = (ls: TimelineLayer[]) => set({ timeline_layers: ls });
  const setL = (i: number, x: Partial<TimelineLayer>) => setLayers(layers.map((y, j) => (j === i ? { ...y, ...x } : y)));
  return (
    <div className="space-y-3">
      <Field label="Timeline layers (several object types on one timeline)">
        <div className="space-y-2">
          {layers.map((l, i) => {
            const lc = layerCols(l.source, cols, sources);
            const src = l.source ?? c.source;
            const ot = src?.kind === "object_type" ? sources.object_types.find((x) => x.id === src.id) : undefined;
            return (
              <details key={i} open={layers.length === 1 || undefined} className="rounded border border-line p-2 text-xs" data-timeline-layer-config={i}>
                <summary className="flex cursor-pointer items-center gap-1">
                  <span className="min-w-0 flex-1 truncate">{l.label || ot?.name || `Layer ${i + 1}`}</span>
                  {layers.length > 1 && (
                    <button type="button" onClick={(e) => (e.preventDefault(), setLayers(layers.filter((_, j) => j !== i)))} className="px-1 text-muted hover:text-bad" title="Remove the layer">
                      ✕
                    </button>
                  )}
                </summary>
                <div className="mt-2 space-y-1">
                  <input value={l.label} onChange={(e) => setL(i, { label: e.target.value })} placeholder="Layer label (the legend)" className={`${fieldClass} w-full text-xs`} />
                  <LayerSource value={l.source} sources={sources} onChange={(v) => setL(i, { source: v, filters: undefined, date_column: undefined, title_column: undefined, props: undefined, rules: undefined })} />
                  <div className="text-muted">Input object set</div>
                  {varSelect(l.input_variable, (v) => setL(i, { input_variable: v }), ["object_set", "object_set_filter", "array"], "All objects")}
                  <div className="text-muted">Date / timestamp property</div>
                  <ColIn value={l.date_column} cols={timeCols(lc).length ? timeCols(lc) : lc} onChange={(v) => setL(i, { date_column: v })} empty="Choose…" />
                  <div className="text-muted">Event title</div>
                  <div className="flex gap-1">
                    <select value={l.title_mode ?? "object"} onChange={(e) => setL(i, { title_mode: e.target.value as TimelineLayer["title_mode"] })} className={`${inputClass} w-32`}>
                      <option value="object">Object title</option>
                      <option value="property">Property</option>
                      <option value="custom">Custom</option>
                    </select>
                    <div className="min-w-0 flex-1">
                      {l.title_mode === "property" && <ColIn value={l.title_column} cols={lc} onChange={(v) => setL(i, { title_column: v })} empty="The primary key" />}
                      {l.title_mode === "custom" && <input value={l.title_text ?? ""} onChange={(e) => setL(i, { title_text: e.target.value || undefined })} placeholder="Audit {{faskes}}" className={inputClass} />}
                      {(l.title_mode ?? "object") === "object" && <div className="py-1 text-muted">{ot?.title_property ? `“${ot.title_property}”` : "The primary key"}</div>}
                    </div>
                  </div>
                  <div className="text-muted">Properties on each event</div>
                  <select value={l.props_mode ?? "prominent"} onChange={(e) => setL(i, { props_mode: e.target.value as TimelineLayer["props_mode"] })} className={inputClass}>
                    <option value="prominent">Prominent properties{ot ? ` (${ot.properties.filter((p) => p.prominent).length})` : ""}</option>
                    <option value="specific">Specific properties</option>
                  </select>
                  {l.props_mode === "specific" && lc.length > 0 && <MultiCols value={l.props} cols={lc} onChange={(v) => setL(i, { props: v })} />}
                  <div className="text-muted">Color (the icon and the title)</div>
                  <div className="flex items-center gap-1">
                    <select value={l.color_mode ?? "default"} onChange={(e) => setL(i, { color_mode: e.target.value as TimelineLayer["color_mode"] })} className={inputClass}>
                      <option value="default">Default (the object type&apos;s)</option>
                      <option value="static">Static</option>
                      <option value="dynamic">Dynamic (rules)</option>
                    </select>
                    {(l.color_mode ?? "default") !== "default" && <input type="color" value={l.color ?? "#1f6feb"} onChange={(e) => setL(i, { color: e.target.value })} className="h-6 w-7 shrink-0 bg-transparent" />}
                  </div>
                  {l.color_mode === "dynamic" && <RulesRows rules={l.rules ?? []} cols={lc} onChange={(r) => setL(i, { rules: r.length ? r : undefined })} />}
                  <div className="text-muted">Icon</div>
                  <div className="flex items-center gap-1">
                    <select value={l.icon_mode ?? "default"} onChange={(e) => setL(i, { icon_mode: e.target.value as TimelineLayer["icon_mode"] })} className={inputClass} data-timeline-icon-mode>
                      <option value="default">Default (the ontology&apos;s{ot?.icon ? `: ${ot.icon}` : ""})</option>
                      <option value="none">None (a dot)</option>
                      <option value="custom">Custom</option>
                    </select>
                    {l.icon_mode === "custom" && (
                      <select value={l.icon ?? ""} onChange={(e) => setL(i, { icon: e.target.value || undefined })} className={`${inputClass} w-28`}>
                        <option value="">Choose…</option>
                        {EVENT_ICONS.map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <EventsEditor events={l.on_select ?? []} mod={mod} onChange={(ev) => setL(i, { on_select: ev.length ? ev : undefined })} label="Selection event override (this layer)" />
                </div>
              </details>
            );
          })}
          <button type="button" onClick={() => setLayers([...layers, { label: `Layer ${layers.length + 1}` }])} className="text-xs text-ocean" data-timeline-add-layer>
            + Timeline layer
          </button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <select value={c.orientation ?? "vertical"} onChange={(e) => set({ orientation: e.target.value as "vertical" })} className={inputClass}>
          <option value="vertical">Vertical</option>
          <option value="horizontal">Horizontal</option>
        </select>
        <select value={c.order ?? "newest"} onChange={(e) => set({ order: e.target.value as "newest" })} className={inputClass}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!c.show_legend} onChange={(e) => set({ show_legend: e.target.checked || undefined })} /> Legend (show / hide layers)
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={c.show_gaps !== false} onChange={(e) => set({ show_gaps: e.target.checked })} /> Time between events
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={c.highlight_selection !== false} onChange={(e) => set({ highlight_selection: e.target.checked ? undefined : false })} /> Highlight the selected event
        </label>
      </div>
      <Field label="Active object (output)">{varSelect(c.active_variable, (v) => set({ active_variable: v }), ["object_set", "array", "string"], "None")}</Field>
      {selectionEvents}
    </div>
  );
}
