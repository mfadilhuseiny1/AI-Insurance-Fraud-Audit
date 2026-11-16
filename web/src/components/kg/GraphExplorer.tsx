"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { inputClass } from "@/components/pipeline/Modal";
import type { KgGraph, KgLink, KgNode } from "@/lib/kg";
import { pageRanges } from "@/lib/format";
import GraphCanvas, { type CanvasLink, type GraphCanvasHandle, type LabelMode } from "./GraphCanvas";

type View = "graph" | "entities" | "relations" | "ontology";
const VIEWS: { id: View; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "entities", label: "Entities" },
  { id: "relations", label: "Relations" },
  { id: "ontology", label: "Ontology" },
];
const ROWS = 300;

const linkId = (l: KgLink) => `${l.source}|${l.predicate}|${l.target}`;
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Explorer for an extraction or a knowledge graph: force-directed graph with class and relation
 * filters and a detail panel, plus entity, relation and ontology tables.
 * `sourceNames` names the extractions a merged graph's nodes and evidence came from.
 */
export function GraphExplorer({ graph, sourceNames }: { graph: KgGraph; sourceNames?: Record<string, string> }) {
  const [view, setView] = useState<View>("graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenPreds, setHiddenPreds] = useState<Set<string>>(new Set());
  const [labelMode, setLabelMode] = useState<LabelMode>("auto");
  const canvas = useRef<GraphCanvasHandle>(null);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const searchText = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, fold([n.label, n.id, ...n.aliases, n.definition].join(" "))])),
    [graph],
  );

  const nodes = useMemo(() => graph.nodes.filter((n) => !hiddenKinds.has(n.kind)), [graph, hiddenKinds]);
  const links: CanvasLink[] = useMemo(
    () =>
      graph.links
        .filter((l) => !hiddenPreds.has(l.predicate))
        .map((l) => ({ id: linkId(l), s: l.source, t: l.target, predicate: l.predicate })),
    [graph, hiddenPreds],
  );
  const linkColors = useMemo(
    () => Object.fromEntries(Object.entries(graph.predicates).map(([k, p]) => [k, p.color])),
    [graph],
  );

  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return null;
    const hits = graph.nodes.filter((n) => searchText.get(n.id)!.includes(q));
    return hits.sort((a, b) => Number(!fold(a.label).startsWith(q)) - Number(!fold(b.label).startsWith(q)) || b.degree - a.degree);
  }, [graph, query, searchText]);

  const { highlightNodes, highlightLinks } = useMemo(() => {
    if (selectedId) {
      const ns = new Set([selectedId]);
      const ls = new Set<string>();
      for (const l of links) {
        if (l.s === selectedId || l.t === selectedId) {
          ns.add(l.s);
          ns.add(l.t);
          ls.add(l.id);
        }
      }
      return { highlightNodes: ns, highlightLinks: ls };
    }
    if (matches) return { highlightNodes: new Set(matches.map((n) => n.id)), highlightLinks: new Set<string>() };
    return { highlightNodes: null, highlightLinks: null };
  }, [selectedId, links, matches]);

  const select = useCallback((id: string | null, center = false) => {
    setSelectedId(id);
    if (id && center) setTimeout(() => canvas.current?.centerOn(id), 50);
  }, []);

  const openInGraph = (id: string) => {
    const n = byId.get(id);
    if (n && hiddenKinds.has(n.kind)) setHiddenKinds((s) => new Set([...s].filter((k) => k !== n.kind)));
    setView("graph");
    select(id, true);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedId(null);
        setQuery("");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const selected = selectedId ? byId.get(selectedId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            className={`rounded-md px-3 py-1.5 text-sm ${view === v.id ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2 hover:text-white"}`}
          >
            {v.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted tabular-nums">
          {graph.stats.nodes.toLocaleString()} entities · {graph.stats.links.toLocaleString()} relations ·{" "}
          {graph.stats.classes} classes · {graph.stats.properties} properties
        </span>
      </div>

      {view === "graph" && (
        <div className="flex min-h-0 flex-1">
          {/* filters */}
          <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel text-sm">
            <div className="border-b border-line p-3">
              <div className="relative">
                <Icon name="search" className="absolute left-2.5 top-2 h-4 w-4 text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search entities…"
                  className={`${inputClass} pl-8`}
                />
              </div>
              {matches && (
                <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-line">
                  {matches.length === 0 && <div className="p-2 text-xs text-muted">No matches</div>}
                  {matches.slice(0, 50).map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => openInGraph(n.id)}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-panel-2"
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: graph.kinds[n.kind]?.color }} />
                      <span className="truncate">{n.label}</span>
                      <span className="ml-auto shrink-0 text-muted">{n.id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <FilterList
              title="Classes"
              items={Object.entries(graph.kinds).map(([id, k]) => ({ id, label: k.label, color: k.color, count: k.count, hint: k.description }))}
              hidden={hiddenKinds}
              onToggle={(id) => setHiddenKinds((s) => toggle(s, id))}
              onOnly={(id) => setHiddenKinds(new Set(Object.keys(graph.kinds).filter((k) => k !== id)))}
              onAll={() => setHiddenKinds(new Set())}
            />
            <FilterList
              title="Relations"
              items={Object.entries(graph.predicates).map(([id, p]) => ({ id, label: p.label, color: p.color, count: p.count, hint: p.desc }))}
              hidden={hiddenPreds}
              onToggle={(id) => setHiddenPreds((s) => toggle(s, id))}
              onOnly={(id) => setHiddenPreds(new Set(Object.keys(graph.predicates).filter((k) => k !== id)))}
              onAll={() => setHiddenPreds(new Set())}
            />
          </aside>

          {/* canvas */}
          <div className="relative min-w-0 flex-1 bg-ink">
            <GraphCanvas
              nodes={nodes}
              links={links}
              kinds={graph.kinds}
              linkColors={linkColors}
              selectedId={selectedId}
              hoverId={hoverId}
              highlightNodes={highlightNodes}
              highlightLinks={highlightLinks}
              labelMode={labelMode}
              onSelect={select}
              onHover={setHoverId}
              handleRef={canvas}
            />
            <div className="absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-line bg-panel/90 p-1 text-xs">
              <button type="button" title="Fit to view" onClick={() => canvas.current?.zoomToFit()} className="rounded p-1.5 text-soft hover:bg-panel-2 hover:text-white">
                <Icon name="fit" />
              </button>
              <button type="button" title="Release pinned nodes" onClick={() => canvas.current?.releasePins()} className="rounded p-1.5 text-soft hover:bg-panel-2 hover:text-white">
                <Icon name="refresh" />
              </button>
              <span className="mx-1 h-4 w-px bg-line-2" />
              <span className="px-1 text-muted">Labels</span>
              {(["auto", "all", "none"] as LabelMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setLabelMode(m)}
                  className={`rounded px-2 py-1 capitalize ${labelMode === m ? "bg-ocean/20 text-white" : "text-soft hover:bg-panel-2"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            {hoverId && hoverId !== selectedId && byId.get(hoverId) && (
              <div className="pointer-events-none absolute bottom-3 left-3 max-w-md rounded-lg border border-line bg-panel/95 px-3 py-2 text-xs">
                <div className="font-medium text-white">{byId.get(hoverId)!.label}</div>
                <div className="text-muted">
                  {graph.kinds[byId.get(hoverId)!.kind]?.label} · {hoverId}
                </div>
              </div>
            )}
          </div>

          {selected && (
            <DetailPanel
              node={selected}
              graph={graph}
              byId={byId}
              sourceNames={sourceNames}
              onSelect={(id) => select(id, true)}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      )}

      {view === "entities" && <EntitiesTable graph={graph} onOpen={openInGraph} sourceNames={sourceNames} />}
      {view === "relations" && <RelationsTable graph={graph} byId={byId} onOpen={openInGraph} sourceNames={sourceNames} />}
      {view === "ontology" && <OntologyView graph={graph} />}
    </div>
  );
}

function FilterList({
  title,
  items,
  hidden,
  onToggle,
  onOnly,
  onAll,
}: {
  title: string;
  items: { id: string; label: string; color: string; count: number; hint: string }[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  onOnly: (id: string) => void;
  onAll: () => void;
}) {
  return (
    <div className="border-b border-line p-3">
      <div className="mb-1.5 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted">
        {title}
        {hidden.size > 0 && (
          <button type="button" onClick={onAll} className="normal-case tracking-normal text-ocean hover:underline">
            Show all
          </button>
        )}
      </div>
      {items.map((it) => (
        <div key={it.id} className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-panel-2" title={it.hint || it.id}>
          <button type="button" onClick={() => onToggle(it.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: hidden.has(it.id) ? "transparent" : it.color, boxShadow: `inset 0 0 0 1.5px ${it.color}` }}
            />
            <span className={`truncate text-xs ${hidden.has(it.id) ? "text-muted line-through" : "text-soft"}`}>{it.label}</span>
          </button>
          <button type="button" onClick={() => onOnly(it.id)} className="hidden text-[10px] text-ocean group-hover:block">
            only
          </button>
          <span className="text-[11px] tabular-nums text-muted">{it.count}</span>
        </div>
      ))}
    </div>
  );
}

function DetailPanel({
  node,
  graph,
  byId,
  sourceNames,
  onSelect,
  onClose,
}: {
  node: KgNode;
  graph: KgGraph;
  byId: Map<string, KgNode>;
  sourceNames?: Record<string, string>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const groups = useMemo(() => {
    const out = new Map<string, { dir: "out" | "in"; predicate: string; items: { other: KgNode; link: KgLink }[] }>();
    for (const l of graph.links) {
      const dir = l.source === node.id ? "out" : l.target === node.id ? "in" : null;
      if (!dir) continue;
      const other = byId.get(dir === "out" ? l.target : l.source);
      if (!other) continue;
      const key = `${dir}:${l.predicate}`;
      if (!out.has(key)) out.set(key, { dir, predicate: l.predicate, items: [] });
      out.get(key)!.items.push({ other, link: l });
    }
    return [...out.values()].sort((a, b) => (a.dir === b.dir ? b.items.length - a.items.length : a.dir === "out" ? -1 : 1));
  }, [node, graph, byId]);
  const kind = graph.kinds[node.kind];

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel text-sm">
      <div className="sticky top-0 border-b border-line bg-panel p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <span className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] ring-1 ring-line-2" style={{ color: kind?.color }}>
              <span className="h-2 w-2 rounded-full" style={{ background: kind?.color }} />
              {kind?.label ?? node.kind}
            </span>
            <h2 className="mt-1.5 text-base font-semibold leading-snug">{node.label}</h2>
            <div className="text-xs text-muted">
              {node.id} · {node.degree} relations · {node.mentions} mentions
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
            <Icon name="x" />
          </button>
        </div>
      </div>
      <div className="space-y-4 p-4">
        {node.definition && <p className="text-soft">{node.definition}</p>}
        {node.aliases.length > 0 && (
          <Section title="Also known as">
            <div className="flex flex-wrap gap-1">
              {node.aliases.map((a) => (
                <span key={a} className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-soft ring-1 ring-line-2">
                  {a}
                </span>
              ))}
            </div>
          </Section>
        )}
        {node.facts.length > 0 && (
          <Section title="Attributes">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {node.facts.map(([k, v], i) => (
                <div key={i} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-soft">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}
        {node.pages.length > 0 && (
          <Section title="Pages">
            <span className="text-xs text-soft">{pageRanges(node.pages)}</span>
          </Section>
        )}
        {node.sources && node.sources.length > 0 && (
          <Section title="From extractions">
            <ul className="space-y-0.5 text-xs text-soft">
              {node.sources.map((s) => (
                <li key={s}>{sourceNames?.[s] ?? s}</li>
              ))}
            </ul>
          </Section>
        )}
        {groups.map((g) => {
          const p = graph.predicates[g.predicate];
          return (
            <Section
              key={`${g.dir}:${g.predicate}`}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: p?.color }} />
                  {g.dir === "out" ? p?.label ?? g.predicate : `${p?.label ?? g.predicate} (incoming)`}
                  <span className="text-muted">· {g.items.length}</span>
                </span>
              }
            >
              <ul className="space-y-1">
                {g.items.map(({ other, link }) => (
                  <RelationRow key={linkId(link)} other={other} link={link} graph={graph} sourceNames={sourceNames} onSelect={onSelect} />
                ))}
              </ul>
            </Section>
          );
        })}
      </div>
    </aside>
  );
}

function RelationRow({
  other,
  link,
  graph,
  sourceNames,
  onSelect,
}: {
  other: KgNode;
  link: KgLink;
  graph: KgGraph;
  sourceNames?: Record<string, string>;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md bg-panel-2/60 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: graph.kinds[other.kind]?.color }} />
        <button type="button" onClick={() => onSelect(other.id)} className="min-w-0 flex-1 truncate text-left text-xs hover:text-ocean">
          {other.label}
        </button>
        {link.evidence.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            title="Evidence"
            className={`shrink-0 rounded px-1.5 text-[10px] ring-1 ${open ? "bg-sand/15 text-sand ring-sand/40" : "text-muted ring-line-2 hover:text-sand"}`}
          >
            “ {link.evidence.length}
          </button>
        )}
      </div>
      {open && <EvidenceList link={link} sourceNames={sourceNames} />}
    </li>
  );
}

function EvidenceList({ link, sourceNames }: { link: KgLink; sourceNames?: Record<string, string> }) {
  return (
    <ul className="mt-1.5 space-y-1.5 border-l-2 border-sand/40 pl-2">
      {link.evidence.map((ev, i) => (
        <li key={i} className="text-xs">
          <q className="text-soft">{ev.quote}</q>
          <span className="ml-1 text-muted">
            {ev.page ? `p. ${ev.page}` : ""}
            {ev.from && sourceNames ? ` · ${sourceNames[ev.from] ?? ev.from}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted">{title}</div>
      {children}
    </div>
  );
}

function TableShell({ children, toolbar }: { children: React.ReactNode; toolbar: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel/60 px-4 py-2">{toolbar}</div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

const th = "sticky top-0 bg-panel px-3 py-2 text-left text-xs font-medium text-muted";
const td = "px-3 py-2 align-top";

function MoreRows({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="p-3 text-center">
      <button type="button" onClick={onMore} className="text-sm text-ocean hover:underline">
        Show more ({(total - shown).toLocaleString()} left)
      </button>
    </div>
  );
}

function EntitiesTable({
  graph,
  onOpen,
  sourceNames,
}: {
  graph: KgGraph;
  onOpen: (id: string) => void;
  sourceNames?: Record<string, string>;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState(ROWS);
  const rows = useMemo(() => {
    const f = fold(q.trim());
    return graph.nodes.filter(
      (n) => (!kind || n.kind === kind) && (!f || fold([n.label, n.id, ...n.aliases, n.definition].join(" ")).includes(f)),
    );
  }, [graph, q, kind]);
  return (
    <TableShell
      toolbar={
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className={`${inputClass} max-w-xs`} />
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputClass} max-w-xs`}>
            <option value="">All classes</option>
            {Object.entries(graph.kinds).map(([id, k]) => (
              <option key={id} value={id}>
                {k.label} ({k.count})
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">{rows.length.toLocaleString()} entities</span>
        </>
      }
    >
      <table className="w-full text-sm">
        <thead>
          <tr>
            {["ID", "Entity", "Class", "Relations", "Description", sourceNames ? "Extractions" : "Pages"].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((n) => (
            <tr key={n.id} className="border-t border-line hover:bg-panel/60">
              <td className={`${td} font-mono text-xs text-muted`}>{n.id}</td>
              <td className={td}>
                <button type="button" onClick={() => onOpen(n.id)} className="text-left hover:text-ocean">
                  {n.label}
                </button>
                {n.aliases.length > 0 && <div className="text-xs text-muted">{n.aliases.slice(0, 4).join(" · ")}</div>}
              </td>
              <td className={td}>
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <span className="h-2 w-2 rounded-full" style={{ background: graph.kinds[n.kind]?.color }} />
                  {graph.kinds[n.kind]?.label ?? n.kind}
                </span>
              </td>
              <td className={`${td} tabular-nums`}>{n.degree}</td>
              <td className={`${td} max-w-xl text-xs text-soft`}>{n.definition}</td>
              <td className={`${td} text-xs text-muted`}>
                {sourceNames ? (n.sources ?? []).map((s) => sourceNames[s] ?? s).join(", ") : pageRanges(n.pages)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreRows shown={limit} total={rows.length} onMore={() => setLimit(limit + ROWS)} />
    </TableShell>
  );
}

function RelationsTable({
  graph,
  byId,
  onOpen,
  sourceNames,
}: {
  graph: KgGraph;
  byId: Map<string, KgNode>;
  onOpen: (id: string) => void;
  sourceNames?: Record<string, string>;
}) {
  const [q, setQ] = useState("");
  const [pred, setPred] = useState("");
  const [limit, setLimit] = useState(ROWS);
  const rows = useMemo(() => {
    const f = fold(q.trim());
    return graph.links.filter((l) => {
      if (pred && l.predicate !== pred) return false;
      if (!f) return true;
      const s = byId.get(l.source)?.label ?? "";
      const t = byId.get(l.target)?.label ?? "";
      return fold(`${s} ${t} ${l.evidence.map((e) => e.quote).join(" ")}`).includes(f);
    });
  }, [graph, byId, q, pred]);
  const nodeCell = (id: string) => {
    const n = byId.get(id);
    return (
      <button type="button" onClick={() => onOpen(id)} className="inline-flex items-center gap-1.5 text-left hover:text-ocean">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: n ? graph.kinds[n.kind]?.color : undefined }} />
        {n?.label ?? id}
      </button>
    );
  };
  return (
    <TableShell
      toolbar={
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject, object or evidence…" className={`${inputClass} max-w-sm`} />
          <select value={pred} onChange={(e) => setPred(e.target.value)} className={`${inputClass} max-w-xs`}>
            <option value="">All relations</option>
            {Object.entries(graph.predicates).map(([id, p]) => (
              <option key={id} value={id}>
                {p.label} ({p.count})
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">{rows.length.toLocaleString()} relations</span>
        </>
      }
    >
      <table className="w-full text-sm">
        <thead>
          <tr>
            {["Subject", "Relation", "Object", "Evidence"].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((l) => (
            <tr key={linkId(l)} className="border-t border-line hover:bg-panel/60">
              <td className={td}>{nodeCell(l.source)}</td>
              <td className={`${td} whitespace-nowrap text-xs`} style={{ color: graph.predicates[l.predicate]?.color }}>
                {graph.predicates[l.predicate]?.label ?? l.predicate}
              </td>
              <td className={td}>{nodeCell(l.target)}</td>
              <td className={`${td} max-w-xl text-xs`}>
                {l.evidence[0] && (
                  <>
                    <q className="text-soft">{l.evidence[0].quote}</q>
                    <span className="ml-1 text-muted">
                      {l.evidence[0].page ? `p. ${l.evidence[0].page}` : ""}
                      {l.evidence[0].from && sourceNames ? ` · ${sourceNames[l.evidence[0].from] ?? ""}` : ""}
                      {l.evidence.length > 1 ? ` · +${l.evidence.length - 1} more` : ""}
                    </span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <MoreRows shown={limit} total={rows.length} onMore={() => setLimit(limit + ROWS)} />
    </TableShell>
  );
}

function OntologyView({ graph }: { graph: KgGraph }) {
  const children = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const c of graph.classes) {
      const p = c.parent && graph.kinds[c.parent] ? c.parent : "";
      out.set(p, [...(out.get(p) ?? []), c.id]);
    }
    return out;
  }, [graph]);

  const renderClass = (id: string, depth: number): React.ReactNode => {
    const c = graph.classes.find((x) => x.id === id)!;
    const k = graph.kinds[id];
    return (
      <div key={id}>
        <div className="flex items-start gap-2 border-t border-line py-2" style={{ paddingLeft: 12 + depth * 20 }}>
          <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: k?.color }} />
          <div className="min-w-0 flex-1">
            <div className="text-sm">
              <span className="font-medium">{c.label}</span> <span className="font-mono text-xs text-muted">{c.id}</span>
            </div>
            {c.description && <div className="text-xs text-soft">{c.description}</div>}
          </div>
          <span className="pr-3 text-xs tabular-nums text-muted">{k?.count ?? 0}</span>
        </div>
        {(children.get(id) ?? []).map((ch) => renderClass(ch, depth + 1))}
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        {(graph.meta.title || graph.meta.domain) && (
          <div>
            <h2 className="text-lg font-semibold">{graph.meta.title}</h2>
            {graph.meta.domain && <p className="text-sm text-soft">{graph.meta.domain}</p>}
          </div>
        )}
        <div className="overflow-hidden rounded-xl border border-line bg-panel/40">
          <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
            Classes · {graph.classes.length}
          </div>
          {(children.get("") ?? []).map((id) => renderClass(id, 0))}
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-panel/40">
          <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
            Object properties · {graph.properties.length}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr>
                {["Property", "Domain → Range", "Description", "Used"].map((h) => (
                  <th key={h} className="border-t border-line px-3 py-2 text-left text-xs font-medium text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {graph.properties.map((p) => (
                <tr key={p.id} className="border-t border-line">
                  <td className={td}>
                    <div style={{ color: graph.predicates[p.id]?.color }}>{p.label}</div>
                    <div className="font-mono text-xs text-muted">{p.id}</div>
                  </td>
                  <td className={`${td} whitespace-nowrap text-xs text-soft`}>
                    {graph.kinds[p.domain]?.label ?? (p.domain || "any")} → {graph.kinds[p.range]?.label ?? (p.range || "any")}
                  </td>
                  <td className={`${td} text-xs text-soft`}>{p.description}</td>
                  <td className={`${td} tabular-nums`}>{graph.predicates[p.id]?.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
