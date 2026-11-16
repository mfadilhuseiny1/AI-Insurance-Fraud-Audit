/**
 * Client for time series (api/timeseries.py, ts_ontology.py, ts_derived.py, ts_alerting.py): time series and
 * geotemporal series syncs (written by pipelines or made in the Time Series Catalog from a dataset), time series
 * properties of object types and their sensors, the card logic every app evaluates (Quiver, derived series, time
 * series alerting, Workshop), derived series, Quiver analyses, alerting jobs and query compute usage.
 */
import type { IconName } from "@/components/Icon";
import { API_URL } from "./api";

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json", ...(rest.headers ?? {}) } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      const d = body.detail ?? message;
      message = typeof d === "string" ? d : (d.message ?? JSON.stringify(d));
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export type SeriesKind = "timeseries" | "geotemporal";
export type SyncMapping = { series_id: string; timestamp: string; value: string; timestamp_unit?: TimestampUnit | null; ingestion_time?: string | null };
export type TimestampUnit = "SECONDS" | "MILLISECONDS" | "MICROSECONDS" | "NANOSECONDS";
export type SyncSettings = { schedule_on_update: boolean; optimized: boolean; index_view_inputs: boolean; overwrite_syncs: string[]; spark_profiles: string[] };
export const DEFAULT_SYNC_SETTINGS: SyncSettings = { schedule_on_update: true, optimized: true, index_view_inputs: false, overwrite_syncs: [], spark_profiles: [] };
export type SyncBuild = { at: string; status: "succeeded" | "failed"; rows?: number; written?: number; errors?: number; error?: string; ms: number; overwritten?: { sync_id: string; points_removed: number }[] };
export type SeriesSync = {
  id: string;
  rid: string;
  /** pipeline: written by a Pipeline Builder output; catalog: made in the Time Series Catalog from a dataset */
  source: "pipeline" | "catalog" | "demo";
  description?: string;
  dataset_id?: string;
  settings?: SyncSettings;
  last_build?: SyncBuild | null;
  builds?: SyncBuild[];
  status?: "new" | "succeeded" | "failed";
  error?: string | null;
  kind: SeriesKind;
  kind_label: string;
  name: string;
  pipeline_id: string;
  pipeline_name: string;
  output_id: string;
  mode: "batch" | "streaming";
  mapping: Record<string, unknown>;
  backing_dataset: string | null;
  stream_id: string | null;
  created_at: string;
  updated_at: string;
  last_write_at: string | null;
  points_total: number;
  errors_total: number;
  /** points / observations held now */
  stored: number;
  series: number;
  first_ts: string | null;
  last_ts: string | null;
  /** written in the last 5 minutes */
  written_5m: number;
  errors: number;
};
export type TimeSeriesInfo = { series_id: string; points: number; first_ts: string; last_ts: string; min: number | null; max: number | null; avg: number | null; last_value: number | string | null };
export type GeoSeriesInfo = { series_id: string; observations: number; first_ts: string; last_ts: string; latitude: number; longitude: number };
export type SeriesPoint = { t: string; value: number | string | null; min?: number; max?: number; n?: number };
export type Observation = { series_id: string; t: string; latitude: number; longitude: number; properties: Record<string, unknown> };
export type SyncError = { at: string; error: string; record: Record<string, unknown> };

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const text = s.toString();
  return text ? `?${text}` : "";
};

export type DatasetRef = { id: string; name: string; path: string[]; updated_at: string };
export type DatasetColumns = { id: string; name: string; updated_at: string; columns: { name: string; type: string }[] };
export type SyncPreview = {
  problems: string[];
  rows_read: number;
  points: { series_id: string; timestamp: string; value: number | string | null }[];
  series: string[];
  series_count: number;
  rejected: number;
  rejected_samples: { error: string; row: Record<string, unknown> }[];
  categorical: boolean;
};

export const timeseries = {
  syncs: (kind?: SeriesKind) => req<SeriesSync[]>(`/api/timeseries/syncs${q({ kind })}`),
  datasets: () => req<DatasetRef[]>("/api/timeseries/datasets"),
  datasetColumns: (id: string) => req<DatasetColumns>(`/api/timeseries/datasets/${id}/columns`),
  previewSync: (dataset_id: string, mapping: SyncMapping) => req<SyncPreview>("/api/timeseries/syncs/preview", { method: "POST", json: { dataset_id, mapping } }),
  createSync: (body: { name: string; dataset_id: string; mapping: SyncMapping; settings: SyncSettings; description?: string; build?: boolean }) =>
    req<SeriesSync>("/api/timeseries/syncs", { method: "POST", json: body }),
  updateSync: (id: string, body: { name?: string; description?: string; mapping?: SyncMapping; settings?: SyncSettings }) =>
    req<SeriesSync>(`/api/timeseries/syncs/${id}`, { method: "PATCH", json: body }),
  buildSync: (id: string) => req<SeriesSync>(`/api/timeseries/syncs/${id}/build`, { method: "POST" }),
  syncProperties: (id: string) => req<{ object_type_id: string; object_type: string; property: string; display_name: string }[]>(`/api/timeseries/syncs/${id}/properties`),
  sync: (id: string) => req<SeriesSync>(`/api/timeseries/syncs/${id}`),
  deleteSync: (id: string) => req<{ deleted: string }>(`/api/timeseries/syncs/${id}`, { method: "DELETE" }),
  series: <T = TimeSeriesInfo | GeoSeriesInfo>(id: string, search = "") => req<T[]>(`/api/timeseries/syncs/${id}/series${q({ q: search })}`),
  points: (id: string, series: string, opts: { start?: string; end?: string; buckets?: number } = {}) =>
    req<{ series_id: string; total: number; bucketed: boolean; points: SeriesPoint[] }>(`/api/timeseries/syncs/${id}/series/${encodeURIComponent(series)}/points${q(opts)}`),
  observations: (id: string, opts: { start?: string; end?: string; series?: string; limit?: number } = {}) =>
    req<{ total: number; truncated: boolean; observations: Observation[] }>(`/api/timeseries/syncs/${id}/observations${q(opts)}`),
  metrics: (id: string, minutes = 120) => req<{ minute: string; points: number; errors: number }[]>(`/api/timeseries/syncs/${id}/metrics${q({ minutes })}`),
  errors: (id: string) => req<SyncError[]>(`/api/timeseries/syncs/${id}/errors`),
  /** demo data (api/timeseries_demo.py): ships in Jakarta Bay, trucks in Jakarta, vessel speeds, port sensors */
  demoStatus: () => req<DemoStatus>("/api/timeseries/demo"),
  loadDemo: (liveMinutes = 60) => req<DemoStatus & { syncs: Record<string, string>; monitoring_view: string | null }>("/api/timeseries/demo", { method: "POST", json: { live_minutes: liveMinutes } }),
  removeDemo: () => req<{ removed: string[] }>("/api/timeseries/demo", { method: "DELETE" }),
  /** the Map's built-in demo: loads it when missing, else catches it up and keeps it (and its streaming pipeline) live */
  ensureDemo: () => req<DemoStatus & { syncs: Record<string, string> }>("/api/timeseries/demo/ensure", { method: "POST" }),
};
/** pipeline_id: the demo's streaming pipeline (vessel positions), when Files is available */
export type DemoStatus = { loaded: boolean; live: boolean; live_until: string | null; pipeline_id?: string | null };
/** demo syncs are written by no real pipeline */
export const isDemo = (s: Pick<SeriesSync, "pipeline_id">) => s.pipeline_id === "demo";

/** Data Health deep link that opens "Add monitoring rules" for a sync's output monitor. */
export const monitorHref = (s: Pick<SeriesSync, "id" | "kind" | "name">) =>
  `/data-health?add=${encodeURIComponent(`${s.kind === "geotemporal" ? "geotemporal" : "timeseries_sync"}:${s.id}`)}&name=${encodeURIComponent(s.name)}`;

// ------------------------------------------------------------------------------------------------
// time series in the Ontology
// ------------------------------------------------------------------------------------------------

export type ObjRef = { object_type_id: string; primary_key: string };
export const INTERPOLATIONS = ["LINEAR", "NEAREST", "PREVIOUS", "NEXT", "NONE"] as const;
export type Interpolation = (typeof INTERPOLATIONS)[number];
export const INTERPOLATION_HELP: Record<Interpolation, string> = {
  LINEAR: "A straight line between the previous and next points (numeric series only)",
  NEAREST: "The value of the nearest point",
  PREVIOUS: "The value of the previous point",
  NEXT: "The value of the next point",
  NONE: "No value where there is no point",
};
export type Formatting = { value?: string | null; property?: string | null };
export type TspConfig = { syncs: string[]; unit: Formatting; interpolation: Formatting; external: "NONE" | "NEAREST"; description?: string };
export type SensorLink = { root_object_type_id: string; foreign_key: string; sensor_name_property: string };
export type SensorConfig = { links: SensorLink[]; is_categorical_property?: string | null; unit_property?: string | null; interpolation_property?: string | null };
export type TimeSeriesConfig = {
  object_type_id: string;
  properties: Record<string, TspConfig>;
  default_property: string | null;
  sensor: SensorConfig | null;
  severed_markings: string[];
  geospatial: { track_latitude?: string | null; track_longitude?: string | null } | null;
  units: string[];
  interpolations: Interpolation[];
};
export type ObjectTsp = {
  key: string;
  label: string;
  source: "property" | "sensor";
  value: unknown;
  ref_kind?: "raw" | "derived" | "invalid" | null;
  unit: string | null;
  interpolation: string | null;
  default: boolean;
  sensor?: { object_type_id: string; object_type: string; primary_key: string };
};
export type TsObjectType = {
  id: string;
  display_name: string;
  api_name: string;
  icon?: string;
  object_count: number;
  properties: { api_name: string; display_name: string; configured: boolean; syncs: string[] }[];
  default_property: string | null;
  is_sensor: boolean;
  root_object_types: string[];
  sensor_types: string[];
  geospatial: TimeSeriesConfig["geospatial"];
  views: number;
};
export type Diagnostics = {
  object_type_id: string;
  properties: {
    property: string;
    display_name: string;
    configured: boolean;
    objects: number;
    with_value: number;
    resolved: number;
    derived: number;
    qualified: number;
    sync_series: number;
    missing: { primary_key: string; series_id: string; sync: string | null }[];
    invalid: { primary_key: string; value: unknown; error: string }[];
  }[];
};

// -- card logic (ts_engine.py) -----------------------------------------------------------------------

export type CardType =
  | "tsp" | "series" | "derived" | "function" | "formula" | "filter" | "derivative" | "integral" | "cumulative" | "rolling" | "periodic" | "sample"
  | "shift" | "relative" | "combine" | "bollinger" | "bounds" | "dsp" | "segment_stats" | "linked_agg" | "aggregate" | "search"
  | "event_set" | "event_ranges" | "event_shift" | "event_dedupe" | "vfunction"
  | "param_number" | "param_string" | "param_boolean" | "param_datetime" | "param_range" | "param_duration" | "param_object_property" | "shift_datetime";
export type Card = { id: string; type: CardType; title?: string; config: Record<string, unknown> };
export type Logic = { cards: Card[]; output?: string | null };
export type CardGroup = "Data" | "Transform" | "Combine" | "Search" | "Parameter";
export const AGGREGATIONS = ["mean", "sum", "min", "max", "count", "std", "median", "first", "last", "range"] as const;
export const CARD_INFO: { type: CardType; label: string; group: CardGroup; icon: IconName; description: string; config: Record<string, unknown> }[] = [
  { type: "tsp", label: "Time series property", group: "Data", icon: "wave", description: "A time series property of the object or of a linked sensor", config: { property: "" } },
  { type: "series", label: "Series ID", group: "Data", icon: "list", description: "A series of a time series sync, by its ID", config: { series_id: "" } },
  { type: "derived", label: "Derived series", group: "Data", icon: "layers", description: "A saved derived series for the object", config: { template: "" } },
  { type: "function", label: "Code function time series", group: "Data", icon: "code", description: "A Python @function in a code repository (function-backed series)", config: { repo_id: "", file: "", function: "", object_param: "", parameters: {} } },
  { type: "linked_agg", label: "Linked series aggregation", group: "Combine", icon: "split", description: "Aggregate the series of every linked sensor", config: { aggregation: "mean", match: "" } },
  { type: "formula", label: "Time series formula", group: "Combine", icon: "logic", description: "Pointwise: $A - $B, $A > 120 && $B < 3, abs($A), @property", config: { formula: "" } },
  { type: "combine", label: "Combine time series", group: "Combine", icon: "union", description: "Union of the points of several series", config: { inputs: [] } },
  { type: "bounds", label: "Time series bounds", group: "Combine", icon: "layers", description: "Upper or lower envelope of several series", config: { inputs: [], band: "upper" } },
  { type: "filter", label: "Filter time series", group: "Transform", icon: "filter", description: "Keep points in a value range, time range or set of values", config: { input: "" } },
  { type: "derivative", label: "Derivative", group: "Transform", icon: "transform", description: "Rate of change per second, minute, hour or day", config: { input: "", unit: "s" } },
  { type: "integral", label: "Integral", group: "Transform", icon: "transform", description: "Running integral from the start of the range", config: { input: "", unit: "s" } },
  { type: "cumulative", label: "Cumulative aggregate", group: "Transform", icon: "transform", description: "Running sum, count, min, max or mean", config: { input: "", aggregation: "sum" } },
  { type: "rolling", label: "Rolling aggregate", group: "Transform", icon: "transform", description: "Aggregate over a trailing time window", config: { input: "", aggregation: "mean", window: "1h" } },
  { type: "periodic", label: "Periodic aggregate", group: "Transform", icon: "clock", description: "One point per hour, day, week, month …", config: { input: "", aggregation: "mean", period: "1d" } },
  { type: "sample", label: "Sample", group: "Transform", icon: "clock", description: "Values at a regular interval", config: { input: "", every: "1h" } },
  { type: "shift", label: "Shift time series", group: "Transform", icon: "right", description: "Move the points in time", config: { input: "", by: "1d" } },
  { type: "relative", label: "Relative time series", group: "Transform", icon: "left", description: "Align the start with another time (overlays) or subtract the start value", config: { input: "", mode: "time" } },
  { type: "bollinger", label: "Bollinger bands", group: "Transform", icon: "wave", description: "Rolling mean ± k standard deviations", config: { input: "", window: "1d", k: 2, band: "upper" } },
  { type: "dsp", label: "DSP filter", group: "Transform", icon: "sliders", description: "Moving average, exponential smoothing, low- or high-pass", config: { input: "", filter: "moving_average", window: "1h" } },
  { type: "segment_stats", label: "Segment statistics", group: "Transform", icon: "table", description: "One aggregate per search interval or period", config: { input: "", aggregation: "mean", period: "1d" } },
  { type: "aggregate", label: "Numeric aggregation", group: "Transform", icon: "gauge", description: "One number over the range", config: { input: "", aggregation: "mean" } },
  { type: "search", label: "Time series search", group: "Search", icon: "search", description: "Intervals where a condition holds", config: { condition: "" } },
  { type: "event_set", label: "Event set from objects", group: "Search", icon: "clock", description: "Events from an object type's start and end properties", config: { object_type_id: "", start_property: "", end_property: "" } },
  { type: "event_ranges", label: "Event set from ranges", group: "Search", icon: "clock", description: "Events typed in: a start and an end each", config: { ranges: [] } },
  { type: "event_shift", label: "Time shift event set", group: "Search", icon: "right", description: "Move the events' starts and ends", config: { input: "", before: "", after: "" } },
  { type: "vfunction", label: "Visual function", group: "Combine", icon: "code", description: "Saved card logic: its inputs from this analysis' cards or values", config: { function_id: "", arguments: {} } },
  { type: "event_dedupe", label: "Deduplicate event set", group: "Search", icon: "union", description: "Merge overlapping events", config: { input: "" } },
  { type: "param_number", label: "Numeric parameter", group: "Parameter", icon: "list", description: "A number formulas can use ($P)", config: { value: 0 } },
  { type: "param_string", label: "String parameter", group: "Parameter", icon: "doc", description: "Text", config: { value: "" } },
  { type: "param_boolean", label: "Boolean parameter", group: "Parameter", icon: "check", description: "True or false", config: { value: false } },
  { type: "param_datetime", label: "Date/time parameter", group: "Parameter", icon: "clock", description: "A point in time", config: { value: "" } },
  { type: "param_range", label: "Date/time range parameter", group: "Parameter", icon: "clock", description: "A start and an end", config: { start: "", end: "" } },
  { type: "param_duration", label: "Duration unit parameter", group: "Parameter", icon: "clock", description: "A duration such as 15m or 7d", config: { value: "1h" } },
  { type: "param_object_property", label: "Linked object property parameter", group: "Parameter", icon: "cube", description: "A property of the root object", config: { property: "" } },
  { type: "shift_datetime", label: "Shift date/time", group: "Parameter", icon: "clock", description: "A date/time moved by a duration", config: { datetime: "", by: "-7d" } },
];
export const cardInfo = (t: CardType) => CARD_INFO.find((c) => c.type === t)!;
/** Cards a derived series can use (no search); time series alerting (Quiver's supported list) */
export const DERIVED_CARDS: CardType[] = CARD_INFO.map((c) => c.type).filter((t) => t !== "search");
export const ALERTING_CARDS: CardType[] = ["tsp", "series", "derived", "filter", "derivative", "sample", "segment_stats", "formula", "combine", "periodic", "rolling", "relative",
  "bollinger", "bounds", "shift", "shift_datetime", "linked_agg", "search", "param_number", "param_string", "param_datetime", "param_range", "param_duration", "param_boolean", "param_object_property"];
export const SCALAR_CARDS: CardType[] = ["aggregate", "param_number", "param_string", "param_boolean", "param_datetime", "param_range", "param_duration", "param_object_property", "shift_datetime"];

export function nextCardId(logic: Logic): string {
  const used = new Set(logic.cards.map((c) => c.id));
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) if (!used.has(a)) return a;
  for (const a of letters) for (const b of letters) if (!used.has(a + b)) return a + b;
  return `C${logic.cards.length}`;
}

export type SeriesResult = {
  kind: "series";
  label: string;
  unit: string | null;
  interpolation: string;
  external: string;
  categorical: boolean;
  points: SeriesPoint[];
  bucketed: boolean;
  stats: { points: number; first_ts: string | null; last_ts: string | null; first: unknown; last: unknown; min: number | null; max: number | null; mean: number | null };
};
export type Interval = { start: string; end: string | null; duration_ms: number; ongoing: boolean };
export type CardResult =
  | SeriesResult
  | { kind: "intervals"; intervals: Interval[]; count: number }
  | { kind: "scalar"; scalar_kind: string; value: unknown }
  | { kind: "error"; error: string };
export type QueryResult = { cards: Record<string, CardResult>; output: string | null; points_scanned: number; compute_seconds: number };
export type QueryBody = { logic: Logic; root?: ObjRef | null; start?: string | null; end?: string | null; params?: Record<string, unknown>; cards?: string[]; buckets?: number; resource?: string };

// -- derived series, Quiver, alerting, usage -----------------------------------------------------------

export type DerivedSaving = {
  mode: "manual" | "automatic";
  sensor_name: string;
  scope: { kind: "all" | "filter" | "objects"; property?: string | null; value?: unknown; primary_keys: string[] };
  property_mapping: Record<string, unknown>;
  actions: { create?: string | null; modify?: string | null; delete?: string | null };
};
export const DEFAULT_SAVING: DerivedSaving = { mode: "manual", sensor_name: "", scope: { kind: "all", primary_keys: [] }, property_mapping: {}, actions: {} };
export type DerivedSeries = {
  id: string;
  rid: string;
  template_rid: string;
  template_id: string;
  name: string;
  description: string;
  type: "templated" | "single";
  root_object_type_id: string | null;
  root_object_type?: string | null;
  bound_object_type_id: string;
  bound_object_type?: string | null;
  folder: string;
  saving: DerivedSaving;
  deployed: { version: string; at: string; created: number; modified: number; deleted: number } | null;
  version: string;
  version_count: number;
  created_at: string;
  updated_at: string;
  versions?: { version: string; logic: Logic; description: string; at: string; by: string | null }[];
  logic?: Logic;
};
export type OntologyStatus =
  | { mode: "manual"; template_rid: string; objects: number; pinned_value: string }
  | {
      mode: "automatic";
      up_to_date: boolean;
      expected: number;
      in_ontology: number;
      to_create: string[];
      to_modify: string[];
      to_delete: string[];
      counts: { create: number; modify: number; delete: number };
      version: string;
      deployed: DerivedSeries["deployed"];
    };
export type Analysis = {
  /** the revision (each save adds one; a save from an older one is refused) */
  rev?: number;
  id: string;
  rid: string;
  name: string;
  description: string;
  logic: Logic;
  root: ObjRef | null;
  plots: { id: string; title: string; cards: string[] }[];
  range: { start?: string | null; end?: string | null; last?: string | null };
  dashboard: { cards: string[]; inputs: string[] };
  canvases?: { id: string; name: string; cards: string[] }[];
  view_mode?: "canvas" | "graph";
  object_sets?: { id: string; object_type_id: string; title: string; query: string; filters: { property: string; op: string; value?: unknown }[]; visualization: "table" | "chart"; group_by: string | null; metric: "count" | "sum" | "avg"; measure: string | null }[];
  created_at: string;
  updated_at: string;
  card_count?: number;
  // the published dashboard (a Files item) and its latest version
  published?: { item_id: string; version: number; at: string } | null;
};
export type PublishedDashboard = {
  item: { id: string; name: string; path?: { id: string; name: string }[] };
  analysis_id: string;
  version: number;
  at: string;
  note: string;
  latest: number;
  versions: { version: number; at: string; by: string; note: string }[];
  analysis: Analysis;
  tables: Record<string, unknown>;
  analysis_exists: boolean;
  /** opened for an object: whether the root object and how many object set cards were bound to it */
  bound?: { root: boolean; object_sets: number } | null;
};
export type PublishedDashboardRow = { item_id: string; name: string; analysis_id: string; version: number | null; root_object_type_id: string | null };
/** A visual function: saved card logic (ts_derived.py) with inputs the calling analysis sets. */
export type VisualFunction = { id: string; name: string; description: string; output: string; inputs: { card: string; name: string; type: string }[]; updated_at?: string };
export type CatalogCard = { kind: "sync" | "derived" | "object_type"; id: string; name: string; subtitle: string; favorite?: boolean; views: number; last_viewed?: string | null };
export type CatalogHome = {
  recent: CatalogCard[];
  favorites: CatalogCard[];
  most_viewed_object_types: CatalogCard[];
  counts: { syncs: number; geotemporal: number; object_types: number; derived: number };
};
export type UsageRow = { resource: string; label: string; href: string | null; queries: number; points: number; compute_seconds: number; days: { day: string; compute_seconds: number; queries: number }[] };
export type AlertJobConfig = {
  batch: { spark_profiles: string[]; fail_on_any: boolean; default_lookback: string; first_run_read_limit: number | null; timeout_hours: number; schedule: { kind: "on_data" | "every"; minutes: number } };
  streaming: { profiles: string[]; fail_on_any: boolean; polling_interval_s: number; allowed_lateness_s: number; excluded_syncs: string[]; every_s: number; default_lookback: string };
};
export type AlertJob = {
  alert_object_type_id: string;
  alert_object_type: string;
  mode: "batch" | "streaming";
  config: AlertJobConfig;
  status: string | null;
  last_run_at: string | null;
  runs: { at: string; trigger: string; status: string; ms: number; error?: string; automations: Record<string, { status: string; objects?: number; alerts_created?: number; alerts_closed?: number; points_scanned?: number; errors?: { primary_key: string; error: string }[] }> }[];
  automations: { id: string; name: string; enabled: boolean; mode: string }[];
  input_syncs: string[];
};

const enc = encodeURIComponent;
export const tsOntology = {
  objectTypes: () => req<TsObjectType[]>("/api/timeseries/object-types"),
  config: (typeId: string) => req<TimeSeriesConfig>(`/api/timeseries/object-types/${typeId}/config`),
  saveConfig: (typeId: string, body: Omit<TimeSeriesConfig, "object_type_id" | "units" | "interpolations">) =>
    req<TimeSeriesConfig>(`/api/timeseries/object-types/${typeId}/config`, { method: "PUT", json: body }),
  addTsp: (typeId: string, body: { property: string; syncs: string[]; unit?: Formatting; interpolation?: Formatting; external?: string; sensor?: SensorConfig | null; make_default?: boolean }) =>
    req<TimeSeriesConfig>(`/api/timeseries/object-types/${typeId}/time-series-properties`, { method: "POST", json: body }),
  removeTsp: (typeId: string, prop: string) => req<TimeSeriesConfig>(`/api/timeseries/object-types/${typeId}/time-series-properties/${enc(prop)}`, { method: "DELETE" }),
  diagnostics: (typeId: string) => req<Diagnostics>(`/api/timeseries/object-types/${typeId}/diagnostics`),
  objectTsps: (typeId: string, pk: string) => req<ObjectTsp[]>(`/api/timeseries/objects/${typeId}/${enc(pk)}/properties`),
  objectSeries: (typeId: string, pk: string, opts: { property: string; start?: string | null; end?: string | null; buckets?: number; resource?: string; rolling?: string; aggregation?: string }) =>
    req<SeriesResult & { points_scanned: number; compute_seconds: number }>(`/api/timeseries/objects/${typeId}/${enc(pk)}/series${q(opts)}`),
  query: (body: QueryBody) => req<QueryResult>("/api/timeseries/query", { method: "POST", json: body }),
  /** each object's track latitude / longitude time series joined: the Map's observations */
  objectTracks: (typeId: string, opts: { start?: string; end?: string } = {}) =>
    req<{ total: number; truncated: boolean; observations: Observation[]; errors: string[]; name: string }>(`/api/timeseries/object-types/${typeId}/tracks${q(opts)}`),
  createBackedType: (body: { dataset_id: string; display_name: string; primary_key: string; title_property?: string; timeseries_columns: string[]; description?: string }) =>
    req<{ id: string; display_name: string; imported: number }>("/api/timeseries/setup/object-type", { method: "POST", json: body }),
  syncBacking: (typeId: string) => req<{ imported: number; synced_at: string }>(`/api/timeseries/object-types/${typeId}/sync-backing`, { method: "POST" }),
  home: () => req<CatalogHome>("/api/timeseries/catalog/home"),
  viewed: (kind: CatalogCard["kind"] | "quiver", rid: string) => req<unknown>("/api/timeseries/catalog/viewed", { method: "POST", json: { kind, rid } }).catch(() => null),
  favorite: (kind: CatalogCard["kind"], rid: string, favorite: boolean) => req<unknown>("/api/timeseries/catalog/favorites", { method: "PUT", json: { kind, rid, favorite } }),
  usage: (days = 30) => req<{ resources: UsageRow[]; total_compute_seconds: number; formula: string }>(`/api/timeseries/usage${q({ days })}`),

  visualFunctions: () => req<VisualFunction[]>("/api/timeseries/visual-functions"),
  visualFunction: (id: string) => req<VisualFunction & { logic: Logic }>(`/api/timeseries/visual-functions/${id}`),
  createVisualFunction: (body: { name: string; description?: string; logic: Logic; output: string; inputs: { card: string; name?: string }[] }) =>
    req<VisualFunction>("/api/timeseries/visual-functions", { method: "POST", json: body }),
  deleteVisualFunction: (id: string) => req<unknown>(`/api/timeseries/visual-functions/${id}`, { method: "DELETE" }),
  derivedList: (filter: { type?: string; root_object_type_id?: string; bound_object_type_id?: string } = {}) => req<DerivedSeries[]>(`/api/timeseries/derived${q(filter)}`),
  derived: (id: string) => req<DerivedSeries>(`/api/timeseries/derived/${id}`),
  createDerived: (body: { name: string; description?: string; type: "templated" | "single"; root_object_type_id?: string | null; bound_object_type_id: string; logic: Logic; saving?: DerivedSaving; folder?: string; version_description?: string }) =>
    req<DerivedSeries>("/api/timeseries/derived", { method: "POST", json: body }),
  updateDerived: (id: string, body: { name?: string; description?: string; logic?: Logic; version_description?: string }) =>
    req<DerivedSeries>(`/api/timeseries/derived/${id}`, { method: "PUT", json: body }),
  saveDerivedOntology: (id: string, saving: DerivedSaving) => req<DerivedSeries>(`/api/timeseries/derived/${id}/ontology`, { method: "PUT", json: saving }),
  deleteDerived: (id: string) => req<{ deleted: string; objects_left: number }>(`/api/timeseries/derived/${id}`, { method: "DELETE" }),
  previewDerived: (id: string, body: { logic?: Logic; root?: ObjRef | null; start?: string | null; end?: string | null; version?: string }) =>
    req<QueryResult>(`/api/timeseries/derived/${id}/preview`, { method: "POST", json: body }),
  ontologyStatus: (id: string) => req<OntologyStatus>(`/api/timeseries/derived/${id}/ontology-status`),
  deploy: (id: string, actions: DerivedSaving["actions"] = {}) => req<OntologyStatus & { edits: number }>(`/api/timeseries/derived/${id}/deploy`, { method: "POST", json: { actions } }),
  deleteFromOntology: (id: string, action?: string) => req<{ deleted: number }>(`/api/timeseries/derived/${id}/delete-from-ontology`, { method: "POST", json: { action: action ?? null } }),

  analyses: () => req<Analysis[]>("/api/timeseries/quiver"),
  analysis: (id: string) => req<Analysis>(`/api/timeseries/quiver/${id}`),
  createAnalysis: (body: Partial<Analysis>) => req<Analysis>("/api/timeseries/quiver", { method: "POST", json: body }),
  publishDashboard: (id: string, body: { folder_id?: string | null; note?: string }) =>
    req<{ item_id: string; version: number }>(`/api/timeseries/quiver/${id}/publish`, { method: "POST", json: body }),
  publishedDashboards: () => req<PublishedDashboardRow[]>("/api/timeseries/quiver-dashboards"),
  publishedDashboard: (itemId: string, version?: number, object?: ObjRef) => {
    const q = new URLSearchParams();
    if (version) q.set("version", String(version));
    if (object) {
      q.set("object_type_id", object.object_type_id);
      q.set("primary_key", object.primary_key);
    }
    const qs = q.toString();
    return req<PublishedDashboard>(`/api/timeseries/quiver-dashboards/${itemId}${qs ? `?${qs}` : ""}`);
  },
  saveAnalysis: (id: string, body: Partial<Analysis>) => req<Analysis>(`/api/timeseries/quiver/${id}`, { method: "PUT", json: body }),
  deleteAnalysis: (id: string) => req<unknown>(`/api/timeseries/quiver/${id}`, { method: "DELETE" }),

  alertObjectTypes: () => req<{ id: string; display_name: string; streaming: boolean }[]>("/api/timeseries/alerting/alert-object-types"),
  createAlertObjectType: (display_name: string, streaming = true) =>
    req<{ id: string; display_name: string }>("/api/timeseries/alerting/alert-object-types", { method: "POST", json: { display_name, streaming } }),
  alertJob: (alertTypeId: string) => req<AlertJob>(`/api/timeseries/alerting/jobs/${alertTypeId}`),
  saveAlertJob: (alertTypeId: string, body: Partial<AlertJobConfig>) => req<AlertJob>(`/api/timeseries/alerting/jobs/${alertTypeId}/config`, { method: "PUT", json: body }),
  runAlertJob: (alertTypeId: string) => req<unknown>(`/api/timeseries/alerting/jobs/${alertTypeId}/run`, { method: "POST" }),
};

/** Relative ranges ("last 7 days") as ISO start / end. */
export function resolveRange(r: { start?: string | null; end?: string | null; last?: string | null } | null | undefined): { start: string | null; end: string | null } {
  if (!r) return { start: null, end: null };
  if (r.last) {
    const ms = durationMs(r.last);
    return ms ? { start: new Date(Date.now() - ms).toISOString(), end: null } : { start: null, end: null };
  }
  return { start: r.start || null, end: r.end || null };
}

export function durationMs(text: string): number | null {
  const m = String(text).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(ms|s|m|min|h|d|w|mo|y)$/);
  if (!m) return null;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_592_000_000, y: 31_536_000_000 };
  return Number(m[1]) * unit[m[2]];
}

export const fmtValue = (v: unknown): string =>
  v === null || v === undefined || v === ""
    ? "—"
    : typeof v === "number"
      ? Math.abs(v) >= 1000 || Number.isInteger(v)
        ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : v.toPrecision(4)
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
