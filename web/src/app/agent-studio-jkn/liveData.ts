"use client";
import { API_URL } from "@/lib/api";
import { fraudApi } from "@/components/demo/fraud/api";

/* The live JKN demo services Agent Studio uses (all data fictitious): the fraud engine's KPIs, pre-payment
   screening and benchmark, and Orbis — retrieval-augmented answers over the Nexus knowledge graph. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

async function req<T = Rec>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}

export type Live = { overview?: Rec; bench?: Rec; metrics?: Rec; queue?: Rec; rules?: Rec; e2e?: Rec; logic?: Rec[] };

export async function loadLive(): Promise<Live> {
  const [overview, bench, metrics, queue, rules, e2e, logic] = await Promise.allSettled([
    fraudApi.overview(), req("/api/demo/jkn/fraud/benchmark"), req("/api/demo/jkn/fraud/metrics"), fraudApi.queue(), fraudApi.rules(), req("/api/demo/jkn/e2e"), req<Rec[]>("/api/ontology/logic"),
  ]);
  const v = <T,>(p: PromiseSettledResult<T>) => (p.status === "fulfilled" ? p.value : undefined);
  return { overview: v(overview), bench: v(bench), metrics: v(metrics), queue: v(queue), rules: v(rules), e2e: v(e2e), logic: v(logic) };
}

// a claim with the patterns the engine is built to catch (over-tariff, upcoding, missing attendance records)
export const SAMPLE_CLAIM = { peserta: "PES-0417", faskes: "RS-01", dokter: "D-01", diagnosa: "J18.9", prosedur: "87.44", severity_diklaim: 3, severity_didukung: 1, tarif_klaim: 9_800_000, dokumen_lengkap: false };
export const screenClaim = () => fraudApi.screen(SAMPLE_CLAIM);
// the JKN AIP agent: an LLM that calls platform tools (Nexus, pipeline, lineage, code, model benchmark, fraud engine)
export const askAgent = (q: string, history: { role: string; text: string }[]) =>
  req("/api/demo/jkn/agent/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, history }) });
export const agentTools = () => req("/api/demo/jkn/agent/tools");
export const askOrbis = (q: string) => req("/api/orbis/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q }) });

export const rp = (n: number | undefined) => n == null ? "—" : n >= 1e9 ? `Rp ${(n / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} M` : n >= 1e6 ? `Rp ${(n / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt` : `Rp ${n.toLocaleString("id-ID")}`;
