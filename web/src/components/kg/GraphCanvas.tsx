"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { forceCollide, forceX, forceY } from "d3-force";
import type { KgKind, KgNode } from "@/lib/kg";

/** A link as drawn: endpoints by id, plus a stable id for highlighting. */
export type CanvasLink = { id: string; s: string; t: string; predicate: string };

export interface GraphCanvasHandle {
  zoomToFit: (ms?: number) => void;
  centerOn: (nodeId: string, ms?: number) => void;
  releasePins: () => void;
}

export type LabelMode = "auto" | "all" | "none";

type FGNode = KgNode & { x?: number; y?: number; fx?: number; fy?: number };
type FGLink = CanvasLink & { source: FGNode | string; target: FGNode | string };
// force-graph is loaded lazily inside the effect, so its type is a type-only import.
type ForceGraphInstance = import("force-graph").default<FGNode, FGLink>;

// Canvas colours follow the dark/light theme; read per frame so a toggle repaints on the next draw.
const light = () => typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
const ink = () => (light() ? { text: "#111a26", muted: "#637184", canvas: "#f3f5f8", link: "rgba(60,76,96,0.32)", dim: "rgba(60,76,96,0.07)" } : { text: "#e8edf5", muted: "#8391a7", canvas: "#070b12", link: "rgba(131,145,167,0.28)", dim: "rgba(131,145,167,0.06)" });

/** Radius grows with degree but saturates, so hubs stay readable. */
const radiusOf = (n: KgNode) => 2.6 + Math.sqrt(n.degree ?? 0) * 1.35;

export default function GraphCanvas({
  nodes,
  links,
  kinds,
  linkColors,
  selectedId,
  hoverId,
  highlightNodes,
  highlightLinks,
  labelMode,
  onSelect,
  onHover,
  handleRef,
}: {
  nodes: KgNode[];
  links: CanvasLink[];
  kinds: Record<string, KgKind>;
  linkColors: Record<string, string>;
  selectedId: string | null;
  hoverId: string | null;
  /** ids kept at full opacity; everything else is dimmed. null = no dimming */
  highlightNodes: Set<string> | null;
  highlightLinks: Set<string> | null;
  labelMode: LabelMode;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  handleRef?: Ref<GraphCanvasHandle>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphInstance | null>(null);
  const fittedRef = useRef(false);

  // Latest render inputs, read by the canvas painters without rebuilding the graph.
  const view = useRef({ kinds, linkColors, selectedId, hoverId, highlightNodes, highlightLinks, labelMode });
  useEffect(() => {
    view.current = { kinds, linkColors, selectedId, hoverId, highlightNodes, highlightLinks, labelMode };
    graphRef.current?.nodeRelSize(1); // repaint
  }, [kinds, linkColors, selectedId, hoverId, highlightNodes, highlightLinks, labelMode]);

  const callbacks = useRef({ onSelect, onHover });
  useEffect(() => {
    callbacks.current = { onSelect, onHover };
  }, [onSelect, onHover]);

  useImperativeHandle(
    handleRef,
    () => ({
      zoomToFit: (ms = 500) => graphRef.current?.zoomToFit(ms, 60),
      centerOn: (nodeId: string, ms = 600) => {
        const g = graphRef.current;
        const n = g?.graphData().nodes.find((x: FGNode) => x.id === nodeId);
        if (g && n && typeof n.x === "number") {
          g.centerAt(n.x, n.y, ms);
          g.zoom(Math.max(g.zoom(), 2.2), ms);
        }
      },
      releasePins: () => {
        for (const n of graphRef.current?.graphData().nodes ?? []) {
          n.fx = undefined;
          n.fy = undefined;
        }
        graphRef.current?.d3ReheatSimulation();
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;

    (async () => {
      const { default: ForceGraph } = await import("force-graph");
      if (disposed || !hostRef.current) return;
      const host = hostRef.current;
      const graph: ForceGraphInstance = new ForceGraph<FGNode, FGLink>(host);
      graphRef.current = graph;
      graph.width(host.clientWidth).height(host.clientHeight);

      graph
        .backgroundColor("transparent")
        .nodeId("id")
        .nodeRelSize(1)
        .nodeVal((n: FGNode) => radiusOf(n))
        .cooldownTime(6000)
        .warmupTicks(30)
        .d3AlphaDecay(0.022)
        .d3VelocityDecay(0.32)
        .linkDirectionalArrowLength((l: FGLink) => (view.current.highlightLinks?.has(l.id) ? 4.5 : 0))
        .linkDirectionalArrowRelPos(0.98)
        .autoPauseRedraw(false)
        .onNodeHover((n: FGNode | null) => callbacks.current.onHover(n ? n.id : null))
        .onNodeClick((n: FGNode) => callbacks.current.onSelect(n.id))
        .onBackgroundClick(() => callbacks.current.onSelect(null))
        .onNodeDragEnd((n: FGNode) => {
          n.fx = n.x;
          n.fy = n.y;
        })
        .nodeCanvasObject((node: FGNode, ctx: CanvasRenderingContext2D, scale: number) => {
          const v = view.current;
          const dimmed = v.highlightNodes ? !v.highlightNodes.has(node.id) : false;
          const isSelected = node.id === v.selectedId;
          const isHover = node.id === v.hoverId;
          const r = radiusOf(node);
          const color = v.kinds[node.kind]?.color ?? "#94a3b8";

          ctx.globalAlpha = dimmed ? 0.16 : 1;
          if (isSelected || isHover) {
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r + (isSelected ? 5 : 3), 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.globalAlpha = dimmed ? 0.16 : isSelected ? 0.28 : 0.18;
            ctx.fill();
            ctx.globalAlpha = dimmed ? 0.16 : 1;
          }
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
          if (node.fx != null) {
            // pinned nodes get a ring so the layout stays explicable
            ctx.lineWidth = 1 / scale;
            ctx.strokeStyle = ink().text;
            ctx.stroke();
          }

          const showLabel = dimmed
            ? v.labelMode === "all"
            : v.labelMode === "all" ||
              (v.labelMode === "auto" && (scale > 1.6 || node.degree > 12)) ||
              isSelected ||
              isHover ||
              (v.highlightNodes?.has(node.id) && v.highlightNodes.size <= 40);
          if (showLabel) {
            const fontSize = Math.max(2.4, 11 / scale);
            ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const text = node.label.length > 42 ? `${node.label.slice(0, 40)}…` : node.label;
            const w = ctx.measureText(text).width;
            ctx.globalAlpha = dimmed ? 0.1 : 0.9;
            ctx.fillStyle = ink().canvas;
            ctx.fillRect(node.x! - w / 2 - 1.5, node.y! + r + 1.2, w + 3, fontSize + 1.5);
            ctx.globalAlpha = dimmed ? 0.15 : 1;
            ctx.fillStyle = isSelected || isHover ? ink().text : ink().muted;
            ctx.fillText(text, node.x!, node.y! + r + 2);
          }
          ctx.globalAlpha = 1;
        })
        .nodePointerAreaPaint((node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, radiusOf(node) + 3, 0, 2 * Math.PI);
          ctx.fill();
        })
        .linkColor((l: FGLink) => {
          const v = view.current;
          if (v.highlightLinks && !v.highlightLinks.has(l.id)) return ink().dim;
          if (v.highlightLinks) return v.linkColors[l.predicate] ?? ink().link;
          return ink().link;
        })
        .linkWidth((l: FGLink) => (view.current.highlightLinks?.has(l.id) ? 1.6 : 0.5));

      // Isolated nodes have no links to hold them, so a weak pull to the origin keeps the
      // drawing compact, and collision stops dense cores from collapsing into a blob.
      graph.d3Force("charge")?.strength(-60).distanceMax(600);
      graph.d3Force("link")?.distance(45);
      graph.d3Force("x", forceX(0).strength(0.035));
      graph.d3Force("y", forceY(0).strength(0.035));
      graph.d3Force("collide", forceCollide((n: FGNode) => radiusOf(n) + 2.5).iterations(2));
    })();

    return () => {
      disposed = true;
      graphRef.current?._destructor?.();
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => graphRef.current?.width(el.clientWidth).height(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Feed data. Node objects are reused so positions survive filtering; link objects are
  // rebuilt because the simulation replaces their endpoints.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const feed = () => {
      const g = graphRef.current;
      if (!g) {
        if (!cancelled) timer = setTimeout(feed, 60); // still importing
        return;
      }
      const present = new Set(nodes.map((n) => n.id));
      const fgLinks: FGLink[] = links
        .filter((l) => present.has(l.s) && present.has(l.t))
        .map((l) => ({ ...l, source: l.s, target: l.t }));
      g.graphData({ nodes: nodes as FGNode[], links: fgLinks });
      if (!fittedRef.current && nodes.length) {
        fittedRef.current = true;
        timer = setTimeout(() => graphRef.current?.zoomToFit(600, 60), 1200);
      }
    };
    feed();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nodes, links]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
