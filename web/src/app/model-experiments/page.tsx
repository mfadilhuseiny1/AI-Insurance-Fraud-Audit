"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { formatMetric } from "@/components/models/Charts";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import { modelingObjectivesApi, type ModelingObjective } from "@/lib/modelingObjectives";
import { modelOverview, type ExperimentRow, type EvaluationRow, type Overview } from "@/lib/modelOverview";
import { useSearchParams } from "next/navigation";

type View = "benchmarks" | "experiments" | "evaluations" | "records";
const VIEWS: View[] = ["benchmarks", "experiments", "evaluations", "records"];

/** Experiments & Evaluations across models, in one place: the benchmarks (each modeling objective's automatic
 *  evaluation of its submissions, opening on its comparisons), the experiments published with model versions, the
 *  evaluations written to evaluation sets, and the older evidence recorded on objective candidates. */
export default function ModelExperimentsPage() {
  const [data, setData] = useState<{ experiments: ExperimentRow[]; evaluations: EvaluationRow[] } | null>(null);
  const [objectives, setObjectives] = useState<ModelingObjective[]>([]);
  const [error, setError] = useState<string | null>(null);
  const params = useSearchParams();
  const [view, setView] = useState<View>(() => (VIEWS.includes(params.get("view") as View) ? (params.get("view") as View) : "benchmarks"));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [showTests, setShowTests] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    modelOverview.experiments().then(setData, (e: Error) => setError(e.message));
    modelingObjectivesApi.list().then(setObjectives, () => {});
    modelOverview.get().then(setOverview, () => {});
  }, []);
  const records = useMemo(() => objectives.flatMap((o) => o.candidates.flatMap((c) => [
    ...(c.experiments ?? []).map((e) => ({ key: e.id, objective: o, candidate: c.name, name: e.name, at: e.created_at, metrics: e.metrics })),
    ...c.evaluations.map((e) => ({ key: e.id, objective: o, candidate: c.name, name: `${e.metric} evaluation`, at: e.evaluated_at, metrics: { [e.metric]: e.value, ...(e.metrics ?? {}) } })),
  ])).sort((a, b) => b.at.localeCompare(a.at)), [objectives]);
  if (error) return <ApiError message={error} />;
  if (!data) return <Loading />;
  const q = query.toLowerCase();
  const exps = data.experiments.filter((e) => `${e.model} ${e.name}`.toLowerCase().includes(q));
  const evs = data.evaluations.filter((e) => `${e.model} ${e.name} ${e.set}`.toLowerCase().includes(q));
  // test and bug-hunting objectives (api/test_space.py naming) stay out unless asked for
  const isTest = (name: string) => /\btest\b|\(uji\)/i.test(name);
  const allBench = (overview?.objectives ?? []).filter((x) => x.name.toLowerCase().includes(q));
  const bench = allBench.filter((x) => showTests || !isTest(x.name));
  const recs = records.filter((r) => `${r.objective.name} ${r.candidate} ${r.name}`.toLowerCase().includes(q));
  const metrics = (m: Record<string, number>) => Object.entries(m).slice(0, 4).map(([k, v]) => `${k} ${formatMetric(v)}`).join(" · ");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Experiments & Evaluations" icon="graph" href="/model-experiments">
        <Link href="/model-assets" className={buttonClass.ghost}><Icon name="cube" className="h-3.5 w-3.5" /> Models</Link>
        <Link href="/model-studio" className={buttonClass.ghost}><Icon name="cpu" className="h-3.5 w-3.5" /> Model Studio</Link>
      </AppHeader>
      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-line text-xs">
              {([["benchmarks", `Benchmarks (${overview ? overview.objectives.filter((x) => showTests || !isTest(x.name)).length : "…"})`], ["experiments", `Experiments (${data.experiments.length})`], ["evaluations", `Evaluations (${data.evaluations.length})`], ["records", `Objective records (${records.length})`]] as [View, string][]).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setView(v)} className={`px-3 py-1.5 ${view === v ? "bg-panel-2 text-white" : "text-muted"}`}>{label}</button>
              ))}
            </div>
            {view === "benchmarks" && (
              <label className="ml-2 flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} /> Tampilkan uji ({allBench.filter((x) => isTest(x.name)).length})
              </label>
            )}
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className={`${inputClass} ml-auto max-w-xs`} />
          </div>
          <div className="overflow-hidden rounded-xl border border-line">
            {view === "benchmarks" && (!overview ? <p className="bg-panel p-6 text-xs text-muted">Loading…</p> : bench.length ? (
              <table className="w-full bg-panel text-xs">
                <thead className="text-muted"><tr>{["Benchmark (modeling objective)", "Models", "Datasets", "Results", "Failures", "Last built", ""].map((h) => <th key={h} className="px-4 py-2 text-left font-normal">{h}</th>)}</tr></thead>
                <tbody>{bench.map((x) => (
                  <tr key={x.id} className="border-t border-line hover:bg-panel-2">
                    <td className="px-4 py-2.5 text-white">{x.name}</td><td className="px-4 py-2.5 text-soft">{x.submissions}</td>
                    <td className="px-4 py-2.5 text-soft">{x.evaluation_datasets || <span className="text-warn">not configured</span>}</td>
                    <td className="px-4 py-2.5 text-soft">{x.evaluation_results}</td><td className={`px-4 py-2.5 ${x.evaluation_failures ? "text-bad" : "text-soft"}`}>{x.evaluation_failures}</td>
                    <td className="px-4 py-2.5 text-muted">{x.last_built ? when(x.last_built) : "—"}</td>
                    <td className="px-4 py-2.5 text-right"><Link href={`/modeling-objectives?id=${x.id}&view=comparisons`} className="text-ocean hover:underline">Compare models →</Link></td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="bg-panel p-6 text-xs text-muted">No benchmarks yet: create a modeling objective, submit models and add an evaluation dataset.</p>)}
            {view === "experiments" && (exps.length ? exps.map((e) => (
              <Link key={e.id} href={`/model-assets/${e.model_id}`} className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5 text-xs last:border-b-0 hover:bg-panel-2">
                <span className="w-56 truncate text-white">{e.name}</span><span className="w-48 truncate text-soft">{e.model} {e.version}</span>
                <span className="flex-1 truncate font-mono text-muted">{metrics(e.metrics)}</span><span className="w-28 text-right text-muted">{when(e.created_at)}</span>
              </Link>
            )) : <p className="bg-panel p-6 text-xs text-muted">No experiments. Publish one with a model version (model_output.publish(adapter, experiment=…)) or run Model Studio.</p>)}
            {view === "evaluations" && (evs.length ? evs.map((e) => (
              <Link key={e.id} href={`/model-assets/${e.model_id}`} className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5 text-xs last:border-b-0 hover:bg-panel-2">
                <span className="w-56 truncate text-white">{e.set} · {e.name}</span><span className="w-48 truncate text-soft">{e.model} {e.version}</span>
                <span className="flex-1 truncate font-mono text-muted">{metrics(e.metrics)}</span><span className="w-28 text-right text-muted">{when(e.created_at)}</span>
              </Link>
            )) : <p className="bg-panel p-6 text-xs text-muted">No evaluations. Build a transform decorated with @evaluation(&quot;set&quot;) from transforms.api.</p>)}
            {view === "records" && (recs.length ? recs.map((r) => (
              <Link key={r.key} href={`/modeling-objectives?id=${r.objective.id}`} className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5 text-xs last:border-b-0 hover:bg-panel-2">
                <span className="w-56 truncate text-white">{r.name}</span><span className="w-48 truncate text-soft">{r.objective.name} · {r.candidate}</span>
                <span className="flex-1 truncate font-mono text-muted">{metrics(r.metrics)}</span><span className="w-28 text-right text-muted">{when(r.at)}</span>
              </Link>
            )) : <p className="bg-panel p-6 text-xs text-muted">No records: evidence typed by hand on older objective candidates appears here.</p>)}
          </div>
        </div>
      </main>
    </div>
  );
}
