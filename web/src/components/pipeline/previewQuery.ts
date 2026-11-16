/**
 * What a data preview shows of a table: its rows that contain a Find keyword and pass the Filter-by conditions, in
 * the chosen order, one page at a time. The same query runs in two places: over the rows the browser holds (the JS
 * engine's result), and as DuckDB SQL around a node's statement (a DuckDB local pipeline, over every row of the node:
 * duckdbPreview.ts). Both read a cell as its text the same way, so a filter keeps the same rows in either place.
 */
import { compareCells, isNumericType, type Cell, type Column, type ColType, type Row, type Table } from "@/lib/pipeline";

/** rows per page (as the editor's preview of a node: lib/deployed.ts SAMPLE_ROWS) */
export const PAGE_ROWS = 100;

export type FilterOp = "months" | "contains" | "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "empty" | "notEmpty";
/** months: `values` holds year-months ("2024-03"); empty / notEmpty: no value; the others compare with `value` */
export type PreviewFilter = { column: string; op: FilterOp; value?: string; values?: string[] };
export type PreviewSort = { column: string; dir: 1 | -1 };
export type PreviewQuery = { find: string; filters: PreviewFilter[]; sort: PreviewSort | null };
export type MonthCount = { month: string; rows: number };

/** Pages, finds and filters over every row of a node, where the rows the browser holds are only its first page. */
export type PreviewPager = {
  /** the table shown is not this pager's first page (a source's stored sample, in the file's order): read it too */
  fetchFirst?: boolean;
  page: (q: PreviewQuery, columns: Column[], offset: number) => Promise<{ table: Table; total: number }>;
  /** the year-months of `column` among the rows `q` keeps, with their row counts */
  months: (column: string, columns: Column[], q: PreviewQuery) => Promise<MonthCount[]>;
};

export const FILTER_OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: "contains", label: "contains", needsValue: true },
  { op: "eq", label: "=", needsValue: true },
  { op: "ne", label: "≠", needsValue: true },
  { op: "gt", label: ">", needsValue: true },
  { op: "ge", label: "≥", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "le", label: "≤", needsValue: true },
  { op: "empty", label: "is empty", needsValue: false },
  { op: "notEmpty", label: "is not empty", needsValue: false },
];

export const isEmptyQuery = (q: PreviewQuery) => !q.find.trim() && !q.filters.length && !q.sort;

/** A cell as the text Find and the text filters read: numbers and booleans as JavaScript writes them. */
export const cellText = (v: Cell | undefined) => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));

const MONTH = /^\d{4}-\d{2}/;
/** A date, a timestamp (ISO, UTC) or a text starting with one: its year-month; anything else none. */
export const monthOf = (v: Cell | undefined) => {
  const s = cellText(v);
  return MONTH.test(s) ? s.slice(0, 7) : null;
};

/** Dates and timestamps, and text columns whose values are mostly ISO dates ("2024-03-15", "2024-03"). */
export function isDateLike(c: Column, rows: Row[]): boolean {
  if (c.type === "Date" || c.type === "Timestamp") return true;
  if (c.type !== "String") return false;
  let seen = 0;
  let dated = 0;
  for (const r of rows.slice(0, 200)) {
    const v = r[c.name];
    if (v === null || v === undefined || v === "") continue;
    seen += 1;
    if (MONTH.test(cellText(v))) dated += 1;
  }
  return seen > 0 && dated / seen >= 0.8;
}

/** "2024-03" → "Mar 2024" */
export function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return m;
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function filterLabel(f: PreviewFilter): string {
  if (f.op === "months") {
    const v = (f.values ?? []).slice().sort();
    return `${f.column}: ${v.length > 3 ? `${v.slice(0, 2).map(monthLabel).join(", ")} +${v.length - 2} months` : v.map(monthLabel).join(", ")}`;
  }
  const op = FILTER_OPS.find((o) => o.op === f.op);
  return op?.needsValue ? `${f.column} ${op.label} "${f.value ?? ""}"` : `${f.column} ${op?.label ?? f.op}`;
}

// ---------------------------------------------------------------- the value a condition compares with

// A value typed in a condition is read here, once, and the browser and the SQL both compare with what this reads:
// JavaScript's Number() and Date.parse() and DuckDB's casts disagree on texts such as "0x10", "2024-03", "2024-1-5"
// (local time in Date.parse) or "08:00+07:00" (DuckDB drops the zone).

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
/** A number written as decimals or with an exponent, else NaN. */
export const numberOf = (s: string) => (NUMBER.test(s.trim()) ? Number(s.trim()) : NaN);

const INSTANT = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
/**
 * A date or timestamp as epoch ms, else NaN: "2024", "2024-03", "2024-03-15", "2024-03-15 08:00[:00[.000]]" with an
 * optional zone ("Z", "+07:00"). Without a zone it is UTC, as the API sends timestamps (and a date is its midnight).
 */
export function instantOf(s: string): number {
  const m = INSTANT.exec(s.trim());
  if (!m) return NaN;
  const n = (i: number, none: number) => (m[i] === undefined ? none : Number(m[i]));
  const [y, mo, d, h, mi, sec] = [n(1, 0), n(2, 1), n(3, 1), n(4, 0), n(5, 0), n(6, 0)];
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0);
  const back = new Date(t);
  // no rolling over: 2024-02-30 is no date
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || sec > 59) return NaN;
  const zone = m[8]?.toUpperCase();
  if (!zone || zone === "Z") return t;
  const digits = zone.slice(1).replace(":", "");
  return t - (zone[0] === "-" ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) * 60_000;
}

// ---------------------------------------------------------------- in the browser

function passes(row: Row, f: PreviewFilter, type: ColType | undefined): boolean {
  const v = row[f.column] ?? null;
  const text = cellText(v);
  switch (f.op) {
    case "months": {
      const m = monthOf(v);
      return m !== null && (f.values ?? []).includes(m);
    }
    case "empty":
      return text === "";
    case "notEmpty":
      return text !== "";
    case "contains":
      return text.toLowerCase().includes((f.value ?? "").toLowerCase());
  }
  // comparisons: a null cell passes none (as in SQL); numbers by value, dates and timestamps by instant, the rest as text
  if (v === null) return false;
  const want = f.value ?? "";
  let d: number;
  if (isNumericType(type) || type === "Date" || type === "Timestamp") {
    const a = isNumericType(type) ? Number(v) : instantOf(text);
    const b = isNumericType(type) ? numberOf(want) : instantOf(want);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    d = a - b;
  } else d = text < want ? -1 : text > want ? 1 : 0;
  return f.op === "eq" ? d === 0 : f.op === "ne" ? d !== 0 : f.op === "gt" ? d > 0 : f.op === "ge" ? d >= 0 : f.op === "lt" ? d < 0 : d <= 0;
}

/** The rows of `table` the query keeps, in its order. */
export function queryRows(table: Table, q: PreviewQuery): Row[] {
  const kw = q.find.trim().toLowerCase();
  const types = new Map(table.columns.map((c) => [c.name, c.type]));
  const filters = q.filters.filter((f) => types.has(f.column));
  let rows = table.rows;
  if (kw || filters.length)
    rows = rows.filter(
      (r) => filters.every((f) => passes(r, f, types.get(f.column))) && (!kw || table.columns.some((c) => cellText(r[c.name]).toLowerCase().includes(kw))),
    );
  const sort = q.sort && types.has(q.sort.column) ? q.sort : null;
  if (sort)
    rows = [...rows].sort((a, b) => {
      const av = a[sort.column] ?? null;
      const bv = b[sort.column] ?? null;
      return av === null || bv === null ? compareCells(av, bv) : sort.dir * compareCells(av, bv);
    });
  return rows;
}

export function monthCounts(rows: Row[], column: string): MonthCount[] {
  const n = new Map<string, number>();
  for (const r of rows) {
    const m = monthOf(r[column]);
    if (m) n.set(m, (n.get(m) ?? 0) + 1);
  }
  return [...n].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, rows]) => ({ month, rows }));
}

/** The query without the months filter of `column` (the month list of a column shows every month to pick from). */
export const withoutMonthsOf = (q: PreviewQuery, column: string): PreviewQuery => ({
  ...q,
  filters: q.filters.filter((f) => !(f.op === "months" && f.column === column)),
  sort: null,
});

// ---------------------------------------------------------------- as DuckDB SQL

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const asText = (c: string) => `CAST(${ident(c)} AS VARCHAR)`;
/**
 * A timestamp as its UTC wall-clock time, as the API sends it: a time-zoned one converted, a plain one as it is.
 * (strftime and CAST of a TIMESTAMPTZ use the session's time zone, which is the machine's.)
 */
const utcSql = (c: string) => `make_timestamp(epoch_us(${ident(c)}))`;

/**
 * A cell's text as the browser holds it (cellText of the API's JSON): timestamps as ISO in UTC with milliseconds
 * ("2024-03-15T08:00:00.000Z", DuckDB writes "2024-03-15 08:00:00"), whole fractional numbers without ".0".
 */
function textSql(c: Column): string {
  const col = ident(c.name);
  if (c.type === "Timestamp") return `strftime(${utcSql(c.name)}, '%Y-%m-%dT%H:%M:%S.%gZ')`;
  if (c.type === "Double" || c.type === "Float" || c.type === "Decimal") {
    // the API sends floats and decimals as doubles
    const x = `CAST(${col} AS DOUBLE)`;
    return `CASE WHEN isfinite(${x}) AND ${x} = trunc(${x}) AND abs(${x}) < 1e15 THEN CAST(TRY_CAST(${x} AS BIGINT) AS VARCHAR) ELSE CAST(${x} AS VARCHAR) END`;
  }
  return asText(c.name);
}

/** A column's year-month as SQL: dates and timestamps by strftime, text by its first 7 characters when ISO. */
export function monthSql(c: Column): string {
  if (c.type === "Date") return `strftime(${ident(c.name)}, '%Y-%m')`;
  if (c.type === "Timestamp") return `strftime(${utcSql(c.name)}, '%Y-%m')`;
  return `CASE WHEN regexp_matches(${asText(c.name)}, '^[0-9]{4}-[0-9]{2}') THEN substr(${asText(c.name)}, 1, 7) END`;
}

function filterSql(f: PreviewFilter, c: Column): string {
  const col = ident(c.name);
  const text = textSql(c);
  const want = f.value ?? "";
  switch (f.op) {
    case "months":
      return (f.values ?? []).length ? `${monthSql(c)} IN (${(f.values ?? []).map(lit).join(", ")})` : "FALSE";
    case "empty":
      return `(${col} IS NULL OR ${text} = '')`;
    case "notEmpty":
      return `(${col} IS NOT NULL AND ${text} <> '')`;
    case "contains":
      return `contains(lower(${text}), ${lit(want.toLowerCase())})`;
  }
  const op = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=" }[f.op];
  // numbers by value, dates and timestamps by instant (a value that is neither keeps no row), the rest as text
  if (isNumericType(c.type)) {
    const n = numberOf(want);
    return Number.isNaN(n) ? "FALSE" : `TRY_CAST(${col} AS DOUBLE) ${op} (${n})`;
  }
  if (c.type === "Date" || c.type === "Timestamp") {
    const t = instantOf(want);
    if (Number.isNaN(t)) return "FALSE";
    // to the millisecond, as the browser holds timestamps
    const at = `TIMESTAMP '${new Date(t).toISOString().slice(0, 23).replace("T", " ")}'`;
    return c.type === "Date" ? `CAST(${col} AS TIMESTAMP) ${op} ${at}` : `date_trunc('millisecond', ${utcSql(c.name)}) ${op} ${at}`;
  }
  return `${text} ${op} ${lit(want)}`;
}

/** The rows of `statement` the query's Find and filters keep, in no particular order (`orderSql` orders the pages). */
export function filteredSql(statement: string, columns: Column[], q: Pick<PreviewQuery, "find" | "filters">): string {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const where = q.filters.filter((f) => byName.has(f.column)).map((f) => filterSql(f, byName.get(f.column)!));
  const kw = q.find.trim().toLowerCase();
  if (kw) {
    const any = columns.filter((c) => c.type !== "Binary").map((c) => `contains(lower(${textSql(c)}), ${lit(kw)})`);
    where.push(any.length ? `(${any.join(" OR ")})` : "FALSE");
  }
  return `SELECT *\nFROM (\n${statement}\n) AS preview_rows${where.length ? `\nWHERE ${where.join("\n  AND ")}` : ""}`;
}

type OrderKey = { expr: string; desc: boolean; nullsFirst: boolean };
const keySql = (k: OrderKey, reverse: boolean) => `${k.expr} ${k.desc !== reverse ? "DESC" : "ASC"} NULLS ${k.nullsFirst !== reverse ? "FIRST" : "LAST"}`;
const ORDER_KEY = /^("(?:[^"]|"")*") (ASC|DESC)(?: NULLS (FIRST|LAST))?$/;

/**
 * A node's own ORDER BY (as the compiler writes it: quoted columns, ASC / DESC, NULLS …) as keys; null when it reads
 * otherwise. DuckDB puts nulls last when the order does not say.
 */
function orderKeys(order: string): OrderKey[] | null {
  const parts = (order.match(/"(?:[^"]|"")*"[^,"]*/g) ?? []).map((p) => p.trim());
  if (!parts.length || parts.join(", ") !== order.trim()) return null;
  const keys: OrderKey[] = [];
  for (const part of parts) {
    const m = ORDER_KEY.exec(part);
    if (!m) return null;
    keys.push({ expr: m[1], desc: m[2] === "DESC", nullsFirst: m[3] === "FIRST" });
  }
  return keys;
}

/**
 * The ORDER BY of preview pages: the chosen sort, then `then` (the node's own order), then every column, so that no
 * two different rows tie: the pages of a statement whose rows come in a different order on each run (the API's
 * DuckDB does not keep the scan order; a join, an aggregate, a sort with equal values) then follow on from each other,
 * without a row on two pages. `reverse`: the same order backwards (the last pages read from the end); null when the
 * node's order cannot be reversed.
 */
export function orderSql(sort: PreviewSort | null, then: string | undefined, reverse = false): string | null {
  const keys: OrderKey[] = [];
  if (sort) keys.push({ expr: ident(sort.column), desc: sort.dir === -1, nullsFirst: false });
  if (then?.trim()) {
    const own = orderKeys(then);
    if (!own) return reverse ? null : [...keys.map((k) => keySql(k, false)), then, "COLUMNS(*) ASC NULLS LAST"].join(", ");
    keys.push(...own);
  }
  keys.push({ expr: "COLUMNS(*)", desc: false, nullsFirst: false });
  return keys.map((k) => keySql(k, reverse)).join(", ");
}

/** The year-months of `column` among the rows of `statement` the query keeps, with their counts. */
export function monthsSql(statement: string, columns: Column[], column: string, q: Pick<PreviewQuery, "find" | "filters">): string {
  const c = columns.find((x) => x.name === column);
  if (!c) throw new Error(`no column ${column}`);
  return `SELECT preview_month AS "month", count(*) AS "rows"\nFROM (SELECT ${monthSql(c)} AS preview_month FROM (\n${filteredSql(statement, columns, q)}\n) AS kept)\nWHERE preview_month IS NOT NULL\nGROUP BY preview_month\nORDER BY preview_month`;
}
