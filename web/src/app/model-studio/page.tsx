"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { LocationField, missingText, type PickedLocation } from "@/components/LocationField";
import { AipAssistButton, AipAssistPanel } from "@/components/aip/AipAssist";
import { studioAssist } from "@/components/aip/studioAssist";
import { AlgorithmPicker } from "@/components/models/AlgorithmPicker";
import { TrainingResults } from "@/components/models/TrainingResults";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { datasetHref, datasetPreview, type Column } from "@/lib/datasetPreview";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { trainedModels } from "@/lib/modelAssets";
import { modelStudio, type AlgorithmChoice, type ConfigInput, type Studio, type StudioFilter, type StudioSummary, type Trainer, type TrainerSpec, type TrainingRun } from "@/lib/modelStudio";

/** Model Studio (palantir.com/docs/foundry/model-studio): no-code training jobs. A studio has a trainer and an output
 *  model; the configuration wizard maps datasets and columns, sets parameters and resources; each training run
 *  publishes a model version with an experiment. api/model_studio.py */
export default function ModelStudioPage() {
  return (
    <Suspense fallback={null}>
      <Studios />
    </Suspense>
  );
}

function Studios() {
  const router = useRouter();
  const params = useSearchParams();
  const [list, setList] = useState<StudioSummary[] | null>(null);
  const [trainers, setTrainers] = useState<Record<Trainer, TrainerSpec> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?new=1 (Files & Projects → New): open the creation dialog
  const [creating, setCreating] = useState(() => params.get("new") === "1");
  const load = useCallback(() => { modelStudio.list().then(setList, (e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  useEffect(() => { modelStudio.trainers().then(setTrainers, () => {}); }, []);
  const id = params.get("id");
  if (error && !list) return <ApiError message={error} />;
  const create = creating && trainers && <CreateStudio trainers={trainers} onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); load(); router.replace(`/model-studio?id=${s.id}`); }} />;
  // the home: every model studio; one opens in place (/model-studio?id=…)
  if (!id || !list)
    return (
      <>
        <AppHome
          app="Model Studio"
          icon="cpu"
          accent="#7c3aed"
          href="/model-studio"
          tagline="Train models without code: pick a trainer, map a dataset's columns and run training."
          description={
            <>
              A studio has a trainer and an output model. The configuration wizard maps datasets and columns, sets parameters and resources; each training run publishes a
              model version with an experiment.
            </>
          }
          headerActions={<Link href="/model-assets" className={buttonClass.ghost}><Icon name="cube" className="h-3.5 w-3.5" /> Models</Link>}
          noun={["model studio", "model studios"]}
          error={error}
          items={list?.map((s) => ({
            id: s.id,
            href: `/model-studio?id=${s.id}`,
            title: s.name,
            updated_at: s.last_run?.started_at ?? s.created_at,
            badges: [
              { label: trainers?.[s.trainer]?.name ?? s.trainer, tone: "muted" as const },
              ...(s.last_run ? [{ label: `Last run ${s.last_run.status}`, tone: s.last_run.status === "succeeded" ? ("ok" as const) : s.last_run.status === "failed" ? ("bad" as const) : ("warn" as const) }] : []),
            ],
            meta: `${s.configs} configuration${s.configs === 1 ? "" : "s"}${s.last_run?.version ? ` · model ${s.last_run.version}` : ""}`,
          })) ?? null}
          stats={[
            { label: "Studios", value: (list?.length ?? 0).toLocaleString() },
            { label: "Trained", value: (list ?? []).filter((s) => s.last_run?.status === "succeeded").length.toLocaleString() },
            { label: "Running", value: (list ?? []).filter((s) => s.last_run?.status === "running").length.toLocaleString() },
          ]}
          empty={{ title: "Train your first model", hint: "Choose a trainer, map a dataset and train a model without writing code.", steps: ["Pick a trainer and name the model", "Map the dataset's target and features", "Start a training run"] }}
          create={
            <button type="button" onClick={() => setCreating(true)} disabled={!trainers} className={buttonClass.primary}><Icon name="plus" className="h-3.5 w-3.5" /> New model studio</button>
          }
        />
        {create}
      </>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Model Studio" icon="cpu" href="/model-studio">
        <Link href="/model-assets" className={buttonClass.ghost}><Icon name="cube" className="h-3.5 w-3.5" /> Models</Link>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}><Icon name="plus" className="h-3.5 w-3.5" /> New model studio</button>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-line bg-panel p-2">
          <button type="button" onClick={() => router.replace("/model-studio")} className="flex items-center gap-1 px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-strong">
            <Icon name="left" className="h-3 w-3" /> All studios
          </button>
          {list.length === 0 && <p className="p-3 text-xs text-muted">No model studios. Choose a trainer, map a dataset and train a model without writing code.</p>}
          {list.map((s) => (
            <button key={s.id} type="button" onClick={() => router.replace(`/model-studio?id=${s.id}`)} className={`block w-full rounded px-3 py-2 text-left ${s.id === id ? "bg-panel-2" : "hover:bg-panel-2"}`}>
              <div className="truncate text-sm text-white">{s.name}</div>
              <div className="text-xs text-muted">{trainers?.[s.trainer]?.name ?? s.trainer}{s.last_run ? ` · ${s.last_run.status}` : ""}</div>
            </button>
          ))}
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          {id ? <StudioView key={id} id={id} trainers={trainers} onDeleted={() => { router.replace("/model-studio"); load(); }} onChanged={load} />
            : <p className="text-sm text-muted">Create a model studio to start.</p>}
        </main>
      </div>
      {create}
    </div>
  );
}

function CreateStudio({ trainers, onClose, onCreated }: { trainers: Record<Trainer, TrainerSpec>; onClose: () => void; onCreated: (s: Studio) => void }) {
  const [trainer, setTrainer] = useState<Trainer>("classification");
  const [name, setName] = useState("");
  const [modelName, setModelName] = useState("");
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Next stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a studio name"]), ...(modelName.trim() ? [] : ["enter an output model name"]), ...(folder ? [] : ["choose a location"])];
  const create = async () => {
    setTried(true);
    if (missing.length || !folder) return;
    setBusy(true);
    setErr(null);
    try {
      onCreated(await modelStudio.create({ name, trainer, folder_id: folder.id, model_name: modelName }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const nameInvalid = tried && !name.trim();
  const modelNameInvalid = tried && !modelName.trim();
  return (
    <Modal title="New model studio" icon="cpu" onClose={onClose}>
      <form className="space-y-3 p-5 text-sm" onSubmit={(e) => (e.preventDefault(), void create())}>
        <div className="grid gap-2">
          {(Object.entries(trainers) as [Trainer, TrainerSpec][]).map(([k, t]) => (
            <button key={k} type="button" onClick={() => setTrainer(k)} className={`rounded-lg border p-3 text-left ${trainer === k ? "border-ocean/60 bg-ocean/10" : "border-line bg-panel-2"}`}>
              <div className="text-sm text-white">{t.name}</div><div className="text-xs text-muted">{t.description}</div>
            </button>
          ))}
        </div>
        <label className="block">
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Studio name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give the studio a name.</span>}
        </label>
        <label className="block">
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Output model name <span className="text-bad" aria-hidden>*</span></span>
          <input value={modelName} onChange={(e) => setModelName(e.target.value)} aria-invalid={modelNameInvalid} className={`${inputClass} ${modelNameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} />
          {modelNameInvalid && <span className="mt-1 block text-[11px] text-bad">Name the model the training runs publish.</span>}
        </label>
        <LocationField value={folder} onChange={setFolder} invalid={tried} hint="Where the output model goes." />
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
          <button type="submit" disabled={busy} className={buttonClass.primary}>{busy ? "Creating…" : "Next"}</button>
        </div>
      </form>
    </Modal>
  );
}

const statusTone = (s: string) => (s === "succeeded" ? "text-ok" : s === "failed" ? "text-bad" : "text-warn");

function StudioView({ id, trainers, onDeleted, onChanged }: { id: string; trainers: Record<Trainer, TrainerSpec> | null; onDeleted: () => void; onChanged: () => void }) {
  const [s, setS] = useState<Studio | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [assist, setAssist] = useState(false);
  const toggleAssist = useCallback(() => setAssist((a) => !a), []);
  const [columns, setColumns] = useState<Column[]>([]);
  const [benchmark, setBenchmark] = useState<{ candidate: string; metrics: Record<string, number> }[] | null>(null);
  const load = useCallback(() => { modelStudio.get(id).then((x) => { setS(x); if (!x.configs.length) setWizard(true); }, (e: Error) => setErr(e.message)); }, [id]);
  // what AIP Assist reads: the training dataset's columns and the last successful run's candidates with their metrics
  const dataId = s?.configs.at(-1)?.training_dataset_id;
  const lastRun = s?.runs.find((r) => r.status === "succeeded" && r.experiment_id);
  useEffect(() => {
    if (!assist || !dataId) return;
    datasetPreview.summary(dataId).then((d) => setColumns(d.columns), () => setColumns([]));
  }, [assist, dataId]);
  useEffect(() => {
    if (!assist || !s || !lastRun?.experiment_id) return;
    trainedModels.experiment(s.model_id, lastRun.experiment_id).then(
      (e) => setBenchmark(Object.entries(e.evaluations ?? {}).map(([k, v]) => ({ candidate: k, metrics: v.metrics }))),
      () => setBenchmark(null),
    );
  }, [assist, s, lastRun?.experiment_id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!s?.runs.some((r) => r.status === "running")) return;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [s, load]);
  if (!s) return <p className="text-sm text-muted">{err ?? "Loading…"}</p>;
  const cfg = s.configs.at(-1);
  const run = s.runs.find((r) => r.id === selected) ?? s.runs[0];
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{s.name}</h1>
          <p className="text-sm text-muted">{trainers?.[s.trainer]?.name ?? s.trainer} trainer</p>
        </div>
        <div className="flex gap-2">
          <AipAssistButton open={assist} onToggle={toggleAssist} />
          <button type="button" className={buttonClass.secondary} onClick={() => setWizard(true)}><Icon name="sliders" className="h-3.5 w-3.5" /> Edit configuration</button>
          <button type="button" disabled={!cfg || s.runs.some((r) => r.status === "running")} className={buttonClass.primary}
            onClick={async () => { setErr(null); try { setS(await modelStudio.run(id)); onChanged(); } catch (e) { setErr((e as Error).message); } }}>
            <Icon name="play" className="h-3.5 w-3.5" /> Start training run
          </button>
          <button type="button" className={buttonClass.ghost} aria-label="Delete studio" onClick={async () => {
            if (!(await confirmDialog({ title: `Delete ${s.name}?`, message: "The studio's configuration and run history are removed; its model stays in Files.", danger: true, confirmLabel: "Delete" }))) return;
            await modelStudio.remove(id); onDeleted();
          }}><Icon name="trash" className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
      <Link href={`/model-assets/${s.model.id}`} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 hover:bg-panel-2">
        <Icon name="cube" className="h-5 w-5 text-ocean" />
        <div className="min-w-0 flex-1"><div className="text-sm text-white">{s.model.name}</div><div className="text-xs text-muted">{s.model.path.join(" / ")}</div></div>
        {s.out_of_date && <span className="text-xs text-warn" title="The training data changed since the last successful run">Out of date</span>}
        <span className="text-xs text-soft">{s.model.versions ? `${s.model.versions} version(s) · latest ${s.model.latest}` : "No versions yet"}</span>
      </Link>
      <label className="flex items-center gap-2 text-xs text-soft">
        <input type="checkbox" checked={!!s.retrain_on_update} disabled={!cfg} onChange={async (e) => { try { setS(await modelStudio.schedule(id, e.target.checked)); } catch (x) { setErr((x as Error).message); } }} />
        Retrain automatically when the training dataset updates
      </label>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-4 py-2.5 text-sm font-medium">Recent training runs</div>
          {s.runs.length === 0 ? <p className="p-4 text-xs text-muted">{cfg ? "No runs yet: start a training run." : "Configure the studio first."}</p> : (
            <table className="w-full text-xs">
              <thead className="text-muted"><tr>{["Name", "Started at", "Status", "Configuration version", "Model version"].map((h) => <th key={h} className="px-3 py-2 text-left font-normal">{h}</th>)}</tr></thead>
              <tbody>{s.runs.map((r) => (
                <tr key={r.id} onClick={() => setSelected(r.id)} className={`cursor-pointer border-t border-line ${run?.id === r.id ? "bg-panel-2" : "hover:bg-panel-2"}`}>
                  <td className="px-3 py-2 text-white">{r.config_name}</td><td className="px-3 py-2 text-soft">{when(r.started_at)}</td>
                  <td className={`px-3 py-2 ${statusTone(r.status)}`}>{r.status}</td><td className="px-3 py-2 text-soft">{r.config_version}</td><td className="px-3 py-2 text-soft">{r.version ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
        {run && <RunSidebar studio={s} run={run} />}
      </div>
      {run?.status === "succeeded" && run.experiment_id && (
        <section className="rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="text-sm font-medium">Benchmark of the candidates</span>
            <span className="text-xs text-muted">{run.config_name} · every candidate on the same validation rows · ★ published</span>
          </div>
          <div className="p-4"><TrainingResults key={run.experiment_id} modelId={s.model_id} experimentId={run.experiment_id} /></div>
        </section>
      )}
      {assist && (
        <AipAssistPanel
          adapter={studioAssist({
            studio: s, trainer: trainers?.[s.trainer] ?? null, columns, benchmark,
            saveConfig: async (c) => { setS(await modelStudio.saveConfig(id, c)); onChanged(); },
            startRun: async () => { setS(await modelStudio.run(id)); onChanged(); },
          })}
          onClose={() => setAssist(false)}
        />
      )}
      {wizard && <Wizard studio={s} trainer={trainers?.[s.trainer] ?? null} onClose={() => setWizard(false)} onSaved={(x) => { setS(x); setWizard(false); onChanged(); }} />}
    </div>
  );
}

const fmtMB = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

function RunSidebar({ studio, run }: { studio: Studio; run: TrainingRun }) {
  const cfg = studio.configs.find((c) => c.version === run.config_version);
  return (
    <aside className="space-y-3 rounded-xl border border-line bg-panel p-4 text-xs">
      <div><div className="text-sm text-white">{run.config_name}</div><div className="text-muted">{when(run.started_at)}{run.trigger && run.trigger !== "manual" && ` · ${run.trigger}`}{run.ms != null && ` · ${(run.ms / 1000).toFixed(1)} s`}</div></div>
      {run.version && <Link href={`/model-assets/${studio.model_id}`} className="block text-ocean hover:underline">{studio.model.name} {run.version}</Link>}
      {run.experiment_id && <Link href={`/model-assets/${studio.model_id}`} className="block text-ocean hover:underline">View experiment (Experiments tab)</Link>}
      {run.best_model && <div className="text-soft">Best model: <span className="text-white">{run.best_model}</span>{run.metrics && Object.entries(run.metrics).map(([k, v]) => ` · ${k} ${Math.abs(v).toFixed(4)}`)}</div>}
      {run.error && <pre className="whitespace-pre-wrap rounded bg-bad/10 p-2 text-bad">{run.error}</pre>}
      {cfg && (
        <div className="space-y-1 text-soft">
          <div className="text-muted">Inputs</div>
          <div>Training: <Link href={datasetHref(cfg.training_dataset_id)} className="text-ocean hover:underline">dataset</Link>{cfg.test_dataset_id && <> · test: <Link href={datasetHref(cfg.test_dataset_id)} className="text-ocean hover:underline">dataset</Link></>}</div>
          <div>Target: {cfg.target}{cfg.timestamp && ` · timestamp ${cfg.timestamp}`}{cfg.item_id && ` · series ${cfg.item_id}`}</div>
          {cfg.features.length > 0 && <div>Features: {cfg.features.join(", ")}</div>}
          {cfg.filters.length > 0 && <div>Filters: {cfg.filters.map((f) => `${f.column} ${f.op} ${f.value ?? ""}`).join("; ")}</div>}
          <div className="text-muted">Parameters</div>
          <div className="font-mono">{JSON.stringify(cfg.params)}</div>
          <div className="text-muted">Resources</div><div>{run.resources.cpu} vCPU · {run.resources.memory_gb} GB</div>
          {cfg.changelog && <><div className="text-muted">Changelog</div><div>{cfg.changelog}</div></>}
        </div>
      )}
      {run.data_read && Object.keys(run.data_read).length > 0 && (
        <div className="space-y-1 text-soft">
          <div className="text-muted">Data read</div>
          {Object.entries(run.data_read).map(([k, d]) => (
            <div key={k}>
              <span className="capitalize">{k}</span>: read {d.rows_read.toLocaleString()} of {d.rows_total.toLocaleString()} rows, {d.columns_read.length} of {d.columns_total} columns
              {d.rows_kept != null && <> · {d.rows_kept.toLocaleString()} rows kept after the filters</>}
              <div className="text-muted">
                {d.source}
                {d.bytes_total > 0 && (d.bytes_columns != null
                  ? <> · at most {fmtMB(d.bytes_columns)} of {fmtMB(d.bytes_total)} (the columns read)</>
                  : <> · {fmtMB(d.bytes_total)}</>)}
              </div>
              {d.filters_pushed.length > 0 && <div className="text-muted">Filters pushed to the scan: {d.filters_pushed.join("; ")}</div>}
              {d.filters_after_read.length > 0 && <div className="text-muted">Applied after the read: {d.filters_after_read.join("; ")}</div>}
            </div>
          ))}
        </div>
      )}
      {run.logs && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-[11px] text-muted">{run.logs}</pre>}
    </aside>
  );
}

function Wizard({ studio, trainer, onClose, onSaved }: { studio: Studio; trainer: TrainerSpec | null; onClose: () => void; onSaved: (s: Studio) => void }) {
  const prev = studio.configs.at(-1);
  const ts = studio.trainer === "time_series";
  const [step, setStep] = useState(0);
  const [c, setC] = useState<ConfigInput>(prev ? { ...prev } : {
    name: "Configuration 1", changelog: "", training_dataset_id: "", test_dataset_id: null, target: "", features: [], ignored: [], timestamp: null, item_id: null, filters: [],
    params: ts ? { prediction_length: 7, seasonal_period: 7 } : { eval_metric: trainer?.metrics[0] }, cpu: 2, memory_gb: 4,
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const [columns, setColumns] = useState<Column[]>([]);
  const [pick, setPick] = useState<"train" | "test" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (c.training_dataset_id) datasetPreview.summary(c.training_dataset_id).then((d) => { setColumns(d.columns); setNames((n) => ({ ...n, [d.id]: d.name })); }, () => setColumns([]));
  }, [c.training_dataset_id]);
  const role = (col: string) => (col === c.target ? "target" : col === c.timestamp ? "timestamp" : col === c.item_id ? "item_id" : c.ignored.includes(col) ? "ignored" : "feature");
  const setRole = (col: string, r: string) => {
    const next = { ...c, ignored: c.ignored.filter((x) => x !== col), target: c.target === col ? "" : c.target, timestamp: c.timestamp === col ? null : c.timestamp, item_id: c.item_id === col ? null : c.item_id };
    if (r === "target") next.target = col;
    if (r === "timestamp") next.timestamp = col;
    if (r === "item_id") next.item_id = col;
    if (r === "ignored") next.ignored = [...next.ignored, col];
    setC({ ...next, features: [] });
  };
  const steps = ["Inputs", "Parameters", "Compute resources", "Save"];
  const p = c.params as Record<string, unknown>;
  const setP = (k: string, v: unknown) => setC({ ...c, params: { ...c.params, [k]: v === "" ? undefined : v } });
  return (
    <Modal title="Configure model studio" icon="sliders" onClose={onClose} xl>
      <div className="flex gap-2 border-b border-line px-5 py-2 text-xs">{steps.map((x, i) => <button key={x} type="button" onClick={() => setStep(i)} className={`rounded px-2 py-1 ${step === i ? "bg-panel-2 text-white" : "text-muted"}`}>{i + 1}. {x}</button>)}</div>
      <div className="max-h-[65vh] space-y-4 overflow-y-auto p-5 text-sm">
        {step === 0 && (
          <>
            <div className="flex flex-wrap gap-4 text-xs">
              <div>Training dataset <button type="button" className="text-ocean hover:underline" onClick={() => setPick("train")}>{names[c.training_dataset_id] ?? (c.training_dataset_id ? "selected" : "Choose…")}</button></div>
              {!ts && <div>Test dataset (optional; else 20% of the training rows) <button type="button" className="text-ocean hover:underline" onClick={() => setPick("test")}>{c.test_dataset_id ? names[c.test_dataset_id] ?? "selected" : "Choose…"}</button>
                {c.test_dataset_id && <button type="button" className="ml-1 text-muted" onClick={() => setC({ ...c, test_dataset_id: null })}>clear</button>}</div>}
            </div>
            {columns.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-muted"><tr><th className="py-1 text-left font-normal">Column</th><th className="py-1 text-left font-normal">Type</th><th className="py-1 text-left font-normal">Mapping</th></tr></thead>
                <tbody>{columns.map((col) => (
                  <tr key={col.name} className="border-t border-line"><td className="py-1 text-white">{col.name}</td><td className="py-1 text-muted">{col.type}</td>
                    <td className="py-1"><select value={role(col.name)} onChange={(e) => setRole(col.name, e.target.value)} className={`${inputClass} w-40 py-1 text-xs`}>
                      <option value="feature">{ts ? "(unused)" : "Feature"}</option><option value="target">Target</option>
                      {ts && <option value="timestamp">Timestamp</option>}{ts && <option value="item_id">Series id (item_id)</option>}<option value="ignored">Ignored</option>
                    </select></td></tr>
                ))}</tbody>
              </table>
            )}
            <div>
              <div className="mb-1 flex items-center justify-between text-xs"><span className="text-muted">Filters (rows matching every filter are kept)</span>
                <button type="button" className="text-ocean hover:underline" onClick={() => setC({ ...c, filters: [...c.filters, { column: columns[0]?.name ?? "", op: "not_null" }] })}>Add filter</button></div>
              {c.filters.map((f, i) => {
                const upd = (patch: Partial<StudioFilter>) => setC({ ...c, filters: c.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="mb-1 flex gap-2 text-xs">
                    <select value={f.column} onChange={(e) => upd({ column: e.target.value })} className={`${inputClass} w-44 py-1 text-xs`}>{columns.map((x) => <option key={x.name}>{x.name}</option>)}</select>
                    <select value={f.op} onChange={(e) => upd({ op: e.target.value as StudioFilter["op"] })} className={`${inputClass} w-28 py-1 text-xs`}>{["==", "!=", ">", ">=", "<", "<=", "in", "is_null", "not_null"].map((o) => <option key={o}>{o}</option>)}</select>
                    {!["is_null", "not_null"].includes(f.op) && <input value={String(f.value ?? "")} onChange={(e) => upd({ value: e.target.value })} className={`${inputClass} w-40 py-1 text-xs`} />}
                    <button type="button" className="text-muted hover:text-bad" onClick={() => setC({ ...c, filters: c.filters.filter((_, j) => j !== i) })}>Remove</button>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {step === 1 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {ts ? (
              <>
                <label className="text-xs text-muted">Prediction length (points to forecast)<input type="number" value={Number(p.prediction_length ?? 7)} onChange={(e) => setP("prediction_length", Number(e.target.value))} className={`${inputClass} mt-1`} /></label>
                <label className="text-xs text-muted">Seasonal period<input type="number" value={Number(p.seasonal_period ?? 7)} onChange={(e) => setP("seasonal_period", Number(e.target.value))} className={`${inputClass} mt-1`} /></label>
                <label className="text-xs text-muted">Frequency (D, W, H, MS…; empty: inferred)<input value={String(p.frequency ?? "")} onChange={(e) => setP("frequency", e.target.value)} className={`${inputClass} mt-1`} /></label>
              </>
            ) : (
              <>
                <label className="text-xs text-muted">Evaluation metric<select value={String(p.eval_metric ?? trainer?.metrics[0] ?? "")} onChange={(e) => setP("eval_metric", e.target.value)} className={`${inputClass} mt-1`}>{(trainer?.metrics ?? []).map((m) => <option key={m}>{m}</option>)}</select></label>
                <label className="text-xs text-muted">Prediction column name (default: the target)<input value={String(p.prediction_column ?? "")} onChange={(e) => setP("prediction_column", e.target.value)} className={`${inputClass} mt-1`} /></label>
                {trainer?.algorithms && (
                  <div className="sm:col-span-2">
                    <AlgorithmPicker catalog={trainer.algorithms} value={(p.algorithms as AlgorithmChoice[] | undefined) ?? []} onChange={(v) => setP("algorithms", v.length ? v : undefined)} />
                  </div>
                )}
                {!((p.algorithms as unknown[] | undefined)?.length) && (<>
                <div className="text-xs text-muted sm:col-span-2">No algorithm picked: the built-in quick models train (LR, KNN, GBM).</div>
                <div className="text-xs text-muted">Excluded model types
                  <div className="mt-1 flex gap-3">{(trainer?.models ?? []).map((m) => (
                    <label key={m} className="flex items-center gap-1 text-soft"><input type="checkbox" checked={((p.excluded_model_types as string[]) ?? []).includes(m)}
                      onChange={(e) => setP("excluded_model_types", e.target.checked ? [...((p.excluded_model_types as string[]) ?? []), m] : ((p.excluded_model_types as string[]) ?? []).filter((x) => x !== m))} />{m}</label>
                  ))}</div>
                </div>
                {studio.trainer === "classification" && <label className="flex items-center gap-2 text-xs text-soft"><input type="checkbox" checked={!!p.predict_probabilities} onChange={(e) => setP("predict_probabilities", e.target.checked)} /> Predict probabilities (columns &lt;prediction&gt;_proba_&lt;class&gt;)</label>}
                <label className="text-xs text-muted sm:col-span-2">Advanced: hyperparameters (JSON; models not listed are not trained)
                  <textarea rows={3} defaultValue={p.hyperparameters ? JSON.stringify(p.hyperparameters) : ""} placeholder='{"GBM": [{"rounds": 100}, {}], "LR": {}}'
                    onBlur={(e) => { try { setP("hyperparameters", e.target.value.trim() ? JSON.parse(e.target.value) : undefined); setErr(null); } catch { setErr("Hyperparameters are not valid JSON"); } }} className={`${inputClass} mt-1 font-mono text-xs`} />
                </label>
                </>)}
              </>
            )}
          </div>
        )}
        {step === 2 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">vCPUs (up to 8)<input type="number" min={1} max={8} value={c.cpu} onChange={(e) => setC({ ...c, cpu: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label>
            <label className="text-xs text-muted">Memory in GB (up to 64)<input type="number" min={1} max={64} value={c.memory_gb} onChange={(e) => setC({ ...c, memory_gb: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label>
            <p className="text-xs text-muted sm:col-span-2">Recorded with each run. Training runs in its own process on this machine; no GPU is available.</p>
          </div>
        )}
        {step === 3 && (
          <div className="space-y-3">
            <label className="block text-xs text-muted">Configuration name<input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-muted">Changelog (what changed from the previous configuration)<textarea rows={3} value={c.changelog} onChange={(e) => setC({ ...c, changelog: e.target.value })} className={`${inputClass} mt-1`} /></label>
          </div>
        )}
        {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
      </div>
      <div className="flex justify-between border-t border-line px-5 py-3">
        <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)} className={buttonClass.ghost}>Back</button>
        {step < 3 ? <button type="button" onClick={() => setStep(step + 1)} className={buttonClass.secondary}>Next</button> : (
          <button type="button" disabled={!c.training_dataset_id || !c.target || !c.name.trim()} className={buttonClass.primary}
            onClick={async () => { setErr(null); try { onSaved(await modelStudio.saveConfig(studio.id, c)); } catch (e) { setErr((e as Error).message); } }}>Save configuration</button>
        )}
      </div>
      {pick && <DrivePicker title={pick === "train" ? "Training dataset" : "Test dataset"} onClose={() => setPick(null)} canPick={(it) => (it.name.endsWith(".parquet") ? null : "Not a dataset")}
        onPick={(it) => { setNames((n) => ({ ...n, [it.id]: it.name.replace(/\.parquet$/, "") })); setC(pick === "train" ? { ...c, training_dataset_id: it.id } : { ...c, test_dataset_id: it.id }); setPick(null); }} />}
    </Modal>
  );
}
