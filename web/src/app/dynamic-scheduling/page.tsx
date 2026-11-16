"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { scenarios } from "@/lib/scenarios";
import { LAYER_OPERATORS, scheduling, type Board, type BoardData, type Puck, type Row, type Slot, type StyleLayer } from "@/lib/scheduling";

const ROW_H = 46;
const LABEL_W = 220;
const PALETTE = ["#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#60a5fa"];
const ms = (iso: string) => new Date(iso).getTime();
/** The row's primary key if the puck sits on that row (in the row's section). */
const onRow = (p: Puck, r: Row, primary: string) => (r.dimension === primary ? p.resource : p.resources?.[r.dimension]) === r.primary_key;
const fmtTime = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Dynamic Scheduling: a scheduling Gantt chart of schedule objects (pucks) on resource rows. Drag pucks in time and
 * between rows (the save handler runs, staged in a scenario until submitted), see validation rules, suggestions for a
 * selected puck, auto-assign unassigned pucks, inline metrics, and a calendar view.
 */
export default function DynamicSchedulingPage() {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [bid, setBid] = useState<string | null>(null);
  const [data, setData] = useState<BoardData | null>(null);
  const [session, setSession] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [slots, setSlots] = useState<Record<string, Slot[]> | null>(null);
  const [view, setView] = useState<"gantt" | "calendar" | "rules" | "layers">("gantt");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    scheduling.boards().then(
      (b) => {
        setBoards(b);
        setBid((cur) => cur ?? b[0]?.id ?? null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  const load = useCallback(() => {
    if (!bid) return;
    scheduling.data(bid, session?.id).then(
      (d) => (setData(d), setError(null)),
      (e: Error) => setError(e.message),
    );
  }, [bid, session]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!bid || !selected) return;
    scheduling.suggest(bid, selected, session?.id).then((r) => setSlots(r.slots), () => setSlots(null));
  }, [bid, selected, session, data?.pucks.length]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const move = (primary_key: string, c: { resource?: string | null; dimension?: string; start?: string; end?: string }) =>
    act(async () => {
      if (!bid) return;
      setData(await scheduling.move(bid, { primary_key, ...c, scenario_id: session?.id }));
      if (selected) setSlots((await scheduling.suggest(bid, selected, session?.id)).slots);
    });

  if (error && !boards) return <ApiError message={error} />;
  if (!boards) return <Loading />;
  const b = data?.board;
  const selPuck = data?.pucks.find((p) => p.id === selected);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Dynamic Scheduling" icon="clock" href="/dynamic-scheduling" crumbs={b ? [{ label: b.name }] : []}>
        {b && !session && (
          <button type="button" disabled={busy} onClick={() => act(async () => setSession(await scheduling.session(b.id)))} className={buttonClass.secondary}>
            <Icon name="split" className="h-3.5 w-3.5" /> Start editing (scenario)
          </button>
        )}
        {b && session && (
          <>
            <span className="text-xs text-warn">Staged in {session.name}</span>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!(await confirmDialog({ message: "Discard every staged change?", danger: true, confirmLabel: "Discard" }))) return;
                await act(async () => {
                  await scenarios.remove(session.id);
                  setSession(null);
                });
              }}
              className={buttonClass.ghost}
            >
              Discard
            </button>
            <button
              type="button"
              disabled={busy || (data?.hard_violations ?? 0) > 0}
              title={(data?.hard_violations ?? 0) > 0 ? "Fix the hard rule violations first" : undefined}
              onClick={() =>
                act(async () => {
                  await scheduling.submit(b.id, session.id);
                  setSession(null);
                })
              }
              className={buttonClass.primary}
            >
              <Icon name="check" className="h-3.5 w-3.5" /> Submit changes
            </button>
          </>
        )}
        {b && (
          <button
            type="button"
            disabled={busy || !data?.unassigned.length}
            onClick={() =>
              act(async () => {
                if (!session && !(await confirmDialog({ message: "Auto-assign writes to the Nexus directly. Start editing in a scenario first to review the result?", confirmLabel: "Assign now" }))) return;
                await scheduling.search(b.id, true, session?.id);
                load();
              })
            }
            className={buttonClass.secondary}
          >
            <Icon name="sparkle" className="h-3.5 w-3.5" /> Auto-assign {data?.unassigned.length ? `(${data.unassigned.length})` : ""}
          </button>
        )}
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Boards</div>
          {boards.map((x) => (
            <button key={x.id} type="button" onClick={() => (setBid(x.id), setSession(null), setSelected(null))} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${bid === x.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
              <Icon name="clock" className="h-3.5 w-3.5 text-ocean" /> <span className="min-w-0 flex-1 truncate">{x.name}</span>
            </button>
          ))}
          {!boards.length && <div className="px-2 text-xs text-muted">No boards yet. A board pairs a schedule object type with a resource object type and a save handler action.</div>}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col bg-ink">
          {data && b ? (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-3 py-2 text-xs">
                {(["gantt", "calendar", "rules", "layers"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setView(v)} className={`capitalize ${view === v ? "text-white" : "text-muted"}`}>
                    {v}
                  </button>
                ))}
                <span className="ml-auto text-muted">
                  {data.pucks.length} schedule objects · {data.unassigned.length} unassigned ·{" "}
                  <span className={data.hard_violations ? "text-bad" : "text-ok"}>{data.hard_violations} hard violations</span>
                </span>
              </div>
              <ErrorBox message={error} />
              {view === "gantt" && <Gantt data={data} selected={selected} setSelected={setSelected} slots={slots} move={move} />}
              {view === "calendar" && <Calendar data={data} onPick={setSelected} />}
              {view === "layers" && (
                <Layers
                  data={data}
                  save={(style_layers) =>
                    act(async () => {
                      const { id, ...rest } = { ...b, style_layers };
                      await scheduling.save(id, rest);
                      load();
                    })
                  }
                />
              )}
              {view === "rules" && (
                <div className="space-y-2 p-4 text-xs">
                  {b.rules.map((r, i) => (
                    <label key={r.id} className="flex items-center gap-2 rounded border border-line bg-panel px-3 py-2">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) =>
                          act(async () => {
                            const next = { ...b, rules: b.rules.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)) };
                            const { id, ...rest } = next;
                            await scheduling.save(id, rest);
                            load();
                          })
                        }
                      />
                      <span className={r.constraint === "HARD" ? "text-bad" : "text-warn"}>{r.constraint === "HARD" ? "●" : "▲"}</span>
                      <span className="flex-1">{r.name}</span>
                      <span className="text-muted">{r.kind}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted">{bid ? <Loading /> : "Pick a board."}</div>
          )}
        </main>
        {data && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-line bg-panel p-3 text-xs">
            {selPuck ? (
              <div className="space-y-2">
                <div className="text-sm font-medium">{selPuck.title}</div>
                <div className="text-muted">{selPuck.start && selPuck.end ? `${fmtTime(selPuck.start)} → ${fmtTime(selPuck.end)}` : "No time"}</div>
                {[data.board.resource_property, ...(data.board.extra_resources ?? []).map((x) => x.resource_property)].map((dim) => {
                  const pk = dim === data.board.resource_property ? selPuck.resource : selPuck.resources?.[dim];
                  const row = data.rows.find((r) => r.dimension === dim && r.primary_key === pk);
                  return (
                    <div key={dim} className="flex items-center gap-2">
                      <span className="flex-1">
                        {data.rows.find((r) => r.dimension === dim)?.section ?? dim}: {row?.title ?? "unassigned"}
                      </span>
                      {row && dim !== data.board.resource_property && (
                        <button type="button" onClick={() => move(selPuck.id, { resource: "", dimension: dim })} className="text-muted hover:text-bad">
                          Clear
                        </button>
                      )}
                    </div>
                  );
                })}
                {selPuck.style && (
                  <div className="flex items-center gap-1.5 text-muted">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: selPuck.style.color }} /> Layer: {selPuck.style.name}
                  </div>
                )}
                {selPuck.fixed && <div className="text-muted">Fixed duration</div>}
                {selPuck.violations.map((v, i) => (
                  <div key={i} className={`rounded px-2 py-1 ${v.constraint === "HARD" ? "bg-bad/10 text-bad" : "bg-warn/10 text-warn"}`}>
                    {v.name}: {v.details}
                  </div>
                ))}
                <div className="text-muted">Suggestions are highlighted on the rows: green fits every rule, amber breaks soft rules, red breaks hard rules. Click a green slot to place it.</div>
                {selPuck.resource && (
                  <button type="button" onClick={() => move(selPuck.id, { resource: "" })} className={buttonClass.ghost}>
                    Unassign
                  </button>
                )}
                <Link href={`/ontology/objects/${data.board.schedule_object_type_id}/${encodeURIComponent(selPuck.id)}`} className="block text-ocean">
                  Object View
                </Link>
                <button type="button" onClick={() => setSelected(null)} className={buttonClass.ghost}>
                  Clear selection
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="font-medium">Unassigned ({data.unassigned.length})</div>
                {data.unassigned.map((id) => {
                  const p = data.pucks.find((x) => x.id === id)!;
                  return (
                    <button key={id} type="button" onClick={() => setSelected(id)} className="block w-full truncate rounded border border-line px-2 py-1.5 text-left hover:bg-panel-2">
                      {p.title}
                    </button>
                  );
                })}
                {!data.unassigned.length && <div className="text-muted">Every schedule object is assigned.</div>}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function Gantt({
  data,
  selected,
  setSelected,
  slots,
  move,
}: {
  data: BoardData;
  selected: string | null;
  setSelected: (id: string | null) => void;
  slots: Record<string, Slot[]> | null;
  move: (id: string, c: { resource?: string | null; dimension?: string; start?: string; end?: string }) => void;
}) {
  const b = data.board;
  const t0 = ms(b.timeline_start);
  const t1 = ms(b.timeline_end);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(500, el.clientWidth - LABEL_W - 20)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * width;
  const days = useMemo(() => {
    const out: number[] = [];
    for (let t = t0; t < t1; t += 86_400_000) out.push(t);
    return out;
  }, [t0, t1]);
  const colorOf = useMemo(() => {
    const vals = [...new Set(data.pucks.map((p) => String(p.color ?? "")))];
    return (v: unknown) => PALETTE[vals.indexOf(String(v ?? "")) % PALETTE.length];
  }, [data.pucks]);
  const drag = useRef<{ id: string; row: string; sx: number; sy: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ id: string; row: string; dx: number; dy: number } | null>(null);
  const rows = data.rows;
  const sections = new Set(rows.map((r) => r.dimension)).size;
  return (
    <div ref={host} className="min-h-0 flex-1 overflow-auto">
      <div style={{ width: LABEL_W + width + 20 }}>
        <div className="sticky top-0 z-10 flex border-b border-line bg-panel text-[11px]">
          <div style={{ width: LABEL_W }} className="shrink-0 px-3 py-1.5 text-muted">
            Resource · utilization
          </div>
          <div className="relative h-10" style={{ width }}>
            {days.map((d) => (
              <div key={d} className="absolute top-0 h-full border-l border-line px-1" style={{ left: x(d), width: x(d + 86_400_000) - x(d) }}>
                <div className="font-medium">{new Date(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
                <div className="text-muted">{data.metrics.per_day[new Date(d).toISOString().slice(0, 10)] ?? 0} scheduled</div>
              </div>
            ))}
          </div>
        </div>
        {rows.map((r, ri) => (
          <div key={r.key}>
          {sections > 1 && (ri === 0 || rows[ri - 1].dimension !== r.dimension) && (
            <div className="border-b border-line bg-panel-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{r.section}</div>
          )}
          <div data-row={ri} className="flex border-b border-line" style={{ height: ROW_H }}>
            <div style={{ width: LABEL_W }} className="flex shrink-0 flex-col justify-center px-3 text-xs">
              <span className="truncate font-medium">{r.title}</span>
              <span className="truncate text-[10px] text-muted">
                {b.row_properties.map((k) => String(r.properties[k] ?? "")).join(" · ")} · {data.metrics.row_utilization[r.key] ?? 0}%
              </span>
            </div>
            <div className="relative" style={{ width }}>
              {days.map((d) => (
                <div key={d} className="absolute top-0 h-full border-l border-line/60" style={{ left: x(d) }} />
              ))}
              {(slots?.[r.key] ?? []).map((s, i) => (
                <button
                  key={i}
                  type="button"
                  title={s.breaks.length ? `Breaks: ${s.breaks.join(", ")}` : "Fits every rule"}
                  onClick={() => selected && s.rating > -1 && move(selected, { resource: r.primary_key, dimension: r.dimension, start: s.start, end: undefined })}
                  className="absolute top-1 h-[calc(100%-8px)] rounded-sm"
                  style={{ left: x(ms(s.start)), width: Math.max(2, x(ms(s.end)) - x(ms(s.start))), background: s.rating >= 1 ? "rgba(52,211,153,0.18)" : s.rating > -1 ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.08)" }}
                />
              ))}
              {data.pucks
                .filter((p) => onRow(p, r, b.resource_property) && p.start && p.end)
                .map((p) => {
                  const g = ghost?.id === p.id && ghost.row === r.key ? ghost : null;
                  const hard = p.violations.some((v) => v.constraint === "HARD");
                  const soft = p.violations.some((v) => v.constraint === "SOFT");
                  return (
                    <div
                      key={p.id}
                      title={`${p.title}${p.style ? ` · ${p.style.name}` : ""}\n${fmtTime(p.start!)} → ${fmtTime(p.end!)}${p.violations.map((v) => `\n${v.constraint}: ${v.name} (${v.details})`).join("")}`}
                      onPointerDown={(e) => {
                        drag.current = { id: p.id, row: r.key, sx: e.clientX, sy: e.clientY, moved: false };
                        (e.target as Element).setPointerCapture?.(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const d = drag.current;
                        if (!d || d.id !== p.id || d.row !== r.key) return;
                        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) d.moved = true;
                        if (d.moved) setGhost({ id: p.id, row: r.key, dx: e.clientX - d.sx, dy: e.clientY - d.sy });
                      }}
                      onPointerUp={(e) => {
                        const d = drag.current;
                        drag.current = null;
                        setGhost(null);
                        if (!d) return;
                        if (!d.moved) return setSelected(p.id === selected ? null : p.id);
                        const dt = ((e.clientX - d.sx) / width) * (t1 - t0);
                        // the row under the pointer (section headers sit between rows); a drop onto another section assigns its row
                        const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLElement && el.dataset.row !== undefined) as HTMLElement | undefined;
                        const target = rows[under ? Number(under.dataset.row) : ri] ?? r;
                        move(p.id, { resource: target.primary_key, dimension: target.dimension, start: new Date(ms(p.start!) + dt).toISOString() });
                      }}
                      className={`absolute top-1 flex h-[calc(100%-8px)] cursor-grab select-none items-center gap-1 overflow-hidden rounded px-1.5 text-[11px] text-ink shadow ${selected === p.id ? "ring-2 ring-white" : ""}`}
                      style={{
                        left: x(ms(p.start!)) + (g?.dx ?? 0),
                        top: 4 + (g?.dy ?? 0),
                        width: Math.max(8, x(ms(p.end!)) - x(ms(p.start!))),
                        background: p.style?.color ?? colorOf(p.color),
                        opacity: g ? 0.8 : 1,
                        zIndex: g ? 20 : 1,
                      }}
                    >
                      {hard && <span className="rounded-full bg-bad px-1 text-[9px] font-bold text-white">!</span>}
                      {!hard && soft && <span className="text-[10px] text-warn">▲</span>}
                      <span className="truncate font-medium">{p.title}</span>
                    </div>
                  );
                })}
            </div>
          </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Puck styling layers: conditions on schedule properties or rule violations, each with a color; the first match wins. */
function Layers({ data, save }: { data: BoardData; save: (layers: StyleLayer[]) => void }) {
  const layers = data.board.style_layers ?? [];
  const props = useMemo(() => [...new Set(data.pucks.flatMap((p) => Object.keys(p.properties)))].sort(), [data.pucks]);
  const set = (i: number, patch: Partial<StyleLayer>) => save(layers.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const swap = (i: number, j: number) => {
    const next = [...layers];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const field = "rounded border border-line bg-ink px-2 py-1";
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 text-xs">
      <p className="text-muted">The first enabled layer (top first) whose condition a puck meets gives it its color; pucks no layer matches keep the board&apos;s color property.</p>
      {layers.map((l, i) => (
        <div key={l.id} className="flex flex-wrap items-center gap-2 rounded border border-line bg-panel px-3 py-2">
          <input type="checkbox" checked={l.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label="Layer enabled" />
          <input type="color" value={l.color} onChange={(e) => set(i, { color: e.target.value })} className="h-6 w-8 bg-transparent" aria-label="Layer color" />
          <input key={`n-${l.name}`} defaultValue={l.name} onBlur={(e) => e.target.value && e.target.value !== l.name && set(i, { name: e.target.value })} className={`${field} w-44`} aria-label="Layer name" />
          {l.operator !== "violation" && (
            <select value={l.property ?? ""} onChange={(e) => set(i, { property: e.target.value })} className={field} aria-label="Property">
              {props.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          )}
          <select
            value={l.operator}
            onChange={(e) => {
              const operator = e.target.value as StyleLayer["operator"];
              set(i, operator === "violation" ? { operator, property: null, value: "" } : { operator, property: l.property ?? props[0] ?? null });
            }}
            className={field}
            aria-label="Condition"
          >
            {LAYER_OPERATORS.map((o) => (
              <option key={o} value={o}>
                {o === "violation" ? "breaks a rule" : o === "empty" ? "is empty" : o === "not_empty" ? "has a value" : o}
              </option>
            ))}
          </select>
          {l.operator === "violation" ? (
            <select value={String(l.value ?? "")} onChange={(e) => set(i, { value: e.target.value })} className={field} aria-label="Rule constraint">
              <option value="">any rule</option>
              <option value="HARD">a hard rule</option>
              <option value="SOFT">a soft rule</option>
            </select>
          ) : (
            l.operator !== "empty" && l.operator !== "not_empty" && (
              <input key={`v-${String(l.value ?? "")}`} defaultValue={String(l.value ?? "")} onBlur={(e) => e.target.value !== String(l.value ?? "") && set(i, { value: e.target.value })} placeholder="value" className={`${field} w-32`} aria-label="Value" />
            )
          )}
          <span className="ml-auto text-muted">{data.pucks.filter((p) => p.style?.layer === l.id).length} pucks</span>
          <button type="button" disabled={i === 0} onClick={() => swap(i, i - 1)} className="text-muted hover:text-white disabled:opacity-30" aria-label="Move up">
            ↑
          </button>
          <button type="button" disabled={i === layers.length - 1} onClick={() => swap(i, i + 1)} className="text-muted hover:text-white disabled:opacity-30" aria-label="Move down">
            ↓
          </button>
          <button type="button" onClick={() => save(layers.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Delete layer">
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={!props.length}
        onClick={() => save([...layers, { id: `l-${crypto.randomUUID().slice(0, 6)}`, name: `Layer ${layers.length + 1}`, operator: "=", property: props[0], value: "", color: PALETTE[layers.length % PALETTE.length], enabled: true }])}
        className={buttonClass.secondary}
      >
        <Icon name="plus" className="h-3.5 w-3.5" /> Layer
      </button>
    </div>
  );
}

function Calendar({ data, onPick }: { data: BoardData; onPick: (id: string) => void }) {
  const byDay = new Map<string, Puck[]>();
  for (const p of data.pucks.filter((x) => x.start && x.resource)) {
    const d = p.start!.slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }
  return (
    <div className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto p-4 text-xs md:grid-cols-5">
      {[...byDay.entries()]
        .sort()
        .map(([d, ps]) => (
          <div key={d} className="rounded-lg border border-line bg-panel">
            <div className="border-b border-line px-3 py-1.5 font-medium">{new Date(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</div>
            {ps
              .sort((a, b) => a.start!.localeCompare(b.start!))
              .map((p) => (
                <button key={p.id} type="button" onClick={() => onPick(p.id)} className="block w-full border-b border-line/50 px-3 py-1.5 text-left hover:bg-panel-2">
                  <div className="text-muted">
                    {new Date(p.start!).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · {data.rows.find((r) => r.primary_key === p.resource)?.title}
                  </div>
                  <div className="truncate">{p.title}</div>
                </button>
              ))}
          </div>
        ))}
    </div>
  );
}
