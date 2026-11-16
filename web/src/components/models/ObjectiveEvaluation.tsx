"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { datasetHref } from "@/lib/datasetPreview";
import { bytes, when } from "@/lib/format";
import { MODEL_SOURCE_LABEL, objectives, type EvalConfig, type EvalDashboard, type EvalLibrarySpec, type EvalPlot, type EvalResult, type Objective, type SubmissionMeta, type SubsetField } from "@/lib/modelingObjectives";
import { BarChart, formatMetric, LineChart, Matrix, SERIES_COLORS } from "./Charts";

/** The evaluation dashboard of a modeling objective: metrics of the selected submissions on an evaluation dataset,
 *  per evaluation library and subset, with the evaluators' plots; and its configuration (datasets, libraries, subsets). */
export function ObjectiveEvaluation({ objectiveId, onChanged, objective, meta = {} }: { objectiveId: string; onChanged?: () => void; objective?: Objective; meta?: Record<string, SubmissionMeta> }) {
  const [data, setData] = useState<EvalDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [transaction, setTransaction] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [subset, setSubset] = useState("Overall");
  const [search, setSearch] = useState({ metric: "", op: ">=", value: "" });
  const [configuring, setConfiguring] = useState(false);
  const [building, setBuilding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [pinTab, setPinTab] = useState<string | null>(null);
  const load = useCallback(() => {
    objectives.evaluation(objectiveId, datasetId, transaction || null).then((d) => { setData(d); setErr(null); }, (e: Error) => setErr(e.message));
  }, [objectiveId, datasetId, transaction]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!data?.building) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [data, load]);
  const results = useMemo(() => data?.results ?? [], [data]);
  const metricNames = useMemo(() => [...new Set(results.flatMap((r) => Object.keys(r.subsets?.Overall?.metrics ?? {})))], [results]);
  if (!data) return <p className="text-xs text-muted">{err ?? "Loading…"}</p>;
  const cfg = data.config;
  if (!cfg.datasets.length && !configuring) {
    return (
      <div className="rounded-xl border border-dashed border-line-2 p-8 text-center text-sm text-muted">
        <p>No evaluation is configured. Add an evaluation dataset and an evaluation library: every submission is then run on the dataset and measured the same way.</p>
        <button type="button" className={`${buttonClass.primary} mt-4`} onClick={() => setConfiguring(true)}><Icon name="sliders" className="h-3.5 w-3.5" /> Configure evaluation dashboard</button>
      </div>
    );
  }
  const evaluable = data.submissions.filter((s) => s.evaluable && !s.archived);
  // the models shown: those selected, plus those matching the search criteria on the chosen subset
  const matches = (s: { id: string }) => {
    if (!search.metric || search.value === "") return false;
    const vals = results.filter((r) => r.candidate_id === s.id).map((r) => r.subsets?.[subset]?.metrics[search.metric]).filter((v): v is number => typeof v === "number");
    const t = Number(search.value);
    return vals.some((v) => (search.op === ">=" ? v >= t : search.op === "<=" ? v <= t : search.op === ">" ? v > t : v < t));
  };
  const shownIds = new Set([...(picked ?? evaluable.map((s) => s.id)), ...evaluable.filter(matches).map((s) => s.id)]);
  const shown = evaluable.filter((s) => shownIds.has(s.id));
  const libs = cfg.libraries;
  const color = (id: string) => SERIES_COLORS[shown.findIndex((s) => s.id === id) % SERIES_COLORS.length];
  const passes = (name: string) => !filter.trim() || name.toLowerCase().includes(filter.trim().toLowerCase());
  const failed = results.filter((r) => r.status === "failed" && shownIds.has(r.candidate_id));
  return (
    <div className="space-y-4" data-comparisons>
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-4">
        <span className="text-base font-semibold">Comparing</span>
        <div className="relative flex min-w-64 flex-1 flex-wrap items-center gap-1.5 rounded-md border border-line-2 bg-panel px-2 py-1.5" data-comparing>
          {shown.map((s) => (
            <span key={s.id} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-white" style={{ background: color(s.id) }} data-comparing-chip={s.id}>
              <Icon name="cube" className="h-3 w-3" />{s.name}
              <button type="button" aria-label={`Remove ${s.name}`} onClick={() => setPicked([...shownIds].filter((x) => x !== s.id))} className="opacity-80 hover:opacity-100">×</button>
            </span>
          ))}
          <button type="button" onClick={() => setAdding((a) => !a)} className="px-2 py-1 text-xs text-muted hover:text-white" data-comparing-add>{shown.length ? "+ Add model" : "Choose models to compare"}</button>
          {adding && (
            <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl">
              {evaluable.length === 0 && <p className="p-3 text-xs text-muted">No submission of a model version yet.</p>}
              {evaluable.map((s) => {
                const on = shownIds.has(s.id);
                const sub = objective?.candidates.find((c) => c.id === s.id);
                const status = meta[s.id]?.review_status;
                return (
                  <button key={s.id} type="button" className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm ${on ? "bg-panel-2" : "hover:bg-panel-2"}`}
                    onClick={() => setPicked(on ? [...shownIds].filter((x) => x !== s.id) : [...shownIds, s.id])}>
                    <span className="mt-0.5 w-3 text-ocean">{on ? "✓" : ""}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-white"><Icon name="cube" className="h-3 w-3 text-ocean" />{s.name}{s.version ? ` ${s.version}` : ""}
                        {status === "rejected" ? <span className="text-bad">✕</span> : status === "accepted" ? <span className="text-ok">✓</span> : (sub?.released_in ?? []).length ? <Icon name="bolt" className="h-3 w-3 text-muted" /> : null}</span>
                      {sub?.submitted_at && <span className="block text-xs text-muted">Submitted {when(sub.submitted_at)}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">Viewing metrics on
          <select value={data.dataset_id ?? ""} onChange={(e) => { setDatasetId(e.target.value); setTransaction(""); }} className={`${inputClass} w-52`} data-comparing-dataset>
            {cfg.datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      </div>
      <section data-model-details>
        <h2 className="mb-2 text-sm font-semibold">Model details</h2>
        {shown.length === 0 ? <p className="text-xs text-muted">Choose the models to compare.</p> : (
          <div className="overflow-x-auto">
            <table className="rounded-lg border border-line bg-panel text-sm">
              <thead><tr><th className="w-40 border-b border-line" />{shown.map((s) => (
                <th key={s.id} className="border-b border-l border-line px-4 py-2.5 text-left font-normal"><span className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-white" style={{ background: color(s.id) }}><Icon name="cube" className="h-3 w-3" />{s.name}</span></th>
              ))}</tr></thead>
              <tbody>
                {([
                  ["Model owners", (id: string) => meta[id]?.owner ?? "-"],
                  ["File size", (id: string) => (meta[id]?.size_bytes != null ? bytes(meta[id].size_bytes as number) : "-")],
                  ["Version", (id: string) => shown.find((x) => x.id === id)?.version ?? "-"],
                  ["Source", (id: string) => { const c = objective?.candidates.find((x) => x.id === id); return c ? MODEL_SOURCE_LABEL[c.source] : "-"; }],
                  ...(objective?.metadata_fields ?? []).map((f) => [f.name, (id: string) => { const v = shown.find((x) => x.id === id)?.metadata[f.id]; return v == null || v === "" ? "-" : String(v); }] as [string, (id: string) => string]),
                ] as [string, (id: string) => string][]).map(([label, value]) => (
                  <tr key={label}><td className="px-4 py-1.5 text-muted">{label}</td>{shown.map((s) => <td key={s.id} className="border-l border-line px-4 py-1.5 text-soft">{value(s.id)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="text-muted">Transaction
          <select value={transaction} onChange={(e) => setTransaction(e.target.value)} className={`${inputClass} mt-1 w-52`}>
            <option value="">Most recent results</option>
            {data.transactions.map((t) => <option key={t.id} value={t.id}>{when(t.at)} · {t.rows ?? "?"} rows</option>)}
          </select>
        </label>
        <label className="text-muted">Search for models
          <span className="mt-1 flex gap-1">
            <select value={search.metric} onChange={(e) => setSearch({ ...search, metric: e.target.value })} className={`${inputClass} w-40`}><option value="">Metric…</option>{metricNames.map((m) => <option key={m}>{m}</option>)}</select>
            <select value={search.op} onChange={(e) => setSearch({ ...search, op: e.target.value })} className={`${inputClass} w-16`}>{[">=", ">", "<=", "<"].map((o) => <option key={o}>{o}</option>)}</select>
            <input value={search.value} onChange={(e) => setSearch({ ...search, value: e.target.value })} placeholder="value" className={`${inputClass} w-20`} />
          </span>
        </label>
        <div className="ml-auto flex gap-2">
          <button type="button" className={buttonClass.ghost} onClick={() => setConfiguring(true)}><Icon name="sliders" className="h-3.5 w-3.5" /> Edit evaluation configuration</button>
          <button type="button" disabled={building || data.building} className={buttonClass.primary}
            onClick={async () => {
              setBuilding(true);
              setNote(null);
              try {
                const r = await objectives.buildEvaluation(objectiveId, { candidate_ids: [...shownIds], dataset_ids: data.dataset_id ? [data.dataset_id] : [] });
                setNote(`Built ${r.built} result(s)${r.failed ? `, ${r.failed} failed: ${r.errors.join("; ")}` : ""}.`);
                setData(r.dashboard);
                onChanged?.();
              } catch (e) {
                setNote((e as Error).message);
              } finally {
                setBuilding(false);
                load();
              }
            }}>
            <Icon name="play" className="h-3.5 w-3.5" /> {building || data.building ? "Building…" : "Build evaluation"}
          </button>
        </div>
      </div>
      {(note || data.last_error) && <p className="whitespace-pre-wrap text-xs text-soft">{note ?? data.last_error}</p>}
      {failed.map((r) => <p key={r.id} className="whitespace-pre-wrap rounded bg-bad/10 px-3 py-2 text-xs text-bad">{r.submission} on {r.dataset}{r.library ? ` (${r.library})` : ""}: {r.error}</p>)}
      <div>
        <h2 className="mb-2 text-sm font-semibold">Key objective metrics and charts</h2>
        <div className="relative max-w-xs">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter metrics and charts" className={`${inputClass} pl-8 text-xs`} data-metric-filter />
        </div>
      </div>
      {cfg.pinned_tabs.length > 0 && (
        <section data-pinned>
          <div className="flex flex-wrap gap-5 border-b border-line text-sm">
            {[...cfg.pinned_tabs.map((t) => t.name), "All pinned"].map((name) => (
              <button key={name} type="button" onClick={() => setPinTab(name)} className={`-mb-px border-b-2 pb-2 ${(pinTab ?? cfg.pinned_tabs[0].name) === name ? "border-ocean text-ocean" : "border-transparent text-soft hover:text-white"}`}>{name}</button>
            ))}
          </div>
          <div className="flex flex-wrap gap-4 rounded-b-lg border border-t-0 border-line bg-panel-2 p-4">
            {(() => {
              const active = pinTab ?? cfg.pinned_tabs[0].name;
              const metrics = [...new Set((active === "All pinned" ? cfg.pinned_tabs : cfg.pinned_tabs.filter((t) => t.name === active)).flatMap((t) => t.metrics))].filter(passes);
              if (!metrics.length) return <p className="text-xs text-muted">No pinned metric matches the filter.</p>;
              const value = (id: string, sub: string, m: string) => results.filter((r) => r.candidate_id === id).map((r) => r.subsets?.[sub]?.metrics[m]).find((x) => typeof x === "number");
              return data.subsets.map((sub) => {
                if (!shown.some((s) => metrics.some((m) => typeof value(s.id, sub, m) === "number"))) return null;
                return (
                  <div key={sub} data-pinned-subset={sub}>
                    <div className="mb-1.5 flex flex-wrap gap-1.5 text-[11px]">{sub.split(/\s*[·,&]\s*/).map((part) => <span key={part} className="rounded bg-panel px-1.5 py-0.5 font-mono text-soft">{part}</span>)}</div>
                    <table className="rounded-lg border border-line bg-panel text-sm">
                      <thead><tr><th />{metrics.map((m) => <th key={m} className="px-3 pt-3 text-left text-xs font-normal text-muted">{m}</th>)}</tr></thead>
                      <tbody>
                        {shown.map((s) => (
                          <tr key={s.id}>
                            <td className="px-3 py-1.5"><span className="flex w-52 items-center gap-1.5 truncate rounded px-2 py-1.5 text-xs font-medium text-white" style={{ background: color(s.id) }}><Icon name="cube" className="h-3 w-3 shrink-0" />{s.name}</span></td>
                            {metrics.map((m) => { const v = value(s.id, sub, m); return <td key={m} className="px-3 py-1.5 font-mono text-white">{typeof v === "number" ? formatMetric(v) : "—"}</td>; })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              });
            })()}
          </div>
        </section>
      )}
      <div className="flex flex-wrap gap-1 border-b border-line text-xs">
        {data.subsets.map((s) => <button key={s} type="button" onClick={() => setSubset(s)} className={`rounded-t px-3 py-1.5 ${subset === s ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}>{s}</button>)}
      </div>
      {libs.length === 0 && <p className="text-xs text-muted">Inference only: no evaluation library is configured, so no metrics are computed. The inference datasets are listed below.</p>}
      {libs.map((lib) => {
        const rows = results.filter((r) => r.library_id === lib.id && shownIds.has(r.candidate_id) && r.status === "succeeded");
        const names = [...new Set(rows.flatMap((r) => Object.keys(r.subsets?.[subset]?.metrics ?? {})))].filter(passes);
        const plotNames = [...new Set(rows.flatMap((r) => Object.keys(r.subsets?.[subset]?.plots ?? {})))].filter(passes);
        return (
          <section key={lib.id} className="rounded-xl border border-line bg-panel">
            <div className="border-b border-line px-4 py-2.5 text-sm font-medium">{lib.name} <span className="text-xs font-normal text-muted">· {subset}</span></div>
            {rows.length === 0 ? <p className="p-4 text-xs text-muted">No metrics for this dataset and selection yet. Select Build evaluation.</p> : (
              <div className="p-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted"><tr><th className="px-2 py-1 text-left font-normal">Metric</th>{rows.map((r) => <th key={r.id} className="px-2 py-1 text-right font-normal" style={{ color: color(r.candidate_id) }}>{r.submission}</th>)}</tr></thead>
                    <tbody>
                      {names.map((m) => {
                        const vals = rows.map((r) => r.subsets?.[subset]?.metrics[m]);
                        return (
                          <tr key={m} className="border-t border-line"><td className="px-2 py-1 text-soft">{m}</td>
                            {vals.map((v, i) => <td key={i} className="px-2 py-1 text-right font-mono text-white">{typeof v === "number" ? formatMetric(v) : "—"}</td>)}</tr>
                        );
                      })}
                      <tr className="border-t border-line text-muted"><td className="px-2 py-1">Rows in subset</td>{rows.map((r) => <td key={r.id} className="px-2 py-1 text-right font-mono">{r.subsets?.[subset]?.rows ?? "—"}</td>)}</tr>
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {plotNames.map((p) => <PlotCard key={p} name={p} rows={rows} subset={subset} color={color} />)}
                </div>
                {rows.flatMap((r) => r.notes ?? []).filter((n, i, a) => a.indexOf(n) === i).map((n) => <p key={n} className="mt-2 text-[11px] text-warn">{n}</p>)}
              </div>
            )}
          </section>
        );
      })}
      <section className="rounded-xl border border-line bg-panel p-4 text-xs">
        <div className="mb-2 text-sm font-medium">Inference and metrics datasets</div>
        {results.filter((r) => r.inference).length === 0 ? <p className="text-muted">None built yet.</p> : (
          <ul className="space-y-1">
            {dedupe(results).map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3 text-soft">
                <span className="text-white">{r.submission}</span>
                {r.inference && <Link href={datasetHref(r.inference.item_id)} className="text-ocean hover:underline">{r.inference.name}</Link>}
                {r.metrics_dataset && <Link href={datasetHref(r.metrics_dataset.item_id)} className="text-ocean hover:underline">{r.metrics_dataset.name}</Link>}
                <span className="text-muted">{when(r.built_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {configuring && <ConfigModal objectiveId={objectiveId} config={cfg} columns={data.columns} onClose={() => setConfiguring(false)} onSaved={(d) => { setData(d); setConfiguring(false); onChanged?.(); }} />}
    </div>
  );
}

const dedupe = (rows: EvalResult[]) => rows.filter((r) => r.inference);

function PlotCard({ name, rows, subset, color }: { name: string; rows: EvalResult[]; subset: string; color: (id: string) => string }) {
  const plots = rows.map((r) => ({ r, p: r.subsets?.[subset]?.plots[name] })).filter((x): x is { r: EvalResult; p: EvalPlot } => !!x.p);
  if (!plots.length) return null;
  const first = plots[0].p;
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-3">
      <div className="mb-2 text-xs text-soft">{name}</div>
      {first.type === "line" ? (
        <LineChart series={plots.filter((x) => x.p.type === "line").map((x) => ({ name: x.r.submission, color: color(x.r.candidate_id), points: (x.p as Extract<EvalPlot, { type: "line" }>).x.map((v, i) => [v, (x.p as Extract<EvalPlot, { type: "line" }>).y[i]] as [number, number]) }))}
          xLabel={first.x_label} yLabel={first.y_label} />
      ) : (
        <div className={`grid gap-3 ${plots.length > 1 ? "grid-cols-2" : ""}`}>
          {plots.map(({ r, p }) => (
            <div key={r.id}>
              <div className="mb-1 text-[11px]" style={{ color: color(r.candidate_id) }}>{r.submission}</div>
              {p.type === "matrix" ? <Matrix rows={p.rows} columns={p.columns} values={p.values} /> : p.type === "bar" ? <BarChart x={p.x} y={p.y} color={color(r.candidate_id)} height={110} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Draft = {
  generate: EvalConfig["generate"]; auto_build: boolean; expected_outputs: string;
  datasets: { id: string; name: string; inference_folder_id: string; inference_folder: string; metrics_folder_id: string }[];
  libraries: { id?: string; kind: "binary_classification" | "regression" | "custom"; library_id?: string; name: string; fields: Record<string, string> }[];
  subsets: { id?: string; fields: (Omit<SubsetField, "cutoffs"> & { cutoffs: string })[] }[];
  pinned_tabs: { name: string; metrics: string }[];
};

function ConfigModal({ objectiveId, config, columns, onClose, onSaved }: { objectiveId: string; config: EvalConfig; columns: string[]; onClose: () => void; onSaved: (d: EvalDashboard) => void }) {
  const [specs, setSpecs] = useState<Record<string, EvalLibrarySpec>>({});
  const [draft, setDraft] = useState<Draft>({
    generate: config.generate, auto_build: config.auto_build, expected_outputs: config.expected_outputs.join(", "),
    datasets: config.datasets.map((d) => ({ ...d, inference_folder: "" })),
    libraries: config.libraries.map((l) => ({ ...l, fields: Object.fromEntries(Object.entries(l.fields).map(([k, v]) => [k, String(v)])) })),
    subsets: config.subsets.map((s) => ({ id: s.id, fields: s.fields.map((f) => ({ ...f, cutoffs: f.cutoffs.join(", ") })) })),
    pinned_tabs: config.pinned_tabs.map((t) => ({ name: t.name, metrics: t.metrics.join(", ") })),
  });
  const [pick, setPick] = useState<"dataset" | { folder: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { objectives.libraries().then(setSpecs, () => {}); }, []);
  const cols = [...new Set([...columns, ...draft.expected_outputs.split(",").map((s) => s.trim()).filter(Boolean)])];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      onSaved(await objectives.saveEvaluation(objectiveId, {
        generate: draft.generate, auto_build: draft.auto_build,
        expected_outputs: draft.expected_outputs.split(",").map((s) => s.trim()).filter(Boolean),
        datasets: draft.datasets.map((d) => ({ id: d.id, inference_folder_id: d.inference_folder_id, metrics_folder_id: d.metrics_folder_id || d.inference_folder_id })),
        libraries: draft.libraries.map((l) => ({ id: l.id, kind: l.kind, library_id: l.library_id, name: l.name, fields: l.fields })),
        subsets: draft.subsets.filter((s) => s.fields.some((f) => f.column)).map((s) => ({
          id: s.id, fields: s.fields.filter((f) => f.column).map((f) => ({ ...f, cutoffs: f.cutoffs.split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x) && f.cutoffs.trim() !== "") })),
        })),
        pinned_tabs: draft.pinned_tabs.filter((t) => t.name.trim()).map((t) => ({ name: t.name.trim(), metrics: t.metrics.split(",").map((m) => m.trim()).filter(Boolean) })),
      }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const columnSelect = (value: string, onChange: (v: string) => void) => (
    <span className="flex gap-1">
      <input list="eval-columns" value={value} onChange={(e) => onChange(e.target.value)} placeholder="column" className={`${inputClass} text-xs`} />
    </span>
  );
  return (
    <Modal title="Evaluation configuration" icon="sliders" onClose={onClose} xl>
      <datalist id="eval-columns">{cols.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto p-5 text-sm">
        <section className="space-y-2">
          <div className="font-medium">Pipelines</div>
          <div className="flex flex-wrap gap-4 text-xs text-soft">
            <label className="flex items-center gap-1.5"><input type="radio" checked={draft.generate === "inference_metrics"} onChange={() => setDraft({ ...draft, generate: "inference_metrics" })} /> Generate inference and metrics</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={draft.generate === "inference"} onChange={() => setDraft({ ...draft, generate: "inference" })} /> Generate inference only</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.auto_build} onChange={(e) => setDraft({ ...draft, auto_build: e.target.checked })} /> Build automatically when a model is submitted</label>
          </div>
        </section>
        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="font-medium">Evaluation datasets</span><button type="button" className={buttonClass.ghost} onClick={() => setPick("dataset")}><Icon name="plus" className="h-3.5 w-3.5" /> Add evaluation dataset</button></div>
          {draft.datasets.length === 0 && <p className="text-xs text-muted">The model must take a single tabular input. Each submission gets one inference dataset per evaluation dataset.</p>}
          {draft.datasets.map((d, i) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 rounded border border-line bg-panel-2 px-3 py-2 text-xs">
              <Icon name="table" className="h-3.5 w-3.5 text-ocean" /><span className="text-white">{d.name}</span>
              <button type="button" className="text-ocean hover:underline" onClick={() => setPick({ folder: i })}>{d.inference_folder_id ? `Output folder${d.inference_folder ? `: ${d.inference_folder}` : " set"} (change)` : "Choose the folder for inference and metrics datasets"}</button>
              <button type="button" className="ml-auto text-muted hover:text-bad" aria-label="Remove dataset" onClick={() => setDraft({ ...draft, datasets: draft.datasets.filter((_, j) => j !== i) })}><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </section>
        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="font-medium">Evaluation libraries</span>
            <span className="flex flex-wrap justify-end gap-1">{Object.entries(specs).map(([key, s]) => (
              <button key={key} type="button" className={buttonClass.ghost} title={s.kind === "custom" ? `${s.repo} ${s.version ?? "(unpublished: default branch)"}` : s.description}
                onClick={() => setDraft({ ...draft, libraries: [...draft.libraries, s.kind === "custom" ? { kind: "custom", library_id: key, name: s.name, fields: {} } : { kind: key as "regression", name: s.name, fields: {} }] })}>
                <Icon name="plus" className="h-3.5 w-3.5" /> {s.name}{s.kind === "custom" && <span className="text-muted"> · custom</span>}
              </button>
            ))}</span>
          </div>
          <label className="block text-xs text-muted">Expected model outputs (columns a submission produces, offered below)
            <input value={draft.expected_outputs} onChange={(e) => setDraft({ ...draft, expected_outputs: e.target.value })} placeholder="prediction, probability_1" className={`${inputClass} mt-1 text-xs`} />
          </label>
          {draft.libraries.map((l, i) => (
            <div key={i} className="rounded border border-line bg-panel-2 p-3 text-xs">
              <div className="mb-2 flex items-center gap-2"><input value={l.name} onChange={(e) => setDraft({ ...draft, libraries: draft.libraries.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className={`${inputClass} max-w-xs text-xs`} />
                <span className="text-muted">{specs[l.kind === "custom" ? (l.library_id ?? "") : l.kind]?.description}</span>
                <button type="button" className="ml-auto text-muted hover:text-bad" aria-label="Remove library" onClick={() => setDraft({ ...draft, libraries: draft.libraries.filter((_, j) => j !== i) })}><Icon name="x" className="h-3.5 w-3.5" /></button></div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(specs[l.kind === "custom" ? (l.library_id ?? "") : l.kind]?.fields ?? []).map((f) => {
                  const set = (v: string) => setDraft({ ...draft, libraries: draft.libraries.map((x, j) => (j === i ? { ...x, fields: { ...x.fields, [f.id]: v } } : x)) });
                  return (
                    <label key={f.id} className="text-muted">{f.id}{f.required && " *"} <span className="text-[11px]">— {f.description}</span>
                      <span className="mt-1 block">{f.type === "column" ? columnSelect(l.fields[f.id] ?? "", set) : <input type={f.type === "int" || f.value_type === "float" ? "number" : "text"} value={l.fields[f.id] ?? ""} placeholder={String(f.default ?? f.value_type ?? "")} onChange={(e) => set(e.target.value)} className={`${inputClass} text-xs`} />}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="font-medium">Evaluation subsets</span>
            <button type="button" className={buttonClass.ghost} onClick={() => setDraft({ ...draft, subsets: [...draft.subsets, { fields: [{ column: "", bucket: "categorical", start: 0, width: 1, cutoffs: "" }] }] })}><Icon name="plus" className="h-3.5 w-3.5" /> Add evaluation subset</button></div>
          <p className="text-xs text-muted">Metrics are always computed on every row (&quot;Overall&quot;). A text column makes one subset per value; a numeric column is bucketed by fixed width or range cut-offs (lower bound included, upper excluded); several fields make every combination.</p>
          {draft.subsets.map((s, i) => (
            <div key={i} className="space-y-2 rounded border border-line bg-panel-2 p-3 text-xs">
              {s.fields.map((f, k) => {
                const upd = (patch: Partial<Draft["subsets"][number]["fields"][number]>) => setDraft({ ...draft, subsets: draft.subsets.map((x, j) => (j === i ? { ...x, fields: x.fields.map((y, m) => (m === k ? { ...y, ...patch } : y)) } : x)) });
                return (
                  <div key={k} className="flex flex-wrap items-center gap-2">
                    <span className="w-40">{columnSelect(f.column, (v) => upd({ column: v }))}</span>
                    <select value={f.bucket} onChange={(e) => upd({ bucket: e.target.value as SubsetField["bucket"] })} className={`${inputClass} w-40 text-xs`}>
                      <option value="categorical">One subset per value</option><option value="fixed_width">Fixed width</option><option value="cutoffs">Range cut-offs</option>
                    </select>
                    {f.bucket === "fixed_width" && <><input type="number" value={f.start ?? 0} onChange={(e) => upd({ start: Number(e.target.value) })} title="Starting value" className={`${inputClass} w-24 text-xs`} /><input type="number" value={f.width ?? 1} onChange={(e) => upd({ width: Number(e.target.value) })} title="Bucket width" className={`${inputClass} w-24 text-xs`} /></>}
                    {f.bucket === "cutoffs" && <input value={f.cutoffs} onChange={(e) => upd({ cutoffs: e.target.value })} placeholder="300, 600" className={`${inputClass} w-40 text-xs`} />}
                  </div>
                );
              })}
              <div className="flex gap-3">
                {s.fields.length < 4 && <button type="button" className="text-ocean hover:underline" onClick={() => setDraft({ ...draft, subsets: draft.subsets.map((x, j) => (j === i ? { ...x, fields: [...x.fields, { column: "", bucket: "categorical", start: 0, width: 1, cutoffs: "" }] } : x)) })}>Add additional field</button>}
                <button type="button" className="text-muted hover:text-bad" onClick={() => setDraft({ ...draft, subsets: draft.subsets.filter((_, j) => j !== i) })}>Remove subset</button>
              </div>
            </div>
          ))}
        </section>
        <section className="space-y-2">
          <div className="flex items-center justify-between"><span className="font-medium">Custom metric views</span>
            <button type="button" className={buttonClass.ghost} onClick={() => setDraft({ ...draft, pinned_tabs: [...draft.pinned_tabs, { name: "Key metrics", metrics: "" }] })}><Icon name="plus" className="h-3.5 w-3.5" /> Create new tab</button></div>
          {draft.pinned_tabs.map((t, i) => (
            <div key={i} className="flex gap-2 text-xs">
              <input value={t.name} onChange={(e) => setDraft({ ...draft, pinned_tabs: draft.pinned_tabs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className={`${inputClass} w-48 text-xs`} />
              <input value={t.metrics} onChange={(e) => setDraft({ ...draft, pinned_tabs: draft.pinned_tabs.map((x, j) => (j === i ? { ...x, metrics: e.target.value } : x)) })} placeholder="Pinned metrics, comma separated: Accuracy, Recall" className={`${inputClass} text-xs`} />
              <button type="button" className="text-muted hover:text-bad" aria-label="Remove tab" onClick={() => setDraft({ ...draft, pinned_tabs: draft.pinned_tabs.filter((_, j) => j !== i) })}><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </section>
        {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
        <button type="button" disabled={busy || draft.datasets.some((d) => !d.inference_folder_id)} onClick={save} className={buttonClass.primary}>Save configuration</button>
      </div>
      {pick === "dataset" && (
        <DrivePicker title="Evaluation dataset" onClose={() => setPick(null)} canPick={(it) => (it.name.endsWith(".parquet") ? null : "Not a dataset")}
          onPick={(it) => { setPick(null); if (!draft.datasets.some((d) => d.id === it.id)) setDraft({ ...draft, datasets: [...draft.datasets, { id: it.id, name: it.name.replace(/\.parquet$/, ""), inference_folder_id: it.parent_id ?? "", inference_folder: it.parent_id ? "next to the dataset" : "", metrics_folder_id: "" }] }); }} />
      )}
      {pick && typeof pick === "object" && (
        <DrivePicker title="Folder for inference and metrics datasets" onClose={() => setPick(null)}
          folder={{ action: "Use this folder", onPick: (f) => { const i = pick.folder; setPick(null); if (f.id) setDraft({ ...draft, datasets: draft.datasets.map((d, j) => (j === i ? { ...d, inference_folder_id: f.id as string, metrics_folder_id: f.id as string, inference_folder: f.name } : d)) }); } }} />
      )}
    </Modal>
  );
}
