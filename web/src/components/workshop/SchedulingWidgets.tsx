"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { ActionForm } from "@/components/ontology/ActionForm";
import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { actions as actionsApi, functions as functionsApi, type ActionParam, type FunctionRow } from "@/lib/actions";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { scenarios, type ScenarioDetail } from "@/lib/scenarios";
import { scheduling, type Board, type BoardData, type Highlight, type Puck, type Row, type SearchResult, type Slot } from "@/lib/scheduling";
import { sourceKey, type Module, type OsFilter, type Variable, type Widget, type WidgetConfig, type WsEvent } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

// Workshop widgets of Dynamic Scheduling (palantir.com/docs/foundry/dynamic-scheduling/scheduling-gantt-chart-widget,
// scheduling-calendar-widget), both bound to a saved scheduling board (api/dynamic_scheduling.py):
// - Scheduling Gantt: the board's resources as rows and its schedule objects (pucks) as bars over a time window, laid
//   out as the Dynamic Scheduling page lays them out; drag a puck in time or onto another row to run the board's save
//   handler; rule violations on the pucks; the unscheduled pucks listed underneath.
// - Scheduling Calendar: the same pucks in a month or a week grid.
// Selecting a puck selects that schedule object in the module and writes it to the output variables. Changes are
// written to the Ontology directly, or staged in the scenario a scenario variable holds.

const ROW_H = 46;
const LABEL_W = 170;
const HOUR_H = 30;
const HOUR = 3_600_000;
const PALETTE = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#60a5fa"];
const ms = (iso: string) => new Date(iso).getTime();
/** Whether the puck sits on that row (in the row's section). */
const onRow = (p: Puck, r: Row, primary: string) => (r.dimension === primary ? p.resource : p.resources?.[r.dimension]) === r.primary_key;

// An object set filter variable holding exactly these objects (GraphWidgets.tsx): data widgets apply it.
const pkFilter = (pks: string[]): OsFilter => ({ filters: [{ column: "__pk", op: "in", value: pks }], mode: "all" });
const NO_FILTER: OsFilter = { filters: [], mode: "all" };

// ------------------------------------------------------------------------------------------------
// time: wall-clock parts in the viewer's time zone (as the Dynamic Scheduling page shows times) or in UTC
// ------------------------------------------------------------------------------------------------

type Wall = { y: number; m: number; d: number; hours: number; dow: number };
function wall(t: number, utc: boolean): Wall {
  const x = new Date(t);
  return utc
    ? { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), hours: x.getUTCHours() + x.getUTCMinutes() / 60, dow: x.getUTCDay() }
    : { y: x.getFullYear(), m: x.getMonth(), d: x.getDate(), hours: x.getHours() + x.getMinutes() / 60, dow: x.getDay() };
}
/** The instant of a wall-clock day (days and months overflow as Date does) plus hours. */
const at = (y: number, m: number, d: number, utc: boolean, hours = 0) => (utc ? Date.UTC(y, m, d, 0, Math.round(hours * 60)) : new Date(y, m, d, 0, Math.round(hours * 60)).getTime());
const dayStart = (t: number, utc: boolean, plus = 0) => {
  const w = wall(t, utc);
  return at(w.y, w.m, w.d + plus, utc);
};
const zone = (utc: boolean) => (utc ? "UTC" : undefined);
const fmtTime = (t: number, utc: boolean) => new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: zone(utc) });
const fmtClock = (t: number, utc: boolean) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: zone(utc) });
const span = (p: Puck, utc: boolean) => (p.start ? `${fmtTime(ms(p.start), utc)}${p.end ? ` → ${fmtTime(ms(p.end), utc)}` : ""}` : "No time");

/** A date (YYYY-MM-DD: that day's start, or the next day's for an inclusive end) or a timestamp, as an instant. */
function toMs(v: unknown, utc: boolean, inclusiveEnd = false): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return at(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (inclusiveEnd ? 1 : 0), utc);
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}
/** A datetime-local value (no zone) in the widget's time zone. */
const localMs = (s: string, utc: boolean) => toMs(utc && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? `${s}Z` : s, utc);

// ------------------------------------------------------------------------------------------------
// the timeline grid precision and operating hours
// ------------------------------------------------------------------------------------------------

type GridUnit = NonNullable<WidgetConfig["ds_grid"]>;
const GRID_UNITS: { id: GridUnit; label: string }[] = [
  { id: "15m", label: "15 minutes" },
  { id: "30m", label: "30 minutes" },
  { id: "1h", label: "Hour" },
  { id: "2h", label: "2 hours" },
  { id: "3h", label: "3 hours" },
  { id: "6h", label: "6 hours" },
  { id: "12h", label: "12 hours" },
  { id: "1d", label: "Day" },
  { id: "1w", label: "Week" },
  { id: "1M", label: "Month" },
];
const MAX_TICKS = 3000;
/** The grid lines of a unit over the window (wall-clock aligned), or null when there would be too many to draw. */
function gridTicks(t0: number, t1: number, unit: GridUnit, utc: boolean, weekStart: number): number[] | null {
  const out: number[] = [];
  if (unit === "1M") {
    const w = wall(t0, utc);
    for (let i = 0; ; i++) {
      const t = at(w.y, w.m + i, 1, utc);
      if (t >= t1) break;
      if (t > t0) out.push(t);
    }
    return out;
  }
  const hours = { "15m": 0.25, "30m": 0.5, "1h": 1, "2h": 2, "3h": 3, "6h": 6, "12h": 12 }[unit as string];
  for (let d = dayStart(t0, utc); d < t1; d = dayStart(d, utc, 1)) {
    const w = wall(d, utc);
    if (hours) {
      for (let h = 0; h < 24; h += hours) {
        const t = at(w.y, w.m, w.d, utc, h);
        if (t > t0 && t < t1) out.push(t);
      }
    } else if ((unit === "1d" || w.dow === weekStart) && d > t0) out.push(d);
    if (out.length > MAX_TICKS) return null;
  }
  return out;
}
const tickLabel = (t: number, unit: GridUnit, utc: boolean) =>
  unit === "1M"
    ? new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: zone(utc) })
    : unit === "1d" || unit === "1w"
      ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: zone(utc) })
      : fmtClock(t, utc);

type Operating = NonNullable<WidgetConfig["ds_operating"]>;
/** The non-operating parts of [t0, t1) (shaded): the complement of the operating hours. */
function closedSpans(t0: number, t1: number, op: Operating | undefined, utc: boolean, board: Board): [number, number][] {
  if (!op) return [];
  const open: [number, number][] = [];
  if (op.kind === "ranges") {
    for (const r of op.ranges ?? []) {
      const a = localMs(r.start, utc);
      const b = localMs(r.end, utc);
      if (a !== null && b !== null && b > a) open.push([a, b]);
    }
  } else {
    // the board's working-hours rule counts in UTC
    const rule = op.kind === "rule" ? board.rules.find((r) => r.enabled && r.kind === "within_hours") : undefined;
    if (op.kind === "rule" && !rule) return [];
    const inUtc = op.kind === "rule" ? true : utc;
    const h0 = rule ? (rule.start_hour ?? 0) : Math.max(0, Math.min(23, op.start_hour ?? 8));
    const h1 = rule ? (rule.end_hour ?? 24) : Math.max(h0 + 1, Math.min(24, op.end_hour ?? 17));
    const days = op.kind === "weekdays" ? new Set(op.days ?? [1, 2, 3, 4, 5]) : null;
    let n = 0;
    for (let d = dayStart(t0, inUtc, -1); d < t1 && n < 1200; d = dayStart(d, inUtc, 1), n++) {
      const w = wall(d, inUtc);
      if (days && !days.has(w.dow)) continue;
      open.push([at(w.y, w.m, w.d, inUtc, h0), at(w.y, w.m, w.d, inUtc, h1)]);
    }
  }
  open.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let cur = t0;
  for (const [a, b] of open) {
    if (b <= cur) continue;
    if (a > cur) out.push([cur, Math.min(a, t1)]);
    cur = Math.max(cur, b);
    if (cur >= t1) break;
  }
  if (cur < t1) out.push([cur, t1]);
  return out.filter(([a, b]) => b > a);
}
/** Keep the pointer on the element while dragging (a pointer that is no longer active cannot be captured). */
const capture = (e: React.PointerEvent<Element>) => {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    // the drag still works while the pointer stays over the element
  }
};
/** Shading of non-operating time (operating time stays clear). */
const CLOSED_BG = "repeating-linear-gradient(135deg, rgba(148,163,184,0.10) 0 6px, rgba(148,163,184,0.04) 6px 12px)";

// ------------------------------------------------------------------------------------------------
// the change log: every change the widgets made in this browser session, per board and scenario (shared by the
// widgets on that board, kept while the tab is open)
// ------------------------------------------------------------------------------------------------

type PuckState = { resource: string | null; resources: Record<string, string | null>; start: string | null; end: string | null };
type LogEntry = {
  id: string;
  at: number;
  kind: "move" | "create" | "action";
  pk?: string;
  title: string;
  text: string;
  /** the section a move changed (its foreign key property) and the states before and after it */
  dimension?: string;
  before?: PuckState;
  after?: PuckState;
  undone?: boolean;
};
const LOGS = new Map<string, LogEntry[]>();
const LOG_LISTENERS = new Set<() => void>();
const EMPTY_LOG: LogEntry[] = [];
const logStoreKey = (k: string) => `ds-change-log:${k}`;
function readLog(key: string): LogEntry[] {
  if (!LOGS.has(key)) {
    let saved: LogEntry[] = [];
    try {
      saved = JSON.parse(sessionStorage.getItem(logStoreKey(key)) ?? "[]") as LogEntry[];
    } catch {
      saved = [];
    }
    LOGS.set(key, Array.isArray(saved) ? saved : []);
  }
  return LOGS.get(key) ?? EMPTY_LOG;
}
function writeLog(key: string, f: (cur: LogEntry[]) => LogEntry[]) {
  const next = f(readLog(key)).slice(-200);
  LOGS.set(key, next);
  try {
    sessionStorage.setItem(logStoreKey(key), JSON.stringify(next));
  } catch {
    // storage full or blocked: the log stays in memory
  }
  LOG_LISTENERS.forEach((l) => l());
}
function useChangeLog(key: string): LogEntry[] {
  return useSyncExternalStore(
    (l) => {
      LOG_LISTENERS.add(l);
      return () => LOG_LISTENERS.delete(l);
    },
    () => (key ? readLog(key) : EMPTY_LOG),
    () => EMPTY_LOG,
  );
}
const stateOf = (p: Puck): PuckState => ({ resource: p.resource, resources: { ...(p.resources ?? {}) }, start: p.start, end: p.end });
const sameTime = (a: string | null, b: string | null) => (a ? ms(a) : null) === (b ? ms(b) : null);
const sameState = (a: PuckState, b: PuckState) =>
  (a.resource ?? null) === (b.resource ?? null) &&
  sameTime(a.start, b.start) &&
  sameTime(a.end, b.end) &&
  Object.keys({ ...a.resources, ...b.resources }).every((k) => (a.resources[k] ?? null) === (b.resources[k] ?? null));
let logSeq = 0;
const newId = () => `${Date.now().toString(36)}-${++logSeq}`;

// ------------------------------------------------------------------------------------------------
// the board: its data, the selection and the save handler
// ------------------------------------------------------------------------------------------------

type Change = { resource?: string | null; dimension?: string; start?: string | null; end?: string | null; exact?: boolean };
type Note = { text: string; bad: boolean };
type BoardApi = {
  data: BoardData;
  utc: boolean;
  scenarioId?: string;
  selected?: string;
  pick: (pk: string | undefined) => void;
  /** whether pucks can be moved (not in the editor, not in a read-only module, and enabled on the widget) */
  canEdit: boolean;
  whyReadOnly: string;
  busy: boolean;
  note: Note | null;
  setNote: (n: Note | null) => void;
  move: (pk: string, change: Change) => Promise<boolean>;
  /** the change log of this board (and scenario), newest last; undo restores the state before a move */
  log: LogEntry[];
  record: (e: Omit<LogEntry, "id" | "at">) => void;
  undo: (e: LogEntry) => Promise<boolean>;
  clearLog: () => void;
  /** after an action outside the save handler: every widget reloads */
  reload: () => void;
  /** the search results output (null: no results) */
  output: (pks: string[] | null) => void;
  /** after Apply: the scenario variable is pointed at a fresh scenario */
  setScenario: (id: string) => void;
};
type Loaded = { scope: string; data?: BoardData; error?: string };

function useBoard(widget: Widget, state: ModuleState, editing: boolean, editableByDefault: boolean): { message?: string; bad?: boolean; api?: BoardApi } {
  const c = widget.config;
  const bid = c.ds_board_id;
  const scenarioId = c.ds_scenario_variable ? String(state.variables[c.ds_scenario_variable] ?? "") || undefined : undefined;
  const scope = bid ? `${bid}|${scenarioId ?? ""}` : "";
  const [res, setRes] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const log = useChangeLog(scope);
  const version = state.version;
  useEffect(() => {
    if (!bid) return;
    let stale = false;
    scheduling.data(bid, scenarioId).then(
      (data) => !stale && setRes({ scope, data }),
      (e: Error) => !stale && setRes({ scope, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [bid, scenarioId, scope, version]);
  if (!bid) return { message: "Choose the scheduling board to show" };
  // a reload (after an action, or a move in another widget) keeps the drawn board until the new data arrives
  if (!res || res.scope !== scope) return { message: "Loading…" };
  if (res.error || !res.data) return { message: res.error ?? "The board did not load", bad: true };
  const data = res.data;
  const src = sourceKey({ kind: "object_type", id: data.board.schedule_object_type_id });
  const selected = state.selection[src];
  const enabled = c.ds_editable ?? editableByDefault;
  const canEdit = enabled && !editing && !state.readOnly;
  const whyReadOnly = !enabled ? "Read-only" : state.readOnly ? "Read-only: this module does not write" : editing ? "Moves are off while the module is edited" : "";
  const pick = (pk: string | undefined) => {
    if (pk === selected) return;
    state.select(src, pk);
    // a string variable holds the primary key; an object set / array variable holds the one selected object
    if (c.ds_selected_variable) state.setVariable(c.ds_selected_variable, state.variableTypes?.[c.ds_selected_variable] === "string" ? (pk ?? "") : pk ? [pk] : []);
    // nothing selected: the filter variable does not filter
    if (c.ds_selected_filter_variable) state.setVariable(c.ds_selected_filter_variable, pk ? pkFilter([pk]) : NO_FILTER);
    void state.runEvents?.(c.ds_events ?? []);
  };
  const utc = c.ds_timezone === "utc";
  const record = (e: Omit<LogEntry, "id" | "at">) => writeLog(scope, (cur) => [...cur, { ...e, id: newId(), at: Date.now() }]);
  const rowTitle = (dim: string, pk: string | null | undefined) => (pk ? (data.rows.find((r) => r.dimension === dim && r.primary_key === pk)?.title ?? pk) : "no resource");
  const describe = (p: Puck, before: PuckState, after: PuckState, dim: string) => {
    const was = dim === data.board.resource_property ? before.resource : before.resources[dim];
    const now = dim === data.board.resource_property ? after.resource : after.resources[dim];
    const parts = [];
    if ((was ?? null) !== (now ?? null)) parts.push(`${rowTitle(dim, was)} → ${rowTitle(dim, now)}`);
    if (!sameTime(before.start, after.start) || !sameTime(before.end, after.end))
      parts.push(`${before.start ? fmtTime(ms(before.start), utc) : "no time"} → ${after.start ? fmtTime(ms(after.start), utc) : "no time"}`);
    return parts.join(" · ") || "unchanged";
  };
  const move = async (pk: string, change: Change, undoOf?: LogEntry): Promise<boolean> => {
    if (!canEdit || busy) return false;
    const cur = data.pucks.find((x) => x.id === pk);
    setBusy(true);
    setNote(null);
    try {
      const d = await scheduling.move(bid, { primary_key: pk, ...change, scenario_id: scenarioId });
      setRes({ scope, data: d });
      const p = d.pucks.find((x) => x.id === pk);
      const hard = (p?.violations ?? []).filter((v) => v.constraint === "HARD");
      setNote(
        hard.length
          ? { text: `${p?.title ?? pk} was saved and now breaks ${hard.map((v) => `${v.name} (${v.details})`).join(", ")}`, bad: true }
          : { text: `${p?.title ?? pk} ${undoOf ? "restored" : "saved"}${scenarioId ? " in the scenario" : ""}`, bad: false },
      );
      if (undoOf) writeLog(scope, (all) => all.map((x) => (x.id === undoOf.id ? { ...x, undone: true } : x)));
      else if (cur && p) {
        const dim = change.dimension ?? data.board.resource_property;
        record({ kind: "move", pk, title: p.title, dimension: dim, before: stateOf(cur), after: stateOf(p), text: describe(p, stateOf(cur), stateOf(p), dim) });
      }
      // the other widgets on this object type reload
      state.bump();
      return true;
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  /** Undo a move: only while the puck is still where that move put it (later moves are undone first). */
  const undo = async (e: LogEntry) => {
    const p = e.pk ? data.pucks.find((x) => x.id === e.pk) : undefined;
    if (!p || !e.before || !e.after || !e.dimension) {
      setNote({ text: "This change cannot be undone here", bad: true });
      return false;
    }
    if (!sameState(stateOf(p), e.after)) {
      setNote({ text: `${p.title} changed since: undo the later change first`, bad: true });
      return false;
    }
    const b = e.before;
    const res = e.dimension === data.board.resource_property ? b.resource : b.resources[e.dimension];
    return move(p.id, { resource: res ?? "", dimension: e.dimension, start: b.start, end: b.end, exact: true }, e);
  };
  const output = (pks: string[] | null) => {
    if (c.ds_search_variable) state.setVariable(c.ds_search_variable, state.variableTypes?.[c.ds_search_variable] === "string" ? (pks ?? []).join(",") : (pks ?? []));
    if (c.ds_search_filter_variable) state.setVariable(c.ds_search_filter_variable, pks ? pkFilter(pks) : NO_FILTER);
  };
  return {
    api: {
      data,
      utc,
      scenarioId,
      selected,
      pick,
      canEdit,
      whyReadOnly,
      busy,
      note,
      setNote,
      move: (pk, change) => move(pk, change),
      log,
      record,
      undo,
      clearLog: () => writeLog(scope, () => []),
      reload: () => state.bump(),
      output,
      setScenario: (id) => c.ds_scenario_variable && state.setVariable(c.ds_scenario_variable, id),
    },
  };
}

function colorFor(pucks: Puck[]) {
  const vals = [...new Set(pucks.map((p) => String(p.color ?? "")))];
  return (p: Puck) => p.style?.color ?? PALETTE[Math.max(0, vals.indexOf(String(p.color ?? ""))) % PALETTE.length];
}

const tooltip = (p: Puck, utc: boolean) => `${p.title}${p.style ? ` · ${p.style.name}` : ""}\n${span(p, utc)}${p.violations.map((v) => `\n${v.constraint}: ${v.name} (${v.details})`).join("")}`;

/** The rule marks of a puck, as on the Dynamic Scheduling page: "!" for a hard rule, a triangle for a soft one. */
function Marks({ p }: { p: Puck }) {
  const hard = p.violations.some((v) => v.constraint === "HARD");
  const soft = p.violations.some((v) => v.constraint === "SOFT");
  if (hard) return <span className="shrink-0 rounded-full bg-bad px-1 text-[9px] font-bold text-white">!</span>;
  if (soft) return <span className="shrink-0 text-[10px] text-warn">▲</span>;
  return null;
}

/** The search bar's matches: the pucks whose title, primary key or a property value holds the text (case ignored). */
function useSearch(pucks: Puck[]) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    return new Set(pucks.filter((p) => [p.title, p.id, ...Object.values(p.properties ?? {})].some((v) => v !== null && v !== undefined && typeof v !== "object" && String(v).toLowerCase().includes(s))).map((p) => p.id));
  }, [q, pucks]);
  return { q, setQ, hits };
}
type Search = ReturnType<typeof useSearch>;
/** A puck found by the search bar has a yellow border (as in Dynamic Scheduling). */
const HIT = "outline outline-2 outline-offset-1 outline-yellow-300";

/** The bar above the chart: counts, the search bar, the rule filter, the staging note and the result of the last move. */
function Toolbar({ api, only, setOnly, search, onEnter, children }: { api: BoardApi; only: boolean; setOnly: (v: boolean) => void; search: Search; onEnter?: (hits: string[]) => void; children?: React.ReactNode }) {
  const { data, note } = api;
  const breaking = data.pucks.filter((p) => p.violations.length).length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-2 py-1 text-[11px] text-muted">
      {children}
      <span className="flex items-center gap-1">
        <input
          value={search.q}
          onChange={(e) => search.setQ(e.target.value)}
          onKeyDown={(e) => {
            // Enter: the matches become the search results (the Gantt opens a search group; the calendar selects the
            // first match)
            if (e.key === "Enter" && search.hits?.size) {
              const hits = [...search.hits];
              if (onEnter) onEnter(hits);
              else {
                api.pick(hits[0]);
                api.output(hits);
              }
            }
            if (e.key === "Escape") search.setQ("");
          }}
          placeholder="Search pucks…"
          aria-label="Search pucks"
          className="w-32 rounded border border-line bg-ink px-1.5 py-0.5 text-[11px] text-white"
          data-ds-search
        />
        {search.hits && <span data-ds-hits={search.hits.size}>{search.hits.size} found</span>}
      </span>
      <span>
        {data.pucks.length} schedule objects · {data.unassigned.length} unscheduled · <span className={data.hard_violations ? "text-bad" : "text-ok"} data-ds-hard={data.hard_violations}>{data.hard_violations} hard violations</span>
      </span>
      <label className="flex items-center gap-1" title={data.board.rules.filter((r) => r.enabled).map((r) => `${r.constraint}: ${r.name}`).join("\n") || "The board has no enabled rule"}>
        <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Rule violations only ({breaking})
      </label>
      {api.scenarioId && <span className="text-warn">Staged in a scenario</span>}
      {!api.canEdit && <span>{api.whyReadOnly}</span>}
      {api.busy && <span>Saving…</span>}
      {note && <span className={`min-w-0 truncate ${note.bad ? "text-bad" : "text-ok"}`} title={note.text} data-ds-note>{note.text}</span>}
    </div>
  );
}

/** The selected puck: its time, rows and broken rules (as the page's side panel shows them), unassign and Object View. */
function Detail({ api }: { api: BoardApi }) {
  const { data, selected, utc } = api;
  const p = selected ? data.pucks.find((x) => x.id === selected) : undefined;
  if (!p) return null;
  const b = data.board;
  const dims = [b.resource_property, ...(b.extra_resources ?? []).map((x) => x.resource_property)];
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-2 py-1.5 text-[11px]" data-ds-selected={p.id}>
      <span className="font-medium text-white">{p.title}</span>
      <span className="text-muted">{span(p, utc)}</span>
      {dims.map((dim) => {
        const pk = dim === b.resource_property ? p.resource : p.resources?.[dim];
        const row = data.rows.find((r) => r.dimension === dim && r.primary_key === pk);
        return (
          <span key={dim} className="text-soft">
            {data.rows.find((r) => r.dimension === dim)?.section ?? dim}: {row?.title ?? "unassigned"}
          </span>
        );
      })}
      {p.fixed && <span className="text-muted">Fixed duration</span>}
      {p.violations.map((v, i) => (
        <span key={i} className={`rounded px-1.5 py-0.5 ${v.constraint === "HARD" ? "bg-bad/10 text-bad" : "bg-warn/10 text-warn"}`}>
          {v.name}: {v.details}
        </span>
      ))}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {api.canEdit && p.resource && (
          <button type="button" disabled={api.busy} onClick={() => api.move(p.id, { resource: "" })} className="text-muted hover:text-bad">
            Unassign
          </button>
        )}
        <a href={`/ontology/objects/${b.schedule_object_type_id}/${encodeURIComponent(p.id)}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">
          Object View
        </a>
        <button type="button" onClick={() => api.pick(undefined)} className="text-muted hover:text-white">
          Clear
        </button>
      </span>
    </div>
  );
}

/** The unscheduled pucks (no resource or no start). In the Gantt they can be dragged onto a row. */
function Unscheduled({ api, onDrag, hint, hits }: { api: BoardApi; onDrag?: (id: string | null) => void; hint: string; hits: Set<string> | null }) {
  const { data, selected } = api;
  if (!data.unassigned.length) return null;
  return (
    <div className="flex max-h-20 shrink-0 flex-wrap items-center gap-1.5 overflow-y-auto border-t border-line bg-panel px-2 py-1.5 text-[11px]" data-ds-unscheduled={data.unassigned.length}>
      <span className="text-muted" title={hint}>Unscheduled ({data.unassigned.length})</span>
      {data.unassigned.map((id) => {
        const p = data.pucks.find((x) => x.id === id);
        if (!p) return null;
        return (
          <button
            key={id}
            type="button"
            draggable={!!onDrag && api.canEdit}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", id);
              e.dataTransfer.effectAllowed = "move";
              onDrag?.(id);
            }}
            onDragEnd={() => onDrag?.(null)}
            onClick={() => api.pick(selected === id ? undefined : id)}
            title={tooltip(p, api.utc)}
            className={`flex max-w-56 items-center gap-1 rounded border px-2 py-0.5 text-left ${selected === id ? "border-ocean bg-ocean/15 text-white" : "border-line text-soft hover:bg-panel-2"} ${hits?.has(id) ? HIT : ""}`}
          >
            <Marks p={p} />
            <span className="truncate">{p.title}</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// the footer: change log and review changes (Dynamic Scheduling's bottom bar)
// ------------------------------------------------------------------------------------------------

/** The change log: the changes made on this board (in this scenario) in this browser session, newest first; undo a move. */
function ChangeLogPanel({ api, onClose }: { api: BoardApi; onClose: () => void }) {
  const { log, utc } = api;
  const undoable = log.filter((e) => e.kind === "move" && !e.undone);
  const undoAll = async () => {
    for (const e of [...undoable].reverse()) if (!(await api.undo(e))) break;
  };
  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-t border-line bg-panel px-2 py-1.5 text-[11px]" data-ds-change-log={log.length}>
      <div className="mb-1 flex items-center gap-3">
        <span className="font-semibold text-white">Change log</span>
        <span className="text-muted">{api.scenarioId ? "changes staged in this scenario" : "changes saved to the Nexus"} from these widgets in this browser session</span>
        <span className="ml-auto flex items-center gap-3">
          {api.canEdit && undoable.length > 0 && (
            <button type="button" disabled={api.busy} onClick={() => void undoAll()} className="text-soft hover:text-white" data-ds-undo-all>
              Undo all ({undoable.length})
            </button>
          )}
          {log.length > 0 && (
            <button type="button" onClick={api.clearLog} className="text-muted hover:text-white" title="Forget the log (the changes stay)">
              Clear log
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close the change log" className="text-muted hover:text-white">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {!log.length && <p className="text-muted">No changes yet.</p>}
      <ul className="space-y-0.5">
        {[...log].reverse().map((e) => (
          <li key={e.id} className={`flex items-center gap-2 ${e.undone ? "text-muted line-through" : "text-soft"}`} data-ds-log-entry={e.pk ?? e.kind}>
            <span className="w-28 shrink-0 text-muted">{fmtTime(e.at, utc)}</span>
            <span className="shrink-0 font-medium text-white">{e.title}</span>
            <span className="min-w-0 truncate" title={e.text}>{e.text}</span>
            {e.kind === "move" && !e.undone && api.canEdit && (
              <button type="button" disabled={api.busy} onClick={() => void api.undo(e)} className="ml-auto shrink-0 text-ocean hover:underline" data-ds-undo={e.pk}>
                Undo
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const shortVal = (v: unknown, utc: boolean) => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtTime(ms(v), utc);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

/** Review changes: every Ontology edit staged in the scenario and the rules still broken; Apply merges the scenario
 * through the board's submit (refused while a hard rule is broken), then a fresh scenario takes its place. */
function ReviewPanel({ api, onClose }: { api: BoardApi; onClose: () => void }) {
  const { data, scenarioId, utc } = api;
  const [detail, setDetail] = useState<{ sid: string; d?: ScenarioDetail; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!scenarioId) return;
    let stale = false;
    scenarios.get(scenarioId).then(
      (d) => !stale && setDetail({ sid: scenarioId, d }),
      (e: Error) => !stale && setDetail({ sid: scenarioId, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [scenarioId, tick, data]);
  if (!scenarioId) return null;
  const d = detail?.sid === scenarioId ? detail.d : undefined;
  const b = data.board;
  const shown = [b.resource_property, ...(b.extra_resources ?? []).map((x) => x.resource_property), b.start_property, b.end_property];
  const edits = d?.edits ?? [];
  const breaking = data.pucks.filter((p) => p.violations.length);
  const hard = breaking.filter((p) => p.violations.some((v) => v.constraint === "HARD")).length;
  const apply = async () => {
    setBusy(true);
    try {
      await scheduling.submit(b.id, scenarioId);
      const next = await scheduling.session(b.id);
      api.setNote({ text: `${edits.length} edits applied to the Nexus; new changes are staged in ${next.name}`, bad: false });
      api.setScenario(next.id);
      onClose();
      api.reload();
    } catch (e) {
      api.setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const discard = async (objectTypeId: string, pk: string) => {
    try {
      await scenarios.discard(scenarioId, { object_type_id: objectTypeId, primary_key: pk });
      setTick((t) => t + 1);
      api.reload();
    } catch (e) {
      api.setNote({ text: (e as Error).message, bad: true });
    }
  };
  return (
    <div className="max-h-60 shrink-0 overflow-y-auto border-t border-line bg-panel px-2 py-1.5 text-[11px]" data-ds-review={edits.length}>
      <div className="mb-1 flex items-center gap-3">
        <span className="font-semibold text-white">Review changes</span>
        <span className="text-muted">{d ? `${d.name}: ${edits.length} Ontology edits` : detail?.error ?? "Loading…"}</span>
        <span className={hard ? "text-bad" : "text-ok"}>{hard ? `${hard} schedule objects break a hard rule` : "No hard rule broken"}</span>
        <span className="ml-auto flex items-center gap-3">
          {api.canEdit && (
            <button type="button" disabled={busy || !edits.length || hard > 0} onClick={() => void apply()} title={hard ? "Fix the hard rule violations first" : "Merge the scenario into the Nexus"}
              className="rounded bg-ocean px-2 py-0.5 font-medium text-ink disabled:opacity-40" data-ds-apply>
              {busy ? "Applying…" : "Apply"}
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close the review" className="text-muted hover:text-white">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {d && !edits.length && <p className="text-muted">Nothing staged in this scenario yet.</p>}
      <ul className="space-y-0.5">
        {edits.map((e) => {
          const keys = e.op === "modify" ? shown.filter((k) => e.changed.includes(k)).concat(e.changed.filter((k) => !shown.includes(k))) : [];
          return (
            <li key={`${e.object_type_id}:${e.primary_key}`} className="flex items-center gap-2 text-soft" data-ds-edit={e.primary_key}>
              <span className={`shrink-0 rounded px-1 ${e.op === "create" ? "bg-ok/15 text-ok" : e.op === "delete" ? "bg-bad/15 text-bad" : "bg-ocean/15 text-ocean"}`}>{e.op}</span>
              <span className="shrink-0 font-medium text-white">{e.title}</span>
              <span className="min-w-0 truncate">
                {keys.map((k) => `${k}: ${shortVal(e.before?.[k], utc)} → ${shortVal(e.after?.[k], utc)}`).join(" · ")}
                {e.conflict ? ` · conflict: ${e.conflict}` : ""}
              </span>
              {api.canEdit && (
                <button type="button" onClick={() => void discard(e.object_type_id, e.primary_key)} className="ml-auto shrink-0 text-muted hover:text-bad">
                  Discard
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {breaking.length > 0 && (
        <div className="mt-1 text-muted">
          Rules still broken:{" "}
          {breaking.slice(0, 12).map((p) => (
            <span key={p.id} className={`mr-2 ${p.violations.some((v) => v.constraint === "HARD") ? "text-bad" : "text-warn"}`}>
              {p.title} ({p.violations.map((v) => v.name).join(", ")})
            </span>
          ))}
          {breaking.length > 12 ? `… ${breaking.length - 12} more` : ""}
        </div>
      )}
    </div>
  );
}

/** The bottom bar's buttons: change log and (with a scenario) review changes, and the panel that is open. */
function useFooter(api: BoardApi) {
  const [open, setOpen] = useState<"log" | "review" | null>(null);
  const active = api.log.filter((e) => !e.undone).length;
  const buttons = (
    <span className="ml-auto flex shrink-0 items-center gap-2">
      <button type="button" onClick={() => setOpen(open === "log" ? null : "log")} className={`rounded border border-line px-1.5 ${open === "log" ? "bg-ocean/20 text-white" : "text-soft hover:text-white"}`} data-ds-log-button={active}>
        Change log ({active})
      </button>
      {api.scenarioId && (
        <button type="button" onClick={() => setOpen(open === "review" ? null : "review")} className={`rounded border border-line px-1.5 ${open === "review" ? "bg-ocean/20 text-white" : "text-soft hover:text-white"}`} data-ds-review-button>
          Review changes
        </button>
      )}
    </span>
  );
  const panel = open === "log" ? <ChangeLogPanel api={api} onClose={() => setOpen(null)} /> : open === "review" && api.scenarioId ? <ReviewPanel api={api} onClose={() => setOpen(null)} /> : null;
  return { buttons, panel };
}

// ------------------------------------------------------------------------------------------------
// actions: drag to create, right-click menu items
// ------------------------------------------------------------------------------------------------

/** An action form to open: the object it runs on, values by property id, and for a row menu the row object and the
 * clicked time (Dynamic Scheduling's "Resource object" and "Selected start timestamp"). */
type Dialog = {
  actionId: string;
  object?: { typeId: string; pk: string };
  by: Record<string, unknown>;
  row?: { typeId: string; pk: string; time: string };
  label: string;
  log?: Omit<LogEntry, "id" | "at">;
};
/** A row menu's values: an object parameter of the row's type takes the row, the first timestamp parameter the time. */
function rowExtra(row: Dialog["row"]) {
  let timeUsed = false;
  return (p: ActionParam) => {
    if (!row) return undefined;
    if (p.type === "object" && p.object_type_id === row.typeId) return row.pk;
    if (p.type === "timestamp" && !timeUsed) {
      timeUsed = true;
      return row.time;
    }
    return undefined;
  };
}

/** The parameters of an action filled from the widget: by the property a parameter edits (or its id). */
function fill(action: ActionType, by: Record<string, unknown>, extra?: (p: ActionParam) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of action.parameters as unknown as ActionParam[]) {
    const k = p.property ?? p.id;
    const v = k in by ? by[k] : extra?.(p);
    if (v !== undefined && v !== null && v !== "") out[p.id] = v;
  }
  return out;
}

/** An action's form opened from the widget (the object and the widget's values filled in), applied in the scenario
 * when the widget stages its changes there. */
function ActionDialog({ dialog, api, onClose }: { dialog: Dialog; api: BoardApi; onClose: () => void }) {
  const [x, setX] = useState<{ action: ActionType; type: ObjectType; object?: OntologyObject } | { error: string } | null>(null);
  useEffect(() => {
    let stale = false;
    (async () => {
      const action = await ontology.actionType(dialog.actionId);
      const typeId = action.object_type_id || dialog.object?.typeId || api.data.board.schedule_object_type_id;
      const [type, object] = await Promise.all([
        ontology.objectType(typeId),
        dialog.object && dialog.object.typeId === typeId ? ontology.object(dialog.object.typeId, dialog.object.pk) : Promise.resolve(undefined),
      ]);
      if (!stale) setX({ action, type, object });
    })().catch((e: Error) => !stale && setX({ error: e.message }));
    return () => {
      stale = true;
    };
    // opened once per dialog
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);
  if (!x) return null;
  if ("error" in x) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="rounded border border-line bg-panel p-3 text-xs text-bad">{x.error}</div>
      </div>
    );
  }
  return (
    <ActionForm
      action={x.action}
      objectType={x.type}
      object={x.object}
      defaults={fill(x.action, dialog.by, rowExtra(dialog.row))}
      scenarioId={api.scenarioId}
      title={dialog.label}
      onClose={onClose}
      onDone={() => {
        // "Done" after the action ran
        if (dialog.log) api.record(dialog.log);
        api.reload();
        onClose();
      }}
    />
  );
}

/** Drag to create: the create action's form with the dragged start, end and row; or applied straight away when the
 * widget says so and the action accepts the values (else the form opens). */
async function createAt(api: BoardApi, c: WidgetConfig, from: number, to: number, row: Row | null, open: (d: Dialog) => void) {
  const id = c.ds_create_action_id;
  if (!id) return;
  const b = api.data.board;
  const by: Record<string, unknown> = { [b.start_property]: new Date(from).toISOString(), [b.end_property]: new Date(to).toISOString() };
  if (row) by[row.dimension] = row.primary_key;
  const where = `${row ? `${row.title}, ` : ""}${fmtTime(from, api.utc)} → ${fmtClock(to, api.utc)}`;
  try {
    const action = await ontology.actionType(id);
    const defaults = fill(action, by);
    const log = { kind: "create" as const, title: action.display_name, text: where };
    if (c.ds_create_immediately) {
      try {
        if (api.scenarioId) await scenarios.apply(api.scenarioId, id, defaults);
        else await actionsApi.apply(id, defaults);
        api.record(log);
        api.setNote({ text: `Created: ${where}${api.scenarioId ? " (in the scenario)" : ""}`, bad: false });
        api.reload();
        return;
      } catch (e) {
        api.setNote({ text: `${(e as Error).message}: fill in the form`, bad: true });
      }
    }
    open({ actionId: id, by, label: `${action.display_name}: ${where}`, log });
  } catch (e) {
    api.setNote({ text: (e as Error).message, bad: true });
  }
}

type MenuItem = { label: string; run: () => void; disabled?: boolean; hint?: string };
/** A right-click menu at the pointer; closes on a click elsewhere, Escape or scrolling. */
function ContextMenu({ at: pos, title, items, onClose }: { at: { x: number; y: number }; title: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);
  const left = Math.min(pos.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 230);
  const top = Math.min(pos.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 30 - items.length * 26);
  return (
    <div ref={ref} role="menu" className="fixed z-50 w-56 overflow-hidden rounded border border-line bg-panel py-1 text-[12px] shadow-xl" style={{ left, top }} data-ds-menu>
      <div className="truncate px-3 pb-1 text-[10px] uppercase tracking-wide text-muted">{title}</div>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          title={it.hint}
          onClick={() => {
            onClose();
            it.run();
          }}
          className="block w-full truncate px-3 py-1 text-left text-soft hover:bg-panel-2 hover:text-white disabled:opacity-40"
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** The menu items a builder configured: an action (its form, filled in) or Workshop events. */
function configuredItems(list: { label: string; action_id?: string; events?: WsEvent[] }[] | undefined, api: BoardApi, state: ModuleState, onAction: (actionId: string, label: string) => void, before?: () => void): MenuItem[] {
  return (list ?? [])
    .filter((m) => m.label && (m.action_id || m.events?.length))
    .map((m) => ({
      label: m.label,
      disabled: !!m.action_id && (!api.canEdit || !!state.readOnly),
      hint: m.action_id ? (api.canEdit ? "Opens the action's form" : api.whyReadOnly) : "Runs the Workshop events",
      run: () => {
        before?.();
        if (m.action_id) onAction(m.action_id, m.label);
        else void state.runEvents?.(m.events ?? []);
      },
    }));
}

// ------------------------------------------------------------------------------------------------
// Scheduling Gantt
// ------------------------------------------------------------------------------------------------

/** Scheduling Gantt — a scheduling board's resources as rows and its pucks as bars over the time window. */
export function SchedulingGanttWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const { message, bad, api } = useBoard(widget, state, editing, true);
  if (!api) return <div className={`p-3 text-xs ${bad ? "text-bad" : "text-muted"}`}>{message}</div>;
  return <GanttChart api={api} widget={widget} state={state} />;
}

/** The time window: the widget's dates (fixed or from date variables), else the board's timeline. */
function windowOf(c: WidgetConfig, vars: Record<string, unknown>, b: Board, utc: boolean): { t0: number; t1: number; warn?: string } {
  const board = { t0: ms(b.timeline_start), t1: ms(b.timeline_end) };
  const t0 = toMs(c.ds_start_variable ? vars[c.ds_start_variable] : c.ds_start, utc) ?? board.t0;
  const t1 = toMs(c.ds_end_variable ? vars[c.ds_end_variable] : c.ds_end, utc, true) ?? board.t1;
  if (t1 <= t0) return { ...board, warn: "The window's end is not after its start: the board's timeline is shown" };
  return { t0, t1 };
}

/** A search group (Dynamic Scheduling: a search creates one): its rows, highlighted slots and pucks, the puck it was
 * run for. */
type Group = { title: string; rows: string[]; slots: Record<string, Highlight[]>; pucks: Map<string, Highlight>; source?: string; error?: string | null; collapsed: boolean; overview: boolean };
type Menu = { x: number; y: number; title: string; items: MenuItem[] };

function GanttChart({ api, widget, state }: { api: BoardApi; widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const { data, utc, selected, canEdit } = api;
  const b = data.board;
  const { t0, t1, warn } = windowOf(c, state.variables, b, utc);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(360, el.clientWidth - LABEL_W - 14)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * width;
  /** The time under the pointer in a row's lane. */
  const timeAt = (clientX: number, lane: Element) => t0 + ((clientX - lane.getBoundingClientRect().left) / width) * (t1 - t0);
  // day columns (each with the pucks starting in it), and hour ticks while the window is short enough to read them
  const days = useMemo(() => {
    const out: { from: number; to: number; start: number; count: number }[] = [];
    for (let d = dayStart(t0, utc); d < t1 && out.length < 800; d = dayStart(d, utc, 1)) {
      const next = dayStart(d, utc, 1);
      out.push({ start: d, from: Math.max(d, t0), to: Math.min(next, t1), count: data.pucks.filter((p) => p.resource && p.start && ms(p.start) >= d && ms(p.start) < next).length });
    }
    return out;
  }, [t0, t1, utc, data.pucks]);
  const hours = useMemo(() => {
    if (t1 - t0 > 3 * 24 * HOUR) return [];
    const px = (width / (t1 - t0)) * HOUR;
    const step = [1, 2, 3, 4, 6, 12].find((n) => n * px >= 46);
    if (!step) return [];
    const out: number[] = [];
    for (let d = dayStart(t0, utc); d < t1; d = dayStart(d, utc, 1)) for (let h = step; h < 24; h += step) if (d + h * HOUR > t0 && d + h * HOUR < t1) out.push(d + h * HOUR);
    return out;
  }, [t0, t1, utc, width]);
  // the custom grid precision replaces the automatic hour lines (null: too many lines for the window)
  const grid = useMemo(() => (c.ds_grid ? gridTicks(t0, t1, c.ds_grid, utc, 1) : undefined), [c.ds_grid, t0, t1, utc]);
  const ticks = grid ?? hours;
  const labels = useMemo(() => {
    if (!grid || !c.ds_grid) return hours.map((t) => ({ t, label: fmtClock(t, utc) }));
    if (c.ds_grid === "1d") return [];
    const out: { t: number; label: string }[] = [];
    let last = -Infinity;
    for (const t of grid) {
      if (x(t) - last < 46) continue;
      last = x(t);
      out.push({ t, label: tickLabel(t, c.ds_grid, utc) });
    }
    return out;
    // x depends on t0, t1 and width
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, hours, c.ds_grid, utc, t0, t1, width]);
  const closed = useMemo(() => closedSpans(t0, t1, c.ds_operating, utc, b), [t0, t1, c.ds_operating, utc, b]);
  const color = useMemo(() => colorFor(data.pucks), [data.pucks]);
  const drag = useRef<{ id: string; row: string; sx: number; sy: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ id: string; row: string; dx: number; dy: number } | null>(null);
  const [only, setOnly] = useState(false);
  const search = useSearch(data.pucks);
  const dropping = useRef<string | null>(null);
  const footer = useFooter(api);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [rowSel, setRowSel] = useState<string | null>(null);
  // drag to create: Shift + drag on a row's empty space
  const creating = useRef<{ lane: string; row: Row; from: number } | null>(null);
  const [band, setBand] = useState<{ lane: string; a: number; b: number } | null>(null);
  const snapMs = Math.max(1, b.snap_minutes) * 60_000;
  const snapT = (t: number) => Math.round(t / snapMs) * snapMs;
  const canCreate = !!c.ds_create_action_id && canEdit;
  // the time-now line (red), refreshed every minute
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nowShown = now > t0 && now < t1;

  // suggestions for the selected puck (the board's suggest route): rated slots on every row
  const suggest = !!c.ds_suggestions && canEdit;
  const slotKey = suggest && selected ? `${b.id}|${selected}|${api.scenarioId ?? ""}|${state.version}` : "";
  const [slots, setSlots] = useState<{ key: string; slots: Record<string, Slot[]> } | null>(null);
  useEffect(() => {
    if (!slotKey) return;
    let stale = false;
    const [boardId, pk, scenario] = slotKey.split("|");
    scheduling.suggest(boardId, pk, scenario || undefined).then((r) => !stale && setSlots({ key: slotKey, slots: r.slots }), () => undefined);
    return () => {
      stale = true;
    };
  }, [slotKey]);
  const shown = slots && slots.key === slotKey ? slots.slots : null;

  const rows = data.rows;
  const sections = new Set(rows.map((r) => r.dimension)).size;
  const placed = data.pucks.filter((p) => p.start && p.end);
  const outside = placed.filter((p) => (p.resource || Object.values(p.resources ?? {}).some(Boolean)) && (ms(p.end!) <= t0 || ms(p.start!) >= t1)).length;
  const title = (pk: string) => data.pucks.find((p) => p.id === pk)?.title ?? pk;
  const rowOf = (key: string | null | undefined) => rows.find((r) => r.key === key);

  // ---- search groups and the search results output
  const [group, setGroup] = useState<Group | null>(null);
  const openGroup = (g: Omit<Group, "collapsed" | "overview">) => {
    setGroup({ ...g, collapsed: false, overview: false });
    api.output([...g.pucks.keys()]);
  };
  const closeGroup = () => {
    setGroup(null);
    api.output(null);
  };
  const fromResult = (r: SearchResult) => {
    const g = r.rowGroup;
    if (!g) return api.setNote({ text: r.error ?? "The search found nothing", bad: true });
    const slotsBy: Record<string, Highlight[]> = {};
    const pucks = new Map<string, Highlight>();
    for (const h of g.highlights) {
      if (h.type === "PUCK" && h.schedulableObjectPrimaryKey) pucks.set(h.schedulableObjectPrimaryKey, h);
      else if (h.type === "SLOT" && h.containerId && h.domain) (slotsBy[h.containerId] ??= []).push(h);
    }
    openGroup({ title: g.title, rows: g.containerIds.filter((k) => rowOf(k)), slots: slotsBy, pucks, source: r.sourcePuckIds[0], error: r.error });
    if (r.error) api.setNote({ text: r.error, bad: true });
  };
  const runSearch = (body: { kind: "row" | "puck"; row?: string; time?: string; primary_key?: string }) =>
    scheduling.recommend(b.id, { ...body, scenario_id: api.scenarioId, function_id: c.ds_search_function_id }).then(fromResult, (e: Error) => api.setNote({ text: e.message, bad: true }));
  /** The search bar's Enter: a search group of the rows holding a match. */
  const searchGroup = (hits: string[]) => {
    const set = new Set(hits);
    const keys = rows.filter((r) => placed.some((p) => set.has(p.id) && onRow(p, r, b.resource_property))).map((r) => r.key);
    openGroup({ title: `Search "${search.q.trim()}"`, rows: keys, slots: {}, pucks: new Map(hits.map((h) => [h, { type: "PUCK", schedulableObjectPrimaryKey: h, comment: "matches the search" } as Highlight])) });
  };
  const highlighted = useMemo(() => {
    if (!group?.pucks.size) return search.hits;
    return new Set([...(search.hits ?? []), ...group.pucks.keys()]);
  }, [search.hits, group]);
  /** Place a puck from a search result (a slot for the source puck, or a puck where the row search proposes it). */
  const place = (pk: string | undefined, h: Highlight) => {
    const r = rowOf(h.containerId);
    if (!pk || !r || !h.domain || !canEdit) return;
    void api.move(pk, { resource: r.primary_key, dimension: r.dimension, start: new Date(h.domain.start).toISOString(), end: new Date(h.domain.end).toISOString() });
  };

  // ---- rows: selection and menus
  const selectRow = (r: Row) => {
    const next = rowSel === r.key ? null : r.key;
    setRowSel(next);
    const pk = next ? r.primary_key : null;
    if (c.ds_row_variable) state.setVariable(c.ds_row_variable, state.variableTypes?.[c.ds_row_variable] === "string" ? (pk ?? "") : pk ? [pk] : []);
    if (next) void state.runEvents?.(c.ds_row_events ?? []);
  };
  const objectView = (typeId: string, pk: string) => window.open(`/ontology/objects/${typeId}/${encodeURIComponent(pk)}`, "_blank", "noopener");
  const puckMenu = (p: Puck, e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: selected === p.id ? "Clear the selection" : "Select", run: () => api.pick(selected === p.id ? undefined : p.id) },
      { label: "Find slots for this schedule object", run: () => void runSearch({ kind: "puck", primary_key: p.id }), hint: c.ds_search_function_id ? "Runs the widget's search function" : "The free slots on every row that break no hard rule" },
    ];
    if (p.resource) items.push({ label: "Unassign", disabled: !canEdit || api.busy, hint: canEdit ? undefined : api.whyReadOnly, run: () => void api.move(p.id, { resource: "" }) });
    items.push({ label: "Open the Object View", run: () => objectView(b.schedule_object_type_id, p.id) });
    items.push(
      ...configuredItems(c.ds_puck_menu, api, state, (actionId, label) =>
        setDialog({
          actionId,
          label: `${label}: ${p.title}`,
          object: { typeId: b.schedule_object_type_id, pk: p.id },
          by: { [b.resource_property]: p.resource, ...(p.resources ?? {}), [b.start_property]: p.start, [b.end_property]: p.end },
          log: { kind: "action", pk: p.id, title: p.title, text: label },
        }),
      () => api.pick(p.id)),
    );
    setMenu({ x: e.clientX, y: e.clientY, title: p.title, items });
  };
  const rowMenu = (r: Row, t: number, e: React.MouseEvent) => {
    const time = new Date(snapT(t)).toISOString();
    const items: MenuItem[] = [];
    if (c.ds_create_action_id)
      items.push({
        label: "Create here",
        disabled: !canEdit,
        hint: canEdit ? `${c.ds_create_minutes ?? 60} minutes from ${fmtTime(snapT(t), utc)}` : api.whyReadOnly,
        run: () => void createAt(api, c, snapT(t), snapT(t) + (c.ds_create_minutes ?? 60) * 60_000, r, setDialog),
      });
    items.push({ label: "Find schedule objects for this time", run: () => void runSearch({ kind: "row", row: r.key, time }), hint: c.ds_search_function_id ? "Runs the widget's search function" : "The schedule objects that could go here without breaking a hard rule" });
    if (selected && canEdit) items.push({ label: `Place ${title(selected)} here`, disabled: api.busy, run: () => void api.move(selected, { resource: r.primary_key, dimension: r.dimension, start: time }) });
    items.push({ label: rowSel === r.key ? "Clear the row selection" : "Select the row", run: () => selectRow(r) });
    items.push({ label: "Open the Object View", run: () => objectView(r.object_type_id, r.primary_key) });
    items.push(
      ...configuredItems(c.ds_row_menu, api, state, (actionId, label) =>
        setDialog({
          actionId,
          label: `${label}: ${r.title}`,
          object: { typeId: r.object_type_id, pk: r.primary_key },
          by: { [r.dimension]: r.primary_key },
          row: { typeId: r.object_type_id, pk: r.primary_key, time },
          log: { kind: "action", title: r.title, text: `${label} at ${fmtTime(snapT(t), utc)}` },
        }),
      () => rowSel !== r.key && selectRow(r)),
    );
    setMenu({ x: e.clientX, y: e.clientY, title: `${r.title} · ${fmtTime(snapT(t), utc)}`, items });
  };

  /** The row of this chart under a point (section headers sit between rows). */
  const rowAt = (cx: number, cy: number) => {
    const el = document.elementsFromPoint(cx, cy).find((e) => e instanceof HTMLElement && e.dataset.dsRow !== undefined && host.current?.contains(e)) as HTMLElement | undefined;
    return el ? rows[Number(el.dataset.dsRow)] : undefined;
  };
  const span2 = (a: number, z: number) => ({ left: x(Math.max(t0, a)), width: Math.max(2, x(Math.min(t1, z)) - x(Math.max(t0, a))) });

  /** One row: its header (click selects the row) and its lane (pucks, slots, shading; drops, Shift + drag, menus). */
  const lane = (r: Row, ri: number, inGroup: boolean) => {
    const laneKey = `${inGroup ? "g:" : ""}${r.key}`;
    const groupSlots = inGroup ? (group?.slots[r.key] ?? []) : [];
    return (
      <div key={laneKey} data-ds-row={ri} data-ds-lane={laneKey} className="flex border-b border-line" style={{ height: ROW_H }}>
        <button
          type="button"
          onClick={() => selectRow(r)}
          style={{ width: LABEL_W }}
          className={`flex shrink-0 flex-col justify-center px-2 text-left text-xs ${rowSel === r.key ? "bg-ocean/15" : "hover:bg-panel-2"}`}
          title={`${r.title}${rowSel === r.key ? " (selected)" : ""}`}
          data-ds-row-header={r.key}
        >
          <span className="w-full truncate font-medium">{r.title}</span>
          <span className="w-full truncate text-[10px] text-muted">
            {[...b.row_properties.map((k) => String(r.properties[k] ?? "")), `${data.metrics.row_utilization[r.key] ?? 0}%`].filter(Boolean).join(" · ")}
          </span>
        </button>
        <div
          className="relative overflow-hidden"
          style={{ width }}
          onDragOver={(e) => {
            if (!dropping.current || !canEdit) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            // an unscheduled puck dropped on the row: it keeps its duration, or takes two hours when it has none
            const id = dropping.current;
            dropping.current = null;
            const p = id ? data.pucks.find((q) => q.id === id) : undefined;
            if (!p || !canEdit) return;
            e.preventDefault();
            const t = timeAt(e.clientX, e.currentTarget);
            void api.move(p.id, { resource: r.primary_key, dimension: r.dimension, start: new Date(t).toISOString(), end: p.start && p.end ? undefined : new Date(t + 2 * HOUR).toISOString() });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.shiftKey || (e.target as HTMLElement).closest("[data-ds-puck],[data-ds-slot]")) return;
            if (!canCreate) {
              if (c.ds_create_action_id) api.setNote({ text: api.whyReadOnly || "Read-only", bad: true });
              return;
            }
            e.preventDefault();
            const t = timeAt(e.clientX, e.currentTarget);
            creating.current = { lane: laneKey, row: r, from: t };
            capture(e);
            setBand({ lane: laneKey, a: t, b: t });
          }}
          onPointerMove={(e) => {
            const k = creating.current;
            if (!k || k.lane !== laneKey) return;
            setBand({ lane: laneKey, a: k.from, b: timeAt(e.clientX, e.currentTarget) });
          }}
          onPointerUp={(e) => {
            const k = creating.current;
            if (!k || k.lane !== laneKey) return;
            creating.current = null;
            setBand(null);
            let from = snapT(Math.min(k.from, timeAt(e.clientX, e.currentTarget)));
            let to = snapT(Math.max(k.from, timeAt(e.clientX, e.currentTarget)));
            if (to - from < snapMs) {
              from = snapT(k.from);
              to = from + (c.ds_create_minutes ?? 60) * 60_000;
            }
            void createAt(api, c, from, to, r, setDialog);
          }}
          onPointerCancel={() => {
            creating.current = null;
            setBand(null);
          }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest("[data-ds-puck]")) return;
            e.preventDefault();
            rowMenu(r, timeAt(e.clientX, e.currentTarget), e);
          }}
        >
          {closed.map(([a, z]) => (
            <div key={a} className="pointer-events-none absolute top-0 h-full" style={{ ...span2(a, z), background: CLOSED_BG }} data-ds-closed />
          ))}
          {days.map((d) => (x(d.to) - x(d.from) >= 6 ? <div key={d.start} className="pointer-events-none absolute top-0 h-full border-l border-line/60" style={{ left: x(d.from) }} /> : null))}
          {ticks.map((h) => (
            <div key={h} className={`pointer-events-none absolute top-0 h-full border-l ${grid ? "border-line/40" : "border-line/25"}`} style={{ left: x(h) }} data-ds-grid={grid ? "" : undefined} />
          ))}
          {nowShown && <div className="pointer-events-none absolute top-0 z-10 h-full border-l-2 border-red-500" style={{ left: x(now) }} title="Now" data-ds-now />}
          {(shown?.[r.key] ?? [])
            .filter((s) => ms(s.end) > t0 && ms(s.start) < t1)
            .map((s, i) => (
              <button
                key={i}
                type="button"
                data-ds-slot
                title={s.breaks.length ? `Breaks: ${s.breaks.join(", ")}` : "Fits every rule: click to place the selected puck here"}
                onClick={() => selected && s.rating > -1 && void api.move(selected, { resource: r.primary_key, dimension: r.dimension, start: s.start })}
                className="absolute top-1 h-[calc(100%-8px)] rounded-sm"
                style={{
                  ...span2(ms(s.start), ms(s.end)),
                  background: s.rating >= 1 ? "rgba(52,211,153,0.18)" : s.rating > -1 ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.08)",
                }}
              />
            ))}
          {groupSlots
            .filter((h) => h.domain && h.domain.end > t0 && h.domain.start < t1)
            .map((h, i) => (
              <button
                key={`s${i}`}
                type="button"
                data-ds-slot
                data-ds-result-slot={r.key}
                title={`${h.comment ?? "Search result"}${group?.source && canEdit ? `: click to place ${title(group.source)} here` : ""}`}
                onClick={() => place(group?.source, h)}
                className="absolute top-0.5 z-[2] h-[calc(100%-4px)] rounded-sm border-2 border-yellow-300 bg-yellow-300/15"
                style={span2(h.domain!.start, h.domain!.end)}
              />
            ))}
          {band?.lane === laneKey && (
            <div className="pointer-events-none absolute top-1 z-20 h-[calc(100%-8px)] rounded border-2 border-dashed border-ocean bg-ocean/20" style={span2(Math.min(band.a, band.b), Math.max(band.a, band.b))} data-ds-create-band />
          )}
          {placed
            .filter((p) => onRow(p, r, b.resource_property) && ms(p.end!) > t0 && ms(p.start!) < t1)
            .map((p) => {
              const g = ghost?.id === p.id && ghost.row === laneKey ? ghost : null;
              const left = x(Math.max(t0, ms(p.start!)));
              return (
                <div
                  key={p.id}
                  data-ds-puck={p.id}
                  title={`${tooltip(p, utc)}${group?.pucks.get(p.id)?.comment ? `\nSearch: ${group.pucks.get(p.id)!.comment}` : ""}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    drag.current = { id: p.id, row: laneKey, sx: e.clientX, sy: e.clientY, moved: false };
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d || d.id !== p.id || d.row !== laneKey || !canEdit) return;
                    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
                    if (d.moved) setGhost({ id: p.id, row: laneKey, dx: e.clientX - d.sx, dy: e.clientY - d.sy });
                  }}
                  onPointerUp={(e) => {
                    const d = drag.current;
                    drag.current = null;
                    setGhost(null);
                    if (!d) return;
                    if (!d.moved) return api.pick(p.id === selected ? undefined : p.id);
                    const dt = ((e.clientX - d.sx) / width) * (t1 - t0);
                    // a drop onto a row of another section assigns that section's row; the save handler snaps the time
                    const target = rowAt(e.clientX, e.clientY) ?? r;
                    void api.move(p.id, { resource: target.primary_key, dimension: target.dimension, start: new Date(ms(p.start!) + dt).toISOString() });
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                    setGhost(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    puckMenu(p, e);
                  }}
                  className={`absolute z-[3] flex h-[calc(100%-8px)] select-none items-center gap-1 overflow-hidden rounded px-1.5 text-[11px] text-ink shadow ${canEdit ? "cursor-grab" : "cursor-pointer"} ${selected === p.id ? "ring-2 ring-white" : ""} ${highlighted?.has(p.id) ? HIT : ""}`}
                  style={{
                    left: left + (g?.dx ?? 0),
                    top: 4 + (g?.dy ?? 0),
                    width: Math.max(8, x(Math.min(t1, ms(p.end!))) - left),
                    background: color(p),
                    opacity: g ? 0.8 : only && !p.violations.length ? 0.2 : 1,
                    zIndex: g ? 20 : undefined,
                  }}
                >
                  <Marks p={p} />
                  <span className="truncate font-medium">{p.title}</span>
                </div>
              );
            })}
        </div>
      </div>
    );
  };

  const results = group ? [...group.pucks.values(), ...Object.values(group.slots).flat()] : [];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink" data-scheduling-gantt={b.id}>
      <Toolbar api={api} only={only} setOnly={setOnly} search={search} onEnter={searchGroup}>
        <Icon name="clock" className="h-3.5 w-3.5 shrink-0 text-ocean" />
        <span className="truncate text-soft">{b.name}</span>
      </Toolbar>
      {(warn || outside > 0 || grid === null) && (
        <div className="shrink-0 border-b border-line bg-panel px-2 py-0.5 text-[11px] text-warn">
          {[warn, outside > 0 ? `${outside} scheduled outside this window` : "", grid === null ? "Too many grid lines at that precision for this window: the automatic grid is shown" : ""].filter(Boolean).join(" · ")}
        </div>
      )}
      <div ref={host} className="min-h-0 flex-1 overflow-auto">
        <div style={{ width: LABEL_W + width + 14 }}>
          <div className="sticky top-0 z-10 flex border-b border-line bg-panel text-[11px]">
            <div style={{ width: LABEL_W }} className="shrink-0 px-2 py-1.5 text-muted">
              Resource · utilization
            </div>
            <div className={`relative ${labels.length ? "h-14" : "h-10"}`} style={{ width }}>
              {days.map((d) => {
                const w = x(d.to) - x(d.from);
                return (
                  <div key={d.start} className="absolute top-0 h-full overflow-hidden whitespace-nowrap border-l border-line px-1" style={{ left: x(d.from), width: w }}>
                    {w >= 22 && (
                      <div className="font-medium">
                        {new Date(d.start).toLocaleDateString(undefined, w >= 84 ? { weekday: "short", day: "numeric", month: "short", timeZone: zone(utc) } : { day: "numeric", timeZone: zone(utc) })}
                      </div>
                    )}
                    {w >= 84 && <div className="text-muted">{d.count} scheduled</div>}
                  </div>
                );
              })}
              {labels.map((h) => (
                <div key={h.t} className="absolute bottom-0 whitespace-nowrap border-l border-line/60 pl-0.5 text-[10px] leading-4 text-muted" style={{ left: x(h.t) }} data-ds-tick>
                  {h.label}
                </div>
              ))}
            </div>
          </div>
          {group && (
            <div className="border-b-2 border-yellow-300/60" data-ds-group={group.title}>
              <div className="flex items-center gap-2 bg-yellow-300/10 px-2 py-1 text-[11px]">
                <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-yellow-300" />
                <span className="truncate font-semibold text-white">{group.title}</span>
                <span className="text-muted" data-ds-group-count={results.length}>
                  {results.length} results · {group.rows.length} rows
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-3">
                  <button type="button" onClick={() => setGroup({ ...group, overview: !group.overview })} className="text-soft hover:text-white" data-ds-overview-button>
                    Results overview
                  </button>
                  <button type="button" onClick={() => setGroup({ ...group, collapsed: !group.collapsed })} aria-label={group.collapsed ? "Expand the search group" : "Collapse the search group"} className="text-soft hover:text-white">
                    {group.collapsed ? "˅" : "˄"}
                  </button>
                  <button type="button" onClick={closeGroup} aria-label="Close the search group" className="text-muted hover:text-white">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
              {group.overview && (
                <ul className="max-h-40 space-y-0.5 overflow-y-auto border-t border-line bg-panel px-2 py-1 text-[11px]" data-ds-overview>
                  {!results.length && <li className="text-muted">{group.error ?? "No results"}</li>}
                  {results.map((h, i) => {
                    const r = rowOf(h.containerId);
                    const pk = h.type === "PUCK" ? h.schedulableObjectPrimaryKey : group.source;
                    const canPlace = canEdit && !!pk && !!r && !!h.domain;
                    return (
                      <li key={i} className="flex items-center gap-2 text-soft">
                        <span className="w-10 shrink-0 text-[10px] text-muted">{h.type === "PUCK" ? "Puck" : "Slot"}</span>
                        {h.type === "PUCK" && (
                          <button type="button" onClick={() => api.pick(h.schedulableObjectPrimaryKey)} className="shrink-0 font-medium text-white hover:underline">
                            {title(h.schedulableObjectPrimaryKey!)}
                          </button>
                        )}
                        {r && h.domain && <span className="shrink-0">{r.title} · {fmtTime(h.domain.start, utc)} → {fmtClock(h.domain.end, utc)}</span>}
                        <span className="min-w-0 truncate text-muted">{h.comment}</span>
                        {canPlace && (
                          <button type="button" disabled={api.busy} onClick={() => place(pk, h)} className="ml-auto shrink-0 text-ocean hover:underline" data-ds-place={pk}>
                            Place {h.type === "SLOT" ? title(pk!) : "here"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {!group.collapsed &&
                group.rows.map((k) => {
                  const ri = rows.findIndex((r) => r.key === k);
                  return ri >= 0 ? lane(rows[ri], ri, true) : null;
                })}
            </div>
          )}
          {rows.map((r, ri) => (
            <div key={r.key}>
              {sections > 1 && (ri === 0 || rows[ri - 1].dimension !== r.dimension) && (
                <div className="border-b border-line bg-panel-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{r.section}</div>
              )}
              {lane(r, ri, false)}
            </div>
          ))}
          {!rows.length && <p className="p-3 text-xs text-muted">This board has no resource objects.</p>}
        </div>
      </div>
      <Detail api={api} />
      {c.ds_show_unscheduled !== false && (
        <Unscheduled api={api} hits={highlighted} onDrag={(id) => (dropping.current = id)} hint={canEdit ? "Drag one onto a row to schedule it there" : "Schedule objects without a resource or a start"} />
      )}
      <div className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-2 py-1 text-[10px] text-muted">
        <span className="truncate">
          Right-click a puck or a row for its menu{canCreate ? " · Shift + drag on a row to create" : ""}
          {c.ds_operating ? " · shaded: outside operating hours" : ""}
        </span>
        {footer.buttons}
      </div>
      {footer.panel}
      {menu && <ContextMenu at={menu} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && <ActionDialog dialog={dialog} api={api} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Scheduling Calendar
// ------------------------------------------------------------------------------------------------

/** Scheduling Calendar — a scheduling board's pucks in a month or a week grid. */
export function SchedulingCalendarWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const { message, bad, api } = useBoard(widget, state, editing, false);
  if (!api) return <div className={`p-3 text-xs ${bad ? "text-bad" : "text-muted"}`}>{message}</div>;
  return <CalendarGrid api={api} widget={widget} state={state} />;
}

type Segment = { p: Puck; from: number; to: number; lane: number };

/** A day's pucks side by side: each in the first lane free at its start. */
function lanes(items: { p: Puck; from: number; to: number }[]): { segments: Segment[]; count: number } {
  const ends: number[] = [];
  const segments = [...items]
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((s) => {
      let lane = ends.findIndex((e) => e <= s.from);
      if (lane < 0) lane = ends.length;
      ends[lane] = s.to;
      return { ...s, lane };
    });
  return { segments, count: Math.max(1, ends.length) };
}

function CalendarGrid({ api, widget, state }: { api: BoardApi; widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const { data, utc, selected, canEdit } = api;
  const b = data.board;
  // the date first shown: the widget's start (fixed or from a date variable), else the start of the board's timeline
  const anchor = toMs(c.ds_start_variable ? state.variables[c.ds_start_variable] : c.ds_start, utc) ?? ms(b.timeline_start);
  const [nav, setNav] = useState<{ anchor: number; t: number } | null>(null);
  const cursor = nav && nav.anchor === anchor ? nav.t : anchor;
  const go = (t: number) => setNav({ anchor, t });
  const [view, setView] = useState<"month" | "week" | "day">(c.ds_view ?? "month");
  const [only, setOnly] = useState(false);
  const search = useSearch(data.pucks);
  const [today] = useState(() => Date.now());
  const weekStart = c.ds_week_start ?? 1;
  const h0 = Math.min(23, Math.max(0, c.ds_start_hour ?? 0));
  const h1 = Math.min(24, Math.max(h0 + 1, c.ds_end_hour ?? 24));
  const color = useMemo(() => colorFor(data.pucks), [data.pucks]);
  const dragging = useRef<{ id: string; grab: number } | null>(null);
  const footer = useFooter(api);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // drag to create (week and day views): Shift + drag down a day column
  const creating = useRef<{ day: number; from: number } | null>(null);
  const [band, setBand] = useState<{ day: number; a: number; b: number } | null>(null);
  const canCreate = !!c.ds_create_action_id && canEdit;
  const snapMin = Math.max(1, b.snap_minutes);
  /** Hours of the day under the pointer in a day column, snapped to the board's interval. */
  const hourAt = (clientY: number, el: Element) => Math.max(h0, Math.min(h1, Math.round(((h0 + (clientY - el.getBoundingClientRect().top) / HOUR_H) * 60) / snapMin) * snapMin / 60));
  const puckMenu = (p: Puck, e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [{ label: selected === p.id ? "Clear the selection" : "Select", run: () => api.pick(selected === p.id ? undefined : p.id) }];
    if (p.resource) items.push({ label: "Unassign", disabled: !canEdit || api.busy, hint: canEdit ? undefined : api.whyReadOnly, run: () => void api.move(p.id, { resource: "" }) });
    items.push({ label: "Open the Object View", run: () => window.open(`/ontology/objects/${b.schedule_object_type_id}/${encodeURIComponent(p.id)}`, "_blank", "noopener") });
    items.push(
      ...configuredItems(c.ds_puck_menu, api, state, (actionId, label) =>
        setDialog({
          actionId,
          label: `${label}: ${p.title}`,
          object: { typeId: b.schedule_object_type_id, pk: p.id },
          by: { [b.resource_property]: p.resource, ...(p.resources ?? {}), [b.start_property]: p.start, [b.end_property]: p.end },
          log: { kind: "action", pk: p.id, title: p.title, text: label },
        }),
      () => api.pick(p.id)),
    );
    setMenu({ x: e.clientX, y: e.clientY, title: p.title, items });
  };
  const timed = useMemo(
    () => data.pucks.filter((p) => p.start).map((p) => ({ p, from: ms(p.start!), to: p.end ? Math.max(ms(p.end), ms(p.start!) + 1) : ms(p.start!) + HOUR })),
    [data.pucks],
  );
  const w = wall(cursor, utc);
  const first = view === "month" ? at(w.y, w.m, 1, utc) : at(w.y, w.m, w.d, utc);
  const back = view === "day" ? 0 : (wall(first, utc).dow - weekStart + 7) % 7;
  const gridStart = dayStart(first, utc, -back);
  const count = view === "day" ? 1 : view === "week" ? 7 : Math.ceil((back + wall(at(w.y, w.m + 1, 0, utc), utc).d) / 7) * 7;
  const cells = Array.from({ length: count }, (_, i) => {
    const from = dayStart(gridStart, utc, i);
    return { from, to: dayStart(gridStart, utc, i + 1), w: wall(from, utc) };
  });
  const title =
    view === "month"
      ? new Date(at(w.y, w.m, 15, utc)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: zone(utc) })
      : view === "day"
        ? new Date(cells[0].from).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: zone(utc) })
        : `${new Date(cells[0].from).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: zone(utc) })} – ${new Date(cells[6].from).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: zone(utc) })}`;
  const step = (dir: number) => go(view === "month" ? at(w.y, w.m + dir, 1, utc) : at(w.y, w.m, w.d + (view === "day" ? 1 : 7) * dir, utc));
  const dragProps = (p: Puck) => ({
    draggable: canEdit,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      e.dataTransfer.setData("text/plain", p.id);
      e.dataTransfer.effectAllowed = "move";
      dragging.current = { id: p.id, grab: e.clientY - e.currentTarget.getBoundingClientRect().top };
    },
    onDragEnd: () => (dragging.current = null),
  });
  const over = (e: React.DragEvent<HTMLElement>) => {
    if (!dragging.current || !canEdit) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  /** A puck dropped on a day: the save handler runs with the new start (the duration is kept, the time snaps). */
  const drop = (e: React.DragEvent<HTMLElement>, day: Wall, hours?: number) => {
    const d = dragging.current;
    dragging.current = null;
    const p = d ? data.pucks.find((q) => q.id === d.id) : undefined;
    if (!p?.start || !canEdit) return;
    e.preventDefault();
    const start = at(day.y, day.m, day.d, utc, hours ?? wall(ms(p.start), utc).hours);
    if (start !== ms(p.start)) void api.move(p.id, { start: new Date(start).toISOString() });
  };
  const names = cells.slice(0, 7).map((x) => new Date(x.from).toLocaleDateString(undefined, { weekday: "short", timeZone: zone(utc) }));
  const isToday = (x: { from: number; to: number }) => today >= x.from && today < x.to;
  const chip = (p: Puck, from: number) => (
    <button
      key={p.id}
      type="button"
      data-ds-puck={p.id}
      {...dragProps(p)}
      onClick={() => api.pick(p.id === selected ? undefined : p.id)}
      onContextMenu={(e) => puckMenu(p, e)}
      title={tooltip(p, utc)}
      className={`flex w-full items-center gap-1 overflow-hidden rounded px-1 py-0.5 text-left text-[10px] text-ink ${selected === p.id ? "ring-2 ring-white" : ""} ${p.resource ? "" : "border border-dashed border-ink/60"} ${search.hits?.has(p.id) ? HIT : ""}`}
      style={{ background: color(p), opacity: only && !p.violations.length ? 0.2 : 1 }}
    >
      <Marks p={p} />
      <span className="shrink-0">{ms(p.start!) >= from ? fmtClock(ms(p.start!), utc) : "…"}</span>
      <span className="truncate font-medium">{p.title}</span>
    </button>
  );
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink" data-scheduling-calendar={b.id}>
      <Toolbar api={api} only={only} setOnly={setOnly} search={search}>
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => step(-1)} className="rounded border border-line px-1.5 text-soft hover:text-white" aria-label="Earlier">‹</button>
          <button type="button" onClick={() => step(1)} className="rounded border border-line px-1.5 text-soft hover:text-white" aria-label="Later">›</button>
          <button type="button" onClick={() => go(today)} className="rounded border border-line px-1.5 text-soft hover:text-white">Today</button>
          <button type="button" onClick={() => setNav(null)} className="rounded border border-line px-1.5 text-soft hover:text-white" title="Back to the date the widget starts on">Start</button>
        </span>
        <span className="font-medium text-white" data-ds-title>{title}</span>
        <span className="flex shrink-0 overflow-hidden rounded border border-line">
          {(["month", "week", "day"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`px-2 capitalize ${view === v ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}>
              {v}
            </button>
          ))}
        </span>
      </Toolbar>
      {view === "month" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 grid grid-cols-7 border-b border-line bg-panel text-center text-[11px] text-muted">
            {names.map((n, i) => <div key={i} className="py-1">{n}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell) => {
              const here = timed.filter((s) => s.from < cell.to && s.to > cell.from).sort((x, y) => x.from - y.from);
              return (
                <div key={cell.from} data-ds-day={`${cell.w.y}-${cell.w.m + 1}-${cell.w.d}`} onDragOver={over} onDrop={(e) => drop(e, cell.w)}
                  className={`min-h-20 space-y-0.5 border-b border-r border-line p-1 ${cell.w.m === w.m ? "" : "bg-panel/40"}`}>
                  <div className={`text-[11px] ${isToday(cell) ? "font-bold text-ocean" : cell.w.m === w.m ? "text-soft" : "text-muted"}`}>{cell.w.d}</div>
                  {here.map((s) => chip(s.p, cell.from))}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 flex border-b border-line bg-panel text-center text-[11px] text-muted">
            <div className="w-11 shrink-0" />
            {cells.map((cell, i) => (
              <div key={cell.from} className={`min-w-0 flex-1 border-l border-line py-1 ${isToday(cell) ? "font-bold text-ocean" : ""}`}>
                {names[i]} {cell.w.d}
              </div>
            ))}
          </div>
          <div className="flex">
            <div className="w-11 shrink-0">
              {Array.from({ length: h1 - h0 }, (_, i) => (
                <div key={i} className="pr-1 text-right text-[10px] text-muted" style={{ height: HOUR_H }}>
                  {String(h0 + i).padStart(2, "0")}:00
                </div>
              ))}
            </div>
            {cells.map((cell) => {
              // each puck's part of this day, in hours of the day, cut to the hours shown
              const day = lanes(
                timed
                  .filter((s) => s.from < cell.to && s.to > cell.from)
                  .map((s) => ({ p: s.p, from: Math.max(h0, (Math.max(s.from, cell.from) - cell.from) / HOUR), to: Math.min(h1, (Math.min(s.to, cell.to) - cell.from) / HOUR) }))
                  .filter((s) => s.to > s.from),
              );
              return (
                <div
                  key={cell.from}
                  data-ds-day={`${cell.w.y}-${cell.w.m + 1}-${cell.w.d}`}
                  className="relative min-w-0 flex-1 border-l border-line"
                  style={{ height: (h1 - h0) * HOUR_H }}
                  onDragOver={over}
                  onDrop={(e) => {
                    const y = e.clientY - e.currentTarget.getBoundingClientRect().top - (dragging.current?.grab ?? 0);
                    const snap = Math.max(1, b.snap_minutes);
                    drop(e, cell.w, Math.max(0, Math.round(((h0 + y / HOUR_H) * 60) / snap) * snap) / 60);
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !e.shiftKey || (e.target as HTMLElement).closest("[data-ds-puck]")) return;
                    if (!canCreate) {
                      if (c.ds_create_action_id) api.setNote({ text: api.whyReadOnly || "Read-only", bad: true });
                      return;
                    }
                    e.preventDefault();
                    const h = hourAt(e.clientY, e.currentTarget);
                    creating.current = { day: cell.from, from: h };
                    capture(e);
                    setBand({ day: cell.from, a: h, b: h });
                  }}
                  onPointerMove={(e) => {
                    const k = creating.current;
                    if (k?.day === cell.from) setBand({ day: cell.from, a: k.from, b: hourAt(e.clientY, e.currentTarget) });
                  }}
                  onPointerUp={(e) => {
                    const k = creating.current;
                    if (k?.day !== cell.from) return;
                    creating.current = null;
                    setBand(null);
                    const h = hourAt(e.clientY, e.currentTarget);
                    const a = Math.min(k.from, h);
                    let z = Math.max(k.from, h);
                    if (z - a < snapMin / 60) z = a + (c.ds_create_minutes ?? 60) / 60;
                    void createAt(api, c, at(cell.w.y, cell.w.m, cell.w.d, utc, a), at(cell.w.y, cell.w.m, cell.w.d, utc, z), null, setDialog);
                  }}
                  onPointerCancel={() => {
                    creating.current = null;
                    setBand(null);
                  }}
                >
                  {Array.from({ length: h1 - h0 }, (_, i) => (
                    <div key={i} className="border-b border-line/40" style={{ height: HOUR_H }} />
                  ))}
                  {closedSpans(cell.from, cell.to, c.ds_operating, utc, b).map(([a, z]) => {
                    const top = Math.max(h0, (a - cell.from) / HOUR);
                    const bottom = Math.min(h1, (z - cell.from) / HOUR);
                    return bottom > top ? (
                      <div key={a} className="pointer-events-none absolute inset-x-0" style={{ top: (top - h0) * HOUR_H, height: (bottom - top) * HOUR_H, background: CLOSED_BG }} data-ds-closed />
                    ) : null;
                  })}
                  {band?.day === cell.from && (
                    <div
                      className="pointer-events-none absolute inset-x-0.5 z-20 rounded border-2 border-dashed border-ocean bg-ocean/20"
                      style={{ top: (Math.min(band.a, band.b) - h0) * HOUR_H, height: Math.max(4, Math.abs(band.b - band.a) * HOUR_H) }}
                      data-ds-create-band
                    />
                  )}
                  {day.segments.map((s) => (
                    <button
                      key={s.p.id}
                      type="button"
                      data-ds-puck={s.p.id}
                      {...dragProps(s.p)}
                      onClick={() => api.pick(s.p.id === selected ? undefined : s.p.id)}
                      onContextMenu={(e) => puckMenu(s.p, e)}
                      title={tooltip(s.p, utc)}
                      className={`absolute flex items-start gap-1 overflow-hidden rounded px-1 text-left text-[10px] leading-4 text-ink shadow ${selected === s.p.id ? "ring-2 ring-white" : ""} ${s.p.resource ? "" : "border border-dashed border-ink/60"} ${search.hits?.has(s.p.id) ? HIT : ""}`}
                      style={{
                        top: (s.from - h0) * HOUR_H,
                        height: Math.max(16, (s.to - s.from) * HOUR_H - 1),
                        left: `calc(${(s.lane / day.count) * 100}% + 1px)`,
                        width: `calc(${100 / day.count}% - 2px)`,
                        background: color(s.p),
                        opacity: only && !s.p.violations.length ? 0.2 : 1,
                      }}
                    >
                      <Marks p={s.p} />
                      <span className="truncate font-medium">{s.p.title}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Detail api={api} />
      {c.ds_show_unscheduled !== false && <Unscheduled api={api} hits={search.hits} hint="Schedule objects without a resource or a start (those with a start are also in the grid, dashed)" />}
      <div className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-2 py-1 text-[10px] text-muted">
        <span className="truncate">
          Right-click a puck for its menu{canCreate ? " · Shift + drag in the week or day view to create" : ""}
          {c.ds_operating ? " · shaded: outside operating hours" : ""}
        </span>
        {footer.buttons}
      </div>
      {footer.panel}
      {menu && <ContextMenu at={menu} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && <ActionDialog dialog={dialog} api={api} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

const SCHEDULING_TYPES = new Set(["scheduling_gantt", "scheduling_calendar"]);
const DATE_TYPES: Variable["type"][] = ["date", "timestamp", "string"];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Operating hours: shade non-operating time (daily hours, hours on chosen weekdays, explicit ranges, or the board's
 * working-hours rule). */
function OperatingConfig({ c, set, board }: { c: WidgetConfig; set: (x: Partial<WidgetConfig>) => void; board?: Board }) {
  const op = c.ds_operating;
  const put = (x: Partial<Operating>) => set({ ds_operating: { ...(op ?? { kind: "daily" }), ...x } });
  const rule = board?.rules.find((r) => r.enabled && r.kind === "within_hours");
  return (
    <div className="space-y-2" data-ds-operating-config>
      <Field label="Operating hours" hint="Non-operating time is shaded. Hours count in the time zone the times are shown in (the board's rule: UTC).">
        <select value={op?.kind ?? ""} onChange={(e) => set({ ds_operating: e.target.value ? { ...(op ?? {}), kind: e.target.value as Operating["kind"] } : undefined })} className={inputClass}>
          <option value="">None</option>
          <option value="daily">Daily hours</option>
          <option value="weekdays">Hours on chosen weekdays</option>
          <option value="ranges">Custom time ranges</option>
          <option value="rule" disabled={!!board && !rule}>The board&apos;s working-hours rule{rule ? ` (${rule.start_hour}:00–${rule.end_hour}:00 UTC)` : board ? " (none)" : ""}</option>
        </select>
      </Field>
      {(op?.kind === "daily" || op?.kind === "weekdays") && (
        <div className="flex items-center gap-1">
          <input type="number" min={0} max={23} value={op.start_hour ?? 8} onChange={(e) => put({ start_hour: Math.max(0, Math.min(23, Math.floor(Number(e.target.value) || 0))) })} className={inputClass} aria-label="Opens at hour" />
          <span className="text-muted">to</span>
          <input type="number" min={1} max={24} value={op.end_hour ?? 17} onChange={(e) => put({ end_hour: Math.max(1, Math.min(24, Math.floor(Number(e.target.value) || 24))) })} className={inputClass} aria-label="Closes at hour" />
        </div>
      )}
      {op?.kind === "weekdays" && (
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d, i) => {
            const days = op.days ?? [1, 2, 3, 4, 5];
            return (
              <label key={d} className="flex items-center gap-1">
                <input type="checkbox" checked={days.includes(i)} onChange={(e) => put({ days: e.target.checked ? [...days, i].sort() : days.filter((x) => x !== i) })} /> {d}
              </label>
            );
          })}
        </div>
      )}
      {op?.kind === "ranges" && (
        <div className="space-y-1">
          {(op.ranges ?? []).map((r, i) => (
            <div key={i} className="flex items-center gap-1">
              <input type="datetime-local" value={r.start} onChange={(e) => put({ ranges: (op.ranges ?? []).map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} className={inputClass} aria-label="Range start" />
              <input type="datetime-local" value={r.end} onChange={(e) => put({ ranges: (op.ranges ?? []).map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} className={inputClass} aria-label="Range end" />
              <button type="button" onClick={() => put({ ranges: (op.ranges ?? []).filter((_, j) => j !== i) })} aria-label="Remove the range" className="text-muted hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => put({ ranges: [...(op.ranges ?? []), { start: "", end: "" }] })} className="text-ocean hover:underline">
            + Operating range
          </button>
        </div>
      )}
    </div>
  );
}

type MenuEntry = NonNullable<WidgetConfig["ds_puck_menu"]>[number];
/** Right-click menu items: a label and either an action or Workshop events. */
function MenuConfig({ label, hint, items, onChange, actions, mod }: { label: string; hint: string; items?: MenuEntry[]; onChange: (v: MenuEntry[] | undefined) => void; actions: ActionType[]; mod: Module }) {
  const list = items ?? [];
  const put = (i: number, x: Partial<MenuEntry>) => onChange(list.map((m, j) => (j === i ? { ...m, ...x } : m)));
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-2" data-ds-menu-config={label}>
        {list.map((m, i) => (
          <div key={i} className="space-y-1 rounded border border-line p-1.5">
            <div className="flex items-center gap-1">
              <input value={m.label} onChange={(e) => put(i, { label: e.target.value })} placeholder="Menu label" className={inputClass} aria-label="Menu label" />
              <select value={m.events ? "events" : "action"} onChange={(e) => put(i, e.target.value === "events" ? { action_id: undefined, events: [] } : { events: undefined })} className={inputClass} aria-label="Menu item kind">
                <option value="action">Action</option>
                <option value="events">Workshop events</option>
              </select>
              <button type="button" onClick={() => onChange(list.length > 1 ? list.filter((_, j) => j !== i) : undefined)} aria-label="Remove the menu item" className="text-muted hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            {m.events ? (
              <EventsEditor events={m.events} mod={mod} onChange={(ev) => put(i, { events: ev })} label="Runs" />
            ) : (
              <select value={m.action_id ?? ""} onChange={(e) => put(i, { action_id: e.target.value || undefined })} className={inputClass} aria-label="Menu action">
                <option value="">Choose an action…</option>
                {actions.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
                {m.action_id && !actions.some((a) => a.id === m.action_id) && <option value={m.action_id}>{m.action_id}</option>}
              </select>
            )}
          </div>
        ))}
        <button type="button" onClick={() => onChange([...list, { label: "", action_id: undefined }])} className="text-ocean hover:underline">
          + Menu item
        </button>
      </div>
    </Field>
  );
}

export function SchedulingWidgetConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const t = widget.type;
  const on = SCHEDULING_TYPES.has(t);
  const vars = mod.variables ?? [];
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [allActions, setAllActions] = useState<ActionType[]>([]);
  const [fns, setFns] = useState<FunctionRow[]>([]);
  useEffect(() => {
    if (!on) return;
    scheduling.boards().then(setBoards, () => setBoards([]));
    ontology.actionTypes().then(setAllActions, () => setAllActions([]));
    functionsApi.list().then(setFns, () => setFns([]));
  }, [on]);
  if (!on) return null;
  const gantt = t === "scheduling_gantt";
  const board = (boards ?? []).find((x) => x.id === c.ds_board_id);
  const varSel = (value: string | undefined, onChange: (v: string | undefined) => void, kinds: Variable["type"][], none = "None") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{none}</option>
      {vars.filter((v) => kinds.includes(v.type)).map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type.replace(/_/g, " ")})</option>)}
    </select>
  );
  const date = (which: "start" | "end", label: string, hint: string) => {
    const variable = which === "start" ? c.ds_start_variable : c.ds_end_variable;
    const fixed = which === "start" ? c.ds_start : c.ds_end;
    return (
      <Field label={label} hint={hint}>
        <div className="flex gap-1">
          {varSel(variable, (v) => set(which === "start" ? { ds_start_variable: v } : { ds_end_variable: v }), DATE_TYPES, "A fixed date")}
          {!variable && (
            <input type="date" value={fixed ?? ""} onChange={(e) => set(which === "start" ? { ds_start: e.target.value || undefined } : { ds_end: e.target.value || undefined })} className={inputClass} aria-label={label} />
          )}
        </div>
      </Field>
    );
  };
  const editable = c.ds_editable ?? gantt;
  return (
    <div className="space-y-3 text-xs" data-scheduling-config>
      <Field label="Scheduling board" hint={board ? `Timeline ${board.timeline_start.slice(0, 10)} to ${board.timeline_end.slice(0, 10)} · ${board.rules.filter((r) => r.enabled).length} rules · saves snap to ${board.snap_minutes} min` : "Boards are made in Dynamic Scheduling."}>
        <select value={c.ds_board_id ?? ""} onChange={(e) => set({ ds_board_id: e.target.value || undefined })} className={inputClass} data-ds-board>
          <option value="">Choose…</option>
          {(boards ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          {c.ds_board_id && boards && !board && <option value={c.ds_board_id}>{c.ds_board_id} (not found)</option>}
        </select>
      </Field>
      <div className="font-semibold uppercase tracking-wide text-muted">{gantt ? "Time window" : "Display"}</div>
      {date("start", gantt ? "Start" : "Date shown first", gantt ? "Empty: the start of the board's timeline." : "Empty: the start of the board's timeline. The calendar moves there whenever the variable changes.")}
      {gantt && date("end", "End", "Empty: the end of the board's timeline. A date (not a timestamp) includes that day.")}
      {!gantt && (
        <>
          <Field label="View shown first">
            <select value={c.ds_view ?? "month"} onChange={(e) => set({ ds_view: e.target.value === "week" || e.target.value === "day" ? e.target.value : undefined })} className={inputClass}>
              <option value="month">Month</option>
              <option value="week">Week</option>
              <option value="day">Day</option>
            </select>
          </Field>
          <Field label="Starting day of week">
            <select value={String(c.ds_week_start ?? 1)} onChange={(e) => set({ ds_week_start: e.target.value === "0" ? 0 : undefined })} className={inputClass}>
              <option value="1">Monday</option>
              <option value="0">Sunday</option>
            </select>
          </Field>
          <Field label="Week and day views: starting and ending hour">
            <div className="flex gap-1">
              <input type="number" min={0} max={23} value={c.ds_start_hour ?? 0} onChange={(e) => set({ ds_start_hour: Number(e.target.value) > 0 ? Math.min(23, Math.floor(Number(e.target.value))) : undefined })} className={inputClass} aria-label="Starting hour" />
              <input type="number" min={1} max={24} value={c.ds_end_hour ?? 24} onChange={(e) => set({ ds_end_hour: Number(e.target.value) > 0 && Number(e.target.value) < 24 ? Math.floor(Number(e.target.value)) : undefined })} className={inputClass} aria-label="Ending hour" />
            </div>
          </Field>
        </>
      )}
      <Field label="Times shown in" hint="The board's working-hours rule and its daily limits count in UTC.">
        <select value={c.ds_timezone ?? "local"} onChange={(e) => set({ ds_timezone: e.target.value === "utc" ? "utc" : undefined })} className={inputClass}>
          <option value="local">The viewer&apos;s time zone (as Dynamic Scheduling)</option>
          <option value="utc">UTC</option>
        </select>
      </Field>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={c.ds_show_unscheduled !== false} onChange={(e) => set({ ds_show_unscheduled: e.target.checked ? undefined : false })} /> List the unscheduled schedule objects
      </label>
      {gantt && (
        <Field label="Timeline grid precision" hint="The unit of the grid lines (automatic: days, and hours while the window is short).">
          <select value={c.ds_grid ?? ""} onChange={(e) => set({ ds_grid: (e.target.value || undefined) as WidgetConfig["ds_grid"] })} className={inputClass} data-ds-grid-config>
            <option value="">Automatic</option>
            {GRID_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        </Field>
      )}
      <OperatingConfig c={c} set={set} board={board} />
      <div className="font-semibold uppercase tracking-wide text-muted">Editing</div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={editable} onChange={(e) => set({ ds_editable: e.target.checked === gantt ? undefined : e.target.checked })} />
        {gantt ? "Drag pucks in time and between rows (runs the board's save handler)" : "Dynamic mode: drag pucks to another day or time (runs the board's save handler)"}
      </label>
      {editable && (
        <>
          <Field label="Scenario (a variable holding a scenario id)" hint="Set: changes are staged in that scenario and the board is shown as it is there. None: every move is saved to the Nexus directly.">
            {varSel(c.ds_scenario_variable, (v) => set({ ds_scenario_variable: v }), ["scenario", "string"])}
          </Field>
          {gantt && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!c.ds_suggestions} onChange={(e) => set({ ds_suggestions: e.target.checked || undefined })} /> Suggest slots for the selected puck (green fits every rule; click to place)
            </label>
          )}
          <Field label="Drag to create: create action" hint={`${gantt ? "Shift + drag on a row's empty space" : "Shift + drag in the week or day view"} opens the action's form with the start, end${gantt ? " and row" : ""} filled in (parameters editing the board's ${board ? `${board.start_property}, ${board.end_property}${gantt ? ` and ${board.resource_property}` : ""}` : "start, end and resource"} properties).`}>
            <select value={c.ds_create_action_id ?? ""} onChange={(e) => set({ ds_create_action_id: e.target.value || undefined })} className={inputClass} data-ds-create-config>
              <option value="">None</option>
              {allActions.filter((a) => !board || a.object_type_id === board.schedule_object_type_id).map((a) => <option key={a.id} value={a.id}>{a.display_name}{a.kind ? ` (${a.kind})` : ""}</option>)}
              {c.ds_create_action_id && !allActions.some((a) => a.id === c.ds_create_action_id) && <option value={c.ds_create_action_id}>{c.ds_create_action_id}</option>}
            </select>
          </Field>
          {c.ds_create_action_id && (
            <>
              <Field label="Length of a click or a right-click Create here (minutes)">
                <input type="number" min={1} value={c.ds_create_minutes ?? 60} onChange={(e) => set({ ds_create_minutes: Number(e.target.value) > 0 && Number(e.target.value) !== 60 ? Math.floor(Number(e.target.value)) : undefined })} className={inputClass} />
              </Field>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!c.ds_create_immediately} onChange={(e) => set({ ds_create_immediately: e.target.checked || undefined })} /> Hide the form and apply immediately if valid
              </label>
            </>
          )}
          <p className="text-muted">The save handler does not refuse a move that breaks a rule: the puck is saved and marked, as in Dynamic Scheduling. A read-only module never moves pucks.</p>
        </>
      )}
      {!editable && (
        <Field label="Scenario (a variable holding a scenario id)" hint="Set: the board is shown as it is in that scenario.">
          {varSel(c.ds_scenario_variable, (v) => set({ ds_scenario_variable: v }), ["scenario", "string"])}
        </Field>
      )}
      <div className="font-semibold uppercase tracking-wide text-muted">Output</div>
      <Field label="Selected schedule object (an object set, array or string variable)" hint="The selected puck is also the module's selected object of the schedule object type.">
        {varSel(c.ds_selected_variable, (v) => set({ ds_selected_variable: v }), ["object_set", "array", "string"])}
      </Field>
      <Field label="Selected schedule object (an object set filter variable)" hint="Data widgets apply it under Object set filter variables applied. Nothing selected: no filter.">
        {varSel(c.ds_selected_filter_variable, (v) => set({ ds_selected_filter_variable: v }), ["object_set_filter"])}
      </Field>
      <EventsEditor events={c.ds_events ?? []} mod={mod} onChange={(ev) => set({ ds_events: ev.length ? ev : undefined })} label="On selection change" />
      <Field label="Search results (an object set, array or string variable)" hint={gantt ? "The schedule objects of the latest search: the search bar on Enter, or a right-click search returning pucks." : "The schedule objects the search bar matched when Enter was pressed."}>
        {varSel(c.ds_search_variable, (v) => set({ ds_search_variable: v }), ["object_set", "array", "string"])}
      </Field>
      <Field label="Search results (an object set filter variable)" hint="No search: no filter.">
        {varSel(c.ds_search_filter_variable, (v) => set({ ds_search_filter_variable: v }), ["object_set_filter"])}
      </Field>
      {gantt && (
        <>
          <Field label="Selected row (a string, array or object set variable)" hint="Clicking a row header selects it (its resource's primary key).">
            {varSel(c.ds_row_variable, (v) => set({ ds_row_variable: v }), ["string", "array", "object_set"])}
          </Field>
          <EventsEditor events={c.ds_row_events ?? []} mod={mod} onChange={(ev) => set({ ds_row_events: ev.length ? ev : undefined })} label="On row select" />
        </>
      )}
      <div className="font-semibold uppercase tracking-wide text-muted">Right-click menus</div>
      <MenuConfig label="Puck menu" items={c.ds_puck_menu} onChange={(v) => set({ ds_puck_menu: v })} actions={allActions.filter((a) => !board || a.object_type_id === board.schedule_object_type_id)} mod={mod}
        hint={`Built in: select, unassign, Object View${gantt ? ", find slots (the search function)" : ""}. An action opens its form on the puck, its start, end and resource filled in.`} />
      {gantt && (
        <>
          <MenuConfig label="Row menu" items={c.ds_row_menu} onChange={(v) => set({ ds_row_menu: v })} actions={allActions} mod={mod}
            hint="Built in: create here, find schedule objects for the time (the search function), place the selected puck, select the row, Object View. An action gets the row object and the clicked time (its first timestamp parameter)." />
          <Field label="Search function" hint="Called with {rowId, selectedTime} from a row or {puck} from a puck; returns an ISearchResult {rowGroup: {title, containerIds, highlights}, sourcePuckIds, error}. None: the built-in search (the rules decide).">
            <select value={c.ds_search_function_id ?? ""} onChange={(e) => set({ ds_search_function_id: e.target.value || undefined })} className={inputClass}>
              <option value="">Built in</option>
              {fns.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              {c.ds_search_function_id && !fns.some((f) => f.id === c.ds_search_function_id) && <option value={c.ds_search_function_id}>{c.ds_search_function_id}</option>}
            </select>
          </Field>
        </>
      )}
    </div>
  );
}
