/**
 * Copy and paste of Code Workbook nodes between workbooks: the copied node comes with everything upstream of it, so
 * the pasted part runs on its own. Pasting reuses the target's imported datasets, renames nodes whose names are
 * taken (and rewrites the references in the pasted code), and brings the workbook templates the nodes use.
 */
import type { WbNode, WbTemplate } from "./codeWorkbook";

export type Clip = { version: 1; workbook: string; nodes: WbNode[]; templates: WbTemplate[] };
export const CLIP_KEY = "bluesandai.codeWorkbook.clipboard";

/** The node and its upstream nodes, with the templates they use. */
export function copyNodes(nodes: WbNode[], ids: string[], templates: WbTemplate[], workbook: string): Clip {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Set<string>();
  const walk = (id: string) => {
    const n = byId.get(id);
    if (!n || keep.has(id)) return;
    keep.add(id);
    n.inputs.forEach(walk);
  };
  ids.forEach(walk);
  const picked = nodes.filter((n) => keep.has(n.id)).map((n) => {
    const c: WbNode = JSON.parse(JSON.stringify(n));
    delete c.dataset_out;
    delete c.built_at;
    return c;
  });
  const used = new Set(picked.map((n) => n.template?.id).filter(Boolean));
  return { version: 1, workbook, nodes: picked, templates: templates.filter((t) => used.has(t.id)) };
}

// one pass, so a rename chain (a → b, b → c) does not apply twice; node names are identifiers
const rewrite = (code: string, renames: Map<string, string>) =>
  renames.size ? code.replace(new RegExp(`\\b(${[...renames.keys()].join("|")})\\b`, "g"), (m) => renames.get(m) ?? m) : code;

/**
 * The target's nodes and templates after pasting; `pasted` lists the new nodes' ids. `bind` maps copied nodes (a
 * template's inputs) to nodes of the target that take their place.
 */
export function pasteNodes(target: WbNode[], targetTemplates: WbTemplate[], clip: Clip, offset = { x: 40, y: 40 }, bind: Record<string, string> = {}): { nodes: WbNode[]; templates: WbTemplate[]; pasted: string[]; renamed: Record<string, string> } {
  const names = new Set(target.map((n) => n.name));
  const idMap = new Map<string, string>();
  const renames = new Map<string, string>();
  const out: WbNode[] = [];
  const minX = Math.min(...clip.nodes.map((n) => n.x ?? 0));
  const minY = Math.min(...clip.nodes.map((n) => n.y ?? 0));
  const baseY = Math.max(0, ...target.map((n) => (n.y ?? 0) + 110));
  for (const n of clip.nodes) {
    // an imported dataset the target already has: reuse its node
    const same = bind[n.id]
      ? target.find((t) => t.id === bind[n.id])
      : n.kind === "input" && n.dataset_id
        ? target.find((t) => t.kind === "input" && t.dataset_id === n.dataset_id)
        : undefined;
    if (same) {
      idMap.set(n.id, same.id);
      if (same.name !== n.name) renames.set(n.name, same.name);
      continue;
    }
    let name = n.name;
    for (let k = 2; names.has(name); k++) name = `${n.name}_${k}`;
    names.add(name);
    if (name !== n.name) renames.set(n.name, name);
    idMap.set(n.id, `n${Math.random().toString(36).slice(2, 10)}`);
  }
  for (const n of clip.nodes) {
    const nid = idMap.get(n.id)!;
    if (target.some((t) => t.id === nid)) continue;
    const c: WbNode = {
      ...n,
      id: nid,
      name: renames.get(n.name) ?? n.name,
      inputs: n.inputs.map((i) => idMap.get(i) ?? i).filter((i) => target.some((t) => t.id === i) || [...idMap.values()].includes(i)),
      x: (n.x ?? 0) - minX + offset.x,
      y: (n.y ?? 0) - minY + baseY + offset.y,
    };
    if (c.code) c.code = rewrite(c.code, renames);
    if (c.template) c.template = { ...c.template, values: Object.fromEntries(Object.entries(c.template.values).map(([k, v]) => [k, renames.get(v) ?? v])) };
    out.push(c);
  }
  const have = new Set(targetTemplates.map((t) => t.id));
  return {
    nodes: [...target, ...out],
    templates: [...targetTemplates, ...clip.templates.filter((t) => !have.has(t.id))],
    pasted: out.map((n) => n.id),
    renamed: Object.fromEntries(renames),
  };
}
