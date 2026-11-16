"use client";

import { useId, useState } from "react";

/* A binary classifier's evaluation, drawn natively (dark, hover read-outs): KPI tiles, the confusion matrix, ROC and
   precision-recall curves, calibration and the score distribution per class. The data is the structured evaluation a
   training run logs (`<prefix>/evaluation.json`, ml_models/evaluasi.py → model_lib → experiment.evaluations). */

export type RegressionEval = {
  type: "regression";
  name: string;
  rows: number;
  metrics: Record<string, number>;
  scatter: { x: number[]; y: number[] };
  residuals: { edges: number[]; counts: number[] };
};
export type ModelEval = BinaryEval | RegressionEval;

export type BinaryEval = {
  type: "binary_classification";
  name: string;
  labels: [string, string];
  threshold: number;
  rows: number;
  prevalence: number;
  metrics: Record<string, number>;
  confusion: { tn: number; fp: number; fn: number; tp: number };
  roc?: { x: number[]; y: number[] };
  pr?: { x: number[]; y: number[] };
  calibration?: { x: number[]; y: number[] };
  scores?: { edges: number[]; negative: number[]; positive: number[] };
};

const POS = "#4cc2ff";
const NEG = "#8b95a7";
const ACCENT = "#c297ff";
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.995 || v < 0.1 ? 1 : 0)}%`;
const num = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? "—" : v.toFixed(3));

const KPI: [string, string, string][] = [
  ["f1", "F1 score", "harmonic mean of precision and recall"],
  ["precision", "Precision", "of the flagged, how many are real"],
  ["recall", "Recall", "of the real ones, how many are flagged"],
  ["roc_auc", "ROC AUC", "ranking quality over every threshold"],
  ["pr_auc", "PR AUC", "average precision"],
  ["accuracy", "Accuracy", "all rows right"],
];
const KPI_META: Record<string, { label: string; hint: string }> = {
  ...Object.fromEntries(KPI.map(([key, label, hint]) => [key, { label, hint }])),
  mcc: { label: "MCC", hint: "correlation between predictions and true labels; 1 is best, 0 is random" },
  specificity: { label: "Specificity", hint: "of the real negatives, how many were correctly left unflagged" },
  sensitivity: { label: "Sensitivity", hint: "of the real positives, how many were correctly flagged" },
  balanced_accuracy: { label: "Balanced accuracy", hint: "average recall across the classes" },
  log_loss: { label: "Log loss", hint: "penalty for incorrect probabilities; lower is better" },
  logloss: { label: "Log loss", hint: "penalty for incorrect probabilities; lower is better" },
};
const metricLabel = (key: string) => KPI_META[key as keyof typeof KPI_META]?.label ?? key.replace(/[_/.-]+/g, " ");
const metricHint = (key: string) => KPI_META[key as keyof typeof KPI_META]?.hint ?? "Logged for this evaluation";

/** A metric as a tile with a thin progress bar (0–1 metrics) and its meaning. */
function Kpi({ label, value, hint }: { label: string; value: number | undefined; hint: string }) {
  const v = value ?? 0;
  const bounded = value !== undefined && value >= 0 && value <= 1;
  return (
    <div className="rounded-xl border border-line bg-gradient-to-b from-panel-2/60 to-panel p-3" title={hint}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{num(value)}</div>
      {bounded && <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: `linear-gradient(90deg, ${POS}, ${ACCENT})` }} />
      </div>}
      <div className="mt-1.5 truncate text-[10px] text-muted">{hint}</div>
    </div>
  );
}

function Panel({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-soft">{title}</div>
        {aside && <div className="text-[10px] text-muted">{aside}</div>}
      </div>
      {children}
    </div>
  );
}

/** The 2×2 confusion matrix: counts, share of all rows, colour by share of its true class. */
function Confusion({ e }: { e: BinaryEval }) {
  const { tn, fp, fn, tp } = e.confusion;
  const n = tn + fp + fn + tp || 1;
  const cell = (v: number, rowTotal: number, good: boolean, name: string) => {
    const share = rowTotal ? v / rowTotal : 0;
    const color = good ? `rgba(76,194,255,${0.12 + 0.7 * share})` : `rgba(247,120,186,${0.08 + 0.6 * share})`;
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-white/5 p-2 text-center" style={{ background: color }}>
        <div className="text-lg font-semibold tabular-nums text-white">{v.toLocaleString()}</div>
        <div className="text-[10px] text-white/70">{name} · {pct(v / n)}</div>
      </div>
    );
  };
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] gap-1.5 text-[10px] text-muted">
      <div />
      <div className="text-center">pred. {e.labels[0]}</div>
      <div className="text-center">pred. {e.labels[1]}</div>
      <div className="flex items-center justify-end pr-1">true {e.labels[0]}</div>
      {cell(tn, tn + fp, true, "TN")}
      {cell(fp, tn + fp, false, "FP")}
      <div className="flex items-center justify-end pr-1">true {e.labels[1]}</div>
      {cell(fn, fn + tp, false, "FN")}
      {cell(tp, fn + tp, true, "TP")}
    </div>
  );
}

/** A curve on the unit square: area fill, a reference line, a hover crosshair reading the nearest point. */
function Curve({ x, y, xLabel, yLabel, reference, area = true }: { x: number[]; y: number[]; xLabel: string; yLabel: string; reference?: "diagonal" | number; area?: boolean }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const W = 300, H = 210, p = { l: 28, r: 8, t: 18, b: 26 };
  const sx = (v: number) => p.l + v * (W - p.l - p.r);
  const sy = (v: number) => p.t + (1 - v) * (H - p.t - p.b);
  const pts = x.map((v, i) => `${sx(v)},${sy(y[i])}`).join(" ");
  const onMove = (ev: React.MouseEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width * W - p.l) / (W - p.l - p.r);
    let best = 0;
    x.forEach((v, i) => { if (Math.abs(v - vx) < Math.abs(x[best] - vx)) best = i; });
    setHover(best);
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${yLabel} vs ${xLabel}`}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={POS} stopOpacity={0.35} />
          <stop offset="100%" stopColor={POS} stopOpacity={0} />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={sx(0)} x2={sx(1)} y1={sy(f)} y2={sy(f)} stroke="currentColor" className="text-line" strokeWidth={0.5} />
          <text x={p.l - 4} y={sy(f) + 3} textAnchor="end" fontSize={8} className="fill-muted">{f}</text>
          <text x={sx(f)} y={H - 14} textAnchor="middle" fontSize={8} className="fill-muted">{f}</text>
        </g>
      ))}
      <text x={(W + p.l) / 2} y={H - 3} textAnchor="middle" fontSize={9} className="fill-muted">{xLabel}</text>
      <text x={p.l - 4} y={9} fontSize={9} className="fill-muted">↑ {yLabel}</text>
      {reference === "diagonal" && <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke={NEG} strokeDasharray="3 3" strokeWidth={1} />}
      {typeof reference === "number" && <line x1={sx(0)} x2={sx(1)} y1={sy(reference)} y2={sy(reference)} stroke={NEG} strokeDasharray="3 3" strokeWidth={1} />}
      {area && x.length > 1 && <polygon points={`${sx(x[0])},${sy(0)} ${pts} ${sx(x[x.length - 1])},${sy(0)}`} fill={`url(#g${id})`} />}
      <polyline points={pts} fill="none" stroke={POS} strokeWidth={2} strokeLinejoin="round" />
      {hover !== null && (
        <g>
          <line x1={sx(x[hover])} x2={sx(x[hover])} y1={sy(0)} y2={sy(1)} stroke="white" strokeOpacity={0.25} />
          <circle cx={sx(x[hover])} cy={sy(y[hover])} r={4} fill={POS} stroke="white" strokeWidth={1.5} />
          <g transform={`translate(${Math.min(sx(x[hover]) + 8, W - 98)},${Math.max(sy(y[hover]) - 30, 4)})`}>
            <rect width={92} height={26} rx={5} fill="#0b1220" stroke="#2a3446" />
            <text x={6} y={11} fontSize={8} className="fill-muted">{xLabel}: <tspan fill="white">{x[hover].toFixed(3)}</tspan></text>
            <text x={6} y={21} fontSize={8} className="fill-muted">{yLabel}: <tspan fill="white">{y[hover].toFixed(3)}</tspan></text>
          </g>
        </g>
      )}
    </svg>
  );
}

/** The score histogram of each class (density), with the decision threshold. */
function Scores({ e }: { e: BinaryEval }) {
  const s = e.scores!;
  const [hover, setHover] = useState<number | null>(null);
  const nNeg = s.negative.reduce((a, b) => a + b, 0) || 1;
  const nPos = s.positive.reduce((a, b) => a + b, 0) || 1;
  const neg = s.negative.map((v) => v / nNeg);
  const pos = s.positive.map((v) => v / nPos);
  const top = Math.max(...neg, ...pos, 1e-9);
  const W = 300, H = 170, p = { l: 8, r: 8, t: 8, b: 22 };
  const lo = s.edges[0], hi = s.edges[s.edges.length - 1];
  const sx = (v: number) => p.l + ((v - lo) / (hi - lo || 1)) * (W - p.l - p.r);
  const bw = (W - p.l - p.r) / neg.length;
  const sy = (v: number) => p.t + (1 - v / top) * (H - p.t - p.b);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)} role="img" aria-label="Score distribution">
        {neg.map((v, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={p.l + i * bw + 0.5} y={sy(v)} width={bw - 1} height={H - p.b - sy(v)} rx={1.5} fill={NEG} fillOpacity={hover === i ? 0.9 : 0.55} />
            <rect x={p.l + i * bw + 0.5} y={sy(pos[i])} width={bw - 1} height={H - p.b - sy(pos[i])} rx={1.5} fill={POS} fillOpacity={hover === i ? 0.95 : 0.6} />
          </g>
        ))}
        <line x1={sx(e.threshold)} x2={sx(e.threshold)} y1={p.t} y2={H - p.b} stroke={ACCENT} strokeWidth={1.5} strokeDasharray="4 3" />
        <text x={sx(e.threshold) + 3} y={p.t + 8} fontSize={8} fill={ACCENT}>threshold {e.threshold.toFixed(3)}</text>
        <text x={p.l} y={H - 6} fontSize={8} className="fill-muted">{lo.toFixed(2)}</text>
        <text x={W - p.r} y={H - 6} fontSize={8} textAnchor="end" className="fill-muted">{hi.toFixed(2)}</text>
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: NEG }} />{e.labels[0]} ({nNeg.toLocaleString()})</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: POS }} />{e.labels[1]} ({nPos.toLocaleString()})</span>
        {hover !== null && <span className="ml-auto text-soft">{s.edges[hover].toFixed(3)}–{s.edges[hover + 1].toFixed(3)}: {s.negative[hover]} / {s.positive[hover]}</span>}
      </div>
    </div>
  );
}

/** Everything about one evaluation (e.g. "kunci": the answer key, or "p2tl_cv5": cross-validated labels). */
export function BinaryEvalView({ e }: { e: BinaryEval }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Object.entries(e.metrics).map(([k, value]) => <Kpi key={k} label={metricLabel(k)} value={value} hint={metricHint(k)} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span>{e.rows.toLocaleString()} rows</span>
        <span>prevalence {pct(e.prevalence)}</span>
        <span>threshold {e.threshold.toFixed(3)}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Confusion matrix" aside={`at threshold ${e.threshold.toFixed(3)}`}><Confusion e={e} /></Panel>
        {e.roc && <Panel title="ROC curve" aside={`AUC ${num(e.metrics.roc_auc)}`}><Curve x={e.roc.x} y={e.roc.y} xLabel="false positive rate" yLabel="true positive rate" reference="diagonal" /></Panel>}
        {e.pr && <Panel title="Precision–recall" aside={`AP ${num(e.metrics.pr_auc)} · baseline ${pct(e.prevalence)}`}><Curve x={e.pr.x} y={e.pr.y} xLabel="recall" yLabel="precision" reference={e.prevalence} /></Panel>}
        {e.calibration && <Panel title="Calibration" aside="predicted vs observed"><Curve x={e.calibration.x} y={e.calibration.y} xLabel="mean predicted" yLabel="fraction positive" reference="diagonal" area={false} /></Panel>}
        {e.scores && <Panel title="Score distribution" aside="density per class"><Scores e={e} /></Panel>}
      </div>
    </div>
  );
}

/** Predicted against actual (a sample of the rows), with the perfect-prediction diagonal and a hover read-out. */
function Scatter({ x, y }: { x: number[]; y: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300, H = 210, p = { l: 40, r: 8, t: 18, b: 26 };
  const all = [...x, ...y];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
  const sx = (v: number) => p.l + ((v - lo) / (hi - lo)) * (W - p.l - p.r);
  const sy = (v: number) => p.t + (1 - (v - lo) / (hi - lo)) * (H - p.t - p.b);
  const ticks = [0, 0.5, 1].map((f) => lo + f * (hi - lo));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)} role="img" aria-label="Predicted vs actual">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={sx(lo)} x2={sx(hi)} y1={sy(t)} y2={sy(t)} stroke="currentColor" className="text-line" strokeWidth={0.5} />
          <text x={p.l - 4} y={sy(t) + 3} textAnchor="end" fontSize={8} className="fill-muted">{t.toPrecision(3)}</text>
          <text x={sx(t)} y={H - 14} textAnchor="middle" fontSize={8} className="fill-muted">{t.toPrecision(3)}</text>
        </g>
      ))}
      <text x={(W + p.l) / 2} y={H - 3} textAnchor="middle" fontSize={9} className="fill-muted">actual</text>
      <text x={p.l - 4} y={9} fontSize={9} className="fill-muted">↑ predicted</text>
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke={NEG} strokeDasharray="3 3" />
      {x.map((v, i) => (
        <circle key={i} cx={sx(v)} cy={sy(y[i])} r={hover === i ? 4 : 2.6} fill={POS} fillOpacity={hover === i ? 1 : 0.55}
          stroke={hover === i ? "white" : "none"} onMouseEnter={() => setHover(i)} />
      ))}
      {hover !== null && (
        <g transform={`translate(${Math.min(sx(x[hover]) + 8, W - 98)},${Math.max(sy(y[hover]) - 30, 4)})`}>
          <rect width={92} height={26} rx={5} fill="#0b1220" stroke="#2a3446" />
          <text x={6} y={11} fontSize={8} className="fill-muted">actual: <tspan fill="white">{x[hover].toPrecision(4)}</tspan></text>
          <text x={6} y={21} fontSize={8} className="fill-muted">predicted: <tspan fill="white">{y[hover].toPrecision(4)}</tspan></text>
        </g>
      )}
    </svg>
  );
}

/** The residual (predicted − actual) histogram, with zero marked. */
function Residuals({ edges, counts }: { edges: number[]; counts: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300, H = 170, p = { l: 8, r: 8, t: 8, b: 22 };
  const top = Math.max(...counts, 1);
  const bw = (W - p.l - p.r) / counts.length;
  const lo = edges[0], hi = edges[edges.length - 1];
  const zero = lo < 0 && hi > 0 ? p.l + ((0 - lo) / (hi - lo)) * (W - p.l - p.r) : null;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)} role="img" aria-label="Residuals">
        {counts.map((c, i) => {
          const h = (c / top) * (H - p.t - p.b);
          return <rect key={i} x={p.l + i * bw + 0.5} y={H - p.b - h} width={bw - 1} height={h} rx={1.5} fill={POS} fillOpacity={hover === i ? 0.95 : 0.6} onMouseEnter={() => setHover(i)} />;
        })}
        {zero !== null && <line x1={zero} x2={zero} y1={p.t} y2={H - p.b} stroke={ACCENT} strokeDasharray="4 3" strokeWidth={1.5} />}
        <text x={p.l} y={H - 6} fontSize={8} className="fill-muted">{lo.toPrecision(3)}</text>
        <text x={W - p.r} y={H - 6} textAnchor="end" fontSize={8} className="fill-muted">{hi.toPrecision(3)}</text>
      </svg>
      <div className="mt-1 h-4 text-[10px] text-muted">{hover !== null ? `${edges[hover].toPrecision(3)} … ${edges[hover + 1].toPrecision(3)}: ${counts[hover]} rows` : "predicted − actual"}</div>
    </div>
  );
}

const REG_KPI: [string, string, string, boolean][] = [
  ["r2", "R²", "share of the variance explained", true],
  ["rmse", "RMSE", "typical error, large errors weigh more", false],
  ["mae", "MAE", "average absolute error", false],
  ["mape", "MAPE", "average error relative to the actual value", false],
];

/** A regression's evaluation: KPI tiles, predicted vs actual, residual distribution. */
export function RegressionEvalView({ e }: { e: RegressionEval }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {REG_KPI.filter(([k]) => e.metrics[k] !== undefined).map(([k, label, hint, bar]) => (
          <div key={k} className="rounded-xl border border-line bg-gradient-to-b from-panel-2/60 to-panel p-3" title={hint}>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{k === "mape" ? pct(e.metrics[k]) : e.metrics[k].toPrecision(4)}</div>
            {bar && (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, e.metrics[k])) * 100}%`, background: `linear-gradient(90deg, ${POS}, ${ACCENT})` }} />
              </div>
            )}
            <div className="mt-1.5 truncate text-[10px] text-muted">{hint}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-muted">{e.rows.toLocaleString()} rows{e.scatter.x.length < e.rows ? ` · ${e.scatter.x.length} shown in the scatter` : ""}</div>
      <div className="grid gap-3 md:grid-cols-2">
        <Panel title="Predicted vs actual" aside="on the diagonal = exact"><Scatter x={e.scatter.x} y={e.scatter.y} /></Panel>
        <Panel title="Residuals" aside="centred on zero = unbiased"><Residuals edges={e.residuals.edges} counts={e.residuals.counts} /></Panel>
      </div>
    </div>
  );
}

/** Any evaluation, by its type. */
export function EvalView({ e }: { e: ModelEval }) {
  return e.type === "regression" ? <RegressionEvalView e={e} /> : <BinaryEvalView e={e} />;
}
