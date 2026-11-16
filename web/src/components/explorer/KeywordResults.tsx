"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { ValueCell } from "@/components/ontology/parts";
import { explorer, recents, type KeywordHit, type KeywordResult } from "@/lib/explorer";
import type { ObjectType } from "@/lib/ontology";
import { om, type Group, type ObjectView } from "@/lib/ontologyModel";
import { compactNum, SearchPill } from "./SearchPill";

/* The results of a keyword search across object types: objects or object types, a filter by object type, the matching
   properties highlighted, and a preview of the selected object (its details, links and object type). */

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const words = terms.map((t) => t.replace(/[*?]/g, "")).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-sand/30 px-px text-white">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function KeywordResults({
  q,
  types,
  groups,
  scope,
  onScope,
  onSearch,
  onOpenType,
  onLineage,
}: {
  q: string;
  types: ObjectType[];
  groups: Group[];
  scope: string[];
  onScope: (ids: string[]) => void;
  onSearch: (q: string) => void;
  onOpenType: (id: string) => void;
  onLineage: (typeIds: string[]) => void;
}) {
  const router = useRouter();
  const [res, setRes] = useState<{ key: string; data: KeywordResult } | null>(null);
  const [err, setErr] = useState<{ key: string; msg: string } | null>(null);
  const [onlyType, setOnlyType] = useState<string | null>(null);
  const [tab, setTab] = useState<"objects" | "types">("objects");
  const [typeFind, setTypeFind] = useState("");
  const [sel, setSel] = useState<KeywordHit | null>(null);
  const [page, setPage] = useState(0);
  const [all, setAll] = useState<KeywordResult["by_type"]>([]);
  const key = JSON.stringify({ q, scope, onlyType, page });
  useEffect(() => {
    const k = JSON.stringify({ q, scope, onlyType, page });
    explorer.keyword({ q, object_type_ids: scope, only_type: onlyType, offset: page * 50, limit: 50 }).then(
      (d) => {
        setRes({ key: k, data: d });
        if (!onlyType) setAll(d.by_type);
      },
      (e: Error) => setErr({ key: k, msg: e.message }),
    );
  }, [q, scope, onlyType, page]);
  const data = res?.key === key ? res.data : null;
  const error = err?.key === key ? err.msg : null;
  const terms = q.split(/\s+/).filter((w) => w && !["AND", "OR", "NOT"].includes(w));
  const byType = all.length ? all : (data?.by_type ?? []);
  const objectTotal = byType.reduce((s, t) => s + t.count, 0);
  const pages = data ? Math.ceil(data.total / 50) : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-panel px-4 py-3">
        <SearchPill key={q} compact types={types} groups={groups} scope={scope} onScope={onScope} initial={q} onSearch={onSearch} onOpenType={onOpenType} />
        <div className="mt-3 flex items-center gap-4 text-sm">
          <button type="button" onClick={() => setTab("objects")} className={`-mb-px border-b-2 pb-1 ${tab === "objects" ? "border-ocean text-white" : "border-transparent text-muted"}`}>
            Objects <span className="ml-1 rounded bg-panel-2 px-1.5 text-[11px] text-soft">{data || all.length ? objectTotal.toLocaleString() : "…"}</span>
          </button>
          <button type="button" onClick={() => setTab("types")} className={`-mb-px border-b-2 pb-1 ${tab === "types" ? "border-ocean text-white" : "border-transparent text-muted"}`}>
            Object types <span className="ml-1 rounded bg-panel-2 px-1.5 text-[11px] text-soft">{data?.object_types.length ?? "…"}</span>
          </button>
          {data && (
            <span className="ml-auto text-[11px] text-muted">
              {data.searched} object types searched{data.skipped_count ? ` · ${data.skipped_count} not searched (large or out of time: pick them in Search across)` : ""} · {data.compute_seconds} compute-seconds
            </span>
          )}
        </div>
      </div>
      {error && <p className="m-4 rounded-md bg-bad/10 p-3 text-sm text-bad">{error}</p>}
      {tab === "types" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!data ? (
            <div className="h-24 animate-pulse rounded-xl bg-panel-2/40" />
          ) : data.object_types.length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.object_types.map((ot) => {
                const t = types.find((x) => x.id === ot.id);
                return (
                  <button key={ot.id} type="button" onClick={() => onOpenType(ot.id)} className="rounded-xl border border-line bg-panel p-4 text-left hover:border-ocean/60">
                    <div className="flex items-center gap-2">
                      <TypeIcon t={t ?? {}} className="h-4 w-4" />
                      <span className="text-sm font-medium text-white">
                        <Highlight text={ot.display_name} terms={terms} />
                      </span>
                    </div>
                    <div className="mt-2 line-clamp-2 text-xs text-muted">{ot.description || "No description"}</div>
                    <div className="mt-2 text-[11px] text-muted">Object type · {compactNum(ot.object_count ?? 0)} objects</div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted">No object type name matches “{q}”.</p>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[240px_minmax(0,1fr)_380px]">
          <aside className="hidden min-h-0 overflow-y-auto border-r border-line p-3 lg:block">
            <div className="mb-2 text-xs font-medium text-soft">Filter results by type</div>
            <input value={typeFind} onChange={(e) => setTypeFind(e.target.value)} placeholder="Search…" className="mb-2 w-full rounded-md border border-line-2 bg-ink px-2 py-1 text-xs outline-none" />
            {byType
              .filter((t) => !typeFind || t.display_name.toLowerCase().includes(typeFind.toLowerCase()))
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => (setOnlyType(onlyType === t.id ? null : t.id), setPage(0), setSel(null))}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${onlyType === t.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
                  data-oe-type-filter={t.id}
                >
                  <TypeIcon t={t} className="h-3.5 w-3.5" box="rounded p-0.5" />
                  <span className="min-w-0 flex-1 truncate">{t.display_name}</span>
                  <span className="rounded bg-panel-2 px-1.5 tabular-nums text-muted">{t.count.toLocaleString()}</span>
                </button>
              ))}
            {byType.length > 0 && (
              <button type="button" onClick={() => onLineage(byType.map((t) => t.id))} className="mt-3 flex w-full items-center gap-2 rounded-md border border-line-2 px-2 py-1.5 text-xs text-soft hover:border-ocean/60" data-oe-lineage-results>
                <Icon name="split" className="h-3.5 w-3.5 text-ocean" /> Explore lineage of these {byType.length} types
              </button>
            )}
          </aside>
          <section className="min-h-0 overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-ink/95 px-4 py-2 text-sm backdrop-blur">
              <span className="text-white">{data ? `${data.total.toLocaleString()} objects matching “${q}”` : "Searching…"}</span>
              {onlyType && (
                <button type="button" onClick={() => (setOnlyType(null), setPage(0))} className="rounded-full bg-ocean/15 px-2 py-0.5 text-[11px] text-ocean">
                  {byType.find((t) => t.id === onlyType)?.display_name} ✕
                </button>
              )}
              {onlyType && (
                <button type="button" onClick={() => onOpenType(onlyType)} className="ml-auto text-xs text-ocean hover:underline">
                  Explore this object type →
                </button>
              )}
            </div>
            {!data ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-lg bg-panel-2/40" />
                ))}
              </div>
            ) : data.objects.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted">No objects match “{q}”.</p>
            ) : (
              <ul className="divide-y divide-line/60">
                {data.objects.map((o) => (
                  <li key={`${o.object_type_id}:${o.primary_key}`}>
                    <button
                      type="button"
                      onClick={() => setSel(o)}
                      onDoubleClick={() => router.push(`/ontology/objects/${o.object_type_id}/${encodeURIComponent(o.primary_key)}`)}
                      className={`flex w-full items-start gap-3 px-4 py-2.5 text-left ${sel?.primary_key === o.primary_key && sel.object_type_id === o.object_type_id ? "bg-ocean/10" : "hover:bg-panel-2/50"}`}
                      data-oe-hit
                    >
                      <TypeIcon t={o} className="h-4 w-4" box="mt-0.5 rounded-md p-1" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-white">
                          <Highlight text={o.title} terms={terms} />
                        </span>
                        <span className="block text-[11px] text-muted">Object type: {o.type_name}</span>
                        {o.matches.map((m) => (
                          <span key={m.property} className="block truncate text-[11px] text-soft">
                            <span className="text-muted">{m.display_name}: </span>
                            <Highlight text={m.value} terms={terms} />
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pages > 1 && (
              <div className="flex items-center justify-center gap-3 p-3 text-xs">
                <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="text-muted hover:text-white disabled:opacity-40">
                  ← Previous
                </button>
                <span className="text-muted">
                  Page {page + 1} of {pages}
                </span>
                <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="text-muted hover:text-white disabled:opacity-40">
                  Next →
                </button>
              </div>
            )}
          </section>
          <aside className="hidden min-h-0 overflow-y-auto border-l border-line lg:block">
            {sel ? <Preview hit={sel} onOpenType={onOpenType} onLineage={onLineage} terms={terms} /> : <p className="p-6 text-center text-xs text-muted">Select an object to preview it.</p>}
          </aside>
        </div>
      )}
    </div>
  );
}

function Preview({ hit, onOpenType, onLineage, terms }: { hit: KeywordHit; onOpenType: (id: string) => void; onLineage: (ids: string[]) => void; terms: string[] }) {
  const [view, setView] = useState<{ key: string; v: ObjectView } | null>(null);
  const [tab, setTab] = useState<"details" | "links" | "type">("details");
  const [filter, setFilter] = useState("");
  const key = `${hit.object_type_id}:${hit.primary_key}`;
  useEffect(() => {
    const k = `${hit.object_type_id}:${hit.primary_key}`;
    om.objectView(hit.object_type_id, hit.primary_key).then((v) => setView({ key: k, v }), () => setView({ key: `!${k}`, v: null as unknown as ObjectView }));
  }, [hit.object_type_id, hit.primary_key]);
  const v = view?.key === key ? view.v : null;
  const href = `/ontology/objects/${hit.object_type_id}/${encodeURIComponent(hit.primary_key)}`;
  const t = v?.object_type;
  return (
    <div className="p-4" data-oe-preview>
      <div className="flex items-start gap-2">
        <TypeIcon t={hit} className="h-5 w-5" box="rounded-lg p-1.5" />
        <div className="min-w-0 flex-1">
          <Link href={href} onClick={() => recents.add({ kind: "object", id: hit.object_type_id, pk: hit.primary_key, title: hit.title, typeName: hit.type_name, icon: hit.icon, color: hit.color })} className="line-clamp-2 text-sm font-semibold text-white hover:text-ocean">
            {hit.title}
          </Link>
          <div className="text-[11px] text-muted">{hit.type_name}</div>
        </div>
        <Link href={href} className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-white" title="Open the object">
          <Icon name="external" className="h-4 w-4" />
        </Link>
      </div>
      <div className="mt-3 flex gap-4 border-b border-line text-xs">
        {(
          [
            ["details", "Details"],
            ["links", "Links"],
            ["type", "Object type details"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 pb-1.5 ${tab === k ? "border-ocean text-white" : "border-transparent text-muted"}`}>
            {l}
          </button>
        ))}
      </div>
      {view?.key === `!${key}` ? (
        <p className="mt-3 rounded-md bg-bad/10 p-2 text-xs text-bad">This object could not be loaded.</p>
      ) : !v ? (
        <div className="mt-3 h-40 animate-pulse rounded-lg bg-panel-2/40" />
      ) : tab === "details" ? (
        <>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter properties…" className="mt-3 w-full rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs outline-none" />
          <dl className="mt-3 space-y-2.5">
            {t!.properties
              .filter((p) => p.visibility !== "hidden" && (!filter || (p.display_name || p.api_name).toLowerCase().includes(filter.toLowerCase())))
              .map((p) => {
                const val = v.object.properties[p.api_name];
                return (
                  <div key={p.api_name}>
                    <dt className="text-[11px] text-muted">{p.display_name || p.api_name}</dt>
                    <dd className="break-words text-xs text-soft">
                      {typeof val === "string" ? <Highlight text={val} terms={terms} /> : <ValueCell type={p.type} value={val} prop={p} object={v.object.properties} />}
                    </dd>
                  </div>
                );
              })}
          </dl>
        </>
      ) : tab === "links" ? (
        <div className="mt-3 space-y-3">
          {v.links.length === 0 && <p className="text-xs text-muted">No links.</p>}
          {v.links.map((l) => (
            <div key={`${l.link_type_id}:${l.direction}`}>
              <div className="mb-1 flex items-center gap-2 text-xs">
                <span className="font-medium text-soft">{l.name}</span>
                <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted">{l.count}</span>
              </div>
              {l.objects.slice(0, 5).map((o) => (
                <Link key={o.primary_key} href={`/ontology/objects/${l.object_type_id}/${encodeURIComponent(o.primary_key)}`} className="block truncate rounded px-2 py-1 text-xs text-soft hover:bg-panel-2 hover:text-ocean">
                  {o.title}
                </Link>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-xs">
          <div className="text-soft">{t!.display_name}</div>
          <div className="text-muted">{t!.description || "No description"}</div>
          <div className="flex justify-between border-t border-line pt-2">
            <span className="text-muted">API name</span>
            <span className="font-mono text-soft">{t!.api_name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Properties</span>
            <span className="text-soft">{t!.properties.length}</span>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <button type="button" onClick={() => onOpenType(t!.id)} className="rounded-md border border-line-2 px-2 py-1 text-soft hover:border-ocean/60">
              Explore {t!.plural_name || t!.display_name}
            </button>
            <button type="button" onClick={() => onLineage([t!.id])} className="rounded-md border border-line-2 px-2 py-1 text-soft hover:border-ocean/60">
              Explore data lineage
            </button>
            <Link href={`/ontology/${t!.id}`} className="rounded-md border border-line-2 px-2 py-1 text-soft hover:border-ocean/60">
              Configure in Ontology Manager
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
