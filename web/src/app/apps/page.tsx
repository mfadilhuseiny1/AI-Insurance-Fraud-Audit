"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, iconPath, type IconName } from "@/components/Icon";
import { APP_CATEGORIES, PROMOTED_APPS, PROMOTED_APPS_EVENT, readPromotedWorkshopApps, SOLUTIONS, type AppCategory, type PlatformApp, type Solution } from "@/lib/platformApps";
import { PINNED_APPS_EVENT, readPinnedApps, togglePinnedApp } from "@/lib/appPreferences";
import { API_URL } from "@/lib/api";
import { NewAppDialog, type AgenticApp } from "@/components/apps/NewAppDialog";

const ALL = "All apps";
const AGENTIC = "Agentic Apps";
const PINNED = "Pinned apps";
const TOTAL = APP_CATEGORIES.reduce((n, c) => n + c.apps.length, 0);

function appId(app: PlatformApp) {
  return app.id ?? app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function dedupe(apps: PlatformApp[]) {
  const seen = new Set<string>();
  return apps.filter((app) => {
    const keys = [appId(app), app.href ?? ""].filter(Boolean);
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}

/** Agentic Apps: the organisation's registry (/api/agentic-apps), the curated apps and Workshop apps promoted here —
    without the listings a solution owns (they show under that solution). */
// AI JKN Audit lists AIP JKN only: no registry listings or promoted Workshop apps
function mergeAgentic(_registry: PlatformApp[], _promoted: PlatformApp[]) {
  return dedupe([...PROMOTED_APPS]);
}

/** each solution: its curated pages (AI JKN Audit: without the Portal listings its builds registered) */
function solutionGroups(_registry: PlatformApp[]): (AppCategory & { solution: Solution })[] {
  return SOLUTIONS.map((s) => ({ name: s.name, solution: s, apps: dedupe([...s.apps]) }));
}

function fromRegistry(a: AgenticApp): PlatformApp {
  // a listing's icon may be one this app has no drawing for (e.g. "map"): show the generic app icon then
  return { id: a.id, name: a.name, description: a.description, icon: iconPath(a.icon as IconName) ? a.icon : "grid", href: a.href ?? undefined, owner: a.owner, collection: a.collection, tags: a.tags };
}

export default function PlatformAppsPage() {
  const [category, setCategory] = useState(ALL);
  const [tag, setTag] = useState("All tags");
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<PlatformApp | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [promoted, setPromoted] = useState<PlatformApp[]>([]);
  const [registry, setRegistry] = useState<PlatformApp[]>([]);
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const loadRegistry = useCallback(() => {
    fetch(`${API_URL}/api/agentic-apps`, { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((x: AgenticApp[]) => setRegistry(Array.isArray(x) ? x.map(fromRegistry) : []), () => setRegistry([]));
  }, []);
  useEffect(loadRegistry, [loadRegistry]);
  const agentic = useMemo(() => mergeAgentic(registry, promoted), [registry, promoted]);
  const solutions = useMemo(() => solutionGroups(registry), [registry]);
  const allApps = useCallback(() => [...APP_CATEGORIES.flatMap((c) => c.apps), ...solutions.flatMap((s) => s.apps), ...agentic], [solutions, agentic]);
  const registryIds = useMemo(() => new Set(registry.map((a) => a.id)), [registry]);
  const remove = async (app: PlatformApp) => {
    const r = await fetch(`${API_URL}/api/agentic-apps/${app.id}`, { method: "DELETE", credentials: "include" });
    if (r.ok) {
      setHovered(null);
      loadRegistry();
    }
  };

  useEffect(() => {
    const refresh = () => setPinned(readPinnedApps());
    const refreshPromoted = () => setPromoted(readPromotedWorkshopApps());
    refresh();
    refreshPromoted();
    window.addEventListener(PINNED_APPS_EVENT, refresh);
    window.addEventListener(PROMOTED_APPS_EVENT, refreshPromoted);
    return () => {
      window.removeEventListener(PINNED_APPS_EVENT, refresh);
      window.removeEventListener(PROMOTED_APPS_EVENT, refreshPromoted);
    };
  }, []);

  const tags = useMemo(() => {
    const values = new Set(allApps().flatMap((app) => app.tags ?? []));
    return ["All tags", ...Array.from(values).sort()];
  }, [allApps]);

  const groups: (AppCategory & { solution?: Solution })[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base: (AppCategory & { solution?: Solution })[] =
      category === AGENTIC
        ? [{ name: AGENTIC, apps: agentic }]
        : category === PINNED
          ? [{ name: PINNED, apps: dedupe(allApps().filter((app) => pinned.includes(appId(app)))) }]
          : category === ALL
            ? [{ name: AGENTIC, apps: agentic }, ...APP_CATEGORIES, ...solutions]
            : [...APP_CATEGORIES, ...solutions].filter((c) => c.name === category);
    return base
      .map((c) => ({
        ...c,
        apps: c.apps.filter((app) => {
          const matchesQuery = !q || [app.name, app.description, app.owner, ...(app.tags ?? [])].join(" ").toLowerCase().includes(q);
          const matchesTag = tag === "All tags" || app.tags?.includes(tag);
          return matchesQuery && matchesTag;
        }),
      }))
      .filter((c) => c.apps.length > 0);
  }, [agentic, allApps, category, pinned, query, solutions, tag]);
  const firstSolution = groups.findIndex((g) => g.solution);

  const pin = (app: PlatformApp) => setPinned(togglePinnedApp(appId(app)));

  return (
    <div className="foundry-light flex flex-1 flex-col overflow-hidden">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
        <Icon name="grid" className="h-4 w-4 text-ocean" />
        <span className="font-medium">Applications Portal</span>
        <span className="text-xs text-muted">Discover, curate, and launch apps</span>
        <button type="button" onClick={() => setCreating(true)} className="ml-auto flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white hover:bg-ocean-deep">
          <Icon name="plus" className="h-4 w-4" /> New app
        </button>
      </header>
      {creating && <NewAppDialog onClose={() => setCreating(false)} onMade={(app) => { setCreating(false); loadRegistry(); if (app.href) router.push(app.href); }} />}

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-5 py-3">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-line-2 bg-ink px-2.5 py-1.5">
          <Icon name="search" className="h-4 w-4 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search applications, owners, or tags..." className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
          {query && <button onClick={() => setQuery("")} className="text-muted hover:text-white" aria-label="Clear search"><Icon name="x" className="h-4 w-4" /></button>}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          Tag
          <select value={tag} onChange={(e) => setTag(e.target.value)} className="rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs text-soft">
            {tags.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          <CategoryButton label={ALL} count={TOTAL + agentic.length + solutions.reduce((n, s) => n + s.apps.length, 0)} active={category === ALL} onClick={() => setCategory(ALL)} />
          <CategoryButton label={PINNED} count={pinned.length} active={category === PINNED} onClick={() => setCategory(PINNED)} />
          <CategoryButton label={AGENTIC} count={agentic.length} active={category === AGENTIC} onClick={() => setCategory(AGENTIC)} />
          <div className="mb-1 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted">BluesandAI platform</div>
          {APP_CATEGORIES.map((c) => <CategoryButton key={c.name} label={c.name} count={c.apps.length} active={category === c.name} onClick={() => setCategory(c.name)} />)}
          <div className="mb-1 mt-3 flex items-center gap-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-violet-300"><Icon name="cube" className="h-3 w-3" /> Solution apps</div>
          {solutions.map((s) => <CategoryButton key={s.name} label={s.name} icon={s.solution.icon} count={s.apps.length} active={category === s.name} onClick={() => setCategory(s.name)} />)}
        </nav>

        <section className="min-w-0 flex-1 overflow-y-auto p-5">
          {groups.length === 0 && <p className="text-sm text-muted">No applications match your filters.</p>}
          {groups.map((g, i) => (
            <div key={g.name} className={i > 0 ? "mt-6" : ""}>
              {i === firstSolution && i > 0 && (
                <div className="mb-4 mt-10 border-t border-line pt-5">
                  <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-violet-300"><Icon name="cube" className="h-4 w-4" /> Solution apps</div>
                  <p className="text-xs text-muted">Aplikasi yang dibangun di atas BluesandAI untuk klien atau domain tertentu — terpisah dari aplikasi inti platform.</p>
                </div>
              )}
              {g.solution ? (
                <div className="mb-2 flex items-start gap-3 rounded-lg border border-violet-400/30 bg-violet-500/5 px-3 py-2.5">
                  <span className="rounded-md bg-violet-500/15 p-1.5 text-violet-200"><Icon name={g.solution.icon} className="h-4 w-4" /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{g.name} <span className="ml-1 text-xs font-normal text-muted">{g.solution.client}</span></span>
                    <span className="block text-xs text-muted">{g.solution.description}</span>
                  </span>
                </div>
              ) : (
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-soft">
                  {g.name}
                  {g.name === AGENTIC && <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal text-ocean hover:bg-ocean/10"><Icon name="plus" className="h-3.5 w-3.5" /> New</button>}
                </h2>
              )}
              <div className="grid gap-x-8 gap-y-1 md:grid-cols-2">{g.apps.map((app) => <AppRow key={appId(app)} app={app} pinned={pinned.includes(appId(app))} onPin={() => pin(app)} onHover={setHovered} />)}</div>
            </div>
          ))}
        </section>

        <aside className="hidden w-80 shrink-0 border-l border-line bg-panel p-5 lg:block">{hovered ? <AppDetails app={hovered} pinned={pinned.includes(appId(hovered))} onPin={() => pin(hovered)} onRemove={hovered.id && registryIds.has(hovered.id) ? () => remove(hovered) : undefined} /> : <EmptyDetails />}</aside>
      </div>
    </div>
  );
}

function CategoryButton({ label, count, active, onClick, icon }: { label: string; count: number; active: boolean; onClick: () => void; icon?: IconName }) {
  return <button onClick={onClick} className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${active ? "bg-ocean/15 font-medium text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2 hover:text-white"}`}><span className="flex min-w-0 items-center gap-1.5">{icon && <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-violet-300" />}<span className="truncate">{label}</span></span><span className="text-xs tabular-nums text-muted">{count}</span></button>;
}

function AppRow({ app, pinned, onPin, onHover }: { app: PlatformApp; pinned: boolean; onPin: () => void; onHover: (a: PlatformApp) => void }) {
  const body = <><span className={`rounded-md p-1.5 ${app.href ? "bg-ocean/15 text-ocean" : "bg-panel-2 text-muted"}`}><Icon name={app.icon} className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-medium">{app.name}{app.trusted && <Icon name="check" className="h-3.5 w-3.5 text-purple-300" />} {!app.href && <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] font-normal text-muted ring-1 ring-line-2">Coming soon</span>}</span><span className="block text-xs text-muted">{app.description}</span>{app.tags?.length ? <span className="mt-1 flex gap-1">{app.tags.map((item) => <span key={item} className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-soft">{item}</span>)}</span> : null}</span></>;
  const cls = "flex items-start gap-3 rounded-lg px-3 py-2 transition-colors";
  return <div onMouseEnter={() => onHover(app)} className={`${cls} ${app.href ? "hover:bg-panel-2" : "cursor-default opacity-70 hover:bg-panel-2/60"}`}><button type="button" onClick={onPin} className="order-last mt-1 shrink-0 text-muted hover:text-sand" aria-label={pinned ? `Unpin ${app.name}` : `Pin ${app.name}`}><Icon name="star" className={`h-4 w-4 ${pinned ? "fill-sand text-sand" : ""}`} /></button>{app.href ? <Link href={app.href} className="flex min-w-0 flex-1 items-start gap-3">{body}</Link> : <div className="flex min-w-0 flex-1 items-start gap-3">{body}</div>}</div>;
}

function AppDetails({ app, pinned, onPin, onRemove }: { app: PlatformApp; pinned: boolean; onPin: () => void; onRemove?: () => void }) {
  return <div><div className="flex items-start justify-between"><span className={`rounded-lg p-2.5 ${app.href ? "bg-ocean/15 text-ocean" : "bg-panel-2 text-muted"}`}><Icon name={app.icon} className="h-6 w-6" /></span><button onClick={onPin} className="flex items-center gap-1 text-xs text-muted hover:text-sand"><Icon name="star" className={`h-4 w-4 ${pinned ? "fill-sand text-sand" : ""}`} /> {pinned ? "Pinned" : "Pin app"}</button></div><h3 className="mt-3 flex items-center gap-2 font-semibold">{app.name}{app.trusted && <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] text-purple-300"><Icon name="check" className="h-3 w-3" /> Trusted</span>}</h3><p className="mt-1 text-sm text-soft">{app.description}</p>{app.owner && <p className="mt-4 text-xs text-muted">Owner <span className="text-soft">{app.owner}</span></p>}{app.collection && <p className="mt-1 text-xs text-muted">Collection <span className="text-soft">{app.collection}</span></p>}{app.tags?.length ? <div className="mt-3 flex flex-wrap gap-1">{app.tags.map((item) => <span key={item} className="rounded bg-panel-2 px-2 py-1 text-[10px] text-soft">{item}</span>)}</div> : null}{app.href ? <Link href={app.href} className="mt-5 block rounded-md bg-ocean px-3 py-2 text-center text-sm font-medium text-white hover:bg-ocean-deep">Open {app.name}</Link> : <p className="mt-5 rounded-md border border-line bg-panel-2 px-3 py-2 text-center text-sm text-muted">Not available in BluesandAI yet</p>}{onRemove && <button type="button" onClick={onRemove} className="mt-2 w-full rounded-md px-3 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-bad">Remove from portal</button>}</div>;
}

function EmptyDetails() { return <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted"><Icon name="info" className="mb-2 h-6 w-6" />Hover on an application to see details</div>; }
