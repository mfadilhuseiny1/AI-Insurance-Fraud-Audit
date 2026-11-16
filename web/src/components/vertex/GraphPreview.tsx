"use client";

import { useState } from "react";
import type { IconName } from "@/components/Icon";
import { FlowCanvas, flowLayout, nodeColor, PALETTE, type Pos } from "@/components/vertex/FlowCanvas";
import type { Graph, GroupedEdge, VEdge, VEvent, VNode } from "@/lib/vertex";

export type GraphPreviewData = {
  graph: Pick<Graph, "id" | "name" | "nodes" | "layout" | "layers" | "edge_styles" | "edge_groups" | "line_type">;
  nodes: VNode[];
  edges: VEdge[];
  grouped_edges: GroupedEdge[];
  types: { id: string; display_name: string; icon?: string | null; index: number }[];
};

const NO_EVENTS = new Map<string, VEvent[]>();
const NOTHING = new Set<string>();

/** Saved positions of a graph's nodes; nodes without one are placed by the system flow layout. */
export function positions(d: GraphPreviewData): Pos {
  const pos: Pos = {};
  for (const n of d.graph.nodes ?? []) {
    const q = n as { object_type_id: string; primary_key: string; x?: number; y?: number };
    if (typeof q.x === "number" && typeof q.y === "number") pos[`${q.object_type_id}|${q.primary_key}`] = { x: q.x, y: q.y };
  }
  if (d.nodes.some((n) => !pos[n.id])) {
    const fresh = flowLayout(d.nodes, [...d.edges, ...d.grouped_edges], d.graph.layers ?? {});
    for (const n of d.nodes) pos[n.id] ??= fresh[n.id];
  }
  return pos;
}

/** A saved Vertex graph, read-only (nodes can be moved for a closer look; nothing is saved). */
export function GraphPreview({ data, height = 420 }: { data: GraphPreviewData; height?: number }) {
  const g = data.graph;
  const layers = g.layers ?? {};
  const [pos, setPos] = useState<Pos>(() => positions(data));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const typeOf = Object.fromEntries(data.types.map((t) => [t.id, t]));
  const nodes = data.nodes.filter((n) => !layers[n.object_type_id]?.hidden);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && !g.edge_styles?.[e.link_type_id]?.hidden);
  const grouped = data.grouped_edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  if (!nodes.length) return <p className="p-3 text-xs text-muted">This graph has no objects.</p>;
  return (
    <div className="flex flex-col overflow-hidden rounded bg-ink" style={{ height }}>
      <FlowCanvas
        nodes={nodes}
        edges={edges}
        grouped={grouped}
        groupFormat={(ge) => (g.edge_groups ?? []).find((x) => x.id === ge.group_id)?.format}
        pos={pos}
        setPos={setPos}
        selected={selected}
        setSelected={setSelected}
        selectedEdge={selectedEdge}
        setSelectedEdge={setSelectedEdge}
        color={(n) => nodeColor(n, layers[n.object_type_id], PALETTE[(typeOf[n.object_type_id]?.index ?? 0) % PALETTE.length])}
        icon={(n) => (layers[n.object_type_id]?.node_style === "circle" ? null : (((layers[n.object_type_id]?.icon ?? typeOf[n.object_type_id]?.icon ?? "cube") as IconName) || "cube"))}
        label={(n) => {
          const lp = layers[n.object_type_id]?.label_property;
          return lp ? String(n.properties[lp] ?? n.title) : n.title;
        }}
        size={(n) => {
          const sp = layers[n.object_type_id]?.size_property;
          if (!sp) return 14;
          const max = Math.max(1, ...data.nodes.filter((x) => x.object_type_id === n.object_type_id).map((x) => Number(x.properties[sp]) || 0));
          return 9 + 14 * Math.sqrt((Number(n.properties[sp]) || 0) / max);
        }}
        changed={NOTHING}
        events={NO_EVENTS}
        edgeStyle={(e) => g.edge_styles?.[e.link_type_id]}
        line={g.line_type ?? (g.layout === "flow" ? "curved" : "straight")}
      />
    </div>
  );
}
