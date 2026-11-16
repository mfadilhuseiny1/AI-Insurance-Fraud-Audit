"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { LogicEditor } from "@/components/timeseries/LogicEditor";
import { FunctionCard, type FunctionCardModel } from "@/components/quiver/FunctionCard";
import { SelectionsBar } from "@/components/quiver/PublishedDashboardView";
import { newTableCard, TableCardDashboard, TableCardSection } from "@/components/quiver/TableCards";
import { useDashboardSelections, type RunWithSelections } from "@/components/quiver/useDashboardSelections";
import { contour } from "@/lib/contour";
import { capture } from "@/lib/drillCapture";
import { CARD_ID_PREFIX, CARD_KIND_LABEL, cellText, isSelectorCard, isSeriesSingleCard, isTableCard, nextId, quiverTables, SINGLE_CARD_MENU, type QuiverTableCard, type TableResult } from "@/lib/quiverTables";
import { Plot, QuiverDashboard, upstream } from "@/components/timeseries/Quiver";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { DrivePicker } from "@/components/DrivePicker";
import { ontology, type ObjectType } from "@/lib/ontology";
import { FILTER_OPS, om, type Filter, type SearchResult } from "@/lib/ontologyModel";
import { cardInfo, nextCardId, SCALAR_CARDS, tsOntology, type Analysis, type Card, type QueryResult, type TsObjectType, type VisualFunction } from "@/lib/timeseries";

type ObjectSetCardModel = {
  id: string;
  object_type_id: string;
  title: string;
  query: string;
  filters: Filter[];
  visualization: "table" | "chart";
  group_by: string | null;
  metric: "count" | "sum" | "avg";
  measure: string | null;
};
type Canvas = NonNullable<Analysis["canvases"]>[number];
type Panel = "contents" | "parameters" | "dashboards" | "functions" | "settings";

/** Quiver: a canvas/graph analysis workspace for Ontology object sets and time series. */
export default function AnalysisPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [a, setA] = useState<Analysis | null>(null);
  const [saved, setSaved] = useState("");
  const [pickPublish, setPickPublish] = useState(false);
  const [mode, setMode] = useState<"analysis" | "dashboard">("analysis");
  const [activeCanvasId, setActiveCanvasId] = useState("");
  const [activePanel, setActivePanel] = useState<Panel>("contents");
  const [results, setResults] = useState<QueryResult | null>(null);
  const [types, setTypes] = useState<TsObjectType[]>([]);
  const [objectTypes, setObjectTypes] = useState<ObjectType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [contentsQuery, setContentsQuery] = useState("");
  const [showDataPicker, setShowDataPicker] = useState(false);
  const [showObjectPicker, setShowObjectPicker] = useState(false);
  const [showCardSearch, setShowCardSearch] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState("");
  const [shareNote, setShareNote] = useState("");
  const [tableResults, setTableResults] = useState<Record<string, TableResult>>({});
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [showTablesMenu, setShowTablesMenu] = useState(false);

  useEffect(() => {
    tsOntology.analysis(id).then((x) => (setA(x), setSaved(JSON.stringify(x))), (e: Error) => setError(e.message));
    tsOntology.objectTypes().then(setTypes, () => setTypes([]));
    ontology.objectTypes().then(setObjectTypes, () => setObjectTypes([]));
    contour.sources().then((s) => setDatasets(s.datasets), () => setDatasets([]));
  }, [id]);

  const canvases = useMemo<Canvas[]>(() => a?.canvases?.length ? a.canvases : a ? [{ id: "canvas-main", name: "Canvas", cards: [...a.logic.cards.map((c) => c.id), ...(a.object_sets ?? []).map((c) => c.id)] }] : [], [a]);
  const activeCanvas = canvases.find((c) => c.id === activeCanvasId) ?? canvases[0];
  const objectSets = useMemo(() => (a?.object_sets ?? []) as ObjectSetCardModel[], [a]);
  // function cards live with the object set cards (kind "function"): published functions run on the object sets
  const isFn = (c: unknown) => (c as FunctionCardModel).kind === "function";
  const setCards = useMemo(() => objectSets.filter((c) => !isFn(c) && !isTableCard(c)), [objectSets]);
  // table-side cards (transform tables, charts, values, Vega plots) run on the server with the unsaved draft
  const tableCards = useMemo(() => objectSets.filter(isTableCard) as unknown as QuiverTableCard[], [objectSets]);
  // (the time range too, when a table has time series columns: they default to it)
  // (and the logic, range and root object when a time series single card reads the logic's series)
  const readsSeries = objectSets.some((c) => isSeriesSingleCard(c as unknown as { kind: string }));
  const tableKey = JSON.stringify([objectSets, (a?.logic.cards ?? []).filter((c) => c.type.startsWith("param_")), objectSets.some((c) => (c as { series_columns?: unknown[] }).series_columns?.length) ? a?.range : null, readsSeries ? [a?.logic, a?.range, a?.root] : null]);
  const fnCards = useMemo(() => objectSets.filter(isFn) as unknown as FunctionCardModel[], [objectSets]);
  const activeIds = activeCanvas?.cards ?? [];
  const visibleTimeSeriesIds = activeIds.filter((cid) => a?.logic.cards.some((c) => c.id === cid));
  const visibleObjectSets = setCards.filter((c) => activeIds.includes(c.id));
  const visibleFnCards = fnCards.filter((c) => activeIds.includes(c.id));
  const viewMode = a?.view_mode ?? "canvas";
  useEffect(() => {
    if (!a || !objectSets.some(isTableCard)) return;
    const t = setTimeout(() => {
      quiverTables.run(a.id, { object_sets: objectSets, logic: a.logic, range: a.range, root: a.root?.object_type_id ? a.root : undefined }).then((r) => setTableResults(r.cards), (e: Error) => setError(e.message));
    }, 500);
    return () => clearTimeout(t);
    // tableKey holds the cards and parameters the tables read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);
  // the dashboard preview: selections in its selector cards re-run the draft for this view only (the analysis keeps
  // its saved defaults; a selector's default is changed in the analysis)
  const aid = a?.id;
  const logic = a?.logic;
  const range = a?.range;
  const root = a?.root?.object_type_id ? a.root : undefined;
  const runPreview = useMemo<RunWithSelections | null>(
    () => !aid || mode !== "dashboard" ? null : (selections) =>
      quiverTables.run(aid, { object_sets: objectSets.map((c) => (c.id in selections && isSelectorCard(c as unknown as { kind: string }) ? { ...c, value: selections[c.id] } : c)), logic, range, root }).then((r) => r.cards),
    [aid, mode, objectSets, logic, range, root],
  );
  const preview = useDashboardSelections(runPreview, `${aid}|${mode}`);

  const save = useCallback(async () => {
    if (!a) return;
    try {
      const x = await tsOntology.saveAnalysis(a.id, { name: a.name, description: a.description, logic: a.logic, root: a.root, plots: a.plots, range: a.range, dashboard: a.dashboard, canvases, view_mode: viewMode, object_sets: objectSets, rev: a.rev ?? 0 } as Partial<Analysis>);
      setA(x);
      setSaved(JSON.stringify(x));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [a, canvases, objectSets, viewMode]);

  /** Publish: save the analysis, then save a new version of its published dashboard (the first one into a folder). */
  const publish = async (folderId?: string | null) => {
    if (!a) return;
    try {
      if (dirty) await save();
      const note = a.published ? await promptDialog("What changed in this version? (optional)", "", { title: `Publish version ${a.published.version + 1}` }) : "";
      if (note === null) return;
      const r = await tsOntology.publishDashboard(a.id, { folder_id: folderId ?? null, note });
      const x = await tsOntology.analysis(a.id);
      setA(x);
      setSaved(JSON.stringify(x));
      setShareNote(`Published version ${r.version}: /quiver/dashboards/${r.item_id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !a) return <ApiError message={error} />;
  if (!a) return <Loading />;
  const dirty = JSON.stringify({ ...a, canvases, view_mode: viewMode, object_sets: objectSets }) !== saved;
  const set = (patch: Partial<Analysis>) => setA((current) => current ? { ...current, ...patch } : current);
  const currentCanvasId = activeCanvas?.id ?? "canvas-main";

  const changeLogic = (logic: Analysis["logic"]) => {
    const previous = new Set(a.logic.cards.map((c) => c.id));
    const next = new Set(logic.cards.map((c) => c.id));
    const added = logic.cards.filter((c) => !previous.has(c.id)).map((c) => c.id);
    const nextCanvases = canvases.map((canvas) => ({
      ...canvas,
      cards: [...new Set([...canvas.cards.filter((cid) => next.has(cid) || objectSets.some((o) => o.id === cid)), ...(canvas.id === currentCanvasId && viewMode === "canvas" ? added : [])])],
    }));
    set({ logic, canvases: nextCanvases });
  };
  const toggleCanvasCard = (cardId: string) => {
    const nextCanvases = canvases.map((c) => c.id === currentCanvasId ? { ...c, cards: c.cards.includes(cardId) ? c.cards.filter((x) => x !== cardId) : [...c.cards, cardId] } : c);
    set({ canvases: nextCanvases });
  };
  const addObjectSet = (type: ObjectType) => {
    const card: ObjectSetCardModel = { id: `object-${crypto.randomUUID().slice(0, 8)}`, object_type_id: type.id, title: type.display_name, query: "", filters: [], visualization: "table", group_by: null, metric: "count", measure: null };
    const nextCanvases = canvases.length ? canvases.map((c) => c.id === currentCanvasId ? { ...c, cards: [...c.cards, card.id] } : c) : [{ id: currentCanvasId, name: "Canvas", cards: [card.id] }];
    set({ object_sets: [...objectSets, card] as Analysis["object_sets"], canvases: nextCanvases });
    setShowObjectPicker(false);
  };
  const updateObjectSet = (cardId: string, patch: Partial<ObjectSetCardModel> | Partial<FunctionCardModel>) => set({ object_sets: objectSets.map((c) => (c.id === cardId ? { ...c, ...patch } : c)) as Analysis["object_sets"] });
  const addFunctionCard = () => {
    const card: FunctionCardModel = { id: `function-${crypto.randomUUID().slice(0, 8)}`, kind: "function", title: "Function", function_id: "", inputs: {} };
    const nextCanvases = canvases.length ? canvases.map((c) => c.id === currentCanvasId ? { ...c, cards: [...c.cards, card.id] } : c) : [{ id: currentCanvasId, name: "Canvas", cards: [card.id] }];
    set({ object_sets: [...objectSets, card as unknown as ObjectSetCardModel], canvases: nextCanvases });
  };
  /** overrides: a menu item that is one operation of a kind (Value at time is a series_op card …). */
  const addTableCard = (kind: QuiverTableCard["kind"], overrides?: Record<string, unknown>) => {
    const cid = nextId(CARD_ID_PREFIX[kind], [...objectSets.map((c) => c.id), ...a.logic.cards.map((c) => c.id)]);
    const first = [...tableCards.filter((c) => c.kind === "table").map((c) => ({ id: c.id, kind: "table" })), ...setCards.map((c) => ({ id: c.id, kind: "object_set" }))].pop();
    const series = a.logic.cards.filter((c) => !SCALAR_CARDS.includes(c.type)).map((c) => c.id);
    const card = { ...newTableCard(kind, cid, kind === "vega" || kind === "grouped_plot" ? tableCards.filter((c) => c.kind === "table").map((c) => ({ id: c.id, kind: "table" })).pop() : first, series), ...overrides } as QuiverTableCard;
    const nextCanvases = canvases.length ? canvases.map((c) => c.id === currentCanvasId ? { ...c, cards: [...c.cards, cid] } : c) : [{ id: currentCanvasId, name: "Canvas", cards: [cid] }];
    set({ object_sets: [...objectSets, card as unknown as ObjectSetCardModel] as Analysis["object_sets"], canvases: nextCanvases });
    setShowTablesMenu(false);
  };
  /** A click on a chart subscribed to a cross filter toggles that value in the chart's selection (null: clear it). */
  const crossSelect = (xfId: string, chartId: string, key: unknown) => {
    const xf = tableCards.find((c) => c.id === xfId);
    if (!xf || xf.kind !== "cross_filter") return;
    const cur = xf.selections?.[chartId] ?? [];
    const next = key === null ? [] : cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    updateObjectSet(xfId, { selections: { ...(xf.selections ?? {}), [chartId]: next } } as never);
  };
  const removeObjectSet = async (cardId: string) => {
    if (!(await confirmDialog("Remove this object set card from the analysis?"))) return;
    set({ object_sets: objectSets.filter((c) => c.id !== cardId), canvases: canvases.map((c) => ({ ...c, cards: c.cards.filter((x) => x !== cardId) })) });
  };
  const addTimeSeries = (type: TsObjectType) => {
    const id = nextCardId(a.logic);
    const property = type.default_property ?? type.properties[0]?.api_name ?? "";
    const card: Card = { id, type: "tsp", title: `${type.display_name} time series`, config: { property } };
    const nextLogic = { ...a.logic, cards: [...a.logic.cards, card], output: a.logic.output ?? id };
    const nextCanvases = canvases.length ? canvases.map((c) => c.id === currentCanvasId ? { ...c, cards: [...c.cards, id] } : c) : [{ id: currentCanvasId, name: "Canvas", cards: [id] }];
    let plotIndex = a.plots.length + 1;
    while (a.plots.some((plot) => plot.id === `plot-${plotIndex}`)) plotIndex += 1;
    const nextPlots = [...a.plots, { id: `plot-${plotIndex}`, title: `${type.display_name} time series`, cards: [id] }];
    set({ logic: nextLogic, root: a.root?.object_type_id === type.id ? a.root : { object_type_id: type.id, primary_key: "" }, canvases: nextCanvases, plots: nextPlots });
    setShowDataPicker(false);
  };
  const addCanvas = () => {
    const canvas = { id: `canvas-${Date.now().toString(36)}`, name: `Canvas ${canvases.length + 1}`, cards: [] };
    set({ canvases: [...canvases, canvas] });
    setActiveCanvasId(canvas.id);
  };
  const renameCanvas = (canvas: Canvas) => {
    const name = window.prompt("Rename canvas", canvas.name)?.trim();
    if (name) set({ canvases: canvases.map((c) => c.id === canvas.id ? { ...c, name } : c) });
  };
  const moveCard = (cardId: string, direction: -1 | 1) => {
    const cards = [...(activeCanvas?.cards ?? [])];
    const at = cards.indexOf(cardId);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= cards.length) return;
    [cards[at], cards[to]] = [cards[to], cards[at]];
    set({ canvases: canvases.map((c) => c.id === currentCanvasId ? { ...c, cards } : c) });
  };
  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareNote("Link copied. Access still follows your platform permissions.");
    } catch {
      setShareNote("Copy the current browser URL to share this analysis with a user who already has access.");
    }
  };
  const toDerived = (cid: string) => {
    const logic = upstream(a.logic, cid);
    const q = new URLSearchParams({ logic: JSON.stringify(logic) });
    if (a.root) { q.set("root", a.root.object_type_id); q.set("pk", a.root.primary_key); }
    router.push(`/time-series/derived/new?${q}`);
  };
  const filteredCards = a.logic.cards.filter((c) => `${c.id} ${c.title ?? ""} ${cardInfo(c.type).label}`.toLowerCase().includes(contentsQuery.toLowerCase()));
  const filteredObjects = objectSets.filter((c) => `${c.title} ${c.id}`.toLowerCase().includes(contentsQuery.toLowerCase()));
  const visiblePlots = a.plots.filter((p) => !p.cards.length || p.cards.some((cid) => visibleTimeSeriesIds.includes(cid)));

  return (
    <div className="quiver-shell flex min-h-0 flex-1 flex-col overflow-hidden">
      <AppHeader app="Quiver" icon="wave" href="/quiver" crumbs={[{ label: a.name }]}>
        <button type="button" onClick={copyShareLink} className={buttonClass.ghost}><Icon name="link" className="h-4 w-4" /> Share</button>
        <button type="button" onClick={async () => { if (!(await confirmDialog(`Delete the analysis ${a.name}?`))) return; await tsOntology.deleteAnalysis(a.id); router.push("/quiver"); }} className={buttonClass.ghost} aria-label="Delete analysis"><Icon name="trash" className="h-4 w-4" /></button>
        <button type="button" disabled={!dirty} onClick={save} className={buttonClass.primary}><Icon name="save" className="h-4 w-4" /> {dirty ? "Save" : "Saved"}</button>
      </AppHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
          <input aria-label="Analysis name" value={a.name} onChange={(e) => set({ name: e.target.value })} className="w-52 min-w-28 border-r border-line bg-transparent pr-3 text-sm font-semibold text-white outline-none" />
          <button type="button" onClick={() => { setShowDataPicker(!showDataPicker); setShowObjectPicker(false); }} className="rounded px-2.5 py-1.5 text-xs font-medium text-soft hover:bg-panel-2"><Icon name="plus" className="mr-1 inline h-3.5 w-3.5" />Add data</button>
          <button type="button" onClick={() => { setShowObjectPicker(!showObjectPicker); setShowDataPicker(false); }} className="rounded px-2.5 py-1.5 text-xs font-medium text-soft hover:bg-panel-2"><Icon name="cube" className="mr-1 inline h-3.5 w-3.5" />Objects</button>
          <button type="button" onClick={() => { setShowDataPicker(!showDataPicker); setShowObjectPicker(false); }} className="rounded px-2.5 py-1.5 text-xs font-medium text-soft hover:bg-panel-2"><Icon name="wave" className="mr-1 inline h-3.5 w-3.5" />Time Series</button>
          <div className="relative">
            <button type="button" onClick={() => setShowTablesMenu(!showTablesMenu)} className="rounded px-2.5 py-1.5 text-xs font-medium text-soft hover:bg-panel-2"><Icon name="table" className="mr-1 inline h-3.5 w-3.5" />Tables & charts</button>
            {showTablesMenu && <div className="absolute left-0 top-full z-40 mt-1 max-h-[70vh] w-60 overflow-y-auto rounded border border-line bg-panel p-1 text-xs shadow-xl">
              {([["table", "Transform table"], ["chart", "Chart (bar, line, pie, scatter, histogram, pivot…)"], ["value", "Value (numeric, string, date, boolean)"], ["cross_filter", "Cross filter (charts filter an object set and each other)"], ["grouped_plot", "Grouped time series plot (a table's time series column, one line per row)"], ["vega", "Vega plot"], ["action", "Action button (an Nexus action)"]] as [QuiverTableCard["kind"], string][]).map(([k, l]) => <button key={k} type="button" onClick={() => addTableCard(k)} className="block w-full rounded px-2 py-1.5 text-left hover:bg-panel-2">{l}</button>)}
              <div className="mt-1 border-t border-line px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Single cards</div>
              {([["numeric_agg", "Numeric aggregation (object set, table or array)"], ["column_values", "Column values (a column as an array)"], ["numeric_formula", "Numeric formula ($N1 / $N2 * 100)"], ["round", "Floor / ceiling"], ["date_diff", "Date difference"], ["date_part", "Date part (day of week, month …)"], ["correlation", "Correlation matrix"], ["waterfall", "Waterfall plot"]] as [QuiverTableCard["kind"], string][]).map(([k, l]) => <button key={k} type="button" onClick={() => addTableCard(k)} className="block w-full rounded px-2 py-1.5 text-left hover:bg-panel-2">{l}</button>)}
              <div className="mt-1 border-t border-line px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Strings, Booleans, arrays</div>
              {([["string_op", "String (concatenate, substring, find and replace, case, split, regex …)"], ["comparison", "Comparison (equal to, greater than, contains, before …)"], ["boolean_formula", "Boolean formula ($N1 > $N2 && !$B1)"], ["create_array", "Create array"], ["stepped_array", "Stepped array"], ["array_op", "Array (length, start, end, index, contains, join, sort, unique …)"], ["coalesce", "Coalesce (first non-empty value)"], ["range", "Range (numeric or date / time)"], ["range_op", "Range start / end (of a range card or range parameter)"]] as [QuiverTableCard["kind"], string][]).map(([k, l]) => <button key={k} type="button" onClick={() => addTableCard(k)} className="block w-full rounded px-2 py-1.5 text-left hover:bg-panel-2">{l}</button>)}
              {SINGLE_CARD_MENU.map((g) => <Fragment key={g.group}>
                <div className="mt-1 border-t border-line px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{g.group}</div>
                {g.items.map(([k, l, o]) => <button key={l} type="button" onClick={() => addTableCard(k, o)} className="block w-full rounded px-2 py-1.5 text-left hover:bg-panel-2">{l}</button>)}
              </Fragment>)}
            </div>}
          </div>
          <button type="button" onClick={() => { set({ view_mode: "canvas" }); setShowCardSearch(true); }} className="rounded px-2.5 py-1.5 text-xs font-medium text-soft hover:bg-panel-2"><Icon name="plus" className="mr-1 inline h-3.5 w-3.5" />Search cards</button>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded border border-line-2 bg-panel-2 p-0.5 text-xs">
              {(["canvas", "graph"] as const).map((v) => <button key={v} type="button" onClick={() => set({ view_mode: v })} className={`rounded px-2.5 py-1 capitalize ${viewMode === v ? "bg-panel font-medium text-blue-700 shadow-sm" : "text-muted hover:text-white"}`}>{v === "canvas" ? "▦ Canvas" : "⑂ Graph"}</button>)}
            </div>
            {mode === "dashboard" && (
              <>
                {a.published && (
                  <Link href={`/quiver/dashboards/${a.published.item_id}`} className="text-xs text-ocean hover:underline" title={`Published ${a.published.at}`}>
                    Published v{a.published.version}
                  </Link>
                )}
                <button type="button" onClick={() => (a.published ? void publish() : setPickPublish(true))} className="rounded bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                  {a.published ? "Publish new version" : "Publish"}
                </button>
              </>
            )}
            {pickPublish && (
              <DrivePicker
                title="Publish the dashboard into a folder (viewers need access to it)"
                canPick={() => "choose a folder"}
                folder={{ action: "Publish here", onPick: (fd) => { setPickPublish(false); void publish(fd.id); } }}
                onClose={() => setPickPublish(false)}
              />
            )}
            <button type="button" onClick={() => setMode(mode === "analysis" ? "dashboard" : "analysis")} className={`rounded px-2.5 py-1.5 text-xs ${mode === "dashboard" ? "bg-ocean/10 font-medium text-blue-700" : "text-soft hover:bg-panel-2"}`}><Icon name="device" className="mr-1 inline h-3.5 w-3.5" />{mode === "dashboard" ? "Exit dashboard" : "Dashboard"}</button>
          </div>
        </div>
        {shareNote && <div className="flex items-center justify-between border-b border-ocean/30 bg-ocean/10 px-4 py-1.5 text-xs text-ocean">{shareNote}<button onClick={() => setShareNote("")} aria-label="Dismiss"><Icon name="x" className="h-3 w-3" /></button></div>}
        <ErrorBox message={error} />
        {mode === "dashboard" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-panel-2 p-4">
          <div className="mx-auto max-w-7xl space-y-4">
              <DashboardConfig a={a} onChange={(dashboard) => set({ dashboard })} />
              {setCards.filter((card) => !a.dashboard.cards.length || a.dashboard.cards.includes(card.id)).map((card) => <ObjectSetDashboardCard key={card.id} card={card} type={objectTypes.find((t) => t.id === card.object_type_id)} resource={`quiver:${a.id}:dashboard:${card.id}`} />)}
              <QuiverDashboard key={JSON.stringify([a.root, a.range, a.dashboard])} analysis={a} />
              {preview.active && (
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span>Previewing your selections (not saved; a selector&apos;s default is set in the analysis).</span>
                  <SelectionsBar sel={preview} />
                </div>
              )}
              <ErrorBox message={preview.error} />
              {tableCards.some((c) => a.dashboard.cards.includes(c.id)) && (
                <div className="grid gap-3 md:grid-cols-2">{tableCards.filter((c) => a.dashboard.cards.includes(c.id)).map((c) => <TableCardDashboard key={c.id} card={preview.cardFor(c)} results={preview.results(tableResults)} onCrossSelect={crossSelect} onSelect={preview.select} />)}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel-2 py-2" aria-label="Quiver panels">
              {([ ["contents", "list", "Analysis contents"], ["parameters", "sliders", "Parameters"], ["dashboards", "device", "Dashboards"], ["functions", "code", "Visual functions"], ["settings", "sliders", "Settings"] ] as [Panel, "list" | "sliders" | "device" | "code", string][]).map(([panel, icon, title]) => <button key={panel} type="button" title={title} onClick={() => setActivePanel(panel)} className={`grid h-8 w-8 place-items-center rounded ${activePanel === panel ? "bg-ocean/15 text-blue-700" : "text-muted hover:bg-panel hover:text-white"}`}><Icon name={icon} className="h-4 w-4" /></button>)}
            </nav>
            <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
              {activePanel === "contents" && <>
                <div className="flex items-center justify-between border-b border-line px-3 py-2.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-soft">Analysis contents</span><button type="button" onClick={addCanvas} title="New canvas" className="rounded p-1 text-muted hover:bg-panel-2"><Icon name="plus" className="h-4 w-4" /></button></div>
                <div className="border-b border-line p-2"><input value={contentsQuery} onChange={(e) => setContentsQuery(e.target.value)} placeholder="Filter cards…" className="w-full rounded border border-line-2 bg-panel px-2 py-1.5 text-xs text-soft outline-none focus:border-blue-500" /></div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Canvases</div>
                  {canvases.map((canvas) => <button key={canvas.id} type="button" onClick={() => setActiveCanvasId(canvas.id)} onDoubleClick={() => renameCanvas(canvas)} className={`mb-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${canvas.id === currentCanvasId && viewMode === "canvas" ? "bg-ocean/10 font-medium text-blue-700" : "text-soft hover:bg-panel-2"}`}><span className="truncate">▦ {canvas.name}</span><span className="ml-2 text-[10px] text-muted">{canvas.cards.length}</span></button>)}
                  <div className="mb-1 mt-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Cards on {activeCanvas?.name ?? "canvas"}</div>
                  {activeIds.map((cid) => {
                    const tsCard = a.logic.cards.find((c) => c.id === cid);
                    const objCard = objectSets.find((c) => c.id === cid);
                    if ((!tsCard && !objCard) || !`${cid} ${tsCard?.title ?? objCard?.title ?? ""} ${tsCard ? cardInfo(tsCard.type).label : "Object set"}`.toLowerCase().includes(contentsQuery.toLowerCase())) return null;
                    const title = tsCard?.title || (tsCard ? cardInfo(tsCard.type).label : objCard?.title) || cid;
                    return <div key={cid} className="group mb-0.5 flex items-center gap-1 rounded hover:bg-panel-2"><button type="button" onClick={() => { setSelectedCardId(cid); document.getElementById(`quiver-card-${cid}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }} className="min-w-0 flex-1 truncate px-1.5 py-1.5 text-left text-[11px] text-soft"><span className="mr-1.5 rounded bg-panel-2 px-1 font-mono text-[10px] text-muted">${cid.replace(/^object-/, "O")}</span>{title}</button><button type="button" title="Move up" onClick={() => moveCard(cid, -1)} className="hidden p-1 text-muted group-hover:inline-flex"><Icon name="down" className="h-3 w-3 rotate-180" /></button><button type="button" title="Move down" onClick={() => moveCard(cid, 1)} className="hidden p-1 text-muted group-hover:inline-flex"><Icon name="down" className="h-3 w-3" /></button><button type="button" title="Remove from canvas" onClick={() => toggleCanvasCard(cid)} className="hidden p-1 text-muted group-hover:inline-flex"><Icon name="eye" className="h-3 w-3" /></button></div>;
                  })}
                  <div className="mb-1 mt-4 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Not on canvas</div>
                  {[...filteredCards.filter((c) => !activeIds.includes(c.id)).map((c) => ({ id: c.id, label: c.title || cardInfo(c.type).label })), ...filteredObjects.filter((c) => !activeIds.includes(c.id)).map((c) => ({ id: c.id, label: c.title }))].map((c) => <button key={c.id} type="button" onClick={() => toggleCanvasCard(c.id)} className="mb-0.5 block w-full truncate rounded px-2 py-1.5 text-left text-[11px] text-muted hover:bg-ocean/10 hover:text-blue-700"><Icon name="plus" className="mr-1 inline h-3 w-3" />{c.label}</button>)}
                  <button type="button" onClick={() => { set({ view_mode: "canvas" }); setShowCardSearch(true); }} className="mt-3 w-full rounded border border-dashed border-line-2 px-2 py-2 text-xs text-muted hover:border-blue-400 hover:text-blue-700"><Icon name="plus" className="mr-1 inline h-3.5 w-3.5" />Add card</button>
                </div>
              </>}
              {activePanel === "parameters" && <>
                <div className="flex items-center justify-between border-b border-line px-3 py-2.5"><span className="text-[11px] font-semibold uppercase tracking-wide text-soft">Parameters</span><button type="button" onClick={() => { set({ view_mode: "canvas" }); setShowCardSearch(true); }} className="rounded p-1 text-muted hover:bg-panel-2" title="Add parameter"><Icon name="plus" className="h-4 w-4" /></button></div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">{a.logic.cards.filter((c) => c.type.startsWith("param_")).map((c) => <ParameterCard key={c.id} card={c} onChange={(next) => changeLogic({ ...a.logic, cards: a.logic.cards.map((x) => x.id === c.id ? next : x) })} />)}{!a.logic.cards.some((c) => c.type.startsWith("param_")) && <p className="px-2 py-3 text-xs leading-5 text-muted">Add numeric, string, boolean, date/time, or range parameters from Search cards. Parameters are saved with the analysis.</p>}</div>
              </>}
              {activePanel === "dashboards" && <>
                <div className="border-b border-line px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-soft">Dashboards</div>
                <div className="space-y-2 p-3"><button type="button" onClick={() => setMode("dashboard")} className="w-full rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700">Open dashboard editor</button><p className="text-[11px] leading-5 text-muted">Choose plots and parameter inputs in dashboard settings, then preview the interactive dashboard. It can be embedded in Workshop.</p></div>
              </>}
              {activePanel === "functions" && <VisualFunctionsPanel logic={a.logic} />}
              {activePanel === "settings" && <>
                <div className="border-b border-line px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-soft">Analysis settings</div>
                <div className="space-y-3 p-3 text-xs"><label className="block text-soft">Default view<select value={viewMode} onChange={(e) => set({ view_mode: e.target.value as "canvas" | "graph" })} className="mt-1 w-full rounded border border-line-2 bg-panel px-2 py-1.5"><option value="canvas">Canvas</option><option value="graph">Graph</option></select></label><label className="block text-soft">Description<textarea value={a.description} onChange={(e) => set({ description: e.target.value })} rows={4} className="mt-1 w-full rounded border border-line-2 bg-panel px-2 py-1.5" /></label><p className="text-[10px] leading-4 text-muted">Canvas placement is organizational only and does not change calculation dependencies.</p></div>
              </>}
            </aside>
            <main className="flex min-w-0 flex-1 flex-col bg-ink">
              <div className="relative z-20 flex min-h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
                <span className="mr-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Add data</span>
                <button type="button" onClick={() => { setShowObjectPicker(!showObjectPicker); setShowDataPicker(false); }} className="rounded px-2 py-1.5 text-xs text-soft hover:bg-panel-2"><Icon name="cube" className="mr-1 inline h-3.5 w-3.5 text-blue-600" />Objects</button>
                <button type="button" onClick={addFunctionCard} className="rounded px-2 py-1.5 text-xs text-soft hover:bg-panel-2" title="A published function run on values and object set cards"><Icon name="code" className="mr-1 inline h-3.5 w-3.5 text-ocean" />Function</button>
                <button type="button" onClick={() => { setShowDataPicker(!showDataPicker); setShowObjectPicker(false); }} className="rounded px-2 py-1.5 text-xs text-soft hover:bg-panel-2"><Icon name="wave" className="mr-1 inline h-3.5 w-3.5 text-pink-600" />Time Series</button>
                <button type="button" onClick={() => { set({ view_mode: "canvas" }); setShowCardSearch(true); }} className="ml-2 rounded px-2 py-1.5 text-xs text-soft hover:bg-panel-2"><Icon name="search" className="mr-1 inline h-3.5 w-3.5" />Search cards</button>
                {a.logic.cards.some((c) => c.id === selectedCardId && !SCALAR_CARDS.includes(c.type)) && <button type="button" onClick={() => toDerived(selectedCardId)} className="rounded px-2 py-1.5 text-xs text-soft hover:bg-panel-2"><Icon name="layers" className="mr-1 inline h-3.5 w-3.5" />Save as derived series</button>}
                <span className="ml-auto text-[10px] text-muted">{a.logic.cards.length + objectSets.length} cards · {activeIds.length} on this canvas</span>
                {showDataPicker && <div className="absolute left-16 top-10 z-50 w-80 rounded border border-line bg-panel p-2 shadow-xl"><div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Time series sources</div>{types.map((t) => <button key={t.id} type="button" onClick={() => addTimeSeries(t)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-soft hover:bg-ocean/10"><Icon name="wave" className="h-3.5 w-3.5 text-pink-600" /><span className="min-w-0 flex-1 truncate">{t.display_name}</span><span className="text-[10px] text-muted">{t.properties.length} series</span></button>)}{!types.length && <p className="px-2 py-3 text-xs text-muted">No time-series-enabled object types found.</p>}</div>}
                {showObjectPicker && <div className="absolute left-0 top-10 z-50 max-h-[70vh] w-80 overflow-auto rounded border border-line bg-panel p-2 shadow-xl"><div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Add object set</div>{objectTypes.map((t) => <button key={t.id} type="button" onClick={() => addObjectSet(t)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-soft hover:bg-ocean/10"><Icon name="cube" className="h-3.5 w-3.5 text-blue-600" /><span className="min-w-0 flex-1 truncate">{t.display_name}</span><span className="text-[10px] text-muted">{t.object_count.toLocaleString()}</span></button>)}{!objectTypes.length && <p className="px-2 py-3 text-xs text-muted">No Nexus object types found.</p>}</div>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {viewMode === "graph" ? <GraphView cards={a.logic.cards} objectSets={setCards} selected={selectedCardId} onSelect={setSelectedCardId} onOpenCanvas={(cardId) => { if (!activeIds.includes(cardId)) toggleCanvasCard(cardId); set({ view_mode: "canvas" }); }} /> : (
                  <div className="mx-auto max-w-[1500px] space-y-3">
                    {!activeIds.length && <div className="grid min-h-[55vh] place-items-center rounded border border-dashed border-line-2 bg-panel text-center"><div className="max-w-md px-6"><div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-ocean/10 text-blue-700"><Icon name="wave" className="h-6 w-6" /></div><h2 className="text-lg font-semibold text-white">Visualize, analyze, and transform data</h2><p className="mt-2 text-sm leading-6 text-muted">Add Nexus objects or time series, build analysis cards, then organize the results on one or more canvases.</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => setShowObjectPicker(true)} className="rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700"><Icon name="plus" className="mr-1 inline h-3.5 w-3.5" />Add object set</button><button type="button" onClick={() => setShowDataPicker(true)} className="rounded border border-line-2 bg-panel px-3 py-2 text-xs text-soft hover:bg-panel-2">Add time series</button><button type="button" onClick={() => setShowCardSearch(true)} className="rounded border border-line-2 bg-panel px-3 py-2 text-xs text-soft hover:bg-panel-2">Search cards</button></div></div></div>}
                    {tableCards.filter((c) => activeIds.includes(c.id)).map((card) => (
                      <TableCardSection
                        key={card.id}
                        card={card}
                        results={tableResults}
                        refs={[...setCards.map((c) => ({ id: c.id, title: c.title, kind: "object_set", tsps: types.find((t) => t.id === c.object_type_id)?.properties.filter((p) => p.configured) })),...a.logic.cards.filter((c) => !SCALAR_CARDS.includes(c.type)).map((c) => ({ id: c.id, title: `${c.title || c.type} (time series)`, kind: "series" })), ...tableCards.map((c) => ({ id: c.id, title: c.title, kind: c.kind, source: "source" in c && c.source && "card" in c.source ? c.source.card : undefined }))]}
                        sources={{ datasets: datasets as never, object_types: [] }}
                        params={a.logic.cards.filter((c) => c.type.startsWith("param_")).map((c) => c.id)}
                        aid={a.id}
                        onChange={(patch) => updateObjectSet(card.id, patch as never)}
                        onRemove={() => removeObjectSet(card.id)}
                        onCrossSelect={crossSelect}
                      />
                    ))}
                    {visibleFnCards.map((card) => <FunctionCard key={card.id} card={card} sets={setCards} onChange={(patch) => updateObjectSet(card.id, patch)} onRemove={() => removeObjectSet(card.id)} />)}
                    {visibleObjectSets.map((card) => <ObjectSetCard key={card.id} card={card} type={objectTypes.find((t) => t.id === card.object_type_id)} resource={`quiver:${a.id}:object:${card.id}`} onChange={(patch) => updateObjectSet(card.id, patch)} onRemove={() => removeObjectSet(card.id)} />)}
                    {visiblePlots.map((p) => <section key={p.id} className="rounded border border-line bg-panel shadow-sm"><header className="flex items-center gap-2 border-b border-line px-3 py-2"><span className="cursor-grab text-muted">⠿</span><input value={p.title} onChange={(e) => set({ plots: a.plots.map((x) => x.id === p.id ? { ...x, title: e.target.value } : x) })} className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-soft outline-none" /><span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">Time series chart</span><button type="button" onClick={() => set({ plots: a.plots.filter((x) => x.id !== p.id) })} title="Remove chart" className="rounded p-1 text-muted hover:bg-panel-2"><Icon name="x" className="h-3.5 w-3.5" /></button></header><div className="p-3"><div className="mb-2 flex flex-wrap gap-1">{a.logic.cards.filter((c) => !SCALAR_CARDS.includes(c.type)).map((c) => { const on = p.cards.includes(c.id); return <button key={c.id} type="button" onClick={() => set({ plots: a.plots.map((x) => x.id === p.id ? { ...x, cards: on ? x.cards.filter((y) => y !== c.id) : [...x.cards, c.id] } : x) })} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${on ? "bg-ocean/15 text-ocean" : "bg-panel-2 text-muted"}`}>${c.id}</button>; })}<button type="button" onClick={() => set({ plots: [...a.plots, { id: `plot-${Date.now().toString(36)}`, title: `Plot ${a.plots.length + 1}`, cards: [] }] })} className="rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-panel-2"><Icon name="plus" className="mr-1 inline h-3 w-3" />Add plot</button></div><Plot ids={p.cards} results={results} logic={a.logic} height={210} /></div></section>)}
                    <div><LogicEditor logic={a.logic} onChange={changeLogic} mode="quiver" rootTypeId={a.root?.object_type_id ?? null} root={a.root?.primary_key ? a.root : null} onRoot={(r) => set({ root: r ?? (a.root ? { ...a.root, primary_key: "" } : null) })} range={a.range} onRange={(range) => set({ range })} resource={`quiver:${a.id}`} showOutput={false} onResults={setResults} visibleCardIds={visibleTimeSeriesIds} openCardPicker={showCardSearch} onCloseCardPicker={() => setShowCardSearch(false)} /></div>
                  </div>
                )}
              </div>
              {viewMode === "canvas" && <div className="flex h-9 shrink-0 items-center gap-1 border-t border-line bg-panel px-2">{canvases.map((canvas) => <button key={canvas.id} type="button" onClick={() => setActiveCanvasId(canvas.id)} onDoubleClick={() => renameCanvas(canvas)} className={`max-w-48 truncate rounded px-3 py-1 text-xs ${canvas.id === currentCanvasId ? "bg-panel-2 font-medium text-soft" : "text-muted hover:bg-panel-2"}`}>{canvas.name}</button>)}<button type="button" onClick={addCanvas} title="New canvas" className="rounded px-2 py-1 text-muted hover:bg-panel-2"><Icon name="plus" className="h-3.5 w-3.5" /></button><span className="ml-auto text-[10px] text-muted">Double-click a canvas tab to rename</span></div>}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

function ParameterCard({ card, onChange }: { card: Card; onChange: (card: Card) => void }) {
  const config = card.config as Record<string, unknown>;
  const setValue = (value: unknown) => onChange({ ...card, config: { ...config, value } });
  return <div className="rounded border border-line bg-panel p-2"><div className="mb-1 flex items-center gap-1.5"><span className="rounded bg-bad/15 px-1 font-mono text-[10px] text-pink-700">${card.id}</span><span className="truncate text-[11px] font-medium text-soft">{card.title || cardInfo(card.type).label}</span></div>{card.type === "param_boolean" ? <label className="flex items-center gap-2 text-xs text-soft"><input type="checkbox" checked={Boolean(config.value)} onChange={(e) => setValue(e.target.checked)} />Enabled</label> : card.type === "param_range" ? <div className="space-y-1">{(["start", "end"] as const).map((k) => <label key={k} className="flex items-center gap-1.5 text-[10px] text-muted"><span className="w-7">{k === "start" ? "Start" : "End"}</span><input type="datetime-local" value={String(config[k] ?? "").slice(0, 16)} onChange={(e) => onChange({ ...card, config: { ...config, [k]: e.target.value } })} className="min-w-0 flex-1 rounded border border-line-2 px-2 py-1 text-xs text-soft" aria-label={`${card.title || "Range"} ${k}`} /></label>)}</div> : <input type={card.type === "param_number" ? "number" : card.type === "param_datetime" ? "datetime-local" : "text"} value={String(config.value ?? "")} onChange={(e) => setValue(card.type === "param_number" ? Number(e.target.value) : e.target.value)} placeholder={String(config.placeholder ?? "Enter value")} className="w-full rounded border border-line-2 px-2 py-1 text-xs text-soft" />}<div className="mt-1 text-[10px] text-muted">Parameter card · {card.type.replace("param_", "")}</div></div>;
}

function ObjectSetDashboardCard({ card, type, resource }: { card: ObjectSetCardModel; type?: ObjectType; resource: string }) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");
  const spec = useMemo(() => ({ object_type_id: card.object_type_id, q: card.query, filters: card.filters, limit: 100, offset: 0, resource, aggregate: card.visualization === "chart" && card.group_by ? { metric: card.metric, property: card.metric === "count" ? null : card.measure, group_by: card.group_by } : null }), [card, resource]);
  useEffect(() => { om.search(spec).then(setResult, (e: Error) => setError(e.message)); }, [spec]);
  const props = type?.properties ?? result?.result_type.properties ?? [];
  const groups = result?.aggregation?.groups ?? [];
  const max = Math.max(1, ...groups.map((g) => Number(g.value ?? 0)));
  return <section className="rounded border border-line bg-panel p-3 shadow-sm"><header className="mb-2 flex items-center gap-2 border-b border-line pb-2"><Icon name="cube" className="h-3.5 w-3.5 text-blue-600" /><span className="text-xs font-semibold text-soft">{card.title}</span><span className="ml-auto text-[10px] text-muted">{type?.display_name ?? "Object set"} · {result?.total.toLocaleString() ?? "…"} objects</span></header>{error ? <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{error}</p> : card.visualization === "chart" && card.group_by ? <div className="space-y-1.5">{groups.slice(0, 12).map((g) => <div key={g.group} className="grid grid-cols-[minmax(5rem,1fr)_3fr_3rem] items-center gap-2 text-[10px]"><span className="truncate text-soft">{g.group || "(empty)"}</span><span className="h-2 overflow-hidden rounded bg-panel-2"><span className="block h-full rounded bg-blue-500" style={{ width: `${Math.max(1, Number(g.value ?? 0) / max * 100)}%` }} /></span><span className="text-right tabular-nums text-muted">{String(g.value ?? "—")}</span></div>)}</div> : <div className="max-h-64 overflow-auto"><table className="w-full border-collapse text-left text-[10px]"><thead className="sticky top-0 bg-panel-2 text-muted"><tr><th className="border-b border-line px-2 py-1">Object</th>{props.slice(0, 5).map((p) => <th key={p.api_name} className="border-b border-line px-2 py-1">{p.display_name || p.api_name}</th>)}</tr></thead><tbody>{(result?.objects ?? []).slice(0, 100).map((o) => <tr key={o.primary_key}><td className="border-b border-line px-2 py-1 text-blue-700">{o.title || o.primary_key}</td>{props.slice(0, 5).map((p) => <td key={p.api_name} className="max-w-44 truncate border-b border-line px-2 py-1 text-soft">{displayValue(o.properties[p.api_name])}</td>)}</tr>)}</tbody></table></div>}</section>;
}

function ObjectSetCard({ card, type, resource, onChange, onRemove }: { card: ObjectSetCardModel; type?: ObjectType; resource: string; onChange: (patch: Partial<ObjectSetCardModel>) => void; onRemove: () => void }) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const spec = useMemo(() => ({ object_type_id: card.object_type_id, q: card.query, filters: card.filters, limit: 100, offset: 0, histograms: false, resource, aggregate: card.visualization === "chart" && card.group_by ? { metric: card.metric, property: card.metric === "count" ? null : card.measure, group_by: card.group_by } : null }), [card, resource]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setBusy(true);
      om.search(spec).then((value) => { setResult(value); setError(""); }, (e: Error) => setError(e.message)).finally(() => setBusy(false));
      capture({ object_type_id: spec.object_type_id, q: spec.q || undefined });
    }, 250);
    return () => clearTimeout(timer);
  }, [spec]);
  const props = type?.properties ?? result?.result_type.properties ?? [];
  const groupable = props.filter((p) => !["struct", "vector", "geoshape", "media", "timeseries"].includes(p.type));
  const groups = result?.aggregation?.groups ?? [];
  const max = Math.max(1, ...groups.map((g) => Number(g.value ?? 0)));
  return <section id={`quiver-card-${card.id}`} className="rounded border border-line bg-panel shadow-sm"><header className="flex items-center gap-2 border-b border-line px-3 py-2"><span className="cursor-grab text-muted">⠿</span><span className="rounded bg-ocean/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-700">${card.id.replace(/^object-/, "O")}</span><Icon name="cube" className="h-3.5 w-3.5 text-blue-600" /><input value={card.title} onChange={(e) => onChange({ title: e.target.value })} className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-soft outline-none" /><span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">Object set</span><button type="button" onClick={onRemove} title="Delete object set card" className="rounded p-1 text-muted hover:bg-bad/10 hover:text-red-600"><Icon name="trash" className="h-3.5 w-3.5" /></button></header><div className="grid gap-3 p-3 lg:grid-cols-[minmax(14rem,20rem)_1fr]"><div className="space-y-2"><div className="text-[10px] font-medium uppercase tracking-wide text-muted">{type?.display_name ?? "Nexus object type"}</div><input value={card.query} onChange={(e) => onChange({ query: e.target.value })} placeholder="Search objects…" className="w-full rounded border border-line-2 px-2 py-1.5 text-xs text-soft outline-none focus:border-blue-500" /><div className="space-y-1">{card.filters.map((f, i) => <div key={`${card.id}-${i}`} className="grid grid-cols-[1fr_100px_1fr_24px] gap-1"><select value={f.property} onChange={(e) => onChange({ filters: card.filters.map((x, j) => j === i ? { ...x, property: e.target.value } : x) })} className="min-w-0 rounded border border-line-2 px-1 py-1 text-[10px]">{props.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}</select><select value={f.op} onChange={(e) => onChange({ filters: card.filters.map((x, j) => j === i ? { ...x, op: e.target.value as Filter["op"] } : x) })} className="rounded border border-line-2 px-1 py-1 text-[10px]">{FILTER_OPS.map((op) => <option key={op.id} value={op.id}>{op.label}</option>)}</select>{!["is_null", "not_null"].includes(f.op) && <input value={String(f.value ?? "")} onChange={(e) => onChange({ filters: card.filters.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} className="min-w-0 rounded border border-line-2 px-1.5 py-1 text-[10px]" placeholder="Value" />}<button type="button" onClick={() => onChange({ filters: card.filters.filter((_, j) => j !== i) })} className="text-muted hover:text-red-600"><Icon name="x" className="h-3 w-3" /></button></div>)}</div><button type="button" onClick={() => onChange({ filters: [...card.filters, { property: props[0]?.api_name ?? "", op: "eq", value: "" }] })} className="rounded border border-dashed border-line-2 px-2 py-1 text-[10px] text-soft hover:border-blue-400"><Icon name="plus" className="mr-1 inline h-3 w-3" />Add filter</button><div className="flex gap-1 border-t border-line pt-2"><button type="button" onClick={() => onChange({ visualization: "table" })} className={`rounded px-2 py-1 text-[10px] ${card.visualization === "table" ? "bg-ocean/10 text-blue-700" : "text-muted"}`}>Table</button><button type="button" onClick={() => onChange({ visualization: "chart" })} className={`rounded px-2 py-1 text-[10px] ${card.visualization === "chart" ? "bg-ocean/10 text-blue-700" : "text-muted"}`}>Chart</button>{card.visualization === "chart" && <select value={card.group_by ?? ""} onChange={(e) => onChange({ group_by: e.target.value || null })} className="min-w-0 flex-1 rounded border border-line-2 px-1 py-1 text-[10px]"><option value="">Group by…</option>{groupable.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}</select>}</div>{card.visualization === "chart" && card.group_by && <><select value={card.metric} onChange={(e) => { const metric = e.target.value as ObjectSetCardModel["metric"]; const numeric = props.filter((p) => ["integer", "long", "short", "double", "float", "decimal"].includes(p.type)); onChange({ metric, measure: metric === "count" ? null : card.measure ?? numeric[0]?.api_name ?? null }); }} className="w-full rounded border border-line-2 px-2 py-1 text-[10px]"><option value="count">Count</option><option value="sum">Sum</option><option value="avg">Average</option></select>{card.metric !== "count" && <select value={card.measure ?? ""} onChange={(e) => onChange({ measure: e.target.value || null })} className="w-full rounded border border-line-2 px-2 py-1 text-[10px]"><option value="">Choose numeric measure…</option>{props.filter((p) => ["integer", "long", "short", "double", "float", "decimal"].includes(p.type)).map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name || p.api_name}</option>)}</select>}</>}</div><div className="min-w-0 rounded border border-line bg-panel p-2"><div className="mb-2 flex items-center justify-between text-[10px] text-muted"><span>{busy ? "Querying…" : error ? "Query failed" : `${(result?.total ?? 0).toLocaleString()} objects`}</span><Link href={`/object-explorer?object_type_id=${encodeURIComponent(card.object_type_id)}`} className="text-blue-700 hover:underline">Open in Object Explorer</Link></div>{error ? <p className="rounded bg-bad/10 p-2 text-xs text-red-700">{error}</p> : card.visualization === "chart" && card.group_by ? <div className="space-y-1.5">{groups.slice(0, 12).map((g) => <div key={g.group} className="grid grid-cols-[minmax(5rem,1fr)_3fr_3rem] items-center gap-2 text-[10px]"><span className="truncate text-soft" title={g.group}>{g.group || "(empty)"}</span><span className="h-2 overflow-hidden rounded bg-panel-2"><span className="block h-full rounded bg-blue-500" style={{ width: `${Math.max(1, Number(g.value ?? 0) / max * 100)}%` }} /></span><span className="text-right tabular-nums text-muted">{String(g.value ?? "—")}</span></div>)}{!groups.length && <div className="py-10 text-center text-xs text-muted">Choose a group-by property to build the chart.</div>}</div> : <div className="max-h-72 overflow-auto"><table className="w-full border-collapse text-left text-[10px]"><thead className="sticky top-0 bg-panel-2 text-muted"><tr><th className="border-b border-line px-2 py-1">Object</th>{props.slice(0, 5).map((p) => <th key={p.api_name} className="border-b border-line px-2 py-1">{p.display_name || p.api_name}</th>)}</tr></thead><tbody>{(result?.objects ?? []).slice(0, 100).map((o) => <tr key={o.primary_key} className="hover:bg-ocean/10"><td className="border-b border-line px-2 py-1"><Link href={`/ontology/objects/${o.object_type_id}/${encodeURIComponent(o.primary_key)}`} className="text-blue-700 hover:underline">{o.title || o.primary_key}</Link></td>{props.slice(0, 5).map((p) => <td key={p.api_name} className="max-w-44 truncate border-b border-line px-2 py-1 text-soft">{displayValue(o.properties[p.api_name])}</td>)}</tr>)}</tbody></table>{result && result.total > 100 && <div className="py-2 text-center text-[10px] text-muted">Showing first 100 of {result.total.toLocaleString()} objects</div>}</div>}</div></div></section>;
}
function displayValue(value: unknown) { if (value === null || value === undefined || value === "") return "—"; if (Array.isArray(value) && !value.length) return "—"; return cellText(value); } // arrays "a, b", structs "field: value"

type GraphNode = { id: string; title: string; type: string; dependencies: string[]; objectSet?: boolean };
function dependencies(card: Card, ids: Set<string>) {
  const cfg = card.config as Record<string, unknown>;
  const found = new Set<string>();
  for (const key of ["input", "at_card", "datetime_card", "time_card", "start", "end"]) if (typeof cfg[key] === "string" && ids.has(cfg[key] as string)) found.add(cfg[key] as string);
  for (const key of ["inputs", "segments"]) for (const id of (cfg[key] as string[] | undefined) ?? []) if (ids.has(id)) found.add(id);
  for (const key of ["formula", "condition", "recovery", "expression"]) for (const match of String(cfg[key] ?? "").matchAll(/\$([A-Z][A-Z0-9]*)/g)) if (ids.has(match[1])) found.add(match[1]);
  return [...found];
}
function GraphView({ cards, objectSets, selected, onSelect, onOpenCanvas }: { cards: Card[]; objectSets: ObjectSetCardModel[]; selected: string; onSelect: (id: string) => void; onOpenCanvas: (id: string) => void }) {
  const nodes = useMemo<GraphNode[]>(() => [...objectSets.map((c) => ({ id: c.id, title: c.title, type: "Object set", dependencies: [], objectSet: true })), ...cards.map((c) => ({ id: c.id, title: c.title || cardInfo(c.type).label, type: cardInfo(c.type).label, dependencies: dependencies(c, new Set(cards.map((x) => x.id))) }))], [cards, objectSets]);
  const positions = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const depth = (id: string, seen = new Set<string>()): number => { if (seen.has(id)) return 0; const nextSeen = new Set(seen).add(id); const n = byId.get(id); return n?.dependencies.length ? Math.max(...n.dependencies.map((dep) => depth(dep, nextSeen))) + 1 : 0; };
    const buckets = new Map<number, GraphNode[]>();
    for (const n of nodes) { const d = depth(n.id); buckets.set(d, [...(buckets.get(d) ?? []), n]); }
    const coords = new Map<string, { x: number; y: number; depth: number }>();
    for (const [d, group] of buckets) group.forEach((n, i) => coords.set(n.id, { x: 30 + d * 260, y: 28 + i * 112, depth: d }));
    return { coords, width: Math.max(760, 80 + (Math.max(0, ...buckets.keys()) + 1) * 260), height: Math.max(300, ...[...buckets.values()].map((x) => x.length * 112 + 60)) };
  }, [nodes]);
  if (!nodes.length) return <div className="grid min-h-[55vh] place-items-center rounded border border-dashed border-line-2 bg-panel text-center text-sm text-muted">Add data or cards to see their dependency graph.</div>;
  return <div className="flex min-h-full flex-col overflow-hidden rounded border border-line bg-line shadow-sm"><div className="flex items-center gap-2 border-b border-line-2 bg-panel px-3 py-2 text-xs text-soft"><span className="font-medium">Analysis graph</span><span className="text-muted">Left to right · {nodes.length} nodes</span><span className="ml-auto">Select a node to inspect it; double-click to open on canvas.</span></div><div className="min-h-[420px] flex-1 overflow-auto"><div className="relative" style={{ width: positions.width, height: positions.height }}><svg className="pointer-events-none absolute inset-0" width={positions.width} height={positions.height}>{nodes.flatMap((n) => n.dependencies.map((dep) => { const from = positions.coords.get(dep); const to = positions.coords.get(n.id); if (!from || !to) return null; const x1 = from.x + 208; const y1 = from.y + 38; const x2 = to.x; const y2 = to.y + 38; return <path style={{ stroke: "var(--color-muted)" }} key={`${dep}-${n.id}`} d={`M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}`} fill="none"  strokeWidth="1.5" markerEnd="url(#quiver-arrow)" />; }))}<defs><marker id="quiver-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path style={{ fill: "var(--color-muted)" }} d="M0,0 L8,4 L0,8 z"  /></marker></defs></svg>{nodes.map((n) => { const p = positions.coords.get(n.id)!; return <button key={n.id} type="button" onClick={() => onSelect(n.id)} onDoubleClick={() => onOpenCanvas(n.id)} className={`absolute flex h-[76px] w-[210px] flex-col justify-center rounded border bg-panel px-3 text-left shadow-sm transition hover:shadow ${selected === n.id ? "border-blue-500 ring-2 ring-blue-200" : "border-line-2"}`} style={{ left: p.x, top: p.y }}><span className="flex items-center gap-1.5"><span className={`rounded px-1 font-mono text-[10px] ${n.objectSet ? "bg-ocean/15 text-blue-700" : "bg-panel-2 text-soft"}`}>${n.id.replace(/^object-/, "O")}</span><span className="truncate text-xs font-semibold text-white">{n.title}</span></span><span className="mt-1 text-[10px] text-muted">{n.type}{n.dependencies.length ? ` · input ${n.dependencies.map((x) => `$${x}`).join(", ")}` : " · source"}</span><span className="absolute right-2 top-2 text-muted">•••</span></button>; })}</div></div></div>;
}

function DashboardConfig({ a, onChange }: { a: Analysis; onChange: (d: Analysis["dashboard"]) => void }) {
  const d = a.dashboard;
  const toggle = (list: string[], id: string) => list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const cardOptions = [...a.plots.map((p) => [p.id, p.title] as const), ...a.logic.cards.map((c) => [c.id, `$${c.id} ${c.title || cardInfo(c.type).label}`] as const), ...(a.object_sets ?? []).map((c) => [c.id, `${isTableCard(c) ? CARD_KIND_LABEL[(c as unknown as QuiverTableCard).kind] : "Object set"} · ${c.title}`] as const)];
  return (
    <details className="rounded border border-line bg-panel p-3 text-sm shadow-sm">
      <summary className="cursor-pointer font-medium text-soft">Dashboard settings</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-muted">Content (empty selection shows every plot)</div>
          <div className="flex flex-wrap gap-1">
            {cardOptions.map(([id, label]) => (
              <button key={id} type="button" onClick={() => onChange({ ...d, cards: toggle(d.cards, id) })} className={`rounded px-2 py-1 text-[11px] ${d.cards.includes(id) ? "bg-ocean/15 text-ocean" : "bg-panel-2 text-soft"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted">Viewer and Workshop inputs</div>
          <div className="flex flex-wrap gap-1">
            {a.logic.cards.filter((c) => c.type.startsWith("param_")).map((c) => (
              <button key={c.id} type="button" onClick={() => onChange({ ...d, inputs: toggle(d.inputs, c.id) })} className={`rounded px-2 py-1 text-[11px] ${d.inputs.includes(c.id) ? "bg-ocean/15 text-ocean" : "bg-panel-2 text-soft"}`}>
                ${c.id} {c.title || cardInfo(c.type).label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

/** Visual functions: save a card and what it depends on as reusable logic, its chosen cards as inputs. */
function VisualFunctionsPanel({ logic }: { logic: Analysis["logic"] }) {
  const [list, setList] = useState<VisualFunction[]>([]);
  const [output, setOutput] = useState("");
  const [inputs, setInputs] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const load = () => tsOntology.visualFunctions().then(setList, () => setList([]));
  useEffect(() => {
    void load();
  }, []);
  const ups = output ? upstreamIds(logic, output).filter((id) => id !== output) : [];
  return (
    <>
      <div className="border-b border-line px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-soft">Visual functions</div>
      <div className="space-y-2 p-3 text-xs">
        <select value={output} onChange={(e) => (setOutput(e.target.value), setInputs([]))} className="w-full rounded border border-line-2 bg-panel px-2 py-1.5">
          <option value="">Output card…</option>
          {logic.cards.map((c) => <option key={c.id} value={c.id}>${c.id} {c.title || c.type}</option>)}
        </select>
        {ups.length > 0 && <div className="text-[11px] text-muted">Inputs (what users of the function set)</div>}
        {ups.map((id) => (
          <label key={id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={inputs.includes(id)} onChange={(e) => setInputs(e.target.checked ? [...inputs, id] : inputs.filter((x) => x !== id))} />${id} {logic.cards.find((c) => c.id === id)?.type}
          </label>
        ))}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Function name" className="w-full rounded border border-line-2 bg-panel px-2 py-1.5" />
        <button
          type="button"
          disabled={!output || !name.trim()}
          onClick={() => tsOntology.createVisualFunction({ name, logic, output, inputs: inputs.map((card) => ({ card })) }).then(() => (setNote(`Saved "${name}"`), setName(""), void load()), (e: Error) => setNote(e.message))}
          className="w-full rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Save as visual function
        </button>
        {note && <p className="text-[11px] text-muted">{note}</p>}
        <div className="pt-2 text-[11px] font-semibold text-soft">Library</div>
        {list.map((f) => (
          <div key={f.id} className="flex items-center gap-1">
            <span className="flex-1 truncate" title={f.description}>{f.name} <span className="text-muted">({f.inputs.length} inputs)</span></span>
            <button type="button" onClick={() => tsOntology.deleteVisualFunction(f.id).then(load)} className="text-muted hover:text-bad" aria-label="Delete function"><Icon name="x" className="h-3 w-3" /></button>
          </div>
        ))}
        {list.length === 0 && <p className="text-[11px] text-muted">No visual functions yet. Add one to an analysis with the Visual function card.</p>}
      </div>
    </>
  );
}

/** The cards a card depends on (itself included), following $ references and inputs. */
function upstreamIds(logic: Analysis["logic"], id: string): string[] {
  const by = Object.fromEntries(logic.cards.map((c) => [c.id, c]));
  const need = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const cid = todo.pop()!;
    if (need.has(cid) || !by[cid]) continue;
    need.add(cid);
    const cfg = by[cid].config as Record<string, unknown>;
    for (const k of ["input", "segments", "at_card", "datetime_card"]) if (typeof cfg[k] === "string") todo.push(cfg[k] as string);
    for (const r of (cfg.inputs as string[] | undefined) ?? []) todo.push(r);
    for (const k of ["formula", "condition", "recovery", "value", "expr"]) for (const m of String(cfg[k] ?? "").matchAll(/\$([A-Z][A-Z0-9]*)/g)) todo.push(m[1]);
  }
  return logic.cards.filter((c) => need.has(c.id)).map((c) => c.id);
}
