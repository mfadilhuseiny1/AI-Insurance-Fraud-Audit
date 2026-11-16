"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bounds, Canvas, type View } from "@/components/solutionDesigner/Canvas";
import { sd, type Graph } from "@/lib/solutionDesigner";

type Catalog = Awaited<ReturnType<typeof sd.catalog>>;

/** A Solution Designer diagram, read-only and fitted to the box (Notepad's Solution Designer widget). */
export function DiagramPreview({ graph, height = 420 }: { graph: Graph; height?: number }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    sd.catalog().then(setCatalog, () => setCatalog(null));
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const comps = useMemo(() => Object.fromEntries((catalog?.components ?? []).map((c) => [c.id, c])), [catalog]);
  const concepts = useMemo(() => Object.fromEntries((catalog?.concepts ?? []).map((c) => [c.id, c])), [catalog]);
  const fitted = useMemo<View>(() => {
    const b = bounds(graph.nodes);
    const k = Math.min(1.2, Math.max(0.15, Math.min((width - 40) / (b.w || 1), (height - 40) / (b.h || 1))));
    return { k, x: (width - b.w * k) / 2 - b.x * k, y: (height - b.h * k) / 2 - b.y * k };
  }, [graph.nodes, width, height]);
  const [view, setView] = useState<View | null>(null);
  const noop = () => undefined;
  return (
    <div ref={wrap} className="relative overflow-hidden rounded bg-ink" style={{ height }}>
      <Canvas
        graph={graph}
        onChange={noop}
        sel={{ nodes: [], edge: null }}
        onSel={noop}
        view={view ?? fitted}
        setView={setView}
        comps={comps}
        concepts={concepts}
        locked
        resolved={{}}
        svgRef={svgRef}
        onContext={noop}
        onOpen={noop}
        onEditLabel={noop}
      />
    </div>
  );
}
