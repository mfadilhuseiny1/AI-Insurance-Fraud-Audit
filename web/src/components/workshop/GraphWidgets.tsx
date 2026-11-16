"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ActionForm } from "@/components/ontology/ActionForm";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { FlowCanvas, nodeColor, PALETTE, type Pos } from "@/components/vertex/FlowCanvas";
import { positions, type GraphPreviewData } from "@/components/vertex/GraphPreview";
import { API_URL } from "@/lib/api";
import { layoutNested, type Box } from "@/lib/machineryLayout";
import { machinery, START, type DurationDistribution, type Machinery, type MetricAggregate, type Metrics, type PathsResult, type Process, type Transition } from "@/lib/machinery";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { vertex, type AroundOption, type EdgeGroup, type Graph, type GraphRow, type Layer, type NodeRef, type Readout, type VEvent, type VNode } from "@/lib/vertex";
import {
  fillVars, sourceKey, vxByType, vxConnected, vxFocusPos, vxInBox, vxMs, vxNeighbours, vxNewRefs, vxNodeId, vxPlaceAdded, vxPlacedNeighbours, vxReadoutColor, vxRefsOf, vxSaveBody, vxSubgraph, vxTimeBound, vxTimeInput, vxTimeStatus,
  vxTimeValue, vxZoomTargets, type MachineryColorRule, type MachineryCustomView, type MachineryFormat, type MachineryMetric, type MachineryProcessCfg, type MachineryView,
  type Module, type OsFilter, type Variable, type Widget, type WidgetConfig,
} from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";
import { downloadBlob, opaqueBackground, pngName, vertexGraphPng } from "./vertexPng";

// Workshop widgets of the graph applications:
// - Vertex: Graph (palantir.com/docs/foundry/vertex/embed-graph-workshop): a saved graph, or a graph template run with
//   object set variables, drawn as Vertex draws it; the selected objects go out as an object set variable.
// - Machinery (palantir.com/docs/foundry/machinery, "Analyze and monitor a process"): a process' states and transitions
//   with their metrics; the objects in the selected states / transitions go out as an object set variable.
// An object set variable holds primary keys; an object set filter variable holds a filter on them, which data widgets
// apply through "Object set filter variables applied".

/** The primary keys an object set (or array, or single object) variable holds; null when it has no value. */
function pksOf(v: unknown): string[] | null {
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return v.map((x) => String(x && typeof x === "object" ? ((x as { primary_key?: unknown }).primary_key ?? "") : x)).filter(Boolean);
  if (typeof v === "object") return (v as { primary_key?: unknown }).primary_key ? [String((v as { primary_key: unknown }).primary_key)] : null;
  return [String(v)];
}

/** An object set filter variable's value holding exactly these objects. A filter on an empty list does not filter
 * (api/workshop.py), so an empty set is a key no object has. */
const NO_OBJECT = "__no_object__";
const pkFilter = (pks: string[]): OsFilter => ({ filters: [{ column: "__pk", op: "in", value: pks.length ? pks : [NO_OBJECT] }], mode: "all" });
const NO_FILTER: OsFilter = { filters: [], mode: "all" };
const SEP = "\u0001";

// ------------------------------------------------------------------------------------------------
// Vertex: Graph
// ------------------------------------------------------------------------------------------------

const NOTHING = new Set<string>();
/** base: the graph and its inputs (the canvas lives as long as they do); key: base, the module's version, the objects
 * added in the widget and the time window (what is loaded); events: the related events in the time window; timeProps:
 * the date / timestamp properties of each object type on the graph */
type LoadedGraph = { key: string; base: string; data?: GraphPreviewData; source?: Graph; events?: VEvent[]; timeProps?: Record<string, string[]>; note?: string; error?: string };
type TimeKind = "date" | "timestamp";
/** The widget's time: the window and the selected time as the API compares them, the values as given (for the time
 * selection panel) and how the panel changes them. */
type VxTime = {
  win: { start?: string; end?: string };
  at?: string;
  raw: { start?: unknown; end?: unknown; at?: unknown };
  set: (which: "start" | "end" | "at", value: string | null) => void;
};
/** What the user added to the graph in the widget (Search Around): kept in memory, never saved to the graph. */
type Added = { base: string; refs: NodeRef[]; groups: EdgeGroup[] };
const NOT_ADDED: Added = { base: "", refs: [], groups: [] };

/** Vertex: Graph — a saved graph (fixed, or its id in a string variable), or a graph template whose parameters come
 * from object set variables. Selecting nodes selects the object in the module and writes the selected objects out. */
export function VertexGraphWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const vars = state.variables;
  const graphId = String((c.vx_graph_variable ? vars[c.vx_graph_variable] : c.vx_graph_id) ?? "").trim();
  const given = JSON.stringify(Object.entries(c.vx_parameters ?? {}).filter(([, v]) => v).map(([p, v]) => [p, pksOf(vars[v]) ?? []]));
  const refresh = c.vx_refresh_variable ? JSON.stringify(vars[c.vx_refresh_variable] ?? null) : "";
  const base = graphId ? [graphId, given, refresh].join("|") : "";
  const [extra, setExtra] = useState<Added>(NOT_ADDED);
  // objects added to another graph (or to other inputs) are not this graph's
  const added = extra.base === base ? extra : NOT_ADDED;
  // "Add objects to subgraph": the objects of a variable are on the graph while the variable holds them
  const fromVar = c.vx_add_variable ? vxRefsOf(vars[c.vx_add_variable], c.vx_add_object_type_id) : { refs: [], untyped: 0 };
  const addedJson = JSON.stringify([added.refs, added.groups, fromVar.refs]);
  // "Time configuration": the time window (two variables, else the time selection panel's own values) and the
  // selected time; the window decides which related events are loaded
  const [localTime, setLocalTime] = useState<{ start?: unknown; end?: unknown; at?: unknown }>({});
  const raw = {
    start: c.vx_window_start_variable ? vars[c.vx_window_start_variable] : localTime.start,
    end: c.vx_window_end_variable ? vars[c.vx_window_end_variable] : localTime.end,
    at: c.vx_time_variable ? vars[c.vx_time_variable] : localTime.at,
  };
  const win = { start: vxTimeBound(raw.start), end: vxTimeBound(raw.end, true) };
  const winKey = win.start || win.end ? JSON.stringify(win) : "";
  const time: VxTime = {
    win,
    at: vxTimeBound(raw.at, true),
    raw,
    set: (which, value) => {
      const v = which === "start" ? c.vx_window_start_variable : which === "end" ? c.vx_window_end_variable : c.vx_time_variable;
      if (v) state.setVariable(v, value);
      else setLocalTime((p) => ({ ...p, [which]: value ?? undefined }));
    },
  };
  const key = base ? [base, state.version, addedJson, winKey].join("|") : "";
  const [res, setRes] = useState<LoadedGraph | null>(null);
  useEffect(() => {
    if (!graphId) return;
    let stale = false;
    const load = async (): Promise<LoadedGraph> => {
      let g: Graph = await vertex.graph(graphId);
      const name = g.name;
      if (g.template) {
        const values = Object.fromEntries(JSON.parse(given) as [string, string[]][]);
        const missing = g.template.parameters.filter((p) => !(values[p.id] ?? []).length);
        if (missing.length) return { key, base, note: `${name} is a graph template: give objects for ${missing.map((p) => p.name || p.id).join(", ")}` };
        g = await vertex.run(graphId, values);
      }
      const [moreRefs, moreGroups, varRefs] = JSON.parse(addedJson) as [NodeRef[], EdgeGroup[], NodeRef[]];
      if (moreRefs.length || moreGroups.length || varRefs.length)
        g = { ...g, nodes: [...g.nodes, ...vxNewRefs(g.nodes, [...moreRefs, ...varRefs])], edge_groups: [...(g.edge_groups ?? []), ...moreGroups] };
      // the widget's time window, else the graph's own time selection
      const timeWindow = winKey ? (JSON.parse(winKey) as { start?: string; end?: string }) : g.time;
      const [r, types] = await Promise.all([vertex.resolve(g.nodes, g.scenario_id, timeWindow, g.edge_groups, g.function_edges), ontology.objectTypes()]);
      const used = new Set(r.nodes.map((n) => n.object_type_id));
      return {
        key,
        base,
        events: r.events ?? [],
        timeProps: Object.fromEntries(types.filter((t) => used.has(t.id)).map((t) => [t.id, (t.properties ?? []).filter((p) => p.type === "date" || p.type === "timestamp").map((p) => p.api_name)])),
        source: { ...g, name },
        data: {
          graph: { id: graphId, name, nodes: g.nodes, layout: g.layout, layers: g.layers, edge_styles: g.edge_styles, edge_groups: g.edge_groups, line_type: g.line_type },
          nodes: r.nodes,
          edges: r.edges,
          grouped_edges: r.grouped_edges,
          // index: the type's place among all object types (Vertex colors types by it)
          types: types.map((t, index) => ({ id: t.id, display_name: t.display_name, icon: t.icon, index })).filter((t) => used.has(t.id)),
        },
      };
    };
    load().then(
      (x) => !stale && setRes(x),
      (e: Error) => !stale && setRes({ key, base, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [graphId, given, key, base, addedJson, winKey]);
  if (!graphId) return <div className="p-3 text-xs text-muted">{c.vx_graph_variable ? "The graph variable is empty" : "Choose the Vertex graph to show"}</div>;
  // a reload (after an action, or with objects added) keeps the drawn graph until the new one arrives
  if (res?.base !== base) return <div className="p-3 text-xs text-muted">Loading…</div>;
  if (res.error)
    return (
      <div className="p-3 text-xs text-bad">
        {res.error}
        {added.refs.length > 0 && (
          <button type="button" onClick={() => setExtra(NOT_ADDED)} className="ml-2 text-ocean hover:underline">
            Remove the {added.refs.length} added objects
          </button>
        )}
      </div>
    );
  if (!res.data || !res.source) return <div className="p-3 text-xs text-muted">{res.note}</div>;
  return (
    <VertexCanvas
      key={base}
      data={res.data}
      source={res.source}
      events={res.events ?? []}
      timeProps={res.timeProps ?? {}}
      time={time}
      loading={res.key !== key}
      added={added.refs}
      fromVar={fromVar}
      onAdd={(refs, group) => setExtra({ base, refs: [...added.refs, ...refs], groups: group ? [...added.groups, group] : added.groups })}
      onReset={() => setExtra(NOT_ADDED)}
      widget={widget}
      state={state}
    />
  );
}

/** The action form on a node's object (the object is read first, so the form opens with it filled in). */
function NodeActionDialog({ action, node, onClose, onDone }: { action: ActionType; node: VNode; onClose: () => void; onDone: () => void }) {
  const [x, setX] = useState<{ type: ObjectType; object: OntologyObject } | null>(null);
  useEffect(() => {
    let stale = false;
    Promise.all([ontology.objectType(node.object_type_id), ontology.object(node.object_type_id, node.primary_key)]).then(
      ([type, object]) => !stale && setX({ type, object }),
      () => !stale && onClose(),
    );
    return () => {
      stale = true;
    };
    // the dialog is opened for one node; onClose is a new function on every render of the graph
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.object_type_id, node.primary_key]);
  if (!x) return null;
  return <ActionForm action={action} objectType={x.type} object={x.object} onClose={onClose} onDone={onDone} />;
}

/** The time selection panel: the time window and the selected time, as dates or as timestamps (UTC). A change is written
 * to the configured variable, else kept in the widget. */
function TimePanel({ time, windowKind, timeKind, note }: { time: VxTime; windowKind: TimeKind; timeKind: TimeKind; note: string }) {
  const input = (which: "start" | "end" | "at", kind: TimeKind, label: string) => (
    <input type={kind === "date" ? "date" : "datetime-local"} value={vxTimeInput(time.raw[which], kind)} onChange={(e) => time.set(which, vxTimeValue(e.target.value, kind))}
      className={`${fieldClass} py-0.5 text-[11px]`} aria-label={label} data-vertex-time={which} />
  );
  const any = [time.raw.start, time.raw.end, time.raw.at].some((v) => v !== undefined && v !== null && v !== "");
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-2 py-1 text-[11px]" data-vertex-time-panel>
      <Icon name="clock" className="h-3 w-3 shrink-0 text-muted" />
      <span className="text-muted">Time window{windowKind === "timestamp" ? " (UTC)" : ""}</span>
      {input("start", windowKind, "Time window start")}
      <span className="text-muted">–</span>
      {input("end", windowKind, "Time window end")}
      <span className="ml-1 text-muted">Selected time{timeKind === "timestamp" ? " (UTC)" : ""}</span>
      {input("at", timeKind, "Selected time")}
      {any && (
        <button type="button" onClick={() => (["start", "end", "at"] as const).forEach((w) => time.set(w, null))} className={barButton} data-vertex-time-clear>
          Clear
        </button>
      )}
      {note && <span className="truncate text-muted">{note}</span>}
    </div>
  );
}

const optionKey = (o: AroundOption) => `${o.link_type_id}|${o.direction}|${o.from_type_id}|${o.via?.link_type_id ?? ""}`;
const barButton = "inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-soft hover:border-ocean hover:text-ocean disabled:opacity-50 disabled:hover:border-line disabled:hover:text-soft";

type CanvasProps = {
  data: GraphPreviewData;
  /** the graph as loaded (a template: as run), with the objects added in the widget — what "Save as" writes */
  source: Graph;
  /** the related events in the time window, and each object type's date / timestamp properties */
  events: VEvent[];
  timeProps: Record<string, string[]>;
  time: VxTime;
  loading: boolean;
  added: NodeRef[];
  /** "Add objects to subgraph": the variable's objects (and how many keys had no object type) */
  fromVar: { refs: NodeRef[]; untyped: number };
  onAdd: (refs: NodeRef[], group?: EdgeGroup) => void;
  onReset: () => void;
  widget: Widget;
  state: ModuleState;
};

/** Text inside a double-quoted CSS string. */
const cssStr = (s: string) => s.replace(/[\\"]/g, "\\$&").replace(/</g, "\\3c ").replace(/\n/g, "\\a ");

async function vertexReadouts(nodes: NodeRef[], readouts: Record<string, NonNullable<Layer["readout"]>>, start?: string, end?: string): Promise<Record<string, Readout>> {
  const res = await fetch(`${API_URL}/api/vertex/readouts`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodes, readouts, start, end }) });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

function VertexCanvas({ data, source, events, timeProps, time, loading, added, fromVar, onAdd, onReset, widget, state }: CanvasProps) {
  const c = widget.config;
  const g = data.graph;
  const layers = useMemo(() => g.layers ?? {}, [g.layers]);
  const [pos, setPos] = useState<Pos>(() => positions(data));
  // objects that arrive later without a position (added from a variable): beside the drawn objects they link to,
  // else right of the graph; placed once, before the browser paints
  const unplaced = data.nodes.filter((n) => !pos[n.id]).map((n) => n.id).join(SEP);
  useLayoutEffect(() => {
    if (!unplaced) return;
    const missing = unplaced.split(SEP);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos((p) => ({ ...p, ...vxPlaceAdded(p, vxPlacedNeighbours(missing, [...data.edges, ...data.grouped_edges], p), missing.filter((id) => !p[id])) }));
    // placed when new objects arrive; the links are those of the same data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unplaced]);
  const varKey = fromVar.refs.map(vxNodeId).join(SEP);
  const varIds = useMemo(() => new Set(varKey ? varKey.split(SEP) : []), [varKey]);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const typeOf = Object.fromEntries(data.types.map((t) => [t.id, t]));
  const allNodes = useMemo(() => data.nodes.filter((n) => !layers[n.object_type_id]?.hidden), [data.nodes, layers]);
  const links = useMemo(() => {
    const on = new Set(allNodes.map((n) => n.id));
    return {
      edges: data.edges.filter((e) => on.has(e.source) && on.has(e.target) && !g.edge_styles?.[e.link_type_id]?.hidden),
      grouped: data.grouped_edges.filter((e) => on.has(e.source) && on.has(e.target)),
    };
  }, [allNodes, data.edges, data.grouped_edges, g.edge_styles]);
  // "Sub-graph": only the connected parts holding an object of the variable (none of them on the graph: all of it)
  const subPks = c.vx_subgraph_variable ? pksOf(state.variables[c.vx_subgraph_variable]) : null;
  const subKey = subPks ? subPks.join(SEP) : "";
  // the objects added from a variable join the shown sub-graph
  const sub = useMemo(() => {
    const s = vxSubgraph(allNodes, [...links.edges, ...links.grouped], subKey ? subKey.split(SEP) : null, c.vx_subgraph_object_type_id);
    return s && varIds.size ? new Set([...s, ...allNodes.filter((n) => varIds.has(n.id)).map((n) => n.id)]) : s;
  }, [allNodes, links, subKey, c.vx_subgraph_object_type_id, varIds]);
  const nodes = useMemo(() => (sub ? allNodes.filter((n) => sub.has(n.id)) : allNodes), [allNodes, sub]);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = sub ? links.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) : links.edges;
  const grouped = sub ? links.grouped.filter((e) => ids.has(e.source) && ids.has(e.target)) : links.grouped;
  // outputs carry one object type's objects when one is chosen (an object set has one type), else every selected object
  const outType = c.vx_object_type_id;
  const inOutput = (n: VNode) => !outType || n.object_type_id === outType;

  // "Objects on graph": every object drawn, written once the graph is loaded
  const onGraph = nodes.filter(inOutput).map((n) => n.primary_key).join(SEP);
  useEffect(() => {
    if (c.vx_objects_variable) state.setVariable(c.vx_objects_variable, onGraph ? onGraph.split(SEP) : []);
    // the variable is written when the drawn objects change, not on every render of the module
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onGraph, c.vx_objects_variable]);

  // "Highlight object set": the objects of a variable are the selection until the user selects something else
  const hl = c.vx_highlight_variable ? pksOf(state.variables[c.vx_highlight_variable]) : null;
  const hlKey = hl ? hl.join(SEP) : "";
  const highlighted = useMemo(() => {
    const want = new Set(hlKey ? hlKey.split(SEP) : []);
    return new Set(nodes.filter((n) => (!outType || n.object_type_id === outType) && want.has(n.primary_key)).map((n) => n.id));
  }, [hlKey, nodes, outType]);
  const [sel, setSel] = useState<{ hl: string; ids: Set<string> } | null>(null);
  const selected = sel && sel.hl === hlKey ? sel.ids : highlighted;
  const lastSource = useRef<string | null>(null);

  const pick = (next: Set<string>) => {
    const same = next.size === selected.size && [...next].every((id) => selected.has(id));
    setSel({ hl: hlKey, ids: next });
    if (same) return;
    const picked = nodes.filter((n) => next.has(n.id));
    const pks = picked.filter(inOutput).map((n) => n.primary_key);
    if (c.vx_selected_variable) state.setVariable(c.vx_selected_variable, pks);
    // nothing selected: the filter variable does not filter
    if (c.vx_selected_filter_variable) state.setVariable(c.vx_selected_filter_variable, pks.length ? pkFilter(pks) : NO_FILTER);
    // per-type outputs: each type's selected objects (none of the type selected: an empty set)
    const perType = Object.entries(c.vx_type_outputs ?? {}).filter(([, v]) => v);
    if (perType.length) {
      const by = vxByType(picked, next, perType.map(([t]) => t));
      for (const [t, v] of perType) state.setVariable(v, by[t] ?? []);
    }
    // one node selected: it is the module's selected object of its type
    if (picked.length === 1) {
      const src = sourceKey({ kind: "object_type", id: picked[0].object_type_id });
      if (lastSource.current && lastSource.current !== src) state.select(lastSource.current, undefined);
      state.select(src, picked[0].primary_key);
      lastSource.current = src;
    } else if (!picked.length && lastSource.current) {
      state.select(lastSource.current, undefined);
      lastSource.current = null;
    }
    void state.runEvents?.(c.vx_events ?? []);
  };

  // "Zoom to object set": the view fits the variable's objects whenever its value changes (an empty set, or objects
  // that are not on the graph: the whole graph). The canvas fits its view to the positions it is given when its fit
  // token changes, so for that one render it gets the positions of those objects alone; the layout effect then gives
  // it every position back before anything is painted, and the fitted view stays.
  const zoomPks = c.vx_zoom_variable ? pksOf(state.variables[c.vx_zoom_variable]) : null;
  const zoomKey = zoomPks ? zoomPks.join(SEP) : "";
  const zoomIds = useMemo(() => vxZoomTargets(nodes, zoomKey ? zoomKey.split(SEP) : null, c.vx_zoom_object_type_id), [nodes, zoomKey, c.vx_zoom_object_type_id]);
  const [zoomed, setZoomed] = useState("");
  const [whole, setWhole] = useState(0);
  const focusing = zoomed !== zoomKey && zoomIds.length > 0;
  useLayoutEffect(() => {
    // the second render is the point: it follows the fitting one before the browser paints
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (zoomed !== zoomKey) setZoomed(zoomKey);
  }, [zoomed, zoomKey]);

  // "Available actions": the actions of the selected object's type, run in the platform's action form on that object
  const actionsMode = c.vx_actions ?? "none";
  const [actions, setActions] = useState<ActionType[]>([]);
  useEffect(() => {
    if (actionsMode === "none") return;
    let stale = false;
    ontology.actionTypes().then((a) => !stale && setActions(a), () => undefined);
    return () => {
      stale = true;
    };
  }, [actionsMode]);
  const picked = nodes.filter((n) => selected.has(n.id));
  const one = picked.length === 1 ? picked[0] : null;
  const offered = one && actionsMode !== "none" ? actions.filter((a) => a.kind !== "create" && a.object_type_id === one.object_type_id && (actionsMode === "all" || (c.vx_action_ids ?? []).includes(a.id))) : [];
  const [running, setRunning] = useState<{ action: ActionType; node: VNode } | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  // Search Around: the link types leading out of the selected objects; the objects one reaches are added to the graph
  // in the widget (the saved graph is not changed)
  const selKey = c.vx_search_around ? picked.map((n) => n.id).join(SEP) : "";
  const [opts, setOpts] = useState<{ key: string; list: AroundOption[] } | null>(null);
  useEffect(() => {
    if (!selKey) return;
    let stale = false;
    const refs = selKey.split(SEP).map((id) => ({ object_type_id: id.slice(0, id.indexOf("|")), primary_key: id.slice(id.indexOf("|") + 1) }));
    vertex.options(refs, source.scenario_id).then(
      (list) => !stale && setOpts({ key: selKey, list }),
      () => !stale && setOpts({ key: selKey, list: [] }),
    );
    return () => {
      stale = true;
    };
  }, [selKey, source.scenario_id, state.version]);
  const options = opts?.key === selKey ? opts.list : [];
  const [busy, setBusy] = useState(false);
  const around = async (o: AroundOption) => {
    const from = picked.filter((n) => n.object_type_id === o.from_type_id).map((n) => ({ object_type_id: n.object_type_id, primary_key: n.primary_key }));
    if (!from.length) return;
    setBusy(true);
    try {
      const via = o.via;
      const res = await vertex.searchAround(from, [{ link_type_id: o.link_type_id, direction: o.direction }, ...(via ? [{ link_type_id: via.link_type_id, direction: via.direction }] : [])], source.scenario_id);
      // through a link-merged intermediary: the far objects are added and the intermediaries are drawn as edges
      const far = res.layers[res.layers.length - 1];
      const fresh = vxNewRefs(source.nodes, via ? far.primary_keys.map((pk) => ({ object_type_id: far.object_type_id, primary_key: pk })) : res.nodes);
      const group: EdgeGroup | undefined =
        via && !(source.edge_groups ?? []).some((x) => x.object_type_id === via.object_type_id && x.links.includes(o.link_type_id) && x.links.includes(via.link_type_id))
          ? { id: `merge-${via.object_type_id}-${via.link_type_id}`, name: via.object_type, object_type_id: via.object_type_id, links: [o.link_type_id, via.link_type_id], label: "count" }
          : undefined;
      if (fresh.length || group) {
        const placed = vxPlaceAdded(pos, from.map(vxNodeId), fresh.map(vxNodeId));
        setPos((p) => ({ ...p, ...placed }));
        onAdd(fresh, group);
      }
      setNote({ text: fresh.length ? `${fresh.length} added: ${o.label}` : `${o.label}: already on the graph` });
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  // "Objects added": what the Search Arounds brought onto the graph
  const addedIds = useMemo(() => new Set(added.map(vxNodeId)), [added]);
  const addedOut = nodes.filter((n) => addedIds.has(n.id) && inOutput(n)).map((n) => n.primary_key).join(SEP);
  useEffect(() => {
    if (c.vx_added_variable) state.setVariable(c.vx_added_variable, addedOut ? addedOut.split(SEP) : []);
    // written when the added objects change, not on every render of the module
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedOut, c.vx_added_variable]);
  const reset = () => {
    // the added objects leave the selection with the graph
    if ([...selected].some((id) => addedIds.has(id))) pick(new Set([...selected].filter((id) => !addedIds.has(id))));
    setNote(null);
    onReset();
  };

  // "Save as a new graph": the graph as drawn becomes a new Vertex graph; the configured graph is never written
  const [saving, setSaving] = useState<{ name: string; busy?: boolean } | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const save = async () => {
    if (!saving || saving.busy) return;
    setSaving({ ...saving, busy: true });
    try {
      const made = await vertex.create(vxSaveBody(source, saving.name, data.nodes, pos) as unknown as Graph);
      setSaved({ id: made.id ?? "", name: made.name });
      setSaving(null);
      setNote(null);
      if (c.vx_saved_variable) state.setVariable(c.vx_saved_variable, made.id ?? "");
      void state.runEvents?.(c.vx_save_events ?? []);
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
      setSaving({ name: saving.name });
    }
  };
  // "Export as PNG": the whole graph as drawn (also the parts out of view), on the widget's background
  const [exporting, setExporting] = useState(false);
  const exportPng = async () => {
    const root = area.current?.closest("[data-vertex-widget]");
    const svgEl = area.current?.querySelector("svg");
    if (!svgEl || !root) return;
    setExporting(true);
    try {
      downloadBlob(await vertexGraphPng(svgEl, opaqueBackground(root)), pngName(g.name));
      setNote({ text: `Exported ${pngName(g.name)}` });
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setExporting(false);
    }
  };
  // sub-graph selection: Select neighbours / connected / same type / all / invert, and box select (Shift-drag on the
  // background, or any drag in the Box select mode; Shift adds to the selection). The box is drawn over the canvas;
  // the nodes whose centers fall in it are selected.
  const selectTools = c.vx_select_tools !== false;
  const selectBy = (how: string) => {
    const cur = new Set([...selected].filter((id) => ids.has(id)));
    const around = [...edges, ...grouped];
    const types = new Set(picked.map((n) => n.object_type_id));
    const next =
      how === "neighbours" ? vxNeighbours(cur, around)
        : how === "connected" ? vxConnected(cur, around)
          : how === "type" ? new Set(nodes.filter((n) => types.has(n.object_type_id)).map((n) => n.id))
            : how === "all" ? new Set(ids)
              : how === "invert" ? new Set(nodes.filter((n) => !cur.has(n.id)).map((n) => n.id))
                : new Set<string>();
    pick(next);
  };
  const [boxMode, setBoxMode] = useState(false);
  const [box, setBox] = useState<{ x1: number; y1: number; x2: number; y2: number; add: boolean } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const local = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const boxStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!selectTools || e.button !== 0 || !(boxMode || e.shiftKey)) return;
    // Shift-click on a node or an edge stays the canvas' own (adds / removes one object)
    if ((e.target as Element).closest("[data-node], [data-edge], button")) return;
    e.stopPropagation();
    e.preventDefault();
    area.current!.setPointerCapture?.(e.pointerId);
    const q = local(e);
    setBox({ x1: q.x, y1: q.y, x2: q.x, y2: q.y, add: e.shiftKey });
  };
  const boxEnd = () => {
    if (!box) return;
    setBox(null);
    if (Math.abs(box.x2 - box.x1) + Math.abs(box.y2 - box.y1) < 4) {
      // a click on the background in the Box select mode clears the selection, as the canvas does
      if (!box.add) pick(new Set());
      return;
    }
    const r = area.current!.getBoundingClientRect();
    const centers = [...area.current!.querySelectorAll("[data-node]")].map((el) => {
      const m = (el as SVGGraphicsElement).getScreenCTM();
      return { id: el.getAttribute("data-node") ?? "", x: (m?.e ?? -1e9) - r.left, y: (m?.f ?? -1e9) - r.top, w: 0, h: 0 };
    });
    const hit = vxInBox(centers, box).filter((id) => ids.has(id));
    pick(new Set([...(box.add ? [...selected].filter((id) => ids.has(id)) : []), ...hit]));
  };

  // the time window and the selected time: event badges until the selected time, objects whose own times all fall
  // outside the window faded, readouts over the window up to the selected time
  const atMs = time.at ? vxMs(time.at) : null;
  const eventsBy = useMemo(() => {
    const m = new Map<string, VEvent[]>();
    for (const ev of events) {
      const t = ev.at ? vxMs(ev.at) : null;
      if (atMs !== null && t !== null && t > atMs) continue;
      m.set(ev.node, [...(m.get(ev.node) ?? []), ev]);
    }
    return m;
  }, [events, atMs]);
  const windowed = !!(time.win.start || time.win.end);
  const status = useMemo(
    () => new Map(nodes.map((n) => [n.id, windowed ? vxTimeStatus(n.properties, timeProps[n.object_type_id] ?? [], time.win.start, time.win.end) : "none"])),
    [nodes, timeProps, windowed, time.win.start, time.win.end],
  );
  const inWindow = nodes.filter((n) => status.get(n.id) === "in").length;
  const outside = nodes.filter((n) => status.get(n.id) === "out").map((n) => n.id);
  const faded = c.vx_time_fade !== false ? outside : [];
  const scope = `[data-vertex-widget="${cssStr(widget.id)}"]`;
  const fadeCss = faded.length ? `${faded.map((id) => `${scope} [data-node="${cssStr(id)}"]`).join(",")}{opacity:0.2}` : "";
  const readoutSpecs = useMemo(() => Object.fromEntries(Object.entries(layers).filter(([, l]) => l.readout?.property).map(([t, l]) => [t, l.readout!])), [layers]);
  const roEnd = time.at ?? time.win.end;
  const roKey = Object.keys(readoutSpecs).length
    ? JSON.stringify([readoutSpecs, allNodes.filter((n) => readoutSpecs[n.object_type_id]).map((n) => ({ object_type_id: n.object_type_id, primary_key: n.primary_key })), time.win.start ?? null, roEnd ?? null, state.version])
    : "";
  const [readings, setReadings] = useState<{ key: string; r: Record<string, Readout> } | null>(null);
  useEffect(() => {
    if (!roKey) return;
    let stale = false;
    const [specs, refs, start, end] = JSON.parse(roKey) as [Record<string, NonNullable<Layer["readout"]>>, NodeRef[], string | null, string | null];
    vertexReadouts(refs, specs, start ?? undefined, end ?? undefined).then(
      (r) => !stale && setReadings({ key: roKey, r }),
      () => !stale && setReadings({ key: roKey, r: {} }),
    );
    return () => {
      stale = true;
    };
  }, [roKey]);
  // while new readouts load, the last ones stay
  const reads = roKey ? (readings?.r ?? {}) : {};
  const roLoading = !!roKey && readings?.key !== roKey;
  const timePanel = !!c.vx_time_panel;

  const tools = actionsMode !== "none" || !!c.vx_search_around || !!c.vx_save || selectTools || !!c.vx_export_png;
  const fromVarOn = nodes.filter((n) => varIds.has(n.id)).length;
  const kiosk = state.readOnly ? "Read-only (kiosk mode)" : undefined;

  if (!nodes.length) return <p className="p-3 text-xs text-muted">This graph has no objects.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink" data-vertex-graph={g.id} data-vertex-widget={widget.id}>
      {fadeCss && <style>{fadeCss}</style>}
      {tools && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-2 py-1 text-[11px]" data-vertex-tools>
          <span className="max-w-[40%] truncate text-muted">{one ? `${one.object_type}: ${one.title}` : picked.length ? `${picked.length} objects selected` : "Select an object on the graph"}</span>
          {selectTools && (
            <>
              <button type="button" onClick={() => setBoxMode((b) => !b)} aria-pressed={boxMode} className={`${barButton} ${boxMode ? "border-ocean text-ocean" : ""}`}
                title="Drag a box on the graph to select the objects in it. Shift-drag works in any mode and adds to the selection; Shift-click adds or removes one object." data-vertex-box={boxMode ? "on" : "off"}>
                <Icon name="grid" className="h-3 w-3" /> Box select
              </button>
              <select value="" onChange={(e) => selectBy(e.target.value)} className={`${fieldClass} py-0.5 text-[11px]`} aria-label="Select" data-vertex-select>
                <option value="">Select…</option>
                <option value="neighbours" disabled={!picked.length}>Neighbours of the selection</option>
                <option value="connected" disabled={!picked.length}>Connected: the selection&apos;s sub-graphs</option>
                <option value="type" disabled={!picked.length}>Every object of the selected types</option>
                <option value="all">All objects</option>
                <option value="invert">Invert the selection</option>
                <option value="none" disabled={!picked.length}>Clear the selection</option>
              </select>
            </>
          )}
          {offered.slice(0, 3).map((a) => (
            <button key={a.id} type="button" disabled={!!state.readOnly} title={kiosk ?? a.description} onClick={() => setRunning({ action: a, node: one! })} className={barButton} data-vertex-action={a.id}>
              <Icon name={a.kind === "delete" ? "trash" : "edit"} className="h-3 w-3" /> {a.display_name}
            </button>
          ))}
          {offered.length > 3 && (
            <select value="" disabled={!!state.readOnly} title={kiosk} onChange={(e) => { const a = offered.find((x) => x.id === e.target.value); if (a) setRunning({ action: a, node: one! }); }} className={`${fieldClass} py-0.5 text-[11px]`} aria-label="More actions">
              <option value="">More actions…</option>
              {offered.slice(3).map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
            </select>
          )}
          {actionsMode !== "none" && picked.length > 1 && <span className="text-muted">· select one object to run an action</span>}
          {c.vx_search_around && picked.length > 0 && (
            <select value="" disabled={busy || loading} onChange={(e) => { const o = options.find((x) => optionKey(x) === e.target.value); if (o) void around(o); }} className={`${fieldClass} py-0.5 text-[11px]`} aria-label="Search Around" data-vertex-around>
              <option value="">{busy ? "Searching…" : "Search Around…"}</option>
              {options.map((o) => <option key={optionKey(o)} value={optionKey(o)} disabled={!o.count}>{o.label} ({o.object_type}) · {o.count}</option>)}
            </select>
          )}
          {note && <span className={`truncate ${note.bad ? "text-bad" : "text-muted"}`} data-vertex-note>{note.text}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {c.vx_export_png && (
              <button type="button" disabled={exporting} onClick={() => void exportPng()} className={barButton} title="Download the whole graph as drawn as a PNG image" data-vertex-export>
                <Icon name="download" className="h-3 w-3" /> {exporting ? "Exporting…" : "PNG"}
              </button>
            )}
            {added.length > 0 && (
              <button type="button" onClick={reset} className={barButton} title="Back to the graph as saved" data-vertex-reset>
                <Icon name="restore" className="h-3 w-3" /> Remove {added.length} added
              </button>
            )}
            {c.vx_save && !saving && (
              <button type="button" disabled={!!state.readOnly || loading} title={kiosk ?? "The graph as drawn becomes a new Vertex graph; this one is not changed"} onClick={() => setSaving({ name: fillVars(c.vx_save_name ?? "", state.variables).trim() || `${g.name} (copy)` })} className={barButton} data-vertex-save>
                <Icon name="save" className="h-3 w-3" /> Save as new graph
              </button>
            )}
            {c.vx_save && saving && (
              <>
                <input value={saving.name} autoFocus maxLength={200} onChange={(e) => setSaving({ name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setSaving(null); }} className={`${fieldClass} w-48 py-0.5 text-[11px]`} aria-label="Name of the new graph" />
                <button type="button" disabled={saving.busy || !saving.name.trim()} onClick={() => void save()} className={barButton}>{saving.busy ? "Saving…" : "Save"}</button>
                <button type="button" onClick={() => setSaving(null)} className={barButton}>Cancel</button>
              </>
            )}
          </span>
        </div>
      )}
      {timePanel && <TimePanel time={time} windowKind={c.vx_window_kind ?? "date"} timeKind={c.vx_time_kind ?? "date"} note={windowed ? `${inWindow} of ${inWindow + outside.length} dated objects in the window` : ""} />}
      {running && (
        <NodeActionDialog
          action={running.action}
          node={running.node}
          onClose={() => setRunning(null)}
          onDone={() => {
            setRunning(null);
            state.bump();
            void state.runEvents?.(c.vx_action_events ?? []);
            // automations may still be writing
            [2000, 6000].forEach((ms) => setTimeout(state.bump, ms));
          }}
        />
      )}
      <div
        ref={area}
        className="relative flex min-h-0 flex-1 flex-col"
        onPointerDownCapture={boxStart}
        onPointerMove={(e) => {
          if (!box) return;
          const q = local(e);
          setBox({ ...box, x2: q.x, y2: q.y });
        }}
        onPointerUp={boxEnd}
        onPointerCancel={() => setBox(null)}
        data-vertex-area
      >
      <FlowCanvas
        nodes={nodes}
        edges={edges}
        grouped={grouped}
        groupFormat={(ge) => (g.edge_groups ?? []).find((x) => x.id === ge.group_id)?.format}
        pos={focusing ? vxFocusPos(pos, zoomIds) : pos}
        fitToken={`${zoomKey}#${whole}`}
        setPos={setPos}
        selected={selected}
        setSelected={pick}
        selectedEdge={selectedEdge}
        setSelectedEdge={setSelectedEdge}
        color={(n) => vxReadoutColor(layers[n.object_type_id]?.readout, reads[n.id]?.value) ?? nodeColor(n, layers[n.object_type_id], PALETTE[(typeOf[n.object_type_id]?.index ?? 0) % PALETTE.length])}
        icon={(n) => (layers[n.object_type_id]?.node_style === "circle" ? null : (((layers[n.object_type_id]?.icon ?? typeOf[n.object_type_id]?.icon ?? "cube") as IconName) || "cube"))}
        label={(n) => {
          const lp = layers[n.object_type_id]?.label_property;
          const text = lp ? String(n.properties[lp] ?? n.title) : n.title;
          const r = reads[n.id];
          return r && r.value !== undefined && r.value !== null ? `${text} · ${Number(r.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${r.unit ? ` ${r.unit}` : ""}` : text;
        }}
        size={(n) => {
          const sp = layers[n.object_type_id]?.size_property;
          if (!sp) return 14;
          const max = Math.max(1, ...data.nodes.filter((x) => x.object_type_id === n.object_type_id).map((x) => Number(x.properties[sp]) || 0));
          return 9 + 14 * Math.sqrt((Number(n.properties[sp]) || 0) / max);
        }}
        changed={NOTHING}
        events={eventsBy}
        edgeStyle={(e) => g.edge_styles?.[e.link_type_id]}
        line={g.line_type ?? (g.layout === "flow" ? "curved" : "straight")}
      />
      {box && (
        <div className="pointer-events-none absolute border border-sky-400 bg-sky-400/10"
          style={{ left: Math.min(box.x1, box.x2), top: Math.min(box.y1, box.y2), width: Math.abs(box.x2 - box.x1), height: Math.abs(box.y2 - box.y1) }} data-vertex-box-rect />
      )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-2 py-1 text-[11px] text-muted">
        <Icon name="graph" className="h-3.5 w-3.5 shrink-0 text-ocean" />
        <span className="truncate">{g.name}</span>
        <span className="shrink-0" data-vertex-selected={selected.size}>
          · {nodes.length} objects{sub ? ` (sub-graph of ${allNodes.length})` : ""}{picked.length ? ` · ${picked.length} selected` : ""}{loading || roLoading ? " · loading…" : ""}
        </span>
        {c.vx_add_variable && (varIds.size > 0 || fromVar.untyped > 0) && (
          <span className={`shrink-0 ${fromVar.untyped ? "text-warn" : ""}`} title={`Objects of ${c.vx_add_variable} drawn on the graph (not saved with it)`} data-vertex-from-var={fromVarOn}>
            · {fromVarOn} of {varIds.size} from {c.vx_add_variable}
            {fromVar.untyped ? ` · ${fromVar.untyped} without an object type (choose it in the panel)` : ""}
          </span>
        )}
        {windowed && (
          <span className="shrink-0" title={`Time window ${time.win.start ?? "…"} – ${time.win.end ?? "…"}${time.at ? ` · selected time ${time.at}` : ""}`} data-vertex-window={outside.length}>
            · <Icon name="clock" className="inline h-3 w-3" /> {inWindow} in the time window{outside.length ? `, ${outside.length} outside` : ""}
          </span>
        )}
        {zoomIds.length > 0 && (
          <button type="button" onClick={() => setWhole((n) => n + 1)} className="shrink-0 hover:text-ocean" title={`The view was fitted to ${zoomIds.length} object(s) of ${c.vx_zoom_variable}`} data-vertex-zoomed={zoomIds.length}>
            · Show the whole graph
          </button>
        )}
        {saved && (
          <a href={`/vertex?graph=${encodeURIComponent(saved.id)}`} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 truncate text-ocean hover:underline" data-vertex-saved={saved.id}>
            · Saved as {saved.name}
          </a>
        )}
        {c.vx_open_in_vertex !== false && (
          <a href={`/vertex?graph=${encodeURIComponent(g.id ?? "")}`} target="_blank" rel="noreferrer" className="ml-auto flex shrink-0 items-center gap-1 hover:text-ocean">
            Open in Vertex <Icon name="external" className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Machinery
// ------------------------------------------------------------------------------------------------

export const MACHINERY_VIEWS: [MachineryView, string][] = [
  ["current_count", "Current count"],
  ["historical_count", "Historical count"],
  ["current_duration_s", "Current duration"],
  ["historical_duration_s", "Historical duration"],
];
const dur = (s: number | null | undefined) => (s === null || s === undefined ? "—" : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} d`);
const W = 150;
const H = 54;

/** Left-to-right layers from the start through the transitions (loops placed by first reach) — the Machinery page's layout. */
function processLayout(p: Process): Record<string, { x: number; y: number }> {
  const ids = [START, ...p.states.map((s) => s.id)];
  const level = new Map<string, number>([[START, 0]]);
  const queue = [START];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of p.transitions.filter((x) => x.from === cur)) {
      if (!level.has(e.to)) {
        level.set(e.to, level.get(cur)! + 1);
        queue.push(e.to);
      }
    }
  }
  let maxL = Math.max(0, ...level.values());
  for (const id of ids) if (!level.has(id)) level.set(id, ++maxL);
  const rows = new Map<number, string[]>();
  for (const id of ids) rows.set(level.get(id)!, [...(rows.get(level.get(id)!) ?? []), id]);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [l, row] of rows) row.forEach((id, i) => (pos[id] = { x: l * 220, y: (i - (row.length - 1) / 2) * 110 }));
  return pos;
}

async function post<T>(path: string, json: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/machinery${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}

type Sel = { states: string[]; transitions: Transition[] };
const NO_SEL: Sel = { states: [], transitions: [] };
/** What narrows a process from elsewhere in its tree, as POST …/metrics, …/paths, …/output and …/distribution take it:
 * ancestors' selected objects (only what sits under them) and descendants' (only the objects they sit under). */
export type McScopeKeys = { ancestor_keys: Record<string, string[]> | null; descendant_keys: Record<string, string[]> | null };
const NO_SCOPE: McScopeKeys = { ancestor_keys: null, descendant_keys: null };
/** The scope keys from a ProcessGraph's ancKey (their JSON; "": none). */
function ancOf(ancKey: string): McScopeKeys {
  return ancKey ? (JSON.parse(ancKey) as McScopeKeys) : NO_SCOPE;
}
/** A process' ancestors, nearest first (a missing or cyclic parent ends the chain). */
export function mcAncestors(rec: Machinery, p: Process): Process[] {
  const out: Process[] = [];
  let cur = p;
  for (let i = 0; i < 50 && cur.parent; i++) {
    const up = rec.processes.find((x) => x.id === cur.parent!.process_id);
    if (!up || up.id === p.id || out.includes(up)) break;
    out.push(up);
    cur = up;
  }
  return out;
}
/** The direct subprocesses of a process. */
export function mcChildren(rec: Machinery, p: Process): Process[] {
  return rec.processes.filter((x) => x.parent?.process_id === p.id && x.id !== p.id);
}
/** How another process relates to this one: above it, below it (at any depth), or neither. */
export function mcRelation(rec: Machinery, p: Process, otherId: string): "ancestor" | "descendant" | null {
  if (otherId === p.id) return null;
  if (mcAncestors(rec, p).some((x) => x.id === otherId)) return "ancestor";
  const o = rec.processes.find((x) => x.id === otherId);
  return o && mcAncestors(rec, o).some((x) => x.id === p.id) ? "descendant" : null;
}
/** The scope keys of a process narrowed by selections elsewhere in its tree: each one above it an ancestor key, each one
 * below it a descendant key (two for the same process: the objects in both); unrelated processes are left out. */
export function mcScopeKeys(rec: Machinery, p: Process, narrows: McNarrow[]): McScopeKeys {
  const a: Record<string, string[]> = {};
  const d: Record<string, string[]> = {};
  for (const n of narrows) {
    const rel = mcRelation(rec, p, n.process_id);
    if (!rel) continue;
    const to = rel === "ancestor" ? a : d;
    const have = to[n.process_id];
    if (have) {
      const s = new Set(n.keys);
      to[n.process_id] = have.filter((k) => s.has(k));
    } else to[n.process_id] = n.keys;
  }
  return { ancestor_keys: Object.keys(a).length ? a : null, descendant_keys: Object.keys(d).length ? d : null };
}
const sameT = (a: Transition, b: Transition) => a.from === b.from && a.to === b.to;

// --- custom metric views ("Metric views": a node metric with number formatting and conditional coloring, an optional
// edge metric, Sankey edge thickness) ---------------------------------------------------------------------------------

/** The metrics a custom view's nodes (states) can show — POST …/metrics' state fields — and its edges (transitions). */
export const MC_STATE_METRICS: [string, string][] = [
  ["current_count", "Current count"],
  ["historical_count", "Historical count (entries)"],
  ["ever_count", "Objects ever in the state"],
  ["current_share", "Share currently in the state"],
  ["historical_share", "Share ever in the state"],
  ["current_duration_s", "Current duration (mean)"],
  ["median_current_duration_s", "Current duration (median)"],
  ["historical_duration_s", "Historical duration (mean)"],
  ["median_historical_duration_s", "Historical duration (median)"],
  ["aggregate", "Property aggregate"],
];
export const MC_EDGE_METRICS: [string, string][] = [
  ["count", "Transitions"],
  ["objects", "Objects through it"],
  ["share", "Share of objects through it"],
  ["mean_duration_s", "Duration (mean)"],
  ["median_duration_s", "Duration (median)"],
  ["aggregate", "Property aggregate"],
];
export const MC_AGG_FNS = ["sum", "mean", "median", "min", "max", "count", "distinct"] as const;
const mcKind = (m: MachineryMetric) => (m.metric.endsWith("duration_s") ? "duration" : m.metric.endsWith("share") ? "share" : "number");
/** The id of an aggregate metric in POST …/metrics' request and answer. */
export const mcAggId = (m: MachineryMetric) => `${m.fn ?? "sum"}:${m.scope ?? "current"}:${m.property ?? ""}`;
/** The property aggregates the custom views need (one per distinct property / function / scope; at most 20). */
export function mcAggregates(views: MachineryCustomView[]): MetricAggregate[] {
  const out = new Map<string, MetricAggregate>();
  for (const v of views)
    for (const m of [v.node, v.edge])
      if (m?.metric === "aggregate" && m.property) out.set(mcAggId(m), { id: mcAggId(m), property: m.property, fn: m.fn ?? "sum", scope: m.scope ?? "current" });
  return [...out.values()].slice(0, 20);
}
/** A metric's value on a state or transition row of POST …/metrics (null: none). */
export function mcValue(row: Record<string, unknown> | undefined, m: MachineryMetric): number | null {
  if (!row) return null;
  const v = m.metric === "aggregate" ? (row.aggregates as Record<string, number | null> | undefined)?.[mcAggId(m)] : row[m.metric];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** Numerical formatting: durations as min / h / d, shares as percent, numbers with the decimals (default: as needed). */
export function mcFormat(v: number | null, m: MachineryMetric, f: MachineryFormat = {}): string {
  if (v === null) return "—";
  const style = f.style ?? (mcKind(m) === "duration" ? "duration" : mcKind(m) === "share" ? "percent" : "number");
  const d = f.decimals;
  const s =
    style === "duration" ? dur(v)
    : style === "percent" ? `${(v * 100).toFixed(d ?? 0)}%`
    : style === "compact" ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: d ?? 1 }).format(v)
    : v.toLocaleString("en-US", { minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? (Number.isInteger(v) ? 0 : 2) });
  return `${f.prefix ?? ""}${s}${f.suffix ?? ""}`;
}
/** Conditional coloring: the color of the first rule the value meets. Rules compare durations in hours and shares in
 * percent (0–100); other metrics as they are. */
export function mcColor(v: number | null, m: MachineryMetric, rules: MachineryColorRule[] = []): string | undefined {
  const x = v === null ? null : mcKind(m) === "duration" ? v / 3600 : mcKind(m) === "share" ? v * 100 : v;
  for (const r of rules) {
    if (r.op === "empty") {
      if (x === null) return r.color;
      continue;
    }
    if (x === null || r.value === undefined || r.value === null) continue;
    const a = r.value;
    const hit =
      r.op === ">" ? x > a : r.op === ">=" ? x >= a : r.op === "<" ? x < a : r.op === "<=" ? x <= a : r.op === "=" ? x === a : r.op === "!=" ? x !== a
      : x >= Math.min(a, r.value2 ?? a) && x <= Math.max(a, r.value2 ?? a);
    if (hit) return r.color;
  }
  return undefined;
}

/** The processes a Machinery widget shows: the first (mc_process_id, else the resource's first) with the widget's
 * input / outputs, then mc_more_processes. A process without an input variable takes the one of a shown process with
 * the same root process (the input is the root process' object set; subprocesses follow the link types). */
export function mcProcesses(rec: Machinery, c: WidgetConfig): { proc: Process; cfg: MachineryProcessCfg }[] {
  const first = rec.processes.find((p) => p.id === c.mc_process_id) ?? rec.processes[0];
  if (!first) return [];
  const list: MachineryProcessCfg[] = [
    { process_id: first.id, input_variable: c.mc_input_variable, output_variable: c.mc_output_variable, output_filter_variable: c.mc_output_filter_variable },
    ...(c.mc_more_processes ?? []),
  ];
  const out: { proc: Process; cfg: MachineryProcessCfg }[] = [];
  for (const cfg of list) {
    const proc = rec.processes.find((p) => p.id === cfg.process_id);
    if (proc && !out.some((o) => o.proc.id === proc.id)) out.push({ proc, cfg });
  }
  const rootOf = (p: Process) => {
    let cur = p;
    for (let i = 0; i < 50 && cur.parent; i++) {
      const up = rec.processes.find((x) => x.id === cur.parent!.process_id);
      if (!up) break;
      cur = up;
    }
    return cur.id;
  };
  return out.map((e) => (e.cfg.input_variable ? e : { ...e, cfg: { ...e.cfg, input_variable: out.find((o) => o.cfg.input_variable && rootOf(o.proc) === rootOf(e.proc))?.cfg.input_variable } }));
}

/** A process' selected objects narrowing another process of the tree: a parent tab's selection narrowing its
 * subprocess tabs, or a selection carried by focusing into another process. */
export type McNarrow = { process_id: string; name: string; keys: string[] };
/** A narrowing as a ProcessGraph shows it: from above or below, carried by a focus (the viewer can drop it) or not. */
export type McNarrowShown = McNarrow & { dir: "ancestor" | "descendant"; carried?: boolean };
/** Parent tabs' selections narrowing a subprocess tab: every ancestor of the process shown as a tab with something
 * selected, nearest first — the subprocess then covers only the objects under all of their selected objects. */
export function mcNarrow(rec: Machinery, shown: string[], p: Process, picked: Record<string, { keys: string[] } | null>): McNarrow[] {
  return mcAncestors(rec, p)
    .filter((up) => shown.includes(up.id) && picked[up.id])
    .map((up) => ({ process_id: up.id, name: up.name, keys: picked[up.id]!.keys }));
}
/** A pane's focus ("focus into a parent process", or into a subprocess): the process drawn in place of the tab's own,
 * and the selections carried there (snapshots of the objects selected where the focus came from). */
type McPane = { focus: string; carry: McNarrow[] };
/** Focusing a pane on a process, carrying a selection: the carried selections, the new one replacing an older one of
 * the same process. A target shown as a tab of its own takes the carried selections there (its pane, unfocused). */
export function mcFocus(panes: Record<string, McPane>, shown: string[], pane: string, target: string, carry: McNarrow | null): Record<string, McPane> {
  const cur = panes[pane] ?? { focus: pane, carry: [] };
  const merged = carry ? [...cur.carry.filter((x) => x.process_id !== carry.process_id), carry] : cur.carry;
  if (target !== pane && shown.includes(target)) {
    const t = panes[target] ?? { focus: target, carry: [] };
    return { ...panes, [target]: { focus: target, carry: [...t.carry.filter((x) => !merged.some((m) => m.process_id === x.process_id)), ...merged] } };
  }
  return { ...panes, [pane]: { focus: target, carry: merged } };
}

/** Machinery — the processes of a Machinery resource (one tab each when there are several): states and transitions with
 * their metrics. The objects in the selected states / transitions / paths (every object of the process when nothing is
 * selected) are each process' output object set. */
export function MachineryWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const mid = c.mc_machinery_id;
  const key = mid ? `${mid}|${state.version}` : "";
  const [tab, setTab] = useState<string | null>(null);
  const [res, setRes] = useState<{ key: string; rec?: Machinery; error?: string } | null>(null);
  // each tab's selection (its output keys while something is selected in it): a parent tab's narrows its subprocess tabs
  const [picked, setPicked] = useState<Record<string, { key: string; keys: string[] } | null>>({});
  // each tab's focus: the process its pane shows in place of its own, and the selections carried there
  const [panes, setPanes] = useState<Record<string, McPane>>({});
  const report = useCallback((pid: string, keys: string[] | null) => {
    const key = keys ? keys.join(SEP) : "";
    setPicked((prev) => ((prev[pid]?.key ?? null) === (keys ? key : null) ? prev : { ...prev, [pid]: keys ? { key, keys } : null }));
  }, []);
  useEffect(() => {
    if (!mid) return;
    let stale = false;
    machinery.get(mid).then(
      (rec) => !stale && setRes({ key, rec }),
      (e: Error) => !stale && setRes({ key, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [mid, key]);
  if (!mid) return <div className="p-3 text-xs text-muted">Choose the Machinery resource to show</div>;
  // a reload (after an action) keeps the drawn process until the new one arrives
  if (!res || !res.key.startsWith(`${mid}|`)) return <div className="p-3 text-xs text-muted">Loading…</div>;
  if (res.error || !res.rec) return <div className="p-3 text-xs text-bad">{res.error}</div>;
  const rec = res.rec;
  const procs = mcProcesses(rec, c);
  if (!procs.length) return <div className="p-3 text-xs text-muted">{rec.name} has no process</div>;
  const shown = procs.map((e) => e.proc.id);
  // a pane shows its tab's process, or the process it is focused on (the tab's own stays mounted, hidden: it keeps its
  // selection and keeps writing its outputs; the focused one writes none)
  const pane = (proc: Process, cfg: MachineryProcessCfg) => {
    const ps = panes[proc.id] ?? { focus: proc.id, carry: [] };
    const fproc = ps.focus !== proc.id ? rec.processes.find((x) => x.id === ps.focus) : undefined;
    const narrowsOf = (p: Process): McNarrowShown[] => [
      ...mcNarrow(rec, shown, p, picked).map((n): McNarrowShown => ({ ...n, dir: "ancestor" })),
      ...ps.carry.flatMap((n): McNarrowShown[] => {
        const rel = mcRelation(rec, p, n.process_id);
        return rel ? [{ ...n, dir: rel, carried: true }] : [];
      }),
    ];
    const onFocus = (target: string, carry: McNarrow | null) => {
      setPanes((prev) => mcFocus(prev, shown, proc.id, target, carry));
      if (target !== proc.id && shown.includes(target)) setTab(target);
    };
    const onDropCarry = (pid: string) => setPanes((prev) => {
      const cur = prev[proc.id] ?? { focus: proc.id, carry: [] };
      return { ...prev, [proc.id]: { ...cur, carry: cur.carry.filter((x) => x.process_id !== pid) } };
    });
    const common = { rec, widget, state, onFocus, onDropCarry };
    return (
      <>
        <div className={fproc ? "hidden" : "flex min-h-0 flex-1 flex-col"} data-mc-base={proc.id}>
          <ProcessGraph key={`${mid}:${proc.id}`} {...common} proc={proc} cfg={cfg} narrows={narrowsOf(proc)} onSelection={procs.length > 1 ? report : undefined} />
        </div>
        {fproc && (
          <div className="flex min-h-0 flex-1 flex-col" data-mc-focused={fproc.id}>
            <ProcessGraph key={`${mid}:${proc.id}:focus:${fproc.id}`} {...common} proc={fproc} cfg={{ process_id: fproc.id, input_variable: cfg.input_variable }} narrows={narrowsOf(fproc)}
              writes={false} focusNote={`the outputs follow ${proc.name}`} home={proc} />
          </div>
        )}
      </>
    );
  };
  if (procs.length === 1) return <div className="flex h-full min-h-0 flex-col" data-mc-processes={1}>{pane(procs[0].proc, procs[0].cfg)}</div>;
  // several processes: one tab each; every process stays mounted, so each keeps its selection and writes its outputs
  const active = procs.find((e) => e.proc.id === tab)?.proc.id ?? procs[0].proc.id;
  return (
    <div className="flex h-full min-h-0 flex-col" data-mc-processes={procs.length}>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-panel px-2 pt-1 text-[11px]" role="tablist">
        {procs.map(({ proc }) => (
          <button key={proc.id} type="button" role="tab" aria-selected={proc.id === active} onClick={() => setTab(proc.id)} data-mc-tab={proc.id}
            className={`shrink-0 rounded-t border-b-2 px-2 py-0.5 ${proc.id === active ? "border-ocean text-ocean" : "border-transparent text-muted hover:text-soft"}`}>
            {proc.name}
            {proc.parent ? <span className="text-muted"> · subprocess</span> : null}
            {picked[proc.id] ? <span className="ml-1 rounded bg-ocean/20 px-1 text-ocean" data-mc-tab-selected={picked[proc.id]!.keys.length}>{picked[proc.id]!.keys.length}</span> : null}
          </button>
        ))}
      </div>
      {procs.map(({ proc, cfg }) => (
        <div key={proc.id} className={proc.id === active ? "flex min-h-0 flex-1 flex-col" : "hidden"} data-mc-pane={proc.id}>
          {pane(proc, cfg)}
        </div>
      ))}
    </div>
  );
}

const PATH_COLOR = "#f59e0b";
/** A zoomed-in node card's height: the state's name and three metrics. */
const HC = 100;
const MC_BUCKETS = 20;
const NO_NARROWS: McNarrowShown[] = [];
/** At most this many node metrics pinned. */
const MC_MAX_PINS = 3;
/** A transition node's id in the drawing (the index of the action in the process). */
const ACT = "__action__:";
/** The transitions an action stands for: each input state to each other output state (as api/machinery.py _covers). */
export function mcCovers(a: { inputs: string[]; outputs: string[] }): Transition[] {
  return a.inputs.flatMap((i) => a.outputs.filter((o) => o !== i).map((o) => ({ from: i, to: o })));
}
/** The process as drawn with transition nodes: each action a node between its input and output states, the state
 * transitions an action covers left out (they are drawn through its node). */
export function mcWithActions(p: Process): Process {
  const covered = new Set(p.actions.flatMap((a) => mcCovers(a).map((t) => `${t.from}->${t.to}`)));
  return {
    ...p,
    states: [...p.states, ...p.actions.map((a, i) => ({ id: `${ACT}${i}`, label: a.action_type_id }))],
    transitions: [
      ...p.transitions.filter((t) => !covered.has(`${t.from}->${t.to}`)),
      ...p.actions.flatMap((a, i) => [...a.inputs.map((s) => ({ from: s, to: `${ACT}${i}` })), ...a.outputs.map((s) => ({ from: `${ACT}${i}`, to: s }))]),
    ],
  };
}
/** The percentiles marked on the duration histogram. */
const PCT_MARKS: ["p50" | "p90" | "p95", string][] = [["p50", "#38bdf8"], ["p90", "#f59e0b"], ["p95", "#ef4444"]];
const PCT_ROWS = ["p25", "p50", "p75", "p90", "p95", "p99"] as const;
/** Durations to the second under a minute (the distribution's small values), else as the graph shows them. */
const durS = (s: number | null | undefined) => (s === null || s === undefined ? "—" : s < 60 ? `${Math.round(s)} s` : dur(s));

/** The three metrics of a zoomed-in node card: the active view first, then the views after it (wrapping), filled from
 * the preconfigured views when fewer than three are offered. */
export function mcCardViews(offered: string[], view: string, pinned: string[] = []): string[] {
  const i = Math.max(0, offered.indexOf(view));
  const rest = [...offered.slice(i), ...offered.slice(0, i)];
  // pinned metrics come right after the active view
  const order = [rest[0], ...pinned.filter((k) => k !== rest[0] && offered.includes(k)), ...rest.slice(1).filter((k) => !pinned.includes(k))].filter((k) => k !== undefined);
  for (const [k] of MACHINERY_VIEWS) if (!order.includes(k)) order.push(k);
  return order.slice(0, 3);
}

/** Zooming the graph by `factor` about a point of the drawing (px, py: pixels from the box's top left) that stays
 * under the cursor. view: k (times the fitted view) and cx / cy (the view centre's offset from the fitted centre, in
 * drawing units); fit: the fitted viewBox; box: the drawing's size in pixels (the viewBox is fitted inside it). */
export function mcZoomAt(view: { k: number; cx: number; cy: number }, fit: { x: number; y: number; w: number; h: number }, box: { w: number; h: number }, px: number, py: number, factor: number) {
  const k2 = Math.min(8, Math.max(0.5, view.k * factor));
  const w = fit.w / view.k;
  const h = fit.h / view.k;
  const s = Math.min(box.w / w, box.h / h);
  const vx = fit.x + fit.w / 2 + view.cx - w / 2;
  const vy = fit.y + fit.h / 2 + view.cy - h / 2;
  const offX = (box.w - w * s) / 2;
  const offY = (box.h - h * s) / 2;
  const ux = vx + (px - offX) / s;
  const uy = vy + (py - offY) / s;
  const s2 = (s * k2) / view.k;
  const w2 = fit.w / k2;
  const h2 = fit.h / k2;
  return { k: k2, cx: ux - (px - offX) / s2 + w2 / 2 - (fit.x + fit.w / 2), cy: uy - (py - offY) / s2 + h2 / 2 - (fit.y + fit.h / 2) };
}

function ProcessGraph({ rec, proc, cfg, widget, state, narrows = NO_NARROWS, onSelection, onFocus, onDropCarry, writes = true, focusNote, home }: {
  rec: Machinery; proc: Process; cfg: MachineryProcessCfg; widget: Widget; state: ModuleState;
  /** selections elsewhere in the tree: parent tabs' (only the objects under them) and those carried by a focus */
  narrows?: McNarrowShown[];
  /** reports the output keys while something is selected (null: nothing selected) */
  onSelection?: (pid: string, keys: string[] | null) => void;
  /** focus the pane on another process of the tree, carrying this one's selection (null: nothing selected) */
  onFocus?: (target: string, carry: McNarrow | null) => void;
  /** drop a carried selection */
  onDropCarry?: (pid: string) => void;
  /** false: a focused process — its selection is not written to any output variable */
  writes?: boolean;
  focusNote?: string;
  /** a focused process: the tab's own process, which "Back" returns to (carrying this one's selection) */
  home?: Process;
}) {
  const c = widget.config;
  const custom = useMemo(() => (c.mc_custom_views ?? []).filter((v) => v.id && v.node?.metric), [c.mc_custom_views]);
  const offered: [string, string][] = [...MACHINERY_VIEWS.filter(([k]) => !c.mc_views?.length || c.mc_views.includes(k)), ...custom.map((v): [string, string] => [`custom:${v.id}`, v.name || "Custom view"])];
  const [view, setView] = useState<string>(c.mc_view && offered.some(([k]) => k === c.mc_view) ? c.mc_view : offered[0][0]);
  const [sel, setSel] = useState<Sel>(NO_SEL);
  // metric pinning: node metrics kept on every node beside the active view (the viewer's own, kept in their browser;
  // else the widget's defaults)
  const pinKey = `mc-pins:${widget.id}:${proc.id}`;
  const [pinsOwn, setPinsOwn] = useState<string[] | null>(() => {
    try {
      const v = window.localStorage.getItem(pinKey);
      const x = v ? (JSON.parse(v) as unknown) : null;
      return Array.isArray(x) ? x.filter((k): k is string => typeof k === "string") : null;
    } catch {
      return null;
    }
  });
  const pins = (pinsOwn ?? c.mc_pinned ?? []).filter((k) => offered.some(([x]) => x === k)).slice(0, MC_MAX_PINS);
  const togglePin = (k: string) => {
    const next = pins.includes(k) ? pins.filter((x) => x !== k) : [...pins, k].slice(-MC_MAX_PINS);
    setPinsOwn(next);
    try {
      window.localStorage.setItem(pinKey, JSON.stringify(next));
    } catch {
      // storage unavailable: the pins last as long as the page
    }
  };
  // graph features (the widget header): actions drawn as transition nodes; subprocesses drawn inside their parent states
  const children = useMemo(() => mcChildren(rec, proc), [rec, proc]);
  const ancestors = useMemo(() => mcAncestors(rec, proc).reverse(), [rec, proc]);
  const [showActions, setShowActions] = useState(!!c.mc_transition_nodes);
  const [showSubs, setShowSubs] = useState(!!c.mc_subprocesses);
  const actionsOn = showActions && proc.actions.length > 0;
  const subsOn = showSubs && children.length > 0;
  // the current selection's objects (null: nothing selected), carried when the pane focuses elsewhere
  const selKeys = useRef<string[] | null>(null);
  const [metrics, setMetrics] = useState<{ key: string; m?: Metrics; error?: string } | null>(null);
  const [out, setOut] = useState<{ key: string; total?: number; written?: number; error?: string } | null>(null);
  // the analysis panel on the right (one at a time): the path explorer or the duration distribution
  const explorer = c.mc_path_explorer !== false;
  const distOn = c.mc_duration_distribution !== false;
  const [panel, setPanel] = useState<"paths" | "durations" | null>(null);
  const pathsOpen = panel === "paths" && explorer;
  const durOpen = panel === "durations" && distOn;
  // the path explorer: its variants, the selected paths (each the states joined by SEP) and the hovered one
  const [paths, setPaths] = useState<{ key: string; r?: PathsResult; error?: string } | null>(null);
  const [pathSel, setPathSel] = useState<string[]>([]);
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  // the duration distribution of the graph selection, and the selected buckets (a range; anchor: the first clicked)
  const [dist, setDist] = useState<{ key: string; d?: DurationDistribution; error?: string } | null>(null);
  const [bk, setBk] = useState<{ key: string; from: number; to: number; anchor: number } | null>(null);
  const byUser = useRef(false);
  // the input object set (the root process' objects); a variable without a value does not restrict the process
  const input = cfg.input_variable ? pksOf(state.variables[cfg.input_variable]) : null;
  const inputKey = input ? `in:${input.join(SEP)}` : "";
  // selections elsewhere in the tree: {process id: its selected objects} sent as ancestor_keys / descendant_keys
  const ancKey = narrows.length ? JSON.stringify(mcScopeKeys(rec, proc, narrows)) : "";
  const deviations = !!c.mc_deviations;
  const aggregates = useMemo(() => mcAggregates(custom), [custom]);
  const aggKey = JSON.stringify(aggregates);
  const loadKey = [rec.id, proc.id, deviations, inputKey, ancKey, state.version].join("|");
  const metricsKey = `${loadKey}|${aggKey}`;
  useEffect(() => {
    let stale = false;
    const keys = inputKey ? inputKey.slice(3).split(SEP).filter(Boolean) : null;
    const aggs = JSON.parse(aggKey) as MetricAggregate[];
    (keys || aggs.length || ancKey
      ? post<Metrics>(`/${rec.id}/processes/${proc.id}/metrics`, { include_deviations: deviations, keys, aggregates: aggs, skip_invalid: true, ...ancOf(ancKey) })
      : machinery.metrics(rec.id, proc.id, deviations)
    ).then(
      (m) => !stale && setMetrics({ key: metricsKey, m }),
      (e: Error) => !stale && setMetrics({ key: metricsKey, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [rec.id, proc.id, deviations, inputKey, ancKey, aggKey, metricsKey]);
  // subprocesses drawn inside their parent states: each direct subprocess' metrics over the objects under each state
  const nestKey = subsOn ? `${loadKey}|${children.map((x) => x.id).join(",")}` : "";
  const [nested, setNested] = useState<{ key: string; m: Record<string, Metrics> } | null>(null);
  useEffect(() => {
    if (!nestKey) return;
    let stale = false;
    const keys = inputKey ? inputKey.slice(3).split(SEP).filter(Boolean) : null;
    const jobs = proc.states.flatMap((s) => children.map((ch) => [s.id, ch.id] as const));
    Promise.all(jobs.map(([sid, cid]) =>
      post<Metrics>(`/${rec.id}/processes/${cid}/metrics`, { include_deviations: deviations, keys, parent_states: [sid], ...ancOf(ancKey) }).then((m) => [`${sid}${SEP}${cid}`, m] as const),
    )).then(
      (rows) => !stale && setNested({ key: nestKey, m: Object.fromEntries(rows) }),
      () => !stale && setNested({ key: nestKey, m: {} }),
    );
    return () => {
      stale = true;
    };
    // nestKey holds everything the nested metrics depend on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestKey]);
  const nm = nested && nested.key === nestKey ? nested.m : null;
  // the path explorer's variants: loaded when it is opened, again whenever the process' objects change
  useEffect(() => {
    if (!pathsOpen) return;
    let stale = false;
    const keys = inputKey ? inputKey.slice(3).split(SEP).filter(Boolean) : null;
    post<PathsResult>(`/${rec.id}/processes/${proc.id}/paths`, { include_deviations: deviations, keys, limit: 200, ...ancOf(ancKey) }).then(
      (r) => !stale && setPaths({ key: loadKey, r }),
      (e: Error) => !stale && setPaths({ key: loadKey, error: e.message }),
    );
    return () => {
      stale = true;
    };
  }, [pathsOpen, rec.id, proc.id, deviations, inputKey, ancKey, loadKey]);

  // the duration distribution: the durations of the graph selection (as the node / edge selection options select its
  // objects), loaded while the panel is open, again whenever the selection or the process' objects change
  const stateMode = c.mc_state_mode ?? "current";
  const transitionMode = c.mc_transition_mode ?? "ever";
  const graphKey = JSON.stringify(sel);
  const distKey = [loadKey, graphKey, stateMode, transitionMode].join("|");
  useEffect(() => {
    if (!durOpen) return;
    let stale = false;
    const s = JSON.parse(graphKey) as Sel;
    const keys = inputKey ? inputKey.slice(3).split(SEP).filter(Boolean) : null;
    post<DurationDistribution>(`/${rec.id}/processes/${proc.id}/distribution`, {
      states: s.states, mode: stateMode, transitions: s.transitions, transition_mode: transitionMode, keys, ...ancOf(ancKey), buckets: MC_BUCKETS,
    }).then(
      (d) => !stale && setDist({ key: distKey, d }),
      (e: Error) => !stale && setDist({ key: distKey, error: e.message }),
    );
    return () => {
      stale = true;
    };
    // distKey holds everything the distribution depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durOpen, distKey]);
  const dd = dist?.key === distKey ? dist.d : undefined;
  const bsel = durOpen && dd && dd.buckets.length && bk?.key === distKey ? bk : null;
  const durRange = bsel && dd ? { min_s: bsel.from === 0 ? null : dd.edges[bsel.from], max_s: bsel.to === dd.buckets.length - 1 ? null : dd.edges[bsel.to + 1] } : null;

  // the output object set: the objects in the selection, written to the output variables whenever it changes. While the
  // path explorer is open, selected paths control the output (the graph selection is cleared when a path is chosen);
  // while the duration distribution is open, selected buckets narrow the graph selection to the objects with a
  // duration in them.
  const usePaths = pathsOpen && pathSel.length > 0;
  const selKey = usePaths ? JSON.stringify({ paths: pathSel }) : JSON.stringify({ ...sel, ...(durRange && dd ? { duration: durRange, now: dd.now } : {}) });
  const outKey = [loadKey, selKey, stateMode, transitionMode].join("|");
  useEffect(() => {
    let stale = false;
    const fromUser = byUser.current;
    byUser.current = false;
    const s = JSON.parse(selKey) as Partial<Sel> & { paths?: string[]; duration?: { min_s: number | null; max_s: number | null }; now?: string };
    const keys = inputKey ? inputKey.slice(3).split(SEP).filter(Boolean) : null;
    const anc = ancOf(ancKey);
    const nothing = !s.states?.length && !s.transitions?.length && !s.paths?.length && !s.duration;
    const body = s.paths
      ? { paths: s.paths.map((p) => p.split(SEP)), keys, ...anc, keys_only: true, limit: 5000 }
      : { states: s.states, mode: stateMode, transitions: s.transitions, transition_mode: transitionMode, keys, ...anc, duration: s.duration ?? null, now: s.now ?? null, keys_only: true, limit: 5000 };
    post<{ total: number; keys?: string[]; objects?: { primary_key: string }[] }>(`/${rec.id}/processes/${proc.id}/output`, body).then(
      (r) => {
        if (stale) return;
        const pks = r.keys ?? (r.objects ?? []).map((o) => o.primary_key);
        setOut({ key: outKey, total: r.total, written: pks.length });
        selKeys.current = nothing ? null : pks;
        // a focused process (not the tab's own) writes no outputs
        if (!writes) return;
        if (cfg.output_variable) state.setVariable(cfg.output_variable, pks);
        // nothing selected and no input: every object of the type passes, so the filter variable does not filter
        if (cfg.output_filter_variable) state.setVariable(cfg.output_filter_variable, nothing && !keys && !ancKey ? NO_FILTER : pkFilter(pks));
        // a parent tab's selection narrows its subprocess tabs
        onSelection?.(proc.id, nothing ? null : pks);
        if (fromUser) void state.runEvents?.(c.mc_events ?? []);
      },
      (e: Error) => !stale && setOut({ key: outKey, error: e.message }),
    );
    return () => {
      stale = true;
    };
    // the keys hold everything the output depends on; the variables are written when it changes, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outKey]);

  // a state, a transition, or several transitions at once (a transition node: the transitions its action stands for)
  const pick = (e: React.MouseEvent, next: { state?: string; transition?: Transition; transitions?: Transition[] }) => {
    e.stopPropagation();
    const ts = next.transitions ?? (next.transition ? [next.transition] : []);
    if (next.state === undefined && !ts.length) return;
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    byUser.current = true;
    // a graph selection replaces the path explorer's
    if (pathSel.length) {
      setPathSel([]);
      if (!add) {
        setSel(next.state !== undefined ? { states: [next.state], transitions: [] } : { states: [], transitions: ts });
        return;
      }
    }
    setSel((prev) => {
      if (next.state !== undefined) {
        const id = next.state;
        const on = prev.states.includes(id);
        if (add) return { ...prev, states: on ? prev.states.filter((x) => x !== id) : [...prev.states, id] };
        return on && prev.states.length === 1 && !prev.transitions.length ? NO_SEL : { states: [id], transitions: [] };
      }
      const has = (t: Transition) => prev.transitions.some((x) => sameT(x, t));
      const on = ts.every(has);
      if (add) return { ...prev, transitions: on ? prev.transitions.filter((x) => !ts.some((t) => sameT(x, t))) : [...prev.transitions, ...ts.filter((t) => !has(t))] };
      return on && prev.transitions.length === ts.length && !prev.states.length ? NO_SEL : { states: [], transitions: ts };
    });
  };
  // focusing into another process of the tree carries this one's selection; focusing into a subprocess from a state
  // drawn with it inside carries the objects in that state
  const focusInto = (target: string, sid?: string) => {
    if (!onFocus) return;
    if (sid === undefined) {
      onFocus(target, selKeys.current ? { process_id: proc.id, name: proc.name, keys: selKeys.current } : null);
      return;
    }
    const keys = inputKey ? inputKey.slice(3).split(SEP).filter(Boolean) : null;
    post<{ keys: string[] }>(`/${rec.id}/processes/${proc.id}/output`, { states: [sid], mode: "current", keys, ...ancOf(ancKey), keys_only: true }).then(
      (r) => onFocus(target, { process_id: proc.id, name: `${proc.name}: ${label(sid)}`, keys: r.keys }),
      () => onFocus(target, null),
    );
  };
  const clear = () => {
    if (!sel.states.length && !sel.transitions.length && !pathSel.length && !bsel) return;
    byUser.current = true;
    setSel(NO_SEL);
    setPathSel([]);
    setBk(null);
  };
  const pickPath = (e: React.MouseEvent, id: string) => {
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    byUser.current = true;
    setSel(NO_SEL);
    setPathSel((prev) => (add ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]) : prev.length === 1 && prev[0] === id ? [] : [id]));
  };
  // a bucket: select it alone (again: unselect); Shift / Ctrl-click: the range from the first selected bucket to it
  const pickBucket = (e: React.MouseEvent, i: number) => {
    e.stopPropagation();
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    byUser.current = true;
    setBk((prev) => {
      const cur = prev && prev.key === distKey ? prev : null;
      if (add && cur) return { key: distKey, from: Math.min(cur.anchor, i), to: Math.max(cur.anchor, i), anchor: cur.anchor };
      if (cur && cur.from === i && cur.to === i) return null;
      return { key: distKey, from: i, to: i, anchor: i };
    });
  };
  const togglePanel = (which: "paths" | "durations") => {
    // closing a panel hands the output back to the graph selection
    if ((pathsOpen && pathSel.length) || bsel) byUser.current = true;
    setPanel(panel === which ? null : which);
  };

  // zoom (wheel, the buttons) and pan (dragging the background): k times the fitted view; zoomed in far enough, the
  // nodes become cards with three metrics
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState({ k: 1, cx: 0, cy: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const fitRef = useRef<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 1, h: 1 });
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // the wheel zooms about the cursor (a non-passive listener, so the page does not scroll)
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const f = Math.exp(-e.deltaY / 400);
      setZoom((z) => mcZoomAt(z, fitRef.current, { w: r.width, h: r.height }, e.clientX - r.left, e.clientY - r.top, f));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  // the drawing: the process (with transition nodes: its actions as nodes), flat (the layer layout) or with each
  // state holding its direct subprocesses' graphs (the compound layout of the Machinery page)
  const drawn = useMemo(() => (actionsOn ? mcWithActions(proc) : proc), [proc, actionsOn]);
  const lay = useMemo(() => (subsOn ? layoutNested(drawn, [], [], children, proc.states.map((s) => s.id)) : null), [drawn, subsOn, children, proc.states]);
  const boxes = useMemo((): Record<string, Box> => {
    if (lay) return lay.nodes;
    return Object.fromEntries(Object.entries(processLayout(drawn)).map(([id, p]) => [id, { ...p, w: W, h: H }]));
  }, [lay, drawn]);
  // each edge's path and label position
  const routes = useMemo(() => {
    const out = new Map<string, { d: string; lx: number; ly: number }>();
    if (lay) {
      for (const e of lay.edges) out.set(`${e.from}->${e.to}`, { d: e.d, lx: e.label.x, ly: e.label.y });
      return out;
    }
    for (const e of drawn.transitions) {
      const a = boxes[e.from];
      const b = boxes[e.to];
      if (!a || !b) continue;
      const back = b.x <= a.x;
      const x1 = a.x + (e.from === START ? 20 : W);
      const y1 = a.y + H / 2;
      const x2 = b.x;
      const y2 = b.y + H / 2;
      const d = back ? `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 70} ${b.x + W / 2},${b.y + H + 70} ${b.x + W / 2},${b.y + H}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
      out.set(`${e.from}->${e.to}`, { d, lx: back ? (a.x + b.x) / 2 + W / 2 : (x1 + x2) / 2, ly: back ? Math.max(a.y, b.y) + H + 62 : (y1 + y2) / 2 - 6 });
    }
    return out;
  }, [lay, drawn, boxes]);
  const m = metrics?.m; // kept while the metrics reload
  const stateM = Object.fromEntries((m?.states ?? []).map((s) => [s.id, s]));
  const transM = new Map((m?.transitions ?? []).map((x) => [`${x.from}->${x.to}`, x]));
  const maxT = Math.max(1, ...(m?.transitions ?? []).map((x) => x.count));
  // a transition node's action metrics, and the transitions it stands for (taken, else the defined ones it covers)
  const actM = (i: number) => m?.actions?.find((a) => a.index === i);
  const actTrans = (i: number): Transition[] => {
    const am = actM(i);
    if (am?.transitions.length) return am.transitions.map(({ from, to }) => ({ from, to }));
    return mcCovers(proc.actions[i]).filter((t) => proc.transitions.some((x) => sameT(x, t)));
  };
  const all = Object.values(boxes);
  const minX = Math.min(...all.map((b) => b.x));
  const minY = Math.min(...all.map((b) => b.y));
  const vb = { x: minX - 40, y: minY - 60, w: Math.max(...all.map((b) => b.x + b.w)) - minX + 80, h: Math.max(...all.map((b) => b.y + b.h)) - minY + 150 };
  useLayoutEffect(() => {
    fitRef.current = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
  }, [vb.x, vb.y, vb.w, vb.h]);
  // the shown part of the drawing, and how many pixels a drawing unit takes (the viewBox is fitted in the box)
  const vw = vb.w / zoom.k;
  const vh = vb.h / zoom.k;
  const view0 = { x: vb.x + vb.w / 2 + zoom.cx - vw / 2, y: vb.y + vb.h / 2 + zoom.cy - vh / 2 };
  const scale = box.w && box.h ? Math.min(box.w / vw, box.h / vh) : 0;
  // contextual zoom: a node at least 200 px wide shows a card with three metrics, starting with the active view
  // (not while subprocesses are drawn inside the states: those keep their boxes)
  const cards = scale * W >= 200 && !lay;
  const cardViews = mcCardViews(offered.map(([k]) => k), view, pins);
  // pinned metrics shown under a node: those not already on it (the active view; a card's three)
  const pinsShown = pins.filter((k) => k !== view && !(cards && cardViews.includes(k)));
  const cv = view.startsWith("custom:") ? custom.find((v) => `custom:${v.id}` === view) : undefined;
  const sankey = cv ? !!cv.sankey : c.mc_sankey !== false;
  const label = (id: string) =>
    id === START ? "start"
    : id.startsWith(ACT) ? (actM(+id.slice(ACT.length))?.name ?? proc.actions[+id.slice(ACT.length)]?.action_type_id ?? id)
    : (proc.states.find((s) => s.id === id)?.label ?? id);
  const viewLabel = (k: string) => offered.find(([x]) => x === k)?.[1] ?? MACHINERY_VIEWS.find(([x]) => x === k)?.[1] ?? k;
  /** A state's value in a view (preconfigured or custom) and its color (a custom view's coloring rules). */
  const metricOf = (id: string, k: string): { text: string; color?: string } => {
    const s = stateM[id];
    if (!s) return { text: "" };
    const v = k.startsWith("custom:") ? custom.find((x) => `custom:${x.id}` === k) : undefined;
    if (v) {
      const x = mcValue(s, v.node);
      return { text: mcFormat(x, v.node, v.format), color: v.colors?.length ? mcColor(x, v.node, v.colors) : undefined };
    }
    const x = s[k];
    return { text: k.endsWith("_s") ? dur(x as number | null) : String(x ?? 0) };
  };
  const edgeText = (tm: Record<string, unknown> & { count: number; mean_duration_s: number | null }) =>
    cv ? (cv.edge?.metric ? mcFormat(mcValue(tm, cv.edge), cv.edge, cv.edge_format) : "") : `${tm.count}${tm.mean_duration_s ? ` · ${dur(tm.mean_duration_s)}` : ""}`;
  // coloring rules on edges: the edge metric's value (none: the "no value" rule) colors the transition
  const edgeColor = (tm: Record<string, unknown> | undefined) => (cv?.edge?.metric && cv.edge_colors?.length ? mcColor(mcValue(tm, cv.edge), cv.edge, cv.edge_colors) : undefined);
  const zoomBy = (f: number) => setZoom((z) => mcZoomAt(z, vb, box.w && box.h ? box : { w: vb.w, h: vb.h }, (box.w || vb.w) / 2, (box.h || vb.h) / 2, f));
  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-mc-state],[data-mc-transition]")) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const pan = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !scale) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: true };
    setZoom((z) => ({ ...z, cx: z.cx - dx / scale, cy: z.cy - dy / scale }));
  };
  const endPan = () => {
    if (drag.current && !drag.current.moved) drag.current = null;
  };
  const backgroundClick = () => {
    // a pan ends in a click: it does not clear the selection
    const moved = drag.current?.moved;
    drag.current = null;
    if (!moved) clear();
  };
  // the hovered (else the selected) paths, drawn on the graph: their states and consecutive transitions
  const shownPaths = (pathsOpen ? (hoverPath ? [hoverPath] : pathSel) : []).map((p) => p.split(SEP));
  const onPathState = new Set(shownPaths.flat());
  const onPathT = new Set(shownPaths.flatMap((p) => p.map((s, i) => `${i ? p[i - 1] : START}->${s}`)));
  const marker = `mc-arrow-${widget.id}-${proc.id}`;
  const described = usePaths
    ? `${pathSel.length} path${pathSel.length > 1 ? "s" : ""} (path explorer)`
    : [...sel.states.map((s) => label(s)), ...sel.transitions.map((t) => `${label(t.from)} → ${label(t.to)}`)].join(", ");
  const bucketText = bsel && dd ? `${durS(dd.buckets[bsel.from].from_s)} – ${durS(dd.buckets[bsel.to].to_s)}` : "";
  const current = out?.key === outKey ? out : null;
  const pr = paths?.key === loadKey ? paths : null;
  const de = dist?.key === distKey ? dist : null;
  const measured = !sel.states.length && !sel.transitions.length ? "Time from the first state to the last"
    : sel.states.length && sel.transitions.length ? "Time in the selected states and transitions"
    : sel.states.length ? (stateMode === "current" ? "Time in the state so far (objects now in it)" : "Time in the state (completed stays)")
    : `Time through the transition${transitionMode === "last" ? " (last transitions)" : ""}`;
  return (
    <div className="flex h-full min-h-0 flex-col bg-ink" data-machinery={rec.id} data-machinery-process={proc.id} data-mc-view={view} data-mc-zoom={zoom.k.toFixed(3)} data-mc-cards={cards ? "1" : undefined}>
      {(narrows.length > 0 || focusNote) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-line bg-ocean/10 px-2 py-0.5 text-[11px] text-ocean" data-mc-narrows={narrows.length}>
          {focusNote && (
            <span className="flex items-center gap-1" data-mc-focus-note>
              Focused on {proc.name} · {focusNote}
              {home && onFocus && (
                <button type="button" onClick={() => focusInto(home.id)} className="underline hover:text-soft" data-mc-back>Back to {home.name}</button>
              )}
            </span>
          )}
          {narrows.map((n) => (
            <span key={`${n.dir}:${n.process_id}`} className="flex items-center gap-1" data-mc-narrow={n.process_id} data-mc-narrow-dir={n.dir} data-mc-narrowed={n.keys.length} data-mc-carried={n.carried ? "1" : undefined}>
              {n.dir === "ancestor" ? "Under" : "Above"} the {n.keys.length.toLocaleString()} selected in {n.name}
              {n.carried && onDropCarry && (
                <button type="button" onClick={() => onDropCarry(n.process_id)} className="hover:text-soft" aria-label={`Drop the selection carried from ${n.name}`} data-mc-drop-carry={n.process_id}>
                  <Icon name="x" className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1 text-[11px]">
        <span className="font-medium text-soft">{proc.name}</span>
        {offered.length > 1 ? (
          <select value={view} onChange={(e) => setView(e.target.value)} className={`${fieldClass} py-0.5 text-[11px]`} aria-label="Metric view" data-mc-view-select>
            {offered.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        ) : (
          <span className="text-muted">{offered[0][1]}</span>
        )}
        {offered.length > 1 && (
          <button type="button" onClick={() => togglePin(view)} className={`${barButton} ${pins.includes(view) ? "border-ocean text-ocean" : ""}`} aria-pressed={pins.includes(view)} data-mc-pin={view}
            title={pins.includes(view) ? "Unpin this metric" : `Pin this metric: it stays on every node when another view is chosen (at most ${MC_MAX_PINS})`}>
            <Icon name="star" className="h-3 w-3" /> {pins.includes(view) ? "Pinned" : "Pin"}
          </button>
        )}
        {pins.filter((k) => k !== view).map((k) => (
          <span key={k} className="inline-flex items-center gap-0.5 rounded bg-ocean/10 px-1 text-ocean" data-mc-pinned={k}>
            {viewLabel(k)}
            <button type="button" onClick={() => togglePin(k)} aria-label={`Unpin ${viewLabel(k)}`} className="hover:text-soft" data-mc-unpin={k}><Icon name="x" className="h-2.5 w-2.5" /></button>
          </span>
        ))}
        {proc.actions.length > 0 && (
          <button type="button" onClick={() => setShowActions(!showActions)} className={`${barButton} ${actionsOn ? "border-ocean text-ocean" : ""}`} aria-pressed={actionsOn} data-mc-actions-toggle
            title="Transition nodes: the process' actions drawn as nodes between their input and output states">
            <Icon name="bolt" className="h-3 w-3" /> Actions
          </button>
        )}
        {children.length > 0 && (
          <button type="button" onClick={() => setShowSubs(!showSubs)} className={`${barButton} ${subsOn ? "border-ocean text-ocean" : ""}`} aria-pressed={subsOn} data-mc-subs-toggle
            title="Subprocesses: each state drawn with its direct subprocesses' graphs inside, counted over the objects under it">
            <Icon name="layers" className="h-3 w-3" /> Subprocesses
          </button>
        )}
        {onFocus && (ancestors.length > 0 || children.length > 0) && (
          <select value="" onChange={(e) => e.target.value && focusInto(e.target.value)} className={`${fieldClass} py-0.5 text-[11px]`} aria-label="Focus into another process" data-mc-focus-select
            title="Show another process of the tree here, narrowed by this one's selection">
            <option value="">Focus…</option>
            {ancestors.map((a) => <option key={a.id} value={a.id}>Parent process: {a.name}</option>)}
            {children.map((ch) => <option key={ch.id} value={ch.id}>Subprocess: {ch.name}</option>)}
          </select>
        )}
        {cv?.edge?.metric && <span className="text-muted">edges: {cv.edge.metric === "aggregate" ? `${cv.edge.fn ?? "sum"} of ${cv.edge.property}` : (MC_EDGE_METRICS.find(([k]) => k === cv.edge!.metric)?.[1] ?? cv.edge.metric).toLowerCase()}</span>}
        {m && <span className="ml-auto text-muted">{m.objects} objects · {m.conforming} conforming · {m.deviating} deviating</span>}
        <span className={`flex items-center gap-0.5 ${m ? "" : "ml-auto"}`}>
          <button type="button" onClick={() => zoomBy(1.5)} className={barButton} aria-label="Zoom in" data-mc-zoom-in title="Zoom in (or the mouse wheel); zoomed in, nodes show three metrics"><Icon name="plus" className="h-3 w-3" /></button>
          <button type="button" onClick={() => zoomBy(1 / 1.5)} className={barButton} aria-label="Zoom out" data-mc-zoom-out><Icon name="minus" className="h-3 w-3" /></button>
          <button type="button" onClick={() => setZoom({ k: 1, cx: 0, cy: 0 })} className={barButton} aria-label="Fit the graph" data-mc-zoom-fit><Icon name="fit" className="h-3 w-3" /></button>
        </span>
        {explorer && (
          <button type="button" onClick={() => togglePanel("paths")} className={`${barButton} ${pathsOpen ? "border-ocean text-ocean" : ""}`} aria-pressed={pathsOpen} data-mc-paths-toggle title="Path explorer: the paths the objects took">
            <Icon name="split" className="h-3 w-3" /> Paths
          </button>
        )}
        {distOn && (
          <button type="button" onClick={() => togglePanel("durations")} className={`${barButton} ${durOpen ? "border-ocean text-ocean" : ""}`} aria-pressed={durOpen} data-mc-durations-toggle title="Duration distribution: how long the selection took">
            <Icon name="clock" className="h-3 w-3" /> Durations
          </button>
        )}
      </div>
      {metrics?.error && <div className="px-2 py-1 text-xs text-bad">{metrics.error}</div>}
      {m?.invalid_aggregates && cv && [cv.node, cv.edge].some((x) => x?.metric === "aggregate" && m.invalid_aggregates![mcAggId(x)]) && (
        <div className="px-2 py-1 text-[11px] text-warn" data-mc-invalid>
          {[cv.node, cv.edge].filter((x): x is MachineryMetric => x?.metric === "aggregate" && !!m.invalid_aggregates![mcAggId(x)]).map((x) => m.invalid_aggregates![mcAggId(x)]).join(" · ")}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <svg ref={svgRef} viewBox={`${view0.x} ${view0.y} ${vw} ${vh}`} className="min-h-0 min-w-0 flex-1 touch-none" onClick={backgroundClick}
        onPointerDown={startPan} onPointerMove={pan} onPointerUp={endPan}>
        <defs>
          {/* user-space size: Sankey edges up to 11 px wide keep normal arrowheads */}
          <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
          </marker>
        </defs>
        {drawn.transitions.map((e) => {
          const key = `${e.from}->${e.to}`;
          const r = routes.get(key);
          if (!r) return null;
          // an action's edge (transition nodes): from one of its input states, or to one of its output states
          const into = e.to.startsWith(ACT);
          const ai = into ? +e.to.slice(ACT.length) : e.from.startsWith(ACT) ? +e.from.slice(ACT.length) : -1;
          const am = ai >= 0 ? actM(ai) : undefined;
          const ts: Transition[] = ai < 0 ? [{ from: e.from, to: e.to }] : actTrans(ai).filter((t) => (into ? t.from === e.from : t.to === e.to));
          const tm = ai < 0 ? transM.get(key) : undefined;
          const count = ai < 0 ? tm?.count : am ? ((into ? am.by_input[e.from] : am.by_output[e.to]) ?? 0) : undefined;
          const on = ts.length > 0 && ts.every((t) => sel.transitions.some((x) => sameT(x, t)));
          const onPath = ts.some((t) => onPathT.has(`${t.from}->${t.to}`));
          const text = tm ? edgeText(tm) : ai >= 0 && count ? String(count) : "";
          const ecol = ai < 0 ? edgeColor(tm) : undefined;
          const width = sankey && count !== undefined ? 1 + Math.min(1, count / maxT) * 10 : undefined;
          return (
            <g key={key} className="cursor-pointer" onClick={(ev) => pick(ev, { transitions: ts })} data-mc-transition={key} data-mc-action-edge={ai >= 0 ? ai : undefined} data-mc-on-path={onPath ? "1" : undefined} data-mc-edge-color={ecol}>
              <path d={r.d} fill="none" stroke="transparent" strokeWidth={14} />
              <path d={r.d} fill="none" stroke={on ? "#38bdf8" : onPath ? PATH_COLOR : (ecol ?? "#64748b")} strokeWidth={width ?? (onPath ? 3 : ecol ? 2.2 : 1.6)} strokeOpacity={ecol && !on && !onPath ? 0.9 : 0.75}
                strokeDasharray={ai >= 0 && !on ? "5 3" : undefined} markerEnd={`url(#${marker})`} data-mc-width={width} />
              {text && (
                <text x={r.lx} y={r.ly} textAnchor="middle" fontSize={11} className={on ? "fill-ocean" : ecol ? undefined : "fill-muted"} fill={on ? undefined : ecol} fontWeight={ecol ? 600 : undefined} data-mc-edge-value>
                  {text}
                </text>
              )}
            </g>
          );
        })}
        {[START, ...drawn.states.map((s) => s.id)].map((id) => {
          const p = boxes[id];
          if (!p) return null;
          if (id.startsWith(ACT)) {
            // a transition node: the action, with the entries it caused; clicking selects the transitions it stands for
            const i = +id.slice(ACT.length);
            const am = actM(i);
            const ts = actTrans(i);
            const on = ts.length > 0 && ts.every((t) => sel.transitions.some((x) => sameT(x, t)));
            const a = proc.actions[i];
            return (
              <g key={id} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" onClick={(ev) => pick(ev, { transitions: ts })} data-mc-action-node={i} data-mc-action-count={am?.count ?? ""}>
                <title>{[label(id), `${am?.count ?? 0} entries, ${am?.objects ?? 0} objects`, am?.mean_duration_s ? `mean ${dur(am.mean_duration_s)}` : "", `${a.inputs.map(label).join(", ") || "—"} → ${a.outputs.map(label).join(", ") || "—"}`].filter(Boolean).join("\n")}</title>
                <rect width={W} height={H} rx={H / 2} fill="var(--color-ink)" stroke={on ? "#38bdf8" : "#a78bfa"} strokeWidth={on ? 2.5 : 1.3} strokeDasharray={on ? undefined : "4 3"} />
                <text x={W / 2} y={21} textAnchor="middle" fontSize={11} className="fill-soft" fontWeight={600}>{(a.automation ? "⚡ " : "") + label(id).slice(0, 20)}</text>
                <text x={W / 2} y={40} textAnchor="middle" fontSize={12} fill="#a78bfa" fontWeight={700} data-mc-action-value>{am ? `${am.count} · ${dur(am.mean_duration_s)}` : ""}</text>
              </g>
            );
          }
          // pinned metrics under the node (those it does not show already)
          const pinRows = (top: number) =>
            pinsShown.map((k, j) => {
              const r = metricOf(id, k);
              return (
                <text key={k} x={4} y={top + 12 + j * 12} fontSize={9.5} className={r.color ? undefined : "fill-muted"} fill={r.color} data-mc-pin-value={k} pointerEvents="none">
                  {viewLabel(k).slice(0, 18)}: <tspan fontWeight={600}>{r.text || "—"}</tspan>
                </text>
              );
            });
          const groups = lay?.groups[id];
          if (groups?.length) {
            // a state drawn with its direct subprocesses inside (each counted over the objects under the state)
            const on = sel.states.includes(id);
            const main = metricOf(id, view);
            return (
              <g key={id} transform={`translate(${p.x},${p.y})`} data-mc-state={id} data-mc-expanded="1" className="cursor-pointer" onClick={(ev) => pick(ev, { state: id })}>
                <title>{label(id)}</title>
                <rect width={p.w} height={p.h} rx={10} fill="var(--color-panel)" stroke={on ? "#38bdf8" : (main.color ?? "#475569")} strokeWidth={on ? 2.5 : 1.3} />
                <text x={12} y={21} fontSize={12} className="fill-soft" fontWeight={600}>{label(id).slice(0, 28)}</text>
                <text x={12} y={41} fontSize={14} className={main.color ? undefined : "fill-ocean"} fill={main.color} fontWeight={700} data-mc-value>{main.text}</text>
                {groups.map((g) => {
                  const ch = children.find((x) => x.id === g.pid);
                  const gm = nm?.[`${id}${SEP}${g.pid}`];
                  const gs = Object.fromEntries((gm?.states ?? []).map((s) => [s.id, s]));
                  const gt = new Map((gm?.transitions ?? []).map((x) => [`${x.from}->${x.to}`, x]));
                  const into = (ev: React.MouseEvent) => {
                    ev.stopPropagation();
                    focusInto(g.pid, id);
                  };
                  return (
                    <g key={g.pid} transform={`translate(${-p.x},${-p.y})`} onClick={into} data-mc-group={g.pid} data-mc-group-state={id} data-mc-group-objects={gm ? gm.objects : ""}>
                      <title>{`${ch?.name ?? g.pid}: the objects under ${label(id)} — click to focus into it`}</title>
                      <rect x={g.box.x - 6} y={g.box.y} width={g.box.w + 12} height={g.box.h + 6} rx={6} fill="var(--color-ink)" stroke="#334155" />
                      <text x={g.title.x} y={g.title.y} fontSize={10} className="fill-muted">
                        {ch?.name ?? g.pid} · {gm ? `${gm.objects.toLocaleString()} objects` : "…"}
                      </text>
                      {g.graph.edges.map((e) => {
                        const n = gt.get(`${e.from}->${e.to}`)?.count;
                        return (
                          <g key={`${e.from}->${e.to}`}>
                            <path d={e.d} fill="none" stroke="#64748b" strokeWidth={1.1} strokeOpacity={0.7} markerEnd={`url(#${marker})`} />
                            {!!n && <text x={e.label.x} y={e.label.y} textAnchor="middle" fontSize={9} className="fill-muted">{n}</text>}
                          </g>
                        );
                      })}
                      {Object.entries(g.graph.nodes).map(([sid, b]) =>
                        sid === START ? (
                          <circle key={sid} cx={b.x + 8} cy={b.y + b.h / 2} r={7} fill="#334155" />
                        ) : (
                          <g key={sid} transform={`translate(${b.x},${b.y})`} data-mc-group-node={sid} data-mc-group-count={gs[sid]?.current_count ?? ""}>
                            <rect width={b.w} height={b.h} rx={8} fill="var(--color-panel)" stroke="#475569" />
                            <text x={8} y={18} fontSize={10} className="fill-soft" fontWeight={600}>{(ch?.states.find((s) => s.id === sid)?.label ?? sid).slice(0, 18)}</text>
                            <text x={8} y={36} fontSize={12} className="fill-ocean" fontWeight={700}>{gs[sid] ? (view in gs[sid] && !view.startsWith("custom:") ? (view.endsWith("_s") ? dur(gs[sid][view] as number | null) : String(gs[sid][view] ?? 0)) : String(gs[sid].current_count)) : ""}</text>
                          </g>
                        ),
                      )}
                    </g>
                  );
                })}
                {pinRows(p.h)}
              </g>
            );
          }
          if (id === START)
            return (
              <g key={id} transform={`translate(${p.x},${p.y + H / 2 - 10})`}>
                <circle cx={10} cy={10} r={10} fill="#334155" />
                <text x={10} y={-6} textAnchor="middle" fontSize={10} className="fill-muted">start</text>
              </g>
            );
          const on = sel.states.includes(id);
          const main = metricOf(id, view);
          const color = main.color;
          const onPath = onPathState.has(id);
          // hovering a node reveals every metric
          const tip = [label(id), ...offered.map(([k, l]) => `${l}: ${metricOf(id, k).text || "—"}`)].join("\n");
          const stroke = on ? "#38bdf8" : onPath ? PATH_COLOR : (color ?? "#475569");
          if (cards)
            return (
              <g key={id} transform={`translate(${p.x},${p.y - (HC - H) / 2})`} className="cursor-pointer" onClick={(ev) => pick(ev, { state: id })} data-mc-state={id} data-mc-color={color} data-mc-on-path={onPath ? "1" : undefined} data-mc-card>
                <title>{tip}</title>
                <rect width={W} height={HC} rx={10} fill="var(--color-panel)" stroke={stroke} strokeWidth={on ? 2.5 : onPath || color ? 2 : 1.3} />
                {color && <rect width={W} height={HC} rx={10} fill={color} fillOpacity={0.12} pointerEvents="none" />}
                <text x={10} y={17} fontSize={11} className="fill-soft" fontWeight={600}>{label(id).slice(0, 22)}</text>
                {cardViews.map((k, i) => {
                  const r = i === 0 ? main : metricOf(id, k);
                  return (
                    <g key={k} transform={`translate(0,${38 + i * 22})`} data-mc-card-metric={k}>
                      <text x={10} y={0} fontSize={8.5} className="fill-muted" data-mc-card-label>{viewLabel(k).slice(0, 20)}</text>
                      <text x={W - 10} y={0} fontSize={i === 0 ? 13 : 11} textAnchor="end" className={r.color ? undefined : i === 0 ? "fill-ocean" : "fill-soft"} fill={r.color} fontWeight={i === 0 ? 700 : 600}
                        data-mc-value={i === 0 ? "" : undefined} data-mc-card-value data-mc-card-color={r.color}>{r.text}</text>
                    </g>
                  );
                })}
                {pinRows(HC)}
              </g>
            );
          return (
            <g key={id} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" onClick={(ev) => pick(ev, { state: id })} data-mc-state={id} data-mc-color={color} data-mc-on-path={onPath ? "1" : undefined}>
              <title>{tip}</title>
              <rect width={W} height={H} rx={10} fill="var(--color-panel)" stroke={stroke} strokeWidth={on ? 2.5 : onPath || color ? 2 : 1.3} />
              {color && <rect width={W} height={H} rx={10} fill={color} fillOpacity={0.16} pointerEvents="none" />}
              <text x={12} y={21} fontSize={12} className="fill-soft" fontWeight={600}>{label(id).slice(0, 20)}</text>
              <text x={12} y={41} fontSize={14} className={color ? undefined : "fill-ocean"} fill={color} fontWeight={700} data-mc-value>{main.text}</text>
              {pinRows(H)}
            </g>
          );
        })}
      </svg>
      {pathsOpen && (
        <div className="flex w-64 shrink-0 flex-col border-l border-line bg-panel text-[11px]" data-mc-path-explorer onMouseLeave={() => setHoverPath(null)}>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
            <span className="font-medium text-soft">Path explorer</span>
            {pr?.r && <span className="ml-auto text-muted">{pr.r.variants} path{pr.r.variants === 1 ? "" : "s"} · {pr.r.objects} objects</span>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!pr && <div className="p-2 text-muted">Loading…</div>}
            {pr?.error && <div className="p-2 text-bad">{pr.error}</div>}
            {pr?.r && pr.r.paths.length === 0 && <div className="p-2 text-muted">No object took a path</div>}
            {pr?.r?.paths.map((v) => {
              const id = v.path.join(SEP);
              const on = pathSel.includes(id);
              return (
                <button key={id} type="button" onClick={(e) => pickPath(e, id)} onMouseEnter={() => setHoverPath(id)} data-mc-path={v.path.join(" > ")} aria-pressed={on}
                  className={`block w-full border-b border-line px-2 py-1 text-left ${on ? "bg-ocean/15" : "hover:bg-ink"}`}>
                  <div className={`truncate ${on ? "text-ocean" : "text-soft"}`} title={v.path.map(label).join(" → ")}>{v.path.map(label).join(" → ")}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-muted">
                    <span className="h-1.5 flex-1 overflow-hidden rounded bg-ink"><span className="block h-full bg-ocean" style={{ width: `${Math.max(2, v.share * 100)}%` }} /></span>
                    <span className="shrink-0" data-mc-path-count>{v.count} · {(v.share * 100).toFixed(v.share < 0.1 ? 1 : 0)}%</span>
                    {v.mean_duration_s !== null && <span className="shrink-0" title={`median ${dur(v.median_duration_s)}, ${dur(v.min_duration_s)} – ${dur(v.max_duration_s)}`}>{dur(v.mean_duration_s)}</span>}
                    {!v.conforming && <span className="shrink-0 text-warn">deviating</span>}
                  </div>
                </button>
              );
            })}
            {pr?.r?.truncated && <div className="p-2 text-muted">The {pr.r.paths.length} most frequent paths are listed</div>}
          </div>
          <div className="shrink-0 border-t border-line px-2 py-1 text-muted">Hover a path to see it on the graph; select paths (Ctrl-click adds) to make them the output.</div>
        </div>
      )}
      {durOpen && (
        <div className="flex w-72 shrink-0 flex-col border-l border-line bg-panel text-[11px]" data-mc-durations data-mc-measure={dd?.measure}>
          <div className="shrink-0 border-b border-line px-2 py-1">
            <div className="font-medium text-soft">Duration distribution</div>
            <div className="truncate text-muted" title={measured}>{measured}{described && !usePaths ? ` · ${described}` : ""}</div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!de && <div className="text-muted">Loading…</div>}
            {de?.error && <div className="text-bad">{de.error}</div>}
            {dd && dd.count === 0 && <div className="text-muted" data-mc-dist-empty>No durations: {dd.selected_objects.toLocaleString()} objects selected, none with a duration of this kind</div>}
            {dd && dd.count > 0 && <DurationHistogram d={dd} sel={bsel} onPick={pickBucket} />}
          </div>
          <div className="shrink-0 border-t border-line px-2 py-1 text-muted">Select a bucket for the objects with a duration in it (Shift-click: a range); combine with a state or transition selected on the graph.</div>
        </div>
      )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-2 py-1 text-[11px] text-muted" data-mc-output={current?.total ?? ""}>
        <span className="min-w-0 flex-1 truncate">
          {described
            ? usePaths ? `${described}: objects that took ${pathSel.length > 1 ? "one of them" : "it"}` : `${described}: ${sel.states.length ? (stateMode === "ever" ? "ever in" : "currently in") : transitionMode === "last" ? "last transition" : "ever went through"}`
            : bucketText ? "Every object of the process" : "Every object of the process — select a state or a transition (Ctrl-click adds)"}
          {bucketText && <span data-mc-bucket-range> · with a duration of {bucketText}</span>}
          {current?.error ? <span className="text-bad"> · {current.error}</span> : current?.total !== undefined ? ` · ${current.total.toLocaleString()} objects` : ""}
          {current?.total !== undefined && current.written !== undefined && current.written < current.total ? ` (the first ${current.written.toLocaleString()} in the output)` : ""}
        </span>
        {(described || bucketText) && <button type="button" onClick={clear} className="shrink-0 hover:text-ocean">Clear</button>}
        <a href={`/machinery?id=${encodeURIComponent(rec.id)}&process=${encodeURIComponent(proc.id)}`} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 hover:text-ocean">
          Open in Machinery <Icon name="external" className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

/** The duration distribution's histogram: equal-width buckets (click: select one; Shift-click: a range), the median,
 * 90th and 95th percentiles marked, and the summary statistics. */
function DurationHistogram({ d, sel, onPick }: { d: DurationDistribution; sel: { from: number; to: number } | null; onPick: (e: React.MouseEvent, i: number) => void }) {
  const Wd = 256;
  const top = 16;
  const bh = 92;
  const n = d.buckets.length;
  const bw = (Wd - 8) / n;
  const most = Math.max(1, ...d.buckets.map((b) => b.count));
  const lo = d.edges[0];
  const hi = d.edges[d.edges.length - 1];
  const xOf = (v: number) => 4 + ((v - lo) / (hi - lo || 1)) * (Wd - 8);
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${Wd} ${top + bh + 30}`} className="w-full" data-mc-histogram>
        {d.buckets.map((b, i) => {
          const on = !!sel && i >= sel.from && i <= sel.to;
          const h = b.count ? Math.max(1.5, (b.count / most) * bh) : 0;
          return (
            <g key={i} className="cursor-pointer" onClick={(e) => onPick(e, i)} data-mc-bucket={i} data-mc-bucket-count={b.count} data-mc-bucket-objects={b.objects} aria-pressed={on}>
              <title>{`${durS(b.from_s)} – ${durS(b.to_s)}: ${b.count} duration${b.count === 1 ? "" : "s"}, ${b.objects} object${b.objects === 1 ? "" : "s"}`}</title>
              <rect x={4 + i * bw} y={top} width={bw} height={bh} fill="transparent" />
              <rect x={4 + i * bw + 0.5} y={top + bh - h} width={Math.max(0.5, bw - 1)} height={h} rx={1} fill={on ? "#38bdf8" : "#64748b"} fillOpacity={sel && !on ? 0.4 : 0.9} />
            </g>
          );
        })}
        <line x1={4} x2={Wd - 4} y1={top + bh + 0.5} y2={top + bh + 0.5} stroke="#475569" />
        {PCT_MARKS.map(([k, color]) => {
          const v = d.percentiles[k];
          if (v === null) return null;
          const x = xOf(v);
          return <line key={k} x1={x} x2={x} y1={top - 4} y2={top + bh} stroke={color} strokeDasharray="3 2" strokeWidth={1.2} pointerEvents="none" data-mc-pct-mark={k} data-x={x} />;
        })}
        {PCT_MARKS.map(([k, color], j) => (
          <text key={k} x={4 + j * 40} y={9} fontSize={8} fill={color}>— {k}</text>
        ))}
        <text x={4} y={top + bh + 13} fontSize={9} className="fill-muted">{durS(lo)}</text>
        <text x={Wd - 4} y={top + bh + 13} fontSize={9} textAnchor="end" className="fill-muted">{durS(hi)}</text>
        <text x={Wd / 2} y={top + bh + 26} fontSize={9} textAnchor="middle" className="fill-muted">{d.count.toLocaleString()} durations · {d.objects.toLocaleString()} objects</text>
      </svg>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5" data-mc-dist-stats>
        <span className="text-muted">Mean</span><span className="text-right text-soft" data-mc-stat="mean" data-v={d.mean_s ?? ""}>{durS(d.mean_s)}</span>
        <span className="text-muted">Min</span><span className="text-right text-soft" data-mc-stat="min" data-v={d.min_s ?? ""}>{durS(d.min_s)}</span>
        <span className="text-muted">Max</span><span className="text-right text-soft" data-mc-stat="max" data-v={d.max_s ?? ""}>{durS(d.max_s)}</span>
        {PCT_ROWS.map((k) => (
          <span key={k} className="contents">
            <span className="text-muted">{k === "p50" ? "Median (p50)" : k}</span>
            <span className="text-right text-soft" data-mc-pct={k} data-v={d.percentiles[k] ?? ""}>{durS(d.percentiles[k])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

const GRAPH_TYPES = new Set(["vertex_graph", "machinery"]);
const SET_TYPES: Variable["type"][] = ["object_set", "array"];

export function GraphWidgetConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const t = widget.type;
  const vars = mod.variables ?? [];
  const [graphs, setGraphs] = useState<GraphRow[] | null>(null);
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [template, setTemplate] = useState<{ id: string; graph: Graph } | null>(null);
  const [resources, setResources] = useState<{ id: string; name: string }[] | null>(null);
  const [rec, setRec] = useState<Machinery | null>(null);
  const [actionTypes, setActionTypes] = useState<ActionType[] | null>(null);
  useEffect(() => {
    if (t === "vertex_graph") {
      ontology.actionTypes().then((a) => setActionTypes(a.filter((x) => x.kind !== "create" && x.object_type_id)), () => setActionTypes([]));
      vertex.graphs().then(setGraphs, () => setGraphs([]));
      ontology.objectTypes().then(setTypes, () => setTypes([]));
    }
    if (t === "machinery") machinery.list().then(setResources, () => setResources([]));
  }, [t]);
  // a graph template's parameters, and a Machinery resource's processes
  const isTemplate = t === "vertex_graph" && !!c.vx_graph_id && !!graphs?.find((g) => g.id === c.vx_graph_id)?.template;
  const templateId = isTemplate ? c.vx_graph_id : undefined;
  useEffect(() => {
    if (!templateId) return;
    let stale = false;
    vertex.graph(templateId).then((graph) => !stale && setTemplate({ id: templateId, graph }), () => undefined);
    return () => {
      stale = true;
    };
  }, [templateId]);
  const mid = t === "machinery" ? c.mc_machinery_id : undefined;
  useEffect(() => {
    if (!mid) return;
    let stale = false;
    machinery.get(mid).then((r) => !stale && setRec(r), () => undefined);
    return () => {
      stale = true;
    };
  }, [mid]);
  if (!GRAPH_TYPES.has(t)) return null;
  const varSel = (value: string | undefined, onChange: (v: string | undefined) => void, kinds: Variable["type"][], none = "None") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{none}</option>
      {vars.filter((v) => kinds.includes(v.type)).map((v) => <option key={v.name} value={v.name}>{v.name} ({v.type.replace(/_/g, " ")})</option>)}
    </select>
  );
  const parameters = template && template.id === templateId ? (template.graph.template?.parameters ?? []) : [];
  const processes = rec && rec.id === mid ? rec.processes : [];
  const views = c.mc_views?.length ? c.mc_views : MACHINERY_VIEWS.map(([k]) => k);
  const more = c.mc_more_processes ?? [];
  const setMore = (next: MachineryProcessCfg[]) => set({ mc_more_processes: next.length ? next : undefined });
  const firstProc = processes.find((p) => p.id === c.mc_process_id) ?? processes[0];
  const shownTypes = [...new Set([firstProc, ...more.map((x) => processes.find((p) => p.id === x.process_id))].filter((p): p is Process => !!p).map((p) => p.object_type_id))];
  const customViews = c.mc_custom_views ?? [];
  const setCustom = (next: MachineryCustomView[]) => set({ mc_custom_views: next.length ? next : undefined, ...(c.mc_view?.startsWith("custom:") && !next.some((v) => `custom:${v.id}` === c.mc_view) ? { mc_view: undefined } : {}) });
  return (
    <div className="space-y-3 text-xs" data-graph-config>
      {t === "vertex_graph" && (
        <>
          <div className="font-semibold uppercase tracking-wide text-muted">Input</div>
          <Field label="Resource (a string variable holding a graph id)">
            {varSel(c.vx_graph_variable, (v) => set({ vx_graph_variable: v }), ["string"], "A fixed graph")}
          </Field>
          {!c.vx_graph_variable && (
            <Field label="Graph or graph template">
              <select value={c.vx_graph_id ?? ""} onChange={(e) => set({ vx_graph_id: e.target.value || undefined, vx_parameters: undefined })} className={inputClass} data-vx-graph>
                <option value="">Choose…</option>
                {(graphs ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}{g.template ? " · template" : ` · ${g.nodes} objects`}</option>)}
              </select>
            </Field>
          )}
          {parameters.length > 0 && <div className="text-muted">Template parameters (object set variables)</div>}
          {parameters.map((p) => (
            <label key={p.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-soft" title={p.name}>{p.name || p.id}</span>
              {varSel(c.vx_parameters?.[p.id], (v) => set({ vx_parameters: { ...(c.vx_parameters ?? {}), [p.id]: v ?? "" } }), ["object_set", "array", "object", "string"], "Choose a variable…")}
            </label>
          ))}
          <Field label="Refresh key" hint="The graph reloads whenever this variable's value changes.">
            {varSel(c.vx_refresh_variable, (v) => set({ vx_refresh_variable: v }), ["string", "number", "boolean", "date", "timestamp", "array", "object", "object_set"])}
          </Field>
          <Field label="Sub-graph" hint="Only the connected parts of the graph holding an object of this variable are shown (empty, or none of them on the graph: the whole graph).">
            {varSel(c.vx_subgraph_variable, (v) => set({ vx_subgraph_variable: v }), ["object_set", "array", "object", "string"])}
          </Field>
          {c.vx_subgraph_variable && (
            <Field label="Sub-graph: object type of the set">
              <select value={c.vx_subgraph_object_type_id ?? ""} onChange={(e) => set({ vx_subgraph_object_type_id: e.target.value || undefined })} className={inputClass}>
                <option value="">Any object type</option>
                {(types ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name || o.api_name}</option>)}
              </select>
            </Field>
          )}
          <div className="font-semibold uppercase tracking-wide text-muted">Interaction</div>
          <Field label="Output object type" hint="An object set holds one type's objects. All types: every selected object's primary key.">
            <select value={c.vx_object_type_id ?? ""} onChange={(e) => set({ vx_object_type_id: e.target.value || undefined })} className={inputClass}>
              <option value="">All object types</option>
              {(types ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name || o.api_name}</option>)}
            </select>
          </Field>
          <Field label="Selected objects (output: an object set variable)">{varSel(c.vx_selected_variable, (v) => set({ vx_selected_variable: v }), SET_TYPES)}</Field>
          <Field label="Selected objects (output: an object set filter variable)" hint="Data widgets apply it under Object set filter variables applied. Nothing selected: no filter.">
            {varSel(c.vx_selected_filter_variable, (v) => set({ vx_selected_filter_variable: v }), ["object_set_filter"])}
          </Field>
          <Field label="Objects on graph / on the sub-graph (output: an object set variable)">{varSel(c.vx_objects_variable, (v) => set({ vx_objects_variable: v }), SET_TYPES)}</Field>
          <Field label="Highlight object set" hint="The objects of this variable are selected in the graph whenever it changes.">
            {varSel(c.vx_highlight_variable, (v) => set({ vx_highlight_variable: v }), ["object_set", "array", "object", "string"])}
          </Field>
          <Field label="Add objects to subgraph" hint="The objects of this variable are drawn on the graph (and on the shown sub-graph) while the variable holds them, beside the objects they link to. Not saved with the graph.">
            {varSel(c.vx_add_variable, (v) => set({ vx_add_variable: v }), ["object_set", "array", "object", "string"])}
          </Field>
          {c.vx_add_variable && (
            <Field label="Add objects to subgraph: object type of the set" hint="The type of the variable's primary keys (values that carry their own object type keep it).">
              <select value={c.vx_add_object_type_id ?? ""} onChange={(e) => set({ vx_add_object_type_id: e.target.value || undefined })} className={inputClass} data-vx-add-type>
                <option value="">Choose…</option>
                {(types ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name || o.api_name}</option>)}
              </select>
            </Field>
          )}
          <div className="text-muted">Selected objects of one type (outputs: object set variables)</div>
          {Object.entries(c.vx_type_outputs ?? {}).map(([tid, v]) => (
            <div key={tid} className="flex items-center gap-2" data-vx-type-output={tid}>
              <span className="w-28 shrink-0 truncate text-soft" title={tid}>{(types ?? []).find((o) => o.id === tid)?.display_name ?? tid}</span>
              {varSel(v, (nv) => set({ vx_type_outputs: { ...(c.vx_type_outputs ?? {}), [tid]: nv ?? "" } }), SET_TYPES, "Choose a variable…")}
              <button type="button" aria-label="Remove the output" className="text-muted hover:text-bad"
                onClick={() => { const next = { ...(c.vx_type_outputs ?? {}) }; delete next[tid]; set({ vx_type_outputs: Object.keys(next).length ? next : undefined }); }}>
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
          ))}
          <select value="" onChange={(e) => e.target.value && set({ vx_type_outputs: { ...(c.vx_type_outputs ?? {}), [e.target.value]: "" } })} className={inputClass} data-vx-add-type-output>
            <option value="">Add an output for an object type…</option>
            {(types ?? []).filter((o) => !(o.id in (c.vx_type_outputs ?? {}))).map((o) => <option key={o.id} value={o.id}>{o.display_name || o.api_name}</option>)}
          </select>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.vx_select_tools !== false} onChange={(e) => set({ vx_select_tools: e.target.checked ? undefined : false })} data-vx-select-tools />
            Sub-graph selection: box select (Shift-drag), select neighbours / connected / same type / all / invert
          </label>
          <EventsEditor events={c.vx_events ?? []} mod={mod} onChange={(ev) => set({ vx_events: ev.length ? ev : undefined })} label="On selected objects change" />
          <Field label="Zoom to object set" hint="The view fits the objects of this variable whenever it changes (empty, or none of them on the graph: the whole graph). The selection is not changed.">
            {varSel(c.vx_zoom_variable, (v) => set({ vx_zoom_variable: v }), ["object_set", "array", "object", "string"])}
          </Field>
          {c.vx_zoom_variable && (
            <Field label="Zoom: object type of the set" hint="Primary keys of different types can be equal; choose the type the variable holds.">
              <select value={c.vx_zoom_object_type_id ?? ""} onChange={(e) => set({ vx_zoom_object_type_id: e.target.value || undefined })} className={inputClass}>
                <option value="">Any object type</option>
                {(types ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name || o.api_name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Available actions" hint="Offered on the one selected object, in a bar above the graph; run in the action's form with the object filled in. Off in kiosk mode.">
            <select value={c.vx_actions ?? "none"} onChange={(e) => set({ vx_actions: e.target.value === "none" ? undefined : (e.target.value as "some" | "all") })} className={inputClass} data-vx-actions>
              <option value="none">None</option>
              <option value="some">Some: the actions chosen below</option>
              <option value="all">All: every action of the selected object&apos;s type</option>
            </select>
          </Field>
          {c.vx_actions === "some" && (
            <div className="max-h-40 space-y-1 overflow-auto rounded border border-line p-2">
              {(actionTypes ?? []).length === 0 && <div className="text-muted">{actionTypes ? "No action types" : "Loading…"}</div>}
              {(actionTypes ?? []).map((a) => (
                <label key={a.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={(c.vx_action_ids ?? []).includes(a.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...(c.vx_action_ids ?? []), a.id] : (c.vx_action_ids ?? []).filter((x) => x !== a.id);
                      set({ vx_action_ids: next.length ? next : undefined });
                    }} />
                  <span className="truncate">{a.display_name} <span className="text-muted">· {(types ?? []).find((o) => o.id === a.object_type_id)?.display_name ?? a.object_type_id}</span></span>
                </label>
              ))}
            </div>
          )}
          {(c.vx_actions ?? "none") !== "none" && (
            <EventsEditor events={c.vx_action_events ?? []} mod={mod} onChange={(ev) => set({ vx_action_events: ev.length ? ev : undefined })} label="On successful action application" />
          )}
          <div className="font-semibold uppercase tracking-wide text-muted">Time configuration</div>
          <Field label="Selected time" hint="Readouts are read as of this time; event badges count the events until it. Default: the time the graph is loaded.">
            <div className="flex gap-2">
              <select value={c.vx_time_kind || c.vx_time_variable ? (c.vx_time_kind ?? "date") : ""} onChange={(e) => set(e.target.value ? { vx_time_kind: e.target.value as TimeKind } : { vx_time_kind: undefined, vx_time_variable: undefined })} className={inputClass} data-vx-time-kind>
                <option value="">Default</option>
                <option value="timestamp">Timestamp variable</option>
                <option value="date">Date variable</option>
              </select>
              {(c.vx_time_kind || c.vx_time_variable) && varSel(c.vx_time_variable, (v) => set({ vx_time_variable: v, vx_time_kind: c.vx_time_kind ?? "date" }), [c.vx_time_kind ?? "date", "string"], "Choose a variable…")}
            </div>
          </Field>
          <Field label="Time window" hint="The related events (badges) and the readouts of this window; objects whose own dates / timestamps all fall outside it are faded.">
            <select value={c.vx_window_start_variable || c.vx_window_end_variable || c.vx_window_kind ? (c.vx_window_kind ?? "date") : ""}
              onChange={(e) => set(e.target.value ? { vx_window_kind: e.target.value as TimeKind } : { vx_window_kind: undefined, vx_window_start_variable: undefined, vx_window_end_variable: undefined })} className={inputClass} data-vx-window-kind>
              <option value="">Default (not synchronized with variables)</option>
              <option value="timestamp">Timestamp: two variables</option>
              <option value="date">Date: two variables</option>
            </select>
          </Field>
          {(c.vx_window_kind || c.vx_window_start_variable || c.vx_window_end_variable) && (
            <>
              <Field label="Start">{varSel(c.vx_window_start_variable, (v) => set({ vx_window_start_variable: v }), [c.vx_window_kind ?? "date", "string"])}</Field>
              <Field label="End">{varSel(c.vx_window_end_variable, (v) => set({ vx_window_end_variable: v }), [c.vx_window_kind ?? "date", "string"])}</Field>
            </>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.vx_time_fade !== false} onChange={(e) => set({ vx_time_fade: e.target.checked ? undefined : false })} /> Fade objects outside the time window
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.vx_time_panel} onChange={(e) => set({ vx_time_panel: e.target.checked || undefined })} data-vx-time-panel />
            Interface: time selection panel (the user changes the window and the selected time; written to the variables)
          </label>
          <div className="font-semibold uppercase tracking-wide text-muted">Capabilities</div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.vx_open_in_vertex !== false} onChange={(e) => set({ vx_open_in_vertex: e.target.checked ? undefined : false })} /> Enable transition to the Vertex application
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.vx_export_png} onChange={(e) => set({ vx_export_png: e.target.checked || undefined })} data-vx-export /> Enable export as PNG (the whole graph as drawn)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.vx_search_around} onChange={(e) => set({ vx_search_around: e.target.checked || undefined })} data-vx-around /> Enable add object: Search Around from the selected objects
          </label>
          {c.vx_search_around && (
            <Field label="Objects added (output: an object set variable)" hint="The objects Search Arounds added in the widget (of the output object type). They are not saved to the graph; Remove added takes them off.">
              {varSel(c.vx_added_variable, (v) => set({ vx_added_variable: v }), SET_TYPES)}
            </Field>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.vx_save} onChange={(e) => set({ vx_save: e.target.checked || undefined })} data-vx-save /> Saving: Save as a new graph
          </label>
          {c.vx_save && (
            <>
              <Field label="Default name of the new graph" hint="{{variable}} is filled in. Empty: the graph's name with (copy). The user can change it before saving.">
                <input value={c.vx_save_name ?? ""} onChange={(e) => set({ vx_save_name: e.target.value || undefined })} className={inputClass} placeholder="{{name}} exploration" />
              </Field>
              <Field label="Saved graph (output: a string variable with the new graph's id)">{varSel(c.vx_saved_variable, (v) => set({ vx_saved_variable: v }), ["string"])}</Field>
              <EventsEditor events={c.vx_save_events ?? []} mod={mod} onChange={(ev) => set({ vx_save_events: ev.length ? ev : undefined })} label="On create new graph" />
            </>
          )}
          <p className="text-muted">Nodes can be moved for a closer look. Nothing is ever saved to the configured graph: added objects stay in the widget, saving makes a new graph.</p>
        </>
      )}
      {t === "machinery" && (
        <>
          <Field label="Machinery resource">
            <select value={c.mc_machinery_id ?? ""} onChange={(e) => set({ mc_machinery_id: e.target.value || undefined, mc_process_id: undefined })} className={inputClass} data-mc-resource>
              <option value="">Choose…</option>
              {(resources ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          {processes.length > 1 && (
            <Field label="Process">
              <select value={c.mc_process_id ?? ""} onChange={(e) => set({ mc_process_id: e.target.value || undefined })} className={inputClass}>
                <option value="">{processes[0].name} (the first)</option>
                {processes.map((p) => <option key={p.id} value={p.id}>{p.name}{p.parent ? " · subprocess" : ""}</option>)}
              </select>
            </Field>
          )}
          {processes.length > 1 && (
            <div className="space-y-2" data-mc-more>
              <div className="text-muted">More processes (one tab each; their own input and outputs)</div>
              {more.map((x, i) => {
                const upd = (patch: Partial<MachineryProcessCfg>) => setMore(more.map((y, j) => (j === i ? { ...y, ...patch } : y)));
                const p = processes.find((q) => q.id === x.process_id);
                return (
                  <div key={i} className="space-y-1 rounded border border-line p-2" data-mc-more-process={x.process_id}>
                    <div className="flex items-center gap-2">
                      <select value={x.process_id} onChange={(e) => upd({ process_id: e.target.value })} className={inputClass} aria-label="Process">
                        {processes.map((q) => <option key={q.id} value={q.id}>{q.name}{q.parent ? " · subprocess" : ""}</option>)}
                      </select>
                      <button type="button" aria-label="Remove the process" className="text-muted hover:text-bad" onClick={() => setMore(more.filter((_, j) => j !== i))}>
                        <Icon name="x" className="h-3 w-3" />
                      </button>
                    </div>
                    <Field label={p?.parent ? "Input (the root process' objects; empty: the input of a shown process with the same root)" : "Input object set"}>
                      {varSel(x.input_variable, (v) => upd({ input_variable: v }), SET_TYPES)}
                    </Field>
                    <Field label="Output object set (an object set variable)">{varSel(x.output_variable, (v) => upd({ output_variable: v }), SET_TYPES)}</Field>
                    <Field label="Output object set (an object set filter variable)">{varSel(x.output_filter_variable, (v) => upd({ output_filter_variable: v }), ["object_set_filter"])}</Field>
                  </div>
                );
              })}
              <select value="" onChange={(e) => e.target.value && setMore([...more, { process_id: e.target.value }])} className={inputClass} data-mc-add-process>
                <option value="">Add a process…</option>
                {processes.filter((p) => p.id !== firstProc?.id && !more.some((x) => x.process_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}{p.parent ? " · subprocess" : ""}</option>)}
              </select>
            </div>
          )}
          <div className="font-semibold uppercase tracking-wide text-muted">Inputs</div>
          <Field label="Input object set (the root process' objects)" hint="Empty: every object of the process. A subprocess covers the objects linked to them.">
            {varSel(c.mc_input_variable, (v) => set({ mc_input_variable: v }), SET_TYPES)}
          </Field>
          <div className="font-semibold uppercase tracking-wide text-muted">Metric views</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {MACHINERY_VIEWS.map(([k, l]) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" checked={views.includes(k)}
                  onChange={(e) => {
                    const next = MACHINERY_VIEWS.map(([x]) => x).filter((x) => (x === k ? e.target.checked : views.includes(x)));
                    set({ mc_views: next.length && next.length < MACHINERY_VIEWS.length ? next : undefined });
                  }} />
                {l}
              </label>
            ))}
          </div>
          <div className="text-muted">Custom views: a node metric with number formatting and conditional coloring, an optional edge metric</div>
          {customViews.map((v, i) => (
            <McCustomViewEditor key={v.id} view={v} typeIds={shownTypes} onChange={(nv) => setCustom(customViews.map((x, j) => (j === i ? nv : x)))} onRemove={() => setCustom(customViews.filter((_, j) => j !== i))} />
          ))}
          <button type="button" className={barButton} data-mc-add-view
            onClick={() => setCustom([...customViews, { id: Math.random().toString(36).slice(2, 8), name: `Custom view ${customViews.length + 1}`, node: { metric: "current_count" }, sankey: true }])}>
            <Icon name="plus" className="h-3 w-3" /> Add a custom view
          </button>
          <Field label="View shown first">
            <select value={c.mc_view ?? ""} onChange={(e) => set({ mc_view: (e.target.value || undefined) as WidgetConfig["mc_view"] })} className={inputClass}>
              <option value="">The first one</option>
              {MACHINERY_VIEWS.filter(([k]) => views.includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              {customViews.map((v) => <option key={v.id} value={`custom:${v.id}`}>{v.name}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.mc_sankey !== false} onChange={(e) => set({ mc_sankey: e.target.checked ? undefined : false })} /> Sankey edges (thickness by how many objects went through)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.mc_deviations} onChange={(e) => set({ mc_deviations: e.target.checked || undefined })} /> Include deviating objects in the metrics
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.mc_path_explorer !== false} onChange={(e) => set({ mc_path_explorer: e.target.checked ? undefined : false })} data-mc-path-explorer-option />
            Path explorer (the paths the objects took; selected paths become the output while it is open)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.mc_duration_distribution !== false} onChange={(e) => set({ mc_duration_distribution: e.target.checked ? undefined : false })} data-mc-durations-option />
            Duration distribution (how long the selection took, with percentiles; selected buckets narrow the output)
          </label>
          <div className="text-muted">Pinned metrics (shown on every node beside the active view; at most {MC_MAX_PINS}; viewers can change their own)</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1" data-mc-pinned-option>
            {[...MACHINERY_VIEWS.filter(([k]) => views.includes(k)), ...customViews.map((v): [string, string] => [`custom:${v.id}`, v.name])].map(([k, l]) => {
              const pinned = c.mc_pinned ?? [];
              return (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={pinned.includes(k)} disabled={!pinned.includes(k) && pinned.length >= MC_MAX_PINS}
                    onChange={(e) => {
                      const next = e.target.checked ? [...pinned, k] : pinned.filter((x) => x !== k);
                      set({ mc_pinned: next.length ? next : undefined });
                    }} data-mc-pin-option={k} />
                  {l}
                </label>
              );
            })}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.mc_transition_nodes} onChange={(e) => set({ mc_transition_nodes: e.target.checked || undefined })} data-mc-actions-option />
            Transition nodes on by default (the process&apos; actions drawn as nodes between their input and output states)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.mc_subprocesses} onChange={(e) => set({ mc_subprocesses: e.target.checked || undefined })} data-mc-subs-option />
            Subprocesses on by default (each state drawn with its direct subprocesses&apos; graphs inside)
          </label>
          <div className="font-semibold uppercase tracking-wide text-muted">Outputs</div>
          <Field label="Output object set (an object set variable)" hint="The objects in the selected states / transitions; every object of the process when nothing is selected.">
            {varSel(c.mc_output_variable, (v) => set({ mc_output_variable: v }), SET_TYPES)}
          </Field>
          <Field label="Output object set (an object set filter variable)" hint="Data widgets apply it under Object set filter variables applied.">
            {varSel(c.mc_output_filter_variable, (v) => set({ mc_output_filter_variable: v }), ["object_set_filter"])}
          </Field>
          <Field label="Node selection">
            <select value={c.mc_state_mode ?? "current"} onChange={(e) => set({ mc_state_mode: e.target.value === "ever" ? "ever" : undefined })} className={inputClass}>
              <option value="current">Processes currently in selected states</option>
              <option value="ever">Processes ever in selected states</option>
            </select>
          </Field>
          <Field label="Edge selection">
            <select value={c.mc_transition_mode ?? "ever"} onChange={(e) => set({ mc_transition_mode: e.target.value === "last" ? "last" : undefined })} className={inputClass}>
              <option value="ever">Objects that ever went through the transition</option>
              <option value="last">Objects whose last transition it is</option>
            </select>
          </Field>
          <EventsEditor events={c.mc_events ?? []} mod={mod} onChange={(ev) => set({ mc_events: ev.length ? ev : undefined })} label="On selection change" />
        </>
      )}
    </div>
  );
}

const MC_NUMERIC = new Set(["integer", "long", "short", "byte", "double", "float", "decimal"]);
const MC_OPS: MachineryColorRule["op"][] = [">", ">=", "<", "<=", "=", "!=", "between", "empty"];
const MC_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#38bdf8", "#a855f7"];

/** One custom metric view of the Machinery widget's configuration: its name, the node metric (a metric of the process
 * or an aggregate of a property of the shown processes' object types) with formatting and coloring rules, the optional
 * edge metric and Sankey edges. */
function McCustomViewEditor({ view, typeIds, onChange, onRemove }: { view: MachineryCustomView; typeIds: string[]; onChange: (v: MachineryCustomView) => void; onRemove: () => void }) {
  const [types, setTypes] = useState<Record<string, ObjectType>>({});
  const typesKey = typeIds.join(",");
  useEffect(() => {
    let stale = false;
    for (const id of typesKey.split(",").filter(Boolean))
      ontology.objectType(id).then((t) => !stale && setTypes((p) => ({ ...p, [id]: t })), () => undefined);
    return () => {
      stale = true;
    };
  }, [typesKey]);
  // the properties of the shown processes' object types (a process whose type lacks one shows no value for it)
  const props = new Map<string, { label: string; numeric: boolean }>();
  for (const id of typeIds)
    for (const p of types[id]?.properties ?? [])
      if (!props.has(p.api_name) && p.type !== "timeseries") props.set(p.api_name, { label: `${p.display_name || p.api_name}${typeIds.length > 1 ? ` · ${types[id].display_name}` : ""}`, numeric: MC_NUMERIC.has(p.type) && !p.array });
  const metricFields = (m: MachineryMetric, catalog: [string, string][], change: (m: MachineryMetric) => void, what: string) => (
    <>
      <select value={m.metric} onChange={(e) => change({ metric: e.target.value, ...(e.target.value === "aggregate" ? { fn: "sum", scope: "current" } : {}) })} className={inputClass} aria-label={`${what} metric`} data-mc-metric={what}>
        {catalog.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {m.metric === "aggregate" && (
        <div className="flex gap-1">
          <select value={m.fn ?? "sum"} onChange={(e) => change({ ...m, fn: e.target.value as MachineryMetric["fn"] })} className={inputClass} aria-label={`${what} function`} data-mc-fn={what}>
            {MC_AGG_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={m.property ?? ""} onChange={(e) => change({ ...m, property: e.target.value || undefined })} className={inputClass} aria-label={`${what} property`} data-mc-property={what}>
            <option value="">Property…</option>
            {[...props].filter(([, p]) => p.numeric || m.fn === "count" || m.fn === "distinct").map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          </select>
          <select value={m.scope ?? "current"} onChange={(e) => change({ ...m, scope: e.target.value === "ever" ? "ever" : "current" })} className={inputClass} aria-label={`${what} objects`}>
            <option value="current">{what === "edge" ? "objects whose last transition it is" : "objects currently in it"}</option>
            <option value="ever">{what === "edge" ? "objects ever through it" : "objects ever in it"}</option>
          </select>
        </div>
      )}
    </>
  );
  const formatFields = (f: MachineryFormat | undefined, change: (f: MachineryFormat | undefined) => void, what: string) => {
    const set = (patch: Partial<MachineryFormat>) => {
      const next = { ...(f ?? {}), ...patch };
      for (const k of Object.keys(next) as (keyof MachineryFormat)[]) if (next[k] === undefined || next[k] === "") delete next[k];
      change(Object.keys(next).length ? next : undefined);
    };
    return (
      <div className="flex gap-1">
        <select value={f?.style ?? ""} onChange={(e) => set({ style: (e.target.value || undefined) as MachineryFormat["style"] })} className={inputClass} aria-label={`${what} format`} data-mc-format={what}>
          <option value="">Format: automatic</option>
          <option value="number">Number</option>
          <option value="compact">Compact (1.2K)</option>
          <option value="percent">Percent (of 0–1)</option>
          <option value="duration">Duration (of seconds)</option>
        </select>
        <input type="number" min={0} max={6} value={f?.decimals ?? ""} placeholder="Decimals" onChange={(e) => set({ decimals: e.target.value === "" ? undefined : Math.max(0, Math.min(6, Number(e.target.value))) })} className={`${inputClass} w-20`} aria-label={`${what} decimals`} />
        <input value={f?.prefix ?? ""} placeholder="Prefix" onChange={(e) => set({ prefix: e.target.value || undefined })} className={`${inputClass} w-16`} aria-label={`${what} prefix`} />
        <input value={f?.suffix ?? ""} placeholder="Suffix" onChange={(e) => set({ suffix: e.target.value || undefined })} className={`${inputClass} w-16`} aria-label={`${what} suffix`} />
      </div>
    );
  };
  // coloring rules (the first rule met), on the node metric (colors) or the edge metric (edge_colors)
  const ruleList = (rules: MachineryColorRule[], setRules: (next: MachineryColorRule[]) => void, what: "node" | "edge") => (
    <div className="space-y-1" data-mc-rules={what}>
      {rules.map((r, i) => {
        const upd = (patch: Partial<MachineryColorRule>) => setRules(rules.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="flex items-center gap-1" data-mc-rule={what === "node" ? i : undefined} data-mc-edge-rule={what === "edge" ? i : undefined}>
            <select value={r.op} onChange={(e) => upd({ op: e.target.value as MachineryColorRule["op"] })} className={`${inputClass} w-24`} aria-label="Condition">
              {MC_OPS.map((o) => <option key={o} value={o}>{o === "empty" ? "no value" : o}</option>)}
            </select>
            {r.op !== "empty" && <input type="number" value={r.value ?? ""} onChange={(e) => upd({ value: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${inputClass} w-20`} aria-label="Value" />}
            {r.op === "between" && <input type="number" value={r.value2 ?? ""} onChange={(e) => upd({ value2: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${inputClass} w-20`} aria-label="And" />}
            <input type="color" value={r.color} onChange={(e) => upd({ color: e.target.value })} className="h-6 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent" aria-label="Color" />
            <button type="button" aria-label="Remove the rule" className="text-muted hover:text-bad" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button type="button" className={barButton} onClick={() => setRules([...rules, { op: ">", value: 0, color: MC_COLORS[rules.length % MC_COLORS.length] }])} data-mc-add-rule={what === "node" ? "" : undefined} data-mc-add-edge-rule={what === "edge" ? "" : undefined}>
        <Icon name="plus" className="h-3 w-3" /> Add a coloring rule
      </button>
    </div>
  );
  return (
    <div className="space-y-1.5 rounded border border-line p-2" data-mc-custom-view={view.id}>
      <div className="flex items-center gap-2">
        <input value={view.name} onChange={(e) => onChange({ ...view, name: e.target.value })} className={inputClass} aria-label="View name" data-mc-view-name />
        <button type="button" aria-label="Remove the view" className="text-muted hover:text-bad" onClick={onRemove}>
          <Icon name="x" className="h-3 w-3" />
        </button>
      </div>
      <div className="text-muted">Node metric</div>
      {metricFields(view.node, MC_STATE_METRICS, (node) => onChange({ ...view, node }), "node")}
      {formatFields(view.format, (format) => onChange({ ...view, format }), "node")}
      <div className="text-muted">Conditional coloring (the first rule met; durations in hours, shares in percent)</div>
      {ruleList(view.colors ?? [], (next) => onChange({ ...view, colors: next.length ? next : undefined }), "node")}
      <div className="text-muted">Edge metric</div>
      <select value={view.edge ? "on" : ""} onChange={(e) => onChange({ ...view, edge: e.target.value ? { metric: "count" } : undefined, edge_format: e.target.value ? view.edge_format : undefined, edge_colors: e.target.value ? view.edge_colors : undefined })} className={inputClass} aria-label="Edge metric shown" data-mc-edge-toggle>
        <option value="">None</option>
        <option value="on">A metric on each transition</option>
      </select>
      {view.edge && metricFields(view.edge, MC_EDGE_METRICS, (edge) => onChange({ ...view, edge }), "edge")}
      {view.edge && formatFields(view.edge_format, (edge_format) => onChange({ ...view, edge_format }), "edge")}
      {view.edge && <div className="text-muted">Edge coloring (the edge metric; the first rule met; durations in hours, shares in percent)</div>}
      {view.edge && ruleList(view.edge_colors ?? [], (next) => onChange({ ...view, edge_colors: next.length ? next : undefined }), "edge")}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!view.sankey} onChange={(e) => onChange({ ...view, sankey: e.target.checked || undefined })} /> Sankey edges (thickness by how many objects went through)
      </label>
    </div>
  );
}
