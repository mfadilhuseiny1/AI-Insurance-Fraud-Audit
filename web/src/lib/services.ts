/**
 * Answers for the pipeline evaluator's Services (LLM calls, media text extraction, REST models) in the
 * browser: one store per page, filled by batched requests to the API. The evaluator looks answers up
 * synchronously and asks for missing ones; each batch that comes back bumps a version the builder
 * re-evaluates on.
 */
"use client";

import { useEffect, useState } from "react";
import { API_URL } from "./api";
import type { ServiceAnswer, ServiceRequest, Services } from "./pipeline";

const ENDPOINT: Record<ServiceRequest["kind"], string> = {
  llm: "/api/pipeline/ai/llm",
  media: "/api/pipeline/media/extract",
  model: "/api/pipeline/ai/models",
  parse: "/api/pipeline/parse",
  embed: "/api/pipeline/ai/embed",
  // Java UDFs: each call runs one step's rows (Code Repositories)
  udf: "/api/code-repos/tools/udfs/run",
  // Python functions (functions registry): one runner call per step's rows
  pyfn: "/api/functions/tools/pipeline-udf/run",
  // Cipher encrypt / decrypt / hash steps: a column chunk per call (Data Manager or Admin licenses)
  cipher: "/api/cipher/pipeline",
};
const BATCH: Record<ServiceRequest["kind"], number> = { llm: 40, media: 10, model: 40, parse: 4, embed: 64, udf: 1, pyfn: 1, cipher: 4 };

const answers = new Map<string, ServiceAnswer>();
const inFlight = new Set<string>();
const queue = new Map<string, ServiceRequest>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
let active = 0;

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

const toBody = (reqs: ServiceRequest[]) => ({ calls: reqs.map((r) => ({ key: r.key, ...r.payload })) });

async function send(kind: ServiceRequest["kind"], reqs: ServiceRequest[]) {
  active++;
  notify();
  try {
    const res = await fetch(API_URL + ENDPOINT[kind], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toBody(reqs)),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { results: Record<string, ServiceAnswer> };
    for (const r of reqs) answers.set(r.key, body.results[r.key] ?? { error: "No answer" });
  } catch (e) {
    for (const r of reqs) answers.set(r.key, { error: `Request failed: ${(e as Error).message}` });
  } finally {
    for (const r of reqs) inFlight.delete(r.key);
    active--;
    notify();
  }
}

function flush() {
  timer = null;
  const byKind = new Map<ServiceRequest["kind"], ServiceRequest[]>();
  for (const r of queue.values()) (byKind.get(r.kind) ?? byKind.set(r.kind, []).get(r.kind)!).push(r);
  queue.clear();
  for (const [kind, reqs] of byKind) for (let i = 0; i < reqs.length; i += BATCH[kind]) send(kind, reqs.slice(i, i + BATCH[kind]));
}

export const browserServices: Services = {
  get: (key) => answers.get(key),
  request: (r) => {
    if (answers.has(r.key) || inFlight.has(r.key) || queue.has(r.key)) return;
    inFlight.add(r.key);
    queue.set(r.key, r);
    timer ??= setTimeout(flush, 30);
  },
};

/** Forgets answers (e.g. after Clear cache) so they are asked for again. */
export function forgetAnswers(prefix: string) {
  for (const k of [...answers.keys()]) if (k.startsWith(prefix)) answers.delete(k);
  notify();
}

/** Re-renders when answers arrive; returns the store's version (for memo keys) and whether requests are running. */
export function useServicesVersion(): { version: number; busy: boolean } {
  const [, set] = useState(0);
  useEffect(() => {
    const l = () => set((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { version, busy: active > 0 };
}

/** Free call for the AI helpers (explain, generate, regex, notional data). */
export async function aiText<T = string>(prompt: string, opts: { system?: string; schema?: Record<string, unknown>; model?: string; temperature?: number; maxTokens?: number } = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api/pipeline/ai/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, system: opts.system ?? "", schema: opts.schema, model: opts.model, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens }),
  });
  if (!res.ok) {
    let msg = await res.text();
    try {
      msg = JSON.parse(msg).detail ?? msg;
    } catch {}
    throw new Error(msg.slice(0, 300));
  }
  return ((await res.json()) as { value: T }).value;
}
