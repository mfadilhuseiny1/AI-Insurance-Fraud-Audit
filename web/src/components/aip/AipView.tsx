"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { ContractCard, HandoffBlock, Lessons, ScrutinyCard, type Contract } from "@/components/aip/KonsepRun";
import { APP_LABEL, aip, appHref, modelName, txt, usd, type Agent, type AipEvent, type Briefing, type Check, type Panel, type Rec, type Receipt, type Result, type Run, type UiSpec } from "./aipRun";
import { useTampilBiaya } from "./biaya";
import { BriefingHero, Findings, Limits, Markdown, PlainWords, Progress, Recommendations, RefChip } from "./Briefing";
import { BarRank, ChartCard, Contrib, DataTable, Donut, Leaderboard, RegionMap, Stat, TrendLine } from "./viz";
import { AgentGraph, type NexusLink } from "./AgentGraph";
import { AuditDrill, drillOf, type Scope } from "./AuditDrill";

/* The AIP centre view. Idle: the agent architecture — the orchestrator, the domain agents and the Nexus objects each
   one is responsible for. During a run: the stages and what the agents are doing now. After it: the briefing (headline,
   key figures, findings, the visuals the screen composer chose, recommendations with the proposals a person decides
   on, limitations), every number one click from the data it came from; beside it the trail — the plan, every agent's
   steps (each opens to its receipt: arguments, the API call, rows, time, the app to open it in) and the validator's
   verdict (each check opens to its evidence and the validator's own steps). */

const AGENT_COLOR = ["#c23030", "#2d72d2", "#238551", "#d1980b", "#7961db", "#5f6b7c", "#0d8050"];
// a sub-agent wears its parent's colour
const colorOf = (key: string, agents: Agent[]) => key === "validator" ? "#f0b14c"
  : AGENT_COLOR[Math.max(0, agents.findIndex((a) => a.key === key || (a.subagents ?? []).some((s) => s.key === key))) % AGENT_COLOR.length];

export function AgentsMap({ agents, roles, links, rules }: { agents: Agent[]; roles: Record<string, string>; links?: NexusLink[]; rules?: string }) {
  const types = agents.reduce((s, a) => s + a.object_types.length, 0);
  const models = new Set(Object.values(roles).filter(Boolean)).size;
  const stats: [string, number | string][] = [["agen domain", agents.length], ["objek Nexus", types], ["relasi Nexus", links?.length ?? "—"], ["model terbuka", models]];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1a1f25] text-[12px]">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-white/[.06] px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold text-white">Jaringan agen AIP JKN</p>
          <p className="mt-0.5 max-w-[760px] text-[11.5px] leading-snug text-[#abb3bf]">Setiap objek Nexus punya agen yang bertanggung jawab. Orkestrator membagi pertanyaan ke agen pemilik objeknya; tool tiap agen hanya menjangkau objeknya sendiri. Jawaban ditulis, diperiksa ulang ke data oleh validator dari keluarga model lain, lalu disusun jadi layar.</p>
        </div>
        <div className="flex gap-5">
          {stats.map(([label, v]) => <div key={label}><p className="text-[22px] font-semibold leading-none text-white">{v}</p><p className="mt-1 text-[10.5px] text-[#8f99a8]">{label}</p></div>)}
        </div>
      </div>
      <div className="min-h-0 flex-1"><AgentGraph agents={agents} roles={roles} links={links} rules={rules} /></div>
    </div>
  );
}

function ReceiptRow({ r, runId, color, onOpenResult }: { r: Receipt; runId: string; color: string; onOpenResult: (rid: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-white/5 last:border-0">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-1.5 px-2 py-1 text-left hover:bg-white/5">
        <span className={r.ok ? "text-emerald-400" : "text-red-400"}>{r.ok ? "✓" : "✗"}</span>
        <span className="min-w-0 flex-1"><span className="font-mono text-[10.5px]" style={{ color }}>{r.tool}</span> <span className="text-[#d3d8de]">{r.summary}</span></span>
        <span className="shrink-0 text-[10px] tabular-nums text-[#8f99a8]">{(r.ms / 1000).toFixed(1)}s</span>
        <span className="shrink-0 text-[#8f99a8]">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mx-2 mb-1.5 space-y-1 rounded bg-black/30 p-2 text-[10.5px]">
          <p className="text-[#8f99a8]">Argumen</p>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[#e5e8eb]">{JSON.stringify(r.args, null, 1)}</pre>
          {r.request && <><p className="text-[#8f99a8]">Panggilan API (sebagai Anda)</p><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[#c5cbd3]">{r.request.endpoint}{r.request.body ? "\n" + JSON.stringify(r.request.body, null, 1) : ""}</pre></>}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {r.rid && <button onClick={() => onOpenResult(r.rid!)} className="rounded border border-[#4c90f0]/60 px-1.5 py-0.5 text-[#8abbff] hover:bg-[#4c90f0]/15">Lihat hasil {r.rid}{r.rows != null ? ` · ${r.rows} baris` : ""}</button>}
            {(r.links ?? []).map((l, i) => <a key={i} href={appHref(l)} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[#d3d8de] hover:bg-white/10"><Icon name="external" className="h-3 w-3" />{APP_LABEL[l.app] ?? l.app}{l.type ? ` · ${l.type.replace(" (BPJS)", "")}` : ""}{l.name ? ` · ${l.name}` : ""}</a>)}
            <span className="ml-auto text-[#8f99a8]">run {runId}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Verdict({ ev, runId, onOpenResult }: { ev: AipEvent; runId: string; onOpenResult: (rid: string) => void }) {
  const [open, setOpen] = useState(false);
  const [openCheck, setOpenCheck] = useState<number | null>(null);
  const checks = (ev.checks ?? []) as Check[];
  const all = ev.passed === ev.total;
  return (
    <div className="rounded-md border border-white/10 bg-black/20">
      <button onClick={() => setOpen(!open)} className={`m-2 flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${all ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300" : "border-[#f0b14c]/70 bg-[#f0b14c]/10 text-[#f6c86b]"}`}>
        {ev.total ? `${ev.passed} dari ${ev.total} cek lolos` : "validator tidak menghasilkan cek"} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="px-2 pb-2 text-[11px]">
          <p className="mb-1 text-[10.5px] text-[#8f99a8]">Validator · {modelName(ev.model)} — keluarga model berbeda dari penulis; tidak melihat cara agen lain bekerja, memeriksa ulang ke data.</p>
          {checks.map((c, i) => (
            <div key={i} className="border-b border-white/5 last:border-0">
              <button onClick={() => setOpenCheck(openCheck === i ? null : i)} className="flex w-full items-start gap-1.5 py-1 text-left">
                <span className={c.ok ? "text-emerald-400" : "text-red-400"}>{c.ok ? "✓" : "✗"}</span><span className="min-w-0 flex-1 text-[#e5e8eb]">{txt(c.klaim)}</span><span className="text-[#8f99a8]">{openCheck === i ? "▾" : "▸"}</span>
              </button>
              {openCheck === i && <p className="mb-1.5 ml-4 rounded bg-black/30 p-1.5 text-[10.5px] text-[#c5cbd3]">Bukti: {txt(c.bukti) || "—"}</p>}
            </div>
          ))}
          {((ev.steps ?? []) as Receipt[]).length > 0 && <p className="mt-2 text-[10.5px] text-[#8f99a8]">Langkah validator</p>}
          {/* the validator's steps travel inside its verdict, without an event seq; the list never changes once it arrives */}
          {((ev.steps ?? []) as Receipt[]).map((r, i) => <ReceiptRow key={i} r={r} runId={runId} color="#f0b14c" onOpenResult={onOpenResult} />)}
        </div>
      )}
    </div>
  );
}

type ParamDef = { id: string; name: string; type?: string; required?: boolean };
const NUMERIC = new Set(["integer", "long", "short", "double", "float", "decimal", "number"]);

function Proposal({ ev }: { ev: AipEvent }) {
  const [confirm, setConfirm] = useState(false);
  const [params, setParams] = useState<Rec>(ev.parameters ?? {});
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  // every parameter of the action is shown, with what the agent filled in; the runtime resolved the action on this type
  const defs: ParamDef[] = ev.parameter_defs ?? Object.keys(ev.parameters ?? {}).map((k) => ({ id: k, name: k }));
  const apply = async () => {
    setState("busy");
    try {
      let id = ev.action_id as string | undefined;
      if (!id) { // a proposal from before the runtime resolved its action: the action of this name on this object type only
        const types = await fetch(`${API_URL}/api/ontology/action-types`, { cache: "no-store" }).then((r) => r.json());
        id = (types as Rec[]).find((a) => a.display_name === ev.action && a.object_type_id === ev.object_type?.id)?.id;
        if (!id) throw new Error(`action "${ev.action}" tidak ada untuk ${ev.object_type?.name}`);
      }
      const values: Rec = {};
      for (const d of defs) {
        const v = params[d.id];
        if (v === undefined || v === "") {
          if (d.required) throw new Error(`isi ${d.name}`);
          continue;
        }
        values[d.id] = NUMERIC.has(String(d.type)) && typeof v === "string" ? Number(v) : v;
      }
      // the object proposed goes last: no parameter of the agent's can replace it
      const r = await fetch(`${API_URL}/api/ontology/action-types/${id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parameters: { ...values, [ev.object_param ?? "object"]: ev.pk } }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail ?? `${r.status}`);
      setState("done"); setMsg("Dijalankan atas nama Anda dan tercatat di riwayat objek.");
    } catch (e) { setState("error"); setMsg((e as Error).message); }
  };
  return (
    <div className="rounded-md border border-[#f0b14c]/40 bg-[#f0b14c]/5 p-2.5 text-[11.5px]">
      <p className="font-semibold text-[#f6c86b]">Usulan agen · {ev.action}</p>
      <p className="mt-0.5 text-[#d3d8de]">{ev.object_type?.name} <span className="font-mono">{ev.pk}</span>{ev.reason ? ` — ${ev.reason}` : ""}</p>
      {state === "done" || state === "error" ? <p className={`mt-1 ${state === "done" ? "text-emerald-300" : "text-red-300"}`}>{msg}</p> : !confirm ? (
        <button onClick={() => setConfirm(true)} className="mt-1.5 rounded border border-[#f0b14c]/60 px-2 py-0.5 text-[#f6c86b] hover:bg-[#f0b14c]/15">Tinjau & putuskan</button>
      ) : (
        <div className="mt-1.5 space-y-1">
          {defs.map((d) => (
            <label key={d.id} title={d.id} className="flex items-center gap-2"><span className="w-36 shrink-0 text-[#8f99a8]">{d.name}{d.required ? " *" : ""}</span><input value={String(params[d.id] ?? "")} onChange={(e) => setParams({ ...params, [d.id]: e.target.value })} className="min-w-0 flex-1 rounded-sm border border-white/15 bg-black/30 px-1.5 py-0.5 text-[#e5e8eb]" /></label>
          ))}
          <div className="flex gap-1.5 pt-1">
            <button disabled={state === "busy"} onClick={apply} className="rounded bg-[#d9822b] px-2 py-0.5 font-medium text-white hover:brightness-110 disabled:opacity-50">{state === "busy" ? "Menjalankan…" : "Jalankan sebagai saya"}</button>
            <button onClick={() => setConfirm(false)} className="rounded border border-white/15 px-2 py-0.5 text-[#d3d8de]">Batal</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the dynamic screen

function columnsOf(p: Panel, result: Result): { label: string; value: string } {
  // runs before 2026-10-23 named the bar's columns x and y
  return {
    label: p.label ?? p.x ?? result.columns[0],
    value: p.value ?? p.y ?? result.columns.find((c) => typeof result.rows[0]?.[c] === "number") ?? result.columns[1],
  };
}

function PanelView({ p, runId, result, onRef, onDrill }: { p: Panel; runId: string; result?: Result; onRef: (rid: string) => void;
  onDrill?: (row: Rec, kelompok: string | undefined, open: boolean) => boolean }) {
  // an audit answer's rankings and lists lead into the report at a narrower scope (AuditDrill): when its rows have one
  const kelompok = (result as (Result & { kelompok?: string }) | undefined)?.kelompok;
  const pick = onDrill && result?.rows.some((r) => onDrill(r, kelompok, false)) ? (r: Rec) => { onDrill(r, kelompok, true); } : undefined;
  const insight = (p.insight ?? p.note ?? "") + (pick ? " Klik untuk rincian." : "");
  if (p.widget === "text") return <ChartCard title={p.title} insight={insight}><span /></ChartCard>;
  const source = p.rid ? (
    <>
      <span>Sumber</span><RefChip rid={p.rid} onRef={onRef} />
      {result?.object_type && <a href={`/object-explorer?type=${result.object_type.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#8abbff] hover:underline"><Icon name="external" className="h-3 w-3" />{result.object_type.name} di Object Explorer</a>}
      <span className="ml-auto" title={`run ${runId}`}>{result ? `${result.total ?? result.rows.length} baris` : ""}</span>
    </>
  ) : undefined;
  if (!result) return <ChartCard title={p.title} insight={insight} source={source}><p className="py-6 text-center text-[11px] text-[#8f99a8]">Memuat data {p.rid}…</p></ChartCard>;
  const { label, value } = columnsOf(p, result);
  const twin = <DataTable rows={result.rows} fields={[...new Set([label, "nama", value, ...result.columns])].filter((c) => result.columns.includes(c)).slice(0, 6)} types={result.types} onRow={pick} />;
  const single = result.rows.length < 2 && ["bar", "donut", "line", "map"].includes(p.widget);
  const chart = single ? <Stat rows={result.rows} label={label} value={value} />
    : p.widget === "bar" ? <BarRank rows={result.rows} label={label} value={value} highlight={p.highlight} onPick={pick} />
    : p.widget === "donut" ? <Donut rows={result.rows} label={label} value={value} />
    : p.widget === "line" ? <TrendLine rows={result.rows} x={p.x ?? label} value={value} series={p.series} />
    : p.widget === "map" ? <RegionMap rows={result.rows} label={label} value={value} highlight={p.highlight} />
    : p.widget === "leaderboard" ? <Leaderboard rows={result.rows} label={p.label ?? "model"} value={p.value ?? "auprc"} highlight={p.highlight} />
    : p.widget === "contrib" ? <Contrib rows={result.rows} label={p.label ?? "label"} value={p.value ?? "kontribusi"} />
    : null;
  if (chart) return <ChartCard title={p.title} insight={insight} source={source} table={twin}>{chart}</ChartCard>;
  return <ChartCard title={p.title} insight={insight} source={source}><DataTable rows={result.rows} fields={p.fields.length ? p.fields : result.columns.slice(0, 8)} types={result.types} onRow={pick} /></ChartCard>;
}

/** The scope an answer from the audit pack was read at (its plan's "audit"; a comparison of several: national), for the
 *  drill-down; none for an answer the agents read */
function auditScope(events: AipEvent[]): { scope: Scope; label: string } | undefined {
  const plan = events.find((e) => e.type === "plan");
  if (plan?.jalur !== "audit" || !plan.audit) return undefined;
  const scope = (Array.isArray(plan.audit) ? {} : plan.audit) as Scope;
  const label = Object.values(scope).flat().filter(Boolean).join(" · ");
  return { scope, label: label || "Nasional" };
}

/** scope: the audit scope of an answer from the audit pack — its rows then drill into the report (AuditDrill) */
export function DynamicScreen({ spec, runId, onRef, scope }: { spec: UiSpec; runId: string; onRef?: (rid: string) => void; scope?: { scope: Scope; label: string } }) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [path, setPath] = useState<{ scope: Scope; label: string }[] | null>(null);
  // open = false only asks whether a row leads anywhere (a panel shows itself clickable when its rows do)
  const onDrill = scope ? (row: Rec, kelompok: string | undefined, open: boolean): boolean => {
    const next = drillOf(kelompok, row, scope.scope);
    if (next && open) setPath([scope, { scope: next, label: String(row.nama ?? row.group ?? row.faskes_profil_id) }]);
    return !!next;
  } : undefined;
  useEffect(() => {
    const need = Array.from(new Set(spec.panels.map((p) => p.rid).filter((r): r is string => !!r)));
    need.forEach((rid) => aip.result(runId, rid).then((r) => setResults((s) => ({ ...s, [rid]: r }))).catch(() => {}));
  }, [spec, runId]);
  const wide = (p: Panel) => p.widget === "table" || p.widget === "map" || p.widget === "line" || p.widget === "kpi";
  return (
    <section>
      {spec.title && <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[#8f99a8]">{spec.title}</h3>}
      <div className="grid gap-3 xl:grid-cols-2">
        {spec.panels.map((p, i) => (
          <div key={i} className={`min-w-0 ${wide(p) ? "xl:col-span-2" : ""}`}><PanelView p={p} runId={runId} result={p.rid ? results[p.rid] : undefined} onRef={onRef ?? (() => {})} onDrill={onDrill} /></div>
        ))}
      </div>
      {path && <AuditDrill key={JSON.stringify(path)} path={path} onClose={() => setPath(null)} />}
    </section>
  );
}

// the data behind a citation: the result as the agent got it, every row
function RefDrawer({ runId, rid, onClose }: { runId: string; rid: string; onClose: () => void }) {
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { aip.result(runId, rid).then(setRes).catch((e) => setErr((e as Error).message)); }, [runId, rid]);
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[min(640px,100%)] flex-col border-l border-black/40 bg-[#1c2127] shadow-2xl">
      <div className="flex items-start gap-2 border-b border-white/[.06] px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Data di balik angka · {rid}</p>
          <p className="mt-0.5 text-[13px] font-semibold text-white">{res?.title ?? "…"}</p>
          {res?.object_type && <a href={`/object-explorer?type=${res.object_type.id}`} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[#8abbff] hover:underline"><Icon name="external" className="h-3 w-3" />Buka {res.object_type.name} di Object Explorer</a>}
        </div>
        <button onClick={onClose} className="rounded p-1 text-[#abb3bf] hover:bg-white/10 hover:text-white" aria-label="Tutup"><Icon name="x" className="h-4 w-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {err ? <p className="text-[12px] text-red-300">{err}</p> : res ? <DataTable rows={res.rows} fields={res.columns} types={res.types} limit={100} /> : <p className="text-[12px] text-[#8f99a8]">Memuat…</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ a run

function Trail({ run, events, agents, onRef }: { run: Run; events: AipEvent[]; agents: Agent[]; onRef: (rid: string) => void }) {
  const tampilBiaya = useTampilBiaya();
  const plan = events.find((e) => e.type === "plan");
  const receipts = events.filter((e) => e.type === "tool" && e.agent !== "validator") as unknown as Receipt[];
  const byAgent = new Map<string, Receipt[]>();
  receipts.forEach((r) => byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r]));
  const verdict = events.filter((e) => e.type === "verdict" && e.validator !== "scrutiny").at(-1);
  const scrutiny = events.filter((e) => e.type === "verdict" && e.validator === "scrutiny");
  const handoffs = new Map(events.filter((e) => e.type === "handoff").map((e) => [String(e.agent ?? e.handoff?.agent), e.handoff as Rec]));
  const errors = events.filter((e) => e.type === "error");
  const name = (k: string) => agents.find((a) => `agen_${a.key}` === k || a.key === k)?.name
    ?? agents.flatMap((a) => a.subagents ?? []).find((s) => s.key === k)?.name ?? k;
  const usage = (run.agents_usage ?? {}) as Rec;
  return (
    <div className="space-y-3 p-3 text-[12px]">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]"><Icon name="sparkle" className="h-3.5 w-3.5 text-[#9d8cff]" />Jejak kerja agen</p>
      {plan && (
        <div className="rounded-md border border-[#9d8cff]/30 bg-[#9d8cff]/5 p-2.5">
          <p className="text-[11px] font-semibold text-[#c9c0ff]">Rencana orkestrator</p>
          <p className="mt-0.5 leading-snug text-[#e5e8eb]">{plan.summary}</p>
          {plan.aturan && <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">Aturan rencana: {String(plan.aturan)}</p>}
          {plan.jalur === "langsung" && <p className="mt-1 text-[11px] leading-snug text-[#c5cbd3]">Jalur langsung: pertanyaan ini tidak butuh data, jadi tidak ada agen domain maupun validator yang dipanggil — satu panggilan model.</p>}
          <ul className="mt-1.5 space-y-1">{(plan.tasks as Rec[]).map((t, i) => (
            <li key={i} className="text-[11px] leading-snug text-[#c5cbd3]"><span className="font-medium" style={{ color: colorOf(t.agen, agents) }}>{t.name}{t.cakupan ? ` · ${t.cakupan}` : ""}</span>
              {t.skill && <span className="ml-1 rounded bg-white/[.06] px-1 text-[10px] text-[#c5cbd3]">skill {t.skill}</span>} — {t.instruksi}</li>
          ))}</ul>
          <ContractCard contract={(plan.kontrak ?? []) as Contract} judged={verdict?.kontrak as Contract | undefined} />
        </div>
      )}
      {Array.from(byAgent.entries()).map(([k, rs]) => (
        <div key={k} className="rounded-md border border-white/10 bg-black/20">
          <p className="flex items-center gap-1.5 border-b border-white/5 px-2 py-1.5 text-[11px] font-semibold text-white">
            <span className="h-2 w-2 rounded-full" style={{ background: colorOf(k.replace(/^agen_/, ""), agents) }} />{name(k)}
            <span className="ml-auto font-normal text-[#8f99a8]">{rs.length} langkah{tampilBiaya && usage[k]?.usd != null ? ` · ${usd(usage[k].usd)}` : ""}</span>
          </p>
          {rs.map((r) => <ReceiptRow key={r.seq} r={r} runId={run.id} color={colorOf(k.replace(/^agen_/, ""), agents)} onOpenResult={onRef} />)}
          <HandoffBlock h={handoffs.get(k)} />
        </div>
      ))}
      {scrutiny.map((e) => <ScrutinyCard key={e.seq} ev={e} />)}
      {verdict && <Verdict ev={verdict} runId={run.id} onOpenResult={onRef} />}
      <Lessons events={events} />
      {errors.map((e) => <p key={e.seq} className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">{e.agent ? `${e.agent}: ` : ""}{e.message}</p>)}
      <p className="text-[10.5px] tabular-nums text-[#8f99a8]">{run.id}{tampilBiaya ? ` · biaya model ${usd(run.spent_usd)}` : ""}</p>
    </div>
  );
}

// finished turns of a conversation, read once: the next follow-up shows them again without a reload
const earlier = new Map<string, { run: Run; events: AipEvent[] }>();

/** The answers a follow-up continues, oldest first: the whole conversation stays on screen above it, as in a chat, so
 *  the follow-up adds to it instead of starting over (the server gives the model the last three turns). */
function Earlier({ id, depth = 0 }: { id: string; depth?: number }) {
  const [data, setData] = useState<{ run: Run; events: AipEvent[] } | null>(earlier.get(id) ?? null);
  const [ref, setRef] = useState<string | null>(null);
  useEffect(() => {
    if (earlier.has(id)) return;
    let on = true;
    aip.run(id, 0).then((d) => {
      if (d.run.status !== "running") earlier.set(id, d);
      if (on) setData(d);
    }).catch(() => {});
    return () => { on = false; };
  }, [id]);
  if (!data) return null;
  const ev = data.events;
  const briefingEv = ev.filter((e) => e.type === "briefing").at(-1);
  const briefing = briefingEv?.briefing as Briefing | undefined;
  const answer = ev.find((e) => e.type === "answer") ?? ev.filter((e) => e.type === "draft").at(-1);
  const spec = ev.find((e) => e.type === "ui_spec")?.spec as UiSpec | undefined;
  return (
    <>
      {data.run.follow && depth < 20 && <Earlier id={data.run.follow} depth={depth + 1} />}
      <div className="space-y-3">
        <div>
          <p className="text-[11px] text-[#8f99a8]">Pertanyaan sebelumnya</p>
          <p className="text-[13.5px] font-medium leading-snug text-[#d3d8de]">{data.run.q}</p>
        </div>
        {briefing ? <BriefingHero b={briefing} verdict={ev.filter((e) => e.type === "verdict" && e.validator !== "scrutiny").at(-1)} revised={!!briefingEv?.revised} onRef={setRef} />
          : answer ? <section className="rounded-xl border border-white/[.08] bg-[#1c2127] px-5 py-4"><Markdown text={String(answer.text ?? "")} onRef={setRef} /></section> : null}
        {briefing && <PlainWords ev={ev.filter((e) => e.type === "awam").at(-1)} />}
        {spec && <DynamicScreen spec={spec} runId={id} onRef={setRef} scope={auditScope(ev)} />}
        {ref && <RefDrawer runId={id} rid={ref} onClose={() => setRef(null)} />}
      </div>
      <div className="flex items-center gap-2 pt-1 text-[10.5px] uppercase tracking-wider text-[#6b7480]"><span className="h-px flex-1 bg-white/10" />lanjutan<span className="h-px flex-1 bg-white/10" /></div>
    </>
  );
}

/** A follow-up under the answer: asked in this run's thread, so "faskes itu" or "yang kedua" means what the answer named. */
function FollowUp({ onAsk }: { onAsk: (q: string) => void }) {
  const [text, setText] = useState("");
  const send = () => { const q = text.trim(); if (q) { onAsk(q); setText(""); } };
  return (
    <section className="rounded-xl border border-[#5b5fd6]/40 bg-[#1c2127] p-3">
      <p className="mb-1.5 text-[11px] font-semibold text-[#c5cbd3]">Tanya lanjutan tentang jawaban ini</p>
      <div className="flex gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="mis. bagaimana profil faskes peringkat pertama? berapa estimasi kerugiannya?"
          className="min-w-0 flex-1 resize-none rounded-sm border border-white/15 bg-[#111418] px-2 py-1.5 text-[12px] outline-none placeholder:text-[#6b7480] focus:border-[#5b5fd6]" />
        <button onClick={send} disabled={!text.trim()} className="self-end rounded-sm bg-[#5b5fd6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">Tanya</button>
      </div>
    </section>
  );
}

export function RunView({ run, events, agents: catalogue, roles, links, onFollow }: { run: Run | null; events: AipEvent[]; agents: Agent[]; roles?: Record<string, string>; links?: NexusLink[];
  onFollow?: (q: string) => void }) {
  // the small agents this question got (one per province, class, mode …): satellites of the agent that owns their objects
  const agents = useMemo(() => {
    const dyn = events.filter((e) => e.type === "subagents" && e.kind === "agen_kecil");
    if (!dyn.length) return catalogue;
    return catalogue.map((a) => {
      const mine = dyn.filter((e) => e.parent === a.key).flatMap((e) => (e.agents ?? []) as Agent["subagents"] & object);
      return mine.length ? { ...a, subagents: [...(a.subagents ?? []).filter((x) => x.family !== "firma"), ...mine] } : a;
    });
  }, [catalogue, events]);
  const [ref, setRef] = useState<string | null>(null);
  const [trail, setTrail] = useState(true);
  const briefingEv = events.filter((e) => e.type === "briefing").at(-1);
  const briefing = briefingEv?.briefing as Briefing | undefined;
  const verdict = events.filter((e) => e.type === "verdict" && e.validator !== "scrutiny").at(-1);
  const proposals = events.filter((e) => e.type === "proposal");
  const answer = events.find((e) => e.type === "answer") ?? events.filter((e) => e.type === "draft").at(-1);
  const spec = events.find((e) => e.type === "ui_spec")?.spec as UiSpec | undefined;
  const stage = events.filter((e) => e.type === "stage").at(-1);
  const plan = events.find((e) => e.type === "plan");
  const activity = useMemo(() => (events.filter((e) => e.type === "tool").slice(-4) as unknown as Receipt[]).map((r) => ({
    who: r.agent === "validator" ? "Validator" : (agents.find((a) => `agen_${a.key}` === r.agent)?.name ?? r.agent).replace(" (BPJS)", ""),
    what: r.summary, color: colorOf(r.agent.replace(/^agen_/, ""), agents),
  })), [events, agents]);
  // the network, live: who is at work in this stage, which objects the tools have touched
  const live = useMemo(() => {
    const st = String(stage?.stage ?? "");
    const at = new Set<string>();
    if (st === "plan") at.add("orkestrator");
    if (st === "verify") at.add("machine_learning");  // a pasted claim through the inference pipeline, before the plan
    if (st === "evidence") ((events.find((e) => e.type === "plan")?.tasks ?? []) as Rec[]).forEach((t) => at.add(String(t.agen)));
    if (st === "write" || st === "revise") at.add("orkestrator");  // the orchestrator plans and writes
    if (st === "scrutiny") at.add("scrutiny");
    if (st === "validate") at.add("validator");
    if (st === "ui") at.add("ui");
    // sub-agents formed by an agent are at work until it reports them done
    let subs: string[] = [];
    events.forEach((e) => {
      if (e.type === "subagents") subs = ((e.agents ?? []) as Rec[]).map((a) => String(a.key));
      if (e.type === "subagents_done") subs = [];
    });
    subs.forEach((k) => at.add(k));
    const touched = new Set<string>();
    (events.filter((e) => e.type === "tool") as unknown as Receipt[]).forEach((r) => (r.links ?? []).forEach((l) => l.type_id && touched.add(l.type_id)));
    return { at, touched };
  }, [events, stage]);
  // a follow-up opens at its own question, under the answers it continues
  const head = useRef<HTMLDivElement>(null);
  const above = useRef<HTMLDivElement>(null);
  // the turns above load, and their dashboards draw, after this one: the view stays on this turn until the reader scrolls
  useEffect(() => {
    const el = above.current;
    if (!run?.follow || !el) return;
    let held = true;
    const scroller = el.closest(".overflow-y-auto");
    const release = () => { held = false; };
    const go = () => { if (held) head.current?.scrollIntoView({ block: "start" }); };
    go();
    const ro = new ResizeObserver(go);
    ro.observe(el);
    const t = setTimeout(release, 10000);
    ["wheel", "touchstart", "pointerdown", "keydown"].forEach((k) => scroller?.addEventListener(k, release, { passive: true }));
    return () => {
      ro.disconnect(); clearTimeout(t);
      ["wheel", "touchstart", "pointerdown", "keydown"].forEach((k) => scroller?.removeEventListener(k, release));
    };
  }, [run?.id, run?.follow]);
  if (!run) return null;
  const running = run.status === "running";
  // the answer is usable once it is out: the executive summary and the lessons still come in after it
  const answered = events.some((e) => e.type === "answer");
  const fast = plan?.jalur === "cepat";
  return (
    <div className="relative flex min-h-0 flex-1 bg-[#252f3a]">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] space-y-4 px-5 py-4">
          {run.follow && <div ref={above} className="space-y-4"><Earlier key={run.follow} id={run.follow} /></div>}
          <div ref={head} className="flex scroll-mt-4 flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-[#8f99a8]">{run.follow ? "Pertanyaan lanjutan" : "Pertanyaan"}</p>
              <p className="text-[15px] font-medium leading-snug text-white">{run.q}</p>
            </div>
            {(plan?.fokus as string[] | undefined)?.length ? (
              <span title="Pertanyaan lanjutan: agen memperdalam objek ini, tanpa membandingkan ulang dengan yang lain" className="mt-1 rounded-full bg-[#9d8cff]/15 px-2 py-0.5 text-[10.5px] text-[#c9c0ff]">
                fokus: {(plan!.fokus as string[]).join(", ")}
              </span>
            ) : null}
            {plan?.jalur === "audit" && (
              <span title="Paket audit: angka, sebaran, modus, faskes prioritas dan temuan analis dibaca sekaligus dari hasil AI Agent Swarm (kode, tanpa analisis ulang); setiap angka jawaban dicek kode"
                className="mt-1 rounded-full bg-[#4c90f0]/15 px-2 py-0.5 text-[10.5px] text-[#8abbff]">paket audit</span>
            )}
            {plan?.jalur === "cepat" && (
              <span title="Jawaban dibaca langsung dari data (hasil AI Agent Swarm atau satu tipe objek): validator menilai dari bacaan agen dalam satu langkah"
                className="mt-1 rounded-full bg-white/[.06] px-2 py-0.5 text-[10.5px] text-[#c5cbd3]">jalur cepat</span>
            )}
            <span className={`mt-1 rounded-full px-2 py-0.5 text-[10.5px] ${running && !answered ? "bg-[#4c90f0]/20 text-[#8abbff]" : running || run.status === "succeeded" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
              {running ? (answered ? "jawaban siap" : "agen bekerja") : run.status === "succeeded" ? "selesai" : run.status}
            </span>
            <button onClick={() => setTrail(!trail)} className="mt-0.5 hidden items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-[#c5cbd3] hover:bg-white/5 xl:flex">
              <Icon name="sparkle" className="h-3 w-3" />{trail ? "Sembunyikan jejak agen" : "Jejak agen"}
            </button>
          </div>
          {((running && !answered) || !answer) && (
            <div className="space-y-3">
              <Progress stage={stage?.stage as string | undefined} done={!running} activity={activity} fast={fast} audit={plan?.jalur === "audit"} />
              {roles && running && <div className="h-[440px] overflow-hidden rounded-xl border border-white/[.08] bg-[#1a1f25]"><AgentGraph compact agents={agents} roles={roles} links={links} active={live.at} touched={live.touched} /></div>}
            </div>
          )}
          {briefing ? (
            <BriefingHero b={briefing} verdict={verdict} revised={!!briefingEv?.revised} onRef={setRef} />
          ) : answer ? (
            <section className="rounded-xl border border-white/[.08] bg-[#1c2127] px-5 py-4">
              <Markdown text={String(answer.text ?? "")} onRef={setRef} />
              {verdict && Number(verdict.total) > 0 && <p className="mt-2 border-t border-white/[.06] pt-2 text-[11px] text-[#8f99a8]">
                {verdict.validator === "kode" ? `Jalur cepat: angka dicek kode terhadap bacaan agen (${verdict.passed}/${verdict.total} cek)` : `Divalidasi ${verdict.passed}/${verdict.total} cek oleh validator dari keluarga model lain`}
              </p>}
              {answer.jalur === "langsung" && <p className="mt-2 border-t border-white/[.06] pt-2 text-[11px] text-[#8f99a8]">Dijawab langsung oleh orkestrator: tanpa data, tanpa agen domain dan validator (jawaban langsung dilarang memuat angka — angka butuh bacaan agen)</p>}
            </section>
          ) : null}
          {briefing && <PlainWords ev={events.filter((e) => e.type === "awam").at(-1)} writing={running && stage?.stage === "awam"} />}
          {briefing && <Findings b={briefing} onRef={setRef} />}
          {spec && <DynamicScreen spec={spec} runId={run.id} onRef={setRef} scope={auditScope(events)} />}
          {briefing && (briefing.rekomendasi.length > 0 || proposals.length > 0) && (
            <Recommendations b={briefing}>{proposals.map((p) => <Proposal key={p.seq} ev={p} />)}</Recommendations>
          )}
          {!briefing && proposals.length > 0 && <div className="space-y-2">{proposals.map((p) => <Proposal key={p.seq} ev={p} />)}</div>}
          {briefing && <Limits b={briefing} onRef={setRef} />}
          {(answered || (!running && answer)) && onFollow && <FollowUp key={run.id} onAsk={onFollow} />}
          <div className="rounded-lg border border-white/[.06] bg-[#1c2127] xl:hidden"><Trail run={run} events={events} agents={agents} onRef={setRef} /></div>
        </div>
      </div>
      {trail && <aside className="hidden w-[360px] shrink-0 overflow-y-auto border-l border-black/30 bg-[#1c2127] xl:block"><Trail run={run} events={events} agents={agents} onRef={setRef} /></aside>}
      {ref && <RefDrawer runId={run.id} rid={ref} onClose={() => setRef(null)} />}
    </div>
  );
}
