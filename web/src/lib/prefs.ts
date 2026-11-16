"use client";

import { useSyncExternalStore } from "react";
import type { UserPreferences } from "./pipeline";

/** Pipeline Builder user preferences: kept per browser (they are the user's, not the pipeline's). */
const KEY = "bluesandai.pipeline.prefs";
const EVENT = "bluesandai:pipeline-prefs";
export const DEFAULT_PREFS: UserPreferences = { collapsedStyle: "summary", autoName: true, previewMode: "auto", snapToGrid: false };

let cached: { raw: string | null; value: UserPreferences } = { raw: null, value: DEFAULT_PREFS };

export function readPrefs(): UserPreferences {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {}
  // the same object while the stored text is unchanged (useSyncExternalStore compares snapshots)
  if (raw !== cached.raw) {
    try {
      cached = { raw, value: { ...DEFAULT_PREFS, ...JSON.parse(raw ?? "{}") } };
    } catch {
      cached = { raw, value: DEFAULT_PREFS };
    }
  }
  return cached.value;
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
};

export function usePrefs(): [UserPreferences, (p: UserPreferences) => void] {
  const prefs = useSyncExternalStore(subscribe, readPrefs, () => DEFAULT_PREFS);
  const save = (p: UserPreferences) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {}
    window.dispatchEvent(new Event(EVENT));
  };
  return [prefs, save];
}
