/**
 * Evaluators of the LLM evaluation suite: each compares a Use LLM node's actual output with expected
 * values (or checks it on its own) and returns pass / fail with a reason. LLM-as-a-judge asks a model
 * whether a stated condition holds for the value.
 */
import type { Cell, Evaluator, EvaluatorKind, Row } from "./pipeline";
import { aiText } from "./services";

export const EVALUATOR_INFO: Record<EvaluatorKind, { label: string; hint: string; expected: boolean; configurable?: boolean }> = {
  exactString: { label: "Exact string match", hint: "The actual string exactly matches the expected string (case-sensitive, whitespace included by default).", expected: true, configurable: true },
  integerRange: { label: "Integer range", hint: "The actual value lies within a range of integers.", expected: false },
  exactNumeric: { label: "Exact numeric match", hint: "Two numbers are exactly equal (integer, long, float, double, short).", expected: true },
  exactStringArray: { label: "Exact string array match", hint: "Two string arrays hold the same elements (order-dependent, case-sensitive by default).", expected: true, configurable: true },
  exactNumericArray: { label: "Exact numeric array match", hint: "Two numeric arrays hold the same elements (order-dependent by default).", expected: true, configurable: true },
  exactTemporal: { label: "Exact temporal match", hint: "Two dates or timestamps are exactly equal.", expected: true },
  genericExact: { label: "Generic exact match", hint: "Identical values; numbers and date / timestamp types are coerced, structs and maps compared by unordered keys, lists by order.", expected: true },
  floatRange: { label: "Floating-point range", hint: "The actual value lies within a numeric range.", expected: false },
  temporalRange: { label: "Temporal range", hint: "The actual date or timestamp lies within a range.", expected: false },
  levenshtein: { label: "Levenshtein distance", hint: "At most N single-character edits from the expected string.", expected: true },
  stringLength: { label: "String length", hint: "The length of the actual string lies within a range.", expected: false },
  keywords: { label: "Keyword checker", hint: "Specific keywords are present in the actual text.", expected: false },
  regex: { label: "Regex match", hint: "The actual string matches a regular expression.", expected: false },
  llmJudge: { label: "LLM-as-a-judge", hint: "An LLM decides whether a condition you state holds for the value (not for references such as objects or models).", expected: false },
};

const norm = (s: string, e: Evaluator) => {
  let x = s;
  if (e.trimWhitespace) x = x.trim().replace(/\s+/g, " ");
  if (e.matchCase === false) x = x.toLowerCase();
  return x;
};
const asArray = (v: Cell): unknown[] | null => {
  if (v === null) return null;
  if (Array.isArray(v)) return v;
  try {
    const p = JSON.parse(String(v));
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
};
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const time = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
};
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = num(a);
  const nb = num(b);
  if (typeof a !== "object" && typeof b !== "object" && na !== null && nb !== null) return na === nb;
  const ta = time(a);
  const tb = time(b);
  if (typeof a === "string" && typeof b === "string" && ta !== null && tb !== null && /\d{4}-\d{2}-\d{2}/.test(a) && /\d{4}-\d{2}-\d{2}/.test(b)) return ta === tb;
  if (typeof a === "string" && /^[[{]/.test(a.trim())) {
    try {
      return deepEqual(JSON.parse(a), b);
    } catch {}
  }
  if (typeof b === "string" && /^[[{]/.test(b.trim())) {
    try {
      return deepEqual(a, JSON.parse(b));
    } catch {}
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export type EvalOutcome = { pass: boolean; reason: string };

/** One evaluator on one row (LLM-as-a-judge is async). */
export async function evaluate(e: Evaluator, actual: Cell, row: Row): Promise<EvalOutcome> {
  const expected = e.expected ? (row[e.expected] ?? null) : null;
  const lo = e.min !== undefined && e.min !== "" ? e.min : undefined;
  const hi = e.max !== undefined && e.max !== "" ? e.max : undefined;
  let r: EvalOutcome;
  switch (e.kind) {
    case "exactString": {
      const ok = actual !== null && expected !== null && norm(String(actual), e) === norm(String(expected), e);
      r = { pass: ok, reason: ok ? "matches" : `"${actual}" ≠ "${expected}"` };
      break;
    }
    case "exactNumeric": {
      const ok = num(actual) !== null && num(actual) === num(expected);
      r = { pass: ok, reason: ok ? "equal" : `${actual} ≠ ${expected}` };
      break;
    }
    case "integerRange":
    case "floatRange": {
      const v = num(actual);
      const integer = e.kind === "integerRange";
      const ok = v !== null && (!integer || Number.isInteger(v)) && (lo === undefined || v >= Number(lo)) && (hi === undefined || v <= Number(hi));
      r = { pass: ok, reason: ok ? "in range" : `${actual} not in [${lo ?? "−∞"}, ${hi ?? "∞"}]${integer && v !== null && !Number.isInteger(v) ? " (not an integer)" : ""}` };
      break;
    }
    case "exactTemporal": {
      const ok = time(actual) !== null && time(actual) === time(expected);
      r = { pass: ok, reason: ok ? "equal" : `${actual} ≠ ${expected}` };
      break;
    }
    case "temporalRange": {
      const t = time(actual);
      const ok = t !== null && (lo === undefined || t >= time(lo)!) && (hi === undefined || t <= time(hi)!);
      r = { pass: ok, reason: ok ? "in range" : `${actual} not between ${lo ?? "…"} and ${hi ?? "…"}` };
      break;
    }
    case "exactStringArray":
    case "exactNumericArray": {
      const a = asArray(actual);
      const b = asArray(expected);
      if (!a || !b) {
        r = { pass: false, reason: "not an array" };
        break;
      }
      const map = (x: unknown) => (e.kind === "exactNumericArray" ? String(num(x)) : norm(String(x), e));
      let aa = a.map(map);
      let bb = b.map(map);
      if (e.orderMatters === false) {
        aa = [...aa].sort();
        bb = [...bb].sort();
      }
      const ok = aa.length === bb.length && aa.every((x, i) => x === bb[i]);
      r = { pass: ok, reason: ok ? "same elements" : `[${aa.join(", ")}] ≠ [${bb.join(", ")}]` };
      break;
    }
    case "genericExact": {
      const ok = deepEqual(actual, expected);
      r = { pass: ok, reason: ok ? "identical" : "different" };
      break;
    }
    case "levenshtein": {
      const d = lev(String(actual ?? ""), String(expected ?? ""));
      const ok = d <= (e.threshold ?? 0);
      r = { pass: ok, reason: `distance ${d}${ok ? "" : ` > ${e.threshold ?? 0}`}` };
      break;
    }
    case "stringLength": {
      const n = actual === null ? 0 : String(actual).length;
      const ok = (lo === undefined || n >= Number(lo)) && (hi === undefined || n <= Number(hi));
      r = { pass: ok, reason: `length ${n}` };
      break;
    }
    case "keywords": {
      const text = norm(String(actual ?? ""), { ...e, trimWhitespace: false });
      const missing = (e.keywords ?? []).filter((k) => !text.includes(norm(k, { ...e, trimWhitespace: false })));
      r = { pass: !missing.length, reason: missing.length ? `missing ${missing.join(", ")}` : "all keywords present" };
      break;
    }
    case "regex": {
      let ok = false;
      try {
        ok = actual !== null && new RegExp(e.pattern ?? "").test(String(actual));
      } catch {
        return { pass: false, reason: "invalid regular expression" };
      }
      r = { pass: ok, reason: ok ? "matches" : "no match" };
      break;
    }
    case "llmJudge": {
      if (!e.condition?.trim()) return { pass: false, reason: "write the condition" };
      try {
        const v = await aiText<{ holds: boolean; reason: string }>(`Condition: ${e.condition}\n\nValue:\n${typeof actual === "string" ? actual : JSON.stringify(actual)}`, {
          system: "You are an evaluator. Decide strictly whether the condition holds for the value. Answer with holds (true/false) and a one-sentence reason.",
          schema: { type: "object", properties: { holds: { type: "boolean" }, reason: { type: "string" } }, required: ["holds", "reason"] },
          model: e.model,
          temperature: 0,
        });
        r = { pass: !!v.holds, reason: v.reason };
      } catch (err) {
        return { pass: false, reason: `judge failed: ${(err as Error).message}` };
      }
      break;
    }
  }
  return e.passing === "no match" ? { pass: !r.pass, reason: `${r.reason} (passing when it does not match)` } : r;
}
