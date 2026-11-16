"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { API_URL } from "@/lib/api";

/* Intelligence Nexus — a Vertex workspace over one domain's ontology semantic layer (Grid, JKN, …).
   Schema View draws the domain's Object Types and the live Nexus link types between them (from <api>/schema,
   falling back to the raw ontology endpoints, then to a clearly labelled mock). Instance View draws real objects
   and their foreign-key neighbours. Verified ontology facts and curated interpretations are badged differently
   everywhere; nothing here invents a relationship. The domain is a NexusConfig (api/nexus_engine.py serves it). */

export type NexusConfig = {
  /** API base, e.g. "/api/grid-nexus" */
  api: string;
  title: string;
  /** core Object Types (display names without "(demo)") — the ontology-fallback and mock use them */
  targetNames: string[];
  /** curated link terms, for the ontology-fallback path */
  termByName: Record<string, string>;
  examples: string[];
  askPlaceholder: string;
  /** node the hierarchical layout starts from */
  hierarchyStart: string;
  /** the domain's operational app, linked from the header */
  appLink: { href: string; label: string };
  /** labels of the five edge kinds in this domain's language */
  edgeLabels?: Partial<Record<EdgeKind, string>>;
};

type EdgeKind = "physical_asset" | "electrical_topology" | "operational_dependency" | "data_lineage" | "logical";
type PropSem = { api_name: string; display_name: string; type: string; ontology_description: string; meaning: string | null; meaning_source: string | null; verified: boolean };
type NodeSem = {
  verified_definition: string | null; verified_source: string | null;
  interpretation: { definition: string; business_context: string; operational_purpose: string; source: string } | null;
  properties: PropSem[]; unverified_properties: string[];
};
type GNode = {
  id: string; node_kind?: "object_type" | "function" | "model"; core?: boolean;
  doc?: string; output?: string; version?: string; latest?: string; versions?: number; deployment?: string | null;
  experiment?: string | null; metrics?: Record<string, number | null>; on_type_id?: string; on_type_name?: string;
  model_project?: string; model_target?: string; association_note?: string;
  name: string; display_name: string; api_name: string; category: string; color: string;
  status?: string; primary_key?: string; title_property?: string; object_count: number | null; visible: boolean;
  property_count: number; backing_dataset: { dataset_id?: string | null; name?: string | null } | null;
  semantic: NodeSem; actions: { id: string; name: string; kind?: string; description?: string }[];
  functions: { id: string; name: string; doc?: string; output?: string }[];
  incoming: string[]; outgoing: string[]; isolated?: boolean;
  /** an object type outside the domain's curated set that joined because a link type connects it to one inside */
  joined_via?: string | null;
};
type GEdge = {
  id: string; name: string; term?: string; term_source?: string; kind: "link_type" | "property_reference" | "function_association" | "model_association"; edge_kind: EdgeKind; edge_kind_source: string;
  link_kind?: string; cardinality?: string; foreign_key?: string; source: string; target: string;
  source_name: string; target_name: string; ontology_description: string; verified: boolean;
};
type Schema = { available: boolean; nodes: GNode[]; edges: GEdge[]; missing_types?: string[]; counts?: Record<string, number>; signature?: string };
type Inst = { id: string; object_type_id: string; type_name: string; primary_key: string; title: string; properties: Record<string, unknown> };
type Sel = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "instance"; id: string } | null;

const EDGE_STYLE: Record<EdgeKind, { label: string; color: string; dash?: string }> = {
  physical_asset: { label: "Physical asset", color: "#34d399" },
  electrical_topology: { label: "Electrical topology", color: "#38bdf8" },
  operational_dependency: { label: "Operational dependency", color: "#a78bfa", dash: "7 4" },
  data_lineage: { label: "Data lineage", color: "#f59e0b", dash: "2 4" },
  logical: { label: "Logical / analytical", color: "#94a3b8", dash: "10 4 2 4" },
};
const norm = (s: string) => s.replace(/ \(demo\)$/, "").trim().toLowerCase();
async function jget<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, { credentials: "include", cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Fallback when the domain backend is not running yet: assemble the same shape from the live ontology
 *  endpoints (real backend data; the curated interpretation layer is then honestly absent). */
async function ontologyFallback(cfg: NexusConfig): Promise<Schema | null> {
  const [types, links, actions] = await Promise.all([
    jget<Record<string, unknown>[]>("/api/ontology/object-types"),
    jget<Record<string, unknown>[]>("/api/ontology/link-types"),
    jget<Record<string, unknown>[]>("/api/ontology/action-types"),
  ]);
  if (!types || !links) return null;
  const wanted = new Map(cfg.targetNames.map((n) => [norm(n), n]));
  const byId = new Map<string, string>();
  const nodes: GNode[] = [];
  for (const t of types) {
    const name = wanted.get(norm(String(t.display_name ?? "")));
    if (!name) continue;
    byId.set(String(t.id), name);
    const props = (t.properties as Record<string, unknown>[] | undefined) ?? [];
    nodes.push({
      id: String(t.id), name, display_name: String(t.display_name), api_name: String(t.api_name ?? ""),
      category: `${cfg.title} (ontology fallback)`, color: "#38bdf8", status: String(t.status ?? ""),
      primary_key: String(t.primary_key ?? ""), title_property: String(t.title_property ?? ""),
      object_count: typeof t.object_count === "number" ? t.object_count : null, visible: true,
      property_count: props.length,
      backing_dataset: (t.backing_dataset as GNode["backing_dataset"]) ?? null,
      semantic: {
        verified_definition: String(t.description ?? "") || null, verified_source: t.description ? "ontology" : null,
        interpretation: null,
        properties: props.map((p) => ({
          api_name: String(p.api_name), display_name: String(p.display_name ?? p.api_name), type: String(p.type ?? ""),
          ontology_description: String(p.description ?? ""), meaning: null, meaning_source: null, verified: Boolean(p.description),
        })),
        unverified_properties: props.filter((p) => !p.description).map((p) => String(p.api_name)),
      },
      actions: (actions ?? []).filter((a) => a.object_type_id === t.id).map((a) => ({ id: String(a.id), name: String(a.display_name), kind: String(a.kind ?? "") })),
      functions: [], incoming: [], outgoing: [],
    });
  }
  if (!nodes.length) return null;
  const fns = await Promise.all(nodes.map((n) => jget<{ name: string; id: string; doc?: string; output?: string }[]>(`/api/vertex/functions?object_type_id=${n.id}`)));
  fns.forEach((f, i) => { if (f) nodes[i].functions = f; });
  const edges: GEdge[] = [];
  for (const lt of links) {
    const s = (lt.source as Record<string, unknown>)?.object_type_id as string;
    const tg = (lt.target as Record<string, unknown>)?.object_type_id as string;
    if (!byId.has(s) || !byId.has(tg)) continue;
    edges.push({
      id: String(lt.id), name: String(lt.display_name ?? lt.id), term: cfg.termByName[String(lt.display_name ?? "")] ?? "related to", term_source: "interpretation", kind: "link_type", edge_kind: "logical", edge_kind_source: "interpretation",
      link_kind: String(lt.kind ?? ""), cardinality: String(lt.cardinality ?? ""), foreign_key: String(lt.foreign_key ?? ""),
      source: s, target: tg, source_name: byId.get(s)!, target_name: byId.get(tg)!,
      ontology_description: String(lt.description ?? ""), verified: true,
    });
  }
  for (const n of nodes) {
    n.incoming = edges.filter((e) => e.target === n.id).map((e) => e.id);
    n.outgoing = edges.filter((e) => e.source === n.id).map((e) => e.id);
    n.isolated = !n.incoming.length && !n.outgoing.length;
  }
  return { available: true, nodes, edges, counts: { object_types: nodes.length, relationships: edges.length } };
}

const mockOf = (cfg: NexusConfig): Schema => ({
  available: false,
  nodes: cfg.targetNames.map((name, i) => ({
    id: `mock-${i}`, name, display_name: name, api_name: "", category: "Mock fallback", color: "#64748b",
    object_count: null, visible: false, property_count: 0, backing_dataset: null,
    semantic: { verified_definition: null, verified_source: null, interpretation: null, properties: [], unverified_properties: [] },
    actions: [], functions: [], incoming: [], outgoing: [], isolated: true,
  })),
  edges: [],
});

type Sim = SimulationNodeDatum & { id: string; x?: number; y?: number; fx?: number | null; fy?: number | null };

export function SemanticNexus({ cfg }: { cfg: NexusConfig }) {
  const EDGE = useMemo(
    () => Object.fromEntries((Object.keys(EDGE_STYLE) as EdgeKind[]).map((k) => [k, { ...EDGE_STYLE[k], label: cfg.edgeLabels?.[k] ?? EDGE_STYLE[k].label }])) as typeof EDGE_STYLE,
    [cfg.edgeLabels],
  );
  const [schema, setSchema] = useState<Schema | null>(null);
  const [source, setSource] = useState<"backend" | "ontology" | "mock">("backend");
  const [mode, setMode] = useState<"schema" | "instance">("schema");
  const [layout, setLayout] = useState<"force" | "hierarchy">("force");
  const [sel, setSel] = useState<Sel>(null);
  const [query, setQuery] = useState("");
  const [nlq, setNlq] = useState("");
  const [answer, setAnswer] = useState<{ text: string; source: string }[]>([]);
  const [hi, setHi] = useState<{ nodes: Set<string>; edges: Set<string> } | null>(null);
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [showFn, setShowFn] = useState(true);
  const [showModels, setShowModels] = useState(true);
  const [kinds, setKinds] = useState<Set<EdgeKind>>(new Set(Object.keys(EDGE_STYLE) as EdgeKind[]));
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // instance mode state
  const [instType, setInstType] = useState<string>("");
  const [instances, setInstances] = useState<Inst[] | null>(null);
  const [graph, setGraph] = useState<{ nodes: Inst[]; edges: { id: string; source: string; target: string; label: string; term?: string; edge_kind: EdgeKind }[] } | null>(null);
  const [hops, setHops] = useState(1);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    (async () => {
      const s = await jget<Schema>(`${cfg.api}/schema`);
      if (s?.nodes?.length) { setSchema(s); setSource("backend"); return; }
      const o = await ontologyFallback(cfg);
      if (o) { setSchema(o); setSource("ontology"); return; }
      setSchema(mockOf(cfg)); setSource("mock");
    })();
  }, [cfg]);

  const categories = useMemo(() => [...new Set((schema?.nodes ?? []).filter((n) => (n.node_kind ?? "object_type") === "object_type").map((n) => n.category))], [schema]);
  const shownNodes = useMemo(() => (schema?.nodes ?? []).filter((n) => {
    const kind = n.node_kind ?? "object_type";
    if (kind === "function") return showFn;
    if (kind === "model") return showModels;
    return !cats.size || cats.has(n.category);
  }), [schema, cats, showFn, showModels]);
  const shownEdges = useMemo(() => {
    const ids = new Set(shownNodes.map((n) => n.id));
    return (schema?.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target) && kinds.has(e.edge_kind));
  }, [schema, shownNodes, kinds]);

  const nodeById = useMemo(() => new Map((schema?.nodes ?? []).map((n) => [n.id, n])), [schema]);
  const edgeById = useMemo(() => new Map((schema?.edges ?? []).map((e) => [e.id, e])), [schema]);

  // ---- layout: force-directed (d3-force) or hierarchical (BFS depth from the primary substation) ----
  // Deterministic seed per node id, so the same node set always starts from the same tidy layout.
  const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; };
  const computeLayout = useCallback((): Record<string, { x: number; y: number }> => {
    void layoutNonce;
    if (mode === "instance") {
      const ns = graph?.nodes ?? [];
      const simNodes: Sim[] = ns.map((n) => ({ id: n.id, x: 400 + (seedOf(n.id) - 0.5) * 140, y: 260 + (seedOf(`${n.id}#y`) - 0.5) * 140 }));
      const sim = forceSimulation(simNodes)
        .force("link", forceLink((graph?.edges ?? []).map((e) => ({ source: e.source, target: e.target }))).id((d) => (d as Sim).id).distance(150))
        .force("charge", forceManyBody().strength(-600)).force("center", forceCenter(400, 260)).force("collide", forceCollide(62));
      sim.tick(260); sim.stop();
      return Object.fromEntries(simNodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
    }
    if (layout === "hierarchy") {
      const depth = new Map<string, number>();
      const start = shownNodes.find((n) => n.name === cfg.hierarchyStart) ?? shownNodes[0];
      if (start) {
        depth.set(start.id, 0);
        const queue = [start.id];
        while (queue.length) {
          const cur = queue.shift()!;
          for (const e of shownEdges) {
            const nxt = e.source === cur ? e.target : e.target === cur ? e.source : null;
            if (nxt && !depth.has(nxt)) { depth.set(nxt, (depth.get(cur) ?? 0) + 1); queue.push(nxt); }
          }
        }
      }
      const perDepth = new Map<number, number>();
      const next: Record<string, { x: number; y: number }> = {};
      for (const n of shownNodes) {
        const d = depth.get(n.id) ?? 6;
        const i = perDepth.get(d) ?? 0;
        perDepth.set(d, i + 1);
        next[n.id] = { x: 120 + d * 210, y: 70 + i * 86 };
      }
      return next;
    }
    // 1. object types: one cluster per category around a ring, spaced for their labels, pulled together by their links
    const typeNodes = shownNodes.filter((n) => (n.node_kind ?? "object_type") === "object_type");
    const satellites = shownNodes.filter((n) => n.node_kind === "function" || n.node_kind === "model");
    const catList = [...new Set(typeNodes.map((n) => n.category))];
    const ring = 120 + typeNodes.length * 16;
    const cx = ring + 260;
    const cy = ring + 200;
    const catAt = Object.fromEntries(catList.map((c, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, catList.length) - Math.PI / 2;
      return [c, { x: cx + Math.cos(a) * ring * 0.75, y: cy + Math.sin(a) * ring * 0.75 }];
    }));
    const catOf = new Map(typeNodes.map((n) => [n.id, n.category]));
    const typeIds = new Set(typeNodes.map((n) => n.id));
    const tSim: Sim[] = typeNodes.map((n) => ({ id: n.id, x: catAt[n.category].x + (seedOf(n.id) - 0.5) * 90, y: catAt[n.category].y + (seedOf(`${n.id}#y`) - 0.5) * 90 }));
    const typeLinks = shownEdges.filter((e) => typeIds.has(e.source) && typeIds.has(e.target) && e.source !== e.target).map((e) => ({ source: e.source, target: e.target }));
    forceSimulation(tSim)
      .force("link", forceLink(typeLinks).id((d) => (d as Sim).id).distance(190).strength(0.3))
      // repulsion only between neighbours: leaves and long chains stay near their cluster instead of drifting off
      .force("charge", forceManyBody().strength(-900).distanceMax(420))
      .force("x", forceX<Sim>((d) => catAt[catOf.get(d.id) ?? ""]?.x ?? cx).strength(0.16))
      .force("y", forceY<Sim>((d) => catAt[catOf.get(d.id) ?? ""]?.y ?? cy).strength(0.16))
      .force("collide", forceCollide(100).strength(1))
      .stop()
      .tick(420);
    const at: Record<string, { x: number; y: number }> = Object.fromEntries(tSim.map((n) => [n.id, { x: n.x ?? cx, y: n.y ?? cy }]));
    // 2. functions and models: a fan around the type they run on / score, on the side facing away from the centre
    const ownerOf = (n: GNode) =>
      n.node_kind === "function" ? n.on_type_id : (schema?.edges ?? []).find((e) => e.source === n.id && e.kind === "model_association")?.target;
    const byOwner = new Map<string, GNode[]>();
    for (const n of satellites) {
      const o = ownerOf(n);
      const key = o && at[o] ? o : "";
      byOwner.set(key, [...(byOwner.get(key) ?? []), n]);
    }
    const mid = { x: tSim.reduce((s, n) => s + (n.x ?? 0), 0) / Math.max(1, tSim.length), y: tSim.reduce((s, n) => s + (n.y ?? 0), 0) / Math.max(1, tSim.length) };
    const sSim: Sim[] = [];
    for (const [owner, list] of byOwner) {
      const o = at[owner] ?? { x: mid.x, y: mid.y - ring - 140 };
      const base = Math.atan2(o.y - mid.y, o.x - mid.x);
      // a hub with many functions/models gets a wider fan and a larger radius, so they do not pile up
      const spread = Math.min(Math.PI * 1.7, 0.55 * Math.max(0, list.length - 1));
      list.forEach((n, i) => {
        const a = base + (list.length > 1 ? -spread / 2 + (spread * i) / (list.length - 1) : 0);
        const r = 135 + Math.max(0, list.length - 3) * 14 + (i % 2) * 40;
        sSim.push({ id: n.id, x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r });
      });
    }
    // 3. a last pass: everything moves apart until no two labels overlap, each node held near its place
    // (types firmly, satellites loosely) so the clusters keep their shape
    const all: Sim[] = [...tSim.map((n) => ({ id: n.id, x: n.x, y: n.y })), ...sSim];
    const home = Object.fromEntries(all.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
    forceSimulation(all)
      .force("x", forceX<Sim>((d) => home[d.id]?.x ?? 0).strength((d) => (typeIds.has((d as Sim).id) ? 0.45 : 0.2)))
      .force("y", forceY<Sim>((d) => home[d.id]?.y ?? 0).strength((d) => (typeIds.has((d as Sim).id) ? 0.45 : 0.2)))
      .force("collide", forceCollide<Sim>((d) => (typeIds.has(d.id) ? 92 : 76)).strength(1).iterations(3))
      .stop()
      .tick(300);
    return Object.fromEntries(all.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
  }, [mode, layout, shownNodes, shownEdges, graph, layoutNonce, cfg.hierarchyStart, schema]);

  // The base layout is computed ONCE per node/edge set (cached by signature): dragging a node only updates
  // that node's drag offset, so the rest of the graph never jumps around while you arrange it.
  const layoutKey = `${mode}|${layout}|${layoutNonce}|${(mode === "schema" ? shownNodes : graph?.nodes ?? []).map((n) => n.id).join(",")}|${(mode === "schema" ? shownEdges : graph?.edges ?? []).map((e) => e.id).join(",")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by layoutKey: recompute only when the node/edge set changes
  const basePos = useMemo(() => computeLayout(), [layoutKey]);
  const pos = { ...basePos, ...dragPos };
  const runLayout = useCallback(() => { setDragPos({}); setLayoutNonce((n) => n + 1); }, []);
  // fit: the whole graph (labels included) in the canvas, centred
  const fit = useCallback(() => {
    const el = svgRef.current;
    const pts = Object.values({ ...basePos, ...dragPos });
    if (!el || !pts.length) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    // room for labels at the sides and for the hint bar over the bottom of the canvas
    const [x0, x1, y0, y1] = [Math.min(...xs) - 120, Math.max(...xs) + 120, Math.min(...ys) - 50, Math.max(...ys) + 110];
    const k = Math.min(1.2, Math.max(0.1, Math.min(el.clientWidth / (x1 - x0), el.clientHeight / (y1 - y0))));
    setView({ k, x: (el.clientWidth - (x1 - x0) * k) / 2 - x0 * k, y: (el.clientHeight - (y1 - y0) * k) / 2 - y0 * k });
  }, [basePos, dragPos]);
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);
  useEffect(() => {
    const t = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(t);
  }, [basePos]);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = `${el.clientWidth}x${el.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const now = `${el.clientWidth}x${el.clientHeight}`;
      if (now !== last) {
        last = now;
        fitRef.current();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- live updates: new object types and relationship types appear without a reload ----
  // The page polls the ontology signature (cheap) every 15 s and when the tab regains focus; on a change it reloads the
  // schema, keeps every existing node where it is, places each new node next to the type it links to, and highlights
  // what is new.
  const [fresh, setFresh] = useState<{ ids: Set<string>; text: string } | null>(null);
  const live = useRef({ pos, schema });
  useEffect(() => {
    live.current = { pos, schema };
  });
  useEffect(() => {
    if (source !== "backend") return;
    let stop = false;
    const check = async () => {
      const cur = live.current.schema;
      const v = await jget<{ signature: string }>(`${cfg.api}/version`);
      if (stop || !v || !cur?.signature || v.signature === cur.signature) return;
      const s = await jget<Schema>(`${cfg.api}/schema`);
      if (stop || !s?.nodes?.length) return;
      const before = new Set(cur.nodes.map((n) => n.id));
      const beforeE = new Set(cur.edges.map((e) => e.id));
      const newNodes = s.nodes.filter((n) => !before.has(n.id));
      const newEdges = s.edges.filter((e) => !beforeE.has(e.id));
      const keep: Record<string, { x: number; y: number }> = {};
      for (const [id, p] of Object.entries(live.current.pos)) if (s.nodes.some((n) => n.id === id)) keep[id] = p;
      newNodes.forEach((n, i) => {
        const e = s.edges.find((x) => (x.source === n.id && keep[x.target]) || (x.target === n.id && keep[x.source]));
        const anchor = e ? keep[e.source === n.id ? e.target : e.source] : null;
        const a = seedOf(n.id) * 2 * Math.PI;
        if (anchor) keep[n.id] = { x: anchor.x + Math.cos(a) * 170, y: anchor.y + Math.sin(a) * 120 };
        else keep[n.id] = { x: 200 + i * 190, y: 80 };
      });
      setDragPos(keep);
      setSchema(s);
      const removed = cur.nodes.filter((n) => !s.nodes.some((x) => x.id === n.id)).length;
      const parts = [
        newNodes.length ? `${newNodes.length} new ${newNodes.length === 1 ? "node" : "nodes"} (${newNodes.slice(0, 4).map((n) => n.name).join(", ")}${newNodes.length > 4 ? ", …" : ""})` : "",
        newEdges.length ? `${newEdges.length} new ${newEdges.length === 1 ? "relationship" : "relationships"}` : "",
        removed ? `${removed} removed` : "",
      ].filter(Boolean);
      setFresh({ ids: new Set([...newNodes.map((n) => n.id), ...newEdges.map((e) => e.id)]), text: parts.length ? parts.join(" · ") : "definitions updated" });
    };
    const timer = setInterval(() => void check(), 15000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      stop = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [source, cfg.api]);

  // ---- instance loading & exploration ----
  const loadInstances = useCallback(async (typeId: string) => {
    setInstType(typeId); setInstances(null); setGraph(null); setNotice("");
    const r = await jget<{ objects: Inst[]; total: number }>(`${cfg.api}/instances?type_id=${typeId}&limit=80`);
    if (r?.objects) { setInstances(r.objects); return; }
    const o = await jget<{ objects: { object_type_id: string; primary_key: string; title: string; properties: Record<string, unknown> }[] }>(`/api/ontology/object-types/${typeId}/objects?limit=80`);
    if (o?.objects) {
      setInstances(o.objects.map((x) => ({ id: `${x.object_type_id}|${x.primary_key}`, object_type_id: x.object_type_id, type_name: nodeById.get(typeId)?.name ?? "", primary_key: x.primary_key, title: x.title, properties: x.properties })));
      return;
    }
    setInstances([]); setNotice("Instance backend unavailable for this type.");
  }, [nodeById, cfg.api]);

  const explore = useCallback(async (inst: Inst, h: number) => {
    setSel({ kind: "instance", id: inst.id });
    const r = await jget<{ nodes: Inst[]; edges: { id: string; source: string; target: string; label: string; term?: string; edge_kind: EdgeKind }[]; available: boolean; alasan?: string }>(
      `${cfg.api}/neighbors?type_id=${inst.object_type_id}&pk=${encodeURIComponent(inst.primary_key)}&hops=${h}`);
    if (r?.available) { setGraph({ nodes: r.nodes, edges: r.edges }); setNotice(""); }
    else { setGraph({ nodes: [inst], edges: [] }); setNotice(r?.alasan ?? `Neighbour exploration needs the ${cfg.title} backend (restart the API if it was just added).`); }
  }, [cfg.api, cfg.title]);

  const semanticSearch = useCallback(async () => {
    if (!nlq.trim()) return;
    const res = await fetch(`${API_URL}${cfg.api}/search`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: nlq }),
    }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { nodes: string[]; edges: string[]; answers: { text: string; source: string }[] } | null;
    if (res) {
      setHi({ nodes: new Set(res.nodes), edges: new Set(res.edges) });
      setAnswer(res.answers ?? []);
      if (mode !== "schema") setMode("schema");
      return;
    }
    // client fallback: name/category keyword match (interpretation layer unavailable)
    const q = nlq.toLowerCase();
    const hit = (schema?.nodes ?? []).filter((n) => `${n.name} ${n.category}`.toLowerCase().split(/[^a-z]+/).some((w) => w.length > 3 && q.includes(w)));
    setHi({ nodes: new Set(hit.map((n) => n.id)), edges: new Set() });
    setAnswer([{ text: "Semantic-search backend unavailable; showing plain name matches only.", source: "interpretation" }]);
  }, [nlq, schema, mode, cfg.api]);

  // ---- pan / zoom / drag ----
  const toGraph = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left - view.x) / view.k, y: (e.clientY - rect.top - view.y) / view.k };
  };
  const onWheel = (e: React.WheelEvent) => {
    const k = Math.min(2.6, Math.max(0.1, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    setView((v) => ({ ...v, k }));
  };

  const counts = schema?.counts ?? {};
  const selNode = sel?.kind === "node" ? nodeById.get(sel.id) : undefined;
  const selEdge = sel?.kind === "edge" ? edgeById.get(sel.id) : undefined;
  const instById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const selInst = sel?.kind === "instance" ? (instById.get(sel.id) ?? (instances ?? []).find((i) => i.id === sel.id)) : undefined;

  const renderNodes = mode === "schema" ? shownNodes : [];
  const renderEdges = mode === "schema" ? shownEdges : [];
  const dim = (id: string, isNode: boolean) => {
    if (query) {
      const n = nodeById.get(id);
      const hit = isNode && n ? `${n.name} ${n.api_name} ${n.category}`.toLowerCase().includes(query.toLowerCase()) : false;
      if (!hit) return true;
    }
    if (hi) return isNode ? !hi.nodes.has(id) : !hi.edges.has(id);
    return false;
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Vertex" icon="graph" href="/vertex" crumbs={[{ label: cfg.title }]}>
        <Link href="/vertex" className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">All Vertex graphs</Link>
        <Link href="/ontology" className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">Nexus Manager</Link>
        <Link href={cfg.appLink.href} className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">{cfg.appLink.label}</Link>
      </AppHeader>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 text-xs">
        <div className="mr-1">
          <div className="text-sm font-semibold text-white">{cfg.title}</div>
          <div className="text-[11px] text-muted">
            {counts.object_types ?? schema?.nodes.length ?? 0} object types · {counts.objects?.toLocaleString("id-ID") ?? "—"} objects · {counts.properties ?? "—"} properties · {counts.relationships ?? schema?.edges.length ?? 0} relationships · {counts.functions ?? 0} functions · {counts.models ?? 0} ML models · {counts.actions ?? 0} actions
            {source === "ontology" && <span className="text-amber-300"> · ontology fallback ({cfg.title} backend unavailable)</span>}
            {source === "mock" && <span className="text-red-300"> · MOCK FALLBACK — backend unavailable, no real data</span>}
          </div>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line-2">
          {(["schema", "instance"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={`px-3 py-1.5 ${mode === m ? "bg-ocean/20 text-white" : "text-soft hover:text-white"}`}>
              {m === "schema" ? "Schema View" : "Instance View"}
            </button>
          ))}
        </div>
        {mode === "schema" && (
          <select value={layout} onChange={(e) => setLayout(e.target.value as "force" | "hierarchy")} className="rounded-md border border-line-2 bg-ink px-2 py-1.5" aria-label="Layout">
            <option value="force">Force-directed</option>
            <option value="hierarchy">Hierarchical</option>
          </select>
        )}
        {mode === "instance" && (
          <div className="flex overflow-hidden rounded-md border border-line-2">
            {[1, 2].map((h) => (
              <button key={h} type="button" onClick={() => setHops(h)} className={`px-2.5 py-1.5 ${hops === h ? "bg-ocean/20 text-white" : "text-soft"}`}>{h}-hop</button>
            ))}
          </div>
        )}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search object types…" className="w-44 rounded-md border border-line-2 bg-ink px-2 py-1.5 outline-none" />
        <div className="flex min-w-52 flex-1 items-center gap-1">
          <input value={nlq} onChange={(e) => setNlq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void semanticSearch()}
            placeholder={cfg.askPlaceholder} className="min-w-40 flex-1 rounded-md border border-line-2 bg-ink px-2 py-1.5 outline-none" />
          <button type="button" onClick={() => void semanticSearch()} className="flex items-center gap-1 rounded-md bg-ocean px-2.5 py-1.5 text-white"><Icon name="sparkle" className="h-3.5 w-3.5" /> Ask</button>
          {hi && <button type="button" onClick={() => { setHi(null); setAnswer([]); }} className="rounded-md border border-line-2 px-2 py-1.5 text-soft">Clear highlight</button>}
        </div>
        <button type="button" onClick={runLayout} className="flex items-center gap-1 rounded-md border border-line-2 px-2.5 py-1.5 text-soft hover:text-white"><Icon name="refresh" className="h-3.5 w-3.5" /> Re-layout</button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-line bg-panel px-3 py-1.5">
        {cfg.examples.map((x) => (
          <button key={x} type="button" onClick={() => setNlq(x)} className="rounded-full border border-line-2 px-2 py-0.5 text-[11px] text-muted hover:text-white">{x}</button>
        ))}
        {answer.map((a, i) => (
          <p key={i} className="w-full rounded border border-ocean/30 bg-ocean/10 px-2 py-1.5 text-[11px] text-soft">
            {a.text} <span className="ml-1 rounded bg-amber-500/20 px-1 text-[10px] text-amber-200">interpretation — curated, not an ontology fact</span>
          </p>
        ))}
        {fresh && (
          <p className="flex w-full items-center gap-2 rounded border border-teal-400/40 bg-teal-500/10 px-2 py-1.5 text-[11px] text-teal-100" data-nexus-fresh>
            <Icon name="sparkle" className="h-3.5 w-3.5 text-teal-300" /> Nexus updated from the ontology: {fresh.text}
            <button type="button" onClick={() => setFresh(null)} className="ml-auto text-teal-300 hover:text-white">Dismiss</button>
          </p>
        )}
        {notice && <p className="w-full rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">{notice}</p>}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* filters + legend */}
        <aside className="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-panel p-3 text-xs">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Categories</div>
            {categories.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-2 py-0.5 text-soft">
                <input type="checkbox" checked={!cats.size || cats.has(c)} onChange={(e) => {
                  const next = new Set(cats.size ? cats : categories);
                  if (e.target.checked) next.add(c); else next.delete(c);
                  setCats(next.size === categories.length ? new Set() : next);
                }} /> {c}
              </label>
            ))}
            <p className="mt-1 text-[10px] text-muted">Grouping is presentation interpretation, not ontology metadata.</p>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Node kinds</div>
            <label className="flex cursor-pointer items-center gap-2 py-0.5 text-soft">
              <input type="checkbox" checked={showFn} onChange={(e) => setShowFn(e.target.checked)} />
              <svg width="14" height="14"><polygon points="7,0 14,7 7,14 0,7" fill="#c084fc" fillOpacity={0.35} stroke="#c084fc" /></svg>
              Functions ({counts.functions ?? 0})
            </label>
            <label className="flex cursor-pointer items-center gap-2 py-0.5 text-soft">
              <input type="checkbox" checked={showModels} onChange={(e) => setShowModels(e.target.checked)} />
              <svg width="14" height="14"><circle cx="7" cy="7" r="6" fill="#facc15" fillOpacity={0.25} stroke="#facc15" /><circle cx="7" cy="7" r="2.5" fill="#facc15" /></svg>
              ML models ({counts.models ?? 0})
            </label>
            <p className="mt-1 text-[10px] text-muted">Diamond = published function (runs on its input type) · double ring = ML model (linked to the type it scores). Associations come from the functions and model registries.</p>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Relationship kinds</div>
            {(Object.keys(EDGE) as EdgeKind[]).map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 py-0.5 text-soft">
                <input type="checkbox" checked={kinds.has(k)} onChange={(e) => { const n = new Set(kinds); if (e.target.checked) n.add(k); else n.delete(k); setKinds(n); }} />
                <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke={EDGE[k].color} strokeWidth="2" strokeDasharray={EDGE[k].dash} /></svg>
                {EDGE[k].label}
              </label>
            ))}
            <p className="mt-1 text-[10px] text-muted">Edge kind classification is interpretation; the edge itself is a verified Nexus link type unless marked property reference.</p>
          </div>
          {mode === "instance" && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Browse instances</div>
              <select value={instType} onChange={(e) => void loadInstances(e.target.value)} className="w-full rounded-md border border-line-2 bg-ink px-2 py-1.5">
                <option value="">Choose object type…</option>
                {(schema?.nodes ?? []).filter((n) => (n.node_kind ?? "object_type") === "object_type").map((n) => <option key={n.id} value={n.id}>{n.name} ({n.object_count ?? "?"})</option>)}
              </select>
              <div className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
                {(instances ?? []).map((o) => (
                  <button key={o.id} type="button" onClick={() => void explore(o, hops)} className={`block w-full truncate rounded px-2 py-1 text-left ${selInst?.id === o.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`} title={o.title}>
                    {o.title} <span className="text-muted">{o.primary_key}</span>
                  </button>
                ))}
                {instances && !instances.length && <p className="text-muted">No visible instances for this account.</p>}
              </div>
            </div>
          )}
          <div className="mt-auto border-t border-line pt-2 text-[10px] text-muted">
            <div className="mb-1 font-semibold uppercase tracking-wide">Legend</div>
            <p><span className="text-emerald-300">● Verified</span> = from the live ontology · <span className="text-amber-300">● Interpretation</span> = curated domain explanation · dashed orange edge = property reference, not a link type · grey ring = isolated in this selection</p>
          </div>
        </aside>

        {/* graph canvas */}
        <main className="relative min-w-0 flex-1 bg-ink"
          onWheel={onWheel}
          onPointerDown={(e) => { if (!(e.target as Element).closest("[data-node]")) panRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }}
          onPointerMove={(e) => {
            if (dragRef.current) {
              const drag = dragRef.current;
              const p = toGraph(e);
              const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
              setDragPos((prev) => ({ ...prev, [drag.id]: { x: clamp(p.x - drag.dx, -6000, 12000), y: clamp(p.y - drag.dy, -6000, 12000) } }));
            } else if (panRef.current) {
              setView((v) => ({ ...v, x: panRef.current!.vx + e.clientX - panRef.current!.x, y: panRef.current!.vy + e.clientY - panRef.current!.y }));
            }
          }}
          onPointerUp={() => { dragRef.current = null; panRef.current = null; }}>
          <div className="absolute right-2 top-2 z-10 flex gap-1">
            <button type="button" aria-label="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(2.6, v.k * 1.2) }))} className="rounded border border-line-2 bg-panel px-2 py-1 text-xs">+</button>
            <button type="button" aria-label="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(0.1, v.k / 1.2) }))} className="rounded border border-line-2 bg-panel px-2 py-1 text-xs">−</button>
            <button type="button" onClick={fit} className="rounded border border-line-2 bg-panel px-2 py-1 text-xs">Fit</button>
          </div>
          {!schema && <p className="p-4 text-sm text-muted">Loading {cfg.title}…</p>}
          {mode === "instance" && !graph && <p className="max-w-md p-4 text-sm text-muted">Pick an object type on the left, then choose an instance — its 1-hop or 2-hop Nexus neighbours are drawn from the live foreign-key link types, read as your account.</p>}
          <svg ref={svgRef} className="h-full w-full" role="img" aria-label={`${cfg.title} knowledge graph`}>
            <defs>
              <marker id="gn-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#64748b" /></marker>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {mode === "schema" && renderEdges.map((e) => {
                const a = pos[e.source], b = pos[e.target];
                if (!a || !b) return null;
                const st = EDGE_STYLE[e.edge_kind];
                const d = dim(e.id, false);
                return (
                  <g key={e.id} opacity={d ? 0.12 : 1}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.verified ? st.color : "#fb923c"} strokeWidth={selEdge?.id === e.id || fresh?.ids.has(e.id) ? 3 : 1.6}
                      strokeDasharray={e.verified ? st.dash : "4 3"} markerEnd="url(#gn-arrow)" className="cursor-pointer"
                      onClick={() => setSel({ kind: "edge", id: e.id })}>
                      <title>{e.name} — {e.source_name} → {e.target_name}</title>
                    </line>
                    <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} textAnchor="middle" fontSize="9.5" fontStyle="italic" fill={e.verified ? "#dbeafe" : "#fdba74"}
                      style={{ paintOrder: "stroke", stroke: "#020617", strokeWidth: 3.5, strokeLinejoin: "round" }} className="pointer-events-none">{e.term ?? "related to"}</text>
                    {(hover === e.id || selEdge?.id === e.id) && (
                      <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 16} textAnchor="middle" fontSize="10" fill="#e2e8f0"
                        style={{ paintOrder: "stroke", stroke: "#020617", strokeWidth: 3.5, strokeLinejoin: "round" }} className="pointer-events-none">{e.source_name} —{e.term ?? "related to"}→ {e.target_name} · {e.name}</text>
                    )}
                  </g>
                );
              })}
              {mode === "schema" && renderNodes.map((n) => {
                const p = pos[n.id] ?? { x: 0, y: 0 };
                const d = dim(n.id, true);
                return (
                  <g key={n.id} data-node transform={`translate(${p.x},${p.y})`} opacity={d ? 0.25 : 1} className="cursor-grab select-none active:cursor-grabbing"
                    onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const g = toGraph(e); dragRef.current = { id: n.id, dx: g.x - p.x, dy: g.y - p.y }; setSel({ kind: "node", id: n.id }); }}
                    onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                    {fresh?.ids.has(n.id) && <circle r={27} fill="none" stroke="#2dd4bf" strokeWidth={2} strokeDasharray="4 3"><title>New since the page opened</title></circle>}
                    {(n.node_kind ?? "object_type") === "function" ? (
                      <polygon points="0,-16 16,0 0,16 -16,0" fill={n.color} fillOpacity={0.3} stroke={n.color} strokeWidth={selNode?.id === n.id ? 3 : 2} />
                    ) : (n.node_kind ?? "object_type") === "model" ? (
                      <><circle r={15} fill={n.color} fillOpacity={0.18} stroke={n.color} strokeWidth={selNode?.id === n.id ? 3 : 2} /><circle r={6} fill={n.color} fillOpacity={0.65} stroke={n.color} /></>
                    ) : (
                      <circle r={selNode?.id === n.id ? 17 : 14} fill={n.color} fillOpacity={0.22} stroke={n.isolated ? "#64748b" : n.color} strokeWidth={selNode?.id === n.id ? 3 : 2} strokeDasharray={n.isolated ? "3 3" : undefined} />
                    )}
                    <text y={30} textAnchor="middle" fontSize="11" fill="#e2e8f0" className="pointer-events-none">{n.name.replace(/ \(demo\)$/, "").replace(" (OSM)", "")}</text>
                    <text y={43} textAnchor="middle" fontSize="9" fill="#94a3b8" className="pointer-events-none">{
                      n.node_kind === "function" ? `ƒ · ${n.output ?? "value"}` :
                      n.node_kind === "model" ? `model · v${n.latest ?? "?"}${n.deployment ? ` · ${n.deployment}` : ""}` :
                      n.object_count == null ? "count n/a" : `${n.object_count.toLocaleString("id-ID")} objects`}</text>
                  </g>
                );
              })}
              {mode === "instance" && (graph?.edges ?? []).map((e) => {
                const a = pos[e.source], b = pos[e.target];
                if (!a || !b) return null;
                const showTerm = (graph?.edges.length ?? 0) <= 40;
                return (
                  <g key={e.id}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={EDGE_STYLE[e.edge_kind]?.color ?? "#94a3b8"} strokeWidth={1.4} strokeDasharray={EDGE_STYLE[e.edge_kind]?.dash} markerEnd="url(#gn-arrow)"><title>{e.label}</title></line>
                    {showTerm && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} textAnchor="middle" fontSize="8.5" fontStyle="italic" fill="#cbd5e1" style={{ paintOrder: "stroke", stroke: "#020617", strokeWidth: 3, strokeLinejoin: "round" }} className="pointer-events-none">{e.term ?? "related to"}</text>}
                  </g>
                );
              })}
              {mode === "instance" && (graph?.nodes ?? []).map((n) => {
                const p = pos[n.id] ?? { x: 0, y: 0 };
                const t = nodeById.get(n.object_type_id);
                return (
                  <g key={n.id} data-node transform={`translate(${p.x},${p.y})`} className="cursor-grab select-none active:cursor-grabbing"
                    onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const g = toGraph(e); dragRef.current = { id: n.id, dx: g.x - p.x, dy: g.y - p.y }; setSel({ kind: "instance", id: n.id }); }}
                    onDoubleClick={() => void explore(n, hops)}>
                    <circle r={11} fill={t?.color ?? "#38bdf8"} fillOpacity={0.25} stroke={t?.color ?? "#38bdf8"} strokeWidth={2} />
                    <text y={24} textAnchor="middle" fontSize="10" fill="#e2e8f0" className="pointer-events-none">{n.title.length > 26 ? `${n.title.slice(0, 26)}…` : n.title}</text>
                    <text y={36} textAnchor="middle" fontSize="8.5" fill="#94a3b8" className="pointer-events-none">{t?.name ?? n.type_name}</text>
                  </g>
                );
              })}
            </g>
          </svg>
          <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-line bg-panel/90 px-2 py-1 text-[10px] text-muted">
            Drag any node to arrange it — it stays where you drop it and the rest of the graph does not move · scroll to zoom · drag background to pan · Re-layout restores the tidy auto layout
          </div>
        </main>

        {/* Semantic Inspector */}
        <aside className="w-96 shrink-0 overflow-y-auto border-l border-line bg-panel p-3 text-xs">
          {!sel && <p className="text-muted">Click a node or an edge to open the Semantic Inspector — verified ontology facts are separated from curated interpretation, and missing metadata is flagged rather than filled in.</p>}
          {selNode && <NodeInspector key={selNode.id} api={cfg.api} n={selNode} schema={schema!} onEdge={(id) => setSel({ kind: "edge", id })} onInstances={() => { setMode("instance"); void loadInstances(selNode.id); }} />}
          {selEdge && <EdgeInspector e={selEdge} edge={EDGE} onNode={(id) => setSel({ kind: "node", id })} />}
          {selInst && (
            <div className="space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted">{nodeById.get(selInst.object_type_id)?.name ?? selInst.type_name}</div>
                <h3 className="text-sm font-semibold text-white">{selInst.title}</h3>
                <p className="text-muted">Primary key {selInst.primary_key}</p>
              </div>
              <button type="button" onClick={() => void explore(selInst, hops)} className="rounded-md bg-ocean px-2.5 py-1.5 text-white">Explore {hops}-hop neighbours</button>
              <table className="w-full"><tbody>
                {Object.entries(selInst.properties).slice(0, 30).map(([k, v]) => (
                  <tr key={k} className="border-b border-line/60"><td className="py-1 pr-2 align-top text-muted">{k}</td><td className="py-1 break-words">{String(v ?? "—")}</td></tr>
                ))}
              </tbody></table>
              <Link href={`/ontology/objects/${selInst.object_type_id}/${encodeURIComponent(selInst.primary_key)}`} className="inline-block rounded-md border border-line-2 px-2.5 py-1.5 text-soft hover:text-white">Open in Object Explorer</Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Badge2({ kind }: { kind: "ontology" | "interpretation" | "missing" }) {
  const map = { ontology: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30", interpretation: "bg-amber-500/15 text-amber-300 ring-amber-500/30", missing: "bg-red-500/15 text-red-300 ring-red-500/30" } as const;
  const label = { ontology: "Verified · ontology", interpretation: "Interpretation", missing: "Unverified" } as const;
  return <span className={`rounded-full px-1.5 py-0.5 text-[10px] ring-1 ${map[kind]}`}>{label[kind]}</span>;
}

function NodeInspector({ api, n, schema, onEdge, onInstances }: { api: string; n: GNode; schema: Schema; onEdge: (id: string) => void; onInstances: () => void }) {
  const sem = n.semantic;
  const edges = schema.edges;
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: n.color }} /><span className="text-[11px] uppercase tracking-wide text-muted">{n.category}</span></div>
        <h3 className="mt-1 text-sm font-semibold text-white">{n.name}</h3>
        {n.node_kind === "function" ? (
          <p className="text-muted">Published function · runs on {n.on_type_name} · returns {n.output ?? "value"} · version {n.version ?? "—"}</p>
        ) : n.node_kind === "model" ? (
          <p className="text-muted">ML model · latest v{n.latest ?? "?"} · {n.versions ?? "?"} versions{n.deployment ? ` · deployment ${n.deployment}` : " · no live deployment"}{n.experiment ? ` · experiment ${n.experiment}` : ""}</p>
        ) : (
          <p className="text-muted">{n.api_name} · PK {n.primary_key ?? "—"} · {n.object_count == null ? "object count unavailable to this account" : `${n.object_count.toLocaleString("id-ID")} objects`} · {n.property_count} properties</p>
        )}
        {n.joined_via && <p className="mt-1 text-teal-200">Joined this Nexus automatically: a link type connects it to <b>{n.joined_via}</b>. No curated interpretation yet — its ontology description is shown. <Badge2 kind="ontology" /></p>}
        {n.isolated && <p className="mt-1"><Badge2 kind="missing" /> <span className="text-muted">No verified relationship to the other selected types — none is invented for it.</span></p>}
      </div>
      {(n.node_kind ?? "object_type") === "object_type" && <DataPreview api={api} n={n} />}
      <section>
        <h4 className="mb-1 font-semibold text-white">Semantic definition</h4>
        {sem.verified_definition ? <p>{sem.verified_definition} <Badge2 kind="ontology" /></p> : <p className="text-muted">No definition in the ontology. <Badge2 kind="missing" /></p>}
        {sem.interpretation ? (
          <div className="mt-2 space-y-1.5 rounded border border-line bg-ink p-2">
            <p>{sem.interpretation.definition}</p>
            <p><span className="text-muted">Business context — </span>{sem.interpretation.business_context}</p>
            <p><span className="text-muted">Operational purpose — </span>{sem.interpretation.operational_purpose}</p>
            <Badge2 kind="interpretation" />
          </div>
        ) : <p className="mt-1 text-muted">No curated interpretation loaded (ontology fallback mode).</p>}
      </section>
      <section>
        <h4 className="mb-1 font-semibold text-white">Relationships</h4>
        <p className="text-muted">Outgoing</p>
        {n.outgoing.map((id) => { const e = edges.find((x) => x.id === id)!; return <button key={id} type="button" onClick={() => onEdge(id)} className="block w-full truncate rounded px-2 py-1 text-left text-soft hover:bg-panel-2">—<i className="text-sky-300">{e.term ?? "related to"}</i>→ {e.target_name}</button>; })}
        <p className="mt-1 text-muted">Incoming</p>
        {n.incoming.map((id) => { const e = edges.find((x) => x.id === id)!; return <button key={id} type="button" onClick={() => onEdge(id)} className="block w-full truncate rounded px-2 py-1 text-left text-soft hover:bg-panel-2">{e.source_name} —<i className="text-sky-300">{e.term ?? "related to"}</i>→</button>; })}
        {!n.incoming.length && !n.outgoing.length && <p className="text-muted">None in this selection.</p>}
      </section>
      <section>
        <h4 className="mb-1 font-semibold text-white">Properties &amp; meanings</h4>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full"><tbody>
            {sem.properties.map((p) => (
              <tr key={p.api_name} className="border-b border-line/60">
                <td className="py-1 pr-2 align-top"><span className="text-soft">{p.api_name}</span><br /><span className="text-[10px] text-muted">{p.type}</span></td>
                <td className="py-1">
                  {p.ontology_description ? <>{p.ontology_description} <Badge2 kind="ontology" /></> : p.meaning ? null : <><span className="text-muted">No verified meaning in the ontology.</span> <Badge2 kind="missing" /></>}
                  {p.meaning && <span className={`${p.ontology_description ? "mt-0.5 block text-[11px] text-muted" : ""}`}>{p.meaning} <Badge2 kind="interpretation" /></span>}
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>
        {sem.unverified_properties.length > 0 && <p className="mt-1 text-[11px] text-amber-200">{sem.unverified_properties.length} properties have no verified description — their names/types only are shown.</p>}
      </section>
      <section>
        <h4 className="mb-1 font-semibold text-white">Actions &amp; functions</h4>
        {n.actions.map((a) => <p key={a.id} className="py-0.5">⚙ {a.name} <span className="text-muted">({a.kind})</span> <Badge2 kind="ontology" /></p>)}
        {n.functions.map((f) => <p key={f.id} className="py-0.5">ƒ {f.name} <span className="text-muted">{f.doc}</span> <Badge2 kind="ontology" /></p>)}
        {!n.actions.length && !n.functions.length && <p className="text-muted">No actions or published functions are associated with this type in the backend.</p>}
      </section>
      {n.node_kind === "model" && n.metrics && Object.keys(n.metrics).length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold text-white">Recorded experiment metrics</h4>
          {Object.entries(n.metrics).slice(0, 8).map(([k, v]) => (
            <p key={k} className="flex justify-between py-0.5"><span className="text-muted">{k}</span><span>{v == null ? "—" : Number(v).toFixed(3)}</span></p>
          ))}
          <p className="mt-1 text-[11px] text-muted">From the demo&apos;s experiment record (state), attached to the registry model of the same name. <Badge2 kind="ontology" /></p>
        </section>
      )}
      {n.node_kind !== "object_type" && n.node_kind && (
        <section>
          <h4 className="mb-1 font-semibold text-white">Association</h4>
          <p>{n.node_kind === "function"
            ? <>This function takes objects of <b>{n.on_type_name}</b> — the association is computed from the published function&apos;s own input type in the functions registry, exactly as Vertex computes it.</>
            : <>{n.association_note || `This model is registered under ${n.model_project ?? "its project"} and associated with ${n.model_target ?? "the type it scores"}.`}</>} <Badge2 kind="ontology" /></p>
        </section>
      )}
      <section>
        <h4 className="mb-1 font-semibold text-white">Data source &amp; provenance</h4>
        {n.node_kind === "function" ? (
          <p>Functions registry · published function version {n.version ?? "—"} · input type {n.on_type_name} · output {n.output ?? "value"} <Badge2 kind="ontology" /></p>
        ) : n.node_kind === "model" ? (
          <p>Model registry · {n.model_project ?? "—"} · latest v{n.latest ?? "?"} · {n.versions ?? "?"} versions{n.deployment ? ` · deployment ${n.deployment}` : ""} <Badge2 kind="ontology" /></p>
        ) : n.backing_dataset?.dataset_id ? (
          <p>Backing dataset <Link href={`/datasets/${n.backing_dataset.dataset_id}`} className="text-ocean underline">{n.backing_dataset.name ?? n.backing_dataset.dataset_id}</Link> · <Link href={`/lineage?node=${encodeURIComponent(`object_type:${n.id}`)}`} className="text-ocean underline">Lineage</Link> <Badge2 kind="ontology" /></p>
        ) : <p className="text-muted">No backing dataset recorded (objects are maintained in Nexus). <Badge2 kind="missing" /></p>}
        {(n.node_kind ?? "object_type") === "object_type"
          ? <p className="mt-1 text-muted">Status {n.status ?? "—"} · title property {n.title_property ?? "—"}</p>
          : n.node_kind === "function"
            ? <p className="mt-1 text-muted">Published · version {n.version ?? "—"}</p>
            : <p className="mt-1 text-muted">Registered model · latest v{n.latest ?? "?"}</p>}
        {(n.node_kind ?? "object_type") === "object_type" && <button type="button" onClick={onInstances} className="mt-2 rounded-md bg-ocean px-2.5 py-1.5 text-white">View instances in Instance View</button>}
      </section>
    </div>
  );
}

function EdgeInspector({ e, edge, onNode }: { e: GEdge; edge: typeof EDGE_STYLE; onNode: (id: string) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted">{edge[e.edge_kind].label}</div>
        <h3 className="text-sm font-semibold text-white">{e.name}</h3>
        <p className="text-base text-white">{e.source_name} <span className="italic text-sky-300">—{e.term ?? "related to"}→</span> {e.target_name}</p>
        <p className="text-muted">Semantic term is a curated reading of the link direction. <Badge2 kind="interpretation" /></p>
      </div>
      <p>{e.verified ? <>This relationship is a live Nexus link type. <Badge2 kind="ontology" /></> : <>This is a property reference in the backing data (foreign-key values in a dataset column), <b>not</b> a Nexus link type. <Badge2 kind="missing" /></>}</p>
      <table className="w-full"><tbody>
        <tr className="border-b border-line/60"><td className="py-1 pr-2 text-muted">Edge kind</td><td className="py-1">{edge[e.edge_kind].label} <Badge2 kind="interpretation" /></td></tr>
        <tr className="border-b border-line/60"><td className="py-1 pr-2 text-muted">Link kind</td><td className="py-1">{e.link_kind ?? "—"}</td></tr>
        <tr className="border-b border-line/60"><td className="py-1 pr-2 text-muted">Cardinality</td><td className="py-1">{e.cardinality ?? "—"}</td></tr>
        <tr className="border-b border-line/60"><td className="py-1 pr-2 text-muted">Foreign key</td><td className="py-1">{e.foreign_key ?? "—"}</td></tr>
        <tr className="border-b border-line/60"><td className="py-1 pr-2 text-muted">Ontology description</td><td className="py-1">{e.ontology_description || <span className="text-muted">None recorded in the ontology.</span>}</td></tr>
      </tbody></table>
      <div className="flex gap-2">
        <button type="button" onClick={() => onNode(e.source)} className="rounded-md border border-line-2 px-2.5 py-1.5 text-soft hover:text-white">Source type</button>
        <button type="button" onClick={() => onNode(e.target)} className="rounded-md border border-line-2 px-2.5 py-1.5 text-soft hover:text-white">Target type</button>
      </div>
      <p className="text-muted">What it means must be read from the two types&apos; semantic definitions; the ontology records no description for this link, so no meaning is invented here.</p>
    </div>
  );
}


/** The first objects of a type, as the signed-in account sees them — the rows of its backing dataset after indexing
 *  (and edits). Columns: the title, then the properties in ontology order; scroll sideways for the rest. */
function DataPreview({ api, n }: { api: string; n: GNode }) {
  const [rows, setRows] = useState<Inst[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    void jget<{ objects: Inst[]; total: number }>(`${api}/instances?type_id=${n.id}&limit=12`).then((r) => {
      if (!live) return;
      setRows(r?.objects ?? []);
      setTotal(r?.total ?? null);
    });
    return () => {
      live = false;
    };
  }, [api, n.id]);
  const cols = n.semantic.properties.map((p) => p.api_name).filter((c) => c !== n.title_property);
  const shown = all ? cols : cols.slice(0, 6);
  const cell = (v: unknown) => {
    if (v == null || v === "") return "—";
    const t = typeof v === "object" ? JSON.stringify(v) : String(v);
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  };
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h4 className="font-semibold text-white">Data preview</h4>
        <span className="text-[11px] text-muted">{total == null ? "…" : `${Math.min(12, total)} of ${total.toLocaleString("id-ID")} objects`}</span>
        <Badge2 kind="ontology" />
      </div>
      <p className="mb-1 text-[11px] text-muted">
        {n.backing_dataset?.dataset_id ? <>Rows of the backing dataset <Link href={`/datasets/${n.backing_dataset.dataset_id}`} className="text-ocean underline">{n.backing_dataset.name ?? "dataset"}</Link>, as objects you may see.</> : "Objects maintained in the Nexus (no backing dataset), as you may see them."}
      </p>
      {!rows ? <div className="h-24 animate-pulse rounded bg-panel-2/40" /> : !rows.length ? <p className="text-muted">No objects visible to this account.</p> : (
        <div className="max-h-72 overflow-auto rounded border border-line" data-nexus-preview>
          <table className="w-full whitespace-nowrap text-[11px]">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr>
                <th className="px-2 py-1 font-normal">{n.title_property || "title"}</th>
                {shown.map((c) => <th key={c} className="px-2 py-1 font-normal">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line/60 hover:bg-panel-2/40">
                  <td className="px-2 py-1"><Link href={`/ontology/objects/${r.object_type_id}/${encodeURIComponent(r.primary_key)}`} className="text-ocean hover:underline">{cell(r.title)}</Link></td>
                  {shown.map((c) => <td key={c} className="px-2 py-1 text-soft">{cell(r.properties[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-1 flex gap-3 text-[11px]">
        {cols.length > 6 && <button type="button" onClick={() => setAll(!all)} className="text-ocean hover:underline">{all ? "Fewer columns" : `All ${cols.length} columns`}</button>}
        <Link href={`/object-explorer?type=${n.id}`} className="text-ocean hover:underline">Open in Object Explorer</Link>
      </div>
    </section>
  );
}
