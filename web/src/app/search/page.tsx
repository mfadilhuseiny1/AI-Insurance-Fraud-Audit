"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { ALL_APP_CATEGORIES } from "@/lib/platformApps";
import { compass, fmtTime, resultHref, type SearchResult, type TagCategory } from "@/lib/securityGov";

const TABS = [["all", "Top results"], ["apps", "Apps"], ["objects", "Objects"], ["datasets", "Datasets"], ["files", "Files"]] as const;
const GROUP_ICON: Record<string, IconName> = { apps: "grid", objects: "cube", datasets: "table", files: "doc" };

/** Quicksearch's full results view: apps, objects, datasets and files with filters and metadata. */
export default function SearchPage() {
  const [init] = useState(() => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)));
  const [q, setQ] = useState(init.get("q") ?? "");
  const [type, setType] = useState(init.get("type") ?? "all");
  const [tags, setTags] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [creator, setCreator] = useState(init.get("creator") ?? "");
  const [promoted, setPromoted] = useState(init.get("promoted") === "true");
  const [cats, setCats] = useState<TagCategory[]>([]);
  const [data, setData] = useState<{ total: number; groups: Record<string, number>; results: SearchResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    compass.tags().then(setCats, () => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!q.trim() && !tags.length && !promoted && !creator.trim()) {
        setData({ total: 0, groups: {}, results: [] });
        return;
      }
      compass.search({ q, type, tags: tags.join(","), path, creator: creator.trim() || undefined, promoted: promoted ? "true" : undefined, limit: 200 }).then(setData, (e: Error) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, type, tags, path, creator, promoted]);
  const apps = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n && (type === "all" || type === "apps") ? ALL_APP_CATEGORIES.flatMap((c) => c.apps.map((a) => ({ ...a, category: c.name }))).filter((a) => a.href && (a.name.toLowerCase().includes(n) || a.description.toLowerCase().includes(n))).slice(0, 12) : [];
  }, [q, type]);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Search" icon="search" href="/search" />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 space-y-4 overflow-y-auto border-b border-line bg-panel p-4 md:w-64 md:border-b-0 md:border-r">
          <input className={inputClass} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={promoted} onChange={(e) => setPromoted(e.target.checked)} />Promoted items only</label>
          <label className="block space-y-1 text-xs"><span className="text-muted">Path contains</span><input className={inputClass} value={path} onChange={(e) => setPath(e.target.value)} placeholder="Project or folder name" /></label>
          <label className="block space-y-1 text-xs"><span className="text-muted">Created by</span><input className={inputClass} value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="Username (or creator:name in the search)" /></label>
          {cats.map((c) => (
            <div key={c.id}>
              <div className="mb-1 text-xs font-semibold text-soft">{c.name}</div>
              {c.tags.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={tags.includes(t.id)} onChange={(e) => setTags((x) => (e.target.checked ? [...x, t.id] : x.filter((y) => y !== t.id)))} />{t.name}</label>
              ))}
            </div>
          ))}
          <p className="text-[11px] text-muted">Objects are searched on up to 250 object types (active, prominent first). Use <Link href="/object-explorer" className="text-ocean hover:underline">Object Explorer</Link> for a specific type.</p>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
          <div className="flex gap-1 border-b border-line bg-panel px-4">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setType(id)} className={`border-b-2 px-3 py-2.5 text-sm ${type === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
                {label}{id !== "all" && data?.groups[id] ? <span className="ml-1 text-xs text-muted">{data.groups[id]}</span> : null}
              </button>
            ))}
          </div>
          <div className="mx-auto max-w-5xl space-y-2 p-4">
            {error && <ApiError message={error} />}
            {apps.map((a) => (
              <Link key={a.name} href={a.href!} className="flex items-start gap-3 rounded-lg border border-line bg-panel p-3 hover:border-ocean/50">
                <Icon name={a.icon} className="mt-0.5 h-5 w-5 text-ocean" />
                <span className="min-w-0 flex-1"><span className="font-medium">{a.name}</span> <span className="text-xs text-muted">Platform app · {a.category}</span><span className="mt-0.5 line-clamp-2 block text-xs text-soft">{a.description}</span></span>
              </Link>
            ))}
            {!data ? <Loading /> : !data.results.length && !apps.length ? <p className="p-6 text-center text-sm text-muted">{q.trim() || tags.length || promoted ? "No results." : "Type to search."}</p> : data.results.map((r) => (
              <Link key={`${r.group}:${r.id}`} href={resultHref(r)} className="flex items-start gap-3 rounded-lg border border-line bg-panel p-3 hover:border-ocean/50">
                <Icon name={GROUP_ICON[r.group] ?? "doc"} className="mt-0.5 h-5 w-5 text-ocean" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.name}</span>{r.promoted && <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-purple-300"><Icon name="check" className="h-3 w-3" />Promoted</span>}
                  <span className="block text-xs text-muted">{r.type_label}{r.path ? ` · ${r.path}` : ""}{r.updated_at ? ` · updated ${fmtTime(r.updated_at)}` : ""}{r.created_by ? ` · by ${r.created_by}` : ""}{r.views ? ` · ${r.views} view${r.views === 1 ? "" : "s"}` : ""}{r.markings ? ` · ${r.markings} marking${r.markings === 1 ? "" : "s"}` : ""}</span>
                  {!!r.columns.length && <span className="block text-xs text-soft">Columns: {r.columns.join(", ")}</span>}
                  {!!r.tags.length && <span className="mt-1 flex flex-wrap gap-1">{r.tags.map((t) => <span key={t.id} className="rounded bg-panel-2 px-1.5 text-[10px] text-soft">{t.category}: {t.name}</span>)}</span>}
                </span>
              </Link>
            ))}
            <p className="pt-2 text-center text-[11px] text-muted">Only resources you can access are shown.</p>
          </div>
        </main>
      </div>
    </div>
  );
}
