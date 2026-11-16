/** Workshop's Performance Profiler: in profiler mode (?profiler=1) widget loads and variable computations are
 * recorded with their start and end (ms since the page started), so the panel can show the module load time, a
 * timeline and the breakdown per widget and variable. Outside profiler mode recording costs nothing. */

export type ProfEvent = { seq: number; kind: "widget" | "variable"; id: string; name: string; container: string; start: number; end: number; ok: boolean };

const listeners = new Set<() => void>();
let events: ProfEvent[] = [];
let seq = 0;
let inflight = 0;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let loadEnd: number | null = null;

export const profilerOn = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("profiler") === "1";
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const emit = () => listeners.forEach((f) => f());

/** Time one load: a widget's query or a variable's computation. */
export function timed<T>(kind: ProfEvent["kind"], id: string, name: string, container: string, p: Promise<T>): Promise<T> {
  if (!profilerOn()) return p;
  const start = now();
  inflight++;
  if (quietTimer) clearTimeout(quietTimer);
  const done = (ok: boolean) => {
    events = [...events, { seq: ++seq, kind, id, name, container, start, end: now(), ok }];
    inflight--;
    // the module has loaded once nothing has been loading for half a second
    if (inflight === 0 && loadEnd === null) quietTimer = setTimeout(() => ((loadEnd = Math.max(...events.map((e) => e.end))), emit()), 500);
    emit();
  };
  p.then(
    () => done(true),
    () => done(false),
  );
  return p;
}

export const profiler = {
  events: () => events,
  loadTime: () => loadEnd,
  clear: () => {
    events = [];
    emit();
  },
  subscribe: (f: () => void) => {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  },
};
