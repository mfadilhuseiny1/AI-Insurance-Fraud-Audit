"use client";

/** More Slate widgets: Segmented control, Date range picker, Calendar, Image gallery, Tree, Graph, Map, the Gantt / Heat
 *  grid / Tree map charts, the Resource selector and Time series. Each renders its resolved properties and reports the
 *  user's state and events to the runtime, like the widgets in SlateWidgets.tsx. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MapCanvas, type Basemap, type MapHandle } from "@/components/map/MapCanvas";
import { VectorTileLayer, type VectorTileStyle } from "@/components/map/VectorTileLayer";
import type { VectorColorBy } from "@/components/map/vectorTileStyle";
import { TsChart, type ChartSeries } from "@/components/timeseries/TsChart";
import { api, type DriveItem } from "@/lib/api";
import type { SlateWidget } from "@/lib/slate";
import type { SlateRuntime } from "@/lib/slateRuntime";
import { timeseries } from "@/lib/timeseries";
import {
  allDayBounds, atMinutes, calendarSettings, cameraViewBox, clipSegment, dayKey, dayRange, daySegment, DAY_MINUTES, fitBox, inDayRange, isTimed, labelsHidden, layoutDay, overlapsDay, parseWall,
  resolveCamera, scrollHour, slotAt, timeRange, toWall, unitsPerPixel, weekStart, zoomCamera, type Camera,
} from "./slateGeometry";

type P = Record<string, unknown>;
type Set = (patch: P, event?: string, value?: unknown) => void;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v]);
const s = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});
const Empty = ({ text }: { text: string }) => <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">{text}</div>;
const field = "rounded border border-line-2 bg-ink px-2 py-1 text-sm outline-none focus:border-ocean";
const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444", "#84cc16"];

/** A color on a linear gradient through `colors` at t in [0, 1]. */
export function scaleColor(colors: string[], t: number): string {
  const cs = colors.length >= 2 ? colors : ["#B9D7EA", "#1F6B9A"];
  const rgb = (c: string) => {
    if (typeof document === "undefined") return [128, 128, 128];
    const el = document.createElement("canvas").getContext("2d")!;
    el.fillStyle = c;
    const h = el.fillStyle as string;
    return /^#/.test(h) ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : (h.match(/[\d.]+/g) ?? ["128", "128", "128"]).slice(0, 3).map(Number);
  };
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (cs.length - 1);
  const i = Math.min(cs.length - 2, Math.floor(x));
  const [a, b] = [rgb(cs[i]), rgb(cs[i + 1])];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * (x - i))).join(",")})`;
}

/** A date in a moment-like display format (YYYY MM DD HH hh mm ss a). */
export function formatDate(iso: unknown, format: string): string {
  const d = new Date(s(iso));
  if (!s(iso) || Number.isNaN(d.getTime())) return "";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()), MM: p(d.getMonth() + 1), DD: p(d.getDate()), HH: p(d.getHours()), hh: p(d.getHours() % 12 || 12), mm: p(d.getMinutes()),
    sss: p(d.getMilliseconds(), 3), ss: p(d.getSeconds()), a: d.getHours() < 12 ? "am" : "pm",
  };
  return format.replace(/YYYY|MM|DD|HH|hh|mm|sss|ss|a/g, (t) => map[t]);
}

export function MoreWidgetBody({ w, p, rt, set }: { w: SlateWidget; p: P; rt: SlateRuntime; set: Set }): React.ReactNode | undefined {
  switch (w.type) {
    case "segmented":
      return <Segmented p={p} set={set} />;
    case "daterange":
      return <DateRange p={p} set={set} />;
    case "calendar":
      return <Calendar p={p} set={set} />;
    case "gallery":
      return <Gallery p={p} set={set} />;
    case "tree":
      return <Tree p={p} set={set} />;
    case "graph":
      return <Graph w={w} p={p} rt={rt} set={set} />;
    case "map":
      return <SlateMap p={p} set={set} />;
    case "gantt":
      return <Gantt p={p} set={set} />;
    case "heatgrid":
      return <HeatGrid p={p} set={set} />;
    case "treemap":
      return <TreeMap p={p} set={set} />;
    case "resourceselector":
      return <ResourceSelector w={w} p={p} rt={rt} set={set} />;
    case "timeseries":
      return <TimeSeries p={p} />;
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------------------------------------
// controls and time
// ------------------------------------------------------------------------------------------------

function Segmented({ p, set }: { p: P; set: Set }) {
  const values = arr(p.values);
  const shown = arr(p.displayValues);
  const sel = arr(p.selectedValues).map((x) => JSON.stringify(x));
  const touched = useRef(false);
  const first = values.length ? JSON.stringify(values[0]) : null;
  useEffect(() => {
    // the first value starts selected (until the user chooses)
    if (p.preselectFirstElement && !touched.current && !sel.length && first !== null) set({ selectedValues: [JSON.parse(first)] }, "changed", [JSON.parse(first)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.preselectFirstElement, first]);
  const pick = (v: unknown) => {
    const k = JSON.stringify(v);
    const on = sel.includes(k);
    let next: string[];
    if (p.multiselectEnabled) next = on ? sel.filter((x) => x !== k) : [...sel, k];
    else next = on ? [] : [k];
    // a required selection keeps its last value
    if (p.selectionRequired && !next.length && touched.current) return;
    touched.current = true;
    const out = next.map((x) => JSON.parse(x));
    set({ selectedValues: out }, "changed", out);
  };
  return (
    <div className="flex h-full items-center" data-segmented>
      <div className="inline-flex overflow-hidden rounded-md border border-line-2">
        {values.map((v, i) => {
          const on = sel.includes(JSON.stringify(v));
          return (
            <button
              key={i}
              type="button"
              disabled={!!p.disabled}
              title={p.tooltipsEnabled ? s(p.tooltipText).replace(/<[^>]+>/g, "") || s(shown[i] ?? v) : undefined}
              onMouseEnter={() => p.tooltipsEnabled && set({ hover: { displayValue: s(shown[i] ?? v), index: i, value: v } })}
              onClick={() => pick(v)}
              className={`border-r border-line-2 px-3 py-1 text-sm last:border-r-0 disabled:opacity-50 ${on ? "bg-ocean text-white" : "bg-ink text-soft hover:bg-panel-2"}`}
              data-segment={i}
              aria-pressed={on}
            >
              {s(shown[i] ?? v)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DateRange({ p, set }: { p: P; set: Set }) {
  const time = !!p.timeEnabled;
  const cut = time ? 16 : 10;
  const local = (iso: unknown) => {
    const d = new Date(s(iso));
    if (!s(iso) || Number.isNaN(d.getTime())) return "";
    // the input shows local time
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, cut);
  };
  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  const change = (from: string | null, to: string | null) => set({ fromDateValue: from, toDateValue: to }, "changed", { fromDateValue: from, toDateValue: to });
  const year = new Date().getFullYear();
  const min = local(p.minDate) || `${year - 20}-01-01${time ? "T00:00" : ""}`;
  const max = local(p.maxDate) || `${year}-12-31${time ? "T23:59" : ""}`;
  const fmt = s(p.displayFormat) || "YYYY-MM-DD";
  const labels = arr(p.shortcutLabels);
  const ranges = arr(p.shortcutRanges);
  const defaults: [string, number][] = [["Last 3 days", 3], ["Last week", 7], ["Last month", 30], ["Last 3 months", 90]];
  const type = time ? "datetime-local" : "date";
  return (
    <div className="flex h-full flex-col justify-center gap-1" data-daterange>
      <div className="flex items-center gap-1">
        <input type={type} disabled={!!p.disabled} value={local(p.fromDateValue)} min={min} max={local(p.toDateValue) || max} onChange={(e) => change(iso(e.target.value), (p.toDateValue as string) ?? null)} className={`${field} min-w-0 flex-1`} data-range-from />
        <span className="text-muted">→</span>
        <input type={type} disabled={!!p.disabled} value={local(p.toDateValue)} min={local(p.fromDateValue) || min} max={max} onChange={(e) => change((p.fromDateValue as string) ?? null, iso(e.target.value))} className={`${field} min-w-0 flex-1`} data-range-to />
      </div>
      {(!!p.fromDateValue || !!p.toDateValue) && (
        <div className="truncate text-[11px] text-muted" data-range-text>
          {formatDate(p.fromDateValue, fmt) || "…"} – {formatDate(p.toDateValue, fmt) || "…"}
        </div>
      )}
      {!!p.shortcutsEnabled && (
        <div className="flex flex-wrap gap-1">
          {ranges.length
            ? ranges.map((r, i) => (
                <button key={i} type="button" disabled={!!p.disabled} onClick={() => change(new Date(s(arr(r)[0])).toISOString(), new Date(s(arr(r)[1])).toISOString())} className="rounded border border-line-2 px-1.5 py-0.5 text-[11px] text-soft hover:border-ocean" data-range-shortcut={i}>
                  {s(labels[i]) || `${s(arr(r)[0])} – ${s(arr(r)[1])}`}
                </button>
              ))
            : defaults.map(([l, days], i) => (
                <button key={l} type="button" disabled={!!p.disabled} onClick={() => change(new Date(Date.now() - days * 86400000).toISOString(), new Date().toISOString())} className="rounded border border-line-2 px-1.5 py-0.5 text-[11px] text-soft hover:border-ocean" data-range-shortcut={i}>
                  {l}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}

type CalEvent = { i: number; name: string; start: Date; end: Date; allDay: boolean; series: string };
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function Calendar({ p, set }: { p: P; set: Set }) {
  const [view, setView] = useState<"day" | "week" | "month">(() => (["day", "week", "month"].includes(s(p.viewDefault).toLowerCase()) ? (s(p.viewDefault).toLowerCase() as "month") : "month"));
  // hour range, snap, first weekday and zone (local / UTC); every Date below is wall clock in that zone
  const cfg = calendarSettings(p);
  const nowWall = () => toWall(new Date(), cfg.utc);
  const [anchor, setAnchor] = useState<Date>(() => (s(p.defaultDate) && !Number.isNaN(parseWall(p.defaultDate, cfg.utc).getTime()) ? parseWall(p.defaultDate, cfg.utc) : nowWall()));
  const [picking, setPicking] = useState<{ a: Date; b: Date } | null>(null);
  const pickRef = useRef<{ a: Date; b: Date } | null>(null);
  const names = arr(p.eventNames);
  const starts = arr(p.eventStarts);
  const ends = arr(p.eventEnds);
  const series = arr(p.eventSeries);
  const allDay = arr(p.areEventsAllDay);
  const events: CalEvent[] = starts
    .map((st, i) => {
      const a = parseWall(st, cfg.utc);
      const b = parseWall(ends[i] ?? st, cfg.utc);
      return { i, name: s(names[i]), start: a, end: Number.isNaN(b.getTime()) ? a : b, allDay: !!allDay[i], series: s(series[i]) };
    })
    .filter((e) => !Number.isNaN(e.start.getTime()));
  const kinds = [...new Set(events.map((e) => e.series))];
  const colorOf = (e: CalEvent) => PALETTE[Math.max(0, kinds.indexOf(e.series)) % PALETTE.length];
  // all-day events snap to whole days (end exclusive); timed events count on every day they touch
  const span = (e: CalEvent) => (e.allDay ? allDayBounds(e.start, e.end) : e);
  const on = (d: Date) => {
    const list = events.filter((e) => overlapsDay(span(e).start, span(e).end, d));
    // the List view keeps the given order; the Time view orders by start
    return s(p.viewType).toLowerCase() === "list" ? list : [...list].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
  };
  const first = view === "month" ? weekStart(new Date(anchor.getFullYear(), anchor.getMonth(), 1), cfg.firstDay) : view === "week" ? weekStart(anchor, cfg.firstDay) : dayStart(anchor);
  const count = view === "month" ? 42 : view === "week" ? 7 : 1;
  const days = Array.from({ length: count }, (_, k) => addDays(first, k));
  const move = (n: number, years = false) => setAnchor(years ? new Date(anchor.getFullYear() + n, anchor.getMonth(), anchor.getDate()) : view === "month" ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : addDays(anchor, n * (view === "week" ? 7 : 1)));
  const title = view === "month" ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : view === "week" ? `${days[0].toLocaleDateString()} – ${days[6].toLocaleDateString()}` : anchor.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const chip = (e: CalEvent, withTime: boolean) => (
    <button
      key={e.i}
      type="button"
      onClick={(ev) => (ev.stopPropagation(), set({ selectedIndex: p.selectedIndex === e.i ? null : e.i }, "selected", e.i))}
      title={`${e.name}${e.allDay ? "" : ` · ${hhmm(e.start)}–${hhmm(e.end)}`}`}
      className={`block w-full truncate rounded px-1 text-left text-[11px] text-white ${p.selectedIndex === e.i ? "ring-2 ring-white" : ""}`}
      style={{ background: colorOf(e) }}
      data-cal-event={e.i}
    >
      {withTime && !e.allDay ? `${hhmm(e.start)} ` : ""}
      {e.name}
    </button>
  );
  const btn = "rounded border border-line-2 px-1.5 py-0.5 text-xs text-soft hover:border-ocean";
  const today = dayStart(nowWall()).getTime();
  // drag across days (or click one) to select a range for creating an event: state selectedRange, event rangeSelected
  const rangeOn = p.rangeSelectionEnabled !== false;
  const shown = picking ? dayRange(picking.a, picking.b) : (obj(p.selectedRange).start ? (p.selectedRange as { start: string; end: string }) : null);
  const dayProps = (d: Date) =>
    rangeOn
      ? {
          "data-slate-drag": true,
          onMouseDown: (e: React.MouseEvent) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            pickRef.current = { a: d, b: d };
            setPicking(pickRef.current);
            const up = () => {
              window.removeEventListener("mouseup", up);
              const r = pickRef.current;
              pickRef.current = null;
              setPicking(null);
              if (!r) return;
              const range = { ...dayRange(r.a, r.b), allDay: true };
              set({ selectedRange: range }, "rangeSelected", range);
            };
            window.addEventListener("mouseup", up);
          },
          onMouseEnter: () => {
            if (!pickRef.current) return;
            pickRef.current = { ...pickRef.current, b: d };
            setPicking(pickRef.current);
          },
        }
      : {};
  const inRange = (d: Date) => (inDayRange(d, shown) ? "ring-1 ring-inset ring-ocean bg-ocean/15" : "");
  // week / day views with viewType "Time" draw the hour grid; "List" keeps the events as a list per day
  const timeGrid = view !== "month" && s(p.viewType).toLowerCase() !== "list";
  return (
    <div className="flex h-full flex-col text-xs" data-calendar={view}>
      <div className="mb-1 flex shrink-0 items-center gap-1">
        {!!p.pagingYearEnabled && <button type="button" onClick={() => move(-1, true)} className={btn} title="Previous year">«</button>}
        {p.pagingEnabled !== false && <button type="button" onClick={() => move(-1)} className={btn} data-cal-prev>‹</button>}
        {p.pagingEnabled !== false && <button type="button" onClick={() => setAnchor(nowWall())} className={btn}>Today</button>}
        {p.pagingEnabled !== false && <button type="button" onClick={() => move(1)} className={btn} data-cal-next>›</button>}
        {!!p.pagingYearEnabled && <button type="button" onClick={() => move(1, true)} className={btn} title="Next year">»</button>}
        {p.dateRangeEnabled !== false && <span className="ml-1 truncate font-semibold" data-cal-title>{title}</span>}
        {p.viewSwitchingEnabled !== false && (
          <span className="ml-auto inline-flex overflow-hidden rounded border border-line-2">
            {(["day", "week", "month"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setView(v)} className={`px-2 py-0.5 capitalize ${view === v ? "bg-ocean text-white" : "text-soft"}`} data-cal-view={v}>
                {v}
              </button>
            ))}
          </span>
        )}
      </div>
      {view === "month" ? (
        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(0,1fr))] gap-px overflow-hidden rounded border border-line bg-line">
          {days.slice(0, 7).map((d) => d.toLocaleDateString("en-US", { weekday: "short" })).map((d) => (
            <div key={d} className="bg-panel px-1 py-0.5 text-center text-[10px] text-muted">{d}</div>
          ))}
          {days.map((d) => {
            const list = on(d);
            return (
              <div key={d.toISOString()} {...dayProps(d)} className={`min-h-0 select-none space-y-px overflow-hidden bg-ink p-0.5 ${d.getMonth() === anchor.getMonth() ? "" : "opacity-40"} ${inRange(d)}`} data-cal-day={`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`}>
                <div className={`text-right text-[10px] ${d.getTime() === today ? "font-bold text-ocean" : "text-muted"}`}>{d.getDate()}</div>
                {list.slice(0, 3).map((e) => chip(e, false))}
                {list.length > 3 && <div className="text-[10px] text-muted">+{list.length - 3} more</div>}
              </div>
            );
          })}
        </div>
      ) : timeGrid ? (
        <CalendarHours
          days={days}
          events={events}
          today={today}
          cfg={cfg}
          rangeOn={rangeOn}
          selectedRange={shown}
          chip={chip}
          colorOf={colorOf}
          selectedIndex={p.selectedIndex}
          onSelect={(e) => set({ selectedIndex: p.selectedIndex === e.i ? null : e.i }, "selected", e.i)}
          onRange={(range) => set({ selectedRange: range }, "rangeSelected", range)}
          dayProps={dayProps}
          inRange={(d) => (shown && !isTimed(shown) ? inRange(d) : "")}
        />
      ) : (
        <div className={`grid min-h-0 flex-1 gap-px overflow-auto rounded border border-line bg-line ${view === "week" ? "grid-cols-7" : "grid-cols-1"}`}>
          {days.map((d) => (
            <div key={d.toISOString()} {...dayProps(d)} className={`min-h-0 select-none space-y-0.5 bg-ink p-1 ${inRange(d)}`} data-cal-day={`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`}>
              <div className={`text-[10px] ${d.getTime() === today ? "font-bold text-ocean" : "text-muted"}`}>{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</div>
              {on(d).map((e) => chip(e, true))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const HOUR_PX = 40;
const MIN_EVENT_MIN = 20; // shortest drawn event (minutes), so short events stay readable

/** The week / day hour grid: day headers, an all-day row (whole-day events, drag for day ranges), and the hours
 *  hourStart..hourEnd (default the whole day) with timed events placed by start / end in side-by-side columns where
 *  they overlap. Dragging down (and across days in the week) selects a time range snapped to slotMinutes (default
 *  30); it first scrolls to the working day (08:00, or the earliest event in view). */
function CalendarHours({
  days, events, today, cfg, rangeOn, selectedRange, chip, colorOf, selectedIndex, onSelect, onRange, dayProps, inRange,
}: {
  days: Date[];
  events: CalEvent[];
  today: number;
  cfg: ReturnType<typeof calendarSettings>;
  rangeOn: boolean;
  selectedRange: { start: string; end: string } | null;
  chip: (e: CalEvent, withTime: boolean) => React.ReactNode;
  colorOf: (e: CalEvent) => string;
  selectedIndex: unknown;
  onSelect: (e: CalEvent) => void;
  onRange: (r: ReturnType<typeof timeRange>) => void;
  dayProps: (d: Date) => object;
  inRange: (d: Date) => string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState<{ a: Date; b: Date } | null>(null);
  const [now, setNow] = useState(() => toWall(new Date(), cfg.utc));
  // the hours shown, in minutes from midnight; positions below are relative to lo
  const [lo, hi] = [cfg.startHour * 60, cfg.endHour * 60];
  const clip = (g: { top: number; bottom: number } | null) => (g ? clipSegment(g, lo, hi) : null);
  const allDay = (d: Date) => events.filter((e) => e.allDay && overlapsDay(allDayBounds(e.start, e.end).start, allDayBounds(e.start, e.end).end, d));
  const starts: number[] = [];
  const placed = days.map((d) => {
    const segs = events.flatMap((e) => {
      if (e.allDay) return [];
      const g = clip(daySegment(e.start, e.end, d));
      if (g) starts.push(g.top + lo);
      return g ? [{ i: e.i, ...g }] : [];
    });
    return layoutDay(segs, MIN_EVENT_MIN);
  });
  const byIndex = new Map(events.map((e) => [e.i, e]));
  // scroll to the working day when the shown days change
  const key = `${dayKey(days[0])}:${days.length}:${lo}`;
  const hour = scrollHour(starts, 8, cfg.startHour);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = (hour - cfg.startHour) * HOUR_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(toWall(new Date(), cfg.utc)), 60000);
    return () => window.clearInterval(t);
  }, [cfg.utc]);
  // the slot under a pointer position: the day column by x, the time by y (the column box scrolls with the grid)
  const slotFrom = (x: number, y: number): Date | null => {
    const r = cols.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    const k = Math.max(0, Math.min(days.length - 1, Math.floor(((x - r.left) / r.width) * days.length)));
    return atMinutes(days[k], slotAt(y - r.top, HOUR_PX, cfg.slot, lo, hi));
  };
  const down = (e: React.MouseEvent) => {
    if (!rangeOn || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const a = slotFrom(e.clientX, e.clientY);
    if (!a) return;
    e.preventDefault();
    let cur = { a, b: a };
    setPicking(cur);
    const move = (ev: MouseEvent) => {
      const b = slotFrom(ev.clientX, ev.clientY);
      if (b && b.getTime() !== cur.b.getTime()) setPicking((cur = { a, b }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setPicking(null);
      onRange(timeRange(cur.a, cur.b, cfg.slot, cfg.utc));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const shownRange = picking ? timeRange(picking.a, picking.b, cfg.slot, cfg.utc) : selectedRange && isTimed(selectedRange) ? selectedRange : null;
  const px = (min: number) => (min / 60) * HOUR_PX;
  const gutter = "w-11 shrink-0";
  const head = (d: Date) => (d.getTime() === today ? "font-bold text-ocean" : "text-muted");
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-line bg-ink" data-cal-timegrid>
      <div className="flex shrink-0 overflow-hidden border-b border-line bg-panel" style={{ scrollbarGutter: "stable" }}>
        <div className={gutter} />
        {days.map((d) => (
          <div key={d.toISOString()} className={`min-w-0 flex-1 truncate border-l border-line px-1 py-0.5 text-[10px] ${head(d)}`}>
            {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
          </div>
        ))}
      </div>
      <div className="flex max-h-[30%] shrink-0 overflow-y-auto border-b border-line" style={{ scrollbarGutter: "stable" }} data-cal-allday-row>
        <div className={`${gutter} px-1 py-0.5 text-[9px] text-muted`}>all-day</div>
        {days.map((d) => (
          <div key={d.toISOString()} {...dayProps(d)} className={`min-h-[22px] min-w-0 flex-1 select-none space-y-px border-l border-line p-0.5 ${inRange(d)}`} data-cal-allday={dayKey(d)}>
            {allDay(d).map((e) => chip(e, false))}
          </div>
        ))}
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }} data-cal-scroll>
        <div className="flex" style={{ height: (cfg.endHour - cfg.startHour) * HOUR_PX }} data-cal-hours={`${cfg.startHour}-${cfg.endHour}`}>
          <div className={`relative ${gutter}`}>
            {Array.from({ length: cfg.endHour - cfg.startHour - 1 }, (_, k) => (
              <div key={k} className="absolute right-1 -translate-y-1/2 text-[9px] text-muted" style={{ top: (k + 1) * HOUR_PX }} data-cal-hour={cfg.startHour + k + 1}>
                {String(cfg.startHour + k + 1).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          <div ref={cols} className="relative flex min-w-0 flex-1" onMouseDown={down} {...(rangeOn ? { "data-slate-drag": true } : {})}>
            {days.map((d, k) => {
              const sel = shownRange ? clip(daySegment(parseWall(shownRange.start, cfg.utc), parseWall(shownRange.end, cfg.utc), d)) : null;
              const nowAt = now.getHours() * 60 + now.getMinutes();
              const nowMin = d.getTime() === today && nowAt >= lo && nowAt < hi ? nowAt - lo : null;
              return (
                <div
                  key={d.toISOString()}
                  className="relative min-w-0 flex-1 select-none border-l border-line"
                  style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--color-line) 0 1px, transparent 1px ${HOUR_PX / 2}px, var(--color-line) ${HOUR_PX / 2}px ${HOUR_PX / 2 + 1}px, transparent ${HOUR_PX / 2 + 1}px ${HOUR_PX}px)` }}
                  data-cal-col={dayKey(d)}
                >
                  {sel && (
                    <div className="pointer-events-none absolute inset-x-0 rounded-sm bg-ocean/20 ring-1 ring-inset ring-ocean" style={{ top: px(sel.top), height: Math.max(2, px(sel.bottom - sel.top)) }} data-cal-range={dayKey(d)} />
                  )}
                  {placed[k].map((x) => {
                    const e = byIndex.get(x.i)!;
                    const h = px(Math.max(x.bottom - x.top, MIN_EVENT_MIN));
                    return (
                      <button
                        key={x.i}
                        type="button"
                        onClick={(ev) => (ev.stopPropagation(), onSelect(e))}
                        title={`${e.name} · ${hhmm(e.start)}–${hhmm(e.end)}`}
                        className={`absolute overflow-hidden rounded px-1 text-left text-[10px] leading-tight text-white ${selectedIndex === e.i ? "z-10 ring-2 ring-white" : ""}`}
                        style={{
                          // a short event at the end of the shown hours keeps its drawn height inside the grid
                          top: px(Math.max(0, Math.min(x.top, hi - lo - MIN_EVENT_MIN))),
                          height: Math.max(14, h - 1),
                          left: `calc(${(x.col / x.cols) * 100}% + 1px)`,
                          width: `calc(${100 / x.cols}% - 2px)`,
                          background: colorOf(e),
                        }}
                        data-cal-event={e.i}
                        data-cal-slot={`${x.col}/${x.cols}`}
                      >
                        <span className="font-medium">{e.name}</span>
                        {h >= 26 ? <span className="block opacity-80">{hhmm(e.start)}–{hhmm(e.end)}</span> : <span className="opacity-80"> {hhmm(e.start)}</span>}
                      </button>
                    );
                  })}
                  {nowMin !== null && nowMin < DAY_MINUTES && <div className="pointer-events-none absolute inset-x-0 z-20 h-px bg-bad" style={{ top: px(nowMin) }} data-cal-now />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// visualization: image gallery, tree, graph, map
// ------------------------------------------------------------------------------------------------

function Gallery({ p, set }: { p: P; set: Set }) {
  const urls = arr(p.imageUrls).map(s).filter(Boolean);
  const caps = arr(p.captions);
  const [open, setOpen] = useState<number | null>(null);
  if (!urls.length) return <Empty text="Set imageUrls" />;
  return (
    <div className="h-full overflow-auto" data-gallery>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
        {urls.map((u, i) => (
          <button key={i} type="button" onClick={() => (setOpen(i), set({ selectedIndex: i }, "selected", i))} className={`overflow-hidden rounded border text-left ${p.selectedIndex === i ? "border-ocean" : "border-line"}`} data-gallery-item={i}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt={s(caps[i])} className="h-20 w-full object-cover" loading="lazy" />
            {s(caps[i]) && <div className="truncate px-1 py-0.5 text-[11px] text-soft">{s(caps[i])}</div>}
          </button>
        ))}
      </div>
      {open !== null && urls[open] && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-ink/90 p-6" onClick={() => setOpen(null)} data-gallery-lightbox>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[open]} alt={s(caps[open])} className="max-h-[80vh] max-w-full rounded" onClick={(e) => e.stopPropagation()} />
          <div className="flex items-center gap-3 text-sm text-white" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setOpen((open + urls.length - 1) % urls.length)} className="rounded border border-white/30 px-2">‹</button>
            <span>{s(caps[open]) || `${open + 1} / ${urls.length}`}</span>
            <button type="button" onClick={() => setOpen((open + 1) % urls.length)} className="rounded border border-white/30 px-2">›</button>
          </div>
        </div>
      )}
    </div>
  );
}

type TNode = { id: string | number; label?: string; childNodes?: TNode[]; iconName?: string; isExpanded?: boolean };

function Tree({ p, set }: { p: P; set: Set }) {
  const nodes = (Array.isArray(p.contents) ? p.contents : []) as TNode[];
  const selected = arr(p.selected ?? p.selectedNodes).map(String);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const mode = s(p.selectionType).toLowerCase() || "single";
  const q = s(p.searchText).toLowerCase();
  const matches = (n: TNode): boolean => !q || s(n.label).toLowerCase().includes(q) || (n.childNodes ?? []).some(matches);
  const pick = (n: TNode) => {
    if (mode === "none") return;
    const k = String(n.id);
    const next = mode === "multiple" ? (selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]) : selected.includes(k) ? [] : [k];
    // ids keep their type (numbers stay numbers)
    const typed = next.map((x) => (typeof n.id === "number" && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x));
    set({ selected: typed, selectedNodes: typed }, "selectionChanged", typed);
  };
  const row = (n: TNode, depth: number): React.ReactNode => {
    if (!matches(n)) return null;
    const k = String(n.id);
    const kids = n.childNodes ?? [];
    const open = q ? true : !(closed[k] ?? n.isExpanded === false);
    return (
      <div key={k}>
        <div className={`flex items-center gap-1 rounded px-1 py-0.5 text-sm ${selected.includes(k) ? "bg-ocean/20 text-white" : "hover:bg-panel-2"}`} style={{ paddingLeft: 4 + depth * 14 }} data-tree-node={k}>
          {kids.length ? (
            <button type="button" onClick={() => setClosed((c) => ({ ...c, [k]: open }))} className="text-muted" aria-label={open ? "Collapse" : "Expand"}>
              <Icon name="down" className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`} />
            </button>
          ) : (
            <span className="w-3" />
          )}
          <Icon name={kids.length || /folder/.test(s(n.iconName)) ? "folder" : "doc"} className="h-3.5 w-3.5 shrink-0 text-muted" />
          <button type="button" onClick={() => pick(n)} className="min-w-0 flex-1 truncate text-left">
            {q && s(n.label ?? n.id).toLowerCase().includes(q) ? <mark className="rounded-sm bg-warn/30 text-inherit">{s(n.label ?? n.id)}</mark> : s(n.label ?? n.id)}
          </button>
        </div>
        {open && kids.map((c) => row(c, depth + 1))}
      </div>
    );
  };
  if (!nodes.length) return <Empty text="Set contents (a tree of {id, label, childNodes})" />;
  const shown = nodes.filter(matches);
  return (
    <div className="flex h-full flex-col" data-tree>
      {p.searchEnabled !== false && (
        <div className="relative mb-1 shrink-0">
          <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={s(p.searchText)}
            onChange={(e) => set({ searchText: e.target.value }, "searchText.changed", e.target.value)}
            placeholder="Search…"
            className="w-full rounded border border-line-2 bg-ink py-1 pl-7 pr-2 text-sm outline-none focus:border-ocean"
            data-tree-search
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.map((n) => row(n, 0))}
        {!shown.length && <div className="px-1 py-2 text-xs text-muted">No matches</div>}
      </div>
    </div>
  );
}

type GNode = { id: string; label: string; x: number; y: number; color: string };

/** Node positions: manual (given), flow (layers along the edges' direction), circle, grid or force directed. */
export function layoutGraph(ids: string[], src: string[], tgt: string[], layout: string, xs: unknown[], ys: unknown[], edgeLength: number): { x: number; y: number }[] {
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const edges = src.map((a, k) => [idx.get(a), idx.get(tgt[k])] as const).filter((e): e is readonly [number, number] => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1]);
  const grid = (i: number) => ({ x: (i % Math.ceil(Math.sqrt(n || 1))) * edgeLength, y: Math.floor(i / Math.ceil(Math.sqrt(n || 1))) * edgeLength });
  const l = layout.toLowerCase();
  if (l.startsWith("manual")) return ids.map((_, i) => (Number.isFinite(Number(xs[i])) && xs[i] !== null && xs[i] !== undefined && Number.isFinite(Number(ys[i])) && ys[i] !== null && ys[i] !== undefined ? { x: Number(xs[i]), y: Number(ys[i]) } : grid(i)));
  if (l.startsWith("grid")) return ids.map((_, i) => grid(i));
  if (l.startsWith("circ")) return ids.map((_, i) => ({ x: Math.cos((2 * Math.PI * i) / (n || 1)) * edgeLength * Math.max(1, n / 6), y: Math.sin((2 * Math.PI * i) / (n || 1)) * edgeLength * Math.max(1, n / 6) }));
  if (l.startsWith("flow")) {
    // layers: the longest path from a root (cycles are cut by a visit limit)
    const layer = new Array(n).fill(0);
    for (let pass = 0; pass < n; pass++) {
      let moved = false;
      for (const [a, b] of edges)
        if (layer[b] < layer[a] + 1 && layer[a] + 1 < n) {
          layer[b] = layer[a] + 1;
          moved = true;
        }
      if (!moved) break;
    }
    const perLayer: Record<number, number> = {};
    return ids.map((_, i) => {
      const k = (perLayer[layer[i]] = (perLayer[layer[i]] ?? 0) + 1) - 1;
      const along = layer[i] * edgeLength;
      const across = k * edgeLength;
      if (l.includes("up")) return { x: across, y: -along };
      if (l.includes("left")) return { x: -along, y: across };
      if (l.includes("right")) return { x: along, y: across };
      return { x: across, y: along };
    });
  }
  // force directed: repulsion between all nodes, springs along edges; a fixed start, so the layout is stable
  const pos = ids.map((_, i) => ({ x: Math.cos(i * 2.399963) * edgeLength * Math.sqrt(i + 1), y: Math.sin(i * 2.399963) * edgeLength * Math.sqrt(i + 1) }));
  for (let it = 0; it < 220; it++) {
    const f = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const d2 = Math.max(1, dx * dx + dy * dy);
        const k = (edgeLength * edgeLength) / d2;
        f[i].x += dx * k;
        f[i].y += dy * k;
        f[j].x -= dx * k;
        f[j].y -= dy * k;
      }
    for (const [a, b] of edges) {
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const k = (d - edgeLength) / d;
      f[a].x += dx * k * 0.5;
      f[a].y += dy * k * 0.5;
      f[b].x -= dx * k * 0.5;
      f[b].y -= dy * k * 0.5;
    }
    const step = 0.08 * (1 - it / 220);
    for (let i = 0; i < n; i++) {
      pos[i].x += Math.max(-40, Math.min(40, f[i].x * step));
      pos[i].y += Math.max(-40, Math.min(40, f[i].y * step));
    }
  }
  return pos;
}

/** The Graph widget: layouts, selection, wheel / button zoom, background panning (not in the editor, where dragging
 *  the background moves the widget) and node dragging. Dragged positions are state (nodes.xPositions / yPositions,
 *  event nodes.changed); in Manual layout the editor also writes them into the document, so they are kept on save. */
function Graph({ w, p, rt, set }: { w: SlateWidget; p: P; rt: SlateRuntime; set: Set }) {
  const nodesP = obj(p.nodes);
  const edgesP = obj(p.edges);
  const ids = arr(nodesP.ids).map(String);
  const src = arr(edgesP.sourceNodeIds).map(String);
  const tgt = arr(edgesP.targetNodeIds).map(String);
  const layout = s(p.layout) || "Force Directed";
  const manual = layout.toLowerCase().startsWith("manual");
  const edgeLength = num(p.edgeLength, 90);
  const key = JSON.stringify([ids, src, tgt, layout, nodesP.xPositions, nodesP.yPositions, edgeLength]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pos = useMemo(() => layoutGraph(ids, src, tgt, layout, arr(nodesP.xPositions), arr(nodesP.yPositions), edgeLength), [key]);
  // nodes moved in a computed layout (kept until the data or layout changes) and the node being dragged
  const shape = JSON.stringify([ids, src, tgt, layout, edgeLength]);
  const [moved, setMoved] = useState<{ shape: string; at: Record<string, { x: number; y: number }> }>({ shape, at: {} });
  const movedAt = moved.shape === shape ? moved.at : {};
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const camKey = JSON.stringify(p.camera ?? null);
  const [cam, setCam] = useState<{ key: string; c: Camera | null }>({ key: camKey, c: (p.camera as Camera) ?? null });
  const camera = cam.key === camKey ? cam.c : ((p.camera as Camera) ?? null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gesture = useRef<{ kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number; upp: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const d = num(p.nodeDiameter, 22);
  const at = (i: number) => (drag && drag.id === ids[i] ? drag : movedAt[ids[i]] ?? pos[i]);
  const points = ids.map((_, i) => pos[i]);
  const fit = fitBox(points, d * 2 + 30);
  const view = cameraViewBox(camera, fit, p.zoomScaleRange);
  const ratio = resolveCamera(camera, fit, p.zoomScaleRange).ratio;
  const commitCamera = (c: Camera) => set({ camera: c }, "camera.changed", c);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setCamera = (c: Camera, commit: "now" | "later" | "no") => {
    setCam({ key: camKey, c });
    if (commitTimer.current) clearTimeout(commitTimer.current);
    if (commit === "now") commitCamera(c);
    // wheel zoom reports once it settles
    else if (commit === "later") commitTimer.current = setTimeout(() => commitCamera(c), 250);
  };
  // the wheel zooms around the pointer (a non-passive listener, so the page does not scroll as well)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
            const m = el.getScreenCTM();
      let pt: { x: number; y: number } | null = null;
      if (m) {
        const sp = el.createSVGPoint();
        sp.x = e.clientX;
        sp.y = e.clientY;
        const g = sp.matrixTransform(m.inverse());
        pt = { x: g.x, y: g.y };
      }
      setCamera(zoomCamera(camera, fit, Math.exp(-e.deltaY * 0.0015), pt, p.zoomScaleRange), "later");
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }); // re-attached each render, so it zooms from the current camera
  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
  }, []);
  if (!ids.length) return <Empty text="Set nodes.ids (and edges.sourceNodeIds / targetNodeIds)" />;

  const finishNodeDrag = (id: string, x: number, y: number) => {
    const all = ids.map((nid, i) => (nid === id ? { x, y } : at(i)));
    const xPositions = all.map((q) => Math.round(q.x * 10) / 10);
    const yPositions = all.map((q) => Math.round(q.y * 10) / 10);
    if (!manual) setMoved({ shape, at: { ...movedAt, [id]: { x, y } } });
    set({ nodes: { xPositions, yPositions } }, "nodes.changed", { id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, xPositions, yPositions });
    // Manual layout keeps positions on save (when the positions are not computed by a template)
    const raw = w.props.nodes;
    if (manual && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const r = raw as P;
      if (typeof r.xPositions !== "string" && typeof r.yPositions !== "string") rt.persistWidgetProps(w.id, { nodes: { ...r, xPositions, yPositions } });
    }
  };
  const onDown = (e: React.MouseEvent, id?: string) => {
    if (e.button !== 0) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const upp = unitsPerPixel(view, rect?.width ?? 1, rect?.height ?? 1);
    if (id) {
      // (the event still bubbles, so the editor selects the widget; the canvas does not move it off a [data-slate-drag])
      const i = ids.indexOf(id);
      const q = at(i);
      gesture.current = { kind: "node", id, sx: e.clientX, sy: e.clientY, ox: q.x, oy: q.y, upp, moved: false };
    } else {
      // in the editor a drag on the background moves the widget instead
      if (rt.opts.isEditMode || (e.target as Element).closest("[data-graph-node]")) return;
      const c = resolveCamera(camera, fit, p.zoomScaleRange);
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, upp, moved: false };
    }
    const move = (ev: MouseEvent) => {
      const g = gesture.current;
      if (!g) return;
      const [dx, dy] = [(ev.clientX - g.sx) * g.upp, (ev.clientY - g.sy) * g.upp];
      if (!g.moved && Math.hypot(ev.clientX - g.sx, ev.clientY - g.sy) < 3) return;
      g.moved = true;
      if (g.kind === "node") setDrag({ id: g.id!, x: g.ox + dx, y: g.oy + dy });
      else setCamera({ x: g.ox - dx, y: g.oy - dy, ratio }, "no");
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const g = gesture.current;
      gesture.current = null;
      if (!g || !g.moved) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      const [dx, dy] = [(ev.clientX - g.sx) * g.upp, (ev.clientY - g.sy) * g.upp];
      if (g.kind === "node") {
        setDrag(null);
        finishNodeDrag(g.id!, g.ox + dx, g.oy + dy);
      } else setCamera({ x: g.ox - dx, y: g.oy - dy, ratio }, "now");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const labels = arr(nodesP.labels);
  const cvals = arr(nodesP.colorScaleValues).map((v) => num(v, NaN));
  const finiteVals = cvals.filter(Number.isFinite);
  const [lo, hi] = [Math.min(...finiteVals), Math.max(...finiteVals)];
  const range = arr(p.nodeColorScaleRange).map(s);
  const nodes: GNode[] = ids.map((id, i) => ({
    id, label: s(labels[i] ?? id), x: at(i).x, y: at(i).y,
    color: Number.isFinite(cvals[i]) && range.length >= 2 ? scaleColor(range, hi === lo ? 0.5 : (cvals[i] - lo) / (hi - lo)) : "#3b82f6",
  }));
  const by = new Map(nodes.map((n) => [n.id, n]));
  const selected = arr(p.selectedNodeIds).map(String);
  const elabels = arr(edgesP.labels);
  const below = s(p.nodeLabelPosition || "bottom") !== "top";
  const hideLabels = labelsHidden(ratio, p.hideLabelsScale);
  const markerId = `arrow-${w.id}`;
  const zoomBtn = "flex h-6 w-6 items-center justify-center rounded border border-line-2 bg-panel text-xs text-soft hover:border-ocean";
  return (
    <div className="relative h-full w-full" data-graph-wrap>
      <svg
        ref={svgRef}
        viewBox={view.join(" ")}
        className={`h-full w-full select-none ${rt.opts.isEditMode ? "" : "cursor-grab active:cursor-grabbing"}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={(e) => onDown(e)}
        onClick={() => !suppressClick.current && selected.length && set({ selectedNodeIds: [] }, "selectionChanged", [])}
        data-graph={layout}
        data-graph-ratio={Math.round(ratio * 1000) / 1000}
      >
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX={10 + d / 2} refY={5} markerWidth={num(p.edgeArrowSize, 7)} markerHeight={num(p.edgeArrowSize, 7)} orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
          </marker>
        </defs>
        {src.map((a, k) => {
          const [A, B] = [by.get(a), by.get(tgt[k])];
          if (!A || !B) return null;
          return (
            <g key={k} data-graph-edge={k}>
              <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="#64748b" strokeWidth={1.5} markerEnd={p.directedEdgesEnabled ? `url(#${markerId})` : undefined} />
              {s(elabels[k]) && !hideLabels && (
                <text x={(A.x + B.x) / 2} y={(A.y + B.y) / 2 - 3} textAnchor="middle" className="fill-muted text-[9px]">
                  {s(elabels[k])}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const on = selected.includes(n.id);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              className={drag?.id === n.id ? "cursor-grabbing" : "cursor-pointer"}
              onMouseDown={(e) => onDown(e, n.id)}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) return;
                const next = e.ctrlKey || e.metaKey ? (on ? selected.filter((x) => x !== n.id) : [...selected, n.id]) : on && selected.length === 1 ? [] : [n.id];
                set({ selectedNodeIds: next }, "selectionChanged", next);
              }}
              data-graph-node={n.id}
              data-slate-drag
            >
              {on && <circle r={num(p.nodeSelectorDiameter, d + 10) / 2} fill="none" stroke="#f59e0b" strokeWidth={2} />}
              <circle r={d / 2} fill={n.color} stroke="#0b1220" strokeWidth={1.5} />
              {!hideLabels && (
                <text y={below ? d / 2 + 11 + num(p.nodeLabelOffset, 0) : -d / 2 - 4 - num(p.nodeLabelOffset, 0)} textAnchor="middle" className="pointer-events-none fill-soft text-[10px]">
                  {n.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="absolute right-1 top-1 flex flex-col gap-0.5">
        <button type="button" onClick={() => setCamera(zoomCamera(camera, fit, 1.25, null, p.zoomScaleRange), "now")} className={zoomBtn} title="Zoom in" data-graph-zoom="in">
          +
        </button>
        <button type="button" onClick={() => setCamera(zoomCamera(camera, fit, 0.8, null, p.zoomScaleRange), "now")} className={zoomBtn} title="Zoom out" data-graph-zoom="out">
          −
        </button>
        <button type="button" onClick={() => setCamera({ x: null, y: null, ratio: null }, "now")} className={zoomBtn} title="Fit" data-graph-zoom="fit">
          <Icon name="fit" className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

type GeoFeature = { type: "Feature"; id?: string | number; properties?: P | null; geometry: { type: string; coordinates: unknown } | null };
const features = (g: unknown): GeoFeature[] => {
  const o = typeof g === "string" ? (() => { try { return JSON.parse(g); } catch { return null; } })() : g;
  if (!o || typeof o !== "object") return [];
  const x = o as { type?: string; features?: GeoFeature[] };
  if (x.type === "FeatureCollection") return x.features ?? [];
  if (x.type === "Feature") return [o as GeoFeature];
  return x.type ? [{ type: "Feature", properties: {}, geometry: o as GeoFeature["geometry"] }] : [];
};
/** The rings (polygons) and lines of a GeoJSON geometry as lists of [lon, lat]. */
const shapes = (g: GeoFeature["geometry"]): { closed: boolean; pts: number[][] }[] => {
  if (!g) return [];
  const c = g.coordinates as number[][][][] & number[][][] & number[][] & number[];
  if (g.type === "Polygon") return (c as unknown as number[][][]).map((pts) => ({ closed: true, pts }));
  if (g.type === "MultiPolygon") return (c as unknown as number[][][][]).flatMap((poly) => poly.map((pts) => ({ closed: true, pts })));
  if (g.type === "LineString") return [{ closed: false, pts: c as unknown as number[][] }];
  if (g.type === "MultiLineString") return (c as unknown as number[][][]).map((pts) => ({ closed: false, pts }));
  return [];
};

/** Slate's IVectorTileStyleOptions (color, outline { color, size }, radius, size) as a VectorTileLayer style. */
const vectorStyle = (o: P): VectorTileStyle => {
  const outline = obj(o.outline);
  const c = s(o.color) || undefined;
  return {
    fill: c,
    line: c,
    circle: c,
    outline: s(outline.color) || undefined,
    outlineWidth: outline.size === undefined ? undefined : num(outline.size, 1),
    radius: o.radius === undefined ? undefined : num(o.radius, 5),
    width: o.size === undefined ? undefined : num(o.size, 1.5),
  };
};

/** The Map widget: a base tile layer and overlay layers — location (points), heatmap, shape (GeoJSON), choropleth (GeoJSON or
 *  vector tiles) and vector (a vector tile server, styled by baseStyle / hoverStyle / clickStyle or by a property). */
function SlateMap({ p, set }: { p: P; set: Set }) {
  const layers = (Array.isArray(p.layers) ? p.layers : []) as P[];
  const tile = s(p.tileLayer || "streets").toLowerCase();
  const [basemap, setBasemap] = useState<Basemap>(tile === "none" ? "none" : tile === "dark" ? "streets" : tile === "satellite" ? "google-satellite" : tile === "streets" ? "streets" : "google-satellite");
  const handle = useRef<MapHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const all: number[][] = [];
  for (const l of layers) {
    const t = s(l.type || "location");
    if (t === "location" || t === "heatmap") arr(l.latitudes).forEach((la, i) => Number.isFinite(Number(la)) && Number.isFinite(Number(arr(l.longitudes)[i])) && all.push([Number(arr(l.longitudes)[i]), Number(la)]));
    else features(l.geoJson).forEach((f) => (f.geometry?.type === "Point" ? all.push(f.geometry.coordinates as number[]) : shapes(f.geometry).forEach((sh) => sh.pts.forEach((q) => all.push(q)))));
  }
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  // fit to the features once the map has its size (MapCanvas measures itself first), and again when either changes
  const sig = JSON.stringify([all.length, all[0], all[all.length - 1], size.w, size.h]);
  const fitted = useRef("");
  useEffect(() => {
    if (!all.length || fitted.current === sig || size.w < 50 || size.h < 50) return;
    fitted.current = sig;
    const lons = all.map((q) => q[0]);
    const lats = all.map((q) => q[1]);
    const pad = Math.max(0.01, (Math.max(...lons) - Math.min(...lons)) * 0.15, (Math.max(...lats) - Math.min(...lats)) * 0.15);
    const bounds: [number, number, number, number] = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
    // after MapCanvas applied the new size (not cancelled by the next render: the runtime re-renders often)
    setTimeout(() => handle.current?.fit(bounds), 50);
  });
  // vector tile layers: failed tiles per layer (retried with back-off by the layer; "Retry" starts them over)
  const [vtFailed, setVtFailed] = useState<Record<number, [number, number]>>({});
  const [vtRetry, setVtRetry] = useState(0);
  const shown = Object.entries(vtFailed).filter(([k]) => layers[Number(k)] && layers[Number(k)].visible !== false);
  const failedTiles = shown.reduce((n, [, v]) => n + v[0], 0);
  const retryingTiles = shown.reduce((n, [, v]) => n + v[1], 0);
  const selected = obj(p.selection);
  const isSel = (layer: number, id: unknown) => selected.layer === layer && arr(selected.ids).map(String).includes(String(id));
  const select = (layer: number, id: unknown, properties: unknown) => {
    const next = isSel(layer, id) ? { layer: null, ids: [], properties: null } : { layer, ids: [id], properties };
    set({ selection: next }, "selectionChanged", next);
  };
  return (
    <div ref={box} className={`relative flex h-full flex-col ${p.interactive === false ? "pointer-events-none" : ""}`} data-slate-map>
      <MapCanvas handle={handle} basemap={basemap} onBasemap={setBasemap}>
        {(m) =>
          layers.map((l, k) => {
            const t = s(l.type || "location");
            const color = s(l.color) || PALETTE[k % PALETTE.length];
            if (l.visible === false) return null;
            // vector: features of a vector tile server; choropleth with layerSource "Vector Tile": its ids / values color the tiles' features
            if (t === "vector" || (t === "choropleth" && /vector/i.test(s(l.layerSource)))) {
              const vo = obj(l.vectorTileOptions);
              const cso = obj(l.colorScaleOptions);
              const ids = arr(l.ids).map(s);
              const vals = arr(l.values);
              const choro = t === "choropleth";
              const colors = (arr(cso.colors).length >= 2 ? arr(cso.colors) : arr(l.colorScale)).map(s);
              const prop = s(l.colorProperty);
              const colorBy: VectorColorBy | null = choro
                ? { mode: "range", colors: colors.length >= 2 ? colors : ["#dbeafe", "#1d4ed8"], defaultColor: s(cso.defaultColor) || undefined }
                : prop
                  ? { property: prop, mode: l.colorMode === "category" || l.colorMode === "range" ? l.colorMode : undefined, colors: colors.length >= 2 ? colors : undefined, palette: colors.length ? colors : undefined, defaultColor: s(cso.defaultColor) || undefined }
                  : null;
              const base = vectorStyle(obj(l.baseStyle));
              return (
                <g key={k} data-map-layer={t}>
                  <VectorTileLayer
                    p={m}
                    url={s(vo.vectorTileUrl || l.vectorTileUrl || l.url)}
                    sourceLayers={arr(vo.layerName ?? l.layerName).map(s).filter(Boolean)}
                    minZoom={num(vo.minZoom, 0)}
                    maxZoom={num(vo.maxZoom, 14)}
                    idKey={s(vo.featureIdKey) || "id"}
                    labelKey={s(l.labelProperty) || undefined}
                    labels={l.showLabels === true || s(l.labelMode) === "always" ? "always" : "hover"}
                    labelStyle={s(l.labelStyle) === "card" ? "card" : "minimal"}
                    proxy={vo.useProxy === true || l.useProxy === true}
                    retryNonce={vtRetry}
                    onStatus={(st) => {
                      const v: [number, number] = [st.failed ?? 0, st.retrying ?? 0];
                      setVtFailed((cur) => (cur[k]?.[0] === v[0] && cur[k]?.[1] === v[1] ? cur : { ...cur, [k]: v }));
                    }}
                    allowIds={arr(vo.featureIdWhitelist).map(s)}
                    color={color}
                    style={{ ...base, opacity: l.opacity === undefined ? undefined : num(l.opacity, 1), fillOpacity: l.fillOpacity === undefined ? (choro ? 0.7 : undefined) : num(l.fillOpacity, 0.3) }}
                    hoverStyle={vectorStyle(obj(l.hoverStyle))}
                    selectedStyle={vectorStyle(obj(l.clickStyle))}
                    colorBy={colorBy}
                    valueById={choro ? Object.fromEntries(ids.map((id, i): [string, number] => [id, num(vals[i], NaN)]).filter(([, v]) => Number.isFinite(v))) : null}
                    selectedIds={selected.layer === k ? arr(selected.ids).map(s) : []}
                    onFeature={(f) => select(k, f.id, { ...f.properties, layer: f.layer, ...(choro && ids.includes(f.id) ? { value: num(vals[ids.indexOf(f.id)], NaN) } : {}) })}
                  />
                </g>
              );
            }
            if (t === "location" || t === "heatmap") {
              const lats = arr(l.latitudes);
              const lons = arr(l.longitudes);
              const lids = arr(l.ids);
              const labels = arr(l.labels);
              const vals = arr(l.colorScaleValues).map((v) => num(v, NaN));
              const fin = vals.filter(Number.isFinite);
              const scale = arr(l.colorScale).map(s);
              return (
                <g key={k} data-map-layer={t}>
                  {t === "heatmap" && (
                    <defs>
                      <radialGradient id={`heat-${k}`}>
                        <stop offset="0%" stopColor={color} stopOpacity={0.55} />
                        <stop offset="100%" stopColor={color} stopOpacity={0} />
                      </radialGradient>
                    </defs>
                  )}
                  {lats.map((la, i) => {
                    const [x, y] = [m.px(Number(lons[i])), m.py(Number(la))];
                    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                    if (t === "heatmap") return <circle key={i} cx={x} cy={y} r={num(l.radius, 28)} fill={`url(#heat-${k})`} className="pointer-events-none" />;
                    const id = lids[i] ?? i;
                    const on = isSel(k, id);
                    const fill = Number.isFinite(vals[i]) && scale.length >= 2 ? scaleColor(scale, Math.max(...fin) === Math.min(...fin) ? 0.5 : (vals[i] - Math.min(...fin)) / (Math.max(...fin) - Math.min(...fin))) : color;
                    return (
                      <g key={i} transform={`translate(${x},${y})`} className="cursor-pointer" onPointerDown={(e) => (e.stopPropagation(), select(k, id, { latitude: Number(la), longitude: Number(lons[i]), label: labels[i] ?? null }))} data-map-point={s(id)}>
                        <circle r={num(l.radius, 6) + (on ? 2 : 0)} fill={fill} stroke={on ? "#fff" : "#0b1220"} strokeWidth={2} />
                        {s(labels[i]) && <title>{s(labels[i])}</title>}
                        {s(labels[i]) && m.z >= 8 && (
                          <text x={10} y={4} className="pointer-events-none fill-white text-[11px]" style={{ paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 }}>
                            {s(labels[i])}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            }
            // shape and choropleth: GeoJSON features; a choropleth colors each by a value on a color scale
            const fs = features(l.geoJson);
            const vp = s(l.valueProperty);
            const values = fs.map((f, i) => num(vp ? obj(f.properties)[vp] : arr(l.values)[i], NaN));
            const fin = values.filter(Number.isFinite);
            const scale = arr(l.colorScale).map(s);
            return (
              <g key={k} data-map-layer={t}>
                {fs.map((f, i) => {
                  const id = f.id ?? obj(f.properties)[s(l.idProperty) || "id"] ?? i;
                  const on = isSel(k, id);
                  const fill = t === "choropleth" && Number.isFinite(values[i]) ? scaleColor(scale.length >= 2 ? scale : ["#dbeafe", "#1d4ed8"], Math.max(...fin) === Math.min(...fin) ? 0.5 : (values[i] - Math.min(...fin)) / (Math.max(...fin) - Math.min(...fin))) : color;
                  const label = s(obj(f.properties)[s(l.labelProperty) || "name"]);
                  if (f.geometry?.type === "Point") {
                    const q = f.geometry.coordinates as number[];
                    return <circle key={i} cx={m.px(q[0])} cy={m.py(q[1])} r={6} fill={fill} stroke="#0b1220" strokeWidth={2} className="cursor-pointer" onPointerDown={(e) => (e.stopPropagation(), select(k, id, f.properties ?? null))} data-map-feature={s(id)} />;
                  }
                  return shapes(f.geometry).map((sh, j) => (
                    <path
                      key={`${i}-${j}`}
                      d={`${sh.pts.map((q, n) => `${n ? "L" : "M"}${m.px(q[0]).toFixed(1)},${m.py(q[1]).toFixed(1)}`).join("")}${sh.closed ? "Z" : ""}`}
                      fill={sh.closed ? fill : "none"}
                      fillOpacity={num(l.fillOpacity, t === "choropleth" ? 0.7 : 0.35)}
                      stroke={on ? "#fff" : color}
                      strokeWidth={on ? 3 : 1.5}
                      className="cursor-pointer"
                      onPointerDown={(e) => (e.stopPropagation(), select(k, id, { ...(f.properties ?? {}), ...(Number.isFinite(values[i]) ? { value: values[i] } : {}) }))}
                      data-map-feature={s(id)}
                    >
                      {label && <title>{`${label}${Number.isFinite(values[i]) ? `: ${values[i]}` : ""}`}</title>}
                    </path>
                  ));
                })}
              </g>
            );
          })
        }
      </MapCanvas>
      {failedTiles > 0 && (
        <div className="pointer-events-auto absolute bottom-2 left-2 z-10 flex items-center gap-2 rounded bg-[#0b1220]/90 px-2 py-1 text-[11px] text-bad" data-vt-failed={failedTiles}>
          {failedTiles} failed tile{failedTiles === 1 ? "" : "s"}
          {retryingTiles ? " · retrying with back-off" : ""}
          <button type="button" onClick={() => setVtRetry((n) => n + 1)} className="underline hover:text-white">
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// charts: Gantt, Heat grid, Tree map
// ------------------------------------------------------------------------------------------------

function Gantt({ p, set }: { p: P; set: Set }) {
  const ys = arr(p.yValues).map(s);
  const starts = arr(p.startValues).map((v) => new Date(s(v)).getTime());
  const ends = arr(p.endValues).map((v) => new Date(s(v)).getTime());
  const labels = arr(p.labels);
  const series = arr(p.seriesValues).map(s);
  const ok = ys.map((_, i) => Number.isFinite(starts[i]) && Number.isFinite(ends[i]));
  if (!ys.length || !ok.some(Boolean)) return <Empty text="Set yValues, startValues and endValues (same length)" />;
  const rows = [...new Set(ys)];
  const kinds = [...new Set(series)];
  const colors = arr(p.seriesColors).map(s);
  const lo = Math.min(...starts.filter((_, i) => ok[i]));
  const hi = Math.max(...ends.filter((_, i) => ok[i]));
  const span = hi - lo || 1;
  const W = 1000;
  const left = 150;
  const rowH = 26;
  const H = rows.length * rowH + 24;
  const x = (t: number) => left + ((t - lo) / span) * (W - left - 10);
  const ticks = Array.from({ length: 6 }, (_, k) => lo + (span * k) / 5);
  return (
    <div className="h-full overflow-auto" data-gantt>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: Math.min(H, 600) }} preserveAspectRatio="xMinYMin meet">
        {ticks.map((t, k) => (
          <g key={k}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={H - 20} stroke="var(--color-line)" strokeWidth={1} />
            <text x={x(t)} y={H - 6} textAnchor={k === 0 ? "start" : k === 5 ? "end" : "middle"} className="fill-muted text-[11px]">
              {new Date(t).toISOString().slice(0, span < 3 * 86400000 ? 16 : 10).replace("T", " ")}
            </text>
          </g>
        ))}
        {rows.map((r, k) => (
          <text key={r} x={4} y={k * rowH + 17} className="fill-soft text-[12px]">
            {r.length > 20 ? `${r.slice(0, 19)}…` : r}
          </text>
        ))}
        {ys.map((y, i) => {
          if (!ok[i]) return null;
          const on = p.selectedIndex === i;
          const c = colors[kinds.indexOf(series[i])] || PALETTE[Math.max(0, kinds.indexOf(series[i])) % PALETTE.length];
          const w = Math.max(3, x(ends[i]) - x(starts[i]));
          return (
            <g key={i} className={p.dataSelectionEnabled === false ? "" : "cursor-pointer"} onClick={() => p.dataSelectionEnabled !== false && set({ selectedIndex: on ? null : i }, "selected", i)} data-gantt-bar={i}>
              <rect x={x(starts[i])} y={rows.indexOf(y) * rowH + 4} width={w} height={rowH - 8} rx={4} fill={c} stroke={on ? "#fff" : "none"} strokeWidth={2} />
              <title>{`${s(labels[i]) || y}: ${new Date(starts[i]).toISOString().slice(0, 16)} → ${new Date(ends[i]).toISOString().slice(0, 16)}`}</title>
              {!!p.labelsEnabled && s(labels[i]) && w > 40 && (
                <text x={x(starts[i]) + 5} y={rows.indexOf(y) * rowH + 17} className="pointer-events-none fill-white text-[11px]">
                  {s(labels[i])}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {!!p.legendEnabled && kinds.filter(Boolean).length > 0 && (
        <div className="flex flex-wrap gap-3 px-1 text-[11px] text-soft">
          {kinds.map((k, i) => (
            <span key={k} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm" style={{ background: colors[i] || PALETTE[i % PALETTE.length] }} /> {k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A number in a Numeral.js-like format ($0,0.00, 0.0%, 0a). */
export function numeral(v: number, format: string): string {
  if (!format) return Number.isInteger(v) ? String(v) : v.toFixed(2);
  const pct = format.includes("%");
  const dec = (format.split(".")[1] ?? "").replace(/[^0]/g, "").length;
  const pre = (format.match(/^[^0#,.]+/) ?? [""])[0];
  if (/a/.test(format)) return `${pre}${Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: dec }).format(v)}`;
  const n = (pct ? v * 100 : v).toLocaleString("en", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: format.includes(",") });
  return `${pre}${n}${pct ? "%" : ""}`;
}

function HeatGrid({ p, set }: { p: P; set: Set }) {
  const xs = arr(p.xValues);
  const ys = arr(p.yValues);
  const vs = arr(p.cellValues).map((v) => num(v, NaN));
  if (!xs.length || !vs.length) return <Empty text="Set xValues, yValues and cellValues (same length)" />;
  const cols = [...new Set(xs.map(s))];
  const rows = [...new Set(ys.map(s))];
  const fin = vs.filter(Number.isFinite);
  const [lo, hi] = [Math.min(...fin), Math.max(...fin)];
  const scale = arr(p.colorScale).map(s);
  const sel = obj(p.selection);
  const chosen = arr(sel.indices).map(Number);
  const pick = (i: number, multi: boolean) => {
    if (!p.selectionEnabled) return;
    const next = multi && s(p.selectionMode).toLowerCase() === "multiple" ? (chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i]) : chosen.length === 1 && chosen[0] === i ? [] : [i];
    const out = { indices: next, cellValues: next.map((k) => vs[k]), xValues: next.map((k) => xs[k]), yValues: next.map((k) => ys[k]) };
    set({ selection: out }, "selectionChanged", out);
  };
  const cell = new Map(xs.map((x, i) => [`${s(x)}|${s(ys[i])}`, i]));
  return (
    <div className="flex h-full flex-col overflow-auto text-xs" data-heatgrid>
      {s(p.title) && <div className="mb-1 font-semibold">{s(p.title)}</div>}
      <div className="grid min-h-0 flex-1 gap-px" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(28px, 1fr))`, gridTemplateRows: `repeat(${rows.length}, minmax(20px, 1fr)) auto` }}>
        {rows.map((r) => (
          <div key={r} className="contents">
            <div className="flex items-center pr-2 text-muted">{obj(p.yAxis).visible === false ? "" : r}</div>
            {cols.map((c) => {
              const i = cell.get(`${c}|${r}`);
              const v = i === undefined ? NaN : vs[i];
              const on = i !== undefined && chosen.includes(i);
              return (
                <button
                  key={c}
                  type="button"
                  disabled={i === undefined}
                  onClick={(e) => i !== undefined && pick(i, e.ctrlKey || e.metaKey)}
                  title={`${c} · ${r}${Number.isFinite(v) ? `: ${v}` : ""}`}
                  className={`flex items-center justify-center rounded-sm text-[10px] ${on ? "ring-2 ring-white" : ""} ${p.selectionEnabled ? "cursor-pointer" : "cursor-default"}`}
                  style={{ background: Number.isFinite(v) ? scaleColor(scale, hi === lo ? 0.5 : (v - lo) / (hi - lo)) : "transparent", color: "#0b1220" }}
                  data-heat-cell={i}
                >
                  {p.labelsEnabled && Number.isFinite(v) ? numeral(v, s(p.labelFormat)) : ""}
                </button>
              );
            })}
          </div>
        ))}
        <div />
        {cols.map((c) => (
          <div key={c} className="truncate pt-0.5 text-center text-muted">{obj(p.xAxis).visible === false ? "" : c}</div>
        ))}
      </div>
      {s(p.legendPosition) && Number.isFinite(lo) && (
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
          {s(p.legendLabel)} {lo}
          <span className="h-2 w-24 rounded" style={{ background: `linear-gradient(to right, ${(scale.length >= 2 ? scale : ["#B9D7EA", "#1F6B9A"]).join(",")})` }} />
          {hi}
        </div>
      )}
    </div>
  );
}

type Rect = { x: number; y: number; w: number; h: number };
/** Squarified tree map: rectangles with areas proportional to `sizes`, as close to squares as the order allows. */
export function squarify(sizes: number[], box: Rect): Rect[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  const out: Rect[] = new Array(sizes.length);
  if (!total || box.w <= 0 || box.h <= 0) return sizes.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const order = sizes.map((v, i) => i).filter((i) => sizes[i] > 0).sort((a, b) => sizes[b] - sizes[a]);
  const area = (i: number) => (sizes[i] / total) * box.w * box.h;
  let { x, y, w, h } = box;
  let row: number[] = [];
  const worst = (r: number[], side: number) => {
    const sum = r.reduce((a, i) => a + area(i), 0);
    const mx = Math.max(...r.map(area));
    const mn = Math.min(...r.map(area));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  const flush = () => {
    const sum = row.reduce((a, i) => a + area(i), 0);
    if (w >= h) {
      const rw = sum / h;
      let yy = y;
      for (const i of row) {
        out[i] = { x, y: yy, w: rw, h: area(i) / rw };
        yy += area(i) / rw;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = sum / w;
      let xx = x;
      for (const i of row) {
        out[i] = { x: xx, y, w: area(i) / rh, h: rh };
        xx += area(i) / rh;
      }
      y += rh;
      h -= rh;
    }
    row = [];
  };
  for (const i of order) {
    const side = Math.min(w, h);
    if (row.length && worst([...row, i], side) > worst(row, side)) flush();
    row.push(i);
  }
  if (row.length) flush();
  for (let i = 0; i < sizes.length; i++) out[i] ??= { x: box.x, y: box.y, w: 0, h: 0 };
  return out;
}

function TreeMap({ p, set }: { p: P; set: Set }) {
  const sizes = arr(p.sizes).map((v) => Math.max(0, num(v, 0)));
  const labels = arr(p.labels);
  const cats = arr(p.categories).map(s);
  const dens = arr(p.densities).map((v) => num(v, NaN));
  if (!sizes.some((v) => v > 0)) return <Empty text="Set sizes (and labels, categories, densities)" />;
  const W = 1000;
  const H = 600;
  const kinds = [...new Set(cats)];
  // categories get their own boxes (sized by their total), cells are laid out inside
  const groups = kinds.length ? kinds : [""];
  const gsize = groups.map((g) => sizes.reduce((a, v, i) => a + (kinds.length && cats[i] !== g ? 0 : v), 0));
  const gbox = squarify(gsize, { x: 0, y: 0, w: W, h: H });
  const rects: (Rect & { i: number })[] = [];
  groups.forEach((g, k) => {
    const idx = sizes.map((_, i) => i).filter((i) => !kinds.length || cats[i] === g);
    squarify(idx.map((i) => sizes[i]), gbox[k]).forEach((r, j) => rects.push({ ...r, i: idx[j] }));
  });
  const fin = dens.filter(Number.isFinite);
  const [lo, hi] = [Math.min(...fin), Math.max(...fin)];
  const catColors = p.categoryColors && !Array.isArray(p.categoryColors) ? obj(p.categoryColors) : null;
  const catList = arr(Array.isArray(p.categoryColors) ? p.categoryColors : []).map(s);
  const densColors = arr(p.densityColors).map(s);
  const color = (i: number) => {
    const t = Number.isFinite(dens[i]) && hi !== lo ? (dens[i] - lo) / (hi - lo) : 0.5;
    const k = Math.max(0, kinds.indexOf(cats[i]));
    const base = (catColors ? s(catColors[cats[i]]) : catList[k]) || PALETTE[k % PALETTE.length];
    if (!fin.length) return base;
    // density only: a gradient; with categories: the category's color from dark (low) to light (high)
    if (!kinds.length) return scaleColor(densColors.length >= 2 ? densColors : ["#1e3a8a", "#bfdbfe"], p.flipGradient ? 1 - t : t);
    return scaleColor(["#0b1220", base, "#ffffff"], 0.25 + (p.flipGradient ? 1 - t : t) * 0.5);
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none" data-treemap>
      {rects.map((r) => {
        const on = p.selectedIndex === r.i;
        return (
          <g key={r.i} className="cursor-pointer" onClick={() => set({ selectedIndex: on ? null : r.i, selectedLabel: on ? null : (labels[r.i] ?? null) }, "selected", labels[r.i] ?? r.i)} data-treemap-cell={r.i}>
            <rect x={r.x + 1} y={r.y + 1} width={Math.max(0, r.w - 2)} height={Math.max(0, r.h - 2)} fill={color(r.i)} stroke={on ? "#fff" : "#0b1220"} strokeWidth={on ? 4 : 1} vectorEffect="non-scaling-stroke" />
            <title>{`${s(labels[r.i])}${cats[r.i] ? ` · ${cats[r.i]}` : ""}: ${sizes[r.i]}${Number.isFinite(dens[r.i]) ? ` (density ${dens[r.i]})` : ""}`}</title>
            {r.w > 70 && r.h > 34 && (
              <text x={r.x + 8} y={r.y + 24} className="pointer-events-none text-[20px]" fill="#fff" style={{ paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 }}>
                {s(labels[r.i])}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------
// platform: resource selector, time series
// ------------------------------------------------------------------------------------------------

/** No visual on the page: the `open` action shows the Files browser; picking a resource sets selectedRid. */
function ResourceSelector({ w, p, rt, set }: { w: SlateWidget; p: P; rt: SlateRuntime; set: Set }) {
  const open = !!p.open;
  const [folder, setFolder] = useState<string | null>(null);
  const [items, setItems] = useState<DriveItem[] | null>(null);
  const [here, setHere] = useState<DriveItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    api.drive.folder(folder).then(
      (f) => !stale && (setItems(f.items), setHere(f.folder), setError(null)),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [open, folder]);
  const close = () => {
    set({ open: false });
    rt.fire(`${w.id}.didClose`, null);
  };
  const filter = arr(p.allowedTypes).map(s);
  if (!open) return rt.opts.isEditMode ? <Empty text="Resource selector (no visual): trigger its open action" /> : null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4" onMouseDown={close} data-resource-selector>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-line-2 bg-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm font-semibold">
          <Icon name="folder" className="h-4 w-4 text-ocean" />
          <span className="flex-1 truncate">{s(p.title) || "Select a resource"}{here ? ` · ${here.name}` : ""}</span>
          <button type="button" onClick={close} className="text-muted hover:text-white" aria-label="Close">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2 text-sm">
          {here && (
            <button type="button" onClick={() => setFolder(here.parent_id ?? null)} className="mb-1 block w-full rounded px-2 py-1 text-left text-muted hover:bg-panel-2">
              ← Up
            </button>
          )}
          {error && <p className="p-2 text-bad">{error}</p>}
          {!items && !error && <p className="p-2 text-muted">Loading…</p>}
          {items?.map((i) => {
            const container = i.kind === "folder" || i.kind === "project";
            const allowed = container || !filter.length || filter.some((t) => (i.content_type ?? "").includes(t) || i.name.endsWith(t));
            return (
              <button
                key={i.id}
                type="button"
                disabled={!allowed}
                onClick={() => {
                  if (container) return setFolder(i.id);
                  set({ selectedRid: i.id, selectedName: i.name, open: false });
                  rt.fire(`${w.id}.selectedRid.changed`, i.id);
                  rt.fire(`${w.id}.didClose`, null);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2 disabled:opacity-40"
                data-resource={i.id}
              >
                <Icon name={container ? "folder" : "doc"} className="h-3.5 w-3.5 text-muted" />
                <span className="truncate">{i.name}</span>
              </button>
            );
          })}
          {items && !items.length && <p className="p-2 text-muted">Empty.</p>}
        </div>
      </div>
    </div>
  );
}

/** Series of a time series sync by Series ID, in one chart; a time range, a unit and colors; streaming polls. */
function TimeSeries({ p }: { p: P }) {
  const ids = arr(p.seriesIds).map(s).filter(Boolean);
  const sync = s(p.syncId);
  const range = obj(p.timeRange);
  const [series, setSeries] = useState<ChartSeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const streaming = !!p.streaming;
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setTick((n) => n + 1), Math.max(2, num(p.streamingIntervalSeconds, 5)) * 1000);
    return () => clearInterval(t);
  }, [streaming, p.streamingIntervalSeconds]);
  const spec = JSON.stringify([sync, ids, range, p.colors, p.unit, tick]);
  useEffect(() => {
    if (!sync || !ids.length) return;
    let stale = false;
    const colors = arr(p.colors).map(s);
    const names = arr(p.seriesNames);
    Promise.all(ids.map((id, i) => timeseries.points(sync, id, { start: s(range.start) || undefined, end: s(range.end) || undefined, buckets: 400 }).then((r) => ({ key: id, label: s(names[i]) || id, unit: s(p.unit) || null, points: r.points, color: colors[i] || undefined }))))
      .then((x) => !stale && (setSeries(x), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
    // spec holds every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  if (!sync || !ids.length) return <Empty text="Set syncId (a time series sync) and seriesIds" />;
  if (error) return <div className="p-2 text-xs text-bad">{error}</div>;
  return (
    <div className="flex h-full flex-col" data-slate-timeseries>
      {s(p.title) && <div className="px-1 text-sm font-semibold">{s(p.title)}{streaming && <span className="ml-2 text-[10px] font-normal text-ok">● streaming</span>}</div>}
      <div className="min-h-0 flex-1 overflow-hidden">
        <TsChart series={series} height={220} />
      </div>
    </div>
  );
}
