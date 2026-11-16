import { applySteps, inputsOf, joinKeys, refNode, stepDefOf, tableNames, type NodeResult, type Pipeline, type PipelineNode, type Step, type StepContext, type Table } from "@/lib/pipeline";

/* What AIP Assist reads about a pipeline. The nodes asked about (selected, or named in the question) come in full:
   their note, input and output columns, the column arithmetic from input to output, their boards in order and what
   the data dictionary says of their columns; every other node in one line. Columns come from `schema` (the in-browser
   engine on each input's sample: instant, and it starts no preview); `result` (the engine's own preview, DuckDB for a
   DuckDB local pipeline) is read for the nodes asked about only. */

export type PipelineContextDeps = {
  pipeline: Pipeline;
  /** the nodes asked about, in order */
  detail: string[];
  result: (id: string) => NodeResult;
  schema: (id: string) => NodeResult;
};

const BOARDS_MAX = 9000;
const fmt = (n: number) => n.toLocaleString("en-US");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// a long summary keeps its end too (a mapping join names its mapping table last)
const cutMiddle = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.floor(n * 0.6))} … ${s.slice(-Math.floor(n * 0.4))}` : s);
const firstLine = (s?: string) => (s ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";

/** How a transform's columns change, board by board: a column that left where another came in, in the same
 *  place, was renamed; `origin` is the input column each output column comes from (null: made by a board). */
export type ColumnTrace = {
  columns: string[];
  origin: Map<string, string | null>;
  madeAt: Map<string, number>;
  /** input column → the board that dropped it (and its name by then) */
  droppedAt: Map<string, { step: number; as: string }>;
  changes: Map<number, { added: string[]; removed: string[] }>;
  error?: { step: number; message: string };
};

export function traceColumns(input: Table, steps: Step[], ctx: StepContext): ColumnTrace {
  let t = input;
  let origin = new Map<string, string | null>(input.columns.map((c) => [c.name, c.name]));
  const madeAt = new Map<string, number>();
  const droppedAt = new Map<string, { step: number; as: string }>();
  const changes = new Map<number, { added: string[]; removed: string[] }>();
  for (let i = 0; i < steps.length; i++) {
    const before = t.columns.map((c) => c.name);
    const r = applySteps(t, [steps[i]], ctx);
    if (r.error !== undefined) return { columns: before, origin, madeAt, droppedAt, changes, error: { step: i, message: r.error } };
    t = r.table;
    const after = t.columns.map((c) => c.name);
    const added = after.filter((c) => !before.includes(c));
    const removed = before.filter((c) => !after.includes(c));
    if (!added.length && !removed.length) continue;
    const renamed = new Map<string, string>();
    if (before.length === after.length) after.forEach((c, j) => added.includes(c) && removed.includes(before[j]) && renamed.set(c, before[j]));
    const from = new Set(renamed.values());
    const next = new Map<string, string | null>();
    for (const c of after) next.set(c, renamed.has(c) ? (origin.get(renamed.get(c)!) ?? null) : origin.has(c) ? origin.get(c)! : null);
    for (const c of added) if (!renamed.has(c)) madeAt.set(c, i);
    for (const c of removed) {
      if (from.has(c)) continue;
      const o = origin.get(c);
      if (o) droppedAt.set(o, { step: i, as: c });
      else madeAt.delete(c);
    }
    origin = next;
    const plain = { added: added.filter((c) => !renamed.has(c)), removed: removed.filter((c) => !from.has(c)) };
    if (plain.added.length || plain.removed.length) changes.set(i, plain);
  }
  return { columns: t.columns.map((c) => c.name), origin, madeAt, droppedAt, changes };
}

export function pipelineContext({ pipeline, detail, result, schema }: PipelineContextDeps): string {
  const nodes = pipeline.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sqlNames = tableNames(nodes);
  const dictionary = pipeline.dictionary ?? {};
  const label = (ref: string) => byId.get(refNode(ref))?.name ?? ref;
  const tableOf = (id: string) => {
    const r = schema(id);
    return r.error !== undefined ? null : r.table;
  };
  const stepName = (s: Step) => stepDefOf(s.kind, pipeline.functions)?.label ?? (s.kind === "sql" ? "SQL" : s.kind);
  const stepText = (s: Step) => {
    if (s.kind === "sql") return cutMiddle(String(s.params.query ?? "").replace(/\s+/g, " "), 400);
    try {
      return cutMiddle(stepDefOf(s.kind, pipeline.functions)?.summary(s.params) ?? "", 260);
    } catch {
      return "";
    }
  };
  const columnsText = (t: Table, max: number) =>
    `${t.columns.slice(0, max).map((c) => `${c.name}:${c.type}`).join(", ")}${t.columns.length > max ? ` … +${t.columns.length - max}` : ""}`;

  const stepContext = (node: PipelineNode): StepContext => ({
    names: () => nodes.filter((n) => n.id !== node.id).map((n) => sqlNames.get(n.id)!),
    table: (name) => {
      const n = nodes.find((x) => x.id !== node.id && sqlNames.get(x.id) === name);
      return n ? (tableOf(n.id) ?? undefined) : undefined;
    },
    functions: pipeline.functions,
    preview: true,
  });

  /** the boards in order, runs of one kind on one line, marked where they add or drop columns */
  const boards = (steps: Step[], trace: ColumnTrace | null) => {
    const lines: string[] = [];
    for (let i = 0; i < steps.length; ) {
      let j = i;
      while (j + 1 < steps.length && steps[j + 1].kind === steps[i].kind && !trace?.changes.get(j + 1)?.removed.length) j++;
      const texts = steps.slice(i, j + 1).map((s, k) => {
        const ch = trace?.changes.get(i + k);
        const marks = ch ? `${ch.added.length ? ` [+${ch.added.join(", ")}]` : ""}${ch.removed.length ? ` [−${ch.removed.join(", ")}]` : ""}` : "";
        return stepText(s) + marks;
      });
      lines.push(`  ${i + 1}${j > i ? `–${j + 1}` : ""}. ${stepName(steps[i])}${j > i ? ` ×${j - i + 1}` : ""}: ${cut(texts.join("; "), 1500)}`);
      i = j + 1;
    }
    const out: string[] = [];
    let size = 0;
    for (const l of lines) {
      if (size + l.length > BOARDS_MAX) {
        out.push(`  … ${lines.length - out.length} more lines of boards not shown`);
        break;
      }
      out.push(l);
      size += l.length;
    }
    return out.join("\n");
  };

  const arithmetic = (input: Table, inputName: string, steps: Step[], trace: ColumnTrace) => {
    const at = (i: number) => `board ${i + 1} ${stepName(steps[i])}`;
    const kept = trace.columns.filter((c) => trace.origin.get(c) === c);
    const renamed = trace.columns.filter((c) => trace.origin.get(c) && trace.origin.get(c) !== c);
    const made = trace.columns.filter((c) => !trace.origin.get(c));
    const dropped = input.columns.map((c) => c.name).filter((c) => trace.droppedAt.has(c));
    const list = (xs: string[]) => xs.join(", ");
    // new columns grouped by the kind of board that made them and the mapping join that later fills them with labels
    const joinOf = (c: string) =>
      steps.findIndex((s, i) => i > (trace.madeAt.get(c) ?? -1) && s.kind === "mapping_join" && Array.isArray(s.params.columns) && (s.params.columns as string[]).includes(c));
    const groups = new Map<string, string[]>();
    for (const c of made) {
      const k = `${trace.madeAt.has(c) ? stepName(steps[trace.madeAt.get(c)!]) : "?"}\u0000${joinOf(c)}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const madeText = [...groups].map(([k, cs]) => {
      const [kind, j] = k.split("\u0000");
      const boards = cs.map((c) => (trace.madeAt.has(c) ? trace.madeAt.get(c)! + 1 : "?")).join(", ");
      const filled = Number(j) >= 0 ? `, each first a lookup key, then replaced by its label text from ${String(steps[Number(j)].params.mapping)} at board ${Number(j) + 1} Mapping join` : "";
      return `      ${cs.length} by ${kind} (board${cs.length > 1 ? "s" : ""} ${boards})${filled}: ${list(cs)}`;
    });
    return [
      `  Column arithmetic, input ${inputName} (${input.columns.length} columns) → this node (${trace.columns.length} columns):`,
      `    ${kept.length} kept as they are: ${list(kept)}`,
      `    ${renamed.length} renamed: ${list(renamed.map((c) => `${trace.origin.get(c)}→${c}`))}`,
      `    ${dropped.length} dropped: ${list(dropped.map((c) => { const d = trace.droppedAt.get(c)!; return `${c}${d.as !== c ? ` (by then ${d.as})` : ""} at ${at(d.step)}`; })) || "none"}`,
      `    ${made.length} new, made by boards${made.length ? `:\n${madeText.join("\n")}` : ": none"}`,
      `    so ${input.columns.length} − ${dropped.length} dropped = ${kept.length + renamed.length} carried over (${kept.length} as they are + ${renamed.length} renamed), + ${made.length} new = ${trace.columns.length}`,
    ].join("\n");
  };

  /** `full`: columns whose note is given whole (the dropped ones: their note says why) */
  const meanings = (names: string[], full: Set<string>) => {
    const seen = [...new Set(names)].filter((c) => dictionary[c]).slice(0, 90);
    return seen.map((c) => {
      const e = dictionary[c];
      return `    ${c}: ${e.label}${e.anonymized ? " (anonymized)" : ""}${e.note ? ` — ${cut(e.note, full.has(c) ? 500 : 140)}` : ""}`;
    });
  };

  const describe = (n: PipelineNode) => {
    const out = result(n.id);
    const own = out.error === undefined && !out.pending && out.table.columns.length ? out.table : tableOf(n.id);
    const ins = inputsOf(n).map((i) => `${label(i)} [${refNode(i)}]`);
    const lines = [`### "${n.name}" [${n.id}] — ${n.kind}${ins.length ? `, input${ins.length > 1 ? "s" : ""}: ${ins.join(", ")}` : ""}; SQL name ${sqlNames.get(n.id)}`];
    if (n.description) lines.push(`  Note (why the node exists):\n${n.description.split("\n").map((l) => `    ${l}`).join("\n")}`);
    if (out.error !== undefined) lines.push(`  error: ${cut(out.error, 400)}`);
    if (own)
      lines.push(
        `  Output: ${own.columns.length} columns, ${own.totalRows !== undefined ? `${fmt(own.totalRows)} rows${pipeline.compute === "duckdb" ? " (DuckDB, every input row)" : ""}` : `${fmt(own.rows.length)} rows in the preview of the inputs' samples (the real count is not known here)`}`,
      );
    const names: string[] = [];
    const dropped = new Set<string>();
    if (n.kind === "source") {
      const ds = pipeline.datasets[n.datasetId];
      if (ds) lines.push(`  Dataset ${ds.name} from ${ds.origin}${ds.totalRows !== undefined ? `, ${fmt(ds.totalRows)} rows` : ""}`);
    } else if (n.kind === "transform") {
      const input = tableOf(refNode(n.input));
      const trace = input ? traceColumns(input, n.steps, stepContext(n)) : null;
      if (input) {
        lines.push(`  Input columns (${input.columns.length}, ${label(n.input)}): ${columnsText(input, 200)}`);
        // the dropped columns' meanings first: they are what a question about a column count asks after
        for (const c of input.columns) if (trace?.droppedAt.has(c.name)) dropped.add(c.name);
        names.push(...dropped, ...input.columns.map((c) => c.name));
      }
      if (trace && input) {
        if (trace.error) lines.push(`  (the column trace stops at board ${trace.error.step + 1}: ${cut(trace.error.message, 200)})`);
        else lines.push(arithmetic(input, label(n.input), n.steps, trace));
      }
      lines.push(`  Boards (${n.steps.length}, applied in order; [+x] adds column x, [−x] drops it):\n${boards(n.steps, trace)}`);
    } else if (n.kind === "join") {
      const l = tableOf(refNode(n.left));
      const r = tableOf(refNode(n.right));
      const keys = joinKeys(n).map((k) => `${k.left} ${k.op ?? "="} ${k.right}`);
      lines.push(`  ${n.how} join of ${label(n.left)} (left${l ? `, ${l.columns.length} columns` : ""}) with ${label(n.right)} (right${r ? `, ${r.columns.length} columns` : ""}) on ${keys.join(" and ") || "—"}`);
      if (n.leftColumns) lines.push(`  left columns kept: ${n.leftColumns.join(", ")}`);
      if (n.rightColumns) lines.push(`  right columns kept: ${n.rightColumns.join(", ")}`);
      if (n.rightPrefix) lines.push(`  right columns prefixed "${n.rightPrefix}"`);
      if (l && r && own) {
        const ln = new Set(l.columns.map((c) => c.name));
        const fromLeft = own.columns.filter((c) => ln.has(c.name)).length;
        lines.push(`  Column arithmetic: ${fromLeft} columns from the left + ${own.columns.length - fromLeft} from the right = ${own.columns.length}`);
      }
    } else if (n.kind === "union") {
      lines.push(`  ${n.mode ?? "union all"} of ${n.inputs.map((i) => `${label(i)} (${tableOf(refNode(i))?.columns.length ?? "?"} columns)`).join(", ")}${n.strict ? "; every input must have the same columns" : "; a column missing from an input is null there"}`);
    }
    if (own) {
      lines.push(`  Output columns (${own.columns.length}): ${columnsText(own, 200)}`);
      names.push(...own.columns.map((c) => c.name));
      lines.push(`  Sample rows: ${cut(JSON.stringify(own.rows.slice(0, 3)), 1500)}`);
    }
    const m = meanings(names, dropped);
    if (m.length) lines.push(`  Column meanings (data dictionary):\n${m.join("\n")}`);
    const outs = pipeline.outputs.filter((o) => refNode(o.node) === n.id);
    if (outs.length) lines.push(`  Outputs: ${outs.map((o) => `${o.name} (${o.kind ?? "dataset"})${o.description ? ` — ${cut(firstLine(o.description), 160)}` : ""}`).join("; ")}`);
    return lines.join("\n");
  };

  const brief = (n: PipelineNode) => {
    const r = schema(n.id);
    const ins = inputsOf(n).map((i) => label(i));
    const cols = r.error !== undefined ? `error: ${cut(r.error, 160)}` : `${r.table.columns.length} columns: ${r.table.columns.slice(0, 15).map((c) => c.name).join(", ")}${r.table.columns.length > 15 ? " …" : ""}`;
    const note = firstLine(n.description).replace(/^Apa:\s*/, "");
    return `- [${n.id}] "${n.name}" — ${n.kind}${ins.length ? ` ← ${ins.join(", ")}` : ""}; ${cols}${note ? `; note: ${cut(note, 130)}` : ""}`;
  };

  const asked = new Set(detail);
  const engine = pipeline.compute === "duckdb" ? "DuckDB local engine (DuckDB SQL)" : pipeline.compute ?? "standard";
  return [
    `Pipeline "${pipeline.name}" (${pipeline.type}, ${engine}), ${nodes.length} nodes, ${pipeline.outputs.length} outputs.`,
    pipeline.meta?.description ? `About: ${cut(pipeline.meta.description, 400)}` : "",
    detail.length ? `\n## Nodes asked about (selected or named in the question)\n${detail.map((id) => describe(byId.get(id)!)).join("\n\n")}` : "\n## No node selected — the question is about the whole pipeline.",
    `\n## All other nodes\n${nodes.filter((n) => !asked.has(n.id)).map(brief).join("\n")}`,
    pipeline.outputs.length
      ? `\n## Outputs\n${pipeline.outputs.map((o) => `- ${o.name} (${o.kind ?? "dataset"}) from ${label(o.node)}${o.description ? ` — ${cut(firstLine(o.description), 120)}` : ""}`).join("\n")}`
      : "",
  ].join("\n");
}

/** Nodes the question names (their name or SQL name as a word), at most `max`. */
export function namedNodes(pipeline: Pipeline, question: string, max: number): string[] {
  const q = question.toLowerCase();
  const sqlNames = tableNames(pipeline.nodes);
  const word = (s: string) => s.length >= 3 && new RegExp(`(^|[^a-z0-9_])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_])`).test(q);
  return pipeline.nodes.filter((n) => word(n.name) || word(sqlNames.get(n.id) ?? "")).slice(0, max).map((n) => n.id);
}
