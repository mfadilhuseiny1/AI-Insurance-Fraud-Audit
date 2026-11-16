/**
 * Property value formatting (Ontology Manager → property → Value formatting) and conditional formatting rules,
 * applied wherever objects are shown: Ontology Manager, Object Explorer, Object Views and Workshop.
 */
import type { CondRule, Property, ValueFormatting } from "./ontology";

const NUMERIC = new Set(["integer", "long", "short", "byte", "double", "float", "decimal"]);

function relative(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (Math.abs(s) >= 86400) return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(s) < 60) return rtf.format(-s, "second");
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), "minute");
  return rtf.format(-Math.round(s / 3600), "hour");
}

export function formatNumber(n: number, f: Extract<ValueFormatting, { kind: "number" }>): string {
  const opts: Intl.NumberFormatOptions = { useGrouping: f.grouping ?? true };
  if (f.notation && f.notation !== "standard") opts.notation = f.notation;
  if (f.max_fraction != null) opts.maximumFractionDigits = f.max_fraction;
  if (f.min_fraction != null) opts.minimumFractionDigits = Math.min(f.min_fraction, f.max_fraction ?? 20);
  if (f.max_significant != null) opts.maximumSignificantDigits = Math.max(1, f.max_significant);
  if (f.min_integer != null) opts.minimumIntegerDigits = Math.max(1, f.min_integer);
  if (f.style === "currency") {
    opts.style = "currency";
    opts.currency = f.currency || "USD";
  } else if (f.style === "percent") opts.style = "percent";
  let text: string;
  try {
    text = new Intl.NumberFormat(undefined, opts).format(n);
  } catch {
    text = String(n);
  }
  if (f.style === "unit" && f.unit) text = `${text} ${f.unit}`;
  if (f.style === "affix") text = `${f.prefix ?? ""}${text}${f.suffix ?? ""}`;
  return text;
}

export function formatDate(v: string, f: Extract<ValueFormatting, { kind: "date" }>, dateOnly: boolean): string {
  const d = new Date(dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  const tz = f.time_zone && !dateOnly ? { timeZone: f.time_zone } : {};
  try {
    switch (f.format) {
      case "date":
        return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", ...tz });
      case "datetime":
        return d.toLocaleString(undefined, { weekday: "short", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", ...tz });
      case "datetime_short":
        return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...tz });
      case "iso":
        return d.toISOString();
      case "relative":
        return relative(d);
      case "time":
        return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...tz });
    }
  } catch {
    return v;
  }
  return v;
}

/** A property value as text, with its value formatting. Null when the value is empty. */
export function formatProperty(p: Pick<Property, "type" | "value_formatting" | "render_hints" | "array" | "struct_fields">, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return v.map((x) => formatProperty({ ...p, array: false }, x) ?? "—").join(", ");
  if (p.type === "struct" && typeof v === "object") {
    const fields = p.struct_fields ?? [];
    const main = fields.filter((f) => f.main);
    const rec = v as Record<string, unknown>;
    const shown = (main.length ? main : fields).map((f) => rec[f.api_name]).filter((x) => x !== null && x !== undefined);
    return shown.length ? shown.join(" · ") : JSON.stringify(v);
  }
  if (p.type === "cipher") return "•••••• (cipher text)";
  if (p.type === "geoshape" && typeof v === "object") return `${(v as { type?: string }).type ?? "Geometry"}`;
  if (p.type === "vector" && Array.isArray(v)) return `Vector(${(v as unknown[]).length})`;
  const f = p.value_formatting;
  const noFormat = p.render_hints?.includes("disable_formatting") || p.render_hints?.includes("identifier");
  if (f?.kind === "number" && NUMERIC.has(p.type)) {
    const n = Number(v);
    if (!Number.isNaN(n)) return formatNumber(n, f);
  }
  if (f?.kind === "date" && (p.type === "date" || p.type === "timestamp")) return formatDate(String(v), f, p.type === "date");
  if (NUMERIC.has(p.type) && !noFormat && typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function num(v: unknown): number | null {
  if (typeof v === "boolean" || v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function test(rule: CondRule, props: Record<string, unknown>, own: string): boolean {
  const w = rule.when;
  if (w.kind === "always") return true;
  if (w.kind === "math") {
    const expr = (w.expression ?? "").replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name) => String(num(props[name]) ?? "NaN"));
    if (!/^[\d\s.+\-*/()<>=!&|NaN]*$/.test(expr)) return false;
    try {
      return !!Function(`"use strict";return (${expr});`)();
    } catch {
      return false;
    }
  }
  const v = props[w.property || own];
  const other = w.value_property ? props[w.value_property] : w.value;
  let hit: boolean;
  switch (w.op) {
    case "is_null":
      hit = v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
      break;
    case "contains":
      hit = String(v ?? "").toLowerCase().includes(String(other ?? "").toLowerCase());
      break;
    case "starts_with":
      hit = String(v ?? "").toLowerCase().startsWith(String(other ?? "").toLowerCase());
      break;
    case "ends_with":
      hit = String(v ?? "").toLowerCase().endsWith(String(other ?? "").toLowerCase());
      break;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = num(v);
      const b = num(other);
      hit = a !== null && b !== null && (w.op === "gt" ? a > b : w.op === "gte" ? a >= b : w.op === "lt" ? a < b : a <= b);
      break;
    }
    case "between": {
      const a = num(v);
      const lo = num(other);
      const hi = num(w.value2);
      hit = a !== null && (lo === null || a >= lo) && (hi === null || a <= hi);
      break;
    }
    default:
      hit = String(v ?? "").toLowerCase() === String(other ?? "").toLowerCase();
  }
  return w.negate ? !hit : hit;
}

/** The style of the first conditional formatting rule that matches the object. */
export function conditionalStyle(p: Pick<Property, "api_name" | "conditional_formatting">, props: Record<string, unknown>): CondRule["style"] | null {
  for (const r of p.conditional_formatting ?? []) if (test(r, props, p.api_name)) return r.style;
  return null;
}

export const INTENT_COLORS: { label: string; color: string; background: string }[] = [
  { label: "Success", color: "#3ddc97", background: "rgba(61,220,151,0.15)" },
  { label: "Warning", color: "#f5b942", background: "rgba(245,185,66,0.15)" },
  { label: "Danger", color: "#ff6b6b", background: "rgba(255,107,107,0.15)" },
  { label: "Primary", color: "#4da3ff", background: "rgba(77,163,255,0.15)" },
  { label: "Neutral", color: "#a0aec0", background: "rgba(160,174,192,0.15)" },
];
