"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox, Field, ParamInput, ValueCell } from "@/components/ontology/parts";
import { DrillCaptureBadge } from "@/components/ontology/DrillCaptureBadge";
import { TypeIcon } from "@/components/ontology/Datasources";
import { ExplorerLanding } from "@/components/explorer/Home";
import { KeywordResults } from "@/components/explorer/KeywordResults";
import { ExploreGrid, PropertySearch, readLayout, writeLayout, type ChartConf } from "@/components/explorer/ExploreGrid";
import { GRAPH_BRAND, ObjectGraph } from "@/components/explorer/ObjectGraph";
import { capture } from "@/lib/drillCapture";
import { buttonClass, fieldClass, Modal } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { alertDialog, promptDialog } from "@/lib/dialogs";
import { recents, tabsStore, type ExplorerTab } from "@/lib/explorer";
import { ontology, typeLabel, type ActionType, type ObjectType, type Property } from "@/lib/ontology";
import {
  exportCsv,
  FILTER_OPS,
  om,
  type Exploration,
  type Filter,
  type GeoRegion,
  type Group,
  type Histogram,
  type Interface,
  type LinkType,
  type SearchResult,
  type SearchSpec,
} from "@/lib/ontologyModel";
import { workshop } from "@/lib/workshop";
import { CarbonOpenIn } from "@/components/carbon/OpenIn";

const PAGE = 50;

export default function ObjectExplorerPage() {
  return (
    <Suspense>
      <ObjectExplorer />
    </Suspense>
  );
}

/** The exploration encoded in the address: ?spec= (a whole search, e.g. Open in Explorer from an object's links) or ?type= / ?interface= / ?q=. */
function specFrom(params: URLSearchParams): SearchSpec {
  const raw = params.get("spec");
  if (raw) {
    try {
      const s = JSON.parse(raw) as SearchSpec;
      return { filters: [], search_around: [], order: "asc", q: "", ...s };
    } catch {
      /* a broken link: the plain parameters below */
    }
  }
  return { object_type_id: params.get("type") || null, interface_id: params.get("interface") || null, q: params.get("q") ?? "", filters: [], search_around: [], order: "asc" };
}

/**
 * Object Explorer: a landing page (search across object types, what is relevant to you, discover the Nexus), keyword
 * results across object types with a preview, and explorations of one object type or interface — a chart for every
 * property, filters, Search Arounds, results, compare, export, bulk actions, Open in Workshop and data lineage —
 * each in its own exploration tab.
 */
function ObjectExplorer() {
  const router = useRouter();
  const params = useSearchParams();
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [ifaces, setIfaces] = useState<Interface[]>([]);
  const [links, setLinks] = useState<LinkType[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [saved, setSaved] = useState<Exploration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const keyword = params.get("search");
  const scope = useMemo(() => (params.get("across") ?? "").split(",").filter(Boolean), [params]);
  const paramKey = params.toString();
  const [spec, setSpec] = useState<SearchSpec>(() => specFrom(params));
  const [specFor, setSpecFor] = useState(paramKey);
  if (specFor !== paramKey) {
    // a new address (a tab, a link, back/forward): its exploration
    setSpecFor(paramKey);
    setSpec(specFrom(params));
  }
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ key: string; spec: string; data: SearchResult } | null>(null);
  const [view, setView] = useState<"explore" | "results" | "aggregate" | "compare" | "graph">("explore");
  // the graph tab stays mounted (its objects and layout) while the exploration keeps its starting type
  const graphKey = spec.object_type_id ?? spec.interface_id ?? "";
  const [graphFor, setGraphFor] = useState<string | null>(null);
  if (view === "graph" && graphFor !== graphKey) setGraphFor(graphKey);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<{ spec: SearchSpec; label: string } | null>(null);
  const [bulk, setBulk] = useState<ActionType | null>(null);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [typeCard, setTypeCard] = useState(false);
  const [gridKey, setGridKey] = useState(0);

  useEffect(() => {
    // the landing needs only the object types; the rest fills in as it arrives (one slow call no longer holds the page)
    ontology.objectTypes().then(setTypes, (e: Error) => setError(e.message));
    om.interfaces().then(setIfaces, () => {});
    om.linkTypes().then(setLinks, () => {});
    om.explorations().then(setSaved, () => {});
    om.groups().then(setGroups, () => {});
  }, []);

  const go = (qs: Record<string, string | null | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(qs)) if (v) p.set(k, v);
    router.push(`/object-explorer${p.toString() ? `?${p}` : ""}`);
  };
  const openType = (id: string) => {
    const t = types?.find((x) => x.id === id);
    if (t) recents.add({ kind: "type", id, title: t.display_name, count: t.object_count, icon: t.icon, color: t.color });
    go({ type: id });
  };
  const doSearch = (q: string) => go({ search: q, across: scope.join(",") || null });
  const setScope = (ids: string[]) => {
    const p = new URLSearchParams(params.toString());
    if (ids.length) p.set("across", ids.join(","));
    else p.delete("across");
    router.replace(`/object-explorer?${p}`);
  };
  const lineageOf = (typeIds: string[]) => router.push(`/lineage?focus=${encodeURIComponent(typeIds.map((id) => `object_type:${id}`).join(","))}`);

  const started = !!(spec.object_type_id || spec.interface_id) && !keyword;
  const fullSpec = { ...spec, all_charts: true };
  const reqKey = JSON.stringify({ ...fullSpec, page });
  const data = result?.key === reqKey ? result.data : null;
  useEffect(() => {
    if (keyword || (!spec.object_type_id && !spec.interface_id)) return;
    const s = { ...spec, all_charts: true };
    const k = JSON.stringify({ ...s, page });
    const sk = JSON.stringify(s);
    // another page of the same set: its charts are those already shown (a chart for every property costs seconds)
    const charts = page && result?.spec === sk ? result.data.histograms : null;
    const t = setTimeout(
      () =>
        om.search({ ...s, offset: page * PAGE, limit: PAGE, resource: "object-explorer", histograms: !charts }).then(
          (d) => {
            setResult({ key: k, spec: sk, data: charts ? { ...d, histograms: charts } : d });
            setError(null);
            // a team race: the type searched, the links followed, the terms (first page only)
            if (!page) capture({ object_type_id: spec.object_type_id, link_type_ids: (spec.search_around ?? []).map((s) => s.link_type_id), q: spec.q || undefined });
          },
          (e: Error) => setError(e.message),
        ),
      200,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- result is only read for the charts of the page before
  }, [spec, page, keyword]);

  const resultTypeId = data?.result_type.id;
  useEffect(() => {
    if (!resultTypeId || spec.interface_id) return;
    ontology.actionTypes(resultTypeId).then(
      (a) => setActions(a.filter((x) => x.kind !== "create" && !(x.type_classes ?? []).some((tc) => tc.endsWith(":hide-action")))),
      () => setActions([]),
    );
  }, [resultTypeId, spec.interface_id]);

  const update = (c: Partial<SearchSpec>) => {
    setSpec({ ...spec, ...c });
    setPage(0);
    setPicked(new Set());
  };
  const startType = types?.find((t) => t.id === spec.object_type_id);
  const startIface = ifaces.find((i) => i.id === spec.interface_id);
  const props: Property[] = data?.result_type.properties ?? [];
  const startProps: Property[] = startType?.properties ?? (startIface?.all_properties as Property[] | undefined) ?? [];
  const currentTypeId = spec.search_around?.length ? data?.path.at(-1)?.object_type_id : spec.object_type_id;
  const aroundOptions = useMemo(
    () =>
      links.flatMap((lt) => [
        ...(lt.source.object_type_id === currentTypeId ? [{ lt, direction: "forward" as const, name: lt.target.display_name, to: lt.target.object_type_id }] : []),
        ...(lt.target.object_type_id === currentTypeId ? [{ lt, direction: "reverse" as const, name: lt.source.display_name, to: lt.source.object_type_id }] : []),
      ]),
    [links, currentTypeId],
  );
  const typeName = (id?: string | null) => types?.find((t) => t.id === id)?.display_name ?? "";

  // the exploration tabs: the current address is the active tab
  const tabLabel = keyword ? `Search: "${keyword}"` : startType ? (startType.plural_name || startType.display_name) : startIface ? startIface.display_name : "New exploration";
  const tabIcon: ExplorerTab["icon"] = keyword ? "search" : started ? "cube" : "home";

  if (error && !types) return <ApiError message={error} />;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ExplorerTabs query={paramKey} label={tabLabel} icon={tabIcon} onGo={(q) => router.push(`/object-explorer${q ? `?${q}` : ""}`)}>
        <DrillCaptureBadge />
        <Link href="/object-views" className="rounded-md px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-white">
          Object Views
        </Link>
        <Link href="/object-monitors" className="rounded-md px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-white">
          Monitors
        </Link>
      </ExplorerTabs>

      {!types ? (
        <div className="p-8">
          <div className="mx-auto h-12 max-w-xl animate-pulse rounded-full bg-panel-2/50" />
        </div>
      ) : keyword ? (
        <KeywordResults q={keyword} types={types} groups={groups} scope={scope} onScope={setScope} onSearch={doSearch} onOpenType={openType} onLineage={lineageOf} />
      ) : !started ? (
        <ExplorerLanding
          types={types}
          groups={groups}
          saved={saved}
          scope={scope}
          onScope={setScope}
          onSearch={doSearch}
          onOpenType={openType}
          onLineage={lineageOf}
          onExploration={(e) => go({ spec: JSON.stringify(e.spec) })}
        />
      ) : (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
            <div className="relative">
              <button type="button" onClick={() => setTypeCard(!typeCard)} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium text-white hover:bg-panel-2" data-oe-typecard>
                {startType ? <TypeIcon t={startType} className="h-4 w-4" /> : <Icon name="layers" className="h-4 w-4 text-sand" />}
                <span className="underline decoration-dotted underline-offset-4">{startType?.display_name ?? startIface?.display_name}</span>
              </button>
              {typeCard && startType && <TypeCard t={startType} links={links} types={types} onClose={() => setTypeCard(false)} onOpenType={openType} />}
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-lg border border-ocean/40 bg-ink px-2 py-1">
              {(spec.filters ?? []).map((f, i) =>
                f.property === "__link" ? (
                  <LinkedChip key={i} f={f} links={links} typeName={typeName} onRemove={() => update({ filters: (spec.filters ?? []).filter((_, j) => j !== i) })} />
                ) : (
                  <FilterChip key={i} f={f} props={startProps} onChange={(nf) => update({ filters: (spec.filters ?? []).map((x, j) => (j === i ? nf : x)) })} onRemove={() => update({ filters: (spec.filters ?? []).filter((_, j) => j !== i) })} />
                ),
              )}
              <div className="flex items-center gap-1.5 rounded-md">
                <Icon name="search" className="h-3.5 w-3.5 text-muted" />
                <input value={spec.q ?? ""} onChange={(e) => update({ q: e.target.value })} placeholder="Keywords…" className="w-28 bg-transparent py-1 text-sm outline-none" />
              </div>
              <PropertySearch
                props={startProps}
                onFilter={(p) => update({ filters: [...(spec.filters ?? []), { property: p.api_name, op: "eq", value: "" }] })}
                onChart={(p) => {
                  const tid = data?.result_type.id ?? spec.object_type_id ?? "";
                  const cur = readLayout(tid) ?? (data?.histograms ?? []).map((h) => ({ property: h.property, chart: h.kind === "numeric" ? "columns" : "bars", sort: "count_desc" }) as ChartConf);
                  writeLayout(tid, [{ property: p.api_name, chart: "bars", sort: "count_desc" }, ...cur.filter((c) => c.property !== p.api_name)]);
                  setGridKey(gridKey + 1);
                  setView("explore");
                }}
              />
              {((spec.filters ?? []).length > 0 || spec.q) && (
                <button type="button" onClick={() => update({ filters: [], q: "" })} className="px-1 text-xs text-muted hover:text-white">
                  Clear
                </button>
              )}
            </div>
            {startType?.properties.some((p) => p.type === "vector") && <SemanticBox spec={spec} update={update} />}
            <button
              type="button"
              onClick={async () => {
                const name = await promptDialog("Name this exploration", startType?.plural_name ?? "", { title: "Save exploration" });
                if (!name) return;
                try {
                  const e = await om.saveExploration(name, spec);
                  setSaved([e, ...saved]);
                } catch (err) {
                  void alertDialog((err as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              <Icon name="save" className="h-3.5 w-3.5" /> Save
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-xs">
            {!spec.interface_id && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-panel-2 px-2 py-1 ring-1 ring-line-2">{startType?.plural_name}</span>
                {(spec.search_around ?? []).map((sa, i) => {
                  const lt = links.find((l) => l.id === sa.link_type_id);
                  return (
                    <span key={i} className="flex items-center gap-1">
                      <Icon name="right" className="h-3 w-3 text-muted" />
                      <span className="flex items-center gap-1 rounded bg-ocean/15 px-2 py-1 text-ocean ring-1 ring-ocean/30">
                        {sa.direction === "forward" ? lt?.target.display_name : lt?.source.display_name}
                        <span className="text-muted">({data?.path[i]?.count ?? "…"})</span>
                        {i === (spec.search_around ?? []).length - 1 && (
                          <button type="button" onClick={() => update({ search_around: (spec.search_around ?? []).slice(0, -1), sort: null, aggregate: null })} className="hover:text-white">
                            <Icon name="x" className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="mx-auto flex items-center gap-1">
              {(
                [
                  ["explore", "Explore", "graph"],
                  ["results", "Results", "list"],
                  ["aggregate", "Aggregate", "sliders"],
                  ["compare", "Compare", "split"],
                  ["graph", GRAPH_BRAND, "constellation"],
                ] as const
              ).map(([v, l, i]) => (
                <button key={v} type="button" onClick={() => setView(v)} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 ${view === v ? "bg-ocean/15 text-white" : "text-muted hover:text-white"}`} data-oe-view={v}>
                  <Icon name={i} className="h-3.5 w-3.5" /> {l}
                </button>
              ))}
            </div>
            <span className="rounded-md bg-ocean/10 px-2 py-1 text-ocean ring-1 ring-ocean/30">{data ? `${data.total.toLocaleString()} Results` : "…"}</span>
            {picked.size > 0 && actions.length > 0 && (
              <select value="" onChange={(e) => setBulk(actions.find((a) => a.id === e.target.value) ?? null)} className="rounded border border-ocean/50 bg-ocean/10 px-1.5 py-1">
                <option value="">Actions on {picked.size} selected…</option>
                {actions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" onClick={() => setPinned({ spec, label: `${data?.result_type.display_name ?? ""}${spec.q ? ` “${spec.q}”` : ""}${spec.filters?.length ? ` +${spec.filters.length} filters` : ""}` })} className={buttonClass.ghost} title="Pin this set for comparison">
              <Icon name="star" className="h-3.5 w-3.5" /> Pin
            </button>
            <button type="button" onClick={() => exportCsv(spec).catch((e: Error) => alertDialog(e.message))} className={buttonClass.ghost}>
              <Icon name="download" className="h-3.5 w-3.5" /> Export
            </button>
            {data && (
              <button type="button" onClick={() => lineageOf([data.result_type.id, ...(spec.object_type_id && spec.object_type_id !== data.result_type.id ? [spec.object_type_id] : [])])} className={buttonClass.ghost} data-oe-lineage-type>
                <Icon name="split" className="h-3.5 w-3.5" /> Lineage
              </button>
            )}
            {data?.object_type_id && (
              <button
                type="button"
                onClick={async () => {
                  const m = await workshop.create({
                    name: `${data.result_type.display_name} exploration`,
                    widgets: [
                      { id: "w1", type: "metric", title: `${data.result_type.display_name} count`, x: 0, y: 0, w: 3, h: 2, config: { source: { kind: "object_type", id: data.result_type.id }, metric: "count" } },
                      { id: "w2", type: "table", title: data.result_type.display_name, x: 0, y: 2, w: 12, h: 7, config: { source: { kind: "object_type", id: data.result_type.id } } },
                    ],
                  });
                  router.push(`/workshop/${m.id}`);
                }}
                className={buttonClass.ghost}
              >
                <Icon name="device" className="h-3.5 w-3.5" /> Open in Workshop
              </button>
            )}
            {data && <CarbonOpenIn typeId={data.result_type.id} />}
          </div>
          {error && (
            <div className="p-4">
              <ErrorBox message={error} />
            </div>
          )}
          <div className={`min-h-0 flex-1 ${view === "graph" ? "overflow-hidden" : "overflow-auto"}`}>
            {graphFor === graphKey && (
              <div className={view === "graph" ? "h-full" : "hidden"}>
                <ObjectGraph key={graphKey} types={types} data={data} spec={spec} picked={picked} onSaved={(e) => setSaved([e, ...saved])} />
              </div>
            )}
            {view === "explore" &&
              (data ? (
                <ExploreGrid
                  key={`${data.result_type.id}:${gridKey}`}
                  data={data}
                  spec={spec}
                  update={update}
                  typeId={data.result_type.id}
                  links={aroundOptions}
                  types={types}
                  onResults={() => setView("results")}
                  onAround={(id, direction) => update({ search_around: [...(spec.search_around ?? []), { link_type_id: id, direction }], sort: null, aggregate: null })}
                />
              ) : (
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-48 animate-pulse rounded-xl bg-panel-2/40" />
                  ))}
                </div>
              ))}
            {view === "results" && data && (
              <Results
                data={data}
                props={props}
                sort={spec.sort ?? null}
                order={spec.order ?? "asc"}
                onSort={(p) => update({ sort: p, order: spec.sort === p && spec.order === "asc" ? "desc" : "asc" })}
                picked={picked}
                setPicked={setPicked}
                page={page}
                setPage={setPage}
              />
            )}
            {view === "aggregate" && data && <ExplorationView data={data} props={props} spec={spec} update={update} />}
            {view === "compare" && <Compare current={spec} pinned={pinned} />}
          </div>
        </section>
      )}
      {bulk && data && (
        <BulkDialog
          action={bulk}
          typeId={data.result_type.id}
          pks={[...picked]}
          onClose={() => setBulk(null)}
          onDone={() => {
            setBulk(null);
            setPicked(new Set());
            setSpec({ ...spec });
          }}
        />
      )}
    </div>
  );
}

/** Exploration tabs: each tab is an Object Explorer address; the active one follows the current address. */
function ExplorerTabs({ query, label, icon, onGo, children }: { query: string; label: string; icon: ExplorerTab["icon"]; onGo: (q: string) => void; children?: React.ReactNode }) {
  const [tabs, setTabs] = useState<ExplorerTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    // browser storage after mount; the current address becomes (or updates) the active tab
    const t = setTimeout(() => {
      const list = tabsStore.list();
      let cur = list.find((x) => x.id === active) ?? list.find((x) => x.query === query);
      let next: ExplorerTab[];
      if (cur) next = list.map((x) => (x.id === cur!.id ? { ...x, query, label, icon } : x));
      else {
        cur = { id: Math.random().toString(36).slice(2, 10), query, label, icon };
        next = [...list, cur];
      }
      tabsStore.save(next);
      setTabs(next);
      setActive(cur.id);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, label, icon]);
  const close = (id: string) => {
    const i = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    tabsStore.save(rest);
    setTabs(rest);
    if (id === active) {
      const n = rest[Math.max(0, i - 1)];
      setActive(n?.id ?? null);
      onGo(n?.query ?? "");
    }
  };
  return (
    <div className="flex items-center gap-1 border-b border-line bg-panel px-2">
      <span className="mr-1 flex h-9 items-center px-1 text-ocean">
        <Icon name="search" className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-1 items-end overflow-x-auto">
        {tabs.map((t) => (
          <div key={t.id} className={`group flex max-w-[15rem] shrink-0 items-center gap-1.5 border-r border-line px-3 py-2 text-xs ${t.id === active ? "bg-ink text-white" : "text-muted hover:bg-panel-2 hover:text-soft"}`} data-oe-tab>
            <button type="button" onClick={() => (setActive(t.id), onGo(t.query))} className="flex min-w-0 items-center gap-1.5">
              <Icon name={t.icon} className="h-3.5 w-3.5 shrink-0 text-ocean" />
              <span className="truncate">{t.label}</span>
            </button>
            <button type="button" onClick={() => close(t.id)} className="rounded p-0.5 opacity-60 hover:bg-panel-2 hover:opacity-100" aria-label="Close tab">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const t: ExplorerTab = { id: Math.random().toString(36).slice(2, 10), query: "", label: "New exploration", icon: "home" };
            const next = [...tabs, t];
            tabsStore.save(next);
            setTabs(next);
            setActive(t.id);
            onGo("");
          }}
          className="px-2 py-2 text-muted hover:text-white"
          aria-label="New exploration tab"
          data-oe-newtab
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

/** "Linked to <type> › is any of <object>": a filter on the objects linked to one object (Open in Explorer). */
function LinkedChip({ f, links, typeName, onRemove }: { f: Filter; links: LinkType[]; typeName: (id?: string | null) => string; onRemove: () => void }) {
  const v = (f.value ?? {}) as { link_type_id?: string; direction?: "forward" | "reverse"; label?: string; filters?: Filter[] };
  const lt = links.find((l) => l.id === v.link_type_id);
  const other = lt ? (v.direction === "reverse" ? lt.source.object_type_id : lt.target.object_type_id) : null;
  const what = v.label ?? (v.filters ?? []).map((x) => String(x.value)).join(", ");
  return (
    <span className="flex items-center gap-1 rounded-md bg-panel-2 px-2 py-0.5 text-xs ring-1 ring-line-2" data-oe-linked>
      <span className="text-muted">Linked to</span>
      <span className="text-soft">{typeName(other) || lt?.display_name}</span>
      <Icon name="right" className="h-3 w-3 text-muted" />
      <span className="text-muted">is any of</span>
      <span className="font-medium text-white">{what}</span>
      <button type="button" onClick={onRemove} className="ml-0.5 text-muted hover:text-white" aria-label="Remove">
        <Icon name="x" className="h-3 w-3" />
      </button>
    </span>
  );
}

/** The object type's card: count, API name, properties, linked object types, Manage. */
function TypeCard({ t, links, types, onClose, onOpenType }: { t: ObjectType; links: LinkType[]; types: ObjectType[]; onClose: () => void; onOpenType: (id: string) => void }) {
  const linked = links.flatMap((l) => (l.source.object_type_id === t.id ? [l.target.object_type_id] : l.target.object_type_id === t.id ? [l.source.object_type_id] : []));
  return (
    <div className="absolute left-0 top-full z-40 mt-1 w-80 rounded-xl border border-line-2 bg-panel p-4 text-xs shadow-2xl" onMouseLeave={onClose}>
      <div className="flex items-start gap-2">
        <TypeIcon t={t} className="h-5 w-5" box="rounded-lg p-1.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-white">{t.display_name}</div>
          <div className="text-muted">{(t.object_count ?? 0).toLocaleString()} objects</div>
        </div>
        <Link href={`/ontology/${t.id}`} className="flex items-center gap-1 text-ocean hover:underline">
          Manage <Icon name="external" className="h-3 w-3" />
        </Link>
      </div>
      <p className="mt-3 text-muted">{t.description || "No description"}</p>
      <div className="mt-3 flex items-center justify-between rounded-md border border-line px-2 py-1.5">
        <span className="text-muted">API name</span>
        <span className="font-mono text-soft">{t.api_name}</span>
      </div>
      <div className="mt-3 rounded-md border border-line">
        <div className="flex justify-between border-b border-line px-2 py-1.5 text-muted">
          <span>Properties ({t.properties.length})</span>
        </div>
        {t.properties.slice(0, 4).map((p) => (
          <div key={p.api_name} className="flex items-center gap-1.5 px-2 py-1 text-soft">
            {p.display_name || p.api_name}
            {p.api_name === t.primary_key && <span className="rounded bg-violet-500/20 px-1 text-[9px] text-violet-200">key</span>}
            {p.api_name === t.title_property && <span className="rounded bg-emerald-500/20 px-1 text-[9px] text-emerald-200">title</span>}
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-md border border-line">
        <div className="border-b border-line px-2 py-1.5 text-muted">Linked object types ({new Set(linked).size})</div>
        {[...new Set(linked)].slice(0, 6).map((id) => {
          const o = types.find((x) => x.id === id);
          return (
            <button key={id} type="button" onClick={() => onOpenType(id)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-soft hover:text-ocean">
              <TypeIcon t={o ?? {}} className="h-3 w-3" box="rounded p-0.5" /> {o?.display_name ?? id}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({ f, props, onChange, onRemove }: { f: Filter; props: Property[]; onChange: (f: Filter) => void; onRemove: () => void }) {
  if (f.op === "in" && Array.isArray(f.value)) {
    // a list of values (objects saved from the graph's selection): shown, not edited
    const p = props.find((x) => x.api_name === f.property);
    return (
      <span className="flex items-center gap-1 rounded-md border border-ocean/40 bg-ocean/10 px-1.5 py-0.5 text-xs" title={f.value.map(String).join(", ")}>
        <span className="text-soft">{p?.display_name || f.property}</span>
        <span className="text-muted">is any of</span>
        <span className="font-medium text-white">{f.value.length === 1 ? String(f.value[0]) : `${f.value.length} values`}</span>
        <button type="button" onClick={onRemove} className="text-muted hover:text-white">
          <Icon name="x" className="h-3 w-3" />
        </button>
      </span>
    );
  }
  const geo = ["geopoint", "geoshape"].includes(props.find((p) => p.api_name === f.property)?.type ?? "");
  return (
    <span className="flex items-center gap-1 rounded-md border border-ocean/40 bg-ocean/10 px-1.5 py-0.5 text-xs">
      <select value={f.property} onChange={(e) => onChange({ ...f, property: e.target.value })} className="bg-transparent outline-none">
        <option value="__title">Title</option>
        {props.map((p) => (
          <option key={p.api_name} value={p.api_name}>
            {p.display_name || p.api_name}
          </option>
        ))}
      </select>
      <select value={f.op} onChange={(e) => onChange({ ...f, op: e.target.value as Filter["op"], value: e.target.value === "geo" ? null : f.op === "geo" ? "" : f.value })} className="bg-transparent outline-none">
        {[...FILTER_OPS, ...(geo ? [{ id: "geo" as const, label: "is in area" }] : [])].map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {f.op === "geo" ? (
        <GeoInput value={f.value as GeoRegion | null} onChange={(value) => onChange({ ...f, value })} />
      ) : f.op === "between" ? (
        <>
          <input value={String((f.value as unknown[])?.[0] ?? "")} onChange={(e) => onChange({ ...f, value: [e.target.value, (f.value as unknown[])?.[1] ?? ""] })} className="w-16 bg-transparent outline-none" placeholder="from" />
          <input value={String((f.value as unknown[])?.[1] ?? "")} onChange={(e) => onChange({ ...f, value: [(f.value as unknown[])?.[0] ?? "", e.target.value] })} className="w-16 bg-transparent outline-none" placeholder="to" />
        </>
      ) : f.op !== "is_null" && f.op !== "not_null" ? (
        <input value={String(f.value ?? "")} onChange={(e) => onChange({ ...f, value: e.target.value })} className="w-24 bg-transparent outline-none" placeholder="value" />
      ) : null}
      <button type="button" onClick={onRemove} className="text-muted hover:text-white">
        <Icon name="x" className="h-3 w-3" />
      </button>
    </span>
  );
}

function Results({
  data,
  props,
  sort,
  order,
  onSort,
  picked,
  setPicked,
  page,
  setPage,
}: {
  data: SearchResult;
  props: Property[];
  sort: string | null;
  order: "asc" | "desc";
  onSort: (p: string) => void;
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  page: number;
  setPage: (n: number) => void;
}) {
  const shown = props.filter((p) => p.visibility !== "hidden").sort((a, b) => Number(b.visibility === "prominent") - Number(a.visibility === "prominent"));
  const viewType = (o: SearchResult["objects"][number]) => o.object_type_id;
  const pages = Math.ceil(data.total / PAGE);
  if (!data.objects.length) return <p className="p-8 text-center text-sm text-muted">No objects match.</p>;
  return (
    <div>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 border-b border-line bg-panel text-left text-xs text-muted">
          <tr>
            <th className="w-8 px-3 py-2">
              <input
                type="checkbox"
                checked={data.objects.every((o) => picked.has(o.primary_key))}
                onChange={(e) => setPicked(e.target.checked ? new Set([...picked, ...data.objects.map((o) => o.primary_key)]) : new Set())}
              />
            </th>
            <th className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium" onClick={() => onSort("__title")}>
              Title {sort === "__title" ? (order === "asc" ? "↑" : "↓") : ""}
            </th>
            {shown.map((p) => (
              <th key={p.api_name} className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium" onClick={() => onSort(p.api_name)}>
                {p.display_name || p.api_name} {sort === p.api_name ? (order === "asc" ? "↑" : "↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.objects.map((o) => (
            <tr key={`${o.object_type_id}:${o.primary_key}`} className="border-b border-line align-top hover:bg-panel-2">
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={picked.has(o.primary_key)}
                  onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(o.primary_key);
                    else n.delete(o.primary_key);
                    setPicked(n);
                  }}
                />
              </td>
              <td className="px-3 py-2">
                <Link href={`/ontology/objects/${viewType(o)}/${encodeURIComponent(o.primary_key)}`} className="flex items-center gap-1.5 font-medium hover:text-ocean">
                  <Icon name="cube" className="h-3.5 w-3.5 shrink-0 text-ocean" />
                  <span className="line-clamp-1 max-w-56 break-all">{o.title}</span>
                </Link>
              </td>
              {shown.map((p) => (
                <td key={p.api_name} className="max-w-72 px-3 py-2 text-soft">
                  <ValueCell type={p.type} value={o.reduced?.[p.api_name] ?? o.properties[p.api_name]} prop={p} object={o.properties} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 p-3 text-xs">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className={buttonClass.ghost}>
            Previous
          </button>
          <span className="text-muted">
            Page {page + 1} of {pages}
          </span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className={buttonClass.ghost}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function Bars({ rows, onPick }: { rows: { label: string; count: number; value?: number | string | null; key?: unknown }[]; onPick?: (k: unknown) => void }) {
  const max = Math.max(1, ...rows.map((r) => (typeof r.value === "number" ? r.value : r.count)));
  return (
    <div className="space-y-1">
      {rows.map((r, i) => {
        const v = typeof r.value === "number" ? r.value : r.count;
        return (
          <button key={i} type="button" onClick={() => onPick?.(r.key ?? r.label)} className="group flex w-full items-center gap-2 text-left text-xs" disabled={!onPick}>
            <span className="w-28 shrink-0 truncate text-soft" title={r.label}>
              {r.label}
            </span>
            <span className="relative h-4 flex-1 rounded bg-panel-2">
              <span className="absolute inset-y-0 left-0 rounded bg-ocean/60 group-hover:bg-ocean" style={{ width: `${(v / max) * 100}%` }} />
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-muted">{typeof r.value === "number" ? r.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : r.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function histRows(h: Histogram) {
  return h.kind === "numeric"
    ? h.buckets.map((b) => ({ label: `${b.from.toLocaleString(undefined, { maximumFractionDigits: 2 })} – ${b.to.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, count: b.count, key: [b.from, b.to] }))
    : h.buckets.map((b) => ({ label: b.value, count: b.count, key: b.value }));
}

function ExplorationView({ data, props, spec, update }: { data: SearchResult; props: Property[]; spec: SearchSpec; update: (c: Partial<SearchSpec>) => void }) {
  const agg = spec.aggregate ?? { metric: "count" as const, property: null, group_by: null };
  const numeric = props.filter((p) => ["integer", "long", "short", "byte", "double", "float", "decimal"].includes(p.type));
  // drill down: a histogram bucket becomes a filter (only on the starting object type)
  const drill = (h: Histogram) => (k: unknown) => {
    if (spec.search_around?.length) return;
    if (h.kind === "numeric") {
      const [lo, hi] = k as [number, number];
      update({ filters: [...(spec.filters ?? []), { property: h.property, op: "between", value: [lo, hi] }] });
    } else if (h.kind === "values") update({ filters: [...(spec.filters ?? []), k === "—" ? { property: h.property, op: "is_null" } : { property: h.property, op: "eq", value: k }] });
  };
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold">Aggregation</span>
          <select value={agg.metric} onChange={(e) => update({ aggregate: { ...agg, metric: e.target.value as typeof agg.metric } })} className={`${fieldClass} py-1 text-xs`}>
            <option value="count">Count</option>
            <option value="sum">Sum</option>
            <option value="avg">Average</option>
            <option value="min">Min</option>
            <option value="max">Max</option>
          </select>
          {agg.metric !== "count" && (
            <select value={agg.property ?? ""} onChange={(e) => update({ aggregate: { ...agg, property: e.target.value } })} className={`${fieldClass} py-1 text-xs`}>
              <option value="">of…</option>
              {(agg.metric === "min" || agg.metric === "max" ? props : numeric).map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  {p.display_name}
                </option>
              ))}
            </select>
          )}
          <span className="text-muted">grouped by</span>
          <select value={agg.group_by ?? ""} onChange={(e) => update({ aggregate: { ...agg, group_by: e.target.value || null } })} className={`${fieldClass} py-1 text-xs`}>
            <option value="">Nothing</option>
            {props
              .filter((p) => !["vector", "geoshape", "struct", "media", "timeseries"].includes(p.type))
              .map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  {p.display_name}
                </option>
              ))}
          </select>
          {!spec.aggregate && (
            <button type="button" onClick={() => update({ aggregate: agg })} className={buttonClass.secondary}>
              Run
            </button>
          )}
        </div>
        {data.aggregation ? (
          <Bars rows={data.aggregation.groups.map((g) => ({ label: g.group, count: g.count, value: typeof g.value === "number" ? g.value : null }))} />
        ) : (
          <p className="text-xs text-muted">Aggregations are metered as aggregation queries (5 compute-seconds).</p>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {data.histograms.map((h) => (
          <div key={h.property} className="rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 flex items-center text-sm font-medium">
              {h.display_name}
              <span className="ml-auto text-xs text-muted">{h.kind === "numeric" ? `${h.min.toLocaleString()} – ${h.max.toLocaleString()}` : `${h.distinct} values`}</span>
            </div>
            <Bars rows={histRows(h)} onPick={spec.search_around?.length ? undefined : drill(h)} />
          </div>
        ))}
        {data.histograms.length === 0 && <p className="text-sm text-muted">No aggregatable properties: mark string properties Selectable or Low cardinality.</p>}
      </div>
    </div>
  );
}

function Compare({ current, pinned }: { current: SearchSpec; pinned: { spec: SearchSpec; label: string } | null }) {
  const [res, setRes] = useState<{ key: string; a: SearchResult; b: SearchResult } | null>(null);
  const [prop, setProp] = useState("");
  const key = JSON.stringify([current, pinned?.spec]);
  useEffect(() => {
    if (!pinned) return;
    const k = JSON.stringify([current, pinned.spec]);
    Promise.all([om.search({ ...pinned.spec, limit: 1, resource: "object-explorer" }), om.search({ ...current, limit: 1, resource: "object-explorer" })]).then(
      ([a, b]) => setRes({ key: k, a, b }),
      () => setRes(null),
    );
  }, [current, pinned]);
  if (!pinned) return <p className="p-8 text-center text-sm text-muted">Pin a set with “Pin for compare”, change the search, and compare the two sets here.</p>;
  const r = res?.key === key ? res : null;
  if (!r) return <p className="p-8 text-center text-sm text-muted">Comparing…</p>;
  const common = r.a.histograms.filter((h) => r.b.histograms.some((x) => x.property === h.property));
  const pick = prop || common[0]?.property;
  const ha = r.a.histograms.find((h) => h.property === pick);
  const hb = r.b.histograms.find((h) => h.property === pick);
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-4">
        {[
          ["A · pinned", pinned.label, r.a],
          ["B · current", "", r.b],
        ].map(([title, label, d]) => (
          <div key={title as string} className="rounded-xl border border-line bg-panel p-4">
            <div className="text-xs text-muted">{title as string}</div>
            <div className="text-2xl font-semibold tabular-nums">{(d as SearchResult).total.toLocaleString()}</div>
            <div className="text-xs text-muted">
              {(d as SearchResult).result_type.display_name} {label as string}
            </div>
          </div>
        ))}
      </div>
      {common.length > 0 && (
        <div className="rounded-xl border border-line bg-panel p-4">
          <select value={pick} onChange={(e) => setProp(e.target.value)} className={`${fieldClass} mb-3 py-1 text-xs`}>
            {common.map((h) => (
              <option key={h.property} value={h.property}>
                {h.display_name}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-4">
            {ha && <Bars rows={histRows(ha)} />}
            {hb && <Bars rows={histRows(hb)} />}
          </div>
        </div>
      )}
    </div>
  );
}

function BulkDialog({ action, typeId, pks, onClose, onDone }: { action: ActionType; typeId: string; pks: string[]; onClose: () => void; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [t, setT] = useState<ObjectType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ontology.objectType(typeId).then(setT, () => setT(null));
  }, [typeId]);
  const params = action.parameters.filter((p) => p.type !== "object");
  return (
    <Modal title={`${action.display_name} · ${pks.length} objects`} icon={action.kind === "delete" ? "trash" : "edit"} onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          {action.kind === "delete" ? `Deletes the ${pks.length} selected objects.` : `Sets the values you fill in on each of the ${pks.length} selected objects; empty parameters are left as they are.`} Metered as one action:{" "}
          {18 + Math.max(0, pks.length - 1)} compute-seconds.
        </p>
        {action.kind === "modify" &&
          params.map((p) => (
            <Field key={p.id} label={p.display_name} hint={typeLabel(p.type, p.array)}>
              <ParamInput param={p} value={values[p.id]} onChange={(v) => setValues({ ...values, [p.id]: v })} property={t?.properties.find((x) => x.api_name === p.property)} />
            </Field>
          ))}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== null && v !== undefined));
                await om.bulkAction(action.id, pks, filled);
                onDone();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
            className={action.kind === "delete" ? `${buttonClass.primary} bg-bad` : buttonClass.primary}
          >
            {busy ? "Applying…" : `Apply to ${pks.length}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}


/** Search by meaning: KNN over the object type's embedding (or hybrid with keywords); results keep relevance order. */
function SemanticBox({ spec, update }: { spec: SearchSpec; update: (c: Partial<SearchSpec>) => void }) {
  const [text, setText] = useState(spec.semantic?.query ?? "");
  const [mode, setMode] = useState<"semantic" | "keyword" | "hybrid">(spec.semantic?.mode ?? "hybrid");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update({ semantic: text.trim() ? { query: text.trim(), k: spec.semantic?.k ?? 20, mode } : null, sort: null });
      }}
      className="flex items-center gap-1.5 rounded-md border border-ocean/40 bg-ocean/5 px-2"
    >
      <Icon name="sparkle" className="h-3.5 w-3.5 text-ocean" />
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by meaning…" className="w-56 bg-transparent py-1.5 text-sm outline-none" />
      <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="bg-transparent text-xs text-muted outline-none" title="Ranking">
        <option value="hybrid">Hybrid</option>
        <option value="semantic">Embeddings</option>
        <option value="keyword">Keywords</option>
      </select>
      <input
        type="number"
        min={1}
        max={500}
        value={spec.semantic?.k ?? 20}
        onChange={(e) => spec.semantic && update({ semantic: { ...spec.semantic, k: Math.max(1, Math.min(500, Number(e.target.value) || 20)) } })}
        className="w-12 bg-transparent text-xs text-muted outline-none"
        title="K: how many objects"
      />
      {spec.semantic && (
        <button
          type="button"
          onClick={() => {
            setText("");
            update({ semantic: null });
          }}
          className="text-muted hover:text-white"
          aria-label="Clear"
        >
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      )}
    </form>
  );
}

/** A geospatial search region; the filter changes only once the numbers are complete. */
function GeoInput({ value, onChange }: { value: GeoRegion | null; onChange: (v: GeoRegion) => void }) {
  const [kind, setKind] = useState<GeoRegion["kind"]>(value?.kind ?? "distance");
  const [text, setText] = useState(() =>
    !value ? "" : value.kind === "distance" ? `${value.lat}, ${value.lon}, ${value.km}` : value.kind === "bbox" ? `${value.min_lat}, ${value.min_lon}, ${value.max_lat}, ${value.max_lon}` : value.points.map((p) => p.join(" ")).join("; "),
  );
  const apply = (k: GeoRegion["kind"], t: string) => {
    if (k === "polygon") {
      const pts = t.split(";").map((x) => x.trim().split(/[\s,]+/).map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][];
      if (pts.length >= 3) onChange({ kind: "polygon", points: pts });
      return;
    }
    const n = t.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!n.every(Number.isFinite)) return;
    if (k === "distance" && n.length === 3) onChange({ kind: "distance", lat: n[0], lon: n[1], km: n[2] });
    if (k === "bbox" && n.length === 4) onChange({ kind: "bbox", min_lat: n[0], min_lon: n[1], max_lat: n[2], max_lon: n[3] });
  };
  const hint = kind === "distance" ? "lat, lon, km" : kind === "bbox" ? "min lat, min lon, max lat, max lon" : "lat lon; lat lon; lat lon…";
  return (
    <>
      <select value={kind} onChange={(e) => (setKind(e.target.value as GeoRegion["kind"]), apply(e.target.value as GeoRegion["kind"], text))} className="bg-transparent outline-none" aria-label="Area">
        <option value="distance">within km of</option>
        <option value="bbox">box</option>
        <option value="polygon">polygon</option>
      </select>
      <input value={text} onChange={(e) => (setText(e.target.value), apply(kind, e.target.value))} className="w-48 bg-transparent outline-none" placeholder={hint} title={hint} />
    </>
  );
}
