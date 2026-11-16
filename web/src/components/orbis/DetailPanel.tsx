"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Adjacency, KindMeta, LinkRow, OrbisNode, PredicateMeta } from "@/lib/orbis";

/* A node's card: what it is, its attributes, where it lives on the platform, and every relation it has. */

interface Props {
  node: OrbisNode;
  nodeIndex: Map<string, OrbisNode>;
  adjacency: Adjacency;
  kinds: Record<string, KindMeta>;
  predicates: Record<string, PredicateMeta>;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onPathFrom: (id: string) => void;
  onPathTo: (id: string) => void;
  onClose: () => void;
}

const SHOW = 12;

export default function DetailPanel({ node, nodeIndex, adjacency, kinds, predicates, onSelect, onFocus, onPathFrom, onPathTo, onClose }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const map = new Map<string, { predicate: string; direction: "out" | "in"; items: { link: LinkRow; other: OrbisNode }[] }>();
    const add = (link: LinkRow, direction: "out" | "in") => {
      const other = nodeIndex.get(direction === "out" ? link.t : link.s);
      if (!other) return;
      const key = `${direction}:${link.predicate}`;
      let g = map.get(key);
      if (!g) map.set(key, (g = { predicate: link.predicate, direction, items: [] }));
      g.items.push({ link, other });
    };
    for (const l of adjacency.out.get(node.id) ?? []) add(l, "out");
    for (const l of adjacency.in.get(node.id) ?? []) add(l, "in");
    return [...map.values()]
      .sort((a, b) => (a.predicate === "instanceOf" ? 1 : 0) - (b.predicate === "instanceOf" ? 1 : 0) || (a.direction === b.direction ? b.items.length - a.items.length : a.direction === "out" ? -1 : 1))
      .map((g) => ({ ...g, items: g.items.sort((x, y) => y.other.degree - x.other.degree || x.other.label.localeCompare(y.other.label)) }));
  }, [node.id, adjacency, nodeIndex]);

  const kind = kinds[node.kind];
  const external = node.url && /^https?:/.test(node.url);
  return (
    <aside className="fade-in flex h-full w-[390px] shrink-0 flex-col border-l panel" key={node.id}>
      <header className="flex items-start gap-2 border-b p-3">
        <span className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: kind?.color ?? "#94a3b8" }} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium leading-snug">{node.label}</div>
          <div className="mono mt-1 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
            <span>{kind?.label ?? node.kind}</span>
            <span>·</span>
            <span className="max-w-44 truncate">{node.rawId}</span>
            <span>·</span>
            <span>{node.degree} relasi</span>
          </div>
        </div>
        <button className="btn" onClick={onClose} title="Tutup">
          ✕
        </button>
      </header>

      <div className="flex flex-wrap gap-1.5 border-b p-3">
        <button className="btn" onClick={() => onFocus(node.id)}>
          Fokus sekitar
        </button>
        <button className="btn" onClick={() => onPathFrom(node.id)}>
          Jalur dari
        </button>
        <button className="btn" onClick={() => onPathTo(node.id)}>
          Jalur ke
        </button>
        {node.url &&
          (external ? (
            <a className="btn" href={node.url} target="_blank" rel="noopener" style={{ textDecoration: "none", color: "var(--kg-accent)" }}>
              Buka sumber ↗
            </a>
          ) : (
            <Link className="btn" href={node.url} style={{ textDecoration: "none", color: "var(--kg-accent)" }}>
              Buka di platform →
            </Link>
          ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {node.definition && (
          <section className="border-b p-3">
            <p className="leading-relaxed" style={{ color: "var(--kg-text-muted)" }}>
              {node.definition}
            </p>
          </section>
        )}
        {!!node.facts?.length && (
          <section className="border-b p-3">
            <SectionTitle>Atribut</SectionTitle>
            <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5">
              {node.facts.map(([k, v], i) => (
                <div key={`${i}-${k}`} className="contents">
                  <dt className="text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
                    {k}
                  </dt>
                  <dd className="min-w-0 break-words leading-relaxed" style={{ color: "var(--kg-text-muted)" }}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <section className="p-3">
          <SectionTitle>Relasi</SectionTitle>
          <div className="space-y-3">
            {groups.map((g) => {
              const p = predicates[g.predicate];
              const key = `${g.direction}:${g.predicate}`;
              const items = open[key] ? g.items : g.items.slice(0, SHOW);
              return (
                <div key={key}>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: p?.color ?? "#64748b" }} />
                    <span className="mono text-[11px]" style={{ color: "var(--kg-text)" }}>
                      {g.direction === "out" ? (p?.label ?? g.predicate) : `← ${p?.label ?? g.predicate}`}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
                      {g.items.length}
                    </span>
                  </div>
                  <ul className="space-y-px">
                    {items.map(({ link, other }) => (
                      <li key={link.id}>
                        <button className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-[var(--kg-surface-2)]" onClick={() => onSelect(other.id)}>
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: kinds[other.kind]?.color ?? "#94a3b8" }} />
                          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--kg-text-muted)" }}>
                            {other.label}
                          </span>
                          {link.propertyLabel && <span className="chip mono shrink-0">{link.propertyLabel}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {g.items.length > SHOW && (
                    <button className="mono mt-0.5 pl-1.5 text-[10.5px] hover:underline" style={{ color: "var(--kg-accent)" }} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                      {open[key] ? "lebih sedikit" : `+${g.items.length - SHOW} lainnya`}
                    </button>
                  )}
                </div>
              );
            })}
            {!groups.length && <p style={{ color: "var(--kg-text-faint)" }}>Tidak ada relasi.</p>}
          </div>
        </section>
      </div>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mono mb-2 text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--kg-text-faint)" }}>
      {children}
    </h3>
  );
}
