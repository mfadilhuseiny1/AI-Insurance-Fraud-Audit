/**
 * Graph helpers for Pipeline Builder: automatic layout, what is hidden (by node, folder or colour group),
 * how hidden nodes are bridged by dotted edges, and folder trees.
 */
import { inputsOf, referencedNodes, refNode, type LegendColor, type Output, type Pipeline, type PipelineFolder, type PipelineNode } from "./pipeline";

export const GRID = 20;
export const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * Swimlane layout, left to right: each legend colour is a horizontal lane (in `lanes` order, then the other colours,
 * uncoloured nodes last); a node sits one column right of the deepest node it reads (its inputs and the nodes its
 * steps read by table name), and within its lane level with the inputs it continues (their mean row), so chains run
 * straight and a lane's nodes stay together. An output sits in the column right of its node, clear of the nodes and
 * outputs already there.
 */
export function autoLayout(
  nodes: PipelineNode[],
  outputs: Output[],
  size: (n: PipelineNode) => { w: number; h: number },
  outSize: { w: number; h: number },
  lanes: string[] = [],
): { nodes: Map<string, { x: number; y: number }>; outputs: Map<string, { x: number; y: number }> } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refs = referencedNodes(nodes);
  const reads = (n: PipelineNode) => [...inputsOf(n).map(refNode), ...(refs.get(n.id) ?? []).map((r) => r.id)].filter((id) => byId.has(id));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    const n = byId.get(id);
    if (!n || seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...reads(n).map((i) => depthOf(i, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => depthOf(n.id));

  const colW = Math.max(...nodes.map((n) => size(n).w), outSize.w) + 110;
  const xOf = (d: number) => 80 + d * colW;
  const laneOf = (n: PipelineNode) => n.color ?? "";
  const order = [...new Set([...lanes, ...nodes.map(laneOf).filter(Boolean), ""])];
  const pos = new Map<string, { x: number; y: number }>();
  const outPos = new Map<string, { x: number; y: number }>();
  // what is placed in each column: [top, bottom) spans, to keep outputs clear of them
  const taken = new Map<number, [number, number][]>();
  const take = (x: number, y: number, h: number) => (taken.get(x) ?? taken.set(x, []).get(x)!).push([y, y + h]);
  const free = (x: number, y: number, h: number) => {
    let at = y;
    for (let moved = true; moved; ) {
      moved = false;
      for (const [a, b] of taken.get(x) ?? [])
        if (at < b + 30 && at + h + 30 > a) {
          at = b + 40;
          moved = true;
        }
    }
    return snap(at);
  };
  let top = 80;
  for (const lane of order) {
    const members = nodes.filter((n) => laneOf(n) === lane);
    if (!members.length) continue;
    let bottom = top;
    for (const d of [...new Set(members.map((n) => depth.get(n.id)!))].sort((a, b) => a - b)) {
      const column = members.filter((n) => depth.get(n.id) === d);
      const want = new Map(
        column.map((n, i) => {
          const ups = reads(n).filter((r) => laneOf(byId.get(r)!) === lane).map((r) => pos.get(r)?.y).filter((y): y is number => y !== undefined);
          // sources and nodes reading only other lanes keep their current order
          return [n.id, ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : top + i * 0.001 + (d === 0 ? n.y * 1e-6 : 0)];
        }),
      );
      column.sort((a, b) => want.get(a.id)! - want.get(b.id)!);
      let y = top;
      for (const n of column) {
        const at = snap(Math.max(y, want.get(n.id)!));
        pos.set(n.id, { x: xOf(d), y: at });
        take(xOf(d), at, size(n).h);
        y = at + size(n).h + 40;
        bottom = Math.max(bottom, y);
      }
    }
    for (const o of outputs.filter((o) => members.some((n) => n.id === refNode(o.node))).sort((a, b) => pos.get(refNode(a.node))!.y - pos.get(refNode(b.node))!.y)) {
      const src = pos.get(refNode(o.node))!;
      const x = xOf(depth.get(refNode(o.node))! + 1);
      const y = free(x, src.y, outSize.h);
      outPos.set(o.id, { x, y });
      take(x, y, outSize.h);
      bottom = Math.max(bottom, y + outSize.h + 40);
    }
    top = snap(bottom + 80);
  }
  return { nodes: pos, outputs: outPos };
}

/** Folder ids inside `id` (itself included). */
export function folderSubtree(folders: PipelineFolder[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders)
      if (f.parent && out.has(f.parent) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
  }
  return out;
}

/** Folders hidden directly or through a hidden parent. */
export function hiddenFolders(folders: PipelineFolder[] = []): Set<string> {
  const out = new Set<string>();
  for (const f of folders) if (f.hidden) for (const id of folderSubtree(folders, f.id)) out.add(id);
  return out;
}

/** Every node id (and OUT-prefixed output id) not drawn on the graph. */
export function hiddenIds(p: Pick<Pipeline, "nodes" | "hidden" | "folders" | "legend" | "outputs">, outPrefix: string): Set<string> {
  const out = new Set(p.hidden ?? []);
  const hf = hiddenFolders(p.folders);
  const hiddenColors = new Set(p.legend.filter((c: LegendColor) => c.hidden).map((c) => c.id));
  for (const n of p.nodes) {
    if (n.folder && hf.has(n.folder)) out.add(n.id);
    if (n.color && hiddenColors.has(n.color)) out.add(n.id);
  }
  // an output is hidden with its input node
  for (const o of p.outputs) if (out.has(refNode(o.node))) out.add(outPrefix + o.id);
  return out;
}

/** For a visible node: its nearest visible ancestors reached through hidden nodes (drawn as dotted edges), and how many hidden inputs it has. */
export function bridgedInputs(nodes: PipelineNode[], hidden: Set<string>, id: string): { refs: string[]; hiddenCount: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const n = byId.get(id);
  if (!n) return { refs: [], hiddenCount: 0 };
  const refs = new Set<string>();
  const seen = new Set<string>();
  let hiddenCount = 0;
  const walk = (ref: string) => {
    const up = refNode(ref);
    if (seen.has(up)) return;
    seen.add(up);
    if (!hidden.has(up)) {
      refs.add(ref);
      return;
    }
    hiddenCount++;
    const node = byId.get(up);
    if (node) inputsOf(node).forEach(walk);
  };
  for (const i of inputsOf(n)) if (hidden.has(refNode(i))) walk(i);
  return { refs: [...refs], hiddenCount };
}
