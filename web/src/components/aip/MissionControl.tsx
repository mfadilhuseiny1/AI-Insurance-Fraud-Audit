"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { RunView } from "./AipView";
import { aip, modelName, usd, wib, type Agent, type AipEvent, type MissionDetail, type Rec, type Run } from "./aipRun";

/* Mission Control: long AIP work the auditor watches, steers and audits. The orchestrator plans milestones, tasks (each
   owned by a domain agent) and a validation contract; a person approves the plan and its budget; tasks run one at a
   time in fresh contexts and end in handoffs; a validator checks the contract after each milestone. The budget pauses
   at 80% and stops at 100%. Every button here is a human gate, logged with who and when. */

const STATUS: Record<string, [string, string]> = {
  planning: ["menyusun rencana", "#8abbff"], awaiting_approval: ["menunggu persetujuan", "#f6c86b"], running: ["berjalan", "#8abbff"],
  paused: ["dijeda", "#f6c86b"], paused_budget: ["dijeda · 80% anggaran", "#f6c86b"], stopped_budget: ["berhenti · anggaran habis", "#ff8f8f"],
  completed: ["selesai", "#72ca9b"], stopped: ["dihentikan", "#ff8f8f"], failed: ["gagal", "#ff8f8f"],
};
const pill = (s: string) => { const [label, c] = STATUS[s] ?? [s, "#c5cbd3"]; return <span className="rounded px-1.5 text-[10.5px]" style={{ color: c, background: `${c}22` }}>{label}</span>; };
const ACTIVE = ["planning", "running"];

function Budget({ m }: { m: MissionDetail["mission"] }) {
  const cap = m.budget_usd ?? m.proposed_cap_usd ?? 0;
  const pct = cap ? Math.min(100, (100 * (m.spent_usd ?? 0)) / cap) : 0;
  return (
    <div className="min-w-[220px]">
      <div className="relative h-2 rounded bg-white/10"><div className="h-2 rounded bg-[#4c90f0]" style={{ width: `${pct}%` }} /><div className="absolute top-[-3px] h-3.5 w-px bg-[#f0b14c]" style={{ left: "80%" }} title="jeda otomatis 80%" /></div>
      <p className="mt-0.5 text-[10.5px] tabular-nums text-[#abb3bf]">{usd(m.spent_usd)} dari {cap ? usd(cap) : "—"}{m.estimate_usd != null ? ` · perkiraan ${usd(m.estimate_usd)}` : ""}</p>
    </div>
  );
}

export function MissionControl({ agents, roles }: { agents: Agent[]; roles: Record<string, string> }) {
  const [list, setList] = useState<Rec[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [d, setD] = useState<MissionDetail | null>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cap, setCap] = useState("");
  const [ext, setExt] = useState({ usd: "0.5", reason: "" });
  const [waive, setWaive] = useState<Record<string, string>>({});
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [runData, setRunData] = useState<{ run: Run; events: AipEvent[] } | null>(null);
  const [openHand, setOpenHand] = useState<number | null>(null);

  const refreshList = useCallback(() => aip.missions().then(setList).catch(() => {}), []);
  useEffect(() => { refreshList(); }, [refreshList]);
  useEffect(() => {
    if (!sel) return;
    let stop = false;
    const tick = async () => {
      try { const x = await aip.mission(sel); if (!stop) setD(x); if (!stop && ACTIVE.includes(x.mission.status)) setTimeout(tick, 3000); } catch (e) { setErr((e as Error).message); }
    };
    tick();
    return () => { stop = true; };
  }, [sel]);
  useEffect(() => { if (openRun) aip.run(openRun).then((r) => setRunData({ run: r.run, events: r.events })).catch(() => setRunData(null)); }, [openRun, d]);

  const gate = async (f: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await f(); if (sel) setD(await aip.mission(sel)); refreshList(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const agentName = (k: string) => agents.find((a) => a.key === k)?.name.replace(" (BPJS)", "") ?? k;
  const m = d?.mission;

  return (
    <div className="flex min-h-0 flex-1 bg-[#252f3a] text-[12px]">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-black/30 bg-[#1c2127]">
        <div className="border-b border-white/5 p-2">
          <p className="mb-1 font-semibold text-white">Misi baru</p>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} placeholder="mis. Siapkan audit 10 profil faskes berisiko tertinggi di Sulawesi Selatan" className="w-full resize-none rounded-sm border border-[#2d72d2] bg-[#111418] px-2 py-1 text-[11.5px] outline-none placeholder:text-[#8f99a8]" />
          <button disabled={busy || goal.trim().length < 10} onClick={() => gate(async () => { const x = await aip.newMission(goal.trim()); setGoal(""); setSel(String(x.id)); })} className="mt-1 w-full rounded-sm bg-[#5b5fd6] py-1 font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">Susun rencana</button>
          <p className="mt-1 text-[10px] leading-snug text-[#8f99a8]">Orkestrator menyusun rencana dan kontrak validasi. Tidak ada yang berjalan sebelum Anda menyetujui rencana dan anggarannya.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.map((x) => (
            <button key={x.id} onClick={() => { setSel(x.id); setOpenRun(null); }} className={`block w-full border-b border-white/5 px-2 py-1.5 text-left hover:bg-white/5 ${sel === x.id ? "bg-white/[.07]" : ""}`}>
              <p className="line-clamp-2 text-[11.5px] text-[#e5e8eb]">{x.goal}</p>
              <p className="mt-0.5 flex items-center gap-1.5">{pill(x.status)}<span className="text-[10px] tabular-nums text-[#8f99a8]">{usd(x.spent_usd)}</span></p>
            </button>
          ))}
          {!list.length && <p className="p-2 text-[11px] text-[#8f99a8]">Belum ada misi.</p>}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-3">
        {err && <p className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">{err}</p>}
        {!m ? <p className="text-[#8f99a8]">Pilih atau buat misi. Model per peran: rencana {modelName(roles.planner)} · pekerja {modelName(roles.tools)} / batch gpt-oss-120b · validator {modelName(roles.validator)}.</p> : (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1"><p className="text-[14px] font-semibold text-white">{m.goal}</p><p className="mt-0.5 flex items-center gap-2">{pill(m.status)}<span className="text-[10.5px] text-[#8f99a8]">{m.id}{m.approved_by ? ` · disetujui ${m.approved_by}` : ""}</span></p></div>
              <Budget m={m} />
              <div className="flex gap-1">
                {m.status === "running" && <button disabled={busy} onClick={() => gate(() => aip.control(m.id, "pause"))} className="rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/10">Jeda</button>}
                {(m.status === "paused") && <button disabled={busy} onClick={() => gate(() => aip.control(m.id, "resume"))} className="rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/10">Lanjutkan</button>}
                {!["completed", "stopped", "failed"].includes(m.status) && <button disabled={busy} onClick={() => gate(() => aip.control(m.id, "stop"))} className="rounded border border-red-500/50 px-2 py-0.5 text-red-300 hover:bg-red-500/10">Hentikan</button>}
              </div>
            </div>

            {m.status === "planning" && <p className="text-[#8abbff]">Orkestrator ({modelName(roles.planner)}) sedang menyusun rencana dan kontrak validasi…</p>}
            {m.status === "awaiting_approval" && (
              <div className="rounded-md border border-[#f0b14c]/50 bg-[#f0b14c]/5 p-2.5">
                <p className="font-semibold text-[#f6c86b]">Gerbang persetujuan · rencana, kontrak dan anggaran</p>
                <p className="mt-0.5 text-[#e5e8eb]">{m.plan?.summary}</p>
                <p className="mt-1 text-[11px] text-[#c5cbd3]">Perkiraan {usd(m.estimate_usd)} (dari rata-rata biaya terukur per langkah) · batas usulan {usd(m.proposed_cap_usd)} = 1,5 × perkiraan · penyetuju: <b>{String(m.approver ?? "").replace("_", " ")}</b></p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-[11px] text-[#8f99a8]">Batas anggaran (USD)</span>
                  <input value={cap} onChange={(e) => setCap(e.target.value)} placeholder={String(m.proposed_cap_usd ?? "")} className="w-20 rounded-sm border border-white/15 bg-black/30 px-1.5 py-0.5 text-right tabular-nums text-[#e5e8eb]" />
                  <button disabled={busy} onClick={() => gate(() => aip.approve(m.id, cap ? Number(cap) : undefined))} className="rounded bg-[#d9822b] px-2.5 py-0.5 font-medium text-white hover:brightness-110 disabled:opacity-50">Setujui & mulai</button>
                </div>
              </div>
            )}
            {(m.status === "paused_budget" || m.status === "stopped_budget") && (
              <div className="rounded-md border border-[#f0b14c]/50 bg-[#f0b14c]/5 p-2.5">
                <p className="font-semibold text-[#f6c86b]">Gerbang anggaran · {m.status === "paused_budget" ? "80% terpakai, misi dijeda" : "anggaran habis, misi berhenti"}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-[#8f99a8]">Tambah (USD)</span>
                  <input value={ext.usd} onChange={(e) => setExt({ ...ext, usd: e.target.value })} className="w-16 rounded-sm border border-white/15 bg-black/30 px-1.5 py-0.5 text-right tabular-nums text-[#e5e8eb]" />
                  <input value={ext.reason} onChange={(e) => setExt({ ...ext, reason: e.target.value })} placeholder="alasan (wajib)" className="min-w-[200px] flex-1 rounded-sm border border-white/15 bg-black/30 px-1.5 py-0.5 text-[#e5e8eb]" />
                  <button disabled={busy || ext.reason.trim().length < 3} onClick={() => gate(() => aip.extend(m.id, Number(ext.usd), ext.reason))} className="rounded bg-[#d9822b] px-2.5 py-0.5 font-medium text-white disabled:opacity-50">Perpanjang & lanjutkan</button>
                </div>
              </div>
            )}

            <div className="grid gap-2.5 xl:grid-cols-2">
              <section className="rounded-md border border-white/10 bg-black/20">
                <p className="border-b border-white/5 px-2 py-1 font-semibold text-white">Tugas · satu per satu, konteks baru tiap tugas</p>
                {(m.plan?.milestones ?? []).map((ms) => (
                  <div key={ms.id}>
                    <p className="bg-white/[.03] px-2 py-0.5 text-[10.5px] font-semibold text-[#c5cbd3]">{ms.id} · {ms.title}</p>
                    {d!.tasks.filter((t) => t.milestone === ms.id).map((t) => (
                      <button key={t.id} disabled={!t.run} onClick={() => setOpenRun(t.run)} className="flex w-full items-start gap-2 border-b border-white/5 px-2 py-1 text-left hover:bg-white/5 disabled:hover:bg-transparent">
                        <span className={t.status === "completed" ? "text-emerald-400" : t.status === "failed" ? "text-red-400" : t.status === "running" ? "text-[#8abbff]" : "text-[#5f6b7c]"}>{t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : t.status === "running" ? "●" : "○"}</span>
                        <span className="min-w-0 flex-1"><span className="text-[#e5e8eb]">{t.title}</span><span className="block text-[10.5px] text-[#8f99a8]">{agentName(t.agent)}{t.run ? ` · ${t.run}` : ""}</span></span>
                        {t.run && <span className="text-[#8f99a8]">▸</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </section>

              <section className="rounded-md border border-white/10 bg-black/20">
                <p className="border-b border-white/5 px-2 py-1 font-semibold text-white">Kontrak validasi · ditulis sebelum pekerjaan dimulai</p>
                {d!.contract.map((a) => (
                  <div key={a.id} className="border-b border-white/5 px-2 py-1">
                    <p className="flex items-start gap-1.5"><span className={a.status === "passed" ? "text-emerald-400" : a.status === "failed" ? "text-red-400" : a.status === "waived" ? "text-[#f6c86b]" : "text-[#5f6b7c]"}>{a.status === "passed" ? "✓" : a.status === "failed" ? "✗" : a.status === "waived" ? "≈" : "○"}</span><span className="text-[#e5e8eb]">{a.text}</span></p>
                    {a.evidence && <p className="ml-4 text-[10.5px] text-[#abb3bf]">Bukti validator: {a.evidence}</p>}
                    {a.status === "waived" && <p className="ml-4 text-[10.5px] text-[#f6c86b]">Diterima oleh {a.waived_by}: {a.waiver_reason}</p>}
                    {a.status === "failed" && (
                      <div className="ml-4 mt-1 flex gap-1"><input value={waive[a.id] ?? ""} onChange={(e) => setWaive({ ...waive, [a.id]: e.target.value })} placeholder="alasan menerima (wajib)" className="min-w-0 flex-1 rounded-sm border border-white/15 bg-black/30 px-1.5 py-0.5 text-[11px] text-[#e5e8eb]" /><button disabled={busy || (waive[a.id] ?? "").trim().length < 3} onClick={() => gate(() => aip.waive(m.id, a.id, waive[a.id]))} className="rounded border border-[#f0b14c]/60 px-1.5 text-[11px] text-[#f6c86b] disabled:opacity-40">Terima</button></div>
                    )}
                  </div>
                ))}
                {!d!.contract.length && <p className="px-2 py-1 text-[#8f99a8]">—</p>}
              </section>
            </div>

            <section className="rounded-md border border-white/10 bg-black/20">
              <p className="border-b border-white/5 px-2 py-1 font-semibold text-white">Pekerja · run, model, token, biaya</p>
              <table className="w-full text-[11px]"><thead><tr className="text-left text-[#8f99a8]"><th className="px-2 py-0.5 font-normal">Run</th><th className="font-normal">Jenis</th><th className="font-normal">Status</th><th className="font-normal">Agen · model · token (input/cache/output)</th><th className="px-2 text-right font-normal">Biaya</th></tr></thead>
                <tbody>{d!.runs.map((r) => (
                  <tr key={r.id} onClick={() => setOpenRun(r.id)} className="cursor-pointer border-t border-white/5 hover:bg-white/5">
                    <td className="px-2 py-0.5 font-mono text-[10.5px] text-[#c5cbd3]">{r.id}</td><td className="text-[#d3d8de]">{r.kind}</td><td>{pill(r.status)}</td>
                    <td className="text-[10.5px] text-[#abb3bf]">{Object.entries((r.agents_usage ?? {}) as Rec).map(([a, u]) => `${a} · ${modelName(u.model)} · ${u.prompt}/${u.cached}/${u.output}`).join(" · ") || "—"}</td>
                    <td className="px-2 text-right tabular-nums text-[#e5e8eb]">{usd(r.spent_usd)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>

            {d!.handoffs.length > 0 && (
              <section className="rounded-md border border-white/10 bg-black/20">
                <p className="border-b border-white/5 px-2 py-1 font-semibold text-white">Handoff · yang dikerjakan, belum selesai, kueri, masalah, prosedur</p>
                {d!.handoffs.map((h, i) => (
                  <div key={i} className="border-b border-white/5">
                    <button onClick={() => setOpenHand(openHand === i ? null : i)} className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-white/5"><span className="font-mono text-[10.5px] text-[#c5cbd3]">{h.task}</span><span className="text-[#d3d8de]">{agentName(h.agent)}</span>{h.skill && <span className="rounded bg-white/[.06] px-1 text-[10px] text-[#c5cbd3]">skill {h.skill}</span>}<span className="ml-auto text-[10.5px] text-[#8f99a8]">{(h.queries_run ?? []).length} kueri · {(h.issues_found ?? []).length} masalah {openHand === i ? "▾" : "▸"}</span></button>
                    {openHand === i && (
                      <div className="space-y-1 px-3 pb-2 text-[11px]">
                        <p className="whitespace-pre-line text-[#e5e8eb]">{String(h.implemented ?? "").slice(0, 2500)}</p>
                        {h.left_undone && <p className="text-[#f6c86b]">Belum selesai: {h.left_undone}</p>}
                        {(h.issues_found ?? []).map((x: string, j: number) => <p key={j} className="text-red-300">Masalah: {x}</p>)}
                        <p className="text-[10.5px] text-[#8f99a8]">Prosedur: {(h.procedures_followed ?? []).join(" · ")}</p>
                        <p className="text-[10.5px] text-[#8f99a8]">Kueri: {(h.queries_run ?? []).map((q: Rec) => `${q.tool}${q.rid ? ` → ${q.rid}` : ""}${q.ok ? "" : " (gagal)"}`).join(" · ")}</p>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}

            {openRun && runData && (
              <section className="rounded-md border border-[#9d8cff]/40">
                <p className="flex items-center gap-2 border-b border-white/5 px-2 py-1 font-semibold text-white"><Icon name="eye" className="h-3.5 w-3.5" />Run {openRun}<button onClick={() => setOpenRun(null)} className="ml-auto text-[#8f99a8] hover:text-white"><Icon name="x" className="h-3.5 w-3.5" /></button></p>
                <div className="flex max-h-[70vh] min-h-[300px]"><RunView run={runData.run} events={runData.events} agents={agents} /></div>
              </section>
            )}

            <section className="rounded-md border border-white/10 bg-black/20">
              <p className="border-b border-white/5 px-2 py-1 font-semibold text-white">Log gerbang · siapa, kapan, apa</p>
              {d!.log.map((l, i) => <p key={i} className="border-b border-white/5 px-2 py-0.5 text-[11px] text-[#d3d8de]"><span className="tabular-nums text-[#8f99a8]">{wib(l.t, true)}</span> · <b>{l.who}</b> · {l.what}{l.detail ? ` — ${l.detail}` : ""}</p>)}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
