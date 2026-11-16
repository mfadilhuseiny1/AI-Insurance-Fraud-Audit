/** Workshop variable transformations: a chain of common operations run in the browser (each step may use earlier steps). */
import type { TArg, TStep } from "./workshop";

type Op = { label: string; group: string; args: string[]; opts?: { key: string; label: string; choices?: string[] }[] };

/** The operations, by group (the labels and argument names the editor shows). */
export const OPS: Record<string, Op> = {
  concat: { label: "String concatenation", group: "General", args: ["value…"], opts: [{ key: "separator", label: "Between elements" }] },
  if_else: { label: "If / else", group: "General", args: ["condition", "then", "else"] },
  to_number: { label: "Cast to number", group: "General", args: ["value"] },
  to_date: { label: "Cast to date (yyyy-mm-dd)", group: "General", args: ["value"] },
  to_string: { label: "Cast to string", group: "General", args: ["value"] },
  add: { label: "Add", group: "Math", args: ["value…"] },
  subtract: { label: "Subtract", group: "Math", args: ["a", "b"] },
  multiply: { label: "Multiply", group: "Math", args: ["value…"] },
  divide: { label: "Divide", group: "Math", args: ["a", "b"] },
  abs: { label: "Absolute", group: "Math", args: ["value"] },
  negate: { label: "Negate", group: "Math", args: ["value"] },
  ceil: { label: "Round up", group: "Math", args: ["value"], opts: [{ key: "precision", label: "Decimals" }] },
  floor: { label: "Round down", group: "Math", args: ["value"], opts: [{ key: "precision", label: "Decimals" }] },
  round: { label: "Round nearest", group: "Math", args: ["value"], opts: [{ key: "precision", label: "Decimals" }] },
  max: { label: "Max", group: "Math", args: ["value…"] },
  min: { label: "Min", group: "Math", args: ["value…"] },
  relative_date: { label: "Relative date", group: "Date / time", args: ["date", "amount"], opts: [{ key: "unit", label: "Unit", choices: ["days", "weeks", "months", "years"] }] },
  between_dates: { label: "Between dates", group: "Date / time", args: ["from", "to"], opts: [{ key: "unit", label: "Unit", choices: ["days", "weeks", "months", "years"] }] },
  current_date: { label: "Current date", group: "Date / time", args: [] },
  current_time: { label: "Current time", group: "Date / time", args: [] },
  date_on_or_after: { label: "Date is on or after", group: "Date / time", args: ["a", "b"] },
  date_after: { label: "Date is after", group: "Date / time", args: ["a", "b"] },
  date_on_or_before: { label: "Date is on or before", group: "Date / time", args: ["a", "b"] },
  date_before: { label: "Date is before", group: "Date / time", args: ["a", "b"] },
  date_equal: { label: "Date is equal", group: "Date / time", args: ["a", "b"] },
  eq: { label: "Equal to", group: "Numeric comparison", args: ["a", "b"] },
  neq: { label: "Not equal to", group: "Numeric comparison", args: ["a", "b"] },
  lt: { label: "Less than", group: "Numeric comparison", args: ["a", "b"] },
  lte: { label: "Less than or equal to", group: "Numeric comparison", args: ["a", "b"] },
  gt: { label: "Greater than", group: "Numeric comparison", args: ["a", "b"] },
  gte: { label: "Greater than or equal to", group: "Numeric comparison", args: ["a", "b"] },
  str_is: { label: "String is", group: "String comparison", args: ["a", "b"] },
  str_is_not: { label: "String is not", group: "String comparison", args: ["a", "b"] },
  contains: { label: "Contains", group: "String comparison", args: ["text", "part"] },
  not_contains: { label: "Does not contain", group: "String comparison", args: ["text", "part"] },
  starts_with: { label: "Starts with", group: "String comparison", args: ["text", "prefix"] },
  ends_with: { label: "Ends with", group: "String comparison", args: ["text", "suffix"] },
  is_true: { label: "Is true", group: "Boolean", args: ["value"] },
  is_false: { label: "Is false (NOT)", group: "Boolean", args: ["value"] },
  and: { label: "And", group: "Boolean", args: ["value…"] },
  or: { label: "Or", group: "Boolean", args: ["value…"] },
  is_null: { label: "Is null", group: "Boolean", args: ["value"] },
  not_null: { label: "Is not null", group: "Boolean", args: ["value"] },
  compose: { label: "Compose arrays", group: "Array", args: ["array…"] },
  intersection: { label: "Intersection", group: "Array", args: ["array…"] },
  get_at: { label: "Get element at", group: "Array", args: ["array", "index"] },
  update_at: { label: "Update element at", group: "Array", args: ["array", "index", "value"] },
  length: { label: "Length", group: "Array", args: ["array"] },
  array_contains: { label: "Array contains", group: "Array", args: ["array", "value"] },
  array_not_contains: { label: "Array does not contain", group: "Array", args: ["array", "value"] },
  subset_of: { label: "Is subset of", group: "Array", args: ["array", "of"] },
  extract_field: { label: "Extract struct field", group: "Struct", args: ["struct"], opts: [{ key: "field", label: "Field" }] },
  make_struct: { label: "Make struct", group: "Struct", args: ["value…"], opts: [{ key: "fields", label: "Field names (comma-separated)" }] },
};

const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const day = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const round = (x: number, p: unknown, f: (n: number) => number) => {
  const k = 10 ** (Number(p) || 0);
  return f(x * k) / k;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v]);

/** Run the steps; the last step's result is the variable's value. Errors name the step. */
export function evalTransform(steps: TStep[], vars: Record<string, unknown>): unknown {
  const out: unknown[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const get = (a: TArg | undefined): unknown => (!a ? undefined : a.var ? vars[a.var] : a.step !== undefined ? out[a.step] : a.value);
    const v = s.args.map(get);
    const [a, b, c] = v;
    const o = s.opts ?? {};
    let r: unknown;
    switch (s.op) {
      case "concat":
        r = v.map((x) => (Array.isArray(x) ? x.join(String(o.separator ?? ", ")) : x === null || x === undefined ? "" : String(x))).join(o.separator !== undefined && v.length > 1 && !v.some(Array.isArray) ? String(o.separator) : "");
        break;
      case "if_else":
        r = a ? b : c;
        break;
      case "to_number":
        r = Number.isNaN(num(a)) ? null : num(a);
        break;
      case "to_date": {
        const d = day(a);
        r = d ? iso(d) : null;
        break;
      }
      case "to_string":
        r = a === null || a === undefined ? "" : typeof a === "object" ? JSON.stringify(a) : String(a);
        break;
      case "add":
        r = v.reduce((t: number, x) => t + (Number.isNaN(num(x)) ? 0 : num(x)), 0);
        break;
      case "subtract":
        r = num(a) - num(b);
        break;
      case "multiply":
        r = v.reduce((t: number, x) => t * num(x), 1);
        break;
      case "divide":
        r = num(b) === 0 ? null : num(a) / num(b);
        break;
      case "abs":
        r = Math.abs(num(a));
        break;
      case "negate":
        r = -num(a);
        break;
      case "ceil":
        r = round(num(a), o.precision, Math.ceil);
        break;
      case "floor":
        r = round(num(a), o.precision, Math.floor);
        break;
      case "round":
        r = round(num(a), o.precision, Math.round);
        break;
      case "max":
      case "min": {
        const xs = v.flatMap(arr).filter((x) => x !== null && x !== undefined && x !== "");
        const dates = xs.every((x) => typeof x === "string" && day(x));
        if (!xs.length) r = null;
        else if (dates) r = xs.reduce((m, x) => ((s.op === "max" ? String(x) > String(m) : String(x) < String(m)) ? x : m));
        else r = (s.op === "max" ? Math.max : Math.min)(...xs.map(num));
        break;
      }
      case "relative_date": {
        const d = day(a);
        if (!d) {
          r = null;
          break;
        }
        const n = num(b) || 0;
        const unit = String(o.unit ?? "days");
        if (unit === "days") d.setDate(d.getDate() + n);
        else if (unit === "weeks") d.setDate(d.getDate() + 7 * n);
        else if (unit === "months") d.setMonth(d.getMonth() + n);
        else d.setFullYear(d.getFullYear() + n);
        r = iso(d);
        break;
      }
      case "between_dates": {
        const x = day(a);
        const y = day(b);
        if (!x || !y) {
          r = null;
          break;
        }
        const days = (y.getTime() - x.getTime()) / 86400000;
        const unit = String(o.unit ?? "days");
        r = Math.trunc(unit === "weeks" ? days / 7 : unit === "months" ? (y.getFullYear() - x.getFullYear()) * 12 + y.getMonth() - x.getMonth() : unit === "years" ? y.getFullYear() - x.getFullYear() : days);
        break;
      }
      case "current_date":
        r = iso(new Date());
        break;
      case "current_time":
        r = new Date().toISOString();
        break;
      case "date_on_or_after":
      case "date_after":
      case "date_on_or_before":
      case "date_before":
      case "date_equal": {
        const x = day(a)?.getTime();
        const y = day(b)?.getTime();
        r = x === undefined || y === undefined ? null : { date_on_or_after: x >= y, date_after: x > y, date_on_or_before: x <= y, date_before: x < y, date_equal: x === y }[s.op];
        break;
      }
      case "eq":
        r = num(a) === num(b);
        break;
      case "neq":
        r = num(a) !== num(b);
        break;
      case "lt":
        r = num(a) < num(b);
        break;
      case "lte":
        r = num(a) <= num(b);
        break;
      case "gt":
        r = num(a) > num(b);
        break;
      case "gte":
        r = num(a) >= num(b);
        break;
      case "str_is":
        r = String(a ?? "") === String(b ?? "");
        break;
      case "str_is_not":
        r = String(a ?? "") !== String(b ?? "");
        break;
      case "contains":
        r = String(a ?? "").includes(String(b ?? ""));
        break;
      case "not_contains":
        r = !String(a ?? "").includes(String(b ?? ""));
        break;
      case "starts_with":
        r = String(a ?? "").startsWith(String(b ?? ""));
        break;
      case "ends_with":
        r = String(a ?? "").endsWith(String(b ?? ""));
        break;
      case "is_true":
        r = a === true || a === "true";
        break;
      case "is_false":
        r = !(a === true || a === "true");
        break;
      case "and":
        r = v.every(Boolean);
        break;
      case "or":
        r = v.some(Boolean);
        break;
      case "is_null":
        r = a === null || a === undefined || a === "" || (Array.isArray(a) && !a.length);
        break;
      case "not_null":
        r = !(a === null || a === undefined || a === "" || (Array.isArray(a) && !a.length));
        break;
      case "compose":
        r = v.flatMap(arr);
        break;
      case "intersection": {
        const [first, ...rest] = v.map(arr);
        r = (first ?? []).filter((x) => rest.every((y) => y.some((z) => String(z) === String(x))));
        break;
      }
      case "get_at":
        r = arr(a)[num(b)] ?? null;
        break;
      case "update_at": {
        const xs = [...arr(a)];
        xs[num(b)] = c;
        r = xs;
        break;
      }
      case "length":
        r = arr(a).length;
        break;
      case "array_contains":
        r = arr(b).every((x) => arr(a).some((y) => String(y) === String(x)));
        break;
      case "array_not_contains":
        r = arr(b).every((x) => !arr(a).some((y) => String(y) === String(x)));
        break;
      case "subset_of":
        r = arr(a).every((x) => arr(b).some((y) => String(y) === String(x)));
        break;
      case "extract_field":
        r = a && typeof a === "object" ? (a as Record<string, unknown>)[String(o.field ?? "")] ?? null : null;
        break;
      case "make_struct": {
        const names = String(o.fields ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        r = Object.fromEntries(names.map((n, j) => [n, v[j] ?? null]));
        break;
      }
      default:
        throw new Error(`step ${i + 1}: unknown operation ${s.op}`);
    }
    if (typeof r === "number" && Number.isNaN(r)) r = null;
    out.push(r);
  }
  return out.length ? out[out.length - 1] : undefined;
}

/** The variables a definition reads (for recomputing and the lineage view). */
export function transformInputs(steps: TStep[]): string[] {
  return [...new Set(steps.flatMap((s) => s.args.map((a) => a.var).filter((x): x is string => !!x)))];
}
