"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GraphCanvas, { type GraphCanvasHandle, type LabelMode } from "./GraphCanvas";
import SidePanel from "./SidePanel";
import ChatPanel from "./ChatPanel";
import DetailPanel from "./DetailPanel";
import { BriefView, ReferencesView, RelationsView } from "./Views";
import {
  buildAdjacency,
  egoNodeIds,
  normalizeLinks,
  orbis,
  pathLinks,
  searchNodes,
  shortestPath,
  type AskResult,
  type LinkRow,
  type OrbisNode,
  type OrbisPayload,
} from "@/lib/orbis";

/* Bluesand Orbis: the ai-jkn Knowledge Nexus explorer, on the JKN demo's operational graph. */

type View = "graph" | "relations" | "brief" | "refs";

export default function Explorer() {
  const [data, setData] = useState<OrbisPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("graph");

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(1);
  const [pathFromId, setPathFromId] = useState<string | null>(null);
  const [pathToId, setPathToId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<"chat" | "filter">("chat");
  /** what an answer or a semantic search lit up on the canvas */
  const [traceFocus, setTraceFocus] = useState<{ nodes: Set<string>; links: Set<string>; label: string } | null>(null);
  const [traceMsgId, setTraceMsgId] = useState<string | null>(null);

  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(new Set());
  const [enabledPredicates, setEnabledPredicates] = useState<Set<string>>(new Set());
  const [labelMode, setLabelMode] = useState<LabelMode>("auto");
  const [linkDistance, setLinkDistance] = useState(40);
  const [chargeStrength, setChargeStrength] = useState(-60);
  const [showLegend, setShowLegend] = useState(true);
  const canvasRef = useRef<GraphCanvasHandle>(null);

  const load = useCallback(() => {
    orbis
      .graph()
      .then((payload) => {
        setData(payload);
        const hiddenKinds = new Set(payload.defaults?.hiddenKinds ?? []);
        const hidden = new Set(payload.defaults?.hiddenPredicates ?? ["instanceOf"]);
        setEnabledPredicates(new Set(Object.keys(payload.predicates).filter((p) => !hidden.has(p))));
        const params = new URLSearchParams(window.location.search);
        const v = params.get("view");
        if (v === "relations" || v === "brief" || v === "refs") setView(v);
        const id = params.get("id");
        const node = id ? payload.nodes.find((n) => n.id === id || n.rawId === id) : undefined;
        if (node) hiddenKinds.delete(node.kind);
        setEnabledKinds(new Set(Object.keys(payload.kinds).filter((k) => !hiddenKinds.has(k))));
        if (node) {
          setSelectedId(node.id);
          setTimeout(() => canvasRef.current?.centerOn(node.id), 1800);
        }
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const allLinks = useMemo<LinkRow[]>(() => (data ? normalizeLinks(data.links) : []), [data]);
  const nodeIndex = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const adjacency = useMemo(() => buildAdjacency(allLinks), [allLinks]);
  const activeLinks = useMemo(() => allLinks.filter((l) => enabledPredicates.has(l.predicate)), [allLinks, enabledPredicates]);
  const activeAdjacency = useMemo(() => buildAdjacency(activeLinks), [activeLinks]);

  const kindCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const n of data?.nodes ?? []) out[n.kind] = (out[n.kind] ?? 0) + 1;
    return out;
  }, [data]);
  const predicateCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const l of allLinks) out[l.predicate] = (out[l.predicate] ?? 0) + 1;
    return out;
  }, [allLinks]);

  /* Nodes of the switched-on kinds (and the focus neighbourhood). A node whose every relation leads to a hidden kind
     would float alone (e.g. decisions on IoT findings while findings are off), so it stays out until selected. */
  const { visibleNodes, visibleLinks } = useMemo(() => {
    if (!data) return { visibleNodes: [] as OrbisNode[], visibleLinks: [] as LinkRow[] };
    const ego = focusId ? egoNodeIds(activeAdjacency, focusId, focusDepth) : null;
    const cand = data.nodes.filter((n) => enabledKinds.has(n.kind) && (!ego || ego.has(n.id)));
    const present = new Set(cand.map((n) => n.id));
    const links = activeLinks.filter((l) => present.has(l.s) && present.has(l.t));
    const linked = new Set<string>();
    for (const l of links) {
      linked.add(l.s);
      linked.add(l.t);
    }
    return { visibleNodes: cand.filter((n) => linked.has(n.id) || n.degree === 0 || n.id === selectedId), visibleLinks: links };
  }, [data, enabledKinds, focusId, focusDepth, activeAdjacency, activeLinks, selectedId]);

  const hits = useMemo(() => (data ? searchNodes(data.nodes, query, 40) : []), [data, query]);

  const path = useMemo(() => {
    if (!pathFromId || !pathToId) return null;
    const ids = shortestPath(activeAdjacency, pathFromId, pathToId);
    if (!ids) return null;
    const hops = pathLinks(activeLinks, ids);
    const labels = ids.map((id, i) => {
      const node = nodeIndex.get(id);
      if (i === 0) return node?.label ?? id;
      const hop = hops[i - 1];
      const predicate = hop ? (data?.predicates[hop.predicate]?.label ?? hop.predicate) : "?";
      return `${hop && hop.t !== id ? "←" : "→"} ${predicate} · ${node?.label ?? id}`;
    });
    return { ids, hops, labels };
  }, [pathFromId, pathToId, activeAdjacency, activeLinks, nodeIndex, data]);

  const effectiveHoverId = selectedId ? null : hoverId;
  const { highlightNodes, highlightLinks } = useMemo(() => {
    if (path) return { highlightNodes: new Set(path.ids), highlightLinks: new Set(path.hops.map((h) => h.id)) };
    if (traceFocus && !selectedId) return { highlightNodes: traceFocus.nodes, highlightLinks: traceFocus.links };
    const anchor = selectedId ?? effectiveHoverId;
    if (!anchor) return { highlightNodes: null, highlightLinks: null };
    const nodes = new Set<string>([anchor]);
    const links = new Set<string>();
    for (const l of activeAdjacency.out.get(anchor) ?? []) {
      nodes.add(l.t);
      links.add(l.id);
    }
    for (const l of activeAdjacency.in.get(anchor) ?? []) {
      nodes.add(l.s);
      links.add(l.id);
    }
    return { highlightNodes: nodes, highlightLinks: links };
  }, [path, effectiveHoverId, selectedId, activeAdjacency, traceFocus]);

  /** Make sure a node's kind is drawn, then select and centre it. */
  const selectNode = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (!id) return;
      const k = nodeIndex.get(id)?.kind;
      if (k) setEnabledKinds((prev) => (prev.has(k) ? prev : new Set([...prev, k])));
      setView("graph");
      setTimeout(() => canvasRef.current?.centerOn(id), 300);
    },
    [nodeIndex],
  );

  /** Light up a set of nodes (an answer's subgraph, semantic hits): their kinds and relations are switched on first. */
  const showSet = useCallback(
    (ids: string[], edgeKeys: Set<string> | null, label: string) => {
      const nodes = new Set(ids.filter((id) => nodeIndex.has(id)));
      if (!nodes.size) return setTraceFocus(null);
      const links = new Set<string>();
      const preds = new Set<string>();
      for (const l of allLinks) {
        const inside = nodes.has(l.s) && nodes.has(l.t);
        if (!inside || (edgeKeys && !edgeKeys.has(`${l.s}|${l.predicate}|${l.t}`))) continue;
        links.add(l.id);
        preds.add(l.predicate);
      }
      const kinds = new Set([...nodes].map((id) => nodeIndex.get(id)!.kind));
      setEnabledKinds((prev) => ([...kinds].every((k) => prev.has(k)) ? prev : new Set([...prev, ...kinds])));
      setEnabledPredicates((prev) => ([...preds].every((p) => prev.has(p)) ? prev : new Set([...prev, ...preds])));
      setFocusId(null);
      setSelectedId(null);
      setView("graph");
      setTraceFocus({ nodes, links, label });
      setTimeout(() => canvasRef.current?.fitNodes([...nodes]), 700);
    },
    [allLinks, nodeIndex],
  );

  const highlightAnswer = useCallback(
    (r: AskResult | null) => {
      if (!r) return setTraceFocus(null);
      showSet(r.subgraph.nodeIds, new Set(r.subgraph.edges.map((e) => `${e.s}|${e.p}|${e.t}`)), "Subgraf jawaban");
    },
    [showSet],
  );

  const toggle = (set: (f: (prev: Set<string>) => Set<string>) => void) => (k: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  useEffect(() => {
    if (!path) return;
    const t = setTimeout(() => canvasRef.current?.fitNodes(path.ids), 120);
    return () => clearTimeout(t);
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.tagName === "SELECT";
      if (e.key === "Escape") {
        if (typing) el.blur();
        setSelectedId(null);
        return;
      }
      if (typing) return;
      if (e.key === "f") canvasRef.current?.zoomToFit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="mb-2 font-medium">Gagal memuat Bluesand Orbis.</p>
          <p className="mono text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
            {error}
          </p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: "var(--kg-text-faint)" }}>
        <span className="mono kg-pulse text-[11px]">memuat Bluesand Orbis… (pembangunan pertama memerlukan beberapa menit)</span>
      </div>
    );
  }
  const selected = selectedId ? (nodeIndex.get(selectedId) ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b px-3.5 panel">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px]" style={{ background: "var(--kg-accent-soft)", color: "var(--kg-accent)" }}>
          ◎
        </span>
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-tight">{data.meta.title}</span>
          <span className="mono text-[10px]" style={{ color: "var(--kg-text-faint)" }}>
            v{data.meta.version}
          </span>
        </div>
        <span className="hidden max-w-[360px] truncate text-[12px] xl:block" style={{ color: "var(--kg-text-faint)" }}>
          {data.meta.subtitle}
        </span>
        <nav className="ml-auto flex gap-1">
          {(
            [
              ["graph", "Graf"],
              ["relations", "Relasi"],
              ["brief", "Ringkasan"],
              ["refs", "Rujukan"],
            ] as [View, string][]
          ).map(([v, l]) => (
            <button key={v} className="btn" data-active={view === v} onClick={() => setView(v)}>
              {l}
            </button>
          ))}
        </nav>
        <div className="mono hidden items-center gap-2 text-[10px] lg:flex" style={{ color: "var(--kg-text-faint)" }}>
          <span>{data.stats.nodes.toLocaleString("id-ID")} simpul</span>
          <span>·</span>
          <span>{data.stats.links.toLocaleString("id-ID")} relasi</span>
          <span>·</span>
          <span>indeks {data.meta.index}</span>
        </div>
        {view === "graph" && (
          <>
            <button className="btn" onClick={() => canvasRef.current?.zoomToFit()} title="Muat ke layar (f)">
              Muat
            </button>
            <button className="btn" data-active={showLegend} onClick={() => setShowLegend((s) => !s)}>
              Legenda
            </button>
          </>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
        {view === "graph" && (
          <div className="contents">
            <div className="flex h-full w-[360px] shrink-0 flex-col border-r panel">
              <div className="flex items-center gap-1 border-b px-3 py-2">
                <button className="btn" data-active={leftTab === "chat"} onClick={() => setLeftTab("chat")}>
                  Tanya Orbis
                </button>
                <button className="btn" data-active={leftTab === "filter"} onClick={() => setLeftTab("filter")}>
                  Filter &amp; cari
                </button>
              </div>
              <div className={leftTab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                <ChatPanel kinds={data.kinds} nodeIndex={nodeIndex} onSelect={selectNode} onHighlight={highlightAnswer} highlightedId={traceMsgId} setHighlightedId={setTraceMsgId} />
              </div>
              {leftTab === "filter" && (
                <SidePanel
                  kinds={data.kinds}
                  predicates={data.predicates}
                  kindCounts={kindCounts}
                  predicateCounts={predicateCounts}
                  enabledKinds={enabledKinds}
                  enabledPredicates={enabledPredicates}
                  toggleKind={toggle(setEnabledKinds)}
                  togglePredicate={toggle(setEnabledPredicates)}
                  setKinds={setEnabledKinds}
                  setPredicates={setEnabledPredicates}
                  query={query}
                  setQuery={setQuery}
                  hits={hits}
                  nodeIndex={nodeIndex}
                  onSelect={selectNode}
                  onShowSet={(ids) => showSet(ids, null, "Hasil pencarian makna")}
                  focusNode={focusId ? (nodeIndex.get(focusId) ?? null) : null}
                  focusDepth={focusDepth}
                  setFocusDepth={setFocusDepth}
                  clearFocus={() => setFocusId(null)}
                  pathFrom={pathFromId ? (nodeIndex.get(pathFromId) ?? null) : null}
                  pathTo={pathToId ? (nodeIndex.get(pathToId) ?? null) : null}
                  pathResult={path ? { labels: path.labels } : null}
                  clearPath={() => (setPathFromId(null), setPathToId(null))}
                  labelMode={labelMode}
                  setLabelMode={setLabelMode}
                  linkDistance={linkDistance}
                  setLinkDistance={setLinkDistance}
                  chargeStrength={chargeStrength}
                  setChargeStrength={setChargeStrength}
                  releasePins={() => canvasRef.current?.releasePins()}
                  visibleNodes={visibleNodes.length}
                  visibleLinks={visibleLinks.length}
                />
              )}
            </div>

            <main className="relative min-w-0 flex-1" style={{ background: "var(--kg-canvas)" }}>
              <GraphCanvas
                handleRef={canvasRef}
                nodes={visibleNodes}
                links={visibleLinks}
                kinds={data.kinds}
                predicates={data.predicates}
                selectedId={selectedId}
                hoverId={effectiveHoverId}
                highlightNodes={highlightNodes}
                highlightLinks={highlightLinks}
                labelMode={labelMode}
                linkDistance={linkDistance}
                chargeStrength={chargeStrength}
                onSelect={setSelectedId}
                onHover={setHoverId}
              />
              {showLegend && (
                <div className="absolute bottom-3 left-3 max-h-[38%] overflow-y-auto rounded-lg border p-2.5" style={{ background: "var(--kg-surface)", boxShadow: "var(--kg-shadow)" }}>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 xl:grid-cols-3">
                    {Object.entries(data.kinds)
                      .filter(([k]) => enabledKinds.has(k) && (kindCounts[k] ?? 0) > 0)
                      .map(([k, meta]) => (
                        <div key={k} className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
                          <span className="max-w-40 truncate text-[11px]" style={{ color: "var(--kg-text-muted)" }}>
                            {meta.label}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {traceFocus && !selectedId && (
                <div className="fade-in absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1" style={{ borderColor: "var(--kg-accent)", background: "var(--kg-surface)", boxShadow: "var(--kg-shadow)" }}>
                  <span className="text-[11px]" style={{ color: "var(--kg-text-muted)" }}>
                    {traceFocus.label} · {traceFocus.nodes.size} simpul
                  </span>
                  <button className="btn" onClick={() => canvasRef.current?.fitNodes([...traceFocus.nodes])}>
                    Muat
                  </button>
                  <button className="btn" onClick={() => (setTraceFocus(null), setTraceMsgId(null))}>
                    Lepas
                  </button>
                </div>
              )}
              <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border px-2 py-1" style={{ background: "var(--kg-surface)" }}>
                <span className="mono text-[10px]" style={{ color: "var(--kg-text-faint)" }}>
                  klik simpul · seret untuk memaku · gulir untuk zoom · f muat
                </span>
              </div>
            </main>

            {selected && (
              <DetailPanel
                node={selected}
                nodeIndex={nodeIndex}
                adjacency={adjacency}
                kinds={data.kinds}
                predicates={data.predicates}
                onSelect={selectNode}
                onFocus={(id) => {
                  setFocusId(id);
                  setLeftTab("filter");
                  setTimeout(() => canvasRef.current?.zoomToFit(), 900);
                }}
                onPathFrom={(id) => (setPathFromId(id), setLeftTab("filter"))}
                onPathTo={(id) => (setPathToId(id), setLeftTab("filter"))}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        )}
        {view === "relations" && <RelationsView links={allLinks} nodeIndex={nodeIndex} kinds={data.kinds} predicates={data.predicates} onSelect={selectNode} />}
        {view === "brief" && (
          <BriefView
            data={data}
            onReload={load}
            onKinds={(ks) => {
              setEnabledKinds(new Set(ks));
              setFocusId(null);
              setTraceFocus(null);
              setView("graph");
              setTimeout(() => canvasRef.current?.zoomToFit(), 1200);
            }}
          />
        )}
        {view === "refs" && <ReferencesView data={data} nodeIndex={nodeIndex} links={allLinks} onSelect={selectNode} />}
      </div>
    </div>
  );
}

