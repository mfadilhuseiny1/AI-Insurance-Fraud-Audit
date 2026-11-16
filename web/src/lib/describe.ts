/**
 * Text descriptions of pipeline logic: pseudocode lines for collapsed transform nodes (User preferences →
 * Collapsed transform style), and a plain-language explanation of selected nodes (Explain) used when no
 * LLM is available and as the context sent to one.
 */
import { effectiveOutputType, TEMPLATE_INFO } from "./llm";
import {
  describeGroup,
  FALSE_PORT,
  inputsOf,
  joinKeys,
  readFilter,
  refLabel,
  stepDefOf,
  type CustomFunction,
  type Output,
  type PipelineNode,
  type Step,
  type Subgraph,
} from "./pipeline";

const fnName = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** One pseudocode line per board of a transform node (other nodes: one line). */
export function pseudocode(n: PipelineNode, nodes: PipelineNode[], functions?: CustomFunction[], subgraphs?: Subgraph[]): string[] {
  const name = (ref: string) => refLabel(nodes, ref);
  switch (n.kind) {
    case "transform":
      return n.steps.map((s) => {
        const def = stepDefOf(s.kind, functions);
        return `${fnName(def?.label ?? s.kind)}(${def ? def.summary(s.params) : ""})`;
      });
    case "join":
      return [`${n.how}_join(${name(n.left)}, ${name(n.right)}) on ${joinKeys(n).map((k) => `${k.left} ${k.op ?? "="} ${k.right}`).join(" and ") || "?"}`];
    case "union":
      return [`${(n.mode ?? "union all").replace(/\s+/g, "_")}(${n.inputs.map(name).join(", ")})`];
    case "split":
      return [`split(${name(n.input)}) where ${safeGroup(n.condition)}`];
    case "subgraph":
      return [`${fnName(subgraphs?.find((s) => s.id === n.subgraph)?.name ?? "subgraph")}(${n.inputs.map(name).join(", ")})`];
    case "llm":
      return [`use_llm(${n.config.model}, ${TEMPLATE_INFO[n.config.template].label}) → ${n.config.outputColumn}: ${effectiveOutputType(n.config)}`];
    case "model":
      return [`predict(${n.model?.name ?? "?"}, ${n.features.join(", ")}) → ${n.output}`];
    case "source":
      return [`read(${n.name})${n.mode === "incremental" ? " incrementally" : ""}`];
    case "input":
      return [`input(${n.name})`];
  }
}

const safeGroup = (json: string) => {
  try {
    return describeGroup(readFilter({ filter: json }));
  } catch {
    return "?";
  }
};

/** A plain-language explanation of nodes, in graph order. */
export function explainNodes(ids: string[], nodes: PipelineNode[], outputs: Output[], functions?: CustomFunction[], subgraphs?: Subgraph[]): string {
  const chosen = nodes.filter((n) => ids.includes(n.id));
  if (!chosen.length) return "Select nodes to explain.";
  const lines: string[] = [];
  for (const n of chosen) {
    const ins = inputsOf(n).map((r) => `"${refLabel(nodes, r)}"`);
    switch (n.kind) {
      case "source":
        lines.push(`**${n.name}** is an input dataset${n.mode === "incremental" ? ", read incrementally (only new rows each build)" : ""}.`);
        break;
      case "transform":
        lines.push(
          `**${n.name}** transforms ${ins.join(", ")} with ${n.steps.length} board${n.steps.length === 1 ? "" : "s"}: ${
            n.steps.map((s) => {
              const def = stepDefOf(s.kind, functions);
              return `${def?.label ?? s.kind} (${def?.summary(s.params) || "…"})`;
            }).join("; then ") || "none yet"
          }.`,
        );
        break;
      case "join":
        lines.push(`**${n.name}** is a ${n.how} join of ${ins.join(" with ")} matching ${joinKeys(n).map((k) => `${k.left} ${k.op ?? "="} ${k.right}`).join(" and ") || "every row (cross)"}${n.rightPrefix ? `; right columns are prefixed "${n.rightPrefix}"` : ""}.`);
        break;
      case "union":
        lines.push(`**${n.name}** combines ${ins.join(", ")} (${n.mode ?? "union all"}).`);
        break;
      case "split":
        lines.push(`**${n.name}** splits ${ins[0]}: rows where ${safeGroup(n.condition)} go to the True output, the others to False.`);
        break;
      case "subgraph":
        lines.push(`**${n.name}** applies the subgraph "${subgraphs?.find((s) => s.id === n.subgraph)?.name ?? "?"}" to ${ins.join(", ")}.`);
        break;
      case "llm":
        lines.push(`**${n.name}** runs ${n.config.model} over each row of ${ins[0]} (${TEMPLATE_INFO[n.config.template].label}) and writes the answer to "${n.config.outputColumn}".`);
        break;
      case "model":
        lines.push(`**${n.name}** predicts "${n.output}" with the model "${n.model?.name}" from ${n.features.join(", ")}.`);
        break;
      case "input":
        lines.push(`**${n.name}** is a subgraph input.`);
        break;
    }
    const outs = outputs.filter((o) => o.node === n.id || o.node === n.id + FALSE_PORT);
    if (outs.length) lines.push(`  It is written to the output${outs.length > 1 ? "s" : ""} ${outs.map((o) => `"${o.name}"`).join(", ")}.`);
  }
  return lines.join("\n");
}

/** A transform node's boards in plain language (Explain on a transform board). */
export function explainSteps(name: string, steps: Step[], functions?: CustomFunction[]): string {
  if (!steps.length) return `**${name}** has no boards yet.`;
  return [
    `**${name}** applies ${steps.length} board${steps.length === 1 ? "" : "s"} in order:`,
    ...steps.map((s, i) => {
      const def = stepDefOf(s.kind, functions);
      return `${i + 1}. ${def?.label ?? s.kind}: ${def?.summary(s.params) || "not configured"}${def?.description ? ` — ${def.description.split(". ")[0]}.` : ""}`;
    }),
  ].join("\n");
}
