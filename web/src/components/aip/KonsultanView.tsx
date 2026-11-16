"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/aip/Briefing";
import { aip, modelName, txt, usd, wib, type AipEvent, type Rec, type Run } from "@/components/aip/aipRun";
import { useTampilBiaya } from "@/components/aip/biaya";
import { fraud, REVIEWED, STRENGTH, VERSI_BADGE, type FirmAgent, type FirmConfig, type Project, type Sizing, type Team } from "@/components/aip/fraudApi";
import { ProjectFormDialog, ProjectHome, StartForm, usdLimit } from "@/components/aip/ProyekKonsultan";
import { ContractCard, HandoffBlock, Lessons, ScrutinyCard, type Contract } from "@/components/aip/KonsepRun";
import { AnatomiPenugasan } from "@/components/aip/AnatomiPenugasan";
import { LaporanLengkap } from "@/components/aip/LaporanLengkap";
import { KonfigurasiAgen } from "@/components/aip/KonfigurasiAgen";
import { demoActive, demoPoll, useDemoSwarm } from "@/components/aip/demoSwarm";

// the animation of the agents at work, loaded with this tab (it imports LINI from here: a static import would be a cycle)
const AnimasiAgen = dynamic(() => import("@/components/aip/AnimasiAgen").then((m) => m.AnimasiAgen), { ssr: false });

/* AI Agent Swarm (Konsultan Fraud AIP until 2026-10-24): the system's own agents work one engagement on the real JKN data (api/aip/konsultan.py,
   adk_runtime/firm.py) — the orchestrator as partner, each domain agent leading its small agents, the validator with QA
   and the red team. The org chart is drawn from the run's own roster and lights up as the agents work; the validation
   contract, the scrutiny of every milestone, the handoffs and the lessons show the orchestration concept at work; every
   tag streams in with its strength and marking; the orchestrator's report closes the engagement. */

export const LINI: Record<string, { label: string; color: string }> = {
  pimpinan: { label: "Pimpinan", color: "#9d8cff" }, wilayah: { label: "Wilayah", color: "#3987e5" }, modus: { label: "Modus (Permenkes 16/2019)", color: "#d95926" },
  peer: { label: "Peer kelas faskes", color: "#199e70" }, ml: { label: "Teknik ML", color: "#c98500" }, kasus: { label: "Kasus & karantina", color: "#d55181" },
  qa: { label: "QA & red team", color: "#8f99a8" },
  laporan: { label: "Redaksi laporan", color: "#008300" },  // the report desk (aip/konsultan.py report_team)
  telaah: { label: "Decision examination", color: "#c084fc" },  // Blu 1.3's examiners (api/aip/telaah.py team)
};
const ORDER = ["wilayah", "modus", "peer", "ml", "kasus", "qa", "laporan"];
const STATUS_RING: Record<string, string> = { antre: "#4b5563", bekerja: "#b8a9ff", selesai: "#29a383", gagal: "#e5484d" };
const EARLIER = "awal";  // the project the engagements from before projects belong to
const LAST_VIEW = "aip.swarm.terakhir";  // the project and engagement the viewer was on (per browser)
const SUBTABS = [["laporan", "Laporan"], ["jejak", "Jejak kerja"], ["indikasi", "Indikasi & rekomendasi"], ["biaya", "Biaya & token"]] as const;

type AgentState = { status?: string; ms?: number; calls?: number; tags?: number; laporan?: string; target?: Rec };

function useEngagement(id: string | null) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<AipEvent[]>([]);
  const stop = useRef({ current: false });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new engagement (or none: a project before its first) starts empty
    setEvents([]); setRun(null);
    if (!id) return;
    const halt = { current: false };
    stop.current = halt;
    aip.run(id, 0).then(async (first) => {
      if (halt.current) return;
      setRun(first.run);
      setEvents(first.events);
      if (first.run.status === "running") {
        let after = first.next;
        for (;;) {
          await new Promise((r) => setTimeout(r, demoPoll(1500)));
          if (halt.current) return;
          const r = await aip.run(id, after).catch(() => null);
          if (!r) continue;
          after = r.next;
          if (r.events.length) setEvents((es) => [...es, ...r.events]);
          setRun(r.run);
          if (r.run.status !== "running") return;
        }
      }
    }).catch(() => {});
    return () => { halt.current = true; };
  }, [id]);
  return { run, events };
}

export function KonsultanView() {
  const tampilBiaya = useTampilBiaya();
  // /swarm-x (demoSwarm.ts): the tab as a tutorial, a recorded engagement replayed; its replays of the simulation and its
  // report rewrite are not offered there
  const demo = !!useDemoSwarm();
  const [team, setTeam] = useState<Team | null>(null);
  const [list, setList] = useState<Rec[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  // the firm chart is the animation of its agents (the user, 2026-10-24: one view): at rest on the engagement's end state,
  // live while it runs; "Putar Sistem AI Swarm" (was "Putar animasi" until 2026-10-29) replays it here
  const [playKey, setPlayKey] = useState(0);
  // "Simulasi Blu 1.1" (the user, 2026-10-30: "kenapa gaada tab simulasi"): the project's own view of its engagement as Blu
  // 1.1, an animation only, no model called (AnimasiAgen simulasi)
  const [simView, setSimView] = useState(false);
  // the sub-tab chosen for an engagement; another engagement opens on its own default (its report, or its work trail)
  const [sub, setSub] = useState<{ run: string | null; tab: string } | null>(null);
  const chart = useRef<HTMLDivElement>(null);
  // projects (the user, 2026-10-24: "Create new project", its own tab, then "Mulai penugasan baru" inside it): each holds its
  // brief and IT settings; the engagements from before projects sit in one project of their own
  const [projects, setProjects] = useState<Project[]>([]);
  const chosen = useRef(false);
  const [cfg, setCfg] = useState<FirmConfig | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [form, setForm] = useState<{ project: Project | null } | null>(null);
  const [konf, setKonf] = useState(false);  // Konfigurasi agen: every agent's algorithm, tools, prompt and settings
  const [dropProject, setDropProject] = useState<string | null>(null);
  const pidOf = (r: Rec, ps: Project[] = projects) => (ps.some((p) => p.id === r.proyek) ? String(r.proyek) : EARLIER);
  useEffect(() => {
    fraud.team().then(setTeam).catch((e) => setErr((e as Error).message));
    fraud.config().then(setCfg).catch((e) => setErr((e as Error).message));
    Promise.all([fraud.engagements(), fraud.projects().catch(() => [] as Project[])]).then(([l, ps]) => {
      setList(l); setProjects(ps);
      // the latest engagement opens only when the viewer has not opened one meanwhile (in development the first load
      // runs twice, and the second answer used to take the viewer back to the running engagement)
      if (chosen.current) return;
      // where the viewer was (the user, 2026-10-30: coming back from another tab opened the latest engagement's project — a
      // cancelled run of an old project — not the project they were on); first visit: the project made last
      const exists = (pid: string) => (pid === EARLIER ? l.some((r) => pidOf(r, ps) === EARLIER) : ps.some((p) => p.id === pid));
      let last: { proyek?: string; run?: string | null; sim?: boolean } | null = null;
      // (the tutorial starts empty and never stores where its viewer was)
      try { last = demoActive() ? null : JSON.parse(localStorage.getItem(LAST_VIEW) ?? "null"); } catch { last = null; }
      if (last?.proyek && exists(last.proyek)) {
        const run = last.run && l.some((r) => r.id === last?.run && pidOf(r, ps) === last?.proyek) ? last.run : null;
        setTabs([last.proyek]); setActive(last.proyek); setSel(run); setSimView(!run && !!last.sim);
        return;
      }
      const pid = ps[0]?.id ?? (l[0] ? pidOf(l[0], ps) : null);  // (the API lists projects newest first)
      if (pid) { setTabs([pid]); setActive(pid); setSel(l.find((r) => pidOf(r, ps) === pid)?.id ?? null); }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on open
  // the view to come back to after another tab
  useEffect(() => {
    if (!active || demoActive()) return;
    try { localStorage.setItem(LAST_VIEW, JSON.stringify({ proyek: active, run: sel, sim: simView })); } catch { /* storage blocked */ }
  }, [active, sel, simView]);
  const all: Project[] = useMemo(() => [...projects, ...(list.some((r) => pidOf(r) === EARLIER) ? [{
    id: EARLIER, nama: "Audit nasional FKRTL 2025", brief: team?.brief ?? "", fokus: "", batas_usd: null, paralel: cfg?.paralel.default ?? 8, model: {}, virtual: true,
  }] : [])], [projects, list, team, cfg]); // eslint-disable-line react-hooks/exhaustive-deps -- pidOf reads projects, listed
  const project = all.find((p) => p.id === active) ?? null;
  const runsOf = (pid: string) => list.filter((r) => pidOf(r) === pid);
  const anyRunning = list.some((r) => r.status === "running");
  const open = (pid: string) => {
    setSimView(false);
    chosen.current = true;
    setTabs((t) => (t.includes(pid) ? t : [...t, pid]));
    setActive(pid);
    setSel(runsOf(pid)[0]?.id ?? null);
    setFocus(null);
  };
  const closeTab = (pid: string) => {
    const rest = tabs.filter((x) => x !== pid);
    setTabs(rest);
    if (active === pid) {
      const next = rest.at(-1) ?? null;
      setActive(next);
      setSel(next ? runsOf(next)[0]?.id ?? null : null);
    }
  };
  const saved = (p: Project) => {
    setProjects((ps) => (ps.some((x) => x.id === p.id) ? ps.map((x) => (x.id === p.id ? p : x)) : [p, ...ps]));
    setForm(null);
    if (!form?.project) { setTabs((t) => [...t.filter((x) => x !== p.id), p.id]); setActive(p.id); setSel(null); setFocus(null); }
  };
  const removeProject = async (pid: string) => {
    setBusy(true); setDropErr("");
    try {
      await fraud.deleteProject(pid);
      setProjects((ps) => ps.filter((p) => p.id !== pid));
      setList((l) => l.filter((r) => r.proyek !== pid));
      closeTab(pid);
      setDropProject(null);
    } catch (e) { setDropErr((e as Error).message); } finally { setBusy(false); }
  };
  const { run, events } = useEngagement(sel);
  // the list follows the open engagement to its end (it said "running" until the tab was opened again, and "Mulai penugasan
  // baru" stayed off)
  useEffect(() => {
    if (!run) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the row of the engagement the view follows
    setList((l) => l.map((r) => (r.id === run.id && r.status !== run.status ? { ...r, status: run.status, spent_usd: run.spent_usd, finished_at: run.finished_at } : r)));
  }, [run?.id, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps -- once per change of state
  const start = async (f: { nama: string; fokus: string; versi: string }) => {
    if (!project) return;
    setBusy(true); setErr("");
    try {
      const r = await fraud.startEngagement({ nama: f.nama, fokus: f.fokus, proyek: project.virtual ? null : project.id, versi: f.versi });
      setList((l) => [{ id: r.run, status: "running", created_at: new Date().toISOString(), nama: f.nama, proyek: project.virtual ? null : project.id, versi: f.versi }, ...l]);
      setSel(r.run);
      setAsk(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  // a wrong engagement off the list, after a confirm on its row
  const [drop, setDrop] = useState<string | null>(null);
  const [dropErr, setDropErr] = useState("");
  const remove = async (id: string) => {
    setBusy(true); setDropErr("");
    try {
      await fraud.deleteEngagement(id);
      const rest = list.filter((r) => r.id !== id);
      setList(rest);
      if (sel === id) setSel(rest.find((r) => pidOf(r) === active)?.id ?? null);  // the project's next, or its home
      setDrop(null);
    } catch (e) { setDropErr((e as Error).message); } finally { setBusy(false); }
  };
  // a confirm step on the page (an engagement is about an hour and some dollars of model calls; a click alone started one
  // by accident), and a stop for one that runs: the work its agents finished stays in the trail
  const [ask, setAsk] = useState<"mulai" | "henti" | null>(null);
  const last = list.find((r) => r.status === "succeeded" && !r.ulang_laporan);
  const stop = async () => {
    if (!sel) return;
    setBusy(true); setErr("");
    try {
      await aip.cancel(sel);
      setList((l) => l.map((r) => (r.id === sel ? { ...r, status: "cancelled" } : r)));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setAsk(null); }
  };
  // the report of this engagement written anew (outline first): a new run, its phases 0–5 copied from this one's trail
  const rewrite = async () => {
    if (!sel) return;
    setBusy(true); setErr("");
    try {
      const r = await fraud.rewriteReport(sel);
      setList((l) => [{ id: r.run, status: "running", created_at: new Date().toISOString(), q: "tulis ulang laporan" }, ...l]);
      setSel(r.run);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // what the run's events say
  const firm = events.find((e) => e.type === "firm");
  // a role (investigator, red team) is one entry; the engagement forms its instances, one per case of its queue
  const formed = useMemo(() => events.filter((e) => e.type === "instances").flatMap((e) => (e.agents ?? []) as FirmAgent[]), [events]);
  const roster: FirmAgent[] = useMemo(() => [...((firm?.tim as FirmAgent[] | undefined) ?? team?.tim ?? []), ...formed], [firm, team, formed]);
  const sizing: Sizing[] = (firm?.ukuran as Sizing[] | undefined) ?? team?.ukuran ?? [];
  const states = useMemo(() => {
    const s: Record<string, AgentState> = {};
    for (const e of events) {
      if (e.type === "agent_status") s[e.agent] = { ...s[e.agent], status: e.status, ...(e.ms != null ? { ms: e.ms, calls: e.calls, tags: e.tags, laporan: e.laporan } : {}) };
      if (e.type === "assign") s[e.agent] = { ...s[e.agent], target: e.target };
    }
    return s;
  }, [events]);
  const phases = useMemo(() => {
    const p: Record<string, { status: string; t0?: string; t1?: string; extra?: Rec }> = {};
    for (const e of events.filter((x) => x.type === "phase")) {
      p[e.phase] = { ...p[e.phase], status: e.status, ...(e.status === "mulai" ? { t0: e.t } : { t1: e.t, extra: e }) };
    }
    return p;
  }, [events]);
  const tags = events.filter((e) => e.type === "tag");
  // Blu 1.1 / 1.3 (api/aip/telaah.py): its clinical review is drawn in the firm's animation (AnimasiAgen), with its own phase
  const blu11 = REVIEWED.includes(String(firm?.versi)) || REVIEWED.includes(String(run?.versi)) || events.some((e) => e.type === "telaah");
  const verdicts = events.filter((e) => e.type === "verdict" && e.validator !== "scrutiny");
  const scrutinies = events.filter((e) => e.type === "verdict" && e.validator === "scrutiny");
  const finalVerdict = verdicts.filter((v) => v.validator === "validator" || v.validator === "validator_laporan").at(-1);
  const reds = events.filter((e) => e.type === "red_team");
  const recs = events.filter((e) => e.type === "rekomendasi");
  const report = events.filter((e) => e.type === "engagement").at(-1) ?? null;
  const draft = events.filter((e) => e.type === "draft").at(-1)?.text as string | undefined;
  const plan = events.find((e) => e.type === "engagement_plan")?.plan as Rec | undefined;
  const copied = events.find((e) => e.type === "salinan");
  const outline = events.filter((e) => e.type === "kerangka").at(-1);
  const written = useMemo(() => {
    const s: Record<string, AipEvent> = {};
    for (const e of events) if (e.type === "bagian") s[e.id] = e;
    return s;
  }, [events]);
  const tagCount = tags.reduce((n, t) => n + (t.jumlah ?? 1), 0);
  const done = Object.values(states).filter((s) => s.status === "selesai" || s.status === "gagal").length;
  const working = Object.values(states).filter((s) => s.status === "bekerja").length;
  const usage = (run?.agents_usage ?? {}) as Record<string, { usd: number; calls: number }>;
  const tab = sub && sub.run === sel ? sub.tab : report ? "laporan" : "jejak";
  const copiedNote = copied && <p className="mb-3 rounded bg-white/[.04] px-2 py-1 text-[11px] text-[#c5cbd3]">Laporan ditulis ulang dari penugasan <b>{String(copied.sumber)}</b>: fase {(copied.fase as string[] ?? []).join(", ")} disalin dari jejaknya (tidak dijalankan ulang; tidak ada tag, box atau rekomendasi yang ditulis dua kali) — hanya fase laporan yang baru.</p>;
  // the orchestrator's report as it wrote it: the draft while it writes, the fallback of the long report
  const orchestratorReport = (report || draft) ? (
    <section className="rounded border border-white/10 bg-[#1c2127] p-4">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[13px] font-semibold text-white">Laporan orkestrator{report ? "" : " (draf)"}</p>
        {[finalVerdict].filter(Boolean).map((v) => v && (
          <span key={v.seq} className={`rounded-full px-2 py-0.5 text-[10.5px] ${v.passed === v.total ? "bg-[#29a383]/20 text-[#7ee2c0]" : "bg-[#fab219]/15 text-[#fbd38d]"}`} title="validator dari keluarga model lain, dengan bacaan data sendiri">validator {v.passed}/{v.total}</span>
        ))}
      </div>
      {report?.statistik && <p className="mb-2 text-[11px] text-[#8f99a8]">{Object.entries(report.statistik as Rec).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</p>}
      {copiedNote}
      <Markdown text={String(report?.laporan ?? draft ?? "")} />
    </section>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden text-[12px]">
      {form && <ProjectFormDialog cfg={cfg} team={team} project={form.project} onSaved={saved} onClose={() => setForm(null)} />}
      {konf && <KonfigurasiAgen lini={LINI} onClose={() => setKonf(false)} />}
      {ask === "mulai" && project && (
        <StartForm cfg={cfg} project={project} count={runsOf(project.id).length} agents={team?.jumlah_agen} last={last} busy={busy} err={err}
          onStart={start} onClose={() => { setAsk(null); setErr(""); }} />
      )}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-black/30 bg-[#1c2127] max-lg:hidden">
        <div className="space-y-2 border-b border-white/5 p-3">
          <p className="text-[13px] font-semibold text-white">AI Agent Swarm</p>
          <p className="line-clamp-4 text-[11px] leading-snug text-[#abb3bf]">Agen-agen sistem yang sama bekerja satu penugasan di data JKN nyata: orkestrator sebagai partner, tiap agen domain memimpin agen kecilnya (analis per provinsi, spesialis modus, penyidik box karantina, sub-agen teknik ML), validator dengan QA dan red team. Kontrak validasi ditulis sebelum kerja; tiap fase ditutup validator kode.</p>
          <button disabled={!cfg} onClick={() => setForm({ project: null })} title={cfg ? undefined : "memuat konfigurasi…"}
            className="flex w-full items-center justify-center gap-1 rounded-sm bg-[#5b5fd6] py-1.5 font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name="plus" className="h-3 w-3" />Buat proyek baru
          </button>
          {err && ask !== "mulai" && <p className="text-[11px] text-red-300">{err}</p>}
        </div>
        <p className="px-3 pt-2 font-semibold text-[#e5e8eb]">Proyek</p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {all.map((p) => {
            const rs = runsOf(p.id);
            const on = active === p.id;
            return (
              <div key={p.id} className="border-b border-white/5">
                <div className={`group relative ${on ? "bg-white/[.05]" : "hover:bg-white/5"}`}>
                  <button onClick={() => open(p.id)} className="flex w-full items-start gap-2 px-3 py-2 pr-8 text-left">
                    <Icon name="project" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${on ? "text-[#9d8cff]" : "text-[#8f99a8]"}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium text-white">{p.nama}</span>
                      <span className="block text-[10.5px] text-[#8f99a8]">{rs.length ? `${rs.length} penugasan · terbaru ${rs[0].status}` : "belum ada penugasan"}</span>
                    </span>
                  </button>
                  {!p.virtual && dropProject !== p.id && !rs.some((r) => r.status === "running") && (
                    <button onClick={() => { setDropProject(p.id); setDropErr(""); }} title="hapus proyek ini" aria-label="Hapus proyek"
                      className="absolute right-2 top-2 rounded p-1 text-[#8f99a8] opacity-0 hover:bg-white/10 hover:text-[#ffb4b4] focus:opacity-100 group-hover:opacity-100">
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {dropProject === p.id && (
                  <Confirm busy={busy} err={dropErr} onYes={() => removeProject(p.id)} onNo={() => setDropProject(null)}
                    text={`Hapus proyek ini${rs.length ? ` beserta ${rs.length} penugasannya` : ""}? Jejak penugasan dipindah ke arsip terhapus (admin bisa memulihkan); tag dan Box Karantina tetap.`} />
                )}
                {on && rs.length > 0 && (
                  <button onClick={() => { setSel(null); setSimView(false); setFocus(null); }}
                    className={`flex w-full items-center gap-1.5 py-1 pl-8 text-left text-[11px] ${sel || simView ? "text-[#8f99a8] hover:text-white" : "bg-white/[.08] text-white"}`}>
                    <Icon name="home" className="h-3 w-3" />Beranda proyek
                  </button>
                )}
                {on && !demo && rs.some((r) => r.status === "succeeded" && !r.ulang_laporan) && (
                  <button onClick={() => { setSimView(true); setFocus(null); }} title="penugasan proyek ini sebagai Blu 1.1, animasi saja: tanpa panggilan model, tanpa biaya"
                    className={`flex w-full items-center gap-1.5 py-1 pl-8 text-left text-[11px] ${simView ? "bg-white/[.08] text-white" : "text-[#d8b4fe] hover:text-white"}`}>
                    <Icon name="sparkle" className="h-3 w-3" />Simulasi Blu 1.1
                  </button>
                )}
                {on && rs.map((r) => (
                  <div key={r.id} className={`group relative ${sel === r.id ? "bg-white/[.08]" : "hover:bg-white/5"}`}>
                    <button onClick={() => { chosen.current = true; setSel(r.id); setSimView(false); setFocus(null); }} className="block w-full py-1.5 pl-8 pr-8 text-left">
                      {r.nama && <p className="truncate text-[11.5px] font-medium text-white">{String(r.nama)}</p>}
                      <span className={`mr-1 inline-block rounded px-1 text-[9.5px] font-semibold ${VERSI_BADGE[String(r.versi)]?.[1] ?? VERSI_BADGE["1.0"][1]}`}
                        title={VERSI_BADGE[String(r.versi)]?.[0] ?? VERSI_BADGE["1.0"][0]}>
                        Blu {VERSI_BADGE[String(r.versi)] ? String(r.versi) : "1.0"}</span>
                      <p className={r.nama ? "text-[10.5px] text-[#c5cbd3]" : "text-[11.5px] text-[#e5e8eb]"}>{wib(r.created_at)}</p>
                      <p className="text-[10px] tabular-nums text-[#8f99a8]">{r.status}{tampilBiaya ? <> · {usd(r.spent_usd)}{r.budget_usd ? ` / batas ${usdLimit(r.budget_usd)}` : ""}</> : null}</p>
                      {r.ulang_laporan && <p className="text-[10px] text-[#c9c0ff]">tulis ulang laporan · {r.kerangka === false ? "sekali jalan (pembanding)" : "kerangka dulu"}</p>}
                    </button>
                    {r.status !== "running" && drop !== r.id && (
                      <button onClick={() => { setDrop(r.id); setDropErr(""); }} title="hapus penugasan ini dari daftar" aria-label="Hapus penugasan"
                        className="absolute right-2 top-1.5 rounded p-1 text-[#8f99a8] opacity-0 hover:bg-white/10 hover:text-[#ffb4b4] focus:opacity-100 group-hover:opacity-100">
                        <Icon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {drop === r.id && (
                      <Confirm busy={busy} err={dropErr} onYes={() => remove(r.id)} onNo={() => setDrop(null)}
                        text="Hapus penugasan ini dari daftar? Jejak dan laporannya dipindah ke arsip terhapus (admin bisa memulihkan); tag dan Box Karantina tetap." />
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {!all.length && <p className="px-3 py-2 text-[11px] text-[#8f99a8]">Belum ada proyek.</p>}
        </div>
        {sizing.length > 0 && (
          <details className="border-t border-white/5 px-3 py-2">
            <summary className="cursor-pointer font-semibold text-[#e5e8eb]">Ukuran firma: {roster.filter((a) => !a.instans_dari).length} agen
              {formed.length > 0 && <span className="font-normal text-[#8f99a8]"> + {formed.length} instans dinamis</span>}</summary>
            <div className="mt-1.5 max-h-[260px] overflow-y-auto">
              {sizing.map((s) => (
                <div key={s.lini} className="mb-1.5" title={s.alasan}>
                  <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: LINI[s.lini]?.color }} /><span className="text-[#d3d8de]">{LINI[s.lini]?.label ?? s.lini}</span><span className="ml-auto tabular-nums text-white">{s.agen}</span></div>
                  <p className="line-clamp-2 pl-3.5 text-[10.5px] text-[#8f99a8]">{s.alasan}</p>
                </div>
              ))}
            </div>
          </details>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* the open projects as tabs, as a workspace opens its resources */}
        <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-white/10 bg-[#15181d] px-2 pt-1.5">
          {tabs.map((pid) => {
            const p = all.find((x) => x.id === pid);
            if (!p) return null;
            const live = runsOf(pid).some((r) => r.status === "running");
            return (
              <div key={pid} className={`flex max-w-[240px] shrink-0 items-center gap-1 rounded-t border border-b-0 pl-2.5 pr-1 ${active === pid ? "border-white/10 bg-[#1c2127] text-white" : "border-transparent text-[#abb3bf] hover:bg-white/5"}`}>
                <button onClick={() => open(pid)} className="flex min-w-0 items-center gap-1.5 py-1.5 text-[11.5px]">
                  <Icon name="project" className={`h-3 w-3 shrink-0 ${active === pid ? "text-[#9d8cff]" : ""}`} />
                  <span className="truncate">{p.nama}</span>
                  {live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#b8a9ff]" title="penugasan sedang berjalan" />}
                </button>
                <button onClick={() => closeTab(pid)} aria-label={`Tutup tab ${p.nama}`} className="rounded p-0.5 text-[#8f99a8] hover:bg-white/10 hover:text-white">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <button disabled={!cfg} onClick={() => setForm({ project: null })} title="Buat proyek baru" aria-label="Buat proyek baru"
            className="mb-1 ml-1 shrink-0 rounded p-1 text-[#abb3bf] hover:bg-white/10 hover:text-white disabled:opacity-40"><Icon name="plus" className="h-3.5 w-3.5" /></button>
          {project && (
            <div className="mb-1 ml-auto flex shrink-0 items-center gap-1.5 pl-3">
              <button onClick={() => setKonf(true)} title="Algoritma, model, tool, prompt dan setelan tiap agen; berlaku untuk penugasan berikutnya"
                className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/5">
                <Icon name="sliders" className="h-3 w-3" />Konfigurasi agen
              </button>
              {!project.virtual && (
                <button onClick={() => setForm({ project })} className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/5">
                  <Icon name="edit" className="h-3 w-3" />Ubah proyek
                </button>
              )}
              {sel && (
                <button disabled={busy || anyRunning} onClick={() => setAsk("mulai")} title={anyRunning ? "satu penugasan sedang berjalan" : undefined}
                  className="flex items-center gap-1 rounded bg-[#5b5fd6] px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
                  <Icon name="play" className="h-3 w-3" />Mulai penugasan baru
                </button>
              )}
            </div>
          )}
        </div>
        {simView && project ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="flex items-center gap-2 border-b border-white/5 bg-[#1c2127] px-4 py-2">
              <Icon name="sparkle" className="h-3.5 w-3.5 text-[#c084fc]" />
              <p className="text-[13px] font-semibold text-white">Simulasi Blu 1.1</p>
              <span className="text-[11px] text-[#abb3bf]">animasi saja · tanpa panggilan model</span>
            </div>
            <div className="mx-3 mt-3 flex shrink-0 flex-col overflow-hidden rounded border border-white/10">
              <AnimasiAgen key={`sim-${project.id}`} embedded simulasi proyek={project.virtual ? null : project.id} />
            </div>
          </div>
        ) : !sel ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <ProjectHome cfg={cfg} project={project} count={project ? runsOf(project.id).length : 0} busy={busy} running={anyRunning}
              onStart={() => { setErr(""); setAsk("mulai"); }} onCreate={() => setForm({ project: null })}
              onEdit={project && !project.virtual ? () => setForm({ project }) : undefined} />
          </div>
        ) : (
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-white/5 bg-[#1c2127] px-4 py-2">
          <Kpi label="agen & instans" value={`${done}/${roster.filter((a) => a.jenjang !== "peran" || !formed.some((x) => x.instans_dari === a.key)).length}`}
            hint={working ? `${working} bekerja` : run?.status ?? ""} />
          <Kpi label="tag oleh agen" value={tagCount.toLocaleString("id-ID")} />
          <Kpi label="red team" value={String(reds.length)} />
          <Kpi label="rekomendasi jalur" value={String(recs.length)} />
          {tampilBiaya && <Kpi label="biaya model" value={usd(run?.spent_usd)} />}
          {run?.status === "running" && (ask === "henti" ? (
            <span className="flex items-center gap-1 rounded border border-[#e5484d]/50 bg-[#e5484d]/10 px-2 py-0.5 text-[11px] text-[#ffb4b4]">
              Hentikan? Kerja yang sudah selesai tetap tersimpan.
              <button disabled={busy} onClick={stop} className="rounded bg-[#e5484d] px-1.5 py-0.5 font-medium text-white hover:brightness-110 disabled:opacity-40">Ya, hentikan</button>
              <button onClick={() => setAsk(null)} className="rounded border border-white/15 px-1.5 py-0.5 text-[#d3d8de] hover:bg-white/10">Batal</button>
            </span>
          ) : (
            <button onClick={() => setAsk("henti")} className="flex items-center gap-1 rounded border border-[#e5484d]/50 px-2 py-0.5 text-[11px] text-[#ffb4b4] hover:bg-[#e5484d]/10">
              <Icon name="x" className="h-3 w-3" />Hentikan penugasan
            </button>
          ))}
          {sel && <button onClick={() => { setPlayKey((k) => k + 1); chart.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }}
            title="putar ulang penugasan ini di bagan firma: agen menyala saat bekerja, log interaksi, alur indikasi → keputusan"
            className="flex items-center gap-1 rounded border border-[#9d8cff]/50 px-2 py-0.5 text-[11px] text-[#c9c0ff] hover:bg-[#9d8cff]/10"><Icon name="play" className="h-3 w-3" />Putar Sistem AI Swarm</button>}
          {sel && !demo && <button onClick={() => { setSimView(true); setFocus(null); }}
            title="putar penugasan proyek ini sebagai Blu 1.1, animasi saja: fase telaah klinis diproyeksikan dari kalibrasi, fase berikutnya jejak nyata penugasan terakhir — tanpa panggilan model, tanpa biaya"
            className="flex items-center gap-1 rounded border border-[#c084fc]/50 px-2 py-0.5 text-[11px] text-[#e9d5ff] hover:bg-[#c084fc]/10"><Icon name="sparkle" className="h-3 w-3" />Simulasi Blu 1.1</button>}
          {sel && !demo && run?.status === "succeeded" && (
            <button disabled={busy} onClick={rewrite} title="laporan penugasan ini ditulis ulang (kerangka dulu, lalu tiap bagian dari sumbernya): fase 0–5 disalin dari jejaknya, tidak dijalankan ulang; admin"
              className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/5 disabled:opacity-40"><Icon name="sparkle" className="h-3 w-3" />Tulis ulang laporan</button>
          )}
          <div className="ml-auto flex flex-wrap gap-1">
            {[...(blu11 ? ["telaah"] : []), "penugasan", "lapangan", "karantina", "investigasi", "sintesis", "qa", "laporan", "redaksi"].map((p) => {
              const st = phases[p]?.status;
              return <span key={p} className={`rounded-full border px-2 py-0.5 text-[10.5px] ${st === "selesai" ? "border-[#29a383]/50 text-[#7ee2c0]" : st === "mulai" ? "border-[#b8a9ff] text-white" : "border-white/10 text-[#8f99a8]"}`}>{p === "telaah" ? "clinical examination" : p}</span>;
            })}
          </div>
        </div>

        {sel && (
          <div ref={chart} className="mx-3 mt-3 flex shrink-0 scroll-mt-3 flex-col overflow-hidden rounded border border-white/10">
            <AnimasiAgen key={sel} initialRun={sel} embedded playKey={playKey} proyek={project && !project.virtual ? project.id : null} onAgent={setFocus} />
          </div>
        )}
        {focus && <div className="mx-3 mt-3"><AgentPanel agent={roster.find((a) => a.key === focus)} state={states[focus]} events={events} usage={usage[focus]} onClose={() => setFocus(null)} /></div>}
        {/* below the chart, one thing at a time (the user, 2026-10-24: "UI nya ga enak banget"): the report first once there is
            one, then the work trail, the indications and recommendations, the cost */}
        <div className="mx-3 mt-3 flex flex-wrap items-end gap-1 border-b border-white/10" role="tablist">
          {SUBTABS.map(([k, label]) => {
            const n = k === "indikasi" ? tagCount + recs.length : k === "jejak" ? scrutinies.length + verdicts.length : 0;
            return (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setSub({ run: sel, tab: k })}
                className={`-mb-px rounded-t border-x border-t px-3 py-1.5 text-[12px] ${tab === k ? "border-white/10 bg-[#1c2127] font-medium text-white" : "border-transparent text-[#abb3bf] hover:text-white"}`}>
                {label}{n ? <span className="ml-1.5 rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums text-[#c5cbd3]">{n.toLocaleString("id-ID")}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="p-3">
          {tab === "laporan" && (report && run?.status === "succeeded" && sel ? (
            <>{copiedNote}<LaporanLengkap key={sel} run={sel} verdict={finalVerdict} fallback={orchestratorReport} /></>
          ) : orchestratorReport ?? (
            <p className="py-10 text-center text-[#8f99a8]">Laporan ditulis di fase terakhir penugasan: kerangka dulu, lalu tiap bagian dari sumbernya, diperiksa validator. Sementara itu, lihat Jejak kerja dan Indikasi.</p>
          ))}
          {tab === "jejak" && (
            <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
              <div className="min-w-0 space-y-3">
            {plan && (
              <section className="rounded border border-white/10 bg-[#1c2127] p-3">
                <p className="mb-1 font-semibold text-white">Rencana orkestrator</p>
                <p className="text-[#d3d8de]">{txt(plan.ringkasan)}</p>
                <p className="mt-1 text-[10.5px] font-medium uppercase tracking-wide text-[#8f99a8]">Hipotesis global (konteks nasional)</p>
                <ul className="mt-0.5 list-disc pl-5 text-[#abb3bf]">{(Array.isArray(plan.hipotesis) ? plan.hipotesis : []).map((h: Rec, i: number) => <li key={i}><b className="text-[#d3d8de]">{txt(h?.id)}</b> {txt(h?.teks ?? h)}</li>)}</ul>
                {Array.isArray(plan.penemuan_regional) && plan.penemuan_regional.length > 0 && (
                  <>
                    <p className="mt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[#8f99a8]">Penemuan regional (dijawab mandiri tiap analis wilayah)</p>
                    <ul className="mt-0.5 list-disc pl-5 text-[#abb3bf]">{plan.penemuan_regional.map((q: unknown, i: number) => <li key={i}>{txt((q as Rec)?.teks ?? q)}</li>)}</ul>
                  </>
                )}
                <ContractCard contract={(plan.kontrak ?? []) as Contract} judged={finalVerdict?.kontrak as Contract | undefined} />
              </section>
            )}
            {scrutinies.length > 0 && (
              <section className="space-y-1.5 rounded border border-white/10 bg-[#1c2127] p-3">
                <p className="font-semibold text-white">Validator scrutiny tiap milestone</p>
                <p className="text-[10.5px] text-[#8f99a8]">Kode, bukan model: dijalankan di akhir setiap fase atas apa yang ditinggalkan fase itu di shared state.</p>
                {scrutinies.map((e) => <ScrutinyCard key={e.seq} ev={e} />)}
              </section>
            )}
            {outline && <section className="rounded border border-white/10 bg-[#1c2127] p-3"><OutlineCard ev={outline} written={written} /></section>}
            {verdicts.some((v) => v.lini) && (
              <section className="rounded border border-white/10 bg-[#1c2127] p-3">
                <p className="mb-1 font-semibold text-white">QA lintas keluarga model</p>
                {verdicts.filter((v) => v.lini).map((v) => (
                  <details key={v.seq} className="border-t border-white/5 py-1">
                    <summary className="cursor-pointer text-[#d3d8de]">{v.sintesis ?? LINI[v.lini]?.label ?? v.lini}: {v.passed}/{v.total} klaim bertahan <span className="text-[#8f99a8]">({modelName(v.model)})</span></summary>
                    <ul className="mt-1 space-y-1 pl-3">{(v.checks ?? []).map((c: Rec, i: number) => <li key={i} className={c.ok ? "text-[#7ee2c0]" : "text-[#ffb4b4]"}>{c.ok ? "✓" : "✗"} {txt(c.klaim)} <span className="text-[#8f99a8]">— {txt(c.bukti)}</span></li>)}</ul>
                  </details>
                ))}
              </section>
            )}
            {report && orchestratorReport && (
              <details className="rounded border border-white/10 bg-[#1c2127] p-3">
                <summary className="cursor-pointer font-semibold text-white">Teks laporan orkestrator (asli)</summary>
                <div className="mt-2">{orchestratorReport}</div>
              </details>
            )}
            {!plan && !scrutinies.length && !outline && <p className="py-6 text-center text-[#8f99a8]">Rencana, kontrak validasi dan scrutiny muncul saat penugasan berjalan.</p>}
              </div>
              <div className="space-y-3"><Lessons events={events} /></div>
            </div>
          )}
          {tab === "indikasi" && (
            <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded border border-white/10 bg-[#1c2127] p-3">
              <p className="mb-1 font-semibold text-white">Tag masuk (langsung)</p>
              <p className="mb-2 text-[10.5px] text-[#8f99a8]">Setiap indikasi, sekecil apa pun, ditandai dengan bukti dari hasil yang dibaca agen itu sendiri. Kekuatan dihitung dari sumbernya; marking Rahasia untuk yang kuat.</p>
              <div className="max-h-[640px] space-y-1 overflow-y-auto">
                {tags.slice(-80).reverse().map((t) => (
                  <div key={t.seq} className="rounded bg-white/[.03] px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STRENGTH[t.kekuatan ?? t.kekuatan_agen] ?? "#8f99a8" }} />
                      <span className="truncate font-medium text-[#e5e8eb]">{t.tag}</span>
                      {t.klasifikasi && <span className={`ml-auto shrink-0 rounded px-1 text-[9.5px] ${t.klasifikasi === "Rahasia" ? "bg-[#e5484d]/20 text-[#ffb4b4]" : "bg-[#fab219]/15 text-[#fbd38d]"}`}>{t.klasifikasi}</span>}
                    </div>
                    <p className="truncate text-[10.5px] text-[#abb3bf]">{t.bulk ? `${t.jumlah} ${t.entitas} · ${t.judul}` : t.judul}</p>
                    <p className="truncate text-[10px] text-[#8f99a8]">{roster.find((a) => a.key === t.agent)?.name ?? t.agent}{t.dukungan ? ` · ${t.dukungan} sumber` : ""}</p>
                  </div>
                ))}
                {!tags.length && <p className="text-[#8f99a8]">Belum ada tag di penugasan ini.</p>}
              </div>
            </section>
              <div className="space-y-3">
            {reds.length > 0 && (
              <section className="rounded border border-white/10 bg-[#1c2127] p-3">
                <p className="mb-1 font-semibold text-white">Red team</p>
                {reds.map((r) => <p key={r.seq} className="border-t border-white/5 py-1 text-[11px]"><span className={r.hasil === "bertahan" ? "text-[#ffb4b4]" : "text-[#7ee2c0]"}>{r.hasil}</span> · {r.tag} · <span className="text-[#d3d8de]">{r.judul}</span> → {r.kekuatan}</p>)}
              </section>
            )}
            {recs.length > 0 && (
              <section className="rounded border border-white/10 bg-[#1c2127] p-3">
                <p className="mb-1 font-semibold text-white">Rekomendasi jalur audit</p>
                {recs.map((r) => (
                  <div key={r.seq} className="border-t border-white/5 py-1 text-[11px]">
                    <p className="text-[#e5e8eb]">[{r.kelompok}] {r.nama}</p>
                    <p><span className={r.jalur === "ditindak" ? "text-[#ffb4b4]" : r.jalur === "dibebaskan" ? "text-[#7ee2c0]" : "text-[#fbd38d]"}>{r.jalur}</span> · T {r.tsm?.terstruktur} · S {r.tsm?.sistematis} · M {r.tsm?.masif}</p>
                  </div>
                ))}
              </section>
            )}
            {!reds.length && !recs.length && <p className="py-6 text-center text-[#8f99a8]">Red team dan rekomendasi jalur muncul di fase investigasi dan sintesis.</p>}
              </div>
            </div>
          )}
          {tab === "biaya" && run && <RunCost run={run} />}
          {tab === "biaya" && (run && Object.keys(usage).length > 0
            ? <AnatomiPenugasan run={run} events={events} roster={roster} inReport={!!report} />
            : <p className="py-6 text-center text-[#8f99a8]">Belum ada panggilan model di penugasan ini.</p>)}
        </div>
      </div>
        )}
      </div>
    </div>
  );
}

/** A delete asked once more on its row; a refusal (a run that is still going, a missing right) shows where it was asked. */
function Confirm({ text, busy, err, onYes, onNo }: { text: string; busy: boolean; err: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="mx-2 mb-2 rounded-sm border border-[#e5484d]/50 bg-[#e5484d]/10 p-2 text-[10.5px] leading-snug text-[#ffb4b4]">
      <p>{text}</p>
      <div className="mt-1.5 flex gap-1">
        <button disabled={busy} onClick={onYes} className="flex-1 rounded-sm bg-[#e5484d] py-0.5 font-medium text-white hover:brightness-110 disabled:opacity-40">{busy ? "Menghapus…" : "Ya, hapus"}</button>
        <button onClick={onNo} className="flex-1 rounded-sm border border-white/15 py-0.5 text-[#d3d8de] hover:bg-white/10">Batal</button>
      </div>
      {err && <p className="mt-1.5 rounded-sm bg-black/30 px-1.5 py-1 text-[#ffd0d0]">Gagal menghapus: {err}</p>}
    </div>
  );
}

/** The engagement's total cost, on the Biaya & token tab (the cost stays off the main screen; the user, 2026-10-28). */
function RunCost({ run }: { run: Run }) {
  const use = Object.values((run.agents_usage ?? {}) as Record<string, { prompt?: number; output?: number; calls?: number }>);
  const tokens = use.reduce((s, u) => s + (u.prompt ?? 0) + (u.output ?? 0), 0);
  const calls = use.reduce((s, u) => s + (u.calls ?? 0), 0);
  const budget = Number((run as Rec).budget_usd) || 0;
  return (
    <div className="mb-3 flex flex-wrap items-end gap-x-8 gap-y-2 rounded border border-white/10 bg-[#1c2127] px-4 py-3" data-run-biaya>
      <div>
        <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#d95926]">Total biaya run ini</p>
        <p className="mt-0.5 text-[22px] font-semibold tabular-nums text-white">{usd(run.spent_usd ?? 0)}</p>
      </div>
      {budget > 0 && <Kpi label="batas biaya" value={usdLimit(budget)} hint={`${Math.round((100 * (run.spent_usd ?? 0)) / budget)}% terpakai`} />}
      <Kpi label="token" value={tokens.toLocaleString("id-ID")} />
      <Kpi label="panggilan model" value={calls.toLocaleString("id-ID")} />
      {run.status === "running" && <p className="text-[11px] text-[#8f99a8]">penugasan masih berjalan: angkanya terus bertambah</p>}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div><p className="text-[16px] font-semibold tabular-nums text-white">{value}</p><p className="text-[10.5px] text-[#8f99a8]">{label}{hint ? ` · ${hint}` : ""}</p></div>;
}

/** The firm as a tree: the orchestrator, a column per agent that leads (each domain agent, the validator), its small agents
    beneath in rows coloured by kind of work; rings show each agent's state. Older rosters (a manager per line) draw the same way. */
export function OrgChart({ roster, states, focus, onFocus, machines }: { roster: FirmAgent[]; states: Record<string, AgentState>; focus: string | null;
  onFocus: (k: string) => void; machines: AipEvent[] }) {
  const W = 1180, COLS = 7, GAP = 24;
  const lines = ORDER.filter((l) => roster.some((a) => a.lini === l));
  const leads = roster.filter((a) => a.jenjang === "manajer");
  const colW = W / Math.max(leads.length, 1);
  const pos: Record<string, { x: number; y: number; r: number }> = {};
  const partner = roster.find((a) => a.jenjang === "partner");
  if (partner) pos[partner.key] = { x: W / 2, y: 42, r: 17 };
  let maxY = 160;
  leads.forEach((lead, i) => {
    const cx = colW * i + colW / 2;
    pos[lead.key] = { x: cx, y: 128, r: 12 };
    const started = new Set(roster.filter((a) => a.instans_dari).map((a) => a.instans_dari));
    const team = roster.filter((a) => a.induk === lead.key && (a.jenjang === "analis" || (a.jenjang === "peran" && !started.has(a.key))));
    const cols = Math.min(COLS, team.length);
    team.forEach((a, j) => {
      const row = Math.floor(j / COLS), col = j % COLS;
      const y = 190 + row * GAP;
      pos[a.key] = { x: cx + (col - (cols - 1) / 2) * GAP, y, r: 7.5 };
      maxY = Math.max(maxY, y + 20);
    });
  });
  const mstate: Record<string, string> = {};
  machines.forEach((m) => { mstate[m.key] = m.status; });
  const MACH = [["penanda_otomatis", "Penanda otomatis"], ["konsensus_ml", "Konsensus ML"], ["karantina", "Box karantina"], ["sinkron_nexus", "Nexus"]];
  return (
    <section className="rounded border border-white/10 bg-[#161a1f] p-2">
      <svg viewBox={`0 0 ${W} ${maxY + 10}`} className="w-full" role="img" aria-label="Bagan firma konsultan">
        {roster.filter((a) => a.induk && pos[a.key] && pos[a.induk]).map((a) => {
          const p = pos[a.key], q = pos[a.induk!];
          return <line key={`e-${a.key}`} x1={q.x} y1={q.y + q.r} x2={p.x} y2={p.y - p.r} stroke={LINI[a.lini]?.color ?? "#555"} strokeOpacity={a.jenjang === "manajer" ? 0.5 : 0.18} strokeWidth={a.jenjang === "manajer" ? 1.5 : 1} />;
        })}
        {MACH.map(([k, label], i) => {
          const x = 70 + i * 120, st = mstate[k];
          return (
            <g key={k} transform={`translate(${x},36)`}>
              <rect x={-9} y={-9} width={18} height={18} transform="rotate(45)" fill="#232a33" stroke={st === "selesai" ? "#29a383" : st === "bekerja" ? "#b8a9ff" : st === "gagal" ? "#e5484d" : "#4b5563"} strokeWidth={2} />
              <text y={26} textAnchor="middle" className="fill-[#8f99a8] text-[10px]">{label}</text>
            </g>
          );
        })}
        {roster.filter((a) => pos[a.key]).map((a) => {
          const p = pos[a.key], s = states[a.key] ?? {}, color = LINI[a.lini]?.color ?? "#888";
          const ring = STATUS_RING[s.status ?? ""] ?? "#2a3038";
          return (
            <g key={a.key} transform={`translate(${p.x},${p.y})`} onClick={() => onFocus(a.key)} className="cursor-pointer">
              <title>{`${a.name}\n${a.peran}\n${modelName(a.model)} · ${s.status ?? "menunggu"}${s.tags ? ` · ${s.tags} tag` : ""}`}</title>
              {s.status === "bekerja" && <circle r={p.r + 5} fill="none" stroke="#b8a9ff" strokeOpacity={0.5}><animate attributeName="r" values={`${p.r + 2};${p.r + 7};${p.r + 2}`} dur="1.6s" repeatCount="indefinite" /></circle>}
              <circle r={p.r} fill={color} fillOpacity={s.status === "selesai" ? 0.95 : s.status ? 0.55 : 0.25} stroke={focus === a.key ? "#fff" : ring} strokeWidth={focus === a.key ? 2.5 : 2}
                strokeDasharray={a.jenjang === "peran" ? "3 2" : undefined} />
              {a.jenjang === "peran" && <text y={3} textAnchor="middle" className="pointer-events-none fill-white text-[7px] font-semibold">×{String(a.target?.kapasitas ?? "")}</text>}
              {a.jenjang !== "analis" && <text y={p.r + 13} textAnchor="middle" className="fill-[#d3d8de] text-[10.5px]">{a.name.replace("Manajer ", "").replace(" Pengelola", "").replace("Orkestrator · Partner", "Orkestrator").replace(/^Agen /, "")}</text>}
              {!!s.tags && a.jenjang === "analis" && <text y={3} textAnchor="middle" className="pointer-events-none fill-white text-[7px] font-semibold">{s.tags > 99 ? "99+" : s.tags}</text>}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-3 px-2 pb-1 text-[10.5px] text-[#8f99a8]">
        {lines.map((l) => <span key={l} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: LINI[l].color }} />{LINI[l].label}</span>)}
        <span>· cincin: <span className="text-[#b8a9ff]">bekerja</span> / <span className="text-[#29a383]">selesai</span> / <span className="text-[#e5484d]">gagal</span> · angka = tag oleh agen · klik agen untuk laporannya</span>
      </div>
    </section>
  );
}

// the report's outline (adk_runtime/firm.py outline): each section's points with their sources, what code dropped and
// why, and how far each section's writer is — the report below is these sections joined by code
function OutlineCard({ ev, written }: { ev: AipEvent; written: Record<string, AipEvent> }) {
  const parts = (ev.bagian ?? []) as { id: string; judul: string; poin: { klaim: string; sumber: string[] }[] }[];
  const dropped = (ev.dibuang ?? []) as { bagian: string; klaim: string; alasan: string }[];
  const points = parts.reduce((n, s) => n + s.poin.length, 0);
  return (
    <details className="mb-3 rounded border border-white/10 bg-black/20 p-2">
      <summary className="cursor-pointer text-[11.5px] text-[#d3d8de]">Kerangka laporan: {parts.length} bagian, {points} poin bersumber
        {dropped.length > 0 && <span className="text-[#fbd38d]"> · {dropped.length} poin dibuang kode</span>}
        <span className="text-[#8f99a8]"> — tiap bagian ditulis hanya dari sumber poinnya, lalu digabung kode</span></summary>
      <div className="mt-2 space-y-2">
        {parts.map((s) => {
          const w = written[s.id];
          return (
            <div key={s.id}>
              <p className="text-[11.5px] font-semibold text-white">{s.judul}
                <span className={`ml-2 text-[10.5px] font-normal ${w?.status === "selesai" ? "text-[#7ee2c0]" : w?.status === "gagal" ? "text-[#ffb4b4]" : "text-[#8f99a8]"}`}>
                  {w ? `${w.status}${w.revisi ? " (revisi)" : ""}${(w.dibuang ?? []).length ? ` · ${w.dibuang.length} kalimat dibuang kode (angka tak terlacak)` : ""}` : s.poin.length ? "menunggu" : "tanpa poin"}</span></p>
              <ul className="mt-0.5 space-y-0.5 pl-3">{s.poin.map((p, i) => (
                <li key={i} className="text-[11px] leading-snug text-[#c5cbd3]">{p.klaim} <span className="text-[#8f99a8]">{p.sumber.length ? `[${p.sumber.join(", ")}]` : "(tanpa sumber)"}</span></li>
              ))}</ul>
            </div>
          );
        })}
        {dropped.length > 0 && (
          <div className="border-t border-white/5 pt-1.5">
            <p className="text-[11px] font-semibold text-[#fbd38d]">Dibuang kode</p>
            <ul className="space-y-0.5 pl-3">{dropped.map((d, i) => <li key={i} className="text-[11px] text-[#abb3bf]">{d.bagian}: {d.klaim} <span className="text-[#8f99a8]">— {d.alasan}</span></li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}

function AgentPanel({ agent, state, events, usage, onClose }: { agent?: FirmAgent; state?: AgentState; events: AipEvent[]; usage?: { usd: number; calls: number }; onClose: () => void }) {
  const tampilBiaya = useTampilBiaya();
  if (!agent) return null;
  const steps = events.filter((e) => e.type === "tool" && e.agent === agent.key);
  const handoff = events.filter((e) => e.type === "handoff" && e.agent === agent.key).at(-1)?.handoff as Rec | undefined;
  const mine = events.filter((e) => e.type === "tag" && e.agent === agent.key);
  return (
    <section className="rounded border border-[#b8a9ff]/30 bg-[#1c2127] p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-white">{agent.name}</p>
          <p className="text-[11px] text-[#abb3bf]">{agent.peran} · {modelName(agent.model)} · {state?.status ?? "menunggu"}{state?.ms ? ` · ${(state.ms / 1000).toFixed(0)} s` : ""}{usage ? ` · ${tampilBiaya ? `${usd(usage.usd)}, ` : ""}${usage.calls} panggilan model` : ""}</p>
          {state?.target && <p className="text-[11px] text-[#8f99a8]">Sasaran: {JSON.stringify(state.target).slice(0, 220)}</p>}
        </div>
        <button onClick={onClose} className="ml-auto rounded p-1 text-[#8f99a8] hover:bg-white/10"><Icon name="x" className="h-3.5 w-3.5" /></button>
      </div>
      {state?.laporan && <div className="mt-2 rounded bg-black/20 p-2"><Markdown text={state.laporan} /></div>}
      {handoff && <div className="mt-2 rounded border border-white/5 bg-black/20"><HandoffBlock h={handoff} /></div>}
      {steps.length > 0 && (
        <details className="mt-2"><summary className="cursor-pointer text-[#d3d8de]">{steps.length} langkah tool</summary>
          <ul className="mt-1 space-y-0.5">{steps.map((s) => <li key={s.seq} className={s.ok ? "text-[#abb3bf]" : "text-[#ffb4b4]"}><b className="text-[#d3d8de]">{s.tool}</b> {s.summary} <span className="text-[#6b7480]">{s.ms} ms{s.rid ? ` · ${s.rid}` : ""}</span></li>)}</ul>
        </details>
      )}
      {mine.length > 0 && <p className="mt-1 text-[11px] text-[#8f99a8]">{mine.reduce((n, t) => n + (t.jumlah ?? 1), 0)} tag: {[...new Set(mine.map((t) => t.tag))].join(", ")}</p>}
    </section>
  );
}
