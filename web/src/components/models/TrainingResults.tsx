"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EvalView, type ModelEval } from "@/components/models/EvalCharts";
import { formatMetric, LoggedTableView } from "@/components/models/Charts";
import { trainedModels, type Experiment } from "@/lib/modelAssets";

// what an evaluation key means, when the training names it so (ml_models/evaluasi.py prefixes)
const EVAL_LABEL: Record<string, string> = { kunci: "Answer key (all customers)", p2tl_cv5: "P2TL labels · 5-fold CV", holdout: "Holdout", test: "Test set", validation: "Validation" };
const label = (s: string) => s.replace(/[_/]+/g, " ");

/** A model version's training run: its evaluations drawn natively (KPIs, confusion matrix, ROC, precision-recall,
 *  calibration, score distribution) with a switch between them, then the other metrics, the report tables and any
 *  figures the run logged. From the version's experiment (an MLflow run). */
export function TrainingResults({ modelId, experimentId, compact = false }: { modelId: string; experimentId: string; compact?: boolean }) {
  const [exp, setExp] = useState<Experiment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    trainedModels.experiment(modelId, experimentId).then(setExp, (e: Error) => setError(e.message));
  }, [modelId, experimentId]);
  if (error) return <p className="text-xs text-bad">{error}</p>;
  if (!exp) return <div className="h-40 animate-pulse rounded-xl bg-panel-2/40" />;
  const evals = Object.entries(exp.evaluations ?? {});
  const current = evals.find(([k]) => k === active) ?? evals[0];
  // Keep every scalar series: this chart complements the final evaluation summaries above with its history by step.
  const others = Object.entries(exp.metrics)
    .filter(([, points]) => points.length > 0);
  const images = Object.entries(exp.images).map(([n, s]) => [n, s.at(-1)] as const).filter((x): x is readonly [string, { step: number; png: string; caption: string }] => !!x[1]);
  const tables = Object.entries(exp.tables).filter(([n]) => !current || n.startsWith(current[0]) ? /report/i.test(n) : false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-line bg-panel-2/60 px-2.5 py-0.5 text-[11px] text-soft">Run · {exp.name}</span>
        {Object.entries(exp.params).slice(0, compact ? 2 : 4).map(([k, v]) => (
          <span key={k} className="max-w-[16rem] truncate rounded-full border border-line px-2.5 py-0.5 text-[11px] text-muted" title={`${k}: ${String(v)}`}>{k}: <span className="text-soft">{String(v)}</span></span>
        ))}
        {compact && <Link href={`/model-assets/${modelId}?tab=experiments`} className="ml-auto text-[11px] text-ocean hover:underline">Open the experiment →</Link>}
      </div>
      {current ? (
        <>
          {evals.length > 1 && (
            evals.length > 2 ? (
              <CompareTable evals={evals} active={current[0]} onPick={setActive} />
            ) : (
              <div className="inline-flex rounded-lg border border-line bg-panel-2/40 p-0.5 text-xs">
                {evals.map(([k]) => (
                  <button key={k} type="button" onClick={() => setActive(k)}
                    className={`rounded-md px-3 py-1.5 transition ${current[0] === k ? "bg-ocean/20 text-white shadow-sm" : "text-muted hover:text-white"}`}>
                    {EVAL_LABEL[k] ?? label(k)}
                  </button>
                ))}
              </div>
            )
          )}
          {evals.length > 2 && <div className="text-xs font-medium text-soft">{EVAL_LABEL[current[0]] ?? label(current[0])}</div>}
          <EvalView e={current[1]} />
        </>
      ) : others.length === 0 && images.length === 0 ? (
        <p className="text-xs text-muted">This run logged no evaluation. Use <code>log_klasifikasi(...)</code> or <code>log_regresi(...)</code> from ml_models/evaluasi.py (Model Training template), or MLflow metrics.</p>
      ) : null}
      {!compact && others.length > 0 && (
        <section className="rounded-xl border border-line bg-panel p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold text-white">All metric trends</h3>
              <p className="mt-0.5 text-[11px] text-muted">Every scalar metric logged by this run, plotted across its training steps. Each chart has its own scale; hover a point for its exact value.</p>
            </div>
            <span className="text-[10px] text-muted">{others.length} metrics</span>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {others.map(([name, points]) => <MetricTrend key={name} name={name} points={points} />)}
          </div>
        </section>
      )}
      {!compact && tables.map(([name, t]) => (
        <details key={name} className="rounded-xl border border-line bg-panel">
          <summary className="cursor-pointer px-3 py-2 text-xs text-soft">{label(name)}</summary>
          <div className="p-3 pt-0"><LoggedTableView table={t} /></div>
        </details>
      ))}
      {!compact && images.length > 0 && (
        <details className="rounded-xl border border-line bg-panel" open={!current}>
          <summary className="cursor-pointer px-3 py-2 text-xs text-soft">Figures logged by the run ({images.length})</summary>
          <div className="grid grid-cols-2 gap-3 p-3 pt-0 lg:grid-cols-4">
            {images.map(([name, img]) => (
              <button key={name} type="button" onClick={() => setZoom(name)} className="overflow-hidden rounded-lg border border-line bg-white text-left hover:border-ocean" title="Enlarge">
                {/* eslint-disable-next-line @next/next/no-img-element -- a logged PNG (data URL) */}
                <img src={`data:image/png;base64,${img.png}`} alt={label(name)} className="w-full" />
              </button>
            ))}
          </div>
        </details>
      )}
      {zoom && exp.images[zoom] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a logged PNG (data URL) */}
          <img src={`data:image/png;base64,${exp.images[zoom].at(-1)!.png}`} alt={label(zoom)} className="max-h-full max-w-full rounded bg-white" />
        </div>
      )}
    </div>
  );
}

type MetricPoint = { step: number; value: number; at: string };

/** Compact, individually scaled trend so metrics with different units remain readable. */
function MetricTrend({ name, points }: { name: string; points: MetricPoint[] }) {
  const data = points.filter((p) => Number.isFinite(p.value)).slice().sort((a, b) => a.step - b.step);
  if (!data.length) return null;
  const first = data[0].value, latest = data[data.length - 1].value;
  const delta = latest - first;
  const scale = Math.max(Math.abs(first), Math.abs(latest), 1e-9);
  const isStable = Math.abs(delta) <= scale * 0.005;
  const lowerIsBetter = /(^|[/_. -])(loss|error|rmse|mae|mse|mape|logloss|latency|duration)([/_. -]|$)/i.test(name);
  const higherIsBetter = /(^|[/_. -])(accuracy|precision|recall|f1|auc|r2|mcc|score|map)([/_. -]|$)/i.test(name);
  const knownDirection = lowerIsBetter || higherIsBetter;
  const improved = lowerIsBetter ? delta < 0 : higherIsBetter ? delta > 0 : false;
  const tone = isStable ? "text-muted" : !knownDirection ? "text-ocean" : improved ? "text-emerald-300" : "text-amber-300";
  const trend = isStable ? "Stable" : knownDirection ? (improved ? "Improving" : "Declining") : `${delta > 0 ? "↑" : "↓"} ${formatMetric(Math.abs(delta))}`;
  const W = 320, H = 76, pad = 5;
  const values = data.map((p) => p.value);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { const bump = Math.max(Math.abs(lo) * 0.05, 0.01); lo -= bump; hi += bump; }
  const minStep = data[0].step, maxStep = data[data.length - 1].step;
  const x = (p: MetricPoint, i: number) => pad + (maxStep === minStep ? i / Math.max(1, data.length - 1) : (p.step - minStep) / (maxStep - minStep)) * (W - pad * 2);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2);
  const polyline = data.map((p, i) => `${x(p, i)},${y(p.value)}`).join(" ");
  const color = isStable || !knownDirection ? "#4cc2ff" : improved ? "#34d399" : "#f5a524";
  return (
    <article className="min-w-0 rounded-lg border border-line bg-ink/35 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-[11px] font-medium text-soft" title={name}>{name}</h4>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-white">{formatMetric(latest)}</div>
        </div>
        <span className={`shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] ${tone}`} title={knownDirection ? (lowerIsBetter ? "Lower is better for this metric" : "Higher is better for this metric") : "Direction depends on the metric definition"}>
          {trend}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label={`${name} over ${data.length} training steps`}>
        <line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} stroke="currentColor" className="text-line" strokeWidth={0.7} />
        {data.length > 1 && <polyline points={polyline} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {data.map((p, i) => <circle key={`${p.step}-${i}`} cx={x(p, i)} cy={y(p.value)} r={data.length === 1 ? 3.5 : data.length <= 24 || i === data.length - 1 ? 2.5 : 1.3} fill={color}>
          <title>{`Step ${p.step}: ${formatMetric(p.value)}`}</title>
        </circle>)}
      </svg>
      <div className="mt-1 flex justify-between gap-2 text-[10px] text-muted">
        <span>{data.length === 1 ? `Step ${data[0].step} · one value` : `Step ${minStep}`}</span>
        <span>{data.length === 1 ? "No trend yet" : `Step ${maxStep} · ${data.length} values`}</span>
      </div>
    </article>
  );
}

/** A model version a build published, with its training run (Code Repositories' build results). */
export function PublishedModel({ modelId, model, version }: { modelId: string; model: string; version: string }) {
  const [exp, setExp] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    trainedModels.get(modelId).then(
      (m) => setExp(m.versions_detail.find((v) => v.version === version)?.experiment_id ?? null),
      () => setExp(null),
    );
  }, [modelId, version]);
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">model published</span>
        <Link href={`/model-assets/${modelId}`} className="font-medium text-ocean hover:underline">{model}</Link>
        <span className="text-muted">v{version}</span>
      </div>
      {exp === undefined ? <div className="h-24 animate-pulse rounded-xl bg-panel-2/40" /> : exp ? <TrainingResults modelId={modelId} experimentId={exp} compact /> : <p className="text-xs text-muted">No training run was logged with this version.</p>}
    </div>
  );
}

// the columns of the comparison, by evaluation type; lower is better for errors
const COMPARE: Record<string, [string, string][]> = {
  binary_classification: [["f1", "F1"], ["precision", "Precision"], ["recall", "Recall"], ["roc_auc", "ROC AUC"], ["pr_auc", "PR AUC"], ["accuracy", "Accuracy"]],
  regression: [["r2", "R²"], ["rmse", "RMSE"], ["mae", "MAE"], ["mape", "MAPE"]],
};
const LOWER_BETTER = new Set(["rmse", "mae", "mape"]);

/** Several evaluations side by side (e.g. Model Studio's candidates): the best value of each metric highlighted;
 *  a row opens its charts below. */
function CompareTable({ evals, active, onPick }: { evals: [string, ModelEval][]; active: string; onPick: (k: string) => void }) {
  const cols = COMPARE[evals[0][1].type] ?? [];
  const best = Object.fromEntries(cols.map(([k]) => {
    const vals = evals.map(([, e]) => e.metrics[k]).filter((v): v is number => typeof v === "number");
    return [k, vals.length ? (LOWER_BETTER.has(k) ? Math.min(...vals) : Math.max(...vals)) : null];
  }));
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-xs">
        <thead className="bg-panel-2/40 text-muted">
          <tr>
            <th className="px-3 py-2 text-left font-normal">Candidate</th>
            {cols.map(([k, l]) => <th key={k} className="px-3 py-2 text-right font-normal">{l}{LOWER_BETTER.has(k) ? " ↓" : ""}</th>)}
          </tr>
        </thead>
        <tbody>
          {evals.map(([key, e]) => (
            <tr key={key} onClick={() => onPick(key)} className={`cursor-pointer border-t border-line ${key === active ? "bg-ocean/10" : "hover:bg-panel-2/50"}`}>
              <td className="max-w-[18rem] truncate px-3 py-2 text-white" title={key}>
                {key === active && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-ocean align-middle" />}
                {EVAL_LABEL[key] ?? key}
              </td>
              {cols.map(([k]) => {
                const v = e.metrics[k];
                const top = typeof v === "number" && v === best[k];
                return (
                  <td key={k} className={`px-3 py-2 text-right tabular-nums ${top ? "font-semibold text-emerald-300" : "text-soft"}`}>
                    {typeof v === "number" ? (k === "mape" ? `${(v * 100).toFixed(1)}%` : v.toFixed(3)) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
