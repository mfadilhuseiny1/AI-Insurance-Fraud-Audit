"use client";
import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { BundleResult, Check, EvidenceView, VersionResult } from "@/lib/faskesVerify/bundle";
import type { ChainOutcome, ChainSnapshot } from "@/lib/faskesVerify/chain";
import type { TamperMode } from "@/lib/faskesVerify/tamper";

/* The insurer's Verifier Desk: take the evidence bundle a faskes exports for one claim and check it WITHOUT trusting the
   faskes's server. Every hash, signature and link is recomputed by this app's own code (src/lib/faskesVerify), then the same
   checks run against what the chain holds. Read-only: no wallet here, nothing stored, no transaction sent. Recording a
   verdict or a payment needs the verifier's or the settlement operator's own key, which belongs on their machine.
   A bundle holds synthetic faskes data only; BPJS claim data never enters this view. */

const OK = "#34d399";
const BAD = "#f87171";
const WARN = "#fbbf24";
const LEDGER = "#a78bfa";
const INFO = "#8abbff";
const DEVICE = "#2dd4bf";
const panel = "rounded border border-white/10 bg-[#1c2127]";

type DeskResult = {
  claim: { claimNo: string; claimId: string; faskes: string; episode: string };
  tamper: TamperMode | null;
  bundle: { generatedAt: number; contract: string; chainId: number | null; statusWhenExported: string; devices: { address: string; kind: string; label: string }[] };
  versions: { version: number; submittedAt: string; readingCount: number; versionHash: string; previousVersionHash: string | null; hasReport: boolean; verdictInBundle: string | null }[];
  offline: BundleResult;
  onchain: { outcome: ChainOutcome; result?: BundleResult };
  evidence: EvidenceView[];
};

const TAMPER: Record<TamperMode, { label: string; what: string }> = {
  reading: { label: "Edit a reading", what: "One device reading was flipped but left signed as it was. Its signature no longer matches what it says." },
  claim: { label: "Rewrite the claim", what: "Version 1's claim document was changed and every hash left alone. The document no longer hashes to its manifest." },
  forge: { label: "Forge every hash", what: "Version 1 was rewritten and every dependent hash recomputed, so the file agrees with itself. A check of the file alone passes. Only the chain remembers what was anchored." },
};

const CHECK_LABEL: Record<string, string> = { files: "Files", "claim-hash": "Claim", evidence: "Evidence", "version-hash": "Hash", link: "Link", ledger: "Ledger", report: "Report" };
const VERSION_CHECK_ORDER = ["files", "claim-hash", "evidence", "version-hash", "link", "ledger", "report"];

const short = (h: string | null | undefined, n = 6) => (h ? `${h.slice(0, 2 + n)}…${h.slice(-4)}` : "—");
const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const nf = (n: number) => n.toLocaleString("en-US");
const hours = (h: number) => (h >= 100 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`);
const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

const Pill = ({ color, children, title }: { color: string; children: ReactNode; title?: string }) => (
  <span title={title} className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium" style={{ color, background: `${color}22`, border: `1px solid ${color}55` }}>{children}</span>
);

/** One small square per check, so a result reads at a glance and every square can be hovered for its detail. */
function CheckStrip({ checks }: { checks: Check[] }) {
  return (
    <div className="flex flex-wrap gap-[3px]" role="img" aria-label={`${checks.filter((c) => c.ok).length} of ${checks.length} checks pass`}>
      {checks.map((c) => (
        <span key={c.id} title={`${c.ok ? "Pass" : "Fail"} · ${c.id}: ${c.detail}`} className="h-3.5 w-3.5 rounded-[3px]" style={{ background: c.ok ? OK : BAD, opacity: c.ok ? 0.75 : 1 }} />
      ))}
    </div>
  );
}

type Standing = "ok" | "warn" | "fail";

export function FaskesVerifierView() {
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [res, setRes] = useState<DeskResult | null>(null);
  const [tamper, setTamper] = useState<TamperMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const run = useCallback(async (text: string, mode: TamperMode | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/faskes-verify${mode ? `?tamper=${mode}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: text, cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof body.error === "string" ? body.error : `${r.status} ${r.statusText}`);
      setRes(body as DeskResult);
      setTamper(mode);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(
    async (f: File | undefined) => {
      if (!f) return;
      if (f.size > 40 * 1024 * 1024) return setErr("The file is larger than 40 MB.");
      const text = await f.text();
      setFile({ name: f.name, size: f.size, text });
      setRes(null);
      await run(text, null);
    },
    [run],
  );

  const chain = res?.onchain.outcome;
  const snapshot: ChainSnapshot | null = chain && chain.reachable && chain.found ? chain.snapshot : null;
  const chainResult = res?.onchain.result;

  const standing: Standing | null = useMemo(() => {
    if (!res) return null;
    if (!res.offline.ok) return "fail";
    if (chainResult) return chainResult.ok ? "ok" : "fail";
    if (chain && chain.reachable) return "fail"; // reached a chain that does not hold this claim
    return "warn";
  }, [res, chain, chainResult]);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[#252d35] text-[12px] text-[#c5cbd3]">
      <div className="mx-auto max-w-[1180px] space-y-4 p-4">
        <header className={`${panel} flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3`}>
          <div className="min-w-[240px] flex-1">
            <h1 className="text-[15px] font-semibold text-white">Verifier Desk: check a faskes claim without trusting the faskes</h1>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#abb3bf]">
              Drop the evidence bundle a faskes exported for one claim. This desk recomputes every hash and device signature with its own code, then asks the chain what was anchored.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Pill color={OK}>Read-only · no wallet</Pill>
            <Pill color={INFO}>Synthetic faskes data only</Pill>
          </div>
        </header>

        {/* intake */}
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void load(e.dataTransfer.files[0]); }}
          className={`${panel} flex cursor-pointer flex-wrap items-center gap-3 px-4 py-4 transition-colors ${drag ? "border-[#8abbff]/70 bg-white/[.06]" : "border-dashed hover:bg-white/[.03]"}`}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/[.07]">
            <Icon name="upload" className="h-5 w-5 text-[#8abbff]" />
          </span>
          <div className="min-w-0 flex-1">
            {file ? (
              <>
                <p className="truncate text-[13px] font-medium text-white">{file.name}</p>
                <p className="text-[11px] text-[#8f99a8]">{kb(file.size)} · drop another file to replace it</p>
              </>
            ) : (
              <>
                <p className="text-[13px] font-medium text-white">Drop an evidence bundle here, or click to choose a file</p>
                <p className="text-[11px] text-[#8f99a8]">From the faskes app: Ledger tab, open a claim, Proof, Evidence bundle (.json)</p>
              </>
            )}
          </div>
          <input ref={input} type="file" accept=".json,application/json" className="sr-only" onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="rounded border border-white/15 bg-white/5 px-2.5 py-1 text-[11.5px] text-white">Choose file</span>
        </label>

        {err && <div role="alert" className="rounded border border-[#f87171]/40 bg-[#f87171]/10 px-3 py-2 text-[12px] text-[#fecaca]">{err}</div>}
        {busy && !res && <div className={`${panel} px-4 py-6 text-center text-[#abb3bf]`}>Recomputing every signature and hash… a bundle of a few thousand readings takes a few seconds.</div>}

        {res && standing && (
          <>
            <Banner res={res} standing={standing} busy={busy} />
            <Meters res={res} chain={res.onchain.outcome} chainResult={chainResult} />
            <VersionChain res={res} snapshot={snapshot} chainResult={chainResult} />
            <Cheat res={res} tamper={tamper} busy={busy} onPick={(m) => file && void run(file.text, m)} />
            <Evidence res={res} snapshot={snapshot} />
            {snapshot && <Ledger snapshot={snapshot} />}
            <Limits />
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- headline */

/** A short, plain list of what failed: one line per kind of check, naming the versions it failed on. */
function describeProblems(results: BundleResult[]): string[] {
  const out = new Set<string>();
  for (const r of results) {
    const byId = new Map<string, { versions: number[]; detail: string }>();
    for (const v of r.versions) {
      for (const c of v.checks) {
        if (c.ok) continue;
        const e = byId.get(c.id) ?? { versions: [], detail: c.detail };
        e.versions.push(v.version);
        byId.set(c.id, e);
      }
    }
    for (const [id, e] of byId) out.add(`${CHECK_LABEL[id] ?? id} on ${e.versions.map((n) => `v${n}`).join(", ")}: ${e.detail}`);
    for (const c of r.checks) if (!c.ok && !/^v\d+$/.test(c.id)) out.add(c.detail);
  }
  return [...out];
}


function Banner({ res, standing, busy }: { res: DeskResult; standing: Standing; busy: boolean }) {
  const chain = res.onchain.outcome;
  const problems = describeProblems([res.offline, ...(res.onchain.result ? [res.onchain.result] : [])]);
  const look = {
    ok: { color: OK, title: "Verified against the chain", icon: "check" as const, text: "Every version, signature and link in this file matches what the ledger holds. Nothing was changed after it was anchored." },
    warn: { color: WARN, title: "Consistent, but not proven", icon: "alert" as const, text: `The file agrees with itself, but the chain could not be read${chain.reachable ? "" : ` (${chain.reason})`}, so the ledger values in it are only the sender's word.` },
    fail: { color: BAD, title: "Do not rely on this evidence", icon: "x" as const, text: "" },
  }[standing];
  const failText = problems.length > 0 ? `${problems.length} problem${problems.length > 1 ? "s" : ""}. ${problems.join(" · ")}` : chain.reachable && !chain.found ? chain.reason : "";
  return (
    <section className="rounded border p-4" style={{ borderColor: `${look.color}66`, background: `${look.color}12` }} aria-live="polite">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full" style={{ background: `${look.color}30`, color: look.color }}>
          <Icon name={look.icon} className="h-6 w-6" />
        </span>
        <div className="min-w-[240px] flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[17px] font-semibold text-white">
            {look.title}
            {res.tamper && <Pill color={WARN} title="You asked the desk to break its in-memory copy. The file you chose is unchanged.">Demonstration copy</Pill>}
            {busy && <span className="text-[11px] font-normal text-[#abb3bf]">re-checking…</span>}
          </p>
          <p className="mt-0.5 text-[12px] text-[#dfe3e8]">{standing === "fail" ? failText : look.text}</p>
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-0.5 text-[11px]">
          <dt className="text-[#8f99a8]">Claim</dt><dd className="font-mono text-white">{res.claim.claimNo}</dd>
          <dt className="text-[#8f99a8]">Episode</dt><dd className="font-mono text-white">{res.claim.episode}</dd>
          <dt className="text-[#8f99a8]">On the ledger</dt><dd className="text-white">{res.onchain.outcome.reachable && res.onchain.outcome.found ? `${res.onchain.outcome.snapshot.status} · ${res.onchain.outcome.snapshot.versionCount} version${res.onchain.outcome.snapshot.versionCount > 1 ? "s" : ""}` : "not read"}</dd>
        </dl>
      </div>
    </section>
  );
}

/* ----------------------------------------------- the two ways of checking */

function Meters({ res, chain, chainResult }: { res: DeskResult; chain: ChainOutcome; chainResult: BundleResult | undefined }) {
  const offlineFailed = res.offline.checks.filter((c) => !c.ok).length;
  const chainFailed = chainResult?.checks.filter((c) => !c.ok).length ?? 0;
  return (
    <section className="grid gap-3 md:grid-cols-2">
      <div className={`${panel} p-3`}>
        <p className="flex items-center gap-1.5 font-semibold text-white"><Icon name="doc" className="h-3.5 w-3.5 text-[#8abbff]" />From the file alone</p>
        <p className="mb-2 text-[11px] text-[#8f99a8]">Hashes, signatures and links recomputed. The ledger values it quotes are taken as given.</p>
        <CheckStrip checks={res.offline.checks} />
        <p className="mt-2 text-[11.5px]" style={{ color: offlineFailed ? BAD : OK }}>{offlineFailed ? `${offlineFailed} of ${res.offline.checks.length} checks fail` : `all ${res.offline.checks.length} checks pass`}</p>
      </div>
      <div className={`${panel} p-3`}>
        <p className="flex items-center gap-1.5 font-semibold text-white"><span style={{ color: LEDGER }}><Icon name="link" className="h-3.5 w-3.5" /></span>Against the chain</p>
        <p className="mb-2 text-[11px] text-[#8f99a8]">The same checks, using what the chain holds instead, plus device registration and timing.</p>
        {chainResult ? (
          <>
            <CheckStrip checks={chainResult.checks} />
            <p className="mt-2 text-[11.5px]" style={{ color: chainFailed ? BAD : OK }}>{chainFailed ? `${chainFailed} of ${chainResult.checks.length} checks fail` : `all ${chainResult.checks.length} checks pass`}</p>
          </>
        ) : (
          <p className="text-[12px]" style={{ color: chain.reachable ? BAD : WARN }}>
            {!chain.reachable ? `The node at ${chain.node} could not be read: ${chain.reason}` : !chain.found ? chain.reason : "The chain answered."}
          </p>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------- the chain of versions */

function VersionChain({ res, snapshot, chainResult }: { res: DeskResult; snapshot: ChainSnapshot | null; chainResult: BundleResult | undefined }) {
  const source = chainResult ?? res.offline;
  const byVersion = (r: BundleResult, v: number): VersionResult | undefined => r.versions.find((x) => x.version === v);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className={`${panel} p-3`}>
      <p className="font-semibold text-white">Every version, linked</p>
      <p className="mb-3 text-[11px] text-[#8f99a8]">Each version names the hash of the one before it. A verdict belongs to one version only. Checked {chainResult ? "against the chain" : "from the file alone"}.</p>
      <div className="flex items-stretch overflow-x-auto pb-1">
        {res.versions.map((v, i) => {
          const r = byVersion(source, v.version);
          const decision = snapshot?.decisions.find((d) => d.version === v.version);
          const verdict = decision?.verdict ?? v.verdictInBundle;
          const color = verdict === "Approve" ? OK : verdict === "Dispute" ? BAD : verdict === "Pend" ? WARN : INFO;
          const chainTime = snapshot?.versions[i]?.submittedAt;
          const checks = VERSION_CHECK_ORDER.map((id) => r?.checks.find((c) => c.id === id)).filter((c): c is Check => Boolean(c));
          return (
            <Fragment key={v.version}>
              {i > 0 && (
                <div className="flex w-10 shrink-0 flex-col items-center justify-center" title={`v${v.version} names the version hash of v${v.version - 1}: ${short(v.previousVersionHash, 8)}`}>
                  <div className="h-px w-full bg-white/25" />
                  <span className="my-0.5" style={{ color: LEDGER }}><Icon name="link" className="h-3 w-3" /></span>
                  <div className="h-px w-full bg-white/25" />
                </div>
              )}
              <div className="min-w-[230px] flex-1 rounded-lg border p-3" style={{ borderColor: r ? (r.ok ? `${OK}88` : BAD) : "rgba(255,255,255,.1)", background: "#161a1f" }}>
                <div className="flex items-center justify-between">
                  <span className="text-[16px] font-semibold text-white">v{v.version}</span>
                  <span className="font-mono text-[10.5px] text-[#8f99a8]" title={v.versionHash}>{short(v.versionHash, 4)}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {verdict ? <Pill color={color}>{verdict === "Approve" ? "Approved" : verdict === "Dispute" ? "Disputed" : "Pending"}{decision ? " · on chain" : " · in bundle only"}</Pill> : <Pill color={INFO}>Awaiting verdict</Pill>}
                </div>
                <p className="mt-2 text-[11px] text-[#8f99a8]">{nf(v.readingCount)} signed readings · {chainTime ? `anchored ${when(chainTime)}` : `submitted ${v.submittedAt ? when(Date.parse(v.submittedAt)) : "—"}`}</p>
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {checks.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setOpen(open === `${v.version}:${c.id}` ? null : `${v.version}:${c.id}`)}
                      title={c.detail}
                      aria-label={`v${v.version} ${CHECK_LABEL[c.id] ?? c.id}: ${c.ok ? "pass" : "fail"}`}
                      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px]"
                      style={{ color: c.ok ? OK : BAD, borderColor: c.ok ? `${OK}44` : `${BAD}99`, background: c.ok ? "transparent" : `${BAD}18` }}
                    >
                      <Icon name={c.ok ? "check" : "x"} className="h-2.5 w-2.5" />{CHECK_LABEL[c.id] ?? c.id}
                    </button>
                  ))}
                </div>
                {open?.startsWith(`${v.version}:`) && (
                  <p className="mt-2 rounded bg-white/[.05] px-2 py-1.5 text-[11px] leading-snug text-[#e5e8eb]">{checks.find((c) => `${v.version}:${c.id}` === open)?.detail}</p>
                )}
                {r && !r.ok && !open && <p className="mt-2 text-[11px]" style={{ color: BAD }}>Tap a red check to see why.</p>}
              </div>
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ try to cheat */

function Cheat({ res, tamper, busy, onPick }: { res: DeskResult; tamper: TamperMode | null; busy: boolean; onPick: (m: TamperMode | null) => void }) {
  const modes = Object.keys(TAMPER) as TamperMode[];
  return (
    <section className={`${panel} p-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-white">Try to cheat it</p>
        <span className="text-[11px] text-[#8f99a8]">Break a copy in memory and watch the checks catch it. Your file is never changed.</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {modes.map((m) => (
          <button key={m} type="button" disabled={busy} onClick={() => onPick(m)} aria-pressed={tamper === m}
            className={`rounded border px-2.5 py-1.5 text-[11.5px] ${tamper === m ? "border-[#fbbf24]/70 bg-[#fbbf24]/15 text-white" : "border-white/15 bg-white/5 text-[#d3d8de] hover:bg-white/10"} disabled:opacity-50`}>
            {TAMPER[m].label}
          </button>
        ))}
        <button type="button" disabled={busy || tamper === null} onClick={() => onPick(null)} className="rounded border border-white/15 px-2.5 py-1.5 text-[11.5px] text-[#d3d8de] hover:bg-white/10 disabled:opacity-40">Back to the original</button>
      </div>
      {tamper && (
        <p className="mt-2 rounded border border-[#fbbf24]/30 bg-[#fbbf24]/10 px-2.5 py-2 text-[11.5px] text-[#fde68a]">
          {TAMPER[tamper].what}
          {tamper === "forge" && res.offline.ok && <b className="mt-1 block text-white">The file alone still verifies. That is why the chain is read.</b>}
        </p>
      )}
    </section>
  );
}

/* ---------------------------------------------- what the devices recorded */

function Evidence({ res, snapshot }: { res: DeskResult; snapshot: ChainSnapshot | null }) {
  const view = res.evidence[res.evidence.length - 1];
  if (!view || view.metrics.length === 0) return null;
  const registered = new Map(snapshot?.devices.map((d) => [d.address.toLowerCase(), d.registered]));
  return (
    <section className={`${panel} p-3`}>
      <p className="font-semibold text-white">What the devices recorded</p>
      <p className="mb-3 text-[11px] text-[#8f99a8]">
        From the signed readings of v{view.version}, {view.from && view.to ? `${when(view.from)} to ${when(view.to)}` : "no timestamps"}. Brighter means the state was on for more of that stretch; gaps are stretches with no reading.
      </p>
      <div className="space-y-2.5">
        {view.metrics.map((m) => (
          <div key={m.metric}>
            <div className="mb-0.5 flex flex-wrap items-baseline gap-x-3 text-[11.5px]">
              <span className="font-medium text-white">{m.label}</span>
              {m.binary ? <span style={{ color: DEVICE }}>{hours(m.activeHours ?? 0)} on</span> : <span className="text-[#c5cbd3]">mean {m.mean?.toFixed(1)} · range {m.min}–{m.max}</span>}
              <span className="text-[#8f99a8]">{nf(m.samples)} readings</span>
              {m.missing > 0 && <span style={{ color: WARN }} title="Readings missing by the device's own counter">{nf(m.missing)} missing</span>}
            </div>
            {m.ribbon && (
              <div className="flex gap-[2px]" role="img" aria-label={`${m.label} over time`}>
                {m.ribbon.map((f, i) => (
                  <span key={i} className="h-5 flex-1 rounded-[2px]" title={f === null ? "no reading" : `${Math.round(f * 100)}% on`} style={{ background: f === null ? "rgba(255,255,255,.06)" : `rgba(45,212,191,${0.12 + 0.88 * f})` }} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-[#8f99a8]">Signed by</span>
        {view.devices.map((d) => {
          const known = registered.get(d.toLowerCase());
          return (
            <span key={d} className="inline-flex items-center gap-1 rounded border border-white/15 bg-[#111418] px-1.5 py-px font-mono text-[10.5px] text-[#e5e8eb]" title={known === undefined ? d : known ? `${d}: registered on chain to the claim's owner` : `${d}: NOT registered, or revoked before it signed`}>
              {known !== undefined && <span style={{ color: known ? OK : BAD }}><Icon name={known ? "check" : "x"} className="h-2.5 w-2.5" /></span>}
              {d.slice(0, 6)}…{d.slice(-4)}
            </span>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------- the ledger's story */

function Ledger({ snapshot }: { snapshot: ChainSnapshot }) {
  type Ev = { at: number; color: string; title: string; note: string };
  const events: Ev[] = [];
  for (const v of snapshot.versions) events.push({ at: v.submittedAt, color: INFO, title: `v${v.version} anchored`, note: `version hash ${short(v.versionHash, 6)}` });
  for (const d of snapshot.decisions) events.push({ at: d.decidedAt, color: d.verdict === "Approve" ? OK : d.verdict === "Dispute" ? BAD : WARN, title: `v${d.version} ${d.verdict === "Approve" ? "approved" : d.verdict === "Dispute" ? "disputed" : "pended"}`, note: `verifier ${short(d.verifierId, 4)} · report ${short(d.reportHash, 4)}` });
  if (snapshot.settlement) events.push({ at: snapshot.settlement.settledAt, color: LEDGER, title: "Settled", note: `payment ref ${short(snapshot.settlement.paymentRef, 4)} · the amount stays off chain, only its commitment is recorded` });
  events.sort((a, b) => a.at - b.at);
  return (
    <section className={`${panel} p-3`}>
      <p className="font-semibold text-white">What the ledger recorded</p>
      <p className="mb-3 text-[11px] text-[#8f99a8]">Read from {snapshot.node}, chain {snapshot.chainId}, contract {short(snapshot.contract, 4)}. Times are the chain&apos;s own clock.</p>
      <ol className="relative ml-1.5 space-y-2.5 border-l border-white/15 pl-4">
        {events.map((e, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[21px] top-[3px] h-2.5 w-2.5 rounded-full ring-2 ring-[#1c2127]" style={{ background: e.color }} />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-white">{e.title}</span>
              <span className="text-[11px] text-[#8f99a8]">{when(e.at)}</span>
            </div>
            <p className="text-[11px] text-[#abb3bf]">{e.note}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ limits */

function Limits() {
  return (
    <section className="rounded border border-white/10 bg-[#1c2127]/60 p-3 text-[11.5px] leading-relaxed text-[#abb3bf]">
      <p className="font-semibold text-[#fbd38d]">What a pass does and does not mean</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>It proves the claim, its device readings and the audit report are exactly what was anchored, in this order, and which registered devices signed the readings.</li>
        <li>It does not prove the care was needed or well given, and it does not prove a device was honest: a device&apos;s clock is its own word, and the timing check only catches readings dated after the claim reached the chain.</li>
        <li>The decision stays with a person. Recording a verdict or a payment needs the verifier&apos;s or the settlement operator&apos;s own wallet, so this desk only reads.</li>
      </ul>
    </section>
  );
}
