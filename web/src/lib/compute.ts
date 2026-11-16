/** Compute profiles of streaming jobs and the compute-seconds a streaming build uses. */
import type { BuildRecord } from "./runtime";

export type StreamingProfileId = "xxs" | "xs" | "s" | "m" | "l" | "xl";
export type StreamingProfileSpec = {
  id: StreamingProfileId;
  label: string;
  /** job manager */
  jmCpu: number;
  jmGiB: number;
  /** task managers: `par` of them, plus one */
  par: number;
  tmCpu: number;
  tmGiB: number;
};

/** The streaming compute profiles (Build settings → Streaming). Every manager has one vCPU. */
export const STREAMING_PROFILES: StreamingProfileSpec[] = [
  { id: "xxs", label: "Extra Extra Small", jmCpu: 1, jmGiB: 1, par: 1, tmCpu: 1, tmGiB: 1 },
  { id: "xs", label: "Extra Small", jmCpu: 1, jmGiB: 1, par: 1, tmCpu: 1, tmGiB: 1 },
  { id: "s", label: "Small", jmCpu: 1, jmGiB: 1, par: 2, tmCpu: 1, tmGiB: 4 },
  { id: "m", label: "Medium", jmCpu: 1, jmGiB: 1, par: 3, tmCpu: 1, tmGiB: 6 },
  { id: "l", label: "Large", jmCpu: 1, jmGiB: 2, par: 4, tmCpu: 1, tmGiB: 8 },
  { id: "xl", label: "XLarge", jmCpu: 1, jmGiB: 2, par: 8, tmCpu: 1, tmGiB: 12 },
];

export const streamingProfile = (id?: string) => STREAMING_PROFILES.find((p) => p.id === id) ?? STREAMING_PROFILES[1];

/** One manager's rate: the larger of its vCPUs and its memory in units of 7.5 GiB, at 0.5 compute-seconds per second. */
const rate = (cpu: number, gib: number) => Math.max(cpu, gib / 7.5) * 0.5;

export type StreamingUsage = { seconds: number; jobManager: number; taskManagers: number; total: number; profile: StreamingProfileSpec };

/**
 * Compute-seconds of a streaming build:
 *   job manager   max(vCPU, GiB / 7.5) × 0.5 × seconds
 * + task managers max(vCPU, GiB / 7.5) × 0.5 × seconds × (parallelism + 1)
 * over the time it ran (until now while it runs).
 */
export function streamingUsage(b: Pick<BuildRecord, "started_at" | "finished_at" | "jobs">, at = Date.now()): StreamingUsage | null {
  if (!b.started_at) return null;
  const profile = streamingProfile(b.jobs[0]?.profile);
  const seconds = Math.max(0, ((b.finished_at ? Date.parse(b.finished_at) : at) - Date.parse(b.started_at)) / 1000);
  const jobManager = rate(profile.jmCpu, profile.jmGiB) * seconds;
  const taskManagers = rate(profile.tmCpu, profile.tmGiB) * seconds * (profile.par + 1);
  return { seconds, jobManager, taskManagers, total: jobManager + taskManagers, profile };
}

/** Batch compute profiles from smallest to largest, per family (a managed profile moves along its ladder). */
const LADDERS = [
  ["xs", "s", "m", "l", "xl"],
  ["warm-xs", "warm-s"],
  ["native-s", "native-m", "native-l", "native-xl"],
  ["faster-s", "faster-m", "faster-l", "faster-xl", "faster-xxl"],
];
/** below this, a job is "consistently small"; above LONG_S it needs the full allocation again */
export const SMALL_S = 60;
const LONG_S = 600;

export type ManagedChoice = { profile: string; reason: string };

/**
 * The managed profile strategy: the allocation of the next build from the last five successful builds (each
 * the longest job's seconds and the profile it ran on). Five builds under a minute scale down one step from
 * the smallest profile they used; a build over ten minutes goes back to the selected profile; otherwise the
 * last allocation is kept. Never above the selected profile, never below its family's smallest.
 */
export function managedProfile(selected: string, recent: { profile: string; seconds: number }[]): ManagedChoice {
  const ladder = LADDERS.find((l) => l.includes(selected));
  if (!ladder) return { profile: selected, reason: "not a profile the managed strategy scales" };
  const top = ladder.indexOf(selected);
  const at = (p: string) => Math.min(top, Math.max(0, ladder.indexOf(p) < 0 ? top : ladder.indexOf(p)));
  const last = recent.slice(0, 5);
  if (last.length < 5) return { profile: selected, reason: `${last.length} of 5 successful builds so far: the selected allocation` };
  if (last.some((b) => b.seconds > LONG_S)) return { profile: selected, reason: "a recent build ran over 10 minutes: back to the selected allocation" };
  if (last.every((b) => b.seconds < SMALL_S)) {
    const lowest = Math.min(...last.map((b) => at(b.profile)));
    const next = Math.max(0, lowest - 1);
    return { profile: ladder[next], reason: next < lowest ? `the last 5 builds each ran under a minute: scaled down to ${ladder[next]}` : `already at the smallest ${ladder[0]} profile` };
  }
  return { profile: ladder[at(last[0].profile)], reason: "recent builds are not consistently small: keeping the last allocation" };
}

/** e.g. "1,234 compute-seconds" */
export const computeSeconds = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 })} compute-seconds`;
