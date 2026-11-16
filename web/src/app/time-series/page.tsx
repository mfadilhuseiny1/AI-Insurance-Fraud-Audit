"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { DemoButton } from "@/components/timeseries/DemoButton";
import { SyncDialog } from "@/components/timeseries/SyncDialog";
import { when } from "@/lib/format";
import { isDemo, monitorHref, timeseries, tsOntology, type CatalogCard, type CatalogHome, type DerivedSeries, type SeriesKind, type SeriesSync, type TsObjectType } from "@/lib/timeseries";

type Tab = "home" | "syncs" | "object-types" | "derived";

export default function TimeSeriesCatalog() {
  // useSearchParams needs a Suspense boundary on a static page
  return (
    <Suspense>
      <Catalog />
    </Suspense>
  );
}

/**
 * Time Series Catalog: the starting point for creating, managing and discovering time series — time series syncs
 * (and geotemporal series syncs), time series object types and derived series — with recently viewed and
 * favourite resources and the most viewed object types.
 */
function Catalog() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get("tab") as Tab) || "home";
  const [newSync, setNewSync] = useState(false);
  const [version, setVersion] = useState(0);
  const go = (t: Tab) => router.replace(t === "home" ? "/time-series" : `/time-series?tab=${t}`);
  const tabs: [Tab, string, IconName][] = [
    ["home", "Home", "home"],
    ["syncs", "Time series syncs", "wave"],
    ["object-types", "Time series object types", "cube"],
    ["derived", "Derived series", "layers"],
  ];
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h1 className="flex flex-1 items-center gap-2 text-xl font-semibold">
            <Icon name="wave" className="h-5 w-5 text-ocean" /> Time Series Catalog
          </h1>
          <DemoButton onChange={() => setVersion((v) => v + 1)} />
          <Link href="/time-series/setup" className={buttonClass.secondary}>
            <Icon name="sparkle" className="h-4 w-4" /> Set up time series
          </Link>
          <Link href="/time-series/derived/new" className={buttonClass.secondary}>
            <Icon name="plus" className="h-4 w-4" /> New derived series
          </Link>
          <button type="button" onClick={() => setNewSync(true)} className={buttonClass.primary}>
            <Icon name="plus" className="h-4 w-4" /> New time series sync
          </button>
        </div>
        <p className="mb-4 text-sm text-muted">
          Time series syncs index timestamp / value points per series into the Time Series DB; time series properties on object types read them; derived series calculate new
          series from them. Open <Link href="/quiver" className="text-ocean hover:underline">Quiver</Link> to analyze them.
        </p>
        <div className="mb-5 flex gap-1 border-b border-line">
          {tabs.map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => go(id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}
            >
              <Icon name={icon} className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        {tab === "home" && <Home key={version} />}
        {tab === "syncs" && <Syncs key={version} onNew={() => setNewSync(true)} />}
        {tab === "object-types" && <ObjectTypes />}
        {tab === "derived" && <Derived />}
      </div>
      {newSync && (
        <SyncDialog
          onClose={() => setNewSync(false)}
          onSaved={(s) => {
            setNewSync(false);
            router.push(`/time-series/${s.id}`);
          }}
        />
      )}
    </div>
  );
}

const CARD_HREF = (c: CatalogCard) => (c.kind === "sync" ? `/time-series/${c.id}` : c.kind === "derived" ? `/time-series/derived/${c.id}` : `/time-series/object-types/${c.id}`);
const CARD_ICON: Record<CatalogCard["kind"], IconName> = { sync: "wave", derived: "layers", object_type: "cube" };

function Home() {
  const [home, setHome] = useState<CatalogHome | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tsOntology.home().then(setHome, (e: Error) => setError(e.message));
  }, []);
  if (error) return <ApiError message={error} />;
  if (!home) return <Loading />;
  const section = (title: string, cards: CatalogCard[], empty: string) => (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-soft">{title}</h2>
      {cards.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-2 p-4 text-center text-xs text-muted">{empty}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((c) => (
            <Link key={`${c.kind}:${c.id}`} href={CARD_HREF(c)} className="rounded-xl border border-line bg-panel p-3 hover:border-ocean/50">
              <div className="flex items-center gap-2">
                <Icon name={CARD_ICON[c.kind]} className="h-4 w-4 shrink-0 text-ocean" />
                <span className="truncate text-sm font-medium">{c.name}</span>
                {c.favorite && <Icon name="star" className="ml-auto h-3.5 w-3.5 text-sand" />}
              </div>
              <div className="mt-1 text-xs text-muted">
                {c.subtitle}
                {c.last_viewed ? ` · ${when(c.last_viewed)}` : c.views ? ` · ${c.views} views` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
  return (
    <div>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {(
          [
            ["Time series syncs", home.counts.syncs, "/time-series?tab=syncs"],
            ["Geotemporal series syncs", home.counts.geotemporal, "/time-series?tab=syncs"],
            ["Time series object types", home.counts.object_types, "/time-series?tab=object-types"],
            ["Derived series", home.counts.derived, "/time-series?tab=derived"],
          ] as const
        ).map(([label, n, href]) => (
          <Link key={label} href={href} className="rounded-xl border border-line bg-panel p-3 hover:border-ocean/50">
            <div className="text-2xl font-semibold tabular-nums">{n}</div>
            <div className="text-xs text-muted">{label}</div>
          </Link>
        ))}
      </div>
      {section("Recently viewed", home.recent, "Syncs and derived series you open show up here.")}
      {section("Favorites", home.favorites, "Star a sync or a derived series to keep it here.")}
      {section("Most viewed time series object types", home.most_viewed_object_types, "No time series object types yet: use Set up time series.")}
    </div>
  );
}

function Syncs({ onNew }: { onNew: () => void }) {
  const [syncs, setSyncs] = useState<SeriesSync[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<SeriesKind | "all">("all");
  const [search, setSearch] = useState("");
  useEffect(() => {
    timeseries.syncs().then(setSyncs, (e: Error) => setError(e.message));
    const t = setInterval(() => timeseries.syncs().then(setSyncs, () => {}), 15_000);
    return () => clearInterval(t);
  }, []);
  if (error && !syncs) return <ApiError message={error} />;
  if (!syncs) return <Loading />;
  const shown = syncs.filter((s) => (kind === "all" || s.kind === kind) && `${s.name} ${s.pipeline_name}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "All"],
            ["timeseries", "Time series syncs"],
            ["geotemporal", "Geotemporal series syncs"],
          ] as [SeriesKind | "all", string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setKind(id)}
            className={`rounded-md px-2.5 py-1 text-sm ${kind === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
          >
            {label} <span className="text-xs text-muted">{id === "all" ? syncs.length : syncs.filter((s) => s.kind === id).length}</span>
          </button>
        ))}
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search syncs…" className={`${inputClass} ml-auto w-64`} />
      </div>
      {shown.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-line-2 py-12 text-center text-sm text-muted">
          {syncs.length ? "No syncs match." : "No syncs yet. Create one from a dataset, add a time series sync output in Pipeline Builder, or load the demo data."}
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" onClick={onNew} className={`${buttonClass.primary} py-1 text-xs`}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New time series sync
            </button>
            <Link href="/pipeline" className={`${buttonClass.secondary} py-1 text-xs`}>
              <Icon name="pipeline" className="h-3.5 w-3.5" /> Open Pipeline Builder
            </Link>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Sync</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2 text-right">Series</th>
                <th className="px-3 py-2 text-right">Stored</th>
                <th className="px-3 py-2 text-right">Last 5 min</th>
                <th className="px-3 py-2">Last write</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Link href={s.kind === "geotemporal" ? `/map?sync=${s.id}` : `/time-series/${s.id}`} className="flex items-center gap-1.5 font-medium hover:text-ocean">
                      <Icon name={s.kind === "geotemporal" ? "globe" : "wave"} className="h-3.5 w-3.5 text-ocean" />
                      {s.name}
                    </Link>
                    <div className="text-xs text-muted">
                      {s.kind_label} · {s.mode}
                      {s.status === "failed" ? <span className="text-bad"> · failed</span> : null}
                      {s.errors ? <span className="text-warn"> · {s.errors.toLocaleString()} rejected</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {isDemo(s) ? (
                      <span className="rounded bg-sand/15 px-1.5 py-0.5 text-sand">Demo project</span>
                    ) : s.source === "catalog" ? (
                      <span className="text-soft">Dataset (catalog)</span>
                    ) : s.pipeline_id ? (
                      <Link href={`/pipeline/${s.pipeline_id}`} className="hover:text-ocean">
                        {s.pipeline_name || s.pipeline_id}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.series.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.stored.toLocaleString()} <span className="text-xs text-muted">{s.kind === "geotemporal" ? "obs." : "points"}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.written_5m.toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs text-muted">{s.last_write_at ? when(s.last_write_at) : "never"}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Link href={`/time-series/${s.id}`} className={`${buttonClass.secondary} py-1 text-xs`}>
                        <Icon name="eye" className="h-3.5 w-3.5" /> Open
                      </Link>
                      {s.kind === "geotemporal" && (
                        <Link href={`/map?sync=${s.id}`} className={`${buttonClass.secondary} py-1 text-xs`}>
                          <Icon name="globe" className="h-3.5 w-3.5" /> Map
                        </Link>
                      )}
                      <Link href={monitorHref(s)} className={`${buttonClass.secondary} py-1 text-xs`} title="Add an output monitor in Data Health">
                        <Icon name="bell" className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ObjectTypes() {
  const [types, setTypes] = useState<TsObjectType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tsOntology.objectTypes().then(setTypes, (e: Error) => setError(e.message));
  }, []);
  if (error) return <ApiError message={error} />;
  if (!types) return <Loading />;
  if (!types.length)
    return (
      <div className="rounded-xl border-2 border-dashed border-line-2 py-12 text-center text-sm text-muted">
        No time series object types yet.
        <div className="mt-3">
          <Link href="/time-series/setup" className={`${buttonClass.primary} py-1 text-xs`}>
            <Icon name="sparkle" className="h-3.5 w-3.5" /> Set up time series
          </Link>
        </div>
      </div>
    );
  const name = (id: string) => types.find((t) => t.id === id)?.display_name ?? id;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {types.map((t) => (
        <Link key={t.id} href={`/time-series/object-types/${t.id}`} className="rounded-xl border border-line bg-panel p-4 hover:border-ocean/50">
          <div className="flex items-center gap-2">
            <Icon name="cube" className="h-4 w-4 text-ocean" />
            <span className="font-medium">{t.display_name}</span>
            <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted">{t.is_sensor ? "Sensor object type" : "Time series object type"}</span>
            <span className="ml-auto text-xs text-muted">{t.object_count.toLocaleString()} objects</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1 text-xs">
            {t.properties.map((p) => (
              <span key={p.api_name} className={`rounded px-1.5 py-0.5 ${p.configured ? "bg-ocean/10 text-soft" : "bg-warn/10 text-warn"}`}>
                {p.display_name}
                {t.default_property === p.api_name ? " · default" : ""}
                {!p.configured ? " · not configured" : ""}
              </span>
            ))}
          </div>
          {(t.root_object_types.length > 0 || t.sensor_types.length > 0) && (
            <div className="mt-2 text-xs text-muted">
              {t.root_object_types.length > 0 && <>Sensors of {t.root_object_types.map(name).join(", ")}</>}
              {t.sensor_types.length > 0 && <>Linked sensors: {t.sensor_types.map(name).join(", ")}</>}
            </div>
          )}
        </Link>
      ))}
    </div>
  );
}

function Derived() {
  const [list, setList] = useState<DerivedSeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "templated" | "single">("all");
  useEffect(() => {
    tsOntology.derivedList().then(setList, (e: Error) => setError(e.message));
  }, []);
  if (error) return <ApiError message={error} />;
  if (!list) return <Loading />;
  const shown = list.filter((d) => filter === "all" || d.type === filter);
  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        {(["all", "templated", "single"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded-md px-2.5 py-1 text-sm capitalize ${filter === f ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2"}`}>
            {f}
          </button>
        ))}
        <Link href="/time-series/derived/new" className={`${buttonClass.primary} ml-auto`}>
          <Icon name="plus" className="h-4 w-4" /> New derived series
        </Link>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border-2 border-dashed border-line-2 py-12 text-center text-sm text-muted">No derived series yet. A derived series saves a calculation over time series and shows it as a time series property.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-panel-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Derived series</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Bound object type</th>
                <th className="px-3 py-2">Nexus saving</th>
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Link href={`/time-series/derived/${d.id}`} className="flex items-center gap-1.5 font-medium hover:text-ocean">
                      <Icon name="layers" className="h-3.5 w-3.5 text-ocean" /> {d.name}
                    </Link>
                    {d.description && <div className="text-xs text-muted">{d.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs capitalize">
                    {d.type}
                    {d.root_object_type ? ` · ${d.root_object_type}` : ""}
                  </td>
                  <td className="px-3 py-2 text-xs">{d.bound_object_type}</td>
                  <td className="px-3 py-2 text-xs capitalize">{d.saving.mode}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.version}</td>
                  <td className="px-3 py-2 text-xs text-muted">{when(d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
