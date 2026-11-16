/**
 * What a deploy builds and whether it may: output selection by schedule target, deployment validation
 * (shared by the deploy dialog in the browser and the build runner), and the branch a build reads.
 */
import { conversionFindings } from "./compat";
import { externalProblems } from "./externalSql";
import { incrementalInputs, inputsOf, isStatefulOutput, keyedProcessUdfs, refNode, writeModeProblems, type Output, type Pipeline, type PipelineNode } from "./pipeline";


function ancestorsOf(nodes: PipelineNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const walk = (ref: string) => {
    const n = byId.get(refNode(ref));
    if (!n) return;
    for (const i of inputsOf(n)) if (!out.has(refNode(i))) {
      out.add(refNode(i));
      walk(i);
    }
  };
  walk(id);
  return out;
}

export function selectOutputs(p: Pipeline, wanted: string[], target: string): Output[] {
  const all = p.outputs;
  if (!wanted.length) return all;
  const chosen = all.filter((o) => wanted.includes(o.id));
  if (target === "single") return chosen;
  const nodeOf = (o: Output) => refNode(o.node);
  const result = new Set(chosen.map((o) => o.id));
  if (target === "withUpstream" || target === "between")
    for (const c of chosen) {
      const ups = ancestorsOf(p.nodes, nodeOf(c));
      for (const o of all) if (ups.has(nodeOf(o))) result.add(o.id);
    }
  if (target === "downstream" || target === "between")
    for (const c of chosen) for (const o of all) if (ancestorsOf(p.nodes, nodeOf(o)).has(nodeOf(c))) result.add(o.id);
  if (target === "between" && chosen.length >= 2) {
    // outputs on a path between the first and the last chosen output
    const from = nodeOf(chosen[0]);
    const to = nodeOf(chosen[chosen.length - 1]);
    const between = all.filter((o) => ancestorsOf(p.nodes, nodeOf(o)).has(from) && ancestorsOf(p.nodes, to).has(nodeOf(o)));
    return [...new Map([...chosen, ...between].map((o) => [o.id, o])).values()];
  }
  return all.filter((o) => result.has(o.id));
}

// ---------------------------------------------------------------- validation

const LARGE = new Set(["l", "xl"]);
export function validate(p: Pipeline, outputs: Output[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const compute = p.compute ?? "standard";
  if (!outputs.length) errors.push("The pipeline has no outputs to build");
  const hasDataset = outputs.some((o) => (o.kind ?? "dataset") === "dataset" || ["icebergTable", "objectType", "linkType", "timeSeries", "geotemporal"].includes(o.kind ?? ""));
  if (compute !== "external" && outputs.length && !hasDataset) errors.push("Job has no foundry output datasets — add at least one dataset output (virtual tables, files and media sets do not count)");
  const profile = p.buildSettings?.profile ?? "xs";
  if (compute === "standard" && LARGE.has(profile) && !(p.buildSettings?.importedProfiles ?? []).includes(profile))
    errors.push(`The ${profile === "l" ? "Large" : "Extra Large"} compute profile is not imported to this project — select Import compute profiles in Build settings`);
  if (compute !== "standard") for (const f of conversionFindings(p, compute)) errors.push(`${f.title}: ${f.detail}`);
  // external pipelines: every output must compile to one SQL statement for the source (the rest cannot be pushed down)
  if (compute === "external") for (const e of externalProblems(p, outputs)) if (!errors.some((x) => e.includes(x) || x.includes(e))) errors.push(e);
  for (const o of outputs) {
    if (!o.name.trim()) errors.push("An output needs a name");
    if ((o.kind ?? "dataset") === "virtualTable" && !o.virtualTable?.connectionId) errors.push(`${o.name}: choose the source of the virtual table`);
    errors.push(...writeModeProblems(o, null));
  }
  if (p.buildSettings?.requireIncremental && !outputs.some((o) => incrementalInputs(p, o.node).length))
    errors.push("Require incremental execution is on, but no output reads an incremental input — mark an input as incremental or turn the setting off (Build settings)");
  // an LLM node with Skip recomputing rows must feed all its outputs from one job group
  for (const n of p.nodes)
    if (n.kind === "llm" && n.config.skipRecompute) {
      const users = outputs.filter((o) => refNode(o.node) === n.id || ancestorsOf(p.nodes, refNode(o.node)).has(n.id));
      const groups = new Set(users.map((o) => o.jobGroup ?? `single:${o.id}`));
      if (groups.size > 1) errors.push(`"${n.name}" skips recomputing rows and feeds ${users.length} outputs in different jobs — put them in the same job group`);
    }
  // a stateful output re-reads the records kept as state every poll: a keyed process UDF there would see them again
  if (p.type === "streaming")
    for (const o of outputs) {
      const keyed = keyedProcessUdfs(p, o.node);
      if (keyed.length && isStatefulOutput(p, o.node))
        errors.push(`${o.name}: keyed process UDF ${keyed.join(", ")} cannot feed an output with stateful transforms (aggregations, windows, dedupe …) — keep that state in the UDF instead`);
    }
  if (p.type === "streaming" && !p.buildSettings?.consistency) warnings.push("No stream consistency guarantee is configured (Build settings → Stream behavior)");
  return { errors, warnings };
}

/** The pipeline a build reads: the branch's content over the main pipeline (datasets are shared). */
export function branchContent(content: Record<string, unknown>, branch: string, versionId?: string): Record<string, unknown> {
  type Vc = {
    branches?: Record<string, { content: Record<string, unknown>; fallbacks?: string[] }>;
    versions?: { id?: string; branch: string; at: string; content: Record<string, unknown> }[];
  };
  const vc = content.vc as Vc | undefined;
  const b = branch || "main";
  // a build reads what was saved last on the branch (or the saved version asked for); its working copy when it was never saved
  const saved = (vc?.versions ?? []).filter((v) => (versionId ? v.id === versionId : v.branch === b)).sort((x, y) => y.at.localeCompare(x.at))[0]?.content;
  const working = b === "main" ? undefined : vc?.branches?.[b]?.content;
  const logic = saved ?? working;
  if (!logic) return content;
  return { ...content, ...logic, datasets: content.datasets, vc: content.vc };
}

/** The branches an input is looked up on: the branch, its fallbacks, then main. */
export function fallbackChain(content: Record<string, unknown>, branch: string): string[] {
  const vc = content.vc as { branches?: Record<string, { fallbacks?: string[] }> } | undefined;
  if (!branch || branch === "main") return ["main"];
  return [...new Set([branch, ...(vc?.branches?.[branch]?.fallbacks ?? []), "main"])];
}

/** A branch build writes "name [branch]" next to main's output, never over it. */
export const branchOutputName = (name: string, branch: string) => (branch && branch !== "main" ? `${name} [${branch}]` : name);

