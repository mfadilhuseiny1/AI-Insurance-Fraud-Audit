/** Pure geometry for the interactive Slate widgets: the Graph's camera (pan / zoom over the fitted view) and the
 *  Calendar's drag-selected day / time ranges and hour-grid layout. No React and no DOM, so it can be tested on its own. */

/** Slate's graph camera: the view's center in graph coordinates and its size relative to the fitted view
 *  (ratio 1 = everything fits, 0.5 = zoomed in twice). Nulls mean "fit". */
export type Camera = { x: number | null; y: number | null; ratio: number | null };
export type Box = [number, number, number, number]; // x, y, width, height

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The box around all points, padded on every side. */
export function fitBox(points: { x: number; y: number }[], pad: number): Box {
  if (!points.length) return [-pad, -pad, pad * 2, pad * 2];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  return [x0 - pad, y0 - pad, Math.max(...xs) - x0 + pad * 2, Math.max(...ys) - y0 + pad * 2];
}

/** The zoom scales allowed by zoomScaleRange ([min, max], scale = 1 / ratio). */
export function scaleRange(range: unknown): [number, number] {
  const r = Array.isArray(range) ? range.map(Number) : [];
  const lo = finite(r[0]) && r[0] > 0 ? r[0] : 0.1;
  const hi = finite(r[1]) && r[1] >= lo ? r[1] : Math.max(lo, 10);
  return [lo, hi];
}

/** A camera with its nulls filled from the fitted box and its ratio kept inside the allowed zoom range. */
export function resolveCamera(cam: Partial<Camera> | null | undefined, fit: Box, range?: unknown): { x: number; y: number; ratio: number } {
  const [lo, hi] = scaleRange(range);
  const ratio = finite(cam?.ratio) && cam!.ratio! > 0 ? cam!.ratio! : 1;
  return {
    x: finite(cam?.x) ? cam!.x! : fit[0] + fit[2] / 2,
    y: finite(cam?.y) ? cam!.y! : fit[1] + fit[3] / 2,
    ratio: Math.min(1 / lo, Math.max(1 / hi, ratio)),
  };
}

/** The SVG viewBox a camera shows. */
export function cameraViewBox(cam: Partial<Camera> | null | undefined, fit: Box, range?: unknown): Box {
  const c = resolveCamera(cam, fit, range);
  const [w, h] = [fit[2] * c.ratio, fit[3] * c.ratio];
  return [c.x - w / 2, c.y - h / 2, w, h];
}

/** Zoom by `factor` (> 1 zooms in) keeping the graph point `at` under the pointer. */
export function zoomCamera(cam: Partial<Camera> | null | undefined, fit: Box, factor: number, at: { x: number; y: number } | null, range?: unknown) {
  const c = resolveCamera(cam, fit, range);
  const next = resolveCamera({ ...c, ratio: c.ratio / (factor > 0 ? factor : 1) }, fit, range);
  const k = next.ratio / c.ratio;
  const p = at ?? { x: c.x, y: c.y };
  return { x: p.x - (p.x - c.x) * k, y: p.y - (p.y - c.y) * k, ratio: next.ratio };
}

/** Move the view by a drag of (dx, dy) graph units (the content follows the pointer). */
export function panCamera(cam: Partial<Camera> | null | undefined, fit: Box, dx: number, dy: number, range?: unknown) {
  const c = resolveCamera(cam, fit, range);
  return { x: c.x - dx, y: c.y - dy, ratio: c.ratio };
}

/** Graph units per screen pixel for a viewBox drawn with preserveAspectRatio "meet" in a w x h element. */
export function unitsPerPixel(view: Box, w: number, h: number): number {
  return Math.max(view[2] / Math.max(1, w), view[3] / Math.max(1, h));
}

/** Labels hide when the zoom scale (1 / ratio) is below hideLabelsScale. */
export function labelsHidden(ratio: number, hideLabelsScale: unknown): boolean {
  const t = Number(hideLabelsScale);
  return Number.isFinite(t) && t > 0 && 1 / ratio < t;
}

/** A local calendar day as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The day range between two days picked in either order: start and end (inclusive) as YYYY-MM-DD, and its length. */
export function dayRange(a: Date, b: Date): { start: string; end: string; days: number } {
  const [x, y] = [new Date(a.getFullYear(), a.getMonth(), a.getDate()), new Date(b.getFullYear(), b.getMonth(), b.getDate())];
  const [lo, hi] = x.getTime() <= y.getTime() ? [x, y] : [y, x];
  // count calendar days (not 24 h blocks, which daylight saving would skew)
  const days = Math.round((Date.UTC(hi.getFullYear(), hi.getMonth(), hi.getDate()) - Date.UTC(lo.getFullYear(), lo.getMonth(), lo.getDate())) / 86400000) + 1;
  return { start: dayKey(lo), end: dayKey(hi), days };
}

/** Whether day d falls inside a range from dayRange (inclusive days) or timeRange (end exclusive). */
export function inDayRange(d: Date, r: { start: string; end: string } | null | undefined): boolean {
  if (!r) return false;
  const k = dayKey(d);
  if (isTimed(r)) {
    const [a, b] = [new Date(r.start), new Date(r.end)];
    return !Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime()) && overlapsDay(a, b, d);
  }
  return k >= r.start.slice(0, 10) && k <= r.end.slice(0, 10);
}

// ------------------------------------------------------------------------------------------------
// calendar hour grid (the week / day views with viewType "Time")
// ------------------------------------------------------------------------------------------------

export const DAY_MINUTES = 1440;
const pad2 = (n: number) => String(n).padStart(2, "0");
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const nextMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

/** A local time as YYYY-MM-DDTHH:mm (the form the calendar's eventStarts / eventEnds take). */
export function localStamp(d: Date): string {
  return `${dayKey(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Whether a selected range carries times (from timeRange) rather than whole days. */
export function isTimed(r: { start: string; allDay?: unknown } | null | undefined): boolean {
  return !!r && r.allDay !== true && /T\d/.test(String(r.start));
}

/** Whether [start, end) touches the local day d (an instant event counts on the day it happens; an event ending
 *  exactly at midnight does not reach the next day). */
export function overlapsDay(start: Date, end: Date, d: Date): boolean {
  const [lo, hi] = [midnight(d).getTime(), nextMidnight(d).getTime()];
  const [a, b] = [start.getTime(), Math.max(start.getTime(), end.getTime())];
  return a < hi && (b > lo || a >= lo);
}

/** All-day events snap to whole days: start and end round down to midnight (Slate: "January 1st 03:00" to
 *  "January 3rd 03:00" becomes "January 1st 00:00" to "January 3rd 00:00"), end exclusive, at least one day. */
export function allDayBounds(start: Date, end: Date): { start: Date; end: Date } {
  const a = midnight(start);
  const b = midnight(end);
  return { start: a, end: b.getTime() > a.getTime() ? b : nextMidnight(a) };
}

/** Wall-clock minutes since midnight. */
const wall = (d: Date) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;

/** The part of [start, end) inside local day d, in minutes from its midnight (0..1440), or null if none. */
export function daySegment(start: Date, end: Date, d: Date): { top: number; bottom: number } | null {
  if (!overlapsDay(start, end, d)) return null;
  const [lo, hi] = [midnight(d).getTime(), nextMidnight(d).getTime()];
  const top = start.getTime() <= lo ? 0 : wall(start);
  const bottom = end.getTime() >= hi ? DAY_MINUTES : Math.max(top, wall(end));
  return { top, bottom };
}

export type Placed = { i: number; top: number; bottom: number; col: number; cols: number };

/** Side-by-side columns for overlapping events in one day. Events that overlap (directly or through others) form a
 *  cluster sharing one column count; each takes the first column free at its start. `minLength` is the shortest
 *  drawn height in minutes, so short events that touch on screen also get their own column. */
export function layoutDay(items: { i: number; top: number; bottom: number }[], minLength = 0): Placed[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.i - b.i);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length;
    cluster = [];
    colEnds = [];
    clusterEnd = -Infinity;
  };
  for (const it of sorted) {
    const end = Math.max(it.bottom, it.top + minLength);
    if (cluster.length && it.top >= clusterEnd) flush();
    let col = colEnds.findIndex((e) => e <= it.top);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(end);
    } else colEnds[col] = end;
    const p: Placed = { i: it.i, top: it.top, bottom: it.bottom, col, cols: 1 };
    cluster.push(p);
    out.push(p);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}

/** The slot (minutes from midnight, floored to `slot`) under a point y pixels down a day column of hourPx per hour
 *  whose top is `startMin` past midnight; kept inside [startMin, endMin - slot]. */
export function slotAt(y: number, hourPx: number, slot: number, startMin = 0, endMin = DAY_MINUTES): number {
  const m = startMin + Math.floor(((y / hourPx) * 60) / slot) * slot;
  return Math.max(startMin, Math.min(endMin - slot, m));
}

/** A day segment (minutes from midnight) clipped to the shown hours [startMin, endMin) and made relative to startMin,
 *  or null when it lies outside them. An instant at the range's start still shows. */
export function clipSegment(seg: { top: number; bottom: number }, startMin: number, endMin: number): { top: number; bottom: number } | null {
  if (seg.top >= endMin || seg.bottom < startMin || (seg.bottom === startMin && seg.top < startMin)) return null;
  const top = Math.max(seg.top, startMin);
  return { top: top - startMin, bottom: Math.max(top, Math.min(seg.bottom, endMin)) - startMin };
}

/** The calendar's display settings, read leniently from the widget's properties: hourStart / hourEnd (the hours the
 *  grid shows, 0..24, at least one hour), slotMinutes (the snap for drag-to-create: a divisor of 60, default 30),
 *  firstDayOfWeek (0 = Sunday .. 6, or a weekday name; default Sunday as in Slate) and timeZone ("local" or "UTC"). */
export function calendarSettings(p: Record<string, unknown>): { startHour: number; endHour: number; slot: number; firstDay: number; utc: boolean } {
  const int = (v: unknown, d: number) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Math.trunc(Number(v)));
  let startHour = Math.max(0, Math.min(23, int(p.hourStart, 0)));
  let endHour = Math.max(1, Math.min(24, int(p.hourEnd, 24)));
  if (endHour <= startHour) [startHour, endHour] = [0, 24];
  const slot = int(p.slotMinutes, 30);
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const fd = String(p.firstDayOfWeek ?? "").trim().toLowerCase();
  const byName = names.indexOf(fd.slice(0, 3));
  const firstDay = byName >= 0 && /^[a-z]/.test(fd) ? byName : ((int(p.firstDayOfWeek, 0) % 7) + 7) % 7;
  return { startHour, endHour, slot: [5, 10, 15, 20, 30, 60].includes(slot) ? slot : 30, firstDay, utc: String(p.timeZone ?? "").trim().toUpperCase() === "UTC" };
}

/** The first day of the week containing d, weeks starting on firstDay (0 = Sunday). */
export function weekStart(d: Date, firstDay = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() - firstDay + 7) % 7));
}

/** The calendar works in wall-clock time: Dates whose local fields are the times shown. In UTC mode an instant becomes
 *  the Date whose local fields are its UTC fields (toWall), and back (fromWall). In local mode both are the identity. */
export function toWall(d: Date, utc: boolean): Date {
  return utc ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()) : d;
}
export function fromWall(d: Date, utc: boolean): Date {
  return utc ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())) : d;
}

/** An event time as wall clock: a time without a zone ("2026-10-12T09:00", "2026-10-14") is read as written (in the
 *  calendar's zone: local or UTC); one with a zone ("…Z", "…+07:00") or a number (epoch ms) is an instant shown in the
 *  calendar's zone. Invalid input gives an invalid Date. */
export function parseWall(v: unknown, utc: boolean): Date {
  if (typeof v === "number") return toWall(new Date(v), utc);
  const t = String(v ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/.exec(t);
  if (m) {
    const [, y, mo, da, h, mi, se, ms] = m;
    return new Date(+y, +mo - 1, +da, +(h ?? 0), +(mi ?? 0), +(se ?? 0), ms ? +ms.padEnd(3, "0") : 0);
  }
  const d = t ? new Date(t) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? d : toWall(d, utc);
}

/** Day d at `minutes` past midnight (local wall clock). */
export function atMinutes(d: Date, minutes: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes);
}

export type TimeRange = { start: string; end: string; days: number; allDay: false; minutes: number; startIso: string; endIso: string; timeZone: "local" | "UTC" };

/** The time range dragged between two slot starts (wall-clock Dates), picked in either order: from the earlier slot's
 *  start to the end of the later slot (end exclusive), as wall-clock times in the calendar's zone (start / end), ISO
 *  instants (startIso / endIso), its length in minutes and the days it touches. */
export function timeRange(a: Date, b: Date, slot: number, utc = false): TimeRange {
  const [lo, last] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
  const hi = new Date(last.getFullYear(), last.getMonth(), last.getDate(), last.getHours(), last.getMinutes() + slot);
  return {
    start: localStamp(lo),
    end: localStamp(hi),
    days: dayRange(lo, new Date(hi.getTime() - 1)).days,
    allDay: false,
    // wall-clock minutes (a DST change inside the range does not stretch it in UTC mode)
    minutes: Math.round((fromWall(hi, utc).getTime() - fromWall(lo, utc).getTime()) / 60000),
    startIso: fromWall(lo, utc).toISOString(),
    endIso: fromWall(hi, utc).toISOString(),
    timeZone: utc ? "UTC" : "local",
  };
}

/** The hour the grid first scrolls to: the working day's start, or earlier when an event in view starts before it,
 *  never before the first hour shown. */
export function scrollHour(startMinutes: number[], workStart = 8, firstHour = 0): number {
  const first = startMinutes.filter((m) => Number.isFinite(m)).reduce((x, m) => Math.min(x, m), Infinity);
  return Math.max(firstHour, Math.min(workStart, Number.isFinite(first) ? Math.floor(first / 60) : workStart));
}
