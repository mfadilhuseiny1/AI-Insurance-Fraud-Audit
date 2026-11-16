/** Fusion spreadsheets (api/fusion.py, formulas in api/fusion_formula.py). */
import { API_URL, type DriveItem } from "./api";
import type { IconName } from "@/components/Icon";

export type CellFormat = { bold?: boolean; italic?: boolean; color?: string; fill?: string; number?: "general" | "0.00" | "currency" | "percent"; align?: "left" | "center" | "right" };
export type Cell = { input?: string; format?: CellFormat; locked?: boolean; selected?: unknown };
export type TableRegion = { id: string; name: string; start: string; columns: number; rows: number; sync?: { name?: string; dataset_id?: string; synced_at?: string; rows?: number } };
export type ConditionalRule = {
  id?: string;
  range: string;
  op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "between" | "contains" | "empty" | "not_empty" | "scale";
  value?: string | null;
  value2?: string | null;
  fill?: string | null;
  color?: string | null;
  bold?: boolean;
  min_color?: string | null;
  max_color?: string | null;
};
export type Sheet = { id: string; name: string; cells: Record<string, Cell>; tables: TableRegion[]; sync?: TableRegion["sync"]; col_widths?: Record<string, number>; conditional?: ConditionalRule[] };
export type FusionDocument = { version: 1; sheets: Sheet[]; settings: { presentation?: boolean; hide_grid?: boolean; auto_update?: boolean }; template?: boolean };
/** a computed value: d = what the cell shows, v = the value (rich values carry __kind__) */
export type CellValue = { d: string; v: unknown };

/** What a cell holding an error shows; any other error shows #ERROR. The same table is api/fusion_formula.py's ERROR_TEXT. */
export const ERROR_TEXT = { spill: "#SPILL!", ref: "#REF!", na: "#N/A", calc: "#CALC!" } as const;
export type ErrorCode = keyof typeof ERROR_TEXT;
export const errorText = (code: unknown): string => (typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ?ERROR_TEXT[code as ErrorCode] : "#ERROR");
/** one series of a chart cell: x as given, y numbers (null = no value), x_num the positions on a number / time axis */
export type ChartPlot = {
  type: "bar" | "line";
  x: (string | number | null)[];
  y: (number | null)[];
  x_kind: "number" | "date" | "category";
  x_num: number[] | null;
  options: { drawLabels?: boolean; orientation?: "horizontal" | "vertical"; dataMarkers?: boolean; color?: string };
};
export type ChartValue = {
  __kind__: "chart";
  plots: ChartPlot[];
  options: { showAxes?: boolean; showLegend?: boolean; showResetZoomButton?: boolean; showToolbar?: boolean; tooltip?: false | "closest" | "aggregate"; yAxisInset?: boolean; rangeSelection?: false | "select" | "visual"; height?: number; width?: number };
};
export type RichValue =
  | ChartValue
  | { __kind__: "chart_options"; options: Record<string, unknown> }
  | { __kind__: "matrix"; rows: unknown[][] }
  | { __kind__: "checkbox"; value: boolean; label: string; bound: { sheet: string; cell: string } | null }
  | { __kind__: "datepicker"; value: string | null; precision: "NONE" | "MINUTE" | "SECOND"; bound: { sheet: string; cell: string } | null }
  | { __kind__: "error"; message: string; code?: ErrorCode }
  | { __kind__: "dropdown"; options: unknown[]; value: unknown; multi?: boolean; objects?: Record<string, string>; object_type_id?: string | null; rids?: Record<string, string>; placeholder?: string | null }
  /** an Ontology object (object(), object_set() items): shows its title */
  | { __kind__: "object"; rid: string; object_type_id: string; object_type: string; primary_key: string; title: string; properties: Record<string, unknown> }
  /** a property read with get_property(): the value, and the object it came from */
  | { __kind__: "property"; value: unknown; property: string; rid: string; object_type_id: string }
  | { __kind__: "submit_options"; options: Record<string, boolean> }
  | { __kind__: "action"; action: string; label?: { text?: string; intent?: string; type?: "button" | "link" | "tag"; icon?: string } }
  | { __kind__: "validation"; ok: boolean; message: string }
  | { __kind__: "url"; href: string; value: string }
  | { __kind__: "styled"; value: unknown; color?: string | null; tooltip?: string | null }
  | { __kind__: "array"; items: unknown[] }
  | { __kind__: "label"; text: string; intent?: string; type?: "button" | "link" | "tag"; icon?: string }
  | { __kind__: "timeseries"; label: string; points: [number, unknown][] };
/** how one evaluation's lookups on a dataset ran: through its index or by scanning it */
export type LookupStats = { count: number; indexed: number; scanned: number; ms: number; filter_columns: string[]; scan_reason: string | null };
export type IndexStatus = "up_to_date" | "syncing" | "stale" | "failed" | "missing";
export type Source = {
  id: string;
  name: string;
  updated_at: string;
  cached_at?: string;
  pinned?: boolean;
  index?: { status: IndexStatus; keys: string[] | null; rows: number | null; built_at: string | null; error: string | null } | null;
  lookup?: LookupStats;
};
/** a dataset's index for lookups (api/fusion_index.py): a sidecar built from one version of the dataset */
export type DatasetIndex = {
  dataset_id: string;
  name: string | null;
  path: string[];
  keys: string[] | null;
  built_keys: string[] | null;
  status: IndexStatus;
  rows: number | null;
  dataset_rows: number | null;
  columns: string[] | null;
  distinct: Record<string, number> | null;
  unheld_columns: string[];
  size_bytes: number | null;
  version: string | null;
  transaction: string | null;
  dataset_updated_at: string | null;
  built_at: string | null;
  built_by: string | null;
  build_ms: number | null;
  created_at: string | null;
  created_by: string | null;
  error: string | null;
  progress: { rows: number; total: number | null } | null;
};
export type IndexLimits = { max_keys: number; max_indexes: number; max_index_bytes: number; max_total_bytes: number; max_rows: number; total_bytes: number; indexes: number };
export type DocumentLookups = {
  manual: boolean;
  datasets: { id: string; name: string; updated_at: string | null; cached_at: string | null; pinned: boolean; path: string[]; columns: string[]; lookup: LookupStats | null; index: DatasetIndex | null }[];
  limits: IndexLimits;
};
export type LocatedItem = DriveItem & { path?: { id: string; name: string }[] };
export type FusionView = {
  item: LocatedItem;
  document: FusionDocument;
  values: Record<string, Record<string, CellValue>>;
  sources: Source[];
  can_edit: boolean;
  /** the stored content's stamp: co-editors compare it with item.updated_at (1 s resolution) */
  revision?: string;
  synced?: { table: string; dataset_id: string; rows: number }[];
};
/** what an action asks the browser to do: action.open_url, action.open_markdown_panel */
export type ActionEffect = { type: "open_url"; url: string; redirect: boolean } | { type: "markdown_panel"; title: string; markdown: string };
export type ActionResult = FusionView & { ok: boolean; error: string | null; toasts: { message: string; intent: string }[]; applied: { action_type: string; edits: number }[]; effects?: ActionEffect[] };
export type Snapshot = { id: string; at: string; by: string; label: string; auto: boolean; cells: number };
export type IndexedDataset = { id: string; name: string; path: string[]; updated_at: string };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/fusion" + path, {
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

export const fusion = {
  list: () => req<LocatedItem[]>("/documents"),
  create: (name: string, parent_id?: string | null) => req<FusionView>("/documents", { method: "POST", json: { name, parent_id } }),
  get: (id: string, params: Record<string, string> = {}) => req<FusionView>(`/documents/${id}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`),
  save: (id: string, document: FusionDocument) => req<FusionView>(`/documents/${id}`, { method: "PUT", json: { document } }),
  conditional: (id: string, sheet: string, rules: ConditionalRule[]) => req<FusionView>(`/documents/${id}/sheets/${sheet}/conditional`, { method: "PUT", json: { rules } }),
  cells: (id: string, body: { sheet: string; cells?: Record<string, string | null>; selected?: Record<string, unknown>; formats?: Record<string, CellFormat | null>; locks?: Record<string, boolean> }) =>
    req<FusionView>(`/documents/${id}/cells`, { method: "PUT", json: body }),
  addSheet: (id: string, name?: string) => req<FusionView>(`/documents/${id}/sheets${name ? `?name=${encodeURIComponent(name)}` : ""}`, { method: "POST" }),
  createTable: (id: string, body: { sheet: string; name: string; start: string; columns: number; rows: number }) => req<FusionView>(`/documents/${id}/tables`, { method: "POST", json: body }),
  sortTable: (id: string, table: string, column: string, descending: boolean) => req<FusionView>(`/documents/${id}/tables/${encodeURIComponent(table)}/sort`, { method: "POST", json: { column, descending } }),
  appendRow: (id: string, table: string, values: unknown[] = []) => req<FusionView>(`/documents/${id}/tables/${encodeURIComponent(table)}/rows`, { method: "POST", json: { values } }),
  syncSheet: (id: string, sheet: string, body: { name?: string; enabled?: boolean }) => req<FusionView>(`/documents/${id}/sheets/${encodeURIComponent(sheet)}/sync`, { method: "PUT", json: body }),
  updateSources: (id: string) => req<FusionView>(`/documents/${id}/update-sources`, { method: "POST" }),
  syncTable: (id: string, table: string, body: { name?: string; enabled?: boolean }) => req<FusionView>(`/documents/${id}/tables/${encodeURIComponent(table)}/sync`, { method: "PUT", json: body }),
  action: (id: string, sheet: string, cell: string) => req<ActionResult>(`/documents/${id}/actions`, { method: "POST", json: { sheet, cell } }),
  /** a checkbox cell's click (true / false) or a datepicker cell's date (null clears it) */
  control: (id: string, sheet: string, cell: string, value: boolean | string | null) => req<FusionView>(`/documents/${id}/control`, { method: "PUT", json: { sheet, cell, value } }),
  history: (id: string) => req<Snapshot[]>(`/documents/${id}/history`),
  snapshot: (id: string, label: string) => req<Snapshot>(`/documents/${id}/history`, { method: "POST", json: { label } }),
  restore: (id: string, snapId: string) => req<FusionView>(`/documents/${id}/history/${snapId}/restore`, { method: "POST" }),
  copy: (id: string, body: { name?: string; overrides?: Record<string, string> } = {}) => req<FusionView>(`/documents/${id}/copy`, { method: "POST", json: body }),
  importXlsx: (body: { name?: string; item_id?: string; data?: string }) => req<FusionView>("/import-xlsx", { method: "POST", json: body }),
  datasets: () => req<IndexedDataset[]>("/datasets"),
  preview: (id: string) => req<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total: number }>(`/datasets/${id}/preview`),
  /** the datasets a document's lookups read, their indexes and how the lookups ran */
  lookups: (id: string) => req<DocumentLookups>(`/documents/${id}/lookups`),
  indexes: () => req<DatasetIndex[]>("/indexes"),
  index: (datasetId: string) => req<DatasetIndex>(`/indexes/${datasetId}`),
  createIndex: (datasetId: string, keys: string[]) => req<DatasetIndex>("/indexes", { method: "POST", json: { dataset_id: datasetId, keys } }),
  rebuildIndex: (datasetId: string) => req<DatasetIndex>(`/indexes/${datasetId}/rebuild`, { method: "POST" }),
  removeIndex: (datasetId: string) => req<{ removed: string }>(`/indexes/${datasetId}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------- addresses

export const colLetters = (i: number) => {
  let s = "";
  let n = i + 1;
  while (n) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
export const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const addr = (r: number, c: number) => `${colLetters(c)}${r + 1}`;
export function parseAddr(a: string): [number, number] {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(a);
  return m ? [Number(m[2]) - 1, colIndex(m[1])] : [0, 0];
}

// what shifting reads in a formula, in this order: a quoted string (a sheet name when "!" follows), a double-quoted
// string, a sheet name with "!", a cell reference ($ marks the absolute part), any other name — the same pattern as
// _SHIFT in api/fusion_formula.py, so the fill handle and paste shift exactly as the server does
const SHIFT =
  "('(?:[^']|'')*'(!(?!=))?)" +
  '|("(?:[^"]|"")*")' +
  "|([A-Za-z_][A-Za-z0-9_.]*\\s*!(?!=))" +
  "|(?<![A-Za-z0-9_.$])(\\$?)([A-Za-z]{1,3})(\\$?)([1-9][0-9]{0,5})(?![A-Za-z0-9_.$])(?!\\s*\\()" +
  "|([A-Za-z_][A-Za-z0-9_.]*)";
const MAX_ROW = 999_999;
const MAX_COL = 18_277;

/**
 * Shift a formula's relative references by rows and columns (fill handle, paste). The parts marked absolute with $
 * stay: $A$1 never moves, $A1 keeps its column, A$1 its row. References to other sheets (Sheet2!A1, 'My sheet'!A1:B2)
 * and text are left alone.
 */
export function shiftFormula(src: string | undefined, dr: number, dc: number): string | undefined {
  if (!src || !src.startsWith("=")) return src;
  const body = src.slice(1);
  const out: string[] = [];
  let last = 0;
  // where a reference qualified by a sheet name may start, and whether it is the end of that range
  let qual = -1;
  let second = false;
  for (const m of body.matchAll(new RegExp(SHIFT, "g"))) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (m[2] || m[4]) {
      qual = end;
      second = false;
      continue;
    }
    if (m[6] === undefined) {
      qual = -1;
      continue;
    }
    if (qual >= 0) {
      if (body.slice(qual, at).trim() === (second ? ":" : "")) {
        qual = second ? -1 : end;
        second = !second;
        continue;
      }
      qual = -1;
      second = false;
    }
    const col = m[6].toUpperCase();
    const c = m[5] ? col : colLetters(Math.min(MAX_COL, Math.max(0, colIndex(col) + dc)));
    const r = m[7] ? m[8] : String(Math.min(MAX_ROW, Math.max(1, Number(m[8]) + dr)));
    out.push(body.slice(last, at), `${m[5]}${c}${m[7]}${r}`);
    last = end;
  }
  out.push(body.slice(last));
  return "=" + out.join("");
}

/** The address action.open_url may open: an absolute http or https URL, or null. */
export function httpUrl(url: unknown): string | null {
  if (typeof url !== "string" || /[\s\\\u0000-\u001f\u007f]/.test(url.trim())) return null;
  try {
    const u = new URL(url.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** action.label's icon — a Blueprint icon name — as one of ours; null for names we have no icon for (the label
 * then shows its text only). */
const LABEL_ICONS: Record<string, IconName> = {
  tick: "check", "tick-circle": "check", confirm: "check", cross: "x", "cross-circle": "x", "small-cross": "x", "small-tick": "check",
  add: "plus", plus: "plus", minus: "minus", remove: "minus", trash: "trash", delete: "trash", edit: "edit", annotation: "pencil",
  document: "doc", "document-open": "doc", "share": "external", "open-application": "external", link: "link", "globe-network": "globe",
  globe: "globe", play: "play", "arrow-right": "right", "chevron-right": "right", "arrow-left": "left", "chevron-left": "left",
  "arrow-down": "down", "chevron-down": "down", download: "download", upload: "upload", "cloud-upload": "upload", "cloud-download": "download",
  refresh: "refresh", repeat: "refresh", reset: "restore", undo: "restore", history: "history", time: "clock", calendar: "clock",
  duplicate: "copy", clipboard: "copy", search: "search", filter: "filter", star: "star", "star-empty": "star", warning: "alert",
  "warning-sign": "alert", error: "alert", "info-sign": "info", info: "info", lock: "lock", unlock: "unlock", "floppy-disk": "save",
  database: "database", "th": "table", "th-list": "table", list: "list", "grid-view": "grid", eye: "eye", "eye-open": "eye",
  notifications: "bell", comment: "comment", flash: "bolt", lightning: "bolt", stop: "stop", "send-message": "right", export: "output",
  import: "download", "folder-close": "folder", "folder-open": "folder", "new-object": "cube", cube: "cube", settings: "sliders", cog: "sliders",
};
export function labelIcon(name: unknown): IconName | null {
  return typeof name === "string" ? (LABEL_ICONS[name.trim().toLowerCase()] ?? null) : null;
}

/** The table region a cell belongs to (and whether it is the header row). */
export function tableAt(sheet: Sheet, r: number, c: number): { table: TableRegion; header: boolean } | null {
  for (const t of sheet.tables) {
    const [r0, c0] = parseAddr(t.start);
    if (r >= r0 && r <= r0 + t.rows && c >= c0 && c < c0 + t.columns) return { table: t, header: r === r0 };
  }
  return null;
}

export function formatValue(v: CellValue | undefined, fmt?: CellFormat): string {
  if (!v) return "";
  const raw = v.v;
  if (typeof raw === "number" && fmt?.number && fmt.number !== "general") {
    if (fmt.number === "0.00") return raw.toFixed(2);
    if (fmt.number === "percent") return `${(raw * 100).toFixed(1)}%`;
    if (fmt.number === "currency") return raw.toLocaleString(undefined, { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
  }
  if (typeof raw === "number") return raw.toLocaleString(undefined, { maximumFractionDigits: 10 });
  return v.d;
}


function inRangeAddr(range: string, a: string): boolean {
  const [from, to] = range.split(":");
  const [r1, c1] = parseAddr(from);
  const [r2, c2] = parseAddr(to ?? from);
  const [r, c] = parseAddr(a);
  return r >= Math.min(r1, r2) && r <= Math.max(r1, r2) && c >= Math.min(c1, c2) && c <= Math.max(c1, c2);
}

function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return t < 0.5 ? a : b;
  return "#" + [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

/** The style conditional formatting gives a cell, from its computed value (later rules win). */
export function conditionalStyle(sheet: Sheet, values: Record<string, CellValue>, a: string): { background?: string; color?: string; fontWeight?: number } {
  const out: { background?: string; color?: string; fontWeight?: number } = {};
  for (const rule of sheet.conditional ?? []) {
    if (!inRangeAddr(rule.range, a)) continue;
    const v = values[a]?.v;
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;
    if (rule.op === "scale") {
      if (n === null) continue;
      const nums = Object.entries(values).filter(([k]) => inRangeAddr(rule.range, k)).map(([, x]) => x.v).filter((x): x is number => typeof x === "number");
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      out.background = mix(rule.min_color ?? "#ffffff", rule.max_color ?? "#16a34a", hi > lo ? (n - lo) / (hi - lo) : 1);
      continue;
    }
    const want = rule.value ?? "";
    const wn = want.trim() !== "" && !Number.isNaN(Number(want)) ? Number(want) : null;
    const text = v === null || v === undefined ? "" : String(v);
    const cmp = (x: number) => (n !== null && wn !== null ? n - wn : text.localeCompare(want)) * Math.sign(x || 1);
    const hit =
      rule.op === "empty" ? text === "" :
      rule.op === "not_empty" ? text !== "" :
      rule.op === "contains" ? text.toLowerCase().includes(want.toLowerCase()) :
      rule.op === "eq" ? (n !== null && wn !== null ? n === wn : text.toLowerCase() === want.toLowerCase()) :
      rule.op === "neq" ? !(n !== null && wn !== null ? n === wn : text.toLowerCase() === want.toLowerCase()) :
      rule.op === "between" ? n !== null && wn !== null && n >= wn && n <= Number(rule.value2 ?? wn) :
      text !== "" && (rule.op === "gt" ? cmp(1) > 0 : rule.op === "gte" ? cmp(1) >= 0 : rule.op === "lt" ? cmp(1) < 0 : cmp(1) <= 0);
    if (!hit) continue;
    if (rule.fill) out.background = rule.fill;
    if (rule.color) out.color = rule.color;
    if (rule.bold) out.fontWeight = 600;
  }
  return out;
}
