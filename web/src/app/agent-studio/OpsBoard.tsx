"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { STAGES, TICKETS, fmtDur, sevColor, type Stage, type Ticket } from "./opsData";

type Audit = { at: string; who: string; what: string; state: "pending" | "approved" | "done" | "rejected" };
const seedAudit = (t: Ticket): Audit[] => [
  { at: t.started, who: "SCADA / AMI", what: `Outage detected on ${t.feeder} — ${t.customers} customers affected`, state: "done" },
  { at: t.started, who: t.agent, what: `Agent correlated telemetry, ${t.substation} and asset history. Likely cause: ${t.cause}`, state: "done" },
  { at: "now", who: t.agent, what: "Recommendation: dispatch crew, attach drone evidence, notify affected customers", state: "pending" },
];

export function OpsBoard({ notify, askAi }: { notify: (m: string) => void; askAi: (q: string) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>(TICKETS);
  const [selId, setSelId] = useState<string | null>("#431");
  const [q, setQ] = useState(""); const [region, setRegion] = useState("All regions"); const [sev, setSev] = useState("All severities");
  const [team, setTeam] = useState("All teams"); const [dur, setDur] = useState("Any duration"); const [sort, setSort] = useState("Priority");
  const [live, setLive] = useState(true); const [tick, setTick] = useState(0);
  const [audits, setAudits] = useState<Record<string, Audit[]>>({});
  const sel = tickets.find((t) => t.id === selId) ?? null;
  useEffect(() => {
    if (!live) return;
    const i = setInterval(() => { setTick((x) => x + 1); setTickets((ts) => ts.map((t, j) => j === (tick + 1) % ts.length && t.stage !== "Resolved" ? { ...t, durationMin: t.durationMin + 1, progress: Math.min(95, t.progress + 2) } : t)); }, 15000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- live simulation tick
  }, [live]);

  const filtered = useMemo(() => tickets.filter((t) =>
    (region === "All regions" || t.region === region) && (sev === "All severities" || t.severity === sev) && (team === "All teams" || t.team === team) &&
    (dur === "Any duration" || (dur === "Under 1h" ? t.durationMin < 60 : dur === "1–2h" ? t.durationMin >= 60 && t.durationMin < 120 : t.durationMin >= 120)) &&
    (t.id + t.loc + t.feeder).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => sort === "Priority" ? sevRank(b) - sevRank(a) || b.customers - a.customers : sort === "Customers affected" ? b.customers - a.customers : sort === "Longest duration" ? b.durationMin - a.durationMin : a.id.localeCompare(b.id)), [tickets, q, region, sev, team, dur, sort]);
  const active = tickets.filter((t) => t.stage !== "Resolved" && t.stage !== "Closed");
  const metrics = [
    { k: "Active outages", v: String(active.length), sub: `${tickets.length} tickets in view` },
    { k: "Critical incidents", v: String(tickets.filter((t) => t.severity === "Critical" && t.stage !== "Resolved" && t.stage !== "Closed").length), sub: "require escalation review" },
    { k: "Avg restoration (resolved)", v: "52m", sub: "target 60m" },
    { k: "SLA compliance", v: `${Math.round(100 * tickets.filter((t) => t.sla !== "Breached").length / tickets.length)}%`, sub: `${tickets.filter((t) => t.sla === "Breached").length} breached` },
    { k: "Customers affected", v: active.reduce((n, t) => n + t.customers, 0).toLocaleString(), sub: "across active outages" },
  ];
  const move = (id: string, to: Stage) => { setTickets((ts) => ts.map((t) => t.id === id ? { ...t, stage: to, progress: to === "Resolved" ? 100 : Math.max(t.progress, 20) } : t)); notify(`${id} moved to ${to}. Ontology action staged for audit.`); };
  const auditFor = (t: Ticket) => audits[t.id] ?? seedAudit(t);
  const propose = (t: Ticket, what: string) => setAudits((a) => ({ ...a, [t.id]: [...auditFor(t), { at: "now", who: "Operator request", what, state: "pending" }] }));
  const decide = (t: Ticket, ok: boolean) => {
    setAudits((a) => ({ ...a, [t.id]: auditFor(t).map((x, i, arr) => i === arr.length - 1 && x.state === "pending" ? { ...x, state: ok ? "approved" : "rejected", what: x.what + (ok ? " — approved by operator" : " — rejected by operator") } : x) }));
    if (ok) { notify(`Approved and executed for ${t.id}. Recorded in the audit trail.`); setTickets((ts) => ts.map((x) => x.id === t.id ? { ...x, progress: Math.min(100, x.progress + 12) } : x)); } else notify(`Recommendation rejected for ${t.id}. No action executed.`);
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 bg-[#232f3e] text-[#e8edf5]">
      {/* left: board tools + agent configuration (reference: Goal / Requirements / Tools / Data access) */}
      <aside className="hidden w-[218px] shrink-0 overflow-y-auto border-r border-[#354254] bg-[#1d2735] p-2.5 text-[11.5px] min-[1600px]:block">
        <p className="flex items-center gap-1.5 font-semibold text-[12px]"><span className="flex h-5 w-5 items-center justify-center rounded bg-[#c62f3b] text-white">⏻</span> Repair Agent 3</p>
        <p className="mt-0.5 text-[10px] text-[#93a2b5]">Probation mode — recommendations only. Consequential actions need human approval.</p>
        <Block title="Goal"><p>Move <b>Power Outages</b> from Resolved → Closed and assign an Outage Investigator.</p></Block>
        <Block title="Requirements (4)"><ul className="list-inside list-disc space-y-0.5 text-[#c3ccda]"><li>99.9% SLA met for 24 hours</li><li>80% customers receive notification</li><li>No active crews on-site</li><li>All crew reports submitted</li></ul></Block>
        <Block title="Tools (4)"><p>Get connection status · Assign Outage Investigator · Resend notification · Set Power Outage status</p></Block>
        <Block title="Data access (3)"><p>Repair crew status · Crew reports · Outage Investigator</p></Block>
        <Block title="Board controls">
          <label className="flex items-center gap-2"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live updates {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}</label>
          <button onClick={() => askAi("Recommend repair priorities across all active outages")} className="mt-2 w-full rounded bg-violet-600 py-1.5 font-medium text-white hover:bg-violet-500">✦ Ask AI for priorities</button>
          <button onClick={() => setTickets(TICKETS)} className="mt-1.5 w-full rounded border border-[#43536a] py-1.5 hover:bg-[#28374a]">Reset demo board</button>
        </Block>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[#354254] px-3 pt-2.5">
          <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-violet-600/20 px-2 py-1 text-[10px] font-semibold text-violet-200 ring-1 ring-violet-400/40">WORKSHOP · GRID COCKPIT</span><h2 className="flex items-center gap-2 text-[15px] font-semibold"><span className="flex h-6 w-6 items-center justify-center rounded bg-[#c62f3b] text-white">⏻</span>Power Outages</h2><span className="text-[11px] text-[#93a2b5]">PLN Grid Monitoring Cockpit · Ontology-driven · {live ? "live" : "paused"}</span><Link href="/pln-cockpit" className="rounded border border-[#43536a] px-2 py-1 text-[11px] text-blue-200 hover:border-violet-400/60 hover:text-white">Open full GRID Cockpit ↗</Link>
            <div className="ml-auto flex gap-1.5"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter boards…" className="w-44 rounded border border-[#43536a] bg-[#1d2735] px-2 py-1.5 text-[11.5px] outline-none" />
            <Sel v={region} set={setRegion} opts={["All regions", ...uniq(tickets.map((t) => t.region))]} /><Sel v={sev} set={setSev} opts={["All severities", "Critical", "High", "Medium", "Low"]} /><Sel v={team} set={setTeam} opts={["All teams", ...uniq(tickets.map((t) => t.team))]} /><Sel v={dur} set={setDur} opts={["Any duration", "Under 1h", "1–2h", "Over 2h"]} /><Sel v={sort} set={setSort} opts={["Priority", "Customers affected", "Longest duration"]} /></div></div>
          <div className="mt-2.5 grid grid-cols-2 gap-2 pb-2.5 md:grid-cols-5">{metrics.map((m) => <div key={m.k} className="rounded border border-[#354254] bg-[#1d2735] px-2.5 py-2"><p className="text-[9.5px] uppercase tracking-wide text-[#93a2b5]">{m.k}</p><p className="mt-0.5 text-[17px] font-semibold leading-none">{m.v}</p><p className="mt-1 text-[10px] text-[#93a2b5]">{m.sub}</p></div>)}</div>
        </div>

        <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto p-3">
          {STAGES.map((stage) => {
            const col = filtered.filter((t) => t.stage === stage);
            return <section key={stage} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = e.dataTransfer.getData("text/plain"); if (id) move(id, stage); }} className="flex min-w-[148px] flex-1 flex-col rounded bg-[#1a2432]/60">
              <header className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{stage}<span className="font-normal text-[#93a2b5]">{col.length}</span></header>
              <div className="min-h-[120px] flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {col.map((t) => <article key={t.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)} onClick={() => setSelId(t.id)} className={`cursor-grab rounded-[3px] bg-[#0b0f16] p-2 shadow ${selId === t.id ? "ring-2 ring-white/80" : "ring-1 ring-black/40"}`}>
                  <p className="flex items-center gap-1.5 text-[12px] font-medium"><span className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] bg-[#c62f3b] text-[11px] text-white">⏻</span>{t.id} <span className="text-[#93a2b5]">/</span> {t.loc}<span className="ml-auto h-2 w-2 shrink-0 rounded-full" style={{ background: sevColor(t.severity) }} title={t.severity} /></p>
                  <p className="mt-1 flex gap-1">{[0, 1, 2].map((i) => <span key={i} className="h-[5px] w-[18px] rounded-sm" style={{ background: i === 0 ? sevColor(t.severity) : i === 1 ? "#3d8bfd" : "#4b5c70" }} />)}</p>
                  <div className="mt-1.5 h-1 overflow-hidden rounded bg-[#2a3647]"><div className="h-full bg-violet-400" style={{ width: `${t.progress}%` }} /></div>
                  <p className="mt-1 text-[10px] text-[#93a2b5]">{t.severity} · {t.customers} customers · {fmtDur(t.durationMin)} · SLA: <span className={t.sla === "Breached" ? "text-red-300" : t.sla === "At risk" ? "text-amber-300" : "text-emerald-300"}>{t.sla}</span></p>
                  <p className="mt-1.5 flex items-center gap-1 rounded-[3px] bg-[#5b4bd6] px-1.5 py-[3px] text-[10.5px] font-medium text-white"><span>ϟ</span><span className="truncate">{t.agent}</span><span className="ml-auto opacity-70">•••</span></p>
                  {t.crew !== "—" && <p className="mt-1 text-[10px] text-[#93a2b5]">Crew: {t.crew}</p>}
                </article>)}
                {col.length === 0 && <p className="rounded border border-dashed border-[#43536a] p-3 text-center text-[10.5px] text-[#93a2b5]">No tickets match the filters</p>}
              </div>
            </section>;
          })}
          {/* contextual detail panel — third panel */}
          {sel && <Detail t={sel} audit={auditFor(sel)} onClose={() => setSelId(null)} onMove={move} onPropose={propose} onDecide={decide} askAi={askAi} />}
        </div>
      </div>
    </div>
  );
}
const sevRank = (t: Ticket) => ({ Critical: 4, High: 3, Medium: 2, Low: 1 }[t.severity]);
const uniq = (a: string[]) => Array.from(new Set(a));
function Sel({ v, set, opts }: { v: string; set: (s: string) => void; opts: string[] }) { return <select value={v} onChange={(e) => set(e.target.value)} className="rounded border border-[#43536a] bg-[#1d2735] px-1.5 py-1.5 text-[11px] outline-none">{opts.map((o) => <option key={o}>{o}</option>)}</select>; }
function Block({ title, children }: { title: string; children: React.ReactNode }) { return <div className="mt-3 border-t border-[#354254] pt-2"><p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#93a2b5]">{title}</p><div className="leading-relaxed text-[#c3ccda]">{children}</div></div>; }

function Detail({ t, audit, onClose, onMove, onPropose, onDecide, askAi }: { t: Ticket; audit: Audit[]; onClose: () => void; onMove: (id: string, s: Stage) => void; onPropose: (t: Ticket, w: string) => void; onDecide: (t: Ticket, ok: boolean) => void; askAi: (q: string) => void }) {
  const [gen, setGen] = useState(false);
  const pending = audit[audit.length - 1]?.state === "pending";
  const generate = () => { setGen(true); setTimeout(() => setGen(false), 1400); };
  return (
    <aside className="absolute bottom-2 right-2 top-[126px] z-20 flex w-[300px] flex-col overflow-y-auto rounded bg-[#141c28] shadow-2xl ring-1 ring-[#354254] max-[1200px]:left-2 max-[1200px]:w-auto">
      <div className="flex items-center gap-2 border-b border-[#354254] p-3"><span className="flex h-6 w-6 items-center justify-center rounded bg-[#c62f3b] text-white">⏻</span><div className="min-w-0 flex-1"><p className="text-[13px] font-semibold">{t.id} / {t.loc}</p><p className="text-[10px] text-[#93a2b5]">{t.feeder} · {t.substation} · {t.region}</p></div><button onClick={onClose} className="text-[#93a2b5] hover:text-white">✕</button></div>
      <div className="space-y-3 p-3 text-[11.5px]">
        <div className="grid grid-cols-3 gap-1.5 text-center">{[[t.severity, "Severity"], [t.sla, "SLA"], [fmtDur(t.durationMin), "Duration"]].map(([v, k]) => <div key={k} className="rounded bg-[#1d2735] px-1 py-1.5"><p className="font-semibold" style={{ color: k === "Severity" ? sevColor(t.severity) : undefined }}>{v}</p><p className="text-[9px] uppercase text-[#93a2b5]">{k}</p></div>)}</div>
        <p className="leading-relaxed text-[#c3ccda]"><b className="text-white">Cause (AI):</b> {t.cause}.<br /><b className="text-white">Evidence:</b> {t.evidence}.</p>

        <div><p className="mb-1 font-semibold">Affected grid</p>
          <svg viewBox="0 0 300 110" className="w-full rounded bg-[#0e2a22]"><path d="M10 90 L80 60 L140 70 L200 35 L290 45" stroke="#e8c97a" strokeWidth="1.6" fill="none" /><path d="M80 60 L110 20 M200 35 L225 75" stroke="#e8c97a" strokeWidth="1" strokeOpacity=".6" /><circle cx="140" cy="70" r="6" fill="#f0616d" /><circle cx="80" cy="60" r="4" fill="#fff" /><circle cx="200" cy="35" r="4" fill="#fff" /><text x="132" y="88" fontSize="8" fill="#fff">{t.feeder}</text><text x="60" y="52" fontSize="8" fill="#d7e0ec">{t.substation}</text><text x="205" y="28" fontSize="8" fill="#d7e0ec">Transmission line</text></svg>
          <p className="mt-1 text-[10px] text-[#93a2b5]">Related: {t.feeder} · {t.substation} · 3 transmission lines · 2 downstream feeders (Ontology links)</p></div>

        <div><div className="mb-1 flex items-center"><p className="font-semibold">Drone footage #96</p><button onClick={generate} className="ml-auto text-[10.5px] text-violet-300 hover:underline">{gen ? "Generating widget…" : "✦ Generate widget"}</button></div>
          {gen ? <div className="flex h-[86px] items-center justify-center rounded bg-[#1d2735] text-violet-200"><span className="mr-2 h-4 w-4 animate-spin rounded-full border border-violet-300 border-t-transparent" /> Generating widget… <button onClick={() => setGen(false)} className="ml-2 underline">Stop</button></div>
          : <div className="relative flex h-[86px] items-end rounded bg-gradient-to-br from-[#5a4632] via-[#3d4a35] to-[#22301f] p-2"><span className="rounded bg-black/55 px-1.5 py-0.5 text-[9.5px]">Aerial · span 47 · vegetation encroachment · 0.93</span></div>}</div>

        <div><p className="mb-1 font-semibold">Customer notification #442</p>
          {[["Sent", t.notif.sent, "#34c38f"], ["Delivered", t.notif.delivered, "#4db2ff"], ["Failed", t.notif.failed, "#f0616d"]].map(([k, v, c]) => <div key={k as string} className="mb-1 flex items-center gap-2 text-[10.5px]"><span className="w-14 text-[#93a2b5]">{k}</span><div className="h-3 flex-1 rounded-sm bg-[#1d2735]"><div className="h-full rounded-sm" style={{ width: `${Math.min(100, (v as number) / Math.max(1, t.notif.sent) * 100)}%`, background: c as string }} /></div><span className="w-10 text-right tabular-nums">{(v as number).toLocaleString()}</span></div>)}
          <p className="text-[10px] text-[#93a2b5]">Crew report #661 attached · last update 12 min ago</p></div>

        <div><p className="mb-1 font-semibold">AI recommendation — approval required</p>
          <div className="rounded border border-violet-400/40 bg-violet-500/10 p-2 leading-relaxed">Dispatch <b>{t.crew !== "—" ? t.crew : "Crew Alpha-3"}</b>, resend failed notifications ({t.notif.failed}), then move to {t.stage === "Open" ? "Triaged" : "Resolved"} after crew confirmation. Reasoning and tool calls are in the audit trail below.</div>
          {pending && <div className="mt-1.5 flex gap-1.5"><button onClick={() => onDecide(t, true)} className="flex-1 rounded bg-emerald-600 py-1.5 font-medium text-white">Approve & execute</button><button onClick={() => onDecide(t, false)} className="flex-1 rounded border border-[#43536a] py-1.5">Reject</button></div>}
          <button onClick={() => askAi(`Investigate outage ${t.id} at ${t.loc} and recommend next-best actions`)} className="mt-1.5 w-full rounded bg-violet-600 py-1.5 font-medium text-white hover:bg-violet-500">✦ Investigate with AI Agent</button></div>

        <div><p className="mb-1 font-semibold">Actions</p><div className="grid grid-cols-2 gap-1.5">
          <button onClick={() => onPropose(t, "Assign operator — staged for approval")} className="rounded border border-[#43536a] py-1.5 hover:bg-[#1d2735]">Assign operator</button>
          <button onClick={() => onPropose(t, `Dispatch ${t.crew !== "—" ? t.crew : "Crew Alpha-3"} — staged for approval`)} className="rounded border border-[#43536a] py-1.5 hover:bg-[#1d2735]">Dispatch crew</button>
          <button onClick={() => onPropose(t, "Escalate incident to Critical — staged for approval")} className="rounded border border-[#43536a] py-1.5 hover:bg-[#1d2735]">Escalate incident</button>
          <button onClick={() => onPropose(t, `Send notifications to ${t.customers} customers — staged for approval`)} className="rounded border border-[#43536a] py-1.5 hover:bg-[#1d2735]">Send notifications</button>
          {STAGES.filter((s) => s !== t.stage).map((s) => <button key={s} onClick={() => onMove(t.id, s)} className="rounded bg-[#28374a] py-1.5 hover:bg-[#32465e]">Move → {s}</button>)}
        </div></div>

        <div><p className="mb-1 font-semibold">Activity & audit trail</p><div className="space-y-1.5">{audit.map((a, i) => <div key={i} className="flex gap-2 text-[10.5px] leading-snug"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${a.state === "done" || a.state === "approved" ? "bg-emerald-400" : a.state === "rejected" ? "bg-red-400" : "bg-amber-300"}`} /><p><span className="text-[#93a2b5]">{a.at} · {a.who} · {a.state}</span><br />{a.what}</p></div>)}</div></div>
      </div>
    </aside>
  );
}
