import { API_URL } from "./api";

/** Object Explorer home (api/ontology_explorer.py): one keyword search across object types, the landing page's
 *  groups and applications, and the viewer's own recents, favorites, searches and exploration tabs (browser storage). */

export type KeywordHit = {
  object_type_id: string;
  type_name: string;
  icon?: string;
  color?: string | null;
  primary_key: string;
  title: string;
  matches: { property: string; display_name: string; value: string }[];
};
export type KeywordResult = {
  q: string;
  total: number;
  by_type: { id: string; display_name: string; count: number; icon?: string; color?: string | null }[];
  objects: KeywordHit[];
  object_types: { id: string; display_name: string; description: string; object_count: number | null }[];
  searched: number;
  skipped: { id: string; display_name: string; object_count: number | null; reason: "large" | "time" }[];
  skipped_count: number;
  compute_seconds: number;
};
export type ExplorerHome = {
  groups: { id: string; name: string; description: string; object_type_ids: string[] }[];
  applications: { kind: string; id: string; name: string; href: string; object_type_ids: string[] }[];
  object_types: Record<string, { applications: number; links: number }>;
};

/** Test items (a "(test)" name) stay out of the lists; they remain searchable by name. */
export const isTestName = (name?: string | null) => /\(test\)/i.test(name ?? "");

async function req<T>(path: string, json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/ontology${path}`, {
    credentials: "include",
    cache: "no-store",
    ...(json !== undefined ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const explorer = {
  keyword: (body: { q: string; object_type_ids?: string[]; only_type?: string | null; offset?: number; limit?: number }) => req<KeywordResult>("/explorer/keyword", body),
  home: () => req<ExplorerHome>("/explorer/home"),
};

/* ---- the viewer's own lists: conveniences in browser storage (an empty list when storage is unavailable) ---- */

export type RecentItem =
  | { kind: "type"; id: string; title: string; count?: number | null; icon?: string; color?: string | null; at: number }
  | { kind: "object"; id: string; pk: string; title: string; typeName: string; icon?: string; color?: string | null; at: number };

type NewItem = RecentItem extends infer R ? (R extends unknown ? Omit<R, "at"> : never) : never;

const KEYS = { recent: "bluesandai:oe-recent", fav: "bluesandai:oe-favorites", searches: "bluesandai:oe-searches", tabs: "bluesandai:oe-tabs" };

function read<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: not remembered */
  }
}
const itemKey = (i: { kind: string; id: string; pk?: string }) => `${i.kind}:${i.id}:${i.pk ?? ""}`;

export const recents = {
  list: (): RecentItem[] => read<RecentItem[]>(KEYS.recent, []),
  add: (i: NewItem) => write(KEYS.recent, [{ ...i, at: Date.now() } as RecentItem, ...recents.list().filter((x) => itemKey(x) !== itemKey(i))].slice(0, 24)),
};
export const favorites = {
  list: (): RecentItem[] => read<RecentItem[]>(KEYS.fav, []),
  has: (i: { kind: string; id: string; pk?: string }) => favorites.list().some((x) => itemKey(x) === itemKey(i)),
  toggle: (i: NewItem) => {
    const all = favorites.list();
    write(KEYS.fav, all.some((x) => itemKey(x) === itemKey(i)) ? all.filter((x) => itemKey(x) !== itemKey(i)) : [{ ...i, at: Date.now() } as RecentItem, ...all]);
  },
};
export const searches = {
  list: (): string[] => read<string[]>(KEYS.searches, []),
  add: (q: string) => write(KEYS.searches, [q, ...searches.list().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8)),
};

/** Exploration tabs: each is an Object Explorer address (its query string) with a label. */
export type ExplorerTab = { id: string; label: string; query: string; icon: "search" | "cube" | "home" };
export const tabsStore = {
  list: (): ExplorerTab[] => read<ExplorerTab[]>(KEYS.tabs, []),
  save: (t: ExplorerTab[]) => write(KEYS.tabs, t.slice(0, 12)),
};
