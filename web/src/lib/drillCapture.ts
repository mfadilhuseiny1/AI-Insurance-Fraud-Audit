/**
 * Path capture for team races (api/ontology_design.py): after a participant joins a race, Object Explorer searches
 * and object views report what was opened — the object type, the links followed, the terms searched.
 */
import { request } from "./ontology";

export type Capture = { drill_id: string; drill_name: string; race_id: string; participant: string; team: string };
const KEY = "bsai:drill-capture";
const EVENT = "bsai:drill-capture-changed";

/** The stored capture as a string (a stable snapshot for useSyncExternalStore). */
export function captureSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "null";
  } catch {
    return "null";
  }
}

export function activeCapture(): Capture | null {
  try {
    return JSON.parse(captureSnapshot()) as Capture | null;
  } catch {
    return null;
  }
}

export function setCapture(c: Capture | null): void {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: capture just stays off
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onCaptureChange(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", fn);
  };
}

/** Report a view to the running race (fire and forget; nothing happens unless this browser joined one). */
export function capture(ev: { object_type_id?: string | null; link_type_ids?: string[]; q?: string; primary_key?: string }): void {
  if (typeof window === "undefined") return;
  const c = activeCapture();
  if (!c) return;
  void request("/design/capture", { method: "POST", json: { drill_id: c.drill_id, race_id: c.race_id, participant: c.participant, ...ev } }).catch(() => setCapture(null));
}
