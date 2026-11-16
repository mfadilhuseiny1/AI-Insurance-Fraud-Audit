/** Workflow Builder copy and paste: a node, or a whole workflow (from its trigger or subgraph start, with the subgraphs
 *  it calls), as JSON on the system clipboard, pasted into the same or another graph with fresh node ids. */
import type { WBDoc, WBEdge, WBNode } from "./workflowBuilder";

export const CLIP_KIND = "bluesandai.workflow-builder.clip";
export type WBClip = { kind: typeof CLIP_KIND; nodes: WBNode[]; edges: WBEdge[]; params: WBDoc["params"]; label: string };

/** Everything a start node runs: nodes reachable along edges, the after-fork / after-loop nodes of forks and loops,
 *  and (recursively) the subgraphs its call-subgraph nodes call. */
export function workflowNodes(doc: WBDoc, start: string): Set<string> {
  const out = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) continue;
    out.add(id);
    for (const e of doc.edges) if (e.from === id) stack.push(e.to);
    for (const x of doc.nodes) if ((x.type === "after_fork" || x.type === "after_loop") && x.config.of === id) stack.push(x.id);
    if (n.type === "call_subgraph" && typeof n.config.subgraph === "string") stack.push(n.config.subgraph);
  }
  return out;
}

export function copyClip(doc: WBDoc, id: string): WBClip | null {
  const n = doc.nodes.find((x) => x.id === id);
  if (!n || n.type === "after_fork" || n.type === "after_loop") return null;
  const whole = n.type === "trigger" || n.type === "subgraph";
  const ids = whole ? workflowNodes(doc, id) : new Set([id, ...doc.nodes.filter((x) => (x.type === "after_fork" || x.type === "after_loop") && x.config.of === id).map((x) => x.id)]);
  const nodes = doc.nodes.filter((x) => ids.has(x.id));
  const text = JSON.stringify(nodes.map((x) => x.config));
  return {
    kind: CLIP_KIND,
    nodes,
    edges: doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    // the graph parameters the copied nodes use (params.<name>)
    params: doc.params.filter((p) => text.includes(`params.${p.name}`)),
    label: whole ? `workflow "${n.name}" (${nodes.length} nodes)` : `node "${n.name}"`,
  };
}

export function readClip(text: string): WBClip | null {
  try {
    const c = JSON.parse(text) as WBClip;
    return c && c.kind === CLIP_KIND && Array.isArray(c.nodes) && Array.isArray(c.edges) ? c : null;
  } catch {
    return null;
  }
}

/** The document with the clip pasted below the existing nodes (or at `at`): new ids, internal edges and references
 *  (after-fork / after-loop owners, called subgraphs) remapped, missing parameters added. */
export function pasteClip(doc: WBDoc, clip: WBClip, newId: () => string, at?: { x: number; y: number }): { doc: WBDoc; ids: string[] } {
  const map = new Map<string, string>();
  for (const n of clip.nodes) map.set(n.id, newId());
  const minX = Math.min(...clip.nodes.map((n) => n.x));
  const minY = Math.min(...clip.nodes.map((n) => n.y));
  const base = at ?? { x: minX, y: (doc.nodes.length ? Math.max(...doc.nodes.map((n) => n.y)) : 0) + 140 };
  const names = new Set(doc.nodes.map((n) => n.name));
  const nodes = clip.nodes.map((n) => {
    const config = { ...n.config };
    if (typeof config.of === "string" && map.has(config.of)) config.of = map.get(config.of);
    // a called subgraph: the pasted copy, else one of this graph with the same id
    if (n.type === "call_subgraph" && typeof config.subgraph === "string") config.subgraph = map.get(config.subgraph) ?? (doc.nodes.some((x) => x.id === config.subgraph) ? config.subgraph : "");
    const name = names.has(n.name) && (n.type === "trigger" || n.type === "subgraph") ? `${n.name} (copy)` : n.name;
    return { ...n, id: map.get(n.id)!, name, x: Math.round(base.x + (n.x - minX)), y: Math.round(base.y + (n.y - minY)), config };
  });
  const edges = clip.edges.map((e) => ({ ...e, from: map.get(e.from)!, to: map.get(e.to)! }));
  const have = new Set(doc.params.map((p) => p.name));
  return { doc: { ...doc, nodes: [...doc.nodes, ...nodes], edges: [...doc.edges, ...edges], params: [...doc.params, ...clip.params.filter((p) => !have.has(p.name))] }, ids: nodes.map((n) => n.id) };
}
