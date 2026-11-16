"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { FaskesVerifierView } from "@/components/aip/FaskesVerifierView";
import { IomtAuditReportView } from "@/components/aip/IomtAuditReportView";
import { IotMonitoringView } from "@/components/aip/IotMonitoringView";
import {
  ANCHOR_ITEMS, ANCHOR_STEPS, AUTO_ONTOLOGY, FLOW, FRAUD_MODES, GUARDRAILS, LAYERS, LEDGER_LIMITS, NEXUS_ACTIONS,
  NEXUS_EXISTING, NEXUS_NEW, READINESS_COLOR, ROADMAP, SOURCE_COLOR, type FraudMode,
} from "@/components/aip/sensorEvidenceData";

/* IoT · IoMT · Blockchain: how measured evidence from devices, and a record that cannot be edited afterwards, close the
   gap of each claim-fraud mode (the six of Permenkes 16/2019). A concept map: it reads no claim data, and the numbers
   in the examples are illustrative. What already runs (power meters of medical devices, with fictional data) links to
   the audit workspace. */

const nf = (n: number) => n.toLocaleString("id-ID");
const panel = "rounded border border-white/10 bg-[#1c2127]";
const H = ({ n, children, sub }: { n: number; children: React.ReactNode; sub?: string }) => (
  <div className="mb-2">
    <p className="flex items-center gap-2 text-[13px] font-semibold text-white">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-white/10 text-[11px] text-[#c7c9ff]">{n}</span>{children}
    </p>
    {sub && <p className="mt-0.5 pl-7 text-[11.5px] text-[#8f99a8]">{sub}</p>}
  </div>
);
const Pill = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span className="inline-block rounded px-1.5 py-px text-[10px] font-medium" style={{ color, background: `${color}22`, border: `1px solid ${color}55` }}>{children}</span>
);

/* Four views of the same subject: IoT Monitoring (the branch's medical devices read by a current clamp on the power cable,
   bound to masked patients and claims: synthetic data, the default view since 2026-11-15), the concept map (what the evidence
   is for), the IoMT Audit Report (claims checked against device evidence: a workflow apart from the AI Agent Swarm, on a
   synthetic world) and the Verifier Desk (a working check of a faskes's evidence bundle). None of them reads BPJS data. */
type View = "monitor" | "map" | "report" | "desk";
export function SensorEvidenceView() {
  const [view, setView] = useState<View>("monitor");
  const tabs: [View, string][] = [["monitor", "IoT Monitoring"], ["map", "Concept map"], ["report", "IoMT Audit Report"], ["desk", "Verifier Desk"]];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#252d35]">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-[#1c2127] px-4 py-1.5" role="tablist" aria-label="IoT, IoMT and blockchain views">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}
            className={`rounded px-3 py-1 text-[12px] ${view === id ? "bg-white/10 font-medium text-white" : "text-[#abb3bf] hover:bg-white/5 hover:text-white"}`}>
            {label}
          </button>
        ))}
      </div>
      {view === "monitor" ? <IotMonitoringView /> : view === "map" ? <ConceptMap /> : view === "report" ? <IomtAuditReportView /> : <FaskesVerifierView />}
    </div>
  );
}

function ConceptMap() {
  const [mode, setMode] = useState(FRAUD_MODES[0].id);
  const m = FRAUD_MODES.find((x) => x.id === mode) ?? FRAUD_MODES[0];
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[#252d35] text-[12px] text-[#c5cbd3]">
      <div className="mx-auto max-w-[1180px] space-y-5 p-4">
        <header className={`${panel} flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3`}>
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-semibold text-white">IoT · IoMT · Blockchain: dari klaim yang dilaporkan ke bukti yang diukur</h1>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#abb3bf]">
              Klaim adalah laporan dari faskes. Alat yang merawat pasien menghasilkan jejak sendiri, dan blockchain membuat jejak itu tidak bisa dirapikan setelah klaim
              diajukan. Tab ini memetakan bagaimana keduanya menutup tiap modus ketidaksesuaian.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Pill color="#fbbf24">Concept map · angka ilustrasi</Pill>
            <Pill color="#34d399">Tidak membaca data klaim BPJS</Pill>
          </div>
        </header>

        {/* 1 · the three layers */}
        <section>
          <H n={1} sub="Tiga lapis dengan pertanyaan berbeda. Tidak ada satu pun yang cukup sendirian.">Tiga layer bukti</H>
          <div className="grid gap-2 md:grid-cols-3">
            {LAYERS.map((l) => (
              <div key={l.id} className={`${panel} p-3`} style={{ borderTopColor: SOURCE_COLOR[l.id], borderTopWidth: 2 }}>
                <p className="font-semibold" style={{ color: SOURCE_COLOR[l.id] }}>{l.name}</p>
                <p className="mt-1 text-[#e5e8eb]">{l.question}</p>
                <p className="mt-1.5 text-[11px] text-[#abb3bf]"><span className="text-[#8f99a8]">Contoh: </span>{l.examples}</p>
                <p className="mt-1.5 text-[11px] text-[#fbd38d]"><span>Batas: </span>{l.limit}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 2 · fraud mode explorer */}
        <section>
          <H n={2} sub="Pilih modus. Setiap modus menunjukkan apa yang dilaporkan klaim, apa yang bisa diukur, dan apa yang mengunci buktinya.">Enam modus ketidaksesuaian</H>
          <div className="grid gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
            <div className="flex gap-1.5 overflow-x-auto lg:flex-col lg:overflow-visible" role="tablist" aria-label="Fraud mode">
              {FRAUD_MODES.map((f) => (
                <button key={f.id} role="tab" aria-selected={mode === f.id} onClick={() => setMode(f.id)}
                  className={`shrink-0 rounded border px-2.5 py-2 text-left ${mode === f.id ? "border-[#8abbff]/70 bg-white/[.07] text-white" : "border-white/10 bg-[#1c2127] text-[#d3d8de] hover:bg-white/5"}`}>
                  <span className="block font-medium">{f.name}</span>
                  <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-[#abb3bf]">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: READINESS_COLOR[f.readiness.level] }} />{f.agent}
                  </span>
                </button>
              ))}
            </div>
            <ModeDetail m={m} />
          </div>
        </section>

        {/* 3 · end to end */}
        <section>
          <H n={3} sub="Hash naik ke ledger sebelum klaim diajukan; data kesehatan tidak pernah meninggalkan faskes.">Alur end-to-end</H>
          <div className={`${panel} flex flex-wrap items-stretch gap-1.5 p-3`}>
            {FLOW.map((s, i) => (
              <div key={s.title} className="flex items-center gap-1.5">
                <div className="w-[170px] rounded border p-2" style={{ borderColor: `${s.color}66`, background: `${s.color}12` }}>
                  <div className="font-semibold" style={{ color: s.color }}>{i + 1}. {s.title}</div>
                  <div className="mt-0.5 text-[11px] text-[#c5cbd3]">{s.body}</div>
                </div>
                {i < FLOW.length - 1 && <span className="text-[#8f99a8]">→</span>}
              </div>
            ))}
          </div>
        </section>

        {/* 4 · blockchain */}
        <section>
          <H n={4} sub="Intinya satu aturan: bukti harus di-anchor sebelum klaim diajukan (commit-before-claim).">Blockchain sebagai evidence integrity</H>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className={`${panel} p-3`}>
              <ol className="space-y-1.5">
                {ANCHOR_STEPS.map(([h, b], i) => (
                  <li key={h} className="flex gap-2">
                    <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold" style={{ background: `${SOURCE_COLOR.Ledger}33`, color: SOURCE_COLOR.Ledger }}>{i + 1}</span>
                    <span><b className="text-white">{h}.</b> {b}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 font-semibold text-white">Yang di-anchor</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11.5px]">{ANCHOR_ITEMS.map((x) => <li key={x}>{x}</li>)}</ul>
              <p className="mt-3 rounded border border-[#a78bfa]/30 bg-[#a78bfa]/10 px-2.5 py-2 text-[11.5px] text-[#ddd6fe]">
                <b>Mulai tanpa chain.</b> Hash chain append-only plus timestamp dari pihak independen sudah memberi bagian terbesar manfaatnya (bukti tidak diubah) dengan biaya jauh lebih kecil.
                Naik ke ledger konsorsium saat ada lebih dari satu pihak yang perlu saling memverifikasi tanpa saling percaya.
              </p>
            </div>
            <div className={`${panel} p-3`}>
              <p className="flex items-center gap-1.5 font-semibold text-white"><Icon name="alert" className="h-3.5 w-3.5 text-[#fbbf24]" />Yang tidak diselesaikan blockchain</p>
              <dl className="mt-1.5 space-y-2">
                {LEDGER_LIMITS.map(([h, b]) => (
                  <div key={h}><dt className="font-medium text-[#fbd38d]">{h}</dt><dd className="text-[11.5px] leading-relaxed">{b}</dd></div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* 5 · ontology */}
        <section>
          <H n={5} sub="Sinyal baru tidak berdiri sendiri: ia menjadi objek dan link di ontology Nexus, jadi agen dan Operator membacanya seperti data lain.">Ontology (Nexus)</H>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <div className={`${panel} p-3`}>
              <p className="font-semibold text-white">Sudah ada di Nexus</p>
              <ul className="mt-1.5 space-y-1.5">
                {NEXUS_EXISTING.map((t) => (
                  <li key={t.name}><span className="rounded border border-white/15 bg-[#111418] px-1.5 py-px font-mono text-[10.5px] text-[#e5e8eb]">{t.name}</span>
                    <span className="mt-0.5 block text-[11px] text-[#abb3bf]">{t.role}</span></li>
                ))}
              </ul>
              <p className="mt-2 text-[10.5px] text-[#8f99a8]">Sinyal sensor baru ada di Nexus demo (data fiktif); Nexus dari Data Sampel BPJS belum punya sinyal sensor.</p>
            </div>
            <div className={`${panel} p-3`}>
              <p className="font-semibold text-white">Object type baru yang diusulkan</p>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                {NEXUS_NEW.map((t) => (
                  <div key={t.name} className="rounded border border-dashed border-[#8abbff]/40 bg-[#111418] p-2">
                    <p className="font-mono text-[11.5px] font-semibold text-[#8abbff]">{t.name}</p>
                    <p className="text-[10px] text-[#8f99a8]">{t.modes}</p>
                    <p className="mt-1 text-[11px]">{t.holds}</p>
                    <ul className="mt-1 space-y-px font-mono text-[10.5px] text-[#abb3bf]">
                      {t.links.map((l) => (<li key={l.verb + l.target}>— {l.verb} → <span className={NEXUS_EXISTING.some((e) => e.name === l.target) ? "text-[#e5e8eb]" : "text-[#8abbff]"}>{l.target}</span></li>))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="mt-3 font-semibold text-white">Actions</p>
              <ul className="mt-1 space-y-1">
                {NEXUS_ACTIONS.map((a) => (
                  <li key={a.name}><b className="text-[#e5e8eb]">{a.name}</b> <Pill color={a.status === "exists" ? "#34d399" : "#fbbf24"}>{a.status}</Pill>
                    <span className="block text-[11px] text-[#abb3bf]">{a.body}</span></li>
                ))}
              </ul>
            </div>
          </div>

          <div className={`${panel} mt-3 p-3`}>
            <p className="font-semibold text-white">Auto-ontology pattern: Discover → Ground → Validate → Expose</p>
            <p className="mt-0.5 text-[11.5px] text-[#abb3bf]">
              NVIDIA merilis Auto Ontology sebagai semantic layer open source untuk agen. Polanya relevan untuk menambah sumber device baru tanpa menulis ontology dari nol.
              Ontology hasil LLM bisa berbeda antar-run, jadi di sini ia hanya draft: tidak ada yang masuk Nexus tanpa persetujuan manusia.
            </p>
            <div className="mt-2 grid gap-2 md:grid-cols-4">
              {AUTO_ONTOLOGY.map((s, i) => (
                <div key={s.stage} className="rounded border border-white/10 bg-[#111418] p-2">
                  <p className="font-semibold text-[#c7c9ff]">{i + 1}. {s.stage}</p>
                  <p className="mt-1 text-[11px]">{s.here}</p>
                  <p className="mt-1.5 text-[10.5px] text-[#8f99a8]"><span className="text-[#6ee7b7]">Hari ini: </span>{s.today}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 6 · roadmap + guardrails */}
        <section>
          <H n={6} sub="Mulai dari yang sudah terbukti di demo, tambah sinyal bernilai tinggi dulu, baru ledger bersama.">Roadmap & guardrails</H>
          <div className="grid gap-2 md:grid-cols-3">
            {ROADMAP.map((p) => (
              <div key={p.name} className={`${panel} p-3`} style={{ borderTopColor: p.color, borderTopWidth: 2 }}>
                <p className="font-semibold" style={{ color: p.color }}>{p.name}</p>
                <p className="text-[10.5px] text-[#8f99a8]">{p.status}</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11.5px]">{p.items.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            ))}
          </div>
          <div className={`${panel} mt-2 grid gap-x-6 gap-y-2 p-3 md:grid-cols-2`}>
            {GUARDRAILS.map(([h, b]) => (
              <div key={h}><p className="font-medium text-white">{h}</p><p className="text-[11.5px] leading-relaxed">{b}</p></div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function ModeDetail({ m }: { m: FraudMode }) {
  const max = Math.max(m.metric.reportedValue, m.metric.measuredValue);
  const bar = (label: string, v: number, color: string) => (
    <div>
      <div className="flex justify-between text-[11px]"><span>{label}</span><span className="tabular-nums text-white">{nf(v)} {m.metric.unit}</span></div>
      <div className="mt-0.5 h-2 rounded bg-white/10"><div className="h-2 rounded" style={{ width: `${Math.max(2, (v / max) * 100)}%`, background: color }} /></div>
    </div>
  );
  return (
    <div className={`${panel} min-w-0 space-y-3 p-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-semibold text-white">{m.name}</p>
        <Pill color={READINESS_COLOR[m.readiness.level]}>{m.readiness.label}</Pill>
        {m.demo && <a href={m.demo.href} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-[#8abbff] hover:underline">{m.demo.label}<Icon name="external" className="h-3 w-3" /></a>}
      </div>
      <p className="leading-relaxed">{m.how}</p>

      <div className="rounded border border-white/10 bg-[#111418] p-2.5">
        <p className="mb-1.5 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Reported vs measured · ilustrasi, bukan data nyata</p>
        <div className="space-y-2">
          {bar(m.metric.reported, m.metric.reportedValue, "#f87171")}
          {bar(m.metric.measured, m.metric.measuredValue, "#34d399")}
        </div>
      </div>

      <div>
        <p className="mb-1 font-semibold text-white">Signals</p>
        <ul className="space-y-1.5">
          {m.signals.map((s) => (
            <li key={s.device} className="flex gap-2">
              <span className="mt-px shrink-0"><Pill color={SOURCE_COLOR[s.type]}>{s.type}</Pill></span>
              <span><b className="text-[#e5e8eb]">{s.device}.</b> {s.evidence}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded border border-[#a78bfa]/30 bg-[#a78bfa]/10 p-2.5">
          <p className="mb-0.5 flex items-center gap-1.5 font-semibold text-[#ddd6fe]"><Icon name="lock" className="h-3.5 w-3.5" />Blockchain role</p>
          <p className="text-[11.5px] leading-relaxed">{m.anchor}</p>
        </div>
        <div className="rounded border border-[#f87171]/30 bg-[#f87171]/10 p-2.5">
          <p className="mb-0.5 flex items-center gap-1.5 font-semibold text-[#fecaca]"><Icon name="alert" className="h-3.5 w-3.5" />Red flag</p>
          <p className="text-[11.5px] leading-relaxed">{m.redFlag}</p>
        </div>
      </div>
      <p className="rounded border border-[#fbbf24]/30 bg-[#fbbf24]/10 px-2.5 py-2 text-[11.5px] leading-relaxed text-[#fde68a]"><b>Guardrail. </b>{m.guardrail}</p>
      <p className="text-[10.5px] text-[#8f99a8]">Dibaca oleh: {m.agent}</p>
    </div>
  );
}
