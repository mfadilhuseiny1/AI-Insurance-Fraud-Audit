"use client";

import { applySteps, JOIN_HOWS, refNode, SET_MODES, STEPS, tableNames, uid, type CustomFunction, type JoinHow, type NodeResult, type Pipeline, type PipelineNode, type SetMode, type Step } from "@/lib/pipeline";
import { CATALOG, PARAMS_HINT, toSteps } from "../pipeline/AiDialogs";
import { OUT } from "../pipeline/Graph";
import type { AssistAdapter } from "./AipAssist";
import { GLOSARIUM } from "./glosarium";
import { namedNodes, pipelineContext } from "./pipelineContext";

/* AIP Assist in Pipeline Builder: reads the graph (pipelineContext: the nodes asked about in full, every other node
   in one line) and proposes new nodes — transform boards, SQL, joins, unions — after the nodes you point at. Boards are
   checked against the input's preview before Apply; an applied node is selected so the next proposal can follow it. */

export type PipelineAssistDeps = {
  pipeline: Pipeline;
  selected: string[];
  setSelected: (ids: string[]) => void;
  result: (id: string) => NodeResult;
  /** a node's columns without running a preview (the in-browser engine on the inputs' samples) */
  schema: (id: string) => NodeResult;
  addNode: (node: Omit<PipelineNode, "id" | "x" | "y">, after: string[]) => string;
  updateNode: (id: string, patch: Partial<PipelineNode>) => void;
  fit: (ids?: string[]) => void;
  functions?: CustomFunction[];
  readOnly?: boolean;
  /** the node the last applied proposal created ("@last" in a later proposal) */
  last: { current: string | null };
};

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim()} `;

/** Glossary entries the question names (a term, a part of it or an alias, as words): the JKN data's glossary, read by
 *  the pipelines that carry a data dictionary. */
function glossaryFor(question: string): string {
  const q = words(question);
  const hits = GLOSARIUM.filter((g) =>
    [...g.istilah.split(/[—→(),&/]/), ...(g.alias ?? [])].map((t) => words(t)).some((t) => t.trim().length >= 2 && q.includes(t)),
  ).slice(0, 8);
  return hits.length ? `\n\n## Glossary terms in the question\n${hits.map((g) => `- ${g.istilah}: ${g.arti}${g.catatan ? ` (${g.catatan})` : ""}`).join("\n")}` : "";
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(str) : typeof v === "string" && v ? [v] : []);

export function pipelineAssist(d: PipelineAssistDeps): AssistAdapter {
  const { pipeline, selected, result } = d;
  const dialect = pipeline.compute === "duckdb" ? "DuckDB SQL" : "Spark SQL";
  const nodes = pipeline.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sqlNames = tableNames(nodes);
  const sel = selected.map((s) => (s.startsWith(OUT) ? pipeline.outputs.find((o) => OUT + o.id === s)?.node : refNode(s))).filter((s): s is string => !!s && byId.has(s));

  /** a node id from the model: exact id, "@last", or a unique node name */
  const resolve = (v: unknown): string | null => {
    const s = str(v).trim();
    if (!s) return null;
    if (s === "@last") return d.last.current && byId.has(d.last.current) ? d.last.current : null;
    if (byId.has(s)) return s;
    const named = nodes.filter((n) => n.name.toLowerCase() === s.toLowerCase() || sqlNames.get(n.id) === s);
    return named.length === 1 ? named[0].id : null;
  };
  const label = (id: string) => byId.get(id)?.name ?? id;
  const tableOf = (id: string) => {
    const r = result(id);
    return r.error !== undefined ? null : r.table;
  };

  /** checks boards on the input's preview: the error of the first failing one, or the resulting columns */
  const check = (input: string | null, steps: Step[]) => {
    if (!input) return { error: "Node input tidak ditemukan" };
    if (!steps.length) return { error: "Tidak ada board" };
    const unknown = steps.find((s) => s.kind !== "sql" && !STEPS.some((x) => x.kind === s.kind) && !d.functions?.some((f) => `fn:${f.id}` === s.kind));
    if (unknown) return { error: `Board tidak dikenal "${unknown.kind}"` };
    if (steps.some((s) => s.kind === "sql")) return { text: "SQL diperiksa setelah node ditambahkan (lihat preview node)." };
    const t = tableOf(input);
    if (!t) return { error: `Input "${label(input)}" sedang error atau belum punya preview` };
    const out = applySteps(t, steps, { names: () => [], table: () => undefined, functions: d.functions });
    if (out.error !== undefined) return { error: `Board ${out.step + 1}: ${out.error}` };
    return { text: `Hasil: ${out.table.rows.length} baris preview · ${out.table.columns.length} kolom (${out.table.columns.slice(0, 8).map((c) => c.name).join(", ")}${out.table.columns.length > 8 ? "…" : ""})` };
  };

  const created = (id: string, what: string) => {
    d.last.current = id;
    setTimeout(() => d.fit([id]), 50);
    return `${what} ditambahkan dan dipilih`;
  };

  const stepsOf = (a: Record<string, unknown>) => toSteps(Array.isArray(a.steps) ? (a.steps as { kind: string; params?: unknown }[]) : []);

  return {
    key: `pipeline:${pipeline.id}`,
    app: `Pipeline Builder — ${pipeline.name}`,
    readOnly: d.readOnly,
    selectHint: "Klik node (Shift+klik / seret dengan Shift untuk beberapa) untuk memilih area yang mau diubah atau disambungkan.",
    onClearSelection: () => d.setSelected([]),
    system:
      `You help build and explain data pipelines in a visual Pipeline Builder (${dialect} semantics). A transform node applies boards (steps) in order; ` +
      "joins combine two nodes; unions stack several. To explain a node (why it exists, why it has the columns or rows it has) use its note, its " +
      "column arithmetic and its boards: give the numbers and name the boards that add, rename or drop columns; column meanings come from the data " +
      "dictionary. When building, prefer boards from the catalog; use SQL when boards cannot express it. " +
      "New nodes go after the selected nodes unless the user names others. To chain proposals, refer to the node made by the previous action as \"@last\".",
    context: (question) => {
      const detail = [...new Set([...sel, ...namedNodes(pipeline, question, 4)])].slice(0, 4);
      return {
        selection: sel.map((id) => ({ id, label: label(id) })),
        // built when a question is sent, not on every render of the panel
        get text() {
          const glossary = pipeline.dictionary ? glossaryFor(question) : "";
          return `${pipelineContext({ pipeline, detail, result, schema: d.schema })}${glossary}\n\n## Board catalog (kind: label — fields)\n${CATALOG}\nParams: ${PARAMS_HINT}`;
        },
      };
    },
    suggestions: (has) =>
      has
        ? ["Jelaskan apa yang dilakukan node terpilih", "Tambahkan transform: buang baris yang kosong lalu urutkan", "Gabungkan (join) node terpilih dengan kunci yang cocok", "Agregasikan per kategori: jumlah & rata-rata"]
        : ["Ringkas alur pipeline ini", "Node mana yang error dan kenapa?", "Usulkan output yang belum ada", "Dataset mana yang belum dipakai?"],
    tools: [
      {
        name: "add_transform",
        description: 'args {"after": node id or "@last", "name": string, "steps": [{"kind": catalog kind, "params": {field: value}}]} — a transform node of boards after one node',
        preview: (a) => {
          const input = resolve(a.after);
          const steps = stepsOf(a);
          const c = check(input, steps);
          return {
            ...c,
            detail: (
              <ol className="space-y-0.5 text-[11px] text-soft">
                <li className="text-muted">setelah: {input ? label(input) : str(a.after) || "?"}</li>
                {steps.map((s, i) => (
                  <li key={s.id}>
                    {i + 1}. {STEPS.find((x) => x.kind === s.kind)?.label ?? s.kind} <span className="font-mono text-muted">{STEPS.find((x) => x.kind === s.kind)?.summary(s.params) ?? ""}</span>
                  </li>
                ))}
              </ol>
            ),
          };
        },
        run: (a) => {
          const input = resolve(a.after);
          const steps = stepsOf(a);
          const c = check(input, steps);
          if (c.error) throw new Error(c.error);
          return created(d.addNode({ kind: "transform", name: str(a.name) || "Transform AIP", input: input!, steps } as Omit<PipelineNode, "id" | "x" | "y">, [input!]), `Transform "${str(a.name) || "Transform AIP"}"`);
        },
      },
      {
        name: "add_sql",
        description: `args {"after": node id or "@last" (the table \`input\`), "name": string, "query": ${dialect}; other nodes are tables by their SQL name} — a SQL transform`,
        preview: (a) => {
          const input = resolve(a.after);
          return {
            error: input ? (str(a.query).trim() ? undefined : "Query kosong") : "Node input tidak ditemukan",
            detail: <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-ink p-1.5 font-mono text-[10px] text-soft">{str(a.query)}</pre>,
            text: input ? `input = ${label(input)}` : undefined,
          };
        },
        run: (a) => {
          const input = resolve(a.after);
          if (!input) throw new Error("Node input tidak ditemukan");
          const name = str(a.name) || "SQL AIP";
          return created(d.addNode({ kind: "transform", name, input, steps: [{ id: uid(), kind: "sql", params: { query: str(a.query) } }] } as Omit<PipelineNode, "id" | "x" | "y">, [input]), `SQL "${name}"`);
        },
      },
      {
        name: "add_join",
        description: `args {"left": node id, "right": node id, "how": ${JOIN_HOWS.join("|")}, "keys": [{"left": column, "right": column}], "name": string, "right_prefix"?: string} — joins two nodes`,
        preview: (a) => {
          const l = resolve(a.left);
          const r = resolve(a.right);
          const keys = Array.isArray(a.keys) ? (a.keys as Record<string, unknown>[]).map((k) => ({ left: str(k.left), right: str(k.right) })) : [];
          const lt = l ? tableOf(l) : null;
          const rt = r ? tableOf(r) : null;
          const how = str(a.how) || "inner";
          let error: string | undefined;
          if (!l || !r) error = "Node kiri/kanan tidak ditemukan";
          else if (!JOIN_HOWS.includes(how as JoinHow)) error = `Jenis join tidak dikenal "${how}"`;
          else if (how !== "cross" && !keys.length) error = "Tidak ada kunci join";
          else {
            const bad = keys.find((k) => (lt && !lt.columns.some((c) => c.name === k.left)) || (rt && !rt.columns.some((c) => c.name === k.right)));
            if (bad) error = `Kolom kunci tidak ada: ${bad.left} = ${bad.right}`;
          }
          return { error, text: l && r ? `${label(l)} ⋈ ${label(r)} (${how}) on ${keys.map((k) => `${k.left} = ${k.right}`).join(", ")}` : undefined };
        },
        run: (a) => {
          const l = resolve(a.left);
          const r = resolve(a.right);
          if (!l || !r) throw new Error("Node kiri/kanan tidak ditemukan");
          const keys = (Array.isArray(a.keys) ? (a.keys as Record<string, unknown>[]) : []).map((k) => ({ left: str(k.left), right: str(k.right) }));
          const name = str(a.name) || `Join ${label(l)} & ${label(r)}`;
          const prefix = str(a.right_prefix);
          const node = { kind: "join", name, left: l, right: r, leftKey: keys[0]?.left ?? "", rightKey: keys[0]?.right ?? "", keys, how: (str(a.how) || "inner") as JoinHow, leftColumns: null, rightColumns: null, ...(prefix ? { rightPrefix: prefix } : {}) };
          return created(d.addNode(node as Omit<PipelineNode, "id" | "x" | "y">, [l, r]), `Join "${name}"`);
        },
      },
      {
        name: "add_union",
        description: `args {"inputs": [node ids], "mode": ${SET_MODES.join("|")}, "name": string} — stacks nodes with the same columns`,
        preview: (a) => {
          const ins = list(a.inputs).map(resolve);
          const mode = str(a.mode) || "union all";
          const missing = ins.some((i) => !i);
          return {
            error: missing ? "Ada input yang tidak ditemukan" : ins.length < 2 ? "Union butuh minimal dua input" : !SET_MODES.includes(mode as SetMode) ? `Mode tidak dikenal "${mode}"` : undefined,
            text: ins.every(Boolean) ? `${mode}: ${ins.map((i) => label(i!)).join(" + ")}` : undefined,
          };
        },
        run: (a) => {
          const ins = list(a.inputs).map(resolve);
          if (ins.length < 2 || ins.some((i) => !i)) throw new Error("Input union tidak lengkap");
          const name = str(a.name) || "Union AIP";
          return created(d.addNode({ kind: "union", name, inputs: ins as string[], mode: (str(a.mode) || "union all") as SetMode } as Omit<PipelineNode, "id" | "x" | "y">, ins as string[]), `Union "${name}"`);
        },
      },
      {
        name: "rename_node",
        description: 'args {"id": node id, "name": string}',
        preview: (a) => {
          const id = resolve(a.id);
          return id ? { text: `"${label(id)}" → "${str(a.name)}"` } : { error: "Node tidak ditemukan" };
        },
        run: (a) => {
          const id = resolve(a.id);
          if (!id || !str(a.name).trim()) throw new Error("Node atau nama tidak valid");
          d.updateNode(id, { name: str(a.name).trim() });
          return "Nama diganti";
        },
      },
      {
        name: "select_nodes",
        description: 'args {"ids": [node ids]} — selects and zooms to nodes (to point at them)',
        safe: true,
        preview: (a) => {
          const ids = list(a.ids).map(resolve).filter((x): x is string => !!x);
          return ids.length ? { text: ids.map(label).join(", ") } : { error: "Node tidak ditemukan" };
        },
        run: (a) => {
          const ids = list(a.ids).map(resolve).filter((x): x is string => !!x);
          d.setSelected(ids);
          setTimeout(() => d.fit(ids), 50);
          return `${ids.length} node dipilih`;
        },
      },
    ],
  };
}
