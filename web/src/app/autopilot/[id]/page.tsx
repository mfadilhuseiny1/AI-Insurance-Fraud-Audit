"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { autopilot, type AutoEvent, type Board, type Card, type Graph, type Positions, type State, type Timeline, type Workbench } from "@/lib/autopilot";
import { when } from "@/lib/format";
import { ontology, type Automation } from "@/lib/ontology";
import { workshop, type ObjectTypeSource } from "@/lib/workshop";

type View = "kanban" | "graph" | "split" | "events";
const fmtV = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? v.toLocaleString() : typeof v === "object" ? JSON.stringify(v) : String(v));

export default function WorkbenchPage() {
  const { id } = useParams<{ id: string }>();
  const [wb, setWb] = useState<Workbench | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [view, setView] = useState<View>("kanban");
  const [sel, setSel] = useState<{ typeId: string; card: Card } | null>(null);
  const [linked, setLinked] = useState<{ key: string; title: string } | null>(null);
  const [stateEdit, setStateEdit] = useState<State | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [notifying, setNotifying] = useState(false);
  const [autos, setAutos] = useState<Automation[]>([]);
  const [types, setTypes] = useState<ObjectTypeSource[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    autopilot.get(id).then(setWb, (e: Error) => setErr(e.message));
    ontology.automations().then(setAutos, () => {});
    workshop.sources().then((s) => setTypes(s.object_types), () => {});
  }, [id, nonce]);
  useEffect(() => {
    autopilot.board(id, linked?.key).then(setBoard, (e: Error) => setErr(e.message));
    autopilot.graph(id).then(setGraph, () => {});
  }, [id, linked, nonce]);
  // live: refresh while automations run
  useEffect(() => {
    if (!board?.live_automations.length) return;
    const t = setInterval(() => setNonce((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [board?.live_automations.length]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearch("");
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const saveStates = async (states: State[]) => setWb(await autopilot.update(id, { states }));
  const onLayout = useCallback((layout: Workbench["layout"]) => setWb((w) => w && { ...w, layout }), []);
  if (err) return <p className="p-8 text-sm text-bad">{err}</p>;
  if (!wb) return <p className="p-8 text-sm text-muted">Loading…</p>;
  const found = search
    ? board?.columns.flatMap((c) => c.cards.filter((k) => k.title.toLowerCase().includes(search.toLowerCase()) || k.pk.toLowerCase().includes(search.toLowerCase())).map((k) => ({ c, k }))).slice(0, 12) ?? []
    : [];
  return (
    <div className="flex h-full flex-col">
      <AppHeader app="Autopilot" icon="grid" href="/autopilot" crumbs={[{ label: wb.name }]}>
        <div className="flex rounded border border-line-2 text-xs">
          {(["kanban", "graph", "split", "events"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`px-2.5 py-1 capitalize ${view === v ? "bg-ocean/15 text-white" : "text-muted"}`}>
              {v === "events" ? "Automation events" : v}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => (setSearch(""), setTimeout(() => searchRef.current?.focus(), 0))} className={buttonClass.secondary} title="Search (Ctrl+F)">
          <Icon name="search" className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setNotifying(true)} className={`${buttonClass.secondary} ${wb.subscribed ? "text-ocean" : ""}`} title="Alert notifications" data-notify-button>
          <Icon name="bell" className="h-3.5 w-3.5" />
          {wb.subscribers.length > 0 && <span className="ml-1 text-[10px]">{wb.subscribers.length}</span>}
        </button>
        {board && board.live_automations.length > 0 && <span className="flex items-center gap-1 text-xs text-ocean"><Icon name="refresh" className="h-3.5 w-3.5 animate-spin" /> running</span>}
      </AppHeader>
      {wb.alerts.length > 0 && (
        <div className="space-y-1 border-b border-line bg-warn/5 px-4 py-2 text-xs">
          {wb.alerts.map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-warn">
              <Icon name="alert" className="h-3.5 w-3.5" /> {a.text}
              {a.kind === "automations" && a.automation_ids && (
                <button type="button" onClick={async () => (setWb(await autopilot.update(id, { automation_ids: [...wb.automation_ids, ...a.automation_ids!] })), setNonce((n) => n + 1))} className="text-ocean hover:underline">
                  Add them
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {linked && (
        <div className="flex items-center gap-2 border-b border-line bg-ocean/10 px-4 py-1.5 text-xs">
          Showing {linked.title} and its linked objects
          <button type="button" onClick={() => setLinked(null)} className="text-ocean hover:underline">
            Clear
          </button>
        </div>
      )}
      {msg && <div className="border-b border-line px-4 py-1 text-xs text-muted">{msg}</div>}
      <div className="flex min-h-0 flex-1">
        <StatesSidebar wb={wb} types={types} focus={focus} onFocus={setFocus} onEdit={setStateEdit} onSave={saveStates} onInfer={async () => (setWb(await autopilot.infer(id)), setNonce((n) => n + 1))} />
        <div className="flex min-w-0 flex-1 flex-col">
          {(view === "kanban" || view === "split") && board && (
            <div className={`${view === "split" ? "h-1/2" : "flex-1"} min-h-0 overflow-auto`}>
              <Kanban
                wb={wb}
                board={board}
                autos={autos}
                focus={focus}
                onOpen={(typeId, card) => setSel({ typeId, card })}
                onLinked={(typeId, card) => setLinked({ key: `${typeId}|${card.pk}`, title: card.title })}
                onRetry={async (aid, pks) => {
                  const r = await autopilot.retry(id, aid, pks);
                  setMsg(`${r.succeeded} of ${r.runs.length} runs succeeded${r.runs.find((x) => x.error) ? `: ${r.runs.find((x) => x.error)!.error}` : ""}`);
                  setNonce((n) => n + 1);
                }}
                onState={setStateEdit}
              />
            </div>
          )}
          {(view === "graph" || view === "split") && graph && (
            <div className={`${view === "split" ? "h-1/2 border-t border-line" : "flex-1"} min-h-0 overflow-auto`}>
              <GraphView
                wb={wb}
                graph={graph}
                focus={focus}
                onRemove={async (nid) => (setWb(await autopilot.update(id, { removed_nodes: [...(wb.removed_nodes ?? []), nid] })), setNonce((n) => n + 1))}
                onLayout={onLayout}
              />
            </div>
          )}
          {view === "events" && <Events wb={wb} onOpen={(pk) => { const c = board?.columns.flatMap((x) => x.cards.map((k) => ({ x, k }))).find((y) => y.k.pk === pk); if (c) setSel({ typeId: c.x.object_type_id, card: c.k }); }} />}
        </div>
        {sel && <ObjectPanel wb={wb} sel={sel} onClose={() => setSel(null)} />}
      </div>
      {search !== null && (
        <Modal title="Find an object" icon="search" onClose={() => setSearch(null)}>
          <div className="p-3 text-sm">
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title or primary key" className={inputClass} />
            <div className="mt-2 max-h-72 overflow-auto">
              {found.map(({ c, k }) => (
                <button key={`${c.id}:${k.pk}`} type="button" onClick={() => (setSel({ typeId: c.object_type_id, card: k }), setSearch(null))} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                  <span className="flex-1 truncate">{k.title}</span>
                  <span className="text-xs text-muted">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {notifying && <NotifyDialog wb={wb} onChange={setWb} onClose={() => setNotifying(false)} />}
      {stateEdit && (
        <StateDialog
          state={stateEdit}
          types={types}
          onClose={() => setStateEdit(null)}
          onSave={async (s) => {
            const exists = wb.states.some((x) => x.id === s.id);
            await saveStates(exists ? wb.states.map((x) => (x.id === s.id ? s : x)) : [...wb.states, s]);
            setStateEdit(null);
            setNonce((n) => n + 1);
          }}
          onDelete={async () => {
            await saveStates(wb.states.filter((x) => x.id !== stateEdit.id));
            setStateEdit(null);
            setNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function StatesSidebar({ wb, types, focus, onFocus, onEdit, onSave, onInfer }: { wb: Workbench; types: ObjectTypeSource[]; focus: string | null; onFocus: (id: string | null) => void; onEdit: (s: State) => void; onSave: (s: State[]) => void; onInfer: () => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <aside className="w-56 shrink-0 overflow-auto border-r border-line bg-panel p-2 text-xs">
      <div className="mb-1 flex items-center px-1 text-[11px] uppercase tracking-wider text-muted">
        States
        <button type="button" onClick={onInfer} className="ml-auto normal-case text-ocean" title="Infer the states again">
          Infer
        </button>
      </div>
      {wb.states.map((s, i) => (
        <div
          key={s.id}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (drag === null || drag === i) return;
            const next = [...wb.states];
            const [m] = next.splice(drag, 1);
            next.splice(i, 0, m);
            onSave(next);
            setDrag(null);
          }}
          className={`group flex cursor-grab items-center gap-1.5 rounded px-2 py-1 ${focus === s.id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
          <button type="button" onClick={() => onFocus(focus === s.id ? null : s.id)} className="flex-1 truncate text-left" title="Focus this state">
            {s.name}
          </button>
          <button type="button" onClick={() => onEdit(s)} className="hidden text-muted hover:text-white group-hover:block" aria-label={`Configure ${s.name}`}>
            <Icon name="sliders" className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onEdit({ id: `st-${Date.now().toString(36)}`, name: "New state", object_type_id: wb.object_type_ids[0], property: "", value: "", color: "#64748b", icon: null, card_properties: [] })}
        className="mt-1 px-2 text-ocean"
      >
        + Add state
      </button>
      <div className="mt-4 px-1 text-[11px] uppercase tracking-wider text-muted">Object types</div>
      {wb.object_type_ids.map((t) => (
        <div key={t} className="truncate px-2 py-0.5 text-soft">
          {types.find((x) => x.id === t)?.name ?? t}
        </div>
      ))}
    </aside>
  );
}

function Kanban({ wb, board, autos, focus, onOpen, onLinked, onRetry, onState }: { wb: Workbench; board: Board; autos: Automation[]; focus: string | null; onOpen: (t: string, c: Card) => void; onLinked: (t: string, c: Card) => void; onRetry: (aid: string, pks: string[]) => void; onState: (s: State) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number; typeId: string; card: Card } | null>(null);
  const [bulk, setBulk] = useState<string | null>(null);
  const mine = autos.filter((a) => wb.automation_ids.includes(a.id));
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (focus) refs.current[focus]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [focus]);
  return (
    <div className="flex h-full gap-3 p-3" onClick={() => setMenu(null)}>
      {board.columns.map((c) => (
        <div key={c.id} ref={(el) => void (refs.current[c.id] = el)} className={`flex w-72 shrink-0 flex-col rounded-lg border bg-panel ${focus === c.id ? "border-ocean" : "border-line"}`}>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs" style={{ borderTop: `3px solid ${c.color}` }}>
            <span className="font-medium">{c.name}</span>
            <span className="text-muted">{c.count}</span>
            <span className="truncate text-[10px] text-muted">{c.object_type}</span>
            <div className="relative ml-auto flex items-center gap-1">
              <button type="button" onClick={(e) => (e.stopPropagation(), setBulk(bulk === c.id ? null : c.id))} className="text-muted hover:text-white" title="Execute an automation for all objects">
                <Icon name="bolt" className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => onState(c)} className="text-muted hover:text-white" aria-label="Configure the state">
                <Icon name="sliders" className="h-3.5 w-3.5" />
              </button>
              {bulk === c.id && (
                <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-line bg-panel p-1 shadow-xl" onClick={(e) => e.stopPropagation()}>
                  <div className="px-2 py-1 text-[10px] uppercase text-muted">Execute for all {c.count} objects</div>
                  {mine.map((a) => (
                    <button key={a.id} type="button" onClick={() => window.confirm(`Run "${a.name}" on ${c.count} objects?`) && (onRetry(a.id, c.cards.map((k) => k.pk)), setBulk(null))} className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-panel-2">
                      {a.name}
                    </button>
                  ))}
                  {!mine.length && <div className="px-2 py-1 text-xs text-muted">No automations in the workbench</div>}
                </div>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
            {c.cards.map((k) => (
              <button
                key={k.pk}
                type="button"
                onClick={() => onOpen(c.object_type_id, k)}
                onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, typeId: c.object_type_id, card: k }))}
                data-card={k.pk}
                className="relative block w-full rounded-md border border-line-2 bg-ink p-2 text-left text-xs hover:border-ocean"
              >
                {k.live && <span className="absolute inset-y-0 left-0 w-1 animate-pulse rounded-l bg-ocean" />}
                <div className="truncate font-medium">{k.title}</div>
                {Object.entries(k.properties).map(([p, v]) => (
                  <div key={p} className="flex gap-1 text-[11px]">
                    <span className="truncate text-muted">{p}</span>
                    <span className="ml-auto truncate">{fmtV(v)}</span>
                  </div>
                ))}
                {k.last && (
                  <div className="mt-1 truncate text-[10px] text-muted">
                    {k.last.automated ? "⚡ " + k.last.automated : "👤 " + k.last.user} · {k.last.action} · {when(k.last.at)}
                  </div>
                )}
              </button>
            ))}
            {!c.cards.length && <div className="p-2 text-xs text-muted">No objects</div>}
          </div>
        </div>
      ))}
      {Object.entries(board.unassigned).some(([, n]) => n > 0) && (
        <div className="w-48 shrink-0 rounded-lg border border-dashed border-line p-3 text-xs text-muted">
          Not in any state:
          {Object.entries(board.unassigned).map(([t, n]) => (
            <div key={t}>
              {t}: {n}
            </div>
          ))}
        </div>
      )}
      {menu && (
        <div style={{ left: menu.x, top: menu.y }} className="fixed z-50 w-60 rounded-lg border border-line bg-panel p-1 text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => (onLinked(menu.typeId, menu.card), setMenu(null))} className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2">
            Filter to linked objects
          </button>
          <button type="button" onClick={() => (void navigator.clipboard?.writeText(menu.card.title), setMenu(null))} className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2">
            Copy title
          </button>
          <div className="px-2 pt-1 text-[10px] uppercase text-muted">Retry an automation</div>
          {mine.map((a) => (
            <button key={a.id} type="button" onClick={() => (onRetry(a.id, [menu.card.pk]), setMenu(null))} className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2">
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_COL: Record<string, number> = { workshop: 0, state: 1, automation: 2, action: 3, logic: 3 };
const KIND_COLOR: Record<string, string> = { workshop: "#a855f7", automation: "#3b82f6", action: "#22c55e", logic: "#f59e0b" };

const fmtTokens = (n: number | null | undefined) => (n ? `${n.toLocaleString()} tokens` : "");
// a mouse position in the graph's coordinates
const svgPoint = (svg: SVGSVGElement | null, e: { clientX: number; clientY: number }) => {
  const r = svg?.getBoundingClientRect();
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
};

function GraphView({ wb, graph, focus, onRemove, onLayout }: { wb: Workbench; graph: Graph; focus: string | null; onRemove: (id: string) => void; onLayout: (l: Workbench["layout"]) => void }) {
  const [sel, setSel] = useState<string | null>(focus);
  const [curved, setCurved] = useState(true);
  const [activity, setActivity] = useState<Awaited<ReturnType<typeof autopilot.activity>> | null>(null);
  // where dragged positions are saved: the viewer's own layout (signed in) or the shared one
  const [scope, setScope] = useState<"mine" | "shared">(wb.layout.can_save_mine ? "mine" : "shared");
  // the node being dragged: where it started (sx, sy), the grab offset (dx, dy) and where it is now (x, y)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);
  // positions shown while a save is on its way (the dropped node stays where it was dropped)
  const [pending, setPending] = useState<Positions | null>(null);
  const [layoutErr, setLayoutErr] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const saved = pending ?? wb.layout.mine ?? wb.layout.shared;
  const auto = useMemo(() => {
    const cols: Record<number, number> = {};
    return Object.fromEntries(
      graph.nodes.map((n) => {
        const c = KIND_COL[n.kind] ?? 2;
        const r = (cols[c] = (cols[c] ?? -1) + 1);
        return [n.id, { x: 30 + c * 230, y: 40 + r * 70 }];
      }),
    );
  }, [graph.nodes]);
  const pos: Record<string, { x: number; y: number }> = useMemo(() => {
    const p = Object.fromEntries(graph.nodes.map((n) => [n.id, saved?.[n.id] ?? auto[n.id]]));
    if (drag) p[drag.id] = { x: drag.x, y: drag.y };
    return p;
  }, [graph.nodes, saved, auto, drag]);
  const h = Math.max(260, ...Object.values(pos).map((p) => p.y + 60));
  const wdt = Math.max(4 * 230 + 60, ...Object.values(pos).map((p) => p.x + 200));
  const node = graph.nodes.find((n) => n.id === (sel ?? focus));
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const p = svgPoint(svgRef.current, e);
      const x = Math.max(0, Math.round(p.x - drag.dx));
      const y = Math.max(0, Math.round(p.y - drag.dy));
      if (x !== drag.x || y !== drag.y) setDrag({ ...drag, x, y, moved: drag.moved || Math.abs(x - drag.sx) + Math.abs(y - drag.sy) > 3 });
    };
    const up = () => {
      const d = drag;
      setDrag(null);
      if (!d.moved) return;
      const next = { ...pos, [d.id]: { x: d.x, y: d.y } };
      setPending(next);
      autopilot.saveLayout(wb.id, next, scope).then(
        (l) => (setLayoutErr(null), onLayout(l), setPending(null)),
        (err: Error) => (setLayoutErr(err.message), setPending(null)),
      );
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, pos, scope, wb.id, onLayout]);
  useEffect(() => {
    if (!node || !["automation", "action"].includes(node.kind)) return;
    let stale = false;
    autopilot.activity(wb.id, node.id).then((a) => !stale && setActivity(a), () => {});
    return () => {
      stale = true;
    };
  }, [node, wb.id]);
  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="flex gap-3 px-3 py-1.5 text-[11px] text-muted">
          {["People (Workshop)", "States", "Automations", "Actions & logic"].map((t) => (
            <span key={t} className="w-[230px]">
              {t}
            </span>
          ))}
          <label className="ml-auto flex items-center gap-1">
            <input type="checkbox" checked={curved} onChange={(e) => setCurved(e.target.checked)} /> curved edges
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 pb-1 text-[11px] text-muted" data-layout-bar>
          <span>Drag nodes to arrange them; the layout is saved</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as "mine" | "shared")} className="rounded border border-line-2 bg-panel-2 px-1 py-0.5" aria-label="Save the layout for">
            {wb.layout.can_save_mine && <option value="mine">for me</option>}
            <option value="shared">for everyone (editors)</option>
          </select>
          <span>
            · showing {wb.layout.mine ? "your layout" : wb.layout.shared ? "the shared layout" : "the automatic layout (columns by kind)"}
          </span>
          {(scope === "mine" ? wb.layout.mine : wb.layout.shared) && (
            <button
              type="button"
              onClick={() => autopilot.resetLayout(wb.id, scope).then((l) => (setLayoutErr(null), onLayout(l)), (err: Error) => setLayoutErr(err.message))}
              className="text-ocean hover:underline"
            >
              Reset {scope === "mine" ? "my" : "the shared"} layout
            </button>
          )}
          {layoutErr && <span className="text-bad">{layoutErr}</span>}
        </div>
        <svg ref={svgRef} width={wdt} height={h} className="select-none text-xs">
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-line-2" />
            </marker>
          </defs>
          {graph.edges.map((e, i) => {
            const a = pos[e.from];
            const b = pos[e.to];
            if (!a || !b) return null;
            const x1 = a.x + 180;
            const y1 = a.y + 18;
            const x2 = b.x;
            const y2 = b.y + 18;
            const back = x2 <= x1;
            const d = curved ? `M ${x1} ${y1} C ${x1 + (back ? 80 : 60)} ${y1 + (back ? 40 : 0)}, ${x2 - (back ? 80 : 60)} ${y2 + (back ? 40 : 0)}, ${x2} ${y2}` : `M ${x1} ${y1} H ${(x1 + x2) / 2} V ${y2} H ${x2}`;
            const hot = sel && (e.from === sel || e.to === sel);
            const live = graph.nodes.find((n) => n.id === e.from || n.id === e.to)?.live;
            return (
              <path key={i} d={d} fill="none" markerEnd="url(#arr)" strokeWidth={hot ? 2 : 1.2} strokeDasharray={e.kind === "human" ? "2 3" : e.kind === "leaves" ? "6 3" : live ? "4 4" : undefined}
                className={hot ? "stroke-ocean" : e.kind === "sets" ? "stroke-ok/60" : "stroke-line-2"}>
                {live && <animate attributeName="stroke-dashoffset" from="16" to="0" dur="0.8s" repeatCount="indefinite" />}
              </path>
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos[n.id];
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                onClick={() => setSel(n.id)}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  const q = svgPoint(svgRef.current, e);
                  setDrag({ id: n.id, dx: q.x - p.x, dy: q.y - p.y, sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false });
                }}
                className={drag?.id === n.id ? "cursor-grabbing" : "cursor-pointer"}
                data-node={n.kind}
                data-node-id={n.id}
              >
                <rect width={180} height={36} rx={n.kind === "state" ? 18 : 6} className={`${sel === n.id ? "fill-ocean/25" : "fill-panel-2"} ${n.live ? "stroke-ocean" : "stroke-line-2"}`} strokeWidth={n.live ? 2 : 1} />
                <circle cx={14} cy={18} r={5} fill={n.kind === "state" ? n.color : KIND_COLOR[n.kind]} />
                <text x={26} y={16} className="fill-current">
                  {n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label}
                </text>
                <text x={26} y={29} className="fill-current text-[9px] text-muted">
                  {n.kind}
                  {n.kind === "automation" ? ` · ${n.runs} runs${n.failed ? ` · ${n.failed} failed` : ""}${n.enabled === false ? " · off" : ""}` : ""}
                  {n.kind === "action" ? ` · ${n.automated_runs ?? 0} automated · ${n.manual_runs ?? 0} manual` : ""}
                  {n.kind === "logic" ? ` · ${n.runs ?? 0} runs${n.tokens ? ` · ${n.tokens.toLocaleString()} tok` : ""}` : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {node && (
        <div className="w-72 shrink-0 overflow-auto border-l border-line p-3 text-xs">
          <div className="text-sm font-medium">{node.label}</div>
          <div className="text-muted">{node.kind}</div>
          {node.kind === "logic" && (
            <div className="mt-2" data-logic-usage>
              <div>
                {node.runs ?? 0} run{node.runs === 1 ? "" : "s"} from the workbench&apos;s automations in the last 7 days
              </div>
              <div>Tokens: {node.tokens ? node.tokens.toLocaleString() : "—"}</div>
              <Link href="/logic" className="text-ocean hover:underline">
                Open AIP Logic
              </Link>
            </div>
          )}
          {node.kind !== "state" && (
            <button type="button" onClick={() => onRemove(node.id)} className="mt-1 text-muted hover:text-bad">
              Remove from workbench
            </button>
          )}
          {activity && ["automation", "action"].includes(node.kind) && (
            <>
              <div className="mt-3 font-medium">Resource activity</div>
              {activity.slice(0, 30).map((a, i) => (
                <div key={i} className="border-t border-line py-1">
                  <span className={a.status === "succeeded" ? "text-ok" : "text-bad"}>{a.status}</span> · {when(a.at)} · {a.user}
                  {a.edits.map((e, j) => (
                    <div key={j} className="truncate font-mono text-[10px] text-muted">
                      {e.op} {e.primary_key}
                    </div>
                  ))}
                  {a.error && <div className="text-bad">{a.error}</div>}
                </div>
              ))}
              {!activity.length && <p className="text-muted">No writes yet.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Events({ wb, onOpen }: { wb: Workbench; onOpen: (pk: string) => void }) {
  const [status, setStatus] = useState("");
  const [auto, setAuto] = useState("");
  const [hours, setHours] = useState(168);
  const [data, setData] = useState<Awaited<ReturnType<typeof autopilot.events>> | null>(null);
  const [open, setOpen] = useState<AutoEvent | null>(null);
  const load = useCallback(() => autopilot.events(wb.id, { status, automation_id: auto, hours }).then(setData, () => {}), [wb.id, status, auto, hours]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto p-3 text-xs">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className={`${inputClass.replace("w-full", "")} w-36`}>
            <option value={1}>Last hour</option>
            <option value={24}>Last day</option>
            <option value={168}>Last 7 days</option>
            <option value={720}>Last 30 days</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass.replace("w-full", "")} w-36`}>
            <option value="">All statuses</option>
            {["succeeded", "failed", "skipped", "running"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={auto} onChange={(e) => setAuto(e.target.value)} className={`${inputClass.replace("w-full", "")} w-56`}>
            <option value="">All automations</option>
            {wb.automation_ids.map((a) => (
              <option key={a} value={a}>
                {data?.events.find((e) => e.automation_id === a)?.automation ?? a}
              </option>
            ))}
          </select>
          <span className="text-muted">
            {data?.total ?? 0} events · {Object.entries(data?.by_status ?? {}).map(([k, v]) => `${v} ${k}`).join(" · ")}
            {data?.tokens ? ` · ${fmtTokens(data.tokens)}` : ""}
          </span>
        </div>
        <table className="w-full">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 font-normal">When</th>
              <th className="py-1 font-normal">Automation</th>
              <th className="py-1 font-normal">Object</th>
              <th className="py-1 font-normal">Trigger</th>
              <th className="py-1 font-normal">Status</th>
              <th className="py-1 font-normal">Edits</th>
              <th className="py-1 font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {data?.events.map((e) => (
              <tr key={e.id} onClick={() => setOpen(e)} className="cursor-pointer border-t border-line hover:bg-panel-2">
                <td className="py-1">{when(e.at)}</td>
                <td>{e.automation}</td>
                <td className="font-mono">
                  {e.primary_key ? (
                    <button type="button" onClick={(x) => (x.stopPropagation(), onOpen(e.primary_key!))} className="text-ocean hover:underline">
                      {e.primary_key}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{e.trigger}</td>
                <td className={e.status === "failed" ? "text-bad" : e.status === "succeeded" ? "text-ok" : "text-muted"}>{e.status}</td>
                <td>{e.edits}</td>
                <td className="text-muted">{e.tokens ? e.tokens.toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="w-72 shrink-0 overflow-auto border-l border-line p-3 text-xs">
        {open ? (
          <>
            <div className="text-sm font-medium">{open.automation}</div>
            <div className="text-muted">{open.at}</div>
            <div className="mt-2">Status: {open.status}</div>
            <div>Trigger: {open.trigger}</div>
            <div>Edits: {open.edits}</div>
            <div>Tokens: {open.tokens ? open.tokens.toLocaleString() : "—"}</div>
            {open.error && <pre className="mt-2 whitespace-pre-wrap rounded bg-bad/10 p-2 text-bad">{open.error}</pre>}
            {open.logic_run_id && (
              <Link href="/logic" className="mt-2 block text-ocean hover:underline">
                Logic run {open.logic_run_id}
              </Link>
            )}
          </>
        ) : (
          <>
            <div className="mb-1 font-medium">Objects failing most</div>
            {data?.failing_objects.map(([pk, n]) => (
              <button key={pk} type="button" onClick={() => onOpen(pk)} className="flex w-full justify-between border-t border-line py-1 text-left hover:text-white">
                <span className="font-mono">{pk}</span>
                <span className="text-bad">{n}</span>
              </button>
            ))}
            {!data?.failing_objects.length && <p className="text-muted">No failures in the period.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function ObjectPanel({ wb, sel, onClose }: { wb: Workbench; sel: { typeId: string; card: Card }; onClose: () => void }) {
  const [tl, setTl] = useState<Timeline | null>(null);
  const [tab, setTab] = useState<"history" | "timeline" | "preview">("history");
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => {
    let stale = false;
    autopilot.timeline(wb.id, sel.typeId, sel.card.pk).then((t) => !stale && setTl(t), () => {});
    return () => {
      stale = true;
    };
  }, [wb.id, sel]);
  const t0 = tl?.items.length ? new Date(tl.items[0].at).getTime() : 0;
  const t1 = tl?.items.length ? new Date(tl.items[tl.items.length - 1].at).getTime() : 1;
  const actors = tl ? [...new Set(tl.items.map((i) => (i.kind === "edit" ? i.automation || `👤 ${i.user}` : `⚡ ${i.automation}`)))] : [];
  return (
    <aside className="w-96 shrink-0 overflow-auto border-l border-line bg-panel text-xs" data-object-panel>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex-1 truncate font-medium">{sel.card.title}</span>
        <Link href={`/ontology/objects/${sel.typeId}/${encodeURIComponent(sel.card.pk)}`} className="text-ocean hover:underline">
          Open
        </Link>
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="flex gap-1 border-b border-line px-2 py-1">
        {(["history", "timeline", "preview"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`rounded px-2 py-0.5 capitalize ${tab === t ? "bg-ocean/15 text-white" : "text-muted"}`}>
            {t === "timeline" ? "Object timeline" : t}
          </button>
        ))}
      </div>
      {!tl && <p className="p-3 text-muted">Loading…</p>}
      {tl && tab === "history" && (
        <div className="space-y-2 p-3">
          {[...tl.items].reverse().map((i, n) => (
            <div key={n} className="rounded border border-line p-2">
              <div className="flex items-center gap-1">
                <span>{i.kind === "edit" ? (i.automation ? "⚡" : "👤") : "▶"}</span>
                <span className="font-medium">{i.kind === "edit" ? i.action : i.automation}</span>
                <span className={`ml-auto ${i.status === "failed" ? "text-bad" : "text-muted"}`}>{i.status}</span>
              </div>
              <div className="text-[10px] text-muted">
                {when(i.at)} · {i.kind === "edit" ? (i.automation ? `by ${i.automation}` : `by ${i.user}`) : "automation run"}
                {i.kind === "execution" && i.tokens ? ` · ${fmtTokens(i.tokens)}` : ""}
              </div>
              {i.kind === "edit" &&
                Object.entries(i.changes).map(([k, c]) => (
                  <div key={k} className="font-mono text-[10px]">
                    {k}: <span className="text-bad line-through">{fmtV(c.from)}</span> → <span className="text-ok">{fmtV(c.to)}</span>
                  </div>
                ))}
              {i.kind === "execution" && i.error && <div className="text-bad">{i.error}</div>}
            </div>
          ))}
          {!tl.items.length && <p className="text-muted">No recorded actions or automation runs on this object.</p>}
        </div>
      )}
      {tl && tab === "timeline" && (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Runtime" value={`${Math.round(tl.summary.runtime_s / 60)} min`} sub={`waiting ${Math.round(tl.summary.waiting_s / 60)} min`} />
            <Metric label="Agentic coverage" value={tl.summary.agentic_coverage === null ? "—" : `${Math.round(tl.summary.agentic_coverage * 100)}%`} sub={`${tl.summary.edits} edits`} />
            <Metric label="Executions" value={String(tl.summary.executions)} />
            <Metric label="Tokens" value={tl.summary.tokens === null ? "—" : tl.summary.tokens.toLocaleString()} />
          </div>
          <div>
            {actors.map((a) => (
              <div key={a} className="mb-1">
                <div className="truncate text-[10px] text-muted">{a}</div>
                <div className="relative h-4 rounded bg-ink">
                  {tl.items.map((i, n) => {
                    const who = i.kind === "edit" ? i.automation || `👤 ${i.user}` : `⚡ ${i.automation}`;
                    if (who !== a) return null;
                    const x = t1 === t0 ? 50 : ((new Date(i.at).getTime() - t0) / (t1 - t0)) * 96 + 2;
                    return i.kind === "edit" ? (
                      <button key={n} type="button" onClick={() => setPick(n)} title={`${i.action} · ${i.at}`} style={{ left: `${x}%` }} className={`absolute top-0.5 h-3 w-3 -translate-x-1/2 rotate-45 ${pick === n ? "bg-warn" : "bg-ok"}`} />
                    ) : (
                      <button key={n} type="button" onClick={() => setPick(n)} title={`${i.automation} · ${i.at}`} style={{ left: `${x}%`, width: Math.max(4, (i.ms ?? 0) / 100) }} className={`absolute top-0.5 h-3 rounded ${pick === n ? "bg-warn" : i.status === "failed" ? "bg-bad" : "bg-ocean"}`} />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {pick !== null && tl.items[pick] && <pre className="whitespace-pre-wrap rounded bg-ink p-2 font-mono text-[10px]">{JSON.stringify(tl.items[pick], null, 1)}</pre>}
        </div>
      )}
      {tl && tab === "preview" && (
        <div className="p-3">
          {Object.entries(tl.object.properties).map(([k, v]) => (
            <div key={k} className="flex gap-2 border-t border-line py-0.5">
              <span className="w-32 shrink-0 truncate text-muted">{k}</span>
              <span className="truncate">{fmtV(v)}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-line p-2">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="text-base font-semibold">{value}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function NotifyDialog({ wb, onChange, onClose }: { wb: Workbench; onChange: (w: Workbench) => void; onClose: () => void }) {
  const mine = wb.subscribers.find((s) => s.me);
  const [email, setEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (f: () => Promise<Workbench>) => {
    setBusy(true);
    try {
      onChange(await f());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Alert notifications" icon="bell" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm" data-notify-dialog>
        <p className="text-xs text-muted">
          Subscribers get a notification when an alert appears on this workbench (checked every few minutes and after changes). Alerts already showing when you subscribe do not notify; one that clears and
          comes back notifies again.
        </p>
        {wb.subscribed ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-ok">You are notified{mine?.email ? " in the app and by email" : " in the app"}.</span>
            <button type="button" disabled={busy} onClick={() => run(() => autopilot.unsubscribe(wb.id))} className={buttonClass.secondary}>
              Stop notifying me
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-1 text-xs">
              <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> by email too
            </label>
            <button type="button" disabled={busy} onClick={() => run(() => autopilot.subscribe(wb.id, email))} className={buttonClass.primary}>
              Notify me
            </button>
          </div>
        )}
        <div>
          <div className="mb-1 text-xs font-medium">Subscribers ({wb.subscribers.length})</div>
          {wb.subscribers.map((s) => (
            <div key={s.user_id} className="flex items-center gap-2 border-t border-line py-1 text-xs">
              <span className="flex-1 truncate">{s.name}</span>
              <label className="flex items-center gap-1 text-muted">
                <input
                  type="checkbox"
                  checked={s.email}
                  disabled={busy}
                  onChange={(e) => run(() => autopilot.setSubscribers(wb.id, wb.subscribers.map((x) => ({ user_id: x.user_id, email: x.user_id === s.user_id ? e.target.checked : x.email }))))}
                />
                email
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => autopilot.setSubscribers(wb.id, wb.subscribers.filter((x) => x.user_id !== s.user_id).map((x) => ({ user_id: x.user_id, email: x.email }))))}
                className="text-muted hover:text-bad"
                title="Remove (editors)"
              >
                ✕
              </button>
            </div>
          ))}
          {!wb.subscribers.length && <p className="text-xs text-muted">Nobody is notified yet.</p>}
        </div>
        {err && <p className="text-xs text-bad">{err}</p>}
      </div>
    </Modal>
  );
}

function StateDialog({ state, types, onClose, onSave, onDelete }: { state: State; types: ObjectTypeSource[]; onClose: () => void; onSave: (s: State) => void; onDelete: () => void }) {
  const [s, setS] = useState(state);
  const props = types.find((t) => t.id === s.object_type_id)?.properties ?? [];
  return (
    <Modal title="Configure state" icon="sliders" onClose={onClose}>
      <div className="space-y-3 p-5 text-xs">
        <div className="font-medium text-soft">Definition</div>
        <label className="block text-muted">
          Name
          <input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-muted">
          Object type
          <select value={s.object_type_id} onChange={(e) => setS({ ...s, object_type_id: e.target.value, property: "", card_properties: [] })} className={`${inputClass} mt-1`}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-3 gap-1">
          <select value={s.property} onChange={(e) => setS({ ...s, property: e.target.value })} className={inputClass}>
            <option value="">Property…</option>
            {props.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label}
              </option>
            ))}
          </select>
          <select value={s.op ?? "eq"} onChange={(e) => setS({ ...s, op: e.target.value as State["op"] })} className={inputClass}>
            <option value="eq">is</option>
            <option value="contains">contains</option>
            <option value="is_null">is empty</option>
          </select>
          <input value={s.value} onChange={(e) => setS({ ...s, value: e.target.value })} disabled={s.op === "is_null"} className={inputClass} />
        </div>
        <div className="font-medium text-soft">Display</div>
        <label className="flex items-center gap-2 text-muted">
          Color <input type="color" value={s.color} onChange={(e) => setS({ ...s, color: e.target.value })} className="h-7 w-10 rounded border border-line-2 bg-transparent" />
        </label>
        <label className="block text-muted">
          Card properties (empty: the prominent properties)
          <select multiple value={s.card_properties} onChange={(e) => setS({ ...s, card_properties: [...e.target.selectedOptions].map((o) => o.value) })} className={`${inputClass} mt-1 h-24`}>
            {props.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-between">
          <button type="button" onClick={onDelete} className="text-bad">
            Delete state
          </button>
          <span className="flex gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" disabled={!s.name || !s.property} onClick={() => onSave(s)} className={buttonClass.primary}>
              Save
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
