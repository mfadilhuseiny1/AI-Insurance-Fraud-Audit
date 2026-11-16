"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { isTestName, searches } from "@/lib/explorer";
import type { ObjectType } from "@/lib/ontology";
import type { Group } from "@/lib/ontologyModel";

/* The Object Explorer search: "Search across" (all object types, a group, or picked object types) and the search term,
   with the recent searches and the object types whose name matches while typing. */

export function SearchPill({
  types,
  groups,
  scope,
  onScope,
  initial = "",
  onSearch,
  onOpenType,
  compact = false,
}: {
  types: ObjectType[];
  groups: Group[];
  scope: string[];
  onScope: (ids: string[]) => void;
  initial?: string;
  onSearch: (q: string) => void;
  onOpenType: (id: string) => void;
  compact?: boolean;
}) {
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState<null | "scope" | "term">(null);
  const [tab, setTab] = useState<"groups" | "types">("types");
  const [find, setFind] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const shown = useMemo(() => types.filter((t) => t.visibility !== "hidden" && !isTestName(t.display_name)), [types]);
  const label = !scope.length ? "All object types" : scope.length === 1 ? (shown.find((t) => t.id === scope[0])?.display_name ?? "1 object type") : `${scope.length} object types`;
  const typeHits = q.trim().length > 1 ? shown.filter((t) => `${t.display_name} ${t.api_name}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 5) : [];
  const submit = () => {
    const s = q.trim();
    if (!s) return;
    searches.add(s);
    setOpen(null);
    onSearch(s);
  };
  const pick = (ids: string[]) => onScope(ids);
  const filtered = shown.filter((t) => !find || t.display_name.toLowerCase().includes(find.toLowerCase()));
  return (
    <div ref={box} className={`relative w-full ${compact ? "max-w-3xl" : "max-w-[640px]"}`}>
      <div className={`flex items-stretch rounded-full border border-line-2 bg-panel shadow-lg shadow-black/20 ${compact ? "" : "ring-1 ring-white/5"}`}>
        <button
          type="button"
          onClick={() => setOpen(open === "scope" ? null : "scope")}
          className={`flex w-56 shrink-0 items-center gap-2 rounded-l-full border-r border-line-2 text-left hover:bg-panel-2/60 ${compact ? "px-4 py-1.5" : "px-5 py-2.5"}`}
          data-oe-scope
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] text-muted">Search across</span>
            <span className="block truncate text-sm text-white">{label}</span>
          </span>
          <Icon name="down" className="h-3.5 w-3.5 text-muted" />
        </button>
        <label className={`flex min-w-0 flex-1 flex-col justify-center ${compact ? "px-4 py-1.5" : "px-5 py-2.5"}`}>
          <span className="text-[10px] text-muted">Search term</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => {
              setRecent(searches.list());
              setOpen("term");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setOpen(null);
            }}
            placeholder="Search for object types or objects…"
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-muted"
            data-oe-term
          />
        </label>
        <button type="button" onClick={submit} aria-label="Search" className="m-1.5 flex aspect-square items-center justify-center rounded-full bg-ocean px-2.5 text-white hover:brightness-110" data-oe-go>
          <Icon name="search" className="h-4 w-4" />
        </button>
      </div>

      {open === "scope" && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl">
          <div className="flex gap-4 border-b border-line px-3 pt-2 text-xs">
            {(["groups", "types"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 pb-1.5 ${tab === k ? "border-ocean text-white" : "border-transparent text-muted"}`}>
                {k === "groups" ? "Groups" : "Object types"}
              </button>
            ))}
            {scope.length > 0 && (
              <button type="button" onClick={() => pick([])} className="ml-auto pb-1.5 text-ocean hover:underline">
                All object types
              </button>
            )}
          </div>
          {tab === "types" && (
            <div className="border-b border-line p-2">
              <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search for object types…" className="w-full rounded-md bg-panel-2 px-2 py-1.5 text-xs outline-none" />
            </div>
          )}
          <div className="max-h-72 overflow-y-auto py-1">
            {tab === "groups" ? (
              groups.filter((g) => !isTestName(g.name)).length ? (
                groups.filter((g) => !isTestName(g.name)).map((g) => (
                  <button key={g.id} type="button" onClick={() => (pick(g.object_type_ids), setOpen(null))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-panel-2">
                    <Icon name="grid" className="h-3.5 w-3.5 text-sand" />
                    <span className="min-w-0 flex-1 truncate text-soft">{g.name}</span>
                    <span className="text-muted">{g.object_type_ids.length}</span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-3 text-xs text-muted">No object type groups yet (Ontology Manager → Groups).</p>
              )
            ) : (
              filtered.map((t) => {
                const on = scope.includes(t.id);
                return (
                  <label key={t.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-panel-2">
                    <input type="checkbox" checked={on} onChange={() => pick(on ? scope.filter((x) => x !== t.id) : [...scope, t.id])} />
                    <TypeIcon t={t} className="h-3.5 w-3.5" box="rounded p-0.5" />
                    <span className="min-w-0 flex-1 truncate text-soft">{t.display_name}</span>
                    <span className="rounded bg-panel-2 px-1.5 text-[10px] tabular-nums text-muted">{compactNum(t.object_count ?? 0)}</span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}

      {open === "term" && (recent.length > 0 || typeHits.length > 0) && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[calc(100%-14rem)] overflow-hidden rounded-xl border border-line-2 bg-panel py-1 shadow-2xl">
          {typeHits.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">Object types</div>
              {typeHits.map((t) => (
                <button key={t.id} type="button" onClick={() => (setOpen(null), onOpenType(t.id))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-panel-2">
                  <TypeIcon t={t} className="h-3.5 w-3.5" box="rounded p-0.5" />
                  <span className="flex-1 truncate text-soft">{t.display_name}</span>
                  <span className="text-muted">{compactNum(t.object_count ?? 0)} objects</span>
                </button>
              ))}
            </>
          )}
          {recent.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">Recent searches</div>
              {recent.map((r) => (
                <button key={r} type="button" onClick={() => (setQ(r), searches.add(r), setOpen(null), onSearch(r))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-panel-2">
                  <Icon name="search" className="h-3.5 w-3.5 text-ocean" />
                  <span className="flex-1 truncate text-soft">{r}</span>
                </button>
              ))}
            </>
          )}
          <div className="border-t border-line px-3 py-1.5 text-[10px] text-muted">↵ to see all results</div>
        </div>
      )}
    </div>
  );
}

export function compactNum(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n);
}
