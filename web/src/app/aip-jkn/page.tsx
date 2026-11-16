"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { UserMenu } from "@/components/Sidebar";
import { RunView } from "@/components/aip/AipView";
import type { NexusLink } from "@/components/aip/AgentGraph";
import { EvalControlView } from "@/components/aip/EvalControlView";
import { MlStudio } from "@/components/aip/MlStudio";
import { KarantinaView } from "@/components/aip/KarantinaView";
import { AturanView } from "@/components/aip/AturanView";
import { TanggaBukti } from "@/components/aip/TanggaBukti";
import { AksesView } from "@/components/aip/AksesView";
import { SensorEvidenceView } from "@/components/aip/SensorEvidenceView";
import { FaktaKlaimPanel } from "@/components/aip/FaktaKlaimPanel";
import { KonsultanView } from "@/components/aip/KonsultanView";
import { RealtimeFraudView } from "@/components/aip/RealtimeFraudView";
import { SystemArchitectureView } from "@/components/aip/SystemArchitectureView";
import { ApiDocsView } from "@/components/aip/ApiDocsView";
import { SwarmCabangView } from "@/components/aip/SwarmCabangView";
import { ProyekCabang } from "@/components/aip/ProyekCabang";
import { TABS_AIP, type TabAip } from "@/components/aip/tabsAip";
import { Operator, clearOperator, openOperator, useOperatorIds } from "@/components/aip/Operator";
import { VoiceMode } from "@/components/aip/VoiceMode";
import { aip, follow, usd, wib, type Agent, type AipEvent, type Rec, type Run } from "@/components/aip/aipRun";
import { setTampilBiaya, useTampilBiaya } from "@/components/aip/biaya";
import { fraud } from "@/components/aip/fraudApi";

/* AIP JKN: questions over the BPJS Nexus, answered by an orchestrator and the domain agents that own the objects
   (Google ADK, open models on Vertex AI behind the platform's spend guard), next to the connected apps — Object
   Explorer, Data Lineage and Pipeline Builder — each loaded as the viewer, chromeless (?embed=1). */

// the tab bar (its history with it) lives in components/aip/tabsAip.ts, shared with the /swarm-x demo
type Tab = TabAip;
const TABS = TABS_AIP;
export default function AipJknPage() {
  const tampilBiaya = useTampilBiaya();
  // the fraud consultancy is the main tab (the user, 2026-10-24): its engagement is what the chat and the cockpit read
  const [tab, setTab] = useState<Tab>("konsultan");
  // the local instance on port 9310 serves the REAL-sample branch trial (testing/uji_riil.py): its badge says so
  const [riil, setRiil] = useState(false);
  useEffect(() => { setRiil(window.location.port === "9310"); }, []);
  const [cat, setCat] = useState<{ agents: Agent[]; roles: Record<string, string>; apps?: Record<string, string>; links?: NexusLink[];
    aturan?: { rencana?: { id: string; model: string; label: string } } } | null>(null);
  const [catErr, setCatErr] = useState("");
  const [spend, setSpend] = useState<Rec | null>(null);
  // the model spend stays off the main screen (the user, 2026-10-28): a button opens it
  const [biaya, setBiaya] = useState(false);
  // the consultancy's last finished engagement: the chat answers from it, and waits for one (the user, 2026-10-24)
  const [analisis, setAnalisis] = useState<{ ada: boolean; run?: string; pada?: string } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<AipEvent[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState<Tab[]>([]);
  const [voiceOn, setVoiceOn] = useState(false);
  // the AIP Operator beside the other tabs (the Agen tab shows it in full); what it opened in an app: a facility of the
  // box, a type in the Object Explorer, a node of the lineage
  const [dock, setDock] = useState(false);
  const [fokus, setFokus] = useState<string | null>(null);
  const [appTarget, setAppTarget] = useState<{ objects?: string; lineage?: string }>({});
  const opTurns = useOperatorIds();
  // the Pipeline Builder tab shows either pipeline of the BPJS data: Data Mentah → Siap Analisis, or Fakta Klaim
  const [pipa, setPipa] = useState<"utama" | "fakta">("utama");
  // the Box Karantina tab shows the box, or the rules and facts its indications rest on
  const [boks, setBoks] = useState<"box" | "aturan" | "bukti">("box");
  // the last spoken questions and answers, so a spoken follow-up ("dan di Jawa Barat?") keeps its context; a typed
  // follow-up is asked under its answer and carries its conversation on the server
  const history = useRef<{ role: string; text: string }[]>([]);
  const following = useRef<string | null>(null);

  const refresh = useCallback(() => {
    aip.runs().then(setRuns).catch(() => {});
    aip.spend().then(setSpend).catch(() => {});
    fraud.latest().then(setAnalisis).catch(() => {});
  }, []);
  useEffect(() => {
    aip.agents().then(setCat).catch((e) => setCatErr((e as Error).message));
    refresh();
    const m = new URLSearchParams(window.location.search).get("tab");
    const t = (m === "aturan" ? "karantina" : m) as Tab | null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep link to a tab on entry
    if (t && TABS.some(([k]) => k === t)) { setTab(t); setLoaded([t]); if (m === "aturan") setBoks("aturan"); }
  }, [refresh]);
  // the spend in the header follows the ledger while anything runs (an engagement of the consultancy spends for half an
  // hour; the figure read on entry went stale — the user, 2026-10-23: "biayanya ga nambah di total biaya Vertex")
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") aip.spend().then(setSpend).catch(() => {}); }, 20000);
    return () => clearInterval(t);
  }, []);
  // an app is loaded the first time its tab is shown, then kept (hidden) so going back is instant
  const go = (k: Tab) => { setTab(k); setLoaded((l) => (l.includes(k) ? l : [...l, k])); };

  /** follow a run on screen; resolves with its answer text as soon as the answer is out (the executive summary and the
   *  lessons keep streaming in after it, and the next question need not wait for them) */
  const watch = async (id: string): Promise<string> => {
    following.current = id;
    setEvents([]);
    const first = await aip.run(id, 0);
    const all = [...first.events];
    setRun(first.run);
    setEvents(first.events);
    const text = () => String((all.find((e) => e.type === "answer") ?? all.filter((e) => e.type === "draft").at(-1))?.text ?? "");
    if (first.run.status !== "running") return text();
    let answered: (t: string) => void = () => {};
    const early = new Promise<string>((resolve) => { answered = resolve; });
    const done = follow(id, (e) => {
      all.push(e);
      if (following.current === id) setEvents((es) => (e.seq >= es.length ? [...es, e] : es));
      if (e.type === "answer") answered(String(e.text ?? ""));
    }, { current: false }, (r) => { if (following.current === id) setRun(r); }).then((final) => {
      if (following.current === id) setRun(final);
      refresh();
      return text();
    });
    return Promise.race([early, done]);
  };
  /** typed questions wait for the previous run; a spoken one goes at once (the voice mode reports its errors) */
  const ask = async (text?: string, voice = false, follow?: string) => {
    const question = (text ?? q).trim();
    if (!question || (busy && !voice)) return;
    setBusy(true); setErr("");
    try {
      // a typed question here starts a new conversation: the answers of another one are not its context
      const { run: id } = await aip.ask(question, voice ? history.current.slice(-4) : [], voice, follow);
      if (!voice && !follow) setQ("");
      go("agents");
      setRun({ id, status: "running", q: question, spent_usd: 0, created_at: new Date().toISOString(), follow: follow ?? null });
      refresh();
      const answer = await watch(id);
      if (answer && voice) history.current = [...history.current, { role: "user", text: question }, { role: "assistant", text: answer }].slice(-8);
    } catch (e) {
      setErr((e as Error).message);
      if (voice) throw e;
    } finally { setBusy(false); }
  };

  // the runs as conversations, like a chat history: a follow-up joins the conversation of the run it continues, listed
  // once under its first question and opened at its latest turn (the user, 2026-10-24: a follow-up "harusnya di tab yg
  // sama aja … kayak chat history claude atau gpt")
  const chats = useMemo(() => {
    const asks = runs.filter((r) => ["ask", "operator"].includes((r as Rec).kind) || !(r as Rec).kind);
    const byId = new Map(asks.map((r) => [r.id, r]));
    const rootOf = (r: Run) => {
      let x = r;
      for (let i = 0; x.follow && byId.has(x.follow) && i < 50; i++) x = byId.get(x.follow)!;
      return x;
    };
    const groups = new Map<string, { first: Run; turns: Run[] }>();
    asks.forEach((r) => {
      const first = rootOf(r);
      const g = groups.get(first.id) ?? { first, turns: [] };
      g.turns.push(r);
      groups.set(first.id, g);
    });
    return [...groups.values()].map((g) => ({ ...g, last: g.turns.reduce((a, b) => (b.created_at > a.created_at ? b : a)) }))
      .sort((a, b) => (b.last.created_at > a.last.created_at ? 1 : -1));
  }, [runs]);

  const apps = cat?.apps ?? {};
  const appSrc: Partial<Record<Tab, string>> = {
    objects: appTarget.objects ?? "/object-explorer", lineage: appTarget.lineage ?? apps.lineage ?? "/lineage",
    pipeline: (pipa === "fakta" ? apps.pipeline_fakta : apps.pipeline) ?? apps.pipeline ?? "/pipeline",
  };
  const embed = (src: string) => `${src}${src.includes("?") ? "&" : "?"}embed=1`;
  /** the operator opens an app (its buka_aplikasi tool, or a step's chip): that tab, at what it found, the conversation
   *  docked beside it — like Palantir AIP opening the pipeline next to its operator */
  const openApp = useCallback((t: string, target: Rec) => {
    const k = t as Tab;
    if (!TABS.some(([x]) => x === k)) return;
    if (k === "agents") {
      if (target.run) { setDock(false); go("agents"); watch(String(target.run)); }
      return;
    }
    if (k === "karantina") {
      setBoks(target.aturan ? "aturan" : "box");
      // the box focuses a facility once per value: cleared first, so opening the same one again focuses it again
      if (target.faskes) { setFokus(null); setTimeout(() => setFokus(String(target.faskes)), 0); }
    }
    if (k === "pipeline" && target.pipeline) setPipa(target.pipeline === "fakta" ? "fakta" : "utama");
    if (k === "objects" && target.type_id) setAppTarget((a) => ({ ...a, objects: `/object-explorer?type=${encodeURIComponent(String(target.type_id))}` }));
    if (k === "lineage" && target.node_id) {
      const base = apps.lineage ?? "/lineage";
      setAppTarget((a) => ({ ...a, lineage: `${base}${base.includes("?") ? "&" : "?"}node=${encodeURIComponent(String(target.node_id))}` }));
    }
    setDock(true);
    go(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go and watch only set state
  }, [apps.lineage]);
  const openRun = useCallback((id: string) => { setDock(false); go("agents"); watch(id); },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go and watch only set state
    []);
  const cap = spend?.caps?.total_usd;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#2f3c48] text-[#f6f7f9]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-black/40 bg-[#111418] px-3 text-[12px]">
        <span title="Orkestrator + agen domain per objek Nexus · Google ADK · model terbuka (Vertex AI)" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold">
          <Icon name="sparkle" className="h-4 w-4 text-[#9d8cff]" />AIP JKN
        </span>
        {/* AI JKN Synthetic: every number on these tabs comes from the synthetic twin of Data Sampel BPJS (synthetic-gen/) */}
        {riil
          ? <span title="Instans lokal 9310: tab AI Agent Swarm Branch membaca uji coba pada sampel data BPJS asli (pakta integritas, internal). Tab lain tetap data sintetis."
                  className="shrink-0 whitespace-nowrap rounded border border-dashed border-amber-300/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-200">Data riil BPJS · internal</span>
          : <span title="Semua data di aplikasi ini sintetis: dibangkitkan dari pola statistik Data Sampel BPJS 2025 (synthetic-gen/METODOLOGI.md), bukan baris data asli"
                  className="shrink-0 whitespace-nowrap rounded border border-amber-300/40 bg-amber-300/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-200">Data sintetis</span>}
        <nav className="mx-auto flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {TABS.map(([k, label, icon]) => (
            <button key={k} onClick={() => go(k)} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 ${tab === k ? "bg-white/10 text-white" : "text-[#d3d8de] hover:bg-white/5"}`}><Icon name={icon} className="h-3.5 w-3.5" />{label}</button>
          ))}
        </nav>
        {tab !== "agents" && (
          <button onClick={() => setDock(!dock)} title="AIP Operator: tanya dan perintah di atas semua tab, di samping tab ini"
            className={`flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 text-[11.5px] ${dock ? "border-[#9d8cff]/70 bg-[#5b5fd6]/30 text-white" : "border-[#9d8cff]/40 text-[#c7c9ff] hover:bg-[#5b5fd6]/20"}`}
            data-aip-operator-toggle>
            <Icon name="sparkle" className="h-3.5 w-3.5" /><span className="max-xl:hidden">Operator</span>
          </button>
        )}
        {spend && (
          <span className="relative shrink-0">
            <button onClick={() => { if (!biaya) aip.spend().then(setSpend).catch(() => {}); setBiaya(!biaya); }} title="Lihat biaya model"
              className={`rounded p-1 ${biaya ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/10"}`} data-aip-biaya>
              <Icon name="gauge" className="h-3.5 w-3.5" />
            </button>
            {biaya && (<>
              <div className="fixed inset-0 z-40" onClick={() => setBiaya(false)} />
              <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded border border-white/10 bg-[#1c2127] p-3 text-[11.5px] shadow-2xl" data-aip-biaya-panel>
                <div className="mb-2 font-semibold text-white">Biaya model (Vertex AI)</div>
                {([["Hari ini", spend.today?.usd, spend.caps?.daily_usd], ["Bulan ini", spend.month?.usd, spend.caps?.monthly_usd], ["Total", spend.total_usd, cap]] as const).map(([label, v, batas]) => (
                  <div key={label} className="flex justify-between py-0.5">
                    <span className="text-[#abb3bf]">{label}</span>
                    <span className="tabular-nums text-white">{usd(v)}{batas != null ? <span className="text-[#abb3bf]"> / {usd(batas)}</span> : null}</span>
                  </div>
                ))}
                <label className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2 text-[#d3d8de]">
                  <input type="checkbox" checked={tampilBiaya} onChange={(e) => setTampilBiaya(e.target.checked)} data-aip-biaya-tampil />
                  Tampilkan biaya di tiap jawaban dan penugasan
                </label>
                <p className="mt-2 text-[10.5px] leading-snug text-[#abb3bf]">
                  Lewat penjaga biaya platform. {spend.caps?.daily_usd != null || spend.caps?.monthly_usd != null || cap ? "Angka setelah garis miring adalah batasnya." : "Tanpa batas biaya."} Rincian per model tiap penugasan Swarm di Evaluasi Swarm.
                </p>
              </div>
            </>)}
          </span>
        )}
        {tab === "pipeline" && apps.pipeline_fakta && (
          <span title="Dua pipeline data BPJS: data siap analisis, lalu fakta tiap klaim" className="flex shrink-0 gap-0.5 rounded border border-white/10 p-0.5 text-[10.5px]">
            {([["utama", "1 · Siap Analisis"], ["fakta", "2 · Fakta Klaim"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setPipa(k)} className={`whitespace-nowrap rounded px-1.5 py-0.5 ${pipa === k ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{label}</button>
            ))}
          </span>
        )}
        {!["agents", "ml", "konsultan", "realtime", "karantina", "kontrol"].includes(tab) && appSrc[tab] && <a href={appSrc[tab]} target="_blank" rel="noreferrer" title="Buka di tab baru" className="rounded p-1 text-[#abb3bf] hover:bg-white/10"><Icon name="external" className="h-3.5 w-3.5" /></a>}
        {/* AI JKN Audit: the account menu lives here, there is no left panel */}
        <UserMenu />
      </header>

      <div className="relative flex min-h-0 flex-1">
        {tab === "agents" && (
          <>
            <aside className="flex w-[260px] shrink-0 flex-col border-r border-white/[.06] bg-[#1b2128] text-[12px] max-md:hidden">
              <div className="space-y-1.5 border-b border-white/5 p-2">
                <button onClick={() => { clearOperator(); following.current = null; setRun(null); setEvents([]); }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-[#8b7cff] to-[#5b5fd6] py-2 font-medium text-white shadow-[0_2px_10px_rgba(110,96,255,.35)] transition hover:brightness-110">
                  <Icon name="plus" className="h-3.5 w-3.5" />Percakapan baru
                </button>
                {analisis?.ada ? (
                  <button onClick={() => go("konsultan")} title="Hasil penugasan yang dibaca Operator: buka AI Agent Swarm"
                    className="block w-full rounded-sm bg-white/[.04] px-2 py-1 text-left text-[10.5px] leading-snug text-[#abb3bf] hover:bg-white/10">
                    Hasil AI Agent Swarm terakhir<br /><span className="tabular-nums text-[#e5e8eb]">{wib(analisis.pada ?? "")}</span>
                  </button>
                ) : analisis && (
                  <button onClick={() => go("konsultan")} className="block w-full rounded-sm border border-[#fab219]/40 bg-[#fab219]/10 px-2 py-1 text-left text-[10.5px] leading-snug text-[#fbd38d]">
                    Belum ada penugasan AI Agent Swarm yang selesai: Operator tetap membaca tab lainnya.
                  </button>
                )}
                {catErr && <p className="text-[11px] text-red-300">Layanan AIP tidak menjawab: {catErr}</p>}
              </div>
              <p className="px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#7d8894]">Riwayat</p>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {chats.map((c) => {
                  // an Operator conversation reopens in the Operator; an analysis of the agents (the full pipeline) in its own view
                  const op = (c.last as Rec).kind === "operator";
                  const here = op ? !run && c.turns.some((t) => opTurns.includes(t.id)) : c.turns.some((t) => t.id === run?.id || t.id === run?.follow);
                  return (
                    <button key={c.first.id} onClick={() => { if (op) { following.current = null; setRun(null); setEvents([]); openOperator(c.last.id, runs); } else watch(c.last.id); }}
                      className={`mx-1.5 mb-0.5 block w-[calc(100%-12px)] rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[.06] ${here ? "bg-white/[.09] ring-1 ring-white/[.06]" : ""}`}>
                      <p className="line-clamp-2 text-[11.5px] text-[#e5e8eb]">{c.first.q}</p>
                      {c.turns.length > 1 && <p className="truncate text-[10.5px] text-[#abb3bf]"><span className="text-[#8abbff]">↳ </span>{c.last.q}</p>}
                      <p className="mt-0.5 flex items-center gap-1 text-[10px] tabular-nums text-[#8f99a8]">
                        <span className={`shrink-0 rounded-sm px-1 ${op ? "bg-[#5b5fd6]/25 text-[#c7c9ff]" : "bg-white/10 text-[#d3d8de]"}`}>{op ? "Operator" : "Analisis agen"}</span>
                        <span className="truncate">{c.turns.length > 1 ? `${c.turns.length} pertanyaan · ` : ""}{c.last.status === "succeeded" ? "" : `${c.last.status} · `}{tampilBiaya ? `${usd(c.turns.reduce((s, t) => s + (t.spent_usd || 0), 0))} · ` : ""}{wib(c.last.created_at)}</span>
                      </p>
                    </button>
                  );
                })}
              </div>
              {voiceOn && <VoiceMode run={run} events={events} ask={(text) => ask(text, true)} onClose={() => setVoiceOn(false)} />}
              {err && <p className="px-2 py-1 text-[11px] text-red-300">{err}</p>}
              <button onClick={() => setVoiceOn((v) => !v)} title="Mode suara: bicara dengan orkestrator dan agen domain, jawaban dibacakan"
                className={`flex items-center gap-1.5 border-t border-white/5 px-2 py-1.5 text-left text-[11px] ${voiceOn ? "text-white" : "text-[#abb3bf] hover:text-white"}`}>
                <Icon name="wave" className="h-3.5 w-3.5" />Mode suara (analisis agen)
              </button>
            </aside>
            {run ? (
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-2 border-b border-white/5 bg-[#1c2127] px-3 py-1.5 text-[11.5px]">
                  <button onClick={() => { following.current = null; setRun(null); setEvents([]); }} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[#8abbff] hover:bg-white/5 hover:text-white">
                    <Icon name="left" className="h-3 w-3" />Percakapan Operator
                  </button>
                  <span className="text-[#8f99a8]">Analisis agen: orkestrator, agen domain, validator</span>
                </div>
                <RunView run={run} events={events} agents={cat?.agents ?? []} roles={cat?.roles} links={cat?.links}
                  onFollow={busy ? undefined : (text) => ask(text, false, run.id)} />
              </div>
            ) : (
              <Operator mode="full" tab="agents" onNav={openApp} onOpenRun={openRun} onDone={refresh} />
            )}
          </>
        )}
        {tab === "ml" && <MlStudio embed={embed} />}
        {tab === "arsitektur" && <SystemArchitectureView />}
        {tab === "apidocs" && <ApiDocsView />}
        {/* the branch tab's projects on the left (as AI Agent Swarm's), the report beside them (2026-11-14) */}
        {tab === "cabang" && <ProyekCabang><SwarmCabangView /></ProyekCabang>}
        {tab === "konsultan" && <KonsultanView />}
        {tab === "realtime" && <RealtimeFraudView onBox={(faskes) => { setBoks("box"); setFokus(null); if (faskes) setTimeout(() => setFokus(faskes), 0); go("karantina"); }} />}
        {tab === "karantina" && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 gap-1 border-b border-white/5 bg-[#1c2127] px-3 py-1.5 text-[11.5px]">
              {([["box", "Box Karantina"], ["aturan", "Aturan Indikasi"], ["bukti", "Tangga bukti & pilot audit"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setBoks(k)} className={`rounded px-2 py-0.5 ${boks === k ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{label}</button>
              ))}
            </div>
            {boks === "box" ? <KarantinaView fokus={fokus} /> : boks === "aturan" ? <AturanView />
              : <div className="min-h-0 flex-1 overflow-y-auto p-3"><TanggaBukti /></div>}
          </div>
        )}
        {tab === "kontrol" && <EvalControlView />}
        {tab === "akses" && <AksesView />}
        {tab === "sensor" && <SensorEvidenceView />}
        {(["objects", "lineage", "pipeline"] as Tab[]).filter((k) => loaded.includes(k) || k === tab).map((k) => k === "pipeline" ? (
          // pipeline 2 (Fakta Klaim): what it computes on every claim, above its canvas
          <div key={`${k}-${pipa}`} className={tab === k ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
            {pipa === "fakta" && <FaktaKlaimPanel onRules={() => { setBoks("aturan"); go("karantina"); }} />}
            <iframe src={embed(appSrc[k]!)} title={k} className="min-h-0 w-full flex-1 border-0" />
          </div>
        ) : (
          <iframe key={k} src={embed(appSrc[k]!)} title={k} className={tab === k ? "h-full w-full flex-1 border-0" : "hidden"} />
        ))}
        {dock && tab !== "agents" && (
          <Operator mode="dock" tab={tab} onNav={openApp} onOpenRun={openRun} onDone={refresh} onClose={() => setDock(false)}
            onExpand={() => { setDock(false); go("agents"); }} />
        )}
      </div>
    </div>
  );
}
