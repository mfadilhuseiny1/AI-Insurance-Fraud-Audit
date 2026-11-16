/**
 * What a pipeline uses that a faster or external pipeline does not support (the conversion checks), and
 * the other warnings of the Pipeline warnings panel.
 */
import { stepDefOf, type BatchCompute, type Pipeline, type PipelineNode } from "./pipeline";

export type Finding = { node?: string; output?: string; title: string; detail: string; kind: "conversion" | "compute" | "pruned" | "sampling" | "schema" | "deploy" };

/** Step categories that need features faster / external pipelines do not have. */
const MEDIA_CATEGORIES = new Set(["Media"]);
const GEO_CATEGORIES = new Set(["Geospatial"]);

function stepProblems(n: PipelineNode, p: Pipeline, target: BatchCompute): string[] {
  if (n.kind !== "transform") return [];
  const out: string[] = [];
  for (const s of n.steps) {
    const def = stepDefOf(s.kind, p.functions);
    if (!def) continue;
    if (MEDIA_CATEGORIES.has(def.category)) out.push(`${def.label}: media set operations are not supported`);
    else if (GEO_CATEGORIES.has(def.category)) out.push(`${def.label}: geospatial functionality is not supported`);
    else if (target === "external" && s.kind.startsWith("fn:")) out.push(`${def.label}: user-defined functions are not supported`);
    else if (target === "faster" && (s.kind === "time_window" || s.kind === "sql_udf")) out.push(`${def.label}: creating time series reference values is not supported`);
  }
  return out;
}

/** Transforms and expressions incompatible with the target pipeline type. */
export function conversionFindings(p: Pipeline, target: BatchCompute): Finding[] {
  if (target === "standard") return [];
  const out: Finding[] = [];
  const label = target === "faster" ? "faster" : "external";
  for (const n of p.nodes) {
    const add = (detail: string) => out.push({ node: n.id, title: n.name, detail, kind: "conversion" });
    if (n.kind === "llm") add(`Use LLM is not supported in ${label} pipelines`);
    if (n.kind === "model" && target === "faster") add("Trained model nodes are not supported in faster pipelines");
    if (n.kind === "model" && target === "external") add("Trained model nodes are not supported in external pipelines");
    if (target === "external" && n.kind === "union") add("Union is not supported in external pipelines");
    if (target === "external" && n.kind === "source") {
      const ds = p.datasets[n.datasetId];
      if (n.mode === "incremental") add("Incremental computation is not supported in external pipelines");
      if (ds && ds.ref?.kind !== "virtual") add("External pipelines read virtual tables from their source only — this is a dataset");
      if (ds?.ref?.kind === "virtual" && p.external && ds.ref.connectionId !== p.external.connectionId) add("This virtual table is from another source");
    }
    if (target === "faster" && n.kind === "source" && p.datasets[n.datasetId]?.media) add("Media sets are not supported in faster pipelines");
    for (const s of stepProblems(n, p, target)) add(s);
  }
  if (target === "external")
    for (const o of p.outputs)
      if ((o.kind ?? "dataset") !== "virtualTable") out.push({ output: o.id, title: o.name, detail: "External pipelines write virtual table outputs only", kind: "conversion" });
  return out;
}

/** Nodes no output depends on: they are pruned from builds. */
export function prunedNodes(p: Pick<Pipeline, "nodes" | "outputs">): Set<string> {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const used = new Set<string>();
  const walk = (ref: string) => {
    const id = ref.split("#")[0];
    if (used.has(id)) return;
    const n = byId.get(id);
    if (!n) return;
    used.add(id);
    for (const i of inputRefs(n)) walk(i);
  };
  for (const o of p.outputs) walk(o.node);
  return new Set(p.nodes.filter((n) => !used.has(n.id)).map((n) => n.id));
}

const inputRefs = (n: PipelineNode): string[] =>
  n.kind === "source" || n.kind === "input" ? [] : n.kind === "join" ? [n.left, n.right] : n.kind === "union" || n.kind === "subgraph" ? n.inputs : [n.input];

/** Warnings shown in the Pipeline warnings panel. */
export function pipelineWarnings(p: Pipeline): Finding[] {
  const out: Finding[] = [];
  const compute = p.compute ?? "standard";
  if (p.showConversionChecks && compute === "standard") out.push(...conversionFindings(p, "faster").map((f) => ({ ...f, title: `Faster conversion: ${f.title}` })));
  if (compute !== "standard") out.push(...conversionFindings(p, compute));
  for (const n of p.nodes) {
    if (n.kind === "llm")
      out.push({
        node: n.id,
        title: n.name,
        detail: "Calls an LLM for every row — an expensive computation. Check the compute profile in Build settings, and consider Skip recomputing rows.",
        kind: "compute",
      });
    if (n.kind === "transform" && n.steps.some((s) => s.kind === "embed" || s.kind === "chunk"))
      out.push({ node: n.id, title: n.name, detail: "Embeddings and chunking are expensive; native acceleration does not help them — use a standard compute profile.", kind: "compute" });
    if (n.kind === "source" && n.sampling && n.sampling.kind !== "none")
      out.push({ node: n.id, title: n.name, detail: "Previews read a sample of this input; deploys read every row.", kind: "sampling" });
  }
  if (p.outputs.length) for (const id of prunedNodes(p)) {
    const n = p.nodes.find((x) => x.id === id)!;
    out.push({ node: id, title: n.name, detail: "Not connected to any output — pruned from builds.", kind: "pruned" });
  }
  const hasDataset = p.outputs.some((o) => (o.kind ?? "dataset") === "dataset");
  if (p.outputs.length && !hasDataset && compute !== "external")
    out.push({ title: "Outputs", detail: "Pipelines must include at least one dataset output — deploys fail with \"Job has no foundry output datasets\".", kind: "deploy" });
  return out;
}
