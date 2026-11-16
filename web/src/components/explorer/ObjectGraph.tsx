"use client";

import { forceCollide, forceLink, forceSimulation } from "d3-force";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, iconPath, type IconName } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { ErrorBox, ValueCell } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { FlowCanvas, LAYOUTS, layoutOf, PALETTE, type Pos } from "@/components/vertex/FlowCanvas";
import { applyHistFilters, HistogramPanel, type HistFilter } from "@/components/vertex/FlowPanels";
import { alertDialog, promptDialog } from "@/lib/dialogs";
import type { ObjectType, OntologyObject } from "@/lib/ontology";
import { om, type Exploration, type SearchResult, type SearchSpec } from "@/lib/ontologyModel";
import { vertex, type AroundOption, type Layout, type NodeRef, type VEdge, type VNode } from "@/lib/vertex";

/** The graph tab's name in Object Explorer (a brand of its own, not Vertex). */
export const GRAPH_BRAND = "Rasi";
/** objects a new graph starts from when no rows are picked in Results */
const SEED = 12;
/** objects one Search Around adds at a time */
const PAGE = 50;
/** what api/vertex.py resolves at most */
const MAX_NODES = 2000;

type Snap = { nodes: NodeRef[]; pos: Pos };
type Notice = { text: string; next?: { label: string; run: () => void } };
type Panel = "layers" | "selection" | "search" | "histogram";
const keyOf = (r: { object_type_id: string; primary_key: string }) => `${r.object_type_id}|${r.primary_key}`;
const refOf = (n: { object_type_id: string; primary_key: string }): NodeRef => ({ object_type_id: n.object_type_id, primary_key: String(n.primary_key) });
const tb = "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-soft hover:bg-panel-2 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Positions for objects new to the graph, the others kept: objects reached from one already drawn fan out in columns to
 * its right (as Vertex places a Search Around), the rest go in a grid below; a short collision pass then moves the new
 * ones off each other. An empty graph gets the force layout.
 */
function placeNew(nodes: VNode[], edges: VEdge[], cur: Pos): Pos {
  const ids = new Set(nodes.map((n) => n.id));
  const out: Pos = Object.fromEntries(Object.entries(cur).filter(([id]) => ids.has(id)));
  const fresh = nodes.filter((n) => !out[n.id]);
  if (!fresh.length) return out;
  if (!Object.keys(out).length) return layoutOf(nodes, edges, edges.length ? "auto" : "grid");
  const anchor = new Map<string, string>();
  for (const e of edges) {
    if (!out[e.source] && out[e.target] && !anchor.has(e.source)) anchor.set(e.source, e.target);
    if (!out[e.target] && out[e.source] && !anchor.has(e.target)) anchor.set(e.target, e.source);
  }
  const fans = new Map<string, string[]>();
  const loose: string[] = [];
  for (const n of fresh) {
    const a = anchor.get(n.id);
    if (a) fans.set(a, [...(fans.get(a) ?? []), n.id]);
    else loose.push(n.id);
  }
  const ROWS = 10;
  for (const [a, list] of fans) {
    const p = out[a];
    const rows = Math.min(ROWS, list.length);
    list.forEach((id, i) => (out[id] = { x: p.x + 260 + Math.floor(i / ROWS) * 180, y: p.y + ((i % ROWS) - (rows - 1) / 2) * 84 }));
  }
  if (loose.length) {
    const xs = Object.values(out).map((q) => q.x);
    const bottom = Math.max(...Object.values(out).map((q) => q.y)) + 150;
    loose.forEach((id, i) => (out[id] = { x: Math.min(...xs) + (i % 8) * 180, y: bottom + Math.floor(i / 8) * 100 }));
  }
  // separate the new objects (the ones drawn before stay put)
  const fixed = new Set(Object.keys(cur));
  const sim = nodes.map((n) => ({ id: n.id, x: out[n.id].x, y: out[n.id].y, ...(fixed.has(n.id) ? { fx: out[n.id].x, fy: out[n.id].y } : {}) }));
  const links = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target }));
  const s = forceSimulation(sim)
    .force("collide", forceCollide(62))
    .force("link", forceLink(links).id((d) => (d as { id: string }).id).distance(240).strength(0.04))
    .stop();
  for (let i = 0; i < 120; i++) s.tick();
  for (const q of sim) out[q.id] = { x: q.x, y: q.y };
  return out;
}

/**
 * Rasi: the relationships between objects, as a graph, inside an exploration. It starts from the rows picked in Results
 * (or the first objects of the exploration); Search Around adds linked objects a page at a time; selection tools,
 * layouts, a histogram of the drawn objects, layers per object type and link type, undo / redo. Built on Vertex's
 * canvas and API (api/vertex.py).
 */
export function ObjectGraph({ types, data, spec, picked, onSaved }: { types: ObjectType[]; data: SearchResult | null; spec: SearchSpec; picked: Set<string>; onSaved?: (e: Exploration) => void }) {
  const [nodes, setNodes] = useState<NodeRef[]>([]);
  const [graph, setGraph] = useState<{ nodes: VNode[]; edges: VEdge[] }>({ nodes: [], edges: [] });
  const [pos, setPos] = useState<Pos>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [past, setPast] = useState<Snap[]>([]);
  const [future, setFuture] = useState<Snap[]>([]);
  const [layout, setLayout] = useState<Layout>("auto");
  const [fit, setFit] = useState(0);
  const [focus, setFocus] = useState<{ ids: string[]; token: number } | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [hiddenLinks, setHiddenLinks] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState(true);
  const [line, setLine] = useState<"straight" | "curved" | "orthogonal">("straight");
  const [hist, setHist] = useState<HistFilter[]>([]);
  const [panel, setPanel] = useState<Panel>("selection");
  const [side, setSide] = useState(true);
  const [menu, setMenu] = useState<"selection" | "around" | "layout" | null>(null);
  const [options, setOptions] = useState<{ key: string; list: AroundOption[] } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // the latest graph, for async work and drags (a Search Around finishing after other changes adds to those)
  const now = useRef<Snap>({ nodes: [], pos: {} });
  useEffect(() => {
    now.current = { nodes, pos };
  }, [nodes, pos]);
  const dragging = useRef(false);
  const seq = useRef(0);
  const loading = useRef(false);

  const typeById = useMemo(() => new Map(types.map((t, i) => [t.id, { t, i }])), [types]);
  const visible = useMemo(() => applyHistFilters(graph.nodes.filter((n) => !hiddenTypes.has(n.object_type_id)), hist), [graph.nodes, hiddenTypes, hist]);
  const visibleIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const edges = useMemo(() => graph.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target) && !hiddenLinks.has(e.link_type_id)), [graph.edges, visibleIds, hiddenLinks]);
  const sel = graph.nodes.filter((n) => selected.has(n.id));

  /** resolve the objects (details and the links among them) and place the new ones; relayout: lay out every object */
  const show = async (next: NodeRef[], relayout?: Layout) => {
    const my = ++seq.current;
    loading.current = true;
    setBusy("Loading objects…");
    try {
      const d = await vertex.resolve(next);
      if (my !== seq.current) return;
      setGraph({ nodes: d.nodes, edges: d.edges });
      const lay = relayout === "auto" && !d.edges.length ? "grid" : relayout;
      setPos((cur) => (lay ? layoutOf(d.nodes, d.edges, lay, [...selected][0]) : placeNew(d.nodes, d.edges, cur)));
      if (relayout) setFit((f) => f + 1);
      setError(null);
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) {
        loading.current = false;
        setBusy(null);
      }
    }
  };
  const remember = () => {
    setPast((h) => [...h.slice(-49), now.current]);
    setFuture([]);
  };
  /** add objects to the graph; how many were new */
  const add = (refs: NodeRef[]): number => {
    const have = new Set(now.current.nodes.map(keyOf));
    const fresh = refs.map(refOf).filter((r) => !have.has(keyOf(r)) && (have.add(keyOf(r)), true));
    if (!fresh.length) return 0;
    const next = [...now.current.nodes, ...fresh];
    if (next.length > MAX_NODES) {
      void alertDialog(`A graph holds at most ${MAX_NODES.toLocaleString()} objects; this would make ${next.length.toLocaleString()}. Remove some first.`);
      return 0;
    }
    remember();
    now.current = { ...now.current, nodes: next };
    setNodes(next);
    void show(next, now.current.nodes.length === fresh.length ? "auto" : undefined);
    return fresh.length;
  };
  const remove = (ids: Set<string>) => {
    if (!ids.size) return;
    remember();
    const next = now.current.nodes.filter((n) => !ids.has(keyOf(n)));
    now.current = { ...now.current, nodes: next };
    setNodes(next);
    setGraph((g) => ({ nodes: g.nodes.filter((n) => !ids.has(n.id)), edges: g.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)) }));
    setPos((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !ids.has(id))));
    setSelected(new Set());
    if (loading.current) void show(next);
  };
  const travel = (back: boolean) => {
    const from = back ? past : future;
    const snap = from[from.length - 1];
    if (!snap) return;
    (back ? setFuture : setPast)((h) => [...h, now.current]);
    (back ? setPast : setFuture)(from.slice(0, -1));
    setNodes(snap.nodes);
    setPos(snap.pos);
    setSelected(new Set());
    const drawn = new Set(graph.nodes.map((n) => n.id));
    const keep = new Set(snap.nodes.map(keyOf));
    now.current = snap;
    if (!loading.current && snap.nodes.every((n) => drawn.has(keyOf(n)))) setGraph((g) => ({ nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) }));
    else void show(snap.nodes);
  };
  const relayout = (l: Layout) => {
    remember();
    setLayout(l);
    setPos(l === "flow" ? layoutOf(graph.nodes, graph.edges, "auto") : layoutOf(graph.nodes, graph.edges, l, [...selected][0]));
    setFit((f) => f + 1);
    setMenu(null);
  };
  const zoomTo = (ids: string[]) => ids.length && setFocus((f) => ({ ids, token: (f?.token ?? 0) + 1 }));

  // a new graph: the rows picked in Results, else the exploration's first objects
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !data) return;
    const rows: OntologyObject[] = data.objects;
    const refs = picked.size
      ? data.object_type_id
        ? [...picked].map((pk) => ({ object_type_id: data.result_type.id, primary_key: pk }))
        : rows.filter((o) => picked.has(o.primary_key)).map(refOf)
      : rows.slice(0, SEED).map(refOf);
    // marked inside the timer: a cleared timer (Strict Mode runs effects twice) leaves the graph to the next run
    const t = setTimeout(() => {
      seeded.current = true;
      now.current = { nodes: refs, pos: {} };
      setNodes(refs);
      if (refs.length) void show(refs, "auto");
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Search Around starts from the selection, or every drawn object when nothing is selected
  const start: NodeRef[] = (sel.length ? sel : visible).map(refOf);
  const startKey = start.map(keyOf).sort().join(",");
  const openAround = () => {
    setMenu(menu === "around" ? null : "around");
    if (options?.key === startKey || !start.length) return;
    setOptions(null);
    vertex.options(start).then(
      (list) => setOptions({ key: startKey, list }),
      (e: Error) => setError(e.message),
    );
  };
  const around = async (o: AroundOption, from: NodeRef[], offset = 0) => {
    setMenu(null);
    const src = from.filter((r) => r.object_type_id === o.from_type_id);
    setBusy(`Search Around: ${o.label}…`);
    try {
      const steps = [{ link_type_id: o.link_type_id, direction: o.direction }, ...(o.via ? [{ link_type_id: o.via.link_type_id, direction: o.via.direction }] : [])];
      const res = await vertex.searchAround(src, steps, null, { limit: PAGE, offset });
      const added = add(res.nodes);
      const last = res.layers[res.layers.length - 1];
      const reached = res.reached ?? last.primary_keys.length;
      const shown = Math.min(reached, offset + PAGE);
      setSelected(new Set(last.primary_keys.map((pk) => `${last.object_type_id}|${pk}`)));
      setPanel("selection");
      setNotice({
        text: reached > PAGE ? `${o.object_type}: ${shown.toLocaleString()} of ${reached.toLocaleString()} linked objects drawn (${added} new).` : `${o.object_type}: ${reached} linked object${reached === 1 ? "" : "s"} (${added} new).`,
        next: reached > offset + PAGE ? { label: `Add next ${Math.min(PAGE, reached - offset - PAGE)}`, run: () => void around(o, src, offset + PAGE) } : undefined,
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  /** every link out of the start objects, a page each */
  const aroundAll = async (list: AroundOption[]) => {
    setMenu(null);
    setBusy("Search Around: all links…");
    const got: NodeRef[] = [];
    let capped = 0;
    try {
      for (const o of list.filter((x) => x.count > 0 && !x.via)) {
        const res = await vertex.searchAround(start.filter((r) => r.object_type_id === o.from_type_id), [{ link_type_id: o.link_type_id, direction: o.direction }], null, { limit: PAGE });
        got.push(...res.nodes);
        if ((res.reached ?? 0) > PAGE) capped++;
      }
      const added = add(got);
      setNotice({ text: `${added} linked object${added === 1 ? "" : "s"} added${capped ? `; ${capped} link${capped === 1 ? "" : "s"} reach more than ${PAGE} (the first ${PAGE} drawn: Search Around one link for more)` : ""}.` });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const selectAll = () => setSelected(new Set(visible.map((n) => n.id)));
  const selectTypes = (tids: Set<string>) => setSelected(new Set(visible.filter((n) => tids.has(n.object_type_id)).map((n) => n.id)));
  const invert = () => setSelected(new Set(visible.filter((n) => !selected.has(n.id)).map((n) => n.id)));
  const selectLinked = (linkTypeId?: string) => {
    const next = new Set<string>();
    for (const e of edges) {
      if (linkTypeId && e.link_type_id !== linkTypeId) continue;
      if (selected.has(e.source) && !selected.has(e.target)) next.add(e.target);
      if (selected.has(e.target) && !selected.has(e.source)) next.add(e.source);
    }
    setSelected(next);
    setMenu(null);
  };
  /** the selection as an exploration (objects of one type): its primary keys as an "is any of" filter */
  const selectionSpec = (): SearchSpec | null => {
    const tids = new Set(sel.map((n) => n.object_type_id));
    const t = tids.size === 1 ? typeById.get([...tids][0])?.t : undefined;
    if (!t) return null;
    return { object_type_id: t.id, q: "", filters: [{ property: t.primary_key, op: "in", value: sel.map((n) => n.primary_key) }], search_around: [], order: "asc" };
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const run = (f: () => void) => (e.preventDefault(), f());
    if (mod && k === "a") return run(() => (e.shiftKey ? selectTypes(new Set(sel.map((n) => n.object_type_id))) : selectAll()));
    if (mod && k === "i") return run(invert);
    if (mod && k === "z") return run(() => travel(!e.shiftKey));
    if (mod && k === "y") return run(() => travel(false));
    if (k === "delete" || k === "backspace") return run(() => remove(selected));
    if (k === "escape") return run(() => (setMenu(null), setSelected(new Set())));
  };

  const linkCounts = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const e of graph.edges) m.set(e.link_type_id, { label: e.label, count: (m.get(e.link_type_id)?.count ?? 0) + 1 });
    return m;
  }, [graph.edges]);
  const selLinks = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const e of edges) if (selected.has(e.source) !== selected.has(e.target)) m.set(e.link_type_id, { label: e.label, count: (m.get(e.link_type_id)?.count ?? 0) + 1 });
    return m;
  }, [edges, selected]);
  const drawnTypes = [...new Set(graph.nodes.map((n) => n.object_type_id))];

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKey}
      onPointerDown={(e) => !(e.target as HTMLElement).closest("input, textarea, select, button, a") && root.current?.focus({ preventScroll: true })}
      className="flex h-full min-h-0 bg-ink outline-none"
      data-oe-graph
    >
      {side && (
        <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel text-xs">
          <div className="flex items-center border-b border-line">
            {(["layers", "selection", "search", "histogram"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPanel(p)} className={`flex-1 py-2.5 capitalize ${panel === p ? "border-b-2 border-ocean text-white" : "text-muted hover:text-soft"}`} data-graph-panel={p}>
                {p}
              </button>
            ))}
            <button type="button" onClick={() => setSide(false)} className="px-2 text-muted hover:text-white" aria-label="Hide panel">
              <Icon name="left" className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {panel === "selection" && (
              <SelectionPanel
                nodes={sel}
                all={graph.nodes}
                edges={edges}
                typeById={typeById}
                onSelect={(ids) => setSelected(new Set(ids))}
                onZoom={zoomTo}
                onAround={(o, from) => void around(o, from)}
              />
            )}
            {panel === "search" && <SearchPanel types={types} data={data} spec={spec} drawn={new Set(nodes.map(keyOf))} onAdd={(refs) => (add(refs), zoomTo(refs.map(keyOf)))} />}
            {panel === "histogram" && <HistogramPanel nodes={visible} types={types} filters={hist} setFilters={setHist} onSelect={(ids) => setSelected(new Set(ids))} />}
            {panel === "layers" && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Object types</div>
                  {!drawnTypes.length && <div className="text-muted">No objects yet.</div>}
                  {drawnTypes.map((tid) => {
                    const t = typeById.get(tid)?.t;
                    const n = graph.nodes.filter((x) => x.object_type_id === tid).length;
                    const off = hiddenTypes.has(tid);
                    return (
                      <div key={tid} className={`flex items-center gap-2 rounded px-1.5 py-1 hover:bg-panel-2 ${off ? "opacity-50" : ""}`}>
                        <TypeIcon t={{ icon: t?.icon, color: colorOf(tid) }} className="h-3.5 w-3.5" box="rounded p-1" />
                        <button type="button" onClick={() => selectTypes(new Set([tid]))} className="min-w-0 flex-1 truncate text-left text-soft hover:text-white" title="Select these objects">
                          {t?.display_name ?? tid}
                        </button>
                        <span className="tabular-nums text-muted">{n}</span>
                        <button type="button" onClick={() => setHiddenTypes(toggle(hiddenTypes, tid))} className="text-muted hover:text-white" aria-label={off ? "Show" : "Hide"}>
                          <Icon name={off ? "eye" : "eye"} className={`h-3.5 w-3.5 ${off ? "opacity-40" : ""}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Links</div>
                  {!linkCounts.size && <div className="text-muted">No links among the drawn objects yet: Search Around adds linked objects.</div>}
                  {[...linkCounts.entries()].map(([id, l]) => {
                    const off = hiddenLinks.has(id);
                    return (
                      <div key={id} className={`flex items-center gap-2 rounded px-1.5 py-1 hover:bg-panel-2 ${off ? "opacity-50" : ""}`}>
                        <Icon name="link" className="h-3.5 w-3.5 text-muted" />
                        <span className="min-w-0 flex-1 truncate text-soft">{l.label || id}</span>
                        <span className="tabular-nums text-muted">{l.count}</span>
                        <button type="button" onClick={() => setHiddenLinks(toggle(hiddenLinks, id))} className="text-muted hover:text-white" aria-label={off ? "Show" : "Hide"}>
                          <Icon name="eye" className={`h-3.5 w-3.5 ${off ? "opacity-40" : ""}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Display</div>
                  <label className="flex items-center gap-2 text-soft">
                    <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Link names on edges
                  </label>
                  <label className="flex items-center gap-2 text-soft">
                    Lines
                    <select value={line} onChange={(e) => setLine(e.target.value as typeof line)} className={fieldClass} aria-label="Lines">
                      <option value="straight">Straight</option>
                      <option value="curved">Curved</option>
                      <option value="orthogonal">Orthogonal</option>
                    </select>
                  </label>
                </div>
              </div>
            )}
          </div>
        </aside>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative z-30 flex flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
          {!side && (
            <button type="button" onClick={() => setSide(true)} className={tb} aria-label="Show panel">
              <Icon name="right" className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="mr-1 flex items-center gap-1.5 px-1.5 text-xs font-semibold text-white">
            <Icon name="constellation" className="h-4 w-4 text-ocean" /> {GRAPH_BRAND}
          </span>
          <span className="mx-1 h-5 w-px bg-line-2" />
          <div className="relative">
            <button type="button" onClick={() => setMenu(menu === "selection" ? null : "selection")} className={tb} data-graph-menu="selection">
              <Icon name="check" className="h-3.5 w-3.5" /> Selection <Icon name="down" className="h-3 w-3" />
            </button>
            {menu === "selection" && (
              <Menu>
                <MenuItem onClick={() => (selectAll(), setMenu(null))} keys="Ctrl A">Select all</MenuItem>
                {drawnTypes.slice(0, 6).map((tid) => (
                  <MenuItem key={tid} onClick={() => (selectTypes(new Set([tid])), setMenu(null))}>
                    Select all &ldquo;{typeById.get(tid)?.t.plural_name || typeById.get(tid)?.t.display_name}&rdquo;
                  </MenuItem>
                ))}
                <MenuItem onClick={() => (invert(), setMenu(null))} keys="Ctrl I">Invert selection</MenuItem>
                <MenuItem onClick={() => (setSelected(new Set()), setMenu(null))} keys="Esc" disabled={!sel.length}>Clear selection</MenuItem>
                <div className="my-1 border-t border-line" />
                <div className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-muted">Select linked objects</div>
                <MenuItem onClick={() => selectLinked()} disabled={!selLinks.size}>All links</MenuItem>
                {[...selLinks.entries()].map(([id, l]) => (
                  <MenuItem key={id} onClick={() => selectLinked(id)}>
                    {l.label} <span className="text-muted">· {l.count}</span>
                  </MenuItem>
                ))}
                <div className="my-1 border-t border-line" />
                <MenuItem
                  disabled={!selectionSpec()}
                  onClick={() => {
                    const s = selectionSpec();
                    setMenu(null);
                    if (s) window.open(`/object-explorer?spec=${encodeURIComponent(JSON.stringify(s))}`, "_blank");
                  }}
                >
                  Open selection in Explorer
                </MenuItem>
                <MenuItem
                  disabled={!selectionSpec()}
                  onClick={async () => {
                    const s = selectionSpec();
                    setMenu(null);
                    if (!s) return;
                    const t = typeById.get(s.object_type_id!)?.t;
                    const name = await promptDialog("Name this exploration", `${t?.plural_name || t?.display_name} (${sel.length})`, { title: "Save objects in current selection" });
                    if (!name) return;
                    try {
                      onSaved?.(await om.saveExploration(name, s));
                      void alertDialog(`Saved "${name}": it is listed with the saved explorations on Object Explorer's home.`);
                    } catch (e) {
                      void alertDialog((e as Error).message);
                    }
                  }}
                >
                  Save objects in current selection…
                </MenuItem>
                {!selectionSpec() && sel.length > 0 && <div className="px-3 py-1 text-[10px] text-muted">Open / save need objects of one type.</div>}
              </Menu>
            )}
          </div>
          <div className="relative">
            <button type="button" onClick={openAround} disabled={!start.length} className={tb} data-graph-menu="around" title={sel.length ? "From the selected objects" : "From every drawn object (select some to narrow)"}>
              <Icon name="graph" className="h-3.5 w-3.5" /> Search Around <Icon name="down" className="h-3 w-3" />
            </button>
            {menu === "around" && (
              <Menu wide>
                <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-muted">
                  From {sel.length ? `${sel.length} selected` : `all ${visible.length}`} object{start.length === 1 ? "" : "s"} · {PAGE} per step
                </div>
                {!options || options.key !== startKey ? (
                  <div className="px-3 py-2 text-muted">Counting linked objects…</div>
                ) : !options.list.length ? (
                  <div className="px-3 py-2 text-muted">These objects have no link types.</div>
                ) : (
                  <>
                    <MenuItem onClick={() => void aroundAll(options.list)} disabled={!options.list.some((o) => o.count > 0 && !o.via)}>
                      <span className="font-medium">All linked objects</span>
                    </MenuItem>
                    {options.list.map((o) => {
                      const t = typeById.get(o.to_type_id)?.t;
                      return (
                        <MenuItem key={`${o.link_type_id}|${o.direction}|${o.from_type_id}|${o.via?.link_type_id ?? ""}`} onClick={() => void around(o, start)} disabled={!o.count}>
                          <span className="flex min-w-0 items-center gap-2">
                            <TypeIcon t={{ icon: t?.icon, color: colorOf(o.to_type_id) }} className="h-3 w-3" box="rounded p-0.5" />
                            <span className="min-w-0 flex-1 truncate">
                              {o.label} {!sameName(o) && <span className="text-muted">({o.object_type})</span>}
                            </span>
                            <span className="tabular-nums text-muted">{o.count.toLocaleString()}</span>
                          </span>
                        </MenuItem>
                      );
                    })}
                  </>
                )}
              </Menu>
            )}
          </div>
          <div className="relative">
            <button type="button" onClick={() => setMenu(menu === "layout" ? null : "layout")} disabled={!graph.nodes.length} className={tb} data-graph-menu="layout">
              <Icon name="grid" className="h-3.5 w-3.5" /> Layout <Icon name="down" className="h-3 w-3" />
            </button>
            {menu === "layout" && (
              <Menu>
                {LAYOUTS.filter(([k]) => k !== "flow").map(([k, l]) => (
                  <MenuItem key={k} onClick={() => relayout(k)} disabled={k === "radial" && !sel.length}>
                    <span className="flex items-center gap-2">
                      <span className="w-3">{layout === k ? "✓" : ""}</span> {l}
                      {k === "radial" && <span className="text-muted">(around the selection)</span>}
                    </span>
                  </MenuItem>
                ))}
              </Menu>
            )}
          </div>
          <button type="button" onClick={() => remove(selected)} disabled={!sel.length} className={tb} title="Remove from the graph (Delete); the objects stay in the Nexus">
            <Icon name="trash" className="h-3.5 w-3.5" /> Remove
          </button>
          <span className="mx-1 h-5 w-px bg-line-2" />
          <button type="button" onClick={() => travel(true)} disabled={!past.length} className={tb} title="Undo (Ctrl Z)">
            <Icon name="restore" className="h-3.5 w-3.5" /> Undo
          </button>
          <button type="button" onClick={() => travel(false)} disabled={!future.length} className={tb} title="Redo (Ctrl Y)">
            <Icon name="refresh" className="h-3.5 w-3.5" /> Redo
          </button>
          <span className="ml-auto flex items-center gap-2 pr-1 text-xs text-muted">
            {busy && (
              <span className="flex items-center gap-1.5 text-ocean">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-ocean border-t-transparent" /> {busy}
              </span>
            )}
            <span data-graph-count>
              {visible.length.toLocaleString()} objects · {edges.length.toLocaleString()} links{sel.length ? ` · ${sel.length} selected` : ""}
            </span>
          </span>
        </div>
        {menu && <div className="fixed inset-0 z-20" onPointerDown={() => setMenu(null)} />}
        <ErrorBox message={error} />
        {notice && (
          <div className="flex items-center gap-2 border-b border-line bg-ocean/10 px-3 py-1.5 text-xs text-soft" data-graph-notice>
            <Icon name="info" className="h-3.5 w-3.5 text-ocean" />
            <span className="min-w-0 flex-1">{notice.text}</span>
            {notice.next && (
              <button type="button" onClick={() => (notice.next!.run(), setNotice(null))} className="rounded bg-ocean/20 px-2 py-0.5 text-white ring-1 ring-ocean/40 hover:bg-ocean/30">
                {notice.next.label}
              </button>
            )}
            <button type="button" onClick={() => setNotice(null)} className="text-muted hover:text-white" aria-label="Dismiss">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
        )}
        {hist.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-3 py-1 text-[11px]">
            {hist.map((f, i) => (
              <span key={i} className="flex items-center gap-1 rounded bg-ocean/15 px-2 py-0.5 text-ocean">
                {f.mode === "to" ? "Only" : "Without"} {f.property}: {f.values.join(", ")}
                <button type="button" onClick={() => setHist(hist.filter((_, j) => j !== i))} aria-label="Remove filter">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button type="button" onClick={() => setHist([])} className="text-muted hover:text-white">
              Clear filters
            </button>
          </div>
        )}
        <FlowCanvas
          nodes={visible}
          edges={edges}
          grouped={[]}
          groupFormat={() => undefined}
          pos={pos}
          setPos={(p) => {
            if (!dragging.current) {
              dragging.current = true;
              remember();
            }
            setPos(p);
          }}
          onDragEnd={() => (dragging.current = false)}
          selected={selected}
          setSelected={(s) => {
            setSelected(s);
            if (s.size) setPanel("selection");
          }}
          selectedEdge={null}
          setSelectedEdge={() => undefined}
          color={(n) => colorOf(n.object_type_id)}
          icon={(n) => {
            const i = typeById.get(n.object_type_id)?.t.icon;
            return i && iconPath(i as IconName) ? (i as IconName) : "cube";
          }}
          label={(n) => n.title}
          size={() => 14}
          changed={EMPTY_SET}
          events={EMPTY_EVENTS}
          edgeStyle={() => undefined}
          line={line}
          fitToken={fit}
          focus={focus}
          edgeLabels={labels}
        />
        {!graph.nodes.length && !busy && (
          <div className="pointer-events-none absolute inset-0 top-12 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <Icon name="constellation" className="h-10 w-10 text-ocean" />
            <div className="text-base font-medium text-white">{GRAPH_BRAND}: how objects are linked</div>
            <div className="max-w-sm">Add objects from Search (or pick rows in Results first), then Search Around to draw the objects linked to them.</div>
          </div>
        )}
      </main>
    </div>
  );

  function colorOf(tid: string): string {
    const e = typeById.get(tid);
    return e?.t.color || PALETTE[(e?.i ?? 0) % PALETTE.length];
  }
}

const EMPTY_SET = new Set<string>();
/** a Search Around whose link is named like the object type it reaches ("Klaim FKRTL" → Klaim FKRTL (BPJS)) */
const sameName = (o: AroundOption) => o.object_type.toLowerCase().startsWith(o.label.toLowerCase());
const EMPTY_EVENTS = new Map();
const toggle = (s: Set<string>, id: string) => {
  const n = new Set(s);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
};

function Menu({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return <div className={`absolute left-0 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-lg border border-line-2 bg-panel py-1 text-xs shadow-2xl ${wide ? "w-96" : "w-72"}`}>{children}</div>;
}

function MenuItem({ children, onClick, keys, disabled }: { children: React.ReactNode; onClick: () => void; keys?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-soft hover:bg-panel-2 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
      <span className="min-w-0 flex-1">{children}</span>
      {keys && <kbd className="rounded border border-line-2 px-1 text-[10px] text-muted">{keys}</kbd>}
    </button>
  );
}

/** The selection: one object's properties and links (and the Search Arounds from it), or the selected objects by type. */
function SelectionPanel({ nodes, all, edges, typeById, onSelect, onZoom, onAround }: {
  nodes: VNode[];
  all: VNode[];
  edges: VEdge[];
  typeById: Map<string, { t: ObjectType; i: number }>;
  onSelect: (ids: string[]) => void;
  onZoom: (ids: string[]) => void;
  onAround: (o: AroundOption, from: NodeRef[]) => void;
}) {
  const [tab, setTab] = useState<"properties" | "links">("properties");
  const [filter, setFilter] = useState("");
  const [opts, setOpts] = useState<{ id: string; list: AroundOption[] } | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const one = nodes.length === 1 ? nodes[0] : null;
  useEffect(() => {
    if (!one || tab !== "links" || opts?.id === one.id) return;
    let live = true;
    vertex.options([refOf(one)]).then(
      (list) => live && setOpts({ id: one.id, list }),
      () => live && setOpts({ id: one.id, list: [] }),
    );
    return () => {
      live = false;
    };
  }, [one, tab, opts?.id]);
  if (!nodes.length)
    return (
      <div className="space-y-2 text-muted">
        <p>Click an object to see its properties and links; Shift-click or drag around nothing to pan. Select several with Shift, or from the Selection menu.</p>
        <p>
          <span className="text-soft">Search Around</span> draws the objects linked to the selection ({PAGE} at a time). <kbd className="rounded border border-line-2 px-1">Del</kbd> removes,{" "}
          <kbd className="rounded border border-line-2 px-1">Ctrl Z</kbd> undoes.
        </p>
      </div>
    );
  if (one) {
    const t = typeById.get(one.object_type_id)?.t;
    const props = (t?.properties ?? []).filter((p) => p.type !== "vector");
    const q = filter.trim().toLowerCase();
    const shown = props.filter((p) => !q || (p.display_name || p.api_name).toLowerCase().includes(q) || String(one.properties[p.api_name] ?? "").toLowerCase().includes(q));
    const touching = edges.filter((e) => e.source === one.id || e.target === one.id);
    const byLink = new Map<string, string[]>();
    for (const e of touching) byLink.set(e.label || e.link_type_id, [...(byLink.get(e.label || e.link_type_id) ?? []), e.source === one.id ? e.target : e.source]);
    const title = (id: string) => all.find((n) => n.id === id)?.title ?? id;
    return (
      <div className="space-y-3" data-graph-selection="one">
        <div className="flex items-start gap-2">
          <TypeIcon t={{ icon: t?.icon, color: t?.color }} className="h-5 w-5" box="rounded-lg p-1.5" />
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-medium text-white">{one.title}</div>
            <div className="text-muted">{one.object_type}</div>
          </div>
          <button type="button" onClick={() => onZoom([one.id])} className="rounded p-1 text-muted ring-1 ring-line-2 hover:text-white" title="Zoom to">
            <Icon name="fit" className="h-3.5 w-3.5" />
          </button>
          <Link href={`/ontology/objects/${encodeURIComponent(one.object_type_id)}/${encodeURIComponent(one.primary_key)}`} className="rounded p-1 text-muted ring-1 ring-line-2 hover:text-white" title="Open the object">
            <Icon name="external" className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="flex gap-3 border-b border-line">
          {(["properties", "links"] as const).map((x) => (
            <button key={x} type="button" onClick={() => setTab(x)} className={`-mb-px pb-1.5 capitalize ${tab === x ? "border-b-2 border-ocean text-white" : "text-muted hover:text-soft"}`}>
              {x}
              {x === "links" && touching.length > 0 && <span className="ml-1 rounded bg-panel-2 px-1 text-[10px]">{touching.length}</span>}
            </button>
          ))}
        </div>
        {tab === "properties" ? (
          <>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className={inputClass} />
            <div className="divide-y divide-line/60">
              {shown.map((p) => (
                <div key={p.api_name} className="grid grid-cols-[42%_1fr] gap-2 py-1.5">
                  <span className="break-words text-muted">{p.display_name || p.api_name}</span>
                  <span className="min-w-0 break-words text-soft">
                    <ValueCell type={p.type} value={one.properties[p.api_name]} prop={p} object={one.properties} />
                  </span>
                </div>
              ))}
              {!shown.length && <div className="py-2 text-muted">No property matches.</div>}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            {[...byLink.entries()].map(([label, ids]) => (
              <div key={label}>
                <div className="mb-1 flex items-center gap-1.5 text-muted">
                  <Icon name="link" className="h-3 w-3" /> {label} <span>· {ids.length} on the graph</span>
                </div>
                {ids.slice(0, 50).map((id) => (
                  <button key={id} type="button" onClick={() => (onSelect([id]), onZoom([id]))} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-soft hover:bg-panel-2 hover:text-white">
                    {title(id)}
                  </button>
                ))}
              </div>
            ))}
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Search Around from this object</div>
              {opts?.id !== one.id ? (
                <div className="text-muted">Counting linked objects…</div>
              ) : !opts.list.length ? (
                <div className="text-muted">No link types.</div>
              ) : (
                opts.list.map((o) => (
                  <button
                    key={`${o.link_type_id}|${o.direction}|${o.via?.link_type_id ?? ""}`}
                    type="button"
                    disabled={!o.count}
                    onClick={() => onAround(o, [refOf(one)])}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-soft hover:bg-panel-2 hover:text-white disabled:opacity-40"
                  >
                    <Icon name="graph" className="h-3 w-3 text-ocean" />
                    <span className="min-w-0 flex-1 truncate">
                      {o.label} {!sameName(o) && <span className="text-muted">({o.object_type})</span>}
                    </span>
                    <span className="tabular-nums text-muted">{o.count.toLocaleString()}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
  const groups = new Map<string, VNode[]>();
  for (const n of nodes) groups.set(n.object_type_id, [...(groups.get(n.object_type_id) ?? []), n]);
  return (
    <div className="space-y-2" data-graph-selection="many">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium text-white">{nodes.length} selected</span>
        <button type="button" onClick={() => onZoom(nodes.map((n) => n.id))} className={buttonClass.ghost}>
          <Icon name="fit" className="h-3.5 w-3.5" /> Zoom to
        </button>
      </div>
      {[...groups.entries()].map(([tid, list]) => {
        const t = typeById.get(tid)?.t;
        const open = !closed.has(tid);
        return (
          <div key={tid}>
            <button type="button" onClick={() => setClosed(toggle(closed, tid))} className="flex w-full items-center gap-1.5 py-1 text-left text-muted hover:text-soft">
              <Icon name={open ? "down" : "right"} className="h-3 w-3" /> {t?.display_name ?? list[0].object_type} <span>({list.length})</span>
            </button>
            {open &&
              list.slice(0, 200).map((n) => (
                <div key={n.id} className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-panel-2">
                  <TypeIcon t={{ icon: t?.icon, color: t?.color }} className="h-3.5 w-3.5" box="rounded p-1" />
                  <button type="button" onClick={() => onSelect([n.id])} className="min-w-0 flex-1 truncate text-left text-soft hover:text-white">
                    {n.title}
                  </button>
                  <button type="button" onClick={() => onZoom([n.id])} className="text-muted opacity-0 hover:text-white group-hover:opacity-100" title="Zoom to">
                    <Icon name="fit" className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => onSelect(nodes.filter((x) => x.id !== n.id).map((x) => x.id))} className="text-muted opacity-0 hover:text-white group-hover:opacity-100" title="Remove from the selection">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            {open && list.length > 200 && <div className="px-1.5 text-muted">… {list.length - 200} more</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Add objects: the exploration's current page, or a keyword search within the exploration. */
function SearchPanel({ types, data, spec, drawn, onAdd }: { types: ObjectType[]; data: SearchResult | null; spec: SearchSpec; drawn: Set<string>; onAdd: (refs: NodeRef[]) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ q: string; rows: OntologyObject[]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const text = q.trim();
    if (!text) return;
    const t = setTimeout(
      () =>
        om
          .search({ object_type_id: spec.object_type_id, interface_id: spec.interface_id, filters: spec.filters, search_around: spec.search_around, q: [spec.q, text].filter(Boolean).join(" "), limit: 30, histograms: false, resource: "object-explorer" })
          .then(
            (r) => (setFound({ q: text, rows: r.objects, total: r.total }), setErr(null)),
            (e: Error) => setErr(e.message),
          ),
      250,
    );
    return () => clearTimeout(t);
  }, [q, spec.object_type_id, spec.interface_id, spec.filters, spec.search_around, spec.q]);
  const text = q.trim();
  const rows = text ? (found?.q === text ? found.rows : null) : (data?.objects ?? null);
  const fresh = (rows ?? []).filter((o) => !drawn.has(keyOf(o)));
  return (
    <div className="space-y-2" data-graph-search>
      <div className="relative">
        <Icon name="search" className="absolute left-2 top-2 h-3.5 w-3.5 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${data?.result_type.display_name ?? "this exploration"}…`} className={`${inputClass} pl-7`} />
      </div>
      <div className="flex items-center gap-2 text-muted">
        <span className="flex-1">
          {text ? (found?.q === text ? `${found.total.toLocaleString()} match${found.total === 1 ? "" : "es"}${found.total > found.rows.length ? `, the first ${found.rows.length}` : ""}` : "Searching…") : "The exploration's current page"}
        </span>
        {fresh.length > 0 && (
          <button type="button" onClick={() => onAdd(fresh.map(refOf))} className="text-ocean hover:underline">
            Add {fresh.length}
          </button>
        )}
      </div>
      <ErrorBox message={err} />
      {(rows ?? []).map((o) => {
        const on = drawn.has(keyOf(o));
        const t = types.find((x) => x.id === o.object_type_id);
        return (
          <button
            key={keyOf(o)}
            type="button"
            onClick={() => onAdd([refOf(o)])}
            className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-panel-2 ${on ? "text-muted" : "text-soft hover:text-white"}`}
            title={on ? "On the graph: zoom to it" : "Add to the graph"}
          >
            <TypeIcon t={{ icon: t?.icon, color: t?.color }} className="h-3.5 w-3.5" box="rounded p-1" />
            <span className="min-w-0 flex-1 truncate">{o.title}</span>
            {on ? <Icon name="check" className="h-3.5 w-3.5 text-emerald-400" /> : <Icon name="plus" className="h-3.5 w-3.5 text-muted" />}
          </button>
        );
      })}
    </div>
  );
}
