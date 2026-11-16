/** Contour (api/contour.py): analyses of paths of boards on datasets and Ontology objects, with parameters and dashboards. */
import { API_URL, type DriveItem } from "./api";

export const TRANSFORM_BOARDS = ["filter", "expression", "edit_columns", "reorder_columns", "sort", "join", "enrich", "set_math", "transform_data", "unpivot", "dedupe", "cipher"] as const;
export const VISUAL_BOARDS = ["table", "histogram", "distribution", "time_series", "chart", "heatmap", "pivot", "calculation", "map", "export"] as const;
export type BoardType = (typeof TRANSFORM_BOARDS)[number] | (typeof VISUAL_BOARDS)[number];

export const BOARD_LABEL: Record<BoardType, string> = {
  filter: "Filter",
  expression: "Expression",
  edit_columns: "Column editor",
  reorder_columns: "Reorder columns",
  sort: "Sort",
  join: "Join",
  enrich: "Add columns (enrich)",
  set_math: "Set math",
  transform_data: "Transform data",
  unpivot: "Unpivot",
  dedupe: "Remove duplicates",
  cipher: "Cipher (encrypt / decrypt / hash)",
  table: "Table",
  histogram: "Histogram",
  distribution: "Distribution",
  time_series: "Time series",
  chart: "Chart",
  heatmap: "Heat grid",
  pivot: "Pivot table",
  calculation: "Summary statistics",
  map: "Map",
  export: "Export",
};

export type SourceRef = { kind: "dataset" | "object_type" | "path" | "restricted_view"; id: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BoardConfig = Record<string, any>;
export type Board = { id: string; type: BoardType; title?: string; config: BoardConfig; selection?: unknown[] | null };
export type ContourPath = { id: string; name: string; source: SourceRef; boards: Board[] };
export type ContourParameter = { name: string; type: "string" | "number" | "date"; default?: unknown; multi?: boolean; values?: unknown[]; suggest?: { source: SourceRef; column: string } };
export type DashItem = { kind: "board"; path: string; board: string; width?: "full" | "half" } | { kind: "text"; text: string; width?: "full" | "half" };
export type Saved = {
  dataset_id: string;
  name: string;
  rows: number;
  built_at: string;
  params: Record<string, unknown>;
  schedule?: { every_hours: number; next_at: string; last_run_at?: string };
  last_status?: "succeeded" | "failed";
  last_error?: string | null;
  /** the engine that built it: duckdb (in memory) or duckdb-scan (large datasets scanned from disk) */
  engine?: "duckdb" | "duckdb-scan";
};
/** Which engine runs a path (api/contour_scale.py): auto scans datasets over the thresholds from disk, memory always
 * reads them into memory, spark runs the path on a local Spark session (DuckDB when Spark cannot run it). */
export type EngineSettings = { mode?: "auto" | "memory" | "spark"; large_rows?: number; large_bytes?: number; spark_rows?: number };
/** What a run says about its engine: which one ran, the sources' sizes (scan: read lazily from disk), fallback notes. */
export type EngineReport = {
  engine: "duckdb" | "duckdb-scan" | "spark";
  mode: "auto" | "memory" | "spark";
  large_rows: number;
  large_bytes: number;
  sources: { kind: string; id: string; name: string | null; rows: number | null; bytes: number | null; scan: boolean }[];
  notes: string[];
};
export type Analysis = {
  /** the revision (each save adds one; a save from an older one is refused) */
  rev?: number;
  title: string;
  description?: string;
  parameters: ContourParameter[];
  /** expressions in Spark SQL (Contour's expression language, translated to DuckDB) or DuckDB SQL (the default) */
  expression_dialect?: "spark" | "duckdb";
  /** the engine for large inputs (default: auto) */
  engine?: EngineSettings;
  paths: ContourPath[];
  dashboard: { tabs: { id: string; name: string; items: DashItem[] }[] };
  saved: Record<string, Saved>;
};
export type AnalysisView = { item: DriveItem & { path?: { id: string; name: string }[] }; analysis: Analysis; can_edit: boolean };
/** A color legend computed on the server: the most frequent categories (up to 10) or a numeric range. */
export type ColorLegend = { kind: "category"; values: (string | null)[]; counts: number[]; distinct: number } | { kind: "scale"; min: number | null; max: number | null };
/** A scatter plot (api/contour_viz.py): points (data: key = x, value = y, color, size) or density bins (data: bx, by, count). */
export type ScatterMeta = {
  mode: "points" | "bins";
  n: number;
  total: number;
  /** rows left out: not numeric, or <= 0 on a log axis */
  excluded: number;
  limit: number;
  x0: number | null;
  x1: number | null;
  y0: number | null;
  y1: number | null;
  log_x: boolean;
  log_y: boolean;
  /** least squares on the plotted values (log10 on log axes) */
  trend: { slope: number; intercept: number; r2: number | null } | null;
  size?: { min: number | null; max: number | null };
  color?: ColorLegend;
  bins?: number;
  max_count?: number;
};
/** One map layer's data (columnar arrays) as computed by api/contour_viz.py. */
export type MapLayerResult = {
  id: string;
  type: "point" | "cluster" | "heatmap" | "choropleth" | "line";
  error?: string;
  total?: number;
  points?: { lat: number[]; lon: number[]; color?: unknown[]; tooltip?: (string | null)[]; size?: (number | null)[] };
  /** point size by a column: its range over the usable rows (n; missing: no usable value) and 4 equal steps of the scale */
  size?: MapSizeLegend;
  color?: ColorLegend;
  /** cluster / heatmap: cells of `cell` degrees (level k); n, s, mn, mx, nv merge into coarser cells */
  k?: number;
  cell?: number;
  metric?: string;
  mergeable?: boolean;
  cells?: { gx: number[]; gy: number[]; n: number[]; lat: number[]; lon: number[]; value: (number | null)[]; s?: (number | null)[]; mn?: (number | null)[]; mx?: (number | null)[]; nv?: number[] };
  regions?: { id: unknown; name: unknown; geometry: GeoGeometry | null; value: number | null; n: number }[];
  min?: number | null;
  max?: number | null;
  matched?: number;
  unmatched?: string[];
  unmatched_count?: number;
  /** a GeoJSON column's shapes; key: md5 of the column's text (what a shape selection filters on) */
  shapes?: { geometry: GeoGeometry; key?: string; value: unknown; tooltip?: string | null }[];
  invalid?: number;
  lines?: { lat: number[]; lon: number[]; lat2: number[]; lon2: number[]; value?: unknown[]; tooltip?: (string | null)[] };
};
export type GeoGeometry = { type: string; coordinates?: unknown; geometries?: GeoGeometry[] };
export type MapSizeLegend = {
  column?: string;
  scale: "linear" | "log" | "sqrt";
  n: number;
  missing: number;
  min: number | null;
  max: number | null;
  bins: { lo: number; hi: number; n: number }[];
};
export type BoardResult = {
  rows?: number;
  columns?: string[];
  data?: Record<string, unknown>[];
  data_columns?: string[];
  total?: number;
  error?: string;
  scatter?: ScatterMeta;
  map?: { layers: MapLayerResult[] };
};
export type PathResult = { source: { rows?: number; columns?: string[]; error?: string }; boards: Record<string, BoardResult>; params?: Record<string, unknown>; engine?: EngineReport };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/contour" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const contour = {
  sources: () =>
    req<{ datasets: { id: string; name: string; path: string[] }[]; object_types: { id: string; name: string; properties: { name: string; label: string }[] }[] }>("/sources"),
  list: () => req<(DriveItem & { path?: { id: string; name: string }[] })[]>("/analyses"),
  create: (title: string, source?: SourceRef, parentId?: string | null) => req<AnalysisView>("/analyses", { method: "POST", json: { title, source, parent_id: parentId ?? undefined } }),
  get: (id: string) => req<AnalysisView>(`/analyses/${id}`),
  /** the analysis' rev is the revision it was loaded at: a save over a newer one is refused */
  save: (id: string, analysis: Analysis) => req<AnalysisView>(`/analyses/${id}`, { method: "PUT", json: { analysis } }),
  run: (id: string, path: string, params: Record<string, unknown>) => req<PathResult>(`/analyses/${id}/paths/${path}/run`, { method: "POST", json: { params } }),
  dashboard: (id: string, params: Record<string, unknown>, selections: Record<string, unknown>) =>
    req<{ paths: Record<string, PathResult> }>(`/analyses/${id}/dashboard`, { method: "POST", json: { params, selections } }),
  suggestions: (id: string, name: string) => req<unknown[]>(`/analyses/${id}/parameters/${name}/suggestions`),
  saveDataset: (id: string, path: string, name: string, params: Record<string, unknown>) => req<Saved>(`/analyses/${id}/paths/${path}/save`, { method: "POST", json: { name, params } }),
  build: (id: string, path: string) => req<Saved>(`/analyses/${id}/paths/${path}/build`, { method: "POST" }),
  schedule: (id: string, path: string, everyHours: number | null) =>
    req<Saved>(`/analyses/${id}/paths/${path}/schedule`, { method: "PUT", json: { every_hours: everyHours } }),
  sql: (id: string, path: string, params: Record<string, unknown>) =>
    req<{ sql: string; single_source: boolean; source: SourceRef; inputs?: number; exportable?: boolean }>(`/analyses/${id}/paths/${path}/sql?params=${encodeURIComponent(JSON.stringify(params))}`),
  /** Export to Pipeline Builder: a new pipeline with an input per dataset, join / union nodes and the boards as SQL steps (translated to SQLite); notes: what was taken from the data */
  toPipeline: (id: string, path: string, params: Record<string, unknown>, name?: string) =>
    req<{ item: { id: string; name: string }; sql: string; queries?: string[]; notes?: string[]; inputs?: number }>(`/analyses/${id}/paths/${path}/to-pipeline`, { method: "POST", json: { params, name } }),
  csvUrl: (id: string, path: string, board: string, params: Record<string, unknown>) =>
    `${API_URL}/api/contour/analyses/${id}/paths/${path}/boards/${board}/csv?params=${encodeURIComponent(JSON.stringify(params))}`,
};
