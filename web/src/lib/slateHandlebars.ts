/** Slate's Handlebars: {{path}}, {{helper a "b" 3}}, sub-expressions, {{#if}} / {{#unless}} / {{#each}} / {{#with}} /
 *  {{#jsonStringify}} blocks with {{else}}, {{!comments}} and {{{raw}}}; the core, widget, Foundry and SQL helpers
 *  of the Slate docs. Three modes:
 *  - "value": a template that is exactly one {{expression}} gives its value (an array stays an array), else text;
 *  - "text": the rendered string (objects as JSON);
 *  - "js": functions and events — every {{expression}} becomes its JSON value, helpers are not accepted;
 *  - "sql": like text, but helpers are param / column / table / schema / alias and other values must go through them. */

export type Scope = Record<string, unknown>;
export type Mode = "value" | "text" | "js" | "sql";

type Node =
  | { t: "text"; v: string }
  | { t: "expr"; e: Expr; raw: boolean; src: string }
  | { t: "block"; name: string; args: Expr[]; body: Node[]; inverse: Node[]; src: string };
type Expr = { k: "path"; parts: string[] } | { k: "lit"; v: unknown } | { k: "call"; name: string; args: Expr[]; hash: Record<string, Expr> };

const cache = new Map<string, Node[]>();

export class TemplateError extends Error {}

function tokenizeExpr(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\" && j + 1 < s.length) j++;
        v += s[j++];
      }
      out.push(JSON.stringify(v));
      i = j + 1;
    } else if (c === "(" || c === ")") {
      out.push(c);
      i++;
    } else {
      let j = i;
      let depth = 0;
      while (j < s.length && (depth > 0 || !/[\s()]/.test(s[j]))) {
        if (s[j] === "[") depth++;
        if (s[j] === "]") depth--;
        j++;
      }
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

function parsePath(tok: string): Expr {
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { k: "lit", v: Number(tok) };
  if (tok === "true" || tok === "false") return { k: "lit", v: tok === "true" };
  if (tok === "null" || tok === "undefined") return { k: "lit", v: null };
  if (tok.startsWith('"')) return { k: "lit", v: JSON.parse(tok) };
  const parts: string[] = [];
  const re = /([^.[\]]+)|\[(\d+|"[^"]*"|'[^']*')\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tok))) parts.push(m[1] ?? m[2].replace(/^["']|["']$/g, ""));
  return { k: "path", parts };
}

function parseExpr(src: string): Expr {
  const toks = tokenizeExpr(src);
  let pos = 0;
  const one = (): Expr => {
    const t = toks[pos++];
    if (t === "(") {
      const e = call(")");
      pos++;
      return e;
    }
    if (t === undefined) throw new TemplateError(`unfinished expression {{${src}}}`);
    return parsePath(t);
  };
  const call = (end?: string): Expr => {
    const first = toks[pos];
    if (first === "(") return one();
    const head = one();
    const args: Expr[] = [];
    const hash: Record<string, Expr> = {};
    while (pos < toks.length && toks[pos] !== end) {
      const t = toks[pos];
      const eq = /^([A-Za-z_]\w*)=(.+)$/.exec(t);
      if (eq) {
        pos++;
        hash[eq[1]] = parsePath(eq[2]);
      } else args.push(one());
    }
    if (!args.length && !Object.keys(hash).length) return head;
    if (head.k !== "path" || head.parts.length !== 1) throw new TemplateError(`${src}: only a helper takes arguments`);
    return { k: "call", name: head.parts[0], args, hash };
  };
  const e = call();
  if (pos < toks.length) throw new TemplateError(`unexpected ${toks[pos]} in {{${src}}}`);
  return e;
}

export function parse(template: string): Node[] {
  const hit = cache.get(template);
  if (hit) return hit;
  const root: Node[] = [];
  const stack: { node: Extract<Node, { t: "block" }>; inElse: boolean }[] = [];
  const push = (n: Node) => {
    const top = stack[stack.length - 1];
    if (!top) root.push(n);
    else (top.inElse ? top.node.inverse : top.node.body).push(n);
  };
  const re = /\{\{(\{)?(~)?([\s\S]*?)(~)?\}?\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    if (m.index > last) push({ t: "text", v: template.slice(last, m.index) });
    last = re.lastIndex;
    const raw = !!m[1];
    const body = m[3].trim();
    if (body.startsWith("!")) continue;
    if (body.startsWith("#")) {
      const [name, ...rest] = body.slice(1).split(/\s+/);
      const args = rest.length ? (parseExpr(`x ${rest.join(" ")}`) as { args: Expr[] }).args ?? [] : [];
      const node: Extract<Node, { t: "block" }> = { t: "block", name, args, body: [], inverse: [], src: m[0] };
      push(node);
      stack.push({ node, inElse: false });
    } else if (body.startsWith("/")) {
      const top = stack.pop();
      if (!top || top.node.name !== body.slice(1).trim()) throw new TemplateError(`{{${body}}} closes ${top ? `{{#${top.node.name}}}` : "nothing"}`);
    } else if (body === "else" || body === "^") {
      const top = stack[stack.length - 1];
      if (!top) throw new TemplateError("{{else}} outside a block");
      top.inElse = true;
    } else {
      push({ t: "expr", e: parseExpr(body), raw, src: m[0] });
    }
  }
  if (last < template.length) push({ t: "text", v: template.slice(last) });
  if (stack.length) throw new TemplateError(`{{#${stack[stack.length - 1].node.name}}} is not closed`);
  if (cache.size > 5000) cache.clear();
  cache.set(template, root);
  return root;
}

/** Root names a template reads ({{q_rows.name}} → q_rows), for the dependency graph. */
export function dependencies(template: string): string[] {
  if (typeof template !== "string" || !template.includes("{{")) return [];
  const out = new Set<string>();
  const exprs = (e: Expr) => {
    if (e.k === "path" && e.parts.length && !["this", "@index", "@key", "@first", "@last", "."].includes(e.parts[0])) out.add(e.parts[0]);
    if (e.k === "call") {
      e.args.forEach(exprs);
      Object.values(e.hash).forEach(exprs);
    }
  };
  const nodes = (ns: Node[]) =>
    ns.forEach((n) => {
      if (n.t === "expr") exprs(n.e);
      if (n.t === "block") {
        n.args.forEach(exprs);
        nodes(n.body);
        nodes(n.inverse);
      }
    });
  try {
    nodes(parse(template));
  } catch {
    // a template that does not parse depends on nothing yet
  }
  return [...out];
}

export function dependenciesOf(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") dependencies(v).forEach((d) => out.add(d));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
}

function lookupPath(parts: string[], scope: Scope, ctx: unknown[]): unknown {
  let start: unknown;
  let rest = parts;
  const [h] = parts;
  if (h === "this" || h === ".") {
    start = ctx[ctx.length - 1];
    rest = parts.slice(1);
  } else if (h?.startsWith("@")) {
    return (ctx[ctx.length - 1] as Record<string, unknown> | undefined)?.[h] ?? (scope as Record<string, unknown>)[h];
  } else {
    const top = ctx[ctx.length - 1];
    if (top && typeof top === "object" && h in (top as object)) start = (top as Record<string, unknown>)[h];
    else start = scope[h];
    rest = parts.slice(1);
  }
  let v = start;
  for (const p of rest) {
    if (v === null || v === undefined) return undefined;
    v = (v as Record<string, unknown>)[p];
  }
  return v;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function formatNumber(v: unknown, fmt = "0,0.[00]"): string {
  const n = num(v);
  if (!Number.isFinite(n)) return str(v);
  const pct = fmt.includes("%");
  const x = pct ? n * 100 : n;
  const dec = /\.(\[?)(0+)/.exec(fmt);
  const digits = dec ? dec[2].length : 0;
  const optional = !!dec?.[1];
  const abbrev = fmt.includes("a");
  let val = x;
  let suffix = "";
  if (abbrev) {
    for (const [d, s] of [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]] as const)
      if (Math.abs(x) >= d) {
        val = x / d;
        suffix = s;
        break;
      }
  }
  let out = val.toLocaleString("en-US", { minimumFractionDigits: optional ? 0 : digits, maximumFractionDigits: digits, useGrouping: fmt.includes(",") });
  if (fmt.startsWith("$")) out = "$" + out;
  return out + suffix + (pct ? "%" : "");
}

export function formatDate(v: unknown, fmt = "YYYY-MM-DD"): string {
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
  if (Number.isNaN(d.getTime())) return str(v);
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(2),
    MMMM: months[d.getMonth()],
    MMM: months[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    dddd: days[d.getDay()],
    ddd: days[d.getDay()].slice(0, 3),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(((d.getHours() + 11) % 12) + 1),
    h: String(((d.getHours() + 11) % 12) + 1),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    A: d.getHours() < 12 ? "AM" : "PM",
  };
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A/g, (t) => map[t]);
}

const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return v.map(sqlLiteral).join(", ");
  return `'${String(v).replace(/'/g, "''")}'`;
};
const sqlIdent = (v: unknown, allowed?: string[]): string => {
  const s = String(v ?? "");
  if (allowed && allowed.length && !allowed.includes(s)) throw new TemplateError(`${s} is not one of the allowed names (${allowed.join(", ")})`);
  if (!/^[A-Za-z_][A-Za-z0-9_ .-]*$/.test(s)) throw new TemplateError(`${s} is not a valid name`);
  return `"${s.replace(/"/g, '""')}"`;
};

type Helper = (args: unknown[], hash: Record<string, unknown>) => unknown;
const CORE: Record<string, Helper> = {
  toString: ([v]: unknown[]) => str(v),
  toNumber: ([v]) => num(v),
  concat: (a) => a.map(str).join(""),
  substring: ([s, a, b]) => str(s).substring(num(a), b === undefined ? undefined : num(b)),
  contains: ([hay, needle]) => (Array.isArray(hay) ? hay.includes(needle) : str(hay).includes(str(needle))),
  jsonParse: ([v]) => {
    try {
      return JSON.parse(str(v));
    } catch {
      return null;
    }
  },
  jsonStringify: ([v]) => JSON.stringify(v ?? null),
  add: (a) => a.reduce<number>((s, v) => s + num(v), 0),
  subtract: ([a, b]) => num(a) - num(b),
  multiply: (a) => a.reduce<number>((s, v) => s * num(v), 1),
  divide: ([a, b]) => num(a) / num(b),
  max: (a) => Math.max(...a.flat().map(num)),
  min: (a) => Math.min(...a.flat().map(num)),
  eq: ([a, b]) => a === b || (a != null && b != null && String(a) === String(b) && typeof a !== "object"),
  ne: ([a, b]) => !(a === b || (a != null && b != null && String(a) === String(b) && typeof a !== "object")),
  lt: ([a, b]) => num(a) < num(b),
  le: ([a, b]) => num(a) <= num(b),
  gt: ([a, b]) => num(a) > num(b),
  ge: ([a, b]) => num(a) >= num(b),
  encodeURI: ([v]) => encodeURI(str(v)),
  encodeURIComponent: ([v]) => encodeURIComponent(str(v)),
  lookup: ([o, k]) => (o == null ? undefined : (o as Record<string, unknown>)[str(k)]),
  and: (a) => a.every(Boolean),
  or: (a) => a.some(Boolean),
  not: ([v]) => !v,
  formatNumber: ([v, f]) => formatNumber(v, f === undefined ? undefined : str(f)),
  formatDate: ([v, f]) => formatDate(v, f === undefined ? undefined : str(f)),
  joinParams: ([v, k]) => (Array.isArray(v) ? v.map((x) => `${encodeURIComponent(str(k ?? "p"))}=${encodeURIComponent(str(x))}`).join("&") : ""),
  getSelectedDisplayValue: ([w]) => {
    const x = (w ?? {}) as { values?: unknown[]; displayValues?: unknown[] | null; selectedValue?: unknown };
    const i = (x.values ?? []).indexOf(x.selectedValue);
    return i >= 0 ? (x.displayValues?.[i] ?? x.values?.[i]) : null;
  },
  getSelectedDisplayValues: ([w]) => {
    const x = (w ?? {}) as { values?: unknown[]; displayValues?: unknown[] | null; selectedValues?: unknown[] };
    return (x.selectedValues ?? []).map((v) => {
      const i = (x.values ?? []).indexOf(v);
      return x.displayValues?.[i] ?? v;
    });
  },
};
const SQL: Record<string, Helper> = {
  param: ([v]) => sqlLiteral(v),
  column: ([v, ...allowed]) => sqlIdent(v, allowed.map(str)),
  table: ([v, ...allowed]) => sqlIdent(v, allowed.map(str)),
  schema: ([v, ...allowed]) => sqlIdent(v, allowed.map(str)),
  alias: ([v]) => sqlIdent(v),
};

function evalExpr(e: Expr, scope: Scope, ctx: unknown[], mode: Mode): unknown {
  if (e.k === "lit") return e.v;
  if (e.k === "path") return lookupPath(e.parts, scope, ctx);
  if (mode === "js") throw new TemplateError(`helpers are not accepted in functions and events ({{${e.name} …}})`);
  const fn = (mode === "sql" ? SQL[e.name] : undefined) ?? CORE[e.name];
  if (!fn) throw new TemplateError(`unknown helper ${e.name}`);
  return fn(
    e.args.map((a) => evalExpr(a, scope, ctx, mode)),
    Object.fromEntries(Object.entries(e.hash).map(([k, v]) => [k, evalExpr(v, scope, ctx, mode)])),
  );
}

const truthy = (v: unknown) => !(v === false || v === null || v === undefined || v === "" || v === 0 || (Array.isArray(v) && !v.length));

function renderNodes(nodes: Node[], scope: Scope, ctx: unknown[], mode: Mode): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "expr") {
      const v = evalExpr(n.e, scope, ctx, mode);
      if (mode === "js") out += v === undefined ? "undefined" : JSON.stringify(v);
      else if (mode === "sql") {
        if (n.e.k !== "call" || !SQL[n.e.name]) {
          // values reach SQL only through the helpers (param quotes, column / table check names)
          out += sqlLiteral(v);
        } else out += str(v);
      } else out += str(v);
    } else {
      const args = n.args.map((a) => evalExpr(a, scope, ctx, mode));
      if (n.name === "if" || n.name === "unless") {
        const ok = n.name === "if" ? truthy(args[0]) : !truthy(args[0]);
        out += renderNodes(ok ? n.body : n.inverse, scope, ctx, mode);
      } else if (n.name === "each") {
        const list = args[0];
        const entries: [string | number, unknown][] = Array.isArray(list) ? list.map((v, i) => [i, v]) : list && typeof list === "object" ? Object.entries(list) : [];
        if (!entries.length) out += renderNodes(n.inverse, scope, ctx, mode);
        entries.forEach(([k, v], i) => {
          const frame = v && typeof v === "object" ? { ...(v as object), "@index": i, "@key": k, "@first": i === 0, "@last": i === entries.length - 1 } : v;
          out += renderNodes(n.body, { ...scope, "@index": i, "@key": k, "@first": i === 0, "@last": i === entries.length - 1 }, [...ctx, frame], mode);
        });
      } else if (n.name === "with") {
        out += truthy(args[0]) ? renderNodes(n.body, scope, [...ctx, args[0]], mode) : renderNodes(n.inverse, scope, ctx, mode);
      } else if (n.name === "jsonStringify") {
        out += JSON.stringify(renderNodes(n.body, scope, ctx, mode === "js" ? "text" : mode));
      } else {
        const fn = CORE[n.name];
        if (!fn) throw new TemplateError(`unknown block helper #${n.name}`);
        out += str(fn([renderNodes(n.body, scope, ctx, mode), ...args], {}));
      }
    }
  }
  return out;
}

export function render(template: unknown, scope: Scope, mode: Mode = "value"): unknown {
  if (typeof template !== "string") {
    if (mode !== "value") return template;
    if (Array.isArray(template)) return template.map((t) => render(t, scope, "value"));
    if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, render(v, scope, "value")]));
    return template;
  }
  if (!template.includes("{{")) return template;
  const nodes = parse(template);
  if (mode === "value" && nodes.length === 1 && nodes[0].t === "expr") return evalExpr(nodes[0].e, scope, [], "value");
  return renderNodes(nodes, scope, [], mode === "value" ? "text" : mode);
}

/** HTTP JSON query templates: every {{…}} must be inside jsonStringify (no injection out of a JSON value). */
export function checkJsonTemplate(template: string): string | null {
  try {
    const nodes = parse(template);
    const bad = (ns: Node[], inside: boolean): string | null => {
      for (const n of ns) {
        if (n.t === "expr" && !inside && !(n.e.k === "call" && n.e.name === "jsonStringify")) return n.src;
        if (n.t === "block") {
          const r = bad(n.body, inside || n.name === "jsonStringify") ?? bad(n.inverse, inside || n.name === "jsonStringify");
          if (r) return r;
        }
      }
      return null;
    };
    const b = bad(nodes, false);
    return b ? `${b}: wrap Handlebars in HTTP JSON queries in {{jsonStringify …}}` : null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A small JSONPath ($, .key, ['key'], [n], [*], ..key) for HTTP JSON extractors. */
export function jsonPath(data: unknown, path: string): unknown {
  if (!path || path === "$") return data;
  const toks = path.replace(/^\$/, "").match(/\.\.[^.[\]]+|\.[^.[\]]+|\[[^\]]+\]/g) ?? [];
  let cur: unknown[] = [data];
  let many = false;
  const deep = (v: unknown, key: string, out: unknown[]) => {
    if (Array.isArray(v)) v.forEach((x) => deep(x, key, out));
    else if (v && typeof v === "object") {
      if (key in (v as object)) out.push((v as Record<string, unknown>)[key]);
      Object.values(v).forEach((x) => deep(x, key, out));
    }
  };
  for (const t of toks) {
    const next: unknown[] = [];
    if (t.startsWith("..")) {
      many = true;
      cur.forEach((v) => deep(v, t.slice(2), next));
    } else if (t === "[*]" || t === ".*") {
      many = true;
      cur.forEach((v) => (Array.isArray(v) ? next.push(...v) : v && typeof v === "object" ? next.push(...Object.values(v)) : null));
    } else {
      const key = t.startsWith(".") ? t.slice(1) : t.slice(1, -1).replace(/^['"]|['"]$/g, "");
      cur.forEach((v) => {
        if (v != null && typeof v === "object") {
          const x = (v as Record<string, unknown>)[key];
          if (x !== undefined) next.push(x);
        }
      });
    }
    cur = next;
  }
  return many ? cur : cur[0];
}
