"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { ActionForm } from "@/components/ontology/ActionForm";
import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import type { ActionParam } from "@/lib/actions";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { filterSets, sourceKey, type Module, type OsFilter, type ProgramLayerConfig, type Variable, type Widget, type WidgetConfig, type WsEvent } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

// Workshop's Program Scheduling widget (palantir.com/docs/foundry/dynamic-scheduling/program-scheduling-overview,
// program-scheduling-configuration): programs, projects and tasks on a timeline. Data layers (an object type's objects,
// or an object set variable's) are drawn as standard pucks (bars, with dependency arrows), background pucks (shaded
// periods, read-only) or event pucks (milestones: points in time). The rows are a hierarchical table of collapsible
// groups (grouping properties) whose rows roll up their tasks (earliest start → latest end, count, late, progress).
// Dragging or resizing a puck is planned on the server (api/dynamic_scheduling.py /program/*) with the dependency
// check of the widget (warn, block, or push the later tasks); the moves wait for "Save changes" (the layer's save
// handler action), or are staged at once in the scenario a scenario variable holds. Selection → output variables.

const ROW_H = 30;
const LABEL_W = 240;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PALETTE = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#60a5fa"];
const ms = (iso: string) => new Date(iso).getTime();
const iso = (t: number) => new Date(t).toISOString();
const pkFilter = (pks: string[]): OsFilter => ({ filters: [{ column: "__pk", op: "in", value: pks }], mode: "all" });
const NO_FILTER: OsFilter = { filters: [], mode: "all" };

// ------------------------------------------------------------------------------------------------
// time: wall-clock days in the viewer's time zone or in UTC
// ------------------------------------------------------------------------------------------------

function wall(t: number, utc: boolean) {
  const x = new Date(t);
  return utc ? { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), dow: x.getUTCDay() } : { y: x.getFullYear(), m: x.getMonth(), d: x.getDate(), dow: x.getDay() };
}
const at = (y: number, m: number, d: number, utc: boolean) => (utc ? Date.UTC(y, m, d) : new Date(y, m, d).getTime());
const dayStart = (t: number, utc: boolean, plus = 0) => {
  const w = wall(t, utc);
  return at(w.y, w.m, w.d + plus, utc);
};
const zone = (utc: boolean) => (utc ? "UTC" : undefined);
const fmtDay = (t: number, utc: boolean) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: zone(utc) });
const fmtTime = (t: number, utc: boolean) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: zone(utc) });
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

// ------------------------------------------------------------------------------------------------
// the API (api/dynamic_scheduling.py, /api/scheduling/program/*)
// ------------------------------------------------------------------------------------------------

type PuckType = ProgramLayerConfig["puck_type"];
type ApiLayer = {
  id: string;
  name: string;
  object_type_id: string;
  puck_type: PuckType;
  start_property: string;
  end_property: string | null;
  dependency_property: string | null;
  label_property: string | null;
  progress_property: string | null;
  save_action_id: string | null;
  color: string | null;
  color_rules: NonNullable<ProgramLayerConfig["color_rules"]>;
  primary_keys?: string[];
  filter_sets: OsFilter[];
};
type Violation = { kind: "predecessor" | "successor" | "missing" | "cycle"; other: string | null; details: string };
type Item = {
  key: string;
  layer: string;
  id: string;
  object_type_id: string;
  kind: PuckType;
  title: string;
  start: string | null;
  end: string | null;
  edited: boolean;
  deps: string[];
  dependents: string[];
  progress: number | null;
  properties: Record<string, unknown>;
  violations: Violation[];
  color: string | null;
  group: string | null;
};
type GroupRow = { key: string; label: string; property: string; depth: number; children: GroupRow[]; items: string[]; count: number; start: string | null; end: string | null; late: number; edited: number; progress: number | null };
type LayerInfo = { id: string; name: string; kind: PuckType; object_type_id: string; object_type: string; start_type: string; end_type: string | null; editable: boolean; dependency_property: string | null };
type ProgramData = { layers: LayerInfo[]; items: Item[]; links: { from: string; to: string; ok: boolean }[]; groups: GroupRow[]; root_items: string[]; warnings: string[]; late: number; edited: number };
type Span = { start: string | null; end: string | null };
type Change = { layer: string; primary_key: string; title: string; key: string; before: Span; after: Span };
type Plan = { changes: Change[]; conflicts: (Violation & { key: string; title: string })[]; refused: string | null };
type Edit = { layer: string; primary_key: string; start: string | null; end: string | null };

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/scheduling/program${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}
const program = {
  data: (body: { layers: ApiLayer[]; grouping: { property: string; descending: boolean }[]; edits: Edit[]; scenario_id: string | null }) => post<ProgramData>("/data", body),
  plan: (body: { layers: ApiLayer[]; edits: Edit[]; scenario_id: string | null; layer: string; primary_key: string; start: string; end: string | null; mode: "warn" | "block" | "push" }) => post<Plan>("/plan", body),
  save: (body: { layers: ApiLayer[]; edits: Edit[]; scenario_id: string | null }) => post<{ saved: number }>("/save", body),
};

const HEX = /^#[0-9a-fA-F]{6}$/;
/** A configured layer as the API takes it: its object set from the variables. */
function toApiLayer(l: ProgramLayerConfig, vars: Record<string, unknown>): ApiLayer {
  let keys: string[] | undefined;
  if (l.object_set_variable) {
    const v = vars[l.object_set_variable];
    // an object set / array variable holds primary keys; a string variable one or several (comma-separated)
    keys = Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  return {
    id: l.id,
    name: l.name ?? "",
    object_type_id: l.object_type_id,
    puck_type: l.puck_type,
    start_property: l.start_property,
    end_property: l.puck_type === "event" ? null : (l.end_property ?? null),
    dependency_property: l.puck_type === "standard" ? (l.dependency_property ?? null) : null,
    label_property: l.label_property ?? null,
    progress_property: l.puck_type === "standard" ? (l.progress_property ?? null) : null,
    save_action_id: l.puck_type === "background" ? null : (l.save_action_id ?? null),
    color: l.color && HEX.test(l.color) ? l.color : null,
    color_rules: (l.color_rules ?? []).filter((r) => r.name && HEX.test(r.color)).map((r) => ({ ...r, enabled: r.enabled !== false })),
    ...(keys ? { primary_keys: keys } : {}),
    filter_sets: l.filter_variable ? filterSets({ filter_variables: [l.filter_variable] }, vars) : [],
  };
}

// ------------------------------------------------------------------------------------------------
// the timeline axis
// ------------------------------------------------------------------------------------------------

type Axis = { months: { t: number; label: string }[]; ticks: { t: number; label: string }[]; unit: "day" | "week" | "month" };
function axisOf(t0: number, t1: number, width: number, utc: boolean): Axis {
  const dayPx = width / Math.max(1, (t1 - t0) / DAY);
  const unit = dayPx >= 22 ? "day" : dayPx * 7 >= 34 ? "week" : "month";
  const months: Axis["months"] = [];
  const ticks: Axis["ticks"] = [];
  let n = 0;
  for (let d = dayStart(t0, utc); d < t1 && n < 5000; d = dayStart(d, utc, 1), n++) {
    const w = wall(d, utc);
    if (w.d === 1 || d <= t0) months.push({ t: Math.max(d, t0), label: new Date(Math.max(d, t0)).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: zone(utc) }) });
    if (d < t0) continue;
    if (unit === "day") ticks.push({ t: d, label: String(w.d) });
    else if (unit === "week" && w.dow === 1) ticks.push({ t: d, label: new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: zone(utc) }) });
    else if (unit === "month" && w.d === 1) ticks.push({ t: d, label: "" });
  }
  return { months, ticks, unit };
}

/** The snap of a drag: hours or days in the widget's time zone; a layer storing dates snaps to whole (UTC) days. */
function snapper(unit: WidgetConfig["ps_snap"], utc: boolean) {
  return (t: number, dates: boolean) => {
    if (dates || (unit ?? "1d") === "1d") {
      const u = dates || utc;
      const a = dayStart(t, u);
      const b = dayStart(t, u, 1);
      return t - a < b - t ? a : b;
    }
    if (unit === "1h") return Math.round(t / HOUR) * HOUR;
    return Math.round(t / 60_000) * 60_000;
  };
}

// ------------------------------------------------------------------------------------------------
// the widget
// ------------------------------------------------------------------------------------------------

type Note = { text: string; bad: boolean };
type Pending = Record<string, { layer: string; primary_key: string; title: string; before: Span; after: Span }>;
type LogEntry = { id: number; title: string; changes: Change[]; undone?: boolean };
type VRow = { kind: "group"; g: GroupRow; depth: number } | { kind: "item"; it: Item; depth: number };
type Drag = { key: string; mode: "move" | "start" | "end"; sx: number; moved: boolean };
type MenuItem = { label: string; run: () => void; disabled?: boolean; hint?: string };
type Dialog = { actionId: string; item: Item; label: string };

const sameSpan = (a: Span, b: Span) => (a.start ? ms(a.start) : null) === (b.start ? ms(b.start) : null) && (a.end ? ms(a.end) : null) === (b.end ? ms(b.end) : null);
const isLate = (i: Item) => i.violations.some((v) => v.kind !== "missing");

/** Program Scheduling — programs, projects and tasks as hierarchical rows over a timeline. */
export function ProgramSchedulingWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const layers = (widget.config.ps_layers ?? []).filter((l) => l.id && l.object_type_id && l.start_property && (l.puck_type === "event" || l.end_property));
  if (!layers.length) return <div className="p-3 text-xs text-muted">Add a data layer: an object type with its start and end time properties.</div>;
  return <ProgramChart widget={widget} state={state} editing={editing} layers={layers} />;
}

function ProgramChart({ widget, state, editing, layers }: { widget: Widget; state: ModuleState; editing: boolean; layers: ProgramLayerConfig[] }) {
  const c = widget.config;
  const utc = c.ps_timezone === "utc";
  const scenarioId = c.ps_scenario_variable ? String(state.variables[c.ps_scenario_variable] ?? "") || undefined : undefined;
  const mode = c.ps_dependency_mode ?? "warn";
  const apiLayers = useMemo(() => layers.map((l) => toApiLayer(l, state.variables)), [layers, state.variables]);
  const grouping = useMemo(() => (c.ps_grouping ?? []).filter((g) => g.property).map((g) => ({ property: g.property, descending: !!g.descending })), [c.ps_grouping]);
  // moves waiting for "Save changes" (no scenario variable): laid over the data on the server
  const [pending, setPending] = useState<Pending>({});
  const edits: Edit[] = useMemo(() => (scenarioId ? [] : Object.values(pending).map((p) => ({ layer: p.layer, primary_key: p.primary_key, start: p.after.start, end: p.after.end }))), [pending, scenarioId]);
  const spec = JSON.stringify({ layers: apiLayers, grouping, edits, scenario_id: scenarioId ?? null });
  const [data, setData] = useState<ProgramData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    program.data(JSON.parse(spec)).then(
      (d) => {
        if (stale) return;
        setData(d);
        setError(null);
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [spec, state.version]);

  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const loaded = data !== null;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth - LABEL_W - 14)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const [fold, setFold] = useState<{ base: boolean; flip: string[] }>({ base: c.ps_expand_groups !== false, flip: [] });
  const [arrows, setArrows] = useState(!c.ps_hide_arrows);
  const [sel, setSel] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showPending, setShowPending] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{ key: string; mode: Drag["mode"]; dx: number } | null>(null);

  const items = useMemo(() => data?.items ?? [], [data]);
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const layerInfo = useMemo(() => new Map((data?.layers ?? []).map((l) => [l.id, l])), [data]);
  const layerIndex = (id: string) => Math.max(0, layers.findIndex((l) => l.id === id));
  const colorOf = (i: Item) => i.color ?? PALETTE[layerIndex(i.layer) % PALETTE.length];

  // the window: the widget's dates (fixed or variables), else the data's extent with a few days around it
  const win = useMemo(() => {
    const a = toMs(c.ps_start_variable ? state.variables[c.ps_start_variable] : c.ps_start, utc);
    const b = toMs(c.ps_end_variable ? state.variables[c.ps_end_variable] : c.ps_end, utc, true);
    const times = items.flatMap((i) => [i.start, i.end]).filter((x): x is string => !!x).map(ms);
    const lo = times.length ? Math.min(...times) : now - 14 * DAY;
    const hi = times.length ? Math.max(...times) : now + 30 * DAY;
    const auto = { t0: dayStart(lo, utc, -3), t1: dayStart(hi, utc, 4) };
    const t0 = a ?? auto.t0;
    const t1 = b ?? auto.t1;
    return t1 > t0 ? { t0, t1, warn: "" } : { ...auto, warn: "The timeline's end is not after its start: the data's extent is shown" };
  }, [c.ps_start, c.ps_end, c.ps_start_variable, c.ps_end_variable, state.variables, items, utc, now]);
  const { t0, t1 } = win;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * width;
  const axis = useMemo(() => axisOf(t0, t1, width, utc), [t0, t1, width, utc]);
  const snap = snapper(c.ps_snap, utc);

  // the rows: group rows (collapsible) and the task rows under them
  const open = (k: string) => fold.base !== fold.flip.includes(k);
  const { rows, scopes } = useMemo(() => {
    const out: VRow[] = [];
    const scopes = new Map<string, [number, number]>();
    const walk = (g: GroupRow, depth: number) => {
      const first = out.length;
      out.push({ kind: "group", g, depth });
      if (fold.base !== fold.flip.includes(g.key)) {
        g.children.forEach((ch) => walk(ch, depth + 1));
        g.items.forEach((k) => {
          const it = byKey.get(k);
          if (it) out.push({ kind: "item", it, depth: depth + 1 });
        });
      }
      scopes.set(g.key, [first, out.length - 1]);
    };
    (data?.groups ?? []).forEach((g) => walk(g, 0));
    (data?.root_items ?? []).forEach((k) => {
      const it = byKey.get(k);
      if (it) out.push({ kind: "item", it, depth: 0 });
    });
    return { rows: out, scopes };
  }, [data, byKey, fold]);
  const rowOf = useMemo(() => new Map(rows.flatMap((r, i) => (r.kind === "item" ? [[r.it.key, i] as const] : []))), [rows]);
  const scopeRange = (key: string | null): [number, number] => (key && scopes.has(key) ? scopes.get(key)! : [0, Math.max(0, rows.length - 1)]);

  // hovering (or a pinned) puck highlights its whole dependency chain: what it waits for and what waits for it
  const focus = pinned ?? hover;
  const chain = useMemo(() => {
    if (!focus || !byKey.has(focus)) return null;
    const set = new Set([focus]);
    const up = [focus];
    while (up.length) {
      const i = byKey.get(up.pop()!);
      for (const d of i?.deps ?? []) {
        const k = `${i!.layer}:${d}`;
        if (byKey.has(k) && !set.has(k)) {
          set.add(k);
          up.push(k);
        }
      }
    }
    const down = [focus];
    const seen = new Set([focus]);
    while (down.length) {
      for (const k of byKey.get(down.pop()!)?.dependents ?? []) {
        if (!seen.has(k)) {
          seen.add(k);
          set.add(k);
          down.push(k);
        }
      }
    }
    return set;
  }, [focus, byKey]);

  // ---- selection and its outputs
  const prevType = useRef<string | null>(null);
  const select = (keys: string[]) => {
    setSel(keys);
    const chosen = keys.map((k) => byKey.get(k)).filter((i): i is Item => !!i);
    const pks = chosen.map((i) => i.id);
    const type = chosen[0]?.object_type_id ?? null;
    if (prevType.current && prevType.current !== type) state.select(sourceKey({ kind: "object_type", id: prevType.current }), undefined);
    if (type) state.select(sourceKey({ kind: "object_type", id: type }), pks[0]);
    prevType.current = type;
    if (c.ps_selected_variable) state.setVariable(c.ps_selected_variable, state.variableTypes?.[c.ps_selected_variable] === "string" ? pks.join(",") : pks);
    if (c.ps_selected_filter_variable) state.setVariable(c.ps_selected_filter_variable, pks.length ? pkFilter(pks) : NO_FILTER);
    void state.runEvents?.(c.ps_events ?? []);
  };
  /** A click selects the puck; Ctrl / Cmd + click adds it to (or takes it out of) the selection, within one layer. */
  const clickItem = (it: Item, additive: boolean) => {
    if (additive) {
      const same = sel.filter((k) => byKey.get(k)?.layer === it.layer);
      select(same.includes(it.key) ? same.filter((k) => k !== it.key) : [...same, it.key]);
    } else select(sel.length === 1 && sel[0] === it.key ? [] : [it.key]);
  };

  // ---- editing
  const enabled = c.ps_editable !== false;
  const whyReadOnly = !enabled ? "Read-only" : state.readOnly ? "Read-only: this module does not write" : editing ? "Moves are off while the module is edited" : "";
  const canMove = (i: Item) => enabled && !editing && !state.readOnly && i.kind !== "background" && !!layerInfo.get(i.layer)?.editable;
  const pendingCount = Object.keys(pending).length;

  const commit = async (it: Item, start: number, end: number | null) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const plan = await program.plan({ layers: apiLayers, edits, scenario_id: scenarioId ?? null, layer: it.layer, primary_key: it.id, start: iso(start), end: end === null ? null : iso(end), mode });
      if (plan.refused) {
        setNote({ text: plan.refused, bad: true });
        return;
      }
      const pushed = plan.changes.length - 1;
      const broken = plan.conflicts.length ? ` · breaks ${plan.conflicts.length} dependenc${plan.conflicts.length === 1 ? "y" : "ies"} (${plan.conflicts[0].title}: ${plan.conflicts[0].details})` : "";
      const what = `${it.title} ${it.kind === "event" ? "moved" : "rescheduled"}${pushed ? `, ${pushed} later task${pushed === 1 ? "" : "s"} pushed` : ""}`;
      if (scenarioId) {
        await program.save({ layers: apiLayers, edits: plan.changes.map((ch) => ({ layer: ch.layer, primary_key: ch.primary_key, start: ch.after.start, end: ch.after.end })), scenario_id: scenarioId });
        setLog((l) => [...l, { id: (l.at(-1)?.id ?? 0) + 1, title: it.title, changes: plan.changes }]);
        setNote({ text: `${what} (staged in the scenario)${broken}`, bad: !!broken });
        state.bump();
      } else {
        setPending((cur) => {
          const next = { ...cur };
          for (const ch of plan.changes) {
            const before = cur[ch.key]?.before ?? ch.before;
            if (sameSpan(before, ch.after)) delete next[ch.key];
            else next[ch.key] = { layer: ch.layer, primary_key: ch.primary_key, title: ch.title, before, after: ch.after };
          }
          return next;
        });
        setNote({ text: `${what}: not saved yet${broken}`, bad: !!broken });
      }
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const saveAll = async () => {
    const list = Object.values(pending);
    if (!list.length) return;
    setBusy(true);
    try {
      const r = await program.save({ layers: apiLayers, edits: list.map((p) => ({ layer: p.layer, primary_key: p.primary_key, start: p.after.start, end: p.after.end })), scenario_id: null });
      setPending({});
      setShowPending(false);
      setNote({ text: `${r.saved} change${r.saved === 1 ? "" : "s"} saved`, bad: false });
      state.bump();
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  /** Undo a staged change (scenario): only while every puck it moved is still where it put them. */
  const undo = async (e: LogEntry) => {
    const moved = e.changes.find((ch) => {
      const i = byKey.get(ch.key);
      return !i || !sameSpan({ start: i.start, end: i.end }, ch.after);
    });
    if (moved) return setNote({ text: `${moved.title} changed since: undo the later change first`, bad: true });
    setBusy(true);
    try {
      await program.save({ layers: apiLayers, edits: e.changes.map((ch) => ({ layer: ch.layer, primary_key: ch.primary_key, start: ch.before.start, end: ch.before.end })), scenario_id: scenarioId ?? null });
      setLog((l) => l.map((x) => (x.id === e.id ? { ...x, undone: true } : x)));
      setNote({ text: `${e.title} restored`, bad: false });
      state.bump();
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  /** The pointer's release: the new start / end of the dragged puck (snapped), then the plan. */
  const drop = (it: Item, d: Drag, clientX: number) => {
    const dt = ((clientX - d.sx) / width) * (t1 - t0);
    const info = layerInfo.get(it.layer);
    if (!it.start) return;
    const s0 = ms(it.start);
    const e0 = it.end ? ms(it.end) : null;
    const startDates = info?.start_type === "date";
    const endDates = info?.end_type === "date";
    if (d.mode === "move") {
      const s = snap(s0 + dt, startDates);
      return void commit(it, s, e0 === null ? null : s + (e0 - s0));
    }
    if (d.mode === "start" && e0 !== null) {
      const s = snap(s0 + dt, startDates);
      if (s >= e0) return setNote({ text: "The start must stay before the end", bad: true });
      return void commit(it, s, e0);
    }
    if (d.mode === "end" && e0 !== null) {
      const e = snap(e0 + dt, endDates);
      if (e <= s0) return setNote({ text: "The end must stay after the start", bad: true });
      return void commit(it, s0, e);
    }
  };
  const pointerHandlers = (it: Item) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const handle = (e.target as HTMLElement).closest("[data-ps-handle]")?.getAttribute("data-ps-handle");
      drag.current = { key: it.key, mode: handle === "start" || handle === "end" ? handle : "move", sx: e.clientX, moved: false };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // the drag still works while the pointer stays over the puck
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.key !== it.key || !canMove(it)) return;
      if (Math.abs(e.clientX - d.sx) > 3) d.moved = true;
      if (d.moved) setGhost({ key: it.key, mode: d.mode, dx: e.clientX - d.sx });
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      drag.current = null;
      setGhost(null);
      if (!d || d.key !== it.key) return;
      if (!d.moved) return clickItem(it, e.ctrlKey || e.metaKey);
      drop(it, d, e.clientX);
    },
    onPointerCancel: () => {
      drag.current = null;
      setGhost(null);
    },
    onPointerEnter: () => setHover(it.key),
    onPointerLeave: () => setHover((h) => (h === it.key ? null : h)),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(it, e);
    },
  });

  const openMenu = (it: Item, e: React.MouseEvent) => {
    const list: MenuItem[] = [
      { label: sel.includes(it.key) ? "Clear the selection" : "Select", run: () => select(sel.includes(it.key) ? [] : [it.key]) },
      { label: pinned === it.key ? "Stop highlighting the dependency chain" : "Highlight the dependency chain", run: () => setPinned(pinned === it.key ? null : it.key), disabled: it.kind !== "standard" },
      { label: "Open the Object View", run: () => window.open(`/ontology/objects/${it.object_type_id}/${encodeURIComponent(it.id)}`, "_blank", "noopener") },
    ];
    for (const m of c.ps_puck_menu ?? []) {
      if (!m.label || !(m.action_id || m.events?.length)) continue;
      list.push({
        label: m.label,
        disabled: !!m.action_id && (!enabled || editing || !!state.readOnly),
        hint: m.action_id ? (whyReadOnly || "Opens the action's form") : "Runs the Workshop events",
        run: () => {
          if (!sel.includes(it.key)) select([it.key]);
          if (m.action_id) setDialog({ actionId: m.action_id, item: it, label: `${m.label}: ${it.title}` });
          else void state.runEvents?.(m.events ?? []);
        },
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, title: it.title, items: list });
  };

  if (!data) return <div className={`p-3 text-xs ${error ? "text-bad" : "text-muted"}`}>{error ?? "Loading…"}</div>;

  const H = rows.length * ROW_H;
  const span = (a: number, z: number) => ({ left: x(Math.max(t0, a)), width: Math.max(2, x(Math.min(t1, z)) - x(Math.max(t0, a))) });
  const visible = (i: Item) => !!i.start && ms(i.end ?? i.start) >= t0 && ms(i.start) <= t1;
  const standard = items.filter((i) => i.kind === "standard");
  const outside = items.filter((i) => i.kind === "standard" && i.start && !visible(i)).length;
  const unscheduled = standard.filter((i) => !i.start).length;
  const selectedItem = sel.length ? byKey.get(sel[sel.length - 1]) : undefined;
  const nowShown = !!c.ps_show_now && now > t0 && now < t1;
  const dimmed = (k: string) => !!chain && !chain.has(k);

  /** A puck's drawn position while it is dragged (the ghost) or as it is. */
  const placed = (i: Item) => {
    const s = ms(i.start!);
    const e = i.end ? ms(i.end) : s;
    const g = ghost?.key === i.key ? ghost : null;
    const dt = g ? (g.dx / width) * (t1 - t0) : 0;
    return { s: g && g.mode !== "end" ? s + dt : s, e: g && g.mode !== "start" ? e + dt : e };
  };

  const links = arrows
    ? data.links.flatMap((l) => {
        const a = byKey.get(l.from);
        const b = byKey.get(l.to);
        const ra = rowOf.get(l.from);
        const rb = rowOf.get(l.to);
        if (!a?.start || !b?.start || ra === undefined || rb === undefined) return [];
        const pa = placed(a);
        const pb = placed(b);
        const x1 = x(pa.e);
        const x2 = x(pb.s);
        const y1 = ra * ROW_H + ROW_H / 2;
        const y2 = rb * ROW_H + ROW_H / 2;
        const mid = rb > ra ? rb * ROW_H : (rb + 1) * ROW_H;
        const d = x2 - 10 >= x1 + 6 ? `M${x1},${y1} H${x2 - 10} V${y2} H${x2 - 2}` : `M${x1},${y1} H${x1 + 8} V${mid} H${x2 - 12} V${y2} H${x2 - 2}`;
        const hot = !!chain && chain.has(l.from) && chain.has(l.to);
        return [{ key: `${l.from}>${l.to}`, d, ok: l.ok, hot, faded: !!chain && !hot }];
      })
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink" data-program-scheduling={widget.id}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-2 py-1 text-[11px] text-muted">
        <Icon name="clock" className="h-3.5 w-3.5 shrink-0 text-ocean" />
        <span data-ps-count={standard.length}>
          {standard.length} tasks{unscheduled ? ` · ${unscheduled} without dates` : ""} ·{" "}
          <span className={data.late ? "text-bad" : "text-ok"} data-ps-late-total={data.late}>
            {data.late} with broken dependencies
          </span>
        </span>
        <button type="button" onClick={() => setFold({ base: true, flip: [] })} className="hover:text-white" data-ps-expand-all>
          Expand all
        </button>
        <button type="button" onClick={() => setFold({ base: false, flip: [] })} className="hover:text-white" data-ps-collapse-all>
          Collapse all
        </button>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={arrows} onChange={(e) => setArrows(e.target.checked)} data-ps-toggle-arrows /> Dependency arrows
        </label>
        <span title="What a move that breaks a dependency does">{mode === "push" ? "Moves push later tasks" : mode === "block" ? "Moves breaking a dependency are refused" : "Broken dependencies are marked"}</span>
        {scenarioId && <span className="text-warn">Staged in a scenario</span>}
        {whyReadOnly && <span>{whyReadOnly}</span>}
        {busy && <span>Saving…</span>}
        {note && (
          <span className={`min-w-0 truncate ${note.bad ? "text-bad" : "text-ok"}`} title={note.text} data-ps-note>
            {note.text}
          </span>
        )}
        {!scenarioId && pendingCount > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setShowPending(!showPending)} className="text-soft hover:text-white" data-ps-pending={pendingCount}>
              {pendingCount} unsaved change{pendingCount === 1 ? "" : "s"}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending({})} className="text-muted hover:text-bad" data-ps-discard>
              Discard
            </button>
            <button type="button" disabled={busy || !!state.readOnly} onClick={() => void saveAll()} className="rounded bg-ocean px-2 py-0.5 font-medium text-ink disabled:opacity-40" data-ps-save>
              Save changes
            </button>
          </span>
        )}
        {scenarioId && log.length > 0 && (
          <button type="button" onClick={() => setShowPending(!showPending)} className="ml-auto text-soft hover:text-white" data-ps-log-button={log.filter((e) => !e.undone).length}>
            Staged changes ({log.filter((e) => !e.undone).length})
          </button>
        )}
      </div>
      {(win.warn || outside > 0 || data.warnings.length > 0 || error) && (
        <div className="shrink-0 border-b border-line bg-panel px-2 py-0.5 text-[11px] text-warn" data-ps-warnings>
          {[error, win.warn, outside > 0 ? `${outside} tasks outside this timeline` : "", ...data.warnings].filter(Boolean).join(" · ")}
        </div>
      )}
      {showPending && !scenarioId && pendingCount > 0 && (
        <ul className="max-h-32 shrink-0 space-y-0.5 overflow-y-auto border-b border-line bg-panel px-2 py-1 text-[11px]" data-ps-pending-list>
          {Object.entries(pending).map(([k, p]) => (
            <li key={k} className="flex items-center gap-2 text-soft">
              <span className="shrink-0 font-medium text-white">{p.title}</span>
              <span className="min-w-0 truncate">
                {p.before.start ? fmtDay(ms(p.before.start), utc) : "—"} → {p.after.start ? fmtDay(ms(p.after.start), utc) : "—"}
                {p.after.end ? ` · ends ${fmtDay(ms(p.after.end) - 1, utc)}` : ""}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPending((cur) => {
                    const next = { ...cur };
                    delete next[k];
                    return next;
                  })
                }
                className="ml-auto shrink-0 text-muted hover:text-bad"
              >
                Discard
              </button>
            </li>
          ))}
        </ul>
      )}
      {showPending && scenarioId && log.length > 0 && (
        <ul className="max-h-32 shrink-0 space-y-0.5 overflow-y-auto border-b border-line bg-panel px-2 py-1 text-[11px]" data-ps-log>
          {[...log].reverse().map((e) => (
            <li key={e.id} className={`flex items-center gap-2 ${e.undone ? "text-muted line-through" : "text-soft"}`}>
              <span className="shrink-0 font-medium text-white">{e.title}</span>
              <span className="min-w-0 truncate">{e.changes.map((ch) => `${ch.title}: ${ch.before.start ? fmtDay(ms(ch.before.start), utc) : "—"} → ${ch.after.start ? fmtDay(ms(ch.after.start), utc) : "—"}`).join(" · ")}</span>
              {!e.undone && (
                <button type="button" disabled={busy} onClick={() => void undo(e)} className="ml-auto shrink-0 text-ocean hover:underline" data-ps-undo={e.id}>
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div ref={host} className="min-h-0 flex-1 overflow-auto">
        <div style={{ width: LABEL_W + width + 14 }}>
          <div className="sticky top-0 z-10 flex border-b border-line bg-panel text-[11px]">
            <div style={{ width: LABEL_W }} className="shrink-0 px-2 py-1.5 text-muted">
              {grouping.length ? grouping.map((g) => g.property).join(" › ") + " › task" : "Task"}
            </div>
            <div className="relative h-10" style={{ width }} data-ps-axis={axis.unit}>
              {axis.months.map((m, i) => (
                <div key={m.t} className="absolute top-0 h-5 overflow-hidden whitespace-nowrap border-l border-line px-1 font-medium text-soft" style={{ left: x(m.t), width: (i + 1 < axis.months.length ? x(axis.months[i + 1].t) : width) - x(m.t) }}>
                  {m.label}
                </div>
              ))}
              {axis.ticks.map((tk) => (
                <div key={tk.t} className="absolute bottom-0 h-5 whitespace-nowrap border-l border-line/60 pl-0.5 text-[10px] leading-5 text-muted" style={{ left: x(tk.t) }}>
                  {tk.label}
                </div>
              ))}
            </div>
          </div>
          <div className="relative" style={{ height: H }}>
            {/* grid lines, background pucks (phases) and the now line, beneath the rows */}
            <div className="pointer-events-none absolute top-0" style={{ left: LABEL_W, width, height: H }}>
              {axis.ticks.map((tk) => (
                <div key={tk.t} className="absolute top-0 h-full border-l border-line/30" style={{ left: x(tk.t) }} />
              ))}
              {items
                .filter((i) => i.kind === "background" && i.start && i.end && visible(i))
                .map((i) => {
                  const [r0, r1] = scopeRange(i.group);
                  return (
                    <div
                      key={i.key}
                      className="absolute overflow-hidden text-ellipsis whitespace-nowrap rounded-sm border-x border-white/10 px-1 text-[10px] font-medium text-white/60"
                      style={{ ...span(ms(i.start!), ms(i.end!)), top: r0 * ROW_H, height: (r1 - r0 + 1) * ROW_H, background: `${colorOf(i)}22` }}
                      title={`${i.title}: ${fmtDay(ms(i.start!), utc)} → ${fmtDay(ms(i.end!) - 1, utc)}`}
                      data-ps-background={i.key}
                    >
                      {i.title}
                    </div>
                  );
                })}
              {nowShown && <div className="absolute top-0 z-[5] h-full border-l-2 border-red-500" style={{ left: x(now) }} title="Now" data-ps-now />}
            </div>
            {rows.map((r, ri) =>
              r.kind === "group" ? (
                <div key={`g:${r.g.key}`} className="absolute flex border-b border-line bg-panel/60" style={{ top: ri * ROW_H, height: ROW_H, width: LABEL_W + width }} data-ps-group={r.g.key} data-ps-open={open(r.g.key) ? "1" : "0"}>
                  <button
                    type="button"
                    onClick={() => setFold((f) => ({ ...f, flip: f.flip.includes(r.g.key) ? f.flip.filter((k) => k !== r.g.key) : [...f.flip, r.g.key] }))}
                    style={{ width: LABEL_W, paddingLeft: 6 + r.depth * 14 }}
                    className="flex shrink-0 items-center gap-1 pr-2 text-left text-xs hover:bg-panel-2"
                    title={`${r.g.property}: ${r.g.label}`}
                    data-ps-group-toggle={r.g.key}
                  >
                    <Icon name={open(r.g.key) ? "down" : "right"} className="h-3 w-3 shrink-0 text-muted" />
                    <span className="truncate font-semibold text-white">{r.g.label}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted">{r.g.count}</span>
                    {r.g.late > 0 && (
                      <span className="shrink-0 rounded bg-bad/15 px-1 text-[10px] text-bad" data-ps-group-late={r.g.late}>
                        {r.g.late} late
                      </span>
                    )}
                  </button>
                  <div className="relative" style={{ width }}>
                    {r.g.start && r.g.end && ms(r.g.end) >= t0 && ms(r.g.start) <= t1 && (
                      <div
                        className="absolute top-[11px] h-2 overflow-hidden rounded-sm bg-white/25"
                        style={span(ms(r.g.start), ms(r.g.end))}
                        title={`${r.g.label}: ${fmtDay(ms(r.g.start), utc)} → ${fmtDay(ms(r.g.end) - 1, utc)} · ${r.g.count} tasks${r.g.progress !== null ? ` · ${Math.round(r.g.progress * 100)}% done` : ""}${r.g.late ? ` · ${r.g.late} with broken dependencies` : ""}`}
                        data-ps-rollup={r.g.key}
                        data-start={r.g.start}
                        data-end={r.g.end}
                      >
                        {r.g.progress !== null && <div className="h-full bg-white/60" style={{ width: `${Math.round(r.g.progress * 100)}%` }} />}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div key={r.it.key} className="absolute flex border-b border-line/50" style={{ top: ri * ROW_H, height: ROW_H, width: LABEL_W + width }} data-ps-row={r.it.key}>
                  <button
                    type="button"
                    onClick={(e) => clickItem(r.it, e.ctrlKey || e.metaKey)}
                    style={{ width: LABEL_W, paddingLeft: 8 + r.depth * 14 }}
                    className={`flex shrink-0 items-center gap-1.5 pr-2 text-left text-xs ${sel.includes(r.it.key) ? "bg-ocean/15" : "hover:bg-panel-2"}`}
                    title={r.it.title}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(r.it) }} />
                    <span className={`truncate ${dimmed(r.it.key) ? "text-muted" : "text-soft"}`}>{r.it.title}</span>
                    {isLate(r.it) && <span className="ml-auto shrink-0 rounded-full bg-bad px-1 text-[9px] font-bold text-white">!</span>}
                  </button>
                  <div className="relative" style={{ width }} />
                </div>
              ),
            )}
            {/* dependency arrows, above the rows and beneath the pucks */}
            {links.length > 0 && (
              <svg className="pointer-events-none absolute top-0 z-[2] overflow-visible" style={{ left: LABEL_W }} width={width} height={H} data-ps-arrows={links.length}>
                <defs>
                  <marker id={`ps-arrow-${widget.id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
                  </marker>
                </defs>
                {links.map((l) => (
                  <path
                    key={l.key}
                    d={l.d}
                    fill="none"
                    stroke={l.hot ? "#fbbf24" : l.ok ? "#94a3b8" : "#ef4444"}
                    strokeWidth={l.hot ? 2 : 1.25}
                    strokeDasharray={l.ok ? undefined : "4 3"}
                    opacity={l.faded ? 0.2 : 0.9}
                    markerEnd={`url(#ps-arrow-${widget.id})`}
                    data-ps-link={l.key}
                    data-ps-ok={l.ok ? "1" : "0"}
                    data-ps-hot={l.hot ? "1" : "0"}
                  />
                ))}
              </svg>
            )}
            {/* standard pucks: bars on their task rows */}
            <div className="absolute top-0 z-[3]" style={{ left: LABEL_W, width, height: 0 }}>
              {standard
                .filter((i) => i.start && i.end && rowOf.has(i.key) && visible(i))
                .map((i) => {
                  const p = placed(i);
                  const ri = rowOf.get(i.key)!;
                  const movable = canMove(i);
                  return (
                    <div
                      key={i.key}
                      {...pointerHandlers(i)}
                      className={`absolute flex select-none items-center overflow-hidden rounded text-[11px] text-ink shadow ${movable ? "cursor-grab" : "cursor-pointer"} ${sel.includes(i.key) ? "ring-2 ring-white" : ""} ${isLate(i) ? "outline outline-2 outline-red-500" : ""} ${i.edited ? "border border-dashed border-white" : ""}`}
                      style={{ ...span(p.s, p.e), top: ri * ROW_H + 5, height: ROW_H - 10, background: colorOf(i), opacity: dimmed(i.key) ? 0.3 : ghost?.key === i.key ? 0.8 : 1 }}
                      title={`${i.title}\n${fmtDay(ms(i.start!), utc)} → ${fmtDay(ms(i.end!) - 1, utc)}${i.progress !== null ? `\n${Math.round(i.progress * 100)}% done` : ""}${i.violations.map((v) => `\n${v.details}`).join("")}${i.edited ? "\nNot saved yet" : ""}`}
                      data-ps-bar={i.key}
                      data-start={i.start!}
                      data-end={i.end!}
                      data-ps-late={isLate(i) ? "1" : "0"}
                    >
                      {i.progress !== null && <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/20" style={{ width: `${Math.round(i.progress * 100)}%` }} />}
                      {movable && <div className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/10" data-ps-handle="start" />}
                      <span className="relative truncate px-2 font-medium">{i.title}</span>
                      {movable && <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/10" data-ps-handle="end" />}
                    </div>
                  );
                })}
              {/* event pucks (milestones): a line over the rows of their group and a diamond on the group's row */}
              {items
                .filter((i) => i.kind === "event" && i.start && visible(i))
                .map((i) => {
                  const p = placed(i);
                  const [r0, r1] = scopeRange(i.group);
                  return (
                    <div key={i.key} className="pointer-events-none absolute" style={{ left: x(p.s), top: r0 * ROW_H, height: (r1 - r0 + 1) * ROW_H }}>
                      <div className="absolute top-0 h-full border-l border-dashed" style={{ borderColor: colorOf(i), opacity: dimmed(i.key) ? 0.3 : 0.8 }} />
                      <div
                        {...pointerHandlers(i)}
                        className={`pointer-events-auto absolute flex items-center gap-1 whitespace-nowrap text-[10px] text-white ${canMove(i) ? "cursor-grab" : "cursor-pointer"}`}
                        style={{ left: -6, top: (ROW_H - 12) / 2 }}
                        title={`${i.title}: ${fmtTime(ms(i.start!), utc)}`}
                        data-ps-event={i.key}
                        data-start={i.start!}
                      >
                        <span className={`inline-block h-3 w-3 rotate-45 ${sel.includes(i.key) ? "ring-2 ring-white" : ""}`} style={{ background: colorOf(i) }} />
                        <span className="rounded bg-ink/70 px-0.5">{i.title}</span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
          {!rows.length && <p className="p-3 text-xs text-muted">No tasks in these layers.</p>}
        </div>
      </div>
      {selectedItem && <DetailCard item={selectedItem} items={byKey} layer={layers.find((l) => l.id === selectedItem.layer)} info={layerInfo.get(selectedItem.layer)} utc={utc} count={sel.length} onPick={(k) => select([k])} onClear={() => select([])} />}
      <div className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-2 py-1 text-[10px] text-muted">
        <span className="truncate">
          Drag a task to move it, its edges to change its start or end · hover a task for its dependency chain · Ctrl + click adds to the selection · right-click for its menu
        </span>
      </div>
      {menu && <ContextMenu at={menu} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && (
        <ActionDialog
          dialog={dialog}
          layer={layers.find((l) => l.id === dialog.item.layer)}
          scenarioId={scenarioId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            state.bump();
          }}
        />
      )}
    </div>
  );
}

const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** The detail card of the selected puck: its properties, what it waits for and what waits for it (click to go
 * there), its broken dependencies and the Object View. */
function DetailCard({ item, items, layer, info, utc, count, onPick, onClear }: { item: Item; items: Map<string, Item>; layer?: ProgramLayerConfig; info?: LayerInfo; utc: boolean; count: number; onPick: (k: string) => void; onClear: () => void }) {
  const props = layer?.detail_properties?.length ? layer.detail_properties : Object.keys(item.properties).slice(0, 12);
  const waits = item.deps.map((d) => items.get(`${item.layer}:${d}`) ?? { key: "", title: d });
  const blocks = item.dependents.map((k) => items.get(k)).filter((i): i is Item => !!i);
  return (
    <div className="max-h-40 shrink-0 overflow-y-auto border-t border-line bg-panel px-2 py-1.5 text-[11px]" data-ps-selected={item.key}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-white">{item.title}</span>
        <span className="text-muted">{info?.name ?? item.layer}</span>
        {count > 1 && <span className="text-muted">{count} selected</span>}
        <span className="text-soft">
          {item.start ? (item.kind === "event" ? fmtTime(ms(item.start), utc) : fmtDay(ms(item.start), utc)) : "No start"}
          {item.end && item.kind !== "event" ? ` → ${fmtDay(ms(item.end) - 1, utc)}` : ""}
        </span>
        {item.progress !== null && <span className="text-soft">{Math.round(item.progress * 100)}% done</span>}
        {item.edited && <span className="text-warn">Not saved yet</span>}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          <a href={`/ontology/objects/${item.object_type_id}/${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">
            Object View
          </a>
          <button type="button" onClick={onClear} className="text-muted hover:text-white">
            Clear
          </button>
        </span>
      </div>
      {item.violations.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {item.violations.map((v, i) => (
            <span key={i} className={`rounded px-1.5 py-0.5 ${v.kind === "missing" ? "bg-warn/10 text-warn" : "bg-bad/10 text-bad"}`} data-ps-violation={v.kind}>
              {v.details}
            </span>
          ))}
        </div>
      )}
      {(waits.length > 0 || blocks.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-soft">
          {waits.length > 0 && <span className="text-muted">Waits for</span>}
          {waits.map((w, i) => (
            <button key={`w${i}`} type="button" disabled={!w.key} onClick={() => w.key && onPick(w.key)} className="rounded border border-line px-1.5 hover:text-white disabled:opacity-50" data-ps-waits={w.key}>
              {w.title}
            </button>
          ))}
          {blocks.length > 0 && <span className="text-muted">Blocks</span>}
          {blocks.map((b) => (
            <button key={b.key} type="button" onClick={() => onPick(b.key)} className="rounded border border-line px-1.5 hover:text-white" data-ps-blocks={b.key}>
              {b.title}
            </button>
          ))}
        </div>
      )}
      <dl className="mt-1 grid gap-x-3 gap-y-0.5" style={{ gridTemplateColumns: "max-content 1fr" }}>
        {props.map((k) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="truncate text-soft">{shown(item.properties[k])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

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
  const left = Math.min(pos.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 250);
  const top = Math.min(pos.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 30 - items.length * 26);
  return (
    <div ref={ref} role="menu" className="fixed z-50 w-60 overflow-hidden rounded border border-line bg-panel py-1 text-[12px] shadow-xl" style={{ left, top }} data-ps-menu>
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

/** A menu item's action on the puck: its form with the object and the start / end parameters filled in. */
function ActionDialog({ dialog, layer, scenarioId, onClose, onDone }: { dialog: Dialog; layer?: ProgramLayerConfig; scenarioId?: string; onClose: () => void; onDone: () => void }) {
  const [x, setX] = useState<{ action: ActionType; type: ObjectType; object?: OntologyObject } | { error: string } | null>(null);
  useEffect(() => {
    let stale = false;
    (async () => {
      const action = await ontology.actionType(dialog.actionId);
      const typeId = action.object_type_id || dialog.item.object_type_id;
      const [type, object] = await Promise.all([ontology.objectType(typeId), typeId === dialog.item.object_type_id ? ontology.object(typeId, dialog.item.id) : Promise.resolve(undefined)]);
      if (!stale) setX({ action, type, object });
    })().catch((e: Error) => !stale && setX({ error: e.message }));
    return () => {
      stale = true;
    };
  }, [dialog]);
  if (!x) return null;
  if ("error" in x) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="rounded border border-line bg-panel p-3 text-xs text-bad">{x.error}</div>
      </div>
    );
  }
  const by: Record<string, unknown> = { ...dialog.item.properties };
  if (layer) {
    by[layer.start_property] = dialog.item.properties[layer.start_property];
    if (layer.end_property) by[layer.end_property] = dialog.item.properties[layer.end_property];
  }
  const defaults: Record<string, unknown> = {};
  for (const p of x.action.parameters as unknown as ActionParam[]) {
    const k = p.property ?? p.id;
    const v = p.type === "object" && (p.object_type_id ?? x.action.object_type_id) === dialog.item.object_type_id ? dialog.item.id : by[k];
    if (v !== undefined && v !== null && v !== "") defaults[p.id] = v;
  }
  return <ActionForm action={x.action} objectType={x.type} object={x.object} defaults={defaults} scenarioId={scenarioId} title={dialog.label} onClose={onClose} onDone={onDone} />;
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

const DATE_TYPES: Variable["type"][] = ["date", "timestamp", "string"];
const OPERATORS = ["=", "!=", ">", "<", "contains", "empty", "not_empty", "violation"] as const;
type ColorRule = NonNullable<ProgramLayerConfig["color_rules"]>[number];
type MenuEntry = NonNullable<WidgetConfig["ps_puck_menu"]>[number];

export function ProgramSchedulingConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const on = widget.type === "program_scheduling";
  const vars = mod.variables ?? [];
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [openLayer, setOpenLayer] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    ontology.objectTypes().then(setTypes, () => setTypes([]));
    ontology.actionTypes().then(setActions, () => setActions([]));
  }, [on]);
  if (!on) return null;
  const layers = c.ps_layers ?? [];
  const putLayer = (id: string, xs: Partial<ProgramLayerConfig>) => set({ ps_layers: layers.map((l) => (l.id === id ? { ...l, ...xs } : l)) });
  const varSel = (value: string | undefined, onChange: (v: string | undefined) => void, kinds: Variable["type"][], none = "None", label?: string) => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass} aria-label={label}>
      <option value="">{none}</option>
      {vars.filter((v) => kinds.includes(v.type)).map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type.replace(/_/g, " ")})</option>)}
    </select>
  );
  const date = (which: "start" | "end", label: string, hint: string) => {
    const variable = which === "start" ? c.ps_start_variable : c.ps_end_variable;
    const fixed = which === "start" ? c.ps_start : c.ps_end;
    return (
      <Field label={label} hint={hint}>
        <div className="flex gap-1">
          {varSel(variable, (v) => set(which === "start" ? { ps_start_variable: v } : { ps_end_variable: v }), DATE_TYPES, "A fixed date", `${label} variable`)}
          {!variable && <input type="date" value={fixed ?? ""} onChange={(e) => set(which === "start" ? { ps_start: e.target.value || undefined } : { ps_end: e.target.value || undefined })} className={inputClass} aria-label={label} />}
        </div>
      </Field>
    );
  };
  // grouping properties: the properties of the standard layers' types
  const groupProps = [...new Set(layers.filter((l) => l.puck_type === "standard").flatMap((l) => types.find((t) => t.id === l.object_type_id)?.properties.map((p) => p.api_name) ?? []))];
  const grouping = c.ps_grouping ?? [];
  const menu = c.ps_puck_menu ?? [];
  const putMenu = (i: number, xs: Partial<MenuEntry>) => set({ ps_puck_menu: menu.map((m, j) => (j === i ? { ...m, ...xs } : m)) });
  const layerTypes = new Set(layers.map((l) => l.object_type_id));
  return (
    <div className="space-y-3 text-xs" data-ps-config>
      <div className="font-semibold uppercase tracking-wide text-muted">Input data (layers)</div>
      {layers.map((l) => {
        const t = types.find((x) => x.id === l.object_type_id);
        const props = t?.properties ?? [];
        const timeProps = props.filter((p) => p.type === "date" || p.type === "timestamp");
        const propSel = (value: string | undefined, onChange: (v: string | undefined) => void, list = props, none = "None", label?: string) => (
          <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass} aria-label={label}>
            <option value="">{none}</option>
            {list.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name} ({p.type})</option>)}
            {value && !list.some((p) => p.api_name === value) && <option value={value}>{value}</option>}
          </select>
        );
        const expanded = openLayer === l.id || layers.length === 1;
        const rules = l.color_rules ?? [];
        const putRule = (i: number, xs: Partial<ColorRule>) => putLayer(l.id, { color_rules: rules.map((r, j) => (j === i ? { ...r, ...xs } : r)) });
        return (
          <div key={l.id} className="space-y-2 rounded border border-line p-2" data-ps-layer-config={l.id}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setOpenLayer(expanded && layers.length > 1 ? null : l.id)} className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium text-white">
                <Icon name={expanded ? "down" : "right"} className="h-3 w-3 shrink-0" />
                <span className="truncate">{l.name || t?.display_name || "New layer"}</span>
                <span className="shrink-0 text-muted">· {l.puck_type}</span>
              </button>
              <button type="button" onClick={() => set({ ps_layers: layers.filter((x) => x.id !== l.id) })} aria-label="Remove the layer" className="text-muted hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            {expanded && (
              <>
                <Field label="Layer name">
                  <input value={l.name ?? ""} onChange={(e) => putLayer(l.id, { name: e.target.value || undefined })} className={inputClass} aria-label="Layer name" />
                </Field>
                <Field label="Object type" hint="Its objects are the layer's pucks (all of them, or an object set variable's).">
                  <select value={l.object_type_id} onChange={(e) => putLayer(l.id, { object_type_id: e.target.value, start_property: "", end_property: undefined, dependency_property: undefined, label_property: undefined, progress_property: undefined, save_action_id: undefined, color_rules: undefined, detail_properties: undefined })} className={inputClass} aria-label="Object type">
                    <option value="">Choose…</option>
                    {types.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}
                  </select>
                </Field>
                <Field label="Puck type" hint="Standard: bars with dependencies. Background: shaded periods (read-only). Event: points in time (milestones).">
                  <select value={l.puck_type} onChange={(e) => putLayer(l.id, { puck_type: e.target.value as PuckType })} className={inputClass} aria-label="Puck type">
                    <option value="standard">Standard</option>
                    <option value="background">Background</option>
                    <option value="event">Event</option>
                  </select>
                </Field>
                <Field label="Start time property">{propSel(l.start_property || undefined, (v) => putLayer(l.id, { start_property: v ?? "" }), timeProps, "Choose…", "Start time property")}</Field>
                {l.puck_type !== "event" && <Field label="End time property" hint="A date property includes its day.">{propSel(l.end_property, (v) => putLayer(l.id, { end_property: v }), timeProps, "Choose…", "End time property")}</Field>}
                {l.puck_type === "standard" && (
                  <Field label="Dependency property" hint="An array (or comma-separated) property of the primary keys, in this layer, of the tasks this one waits for.">
                    {propSel(l.dependency_property, (v) => putLayer(l.id, { dependency_property: v }), props.filter((p) => p.type === "string_array" || p.type === "string" || p.array), "None", "Dependency property")}
                  </Field>
                )}
                <Field label="Label property" hint="None: the object's title.">{propSel(l.label_property, (v) => putLayer(l.id, { label_property: v }), props, "None", "Label property")}</Field>
                {l.puck_type === "standard" && (
                  <Field label="Progress property" hint="A number, 0–1 or 0–100: filled on the bar and rolled up on the group rows.">
                    {propSel(l.progress_property, (v) => putLayer(l.id, { progress_property: v }), props.filter((p) => p.type === "integer" || p.type === "double"), "None", "Progress property")}
                  </Field>
                )}
                <Field label="Object set (a variable)" hint="None: every object of the type. An object set / array variable of primary keys; an empty one shows none.">
                  {varSel(l.object_set_variable, (v) => putLayer(l.id, { object_set_variable: v }), ["object_set", "array", "string"], "None", "Object set variable")}
                </Field>
                <Field label="Object set filter (a variable)" hint="Only the objects that pass this filter variable.">
                  {varSel(l.filter_variable, (v) => putLayer(l.id, { filter_variable: v }), ["object_set_filter", "object_set", "array"], "None", "Filter variable")}
                </Field>
                <Field label="Detail properties" hint="Shown on the detail card of a selected puck (none chosen: the first twelve).">
                  <select multiple value={l.detail_properties ?? []} onChange={(e) => putLayer(l.id, { detail_properties: [...e.target.selectedOptions].map((o) => o.value) })} className={`${inputClass} h-20`} aria-label="Detail properties">
                    {props.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
                  </select>
                </Field>
                <Field label="Color" hint="Static: one color for the layer. Rules (top first): the first one that matches colors the puck; 'violation' matches a broken dependency.">
                  <div className="space-y-1">
                    <input type="color" value={l.color ?? PALETTE[layers.indexOf(l) % PALETTE.length]} onChange={(e) => putLayer(l.id, { color: e.target.value })} aria-label="Layer color" />
                    {rules.map((r, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <input value={r.name} onChange={(e) => putRule(i, { name: e.target.value })} placeholder="Rule name" className={inputClass} aria-label="Rule name" />
                        {r.operator !== "violation" && propSel(r.property, (v) => putRule(i, { property: v }), props, "Property", "Rule property")}
                        <select value={r.operator} onChange={(e) => putRule(i, { operator: e.target.value as ColorRule["operator"] })} className={inputClass} aria-label="Rule operator">
                          {OPERATORS.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                        {!["empty", "not_empty", "violation"].includes(r.operator) && <input value={String(r.value ?? "")} onChange={(e) => putRule(i, { value: e.target.value })} placeholder="Value" className={inputClass} aria-label="Rule value" />}
                        <input type="color" value={r.color} onChange={(e) => putRule(i, { color: e.target.value })} aria-label="Rule color" />
                        <button type="button" onClick={() => putLayer(l.id, { color_rules: rules.filter((_, j) => j !== i) })} aria-label="Remove the rule" className="text-muted hover:text-bad">
                          <Icon name="x" className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => putLayer(l.id, { color_rules: [...rules, { name: `Rule ${rules.length + 1}`, operator: "=", color: "#ef4444" }] })} className="text-ocean hover:underline">
                      + Color rule
                    </button>
                  </div>
                </Field>
                {l.puck_type !== "background" && (
                  <Field label="Save handler action" hint="Runs when a puck is dragged or resized: an action on this object type taking the object and parameters with the start / end property ids (a dependency parameter keeps its value). None: the layer cannot be moved.">
                    <select value={l.save_action_id ?? ""} onChange={(e) => putLayer(l.id, { save_action_id: e.target.value || undefined })} className={inputClass} aria-label="Save handler action">
                      <option value="">None</option>
                      {actions.filter((a) => a.object_type_id === l.object_type_id).map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
                    </select>
                  </Field>
                )}
              </>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => {
          const id = `layer-${Date.now().toString(36)}`;
          set({ ps_layers: [...layers, { id, object_type_id: "", puck_type: layers.length ? "event" : "standard", start_property: "" }] });
          setOpenLayer(id);
        }}
        className="text-ocean hover:underline"
        data-ps-add-layer
      >
        + Layer
      </button>
      <Field label="Grouping properties" hint="Nest the rows by these properties (the first is the outermost), each sorted ascending or descending; group rows roll up their tasks.">
        <div className="space-y-1">
          {grouping.map((g, i) => (
            <div key={i} className="flex items-center gap-1">
              <select value={g.property} onChange={(e) => set({ ps_grouping: grouping.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)) })} className={inputClass} aria-label="Grouping property">
                <option value="">Choose…</option>
                {groupProps.map((p) => <option key={p} value={p}>{p}</option>)}
                {g.property && !groupProps.includes(g.property) && <option value={g.property}>{g.property}</option>}
              </select>
              <select value={g.descending ? "desc" : "asc"} onChange={(e) => set({ ps_grouping: grouping.map((x, j) => (j === i ? { ...x, descending: e.target.value === "desc" || undefined } : x)) })} className={inputClass} aria-label="Sort direction">
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
              <button type="button" onClick={() => set({ ps_grouping: grouping.length > 1 ? grouping.filter((_, j) => j !== i) : undefined })} aria-label="Remove the grouping property" className="text-muted hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => set({ ps_grouping: [...grouping, { property: "" }] })} className="text-ocean hover:underline">
            + Grouping property
          </button>
        </div>
      </Field>
      <div className="font-semibold uppercase tracking-wide text-muted">Timeline</div>
      {date("start", "Start", "Empty: a few days before the earliest puck.")}
      {date("end", "End", "Empty: a few days after the latest puck. A date (not a timestamp) includes that day.")}
      <Field label="Times shown in">
        <select value={c.ps_timezone ?? "local"} onChange={(e) => set({ ps_timezone: e.target.value === "utc" ? "utc" : undefined })} className={inputClass}>
          <option value="local">The viewer&apos;s time zone</option>
          <option value="utc">UTC</option>
        </select>
      </Field>
      <div className="font-semibold uppercase tracking-wide text-muted">Interface</div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={c.ps_expand_groups !== false} onChange={(e) => set({ ps_expand_groups: e.target.checked ? undefined : false })} /> Expand groups by default
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!c.ps_hide_arrows} onChange={(e) => set({ ps_hide_arrows: e.target.checked || undefined })} /> Hide arrows by default (users can show them)
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!c.ps_show_now} onChange={(e) => set({ ps_show_now: e.target.checked || undefined })} /> Show current time indicator
      </label>
      <div className="font-semibold uppercase tracking-wide text-muted">Editing</div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={c.ps_editable !== false} onChange={(e) => set({ ps_editable: e.target.checked ? undefined : false })} /> Drag and resize pucks (layers with a save handler)
      </label>
      {c.ps_editable !== false && (
        <>
          <Field label="Snap to">
            <select value={c.ps_snap ?? "1d"} onChange={(e) => set({ ps_snap: e.target.value === "1d" ? undefined : (e.target.value as WidgetConfig["ps_snap"]) })} className={inputClass}>
              <option value="1d">Days</option>
              <option value="1h">Hours</option>
              <option value="none">Minutes</option>
            </select>
          </Field>
          <Field label="A move that breaks a dependency" hint="Dependency: a task starts before a task it waits for ends.">
            <select value={c.ps_dependency_mode ?? "warn"} onChange={(e) => set({ ps_dependency_mode: e.target.value === "warn" ? undefined : (e.target.value as WidgetConfig["ps_dependency_mode"]) })} className={inputClass} data-ps-mode-config>
              <option value="warn">Is kept, and the dependency is marked broken</option>
              <option value="block">Is refused</option>
              <option value="push">Pushes the tasks waiting for it later (a start before a predecessor&apos;s end is refused)</option>
            </select>
          </Field>
          <Field label="Scenario (a variable holding a scenario id)" hint="Set: every move is staged in that scenario at once (undo in Staged changes) and the data is shown as it is there. None: moves wait for Save changes.">
            {varSel(c.ps_scenario_variable, (v) => set({ ps_scenario_variable: v }), ["scenario", "string"])}
          </Field>
        </>
      )}
      <div className="font-semibold uppercase tracking-wide text-muted">Output</div>
      <Field label="Selected objects (an object set, array or string variable)" hint="Ctrl + click selects several pucks of one layer. The first is also the module's selected object of its type.">
        {varSel(c.ps_selected_variable, (v) => set({ ps_selected_variable: v }), ["object_set", "array", "string"])}
      </Field>
      <Field label="Selected objects (an object set filter variable)" hint="Nothing selected: no filter.">
        {varSel(c.ps_selected_filter_variable, (v) => set({ ps_selected_filter_variable: v }), ["object_set_filter"])}
      </Field>
      <EventsEditor events={c.ps_events ?? []} mod={mod} onChange={(ev) => set({ ps_events: ev.length ? ev : undefined })} label="On selection change" />
      <Field label="Right-click menu" hint="Built in: select, highlight the dependency chain, Object View. An action opens its form on the puck (start and end filled in); events run in the module.">
        <div className="space-y-2">
          {menu.map((m, i) => (
            <div key={i} className="space-y-1 rounded border border-line p-1.5">
              <div className="flex items-center gap-1">
                <input value={m.label} onChange={(e) => putMenu(i, { label: e.target.value })} placeholder="Menu label" className={inputClass} aria-label="Menu label" />
                <select value={m.events ? "events" : "action"} onChange={(e) => putMenu(i, e.target.value === "events" ? { action_id: undefined, events: [] as WsEvent[] } : { events: undefined })} className={inputClass} aria-label="Menu item kind">
                  <option value="action">Action</option>
                  <option value="events">Workshop events</option>
                </select>
                <button type="button" onClick={() => set({ ps_puck_menu: menu.length > 1 ? menu.filter((_, j) => j !== i) : undefined })} aria-label="Remove the menu item" className="text-muted hover:text-bad">
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </div>
              {m.events ? (
                <EventsEditor events={m.events} mod={mod} onChange={(ev) => putMenu(i, { events: ev })} label="Runs" />
              ) : (
                <select value={m.action_id ?? ""} onChange={(e) => putMenu(i, { action_id: e.target.value || undefined })} className={inputClass} aria-label="Menu action">
                  <option value="">Choose an action…</option>
                  {actions.filter((a) => layerTypes.has(a.object_type_id)).map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
                </select>
              )}
            </div>
          ))}
          <button type="button" onClick={() => set({ ps_puck_menu: [...menu, { label: "" }] })} className="text-ocean hover:underline">
            + Menu item
          </button>
        </div>
      </Field>
    </div>
  );
}
