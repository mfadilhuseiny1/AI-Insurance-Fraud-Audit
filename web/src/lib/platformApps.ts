import type { IconName } from "@/components/Icon";

const PROMOTED_WORKSHOP_KEY = "bluesandai.platform-apps.workshop-promoted";
export const PROMOTED_APPS_EVENT = "bluesandai:platform-apps-promoted-updated";

export type PlatformApp = {
  /** Stable identifier used for pinning and future server-side curation. */
  id?: string;
  name: string;
  description: string;
  icon: IconName;
  /** route of the BluesandAI page that covers this app; absent = not built yet */
  href?: string;
  owner?: string;
  collection?: string;
  tags?: string[];
  trusted?: boolean;
};

export type AppCategory = { name: string; apps: PlatformApp[] };

export function readPromotedWorkshopApps(): PlatformApp[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(PROMOTED_WORKSHOP_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((app): app is PlatformApp => !!app && typeof app.id === "string" && typeof app.name === "string") : [];
  } catch {
    return [];
  }
}

export const readPromotedApps = readPromotedWorkshopApps;

export function promoteWorkshopApp(app: PlatformApp) {
  if (typeof window === "undefined") return;
  const apps = readPromotedWorkshopApps().filter((item) => item.id !== app.id);
  window.localStorage.setItem(PROMOTED_WORKSHOP_KEY, JSON.stringify([...apps, app]));
  window.dispatchEvent(new Event(PROMOTED_APPS_EVENT));
}

export function unpromoteWorkshopApp(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PROMOTED_WORKSHOP_KEY, JSON.stringify(readPromotedWorkshopApps().filter((app) => app.id !== id)));
  window.dispatchEvent(new Event(PROMOTED_APPS_EVENT));
}

export const promoteSlateApp = promoteWorkshopApp;
export const unpromotePlatformApp = unpromoteWorkshopApp;

/** AI JKN Audit (2026-10-29: "cuman butuh ini aja sisanya engga butuh"): the catalog keeps AIP JKN only; the
 *  platform's own apps, the other solutions and the promoted document apps are not part of this app. */
export const APP_CATEGORIES: AppCategory[] = [];

/**
 * Solution apps: what was built ON BluesandAI for one client or domain (JKN, PLN, …), kept apart from the core platform
 * apps above. Each solution lists its curated pages and owns the Applications Portal collections its builds register
 * (/api/agentic-apps), so those listings show under the solution instead of mixing into the platform's own apps.
 */
export type Solution = {
  id: string;
  name: string;
  /** who the solution is for */
  client: string;
  description: string;
  icon: IconName;
  /** Applications Portal collections that belong to this solution */
  collections: string[];
  apps: PlatformApp[];
};

export const SOLUTIONS: Solution[] = [
  {
    id: "jkn",
    name: "JKN Healthcare Intelligence",
    client: "BPJS Kesehatan · Jaminan Kesehatan Nasional (demo)",
    description: "AIP JKN: AI Agent Swarm, agen, ML Studio, Box Karantina, Evaluasi Swarm, Keamanan & Akses, Nexus, Data Lineage dan Pipeline Builder di atas Data Sampel BPJS.",
    icon: "alert",
    collections: ["Audit JKN", "JKN", "JKN Healthcare"],
    apps: [
      { name: "AIP JKN · Agen domain & layar dinamis", icon: "sparkle", href: "/aip-jkn", owner: "JKN Healthcare Intelligence", collection: "Audit JKN",
        tags: ["JKN", "AIP", "ADK", "agent", "BPJS", "fraud", "Nexus", "open models"],
        description: "Tanya data BPJS: orkestrator (Google ADK, model terbuka di Vertex AI) membagi pertanyaan ke agen pemilik objek Nexus, validator dari keluarga model lain memeriksa jawabannya, dan layar dinamis menampilkan hasil. Setiap langkah bisa dibuka; Data Lineage, Pipeline dan Object Explorer terhubung." },
    ],
  },
];

export const SOLUTION_CATEGORIES: AppCategory[] = SOLUTIONS.map((s) => ({ name: s.name, apps: s.apps }));
/** core platform apps and solution apps together — for pins and search, which must find both */
export const ALL_APP_CATEGORIES: AppCategory[] = [...APP_CATEGORIES, ...SOLUTION_CATEGORIES];

/** the solution a registry listing belongs to (by its Applications Portal collection) */
export function solutionOf(app: Pick<PlatformApp, "collection">): Solution | undefined {
  const c = (app.collection ?? "").toLowerCase();
  return c ? SOLUTIONS.find((s) => s.collections.some((x) => x.toLowerCase() === c)) : undefined;
}

/** BluesandAI's own apps, pinned under "Promoted apps" like Foundry's launcher */
export const PROMOTED_APPS: PlatformApp[] = [];
