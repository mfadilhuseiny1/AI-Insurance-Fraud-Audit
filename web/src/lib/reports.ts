/** Reports [Sunset] (api/reports.py): parameterized reports of widgets on live data. */
import { API_URL, type DriveItem } from "./api";

export type WidgetKind = "text" | "table" | "chart" | "metric" | "object_table" | "image" | "divider" | "page_break" | "contour_board" | "quiver_card";
export type ReportFilter = { column: string; op?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "is_null" | "not_null"; value?: unknown };
export type ReportWidget = {
  id: string;
  kind: WidgetKind;
  title?: string;
  title_prefix_param?: string;
  text?: string;
  src?: string;
  width?: "full" | "half";
  height?: number;
  hidden?: boolean;
  source?: { kind: "dataset" | "object_type"; id: string };
  columns?: string[];
  filters?: ReportFilter[];
  group_by?: string;
  bucket?: "day" | "month" | "year";
  metric?: "count" | "sum" | "avg" | "min" | "max" | "distinct";
  metric_column?: string;
  chart?: "bar" | "line" | "pie";
  sort?: string;
  descending?: boolean;
  limit?: number;
  /** contour_board: a board of a Contour path; parameter values or "$param:<report parameter>" */
  contour?: { analysis_id?: string; path_id?: string; board_id?: string; params?: Record<string, string> };
  /** quiver_card: a table-side card of a Quiver analysis */
  quiver?: { analysis_id?: string; card_id?: string };
};
export type ReportParameter = { id: string; name: string; type: "string" | "number" | "date"; default?: unknown; values?: unknown[]; suggest?: { source: { kind: "dataset" | "object_type"; id: string }; column: string } };
/** rev: the revision (each save adds one; a save from an older one is merged with the saves made since) */
export type Report = { rev?: number; title: string; description?: string; parameters: ReportParameter[]; widgets: ReportWidget[] };
export type ReportView = { item: DriveItem & { path?: { id: string; name: string }[] }; report: Report; can_edit: boolean };
export type WidgetData = {
  title: string;
  text?: string;
  error?: string;
  data?: {
    total?: number;
    value?: number | null;
    columns?: { name: string; type: string }[];
    rows?: Record<string, unknown>[];
    groups?: { key: unknown; value: number | null; count: number }[];
    /** contour_board: the board and its result; quiver_card: the card and the results it reads */
    board?: unknown;
    result?: unknown;
    card?: unknown;
    results?: unknown;
    source_name?: string;
    // a Quiver time series plot or card: drawn by the browser from the analysis
    client?: boolean;
    analysis?: unknown;
    card_id?: string;
  };
};
export type ReportData = { params: Record<string, unknown>; widgets: Record<string, WidgetData> };

/** A conflict of a three-way merge on save: the same field changed differently, an item edited on one side and
 * deleted on the other (deleted_mine / deleted_theirs: that side's value is null), or a widget moved to different
 * places (position: 1-based positions). id: "report:<field>" | "<widget|parameter>:<id>:<field|deleted|position>" */
export type MergeConflict = {
  id: string;
  scope: "report" | "widget" | "parameter";
  item_id: string | null;
  field: string | null;
  label: string;
  kind: "field" | "deleted_mine" | "deleted_theirs" | "position";
  base: unknown;
  mine: unknown;
  theirs: unknown;
};
/** The 409 answer of a save from an older revision whose changes conflict with the saves made since */
export type MergeConflicts = { message: string; conflicts: MergeConflict[]; base_rev: number; theirs_rev: number; theirs_by: string[]; resolved: string[] };
export type Resolution = "mine" | "theirs";
/** A save's answer: merge is set when the save was merged with others' saves (resolved: the conflicts settled) */
export type SaveView = ReportView & { merge?: { base_rev: number; theirs_rev: number; resolved: string[] } };

/** A kept revision (newest first): who saved it, when, whether the save was merged or restored an earlier revision,
 * and what it changed from the revision before (prev_rev; null for the oldest kept) */
export type ReportRevision = {
  rev: number;
  at: string;
  by: string;
  merged?: { base_rev: number; theirs_rev: number; resolved: string[] };
  restored_from?: number;
  summary: string;
  changes: number;
  prev_rev: number | null;
};
/** One change between two revisions: a report setting, or a parameter / widget added, removed, moved or one of its
 * fields changed (before / after: null for an absent side; positions are 1-based for a move) */
export type RevisionChange = {
  scope: "report" | "parameter" | "widget";
  item_id: string | null;
  label: string;
  kind: "added" | "removed" | "changed" | "moved";
  field: string | null;
  before: unknown;
  after: unknown;
};
export type RevisionDiff = { from_rev: number; to_rev: number; changes: RevisionChange[]; summary: string };

/** An API error; detail is the answer's detail (a MergeConflicts object for a save with conflicts) */
export class ReportsError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
  get conflicts(): MergeConflicts | null {
    const d = this.detail as MergeConflicts | null;
    return this.status === 409 && d && typeof d === "object" && Array.isArray(d.conflicts) ? d : null;
  }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/reports" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    let detail: unknown = null;
    try {
      const body = await res.json();
      detail = body.detail;
      message = typeof body.detail === "string" ? body.detail : typeof body.detail?.message === "string" ? body.detail.message : JSON.stringify(body.detail);
    } catch {}
    throw new ReportsError(message, res.status, detail);
  }
  return (res.headers.get("content-type")?.includes("json") ? res.json() : res.blob()) as Promise<T>;
}

export const reports = {
  list: () => req<(DriveItem & { path?: { id: string; name: string }[] })[]>(""),
  create: (title: string, parentId?: string | null) => req<ReportView>("", { method: "POST", json: { title, parent_id: parentId ?? undefined } }),
  get: (id: string) => req<ReportView>(`/${id}`),
  /** Saves from the revision the copy was loaded at (rev; 0 for a never-saved report): saves made since are merged
   * in; conflicts throw a ReportsError with .conflicts, settled by saving again with resolutions for resolveRev */
  save: (id: string, report: Report, settle?: { resolutions: Record<string, Resolution>; resolveRev: number }) =>
    req<SaveView>(`/${id}`, { method: "PUT", json: { report: { ...report, rev: report.rev ?? 0 }, ...(settle ? { resolutions: settle.resolutions, resolve_rev: settle.resolveRev } : {}) } }),
  revisions: (id: string) => req<ReportRevision[]>(`/${id}/revisions`),
  revision: (id: string, rev: number) => req<Report>(`/${id}/revisions/${rev}`),
  /** A read-only preview of a kept revision: its widgets as that revision laid them out, on today's data */
  revisionData: (id: string, rev: number, params: Record<string, unknown>) =>
    req<ReportData & { revision: Omit<ReportRevision, "summary" | "changes" | "prev_rev"> }>(`/${id}/revisions/${rev}/data`, { method: "POST", json: { params } }),
  /** What changed from revision rev to against (default: the current revision) */
  diff: (id: string, rev: number, against?: number) => req<RevisionDiff>(`/${id}/revisions/${rev}/diff${against === undefined ? "" : `?against=${against}`}`),
  /** Restores rev as a new revision, merged with saves made since baseRev (the revision on screen) like a save;
   * conflicts throw a ReportsError with .conflicts, settled by restoring again with resolutions for resolveRev */
  restore: (id: string, rev: number, baseRev: number, settle?: { resolutions: Record<string, Resolution>; resolveRev: number }) =>
    req<SaveView & { restored_from: number }>(`/${id}/revisions/${rev}/restore`, {
      method: "POST",
      json: { base_rev: baseRev, ...(settle ? { resolutions: settle.resolutions, resolve_rev: settle.resolveRev } : {}) },
    }),
  data: (id: string, params: Record<string, unknown>) => req<ReportData>(`/${id}/data`, { method: "POST", json: { params } }),
  suggestions: (id: string, param: string) => req<unknown[]>(`/${id}/parameters/${param}/suggestions`),
  duplicate: (id: string) => req<ReportView>(`/${id}/duplicate`, { method: "POST" }),
  markdown: (id: string, params: Record<string, unknown>) => req<{ markdown: string }>(`/${id}/markdown`, { method: "POST", json: { params } }),
  pptx: (id: string, params: Record<string, unknown>) => req<Blob>(`/${id}/pptx`, { method: "POST", json: { params } }),
  toContour: (id: string) => req<{ item: { id: string } }>(`/${id}/convert-contour`, { method: "POST", json: {} }),
  toNotepad: (id: string, params: Record<string, unknown>) => req<{ notepad_id: string }>(`/${id}/convert-notepad`, { method: "POST", json: { params } }),
  csvUrl: (id: string, widget: string, params: Record<string, unknown>) => `${API_URL}/api/reports/${id}/widgets/${widget}/csv?params=${encodeURIComponent(JSON.stringify(params))}`,
  pdfUrl: (id: string) => `${API_URL}/api/reports/${id}/pdf`,
};
