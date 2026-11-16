"use client";
import { API_URL } from "@/lib/api";
import type { AnyRec } from "./types";

/* Klien API fraud: satu tempat untuk semua panggilan, pagination eksplisit. */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}
const page = (limit: number, offset: number) => `limit=${limit}&offset=${offset}`;

export const fraudApi = {
  overview: () => req<AnyRec>("/api/demo/jkn/fraud/overview"),
  cases: (limit: number, offset: number) => req<AnyRec>(`/api/demo/jkn/fraud/cases?${page(limit, offset)}`),
  caseDetail: (id: string) => req<AnyRec>(`/api/demo/jkn/fraud/cases/${id}`),
  graph: (maxEdges = 400) => req<AnyRec>(`/api/demo/jkn/fraud/graph?max_edges=${maxEdges}`),
  billing: (limit: number, offset: number) => req<AnyRec>(`/api/demo/jkn/fraud/billing-checks?${page(limit, offset)}`),
  scores: (limit: number, offset: number) => req<AnyRec>(`/api/demo/jkn/fraud/risk-scores?${page(limit, offset)}`),
  queue: () => req<AnyRec>("/api/demo/jkn/fraud/prepayment/queue"),
  rules: () => req<AnyRec>("/api/demo/jkn/fraud/rules"),
  screen: (body: AnyRec) => req<AnyRec>("/api/demo/jkn/fraud/prepayment/screen", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }),
  activate: (rule_id: string, versi: string) => req<AnyRec>("/api/demo/jkn/fraud/rules/activate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rule_id, versi }),
  }),
  draft: (rule_id: string, versi: string, perubahan: string) => req<AnyRec>("/api/demo/jkn/fraud/rules/draft", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rule_id, versi, perubahan }),
  }),
  submitReview: (rule_id: string, versi: string) => req<AnyRec>("/api/demo/jkn/fraud/rules/submit-review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rule_id, versi }),
  }),
  approve: (rule_id: string, versi: string) => req<AnyRec>("/api/demo/jkn/fraud/rules/approve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rule_id, versi }),
  }),
  caseDecision: (id: string, status: string, catatan = "") => req<AnyRec>(`/api/demo/jkn/fraud/cases/${id}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, catatan }),
  }),
  subgraph: (node: string, depth = 1) => req<AnyRec>(`/api/demo/jkn/fraud/graph/subgraph?node=${encodeURIComponent(node)}&depth=${depth}`),
  startJob: () => req<AnyRec>("/api/demo/jkn/fraud/jobs/batch-scoring", { method: "POST" }),
  job: (id: string) => req<AnyRec>(`/api/demo/jkn/fraud/jobs/${id}`),
  materialized: () => req<AnyRec>("/api/demo/jkn/fraud/materialized"),
  benchmark: () => req<AnyRec>("/api/demo/jkn/fraud/benchmark?iterasi=200"),
  metrics: () => req<AnyRec>("/api/demo/jkn/fraud/metrics"),
  decisions: () => req<AnyRec>("/api/demo/jkn/fraud/decisions?limit=12&offset=0"),
  feedback: (no_sep: string, verdict: string) => req<AnyRec>("/api/demo/jkn/fraud/feedback", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ no_sep, verdict }),
  }),
};
