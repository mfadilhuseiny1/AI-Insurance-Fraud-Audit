export const PINNED_APPS_KEY = "bluesandai.platform-apps.pinned";
export const PINNED_APPS_EVENT = "bluesandai:platform-apps-updated";

export function readPinnedApps(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(PINNED_APPS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function setPinnedApps(ids: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PINNED_APPS_KEY, JSON.stringify([...new Set(ids)]));
  window.dispatchEvent(new Event(PINNED_APPS_EVENT));
}

export function togglePinnedApp(id: string): string[] {
  const current = readPinnedApps();
  const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
  setPinnedApps(next);
  return next;
}
