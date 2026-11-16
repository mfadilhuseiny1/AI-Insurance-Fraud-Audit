"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AggregationView } from "@/components/functions/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { functions, type FnResult, type FunctionRow } from "@/lib/actions";
import { om, type Filter } from "@/lib/ontologyModel";

/** A Quiver function card: a published function run on fixed values and the analysis's object set cards. */
export type FunctionCardModel = {
  id: string;
  kind: "function";
  title: string;
  function_id: string;
  version?: string;
  /** input name → a fixed value (JSON or text) or "@card:<object set card id>" */
  inputs: Record<string, string>;
};
type SetCard = { id: string; title: string; object_type_id: string; query: string; filters: Filter[] };

async function inputsOf(card: FunctionCardModel, sets: SetCard[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(card.inputs)) {
    if (v === "") continue;
    if (v.startsWith("@card:")) {
      // an object set card: its objects (query and filters) as the function's object set or object list input
      const s = sets.find((x) => x.id === v.slice(6));
      if (!s) continue;
      const r = await om.search({ object_type_id: s.object_type_id, q: s.query, filters: s.filters, limit: 10000 });
      out[k] = { object_type_id: s.object_type_id, primary_keys: r.objects.map((o) => o.primary_key) };
      continue;
    }
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-muted">No value</span>;
  if (typeof v !== "object") return <div className="text-3xl font-semibold tabular-nums">{typeof v === "number" ? v.toLocaleString() : String(v)}</div>;
  const o = v as Record<string, unknown>;
  if (o.__object_set__) return <div className="text-sm">{((o.__object_set__ as { primary_keys: string[] }).primary_keys ?? []).length.toLocaleString()} objects</div>;
  if (Array.isArray(v) && v.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const cols = [...new Set(v.flatMap((r) => Object.keys(r as object)))];
    return (
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c} className="px-2 py-1 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.slice(0, 200).map((r, i) => (
            <tr key={i} className="border-t border-line">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1">
                  {JSON.stringify((r as Record<string, unknown>)[c] ?? null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (Array.isArray(o.buckets)) return <AggregationView value={v as Parameters<typeof AggregationView>[0]["value"]} />;
  return <pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(v, null, 1)}</pre>;
}

export function FunctionCard({ card, sets, onChange, onRemove }: { card: FunctionCardModel; sets: SetCard[]; onChange: (patch: Partial<FunctionCardModel>) => void; onRemove: () => void }) {
  const [fns, setFns] = useState<FunctionRow[]>([]);
  const [res, setRes] = useState<FnResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    functions.list().then((rows) => setFns(rows.filter((f) => f.kind !== "edit")), () => setFns([]));
  }, []);
  const f = fns.find((x) => x.id === card.function_id);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await functions.execute(card.function_id, await inputsOf(card, sets), card.version || undefined, "quiver");
      setRes(r);
      if (!r.ok) setError(r.error ?? "The function failed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  return (
    <section id={`quiver-card-${card.id}`} className="rounded border border-line bg-panel shadow-sm">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="code" className="h-3.5 w-3.5 text-ocean" />
        <input value={card.title} onChange={(e) => onChange({ title: e.target.value })} className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none" />
        <button type="button" disabled={!card.function_id || running} onClick={run} className="rounded px-2 py-1 text-xs text-ocean hover:bg-ocean/10 disabled:opacity-40">
          {running ? "Running…" : "Run"}
        </button>
        <button type="button" onClick={onRemove} className="rounded p-1 text-muted hover:text-bad" aria-label="Remove card">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="grid gap-3 p-3 md:grid-cols-[280px_1fr]">
        <div className="space-y-2 text-xs">
          <select value={card.function_id} onChange={(e) => onChange({ function_id: e.target.value, inputs: {} })} className={inputClass}>
            <option value="">Choose a function…</option>
            {fns.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.version})
              </option>
            ))}
          </select>
          {f?.inputs.map((i) => {
            const takesObjects = i.type.startsWith("object_set:") || i.type.startsWith("array<object:");
            return (
              <label key={i.name} className="block">
                <span className="text-muted">
                  {i.name} · {i.type}
                  {i.required ? " *" : ""}
                </span>
                {takesObjects ? (
                  <select value={card.inputs[i.name] ?? ""} onChange={(e) => onChange({ inputs: { ...card.inputs, [i.name]: e.target.value } })} className={inputClass}>
                    <option value="">Choose an object set card…</option>
                    {sets.map((s) => (
                      <option key={s.id} value={`@card:${s.id}`}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={card.inputs[i.name] ?? ""} onChange={(e) => onChange({ inputs: { ...card.inputs, [i.name]: e.target.value } })} className={`${inputClass} font-mono`} />
                )}
              </label>
            );
          })}
        </div>
        <div className="min-h-24 overflow-auto rounded border border-line p-3">
          {error ? <div className="text-xs text-bad">{error}</div> : res?.ok ? <Value v={res.value} /> : <div className="text-xs text-muted">Choose a function and its inputs, then Run.</div>}
        </div>
      </div>
    </section>
  );
}
