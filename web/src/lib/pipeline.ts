/**
 * Pipeline Builder: datasets → transform / join / union nodes → outputs.
 * Everything runs in the browser; pipelines (with their datasets) are kept in localStorage.
 */

import type { Flow } from "./flow";
import { gunzipSync } from "fflate";
import { computeLlm } from "./llm";
import { computeModel } from "./models";
import {
  CHARSETS,
  convBase,
  crc32,
  decodeBytes,
  doubleBits,
  encodeText,
  factorial,
  floatBits,
  formatNumber,
  fromHex,
  kurtosis,
  md5,
  murmurBytes,
  murmurInt,
  murmurLong,
  pairStat,
  parseDuration,
  pmod,
  roundHalfEven,
  sha1,
  sha224,
  sha256,
  sha384,
  sha512,
  shift,
  skewness,
  soundex,
  substringIndex,
  toHex,
  translate,
} from "./spark";

export { md5, sha256 };

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
/** Column types, as in Spark SQL (see SQL_TYPE_NAMES). */
export const COL_TYPES = [
  "String",
  "Boolean",
  "Byte",
  "Short",
  "Integer",
  "Long",
  "Float",
  "Double",
  "Decimal",
  "Date",
  "Timestamp",
  "Binary",
] as const;
export type ColType = (typeof COL_TYPES)[number];

/** Spark SQL name of each type, as written in CAST(x AS …). */
export const SQL_TYPE_NAMES: Record<ColType, string> = {
  String: "string",
  Boolean: "boolean",
  Byte: "tinyint",
  Short: "smallint",
  Integer: "int",
  Long: "bigint",
  Float: "float",
  Double: "double",
  Decimal: "decimal",
  Date: "date",
  Timestamp: "timestamp",
  Binary: "binary",
};
// no prototype: names from data ("constructor", "toString"…) must not match inherited properties
Object.setPrototypeOf(SQL_TYPE_NAMES, null);
export const typeLabel = (t: string) => (t in SQL_TYPE_NAMES ? `${t} (${SQL_TYPE_NAMES[t as ColType]})` : t);

const INTEGRAL: Partial<Record<ColType, [number, number, number]>> = {
  // min, max, width in bytes
  Byte: [-128, 127, 1],
  Short: [-32768, 32767, 2],
  Integer: [-2147483648, 2147483647, 4],
  // JavaScript numbers hold integers exactly up to 2^53
  Long: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 8],
};
export const isNumericType = (t: ColType | undefined) =>
  t === "Byte" || t === "Short" || t === "Integer" || t === "Long" || t === "Float" || t === "Double" || t === "Decimal";
export type Column = { name: string; type: ColType };
/** A raw file in an unstructured dataset (no schema until an extract step parses it). */
/** `encoding: "base64"`: a binary file (Excel, zip, PDF …) whose bytes are in `text` as base64 */
export type DataFile = { path: string; size: number; text: string; encoding?: "base64" };
/** `files` is set only on an unstructured dataset; its rows are then the file listing. */
export type Table = { columns: Column[]; rows: Row[]; files?: DataFile[]; /** the real row count when rows holds only a preview/sample of it (DuckDB previews, dataset samples) */ totalRows?: number };

/** Where a dataset's rows live, so builds read the latest data (the copy kept in the pipeline is for previews). */
export type DatasetRef =
  | { kind: "drive"; itemId: string }
  | { kind: "datasource"; id: string }
  /** a virtual table: read from the database each time, never ingested */
  | { kind: "virtual"; connectionId: string; connectionName: string; database: string; schema: string; table: string }
  | { kind: "stream"; streamId: string }
  /** an ingest stream of the Streaming app (push-based ingestion or a streaming sync) */
  | { kind: "ingest"; streamId: string }
  /** a media set: the Files folder holding its items */
  | { kind: "media"; folderId: string | null };
export type Dataset = Table & {
  id: string;
  name: string;
  origin: string;
  createdAt: string;
  ref?: DatasetRef;
  /** a media set: one row per media item (mediaReference = Files item id) */
  media?: boolean;
  /** when the preview copy was last read from `ref` */
  refreshedAt?: string;
  /** rows of the input when the generated data was made (Generate notional data) */
  generator?: GeneratorConfig;
  /** pre-conditions checked on the input's rows when a build reads it (before any job runs) */
  preconditions?: Expectation[];
};

export const GENERATORS = [
  "City",
  "Company",
  "Constant",
  "Country code",
  "Email",
  "First name",
  "Foreign key",
  "Full name",
  "Last name",
  "List",
  "Null",
  "One of",
  "Street address",
  "Template",
  "US state",
  "US state code",
  "US ZIP code",
  "UUID",
  "Integer",
  "Decimal",
  "Date",
  "Boolean",
  "Generate with LLM",
] as const;
export type GeneratorKind = (typeof GENERATORS)[number];
export type ColumnGenerator = {
  column: string;
  kind: GeneratorKind;
  locked?: boolean;
  /** Constant / Template / LLM prompt */
  value?: string;
  /** List: values with weights; One of: generators with weights */
  options?: { value: string; weight: number }[];
  choices?: { kind: GeneratorKind; weight: number; value?: string }[];
  /** Foreign key: a column of another node */
  foreignNode?: string;
  foreignColumn?: string;
  /** US ZIP code: in this state */
  state?: string;
  min?: number;
  max?: number;
  example?: string;
};
export type GeneratorConfig = { rows: number; columns: ColumnGenerator[]; seed?: number };

export type Params = Record<string, string | string[]>;
export type Step = { id: string; kind: string; params: Params };

export const JOIN_HOWS = ["inner", "left", "right", "outer", "left semi", "left anti", "cross"] as const;
export type JoinHow = (typeof JOIN_HOWS)[number];

type NodeBase = {
  id: string;
  name: string;
  x: number;
  y: number;
  color?: string;
  /** folder of the pipeline file tree the node is in */
  folder?: string;
  /** computed once per build and shared by every output that uses it */
  checkpoint?: boolean;
  /** free-text note shown on the node */
  description?: string;
};
/** How previews read an input: a sample of its rows. Deploys always read every row. */
export type Sampling =
  | { kind: "none" }
  | { kind: "first"; rows: number }
  | { kind: "random"; percent: number; seed?: number }
  | { kind: "filter"; filter: string; rows?: number };
/** snapshot = every build reads all rows; incremental = a build only reads rows added since the last one */
export type InputMode = "snapshot" | "incremental";
export type SourceNode = NodeBase & { kind: "source"; datasetId: string; sampling?: Sampling; mode?: InputMode };
export type TransformNode = NodeBase & { kind: "transform"; input: string; steps: Step[] };
/** Rows matching the condition go to the True output (the node's id), the rest to the False output (id + FALSE_PORT). */
export type SplitNode = NodeBase & { kind: "split"; input: string; condition: string };
/** An instance of a reusable subgraph; `inputs` are mapped in the order of the subgraph's inputs. */
export type SubgraphNode = NodeBase & { kind: "subgraph"; subgraph: string; inputs: string[] };
/** Inside a subgraph or a unit test: stands for one of its inputs. */
export type InputNode = NodeBase & { kind: "input"; inputId: string };
/** Use LLM: runs a prompt over every row and writes the answer to a column. */
export type LlmNode = NodeBase & { kind: "llm"; input: string; config: LlmConfig };
/** A model the pipeline can run: trained here (Train model), imported as coefficients, or a registered REST endpoint. */
export type TrainedModel = {
  id: string;
  name: string;
  /** Files item the model was read from, if any */
  itemId?: string;
  createdAt: string;
  features: { name: string; type: "numeric" | "categorical" }[];
  /** what it predicts and how well it did on its training data */
  target?: string;
  metrics?: Record<string, number>;
} & (
  | { algorithm: "linear"; intercept: number; coefficients: number[]; categories?: Record<string, string[]> }
  | { algorithm: "logistic"; intercept: number; coefficients: number[]; classes: [string, string]; categories?: Record<string, string[]> }
  | { algorithm: "kmeans"; centroids: number[][]; scale?: { mean: number[]; std: number[] } }
  | { algorithm: "rest"; url: string; headers?: Record<string, string> }
);
/** Runs a trained model's inference over the rows (single tabular input and output). */
export type ModelNode = NodeBase & {
  kind: "model";
  input: string;
  model: TrainedModel;
  /** the input column for each model feature, in order */
  features: string[];
  /** the prediction column (logistic models also write <output>_probability) */
  output: string;
};
/** A Markdown note on the graph, drawn behind the nodes. */
export type TextNode = { id: string; x: number; y: number; w: number; h: number; text: string; color?: string; folder?: string };
export type PipelineFolder = { id: string; name: string; parent: string | null; hidden?: boolean };
export type Parameter = { id: string; name: string; type: ColType; value: string; description?: string };

export const LLM_TEMPLATES = ["classification", "summarization", "translation", "sentiment", "entities", "empty"] as const;
export type LlmTemplate = (typeof LLM_TEMPLATES)[number];
export const LLM_OUTPUT_TYPES = ["String", "Integer", "Double", "Boolean", "Array<String>", "Struct", "JSON string"] as const;
export type LlmOutputType = (typeof LLM_OUTPUT_TYPES)[number];
export type LlmEntity = { id: string; name: string; type: "String" | "Integer" | "Double" | "Boolean" | "Array<String>" | "Array<Integer>" };
export type LlmConfig = {
  model: string;
  template: LlmTemplate;
  /** the template is turned into a free prompt (Create prompt); it cannot go back */
  created?: boolean;
  /** classification */
  multiplicity?: "exactly one" | "one or more" | "exact number";
  count?: number;
  context?: string;
  categories?: string[];
  /** the column a template reads */
  column?: string;
  /** summarization */
  size?: number;
  unit?: "words" | "sentences" | "paragraphs";
  /** translation */
  language?: string;
  /** sentiment: scores from min to max */
  scaleMin?: number;
  scaleMax?: number;
  /** entity extraction */
  entities?: LlmEntity[];
  /** empty prompt / created prompt: system instructions and the user prompt; {column} inserts a column */
  system?: string;
  prompt?: string;
  /** a media reference / image column for vision models */
  imageColumn?: string;
  outputType: LlmOutputType;
  outputColumn: string;
  includeErrors?: boolean;
  /** reuse answers of earlier builds for rows whose prompt is unchanged */
  skipRecompute?: boolean;
  /** bumped by Clear cache: earlier answers are not reused */
  cacheEpoch?: number;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  trials?: { id: string; values: Record<string, string> }[];
};
/** "<=>" / "!<=>": null-safe (null matches null); "=" / "!=": not null safe (Spark's =, the default of keys saved without an op) */
export const JOIN_OPS = ["<=>", "!<=>", "=", "!=", "<", "<=", ">", ">="] as const;
export type JoinOp = (typeof JOIN_OPS)[number];
/** left <op> right; "=" when op is missing */
export type JoinKey = { left: string; right: string; op?: JoinOp };
export type JoinNode = NodeBase & {
  kind: "join";
  left: string;
  right: string;
  /** first key pair; kept for pipelines saved before multi-key joins */
  leftKey: string;
  rightKey: string;
  keys?: JoinKey[];
  how: JoinHow;
  /** columns kept from the left input, in order; null or missing = all (auto-select) */
  leftColumns?: string[] | null;
  /** columns kept from the right input; null = all. Missing (joins saved before column selection) = all, with same-named keys merged */
  rightColumns?: string[] | null;
  /** put in front of every right column name, e.g. "product_" */
  rightPrefix?: string;
};
export const SET_MODES = ["union all", "union distinct", "intersect", "intersect all", "except", "except all"] as const;
export type SetMode = (typeof SET_MODES)[number];
/** strict: every input must have the same columns (missing ones are an error); otherwise missing columns are null */
export type UnionNode = NodeBase & { kind: "union"; inputs: string[]; mode?: SetMode; strict?: boolean };

/** The join's key pairs (older pipelines store one pair as leftKey / rightKey). */
export const joinKeys = (n: Pick<JoinNode, "leftKey" | "rightKey" | "keys">): JoinKey[] =>
  (n.keys ?? [{ left: n.leftKey, right: n.rightKey }]).filter((k) => k.left || k.right);
export type PipelineNode = SourceNode | TransformNode | JoinNode | UnionNode | SplitNode | SubgraphNode | InputNode | LlmNode | ModelNode;

/** A split's False output is addressed as its id + FALSE_PORT; its id alone is the True output. */
export const FALSE_PORT = "#false";
/** The node an input reference points at (a split's False port belongs to the split). */
export const refNode = (ref: string) => (ref.endsWith(FALSE_PORT) ? ref.slice(0, -FALSE_PORT.length) : ref);
export const isFalsePort = (ref: string) => ref.endsWith(FALSE_PORT);

/**
 * A check on an output before it is written (or on an input before the build runs: a pre-condition).
 * A failing check aborts the build (nothing is written), or in warn mode only warns.
 */
export type Expectation = ExpectationCheck & { mode?: ExpectationMode };
export type ExpectationMode = "abort" | "warn";
export type ExpectationCheck =
  /** max is optional; older pipelines only have min */
  | { id: string; kind: "rowCount"; min?: number; max?: number }
  /** primary key: no nulls in the columns and their combination is unique */
  | { id: string; kind: "unique"; columns: string[] }
  | { id: string; kind: "notNull"; columns: string[] }
  | { id: string; kind: "oneOf"; column: string; values: string[] }
  | { id: string; kind: "notNaN"; columns: string[] }
  /** a condition (ConditionGroup JSON) that must hold for every row */
  | { id: string; kind: "rowLevel"; condition: string };
export const EXPECTATION_KINDS: { kind: Expectation["kind"]; label: string; hint: string }[] = [
  { kind: "unique", label: "Primary key", hint: "The selected columns contain no nulls and their combination is unique." },
  { kind: "rowCount", label: "Row count", hint: "The output has a number of rows within a range." },
  { kind: "oneOf", label: "Value is one of", hint: "Every value of the column is one of the permitted values." },
  { kind: "notNull", label: "Value is not null", hint: "The columns have no missing values (an empty string is a value)." },
  { kind: "notNaN", label: "Floats and doubles are not NaN", hint: "The floating point columns hold no NaN values." },
  { kind: "rowLevel", label: "Row-level", hint: "A condition that must hold for every row, e.g. end_time > start_time." },
];

export const OUTPUT_KINDS = ["dataset", "icebergTable", "virtualTable", "mediaSet", "file", "objectType", "linkType", "timeSeries", "geotemporal"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];
export type ObjectProperty = { source: string; apiName: string; displayName: string; type?: string };
export type ObjectTypeConfig = {
  apiName: string;
  pluralName?: string;
  description?: string;
  primaryKey: string;
  titleProperty: string;
  /** source column → property; null = every column */
  properties: ObjectProperty[] | null;
  /** Ontology interfaces implemented (interfaceId: an Ontology interface; mapping: interface property → property API name) */
  interfaces?: { id: string; name: string; interfaceId?: string; mapping: Record<string, string> }[];
  /** on deploy, register (or re-index) the object type in the Ontology, with the interfaces it implements */
  register?: boolean;
};
export type LinkTypeConfig = {
  /** the two object type outputs */
  from: string;
  to: string;
  /** many-to-one: a foreign key on `from` pointing at `to`'s primary key; many-to-many: a join table (this output's input) */
  cardinality: "one-to-one" | "many-to-one" | "many-to-many";
  fromKey: string;
  toKey: string;
  apiName: string;
  reverseApiName: string;
};
export type VirtualTableConfig = { connectionId: string; connectionName?: string; database: string; schema: string; table: string };
export type FileOutputConfig = { format: "csv" | "json" | "jsonl" | "parquet" | "txt"; fileName: string; textColumn?: string };
export type TimeSeriesConfig = { seriesId: string; timestamp: string; value: string };
export type GeotemporalConfig = { seriesId: string; timestamp: string; latitude: string; longitude: string; properties?: string[] };
export type MediaSetConfig = { mediaColumn: string; pathColumn?: string };
export type OutputColumn = { source: string; name: string };
/** A folder of the Files tab (Drive); id null = the top level. */
export type DriveLocation = { id: string | null; name: string };
/** The last deploy: the Parquet file it wrote in the Files tab. */
export type OutputDeploy = { at: string; version: number; rows: number; columns: number; itemId?: string; path?: string; parentId?: string | null };
export type Output = {
  id: string;
  name: string;
  node: string;
  /** a note on the output: what it is for and who reads it (shown in its About panel) */
  description?: string;
  /** a dataset when missing (pipelines saved before other output kinds) */
  kind?: OutputKind;
  objectType?: ObjectTypeConfig;
  linkType?: LinkTypeConfig;
  virtualTable?: VirtualTableConfig;
  file?: FileOutputConfig;
  timeSeries?: TimeSeriesConfig;
  geotemporal?: GeotemporalConfig;
  mediaSet?: MediaSetConfig;
  /** the job group it builds in; ungrouped outputs each get a job of their own */
  jobGroup?: string;
  /** schema written: source column → output name, in order; null or missing = the upstream schema as is */
  columns?: OutputColumn[] | null;
  expectations?: Expectation[];
  /** how a deploy writes the output (Palantir's output write modes); see `writeModeOf` */
  writeMode?: WriteMode;
  /** the primary key of the keyed write modes (Snapshot replace, Changelog, Append only new rows, …) */
  primaryKey?: string[];
  /** Snapshot replace and remove: the boolean column whose FALSE rows remove their key from the output */
  postFilterColumn?: string;
  /** Direct changelog: the columns that order the changes and flag deletions */
  changelog?: { timestamp: string; deleted: string };
  /** folder the dataset is created in; the pipeline's location when missing */
  location?: DriveLocation;
  /** position on the graph; next to its input when missing */
  x?: number;
  y?: number;
  deployed?: OutputDeploy;
};
/** `hidden`: the colour group's nodes are hidden on the graph; `collapsed`: drawn as one node */
export type LegendColor = { id: string; name: string; hex: string; hidden?: boolean; collapsed?: boolean };

/** Expression<Type> arguments of a custom function: a column (or value) of that type. */
export type FunctionArg = { id: string; name: string; type: ColType | "Any" };
/** A Spark SQL expression over its arguments (written {arg}), saved for reuse in any transform. */
export type CustomExpression = {
  id: string;
  kind: "expression";
  name: string;
  description?: string;
  args: FunctionArg[];
  /** e.g. "sha2(concat_ws('-', {first}, {last}), 256)" */
  definition: string;
};
/** A series of transform boards saved as one transform; column params that were arguments hold ARG_MARK + arg id. */
export type CustomTransform = {
  id: string;
  kind: "transform";
  name: string;
  description?: string;
  args: FunctionArg[];
  steps: Step[];
};
/** A field of a Java UDF's input or output schema (arrays, maps and structs are JSON text in tables). */
export type UdfField = { name: string; type: ColType; nullable: boolean; field_type?: string };
export type UdfExample = { id: string; description?: string; category?: string; visibility?: string; configuration: Record<string, unknown>; input: Row[]; expected: Row[] };
/** A published version of a Java user-defined function (Code Repositories): what its step needs to run it. */
export type UdfVersion = {
  /** the lockfile id: stable across versions, new when the UDF is renamed */
  id: string | null;
  name: string;
  description: string;
  /** keyed_process: records partitioned by keyColumns, with state and timers per key (streaming) */
  type: "map" | "flat_map" | "keyed_process";
  repoId: string;
  repoName: string;
  tag: string;
  input: { name: string; fields: UdfField[] };
  output: { name: string; fields: UdfField[] };
  arguments: { name: string; required: boolean; description: string; type: ColType; field_type?: string }[];
  examples: UdfExample[];
  /** keyed process UDFs: the key columns, the event time column and the state kept per key */
  keyColumns?: string[];
  eventTimeColumn?: string | null;
  state?: { name: string; fields: UdfField[] };
};
/** A Java UDF imported into the pipeline (Reusables → User-defined functions); a transform step like any other. */
export type CustomUdf = {
  id: string;
  kind: "udf";
  name: string;
  description?: string;
  /** UDFs take their columns by name (the input schema), not as arguments */
  args: FunctionArg[];
  udf: UdfVersion;
};
/** A published Python function (functions registry) imported as a UDF: it runs once per row on the server. */
export type PythonFunctionVersion = { functionId: string; name: string; version: string; repoName?: string; inputs: { name: string; type: string; required: boolean }[]; output: string };
export type CustomPyFunction = {
  id: string;
  kind: "pyfn";
  name: string;
  description?: string;
  /** its inputs are mapped to columns in the step, not declared as arguments */
  args: FunctionArg[];
  fn: PythonFunctionVersion;
};
export type CustomFunction = CustomExpression | CustomTransform | CustomUdf | CustomPyFunction;

export type SubgraphInput = { id: string; name: string; columns: Column[] };
/** A reusable block of nodes: InputNodes stand for its inputs, `output` is the node it returns. */
export type Subgraph = {
  id: string;
  name: string;
  description?: string;
  inputs: SubgraphInput[];
  nodes: PipelineNode[];
  output: string;
  /** declared output columns; checked when the subgraph is applied */
  outputColumns?: Column[];
  updatedAt?: string;
};

export type JobGroup = { id: string; name: string; profile?: string };
export const SCHEDULE_TARGETS = ["single", "withUpstream", "downstream", "between"] as const;
export type ScheduleTarget = (typeof SCHEDULE_TARGETS)[number];
/**
 * A schedule's trigger: AND / OR groups over events. An event latches its condition until the schedule
 * runs; a group fires when all (AND) or any (OR) of its items have.
 */
export type ScheduleTrigger =
  | { id: string; kind: "and" | "or"; items: ScheduleTrigger[] }
  /** at times: a cron expression (minute hour day month weekday) in a time zone */
  | { id: string; kind: "time"; cron: string; timezone?: string }
  /** an input was updated: any input, or the chosen ones (dataset ids) */
  | { id: string; kind: "data"; inputs?: string[] }
  /** the pipeline's logic changed and stayed unchanged for 2 minutes */
  | { id: string; kind: "logic" }
  /** a build of a pipeline succeeded (optionally one that built the output) */
  | { id: string; kind: "job"; pipelineId: string; pipelineName?: string; outputId?: string; outputName?: string }
  /** another schedule ran: its builds finished (succeeded, or with any result) */
  | { id: string; kind: "schedule"; pipelineId: string; scheduleId: string; scheduleName?: string; status?: "succeeded" | "any" };
export type ScheduleRunSetup = { id: string; name: string; parameters: Record<string, string> };
export type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  /** when it was last turned on or off (a stale editor copy does not undo a later toggle) */
  enabledAt?: string;
  trigger?: ScheduleTrigger;
  /** older schedules: flat conditions, read as one AND / OR group (see `scheduleTrigger`) */
  cron?: string;
  timezone?: string;
  onDataUpdate?: boolean;
  onLogicUpdate?: boolean;
  combine?: "any" | "all";
  /** which outputs it builds */
  target: ScheduleTarget;
  outputs: string[];
  /** outputs the target reaches that are never built by this schedule */
  excluded?: string[];
  /** for "between": the output built up to */
  until?: string;
  allowOverlap?: boolean;
  branch?: string;
  /** a failed build is retried this many times, after a delay */
  retries?: { count: number; delayMinutes: number };
  /** pause the schedule after this many failed runs in a row (0 / missing = never) */
  autoPauseAfter?: number;
  /** build outputs even when they are up to date (no input or logic change since their last build) */
  force?: boolean;
  /** parameter values (by name) over the pipeline's defaults */
  parameters?: Record<string, string>;
  /** parallel run setups: each run builds once per setup, with its parameter values */
  runSetups?: ScheduleRunSetup[];
  /** build scope: "project" builds only outputs written in `scopeProjects` (default: the pipeline's Project),
   *  whoever edited it last; "user" runs as `owner` and builds only what they may build */
  scope?: "project" | "user";
  scopeProjects?: string[];
  /** set by the API: the last user to create or change the schedule (what the client sends is ignored) */
  owner?: string;
  createdAt: string;
  lastRun?: { at: string; buildId?: string; status: string };
};

/** The schedule's trigger tree (older schedules' cron / data / logic conditions as one group). */
export function scheduleTrigger(s: Schedule): ScheduleTrigger {
  if (s.trigger) return s.trigger;
  const items: ScheduleTrigger[] = [];
  if (s.cron) items.push({ id: "cron", kind: "time", cron: s.cron, timezone: s.timezone || "UTC" });
  if (s.onDataUpdate) items.push({ id: "data", kind: "data" });
  if (s.onLogicUpdate) items.push({ id: "logic", kind: "logic" });
  return { id: "root", kind: s.combine === "all" ? "and" : "or", items };
}

export function describeTrigger(t: ScheduleTrigger, datasets?: Record<string, { name: string }>): string {
  switch (t.kind) {
    case "and":
    case "or": {
      const parts = t.items.map((i) => describeTrigger(i, datasets)).filter(Boolean);
      return parts.length > 1 ? `(${parts.join(` ${t.kind.toUpperCase()} `)})` : (parts[0] ?? "");
    }
    case "time":
      return `cron ${t.cron}${t.timezone ? ` (${t.timezone})` : ""}`;
    case "data":
      return t.inputs?.length ? `${t.inputs.map((i) => datasets?.[i]?.name ?? i).join(", ")} updated` : "data updated";
    case "logic":
      return "logic updated";
    case "job":
      return `job succeeded (${t.pipelineName ?? t.pipelineId}${t.outputName ? ` · ${t.outputName}` : ""})`;
    case "schedule":
      return `schedule ran (${t.scheduleName ?? t.scheduleId}${(t.status ?? "succeeded") === "succeeded" ? ", succeeded" : ""})`;
  }
}

/** Leaf conditions of a trigger tree. */
export const triggerLeaves = (t: ScheduleTrigger): ScheduleTrigger[] => (t.kind === "and" || t.kind === "or" ? t.items.flatMap(triggerLeaves) : [t]);

export type ComputeProfile =
  | "xs"
  | "s"
  | "m"
  | "l"
  | "xl"
  | "warm-xs"
  | "warm-s"
  | "native-s"
  | "native-m"
  | "native-l"
  | "native-xl"
  | "native-advanced"
  | "faster-s"
  | "faster-m"
  | "faster-l"
  | "faster-xl"
  | "faster-xxl";
export type BuildSettings = {
  /** jobs of incremental outputs fail when they cannot run incrementally (instead of running as a snapshot) */
  requireIncremental?: boolean;
  /** incremental builds that produce no rows still commit, so their input rows are not processed again */
  commitEmptyTransactions?: boolean;
  profile?: ComputeProfile;
  strategy?: "standard" | "warm" | "managed";
  /** off-heap share (0–90) of the advanced natively accelerated profile */
  offHeapPercent?: number;
  importedProfiles?: ComputeProfile[];
  /** streaming */
  streamingProfile?: "xxs" | "xs" | "s" | "m" | "l" | "xl";
  /** streaming profiles (Control Panel) the job uses; combined, with Advanced overrides */
  streamingProfiles?: string[];
  streamingAdvanced?: Partial<{ parallelism: number; batch_records: number; max_record_bytes: number; buffer_records: number; checkpoint_interval_s: number; poll_timeout_s: number }>;
  /** the resolved settings, saved with the profiles (the runner reads batch_records) */
  streamingSettings?: { parallelism: number; batch_records: number; max_record_bytes: number; buffer_records: number; checkpoint_interval_s: number; poll_timeout_s: number };
  maxDurationMinutes?: number | null;
  /** regular snapshotting of incremental pipelines: re-process the inputs in full and replace the outputs when one
   *  of the limits is reached, so APPEND transactions do not pile up */
  regularSnapshot?: { enabled: boolean; everyBuilds?: number; everyDays?: number; maxAppends?: number };
  /** stateful streaming outputs keep input records as state for this long (default one day) */
  stateTtlMinutes?: number;
  consistency?: "at-least-once" | "exactly-once";
  /** external pipelines */
  externalProfile?: "serverless" | "classic" | "warehouse";
  clusterId?: string;
  warehouse?: string;
};

export type UnitTestTable = { columns: Column[]; rows: Row[] };
export type UnitTest = {
  id: string;
  name: string;
  /** the transform nodes under test */
  nodes: string[];
  /** test data for each input feeding the tested nodes, by the input's ref */
  inputs: Record<string, UnitTestTable>;
  /** expected output of each tested node with no tested node downstream, by node id */
  expected: Record<string, UnitTestTable>;
  lastRun?: { at: string; ok: boolean; results: { node: string; ok: boolean; message: string }[] };
};

export const EVALUATORS = [
  "exactString",
  "integerRange",
  "exactNumeric",
  "exactStringArray",
  "exactNumericArray",
  "exactTemporal",
  "genericExact",
  "floatRange",
  "temporalRange",
  "levenshtein",
  "stringLength",
  "keywords",
  "regex",
  "llmJudge",
] as const;
export type EvaluatorKind = (typeof EVALUATORS)[number];
export type Evaluator = {
  id: string;
  kind: EvaluatorKind;
  /** column holding the expected value (or the range bounds as min/max columns or constants) */
  expected?: string;
  min?: string;
  max?: string;
  matchCase?: boolean;
  trimWhitespace?: boolean;
  orderMatters?: boolean;
  /** pass when the distance is at most this */
  threshold?: number;
  keywords?: string[];
  pattern?: string;
  condition?: string;
  model?: string;
  passing?: "match" | "no match";
};
export type EvalSuite = {
  id: string;
  name: string;
  /** the Use LLM node evaluated */
  node: string;
  testData: UnitTestTable;
  evaluators: Evaluator[];
  outputDataset?: string;
  lastRun?: { at: string; rows: Row[]; passed: number; total: number };
};

export type PipelineComment = { id: string; author: string; text: string; at: string; node?: string; resolved?: boolean; editedAt?: string; parent?: string };
export type PipelineMeta = {
  description?: string;
  views?: { at: string }[];
  followers?: string[];
  collaborators?: { name: string; addedAt: string; role: string }[];
  markings?: string[];
  organizations?: string[];
  roles?: { principal: string; role: "Owner" | "Editor" | "Viewer" | "Discoverer" }[];
  linkSharing?: { enabled: boolean; role: "Viewer" | "Editor" };
};

export type UserPreferences = {
  /** how a collapsed transform node lists its boards */
  collapsedStyle?: "summary" | "pseudocode";
  /** name new transform nodes after their boards */
  autoName?: boolean;
  /** run previews when a node is selected, or wait for a click */
  previewMode?: "auto" | "confirm";
  snapToGrid?: boolean;
  /** shown as the author of saves, proposals, comments and approvals */
  userName?: string;
};

/**
 * One column of a pipeline's data dictionary (Palantir's column descriptions): `label` what the column holds, `note`
 * where it comes from or how it is computed, `group` the table or stage it belongs to, `source` who says so (the data
 * provider's own label, the pipeline step that computes it), `anonymized` how the source de-identified it (absent:
 * not an identifier) and `anonymizedSource` what that statement rests on.
 */
export type DictionaryEntry = { label: string; note?: string; group?: string; source?: string; anonymized?: string; anonymizedSource?: string };
/** One source file read into an input dataset: its size, sha256 and rows when it was read, and (sha256_ok) whether the
 *  file in Files still has that sha256. */
export type UpstreamFile = { name: string; edisi: string; tabel: string; dataset: string; bytes: number; sha256: string; rows: number; item_id: string | null; sha256_ok?: boolean | null };
/** An input dataset the pipeline reads: the build and commit that wrote it, and whether its rows equal its files' rows. */
export type UpstreamOutput = { name: string; rows: number | null; files: number; rows_from_files: number; bytes_from_files: number; editions: string[]; matches: boolean;
  commit: string | null; built_at: string | null; build: string | null };
export type Upstream = {
  title: string;
  summary: string;
  document?: string;
  source: { label: string; folder: { id: string; name: string } | null; files: UpstreamFile[]; verified?: { at: string; matched: number; files: number } | null };
  transform: { label: string; repo: { id: string; name: string } | null; path: string; link: string | null; steps: { title: string; detail: string }[];
    versions: { commit: string; message: string; datasets: string[]; path: string; code: string }[] };
  outputs: UpstreamOutput[];
};

/** streaming = business / document event streams (ERP, CRM …); device = IoT device flows (MQTT, OPC-UA …) */
export type PipelineType = "batch" | "streaming" | "device";
/**
 * The engine a batch pipeline builds on: standard (Spark-like, everything), faster (DataFusion-like, a subset), external
 * (pushed down to a database), duckdb (the DuckDB local engine: compiled to SQL and run by the API over the Files
 * datasets on disk, for millions of rows; the editor previews a sample of each input).
 */
export type BatchCompute = "standard" | "faster" | "external" | "duckdb";
export type Pipeline = {
  id: string;
  name: string;
  type: PipelineType;
  createdAt: string;
  updatedAt: string;
  nodes: PipelineNode[];
  datasets: Record<string, Dataset>;
  outputs: Output[];
  legend: LegendColor[];
  /** folder of the Files tab where deployed outputs are created by default */
  location?: DriveLocation;
  /** a device pipeline's Node-RED style flow */
  flow?: Flow;
  /** a device pipeline running in real Node-RED (its Node-RED hangs off the pipeline file); without it, the built-in editor */
  engine?: "nodered";
  /** `flow` has been put into the pipeline's Node-RED (it is then edited there) */
  noderedImported?: boolean;
  /** it was made in the built-in editor and moved to Node-RED */
  movedToNodeRed?: boolean;
  compute?: BatchCompute;
  /** pipelines created since incremental became the default (2026-10-26): source nodes added to them start
   *  incremental where the compute supports it (newSourceMode). Files saved before carry no flag and keep
   *  the snapshot default, so an existing pipeline never changes behaviour by being opened. */
  incrementalDefault?: boolean;
  /** external pipelines: the source every input and output table belongs to */
  external?: { connectionId: string; connectionName: string; kind: string };
  textNodes?: TextNode[];
  /** the data dictionary: what each column means, by column name (source codes and the names they become) */
  dictionary?: Record<string, DictionaryEntry>;
  /** how the pipeline's inputs were made from the source files, before this pipeline (the Builder's "Dari Arsip Sumber") */
  upstream?: Upstream;
  folders?: PipelineFolder[];
  /** ids of nodes (and OUT + output ids) hidden on the graph */
  hidden?: string[];
  parameters?: Parameter[];
  functions?: CustomFunction[];
  subgraphs?: Subgraph[];
  jobGroups?: JobGroup[];
  schedules?: Schedule[];
  buildSettings?: BuildSettings;
  unitTests?: UnitTest[];
  evalSuites?: EvalSuite[];
  comments?: PipelineComment[];
  meta?: PipelineMeta;
  /** generated and owned by HyperAuto: edits go through its configuration (proposals) */
  managedBy?: { kind: "hyperauto"; id: string; name: string };
  /** list what a conversion to faster would not support in the warnings panel */
  showConversionChecks?: boolean;
  /** streaming: input streams by node */
  streams?: Record<string, { streamId: string }>;
};
export type PipelineSummary = {
  id: string;
  name: string;
  type: PipelineType;
  updatedAt: string;
  nodes: number;
  outputs: number;
};

export const uid = () => crypto.randomUUID().slice(0, 8);

/** The input references of a node (a split's False output is its id + FALSE_PORT). */
export function inputsOf(node: PipelineNode): string[] {
  switch (node.kind) {
    case "source":
    case "input":
      return [];
    case "transform":
    case "split":
    case "llm":
    case "model":
      return [node.input];
    case "join":
      return [node.left, node.right];
    case "union":
    case "subgraph":
      return node.inputs;
  }
}

/** A node a transform's step reads by table name: through a Mapping join (a lookup input) or a SQL query step. */
export type NodeReference = { id: string; via: "mapping_join" | "sql" };

/**
 * The other nodes each transform reads by table name — Mapping join steps, and SQL query steps (every node whose
 * table name is a word of the query, as the engines resolve them): node id → references. The canvas draws them as
 * dotted edges, and the layout keeps them left of their reader.
 */
export function referencedNodes(nodes: PipelineNode[]): Map<string, NodeReference[]> {
  const names = tableNames(nodes);
  const byName = new Map([...names].map(([id, name]) => [name, id]));
  const out = new Map<string, NodeReference[]>();
  for (const n of nodes) {
    if (n.kind !== "transform") continue;
    const refs = new Map<string, NodeReference["via"]>();
    for (const s of n.steps) {
      const p = s.params ?? {};
      if (s.kind === "mapping_join" && typeof p.mapping === "string") {
        const id = byName.get(tableName(p.mapping.trim()));
        if (id) refs.set(id, "mapping_join");
      } else if (s.kind === "sql" && typeof p.query === "string") {
        const words = new Set(p.query.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
        for (const [id, name] of names) if (words.has(name) && !refs.has(id)) refs.set(id, "sql");
      }
    }
    refs.delete(n.id);
    refs.delete(refNode(n.input));
    if (refs.size) out.set(n.id, [...refs].map(([id, via]) => ({ id, via })));
  }
  return out;
}

/** The same node with its input references passed through `fn`. */
export function remapInputs<N extends PipelineNode>(node: N, fn: (ref: string) => string): N {
  switch (node.kind) {
    case "transform":
    case "split":
    case "llm":
    case "model":
      return { ...node, input: fn(node.input) };
    case "join":
      return { ...node, left: fn(node.left), right: fn(node.right) };
    case "union":
    case "subgraph":
      return { ...node, inputs: node.inputs.map(fn) };
    default:
      return node;
  }
}

/**
 * Output write modes (Pipeline Builder): Default appends when every incremental input only had rows added,
 * else snapshots. "snapshot" and "append" are pipelines saved before the modes (Default, Always append rows).
 */
export type WriteMode =
  | "default"
  | "snapshotReplace"
  | "snapshotReplaceRemove"
  | "changelog"
  | "appendNewRows"
  | "directChangelog"
  | "snapshotNewRows"
  | "alwaysAppend"
  | "snapshot"
  | "append";
export type ResolvedWriteMode = Exclude<WriteMode, "snapshot" | "append">;
export const writeModeOf = (o: Pick<Output, "writeMode">): ResolvedWriteMode =>
  o.writeMode === "append" ? "alwaysAppend" : !o.writeMode || o.writeMode === "snapshot" ? "default" : o.writeMode;
export const WRITE_MODES: { id: ResolvedWriteMode; label: string; hint: string; keyed?: boolean }[] = [
  { id: "default", label: "Default", hint: "APPEND when at least one input is incremental and every incremental input only had rows added since the last build; SNAPSHOT otherwise." },
  { id: "snapshotReplace", label: "Snapshot replace", keyed: true, hint: "SNAPSHOT of the previous output merged with the new rows: rows whose primary key is in the new data are replaced; one row is kept per key." },
  { id: "snapshotReplaceRemove", label: "Snapshot replace and remove", keyed: true, hint: "Snapshot replace, then a post-filter: a new row whose post-filtering column is FALSE removes its key from the output; TRUE rows are stored." },
  { id: "changelog", label: "Changelog", keyed: true, hint: "APPEND transactions holding the complete history: each new or changed row is added with the build time and is_deleted = false." },
  { id: "appendNewRows", label: "Append only new rows", keyed: true, hint: "APPEND of the rows whose primary key the output has not seen yet (one per key); rows with a known key are dropped." },
  { id: "directChangelog", label: "Direct changelog", keyed: true, hint: "The rows are the changelog: each names a primary key, a timestamp and a deletion flag, and is appended as is." },
  { id: "snapshotNewRows", label: "Snapshot only new rows", keyed: true, hint: "SNAPSHOT of only the rows whose primary key is not in the previous output (duplicates within the new data are kept)." },
  { id: "alwaysAppend", label: "Always append rows", hint: "Every build adds its rows to the output as an APPEND transaction." },
];
/** what a write mode needs that the output's columns don't provide (null columns: only what needs no columns) */
export function writeModeProblems(o: Output, columns: Column[] | null): string[] {
  const mode = writeModeOf(o);
  const spec = WRITE_MODES.find((m) => m.id === mode);
  if (!spec?.keyed) return [];
  const kind = o.kind ?? "dataset";
  if (kind !== "dataset" && kind !== "icebergTable") return [`${o.name}: ${spec.label} writes dataset and Iceberg table outputs only — use Default or Always append rows`];
  const out: string[] = [];
  const has = (c: string) => !columns || columns.some((x) => x.name === c);
  const col = (c: string | undefined) => (columns ? columns.find((x) => x.name === c) : c ? { name: c, type: "Boolean" as ColType } : undefined);
  const pk = o.primaryKey ?? [];
  if (!pk.length) out.push(`${o.name}: ${spec.label} needs a primary key (Configure write mode)`);
  for (const c of pk) if (!has(c)) out.push(`${o.name}: the primary key column "${c}" is not in the output`);
  if (mode === "snapshotReplaceRemove") {
    const c = col(o.postFilterColumn);
    if (!o.postFilterColumn) out.push(`${o.name}: Snapshot replace and remove needs a post-filtering column`);
    else if (!c) out.push(`${o.name}: the post-filtering column "${o.postFilterColumn}" is not in the output`);
    else if (c.type !== "Boolean") out.push(`${o.name}: the post-filtering column "${c.name}" must be Boolean (it is ${c.type})`);
  }
  if (mode === "directChangelog") {
    const ts = col(o.changelog?.timestamp);
    const del = col(o.changelog?.deleted);
    if (!ts) out.push(`${o.name}: Direct changelog needs a timestamp column in the output`);
    if (!del) out.push(`${o.name}: Direct changelog needs a deletion column in the output`);
    else if (del.type !== "Boolean") out.push(`${o.name}: the deletion column "${del.name}" must be Boolean (it is ${del.type})`);
  }
  if (mode === "changelog" && columns) for (const c of ["_changelog_timestamp", "_is_deleted"]) if (has(c)) out.push(`${o.name}: Changelog adds the column "${c}" — rename the output column of that name`);
  return out;
}

export type DeployModeFields = {
  mode: Exclude<ResolvedWriteMode, "default"> | "snapshot" | "append";
  primary_key: string[];
  post_filter: string | null;
  changelog_timestamp: string | null;
  changelog_deleted: string | null;
};
/** The write mode fields of a dataset deploy request; the caller resolves Default to a snapshot or an append. */
export const deployModeFields = (o: Output, resolvedDefault: "snapshot" | "append"): DeployModeFields => {
  const m = writeModeOf(o);
  return {
    mode: m === "default" ? resolvedDefault : m,
    primary_key: o.primaryKey ?? [],
    post_filter: o.postFilterColumn ?? null,
    changelog_timestamp: o.changelog?.timestamp ?? null,
    changelog_deleted: o.changelog?.deleted ?? null,
  };
};

/** The incremental inputs (dataset ids) feeding a node. */
export function incrementalInputs(p: Pick<Pipeline, "nodes">, ref: string): string[] {
  const ids = new Set([refNode(ref), ...ancestors(p.nodes, ref)]);
  return p.nodes.filter((n) => ids.has(n.id) && n.kind === "source" && n.mode === "incremental").map((n) => (n as SourceNode).datasetId);
}

/** Transforms that need data across rows: in an incremental pipeline their state covers past builds. */
const STATEFUL_STEPS = new Set(["aggregate", "aggregate_columns", "window", "pivot", "dedupe", "top_rows", "keep_duplicates", "fp_growth", "date_distribution", "numeric_distribution"]);
/**
 * What the state of an incremental output depends on: its stateful transforms (and the inputs feeding
 * them). A change here is a breaking change: the output must be replayed from the start of the input data.
 */
export function statefulFingerprint(p: Pick<Pipeline, "nodes">, ref: string): string {
  const ids = new Set([refNode(ref), ...ancestors(p.nodes, ref)]);
  const parts: string[] = [];
  for (const n of p.nodes) {
    if (!ids.has(n.id) || n.kind !== "transform") continue;
    const steps = n.steps.filter((st) => STATEFUL_STEPS.has(st.kind) || (st.kind === "sql" && /\b(group\s+by|over\s*\(|distinct)\b/i.test(String(st.params.query ?? ""))));
    if (steps.length) parts.push(JSON.stringify([n.id, n.input, steps.map((st) => [st.kind, st.params])]));
  }
  return parts.sort().join("\n");
}

/** Partition and primary keys of a stream (Foundry's includeInPartitioning and primaryKey schema metadata). */
export type StreamKeys = { partition: string[]; primary: { columns: string[]; deleted: string | null } | null };

/**
 * The keys an output stream gets: from the nearest Key by step upstream of it, else the keys of its input
 * streams (`inputKeys` by dataset id). Keys on columns the output no longer has are dropped (all partition
 * columns gone drops the key). Primary keys do not propagate through stateful transforms, except a running
 * aggregate grouped by (at least) the primary key columns: it emits one updated row per group, so its output
 * is a changelog keyed by the group-by columns.
 */
export function streamKeys(p: Pick<Pipeline, "nodes">, ref: string, inputKeys: Record<string, StreamKeys | undefined>, columns: string[]): StreamKeys {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let stateful = false;
  // the group-by columns of the aggregate nearest the output, when every stateful step is a plain aggregate
  let grouped: string[] | null = null;
  let otherStateful = false;
  const walk = (r: string): StreamKeys | null => {
    const n = byId.get(refNode(r));
    if (!n || seen.has(n.id)) return null;
    seen.add(n.id);
    if (n.kind === "source") return inputKeys[n.datasetId] ?? null;
    if (n.kind === "transform") {
      for (let i = n.steps.length - 1; i >= 0; i--) {
        const st = n.steps[i];
        if (st.kind === "key_by") {
          const cols = list(st.params, "columns");
          return { partition: cols, primary: st.params.cdc === "true" ? { columns: cols, deleted: str(st.params, "deleted") || null } : null };
        }
        if (STATEFUL_STEPS.has(st.kind)) {
          stateful = true;
          const groupBy = list(st.params, "groupBy");
          if (st.kind === "aggregate" && (str(st.params, "grouping") || "Group by") === "Group by" && groupBy.length) grouped ??= groupBy;
          else otherStateful = true;
        }
      }
    }
    for (const i of inputsOf(n)) {
      const k = walk(i);
      if (k) return k;
    }
    return null;
  };
  const found = walk(ref) ?? { partition: [], primary: null };
  const has = new Set(columns);
  const partition = found.partition.filter((c) => has.has(c));
  // assigned inside walk: TypeScript's narrowing does not see it
  const groupCols = grouped as string[] | null;
  const aggregatedKey = !!found.primary && stateful && !otherStateful && !!groupCols && found.primary.columns.every((c) => groupCols.includes(c)) && groupCols.every((c) => has.has(c));
  let primary = aggregatedKey ? { columns: groupCols!, deleted: null } : found.primary && !stateful && found.primary.columns.every((c) => has.has(c)) ? found.primary : null;
  if (primary?.deleted && !has.has(primary.deleted)) primary = { ...primary, deleted: null };
  return { partition: partition.length ? partition : [], primary };
}

/** The keyed process UDFs (by name) an output depends on: they keep their own state per key. */
export function keyedProcessUdfs(p: Pick<Pipeline, "nodes" | "functions">, ref: string): string[] {
  const ids = new Set([refNode(ref), ...ancestors(p.nodes, ref)]);
  const keyed = new Map((p.functions ?? []).filter((f): f is CustomUdf => f.kind === "udf" && f.udf.type === "keyed_process").map((f) => [FN_PREFIX + f.id, f.name]));
  const out = new Set<string>();
  for (const n of p.nodes) if (ids.has(n.id) && n.kind === "transform") for (const st of n.steps) if (keyed.has(st.kind)) out.add(keyed.get(st.kind)!);
  return [...out];
}

/** Whether an output depends on stateful transforms (aggregations, windows, dedupe …): in a streaming
 *  pipeline those keep state across records, not just within one poll. */
export const isStatefulOutput = (p: Pick<Pipeline, "nodes">, ref: string) => statefulFingerprint(p, ref) !== "";

/** Nodes whose output feeds `id` (directly or not). */
export function ancestors(nodes: PipelineNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const walk = (ref: string) => {
    const n = byId.get(refNode(ref));
    if (!n) return;
    for (const i of inputsOf(n)) {
      const up = refNode(i);
      if (!out.has(up)) {
        out.add(up);
        walk(up);
      }
    }
  };
  walk(id);
  return out;
}

/** Nodes fed by `id` (directly or not). */
export function descendants(nodes: PipelineNode[], id: string): Set<string> {
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes)
      if (!out.has(n.id) && inputsOf(n).some((i) => refNode(i) === id || out.has(refNode(i)))) {
        out.add(n.id);
        grew = true;
      }
  }
  return out;
}

/** Every reference a node can be read through: its id, and a split's False output. */
export function outputRefs(nodes: PipelineNode[]): { ref: string; node: PipelineNode; label: string }[] {
  return nodes.flatMap((n): { ref: string; node: PipelineNode; label: string }[] =>
      n.kind === "split"
        ? [
            { ref: n.id, node: n, label: `${n.name} (True)` },
            { ref: n.id + FALSE_PORT, node: n, label: `${n.name} (False)` },
          ]
        : [{ ref: n.id, node: n, label: n.name }],
    );
}

/** Display name of an input reference. */
export function refLabel(nodes: PipelineNode[], ref: string): string {
  const n = nodes.find((x) => x.id === refNode(ref));
  if (!n) return "missing";
  return n.kind === "split" ? `${n.name} (${isFalsePort(ref) ? "False" : "True"})` : n.name;
}

// ---------------------------------------------------------------- storage

export const PIPELINE_INDEX_KEY = "bluesandai.pipelines";
export const pipelineKey = (id: string) => `bluesandai.pipeline.${id}`;
/** dispatched on window after every save or delete (the storage event only reaches other tabs) */
export const PIPELINES_CHANGED = "bluesandai:pipelines";

function listPipelines(): PipelineSummary[] {
  try {
    return JSON.parse(localStorage.getItem(PIPELINE_INDEX_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function savePipeline(p: Pipeline): Pipeline {
  const saved = { ...p, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(pipelineKey(p.id), JSON.stringify(saved));
  } catch {
    throw new Error("This pipeline is too large to keep in the browser — remove a dataset or use smaller files.");
  }
  const summary: PipelineSummary = {
    id: saved.id,
    name: saved.name,
    type: saved.type,
    updatedAt: saved.updatedAt,
    nodes: saved.nodes.length,
    outputs: saved.outputs.length,
  };
  localStorage.setItem(PIPELINE_INDEX_KEY, JSON.stringify([summary, ...listPipelines().filter((s) => s.id !== p.id)]));
  window.dispatchEvent(new Event(PIPELINES_CHANGED));
  return saved;
}

/** A pipeline kept in this browser (before pipelines became files), or null. */
export function loadPipeline(id: string): Pipeline | null {
  try {
    const raw = localStorage.getItem(pipelineKey(id));
    return raw ? (JSON.parse(raw) as Pipeline) : null;
  } catch {
    return null;
  }
}

export function deletePipeline(id: string) {
  localStorage.removeItem(pipelineKey(id));
  localStorage.setItem(PIPELINE_INDEX_KEY, JSON.stringify(listPipelines().filter((s) => s.id !== id)));
  window.dispatchEvent(new Event(PIPELINES_CHANGED));
}

export function newPipeline(name: string, type: PipelineType, location?: DriveLocation): Pipeline {
  const now = new Date().toISOString();
  return { id: uid(), name, type, createdAt: now, updatedAt: now, nodes: [], datasets: {}, outputs: [], legend: [], incrementalDefault: true, ...(location ? { location } : {}) };
}

/** Compute that can read only new rows: the browser/server engine. The DuckDB local and external (warehouse)
 *  engines compile every source as a whole table and reject incremental sources, so pipelines on them keep
 *  the snapshot default until those engines learn watermarks. */
export const supportsIncremental = (p: Pick<Pipeline, "type" | "compute" | "external">): boolean =>
  p.type === "batch" && !p.external && p.compute !== "duckdb" && p.compute !== "external";

/** The mode a source node added to a pipeline starts with: incremental on pipelines created since it became
 *  the default, snapshot on older files (their sources carry no flag and must not change meaning). */
export const newSourceMode = (p: Pick<Pipeline, "type" | "compute" | "external" | "incrementalDefault">): InputMode =>
  p.incrementalDefault && supportsIncremental(p) ? "incremental" : "snapshot";

// ---------------------------------------------------------------- reading files

/** RFC 4180 CSV with the delimiter (comma, tab or semicolon) detected from the header line. */
export function parseCsv(text: string): Table {
  text = text.replace(/^\uFEFF/, "");
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  const delim = [",", "\t", ";"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );

  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((v) => v !== ""));
  if (!nonEmpty.length) throw new Error("The file is empty");

  const names = uniqueNames(nonEmpty[0].map((h) => h.trim()));
  return {
    columns: names.map((name) => ({ name, type: "String" })),
    rows: nonEmpty.slice(1).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? null]))),
  };
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n, i) => {
    let name = n || `column_${i + 1}`;
    while (seen.has(name)) name += "_";
    seen.add(name);
    return name;
  });
}

/** A JSON array of objects, an object holding one, or JSON Lines. Nested values become JSON text. */
export function parseJson(text: string): Table {
  text = text.replace(/^﻿/, "").trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          throw new Error(`Line ${i + 1} is not valid JSON`);
        }
      });
  }
  if (data && !Array.isArray(data) && typeof data === "object") {
    const arrays = Object.values(data).filter(Array.isArray);
    data = arrays.length === 1 ? arrays[0] : [data];
  }
  if (!Array.isArray(data) || !data.length) throw new Error("Expected a list of records");
  return fromRecords(data.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? r : { value: r })));
}

export function fromRecords(records: Record<string, unknown>[]): Table {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of records)
    for (const k of Object.keys(r))
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
  const columns: Column[] = [];
  const values = new Map<string, Cell[]>();
  for (const name of names) {
    const col = inferColumn(records.map((r) => r[name]));
    columns.push({ name, type: col.type });
    values.set(name, col.values);
  }
  return { columns, rows: records.map((_, i) => Object.fromEntries(names.map((n) => [n, values.get(n)![i]]))) };
}

/** Narrowest type for numbers: int within 32 bits, bigint up to 2^53 (exact in JavaScript), else double. */
export function numberType(nums: number[]): ColType {
  if (!nums.every((n) => Number.isInteger(n))) return "Double";
  if (nums.every((n) => Math.abs(n) <= 2147483647)) return "Integer";
  return nums.every((n) => Number.isSafeInteger(n)) ? "Long" : "Double";
}

/** Type of a column from raw JS values; objects become JSON text and mixed columns become strings. */
function inferColumn(raw: unknown[]): { type: ColType; values: Cell[] } {
  const present = raw.filter((v) => v !== null && v !== undefined);
  let type: ColType = "String";
  if (present.length && present.every((v) => typeof v === "number"))
    type = numberType(present as number[]);
  else if (present.length && present.every((v) => typeof v === "boolean")) type = "Boolean";
  const values = raw.map((v): Cell => {
    if (v === null || v === undefined) return null;
    if (type !== "String") return v as Cell;
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  return { type, values };
}

export const DATA_FILE_ACCEPT = ".csv,.tsv,.txt,.json,.jsonl,.ndjson";

export async function readDataFile(file: File): Promise<Table> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "parquet") throw new Error("Parquet is not supported yet — export it as CSV or JSON");
  if (file.size > 20 * 1024 * 1024) throw new Error("Files up to 20 MB can be used in the browser");
  const text = await file.text();
  return ["json", "jsonl", "ndjson"].includes(ext) ? parseJson(text) : parseCsv(text);
}

export const datasetName = (fileName: string) => fileName.replace(/\.[^.]+$/, "");

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Why a file cannot be uploaded as a structured dataset, or null when it can: CSV / TSV with columns,
 * or JSON / JSON Lines holding a list of records (alone or as the one list in a wrapper object).
 * Anything else — a single JSON document, a list of plain values, prose, binary files — only goes
 * into an unstructured dataset.
 */
export function unstructuredReason(fileName: string, text: string): string | null {
  const ext = fileName.toLowerCase().includes(".") ? fileName.toLowerCase().split(".").pop()! : "";
  if (text.slice(0, 8192).includes("\u0000")) return "Binary file — no rows and columns";
  const body = text.replace(/^﻿/, "").trim();
  if (!body) return "Empty file";
  if (["json", "jsonl", "ndjson"].includes(ext)) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      try {
        data = body
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
      } catch {
        return "Not valid JSON or JSON Lines";
      }
    }
    if (isRecord(data)) {
      const lists = Object.values(data).filter(Array.isArray);
      if (lists.length !== 1 || !lists[0].length || !lists[0].every(isRecord)) return "A single JSON document, not a list of records";
      data = lists[0];
    }
    if (!Array.isArray(data) || !data.length) return "No records";
    if (!data.every(isRecord)) return "A JSON list of values, not records";
    return null;
  }
  if (["csv", "tsv", "txt"].includes(ext)) {
    try {
      const t = parseCsv(text);
      if (!t.columns.length) return "No columns";
      // plain text reads as one column of lines: not a table
      if (ext === "txt" && t.columns.length < 2) return "Plain text, not delimited columns";
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }
  return `${ext ? `.${ext} files` : "Files without an extension"} have no rows and columns`;
}

// ---------------------------------------------------------------- values

function toNumber(v: Cell): number | null {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function toDate(v: Cell): Date | null {
  if (v === null || typeof v === "boolean") return null;
  // epoch seconds or milliseconds
  if (typeof v === "number") {
    const d = new Date(Math.abs(v) < 1e11 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let s = v.trim().replace(/\s*\([^)]*\)\s*$/, "");
  // date-times without a zone are UTC (as Spark's session time zone here), not the browser's local time
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
  if (local) s = `${local[1]}T${local[2]}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// binary values are kept as base64 text

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64ToBytes(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Rounds half up to `scale` decimals; null when the integer part needs more than precision − scale digits (Spark: overflow → null). */
export function toDecimal(n: number, precision: number, scale: number): number | null {
  const factor = 10 ** scale;
  const rounded = (Math.sign(n) * Math.round(Math.abs(n) * factor + 1e-9 * Math.abs(n) * factor)) / factor;
  if (!Number.isFinite(rounded)) return null;
  // count digits arithmetically: toString() writes large numbers as 1e+21
  const whole = Math.trunc(Math.abs(rounded));
  const intDigits = whole === 0 ? 0 : Math.floor(Math.log10(whole)) + 1;
  return intDigits > precision - scale ? null : rounded + 0;
}

export function castCell(v: Cell, to: ColType): Cell {
  if (v === null) return null;
  const range = INTEGRAL[to];
  if (range) {
    const n = toNumber(v);
    if (n === null) return null;
    const i = Math.trunc(n);
    return i < range[0] || i > range[1] ? null : i;
  }
  switch (to) {
    case "String":
      return typeof v === "string" ? v : String(v);
    case "Float": {
      const n = toNumber(v);
      // 32-bit precision, shown without the binary noise
      return n === null ? null : Math.abs(n) > 3.4028234663852886e38 ? null : Number(Math.fround(n).toPrecision(7));
    }
    case "Double":
    case "Decimal":
      return toNumber(v);
    case "Binary":
      return bytesToBase64(new TextEncoder().encode(String(v)));
    case "Boolean": {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      const s = String(v).trim().toLowerCase();
      if (["true", "t", "yes", "y", "1"].includes(s)) return true;
      if (["false", "f", "no", "n", "0"].includes(s)) return false;
      return null;
    }
    case "Date": {
      const d = toDate(v);
      return d ? d.toISOString().slice(0, 10) : null;
    }
    case "Timestamp": {
      const d = toDate(v);
      return d ? d.toISOString() : null;
    }
  }
  return null;
}

/** Spark CAST from a known column type: binary decodes / encodes bytes, timestamps and numbers convert via epoch seconds. */
export function castValue(v: Cell, from: ColType, to: ColType, decimal?: { precision: number; scale: number }): Cell {
  if (v === null) return null;
  // same type: unchanged, except whole numbers are still checked against the type's range
  if (from === to && to !== "Decimal") return INTEGRAL[to] ? castCell(v, to) : v;
  if (from === "Binary") {
    const bytes = base64ToBytes(String(v));
    if (!bytes) return null;
    if (to === "String") return new TextDecoder().decode(bytes);
    // other targets read the bytes as text, e.g. binary "12" → 12
    return castValue(new TextDecoder().decode(bytes), "String", to, decimal);
  }
  if (to === "Binary") {
    const range = INTEGRAL[from];
    if (range) {
      // integers become big-endian bytes of their width, as in Spark
      const view = new DataView(new ArrayBuffer(range[2]));
      const n = toNumber(v);
      if (n === null) return null;
      if (range[2] === 1) view.setInt8(0, n);
      else if (range[2] === 2) view.setInt16(0, n);
      else if (range[2] === 4) view.setInt32(0, n);
      else view.setBigInt64(0, BigInt(Math.trunc(n)));
      return bytesToBase64(new Uint8Array(view.buffer));
    }
    return castCell(castCell(v, "String"), "Binary");
  }
  if (from === "Timestamp" && isNumericType(to)) {
    // timestamps become seconds since 1970-01-01 UTC
    const d = toDate(v);
    return d ? castValue(d.getTime() / 1000, "Double", to, decimal) : null;
  }
  if (from === "Date" && isNumericType(to)) return null;
  if (isNumericType(from) && (to === "Timestamp" || to === "Date")) {
    const n = toNumber(v);
    if (n === null) return null;
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return null;
    return to === "Date" ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  if (to === "Decimal") {
    const n = typeof v === "boolean" ? null : toNumber(v);
    return n === null ? null : toDecimal(n, decimal?.precision ?? 10, decimal?.scale ?? 0);
  }
  return castCell(v, to);
}

/** Text order with numbers in text compared by value ("a2" < "a10"); one collator, as localeCompare with options builds a new one per call. */
export const textOrder = new Intl.Collator(undefined, { numeric: true }).compare;

/** Nulls sort last; numbers and booleans numerically; everything else as text. */
export function compareCells(a: Cell, b: Cell): number {
  if (a === null || a === "") return b === null || b === "" ? 0 : 1;
  if (b === null || b === "") return -1;
  if (typeof a !== "string" && typeof b !== "string") return Number(a) - Number(b);
  return textOrder(String(a), String(b));
}

const isEmpty = (v: Cell) => v === null || v === "";
const cellKey = (v: Cell) => (v === null ? "\u0000null" : `${typeof v}:${v}`);

// ---------------------------------------------------------------- transform steps

export type FieldDef = {
  key: string;
  label: string;
  /** expressions: an ordered list of columns and literal values (see LITERAL); boolean: "true" or "";
   *  formats: a list of date patterns; timezone: an IANA zone name */
  kind:
    | "column"
    | "columns"
    | "expressions"
    | "text"
    | "select"
    | "boolean"
    | "formats"
    | "timezone"
    | "formula"
    /** CASE WHEN branches (JSON) */
    | "cases"
    /** list of aggregations (JSON) */
    | "aggregations"
    /** ORDER BY keys (JSON) */
    | "sortkeys"
    /** a SQL query */
    | "sql"
    /** a Cipher license RID (picked from the licenses the user may use for `cipherOperation`) */
    | "cipherLicense";
  cipherOperation?: "encrypt" | "decrypt" | "hash";
  /** shown only when this returns true */
  showIf?: (p: Params) => boolean;
  help?: string;
  options?: readonly string[];
  /** display text of a select option */
  optionLabel?: (option: string) => string;
  optional?: boolean;
  placeholder?: string;
};

/** What a step can use besides its input: the other pipeline nodes and the SQL engine. */
export type StepContext = {
  /** table names of the other nodes */
  names: () => string[];
  /** a node's output by table name; throws if that node fails */
  table: (name: string) => Table | undefined;
  sql?: SqlRuntime;
  /** custom expressions and transforms of the pipeline, for "fn:<id>" steps */
  functions?: CustomFunction[];
  /** async work (text extraction, parsing, embeddings) is looked up and requested here */
  services?: Services;
  /** previews compute async values for the first rows only */
  preview?: boolean;
  /** steps add the rows still being computed */
  pending?: { count: number };
  /** the node and step being run (keyed process UDFs scope their state by them) */
  nodeId?: string;
  stepId?: string;
  /** a streaming job's keyed state (keyed process UDFs); absent: a batch, the state starts empty */
  keyedState?: KeyedStates;
  /** builds: the result stores of Compute if expression absent steps (kept in the pipeline's state) */
  stores?: ResultStores;
};

/** Results of Compute if expression absent, by store id: key (JSON of the key values) → result. */
export type ResultStores = {
  get: (storeId: string) => Record<string, Cell> | undefined;
  type: (storeId: string) => ColType | undefined;
  put: (storeId: string, results: Record<string, Cell>, type: ColType | undefined) => void;
};

/**
 * The keyed state of a streaming job's keyed process UDF steps, by scope (node id:step id): `get` returns what the
 * last committed micro-batch left; `use` tells the job which service answer carries the step's new state, which it
 * commits with the batch's offsets.
 */
export type KeyedStates = { get: (scope: string) => unknown; use: (scope: string, key: string) => void };

/** The SQL engine once loaded, or why it could not load. */
export type SqlRuntime = { engine: SqlEngine | null; error: string | null };

/** Table name of a node in SQL: lower case, non-alphanumerics as _, e.g. "customers_raw (1)" → customers_raw_1. */
export const tableName = (node: string) => {
  const n = node.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "table";
  return /^[0-9]/.test(n) ? `t_${n}` : n;
};

/** Unique SQL table name per node: nodes with the same name get _2, _3… in graph order. */
export function tableNames(nodes: { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set(["input"]);
  for (const n of nodes) {
    const base = tableName(n.name);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    out.set(n.id, name);
  }
  return out;
}

/** Runs SQL over named tables; supplied by the UI once the SQLite (sql.js) runtime has loaded. */
export type SqlEngine = { query: (tables: Record<string, Table>, sql: string) => Table };

export type StepDef = {
  kind: string;
  label: string;
  category: string;
  description: string;
  fields: FieldDef[];
  /** writes its result to the `output` param, defaulting to the input column (replace) */
  output?: boolean;
  /** output column name when `output` is left empty; defaults to the input column */
  outputDefault?: string | ((p: Params) => string);
  /** params a new step starts with */
  defaults?: Params;
  run: (t: Table, p: Params, ctx?: StepContext) => Table;
  summary: (p: Params) => string;
};

const str = (p: Params, k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");

/** Marks a literal value in an expressions list; column names never contain it. */
export const LITERAL = "\u0001";
export const isLiteral = (e: string) => e.startsWith(LITERAL);
export const literalText = (e: string) => e.slice(LITERAL.length);
const expressionText = (e: string) => (isLiteral(e) ? JSON.stringify(literalText(e)) : e || "?");
const list = (p: Params, k: string) => (Array.isArray(p[k]) ? (p[k] as string[]) : []);

function need(t: Table, name: string): Column {
  if (!name) throw new Error("Choose a column");
  const col = t.columns.find((c) => c.name === name);
  if (!col) throw new Error(`Column "${name}" not found`);
  return col;
}

/** The output column name for a step: its `output` param, else the input column. */
export const outputName = (p: Params, fallback = str(p, "column")) => str(p, "output").trim() || fallback;

/** Adds or replaces a column. Every step writes through here, so it also guards the values: ±∞ and NaN become null. */
function setColumn(t: Table, name: string, type: ColType, value: (row: Row) => Cell): Table {
  if (!COL_TYPES.includes(type)) throw new Error(`Unknown type "${type}"`);
  if (!name) throw new Error("The output column needs a name");
  const exists = t.columns.some((c) => c.name === name);
  return {
    columns: exists ? t.columns.map((c) => (c.name === name ? { name, type } : c)) : [...t.columns, { name, type }],
    rows: t.rows.map((r) => {
      const v = value(r);
      return { ...r, [name]: typeof v === "number" && !Number.isFinite(v) ? null : v };
    }),
  };
}

/** A type chosen in a select, checked: settings from storage may hold anything. */
function typeParam(p: Params, key: string, fallback: ColType): ColType {
  const t = str(p, key) || fallback;
  if (!COL_TYPES.includes(t as ColType)) throw new Error(`Unknown type "${t}"`);
  return t as ColType;
}

function mapText(t: Table, p: Params, fn: (s: string) => string): Table {
  const col = need(t, str(p, "column"));
  return setColumn(t, outputName(p), "String", (r) => {
    const v = r[col.name];
    return v === null ? null : fn(String(v));
  });
}

// ---- filter conditions: kept as JSON in the filter step's `filter` param

export const FILTER_OPS = [
  "is null",
  "is not null",
  "is equal to",
  "is not equal to",
  // null-unsafe equality: null on either side gives null (the condition is not satisfied)
  "is equal to (not null safe)",
  "is not equal to (not null safe)",
  "starts with",
  "ends with",
  "contains",
  "does not contain",
  "regex find",
  "regex match",
  "is less than",
  "is less than or equal to",
  "is greater than",
  "is greater than or equal to",
  "is in",
  "is not in",
  "is between",
  "is not between",
  "like",
  "not like",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const RANGE_OPS: ReadonlySet<FilterOp> = new Set(["is between", "is not between"]);
export const LIST_OPS: ReadonlySet<FilterOp> = new Set(["is in", "is not in"]);
export const UNARY_OPS: ReadonlySet<FilterOp> = new Set(["is null", "is not null"]);
const OP_SYMBOL: Partial<Record<FilterOp, string>> = {
  "is equal to": "=",
  "is not equal to": "≠",
  "is equal to (not null safe)": "= (not null safe)",
  "is not equal to (not null safe)": "≠ (not null safe)",
  "is less than": "<",
  "is less than or equal to": "≤",
  "is greater than": ">",
  "is greater than or equal to": "≥",
};

export type Operand = { kind: "column"; column: string } | { kind: "value"; type: ColType; value: string } | null;
export type Condition = {
  id: string;
  left: Operand;
  op: FilterOp;
  right: Operand;
  /** is null / is not null: also count "" (how CSV files store empty cells) as null */
  emptyAsNull?: boolean;
  /** upper bound of is between */
  right2?: Operand;
};
export type ConditionGroup = { id: string; match: "all" | "any"; items: (Condition | ConditionGroup)[] };

export const isGroup = (item: Condition | ConditionGroup): item is ConditionGroup => "items" in item;
export const newCondition = (): Condition => ({ id: uid(), left: null, op: "is equal to", right: null });
export const newGroup = (): ConditionGroup => ({ id: uid(), match: "all", items: [newCondition()] });
export const FILTER_MODES = ["Keep rows", "Remove rows"] as const;

const LEGACY_OPS: Record<string, FilterOp> = {
  equals: "is equal to",
  "does not equal": "is not equal to",
  "greater than": "is greater than",
  "less than": "is less than",
  "at least": "is greater than or equal to",
  "at most": "is less than or equal to",
  "is empty": "is null",
  "is not empty": "is not null",
  "matches regex": "regex find",
};
// no prototype: names from data ("constructor", "toString"…) must not match inherited properties
Object.setPrototypeOf(LEGACY_OPS, null);

/** Siblings keep distinct ids (editors key rows by them): a repeated id gets ~2, ~3… */
function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id;
    for (let k = 2; seen.has(id); k++) id = `${item.id}~${k}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/** A condition group read from JSON with every part checked; null when it is not one. */
function cleanGroup(raw: unknown, id: string): ConditionGroup | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as ConditionGroup).items)) return null;
  const g = raw as ConditionGroup;
  const operand = (o: unknown): Operand => {
    if (!o || typeof o !== "object") return null;
    const x = o as Record<string, unknown>;
    if (x.kind === "column" && typeof x.column === "string") return { kind: "column", column: x.column };
    if (x.kind === "value") return { kind: "value", type: (COL_TYPES as readonly unknown[]).includes(x.type) ? (x.type as ColType) : "String", value: String(x.value ?? "") };
    return null;
  };
  const items: (Condition | ConditionGroup)[] = [];
  g.items.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const itemId = typeof item.id === "string" && item.id ? item.id : `${id}.${i}`;
    if ("items" in item) {
      const sub = cleanGroup(item, itemId);
      if (sub) items.push(sub);
      return;
    }
    const c = item as Condition;
    const op = LEGACY_OPS[c.op] ?? (FILTER_OPS.includes(c.op) ? c.op : "is equal to");
    items.push({ id: itemId, left: operand(c.left), op, right: operand(c.right), right2: operand(c.right2), emptyAsNull: c.emptyAsNull === true || undefined });
  });
  return { id: typeof g.id === "string" && g.id ? g.id : id, match: g.match === "any" ? "any" : "all", items: uniqueIds(items) };
}

/** The condition tree of a filter step; also reads the older single-condition params. */
export function readFilter(p: Params): ConditionGroup {
  const raw = str(p, "filter");
  if (raw) {
    try {
      const g = cleanGroup(JSON.parse(raw), "root");
      if (g) return g;
    } catch {}
  }
  // ids are fixed so the editor keeps focus until the first edit stores real ones
  const column = str(p, "column");
  if (!column) return { id: "root", match: "all", items: [{ id: "c0", left: null, op: "is equal to", right: null }] };
  const op = LEGACY_OPS[str(p, "op")] ?? (FILTER_OPS.includes(str(p, "op") as FilterOp) ? (str(p, "op") as FilterOp) : "is equal to");
  return {
    id: "root",
    match: "all",
    items: [
      {
        id: "c0",
        left: { kind: "column", column },
        op,
        right: UNARY_OPS.has(op) ? null : { kind: "value", type: "String", value: str(p, "value") },
        emptyAsNull: UNARY_OPS.has(op),
      },
    ],
  };
}

/** Equality / ordering that lets a number column be compared with a value typed as text. */
function looseCompare(a: Cell, b: Cell): number {
  if (typeof a === "number" && typeof b === "string") {
    const n = toNumber(b);
    if (n !== null) return a - n;
  }
  if (typeof b === "number" && typeof a === "string") {
    const n = toNumber(a);
    if (n !== null) return n - b;
  }
  return compareCells(a, b);
}

function compileOperand(t: Table, o: Operand): (r: Row) => Cell {
  if (!o) throw new Error("Complete every condition");
  if (o.kind === "column") {
    const col = need(t, o.column);
    return (r) => r[col.name] ?? null;
  }
  const v = o.value === "" && o.type !== "String" ? null : castCell(o.value, o.type);
  if (v === null && o.value !== "") throw new Error(`"${o.value}" is not a valid ${o.type}`);
  return () => v;
}

function compileCondition(t: Table, c: Condition): (r: Row) => boolean {
  const left = compileOperand(t, c.left);
  const op = LEGACY_OPS[c.op] ?? c.op;
  const isNull = c.emptyAsNull ? isEmpty : (v: Cell) => v === null;
  if (op === "is null") return (r) => isNull(left(r));
  if (op === "is not null") return (r) => !isNull(left(r));
  if (LIST_OPS.has(op) && c.right?.kind === "value") {
    // comma-separated list, each item read as the value's type
    const type = c.right.type;
    const items = c.right.value
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "")
      .map((x) => {
        const v = castCell(x, type);
        if (v === null) throw new Error(`"${x}" is not a valid ${type}`);
        return v;
      });
    if (!items.length) throw new Error("List the values, separated by commas");
    const negate = op === "is not in";
    return (r) => {
      const a = left(r);
      if (a === null) return false;
      return items.some((v) => looseCompare(a, v) === 0) !== negate;
    };
  }
  const right = compileOperand(t, c.right);
  if (RANGE_OPS.has(op)) {
    if (!c.right2) throw new Error("Complete every condition");
    const upper = compileOperand(t, c.right2);
    const negate = op === "is not between";
    return (r) => {
      const a = left(r);
      const lo = right(r);
      const hi = upper(r);
      if (a === null || lo === null || hi === null) return false;
      return (looseCompare(a, lo) >= 0 && looseCompare(a, hi) <= 0) !== negate;
    };
  }
  if (op === "like" || op === "not like") {
    const negate = op === "not like";
    return (r) => {
      const a = left(r);
      const b = right(r);
      if (a === null || b === null) return false;
      return likeRegex(String(b)).test(String(a)) !== negate;
    };
  }
  let re: RegExp | null = null;
  if (op === "regex find" || op === "regex match") {
    const pattern = right({});
    try {
      // regex match must cover the whole value; regex find matches anywhere in it
      re = new RegExp(op === "regex match" ? `^(?:${pattern ?? ""})$` : String(pattern ?? ""));
    } catch {
      throw new Error(`Invalid regular expression "${pattern}"`);
    }
  }
  return (r) => {
    const a = left(r);
    const b = right(r);
    // null-safe equality (Pipeline Builder's "is equal to"): null equals null and differs from any value
    if ((op === "is equal to" || op === "is not equal to") && (a === null || b === null)) {
      const same = a === null && b === null;
      return op === "is equal to" ? same : !same;
    }
    // every other comparison with null is null: the condition is not satisfied
    if (a === null || b === null) return false;
    const as = String(a).toLowerCase();
    const bs = String(b).toLowerCase();
    switch (op) {
      case "contains":
        return as.includes(bs);
      case "does not contain":
        return !as.includes(bs);
      case "starts with":
        return as.startsWith(bs);
      case "ends with":
        return as.endsWith(bs);
      case "regex find":
      case "regex match":
        return re!.test(String(a));
    }
    const cmp = looseCompare(a, b);
    if (op === "is in") return cmp === 0;
    if (op === "is not in") return cmp !== 0;
    if (op === "is equal to" || op === "is equal to (not null safe)") return cmp === 0;
    if (op === "is not equal to" || op === "is not equal to (not null safe)") return cmp !== 0;
    if (op === "is less than") return cmp < 0;
    if (op === "is less than or equal to") return cmp <= 0;
    if (op === "is greater than") return cmp > 0;
    return cmp >= 0;
  };
}

const likeCache = new Map<string, RegExp>();

/** SQL LIKE: % is any run of characters, _ is one character, \\ escapes; case-sensitive. */
export function likeRegex(pattern: string): RegExp {
  let re = likeCache.get(pattern);
  if (!re) {
    let src = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "\\" && i + 1 < pattern.length) src += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (ch === "%") src += "[\\s\\S]*";
      else if (ch === "_") src += "[\\s\\S]";
      else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    re = new RegExp(`^${src}$`);
    likeCache.set(pattern, re);
  }
  return re;
}

export function compileGroup(t: Table, g: ConditionGroup): (r: Row) => boolean {
  if (!g.items.length) throw new Error("Add a condition");
  const tests = g.items.map((i) => (isGroup(i) ? compileGroup(t, i) : compileCondition(t, i)));
  return g.match === "any" ? (r) => tests.some((f) => f(r)) : (r) => tests.every((f) => f(r));
}

export const operandText = (o: Operand) => (!o ? "?" : o.kind === "column" ? o.column : JSON.stringify(o.value));

export function describeGroup(g: ConditionGroup, nested = false): string {
  const parts = g.items.map((i) =>
    isGroup(i)
      ? describeGroup(i, true)
      : `${operandText(i.left)} ${OP_SYMBOL[i.op] ?? i.op}${
          UNARY_OPS.has(i.op)
            ? i.emptyAsNull
              ? " or empty"
              : ""
            : RANGE_OPS.has(i.op)
              ? ` ${operandText(i.right)} and ${operandText(i.right2 ?? null)}`
              : LIST_OPS.has(i.op) && i.right?.kind === "value"
                ? ` (${i.right.value})`
                : ` ${operandText(i.right)}`
        }`,
  );
  const text = parts.join(g.match === "any" ? " or " : " and ");
  return nested && parts.length > 1 ? `(${text})` : text;
}

// ---- date formats (Java DateTimeFormatter letters, as in Spark / Pipeline Builder)

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

type DateParts = { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number; offset?: number };
type Setter = (parts: DateParts, text: string) => boolean;

const num = (key: "y" | "mo" | "d" | "h" | "mi" | "s"): Setter => (p, t) => {
  p[key] = Number(t);
  return true;
};

function parseOffset(t: string): number | undefined {
  if (/^z$/i.test(t)) return 0;
  const m = /^(?:GMT|UTC)?([+-])(\d{1,2}):?(\d{2})?$/i.exec(t);
  if (!m) return undefined;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Compiles a pattern such as "EEE MMM dd yyyy HH:mm:ss 'GMT'Z (zzzz)" into a parser of whole strings. */
export function compileDateFormat(pattern: string): (text: string) => DateParts | null {
  let re = "";
  const setters: Setter[] = [];
  let pm: boolean | undefined;
  const group = (regex: string, set: Setter) => {
    re += `(${regex})`;
    setters.push(set);
  };
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i];
    if (ch === "'") {
      // quoted literal; '' is a single quote
      let j = i + 1;
      let lit = "";
      while (j < pattern.length) {
        if (pattern[j] === "'" && pattern[j + 1] === "'") {
          lit += "'";
          j += 2;
        } else if (pattern[j] === "'") break;
        else lit += pattern[j++];
      }
      if (j >= pattern.length && i + 1 !== j) throw new Error(`Unclosed quote in "${pattern}"`);
      re += (lit || "'").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i = j + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) {
      re += /\s/.test(ch) ? "\\s+" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
      continue;
    }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    i += n;
    switch (ch) {
      case "y":
      case "u":
        if (n === 2) group("\\d{2}", (p, t) => ((p.y = 2000 + Number(t)), true));
        else group("\\d{4}", num("y"));
        break;
      case "M":
      case "L":
        if (n >= 3)
          group("[A-Za-z]+\\.?", (p, t) => {
            const name = t.replace(".", "").toLowerCase();
            const idx = MONTHS.findIndex((m) => (n === 3 ? m.startsWith(name) && name.length >= 3 : m === name));
            if (idx < 0) return false;
            p.mo = idx + 1;
            return true;
          });
        else group(n === 2 ? "\\d{2}" : "\\d{1,2}", num("mo"));
        break;
      case "d":
        group(n === 2 ? "\\d{2}" : "\\d{1,2}", num("d"));
        break;
      case "E":
        group("[A-Za-z]+\\.?", () => true);
        break;
      case "H":
      case "k":
        group(n === 2 ? "\\d{2}" : "\\d{1,2}", (p, t) => ((p.h = Number(t) % 24), true));
        break;
      case "h":
      case "K":
        group(n === 2 ? "\\d{2}" : "\\d{1,2}", (p, t) => ((p.h = Number(t) % 12), true));
        break;
      case "a":
        group("[AaPp]\\.?[Mm]\\.?", (_, t) => ((pm = /^p/i.test(t)), true));
        break;
      case "m":
        group(n === 2 ? "\\d{2}" : "\\d{1,2}", num("mi"));
        break;
      case "s":
        group(n === 2 ? "\\d{2}" : "\\d{1,2}", num("s"));
        break;
      case "S":
        group(`\\d{${n}}`, (p, t) => ((p.ms = Number(t.padEnd(3, "0").slice(0, 3))), true));
        break;
      case "Z":
      case "X":
      case "x":
        group("Z|(?:GMT|UTC)?[+-]\\d{1,2}(?::?\\d{2})?", (p, t) => {
          const o = parseOffset(t);
          if (o === undefined) return false;
          p.offset = o;
          return true;
        });
        break;
      case "z":
      case "V":
      case "O":
        // zone names ("GMT", "Greenwich Mean Time") are read but the offset comes from Z/X or the time zone
        group(n >= 4 ? "[A-Za-z][A-Za-z ]*?" : "[A-Za-z][A-Za-z/_+\\-0-9:]*?", (p, t) => {
          const o = parseOffset(t);
          if (o !== undefined && p.offset === undefined) p.offset = o;
          return true;
        });
        break;
      default:
        throw new Error(`Unsupported format letter "${ch}" in "${pattern}" — quote literal text with '…'`);
    }
  }
  const regex = new RegExp(`^\\s*${re}\\s*$`, "i");
  return (text) => {
    const m = regex.exec(text);
    if (!m) return null;
    const parts: DateParts = { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0, ms: 0 };
    pm = undefined;
    for (let g = 0; g < setters.length; g++) if (!setters[g](parts, m[g + 1])) return null;
    if (pm) parts.h = (parts.h % 12) + 12;
    if (parts.mo < 1 || parts.mo > 12 || parts.d < 1 || parts.mi > 59 || parts.s > 60) return null;
    // reject dates such as Feb 30
    if (new Date(Date.UTC(parts.y, parts.mo - 1, parts.d)).getUTCDate() !== parts.d) return null;
    return parts;
  };
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** Minutes the zone is ahead of UTC at the instant `utc`. */
export function zoneOffset(zone: string, utc: number): number {
  let f = zoneFormats.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new Error(`Unknown time zone "${zone}"`);
    }
    zoneFormats.set(zone, f);
  }
  const v = Object.fromEntries(f.formatToParts(utc).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
  return Math.round((asUtc - Math.floor(utc / 1000) * 1000) / 60000);
}

/** Instant of parsed parts: their own offset, else wall-clock time in `zone` (UTC when empty). */
export function partsToUtc(p: DateParts, zone: string): number {
  const local = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms);
  if (p.offset !== undefined) return local - p.offset * 60000;
  if (!zone || zone === "UTC") return local;
  const first = zoneOffset(zone, local);
  const utc = local - first * 60000;
  const second = zoneOffset(zone, utc);
  return second === first ? utc : local - second * 60000;
}

/** Parses text with the first matching format; null when none matches. */
export function parseDateWith(formats: ((t: string) => DateParts | null)[], text: string, zone: string, to: "Date" | "Timestamp"): string | null {
  for (const f of formats) {
    const p = f(text);
    if (!p) continue;
    if (to === "Date") return `${String(p.y).padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    return new Date(partsToUtc(p, zone)).toISOString();
  }
  return null;
}

/** Formats tried by "Generate" when the AI suggestion is unavailable. */
export const COMMON_DATE_FORMATS = [
  "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
  "yyyy-MM-dd'T'HH:mm:ssXXX",
  "yyyy-MM-dd'T'HH:mm:ss.SSS",
  "yyyy-MM-dd'T'HH:mm:ss",
  "yyyy-MM-dd HH:mm:ss",
  "yyyy-MM-dd HH:mm",
  "yyyy-MM-dd",
  "yyyy/MM/dd HH:mm:ss",
  "yyyy/MM/dd",
  "dd/MM/yyyy HH:mm:ss",
  "dd/MM/yyyy",
  "MM/dd/yyyy HH:mm:ss",
  "MM/dd/yyyy h:mm a",
  "MM/dd/yyyy",
  "dd-MM-yyyy",
  "dd.MM.yyyy",
  "d MMM yyyy",
  "dd MMM yyyy HH:mm",
  "MMM d, yyyy",
  "MMMM d, yyyy",
  "EEE MMM dd yyyy HH:mm:ss 'GMT'Z (zzzz)",
  "EEE MMM dd HH:mm:ss zzz yyyy",
  "EEE, dd MMM yyyy HH:mm:ss Z",
  "yyyyMMdd",
];

/** How many of the sample values each format parses, best first. */
export function rankDateFormats(formats: string[], samples: string[]): { format: string; matches: number }[] {
  return formats
    .map((format) => {
      try {
        const parse = compileDateFormat(format);
        return { format, matches: samples.filter((s) => parse(s)).length };
      } catch {
        return { format, matches: -1 };
      }
    })
    .filter((r) => r.matches >= 0)
    .sort((a, b) => b.matches - a.matches);
}

// ---- formula: arithmetic expressions over columns, e.g. A*x^2 + b^2 + ln(x)

type Num = number | null;
type Fn = { args: [number, number]; run: (...a: number[]) => number; help: string };

export const FORMULA_FUNCTIONS: Record<string, Fn> = {
  rand: { args: [0, 1], run: Math.random, help: "random number in [0, 1); rand(seed) gives a repeatable sequence" },
  ln: { args: [1, 1], run: Math.log, help: "natural logarithm" },
  log: { args: [1, 2], run: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)), help: "log(x) base 10, log(x, base)" },
  log2: { args: [1, 1], run: Math.log2, help: "base-2 logarithm" },
  exp: { args: [1, 1], run: Math.exp, help: "e to the power x" },
  sqrt: { args: [1, 1], run: Math.sqrt, help: "square root" },
  cbrt: { args: [1, 1], run: Math.cbrt, help: "cube root" },
  abs: { args: [1, 1], run: Math.abs, help: "absolute value" },
  pow: { args: [2, 2], run: Math.pow, help: "pow(x, y) = x^y" },
  round: { args: [1, 2], run: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n, help: "round(x) or round(x, decimals)" },
  floor: { args: [1, 1], run: Math.floor, help: "round down" },
  ceil: { args: [1, 1], run: Math.ceil, help: "round up" },
  sign: { args: [1, 1], run: Math.sign, help: "-1, 0 or 1" },
  min: { args: [1, 99], run: Math.min, help: "smallest argument" },
  max: { args: [1, 99], run: Math.max, help: "largest argument" },
  sin: { args: [1, 1], run: Math.sin, help: "sine (radians)" },
  cos: { args: [1, 1], run: Math.cos, help: "cosine (radians)" },
  tan: { args: [1, 1], run: Math.tan, help: "tangent (radians)" },
  asin: { args: [1, 1], run: Math.asin, help: "arcsine" },
  acos: { args: [1, 1], run: Math.acos, help: "arccosine" },
  atan: { args: [1, 1], run: Math.atan, help: "arctangent" },
  atan2: { args: [2, 2], run: Math.atan2, help: "atan2(y, x): angle of the point (x, y)" },
  sinh: { args: [1, 1], run: Math.sinh, help: "hyperbolic sine" },
  cosh: { args: [1, 1], run: Math.cosh, help: "hyperbolic cosine" },
  tanh: { args: [1, 1], run: Math.tanh, help: "hyperbolic tangent" },
  log10: { args: [1, 1], run: Math.log10, help: "base-10 logarithm" },
  log1p: { args: [1, 1], run: Math.log1p, help: "ln(1 + x)" },
  expm1: { args: [1, 1], run: Math.expm1, help: "e^x − 1" },
  hypot: { args: [2, 2], run: Math.hypot, help: "√(a² + b²)" },
  bround: { args: [1, 2], run: (x, d = 0) => roundHalfEven(x, d), help: "round half to even (bankers' rounding)" },
  rint: { args: [1, 1], run: (x) => roundHalfEven(x, 0), help: "nearest whole number, ties to even" },
  signum: { args: [1, 1], run: Math.sign, help: "-1, 0 or 1" },
  negative: { args: [1, 1], run: (x) => -x, help: "−x" },
  factorial: { args: [1, 1], run: (x) => factorial(x) ?? NaN, help: "n! for 0–20" },
  pmod: { args: [2, 2], run: pmod, help: "remainder that is never negative" },
  shiftleft: { args: [2, 2], run: (x, n) => shift(x, n, "left"), help: "x << n (64-bit)" },
  shiftright: { args: [2, 2], run: (x, n) => shift(x, n, "right"), help: "x >> n (64-bit, keeps the sign)" },
  shiftrightunsigned: { args: [2, 2], run: (x, n) => shift(x, n, "unsigned"), help: "x >>> n (64-bit)" },
  degrees: { args: [1, 1], run: (x) => (x * 180) / Math.PI, help: "radians to degrees (TODEGREES)" },
  todegrees: { args: [1, 1], run: (x) => (x * 180) / Math.PI, help: "radians to degrees" },
  radians: { args: [1, 1], run: (x) => (x * Math.PI) / 180, help: "degrees to radians (TORADIANS)" },
  toradians: { args: [1, 1], run: (x) => (x * Math.PI) / 180, help: "degrees to radians" },
  power: { args: [2, 2], run: Math.pow, help: "power(x, y) = x^y" },
  ceiling: { args: [1, 1], run: Math.ceil, help: "round up" },
  pi: { args: [0, 0], run: () => Math.PI, help: "π" },
  e: { args: [0, 0], run: () => Math.E, help: "Euler's number" },
};
// no prototype: names from data ("constructor", "toString"…) must not match inherited properties
Object.setPrototypeOf(FORMULA_FUNCTIONS, null);
export const FORMULA_CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
// no prototype: names from data ("constructor", "toString"…) must not match inherited properties
Object.setPrototypeOf(FORMULA_CONSTANTS, null);

export type FormulaToken = { kind: "num" | "name" | "op" | "end"; text: string; value?: number; pos: number };
type Token = FormulaToken;

/** The tokens of a formula (numbers, names, operators), as compileFormula and the DuckDB compiler read them. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ kind: "num", text: num[0], value: Number(num[0]), pos: i });
      i += num[0].length;
      continue;
    }
    if (ch === "`" || ch === "[") {
      // `column name` or [column name]
      const close = src.indexOf(ch === "`" ? "`" : "]", i + 1);
      if (close < 0) throw new Error(`Unclosed ${ch} at position ${i + 1}`);
      out.push({ kind: "name", text: src.slice(i + 1, close), pos: i });
      i = close + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (name) {
      out.push({ kind: "name", text: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    if ("+-*/%^(),×÷·−".includes(ch)) {
      const op = ch === "×" || ch === "·" ? "*" : ch === "÷" ? "/" : ch === "−" ? "-" : ch;
      out.push({ kind: "op", text: op, pos: i });
      i++;
      continue;
    }
    throw new Error(`Unexpected "${ch}" at position ${i + 1}`);
  }
  out.push({ kind: "end", text: "end of formula", pos: src.length });
  return out;
}

type Compiled = (r: Row) => Num;

/** Parses constants written as "A = 2, b = 0.5". */
export function parseConstants(text: string): Record<string, number> {
  // no prototype: a constant named "toString" or a formula naming one must not hit inherited properties
  const out: Record<string, number> = Object.create(null);
  for (const part of text.split(/[,;\n]/)) {
    if (!part.trim()) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(part);
    const value = m ? Number(m[2]) : NaN;
    if (!m || !Number.isFinite(value)) throw new Error(`Constants are written as name = number, e.g. "A = 2" (got "${part.trim()}")`);
    out[m[1]] = value;
  }
  return out;
}

/** Compiles a formula against a table's columns; precedence: ^ (right), unary -, * / % and implicit ×, + -. */
export function compileFormula(src: string, columns: Column[], constants: Record<string, number> = {}): Compiled {
  if (!src.trim()) throw new Error("Enter a formula");
  const tokens = tokenize(src);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const fail = (t: Token, what = `Unexpected "${t.text}"`) => {
    throw new Error(`${what} at position ${t.pos + 1}`);
  };
  const expect = (text: string) => {
    const t = next();
    if (t.text !== text || t.kind !== "op") fail(t, `Expected "${text}" but found "${t.text}"`);
  };
  const lift =
    (f: (...a: number[]) => number, parts: Compiled[]): Compiled =>
    (r) => {
      const vals: number[] = [];
      for (const p of parts) {
        const v = p(r);
        if (v === null) return null;
        vals.push(v);
      }
      const out = f(...vals);
      return Number.isFinite(out) ? out : null;
    };

  const variable = (t: Token): Compiled => {
    if (t.text in constants) {
      const v = constants[t.text];
      return () => v;
    }
    const col = columns.find((c) => c.name === t.text) ?? columns.find((c) => c.name.toLowerCase() === t.text.toLowerCase());
    if (col)
      return (r) => {
        const v = r[col.name];
        if (v === null || v === undefined || v === "") return null;
        const n = typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : Number(String(v).trim());
        return Number.isFinite(n) ? n : null;
      };
    const lower = t.text.toLowerCase();
    if (lower in FORMULA_CONSTANTS) {
      const v = FORMULA_CONSTANTS[lower];
      return () => v;
    }
    // e.g. "lnX" → ln(X), "Ax" → A*x
    const fn = Object.keys(FORMULA_FUNCTIONS).find((f) => lower.startsWith(f) && columns.some((c) => c.name === t.text.slice(f.length)));
    const hint = fn
      ? ` — did you mean ${fn}(${t.text.slice(fn.length)})?`
      : t.text.length > 1 && [...t.text].every((ch) => ch in constants || columns.some((c) => c.name === ch))
        ? ` — write ${[...t.text].join("*")} to multiply`
        : " — add it under Constants, or wrap a column name with spaces in `backticks`";
    return fail(t, `Unknown name "${t.text}"${hint}`);
  };

  const primary = (): Compiled => {
    const t = next();
    if (t.kind === "num") {
      const v = t.value!;
      return () => v;
    }
    if (t.kind === "op" && t.text === "(") {
      const inner = add();
      expect(")");
      return inner;
    }
    if (t.kind === "name") {
      if (t.text.toLowerCase() === "rand" && peek().text === "(" && !(t.text in constants) && !columns.some((c) => c.name === t.text)) {
        // one random number per row, in row order; a seed makes the sequence repeatable
        next();
        let seed: number | null = null;
        if (peek().text !== ")") {
          const negative = peek().text === "-" ? (next(), true) : false;
          const st = next();
          if (st.kind !== "num") fail(st, "rand() takes an optional number seed");
          seed = negative ? -st.value! : st.value!;
        }
        expect(")");
        const gen = seed === null ? Math.random : seeded(Math.trunc(seed));
        return () => gen();
      }
      const fn = FORMULA_FUNCTIONS[t.text.toLowerCase()];
      if (fn && peek().text === "(" && !(t.text in constants) && !columns.some((c) => c.name === t.text)) {
        next();
        const args: Compiled[] = [];
        if (peek().text !== ")") {
          args.push(add());
          while (peek().text === ",") {
            next();
            args.push(add());
          }
        }
        expect(")");
        if (args.length < fn.args[0] || args.length > fn.args[1])
          fail(t, `${t.text}() takes ${fn.args[0] === fn.args[1] ? fn.args[0] : `${fn.args[0]}–${fn.args[1]}`} argument${fn.args[1] > 1 ? "s" : ""}`);
        return lift(fn.run, args);
      }
      // "ln x" / "sqrt 2x" without parentheses: a one-argument function applies to the next power term
      const after = peek();
      if (fn && fn.args[0] === 1 && !(t.text in constants) && !columns.some((c) => c.name === t.text) && (after.kind === "num" || after.kind === "name"))
        return lift(fn.run, [power()]);
      return variable(t);
    }
    return fail(t);
  };

  const power = (): Compiled => {
    const base = primary();
    if (peek().text === "^") {
      next();
      return lift(Math.pow, [base, unary()]);
    }
    return base;
  };

  const unary = (): Compiled => {
    const t = peek();
    if (t.kind === "op" && (t.text === "-" || t.text === "+")) {
      next();
      const inner = unary();
      return t.text === "-" ? lift((x) => -x, [inner]) : inner;
    }
    return power();
  };

  const mul = (): Compiled => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t.kind === "op" && (t.text === "*" || t.text === "/" || t.text === "%")) {
        next();
        const right = unary();
        left = lift(t.text === "*" ? (a, b) => a * b : t.text === "/" ? (a, b) => a / b : (a, b) => a % b, [left, right]);
      } else if (t.kind === "num" || t.kind === "name" || (t.kind === "op" && t.text === "(")) {
        // implicit multiplication: 2x, 3(x + 1), A x
        left = lift((a, b) => a * b, [left, unary()]);
      } else return left;
    }
  };

  const add = (): Compiled => {
    let left = mul();
    for (;;) {
      const t = peek();
      if (t.kind !== "op" || (t.text !== "+" && t.text !== "-")) return left;
      next();
      const right = mul();
      left = lift(t.text === "+" ? (a, b) => a + b : (a, b) => a - b, [left, right]);
    }
  };

  const result = add();
  if (peek().kind !== "end") fail(peek());
  return result;
}


// arrays: JSON array text, or text split by a separator

export const ARRAY_FNS = [
  "Size",
  "Contains",
  "Position of",
  "Element at",
  "Join",
  "Distinct",
  "Sort",
  "Sort descending",
  "Reverse",
  "Slice",
  "Remove nulls",
  "Min",
  "Max",
  "Sum",
  "Mean",
  "Contains null",
  "Elements are distinct",
  "Add",
  "Remove",
  "Repeat",
  "Flatten",
] as const;
/** functions whose result is an array (kept as JSON text) */
const ARRAY_RESULT = new Set(["Distinct", "Sort", "Sort descending", "Reverse", "Slice", "Remove nulls", "Add", "Remove", "Repeat", "Flatten"]);

function readArray(v: Cell, sep: string): unknown[] | null {
  if (v === null) return null;
  if (sep) return v === "" ? [] : String(v).split(sep).map((x) => x.trim());
  if (typeof v !== "string") return [v];
  if (!v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error(`"${v.slice(0, 40)}" is not a JSON array — set a separator to split text`);
  }
}

const elementCell = (x: unknown): Cell => (x === undefined || x === null ? null : typeof x === "object" ? JSON.stringify(x) : (x as Cell));

function arrayResult(fn: string, xs: unknown[], p: Params): unknown {
  const cells = xs.map(elementCell);
  const target = str(p, "value");
  switch (fn) {
    case "Size":
      return xs.length;
    case "Contains":
      return cells.some((c) => c !== null && looseCompare(c, target) === 0);
    case "Position of": {
      const i = cells.findIndex((c) => c !== null && looseCompare(c, target) === 0);
      return i + 1;
    }
    case "Element at": {
      const i = Math.trunc(Number(str(p, "index") || 1));
      return i > 0 ? xs[i - 1] : i < 0 ? xs[xs.length + i] : undefined;
    }
    case "Join":
      return cells
        .filter((c) => c !== null)
        .map(String)
        .join(str(p, "joinWith") === "" ? ", " : str(p, "joinWith"));
    case "Distinct": {
      const seen = new Set<string>();
      return xs.filter((x) => {
        const k = cellKey(elementCell(x));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case "Sort":
      return [...xs].sort((a, b) => compareCells(elementCell(a), elementCell(b)));
    case "Sort descending":
      // nulls last, as SORT_ARRAY(x, false) puts them
      return [...xs].sort((a, b) => {
        const x = elementCell(a);
        const y = elementCell(b);
        return x === null || y === null ? compareCells(x, y) : compareCells(y, x);
      });
    case "Reverse":
      return [...xs].reverse();
    case "Slice": {
      const start = Math.trunc(Number(str(p, "index") || 1));
      const from = start > 0 ? start - 1 : Math.max(0, xs.length + start);
      const len = str(p, "length") === "" ? undefined : Math.trunc(Number(str(p, "length")));
      return xs.slice(from, len === undefined ? undefined : from + len);
    }
    case "Remove nulls":
      return xs.filter((x) => x !== null && x !== undefined);
    case "Contains null":
      return cells.some((c) => c === null);
    case "Elements are distinct":
      return new Set(cells.map(cellKey)).size === cells.length;
    case "Add": {
      // ARRAY_INSERT: position 1 is first; past the end appends; an empty position leaves the array as is
      if (str(p, "index") === "") return xs;
      const at = Math.max(1, Math.trunc(Number(str(p, "index"))));
      const v = target === "" ? null : Number.isFinite(Number(target)) && xs.every((x) => typeof x === "number" || x === null) ? Number(target) : target;
      return [...xs.slice(0, at - 1), v, ...xs.slice(at - 1)];
    }
    case "Remove":
      // ARRAY_REMOVE: every equal element; a null value removes the nulls
      return target === "" ? xs.filter((x) => x !== null && x !== undefined) : xs.filter((x) => elementCell(x) === null || looseCompare(elementCell(x), target) !== 0);
    case "Repeat": {
      const n = Math.trunc(Number(str(p, "index") || 1));
      return n > 0 ? Array.from({ length: n }, () => xs).flat(1) : [];
    }
    case "Flatten":
      return xs.flatMap((x) => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]));
    default:
      return aggregateValues(fn, cells, cells.length);
  }
}

// SQL

/** SQL tables the query mentions: `input` plus other nodes named in it. */
function sqlTables(t: Table, query: string, ctx?: StepContext): Record<string, Table> {
  const tables: Record<string, Table> = { input: t };
  const words = new Set(query.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
  for (const name of ctx?.names() ?? []) {
    if (name === "input" || !words.has(name) || tables[name]) continue;
    const table = ctx!.table(name);
    if (table) tables[name] = table;
  }
  // Palantir-style dataset paths in backticks, e.g. `/Project/raw/customers_raw (1)`: matched on the last segment
  for (const m of query.matchAll(/`([^`]+)`/g)) {
    const raw = m[1];
    if (tables[raw]) continue;
    const name = tableName(raw.split("/").filter(Boolean).pop() ?? raw);
    if (name === "input") tables[raw] = t;
    else if ((ctx?.names() ?? []).includes(name)) {
      const table = ctx!.table(name);
      if (table) tables[raw] = table;
    }
  }
  return tables;
}


// ---- Spark functions used by the steps below

const HASH_ALGORITHMS = ["SHA-256", "SHA-224", "SHA-384", "SHA-512", "SHA-1", "MD5", "CRC32", "Murmur3 (HASH)"] as const;

/** Spark HASH of one value by its column type (Murmur3, chained through `seed`; nulls leave it unchanged). Decimals hash as doubles. */
function sparkHash(v: Cell, type: ColType, seed: number): number {
  if (v === null) return seed;
  switch (type) {
    case "Boolean":
      return murmurInt(v === true ? 1 : 0, seed);
    case "Byte":
    case "Short":
    case "Integer":
      return murmurInt(Number(v), seed);
    case "Long":
      return Number.isFinite(Number(v)) ? murmurLong(BigInt(Math.trunc(Number(v))), seed) : seed;
    case "Float":
      return murmurInt(floatBits(Number(v)), seed);
    case "Double":
    case "Decimal":
      return murmurLong(doubleBits(Number(v)), seed);
    case "Date": {
      const d = toDate(v);
      return d ? murmurInt(Math.floor(d.getTime() / DAY), seed) : seed;
    }
    case "Timestamp": {
      const d = toDate(v);
      return d ? murmurLong(BigInt(d.getTime()) * 1000n, seed) : seed;
    }
    case "Binary":
      return murmurBytes(base64ToBytes(String(v)) ?? new Uint8Array(), seed);
    default:
      return murmurBytes(new TextEncoder().encode(String(v)), seed);
  }
}

/** "$.address.lines[0]" or "address.lines.0" → ["address", "lines", "0"]; "$" alone is the whole value. */
function jsonPath(path: string): string[] {
  return path
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[\s*['"]?([^\]'"]*)['"]?\s*\]/g, ".$1")
    .split(".")
    .filter((k) => k !== "");
}

const sqlLabel = (names: Record<string, string>) => (o: string) => (names[o] ? `${o} — ${names[o]}` : o);

export const STRING_FNS = [
  "ASCII code",
  "Base64 encode",
  "Base64 decode",
  "Hex",
  "Unhex",
  "Encode",
  "Decode",
  "Soundex",
  "Substring index",
  "Translate",
  "Format number",
  "Binary string",
  "Convert base",
  "Split to array",
  "Initial capitals",
] as const;
const STRING_FN_SQL: Record<string, string> = {
  "ASCII code": "ASCII",
  "Base64 encode": "BASE64",
  "Base64 decode": "UNBASE64",
  Hex: "HEX",
  Unhex: "UNHEX",
  Encode: "ENCODE",
  Decode: "DECODE",
  Soundex: "SOUNDEX",
  "Substring index": "SUBSTRING_INDEX",
  Translate: "TRANSLATE",
  "Format number": "FORMAT_NUMBER",
  "Binary string": "BIN",
  "Convert base": "CONV",
  "Split to array": "SPLIT",
  "Initial capitals": "INITCAP",
};

/** Bytes of a value: binary columns hold base64, everything else is text in the character set. */
const valueBytes = (v: Cell, type: ColType, charset = "UTF-8") =>
  type === "Binary" ? base64ToBytes(String(v)) : encodeText(String(castCell(v, "String")), charset);

function stringFn(fn: string, v: Cell, type: ColType, p: Params): Cell {
  if (v === null) return null;
  const text = () => String(castCell(v, "String"));
  switch (fn) {
    case "ASCII code":
      return text().length ? text().codePointAt(0)! : 0;
    case "Base64 encode": {
      const bytes = valueBytes(v, type);
      return bytes ? bytesToBase64(bytes) : null;
    }
    case "Base64 decode": {
      // the result is binary, kept as (normalised) base64
      const bytes = base64ToBytes(text().replace(/\s+/g, ""));
      return bytes ? bytesToBase64(bytes) : null;
    }
    case "Hex": {
      if ((INTEGRAL[type] && Number.isFinite(Number(v))) || (typeof v === "number" && Number.isInteger(v)))
        return BigInt.asUintN(64, BigInt(Math.trunc(Number(v)))).toString(16).toUpperCase();
      const bytes = valueBytes(v, type);
      return bytes ? toHex(bytes) : null;
    }
    case "Unhex": {
      const bytes = fromHex(text());
      return bytes ? bytesToBase64(bytes) : null;
    }
    case "Encode":
      return bytesToBase64(encodeText(text(), str(p, "charset") || "UTF-8"));
    case "Decode": {
      const bytes = type === "Binary" ? base64ToBytes(String(v)) : new TextEncoder().encode(text());
      return bytes ? decodeBytes(bytes, str(p, "charset") || "UTF-8") : null;
    }
    case "Soundex":
      return soundex(text());
    case "Substring index":
      return substringIndex(text(), str(p, "delimiter"), Math.trunc(Number(str(p, "count") || 1)));
    case "Translate":
      return translate(text(), str(p, "from"), str(p, "to"));
    case "Format number": {
      const n = toNumber(v);
      return n === null ? null : formatNumber(n, Math.trunc(Number(str(p, "decimals") || 0)));
    }
    case "Binary string":
      return convBase(String(Math.trunc(toNumber(v) ?? NaN)), 10, 2);
    case "Convert base":
      return convBase(text(), Math.trunc(Number(str(p, "fromBase") || 10)), Math.trunc(Number(str(p, "toBase") || 16)));
    case "Split to array": {
      let re: RegExp;
      try {
        re = new RegExp(str(p, "pattern") || ",");
      } catch {
        throw new Error(`Invalid regular expression "${str(p, "pattern")}"`);
      }
      return JSON.stringify(text().split(re));
    }
    case "Initial capitals":
      return text().toLowerCase().replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());
  }
  throw new Error(`Unknown string function "${fn}"`);
}

const STRING_FN_TYPE: Record<string, ColType> = {
  "ASCII code": "Integer",
  "Base64 decode": "Binary",
  Unhex: "Binary",
  Encode: "Binary",
};

export const LOGICAL_FNS = ["Is null", "Is not null", "Not", "Is NaN", "Replace NaN"] as const;
const LOGICAL_SQL: Record<string, string> = {
  "Is null": "ISNULL",
  "Is not null": "ISNOTNULL",
  Not: "NOT",
  "Is NaN": "ISNAN",
  "Replace NaN": "NANVL",
};
const isNaNCell = (v: Cell) => (typeof v === "number" && Number.isNaN(v)) || (typeof v === "string" && v.trim().toLowerCase() === "nan");

// ---- flatten struct: parse JSON text and spread its fields into columns

export const SCHEMA_TYPES = [...COL_TYPES, "Struct", "Array"] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];
export type SchemaField = { id: string; name: string; type: SchemaType; fields?: SchemaField[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A row's value for a column it may not have (e.g. union of different tables): null, never an inherited property. */
export const cellOf = (r: Row, name: string): Cell => (Object.prototype.hasOwnProperty.call(r, name) ? (r[name] ?? null) : null);

/** Sets a field as an own property: plain assignment of "__proto__" would change the object's prototype instead. */
export function setField(obj: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A field of parsed JSON (object key or array index); never an inherited property such as toString or constructor. */
export function ownField(v: unknown, key: string): unknown {
  return v !== null && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, key) ? (v as Record<string, unknown>)[key] : undefined;
}

/** Struct schema of sample JSON: one object, or a list of objects whose fields are merged. */
export function inferSchema(sample: unknown): SchemaField[] {
  const objects = (Array.isArray(sample) ? sample : [sample]).filter(isObject);
  if (!objects.length) throw new Error("Expected a JSON object");
  const values = new Map<string, unknown[]>();
  for (const o of objects)
    for (const [k, v] of Object.entries(o)) {
      if (!values.has(k)) values.set(k, []);
      values.get(k)!.push(v);
    }
  return [...values].map(([name, vals]) => {
    const present = vals.filter((v) => v !== null && v !== undefined);
    if (present.length && present.every(isObject)) return { id: uid(), name, type: "Struct", fields: inferSchema(present) };
    let type: SchemaType = "String";
    if (present.length && present.every(Array.isArray)) type = "Array";
    else if (present.length && present.every((v) => typeof v === "number"))
      type = numberType(present as number[]);
    else if (present.length && present.every((v) => typeof v === "boolean")) type = "Boolean";
    return { id: uid(), name, type };
  });
}

/** Struct schema from a JSON Schema document ({"type": "object", "properties": {...}}). */
export function fromJsonSchema(doc: unknown): SchemaField[] {
  const props = isObject(doc) ? doc.properties : undefined;
  if (!isObject(props)) throw new Error('Expected a JSON schema with "properties"');
  return Object.entries(props).map(([name, def]) => {
    const d = isObject(def) ? def : {};
    const t = Array.isArray(d.type) ? d.type.find((x) => x !== "null") : d.type;
    if (t === "object") return { id: uid(), name, type: "Struct", fields: isObject(d.properties) ? fromJsonSchema(d) : [] };
    const type: SchemaType =
      t === "integer"
        ? "Integer"
        : t === "number"
          ? "Double"
          : t === "boolean"
            ? "Boolean"
            : t === "array"
              ? "Array"
              : d.format === "date"
                ? "Date"
                : d.format === "date-time"
                  ? "Timestamp"
                  : "String";
    return { id: uid(), name, type };
  });
}

export function readSchema(p: Params): SchemaField[] {
  try {
    return cleanSchema(JSON.parse(str(p, "schema") || "[]"), "f");
  } catch {
    return [];
  }
}

/** Schema fields with a name, a known type and an id each (the editor keys rows by id). */
function cleanSchema(raw: unknown, prefix: string): SchemaField[] {
  if (!Array.isArray(raw)) return [];
  return uniqueIds(
    raw
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .map((f, i) => {
        const id = typeof f.id === "string" && f.id ? f.id : `${prefix}${i}`;
        const type = (SCHEMA_TYPES as readonly unknown[]).includes(f.type) ? (f.type as SchemaType) : "String";
        return { id, name: typeof f.name === "string" ? f.name : "", type, ...(type === "Struct" ? { fields: cleanSchema(f.fields, `${id}.`) } : {}) };
      }),
  );
}

type FlatTarget = { name: string; path: string[]; type: ColType };

/** The columns a flatten step writes: struct fields expanded down to max depth, joined with the separator. */
export function flattenTargets(p: Params): FlatTarget[] {
  const maxDepth = Math.max(1, Math.trunc(Number(str(p, "maxDepth") || 1)) || 1);
  const sep = p.separator === undefined ? "_" : str(p, "separator");
  const prefix = str(p, "prefix");
  const out: FlatTarget[] = [];
  const walk = (fields: SchemaField[], path: string[], depth: number) => {
    for (const f of fields) {
      const name = f.name.trim();
      if (!name) throw new Error("Every schema field needs a name");
      const fp = [...path, name];
      if (f.type === "Struct" && depth < maxDepth && f.fields?.length) walk(f.fields, fp, depth + 1);
      else
        out.push({
          name: (prefix ? [prefix, ...fp] : fp).join(sep),
          path: fp,
          // structs below max depth and arrays stay as JSON text
          type: f.type === "Struct" || f.type === "Array" ? "String" : f.type,
        });
    }
  };
  walk(readSchema(p), [], 1);
  return out;
}

function flatten(t: Table, p: Params): Table {
  const col = need(t, str(p, "column"));
  if (!readSchema(p).length) throw new Error("Add at least one schema field");
  const targets = flattenTargets(p);
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.name)) throw new Error(`Two fields would both be named "${target.name}" — change the separator or prefix`);
    seen.add(target.name);
  }
  const parsed = t.rows.map((r) => {
    const v = r[col.name];
    if (typeof v !== "string" || !v.trim()) return null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  });
  let out = t;
  for (const target of targets) {
    let i = 0;
    out = setColumn(out, target.name, target.type, () => {
      let v: unknown = parsed[i++];
      for (const k of target.path) v = ownField(v, k);
      if (v === undefined || v === null) return null;
      if (typeof v === "object") return JSON.stringify(v);
      return castCell(v as Cell, target.type);
    });
  }
  if (str(p, "drop") === "true" && !seen.has(col.name)) {
    const columns = out.columns.filter((c) => c.name !== col.name);
    out = {
      columns,
      rows: out.rows.map((r) => Object.fromEntries(columns.map((c) => [c.name, r[c.name] ?? null]))),
    };
  }
  return out;
}

// ---- validation expressions (Is valid IPv4, H3 index, MGRS…)

export const VALIDATORS = [
  "Is valid IPv4",
  "Is valid IPv6",
  "Is valid uuid",
  "Is valid rid",
  "Is valid MIME type",
  "Is valid Geohash",
  "Is valid H3 index",
  "Is valid MGRS",
  "Is valid Ontology GeoPoint",
  "Is valid GeoJSON",
  "Is valid media reference",
  "Is valid delegated media gid",
] as const;
export type Validator = (typeof VALIDATORS)[number];

const IPV4_PART = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_PART}(\\.${IPV4_PART}){3}$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RID = /^ri\.[a-z][a-z0-9-]*\.[a-z0-9-]*\.[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$/;
const MIME_TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
const MIME = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}(\\s*;\\s*${MIME_TOKEN}=("[^"]*"|[^;\\s]+))*$`);
const GEOHASH_RE = /^[0-9b-hjkmnp-z]{1,12}$/i;
const DELEGATED_GID = /^ri\.gotham-delegated-media\.[A-Za-z0-9-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;
const GEOJSON_TYPES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection", "Feature", "FeatureCollection"]);

function isIPv6(v: string): boolean {
  if (!v.includes(":") || /[^0-9a-fA-F:.]/.test(v)) return false;
  const [head, ...more] = v.split("::");
  if (more.length > 1) return false;
  const groups = (s: string) => (s ? s.split(":") : []);
  const parts = [...groups(head), ...groups(more[0] ?? "")];
  // an IPv4 tail (::ffff:10.0.0.1) counts as two groups
  const last = parts[parts.length - 1] ?? "";
  const v4 = last.includes(".");
  if (v4 && !IPV4.test(last)) return false;
  const hex = v4 ? parts.slice(0, -1) : parts;
  if (!hex.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const n = hex.length + (v4 ? 2 : 0);
  return more.length ? n < 8 : n === 8;
}

/** An H3 cell index: 15 hex digits, mode 1, resolution 0–15, base cell < 122, unused digits 7. */
function isH3(v: string): boolean {
  if (!/^[0-9a-f]{15,16}$/i.test(v)) return false;
  const h = BigInt(`0x${v}`);
  if (h >> 63n) return false;
  if (((h >> 59n) & 0xfn) !== 1n) return false;
  const res = Number((h >> 52n) & 0xfn);
  if (Number((h >> 45n) & 0x7fn) >= 122) return false;
  for (let r = 1; r <= 15; r++) {
    const digit = Number((h >> BigInt((15 - r) * 3)) & 7n);
    if (r <= res ? digit === 7 : digit !== 7) return false;
  }
  return true;
}

/** MGRS: zone 1–60 + latitude band + 100 km square + an even number of digits (easting and northing), or polar UPS. */
function isMgrs(v: string): boolean {
  const parts = v.trim().toUpperCase().split(/\s+/);
  const joined = parts.join("");
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z]{2})(\d*)$/.exec(joined) ?? /^()([ABYZ])([A-HJ-NP-Z]{2})(\d*)$/.exec(joined);
  if (!m) return false;
  if (m[1] && (Number(m[1]) < 1 || Number(m[1]) > 60)) return false;
  const digits = m[4];
  if (!digits.length || digits.length % 2 || digits.length > 10) return false;
  // with spaces the easting and northing are separate groups of the same length
  if (parts.length > 1) {
    const nums = parts.filter((x) => /^\d+$/.test(x));
    if (nums.length === 2 && nums[0].length !== nums[1].length) return false;
    if (nums.length === 1 && parts.length > 2) return false;
  }
  return true;
}

function isGeoPoint(v: string): boolean {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
  if (!m) return false;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function parseJsonObject(v: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(v);
    return isObject(o) ? o : null;
  } catch {
    return null;
  }
}

function isMediaReference(v: string): boolean {
  const o = parseJsonObject(v);
  const ref = o && isObject(o.reference) ? o.reference : null;
  if (!o || typeof o.mimeType !== "string" || !ref || typeof ref.type !== "string") return false;
  const body = ref[ref.type];
  if (!isObject(body)) return false;
  if (ref.type === "mediaSetItem" || ref.type === "mediaSetViewItem") return typeof body.mediaSetRid === "string" && typeof body.mediaItemRid === "string";
  if (ref.type === "datasetFile") {
    const f = isObject(body.fileReference) ? body.fileReference : null;
    return !!f && typeof f.datasetRid === "string" && typeof f.logicalFilePath === "string";
  }
  return false;
}

export function isValidValue(fn: Validator, v: string): boolean {
  switch (fn) {
    case "Is valid IPv4":
      return IPV4.test(v);
    case "Is valid IPv6":
      return isIPv6(v);
    case "Is valid uuid":
      return UUID.test(v);
    case "Is valid rid":
      return RID.test(v);
    case "Is valid MIME type":
      return MIME.test(v.trim());
    case "Is valid Geohash":
      return GEOHASH_RE.test(v);
    case "Is valid H3 index":
      return isH3(v);
    case "Is valid MGRS":
      return isMgrs(v);
    case "Is valid Ontology GeoPoint":
      return isGeoPoint(v);
    case "Is valid GeoJSON": {
      const o = parseJsonObject(v);
      return !!o && typeof o.type === "string" && GEOJSON_TYPES.has(o.type) && (o.type === "GeometryCollection" ? Array.isArray(o.geometries) : o.type.startsWith("Feature") || Array.isArray(o.coordinates));
    }
    case "Is valid media reference":
      return isMediaReference(v);
    case "Is valid delegated media gid":
      return DELEGATED_GID.test(v);
  }
}

// ---- array element conditions (All array elements satisfy / Any array element satisfy)

export const ELEMENT_OPS = ["<", "<=", "=", "!=", ">", ">=", "is null", "is not null", "is true", "contains", "starts with"] as const;
const ELEMENT_UNARY: ReadonlySet<string> = new Set(["is null", "is not null", "is true"]);

function elementTest(op: string, x: Cell, right: Cell): boolean {
  if (op === "is null") return x === null;
  if (op === "is not null") return x !== null;
  if (op === "is true") return castCell(x, "Boolean") === true;
  if (x === null || right === null) return false;
  if (op === "contains") return String(x).toLowerCase().includes(String(right).toLowerCase());
  if (op === "starts with") return String(x).toLowerCase().startsWith(String(right).toLowerCase());
  const c = looseCompare(x, right);
  return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === "=" ? c === 0 : op === "!=" ? c !== 0 : op === ">" ? c > 0 : c >= 0;
}

/** Is empty struct: every field null, recursively (an array of nulls and a map of null values are empty too). */
function isEmptyDeep(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.every(isEmptyDeep);
  if (isObject(v)) return Object.values(v).every(isEmptyDeep);
  return false;
}

// ---- unstructured datasets: extract rows from raw files

export function filesTable(files: DataFile[]): Table {
  return {
    columns: [
      { name: "path", type: "String" },
      { name: "size", type: "Integer" },
    ],
    rows: files.map((f) => ({ path: f.path, size: f.size })),
    files,
  };
}

/** A file's bytes: base64 files decoded, text files as UTF-8. */
function fileBytes(f: DataFile): Uint8Array {
  if (f.encoding === "base64") {
    const b = base64ToBytes(f.text);
    if (!b) throw new Error(`${f.path}: not valid base64`);
    return b;
  }
  return new TextEncoder().encode(f.text);
}

/** A file from bytes: text when they are valid UTF-8, else base64. */
function bytesFile(path: string, bytes: Uint8Array): DataFile {
  try {
    return { path, size: bytes.length, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { path, size: bytes.length, text: bytesToBase64(bytes), encoding: "base64" };
  }
}

function gunzipFile(f: DataFile): DataFile {
  try {
    return bytesFile(f.path.replace(/\.gz$/i, ""), gunzipSync(fileBytes(f)));
  } catch (e) {
    throw new Error(`${f.path}: not a gzip file (${(e as Error).message})`);
  }
}

/** The regular files of a tar archive (ustar / GNU long names; .tar.gz and .tgz are gunzipped first). */
function untarFile(f: DataFile): DataFile[] {
  let bytes = fileBytes(f);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const base = f.path.replace(/\.(tar\.gz|tgz|tar)$/i, "");
  const text = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
  const out: DataFile[] = [];
  let longName: string | null = null;
  for (let off = 0; off + 512 <= bytes.length; ) {
    const h = bytes.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(text(h.subarray(124, 136)).trim() || "0", 8);
    if (Number.isNaN(size)) throw new Error(`${f.path}: not a tar archive`);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = text(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
    const body = bytes.subarray(off + 512, off + 512 + size);
    longName = null;
    if (type === "L") longName = text(body);
    else if (type === "0" || type === "7") out.push(bytesFile(`${base}/${name.replace(/^\.\//, "")}`, body.slice()));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** The columns Filter files conditions are written over. */
export const FILE_FILTER_COLUMNS: Column[] = [
  { name: "file_path", type: "String" },
  { name: "file_name", type: "String" },
  { name: "extension", type: "String" },
  { name: "size_bytes", type: "Long" },
];

function fileListingRow(f: DataFile): Row {
  const name = f.path.split("/").pop() ?? f.path;
  return { file_path: f.path, file_name: name, extension: name.includes(".") ? name.split(".").pop()!.toLowerCase() : null, size_bytes: f.size };
}

function inputFiles(t: Table): DataFile[] {
  if (!t.files) throw new Error("This step reads a dataset of files — upload the files as an unstructured dataset");
  if (!t.files.length) throw new Error("The dataset has no files");
  return t.files;
}

/** Records from JSON files: one record per line (JSON Lines), or whole files when values span lines. */
export function readJsonRecords(files: DataFile[], multiline: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (v: unknown) => {
    for (const item of Array.isArray(v) ? v : [v]) out.push(isObject(item) ? item : { value: item });
  };
  for (const f of files) {
    if (multiline) {
      try {
        add(JSON.parse(f.text.replace(/^\uFEFF/, "")));
      } catch {
        throw new Error(`${f.path} is not valid JSON — turn off "Allow JSON values to span multiple lines" for JSON Lines`);
      }
      continue;
    }
    f.text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!line.trim()) return;
        try {
          add(JSON.parse(line));
        } catch {
          throw new Error(`${f.path} line ${i + 1} is not valid JSON — turn on "Allow JSON values to span multiple lines" if records span lines`);
        }
      });
  }
  return out;
}

/** Records to a table: typed by the schema when there is one, inferred otherwise. */
function recordsToTable(records: Record<string, unknown>[], schema: SchemaField[]): Table {
  if (!schema.length) return records.length ? fromRecords(records) : { columns: [], rows: [] };
  const seen = new Set<string>();
  const columns = schema.map((f): Column => {
    const name = f.name.trim();
    if (!name) throw new Error("Every schema field needs a name");
    if (seen.has(name)) throw new Error(`Two schema fields are named "${name}"`);
    seen.add(name);
    return { name, type: f.type === "Struct" || f.type === "Array" ? "String" : f.type };
  });
  return {
    columns,
    rows: records.map((r) =>
      Object.fromEntries(
        columns.map((c, i) => {
          const v = ownField(r, schema[i].name) ?? ownField(r, c.name);
          if (v === undefined || v === null) return [c.name, null];
          return [c.name, typeof v === "object" ? JSON.stringify(v) : castCell(v as Cell, c.type)];
        }),
      ),
    ),
  };
}

function withPath(t: Table, paths: string[], on: boolean): Table {
  if (!on) return t;
  let i = 0;
  return setColumn(t, "file_path", "String", () => paths[i++]);
}

function extractJson(t: Table, p: Params): Table {
  const files = inputFiles(t);
  const multiline = str(p, "multiline") === "true";
  const paths: string[] = [];
  const records: Record<string, unknown>[] = [];
  for (const f of files) {
    // loops, not push(...rs): spreading a large file's records overflows the call stack
    for (const r of readJsonRecords([f], multiline)) {
      records.push(r);
      paths.push(f.path);
    }
  }
  return withPath(recordsToTable(records, readSchema(p)), paths, str(p, "includePath") === "true");
}

function extractCsv(t: Table, p: Params): Table {
  const files = inputFiles(t);
  return union(
    files.map((f) => {
      const table = parseCsv(f.text);
      return withPath(table, table.rows.map(() => f.path), str(p, "includePath") === "true");
    }),
  );
}

// ---- SQL building blocks: aggregate functions, ORDER BY keys, dates, hashing

export const AGG_FNS = [
  "Count",
  "Count distinct",
  "Sum",
  "Mean",
  "Min",
  "Max",
  "Median",
  "Approximate median",
  "Percentile",
  "Std dev",
  "Variance",
  "First",
  "Last",
  "Collect list",
  "Collect set",
  "Mode",
  "Any true",
  "All true",
  "Array agg",
  "Approx count distinct",
  "Std dev (population)",
  "Variance (population)",
  "Skewness",
  "Kurtosis",
  "Correlation",
  "Covariance (sample)",
  "Covariance (population)",
] as const;
export type AggFn = (typeof AGG_FNS)[number];
/** Spark SQL name of each aggregation */
export const AGG_SQL: Record<AggFn, string> = {
  Count: "COUNT",
  "Count distinct": "COUNT(DISTINCT)",
  Sum: "SUM",
  Mean: "AVG / MEAN",
  Min: "MIN",
  Max: "MAX",
  Median: "MEDIAN",
  "Approximate median": "PERCENTILE_APPROX",
  Percentile: "PERCENTILE",
  "Std dev": "STDDEV / STDDEV_SAMP",
  Variance: "VARIANCE / VAR_SAMP",
  First: "FIRST",
  Last: "LAST",
  "Collect list": "COLLECT_LIST joined",
  "Collect set": "COLLECT_SET joined",
  Mode: "MODE",
  "Any true": "BOOL_OR",
  "All true": "BOOL_AND",
  "Array agg": "COLLECT_LIST",
  "Approx count distinct": "APPROX_COUNT_DISTINCT",
  "Std dev (population)": "STDDEV_POP",
  "Variance (population)": "VAR_POP",
  Skewness: "SKEWNESS",
  Kurtosis: "KURTOSIS",
  Correlation: "CORR",
  "Covariance (sample)": "COVAR_SAMP",
  "Covariance (population)": "COVAR_POP",
};
/** aggregations over two columns; the second is in `arg` */
export const PAIR_AGGS: ReadonlySet<string> = new Set(["Correlation", "Covariance (sample)", "Covariance (population)"]);
/** aggregate functions that take an extra argument, and what it is */
export const AGG_ARG: Partial<Record<AggFn, string>> = {
  Correlation: "second column",
  "Covariance (sample)": "second column",
  "Covariance (population)": "second column",
  Percentile: "percentile, 0–100",
  "Collect list": 'separator (default ", ")',
  "Collect set": 'separator (default ", ")',
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function aggType(fn: string, col?: Column | null): ColType {
  if (fn === "Count" || fn === "Count distinct" || fn === "Approx count distinct") return "Integer";
  if (fn === "Min" || fn === "Max" || fn === "First" || fn === "Last" || fn === "Mode") return col?.type ?? "String";
  if (fn === "Any true" || fn === "All true") return "Boolean";
  if (fn === "Collect list" || fn === "Collect set" || fn === "Array agg") return "String";
  return "Double";
}

/** One aggregate over a group's values (null for COUNT(*)), ignoring nulls like SQL. */
export function aggregateValues(fn: string, values: Cell[] | null, rowCount: number, arg = ""): Cell {
  const v = aggregateRaw(fn, values, rowCount, arg);
  // overflow on extreme values (e.g. variance near 1e308) is null, never ±∞ or NaN
  return typeof v === "number" && !Number.isFinite(v) ? null : v;
}

function aggregateRaw(fn: string, values: Cell[] | null, rowCount: number, arg = ""): Cell {
  if (fn === "Count") return values ? values.filter((v) => !isEmpty(v)).length : rowCount;
  if (!values) throw new Error(`${fn} needs a column`);
  const vals = values.filter((v) => !isEmpty(v));
  const nums = () => vals.map(toNumber).filter((n): n is number => n !== null);
  if (PAIR_AGGS.has(fn)) throw new Error(`${fn} needs two columns — use it in an Aggregate step`);
  switch (fn) {
    case "Count distinct":
    case "Approx count distinct":
      // exact; Spark's approximation is within 5%
      return new Set(vals.map(cellKey)).size;
    case "Std dev (population)":
    case "Variance (population)": {
      const n = nums();
      if (!n.length) return null;
      const mean = n.reduce((a, b) => a + b, 0) / n.length;
      const variance = n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length;
      return fn === "Variance (population)" ? variance : Math.sqrt(variance);
    }
    case "Skewness":
      return skewness(nums());
    case "Kurtosis":
      return kurtosis(nums());
    case "Sum": {
      const n = nums();
      return n.length ? n.reduce((a, b) => a + b, 0) : null;
    }
    case "Mean": {
      const n = nums();
      return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
    }
    case "Median":
    case "Approximate median":
    case "Percentile": {
      // Approximate median is exact here (Spark's approximation is within its accuracy bound)
      const p = fn === "Percentile" ? Number(arg) : 50;
      if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error("Percentile must be a number from 0 to 100");
      const n = nums().sort((a, b) => a - b);
      if (!n.length) return null;
      const rank = (p / 100) * (n.length - 1);
      const lo = Math.floor(rank);
      return n[lo] + (n[Math.ceil(rank)] - n[lo]) * (rank - lo);
    }
    case "Std dev":
    case "Variance": {
      const n = nums();
      if (n.length < 2) return null;
      const mean = n.reduce((a, b) => a + b, 0) / n.length;
      const variance = n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1);
      return fn === "Variance" ? variance : Math.sqrt(variance);
    }
    case "Min":
    case "Max": {
      if (!vals.length) return null;
      const sorted = [...vals].sort(compareCells);
      return sorted[fn === "Min" ? 0 : sorted.length - 1];
    }
    case "Mode": {
      // most frequent value; ties go to the one seen first
      const counts = new Map<string, [Cell, number]>();
      for (const v of vals) {
        const e = counts.get(cellKey(v));
        if (e) e[1]++;
        else counts.set(cellKey(v), [v, 1]);
      }
      let best: [Cell, number] | null = null;
      for (const e of counts.values()) if (!best || e[1] > best[1]) best = e;
      return best ? best[0] : null;
    }
    case "Any true":
    case "All true": {
      const bools = vals.map((v) => castCell(v, "Boolean")).filter((b): b is boolean => typeof b === "boolean");
      if (!bools.length) return null;
      return fn === "Any true" ? bools.some(Boolean) : bools.every(Boolean);
    }
    case "First":
      return vals[0] ?? null;
    case "Last":
      return vals[vals.length - 1] ?? null;
    case "Array agg":
      return JSON.stringify(vals);
    case "Collect list":
    case "Collect set": {
      const items = vals.map((v) => String(castCell(v, "String")));
      return (fn === "Collect set" ? [...new Set(items)] : items).join(arg === "" ? ", " : arg);
    }
  }
  throw new Error(`Unknown aggregation "${fn}"`);
}

/** `where` filters the rows of each group first, as in COUNT(*) FILTER (WHERE …) */
export type AggSpec = { id: string; fn: AggFn; column: string; arg?: string; output?: string; where?: ConditionGroup };

export const aggOutput = (a: AggSpec) => a.output?.trim() || (a.column ? `${slug(a.fn)}_${a.column}` : "count");

/** The aggregations of an Aggregate step (older steps store a single fn / column / output). */
export function readAggs(p: Params): AggSpec[] {
  const raw = str(p, "aggs");
  if (raw) {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a))
        return uniqueIds(a
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x, i) => ({
            id: typeof x.id === "string" && x.id ? x.id : `a${i}`,
            fn: (AGG_FNS as readonly unknown[]).includes(x.fn) ? (x.fn as AggFn) : "Count",
            column: typeof x.column === "string" ? x.column : "",
            ...(typeof x.arg === "string" ? { arg: x.arg } : {}),
            ...(typeof x.output === "string" ? { output: x.output } : {}),
            ...(x.where ? { where: cleanGroup(x.where, `a${i}.w`) ?? undefined } : {}),
          })));
    } catch {}
  }
  return [{ id: "a0", fn: (str(p, "fn") || "Count") as AggFn, column: str(p, "column"), output: str(p, "output") }];
}

export type SortKey = { column: string; direction: "asc" | "desc"; nulls?: "first" | "last" };

/** ORDER BY keys stored as JSON under `key` (the Sort step also reads its older column / direction). */
export function readSortKeys(p: Params, key: string): SortKey[] {
  const raw = str(p, key);
  if (raw) {
    try {
      const k = JSON.parse(raw);
      if (Array.isArray(k)) return k.filter((x) => x && x.column);
    } catch {}
  }
  if (key === "sort" && str(p, "column"))
    return [{ column: str(p, "column"), direction: str(p, "direction") === "Descending" ? "desc" : "asc" }];
  return [];
}

function rowComparator(t: Table, keys: SortKey[]): (a: Row, b: Row) => number {
  const cols = keys.map((k) => ({ name: need(t, k.column).name, dir: k.direction === "desc" ? -1 : 1, nullsFirst: k.nulls === "first" }));
  return (a, b) => {
    for (const c of cols) {
      const av = a[c.name] ?? null;
      const bv = b[c.name] ?? null;
      const an = isEmpty(av);
      const bn = isEmpty(bv);
      if (an || bn) {
        if (an && bn) continue;
        return (an ? -1 : 1) * (c.nullsFirst ? 1 : -1);
      }
      const cmp = compareCells(av, bv);
      if (cmp) return c.dir * cmp;
    }
    return 0;
  };
}

const describeSort = (keys: SortKey[]) =>
  keys.map((k) => `${k.column} ${k.direction}${k.nulls === "first" ? " nulls first" : ""}`).join(", ");

// dates: Date columns hold "yyyy-MM-dd", Timestamp columns ISO instants (UTC)

const DAY = 86400000;
const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, "0");
export const isoDate = (d: Date) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Shifts an instant so its UTC fields read as the wall clock in `zone` (UTC when empty). */
export function wallClock(d: Date, zone: string): Date {
  return zone && zone !== "UTC" ? new Date(d.getTime() + zoneOffset(zone, d.getTime()) * 60000) : d;
}

/** Inverse of wallClock. */
export function fromWallClock(w: Date, zone: string): Date {
  const parts = {
    y: w.getUTCFullYear(),
    mo: w.getUTCMonth() + 1,
    d: w.getUTCDate(),
    h: w.getUTCHours(),
    mi: w.getUTCMinutes(),
    s: w.getUTCSeconds(),
    ms: w.getUTCMilliseconds(),
  };
  return new Date(partsToUtc(parts, zone));
}

export const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const out = new Date(d);
  out.setUTCFullYear(ty, tm, Math.min(d.getUTCDate(), daysInMonth(ty, tm)));
  return out;
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Formats a wall-clock date with Java DateTimeFormatter letters (y M d E H h m s S a Z X, 'text'). */
export function formatDate(w: Date, pattern: string, offsetMinutes = 0): string {
  let out = "";
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i];
    if (ch === "'") {
      const close = pattern.indexOf("'", i + 1);
      if (close === i + 1) {
        out += "'";
        i += 2;
        continue;
      }
      if (close < 0) throw new Error(`Unclosed quote in "${pattern}"`);
      out += pattern.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    i += n;
    const h = w.getUTCHours();
    switch (ch) {
      case "y":
      case "u":
        out += n === 2 ? pad(w.getUTCFullYear() % 100) : pad(w.getUTCFullYear(), Math.max(4, n));
        break;
      case "M":
      case "L":
        out +=
          n >= 4
            ? MONTH_NAMES[w.getUTCMonth()]
            : n === 3
              ? MONTH_NAMES[w.getUTCMonth()].slice(0, 3)
              : pad(w.getUTCMonth() + 1, n);
        break;
      case "d":
        out += pad(w.getUTCDate(), n);
        break;
      case "D":
        out += pad((Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - Date.UTC(w.getUTCFullYear(), 0, 1)) / DAY + 1, n);
        break;
      case "E":
        out += n >= 4 ? DAY_NAMES[w.getUTCDay()] : DAY_NAMES[w.getUTCDay()].slice(0, 3);
        break;
      case "H":
        out += pad(h, n);
        break;
      case "h":
        out += pad(h % 12 || 12, n);
        break;
      case "m":
        out += pad(w.getUTCMinutes(), n);
        break;
      case "s":
        out += pad(w.getUTCSeconds(), n);
        break;
      case "S":
        out += pad(w.getUTCMilliseconds(), 3).padEnd(n, "0").slice(0, n);
        break;
      case "a":
        out += h < 12 ? "AM" : "PM";
        break;
      case "Z":
      case "X":
      case "x": {
        if (ch === "X" && offsetMinutes === 0) {
          out += "Z";
          break;
        }
        const sign = offsetMinutes < 0 ? "-" : "+";
        const hh = pad(Math.abs(offsetMinutes) / 60);
        const mm = pad(Math.abs(offsetMinutes) % 60);
        out += n >= 3 || ch === "Z" ? (n >= 3 ? `${sign}${hh}:${mm}` : `${sign}${hh}${mm}`) : `${sign}${hh}${n === 2 ? mm : ""}`;
        break;
      }
      default:
        throw new Error(`Unsupported format letter "${ch}" in "${pattern}" — quote literal text with '…'`);
    }
  }
  return out;
}

const DATE_UNITS = ["Years", "Quarters", "Months", "Weeks", "Days", "Hours", "Minutes", "Seconds"] as const;
const SUB_DAY = new Set(["Hours", "Minutes", "Seconds", "Hour", "Minute", "Second"]);

/** Output of a date operation: a Date column stays a date for day-level units, else a timestamp. */
const dateOut = (input: ColType, unit: string): ColType => (input === "Date" && !SUB_DAY.has(unit) ? "Date" : "Timestamp");
const writeDate = (d: Date, type: ColType): Cell => (Number.isNaN(d.getTime()) ? null : type === "Date" ? isoDate(d) : d.toISOString());

function addToDate(d: Date, amount: number, unit: string): Date {
  switch (unit) {
    case "Years":
      return addMonths(d, amount * 12);
    case "Quarters":
      return addMonths(d, amount * 3);
    case "Months":
      return addMonths(d, amount);
    case "Weeks":
      return new Date(d.getTime() + amount * 7 * DAY);
    case "Days":
      return new Date(d.getTime() + amount * DAY);
    case "Hours":
      return new Date(d.getTime() + amount * 3600000);
    case "Minutes":
      return new Date(d.getTime() + amount * 60000);
    default:
      return new Date(d.getTime() + amount * 1000);
  }
}

/** Whole units from start to end, truncated toward zero (months count calendar months). */
function dateDiff(end: Date, start: Date, unit: string): number {
  if (unit === "Months" || unit === "Quarters" || unit === "Years") {
    let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
    const endRest = end.getTime() - addMonths(start, months).getTime();
    if (months > 0 && endRest < 0) months--;
    if (months < 0 && endRest > 0) months++;
    return Math.trunc(months / (unit === "Years" ? 12 : unit === "Quarters" ? 3 : 1));
  }
  const ms = { Weeks: 7 * DAY, Days: DAY, Hours: 3600000, Minutes: 60000, Seconds: 1000 }[unit] ?? DAY;
  return Math.trunc((end.getTime() - start.getTime()) / ms);
}

/** Units of Date difference: DATE_UNITS plus Spark's MONTHS_BETWEEN */
const DIFF_UNITS = [...DATE_UNITS, "Months (fractional)"] as const;

/** Spark MONTHS_BETWEEN(a, b): whole months when the days match or both are month ends; else a 31-day-month fraction, 8 decimals. */
export function monthsBetween(a: Date, b: Date): number {
  const months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + a.getUTCMonth() - b.getUTCMonth();
  const da = a.getUTCDate();
  const db = b.getUTCDate();
  const lastA = da === daysInMonth(a.getUTCFullYear(), a.getUTCMonth());
  const lastB = db === daysInMonth(b.getUTCFullYear(), b.getUTCMonth());
  if (da === db || (lastA && lastB)) return months;
  const secondsOfDay = (d: Date) => (((d.getTime() % DAY) + DAY) % DAY) / 1000;
  const seconds = (da - db) * 86400 + secondsOfDay(a) - secondsOfDay(b);
  return Math.round((months + seconds / (31 * 86400)) * 1e8) / 1e8;
}

const WEEKDAYS: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
// no prototype: names from data ("constructor", "toString"…) must not match inherited properties
Object.setPrototypeOf(WEEKDAYS, null);

const TRUNC_UNITS = ["Year", "Quarter", "Month", "Week", "Day", "Hour", "Minute"] as const;

export function truncDate(w: Date, unit: string): Date {
  const y = w.getUTCFullYear();
  const m = w.getUTCMonth();
  switch (unit) {
    case "Year":
      return new Date(Date.UTC(y, 0, 1));
    case "Quarter":
      return new Date(Date.UTC(y, m - (m % 3), 1));
    case "Month":
      return new Date(Date.UTC(y, m, 1));
    case "Week": {
      // ISO weeks start on Monday
      const day = (w.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, m, w.getUTCDate() - day));
    }
    case "Day":
      return new Date(Date.UTC(y, m, w.getUTCDate()));
    case "Hour":
      return new Date(Date.UTC(y, m, w.getUTCDate(), w.getUTCHours()));
    default:
      return new Date(Date.UTC(y, m, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes()));
  }
}

const DATE_PARTS = [
  "Year",
  "Quarter",
  "Month",
  "Week of year",
  "Day",
  "Day of week (1 = Monday)",
  "Day of year",
  "Hour",
  "Minute",
  "Second",
  "Epoch seconds",
  "Month name",
  "Day name",
] as const;

function datePart(d: Date, w: Date, part: string): Cell {
  switch (part) {
    case "Year":
      return w.getUTCFullYear();
    case "Quarter":
      return Math.floor(w.getUTCMonth() / 3) + 1;
    case "Month":
      return w.getUTCMonth() + 1;
    case "Week of year":
      return isoWeek(w);
    case "Day":
      return w.getUTCDate();
    case "Day of week (1 = Monday)":
      return w.getUTCDay() || 7;
    case "Day of year":
      return (Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - Date.UTC(w.getUTCFullYear(), 0, 1)) / DAY + 1;
    case "Hour":
      return w.getUTCHours();
    case "Minute":
      return w.getUTCMinutes();
    case "Second":
      return w.getUTCSeconds();
    case "Epoch seconds":
      return Math.floor(d.getTime() / 1000);
    case "Month name":
      return MONTH_NAMES[w.getUTCMonth()];
    default:
      return DAY_NAMES[w.getUTCDay()];
  }
}

/** A column name or a number, resolved per row. */
function columnOrNumber(t: Table, text: string, what: string): (r: Row) => number | null {
  const col = t.columns.find((c) => c.name === text.trim());
  if (col) return (r) => toNumber(r[col.name] ?? null);
  const n = toNumber(text);
  if (n === null) throw new Error(`${what} must be a number or a column name`);
  return () => n;
}

/** Deterministic random numbers in [0, 1) for a seed. */
function seeded(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// CASE WHEN

export type CaseBranch = { id: string; when: ConditionGroup; then: Operand };
export type CaseSpec = { cases: CaseBranch[]; else: Operand };
export const CASE_TYPES = ["Auto", ...COL_TYPES] as const;

export function readCases(p: Params): CaseSpec {
  try {
    const spec = JSON.parse(str(p, "cases") || "null");
    if (spec && Array.isArray(spec.cases)) {
      const operand = (o: unknown) => cleanGroup({ items: [{ left: o, op: "is null" }] }, "x")?.items[0] as Condition | undefined;
      return {
        cases: uniqueIds(
          spec.cases
            .filter((b: unknown) => !!b && typeof b === "object")
            .map((b: Record<string, unknown>, i: number) => ({
              id: typeof b.id === "string" && b.id ? b.id : `b${i}`,
              when: cleanGroup(b.when, `b${i}.w`) ?? { id: `b${i}.w`, match: "all" as const, items: [] },
              then: operand(b.then)?.left ?? null,
            })),
        ),
        else: operand(spec.else)?.left ?? null,
      };
    }
  } catch {}
  return {
    cases: [{ id: "b0", when: { id: "w0", match: "all", items: [{ id: "c0", left: null, op: "is equal to", right: null }] }, then: null }],
    else: null,
  };
}

/** Edit distance between two character lists. */
export function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// window functions

/** Position of a value on a range frame's axis: numbers as-is, dates and timestamps in days. */
function rangeValue(v: Cell): number | null {
  if (isEmpty(v)) return null;
  if (typeof v === "number") return v;
  const n = toNumber(v);
  if (n !== null) return n;
  const d = toDate(v);
  return d ? d.getTime() / DAY : null;
}

export const WINDOW_FNS = [
  "Row number",
  "Rank",
  "Dense rank",
  "Percent rank",
  "Cumulative distribution",
  "Ntile",
  "Lag",
  "Lead",
  "First value",
  "Last value",
  "Nth value",
  "Sum",
  "Mean",
  "Count",
  "Min",
  "Max",
] as const;
const RANKING_FNS = new Set(["Row number", "Rank", "Dense rank", "Percent rank", "Cumulative distribution", "Ntile"]);
const FRAME_FNS = new Set(["First value", "Last value", "Nth value", "Sum", "Mean", "Count", "Min", "Max"]);
export const WINDOW_FRAMES = [
  "Whole partition",
  "Running (up to this row)",
  "Last N rows",
  "N rows before and after",
  "Last N units of the order column",
] as const;
/** frames whose size comes from the N field */
const SIZED_FRAMES = new Set(["Last N rows", "N rows before and after", "Last N units of the order column"]);
const windowNeedsColumn = (fn: string) => !RANKING_FNS.has(fn) && fn !== "Count";

function windowValues(t: Table, p: Params): { values: Cell[]; type: ColType } {
  const fn = str(p, "fn") || "Row number";
  const col = windowNeedsColumn(fn) || str(p, "column") ? need(t, str(p, "column")) : null;
  const partition = list(p, "partitionBy").map((c) => need(t, c).name);
  const keys = readSortKeys(p, "orderBy");
  if ((RANKING_FNS.has(fn) || fn === "Lag" || fn === "Lead") && !keys.length) throw new Error(`${fn} needs an order — add an Order by column`);
  const cmp = rowComparator(t, keys);
  const frame = str(p, "frame") || "Whole partition";
  const nText = str(p, "n");
  // time ranges may be fractional (e.g. 0.5 days); everything else counts rows
  const n = frame === "Last N units of the order column" && FRAME_FNS.has(fn) ? Number(nText) : Math.trunc(Number(nText || (fn === "Ntile" ? 4 : 1)));
  if ((fn === "Ntile" || fn === "Lag" || fn === "Lead" || fn === "Nth value" || (FRAME_FNS.has(fn) && SIZED_FRAMES.has(frame))) && !(n >= (frame === "N rows before and after" && FRAME_FNS.has(fn) ? 0 : 1)))
    throw new Error(fn === "Ntile" ? "Buckets must be a whole number of at least 1" : "N must be a number of at least 1");
  const nth = Math.trunc(Number(str(p, "nth") || 1));
  if (fn === "Nth value" && !(nth >= 1)) throw new Error("Nth must be a whole number of at least 1");
  if (frame === "Last N units of the order column" && FRAME_FNS.has(fn) && !keys.length)
    throw new Error("A time range frame needs an Order by column (a number, date or timestamp)");
  const fallback = col && str(p, "default") !== "" ? castCell(str(p, "default"), col.type) : null;

  const groups = new Map<string, number[]>();
  t.rows.forEach((r, i) => {
    const k = partition.map((c) => cellKey(r[c] ?? null)).join("\u0001");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  });

  const values = new Array<Cell>(t.rows.length).fill(null);
  const aggFn = fn === "First value" ? "First" : fn === "Last value" ? "Last" : fn;
  for (const idxs of groups.values()) {
    const order = keys.length ? [...idxs].sort((a, b) => cmp(t.rows[a], t.rows[b]) || a - b) : idxs;
    const size = order.length;
    const peer = (i: number, j: number) => cmp(t.rows[order[i]], t.rows[order[j]]) === 0;
    const colVals = col ? order.map((i) => t.rows[i][col.name] ?? null) : null;

    if (fn === "Row number") order.forEach((row, i) => (values[row] = i + 1));
    else if (fn === "Rank" || fn === "Dense rank" || fn === "Percent rank") {
      let rank = 0;
      let dense = 0;
      order.forEach((row, i) => {
        if (i === 0 || !peer(i, i - 1)) {
          rank = i + 1;
          dense++;
        }
        values[row] = fn === "Rank" ? rank : fn === "Dense rank" ? dense : size > 1 ? (rank - 1) / (size - 1) : 0;
      });
    } else if (fn === "Cumulative distribution") {
      for (let i = 0; i < size; ) {
        let j = i;
        while (j + 1 < size && peer(j + 1, i)) j++;
        for (let k = i; k <= j; k++) values[order[k]] = (j + 1) / size;
        i = j + 1;
      }
    } else if (fn === "Ntile") {
      const base = Math.floor(size / n);
      const extra = size % n;
      let bucket = 1;
      let left = base + (extra >= 1 ? 1 : 0);
      order.forEach((row) => {
        if (left === 0) {
          bucket++;
          left = base + (bucket <= extra ? 1 : 0);
        }
        values[row] = bucket;
        left--;
      });
    } else if (fn === "Lag" || fn === "Lead") {
      order.forEach((row, i) => {
        const j = fn === "Lag" ? i - n : i + n;
        values[row] = j >= 0 && j < size ? colVals![j] : fallback;
      });
    } else if (FRAME_FNS.has(fn)) {
      // the rows of a frame, as [from, to] positions in `order`
      const bounds = (i: number): [number, number] => {
        if (frame === "Whole partition") return [0, size - 1];
        if (frame === "Running (up to this row)") return [0, i];
        if (frame === "Last N rows") return [Math.max(0, i - n + 1), i];
        if (frame === "N rows before and after") return [Math.max(0, i - n), Math.min(size - 1, i + n)];
        // time range: rows whose order value is within n units before this one (and its peers)
        const pos = (j: number) => rangeValue(t.rows[order[j]][keys[0].column] ?? null);
        const cur = pos(i);
        if (cur === null) return [i, i];
        const dir = keys[0].direction === "desc" ? -1 : 1;
        let from = i;
        while (from > 0) {
          const v = pos(from - 1);
          if (v === null || (cur - v) * dir > n) break;
          from--;
        }
        let to = i;
        while (to + 1 < size && pos(to + 1) === cur) to++;
        return [from, to];
      };
      const frameValue = (from: number, to: number): Cell => {
        if (fn === "Nth value") return to - from + 1 >= nth ? colVals![from + nth - 1] : null;
        return aggregateValues(aggFn, colVals ? colVals.slice(from, to + 1) : null, to - from + 1);
      };
      if (frame !== "Running (up to this row)" || fn === "Nth value") {
        if (frame === "Whole partition") {
          const v = frameValue(0, size - 1);
          order.forEach((row) => (values[row] = v));
        } else order.forEach((row, i) => (values[row] = frameValue(...bounds(i))));
      } else {
        // running: incremental so long partitions stay linear
        let sum = 0;
        let count = 0;
        let min: Cell = null;
        let max: Cell = null;
        let first: Cell = null;
        let last: Cell = null;
        order.forEach((row, i) => {
          const v = colVals ? colVals[i] : null;
          if (colVals && !isEmpty(v)) {
            const num = toNumber(v);
            if (num !== null) sum += num;
            count++;
            if (first === null) first = v;
            last = v;
            if (min === null || compareCells(v, min) < 0) min = v;
            if (max === null || compareCells(v, max) > 0) max = v;
          }
          values[row] =
            fn === "Count"
              ? colVals
                ? count
                : i + 1
              : fn === "Sum"
                ? count
                  ? sum
                  : null
                : fn === "Mean"
                  ? count
                    ? sum / count
                    : null
                  : fn === "Min"
                    ? min
                    : fn === "Max"
                      ? max
                      : fn === "First value"
                        ? first
                        : last;
        });
      }
    } else throw new Error(`Unknown window function "${fn}"`);
  }
  const type: ColType =
    fn === "Percent rank" || fn === "Cumulative distribution" || fn === "Mean" || fn === "Sum"
      ? "Double"
      : RANKING_FNS.has(fn) || fn === "Count"
        ? "Integer"
        : (col?.type ?? "String");
  return { values, type };
}

export const windowOutput = (p: Params) => {
  const fn = str(p, "fn") || "Row number";
  return slug(fn) + (windowNeedsColumn(fn) && str(p, "column") ? `_${str(p, "column")}` : "");
};

// set operations

const rowKey = (r: Row, columns: Column[]) => columns.map((c) => cellKey(castCell(cellOf(r, c.name), "String"))).join("\u0001");

function distinctRows(t: Table): Table {
  const seen = new Set<string>();
  return {
    columns: t.columns,
    rows: t.rows.filter((r) => {
      const k = rowKey(r, t.columns);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

/** UNION [ALL] / INTERSECT [ALL] / EXCEPT [ALL]; rows are matched by column name, using the first input's columns. */
function setOperation(tables: Table[], mode: SetMode): Table {
  if (mode === "union all") return union(tables);
  if (mode === "union distinct") return distinctRows(union(tables));
  if (tables.length < 2) throw new Error(`${mode} needs at least two inputs`);
  const [first, ...rest] = tables;
  for (const other of rest)
    for (const c of first.columns)
      if (!other.columns.some((o) => o.name === c.name)) throw new Error(`Column "${c.name}" is missing from an input — ${mode} compares whole rows`);
  if (mode === "intersect all" || mode === "except all") {
    // multiset semantics: a row kept n times in the first input is matched against how often the others have it
    const counts = rest.map((o) => {
      const m = new Map<string, number>();
      for (const r of o.rows) {
        const k = rowKey(r, first.columns);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    });
    const seen = new Map<string, number>();
    return {
      columns: first.columns,
      rows: first.rows.filter((r) => {
        const k = rowKey(r, first.columns);
        const nth = (seen.get(k) ?? 0) + 1;
        seen.set(k, nth);
        if (mode === "intersect all") return counts.every((m) => (m.get(k) ?? 0) >= nth);
        return nth > counts.reduce((sum, m) => sum + (m.get(k) ?? 0), 0);
      }),
    };
  }
  const others = rest.map((o) => new Set(o.rows.map((r) => rowKey(r, first.columns))));
  const keep =
    mode === "intersect"
      ? (k: string) => others.every((s) => s.has(k))
      : (k: string) => !others.some((s) => s.has(k));
  return distinctRows({ columns: first.columns, rows: first.rows.filter((r) => keep(rowKey(r, first.columns))) });
}



const MATH_OPS = ["+", "−", "×", "÷"] as const;

export const STEPS: StepDef[] = [
  {
    kind: "trim",
    label: "Trim whitespace",
    category: "String",
    description: "Removes whitespace (or the characters you list) from the start, end or both ends of each value (TRIM / LTRIM / RTRIM).",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "side", label: "Side", kind: "select", options: ["Both", "Left", "Right"] },
      { key: "chars", label: "Characters", kind: "text", optional: true, placeholder: "whitespace", help: "Every character listed is removed, e.g. \"0\" or \"-_ \"." },
    ],
    output: true,
    run: (t, p) => {
      const chars = str(p, "chars");
      const set = chars ? `[${chars.replace(/[\]\\^-]/g, "\\$&")}]` : "\\s";
      const side = str(p, "side") || "Both";
      const re = new RegExp(side === "Left" ? `^${set}+` : side === "Right" ? `${set}+$` : `^${set}+|${set}+$`, "g");
      return mapText(t, p, (s) => s.replace(re, ""));
    },
    summary: (p) => `${str(p, "column")}${str(p, "side") && str(p, "side") !== "Both" ? ` (${str(p, "side").toLowerCase()})` : ""}${str(p, "chars") ? ` "${str(p, "chars")}"` : ""}`,
  },
  {
    kind: "cast",
    label: "Cast",
    category: "Cast",
    description:
      "Converts a column to another type, as CAST(x AS type) in Spark SQL: boolean, tinyint, smallint, int, bigint, float, double, decimal(p, s), date, timestamp, binary or string. Values that cannot be converted (or do not fit the type) become null. Strings cast to a date or timestamp are read with the formats given; with no formats, ISO 8601 and most common forms are accepted. Timestamps and numbers convert through seconds since 1970-01-01 UTC; binary is shown as base64.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "type", label: "Type", kind: "select", options: COL_TYPES, optionLabel: typeLabel },
      {
        key: "precision",
        label: "Precision",
        kind: "text",
        showIf: (p) => str(p, "type") === "Decimal",
        placeholder: "10",
        help: "Total digits, 1–38. Spark's plain DECIMAL is decimal(10, 0).",
      },
      {
        key: "scale",
        label: "Scale",
        kind: "text",
        showIf: (p) => str(p, "type") === "Decimal",
        placeholder: "0",
        help: "Digits after the decimal point; values are rounded half up, and ones too large for the precision become null.",
      },
      {
        key: "timezone",
        label: "Time zone",
        kind: "timezone",
        optional: true,
        showIf: (p) => str(p, "type") === "Timestamp",
        help: "Used to parse formats that do not include a time zone. If the value also includes an offset, the offset wins.",
      },
      {
        key: "formats",
        label: "Formats",
        kind: "formats",
        optional: true,
        showIf: (p) => str(p, "type") === "Date" || str(p, "type") === "Timestamp",
        help: "Format defaults to ISO 8601 `yyyy-MM-dd'T'HH:mm:ss.SSSXXX` and `yyyy-MM-dd`.",
      },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const to = (str(p, "type") || "String") as ColType;
      if (!COL_TYPES.includes(to)) throw new Error(`Unknown type "${to}"`);
      let decimal: { precision: number; scale: number } | undefined;
      if (to === "Decimal") {
        const precision = Math.trunc(Number(str(p, "precision") || 10));
        const scale = Math.trunc(Number(str(p, "scale") || 0));
        if (!(precision >= 1 && precision <= 38)) throw new Error("Precision must be a whole number from 1 to 38");
        if (!(scale >= 0 && scale <= precision)) throw new Error("Scale must be a whole number from 0 to the precision");
        decimal = { precision, scale };
      }
      const patterns = list(p, "formats").filter((f) => f.trim());
      if ((to === "Date" || to === "Timestamp") && patterns.length) {
        const formats = patterns.map(compileDateFormat);
        const zone = str(p, "timezone");
        if (zone) zoneOffset(zone, 0); // fail early on an unknown zone
        return setColumn(t, outputName(p), to, (r) => {
          const v = r[col.name];
          return typeof v === "string" ? parseDateWith(formats, v, zone, to) : castValue(v ?? null, col.type, to);
        });
      }
      return setColumn(t, outputName(p), to, (r) => castValue(r[col.name] ?? null, col.type, to, decimal));
    },
    summary: (p) =>
      `${str(p, "column")} → ${SQL_TYPE_NAMES[(str(p, "type") || "String") as ColType] ?? str(p, "type")}${
        str(p, "type") === "Decimal" ? `(${str(p, "precision") || 10}, ${str(p, "scale") || 0})` : ""
      }${list(p, "formats").length ? ` (${list(p, "formats").join(" | ")})` : ""}${str(p, "timezone") ? ` in ${str(p, "timezone")}` : ""}`,
  },
  {
    kind: "case",
    label: "Change case",
    category: "String",
    description: "Converts text to upper case, lower case or title case.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "case", label: "Case", kind: "select", options: ["Upper", "Lower", "Title"] },
    ],
    output: true,
    run: (t, p) => {
      const c = str(p, "case") || "Upper";
      return mapText(t, p, (s) =>
        c === "Upper"
          ? s.toUpperCase()
          : c === "Lower"
            ? s.toLowerCase()
            : s.toLowerCase().replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase()),
      );
    },
    summary: (p) => `${str(p, "column")} → ${(str(p, "case") || "Upper").toLowerCase()} case`,
  },
  {
    kind: "replace",
    label: "Find and replace",
    category: "String",
    description: "Replaces every match of a text or regular expression.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "find", label: "Find", kind: "text" },
      { key: "with", label: "Replace with", kind: "text", optional: true },
      { key: "mode", label: "Match", kind: "select", options: ["Text", "Regex"] },
    ],
    output: true,
    run: (t, p) => {
      const find = str(p, "find");
      if (!find) throw new Error("Enter the text to find");
      let re: RegExp;
      try {
        re = new RegExp(str(p, "mode") === "Regex" ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      } catch {
        throw new Error("Invalid regular expression");
      }
      return mapText(t, p, (s) => s.replace(re, str(p, "with")));
    },
    summary: (p) => `${str(p, "column")}: "${str(p, "find")}" → "${str(p, "with")}"`,
  },
  {
    kind: "concat",
    label: "Concatenate strings",
    category: "String",
    description: "Concatenates a list of strings (columns or values) with the specified separator.",
    fields: [
      { key: "separator", label: "Separator", kind: "text", optional: true, placeholder: "e.g. , (comma and space)" },
      { key: "columns", label: "Expressions", kind: "expressions" },
      { key: "nullIfAny", label: "Null output if any input is null", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "concat_strings",
    defaults: { separator: "", columns: ["", ""] },
    run: (t, p) => {
      const parts = list(p, "columns").map((e): ((r: Row) => Cell) => {
        if (!e) throw new Error("Complete every expression");
        if (isLiteral(e)) return () => literalText(e);
        const name = need(t, e).name;
        return (r) => r[name] ?? null;
      });
      if (!parts.length) throw new Error("Add at least one expression");
      const nullIfAny = str(p, "nullIfAny") === "true";
      return setColumn(t, outputName(p, "concat_strings"), "String", (r) => {
        const values = parts.map((f) => f(r));
        // otherwise null inputs are left out
        if (nullIfAny && values.includes(null)) return null;
        return values
          .filter((v) => v !== null)
          .map((v) => castCell(v, "String"))
          .join(str(p, "separator"));
      });
    },
    summary: (p) =>
      `${list(p, "columns").map(expressionText).join(` + ${JSON.stringify(str(p, "separator"))} + `)} → ${outputName(p, "concat_strings")}`,
  },
  {
    kind: "json",
    label: "Extract JSON field",
    category: "Struct",
    description: 'Reads a field from JSON text (GET_JSON_OBJECT), e.g. city, address.lines.0 or $.address.lines[0].',
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "path", label: "Field path", kind: "text", placeholder: "city" },
      { key: "output", label: "New column", kind: "text", optional: true },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const path = str(p, "path").trim();
      if (!path) throw new Error("Enter a field path");
      const keys = jsonPath(path);
      const raw = t.rows.map((r) => {
        let v: unknown = r[col.name];
        if (typeof v === "string") {
          try {
            v = JSON.parse(v);
          } catch {
            return null;
          }
        }
        for (const k of keys) v = ownField(v, k);
        return v;
      });
      const out = inferColumn(raw);
      const name = outputName(p, keys[keys.length - 1] ?? col.name);
      let i = 0;
      return setColumn(t, name, out.type, () => out.values[i++]);
    },
    summary: (p) => `${str(p, "column")}.${str(p, "path")} → ${outputName(p, jsonPath(str(p, "path")).pop() ?? str(p, "column"))}`,
  },
  {
    kind: "flatten",
    label: "Flatten struct",
    category: "Struct",
    description:
      "Parses a JSON string column with a struct schema and turns each field into its own column, e.g. address → city, street, state.",
    // edited by FlattenForm; listed here for the transform picker
    fields: [
      { key: "column", label: "Expression: Parse JSON string", kind: "column" },
      { key: "schema", label: "Schema", kind: "text" },
      { key: "maxDepth", label: "Max depth", kind: "text" },
      { key: "prefix", label: "Column prefix", kind: "text", optional: true },
      { key: "separator", label: "Separator", kind: "text" },
    ],
    defaults: { schema: "[]", maxDepth: "1", prefix: "", separator: "_" },
    run: flatten,
    summary: (p) => {
      let names: string[] = [];
      try {
        names = flattenTargets(p).map((t) => t.name);
      } catch {}
      return `Parse JSON string(${str(p, "column") || "?"}) → ${names.join(", ") || "no fields"}`;
    },
  },
  {
    kind: "extract_json",
    label: "Extract rows from a JSON file",
    category: "File",
    description: "Reads a dataset of files and parses each JSON file into rows.",
    // edited by ExtractJsonForm; listed here for the transform picker
    fields: [
      { key: "schema", label: "Schema: schema definition used when parsing the JSON files (empty reads every field)", kind: "text", optional: true },
      {
        key: "multiline",
        label: "Allow JSON values to span multiple lines: if off, each JSON record must be entirely on one line",
        kind: "boolean",
        optional: true,
      },
    ],
    defaults: { schema: "[]", multiline: "" },
    run: extractJson,
    summary: (p) => {
      const fields = readSchema(p).map((f) => `${f.name}: ${f.type}`);
      return `Schema: ${fields.length ? `Struct(${fields.join(", ")})` : "inferred"} · Allow JSON values to span multiple lines: ${str(p, "multiline") === "true"}`;
    },
  },
  {
    kind: "extract_csv",
    label: "Extract rows from a CSV file",
    category: "File",
    description: "Reads a dataset of files and parses each CSV file (first line is the header) into rows; files are stacked by column name.",
    fields: [{ key: "includePath", label: "Add a file_path column", kind: "boolean", optional: true }],
    run: extractCsv,
    summary: (p) => (str(p, "includePath") === "true" ? "with file_path" : "all files"),
  },
  {
    kind: "formula",
    label: "Formula",
    category: "Numeric",
    description:
      "Computes a numeric column from a formula over columns, numbers and constants, e.g. A*x^2 + b^2 + ln(x). Supports + − × ÷ % ^, parentheses and functions such as ln, log, exp, sqrt, abs, pow, round, min, max, sin, cos. If an input is null or the math is undefined (ln of a negative), the result is null.",
    fields: [
      { key: "formula", label: "Formula", kind: "formula", placeholder: "A*x^2 + b^2 + ln(x)" },
      {
        key: "constants",
        label: "Constants",
        kind: "text",
        optional: true,
        placeholder: "A = 2, b = 0.5",
        help: "Names used in the formula that are not columns. pi and e are built in.",
      },
    ],
    output: true,
    outputDefault: "formula",
    run: (t, p) => {
      const f = compileFormula(str(p, "formula"), t.columns, parseConstants(str(p, "constants")));
      return setColumn(t, outputName(p, "formula"), "Double", f);
    },
    summary: (p) => `${str(p, "formula") || "?"}${str(p, "constants") ? ` (${str(p, "constants")})` : ""}`,
  },
  {
    kind: "math",
    label: "Arithmetic",
    category: "Numeric",
    description: "Adds, subtracts, multiplies or divides a column by another column or a number.",
    fields: [
      { key: "column", label: "Left", kind: "column" },
      { key: "op", label: "Operator", kind: "select", options: MATH_OPS },
      { key: "right", label: "Right", kind: "text", placeholder: "column name or number" },
    ],
    output: true,
    run: (t, p) => {
      const left = need(t, str(p, "column"));
      const right = str(p, "right").trim();
      const rightCol = t.columns.find((c) => c.name === right);
      const constant = rightCol ? null : toNumber(right);
      if (!rightCol && constant === null) throw new Error("Right must be a column name or a number");
      const op = str(p, "op") || "+";
      return setColumn(t, outputName(p), "Double", (r) => {
        const a = toNumber(r[left.name]);
        const b = rightCol ? toNumber(r[rightCol.name]) : constant;
        if (a === null || b === null) return null;
        const v = op === "+" ? a + b : op === "−" ? a - b : op === "×" ? a * b : b === 0 ? NaN : a / b;
        // overflow (e.g. 1e308 × 10) is null, like division by zero
        return Number.isFinite(v) ? v : null;
      });
    },
    summary: (p) => `${str(p, "column")} ${str(p, "op") || "+"} ${str(p, "right")}`,
  },
  {
    kind: "constant",
    label: "Add constant column",
    category: "Data preparation",
    description: "Adds a column with the same value in every row.",
    fields: [
      { key: "output", label: "New column", kind: "text" },
      { key: "value", label: "Value", kind: "text", optional: true },
      { key: "type", label: "Type", kind: "select", options: COL_TYPES },
    ],
    run: (t, p) => {
      const name = str(p, "output").trim();
      if (!name) throw new Error("Name the new column");
      const type = typeParam(p, "type", "String");
      const value = castCell(str(p, "value"), type);
      return setColumn(t, name, type, () => value);
    },
    summary: (p) => `${str(p, "output")} = "${str(p, "value")}"`,
  },
  {
    kind: "fill",
    label: "Fill nulls",
    category: "Data preparation",
    description: "Replaces null or empty values with a default.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "value", label: "Default", kind: "text" },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const value = castCell(str(p, "value"), col.type);
      return setColumn(t, col.name, col.type, (r) => (isEmpty(r[col.name]) ? value : r[col.name]));
    },
    summary: (p) => `${str(p, "column")} ← "${str(p, "value")}"`,
  },
  {
    kind: "rename",
    label: "Rename column",
    category: "Data preparation",
    description: "Gives a column a new name.",
    fields: [
      { key: "column", label: "Column", kind: "column" },
      { key: "to", label: "New name", kind: "text" },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const to = str(p, "to").trim();
      if (!to) throw new Error("Enter the new name");
      if (to !== col.name && t.columns.some((c) => c.name === to)) throw new Error(`Column "${to}" already exists`);
      return {
        columns: t.columns.map((c) => (c.name === col.name ? { ...c, name: to } : c)),
        rows: t.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k === col.name ? to : k, v]))),
      };
    },
    summary: (p) => `${str(p, "column")} → ${str(p, "to")}`,
  },
  {
    kind: "select",
    label: "Select columns",
    category: "Data preparation",
    description: "Keeps only the chosen columns, in the chosen order.",
    fields: [{ key: "columns", label: "Columns", kind: "columns" }],
    run: (t, p) => {
      const cols = [...new Set(list(p, "columns"))].map((c) => need(t, c));
      if (!cols.length) throw new Error("Choose at least one column");
      return {
        columns: cols,
        rows: t.rows.map((r) => Object.fromEntries(cols.map((c) => [c.name, r[c.name] ?? null]))),
      };
    },
    summary: (p) => list(p, "columns").join(", "),
  },
  {
    kind: "drop",
    label: "Drop columns",
    category: "Data preparation",
    description: "Removes the chosen columns from the dataset.",
    fields: [{ key: "columns", label: "Columns to drop", kind: "columns" }],
    run: (t, p) => {
      if (!list(p, "columns").length) throw new Error("Choose the columns to drop");
      const drop = new Set(list(p, "columns").map((c) => need(t, c).name));
      const columns = t.columns.filter((c) => !drop.has(c.name));
      return {
        columns,
        rows: t.rows.map((r) => Object.fromEntries(columns.map((c) => [c.name, r[c.name] ?? null]))),
      };
    },
    summary: (p) => list(p, "columns").join(", "),
  },
  {
    kind: "filter",
    label: "Filter rows",
    category: "Rows",
    description:
      "Filter rows based on comparisons for selected columns. Keep or remove the rows that match all (or any) of the conditions; contains, starts with and ends with ignore case.",
    // edited by FilterForm; listed here for the transform picker
    fields: [
      { key: "mode", label: "Keep or remove rows", kind: "select", options: FILTER_MODES },
      { key: "filter", label: "Conditions and condition groups", kind: "text" },
    ],
    run: (t, p) => {
      const test = compileGroup(t, readFilter(p));
      const remove = str(p, "mode") === "Remove rows";
      return { columns: t.columns, rows: t.rows.filter((r) => test(r) !== remove) };
    },
    summary: (p) => `${str(p, "mode") === "Remove rows" ? "remove" : "keep"} where ${describeGroup(readFilter(p))}`,
  },
  {
    kind: "dedupe",
    label: "Drop duplicates",
    category: "Rows",
    description: "Keeps the first row for each distinct combination of the chosen columns (all columns if none).",
    fields: [{ key: "columns", label: "Columns", kind: "columns", optional: true }],
    run: (t, p) => {
      const cols = list(p, "columns").length ? list(p, "columns").map((c) => need(t, c).name) : t.columns.map((c) => c.name);
      const seen = new Set<string>();
      return {
        columns: t.columns,
        rows: t.rows.filter((r) => {
          const k = cols.map((c) => cellKey(r[c])).join("\u0001");
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }),
      };
    },
    summary: (p) => list(p, "columns").join(", ") || "all columns",
  },
  {
    kind: "sort",
    label: "Sort",
    category: "Rows",
    description: "Orders the rows by one or more columns (ORDER BY), each ascending or descending, with nulls first or last.",
    fields: [{ key: "sort", label: "Order by", kind: "sortkeys" }],
    run: (t, p) => {
      const keys = readSortKeys(p, "sort");
      if (!keys.length) throw new Error("Add a column to sort by");
      return { columns: t.columns, rows: [...t.rows].sort(rowComparator(t, keys)) };
    },
    summary: (p) => describeSort(readSortKeys(p, "sort")) || "?",
  },
  {
    kind: "limit",
    label: "Limit rows",
    category: "Rows",
    description: "Keeps the first N rows after skipping an offset (LIMIT … OFFSET …). Sort first to choose which rows.",
    fields: [
      { key: "n", label: "Number of rows", kind: "text", placeholder: "100" },
      { key: "offset", label: "Skip first", kind: "text", optional: true, placeholder: "0" },
    ],
    run: (t, p) => {
      const n = Math.trunc(Number(str(p, "n")));
      const offset = Math.trunc(Number(str(p, "offset") || 0));
      if (!str(p, "n") || !(n >= 0)) throw new Error("Number of rows must be a whole number");
      if (!(offset >= 0)) throw new Error("Skip must be a whole number");
      return { columns: t.columns, rows: t.rows.slice(offset, offset + n) };
    },
    summary: (p) => `${str(p, "n") || "?"} rows${str(p, "offset") ? ` after ${str(p, "offset")}` : ""}`,
  },
  {
    kind: "sample",
    label: "Sample rows",
    category: "Rows",
    description: "Keeps a random share of the rows (TABLESAMPLE). The same seed always picks the same rows.",
    fields: [
      { key: "percent", label: "Percent of rows", kind: "text", placeholder: "10" },
      { key: "seed", label: "Seed", kind: "text", optional: true, placeholder: "1" },
    ],
    run: (t, p) => {
      const pct = Number(str(p, "percent"));
      if (!str(p, "percent") || !(pct >= 0 && pct <= 100)) throw new Error("Percent must be a number from 0 to 100");
      const rand = seeded(Math.trunc(Number(str(p, "seed") || 1)));
      return { columns: t.columns, rows: t.rows.filter(() => rand() * 100 < pct) };
    },
    summary: (p) => `${str(p, "percent") || "?"}%${str(p, "seed") ? ` (seed ${str(p, "seed")})` : ""}`,
  },
  {
    kind: "aggregate",
    label: "Aggregate",
    category: "Aggregate",
    description:
      "Groups rows by a set of columns (GROUP BY) and computes any number of aggregations per group. With no group-by columns the whole dataset is one group. Rollup and Cube add subtotal rows, with the rolled-up columns left null. Filter afterwards for HAVING.",
    fields: [
      { key: "groupBy", label: "Group by columns", kind: "columns", optional: true },
      { key: "grouping", label: "Grouping", kind: "select", options: ["Group by", "Rollup", "Cube", "Grouping sets"] },
      {
        key: "sets",
        label: "Grouping sets",
        kind: "text",
        showIf: (p) => str(p, "grouping") === "Grouping sets",
        placeholder: "region, rep; region; ()",
        help: "Sets separated by ; — each a comma-separated list of Group by columns, () for the grand total.",
      },
      {
        key: "groupingId",
        label: "Add grouping_id column",
        kind: "boolean",
        optional: true,
        showIf: (p) => !!str(p, "grouping") && str(p, "grouping") !== "Group by",
        help: "GROUPING_ID: a bit per Group by column (first column = highest bit), set when that column is rolled up — tells subtotal nulls from real nulls.",
      },
      { key: "aggs", label: "Aggregations", kind: "aggregations" },
    ],
    defaults: { aggs: JSON.stringify([{ id: "a1", fn: "Count", column: "" }]) },
    run: (t, p) => {
      // a column chosen twice would make two output columns with one name
      const groupBy = [...new Set(list(p, "groupBy"))].map((c) => need(t, c));
      const specs = readAggs(p);
      if (!specs.length) throw new Error("Add an aggregation");
      const resolved = specs.map((a) => {
        if (!AGG_FNS.includes(a.fn)) throw new Error(`Unknown aggregation "${a.fn}"`);
        const col = a.column ? need(t, a.column) : null;
        if (!col && a.fn !== "Count") throw new Error(`${a.fn} needs a column`);
        const col2 = PAIR_AGGS.has(a.fn) ? need(t, a.arg ?? "") : null;
        let test: ((r: Row) => boolean) | null = null;
        if (a.where?.items.length) {
          try {
            test = compileGroup(t, a.where);
          } catch (e) {
            throw new Error(`${aggOutput(a)} filter: ${(e as Error).message}`);
          }
        }
        return { a, col, col2, test, name: aggOutput(a) };
      });
      const names = new Set(groupBy.map((c) => c.name));
      for (const r of resolved) {
        if (names.has(r.name)) throw new Error(`Two output columns are named "${r.name}" — rename one`);
        names.add(r.name);
      }
      const grouping = str(p, "grouping") || "Group by";
      const n = groupBy.length;
      if (grouping === "Cube" && n > 10) throw new Error("Cube over more than 10 columns makes over 1,000 grouping sets — use Grouping sets");
      const parseSets = (): number[][] => {
        const text = str(p, "sets").trim();
        if (!text) throw new Error("Enter the grouping sets, e.g. region, rep; region; ()");
        return text.split(";").map((part) => {
          const inner = part.trim().replace(/^\(|\)$/g, "").trim();
          if (!inner) return [];
          return inner.split(",").map((name) => {
            const i = groupBy.findIndex((c) => c.name === name.trim());
            if (i < 0) throw new Error(`"${name.trim()}" is not one of the Group by columns`);
            return i;
          });
        });
      };
      const sets: number[][] =
        grouping === "Grouping sets"
          ? parseSets()
          : grouping === "Rollup"
          ? Array.from({ length: n + 1 }, (_, k) => Array.from({ length: n - k }, (_, i) => i))
          : grouping === "Cube"
            ? Array.from({ length: 2 ** n }, (_, mask) => groupBy.map((_, i) => i).filter((i) => mask & (1 << (n - 1 - i)))).sort(
                (a, b) => b.length - a.length,
              )
            : [groupBy.map((_, i) => i)];
      const withId = grouping !== "Group by" && str(p, "groupingId") === "true";
      if (withId && names.has("grouping_id")) throw new Error('An output column is already named "grouping_id"');
      const rows: Row[] = [];
      for (const set of sets) {
        const groups = new Map<string, Row[]>();
        for (const r of t.rows) {
          const k = set.map((i) => cellKey(r[groupBy[i].name] ?? null)).join("\u0001");
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(r);
        }
        if (!set.length && !groups.size) groups.set("", []);
        for (const rs of groups.values()) {
          const out: Row = Object.fromEntries(groupBy.map((c, i) => [c.name, set.includes(i) ? (rs[0]?.[c.name] ?? null) : null]));
          for (const r of resolved) {
            const inGroup = r.test ? rs.filter(r.test) : rs;
            if (r.col2) {
              const pairs: [number, number][] = [];
              for (const x of inGroup) {
                const a = toNumber(x[r.col!.name] ?? null);
                const b = toNumber(x[r.col2.name] ?? null);
                if (a !== null && b !== null) pairs.push([a, b]);
              }
              const stat = pairStat(r.a.fn === "Correlation" ? "corr" : r.a.fn === "Covariance (sample)" ? "covar_samp" : "covar_pop", pairs);
              setField(out, r.name, stat !== null && Number.isFinite(stat) ? stat : null);
            } else
              setField(out, r.name, aggregateValues(r.a.fn, r.col ? inGroup.map((x) => x[r.col!.name] ?? null) : null, inGroup.length, r.a.arg ?? ""));
          }
          if (withId) out.grouping_id = groupBy.reduce((id, _, i) => (id << 1) | (set.includes(i) ? 0 : 1), 0);
          rows.push(out);
        }
      }
      return {
        columns: [
          ...groupBy,
          ...(withId ? [{ name: "grouping_id", type: "Integer" as ColType }] : []),
          ...resolved.map((r) => ({ name: r.name, type: aggType(r.a.fn, r.col) })),
        ],
        rows,
      };
    },
    summary: (p) => {
      const by = list(p, "groupBy");
      const grouping = str(p, "grouping");
      const aggs = readAggs(p).map((a) => `${a.fn}${a.column ? `(${a.column})` : ""}${a.where?.items.length ? ` filter (where ${describeGroup(a.where)})` : ""}`);
      return `${aggs.join(", ")}${by.length ? ` by ${grouping && grouping !== "Group by" ? `${grouping.toLowerCase()} ` : ""}${by.join(", ")}` : ""}`;
    },
  },
  {
    kind: "window",
    label: "Window function",
    category: "Aggregate",
    description:
      "Computes a value for each row from related rows without collapsing them (… OVER (PARTITION BY … ORDER BY …)): row number, rank, ntile, lag / lead, and running or whole-partition sums, means, counts, minimums and maximums.",
    fields: [
      { key: "fn", label: "Function", kind: "select", options: WINDOW_FNS },
      { key: "column", label: "Column", kind: "column", optional: true, showIf: (p) => !RANKING_FNS.has(str(p, "fn") || "Row number") },
      {
        key: "n",
        label: "N",
        kind: "text",
        showIf: (p) => ["Ntile", "Lag", "Lead"].includes(str(p, "fn")) || (FRAME_FNS.has(str(p, "fn")) && SIZED_FRAMES.has(str(p, "frame"))),
        help: "Ntile: buckets (default 4). Lag / Lead: rows back / ahead (default 1). Frames: rows, or for a time range the units of the first Order by column — days for dates and timestamps (e.g. 7 = last 7 days).",
      },
      { key: "nth", label: "Nth", kind: "text", showIf: (p) => str(p, "fn") === "Nth value", placeholder: "2", help: "Position in the frame, 1 = first." },
      { key: "default", label: "Default", kind: "text", optional: true, showIf: (p) => ["Lag", "Lead"].includes(str(p, "fn")), help: "Used when there is no row that far back / ahead." },
      { key: "partitionBy", label: "Partition by", kind: "columns", optional: true },
      { key: "orderBy", label: "Order by", kind: "sortkeys", optional: true },
      {
        key: "frame",
        label: "Frame",
        kind: "select",
        options: WINDOW_FRAMES,
        showIf: (p) => FRAME_FNS.has(str(p, "fn")),
        help: "Running includes the rows up to and including this one in the order.",
      },
    ],
    output: true,
    outputDefault: windowOutput,
    run: (t, p) => {
      const { values, type } = windowValues(t, p);
      let i = 0;
      return setColumn(t, outputName(p, windowOutput(p)), type, () => values[i++]);
    },
    summary: (p) => {
      const fn = str(p, "fn") || "Row number";
      const part = list(p, "partitionBy");
      const order = describeSort(readSortKeys(p, "orderBy"));
      return `${fn}${str(p, "column") && windowNeedsColumn(fn) ? `(${str(p, "column")})` : ""} over (${part.length ? `partition by ${part.join(", ")}` : ""}${part.length && order ? " " : ""}${order ? `order by ${order}` : ""})`;
    },
  },
  {
    kind: "pivot",
    label: "Pivot",
    category: "Reshape",
    description: "Turns the distinct values of one column into columns (PIVOT), aggregating a value column for each group and value.",
    fields: [
      { key: "groupBy", label: "Group by columns", kind: "columns", optional: true },
      { key: "pivotColumn", label: "Pivot column", kind: "column", help: "Each distinct value becomes a column (up to 200)." },
      { key: "fn", label: "Aggregation", kind: "select", options: AGG_FNS },
      { key: "valueColumn", label: "Value column", kind: "column", optional: true },
      { key: "arg", label: "Argument", kind: "text", optional: true, showIf: (p) => !!AGG_ARG[(str(p, "fn") || "Count") as AggFn] },
    ],
    run: (t, p) => {
      // a column chosen twice would make two output columns with one name
      const groupBy = [...new Set(list(p, "groupBy"))].map((c) => need(t, c));
      const pc = need(t, str(p, "pivotColumn"));
      const fn = str(p, "fn") || "Count";
      const vc = str(p, "valueColumn") ? need(t, str(p, "valueColumn")) : null;
      if (!vc && fn !== "Count") throw new Error(`${fn} needs a value column`);
      const pivots = new Map<string, Cell>();
      for (const r of t.rows) {
        const v = r[pc.name] ?? null;
        if (!isEmpty(v) && !pivots.has(cellKey(v))) pivots.set(cellKey(v), v);
      }
      if (pivots.size > 200) throw new Error(`"${pc.name}" has ${pivots.size} distinct values — pivot supports up to 200`);
      const taken = new Set(groupBy.map((c) => c.name));
      const names = new Map<string, string>();
      for (const [k, v] of pivots) {
        let name = String(castCell(v, "String"));
        for (let k = 2; taken.has(name); k++) name = `${String(castCell(v, "String"))}_${k}`;
        taken.add(name);
        names.set(k, name);
      }
      const groups = new Map<string, Row[]>();
      for (const r of t.rows) {
        const k = groupBy.map((c) => cellKey(r[c.name] ?? null)).join("\u0001");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const rows = [...groups.values()].map((rs) => {
        const out: Row = Object.fromEntries(groupBy.map((c) => [c.name, rs[0][c.name] ?? null]));
        const byPivot = new Map<string, Row[]>();
        for (const r of rs) {
          const k = cellKey(r[pc.name] ?? null);
          if (!byPivot.has(k)) byPivot.set(k, []);
          byPivot.get(k)!.push(r);
        }
        for (const [k, name] of names) {
          const cell = byPivot.get(k);
          setField(out, name, cell ? aggregateValues(fn, vc ? cell.map((r) => r[vc.name] ?? null) : null, cell.length, str(p, "arg")) : null);
        }
        return out;
      });
      return { columns: [...groupBy, ...[...names.values()].map((name) => ({ name, type: aggType(fn, vc) }))], rows };
    },
    summary: (p) =>
      `${str(p, "pivotColumn") || "?"} → columns, ${str(p, "fn") || "Count"}${str(p, "valueColumn") ? `(${str(p, "valueColumn")})` : ""}${list(p, "groupBy").length ? ` by ${list(p, "groupBy").join(", ")}` : ""}`,
  },
  {
    kind: "unpivot",
    label: "Unpivot",
    category: "Reshape",
    description: "Turns columns into rows (UNPIVOT / melt): each chosen column becomes a row holding its name and value; other columns are repeated.",
    fields: [
      { key: "columns", label: "Columns to unpivot", kind: "columns" },
      { key: "nameColumn", label: "Name column", kind: "text", optional: true, placeholder: "name" },
      { key: "valueColumn", label: "Value column", kind: "text", optional: true, placeholder: "value" },
      { key: "dropNulls", label: "Drop null values", kind: "boolean", optional: true },
    ],
    run: (t, p) => {
      const cols = [...new Set(list(p, "columns"))].map((c) => need(t, c));
      if (!cols.length) throw new Error("Choose the columns to unpivot");
      const nameCol = str(p, "nameColumn").trim() || "name";
      const valueCol = str(p, "valueColumn").trim() || "value";
      const unpivoted = new Set(cols.map((c) => c.name));
      const keep = t.columns.filter((c) => !unpivoted.has(c.name));
      for (const n of [nameCol, valueCol])
        if (keep.some((c) => c.name === n)) throw new Error(`"${n}" is already a column — choose another name`);
      if (nameCol === valueCol) throw new Error("The name and value columns need different names");
      const types = new Set(cols.map((c) => c.type));
      const type: ColType = types.size === 1 ? cols[0].type : "String";
      const dropNulls = str(p, "dropNulls") === "true";
      const rows: Row[] = [];
      for (const r of t.rows)
        for (const c of cols) {
          const v = r[c.name] ?? null;
          if (dropNulls && isEmpty(v)) continue;
          rows.push({
            ...Object.fromEntries(keep.map((k) => [k.name, r[k.name] ?? null])),
            [nameCol]: c.name,
            [valueCol]: type === "String" ? castCell(v, "String") : v,
          });
        }
      return { columns: [...keep, { name: nameCol, type: "String" }, { name: valueCol, type }], rows };
    },
    summary: (p) => `${list(p, "columns").join(", ") || "?"} → ${str(p, "nameColumn") || "name"}, ${str(p, "valueColumn") || "value"}`,
  },
  {
    kind: "explode",
    label: "Explode into rows",
    category: "Reshape",
    description:
      "Makes one row per element of a list (EXPLODE): a JSON array such as [\"a\",\"b\"], or text split by a separator. Other columns are repeated.",
    fields: [
      { key: "column", label: "Column", kind: "column" },
      { key: "separator", label: "Separator", kind: "text", optional: true, placeholder: "empty = JSON array", help: "Leave empty when the column holds JSON arrays." },
      { key: "keepEmpty", label: "Keep rows with empty lists", kind: "boolean", optional: true, help: "As EXPLODE_OUTER: the row stays with a null element." },
      { key: "position", label: "Add a position column", kind: "boolean", optional: true },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const sep = str(p, "separator");
      const name = outputName(p);
      const lists = t.rows.map((r): unknown[] => {
        const v = r[col.name] ?? null;
        if (isEmpty(v)) return [];
        if (sep) return String(v).split(sep).map((x) => x.trim());
        if (typeof v !== "string") return [v];
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          throw new Error(`"${v.slice(0, 40)}" is not a JSON array — set a separator to split text`);
        }
      });
      const elements = inferColumn(lists.flat());
      const posName = `${name}_position`;
      const keepEmpty = str(p, "keepEmpty") === "true";
      const withPos = str(p, "position") === "true";
      const rows: Row[] = [];
      let k = 0;
      t.rows.forEach((r, i) => {
        if (!lists[i].length) {
          if (keepEmpty) rows.push({ ...r, [name]: null, ...(withPos ? { [posName]: null } : {}) });
          return;
        }
        lists[i].forEach((_, j) => rows.push({ ...r, [name]: elements.values[k++], ...(withPos ? { [posName]: j + 1 } : {}) }));
      });
      const columns = t.columns.some((c) => c.name === name)
        ? t.columns.map((c) => (c.name === name ? { name, type: elements.type } : c))
        : [...t.columns, { name, type: elements.type }];
      if (withPos && !columns.some((c) => c.name === posName)) columns.push({ name: posName, type: "Integer" });
      return { columns, rows };
    },
    summary: (p) => `${str(p, "column") || "?"}${str(p, "separator") ? ` split by "${str(p, "separator")}"` : ""}`,
  },
  {
    kind: "split",
    label: "Split into columns",
    category: "String",
    description: "Splits text by a separator into numbered columns (SPLIT(…)[i]), e.g. address → address_1, address_2, ….",
    fields: [
      { key: "column", label: "Column", kind: "column" },
      { key: "separator", label: "Separator", kind: "text", placeholder: "," },
      { key: "regex", label: "Separator is a regex", kind: "boolean", optional: true },
      { key: "parts", label: "Number of columns", kind: "text", optional: true, placeholder: "as many as needed (max 50)" },
      { key: "prefix", label: "Column name prefix", kind: "text", optional: true },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const sepText = str(p, "separator");
      if (!sepText) throw new Error("Enter the separator");
      let sep: string | RegExp = sepText;
      if (str(p, "regex") === "true") {
        try {
          sep = new RegExp(sepText);
        } catch {
          throw new Error(`Invalid regular expression "${sepText}"`);
        }
      }
      const parts = t.rows.map((r) => (isEmpty(r[col.name] ?? null) ? null : String(r[col.name]).split(sep)));
      const wanted = str(p, "parts") ? Math.trunc(Number(str(p, "parts"))) : parts.reduce((m, x) => Math.max(m, x?.length ?? 0), 1);
      if (!(wanted >= 1 && wanted <= 50)) throw new Error("Number of columns must be from 1 to 50");
      const prefix = str(p, "prefix").trim() || col.name;
      let out = t;
      for (let i = 0; i < wanted; i++) {
        let k = 0;
        out = setColumn(out, `${prefix}_${i + 1}`, "String", () => {
          const xs = parts[k++];
          if (!xs) return null;
          // the last column keeps the remainder when the count is fixed
          if (i === wanted - 1 && xs.length > wanted && typeof sep === "string") return xs.slice(i).join(sep);
          return xs[i]?.trim() ?? null;
        });
      }
      return out;
    },
    summary: (p) => `${str(p, "column") || "?"} by "${str(p, "separator")}" → ${str(p, "prefix") || str(p, "column")}_1…`,
  },
  {
    kind: "substring",
    label: "Substring",
    category: "String",
    description: "Takes part of a text (SUBSTRING): start is 1-based; a negative start counts from the end, so start -3 gives the last 3 characters (RIGHT). Start 1 with a length is LEFT.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "start", label: "Start", kind: "text", placeholder: "1" },
      { key: "length", label: "Length", kind: "text", optional: true, placeholder: "to the end" },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const start = Math.trunc(Number(str(p, "start") || 1));
      const len = str(p, "length") === "" ? null : Math.trunc(Number(str(p, "length")));
      if (!Number.isFinite(start)) throw new Error("Start must be a whole number");
      if (len !== null && !(len >= 0)) throw new Error("Length must be a whole number of at least 0");
      return setColumn(t, outputName(p), "String", (r) => {
        const v = r[col.name] ?? null;
        if (v === null) return null;
        const chars = [...String(v)];
        const from = start > 0 ? start - 1 : start < 0 ? Math.max(0, chars.length + start) : 0;
        return chars.slice(from, len === null ? undefined : from + len).join("");
      });
    },
    summary: (p) => `${str(p, "column") || "?"}[${str(p, "start") || 1}${str(p, "length") ? `, ${str(p, "length")}` : ""}]`,
  },
  {
    kind: "length",
    label: "String length",
    category: "String",
    description: "Number of characters in the text (LENGTH).",
    fields: [{ key: "column", label: "Expression", kind: "column" }],
    output: true,
    outputDefault: (p) => `${str(p, "column") || "text"}_length`,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      return setColumn(t, outputName(p, `${col.name}_length`), "Integer", (r) => {
        const v = r[col.name] ?? null;
        return v === null ? null : [...String(v)].length;
      });
    },
    summary: (p) => `length(${str(p, "column") || "?"})`,
  },
  {
    kind: "pad",
    label: "Pad string",
    category: "String",
    description: "Pads text on the left or right to a fixed length (LPAD / RPAD); longer text is cut to that length.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "side", label: "Side", kind: "select", options: ["Left", "Right"] },
      { key: "length", label: "Length", kind: "text", placeholder: "10" },
      { key: "fill", label: "Pad with", kind: "text", optional: true, placeholder: "space" },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const len = Math.trunc(Number(str(p, "length")));
      if (!str(p, "length") || !(len >= 0)) throw new Error("Length must be a whole number");
      if (len > 100000) throw new Error("Length can be at most 100,000");
      const fill = str(p, "fill") || " ";
      const left = str(p, "side") !== "Right";
      return setColumn(t, outputName(p), "String", (r) => {
        const v = r[col.name] ?? null;
        if (v === null) return null;
        const chars = [...String(v)];
        if (chars.length >= len) return chars.slice(0, len).join("");
        const padding = [...fill.repeat(Math.ceil((len - chars.length) / [...fill].length))].slice(0, len - chars.length).join("");
        return left ? padding + chars.join("") : chars.join("") + padding;
      });
    },
    summary: (p) => `${str(p, "side") === "Right" ? "rpad" : "lpad"}(${str(p, "column") || "?"}, ${str(p, "length") || "?"}, "${str(p, "fill") || " "}")`,
  },
  {
    kind: "position",
    label: "Find position",
    category: "String",
    description: "1-based position of the first occurrence of a text (INSTR / POSITION); 0 when it does not occur. Case-sensitive.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "search", label: "Find", kind: "text" },
    ],
    output: true,
    outputDefault: (p) => `${str(p, "column") || "text"}_position`,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const search = str(p, "search");
      if (!search) throw new Error("Enter the text to find");
      return setColumn(t, outputName(p, `${col.name}_position`), "Integer", (r) => {
        const v = r[col.name] ?? null;
        if (v === null) return null;
        const at = String(v).indexOf(search);
        return at < 0 ? 0 : [...String(v).slice(0, at)].length + 1;
      });
    },
    summary: (p) => `position of "${str(p, "search")}" in ${str(p, "column") || "?"}`,
  },
  {
    kind: "regex_extract",
    label: "Regex extract",
    category: "String",
    description: "Extracts the part of the text matched by a regular expression (REGEXP_EXTRACT); null when it does not match.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "pattern", label: "Pattern", kind: "text", placeholder: "(\\d{4})-(\\d{2})" },
      { key: "group", label: "Group", kind: "text", optional: true, placeholder: "1, or 0 for the whole match" },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      let re: RegExp;
      try {
        re = new RegExp(str(p, "pattern"));
      } catch {
        throw new Error(`Invalid regular expression "${str(p, "pattern")}"`);
      }
      if (!str(p, "pattern")) throw new Error("Enter a pattern");
      const groups = new RegExp(`${re.source}|`).exec("")!.length - 1;
      const group = str(p, "group") === "" ? (groups ? 1 : 0) : Math.trunc(Number(str(p, "group")));
      if (!(group >= 0 && group <= groups)) throw new Error(`The pattern has ${groups} group${groups === 1 ? "" : "s"}`);
      return setColumn(t, outputName(p), "String", (r) => {
        const v = r[col.name] ?? null;
        if (v === null) return null;
        return re.exec(String(v))?.[group] ?? null;
      });
    },
    summary: (p) => `${str(p, "column") || "?"} ~ /${str(p, "pattern")}/`,
  },
  {
    kind: "date_part",
    label: "Extract date part",
    category: "Datetime",
    description: "Reads a part of a date or timestamp (EXTRACT / YEAR() / MONTH() …), such as the year, month, ISO week, weekday or hour.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "part", label: "Part", kind: "select", options: DATE_PARTS },
      { key: "timezone", label: "Time zone", kind: "timezone", optional: true, help: "Wall-clock zone for timestamps; defaults to UTC." },
    ],
    output: true,
    outputDefault: (p) => slug(str(p, "part") || "Year").replace(/_1_monday$/, ""),
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const part = str(p, "part") || "Year";
      const zone = col.type === "Date" ? "" : str(p, "timezone");
      const named = part === "Month name" || part === "Day name";
      return setColumn(t, outputName(p, slug(part).replace(/_1_monday$/, "")), named ? "String" : part === "Epoch seconds" ? "Long" : "Integer", (r) => {
        const d = toDate(r[col.name] ?? null);
        return d ? datePart(d, wallClock(d, zone), part) : null;
      });
    },
    summary: (p) => `${(str(p, "part") || "Year").toLowerCase()}(${str(p, "column") || "?"})`,
  },
  {
    kind: "date_trunc",
    label: "Truncate date",
    category: "Datetime",
    description: "Rounds dates or timestamps to the start (DATE_TRUNC) or end (LAST_DAY) of a year, quarter, month, ISO week, day, hour or minute.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "edge", label: "Round to", kind: "select", options: ["Start", "End"], help: "End gives the last day (LAST_DAY) or last millisecond of the period." },
      { key: "unit", label: "Of the", kind: "select", options: TRUNC_UNITS },
      { key: "timezone", label: "Time zone", kind: "timezone", optional: true },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const unit = str(p, "unit") || "Year";
      const type = dateOut(col.type, unit);
      const zone = col.type === "Date" ? "" : str(p, "timezone");
      const end = str(p, "edge") === "End";
      return setColumn(t, outputName(p), type, (r) => {
        const d = toDate(r[col.name] ?? null);
        if (!d) return null;
        let w = truncDate(wallClock(d, zone), unit);
        if (end) w = new Date(addToDate(w, 1, `${unit}s`).getTime() - (type === "Date" ? DAY : 1));
        return writeDate(fromWallClock(w, zone), type);
      });
    },
    summary: (p) => `${str(p, "edge") === "End" ? "end" : "start"} of ${(str(p, "unit") || "Year").toLowerCase()} of ${str(p, "column") || "?"}`,
  },
  {
    kind: "date_add",
    label: "Add to date",
    category: "Datetime",
    description: "Adds (or, with a negative amount, subtracts) days, weeks, months, years, hours, minutes or seconds (DATE_ADD / ADD_MONTHS). Months keep the day, clamped to the month's end.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "amount", label: "Amount", kind: "text", placeholder: "number or column name, e.g. 7 or -1" },
      { key: "unit", label: "Unit", kind: "select", options: DATE_UNITS, help: "" },
    ],
    output: true,
    defaults: { unit: "Days" },
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const unit = str(p, "unit") || "Days";
      const amount = columnOrNumber(t, str(p, "amount"), "Amount");
      const type = dateOut(col.type, unit);
      return setColumn(t, outputName(p), type, (r) => {
        const d = toDate(r[col.name] ?? null);
        const n = amount(r);
        return d && n !== null ? writeDate(addToDate(d, n, unit), type) : null;
      });
    },
    summary: (p) => `${str(p, "column") || "?"} + ${str(p, "amount") || "?"} ${(str(p, "unit") || "Days").toLowerCase()}`,
  },
  {
    kind: "date_diff",
    label: "Date difference",
    category: "Datetime",
    description:
      "Units between two dates: end − start (DATEDIFF for days). Whole units are truncated toward zero; Months (fractional) is Spark's MONTHS_BETWEEN.",
    fields: [
      { key: "column", label: "End", kind: "column" },
      { key: "start", label: "Start", kind: "text", placeholder: "column name, a date such as 2024-01-01, or now" },
      { key: "unit", label: "Unit", kind: "select", options: DIFF_UNITS },
    ],
    output: true,
    defaults: { unit: "Days" },
    outputDefault: (p) => `${slug(str(p, "unit") || "Days")}_between`,
    run: (t, p) => {
      const end = need(t, str(p, "column"));
      const unit = str(p, "unit") || "Days";
      const startText = str(p, "start").trim();
      const startCol = t.columns.find((c) => c.name === startText);
      let fixed: Date | null = null;
      if (!startCol) {
        fixed = startText.toLowerCase() === "now" ? new Date() : toDate(startText);
        if (!fixed) throw new Error("Start must be a column name, a date, or now");
      }
      const fractional = unit === "Months (fractional)";
      // seconds or minutes across centuries exceed a 32-bit int
      return setColumn(t, outputName(p, `${slug(unit)}_between`), fractional ? "Double" : "Long", (r) => {
        const e = toDate(r[end.name] ?? null);
        const s = startCol ? toDate(r[startCol.name] ?? null) : fixed;
        if (!e || !s) return null;
        return fractional ? monthsBetween(e, s) : dateDiff(e, s, unit);
      });
    },
    summary: (p) => `${(str(p, "unit") || "Days").toLowerCase()} from ${str(p, "start") || "?"} to ${str(p, "column") || "?"}`,
  },
  {
    kind: "current_time",
    label: "Current date / timestamp",
    category: "Datetime",
    description: "Adds the date or time of the run (CURRENT_DATE / CURRENT_TIMESTAMP). It changes every time the pipeline is evaluated.",
    fields: [
      { key: "type", label: "Type", kind: "select", options: ["Timestamp", "Date"] },
      { key: "timezone", label: "Time zone", kind: "timezone", optional: true, help: "Which day it is for Date; defaults to UTC." },
    ],
    output: true,
    outputDefault: (p) => (str(p, "type") === "Date" ? "current_date" : "current_timestamp"),
    run: (t, p) => {
      const date = str(p, "type") === "Date";
      const now = new Date();
      const value = date ? isoDate(wallClock(now, str(p, "timezone"))) : now.toISOString();
      return setColumn(t, outputName(p, date ? "current_date" : "current_timestamp"), date ? "Date" : "Timestamp", () => value);
    },
    summary: (p) => (str(p, "type") === "Date" ? "current date" : "current timestamp"),
  },
  {
    kind: "format_date",
    label: "Format date",
    category: "Datetime",
    description: "Writes a date or timestamp as text with a pattern (DATE_FORMAT), e.g. dd MMM yyyy → 05 Jan 2024.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "pattern", label: "Pattern", kind: "text", placeholder: "yyyy-MM-dd HH:mm:ss", help: "y year, M month (MMM Jan, MMMM January), d day, E weekday, H/h hour, m minute, s second, a AM/PM, X offset, 'text' literal." },
      { key: "timezone", label: "Time zone", kind: "timezone", optional: true },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const pattern = str(p, "pattern") || "yyyy-MM-dd HH:mm:ss";
      formatDate(new Date(0), pattern); // fail early on a bad pattern
      const zone = col.type === "Date" ? "" : str(p, "timezone");
      return setColumn(t, outputName(p), "String", (r) => {
        const d = toDate(r[col.name] ?? null);
        if (!d) return null;
        return formatDate(wallClock(d, zone), pattern, zone && zone !== "UTC" ? zoneOffset(zone, d.getTime()) : 0);
      });
    },
    summary: (p) => `${str(p, "column") || "?"} as "${str(p, "pattern") || "yyyy-MM-dd HH:mm:ss"}"`,
  },
  {
    kind: "make_date",
    label: "Make date",
    category: "Datetime",
    description: "Builds a date from year, month and day columns or numbers (MAKE_DATE); invalid dates such as 31 February become null.",
    fields: [
      { key: "year", label: "Year", kind: "text", placeholder: "column name or number" },
      { key: "month", label: "Month", kind: "text", placeholder: "column name or number" },
      { key: "day", label: "Day", kind: "text", placeholder: "column name or number (default 1)" },
    ],
    output: true,
    outputDefault: "date",
    run: (t, p) => {
      const y = columnOrNumber(t, str(p, "year"), "Year");
      const m = columnOrNumber(t, str(p, "month"), "Month");
      const d = columnOrNumber(t, str(p, "day") || "1", "Day");
      return setColumn(t, outputName(p, "date"), "Date", (r) => {
        const [yy, mm, dd] = [y(r), m(r), d(r)];
        if (yy === null || mm === null || dd === null || [yy, mm, dd].some((x) => !Number.isInteger(x))) return null;
        // years 1–9999, as Spark's make_date
        if (yy < 1 || yy > 9999 || mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(yy, mm - 1)) return null;
        return isoDate(new Date(Date.UTC(yy, mm - 1, dd)));
      });
    },
    summary: (p) => `date(${str(p, "year") || "?"}, ${str(p, "month") || "?"}, ${str(p, "day") || "1"})`,
  },
  {
    kind: "reverse",
    label: "Reverse / repeat string",
    category: "String",
    description: "Reverses the characters of a text (REVERSE) or repeats it N times (REPEAT).",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "fn", label: "Function", kind: "select", options: ["Reverse", "Repeat"] },
      { key: "times", label: "Times", kind: "text", showIf: (p) => str(p, "fn") === "Repeat", placeholder: "2" },
    ],
    output: true,
    run: (t, p) => {
      const repeat = str(p, "fn") === "Repeat";
      const times = Math.trunc(Number(str(p, "times") || 2));
      if (repeat && !(times >= 0 && times <= 1000)) throw new Error("Times must be a whole number from 0 to 1000");
      return mapText(t, p, (s) => (repeat ? s.repeat(times) : [...s].reverse().join("")));
    },
    summary: (p) => (str(p, "fn") === "Repeat" ? `repeat(${str(p, "column") || "?"}, ${str(p, "times") || 2})` : `reverse(${str(p, "column") || "?"})`),
  },
  {
    kind: "similarity",
    label: "Text similarity",
    category: "String",
    description:
      "Compares two text columns (LEVENSHTEIN): the edit distance, or a similarity from 0 (different) to 1 (equal) — useful for fuzzy matching names or addresses.",
    fields: [
      { key: "column", label: "Text", kind: "column" },
      { key: "other", label: "Compare with", kind: "column" },
      { key: "measure", label: "Measure", kind: "select", options: ["Similarity (0–1)", "Edit distance"] },
      { key: "ignoreCase", label: "Ignore case and spaces at the ends", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: (p) => (str(p, "measure") === "Edit distance" ? "edit_distance" : "similarity"),
    run: (t, p) => {
      const a = need(t, str(p, "column"));
      const b = need(t, str(p, "other"));
      const distance = str(p, "measure") === "Edit distance";
      const norm = str(p, "ignoreCase") === "true" ? (x: string) => x.trim().toLowerCase() : (x: string) => x;
      return setColumn(t, outputName(p, distance ? "edit_distance" : "similarity"), distance ? "Integer" : "Double", (r) => {
        const x = r[a.name] ?? null;
        const y = r[b.name] ?? null;
        if (x === null || y === null) return null;
        const xs = [...norm(String(x))];
        const ys = [...norm(String(y))];
        const d = levenshtein(xs, ys);
        return distance ? d : Math.max(xs.length, ys.length) ? 1 - d / Math.max(xs.length, ys.length) : 1;
      });
    },
    summary: (p) => `${str(p, "measure") === "Edit distance" ? "levenshtein" : "similarity"}(${str(p, "column") || "?"}, ${str(p, "other") || "?"})`,
  },
  {
    kind: "sql",
    label: "SQL query",
    category: "SQL",
    description:
      "Runs a SQL query with Spark SQL's functions and CAST rules on SQLite (CTEs, joins, GROUP BY, window functions, CASE, subqueries…). Palantir's CREATE TABLE `/path` AS SELECT … form works. The step's input is the table input; other nodes are tables named after them (customers_raw_1) or by a backticked path ending in their name. The last statement's result becomes the output.",
    fields: [{ key: "query", label: "Query", kind: "sql" }],
    defaults: { query: "SELECT *\nFROM input" },
    run: (t, p, ctx) => {
      const query = str(p, "query").trim();
      if (!query) throw new Error("Write a query");
      const engine = ctx?.sql?.engine;
      if (!engine) throw new Error(ctx?.sql?.error ?? "Loading the SQL engine…");
      return engine.query(sqlTables(t, query, ctx), query);
    },
    summary: (p) => str(p, "query").replace(/\s+/g, " ").trim().slice(0, 120) || "?",
  },
  {
    kind: "array_fn",
    label: "Array function",
    category: "Array",
    description:
      "Works on a list held in a column — a JSON array such as [\"a\",\"b\"], or text with a separator: size, contains, position, element at, join, distinct, sort, reverse, slice, remove nulls, min, max, sum, mean (SIZE / ARRAY_CONTAINS / ELEMENT_AT / ARRAY_JOIN …). Array results stay JSON text.",
    fields: [
      { key: "column", label: "Array", kind: "column" },
      { key: "separator", label: "Separator", kind: "text", optional: true, placeholder: "empty = JSON array" },
      { key: "fn", label: "Function", kind: "select", options: ARRAY_FNS },
      { key: "value", label: "Value", kind: "text", optional: true, showIf: (p) => ["Contains", "Position of", "Add", "Remove"].includes(str(p, "fn")) },
      {
        key: "index",
        label: "Index",
        kind: "text",
        showIf: (p) => ["Element at", "Slice", "Add", "Repeat"].includes(str(p, "fn")),
        placeholder: "1",
        help: "1 = first element; negative counts from the end (-1 = last). Add: the position to insert at; Repeat: how many times.",
      },
      { key: "length", label: "Length", kind: "text", optional: true, showIf: (p) => str(p, "fn") === "Slice", placeholder: "to the end" },
      { key: "joinWith", label: "Join with", kind: "text", optional: true, showIf: (p) => str(p, "fn") === "Join", placeholder: ", " },
    ],
    output: true,
    outputDefault: (p) => `${slug(str(p, "fn") || "Size")}_${str(p, "column") || "array"}`,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const fn = str(p, "fn") || "Size";
      const sep = str(p, "separator");
      const raw = t.rows.map((r) => {
        const xs = readArray(r[col.name] ?? null, sep);
        return xs === null ? null : arrayResult(fn, xs, p);
      });
      const name = outputName(p, `${slug(fn)}_${col.name}`);
      if (ARRAY_RESULT.has(fn) || fn === "Join") {
        let i = 0;
        return setColumn(t, name, "String", () => {
          const v = raw[i++];
          return v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);
        });
      }
      const typed: ColType | null = fn === "Size" || fn === "Position of" ? "Integer" : fn === "Contains" || fn === "Contains null" || fn === "Elements are distinct" ? "Boolean" : fn === "Sum" || fn === "Mean" ? "Double" : null;
      const inferred = typed ? null : inferColumn(raw);
      let i = 0;
      return setColumn(t, name, typed ?? inferred!.type, () => (inferred ? inferred.values[i++] : ((raw[i++] ?? null) as Cell)));
    },
    summary: (p) => `${(str(p, "fn") || "Size").toLowerCase()}(${str(p, "column") || "?"}${["Contains", "Position of"].includes(str(p, "fn")) ? `, "${str(p, "value")}"` : ["Element at", "Slice"].includes(str(p, "fn")) ? `, ${str(p, "index") || 1}` : ""})`,
  },
  {
    kind: "make_array",
    label: "Create array",
    category: "Array",
    description: "Puts several columns or values into one JSON array column (ARRAY(a, b, c)).",
    fields: [
      { key: "columns", label: "Elements", kind: "expressions" },
      { key: "skipNulls", label: "Leave out nulls", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "array",
    defaults: { columns: ["", ""] },
    run: (t, p) => {
      const exprs = list(p, "columns");
      if (!exprs.length || exprs.some((e) => !e)) throw new Error("Complete every element");
      const parts = exprs.map((e): ((r: Row) => Cell) => {
        if (isLiteral(e)) return () => literalText(e);
        const c = need(t, e);
        return (r) => r[c.name] ?? null;
      });
      const skip = str(p, "skipNulls") === "true";
      return setColumn(t, outputName(p, "array"), "String", (r) => JSON.stringify(parts.map((f) => f(r)).filter((v) => !skip || v !== null)));
    },
    summary: (p) => `array(${list(p, "columns").map((e) => (isLiteral(e) ? JSON.stringify(literalText(e)) : e || "?")).join(", ")})`,
  },
  {
    kind: "string_fn",
    label: "String function",
    category: "String",
    description:
      "Spark string functions: ASCII, BASE64 / UNBASE64, HEX / UNHEX, ENCODE / DECODE (character sets), SOUNDEX, SUBSTRING_INDEX, TRANSLATE, FORMAT_NUMBER, BIN, CONV, SPLIT (to a JSON array) and INITCAP. Binary results are shown as base64.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "fn", label: "Function", kind: "select", options: STRING_FNS, optionLabel: sqlLabel(STRING_FN_SQL) },
      { key: "charset", label: "Character set", kind: "select", options: CHARSETS, showIf: (p) => ["Encode", "Decode"].includes(str(p, "fn")) },
      { key: "delimiter", label: "Delimiter", kind: "text", showIf: (p) => str(p, "fn") === "Substring index", placeholder: "." },
      {
        key: "count",
        label: "Count",
        kind: "text",
        showIf: (p) => str(p, "fn") === "Substring index",
        placeholder: "1",
        help: "Positive: text before the count-th delimiter. Negative: text after the count-th delimiter from the end.",
      },
      { key: "from", label: "Characters", kind: "text", showIf: (p) => str(p, "fn") === "Translate", placeholder: "abc" },
      { key: "to", label: "Replace with", kind: "text", optional: true, showIf: (p) => str(p, "fn") === "Translate", placeholder: "xyz", help: "Characters without a partner are removed." },
      { key: "decimals", label: "Decimals", kind: "text", showIf: (p) => str(p, "fn") === "Format number", placeholder: "2", help: "Rounded half to even, grouped with commas: 1,234.50" },
      { key: "fromBase", label: "From base", kind: "text", showIf: (p) => str(p, "fn") === "Convert base", placeholder: "10" },
      { key: "toBase", label: "To base", kind: "text", showIf: (p) => str(p, "fn") === "Convert base", placeholder: "16", help: "2–36; a negative base gives signed output." },
      { key: "pattern", label: "Split on (regex)", kind: "text", showIf: (p) => str(p, "fn") === "Split to array", placeholder: "," },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const fn = str(p, "fn") || STRING_FNS[0];
      if (fn === "Substring index" && !str(p, "delimiter")) throw new Error("Enter the delimiter");
      if (fn === "Translate" && !str(p, "from")) throw new Error("Enter the characters to translate");
      return setColumn(t, outputName(p), STRING_FN_TYPE[fn] ?? "String", (r) => stringFn(fn, r[col.name] ?? null, col.type, p));
    },
    summary: (p) => `${(STRING_FN_SQL[str(p, "fn") || STRING_FNS[0]] ?? str(p, "fn")).toLowerCase()}(${str(p, "column") || "?"})`,
  },
  {
    kind: "logical",
    label: "Null / boolean function",
    category: "Data preparation",
    description: "ISNULL, ISNOTNULL, NOT (inverts true / false), ISNAN and NANVL (replace NaN with another column or value).",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "fn", label: "Function", kind: "select", options: LOGICAL_FNS, optionLabel: sqlLabel(LOGICAL_SQL) },
      { key: "other", label: "Replacement", kind: "text", showIf: (p) => str(p, "fn") === "Replace NaN", placeholder: "column name or value" },
      { key: "emptyAsNull", label: "Treat empty strings as null", kind: "boolean", optional: true, showIf: (p) => ["Is null", "Is not null"].includes(str(p, "fn") || "Is null") },
    ],
    output: true,
    outputDefault: (p) => `${slug(str(p, "fn") || "Is null")}_${str(p, "column") || "value"}`,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const fn = str(p, "fn") || "Is null";
      const name = outputName(p, `${slug(fn)}_${col.name}`);
      const nullTest = str(p, "emptyAsNull") === "true" ? isEmpty : (v: Cell) => v === null;
      if (fn === "Replace NaN") {
        const other = str(p, "other").trim();
        const otherCol = t.columns.find((c) => c.name === other);
        return setColumn(t, name, col.type, (r) => {
          const v = r[col.name] ?? null;
          return isNaNCell(v) ? castCell(otherCol ? (r[otherCol.name] ?? null) : other, col.type) : v;
        });
      }
      return setColumn(t, name, "Boolean", (r) => {
        const v = r[col.name] ?? null;
        if (fn === "Is null") return nullTest(v);
        if (fn === "Is not null") return !nullTest(v);
        if (fn === "Is NaN") return isNaNCell(v);
        const b = castCell(v, "Boolean");
        return b === null ? null : !b;
      });
    },
    summary: (p) => `${(LOGICAL_SQL[str(p, "fn") || "Is null"] ?? "").toLowerCase()}(${str(p, "column") || "?"})`,
  },
  {
    kind: "struct_map",
    label: "Create struct / map",
    category: "Struct",
    description: "Builds a JSON object column: STRUCT(columns) names each field after its column; MAP(key, value, …) takes alternating keys and values.",
    fields: [
      { key: "mode", label: "Build", kind: "select", options: ["Struct", "Map"] },
      { key: "columns", label: "Fields", kind: "columns", showIf: (p) => str(p, "mode") !== "Map" },
      { key: "pairs", label: "Key, value, key, value…", kind: "expressions", showIf: (p) => str(p, "mode") === "Map" },
    ],
    output: true,
    outputDefault: (p) => (str(p, "mode") === "Map" ? "map" : "struct"),
    defaults: { pairs: ["", ""] },
    run: (t, p) => {
      if (str(p, "mode") === "Map") {
        const exprs = list(p, "pairs");
        if (!exprs.length || exprs.length % 2 || exprs.some((e) => !e)) throw new Error("Give keys and values in pairs: key, value, key, value…");
        const parts = exprs.map((e): ((r: Row) => Cell) => {
          if (isLiteral(e)) return () => literalText(e);
          const c = need(t, e);
          return (r) => r[c.name] ?? null;
        });
        return setColumn(t, outputName(p, "map"), "String", (r) => {
          const obj: Record<string, Cell> = {};
          for (let i = 0; i < parts.length; i += 2) {
            const k = parts[i](r);
            if (k === null) throw new Error("A map key is null");
            setField(obj, String(k), parts[i + 1](r));
          }
          return JSON.stringify(obj);
        });
      }
      const cols = list(p, "columns").map((c) => need(t, c).name);
      if (!cols.length) throw new Error("Choose the fields");
      return setColumn(t, outputName(p, "struct"), "String", (r) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
    },
    summary: (p) =>
      str(p, "mode") === "Map"
        ? `map(${list(p, "pairs").map((e) => (isLiteral(e) ? JSON.stringify(literalText(e)) : e || "?")).join(", ")})`
        : `struct(${list(p, "columns").join(", ") || "?"})`,
  },
  {
    kind: "unix_time",
    label: "Unix time",
    category: "Datetime",
    description:
      "UNIX_TIMESTAMP: a date, timestamp or text (read with the pattern) to seconds since 1970-01-01 UTC. FROM_UNIXTIME: seconds to text with the pattern.",
    fields: [
      { key: "mode", label: "Convert", kind: "select", options: ["To seconds", "From seconds"], optionLabel: sqlLabel({ "To seconds": "UNIX_TIMESTAMP", "From seconds": "FROM_UNIXTIME" }) },
      { key: "column", label: "Expression", kind: "column" },
      {
        key: "pattern",
        label: "Pattern",
        kind: "text",
        optional: true,
        placeholder: "yyyy-MM-dd HH:mm:ss",
        help: "To seconds: how text values are written (other forms are still tried). From seconds: the output format.",
      },
      { key: "timezone", label: "Time zone", kind: "timezone", optional: true, help: "For text without an offset, and for the output of From seconds; defaults to UTC." },
    ],
    output: true,
    outputDefault: (p) => (str(p, "mode") === "From seconds" ? "from_unixtime" : "unix_timestamp"),
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const pattern = str(p, "pattern").trim() || "yyyy-MM-dd HH:mm:ss";
      const zone = str(p, "timezone");
      if (zone) zoneOffset(zone, 0);
      if (str(p, "mode") === "From seconds") {
        formatDate(new Date(0), pattern);
        return setColumn(t, outputName(p, "from_unixtime"), "String", (r) => {
          const n = toNumber(r[col.name] ?? null);
          if (n === null) return null;
          const d = new Date(n * 1000);
          if (Number.isNaN(d.getTime())) return null;
          return formatDate(wallClock(d, zone), pattern, zone && zone !== "UTC" ? zoneOffset(zone, d.getTime()) : 0);
        });
      }
      const parse = compileDateFormat(pattern);
      return setColumn(t, outputName(p, "unix_timestamp"), "Long", (r) => {
        const v = r[col.name] ?? null;
        if (v === null) return null;
        let ms: number | null = null;
        if (typeof v === "string" && col.type === "String") {
          const iso = parseDateWith([parse], v, zone, "Timestamp");
          ms = iso ? Date.parse(iso) : (toDate(v)?.getTime() ?? null);
        } else if (col.type === "Date") {
          const d = toDate(v);
          ms = d ? fromWallClock(d, zone).getTime() : null;
        } else ms = toDate(v)?.getTime() ?? null;
        return ms === null ? null : Math.floor(ms / 1000);
      });
    },
    summary: (p) => `${str(p, "mode") === "From seconds" ? "from_unixtime" : "unix_timestamp"}(${str(p, "column") || "?"}${str(p, "pattern") ? `, "${str(p, "pattern")}"` : ""})`,
  },
  {
    kind: "tz_convert",
    label: "Convert time zone",
    category: "Datetime",
    description:
      "FROM_UTC_TIMESTAMP: reads the timestamp as UTC and shows the same moment's wall-clock time in a zone. TO_UTC_TIMESTAMP: reads it as wall-clock time in a zone and converts to UTC.",
    fields: [
      { key: "mode", label: "Convert", kind: "select", options: ["From UTC", "To UTC"], optionLabel: sqlLabel({ "From UTC": "FROM_UTC_TIMESTAMP", "To UTC": "TO_UTC_TIMESTAMP" }) },
      { key: "column", label: "Timestamp", kind: "column" },
      { key: "timezone", label: "Time zone", kind: "timezone" },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const zone = str(p, "timezone");
      if (!zone) throw new Error("Choose the time zone");
      zoneOffset(zone, 0);
      const toUtc = str(p, "mode") === "To UTC";
      return setColumn(t, outputName(p), "Timestamp", (r) => {
        const d = toDate(r[col.name] ?? null);
        if (!d) return null;
        return (toUtc ? fromWallClock(d, zone) : wallClock(d, zone)).toISOString();
      });
    },
    summary: (p) => `${str(p, "mode") === "To UTC" ? "to_utc_timestamp" : "from_utc_timestamp"}(${str(p, "column") || "?"}, ${str(p, "timezone") || "?"})`,
  },
  {
    kind: "next_day",
    label: "Next day of week",
    category: "Datetime",
    description: "The first date after each date that falls on the given weekday (NEXT_DAY), e.g. the next Monday.",
    fields: [
      { key: "column", label: "Date", kind: "column" },
      { key: "weekday", label: "Weekday", kind: "select", options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const target = WEEKDAYS[(str(p, "weekday") || "Monday").slice(0, 2).toLowerCase()];
      if (target === undefined) throw new Error("Choose a weekday");
      return setColumn(t, outputName(p), "Date", (r) => {
        const d = toDate(r[col.name] ?? null);
        if (!d) return null;
        const ahead = (target - d.getUTCDay() + 7) % 7 || 7;
        return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ahead)));
      });
    },
    summary: (p) => `next_day(${str(p, "column") || "?"}, ${(str(p, "weekday") || "Monday").slice(0, 3)})`,
  },
  {
    kind: "time_window",
    label: "Time window",
    category: "Datetime",
    description:
      "Buckets timestamps into fixed windows (WINDOW): adds window_start and window_end. With a slide shorter than the duration the windows overlap, and each row is repeated for every window it falls in.",
    fields: [
      { key: "column", label: "Timestamp", kind: "column" },
      { key: "duration", label: "Window duration", kind: "text", placeholder: "10 minutes", help: "e.g. 30 seconds, 10 minutes, 1 hour 30 minutes, 1 day, 1 week" },
      { key: "slide", label: "Slide", kind: "text", optional: true, placeholder: "same as the duration (tumbling)" },
      { key: "start", label: "Start offset", kind: "text", optional: true, placeholder: "0", help: "Shifts the windows, e.g. 15 minutes for hourly windows starting at :15." },
      { key: "prefix", label: "Column prefix", kind: "text", optional: true, placeholder: "window" },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const size = parseDuration(str(p, "duration"));
      const slide = str(p, "slide").trim() ? parseDuration(str(p, "slide")) : size;
      const offset = str(p, "start").trim() ? parseDuration(str(p, "start")) : 0;
      if (size <= 0 || slide <= 0) throw new Error("Durations must be greater than zero");
      if (slide > size) throw new Error("The slide must not be longer than the window duration");
      if (size / slide > 1000) throw new Error("That slide would put each row in more than 1,000 windows");
      const prefix = str(p, "prefix").trim() || "window";
      const startName = `${prefix}_start`;
      const endName = `${prefix}_end`;
      const rows: Row[] = [];
      for (const r of t.rows) {
        const d = toDate(r[col.name] ?? null);
        if (!d) {
          rows.push({ ...r, [startName]: null, [endName]: null });
          continue;
        }
        const ms = d.getTime();
        const last = Math.floor((ms - offset) / slide) * slide + offset;
        const starts: number[] = [];
        for (let s = last; s > ms - size; s -= slide) starts.unshift(s);
        for (const s of starts) rows.push({ ...r, [startName]: new Date(s).toISOString(), [endName]: new Date(s + size).toISOString() });
      }
      const columns = [...t.columns.filter((c) => c.name !== startName && c.name !== endName), { name: startName, type: "Timestamp" as ColType }, { name: endName, type: "Timestamp" as ColType }];
      return { columns, rows };
    },
    summary: (p) => `window(${str(p, "column") || "?"}, ${str(p, "duration") || "?"}${str(p, "slide") ? `, ${str(p, "slide")}` : ""})`,
  },
  {
    kind: "case_when",
    label: "Conditional column",
    category: "Conditional",
    description: "Sets a column from the first matching condition (CASE WHEN … THEN … ELSE … END). Rows that match no case get the Else value, or null.",
    fields: [
      { key: "cases", label: "Cases", kind: "cases" },
      { key: "type", label: "Output type", kind: "select", options: CASE_TYPES, help: "Auto uses the type shared by all results, else String." },
    ],
    output: true,
    outputDefault: "case_result",
    run: (t, p) => {
      const spec = readCases(p);
      if (!spec.cases.length) throw new Error("Add a case");
      const branches = spec.cases.map((b, i) => {
        try {
          // an empty THEN is null, as in the SQL engines (CASE WHEN … THEN NULL)
          return { test: compileGroup(t, b.when), value: b.then ? compileOperand(t, b.then) : () => null };
        } catch (e) {
          throw new Error(`Case ${i + 1}: ${(e as Error).message}`);
        }
      });
      let otherwise: (r: Row) => Cell = () => null;
      if (spec.else) {
        try {
          otherwise = compileOperand(t, spec.else);
        } catch (e) {
          throw new Error(`Else: ${(e as Error).message}`);
        }
      }
      let type: ColType | "Auto" = str(p, "type") === "Auto" || !str(p, "type") ? "Auto" : typeParam(p, "type", "String");
      if (type === "Auto") {
        const types = new Set(
          [...spec.cases.map((b) => b.then), spec.else]
            .filter((o): o is NonNullable<Operand> => !!o)
            .map((o) => (o.kind === "column" ? need(t, o.column).type : o.type)),
        );
        type = types.size === 1 ? [...types][0] : "String";
      }
      const to = type;
      return setColumn(t, outputName(p, "case_result"), to, (r) => {
        for (const b of branches) if (b.test(r)) return castCell(b.value(r), to);
        return castCell(otherwise(r), to);
      });
    },
    summary: (p) => {
      const spec = readCases(p);
      return `CASE ${spec.cases.map((b) => `WHEN ${describeGroup(b.when)} THEN ${operandText(b.then)}`).join(" ")} ELSE ${spec.else ? operandText(spec.else) : "null"} END`;
    },
  },
  {
    kind: "coalesce",
    label: "Coalesce",
    category: "Data preparation",
    description: "The first non-null value among several columns or values (COALESCE / IFNULL / NVL).",
    fields: [
      { key: "columns", label: "Expressions", kind: "expressions" },
      { key: "emptyAsNull", label: "Treat empty strings as null", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "coalesce",
    defaults: { columns: ["", ""] },
    run: (t, p) => {
      const exprs = list(p, "columns");
      if (!exprs.length || exprs.some((e) => !e)) throw new Error("Complete every expression");
      const parts = exprs.map((e): { get: (r: Row) => Cell; type: ColType } => {
        if (isLiteral(e)) return { get: () => literalText(e), type: "String" };
        const c = need(t, e);
        return { get: (r) => r[c.name] ?? null, type: c.type };
      });
      const types = new Set(parts.map((x) => x.type));
      const type: ColType = types.size === 1 ? parts[0].type : "String";
      const empty = str(p, "emptyAsNull") === "true" ? isEmpty : (v: Cell) => v === null;
      return setColumn(t, outputName(p, "coalesce"), type, (r) => {
        for (const part of parts) {
          const v = part.get(r);
          if (!empty(v)) return castCell(v, type);
        }
        return null;
      });
    },
    summary: (p) => `coalesce(${list(p, "columns").map((e) => (isLiteral(e) ? JSON.stringify(literalText(e)) : e || "?")).join(", ")})`,
  },
  {
    kind: "nullif",
    label: "Null if",
    category: "Data preparation",
    description: "Turns a specific value into null (NULLIF), e.g. 0, \"N/A\" or \"-\".",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "value", label: "Value", kind: "text", placeholder: "N/A" },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const value = str(p, "value");
      return setColumn(t, outputName(p), col.type, (r) => {
        const v = r[col.name] ?? null;
        return v !== null && looseCompare(v, value) === 0 ? null : v;
      });
    },
    summary: (p) => `nullif(${str(p, "column") || "?"}, "${str(p, "value")}")`,
  },
  {
    kind: "greatest",
    label: "Greatest / least",
    category: "Data preparation",
    description: "The largest or smallest value across several columns in each row (GREATEST / LEAST); nulls are skipped.",
    fields: [
      { key: "fn", label: "Function", kind: "select", options: ["Greatest", "Least"] },
      { key: "columns", label: "Columns", kind: "columns" },
    ],
    output: true,
    outputDefault: (p) => (str(p, "fn") === "Least" ? "least" : "greatest"),
    run: (t, p) => {
      const cols = list(p, "columns").map((c) => need(t, c));
      if (cols.length < 2) throw new Error("Choose at least two columns");
      const types = new Set(cols.map((c) => c.type));
      const numeric = [...types].every(isNumericType);
      const type: ColType = types.size === 1 ? cols[0].type : numeric ? "Double" : "String";
      const least = str(p, "fn") === "Least";
      return setColumn(t, outputName(p, least ? "least" : "greatest"), type, (r) => {
        let best: Cell = null;
        for (const c of cols) {
          const v = castCell(r[c.name] ?? null, type);
          if (isEmpty(v)) continue;
          if (best === null || (least ? compareCells(v, best) < 0 : compareCells(v, best) > 0)) best = v;
        }
        return best;
      });
    },
    summary: (p) => `${(str(p, "fn") || "Greatest").toLowerCase()}(${list(p, "columns").join(", ") || "?"})`,
  },
  {
    kind: "row_id",
    label: "Add row ID",
    category: "Data preparation",
    description: "Adds a row number (1, 2, 3 … in the current order) or a random UUID per row. UUIDs change every time the pipeline is evaluated.",
    fields: [{ key: "mode", label: "ID", kind: "select", options: ["Row number", "UUID"] }],
    output: true,
    outputDefault: "row_id",
    run: (t, p) => {
      const uuid = str(p, "mode") === "UUID";
      let i = 0;
      return setColumn(t, outputName(p, "row_id"), uuid ? "String" : "Integer", () => (uuid ? crypto.randomUUID() : ++i));
    },
    summary: (p) => (str(p, "mode") === "UUID" ? "UUID" : "row number"),
  },
  {
    kind: "hash",
    label: "Hash columns",
    category: "Data preparation",
    description:
      "Hashes one or more columns: SHA2 (224 / 256 / 384 / 512), SHA1, MD5 and CRC32 over the values joined with | (nulls as empty text; a single binary column is hashed as its bytes), or Spark's HASH (Murmur3, seed 42, by column type) — e.g. a stable key for deduplication or to mask personal data.",
    fields: [
      { key: "columns", label: "Columns", kind: "columns" },
      { key: "algorithm", label: "Algorithm", kind: "select", options: HASH_ALGORITHMS },
    ],
    output: true,
    outputDefault: "hash",
    run: (t, p) => {
      const cols = list(p, "columns").map((c) => need(t, c));
      if (!cols.length) throw new Error("Choose the columns to hash");
      const alg = (str(p, "algorithm") || "SHA-256") as (typeof HASH_ALGORITHMS)[number];
      if (alg === "Murmur3 (HASH)")
        return setColumn(t, outputName(p, "hash"), "Integer", (r) => cols.reduce((seed, c) => sparkHash(r[c.name] ?? null, c.type, seed), 42));
      const fn = { "SHA-256": sha256, "SHA-224": sha224, "SHA-384": sha384, "SHA-512": sha512, "SHA-1": sha1, MD5: md5, CRC32: crc32 }[alg];
      if (!fn) throw new Error(`Unknown algorithm "${alg}"`);
      const binary = cols.length === 1 && cols[0].type === "Binary";
      return setColumn(t, outputName(p, "hash"), alg === "CRC32" ? "Long" : "String", (r) => {
        if (binary) {
          const v = r[cols[0].name] ?? null;
          const bytes = v === null ? null : base64ToBytes(String(v));
          return bytes ? fn(bytes) : null;
        }
        return fn(cols.map((c) => (r[c.name] === null || r[c.name] === undefined ? "" : String(r[c.name]))).join("|"));
      });
    },
    summary: (p) => `${str(p, "algorithm") || "SHA-256"}(${list(p, "columns").join(", ") || "?"})`,
  },
  cipherStep("cipher_encrypt", "Cipher encrypt", "encrypt",
    "Encrypts a String column with a Cipher license (Data Manager or Admin, encrypt permission): values become CIPHER::<channel>::…::CIPHER. Optionally only the parts matching a regex. Previews show a placeholder; data is encrypted at build time."),
  cipherStep("cipher_decrypt", "Cipher decrypt", "decrypt",
    "Decrypts a column encrypted with Cipher, with a license of the same channel (Data Manager or Admin, decrypt permission). Previews show a placeholder; data is decrypted at build time."),
  cipherStep("cipher_hash", "Cipher hash", "hash",
    "Hashes a String column with a Cipher hashing channel's pepper (SHA-256 / SHA-512) through a license with encrypt permission. Optionally only the parts matching a regex. Previews show a placeholder."),
];

/** Pipeline Builder's Cipher steps: the column goes to the API (api/cipher.py) in chunks when the pipeline builds. */
function cipherStep(kind: string, label: string, operation: "encrypt" | "decrypt" | "hash", description: string): StepDef {
  return {
    kind,
    label,
    category: "Data preparation",
    description,
    fields: [
      { key: "column", label: "Expression (column)", kind: "column" },
      { key: "license", label: "Cipher license", kind: "cipherLicense", cipherOperation: operation, placeholder: "ri.bellaso.main.cipher-license.…" },
      ...(operation !== "decrypt" ? [{ key: "regex", label: "Only matches of (regex)", kind: "text" as const, optional: true, placeholder: "all of the value" }] : []),
    ],
    output: true,
    outputDefault: operation === "decrypt" ? "decrypted" : operation === "hash" ? "hashed" : "encrypted",
    run: (t, p, ctx) => {
      const col = need(t, str(p, "column"));
      const license = str(p, "license").trim();
      if (!license) throw new Error("Choose a Cipher license");
      const out = outputName(p, operation === "decrypt" ? "decrypted" : operation === "hash" ? "hashed" : "encrypted");
      const values = t.rows.map((r) => (r[col.name] === null || r[col.name] === undefined ? null : String(r[col.name])));
      let result: (string | null)[];
      if (ctx?.preview) {
        // as in the reference: previews show a placeholder, the real operation runs at build time
        result = values.map((v) => (v === null ? null : `<${operation}ed at build time>`));
      } else {
        result = [];
        const CHUNK = 2000;
        for (let i = 0; i < values.length; i += CHUNK) {
          const part = values.slice(i, i + CHUNK);
          const regex = str(p, "regex");
          const key = `cipher:${license}:${operation}:${regex}:${keyHash(JSON.stringify(part))}`;
          const v = service(ctx, "cipher", key, { license, operation, values: part, ...(regex ? { regex } : {}) }) as (string | null)[] | undefined;
          result.push(...(v ?? part.map(() => null)));
        }
      }
      const index = new Map(t.rows.map((r, i) => [r, i]));
      return setColumn(t, out, "String", (r) => result[index.get(r) ?? -1] ?? null);
    },
    summary: (p) => `${operation} ${str(p, "column") || "?"}`,
  };
}


// ---------------------------------------------------------------- steps that wait for the API (parsing, media, embeddings)

/** Looks up an async value; asks for it when missing. Returns undefined while it is computed. */
function service(ctx: StepContext | undefined, kind: ServiceRequest["kind"], key: string, payload: Record<string, unknown>): unknown {
  const s = ctx?.services;
  if (!s) throw new Error("This transform is computed when the pipeline runs");
  const a = s.get(key);
  if (!a) {
    s.request({ key, kind, payload });
    if (ctx.pending) ctx.pending.count++;
    return undefined;
  }
  if ("error" in a) throw new Error(a.error);
  return a.value;
}

/** Like service() but a failed row gives null (and the error text) instead of failing the step. */
function serviceCell(ctx: StepContext | undefined, kind: ServiceRequest["kind"], key: string, payload: Record<string, unknown>): { value: unknown; error?: string } {
  const s = ctx?.services;
  if (!s) throw new Error("This transform is computed when the pipeline runs");
  const a = s.get(key);
  if (!a) {
    s.request({ key, kind, payload });
    if (ctx.pending) ctx.pending.count++;
    return { value: undefined };
  }
  return "error" in a ? { value: null, error: a.error } : { value: a.value };
}

/** cyrb53 (as in llm.ts), kept here so the engine has no import cycle for keys. */
function keyHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const fileBody = (f: DataFile) => (f.encoding === "base64" ? { base64: f.text } : { text: f.text });

/** Parses each file through the API's parsers and stacks the tables (with an optional file_path column). */
function parseFiles(t: Table, p: Params, ctx: StepContext | undefined, format: string, accept: RegExp, options: Record<string, unknown> = {}): Table {
  const files = inputFiles(t).filter((f) => accept.test(f.path));
  if (!files.length) throw new Error(`The dataset has no ${format} files`);
  const tables: Table[] = [];
  for (const f of files) {
    const key = `parse:${format}:${keyHash(JSON.stringify(options) + f.path + f.text.length + f.text.slice(0, 2000) + f.text.slice(-2000))}`;
    const v = service(ctx, "parse", key, { format, name: f.path, ...fileBody(f), ...options }) as Table | undefined;
    if (!v) continue;
    const table = { columns: v.columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type) ? c.type : "String") as ColType })), rows: v.rows };
    tables.push(withPath(table, table.rows.map(() => f.path), str(p, "includePath") === "true"));
  }
  if (!tables.length) return { columns: [{ name: "status", type: "String" }], rows: [] };
  return union(tables);
}

/** Media references: a Files item id, optionally with #page=N / #rotate=D. */
const mediaRef = (v: Cell): string | null => (v === null || v === "" ? null : String(v));
const withRefParam = (ref: string, key: string, value: string | number) => {
  const [id, frag = ""] = ref.split("#");
  const params = new URLSearchParams(frag);
  params.set(key, String(value));
  return `${id}#${params.toString()}`;
};

/** Rows an async media / embedding step computes: all of them in builds, the first ones in previews. */
const asyncRows = (t: Table, ctx: StepContext | undefined) => (ctx?.preview ? Math.min(t.rows.length, LLM_PREVIEW_ROWS) : t.rows.length);

function mediaStep(t: Table, p: Params, ctx: StepContext | undefined, method: string, outType: ColType, describe: (v: unknown) => Cell, extra: Record<string, string> = {}): Table {
  const col = need(t, str(p, "column"));
  const n = asyncRows(t, ctx);
  const out = outputName(p, method === "metadata" ? "media_metadata" : "text");
  const errCol = str(p, "errors") === "true" ? `${out}_error` : "";
  const rows = t.rows.slice(0, n).map((r) => {
    const ref = mediaRef(r[col.name] ?? null);
    if (!ref) return { ...r, [out]: null, ...(errCol ? { [errCol]: null } : {}) };
    const c = serviceCell(ctx, "media", `media:${method}:${JSON.stringify(extra)}:${ref}`, { item_id: ref, method, max_pages: Number(str(p, "maxPages") || 50), ...extra });
    return { ...r, [out]: c.value === undefined || c.value === null ? null : describe(c.value), ...(errCol ? { [errCol]: c.error ?? null } : {}) };
  });
  const columns = [...t.columns.filter((c) => c.name !== out && c.name !== errCol), { name: out, type: outType }, ...(errCol ? [{ name: errCol, type: "String" as ColType }] : [])];
  return { columns, rows };
}

const GEO_UNITS: Record<string, number> = { kilometers: 6371.0088, meters: 6371008.8, miles: 3958.7613, "nautical miles": 3440.0695 };
const toRad = (d: number) => (d * Math.PI) / 180;
function haversine(lat1: number, lon1: number, lat2: number, lon2: number, radius: number): number {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}
const GEOHASH = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohash(lat: number, lon: number, precision: number): string {
  let [latLo, latHi, lonLo, lonHi] = [-90, 90, -180, 180];
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) {
        ch |= 16 >> bit;
        lonLo = mid;
      } else lonHi = mid;
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch |= 16 >> bit;
        latLo = mid;
      } else latHi = mid;
    }
    even = !even;
    if (bit < 4) bit++;
    else {
      hash += GEOHASH[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}
type Geometry = { type: string; coordinates: unknown };
function readGeometry(v: Cell): Geometry | null {
  if (v === null || v === "") return null;
  try {
    const g = JSON.parse(String(v));
    if (g && typeof g === "object" && "type" in g) return g.type === "Feature" ? (g.geometry as Geometry) : (g as Geometry);
  } catch {}
  const wkt = /^\s*POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(String(v));
  return wkt ? { type: "Point", coordinates: [Number(wkt[1]), Number(wkt[2])] } : null;
}
function allPositions(g: Geometry): number[][] {
  const out: number[][] = [];
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === "number") out.push(c as number[]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(g.coordinates);
  return out;
}
function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeometry(x: number, y: number, g: Geometry): boolean {
  const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
  return polys.some((rings) => pointInRing(x, y, rings[0]) && !rings.slice(1).some((hole) => pointInRing(x, y, hole)));
}


// ---- coordinate reference systems (Foundry's maps expect WGS 84): geographic, Web / World Mercator and UTM zones
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** EPSG codes this engine converts: WGS 84 (4326) and datums within about a metre of it (NAD83 4269, DGN95 4755, ETRS89 4258), Web Mercator (3857), World Mercator (3395), UTM on WGS 84 (326zz north, 327zz south) or NAD83 (269zz) */
export const PB_CRS: { code: string; label: string }[] = [
  { code: "EPSG:4326", label: "WGS 84 (latitude / longitude)" },
  { code: "EPSG:3857", label: "Web Mercator" },
  { code: "EPSG:3395", label: "World Mercator" },
  { code: "EPSG:4269", label: "NAD83" },
  { code: "EPSG:4755", label: "DGN95 (Indonesia)" },
  { code: "EPSG:32748", label: "UTM zone 48S (WGS 84)" },
  { code: "EPSG:32749", label: "UTM zone 49S (WGS 84)" },
  { code: "EPSG:32610", label: "UTM zone 10N (WGS 84)" },
  { code: "EPSG:26910", label: "UTM zone 10N (NAD83)" },
];
type Crs = { kind: "geo" } | { kind: "webmerc" } | { kind: "merc" } | { kind: "utm"; zone: number; south: boolean };
function parseCrs(code: string): Crs {
  const m = /^\s*(?:EPSG:)?(\d{4,5})\s*$/i.exec(code);
  const n = m ? Number(m[1]) : NaN;
  if ([4326, 4269, 4755, 4258, 4283].includes(n)) return { kind: "geo" };
  if ([3857, 900913, 3785].includes(n)) return { kind: "webmerc" };
  if (n === 3395) return { kind: "merc" };
  if (n >= 32601 && n <= 32660) return { kind: "utm", zone: n - 32600, south: false };
  if (n >= 32701 && n <= 32760) return { kind: "utm", zone: n - 32700, south: true };
  if (n >= 26901 && n <= 26923) return { kind: "utm", zone: n - 26900, south: false };
  if (n >= 23830 && n <= 23845) throw new Error(`${code} (DGN95 / Indonesia TM-3) needs Python transforms (pyproj): this engine converts ${PB_CRS.map((c) => c.code).join(", ")} and any UTM zone`);
  throw new Error(`Unsupported coordinate reference system "${code}": use ${PB_CRS.map((c) => c.code).join(", ")} or any UTM zone (EPSG:326zz / 327zz / 269zz)`);
}
/** UTM (transverse Mercator, k0 0.9996) ↔ latitude / longitude on the WGS 84 ellipsoid (Snyder's series). */
function utmForward(lat: number, lon: number, zone: number, south: boolean): [number, number] {
  const k0 = 0.9996;
  const e2 = WGS84_E2;
  const ep2 = e2 / (1 - e2);
  const phi = toRad(lat);
  const lon0 = toRad((zone - 1) * 6 - 180 + 3);
  const N = WGS84_A / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (toRad(lon) - lon0);
  const M =
    WGS84_A *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let y = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (south) y += 10000000;
  return [x, y];
}
function utmInverse(x: number, y: number, zone: number, south: boolean): [number, number] {
  const k0 = 0.9996;
  const e2 = WGS84_E2;
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const M = (south ? y - 10000000 : y) / k0;
  const mu = M / (WGS84_A * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const phi1 =
    mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const N1 = WGS84_A / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const T1 = Math.tan(phi1) ** 2;
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const R1 = (WGS84_A * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = (x - 500000) / (N1 * k0);
  const lat =
    phi1 - ((N1 * Math.tan(phi1)) / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / Math.cos(phi1);
  return [(lat * 180) / Math.PI, (zone - 1) * 6 - 180 + 3 + (lon * 180) / Math.PI];
}
/** [x, y] in a CRS → [longitude, latitude] (geographic CRSs take [longitude, latitude]). */
function crsToLonLat(c: Crs, x: number, y: number): [number, number] {
  if (c.kind === "geo") return [x, y];
  if (c.kind === "webmerc") return [((x / WGS84_A) * 180) / Math.PI, (Math.atan(Math.sinh(y / WGS84_A)) * 180) / Math.PI];
  if (c.kind === "merc") {
    // World Mercator on the ellipsoid: iterate the conformal latitude
    const e = Math.sqrt(WGS84_E2);
    const t = Math.exp(-y / WGS84_A);
    let phi = Math.PI / 2 - 2 * Math.atan(t);
    for (let i = 0; i < 10; i++) phi = Math.PI / 2 - 2 * Math.atan(t * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
    return [((x / WGS84_A) * 180) / Math.PI, (phi * 180) / Math.PI];
  }
  const [lat, lon] = utmInverse(x, y, c.zone, c.south);
  return [lon, lat];
}
function lonLatToCrs(c: Crs, lon: number, lat: number): [number, number] {
  if (c.kind === "geo") return [lon, lat];
  if (c.kind === "webmerc") return [toRad(lon) * WGS84_A, Math.log(Math.tan(Math.PI / 4 + toRad(Math.max(-85.06, Math.min(85.06, lat))) / 2)) * WGS84_A];
  if (c.kind === "merc") {
    const e = Math.sqrt(WGS84_E2);
    const phi = toRad(lat);
    return [toRad(lon) * WGS84_A, WGS84_A * Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2))];
  }
  return utmForward(lat, lon, c.zone, c.south);
}
function mapPositions(g: Geometry, fn: (p: number[]) => number[]): Geometry {
  const walk = (c: unknown): unknown => (Array.isArray(c) && typeof c[0] === "number" ? fn(c as number[]) : Array.isArray(c) ? c.map(walk) : c);
  return { type: g.type, coordinates: walk(g.coordinates) };
}
const round9 = (v: number) => Math.round(v * 1e9) / 1e9;
/** Spherical excess area of a ring of [lon, lat] (m²; > 0 counter-clockwise). */
function ringArea(ring: number[][]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    s += toRad(x2 - x1) * (2 + Math.sin(toRad(y1)) + Math.sin(toRad(y2)));
  }
  // the sum is negative for a counter-clockwise ring
  return (-s * GEO_UNITS.meters ** 2) / 2;
}
function geometryArea(g: Geometry): number {
  const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
  return polys.reduce((s, rings) => s + Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);
}
function geometryLength(g: Geometry): number {
  const lines =
    g.type === "LineString"
      ? [g.coordinates as number[][]]
      : g.type === "MultiLineString" || g.type === "Polygon"
        ? (g.coordinates as number[][][])
        : g.type === "MultiPolygon"
          ? (g.coordinates as number[][][][]).flat()
          : [];
  return lines.reduce((s, pts) => s + pts.slice(1).reduce((d, q, i) => d + haversine(pts[i][1], pts[i][0], q[1], q[0], GEO_UNITS.meters), 0), 0);
}
/** Why a GeoJSON value is not a valid Ontology geoshape (RFC 7946, WGS 84, closed counter-clockwise rings); null if valid. */
export function geoshapeProblem(v: Cell): string | null {
  if (v === null || v === "") return null;
  let g: { type?: string; coordinates?: unknown };
  try {
    g = JSON.parse(String(v));
  } catch {
    return "not valid JSON";
  }
  if (!g || typeof g !== "object" || !g.type) return "not GeoJSON";
  if (["Feature", "FeatureCollection", "GeometryCollection"].includes(g.type)) return `a geoshape must be a geometry, not a ${g.type}`;
  if (!["LineString", "Polygon", "MultiLineString", "MultiPolygon", "MultiPoint", "Point"].includes(g.type)) return `${g.type} is not a GeoJSON geometry type`;
  const pts = allPositions(g as Geometry);
  if (!pts.length) return "no coordinates";
  if (pts.some((p) => !(Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90))) return "coordinates are not WGS 84 longitude, latitude";
  const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]) : [];
  for (const rings of polys)
    for (const [i, r] of rings.entries()) {
      if (r.length < 4) return "a polygon ring needs at least four positions";
      if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) return "polygon rings must be closed";
      const a = ringArea(r);
      if (i === 0 && a < 0) return "the exterior ring must be counter-clockwise";
      if (i > 0 && a > 0) return "holes must be clockwise";
    }
  return null;
}

/** Text split into chunks: by characters (with overlap), sentences, paragraphs or a separator. */
/** The separators of the Recursive strategy, highest priority first: "|"-separated, with \n and \t escapes. */
export const DEFAULT_SEPARATORS = "\\n\\n|\\n|. | ";

export function parseSeparators(spec: string): string[] {
  return (spec || DEFAULT_SEPARATORS).split("|").map((s) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t")).filter((s) => s !== "");
}

/** Pieces merged into chunks of at most `size` characters, each starting with up to `overlap` characters of the previous one's pieces. */
function mergePieces(pieces: string[], sep: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const total = (xs: string[]) => xs.reduce((a, x) => a + x.length, 0) + Math.max(0, xs.length - 1) * sep.length;
  for (const p of pieces) {
    if (cur.length && total(cur) + sep.length + p.length > size) {
      out.push(cur.join(sep));
      while (cur.length && (total(cur) > overlap || total(cur) + sep.length + p.length > size)) cur = cur.slice(1);
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur.join(sep));
  return out.map((c) => c.trim()).filter(Boolean);
}

/** Recursive splitting (as LangChain's RecursiveCharacterTextSplitter): split on the first separator that occurs,
 * split pieces still longer than `size` with the next separators (characters last), then merge pieces up to `size`. */
export function chunkRecursive(text: string, separators: string[], size: number, overlap: number): string[] {
  const i = separators.findIndex((s) => text.includes(s));
  if (i < 0) {
    const out: string[] = [];
    const step = Math.max(1, size - Math.min(overlap, size - 1));
    for (let k = 0; k < text.length; k += step) {
      out.push(text.slice(k, k + size));
      if (k + size >= text.length) break;
    }
    return out;
  }
  const sep = separators[i];
  const rest = separators.slice(i + 1);
  const out: string[] = [];
  let small: string[] = [];
  for (const part of text.split(sep)) {
    if (part.length <= size) {
      if (part.trim()) small.push(part);
      continue;
    }
    out.push(...mergePieces(small, sep, size, overlap));
    small = [];
    out.push(...chunkRecursive(part, rest, size, overlap));
  }
  out.push(...mergePieces(small, sep, size, overlap));
  return out;
}

export function chunkText(text: string, strategy: string, size: number, overlap: number, separator: string): string[] {
  if (!text) return [];
  if (strategy === "Recursive") return chunkRecursive(text, parseSeparators(separator), size, overlap);
  if (strategy === "Separator") return text.split(separator || "\n").map((s) => s.trim()).filter(Boolean);
  const units =
    strategy === "Sentences"
      ? text.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) ?? [text]
      : strategy === "Paragraphs"
        ? text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
        : null;
  if (!units) {
    const step = Math.max(1, size - Math.min(overlap, size - 1));
    const out: string[] = [];
    for (let i = 0; i < text.length; i += step) {
      out.push(text.slice(i, i + size));
      if (i + size >= text.length) break;
    }
    return out;
  }
  // group units into chunks of about `size` characters
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length > size) {
      out.push(cur.trim());
      cur = "";
    }
    cur += (cur && strategy === "Paragraphs" ? "\n\n" : "") + u;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The Text to embeddings step's models: providers' models, then registered ones ("function:<id>", functions
 *  implementing the Embedding function interface) added by addRegisteredEmbeddingModels. */
export const EMBEDDING_MODELS: string[] = ["baai/bge-m3", "openai/text-embedding-3-small", "openai/text-embedding-3-large", "intfloat/multilingual-e5-large", "qwen/qwen3-embedding-8b"];
const EMBEDDING_LABELS: Record<string, string> = {};
/** Add registered embedding models to the step's choices (once each); returns whether any was new. */
export function addRegisteredEmbeddingModels(models: { id: string; label: string; dimension?: number | null }[]): boolean {
  let added = false;
  for (const m of models) {
    EMBEDDING_LABELS[m.id] = m.label;
    if (m.dimension) EMBEDDING_DIMS[m.id] = m.dimension;
    if (!EMBEDDING_MODELS.includes(m.id)) {
      EMBEDDING_MODELS.push(m.id);
      added = true;
    }
  }
  return added;
}
/** a registered model's own dimension (0: the one it answers) when unknown here; providers' default 1024 */
const embeddingDim = (model: string) => EMBEDDING_DIMS[model] ?? (model.startsWith("function:") ? 0 : 1024);
const EMBEDDING_DIMS: Record<string, number> = {
  "baai/bge-m3": 1024,
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "intfloat/multilingual-e5-large": 1024,
  "qwen/qwen3-embedding-8b": 4096,
};

const EXTRA_STEPS: StepDef[] = [
  {
    kind: "title_case",
    label: "Title case",
    category: "String",
    description: "Converts text so each word starts with an upper-case letter and the rest is lower case, e.g. \"gold MEMBER\" → \"Gold Member\".",
    fields: [{ key: "column", label: "Expression", kind: "column" }],
    output: true,
    run: (t, p) => mapText(t, p, (s) => s.toLowerCase().replace(/(^|[\s\-_/(])\p{L}/gu, (m) => m.toUpperCase())),
    summary: (p) => str(p, "column"),
  },
  {
    kind: "key_by",
    label: "Key by",
    category: "Streaming",
    description:
      "Sets the stream's keys, replacing the keys of its input. Partition key columns keep the order of records with the same values. CDC mode also sets them as the primary key: the output stream is a changelog that CDC-aware readers resolve to the latest record per key (and drop keys whose latest record is deleted).",
    fields: [
      { key: "columns", label: "Key by columns", kind: "columns" },
      { key: "cdc", label: "CDC mode (primary key)", kind: "boolean", optional: true },
      { key: "deleted", label: "Primary key is deleted", kind: "column", optional: true, showIf: (p) => p.cdc === "true", help: "A Boolean column; true deletes the key." },
    ],
    run: (t, p) => {
      const cols = list(p, "columns");
      if (!cols.length) throw new Error("Choose the key columns");
      for (const c of cols) need(t, c);
      if (p.cdc === "true" && str(p, "deleted")) need(t, str(p, "deleted"));
      return t;
    },
    summary: (p) => `${list(p, "columns").join(", ") || "?"}${p.cdc === "true" ? " (CDC)" : ""}`,
  },
  {
    kind: "uppercase",
    label: "Uppercase",
    category: "String",
    description: "Converts text to upper case.",
    fields: [{ key: "column", label: "Expression", kind: "column" }],
    output: true,
    run: (t, p) => mapText(t, p, (s) => s.toUpperCase()),
    summary: (p) => str(p, "column"),
  },
  {
    kind: "lowercase",
    label: "Lowercase",
    category: "String",
    description: "Converts text to lower case.",
    fields: [{ key: "column", label: "Expression", kind: "column" }],
    output: true,
    run: (t, p) => mapText(t, p, (s) => s.toLowerCase()),
    summary: (p) => str(p, "column"),
  },
  {
    kind: "clean_string",
    label: "Clean string",
    category: "String",
    description: "Cleans text with the actions you check: convert empty strings to null, reduce runs of whitespace to one space, and trim whitespace at both ends.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "emptyToNull", label: "Converts empty strings to null", kind: "boolean", optional: true },
      { key: "collapse", label: "Reduce sequences of multiple whitespace characters to a single whitespace", kind: "boolean", optional: true },
      { key: "trim", label: "Trims whitespace at beginning and end of string", kind: "boolean", optional: true },
    ],
    defaults: { emptyToNull: "true", collapse: "true", trim: "true" },
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      return setColumn(t, outputName(p), "String", (r) => {
        const v = r[col.name];
        if (v === null || v === undefined) return null;
        let s = String(v);
        if (str(p, "collapse") === "true") s = s.replace(/\s+/g, " ");
        if (str(p, "trim") === "true") s = s.trim();
        if (str(p, "emptyToNull") === "true" && s === "") return null;
        return s;
      });
    },
    summary: (p) =>
      `${str(p, "column")}${[str(p, "emptyToNull") === "true" ? " empty→null" : "", str(p, "collapse") === "true" ? " collapse" : "", str(p, "trim") === "true" ? " trim" : ""].join("")}`,
  },
  {
    kind: "sha256",
    label: "Hash sha256",
    category: "String",
    description: "The SHA-256 hash of a value as 64 hexadecimal characters (sha2(x, 256) in Spark).",
    fields: [{ key: "column", label: "Expression", kind: "column" }],
    output: true,
    outputDefault: "sha256",
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      return setColumn(t, outputName(p, "sha256"), "String", (r) => (r[col.name] === null || r[col.name] === undefined ? null : sha256(String(r[col.name]))));
    },
    summary: (p) => str(p, "column"),
  },
  {
    kind: "chunk",
    label: "Chunk string",
    category: "String",
    description:
      "Splits long text into chunks for embeddings and semantic search: by characters (with overlap), sentences, paragraphs, a separator, or recursively over a prioritized list of separators (paragraphs, then lines, sentences, words) merged up to the chunk size with overlap. Each chunk becomes a row with its chunk_index; the other columns are repeated.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "strategy", label: "Strategy", kind: "select", options: ["Characters", "Sentences", "Paragraphs", "Separator", "Recursive"] },
      { key: "size", label: "Chunk size (characters)", kind: "text", placeholder: "1000", showIf: (p) => str(p, "strategy") !== "Separator" },
      { key: "overlap", label: "Overlap (characters)", kind: "text", placeholder: "100", showIf: (p) => ["Characters", "Recursive"].includes(str(p, "strategy") || "Characters") },
      {
        key: "separator",
        label: "Separator (Recursive: several, highest priority first, | between them)",
        kind: "text",
        placeholder: "\\n  ·  Recursive: \\n\\n|\\n|. | ",
        showIf: (p) => ["Separator", "Recursive"].includes(str(p, "strategy")),
      },
    ],
    output: true,
    outputDefault: "chunk",
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const size = Math.max(10, Number(str(p, "size") || 1000));
      const overlap = Math.max(0, Number(str(p, "overlap") || 100));
      const strategy = str(p, "strategy") || "Characters";
      const sep = strategy === "Recursive" ? str(p, "separator") : str(p, "separator").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      const out = outputName(p, "chunk");
      const rows: Row[] = [];
      for (const r of t.rows) {
        const v = r[col.name];
        const chunks = v === null || v === undefined ? [] : chunkText(String(v), str(p, "strategy") || "Characters", size, overlap, sep);
        chunks.forEach((c, i) => rows.push({ ...r, [out]: c, chunk_index: i }));
      }
      const columns = [...t.columns.filter((c) => c.name !== out && c.name !== "chunk_index"), { name: out, type: "String" as ColType }, { name: "chunk_index", type: "Integer" as ColType }];
      return { columns, rows };
    },
    summary: (p) => `${str(p, "column")} by ${(str(p, "strategy") || "Characters").toLowerCase()}${str(p, "size") ? ` (${str(p, "size")})` : ""}`,
  },
  {
    kind: "embed",
    label: "Text to embeddings",
    category: "String",
    description: "Turns text into an embedding vector (unit length, JSON array) for semantic search, through OpenRouter. Previews embed the first 50 rows.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "model", label: "Model", kind: "select", options: EMBEDDING_MODELS, optionLabel: (o) => EMBEDDING_LABELS[o] ?? o },
    ],
    output: true,
    outputDefault: "embedding",
    run: (t, p, ctx) => {
      const col = need(t, str(p, "column"));
      const model = str(p, "model") || EMBEDDING_MODELS[0];
      const dim = embeddingDim(model);
      const n = asyncRows(t, ctx);
      const out = outputName(p, "embedding");
      const rows = t.rows.slice(0, n).map((r) => {
        const v = r[col.name];
        if (v === null || v === undefined || v === "") return { ...r, [out]: null };
        const c = serviceCell(ctx, "embed", `embed:${model}:${keyHash(String(v))}`, { text: String(v), model, dimension: dim });
        return { ...r, [out]: Array.isArray(c.value) ? JSON.stringify(c.value) : null };
      });
      return { columns: [...t.columns.filter((c) => c.name !== out), { name: out, type: "String" }], rows };
    },
    summary: (p) => `${str(p, "column")} with ${EMBEDDING_LABELS[str(p, "model")] ?? (str(p, "model") || EMBEDDING_MODELS[0])}`,
  },
  {
    kind: "extract_lines",
    label: "Extract lines from text files",
    category: "File",
    description: "Reads plain text files into one row per line (file_path, line_number, line).",
    fields: [{ key: "skipEmpty", label: "Skip empty lines", kind: "boolean", optional: true }],
    run: (t, p) => {
      const rows: Row[] = [];
      for (const f of inputFiles(t)) {
        if (f.encoding === "base64") continue;
        f.text.split(/\r?\n/).forEach((line, i) => {
          if (str(p, "skipEmpty") === "true" && !line.trim()) return;
          rows.push({ file_path: f.path, line_number: i + 1, line });
        });
      }
      return {
        columns: [
          { name: "file_path", type: "String" },
          { name: "line_number", type: "Integer" },
          { name: "line", type: "String" },
        ],
        rows,
      };
    },
    summary: (p) => (str(p, "skipEmpty") === "true" ? "skip empty lines" : "every line"),
  },
  {
    kind: "extract_excel",
    label: "Extract rows from an Excel file",
    category: "File",
    description: "Reads .xlsx, .xlsm, .xltx and .xltm workbooks into rows (the header row names the columns; types come from the cells). Old .xls / .xlt files must be saved as .xlsx.",
    fields: [
      { key: "sheet", label: "Sheet", kind: "text", optional: true, placeholder: "first sheet" },
      { key: "headerRow", label: "Header row", kind: "text", optional: true, placeholder: "1" },
      { key: "allSheets", label: "Read every sheet (adds sheet_name)", kind: "boolean", optional: true },
      { key: "includePath", label: "Add a file_path column", kind: "boolean", optional: true },
    ],
    run: (t, p, ctx) =>
      parseFiles(t, p, ctx, "excel", /\.(xlsx|xlsm|xltx|xltm|xls|xlt)$/i, {
        sheet: str(p, "sheet"),
        header_row: Number(str(p, "headerRow") || 1),
        all_sheets: str(p, "allSheets") === "true",
      }),
    summary: (p) => (str(p, "allSheets") === "true" ? "all sheets" : str(p, "sheet") || "first sheet"),
  },
  {
    kind: "parse_xml",
    label: "Parse XML",
    category: "File",
    description:
      "Reads XML files into rows: one row per record element (an XPath like //order, or the repeating children of the root). Name an .xsd file of the same dataset (or paste an XSD) to type the columns from the schema.",
    fields: [
      { key: "recordPath", label: "Record path (XPath)", kind: "text", optional: true, placeholder: "//order" },
      { key: "xsdFile", label: "XSD file in this dataset", kind: "text", optional: true, placeholder: "schema.xsd" },
      { key: "xsd", label: "XSD (pasted)", kind: "text", optional: true },
      { key: "includePath", label: "Add a file_path column", kind: "boolean", optional: true },
    ],
    run: (t, p, ctx) => {
      const files = inputFiles(t);
      const xsdName = str(p, "xsdFile");
      const xsd = xsdName ? (files.find((f) => f.path === xsdName || f.path.endsWith(`/${xsdName}`))?.text ?? "") : str(p, "xsd");
      if (xsdName && !xsd) throw new Error(`No file "${xsdName}" in this dataset`);
      return parseFiles({ ...t, files: files.filter((f) => !/\.xsd$/i.test(f.path)) }, p, ctx, "xml", /\.xml$/i, { record_path: str(p, "recordPath"), xsd });
    },
    summary: (p) => `${str(p, "recordPath") || "records"}${str(p, "xsdFile") ? ` typed by ${str(p, "xsdFile")}` : ""}`,
  },
  {
    kind: "extract_email",
    label: "Extract rows from email files",
    category: "File",
    description: "Reads .eml email files into one row each: subject, from, to, cc, date, message id, body and attachment names.",
    fields: [],
    run: (t, p, ctx) => parseFiles(t, p, ctx, "email", /\.eml$/i),
    summary: () => "subject, from, to, body…",
  },
  {
    kind: "extract_geojson",
    label: "Extract features from GeoJSON",
    category: "Geospatial",
    description: "Reads GeoJSON files into one row per feature: its properties as columns and its geometry as GeoJSON text.",
    fields: [{ key: "includePath", label: "Add a file_path column", kind: "boolean", optional: true }],
    run: (t, p) => {
      const records: Record<string, unknown>[] = [];
      const paths: string[] = [];
      for (const f of inputFiles(t)) {
        if (!/\.(geo)?json$/i.test(f.path)) continue;
        const doc = JSON.parse(f.text);
        const features = doc.type === "FeatureCollection" ? doc.features : doc.type === "Feature" ? [doc] : [{ properties: {}, geometry: doc }];
        for (const ft of features) {
          records.push({ ...(ft.properties ?? {}), geometry: JSON.stringify(ft.geometry ?? null) });
          paths.push(f.path);
        }
      }
      return withPath(recordsToTable(records, []), paths, str(p, "includePath") === "true");
    },
    summary: () => "features",
  },
  {
    kind: "extract_kml",
    label: "Extract placemarks from KML",
    category: "Geospatial",
    description: "Reads KML files into one row per placemark: name, description, extended data and the geometry as GeoJSON text.",
    fields: [{ key: "includePath", label: "Add a file_path column", kind: "boolean", optional: true }],
    run: (t, p, ctx) => parseFiles(t, p, ctx, "kml", /\.kml$/i),
    summary: () => "placemarks",
  },
  {
    kind: "extract_shapefile",
    label: "Extract shapes from a shapefile",
    category: "Geospatial",
    description: "Reads zipped shapefiles (.shp with .dbf and .shx in one .zip) into one row per shape: its attributes and the geometry as GeoJSON text.",
    fields: [{ key: "includePath", label: "Add a file_path column", kind: "boolean", optional: true }],
    run: (t, p, ctx) => parseFiles(t, p, ctx, "shapefile", /\.zip$/i),
    summary: () => "shapes",
  },
  {
    kind: "geo_point",
    label: "Construct point",
    category: "Geospatial",
    description: "Makes a GeoJSON point from latitude and longitude columns.",
    fields: [
      { key: "lat", label: "Latitude", kind: "column" },
      { key: "lon", label: "Longitude", kind: "column" },
    ],
    output: true,
    outputDefault: "point",
    run: (t, p) => {
      const lat = need(t, str(p, "lat"));
      const lon = need(t, str(p, "lon"));
      return setColumn(t, outputName(p, "point"), "String", (r) => {
        const y = toNumber(r[lat.name] ?? null);
        const x = toNumber(r[lon.name] ?? null);
        return x === null || y === null || Math.abs(y) > 90 || Math.abs(x) > 180 ? null : JSON.stringify({ type: "Point", coordinates: [x, y] });
      });
    },
    summary: (p) => `(${str(p, "lat")}, ${str(p, "lon")})`,
  },
  {
    kind: "geo_coordinates",
    label: "Extract latitude and longitude",
    category: "Geospatial",
    description: "Reads the coordinates of a point geometry (GeoJSON or WKT POINT) into latitude and longitude columns; other geometries give their centroid.",
    fields: [{ key: "column", label: "Geometry", kind: "column" }],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const center = (r: Row) => {
        const g = readGeometry(r[col.name] ?? null);
        const pts = g ? allPositions(g) : [];
        if (!pts.length) return null;
        return [pts.reduce((s, q) => s + q[1], 0) / pts.length, pts.reduce((s, q) => s + q[0], 0) / pts.length];
      };
      const withLat = setColumn(t, "latitude", "Double", (r) => center(r)?.[0] ?? null);
      return setColumn(withLat, "longitude", "Double", (r) => center(r)?.[1] ?? null);
    },
    summary: (p) => str(p, "column"),
  },
  {
    kind: "geo_distance",
    label: "Distance between points",
    category: "Geospatial",
    description: "Great-circle (haversine) distance between two points given as latitude / longitude columns.",
    fields: [
      { key: "lat1", label: "Latitude 1", kind: "column" },
      { key: "lon1", label: "Longitude 1", kind: "column" },
      { key: "lat2", label: "Latitude 2", kind: "column" },
      { key: "lon2", label: "Longitude 2", kind: "column" },
      { key: "unit", label: "Unit", kind: "select", options: Object.keys(GEO_UNITS) },
    ],
    output: true,
    outputDefault: "distance",
    run: (t, p) => {
      const [a, b, c, d] = ["lat1", "lon1", "lat2", "lon2"].map((k) => need(t, str(p, k)));
      const radius = GEO_UNITS[str(p, "unit") || "kilometers"] ?? GEO_UNITS.kilometers;
      return setColumn(t, outputName(p, "distance"), "Double", (r) => {
        const v = [a, b, c, d].map((x) => toNumber(r[x.name] ?? null));
        return v.some((x) => x === null) ? null : Math.round(haversine(v[0]!, v[1]!, v[2]!, v[3]!, radius) * 1e6) / 1e6;
      });
    },
    summary: (p) => `(${str(p, "lat1")}, ${str(p, "lon1")}) → (${str(p, "lat2")}, ${str(p, "lon2")}) in ${str(p, "unit") || "kilometers"}`,
  },
  {
    kind: "geohash",
    label: "Geohash",
    category: "Geospatial",
    description: "Encodes a latitude / longitude as a geohash of the given precision (1–12 characters; 7 ≈ 150 m).",
    fields: [
      { key: "lat", label: "Latitude", kind: "column" },
      { key: "lon", label: "Longitude", kind: "column" },
      { key: "precision", label: "Precision", kind: "text", placeholder: "7" },
    ],
    output: true,
    outputDefault: "geohash",
    run: (t, p) => {
      const lat = need(t, str(p, "lat"));
      const lon = need(t, str(p, "lon"));
      const precision = Math.min(12, Math.max(1, Math.trunc(Number(str(p, "precision") || 7))));
      return setColumn(t, outputName(p, "geohash"), "String", (r) => {
        const y = toNumber(r[lat.name] ?? null);
        const x = toNumber(r[lon.name] ?? null);
        return x === null || y === null ? null : geohash(y, x, precision);
      });
    },
    summary: (p) => `(${str(p, "lat")}, ${str(p, "lon")}) precision ${str(p, "precision") || 7}`,
  },
  {
    kind: "geo_within",
    label: "Point in polygon",
    category: "Geospatial",
    description: "True when a point (latitude / longitude) lies inside a polygon: a GeoJSON polygon column, or one polygon pasted as GeoJSON.",
    fields: [
      { key: "lat", label: "Latitude", kind: "column" },
      { key: "lon", label: "Longitude", kind: "column" },
      { key: "polygonColumn", label: "Polygon column", kind: "column", optional: true },
      { key: "polygon", label: "Polygon (GeoJSON)", kind: "text", optional: true, placeholder: '{"type":"Polygon","coordinates":[[[lon,lat],…]]}' },
    ],
    output: true,
    outputDefault: "within",
    run: (t, p) => {
      const lat = need(t, str(p, "lat"));
      const lon = need(t, str(p, "lon"));
      const polyCol = str(p, "polygonColumn") ? need(t, str(p, "polygonColumn")) : null;
      const fixed = polyCol ? null : readGeometry(str(p, "polygon"));
      if (!polyCol && !fixed) throw new Error("Choose a polygon column or paste a GeoJSON polygon");
      return setColumn(t, outputName(p, "within"), "Boolean", (r) => {
        const y = toNumber(r[lat.name] ?? null);
        const x = toNumber(r[lon.name] ?? null);
        const g = polyCol ? readGeometry(r[polyCol.name] ?? null) : fixed;
        return x === null || y === null || !g ? null : pointInGeometry(x, y, g);
      });
    },
    summary: (p) => `(${str(p, "lat")}, ${str(p, "lon")}) in ${str(p, "polygonColumn") || "polygon"}`,
  },
  {
    kind: "geo_bbox",
    label: "Filter to bounding box",
    category: "Geospatial",
    description: "Keeps the rows whose point lies within a bounding box (min / max latitude and longitude).",
    fields: [
      { key: "lat", label: "Latitude", kind: "column" },
      { key: "lon", label: "Longitude", kind: "column" },
      { key: "bbox", label: "Box", kind: "text", placeholder: "minLat, minLon, maxLat, maxLon" },
    ],
    run: (t, p) => {
      const lat = need(t, str(p, "lat"));
      const lon = need(t, str(p, "lon"));
      const b = str(p, "bbox").split(",").map((x) => Number(x.trim()));
      if (b.length !== 4 || b.some((x) => !Number.isFinite(x))) throw new Error("Enter the box as minLat, minLon, maxLat, maxLon");
      return {
        ...t,
        rows: t.rows.filter((r) => {
          const y = toNumber(r[lat.name] ?? null);
          const x = toNumber(r[lon.name] ?? null);
          return y !== null && x !== null && y >= b[0] && y <= b[2] && x >= b[1] && x <= b[3];
        }),
      };
    },
    summary: (p) => str(p, "bbox"),
  },
  {
    kind: "geo_crs",
    label: "Convert coordinate reference system",
    category: "Geospatial",
    description:
      "Reprojects coordinates into another CRS (all maps expect WGS 84, EPSG:4326): a GeoJSON geometry column, or x / y columns (longitude / latitude for geographic CRSs). Data in different CRSs will not line up on a map.",
    fields: [
      { key: "mode", label: "Input", kind: "select", options: ["Geometry column", "X / Y columns"] },
      { key: "column", label: "Geometry (GeoJSON)", kind: "column", showIf: (p) => str(p, "mode") !== "X / Y columns" },
      { key: "x", label: "X (easting / longitude)", kind: "column", showIf: (p) => str(p, "mode") === "X / Y columns" },
      { key: "y", label: "Y (northing / latitude)", kind: "column", showIf: (p) => str(p, "mode") === "X / Y columns" },
      { key: "from", label: "From CRS", kind: "text", placeholder: "EPSG:32748" },
      { key: "to", label: "To CRS", kind: "text", optional: true, placeholder: "EPSG:4326" },
    ],
    output: true,
    outputDefault: "geometry_wgs84",
    run: (t, p) => {
      const from = parseCrs(str(p, "from") || "EPSG:4326");
      const to = parseCrs(str(p, "to") || "EPSG:4326");
      const conv = (q: number[]) => {
        const [lon, lat] = crsToLonLat(from, q[0], q[1]);
        const [x, y] = lonLatToCrs(to, lon, lat);
        return [round9(x), round9(y), ...q.slice(2)];
      };
      if (str(p, "mode") === "X / Y columns") {
        const x = need(t, str(p, "x"));
        const y = need(t, str(p, "y"));
        const base = outputName(p, "geometry_wgs84");
        const pair = (r: Row) => {
          const a = toNumber(r[x.name] ?? null);
          const b = toNumber(r[y.name] ?? null);
          return a === null || b === null ? null : conv([a, b]);
        };
        const withX = setColumn(t, `${base}_x`, "Double", (r) => pair(r)?.[0] ?? null);
        return setColumn(withX, `${base}_y`, "Double", (r) => pair(r)?.[1] ?? null);
      }
      const col = need(t, str(p, "column"));
      return setColumn(t, outputName(p, "geometry_wgs84"), "String", (r) => {
        const g = readGeometry(r[col.name] ?? null);
        return g ? JSON.stringify(mapPositions(g, conv)) : null;
      });
    },
    summary: (p) => `${str(p, "from") || "EPSG:4326"} → ${str(p, "to") || "EPSG:4326"}`,
  },
  {
    kind: "geo_area",
    label: "Geometry area",
    category: "Geospatial",
    description: "Area of a GeoJSON polygon or multipolygon (WGS 84) on the sphere, in square meters (0 for points and lines).",
    fields: [{ key: "column", label: "Geometry (GeoJSON)", kind: "column" }],
    output: true,
    outputDefault: "area_m2",
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      return setColumn(t, outputName(p, "area_m2"), "Double", (r) => {
        const g = readGeometry(r[col.name] ?? null);
        return g ? Math.round(geometryArea(g) * 100) / 100 : null;
      });
    },
    summary: (p) => str(p, "column"),
  },
  {
    kind: "geo_length",
    label: "Geometry length",
    category: "Geospatial",
    description: "Great-circle length of a GeoJSON line (or a polygon's perimeter), in meters.",
    fields: [{ key: "column", label: "Geometry (GeoJSON)", kind: "column" }],
    output: true,
    outputDefault: "length_m",
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      return setColumn(t, outputName(p, "length_m"), "Double", (r) => {
        const g = readGeometry(r[col.name] ?? null);
        return g ? Math.round(geometryLength(g) * 100) / 100 : null;
      });
    },
    summary: (p) => str(p, "column"),
  },
  {
    kind: "geo_validate_shape",
    label: "Validate geoshape",
    category: "Geospatial",
    description:
      "Checks a GeoJSON column against the Nexus's geoshape rules (a geometry, not a Feature; WGS 84; closed, counter-clockwise exterior rings) and writes the problem, or null when valid. With Fix winding, rings are reoriented and Features unwrapped first.",
    fields: [
      { key: "column", label: "Geometry (GeoJSON)", kind: "column" },
      { key: "fix", label: "Fix winding order and unwrap Features", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "geoshape_problem",
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      let out = t;
      if (p.fix) {
        const orient = (rings: number[][][]) => rings.map((r, i) => ((i === 0 ? ringArea(r) < 0 : ringArea(r) > 0) ? [...r].reverse() : r));
        out = setColumn(t, col.name, col.type, (r) => {
          const g = readGeometry(r[col.name] ?? null);
          if (!g) return r[col.name] ?? null;
          if (g.type === "Polygon") return JSON.stringify({ type: g.type, coordinates: orient(g.coordinates as number[][][]) });
          if (g.type === "MultiPolygon") return JSON.stringify({ type: g.type, coordinates: (g.coordinates as number[][][][]).map(orient) });
          return JSON.stringify({ type: g.type, coordinates: g.coordinates });
        });
      }
      return setColumn(out, outputName(p, "geoshape_problem"), "String", (r) => geoshapeProblem(r[col.name] ?? null));
    },
    summary: (p) => `${str(p, "column")}${p.fix ? " (fix)" : ""}`,
  },
  {
    kind: "geo_gtsr",
    label: "Create geotemporal series reference",
    category: "Geospatial",
    description:
      "A geotemporal series reference (GTSR) for an object type: the series ID column (the same one the geotemporal series sync uses) and the RID of the deployed sync. Map it to a Geotemporal series reference property in Nexus Manager.",
    fields: [
      { key: "seriesId", label: "Series ID", kind: "column" },
      { key: "rid", label: "Geotemporal series integration RID", kind: "text", placeholder: "geo-… (Time Series Catalog → the sync)" },
    ],
    output: true,
    outputDefault: "geotemporal_series",
    run: (t, p) => {
      const sid = need(t, str(p, "seriesId"));
      const rid = str(p, "rid").trim();
      if (!rid) throw new Error("Enter the RID of the deployed geotemporal series sync");
      return setColumn(t, outputName(p, "geotemporal_series"), "String", (r) => {
        const v = r[sid.name];
        if (v === null || v === undefined || v === "") return null;
        const id = String(v);
        if (id.length > 100) throw new Error(`Series ID "${id.slice(0, 40)}…" is longer than 100 characters`);
        return JSON.stringify({ seriesId: id, integrationRid: rid });
      });
    },
    summary: (p) => `${str(p, "seriesId")} in ${str(p, "rid") || "?"}`,
  },
  {
    kind: "media_to_rows",
    label: "Convert media set to table rows",
    category: "Media",
    description: "One row per media item with its mediaReference (feed it to Use LLM for vision, or to text extraction), path, media type and size.",
    fields: [],
    run: (t) => {
      if (!t.columns.some((c) => c.name === "mediaReference")) throw new Error("The input is not a media set (it has no mediaReference column)");
      return t;
    },
    summary: () => "mediaReference, path, mediaType, size",
  },
  {
    kind: "extract_pdf_text",
    label: "Extract text from PDF",
    category: "Media",
    description:
      "Reads the text of each PDF a media reference points to. Raw text: computer-generated PDFs (their text layer). OCR: photocopies and scans (a vision model reads each page). Layout aware: text with bounding boxes, as JSON. Previews extract the first 50 rows.",
    fields: [
      { key: "column", label: "Media reference", kind: "column" },
      { key: "method", label: "Extract method", kind: "select", options: ["Raw text", "OCR", "Layout aware"] },
      { key: "maxPages", label: "Pages (OCR)", kind: "text", optional: true, placeholder: "50", showIf: (p) => str(p, "method") === "OCR" },
      { key: "errors", label: "Add an error column", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "text",
    run: (t, p, ctx) => {
      const method = str(p, "method") === "OCR" ? "ocr" : str(p, "method") === "Layout aware" ? "layout" : "raw";
      return mediaStep(t, p, ctx, method, "String", (v) => (typeof v === "string" ? v : JSON.stringify(v)));
    },
    summary: (p) => `${str(p, "column")} (${(str(p, "method") || "Raw text").toLowerCase()})`,
  },
  {
    kind: "transcribe_audio",
    label: "Transcribe audio",
    category: "Media",
    description:
      "Speech to text for each audio (or video) file a media reference points to, with Whisper: plain text, text with timestamps, or the segments as JSON. The language is detected when left empty. Previews transcribe the first 50 rows.",
    fields: [
      { key: "column", label: "Media reference", kind: "column" },
      { key: "language", label: "Language", kind: "text", optional: true, placeholder: "detected (e.g. indonesian, english)" },
      { key: "format", label: "Output", kind: "select", options: ["Text", "Text with timestamps", "Segments (JSON)"] },
      { key: "mode", label: "Performance", kind: "select", options: ["More economical", "More performant"], optional: true },
      { key: "errors", label: "Add an error column", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "transcription",
    run: (t, p, ctx) =>
      mediaStep(t, { ...p, output: str(p, "output") || "transcription" }, ctx, "transcribe", "String", (v) => (typeof v === "string" ? v : JSON.stringify(v)), {
        language: str(p, "language"),
        output: str(p, "format") === "Segments (JSON)" ? "segments" : str(p, "format") === "Text with timestamps" ? "timestamps" : "text",
        performance_mode: str(p, "mode") === "More performant" ? "more_performant" : "more_economical",
      }),
    summary: (p) => `${str(p, "column")} → ${(str(p, "format") || "Text").toLowerCase()}${str(p, "language") ? ` (${str(p, "language")})` : ""}`,
  },
  {
    kind: "ocr_image",
    label: "Extract text from image (OCR)",
    category: "Media",
    description: "Reads the text in images (and PDF pages) with a vision model, in reading order. Previews extract the first 50 rows.",
    fields: [
      { key: "column", label: "Media reference", kind: "column" },
      { key: "errors", label: "Add an error column", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "text",
    run: (t, p, ctx) => mediaStep(t, p, ctx, "ocr", "String", (v) => String(v)),
    summary: (p) => str(p, "column"),
  },
  {
    kind: "media_metadata",
    label: "Get media metadata",
    category: "Media",
    description: "File name, size and type of each media item; page count for PDFs, width and height for images (as JSON).",
    fields: [{ key: "column", label: "Media reference", kind: "column" }],
    output: true,
    outputDefault: "media_metadata",
    run: (t, p, ctx) => mediaStep(t, p, ctx, "metadata", "String", (v) => JSON.stringify(v)),
    summary: (p) => str(p, "column"),
  },
  {
    kind: "split_pdf_pages",
    label: "Split PDF into pages",
    category: "Media",
    description: "One row per page of each PDF, with a page_number and a media reference to that page — so OCR, text extraction or a vision LLM work page by page.",
    fields: [{ key: "column", label: "Media reference", kind: "column" }],
    run: (t, p, ctx) => {
      const col = need(t, str(p, "column"));
      const rows: Row[] = [];
      for (const r of t.rows.slice(0, asyncRows(t, ctx))) {
        const ref = mediaRef(r[col.name] ?? null);
        if (!ref) continue;
        const pages = service(ctx, "media", `media:pages:${ref.split("#")[0]}`, { item_id: ref.split("#")[0], method: "pages" });
        if (typeof pages !== "number") continue;
        for (let i = 1; i <= pages; i++) rows.push({ ...r, [col.name]: withRefParam(ref, "page", i), page_number: i });
      }
      return { columns: [...t.columns.filter((c) => c.name !== "page_number"), { name: "page_number", type: "Integer" }], rows };
    },
    summary: (p) => str(p, "column"),
  },
  {
    kind: "rotate_image",
    label: "Rotate image",
    category: "Media",
    description:
      "Rotates the media a reference points to (90° steps, clockwise) before text extraction or a vision LLM reads it. Transformed media references are not valid in dataset outputs — drop the column first.",
    fields: [
      { key: "column", label: "Media reference", kind: "column" },
      { key: "degrees", label: "Rotate clockwise", kind: "select", options: ["90", "180", "270"] },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      return setColumn(t, outputName(p), "String", (r) => {
        const ref = mediaRef(r[col.name] ?? null);
        return ref ? withRefParam(ref, "rotate", str(p, "degrees") || "90") : null;
      });
    },
    summary: (p) => `${str(p, "column")} by ${str(p, "degrees") || 90}°`,
  },
];
STEPS.push(...EXTRA_STEPS);

// ---------------------------------------------------------------- Pipeline Builder table transforms

/** A JSON array cell (arrays are JSON text), or null. */
function arrayOf(v: Cell): unknown[] | null {
  if (v === null || v === "") return null;
  try {
    const x = JSON.parse(String(v));
    return Array.isArray(x) ? x : null;
  } catch {
    return null;
  }
}

/** A JSON object cell (structs and maps are JSON text), or null. */
function objectOf(v: Cell): Record<string, unknown> | null {
  if (v === null || v === "") return null;
  try {
    const x = JSON.parse(String(v));
    return x && typeof x === "object" && !Array.isArray(x) ? x : null;
  } catch {
    return null;
  }
}

/** Unique output names: a repeated name gets _2, _3 … (case-insensitive, like Pipeline Builder). */
function suffixedNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    return count === 1 ? n : `${n}_${count}`;
  });
}

function renameAll(t: Table, rename: (name: string) => string): Table {
  const names = suffixedNames(t.columns.map((c) => rename(c.name)));
  const map = new Map(t.columns.map((c, i) => [c.name, names[i]]));
  return {
    ...t,
    columns: t.columns.map((c) => ({ ...c, name: map.get(c.name)! })),
    rows: t.rows.map((r) => Object.fromEntries(t.columns.map((c) => [map.get(c.name)!, r[c.name] ?? null]))),
  };
}

/** lowerCamelCase / Title Case / kebab-case / spaced names → lower_snake_case. */
export function snakeCase(name: string, removeSpecial: boolean): string {
  let s = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  s = removeSpecial ? s.replace(/[^a-z0-9]+/g, "_") : s.replace(/[\s\-.]+/g, "_");
  return s.replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "_untitled_column";
}

/** Which columns a column predicate selects: all, by type, by a name regex, or a list of names. */
const PREDICATES = ["All columns", "Columns of type", "Name matches regex", "Name is in list"] as const;
function predicateColumns(t: Table, p: Params): Column[] {
  const kind = str(p, "predicate") || "All columns";
  if (kind === "Columns of type") {
    const type = typeParam(p, "predicateType", "String");
    return t.columns.filter((c) => c.type === type);
  }
  if (kind === "Name matches regex") {
    let re: RegExp;
    try {
      re = new RegExp(str(p, "predicateRegex"));
    } catch {
      throw new Error(`Invalid regular expression "${str(p, "predicateRegex")}"`);
    }
    return t.columns.filter((c) => re.test(c.name));
  }
  if (kind === "Name is in list") {
    const names = new Set(list(p, "predicateColumns"));
    return t.columns.filter((c) => names.has(c.name));
  }
  return t.columns;
}
const predicateFields: FieldDef[] = [
  { key: "predicate", label: "Columns to apply to", kind: "select", options: PREDICATES },
  { key: "predicateType", label: "Column type", kind: "select", options: COL_TYPES, showIf: (p) => str(p, "predicate") === "Columns of type" },
  { key: "predicateRegex", label: "Name regex", kind: "text", placeholder: "_str$", showIf: (p) => str(p, "predicate") === "Name matches regex" },
  { key: "predicateColumns", label: "Columns", kind: "columns", showIf: (p) => str(p, "predicate") === "Name is in list" },
];
const describePredicate = (p: Params) => {
  const kind = str(p, "predicate") || "All columns";
  if (kind === "Columns of type") return `${str(p, "predicateType") || "String"} columns`;
  if (kind === "Name matches regex") return `columns matching /${str(p, "predicateRegex")}/`;
  if (kind === "Name is in list") return list(p, "predicateColumns").join(", ") || "no columns";
  return "all columns";
};

const sqlName = (name: string) => "`" + name.replace(/`/g, "``") + "`";
/** {column} in a Spark SQL template → the quoted column; {name} → its name as a string literal. */
const fillTemplate = (template: string, column: string) =>
  template.replace(/\{column\}/g, sqlName(column)).replace(/\{name\}/g, `'${column.replace(/'/g, "''")}'`);

function runQuery(t: Table, query: string, ctx?: StepContext): Table {
  const engine = ctx?.sql?.engine;
  if (!engine) throw new Error(ctx?.sql?.error ?? "Loading the SQL engine…");
  return engine.query(sqlTables(t, query, ctx), query);
}

/** Start of the UTC bucket a time falls in. */
function bucketStart(d: Date, unit: string): Date {
  const x = new Date(d.getTime());
  if (unit === "Second") x.setUTCMilliseconds(0);
  else if (unit === "Minute") x.setUTCSeconds(0, 0);
  else if (unit === "Hour") x.setUTCMinutes(0, 0, 0);
  else {
    x.setUTCHours(0, 0, 0, 0);
    if (unit === "Week") x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    else if (unit === "Month") x.setUTCDate(1);
    else if (unit === "Year") x.setUTCMonth(0, 1);
  }
  return x;
}

/** Frequent itemsets (Apriori, equivalent output to FP-growth) with support ≥ minSupport. */
export function frequentPatterns(transactions: string[][], minSupport: number, maxSize = 6): { items: string[]; count: number }[] {
  const n = transactions.length;
  const minCount = Math.max(1, Math.ceil(minSupport * n - 1e-9));
  const sets = transactions.map((t) => new Set(t));
  const result: { items: string[]; count: number }[] = [];
  const singles = new Map<string, number>();
  for (const s of sets) for (const i of s) singles.set(i, (singles.get(i) ?? 0) + 1);
  let level = [...singles].filter(([, c]) => c >= minCount).map(([i, c]) => ({ items: [i], count: c }));
  level.sort((a, b) => a.items[0].localeCompare(b.items[0]));
  for (let size = 1; level.length && size <= maxSize; size++) {
    result.push(...level);
    if (size === maxSize) break;
    const frequent = new Set(level.map((x) => x.items.join("\u0001")));
    const next = new Map<string, string[]>();
    for (let a = 0; a < level.length; a++)
      for (let b = a + 1; b < level.length; b++) {
        const x = level[a].items;
        const y = level[b].items;
        if (x.slice(0, -1).join("\u0001") !== y.slice(0, -1).join("\u0001")) continue;
        const cand = [...x, y[y.length - 1]].sort();
        // every subset one smaller must be frequent
        if (!cand.every((_, i) => frequent.has(cand.filter((__, j) => j !== i).join("\u0001")))) continue;
        next.set(cand.join("\u0001"), cand);
      }
    if (next.size > 200_000) throw new Error("Too many candidate patterns — raise the minimum support");
    level = [...next.values()]
      .map((items) => ({ items, count: sets.filter((s) => items.every((i) => s.has(i))).length }))
      .filter((x) => x.count >= minCount);
  }
  return result;
}

const PB_STEPS: StepDef[] = [
  {
    kind: "normalize_columns",
    label: "Normalize column names",
    category: "Data preparation",
    description: "Renames every column to lower_snake_case (recentlyServiced → recently_serviced, _airlineCode → airline_code). Names that collide get _2, _3 ….",
    fields: [{ key: "removeSpecial", label: "Remove special characters", kind: "boolean", optional: true }],
    run: (t, p) => renameAll(t, (n) => snakeCase(n, str(p, "removeSpecial") === "true")),
    summary: (p) => `lower_snake_case${str(p, "removeSpecial") === "true" ? ", special characters removed" : ""}`,
  },
  {
    kind: "uppercase_columns",
    label: "Uppercase column names",
    category: "Data preparation",
    description: "Uppercases every column name (recentlyServiced → RECENTLYSERVICED).",
    fields: [],
    run: (t) => renameAll(t, (n) => n.toUpperCase()),
    summary: () => "UPPERCASE names",
  },
  {
    kind: "top_rows",
    label: "Top rows",
    category: "Rows",
    description: "Keeps the first rows of each partition after sorting it: e.g. the latest record per customer. Partition by nothing for the top rows of the whole dataset.",
    fields: [
      { key: "partition", label: "Partition by columns", kind: "columns", optional: true },
      { key: "sort", label: "Sort specification", kind: "sortkeys" },
      { key: "n", label: "Number of rows", kind: "text", optional: true, placeholder: "1" },
    ],
    run: (t, p) => {
      const keys = readSortKeys(p, "sort");
      if (!keys.length) throw new Error("Add a column to sort by");
      const n = Math.max(1, Math.trunc(Number(str(p, "n") || 1)) || 1);
      const by = list(p, "partition").map((c) => need(t, c).name);
      const groups = new Map<string, Row[]>();
      for (const r of t.rows) {
        const k = by.map((c) => cellKey(r[c] ?? null)).join("\u0001");
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
      }
      const cmp = rowComparator(t, keys);
      return { columns: t.columns, rows: [...groups.values()].flatMap((g) => [...g].sort(cmp).slice(0, n)) };
    },
    summary: (p) => `top ${str(p, "n") || 1} by ${describeSort(readSortKeys(p, "sort")) || "?"}${list(p, "partition").length ? ` per ${list(p, "partition").join(", ")}` : ""}`,
  },
  {
    kind: "keep_duplicates",
    label: "Keep duplicates",
    category: "Rows",
    description: "Keeps only the rows whose values (in the chosen columns, or all columns) appear more than once — the opposite of Drop duplicates.",
    fields: [{ key: "columns", label: "Column subset", kind: "columns", optional: true }],
    run: (t, p) => {
      const cols = list(p, "columns").length ? list(p, "columns").map((c) => need(t, c).name) : t.columns.map((c) => c.name);
      const key = (r: Row) => cols.map((c) => cellKey(r[c] ?? null)).join("\u0001");
      const counts = new Map<string, number>();
      for (const r of t.rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
      return { columns: t.columns, rows: t.rows.filter((r) => (counts.get(key(r)) ?? 0) > 1) };
    },
    summary: (p) => list(p, "columns").join(", ") || "all columns",
  },
  {
    kind: "array_to_columns",
    label: "Array elements to columns",
    category: "Array",
    description: "Puts the first elements of an array column into new columns, in order: [1000, 2] with columns miles, id gives miles = 1000, id = 2. Missing elements are null; existing columns with those names are replaced.",
    fields: [
      { key: "column", label: "Array", kind: "column" },
      { key: "names", label: "Columns to extract", kind: "text", placeholder: "miles, id" },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const names = str(p, "names").split(",").map((s) => s.trim()).filter(Boolean);
      if (!names.length) throw new Error("Name the columns to extract");
      const arrays = t.rows.map((r) => arrayOf(r[col.name] ?? null));
      const made = names.map((name, i) => ({ name, ...inferColumn(arrays.map((a) => (a ? (a[i] ?? null) : null))) }));
      // the new columns come first, as in Pipeline Builder; same-named columns are replaced
      const rest = t.columns.filter((c) => !names.includes(c.name));
      return {
        columns: [...made.map((m) => ({ name: m.name, type: m.type })), ...rest],
        rows: t.rows.map((r, ri) => {
          const o: Row = {};
          for (const m of made) setField(o, m.name, m.values[ri] ?? null);
          for (const c of rest) setField(o, c.name, cellOf(r, c.name));
          return o;
        }),
      };
    },
    summary: (p) => `${str(p, "column") || "?"} → ${str(p, "names") || "?"}`,
  },
  {
    kind: "struct_fields",
    label: "Extract many struct fields",
    category: "Struct",
    description: "Extracts several fields of a struct column into columns, one per line as  locator as name  (airline.name as airline). Nested fields use dots. The struct column is dropped.",
    fields: [
      { key: "column", label: "Struct", kind: "column" },
      { key: "locators", label: "Locators", kind: "text", placeholder: "airline.name as airline, tail_no as tail_number", help: "Comma-separated; without “as”, the last part of the locator is the column name." },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const specs = str(p, "locators")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = /^(.+?)\s+as\s+(.+)$/i.exec(s);
          const path = (m ? m[1] : s).trim();
          return { path: path.split("."), name: (m ? m[2] : path.split(".").pop()!).trim() };
        });
      if (!specs.length) throw new Error("Add a locator, e.g. airline.name as airline");
      const structs = t.rows.map((r) => objectOf(r[col.name] ?? null));
      const dig = (o: Record<string, unknown> | null, path: string[]) =>
        path.reduce<unknown>((v, k) => (v && typeof v === "object" && !Array.isArray(v) ? ownField(v as Record<string, unknown>, k) : null), o);
      const made = specs.map((s) => ({ name: s.name, ...inferColumn(structs.map((o) => dig(o, s.path) ?? null)) }));
      const names = new Set(made.map((m) => m.name));
      const rest = t.columns.filter((c) => c.name !== col.name && !names.has(c.name));
      return {
        columns: [...rest, ...made.map((m) => ({ name: m.name, type: m.type }))],
        rows: t.rows.map((r, ri) => {
          const o: Row = {};
          for (const c of rest) setField(o, c.name, cellOf(r, c.name));
          for (const m of made) setField(o, m.name, m.values[ri] ?? null);
          return o;
        }),
      };
    },
    summary: (p) => `${str(p, "column") || "?"}: ${str(p, "locators") || "?"}`,
  },
  {
    kind: "apply_columns",
    label: "Apply to multiple columns",
    category: "Data preparation",
    description:
      "Applies one Spark SQL expression to every column that matches a condition (all columns, columns of a type, names matching a regex, or a list). Write the expression with {column} for each matched column, e.g. CAST({column} AS INT) or trim({column}).",
    fields: [
      ...predicateFields,
      { key: "expression", label: "Expression to apply", kind: "text", placeholder: "trim({column})" },
      { key: "suffix", label: "New column suffix", kind: "text", optional: true, placeholder: "_as_integer", help: "Empty: the result replaces the column." },
      { key: "keepRemaining", label: "Keep remaining columns", kind: "boolean", optional: true },
      { key: "keepMatched", label: "Keep matched columns", kind: "boolean", optional: true, showIf: (p) => !!str(p, "suffix").trim() },
    ],
    defaults: { predicate: "All columns", keepRemaining: "true" },
    run: (t, p, ctx) => {
      const expr = str(p, "expression").trim();
      if (!expr.includes("{column}")) throw new Error("Write the expression with {column}, e.g. trim({column})");
      const matched = new Set(predicateColumns(t, p).map((c) => c.name));
      const suffix = str(p, "suffix").trim();
      const keepRemaining = str(p, "keepRemaining") === "true";
      const keepMatched = !!suffix && str(p, "keepMatched") === "true";
      const projections: string[] = [];
      for (const c of t.columns) {
        if (matched.has(c.name)) projections.push(`${fillTemplate(expr, c.name)} AS ${sqlName(c.name + suffix)}`);
      }
      for (const c of t.columns) {
        if (matched.has(c.name) ? keepMatched : keepRemaining) projections.push(sqlName(c.name));
      }
      if (!projections.length) return { columns: [], rows: t.rows.map(() => ({})) };
      return runQuery(t, `SELECT ${projections.join(", ")} FROM input`, ctx);
    },
    summary: (p) => `${str(p, "expression") || "?"} on ${describePredicate(p)}`,
  },
  {
    kind: "aggregate_columns",
    label: "Aggregate on condition",
    category: "Aggregate",
    description:
      "Applies an aggregate expression to every column that matches a condition, grouped by columns (or the whole dataset), e.g. avg({column}) with suffix _mean on all Integer columns gives value_mean, distance_mean ….",
    fields: [
      ...predicateFields,
      { key: "expression", label: "Expression to aggregate", kind: "text", placeholder: "count({column})" },
      { key: "suffix", label: "Column name suffix", kind: "text", placeholder: "_non_null" },
      { key: "groupBy", label: "Group by columns", kind: "columns", optional: true },
    ],
    defaults: { predicate: "All columns" },
    run: (t, p, ctx) => {
      const expr = str(p, "expression").trim();
      if (!expr.includes("{column}")) throw new Error("Write the expression with {column}, e.g. avg({column})");
      const suffix = str(p, "suffix").trim();
      if (!suffix) throw new Error("Give a suffix so each result column has its own name");
      const by = list(p, "groupBy").map((c) => need(t, c).name);
      const cols = predicateColumns(t, p);
      if (!cols.length) throw new Error(`No column matches: ${describePredicate(p)}`);
      const select = [...by.map(sqlName), ...cols.map((c) => `${fillTemplate(expr, c.name)} AS ${sqlName(c.name + suffix)}`)];
      return runQuery(t, `SELECT ${select.join(", ")} FROM input${by.length ? ` GROUP BY ${by.map(sqlName).join(", ")}` : ""}`, ctx);
    },
    summary: (p) => `${str(p, "expression") || "?"} → *${str(p, "suffix")} on ${describePredicate(p)}${list(p, "groupBy").length ? ` by ${list(p, "groupBy").join(", ")}` : ""}`,
  },
  {
    kind: "mapping_join",
    label: "Mapping join",
    category: "Data preparation",
    description:
      "Replaces the values of the target columns using a mapping table (another node): each value is looked up in its key column and replaced by the value column, or by the default when it has no mapping.",
    fields: [
      { key: "mapping", label: "Mapping dataset", kind: "text", placeholder: "flight_codes", help: "The table name of another node, as in a SQL step." },
      { key: "key", label: "Key column for mapping values", kind: "text", placeholder: "flight_code" },
      { key: "value", label: "Values to use for mapping", kind: "text", placeholder: "flight_number" },
      { key: "columns", label: "Target columns", kind: "columns" },
      { key: "default", label: "Default value", kind: "text", optional: true, placeholder: "unknown", help: "Empty: unmapped values become null." },
    ],
    run: (t, p, ctx) => {
      const name = tableName(str(p, "mapping").trim());
      if (!str(p, "mapping").trim()) throw new Error("Choose the mapping dataset");
      const m = ctx?.table(name);
      if (!m) throw new Error(`No node named "${str(p, "mapping")}" — use the table name of another node (${(ctx?.names() ?? []).slice(0, 5).join(", ")}…)`);
      const key = need(m, str(p, "key"));
      const value = need(m, str(p, "value"));
      const map = new Map<string, Cell>();
      for (const r of m.rows) {
        const k = r[key.name] ?? null;
        if (k !== null && !map.has(String(k))) map.set(String(k), r[value.name] ?? null);
      }
      const targets = list(p, "columns").map((c) => need(t, c).name);
      if (!targets.length) throw new Error("Choose the columns to map");
      const fallback: Cell = str(p, "default") === "" ? null : str(p, "default");
      const outType = fallback === null || value.type === "String" ? value.type : "String";
      return {
        columns: t.columns.map((c) => (targets.includes(c.name) ? { name: c.name, type: outType } : c)),
        rows: t.rows.map((r) => {
          const o = { ...r };
          for (const c of targets) {
            const v = cellOf(r, c);
            setField(o, c, v === null ? fallback : map.has(String(v)) ? map.get(String(v))! : fallback);
          }
          return o;
        }),
      };
    },
    summary: (p) => `${list(p, "columns").join(", ") || "?"} via ${str(p, "mapping") || "?"} (${str(p, "key")} → ${str(p, "value")})`,
  },
  {
    kind: "date_distribution",
    label: "Date distribution",
    category: "Aggregate",
    description: "Counts the rows per time bucket (year, month, week, day, hour, minute or second) of a date or timestamp column, optionally between a start and end time. Buckets are in UTC; weeks start on Monday.",
    fields: [
      { key: "column", label: "Column", kind: "column" },
      { key: "bucket", label: "Time bucket", kind: "select", options: ["Year", "Month", "Week", "Day", "Hour", "Minute", "Second"] },
      { key: "start", label: "Start time", kind: "text", optional: true, placeholder: "2026-01-01" },
      { key: "end", label: "End time", kind: "text", optional: true, placeholder: "2026-12-31" },
    ],
    defaults: { bucket: "Day" },
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const unit = str(p, "bucket") || "Day";
      const start = str(p, "start") ? toDate(str(p, "start")) : null;
      const end = str(p, "end") ? toDate(str(p, "end")) : null;
      if (str(p, "start") && !start) throw new Error(`"${str(p, "start")}" is not a date`);
      if (str(p, "end") && !end) throw new Error(`"${str(p, "end")}" is not a date`);
      const counts = new Map<number, number>();
      for (const r of t.rows) {
        const d = toDate(r[col.name] ?? null);
        if (!d || (start && d < start) || (end && d > end)) continue;
        const b = bucketStart(d, unit).getTime();
        counts.set(b, (counts.get(b) ?? 0) + 1);
      }
      return {
        columns: [
          { name: "bucket_start", type: "Timestamp" },
          { name: "count", type: "Long" },
        ],
        rows: [...counts].sort((a, b) => a[0] - b[0]).map(([b, c]) => ({ bucket_start: new Date(b).toISOString(), count: c })),
      };
    },
    summary: (p) => `${str(p, "column") || "?"} per ${(str(p, "bucket") || "Day").toLowerCase()}`,
  },
  {
    kind: "numeric_distribution",
    label: "Numeric distribution",
    category: "Aggregate",
    description: "Counts the values of a numeric column in equal-width buckets between its minimum and maximum (a histogram). Nulls are counted in a bucket of their own.",
    fields: [
      { key: "column", label: "Column", kind: "column" },
      { key: "buckets", label: "Number of buckets", kind: "text", optional: true, placeholder: "10" },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const k = Math.min(1000, Math.max(1, Math.trunc(Number(str(p, "buckets") || 10)) || 10));
      const vals = t.rows.map((r) => toNumber(r[col.name] ?? null));
      const nums = vals.filter((v): v is number => v !== null);
      const nulls = vals.length - nums.length;
      const columns: Column[] = [
        { name: "bucket_start", type: "Double" },
        { name: "bucket_end", type: "Double" },
        { name: "count", type: "Long" },
      ];
      const rows: Row[] = [];
      if (nums.length) {
        let min = Infinity;
        let max = -Infinity;
        for (const v of nums) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const width = max === min ? 1 : (max - min) / k;
        const counts = new Array(max === min ? 1 : k).fill(0);
        for (const v of nums) counts[Math.min(counts.length - 1, Math.floor((v - min) / width))]++;
        counts.forEach((c, i) => rows.push({ bucket_start: min + i * width, bucket_end: i === counts.length - 1 ? max : min + (i + 1) * width, count: c }));
      }
      if (nulls) rows.push({ bucket_start: null, bucket_end: null, count: nulls });
      return { columns, rows };
    },
    summary: (p) => `${str(p, "column") || "?"} in ${str(p, "buckets") || 10} buckets`,
  },
  {
    kind: "fp_growth",
    label: "Frequent pattern growth",
    category: "Aggregate",
    description:
      "Finds the sets of items that often occur together (market basket analysis): every pattern contained in at least the minimum support share of the rows, with how often it occurs. The items column is an array per row.",
    fields: [
      { key: "column", label: "Items column", kind: "column" },
      { key: "support", label: "Minimum support", kind: "text", placeholder: "0.6", help: "Between 0 and 1: the share of rows a pattern must appear in." },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const support = Number(str(p, "support") || 0.6);
      if (!(support > 0 && support <= 1)) throw new Error("Minimum support must be between 0 and 1");
      const transactions = t.rows.map((r) => {
        const xs = arrayOf(r[col.name] ?? null);
        return xs ? [...new Set(xs.filter((x) => x !== null).map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))))] : [];
      });
      const patterns = frequentPatterns(transactions, support);
      patterns.sort((a, b) => b.count - a.count || a.items.length - b.items.length || a.items.join().localeCompare(b.items.join()));
      return {
        columns: [
          { name: "pattern", type: "String" },
          { name: "pattern_occurrence", type: "Long" },
          { name: "total_count", type: "Long" },
        ],
        rows: patterns.map((x) => ({ pattern: JSON.stringify(x.items), pattern_occurrence: x.count, total_count: transactions.length })),
      };
    },
    summary: (p) => `${str(p, "column") || "?"} with support ≥ ${str(p, "support") || 0.6}`,
  },
  {
    kind: "file_metadata",
    label: "Extract file metadata as rows",
    category: "File",
    description: "Lists the files of an unstructured dataset as rows: path, file name, extension and size in bytes.",
    fields: [],
    run: (t) => {
      if (!t.files) throw new Error("This transform reads a dataset of files (an unstructured dataset)");
      return {
        columns: [
          { name: "file_path", type: "String" },
          { name: "file_name", type: "String" },
          { name: "extension", type: "String" },
          { name: "size_bytes", type: "Long" },
        ],
        rows: t.files.map((f) => {
          const name = f.path.split("/").pop() ?? f.path;
          return { file_path: f.path, file_name: name, extension: name.includes(".") ? name.split(".").pop()!.toLowerCase() : null, size_bytes: f.size };
        }),
      };
    },
    summary: () => "file path, name, extension, size",
  },
  {
    kind: "empty_table",
    label: "Empty table",
    category: "Data preparation",
    description: "Replaces the input with an empty table of the given schema, e.g.  flight_code:Integer, flight_number:String, airline:String.",
    fields: [{ key: "schema", label: "Schema", kind: "text", placeholder: "flight_code:Integer, flight_number:String" }],
    run: (_t, p) => {
      const columns = str(p, "schema")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [name, type = "String"] = s.split(":").map((x) => x.trim());
          const match = COL_TYPES.find((c) => c.toLowerCase() === type.toLowerCase());
          if (!name || !match) throw new Error(`"${s}" is not name:Type (types: ${COL_TYPES.join(", ")})`);
          return { name, type: match };
        });
      if (!columns.length) throw new Error("Give the schema, e.g. id:Integer, name:String");
      return { columns, rows: [] };
    },
    summary: (p) => str(p, "schema") || "?",
  },
  {
    kind: "decompress_gzip",
    label: "Decompress gzip files",
    category: "File",
    description: "Decompresses each gzipped file (.gz) of a dataset of files; the output file drops the .gz suffix. Other files pass through unchanged.",
    fields: [],
    run: (t) => filesTable(inputFiles(t).map((f) => (/\.gz$/i.test(f.path) && !/\.tar\.gz$/i.test(f.path) ? gunzipFile(f) : f))),
    summary: () => "gunzip every .gz file",
  },
  {
    kind: "decompress_tar",
    label: "Decompress tar files",
    category: "File",
    description: "Unpacks each tar archive (.tar, .tar.gz, .tgz) of a dataset of files into its files, under a folder named after the archive. Other files pass through unchanged.",
    fields: [],
    run: (t) => filesTable(inputFiles(t).flatMap((f) => (/\.(tar|tar\.gz|tgz)$/i.test(f.path) ? untarFile(f) : [f]))),
    summary: () => "unpack every tar archive",
  },
  {
    kind: "filter_files",
    label: "Filter files",
    category: "File",
    description: "Keeps (or removes) the files of a dataset of files that match the conditions on file_path, file_name, extension and size_bytes.",
    // edited by FilterForm over FILE_FILTER_COLUMNS
    fields: [
      { key: "mode", label: "Keep or remove files", kind: "select", options: FILTER_MODES },
      { key: "filter", label: "Conditions and condition groups", kind: "text" },
    ],
    run: (t, p) => {
      const files = inputFiles(t);
      const listing: Table = { columns: FILE_FILTER_COLUMNS, rows: files.map(fileListingRow) };
      const test = compileGroup(listing, readFilter(p));
      const remove = str(p, "mode") === "Remove rows";
      return filesTable(files.filter((_f, i) => test(listing.rows[i]) !== remove));
    },
    summary: (p) => `${str(p, "mode") === "Remove rows" ? "remove" : "keep"} files where ${describeGroup(readFilter(p))}`,
  },
  {
    kind: "empty_file",
    label: "Empty file",
    category: "Other",
    description: "Replaces the input with an empty dataset of files (no files), e.g. to start a pipeline whose files arrive later.",
    fields: [{ key: "readMode", label: "Read mode", kind: "select", options: ["SNAPSHOT", "INCREMENTAL", "STREAM", "UNKNOWN"] }],
    run: () => filesTable([]),
    summary: (p) => `no files (${str(p, "readMode") || "SNAPSHOT"})`,
  },
  {
    kind: "empty_media_set_file",
    label: "Empty media set file",
    category: "Other",
    description: "Replaces the input with an empty media set listing (no items), for a media set output of the given schema.",
    fields: [{ key: "schema", label: "Schema", kind: "select", options: ["document", "image", "audio", "video", "spreadsheet", "email", "dicom", "untyped"] }],
    run: () => ({
      columns: [
        { name: "media_item_rid", type: "String" },
        { name: "path", type: "String" },
        { name: "media_type", type: "String" },
        { name: "size", type: "Integer" },
      ],
      rows: [],
      files: [],
    }),
    summary: (p) => `empty ${str(p, "schema") || "document"} media set`,
  },
  {
    kind: "compute_if_absent",
    label: "Compute if expression absent",
    category: "Other",
    description:
      "Computes a SQL expression only for keys it has not computed before: results are kept in a store across builds (the pipeline's state), so a value is computed once per key. Previews compute every row. Changing the store id invalidates every result.",
    fields: [
      { key: "keys", label: "Key", kind: "columns" },
      { key: "expression", label: "Expression (SQL)", kind: "text", placeholder: "upper(name) || '-' || id" },
      { key: "storeId", label: "Store id", kind: "text", placeholder: "my_store", showIf: (p) => str(p, "disableStore") !== "true" },
      {
        key: "skipWhen",
        label: "Do not store results when",
        kind: "text",
        optional: true,
        placeholder: "result IS NULL",
        help: "A SQL condition over result (and the input columns). Empty: null results are not stored.",
      },
      { key: "recomputeNull", label: "Always recompute null results", kind: "boolean", optional: true },
      { key: "disableStore", label: "Disable store", kind: "boolean", optional: true },
    ],
    output: true,
    outputDefault: "result",
    run: (t, p, ctx) => {
      const keys = list(p, "keys").map((k) => need(t, k).name);
      const expr = str(p, "expression").trim();
      const disabled = str(p, "disableStore") === "true";
      const storeId = str(p, "storeId").trim();
      if (!keys.length) throw new Error("Choose the key columns");
      if (!expr) throw new Error("Write the expression");
      if (!storeId && !disabled) throw new Error("Name the store id");
      const engine = ctx?.sql?.engine;
      if (!engine) throw new Error(ctx?.sql?.error ?? "Loading the SQL engine…");
      const store = disabled ? undefined : ctx?.stores;
      const saved = store?.get(storeId) ?? {};
      const keyOf = (r: Row) => JSON.stringify(keys.map((k) => r[k] ?? null));
      const recomputeNull = str(p, "recomputeNull") === "true";
      // each missing key is computed once, from its first row
      const firstOf = new Map<string, number>();
      t.rows.forEach((r, i) => {
        const k = keyOf(r);
        if ((!(k in saved) || (recomputeNull && saved[k] === null)) && !firstOf.has(k)) firstOf.set(k, i);
      });
      const fresh: Record<string, Cell> = {};
      let type: ColType | undefined = store?.type(storeId);
      if (firstOf.size) {
        const sub: Table = { columns: [...t.columns, { name: "__row", type: "Integer" }], rows: [...firstOf.values()].map((i) => ({ ...t.rows[i], __row: i })) };
        const r = engine.query({ input: sub }, `SELECT *, (${expr}) AS result FROM input`);
        type = r.columns.find((c) => c.name === "result")?.type ?? type ?? "String";
        const skipWhen = str(p, "skipWhen").trim() || "result IS NULL";
        const flags = engine.query({ input: r }, `SELECT __row, CASE WHEN (${skipWhen}) THEN 1 ELSE 0 END AS __skip FROM input`).rows;
        const skip = new Set(flags.filter((x) => Number(x.__skip) === 1).map((x) => Number(x.__row)));
        const keep: Record<string, Cell> = {};
        for (const row of r.rows) {
          const i = Number(row.__row);
          const k = keyOf(t.rows[i]);
          fresh[k] = (row.result ?? null) as Cell;
          if (!skip.has(i)) keep[k] = fresh[k];
        }
        if (store && Object.keys(keep).length) store.put(storeId, keep, type);
      }
      const outType: ColType = type ?? "String";
      return setColumn(t, outputName(p, "result"), outType, (r) => {
        const k = keyOf(r);
        return castCell(k in fresh ? fresh[k] : ((saved[k] ?? null) as Cell), outType);
      });
    },
    summary: (p) =>
      `${str(p, "expression") || "?"} per ${list(p, "keys").join(", ") || "?"}${str(p, "disableStore") === "true" ? " (store disabled)" : ` in store ${str(p, "storeId") || "?"}`}`,
  },
  {
    kind: "assign_watermarks",
    label: "Assign timestamps and watermarks",
    category: "Other",
    description:
      "Gives each record its event time from a timestamp column and drops records whose timestamp is null; the column becomes a Timestamp, the event time to choose in downstream time windows.",
    fields: [
      { key: "column", label: "Timestamp expression", kind: "column" },
      { key: "everyRecord", label: "Emit watermark on every record", kind: "boolean", optional: true },
      { key: "idleValue", label: "Idleness timeout value", kind: "text", optional: true, placeholder: "none" },
      {
        key: "idleUnit",
        label: "Idleness timeout unit",
        kind: "select",
        options: ["Seconds", "Milliseconds", "Minutes", "Hours", "Days", "Weeks"],
        showIf: (p) => !!str(p, "idleValue"),
      },
    ],
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const rows = t.rows.map((r) => ({ ...r, [col.name]: castCell(r[col.name] ?? null, "Timestamp") })).filter((r) => r[col.name] !== null);
      return { columns: t.columns.map((c) => (c.name === col.name ? { ...c, type: "Timestamp" as ColType } : c)), rows };
    },
    summary: (p) =>
      `event time ${str(p, "column") || "?"}${str(p, "idleValue") ? `, idle after ${str(p, "idleValue")} ${(str(p, "idleUnit") || "Seconds").toLowerCase()}` : ""}`,
  },
  {
    kind: "validate",
    label: "Validate value",
    category: "Data preparation",
    description:
      "True when the value is a valid identifier or encoding: IPv4, IPv6, UUID, Foundry rid, MIME type, Geohash, H3 index, MGRS, Nexus GeoPoint ('lat,lon'), GeoJSON geometry, Foundry media reference or Gotham delegated media gid.",
    fields: [
      { key: "column", label: "Expression", kind: "column" },
      { key: "fn", label: "Check", kind: "select", options: VALIDATORS },
    ],
    output: true,
    outputDefault: (p) => `${slug(str(p, "fn") || VALIDATORS[0])}_${str(p, "column") || "value"}`,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const fn = (str(p, "fn") || VALIDATORS[0]) as Validator;
      return setColumn(t, outputName(p, `${slug(fn)}_${col.name}`), "Boolean", (r) => {
        const v = r[col.name] ?? null;
        if (v === null) return fn === "Is valid delegated media gid" ? null : false;
        return isValidValue(fn, String(v));
      });
    },
    summary: (p) => `${(str(p, "fn") || VALIDATORS[0]).toLowerCase()}(${str(p, "column") || "?"})`,
  },
  {
    kind: "array_condition",
    label: "Array elements satisfy",
    category: "Array",
    description:
      "All array elements satisfy / Any array element satisfies a condition: each element is compared with a value or another column (element < base_line), or tested for null / true. A null array gives null.",
    fields: [
      { key: "column", label: "Array", kind: "column" },
      { key: "separator", label: "Separator", kind: "text", optional: true, placeholder: "empty = JSON array" },
      { key: "quantifier", label: "Elements", kind: "select", options: ["All", "Any"] },
      { key: "op", label: "Condition", kind: "select", options: ELEMENT_OPS },
      { key: "value", label: "Value", kind: "text", placeholder: "column name or value", showIf: (p) => !ELEMENT_UNARY.has(str(p, "op") || ELEMENT_OPS[0]) },
    ],
    output: true,
    outputDefault: (p) => `${(str(p, "quantifier") || "All").toLowerCase()}_${str(p, "column") || "array"}`,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const op = str(p, "op") || ELEMENT_OPS[0];
      const all = (str(p, "quantifier") || "All") === "All";
      const raw = str(p, "value").trim();
      const other = t.columns.find((c) => c.name === raw);
      return setColumn(t, outputName(p, `${all ? "all" : "any"}_${col.name}`), "Boolean", (r) => {
        const xs = readArray(r[col.name] ?? null, str(p, "separator"));
        if (xs === null) return null;
        const right: Cell = other ? (r[other.name] ?? null) : raw;
        const test = (x: unknown) => elementTest(op, elementCell(x), right);
        return all ? xs.every(test) : xs.some(test);
      });
    },
    summary: (p) =>
      `${(str(p, "quantifier") || "All").toLowerCase()} elements of ${str(p, "column") || "?"} ${str(p, "op") || ELEMENT_OPS[0]}${ELEMENT_UNARY.has(str(p, "op") || ELEMENT_OPS[0]) ? "" : ` ${str(p, "value") || "?"}`}`,
  },
  {
    kind: "combine_arrays",
    label: "Combine arrays",
    category: "Array",
    description:
      "Array concat (every element, in order), union (distinct), intersect, difference (in the first, not in the others) and cartesian product (every combination, as structs named after the columns) of two or more array columns.",
    fields: [
      { key: "columns", label: "Arrays", kind: "columns" },
      { key: "fn", label: "Function", kind: "select", options: ["Concat", "Union", "Intersect", "Difference", "Cartesian product"] },
      { key: "separator", label: "Separator", kind: "text", optional: true, placeholder: "empty = JSON arrays" },
    ],
    output: true,
    outputDefault: (p) => slug(str(p, "fn") || "Concat"),
    run: (t, p) => {
      const cols = list(p, "columns").map((c) => need(t, c).name);
      if (!cols.length) throw new Error("Choose the array columns");
      const fn = str(p, "fn") || "Concat";
      const sep = str(p, "separator");
      return setColumn(t, outputName(p, slug(fn)), "String", (r) => {
        const arrays = cols.map((c) => readArray(r[c] ?? null, sep));
        if (fn === "Cartesian product") {
          // a null array counts as empty: no combinations
          let rows: Record<string, unknown>[] = [{}];
          arrays.forEach((xs, i) => {
            rows = rows.flatMap((acc) => (xs ?? []).map((x) => ({ ...acc, [cols[i]]: x ?? null })));
          });
          return JSON.stringify(arrays.some((xs) => !xs?.length) ? [] : rows);
        }
        if (arrays.some((xs) => xs === null)) return null;
        const [first, ...rest] = arrays as unknown[][];
        const key = (x: unknown) => cellKey(elementCell(x));
        const distinct = (xs: unknown[]) => xs.filter((x, i) => xs.findIndex((y) => key(y) === key(x)) === i);
        if (fn === "Concat") return JSON.stringify(arrays.flat(1));
        if (fn === "Union") return JSON.stringify(distinct(arrays.flat(1)));
        const sets = rest.map((xs) => new Set(xs.map(key)));
        if (fn === "Intersect") return JSON.stringify(distinct(first.filter((x) => sets.every((s) => s.has(key(x))))));
        return JSON.stringify(distinct(first.filter((x) => !sets.some((s) => s.has(key(x))))));
      });
    },
    summary: (p) => `${(str(p, "fn") || "Concat").toLowerCase()}(${list(p, "columns").join(", ") || "?"})`,
  },
  {
    kind: "update_struct",
    label: "Struct / map function",
    category: "Struct",
    description:
      "Add or update struct field (a locator like airline.id reaches inner fields), Add or update map (sets a key), or Is empty struct (true when every field is null, recursively through inner structs, maps and arrays).",
    fields: [
      { key: "column", label: "Struct or map", kind: "column" },
      { key: "fn", label: "Function", kind: "select", options: ["Add or update struct field", "Add or update map", "Is empty struct"] },
      { key: "locator", label: "Field / key", kind: "text", placeholder: "airline.id", showIf: (p) => str(p, "fn") !== "Is empty struct" },
      { key: "value", label: "Value", kind: "text", placeholder: "column name or value", showIf: (p) => str(p, "fn") !== "Is empty struct" },
    ],
    output: true,
    run: (t, p) => {
      const col = need(t, str(p, "column"));
      const fn = str(p, "fn") || "Add or update struct field";
      const parse = (v: Cell): Record<string, unknown> | null => {
        if (v === null) return null;
        try {
          const o = typeof v === "string" ? JSON.parse(v) : v;
          return isObject(o) ? o : null;
        } catch {
          return null;
        }
      };
      if (fn === "Is empty struct") return setColumn(t, outputName(p, `is_empty_${col.name}`), "Boolean", (r) => {
        const o = parse(r[col.name] ?? null);
        return o === null ? null : isEmptyDeep(o);
      });
      const locator = str(p, "locator").trim();
      if (!locator) throw new Error(fn === "Add or update map" ? "Give the key" : "Give the field locator, e.g. airline.id");
      const raw = str(p, "value");
      const other = t.columns.find((c) => c.name === raw.trim());
      const path = fn === "Add or update map" ? [locator] : locator.split(".").map((s) => s.trim());
      return setColumn(t, outputName(p), "String", (r) => {
        const o = parse(r[col.name] ?? null);
        if (o === null) return null;
        let value: unknown = other ? (r[other.name] ?? null) : raw;
        if (typeof value === "string" && /^[[{]/.test(value.trim())) {
          try {
            value = JSON.parse(value);
          } catch {}
        } else if (!other && raw !== "" && Number.isFinite(Number(raw))) value = Number(raw);
        const out = structuredClone(o);
        let cur: Record<string, unknown> = out;
        for (const k of path.slice(0, -1)) {
          if (!isObject(cur[k])) cur[k] = {};
          cur = cur[k] as Record<string, unknown>;
        }
        cur[path[path.length - 1]] = value;
        return JSON.stringify(out);
      });
    },
    summary: (p) =>
      str(p, "fn") === "Is empty struct" ? `is_empty(${str(p, "column") || "?"})` : `${str(p, "column") || "?"}.${str(p, "locator") || "?"} = ${str(p, "value") || "?"}`,
  },
];
STEPS.push(...PB_STEPS);

export const STEP_BY_KIND = new Map(STEPS.map((s) => [s.kind, s]));
export const STEP_CATEGORIES = [...new Set(STEPS.map((s) => s.category))];

export type StepsResult = { table: Table; error?: undefined } | { table: Table; error: string; step: number };

// ---------------------------------------------------------------- custom functions

/** Marks an argument in a custom transform's saved steps: ARG_MARK + argument id. */
export const ARG_MARK = "\u0002arg:";
export const FN_PREFIX = "fn:";
const argKey = (a: FunctionArg) => `arg_${a.id}`;

/** Every string in a value (and in JSON held in strings) passed through `fn`. */
export function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.length > 1) {
      try {
        return JSON.stringify(mapStrings(JSON.parse(t), fn));
      } catch {}
    }
    return fn(value);
  }
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/** Column names a series of steps reads, among the given columns (candidates for custom transform arguments). */
export function columnsUsed(steps: Step[], columns: Column[]): Column[] {
  const used = new Set<string>();
  const names = new Set(columns.map((c) => c.name));
  for (const s of steps) mapStrings(s.params, (v) => (names.has(v) && used.add(v), v));
  return columns.filter((c) => used.has(c.name));
}

/** Steps with chosen columns turned into arguments (column name → ARG_MARK + arg id). */
export function abstractSteps(steps: Step[], args: { column: string; arg: FunctionArg }[]): Step[] {
  const byColumn = new Map(args.map((a) => [a.column, ARG_MARK + a.arg.id]));
  return steps.map((s) => ({ ...s, params: mapStrings(s.params, (v) => byColumn.get(v) ?? v) as Params }));
}

function bindArgs(steps: Step[], binding: Record<string, string>): Step[] {
  return steps.map((s) => ({
    ...s,
    id: s.id,
    params: mapStrings(s.params, (v) => (v.startsWith(ARG_MARK) ? (binding[v.slice(ARG_MARK.length)] ?? v) : v)) as Params,
  }));
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

const udfArgKey = (name: string) => `udfarg_${name}`;

/**
 * A Java UDF as a step: the input schema's columns (by name; extra columns are left out) go through the UDF on
 * the server and the step outputs the UDF's rows. A row map UDF outputs one row per input row, a flat map any number.
 * A keyed process UDF outputs any number per record and per timer; in a streaming job its state, timers and
 * watermark carry over between micro-batches (ctx.keyedState), elsewhere it runs as a batch: empty state, and every
 * event-time timer fires at the end of the input.
 */
export const udfTypeLabel = (u: Pick<UdfVersion, "type">) => (u.type === "map" ? "Row map" : u.type === "flat_map" ? "Flat map" : "Keyed process");

export function udfStepDef(fn: CustomUdf): StepDef {
  const u = fn.udf;
  return {
    kind: FN_PREFIX + fn.id,
    label: fn.name,
    category: "User-defined functions",
    description: `${u.description || `${udfTypeLabel(u)} UDF`} (${u.repoName} ${u.tag}).${u.type === "keyed_process" ? ` Keyed by ${(u.keyColumns ?? []).join(", ")}${u.eventTimeColumn ? `, event time ${u.eventTimeColumn}` : ""}.` : ""} Input: ${u.input.fields.map((f) => `${f.name} ${f.type}`).join(", ")}. Output: ${u.output.fields
      .map((f) => `${f.name} ${f.type}`)
      .join(", ")}.`,
    fields: u.arguments.map((a) => ({
      key: udfArgKey(a.name),
      label: `${a.name}${a.required ? "" : " (optional)"}`,
      kind: a.field_type === "boolean" ? ("boolean" as const) : ("text" as const),
      optional: !a.required,
      help: a.description || undefined,
    })),
    run: (t, p, ctx) => {
      if (t.files) throw new Error("A UDF takes rows: extract rows from the files first");
      const missing = u.input.fields.filter((f) => !t.columns.some((c) => c.name === f.name));
      if (missing.length) throw new Error(`${fn.name} needs the columns ${missing.map((f) => `${f.name} (${f.type})`).join(", ")}`);
      const config: Record<string, string> = {};
      for (const a of u.arguments) {
        const v = str(p, udfArgKey(a.name));
        if (v !== "") config[a.name] = v;
        else if (a.required) throw new Error(`Set the argument "${a.name}"`);
      }
      const rows = t.rows.map((r) => Object.fromEntries(u.input.fields.map((f) => [f.name, cellOf(r, f.name)])));
      const columns: Column[] = u.output.fields.map((f) => ({ name: f.name, type: f.type }));
      let key = `udf:${u.repoId}:${u.tag}:${u.name}:${keyHash(JSON.stringify([config, rows]))}`;
      const payload: Record<string, unknown> = { repo_id: u.repoId, tag: u.tag, udf: u.name, config, rows };
      if (u.type === "keyed_process") {
        // streaming: start from the state the last micro-batch left (per node and step); batch: empty, bounded input
        const scope = `${ctx?.nodeId ?? ""}:${ctx?.stepId ?? fn.id}`;
        const saved = ctx?.keyedState ? (ctx.keyedState.get(scope) ?? null) : null;
        payload.keyed = saved;
        payload.bounded = !ctx?.keyedState;
        key = `udf:${u.repoId}:${u.tag}:${u.name}:${keyHash(JSON.stringify([config, rows, saved, payload.bounded]))}`;
        ctx?.keyedState?.use(scope, key);
      }
      const value = service(ctx, "udf", key, payload) as { rows: Row[] } | undefined;
      // while the server runs it, the step shows its output columns with no rows yet
      return { columns, rows: value ? value.rows.map((r) => Object.fromEntries(columns.map((c) => [c.name, (r[c.name] ?? null) as Cell]))) : [] };
    },
    summary: (p) =>
      `${u.repoName} ${u.tag}${u.arguments.length ? ` · ${u.arguments.map((a) => `${a.name}=${str(p, udfArgKey(a.name)) || "–"}`).join(", ")}` : ""}`,
  };
}

const pyArgKey = (name: string) => `pyarg_${name}`;
const PY_COL: Record<string, ColType> = { string: "String", integer: "Integer", long: "Long", double: "Double", float: "Double", boolean: "Boolean", date: "Date", timestamp: "Timestamp" };

/**
 * A Python function as a step: each input is mapped to a column, the function runs once per row on the server and
 * its return value becomes a new column (a struct or a list as JSON text). A row whose call fails gets null; when
 * every row fails the step fails with the first error.
 */
export function pyfnStepDef(fn: CustomPyFunction): StepDef {
  const f = fn.fn;
  const out = PY_COL[f.output] ?? "String";
  return {
    kind: FN_PREFIX + fn.id,
    label: fn.name,
    category: "User-defined functions",
    description: `${fn.description || "Python function"} (${f.repoName ?? "functions"} ${f.version}). Inputs: ${f.inputs.map((i) => `${i.name} ${i.type}`).join(", ") || "none"}. Returns ${f.output}, once per row.`,
    fields: f.inputs.map((i) => ({ key: pyArgKey(i.name), label: `${i.name} · ${i.type}`, kind: "column" as const, optional: !i.required })),
    output: true,
    outputDefault: slug(f.name),
    run: (t, p, ctx) => {
      if (t.files) throw new Error("A UDF takes rows: extract rows from the files first");
      const mapped = f.inputs.map((i) => [i.name, str(p, pyArgKey(i.name))] as const);
      const missing = f.inputs.filter((i, n) => i.required && !mapped[n][1]);
      if (missing.length) throw new Error(`Map ${missing.map((i) => i.name).join(", ")} to columns`);
      const rows = t.rows.map((r) => Object.fromEntries(mapped.filter(([, col]) => col).map(([name, col]) => [name, cellOf(r, col)])));
      const key = `pyfn:${f.functionId}:${f.version}:${keyHash(JSON.stringify(rows))}`;
      const value = service(ctx, "pyfn", key, { function_id: f.functionId, version: f.version, rows }) as { rows: { value?: unknown; error?: string }[] } | undefined;
      const results = value?.rows ?? [];
      if (results.length && results.every((r) => r.error)) throw new Error(`${f.name}: ${results[0].error}`);
      let i = 0;
      // while the server runs it, the new column is empty
      return setColumn(t, outputName(p, slug(f.name)), out, () => {
        const v = results[i++]?.value;
        return v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : (v as Cell);
      });
    },
    summary: (p) => `${f.name}(${f.inputs.map((i) => str(p, pyArgKey(i.name)) || "?").join(", ")})`,
  };
}

/** A custom function as a step the transform editor and evaluator can use. */
export function customStepDef(fn: CustomFunction): StepDef {
  if (fn.kind === "udf") return udfStepDef(fn);
  if (fn.kind === "pyfn") return pyfnStepDef(fn);
  const argFields: FieldDef[] = fn.args.map((a) => ({
    key: argKey(a),
    label: `${a.name}${a.type !== "Any" ? ` · Expression<${a.type}>` : ""}`,
    kind: "column",
  }));
  const binding = (t: Table, p: Params): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const a of fn.args) {
      const col = str(p, argKey(a));
      if (!col) throw new Error(`Choose a column for "${a.name}"`);
      const c = need(t, col);
      if (a.type !== "Any" && c.type !== a.type)
        throw new Error(`"${a.name}" takes Expression<${a.type}>, but "${col}" is ${c.type} — cast it first`);
      out[a.id] = col;
    }
    return out;
  };
  return {
    kind: FN_PREFIX + fn.id,
    label: fn.name,
    category: fn.kind === "expression" ? "Custom expressions" : "Custom transforms",
    description: fn.description || (fn.kind === "expression" ? `Custom expression: ${fn.definition}` : `Custom transform of ${fn.steps.length} boards`),
    fields: argFields,
    output: fn.kind === "expression",
    outputDefault: fn.kind === "expression" ? slug(fn.name) : undefined,
    run: (t, p, ctx) => {
      const b = binding(t, p);
      if (fn.kind === "transform") {
        const r = applySteps(t, bindArgs(fn.steps, b), ctx);
        if (r.error !== undefined) throw new Error(`${fn.name}, board ${r.step + 1}: ${r.error}`);
        return r.table;
      }
      const engine = ctx?.sql?.engine;
      if (!engine) throw new Error(ctx?.sql?.error ?? "Loading the SQL engine…");
      let expr = fn.definition;
      for (const a of fn.args) expr = expr.split(`{${a.name}}`).join(quoteIdent(b[a.id]));
      const res = engine.query({ input: t }, `SELECT ${expr} AS __value FROM input`);
      const col = res.columns[0];
      if (!col) throw new Error("The expression returned no value");
      const values = res.rows.map((r) => r.__value ?? null);
      let i = 0;
      return setColumn(t, outputName(p, slug(fn.name)), col.type, () => values[i++] ?? null);
    },
    summary: (p) => `${fn.name}(${fn.args.map((a) => str(p, argKey(a)) || "?").join(", ")})`,
  };
}

/** The definition of a step kind: built-in, or a custom function of the pipeline. */
export function stepDefOf(kind: string, functions?: CustomFunction[]): StepDef | undefined {
  if (kind.startsWith(FN_PREFIX)) {
    const fn = functions?.find((f) => f.id === kind.slice(FN_PREFIX.length));
    return fn ? customStepDef(fn) : undefined;
  }
  return STEP_BY_KIND.get(kind);
}

/** Runs steps in order; on failure returns the table before the failing step. */
export function applySteps(t: Table, steps: Step[], ctx?: StepContext): StepsResult {
  for (let i = 0; i < steps.length; i++) {
    const def = stepDefOf(steps[i].kind, ctx?.functions);
    if (!def)
      return { table: t, error: steps[i].kind.startsWith(FN_PREFIX) ? "This custom function was deleted" : `Unknown transform "${steps[i].kind}"`, step: i };
    try {
      // settings come from storage: an option no longer (or never) offered is an error, not a silent fallback
      for (const f of def.fields) {
        const v = steps[i].params[f.key];
        if (f.kind === "select" && f.options && typeof v === "string" && v && !f.options.includes(v))
          throw new Error(`${f.label}: "${v}" is not one of the choices`);
      }
      t = def.run(t, steps[i].params, ctx && { ...ctx, stepId: steps[i].id });
    } catch (e) {
      return { table: t, error: (e as Error).message, step: i };
    }
  }
  return { table: t };
}

// ---------------------------------------------------------------- join / union

const MAX_PAIRS = 5_000_000;

/** Column selection of a join; undefined for joins saved before it existed. */
export type JoinSelect = { left?: string[] | null; right?: string[] | null; prefix?: string };

export const joinSelectOf = (n: Pick<JoinNode, "leftColumns" | "rightColumns" | "rightPrefix">): JoinSelect | undefined =>
  n.rightColumns === undefined && n.leftColumns === undefined && n.rightPrefix === undefined
    ? undefined
    : { left: n.leftColumns ?? null, right: n.rightColumns ?? null, prefix: n.rightPrefix ?? "" };

/** The output of a join node from its two inputs (also used by the join editor's preview). */
export function joinTables(l: Table, r: Table, n: Pick<JoinNode, "leftKey" | "rightKey" | "keys" | "how" | "leftColumns" | "rightColumns" | "rightPrefix">): Table {
  if (l.files || r.files) throw new Error("Extract rows from the files before joining them");
  return join(l, r, joinKeys(n), n.how, joinSelectOf(n));
}

function join(l: Table, r: Table, keys: JoinKey[], how: JoinHow, select?: JoinSelect): Table {
  if (how === "cross") {
    if (l.rows.length * r.rows.length > 2_000_000) throw new Error("A cross join of these inputs would make more than 2,000,000 rows");
    keys = [];
  } else if (!keys.length) throw new Error("Choose the columns to join on");
  for (const k of keys) {
    need(l, k.left);
    need(r, k.right);
  }
  const isEq = (k: JoinKey) => (k.op ?? "=") === "=" || k.op === "<=>";
  const eq = keys.filter(isEq);
  const other = keys.filter((k) => !isEq(k));
  if (how !== "cross" && !eq.length && l.rows.length * r.rows.length > MAX_PAIRS)
    throw new Error("A join without any = condition compares every pair of rows — add an = key or filter the inputs first (limit 5,000,000 pairs)");

  const keyOf = (row: Row, side: "left" | "right") => {
    const parts: string[] = [];
    for (const k of eq) {
      const v = row[k[side]] ?? null;
      if (isEmpty(v)) {
        // null-safe keys match null with null; "=" keys never match a null
        if (k.op !== "<=>") return null;
        parts.push("\u0000null");
      } else parts.push(String(v));
    }
    return parts.join("\u0001");
  };
  const index = new Map<string, number[]>();
  if (eq.length)
    r.rows.forEach((row, i) => {
      const k = keyOf(row, "right");
      if (k === null) return;
      if (!index.has(k)) index.set(k, []);
      index.get(k)!.push(i);
    });
  const all = r.rows.map((_, i) => i);
  const passes = (lrow: Row, rrow: Row) =>
    other.every((k) => {
      const a = lrow[k.left] ?? null;
      const b = rrow[k.right] ?? null;
      if (k.op === "!<=>" && (isEmpty(a) || isEmpty(b))) return isEmpty(a) !== isEmpty(b);
      if (isEmpty(a) || isEmpty(b)) return false;
      const c = looseCompare(a, b);
      if (k.op === "!<=>") return c !== 0;
      return k.op === "!=" ? c !== 0 : k.op === "<" ? c < 0 : k.op === "<=" ? c <= 0 : k.op === ">" ? c > 0 : c >= 0;
    });
  /** indexes of right rows matching a left row */
  const matches = (lrow: Row): number[] => {
    if (how === "cross") return all;
    let candidates = all;
    if (eq.length) {
      const k = keyOf(lrow, "left");
      candidates = k === null ? [] : (index.get(k) ?? []);
    }
    return other.length ? candidates.filter((i) => passes(lrow, r.rows[i])) : candidates;
  };

  // chosen columns (all when not chosen), each once
  const pickCols = (t: Table, names: string[] | null | undefined) => (names ? [...new Set(names)].map((c) => need(t, c)) : t.columns);
  const leftCols = select ? pickCols(l, select.left) : l.columns;
  const project = (row: Row) => (select ? Object.fromEntries(leftCols.map((c) => [c.name, row[c.name] ?? null])) : row);

  if (how === "left semi" || how === "left anti") {
    const semi = how === "left semi";
    return { columns: leftCols, rows: l.rows.filter((row) => (matches(row).length > 0) === semi).map(project) };
  }

  // right key columns named like their = partner on the left are merged into it
  // same-named = keys merge into one column only when both sides have the same type; otherwise the right one stays as …_right
  const leftType = (name: string) => l.columns.find((c) => c.name === name)?.type;
  const rightType = (name: string) => r.columns.find((c) => c.name === name)?.type;
  // with a column selection nothing is merged: the user picks which key columns to keep
  const merged = select ? new Set<string>() : new Set(eq.filter((k) => k.left === k.right && leftType(k.left) === rightType(k.right)).map((k) => k.right));
  const taken = new Set(leftCols.map((c) => c.name));
  const rename = new Map<string, string>();
  const rightCols: Column[] = [];
  for (const c of select ? pickCols(r, select.right) : r.columns) {
    if (merged.has(c.name)) continue;
    let name = (select?.prefix ?? "") + c.name;
    while (taken.has(name)) name += "_right";
    taken.add(name);
    rename.set(c.name, name);
    rightCols.push({ ...c, name });
  }
  const columns = [...leftCols, ...rightCols];
  const nullLeft = Object.fromEntries(leftCols.map((c) => [c.name, null]));
  const nullRight = Object.fromEntries(rightCols.map((c) => [c.name, null]));
  const mapRight = (row: Row) => Object.fromEntries([...rename].map(([from, to]) => [to, row[from] ?? null]));

  const rows: Row[] = [];
  const matched = new Set<number>();
  for (const row of l.rows) {
    const hits = matches(row);
    if (hits.length) {
      for (const i of hits) {
        matched.add(i);
        rows.push({ ...project(row), ...mapRight(r.rows[i]) });
      }
    } else if (how === "left" || how === "outer") rows.push({ ...project(row), ...nullRight });
  }
  if (how === "right" || how === "outer")
    r.rows.forEach((row, i) => {
      if (matched.has(i)) return;
      rows.push({ ...nullLeft, ...mapRight(row), ...Object.fromEntries([...merged].map((name) => [name, row[name] ?? null])) });
    });
  return { columns, rows };
}

/** Union by column name; missing columns are null, columns whose types disagree become strings. */
function union(tables: Table[]): Table {
  const types = new Map<string, ColType>();
  for (const t of tables)
    for (const c of t.columns) {
      const prev = types.get(c.name);
      types.set(c.name, prev && prev !== c.type ? "String" : c.type);
    }
  const columns = [...types].map(([name, type]) => ({ name, type }));
  const rows = tables.flatMap((t) =>
    t.rows.map((r) =>
      Object.fromEntries(columns.map((c) => [c.name, c.type === "String" ? castCell(cellOf(r, c.name), "String") : cellOf(r, c.name)])),
    ),
  );
  return { columns, rows };
}

// ---------------------------------------------------------------- evaluation

/** What evaluation depends on: the nodes without their position or legend colour. */
export const logicKey = (nodes: PipelineNode[]) =>
  JSON.stringify(nodes.map((n) => ({ ...n, x: 0, y: 0, color: undefined })));

/** `pending`: rows whose value is still being computed (LLM answers, extracted text …), shown as null meanwhile. */
export type NodeResult = { table: Table; error?: undefined; pending?: number } | { table?: undefined; error: string; pending?: number };

/** Work the synchronous evaluator cannot do itself (LLM calls, text extraction, model inference): it looks answers
 *  up by key and asks for the missing ones, which the caller computes and then evaluates again. */
export type ServiceRequest = { key: string; kind: "llm" | "media" | "model" | "parse" | "embed" | "udf" | "pyfn" | "cipher"; payload: Record<string, unknown> };
export type ServiceAnswer = { value: unknown } | { error: string };
export type Services = {
  get: (key: string) => ServiceAnswer | undefined;
  request: (r: ServiceRequest) => void;
};

export type EvalOptions = {
  /** previews read sampled inputs and compute LLM answers for the first rows only */
  preview?: boolean;
  services?: Services;
  parameters?: Parameter[];
  functions?: CustomFunction[];
  subgraphs?: Subgraph[];
  /** tables for InputNodes (inside a subgraph or unit test), by input id */
  inputs?: Record<string, Table>;
  /** incremental builds: rows of each dataset already processed by earlier builds */
  watermarks?: Record<string, number>;
  /** streaming jobs: the keyed state of keyed process UDF steps */
  keyedState?: KeyedStates;
  /** builds: result stores of Compute if expression absent steps */
  stores?: ResultStores;
};

/** Rows of an LLM node computed in a preview (the board shows the first 50). */
export const LLM_PREVIEW_ROWS = 50;

/** {{name}} in step settings is replaced by the parameter's value. */
export function substituteParameters<T>(value: T, parameters: Parameter[] | undefined): T {
  if (!parameters?.length) return value;
  const byName = new Map(parameters.map((p) => [p.name, p.value]));
  const sub = (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name: string) => (byName.has(name) ? byName.get(name)! : m));
  const walk = (v: unknown): unknown =>
    typeof v === "string" ? sub(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}

/** Applies an input's sampling strategy (previews only). */
export function sampleTable(t: Table, s: Sampling | undefined): Table {
  if (!s || s.kind === "none" || t.files) return t;
  if (s.kind === "first") return { ...t, rows: t.rows.slice(0, Math.max(0, Math.trunc(s.rows))) };
  if (s.kind === "random") {
    const pct = Math.min(100, Math.max(0, s.percent));
    const rand = seeded(s.seed ?? 42);
    return { ...t, rows: t.rows.filter(() => rand() * 100 < pct) };
  }
  let group: ConditionGroup;
  try {
    group = readGroupJson(s.filter);
  } catch {
    throw new Error("The sampling filter is not valid");
  }
  const keep = compileGroup(t, group);
  const rows = t.rows.filter(keep);
  return { ...t, rows: s.rows ? rows.slice(0, s.rows) : rows };
}

const readGroupJson = (text: string): ConditionGroup => readFilter({ filter: text });

/** Returns a memoized evaluator for one version of the pipeline's nodes and datasets. */
export function evaluator(
  p: Pick<Pipeline, "nodes" | "datasets"> & Partial<Pick<Pipeline, "parameters" | "functions" | "subgraphs">>,
  sql?: SqlRuntime,
  options: EvalOptions = {},
): (id: string) => NodeResult {
  const opts: EvalOptions = {
    ...options,
    parameters: options.parameters ?? p.parameters,
    functions: options.functions ?? p.functions,
    subgraphs: options.subgraphs ?? p.subgraphs,
  };
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const names = tableNames(p.nodes);
  const cache = new Map<string, NodeResult>();
  const visiting = new Set<string>();

  const run = (ref: string): NodeResult => {
    const hit = cache.get(ref);
    if (hit) return hit;
    const id = refNode(ref);
    const node = byId.get(id);
    if (!node) return { error: "Input node was removed" };
    if (id !== ref) {
      // a split's False output: computed with its True output
      const r = run(id);
      return cache.get(ref) ?? (r.error !== undefined ? r : { error: "Not a split" });
    }
    if (visiting.has(id)) return { error: "The pipeline has a cycle" };
    visiting.add(id);
    let result: NodeResult;
    try {
      result = compute(node);
    } catch (e) {
      result = { error: (e as Error).message };
    }
    // rows still being computed upstream make this result provisional too
    const upPending = inputsOf(node).reduce((s, i) => s + (cache.get(i)?.pending ?? 0), 0);
    if (upPending && !result.pending) result = { ...result, pending: upPending };
    visiting.delete(id);
    cache.set(id, result);
    return result;
  };

  const label = (ref: string) => {
    const n = byId.get(refNode(ref));
    return n ? (n.kind === "split" ? `${n.name} (${isFalsePort(ref) ? "False" : "True"})` : n.name) : ref;
  };
  const upstream = (ref: string): Table => {
    const r = run(ref);
    if (r.error !== undefined) throw new Error(`Input "${label(ref)}" failed: ${r.error}`);
    return r.table;
  };

  const stepContext = (node: PipelineNode): StepContext => ({
    sql,
    names: () => p.nodes.filter((n) => n.id !== node.id).map((n) => names.get(n.id)!),
    table: (name) => {
      const n = p.nodes.find((x) => x.id !== node.id && names.get(x.id) === name);
      return n ? upstream(n.id) : undefined;
    },
    functions: opts.functions,
    services: opts.services,
    preview: opts.preview,
    nodeId: node.id,
    keyedState: opts.keyedState,
    stores: opts.stores,
  });

  const compute = (node: PipelineNode): NodeResult => {
    switch (node.kind) {
      case "source": {
        const ds = p.datasets[node.datasetId];
        if (!ds) return { error: "Dataset is missing" };
        let table: Table = ds.files ? filesTable(ds.files) : { columns: ds.columns, rows: ds.rows, totalRows: ds.totalRows };
        const mark = opts.watermarks?.[node.datasetId];
        if (node.mode === "incremental" && mark !== undefined && !table.files) table = { ...table, rows: table.rows.slice(mark) };
        if (opts.preview) table = sampleTable(table, node.sampling);
        return { table };
      }
      case "input": {
        const t = opts.inputs?.[node.inputId];
        return t ? { table: t } : { error: "This input is not connected" };
      }
      case "transform": {
        const steps = substituteParameters(node.steps, opts.parameters);
        const ctx = { ...stepContext(node), pending: { count: 0 } };
        const r = applySteps(upstream(node.input), steps, ctx);
        if (r.error !== undefined) return { error: `Step ${r.step + 1}: ${r.error}`, pending: ctx.pending.count || undefined };
        return ctx.pending.count ? { table: r.table, pending: ctx.pending.count } : { table: r.table };
      }
      case "join":
        return { table: joinTables(upstream(node.left), upstream(node.right), node) };
      case "union": {
        if (!node.inputs.length) return { error: "Choose datasets to union" };
        const tables = node.inputs.map(upstream);
        if (node.strict) checkSameSchema(tables, node.inputs.map(label));
        return { table: setOperation(tables, node.mode ?? "union all") };
      }
      case "split": {
        const t = upstream(node.input);
        if (t.files) throw new Error("Extract rows from the files before splitting them");
        const group = readGroupJson(substituteParameters(node.condition, opts.parameters));
        const test = compileGroup(t, group);
        const yes: Row[] = [];
        const no: Row[] = [];
        for (const r of t.rows) (test(r) ? yes : no).push(r);
        cache.set(node.id + FALSE_PORT, { table: { columns: t.columns, rows: no } });
        return { table: { columns: t.columns, rows: yes } };
      }
      case "subgraph": {
        const def = opts.subgraphs?.find((s) => s.id === node.subgraph);
        if (!def) return { error: "The subgraph was deleted" };
        return runSubgraph(def, node.inputs.map((ref, i) => (ref ? upstream(ref) : missingInput(def.inputs[i]?.name))), p.datasets, sql, opts);
      }
      case "llm": {
        const config = substituteParameters(node.config, opts.parameters);
        return computeLlm(upstream(node.input), config, node.id, opts);
      }
      case "model":
        return computeModel(upstream(node.input), node, opts);
    }
  };

  return run;
}

const missingInput = (name = "input"): Table => {
  throw new Error(`Map the subgraph input "${name}" to a node`);
};

/** Columns missing from some union inputs, as Pipeline Builder reports them. */
export function checkSameSchema(tables: Table[], labels: string[]) {
  const all = new Map<string, ColType>();
  for (const t of tables) for (const c of t.columns) if (!all.has(c.name)) all.set(c.name, c.type);
  const problems: string[] = [];
  tables.forEach((t, i) => {
    const missing = [...all.keys()].filter((c) => !t.columns.some((x) => x.name === c));
    if (missing.length) problems.push(`"${labels[i]}" is missing ${missing.map((m) => `"${m}"`).join(", ")}`);
  });
  if (problems.length) throw new Error(`Union inputs must have the same schema: ${problems.join("; ")}`);
}

/** Runs a subgraph with its inputs bound to tables; checks each input has the required columns. */
export function runSubgraph(def: Subgraph, tables: Table[], datasets: Record<string, Dataset>, sql: SqlRuntime | undefined, opts: EvalOptions): NodeResult {
  const inputs: Record<string, Table> = {};
  const errors: string[] = [];
  def.inputs.forEach((inp, i) => {
    const t = tables[i];
    if (!t) return;
    const missing = inp.columns.filter((c) => !t.columns.some((x) => x.name === c.name));
    if (missing.length) errors.push(`Input "${inp.name}" is missing required column${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m.name}"`).join(", ")}`);
    inputs[inp.id] = t;
  });
  if (errors.length) return { error: errors.join("; ") };
  const inner = evaluator({ nodes: def.nodes, datasets }, sql, { ...opts, inputs });
  if (!def.output) return { error: "The subgraph has no output node" };
  const r = inner(def.output);
  if (r.error !== undefined) return { error: `Inside subgraph "${def.name}": ${r.error}` };
  if (def.outputColumns?.length) {
    const missing = def.outputColumns.filter((c) => !r.table.columns.some((x) => x.name === c.name));
    if (missing.length) return { error: `Subgraph output is missing ${missing.map((m) => `"${m.name}"`).join(", ")}` };
  }
  return r;
}

// ---------------------------------------------------------------- export & stats

export function toCsv(t: Table): string {
  const esc = (v: Cell) => {
    if (v === null) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [t.columns.map((c) => esc(c.name)).join(","), ...t.rows.map((r) => t.columns.map((c) => esc(r[c.name])).join(","))].join(
    "\n",
  );
}

export type ColumnStats = {
  rows: number;
  nulls: number;
  distinct: number;
  min: Cell;
  max: Cell;
  mean: number | null;
  top: [Cell, number][];
};

export function columnStats(t: Table, name: string): ColumnStats {
  const col = t.columns.find((c) => c.name === name);
  const vals = t.rows.map((r) => r[name] ?? null);
  const present = vals.filter((v) => !isEmpty(v));
  const counts = new Map<string, [Cell, number]>();
  for (const v of present) {
    const k = cellKey(v);
    const e = counts.get(k);
    if (e) e[1]++;
    else counts.set(k, [v, 1]);
  }
  const sorted = [...present].sort(compareCells);
  const numeric = isNumericType(col?.type);
  const nums = numeric ? present.map(toNumber).filter((n): n is number => n !== null) : [];
  return {
    rows: vals.length,
    nulls: vals.length - present.length,
    distinct: counts.size,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    mean: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
    top: [...counts.values()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

// ---------------------------------------------------------------- outputs

export type ExpectationResult = { id: string; ok: boolean; message: string; mode?: ExpectationMode; kind?: string };

/** The table an output writes: the upstream table mapped to the output's schema. */
export function outputTable(o: Output, upstream: Table): Table {
  if (upstream.files) throw new Error("An output needs rows and columns — extract rows from the files first");
  if (!o.columns) return { columns: upstream.columns, rows: upstream.rows };
  if (!o.columns.length) throw new Error("The output has no columns — use the upstream schema or add a column");
  const names = new Set<string>();
  const cols = o.columns.map((m) => {
    const name = m.name.trim();
    if (!name) throw new Error(`The column from "${m.source}" needs a name`);
    if (names.has(name)) throw new Error(`Two output columns are named "${name}"`);
    names.add(name);
    const src = upstream.columns.find((c) => c.name === m.source);
    if (!src) throw new Error(`Column "${m.source}" is not in the input any more`);
    return { name, type: src.type, source: src.name };
  });
  return {
    columns: cols.map(({ name, type }) => ({ name, type })),
    rows: upstream.rows.map((r) => Object.fromEntries(cols.map((c) => [c.name, cellOf(r, c.source)]))),
  };
}

/** Mapped / total: output columns whose source is still in the input. */
export function mappedCount(o: Output, upstream: Table | undefined): { mapped: number; total: number } {
  if (!upstream) return { mapped: 0, total: o.columns?.length ?? 0 };
  if (!o.columns) return { mapped: upstream.columns.length, total: upstream.columns.length };
  return { mapped: o.columns.filter((m) => upstream.columns.some((c) => c.name === m.source)).length, total: o.columns.length };
}

export const expectationLabel = (e: Expectation) => EXPECTATION_KINDS.find((k) => k.kind === e.kind)?.label ?? e.kind;

export function checkExpectations(t: Table, expectations: Expectation[] = []): ExpectationResult[] {
  return expectations.map((e) => ({ ...checkExpectation(t, e), mode: e.mode ?? "abort", kind: e.kind }));
}

function checkExpectation(t: Table, e: Expectation): ExpectationResult {
  const n = t.rows.length;
  if (e.kind === "rowCount") {
    const min = e.min ?? null;
    const max = e.max ?? null;
    if (min === null && max === null) return { id: e.id, ok: false, message: "Set a minimum and/or maximum row count" };
    const ok = (min === null || n >= min) && (max === null || n <= max);
    const range = min !== null && max !== null ? `${min.toLocaleString()}–${max.toLocaleString()}` : min !== null ? `at least ${min.toLocaleString()}` : `at most ${max!.toLocaleString()}`;
    return { id: e.id, ok, message: `Row count ${range} — has ${n.toLocaleString()}` };
  }
  if (e.kind === "rowLevel") {
    let test: (r: Row) => boolean;
    try {
      test = compileGroup(t, readFilter({ filter: e.condition }));
    } catch (err) {
      return { id: e.id, ok: false, message: `Row-level: ${(err as Error).message}` };
    }
    const desc = describeGroup(readFilter({ filter: e.condition }));
    const bad = t.rows.filter((r) => !test(r)).length;
    return { id: e.id, ok: bad === 0, message: `Every row: ${desc}${bad ? ` — ${bad.toLocaleString()} rows fail` : ""}` };
  }
  const cols = e.kind === "oneOf" ? (e.column ? [e.column] : []) : e.columns;
  if (!cols.length) return { id: e.id, ok: false, message: e.kind === "oneOf" ? "Choose the column to check" : "Choose the columns to check" };
  const missing = cols.filter((c) => !t.columns.some((x) => x.name === c));
  if (missing.length) return { id: e.id, ok: false, message: `Column ${missing.map((m) => `"${m}"`).join(", ")} is not in the output` };
  if (e.kind === "notNull") {
    const bad = t.rows.filter((r) => cols.some((c) => cellOf(r, c) === null)).length;
    return { id: e.id, ok: bad === 0, message: `No nulls in ${cols.join(", ")}${bad ? ` — ${bad.toLocaleString()} rows have one` : ""}` };
  }
  if (e.kind === "notNaN") {
    const notFloat = cols.filter((c) => !["Float", "Double", "Decimal"].includes(t.columns.find((x) => x.name === c)!.type));
    if (notFloat.length) return { id: e.id, ok: false, message: `${notFloat.join(", ")} ${notFloat.length > 1 ? "are" : "is"} not a floating point column` };
    // NaN does not survive into a table (setColumn turns it into null); text "NaN" from files is checked too
    const bad = t.rows.filter((r) => cols.some((c) => {
      const v = cellOf(r, c);
      return (typeof v === "number" && Number.isNaN(v)) || v === "NaN";
    })).length;
    return { id: e.id, ok: bad === 0, message: `No NaN in ${cols.join(", ")}${bad ? ` — ${bad.toLocaleString()} rows have one` : ""}` };
  }
  if (e.kind === "oneOf") {
    const allowed = new Set(e.values);
    if (!allowed.size) return { id: e.id, ok: false, message: "Add the permitted values" };
    const badValues = new Set<string>();
    let bad = 0;
    for (const r of t.rows) {
      const v = cellOf(r, e.column);
      if (v === null || !allowed.has(String(v))) {
        bad++;
        if (badValues.size < 5) badValues.add(v === null ? "null" : String(v));
      }
    }
    return {
      id: e.id,
      ok: bad === 0,
      message: `${e.column} is one of ${e.values.join(", ")}${bad ? ` — ${bad.toLocaleString()} rows are not (${[...badValues].join(", ")})` : ""}`,
    };
  }
  // primary key: no nulls, and unique combination
  const nulls = t.rows.filter((r) => cols.some((c) => cellOf(r, c) === null)).length;
  const seen = new Set<string>();
  let dups = 0;
  for (const r of t.rows) {
    const k = cols.map((c) => cellKey(cellOf(r, c))).join("\u0001");
    if (seen.has(k)) dups++;
    else seen.add(k);
  }
  const problems = [nulls ? `${nulls.toLocaleString()} rows have a null` : "", dups ? `${dups.toLocaleString()} duplicate rows` : ""].filter(Boolean);
  return { id: e.id, ok: !problems.length, message: `Primary key ${cols.join(", ")}${problems.length ? ` — ${problems.join(", ")}` : ""}` };
}
