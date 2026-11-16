"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";

/** One resource an app lists on its home page (an analysis, a report, a spreadsheet, a dataset …). */
export type AppHomeItem = {
  id: string;
  href: string;
  title: string;
  /** where it lives: Project / folder / … */
  path?: string[];
  updated_at?: string | null;
  icon?: IconName;
  /** small labels after the title (kind, status …) */
  badges?: { label: string; tone?: "ocean" | "ok" | "warn" | "bad" | "sand" | "muted" }[];
  /** a short fact on the right of a list row / the bottom of a card (size, item count …) */
  meta?: string;
  /** one more line under the title on cards (a description) */
  detail?: string;
  /** per-item controls (a "…" menu, small links) shown at the top right of a card / the end of a row, outside its link */
  actions?: ReactNode;
  /** links along the bottom of a card, outside its link (Edit, View …); list rows reach them through `actions` */
  footer?: ReactNode;
};

export type AppHomeProps = {
  /** the app's name, icon and accent colour (a hex colour; the hero, icons and hovers take it) */
  app: string;
  icon: IconName;
  accent?: string;
  href: string;
  /** one line under the name */
  tagline: string;
  /** the longer explanation, folded under "About" */
  description?: ReactNode;
  /** the hero's create controls (inputs and buttons) */
  create?: ReactNode;
  /** header buttons on the right */
  headerActions?: ReactNode;
  items: AppHomeItem[] | null;
  error?: string | null;
  /** what one item is called: "analysis" / "analyses" */
  noun: [string, string];
  /** server-side search (e.g. datasets): the query is handed over instead of filtering the list here */
  onSearch?: (q: string) => void;
  empty?: { title: string; hint: string; steps?: string[] };
  /** extra content under the list */
  children?: ReactNode;
  /** content right under the hero, before the list (a guide, a workflow) */
  lead?: ReactNode;
  /** the hero's figures in place of Total / This week / Projects */
  stats?: { label: string; value: string }[];
  /** extra controls in the toolbar, after the count (status filters …) */
  toolbar?: ReactNode;
  /** an extra filter the page applies (from its toolbar controls); undefined: none */
  filter?: (i: AppHomeItem) => boolean;
};

const TONE: Record<NonNullable<NonNullable<AppHomeItem["badges"]>[number]["tone"]>, string> = {
  ocean: "bg-ocean/12 text-ocean",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn",
  bad: "bg-bad/12 text-bad",
  sand: "bg-sand/15 text-sand",
  muted: "bg-panel-2 text-muted",
};

const DAY = 86_400_000;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function ago(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function section(iso?: string | null): string {
  if (!iso) return "Earlier";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t = Date.parse(iso);
  if (t >= start.getTime()) return "Today";
  if (t >= start.getTime() - DAY) return "Yesterday";
  if (t >= start.getTime() - 6 * DAY) return "This week";
  if (t >= start.getTime() - 29 * DAY) return "This month";
  return "Earlier";
}
const SECTIONS = ["Today", "Yesterday", "This week", "This month", "Earlier"];

/** a remembered per-viewer choice (view mode); storage may be unavailable */
function useStored<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const s = window.localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the view remembered in this browser
      if (s) setV(s as T);
    } catch {
      // private mode: the default stays
    }
  }, [key]);
  return [
    v,
    (x: T) => {
      setV(x);
      try {
        window.localStorage.setItem(key, x);
      } catch {
        // not remembered
      }
    },
  ];
}

/**
 * The home page of a resource app (Contour, Reports, Fusion …): a hero with the app's identity, live counts and its
 * create controls; the most recent items to jump back into; search, a Project filter, sort and a grid / list of
 * everything, grouped by when it last changed.
 */
export function AppHome({ app, icon, accent = "#3d8bfd", href, tagline, description, create, headerActions, items, error, noun, onSearch, empty, children, stats, toolbar, filter, lead }: AppHomeProps) {
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [view, setView] = useStored<"grid" | "list">(`app-home-view:${app}`, "grid");
  const [about, setAbout] = useState(false);
  // "now" for the counts, taken once when the page opens
  const [now] = useState(() => Date.now());
  const style = { "--app-accent": accent } as CSSProperties;

  useEffect(() => {
    if (!onSearch) return;
    const t = setTimeout(() => onSearch(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q, onSearch]);

  const projects = useMemo(() => {
    const n = new Map<string, number>();
    for (const i of items ?? []) if (i.path?.[0]) n.set(i.path[0], (n.get(i.path[0]) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (items ?? []).filter(
      (i) =>
        (!project || i.path?.[0] === project) &&
        (!filter || filter(i)) &&
        (onSearch || !needle || i.title.toLowerCase().includes(needle) || (i.path ?? []).join(" ").toLowerCase().includes(needle) || (i.detail ?? "").toLowerCase().includes(needle) || (i.badges ?? []).some((x) => x.label.toLowerCase().includes(needle))),
    );
    return sort === "name" ? [...list].sort((a, b) => a.title.localeCompare(b.title)) : [...list].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  }, [items, q, project, sort, onSearch, filter]);
  const week = useMemo(() => (items ?? []).filter((i) => i.updated_at && now - Date.parse(i.updated_at) < 7 * DAY).length, [items, now]);
  const recent = useMemo(() => [...(items ?? [])].filter((i) => i.updated_at).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).slice(0, 4), [items]);
  const filtering = !!(q.trim() || project || filter);
  const grouped = useMemo(() => {
    if (sort !== "recent") return [["", shown] as const];
    const by = new Map<string, AppHomeItem[]>();
    for (const i of shown) by.set(section(i.updated_at), [...(by.get(section(i.updated_at)) ?? []), i]);
    return SECTIONS.filter((s) => by.has(s)).map((s) => [s, by.get(s)!] as const);
  }, [shown, sort]);
  const count = (n: number) => `${n.toLocaleString()} ${n === 1 ? noun[0] : noun[1]}`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" style={style} data-app-home={app}>
      <AppHeader app={app} icon={icon} href={href}>
        {headerActions}
      </AppHeader>
      <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
        {/* hero */}
        <section
          className="relative overflow-hidden rounded-2xl border border-line bg-panel p-6"
          style={{ backgroundImage: "radial-gradient(120% 140% at 100% 0%, color-mix(in srgb, var(--app-accent) 16%, transparent) 0%, transparent 55%)" }}
        >
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            <div className="flex min-w-0 flex-1 gap-4">
              <span
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-lg"
                style={{ background: "linear-gradient(135deg, var(--app-accent), color-mix(in srgb, var(--app-accent) 55%, #000))", boxShadow: "0 10px 30px -12px var(--app-accent)" }}
              >
                <Icon name={icon} className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight text-strong">{app}</h1>
                <p className="mt-1 max-w-2xl text-sm text-soft">{tagline}</p>
                {description && (
                  <button type="button" onClick={() => setAbout(!about)} className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-soft" aria-expanded={about}>
                    <Icon name="info" className="h-3.5 w-3.5" /> About {app}
                    <Icon name={about ? "down" : "right"} className="h-3 w-3" />
                  </button>
                )}
                {about && <div className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">{description}</div>}
              </div>
            </div>
            <dl className={`grid shrink-0 gap-2 text-center ${stats && stats.length !== 3 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
              {(stats
                ? stats.map((x) => [items ? x.value : "–", x.label])
                : [
                    [items ? items.length.toLocaleString() : "–", "Total"],
                    [items ? week.toLocaleString() : "–", "This week"],
                    [items ? projects.length.toLocaleString() : "–", "Projects"],
                  ]
              ).map(([v, l]) => (
                <div key={l} className="min-w-20 rounded-xl border border-line bg-ink/40 px-3 py-2">
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{l}</dt>
                  <dd className="text-lg font-semibold text-strong">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          {create && <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-5">{create}</div>}
        </section>

        <ErrorBox message={error ?? null} />

        {lead}

        {/* jump back in */}
        {!filtering && recent.length > 1 && (items?.length ?? 0) > 4 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Jump back in</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {recent.map((i) => (
                <Link
                  key={i.id}
                  href={i.href}
                  className="group relative overflow-hidden rounded-xl border border-line bg-panel p-4 transition hover:-translate-y-0.5 hover:border-[color:var(--app-accent)]"
                  data-app-home-recent={i.id}
                >
                  <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: "var(--app-accent)" }} />
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <Icon name="clock" className="h-3 w-3" /> {ago(i.updated_at)}
                  </div>
                  <div className="mt-2 line-clamp-2 text-sm font-medium text-strong">{i.title}</div>
                  <div className="mt-1 truncate text-xs text-muted">{(i.path ?? []).slice(-2).join(" / ")}</div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* toolbar */}
        {(items === null || items.length > 0 || onSearch) && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1 sm:max-w-sm">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={`Search ${noun[1]}…`}
                  className="w-full rounded-lg border border-line-2 bg-panel py-2 pl-9 pr-3 text-sm outline-none focus:border-[color:var(--app-accent)]"
                  data-app-home-search
                />
              </div>
              <span className="text-xs text-muted">{items ? count(shown.length) : "Loading…"}</span>
              {toolbar}
              <div className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5 text-xs">
                {(["recent", "name"] as const).map((s) => (
                  <button key={s} type="button" onClick={() => setSort(s)} className={`rounded-md px-2.5 py-1 ${sort === s ? "bg-panel-2 text-strong" : "text-muted hover:text-soft"}`}>
                    {s === "recent" ? "Recent" : "A–Z"}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5">
                {(["grid", "list"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setView(v)} title={v === "grid" ? "Cards" : "List"} aria-pressed={view === v} className={`rounded-md p-1.5 ${view === v ? "bg-panel-2 text-strong" : "text-muted hover:text-soft"}`}>
                    <Icon name={v} className="h-4 w-4" />
                  </button>
                ))}
              </div>
            </div>
            {projects.length > 1 && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {[["", items?.length ?? 0] as const, ...projects.slice(0, 8)].map(([p, n]) => (
                  <button
                    key={p || "all"}
                    type="button"
                    onClick={() => setProject(p)}
                    className={`rounded-full border px-3 py-1 ${project === p ? "border-[color:var(--app-accent)] text-strong" : "border-line text-muted hover:text-soft"}`}
                    style={project === p ? { background: "color-mix(in srgb, var(--app-accent) 14%, transparent)" } : undefined}
                  >
                    {p || "All"} <span className="text-muted">{n}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* everything */}
        {items === null && !error && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((k) => (
              <div key={k} className="h-28 animate-pulse rounded-xl border border-line bg-panel" />
            ))}
          </div>
        )}
        {items && items.length === 0 && !q && empty && (
          <section className="rounded-2xl border border-dashed border-line-2 bg-panel/60 p-10 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "color-mix(in srgb, var(--app-accent) 15%, transparent)", color: "var(--app-accent)" }}>
              <Icon name={icon} className="h-7 w-7" />
            </span>
            <h2 className="mt-4 text-lg font-semibold text-strong">{empty.title}</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">{empty.hint}</p>
            {empty.steps && (
              <ol className="mx-auto mt-5 grid max-w-2xl gap-2 text-left text-sm sm:grid-cols-3">
                {empty.steps.map((s, i) => (
                  <li key={i} className="rounded-xl border border-line bg-panel p-3">
                    <span className="mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: "var(--app-accent)" }}>
                      {i + 1}
                    </span>
                    <span className="text-soft">{s}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
        {items && shown.length === 0 && (items.length > 0 || q) && <p className="py-10 text-center text-sm text-muted">No {noun[1]} match.</p>}
        {grouped.map(([label, list]) => (
          <section key={label || "all"}>
            {label && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{label}</h2>}
            {view === "grid" ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((i) => (
                  <Card key={i.id} i={i} icon={icon} />
                ))}
              </div>
            ) : (
              // per-item menus open below their row, so the list does not clip them
              <div className={`rounded-xl border border-line bg-panel ${list.some((i) => i.actions) ? "" : "overflow-hidden"}`}>
                {list.map((i) => (
                  <Row key={i.id} i={i} icon={icon} />
                ))}
              </div>
            )}
          </section>
        ))}
        {children}
      </div>
    </div>
  );
}

function Badges({ i }: { i: AppHomeItem }) {
  return (
    <>
      {(i.badges ?? []).map((b, k) => (
        <span key={`${k}-${b.label}`} className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${TONE[b.tone ?? "muted"]}`}>
          {b.label}
        </span>
      ))}
    </>
  );
}

/** an item's own controls sit beside its link (a link may not hold buttons) */
function Card({ i, icon }: { i: AppHomeItem; icon: IconName }) {
  if (!i.actions && !i.footer) return <CardLink i={i} icon={icon} />;
  return (
    <div className="group/card relative">
      <CardLink i={i} icon={icon} />
      {i.actions && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 transition group-hover/card:-translate-y-0.5" data-app-home-actions={i.id}>
          {i.actions}
        </div>
      )}
      {i.footer && (
        <div className="absolute inset-x-4 bottom-3 z-10 flex flex-wrap items-center gap-3 border-t border-line pt-2 text-xs transition group-hover/card:-translate-y-0.5" data-app-home-footer={i.id}>
          {i.footer}
        </div>
      )}
    </div>
  );
}

function CardLink({ i, icon }: { i: AppHomeItem; icon: IconName }) {
  return (
    <Link href={i.href} className={`group flex h-full flex-col rounded-xl border border-line bg-panel p-4 ${i.footer ? "pb-12" : ""} transition hover:-translate-y-0.5 hover:border-[color:var(--app-accent)] hover:shadow-lg`} data-app-home-item={i.id}>
      <div className={`flex items-start gap-3 ${i.actions ? "pr-8" : ""}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: "color-mix(in srgb, var(--app-accent) 14%, transparent)", color: "var(--app-accent)" }}>
          <Icon name={i.icon ?? icon} className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-medium text-strong">{i.title}</div>
          {i.path?.length ? (
            <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted">
              <Icon name="folder" className="h-3 w-3 shrink-0" />
              <span className="truncate">{i.path.slice(-2).join(" / ")}</span>
            </div>
          ) : null}
        </div>
      </div>
      {i.detail && <p className="mt-2 line-clamp-2 text-xs text-muted">{i.detail}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3 text-[11px] text-muted">
        <Badges i={i} />
        {i.meta && <span>{i.meta}</span>}
        <span className="ml-auto">{ago(i.updated_at)}</span>
      </div>
    </Link>
  );
}

function Row({ i, icon }: { i: AppHomeItem; icon: IconName }) {
  if (!i.actions) return <RowLink i={i} icon={icon} />;
  return (
    <div className="relative border-b border-line last:border-0 first:[&>a]:rounded-t-xl last:[&>a]:rounded-b-xl">
      <RowLink i={i} icon={icon} />
      <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1" data-app-home-actions={i.id}>
        {i.actions}
      </div>
    </div>
  );
}

function RowLink({ i, icon }: { i: AppHomeItem; icon: IconName }) {
  return (
    <Link href={i.href} className={`flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-panel-2 ${i.actions ? "pr-12" : "border-b border-line last:border-0"}`} data-app-home-item={i.id}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: "color-mix(in srgb, var(--app-accent) 14%, transparent)", color: "var(--app-accent)" }}>
        <Icon name={i.icon ?? icon} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-strong">{i.title}</span>
        <span className="block truncate text-xs text-muted">{(i.path ?? []).join(" / ")}</span>
      </span>
      <Badges i={i} />
      {i.meta && <span className="min-w-20 shrink-0 whitespace-nowrap text-right text-xs text-muted">{i.meta}</span>}
      <span className="w-24 text-right text-xs text-muted">{ago(i.updated_at)}</span>
    </Link>
  );
}
