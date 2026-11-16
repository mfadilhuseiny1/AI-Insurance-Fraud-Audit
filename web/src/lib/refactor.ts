/**
 * Find and replace column names across a pipeline: transform boards (column fields, conditions,
 * aggregations, sort keys, formulas and SQL by whole word), joins, splits, LLM prompts, model features,
 * output schemas and expectations — and optionally the columns of the input datasets themselves.
 */
import {
  stepDefOf,
  type Dataset,
  type Expectation,
  type Output,
  type Params,
  type Pipeline,
  type PipelineNode,
  type Step,
} from "./pipeline";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const identLike = (s: string) => /^[A-Za-z_][\w]*$/.test(s);

/** JSON values with column operands ({kind: "column", column}) and keyed column fields renamed; literal values untouched. */
function renameInJson(v: unknown, from: string, to: string): [unknown, number] {
  let n = 0;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o.kind === "value") return o;
      return Object.fromEntries(
        Object.entries(o).map(([k, val]) => {
          if (typeof val === "string" && val === from && ["column", "left", "right", "arg", "source", "name"].includes(k) && (k !== "name" || "type" in o)) {
            n++;
            return [k, to];
          }
          return [k, walk(val)];
        }),
      );
    }
    return x;
  };
  return [walk(v), n];
}

function renameInText(text: string, from: string, to: string): [string, number] {
  if (!identLike(from)) {
    const re = new RegExp(`\`${escapeRe(from)}\`|"${escapeRe(from)}"`, "g");
    let n = 0;
    const out = text.replace(re, (m) => (n++, m[0] + to + m[0]));
    return [out, n];
  }
  let n = 0;
  const out = text.replace(new RegExp(`(?<![\\w.'"])${escapeRe(from)}(?![\\w'"])`, "g"), () => (n++, to));
  return [out, n];
}

function renameStep(step: Step, from: string, to: string, functions: Pipeline["functions"]): [Step, number] {
  const def = stepDefOf(step.kind, functions);
  let count = 0;
  const params: Params = { ...step.params };
  for (const [key, value] of Object.entries(step.params)) {
    const field = def?.fields.find((f) => f.key === key);
    if (Array.isArray(value)) {
      if (!field || field.kind === "columns" || field.kind === "expressions" || field.kind === "formats") {
        params[key] = value.map((v) => (v === from && field?.kind !== "formats" ? (count++, to) : v));
      }
      continue;
    }
    if (typeof value !== "string") continue;
    if (key === "output") continue; // a new column's name is not a reference
    if (field?.kind === "column" || (!field && key === "column")) {
      if (value === from) {
        params[key] = to;
        count++;
      }
    } else if (field?.kind === "formula" || field?.kind === "sql") {
      const [t, n] = renameInText(value, from, to);
      params[key] = t;
      count += n;
    } else if (value.trim().startsWith("{") || value.trim().startsWith("[")) {
      try {
        const [j, n] = renameInJson(JSON.parse(value), from, to);
        if (n) {
          params[key] = JSON.stringify(j);
          count += n;
        }
      } catch {}
    }
  }
  return [{ ...step, params }, count];
}

const renameList = (list: string[] | null | undefined, from: string, to: string): [string[] | null | undefined, number] => {
  if (!list) return [list, 0];
  let n = 0;
  return [list.map((c) => (c === from ? (n++, to) : c)), n];
};

function renameNode(node: PipelineNode, from: string, to: string, functions: Pipeline["functions"]): [PipelineNode, number] {
  switch (node.kind) {
    case "transform": {
      let total = 0;
      const steps = node.steps.map((s) => {
        const [x, n] = renameStep(s, from, to, functions);
        total += n;
        return x;
      });
      return [{ ...node, steps }, total];
    }
    case "join": {
      let n = 0;
      const keys = (node.keys ?? [{ left: node.leftKey, right: node.rightKey }]).map((k) => ({
        ...k,
        left: k.left === from ? (n++, to) : k.left,
        right: k.right === from ? (n++, to) : k.right,
      }));
      const [lc, a] = renameList(node.leftColumns, from, to);
      const [rc, b] = renameList(node.rightColumns, from, to);
      return [{ ...node, keys, leftKey: keys[0]?.left ?? "", rightKey: keys[0]?.right ?? "", leftColumns: lc, rightColumns: rc }, n + a + b];
    }
    case "split": {
      try {
        const [j, n] = renameInJson(JSON.parse(node.condition), from, to);
        return [{ ...node, condition: JSON.stringify(j) }, n];
      } catch {
        return [node, 0];
      }
    }
    case "llm": {
      let n = 0;
      const c = { ...node.config };
      if (c.column === from) {
        c.column = to;
        n++;
      }
      if (c.imageColumn === from) {
        c.imageColumn = to;
        n++;
      }
      for (const k of ["prompt", "system"] as const)
        if (c[k]) {
          const before = c[k]!;
          c[k] = before.split(`{${from}}`).join(`{${to}}`);
          if (c[k] !== before) n++;
        }
      return [{ ...node, config: c }, n];
    }
    case "model": {
      const [f, n] = renameList(node.features, from, to);
      return [{ ...node, features: f ?? [] }, n];
    }
    default:
      return [node, 0];
  }
}

function renameOutput(o: Output, from: string, to: string): [Output, number] {
  let n = 0;
  const columns = o.columns?.map((c) => (c.source === from ? (n++, { ...c, source: to }) : c)) ?? o.columns;
  const expectations = o.expectations?.map((e): Expectation => {
    if (e.kind === "oneOf") return e.column === from ? (n++, { ...e, column: to }) : e;
    if (e.kind === "rowLevel") {
      try {
        const [j, k] = renameInJson(JSON.parse(e.condition), from, to);
        n += k;
        return { ...e, condition: JSON.stringify(j) };
      } catch {
        return e;
      }
    }
    if (e.kind === "rowCount") return e;
    return { ...e, columns: e.columns.map((c) => (c === from ? (n++, to) : c)) };
  });
  const objectType = o.objectType && {
    ...o.objectType,
    primaryKey: o.objectType.primaryKey === from ? (n++, to) : o.objectType.primaryKey,
    titleProperty: o.objectType.titleProperty === from ? (n++, to) : o.objectType.titleProperty,
    properties: o.objectType.properties?.map((p) => (p.source === from ? (n++, { ...p, source: to }) : p)) ?? null,
  };
  return [{ ...o, columns, expectations, ...(objectType ? { objectType } : {}) }, n];
}

function renameDataset(d: Dataset, from: string, to: string): [Dataset, number] {
  if (!d.columns.some((c) => c.name === from) || d.columns.some((c) => c.name === to)) return [d, 0];
  return [
    {
      ...d,
      columns: d.columns.map((c) => (c.name === from ? { ...c, name: to } : c)),
      rows: d.rows.map((r) => {
        const { [from]: v, ...rest } = r;
        return { ...rest, [to]: v ?? null };
      }),
    },
    1,
  ];
}

export function replaceColumnName(p: Pipeline, from: string, to: string, options: { datasets: boolean; nodes?: Set<string> }): { pipeline: Pipeline; count: number } {
  let count = 0;
  const nodes = p.nodes.map((n) => {
    if (options.nodes && !options.nodes.has(n.id)) return n;
    const [x, c] = renameNode(n, from, to, p.functions);
    count += c;
    return x;
  });
  const outputs = p.outputs.map((o) => {
    const [x, c] = renameOutput(o, from, to);
    count += c;
    return x;
  });
  let datasets = p.datasets;
  if (options.datasets) {
    datasets = Object.fromEntries(
      Object.entries(p.datasets).map(([id, d]) => {
        const [x, c] = renameDataset(d, from, to);
        count += c;
        return [id, x];
      }),
    );
  }
  return { pipeline: { ...p, nodes, outputs, datasets }, count };
}
