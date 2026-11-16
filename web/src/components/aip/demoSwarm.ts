"use client";
import { useSyncExternalStore } from "react";
import { API_URL } from "@/lib/api";
import { aip, type AipEvent, type Rec, type Run } from "@/components/aip/aipRun";
import { fraud, type FullReport, type Project } from "@/components/aip/fraudApi";

/* /swarm-x: the AI Agent Swarm tab for a tutorial (the user, 2026-10-30: "seakan2 saya nge klik mulai project dan nge run
   padahal yg di run adalah simulasi yang sudah pernah kita run yg audit nasional 1.1 … seakan2 ini beneran dari awal belum
   ada laporan … tp bisa dipercepat 15x"). While the page is open the tab's calls are answered here: its projects and
   engagements live in the page only, and an engagement "runs" by releasing a recorded one's events on a clock the speed
   buttons drive. Blu 1.1 plays the simulation of Audit Nasional 1.1 (GET /simulasi: the clinical examination projected
   from the calibration, then run-675404928dfd's real trail); Blu 1.0 plays that trail alone. The long report at the end
   is that engagement's own. No model is called and nothing is written: any other change sent under /api/aip is refused. */

/** Audit Nasional 1.1 · penugasan 1 (project pr-45d84b9f13): the engagement replayed unless the address names another */
export const DEMO_SOURCE = "run-675404928dfd";
export const DEMO_SPEEDS = [1, 5, 15, 40, 100];
// with "lewati jeda" a quiet stretch (models thinking, the projected examination between its counts) counts at most this
// many seconds of the engagement: Blu 1.1 is then ~77 min of engagement, ~5 min at 15× (as recorded: 314 min, 21 min)
const IDLE_CAP = 20;

type Trail = { events: AipEvent[]; offs: number[] };  // offs: each event's second from the trail's start
type Source = { q: string; agents: number; blu11: Trail; blu10: Trail; usage: Record<string, Rec>; spent: number };
type Engagement = {
  run: Run & Rec; trail: Trail; out: AipEvent[]; next: number;
  /** the next event's time and the clock, in seconds of the engagement; wall: when the clock last moved; t0: its start (ms) */
  due: number; clock: number; wall: number; t0: number;
  usage: Record<string, Rec>; spent: number; shown: Record<string, Rec>; telaah: number;
};

const S = {
  sumber: DEMO_SOURCE, laporan: DEMO_SOURCE, speed: 15, paused: false, skip: true,
  source: null as Promise<Source> | null, ready: false, err: "",
  projects: [] as Project[], runs: [] as Engagement[],
};

async function get<T = Rec>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}
// event times are UTC, with an offset or without one
const msOf = (t: unknown) => { const s = String(t ?? ""); return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`); };
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);  // as the API writes event times
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2))), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
const refuse = async (): Promise<never> => { throw new Error("Mode tutorial: tidak dikirim ke server (tanpa panggilan model)."); };

/** an event as a live engagement writes it: no mark of the simulation, its place given when it is released */
function clean(e: AipEvent): AipEvent {
  const c: Rec = { ...e };
  delete c.simulasi;
  delete c.seq;
  if (typeof c.bukti === "string") c.bukti = c.bukti.replace(" (simulasi)", "");
  return c as AipEvent;
}
function trail(events: AipEvent[]): Trail {
  const base = msOf(events[0]?.t);
  let last = 0;
  // a time earlier than the one before (a copied trail, writers out of step) does not take the clock back
  return { events, offs: events.map((e) => { const s = (msOf(e.t) - base) / 1000; last = Number.isFinite(s) ? Math.max(last, s) : last; return last; }) };
}

/** The recorded engagement, both ways: Blu 1.1 as /simulasi lays it out, Blu 1.0 without the projected examination. */
function load(): Promise<Source> {
  S.source ??= (async () => {
    const [sim, src] = await Promise.all([
      get<{ run: Rec; events: AipEvent[] }>(`/api/aip/konsultan/simulasi?sumber=${encodeURIComponent(S.sumber)}`),
      // the run without its events: what each of its agents spent
      get<{ run: Rec }>(`/api/aip/runs/${encodeURIComponent(S.sumber)}?after=1000000000`).catch(() => null),
    ]);
    const real = sim.events.filter((e) => !e.simulasi);
    const start = sim.events.find((e) => e.type === "run") ?? { type: "run", status: "started", kind: "konsultan", seq: 0 };
    const firm = sim.events.find((e) => e.type === "firm");
    if (!firm || !real.length) throw new Error(`jejak ${S.sumber} tidak bisa diputar`);
    const t = real[0].t;
    const firm10 = { ...firm, t, versi: "1.0", mesin: ((firm.mesin ?? []) as Rec[]).filter((m) => m.key !== "telaah_klinis"),
      fase: ((firm.fase ?? []) as Rec[]).filter((f) => f.id !== "telaah") } as AipEvent;
    return {
      q: String(sim.run.q ?? ""), agents: ((firm.tim ?? []) as unknown[]).length,
      blu11: trail(sim.events.map(clean)), blu10: trail([{ ...start, t }, firm10, ...real].map(clean)),
      usage: (src?.run.agents_usage ?? {}) as Record<string, Rec>, spent: Number(src?.run.spent_usd ?? 0),
    };
  })();
  const p = S.source;
  p.then(() => { S.ready = true; S.err = ""; emit(); }, (e) => { if (S.source === p) S.source = null; S.err = (e as Error).message; emit(); });
  return p;
}

/** The engagement's clock moved to now: every event due by then is released, dated on the engagement's own time. */
function tick(E: Engagement, now = Date.now()) {
  if (E.run.status !== "running") return;
  if (!S.paused) E.clock += ((now - E.wall) / 1000) * S.speed;
  E.wall = now;
  const { events, offs } = E.trail;
  while (E.next < events.length && E.due <= E.clock) {
    const i = E.next, e = events[i];
    E.out.push({ ...e, seq: E.out.length, t: iso(E.t0 + E.due * 1000) });
    // what an agent spent shows once it has finished; the examination's spend as it goes
    if (e.type === "agent_status" && (e.status === "selesai" || e.status === "gagal") && E.usage[e.agent]) E.shown[e.agent] = E.usage[e.agent];
    if (e.type === "telaah" && e.usd != null) E.telaah = Number(e.usd);
    E.next++;
    if (E.next < events.length) { const gap = offs[E.next] - offs[i]; E.due += S.skip ? Math.min(gap, IDLE_CAP) : gap; }
  }
  if (E.next >= events.length) {
    E.run.status = "succeeded";
    E.run.finished_at = new Date(E.t0 + E.due * 1000).toISOString();
    E.shown = { ...E.usage };
  }
  E.run.agents_usage = { ...E.shown };
  E.run.spent_usd = E.run.status === "succeeded" ? E.spent + E.telaah : Object.values(E.shown).reduce((n, u) => n + Number(u.usd ?? 0), 0) + E.telaah;
}
const tickAll = () => { const now = Date.now(); S.runs.forEach((E) => tick(E, now)); };
function find(id: string): Engagement {
  const E = S.runs.find((x) => x.run.id === id);
  if (!E) throw new Error("penugasan tidak ditemukan");
  return E;
}
const isDemo = (id: string) => S.runs.some((E) => E.run.id === id);

async function start(f: { nama: string; fokus: string | null; proyek: string | null; versi?: string }) {
  if (S.runs.some((E) => E.run.status === "running")) throw new Error("satu penugasan sedang berjalan");
  const src = await load();  // "Membentuk firma…" while the trail is still on its way
  const versi = f.versi === "1.0" ? "1.0" : "1.1";
  const now = Date.now();
  const E: Engagement = {
    run: { id: `run-${hex(12)}`, kind: "konsultan", status: "running", q: src.q, nama: f.nama, fokus: f.fokus, proyek: f.proyek, versi,
      created_at: new Date(now).toISOString(), finished_at: null, spent_usd: 0, agents_usage: {}, budget_usd: null },
    trail: versi === "1.0" ? src.blu10 : src.blu11, out: [], next: 0, due: 0, clock: 0, wall: now, t0: now,
    usage: src.usage, spent: src.spent, shown: {}, telaah: 0,
  };
  S.runs.unshift(E);
  tick(E, now);
  emit();
  return { run: E.run.id, jumlah_agen: src.agents };
}

/** The recorded engagement's long report, dated as this one ran; its run stays the recorded one, which its links (its own
 *  page, the claim traces of its case files) open. */
async function report(orig: typeof fraud, id: string): Promise<FullReport> {
  const E = find(id);
  tick(E);
  const rep = await orig.fullReport(S.laporan);
  const end = E.run.finished_at ?? null;
  return { ...rep, status: E.run.status, mulai: E.run.created_at, selesai: end, biaya_usd: E.run.spent_usd,
    beku_pada: rep.beku_pada && end, narasi_pada: rep.narasi_pada && end };
}

/** The tab's calls while the demo is open; reads of the platform (the team, the data's readiness, the review's state, the
 *  box) still go to the API. */
function patches(orig: { fraud: typeof fraud; aip: typeof aip }): { fraud: Partial<typeof fraud>; aip: Partial<typeof aip> } {
  return {
    fraud: {
      projects: async () => S.projects.map((p) => ({ ...p })),
      createProject: async (f) => {
        const p: Project = { id: `pr-${hex(10)}`, ...f, dibuat_pada: new Date().toISOString() };
        S.projects.unshift(p);
        return { ...p };
      },
      updateProject: async (id, f) => {
        const p = S.projects.find((x) => x.id === id);
        if (!p) throw new Error("proyek tidak ditemukan");
        Object.assign(p, f);
        return { ...p };
      },
      deleteProject: async (id) => {
        const gone = S.runs.filter((E) => E.run.proyek === id).map((E) => E.run.id);
        S.projects = S.projects.filter((p) => p.id !== id);
        S.runs = S.runs.filter((E) => E.run.proyek !== id);
        emit();
        return { dihapus: id, penugasan: gone };
      },
      engagements: async () => { tickAll(); return S.runs.map((E) => ({ ...E.run })); },
      startEngagement: start,
      deleteEngagement: async (id) => { S.runs = S.runs.filter((E) => E.run.id !== id); emit(); return { dihapus: id }; },
      // the orchestrations the demo has a trail for
      config: async () => {
        const c = await orig.fraud.config();
        return { ...c, versi: c.versi && Object.fromEntries(Object.entries(c.versi).filter(([k]) => k === "1.0" || k === "1.1")) };
      },
      fullReport: async (id) => (isDemo(id) ? report(orig.fraud, id) : orig.fraud.fullReport(id)),
      reportPdf: async (id) => orig.fraud.reportPdf(isDemo(id) ? S.laporan : id),
      rewriteReport: refuse, writeNotes: refuse, calibrate: refuse,
    },
    aip: {
      run: async (id, after = 0) => {
        if (!isDemo(id)) return orig.aip.run(id, after);
        const E = find(id);
        tick(E);
        return { run: { ...E.run }, events: E.out.slice(Math.max(0, after)), next: E.out.length };
      },
      // "Hentikan penugasan": the clock stops where it is; what was released stays
      cancel: async (id) => {
        if (!isDemo(id)) return refuse();
        const E = find(id);
        tick(E);
        if (E.run.status === "running") {
          E.run.status = "cancelled";
          E.run.finished_at = new Date(E.t0 + E.clock * 1000).toISOString();
        }
        return { status: E.run.status };
      },
    },
  };
}

/** the safety net: a change under /api/aip (a start, a calibration, a rewrite, a question to the Operator) never leaves
 *  the page while the demo is open, whichever component sends it */
function guard(orig: typeof fetch): typeof fetch {
  return (input, init) => {
    const req = input instanceof Request ? input : null;
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : String(input), window.location.href);
    if (method !== "GET" && method !== "HEAD" && url.pathname.startsWith("/api/aip/")) return refuse();
    return orig(input, init);
  };
}

let saved: { fraud: typeof fraud; aip: typeof aip; fetch: typeof fetch } | null = null;

/** Open the demo (the page's mount): the calls answered here, the recorded trail fetched while the viewer makes a project.
 *  Returns its close, which puts every call back. */
export function installDemo(o: { sumber?: string | null; laporan?: string | null; kecepatan?: number | null } = {}): () => void {
  if (saved) return () => {};
  const sumber = o.sumber || DEMO_SOURCE;
  if (sumber !== S.sumber) Object.assign(S, { sumber, source: null, ready: false, err: "", projects: [], runs: [] });
  S.laporan = o.laporan || sumber;
  if (o.kecepatan && DEMO_SPEEDS.includes(o.kecepatan)) S.speed = o.kecepatan;
  const orig = { fraud: { ...fraud }, aip: { ...aip } };
  const p = patches(orig);
  saved = { ...orig, fetch: window.fetch };
  Object.assign(fraud, p.fraud);
  Object.assign(aip, p.aip);
  window.fetch = guard(saved.fetch);
  emit();
  load().catch(() => {});
  return () => {
    if (!saved) return;
    Object.assign(fraud, saved.fraud);
    Object.assign(aip, saved.aip);
    window.fetch = saved.fetch;
    saved = null;
    emit();
  };
}

export type DemoSnap = { speed: number; paused: boolean; skip: boolean; ready: boolean; err: string };
let snap: DemoSnap | null = null;
const listeners = new Set<() => void>();
function emit() {
  snap = saved ? { speed: S.speed, paused: S.paused, skip: S.skip, ready: S.ready, err: S.err } : null;
  listeners.forEach((l) => l());
}
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
/** the demo's settings while /swarm-x is open; null elsewhere (and while rendering on the server) */
export function useDemoSwarm(): DemoSnap | null {
  return useSyncExternalStore(subscribe, () => snap, () => null);
}
/** whether /swarm-x is open, read at call time */
export const demoActive = () => !!saved;
/** whether a demo engagement runs: the space bar then pauses its clock, not a chart's replay */
export const demoLive = () => !!saved && S.runs.some((E) => E.run.status === "running");
/** how often a view polls an engagement: in the demo more often, nothing goes over the network */
export const demoPoll = (ms: number) => (saved ? Math.min(ms, 400) : ms);

export const demoSwarm = {
  // a change of speed, pause or idle skipping applies from now: the clock is moved under the old setting first
  setSpeed: (s: number) => { tickAll(); S.speed = s; emit(); },
  togglePause: () => { tickAll(); S.paused = !S.paused; emit(); },
  setSkip: (on: boolean) => { tickAll(); S.skip = on; emit(); },
  /** a new take: no project, no engagement, no report */
  reset: () => { S.projects = []; S.runs = []; S.paused = false; emit(); },
  /** the engagement on the demo's clock (the running one, else the last): its time and how far it is */
  now: (): { nama: string; status: string; detik: number; pct: number } | null => {
    tickAll();
    const E = S.runs.find((x) => x.run.status === "running") ?? S.runs[0];
    if (!E) return null;
    return { nama: String(E.run.nama ?? ""), status: E.run.status, detik: E.run.status === "succeeded" ? E.due : E.clock,
      pct: E.trail.events.length ? E.next / E.trail.events.length : 0 };
  },
};
