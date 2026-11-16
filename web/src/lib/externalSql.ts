/**
 * External pipelines (Palantir's "External pipelines with Pipeline Builder"): the graph behind a virtual table
 * output compiled into one SQL statement (a WITH … SELECT chain) that runs in the source's warehouse — Databricks or
 * Snowflake — so no rows pass through this server. The API runs it as CREATE OR REPLACE TABLE … AS (snapshot) or
 * INSERT INTO … (append).
 *
 * What compiles: virtual table inputs of the pipeline's source, joins, splits, and the transforms Select, Drop,
 * Rename, Filter, Drop duplicates, Sort, Limit, Aggregate (group by, rollup, cube), Cast, Add constant column,
 * Uppercase / Lowercase / Change case, Trim, Coalesce, Concatenate strings, Arithmetic, Fill nulls, Find and replace,
 * Null if, Greatest / least, Substring, String length, Pad string, Find position, Regex extract, Conditional column,
 * Unpivot, Window function (ranking, lag / lead, row frames), Explode into rows (text with a separator), Hash columns
 * (SHA-256 / SHA-512 / SHA-1 / MD5), SQL query, the date / time steps (Extract date part, Truncate date, Add to date,
 * Date difference, Current date / timestamp, Format date, Make date, Unix time, Convert time zone, Next day of week,
 * tumbling Time windows, and Cast to a date or timestamp with formats: the Java format letters are translated to each
 * warehouse's own) and Pivot. Timestamps are UTC instants, as in the JS engine: a Databricks session time zone other
 * than UTC shifts what TIMESTAMP values mean there.
 *
 * Pivot's columns come from the data, so it compiles in two phases: without its values `compileOutput` throws
 * `PivotValuesNeeded` carrying a one-row query (the number of distinct values and the values as JSON, sorted); the
 * caller runs it in the warehouse (`resolvePivotValues`) and compiles again with the values, which become one
 * conditional aggregate (agg(CASE WHEN pivot = value THEN …)) per value. Anything else is reported by
 * `externalProblems` (deploy validation), as are the doc's unsupported features: incremental inputs, LLMs, media,
 * union, user-defined functions and geospatial transforms.
 *
 * The DuckDB local engine (dialect duckdb, `local`) compiles more than a warehouse pushdown: Union nodes (by name:
 * an input without a column gives nulls), the Formula step, the Percentile and Mode aggregations, and checkpoint
 * nodes, each compiled once into a table of its own (`Checkpoint`) that the API computes once and shares. Mapping
 * join (values looked up in another node) compiles on every dialect.
 */
import {
  aggOutput,
  aggType,
  FORMULA_CONSTANTS,
  isFalsePort,
  isGroup,
  isLiteral,
  joinKeys,
  joinSelectOf,
  literalText,
  outputName,
  parseConstants,
  readAggs,
  readCases,
  readFilter,
  readSortKeys,
  refNode,
  substituteParameters,
  tableName,
  tableNames,
  tokenize,
  windowOutput,
  type AggSpec,
  type ColType,
  type Column,
  type Condition,
  type ConditionGroup,
  type Expectation,
  type ExpectationResult,
  type FormulaToken,
  type Operand,
  type Output,
  type Params,
  type Pipeline,
  type PipelineNode,
  type Step,
} from "./pipeline";
import { parseDuration } from "./spark";

export type Dialect = "databricks" | "snowflake" | "duckdb";

/** The steps that compile to SQL (the others fail deploy validation of an external pipeline). */
export const PUSHDOWN_STEPS = new Set([
  "select", "drop", "rename", "filter", "dedupe", "sort", "limit", "aggregate", "cast", "constant",
  "uppercase", "lowercase", "case", "trim", "coalesce", "sql",
  "concat", "math", "fill", "replace", "nullif", "greatest", "substring", "length", "pad", "position", "regex_extract",
  "case_when", "unpivot", "window", "explode", "hash",
  "date_part", "date_trunc", "date_add", "date_diff", "current_time", "format_date", "make_date", "unix_time",
  "tz_convert", "next_day", "time_window", "pivot", "mapping_join",
]);

export class PushdownError extends Error {
  constructor(
    public where: string,
    message: string,
  ) {
    super(`${where}: ${message}`);
  }
}

/**
 * A Pivot step's columns are the distinct values of its pivot column: run `sql` in the warehouse (one row: the
 * number of distinct values, at most 201 counted, and the values as a JSON array, sorted) and compile again with
 * the values under `key` in `pivotValues`.
 */
export class PivotValuesNeeded extends Error {
  constructor(
    public key: string,
    public sql: string,
    public where: string,
    /** the checkpoint tables `sql` reads (DuckDB local engine) */
    public checkpoints: Checkpoint[] = [],
  ) {
    super(`${where}: the pivot's values must be read from the source first`);
  }
}

/** Options of a compile: the values of each Pivot step (by `PivotValuesNeeded.key`), read from the warehouse. */
export type CompileOptions = {
  pivotValues?: Record<string, string[]>;
  /** the DuckDB local engine (pipeline_duckdb.py): Files datasets are read as the tables named by `localTable` */
  local?: boolean;
};

/** The table a Files dataset is read as by the DuckDB local engine (the API registers its Parquet file under it). */
export const localTable = (datasetId: string) => `in_${datasetId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 120)}`;

/**
 * A checkpoint node of a DuckDB local pipeline ("Mark as checkpoint", Palantir's checkpoints): compiled on its own
 * into `sql` and read by every statement that needs it as the table `table`. The API computes it once into a Parquet
 * file kept under the hash of its statement and its inputs' identity (api/pipeline_duckdb.py), so the outputs of a
 * build, and the previews after it, share one computation: unchanged logic over unchanged data is never computed
 * again. The list is in dependency order (a checkpoint that reads another comes after it).
 */
export type Checkpoint = { table: string; sql: string };

/** The table a checkpoint node is read as by the DuckDB local engine. */
export const checkpointTable = (nodeId: string) => `cp_${nodeId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 120)}`;

/** The checkpoints of one compile, shared by the compilers of the checkpoints themselves. */
type Checkpoints = { list: Checkpoint[]; columns: Map<string, Column[] | null>; owner: Map<string, string> };

/** The Files datasets a DuckDB local output reads: table name → Files item id. */
export function localInputs(p: Pipeline): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, d] of Object.entries(p.datasets)) if (d.ref?.kind === "drive") out[localTable(id)] = d.ref.itemId;
  return out;
}

/** At most this many distinct values become columns (as the JS engine's Pivot). */
const PIVOT_MAX = 200;

/** A null argument makes the result null (SQL's LEAST and GREATEST skip nulls; the JS engine's min and max do not). */
const nullIfAny = (args: string[], expr: string) => `CASE WHEN ${args.map((a) => `${a} IS NULL`).join(" OR ")} THEN NULL ELSE ${expr} END`;

/**
 * The Formula functions in DuckDB SQL (FORMULA_FUNCTIONS of the JS engine): outside its domain a function is null,
 * as Math.log(-1) is NaN there (DuckDB raises an error instead). rand() is not here: a build would differ from the
 * preview.
 */
const FORMULA_SQL: Record<string, { args: [number, number]; sql: (a: string[]) => string }> = Object.assign(Object.create(null), {
  ln: { args: [1, 1], sql: ([x]: string[]) => `CASE WHEN ${x} > 0 THEN LN(${x}) END` },
  log: { args: [1, 2], sql: ([x, b]: string[]) => (b === undefined ? `CASE WHEN ${x} > 0 THEN LOG10(${x}) END` : `CASE WHEN ${x} > 0 AND ${b} > 0 AND ${b} <> 1 THEN LN(${x}) / LN(${b}) END`) },
  log2: { args: [1, 1], sql: ([x]: string[]) => `CASE WHEN ${x} > 0 THEN LOG2(${x}) END` },
  log10: { args: [1, 1], sql: ([x]: string[]) => `CASE WHEN ${x} > 0 THEN LOG10(${x}) END` },
  log1p: { args: [1, 1], sql: ([x]: string[]) => `CASE WHEN ${x} > -1 THEN LN(1 + ${x}) END` },
  exp: { args: [1, 1], sql: ([x]: string[]) => `EXP(${x})` },
  expm1: { args: [1, 1], sql: ([x]: string[]) => `(EXP(${x}) - 1)` },
  sqrt: { args: [1, 1], sql: ([x]: string[]) => `CASE WHEN ${x} >= 0 THEN SQRT(${x}) END` },
  cbrt: { args: [1, 1], sql: ([x]: string[]) => `CBRT(${x})` },
  abs: { args: [1, 1], sql: ([x]: string[]) => `ABS(${x})` },
  pow: { args: [2, 2], sql: ([x, y]: string[]) => `POW(${x}, ${y})` },
  power: { args: [2, 2], sql: ([x, y]: string[]) => `POW(${x}, ${y})` },
  hypot: { args: [2, 2], sql: ([x, y]: string[]) => `SQRT(${x} * ${x} + ${y} * ${y})` },
  round: { args: [1, 2], sql: ([x, n]: string[]) => (n === undefined ? `ROUND(${x})` : `ROUND(${x}, CAST(${n} AS INTEGER))`) },
  bround: { args: [1, 2], sql: ([x, n]: string[]) => `ROUND_EVEN(${x}, ${n === undefined ? "0" : `CAST(${n} AS INTEGER)`})` },
  rint: { args: [1, 1], sql: ([x]: string[]) => `ROUND_EVEN(${x}, 0)` },
  floor: { args: [1, 1], sql: ([x]: string[]) => `FLOOR(${x})` },
  ceil: { args: [1, 1], sql: ([x]: string[]) => `CEIL(${x})` },
  ceiling: { args: [1, 1], sql: ([x]: string[]) => `CEIL(${x})` },
  sign: { args: [1, 1], sql: ([x]: string[]) => `SIGN(${x})` },
  signum: { args: [1, 1], sql: ([x]: string[]) => `SIGN(${x})` },
  negative: { args: [1, 1], sql: ([x]: string[]) => `(-${x})` },
  pmod: { args: [2, 2], sql: ([a, b]: string[]) => `CASE WHEN ${b} = 0 THEN NULL ELSE ((${a} % ${b}) + ${b}) % ${b} END` },
  min: { args: [1, 99], sql: (a: string[]) => (a.length === 1 ? a[0] : nullIfAny(a, `LEAST(${a.join(", ")})`)) },
  max: { args: [1, 99], sql: (a: string[]) => (a.length === 1 ? a[0] : nullIfAny(a, `GREATEST(${a.join(", ")})`)) },
  sin: { args: [1, 1], sql: ([x]: string[]) => `SIN(${x})` },
  cos: { args: [1, 1], sql: ([x]: string[]) => `COS(${x})` },
  tan: { args: [1, 1], sql: ([x]: string[]) => `TAN(${x})` },
  asin: { args: [1, 1], sql: ([x]: string[]) => `CASE WHEN ${x} BETWEEN -1 AND 1 THEN ASIN(${x}) END` },
  acos: { args: [1, 1], sql: ([x]: string[]) => `CASE WHEN ${x} BETWEEN -1 AND 1 THEN ACOS(${x}) END` },
  atan: { args: [1, 1], sql: ([x]: string[]) => `ATAN(${x})` },
  atan2: { args: [2, 2], sql: ([y, x]: string[]) => `ATAN2(${y}, ${x})` },
  degrees: { args: [1, 1], sql: ([x]: string[]) => `DEGREES(${x})` },
  todegrees: { args: [1, 1], sql: ([x]: string[]) => `DEGREES(${x})` },
  radians: { args: [1, 1], sql: ([x]: string[]) => `RADIANS(${x})` },
  toradians: { args: [1, 1], sql: ([x]: string[]) => `RADIANS(${x})` },
  pi: { args: [0, 0], sql: () => "PI()" },
  e: { args: [0, 0], sql: () => "EXP(1)" },
});

/** A relation in the chain: its CTE name and columns (null after a SQL query step: not known until it runs). */
type Rel = { name: string; columns: Column[] | null; order?: string };

// ---- date / time formats: Java DateTimeFormatter letters (as the JS engine reads and writes them) per warehouse

type FmtToken = { lit: string } | { ch: string; n: number };

/** Splits a Java date pattern into letters and literal text ('…' quotes text, '' is a quote), as formatDate reads it. */
function tokenizePattern(pattern: string, where: string): FmtToken[] {
  const out: FmtToken[] = [];
  const lit = (s: string) => {
    const last = out[out.length - 1];
    if (last && "lit" in last) last.lit += s;
    else out.push({ lit: s });
  };
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i];
    if (ch === "'") {
      const close = pattern.indexOf("'", i + 1);
      if (close === i + 1) {
        lit("'");
        i += 2;
        continue;
      }
      if (close < 0) throw new PushdownError(where, `unclosed quote in "${pattern}"`);
      lit(pattern.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) {
      lit(ch);
      i++;
      continue;
    }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    i += n;
    out.push({ ch, n });
  }
  return out;
}

/** What a pattern letter stands for: a field and its width, normalised (u → y, L → M). */
type Field =
  | "year4" | "year2" | "monthFull" | "monthAbbr" | "month" | "day" | "doy" | "dowAbbr" | "dowFull"
  | "hour24" | "hour12" | "minute" | "second" | "fraction" | "ampm" | "offset";

function fieldOf(t: { ch: string; n: number }, pattern: string, where: string): { f: Field; n: number } {
  const { ch, n } = t;
  const narrow = (f: Field) => {
    if (n > 2) throw new PushdownError(where, `"${ch.repeat(n)}" in "${pattern}" cannot be pushed down: use ${ch} or ${ch}${ch}`);
    return { f, n };
  };
  switch (ch) {
    case "y":
    case "u":
      if (n > 4) throw new PushdownError(where, `"${ch.repeat(n)}" in "${pattern}" cannot be pushed down: use yyyy`);
      return n === 2 ? { f: "year2", n: 2 } : { f: "year4", n: 4 };
    case "M":
    case "L":
      return n >= 4 ? { f: "monthFull", n: 4 } : n === 3 ? { f: "monthAbbr", n: 3 } : { f: "month", n };
    case "d":
      return narrow("day");
    case "D":
      if (n > 3) throw new PushdownError(where, `"${ch.repeat(n)}" in "${pattern}" cannot be pushed down: use D, DD or DDD`);
      return { f: "doy", n };
    case "E":
      return n >= 4 ? { f: "dowFull", n: 4 } : { f: "dowAbbr", n: 3 };
    case "H":
      return narrow("hour24");
    case "h":
      return narrow("hour12");
    case "m":
      return narrow("minute");
    case "s":
      return narrow("second");
    case "S":
      if (n > 9) throw new PushdownError(where, `at most 9 fraction digits (S) in "${pattern}"`);
      return { f: "fraction", n };
    case "a":
      return { f: "ampm", n: 1 };
    case "Z":
    case "X":
    case "x":
      return { f: "offset", n };
    default:
      throw new PushdownError(where, `the format letter "${ch}" in "${pattern}" cannot be pushed down (quote literal text with '…')`);
  }
}

const JAVA_LETTER: Record<Field, (n: number) => string> = {
  year4: () => "yyyy",
  year2: () => "yy",
  monthFull: () => "MMMM",
  monthAbbr: () => "MMM",
  month: (n) => "M".repeat(n),
  day: (n) => "d".repeat(n),
  doy: (n) => "D".repeat(n),
  dowAbbr: () => "EEE",
  dowFull: () => "EEEE",
  hour24: (n) => "H".repeat(n),
  hour12: (n) => "h".repeat(n),
  minute: (n) => "m".repeat(n),
  second: (n) => "s".repeat(n),
  fraction: (n) => "S".repeat(n),
  ampm: () => "a",
  offset: (n) => "X".repeat(Math.min(n, 3)),
};

/** Java pattern text for literal text: quoted when it holds letters or quotes. */
const javaLiteral = (s: string) => (/[A-Za-z']/.test(s) ? `'${s.replace(/'/g, "''")}'` : s);

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_ISO = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const str = (p: Params, k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
const list = (p: Params, k: string) => (Array.isArray(p[k]) ? (p[k] as string[]) : []);

export function quote(d: Dialect, ident: string): string {
  return d === "databricks" ? "`" + ident.replace(/`/g, "``") + "`" : '"' + ident.replace(/"/g, '""') + '"';
}

const STRING_TYPE: Record<Dialect, string> = { databricks: "STRING", snowflake: "VARCHAR", duckdb: "VARCHAR" };

function sqlType(d: Dialect, t: ColType, where: string, decimal?: { precision: number; scale: number }): string {
  switch (t) {
    case "String":
      return STRING_TYPE[d];
    case "Boolean":
      return "BOOLEAN";
    case "Byte":
      return d === "snowflake" ? "NUMBER(3, 0)" : "TINYINT";
    case "Short":
      return d === "snowflake" ? "NUMBER(5, 0)" : "SMALLINT";
    case "Integer":
      return d === "snowflake" ? "NUMBER(10, 0)" : "INT";
    case "Long":
      return d === "snowflake" ? "NUMBER(19, 0)" : "BIGINT";
    case "Float":
      return "FLOAT";
    case "Double":
      return "DOUBLE";
    case "Decimal":
      return `DECIMAL(${decimal?.precision ?? 38}, ${decimal?.scale ?? 18})`;
    case "Date":
      return "DATE";
    case "Timestamp":
      return d === "snowflake" ? "TIMESTAMP_NTZ" : "TIMESTAMP";
    default:
      throw new PushdownError(where, `the ${t} type cannot be pushed down`);
  }
}

function literal(d: Dialect, value: string, type: ColType, where: string): string {
  switch (type) {
    case "String":
    case "Binary":
      return `'${value.replace(/'/g, "''")}'`;
    case "Boolean": {
      const v = value.trim().toLowerCase();
      if (!["true", "false"].includes(v)) throw new PushdownError(where, `"${value}" is not a boolean`);
      return v.toUpperCase();
    }
    case "Date":
    case "Timestamp":
      return `CAST('${value.replace(/'/g, "''")}' AS ${sqlType(d, type, where)})`;
    default: {
      const v = value.trim();
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) throw new PushdownError(where, `"${value}" is not a number`);
      return type === "Decimal" ? `CAST(${v} AS DECIMAL(38, 18))` : v;
    }
  }
}

/** `x` as text (for the case-insensitive string comparisons). */
const asText = (d: Dialect, x: string) => `CAST(${x} AS ${STRING_TYPE[d]})`;

// ---- projection fusion (DuckDB local engine): a run of row-wise steps becomes one SELECT

/** A compiled CTE: its name, statement, and whether it is a row-wise projection of one relation (fusable). */
type Def = { name: string; sql: string; fusable: boolean };
type Item = { expr: string; alias: string };
type Projection = { items: Item[] | "*"; from: string };

/** The largest expression fusion may write: past it the step keeps a CTE (an expression read twice would double). */
const FUSE_MAX = 4000;
const IDENT = /^"((?:[^"]|"")+)"$/;
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The end of the quoted text starting at `i` (its closing quote; a doubled quote is part of it), or -1. */
function quoteEnd(text: string, i: number): number {
  const ch = text[i];
  for (let j = i + 1; j < text.length; j++)
    if (text[j] === ch) {
      if (text[j + 1] === ch) j++;
      else return j;
    }
  return -1;
}

/** The parts of a SELECT list (commas outside quotes and parentheses), or null when it does not parse. */
function splitList(text: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = quoteEnd(text, i);
      if (i < 0) return null;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return null;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth) return null;
  out.push(text.slice(start).trim());
  return out;
}

/** `SELECT <list>\nFROM <relation>` as its items, or null for any other statement. */
function projectionOf(sql: string): Projection | null {
  const at = sql.lastIndexOf("\nFROM ");
  if (at < 0 || !sql.startsWith("SELECT ")) return null;
  const from = sql.slice(at + 6);
  const list = sql.slice(7, at);
  if (!/^(s\d+|"(?:[^"]|"")+")$/.test(from) || list.includes("\n")) return null;
  if (list === "*") return { items: "*", from };
  const parts = splitList(list);
  if (!parts) return null;
  const items: Item[] = [];
  for (const part of parts) {
    const bare = IDENT.exec(part);
    const aliased = /^([\s\S]+?)\s+AS\s+("(?:[^"]|"")+")$/.exec(part);
    if (bare) items.push({ expr: part, alias: bare[1].replace(/""/g, '"') });
    else if (aliased) items.push({ expr: aliased[1], alias: aliased[2].slice(1, -1).replace(/""/g, '"') });
    else return null;
  }
  return { items, from };
}

/** `expr` with each column it reads replaced by that column's expression in `inner`; null when it cannot be. */
function substitute(expr: string, inner: Map<string, string>, star: boolean): string | null {
  let out = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch !== "'" && ch !== '"') {
      out += ch;
      continue;
    }
    const end = quoteEnd(expr, i);
    if (end < 0) return null;
    const token = expr.slice(i, end + 1);
    i = end;
    if (ch === "'") {
      out += token;
      continue;
    }
    // a qualified name (t."x") is not this relation's column
    if (expr[i - token.length] === ".") return null;
    const e = inner.get(token.slice(1, -1).replace(/""/g, '"'));
    if (e === undefined) {
      if (!star) return null;
      out += token;
    } else out += IDENT.test(e) ? e : `(${e})`;
  }
  return out;
}

/** `outer` reading `inner` as one projection, or null when fusing would nest a window or grow an expression too far. */
function fuseTwo(outer: Projection, inner: Projection): Projection | null {
  if (inner.items === "*") return { items: outer.items, from: inner.from };
  if (outer.items === "*") return inner;
  const exprs = new Map(inner.items.map((i) => [i.alias, i.expr]));
  const items: Item[] = [];
  for (const it of outer.items) {
    const bare = IDENT.exec(it.expr);
    // a window function's value is read as it is, never inside another expression (no nesting of windows)
    if (!bare && inner.items.some((x) => /\bOVER \(/.test(x.expr) && it.expr.includes(quoted(x.alias)))) return null;
    const expr = substitute(it.expr, exprs, false);
    if (expr === null || expr.length > FUSE_MAX) return null;
    items.push({ expr, alias: it.alias });
  }
  return { items, from: inner.from };
}

/**
 * The CTEs of a statement whose own text is `tail`, with each row-wise projection that reads another one used
 * nowhere else fused into it: Rename, Cast, Trim, Formula, Conditional column … in a row compile to one SELECT, not a
 * CTE each. DuckDB holds a pipeline's intermediate vectors per projection: a transform of 250 steps over 100
 * columns needed more than 8 GB as 250 nested CTEs, whatever the rows.
 */
function fuseProjections(defs: Def[], tail: string): Def[] {
  const refs = new Map<string, number>();
  for (const text of [...defs.map((d) => d.sql), tail])
    for (const m of text.matchAll(/\bs\d+\b/g)) refs.set(m[0], (refs.get(m[0]) ?? 0) + 1);
  const proj = new Map<string, Projection>();
  const gone = new Set<string>();
  const out = defs.map((d) => ({ ...d }));
  for (const d of out) {
    let p = d.fusable ? projectionOf(d.sql) : null;
    if (!p) continue;
    let fused = false;
    for (let inner = proj.get(p.from); inner && refs.get(p.from) === 1; inner = proj.get(p.from)) {
      const f = fuseTwo(p, inner);
      if (!f) break;
      gone.add(p.from);
      p = f;
      fused = true;
    }
    proj.set(d.name, p);
    if (fused) {
      const list = p.items === "*" ? "*" : p.items.map((i) => (i.expr === quoted(i.alias) ? i.expr : `${i.expr} AS ${quoted(i.alias)}`)).join(", ");
      d.sql = `SELECT ${list}\nFROM ${p.from}`;
    }
  }
  return out.filter((d) => !gone.has(d.name));
}

class Compiler {
  private defs: Def[] = [];
  private n = 0;
  private done = new Map<string, Rel>();
  /** The transform node whose steps are being compiled (keys of the pivot values), and the nodes leading to it. */
  private at = "";
  private path: string[] = [];

  constructor(
    private p: Pipeline,
    private d: Dialect,
    private opts: CompileOptions = {},
    private cps: Checkpoints = { list: [], columns: new Map(), owner: new Map() },
    /** the checkpoint node this compiler computes (compiled as itself, not read from its table) */
    private root = "",
  ) {}

  /** The checkpoints the compiled statements read, in dependency order. */
  get checkpoints(): Checkpoint[] {
    return this.cps.list;
  }

  q = (ident: string) => quote(this.d, ident);

  /** `fusable`: a row-wise projection of one relation (SELECT list … FROM it), which the DuckDB statement may fuse. */
  private add(sql: string, columns: Column[] | null, order?: string, fusable = false): Rel {
    const name = `s${++this.n}`;
    this.defs.push({ name, sql, fusable });
    return { name, columns, order };
  }

  /** The statement `tail` with the CTEs it reads (on DuckDB, runs of row-wise steps fused into one SELECT). */
  with(tail: string): string {
    const defs = this.d === "duckdb" ? fuseProjections(this.defs, tail) : this.defs;
    return `WITH ${defs.map((c) => `${c.name} AS (\n  ${c.sql.replace(/\n/g, "\n  ")}\n)`).join(",\n")}\n${tail}`;
  }

  private need(rel: Rel, col: string, where: string): Column {
    if (!rel.columns) return { name: col, type: "String" };
    const c = rel.columns.find((x) => x.name === col);
    if (!c) throw new PushdownError(where, `there is no column "${col}"`);
    return c;
  }

  private known(rel: Rel, where: string): Column[] {
    if (!rel.columns) throw new PushdownError(where, "the columns after a SQL query step are not known when the pipeline is compiled: put this step in the query instead");
    return rel.columns;
  }

  /** SELECT list replacing (in place) or adding a column computed by `expr`. */
  private withColumn(rel: Rel, name: string, expr: string, type: ColType, where: string): Rel {
    if (!rel.columns && this.d === "duckdb") {
      // after a SQL query step (columns known when it runs): DuckDB replaces the column the expression reads, or adds it
      const q = this.q(name);
      return this.add(expr.includes(q) ? `SELECT * REPLACE (${expr} AS ${q})\nFROM ${rel.name}` : `SELECT *, ${expr} AS ${q}\nFROM ${rel.name}`, null);
    }
    const cols = this.known(rel, where);
    const exists = cols.some((c) => c.name === name);
    const select = exists ? cols.map((c) => (c.name === name ? `${expr} AS ${this.q(name)}` : this.q(c.name))) : [...cols.map((c) => this.q(c.name)), `${expr} AS ${this.q(name)}`];
    const columns = exists ? cols.map((c) => (c.name === name ? { name, type } : c)) : [...cols, { name, type }];
    return this.add(`SELECT ${select.join(", ")}\nFROM ${rel.name}`, columns, undefined, true);
  }

  // ---- conditions (Pipeline Builder semantics: every comparison with null is false, "is equal to" is null safe)

  private operand(o: Operand, rel: Rel, where: string, prefix = ""): string {
    if (!o) throw new PushdownError(where, "complete every condition");
    if (o.kind === "column") {
      this.need(rel, o.column, where);
      return prefix + this.q(o.column);
    }
    return literal(this.d, o.value, o.type, where);
  }

  private nullSafeEq(a: string, b: string): string {
    return this.d === "databricks" ? `(${a} <=> ${b})` : this.d === "snowflake" ? `EQUAL_NULL(${a}, ${b})` : `(${a} IS NOT DISTINCT FROM ${b})`;
  }

  private condition(c: Condition, rel: Rel, where: string): string {
    const d = this.d;
    const a = this.operand(c.left, rel, where);
    if (c.op === "is null" || c.op === "is not null") {
      const test = c.emptyAsNull ? `(${a} IS NULL OR ${asText(d, a)} = '')` : `${a} IS NULL`;
      return c.op === "is null" ? test : `NOT ${test}`;
    }
    if (c.op === "is in" || c.op === "is not in") {
      if (c.right?.kind !== "value") throw new PushdownError(where, `${c.op} needs a list of values`);
      const type = c.right.type;
      const items = c.right.value.split(",").map((x) => x.trim()).filter((x) => x !== "").map((x) => literal(d, x, type, where));
      if (!items.length) throw new PushdownError(where, "list the values, separated by commas");
      return `${a} ${c.op === "is in" ? "IN" : "NOT IN"} (${items.join(", ")})`;
    }
    const b = this.operand(c.right, rel, where);
    const lower = (x: string) => `LOWER(${asText(d, x)})`;
    switch (c.op) {
      case "is equal to":
        return this.nullSafeEq(a, b);
      case "is not equal to":
        return `NOT ${this.nullSafeEq(a, b)}`;
      case "is equal to (not null safe)":
        return `${a} = ${b}`;
      case "is not equal to (not null safe)":
        return `${a} <> ${b}`;
      case "is less than":
        return `${a} < ${b}`;
      case "is less than or equal to":
        return `${a} <= ${b}`;
      case "is greater than":
        return `${a} > ${b}`;
      case "is greater than or equal to":
        return `${a} >= ${b}`;
      case "is between":
      case "is not between": {
        const hi = this.operand(c.right2 ?? null, rel, where);
        return `${c.op === "is between" ? "" : "NOT "}(${a} BETWEEN ${b} AND ${hi})`;
      }
      case "contains":
      case "does not contain": {
        const t = d === "snowflake" ? `CONTAINS(${lower(a)}, ${lower(b)})` : `INSTR(${lower(a)}, ${lower(b)}) > 0`;
        return c.op === "contains" ? t : `NOT (${t})`;
      }
      case "starts with":
        return d === "duckdb" ? `starts_with(${lower(a)}, ${lower(b)})` : `STARTSWITH(${lower(a)}, ${lower(b)})`;
      case "ends with":
        return d === "duckdb" ? `suffix(${lower(a)}, ${lower(b)})` : `ENDSWITH(${lower(a)}, ${lower(b)})`;
      case "like":
        return `${asText(d, a)} LIKE ${b}`;
      case "not like":
        return `${asText(d, a)} NOT LIKE ${b}`;
      case "regex find":
        return d === "databricks" ? `${asText(d, a)} RLIKE ${b}` : d === "snowflake" ? `REGEXP_INSTR(${asText(d, a)}, ${b}) > 0` : `regexp_matches(${asText(d, a)}, ${b})`;
      case "regex match":
        if (d === "databricks") {
          if (c.right?.kind !== "value") throw new PushdownError(where, "regex match needs the pattern as a value");
          return `${asText(d, a)} RLIKE ${literal(d, `^(?:${c.right.value})$`, "String", where)}`;
        }
        return d === "snowflake" ? `REGEXP_LIKE(${asText(d, a)}, ${b})` : `regexp_full_match(${asText(d, a)}, ${b})`;
      default:
        throw new PushdownError(where, `the condition "${c.op}" cannot be pushed down`);
    }
  }

  /** Two-valued (null counts as false), so NOT of it is the rest of the rows — as Pipeline Builder evaluates it. */
  group(g: ConditionGroup, rel: Rel, where: string): string {
    if (!g.items.length) throw new PushdownError(where, "add a condition");
    const parts = g.items.map((i) => (isGroup(i) ? this.group(i, rel, where) : `COALESCE(${this.condition(i, rel, where)}, FALSE)`));
    return parts.length === 1 ? parts[0] : `(${parts.join(g.match === "any" ? " OR " : " AND ")})`;
  }

  // ---- aggregations

  private agg(a: AggSpec, rel: Rel, where: string): { expr: string; type: ColType } {
    const d = this.d;
    const col = a.column ? this.need(rel, a.column, where) : null;
    const filter = a.where?.items.length ? this.group(a.where, rel, where) : null;
    const x = col ? this.q(col.name) : null;
    const v = (e: string) => (filter ? `CASE WHEN ${filter} THEN ${e} END` : e);
    const numericType: ColType = col && ["Byte", "Short", "Integer", "Long"].includes(col.type) ? "Long" : "Double";
    const needCol = () => {
      if (!x) throw new PushdownError(where, `${a.fn} needs a column`);
      return x;
    };
    switch (a.fn) {
      case "Count":
        return { expr: x ? `COUNT(${v(x)})` : filter ? `COUNT(CASE WHEN ${filter} THEN 1 END)` : "COUNT(*)", type: "Long" };
      case "Count distinct":
        return { expr: `COUNT(DISTINCT ${v(needCol())})`, type: "Long" };
      case "Approx count distinct":
        return { expr: `APPROX_COUNT_DISTINCT(${v(needCol())})`, type: "Long" };
      case "Sum":
        // DuckDB sums whole numbers as HUGEINT (written as DECIMAL(38, 0)): a Long, as Spark and Pipeline Builder type it
        return { expr: d === "duckdb" && numericType === "Long" ? `CAST(SUM(${v(needCol())}) AS BIGINT)` : `SUM(${v(needCol())})`, type: numericType };
      case "Mean":
        return { expr: `AVG(${v(needCol())})`, type: "Double" };
      case "Min":
        return { expr: `MIN(${v(needCol())})`, type: col!.type };
      case "Max":
        return { expr: `MAX(${v(needCol())})`, type: col!.type };
      case "Median":
      case "Approximate median":
        // exact, as the JS engine computes it
        return { expr: `MEDIAN(${v(needCol())})`, type: "Double" };
      case "Percentile": {
        // linear interpolation between the closest ranks, as the JS engine (PERCENTILE_CONT)
        const pct = Number((a.arg ?? "").trim());
        if (!(a.arg ?? "").trim() || !Number.isFinite(pct) || pct < 0 || pct > 100) throw new PushdownError(where, "Percentile must be a number from 0 to 100");
        const frac = String(pct / 100);
        const expr =
          d === "duckdb" ? `QUANTILE_CONT(${v(needCol())}, ${frac})` : d === "databricks" ? `PERCENTILE(${v(needCol())}, ${frac})` : `PERCENTILE_CONT(${frac}) WITHIN GROUP (ORDER BY ${v(needCol())})`;
        return { expr, type: "Double" };
      }
      case "Mode":
        return { expr: `MODE(${v(needCol())})`, type: col!.type };
      case "Std dev":
        return { expr: `STDDEV_SAMP(${v(needCol())})`, type: "Double" };
      case "Variance":
        return { expr: `VAR_SAMP(${v(needCol())})`, type: "Double" };
      case "Std dev (population)":
        return { expr: `STDDEV_POP(${v(needCol())})`, type: "Double" };
      case "Variance (population)":
        return { expr: `VAR_POP(${v(needCol())})`, type: "Double" };
      case "Skewness":
        return { expr: `${d === "snowflake" ? "SKEW" : "SKEWNESS"}(${v(needCol())})`, type: "Double" };
      case "Any true":
        return { expr: `${d === "snowflake" ? "BOOLOR_AGG" : "BOOL_OR"}(${v(needCol())})`, type: "Boolean" };
      case "All true":
        return { expr: `${d === "snowflake" ? "BOOLAND_AGG" : "BOOL_AND"}(${v(needCol())})`, type: "Boolean" };
      case "Correlation":
      case "Covariance (sample)":
      case "Covariance (population)": {
        const y = this.q(this.need(rel, a.arg ?? "", where).name);
        const fn = a.fn === "Correlation" ? "CORR" : a.fn === "Covariance (sample)" ? "COVAR_SAMP" : "COVAR_POP";
        return { expr: `${fn}(${v(needCol())}, ${filter ? `CASE WHEN ${filter} THEN ${y} END` : y})`, type: "Double" };
      }
      default:
        throw new PushdownError(where, `the ${a.fn} aggregation cannot be pushed down`);
    }
  }

  // ---- dates and times: Date columns are days, Timestamp columns UTC instants (a time zone gives the wall clock)

  private tsType = () => sqlType(this.d, "Timestamp", "");
  private intType = () => sqlType(this.d, "Integer", "");
  private longType = () => sqlType(this.d, "Long", "");

  /** The column as a timestamp: a date at midnight UTC, text read as ISO 8601. */
  private ts(col: Column, where: string): string {
    const x = this.q(col.name);
    if (col.type === "Timestamp") return x;
    if (col.type === "Date") return `CAST(${x} AS ${this.tsType()})`;
    if (col.type === "String") return this.textTs(x);
    throw new PushdownError(where, `"${col.name}" is a ${col.type} column: convert it to a date or timestamp first (Cast, or Unix time for seconds)`);
  }

  /** ISO 8601 text as a UTC timestamp: an offset in the text is applied, text without one is UTC. */
  private textTs(x: string): string {
    if (this.d === "databricks") return `TRY_CAST(${x} AS TIMESTAMP)`;
    if (this.d === "duckdb") return `timezone('UTC', TRY_CAST(${x} AS TIMESTAMPTZ))`;
    // Snowflake reads text without an offset in the session's time zone: only text with one goes through _TZ
    return `CASE WHEN REGEXP_LIKE(${x}, '.*[0-9]{2}:[0-9]{2}.*([+-][0-9]{2}(:?[0-9]{2})?|Z)') THEN CAST(CONVERT_TIMEZONE('UTC', TRY_TO_TIMESTAMP_TZ(${x})) AS TIMESTAMP_NTZ) ELSE TRY_TO_TIMESTAMP_NTZ(${x}) END`;
  }

  private zoneLiteral(zone: string, where: string): string {
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) throw new PushdownError(where, `unknown time zone "${zone}"`);
    return literal(this.d, zone, "String", where);
  }

  /** The wall clock in `zone` of a UTC timestamp (FROM_UTC_TIMESTAMP). */
  private wall(x: string, zone: string, where: string): string {
    if (!zone || zone === "UTC") return x;
    const z = this.zoneLiteral(zone, where);
    return this.d === "databricks" ? `FROM_UTC_TIMESTAMP(${x}, ${z})` : this.d === "snowflake" ? `CONVERT_TIMEZONE('UTC', ${z}, ${x})` : `timezone(${z}, timezone('UTC', ${x}))`;
  }

  /** The UTC instant of a wall-clock time in `zone` (TO_UTC_TIMESTAMP). */
  private unwall(x: string, zone: string, where: string): string {
    if (!zone || zone === "UTC") return x;
    const z = this.zoneLiteral(zone, where);
    return this.d === "databricks" ? `TO_UTC_TIMESTAMP(${x}, ${z})` : this.d === "snowflake" ? `CONVERT_TIMEZONE(${z}, 'UTC', ${x})` : `timezone('UTC', timezone(${z}, ${x}))`;
  }

  /** Milliseconds since 1970-01-01 UTC of a timestamp. */
  private epochMs(x: string): string {
    return this.d === "databricks" ? `UNIX_MILLIS(${x})` : this.d === "snowflake" ? `DATE_PART(EPOCH_MILLISECOND, ${x})` : `epoch_ms(${x})`;
  }

  /** The timestamp of a whole number of milliseconds since 1970-01-01 UTC. */
  private fromEpochMs(ms: string): string {
    return this.d === "databricks" ? `TIMESTAMP_MILLIS(${ms})` : this.d === "snowflake" ? `TO_TIMESTAMP_NTZ(${ms}, 3)` : `epoch_ms(CAST(${ms} AS BIGINT))`;
  }

  /** a ÷ b truncated toward zero, as a long. */
  private truncDiv(a: string, b: string): string {
    return this.d === "databricks" ? `((${a}) DIV ${b})` : this.d === "snowflake" ? `CAST(TRUNC((${a}) / ${b}) AS ${this.longType()})` : `CAST(trunc((${a}) / ${b}) AS BIGINT)`;
  }

  /** x plus a whole number of units (months keep the day, clamped to the month's end). */
  private addUnit(x: string, n: string, unit: string): string {
    const u = unit.toUpperCase();
    if (this.d === "databricks") return `TIMESTAMPADD(${u}, ${n}, ${x})`;
    if (this.d === "snowflake") return `DATEADD(${u}, ${n}, ${x})`;
    const one = u === "QUARTER" ? "3 MONTH" : u === "WEEK" ? "7 DAY" : `1 ${u}`;
    return `(${x} + CAST(${n} AS BIGINT) * INTERVAL '${one}')`;
  }

  /** The current instant as a UTC timestamp. */
  private nowTs(): string {
    return this.d === "databricks" ? "CURRENT_TIMESTAMP()" : this.d === "snowflake" ? "SYSDATE()" : "timezone('UTC', now())";
  }

  private monthName(w: string): string {
    if (this.d === "databricks") return `DATE_FORMAT(${w}, 'MMMM')`;
    if (this.d === "duckdb") return `monthname(${w})`;
    return `CASE MONTH(${w}) ${MONTHS_FULL.map((m, i) => `WHEN ${i + 1} THEN '${m}'`).join(" ")} END`;
  }

  private isoWeekday(w: string): string {
    return this.d === "databricks" ? `((DAYOFWEEK(${w}) + 5) % 7 + 1)` : this.d === "snowflake" ? `DAYOFWEEKISO(${w})` : `isodow(${w})`;
  }

  private dayName(w: string): string {
    if (this.d === "databricks") return `DATE_FORMAT(${w}, 'EEEE')`;
    if (this.d === "duckdb") return `dayname(${w})`;
    return `CASE DAYOFWEEKISO(${w}) ${DAYS_ISO.map((m, i) => `WHEN ${i + 1} THEN '${m}'`).join(" ")} END`;
  }

  /** A warehouse format code for a field, or null when it has none (written with an expression instead). */
  private fmtCode(f: Field, n: number): string | null {
    const d = this.d;
    if (d === "databricks") return JAVA_LETTER[f](n);
    const two = n === 2;
    if (d === "duckdb") {
      const codes: Partial<Record<Field, string>> = {
        year4: "%Y", year2: "%y", monthFull: "%B", monthAbbr: "%b", month: two ? "%m" : "%-m", day: two ? "%d" : "%-d",
        dowAbbr: "%a", dowFull: "%A", hour24: two ? "%H" : "%-H", hour12: two ? "%I" : "%-I", minute: two ? "%M" : "%-M",
        second: two ? "%S" : "%-S", ampm: "%p",
      };
      if (f === "doy") return n === 3 ? "%j" : n === 1 ? "%-j" : null;
      if (f === "fraction") return n === 3 ? "%g" : null;
      return codes[f] ?? null;
    }
    const codes: Partial<Record<Field, string>> = { year4: "YYYY", year2: "YY", month: "MM", day: "DD", hour24: "HH24", hour12: "HH12", minute: "MI", second: "SS" };
    if (f === "fraction") return `FF${n}`;
    // Snowflake has no unpadded numbers and no full weekday names: those are written with expressions
    return two || f === "year4" || f === "year2" ? (codes[f] ?? null) : null;
  }

  private padNum(v: string, n: number): string {
    const t = asText(this.d, v);
    return n <= 1 ? t : `LPAD(${t}, CAST(GREATEST(LENGTH(${t}), ${n}) AS ${this.intType()}), '0')`;
  }

  /** A field of the wall-clock timestamp `w` as text, for fields with no format code. */
  private fmtExpr(w: string, f: Field, n: number, where: string): string {
    switch (f) {
      case "month":
        return this.padNum(`MONTH(${w})`, n);
      case "day":
        return this.padNum(`DAY(${w})`, n);
      case "doy":
        return this.padNum(`DAYOFYEAR(${w})`, n);
      case "hour24":
        return this.padNum(`HOUR(${w})`, n);
      case "hour12":
        return this.padNum(`((HOUR(${w}) + 11) % 12 + 1)`, n);
      case "minute":
        return this.padNum(`MINUTE(${w})`, n);
      case "second":
        return this.padNum(`SECOND(${w})`, n);
      case "fraction":
        return `SUBSTR(strftime(${w}, '%g') || '000000', 1, ${n})`;
      case "monthFull":
        return this.monthName(w);
      case "monthAbbr":
        return `MONTHNAME(${w})`;
      case "dowAbbr":
        return `DAYNAME(${w})`;
      case "dowFull":
        return this.dayName(w);
      case "ampm":
        return `CASE WHEN HOUR(${w}) < 12 THEN 'AM' ELSE 'PM' END`;
      default:
        throw new PushdownError(where, `the ${f} field cannot be written here`);
    }
  }

  /** Format text of literal text, or null when it cannot be part of a format string. */
  private fmtLiteral(s: string): string | null {
    if (this.d === "databricks") return javaLiteral(s);
    if (this.d === "duckdb") return s.replace(/%/g, "%%");
    if (/^[-/:,.; ]*$/.test(s)) return s;
    return s.includes('"') ? null : `"${s}"`;
  }

  /** The wall-clock timestamp `w` as text with a Java pattern (DATE_FORMAT / TO_CHAR / strftime). */
  private formatTs(w: string, pattern: string, zoned: boolean, where: string): string {
    // runs of format text (raw: the literal text they write when they hold no field) and expressions
    type Piece = { fmt: string; raw: string; codes: boolean } | { sql: string };
    const pieces: Piece[] = [];
    let fields = 0;
    let plain = "";
    const addFmt = (s: string, raw: string | null) => {
      let last = pieces[pieces.length - 1];
      if (!last || !("fmt" in last)) pieces.push((last = { fmt: "", raw: "", codes: false }));
      last.fmt += s;
      if (raw === null) last.codes = true;
      else last.raw += raw;
    };
    for (const t of tokenizePattern(pattern, where)) {
      if ("lit" in t) {
        plain += t.lit;
        const f = this.fmtLiteral(t.lit);
        if (f === null) pieces.push({ sql: literal(this.d, t.lit, "String", where) });
        else addFmt(f, t.lit);
        continue;
      }
      const { f, n } = fieldOf(t, pattern, where);
      if (f === "offset") {
        // no time zone: the offset is +00:00 (X writes Z)
        if (zoned) throw new PushdownError(where, "offset letters (X, Z, x) with a time zone cannot be pushed down");
        const off = t.ch === "X" ? "Z" : t.n >= 3 ? "+00:00" : t.ch === "Z" || t.n === 2 ? "+0000" : "+00";
        plain += off;
        const lit = this.fmtLiteral(off);
        if (lit === null) pieces.push({ sql: literal(this.d, off, "String", where) });
        else addFmt(lit, off);
        continue;
      }
      fields++;
      const code = this.fmtCode(f, n);
      if (code !== null) addFmt(code, null);
      else pieces.push({ sql: this.fmtExpr(w, f, n, where) });
    }
    const call = (fmt: string) => {
      const pat = literal(this.d, fmt, "String", where);
      return this.d === "databricks" ? `DATE_FORMAT(${w}, ${pat})` : this.d === "snowflake" ? `TO_CHAR(${w}, ${pat})` : `strftime(${w}, ${pat})`;
    };
    // a pattern of literal text only is still null for a null date
    if (!fields) return `CASE WHEN ${w} IS NULL THEN NULL ELSE ${literal(this.d, plain, "String", where)} END`;
    const parts = pieces.map((x) => ("fmt" in x ? (x.codes ? call(x.fmt) : literal(this.d, x.raw, "String", where)) : x.sql));
    return parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
  }

  /**
   * Text `x` read with a Java pattern: a UTC timestamp (text without an offset is wall-clock time in `zone`), or for
   * `to` Date the day as written. Null when it does not match.
   */
  private parseText(x: string, pattern: string, to: "Date" | "Timestamp", zone: string, where: string): string {
    const d = this.d;
    let fmt = "";
    let offset = false;
    let zulu = "";
    for (const t of tokenizePattern(pattern, where)) {
      if ("lit" in t) {
        const f = d === "databricks" ? javaLiteral(t.lit) : d === "duckdb" ? t.lit.replace(/%/g, "%%") : /^[-/:,.; ]*$/.test(t.lit) ? t.lit : t.lit.includes('"') ? null : `"${t.lit}"`;
        if (f === null) throw new PushdownError(where, `the text ${JSON.stringify(t.lit)} in "${pattern}" cannot be read in Snowflake`);
        fmt += f;
        continue;
      }
      const { f, n } = fieldOf(t, pattern, where);
      if (f === "offset") {
        offset = true;
        zulu = t.ch === "X" && n === 1 ? "+00" : n >= 3 ? "+00:00" : "+0000";
      }
      if (d === "databricks") {
        fmt += f === "offset" ? (t.ch === "X" ? "X".repeat(Math.min(n, 3)) : n >= 3 ? "XXX" : "XX") : JAVA_LETTER[f](n);
        continue;
      }
      const codes: Partial<Record<Field, string>> =
        d === "duckdb"
          ? {
              year4: "%Y", year2: "%y", monthFull: "%B", monthAbbr: "%b", month: "%m", day: "%d", doy: "%j", dowAbbr: "%a", dowFull: "%A",
              hour24: "%H", hour12: "%I", minute: "%M", second: "%S", ampm: "%p", offset: "%z",
              fraction: n === 3 ? "%g" : n === 6 ? "%f" : n === 9 ? "%n" : undefined,
            }
          : {
              year4: "YYYY", year2: "YY", monthFull: "MMMM", monthAbbr: "MON", month: "MM", day: "DD", dowAbbr: "DY",
              hour24: "HH24", hour12: "HH12", minute: "MI", second: "SS", ampm: "AM", fraction: "FF",
              offset: t.ch === "X" && n === 1 ? "TZH" : n >= 3 ? "TZH:TZM" : "TZHTZM",
            };
      const code = codes[f];
      if (!code) throw new PushdownError(where, `"${t.ch.repeat(n)}" in "${pattern}" cannot be read in ${d === "snowflake" ? "Snowflake" : "this warehouse"}`);
      fmt += code;
    }
    const pat = literal(d, fmt, "String", where);
    // "Z" for UTC, which strptime's %z and Snowflake's TZH:TZM do not read
    if (offset && d !== "databricks") x = `REGEXP_REPLACE(${x}, 'Z$', '${zulu}')`;
    let ts: string;
    if (d === "databricks") ts = `TRY_TO_TIMESTAMP(${x}, ${pat})`;
    else if (d === "snowflake") ts = offset ? (to === "Date" ? `TRY_TO_TIMESTAMP_TZ(${x}, ${pat})` : `CAST(CONVERT_TIMEZONE('UTC', TRY_TO_TIMESTAMP_TZ(${x}, ${pat})) AS TIMESTAMP_NTZ)`) : `TRY_TO_TIMESTAMP_NTZ(${x}, ${pat})`;
    else ts = offset ? `timezone('UTC', try_strptime(${x}, ${pat}))` : `try_strptime(${x}, ${pat})`;
    if (to === "Date") return d === "databricks" ? `TO_DATE(${ts})` : `CAST(${ts} AS DATE)`;
    return offset ? ts : this.unwall(ts, zone, where);
  }

  /** A whole number: a column of a whole-number type, or a whole-number literal. */
  private wholeNumber(rel: Rel, text: string, what: string, where: string): string {
    const t = text.trim();
    const col = rel.columns?.find((c) => c.name === t);
    if (col) {
      if (!["Byte", "Short", "Integer", "Long"].includes(col.type)) throw new PushdownError(where, `${what} "${col.name}" is a ${col.type} column: only whole-number columns can be pushed down`);
      return this.q(col.name);
    }
    if (!rel.columns && t && !/^[+-]?\d+$/.test(t)) return this.q(t);
    if (!/^[+-]?\d+$/.test(t)) throw new PushdownError(where, `${what} must be a whole number or a column name`);
    return String(Number(t));
  }

  /** A number for Make date: a column (text and numbers read as numbers) or a literal. */
  private numberOf(rel: Rel, text: string, what: string, where: string): string {
    const t = text.trim();
    const col = rel.columns?.find((c) => c.name === t) ?? (!rel.columns && t && !Number.isFinite(Number(t)) ? { name: t, type: "String" as ColType } : null);
    if (col) return ["Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal"].includes(col.type) ? `CAST(${this.q(col.name)} AS DOUBLE)` : `TRY_CAST(${asText(this.d, this.q(col.name))} AS DOUBLE)`;
    if (!t || !Number.isFinite(Number(t))) throw new PushdownError(where, `${what} must be a number or a column name`);
    return `CAST(${Number(t)} AS DOUBLE)`;
  }

  /**
   * A Formula step's expression as DuckDB SQL (a DOUBLE), read with compileFormula's grammar and rules: ^ (right),
   * unary −, * / % and implicit ×, + −; a null input or an undefined result (÷ 0, ln of 0) is null.
   */
  private formula(src: string, rel: Rel, constants: Record<string, number>, where: string): string {
    if (!src.trim()) throw new PushdownError(where, "enter a formula");
    let tokens: FormulaToken[];
    try {
      tokens = tokenize(src);
    } catch (e) {
      throw new PushdownError(where, (e as Error).message);
    }
    let at = 0;
    const peek = () => tokens[at];
    const next = () => tokens[at++];
    const fail = (t: FormulaToken, what = `unexpected "${t.text}"`): never => {
      throw new PushdownError(where, `${what} at position ${t.pos + 1}`);
    };
    const expect = (text: string) => {
      const t = next();
      if (t.kind !== "op" || t.text !== text) fail(t, `expected "${text}" but found "${t.text}"`);
    };
    const num = (v: number) => `CAST(${v} AS DOUBLE)`;
    const isColumn = (name: string) => !!rel.columns?.some((c) => c.name === name);
    // a column as a number: booleans are 0 / 1, text is read as a number (else null), dates are not numbers
    const column = (name: string): string | null => {
      if (!rel.columns) return `TRY_CAST(${this.q(name)} AS DOUBLE)`;
      const c = rel.columns.find((x) => x.name === name) ?? rel.columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!c) return null;
      const x = this.q(c.name);
      if (["Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal", "Boolean"].includes(c.type)) return `CAST(${x} AS DOUBLE)`;
      return c.type === "String" ? `TRY_CAST(TRIM(${x}) AS DOUBLE)` : "CAST(NULL AS DOUBLE)";
    };
    const variable = (t: FormulaToken): string => {
      if (t.text in constants) return num(constants[t.text]);
      const c = column(t.text);
      if (c) return c;
      const lower = t.text.toLowerCase();
      if (lower in FORMULA_CONSTANTS) return num(FORMULA_CONSTANTS[lower]);
      return fail(t, `unknown name "${t.text}" — add it under Constants, or wrap a column name with spaces in \`backticks\``);
    };

    const primary = (): string => {
      const t = next();
      if (t.kind === "num") return num(t.value!);
      if (t.kind === "op" && t.text === "(") {
        const inner = add();
        expect(")");
        return inner;
      }
      if (t.kind === "name") {
        const shadowed = t.text in constants || isColumn(t.text);
        const fn = FORMULA_SQL[t.text.toLowerCase()];
        if (!shadowed && peek().text === "(") {
          if (!fn) fail(t, `${t.text}() cannot be computed by the DuckDB local engine`);
          next();
          const args: string[] = [];
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
          return fn.sql(args);
        }
        // "ln x" / "sqrt 2x" without parentheses: a one-argument function applies to the next power term
        const after = peek();
        if (fn && fn.args[0] === 1 && !shadowed && (after.kind === "num" || after.kind === "name")) return fn.sql([power()]);
        return variable(t);
      }
      return fail(t);
    };
    const power = (): string => {
      const base = primary();
      if (peek().text !== "^") return base;
      next();
      return `POW(${base}, ${unary()})`;
    };
    const unary = (): string => {
      const t = peek();
      if (t.kind === "op" && (t.text === "-" || t.text === "+")) {
        next();
        const inner = unary();
        return t.text === "-" ? `(-${inner})` : inner;
      }
      return power();
    };
    const mul = (): string => {
      let left = unary();
      for (;;) {
        const t = peek();
        if (t.kind === "op" && (t.text === "*" || t.text === "/" || t.text === "%")) {
          next();
          const right = unary();
          left = t.text === "*" ? `(${left} * ${right})` : `(CASE WHEN ${right} = 0 THEN NULL ELSE ${left} ${t.text} ${right} END)`;
        } else if (t.kind === "num" || t.kind === "name" || (t.kind === "op" && t.text === "(")) {
          // implicit multiplication: 2x, 3(x + 1), A x
          left = `(${left} * ${unary()})`;
        } else return left;
      }
    };
    const add = (): string => {
      let left = mul();
      for (;;) {
        const t = peek();
        if (t.kind !== "op" || (t.text !== "+" && t.text !== "-")) return left;
        next();
        left = `(${left} ${t.text} ${mul()})`;
      }
    };
    const result = add();
    if (peek().kind !== "end") fail(peek());
    return result;
  }

  // ---- steps

  step(rel: Rel, s: Step, where: string): Rel {
    const d = this.d;
    const p = s.params;
    const q = this.q;
    switch (s.kind) {
      case "select": {
        const cols = [...new Set(list(p, "columns"))].map((c) => this.need(rel, c, where));
        if (!cols.length) throw new PushdownError(where, "choose at least one column");
        return this.add(`SELECT ${cols.map((c) => q(c.name)).join(", ")}\nFROM ${rel.name}`, rel.columns ? cols : null, undefined, true);
      }
      case "drop": {
        const drop = new Set(list(p, "columns").map((c) => this.need(rel, c, where).name));
        const cols = this.known(rel, where).filter((c) => !drop.has(c.name));
        return this.add(`SELECT ${cols.map((c) => q(c.name)).join(", ")}\nFROM ${rel.name}`, cols, undefined, true);
      }
      case "rename": {
        const col = this.need(rel, str(p, "column"), where);
        const to = str(p, "to").trim();
        if (!to) throw new PushdownError(where, "enter the new name");
        const cols = this.known(rel, where);
        return this.add(`SELECT ${cols.map((c) => (c.name === col.name ? `${q(c.name)} AS ${q(to)}` : q(c.name))).join(", ")}\nFROM ${rel.name}`,
          cols.map((c) => (c.name === col.name ? { ...c, name: to } : c)), undefined, true);
      }
      case "filter": {
        const cond = this.group(readFilter(p), rel, where);
        const remove = str(p, "mode") === "Remove rows";
        return this.add(`SELECT *\nFROM ${rel.name}\nWHERE ${remove ? `NOT ${cond}` : cond}`, rel.columns, rel.order);
      }
      case "dedupe": {
        const cols = list(p, "columns").length ? list(p, "columns").map((c) => this.need(rel, c, where).name) : null;
        if (!cols) return this.add(`SELECT DISTINCT *\nFROM ${rel.name}`, rel.columns);
        const all = this.known(rel, where);
        const keys = cols.map(q).join(", ");
        const inner = this.add(`SELECT *, ROW_NUMBER() OVER (PARTITION BY ${keys} ORDER BY ${keys}) AS ${q("__row")}\nFROM ${rel.name}`, null);
        return this.add(`SELECT ${all.map((c) => q(c.name)).join(", ")}\nFROM ${inner.name}\nWHERE ${q("__row")} = 1`, all);
      }
      case "sort": {
        const keys = readSortKeys(p, "sort");
        if (!keys.length) throw new PushdownError(where, "add a column to sort by");
        const order = keys.map((k) => `${q(this.need(rel, k.column, where).name)} ${k.direction === "desc" ? "DESC" : "ASC"}${k.nulls ? ` NULLS ${k.nulls === "first" ? "FIRST" : "LAST"}` : ""}`).join(", ");
        // a CTE's ORDER BY does not order what reads it: kept for a Limit step right after it
        return { ...rel, order };
      }
      case "limit": {
        const n = Math.trunc(Number(str(p, "n")));
        const offset = Math.trunc(Number(str(p, "offset") || 0));
        if (!str(p, "n") || !(n >= 0) || !(offset >= 0)) throw new PushdownError(where, "the number of rows must be a whole number");
        return this.add(`SELECT *\nFROM ${rel.name}${rel.order ? `\nORDER BY ${rel.order}` : ""}\nLIMIT ${n}${offset ? ` OFFSET ${offset}` : ""}`, rel.columns);
      }
      case "aggregate": {
        const groupBy = [...new Set(list(p, "groupBy"))].map((c) => this.need(rel, c, where));
        const aggs = readAggs(p);
        if (!aggs.length) throw new PushdownError(where, "add an aggregation");
        const grouping = str(p, "grouping") || "Group by";
        if (grouping === "Grouping sets" || str(p, "groupingId") === "true") throw new PushdownError(where, "grouping sets and grouping_id cannot be pushed down: use Group by, Rollup or Cube");
        const parts = aggs.map((a) => ({ ...this.agg(a, rel, where), name: aggOutput(a) }));
        const keys = groupBy.map((c) => q(c.name)).join(", ");
        const by = !groupBy.length ? "" : grouping === "Rollup" ? `\nGROUP BY ROLLUP (${keys})` : grouping === "Cube" ? `\nGROUP BY CUBE (${keys})` : `\nGROUP BY ${keys}`;
        return this.add(`SELECT ${[...groupBy.map((c) => q(c.name)), ...parts.map((x) => `${x.expr} AS ${q(x.name)}`)].join(", ")}\nFROM ${rel.name}${by}`,
          [...groupBy, ...parts.map((x) => ({ name: x.name, type: x.type }))]);
      }
      case "cast": {
        const col = this.need(rel, str(p, "column"), where);
        const to = (str(p, "type") || "String") as ColType;
        const decimal = to === "Decimal" ? { precision: Math.trunc(Number(str(p, "precision") || 10)), scale: Math.trunc(Number(str(p, "scale") || 0)) } : undefined;
        const formats = list(p, "formats").filter((f) => f.trim());
        let expr: string;
        if ((to === "Date" || to === "Timestamp") && formats.length && col.type === "String") {
          // the first format that reads the text, its letters translated to the warehouse's (Spark reads Java's)
          const zone = to === "Timestamp" ? str(p, "timezone") : "";
          const tries = formats.map((f) => this.parseText(q(col.name), f, to, zone, where));
          expr = tries.length === 1 ? tries[0] : `COALESCE(${tries.join(", ")})`;
        } else {
          const target = sqlType(d, to, where, decimal);
          // values that cannot be converted become null (Snowflake's TRY_CAST takes text)
          expr = d === "snowflake" && to !== "String" ? `TRY_CAST(${asText(d, q(col.name))} AS ${target})` : `TRY_CAST(${q(col.name)} AS ${target})`;
        }
        return this.withColumn(rel, outputName(p), expr, to, where);
      }
      case "constant": {
        const name = str(p, "output").trim();
        if (!name) throw new PushdownError(where, "name the new column");
        const type = ((str(p, "type") || "String") as ColType);
        const value = str(p, "value");
        return this.withColumn(rel, name, value === "" && type !== "String" ? `CAST(NULL AS ${sqlType(d, type, where)})` : literal(d, value, type, where), type, where);
      }
      case "uppercase":
      case "lowercase":
      case "case": {
        const col = this.need(rel, str(p, "column"), where);
        const mode = s.kind === "uppercase" ? "Upper" : s.kind === "lowercase" ? "Lower" : str(p, "case") || "Upper";
        if (mode === "Title") throw new PushdownError(where, "title case cannot be pushed down");
        return this.withColumn(rel, outputName(p), `${mode === "Upper" ? "UPPER" : "LOWER"}(${asText(d, q(col.name))})`, "String", where);
      }
      case "trim": {
        const col = this.need(rel, str(p, "column"), where);
        const side = str(p, "side") || "Both";
        const chars = str(p, "chars");
        const x = asText(d, q(col.name));
        let expr: string;
        if (!chars) expr = side === "Left" ? `LTRIM(${x})` : side === "Right" ? `RTRIM(${x})` : `TRIM(${x})`;
        else if (d === "databricks") expr = `TRIM(${side === "Left" ? "LEADING" : side === "Right" ? "TRAILING" : "BOTH"} ${literal(d, chars, "String", where)} FROM ${x})`;
        else expr = `${side === "Left" ? "LTRIM" : side === "Right" ? "RTRIM" : "TRIM"}(${x}, ${literal(d, chars, "String", where)})`;
        return this.withColumn(rel, outputName(p), expr, "String", where);
      }
      case "coalesce": {
        const exprs = list(p, "columns");
        if (!exprs.length || exprs.some((e) => !e)) throw new PushdownError(where, "complete every expression");
        const parts = exprs.map((e) => (isLiteral(e) ? { sql: literal(d, literalText(e), "String", where), type: "String" as ColType } : { sql: q(this.need(rel, e, where).name), type: this.need(rel, e, where).type }));
        const types = new Set(parts.map((x) => x.type));
        const type: ColType = types.size === 1 ? parts[0].type : "String";
        const empty = str(p, "emptyAsNull") === "true";
        const args = parts.map((x) => {
          const v = type === "String" && x.type !== "String" ? asText(d, x.sql) : x.sql;
          return empty && type === "String" ? `NULLIF(${v}, '')` : v;
        });
        return this.withColumn(rel, outputName(p, "coalesce"), `COALESCE(${args.join(", ")})`, type, where);
      }
      case "concat": {
        const exprs = list(p, "columns");
        if (!exprs.length || exprs.some((e) => !e)) throw new PushdownError(where, "complete every expression");
        const parts = exprs.map((e) => (isLiteral(e) ? literal(d, literalText(e), "String", where) : asText(d, q(this.need(rel, e, where).name))));
        const sep = literal(d, str(p, "separator"), "String", where);
        // CONCAT_WS leaves nulls out, as Pipeline Builder does
        const joined = `CONCAT_WS(${sep}, ${parts.join(", ")})`;
        const expr = str(p, "nullIfAny") === "true" ? `CASE WHEN ${parts.map((x) => `${x} IS NULL`).join(" OR ")} THEN NULL ELSE ${joined} END` : joined;
        return this.withColumn(rel, outputName(p, "concat_strings"), expr, "String", where);
      }
      case "math": {
        const left = this.need(rel, str(p, "column"), where);
        const right = str(p, "right").trim();
        const rc = rel.columns?.find((c) => c.name === right);
        if (!rc && !Number.isFinite(Number(right))) throw new PushdownError(where, "Right must be a column name or a number");
        const a = `CAST(${q(left.name)} AS DOUBLE)`;
        const b = rc ? `CAST(${q(rc.name)} AS DOUBLE)` : `CAST(${Number(right)} AS DOUBLE)`;
        const op = str(p, "op") || "+";
        const expr = op === "+" ? `${a} + ${b}` : op === "−" ? `${a} - ${b}` : op === "×" ? `${a} * ${b}` : `CASE WHEN ${b} = 0 THEN NULL ELSE ${a} / ${b} END`;
        return this.withColumn(rel, outputName(p), `(${expr})`, "Double", where);
      }
      case "fill": {
        const col = this.need(rel, str(p, "column"), where);
        const value = literal(d, str(p, "value"), col.type, where);
        const test = col.type === "String" ? `(${q(col.name)} IS NULL OR ${q(col.name)} = '')` : `${q(col.name)} IS NULL`;
        return this.withColumn(rel, col.name, `CASE WHEN ${test} THEN ${value} ELSE ${q(col.name)} END`, col.type, where);
      }
      case "replace": {
        const col = this.need(rel, str(p, "column"), where);
        const find = str(p, "find");
        if (!find) throw new PushdownError(where, "enter the text to find");
        const x = asText(d, q(col.name));
        const withText = str(p, "with");
        let expr: string;
        if (str(p, "mode") === "Regex") {
          // replacement groups: $1 in Spark, \\1 in Snowflake and DuckDB
          const rep = d === "databricks" ? withText : withText.replace(/\$(\d)/g, "\\$1");
          expr = d === "duckdb" ? `regexp_replace(${x}, ${literal(d, find, "String", where)}, ${literal(d, rep, "String", where)}, 'g')` : `REGEXP_REPLACE(${x}, ${literal(d, find, "String", where)}, ${literal(d, rep, "String", where)})`;
        } else expr = `REPLACE(${x}, ${literal(d, find, "String", where)}, ${literal(d, withText, "String", where)})`;
        return this.withColumn(rel, outputName(p), expr, "String", where);
      }
      case "nullif": {
        const col = this.need(rel, str(p, "column"), where);
        return this.withColumn(rel, outputName(p), `NULLIF(${q(col.name)}, ${literal(d, str(p, "value"), col.type, where)})`, col.type, where);
      }
      case "greatest": {
        const cols = list(p, "columns").map((c) => this.need(rel, c, where));
        if (cols.length < 2) throw new PushdownError(where, "choose at least two columns");
        const types = new Set(cols.map((c) => c.type));
        const numeric = [...types].every((t) => ["Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal"].includes(t));
        const type: ColType = types.size === 1 ? cols[0].type : numeric ? "Double" : "String";
        const args = cols.map((c) => {
          const v = types.size === 1 ? q(c.name) : `CAST(${q(c.name)} AS ${sqlType(d, type, where)})`;
          return type === "String" ? `NULLIF(${v}, '')` : v;
        });
        const least = str(p, "fn") === "Least";
        // nulls are skipped (Snowflake's GREATEST / LEAST return null when any argument is null)
        const fn = d === "snowflake" ? (least ? "LEAST_IGNORE_NULLS" : "GREATEST_IGNORE_NULLS") : least ? "LEAST" : "GREATEST";
        return this.withColumn(rel, outputName(p, least ? "least" : "greatest"), `${fn}(${args.join(", ")})`, type, where);
      }
      case "substring": {
        const col = this.need(rel, str(p, "column"), where);
        const start = Math.trunc(Number(str(p, "start") || 1));
        const lenText = str(p, "length");
        if (!Number.isFinite(start)) throw new PushdownError(where, "Start must be a whole number");
        const len = lenText === "" ? null : Math.trunc(Number(lenText));
        if (len !== null && !(len >= 0)) throw new PushdownError(where, "Length must be a whole number of at least 0");
        const x = asText(d, q(col.name));
        // a negative start counts from the end (past the start of the text: from its first character)
        const from = start > 0 ? `${start}` : start < 0 ? `GREATEST(LENGTH(${x}) + ${start + 1}, 1)` : "1";
        return this.withColumn(rel, outputName(p), len === null ? `SUBSTR(${x}, ${from})` : `SUBSTR(${x}, ${from}, ${len})`, "String", where);
      }
      case "length": {
        const col = this.need(rel, str(p, "column"), where);
        return this.withColumn(rel, outputName(p, `${col.name}_length`), `CAST(LENGTH(${asText(d, q(col.name))}) AS ${sqlType(d, "Integer", where)})`, "Integer", where);
      }
      case "pad": {
        const col = this.need(rel, str(p, "column"), where);
        const len = Math.trunc(Number(str(p, "length")));
        if (!str(p, "length") || !(len >= 0)) throw new PushdownError(where, "Length must be a whole number");
        const fn = str(p, "side") === "Right" ? "RPAD" : "LPAD";
        return this.withColumn(rel, outputName(p), `${fn}(${asText(d, q(col.name))}, ${len}, ${literal(d, str(p, "fill") || " ", "String", where)})`, "String", where);
      }
      case "position": {
        const col = this.need(rel, str(p, "column"), where);
        const search = str(p, "search");
        if (!search) throw new PushdownError(where, "enter the text to find");
        const x = asText(d, q(col.name));
        const s2 = literal(d, search, "String", where);
        const expr = d === "snowflake" ? `POSITION(${s2}, ${x})` : `INSTR(${x}, ${s2})`;
        return this.withColumn(rel, outputName(p, `${col.name}_position`), `CAST(${expr} AS ${sqlType(d, "Integer", where)})`, "Integer", where);
      }
      case "regex_extract": {
        const col = this.need(rel, str(p, "column"), where);
        const pattern = str(p, "pattern");
        if (!pattern) throw new PushdownError(where, "enter a pattern");
        let groups: number;
        try {
          groups = new RegExp(`${pattern}|`).exec("")!.length - 1;
        } catch {
          throw new PushdownError(where, `invalid regular expression "${pattern}"`);
        }
        const group = str(p, "group") === "" ? (groups ? 1 : 0) : Math.trunc(Number(str(p, "group")));
        if (!(group >= 0 && group <= groups)) throw new PushdownError(where, `the pattern has ${groups} group${groups === 1 ? "" : "s"}`);
        const x = asText(d, q(col.name));
        const pat = literal(d, pattern, "String", where);
        // no match is null (Spark's and DuckDB's REGEXP_EXTRACT give an empty string)
        const expr =
          d === "snowflake"
            ? group ? `REGEXP_SUBSTR(${x}, ${pat}, 1, 1, 'ce', ${group})` : `REGEXP_SUBSTR(${x}, ${pat})`
            : d === "databricks"
              ? `CASE WHEN ${x} RLIKE ${pat} THEN REGEXP_EXTRACT(${x}, ${pat}, ${group}) END`
              : `CASE WHEN regexp_matches(${x}, ${pat}) THEN regexp_extract(${x}, ${pat}, ${group}) END`;
        return this.withColumn(rel, outputName(p), expr, "String", where);
      }
      case "case_when": {
        const spec = readCases(p);
        if (!spec.cases.length) throw new PushdownError(where, "add a case");
        let type: ColType | "Auto" = str(p, "type") && str(p, "type") !== "Auto" ? (str(p, "type") as ColType) : "Auto";
        if (type === "Auto") {
          const types = new Set([...spec.cases.map((b) => b.then), spec.else].filter((o): o is NonNullable<Operand> => !!o).map((o) => (o.kind === "column" ? this.need(rel, o.column, where).type : o.type)));
          type = types.size === 1 ? [...types][0] : "String";
        }
        const to = type as ColType;
        const cast = (o: Operand) => (o ? `TRY_CAST(${d === "snowflake" && to !== "String" ? asText(d, this.operand(o, rel, where)) : this.operand(o, rel, where)} AS ${sqlType(d, to, where)})` : "NULL");
        const branches = spec.cases.map((b) => `WHEN ${this.group(b.when, rel, where)} THEN ${cast(b.then)}`);
        return this.withColumn(rel, outputName(p, "case_result"), `CASE ${branches.join(" ")} ELSE ${spec.else ? cast(spec.else) : "NULL"} END`, to, where);
      }
      case "unpivot": {
        const cols = [...new Set(list(p, "columns"))].map((c) => this.need(rel, c, where));
        if (!cols.length) throw new PushdownError(where, "choose the columns to unpivot");
        const nameCol = str(p, "nameColumn").trim() || "name";
        const valueCol = str(p, "valueColumn").trim() || "value";
        const unpivoted = new Set(cols.map((c) => c.name));
        const keep = this.known(rel, where).filter((c) => !unpivoted.has(c.name));
        const types = new Set(cols.map((c) => c.type));
        const type: ColType = types.size === 1 ? cols[0].type : "String";
        const dropNulls = str(p, "dropNulls") === "true";
        // one SELECT per unpivoted column, in column order within each row
        const parts = cols.map((c, i) => {
          const v = type === "String" && c.type !== "String" ? asText(d, q(c.name)) : q(c.name);
          const empty = type === "String" ? `(${v} IS NULL OR ${v} = '')` : `${v} IS NULL`;
          return `SELECT ${[...keep.map((k) => q(k.name)), `${literal(d, c.name, "String", where)} AS ${q(nameCol)}`, `${v} AS ${q(valueCol)}`, `${i} AS ${q("__col")}`].join(", ")}\nFROM ${rel.name}${dropNulls ? `\nWHERE NOT ${empty}` : ""}`;
        });
        const u = this.add(parts.join("\nUNION ALL\n"), null);
        return this.add(`SELECT ${[...keep.map((k) => q(k.name)), q(nameCol), q(valueCol)].join(", ")}\nFROM ${u.name}`, [...keep, { name: nameCol, type: "String" }, { name: valueCol, type }]);
      }
      case "window": {
        const fn = str(p, "fn") || "Row number";
        const col = str(p, "column") ? this.need(rel, str(p, "column"), where) : null;
        const partition = list(p, "partitionBy").map((c) => q(this.need(rel, c, where).name));
        const keys = readSortKeys(p, "orderBy");
        const order = keys.map((k) => `${q(this.need(rel, k.column, where).name)} ${k.direction === "desc" ? "DESC" : "ASC"}${k.nulls ? ` NULLS ${k.nulls === "first" ? "FIRST" : "LAST"}` : ""}`).join(", ");
        const ranking = ["Row number", "Rank", "Dense rank", "Percent rank", "Cumulative distribution", "Ntile"];
        if ((ranking.includes(fn) || fn === "Lag" || fn === "Lead") && !keys.length) throw new PushdownError(where, `${fn} needs an order — add an Order by column`);
        const over = (frame = "") => `OVER (${[partition.length ? `PARTITION BY ${partition.join(", ")}` : "", order ? `ORDER BY ${order}` : "", frame].filter(Boolean).join(" ")})`;
        const needCol = () => {
          if (!col) throw new PushdownError(where, `${fn} needs a column`);
          return q(col.name);
        };
        const n = Math.trunc(Number(str(p, "n") || (fn === "Ntile" ? 4 : 1)));
        let expr: string;
        let type: ColType;
        switch (fn) {
          case "Row number":
          case "Rank":
          case "Dense rank":
            expr = `${{ "Row number": "ROW_NUMBER", Rank: "RANK", "Dense rank": "DENSE_RANK" }[fn]}() ${over()}`;
            type = "Integer";
            break;
          case "Percent rank":
            expr = `PERCENT_RANK() ${over()}`;
            type = "Double";
            break;
          case "Cumulative distribution":
            expr = `CUME_DIST() ${over()}`;
            type = "Double";
            break;
          case "Ntile":
            if (!(n >= 1)) throw new PushdownError(where, "Buckets must be a whole number of at least 1");
            expr = `NTILE(${n}) ${over()}`;
            type = "Integer";
            break;
          case "Lag":
          case "Lead": {
            if (!(n >= 1)) throw new PushdownError(where, "N must be a number of at least 1");
            const fallback = str(p, "default") !== "" ? `, ${literal(d, str(p, "default"), col?.type ?? "String", where)}` : "";
            expr = `${fn.toUpperCase()}(${needCol()}, ${n}${fallback}) ${over()}`;
            type = col!.type;
            break;
          }
          case "First value":
          case "Last value":
          case "Sum":
          case "Mean":
          case "Count":
          case "Min":
          case "Max": {
            const frame = str(p, "frame") || "Whole partition";
            const rows =
              frame === "Whole partition"
                ? "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING"
                : frame === "Running (up to this row)"
                  ? "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"
                  : frame === "Last N rows"
                    ? `ROWS BETWEEN ${Math.max(0, n - 1)} PRECEDING AND CURRENT ROW`
                    : frame === "N rows before and after"
                      ? `ROWS BETWEEN ${Math.max(0, n)} PRECEDING AND ${Math.max(0, n)} FOLLOWING`
                      : null;
            if (!rows) throw new PushdownError(where, "a time range frame cannot be pushed down");
            if ((frame === "Last N rows" && !(n >= 1)) || (frame === "N rows before and after" && !(n >= 0))) throw new PushdownError(where, "N must be a whole number");
            const sqlFn = { "First value": "FIRST_VALUE", "Last value": "LAST_VALUE", Sum: "SUM", Mean: "AVG", Count: "COUNT", Min: "MIN", Max: "MAX" }[fn];
            const arg = fn === "Count" && !col ? "*" : needCol();
            // Spark and DuckDB's FIRST_VALUE / LAST_VALUE keep nulls unless IGNORE NULLS: Pipeline Builder skips them
            const ignore = fn === "First value" || fn === "Last value";
            expr = !ignore
              ? `${sqlFn}(${arg}) ${over(rows)}`
              : d === "databricks"
                ? `${sqlFn}(${arg}, TRUE) ${over(rows)}`
                : d === "duckdb"
                  ? `${sqlFn}(${arg} IGNORE NULLS) ${over(rows)}`
                  : `${sqlFn}(${arg}) IGNORE NULLS ${over(rows)}`;
            type = fn === "Count" ? "Long" : fn === "Mean" ? "Double" : fn === "Sum" ? (col && ["Byte", "Short", "Integer", "Long"].includes(col.type) ? "Long" : "Double") : col!.type;
            // DuckDB sums whole numbers as HUGEINT: a Long, as the column is typed
            if (fn === "Sum" && type === "Long" && d === "duckdb") expr = `CAST(${expr} AS BIGINT)`;
            break;
          }
          default:
            throw new PushdownError(where, `the window function ${fn} cannot be pushed down`);
        }
        return this.withColumn(rel, outputName(p, windowOutput(p)), expr, type, where);
      }
      case "explode": {
        const col = this.need(rel, str(p, "column"), where);
        const sep = str(p, "separator");
        if (!sep) throw new PushdownError(where, "only text split by a separator can be pushed down (JSON arrays are read here)");
        const name = outputName(p);
        const keepEmpty = str(p, "keepEmpty") === "true";
        const withPos = str(p, "position") === "true";
        const cols = this.known(rel, where);
        const others = cols.filter((c) => c.name !== name).map((c) => q(c.name));
        const x = asText(d, q(col.name));
        const posName = `${name}_position`;
        let sql: string;
        if (d === "snowflake") {
          sql = `SELECT ${[...others, `TRIM(f.value::VARCHAR) AS ${q(name)}`, ...(withPos ? [`f.index + 1 AS ${q(posName)}`] : [])].join(", ")}\nFROM ${rel.name}, LATERAL FLATTEN(INPUT => SPLIT(${x}, ${literal(d, sep, "String", where)})${keepEmpty ? ", OUTER => TRUE" : ""}) f${keepEmpty ? "" : `\nWHERE ${x} <> ''`}`;
        } else if (d === "databricks") {
          sql = `SELECT ${[...others, `TRIM(e.v) AS ${q(name)}`, ...(withPos ? [`e.pos + 1 AS ${q(posName)}`] : [])].join(", ")}\nFROM ${rel.name}\nLATERAL VIEW ${keepEmpty ? "OUTER " : ""}POSEXPLODE(CASE WHEN ${x} = '' THEN NULL ELSE SPLIT(${x}, ${literal(d, sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "String", where)}, -1) END) e AS pos, v`;
        } else {
          sql = `SELECT ${[...others, `TRIM(e.v) AS ${q(name)}`, ...(withPos ? [`CAST(e.pos AS INTEGER) AS ${q(posName)}`] : [])].join(", ")}\nFROM ${rel.name}\n${keepEmpty ? "LEFT JOIN" : "JOIN"} LATERAL (SELECT UNNEST(string_split(${x}, ${literal(d, sep, "String", where)})) AS v, generate_subscripts(string_split(${x}, ${literal(d, sep, "String", where)}), 1) AS pos WHERE ${x} <> '') e ON TRUE`;
        }
        const out = [...cols.filter((c) => c.name !== name), { name, type: "String" as ColType }, ...(withPos ? [{ name: posName, type: "Integer" as ColType }] : [])];
        return this.add(sql, out);
      }
      case "hash": {
        const cols = list(p, "columns").map((c) => this.need(rel, c, where));
        if (!cols.length) throw new PushdownError(where, "choose the columns to hash");
        const alg = str(p, "algorithm") || "SHA-256";
        // the columns as text joined with |, nulls as empty text (as Pipeline Builder hashes them)
        const text = cols.length === 1 ? `COALESCE(${asText(d, q(cols[0].name))}, '')` : `CONCAT_WS('|', ${cols.map((c) => `COALESCE(${asText(d, q(c.name))}, '')`).join(", ")})`;
        const fn: Record<string, Record<Dialect, string>> = {
          "SHA-256": { databricks: `SHA2(${text}, 256)`, snowflake: `SHA2(${text}, 256)`, duckdb: `sha256(${text})` },
          "SHA-512": { databricks: `SHA2(${text}, 512)`, snowflake: `SHA2(${text}, 512)`, duckdb: "" },
          "SHA-1": { databricks: `SHA1(${text})`, snowflake: `SHA1(${text})`, duckdb: `sha1(${text})` },
          MD5: { databricks: `MD5(${text})`, snowflake: `MD5(${text})`, duckdb: `md5(${text})` },
        };
        const expr = fn[alg]?.[d];
        if (!expr) throw new PushdownError(where, `${alg} cannot be pushed down${d === "duckdb" ? " here" : ""}`);
        return this.withColumn(rel, outputName(p, "hash"), expr, "String", where);
      }
      case "date_part": {
        const col = this.need(rel, str(p, "column"), where);
        const part = str(p, "part") || "Year";
        const zone = col.type === "Date" ? "" : str(p, "timezone");
        const t = this.ts(col, where);
        const w = col.type === "Date" ? q(col.name) : this.wall(t, zone, where);
        const wt = col.type === "Date" ? t : w;
        const int = (e: string) => `CAST(${e} AS ${this.intType()})`;
        const exprs: Record<string, () => string> = {
          Year: () => int(`YEAR(${w})`),
          Quarter: () => int(`QUARTER(${w})`),
          Month: () => int(`MONTH(${w})`),
          "Week of year": () => int(d === "snowflake" ? `WEEKISO(${w})` : `WEEKOFYEAR(${w})`),
          Day: () => int(`DAY(${w})`),
          "Day of week (1 = Monday)": () => int(this.isoWeekday(w)),
          "Day of year": () => int(`DAYOFYEAR(${w})`),
          Hour: () => int(`HOUR(${wt})`),
          Minute: () => int(`MINUTE(${wt})`),
          Second: () => int(`SECOND(${wt})`),
          "Epoch seconds": () => `CAST(FLOOR(${this.epochMs(t)} / 1000) AS ${this.longType()})`,
          "Month name": () => this.monthName(w),
          "Day name": () => this.dayName(w),
        };
        if (!exprs[part]) throw new PushdownError(where, `the part "${part}" cannot be pushed down`);
        const type: ColType = part === "Month name" || part === "Day name" ? "String" : part === "Epoch seconds" ? "Long" : "Integer";
        return this.withColumn(rel, outputName(p, part.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").replace(/_1_monday$/, "")), exprs[part](), type, where);
      }
      case "date_trunc": {
        const col = this.need(rel, str(p, "column"), where);
        const unit = str(p, "unit") || "Year";
        if (!["Year", "Quarter", "Month", "Week", "Day", "Hour", "Minute"].includes(unit)) throw new PushdownError(where, `truncating to a ${unit} cannot be pushed down`);
        const end = str(p, "edge") === "End";
        const asDate = col.type === "Date" && !["Hour", "Minute"].includes(unit);
        let expr: string;
        if (asDate) {
          const start = `DATE_TRUNC('${unit.toUpperCase()}', ${q(col.name)})`;
          expr = `CAST(${end ? this.addUnit(this.addUnit(start, "1", unit), "-1", "Day") : start} AS DATE)`;
        } else {
          const zone = col.type === "Date" ? "" : str(p, "timezone");
          const start = `DATE_TRUNC('${unit.toUpperCase()}', ${this.wall(this.ts(col, where), zone, where)})`;
          expr = this.unwall(end ? this.addUnit(this.addUnit(start, "1", unit), "-1", "Millisecond") : start, zone, where);
          if (d === "duckdb" || d === "snowflake") expr = `CAST(${expr} AS ${this.tsType()})`;
        }
        return this.withColumn(rel, outputName(p), expr, asDate ? "Date" : "Timestamp", where);
      }
      case "date_add": {
        const col = this.need(rel, str(p, "column"), where);
        const unit = str(p, "unit") || "Days";
        const units: Record<string, string> = { Years: "Year", Quarters: "Quarter", Months: "Month", Weeks: "Week", Days: "Day", Hours: "Hour", Minutes: "Minute", Seconds: "Second" };
        if (!units[unit]) throw new PushdownError(where, `adding ${unit} cannot be pushed down`);
        const n = this.wholeNumber(rel, str(p, "amount"), "Amount", where);
        const asDate = col.type === "Date" && !["Hours", "Minutes", "Seconds"].includes(unit);
        const added = this.addUnit(asDate ? q(col.name) : this.ts(col, where), n, units[unit]);
        return this.withColumn(rel, outputName(p), `CAST(${added} AS ${asDate ? "DATE" : this.tsType()})`, asDate ? "Date" : "Timestamp", where);
      }
      case "date_diff": {
        const endCol = this.need(rel, str(p, "column"), where);
        const unit = str(p, "unit") || "Days";
        const startText = str(p, "start").trim();
        const e = this.ts(endCol, where);
        let s: string;
        const startCol = rel.columns?.find((c) => c.name === startText);
        if (startCol) s = this.ts(startCol, where);
        else if (startText.toLowerCase() === "now") s = this.nowTs();
        else if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?Z?$/.test(startText)) s = `CAST(${literal(d, startText.replace("T", " ").replace(/Z$/, ""), "String", where)} AS ${this.tsType()})`;
        else if (!rel.columns && startText) s = this.ts({ name: startText, type: "Timestamp" }, where);
        else throw new PushdownError(where, "Start must be a column name, a date such as 2024-01-01, or now");
        const slugUnit = unit.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        const name = outputName(p, `${slugUnit}_between`);
        const ms: Record<string, number> = { Weeks: 7 * 86400000, Days: 86400000, Hours: 3600000, Minutes: 60000, Seconds: 1000 };
        if (ms[unit]) return this.withColumn(rel, name, this.truncDiv(`${this.epochMs(e)} - ${this.epochMs(s)}`, String(ms[unit])), "Long", where);
        // calendar months from start to end, less one when the end is earlier in its month (toward zero)
        const m0 = `((YEAR(${e}) - YEAR(${s})) * 12 + MONTH(${e}) - MONTH(${s}))`;
        if (unit === "Months (fractional)") {
          // Spark's MONTHS_BETWEEN: whole months when the days match or both are month ends, else a 31-day fraction
          if (d === "databricks") return this.withColumn(rel, name, `MONTHS_BETWEEN(${e}, ${s})`, "Double", where);
          const sod = (x: string) => `(((${this.epochMs(x)} % 86400000) + 86400000) % 86400000) / 1000.0`;
          const last = (x: string) => `DAY(${x}) = DAY(LAST_DAY(${x}))`;
          const frac = `ROUND(${m0} + ((DAY(${e}) - DAY(${s})) * 86400 + ${sod(e)} - ${sod(s)}) / ${31 * 86400}.0, 8)`;
          return this.withColumn(rel, name, `CAST(CASE WHEN DAY(${e}) = DAY(${s}) OR (${last(e)} AND ${last(s)}) THEN ${m0} ELSE ${frac} END AS DOUBLE)`, "Double", where);
        }
        if (!["Months", "Quarters", "Years"].includes(unit)) throw new PushdownError(where, `the unit ${unit} cannot be pushed down`);
        const rest = `${this.epochMs(e)} - ${this.epochMs(this.addUnit(s, m0, "Month"))}`;
        const months = `(CASE WHEN ${m0} > 0 AND ${rest} < 0 THEN ${m0} - 1 WHEN ${m0} < 0 AND ${rest} > 0 THEN ${m0} + 1 ELSE ${m0} END)`;
        const expr = unit === "Months" ? `CAST(${months} AS ${this.longType()})` : this.truncDiv(months, unit === "Years" ? "12" : "3");
        return this.withColumn(rel, name, expr, "Long", where);
      }
      case "current_time": {
        const date = str(p, "type") === "Date";
        const expr = date ? `CAST(${this.wall(this.nowTs(), str(p, "timezone"), where)} AS DATE)` : this.nowTs();
        return this.withColumn(rel, outputName(p, date ? "current_date" : "current_timestamp"), expr, date ? "Date" : "Timestamp", where);
      }
      case "format_date": {
        const col = this.need(rel, str(p, "column"), where);
        const pattern = str(p, "pattern") || "yyyy-MM-dd HH:mm:ss";
        const zone = col.type === "Date" ? "" : str(p, "timezone");
        const w = this.wall(this.ts(col, where), zone, where);
        return this.withColumn(rel, outputName(p), this.formatTs(w, pattern, !!zone && zone !== "UTC", where), "String", where);
      }
      case "make_date": {
        const y = this.numberOf(rel, str(p, "year"), "Year", where);
        const m = this.numberOf(rel, str(p, "month"), "Month", where);
        const dd = this.numberOf(rel, str(p, "day") || "1", "Day", where);
        const int = (x: string) => `CAST(${x} AS ${this.intType()})`;
        const make = (a: string, b: string, c: string) => (d === "snowflake" ? `DATE_FROM_PARTS(${a}, ${b}, ${c})` : `${d === "duckdb" ? "make_date" : "MAKE_DATE"}(${a}, ${b}, ${c})`);
        // invalid dates (31 February, month 13, fractions) are null, as the JS engine and Spark without ANSI mode
        const expr =
          `CASE WHEN ${y} <> FLOOR(${y}) OR ${m} <> FLOOR(${m}) OR ${dd} <> FLOOR(${dd}) THEN NULL` +
          ` WHEN ${y} < 1 OR ${y} > 9999 OR ${m} < 1 OR ${m} > 12 OR ${dd} < 1 THEN NULL` +
          ` WHEN ${dd} > DAY(LAST_DAY(${make(int(y), int(m), "1")})) THEN NULL` +
          ` ELSE ${make(int(y), int(m), int(dd))} END`;
        return this.withColumn(rel, outputName(p, "date"), expr, "Date", where);
      }
      case "unix_time": {
        const col = this.need(rel, str(p, "column"), where);
        const pattern = str(p, "pattern").trim() || "yyyy-MM-dd HH:mm:ss";
        const zone = str(p, "timezone");
        if (zone) this.zoneLiteral(zone, where);
        if (str(p, "mode") === "From seconds") {
          const n = ["Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal"].includes(col.type) ? `CAST(${q(col.name)} AS DOUBLE)` : `TRY_CAST(${asText(d, q(col.name))} AS DOUBLE)`;
          // milliseconds truncated toward zero, as new Date(seconds * 1000)
          const msExpr = d === "databricks" ? `CAST(${n} * 1000 AS BIGINT)` : d === "snowflake" ? `CAST(TRUNC(${n} * 1000) AS ${this.longType()})` : `CAST(trunc(${n} * 1000) AS BIGINT)`;
          const w = this.wall(this.fromEpochMs(msExpr), zone, where);
          return this.withColumn(rel, outputName(p, "from_unixtime"), this.formatTs(w, pattern, !!zone && zone !== "UTC", where), "String", where);
        }
        let t: string;
        if (col.type === "String") t = `COALESCE(${this.parseText(q(col.name), pattern, "Timestamp", zone, where)}, ${this.textTs(q(col.name))})`;
        else if (col.type === "Date") t = this.unwall(this.ts(col, where), zone, where);
        else t = this.ts(col, where);
        return this.withColumn(rel, outputName(p, "unix_timestamp"), `CAST(FLOOR(${this.epochMs(t)} / 1000) AS ${this.longType()})`, "Long", where);
      }
      case "tz_convert": {
        const col = this.need(rel, str(p, "column"), where);
        const zone = str(p, "timezone");
        if (!zone) throw new PushdownError(where, "choose the time zone");
        const t = this.ts(col, where);
        const expr = str(p, "mode") === "To UTC" ? this.unwall(t, zone, where) : this.wall(t, zone, where);
        return this.withColumn(rel, outputName(p), d === "databricks" ? expr : `CAST(${expr} AS ${this.tsType()})`, "Timestamp", where);
      }
      case "next_day": {
        const col = this.need(rel, str(p, "column"), where);
        const day = str(p, "weekday") || "Monday";
        const target = DAYS_ISO.indexOf(day);
        if (target < 0) throw new PushdownError(where, "choose a weekday");
        const x = col.type === "Date" ? q(col.name) : `CAST(${this.ts(col, where)} AS DATE)`;
        // the first date after x on that weekday (one week later when x is on it)
        const expr =
          d === "duckdb"
            ? `CAST(${x} + CAST(COALESCE(NULLIF((${(target + 1) % 7} - dayofweek(${x}) + 7) % 7, 0), 7) AS INTEGER) AS DATE)`
            : `NEXT_DAY(${x}, '${day.slice(0, 2).toUpperCase()}')`;
        return this.withColumn(rel, outputName(p), expr, "Date", where);
      }
      case "time_window": {
        const col = this.need(rel, str(p, "column"), where);
        let size: number;
        let slide: number;
        let offset: number;
        try {
          size = parseDuration(str(p, "duration"));
          slide = str(p, "slide").trim() ? parseDuration(str(p, "slide")) : size;
          offset = str(p, "start").trim() ? parseDuration(str(p, "start")) : 0;
        } catch (e) {
          throw new PushdownError(where, (e as Error).message);
        }
        if (!(size > 0) || !(slide > 0)) throw new PushdownError(where, "durations must be greater than zero");
        if (slide !== size) throw new PushdownError(where, "sliding windows (a slide other than the duration) cannot be pushed down: only tumbling windows");
        if (![size, offset].every(Number.isInteger)) throw new PushdownError(where, "durations must be whole milliseconds");
        const prefix = str(p, "prefix").trim() || "window";
        const startName = `${prefix}_start`;
        const endName = `${prefix}_end`;
        const ms = this.epochMs(this.ts(col, where));
        const floor = d === "databricks" ? `FLOOR((${ms} - ${offset}) / ${size})` : `CAST(FLOOR((${ms} - ${offset}) / ${size}) AS ${this.longType()})`;
        const startMs = `(${floor} * ${size} + ${offset})`;
        const cast = (x: string) => (d === "databricks" ? x : `CAST(${x} AS ${this.tsType()})`);
        const cols = this.known(rel, where).filter((c) => c.name !== startName && c.name !== endName);
        return this.add(
          `SELECT ${[...cols.map((c) => q(c.name)), `${cast(this.fromEpochMs(startMs))} AS ${q(startName)}`, `${cast(this.fromEpochMs(`${startMs} + ${size}`))} AS ${q(endName)}`].join(", ")}\nFROM ${rel.name}`,
          [...cols, { name: startName, type: "Timestamp" }, { name: endName, type: "Timestamp" }],
        );
      }
      case "pivot": {
        const groupBy = [...new Set(list(p, "groupBy"))].map((c) => this.need(rel, c, where));
        const pc = this.need(rel, str(p, "pivotColumn"), where);
        const fn = str(p, "fn") || "Count";
        const vc = str(p, "valueColumn") ? this.need(rel, str(p, "valueColumn"), where) : null;
        if (!vc && fn !== "Count") throw new PushdownError(where, `${fn} needs a value column`);
        const sqlFn: Record<string, string> = {
          Count: "COUNT", "Count distinct": "COUNT", "Approx count distinct": "COUNT", Sum: "SUM", Mean: "AVG", Min: "MIN", Max: "MAX", Median: "MEDIAN",
          "Std dev": "STDDEV_SAMP", Variance: "VAR_SAMP", "Std dev (population)": "STDDEV_POP", "Variance (population)": "VAR_POP",
          "Any true": d === "snowflake" ? "BOOLOR_AGG" : "BOOL_OR", "All true": d === "snowflake" ? "BOOLAND_AGG" : "BOOL_AND",
        };
        if (!sqlFn[fn]) throw new PushdownError(where, `the ${fn} aggregation cannot be pushed down in a pivot`);
        // a pivot column's values name the new columns: types whose text is written alike in every warehouse
        if (!["String", "Boolean", "Byte", "Short", "Integer", "Long", "Date"].includes(pc.type))
          throw new PushdownError(where, `a ${pc.type} pivot column cannot be pushed down (the warehouse writes its values differently): cast it to text first`);
        if ((fn === "Any true" || fn === "All true") && vc?.type !== "Boolean") throw new PushdownError(where, `${fn} needs a boolean value column`);
        const x = q(pc.name);
        const key = `${this.at}:${s.id}`;
        const values = this.opts.pivotValues?.[key];
        if (!values) {
          const nonEmpty = pc.type === "String" ? `${x} IS NOT NULL AND ${x} <> ''` : `${x} IS NOT NULL`;
          const agg = d === "databricks" ? `TO_JSON(ARRAY_SORT(COLLECT_LIST(${x})))` : d === "snowflake" ? `TO_JSON(ARRAY_AGG(${x}) WITHIN GROUP (ORDER BY ${x}))` : `CAST(to_json(list(${x} ORDER BY ${x})) AS VARCHAR)`;
          const sql = this.with(`SELECT COUNT(*) AS ${q("n")}, ${agg} AS ${q("pivot_values")}\nFROM (SELECT DISTINCT ${x}\n  FROM ${rel.name}\n  WHERE ${nonEmpty}\n  ORDER BY ${x}\n  LIMIT ${PIVOT_MAX + 1}) ${q("v")}`);
          throw new PivotValuesNeeded(key, sql, where, [...this.cps.list]);
        }
        if (values.length > PIVOT_MAX) throw new PushdownError(where, `"${pc.name}" has more than ${PIVOT_MAX} distinct values — pivot supports up to ${PIVOT_MAX}`);
        const numericFn = !["Count", "Count distinct", "Approx count distinct", "Min", "Max", "Any true", "All true"].includes(fn);
        const v = !vc
          ? null
          : numericFn && !["Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal"].includes(vc.type)
            ? `TRY_CAST(${asText(d, q(vc.name))} AS DOUBLE)`
            : vc.type === "String"
              ? `NULLIF(${q(vc.name)}, '')`
              : q(vc.name);
        const taken = new Set(groupBy.map((c) => c.name));
        const counting = fn === "Count" || fn === "Count distinct" || fn === "Approx count distinct";
        const cols = values.map((value) => {
          let name = value;
          for (let k = 2; taken.has(name); k++) name = `${value}_${k}`;
          taken.add(name);
          const when = (e: string) => `CASE WHEN ${x} = ${literal(d, value, pc.type, where)} THEN ${e} END`;
          const rows = `COUNT(${when("1")})`;
          const agg = !v ? rows : `${sqlFn[fn]}(${fn === "Count" || !counting ? "" : "DISTINCT "}${when(v)})`;
          // a group without the value has no cell (null), not a count of 0
          return { name, expr: counting ? `CASE WHEN ${rows} = 0 THEN NULL ELSE CAST(${agg} AS ${this.intType()}) END` : agg };
        });
        const keys = groupBy.map((c) => q(c.name)).join(", ");
        return this.add(`SELECT ${[...groupBy.map((c) => q(c.name)), ...cols.map((c) => `${c.expr} AS ${q(c.name)}`)].join(", ")}\nFROM ${rel.name}${keys ? `\nGROUP BY ${keys}` : ""}`,
          [...groupBy, ...cols.map((c) => ({ name: c.name, type: aggType(fn, vc) }))]);
      }
      case "mapping_join": {
        // the mapping table is another node, named as in a SQL step; its first value per key, as the JS engine keeps it
        const mapping = str(p, "mapping").trim();
        if (!mapping) throw new PushdownError(where, "choose the mapping dataset");
        const id = [...tableNames(this.p.nodes)].find(([, name]) => name === tableName(mapping))?.[0];
        if (!id) throw new PushdownError(where, `there is no node named "${mapping}" (use the table name of another node)`);
        if (id === this.at || this.path.includes(id)) throw new PushdownError(where, `"${mapping}" reads this node: the graph would have a cycle`);
        const [at, path] = [this.at, this.path];
        const m = this.node(id, path);
        [this.at, this.path] = [at, path];
        const key = this.need(m, str(p, "key"), where);
        const value = this.need(m, str(p, "value"), where);
        const targets = [...new Set(list(p, "columns"))].map((c) => this.need(rel, c, where));
        if (!targets.length) throw new PushdownError(where, "choose the columns to map");
        const fallback = str(p, "default");
        const type: ColType = fallback === "" || value.type === "String" ? value.type : "String";
        const k = asText(d, q(key.name));
        const book = this.add(`SELECT ${k} AS ${q("k")}, ANY_VALUE(${q(value.name)}) AS ${q("v")}\nFROM ${m.name}\nWHERE ${q(key.name)} IS NOT NULL\nGROUP BY ${k}`, null);
        const fb = fallback === "" ? `CAST(NULL AS ${sqlType(d, type, where)})` : literal(d, fallback, "String", where);
        const cols = this.known(rel, where);
        const at_ = (c: string) => targets.findIndex((t) => t.name === c);
        // an unmapped value (or null) is the default; a key mapped to null stays null
        const select = cols.map((c) => {
          const i = at_(c.name);
          if (i < 0) return `t.${q(c.name)}`;
          const v = type === value.type ? `m${i}.${q("v")}` : asText(d, `m${i}.${q("v")}`);
          return `CASE WHEN m${i}.${q("k")} IS NULL THEN ${fb} ELSE ${v} END AS ${q(c.name)}`;
        });
        const joins = targets.map((t, i) => `LEFT JOIN ${book.name} m${i} ON m${i}.${q("k")} = ${asText(d, `t.${q(t.name)}`)}`);
        return this.add(`SELECT ${select.join(", ")}\nFROM ${rel.name} t\n${joins.join("\n")}`, cols.map((c) => (at_(c.name) < 0 ? c : { name: c.name, type })));
      }
      case "formula": {
        if (d !== "duckdb") throw new PushdownError(where, "Formula is computed by the DuckDB local engine only: use Arithmetic steps");
        const name = outputName(p, "formula");
        let constants: Record<string, number>;
        try {
          constants = parseConstants(str(p, "constants"));
        } catch (e) {
          throw new PushdownError(where, (e as Error).message);
        }
        const raw = this.withColumn(rel, name, `CAST(${this.formula(str(p, "formula"), rel, constants, where)} AS DOUBLE)`, "Double", where);
        // infinities and NaN (overflow, 0 ÷ 0 inside a function) are null, as the JS engine leaves them
        return this.withColumn(raw, name, `CASE WHEN isfinite(${q(name)}) THEN ${q(name)} END`, "Double", where);
      }
      case "sql": {
        let query = str(p, "query").trim().replace(/;\s*$/, "");
        if (!query) throw new PushdownError(where, "write a query");
        if (/;\s*\S/.test(query)) throw new PushdownError(where, "one statement only: the step's query is pushed down as a subquery");
        // Palantir's CREATE TABLE `/path` AS SELECT … form: the SELECT
        query = query.replace(/^create\s+(or\s+replace\s+)?table\s+(`[^`]*`|"[^"]*"|\S+)\s+as\s+/i, "");
        // the step's input is "input"; other nodes are tables named after them (as the JS engine's SQL step)
        const tables = [`input AS (SELECT * FROM ${rel.name})`];
        const words = new Set(query.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
        for (const [id, name] of tableNames(this.p.nodes)) {
          if (id === this.at || !words.has(name) || this.path.includes(id)) continue;
          const [at, path] = [this.at, this.path];
          const other = this.node(id, path);
          [this.at, this.path] = [at, path];
          tables.push(`${name} AS (SELECT * FROM ${other.name})`);
        }
        // a query with its own WITH … gets these tables first in the same WITH
        const own = query.match(/^with\s+(recursive\s+)?/i);
        return this.add(own ? `WITH ${own[1] ?? ""}${tables.join(", ")}, ${query.slice(own[0].length)}` : `WITH ${tables.join(", ")}\n${query}`, null);
      }
      default:
        throw new PushdownError(where, "this transform cannot be pushed down to the source");
    }
  }

  // ---- nodes

  node(ref: string, path: string[] = []): Rel {
    const id = refNode(ref);
    const key = ref;
    if (this.done.has(key)) return this.done.get(key)!;
    if (path.includes(id)) throw new PushdownError(id, "the graph has a cycle");
    const n = this.p.nodes.find((x) => x.id === id);
    if (!n) throw new PushdownError(ref, "a node this output reads was deleted");
    // a checkpoint (not a split's port) is read from its own table on the DuckDB local engine
    const rel =
      this.opts.local && n.checkpoint && ref === id && id !== this.root
        ? this.checkpoint(n)
        : this.compileNode(substituteParameters(n, this.p.parameters) as PipelineNode, ref, [...path, id]);
    this.done.set(key, rel);
    return rel;
  }

  /** A checkpoint node: compiled once per compile into its own statement (the API computes it once per content). */
  private checkpoint(n: PipelineNode): Rel {
    const table = checkpointTable(n.id);
    const owner = this.cps.owner.get(table);
    if (owner && owner !== n.id) throw new PushdownError(n.name, `the checkpoint table ${table} is taken by another node: rename this node's id`);
    let columns = this.cps.columns.get(n.id);
    if (columns === undefined) {
      const sub = new Compiler(this.p, this.d, this.opts, this.cps, n.id);
      const rel = sub.node(n.id);
      this.cps.list.push({ table, sql: sub.with(`SELECT *\nFROM ${rel.name}`) });
      this.cps.columns.set(n.id, rel.columns);
      this.cps.owner.set(table, n.id);
      columns = rel.columns;
    }
    return this.add(`SELECT *\nFROM ${this.q(table)}`, columns, undefined, true);
  }

  /**
   * A Union node (DuckDB local engine): its inputs by column name, as the JS engine's set operation. A column an
   * input lacks is null there (strict: an error); a column whose inputs disagree on its type is a Double when they
   * are all numbers, else text.
   */
  private union(n: Extract<PipelineNode, { kind: "union" }>, path: string[]): Rel {
    if (!this.opts.local) throw new PushdownError(n.name, "union is not supported in external pipelines");
    if (!n.inputs.length) throw new PushdownError(n.name, "choose datasets to union");
    const q = this.q;
    const rels = n.inputs.map((ref) => this.node(ref, path));
    const cols = rels.map((r) => this.known(r, n.name));
    const names: string[] = [];
    const types = new Map<string, Set<ColType>>();
    for (const cs of cols)
      for (const c of cs) {
        if (!types.has(c.name)) {
          names.push(c.name);
          types.set(c.name, new Set());
        }
        types.get(c.name)!.add(c.type);
      }
    if (n.strict) {
      const problems = cols
        .map((cs, i) => ({ i, missing: names.filter((m) => !cs.some((c) => c.name === m)) }))
        .filter((x) => x.missing.length)
        .map(({ i, missing }) => `"${this.p.nodes.find((x) => x.id === refNode(n.inputs[i]))?.name ?? n.inputs[i]}" is missing ${missing.map((m) => `"${m}"`).join(", ")}`);
      if (problems.length) throw new PushdownError(n.name, `union inputs must have the same schema: ${problems.join("; ")}`);
    }
    const numeric = ["Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal"];
    const out: Column[] = names.map((name) => {
      const ts = [...types.get(name)!];
      return { name, type: ts.length === 1 ? ts[0] : ts.every((t) => numeric.includes(t)) ? "Double" : "String" };
    });
    const selects = cols.map((cs, i) => {
      const list = out.map((c) => {
        const have = cs.find((x) => x.name === c.name);
        if (!have) return `CAST(NULL AS ${sqlType(this.d, c.type, n.name)}) AS ${q(c.name)}`;
        return have.type === c.type ? q(c.name) : `TRY_CAST(${q(c.name)} AS ${sqlType(this.d, c.type, n.name)}) AS ${q(c.name)}`;
      });
      return `SELECT ${list.join(", ")}\nFROM ${rels[i].name}`;
    });
    const op = { "union all": "UNION ALL", "union distinct": "UNION", intersect: "INTERSECT", "intersect all": "INTERSECT ALL", except: "EXCEPT", "except all": "EXCEPT ALL" }[n.mode ?? "union all"];
    return this.add(selects.join(`\n${op}\n`), out);
  }

  private compileNode(n: PipelineNode, ref: string, path: string[]): Rel {
    const q = this.q;
    switch (n.kind) {
      case "source": {
        const ds = this.p.datasets[n.datasetId];
        const r = ds?.ref;
        if (this.opts.local) {
          if (!ds || r?.kind !== "drive") throw new PushdownError(n.name, "the DuckDB local engine reads datasets in Files (Parquet) only");
          if (n.mode === "incremental") throw new PushdownError(n.name, "incremental computation is not supported by the DuckDB local engine");
          return this.add(`SELECT *\nFROM ${q(localTable(n.datasetId))}`, ds.columns?.length ? ds.columns : null, undefined, true);
        }
        if (!ds || r?.kind !== "virtual") throw new PushdownError(n.name, "external pipelines read virtual tables of their source only");
        if (n.mode === "incremental") throw new PushdownError(n.name, "incremental computation is not supported in external pipelines");
        if (this.p.external && r.connectionId !== this.p.external.connectionId) throw new PushdownError(n.name, "this virtual table is from another source");
        const table = [r.database, r.schema, r.table].filter(Boolean).map(q).join(".");
        return this.add(`SELECT *\nFROM ${table}`, ds.columns?.length ? ds.columns : null);
      }
      case "transform": {
        let rel = this.node(n.input, path);
        this.at = n.id;
        this.path = path;
        n.steps.forEach((s, i) => {
          rel = this.step(rel, s, `${n.name} · step ${i + 1} (${s.kind})`);
        });
        return rel;
      }
      case "split": {
        const rel = this.node(n.input, path);
        const cond = this.group(readFilter({ filter: n.condition }), rel, n.name);
        return this.add(`SELECT *\nFROM ${rel.name}\nWHERE ${isFalsePort(ref) ? `NOT ${cond}` : cond}`, rel.columns);
      }
      case "join":
        return this.join(n, path);
      case "union":
        return this.union(n, path);
      case "llm":
        throw new PushdownError(n.name, "Use LLM is not supported in external pipelines");
      case "model":
        throw new PushdownError(n.name, "trained model nodes are not supported in external pipelines");
      default:
        throw new PushdownError(n.name, `${n.kind} nodes cannot be pushed down`);
    }
  }

  private join(n: Extract<PipelineNode, { kind: "join" }>, path: string[]): Rel {
    const q = this.q;
    const l = this.node(n.left, path);
    const r = this.node(n.right, path);
    const where = n.name;
    const keys = n.how === "cross" ? [] : joinKeys(n);
    if (n.how !== "cross" && !keys.length) throw new PushdownError(where, "choose the columns to join on");
    const on = keys.map((k) => {
      const a = `l.${q(this.need(l, k.left, where).name)}`;
      const b = `r.${q(this.need(r, k.right, where).name)}`;
      switch (k.op ?? "=") {
        case "<=>":
          return this.nullSafeEq(a, b);
        case "!<=>":
          return `NOT ${this.nullSafeEq(a, b)}`;
        case "!=":
          return `${a} <> ${b}`;
        default:
          return `${a} ${k.op ?? "="} ${b}`;
      }
    }).join(" AND ");
    const select = joinSelectOf(n);
    const lcols = this.known(l, where);
    const rcols = this.known(r, where);
    const pick = (cols: Column[], names: string[] | null | undefined, side: Rel) => (names ? [...new Set(names)].map((c) => this.need(side, c, where)) : cols);
    const leftCols = select ? pick(lcols, select.left, l) : lcols;
    if (n.how === "left semi" || n.how === "left anti") {
      return this.add(`SELECT ${leftCols.map((c) => `l.${q(c.name)}`).join(", ")}\nFROM ${l.name} l\nWHERE ${n.how === "left anti" ? "NOT " : ""}EXISTS (SELECT 1 FROM ${r.name} r WHERE ${on})`, leftCols);
    }
    // same-named = keys of the same type merge into one column (no column selection), as Pipeline Builder joins do
    const typeOf = (cols: Column[], name: string) => cols.find((c) => c.name === name)?.type;
    const merged = select ? new Set<string>() : new Set(keys.filter((k) => ((k.op ?? "=") === "=" || k.op === "<=>") && k.left === k.right && typeOf(lcols, k.left) === typeOf(rcols, k.right)).map((k) => k.right));
    const taken = new Set(leftCols.map((c) => c.name));
    const out: string[] = leftCols.map((c) => (merged.has(c.name) && (n.how === "right" || n.how === "outer") ? `COALESCE(l.${q(c.name)}, r.${q(c.name)}) AS ${q(c.name)}` : `l.${q(c.name)}`));
    const columns: Column[] = [...leftCols];
    for (const c of select ? pick(rcols, select.right, r) : rcols) {
      if (merged.has(c.name)) continue;
      let name = (select?.prefix ?? "") + c.name;
      while (taken.has(name)) name += "_right";
      taken.add(name);
      out.push(`r.${q(c.name)} AS ${q(name)}`);
      columns.push({ ...c, name });
    }
    const how = { inner: "JOIN", left: "LEFT JOIN", right: "RIGHT JOIN", outer: "FULL OUTER JOIN", cross: "CROSS JOIN" }[n.how as "inner" | "left" | "right" | "outer" | "cross"];
    return this.add(`SELECT ${out.join(", ")}\nFROM ${l.name} l\n${how} ${r.name} r${n.how === "cross" ? "" : ` ON ${on}`}`, columns);
  }
}

/**
 * The SELECT statement computing an output in the source's warehouse, and its columns (null: known when it runs).
 * On the DuckDB local engine `checkpoints` are the checkpoint tables it reads, to be computed first (in order).
 */
export function compileOutput(
  p: Pipeline,
  o: Pick<Output, "node" | "name">,
  dialect: Dialect,
  opts: CompileOptions = {},
): { sql: string; columns: Column[] | null; checkpoints: Checkpoint[]; order?: string } {
  const c = new Compiler(p, dialect, opts);
  const rel = c.node(o.node);
  // order: the node's sort (column names), for whoever reads the statement as a subquery (preview pages)
  return { sql: c.with(`SELECT *\nFROM ${rel.name}${rel.order ? `\nORDER BY ${rel.order}` : ""}`), columns: rel.columns, checkpoints: c.checkpoints, order: rel.order };
}

/** The values of a Pivot step from the row its `PivotValuesNeeded.sql` returned: [count, JSON array]. */
export function pivotValuesFrom(row: unknown[], where = "Pivot"): string[] {
  const n = Number(row[0] ?? 0);
  const raw = row[1];
  let values: unknown = raw;
  if (raw === null || raw === undefined) values = [];
  else if (typeof raw === "string") {
    try {
      values = JSON.parse(raw);
    } catch {
      throw new Error(`${where}: the source returned unreadable pivot values`);
    }
  }
  if (!Array.isArray(values)) throw new Error(`${where}: the source returned unreadable pivot values`);
  if (n > PIVOT_MAX || values.length > PIVOT_MAX) throw new Error(`${where}: more than ${PIVOT_MAX} distinct values — pivot supports up to ${PIVOT_MAX}`);
  return values.filter((v) => v !== null && v !== "").map((v) => String(v));
}

/**
 * Phase one of compiling an output with Pivot steps: runs each pivot's values query in the warehouse (`run` returns
 * the row's values in SELECT order, as /api/pipeline/external/check does) until every pivot has its values.
 */
export async function resolvePivotValues(
  p: Pipeline,
  o: Pick<Output, "node" | "name">,
  dialect: Dialect,
  run: (sql: string, checkpoints: Checkpoint[]) => Promise<unknown[]>,
  base: CompileOptions = {},
): Promise<Record<string, string[]>> {
  const pivotValues: Record<string, string[]> = {};
  for (let i = 0; i <= 100; i++) {
    try {
      compileOutput(p, o, dialect, { ...base, pivotValues });
      return pivotValues;
    } catch (e) {
      if (!(e instanceof PivotValuesNeeded)) throw e;
      pivotValues[e.key] = pivotValuesFrom(await run(e.sql, e.checkpoints), e.where);
    }
  }
  throw new Error(`${o.name}: too many pivot steps`);
}

/** The SQL dialect of an external pipeline's source (Databricks or Snowflake), from the connection kind. */
export function dialectOf(kind: string | undefined): Dialect | null {
  const k = (kind ?? "").toLowerCase();
  return k.includes("databricks") ? "databricks" : k.includes("snowflake") ? "snowflake" : null;
}

/** Why outputs of an external pipeline cannot run in its source (deploy validation). */
export function externalProblems(p: Pipeline, outputs: Output[]): string[] {
  const dialect = dialectOf(p.external?.kind);
  if (!dialect) return [`External pipelines run on Databricks or Snowflake${p.external?.kind ? ` — ${p.external.kind} is not supported` : ": choose the source"}`];
  const out: string[] = [];
  for (const o of outputs) {
    if ((o.kind ?? "dataset") !== "virtualTable") continue;
    if (o.virtualTable && p.external && o.virtualTable.connectionId !== p.external.connectionId) out.push(`${o.name}: the output table must be in the pipeline's source (${p.external.connectionName})`);
    try {
      compileOutput(p, o, dialect);
    } catch (e) {
      // a pivot's values are read from the source when the output builds: what follows it is checked then
      if (e instanceof PivotValuesNeeded) continue;
      out.push(`${o.name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Expectations of an external output, checked in the warehouse before it is written: one SELECT of counts over the
 * output's query (no rows leave the source). `evaluate` turns the row it returns into results, as checkExpectations
 * words them; a failing check in abort mode stops the write.
 */
export function compileExpectations(
  p: Pipeline,
  o: Pick<Output, "node" | "name">,
  dialect: Dialect,
  expectations: Expectation[],
  opts: CompileOptions = {},
): { sql: string; aliases: string[]; checkpoints: Checkpoint[]; evaluate: (row: Record<string, unknown>) => ExpectationResult[] } {
  const c = new Compiler(p, dialect, opts);
  const rel = c.node(o.node);
  const q = (x: string) => quote(dialect, x);
  const known = rel.columns;
  const selects: string[] = [`(SELECT COUNT(*) FROM ${rel.name}) AS ${q("n")}`];
  // the order of the SELECT list: the warehouse returns the values positionally
  const aliases = ["n"];
  type Plan = { e: Expectation; error?: string; keys: string[] };
  const plans: Plan[] = expectations.map((e, i) => {
    const key = (s: string) => `e${i}_${s}`;
    const cols = e.kind === "oneOf" ? (e.column ? [e.column] : []) : e.kind === "rowCount" || e.kind === "rowLevel" ? [] : e.columns;
    if (e.kind !== "rowCount" && e.kind !== "rowLevel" && !cols.length) return { e, keys: [], error: e.kind === "oneOf" ? "Choose the column to check" : "Choose the columns to check" };
    const missing = known ? cols.filter((x) => !known.some((k) => k.name === x)) : [];
    if (missing.length) return { e, keys: [], error: `Column ${missing.map((m) => `"${m}"`).join(", ")} is not in the output` };
    const anyNull = cols.map((x) => `${q(x)} IS NULL`).join(" OR ");
    const count = (where: string, k: string) => {
      selects.push(`(SELECT COUNT(*) FROM ${rel.name} WHERE ${where}) AS ${q(key(k))}`);
      aliases.push(key(k));
      return key(k);
    };
    try {
      switch (e.kind) {
        case "rowCount":
          return { e, keys: [] };
        case "notNull":
          return { e, keys: [count(anyNull, "bad")] };
        case "notNaN": {
          const notFloat = known ? cols.filter((x) => !["Float", "Double", "Decimal"].includes(known.find((k) => k.name === x)!.type)) : [];
          if (notFloat.length) return { e, keys: [], error: `${notFloat.join(", ")} ${notFloat.length > 1 ? "are" : "is"} not a floating point column` };
          const nan = (x: string) => (dialect === "snowflake" ? `${q(x)} = 'NaN'::FLOAT` : dialect === "databricks" ? `ISNAN(${q(x)})` : `isnan(${q(x)})`);
          return { e, keys: [count(cols.map(nan).join(" OR "), "bad")] };
        }
        case "oneOf": {
          if (!e.values.length) return { e, keys: [], error: "Add the permitted values" };
          const list = e.values.map((v) => literal(dialect, v, "String", o.name)).join(", ");
          return { e, keys: [count(`${q(e.column)} IS NULL OR ${asText(dialect, q(e.column))} NOT IN (${list})`, "bad")] };
        }
        case "unique": {
          const keyCols = cols.map(q).join(", ");
          selects.push(`(SELECT COALESCE(SUM(${q("c")} - 1), 0) FROM (SELECT COUNT(*) AS ${q("c")} FROM ${rel.name} GROUP BY ${keyCols} HAVING COUNT(*) > 1) ${q("d")}) AS ${q(key("dups"))}`);
          aliases.push(key("dups"));
          return { e, keys: [count(anyNull, "nulls"), key("dups")] };
        }
        case "rowLevel": {
          const cond = c.group(readFilter({ filter: e.condition }), rel, `${o.name} · expectation`);
          return { e, keys: [count(`NOT ${cond}`, "bad")] };
        }
      }
    } catch (err) {
      return { e, keys: [], error: (err as Error).message };
    }
    return { e, keys: [], error: "unknown expectation" };
  });
  const sql = c.with(`SELECT ${selects.join(",\n  ")}`);
  const num = (v: unknown) => Number(v ?? 0);
  const evaluate = (row: Record<string, unknown>): ExpectationResult[] => {
    const get = (k: string) => num(row[k] ?? row[k.toUpperCase()] ?? row[k.toLowerCase()]);
    const n = get("n");
    return plans.map(({ e, error, keys }) => {
      const base = { id: e.id, mode: e.mode ?? "abort", kind: e.kind };
      if (error) return { ...base, ok: false, message: error };
      switch (e.kind) {
        case "rowCount": {
          const min = e.min ?? null;
          const max = e.max ?? null;
          if (min === null && max === null) return { ...base, ok: false, message: "Set a minimum and/or maximum row count" };
          const range = min !== null && max !== null ? `${min.toLocaleString()}–${max.toLocaleString()}` : min !== null ? `at least ${min.toLocaleString()}` : `at most ${max!.toLocaleString()}`;
          return { ...base, ok: (min === null || n >= min) && (max === null || n <= max), message: `Row count ${range} — has ${n.toLocaleString()}` };
        }
        case "notNull": {
          const bad = get(keys[0]);
          return { ...base, ok: bad === 0, message: `No nulls in ${e.columns.join(", ")}${bad ? ` — ${bad.toLocaleString()} rows have one` : ""}` };
        }
        case "notNaN": {
          const bad = get(keys[0]);
          return { ...base, ok: bad === 0, message: `No NaN in ${e.columns.join(", ")}${bad ? ` — ${bad.toLocaleString()} rows have one` : ""}` };
        }
        case "oneOf": {
          const bad = get(keys[0]);
          return { ...base, ok: bad === 0, message: `${e.column} is one of ${e.values.join(", ")}${bad ? ` — ${bad.toLocaleString()} rows are not` : ""}` };
        }
        case "unique": {
          const nulls = get(keys[0]);
          const dups = get(keys[1]);
          const problems = [nulls ? `${nulls.toLocaleString()} rows have a null` : "", dups ? `${dups.toLocaleString()} duplicate rows` : ""].filter(Boolean);
          return { ...base, ok: !problems.length, message: `Primary key ${e.columns.join(", ")}${problems.length ? ` — ${problems.join(", ")}` : ""}` };
        }
        case "rowLevel": {
          const bad = get(keys[0]);
          return { ...base, ok: bad === 0, message: `Every row passes the condition${bad ? ` — ${bad.toLocaleString()} rows fail` : ""}` };
        }
      }
      return { ...base, ok: false, message: "unknown expectation" };
    });
  };
  return { sql, aliases, checkpoints: c.checkpoints, evaluate };
}
