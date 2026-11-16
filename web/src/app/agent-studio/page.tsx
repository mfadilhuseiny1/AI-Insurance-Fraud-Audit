"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { ACTIONS, AGENTS, FILES, FUNCTIONS, LOGICS, OBJECT_TYPES, SUGGESTIONS, byId, neighbors, type ObjType } from "./data";
import { AgentLogicPanel } from "./AgentLogicPanel";
import { OpsBoard } from "./OpsBoard";
import { PipelineWorkspace } from "./PipelineWorkspace";
import { AI_NODES, INITIAL_EDGES, INITIAL_NODES, type PEdge, type PNode } from "./pipelineData";

type Msg = { role: "user" | "agent"; text: string; objects?: string[]; plan?: string[] };
type Log = { label: string; state: "run" | "done" | "wait" };
const TOP = [
  { label: "Data Lineage", href: "/lineage", icon: "split" as const, badge: "1" },
  { label: "Pipeline Builder", href: "/pipeline", icon: "pipeline" as const, badge: "1" },
  { label: "AIP Logic", href: "/logic", icon: "logic" as const, badge: "1" },
  { label: "Functions", href: "/functions", icon: "code" as const, badge: "" },
  { label: "Workshop", href: "/pln-cockpit", icon: "device" as const, badge: "2" },
];

export default function AgentStudioPage() {
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [selectedId, setSelectedId] = useState("outage");
  const [tab, setTab] = useState<"visual" | "objects" | "lineage">("visual");
  const [mode, setMode] = useState<"ontology" | "pipeline" | "ops" | "logic">("ontology");
  const [pNodes, setPNodes] = useState<PNode[]>(INITIAL_NODES);
  const [pEdges, setPEdges] = useState<PEdge[]>(INITIAL_EDGES);
  const [proposalState, setProposalState] = useState("Saved");
  const [detailOpen, setDetailOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(true);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  useEffect(() => {
    // Fit at 100% zoom: fold the platform sidebar to its icon rail (existing platform mechanism)
    window.dispatchEvent(new Event("bluesandai:sidebar-rail"));
    const m = new URLSearchParams(window.location.search).get("mode");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link mode from the URL on entry
    if (m === "pipeline" || m === "ops" || m === "logic" || m === "ontology") setMode(m);
    if (window.innerWidth < 1500) setLeftCollapsed(true);
  }, []);
  const [leftOpen, setLeftOpen] = useState<Record<string, boolean>>({ types: true, agents: true, actions: false, logic: false, files: false });
  const [agentId, setAgentId] = useState("ops");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [planDone, setPlanDone] = useState<number>(-1);
  const [toast, setToast] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "agent", text: "I can investigate live outages across the ontology. I found 1 active high-priority outage on feeder FDR-12 affecting 342 customers, with a recent drone inspection already linked.", objects: ["outage", "drone"] },
  ]);
  const [logs, setLogs] = useState<Log[]>([
    { label: "Ontology indexed · 14 object types · 121k objects", state: "done" },
    { label: "Pipelines healthy · outage-detection 2 min ago", state: "done" },
  ]);
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setLoading(false), 800); return () => clearTimeout(t); }, []);
  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, logs]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t); }, [toast]);

  const selected = byId(selectedId);
  const near = useMemo(() => neighbors(selectedId), [selectedId]);
  const groups = ["All", ...Array.from(new Set(OBJECT_TYPES.map((o) => o.group)))];
  const filtered = OBJECT_TYPES.filter((o) => (group === "All" || o.group === group) && o.name.toLowerCase().includes(query.toLowerCase()));
  const agent = AGENTS.find((a) => a.id === agentId)!;

  const pick = (id: string) => { setSelectedId(id); setDetailOpen(true); };
  const act = (name: string) => { setToast(`${name} — staged on ${selected.name}. Review in Ontology Manager before applying.`); setLogs((l) => [...l, { label: `${name} staged on ${selected.instances[0]?.id ?? selected.name}`, state: "done" }]); };

  const ask = (raw?: string) => {
    const q = (raw ?? input).trim(); if (!q || busy) return;
    setInput(""); setBusy(true); setPlanDone(-1);
    setMsgs((m) => [...m, { role: "user", text: q }]);
    const steps = ["Searching ontology for relevant objects", "Traversing links · outage → feeder → assets → crews", "Checking Pipeline Builder freshness and Data Lineage", "Running AIP Logic · Outage Root-Cause Analysis", "Drafting work plan with Functions estimateRestorationTime()"];
    setLogs((l) => [...l, ...steps.map((label) => ({ label, state: "wait" as const }))]);
    steps.forEach((_, i) => setTimeout(() => setLogs((l) => l.map((x, j) => j === l.length - steps.length + i ? { ...x, state: i === steps.length - 1 ? "done" : "done" } : x)), 450 * (i + 1)));
    setTimeout(() => {
      setMsgs((m) => [...m, {
        role: "agent",
        text: `Investigation complete for ${selected.name}. OUT-8841 on FDR-12 is most likely vegetation encroachment at span 47 (drone inspection INS-3092, confidence 0.93). 342 customers are affected; estimated restoration is 2h 10m. Crew Alpha-3 is drone-certified and 25 minutes away.`,
        objects: ["outage", "drone", "crew", "feeder"],
        plan: ["Dispatch Crew Alpha-3 to span 47 with vegetation kit", "Attach INS-3092 footage to work order WO-55210", "Notify 342 affected customers via Automate", "Re-run Drone Defect Triage after repair and close OUT-8841"],
      }]);
      setBusy(false);
    }, 450 * steps.length + 500);
  };
  const runPlan = (plan: string[]) => { plan.forEach((_, i) => setTimeout(() => setPlanDone(i), 600 * (i + 1))); setLogs((l) => [...l, { label: "Work plan execution started from Agent Studio", state: "done" }]); };
  const notify = (m: string) => { setToast(m); setLogs((l) => [...l, { label: m, state: "done" }]); };
  const aiGeneratePipeline = () => {
    setMode("pipeline");
    const steps = ["Builder · Create pipeline branch for Power Outage", "Search · Found datasets Video Source A, Video Source B, Metadata, Quality, Tags, Thumbnails", "Builder · Add datasets to Power Outage pipeline", "Builder · Add 1 object target · Aerial Photography", "Builder · Adding drone footage datasets and creating target Aerial Photography Object", "Builder · Generate 7 transforms", "Builder · Create pipeline proposal for Power Outage — review before deploying"];
    setLogs((l) => [...l, ...steps.map((label) => ({ label, state: "done" as const }))]);
    setPNodes((ns) => [...ns.filter((n) => !n.proposed), ...AI_NODES]);
    setPEdges((es) => [...es.filter((e) => !(e.from === "aiJoin" || e.to === "aiJoin" || e.from === "aiDefect")), { from: "join2", to: "aiJoin" }, { from: "aiJoin", to: "aiDefect" }, { from: "aiDefect", to: "aerial" }]);
    setProposalState("Draft proposal");
    setMsgs((m) => [...m, { role: "agent", text: "I generated 2 proposed pipeline nodes (dashed violet) on branch “Add Drone Footage”: a drone↔outage join and a defect-detection function feeding Aerial Photography. Review them in Pipeline Builder → Proposals. Nothing is deployed until you approve and deploy.", objects: ["outage", "drone"] }]);
    setToast("AI transforms generated — review in Proposals before deploying.");
  };

  if (loading) return (
    <div className="flex flex-1 items-center justify-center bg-[#0b0f16] text-[#c3ccda]">
      <div className="text-center"><div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[#2a3647] border-t-violet-400" /><p className="mt-4 text-[13px]">Loading AIP Agent Studio…</p><p className="mt-1 text-[11px] text-[#8391a7]">Indexing ontology · pipelines · agents</p></div>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#0b0f16] text-[#e8edf5]">
      {/* near-black top navigation */}
      <header className="flex h-11 shrink-0 items-center gap-1 overflow-hidden border-b border-[#1d2735] bg-[#070a0f] px-2.5 text-[12px]">
        <button onClick={() => setLeftCollapsed(!leftCollapsed)} title={leftCollapsed ? "Show Explore sidebar" : "Hide Explore sidebar"} className="shrink-0 rounded border border-[#2a3647] px-2 py-1.5 text-[11px] text-[#c3ccda] hover:bg-[#121a27]">{leftCollapsed ? "☰ Explore" : "☰"}</button>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold text-[13px]"><span className="flex h-6 w-6 items-center justify-center rounded bg-violet-600 text-white"><Icon name="sparkle" className="h-3.5 w-3.5" /></span><span className="max-[1400px]:hidden">AIP Agent Studio</span><span className="min-[1401px]:hidden">Agent Studio</span></span>
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TOP.map((t) => <Link key={t.label} href={t.href} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1.5 text-[#c3ccda] hover:bg-[#121a27] hover:text-white"><Icon name={t.icon} className="h-3.5 w-3.5 text-[#8391a7]" />{t.label}{t.badge && <span className="rounded bg-[#2a3647] px-1 text-[9px] text-[#c3ccda]">{t.badge}</span>}</Link>)}
        </nav>
        <div className="ml-2 hidden shrink-0 rounded border border-[#2a3647] p-0.5 lg:flex">
          {([["ontology", "Ontology"], ["pipeline", "Pipeline"], ["ops", "GRID Cockpit"], ["logic", "AIP Logic"]] as const).map(([k, l]) => <button key={k} onClick={() => setMode(k)} className={`whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium ${mode === k ? "bg-violet-600 text-white" : "text-[#8391a7] hover:text-white"}`}>{l}</button>)}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 whitespace-nowrap rounded border border-[#2a3647] px-2 py-1 text-[11px] text-[#8391a7] min-[1500px]:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live · Main ontology</span>
          <button onClick={() => setAiOpen(!aiOpen)} className={`whitespace-nowrap rounded px-2.5 py-1.5 font-medium ${aiOpen ? "bg-violet-600 text-white" : "border border-[#2a3647] text-[#c3ccda] hover:bg-[#121a27]"}`}>AI Agent</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* persistent left sidebar */}
        <aside className={`w-[208px] shrink-0 flex-col overflow-y-auto border-r border-[#1d2735] bg-[#0d131d] ${leftCollapsed ? "hidden" : "hidden md:flex"}`}>
          <div className="border-b border-[#1d2735] p-2.5">
            <label className="flex items-center gap-2 rounded border border-[#2a3647] bg-[#070b12] px-2 py-1.5"><Icon name="search" className="h-3.5 w-3.5 text-[#8391a7]" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search object types…" className="w-full bg-transparent text-[12px] outline-none placeholder:text-[#8391a7]" /></label>
            <div className="mt-2 flex flex-wrap gap-1">{groups.map((g) => <button key={g} onClick={() => setGroup(g)} className={`rounded px-2 py-0.5 text-[11px] ${group === g ? "bg-violet-600/20 text-violet-200 ring-1 ring-violet-400/40" : "bg-[#121a27] text-[#8391a7] hover:text-white"}`}>{g}</button>)}</div>
          </div>
          <div className="border-b border-[#1d2735] px-2.5 py-2">
            <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-[#8391a7]">Active objects · PLN Grid</p>
            <div className="mt-1 space-y-0.5">{OBJECT_TYPES.slice(0, 8).map((o) => <button key={o.id} onClick={() => { pick(o.id); setMode("ontology"); }} className="flex w-full items-center gap-2 rounded px-1.5 py-[3px] text-left text-[11.5px] text-[#c3ccda] hover:bg-[#121a27]"><span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: o.color }} /><span className="truncate">[Power Grid] {o.name}</span></button>)}</div>
          </div>
          <Section title="Object Types" sub="All integrated object types in the ontology" open={leftOpen.types} onToggle={() => setLeftOpen((s) => ({ ...s, types: !s.types }))}>
            {filtered.length === 0 && <p className="px-2 py-2 text-[11px] text-[#8391a7]">No object types match “{query}”.</p>}
            {filtered.map((o) => <button key={o.id} onClick={() => pick(o.id)} className={`flex w-full items-center gap-2 rounded px-2 py-[5px] text-left text-[12px] ${o.id === selectedId ? "bg-violet-600/15 text-white ring-1 ring-inset ring-violet-400/30" : "text-[#c3ccda] hover:bg-[#121a27]"}`}><span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: o.color }} /><span className="min-w-0 flex-1 truncate">{o.name}</span><span className="text-[10px] tabular-nums text-[#8391a7]">{o.count.toLocaleString()}</span></button>)}
          </Section>
          <Section title="AI Agents" sub="AI-powered agents taking action using the ontology" open={leftOpen.agents} onToggle={() => setLeftOpen((s) => ({ ...s, agents: !s.agents }))}>
            {AGENTS.map((a) => <button key={a.id} onClick={() => { setAgentId(a.id); setAiOpen(true); }} className={`block w-full rounded px-2 py-[5px] text-left ${a.id === agentId ? "bg-[#121a27] ring-1 ring-inset ring-[#2a3647]" : "hover:bg-[#121a27]"}`}><span className="flex items-center gap-1.5 text-[12px] text-white"><span className={`h-1.5 w-1.5 rounded-full ${a.online ? "bg-emerald-400" : "bg-[#8391a7]"}`} />{a.name}</span><span className="mt-0.5 block text-[11px] leading-snug text-[#8391a7]">{a.desc}</span></button>)}
            <Link href="/agents" className="mt-1 block px-2 py-1 text-[11px] text-blue-300 hover:underline">Open AIP Agent Studio registry →</Link>
          </Section>
          <Section title="Actions" sub="Actions for modifying the ontology" open={leftOpen.actions} onToggle={() => setLeftOpen((s) => ({ ...s, actions: !s.actions }))}>
            {ACTIONS.map((a) => <button key={a.name} onClick={() => act(a.name)} className="flex w-full items-center justify-between rounded px-2 py-[5px] text-left text-[12px] text-[#c3ccda] hover:bg-[#121a27]"><span>{a.name}</span><span className="text-[10px] text-[#8391a7]">{a.on}</span></button>)}
          </Section>
          <Section title="AIP Logic" sub="Functions that compute using data in object types" open={leftOpen.logic} onToggle={() => setLeftOpen((s) => ({ ...s, logic: !s.logic }))}>
            {LOGICS.map((l) => <Link key={l.name} href={l.href} className="flex items-center justify-between rounded px-2 py-[5px] text-[12px] text-[#c3ccda] hover:bg-[#121a27]"><span>{l.name}</span><span className="text-[10px] text-[#8391a7]">{l.runs} runs</span></Link>)}
            {FUNCTIONS.map((f) => <Link key={f.name} href={f.href} className="block rounded px-2 py-[5px] font-mono text-[11px] text-[#c3ccda] hover:bg-[#121a27]">{f.name} <span className="text-[#8391a7]">{f.ver}</span></Link>)}
          </Section>
          <Section title="All Files" sub="All pipelines, datasets, and other files" open={leftOpen.files} onToggle={() => setLeftOpen((s) => ({ ...s, files: !s.files }))}>
            {FILES.map((f) => <Link key={f.name} href={f.href} className="flex items-center justify-between rounded px-2 py-[5px] text-[12px] text-[#c3ccda] hover:bg-[#121a27]"><span className="truncate">{f.name}</span><span className="shrink-0 text-[10px] text-[#8391a7]">{f.kind}</span></Link>)}
          </Section>
          <div className="mt-auto border-t border-[#1d2735] p-2.5 text-[10px] leading-relaxed text-[#8391a7]">Integrated with <Link className="text-blue-300 hover:underline" href="/lineage">Data Lineage</Link>, <Link className="text-blue-300 hover:underline" href="/pipeline">Pipeline Builder</Link>, <Link className="text-blue-300 hover:underline" href="/functions">Functions</Link> and <Link className="text-blue-300 hover:underline" href="/pln-cockpit">Workshop · GRID Cockpit</Link>.</div>
        </aside>

        {/* central workspace — three modes, one platform */}
        {mode === "pipeline" && <PipelineWorkspace nodes={pNodes} edges={pEdges} setNodes={setPNodes} setEdges={setPEdges} notify={notify} onAiGenerate={aiGeneratePipeline} proposalState={proposalState} setProposalState={setProposalState} />}
        {mode === "ops" && <OpsBoard notify={notify} askAi={(q) => { setAiOpen(true); ask(q); }} />}
        {mode === "logic" && <AgentLogicPanel notify={notify} />}
        {mode === "ontology" && (
        <main className="relative flex min-w-0 flex-1 flex-col bg-[#111927]">
          <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b border-[#1d2735] bg-[#0d131d] px-3 text-[12px]">
            <span className="whitespace-nowrap font-medium">{selected.name}</span><span className="hidden whitespace-nowrap text-[#8391a7] min-[1400px]:inline">{selected.count.toLocaleString()} objects · {selected.group}</span>
            <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] ${selected.status === "Healthy" ? "bg-emerald-500/10 text-emerald-300" : selected.status === "Degraded" ? "bg-amber-500/10 text-amber-300" : "bg-red-500/10 text-red-300"}`}>{selected.status}</span>
            <div className="ml-auto flex shrink-0 rounded border border-[#2a3647] p-0.5">
              {([["visual", "Visualization"], ["objects", "Objects"], ["lineage", "Lineage"]] as const).map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`whitespace-nowrap rounded px-2 py-1 text-[11px] ${tab === k ? "bg-violet-600 text-white" : "text-[#8391a7] hover:text-white"}`}>{l}</button>)}
            </div>
          </div>
          {tab === "visual" && <Visualization selected={selected} onCreatePlan={() => ask("Create a work plan to resolve power outages using drone footage")} />}
          {tab === "objects" && <ObjectsTab selected={selected} onAct={act} />}
          {tab === "lineage" && <LineageTab selected={selected} />}
          {detailOpen && tab === "visual" && <DetailPanel o={selected} near={near} onPick={pick} onClose={() => setDetailOpen(false)} onAct={act} />}
          {toast && <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded border border-violet-400/40 bg-[#171126] px-3 py-2 text-[12px] shadow-xl">{toast}</div>}
        </main>)}

        {/* AI agent console */}
        {aiOpen && (
          <aside className="flex w-[288px] shrink-0 flex-col border-l border-[#1d2735] bg-[#0d131d] max-lg:hidden">
            <div className="border-b border-[#1d2735] p-3">
              <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded bg-violet-600 text-white"><Icon name="sparkle" className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-[12px] font-semibold">{agent.name}</p><p className="text-[10px] text-[#8391a7]">{agent.model} · grounded in Ontology</p></div><span className={`h-2 w-2 rounded-full ${agent.online ? "bg-emerald-400" : "bg-[#8391a7]"}`} /></div>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="mt-2.5 w-full rounded border border-[#2a3647] bg-[#070b12] px-2 py-1.5 text-[12px] outline-none">{AGENTS.map((a) => <option key={a.id} value={a.id}>{a.name}{a.online ? "" : " (offline)"}</option>)}</select>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {msgs.map((m, i) => (
                <div key={i} className={`mb-3 rounded border p-2.5 text-[12px] leading-relaxed ${m.role === "user" ? "ml-6 border-blue-400/30 bg-blue-500/10" : "mr-2 border-[#2a3647] bg-[#121a27]"}`}>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#8391a7]">{m.role === "user" ? "Operator" : agent.name}</p>
                  <p className="text-[#e8edf5]">{m.text}</p>
                  {m.objects && <div className="mt-2 flex flex-wrap gap-1">{m.objects.map((id) => <button key={id} onClick={() => pick(id)} className="rounded bg-violet-600/15 px-1.5 py-0.5 text-[10px] text-violet-200 ring-1 ring-violet-400/30 hover:bg-violet-600/25">{byId(id).name}</button>)}</div>}
                  {m.plan && <div className="mt-2.5 border-t border-[#2a3647] pt-2"><p className="text-[11px] font-semibold">Work plan</p>{m.plan.map((s, j) => <p key={j} className="mt-1 flex gap-1.5 text-[11px] text-[#c3ccda]"><span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${planDone >= j ? "bg-emerald-500 text-white" : "bg-[#2a3647]"}`}>{planDone >= j ? "✓" : j + 1}</span>{s}</p>)}<button onClick={() => runPlan(m.plan!)} className="mt-2 w-full rounded bg-violet-600 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500">Execute work plan</button></div>}
                </div>
              ))}
              {busy && <p className="mb-3 flex items-center gap-2 text-[11px] text-violet-200"><span className="h-3.5 w-3.5 animate-spin rounded-full border border-violet-300 border-t-transparent" /> Agent is investigating…</p>}
              <div className="mb-3"><p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#8391a7]">Suggested next steps</p><div className="flex flex-wrap gap-1">{SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="rounded border border-[#2a3647] px-2 py-1 text-left text-[11px] text-[#c3ccda] hover:border-violet-400/50 hover:text-white">{s}</button>)}<button onClick={aiGeneratePipeline} className="rounded border border-violet-400/50 bg-violet-600/15 px-2 py-1 text-left text-[11px] text-violet-100 hover:bg-violet-600/25">✦ Generate drone-footage pipeline</button><button onClick={() => setMode("ops")} className="rounded border border-[#2a3647] px-2 py-1 text-left text-[11px] text-[#c3ccda] hover:border-violet-400/50 hover:text-white">Open GRID Cockpit (Workshop)</button><button onClick={() => setMode("pipeline")} className="rounded border border-[#2a3647] px-2 py-1 text-left text-[11px] text-[#c3ccda] hover:border-violet-400/50 hover:text-white">Open Pipeline Builder</button></div></div>
              <details className="rounded border border-[#2a3647] bg-[#070b12] p-2" open>
                <summary className="cursor-pointer text-[11px] font-medium text-[#c3ccda]">Execution logs</summary>
                <div className="mt-2 space-y-1">{logs.slice(-8).map((l, i) => <p key={i} className="flex gap-1.5 text-[10px] leading-snug text-[#8391a7]"><span className={l.state === "done" ? "text-emerald-300" : "text-amber-300"}>{l.state === "done" ? "✓" : "…"}</span>{l.label}</p>)}<div ref={logEnd} /></div>
              </details>
            </div>
            <div className="border-t border-[#1d2735] p-2.5">
              <div className="flex gap-1 text-[10px] text-[#8391a7]"><span>Context:</span><button onClick={() => setDetailOpen(true)} className="rounded bg-violet-600/15 px-1.5 py-0.5 text-violet-200 ring-1 ring-violet-400/30">{selected.name} ×</button><Link href="/ontology" className="px-1 py-0.5 text-blue-300 hover:underline">Ontology</Link><Link href="/lineage" className="px-1 py-0.5 text-blue-300 hover:underline">Lineage</Link></div>
              <div className="mt-2 flex gap-2"><input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} placeholder="Ask the agent to investigate, retrieve objects, or create a plan…" className="min-w-0 flex-1 rounded border border-[#2a3647] bg-[#070b12] px-2.5 py-2 text-[12px] outline-none placeholder:text-[#8391a7] focus:border-violet-400/60" /><button onClick={() => ask()} disabled={busy} className="shrink-0 rounded bg-violet-600 px-3 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-50">Send</button></div>
              <p className="mt-1.5 text-[10px] text-[#8391a7]">Answers cite ontology objects. Actions are staged for review — nothing is applied silently.</p>
            </div>
          </aside>
        )}
      </div>
      {/* mobile AI / detail shortcuts */}
      <div className="flex shrink-0 gap-2 border-t border-[#1d2735] bg-[#0d131d] p-2 md:hidden">
        <select value={selectedId} onChange={(e) => pick(e.target.value)} className="min-w-0 flex-1 rounded border border-[#2a3647] bg-[#070b12] px-2 py-2 text-[12px]">{OBJECT_TYPES.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <button onClick={() => setAiOpen(!aiOpen)} className="rounded bg-violet-600 px-3 text-[12px] text-white">AI Agent</button>
      </div>
      {aiOpen && <div className="fixed inset-x-0 bottom-0 z-30 max-h-[55vh] overflow-y-auto border-t border-[#2a3647] bg-[#0d131d] p-3 text-[12px] lg:hidden"><p className="font-semibold">{agent.name}</p><p className="mt-1 text-[#c3ccda]">{msgs[msgs.length - 1]?.text}</p><div className="mt-2 flex gap-2"><input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} placeholder="Ask the agent…" className="min-w-0 flex-1 rounded border border-[#2a3647] bg-[#070b12] px-2 py-2 outline-none" /><button onClick={() => ask()} className="rounded bg-violet-600 px-3 text-white">Send</button></div></div>}
    </div>
  );
}

function Section({ title, sub, open, onToggle, children }: { title: string; sub: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <div className="border-b border-[#1d2735] py-1"><button onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"><span className="flex-1"><span className="block text-[12px] font-medium text-white">{title}</span><span className="block text-[10px] leading-snug text-[#8391a7]">{sub}</span></span><Icon name={open ? "down" : "right"} className="h-3.5 w-3.5 text-[#8391a7]" /></button>{open && <div className="px-1.5 pb-2">{children}</div>}</div>;
}

/* Ambient ontology visualization only — as in the reference screenshots: a faint node
   network around a glowing violet ring on a slate canvas. It is not a graph editor;
   object selection happens in the left sidebar and detail panel. */
function Visualization({ selected, onCreatePlan }: { selected: ObjType; onCreatePlan: () => void }) {
  const pts = useMemo(() => {
    const out: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < 46; i++) {
      const a = i * 2.39996, rad = 26 + 148 * Math.sqrt((i + 0.5) / 46);
      out.push({ x: 400 + Math.cos(a) * rad * 1.08, y: 262 + Math.sin(a) * rad * 0.92, r: 1.4 + (i % 3) * 0.5 });
    }
    return out;
  }, []);
  const lines = useMemo(() => {
    const ls: [number, number][] = [];
    pts.forEach((p, i) => pts.forEach((q, j) => { if (j > i && Math.hypot(p.x - q.x, p.y - q.y) < 118) ls.push([i, j]); }));
    return ls.slice(0, 95);
  }, [pts]);
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#2e3d4c]">
      <style>{`@keyframes spinSlow{to{transform:rotate(360deg)}}@keyframes pulseRing{0%,100%{opacity:.75}50%{opacity:1}}`}</style>
      <svg viewBox="0 0 800 524" className="h-full w-full" role="img" aria-label="Ontology visualization">
        <defs>
          <radialGradient id="vizGlow"><stop offset="55%" stopColor="#7c6cf0" stopOpacity="0" /><stop offset="82%" stopColor="#8b7cf6" stopOpacity=".34" /><stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" /></radialGradient>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#6d64d8" /><stop offset="55%" stopColor="#9a8cff" /><stop offset="100%" stopColor="#5b54b8" /></linearGradient>
        </defs>
        <g style={{ transformOrigin: "400px 262px", animation: "spinSlow 140s linear infinite" }}>
          <circle cx="400" cy="262" r="196" fill="url(#vizGlow)" />
          <circle cx="400" cy="262" r="148" fill="none" stroke="url(#ringGrad)" strokeWidth="13" strokeOpacity=".5" strokeLinecap="round" strokeDasharray="760 171" style={{ animation: "pulseRing 5s ease-in-out infinite" }} />
          <circle cx="400" cy="262" r="148" fill="none" stroke="#a99cff" strokeWidth="1.4" strokeOpacity=".65" />
          {lines.map(([a, b], i) => <line key={i} x1={pts[a].x} y1={pts[a].y} x2={pts[b].x} y2={pts[b].y} stroke="#dbe6f2" strokeOpacity=".34" strokeWidth=".7" />)}
          {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} fill="#eef3fa" fillOpacity=".9" />)}
        </g>
      </svg>
      <div className="absolute inset-x-0 bottom-5 flex flex-col items-center gap-2">
        <p className="rounded bg-black/25 px-2.5 py-1 text-[11px] text-[#d7e0ec]">Ontology · <span className="font-medium text-white">{selected.name}</span> · {selected.count.toLocaleString()} objects · updated {selected.freshness}</p>
        <button onClick={onCreatePlan} className="rounded bg-[#5b6ee1] px-4 py-2 text-[12.5px] font-medium text-white shadow-lg hover:bg-[#6a7bf0]">Create work plan</button>
      </div>
      <p className="absolute left-3 top-3 rounded bg-black/20 px-2 py-1 text-[10px] text-[#b9c6d6]">Visualization — select object types in Explore to inspect them</p>
    </div>
  );
}

function DetailPanel({ o, near, onPick, onClose, onAct }: { o: ObjType; near: Set<string>; onPick: (id: string) => void; onClose: () => void; onAct: (n: string) => void }) {
  return (
    <aside className="absolute right-3 top-12 z-10 max-h-[calc(100%-4rem)] w-[262px] overflow-y-auto rounded border border-[#2a3647] bg-[#0d131d]/97 shadow-2xl max-sm:left-3 max-sm:right-3 max-sm:w-auto">
      <div className="flex items-start gap-2 border-b border-[#1d2735] p-3"><span className="mt-0.5 h-3 w-3 shrink-0 rounded-sm" style={{ background: o.color }} /><div className="min-w-0 flex-1"><p className="text-[13px] font-semibold">{o.name}</p><p className="text-[11px] leading-snug text-[#8391a7]">{o.desc}</p></div><button onClick={onClose} aria-label="Close details" className="text-[#8391a7] hover:text-white"><Icon name="x" className="h-4 w-4" /></button></div>
      <div className="space-y-3 p-3 text-[12px]">
        <div><p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#8391a7]">Properties</p>{o.props.map((p) => <div key={p.name} className="flex justify-between gap-2 border-b border-[#1d2735] py-1"><span className="font-mono text-[11px] text-[#c3ccda]">{p.name}<span className="ml-1 text-[9px] text-[#8391a7]">{p.type}</span></span><span className="truncate text-right">{p.value}</span></div>)}</div>
        <div><p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#8391a7]">Linked objects</p><div className="flex flex-wrap gap-1">{[...near].map((id) => <button key={id} onClick={() => onPick(id)} className="rounded bg-[#121a27] px-2 py-1 text-[11px] ring-1 ring-[#2a3647] hover:ring-violet-400/50">{byId(id).name}</button>)}</div></div>
        <div><p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#8391a7]">Sample objects</p>{o.instances.map((x) => <div key={x.id} className="mb-1 rounded border border-[#1d2735] bg-[#121a27] px-2 py-1.5"><p className="font-medium">{x.title}</p><p className="text-[10px] text-[#8391a7]">{x.id} · {x.status} · {x.detail}</p></div>)}</div>
        <div className="rounded border border-[#1d2735] bg-[#070b12] p-2 text-[11px] text-[#8391a7]">Backed by <Link href="/datasets" className="font-mono text-blue-300 hover:underline">{o.dataset}</Link> via <Link href="/pipeline" className="font-mono text-blue-300 hover:underline">{o.pipeline}</Link> · updated {o.freshness} · <Link href="/lineage" className="text-blue-300 hover:underline">View lineage</Link></div>
        <div className="grid grid-cols-2 gap-1.5">{ACTIONS.filter((a) => a.on === o.name || o.name === "Power Outage").slice(0, 4).map((a) => <button key={a.name} onClick={() => onAct(a.name)} className="rounded border border-violet-400/40 bg-violet-600/15 px-2 py-1.5 text-[11px] font-medium text-violet-100 hover:bg-violet-600/25">{a.name}</button>)}<Link href="/ontology" className="rounded border border-[#2a3647] px-2 py-1.5 text-center text-[11px] hover:bg-[#121a27]">Open in Ontology</Link><Link href="/object-explorer" className="rounded border border-[#2a3647] px-2 py-1.5 text-center text-[11px] hover:bg-[#121a27]">Explore objects</Link></div>
      </div>
    </aside>
  );
}

function ObjectsTab({ selected, onAct }: { selected: ObjType; onAct: (n: string) => void }) {
  const [q, setQ] = useState("");
  const rows = selected.instances.filter((x) => (x.title + x.id).toLowerCase().includes(q.toLowerCase()));
  return <div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="mb-2 flex gap-2"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${selected.plural}…`} className="w-64 rounded border border-[#2a3647] bg-[#0d131d] px-2.5 py-1.5 text-[12px] outline-none" /><button onClick={() => onAct("Create Work Order")} className="rounded bg-violet-600 px-3 py-1.5 text-[12px] text-white">New action</button></div>{rows.length === 0 ? <p className="rounded border border-dashed border-[#2a3647] p-8 text-center text-[12px] text-[#8391a7]">No objects match this filter.</p> : <table className="w-full overflow-hidden rounded border border-[#2a3647] text-left text-[12px]"><thead className="bg-[#0d131d] text-[#8391a7]"><tr><th className="px-3 py-2 font-medium">Object</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Detail</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id} className="border-t border-[#1d2735] bg-[#121a27]/60 hover:bg-[#121a27]"><td className="px-3 py-2"><span className="font-mono text-[11px] text-blue-300">{r.id}</span><br />{r.title}</td><td className="px-3 py-2">{r.status}</td><td className="px-3 py-2 text-[#8391a7]">{r.detail}</td></tr>)}</tbody></table>}</div>;
}

function LineageTab({ selected }: { selected: ObjType }) {
  const nodes = [{ l: "Source dataset", v: selected.dataset, href: "/datasets" }, { l: "Pipeline Builder", v: selected.pipeline, href: "/pipeline" }, { l: "Object Type", v: selected.name, href: "/ontology" }, { l: "AIP Logic / Function", v: "Root-Cause Analysis · estimateRestorationTime()", href: "/logic" }, { l: "Application · Workshop", v: "GRID Cockpit", href: "/pln-cockpit" }];
  return <div className="min-h-0 flex-1 overflow-y-auto p-4"><div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-[#2a3647] bg-[#0d131d] px-3 py-2 text-[11px]"><span className="font-semibold">Permissions</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#3d8bfd]" />View data (120)</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#f0a0a8]" />No access (40)</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#4b5c70]" />No data (0)</span><span className="text-[#8391a7]">Permissions type: Data access in datasets · View as: Platform Administrator (admin)</span><span className="ml-auto text-[#8391a7]">Access level is only visible to users who hold that level.</span></div><p className="text-[12px] text-[#8391a7]">End-to-end integration for <span className="text-white">{selected.name}</span> — every stage opens the real platform app.</p><div className="mt-4 flex flex-wrap items-center gap-2">{nodes.map((n, i) => <span key={n.l} className="flex items-center gap-2"><Link href={n.href} className="rounded border border-[#2a3647] bg-[#0d131d] px-3 py-2.5 hover:border-violet-400/50"><span className="block text-[10px] uppercase tracking-wide text-[#8391a7]">{n.l}</span><span className="font-mono text-[11px] text-blue-200">{n.v}</span></Link>{i < nodes.length - 1 && <span className="text-violet-300">→</span>}</span>)}</div><div className="mt-4 grid gap-2 md:grid-cols-3">{[["Pipeline freshness", selected.freshness], ["Objects indexed", selected.count.toLocaleString()], ["Downstream apps", "Workshop · Automate · Agent Studio"]].map(([k, v]) => <div key={k} className="rounded border border-[#2a3647] bg-[#0d131d] p-3"><p className="text-[10px] uppercase tracking-wide text-[#8391a7]">{k}</p><p className="mt-1 text-[13px] font-medium">{v}</p></div>)}</div><Link href="/lineage" className="mt-4 inline-block rounded bg-violet-600 px-3 py-2 text-[12px] font-medium text-white">Open full Data Lineage</Link></div>;
}
