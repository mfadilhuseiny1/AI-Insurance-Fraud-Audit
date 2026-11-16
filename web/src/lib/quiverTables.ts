/** Quiver table cards (api/quiver_tables.py): transform tables, charts, values and Vega plots on the Contour engine. */
import { API_URL } from "./api";
import type { Board } from "./contour";

/**
 * A cell as people read it (the same as the Markdown / DOCX / PowerPoint exports, api/quiver_tables.display_text): an
 * array as its elements joined by ", ", a struct as "field: value, …", numbers localized; an array or struct inside
 * one is JSON. The data stays typed (arrays are JSON arrays); CSV exports write them as JSON.
 */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(innerText).join(", ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${innerText(x)}`).join(", ");
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function innerText(v: unknown): string {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : cellText(v);
}

export type TableSource =
  | { kind: "object_set"; card: string }
  | { kind: "table"; card: string }
  /** a time series (or search / event set) card of the analysis' logic: timestamp + value, or start + end + title */
  | { kind: "series"; card: string }
  | { kind: "dataset"; id: string }
  | { kind: "values"; columns: string[]; rows: unknown[][] };
export type ChartKind = "bar" | "line" | "pie" | "scatter" | "histogram" | "distribution" | "time_series" | "heatmap" | "pivot";
/** A time series column's range (the sparkline's view range): the analysis' range, the full extent, fixed or relative. */
export type SeriesRange = "analysis" | "full" | { start?: string; end?: string } | { last: string };
export const SERIES_OPS = [
  ["last", "Last value"],
  ["first", "First value"],
  ["mean", "Mean"],
  ["min", "Minimum"],
  ["max", "Maximum"],
  ["sum", "Sum"],
  ["count", "Count of points"],
  ["std", "Standard deviation"],
  ["median", "Median"],
  ["range", "Max − min"],
  ["value_at", "Value at time"],
  ["start", "Time series start date"],
  ["end", "Time series end date"],
  ["sparkline", "Sparkline"],
  ["unit", "Time series unit"],
] as const;
export type SeriesOp = (typeof SERIES_OPS)[number][0];
/** Series-to-series transforms of a time series column, applied in order before its operation (the doc's "Add Transformation"). */
export const SERIES_TRANSFORMS = [
  ["rolling", "Rolling aggregate"],
  ["periodic", "Periodic aggregate"],
  ["cumulative", "Cumulative aggregate"],
  ["derivative", "Derivative"],
  ["integral", "Integral"],
  ["shift", "Shift time series"],
  ["sample", "Sample"],
  ["filter", "Filter time series"],
  ["dsp", "DSP filter"],
] as const;
export type SeriesTransformType = (typeof SERIES_TRANSFORMS)[number][0];
export const SERIES_AGGREGATIONS = ["mean", "sum", "min", "max", "count", "std", "median", "first", "last", "range"] as const;
export type SeriesTransform = {
  type: SeriesTransformType;
  /** rolling / dsp: a duration (7d, 1h, 15m); rolling windows end at each point, inclusive */
  window?: string;
  aggregation?: (typeof SERIES_AGGREGATIONS)[number];
  /** periodic: a calendar period (1h, 1d, 1w, 1mo) */
  period?: string;
  /** derivative / integral: per s | m | h | d */
  unit?: string;
  /** shift: a signed duration */
  by?: string;
  /** sample: the interval */
  every?: string;
  /** filter: keep values in [min, max] */
  min?: number;
  max?: number;
  /** dsp: moving_average | ema | lowpass | highpass */
  filter?: string;
  alpha?: number;
};
/** The server's defaults (api/quiver_series.py TRANSFORMS); they also name the column. */
export const SERIES_TRANSFORM_DEFAULTS: Record<SeriesTransformType, Partial<SeriesTransform>> = {
  rolling: { window: "1h", aggregation: "mean" },
  periodic: { period: "1d", aggregation: "mean" },
  cumulative: { aggregation: "sum" },
  derivative: { unit: "s" },
  integral: { unit: "s" },
  shift: { by: "0s" },
  sample: { every: "1h" },
  filter: {},
  dsp: { filter: "moving_average", window: "1h" },
};
const TRANSFORM_NAME_KEYS: Partial<Record<SeriesTransformType, (keyof SeriesTransform)[]>> = {
  rolling: ["aggregation", "window"],
  periodic: ["aggregation", "period"],
  cumulative: ["aggregation"],
  shift: ["by"],
  sample: ["every"],
  dsp: ["filter"],
};
/** A column computed from each row's time series (api/quiver_series.py); property: a time series property or "sensor:<name>". */
export type SeriesColumn = { name?: string; property: string; op: SeriesOp; range?: SeriesRange; at?: string; points?: number; transforms?: SeriesTransform[] };
export type SeriesColumnInfo = { property: string; op: SeriesOp; kind: "sparkline" | "time" | "number" | "value" | "text"; unit?: string | null; range: [string | null, string | null]; transforms?: SeriesTransform[] };
export type TableCard = { id: string; kind: "table"; title: string; source: TableSource; steps: Board[]; columns?: string[]; series_columns?: SeriesColumn[] };
export type ChartCard = { id: string; kind: "chart"; title: string; source: { card: string }; chart: ChartKind; config: Record<string, unknown> };
export type ValueCard = { id: string; kind: "value"; title: string; source: { card: string }; expr: string };
export type VegaCard = { id: string; kind: "vega"; title: string; tables: string[]; spec: string };
/** Cross filter: the input filtered by the subscribed charts' selections; the charts filter each other. */
export type CrossFilterCard = { id: string; kind: "cross_filter"; title: string; source: { card: string }; subscribed: string[]; selections: Record<string, unknown[]> };
/** An Action button: an Ontology action with parameter defaults (constants, or "$V1" for a value card's result). */
export type ActionCard = { id: string; kind: "action"; title: string; action_id: string; defaults: Record<string, string> };
/** A grouped time series plot: a transform table's sparkline column, one line per row (a page of rows at a time), with
 * an optional linear aggregation across every row's series (api/quiver_tables.py _grouped_plot). */
export type GroupedPlotCard = { id: string; kind: "grouped_plot"; title: string; source: { card: string }; column?: string; label?: string; page_size?: number; page?: number; aggregate?: GroupedAggregate };
export const GROUPED_AGGREGATES = ["mean", "sum", "min", "max", "count", "median", "std", "range"] as const;
export type GroupedAggregate = (typeof GROUPED_AGGREGATES)[number];
/* Single cards (api/quiver_cards.py). An operand is "$ID" (another card's value or a parameter) or a literal. */
export const AGGREGATIONS = [
  ["count", "Count"],
  ["unique_count", "Unique count"],
  ["sum", "Sum"],
  ["mean", "Average"],
  ["min", "Minimum"],
  ["max", "Maximum"],
  ["median", "Median"],
  ["percentile", "Percentile"],
  ["std", "Standard deviation (sample)"],
  ["variance", "Variance (sample)"],
  ["product", "Product"],
  ["first", "First value"],
  ["last", "Last value"],
  ["difference", "Difference (last − first)"],
  ["relative_difference", "Relative difference ((last − first) / |first|)"],
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number][0];
/** Aggregations a date column takes (the result is a date for min / max / first / last). */
export const DATE_AGGREGATIONS: Aggregation[] = ["count", "unique_count", "min", "max", "first", "last"];
export const DATE_UNITS = ["week", "day", "hour", "minute", "second", "millisecond"] as const;
export const DATE_PARTS = [
  ["day_of_week", "Day of week (Monday 1 … Sunday 7)"],
  ["day_of_month", "Day of month"],
  ["day_of_year", "Day of year"],
  ["hour", "Hour of day"],
  ["month", "Month"],
  ["year", "Year"],
] as const;
export const WATERFALL_METRICS = [["count", "Count"], ["sum", "Sum"], ["avg", "Average"], ["min", "Minimum"], ["max", "Maximum"], ["unique_count", "Unique count"]] as const;
/** Numeric aggregation (object set), Transform table aggregation (table) or Number array aggregation (column values card). */
export type NumericAggCard = { id: string; kind: "numeric_agg"; title: string; source: { card: string }; aggregation: Aggregation; column?: string; percentile?: number };
/** Transform table column values / unique values: a column as an array. */
export type ColumnValuesCard = { id: string; kind: "column_values"; title: string; source: { card: string }; column: string; distinct?: boolean; sort?: "" | "asc" | "desc"; limit?: number };
export type NumericFormulaCard = { id: string; kind: "numeric_formula"; title: string; formula: string };
/** Floor / Ceiling (and rounding) of a number, optionally to a number of digits (negative: tens, hundreds …). */
export type RoundCard = { id: string; kind: "round"; title: string; mode: "floor" | "ceil" | "round"; input: string; digits?: number };
export type DateDiffCard = { id: string; kind: "date_diff"; title: string; start: string; end: string; unit: (typeof DATE_UNITS)[number] };
export type DatePartCard = { id: string; kind: "date_part"; title: string; input: string; part: (typeof DATE_PARTS)[number][0] };
export type CorrelationCard = { id: string; kind: "correlation"; title: string; source: { card: string }; columns?: string[]; method: "pearson" | "spearman" };
/** Waterfall plot: buckets from an object set / table grouped by a column, or steps of numbers (literals or "$ID"). */
export type WaterfallCard = {
  id: string;
  kind: "waterfall";
  title: string;
  source: { card: string };
  group_by?: string;
  metric?: (typeof WATERFALL_METRICS)[number][0];
  measure?: string;
  sort?: "" | "value_asc" | "key";
  limit?: number;
  steps?: { label: string; input: string }[];
  total?: boolean;
  total_label?: string;
};
export const STRING_OPS = [
  ["concatenate", "Concatenate"],
  ["substring", "Substring"],
  ["find_replace", "Find and replace"],
  ["lower", "To lower case"],
  ["upper", "To upper case"],
  ["trim", "Trim spaces"],
  ["length", "String length"],
  ["regex_extract", "Regex extract"],
  ["split", "Split (to a string array)"],
  ["to_number", "String to number"],
  ["to_boolean", "String to Boolean"],
  ["date_to_string", "Date to string"],
] as const;
export type StringOp = (typeof STRING_OPS)[number][0];
/** A string operation (api/quiver_cards.py string_op); inputs are "$ID" or typed text. */
export type StringOpCard = {
  id: string;
  kind: "string_op";
  title: string;
  op: StringOp;
  input: string;
  /** concatenate: the second string and the delimiter between them */
  input2?: string;
  delimiter?: string;
  /** substring: start (0 first, negative from the end) and length (empty: to the end) */
  start?: string;
  length?: string;
  /** find and replace */
  find?: string;
  replace?: string;
  regex?: boolean;
  ignore_case?: boolean;
  /** regex extract */
  pattern?: string;
  group?: number;
  /** split: trim each part (default on), leave out empty parts */
  trim?: boolean;
  drop_empty?: boolean;
  /** string to Boolean */
  true_values?: string[];
  false_values?: string[];
  default?: boolean;
  /** date to string: YYYY-MM-DD, DD MMM YYYY HH:mm, dddd … ([text] is literal; empty: ISO) */
  format?: string;
};
export const COMPARISONS = [
  ["eq", "Equal to", "number"],
  ["neq", "Not equal to", "number"],
  ["gt", "Greater than", "number"],
  ["gte", "Greater than or equal to", "number"],
  ["lt", "Less than", "number"],
  ["lte", "Less than or equal to", "number"],
  ["is", "Is", "string"],
  ["is_not", "Is not", "string"],
  ["contains", "Contains", "string"],
  ["not_contains", "Does not contain", "string"],
  ["starts_with", "Starts with", "string"],
  ["ends_with", "Ends with", "string"],
  ["before", "Before", "date"],
  ["on_or_before", "On or before", "date"],
  ["after", "After", "date"],
  ["on_or_after", "On or after", "date"],
  ["on", "On", "date"],
  ["not_on", "Not on", "date"],
  ["between", "Between (inclusive)", "date"],
] as const;
export type ComparisonOp = (typeof COMPARISONS)[number][0];
/** Boolean comparison cards: numbers, strings / Booleans or dates; null when an input is empty. */
export type ComparisonCard = { id: string; kind: "comparison"; title: string; op: ComparisonOp; left: string; right: string; right2?: string; ignore_case?: boolean; whole_words?: boolean };
export type BooleanFormulaCard = { id: string; kind: "boolean_formula"; title: string; formula: string };
export const ARRAY_ELEMENT_TYPES = ["auto", "string", "number", "boolean", "date"] as const;
/** Create array: typed values and cards' values; an array card's values are spliced in. */
export type CreateArrayCard = { id: string; kind: "create_array"; title: string; items: string[]; element_type?: (typeof ARRAY_ELEMENT_TYPES)[number] };
export type SteppedArrayCard = { id: string; kind: "stepped_array"; title: string; start: string; end: string; step: string };
export const ARRAY_OPS = [
  ["length", "Array length"],
  ["first", "Array start (first value)"],
  ["last", "Array end (last value)"],
  ["at", "Value at index"],
  ["contains", "Array contains"],
  ["join", "Array join (to a string)"],
  ["sort", "Array sort"],
  ["unique", "Unique values"],
  ["to_numbers", "Strings to numbers"],
  ["to_dates", "Strings to dates"],
  ["to_booleans", "Strings to booleans"],
] as const;
export type ArrayOp = (typeof ARRAY_OPS)[number][0];
export type ArrayOpCard = { id: string; kind: "array_op"; title: string; op: ArrayOp; input: string; index?: string; value?: string; delimiter?: string; order?: "asc" | "desc" };
/** Coalesce: the first input that is not null. */
export type CoalesceCard = { id: string; kind: "coalesce"; title: string; inputs: string[] };
export const RANGE_TYPES = ["auto", "number", "date"] as const;
/** A numeric or date / time range from two inputs (typed, cards' values or parameters); its value is {start, end}. */
export type RangeCard = { id: string; kind: "range"; title: string; start: string; end: string; range_type?: (typeof RANGE_TYPES)[number] };
export const RANGE_OPS = [
  ["start", "Range start"],
  ["end", "Range end"],
  ["to_date_range", "Numeric range to date range"],
] as const;
/** The start / end of a range card or of a date / time range parameter; a numeric range (epoch ms) as a date range. */
export type RangeOpCard = { id: string; kind: "range_op"; title: string; op: (typeof RANGE_OPS)[number][0]; input: string };
/** A selection: one value, or a list of values when the selector is a multiselect. The saved value is the default; a
 * dashboard viewer's selection applies to their view only. */
export type Selection = string | number | (string | number)[] | null;
/** String selector (source.card empty: the typed options): typed options, the distinct values of a column of an object set / table, or an array card's values. */
export type StringSelectorCard = { id: string; kind: "string_selector"; title: string; options?: string[]; source: { card: string }; column?: string; multiple?: boolean; value?: Selection };
/** Property value select parameter: the values of an object set property, with the property's type. */
export type PropertySelectCard = { id: string; kind: "property_select"; title: string; source: { card: string }; property: string; multiple?: boolean; value?: Selection };
/** Object selector: objects of an object set by primary key; the card is itself an object set (the selected objects). */
export type ObjectSelectorCard = { id: string; kind: "object_selector"; title: string; source: { card: string }; label?: string; multiple?: boolean; value?: Selection };
/** Transform table row selector: one row, by a key column's value or by its row index (0 first); $ID.column reads a cell. */
export type RowSelectorCard = { id: string; kind: "row_selector"; title: string; source: { card: string }; key?: string; label?: string; value?: Selection };
export const DATE_CONVERSIONS = [
  ["string_to_date", "String to date"],
  ["number_to_date", "Number to date"],
] as const;
export const NUMBER_DATE_UNITS = ["milliseconds", "seconds", "days"] as const;
/** String / number to date: a Day.js format (empty: ISO or MM/DD/YYYY) and time zone, or epoch units. */
export type DateConvertCard = { id: string; kind: "date_convert"; title: string; op: (typeof DATE_CONVERSIONS)[number][0]; input: string; format?: string; timezone?: string; unit?: (typeof NUMBER_DATE_UNITS)[number] };
export const PERIODS = [
  ["day", "Day to date"],
  ["week", "Week to date"],
  ["month", "Month to date"],
  ["year", "Year to date"],
] as const;
/** Day / week / month / year to date: the range from the start of the input date's period (UTC) to the date (empty: now). */
export type PeriodToDateCard = { id: string; kind: "period_to_date"; title: string; period: (typeof PERIODS)[number][0]; input?: string; week_start?: "monday" | "sunday" };
/** A property of the one object of an object selector (or of an object set holding one object). */
export type ObjectPropertyCard = { id: string; kind: "object_property"; title: string; source: { card: string }; property: string };
export const MULTIPASS_ATTRIBUTES = [
  ["id", "User ID"],
  ["username", "Username"],
  ["display_name", "Display name"],
  ["first_name", "Given name"],
  ["last_name", "Family name"],
  ["email", "Email"],
  ["role", "Role"],
  ["organization", "Organization"],
  ["groups", "Groups"],
] as const;
/** An attribute of the current user (or the ID / username / display name of the user whose ID is `user`); a custom
 * attribute is "attribute:<name>". */
export type MultipassAttributeCard = { id: string; kind: "multipass_attribute"; title: string; attribute: string; user?: string };
export const XY_RANGE_TYPES = ["auto", "number", "date", "string"] as const;
/** Two ranges (a box): $ID.x and $ID.y are range inputs. */
export type XyRangeCard = {
  id: string; kind: "xy_range"; title: string; x_start: string; x_end: string; y_start: string; y_end: string;
  x_type?: (typeof XY_RANGE_TYPES)[number]; y_type?: (typeof XY_RANGE_TYPES)[number];
};
/* Time series single cards: their input is a time series card of the analysis' logic (source.card: "A"). */
/** The range a time series card reads: the analysis' time range (empty), the full series, a fixed or relative range,
 * or "$ID" — a range card or a date / time range parameter. */
export type CardRange = "" | "analysis" | "full" | `$${string}` | { start?: string; end?: string } | { last: string };
export const SERIES_CARD_AGGREGATIONS = [
  ["sum", "Sum"],
  ["mean", "Average"],
  ["std", "Standard deviation"],
  ["max", "Maximum"],
  ["min", "Minimum"],
  ["relative_difference", "Relative difference ((last − first) / |first|)"],
  ["difference", "Difference (last − first)"],
  ["product", "Product"],
  ["count", "Count of points"],
  ["first", "First point"],
  ["last", "Last point"],
  ["time_weighted_average", "Time-weighted average"],
  ["integral", "Integral"],
  ["median", "Median"],
  ["percentile", "Percentile"],
  ["range", "Max − min"],
] as const;
export const INTEGRATION_METHODS = [["linear", "Linear (trapezoids)"], ["lhs", "Left-hand side (a value holds until the next point)"], ["rhs", "Right-hand side (a value holds back to the previous point)"]] as const;
export const BOUNDS_INTERPOLATIONS = [["none", "None (only between the points inside)"], ["linear", "Linear"], ["nearest", "Nearest point"], ["previous", "Previous point"], ["next", "Next point"]] as const;
export const TIME_UNITS = [["s", "second"], ["m", "minute"], ["h", "hour"], ["d", "day"]] as const;
export type TimeUnit = (typeof TIME_UNITS)[number][0];
/** Time series numeric aggregation: one number from a numeric series over a range. */
export type SeriesAggCard = {
  id: string; kind: "series_agg"; title: string; source: { card: string }; aggregation: (typeof SERIES_CARD_AGGREGATIONS)[number][0]; range?: CardRange; percentile?: number;
  /** time-weighted average and integral: how the area between two points is taken, and how the curve reaches the range's ends */
  method?: (typeof INTEGRATION_METHODS)[number][0]; bounds?: (typeof BOUNDS_INTERPOLATIONS)[number][0];
  /** integral: the area per second, minute, hour or day */
  time_unit?: TimeUnit;
};
export const SERIES_CARD_OPS = [
  ["value_at", "Value at time"],
  ["enum_value_at", "Enum value at time"],
  ["latest_enum", "Latest value for enum time series"],
  ["unit", "Time series unit"],
  ["start", "Time series start date"],
  ["end", "Time series end date"],
  ["backing_object", "Backing object from time series"],
] as const;
export type SeriesCardOp = (typeof SERIES_CARD_OPS)[number][0];
export const SERIES_INTERPOLATIONS = ["LINEAR", "NEAREST", "PREVIOUS", "NEXT", "NONE"] as const;
/** One value from a time series card: its value at a time (by its interpolation, or the one chosen), its latest enum
 * value, its unit, the first / last point's date in the range, or the object it is read for. */
export type SeriesOpCard = {
  id: string; kind: "series_op"; title: string; op: SeriesCardOp; source: { card: string }; at?: string;
  interpolation?: "" | (typeof SERIES_INTERPOLATIONS)[number]; external?: "" | "NEAREST" | "NONE"; range?: CardRange;
};
export const REGRESSION_FITS = [["linear", "Linear (y = c0 + c1·x)"], ["polynomial", "Polynomial (degree 0–13)"], ["exponential", "Exponential (y = a·e^(b·x))"]] as const;
export type RegressionFit = (typeof REGRESSION_FITS)[number][0];
/** Regression coefficients as a number array, lowest power first: of a time series against time (x: the time since
 * the first point in x_unit), or of a time series scatter plot card's points. */
export type RegressionCard = { id: string; kind: "regression"; title: string; source: { card: string }; fit: RegressionFit; degree?: number; x_unit?: TimeUnit; range?: CardRange };
/** Shift date/time: the date (empty: now) moved by a number of weeks … milliseconds (negative: earlier). */
export type ShiftDatetimeCard = { id: string; kind: "shift_datetime"; title: string; input?: string; amount: string; unit: (typeof DATE_UNITS)[number] };
/** Time series distribution: counts of a series' values per bin (an enum series: per value). */
export type SeriesDistributionCard = { id: string; kind: "series_distribution"; title: string; source: { card: string }; bins?: number; range?: CardRange };
export const BUCKET_VALUES = ["mean", "sum", "min", "max", "median", "first", "last"] as const;
/** Time series scatter plot / heat grid: two series joined and aggregated per time bucket; fit draws the regression line. */
export type SeriesScatterCard = {
  id: string; kind: "series_scatter"; title: string; x: { card: string }; y: { card: string }; range?: CardRange; buckets?: number;
  bucket_value?: (typeof BUCKET_VALUES)[number]; view?: "scatter" | "heat_grid"; grid?: number; fit?: "" | RegressionFit; degree?: number;
};
export type SeriesSingleCard = SeriesAggCard | SeriesOpCard | RegressionCard | ShiftDatetimeCard | SeriesDistributionCard | SeriesScatterCard;
/** Object set card filter operators (api/quiver_cards.py OBJECT_FILTER_OPS): [op, label, takes a value]. */
export const OBJECT_FILTER_OPS = [
  ["eq", "is", true],
  ["neq", "is not", true],
  ["in", "is one of (a, b, …)", true],
  ["contains", "contains", true],
  ["starts_with", "starts with", true],
  ["gt", ">", true],
  ["gte", "≥", true],
  ["lt", "<", true],
  ["lte", "≤", true],
  ["between", "between (from, to)", true],
  ["is_null", "is empty", false],
  ["not_null", "has a value", false],
  ["regex", "matches regex", true],
  ["wildcard", "matches wildcard (* ?)", true],
] as const;
export type ObjectFilterOp = (typeof OBJECT_FILTER_OPS)[number][0] | "linked" | "not_linked";
/** A filter condition: on a property, on a linked object's property (link: "<link type>:<forward|reverse>"; linked /
 * not_linked without a property: linked to any object / to none), or a nested group. A value is typed or "$ID". */
export type ObjectCondition =
  | { property: string; op: ObjectFilterOp; value?: string; link?: string; negate?: boolean }
  | { match: "all" | "any"; conditions: ObjectCondition[]; negate?: boolean };
export const isConditionGroup = (c: ObjectCondition): c is Extract<ObjectCondition, { conditions: ObjectCondition[] }> => Array.isArray((c as { conditions?: unknown }).conditions);
/** Filter object set: the input's objects matching every (all) or any condition. */
export type FilterObjectSetCard = { id: string; kind: "filter_object_set"; title: string; source: { card: string }; match?: "all" | "any"; conditions: ObjectCondition[] };
export const SET_MATH_OPS = [
  ["union", "Union (in any set)"],
  ["intersection", "Intersection (in every set)"],
  ["difference", "Difference (in the first set, not in the others)"],
] as const;
/** Set math: object sets of the same type combined. */
export type SetMathCard = { id: string; kind: "set_math"; title: string; inputs: string[]; op: (typeof SET_MATH_OPS)[number][0] };
/** Switch to linked object set (a search around): the objects linked to the input's objects. */
export type LinkedObjectSetCard = { id: string; kind: "linked_object_set"; title: string; source: { card: string }; link: string };
/** Status filter: objects open (or closed) during a time range, by a start and an end date property. */
export type StatusFilterCard = { id: string; kind: "status_filter"; title: string; source: { card: string }; start_property: string; end_property: string; status: "open" | "closed"; range?: CardRange };
/** Object view: one object — of an object set holding one (source), or by type and primary key (typed or "$ID"). */
export type ObjectViewCard = { id: string; kind: "object_view"; title: string; source?: { card: string }; object_type_id?: string; primary_key?: string };
/** Defined by property: the objects (of the input, or of a whole type) whose property holds one of the values — another
 * card's column / property (`from`; without a property: an array or value card's value) or typed / "$ID" values (e.g.
 * a saved object set's identifier). */
export type DefinedByPropertyCard = { id: string; kind: "defined_by_property"; title: string; source?: { card: string }; object_type_id?: string; property: string; from?: { card: string; property?: string }; value?: string };
/** Import saved object set: an Object Explorer exploration or an object list (RID ri.object-set.main.exploration.<id> / .list.<id>). */
export type SavedObjectSetCard = { id: string; kind: "saved_object_set"; title: string; object_set: string };
export type ObjectSetSingleCard = FilterObjectSetCard | SetMathCard | LinkedObjectSetCard | StatusFilterCard | ObjectViewCard | DefinedByPropertyCard | SavedObjectSetCard;
/** Object set cards: each is itself an object set other cards read as their input. */
export const OBJECT_SET_CARD_KINDS = ["filter_object_set", "set_math", "linked_object_set", "status_filter", "object_view", "defined_by_property", "saved_object_set"] as const;
/** A saved object set an "Import saved object set" card picks (GET /api/quiver-tables/saved-object-sets). */
export type SavedObjectSet = { rid: string; kind: "exploration" | "list"; id: string; name: string; description: string; object_type_id: string | null; object_type: string | null; owner?: string; created_at?: string; count?: number };
export const isObjectSetCardKind = (kind: string) => (OBJECT_SET_CARD_KINDS as readonly string[]).includes(kind);
/** Cards whose rows are whole objects of one type (inputs of the object set cards). */
export const OBJECT_INPUT_KINDS = ["object_set", "object_selector", ...OBJECT_SET_CARD_KINDS] as const;
export const SERIES_SINGLE_KINDS = ["series_agg", "series_op", "regression", "shift_datetime", "series_distribution", "series_scatter"] as const;
export const isSeriesSingleCard = (c: { kind: string }): c is SeriesSingleCard => (SERIES_SINGLE_KINDS as readonly string[]).includes(c.kind);
/** Single cards drawn as a chart (wide on a dashboard, with a CSV export). */
export const CHART_SINGLE_KINDS = ["correlation", "waterfall", "series_distribution", "series_scatter"] as const;
export const isChartSingleKind = (kind: string) => (CHART_SINGLE_KINDS as readonly string[]).includes(kind);
export type SingleCard =
  | SeriesSingleCard
  | NumericAggCard | ColumnValuesCard | NumericFormulaCard | RoundCard | DateDiffCard | DatePartCard | CorrelationCard | WaterfallCard
  | StringOpCard | ComparisonCard | BooleanFormulaCard | CreateArrayCard | SteppedArrayCard | ArrayOpCard | CoalesceCard
  | RangeCard | RangeOpCard
  | StringSelectorCard | PropertySelectCard | ObjectSelectorCard | RowSelectorCard
  | DateConvertCard | PeriodToDateCard | ObjectPropertyCard | MultipassAttributeCard | XyRangeCard
  | ObjectSetSingleCard;
export const SINGLE_CARD_KINDS = ["numeric_agg", "column_values", "numeric_formula", "round", "date_diff", "date_part", "correlation", "waterfall",
  "string_op", "comparison", "boolean_formula", "create_array", "stepped_array", "array_op", "coalesce", "range", "range_op",
  "string_selector", "property_select", "object_selector", "row_selector",
  "date_convert", "period_to_date", "object_property", "multipass_attribute", "xy_range", ...SERIES_SINGLE_KINDS, ...OBJECT_SET_CARD_KINDS] as const;
/** Selector parameter cards: a viewer changes their value (`value`; a list when `multiple`). */
export const SELECTOR_CARD_KINDS = ["string_selector", "property_select", "object_selector", "row_selector"] as const;
export const isSelectorCard = (c: { kind: string }): c is StringSelectorCard | PropertySelectCard | ObjectSelectorCard | RowSelectorCard =>
  (SELECTOR_CARD_KINDS as readonly string[]).includes(c.kind);
/** The single cards of the "Tables & charts" menu, grouped: [kind, label, the new card's settings that differ from the
 * kind's defaults (a card of the reference that is one operation of a kind)]. */
export const SINGLE_CARD_MENU: { group: string; items: [SingleCard["kind"], string, Record<string, unknown>?][] }[] = [
  { group: "Objects (object sets)", items: [
    ["filter_object_set", "Filter object set (properties, linked objects, nested and / or)"],
    ["set_math", "Set math (union, intersection, difference)"],
    ["linked_object_set", "Switch to linked object set (search around)"],
    ["status_filter", "Status filter (open / closed during a time range)"],
    ["object_view", "Object view (one object's properties)"],
    ["defined_by_property", "Defined by property (objects whose property holds another card's values)"],
    ["saved_object_set", "Import saved object set (an exploration or an object list)"],
  ] },
  { group: "Selectors (parameters)", items: [
    ["string_selector", "String selector (typed options, a column's values or an array)"],
    ["property_select", "Property value select (an object set property's values)"],
    ["object_selector", "Object selector (objects of an object set)"],
    ["row_selector", "Transform table row selector"],
  ] },
  { group: "Dates and data", items: [
    ["date_convert", "String / number to date"],
    ["period_to_date", "Day / week / month / year to date"],
    ["object_property", "Object property (of a selected object)"],
    ["multipass_attribute", "Multipass attribute (the current user)"],
    ["xy_range", "X/Y range"],
    ["shift_datetime", "Shift date/time (a date moved by weeks … milliseconds)"],
  ] },
  { group: "Time series (values and charts)", items: [
    ["series_agg", "Time series numeric aggregation (sum, average, time-weighted average, integral …)"],
    ["series_op", "Value at time", { op: "value_at", title: "Value at time" }],
    ["series_op", "Enum value at time", { op: "enum_value_at", title: "Enum value at time" }],
    ["series_op", "Latest value for enum time series", { op: "latest_enum", title: "Latest value for enum time series" }],
    ["series_op", "Time series unit", { op: "unit", title: "Time series unit" }],
    ["series_op", "Time series start date", { op: "start", title: "Time series start date" }],
    ["series_op", "Time series end date", { op: "end", title: "Time series end date" }],
    ["series_op", "Backing object from time series", { op: "backing_object", title: "Backing object from time series" }],
    ["regression", "Time series regression coefficients"],
    ["regression", "Scatter plot regression coefficients (of a time series scatter plot card)", { title: "Scatter plot regression coefficients", source: { card: "" } }],
    ["series_distribution", "Time series distribution"],
    ["series_scatter", "Time series scatter plot (two series, with a regression line)"],
    ["series_scatter", "Time series heat grid", { view: "heat_grid", title: "Time series heat grid", fit: "" }],
  ] },
];
/** Cards whose result is one value (or an array) other cards can reference as $ID. */
export const VALUE_CARD_KINDS = ["value", "numeric_agg", "column_values", "numeric_formula", "round", "date_diff", "date_part",
  "string_op", "comparison", "boolean_formula", "create_array", "stepped_array", "array_op", "coalesce", "range_op",
  "string_selector", "property_select", "object_selector", "row_selector", "date_convert", "object_property", "multipass_attribute",
  "series_agg", "series_op", "regression", "shift_datetime", "object_view"] as const;
/** Cards whose result may be an array (inputs of array cards and of a number array aggregation). */
export const ARRAY_CARD_KINDS = ["column_values", "create_array", "stepped_array", "array_op", "string_op", "coalesce",
  "string_selector", "property_select", "multipass_attribute", "regression"] as const;
/** Cards whose result may be a range (inputs of Range start / Range end); an X/Y range's are $ID.x and $ID.y. */
export const RANGE_CARD_KINDS = ["range", "range_op", "period_to_date"] as const;
/** Cards other cards read as an object set or a table (an object selector is its selected objects; the object set
 * cards their objects). */
export const INPUT_CARD_KINDS = ["object_set", "table", "cross_filter", "object_selector", ...OBJECT_SET_CARD_KINDS] as const;
export const isSingleCard = (c: QuiverTableCard): c is SingleCard => SINGLE_CARD_KINDS.includes(c.kind as never);
export type QuiverTableCard = TableCard | ChartCard | ValueCard | VegaCard | CrossFilterCard | ActionCard | GroupedPlotCard | SingleCard;
/** Display names of the table-side card kinds. */
export const CARD_KIND_LABEL: Record<QuiverTableCard["kind"], string> = {
  table: "Transform table",
  chart: "Chart",
  value: "Value",
  vega: "Vega plot",
  cross_filter: "Cross filter",
  action: "Action button",
  grouped_plot: "Grouped time series plot",
  numeric_agg: "Numeric aggregation",
  column_values: "Column values",
  numeric_formula: "Numeric formula",
  round: "Floor / ceiling",
  date_diff: "Date difference",
  date_part: "Date part",
  correlation: "Correlation matrix",
  waterfall: "Waterfall plot",
  string_op: "String",
  comparison: "Comparison",
  boolean_formula: "Boolean formula",
  create_array: "Create array",
  stepped_array: "Stepped array",
  array_op: "Array",
  coalesce: "Coalesce",
  range: "Range",
  range_op: "Range start / end",
  string_selector: "String selector",
  property_select: "Property value select",
  object_selector: "Object selector",
  row_selector: "Row selector",
  date_convert: "To date",
  period_to_date: "Period to date",
  object_property: "Object property",
  multipass_attribute: "Multipass attribute",
  xy_range: "X/Y range",
  series_agg: "Time series aggregation",
  series_op: "Time series value",
  regression: "Regression coefficients",
  shift_datetime: "Shift date/time",
  series_distribution: "Time series distribution",
  series_scatter: "Time series scatter plot",
  filter_object_set: "Filter object set",
  set_math: "Set math",
  linked_object_set: "Linked object set",
  status_filter: "Status filter",
  object_view: "Object view",
  defined_by_property: "Defined by property",
  saved_object_set: "Saved object set",
};
/** The ID prefix of a new card of each kind. */
export const CARD_ID_PREFIX: Record<QuiverTableCard["kind"], string> = {
  table: "T", chart: "C", value: "V", vega: "G", cross_filter: "X", action: "A", grouped_plot: "P",
  numeric_agg: "N", column_values: "L", numeric_formula: "F", round: "R", date_diff: "DD", date_part: "DP", correlation: "M", waterfall: "W",
  string_op: "S", comparison: "B", boolean_formula: "BF", create_array: "AR", stepped_array: "SA", array_op: "AO", coalesce: "CO", range: "RG", range_op: "RO",
  string_selector: "SS", property_select: "PS", object_selector: "OS", row_selector: "RS",
  date_convert: "TD", period_to_date: "PD", object_property: "OP", multipass_attribute: "MP", xy_range: "XY",
  series_agg: "TA", series_op: "TV", regression: "RC", shift_datetime: "SH", series_distribution: "DS", series_scatter: "SC",
  filter_object_set: "FO", set_math: "SM", linked_object_set: "LK", status_filter: "ST", object_view: "OV", defined_by_property: "DB", saved_object_set: "IS",
};
export type TableResult = {
  error?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  total?: number;
  step_columns?: string[][];
  /** the result's time series columns (a sparkline cell is JSON text [[epoch ms, value], …]) */
  series_columns?: Record<string, SeriesColumnInfo>;
  /** series read for them: one per row × (series, range); rows whose series could not be read have empty cells */
  series?: { reads: number; failed: number; points_scanned: number; errors: string[] };
  data?: Record<string, unknown>[];
  data_columns?: string[];
  board?: Board;
  input_columns?: string[];
  value?: unknown;
  ok?: boolean;
  /** a chart subscribed to a cross filter: the cross filter's ID and this chart's selection */
  cross_filter?: string;
  selection?: unknown[];
  selections?: Record<string, unknown[]>;
  /** an Action button's parameter defaults, references resolved */
  defaults?: Record<string, unknown>;
  /** a grouped time series plot: the page's series ([epoch ms, value] points), paging, the plotted column and label */
  lines?: { label: string; points: [number, number][] }[];
  page?: number;
  pages?: number;
  page_size?: number;
  column?: string;
  label_column?: string | null;
  unit?: string | null;
  sparkline_columns?: string[];
  /** a grouped time series plot's linear aggregation across every row's series */
  aggregate?: { how: GroupedAggregate; series: number; points: [number, number][] };
  /** a single card's value type (array: a column values card's array of element_type values) */
  type?: "number" | "date" | "string" | "boolean" | "array" | "range" | "row" | "xy_range";
  element_type?: "number" | "date" | "string" | "boolean";
  /** an X/Y range: the type of each axis' range */
  element_types?: { x?: string; y?: string };
  /** selectors: what can be selected (an object / row selector: {value, label}) and how many there are in all */
  options?: (string | number | boolean | { value: string | number; label: string })[];
  options_total?: number;
  /** an object selector: the selected objects and the column their labels come from */
  objects?: { primary_key: string; label: string }[];
  /** a row selector: its key column and the selected row's index; an object property: the object's primary key */
  key?: string | null;
  row_index?: number;
  object?: string | null;
  /** a period to date card's period */
  period?: string;
  /** column values: how many values there are (the array holds at most 10,000) */
  count?: number;
  truncated?: boolean;
  /** single cards over an object set or a table: the input's columns by kind */
  column_types?: Record<string, "number" | "date" | "string" | "boolean">;
  /** a correlation matrix's columns and method */
  method?: "pearson" | "spearman";
  /** a date part card: the date it read */
  date?: string;
  /** time series single cards: the series' label and points in the range read ([start, end], null: open), the unit of
   * the value, the time read (and whether a point is on it) with the interpolation used */
  label?: string;
  points?: number;
  range?: [string | null, string | null];
  value_unit?: string | null;
  at?: string | null;
  exact?: boolean;
  interpolation?: string;
  external?: string;
  /** a time-weighted aggregation: the time its area covers (ms) */
  covered_ms?: number;
  /** a backing object: its object type */
  object_type_id?: string;
  object_type?: string;
  /** regression coefficients: the fit ("linear" …; a scatter plot's regression line: the fit itself), its degree,
   * R², the points fitted, the equation, and for a time regression x's unit and origin (the first point) */
  fit?: string | ScatterFit;
  degree?: number;
  r_squared?: number | null;
  n?: number;
  equation?: string;
  x_unit?: string | null;
  y_unit?: string | null;
  origin?: string;
  input?: string;
  /** a time series distribution: enum series count per value; a scatter plot / heat grid: its view, axes and extent */
  categorical?: boolean;
  bins?: number;
  view?: "scatter" | "heat_grid";
  grid?: number;
  x_label?: string;
  y_label?: string;
  joined?: number;
  extent?: { x: [number, number]; y: [number, number] } | null;
  /** object set cards: the type's properties and title property, an object view's object; for the editor the input's
   * type, the links out of it (with the linked type's properties) and set math's inputs' types */
  properties?: ObjectProperty[];
  title_property?: string | null;
  object_row?: Record<string, unknown> | null;
  input_type?: { object_type_id?: string; object_type?: string; properties?: ObjectProperty[] };
  links?: { link: string; label: string; object_type_id: string; object_type: string; properties: ObjectProperty[] }[];
  input_types?: Record<string, string | null>;
  /** defined by property: the columns of the card the values come from */
  from_column_types?: Record<string, "number" | "date" | "string" | "boolean">;
  /** defined by property: the array properties of the objects (matched on any element) and of the values card's objects (each element a value) */
  array_properties?: string[];
  from_array_properties?: string[];
  /** an imported saved object set: its metadata (`stored`: objects saved in it, some may be gone or hidden) */
  saved?: { kind: "exploration" | "list"; id: string; rid: string; name: string; description: string; owner?: string; created_at?: string; updated_at?: string; object_type_id: string; stored: number };
};
export type ObjectProperty = { api_name: string; display_name: string; type?: string };
/** A scatter plot's regression line: the fit, or why it could not be made. */
export type ScatterFit = { error?: string; fit?: string; degree?: number; coefficients?: number[]; r_squared?: number | null; n?: number; equation?: string; line?: [number, number][] };

export const TABLE_CARD_KINDS = ["table", "chart", "value", "vega", "cross_filter", "action", "grouped_plot", ...SINGLE_CARD_KINDS] as const;
export const isTableCard = (c: unknown): c is QuiverTableCard => TABLE_CARD_KINDS.includes((c as { kind?: string })?.kind as never);

/** The table-side cards another document can embed (a Report's Quiver card, a Notepad Quiver chart): every table-side
 * card but the Action button, as [ID, "$ID title · kind"]. */
export function embeddableCards(objectSets: { id: string; kind?: string; title?: string }[] | undefined): [string, string][] {
  return (objectSets ?? [])
    .filter((x) => x.kind !== "action" && isTableCard(x))
    .map((x) => {
      const label = CARD_KIND_LABEL[x.kind as QuiverTableCard["kind"]];
      return [String(x.id), `$${x.id} ${x.title || label}${x.title && x.title !== label ? ` · ${label}` : ""}`];
    });
}

/** The next free short ID with a prefix (T1, C2, V3, G1). */
export function nextId(prefix: string, taken: string[]): string {
  let n = 1;
  while (taken.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

async function req<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_URL + "/api/quiver-tables" + path, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const quiverTables = {
  run: (aid: string, body: { object_sets?: unknown[]; logic?: unknown; cards?: string[]; range?: unknown; root?: unknown } = {}) => req<{ cards: Record<string, TableResult> }>(`/${aid}/run`, body),
  csvUrl: (aid: string, cid: string) => `${API_URL}/api/quiver-tables/${aid}/cards/${cid}/csv`,
  /** The saved object sets the viewer can import (explorations, object lists). */
  savedObjectSets: async (): Promise<SavedObjectSet[]> => {
    const res = await fetch(API_URL + "/api/quiver-tables/saved-object-sets", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    return res.json() as Promise<SavedObjectSet[]>;
  },
  /** Save an object set card's objects (the editor's draft cards) as an object list other analyses import. */
  saveObjectList: (aid: string, cid: string, body: { name: string; description?: string; object_sets?: unknown[]; logic?: unknown; range?: unknown }) =>
    req<{ id: string; rid: string; name: string; count: number; object_type_id: string }>(`/${aid}/cards/${cid}/object-list`, body),
  /** A published dashboard's table cards with a viewer's selections in its selector cards (the saved defaults stay). */
  runDashboard: (itemId: string, body: { version?: number; object_type_id?: string; primary_key?: string; selections: Record<string, Selection> }) =>
    req<{ version: number; selections: Record<string, Selection>; tables: Record<string, TableResult> }>(`/dashboards/${itemId}/run`, body),
};

const slug = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

/** A transform with the server's defaults filled in (empty values take the default; avg / average is mean). */
export function fillTransform(t: SeriesTransform): SeriesTransform {
  const given = Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<SeriesTransform>;
  const out = { ...SERIES_TRANSFORM_DEFAULTS[t.type], ...given, type: t.type } as SeriesTransform;
  if (out.aggregation) {
    const a = String(out.aggregation).toLowerCase();
    out.aggregation = (a === "avg" || a === "average" ? "mean" : a) as SeriesTransform["aggregation"];
  }
  return out;
}

/** The name the server gives a time series column without one: <property>_<op>, or <property>_<transforms>_<op>
 * (e.g. klaim_harian_rolling_mean_7d_last). */
export function seriesColumnName(c: SeriesColumn): string {
  if (c.name?.trim()) return c.name.trim();
  const parts = [slug(c.property || "series")];
  for (const t of c.transforms ?? []) {
    const f = fillTransform(t);
    parts.push(slug([f.type, ...(TRANSFORM_NAME_KEYS[f.type] ?? []).map((k) => String(f[k]))].join("_")));
  }
  return [...parts, c.op].join("_");
}

/** A transform in a few words, e.g. "rolling mean 7d". */
export function describeTransform(t: SeriesTransform): string {
  const f = fillTransform(t);
  switch (f.type) {
    case "rolling": return `rolling ${f.aggregation} ${f.window}`;
    case "periodic": return `${f.aggregation} per ${f.period}`;
    case "cumulative": return `cumulative ${f.aggregation}`;
    case "derivative": return `derivative per ${f.unit}`;
    case "integral": return `integral (${f.unit})`;
    case "shift": return `shifted ${f.by}`;
    case "sample": return `sampled every ${f.every}`;
    case "filter": return `filtered${f.min !== undefined ? ` ≥ ${f.min}` : ""}${f.max !== undefined ? ` ≤ ${f.max}` : ""}`;
    case "dsp": return `${String(f.filter).replace("_", " ")}${f.filter !== "ema" || f.alpha === undefined ? ` ${f.window}` : ` α ${f.alpha}`}`;
  }
}

/** A sparkline cell's points ([epoch ms, value]; numeric values only), or null when the cell is not one. */
export function sparklinePoints(cell: unknown): [number, number][] | null {
  if (typeof cell !== "string" || !cell.startsWith("[")) return null;
  try {
    const pts = JSON.parse(cell) as unknown;
    if (!Array.isArray(pts)) return null;
    return pts.filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number");
  } catch {
    return null;
  }
}

/** A Vega / Vega-Lite spec with $T (the table's rows) and $T.column (the column name as a string) resolved. */
export function resolveVega(spec: string, results: Record<string, TableResult>): unknown {
  const text = spec.replace(/\$([A-Za-z][\w-]*)(?:\.([A-Za-z_][\w]*))?/g, (m, id: string, col?: string) => {
    const r = results[id];
    if (!r) return m;
    return col ? JSON.stringify(col) : JSON.stringify(r.rows ?? []);
  });
  return JSON.parse(text);
}
