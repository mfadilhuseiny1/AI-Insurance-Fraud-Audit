/**
 * Spark SQL on SQLite: registers Spark's functions on a sql.js database and rewrites Spark-only syntax
 * (CAST rules, CREATE TABLE … AS) so queries written for Palantir's SQL transforms run in the SQL step.
 */

import {
  addMonths,
  aggregateValues,
  base64ToBytes,
  bytesToBase64,
  castValue,
  COL_TYPES,
  compileDateFormat,
  daysInMonth,
  formatDate,
  fromWallClock,
  isoDate,
  levenshtein,
  monthsBetween,
  ownField,
  parseDateWith,
  setField,
  textOrder,
  toDate,
  truncDate,
  wallClock,
  zoneOffset,
  type Cell,
  type ColType,
} from "./pipeline";
import {
  convBase,
  formatString,
  ipv6Canonical,
  isValidIpv4,
  isValidIpv6,
  isValidUuid,
  parsePhoneNumber,
  parseSemver,
  tokenSetRatio,
  urlDecode,
  urlEncode,
  uuidV5,
  crc32,
  decodeBytes,
  doubleBits,
  encodeText,
  factorial,
  formatNumber,
  fromHex,
  kurtosis,
  md5,
  murmurBytes,
  murmurInt,
  murmurLong,
  pairStat,
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

export type SqlValue = number | string | Uint8Array | null;
type Aggregate<S> = { init?: () => S; step: (state: S, ...args: SqlValue[]) => S; finalize: (state: S) => SqlValue };
export type FunctionHost = {
  create_function: (name: string, fn: (...args: SqlValue[]) => SqlValue | boolean | undefined) => unknown;
  create_aggregate: <S>(name: string, agg: Aggregate<S>) => unknown;
};

const DAY = 86400000;

// ---------------------------------------------------------------- value helpers

// optional arguments arrive as undefined: treated like null
const text = (v: SqlValue | undefined) => (v == null ? null : v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v));
const bytesOf = (v: SqlValue) => (v instanceof Uint8Array ? v : new TextEncoder().encode(String(v)));
const num = (v: SqlValue | undefined): number | null => {
  if (v == null || v instanceof Uint8Array) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const date = (v: SqlValue | undefined) => (v == null || v instanceof Uint8Array ? null : toDate(v));
/** what SQLite can hold: booleans become 1 / 0, NaN and ±∞ null */
const out = (v: unknown): SqlValue => {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  // −0 (e.g. ceil(-0.1)) shows as 0, as in Spark
  if (typeof v === "number") return Number.isFinite(v) ? v + 0 : null;
  if (v instanceof Uint8Array) return v;
  return String(v);
};
const json = (v: SqlValue): unknown[] | null => {
  if (v === null) return null;
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
/** A JSON object (a struct or map), or null. */
const objectOf = (v: SqlValue): Record<string, unknown> | null => {
  if (v === null) return null;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
};
const jsonCell = (x: unknown): Cell => (x === null || x === undefined ? null : typeof x === "object" ? JSON.stringify(x) : (x as Cell));
const sqlCompare = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return textOrder(String(a), String(b));
};
/** yyyy-MM-dd, or null for dates out of range (e.g. date_add with a huge day count) */
const day = (d: Date) => (Number.isNaN(d.getTime()) ? null : isoDate(d));
const ts = (d: Date) => (Number.isNaN(d.getTime()) ? null : d.toISOString());

/** Spark date/time patterns use Java letters; quoted text is literal. */
function format(d: Date, pattern: string, zone = ""): string {
  return formatDate(wallClock(d, zone), pattern, zone && zone !== "UTC" ? zoneOffset(zone, d.getTime()) : 0);
}

function parseWith(s: string, pattern: string | null, zone = ""): Date | null {
  if (!pattern) return toDate(s);
  const iso = parseDateWith([compileDateFormat(pattern)], s, zone, "Timestamp");
  return iso ? new Date(iso) : null;
}

// ---------------------------------------------------------------- CAST

const CAST_TYPES: Record<string, ColType> = {
  boolean: "Boolean",
  bool: "Boolean",
  tinyint: "Byte",
  byte: "Byte",
  smallint: "Short",
  short: "Short",
  int: "Integer",
  integer: "Integer",
  bigint: "Long",
  long: "Long",
  float: "Float",
  real: "Float",
  double: "Double",
  decimal: "Decimal",
  dec: "Decimal",
  numeric: "Decimal",
  date: "Date",
  timestamp: "Timestamp",
  binary: "Binary",
  blob: "Binary",
  string: "String",
  varchar: "String",
  char: "String",
  text: "String",
};
// no prototype: names from data ("constructor", "toString"…) must not match inherited properties
Object.setPrototypeOf(CAST_TYPES, null);

/** Spark type of a raw SQLite value, so castValue applies Spark's rules (e.g. timestamp text → seconds). */
function sqlType(v: SqlValue): ColType {
  if (v instanceof Uint8Array) return "Binary";
  // integers beyond 2^53 (e.g. 1e308) are not exact bigints: treat them as doubles
  if (typeof v === "number") return Number.isSafeInteger(v) ? "Long" : "Double";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "Date";
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return "Timestamp";
  }
  return "String";
}

function sparkCast(v: SqlValue, typeText: SqlValue): SqlValue {
  const m = /^\s*([a-z]+)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/i.exec(String(typeText));
  const type = m ? CAST_TYPES[m[1].toLowerCase()] : undefined;
  if (!type) throw new Error(`CAST to unknown type "${typeText}"`);
  if (v === null) return null;
  const from = sqlType(v);
  const value: Cell = v instanceof Uint8Array ? bytesToBase64(v) : v;
  const decimal = type === "Decimal" ? { precision: Number(m![2] ?? 10), scale: Number(m![3] ?? 0) } : undefined;
  const r = castValue(value, from, type, decimal);
  if (r === null) return null;
  if (type === "Binary") return base64ToBytes(String(r));
  return out(r);
}

const isWordChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);

/** Index just past a quoted string, quoted name or comment starting at i; i itself when none starts there. */
function skipQuoted(sql: string, i: number): number {
  const ch = sql[i];
  if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
    const close = ch === "[" ? "]" : ch;
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === close) {
        if (close !== "]" && sql[j + 1] === close) j += 2;
        else return j + 1;
      } else j++;
    }
    return sql.length;
  }
  if (ch === "-" && sql[i + 1] === "-") {
    const nl = sql.indexOf("\n", i);
    return nl < 0 ? sql.length : nl + 1;
  }
  if (ch === "/" && sql[i + 1] === "*") {
    const end = sql.indexOf("*/", i + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return i;
}

/** Rewrites CAST(x AS type) / TRY_CAST(…) into spark_cast(x, 'type'), which applies Spark's conversion rules. */
export function rewriteCasts(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    const skipped = skipQuoted(sql, i);
    if (skipped > i) {
      result += sql.slice(i, skipped);
      i = skipped;
      continue;
    }
    const word = /^(try_cast|cast)\s*\(/i.exec(sql.slice(i));
    if (word && !isWordChar(sql[i - 1])) {
      // find the matching parenthesis and the last AS at depth 0
      const open = i + word[0].length - 1;
      let depth = 0;
      let asAt = -1;
      let j = open;
      for (; j < sql.length; j++) {
        const s = skipQuoted(sql, j);
        if (s > j) {
          j = s - 1;
          continue;
        }
        if (sql[j] === "(") depth++;
        else if (sql[j] === ")") {
          depth--;
          if (depth === 0) break;
        } else if (depth === 1 && /^as\b/i.test(sql.slice(j, j + 3)) && !isWordChar(sql[j - 1])) asAt = j;
      }
      if (j < sql.length && asAt > 0) {
        // every CAST follows Spark's rules; unknown types fail in spark_cast, as Spark rejects them
        const typeText = sql.slice(asAt + 2, j).trim();
        result += `spark_cast(${rewriteCasts(sql.slice(open + 1, asAt))}, '${typeText.replace(/'/g, "''")}')`;
        i = j + 1;
        continue;
      }
    }
    result += sql[i];
    i++;
  }
  return result;
}

/** Palantir's form CREATE TABLE `/path` AS SELECT … (or AS ( … )) becomes the SELECT itself. */
export function stripCreateTable(sql: string): string {
  const m = /^(\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*)create\s+table\s+(?:`[^`]*`|"[^"]*"|\[[^\]]*\]|[\w./-]+)\s+as\s+/i.exec(sql);
  if (!m) return sql;
  let rest = sql.slice(m[0].length).trim();
  if (rest.startsWith("(") && rest.endsWith(")")) rest = rest.slice(1, -1).trim();
  return rest;
}

// ---------------------------------------------------------------- functions

type Scalar = ((...a: SqlValue[]) => SqlValue) & { required?: number };

/** Null when any argument is null; remembers its parameter count (parameters with defaults are optional) as the arguments it needs. */
const ifAll = (f: (...a: SqlValue[]) => unknown): Scalar =>
  Object.assign((...a: SqlValue[]) => (a.some((x) => x === null) ? null : out(f(...a))), { required: f.length });

function scalar(): Record<string, (...a: SqlValue[]) => SqlValue> {
  const seeds = new Map<number, () => number>();
  const unaryMath: Record<string, (x: number) => number> = {
    ln: Math.log,
    log10: Math.log10,
    log2: Math.log2,
    log1p: Math.log1p,
    expm1: Math.expm1,
    exp: Math.exp,
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    ceil: Math.ceil,
    ceiling: Math.ceil,
    floor: Math.floor,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    signum: Math.sign,
    sign: Math.sign,
    negative: (x) => -x,
    positive: (x) => x,
    degrees: (x) => (x * 180) / Math.PI,
    todegrees: (x) => (x * 180) / Math.PI,
    radians: (x) => (x * Math.PI) / 180,
    toradians: (x) => (x * Math.PI) / 180,
    rint: (x) => roundHalfEven(x, 0),
    factorial: (x) => factorial(x) ?? NaN,
  };
  const fns: Record<string, (...a: SqlValue[]) => SqlValue> = {
    spark_cast: sparkCast,

    // math
    ...Object.fromEntries(Object.entries(unaryMath).map(([k, f]) => [k, ifAll((x) => f(num(x) ?? NaN))])),
    // Spark: log(x) is natural, log(base, x)
    log: (...a) => (a.some((x) => x === null) ? null : out(a.length > 1 ? Math.log(num(a[1]) ?? NaN) / Math.log(num(a[0]) ?? NaN) : Math.log(num(a[0]) ?? NaN))),
    pow: ifAll((x, y) => Math.pow(num(x) ?? NaN, num(y) ?? NaN)),
    power: ifAll((x, y) => Math.pow(num(x) ?? NaN, num(y) ?? NaN)),
    atan2: ifAll((y, x) => Math.atan2(num(y) ?? NaN, num(x) ?? NaN)),
    hypot: ifAll((x, y) => Math.hypot(num(x) ?? NaN, num(y) ?? NaN)),
    pmod: ifAll((a, b) => pmod(num(a) ?? NaN, num(b) ?? NaN)),
    bround: (x, d) => (x === null ? null : out(roundHalfEven(num(x) ?? NaN, num(d ?? 0) ?? 0))),
    shiftleft: ifAll((x, n) => shift(num(x) ?? NaN, num(n) ?? 0, "left")),
    shiftright: ifAll((x, n) => shift(num(x) ?? NaN, num(n) ?? 0, "right")),
    shiftrightunsigned: ifAll((x, n) => shift(num(x) ?? NaN, num(n) ?? 0, "unsigned")),
    bin: ifAll((x) => convBase(String(Math.trunc(num(x) ?? NaN)), 10, 2)),
    conv: ifAll((x, from, to) => convBase(String(x), num(from) ?? 0, num(to) ?? 0)),
    pi: () => Math.PI,
    e: () => Math.E,
    rand: (seed) => {
      if (seed === null || seed === undefined) return Math.random();
      const k = num(seed) ?? 0;
      if (!seeds.has(k)) {
        let x = k >>> 0 || 0x9e3779b9;
        seeds.set(k, () => {
          x = (x + 0x6d2b79f5) | 0;
          let t = Math.imul(x ^ (x >>> 15), 1 | x);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        });
      }
      return seeds.get(k)!();
    },
    greatest: (...a) => out(a.filter((x) => x !== null).sort(sqlCompare).at(-1) ?? null),
    least: (...a) => out(a.filter((x) => x !== null).sort(sqlCompare)[0] ?? null),

    // strings
    ascii: ifAll((s) => (text(s)!.length ? text(s)!.codePointAt(0)! : 0)),
    base64: ifAll((s) => bytesToBase64(bytesOf(s))),
    unbase64: ifAll((s) => base64ToBytes(String(s).replace(/\s+/g, ""))),
    hex: ifAll((v) => (typeof v === "number" && Number.isInteger(v) ? BigInt.asUintN(64, BigInt(v)).toString(16).toUpperCase() : toHex(bytesOf(v)))),
    unhex: ifAll((s) => fromHex(String(s))),
    encode: (s, cs) => {
      if (cs === undefined) throw new Error("encode(text, charset) needs a character set, e.g. 'UTF-8'");
      return s === null || cs === null ? null : encodeText(text(s)!, String(cs));
    },
    decode: (b, cs) => {
      if (cs === undefined) throw new Error("decode(binary, charset) needs a character set, e.g. 'UTF-8'");
      return b === null || cs === null ? null : decodeBytes(bytesOf(b), String(cs));
    },
    soundex: ifAll((s) => soundex(text(s)!)),
    substring_index: ifAll((s, d, n) => substringIndex(text(s)!, String(d), num(n) ?? 0)),
    translate: ifAll((s, f, t) => translate(text(s)!, String(f), String(t))),
    format_number: ifAll((x, d) => formatNumber(num(x) ?? NaN, num(d) ?? 0)),
    levenshtein: ifAll((a, b) => levenshtein([...text(a)!], [...text(b)!])),
    lpad: ifAll((s, n, p: SqlValue | undefined = undefined) => padText(text(s)!, num(n) ?? 0, p === undefined ? " " : text(p)!, true)),
    rpad: ifAll((s, n, p: SqlValue | undefined = undefined) => padText(text(s)!, num(n) ?? 0, p === undefined ? " " : text(p)!, false)),
    repeat: ifAll((s, n) => {
      const times = Math.max(0, Math.trunc(num(n) ?? 0));
      if (text(s)!.length * times > 10_000_000) throw new Error("repeat() result longer than 10,000,000 characters");
      return text(s)!.repeat(times);
    }),
    reverse: ifAll((s) => {
      const arr = json(s);
      return arr ? JSON.stringify([...arr].reverse()) : [...text(s)!].reverse().join("");
    }),
    initcap: ifAll((s) => text(s)!.toLowerCase().replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase())),
    ucase: ifAll((s) => text(s)!.toUpperCase()),
    lcase: ifAll((s) => text(s)!.toLowerCase()),
    // Spark CONCAT is null when any argument is null; CONCAT_WS skips nulls
    concat: (...a) => (a.some((x) => x === null) ? null : a.map((x) => text(x)).join("")),
    concat_ws: (sep, ...a) => (sep === null ? null : a.filter((x) => x !== null).map((x) => text(x)).join(String(sep))),
    split: ifAll((s, pattern) => JSON.stringify(text(s)!.split(new RegExp(String(pattern))))),
    regexp_extract: (s, pattern, idx) => {
      if (s === null || pattern === null) return null;
      const m = new RegExp(String(pattern)).exec(text(s)!);
      return m ? (m[num(idx ?? 1) ?? 1] ?? "") : "";
    },
    regexp_replace: ifAll((s, pattern, rep) => text(s)!.replace(new RegExp(String(pattern), "g"), String(rep))),
    rlike: ifAll((s, pattern) => new RegExp(String(pattern)).test(text(s)!)),
    // SQLite's  x REGEXP y  calls regexp(y, x)
    regexp: ifAll((pattern, s) => new RegExp(String(pattern)).test(text(s)!)),
    get_json_object: ifAll((s, path) => {
      let v: unknown;
      try {
        v = JSON.parse(text(s)!);
      } catch {
        return null;
      }
      const keys = String(path)
        .trim()
        .replace(/^\$\.?/, "")
        .replace(/\[\s*['"]?([^\]'"]*)['"]?\s*\]/g, ".$1")
        .split(".")
        .filter(Boolean);
      for (const k of keys) v = ownField(v, k);
      return v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : v;
    }),

    // dates (dates are yyyy-MM-dd text, timestamps ISO text, both UTC)
    year: ifAll((v) => date(v)?.getUTCFullYear() ?? null),
    quarter: ifAll((v) => {
      const d = date(v);
      return d ? Math.floor(d.getUTCMonth() / 3) + 1 : null;
    }),
    month: ifAll((v) => (date(v) ? date(v)!.getUTCMonth() + 1 : null)),
    day: ifAll((v) => date(v)?.getUTCDate() ?? null),
    dayofmonth: ifAll((v) => date(v)?.getUTCDate() ?? null),
    // Spark: 1 = Sunday … 7 = Saturday
    dayofweek: ifAll((v) => (date(v) ? date(v)!.getUTCDay() + 1 : null)),
    weekday: ifAll((v) => (date(v) ? (date(v)!.getUTCDay() + 6) % 7 : null)),
    dayofyear: ifAll((v) => {
      const d = date(v);
      return d ? (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1 : null;
    }),
    hour: ifAll((v) => date(v)?.getUTCHours() ?? null),
    minute: ifAll((v) => date(v)?.getUTCMinutes() ?? null),
    second: ifAll((v) => date(v)?.getUTCSeconds() ?? null),
    weekofyear: ifAll((v) => {
      const d = date(v);
      if (!d) return null;
      const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
      return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
    }),
    last_day: ifAll((v) => {
      const d = date(v);
      return d ? day(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), daysInMonth(d.getUTCFullYear(), d.getUTCMonth())))) : null;
    }),
    next_day: ifAll((v, dow) => {
      const d = date(v);
      const target = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 }[String(dow).trim().slice(0, 2).toLowerCase()];
      if (!d || target === undefined) return null;
      return day(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((target - d.getUTCDay() + 7) % 7 || 7))));
    }),
    add_months: ifAll((v, n) => {
      const d = date(v);
      return d ? day(addMonths(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), Math.trunc(num(n) ?? 0))) : null;
    }),
    date_add: ifAll((v, n) => {
      const d = date(v);
      return d ? day(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + Math.trunc(num(n) ?? 0)))) : null;
    }),
    date_sub: ifAll((v, n) => {
      const d = date(v);
      return d ? day(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - Math.trunc(num(n) ?? 0)))) : null;
    }),
    datediff: ifAll((end, start) => {
      const a = date(end);
      const b = date(start);
      if (!a || !b) return null;
      const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY;
      return day(a) - day(b);
    }),
    months_between: (a, b, round) => {
      const x = date(a);
      const y = date(b);
      if (!x || !y) return null;
      const m = monthsBetween(x, y);
      return round === 0 || round === "false" ? m : Math.round(m * 1e8) / 1e8;
    },
    date_format: ifAll((v, pattern) => {
      const d = date(v);
      return d ? format(d, String(pattern)) : null;
    }),
    to_date: (v, pattern) => {
      if (v === null) return null;
      const d = parseWith(text(v)!, pattern === undefined || pattern === null ? null : String(pattern));
      return d ? isoDate(d) : null;
    },
    to_timestamp: (v, pattern) => {
      if (v === null) return null;
      const d = parseWith(text(v)!, pattern === undefined || pattern === null ? null : String(pattern));
      return d ? ts(d) : null;
    },
    unix_timestamp: (v, pattern) => {
      if (v === undefined) return Math.floor(Date.now() / 1000);
      if (v === null) return null;
      const d = typeof v === "number" ? null : parseWith(text(v)!, pattern === undefined || pattern === null ? "yyyy-MM-dd HH:mm:ss" : String(pattern)) ?? date(v);
      return d ? Math.floor(d.getTime() / 1000) : null;
    },
    from_unixtime: (v, pattern) => {
      const n = num(v);
      const d = n === null ? null : new Date(n * 1000);
      return !d || Number.isNaN(d.getTime()) ? null : format(d, pattern === undefined || pattern === null ? "yyyy-MM-dd HH:mm:ss" : String(pattern));
    },
    from_utc_timestamp: ifAll((v, zone) => {
      const d = date(v);
      return d ? ts(wallClock(d, String(zone))) : null;
    }),
    to_utc_timestamp: ifAll((v, zone) => {
      const d = date(v);
      return d ? ts(fromWallClock(d, String(zone))) : null;
    }),
    trunc: ifAll((v, unit) => {
      const d = date(v);
      const u = TRUNC[String(unit).toLowerCase()];
      return d && u ? day(truncDate(d, u)) : null;
    }),
    date_trunc: ifAll((unit, v) => {
      const d = date(v);
      const u = TRUNC[String(unit).toLowerCase()];
      if (!d || !u) return null;
      return ts(u === "Second" ? new Date(Math.floor(d.getTime() / 1000) * 1000) : truncDate(d, u));
    }),
    now: () => ts(new Date()),

    // nulls and logic
    isnull: (v) => (v === null ? 1 : 0),
    isnotnull: (v) => (v === null ? 0 : 1),
    nvl: (a, b) => (a === null ? b : a),
    nvl2: (a, b, c) => (a !== null ? b : c),
    isnan: (v) => (typeof v === "string" && v.trim().toLowerCase() === "nan" ? 1 : 0),
    nanvl: (a, b) => (typeof a === "string" && a.trim().toLowerCase() === "nan" ? b : a),

    // collections: arrays and maps are JSON text
    array: (...a) => JSON.stringify(a.map((x) => (x instanceof Uint8Array ? bytesToBase64(x) : x))),
    array_contains: (arr, v) => {
      const xs = json(arr);
      if (!xs || v === null) return null;
      return xs.some((x) => x !== null && sqlCompare(x, v) === 0) ? 1 : 0;
    },
    size: (arr) => {
      if (arr === null) return -1;
      const xs = json(arr);
      if (xs) return xs.length;
      try {
        const o = JSON.parse(String(arr));
        return o && typeof o === "object" ? Object.keys(o).length : null;
      } catch {
        return null;
      }
    },
    sort_array: (arr, asc) => {
      const xs = json(arr);
      if (!xs) return null;
      const up = asc === undefined || asc === null || (asc !== 0 && asc !== "false");
      return JSON.stringify(
        [...xs].sort((a, b) => {
          if (a === null || b === null) return a === null ? (up ? -1 : 1) : up ? 1 : -1;
          return up ? sqlCompare(a, b) : sqlCompare(b, a);
        }),
      );
    },
    element_at: (arr, idx) => {
      const xs = json(arr);
      const i = num(idx);
      if (xs === null) {
        // maps: element_at(map, key)
        try {
          const o = JSON.parse(String(arr));
          return o && typeof o === "object" ? out(jsonCell((ownField(o, String(idx)) ?? null) as unknown)) : null;
        } catch {
          return null;
        }
      }
      if (i === null || i === 0) return null;
      return out(jsonCell(i > 0 ? xs[i - 1] : xs[xs.length + i]));
    },
    array_distinct: ifAll((arr) => {
      const xs = json(arr);
      if (!xs) return null;
      const seen = new Set<string>();
      return JSON.stringify(xs.filter((x) => (seen.has(JSON.stringify(x)) ? false : (seen.add(JSON.stringify(x)), true))));
    }),
    array_join: (arr, sep, nullReplacement) => {
      const xs = json(arr);
      if (!xs || sep === null) return null;
      return xs
        .map((x) => (x === null ? (nullReplacement === undefined || nullReplacement === null ? null : String(nullReplacement)) : String(jsonCell(x))))
        .filter((x) => x !== null)
        .join(String(sep));
    },
    array_max: ifAll((arr) => out(jsonCell((json(arr) ?? []).filter((x) => x !== null).sort(sqlCompare).at(-1) ?? null))),
    array_min: ifAll((arr) => out(jsonCell((json(arr) ?? []).filter((x) => x !== null).sort(sqlCompare)[0] ?? null))),
    slice: ifAll((arr, start, len) => {
      const xs = json(arr);
      const s = num(start) ?? 1;
      if (!xs || s === 0) return null;
      const from = s > 0 ? s - 1 : Math.max(0, xs.length + s);
      return JSON.stringify(xs.slice(from, from + Math.max(0, num(len) ?? 0)));
    }),
    map: (...a) => {
      if (a.length % 2) throw new Error("map() takes key, value pairs");
      const o: Record<string, unknown> = {};
      for (let i = 0; i < a.length; i += 2) {
        if (a[i] === null) throw new Error("A map key is null");
        setField(o, String(a[i]), a[i + 1]);
      }
      return JSON.stringify(o);
    },
    // without column names in SQLite, fields are col1, col2…; named_struct('name', value, …) names them
    struct: (...a) => JSON.stringify(Object.fromEntries(a.map((v, i) => [`col${i + 1}`, v]))),
    named_struct: (...a) => {
      if (a.length % 2) throw new Error("named_struct() takes name, value pairs");
      const o: Record<string, unknown> = {};
      for (let i = 0; i < a.length; i += 2) setField(o, String(a[i]), a[i + 1]);
      return JSON.stringify(o);
    },

    // hashing
    md5: ifAll((v) => md5(bytesOf(v))),
    sha1: ifAll((v) => sha1(bytesOf(v))),
    sha: ifAll((v) => sha1(bytesOf(v))),
    sha2: (v, bits) => {
      if (v === null) return null;
      const b = num(bits) ?? 256;
      const fn = { 0: sha256, 224: sha224, 256: sha256, 384: sha384, 512: sha512 }[b];
      return fn ? fn(bytesOf(v)) : null;
    },
    crc32: ifAll((v) => crc32(bytesOf(v))),
    hash: (...a) =>
      a.reduce<number>((seed, v) => {
        if (v === null) return seed;
        if (v instanceof Uint8Array) return murmurBytes(v, seed);
        if (typeof v === "number") {
          if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) return murmurInt(v, seed);
          return Number.isInteger(v) ? murmurLong(BigInt(v), seed) : murmurLong(doubleBits(v), seed);
        }
        return murmurBytes(new TextEncoder().encode(v), seed);
      }, 42),
    uuid: () => crypto.randomUUID(),
    // arrays (Spark 3.4 / Pipeline Builder array expressions)
    array_position: (arr, v) => {
      const xs = json(arr);
      if (!xs || v === null) return null;
      return xs.findIndex((x) => x !== null && sqlCompare(x, v) === 0) + 1;
    },
    array_remove: (arr, v) => {
      const xs = json(arr);
      if (!xs || v === null) return null;
      return JSON.stringify(xs.filter((x) => x === null || sqlCompare(x, v) !== 0));
    },
    array_repeat: (v, n) => {
      const k = num(n);
      if (k === null) return null;
      if (k > 100_000) throw new Error("array_repeat count is too large");
      return JSON.stringify(new Array(Math.max(0, Math.trunc(k))).fill(v instanceof Uint8Array ? bytesToBase64(v) : v));
    },
    array_union: ifAll((a, b) => {
      const seen = new Set<string>();
      return JSON.stringify([...(json(a) ?? []), ...(json(b) ?? [])].filter((x) => (seen.has(JSON.stringify(x)) ? false : (seen.add(JSON.stringify(x)), true))));
    }),
    array_intersect: ifAll((a, b) => {
      const other = new Set((json(b) ?? []).map((x) => JSON.stringify(x)));
      const seen = new Set<string>();
      return JSON.stringify((json(a) ?? []).filter((x) => other.has(JSON.stringify(x)) && !seen.has(JSON.stringify(x)) && (seen.add(JSON.stringify(x)), true)));
    }),
    array_except: ifAll((a, b) => {
      const other = new Set((json(b) ?? []).map((x) => JSON.stringify(x)));
      const seen = new Set<string>();
      return JSON.stringify((json(a) ?? []).filter((x) => !other.has(JSON.stringify(x)) && !seen.has(JSON.stringify(x)) && (seen.add(JSON.stringify(x)), true)));
    }),
    arrays_overlap: ifAll((a, b) => {
      const other = new Set((json(b) ?? []).filter((x) => x !== null).map((x) => JSON.stringify(x)));
      return (json(a) ?? []).some((x) => x !== null && other.has(JSON.stringify(x)));
    }),
    array_sort: ifAll((arr) =>
      JSON.stringify([...(json(arr) ?? [])].sort((a, b) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : sqlCompare(a, b)))),
    ),
    array_compact: ifAll((arr) => JSON.stringify((json(arr) ?? []).filter((x) => x !== null))),
    array_append: (arr, v) => {
      const xs = json(arr);
      return xs ? JSON.stringify([...xs, v instanceof Uint8Array ? bytesToBase64(v) : v]) : null;
    },
    array_prepend: (arr, v) => {
      const xs = json(arr);
      return xs ? JSON.stringify([v instanceof Uint8Array ? bytesToBase64(v) : v, ...xs]) : null;
    },
    array_insert: (arr, pos, v) => {
      const xs = json(arr);
      const p = num(pos);
      if (!xs || p === null || p === 0) return null;
      const copy = [...xs];
      // 1-based; negative counts from the end; past the end pads with nulls
      const at = p > 0 ? p - 1 : copy.length + p + 1;
      while (copy.length < at) copy.push(null);
      copy.splice(Math.max(0, at), 0, v instanceof Uint8Array ? bytesToBase64(v) : v);
      return JSON.stringify(copy);
    },
    flatten: ifAll((arr) => {
      // inner arrays made by array(...) arrive as JSON text
      const xs = json(arr)?.map((x) => (typeof x === "string" ? (json(x) ?? x) : x));
      if (!xs) return null;
      if (xs.some((x) => x !== null && !Array.isArray(x))) return null;
      return JSON.stringify(xs.flatMap((x) => (x === null ? [] : (x as unknown[]))));
    }),
    arrays_zip: (...arrs) => {
      const lists = arrs.map((a) => json(a));
      if (lists.some((l) => l === null)) return null;
      const n = Math.max(0, ...lists.map((l) => l!.length));
      return JSON.stringify(Array.from({ length: n }, (_, i) => Object.fromEntries(lists.map((l, j) => [String(j), l![i] ?? null]))));
    },
    sequence: (start, stop, step) => {
      const a = num(start);
      const b = num(stop);
      if (a === null || b === null) return null;
      const s = num(step ?? null) ?? (b >= a ? 1 : -1);
      if (s === 0 || (b - a) / s < 0) throw new Error("sequence: the step goes the wrong way");
      if (Math.abs((b - a) / s) > 100_000) throw new Error("sequence: more than 100,000 elements");
      const xs: number[] = [];
      for (let x = a; s > 0 ? x <= b : x >= b; x += s) xs.push(x);
      return JSON.stringify(xs);
    },
    // maps (JSON objects)
    map_from_arrays: ifAll((keys, values) => {
      const ks = json(keys);
      const vs = json(values);
      if (!ks || !vs) return null;
      if (ks.length !== vs.length) throw new Error("map_from_arrays: the key and value arrays differ in length");
      if (ks.some((k) => k === null)) throw new Error("map_from_arrays: a map key cannot be null");
      return JSON.stringify(Object.fromEntries(ks.map((k, i) => [String(k), vs[i] ?? null])));
    }),
    map_keys: ifAll((m) => {
      const o = objectOf(m);
      return o ? JSON.stringify(Object.keys(o)) : null;
    }),
    map_values: ifAll((m) => {
      const o = objectOf(m);
      return o ? JSON.stringify(Object.values(o)) : null;
    }),
    map_concat: (...maps) => {
      const objs = maps.map(objectOf);
      return objs.some((o) => o === null) ? null : JSON.stringify(Object.assign({}, ...objs));
    },
    str_to_map: (s, pairDelim, kvDelim) => {
      const t = text(s);
      if (t === null) return null;
      const pd = text(pairDelim ?? ",") ?? ",";
      const kd = text(kvDelim ?? ":") ?? ":";
      return JSON.stringify(
        Object.fromEntries(
          t.split(pd).map((pair) => {
            const i = pair.indexOf(kd);
            return i < 0 ? [pair, null] : [pair.slice(0, i), pair.slice(i + kd.length)];
          }),
        ),
      );
    },
    // regular expressions
    regexp_extract_all: (s, pattern, idx) => {
      const t = text(s);
      if (t === null || pattern === null) return null;
      const g = num(idx ?? 1) ?? 1;
      return JSON.stringify([...t.matchAll(new RegExp(String(pattern), "g"))].map((m) => m[g] ?? null));
    },
    regexp_count: ifAll((s, pattern) => [...text(s)!.matchAll(new RegExp(String(pattern), "g"))].length),
    regexp_like: ifAll((s, pattern) => new RegExp(String(pattern)).test(text(s)!)),
    // text
    format_string: (fmt, ...args) => (fmt === null ? null : formatString(String(fmt), args)),
    printf: (fmt, ...args) => (fmt === null ? null : formatString(String(fmt), args)),
    url_encode: ifAll((s) => urlEncode(text(s)!)),
    url_decode: ifAll((s) => urlDecode(text(s)!)),
    unicode_normalize: (s, form) => {
      const t = text(s);
      if (t === null) return null;
      const f = (text(form ?? "NFC") ?? "NFC").toUpperCase();
      if (!["NFC", "NFD", "NFKC", "NFKD"].includes(f)) throw new Error("unicode_normalize: the form is NFC, NFD, NFKC or NFKD");
      return t.normalize(f);
    },
    token_set_ratio: (a, b, ignoreCase) => {
      if (a === null || b === null) return null;
      return tokenSetRatio(text(a)!, text(b)!, ignoreCase !== undefined && ignoreCase !== null && ignoreCase !== 0 && ignoreCase !== "false");
    },
    // identifiers and network values
    uuid_v5: ifAll((namespace, name) => uuidV5(text(namespace)!, text(name)!)),
    is_valid_uuid: (s) => (s === null ? 0 : isValidUuid(text(s)!) ? 1 : 0),
    is_valid_ipv4: (s) => (s === null ? 0 : isValidIpv4(text(s)!) ? 1 : 0),
    is_valid_ipv6: (s) => (s === null ? 0 : isValidIpv6(text(s)!) ? 1 : 0),
    ipv6_canonical: ifAll((s) => ipv6Canonical(text(s)!)),
    parse_semantic_version: ifAll((s) => {
      const v = parseSemver(text(s)!);
      return v ? JSON.stringify(v) : null;
    }),
    parse_phone_number: (s, region) => (s === null ? null : parsePhoneNumber(text(s)!, text(region ?? "US") ?? "US")),
  };
  return fns;
}

/** Arguments needed by the functions not wrapped in ifAll. */
const REQUIRED: Record<string, number> = {
  spark_cast: 2,
  log: 1,
  bround: 1,
  concat_ws: 1,
  regexp_extract: 2,
  months_between: 2,
  to_date: 1,
  to_timestamp: 1,
  from_unixtime: 1,
  isnull: 1,
  isnotnull: 1,
  nvl: 2,
  nvl2: 3,
  isnan: 1,
  nanvl: 2,
  array_contains: 2,
  size: 1,
  sort_array: 1,
  element_at: 2,
  array_join: 2,
  sha2: 1,
  encode: 1,
  decode: 1,
  greatest: 2,
  least: 2,
};

const TRUNC: Record<string, string> = {
  year: "Year",
  yyyy: "Year",
  yy: "Year",
  quarter: "Quarter",
  month: "Month",
  mon: "Month",
  mm: "Month",
  week: "Week",
  day: "Day",
  dd: "Day",
  hour: "Hour",
  minute: "Minute",
  second: "Second",
};
// no prototype: names from data ("constructor", "toString"…) must not match inherited properties
Object.setPrototypeOf(TRUNC, null);

function padText(s: string, len: number, fill: string, left: boolean): string {
  if (len > 10_000_000) throw new Error("pad length longer than 10,000,000 characters");
  const chars = [...s];
  if (chars.length >= len) return chars.slice(0, Math.max(0, len)).join("");
  if (!fill) return s;
  const padding = [...fill.repeat(Math.ceil((len - chars.length) / [...fill].length))].slice(0, len - chars.length).join("");
  return left ? padding + s : s + padding;
}

// ---------------------------------------------------------------- aggregates

type Acc = { values: SqlValue[] };
const collect = (fn: (values: SqlValue[]) => SqlValue): Aggregate<Acc> => ({
  init: () => ({ values: [] }),
  step: (s, v) => {
    s.values.push(v === undefined ? null : v);
    return s;
  },
  finalize: (s) => fn(s.values),
});
/** binary values (bytes) as base64 text, like the pipeline holds them */
const cells = (values: SqlValue[]): Cell[] => values.map((v) => (v instanceof Uint8Array ? bytesToBase64(v) : v));
const viaPipeline = (name: string, arg = "") => collect((values) => out(aggregateValues(name, cells(values), values.length, arg)));
const numbers = (values: SqlValue[]) => values.map(num).filter((n): n is number => n !== null);

type PairAcc = { pairs: [number, number][] };
const pair = (kind: "corr" | "covar_pop" | "covar_samp"): Aggregate<PairAcc> => ({
  init: () => ({ pairs: [] }),
  step: (s, x, y) => {
    const a = num(x);
    const b = num(y);
    if (a !== null && b !== null) s.pairs.push([a, b]);
    return s;
  },
  finalize: (s) => out(pairStat(kind, s.pairs)),
});

type ArgAcc = { values: SqlValue[]; arg: SqlValue };
const withArg = (fn: (values: SqlValue[], arg: SqlValue) => SqlValue): Aggregate<ArgAcc> => ({
  init: () => ({ values: [], arg: null }),
  step: (s, v, arg) => {
    s.values.push(v === undefined ? null : v);
    s.arg = arg === undefined ? null : arg;
    return s;
  },
  finalize: (s) => fn(s.values, s.arg),
});

type ByAcc = { best: SqlValue; key: SqlValue };
const by = (largest: boolean): Aggregate<ByAcc> => ({
  init: () => ({ best: null, key: null }),
  step: (s, v, key) => {
    if (key === null || key === undefined) return s;
    if (s.key === null || (largest ? sqlCompare(key, s.key) > 0 : sqlCompare(key, s.key) < 0)) {
      s.key = key;
      s.best = v;
    }
    return s;
  },
  finalize: (s) => s.best,
});

function aggregates(): Record<string, Aggregate<never>> {
  const list = (values: SqlValue[]) => JSON.stringify(values.filter((v) => v !== null).map((v) => (v instanceof Uint8Array ? bytesToBase64(v) : v)));
  const aggs: Record<string, Aggregate<Acc> | Aggregate<PairAcc> | Aggregate<ArgAcc> | Aggregate<ByAcc>> = {
    collect_list: collect(list),
    array_agg: collect(list),
    collect_set: collect((values) => {
      const seen = new Set<string>();
      return JSON.stringify(values.filter((v) => v !== null && (seen.has(String(v)) ? false : (seen.add(String(v)), true))));
    }),
    first: withArg((values, ignoreNulls) => (ignoreNulls === 1 || ignoreNulls === "true" ? (values.find((v) => v !== null) ?? null) : (values[0] ?? null))),
    last: withArg((values, ignoreNulls) =>
      ignoreNulls === 1 || ignoreNulls === "true" ? ([...values].reverse().find((v) => v !== null) ?? null) : (values[values.length - 1] ?? null),
    ),
    mean: viaPipeline("Mean"),
    median: viaPipeline("Median"),
    mode: viaPipeline("Mode"),
    stddev: viaPipeline("Std dev"),
    std: viaPipeline("Std dev"),
    stddev_samp: viaPipeline("Std dev"),
    stddev_pop: viaPipeline("Std dev (population)"),
    variance: viaPipeline("Variance"),
    var_samp: viaPipeline("Variance"),
    var_pop: viaPipeline("Variance (population)"),
    skewness: collect((values) => out(skewness(numbers(values)))),
    kurtosis: collect((values) => out(kurtosis(numbers(values)))),
    approx_count_distinct: viaPipeline("Count distinct"),
    // Spark percentile takes a fraction 0–1
    percentile: withArg((values, p) => out(aggregateValues("Percentile", cells(values), values.length, String((num(p) ?? 0.5) * 100)))),
    percentile_approx: withArg((values, p) => out(aggregateValues("Percentile", cells(values), values.length, String((num(p) ?? 0.5) * 100)))),
    corr: pair("corr"),
    covar_pop: pair("covar_pop"),
    covar_samp: pair("covar_samp"),
    bool_and: viaPipeline("All true"),
    every: viaPipeline("All true"),
    bool_or: viaPipeline("Any true"),
    count_if: collect((values) => values.filter((v) => v !== null && v !== 0 && v !== "0" && v !== "false").length),
    max_by: by(true),
    min_by: by(false),
  };
  return aggs as unknown as Record<string, Aggregate<never>>;
}

const SCALAR_NAMES = new Set(Object.keys(scalar()));
const AGGREGATE_NAMES = new Set(Object.keys(aggregates()));
const PREFIX = "spark_";

/** Spark functions available in the SQL step, for the editor's help. */
export const SPARK_SQL_FUNCTIONS = [...SCALAR_NAMES, ...AGGREGATE_NAMES].filter((n) => n !== "spark_cast").sort();

/** sql.js takes a function's argument count from its declared parameters; -1 lets SQLite pass any number. */
function variadic<F extends (...a: never[]) => unknown>(f: F, length: number): F {
  Object.defineProperty(f, "length", { value: length });
  return f;
}

/**
 * Registers every Spark function as spark_<name> (rewriteFunctionNames points the query's calls there), so
 * SQLite's built-ins with the same name but other rules (log, hex, concat, trunc, percentile…) are not used.
 */
export function registerSparkFunctions(db: FunctionHost) {
  const fns = scalar();
  for (const [name, fn] of Object.entries(fns)) {
    const needs = (fn as Scalar).required ?? REQUIRED[name] ?? 0;
    const checked = (...a: SqlValue[]) => {
      if (a.length < needs) throw new Error(`${name}() needs ${needs === 1 ? "an argument" : `${needs} arguments`}`);
      return fn(...a);
    };
    db.create_function(name === "spark_cast" ? name : PREFIX + name, variadic(safely(checked), -1));
  }
  // SQLite's  x REGEXP y  operator calls regexp(y, x)
  db.create_function("regexp", variadic(safely(fns.regexp), -1));
  for (const [name, agg] of Object.entries(aggregates()))
    db.create_aggregate(PREFIX + name, {
      ...agg,
      step: variadic(safely((s: never, ...a: SqlValue[]) => agg.step(s, ...a)), 0),
      // over no rows sql.js finalizes without ever calling init
      finalize: safely((s: never) => agg.finalize(s ?? (agg.init ? (agg.init() as never) : s))),
    });
}

/** sql.js reports a thrown string as the SQL error; an Error object would arrive empty. */
function safely<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  return (...a: A) => {
    try {
      return fn(...a);
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  };
}

/** Calls of Spark functions, e.g. date_format(…), become spark_date_format(…); strings, names and comments are untouched. */
export function rewriteFunctionNames(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    const skipped = skipQuoted(sql, i);
    if (skipped > i) {
      result += sql.slice(i, skipped);
      i = skipped;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\s*\()/.exec(sql.slice(i));
    if (m && !isWordChar(sql[i - 1]) && sql[i - 1] !== ".") {
      const name = m[1].toLowerCase();
      const known = name !== "spark_cast" && (SCALAR_NAMES.has(name) || AGGREGATE_NAMES.has(name));
      result += (known ? PREFIX + name : m[1]) + m[2];
      i += m[0].length;
      continue;
    }
    result += sql[i];
    i++;
  }
  return result;
}

/** Spark-only syntax → SQLite. */
export const toSqlite = (sql: string) => rewriteFunctionNames(rewriteCasts(stripCreateTable(sql)));

export const SPARK_TYPES = COL_TYPES;
