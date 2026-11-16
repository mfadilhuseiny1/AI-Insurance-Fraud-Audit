"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { API_URL, driveContentUrl, uploadDriveFile } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { AggregationView } from "@/components/functions/parts";
import { MediaPreview } from "@/components/media/MediaPreview";
import { ValueCell } from "@/components/ontology/parts";
import { ActionForm as ActionDialog } from "@/components/ontology/ActionForm";
import { functions as fnRegistry, type FnResult } from "@/lib/actions";
import { mediaSets, type MediaSchema } from "@/lib/mediaSets";
import { timed } from "@/lib/workshopProfiler";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import {
  filterSets, fillVars, fmt, fmtWith, METRIC_LABEL, objectInputValue, resolveVar, ruleFor, sourceKey, workshop, type Filter, type InterfaceActionOptions, type InterfaceActionResolution, type ModuleDerived, type QueryBody, type QueryResult, type Widget, type WsEvent } from "@/lib/workshop";
import { BarChart, LineChart, PieChart } from "./Charts";
import { CustomWidgetHost } from "./CustomWidgetHost";
import { DerivedWidget, QuiverWidget, TsChartWidget, TsMetricWidget } from "./TsWidgets";
import {
  ButtonGroupWidget,
  EmbeddedModuleWidget,
  IframeWidget,
  InputWidget,
  LoopWidget,
  SectionWidget,
  LinkedObjectsWidget,
  ObjectDropdownWidget,
  ObjectListWidget,
  PivotWidget,
  PropertyListWidget,
  SecurityMarkings,
  StringSelectorWidget,
  TabsWidget,
  UserSelectWidget,
} from "./WorkshopWidgets";
import { GanttWidget, MapWidget, ObjectSetTitleWidget, StepperWidget, TimelineWidget, VegaWidget } from "./VizWidgets";
import { AipChatbotWidget, AipContentWidget, CommentsWidget, InlineActionWidget } from "./AipWidgets";
import { DataFreshnessWidget } from "./ModuleSettings";
import { AppPairingWidget, dragObjects } from "./CrossApp";
import { NotepadEmbedWidget, NotepadExportWidget, NotepadLinkedWidget, NotepadNewWidget } from "./NotepadWidgets";
import { MachineryWidget, VertexGraphWidget } from "./GraphWidgets";
import { SchedulingCalendarWidget, SchedulingGanttWidget } from "./SchedulingWidgets";
import { ProgramSchedulingWidget } from "./ProgramScheduling";
import { ProposalReviewerWidget, RuleEditorWidget } from "./RulesWidgets";
import { VulcanWidget } from "./VulcanWidget";
import { FormEmbedWidget } from "./FormWidgets";
import { CurrentLocationWidget, QrReaderWidget } from "./MobileWidgets";
import { TsCell, useTsColumns, useTsDomains } from "./TsFormatting";
import { ScenarioManagerWidget, ScenarioSelectorWidget, ScenarioSummaryWidget, useScenarios } from "./ScenarioWidgets";
import { ExplorationWidget, FilterListWidget, ProminentTermsWidget } from "./FilterWidgets";
import { AnalystWidget, FreeformWidget, ObservabilityWidget, PdfViewerWidget, VideoWidget } from "./MediaWidgets";
import { ExtraParameters, ImageAnnotationView, typed } from "./ImageAnnotation";
import { ActionLogWidget, EditHistoryWidget, LinkedResourcesWidget, MarkdownWidget, MediaUploaderWidget, ObjectViewWidget, ResourceListWidget } from "./ObjectWidgets";

/** What widgets share in a module: filters and the selected object, per source. */
export type ModuleState = {
  filters: Record<string, Record<string, unknown>>;
  setFilter: (source: string, column: string, value: unknown) => void;
  selection: Record<string, string | undefined>;
  select: (source: string, pk: string | undefined) => void;
  /** module variables: function outputs written by function widgets, read as "$var:name" inputs, filter values and {{name}} in text */
  variables: Record<string, unknown>;
  setVariable: (name: string, value: unknown) => void;
  /** bumped after an action, so every widget reloads */
  version: number;
  /** the module: time series queries are metered against it */
  moduleId?: string;
  bump: () => void;
  /** layout (ModuleRuntime.tsx): the open tab of each tabs widget, the page, overlays, nested grids and events */
  tabs?: Record<string, string>;
  setTab?: (widget: string, tab: string) => void;
  page?: string;
  goPage?: (page: string) => void;
  openOverlay?: (id: string) => void;
  closeOverlay?: () => void;
  renderContainer?: (key: string) => React.ReactNode;
  runEvents?: (events: WsEvent[]) => Promise<void>;
  /** module-level derived properties (column math), added to queries on their object type */
  derived?: ModuleDerived[];
  /** collapsed state of collapsible sections, set by their chevron and by section events */
  sections?: Record<string, boolean>;
  setSection?: (id: string, collapsed: boolean) => void;
  /** translations: a module string in the viewer's (or the previewed) language */
  tr?: (s: string) => string;
  /** kiosk mode: no Ontology writes (actions, comments) */
  readOnly?: boolean;
  /** auto-refresh: whether updates apply (undefined: auto-refresh off) */
  autoRefresh?: boolean;
  /** each variable's type (drop zones write the shape their variable needs) */
  variableTypes?: Record<string, string>;
  /** display optimization: containers whose widgets stay mounted while hidden (never: once visited; eager: always) */
  keep?: { never: Set<string>; eager: Set<string> };
  /** a mobile module: grids show as one column of widgets in order */
  mobile?: boolean;
};

/** The module-state filter key a semantic search box sets on its object type source. */
const SEMANTIC = "__semantic";

function useQuery(widget: Widget, state: ModuleState, ownFilter = false) {
  const c = widget.config;
  const key = sourceKey(c.source);
  const filters: Filter[] = useMemo(
    () => (c.filters ?? []).map((f) => ({ ...f, value: resolveVar(f.value, state.variables) })),
    [c.filters, state.variables],
  );
  const additionalFilters: Filter[] = useMemo(
    () =>
      Object.entries(state.filters[key] ?? {})
          .filter(([col, v]) => col !== SEMANTIC && v !== undefined && v !== "" && !(ownFilter && col === c.column))
          .map(([column, value]) => ({ column, op: "eq" as const, value })),
    [state.filters, key, ownFilter, c.column],
  );
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const semantic = (state.filters[key] ?? {})[SEMANTIC] as QueryBody["semantic"] | undefined;
  const sets = useMemo(() => filterSets(c, state.variables), [c, state.variables]);
  // scenarios [Legacy]: the data as it is in a scenario; a table also loads the scenarios it compares against
  const scenarioId = c.scenario_variable ? String(state.variables[c.scenario_variable] ?? "") || undefined : undefined;
  const compareIds = widget.type === "table" && c.scenario_compare ? (Array.isArray(state.variables[c.scenario_compare]) ? (state.variables[c.scenario_compare] as unknown[]).map(String).filter(Boolean) : []) : [];
  const [compare, setCompare] = useState<{ scenario: string; result: QueryResult }[]>([]);
  const spec = JSON.stringify({ c, filters, additionalFilters, semantic, v: state.version, t: widget.type, sets, scenarioId, compareIds });
  useEffect(() => {
    if (!c.source) return;
    let stale = false;
    const grouped = widget.type === "bar" || widget.type === "pie" || widget.type === "line" || widget.type === "filter";
    const body: QueryBody = {
        source: c.source,
        filters,
        filter_mode: c.filter_mode,
        additional_filters: additionalFilters,
        filter_sets: sets,
        join: c.join,
        derived: [
          ...(c.derived ?? []),
          ...(state.derived ?? [])
            .filter((d) => c.source?.kind === "object_type" && d.object_type_id === c.source.id && d.name && d.column)
            .map((d) => ({ name: d.name, op: d.op, column: d.column, other_column: d.other_column, value: d.value })),
        ],
        search: c.search,
        columns: widget.type === "table" ? c.columns : widget.type === "object_list" ? [...(c.columns ?? []).slice(0, 1), ...(c.subtitle_property ? [c.subtitle_property] : [])] : widget.type === "media" && c.column ? [c.column] : [],
        group_by: grouped ? (widget.type === "filter" ? c.column : c.group_by) : undefined,
        bucket: widget.type === "line" ? c.bucket : undefined,
        metric: widget.type === "filter" ? "count" : (c.metric ?? "count"),
        metric_column: c.metric_column,
        sort: widget.type === "line" || widget.type === "filter" ? "key" : c.sort,
        descending: widget.type === "line" || widget.type === "filter" ? false : c.descending,
        limit: widget.type === "metric" ? 0 : widget.type === "table" || widget.type === "object_list" ? (c.limit ?? 200) : 200,
        semantic,
        scenario_id: scenarioId,
      };
    if (compareIds.length)
      Promise.all(compareIds.map((sid) => workshop.query({ ...body, scenario_id: sid }).then((result) => ({ scenario: sid, result }))))
        .then((x) => !stale && setCompare(x), () => !stale && setCompare([]));
    timed("widget", widget.id, widget.title || widget.type, widget.parent ?? "", workshop.query(body))
      .then((r) => {
        if (stale) return;
        setResult(r);
        setError(null);
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
    // the spec string holds everything the query depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  // without scenarios to compare there is nothing to show (older results are ignored)
  return { result, error, compare: compareIds.length ? compare : [] };
}

export function WidgetView({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  if (widget.type === "text") return <MarkdownWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "button") return <ButtonWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "ts_chart") return <TsChartWidget widget={widget} state={state} />;
  if (widget.type === "ts_metric") return <TsMetricWidget widget={widget} state={state} />;
  if (widget.type === "quiver") return <QuiverWidget widget={widget} state={state} />;
  if (widget.type === "derived") return <DerivedWidget widget={widget} />;
  if (widget.type === "semantic_search") return <SemanticSearchBox widget={widget} state={state} editing={editing} />;
  if (widget.type === "function") return <FunctionWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "audio_recorder") return <AudioRecorderWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "custom") return <CustomWidgetHost widget={widget} state={state} editing={editing} />;
  if (widget.type === "tabs") return <TabsWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "button_group") return <ButtonGroupWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "text_input" || widget.type === "number_input" || widget.type === "date_picker" || widget.type === "toggle") return <InputWidget widget={widget} state={state} />;
  if (widget.type === "string_selector") return <StringSelectorWidget widget={widget} state={state} />;
  if (widget.type === "object_dropdown") return <ObjectDropdownWidget widget={widget} state={state} />;
  if (widget.type === "user_select") return <UserSelectWidget widget={widget} state={state} />;
  if (widget.type === "property_list") return <PropertyListWidget widget={widget} state={state} />;
  if (widget.type === "linked_objects") return <LinkedObjectsWidget widget={widget} state={state} />;
  if (widget.type === "pivot") return <PivotWidget widget={widget} state={state} />;
  if (widget.type === "embedded_module") return <EmbeddedModuleWidget widget={widget} state={state} />;
  if (widget.type === "iframe") return <IframeWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "loop") return <LoopWidget widget={widget} state={state} />;
  if (widget.type === "section") return <SectionWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "object_set_title") return <ObjectSetTitleWidget widget={widget} state={state} />;
  if (widget.type === "vega") return <VegaWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "map") return <MapWidget widget={widget} state={state} />;
  if (widget.type === "gantt") return <GanttWidget widget={widget} state={state} />;
  if (widget.type === "timeline") return <TimelineWidget widget={widget} state={state} />;
  if (widget.type === "stepper") return <StepperWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "scenario_manager") return <ScenarioManagerWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "scenario_selector") return <ScenarioSelectorWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "scenario_summary") return <ScenarioSummaryWidget widget={widget} state={state} />;
  if (widget.type === "qr_reader") return <QrReaderWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "current_location") return <CurrentLocationWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "app_pairing") return <AppPairingWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "notepad_linked") return <NotepadLinkedWidget widget={widget} state={state} />;
  if (widget.type === "notepad_embed") return <NotepadEmbedWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "notepad_new") return <NotepadNewWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "notepad_export") return <NotepadExportWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "vertex_graph") return <VertexGraphWidget widget={widget} state={state} />;
  if (widget.type === "machinery") return <MachineryWidget widget={widget} state={state} />;
  if (widget.type === "scheduling_gantt") return <SchedulingGanttWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "scheduling_calendar") return <SchedulingCalendarWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "program_scheduling") return <ProgramSchedulingWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "rule_editor") return <RuleEditorWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "proposal_reviewer") return <ProposalReviewerWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "vulcan_viewer") return <VulcanWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "form_embed") return <FormEmbedWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "pdf_viewer") return <PdfViewerWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "video_display") return <VideoWidget widget={widget} state={state} />;
  if (widget.type === "observability") return <ObservabilityWidget widget={widget} state={state} />;
  if (widget.type === "freeform") return <FreeformWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "aip_analyst") return <AnalystWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "object_view") return <ObjectViewWidget widget={widget} state={state} />;
  if (widget.type === "edit_history") return <EditHistoryWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "action_log") return <ActionLogWidget widget={widget} state={state} />;
  if (widget.type === "linked_resources") return <LinkedResourcesWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "media_uploader") return <MediaUploaderWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "resource_list") return <ResourceListWidget widget={widget} state={state} />;
  if (widget.type === "filter_list") return <FilterListWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "filter_pills" || widget.type === "search_bar") return <ExplorationWidget widget={widget} state={state} editing={editing} search={widget.type === "search_bar"} />;
  if (widget.type === "prominent_terms") return <ProminentTermsWidget widget={widget} state={state} />;
  if (widget.type === "data_freshness") return <DataFreshnessWidget widget={widget} state={state} />;
  if (widget.type === "comments") return <CommentsWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "inline_action" && c.action_interface_id) return <InterfaceInlineActionWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "inline_action") return <InlineActionWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "aip_chatbot") return <AipChatbotWidget widget={widget} state={state} editing={editing} />;
  if (widget.type === "aip_content") return <AipContentWidget widget={widget} state={state} editing={editing} />;
  if (!c.source)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-muted">
        <Icon name="database" className="h-5 w-5" />
        Choose a data source
      </div>
    );
  return <DataWidget widget={widget} state={state} />;
}

function DataWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const { result, error, compare } = useQuery(widget, state, widget.type === "filter");
  const key = sourceKey(c.source);
  const metricLabel = `${METRIC_LABEL[c.metric ?? "count"]}${c.metric && c.metric !== "count" && c.metric_column ? ` of ${c.metric_column}` : ""}`;
  if (error) return <div className="p-3 text-xs text-bad">{error}</div>;
  if (!result) return <div className="p-3 text-xs text-muted">Loading…</div>;

  switch (widget.type) {
    case "metric":
      return (
        <div className="flex h-full flex-col justify-center px-4">
          <div className="text-xs text-muted">{c.label || metricLabel}</div>
          {(() => {
            const rule = ruleFor(c.rules, "", result.value);
            return (
              <div className="mt-1 truncate rounded text-3xl font-semibold tabular-nums" style={rule ? (rule.target === "background" ? { background: rule.color, padding: "0 6px" } : { color: rule.color }) : undefined}>
                {fmtWith(result.value, c.formats?.[""])}
              </div>
            );
          })()}
          <div className="mt-0.5 text-[11px] text-muted">{result.total.toLocaleString()} rows</div>
        </div>
      );
    case "bar":
    case "pie":
    case "line": {
      if (!c.group_by) return <div className="flex h-full items-center justify-center text-xs text-muted">Choose a column to group by</div>;
      const data = result.groups ?? [];
      if (!data.length) return <div className="flex h-full items-center justify-center text-xs text-muted">No data</div>;
      const Chart = widget.type === "bar" ? BarChart : widget.type === "pie" ? PieChart : LineChart;
      const selectedValue = state.filters[key]?.[c.group_by!];
      const selectCategory = (value: unknown) => state.setFilter(key, c.group_by!, Object.is(selectedValue, value) ? undefined : value);
      return (
        <div className="h-full p-2">
          <Chart data={data} metricLabel={metricLabel} onSelect={selectCategory} />
        </div>
      );
    }
    case "filter": {
      if (!c.column) return <div className="p-3 text-xs text-muted">Choose a column to filter</div>;
      const current = state.filters[key]?.[c.column];
      return (
        <div className="flex h-full items-center gap-2 px-3">
          <select
            value={current === undefined ? "" : JSON.stringify(current)}
            onChange={(e) => state.setFilter(key, c.column!, e.target.value === "" ? undefined : JSON.parse(e.target.value))}
            className="w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean"
          >
            <option value="">All {c.label || c.column}</option>
            {(result.groups ?? []).map((g) => (
              <option key={JSON.stringify(g.key)} value={JSON.stringify(g.key)}>
                {g.key === null || g.key === "" ? "(empty)" : String(g.key)} ({g.count})
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "table":
      return <TableWidget result={result} sourceKey={key} state={state} isObjects={c.source?.kind === "object_type" || c.source?.kind === "interface"} config={c} compare={compare} />;
    case "object_list":
      return <ObjectListWidget widget={widget} state={state} result={result} />;
    case "media": {
      if (!c.column) return <div className="p-3 text-xs text-muted">Choose the media column in the panel on the right.</div>;
      // the object selected in a table on the same source, else the first row
      const selected = state.selection[key];
      const row = (selected !== undefined && result.rows?.find((r) => r.__pk === selected)) || result.rows?.[0];
      const ref = row ? row[c.column] : null;
      return typeof ref === "string" && ref ? <MediaById reference={ref} /> : <div className="p-3 text-xs text-muted">No media on this {row ? "object" : "source"}.</div>;
    }
    case "image_annotation": {
      if (!c.column) return <div className="p-3 text-xs text-muted">Choose the image column in the panel on the right.</div>;
      const selected = state.selection[key];
      const row = (selected !== undefined && result.rows?.find((r) => r.__pk === selected)) || result.rows?.[0];
      const ref = row ? row[c.column] : null;
      return typeof ref === "string" && ref && row?.__pk !== undefined ? (
        <ImageAnnotationView key={`${row.__pk}:${ref}`} reference={ref} pk={row.__pk} widget={widget} state={state} />
      ) : (
        <div className="p-3 text-xs text-muted">No image on this {row ? "object" : "source"}.</div>
      );
    }
    case "transcription": {
      if (!c.column) return <div className="p-3 text-xs text-muted">Choose the audio column in the panel on the right.</div>;
      const selected = state.selection[key];
      const row = (selected !== undefined && result.rows?.find((r) => r.__pk === selected)) || result.rows?.[0];
      const ref = row ? row[c.column] : null;
      return typeof ref === "string" && ref ? (
        <TranscriptionView key={ref} reference={ref} language={c.language} />
      ) : (
        <div className="p-3 text-xs text-muted">No audio on this {row ? "object" : "source"}.</div>
      );
    }
    default:
      return null;
  }
}

function TableWidget({ result, sourceKey: key, state, isObjects, config, compare = [] }: { result: QueryResult; sourceKey: string; state: ModuleState; isObjects: boolean; config: Widget["config"]; compare?: { scenario: string; result: QueryResult }[] }) {
  const selected = state.selection[key];
  // scenario comparison: for each scenario, the columns whose values differ from main, side by side
  const { find } = useScenarios(state.version);
  const cmp = compare.map((x) => ({ ...x, byPk: new Map((x.result.rows ?? []).map((r) => [String(r.__pk), r])) }));
  const diffCols = cmp.flatMap((x) => result.columns.filter((col) => (result.rows ?? []).some((r) => JSON.stringify(x.byPk.get(String(r.__pk))?.[col.name] ?? null) !== JSON.stringify(r[col.name] ?? null))).map((col) => ({ x, col })));
  // interface sources: rows are "<type id>:<pk>" across implementing types (selectable; no drag, function or time series columns)
  const typedRows = isObjects && key.startsWith("object_type:");
  const derived = useFunctionColumn(result, typedRows ? config : {});
  // time series property columns of an object type source: a summary and a sparkline per row
  const tsCols = isObjects && key.startsWith("object_type:") ? config.ts_columns ?? [] : [];
  const tsData = useTsColumns(tsCols.length ? key.slice("object_type:".length) : null, (result.rows ?? []).map((r) => String(r.__pk ?? "")).filter(Boolean), tsCols, state.version, state.moduleId ? `workshop:${state.moduleId}` : "workshop");
  // color scales: each column's bounds over the rows shown
  const tsDomains = useTsDomains(tsCols, tsData);
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-panel text-left text-xs text-muted">
          <tr className="border-b border-line">
            {result.columns.map((col) => (
              <th key={col.name} className="whitespace-nowrap px-3 py-2 font-medium" title={col.label ? col.name : undefined}>
                {col.label ?? col.name}
              </th>
            ))}
            {diffCols.map(({ x, col }) => (
              <th key={`${x.scenario}:${col.name}`} className="whitespace-nowrap bg-warn/10 px-3 py-2 font-medium" data-scenario-col={x.scenario}>
                {col.name} · {find(x.scenario)?.name ?? "scenario"}
              </th>
            ))}
            {tsCols.map((t) => (
              <th key={t.id} className="whitespace-nowrap px-3 py-2 font-medium" title={`${t.aggregation ?? "last"} of ${t.property}${t.range_last ? ` · last ${t.range_last}` : ""}`} data-ts-column={t.id}>
                <Icon name="wave" className="mr-1 inline h-3 w-3" />
                {t.label || t.property}
              </th>
            ))}
            {derived && (
              <th className="whitespace-nowrap px-3 py-2 font-medium" title="Function-backed column">
                <Icon name="code" className="mr-1 inline h-3 w-3" />
                {config.column_function_label || "Function"}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {result.rows?.map((r, i) => {
            const pk = r.__pk;
            const on = isObjects && pk !== undefined && pk === selected;
            return (
              <tr
                key={pk ?? i}
                draggable={typedRows && !!config.enable_drag && pk !== undefined}
                onDragStart={(e) => pk !== undefined && dragObjects(e, key.split(":").slice(1).join(":"), [String(pk)])}
                onClick={() => {
                  if (!isObjects) return;
                  state.select(key, on ? undefined : pk);
                  if (!on && config.on_select?.length) void state.runEvents?.(config.on_select);
                }}
                className={`border-b border-line ${isObjects ? "cursor-pointer" : ""} ${on ? "bg-ocean/15" : "hover:bg-panel-2"}`}
              >
                {result.columns.map((col, j) => (
                  <td key={col.name} className="max-w-64 px-3 py-1.5 text-soft">
                    <span className="flex items-center gap-1.5">
                      {j === 0 && isObjects && <Icon name="cube" className="h-3.5 w-3.5 shrink-0 text-sand" />}
                      {col.type === "Media" ? (
                        <ValueCell type="media" value={r[col.name]} />
                      ) : (
                        <span className="truncate whitespace-nowrap rounded px-0.5" title={fmt(r[col.name])}
                          style={(() => {
                            const rule = ruleFor(config.rules, col.name, r[col.name]);
                            return rule ? (rule.target === "background" ? { background: rule.color } : { color: rule.color }) : undefined;
                          })()}>
                          {fmtWith(r[col.name], config.formats?.[col.name])}
                        </span>
                      )}
                      {isObjects && <SecurityMarkings marks={r.__markings?.[col.name]} mode={config.security_markings === "responsive" ? "full" : config.security_markings} />}
                    </span>
                  </td>
                ))}
                {diffCols.map(({ x, col }) => {
                  const v = x.byPk.get(String(pk))?.[col.name];
                  const changed = JSON.stringify(v ?? null) !== JSON.stringify(r[col.name] ?? null);
                  return (
                    <td key={`${x.scenario}:${col.name}`} className={`max-w-64 px-3 py-1.5 ${changed ? "bg-warn/15 font-semibold text-white" : "text-muted"}`} data-scenario-cell={changed ? "changed" : "same"}>
                      {fmt(v)}
                    </td>
                  );
                })}
                {tsCols.map((t) => (
                  <td key={t.id} className="px-3 py-1 text-soft">
                    <TsCell col={t} cell={tsData[t.id]?.[String(pk)]} domain={tsDomains[t.id]} />
                  </td>
                ))}
                {derived && (
                  <td className="px-3 py-1.5 text-soft">
                    {derived.error ? <span className="text-bad" title={derived.error}>error</span> : derived.values ? fmt(derived.values[String(pk)]) : "…"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {result.total > (result.rows?.length ?? 0) && (
        <div className="px-3 py-1.5 text-[11px] text-muted">
          Showing {result.rows?.length.toLocaleString()} of {result.total.toLocaleString()}
        </div>
      )}
    </div>
  );
}

function ButtonWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  if (widget.config.action_interface_id) return <InterfaceButtonWidget widget={widget} state={state} editing={editing} />;
  return <TypeButtonWidget widget={widget} state={state} editing={editing} />;
}

/** An action button on an interface source: the selected object ("<type id>:<pk>") can be of any implementing type, so
 * the concrete action is resolved for it (constraint mapping, per-type action, interface action or the type's own). */
function useInterfaceAction(c: Widget["config"], state: ModuleState, editing: boolean) {
  const selected = state.selection[sourceKey({ kind: "interface", id: c.action_interface_id! })];
  const [res, setRes] = useState<{ key: string; r?: InterfaceActionResolution; error?: string } | null>(null);
  // an inline action keeps its action in action_ids (the first one is the configured action)
  const actionId = c.action_type_id ?? c.action_ids?.[0];
  const spec = JSON.stringify([c.action_interface_id, c.action_constraint, actionId, c.action_by_type, selected]);
  useEffect(() => {
    if (!selected || editing) return;
    let stale = false;
    workshop
      .interfaceAction({ interface_id: c.action_interface_id!, object: selected, action_type_id: actionId, constraint: c.action_constraint, by_type: c.action_by_type })
      .then((r) => !stale && setRes({ key: spec, r }), (e: Error) => !stale && setRes({ key: spec, error: e.message }));
    return () => {
      stale = true;
    };
    // the spec string holds everything the resolution depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, editing]);
  return { selected, spec, cur: res?.key === spec ? res : null, setRes };
}

/** An inline action on an interface source: the configured actions (action_ids / action_type_id, the action per type and
 * the interface's action type constraint) resolved for the selected object's type; a menu above the form when several
 * apply (POST /api/workshop/interface-actions), the form of the chosen one. */
function InterfaceInlineActionWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const selected = state.selection[sourceKey({ kind: "interface", id: c.action_interface_id! })];
  const ids = c.action_ids?.length ? c.action_ids : c.action_type_id ? [c.action_type_id] : [];
  const spec = JSON.stringify([c.action_interface_id, c.action_constraint, ids, c.action_by_type, selected]);
  const [opts, setOpts] = useState<{ key: string; r?: InterfaceActionOptions; error?: string } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    if (!selected || editing) return;
    let stale = false;
    workshop
      .interfaceActions({ interface_id: c.action_interface_id!, object: selected, action_type_ids: ids, constraint: c.action_constraint, by_type: c.action_by_type })
      .then((r) => !stale && setOpts({ key: spec, r }), (e: Error) => !stale && setOpts({ key: spec, error: e.message }));
    return () => {
      stale = true;
    };
    // the spec string holds everything the resolution depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, editing]);
  const cur = opts?.key === spec ? opts : null;
  const options = cur?.r?.options ?? [];
  // the picked action stays picked while it applies to the newly selected object, else the first one
  const r = options.find((o) => o.action_type_id === pick) ?? options[0];
  const [loaded, setLoaded] = useState<{ key: string; action: ActionType; type: ObjectType; object: OntologyObject } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const key = r ? `${r.action_type_id}|${r.object_type_id}|${r.primary_key}` : "";
  useEffect(() => {
    if (!r) return;
    let stale = false;
    Promise.all([ontology.actionType(r.action_type_id), ontology.objectType(r.object_type_id), ontology.object(r.object_type_id, r.primary_key)]).then(
      ([action, type, object]) => {
        if (stale) return;
        setError(null);
        setLoaded({ key, action, type, object });
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
    // key names the resolved action and object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const msg = (t: string, bad = false) => <div className={`flex h-full items-center justify-center p-3 text-center text-xs ${bad ? "text-bad" : "text-muted"}`}>{t}</div>;
  if (state.readOnly) return msg("Actions are off in kiosk mode (read-only)");
  if (editing) return msg(ids.length > 1 ? `An action form for the object selected on the interface (${ids.length} actions: those that apply to its type)` : "An action form for the object selected on the interface");
  if (!selected) return msg("Select an object in a table on the interface");
  if (cur?.error) return msg(cur.error, true);
  if (cur?.r && !options.length)
    return msg(`No configured action applies to ${cur.r.object_type_name} objects${cur.r.refused.length ? `: ${cur.r.refused.map((x) => x.reason).join("; ")}` : ""}`, true);
  if (error) return msg(error, true);
  if (!r || !loaded || loaded.key !== key) return msg("Loading the action…");
  return (
    <div className="flex h-full min-h-0 flex-col" data-interface-action={r.action_type_id} data-inline={widget.id}>
      {options.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-line px-2 py-1" data-interface-action-menu={options.length}>
          {options.map((o) => (
            <button
              key={o.action_type_id}
              type="button"
              data-interface-action-pick={o.action_type_id}
              title={`${o.action_name} on ${cur?.r?.object_type_name ?? o.object_type_id} ${o.primary_key}`}
              onClick={() => setPick(o.action_type_id)}
              className={`rounded px-2 py-0.5 text-xs ${o.action_type_id === r.action_type_id ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`}
            >
              {o.action_name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ActionDialog
          key={`${key}:${round}`}
          action={loaded.action}
          objectType={loaded.type}
          object={loaded.object}
          inline
          defaults={r.defaults}
          title={c.action_title ? fillVars(c.action_title, state.variables) : undefined}
          hideHeader={c.hide_header}
          scenarioId={c.apply_to_scenario ? String(state.variables[c.apply_to_scenario] ?? "") || undefined : undefined}
          onClose={() => setRound((n) => n + 1)}
          onDone={() => {
            setRound((n) => n + 1);
            state.bump();
            if (c.on_submit?.length) void state.runEvents?.(c.on_submit);
          }}
        />
      </div>
    </div>
  );
}

function InterfaceButtonWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { selected, spec, cur, setRes } = useInterfaceAction(c, state, editing);
  const [open, setOpen] = useState<{ action: ActionType; type: ObjectType; r: InterfaceActionResolution } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!cur?.r) return;
    setBusy(true);
    try {
      const [action, type] = await Promise.all([ontology.actionType(cur.r.action_type_id), ontology.objectType(cur.r.object_type_id)]);
      setOpen({ action, type, r: cur.r });
    } catch (e) {
      setRes({ key: spec, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const label = fillVars((c.label ? (state.tr?.(c.label) ?? c.label) : "") || cur?.r?.action_name || "Action", state.variables);
  const title = state.readOnly ? "Read-only (kiosk mode)" : !selected ? "Select an object in a table on the interface first" : cur?.error ?? (cur?.r ? `${cur.r.action_name} on ${cur.r.object_type_id}:${cur.r.primary_key}` : undefined);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-2" data-interface-action={cur?.r?.action_type_id ?? ""}>
      <button
        type="button"
        disabled={editing || !selected || !cur?.r || busy || !!state.readOnly}
        title={title}
        onClick={() => void run()}
        className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white hover:bg-ocean-deep disabled:opacity-50"
      >
        <Icon name="edit" className="h-3.5 w-3.5" />
        {label}
      </button>
      {selected && cur?.error && <div className="max-w-full truncate text-[11px] text-bad" title={cur.error}>{cur.error}</div>}
      {open && (
        <SelectedActionDialog
          action={open.action}
          type={open.type}
          pk={open.r.primary_key}
          defaults={open.r.defaults}
          scenarioId={c.apply_to_scenario ? String(state.variables[c.apply_to_scenario] ?? "") || undefined : undefined}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            state.bump();
            if (c.events?.length) void state.runEvents?.(c.events);
            [2000, 6000].forEach((ms) => setTimeout(state.bump, ms));
          }}
        />
      )}
    </div>
  );
}

function TypeButtonWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [action, setAction] = useState<ActionType | null>(null);
  const [type, setType] = useState<ObjectType | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!c.action_type_id) return;
    ontology
      .actionTypes()
      .then((as) => {
        const a = as.find((x) => x.id === c.action_type_id) ?? null;
        setAction(a);
        if (a) ontology.objectType(a.object_type_id).then(setType);
      })
      .catch(() => {});
  }, [c.action_type_id]);
  const selectedPk = type ? state.selection[sourceKey({ kind: "object_type", id: type.id })] : undefined;
  const needsObject = action && action.kind !== "create";
  return (
    <div className="flex h-full items-center justify-center p-2">
      <button
        type="button"
        disabled={editing || (!action && !c.events?.length) || (!!needsObject && !selectedPk) || (!!action && !!state.readOnly)}
        title={action && state.readOnly ? "Read-only (kiosk mode)" : needsObject && !selectedPk ? `Select a ${type?.display_name ?? "object"} in a table first` : undefined}
        onClick={() => (action ? setOpen(true) : void state.runEvents?.(c.events ?? []))}
        className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white hover:bg-ocean-deep disabled:opacity-50"
      >
        <Icon name={action?.kind === "delete" ? "trash" : action?.kind === "create" ? "plus" : "edit"} className="h-3.5 w-3.5" />
        {fillVars((c.label ? (state.tr?.(c.label) ?? c.label) : "") || action?.display_name || "Button", state.variables)}
      </button>
      {open && action && type && (
        <SelectedActionDialog
          action={action}
          type={type}
          scenarioId={c.apply_to_scenario ? String(state.variables[c.apply_to_scenario] ?? "") || undefined : undefined}
          pk={needsObject ? selectedPk : undefined}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            state.bump();
            if (c.events?.length) void state.runEvents?.(c.events);
            // automations may still be writing
            [2000, 6000].forEach((ms) => setTimeout(state.bump, ms));
          }}
        />
      )}
    </div>
  );
}

function SelectedActionDialog({ action, type, pk, onClose, onDone, scenarioId, defaults }: { action: ActionType; type: ObjectType; pk?: string; onClose: () => void; onDone: () => void; scenarioId?: string; defaults?: Record<string, unknown> }) {
  const [object, setObject] = useState<OntologyObject | null | undefined>(pk ? undefined : null);
  useEffect(() => {
    if (!pk) return;
    ontology
      .object(type.id, pk)
      .then(setObject)
      .catch(() => setObject(null));
  }, [pk, type.id]);
  if (object === undefined) return null;
  return <ActionDialog action={action} objectType={type} object={object ?? undefined} onClose={onClose} onDone={onDone} scenarioId={scenarioId} defaults={defaults} />;
}


/** A media reference (a media item id, optionally with "#page" etc.) previewed by its type. */
function MediaById({ reference }: { reference: string }) {
  const id = reference.split("#")[0];
  const [meta, setMeta] = useState<{ path: string; schema: MediaSchema | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    mediaSets.metadata(id).then(
      (m) => !stale && setMeta({ path: String(m.path ?? id), schema: (m.schema as MediaSchema | null) ?? null }),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [id]);
  if (error) return <div className="p-3 text-xs text-bad">{error}</div>;
  if (!meta) return <div className="p-3 text-xs text-muted">Loading…</div>;
  return (
    <div className="h-full overflow-auto p-2">
      <MediaPreview id={id} schema={meta.schema} path={meta.path} compact />
    </div>
  );
}

/** Audio Recorder: records from the microphone (MediaRecorder), uploads the clip and runs an action with it. */
function AudioRecorderWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [action, setAction] = useState<ActionType | null>(null);
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<Blob | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  useEffect(() => {
    if (!c.action_type_id) return;
    ontology.actionType(c.action_type_id).then(setAction, () => setAction(null));
  }, [c.action_type_id]);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  const url = useMemo(() => (clip ? URL.createObjectURL(clip) : null), [clip]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const selectedPk = action?.object_type_id ? state.selection[sourceKey({ kind: "object_type", id: action.object_type_id })] : undefined;
  const needsObject = !!action && action.kind !== "create";
  const start = async () => {
    setStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setClip(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
      };
      r.start();
      rec.current = r;
      setClip(null);
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      setStatus(`Microphone unavailable: ${(e as Error).message}`);
    }
  };
  const stop = () => {
    rec.current?.stop();
    setRecording(false);
  };
  // the media parameter getting the recording (config "column"; else the first); other media parameters stay as they are
  const mediaParam = action?.parameters.find((p) => p.type === "media" && p.id === c.column) ?? action?.parameters.find((p) => p.type === "media");
  const objectParam = needsObject ? action?.parameters.find((p) => p.type === "object") : undefined;
  const given = (media: string) => ({ ...(mediaParam ? { [mediaParam.id]: media } : {}), ...(objectParam ? { [objectParam.id]: selectedPk } : {}) });
  const filled = action ? { ...given(""), ...Object.fromEntries(action.parameters.filter((p) => p.type === "media").map((p) => [p.id, null])) } : {};
  const save = async () => {
    if (!action || !clip) return;
    setBusy(true);
    setStatus(null);
    try {
      const folder = await ontology.mediaFolder();
      const ext = clip.type.includes("ogg") ? "ogg" : clip.type.includes("mp4") ? "m4a" : "webm";
      const item = await uploadDriveFile(new File([clip], `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`, { type: clip.type }), folder.id, () => {});
      await ontology.applyAction(action.id, { ...typed(action, extra), ...given(item.id) });
      setClip(null);
      setStatus("Saved");
      state.bump();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!c.action_type_id) return <div className="p-3 text-xs text-muted">Choose an action with a media parameter in the panel on the right.</div>;
  return (
    <div className="flex h-full flex-col justify-center gap-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        {recording ? (
          <button type="button" onClick={stop} className="inline-flex items-center gap-1.5 rounded-md bg-bad px-3 py-1.5 text-sm font-medium text-white">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> Stop · {new Date(seconds * 1000).toISOString().slice(14, 19)}
          </button>
        ) : (
          <button type="button" onClick={start} disabled={editing} className="inline-flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-sm hover:border-ocean disabled:opacity-50">
            <span className="h-2 w-2 rounded-full bg-bad" /> {clip ? "Record again" : "Record"}
          </button>
        )}
        {url && <audio controls src={url} className="h-8 min-w-0 flex-1" />}
      </div>
      {clip && action && (
        <>
          <ExtraParameters action={action} filled={filled} values={extra} onChange={setExtra} />
          <button
            type="button"
            onClick={save}
            disabled={busy || (needsObject && !selectedPk)}
            title={needsObject && !selectedPk ? "Select an object in a table first" : undefined}
            className="self-start rounded-md bg-ocean px-3 py-1.5 font-medium text-white hover:bg-ocean-deep disabled:opacity-50"
          >
            {busy ? "Saving…" : c.label || action.display_name}
          </button>
        </>
      )}
      {status && <p className={status === "Saved" ? "text-ok" : "text-bad"}>{status}</p>}
    </div>
  );
}

/** Audio and Transcription Display: the audio player and the Whisper transcript (pipeline media service, cached). */
function TranscriptionView({ reference, language }: { reference: string; language?: string }) {
  const id = reference.split("#")[0];
  const [segs, setSegs] = useState<{ start: number; end: number; text: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    let stale = false;
    const key = `media:transcribe:workshop:${language ?? ""}:${id}`;
    fetch(`${API_URL}/api/pipeline/media/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ calls: [{ key, item_id: id, method: "transcribe", output: "segments", language: language || null }] }),
    })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).detail ?? r.statusText))))
      .then((d: { results: Record<string, { value?: string; error?: string }> }) => {
        if (stale) return;
        const res = d.results[key];
        if (res?.error) setError(res.error);
        else setSegs((JSON.parse(String(res?.value ?? "{}")).segments ?? []) as { start: number; end: number; text: string }[]);
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [id, language]);
  return (
    <div className="flex h-full flex-col gap-2 p-2 text-sm">
      <audio ref={audio} controls src={driveContentUrl(id, true)} className="w-full" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
      <div className="min-h-0 flex-1 overflow-auto rounded border border-line-2 p-2">
        {error && <p className="text-xs text-bad">{error}</p>}
        {!segs && !error && <p className="text-xs text-muted">Transcribing…</p>}
        {segs?.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              if (audio.current) {
                audio.current.currentTime = s.start;
                void audio.current.play();
              }
            }}
            className={`mb-1 block w-full rounded px-1.5 py-1 text-left ${now >= s.start && now < s.end ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}
          >
            <span className="mr-2 font-mono text-[11px] text-muted">{new Date(s.start * 1000).toISOString().slice(14, 19)}</span>
            {s.text}
          </button>
        ))}
        {segs && !segs.length && <p className="text-xs text-muted">No speech found.</p>}
      </div>
    </div>
  );
}

/** Runs a published function with fixed inputs (and the selected object) and shows the output; re-runs when the selection changes. */
function FunctionWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const pk = c.object_type_id ? state.selection[sourceKey({ kind: "object_type", id: c.object_type_id })] : undefined;
  const [res, setRes] = useState<FnResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the variables this widget reads ("$var:name" inputs)
  const used = Object.values(c.function_inputs ?? {}).filter((v) => v.startsWith("$var:")).map((v) => v.slice(5).trim());
  // interface-typed inputs: references from a selection or a variable ({object_type_id, primary_key} / a list / {objects})
  const objectInputs = Object.fromEntries(Object.entries(c.function_object_inputs ?? {}).map(([k, b]) => [k, objectInputValue(b, state.selection, state.variables)]));
  const waiting = Object.keys(objectInputs).find((k) => objectInputs[k] === undefined);
  const spec = JSON.stringify([c.function_id, c.function_version, c.function_inputs, c.object_input, pk, used.map((n) => state.variables[n]), objectInputs]);
  useEffect(() => {
    if (!c.function_id || (c.object_input && !pk) || waiting) return;
    let stale = false;
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.function_inputs ?? {})) {
      if (v === "") continue;
      if (v.startsWith("$var:")) {
        inputs[k] = resolveVar(v, state.variables);
        continue;
      }
      try {
        inputs[k] = JSON.parse(v);
      } catch {
        inputs[k] = v;
      }
    }
    if (c.object_input && pk) inputs[c.object_input] = pk;
    Object.assign(inputs, objectInputs);
    fnRegistry
      .execute(c.function_id, inputs, c.function_version || undefined, "workshop")
      .then((r) => {
        if (stale) return;
        setRes(r);
        setError(r.ok ? null : (r.error ?? "The function failed"));
        if (r.ok && c.output_variable && JSON.stringify(state.variables[c.output_variable]) !== JSON.stringify(r.value)) state.setVariable(c.output_variable, r.value);
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
    // the spec string holds everything the run depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, state.version]);
  if (!c.function_id) return <div className="flex h-full items-center justify-center text-xs text-muted">{editing ? "Choose a function in the panel" : "No function"}</div>;
  if (c.object_input && !pk) return <div className="flex h-full items-center justify-center text-xs text-muted">Select an object in a table</div>;
  if (waiting)
    return (
      <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">
        {c.function_object_inputs?.[waiting]?.from === "variable" ? `Set the variable ${c.function_object_inputs[waiting].variable ?? ""} (input ${waiting})` : `Select an object in a table (input ${waiting})`}
      </div>
    );
  if (error) return <div className="p-3 text-xs text-bad">{error}</div>;
  if (!res) return <div className="flex h-full items-center justify-center text-xs text-muted">Running…</div>;
  const v = res.value;
  // a sentence or more (an explanation, a summary): readable text that wraps, not a big number cut off at the edges
  if (typeof v === "string" && (v.length > 40 || v.includes("\n")))
    return (
      <div className="flex h-full flex-col overflow-auto p-3">
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-soft">{v}</div>
        <div className="mt-auto pt-2 text-[11px] text-muted">
          v{res.version} · {res.ms} ms
        </div>
      </div>
    );
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-2">
        <div className="truncate text-3xl font-semibold tabular-nums">{typeof v === "number" ? v.toLocaleString() : String(v)}</div>
        <div className="text-[11px] text-muted">
          v{res.version} · {res.ms} ms
        </div>
      </div>
    );
  if (v && typeof v === "object" && Array.isArray((v as { buckets?: unknown }).buckets))
    return (
      <div className="h-full overflow-auto p-2">
        <AggregationView value={v as { buckets: { key: unknown; value: unknown }[] }} />
      </div>
    );
  return <pre className="h-full overflow-auto p-3 text-xs">{JSON.stringify(v, null, 2)}</pre>;
}

/** A function-backed column: the function gets the table's objects as an object set and returns Map<Object, value>. */
function useFunctionColumn(result: QueryResult, c: Widget["config"]): { values: Record<string, unknown> | null; error: string | null } | null {
  const [state, setState] = useState<{ key: string; values: Record<string, unknown> | null; error: string | null }>({ key: "", values: null, error: null });
  const pks = (result.rows ?? []).map((r) => String(r.__pk)).filter((x) => x !== "undefined");
  const key = JSON.stringify([c.column_function_id, c.column_function_input, c.source?.id, pks]);
  useEffect(() => {
    if (!c.column_function_id || !c.column_function_input || !c.source || !pks.length) return;
    let stale = false;
    fnRegistry.execute(c.column_function_id, { [c.column_function_input]: { object_type_id: c.source.id, primary_keys: pks } }, undefined, "workshop").then(
      (r) => {
        if (stale) return;
        const m = (r.value as { __object_map__?: { primary_key: string; value: unknown }[] } | undefined)?.__object_map__;
        setState({ key, values: m ? Object.fromEntries(m.map((x) => [x.primary_key, x.value])) : null, error: r.ok ? (m ? null : "the function must return Map<Object, value>") : (r.error ?? "failed") });
      },
      (e: Error) => !stale && setState({ key, values: null, error: e.message }),
    );
    return () => {
      stale = true;
    };
    // the key holds everything the column depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!c.column_function_id || !c.column_function_input) return null;
  return state.key === key ? state : { values: null, error: null };
}

/** A semantic search box: a query ranks the object type's objects by meaning for every widget on that source. */
function SemanticSearchBox({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const key = sourceKey(c.source);
  const active = (state.filters[key] ?? {})[SEMANTIC] as { query: string } | undefined;
  const [text, setText] = useState(active?.query ?? "");
  if (!c.source || c.source.kind !== "object_type") return <div className="flex h-full items-center justify-center text-xs text-muted">Choose an object type with an embedding</div>;
  const run = () =>
    state.setFilter(key, SEMANTIC, text.trim() ? { query: text.trim(), k: c.semantic_k ?? 20, mode: c.semantic_mode ?? "semantic", property: c.semantic_property } : undefined);
  return (
    <form
      className="flex h-full items-center gap-2 px-3"
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
    >
      <Icon name="search" className="h-4 w-4 shrink-0 text-muted" />
      <input
        value={text}
        disabled={editing}
        onChange={(e) => setText(e.target.value)}
        placeholder={c.placeholder || "Search by meaning…"}
        className="min-w-0 flex-1 rounded-md border border-line-2 bg-ink px-2 py-1.5 text-sm outline-none focus:border-ocean"
      />
      <button type="submit" disabled={editing} className="rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        Search
      </button>
      {active && (
        <button
          type="button"
          onClick={() => {
            setText("");
            state.setFilter(key, SEMANTIC, undefined);
          }}
          className="text-xs text-muted hover:text-white"
        >
          Clear
        </button>
      )}
    </form>
  );
}
