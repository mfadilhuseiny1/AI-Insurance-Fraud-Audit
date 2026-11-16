/**
 * Export pipeline code: a batch pipeline as Python transforms for Code Repositories (pandas DataFrames,
 * `transforms.api`), like Pipeline Builder's export to Java transforms.
 *
 * Two files in `src/<package>/`: `pipeline_logic.py` (one function per graph node) and
 * `pipeline_outputs.py` (one `@transform_df` per output, wiring the nodes from its inputs). Steps and
 * nodes that cannot be converted become `todo(...)` blocks that fail the build until written by hand.
 * The code is a starting point: pandas differs from the pipeline engine in edge cases, so check its
 * output against the pipeline's.
 */
import {
  aggOutput,
  ancestors,
  FALSE_PORT,
  inputsOf,
  isGroup,
  joinKeys,
  readAggs,
  readFilter,
  readSortKeys,
  refNode,
  STEP_BY_KIND,
  type Condition,
  type ConditionGroup,
  type Operand,
  type Params,
  type Pipeline,
  type PipelineNode,
  type Step,
} from "./pipeline";

export type ExportedCode = { files: Record<string, string>; todos: string[]; outputs: number; package: string };

class Unsupported extends Error {}

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield df pd np re json".split(" "),
);
/** A Python identifier from a display name, unique within `used`. */
function ident(name: string, used: Set<string>, fallback = "x"): string {
  let base = name
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!base) base = fallback;
  if (/^\d/.test(base) || PY_KEYWORDS.has(base)) base = `${fallback}_${base}`;
  let id = base;
  for (let k = 2; used.has(id); k++) id = `${base}_${k}`;
  used.add(id);
  return id;
}

/** A Python string literal (JSON string escapes are valid Python). */
const pyStr = (s: string) => JSON.stringify(s);
const pyList = (xs: string[]) => `[${xs.map(pyStr).join(", ")}]`;
const str = (p: Params, k: string) => {
  const v = p[k];
  return typeof v === "string" ? v : "";
};
const list = (p: Params, k: string): string[] => {
  const v = p[k];
  return Array.isArray(v) ? v.filter(Boolean) : typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];
};
const outName = (p: Params) => str(p, "output").trim() || str(p, "column");
const col = (name: string) => `df[${pyStr(name)}]`;

const INT_TYPES = new Set(["Byte", "Short", "Integer", "Long"]);
const FLOAT_TYPES = new Set(["Float", "Double", "Decimal"]);
/** A typed value from a filter or constant as a Python literal. */
function literal(value: string, type: string): string {
  if (INT_TYPES.has(type) || FLOAT_TYPES.has(type)) {
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n)) throw new Unsupported(`"${value}" is not a ${type}`);
    return String(n);
  }
  if (type === "Boolean") return /^(true|1|yes)$/i.test(value.trim()) ? "True" : "False";
  return pyStr(value);
}
const operand = (o: Operand): string => {
  if (!o) throw new Unsupported("an incomplete condition");
  return o.kind === "column" ? col(o.column) : literal(o.value, o.type);
};
const asText = (e: string) => `${e}.astype("string")`;
const isColumn = (o: Operand) => o?.kind === "column";

/** SQL LIKE as a full-match Python regular expression. */
function likePattern(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "\\" && i + 1 < p.length) out += p[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** A filter condition as a boolean pandas Series over `df` (no nulls: a null comparison is False). */
function condition(c: Condition): string {
  const L = operand(c.left);
  const isNull = c.emptyAsNull ? `(${L}.isna() | (${asText(L)} == ""))` : `${L}.isna()`;
  switch (c.op) {
    case "is null":
      return isNull;
    case "is not null":
      return `~${isNull}`;
    case "is in":
    case "is not in": {
      if (c.right?.kind !== "value") throw new Unsupported("is in with a column");
      const right = c.right;
      const items = right.value.split(",").map((x) => x.trim()).filter(Boolean).map((x) => literal(x, right.type));
      return `(${c.op === "is not in" ? "~" : ""}${L}.isin([${items.join(", ")}]) & ${L}.notna())`;
    }
    case "is between":
    case "is not between": {
      if (!c.right2) throw new Unsupported("an incomplete condition");
      const between = `${L}.between(${operand(c.right)}, ${operand(c.right2)})`;
      return c.op === "is between" ? between : `(${L}.notna() & ~${between})`;
    }
    case "like":
    case "not like": {
      if (c.right?.kind !== "value") throw new Unsupported("like with a column");
      const m = `${asText(L)}.str.fullmatch(${pyStr(likePattern(c.right.value))}, na=False)`;
      return c.op === "like" ? m : `(${L}.notna() & ~${m})`;
    }
    case "regex find":
    case "regex match": {
      if (c.right?.kind !== "value") throw new Unsupported("a regex from a column");
      return `${asText(L)}.str.${c.op === "regex match" ? "fullmatch" : "contains"}(${pyStr(c.right.value)}, regex=True, na=False)`;
    }
    case "contains":
    case "does not contain":
    case "starts with":
    case "ends with": {
      if (c.right?.kind !== "value") throw new Unsupported(`${c.op} with a column`);
      const v = pyStr(c.right.value.toLowerCase());
      const s = `${asText(L)}.str.lower()`;
      if (c.op === "starts with") return `${s}.str.startswith(${v}, na=False)`;
      if (c.op === "ends with") return `${s}.str.endswith(${v}, na=False)`;
      const has = `${s}.str.contains(${v}, regex=False, na=False)`;
      return c.op === "contains" ? has : `(${L}.notna() & ~${has})`;
    }
  }
  const R = operand(c.right);
  const bothNull = isColumn(c.right) ? ` | (${L}.isna() & ${R}.isna())` : "";
  switch (c.op) {
    case "is equal to":
      return `((${L} == ${R})${bothNull})`;
    case "is not equal to":
      return `~((${L} == ${R})${bothNull})`;
    case "is equal to (not null safe)":
      return `(${L} == ${R})`;
    case "is not equal to (not null safe)":
      return `((${L} != ${R}) & ${L}.notna()${isColumn(c.right) ? ` & ${R}.notna()` : ""})`;
    case "is less than":
      return `(${L} < ${R})`;
    case "is less than or equal to":
      return `(${L} <= ${R})`;
    case "is greater than":
      return `(${L} > ${R})`;
    case "is greater than or equal to":
      return `(${L} >= ${R})`;
  }
  throw new Unsupported(`the "${c.op}" condition`);
}
function group(g: ConditionGroup): string {
  if (!g.items.length) return "pd.Series(True, index=df.index)";
  const parts = g.items.map((x) => (isGroup(x) ? group(x) : condition(x)));
  return parts.length === 1 ? parts[0] : `(${parts.join(g.match === "any" ? " | " : " & ")})`;
}

const CAST: Record<string, (e: string) => string> = {
  String: (e) => `${e}.astype("string")`,
  Boolean: (e) => `${e}.astype("boolean")`,
  Date: (e) => `pd.to_datetime(${e}, errors="coerce").dt.date`,
  Timestamp: (e) => `pd.to_datetime(${e}, errors="coerce", utc=True)`,
};
for (const t of INT_TYPES) CAST[t] = (e) => `pd.to_numeric(${e}, errors="coerce").apply(np.trunc).astype("Int64")`;
for (const t of FLOAT_TYPES) CAST[t] = (e) => `pd.to_numeric(${e}, errors="coerce").astype("float64")`;
const DTYPE: Record<string, string> = { String: "string", Boolean: "boolean", Date: "object", Timestamp: "datetime64[ns, UTC]" };
for (const t of INT_TYPES) DTYPE[t] = "Int64";
for (const t of FLOAT_TYPES) DTYPE[t] = "float64";

const AGG: Record<string, string> = {
  "Count distinct": '"nunique"',
  "Approx count distinct": '"nunique"',
  Sum: "lambda s: s.sum(min_count=1)",
  Mean: '"mean"',
  Min: '"min"',
  Max: '"max"',
  Median: '"median"',
  "Std dev": '"std"',
  Variance: '"var"',
  "Std dev (population)": "lambda s: s.std(ddof=0)",
  "Variance (population)": "lambda s: s.var(ddof=0)",
  Skewness: '"skew"',
  First: '"first"',
  Last: '"last"',
  "Collect list": "lambda s: list(s.dropna())",
  "Collect set": "lambda s: list(dict.fromkeys(s.dropna()))",
};

function sortLines(keys: { column: string; direction?: string; nulls?: string }[]): string {
  if (!keys.length) throw new Unsupported("a sort with no columns");
  const na = keys[0].nulls === "first" ? "first" : "last";
  return `df = df.sort_values(${pyList(keys.map((k) => k.column))}, ascending=[${keys.map((k) => (k.direction === "desc" ? "False" : "True")).join(", ")}], na_position=${pyStr(na)}, kind="stable")`;
}

/** The pandas lines of one step over `df`, or Unsupported. */
function stepLines(s: Step): string[] {
  const p = s.params;
  switch (s.kind) {
    case "select":
      return [`df = df[${pyList(list(p, "columns"))}]`];
    case "drop":
      return [`df = df.drop(columns=${pyList(list(p, "columns"))})`];
    case "rename":
      return [`df = df.rename(columns={${pyStr(str(p, "column"))}: ${pyStr(str(p, "to"))}})`];
    case "filter": {
      const mask = group(readFilter(p));
      return [`df = df[${str(p, "mode") === "Remove rows" ? "~" : ""}${mask}]`];
    }
    case "dedupe": {
      const cols = list(p, "columns");
      return [`df = df.drop_duplicates(${cols.length ? `subset=${pyList(cols)}` : ""})`];
    }
    case "keep_duplicates": {
      const cols = list(p, "columns");
      return [`df = df[df.duplicated(${cols.length ? `subset=${pyList(cols)}, ` : ""}keep=False)]`];
    }
    case "sort":
      return [sortLines(readSortKeys(p, "sort"))];
    case "top_rows": {
      const n = Math.max(1, Math.trunc(Number(str(p, "n") || "1")) || 1);
      const part = list(p, "partition");
      return [sortLines(readSortKeys(p, "sort")), part.length ? `df = df.groupby(${pyList(part)}, dropna=False, sort=False).head(${n})` : `df = df.head(${n})`];
    }
    case "limit": {
      const n = Math.trunc(Number(str(p, "n") || "100"));
      const off = Math.trunc(Number(str(p, "offset") || "0")) || 0;
      if (!Number.isFinite(n)) throw new Unsupported("a limit that is not a number");
      return [`df = df.iloc[${off}:${off + n}]`];
    }
    case "trim": {
      const fn = { Left: "lstrip", Right: "rstrip" }[str(p, "side")] ?? "strip";
      const chars = str(p, "chars");
      return [`df[${pyStr(outName(p))}] = ${asText(col(str(p, "column")))}.str.${fn}(${chars ? pyStr(chars) : ""})`];
    }
    case "uppercase":
    case "lowercase":
    case "title_case": {
      const fn = { uppercase: "upper", lowercase: "lower", title_case: "title" }[s.kind];
      return [`df[${pyStr(outName(p))}] = ${asText(col(str(p, "column")))}.str.${fn}()`];
    }
    case "cast": {
      const cast = CAST[str(p, "type")];
      if (!cast) throw new Unsupported(`a cast to ${str(p, "type")}`);
      return [`df[${pyStr(outName(p))}] = ${cast(col(str(p, "column")))}`];
    }
    case "constant": {
      const v = str(p, "value");
      return [`df[${pyStr(str(p, "output"))}] = ${v === "" ? "None" : literal(v, str(p, "type") || "String")}`];
    }
    case "fill": {
      const c = col(str(p, "column"));
      const v = str(p, "value");
      const value = /^-?\d+(\.\d+)?$/.test(v) ? v : pyStr(v);
      return [`df[${pyStr(str(p, "column"))}] = ${c}.mask(${c}.isna() | (${asText(c)} == ""), ${value})`];
    }
    case "explode": {
      if (str(p, "position") === "true") throw new Unsupported("explode with a position column");
      const c = col(str(p, "column"));
      const out = pyStr(outName(p));
      const sep = str(p, "separator");
      const lines = [
        sep
          ? `df[${out}] = ${asText(c)}.str.split(${pyStr(sep)})`
          : `df[${out}] = ${c}.map(lambda v: json.loads(v) if isinstance(v, str) else v)`,
        `df = df.explode(${out}, ignore_index=True)`,
      ];
      if (str(p, "keepEmpty") !== "true") lines.push(`df = df[df[${out}].notna()]`);
      return lines;
    }
    case "aggregate": {
      if (str(p, "grouping") && str(p, "grouping") !== "Group by") throw new Unsupported(`${str(p, "grouping")} grouping`);
      const keys = list(p, "groupBy");
      const aggs = readAggs(p);
      if (!aggs.length) throw new Unsupported("an aggregate with no aggregations");
      const named = aggs.map((a) => {
        if (a.where?.items.length) throw new Unsupported("an aggregation with a filter");
        if (a.fn === "Count") return `${pyStr(aggOutput(a))}: (${a.column ? `${pyStr(a.column)}, "count"` : `df.columns[0], "size"`})`;
        const fn = AGG[a.fn];
        if (!fn || !a.column) throw new Unsupported(`the ${a.fn} aggregation`);
        return `${pyStr(aggOutput(a))}: (${pyStr(a.column)}, ${fn})`;
      });
      return [
        `df = group(df, ${pyList(keys)}).agg(**{${named.join(", ")}})`,
        keys.length ? "df = df.reset_index()" : "df = df.reset_index(drop=True)",
      ];
    }
    case "normalize_columns":
      return [`df.columns = [snake_case(c, ${str(p, "removeSpecial") === "true" ? "True" : "False"}) for c in df.columns]`];
    case "uppercase_columns":
      return ["df.columns = [c.upper() for c in df.columns]"];
    case "empty_table": {
      const cols = str(p, "schema")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const [name, type = "String"] = x.split(":").map((y) => y.trim());
          return `${pyStr(name)}: pd.Series(dtype=${pyStr(DTYPE[type] ?? "object")})`;
        });
      return [`df = pd.DataFrame({${cols.join(", ")}})`];
    }
  }
  throw new Unsupported(STEP_BY_KIND.get(s.kind)?.label ?? s.kind);
}

const PRELUDE = `"""Pipeline logic exported from Pipeline Builder: one function per node of the pipeline graph.

The pandas code is a starting point — check its output against the pipeline's. Blocks the export could
not convert call todo(...), which fails the build until they are written by hand.
"""

import json
import re

import numpy as np
import pandas as pd


def todo(what, df=None):
    raise NotImplementedError(f"Not exported from Pipeline Builder: {what} — write this part by hand")


def group(df, keys):
    """GROUP BY keys (null keys form a group); no keys: the whole table is one group."""
    if keys:
        return df.groupby(keys, dropna=False, sort=False)
    return df.groupby(np.zeros(len(df), dtype=int), sort=False)


def snake_case(name, remove_special):
    s = re.sub(r"([a-z0-9])([A-Z])", r"\\1_\\2", name)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\\1_\\2", s).lower()
    s = re.sub(r"[^a-z0-9]+" if remove_special else r"[\\s\\-.]+", "_", s)
    return re.sub(r"_+", "_", s).strip("_") or "_untitled_column"


def join(left, right, left_on, right_on, how, null_safe, left_columns=None, right_columns=None, right_prefix=""):
    """A Pipeline Builder join. null_safe: null keys match each other (is equal to); otherwise never (=)."""
    if left_columns is not None:
        left = left[list(dict.fromkeys([*left_columns, *left_on]))]
    if right_columns is not None:
        right = right[list(dict.fromkeys([*right_columns, *right_on]))]
    if right_prefix:
        right = right.rename(columns={c: right_prefix + c for c in right.columns})
        right_on = [right_prefix + c for c in right_on]
    if how == "cross":
        return left.merge(right, how="cross")
    lmask = left[left_on].notna().all(axis=1) if not null_safe else pd.Series(True, index=left.index)
    rmask = right[right_on].notna().all(axis=1) if not null_safe else pd.Series(True, index=right.index)
    if how in ("left semi", "left anti"):
        keys = right.loc[rmask, right_on].drop_duplicates()
        keys.columns = left_on
        hit = left.merge(keys.assign(_hit=True), on=left_on, how="left")["_hit"].eq(True).to_numpy() & lmask.to_numpy()
        return left[hit if how == "left semi" else ~hit]
    out = left[lmask].merge(right[rmask], left_on=left_on, right_on=right_on, how=how, suffixes=("", "_right"))
    rest = []
    if how in ("left", "outer"):
        rest.append(left[~lmask])
    if how in ("right", "outer"):
        rest.append(right[~rmask])
    return pd.concat([out, *rest], ignore_index=True) if rest else out.reset_index(drop=True)


def union(frames, mode):
    """Union by column name (missing columns are null)."""
    if mode in ("union all", "union distinct"):
        out = pd.concat(frames, ignore_index=True)
        return out.drop_duplicates(ignore_index=True) if mode == "union distinct" else out
    out = frames[0].drop_duplicates()
    for other in frames[1:]:
        other = other.drop_duplicates()
        if mode == "intersect":
            out = out.merge(other, how="inner")
        else:
            m = out.merge(other, how="left", indicator=True)
            out = m[m["_merge"] == "left_only"].drop(columns="_merge")
    return out.reset_index(drop=True)
`;

/** The pipeline's batch logic as Python transforms (files keyed by repository path). */
export function exportPipelineCode(p: Pipeline): ExportedCode {
  const used = new Set<string>();
  const pkg = ident(p.name, new Set(), "pipeline") + "_export";
  const todos: string[] = [];
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const fnName = new Map<string, string>();
  const logic: string[] = [PRELUDE];

  const fnOf = (n: PipelineNode) => {
    if (!fnName.has(n.id)) fnName.set(n.id, ident(`node_${n.name || n.kind}`, used, "node"));
    return fnName.get(n.id)!;
  };
  const todoBlock = (what: string, args: string[]) => {
    todos.push(what);
    return [`    return todo(${pyStr(what)}${args.length ? `, ${args[0]}` : ""})`];
  };

  for (const n of p.nodes) {
    if (n.kind === "source" || n.kind === "input") continue;
    const name = fnOf(n);
    let args: string[] = [];
    let body: string[] = [];
    switch (n.kind) {
      case "transform": {
        args = ["df"];
        body = ["    df = df.copy()"];
        for (const s of n.steps) {
          const label = STEP_BY_KIND.get(s.kind)?.label ?? s.kind;
          try {
            body.push(...stepLines(s).map((l) => `    ${l}`));
          } catch (e) {
            if (!(e instanceof Unsupported)) throw e;
            const what = `"${n.name}" → ${label}${e.message && e.message !== label ? ` (${e.message})` : ""}`;
            todos.push(what);
            body.push(`    # params: ${JSON.stringify(s.params).slice(0, 400)}`, `    df = todo(${pyStr(what)}, df)`);
          }
        }
        body.push("    return df");
        break;
      }
      case "join": {
        args = ["left", "right"];
        const keys = joinKeys(n);
        const ops = new Set(keys.map((k) => k.op ?? "="));
        if (n.how !== "cross" && (!keys.length || [...ops].some((o) => o !== "=" && o !== "<=>") || ops.size > 1)) {
          body = todoBlock(`"${n.name}" → join with ${[...ops].join(", ")} keys`, ["left"]);
          break;
        }
        const cols = (v: string[] | null | undefined) => (v ? pyList(v) : "None");
        body = [
          `    return join(left, right, ${pyList(keys.map((k) => k.left))}, ${pyList(keys.map((k) => k.right))}, ${pyStr(n.how)}, null_safe=${ops.has("<=>") ? "True" : "False"},`,
          `                left_columns=${cols(n.leftColumns)}, right_columns=${cols(n.rightColumns)}, right_prefix=${pyStr(n.rightPrefix ?? "")})`,
        ];
        break;
      }
      case "union": {
        args = ["*frames"];
        const mode = n.mode ?? "union all";
        body = mode.endsWith(" all") && mode !== "union all" ? todoBlock(`"${n.name}" → ${mode}`, ["frames[0]"]) : [`    return union(list(frames), ${pyStr(mode)})`];
        break;
      }
      case "split": {
        args = ["df"];
        try {
          body = [`    mask = ${group(readFilter({ filter: n.condition }))}`, "    return df[mask], df[~mask]"];
        } catch (e) {
          if (!(e instanceof Unsupported)) throw e;
          body = todoBlock(`"${n.name}" → split condition (${e.message})`, ["df"]);
        }
        break;
      }
      default: {
        // LLM, model and subgraph nodes are Foundry features the export cannot convert
        args = ["df"];
        body = todoBlock(`"${n.name}" → ${n.kind === "llm" ? "Use LLM" : n.kind === "model" ? "model inference" : "subgraph"} node`, ["df"]);
      }
    }
    logic.push(`\n\ndef ${name}(${args.join(", ")}):\n    """${(n.name || n.kind).replace(/"""/g, "'''")} (${n.kind})"""\n${body.join("\n")}\n`);
  }

  // outputs: one transform each, wiring its nodes in dependency order
  const outFns = new Set<string>();
  const outs: string[] = [
    `"""Pipeline outputs exported from Pipeline Builder (${p.name.replace(/"""/g, "")}): one transform per output.\n\nOutputs are written to this repository's folder; point Output(..., folder=...) elsewhere if needed.\n"""\n\nfrom transforms.api import Input, Output, transform_df\n\nfrom ${pkg} import pipeline_logic as logic\n`,
  ];
  let exported = 0;
  for (const o of p.outputs) {
    const kind = o.kind ?? "dataset";
    if (kind === "virtualTable" || kind === "mediaSet" || kind === "file") {
      outs.push(`\n# "${o.name}" (${kind} output) is not exported: only dataset-backed outputs are.\n`);
      continue;
    }
    exported++;
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = byId.get(id);
      if (n) for (const i of inputsOf(n)) visit(refNode(i));
      order.push(id);
    };
    for (const id of [...ancestors(p.nodes, o.node), refNode(o.node)]) visit(id);
    const params = new Set<string>();
    const inputs: string[] = [];
    const lines: string[] = [];
    const v = (ref: string) => {
      const n = byId.get(refNode(ref));
      const base = `n_${fnName.get(refNode(ref)) ?? ident(n?.name ?? "node", new Set(), "node")}`;
      if (n?.kind !== "split") return base;
      return `${base}[${ref.endsWith(FALSE_PORT) ? 1 : 0}]`;
    };
    for (const id of order) {
      const n = byId.get(id);
      if (!n) continue;
      if (n.kind === "source") {
        const d = p.datasets[n.datasetId];
        const name = ident(d?.name.replace(/\.\w+$/, "") ?? "input", params, "input");
        fnName.set(n.id, `src_${name}`);
        if (d?.ref?.kind === "drive") inputs.push(`    ${name}=Input(${pyStr(d.ref.itemId)}),  # ${d.name}`);
        else {
          const why = !d ? "a missing dataset" : d.ref ? `a ${d.ref.kind} input` : "a copy kept in the pipeline file";
          todos.push(`input "${d?.name ?? n.datasetId}" (${why})`);
          lines.push(`    ${name} = logic.todo(${pyStr(`input "${d?.name ?? n.datasetId}" is ${why} — save it to Files as Parquet and add it as Input(...)`)})`);
          params.delete(name);
          params.add(`_${name}`);
        }
        lines.push(`    n_src_${name} = ${name}`);
        continue;
      }
      if (n.kind === "input") {
        lines.push(`    n_${fnOf(n)} = logic.todo(${pyStr(`subgraph input "${n.name}"`)})`);
        continue;
      }
      lines.push(`    n_${fnOf(n)} = logic.${fnOf(n)}(${inputsOf(n).map(v).join(", ")})`);
    }
    let result = v(o.node);
    if (o.columns?.length) {
      const renames = o.columns.filter((c) => c.name !== c.source).map((c) => `${pyStr(c.source)}: ${pyStr(c.name)}`);
      result = `${result}[${pyList(o.columns.map((c) => c.source))}]${renames.length ? `.rename(columns={${renames.join(", ")}})` : ""}`;
    }
    const fn = ident(`build_${o.name}`, outFns, "build");
    const args = [...params].filter((x) => !x.startsWith("_"));
    outs.push(
      `\n\n@transform_df(\n    Output(${pyStr(o.name.trim())}),\n${inputs.join("\n")}${inputs.length ? "\n" : ""})\ndef ${fn}(${args.join(", ")}):\n    """${kind === "dataset" ? "Dataset" : `Dataset backing the ${kind} output`} "${o.name.replace(/"/g, "'")}"."""\n${lines.join("\n")}\n    return ${result}\n`,
    );
  }

  const readme = [
    `# ${p.name} — exported from Pipeline Builder`,
    "",
    `Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${exported} output${exported === 1 ? "" : "s"}, ${todos.length} block${todos.length === 1 ? "" : "s"} to write by hand.`,
    "",
    `- \`src/${pkg}/pipeline_logic.py\` — one function per node of the graph.`,
    `- \`src/${pkg}/pipeline_outputs.py\` — one transform per output, wiring the nodes from its inputs.`,
    "",
    "The export is one-way: changes here do not flow back into the pipeline. The code uses pandas, which differs",
    "from the pipeline engine in edge cases (types, null handling, sort stability), so treat it as a starting point",
    "and check its output against the pipeline's. Pipeline parameters are not substituted.",
    "",
    ...(todos.length ? ["## To write by hand", "", ...todos.map((t) => `- ${t}`), ""] : []),
  ].join("\n");

  return {
    package: pkg,
    outputs: exported,
    todos,
    files: {
      [`src/${pkg}/__init__.py`]: "",
      [`src/${pkg}/pipeline_logic.py`]: logic.join(""),
      [`src/${pkg}/pipeline_outputs.py`]: outs.join(""),
      [`src/${pkg}/README.md`]: readme,
    },
  };
}
