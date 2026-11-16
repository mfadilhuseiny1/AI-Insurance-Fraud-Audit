"use client";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";

/* The IoMT Audit Report: claims checked against the devices that observed them. A workflow of its own, apart from the AI Agent
   Swarm and its BPJS data: it reads the output of synthetic-iomt/audit.py (a synthetic world), so no BPJS claim is in it.
   The same sections can be embedded in a combined audit report: the data is one JSON (see the download) with the same
   fraud-mode groups and the same two outcomes, dispute and verify. */

const OK = "#34d399";
const BAD = "#f87171";
const WARN = "#fbbf24";
const LEDGER = "#a78bfa";
const INFO = "#8abbff";
const DEVICE = "#2dd4bf";
const panel = "rounded border border-white/10 bg-[#1c2127]";

type Finding = { rule: string; flag: "dispute" | "verify"; title: string; claimed: string; measured: string; evidence: string };
type Measure = { label: string; unit: string; claimed: number; measured: number };
type Timeline = { from: number; to: number; claimedFrom: number; claimedTo: number; series: { metric: string; label: string; note: string; cells: (number | null)[] }[] };
type ClaimItem = {
  id: string; faskes: string; type: string; dx: string; admitted: string; discharged: string; severity: string; tariffRp: number;
  flag: "dispute" | "verify"; family: string; headline: string; estRp: number; findings: Finding[]; measures: Measure[]; timeline: Timeline | null; next: string;
};
type Mode = { id: string; name: string; blurb: string; dispute: number; verify: number; estRp: number; rules: { rule: string; title: string; claims: number }[] };
type FaskesRow = { id: string; name: string; coverage: string; province: string; claims: number; instrumented: number; dispute: number; verify: number; estRp: number };
type Report = {
  world: string; seed: number | null;
  headline: { claims: number; instrumented: number; readings: number; faskes: number; instrumentedFaskes: number; dispute: number; verify: number; pricedRp: number; faskesWithFindings: number };
  workflow: { id: string; title: string; value: number; unit: string; detail: string }[];
  modes: Mode[]; faskes: FaskesRow[]; claims: ClaimItem[];
  guardrails: { rule: string; title: string; claims: number }[];
  score: null | {
    caught: number; fraud_assessable: number; recall: number; disputed: number; false_disputes: number; benign_accused: number; honest_accused: number; review_fraud: number; review_flagged: number;
    out_of_scope_fraud: number; upcodingEstimatedRp: number | null; upcodingTrueRp: number | null; note: string;
    perScenario: { scenario: string; claims: number; expected: string; ok: number; rate: number }[];
  };
  limits: string[];
};

const nf = (n: number) => n.toLocaleString("en-US");
const rp = (n: number) => (n >= 1e9 ? `Rp ${(n / 1e9).toFixed(2)} billion` : `Rp ${Math.round(n / 1e6).toLocaleString("en-US")} million`);
const flagColor = (f: string) => (f === "dispute" ? BAD : WARN);
const modeColor: Record<string, string> = { upcoding: LEDGER, phantom: BAD, inflated: "#fb923c", stay: INFO, integrity: DEVICE, explain: WARN };

const Pill = ({ color, children }: { color: string; children: ReactNode }) => (
  <span className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium" style={{ color, background: `${color}22`, border: `1px solid ${color}55` }}>{children}</span>
);

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className={`${panel} p-3`} style={{ borderTopColor: color, borderTopWidth: 2 }}>
      <p className="text-[11px] text-[#8f99a8]">{label}</p>
      <p className="mt-0.5 text-[22px] font-semibold leading-tight text-white">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-[#abb3bf]">{sub}</p>}
    </div>
  );
}

export function IomtAuditReportView() {
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [flag, setFlag] = useState<"all" | "dispute" | "verify">("all");
  const [faskes, setFaskes] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(20);

  useEffect(() => {
    let alive = true;
    fetch("/api/iomt-audit", { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof body.error === "string" ? body.error : `${r.status} ${r.statusText}`);
        if (alive) setRep(body as Report);
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => (rep?.claims ?? []).filter((c) => (!mode || c.family === mode) && (flag === "all" || c.flag === flag) && (!faskes || c.faskes === faskes)), [rep, mode, flag, faskes]);

  const download = () => {
    if (!rep) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(rep, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "iomt-audit-report.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (err) return <div className="min-h-0 flex-1 overflow-y-auto bg-[#252d35] p-4"><div role="alert" className="mx-auto max-w-[1180px] rounded border border-[#fbbf24]/40 bg-[#fbbf24]/10 px-3 py-3 text-[12px] text-[#fde68a]">{err}</div></div>;
  if (!rep) return <div className="min-h-0 flex-1 bg-[#252d35] p-8 text-center text-[12px] text-[#abb3bf]">Loading the audit report…</div>;

  const h = rep.headline;
  const maxMode = Math.max(1, ...rep.modes.map((m) => m.dispute + m.verify));
  const topFaskes = rep.faskes.filter((f) => f.dispute || f.verify).slice(0, 10);
  const maxFaskes = Math.max(1, ...topFaskes.map((f) => f.dispute + f.verify));
  const pick = (m: string | null) => { setMode(m === mode ? null : m); setShown(20); };

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[#252d35] text-[12px] text-[#c5cbd3]">
      <div className="mx-auto max-w-[1180px] space-y-4 p-4">
        <header className={`${panel} flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3`}>
          <div className="min-w-[240px] flex-1">
            <h1 className="text-[15px] font-semibold text-white">IoMT Audit Report: claims checked against the devices that observed them</h1>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#abb3bf]">
              A workflow of its own, separate from the AI Agent Swarm. Where a faskes has IoMT, each claim is reconciled with the readings of its own devices; the result can be added to the swarm&apos;s audit report as one section.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Pill color={WARN}>Synthetic demonstration</Pill>
            <Pill color={OK}>No BPJS data</Pill>
            <button type="button" onClick={download} className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/5 px-2.5 py-1 text-[11.5px] text-white hover:bg-white/10" title="The whole report as JSON, to embed in a combined audit report">
              <Icon name="download" className="h-3 w-3" /> JSON
            </button>
          </div>
        </header>

        {/* the workflow */}
        <section>
          <p className="mb-1.5 font-semibold text-white">The workflow</p>
          <div className="flex flex-wrap items-stretch gap-1.5">
            {rep.workflow.map((s, i) => (
              <Fragment key={s.id}>
                <div className={`${panel} min-w-[190px] flex-1 p-2.5`}>
                  <p className="flex items-center gap-1.5 text-[11px] text-[#8f99a8]"><span className="grid h-4 w-4 place-items-center rounded-full bg-white/10 text-[10px] text-[#c7c9ff]">{i + 1}</span>{s.title}</p>
                  <p className="mt-1 text-[18px] font-semibold leading-tight text-white">{nf(s.value)} <span className="text-[11px] font-normal text-[#abb3bf]">{s.unit}</span></p>
                  <p className="mt-0.5 text-[10.5px] leading-snug text-[#8f99a8]">{s.detail}</p>
                </div>
                {i < rep.workflow.length - 1 && <span className="hidden self-center text-[#8f99a8] md:block"><Icon name="right" className="h-4 w-4" /></span>}
              </Fragment>
            ))}
          </div>
        </section>

        <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Disputes" value={nf(h.dispute)} sub="the devices contradict the claim" color={BAD} />
          <Tile label="To verify" value={nf(h.verify)} sub="needs an explanation, not an accusation" color={WARN} />
          <Tile label="Overbilling priced" value={rp(h.pricedRp)} sub="tariff gap of the severity and ventilation findings" color={LEDGER} />
          <Tile label="Faskes with findings" value={`${h.faskesWithFindings} of ${h.instrumentedFaskes}`} sub={`${nf(h.instrumented)} of ${nf(h.claims)} claims have device evidence`} color={DEVICE} />
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <div className={`${panel} p-3`}>
            <p className="font-semibold text-white">Fraud modes found</p>
            <p className="mb-2 text-[11px] text-[#8f99a8]">The modes of Permenkes 16/2019 that a device can expose. Click one to list its claims.</p>
            <div className="space-y-1.5">
              {rep.modes.map((m) => {
                const total = m.dispute + m.verify;
                if (!total) return null;
                return (
                  <button key={m.id} type="button" onClick={() => pick(m.id)} aria-pressed={mode === m.id}
                    className={`block w-full rounded border px-2 py-1.5 text-left ${mode === m.id ? "border-white/40 bg-white/[.07]" : "border-white/10 hover:bg-white/5"}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-white"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: modeColor[m.id] }} />{m.name}</span>
                      <span className="text-[11px] text-[#abb3bf]">{m.dispute > 0 && <span style={{ color: BAD }}>{m.dispute} disputes</span>}{m.dispute > 0 && m.verify > 0 && " · "}{m.verify > 0 && <span style={{ color: WARN }}>{m.verify} to verify</span>}</span>
                    </div>
                    <div className="mt-1 flex h-2 overflow-hidden rounded bg-white/5" role="img" aria-label={`${m.dispute} disputes and ${m.verify} to verify`}>
                      <span style={{ width: `${(m.dispute / maxMode) * 100}%`, background: BAD }} />
                      <span style={{ width: `${(m.verify / maxMode) * 100}%`, background: WARN }} />
                    </div>
                    <p className="mt-1 text-[10.5px] text-[#8f99a8]">{m.blurb}{m.estRp > 0 && <> · priced {rp(m.estRp)}</>}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`${panel} p-3`}>
            <p className="font-semibold text-white">Where</p>
            <p className="mb-2 text-[11px] text-[#8f99a8]">Faskes by findings. A faskes with no IoMT cannot be audited this way. Click one to filter.</p>
            <div className="space-y-1">
              {topFaskes.map((f) => (
                <button key={f.id} type="button" onClick={() => { setFaskes(faskes === f.id ? null : f.id); setShown(20); }} aria-pressed={faskes === f.id}
                  className={`block w-full rounded border px-2 py-1 text-left ${faskes === f.id ? "border-white/40 bg-white/[.07]" : "border-white/10 hover:bg-white/5"}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-white"><span className="font-mono text-[10.5px] text-[#abb3bf]">{f.id}</span> {f.name} <span className="text-[10px] text-[#8f99a8]">· {f.coverage}</span></span>
                    <span className="shrink-0 text-[11px] text-[#abb3bf]">{f.dispute + f.verify} of {f.instrumented}</span>
                  </div>
                  <div className="mt-0.5 flex h-1.5 overflow-hidden rounded bg-white/5">
                    <span style={{ width: `${(f.dispute / maxFaskes) * 100}%`, background: BAD }} />
                    <span style={{ width: `${(f.verify / maxFaskes) * 100}%`, background: WARN }} />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* the claims */}
        <section className={`${panel} p-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-white">Claim evidence</p>
            <span className="text-[11px] text-[#8f99a8]">{nf(rows.length)} claim{rows.length === 1 ? "" : "s"}</span>
            <div className="ml-auto flex flex-wrap items-center gap-1" role="group" aria-label="Filter by outcome">
              {(["all", "dispute", "verify"] as const).map((x) => (
                <button key={x} type="button" aria-pressed={flag === x} onClick={() => { setFlag(x); setShown(20); }}
                  className={`rounded border px-2 py-0.5 text-[11px] ${flag === x ? "border-white/40 bg-white/10 text-white" : "border-white/10 text-[#abb3bf] hover:bg-white/5"}`}>{x === "all" ? "All" : x === "dispute" ? "Disputes" : "To verify"}</button>
              ))}
              {(mode || faskes) && <button type="button" onClick={() => { setMode(null); setFaskes(null); }} className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-[#abb3bf] hover:bg-white/5">Clear filters</button>}
            </div>
          </div>
          <div className="mt-2 space-y-1">
            {rows.slice(0, shown).map((c) => (
              <div key={c.id} className={`rounded border ${open === c.id ? "border-white/30 bg-white/[.04]" : "border-white/10"}`}>
                <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id} className="flex w-full items-center gap-2 px-2 py-1.5 text-left">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: flagColor(c.flag) }} title={c.flag} />
                  <span className="shrink-0 font-mono text-[11px] text-white">{c.id}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-[#8f99a8]">{c.faskes}</span>
                  <span className="min-w-0 flex-1 truncate text-[#e5e8eb]">{c.headline}</span>
                  {c.estRp > 0 && <span className="hidden shrink-0 text-[11px] sm:block" style={{ color: LEDGER }}>{rp(c.estRp)}</span>}
                  <Icon name={open === c.id ? "down" : "right"} className="h-3 w-3 shrink-0 text-[#8f99a8]" />
                </button>
                {open === c.id && <ClaimDetail c={c} />}
              </div>
            ))}
            {rows.length === 0 && <p className="py-4 text-center text-[#8f99a8]">No claim matches these filters.</p>}
          </div>
          {rows.length > shown && <button type="button" onClick={() => setShown(shown + 30)} className="mt-2 w-full rounded border border-white/10 py-1.5 text-[11.5px] text-[#d3d8de] hover:bg-white/5">Show {Math.min(30, rows.length - shown)} more</button>}
        </section>

        {/* guardrails */}
        <section className={`${panel} p-3`}>
          <p className="font-semibold text-white">Guardrails: what is held back instead of accused</p>
          <p className="mb-2 text-[11px] text-[#8f99a8]">An honest faskes has outages, late uploads and clinical early stops. These become a request for an explanation.</p>
          <div className="flex flex-wrap gap-1.5">
            {rep.guardrails.map((g) => (
              <span key={g.rule} className="inline-flex items-center gap-1.5 rounded border border-white/10 bg-[#161a1f] px-2 py-1"><span className="font-semibold text-white">{g.claims}</span><span className="text-[#c5cbd3]">{g.title}</span></span>
            ))}
          </div>
        </section>

        {rep.score && <Score score={rep.score} />}

        <section className="rounded border border-white/10 bg-[#1c2127]/60 p-3 text-[11.5px] leading-relaxed text-[#abb3bf]">
          <p className="font-semibold text-[#fbd38d]">What this report does and does not show</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{rep.limits.map((l) => <li key={l}>{l}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}

function ClaimDetail({ c }: { c: ClaimItem }) {
  return (
    <div className="space-y-3 border-t border-white/10 px-3 py-3">
      <p className="text-[11px] text-[#8f99a8]">{c.type} · {c.dx} · {c.admitted} to {c.discharged} · severity {c.severity} · tariff {rp(c.tariffRp)}</p>

      {c.measures.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-white">Claimed against measured</p>
          <div className="space-y-1.5">
            {[...c.measures].sort((a, b) => Number(b.claimed > b.measured * 1.15 + 1) - Number(a.claimed > a.measured * 1.15 + 1)).map((m) => {
              const max = Math.max(m.claimed, m.measured, 1);
              const over = m.claimed > m.measured * 1.15 + 1;
              return (
                <div key={m.label} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
                  <span className="text-[11px]" style={{ color: over ? "#fecaca" : "#c5cbd3" }}>{m.label}</span>
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5"><div className="w-[60%]"><div className="h-2 rounded" style={{ width: `${(m.claimed / max) * 100}%`, minWidth: 2, background: over ? BAD : "#94a3b8" }} /></div><span className="whitespace-nowrap text-[10.5px] text-[#abb3bf]">billed {m.claimed} {m.unit}</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-[60%]"><div className="h-2 rounded" style={{ width: `${(m.measured / max) * 100}%`, minWidth: 2, background: DEVICE }} /></div><span className="whitespace-nowrap text-[10.5px] text-[#abb3bf]">measured {m.measured} {m.unit}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {c.timeline && c.timeline.series.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-white">What the devices recorded</p>
          <div className="space-y-1">
            {c.timeline.series.map((s) => (
              <div key={s.metric}>
                <p className="text-[10.5px] text-[#abb3bf]">{s.label}{s.note && <span className="ml-1 font-mono text-[10px]" style={{ color: s.note.includes("STANDBY") || s.note.includes("NIV") ? WARN : "#8f99a8" }}>{s.note}</span>}</p>
                <div className="flex gap-[2px]">
                  {s.cells.map((v, i) => <span key={i} className="h-3.5 flex-1 rounded-[2px]" title={v === null ? "no reading" : `${Math.round(v * 100)}% on`} style={{ background: v === null ? "rgba(255,255,255,.06)" : `rgba(45,212,191,${0.12 + 0.88 * v})` }} />)}
                </div>
              </div>
            ))}
            <div className="relative h-2.5">
              <span className="absolute top-0 h-2 rounded-sm border border-[#fbbf24]/70 bg-[#fbbf24]/20"
                style={{ left: `${((c.timeline.claimedFrom - c.timeline.from) / (c.timeline.to - c.timeline.from)) * 100}%`, width: `${Math.max(1, ((c.timeline.claimedTo - c.timeline.claimedFrom) / (c.timeline.to - c.timeline.from)) * 100)}%` }} title="The stay as billed" />
            </div>
            <p className="text-right text-[10px] text-[#fbbf24]">the amber bar is the stay as billed</p>
          </div>
        </div>
      )}

      <div>
        <p className="mb-1 font-medium text-white">Findings</p>
        <ul className="space-y-1.5">
          {c.findings.map((f) => (
            <li key={f.rule} className="rounded bg-white/[.04] px-2 py-1.5">
              <p className="flex flex-wrap items-center gap-1.5"><Pill color={flagColor(f.flag)}>{f.flag}</Pill><span className="text-white">{f.title}</span></p>
              {(f.claimed || f.measured) && <p className="mt-0.5 text-[11px] text-[#c5cbd3]">Claimed: {f.claimed || "—"} · Measured: {f.measured || "—"}</p>}
              <p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">{f.evidence}</p>
            </li>
          ))}
        </ul>
      </div>
      <p className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: `${flagColor(c.flag)}55`, background: `${flagColor(c.flag)}12`, color: "#e5e8eb" }}><b>Next step.</b> {c.next}</p>
    </div>
  );
}

function Score({ score }: { score: NonNullable<Report["score"]> }) {
  return (
    <section className={`${panel} p-3`}>
      <p className="font-semibold text-white">How we know: scored against the synthetic ground truth</p>
      <p className="mb-2 text-[11px] text-[#8f99a8]">{score.note}</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Fraud the devices can see" value={`${score.caught} of ${score.fraud_assessable}`} sub={`${Math.round(score.recall * 100)}% caught`} color={OK} />
        <Tile label="Disputes that were wrong" value={String(score.false_disputes)} sub={`of ${score.disputed} disputes`} color={score.false_disputes ? WARN : OK} />
        <Tile label="Honest claims accused" value={String(score.honest_accused)} sub="no honest claim disputed" color={score.honest_accused ? BAD : OK} />
        <Tile label="Sent for review" value={`${score.review_flagged} of ${score.review_fraud}`} sub="severity upcoding: devices cannot confirm a diagnosis" color={LEDGER} />
      </div>
      {score.upcodingEstimatedRp !== null && score.upcodingTrueRp !== null && (
        <p className="mt-2 text-[11.5px] text-[#c5cbd3]">Priced the same way, the four upcoding scenarios came to <b className="text-white">{rp(score.upcodingEstimatedRp)}</b> against <b className="text-white">{rp(score.upcodingTrueRp)}</b> of true overbilling.</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {score.perScenario.filter((s) => s.expected !== "none" || !["honest", "unmonitored_honest"].includes(s.scenario)).map((s) => (
          <span key={s.scenario} className="rounded border px-1.5 py-0.5 font-mono text-[10px]" style={{ color: s.rate >= 0.95 ? OK : s.rate >= 0.6 ? WARN : BAD, borderColor: "rgba(255,255,255,.1)" }} title={`${s.ok} of ${s.claims} handled as expected (${s.expected})`}>{s.scenario} {s.ok}/{s.claims}</span>
        ))}
      </div>
    </section>
  );
}
