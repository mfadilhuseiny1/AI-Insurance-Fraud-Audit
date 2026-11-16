/** Workshop (api/workshop.py): drag-and-drop dashboards over datasets and object types. */
import { API_URL, type DriveItem } from "./api";
import type { IconName } from "@/components/Icon";

/** object_types: a union of several object types' object sets (id: their ids, comma-separated) */
export type SourceRef = { kind: "dataset" | "object_type" | "interface" | "restricted_view" | "object_types"; id: string };
export const sourceKey = (s?: SourceRef | null) => (s ? `${s.kind}:${s.id}` : "");

export type WidgetType =
  | "table" | "metric" | "bar" | "pie" | "line" | "filter" | "text" | "button" | "media" | "ts_chart" | "ts_metric" | "quiver" | "derived" | "function" | "semantic_search" | "transcription" | "image_annotation" | "audio_recorder" | "custom"
  // layout, inputs, display and embedding (WorkshopWidgets.tsx)
  | "tabs" | "button_group" | "text_input" | "number_input" | "string_selector" | "date_picker" | "toggle" | "object_dropdown" | "user_select"
  | "object_list" | "property_list" | "linked_objects" | "pivot" | "embedded_module" | "iframe" | "loop" | "section"
  // visualization widgets (VizWidgets.tsx)
  | "object_set_title" | "vega" | "map" | "gantt" | "stepper" | "timeline"
  // collaboration, writeback and AIP widgets (AipWidgets.tsx)
  | "comments" | "inline_action" | "aip_chatbot" | "aip_content"
  // module state (ModuleSettings.tsx)
  | "data_freshness"
  // filtering widgets (FilterWidgets.tsx)
  | "filter_list" | "filter_pills" | "search_bar" | "prominent_terms"
  // objects, history and resources (ObjectWidgets.tsx)
  | "object_view" | "edit_history" | "action_log" | "linked_resources" | "media_uploader" | "resource_list"
  // documents, video, telemetry and analysis (MediaWidgets.tsx)
  | "pdf_viewer" | "video_display" | "observability" | "freeform" | "aip_analyst"
  // cross-application interactivity (CrossApp.tsx)
  | "app_pairing"
  // Notepad documents (NotepadWidgets.tsx)
  | "notepad_linked" | "notepad_embed" | "notepad_new" | "notepad_export"
  // Vertex graphs and Machinery processes (GraphWidgets.tsx)
  | "vertex_graph" | "machinery"
  // Dynamic Scheduling boards (SchedulingWidgets.tsx)
  | "scheduling_gantt" | "scheduling_calendar"
  // Dynamic Scheduling's Program Scheduling (ProgramScheduling.tsx)
  | "program_scheduling"
  // Foundry Rules workflows (RulesWidgets.tsx)
  | "rule_editor" | "proposal_reviewer"
  // Vulcan CAD viewer (VulcanWidget.tsx)
  | "vulcan_viewer"
  // Forms (FormWidgets.tsx)
  | "form_embed"
  // scenarios [Legacy] (ScenarioWidgets.tsx)
  | "scenario_manager" | "scenario_selector" | "scenario_summary"
  // mobile (MobileWidgets.tsx)
  | "qr_reader" | "current_location";

/** What a button or another event source does, in order (workshopEvents.ts). */
export type WsEvent =
  | { kind: "set_variable"; variable: string; value: unknown }
  | { kind: "open_overlay"; overlay: string }
  | { kind: "close_overlay" }
  | { kind: "switch_tab"; widget: string; tab: string }
  | { kind: "go_page"; page: string }
  | { kind: "open_module"; module_id: string; params?: Record<string, unknown>; new_tab?: boolean }
  | { kind: "open_url"; url: string; new_tab?: boolean }
  | { kind: "refresh" }
  | { kind: "apply_action"; action_type_id: string }
  | { kind: "reset_variable"; variable: string }
  | { kind: "recompute_variable"; variable: string }
  | { kind: "llm_to_variable"; variable: string; prompt: string; model?: string }
  | { kind: "open_object"; object_type_id: string; primary_key: string; new_tab?: boolean }
  | { kind: "section"; widget: string; action: "expand" | "collapse" | "toggle" }
  | { kind: "auto_refresh"; enabled: boolean }
  | { kind: "send_command"; target: string; command: string; payload?: unknown }
  /** scenarios [Legacy]: create one (into a scenario array, as the active one), save (persist, optionally a scenario object
   * through an action), apply (merge through an action type with an Apply scenario rule) or delete the active one */
  | { kind: "scenario"; op: "create" | "save" | "apply" | "delete" | "duplicate"; variable: string; list_variable?: string; action_type_id?: string; id_param?: string; name_param?: string;
      /** save to a scenario object: the type implementing the scenario trait (type classes fill the id, name and object
       * parameters) and the action that updates an object already storing the scenario */
      object_type_id?: string; update_action_type_id?: string };
/** An argument of a transformation step: a constant, a variable, or an earlier step's result. */
export type TArg = { value?: unknown; var?: string; step?: number };
export type TStep = { op: string; args: TArg[]; opts?: Record<string, unknown> };
/** How a variable gets its value (Workshop's variable definition types). */
export type VariableDefinition =
  | { kind: "static" }
  | { kind: "transform"; steps: TStep[] }
  | { kind: "function"; function_id: string; version?: string; inputs?: Record<string, unknown> }
  | { kind: "aggregation"; source?: SourceRef; metric: Metric; column?: string; filters?: Filter[]; scenario?: string }
  | { kind: "property"; object_type_id: string; object?: string; property: string; scenario?: string }
  /** scenarios loaded from an object set: objects holding a scenario id (rid) in id_property */
  | { kind: "scenario_objects"; object_type_id: string; id_property: string; filters?: Filter[] }
  | { kind: "sql"; query: string; tables: { alias: string; object_type_id: string }[]; params: { alias: string; variable: string }[] }
  /** K-nearest neighbors: the k objects of a type nearest a query — text ({{var}} / $var:name / literal) or a vector
   * (a numeric array variable) — over a vector property, or ranked by keywords / hybrid; recomputed when the query changes; no query or no
   * results: an empty object set (emptySet / emptyKeys) */
  | { kind: "knn"; object_type_id: string; query: string; property?: string; k?: number; mode?: "semantic" | "hybrid" | "keyword" };
export type Variable = {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "timestamp" | "object" | "object_set" | "array" | "struct" | "struct_array" | "object_set_filter" | "scenario" | "scenario_array";
  default?: unknown;
  /** object set filter variables: write the values of a matching filter back into the variables its default uses */
  extract?: boolean;
  /** routing: initialize from ?v.<name>= (or ?<external_id>=) */
  url_param?: boolean;
  description?: string;
  definition?: VariableDefinition;
  /** automatic (default), only on a recompute event, or on load and on a recompute event */
  recompute?: "auto" | "event" | "load_event";
  /** module interface: the name embedding modules, Open module events and URLs use */
  external_id?: string;
  interface?: boolean;
};
/** Style formatting shared by pages, sections and widgets (Workshop's style formatting). */
export type Background = "default" | "1" | "2" | "3" | "4" | "5" | "transparent" | string;
export type Padding = "none" | "compact" | "regular" | "large" | number;
export type Page = { id: string; name: string; background?: Background; padding?: Padding };
/** open_variable: a boolean variable backing the open state (both ways); on_close: events run when it closes */
export type Overlay = {
  id: string; name: string; kind: "drawer" | "modal"; width?: number; open_variable?: string; side?: "left" | "right";
  show_header?: boolean; title?: string; icon?: string; on_close?: WsEvent[]; close_on_backdrop?: boolean; backdrop?: boolean;
};
/** The module header: a persistent toolbar (its widgets have parent "header") with a title and a logo. */
export type ModuleHeader = {
  hidden?: boolean; title?: string; title_color?: string; icon?: string; icon_color?: string; image_url?: string; image_height?: number;
  image_position?: "left" | "center" | "right" | "top" | "bottom"; background?: string; orientation?: "horizontal" | "vertical";
  height?: number; width?: number; collapsible?: boolean; collapsed?: boolean; favorite?: boolean;
};
/** A module-level derived property (column math on an object type), added to every query on that type. */
export type ModuleDerived = { object_type_id: string; name: string; op: DerivedColumn["op"]; column: string; other_column?: string; value?: unknown };
/** Value formatting: decimals (both fraction digit bounds) or min / max fraction digits, minimum integer digits, min / max
 * significant digits, grouping separators, notation, prefix / suffix. Local to the module. */
export type ValueFormat = {
  decimals?: number; prefix?: string; suffix?: string; notation?: "standard" | "compact" | "percent" | "scientific" | "engineering";
  min_fraction?: number; max_fraction?: number; min_integer?: number; min_significant?: number; max_significant?: number; grouping?: boolean;
};
/** Conditional formatting: the first matching rule colors the text, the cell background, a time series sparkline or all. */
export type FormatRule = {
  column?: string; op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "contains" | "between"; value: unknown; value2?: unknown; color: string;
  target?: "text" | "background" | "sparkline" | "all";
  /** time series only: what the rule tests — the summary value (default) or a measure of the sparkline's series */
  test?: TsMeasure;
};
/** A measure of a time series cell: the summary value, the change over the range (last − first point, absolute or in %)
 * or the trend (the least-squares slope per day of the sparkline's points). */
export type TsMeasure = "value" | "change" | "change_pct" | "trend";
/** A color scale on a time series measure: min → (mid →) max colors over the shown rows' range, or fixed bounds. */
export type TsColorScale = {
  by?: TsMeasure; min_color: string; mid_color?: string; max_color: string; min?: number; max?: number;
  target?: "text" | "background" | "sparkline" | "all";
};
/** A time series property column of an object table: the property summarized over a range, with a sparkline. */
export type TsColumn = {
  id: string; property: string; label?: string; aggregation?: TsAggregation;
  range_last?: string; sparkline?: boolean; buckets?: number; format?: ValueFormat; rules?: FormatRule[]; color_scale?: TsColorScale;
  /** a rolling aggregate transform first (window, e.g. 7d; aggregation, default mean): the summary and the sparkline
   * are of the rolled series */
  rolling?: string; rolling_agg?: string;
  /** more time series transforms after the rolling window, in order */
  transforms?: TsTransform[];
  /** single value (default) or value change: the aggregation over the range minus the same over the period before it
   * (of the range's length, or `change_offset` earlier), as a difference or a percent */
  summarizer?: "single" | "value_change"; change_as?: "absolute" | "percent"; change_offset?: string;
  /** the time unit of the integral summary */
  integral_unit?: string;
  /** a custom range (the doc's "Custom range"): exact start / end (ISO, either may be open), or relative: `range_last`
   * before now ending `range_end_offset` from now (a signed duration: -7d a week ago, 1w a week ahead) */
  range_start?: string; range_end?: string; range_end_offset?: string;
  /** value at a time (aggregation value_at): an exact time (ISO), a signed duration from now (-7d) or now (empty), and
   * the interpolation (series: the series' own; previous / next / nearest point; linear between two points) */
  value_at?: string; value_at_interpolation?: TsValueAtInterpolation;
};
export type TsValueAtInterpolation = "series" | "linear" | "previous" | "next" | "nearest";
/** The summarizer aggregations (the Workshop time series doc's list, and the value at a time). */
export type TsAggregation = "last" | "first" | "min" | "max" | "mean" | "sum" | "count" | "std" | "difference" | "relative_difference" | "integral" | "product" | "time_weighted_average" | "value_at";
/** A time series transform of a column: rolling / cumulative / periodic aggregate, derivative, integral, formula ($X the
 * input, $A the property, @name an object property) or time shift. */
export type TsTransform = {
  type: "rolling" | "cumulative" | "periodic" | "derivative" | "integral" | "formula" | "shift" | "time_range";
  window?: string; period?: string; aggregation?: string; unit?: string; method?: "linear" | "left" | "right"; formula?: string; by?: string;
  /** periodic: the alignment timestamp (ISO) and the window type (a point is its period's start, or its end) */
  align?: string; window_type?: "start" | "end";
  /** time range: exact start / end (ISO), or relative: the last <n><unit>, ending `end_offset` from now */
  start?: string; end?: string; last?: string; end_offset?: string;
};
/** A time series cell; a value change cell also carries both summaries and the change (absolute and %). */
export type TsCellData = {
  value?: number | null; unit?: string | null; points?: [string, number][]; error?: string;
  current?: number | null; previous?: number | null; change?: number | null; change_pct?: number | null;
  /** value at a time: the time of the value (and of the previous value of a value change), ISO */
  at?: string; previous_at?: string;
};
/** The options of a time series column the API reads (only those set, so original columns send what they did). */
export type TsColumnRequest = {
  id: string; property: string; aggregation?: string; range_last?: string; buckets?: number; rolling?: string; rolling_agg?: string;
  transforms?: TsTransform[]; summarizer?: string; change_as?: string; change_offset?: string; integral_unit?: string;
  range_start?: string; range_end?: string; range_end_offset?: string; value_at?: string; value_at_interpolation?: string;
};
export type Metric ="count" | "sum" | "avg" | "min" | "max" | "distinct";
export type WidgetConfig = {
  source?: SourceRef;
  /** transcription widget: the spoken language (empty: detected) */
  language?: string;
  /** image annotation: the annotation object type, its property naming the image object, the box (JSON {x, y, w, h} as
   * fractions of the image) and the label; new boxes run the create action (action_type_id) with those parameters */
  annotation_type_id?: string;
  annotation_link?: string;
  annotation_box?: string;
  annotation_label?: string;
  /** image annotation: the drawing tools offered (empty: all — rectangle, polygon, point, and text on PDFs; geometry in the
   * box property: rectangles {x, y, w, h}, {"type": "polygon", "points": [[x, y], …]}, {"type": "point", x, y},
   * {"type": "text", page, start, end, quote, boxes}), and the modify / delete actions on a selected annotation (none:
   * no editing / no delete) */
  annotation_tools?: ("rect" | "polygon" | "point" | "text")[];
  annotation_modify_action?: string;
  annotation_delete_action?: string;
  /** custom widget: the widget set, its widget and version (empty: latest), parameter and event bindings, the
   * iframe permissions granted, auto height (customWidgets/CustomWidgetHost.tsx) */
  custom_set_id?: string;
  custom_widget_id?: string;
  custom_version?: string;
  custom_params?: Record<string, unknown>;
  custom_events?: Record<string, unknown[]>;
  custom_permissions?: string[];
  custom_auto_height?: boolean;
  /** fixed query criteria from the originating Contour analysis */
  filters?: Filter[];
  filter_mode?: "all" | "any";
  join?: JoinSpec;
  derived?: DerivedColumn[];
  search?: string;
  columns?: string[];
  sort?: string;
  descending?: boolean;
  limit?: number;
  metric?: Metric;
  metric_column?: string;
  group_by?: string;
  bucket?: "day" | "month" | "year";
  column?: string;
  text?: string;
  action_type_id?: string;
  label?: string;
  /** time series widgets: TSPs ("sensor:<name>" for linked sensors) of the object type source */
  tsps?: string[];
  /** a fixed object; else the object selected in a table on the same object type */
  object_pk?: string;
  /** rolling transform of a time series set (window, e.g. 7d) */
  rolling?: string;
  rolling_agg?: string;
  /** time range: the last 1h / 1d / 7d / 30d (empty: all) */
  range_last?: string;
  ts_aggregation?: TsAggregation;
  /** the time series Metric Card's summary, as a table column's (TsColumn): transforms after the rolling window, the
   * value change summarizer, the integral's unit and a custom range */
  ts_transforms?: TsTransform[];
  ts_summarizer?: "single" | "value_change";
  ts_change_as?: "absolute" | "percent";
  ts_change_offset?: string;
  ts_integral_unit?: string;
  range_start?: string;
  range_end?: string;
  range_end_offset?: string;
  ts_value_at?: string;
  ts_value_at_interpolation?: TsValueAtInterpolation;
  analysis_id?: string;
  derived_type?: "templated" | "single" | "";
  derived_root?: string;
  derived_bound?: string;
  disable_create?: boolean;
  empty_header?: string;
  empty_description?: string;
  /** function widget: a published function, its version (range), fixed inputs and the input fed the selected object */
  function_id?: string;
  function_version?: string;
  function_inputs?: Record<string, string>;
  /** function widget: object inputs typed by an interface (interface:X, array<interface:X>, interface_set:X), fed from
   * the selection of an interface-sourced widget or an implementing type's, or from an object / object set variable */
  function_object_inputs?: Record<string, ObjectInputBinding>;
  /** button: the action runs on the object selected in a widget on this interface source (any implementing type):
   * the interface's action type constraint mapped by the selected object's type, the type's action in action_by_type,
   * an interface action (an interface reference parameter) or action_type_id when it belongs to the selected type */
  action_interface_id?: string;
  action_constraint?: string;
  action_by_type?: Record<string, string>;
  /** function widget: the module variable its output is written to */
  output_variable?: string;
  object_type_id?: string;
  object_input?: string;
  /** object tables: a function-backed column (a function taking an object set and returning Map<Object, value>) */
  column_function_id?: string;
  column_function_input?: string;
  column_function_label?: string;
  /** semantic search box: the embedding (vector property), how many results and how they are ranked */
  semantic_property?: string;
  semantic_k?: number;
  semantic_mode?: "semantic" | "keyword" | "hybrid";
  placeholder?: string;
  /** tabs widget: its tabs (children have parent "<widget id>:<tab id>") */
  tabs?: { id: string; name: string }[];
  /** input widgets: the module variable they write, options (selector) and the source column offering them */
  variable?: string;
  options?: string[];
  options_column?: string;
  multiple?: boolean;
  /** buttons: what a click does; button groups: several buttons */
  events?: WsEvent[];
  buttons?: { label: string; events: WsEvent[]; style?: "primary" | "secondary" }[];
  /** table / list: what selecting a row does (besides selecting it) */
  on_select?: WsEvent[];
  /** object list: the property shown under the title */
  subtitle_property?: string;
  /** property list, object list, object table: show property security markings (responsive is not offered for tables) */
  security_markings?: "responsive" | "full" | "icon";
  /** property list: the properties shown (empty: all) */
  properties?: string[];
  /** linked objects: the link type to follow from the selected object */
  link_type_id?: string;
  /** pivot table */
  pivot_rows?: string;
  pivot_columns?: string;
  /** embedded module: the module and the values of its variables (constants, $var:name or {{templates}}) */
  module_id?: string;
  module_params?: Record<string, unknown>;
  /** iframe: the URL ({{variables}} allowed) */
  url?: string;
  /** tabs: a string variable backing the selected tab (both ways) */
  tab_variable?: string;
  /** conditional visibility: hide the widget when the variable is true (or false with hide_when false) */
  hide_if?: { variable: string; when?: boolean };
  /** value formatting per column (metric cards: the "" key) and conditional formatting rules */
  formats?: Record<string, ValueFormat>;
  rules?: FormatRule[];
  /** object table: time series property columns; time series metric card: a sparkline under the value */
  ts_columns?: TsColumn[];
  ts_sparkline?: boolean;
  /** time series metric card: a color scale on the value or a measure of its series (fixed bounds) */
  ts_color_scale?: TsColorScale;
  /** loop layout: over an array variable or an object set (the source and its filters), one embedded module per item */
  loop_mode?: "array" | "objects";
  loop_variable?: string;
  loop_interface?: string;
  paging?: "limit" | "paged";
  per_page?: number;
  display?: "list" | "grid";
  grid_columns?: number;
  /** section: how its children are laid out, and whether it collapses (collapsed: the initial state) */
  section_layout?: SectionLayout;
  collapsible?: boolean;
  collapsed?: boolean;
  /** object set title: one object (the selected one) or the type and count; title override; render when empty */
  single_object?: boolean;
  title_override?: string;
  show_icon?: boolean;
  render_empty?: boolean;
  /** vega chart: Vega-Lite or Vega, the spec (inline or a string variable), data inputs, theme, selection parameters */
  vega_mode?: "vega-lite" | "vega";
  spec?: string;
  spec_variable?: string;
  vega_inputs?: VegaInput[];
  vega_theme?: "default" | "none";
  vega_params?: { name: string; variable: string }[];
  /** map: base map, object layers, events when an object is selected */
  basemap?: string;
  map_layers?: MapLayer[];
  map_overlays?: MapOverlay[];
  map_template?: MapTemplate;
  /** the legend panel: shown unless false, collapsed at first when map_legend_collapsed */
  map_legend?: boolean;
  map_legend_collapsed?: boolean;
  /** advanced selection tools: a box select tool in the map's toolbar (the objects a dragged box meets) */
  map_selection_tools?: boolean;
  /** map drawing: the shape kinds offered in the toolbar (none: no drawing), drawn shapes' color / fill opacity, the
   * drawn shapes and selected shape string variables (GeoJSON, both ways; features or geometries), events when a shape
   * is drawn, single draw mode, splitting at the antimeridian (default on), shape-based selection (Select within) and
   * clearing the shapes after it */
  map_draw_kinds?: ("point" | "line" | "polygon")[];
  map_draw_color?: string;
  map_draw_opacity?: number;
  map_draw_variable?: string;
  map_draw_selected_variable?: string;
  map_draw_output?: "feature" | "geometry";
  map_on_draw?: WsEvent[];
  map_draw_single?: boolean;
  map_draw_split?: boolean;
  map_shape_selection?: boolean;
  map_draw_clear_after?: boolean;
  /** map measurements of drawn shapes (geodesic): line lengths and polygon perimeters (total or per segment), areas */
  map_measure?: { line?: "total" | "segments"; perimeter?: "total" | "segments"; area?: boolean; units?: "metric" | "imperial" };
  /** map timeline: a time window over the layers' time_column (objects outside it hidden; "cumulative": everything up to
   * its end), open at first unless false, locked: users cannot move it; the window's start / end variables (both ways),
   * playback state (boolean) and position (number, epoch ms) variables, the step interval while playing */
  map_timeline?: boolean;
  map_timeline_open?: boolean;
  map_timeline_locked?: boolean;
  map_time_mode?: "window" | "cumulative";
  map_time_zone?: "local" | "utc";
  map_time_start_variable?: string;
  map_time_end_variable?: string;
  map_play_variable?: string;
  map_play_position_variable?: string;
  map_play_interval?: number;
  /** map shape editing tools: a Modify tool (move / reshape / add / remove vertices of drawn shapes, written back) */
  map_shape_edit?: boolean;
  /** geospatial object search: Search within sends the drawn shape to the server's geo filter (every object of a layer's
   * source that meets it, not only the loaded ones), shows and selects what it finds (map_draw_clear_after clears the
   * drawn shapes after it too) */
  map_geo_search?: boolean;
  /** load the objects in view: each layer's query is filtered on the server to the map's viewport (again after a move) */
  map_load_in_view?: boolean;
  /** map timeline: the selected time (the window's end) as a timestamp / date / number variable (both ways), the View
   * latest toggle (live mode: the window ends at the newest time), the 12 / 24-hour clock for the local time zone, and
   * an array of times at which playback pauses */
  map_selected_time_variable?: string;
  map_time_live?: boolean;
  map_time_format?: "local" | "12h" | "24h";
  map_auto_pause_variable?: string;
  /** gantt / timeline: time properties, label, grouping, color, stacking and display */
  start_column?: string;
  end_column?: string;
  label_column?: string;
  group_column?: string;
  no_end?: "exclude" | "point";
  stacking?: "new_rows" | "overlap" | "smart";
  show_now?: boolean;
  color?: string;
  hover_columns?: string[];
  order?: "newest" | "oldest";
  orientation?: "vertical" | "horizontal";
  show_gaps?: boolean;
  /** gantt: data layers (several object types on one chart; none: the widget's own source and columns as one layer),
   * the time zone the axis and labels use (local, a static IANA zone, or a string variable holding one), the timeline
   * start / end as timestamp variables (both ways: they set the window, panning / zooming writes them), row order and
   * the width of the group column */
  gantt_layers?: GanttLayer[];
  tz_mode?: "local" | "static" | "dynamic";
  time_zone?: string;
  time_zone_variable?: string;
  window_start_variable?: string;
  window_end_variable?: string;
  row_order?: "alpha" | "start";
  group_width?: number;
  /** timeline: layers (several object types; none: the widget's own source as one layer), the legend (layers shown /
   * hidden by the viewer; show_legend, off unless true), the active object output (an object set variable),
   * highlight of the selected event */
  timeline_layers?: TimelineLayer[];
  active_variable?: string;
  highlight_selection?: boolean;
  /** stepper: linear or not, its steps, colors, and a variable holding the active step index */
  stepper_type?: "linear" | "non_linear";
  steps?: Step[];
  step_icons?: boolean;
  completed_color?: string;
  active_color?: string;
  step_variable?: string;
  /** comments: on the selected object of the source (or object_pk), object references, events after commenting and
   * on selecting a reference, the action log in the same feed */
  ref_object_type_id?: string;
  ref_events?: WsEvent[];
  comment_events?: WsEvent[];
  show_action_log?: boolean;
  /** comments: Send default notifications off (the thread's subscribers are not notified; @mentions still are) */
  comment_no_notify?: boolean;
  /** comments: an action applied after each comment; parameter values may be the comment's special values
   * "$comment:text", "$comment:users" (users to notify: the thread's subscribers), "$comment:object" (the parent
   * object's primary key), "$comment:author", or $var:name / literals */
  comment_action?: { action_type_id: string; parameters: Record<string, unknown> };
  /** inline action: one or more action types, parameter defaults ($var:name allowed), title, header, success events */
  action_ids?: string[];
  action_defaults?: Record<string, unknown>;
  action_title?: string;
  hide_header?: boolean;
  on_submit?: WsEvent[];
  /** inline action: the layout (a form, or a table of rows applied together), whether users switch it, add / remove
   * rows and upload a CSV of rows (table), rows pre-filled from an object set variable into an object parameter
   * (table), and an action whose submission criteria fail shown disabled (default) or hidden */
  action_layout?: "form" | "table";
  allow_layout_switch?: boolean;
  allow_row_changes?: boolean;
  allow_csv_upload?: boolean;
  prefill_variable?: string;
  prefill_param?: string;
  invalid_state?: "disabled" | "hidden";
  /** AIP chatbot: an AIP Agent Studio agent, reasoning shown or not, application state shared (read, or read and
   * write: the agent may set the variable, values of another type are refused), the textbox variable (sends when
   * changed from outside), the variable receiving the last answer */
  agent_id?: string;
  show_reasoning?: boolean;
  app_state?: { variable: string; description?: string; access?: "read" | "read_write" }[];
  textbox_variable?: string;
  answer_variable?: string;
  /** AIP generated content: direct to an LLM (a prompt with {{variables}} or a string variable) or an AIP Logic
   * function; the output variable, button label, title, loading message / spinner, clear when the prompt changes */
  content_mode?: "llm" | "logic";
  prompt?: string;
  prompt_variable?: string;
  model?: string;
  /** direct to an LLM: 0 (focused) … 1 (random); empty: 0 */
  temperature?: number;
  logic_id?: string;
  logic_inputs?: Record<string, unknown>;
  button_label?: string;
  content_title?: string;
  loading_message?: string;
  spinner?: boolean;
  clear_on_change?: boolean;
  /** data widgets: object set filter variables applied to the source (each one must hold) */
  filter_variables?: string[];
  /** filter list: the filters shown, whether users add / remove them, vertical or pills, the output filter variable */
  filter_items?: FilterItem[];
  allow_add?: boolean;
  filter_layout?: "vertical" | "pills";
  filter_output?: string;
  /** exploration filter pills / search bar: what users may change, operators, the object type pill, the bar's options */
  pills_mode?: "read" | "remove" | "update" | "add";
  fixed_operator?: boolean;
  show_type_pill?: boolean;
  show_clear?: boolean;
  no_autocomplete?: boolean;
  no_keyword?: boolean;
  /** prominent terms: the property, its terms (value, display name, icon), hide terms without results */
  term_column?: string;
  terms?: { value: string; label?: string; icon?: string }[];
  hide_empty?: boolean;
  /** object view: the full object page (embedded) or a panel (one object, or the set's aggregates) */
  form_factor?: "full" | "panel";
  panel_behavior?: "instance" | "adaptive" | "set";
  initial_tab?: string;
  /** object view mode: the standard view (default: the visible properties in the panel, the object page in full) or the
   * object type's configured Object View (its panel properties, its published tabs); view_mode_toggle lets viewers switch */
  view_mode?: "standard" | "configured";
  view_mode_toggle?: boolean;
  /** full object view: hide the tabs, go back to the initial tab when the object changes, and per Workshop tab of the
   * configured view, its module's interface variables set from this module ($var:x, {{x}}, a constant; $object: the
   * object's primary key) — the module then runs inside the tab */
  hide_tabs?: boolean;
  reset_tab?: boolean;
  tab_interfaces?: Record<string, Record<string, unknown>>;
  empty_message?: string;
  /** edit history: order and the properties shown (empty: all) */
  history_order?: "newest" | "oldest";
  history_props?: string[];
  /** action log timeline: the action types shown (empty: all) */
  log_actions?: string[];
  /** linked resources and media uploader: the Files folder uploads go to (or a string variable holding its ID) */
  upload_folder?: string;
  upload_folder_variable?: string;
  hide_upload?: boolean;
  hide_link?: boolean;
  /** media uploader: the button, allowed extensions, several files, outputs, an action per file (the file's ID in
   * upload_param, other parameters from action_defaults) */
  button_text?: string;
  intent?: "none" | "primary" | "success" | "warning" | "danger";
  left_icon?: string;
  right_icon?: string;
  extensions?: string;
  multi?: boolean;
  max_files?: number;
  rid_variable?: string;
  filename_variable?: string;
  upload_action?: string;
  upload_param?: string;
  /** resource list: Files resources, object types or object sets; static items or dynamic content; format and style */
  list_type?: "files" | "object_types" | "object_sets";
  list_content?: "static" | "recent" | "favorite" | "folder" | "tags" | "all" | "prominent";
  resource_items?: ResourceItem[];
  /** Files resources: the "Tags" content's tags (resources having one of them), each item's tags shown as chips, and a
   * tag bar viewers filter the list with (items having one of the picked tags) */
  resource_tags?: string[];
  show_tags?: boolean;
  tag_filter?: boolean;
  item_format?: "list" | "cards";
  item_style?: "minimal" | "classic" | "prominent";
  selected_type_variable?: string;
  /** a star on each item: an object type's is the viewer's favorite object type, a Files item's is its star in Files */
  favorite_toggle?: boolean;
  /** image cards: image files show themselves as the thumbnail (default on; false: their icon) */
  image_thumbnails?: boolean;
  /** resource list: every item's icon colour (an item's icon_color wins; empty: an object type's colour, else the theme's) */
  icon_color?: string;
  /** media uploader: where the files go — a Files folder (default) or a media set (media_set, or a string variable
   * holding its ID); a transactional media set gets one transaction per click, committed after the last file */
  upload_target?: "folder" | "media_set";
  media_set?: string;
  media_set_variable?: string;
  /** markdown: object references (:objectreference[text]{objectType="…" primaryKey="…"}) — colors per object type,
   * events on selection and the highlight behavior — and annotation objects over the text */
  md_ref_colors?: Record<string, string>;
  md_ref_events?: WsEvent[];
  md_select?: "none" | "last" | "selected";
  md_annotation?: MdAnnotation;
  /** PDF viewer and video display: a Files item / media reference (static or a variable), else the selected object's
   * media property (column); the page and initial search variables; annotation objects on the PDF */
  media_ref?: string;
  media_ref_variable?: string;
  page_variable?: string;
  search_variable?: string;
  pdf_annotation?: PdfAnnotation;
  /** PDF viewer: a passage to find in the text layer, highlight and scroll to — a property of the selected object (a
   * semantic search chunk's text) or a string variable */
  pdf_highlight_prop?: string;
  pdf_highlight_variable?: string;
  /** video display: seek to a numeric variable, key frames (an interval, a numeric array variable or scene changes) */
  seek_variable?: string;
  frames?: "none" | "1" | "5" | "10" | "60" | "custom" | "advanced";
  frames_variable?: string;
  sensitivity?: "less" | "standard" | "more";
  /** observability chart: a function or an action type, the metric, the time range variables (brushing sets them) */
  obs_kind?: "function" | "action";
  obs_id?: string;
  obs_metric?: "executions" | "p95";
  start_variable?: string;
  end_variable?: string;
  show_legend?: boolean;
  /** free-form analysis: the empty state, path saving, the output filter variable (the path's filters) */
  empty_title?: string;
  path_saving?: boolean;
  /** free-form analysis: Copy to Notepad on a saved analysis path */
  notepad_copy?: boolean;
  /** AIP analyst: the model (empty: the default) and starter questions */
  analyst_model?: string;
  starters?: string[];
  /** scenarios [Legacy]: load the widget's data from a scenario (a scenario variable); a table compares a scenario array;
   * actions apply to a scenario; the manager's static / dynamic / active scenarios; the selector's candidates and output */
  scenario_variable?: string;
  scenario_compare?: string;
  apply_to_scenario?: string;
  static_scenarios?: string;
  dynamic_scenarios?: string;
  active_scenario?: string;
  scenario_candidates?: string;
  scenario_output?: string;
  scenario_multi?: boolean;
  /** the manager's Save scenario: the scenario object type (an ID property with scenarios:versioned-scenario-rid, a name
   * with scenarios:scenario-name) and its create / update actions; unset: Save only persists the scenario */
  scenario_save_type?: string;
  scenario_save_create_action?: string;
  scenario_save_update_action?: string;
  /** QR Code Reader: QR codes or barcodes (of these formats), one code (a string) or several (a string array), a
   * confirmation before each scan, the button opening the camera, events after scanning */
  qr_kind?: "qr" | "barcode";
  barcode_formats?: string[];
  qr_multiple?: boolean;
  qr_prompt?: boolean;
  qr_output?: string;
  qr_button?: { label?: string; icon?: string; style?: "primary" | "secondary" | "minimal"; large?: boolean; fill?: boolean };
  qr_events?: WsEvent[];
  /** Current Location Manager: "lat,long" into a string variable; the label; hide the preview; the nearest place of the
   * widget's source (label / latitude / longitude columns) in the preview */
  location_output?: string;
  location_label?: string;
  hide_location?: boolean;
  place_label?: string;
  place_lat?: string;
  place_lon?: string;
  /** display optimization: when the widget mounts (normal, once on screen, at module load) and unmounts (normal,
   * when off screen, never) */
  mount?: "normal" | "delay" | "eager";
  unmount?: "normal" | "offscreen" | "never";
  /** sections as drop zones: dropped objects (or an object set) into a variable, then events */
  drop_handling?: boolean;
  drop_label?: string;
  drop_icon?: string;
  drop_output?: string;
  drop_events?: WsEvent[];
  /** object set title, object table rows and the object view as drag zones */
  enable_drag?: boolean;
  /** Notepad: Linked documents — the object type whose selected object's documents are listed, how they are shown,
   * the fields shown, the default sort; np_variable: the Active Notepad output (the selected document's rid) */
  np_object_type_id?: string;
  np_display?: "list" | "cards" | "table";
  np_fields?: ("author" | "updated" | "location")[];
  np_sort?: "updated" | "name" | "author";
  np_sort_asc?: boolean;
  /** Notepad widgets: the string variable holding a document rid (linked documents write it; embedded document and
   * export button read it), or a fixed document (np_document: a rid or Files item id) */
  np_variable?: string;
  np_document?: string;
  /** Notepad: Embedded document — a reduced editor instead of read-only */
  np_allow_edit?: boolean;
  /** Notepad: New Notepad button — from templates (each with a version and its inputs linked to variables) or from a
   * string variable (Markdown or plain text); save options, on-click options, the Created document output, events */
  np_mode?: "template" | "string";
  np_templates?: NotepadTemplateRef[];
  np_string_variable?: string;
  np_string_format?: "markdown" | "plain";
  np_choose_location?: boolean;
  np_save_name?: string;
  /** a Files folder id, or "$var:name" of a string variable holding one */
  np_save_folder?: string;
  np_export_pdf?: boolean;
  np_open_new_tab?: boolean;
  np_created_variable?: string;
  np_events?: WsEvent[];
  /** Notepad buttons: the text; export button: the file name and format */
  np_button_text?: string;
  np_filename?: string;
  np_format?: "pdf" | "docx";
  /** Vertex: Graph — a saved graph or graph template (fixed, or its id in a string variable); a template's parameters
   * (parameter id -> an object set variable); a variable whose change reloads the graph */
  vx_graph_id?: string;
  vx_graph_variable?: string;
  vx_parameters?: Record<string, string>;
  vx_refresh_variable?: string;
  /** Vertex: Graph — the object type the outputs carry (unset: every type); outputs: the selected objects as an object
   * set variable and as an object set filter variable, every object drawn; input: the objects to highlight */
  vx_object_type_id?: string;
  vx_selected_variable?: string;
  vx_selected_filter_variable?: string;
  vx_objects_variable?: string;
  vx_highlight_variable?: string;
  vx_events?: WsEvent[];
  /** Vertex: Graph — the Open in Vertex link (default on) */
  vx_open_in_vertex?: boolean;
  /** Vertex: Graph — "Zoom to object set": the view fits the objects of this variable (of one object type when one is
   * chosen) whenever its value changes */
  vx_zoom_variable?: string;
  vx_zoom_object_type_id?: string;
  /** Vertex: Graph — "Available actions" on the selected object: none (default), the chosen ones, or every action of
   * the object's type; events run after an action is applied */
  vx_actions?: "none" | "some" | "all";
  vx_action_ids?: string[];
  vx_action_events?: WsEvent[];
  /** Vertex: Graph — Search Around from the selected objects adds objects to the widget's graph (not saved); output:
   * the objects added */
  vx_search_around?: boolean;
  vx_added_variable?: string;
  /** Vertex: Graph — "Saving settings": save the current graph as a new graph (never over the configured one); the
   * default name ({{variable}} filled), a string variable receiving the new graph's id, events run after saving */
  vx_save?: boolean;
  vx_save_name?: string;
  vx_saved_variable?: string;
  vx_save_events?: WsEvent[];
  /** Vertex: Graph — "Sub-graph": only the connected parts of the graph that hold an object of this variable are shown
   * (of one object type when one is chosen; empty, or none of them on the graph: the whole graph) */
  vx_subgraph_variable?: string;
  vx_subgraph_object_type_id?: string;
  /** Vertex: Graph — sub-graph selection tools (default on): box select (Shift-drag, or the Box select mode) and Select
   * neighbours / connected / same type / all / invert; per-type outputs: object type id -> an object set variable
   * receiving the selected objects of that type */
  vx_select_tools?: boolean;
  vx_type_outputs?: Record<string, string>;
  /** Vertex: Graph — "Time configuration": the selected time (a date or timestamp variable: readouts are read as of it,
   * event badges count the events until it) and the time window (two variables: the related events and readouts of the
   * window, objects whose own times all fall outside it faded unless vx_time_fade is false); the time selection panel
   * lets the user change both (written to the variables, else kept in the widget) */
  vx_time_kind?: "date" | "timestamp";
  vx_time_variable?: string;
  vx_window_kind?: "date" | "timestamp";
  vx_window_start_variable?: string;
  vx_window_end_variable?: string;
  vx_time_fade?: boolean;
  vx_time_panel?: boolean;
  /** Vertex: Graph — "Add objects to subgraph": the objects of this variable are drawn on the graph (and on the shown
   * sub-graph) while the variable holds them, placed beside the objects they link to; primary keys are of
   * vx_add_object_type_id (values that carry their own object type keep it). Kept in the widget, never saved. */
  vx_add_variable?: string;
  vx_add_object_type_id?: string;
  /** Vertex: Graph — "Enable export as PNG": a button downloads the whole graph as drawn as a PNG image */
  vx_export_png?: boolean;
  /** Machinery — the resource and its process (unset: the first); the input object set of the root process */
  mc_machinery_id?: string;
  mc_process_id?: string;
  mc_input_variable?: string;
  /** Machinery — the metric views offered (unset: all four) and the one shown first; Sankey edges (default on);
   * deviating objects counted in the metrics */
  mc_views?: MachineryView[];
  mc_view?: MachineryView | `custom:${string}`;
  mc_sankey?: boolean;
  mc_deviations?: boolean;
  /** Machinery — the output object set (the objects in the selected states / transitions) as an object set variable
   * and as an object set filter variable; node selection: currently / ever in the states; edge selection: ever went
   * through / the last transition */
  mc_output_variable?: string;
  mc_output_filter_variable?: string;
  mc_state_mode?: "current" | "ever";
  mc_transition_mode?: "ever" | "last";
  mc_events?: WsEvent[];
  /** Machinery — custom metric views offered beside the preconfigured ones (mc_view "custom:<id>" shows one first) */
  mc_custom_views?: MachineryCustomView[];
  /** Machinery — more processes of the resource shown in the widget (one tab each), each with its own input and outputs;
   * the first process is mc_process_id with mc_input_variable / mc_output_variable / mc_output_filter_variable */
  mc_more_processes?: MachineryProcessCfg[];
  /** Machinery — the path explorer beside the graph (default on): the paths the objects took; selected paths are the output */
  mc_path_explorer?: boolean;
  /** Machinery — the duration distribution beside the graph (default on): the durations of the selection as a histogram
   * with percentiles; selected buckets narrow the output */
  mc_duration_distribution?: boolean;
  /** Machinery — node metrics pinned by default (view keys: a preconfigured view or "custom:<id>"), shown on every node
   * beside the active view; a viewer's own pins (kept in their browser) replace them */
  mc_pinned?: string[];
  /** Machinery — graph features' defaults (each toggled in the widget header): transition nodes (the process' actions
   * drawn as nodes in place of the state transitions they cause; default off) and subprocesses (each state drawn with
   * the graphs of its direct subprocesses inside, counted under it; default off: the implicit state transitions only) */
  mc_transition_nodes?: boolean;
  mc_subprocesses?: boolean;
  /** Scheduling Gantt / Scheduling Calendar — the Dynamic Scheduling board shown; the time window (the Gantt's range,
   * the calendar's first date): fixed dates or date variables, unset: the board's timeline; times in the viewer's
   * time zone (default) or UTC */
  ds_board_id?: string;
  ds_start?: string;
  ds_end?: string;
  ds_start_variable?: string;
  ds_end_variable?: string;
  ds_timezone?: "local" | "utc";
  /** Scheduling widgets — pucks can be moved (Gantt: default on; calendar: default off); the variable holding the
   * scenario the moves are staged in (unset: saved directly); Gantt: suggestion slots for the selected puck; the
   * unscheduled list (default on) */
  ds_editable?: boolean;
  ds_scenario_variable?: string;
  ds_suggestions?: boolean;
  ds_show_unscheduled?: boolean;
  /** Scheduling Calendar — the view shown first, the first day of the week (0 Sunday, 1 Monday: default) and the
   * hours of the week and day views */
  ds_view?: "month" | "week" | "day";
  ds_week_start?: 0 | 1;
  ds_start_hour?: number;
  ds_end_hour?: number;
  /** Scheduling widgets — outputs: the selected schedule object in an object set / array / string variable and as
   * an object set filter variable; events on selection change */
  ds_selected_variable?: string;
  ds_selected_filter_variable?: string;
  ds_events?: WsEvent[];
  /** Scheduling widgets — the search results (the search bar on Enter, a right-click search) as an object set / array
   * / string variable and as an object set filter variable */
  ds_search_variable?: string;
  ds_search_filter_variable?: string;
  /** Scheduling Gantt — the grid lines' unit (unset: automatic days and hours) */
  ds_grid?: "15m" | "30m" | "1h" | "2h" | "3h" | "6h" | "12h" | "1d" | "1w" | "1M";
  /** Scheduling widgets — operating hours: non-operating time is shaded. daily: the hours every day; weekdays: the
   * hours on the chosen weekdays (0 Sunday … 6 Saturday), other days closed; ranges: only the given ranges operate;
   * rule: the hours of the board's first enabled working-hours rule (UTC) */
  ds_operating?: { kind: "daily" | "weekdays" | "ranges" | "rule"; start_hour?: number; end_hour?: number; days?: number[]; ranges?: { start: string; end: string }[] };
  /** Scheduling widgets — drag to create (Gantt: Shift + drag on a row; calendar: Shift + drag in the week / day
   * view): a create action on the schedule object type, its start / end / resource parameters filled in; minutes a
   * right-click "Create here" spans; apply without the form when it is valid */
  ds_create_action_id?: string;
  ds_create_minutes?: number;
  ds_create_immediately?: boolean;
  /** Scheduling Gantt — right-click menus: items running an action (the puck / row object and the times filled in)
   * or Workshop events; the search function of the menus (unset: the built-in search) */
  ds_puck_menu?: { label: string; action_id?: string; events?: WsEvent[] }[];
  ds_row_menu?: { label: string; action_id?: string; events?: WsEvent[] }[];
  ds_search_function_id?: string;
  /** Scheduling Gantt — the selected row (a resource's primary key) in a string / array / object set variable; events
   * when a row header is selected */
  ds_row_variable?: string;
  ds_row_events?: WsEvent[];
  /** Rule Editor / Proposal Reviewer — the Foundry Rules workflow; the widget's own list with filters (default on;
   * off: the rule / proposal comes from the variable) */
  fr_workflow_id?: string;
  fr_show_list?: boolean;
  /** Rule Editor — the selected rule (input and output) and the proposal Submit changes creates (output); Proposal
   * Reviewer — the selected proposal (input and output) and its rule (output). A string variable holds the id, an
   * array / object set the id in a list, a struct the record's fields (a rule's custom properties as fields) */
  fr_rule_variable?: string;
  fr_proposal_variable?: string;
  /** Rule Editor — optional features: the logic boards offered (unset: the workflow's), Contour import, Create New and
   * Propose delete (default on); read-only is the Rule Viewer */
  fr_boards?: ("filter" | "expression" | "aggregation" | "join" | "window" | "select" | "union" | "link")[];
  fr_contour_import?: boolean;
  fr_allow_create?: boolean;
  fr_allow_delete?: boolean;
  fr_read_only?: boolean;
  /** Proposal Reviewer — the status filter shown first (default open) */
  fr_status?: "open" | "approved" | "rejected" | "all";
  /** Rules widgets — events on selection change; after Submit changes (Rule Editor) / Approve or Reject (Proposal
   * Reviewer) */
  fr_events?: WsEvent[];
  fr_submit_events?: WsEvent[];
  fr_review_events?: WsEvent[];
  /** Vulcan — the model: the first object of a variable (object set / array / string of primary keys) or a fixed CAD
   * object; the CAD object type (unset: any); part coloring from a variable (a list of { partInstanceIds, color,
   * opacity } structs) */
  vc_object_type_id?: string;
  vc_primary_key?: string;
  vc_model_variable?: string;
  vc_part_coloring_variable?: string;
  /** Vulcan — interaction: the selected part (a string variable, both ways), the clicked point (number variables),
   * events on selection change */
  vc_selected_part_variable?: string;
  vc_click_x_variable?: string;
  vc_click_y_variable?: string;
  vc_click_z_variable?: string;
  vc_events?: WsEvent[];
  /** Vulcan — output: a saved or chosen measurement's distance (number, scene units) and formatted with the unit */
  vc_measure_distance_variable?: string;
  vc_measure_unit_variable?: string;
  /** Vulcan — styling: the color of parts without one, the viewport background, the mesh style shown first */
  vc_fallback_color?: string;
  vc_background?: string;
  vc_style?: "normal" | "xray" | "wireframe";
  /** Vulcan — interface and tools (all on by default; false turns one off) */
  vc_show_toolbar?: boolean;
  vc_show_sidebar?: boolean;
  vc_sidebar_expanded?: boolean;
  vc_annotation_tool?: boolean;
  vc_measure_tool?: boolean;
  vc_section_tool?: boolean;
  vc_styling_tool?: boolean;
  vc_coloring_tool?: boolean;
  /** Form embed — the published form; prefilled values (from variables or fixed text); the object it opens for (an
   * object / object set variable and its type: object dropdowns select it, a form writing its type edits it) */
  fe_form_id?: string;
  fe_prefill?: FormEmbedPrefill[];
  fe_object_variable?: string;
  fe_object_type_id?: string;
  fe_require_object?: boolean;
  fe_empty_message?: string;
  /** Form embed — on submit: the response id and the edited / created object into output variables, events, the
   * other widgets reloaded (default on), a new blank response (default on), the message shown */
  fe_response_variable?: string;
  fe_object_output_variable?: string;
  fe_events?: WsEvent[];
  fe_refresh?: boolean;
  fe_reset?: boolean;
  fe_confirmation?: string;
  /** Form embed — display: no title, the progress bar only, the most height before the form scrolls */
  fe_no_header?: boolean;
  fe_progress_only?: boolean;
  fe_max_height?: number;
  /** Program Scheduling — the data layers (each an object type's object set, a puck type and its properties), the
   * properties nesting the rows (each sorted ascending or descending) */
  ps_layers?: ProgramLayerConfig[];
  ps_grouping?: { property: string; descending?: boolean }[];
  /** Program Scheduling — the timeline: fixed dates or date / timestamp variables (unset: the data's extent); times in
   * the viewer's time zone (default) or UTC */
  ps_start?: string;
  ps_end?: string;
  ps_start_variable?: string;
  ps_end_variable?: string;
  ps_timezone?: "local" | "utc";
  /** Program Scheduling — interface: groups expanded when the widget loads (default on), dependency arrows hidden at
   * first, the current time line */
  ps_expand_groups?: boolean;
  ps_hide_arrows?: boolean;
  ps_show_now?: boolean;
  /** Program Scheduling — editing: drag / resize pucks (default on); the snap (default a day); what a move that breaks
   * a dependency does (warn: kept and marked, default; block: refused; push: the later tasks move along); the
   * variable holding the scenario moves are staged in (unset: moves wait for Save changes) */
  ps_editable?: boolean;
  ps_snap?: "none" | "1h" | "1d";
  ps_dependency_mode?: "warn" | "block" | "push";
  ps_scenario_variable?: string;
  /** Program Scheduling — outputs: the selected objects (object set / array / string variable, an object set filter
   * variable), events on selection change; right-click menu items (an action on the puck or Workshop events) */
  ps_selected_variable?: string;
  ps_selected_filter_variable?: string;
  ps_events?: WsEvent[];
  ps_puck_menu?: { label: string; action_id?: string; events?: WsEvent[] }[];
  /** object list: users reorder the cards by dragging; the order (primary keys) into an array variable */
  reorderable?: boolean;
  order_variable?: string;
  /** app pairing: a pairing code shared with other windows; what they keep in sync */
  pairing_code?: string;
  pairing_selection?: boolean;
  pairing_variables?: string[];
  /** data freshness: the object types whose last update is shown (default: the source) */
  freshness_types?: string[];
  /** style formatting: header (block / contained / floating), background, border, padding (sections) */
  header_style?: "block" | "contained" | "floating";
  background?: Background;
  border?: "bordered" | "shadow" | "inner" | "none";
  padding?: Padding;
};
export type SectionLayout = "grid" | "rows" | "columns" | "toolbar" | "flow";
/** Vega chart data input: the widget's objects (chosen columns), an aggregation of them, or a struct array variable. */
export type VegaInput = { name: string; kind: "objects" | "aggregation" | "variable"; columns?: string[]; group_by?: string; bucket?: "day" | "month" | "year"; metric?: Metric; metric_column?: string; variable?: string };
/** A Vega data input as the spec generator sees it: its name and fields with their types (no rows). */
export type VegaInputSchema = { name: string; kind: VegaInput["kind"]; fields: { name: string; type: string }[] };
export type VegaGenerateBody = { prompt: string; mode: "vega-lite" | "vega"; inputs: VegaInputSchema[]; params?: string[]; current_spec?: string; model?: string };
/** A checked spec: errors make it unacceptable (not JSON, unknown mark or field, url data / links / addresses), warnings are shown. */
export type VegaSpecCheck = { ok: boolean; spec: Record<string, unknown> | null; errors: string[]; warnings: string[] };
/** A map object layer: its own source and filters, coordinates from latitude / longitude columns or one "lat,lon" column,
 * or shapes from a geoshape column (GeoJSON polygons, lines, multi-geometries, geometry collections). color_by colors
 * points and shapes by a property (categories, or a numeric range on a gradient; a legend); input_variable restricts the
 * layer to an object set variable; selected_variable is the layer's selection (an object set / array / string variable,
 * both ways: clicking writes it, setting it highlights). */
export type MapLayer = {
  label: string; source?: SourceRef; filters?: Filter[]; lat?: string; lon?: string; point?: string; label_column?: string;
  color?: string; radius?: number; rules?: FormatRule[]; visible_variable?: string; locked?: boolean; hover?: string[];
  shape?: string; color_by?: string; color_mode?: "category" | "range" | "bins"; color_from?: string; color_to?: string;
  fill_opacity?: number; line_width?: number; input_variable?: string; selected_variable?: string; hide_in_legend?: boolean;
  /** color_mode "bins" (color classes, a choropleth): how many classes (default 5) and how their edges are spaced */
  color_bins?: number; color_scale?: "linear" | "sqrt" | "log" | "quantile";
  /** range / bins: fixed ends of the scale (default: the lowest and highest value shown) */
  color_min?: number; color_max?: number;
  /** shapes: the outline's color (default: the fill color) */
  outline_color?: string;
  /** the map's timeline: the date / timestamp property placing each object in time */
  time_column?: string;
};
/** A map overlay layer: a layer of a saved map (Map app: tile / WMS / WMTS servers, vector tiles, feature services and
 * GeoJSON, object searches, Enterprise Map Layers, boundaries, rasters; layer_id unset: every layer of the map), or one
 * given here (an XYZ / WMS {bbox-epsg-3857} tile URL, a vector tile URL, a GeoJSON URL or a GeoJSON file in Files). */
export type MapOverlay = {
  label: string; map_id?: string; layer_id?: string;
  tiles?: string; vector_tiles?: string; source_layers?: string; geojson_url?: string; geojson_item?: string;
  color?: string; opacity?: number; visible_variable?: string;
  /** drawn over the object layers (vector layers; tile and raster images stay under them). Overlays draw in list order. */
  above?: boolean;
};
/** Import map template: a saved map's layers, base map and view, its object layers' inputs bound to module object set
 * variables (by layer id), and the selected objects written to a variable. */
export type MapTemplate = { map_id: string; inputs?: Record<string, string>; use_view?: boolean; selected_variable?: string };
export type Step = { label: string; events?: WsEvent[]; completed_variable?: string; icon?: string };
/** A Gantt chart data layer: its own object type (or dataset) and filters, restricted by an object set variable, time
 * range (start / end) or discrete (start only) events; events without an end are excluded, drawn as points, or end at
 * a timestamp variable's value; label, group by, a static color with conditional rules, hover properties; the
 * selection (an object set / array / string variable, both ways) or none when selection is off. */
export type GanttLayer = {
  label: string; source?: SourceRef; filters?: Filter[]; input_variable?: string;
  start_column?: string; end_column?: string; no_end?: "exclude" | "point" | "variable"; end_variable?: string;
  label_column?: string; group_column?: string; color?: string; rules?: FormatRule[]; hover_columns?: string[];
  selectable?: boolean; multiselect?: boolean; selected_variable?: string; on_select?: WsEvent[];
};
/** A Timeline layer: its own object type and filters (an object set variable restricts it), the date / timestamp
 * property, the event title (the object's title property, a property, or custom text with {{property}}), the
 * properties shown (the type's prominent ones or chosen ones), the color (the object type's, static, or conditional
 * rules), the icon (the object type's ontology icon, none, or a custom one), and selection events that replace the
 * widget's. */
export type TimelineLayer = {
  label: string; source?: SourceRef; filters?: Filter[]; input_variable?: string; date_column?: string;
  title_mode?: "object" | "property" | "custom"; title_column?: string; title_text?: string;
  props_mode?: "prominent" | "specific"; props?: string[];
  color_mode?: "default" | "static" | "dynamic"; color?: string; rules?: FormatRule[];
  icon_mode?: "default" | "none" | "custom"; icon?: string; on_select?: WsEvent[];
};

/** Preset background shades (1 lightest … 5 darkest in light mode; reversed in dark mode via the theme tokens). */
export const BACKGROUNDS: Record<string, string> = {
  default: "var(--color-panel)",
  "1": "var(--color-ink)",
  "2": "var(--color-panel)",
  "3": "var(--color-panel-2)",
  "4": "color-mix(in srgb, var(--color-panel-2) 70%, var(--color-line-2))",
  "5": "var(--color-line-2)",
  transparent: "transparent",
};
export const backgroundOf = (b: Background | undefined): string | undefined => (b === undefined ? undefined : BACKGROUNDS[b] ?? b);
/** Padding presets in px: [vertical, horizontal]. */
export function paddingOf(p: Padding | undefined): string | undefined {
  if (p === undefined || p === "none") return undefined;
  if (typeof p === "number") return `${p}px`;
  return { compact: "16px", regular: "24px 48px", large: "40px 62px" }[p];
}
/** parent: "page:<id>" (absent: the first page), "<tabs widget id>:<tab id>", "<section id>:body", "overlay:<id>" or "header" */
/** A document template on a New Notepad button: its published version (latest when unset), the menu name and the
 * module variable each template input takes its value from. */
/** A Machinery widget's metric view: what the state nodes show. */
export type MachineryView = "current_count" | "historical_count" | "current_duration_s" | "historical_duration_s";
/** A Machinery custom view's metric: a metric of POST …/metrics (states: current_count, ever_count, current_share,
 * median_current_duration_s, …; transitions: count, objects, share, mean_duration_s, median_duration_s) or "aggregate":
 * fn of a property over the objects currently in the state / whose last transition it is ("current") or ever in it /
 * through it ("ever"). */
export type MachineryMetric = { metric: string; property?: string; fn?: "sum" | "mean" | "median" | "min" | "max" | "count" | "distinct"; scope?: "current" | "ever" };
/** Number formatting: style (default: duration for durations, percent for shares, else number), decimals, prefix / suffix. */
export type MachineryFormat = { style?: "number" | "compact" | "percent" | "duration"; decimals?: number; prefix?: string; suffix?: string };
/** Conditional coloring: the first rule the node's value meets colors it ("between": value ≤ x ≤ value2). */
export type MachineryColorRule = { op: ">" | ">=" | "<" | "<=" | "=" | "!=" | "between" | "empty"; value?: number; value2?: number; color: string };
export type MachineryCustomView = {
  id: string; name: string; node: MachineryMetric; format?: MachineryFormat; colors?: MachineryColorRule[];
  edge?: MachineryMetric; edge_format?: MachineryFormat; sankey?: boolean;
  /** coloring rules on the edges: the edge metric's value colors the transition (the first rule met) */
  edge_colors?: MachineryColorRule[];
};
export type MachineryProcessCfg = { process_id: string; input_variable?: string; output_variable?: string; output_filter_variable?: string };
export type NotepadTemplateRef ={ item_id: string; name?: string; version?: number; label?: string; inputs?: Record<string, string>; input_types?: Record<string, string> };
export type Widget = { id: string; type: WidgetType; title: string; x: number; y: number; w: number; h: number; config: WidgetConfig; parent?: string };
/** A Form embed's prefilled field: a variable's value (converted to the field) or fixed text; `multiple`: the field
 * takes several values (an object set gives all its objects). */
export type FormEmbedPrefill = { field: string; label?: string; multiple?: boolean; variable?: string; fixed?: boolean; value?: string };
/** A Program Scheduling data layer: the objects of a type (all, or an object set variable's / filter variable's),
 * drawn as standard pucks (bars; dependencies), background pucks (shaded periods, read-only) or event pucks (points in
 * time); the save handler action gets the object and the start / end parameters (the property ids); a static color
 * or the first matching color rule; the properties of the detail card (unset: all). */
export type ProgramLayerConfig = {
  id: string;
  name?: string;
  object_type_id: string;
  puck_type: "standard" | "background" | "event";
  start_property: string;
  end_property?: string;
  dependency_property?: string;
  label_property?: string;
  progress_property?: string;
  save_action_id?: string;
  color?: string;
  color_rules?: { id?: string; name: string; operator: "=" | "!=" | ">" | "<" | "contains" | "empty" | "not_empty" | "violation"; property?: string; value?: unknown; color: string; enabled?: boolean }[];
  object_set_variable?: string;
  filter_variable?: string;
  detail_properties?: string[];
};
export type Module = {
  id: string;
  name: string;
  description: string;
  widgets: Widget[];
  pages?: Page[];
  overlays?: Overlay[];
  variables?: Variable[];
  settings?: ModuleSettings;
  favorite?: boolean;
  /** Files: the module's item, whether the user edits it, its path (in_files false: made before modules were Files items) */
  item_id?: string;
  can_edit?: boolean;
  path?: { id: string; name: string }[] | null;
  in_files?: boolean;
  /** on a global branch: the branch state */
  branch?: BranchState;
  derived?: ModuleDerived[];
  latest_version?: number;
  published_version?: number;
  showing_version?: number;
  created_at: string;
  updated_at: string;
  widget_count?: number;
};
/** Module settings: publishing, kiosk mode, auto-refresh, translations, saved colors, the header. */
/** An object set filter variable's value: property filters (column "__link" for linked objects), all / any, a keyword. */
export type OsFilter = {
  filters: Filter[]; mode?: "all" | "any"; keyword?: string; /** a ranked set (KNN): keys in rank order and their relevance */ order?: string[]; relevance?: Record<string, number>;
  /** the keyword as a substring (simple), in advanced syntax (AND / OR / NOT, brackets, "phrases") or as a regular expression */
  syntax?: KeywordSyntax;
  /** Foundry's starting-filter CONTAIN: "contains" filters match prefixes only (of the value or one of its words) */
  contains_prefix?: boolean;
  /** an empty object set (a KNN variable with no query or no results): no object passes */
  empty?: boolean;
};
export type KeywordSyntax = "simple" | "advanced" | "regex";
/** The filter op of a property keyword in a syntax. */
export const keywordOp = (s: KeywordSyntax | undefined): Filter["op"] => (s === "advanced" ? "search" : s === "regex" ? "regex" : "contains");
export const KEYWORD_OPS: Filter["op"][] = ["contains", "search", "regex", "starts_with"];
/** The columns of a union of object types: common properties (same property ID) once, then each type's own ones, and
 * object_type; `only` names the one type that has a single property. */
export function unionColumns(source: SourceRef | undefined, types: ObjectTypeSource[]): (Column & { only?: string; regex?: boolean })[] {
  if (source?.kind !== "object_types") return [];
  const chosen = source.id.split(",").map((id) => types.find((t) => t.id === id.trim())).filter((t): t is ObjectTypeSource => !!t);
  const out = new Map<string, Column & { only?: string; regex?: boolean; n: number }>();
  for (const t of chosen)
    for (const p of t.properties) {
      const had = out.get(p.name);
      out.set(p.name, had ? { ...had, n: had.n + 1, regex: had.regex || !!p.regex } : { name: p.name, type: p.type, n: 1, only: t.name, regex: !!p.regex });
    }
  const all = [...out.values()].map(({ n, only, ...c }) => ({ ...c, ...(n === 1 && chosen.length > 1 ? { only } : {}) }));
  return [...all.filter((c) => !c.only), ...all.filter((c) => c.only), ...(out.has("object_type") ? [] : [{ name: "object_type", type: "string" }])];
}
/** A ranked object set (a KNN variable's result) as an object set filter: these objects, in this order. */
export const rankedSet = (pks: string[], relevance?: Record<string, number>): OsFilter => ({ filters: [{ column: "__pk", op: "in", value: pks }], order: pks, ...(relevance ? { relevance } : {}) });
/** An empty object set (a KNN variable with no query or no results): widgets on it show no objects. As primary keys
 * (an object set or array variable) it is an empty array marked `empty` (a plain empty array does not filter). */
export const emptySet = (): OsFilter => ({ filters: [], order: [], empty: true });
export const emptyKeys = (): string[] => Object.defineProperty([] as string[], "empty", { value: true, enumerable: false });
export const isEmptySet = (v: unknown): boolean => !!v && typeof v === "object" && (v as { empty?: unknown }).empty === true;
/** One link type read from one side (from_type_id: the object type it starts from, on a union). */
export type LinkRef = { link_type_id: string; direction: "forward" | "reverse"; from_type_id?: string };
/** A linked-object filter's value: one link type (link_type_id + direction), a link per object type of a union (links),
 * every link to an object type (target_type_id), or an interface link type (interface_link: its api name, on an
 * interface source: each implementing type's link for it); with filters on the linked objects, or negated (has no link). */
export type LinkSpec = { link_type_id?: string; direction?: "forward" | "reverse"; links?: LinkRef[]; target_type_id?: string; interface_link?: string; name?: string; filters?: Filter[]; negate?: boolean };
/** A Filter List item's link (FilterItem.link); an interface link keeps each implementing type's link in `links`. */
export type ItemLink = { link_type_id?: string; direction?: "forward" | "reverse"; name?: string; target_type_id?: string; links?: LinkRef[]; every?: boolean; interface_link?: string };
/** The link part of a filter value for an item's link: an interface link, every link to the target, a link per type,
 * or one link type. */
export function linkSpec(l: ItemLink): LinkSpec {
  if (l.interface_link) return { interface_link: l.interface_link, name: l.name };
  if (l.every && l.target_type_id) return { target_type_id: l.target_type_id, name: l.name };
  if (l.links?.length) return { links: l.links.map((x) => ({ link_type_id: x.link_type_id, direction: x.direction })), name: l.name };
  return { link_type_id: l.link_type_id, direction: l.direction, name: l.name };
}
/** The same link (an item's, or a filter value's) whatever the form's extra fields. */
export function linkKey(l: ItemLink | LinkSpec | undefined): string {
  if (!l) return "";
  const s: LinkSpec = (l as ItemLink).every || l.interface_link ? linkSpec(l as ItemLink) : l;
  if (s.interface_link) return `iface:${s.interface_link}`;
  if (s.target_type_id && !s.link_type_id && !s.links?.length) return `to:${s.target_type_id}`;
  if (s.links?.length) return `links:${s.links.map((x) => `${x.link_type_id}:${x.direction}`).sort().join(",")}`;
  return `${s.link_type_id ?? ""}:${s.direction ?? "forward"}`;
}
/** The object types an item's link reaches (with the links of the item's object set). */
export function linkTargets(l: ItemLink, infos: LinkInfo[]): string[] {
  if (l.every) return l.target_type_id ? [l.target_type_id] : [];
  const refs: LinkRef[] = l.links?.length ? l.links : l.link_type_id ? [{ link_type_id: l.link_type_id, direction: l.direction ?? "forward" }] : [];
  const out = refs.map((r) => infos.find((x) => x.link_type_id === r.link_type_id && x.direction === r.direction && (!r.from_type_id || !x.from_type_id || x.from_type_id === r.from_type_id))?.target_type_id);
  const ids = [...new Set(out.filter((x): x is string => !!x))];
  return ids.length ? ids : l.target_type_id ? [l.target_type_id] : [];
}
/** The object types of the object set without the link (they have no linked objects: "has link" drops their objects,
 * "has no link" keeps them all). */
export function linkGaps(memberIds: string[], l: ItemLink, infos: LinkInfo[]): string[] {
  if (memberIds.length < 2) return [];
  const has = (tid: string) =>
    l.every
      ? infos.some((x) => x.from_type_id === tid && x.target_type_id === l.target_type_id)
      : (l.links?.length ? l.links : [{ link_type_id: l.link_type_id ?? "", direction: l.direction ?? "forward" }]).some((r) =>
          infos.some((x) => x.from_type_id === tid && x.link_type_id === r.link_type_id && x.direction === r.direction),
        );
  return infos.length ? memberIds.filter((t) => !has(t)) : [];
}
export type FilterItem = {
  column: string;
  /** timeline: a date / timestamp property as a brushable histogram over time; distribution: a numeric property as a
   * brushable histogram of equal bins (both with from / to inputs; counts follow the other filters) */
  component: "keyword" | "histogram" | "single" | "multi" | "range" | "date_range" | "has_link" | "timeline" | "distribution";
  label?: string;
  /** a timeline's bucket (auto: by the values' range) */
  interval?: "auto" | "day" | "week" | "month" | "year";
  /** a distribution's number of bins, about (default 24; edges are round numbers) */
  bins?: number;
  /** a keyword item: its syntax when the module opens (users switch it in the item), and whether regex is offered */
  syntax?: KeywordSyntax;
  allow_regex?: boolean;
  /** a filter on linked objects: the link, and the linked type's property filtered (none: has link); on a union a link
   * per member type (links) or every link to an object type (every + target_type_id) */
  link?: ItemLink;
};
export type LinkInfo = { link_type_id: string; direction: "forward" | "reverse"; name: string; from_type_id?: string; target_type_id: string; target_name: string; properties: { name: string; label: string; type: string }[] };
export const isOsFilter = (v: unknown): v is OsFilter => !!v && typeof v === "object" && Array.isArray((v as OsFilter).filters);
/** A filter variable's value with its $var: values resolved (an empty one does not filter). */
export function resolveOsFilter(v: unknown, vars: Record<string, unknown>): OsFilter | null {
  if (!isOsFilter(v)) return null;
  const sub = (f: Filter): Filter => ({ ...f, value: f.column === "__link" && f.value && typeof f.value === "object" ? { ...(f.value as LinkSpec), filters: ((f.value as LinkSpec).filters ?? []).map(sub) } : resolveVar(f.value, vars) });
  return { ...v, filters: v.filters.map(sub) };
}
/** The filter sets a data widget's query gets from its filter variables. */
export function filterSets(c: { filter_variables?: string[] }, vars: Record<string, unknown>): OsFilter[] {
  // an object set variable (primary keys, e.g. a KNN result) keeps its objects in its order; an empty KNN result none
  return (c.filter_variables ?? [])
    .map((n) => (Array.isArray(vars[n]) ? ((vars[n] as unknown[]).length ? rankedSet((vars[n] as unknown[]).map(String)) : isEmptySet(vars[n]) ? emptySet() : null) : resolveOsFilter(vars[n], vars)))
    .filter((x): x is OsFilter => !!x && (x.filters.length > 0 || !!x.keyword || !!x.empty));
}
/** Filter value extraction: the variables a default filter uses ($var:name) take the values of the matching filters of
 * the new value (same property; ranges by operator; terms as a list, or the first one); missing ones are cleared. */
export function extractVars(def: OsFilter, val: unknown, defs: Variable[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const now = isOsFilter(val) ? val.filters : [];
  for (const f of def.filters ?? []) {
    if (typeof f.value !== "string" || !f.value.startsWith("$var:")) continue;
    const name = f.value.slice(5).trim();
    const range = ["gt", "gte", "lt", "lte"].includes(f.op);
    // a range end: the same operator, else the same end of the range (a brushed chart sets "from ≤ x < to")
    const hit =
      now.find((x) => x.column === f.column && (range ? x.op === f.op : ["eq", "in", "contains"].includes(x.op))) ??
      (range ? now.find((x) => x.column === f.column && x.op[0] === f.op[0] && ["gt", "gte", "lt", "lte"].includes(x.op)) : undefined);
    const isArray = defs?.find((d) => d.name === name)?.type === "array";
    if (!hit) out[name] = isArray ? [] : undefined;
    else if (Array.isArray(hit.value)) out[name] = isArray ? hit.value : hit.value[0];
    else out[name] = isArray ? [hit.value] : hit.value;
  }
  return out;
}
export const describeFilter = (f: Filter): string => {
  if (f.column === "__link") {
    const l = f.value as LinkSpec;
    return `${l.negate ? "no " : "has "}${l.name ?? "link"}${l.filters?.length ? `: ${l.filters.map(describeFilter).join(", ")}` : ""}`;
  }
  const op = { eq: "is", neq: "is not", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", in: "is any of", is_null: "is empty", not_null: "has a value", starts_with: "starts with", search: "matches", regex: "matches regex", geo: "is in area" }[f.op];
  if (f.op === "geo") return `${f.column} is in area`;
  const v = Array.isArray(f.value) ? f.value.join(", ") : f.value === undefined || f.value === null ? "" : String(f.value);
  return `${f.column} ${op}${f.op === "is_null" || f.op === "not_null" ? "" : ` ${v}`}`;
};
/** A static Resource List item: a Files item, an object type or an object set variable, with display overrides. */
/** One object of an interface: its implementing type and the interface's properties read through that type's mapping
 *  (local: the implementing property, null when unmapped) */
export type InterfaceObject = {
  interface: { id: string; name: string }; object_type: { id: string; display_name: string }; primary_key: string; title: string;
  properties: { name: string; label: string; type: string; local: string | null; value: unknown }[];
};
/** A Files tag (a Compass tag), with its category */
export type FileTag = { id: string; name: string; category: string; category_id: string };
export type ResourceItem = {
  id?: string; variable?: string; title?: string; description?: string; events?: WsEvent[]; visible_variable?: string; icon?: string;
  /** display overrides: the item's own style; image cards: a Files image as its thumbnail, and where it sits */
  style?: "minimal" | "classic" | "prominent"; thumbnail?: string; thumbnail_position?: "top" | "right" | "bottom" | "left";
  /** the icon's colour (a CSS colour), over the list's icon_color and an object type's own colour */
  icon_color?: string;
};
/** Annotations over Markdown text: annotation objects with start (inclusive) and end (exclusive) character indices,
 * those whose link property equals link_value; new ones through an action with the selection's start, end and text. */
export type MdAnnotation = {
  object_type_id: string; start: string; end: string; link_prop?: string; link_value?: string; label?: string; color?: string;
  create_action?: string; start_param?: string; end_param?: string; text_param?: string; link_param?: string; on_select?: WsEvent[];
};
export type EditChange = { at: string; user: string; primary_key: string; op: string; property: string | null; before: unknown; after: unknown };
export type ResourceMeta = { id: string; name: string; kind: string; content_type?: string | null; size?: number | null; updated_at?: string };
/** Annotations on a PDF: objects with a page and bounding boxes (a string array of JSON {x1, y1, x2, y2} as fractions
 * of the page from its top left), those whose link property equals link_value; new ones from an area selection. */
export type PdfAnnotation = {
  object_type_id: string; page_prop: string; boxes_prop: string; link_prop?: string; link_value?: string; label?: string; color?: string;
  create_action?: string; page_param?: string; boxes_param?: string; link_param?: string; on_select?: WsEvent[];
};
export type ObsSeries = { kind: string; id: string; name: string; metric: string; bucket: "hour" | "day"; start: string; end: string; series: { t: string; succeeded: number; failed: number; p95: number | null }[] };
export type AnalystAnswer = { explanation: string; chart: "metric" | "bar" | "line" | "pie" | "table"; query: Record<string, unknown>; result: QueryResult };
export type FreeCard = { id: string; kind: "filter" | "metric" | "text" | "table" | "bar" | "pie" | "line" | "pivot" | "heat" | "waterfall" | "linked" | "selector"; title?: string; config: Record<string, unknown> };
export type SavedAnalysis = { id: string; name: string; visibility: "private" | "public"; cards: FreeCard[]; owner: string; owner_name?: string; updated_at: string };
/** A free-form path sent to Quiver / Notepad (api/workshop.py freeform_quiver): its input object set and cards. */
export type FreeformExport = { name: string; source: SourceRef; filters: Filter[]; filter_sets: OsFilter[]; cards: FreeCard[]; module_id?: string };
/** Open in Quiver: the new analysis, free-form card ID → Quiver card ID, and what did not carry over. */
/** range: the analysis' time range — the bounds of the path's date / timestamp filters, else all time (start and end null) */
export type FreeformQuiver = { analysis_id: string; name: string; cards: Record<string, string>; notes: string[]; texts: string[]; range?: { start?: string | null; end?: string | null; last?: string | null } };
export type FreeformNotepad = { item: { id: string; name: string }; analysis_id: string; added: string[]; skipped: string[]; notes: string[] };
export type ModuleSettings = {
  auto_publish?: boolean;
  /** the selection the module opens with, per source ("object_type:<id>" → primary key): widgets that follow the
   * selection (object views, functions, inline actions) show something before anyone clicks a row */
  default_selection?: Record<string, string>;
  kiosk?: boolean;
  page_variable?: string;
  header?: ModuleHeader;
  auto_refresh?: { enabled?: boolean; object_type_ids?: string[]; min_seconds?: number; disable_in_edit?: boolean };
  translations?: { enabled?: boolean; base?: string; languages?: Record<string, { strings: Record<string, string>; complete?: string[] }> };
  colors?: SavedColor[];
  /** resource protection: changes go through a branch and an approved merge */
  protected?: boolean;
  /** Marketplace installation configuration: string / boolean parameters bound to variables */
  installation?: { enabled?: boolean; parameters?: InstallParam[] };
  /** commands other applications (a parent window, an embedded page) may execute: the payload into a variable, then events */
  commands?: { name: string; variable?: string; events: WsEvent[] }[];
  /** device type: a mobile module is edited at phone size in one column, listed in the mobile app launcher (/m) and
   * may have a bottom navigation bar */
  mobile?: MobileSettings;
};
export type NavItem = { type: "single" | "submenu"; label: string; icon?: string; events?: WsEvent[]; items?: { label: string; icon?: string; events: WsEvent[] }[] };
export type MobileSettings = {
  device?: "desktop" | "mobile";
  navbar?: { visible?: boolean; title?: string; icon?: string; height?: number; hide_text?: boolean; items?: NavItem[] };
};
export type MobileApp = { id: string; name: string; description: string; title: string; icon: string; updated_at: string; favorite: boolean; published: boolean };
export type ScannedCode = { value: string; format: string };
export type InstallParam = { name: string; type: "string" | "boolean"; default?: string; variable?: string; description?: string };
export type BranchChange = { unit: string; op: "added" | "modified" | "deleted" | "moved" };
export type BranchState = {
  branch_id: string; branch_name: string; branch_status: string; on_branch: boolean; status?: string; changes: BranchChange[]; conflicts: string[];
  rebase_needed: boolean; reviews?: Record<string, { decision: "approve" | "reject"; comment: string; at: string; counts: boolean }>; approved?: boolean; by?: string; updated_at?: string; merged_at?: string;
};
export type RebaseConflict = { unit: string; base: unknown; main: unknown; branch: unknown };

/** Functions of a global branch: newer main versions to rebase onto, version targets main released meanwhile. */
export type BranchFunctionRepo = {
  repo_id: string; repository: string; base: string; newer_on_main: string[]; rebase_available: boolean;
  targets: { target: string; version: string; functions: string[]; at: string; stale: boolean }[]; stale_targets: string[];
};
/** Running on a global branch (Workshop opened with ?branch=): the branch's data scenario and its functions' state. */
export type BranchContext = {
  branch_id: string; branch_name: string; branch_status: string; ontology_id: string; scenario_id: string | null; scenario_rid?: string | null;
  object_edits: number; link_edits: number;
  functions: { repos: BranchFunctionRepo[]; rebase_available: boolean; stale_targets: { repo_id: string; repository: string; target: string }[] };
};

const SCENARIO_HEADER = "x-bluesandai-scenario";
let branchFetch: { ctx: BranchContext; original: typeof fetch } | null = null;

/** Requests that manage the branch itself or edit resources (not runtime data) go without the branch's data header. */
function branchScoped(url: URL): boolean {
  const api = new URL(API_URL || window.location.origin, window.location.href);
  if (url.origin !== api.origin || !url.pathname.startsWith("/api/")) return false;
  return !/^\/api\/(workshop\/modules(\/|$)|ontology\/(branches|scenarios|staged-writes)(\/|$)|auth\/)/.test(url.pathname);
}

/**
 * Enter a global branch for this tab, like Foundry's branch selector: every runtime request (object reads, action
 * applies, AIP Logic runs, function executions) carries the branch's data scenario, so reads see the branch's
 * objects, edits go to the branch — never to main — and functions run at the branch's "Branched pre-release"
 * versions. Returns the branch context; leaveGlobalBranch() restores main.
 */
export async function enterGlobalBranch(branchId: string): Promise<BranchContext> {
  const original = branchFetch?.original ?? window.fetch.bind(window);
  const res = await original(`${API_URL}/api/ontology/branches/${encodeURIComponent(branchId)}/context`, { method: "POST", credentials: "include", cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.statusText);
  const ctx = body as BranchContext;
  branchFetch = { ctx, original };
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const cur = branchFetch;
    if (!cur?.ctx.scenario_id) return original(input, init);
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      return original(input, init);
    }
    if (!branchScoped(url)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // a page's own scenario (a scenario widget) wins
    if (!headers.has(SCENARIO_HEADER)) headers.set(SCENARIO_HEADER, cur.ctx.scenario_id);
    return original(input instanceof Request ? new Request(input, { headers }) : input, { ...init, headers });
  };
  return ctx;
}

/** Back to main: requests no longer carry the branch's data scenario. */
export function leaveGlobalBranch(): void {
  if (!branchFetch) return;
  window.fetch = branchFetch.original;
  branchFetch = null;
}

/** The global branch this tab works on, if any. */
export function globalBranch(): BranchContext | null {
  return branchFetch?.ctx ?? null;
}

async function branchCall<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...((rest.headers as Record<string, string>) ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText));
  return body as T;
}

export const globalBranches = {
  context: (branchId: string) => branchCall<BranchContext>(`/api/ontology/branches/${encodeURIComponent(branchId)}/context`),
  /** rebase the branch's functions onto main; a stale version target needs a new one (retarget: old → new) */
  rebaseFunctions: (branchId: string, body: { repo_id?: string; retarget?: Record<string, string> } = {}) =>
    branchCall<{ status: "rebased" | "needs_target"; stale?: { repo_id: string; repository: string; target: string }[]; repos: BranchFunctionRepo[]; dependents?: { kind: string; id: string; name: string; version?: string; function: string; on_branch?: boolean }[] }>(
      `/api/functions/branches/${encodeURIComponent(branchId)}/rebase`, { method: "POST", json: body }),
};
export type LintResult = { dependencies: Record<string, string[]>; errors: { kind: string; id: string; message: string }[]; warnings: { kind: string; id: string; message: string }[]; packageable: boolean };
export type ProductPackage = { kind: string; version: number; name: string; description: string; module: Record<string, unknown>; dependencies: Record<string, string[]>; names: Record<string, string>; parameters: InstallParam[] };
export type SavedColor = { id: string; name: string; light: string; dark: string };
export const savedColorVar = (id: string) => `var(--ws-color-${id})`;
export type Freshness = Record<string, { name: string; updated_at: string | null; version: number }>;
export type ModuleVersion = { version: number; at: string; by: string | null; note: string; summary: string };

export const WIDGETS: { type: WidgetType; label: string; icon: IconName; w: number; h: number; description: string }[] = [
  { type: "table", label: "Object table", icon: "table", w: 8, h: 7, description: "Rows of a dataset or object type" },
  { type: "metric", label: "Metric card", icon: "gauge", w: 3, h: 3, description: "One number: a count, sum or average" },
  { type: "bar", label: "Bar chart", icon: "list", w: 6, h: 6, description: "Compare a measure across categories" },
  { type: "pie", label: "Pie chart", icon: "globe", w: 4, h: 6, description: "Share of a whole (up to 6 slices)" },
  { type: "line", label: "Line chart", icon: "wave", w: 6, h: 6, description: "A measure over time" },
  { type: "filter", label: "Filter", icon: "filter", w: 3, h: 2, description: "Filter widgets on the same source" },
  { type: "text", label: "Text", icon: "doc", w: 4, h: 2, description: "A heading or notes (Markdown)" },
  { type: "button", label: "Button", icon: "bolt", w: 2, h: 2, description: "Apply an ontology action" },
  { type: "ts_chart", label: "Chart XY (time series)", icon: "wave", w: 8, h: 6, description: "Time series properties of the selected object, one layer each, with a rolling transform" },
  { type: "ts_metric", label: "Time series metric", icon: "gauge", w: 3, h: 3, description: "Last, max, min or mean of a time series property over a range" },
  { type: "quiver", label: "Quiver dashboard", icon: "wave", w: 12, h: 9, description: "Embed a Quiver dashboard; its object follows the selection" },
  { type: "derived", label: "Derived series", icon: "layers", w: 4, h: 5, description: "Discover and create derived series of object types" },
  { type: "semantic_search", label: "Semantic search box", icon: "search", w: 6, h: 2, description: "A text input that ranks an object type's objects by meaning (KNN over its embedding): tables and charts on it show the k most relevant" },
  { type: "function", label: "Function output", icon: "code", w: 4, h: 4, description: "Run a published function (optionally on the selected object) and show its output; aggregations render as charts" },
  { type: "media", label: "Media preview", icon: "image", w: 5, h: 7, description: "Images, PDFs, audio, video, spreadsheets, email or DICOM of the selected object" },
  { type: "image_annotation", label: "Image, PDF and spreadsheet annotation", icon: "image", w: 6, h: 8, description: "The selected object's image, PDF (page by page) or spreadsheet with its annotation objects as boxes, polygons, points, text spans or cell ranges; draw one to create it with an action, select one to edit or delete it" },
  { type: "custom", label: "Custom widget", icon: "grid", w: 6, h: 6, description: "A widget from a widget set (custom frontend code), its parameters bound to the module and its events back" },
  { type: "audio_recorder", label: "Audio recorder", icon: "wave", w: 4, h: 3, description: "Record audio in the browser and save it with an action (its media parameter), on the selected object" },
  { type: "transcription", label: "Audio and transcription", icon: "wave", w: 6, h: 7, description: "Play the selected object's audio with its transcript (Whisper); click a segment to jump to it" },
  { type: "tabs", label: "Tabs", icon: "layers", w: 12, h: 8, description: "A tabbed section: each tab holds its own widgets" },
  { type: "object_set_title", label: "Object set title", icon: "cube", w: 6, h: 2, description: "The selected object's title, or the object type and the count of the set" },
  { type: "vega", label: "Vega chart", icon: "graph", w: 6, h: 8, description: "A Vega or Vega-Lite spec with objects, aggregations or variables injected as data; selection parameters to variables" },
  { type: "map", label: "Map", icon: "globe", w: 8, h: 9, description: "Object layers as points or shapes (geoshape polygons and lines) on a base map, colored by a property with a legend; overlay layers and map templates from saved maps; selection to variables" },
  { type: "gantt", label: "Gantt chart", icon: "sliders", w: 12, h: 8, description: "Objects as time ranges (or points) per group, stacked in rows, with a now line" },
  { type: "stepper", label: "Stepper", icon: "list", w: 12, h: 2, description: "A multi-step workflow: steps with events, completion from boolean variables, linear or not" },
  { type: "timeline", label: "Timeline", icon: "clock", w: 4, h: 9, description: "Objects as events in time order (vertical or horizontal), with the time between them" },
  { type: "comments", label: "Comments", icon: "comment", w: 4, h: 9, description: "Comments on the selected object, with @mentions, object references, attachments and its action log" },
  { type: "inline_action", label: "Inline action", icon: "edit", w: 4, h: 9, description: "An action form in the page (one or several action types), with parameter defaults from variables" },
  { type: "aip_chatbot", label: "AIP chatbot", icon: "sparkle", w: 4, h: 10, description: "Chat with an AIP Agent Studio agent that sees chosen module variables; the answer into a variable" },
  { type: "aip_content", label: "AIP generated content", icon: "sparkle", w: 6, h: 6, description: "Generate text with an LLM prompt or an AIP Logic function, into a variable" },
  { type: "data_freshness", label: "Data freshness", icon: "clock", w: 4, h: 2, description: "When the object types last changed: relative within a day, else the date" },
  { type: "filter_list", label: "Filter list", icon: "filter", w: 3, h: 10, description: "Histograms, selectors, ranges, keyword and linked filters into an object set filter variable" },
  { type: "filter_pills", label: "Exploration filter pills", icon: "filter", w: 8, h: 1, description: "The filters of an object set as pills: read only, remove, update or add" },
  { type: "search_bar", label: "Exploration search bar", icon: "search", w: 8, h: 1, description: "Search and filter an object set: property suggestions, keyword, linked objects" },
  { type: "prominent_terms", label: "Prominent terms", icon: "list", w: 3, h: 6, description: "Chosen terms of a property with their counts, as filters" },
  { type: "object_view", label: "Object view", icon: "cube", w: 6, h: 10, description: "The selected object's full object view, or a panel (the object or its set's aggregates)" },
  { type: "edit_history", label: "Edit history", icon: "history", w: 4, h: 8, description: "User edits to the selected object's properties, before and after (tracking per object type)" },
  { type: "action_log", label: "Action log timeline", icon: "bolt", w: 4, h: 8, description: "Actions applied to the selected object, in time order" },
  { type: "linked_resources", label: "Linked resources", icon: "folder", w: 4, h: 6, description: "Files linked to the selected object: upload, link existing files, unlink" },
  { type: "media_uploader", label: "Media uploader", icon: "upload", w: 3, h: 2, description: "A button uploading files to a folder, with an action run per file" },
  { type: "resource_list", label: "Resource list", icon: "list", w: 4, h: 6, description: "Files resources, object types or object sets as a list or cards" },
  { type: "pdf_viewer", label: "PDF viewer", icon: "doc", w: 6, h: 12, description: "A PDF with keyword search and highlights, page navigation and annotation objects" },
  { type: "video_display", label: "Video display", icon: "play", w: 6, h: 9, description: "A video with seeking from a variable and key frames (intervals, a list or scene changes)" },
  { type: "observability", label: "Observability chart", icon: "gauge", w: 6, h: 6, description: "Executions or p95 duration of a function or an action over time; brushing sets the range" },
  { type: "freeform", label: "Free-form analysis", icon: "graph", w: 8, h: 14, description: "An analysis path of cards over the object set: filters, metrics, tables, charts; saved paths" },
  { type: "aip_analyst", label: "AIP analyst", icon: "sparkle", w: 6, h: 12, description: "Ask questions about the object set: the answer runs as a real query, shown as a chart or table" },
  { type: "app_pairing", label: "App pairing", icon: "link", w: 4, h: 3, description: "Pair this module with other windows by a code: selections and chosen variables stay in sync" },
  { type: "notepad_linked", label: "Notepad: Linked documents", icon: "doc", w: 4, h: 6, description: "Notepad documents that link to the selected object; the chosen one is the Active Notepad variable" },
  { type: "notepad_embed", label: "Notepad: Embedded document", icon: "doc", w: 8, h: 14, description: "A Notepad document from a variable (its rid), read-only or with a reduced editor" },
  { type: "notepad_new", label: "Notepad: New Notepad button", icon: "plus", w: 3, h: 1, description: "Create a Notepad document from a template (inputs from variables) or from a string variable" },
  { type: "notepad_export", label: "Notepad: Export button", icon: "download", w: 3, h: 1, description: "Download a Notepad document as PDF or DOCX" },
  { type: "vertex_graph", label: "Vertex: Graph", icon: "graph", w: 8, h: 14, description: "A saved Vertex graph or a graph template run with object set variables; the selected objects are an output variable" },
  { type: "machinery", label: "Machinery", icon: "split", w: 8, h: 12, description: "A Machinery process: states and transitions with their metrics; the objects in the selection are an output object set" },
  { type: "scheduling_gantt", label: "Scheduling Gantt", icon: "clock", w: 12, h: 12, description: "A Dynamic Scheduling board: resources as rows, schedule objects as pucks to drag in time and between rows, with rule violations; the selected puck is an output variable" },
  { type: "scheduling_calendar", label: "Scheduling Calendar", icon: "clock", w: 8, h: 14, description: "A Dynamic Scheduling board's schedule objects in a month or week calendar; the selected one is an output variable" },
  { type: "program_scheduling", label: "Program Scheduling", icon: "clock", w: 12, h: 14, description: "Programs, projects and tasks on a timeline: grouped rows with roll-ups, dependency arrows, milestones and phases; drag or resize tasks with dependency checks; the selection is an output variable" },
  { type: "rule_editor", label: "Foundry Rules: Rule Editor", icon: "sliders", w: 12, h: 16, description: "A Foundry Rules workflow's rules: create or edit a rule (logic boards with previews, the rule output) and submit the change as a proposal; read-only as a Rule Viewer; the selected rule is a variable" },
  { type: "proposal_reviewer", label: "Foundry Rules: Proposal Reviewer", icon: "check", w: 12, h: 14, description: "A Foundry Rules workflow's rule proposals with the diff of each change; approve (the change is applied) or reject; the selected proposal is a variable" },
  { type: "vulcan_viewer", label: "Vulcan", icon: "cube", w: 12, h: 16, description: "A CAD object in the Vulcan 3D viewer (meshes, DXF drawings, LAS point clouds) with its tools — annotate, measure, section, style, color; the selected part and clicked point are output variables" },
  { type: "form_embed", label: "Form", icon: "edit", w: 6, h: 12, description: "A published form, prefilled from variables, for an object variable's object (a form on its type edits it); on submit the response and the object are output variables, events run and the other widgets reload" },
  { type: "scenario_manager", label: "Scenario manager", icon: "split", w: 4, h: 7, description: "Create, select, duplicate and delete what-if scenarios (Nexus scenarios)" },
  { type: "scenario_selector", label: "Scenario selector", icon: "split", w: 4, h: 4, description: "Choose one or several scenarios from candidates into a variable" },
  { type: "scenario_summary", label: "Scenario summary", icon: "list", w: 4, h: 6, description: "The actions and edits of a scenario" },
  { type: "qr_reader", label: "QR code reader", icon: "camera", w: 4, h: 2, description: "A button that scans QR codes or barcodes with the camera (or a photo) into a variable" },
  { type: "current_location", label: "Current location manager", icon: "globe", w: 6, h: 1, description: "The user's location as \"lat,long\" into a variable while the page is open, with a preview" },
  { type: "section", label: "Section", icon: "grid", w: 6, h: 8, description: "A container with a header, its own layout (grid, rows, columns, toolbar, flow) and an optional collapse" },
  { type: "button_group", label: "Button group", icon: "bolt", w: 4, h: 2, description: "Buttons whose events set variables, open overlays, switch tabs or pages, open modules or URLs" },
  { type: "text_input", label: "Text input", icon: "edit", w: 3, h: 2, description: "Writes a string variable" },
  { type: "number_input", label: "Numeric input", icon: "edit", w: 3, h: 2, description: "Writes a number variable" },
  { type: "string_selector", label: "String selector", icon: "list", w: 3, h: 2, description: "Pick values (fixed, or a column's values) into a variable" },
  { type: "date_picker", label: "Date picker", icon: "clock", w: 3, h: 2, description: "Writes a date variable" },
  { type: "toggle", label: "Toggle", icon: "check", w: 2, h: 2, description: "Writes a boolean variable" },
  { type: "object_dropdown", label: "Object dropdown", icon: "cube", w: 4, h: 2, description: "Pick an object: it becomes the selection of its object type" },
  { type: "user_select", label: "User select", icon: "eye", w: 3, h: 2, description: "Pick a user into a variable" },
  { type: "object_list", label: "Object list", icon: "list", w: 4, h: 7, description: "Objects as a list of cards (title and a property); selecting one selects it" },
  { type: "property_list", label: "Property list", icon: "doc", w: 4, h: 6, description: "The properties of the selected object" },
  { type: "linked_objects", label: "Links", icon: "link", w: 4, h: 5, description: "Objects linked to the selected object" },
  { type: "pivot", label: "Pivot table", icon: "table", w: 8, h: 7, description: "A measure by two columns (rows × columns)" },
  { type: "embedded_module", label: "Embedded module", icon: "device", w: 12, h: 8, description: "Another Workshop module inside this one, its variables set from here" },
  { type: "iframe", label: "Iframe", icon: "globe", w: 6, h: 6, description: "Embed a page or another platform application by URL" },
  { type: "loop", label: "Loop layout", icon: "layers", w: 12, h: 8, description: "One embedded module per entry of an array variable or object of an object set, as a list or a grid" },
];
export const widgetInfo = (t: WidgetType) => WIDGETS.find((w) => w.type === t)!;

export const METRIC_LABEL: Record<Metric, string> = { count: "Count", sum: "Sum", avg: "Average", min: "Minimum", max: "Maximum", distinct: "Distinct count" };

export type Column = { name: string; type: string; /** an object type property's display name */ label?: string };
export type DatasetSource = { id: string; name: string; path: string[]; size: number | null; updated_at: string };
export type ObjectTypeSource = {
  id: string; name: string; count: number; properties: { name: string; label: string; type: string; /** indexed for regex search ("Regex queries") */ regex?: boolean; /** visibility "prominent" */ prominent?: boolean }[];
  /** the ontology's icon, color and title property */
  icon?: string; color?: string | null; title_property?: string;
  /** the type is marked prominent (or promoted) */
  prominent?: boolean;
};
/** an interface-based object set: the objects of every implementing type under the interface's properties */
export type InterfaceSource = {
  id: string; name: string; implemented_by: number; properties: { name: string; label: string; type: string }[];
  /** the API name function signatures use (interface:<api_name>), its implementing types (with the interfaces it extends) and action type constraints */
  api_name?: string; extends?: string[]; types?: { id: string; name: string }[]; action_constraints?: { api_name: string; display_name: string }[];
  /** its link types (constraints) with each implementing type's concrete link (by_type: type id → the link read from it) */
  link_constraints?: InterfaceLink[];
};
export type InterfaceLink = {
  api_name: string; display_name: string; target_kind?: "object_type" | "interface"; target_id?: string; cardinality?: "one" | "many"; required?: boolean;
  by_type: Record<string, { link_type_id: string; direction: "forward" | "reverse" }>;
};
/** An object reference as functions and actions take it. */
export type ObjectRef = { object_type_id: string; primary_key: string };
/** Where a function's interface-typed input comes from: the object selected in a widget on a source ("interface:<id>"
 * holds "<type id>:<pk>", "object_type:<id>" a primary key), a variable (references, "<type id>:<pk>" or primary keys of
 * object_type_id), or every object of the interface (interface_set inputs). type: the input's type when configured. */
export type ObjectInputBinding = { from: "selection" | "variable" | "all"; source?: string; variable?: string; object_type_id?: string; type: string };
/** A resolved interface action: the concrete action type to run on the selected object, parameters filled from it. */
export type InterfaceActionResolution = {
  action_type_id: string; action_name: string; object_type_id: string; primary_key: string;
  via: "by_type" | "constraint" | "interface_action" | "type_action"; defaults: Record<string, unknown>;
};

/** Every configured action that applies to an object selected on an interface source (POST /api/workshop/interface-actions). */
export type InterfaceActionOptions = {
  object_type_id: string; object_type_name: string; primary_key: string;
  options: InterfaceActionResolution[]; refused: { action_type_id: string; action_name: string; reason: string }[];
};

/** An interface-typed function input ("interface:X", "array<interface:X>", "interface_set:X"): its shape and interface. */
export function interfaceInput(type: string): { shape: "one" | "list" | "set"; iface: string } | null {
  const m = /^(?:(array)<interface:(.+)>|interface_set:(.+)|interface:(.+))$/.exec(type.trim());
  if (!m) return null;
  return m[1] ? { shape: "list", iface: m[2] } : m[3] ? { shape: "set", iface: m[3] } : { shape: "one", iface: m[4] };
}

/** One object reference from a selection or variable value: {object_type_id, primary_key}, "<type id>:<pk>" (interface
 * selections) or a bare primary key of typeId. */
export function toObjectRef(v: unknown, typeId?: string): ObjectRef | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const tid = (o.object_type_id ?? o.__type ?? typeId) as string | undefined;
    const pk = o.primary_key ?? o.__pk;
    if (tid && pk !== undefined && pk !== null && pk !== "") return { object_type_id: String(tid), primary_key: String(pk).startsWith(`${tid}:`) ? String(pk).slice(String(tid).length + 1) : String(pk) };
    return null;
  }
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  const m = /^(ot-[\w-]+):(.+)$/.exec(s);
  if (m) return { object_type_id: m[1], primary_key: m[2] };
  return typeId ? { object_type_id: typeId, primary_key: s } : null;
}

/** The value an interface-typed input gets from its binding: a reference (interface:X), a list (array<interface:X>) or
 * {objects} (interface_set:X; {} for every object of the interface); undefined while nothing is selected / set. */
export function objectInputValue(b: ObjectInputBinding, selection: Record<string, string | undefined>, vars: Record<string, unknown>): unknown {
  const shape = interfaceInput(b.type)?.shape ?? "one";
  if (b.from === "all") return shape === "set" ? {} : undefined;
  let refs: ObjectRef[] = [];
  if (b.from === "selection" && b.source) {
    const sel = selection[b.source];
    const typeId = b.source.startsWith("object_type:") ? b.source.slice("object_type:".length) : undefined;
    const r = sel === undefined ? null : toObjectRef(sel, typeId);
    if (r) refs = [r];
  } else if (b.from === "variable" && b.variable) {
    const v = vars[b.variable];
    const items = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : typeof v === "string" && v.includes(",") ? v.split(",").map((x) => x.trim()) : [v];
    refs = items.map((x) => toObjectRef(x, b.object_type_id)).filter((x): x is ObjectRef => !!x);
  }
  if (!refs.length) return shape === "one" ? undefined : shape === "set" && b.from === "variable" ? { objects: [] } : undefined;
  return shape === "one" ? refs[0] : shape === "list" ? refs : { objects: refs };
}
export type Sources = { datasets: DatasetSource[]; object_types: ObjectTypeSource[]; interfaces?: InterfaceSource[]; restricted_views?: { id: string; name: string }[] };

/** starts_with: the value or one of its words starts with it; search: advanced keyword syntax; regex: a Lucene pattern on the whole value;
 * geo (the Map widget): the geopoint / geoshape meets value {geometry} (GeoJSON) or {bbox}, value.lon_column: a latitude / longitude pair */
export type Filter = { column: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "is_null" | "not_null" | "starts_with" | "search" | "regex" | "geo"; value?: unknown };
export type JoinSpec = { dataset_id: string; left_key: string; right_key: string; mode: "left" | "inner"; prefix: string };
export type DerivedColumn = { name: string; op: "add" | "subtract" | "multiply" | "divide" | "concat" | "upper" | "lower" | "year"; column: string; other_column?: string; value?: unknown };
export type QueryBody = {
  source: SourceRef;
  filters?: Filter[];
  filter_mode?: "all" | "any";
  additional_filters?: Filter[];
  /** object set filter variables (each must hold) */
  filter_sets?: OsFilter[];
  /** read the objects as they are in this scenario */
  scenario_id?: string;
  join?: JoinSpec;
  derived?: DerivedColumn[];
  columns?: string[];
  group_by?: string;
  bucket?: "day" | "month" | "year";
  metric?: Metric;
  metric_column?: string;
  /** bucket counts of a date / timestamp (timeline) or numeric (distribution) property over the filtered rows */
  histogram?: { column: string; kind: "timeline" | "distribution"; interval?: "auto" | "day" | "week" | "month" | "year"; bins?: number };
  sort?: string;
  descending?: boolean;
  limit?: number;
  search?: string;
  semantic?: { query: string; k?: number; mode?: string; property?: string };
};
/** One bucket: the objects with from ≤ value < to (closed: ≤ to, a property with a single value). Timeline ends are
 * ISO dates, a distribution's are numbers. */
export type HistBucket = { from: string | number; to: string | number; count: number; closed?: boolean };
export type Histogram = {
  kind: "timeline" | "distribution"; column: string; type: string; buckets: HistBucket[];
  /** objects with a value / without one / with a value that is not a date or number */
  count: number; nulls: number; invalid: number;
  min: string | number | null; max: string | number | null;
  interval?: "day" | "week" | "month" | "year" | null; years?: number; step?: number | null; integer?: boolean;
};
export type QueryResult = {
  total: number;
  columns: Column[];
  histogram?: Histogram;
  value?: unknown;
  rows?: (Record<string, unknown> & { __pk?: string; __markings?: Record<string, { id: string; name: string }[]> })[];
  groups?: { key: unknown; value: number | null; count: number }[];
  group_count?: number;
};

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/workshop" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const workshop = {
  modules: () => request<Module[]>("/modules"),
  mobileApps: (q = "") => request<MobileApp[]>(`/mobile-apps${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  tsColumns: (body: { object_type_id: string; primary_keys: string[]; property: string; aggregation?: string; range_last?: string; buckets?: number; rolling?: string; rolling_agg?: string; resource?: string } & Omit<Partial<TsColumnRequest>, "id">) =>
    request<{ rows: Record<string, TsCellData>; points_scanned: number }>("/ts-columns", { method: "POST", json: body }),
  /** every time series column of a table for one page (up to 500) of its rows: per column id, the rows */
  tsColumnsBatch: (body: { object_type_id: string; primary_keys: string[]; columns: TsColumnRequest[]; resource?: string }) =>
    request<{ columns: Record<string, Record<string, TsCellData>>; points_scanned: number }>("/ts-columns/batch", { method: "POST", json: body }),
  decodeCodes: (image: Blob, kind: "qr" | "barcode") => request<{ codes: ScannedCode[] }>(`/decode-codes?kind=${kind}`, { method: "POST", body: image, headers: { "content-type": image.type || "image/jpeg" } }),
  module: (id: string) => request<Module>(`/modules/${id}`),
  create: (body: Partial<Module>) => request<Module>("/modules", { method: "POST", json: body }),
  save: (id: string, body: Partial<Module> & { version_note?: string }) => request<Module>(`/modules/${id}`, { method: "PUT", json: body }),
  moduleAt: (id: string, q: { version?: number; published?: boolean }) => request<Module>(`/modules/${id}?${q.version ? `version=${q.version}` : "published=true"}`),
  versions: (id: string) => request<ModuleVersion[]>(`/modules/${id}/versions`),
  publish: (id: string, version: number) => request<Module>(`/modules/${id}/publish`, { method: "POST", json: { version } }),
  editHistory: (typeId: string, pk: string, order: "newest" | "oldest" = "newest") =>
    request<{ enabled: boolean; since?: string; changes: EditChange[] }>(`/edit-history/${typeId}/${encodeURIComponent(pk)}?order=${order}`),
  setTracking: (typeId: string, enabled: boolean) => request<{ enabled: boolean }>(`/edit-history/${typeId}`, { method: "PUT", json: { enabled } }),
  resourceLinks: (typeId: string, pk: string) => request<ResourceMeta[]>(`/resource-links/${typeId}/${encodeURIComponent(pk)}`),
  linkResource: (typeId: string, pk: string, itemId: string) => request<ResourceMeta[]>(`/resource-links/${typeId}/${encodeURIComponent(pk)}`, { method: "POST", json: { item_id: itemId } }),
  unlinkResource: (typeId: string, pk: string, itemId: string) => request<ResourceMeta[]>(`/resource-links/${typeId}/${encodeURIComponent(pk)}/${itemId}`, { method: "DELETE" }),
  /** the user's favorite object types (Resource List "Favorite" object types), and starring one */
  favoriteTypes: () => request<string[]>("/favorite-object-types"),
  setFavoriteType: (typeId: string, favorite: boolean) => request<string[]>(`/favorite-object-types/${typeId}`, { method: "PUT", json: { favorite } }),
  /** an interface's object (Object View on an interface source): each interface property through the type's mapping */
  interfaceObject: (ifaceId: string, typeId: string, pk: string) => request<InterfaceObject>(`/interface-object/${ifaceId}/${typeId}/${encodeURIComponent(pk)}`),
  /** Files tags (Resource List): the tags the user can choose, the tags of listed resources, resources with one of the tags */
  resourceTags: () => request<FileTag[]>("/resource-tags"),
  resourceTagsOf: (ids: string[]) => request<Record<string, FileTag[]>>("/resource-tags/of", { method: "POST", json: { ids } }),
  taggedResources: (tags: string[]) => request<(DriveItem & { tags: FileTag[] })[]>(`/resources/tagged?tags=${encodeURIComponent(tags.join(","))}`),
  pdfInfo: (ref: string) => request<{ pages: number; sizes: [number, number][] }>(`/pdf/${ref}`),
  pdfLocate: (ref: string, text: string) =>
    request<{ pages: { page: number; boxes: { x: number; y: number; w: number; h: number }[] }[]; matched: number }>(`/pdf/${ref}/locate`, { method: "POST", json: { text } }),
  /** k nearest neighbors (POST /api/ontology/semantic/knn): the objects, most relevant first */
  knn: async (body: { object_type_id: string; query?: string; vector?: number[]; property?: string; k?: number; mode?: string; resource?: string }) => {
    const res = await fetch(`${API_URL}/api/ontology/semantic/knn`, { method: "POST", cache: "no-store", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof out.detail === "string" ? out.detail : res.statusText);
    return out as { objects: { primary_key: string; title?: string; relevance: number }[] };
  },
  pdfSearch: (ref: string, q: string) => request<{ page: number; boxes: { x: number; y: number; w: number; h: number }[] }[]>(`/pdf/${ref}/search?q=${encodeURIComponent(q)}`),
  /** a page's text layer (runs with [s, e) character offsets and boxes) and a text span's quote and line boxes */
  pdfText: (ref: string, page: number) => request<{ page: number; text: string; runs: { s: number; e: number; x: number; y: number; w: number; h: number }[] }>(`/pdf/${ref}/text/${page}`),
  pdfSpan: (ref: string, page: number, start: number, end: number) =>
    request<{ page: number; start: number; end: number; quote: string; boxes: { x: number; y: number; w: number; h: number }[] }>(`/pdf/${ref}/span?page=${page}&start=${start}&end=${end}`),
  videoInfo: (ref: string) => request<{ duration: number | null }>(`/video/${ref}/info`),
  videoScenes: (ref: string, sensitivity: string) => request<number[]>(`/video/${ref}/scenes?sensitivity=${sensitivity}`),
  observability: (kind: string, id: string, metric: string, start?: string, end?: string) =>
    request<ObsSeries>(`/observability?kind=${kind}&id=${encodeURIComponent(id)}&metric=${metric}${start ? `&start=${encodeURIComponent(start)}` : ""}${end ? `&end=${encodeURIComponent(end)}` : ""}`),
  analyst: (body: { source: SourceRef; filters?: Filter[]; filter_sets?: OsFilter[]; question: string; history?: { role: string; content: string }[]; model?: string; derived?: DerivedColumn[] }) =>
    request<AnalystAnswer>("/analyst", { method: "POST", json: body }),
  /** Vega chart AIP spec generator: the prompt and the data inputs' schema (no rows) to the language model; the answer checked */
  vegaGenerate: (body: VegaGenerateBody) => request<VegaSpecCheck & { text: string; model: string; attempts: number; raw: string }>("/vega/generate", { method: "POST", json: body }),
  /** the same checks on a spec the author edited */
  vegaValidate: (body: Omit<VegaGenerateBody, "prompt" | "current_spec" | "model"> & { spec: string }) => request<VegaSpecCheck>("/vega/validate", { method: "POST", json: body }),
  analyses: (moduleId: string, widgetId: string) => request<SavedAnalysis[]>(`/analyses/${moduleId}/${widgetId}`),
  saveAnalysis: (moduleId: string, widgetId: string, body: { id?: string; name: string; visibility: "private" | "public"; cards: FreeCard[] }) =>
    request<SavedAnalysis>(`/analyses/${moduleId}/${widgetId}`, { method: "PUT", json: body }),
  deleteAnalysis: (moduleId: string, widgetId: string, id: string) => request<unknown>(`/analyses/${moduleId}/${widgetId}/${id}`, { method: "DELETE" }),
  freeformQuiver: (body: FreeformExport) => request<FreeformQuiver>("/freeform/quiver", { method: "POST", json: body }),
  freeformNotepad: (body: FreeformExport & { card_ids?: string[]; document_id?: string; document_name?: string; parent_id?: string }) =>
    request<FreeformNotepad>("/freeform/notepad", { method: "POST", json: body }),
  move: (id: string, folderId: string) => request<Module>(`/modules/${id}/move`, { method: "POST", json: { folder_id: folderId } }),
  branches: (id: string) => request<BranchState[]>(`/modules/${id}/branches`),
  onBranch: (id: string, branchId: string) => request<Module>(`/modules/${id}/branches/${branchId}`),
  saveOnBranch: (id: string, branchId: string, body: Partial<Module>) => request<Module>(`/modules/${id}/branches/${branchId}`, { method: "PUT", json: body }),
  rebase: (id: string, branchId: string, body: { resolutions?: Record<string, unknown>; keep_branch?: boolean; preview?: boolean }) =>
    request<{ done: boolean; conflicts: RebaseConflict[]; incoming?: BranchChange[]; module?: Module }>(`/modules/${id}/branches/${branchId}/rebase`, { method: "POST", json: body }),
  review: (id: string, branchId: string, decision: "approve" | "reject", comment = "") => request<BranchState>(`/modules/${id}/branches/${branchId}/review`, { method: "POST", json: { decision, comment } }),
  mergeBranch: (id: string, branchId: string) => request<Module>(`/modules/${id}/branches/${branchId}/merge`, { method: "POST" }),
  lint: (id: string) => request<LintResult>(`/modules/${id}/lint`),
  package: (id: string) => request<ProductPackage>(`/modules/${id}/package`),
  install: (body: { package: ProductPackage; folder_id?: string; name?: string; inputs?: Record<string, unknown>; mapping?: Record<string, string> }) => request<Module>("/install", { method: "POST", json: body }),
  links: (typeId: string) => request<LinkInfo[]>(`/links/${typeId}`),
  freshness: (typeIds: string[]) => request<Freshness>(`/freshness?types=${encodeURIComponent(typeIds.join(","))}`),
  favorite: (id: string, favorite: boolean) => request<{ favorite: boolean }>(`/modules/${id}/favorite`, { method: "PUT", json: { favorite } }),
  sql: (body: { query: string; tables: Record<string, string>; params: Record<string, unknown>; limit?: number }) =>
    request<{ columns: { name: string; type: string }[]; rows: unknown[][]; row_count: number; truncated: boolean }>("/sql", { method: "POST", json: body }),
  remove: (id: string) => request<unknown>(`/modules/${id}`, { method: "DELETE" }),
  sources: () => request<Sources>("/sources"),
  /** the concrete action to run on an object selected through an interface (POST /api/workshop/interface-action) */
  interfaceAction: (body: { interface_id: string; object: string | ObjectRef; action_type_id?: string; constraint?: string; by_type?: Record<string, string> }) =>
    request<InterfaceActionResolution>("/interface-action", { method: "POST", json: body }),
  /** every configured action that applies to that object (an inline action's menu), with the refused ones and why */
  interfaceActions: (body: { interface_id: string; object: string | ObjectRef; action_type_ids?: string[]; action_type_id?: string; constraint?: string; by_type?: Record<string, string> }) =>
    request<InterfaceActionOptions>("/interface-actions", { method: "POST", json: body }),
  query: (body: QueryBody) => request<QueryResult>("/query", { method: "POST", json: body }),
  /** scenarios [Legacy]: Save scenario (persist it, create or update its scenario object); preview only fills the form */
  saveScenario: (sid: string, body: ScenarioSaveBody) => request<ScenarioSaveResult>(`/scenarios/${encodeURIComponent(sid)}/save`, { method: "POST", json: body }),
  /** each scenario's save state: new, saved or updated (changed since it was saved); unknown ids are left out */
  scenarioStates: (ids: string[]) => request<Record<string, ScenarioSaveState>>("/scenario-states", { method: "POST", json: { ids } }),
  /** a copy of a scenario's edits and applied actions, "<name> (copy)" (POST /api/ontology/scenarios/{id}/duplicate) */
  duplicateScenario: async (sid: string, body: { name?: string; persisted?: boolean } = {}) => {
    const res = await fetch(`${API_URL}/api/ontology/scenarios/${encodeURIComponent(sid)}/duplicate`, { method: "POST", cache: "no-store", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof out.detail === "string" ? out.detail : res.statusText);
    return out as { id: string; rid: string; name: string; persisted: boolean; duplicated_from: { id: string; name: string } };
  },
};

export type ScenarioSaveBody = { object_type_id?: string; create_action_id?: string; update_action_id?: string; parameters?: Record<string, unknown>; preview?: boolean };
export type ScenarioSaveState = { state: "new" | "saved" | "updated"; saved: { at: string; by: string; object_type_id: string | null; primary_key: string | null } | null };
export type ScenarioSaveResult = {
  mode: "create" | "update" | "persist";
  object_type_id: string | null;
  primary_key: string | null;
  action_type_id: string | null;
  action: string | null;
  parameters?: Record<string, unknown>;
  filled?: string[];
  locked?: string[];
  missing?: string[];
  fields?: { id: string; display_name: string; type: string; required: boolean; filled: boolean; locked: boolean }[];
  scenario?: { id: string; name: string; persisted: boolean } & ScenarioSaveState;
};

/** The validated categorical steps for a dark surface, in fixed order (never cycled; extra slices fold into "Other"). */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const OTHER = "#5b6676";

/** A value naming a module variable ("$var:name") resolves to the variable's value; other values stay. */
export function resolveVar(v: unknown, vars: Record<string, unknown>): unknown {
  return typeof v === "string" && v.startsWith("$var:") ? vars[v.slice(5).trim()] : v;
}

/** Text with {{name}} replaced by module variables. */
export function fillVars(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => (name in vars ? fmt(vars[name]) : `{{${name}}}`));
}

/** A value with a value format (decimals, prefix / suffix, compact or percent notation). */
export function fmtWith(v: unknown, f?: ValueFormat): string {
  if (!f || typeof v !== "number") return f && v !== null && v !== undefined && v !== "" ? `${f.prefix ?? ""}${fmt(v)}${f.suffix ?? ""}` : fmt(v);
  const opts: Intl.NumberFormatOptions = {};
  if (f.decimals !== undefined) Object.assign(opts, { minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals });
  if (f.min_fraction !== undefined) opts.minimumFractionDigits = f.min_fraction;
  if (f.max_fraction !== undefined) opts.maximumFractionDigits = Math.max(f.max_fraction, opts.minimumFractionDigits ?? 0);
  if (f.min_integer !== undefined) opts.minimumIntegerDigits = Math.max(1, Math.min(21, f.min_integer));
  // significant digits take precedence over fraction digits (as in Intl)
  if (f.min_significant !== undefined) opts.minimumSignificantDigits = Math.max(1, Math.min(21, f.min_significant));
  if (f.max_significant !== undefined) opts.maximumSignificantDigits = Math.max(opts.minimumSignificantDigits ?? 1, Math.min(21, f.max_significant));
  if (f.grouping !== undefined) opts.useGrouping = f.grouping;
  if (f.notation === "compact" || f.notation === "scientific" || f.notation === "engineering") opts.notation = f.notation;
  if (f.notation === "percent") opts.style = "percent";
  try {
    return `${f.prefix ?? ""}${v.toLocaleString(undefined, opts)}${f.suffix ?? ""}`;
  } catch {
    // contradictory digit bounds: fall back to the plain number
    return `${f.prefix ?? ""}${fmt(v)}${f.suffix ?? ""}`;
  }
}

/** The color a conditional formatting rule gives a value (the first rule that matches). */
export function ruleFor(rules: FormatRule[] | undefined, column: string, v: unknown): FormatRule | undefined {
  return (rules ?? []).find((r) => {
    if (r.column && r.column !== column) return false;
    const a = Number(v);
    const b = Number(r.value);
    const num = !Number.isNaN(a) && !Number.isNaN(b) && v !== null && v !== "" && r.value !== "";
    switch (r.op) {
      case "gt":
        return num && a > b;
      case "gte":
        return num && a >= b;
      case "lt":
        return num && a < b;
      case "lte":
        return num && a <= b;
      case "eq":
        return num ? a === b : String(v) === String(r.value);
      case "neq":
        return num ? a !== b : String(v) !== String(r.value);
      case "contains":
        return String(v ?? "").toLowerCase().includes(String(r.value).toLowerCase());
      case "between": {
        const c = Number(r.value2);
        return num && !Number.isNaN(c) && r.value2 !== "" && a >= Math.min(b, c) && a <= Math.max(b, c);
      }
    }
  });
}

export function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ------------------------------------------------------------------------------------------------
// Vertex: Graph widget (components/workshop/GraphWidgets.tsx): the logic that needs no rendering
// ------------------------------------------------------------------------------------------------

export type VxPos = Record<string, { x: number; y: number }>;
export type VxRef = { object_type_id: string; primary_key: string; x?: number; y?: number };
/** A graph node's id, as api/vertex.py builds it. */
export const vxNodeId = (r: { object_type_id: string; primary_key: unknown }) => `${r.object_type_id}|${r.primary_key}`;

/** "Add objects to subgraph": the objects a variable holds — primary keys (an object set / array / string variable) of
 * `objectTypeId`, or values carrying their own object_type_id and primary_key — each once, at most `max`. untyped:
 * the keys left out because no object type was chosen for them. */
export function vxRefsOf(v: unknown, objectTypeId?: string, max = 500): { refs: VxRef[]; untyped: number } {
  const items = v === null || v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v];
  const refs: VxRef[] = [];
  const seen = new Set<string>();
  let untyped = 0;
  for (const x of items) {
    const o = x && typeof x === "object" ? (x as { object_type_id?: unknown; primary_key?: unknown }) : null;
    const pk = o ? o.primary_key : x;
    if (pk === null || pk === undefined || pk === "" || typeof pk === "object") continue;
    const type = (o && typeof o.object_type_id === "string" && o.object_type_id) || objectTypeId;
    if (!type) {
      untyped++;
      continue;
    }
    const r = { object_type_id: type, primary_key: String(pk) };
    const id = vxNodeId(r);
    if (seen.has(id)) continue;
    seen.add(id);
    if (refs.length < max) refs.push(r);
  }
  return { refs, untyped };
}

/** The drawn nodes next to the nodes in `missing` (linked to one of them) that have a position: where objects added
 * without a Search Around are placed beside. */
export function vxPlacedNeighbours(missing: string[], links: VxLink[], pos: VxPos): string[] {
  const miss = new Set(missing);
  const out = new Set<string>();
  for (const e of links) {
    if (miss.has(e.source) && !miss.has(e.target) && pos[e.target]) out.add(e.target);
    if (miss.has(e.target) && !miss.has(e.source) && pos[e.source]) out.add(e.source);
  }
  return [...out];
}

/** "Export as PNG": the frame of the image — the drawing's bounds (user units) with a margin, and the size in pixels
 * (`scale` pixels per unit, made smaller so the longer side is at most `maxSide`, and at least 1 pixel). */
export function vxPngFrame(b: { x: number; y: number; width: number; height: number }, pad = 40, scale = 1.5, maxSide = 4096): { x: number; y: number; w: number; h: number; width: number; height: number } {
  const w = Math.max(1, b.width + pad * 2);
  const h = Math.max(1, b.height + pad * 2);
  const k = Math.min(scale, maxSide / Math.max(w, h));
  return { x: b.x - pad, y: b.y - pad, w, h, width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** "Zoom to object set": the ids of the drawn nodes whose primary key is in the set (of one object type when given). */
export function vxZoomTargets(nodes: { id: string; object_type_id: string; primary_key: string }[], pks: string[] | null, objectTypeId?: string): string[] {
  if (!pks?.length) return [];
  const want = new Set(pks.map(String));
  return nodes.filter((n) => (!objectTypeId || n.object_type_id === objectTypeId) && want.has(String(n.primary_key))).map((n) => n.id);
}

/** The positions the Vertex canvas fits its view to when only `ids` are to be shown: theirs alone. The canvas refits
 * when the number of positions changes, so the result has as many entries as `pos` (placeholders the canvas never
 * draws). No id with a position: `pos` itself (the whole graph). */
export function vxFocusPos(pos: VxPos, ids: string[]): VxPos {
  const out: VxPos = {};
  for (const id of ids) if (pos[id]) out[id] = pos[id];
  const kept = Object.keys(out);
  if (!kept.length) return pos;
  const missing = Object.keys(pos).length - kept.length;
  for (let i = 0; i < missing; i++) out[`\u0000${i}`] = out[kept[0]];
  return out;
}

/** The references of `found` that are not on the graph yet, each once (a Search Around returns its start objects too). */
export function vxNewRefs(existing: VxRef[], found: VxRef[]): VxRef[] {
  const have = new Set(existing.map(vxNodeId));
  const out: VxRef[] = [];
  for (const r of found) {
    const id = vxNodeId(r);
    if (have.has(id)) continue;
    have.add(id);
    out.push({ ...r, primary_key: String(r.primary_key) });
  }
  return out;
}

/** Where objects added from `sourceIds` go: columns of at most `maxRows` to the right of the sources, centered on
 * them, moved further right until no node already drawn is in the way. */
export function vxPlaceAdded(pos: VxPos, sourceIds: string[], newIds: string[], gapX = 260, gapY = 90, maxRows = 12): VxPos {
  const out: VxPos = {};
  if (!newIds.length) return out;
  const all = Object.values(pos);
  const from = sourceIds.map((id) => pos[id]).filter(Boolean);
  const ref = from.length ? from : all;
  const cy = ref.length ? ref.reduce((a, p) => a + p.y, 0) / ref.length : 0;
  const rows = Math.min(newIds.length, maxRows);
  const cols = Math.ceil(newIds.length / rows);
  const top = cy - ((rows - 1) * gapY) / 2;
  const bottom = top + (rows - 1) * gapY;
  let x0 = (ref.length ? Math.max(...ref.map((p) => p.x)) : -gapX) + gapX;
  const taken = (x: number) => all.some((p) => p.x > x - gapX / 2 && p.x < x + (cols - 1) * gapX + gapX / 2 && p.y > top - gapY / 2 && p.y < bottom + gapY / 2);
  for (let i = 0; i < 500 && taken(x0); i++) x0 += gapX;
  newIds.forEach((id, i) => (out[id] = { x: x0 + Math.floor(i / rows) * gapX, y: top + (i % rows) * gapY }));
  return out;
}

/** "Save as a new graph": the graph as drawn (its objects at their positions, with the objects added in the widget),
 * under a new name — never the saved graph's id, owner, read-only flag or template. */
export function vxSaveBody<G extends Record<string, unknown>>(graph: G, name: string, nodes: { id: string; object_type_id: string; primary_key: string }[], pos: VxPos): Record<string, unknown> {
  const { id: _id, owner: _owner, created_at: _created, updated_at: _updated, ...rest } = graph;
  void [_id, _owner, _created, _updated];
  return {
    ...rest,
    name: name.trim() || "Untitled graph",
    nodes: nodes.map((n) => ({ object_type_id: n.object_type_id, primary_key: n.primary_key, ...(pos[n.id] ? { x: Math.round(pos[n.id].x), y: Math.round(pos[n.id].y) } : {}) })),
    read_only: false,
    template: null,
  };
}

type VxLink = { source: string; target: string };

/** Each node's neighbours through the edges given (both directions). */
function vxAdjacency(edges: VxLink[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  return adj;
}

/** "Select neighbours": the nodes given and every node one edge away from them. */
export function vxNeighbours(ids: Iterable<string>, edges: VxLink[]): Set<string> {
  const adj = vxAdjacency(edges);
  const out = new Set(ids);
  for (const id of [...out]) for (const x of adj.get(id) ?? []) out.add(x);
  return out;
}

/** "Select connected": every node of the connected parts (sub-graphs) that hold one of the nodes given. */
export function vxConnected(ids: Iterable<string>, edges: VxLink[]): Set<string> {
  const adj = vxAdjacency(edges);
  const out = new Set(ids);
  const queue = [...out];
  while (queue.length) {
    for (const x of adj.get(queue.pop()!) ?? []) {
      if (!out.has(x)) {
        out.add(x);
        queue.push(x);
      }
    }
  }
  return out;
}

/** Box select: the nodes whose drawn center lies in the box (screen coordinates, corners in any order). */
export function vxInBox(rects: { id: string; x: number; y: number; w: number; h: number }[], box: { x1: number; y1: number; x2: number; y2: number }): string[] {
  const [l, r] = [Math.min(box.x1, box.x2), Math.max(box.x1, box.x2)];
  const [t, b] = [Math.min(box.y1, box.y2), Math.max(box.y1, box.y2)];
  return rects.filter((q) => q.x + q.w / 2 >= l && q.x + q.w / 2 <= r && q.y + q.h / 2 >= t && q.y + q.h / 2 <= b).map((q) => q.id);
}

/** The selected objects' primary keys per object type (every type in `types` present, empty when none is selected). */
export function vxByType(nodes: { id: string; object_type_id: string; primary_key: string }[], ids: Set<string>, types: string[] = []): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(types.map((t) => [t, [] as string[]]));
  for (const n of nodes) if (ids.has(n.id)) (out[n.object_type_id] ??= []).push(n.primary_key);
  return out;
}

/** "Sub-graph": the ids of the nodes in the connected parts holding an object of the set (of one type when given);
 * null (the whole graph) when the set is empty or none of its objects is on the graph. */
export function vxSubgraph(nodes: { id: string; object_type_id: string; primary_key: string }[], edges: VxLink[], pks: string[] | null, objectTypeId?: string): Set<string> | null {
  const seeds = vxZoomTargets(nodes, pks, objectTypeId);
  if (!seeds.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  return vxConnected(seeds, edges.filter((e) => ids.has(e.source) && ids.has(e.target)));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A date or timestamp variable's value as a bound the API compares with (api/vertex.py compares the text): a date
 * stays a date (an end: that day's last second, as the Vertex page sends it), a number (epoch ms) or Date becomes ISO
 * text, other text is kept. No value: undefined. */
export function vxTimeBound(v: unknown, end = false): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v).toISOString() : undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return DAY.test(s) && end ? `${s}T23:59:59` : s;
}

/** A time as an instant: a date is that day's start (UTC), a timestamp without a zone is read as UTC (as the API's
 * text comparison treats it). Not a time: null. */
export function vxMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const iso = DAY.test(s) ? `${s}T00:00:00Z` : /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s}Z` : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Whether a node falls in the time window by its own date / timestamp properties: "in" (one of them in it), "out"
 * (it has times, none in it) or "none" (no time: not temporal, never faded). A date covers its whole day. */
export function vxTimeStatus(properties: Record<string, unknown>, timeProps: string[], start?: string, end?: string): "in" | "out" | "none" {
  const s = start ? vxMs(start) : null;
  const e = end ? vxMs(end) : null;
  let any = false;
  for (const p of timeProps) {
    const raw = properties[p];
    const t = vxMs(raw);
    if (t === null) continue;
    any = true;
    const last = typeof raw === "string" && DAY.test(raw.trim()) ? t + 86_399_999 : t;
    if ((s === null || last >= s) && (e === null || t <= e)) return "in";
  }
  return any ? "out" : "none";
}

/** A readout's color: the first threshold it passes (in order), as the Vertex page colors it; none without a value. */
export function vxReadoutColor(readout: { thresholds?: { op: "gt" | "lt"; value: number; color: string }[] } | undefined, value: number | null | undefined): string | undefined {
  if (!readout || value === undefined || value === null) return undefined;
  const v = Number(value);
  return (readout.thresholds ?? []).find((th) => (th.op === "gt" ? v > th.value : v < th.value))?.color;
}

/** What the time selection panel writes to a variable: a date as YYYY-MM-DD, a timestamp (an input's local
 * "YYYY-MM-DDTHH:MM", read as UTC) as ISO text; an empty input: null. */
export function vxTimeValue(input: string, kind: "date" | "timestamp"): string | null {
  const s = input.trim();
  if (!s) return null;
  if (kind === "date") return s.slice(0, 10);
  const t = vxMs(s);
  return t === null ? null : new Date(t).toISOString();
}

/** A value shown in the time selection panel's input: YYYY-MM-DD for a date, YYYY-MM-DDTHH:MM (UTC) for a timestamp. */
export function vxTimeInput(v: unknown, kind: "date" | "timestamp"): string {
  const t = vxMs(v);
  if (t === null) return "";
  const iso = new Date(t).toISOString();
  return kind === "date" ? iso.slice(0, 10) : iso.slice(0, 16);
}
