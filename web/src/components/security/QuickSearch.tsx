"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ALL_APP_CATEGORIES } from "@/lib/platformApps";
import { compass, resultHref, type SearchResult } from "@/lib/securityGov";

export const QUICKSEARCH_EVENT = "bsai:quicksearch";
const RECENT_KEY = "bluesandai.quicksearch.recent";
const GROUP_ICON: Record<string, IconName> = { apps: "grid", objects: "cube", datasets: "table", files: "doc" };

const readRecent = (): string[] => {
  try {
    return JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
};

/**
 * Quicksearch (Compass): Ctrl+J / Cmd+J or the sidebar's Search. Jump-to mode searches titles of platform apps,
 * application resources, objects, datasets and files; Enter opens the full results view (/search).
 */
export function QuickSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchResult[]>([]);
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const show = () => {
      setRecent(readRecent());
      setOpen(true);
      setTimeout(() => input.current?.focus(), 10);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        show();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    window.addEventListener(QUICKSEARCH_EVENT, show);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener(QUICKSEARCH_EVENT, show);
    };
  }, []);
  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    const t = setTimeout(() => {
      compass.search({ q, jump: "true", limit: 12 }).then((r) => { setRows(r.results); setSel(0); }, () => setRows([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);
  const apps = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return ALL_APP_CATEGORIES.flatMap((c) => c.apps).filter((a) => a.href && a.name.toLowerCase().includes(needle)).slice(0, 5);
  }, [q]);
  if (!open) return null;
  const items: { key: string; label: string; sub: string; icon: IconName; href: string; promoted?: boolean }[] = [
    ...apps.map((a) => ({ key: `app:${a.name}`, label: a.name, sub: "Platform app", icon: a.icon, href: a.href! })),
    ...(q.trim().length < 2 ? [] : rows).map((r) => ({ key: `${r.group}:${r.id}`, label: r.name, sub: `${r.type_label}${r.path ? ` · ${r.path}` : ""}`, icon: GROUP_ICON[r.group] ?? "doc", href: resultHref(r), promoted: r.promoted })),
  ];
  const go = (href: string) => {
    const next = [q.trim(), ...readRecent().filter((x) => x !== q.trim())].filter(Boolean).slice(0, 8);
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // private window
    }
    setOpen(false);
    setQ("");
    router.push(href);
  };
  const full = (tab = "all") => go(`/search?q=${encodeURIComponent(q.trim())}${tab !== "all" ? `&type=${tab}` : ""}`);
  return (
    <div className="fixed inset-0 z-[85] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={() => setOpen(false)} data-quicksearch>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" className="h-4 w-4 text-muted" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps, objects, datasets and files…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey || !items[sel]) full(); else go(items[sel].href); }
            }} />
          <kbd className="rounded border border-line-2 px-1.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <div className="flex gap-1 border-b border-line px-3 py-1.5">
          {["apps", "objects", "datasets", "files"].map((t) => (
            <button key={t} type="button" disabled={!q.trim()} onClick={() => full(t)} className="rounded px-2 py-0.5 text-xs capitalize text-soft hover:bg-panel-2 disabled:opacity-40">{t}</button>
          ))}
          <span className="ml-auto text-[11px] text-muted">Enter: open · Shift+Enter: all results</span>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {!q.trim() && recent.map((r) => (
            <li key={r}><button type="button" onClick={() => setQ(r)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-soft hover:bg-panel-2"><Icon name="clock" className="h-3.5 w-3.5 text-muted" />{r}</button></li>
          ))}
          {items.map((it, i) => (
            <li key={it.key}>
              <button type="button" onClick={() => go(it.href)} onMouseEnter={() => setSel(i)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === sel ? "bg-ocean/15" : ""}`}>
                <Icon name={it.icon} className="h-4 w-4 shrink-0 text-ocean" />
                <span className="min-w-0 flex-1"><span className="block truncate">{it.label}{it.promoted && <Icon name="check" className="ml-1 inline h-3 w-3 text-purple-300" />}</span><span className="block truncate text-[11px] text-muted">{it.sub}</span></span>
              </button>
            </li>
          ))}
          {q.trim().length >= 2 && !items.length && <li className="px-3 py-3 text-sm text-muted">No title matches. Press Enter to search descriptions, column names and paths too.</li>}
        </ul>
      </div>
    </div>
  );
}
