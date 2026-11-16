"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { FlowCanvas, flowLayout, LAYOUTS, layoutOf, nodeColor, PALETTE, type Pos } from "@/components/vertex/FlowCanvas";
import { PairControl } from "@/components/map/PairControl";
import { usePairing, type ObjectRef } from "@/lib/appPairing";
import type { EdgeStyle } from "@/lib/vertex";
import { applyHistFilters, EdgeDetails, FlowPanel, HistogramPanel, SavedSelections, SavedStyles, SeriesPanel, type HistFilter } from "@/components/vertex/FlowPanels";
import { AppHeader, ErrorBox, ObjectPicker, ValueCell } from "@/components/ontology/parts";
import { DrivePicker } from "@/components/DrivePicker";
import { driveContentUrl } from "@/lib/api";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";
import { copyForNotepad } from "@/lib/notepadClip";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { ActionForm } from "@/components/ontology/ActionForm";
import { FILTER_OPS, om, type Filter, type LinkType } from "@/lib/ontologyModel";
import { scenarios, type Scenario } from "@/lib/scenarios";
import { emptyGraph, vertex, type Annotation, type Readout, type AroundOption, type DerivedSpec, type FunctionEdge, type GraphFunction, type Graph, type GraphRow, type GroupedEdge, type Layer, type Layout, type NodeRef, type Step, type VEdge, type VEvent, type VNode } from "@/lib/vertex";

const INTENT: Record<string, string> = { primary: "#60a5fa", success: "#34d399", warning: "#f59e0b", danger: "#ef4444" };
const key = (n: NodeRef) => `${n.object_type_id}|${n.primary_key}`;

export default function VertexPage() {
  return (
    <Suspense>
      <VertexApp />
    </Suspense>
  );
}

/**
 * Vertex: system graphs of Ontology objects — add objects, Search Around (one or several filtered steps), layouts,
 * layer styling, the selection panel, related events on a timeline with a time selection, viewing the graph inside
 * an Ontology scenario, and graph templates.
 */
function VertexApp() {
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [rows, setRows] = useState<GraphRow[]>([]);
  const [scList, setScList] = useState<Scenario[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [g, setG] = useState<Graph>(emptyGraph);
  const [data, setData] = useState<{ nodes: VNode[]; edges: VEdge[]; grouped_edges: GroupedEdge[]; events: VEvent[]; scenario_changed: string[] }>({ nodes: [], edges: [], grouped_edges: [], events: [], scenario_changed: [] });
  const [links, setLinks] = useState<LinkType[]>([]);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [hist, setHist] = useState<HistFilter[]>([]);
  const [showSeries, setShowSeries] = useState(true);
  // time series readouts by node id (layers with a readout)
  const [readings, setReadings] = useState<Record<string, Readout>>({});
  // the media layer image's height at its width (from the loaded image)
  const [mediaH, setMediaH] = useState<number | null>(null);
  // undo / redo: snapshots of the graph and the positions
  const [past, setPast] = useState<{ g: Graph; pos: Pos }[]>([]);
  const [future, setFuture] = useState<{ g: Graph; pos: Pos }[]>([]);
  const [pos, setPos] = useState<Pos>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<"selection" | "histogram" | "around" | "layers" | "flow" | "whatif" | "events" | "template">("selection");
  const [options, setOptions] = useState<AroundOption[]>([]);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState<{ typeId: string; pk: string }>({ typeId: "", pk: "" });

  useEffect(() => {
    om.linkTypes().then(setLinks, () => setLinks([]));
    Promise.all([ontology.objectTypes(), vertex.graphs(), scenarios.list().catch(() => [] as Scenario[])]).then(
      ([t, r, s]) => {
        setTypes(t);
        setRows(r);
        setScList(s);
        setAdding({ typeId: t[0]?.id ?? "", pk: "" });
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const [fitRun, setFitRun] = useState(0);
  const resolve = useCallback(
    async (graph: Graph, relayout: boolean) => {
      try {
        const d = await vertex.resolve(graph.nodes, graph.scenario_id, graph.time, graph.edge_groups, graph.function_edges);
        // derived properties: function values merged into the nodes' properties
        const specs = Object.fromEntries(Object.entries(graph.layers).filter(([, l]) => l.derived?.length).map(([tid, l]) => [tid, l.derived!]));
        if (Object.keys(specs).length) {
          const dv = await vertex.derived(graph.nodes, specs, graph.scenario_id).catch(() => null);
          if (dv) d.nodes = d.nodes.map((n) => (dv.values[n.id] ? { ...n, properties: { ...n.properties, ...dv.values[n.id] } } : n));
        }
        setData({ ...d, grouped_edges: d.grouped_edges ?? [] });
        const ro = Object.fromEntries(Object.entries(graph.layers).filter(([, l]) => l.readout?.property).map(([tid, l]) => [tid, l.readout!]));
        if (Object.keys(ro).length) vertex.readouts(graph.nodes, ro).then(setReadings, () => setReadings({}));
        else setReadings({});
        const lay = (layout: Layout) => (layout === "flow" ? flowLayout(d.nodes, [...d.edges, ...(d.grouped_edges ?? [])], graph.layers) : layoutOf(d.nodes, d.edges, layout, [...selected][0]));
        const saved: Pos = {};
        for (const n of graph.nodes) if (n.x !== undefined && n.y !== undefined) saved[key(n)] = { x: n.x, y: n.y };
        if (relayout) setFitRun((r) => r + 1);
        setPos((cur) => {
          if (relayout || !Object.keys(saved).length) {
            const fresh = lay(graph.layout);
            return relayout ? fresh : { ...fresh, ...cur, ...saved };
          }
          const missing = d.nodes.filter((x) => !saved[x.id] && !cur[x.id]);
          const fresh = missing.length ? lay(graph.layout === "flow" ? "flow" : "auto") : {};
          return { ...fresh, ...cur, ...saved };
        });
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [selected],
  );

  const update = (c: Partial<Graph>, relayout = false) => {
    const next = { ...g, ...c };
    setPast((h) => [...h.slice(-49), { g, pos }]);
    setFuture([]);
    setG(next);
    setDirty(true);
    const layerKey = (ls: Graph["layers"]) => JSON.stringify(Object.values(ls).map((l) => [l.readout, l.derived]));
    if (c.nodes || c.scenario_id !== undefined || c.time !== undefined || c.edge_groups || c.function_edges || relayout || (c.layers && layerKey(c.layers) !== layerKey(g.layers))) void resolve(next, relayout);
  };
  const travel = (back: boolean) => {
    const from = back ? past : future;
    const snap = from[from.length - 1];
    if (!snap) return;
    (back ? setFuture : setPast)((h) => [...h, { g, pos }]);
    (back ? setPast : setFuture)(from.slice(0, -1));
    setG(snap.g);
    setPos(snap.pos);
    setDirty(true);
    void resolve(snap.g, false);
  };
  const [dropping, setDropping] = useState(false);
  // Search Around chains added to the graph in this session: what "Save as template" replays from its parameter
  const [recorded, setRecorded] = useState<RecordedAround[]>([]);
  const addNodes = (refs: NodeRef[]) => {
    const have = new Set(g.nodes.map(key));
    const add = refs.filter((r) => !have.has(key(r)));
    if (add.length) update({ nodes: [...g.nodes, ...add.map((r) => ({ object_type_id: r.object_type_id, primary_key: String(r.primary_key) }))] });
  };
  const selRefs: NodeRef[] = data.nodes.filter((n) => selected.has(n.id)).map((n) => ({ object_type_id: n.object_type_id, primary_key: n.primary_key }));
  useEffect(() => {
    if (!selRefs.length) return;
    const t = setTimeout(() => vertex.options(selRefs, g.scenario_id).then(setOptions, () => setOptions([])), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, g.scenario_id]);

  // App Pairing (Vertex plays Graph's role): selected nodes sync with paired Workshop modules and windows; paired /
  // embedding windows send commands (select, zoom to, add objects, clear). Objects not on the graph are added when
  // "Add selected objects" is on (the add command always adds); otherwise a selection of objects the graph does not
  // show is ignored quietly.
  const [addIncoming, setAddIncoming] = useState(false);
  const [focus, setFocus] = useState<{ ids: string[]; token: number } | null>(null);
  const refOfId = (id: string): ObjectRef => {
    const n = data.nodes.find((x) => x.id === id);
    if (n) return { object_type_id: n.object_type_id, primary_key: n.primary_key };
    const i = id.indexOf("|");
    return { object_type_id: id.slice(0, i), primary_key: id.slice(i + 1) };
  };
  /** objects asked for by a paired window: the ones on the graph (adding the others when asked), as node ids */
  const bring = (refs: ObjectRef[], add: boolean): string[] => {
    const have = new Set(g.nodes.map(key));
    if (add) addNodes(refs);
    return refs.filter((r) => add || have.has(key(r))).map(key);
  };
  const zoomTo = (ids: string[]) => {
    if (ids.length) setFocus((f) => ({ ids, token: (f?.token ?? 0) + 1 }));
  };
  const pairing = usePairing("vertex", {
    onSelection: (typeId, pks) => {
      const ids = bring(pks.map((pk) => ({ object_type_id: typeId, primary_key: pk })), addIncoming);
      if (pks.length && !ids.length) return;
      setSelected((cur) => new Set([...[...cur].filter((id) => refOfId(id).object_type_id !== typeId), ...ids]));
      setSelectedEdge(null);
      zoomTo(ids);
    },
    onCommand: (cmd) => {
      if (cmd.name === "clear") return void setSelected(new Set());
      if (!cmd.objects.length) return false;
      const ids = bring(cmd.objects, cmd.name === "add" || addIncoming);
      if (cmd.name === "select") {
        setSelected(new Set(ids));
        setSelectedEdge(null);
      }
      zoomTo(ids);
      return ids.length > 0;
    },
  });
  /** a selection made here (canvas, histogram, events, saved selections) goes to the paired windows */
  const selectLocal = (s: Set<string>) => {
    setSelected(s);
    pairing.publish([...s].map(refOfId));
  };

  const open = async (id: string) => {
    try {
      const graph = await vertex.graph(id);
      setG(graph);
      setDirty(false);
      setSelected(new Set());
      setPos({});
      await resolve(graph, !graph.nodes.some((n) => n.x !== undefined));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // ?graph=<id> opens a saved graph (links from Notepad widgets)
  const linked = useRef(false);
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const id = qs.get("graph");
    if (id && !linked.current) {
      linked.current = true;
      void open(id);
    }
    // ?template=<id>&objects=<pk,pk>: generate the template's graph from these objects (links from a map's object)
    const tpl = qs.get("template");
    if (tpl && !linked.current) {
      linked.current = true;
      void (async () => {
        try {
          const t = await vertex.graph(tpl);
          const param = t.template?.parameters[0];
          if (!param) throw new Error(`${t.name} is not a graph template`);
          const graph = await vertex.run(tpl, { [param.id]: list(qs.get("objects") ?? "") });
          setG(graph);
          setDirty(true);
          setSelected(new Set());
          setPos({});
          await resolve(graph, true);
        } catch (e) {
          setError((e as Error).message);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = async (asTemplate = false) => {
    const nodes = g.nodes.map((n) => ({ ...n, x: Math.round(pos[key(n)]?.x ?? 0), y: Math.round(pos[key(n)]?.y ?? 0) }));
    let body: Graph = { ...g, nodes };
    if (asTemplate) {
      const first = data.nodes.find((x) => selected.has(x.id)) ?? data.nodes[0];
      if (!first) return alertDialog("Add objects first: the template's parameter is the selected object's type.");
      const name = await promptDialog("Template name", `${g.name} template`, { title: "Save as template" });
      if (!name) return;
      const known = g.template?.parameters[0]?.search_arounds ?? [];
      const steps = [...known, ...recorded.filter((r) => r.object_type_id === first.object_type_id).map((r) => ({ steps: r.steps }))];
      body = { ...body, id: undefined, name, nodes: [], template: { parameters: [{ id: "objects", name: first.object_type, object_type_id: first.object_type_id, search_arounds: steps }] } };
    }
    try {
      const out = body.id ? await vertex.save(body.id, body) : await vertex.create(body);
      if (!asTemplate) setG(out);
      setDirty(false);
      setRows(await vertex.graphs());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !types) return <ApiError message={error} />;
  if (!types) return <Loading />;
  const typeIndex = Object.fromEntries(types.map((t, i) => [t.id, i]));
  const visible = applyHistFilters(data.nodes.filter((n) => !g.layers[n.object_type_id]?.hidden), hist);
  const visibleIds = new Set(visible.map((n) => n.id));
  const edges = data.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target) && !g.edge_styles[e.link_type_id]?.hidden);
  const grouped = data.grouped_edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
  const edgeSel = grouped.find((e) => e.id === selectedEdge) ?? null;
  const changed = new Set(data.scenario_changed);
  const sel = data.nodes.filter((n) => selected.has(n.id));
  // objects pinned onto the media layer by their pixel-coordinate properties
  const media = g.media;
  const pinnedPos: Pos = media
    ? {
        ...pos,
        ...Object.fromEntries(
          data.nodes.flatMap((n) => {
            const l = g.layers[n.object_type_id];
            const x = l?.media_x ? Number(n.properties[l.media_x]) : NaN;
            const y = l?.media_y ? Number(n.properties[l.media_y]) : NaN;
            return Number.isFinite(x) && Number.isFinite(y) ? [[n.id, { x: media.x + x, y: media.y + y }]] : [];
          }),
        ),
      }
    : pos;
  const eventsByNode = new Map<string, VEvent[]>();
  for (const ev of data.events) eventsByNode.set(ev.node, [...(eventsByNode.get(ev.node) ?? []), ev]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Vertex" icon="graph" href="/vertex" crumbs={[{ label: g.name + (dirty ? " •" : "") }]}>
        <PairControl pairing={pairing} addIncoming={addIncoming} setAddIncoming={setAddIncoming} what="graph" />
        <button type="button" onClick={() => (setG(emptyGraph()), setData({ nodes: [], edges: [], grouped_edges: [], events: [], scenario_changed: [] }), setPos({}), setSelected(new Set()), setRecorded([]), setDirty(false))} className={buttonClass.secondary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New graph
        </button>
        <button
          type="button"
          onClick={async () => {
            const name = await promptDialog("Graph name", g.name, { title: "Rename graph" });
            if (name) update({ name });
          }}
          className={buttonClass.secondary}
        >
          <Icon name="pencil" className="h-3.5 w-3.5" /> Rename
        </button>
        <button type="button" onClick={() => save(true)} className={buttonClass.secondary}>
          <Icon name="layers" className="h-3.5 w-3.5" /> Save as template
        </button>
        <button type="button" onClick={() => save(false)} disabled={g.read_only && !!g.id} className={buttonClass.primary}>
          <Icon name="save" className="h-3.5 w-3.5" /> Save
        </button>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 space-y-4 overflow-y-auto border-r border-line bg-panel p-3 text-xs">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Add objects</div>
            <select value={adding.typeId} onChange={(e) => setAdding({ typeId: e.target.value, pk: "" })} className={`${inputClass} mb-1`} aria-label="Object type">
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
            {adding.typeId && <ObjectList key={adding.typeId} objectTypeId={adding.typeId} onGraph={new Set(g.nodes.map(key))} onAdd={(pk) => addNodes([{ object_type_id: adding.typeId, primary_key: pk }])} />}
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Scenario</div>
            <select value={g.scenario_id ?? ""} onChange={(e) => update({ scenario_id: e.target.value || null })} className={inputClass} aria-label="Scenario">
              <option value="">Main Nexus</option>
              {scList
                .filter((s) => !s.merged)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            {g.scenario_id && <div className="mt-1 text-muted">Nodes show the scenario&apos;s values; objects it changed have a dashed ring.</div>}
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Semantic graph</div>
            <Link href="/vertex/grid-intelligence-nexus" className="mb-2 flex w-full items-center gap-2 rounded bg-ocean/15 px-2 py-1.5 text-left text-white ring-1 ring-ocean/30">
              <Icon name="sparkle" className="h-3.5 w-3.5 text-ocean" /> <span className="min-w-0 flex-1 truncate">Grid Intelligence Nexus</span>
            </Link>
            <Link href="/vertex/jkn-intelligence-nexus" className="mb-2 flex w-full items-center gap-2 rounded bg-ocean/15 px-2 py-1.5 text-left text-white ring-1 ring-ocean/30">
              <Icon name="sparkle" className="h-3.5 w-3.5 text-ocean" /> <span className="min-w-0 flex-1 truncate">JKN Intelligence Nexus</span>
            </Link>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Graphs</div>
            {rows
              .filter((r) => !r.template)
              .map((r) => (
                <button key={r.id} type="button" onClick={() => open(r.id)} className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${g.id === r.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
                  <Icon name="graph" className="h-3.5 w-3.5 text-ocean" /> <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className="text-muted">{r.nodes}</span>
                </button>
              ))}
            <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Templates</div>
            {rows
              .filter((r) => r.template)
              .map((r) => (
                <button key={r.id} type="button" onClick={() => open(r.id).then(() => setPanel("template"))} className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${g.id === r.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
                  <Icon name="layers" className="h-3.5 w-3.5 text-sand" /> <span className="min-w-0 flex-1 truncate">{r.name}</span>
                </button>
              ))}
          </div>
        </aside>

        <main
          className={`relative flex min-w-0 flex-1 flex-col bg-ink ${dropping ? "ring-2 ring-inset ring-ocean/60" : ""}`}
          // objects dragged in: from the list on the left, or Nexus Manager's Objects table in another window
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(OBJECT_DRAG) && !e.dataTransfer.types.includes("text/plain")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropping(true);
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
          onDrop={(e) => {
            setDropping(false);
            const refs = droppedObjects(e.dataTransfer);
            if (!refs.length) return;
            e.preventDefault();
            addNodes(refs);
          }}
          data-vertex-drop
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 text-xs">
            <select value={g.layout} onChange={(e) => update({ layout: e.target.value as Layout }, true)} className={fieldClass} aria-label="Layout">
              {LAYOUTS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => update({}, true)} className={buttonClass.ghost}>
              <Icon name="refresh" className="h-3.5 w-3.5" /> Re-layout
            </button>
            {g.id && (
              <button
                type="button"
                onClick={() => copyForNotepad("vertex_graph", { graph_id: g.id }, `${g.name} (Vertex)`) && void alertDialog(dirty ? "Copied. Save the graph first: Notepad shows the saved version." : "Copied: in a Notepad document, Insert → Paste copied widget.")}
                className={buttonClass.ghost}
                title="Copy for Notepad"
              >
                <Icon name="copy" className="h-3.5 w-3.5" /> For Notepad
              </button>
            )}
            <button type="button" disabled={!past.length} onClick={() => travel(true)} className={buttonClass.ghost} title="Undo">↶</button>
            <button type="button" disabled={!future.length} onClick={() => travel(false)} className={buttonClass.ghost} title="Redo">↷</button>
            {!showSeries && Object.values(g.series ?? {}).some((x) => x.length) && (
              <button type="button" onClick={() => setShowSeries(true)} className={buttonClass.ghost}><Icon name="wave" className="h-3.5 w-3.5" /> Series</button>
            )}
            {sel.length > 0 && (
              <>
                <select
                  value=""
                  onChange={async (e) => {
                    const o = options.find((x) => `${x.link_type_id}|${x.direction}|${x.from_type_id}|${x.via?.link_type_id ?? ""}` === e.target.value);
                    if (!o) return;
                    const from = selRefs.filter((r) => r.object_type_id === o.from_type_id);
                    try {
                      if (o.via) {
                        // through a link-merged intermediary: add the far objects; the intermediaries become edges
                        const via = o.via;
                        const res = await vertex.searchAround(from, [{ link_type_id: o.link_type_id, direction: o.direction }, { link_type_id: via.link_type_id, direction: via.direction }], g.scenario_id);
                        const far = res.layers[res.layers.length - 1];
                        const have = new Set(g.nodes.map(key));
                        const add = far.primary_keys.map((pk) => ({ object_type_id: far.object_type_id, primary_key: pk })).filter((r) => !have.has(key(r)));
                        const groups = g.edge_groups ?? [];
                        const exists = groups.some((x) => x.object_type_id === via.object_type_id && x.links.includes(o.link_type_id) && x.links.includes(via.link_type_id));
                        update({
                          nodes: [...g.nodes, ...add],
                          ...(exists ? {} : { edge_groups: [...groups, { id: `merge-${via.object_type_id}-${via.link_type_id}`, name: via.object_type, object_type_id: via.object_type_id, links: [o.link_type_id, via.link_type_id] as [string, string], label: "count" }] }),
                        });
                        return;
                      }
                      const res = await vertex.searchAround(from, [{ link_type_id: o.link_type_id, direction: o.direction }], g.scenario_id);
                      addNodes(res.nodes);
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                  className={fieldClass}
                  aria-label="Search Around"
                >
                  <option value="">Search Around…</option>
                  {options.map((o) => (
                    <option key={`${o.link_type_id}|${o.direction}|${o.from_type_id}|${o.via?.link_type_id ?? ""}`} value={`${o.link_type_id}|${o.direction}|${o.from_type_id}|${o.via?.link_type_id ?? ""}`} disabled={!o.count}>
                      {o.label} ({o.object_type}) · {o.count}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => update({ nodes: g.nodes.filter((n) => !selected.has(key(n))) })} className={buttonClass.ghost}>
                  <Icon name="trash" className="h-3.5 w-3.5" /> Remove {sel.length}
                </button>
              </>
            )}
            <span className="ml-auto text-muted">
              {visible.length} objects · {edges.length + grouped.length} edges · {data.events.length} events
            </span>
          </div>
          <ErrorBox message={error} />
          {hist.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-3 py-1 text-[11px]">
              {hist.map((f, i) => (
                <span key={i} className="flex items-center gap-1 rounded bg-ocean/15 px-2 py-0.5 text-ocean">
                  {f.mode === "to" ? "Only" : "Without"} {f.property}: {f.values.join(", ")}
                  <button type="button" onClick={() => setHist(hist.filter((_, j) => j !== i))} aria-label="Remove filter"><Icon name="x" className="h-3 w-3" /></button>
                </span>
              ))}
              <button type="button" onClick={() => setHist([])} className="text-muted hover:text-white">Clear filters</button>
            </div>
          )}
          <FlowCanvas
            fitToken={fitRun}
            grouped={grouped}
            groupFormat={(ge) => (g.edge_groups ?? []).find((x) => x.id === ge.group_id)?.format}
            onDragEnd={() => setPast((h) => [...h.slice(-49), { g, pos }])}
            selectedEdge={selectedEdge}
            setSelectedEdge={(id) => {
              setSelectedEdge(id);
              if (id) setPanel("selection");
            }}
            icon={(n) => {
              const l = g.layers[n.object_type_id];
              if (l?.node_style === "circle") return null;
              return ((l?.icon ?? types.find((t) => t.id === n.object_type_id)?.icon ?? "cube") as IconName) || "cube";
            }}
            line={g.line_type ?? (g.layout === "flow" ? "curved" : "straight")}
            nodes={visible}
            edges={edges}
            pos={pinnedPos}
            setPos={(p) => {
              setPos(p);
              setDirty(true);
            }}
            selected={selected}
            setSelected={selectLocal}
            focus={focus}
            color={(n) => readoutColor(g.layers[n.object_type_id], readings[n.id]) ?? nodeColor(n, g.layers[n.object_type_id], PALETTE[(typeIndex[n.object_type_id] ?? 0) % PALETTE.length])}
            label={(n) => {
              const lp = g.layers[n.object_type_id]?.label_property;
              const base = lp ? String(n.properties[lp] ?? n.title) : n.title;
              const r = readings[n.id];
              return r && r.value !== undefined && r.value !== null ? `${base} · ${Number(r.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${r.unit ? ` ${r.unit}` : ""}` : base;
            }}
            size={(n) => {
              const sp = g.layers[n.object_type_id]?.size_property;
              if (!sp) return 14;
              const vals = data.nodes.filter((x) => x.object_type_id === n.object_type_id).map((x) => Number(x.properties[sp]) || 0);
              const max = Math.max(1, ...vals);
              return 9 + 14 * Math.sqrt((Number(n.properties[sp]) || 0) / max);
            }}
            changed={changed}
            events={eventsByNode}
            edgeStyle={(e) => g.edge_styles[e.link_type_id]}
            underlay={<MediaUnderlay g={g} onSize={setMediaH} />}
            underlayBounds={g.media ? { x: g.media.x, y: g.media.y, w: g.media.width, h: mediaH ?? g.media.width * 0.6 } : null}
          />
          {showSeries && Object.values(g.series ?? {}).some((x) => x.length) && <SeriesPanel g={g} nodes={sel} onClose={() => setShowSeries(false)} />}
          {!visible.length && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted">
              <Icon name="graph" className="h-8 w-8 text-ocean" />
              Add objects, or open a graph or a template on the left.
            </div>
          )}
        </main>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel">
          <div className="flex border-b border-line">
            {(["selection", "histogram", "around", "layers", "flow", "whatif", "events", "template"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPanel(p)} className={`flex-1 px-0.5 py-2.5 text-[10px] capitalize ${panel === p ? "border-b-2 border-ocean text-white" : "text-muted"}`}>
                {p === "around" ? "Around" : p === "template" ? "Tmpl" : p === "whatif" ? "What-if" : p}
              </button>
            ))}
          </div>
          <div className="p-3 text-xs">
            {panel === "selection" && !edgeSel && <SavedSelections g={g} selected={selected} setSelected={selectLocal} update={update} />}
            {panel === "selection" && (edgeSel ? <EdgeDetails edge={edgeSel} nodes={data.nodes} /> : <SelectionPanel nodes={sel} types={types} events={eventsByNode} changed={changed} />)}
            {panel === "histogram" && <HistogramPanel nodes={visible} types={types} filters={hist} setFilters={setHist} onSelect={(ids) => (selectLocal(new Set(ids)), setSelectedEdge(null))} />}
            {panel === "flow" && <FlowPanel g={g} types={types.filter((t) => data.nodes.some((n) => n.object_type_id === t.id))} allTypes={types} links={links} update={(c) => update(c, c.layers !== undefined && g.layout === "flow")} />}
            {panel === "around" && (
              <AroundPanel
                start={selRefs}
                types={types}
                scenarioId={g.scenario_id}
                onAdd={addNodes}
                onRecord={(r) => setRecorded((cur) => (cur.some((x) => JSON.stringify([x.object_type_id, x.steps]) === JSON.stringify([r.object_type_id, r.steps])) ? cur : [...cur, r]))}
                onAddFunction={(refs, edges) => {
                  const have = new Set(g.nodes.map(key));
                  const add = refs.filter((r) => !have.has(key(r))).map((r) => ({ object_type_id: r.object_type_id, primary_key: String(r.primary_key) }));
                  const known = new Set((g.function_edges ?? []).map((e) => `${e.function_id}|${e.source}|${e.target}`));
                  update({ nodes: [...g.nodes, ...add], function_edges: [...(g.function_edges ?? []), ...edges.filter((e) => !known.has(`${e.function_id}|${e.source}|${e.target}`))] });
                }}
              />
            )}
            {panel === "layers" && <SavedStyles g={g} update={update} />}
            {panel === "layers" && <MediaPanel g={g} types={types.filter((t) => data.nodes.some((n) => n.object_type_id === t.id))} update={update} />}
            {panel === "layers" && <LayersPanel g={g} types={types.filter((t) => data.nodes.some((n) => n.object_type_id === t.id))} update={update} />}
            {panel === "layers" && <EdgeStylesPanel g={g} edges={data.edges} update={update} />}
            {panel === "whatif" && (
              <WhatIfPanel
                g={g}
                scenarios={scList.filter((s) => !s.merged)}
                selected={sel}
                types={types}
                onScenario={(id, created) => (created && setScList((l) => [created, ...l]), update({ scenario_id: id }))}
                onApplied={() => void resolve(g, false)}
              />
            )}
            {panel === "events" && <EventsPanel events={data.events} time={g.time} update={update} onPick={(id) => selectLocal(new Set([id]))} />}
            {panel === "template" && <TemplatePanel g={g} recorded={recorded} setRecorded={setRecorded} types={types} onGenerated={(graph) => (setG(graph), setDirty(true), setPos({}), void resolve(graph, true))} onSaved={async () => setRows(await vertex.graphs())} />}
          </div>
          {g.id && (
            <div className="border-t border-line p-3 text-xs">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={g.read_only} onChange={(e) => update({ read_only: e.target.checked })} /> Read-only for others
              </label>
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirmDialog({ message: `Delete ${g.name}?`, danger: true, confirmLabel: "Delete" }))) return;
                  try {
                    await vertex.remove(g.id!);
                    setRows(await vertex.graphs());
                    setG(emptyGraph());
                    setData({ nodes: [], edges: [], grouped_edges: [], events: [], scenario_changed: [] });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                className={`${buttonClass.ghost} mt-2`}
              >
                <Icon name="trash" className="h-3.5 w-3.5" /> Delete graph
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}


function SelectionPanel({ nodes, types, events, changed }: { nodes: VNode[]; types: ObjectType[]; events: Map<string, VEvent[]>; changed: Set<string> }) {
  if (!nodes.length) return <div className="text-muted">Click a node (shift-click for several) to see its properties, related events and Search Arounds.</div>;
  if (nodes.length > 1)
    return (
      <div className="space-y-1">
        <div className="font-medium">{nodes.length} objects selected</div>
        {nodes.map((n) => (
          <div key={n.id} className="truncate text-soft">
            {n.object_type}: {n.title}
          </div>
        ))}
      </div>
    );
  const n = nodes[0];
  const t = types.find((x) => x.id === n.object_type_id);
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">{n.title}</div>
        <div className="text-muted">
          {n.object_type}
          {changed.has(n.id) && <span className="ml-2 text-sand">changed in the scenario</span>}
        </div>
        <Link href={`/ontology/objects/${n.object_type_id}/${encodeURIComponent(n.primary_key)}`} className="text-ocean hover:underline">
          Object View
        </Link>
      </div>
      {(events.get(n.id) ?? []).map((ev) => (
        <div key={ev.id} className="flex items-center gap-2 rounded border border-line px-2 py-1">
          <span className="h-2 w-2 rounded-full" style={{ background: INTENT[ev.intent] }} />
          <span className="flex-1 truncate">{ev.title}</span>
          <span className="text-muted">{ev.at ? String(ev.at).slice(0, 10) : ""}</span>
        </div>
      ))}
      <div className="divide-y divide-line">
        {(t?.properties ?? [])
          .filter((p) => p.type !== "vector" && n.properties[p.api_name] !== undefined)
          .map((p) => (
            <div key={p.api_name} className="flex gap-2 py-1.5">
              <span className="w-28 shrink-0 text-muted">{p.display_name}</span>
              <span className="min-w-0 flex-1 break-words">
                <ValueCell type={p.type} value={n.properties[p.api_name]} />
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

/** A Search Around chain as it was added to the graph: the starting type, its steps (links, directions, filters), a label. */
type RecordedAround = { object_type_id: string; steps: Step[]; label: string };

function AroundPanel({ start, types, scenarioId, onAdd, onRecord, onAddFunction }: { start: NodeRef[]; types: ObjectType[]; scenarioId: string | null; onAdd: (n: NodeRef[]) => void; onRecord?: (r: RecordedAround) => void; onAddFunction: (n: NodeRef[], edges: FunctionEdge[]) => void }) {
  const [steps, setSteps] = useState<(Step & { label?: string; to_type_id?: string })[]>([]);
  const [opts, setOpts] = useState<AroundOption[]>([]);
  const [result, setResult] = useState<{ layers: { object_type_id: string; primary_keys: string[] }[]; nodes: NodeRef[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startType = start[0]?.object_type_id;
  const sameType = start.every((s) => s.object_type_id === startType);
  const lastType = result?.layers.at(-1)?.object_type_id ?? startType;
  useEffect(() => {
    if (!startType || !sameType) return;
    const fromNodes: NodeRef[] = result?.layers.length ? result.layers.at(-1)!.primary_keys.slice(0, 500).map((pk) => ({ object_type_id: result.layers.at(-1)!.object_type_id, primary_key: pk })) : start;
    if (!fromNodes.length) return;
    vertex.options(fromNodes, scenarioId).then((o) => setOpts(o.filter((x) => !x.via)), () => setOpts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startType, sameType, result, scenarioId, start.length]);
  const run = async (next: Step[]) => {
    try {
      setResult(next.length ? await vertex.searchAround(start, next, scenarioId) : null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!start.length || !sameType) return <div className="text-muted">Select one or more objects of the same type on the graph to start a Search Around.</div>;
  const tname = (id: string) => types.find((t) => t.id === id)?.display_name ?? id;
  return (
    <div className="space-y-3">
      <div className="rounded border border-line p-2">
        Starting objects: {start.length} {tname(startType)}
      </div>
      <FunctionSearch key={startType} start={start} typeId={startType} scenarioId={scenarioId} onAdd={onAddFunction} />
      {steps.map((s, i) => {
        const layer = result?.layers[i + 1];
        // the type the step reaches: known from the link chosen, before its results arrive (filters can be added at once)
        const t = types.find((x) => x.id === (layer?.object_type_id ?? s.to_type_id));
        return (
          <div key={i} className="space-y-1.5 rounded border border-line p-2" data-around-step={i}>
            <div className="flex items-center gap-2">
              <span className="font-medium">
                {i + 1}. {s.label}
              </span>
              <span className="ml-auto text-muted">{layer ? `${layer.primary_keys.length} objects` : ""}</span>
            </div>
            {(s.filters ?? []).map((f, j) => (
              <div key={j} className="flex flex-wrap gap-1">
                <select
                  value={f.property}
                  onChange={(e) => setSteps(steps.map((x, k) => (k === i ? { ...x, filters: (x.filters ?? []).map((y, m) => (m === j ? { ...y, property: e.target.value } : y)) } : x)))}
                  className={fieldClass}
                >
                  {(t?.properties ?? []).map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
                <select
                  value={f.op}
                  onChange={(e) => setSteps(steps.map((x, k) => (k === i ? { ...x, filters: (x.filters ?? []).map((y, m) => (m === j ? { ...y, op: e.target.value } : y)) } : x)))}
                  className={fieldClass}
                >
                  {FILTER_OPS.filter((o) => o.id !== "between").map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {f.op !== "is_null" && f.op !== "not_null" && (
                  <input
                    value={String(f.value ?? "")}
                    onChange={(e) => setSteps(steps.map((x, k) => (k === i ? { ...x, filters: (x.filters ?? []).map((y, m) => (m === j ? { ...y, value: e.target.value } : y)) } : x)))}
                    className={`${fieldClass} w-24`}
                  />
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSteps(steps.map((x, k) => (k === i ? { ...x, filters: [...(x.filters ?? []), { property: t?.properties[0]?.api_name ?? "", op: "eq", value: "" } as Filter] } : x)))}
                className={buttonClass.ghost}
              >
                <Icon name="filter" className="h-3 w-3" /> Add filter
              </button>
              <button type="button" onClick={() => run(steps)} className={buttonClass.ghost}>
                Apply
              </button>
            </div>
          </div>
        );
      })}
      <select
        value=""
        onChange={(e) => {
          const o = opts.find((x) => `${x.link_type_id}|${x.direction}` === e.target.value && x.from_type_id === lastType);
          if (!o) return;
          const next = [...steps, { link_type_id: o.link_type_id, direction: o.direction, filters: [], label: `${o.label} (${o.object_type})`, to_type_id: o.to_type_id }];
          setSteps(next);
          void run(next);
        }}
        className={inputClass}
        aria-label="Add a link"
      >
        <option value="">{steps.length ? "Add link…" : "Search Around to…"}</option>
        {opts
          .filter((o) => o.from_type_id === lastType)
          .map((o) => (
            <option key={`${o.link_type_id}|${o.direction}`} value={`${o.link_type_id}|${o.direction}`}>
              {o.label} ({o.object_type}) · {o.count}
            </option>
          ))}
      </select>
      <ErrorBox message={error} />
      {result && (
        <div className="space-y-2">
          <div className="text-muted">
            Starting set narrowed to {result.layers[0].primary_keys.length} {tname(startType)} connected to the result.
          </div>
          <button
            type="button"
            onClick={() => {
              onAdd(result.nodes);
              // remembered for "Save as template": the chain replays from the template's objects
              onRecord?.({
                object_type_id: startType,
                steps: steps.map((s) => ({ link_type_id: s.link_type_id, direction: s.direction, ...(s.filters?.length ? { filters: s.filters } : {}) })),
                label: steps.map((s) => s.label ?? s.link_type_id).join(" → "),
              });
            }}
            className={`${buttonClass.primary} w-full`}
            data-around-add
          >
            Add {result.nodes.length} objects to graph
          </button>
          <button type="button" onClick={() => (setSteps([]), setResult(null))} className={`${buttonClass.ghost} w-full`}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** The first matching readout threshold's color (thresholds in order), else none. */
function readoutColor(layer: Layer | undefined, r: Readout | undefined): string | undefined {
  if (!layer?.readout || r?.value === undefined || r.value === null) return undefined;
  const v = Number(r.value);
  return (layer.readout.thresholds ?? []).find((th) => (th.op === "gt" ? v > th.value : v < th.value))?.color;
}

function LayersPanel({ g, types, update }: { g: Graph; types: ObjectType[]; update: (c: Partial<Graph>) => void }) {
  const set = (tid: string, c: Partial<Layer>) => update({ layers: { ...g.layers, [tid]: { ...(g.layers[tid] ?? {}), ...c } } });
  if (!types.length) return <div className="text-muted">Add objects to style their layers.</div>;
  return (
    <div className="space-y-3">
      {types.map((t, i) => {
        const l = g.layers[t.id] ?? {};
        const numeric = t.properties.filter((p) => ["integer", "long", "double", "float", "decimal", "short"].includes(p.type));
        return (
          <div key={t.id} className="space-y-1.5 rounded border border-line p-2" data-layer={t.id}>
            <div className="flex items-center gap-2">
              <input type="color" value={l.color ?? PALETTE[i % PALETTE.length]} onChange={(e) => set(t.id, { color: e.target.value })} className="h-5 w-6 bg-transparent" aria-label="Color" />
              <span className="flex-1 font-medium">{t.display_name}</span>
              <label className="flex items-center gap-1 text-muted">
                <input type="checkbox" checked={!l.hidden} onChange={(e) => set(t.id, { hidden: !e.target.checked })} /> shown
              </label>
            </div>
            <div className="flex gap-1">
              <select value={l.label_property ?? ""} onChange={(e) => set(t.id, { label_property: e.target.value || undefined })} className={`${fieldClass} flex-1`} aria-label="Label">
                <option value="">Label: title</option>
                {t.properties.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    Label: {p.display_name}
                  </option>
                ))}
                {(l.derived ?? []).map((d) => (
                  <option key={`d-${d.name}`} value={d.name}>
                    Label: {d.name} (derived)
                  </option>
                ))}
              </select>
              <select value={l.size_property ?? ""} onChange={(e) => set(t.id, { size_property: e.target.value || undefined })} className={`${fieldClass} flex-1`} aria-label="Size">
                <option value="">Size: fixed</option>
                {numeric.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    Size: {p.display_name}
                  </option>
                ))}
              </select>
            </div>
            {(l.rules ?? []).map((r, j) => (
              <div key={j} className="flex items-center gap-1" data-rule={j}>
                <select value={r.property} onChange={(e) => set(t.id, { rules: (l.rules ?? []).map((x, k) => (k === j ? { ...x, property: e.target.value } : x)) })} className={`${fieldClass} w-24`}>
                  {t.properties.map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
                <select value={r.op} onChange={(e) => set(t.id, { rules: (l.rules ?? []).map((x, k) => (k === j ? { ...x, op: e.target.value as "eq" } : x)) })} className={fieldClass}>
                  <option value="eq">=</option>
                  <option value="neq">≠</option>
                  <option value="gt">&gt;</option>
                  <option value="lt">&lt;</option>
                </select>
                <input value={r.value} onChange={(e) => set(t.id, { rules: (l.rules ?? []).map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} className={`${fieldClass} w-16`} />
                <input type="color" value={r.color} onChange={(e) => set(t.id, { rules: (l.rules ?? []).map((x, k) => (k === j ? { ...x, color: e.target.value } : x)) })} className="h-5 w-6 bg-transparent" />
                <button type="button" onClick={() => set(t.id, { rules: (l.rules ?? []).filter((_, k) => k !== j) })} className="text-muted hover:text-bad" aria-label="Remove rule">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button type="button" data-add-rule onClick={() => set(t.id, { rules: [...(l.rules ?? []), { property: t.properties[0]?.api_name ?? "", op: "eq", value: "", color: "#f59e0b" }] })} className={buttonClass.ghost}>
              <Icon name="plus" className="h-3 w-3" /> Conditional color
            </button>
            <DerivedEditor typeId={t.id} specs={l.derived ?? []} onChange={(derived) => set(t.id, { derived })} />
            {t.properties.some((p) => p.type === "timeseries") && (
              <div className="space-y-1 border-t border-line pt-1.5">
                <div className="flex gap-1">
                  <select value={l.readout?.property ?? ""} onChange={(e) => set(t.id, { readout: e.target.value ? { ...l.readout, property: e.target.value } : undefined })} className={`${fieldClass} flex-1`} aria-label="Time series readout">
                    <option value="">Readout: none</option>
                    {t.properties.filter((p) => p.type === "timeseries").map((p) => <option key={p.api_name} value={p.api_name}>Readout: {p.display_name}</option>)}
                  </select>
                  {l.readout && (
                    <select value={l.readout.stat ?? "last"} onChange={(e) => set(t.id, { readout: { ...l.readout!, stat: e.target.value as "last" } })} className={fieldClass} aria-label="Statistic">
                      {["last", "mean", "min", "max", "first"].map((s) => <option key={s}>{s}</option>)}
                    </select>
                  )}
                </div>
                {l.readout && (l.readout.thresholds ?? []).map((th, j) => (
                  <div key={j} className="flex items-center gap-1" data-threshold={j}>
                    <span className="text-muted">value</span>
                    <select value={th.op} onChange={(e) => set(t.id, { readout: { ...l.readout!, thresholds: l.readout!.thresholds!.map((x, k) => (k === j ? { ...x, op: e.target.value as "gt" } : x)) } })} className={fieldClass}>
                      <option value="gt">&gt;</option>
                      <option value="lt">&lt;</option>
                    </select>
                    <input type="number" value={th.value} onChange={(e) => set(t.id, { readout: { ...l.readout!, thresholds: l.readout!.thresholds!.map((x, k) => (k === j ? { ...x, value: Number(e.target.value) } : x)) } })} className={`${fieldClass} w-20`} />
                    <input type="color" value={th.color} onChange={(e) => set(t.id, { readout: { ...l.readout!, thresholds: l.readout!.thresholds!.map((x, k) => (k === j ? { ...x, color: e.target.value } : x)) } })} className="h-5 w-6 bg-transparent" />
                    <button type="button" onClick={() => set(t.id, { readout: { ...l.readout!, thresholds: l.readout!.thresholds!.filter((_, k) => k !== j) } })} className="text-muted hover:text-bad" aria-label="Remove threshold"><Icon name="x" className="h-3 w-3" /></button>
                  </div>
                ))}
                {l.readout && (
                  <button type="button" data-add-threshold onClick={() => set(t.id, { readout: { ...l.readout!, thresholds: [...(l.readout!.thresholds ?? []), { op: "gt", value: 0, color: "#ef4444" }] } })} className={buttonClass.ghost}>
                    <Icon name="plus" className="h-3 w-3" /> Threshold color
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EventsPanel({ events, time, update, onPick }: { events: VEvent[]; time: Graph["time"]; update: (c: Partial<Graph>) => void; onPick: (nodeId: string) => void }) {
  const dated = events.filter((e) => e.at).map((e) => ({ ...e, t: new Date(String(e.at)).getTime() }));
  const min = Math.min(...dated.map((e) => e.t));
  const max = Math.max(...dated.map((e) => e.t));
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="text-muted">Time selection</div>
        <div className="flex gap-1">
          <input type="date" value={time?.start?.slice(0, 10) ?? ""} onChange={(e) => update({ time: { ...time, start: e.target.value || undefined } })} className={`${fieldClass} flex-1`} aria-label="Start" />
          <input type="date" value={time?.end?.slice(0, 10) ?? ""} onChange={(e) => update({ time: { ...time, end: e.target.value ? `${e.target.value}T23:59:59` : undefined } })} className={`${fieldClass} flex-1`} aria-label="End" />
        </div>
      </div>
      {dated.length > 0 && (
        <svg viewBox="0 0 280 40" className="w-full">
          <line x1={0} y1={20} x2={280} y2={20} stroke="#475569" />
          {dated.map((e) => (
            <circle key={e.id + e.node} cx={max > min ? ((e.t - min) / (max - min)) * 270 + 5 : 140} cy={20} r={4} fill={INTENT[e.intent]} className="cursor-pointer" onClick={() => onPick(e.node)}>
              <title>{`${e.title} · ${String(e.at).slice(0, 10)}`}</title>
            </circle>
          ))}
        </svg>
      )}
      {events.length === 0 && <div className="text-muted">No related events. Event object types carry a vertex:event_intent type class and link to the graph&apos;s objects.</div>}
      <div className="divide-y divide-line">
        {events.map((e) => (
          <button key={e.id + e.node} type="button" onClick={() => onPick(e.node)} className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-panel-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: INTENT[e.intent] }} />
            <span className="min-w-0 flex-1 truncate">{e.title}</span>
            <span className="text-muted">{e.at ? String(e.at).slice(0, 10) : "—"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TemplatePanel({ g, recorded, setRecorded, types, onGenerated, onSaved }: { g: Graph; recorded: RecordedAround[]; setRecorded: (r: RecordedAround[]) => void; types: ObjectType[]; onGenerated: (graph: Graph) => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!g.template)
    return (
      <div className="space-y-2" data-template-draft>
        <div className="text-muted">
          This graph is not a template. Select an object and use &quot;Save as template&quot;: the template takes objects of that type and replays the graph&apos;s styling; the Search Arounds added
          to the graph from that type (Around tab) run from them.
        </div>
        {recorded.map((r, i) => (
          <div key={i} className="flex items-start gap-1 rounded border border-line p-2" data-recorded-around={i}>
            <div className="min-w-0 flex-1">
              <div className="text-muted">From {types.find((t) => t.id === r.object_type_id)?.display_name ?? r.object_type_id}</div>
              <div className="break-words">{r.label}</div>
              {r.steps.some((s) => s.filters?.length) && <div className="text-muted">{r.steps.flatMap((s) => (s.filters ?? []).map((f) => `${f.property} ${f.op}${f.value === undefined || f.value === "" ? "" : ` ${String(f.value)}`}`)).join(", ")}</div>}
            </div>
            <button type="button" onClick={() => setRecorded(recorded.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Forget this Search Around">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
        ))}
        {!recorded.length && <div className="text-muted">No Search Around added to the graph yet.</div>}
      </div>
    );
  const params = Object.fromEntries(g.template.parameters.map((p) => [p.id, list(values[p.id] ?? "")]));
  return (
    <div className="space-y-3">
      <div className="text-muted">{g.description}</div>
      {g.template.parameters.map((p) => (
        <div key={p.id} className="space-y-1">
          <div className="font-medium">{p.name}</div>
          <ObjectPicker objectTypeId={p.object_type_id} value={values[p.id] ?? ""} onChange={(pk) => setValues({ ...values, [p.id]: pk })} />
          <div className="text-muted">{p.search_arounds.length} Search Around{p.search_arounds.length === 1 ? "" : "s"} from these objects</div>
        </div>
      ))}
      <ErrorBox message={error} />
      <div className="flex gap-2">
        <button type="button" onClick={() => vertex.run(g.id!, params).then(onGenerated, (e: Error) => setError(e.message))} className={buttonClass.primary}>
          Generate graph
        </button>
        <button type="button" onClick={() => vertex.run(g.id!, params, true).then(onSaved, (e: Error) => setError(e.message))} className={buttonClass.secondary}>
          Generate and save
        </button>
      </div>
    </div>
  );
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** What-if: a scenario of the Ontology, Actions run on the selected object inside it, and what changed vs main. */
function WhatIfPanel({ g, scenarios: list, selected, types, onScenario, onApplied }: {
  g: Graph;
  scenarios: Scenario[];
  selected: VNode[];
  types: ObjectType[];
  onScenario: (id: string | null, created?: Scenario) => void;
  onApplied: () => void;
}) {
  const [actions, setActions] = useState<ActionType[]>([]);
  const [open, setOpen] = useState<{ action: ActionType; type: ObjectType; object: OntologyObject } | null>(null);
  const [cmp, setCmp] = useState<Awaited<ReturnType<typeof vertex.compare>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const node = selected.length === 1 ? selected[0] : null;
  useEffect(() => {
    if (!node) return;
    ontology.actionTypes(node.object_type_id).then(setActions, () => setActions([]));
  }, [node]);
  const run = useCallback(() => {
    if (!g.scenario_id) return;
    vertex.compare(g.nodes, g.scenario_id).then(setCmp, (e: Error) => setErr(e.message));
  }, [g.nodes, g.scenario_id]);
  useEffect(() => {
    if (!g.scenario_id) return;
    run();
  }, [g.scenario_id, run]);
  return (
    <div className="space-y-3">
      <p className="text-muted">Ask &quot;what if?&quot;: run Actions in a scenario (main plus its edits) and compare the graph&apos;s objects with main.</p>
      <div className="flex gap-1">
        <select value={g.scenario_id ?? ""} onChange={(e) => onScenario(e.target.value || null)} className={`${fieldClass} flex-1`} aria-label="Scenario">
          <option value="">Pick a scenario…</option>
          {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button
          type="button"
          onClick={async () => {
            const name = await promptDialog("Scenario name", `What-if ${g.name}`, { title: "New scenario" });
            if (!name) return;
            try {
              const s = await scenarios.create({ name });
              onScenario(s.id, s);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
          className={buttonClass.ghost}
        >
          New
        </button>
      </div>
      {g.scenario_id && (
        <div className="space-y-1">
          <div className="font-medium">Add an Action{node ? ` on ${node.title}` : ""}</div>
          {!node && <p className="text-muted">Select one object on the graph.</p>}
          {node && actions.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={async () => {
                try {
                  const [type, object] = await Promise.all([ontology.objectType(node.object_type_id), ontology.object(node.object_type_id, node.primary_key)]);
                  setOpen({ action: a, type, object });
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
              className="block w-full rounded px-2 py-1 text-left text-ocean hover:bg-panel-2"
            >
              {a.display_name}
            </button>
          ))}
          {node && actions.length === 0 && <p className="text-muted">No action types on {types.find((t) => t.id === node.object_type_id)?.display_name ?? "this type"}.</p>}
        </div>
      )}
      {cmp && (
        <div className="space-y-1">
          <div className="flex items-center justify-between font-medium">
            <span>Compared with main</span>
            <button type="button" onClick={run} className="text-ocean hover:underline">Refresh</button>
          </div>
          {cmp.objects.length === 0 && <p className="text-muted">No differences on this graph&apos;s objects yet.</p>}
          {cmp.objects.map((o) => (
            <div key={o.id} className="rounded border border-line p-1.5">
              <div className="font-medium">{o.title} <span className="text-muted">{o.object_type} · {o.status}</span></div>
              {o.changes.map((ch) => (
                <div key={ch.property} className="grid grid-cols-[1fr_auto_auto] gap-1 text-[11px]">
                  <span className="truncate text-muted">{ch.property}</span>
                  <span className="text-muted line-through">{String(ch.baseline ?? "—")}</span>
                  <span className="text-sand">{String(ch.scenario ?? "—")}</span>
                </div>
              ))}
            </div>
          ))}
          <p className="text-[10px] text-muted">{cmp.unchanged} objects unchanged.</p>
        </div>
      )}
      {err && <p className="text-bad">{err}</p>}
      {open && g.scenario_id && (
        <ActionForm
          action={open.action}
          objectType={open.type}
          object={open.object}
          scenarioId={g.scenario_id}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            onApplied();
            run();
          }}
        />
      )}
    </div>
  );
}

/** Function-backed Search Around: a published function taking the selected objects and returning objects. */
function FunctionSearch({ start, typeId, scenarioId, onAdd }: { start: NodeRef[]; typeId: string; scenarioId: string | null; onAdd: (n: NodeRef[], edges: FunctionEdge[]) => void }) {
  const [fns, setFns] = useState<GraphFunction[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    vertex.functions(typeId).then((f) => setFns(f.filter((x) => x.returns === "objects")), () => setFns([]));
  }, [typeId]);
  if (!fns.length) return null;
  return (
    <div className="space-y-1 rounded border border-line p-2">
      <div className="font-medium">Search Around with a function</div>
      {fns.map((f) => (
        <button
          key={f.id}
          type="button"
          disabled={busy !== null}
          title={f.doc || f.output}
          onClick={async () => {
            setBusy(f.id);
            try {
              const r = await vertex.functionAround(start, f.id, scenarioId);
              onAdd(r.nodes, r.edges);
              setMsg(`${f.name}: ${r.nodes.length} objects${r.errors.length ? ` · ${r.errors.join("; ")}` : ""}`);
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setBusy(null);
            }
          }}
          className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-ocean hover:bg-panel-2 disabled:opacity-50"
        >
          <span>{f.name}</span>
          <span className="text-[10px] text-muted">{busy === f.id ? "running…" : f.mode === "one" ? "per object" : "all at once"}</span>
        </button>
      ))}
      {msg && <p className="text-muted">{msg}</p>}
    </div>
  );
}

/** Derived properties of a layer: published functions returning a value for each object of the type. */
function DerivedEditor({ typeId, specs, onChange }: { typeId: string; specs: DerivedSpec[]; onChange: (s: DerivedSpec[]) => void }) {
  const [fns, setFns] = useState<GraphFunction[]>([]);
  useEffect(() => {
    vertex.functions(typeId).then((f) => setFns(f.filter((x) => x.returns === "value")), () => setFns([]));
  }, [typeId]);
  if (!fns.length && !specs.length) return null;
  return (
    <div className="space-y-1 border-t border-line pt-1.5">
      <div className="text-muted">Derived properties (from functions)</div>
      {specs.map((d, j) => (
        <div key={j} className="flex items-center gap-1">
          <input key={`n-${d.name}`} defaultValue={d.name} onBlur={(e) => e.target.value && e.target.value !== d.name && onChange(specs.map((x, k) => (k === j ? { ...x, name: e.target.value } : x)))} className={`${fieldClass} w-24`} aria-label="Derived property name" />
          <select value={d.function_id} onChange={(e) => onChange(specs.map((x, k) => (k === j ? { ...x, function_id: e.target.value } : x)))} className={`${fieldClass} min-w-0 flex-1`} aria-label="Function">
            {fns.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => onChange(specs.filter((_, k) => k !== j))} className="text-muted hover:text-bad" aria-label="Remove derived property">
            <Icon name="x" className="h-3 w-3" />
          </button>
        </div>
      ))}
      {fns.length > 0 && specs.length < 5 && (
        <button type="button" onClick={() => onChange([...specs, { name: fns[0].name, function_id: fns[0].id }])} className={buttonClass.ghost}>
          <Icon name="plus" className="h-3 w-3" /> Derived property
        </button>
      )}
    </div>
  );
}

/** The media layer image and its annotations, in world coordinates under the graph. */
function MediaUnderlay({ g, onSize }: { g: Graph; onSize: (h: number) => void }) {
  const m = g.media;
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    if (!m) return;
    const img = new Image();
    img.onload = () => {
      const r = img.naturalHeight / Math.max(1, img.naturalWidth);
      setRatio(r);
      onSize(m.width * r);
    };
    img.src = driveContentUrl(m.item_id, true);
  }, [m, onSize]);
  if (!m) return null;
  const h = m.width * (ratio ?? 0.6);
  return (
    <g pointerEvents="none">
      <image href={driveContentUrl(m.item_id, true)} x={m.x} y={m.y} width={m.width} height={h} opacity={m.opacity} preserveAspectRatio="xMinYMin meet" />
      {(g.annotations ?? []).map((a) => (
        <g key={a.id}>
          <rect x={m.x + a.x} y={m.y + a.y} width={a.w} height={a.h} fill={a.color} fillOpacity={0.12} stroke={a.color} strokeWidth={2} rx={4} />
          <text x={m.x + a.x + 6} y={m.y + a.y + 16} fontSize={14} fill={a.color} fontWeight={600}>
            {a.text}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Media layer settings: the image, where it sits, annotations, and the layers pinned onto it by coordinates. */
function MediaPanel({ g, types, update }: { g: Graph; types: ObjectType[]; update: (c: Partial<Graph>, relayout?: boolean) => void }) {
  const [picking, setPicking] = useState(false);
  const m = g.media;
  const anns = g.annotations ?? [];
  const setM = (c: Partial<NonNullable<Graph["media"]>>) => m && update({ media: { ...m, ...c } });
  const setA = (i: number, c: Partial<Annotation>) => update({ annotations: anns.map((a, j) => (j === i ? { ...a, ...c } : a)) });
  const num = (v: number, set: (n: number) => void, label: string, w = "w-16") => (
    <input type="number" value={v} onChange={(e) => set(Number(e.target.value) || 0)} className={`${fieldClass} ${w}`} aria-label={label} title={label} />
  );
  return (
    <div className="mb-3 space-y-2 rounded border border-line p-2">
      <div className="flex items-center justify-between">
        <span className="font-medium">Media layer</span>
        <button type="button" onClick={() => setPicking(true)} className="text-ocean hover:underline">
          {m ? "Change image" : "Add an image"}
        </button>
      </div>
      {!m && <p className="text-muted">An image from Files (a site plan, a schematic) under the graph; pin objects onto it by their pixel coordinates.</p>}
      {m && (
        <>
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate" title={m.name}>{m.name}</span>
            <button type="button" onClick={() => update({ media: null, annotations: [] })} className="text-muted hover:text-bad" aria-label="Remove media layer">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-muted">
            x {num(m.x, (x) => setM({ x }), "Left")} y {num(m.y, (y) => setM({ y }), "Top")} width {num(m.width, (width) => setM({ width: Math.max(10, width) }), "Width", "w-20")}
          </div>
          <label className="flex items-center gap-2 text-muted">
            Opacity <input type="range" min={0.1} max={1} step={0.05} value={m.opacity} onChange={(e) => setM({ opacity: Number(e.target.value) })} className="flex-1" />
          </label>
          {types.map((t) => {
            const l = g.layers[t.id] ?? {};
            const numeric = t.properties.filter((p) => p.type === "integer" || p.type === "double");
            if (!numeric.length) return null;
            const setL = (c: Partial<Layer>) => update({ layers: { ...g.layers, [t.id]: { ...l, ...c } } });
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-1">
                <span className="w-full text-muted">Pin {t.display_name} by</span>
                {(["media_x", "media_y"] as const).map((k) => (
                  <select key={k} value={l[k] ?? ""} onChange={(e) => setL({ [k]: e.target.value || undefined })} className={`${fieldClass} flex-1`} aria-label={k === "media_x" ? "X property" : "Y property"}>
                    <option value="">{k === "media_x" ? "x: —" : "y: —"}</option>
                    {numeric.map((p) => (
                      <option key={p.api_name} value={p.api_name}>
                        {k === "media_x" ? "x" : "y"}: {p.display_name}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            );
          })}
          <div className="space-y-1 border-t border-line pt-1.5">
            <div className="text-muted">Annotations (pixels on the image)</div>
            {anns.map((a, i) => (
              <div key={a.id} className="flex flex-wrap items-center gap-1">
                <input type="color" value={a.color} onChange={(e) => setA(i, { color: e.target.value })} className="h-5 w-6 bg-transparent" aria-label="Annotation color" />
                <input key={`t-${a.text}`} defaultValue={a.text} onBlur={(e) => e.target.value !== a.text && setA(i, { text: e.target.value })} className={`${fieldClass} min-w-0 flex-1`} aria-label="Annotation text" />
                <button type="button" onClick={() => update({ annotations: anns.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove annotation">
                  <Icon name="x" className="h-3 w-3" />
                </button>
                <div className="flex w-full gap-1">
                  {num(a.x, (x) => setA(i, { x }), "x", "w-14")}
                  {num(a.y, (y) => setA(i, { y }), "y", "w-14")}
                  {num(a.w, (w) => setA(i, { w: Math.max(4, w) }), "width", "w-14")}
                  {num(a.h, (h) => setA(i, { h: Math.max(4, h) }), "height", "w-14")}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => update({ annotations: [...anns, { id: `an-${crypto.randomUUID().slice(0, 6)}`, x: 20, y: 20, w: 160, h: 90, text: "Area", color: "#f59e0b" }] })}
              className={buttonClass.ghost}
            >
              <Icon name="plus" className="h-3 w-3" /> Annotation
            </button>
          </div>
        </>
      )}
      {picking && (
        <DrivePicker
          title="Media layer image"
          canPick={(it) => (it.content_type?.startsWith("image/") ? null : "Pick an image")}
          onPick={(it) => {
            setPicking(false);
            update({ media: { item_id: it.id, name: it.name, x: m?.x ?? 0, y: m?.y ?? 0, width: m?.width ?? 1200, opacity: m?.opacity ?? 0.8 } });
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** Edge styles per link type on this graph: color, dashed, and arrows (as the Ontology says, reversed, none, both). */
function EdgeStylesPanel({ g, edges, update }: { g: Graph; edges: VEdge[]; update: (c: Partial<Graph>) => void }) {
  const kinds = [...new Map(edges.map((e) => [e.link_type_id, e])).values()];
  if (!kinds.length) return null;
  const set = (lt: string, c: Partial<EdgeStyle>) => update({ edge_styles: { ...g.edge_styles, [lt]: { ...(g.edge_styles[lt] ?? {}), ...c } } });
  return (
    <div className="mt-3 space-y-1.5 rounded border border-line p-2">
      <div className="font-medium">Edges</div>
      {kinds.map((e) => {
        const st = g.edge_styles[e.link_type_id] ?? {};
        return (
          <div key={e.link_type_id} className="flex flex-wrap items-center gap-1" data-edge-style={e.link_type_id}>
            <input type="color" value={st.color ?? "#64748b"} onChange={(ev) => set(e.link_type_id, { color: ev.target.value })} className="h-5 w-6 bg-transparent" aria-label="Edge color" />
            <span className="min-w-0 flex-1 truncate" title={e.label}>{e.label || e.link_type_id}</span>
            <label className="flex items-center gap-1 text-muted">
              <input type="checkbox" checked={!!st.dashed} onChange={(ev) => set(e.link_type_id, { dashed: ev.target.checked })} /> dashed
            </label>
            <select value={st.arrows ?? "default"} onChange={(ev) => set(e.link_type_id, { arrows: ev.target.value as EdgeStyle["arrows"] })} className={fieldClass} aria-label="Arrows">
              <option value="default">arrows: {e.arrow === "none" ? "none" : e.arrow === "both" ? "both" : "Nexus"}</option>
              <option value="reverse">reversed</option>
              <option value="none">none</option>
              <option value="both">both ends</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}

/** Objects dragged onto the graph: "object:<type id>:<primary key>" lines (Nexus Manager's Objects table, the list here). */
const OBJECT_DRAG = "application/x-bluesandai-objects";
function droppedObjects(dt: DataTransfer): NodeRef[] {
  const text = dt.getData(OBJECT_DRAG) || dt.getData("text/plain");
  return text
    .split(/\r?\n/)
    .map((line) => /^object:([^:]+):(.+)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ object_type_id: m[1], primary_key: m[2] }));
}

/** The chosen type's objects, searchable: click one to add it, or drag it (or several, Ctrl-click) onto the graph. */
function ObjectList({ objectTypeId, onGraph, onAdd }: { objectTypeId: string; onGraph: Set<string>; onAdd: (pk: string) => void }) {
  const [objects, setObjects] = useState<OntologyObject[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // searched on the server (a type may hold more objects than one listing returns)
  useEffect(() => {
    let stale = false;
    const t = setTimeout(() => ontology.objects(objectTypeId, q.trim()).then((r) => !stale && setObjects(r.objects), () => !stale && setObjects([])), q ? 250 : 0);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [objectTypeId, q]);
  const needle = q.trim();
  const shown = (objects ?? []).slice(0, 60);
  return (
    <div className="space-y-1" data-object-list>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search objects…" className={inputClass} data-object-search />
      <ul className="max-h-56 overflow-y-auto rounded border border-line">
        {shown.map((o) => {
          const on = onGraph.has(`${objectTypeId}|${o.primary_key}`);
          return (
            <li
              key={o.primary_key}
              draggable
              onDragStart={(e) => {
                const pks = picked.has(o.primary_key) ? [...picked] : [o.primary_key];
                const text = pks.map((pk) => `object:${objectTypeId}:${pk}`).join("\n");
                e.dataTransfer.setData(OBJECT_DRAG, text);
                e.dataTransfer.setData("text/plain", text);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) return setPicked((s) => (s.has(o.primary_key) ? new Set([...s].filter((x) => x !== o.primary_key)) : new Set([...s, o.primary_key])));
                onAdd(o.primary_key);
              }}
              title={on ? "On the graph" : "Click to add, or drag onto the graph (Ctrl-click to pick several)"}
              className={`flex cursor-grab items-center gap-1 truncate px-2 py-1 ${picked.has(o.primary_key) ? "bg-ocean/20" : "hover:bg-panel-2"} ${on ? "text-muted" : ""}`}
              data-object-pk={o.primary_key}
            >
              <span className="min-w-0 flex-1 truncate">{o.title === o.primary_key ? o.title : `${o.title} · ${o.primary_key}`}</span>
              {on && <Icon name="check" className="h-3 w-3 shrink-0 text-ok" />}
            </li>
          );
        })}
        {objects !== null && !shown.length && <li className="px-2 py-1 text-muted">No objects{needle ? " match" : ""}</li>}
      </ul>
    </div>
  );
}
