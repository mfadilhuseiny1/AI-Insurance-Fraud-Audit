"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { forceCollide, forceX, forceY } from "d3-force";
import type { KindMeta, LinkRow, OrbisNode, PredicateMeta } from "@/lib/orbis";

/* The force canvas of the ai-jkn Knowledge Nexus explorer, on Orbis' operational graph. */

export interface GraphCanvasHandle {
  zoomToFit: (ms?: number) => void;
  /** Frame just these nodes — used to bring a whole path or answer into view. */
  fitNodes: (ids: string[], ms?: number) => void;
  centerOn: (nodeId: string, ms?: number) => void;
  releasePins: () => void;
}

export type LabelMode = "auto" | "all" | "none";

interface Props {
  nodes: OrbisNode[];
  links: LinkRow[];
  kinds: Record<string, KindMeta>;
  predicates: Record<string, PredicateMeta>;
  selectedId: string | null;
  hoverId: string | null;
  /** ids kept at full opacity; everything else is dimmed. null = no dimming */
  highlightNodes: Set<string> | null;
  highlightLinks: Set<string> | null;
  labelMode: LabelMode;
  linkDistance: number;
  chargeStrength: number;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  handleRef?: Ref<GraphCanvasHandle>;
}

type FGNode = OrbisNode;
type FGLink = LinkRow & { source: FGNode | string; target: FGNode | string };
type ForceGraphInstance = import("force-graph").default<FGNode, FGLink>;

const cssVar = (name: string, fallback: string) => {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

/** Radius grows with degree but saturates: a type with 1 800 objects stays a hub, not a disc over the graph. */
const radiusOf = (n: OrbisNode) => 2.6 + Math.min(Math.sqrt(n.degree ?? 0), 11) * 1.15;

export default function GraphCanvas({
  nodes,
  links,
  kinds,
  predicates,
  selectedId,
  hoverId,
  highlightNodes,
  highlightLinks,
  labelMode,
  linkDistance,
  chargeStrength,
  onSelect,
  onHover,
  handleRef,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphInstance | null>(null);
  const fittedRef = useRef(false);

  /* Latest render inputs, read from inside the canvas painters without rebuilding the graph on every state change. */
  const view = useRef({ kinds, predicates, selectedId, hoverId, highlightNodes, highlightLinks, labelMode });
  useEffect(() => {
    view.current = { kinds, predicates, selectedId, hoverId, highlightNodes, highlightLinks, labelMode };
    graphRef.current?.nodeRelSize(1); // repaint
  }, [kinds, predicates, selectedId, hoverId, highlightNodes, highlightLinks, labelMode]);

  useImperativeHandle(
    handleRef,
    () => ({
      zoomToFit: (ms = 500) => graphRef.current?.zoomToFit(ms, 90),
      fitNodes: (ids: string[], ms = 600) => {
        const wanted = new Set(ids);
        graphRef.current?.zoomToFit(ms, 110, (n: FGNode) => wanted.has(n.id));
      },
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
    let graph: ForceGraphInstance | undefined;
    (async () => {
      const { default: ForceGraph } = await import("force-graph");
      if (disposed || !hostRef.current) return;
      const host = hostRef.current;
      graph = new ForceGraph<FGNode, FGLink>(host);
      graphRef.current = graph;
      graph.width(host.clientWidth).height(host.clientHeight);
      graph
        .backgroundColor("transparent")
        .nodeId("id")
        .nodeRelSize(1)
        .nodeVal((n: FGNode) => radiusOf(n))
        .cooldownTime(7000)
        .warmupTicks(40)
        .d3AlphaDecay(0.022)
        .d3VelocityDecay(0.32)
        .linkDirectionalArrowLength((l: FGLink) => (view.current.highlightLinks?.has(l.id) ? 4.5 : 0))
        .linkDirectionalArrowRelPos(0.98)
        .autoPauseRedraw(false)
        .onNodeHover((n: FGNode | null) => onHover(n ? n.id : null))
        .onNodeClick((n: FGNode) => onSelect(n.id))
        .onBackgroundClick(() => onSelect(null))
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
          ctx.globalAlpha = dimmed ? 0.14 : 1;
          if (isSelected || isHover) {
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r + (isSelected ? 5 : 3), 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.globalAlpha = dimmed ? 0.14 : isSelected ? 0.28 : 0.18;
            ctx.fill();
            ctx.globalAlpha = dimmed ? 0.14 : 1;
          }
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
          if (node.fx != null) {
            ctx.lineWidth = 1 / scale;
            ctx.strokeStyle = cssVar("--kg-text", "#e8ecf3");
            ctx.stroke();
          }
          const showLabel = dimmed
            ? v.labelMode === "all"
            : v.labelMode === "all" ||
              (v.labelMode === "auto" && (scale > 1.8 || node.degree > 60)) ||
              isSelected ||
              isHover ||
              (v.highlightNodes?.has(node.id) && v.highlightNodes.size <= 50);
          if (showLabel && v.labelMode !== "none") {
            const fontSize = Math.max(2.4, 11 / scale);
            ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const text = node.label.length > 42 ? `${node.label.slice(0, 40)}…` : node.label;
            const w = ctx.measureText(text).width;
            ctx.globalAlpha = dimmed ? 0.1 : 0.92;
            ctx.fillStyle = cssVar("--kg-canvas", "#080b10");
            ctx.fillRect(node.x! - w / 2 - 1.5, node.y! + r + 1.2, w + 3, fontSize + 1.5);
            ctx.globalAlpha = dimmed ? 0.15 : 1;
            ctx.fillStyle = isSelected || isHover ? cssVar("--kg-text", "#e8ecf3") : cssVar("--kg-text-muted", "#93a0b3");
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
          if (v.highlightLinks && !v.highlightLinks.has(l.id)) return cssVar("--kg-link-dim", "rgba(148,163,184,0.06)");
          if (v.highlightLinks) return v.predicates[l.predicate]?.color ?? cssVar("--kg-link", "rgba(148,163,184,0.3)");
          return cssVar("--kg-link", "rgba(148,163,184,0.28)");
        })
        .linkWidth((l: FGLink) => (view.current.highlightLinks?.has(l.id) ? 1.6 : 0.4));
      graph.d3Force("charge")?.distanceMax(600);
      graph.d3Force("x", forceX(0).strength(0.04));
      graph.d3Force("y", forceY(0).strength(0.04));
      graph.d3Force("collide", forceCollide((n: FGNode) => radiusOf(n) + 2).iterations(1));
    })();
    return () => {
      disposed = true;
      graphRef.current?._destructor?.();
      graphRef.current = null;
    };
    // onSelect/onHover are stable callbacks from the parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => graphRef.current?.width(el.clientWidth).height(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Feed data. Node objects are reused so positions survive filtering; link objects are rebuilt. */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const feed = () => {
      const g = graphRef.current;
      if (!g || cancelled) {
        if (!cancelled) timer = setTimeout(feed, 60);
        return;
      }
      const present = new Set(nodes.map((n) => n.id));
      const fgLinks: FGLink[] = links.filter((l) => present.has(l.s) && present.has(l.t)).map((l) => ({ ...l, source: l.s, target: l.t }));
      g.graphData({ nodes, links: fgLinks });
      if (!fittedRef.current && nodes.length) {
        fittedRef.current = true;
        timer = setTimeout(() => graphRef.current?.zoomToFit(600, 90), 1600);
      }
    };
    feed();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nodes, links]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    (g.d3Force("link") as unknown as { distance: (d: number) => void } | undefined)?.distance(linkDistance);
    (g.d3Force("charge") as unknown as { strength: (s: number) => void } | undefined)?.strength(chargeStrength);
    g.d3ReheatSimulation();
  }, [linkDistance, chargeStrength]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
