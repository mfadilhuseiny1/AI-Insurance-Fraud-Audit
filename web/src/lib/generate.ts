/**
 * Generate notional data for manually entered tables: one generator per column (city, company, email,
 * names, weighted lists, templates, US states and ZIP codes, UUIDs, foreign keys into another node, …),
 * or an LLM prompt that can reference other columns as /column. Seeded, so the same settings give the
 * same rows; locked columns keep their values when the table is generated again.
 */
import { aiText } from "./services";
import type { Cell, ColType, Column, ColumnGenerator, GeneratorConfig, GeneratorKind, Row, Table } from "./pipeline";

const FIRST = ["Aisha", "Budi", "Carlos", "Dewi", "Elena", "Farhan", "Grace", "Hiro", "Indah", "James", "Kenji", "Lina", "Mateo", "Nadia", "Omar", "Priya", "Quinn", "Rizky", "Sofia", "Tomas", "Uma", "Victor", "Wulan", "Xavier", "Yusuf", "Zara", "Ahmad", "Bella", "Chen", "Dimas"];
const LAST = ["Anderson", "Basri", "Chen", "Dharma", "Evans", "Fernandez", "Gunawan", "Harris", "Ibrahim", "Johnson", "Kusuma", "Lopez", "Martin", "Nguyen", "Okafor", "Pratama", "Quintero", "Rossi", "Santoso", "Tanaka", "Utomo", "Vargas", "Wijaya", "Xu", "Yamamoto", "Zhang"];
const CITIES = ["Jakarta", "Surabaya", "Bandung", "Medan", "Denpasar", "Singapore", "Kuala Lumpur", "Bangkok", "Tokyo", "Seoul", "Sydney", "London", "Paris", "Berlin", "New York", "Chicago", "Toronto", "São Paulo", "Nairobi", "Dubai"];
const COMPANY_A = ["Nusantara", "Blue", "Summit", "Pacific", "Golden", "Prime", "Vertex", "Harbor", "Evergreen", "Quantum", "Atlas", "Coral", "Silver", "Northwind", "Sunrise"];
const COMPANY_B = ["Logistics", "Foods", "Energy", "Analytics", "Holdings", "Textiles", "Robotics", "Fisheries", "Pharma", "Mining", "Retail", "Systems", "Farms", "Shipping", "Labs"];
const COMPANY_C = ["Inc.", "Ltd.", "Group", "Co.", "PT", "LLC", "Corp."];
const STREETS = ["Main", "Oak", "Maple", "Cedar", "Pine", "Elm", "Sudirman", "Thamrin", "Gatot Subroto", "Lake", "Hill", "Park", "Sunset", "River", "Harbor"];
const STREET_TYPES = ["St", "Ave", "Rd", "Blvd", "Ln", "Way", "Dr"];
const COUNTRIES = ["ID", "SG", "MY", "TH", "JP", "KR", "AU", "GB", "FR", "DE", "US", "CA", "BR", "KE", "AE", "IN", "CN", "VN", "PH", "NL"];
const DOMAINS = ["example.com", "mail.test", "corp.example", "inbox.test"];
/** state, code, ZIP prefix range */
export const US_STATES: [string, string, number, number][] = [
  ["Alabama", "AL", 350, 369], ["Alaska", "AK", 995, 999], ["Arizona", "AZ", 850, 865], ["Arkansas", "AR", 716, 729], ["California", "CA", 900, 961],
  ["Colorado", "CO", 800, 816], ["Connecticut", "CT", 60, 69], ["Delaware", "DE", 197, 199], ["Florida", "FL", 320, 349], ["Georgia", "GA", 300, 319],
  ["Hawaii", "HI", 967, 968], ["Idaho", "ID", 832, 838], ["Illinois", "IL", 600, 629], ["Indiana", "IN", 460, 479], ["Iowa", "IA", 500, 528],
  ["Kansas", "KS", 660, 679], ["Kentucky", "KY", 400, 427], ["Louisiana", "LA", 700, 714], ["Maine", "ME", 39, 49], ["Maryland", "MD", 206, 219],
  ["Massachusetts", "MA", 10, 27], ["Michigan", "MI", 480, 499], ["Minnesota", "MN", 550, 567], ["Mississippi", "MS", 386, 397], ["Missouri", "MO", 630, 658],
  ["Montana", "MT", 590, 599], ["Nebraska", "NE", 680, 693], ["Nevada", "NV", 889, 898], ["New Hampshire", "NH", 30, 38], ["New Jersey", "NJ", 70, 89],
  ["New Mexico", "NM", 870, 884], ["New York", "NY", 100, 149], ["North Carolina", "NC", 270, 289], ["North Dakota", "ND", 580, 588], ["Ohio", "OH", 430, 459],
  ["Oklahoma", "OK", 730, 749], ["Oregon", "OR", 970, 979], ["Pennsylvania", "PA", 150, 196], ["Rhode Island", "RI", 28, 29], ["South Carolina", "SC", 290, 299],
  ["South Dakota", "SD", 570, 577], ["Tennessee", "TN", 370, 385], ["Texas", "TX", 750, 799], ["Utah", "UT", 840, 847], ["Vermont", "VT", 50, 59],
  ["Virginia", "VA", 220, 246], ["Washington", "WA", 980, 994], ["West Virginia", "WV", 247, 268], ["Wisconsin", "WI", 530, 549], ["Wyoming", "WY", 820, 831],
];

export const GENERATOR_INFO: Record<GeneratorKind, { hint: string; type: ColType }> = {
  City: { hint: "A random city name", type: "String" },
  Company: { hint: "A fictional company name", type: "String" },
  Constant: { hint: "Always the same value", type: "String" },
  "Country code": { hint: "A two-letter country code", type: "String" },
  Email: { hint: "A valid but notional email address", type: "String" },
  "First name": { hint: "A notional first name", type: "String" },
  "Foreign key": { hint: "A value of a column of another node (links the tables)", type: "String" },
  "Full name": { hint: "First and last name", type: "String" },
  "Last name": { hint: "A notional last name", type: "String" },
  List: { hint: "A weighted random value from your list", type: "String" },
  Null: { hint: "Always null", type: "String" },
  "One of": { hint: "Picks one of several generators, by weight", type: "String" },
  "Street address": { hint: "A random street address", type: "String" },
  Template: { hint: "Text from a template: {{firstName}} {{lastName}} {{int 1 100}} {{pick a|b|c}} {{city}} {{uuid}} {{row}}", type: "String" },
  "US state": { hint: "A US state name", type: "String" },
  "US state code": { hint: "A two-letter US state code", type: "String" },
  "US ZIP code": { hint: "A ZIP code located in the given state", type: "String" },
  UUID: { hint: "A universally unique identifier", type: "String" },
  Integer: { hint: "A whole number between min and max", type: "Integer" },
  Decimal: { hint: "A number between min and max (2 decimals)", type: "Double" },
  Date: { hint: "A date between min and max years", type: "Date" },
  Boolean: { hint: "true or false", type: "Boolean" },
  "Generate with LLM": { hint: "An LLM writes values from your description (reference other columns as /column)", type: "String" },
};

/** Deterministic random numbers in [0, 1). */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
function weighted<T extends { weight: number }>(r: () => number, xs: T[]): T | undefined {
  const total = xs.reduce((s, x) => s + Math.max(0, x.weight || 0), 0);
  if (!total) return xs[0];
  let v = r() * total;
  for (const x of xs) {
    v -= Math.max(0, x.weight || 0);
    if (v <= 0) return x;
  }
  return xs[xs.length - 1];
}
const uuid = (r: () => number) =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const v = Math.floor(r() * 16);
    return (c === "x" ? v : (v & 0x3) | 0x8).toString(16);
  });

function template(r: () => number, text: string, row: number): string {
  return text.replace(/\{\{\s*(\w+)([^}]*)\}\}/g, (m, fn: string, rest: string) => {
    const args = rest.trim().split(/\s+/).filter(Boolean);
    switch (fn) {
      case "firstName":
        return pick(r, FIRST);
      case "lastName":
        return pick(r, LAST);
      case "city":
        return pick(r, CITIES);
      case "company":
        return `${pick(r, COMPANY_A)} ${pick(r, COMPANY_B)}`;
      case "uuid":
        return uuid(r);
      case "row":
        return String(row + 1);
      case "int": {
        const [lo, hi] = [Number(args[0] ?? 0), Number(args[1] ?? 100)];
        return String(lo + Math.floor(r() * (hi - lo + 1)));
      }
      case "pick":
        return pick(r, args.join(" ").split("|"));
      case "letter":
        return String.fromCharCode(65 + Math.floor(r() * 26));
      case "digit":
        return String(Math.floor(r() * 10));
      default:
        return m;
    }
  });
}

export const EXAMPLES: Partial<Record<GeneratorKind, string[]>> = {
  City: ["Bandung", "Tokyo", "Nairobi"],
  Company: ["Summit Fisheries PT", "Blue Analytics Ltd."],
  "Country code": ["ID", "JP", "KE"],
  Email: ["dewi.santoso@example.com", "omar.lopez42@mail.test"],
  "First name": ["Aisha", "Kenji", "Sofia"],
  "Full name": ["Priya Gunawan", "Mateo Rossi"],
  "Last name": ["Wijaya", "Nguyen"],
  "Street address": ["128 Cedar Ave", "57 Sudirman Rd"],
  "US state": ["Oregon", "Texas"],
  "US state code": ["OR", "TX"],
  "US ZIP code": ["97214", "75201"],
  UUID: ["0b8e4c4e-3f8d-4b2a-9e1d-5a6f7c8d9e0f"],
  Template: ["INV-{{int 1000 9999}}-{{letter}}", "{{firstName}}.{{lastName}}"],
};

/** One value of a (non-LLM) generator. `foreign` holds the values a foreign key picks from. */
function value(g: ColumnGenerator | { kind: GeneratorKind; value?: string; options?: ColumnGenerator["options"]; state?: string; min?: number; max?: number }, r: () => number, row: number, foreign?: Cell[]): Cell {
  switch (g.kind) {
    case "City":
      return pick(r, CITIES);
    case "Company":
      return `${pick(r, COMPANY_A)} ${pick(r, COMPANY_B)} ${pick(r, COMPANY_C)}`;
    case "Constant":
      return g.value ?? "";
    case "Country code":
      return pick(r, COUNTRIES);
    case "Email": {
      const f = pick(r, FIRST).toLowerCase();
      const l = pick(r, LAST).toLowerCase();
      return `${f}.${l}${r() < 0.4 ? Math.floor(r() * 100) : ""}@${pick(r, DOMAINS)}`;
    }
    case "First name":
      return pick(r, FIRST);
    case "Last name":
      return pick(r, LAST);
    case "Full name":
      return `${pick(r, FIRST)} ${pick(r, LAST)}`;
    case "Foreign key":
      return foreign?.length ? (foreign[Math.floor(r() * foreign.length)] ?? null) : null;
    case "List":
      return weighted(r, (g.options ?? []).filter((o) => o.value !== ""))?.value ?? null;
    case "Null":
      return null;
    case "Street address":
      return `${1 + Math.floor(r() * 999)} ${pick(r, STREETS)} ${pick(r, STREET_TYPES)}`;
    case "Template":
      return template(r, g.value ?? "", row);
    case "US state":
      return pick(r, US_STATES)[0];
    case "US state code":
      return pick(r, US_STATES)[1];
    case "US ZIP code": {
      const st = US_STATES.find((s) => s[0] === g.state || s[1] === g.state) ?? pick(r, US_STATES);
      const prefix = st[2] + Math.floor(r() * (st[3] - st[2] + 1));
      return String(prefix).padStart(3, "0") + String(Math.floor(r() * 100)).padStart(2, "0");
    }
    case "UUID":
      return uuid(r);
    case "Integer": {
      const lo = Math.ceil(g.min ?? 0);
      const hi = Math.floor(g.max ?? 1000);
      return lo + Math.floor(r() * (hi - lo + 1));
    }
    case "Decimal": {
      const lo = g.min ?? 0;
      const hi = g.max ?? 1000;
      return Math.round((lo + r() * (hi - lo)) * 100) / 100;
    }
    case "Date": {
      const lo = Date.UTC(g.min ?? 2015, 0, 1);
      const hi = Date.UTC((g.max ?? 2025) + 1, 0, 1);
      return new Date(lo + Math.floor(r() * (hi - lo))).toISOString().slice(0, 10);
    }
    case "Boolean":
      return r() < 0.5;
    default:
      return null;
  }
}

export const generatorType = (g: ColumnGenerator): ColType => GENERATOR_INFO[g.kind]?.type ?? "String";

/** The table the generators make (LLM columns are filled separately by fillLlmColumns). */
export function generateTable(cfg: GeneratorConfig, previous: Table | null, foreign: (g: ColumnGenerator) => Cell[] | undefined): Table {
  const rows = Math.max(1, Math.min(1000, Math.trunc(cfg.rows)));
  const seed = cfg.seed ?? 1;
  const columns: Column[] = cfg.columns.map((g) => ({ name: g.column, type: g.locked && previous?.columns.find((c) => c.name === g.column)?.type ? previous.columns.find((c) => c.name === g.column)!.type : generatorType(g) }));
  const out: Row[] = Array.from({ length: rows }, () => ({}));
  cfg.columns.forEach((g, ci) => {
    if (g.locked && previous?.columns.some((c) => c.name === g.column)) {
      out.forEach((row, i) => (row[g.column] = previous.rows[i]?.[g.column] ?? null));
      return;
    }
    const r = rng(seed * 1009 + ci * 7919);
    const keys = g.kind === "Foreign key" ? foreign(g) : undefined;
    out.forEach((row, i) => {
      if (g.kind === "Generate with LLM") row[g.column] = previous?.rows[i]?.[g.column] ?? null;
      else if (g.kind === "One of") {
        const choice = weighted(r, g.choices ?? []);
        row[g.column] = choice ? value({ kind: choice.kind, value: choice.value }, r, i) : null;
      } else row[g.column] = value(g, r, i, keys);
    });
  });
  return { columns, rows: out };
}

/** Fills the LLM-generated columns of a table, `limit` rows at most (previews use 10). */
export async function fillLlmColumns(t: Table, cfg: GeneratorConfig, limit = t.rows.length, onProgress?: (done: number) => void): Promise<Table> {
  const rows = t.rows.map((r) => ({ ...r }));
  const llm = cfg.columns.filter((g) => g.kind === "Generate with LLM" && !g.locked);
  let done = 0;
  for (const g of llm) {
    const refs = [...(g.value ?? "").matchAll(/\/([\w.-]+)/g)].map((m) => m[1]).filter((c) => t.columns.some((x) => x.name === c));
    for (let start = 0; start < Math.min(limit, rows.length); start += 50) {
      const batch = rows.slice(start, Math.min(start + 50, limit));
      const context = refs.length ? batch.map((r, i) => `${i + 1}. ${refs.map((c) => `${c}=${r[c] ?? "null"}`).join(", ")}`).join("\n") : "";
      const values = await aiText<string[]>(
        `Generate ${batch.length} realistic but fictional values for a column "${g.column}".\nDescription: ${g.value ?? ""}${g.example ? `\nExample value: ${g.example}` : ""}${
          context ? `\nEach value must fit its row:\n${context}` : ""
        }\nReturn exactly ${batch.length} values in order.`,
        { system: "You generate notional test data. Never use real people's personal data.", schema: { type: "array", items: { type: "string" } }, temperature: 0.9 },
      );
      batch.forEach((r, i) => (r[g.column] = values[i] ?? null));
      done += batch.length;
      onProgress?.(done);
    }
  }
  return { ...t, rows };
}
