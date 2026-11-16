"use client";

import { useEffect, useState } from "react";
import { ObjectPicker } from "@/components/ontology/parts";
import { fieldClass } from "@/components/pipeline/Modal";
import { fmtValue, resolveRange, tsOntology, type Analysis, type CardResult, type Interval, type Logic, type ObjRef, type QueryResult } from "@/lib/timeseries";
import { RangePicker, TsChart, type ChartSeries } from "./TsChart";

/** The cards a card depends on, itself included, in logic order (what "Create derived series" saves). */
export function upstream(logic: Logic, id: string): Logic {
  const by = new Map(logic.cards.map((c) => [c.id, c]));
  const need = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const cid = todo.pop()!;
    const c = by.get(cid);
    if (!c || need.has(cid)) continue;
    need.add(cid);
    const cfg = c.config as Record<string, unknown>;
    for (const k of ["input", "segments", "at_card", "datetime_card"]) if (typeof cfg[k] === "string" && cfg[k]) todo.push(cfg[k] as string);
    for (const r of (cfg.inputs as string[]) ?? []) todo.push(r);
    for (const k of ["formula", "condition", "recovery"]) for (const m of String(cfg[k] ?? "").matchAll(/\$([A-Z][A-Z0-9]*)/g)) todo.push(m[1]);
  }
  return { cards: logic.cards.filter((c) => need.has(c.id)), output: id };
}

/** One plot: the series cards it overlays and the intervals of any search cards in it. */
export function Plot({ ids, results, logic, height = 260 }: { ids: string[]; results: QueryResult | null; logic: Logic; height?: number }) {
  const series: ChartSeries[] = [];
  const intervals: Interval[] = [];
  for (const id of ids) {
    const r: CardResult | undefined = results?.cards[id];
    if (!r) continue;
    if (r.kind === "series") {
      const title = logic.cards.find((c) => c.id === id)?.title;
      series.push({ key: id, label: `$${id} ${title || r.label}`, unit: r.unit, points: r.points, categorical: r.categorical });
    } else if (r.kind === "intervals") intervals.push(...r.intervals);
  }
  return <TsChart series={series} intervals={intervals} height={height} empty={results ? "Add series cards to this plot." : "Running…"} />;
}

/**
 * A Quiver dashboard: the analysis' chosen plots and numbers with its inputs (the object and parameter cards).
 * Workshop embeds it, passing the object and parameter values (key it by them: they seed its inputs).
 */
export function QuiverDashboard({
  analysis,
  root: rootIn,
  params: paramsIn,
  range: rangeIn,
  resource,
  editableInputs = true,
}: {
  analysis: Analysis;
  root?: ObjRef | null;
  params?: Record<string, unknown>;
  range?: { start?: string | null; end?: string | null; last?: string | null };
  resource?: string;
  editableInputs?: boolean;
}) {
  const [root, setRoot] = useState<ObjRef | null>(rootIn ?? analysis.root);
  const [params, setParams] = useState<Record<string, unknown>>(paramsIn ?? {});
  const [range, setRange] = useState(rangeIn ?? analysis.range);
  const [results, setResults] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = JSON.stringify({ l: analysis.logic, root, params, range });
  useEffect(() => {
    if (!analysis.logic.cards.length) return;
    const { start, end } = resolveRange(range);
    tsOntology
      .query({ logic: analysis.logic, root, start, end, params, resource: resource ?? `quiver:${analysis.id}`, buckets: 400 })
      .then((r) => (setResults(r), setError(null)), (e: Error) => setError(e.message));
    // spec holds every input of the query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, resource]);
  const items = analysis.dashboard.cards.length ? analysis.dashboard.cards : analysis.plots.map((p) => p.id);
  const inputs = analysis.dashboard.inputs;
  return (
    <div className="space-y-3">
      {editableInputs && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {analysis.root && (
            <div className="flex items-center gap-2">
              <span className="text-muted">Object</span>
              <div className="w-56">
                <ObjectPicker objectTypeId={analysis.root.object_type_id} value={root?.primary_key ?? ""} onChange={(pk) => setRoot(pk ? { object_type_id: analysis.root!.object_type_id, primary_key: pk } : null)} />
              </div>
            </div>
          )}
          {inputs.map((id) => {
            const c = analysis.logic.cards.find((x) => x.id === id);
            if (!c) return null;
            return (
              <label key={id} className="flex items-center gap-1.5">
                <span className="text-muted">{c.title || `$${id}`}</span>
                <input
                  value={String(params[id] ?? (c.config as Record<string, unknown>).value ?? "")}
                  onChange={(e) => setParams({ ...params, [id]: c.type === "param_number" ? Number(e.target.value) : e.target.value })}
                  className={`${fieldClass} w-32 py-1 text-xs`}
                />
              </label>
            );
          })}
          <RangePicker value={range} onChange={setRange} />
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((id) => {
          const plot = analysis.plots.find((p) => p.id === id);
          if (plot)
            return (
              <div key={id} className="rounded-xl border border-line bg-panel p-3 md:col-span-2">
                <div className="mb-1 text-sm font-medium">{plot.title}</div>
                <Plot ids={plot.cards} results={results} logic={analysis.logic} height={220} />
              </div>
            );
          const r = results?.cards[id];
          const c = analysis.logic.cards.find((x) => x.id === id);
          if (!c) return null;
          return (
            <div key={id} className="rounded-xl border border-line bg-panel p-3">
              <div className="text-xs text-muted">{c.title || `$${id}`}</div>
              {r?.kind === "scalar" ? (
                <div className="text-2xl font-semibold tabular-nums">{fmtValue(r.value)}</div>
              ) : r?.kind === "series" ? (
                <Plot ids={[id]} results={results} logic={analysis.logic} height={160} />
              ) : r?.kind === "intervals" ? (
                <div className="text-2xl font-semibold">{r.count} intervals</div>
              ) : (
                <div className="text-xs text-bad">{r?.kind === "error" ? r.error : "…"}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
