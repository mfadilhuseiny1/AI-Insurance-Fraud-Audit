"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { buttonClass } from "@/components/pipeline/Modal";
import { explorer, favorites, isTestName, recents, type ExplorerHome, type RecentItem } from "@/lib/explorer";
import type { ObjectType } from "@/lib/ontology";
import type { Exploration, Group } from "@/lib/ontologyModel";
import { compactNum, SearchPill } from "./SearchPill";

/* Object Explorer's landing page: the search, "Relevant to you" (recents, favorites, saved explorations) and
   "Discover your Nexus" (object type groups, the applications built on them, every object type). */

export function ExplorerLanding({
  types,
  groups,
  saved,
  scope,
  onScope,
  onSearch,
  onOpenType,
  onLineage,
  onExploration,
}: {
  types: ObjectType[];
  groups: Group[];
  saved: Exploration[];
  scope: string[];
  onScope: (ids: string[]) => void;
  onSearch: (q: string) => void;
  onOpenType: (id: string) => void;
  onLineage: (typeIds: string[]) => void;
  onExploration: (e: Exploration) => void;
}) {
  const [relevant, setRelevant] = useState<"recents" | "favorites" | "explorations">("recents");
  const [more, setMore] = useState(false);
  const [lists, setLists] = useState<{ recents: RecentItem[]; favorites: RecentItem[] }>({ recents: [], favorites: [] });
  useEffect(() => {
    // browser storage is read after mount (the server render has none)
    const t = setTimeout(() => setLists({ recents: recents.list(), favorites: favorites.list() }), 0);
    return () => clearTimeout(t);
  }, []);
  const cards: { key: string; href?: string; onClick?: () => void; title: string; sub: string; t: { icon?: string; color?: string | null }; star?: RecentItem }[] =
    relevant === "explorations"
      ? saved.map((e) => ({ key: e.id, onClick: () => onExploration(e), title: e.name, sub: `Exploration · ${types.find((t) => t.id === e.spec.object_type_id)?.display_name ?? ""}`, t: { icon: "search" } }))
      : (relevant === "recents" ? lists.recents : lists.favorites).map((r) =>
          r.kind === "type"
            ? { key: `t:${r.id}`, onClick: () => onOpenType(r.id), title: r.title, sub: `Object Type${r.count != null ? ` · ${compactNum(r.count)} objects` : ""}`, t: r, star: r }
            : { key: `o:${r.id}:${r.pk}`, href: `/ontology/objects/${r.id}/${encodeURIComponent(r.pk)}`, title: r.title, sub: `Object · ${r.typeName}`, t: r, star: r },
        );
  const visibleCards = more ? cards : cards.slice(0, 3);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-line bg-gradient-to-b from-ocean/[0.06] to-transparent px-4 pb-10 pt-12">
        <h1 className="mb-6 text-center text-2xl font-semibold text-white">Welcome to Object Explorer</h1>
        <div className="flex justify-center">
          <SearchPill types={types} groups={groups} scope={scope} onScope={onScope} onSearch={onSearch} onOpenType={onOpenType} />
        </div>
      </div>
      <div className="mx-auto max-w-6xl space-y-10 px-6 py-8">
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="flex-1 text-base font-semibold text-white">Relevant to you</h2>
            {(
              [
                ["recents", "Recents"],
                ["favorites", "Favorites"],
                ["explorations", "Your explorations and lists"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" onClick={() => (setRelevant(k), setMore(false))} className={`rounded-full px-3 py-1 text-xs ${relevant === k ? "bg-ocean/20 text-white ring-1 ring-ocean/50" : "bg-panel-2 text-muted hover:text-soft"}`}>
                {l}
              </button>
            ))}
          </div>
          {cards.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-2 p-6 text-center text-sm text-muted">
              {relevant === "recents" ? "Object types and objects you open show here." : relevant === "favorites" ? "Star an object type or an object to keep it here." : "Save an exploration to find it here."}
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visibleCards.map((c) => {
                  const body = (
                    <>
                      <div className="flex items-start justify-between">
                        <TypeIcon t={c.t} className="h-5 w-5" box="rounded-lg p-1.5" />
                        {c.star && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              favorites.toggle(c.star!);
                              setLists({ recents: recents.list(), favorites: favorites.list() });
                            }}
                            className="text-muted hover:text-sand"
                            title="Favorite"
                          >
                            <Icon name="star" className={`h-4 w-4 ${favorites.has(c.star) ? "fill-current text-sand" : ""}`} />
                          </span>
                        )}
                      </div>
                      <div className="mt-6 line-clamp-1 text-sm font-medium text-white">{c.title}</div>
                      <div className="mt-1 text-xs text-muted">{c.sub}</div>
                    </>
                  );
                  const cls = "block rounded-xl border border-line bg-panel p-4 text-left transition hover:border-ocean/60 hover:bg-panel-2/60";
                  return c.href ? (
                    <Link key={c.key} href={c.href} className={cls}>
                      {body}
                    </Link>
                  ) : (
                    <button key={c.key} type="button" onClick={c.onClick} className={cls}>
                      {body}
                    </button>
                  );
                })}
              </div>
              {cards.length > 3 && (
                <div className="mt-2 text-center">
                  <button type="button" onClick={() => setMore(!more)} className="text-xs text-muted hover:text-white">
                    {more ? "Show less" : "Show more"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
        <Discover types={types} onOpenType={onOpenType} onLineage={onLineage} />
      </div>
    </div>
  );
}

function Discover({ types, onOpenType, onLineage }: { types: ObjectType[]; onOpenType: (id: string) => void; onLineage: (ids: string[]) => void }) {
  const [home, setHome] = useState<ExplorerHome | null>(null);
  const [tab, setTab] = useState<"groups" | "apps" | "all">("groups");
  const [left, setLeft] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [sort, setSort] = useState<"name" | "objects" | "apps">("objects");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    explorer.home().then(setHome, () => setHome({ groups: [], applications: [], object_types: {} }));
  }, []);
  const shown = useMemo(() => types.filter((t) => t.visibility !== "hidden" && !isTestName(t.display_name)), [types]);
  const homeGroups = home?.groups ?? [];
  const apps = home?.applications ?? [];
  const leftItems = tab === "groups" ? homeGroups.map((g) => ({ id: g.id, name: g.name, ids: g.object_type_ids })) : tab === "apps" ? apps.map((a) => ({ id: a.id, name: a.name, ids: a.object_type_ids, href: a.href })) : [];
  const leftHit = leftItems.find((i) => i.id === left) ?? (tab === "all" ? null : leftItems[0]);
  const rows = (tab === "all" ? shown : shown.filter((t) => leftHit?.ids.includes(t.id)))
    .filter((t) => tab !== "all" || !find || t.display_name.toLowerCase().includes(find.toLowerCase()))
    .sort((a, b) =>
      sort === "name" ? a.display_name.localeCompare(b.display_name) : sort === "apps" ? (home?.object_types[b.id]?.applications ?? 0) - (home?.object_types[a.id]?.applications ?? 0) : (b.object_count ?? 0) - (a.object_count ?? 0),
    );
  const th = (k: typeof sort, l: string, cls = "") => (
    <th className={`px-3 py-2 font-normal ${cls}`}>
      <button type="button" onClick={() => setSort(k)} className={`inline-flex items-center gap-1 ${sort === k ? "text-white" : "hover:text-soft"}`}>
        {l} {sort === k && <Icon name="down" className="h-3 w-3" />}
      </button>
    </th>
  );
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-base font-semibold text-white">Discover your Nexus</h2>
        {picked.size > 0 && (
          <button type="button" onClick={() => onLineage([...picked])} className={buttonClass.secondary} data-oe-lineage>
            <Icon name="split" className="h-3.5 w-3.5" /> Explore lineage ({picked.size})
          </button>
        )}
        {(
          [
            ["groups", "Object type groups"],
            ["apps", "Applications"],
            ["all", `All object types ${shown.length}`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" onClick={() => (setTab(k), setLeft(null))} className={`rounded-full px-3 py-1 text-xs ${tab === k ? "bg-ocean/20 text-white ring-1 ring-ocean/50" : "bg-panel-2 text-muted hover:text-soft"}`}>
            {l}
          </button>
        ))}
      </div>
      <div className={`grid min-h-[320px] overflow-hidden rounded-xl border border-line bg-panel ${tab === "all" ? "" : "md:grid-cols-[260px_1fr]"}`}>
        {tab !== "all" && (
          <div className="border-b border-line md:border-b-0 md:border-r">
            <div className="border-b border-line p-2">
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder={tab === "groups" ? "Search for object type groups…" : "Search applications…"} className="w-full rounded-md bg-panel-2 px-2 py-1.5 text-xs outline-none" />
            </div>
            <div className="max-h-[420px] overflow-y-auto py-1">
              {leftItems.filter((i) => !find || i.name.toLowerCase().includes(find.toLowerCase())).map((i) => (
                <button key={i.id} type="button" onClick={() => setLeft(i.id)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${leftHit?.id === i.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
                  <Icon name={tab === "groups" ? "grid" : "device"} className="h-3.5 w-3.5 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  <span className="text-muted">{i.ids.length}</span>
                </button>
              ))}
              {!leftItems.length && <p className="p-3 text-xs text-muted">{tab === "groups" ? "No object type groups yet: group object types in Ontology Manager → Groups." : "No application uses an object type yet."}</p>}
            </div>
          </div>
        )}
        <div className="min-w-0">
          {tab === "all" && (
            <div className="border-b border-line p-2">
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search object types…" className="w-full max-w-sm rounded-md bg-panel-2 px-2 py-1.5 text-xs outline-none" />
            </div>
          )}
          {tab === "apps" && leftHit && "href" in leftHit && (
            <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
              <span className="text-muted">Object types used by</span>
              <Link href={leftHit.href as string} className="text-ocean hover:underline">
                {leftHit.name} →
              </Link>
            </div>
          )}
          <div className="max-h-[460px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-left text-muted">
                <tr className="border-b border-line">
                  <th className="w-8 px-3 py-2" />
                  {th("name", "Name")}
                  {th("apps", "Applications", "w-28")}
                  <th className="w-20 px-3 py-2 font-normal">Links</th>
                  {th("objects", "Objects", "w-24 text-right")}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b border-line/60 hover:bg-panel-2/50">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={picked.has(t.id)}
                        onChange={() => {
                          const n = new Set(picked);
                          if (n.has(t.id)) n.delete(t.id);
                          else n.add(t.id);
                          setPicked(n);
                        }}
                        aria-label={`Select ${t.display_name}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => onOpenType(t.id)} className="flex items-center gap-2 text-left text-soft hover:text-ocean">
                        <TypeIcon t={t} className="h-3.5 w-3.5" box="rounded p-0.5" />
                        <span className="line-clamp-1">{t.display_name}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted">{home?.object_types[t.id]?.applications ?? "…"}</td>
                    <td className="px-3 py-2 tabular-nums text-muted">{home?.object_types[t.id]?.links ?? "…"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-soft">{(t.object_count ?? 0).toLocaleString()}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-muted">
                      Nothing here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
