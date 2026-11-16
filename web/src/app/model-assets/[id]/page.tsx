"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { BarChart, formatMetric, LineChart, LoggedTableView, ParallelCoordinates, SERIES_COLORS } from "@/components/models/Charts";
import { DeploymentPanel } from "@/components/models/DeploymentPanel";
import { ExternalModelForm } from "@/components/models/ExternalModelForm";
import { ModelTelemetry } from "@/components/models/ModelTelemetry";
import { SpanWaterfall } from "@/components/models/SpanWaterfall";
import { TrainingResults } from "@/components/models/TrainingResults";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { datasetHref } from "@/lib/datasetPreview";
import { bytes, when } from "@/lib/format";
import { exampleInputs, trainedModels, type AdapterUpgradePlan, type ApiItem, type EvaluationSets, type Experiment, type ExperimentSummary, type ModelEvaluation, type TestRun, type TrainedModel, type TrainedVersion } from "@/lib/modelAssets";
import { modelDeployments, type Deployment } from "@/lib/modelDeployments";
import { objectives, type Objective } from "@/lib/modelingObjectives";

type Tab = "overview" | "experiments" | "evaluations" | "deployment";

/** A model trained in a Python transform (an MLflow model or an adapter): versions with their API, adapter and source, the
 *  experiments published with them, evaluation sets, and the direct live deployment. api/model_assets.py */
export default function ModelPage() {
  const { id } = useParams<{ id: string }>();
  const [model, setModel] = useState<TrainedModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (["overview", "experiments", "evaluations", "deployment"].includes(search.get("tab") ?? "") ? (search.get("tab") as Tab) : "overview"));
  const [versionId, setVersionId] = useState<string | null>(null);
  const load = useCallback(() => {
    trainedModels.get(id).then(setModel, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  if (error) return <ApiError message={error} />;
  if (!model) return <Loading />;
  const version = model.versions_detail.find((v) => v.id === versionId) ?? model.versions_detail[0] ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Models" icon="cube" href="/model-assets" crumbs={[...model.path.map((p) => ({ label: p })), { label: model.name }]}>
        {version && <SubmitButton model={model} version={version} />}
      </AppHeader>
      <div className="flex shrink-0 flex-col gap-2 border-b border-line bg-panel px-3 py-2 sm:flex-row sm:items-center sm:gap-3 sm:px-5 sm:py-0">
        <div className="flex min-w-0 gap-1 overflow-x-auto text-sm [scrollbar-width:thin]" role="tablist" aria-label="Model sections">
          {([["overview", "Overview"], ["experiments", `Experiments · ${model.experiments}`], ["evaluations", `Evaluations · ${model.evaluation_sets.length}`], ["deployment", "Live deployment"]] as [Tab, string][]).map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`shrink-0 border-b-2 px-3 py-2.5 transition-colors ${tab === t ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>{label}</button>
          ))}
        </div>
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted sm:ml-auto sm:py-1">
          <span className="shrink-0">Version</span>
          <select value={version?.id ?? ""} onChange={(e) => setVersionId(e.target.value)} aria-label="Select model version" className={`${inputClass} min-w-0 flex-1 py-1 text-xs sm:w-auto sm:flex-none`}>
            {model.versions_detail.map((v) => <option key={v.id} value={v.id}>{v.version} · {v.branch} · {when(v.created_at)}</option>)}
          </select>
        </label>
      </div>
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-[1500px]">
          {!version ? <p className="text-sm text-muted">This model has no versions yet: build the transform that publishes to it.</p>
            : tab === "overview" ? <Overview model={model} version={version} onChanged={(m) => { setModel(m); setVersionId(null); }} onPick={setVersionId} />
            : tab === "experiments" ? <Experiments model={model} />
            : tab === "evaluations" ? <Evaluations model={model} />
            : <LiveDeployment model={model} />}
        </div>
      </main>
    </div>
  );
}

function Card({ title, children, aside, icon }: { title: string; children: React.ReactNode; aside?: React.ReactNode; icon?: IconName }) {
  return (
    <section className="rounded-2xl border border-line bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 text-[13px] font-semibold">
        <span className="flex items-center gap-2">{icon && <Icon name={icon} className="h-4 w-4 text-ocean" />}{title}</span>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

const TYPE_TONE: Record<string, string> = {
  string: "bg-sky-500/15 text-sky-300", double: "bg-emerald-500/15 text-emerald-300", float: "bg-emerald-500/15 text-emerald-300",
  integer: "bg-amber-500/15 text-amber-300", long: "bg-amber-500/15 text-amber-300", boolean: "bg-violet-500/15 text-violet-300",
  timestamp: "bg-pink-500/15 text-pink-300", date: "bg-pink-500/15 text-pink-300",
};

/** One side of the model's API: each input / output with its columns as a compact typed list. */
function ApiSide({ title, items }: { title: string; items: ApiItem[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</div>
      {!items.length ? <p className="text-xs text-muted">None declared.</p> : items.map((i) => (
        <div key={i.name} className="mb-3 last:mb-0">
          <div className="mb-1.5 flex items-baseline gap-2">
            <code className="text-sm text-white">{i.name}</code>
            <span className="text-[11px] text-muted">
              {i.type === "tabular" ? `table · ${(i.columns ?? []).length || "any"} columns` : i.type === "parameter" ? `parameter · ${i.value_type}${i.default != null ? ` · default ${JSON.stringify(i.default)}` : ""}` : i.type}
            </span>
          </div>
          {i.type === "tabular" && (i.columns ?? []).length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
              {(i.columns ?? []).map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-3 border-b border-line/60 px-2.5 py-1 last:border-b-0">
                  <span className="truncate font-mono text-[11px] text-soft" title={c.name}>{c.name}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${TYPE_TONE[c.type] ?? "bg-panel-2 text-muted"}`}>{c.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Where a version was trained, as a label and a link. */
function sourceOf(version: TrainedVersion): { app: string; label: string; href: string | null } {
  const s = version.source as TrainedVersion["source"] & { workspace_id?: string };
  if (version.external) return { app: "Externally hosted", label: version.external.base_url || "external", href: null };
  if (s.kind === "model_studio") return { app: "Model Studio", label: s.repo, href: `/model-studio?id=${s.studio_id}` };
  if ((s.kind as unknown as string) === "code_workspace") return { app: "Jupyter", label: s.repo, href: `/code-workspaces?id=${s.workspace_id ?? ""}` };
  const file = s.transform?.split("::")[0];
  return { app: "Code Repositories", label: s.repo, href: s.repo_id ? `/code-repositories/${s.repo_id}${file ? `?file=${encodeURIComponent(file)}` : ""}` : null };
}

function Pill({ icon, children, href, tone = "default" }: { icon: IconName; children: React.ReactNode; href?: string | null; tone?: "default" | "ok" | "accent" }) {
  const cls = `inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
    tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : tone === "accent" ? "border-ocean/40 bg-ocean/10 text-ocean" : "border-line bg-panel-2/60 text-soft"
  }`;
  const inner = <><Icon name={icon} className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{children}</span></>;
  return href ? <Link href={href} className={`${cls} hover:border-ocean`}>{inner}</Link> : <span className={cls}>{inner}</span>;
}

/** The model at a glance: name, version, where it was trained, its API, its benchmarks, its lineage. */
function Hero({ model, version }: { model: TrainedModel; version: TrainedVersion }) {
  const [bench, setBench] = useState<Objective[]>([]);
  useEffect(() => {
    objectives.list().then((all) => setBench(all.filter((o) => o.candidates.some((c) => c.model_id === model.id && !c.archived))), () => setBench([]));
  }, [model.id]);
  const src = sourceOf(version);
  const cols = (items: ApiItem[]) => items.reduce((n, i) => n + (i.columns?.length ?? 0), 0);
  const mlflow = version.adapter.class === "MlflowModel";
  return (
    <section className="rounded-2xl border border-line bg-gradient-to-br from-violet-500/[0.07] via-panel to-panel p-5">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><Icon name="cpu" className="h-6 w-6" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-white">{model.name}</h1>
            <span className="rounded-md bg-panel-2 px-2 py-0.5 font-mono text-xs text-soft">v{version.version}</span>
            <span className="rounded-md bg-panel-2 px-2 py-0.5 text-xs text-muted">{version.branch}</span>
            <span className={`rounded-md px-2 py-0.5 text-xs ${mlflow ? "bg-violet-500/15 text-violet-200" : "bg-panel-2 text-muted"}`}>{mlflow ? "MLflow model" : version.adapter.class}</span>
          </div>
          <div className="mt-1 truncate text-xs text-muted">{["Files & Projects", ...model.path].join(" / ")} · published {when(version.created_at)} · {bytes(version.size_bytes)}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Pill icon={src.app === "Model Studio" ? "cpu" : src.app === "Jupyter" ? "doc" : "code"} href={src.href} tone="accent">Trained in {src.app} · {src.label}</Pill>
            <Pill icon="table">{cols(version.api.inputs)} inputs → {cols(version.api.outputs)} outputs</Pill>
            {version.training_datasets.length > 0 && <Pill icon="database" href={datasetHref(version.training_datasets[0].item_id)}>{version.training_datasets.length} training dataset{version.training_datasets.length > 1 ? "s" : ""}</Pill>}
            {bench.map((o) => <Pill key={o.id} icon="split" href={`/modeling-objectives?id=${o.id}&view=comparisons`} tone="ok">Benchmark · {o.name}</Pill>)}
            <Pill icon="split" href={`/lineage?node=${encodeURIComponent(`model:${model.id}`)}`}>Data Lineage</Pill>
          </div>
        </div>
      </div>
    </section>
  );
}

function Overview({ model, version, onChanged, onPick }: { model: TrainedModel; version: TrainedVersion; onChanged: (m: TrainedModel) => void; onPick: (versionId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const src = sourceOf(version);
  return (
    <div className="space-y-4">
      <Hero model={model} version={version} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {version.experiment_id ? (
            <Card title="Training results" icon="graph">
              <TrainingResults key={version.experiment_id} modelId={model.id} experimentId={version.experiment_id} />
            </Card>
          ) : (
            <Card title="Training results" icon="graph"><p className="text-xs text-muted">This version was published without a training run (no experiment).</p></Card>
          )}
          <Card title="Model API" icon="table" aside={<span className="text-xs font-normal text-muted">what the model reads and returns</span>}>
            <div className="grid gap-6 md:grid-cols-2">
              <ApiSide title="Inputs" items={version.api.inputs} />
              <ApiSide title="Outputs" items={version.api.outputs} />
            </div>
          </Card>
          <TestCard model={model} version={version} />
          <Card title="Use this model" icon="code">
            <pre className="overflow-x-auto rounded-lg bg-ink p-3 text-xs text-soft">{`from transforms.api import transform, Input, Output, ModelInput


@transform.using(
    data=Input("/path/to/input"),
    model=ModelInput("${["", ...model.path, model.name].join("/")}"),  # or "${model.rid}"; model_version="${version.rid}" pins this version
    out=Output("/path/to/output"),
)
def compute(data, model, out):
    out.write_pandas(model.predict(data.pandas()))`}</pre>
            <p className="mt-2 text-xs text-muted">The model is an MLflow model (open source); <code>predict()</code> returns a DataFrame. Add <code>use_sidecar=True</code> to run it in its own process. Without a pinned version, a build uses the latest version on its branch.</p>
          </Card>
          <Card title="Telemetry" icon="signal" aside={<span className="text-xs font-normal text-muted">Calls from transforms, linked to their builds</span>}>
            <ModelTelemetry modelId={model.id} />
          </Card>
        </div>
        <div className="min-w-0 space-y-4">
          {version.external && (
            <Card title="Externally hosted model" icon="plug" aside={model.can_edit ? <button type="button" onClick={() => setEditing(true)} className="text-xs font-normal text-ocean hover:underline">New version</button> : undefined}>
              <dl className="space-y-2 text-xs">
                <div><dt className="text-muted">URL</dt><dd className="break-all text-soft">{version.external.base_url || "—"}</dd></div>
                <div><dt className="text-muted">Connection configuration</dt><dd className="font-mono text-soft">{Object.entries(version.external.configuration).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}</dd></div>
                <div><dt className="text-muted">Credentials (encrypted)</dt><dd className="text-soft">{version.external.credential_keys.join(", ") || "—"}</dd></div>
              </dl>
              <p className="mt-2 text-[11px] text-muted">Batch deployments and automatic evaluation do not support externally hosted models; use it in a Python transform or a live deployment.</p>
            </Card>
          )}
          {editing && <ExternalModelForm model={model} version={version} onClose={() => setEditing(false)} onSaved={(m) => { setEditing(false); onChanged(m); }} />}
          <Card title="Details" icon="info">
            <dl className="space-y-2.5 text-xs">
              {([
                ["Trained in", src.href ? <Link key="s" href={src.href} className="text-ocean hover:underline">{src.app} · {src.label}</Link> : `${src.app} · ${src.label}`],
                ["Transform", <span key="t" className="break-all font-mono text-[11px]">{version.source.transform?.split("::").pop() ?? "—"}</span>],
                ["Training data", version.training_datasets.length ? (
                  <span key="d" className="flex flex-col items-end gap-0.5">{version.training_datasets.map((d) => <Link key={d.item_id} href={datasetHref(d.item_id)} className="text-ocean hover:underline">{d.name}</Link>)}</span>
                ) : "—"],
                ["Model files", bytes(version.size_bytes)],
                ["Pickle", version.pickle ? (
                  <a key="p" href={trainedModels.pickleUrl(model.id, version.id)} download className="inline-flex items-center gap-1 text-ocean hover:underline" title={`${version.pickle.file} of v${version.version}, as training saved it`}>
                    <Icon name="download" className="h-3 w-3" />{version.pickle.file} · {bytes(version.pickle.bytes)}</a>
                ) : "—"],
                ["Format", version.adapter.class === "MlflowModel" ? "MLflow (pyfunc)" : `${version.adapter.module}.${version.adapter.class}`],
                ["Serialization", version.serializers ? Object.entries(version.serializers).map(([k, v]) => `${k}: ${v}`).join(", ") : version.adapter.class === "MlflowModel" ? "MLflow" : "custom save() / load()"],
              ] as [string, React.ReactNode][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="shrink-0 text-muted">{k}</dt><dd className="min-w-0 text-right text-soft">{v}</dd></div>
              ))}
            </dl>
            <div className="mt-3 break-all rounded-md bg-ink px-2 py-1.5 font-mono text-[10px] text-muted">{version.rid}</div>
          </Card>
          <Card title={`Versions · ${model.versions_detail.length}`} icon="history">
            <ol className="relative space-y-0.5 text-xs">
              {model.versions_detail.slice(0, 15).map((v, i) => (
                <li key={v.id}>
                  <button type="button" onClick={() => onPick(v.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${v.id === version.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${v.id === version.id ? "bg-ocean" : i === 0 ? "bg-emerald-400" : "bg-line-2"}`} />
                    <span className="font-mono">v{v.version}</span>
                    {i === 0 && <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] text-emerald-300">latest</span>}
                    {v.upgraded_from && <span className="truncate text-[10px] text-muted">adapter upgrade of {v.upgraded_from.version}</span>}
                    <span className="ml-auto shrink-0 text-muted">{when(v.created_at)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Card>
          <InferenceConfiguration key={version.id} model={model} version={version} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}

/** Inference configuration: the adapter a version runs with, and "Upgrade model adapter" — a new version with the
 *  adapter at its repository's latest commit and the same published model artifacts (no retraining). */
function InferenceConfiguration({ model, version, onChanged }: { model: TrainedModel; version: TrainedVersion; onChanged: (m: TrainedModel) => void }) {
  const [plan, setPlan] = useState<AdapterUpgradePlan | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fromRepository = !!version.source.repo_id && version.source.kind !== "model_studio" && !version.external;
  const show = () => {
    setOpen(true);
    setPlan(null);
    setErr(null);
    trainedModels.adapterUpgradePlan(model.id, version.id).then(setPlan, (e: Error) => setErr(e.message));
  };
  return (
    <Card title="Inference configuration" icon="sliders">
      <dl className="space-y-2 text-xs">
        <div className="flex justify-between gap-3"><dt className="text-muted">Model adapter</dt><dd className="break-all text-right font-mono text-soft">{version.adapter.module}.{version.adapter.class}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">Adapter commit</dt><dd className="text-right font-mono text-soft">{version.source.commit ? version.source.commit.slice(0, 10) : "—"}</dd></div>
        {version.upgraded_from && <div className="flex justify-between gap-3"><dt className="text-muted">Model artifacts of</dt><dd className="text-right text-soft">version {version.upgraded_from.version}{version.api_changed ? " · API changed" : ""}</dd></div>}
      </dl>
      {fromRepository ? (
        model.can_edit && <button type="button" onClick={show} className={`${buttonClass.secondary} mt-3`}><Icon name="refresh" className="h-3.5 w-3.5" /> Upgrade model adapter</button>
      ) : <p className="mt-2 text-[11px] text-muted">Adapter upgrades apply to models trained in Code Repositories.</p>}
      {open && (
        <Modal title="Upgrade model adapter" icon="refresh" onClose={() => setOpen(false)} wide>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted">
              Creates a new model version with the adapter as it is at the latest commit of its repository, keeping the model artifacts published with version {version.version}.
              The adapter must stay in the same Python module with the same class name, and its load, api and predict must fit the existing artifacts: the upgraded adapter is loaded once before the version is created.
            </p>
            {err && <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-bad/10 p-2 text-xs text-bad">{err}</pre>}
            {!plan && !err && <div className="text-xs text-muted">Reading the repository…</div>}
            {plan && (
              <>
                <dl className="space-y-1.5 rounded border border-line bg-panel-2 p-3 text-xs">
                  <div className="flex justify-between gap-3"><dt className="text-muted">Repository</dt><dd><Link href={`/code-repositories/${plan.repo.id}`} className="text-ocean hover:underline">{plan.repo.name}</Link> <span className="text-muted">· {plan.branch}</span></dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted">Adapter</dt><dd className="break-all text-right font-mono text-soft">{plan.adapter_file} · {plan.class}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted">Commit</dt><dd className="text-right font-mono text-soft">{(plan.from_commit ?? "—").slice(0, 10)} → {(plan.commit ?? "uncommitted").slice(0, 10)}</dd></div>
                  {plan.commit_message && <div className="flex justify-between gap-3"><dt className="text-muted">Latest commit</dt><dd className="text-right text-soft">{plan.commit_message}{plan.commit_at ? ` · ${when(plan.commit_at)}` : ""}</dd></div>}
                </dl>
                {plan.up_to_date ? (
                  <p className="text-xs text-warn">This version already runs the adapter at the latest commit. Commit the adapter change in the repository first.</p>
                ) : (
                  <div>
                    <div className="mb-1 text-xs text-muted">Source changes since this version ({plan.changed.length}){plan.adapter_changed ? "" : " · the adapter file itself is unchanged"}</div>
                    <ul className="max-h-40 space-y-0.5 overflow-auto rounded bg-ink p-2 font-mono text-[11px]">
                      {plan.changed.map((c) => <li key={c.path} className={c.status === "removed" ? "text-bad" : c.status === "added" ? "text-ok" : "text-soft"}>{c.status === "added" ? "+" : c.status === "removed" ? "−" : "~"} {c.path}</li>)}
                    </ul>
                  </div>
                )}
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Description of the new version (optional)" className={inputClass} maxLength={2000} />
                <p className="text-[11px] text-muted">Submissions to modeling objectives are not moved: submit the new version again. Live deployments of this model on {version.branch} upgrade to it.</p>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className={buttonClass.ghost}>Cancel</button>
              <button type="button" disabled={busy || !plan || plan.up_to_date} className={buttonClass.primary}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await trainedModels.adapterUpgrade(model.id, version.id, note);
                    setOpen(false);
                    onChanged(await trainedModels.get(model.id));
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}>
                {busy ? "Loading the upgraded adapter…" : "Create model version"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function TestCard({ model, version }: { model: TrainedModel; version: TrainedVersion }) {
  const example = useMemo(() => JSON.stringify(exampleInputs(version.api), null, 2), [version]);
  const [text, setText] = useState("");
  const [res, setRes] = useState<TestRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Test this version" icon="play" aside={<span className="text-xs font-normal text-muted">Loads the version in its own process, runs once and stops</span>}>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <textarea value={text || example} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
          <button type="button" disabled={busy} className={`${buttonClass.primary} mt-2`}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                setRes(await trainedModels.predict(model.id, version.id, JSON.parse(text || example)));
              } catch (e) {
                setRes(null);
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}>
            <Icon name="play" className="h-3.5 w-3.5" /> {busy ? "Running…" : "Run"}
          </button>
        </div>
        {err ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bad/10 p-2 text-xs text-bad">{err}</pre>
          : <pre className="max-h-64 overflow-auto rounded bg-ink p-2 text-xs text-soft">{res ? JSON.stringify(res.outputs, null, 2) : "The outputs appear here."}</pre>}
      </div>
      {res && ((res.spans?.length ?? 0) > 0 || res.logs) && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted hover:text-white">Telemetry of this run{res.ms != null ? ` · ${res.ms} ms` : ""} · {res.spans?.length ?? 0} span(s)</summary>
          <div className="mt-2 space-y-2">
            <SpanWaterfall spans={res.spans ?? []} />
            {res.logs && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-[11px] text-muted">{res.logs}</pre>}
          </div>
        </details>
      )}
    </Card>
  );
}

function SubmitButton({ model, version }: { model: TrainedModel; version: TrainedVersion }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Objective[]>([]);
  const [objectiveId, setObjectiveId] = useState("");
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) objectives.list().then((o) => { setList(o); setObjectiveId((c) => c || o[0]?.id || ""); }, (e: Error) => setErr(e.message));
  }, [open]);
  const objective = list.find((o) => o.id === objectiveId);
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); setMsg(null); setErr(null); }} className={buttonClass.primary}><Icon name="upload" className="h-3.5 w-3.5" /> Submit to a Modeling Objective</button>
      {open && (
        <Modal title="Submit to a Modeling Objective" icon="layers" onClose={() => setOpen(false)}>
          <div className="space-y-3 p-5 text-sm">
            <p className="text-xs text-muted">Submits <span className="text-white">{model.name}</span> version {version.version} for evaluation, review, release and deployment.</p>
            {list.length === 0 ? <p className="text-xs text-muted">No modeling objectives yet. <Link href="/modeling-objectives" className="text-ocean hover:underline">Create one</Link>.</p> : (
              <label className="block text-xs text-muted">Objective
                <select value={objectiveId} onChange={(e) => setObjectiveId(e.target.value)} className={`${inputClass} mt-1`}>{list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
              </label>
            )}
            {(objective?.metadata_fields ?? []).map((f) => (
              <label key={f.id} className="block text-xs text-muted">{f.name}{f.required && " *"}
                {f.type === "select" ? (
                  <select value={meta[f.id] ?? ""} onChange={(e) => setMeta({ ...meta, [f.id]: e.target.value })} className={`${inputClass} mt-1`}><option value="" />{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                ) : <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={meta[f.id] ?? ""} onChange={(e) => setMeta({ ...meta, [f.id]: e.target.value })} className={`${inputClass} mt-1`} />}
              </label>
            ))}
            {err && <p className="text-xs text-bad">{err}</p>}
            {msg && <p className="text-xs text-ok">{msg} <Link href={`/modeling-objectives?id=${objectiveId}`} className="text-ocean hover:underline">Open the objective</Link></p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className={buttonClass.ghost}>Close</button>
              <button type="button" disabled={!objective} className={buttonClass.primary}
                onClick={async () => {
                  setErr(null);
                  try {
                    const values = Object.fromEntries((objective?.metadata_fields ?? []).filter((f) => (meta[f.id] ?? "") !== "").map((f) => [f.id, f.type === "number" ? Number(meta[f.id]) : f.type === "boolean" ? meta[f.id] === "true" : meta[f.id]]));
                    await objectives.submit(objectiveId, { model_id: model.id, version: version.id, metadata: values });
                    setMsg("Submitted.");
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}>
                Submit
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// -- experiments --------------------------------------------------------------------------------------------------

function Experiments({ model }: { model: TrainedModel }) {
  const [list, setList] = useState<ExperimentSummary[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [full, setFull] = useState<Record<string, Experiment>>({});
  const [view, setView] = useState<"charts" | "images" | "plots" | "tables">("charts");
  const [pc, setPc] = useState<{ params: string[]; metric: string; agg: "last" | "min" | "max" } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    trainedModels.experiments(model.id).then((l) => { setList(l); setSelected(l.slice(0, 1).map((e) => e.id)); }, () => setList([]));
  }, [model.id]);
  useEffect(() => {
    for (const eid of selected) if (!full[eid]) trainedModels.experiment(model.id, eid).then((e) => setFull((f) => ({ ...f, [eid]: e })), () => {});
  }, [selected, full, model.id]);
  if (!list) return <Loading />;
  if (!list.length) return <p className="text-sm text-muted">No experiments. Create one with <code className="text-soft">model_output.create_experiment(name=…)</code>, log parameters and metrics, and pass it to <code className="text-soft">publish(adapter, experiment=experiment)</code>.</p>;
  const chosen = selected.map((eid) => list.find((e) => e.id === eid)).filter(Boolean) as ExperimentSummary[];
  const color = (eid: string) => SERIES_COLORS[selected.indexOf(eid) % SERIES_COLORS.length];
  const paramKeys = [...new Set(chosen.flatMap((e) => Object.keys(e.params)))];
  const metricKeys = [...new Set(chosen.flatMap((e) => Object.keys(e.metrics)))];
  const toggle = (eid: string) => setSelected((s) => (s.includes(eid) ? s.filter((x) => x !== eid) : s.length >= 5 ? s : [...s, eid]));
  const series = (name: string) => chosen.filter((e) => full[e.id]?.metrics[name]).map((e) => ({ name: e.name, color: color(e.id), points: full[e.id].metrics[name].map((p) => [p.step, p.value] as [number, number]) }));
  return (
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="rounded-xl border border-line bg-panel p-2">
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted">Experiments · up to 5 compared</div>
        {list.map((e) => (
          <button key={e.id} type="button" onClick={() => toggle(e.id)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${selected.includes(e.id) ? "bg-panel-2 text-white" : "text-soft hover:bg-panel-2"}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-line-2" style={{ background: selected.includes(e.id) ? color(e.id) : "transparent" }} />
            <span className="min-w-0 flex-1 truncate">{e.name}</span><span className="text-muted">{e.version}</span>
          </button>
        ))}
      </aside>
      <div className="space-y-4">
        <Card title="Hyperparameters">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted"><tr><th className="px-2 py-1 text-left font-normal">Experiment</th><th className="px-2 py-1 text-left font-normal">Version</th>{paramKeys.map((k) => <th key={k} className="px-2 py-1 text-left font-normal">{k}</th>)}</tr></thead>
              <tbody>
                {chosen.map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="px-2 py-1 text-white"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: color(e.id) }} />{e.name}</td>
                    <td className="px-2 py-1 text-soft">{e.version}</td>
                    {paramKeys.map((k) => <td key={k} className="px-2 py-1 font-mono text-soft">{e.params[k] === undefined ? "—" : String(e.params[k])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="flex items-center gap-1 text-xs">
          {(["charts", "images", "plots", "tables"] as const).map((v) => <button key={v} type="button" onClick={() => setView(v)} className={`rounded px-3 py-1.5 capitalize ${view === v ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}>{v === "charts" ? "Metrics" : v}</button>)}
          {view === "charts" && !pc && metricKeys.length > 0 && (
            <button type="button" className={`${buttonClass.ghost} ml-auto`} onClick={() => setPc({ params: paramKeys.slice(0, 3), metric: metricKeys[0], agg: "last" })}><Icon name="plus" className="h-3.5 w-3.5" /> Parallel coordinate plot</button>
          )}
        </div>
        {view === "charts" && (
          <>
            {pc && (
              <Card title="Parallel coordinate plot" aside={<button type="button" className="text-xs font-normal text-muted hover:text-white" onClick={() => setPc(null)}>Remove</button>}>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  {paramKeys.map((k) => (
                    <label key={k} className="flex items-center gap-1 text-soft"><input type="checkbox" checked={pc.params.includes(k)} onChange={(e) => setPc({ ...pc, params: e.target.checked ? [...pc.params, k] : pc.params.filter((x) => x !== k) })} />{k}</label>
                  ))}
                  <span className="ml-auto text-muted">Output</span>
                  <select value={pc.metric} onChange={(e) => setPc({ ...pc, metric: e.target.value })} className={`${inputClass} w-auto py-1 text-xs`}>{metricKeys.map((k) => <option key={k}>{k}</option>)}</select>
                  <select value={pc.agg} onChange={(e) => setPc({ ...pc, agg: e.target.value as "last" | "min" | "max" })} className={`${inputClass} w-auto py-1 text-xs`}><option value="last">Last</option><option value="min">Min</option><option value="max">Max</option></select>
                </div>
                <ParallelCoordinates axes={[...pc.params, `${pc.metric} (${pc.agg})`]}
                  rows={chosen.map((e) => ({ label: e.name, color: color(e.id), values: [...pc.params.map((k) => (e.params[k] ?? null) as number | string | boolean | null), e.metrics[pc.metric]?.[pc.agg] ?? null] }))} />
              </Card>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {metricKeys.map((k) => (
                <Card key={k} title={k} aside={<button type="button" className="text-muted hover:text-white" aria-label="Expand" onClick={() => setExpanded(k)}><Icon name="fit" className="h-3.5 w-3.5" /></button>}>
                  <LineChart series={series(k)} xLabel="step" />
                </Card>
              ))}
            </div>
            {metricKeys.length === 0 && <p className="text-xs text-muted">The selected experiments logged no metrics.</p>}
          </>
        )}
        {view === "images" && <SeriesCards chosen={chosen} color={color} pick={(e) => full[e.id]?.images ?? {}} render={(v) => (
          <div className="flex gap-2 overflow-x-auto">{(v as { step: number; png: string; caption: string }[]).map((img) => (
            <a key={img.step} href={`data:image/png;base64,${img.png}`} download={`step-${img.step}.png`} className="shrink-0 text-center text-[11px] text-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`data:image/png;base64,${img.png}`} alt={img.caption || `step ${img.step}`} className="h-40 rounded border border-line" />step {img.step}{img.caption && ` · ${img.caption}`}
            </a>
          ))}</div>
        )} empty="No images were logged (log_image)." />}
        {view === "plots" && <SeriesCards chosen={chosen} color={color} pick={(e) => full[e.id]?.plots ?? {}} render={(v) => <FigureView figure={(v as { figure: unknown }[]).at(-1)?.figure} />} empty="No plots were logged (log_plot takes a Plotly figure or its JSON)." />}
        {view === "tables" && <SeriesCards chosen={chosen} color={color} pick={(e) => full[e.id]?.tables ?? {}} render={(v) => <LoggedTableView table={v as Experiment["tables"][string]} />} empty="No tables were logged (log_table)." />}
      </div>
      {expanded && (
        <Modal title={expanded} icon="graph" onClose={() => setExpanded(null)} xl>
          <div className="p-5"><LineChart series={series(expanded)} height={320} xLabel="step" /></div>
        </Modal>
      )}
    </div>
  );
}

function SeriesCards<T>({ chosen, color, pick, render, empty }: { chosen: ExperimentSummary[]; color: (id: string) => string; pick: (e: ExperimentSummary) => Record<string, T>; render: (v: T) => React.ReactNode; empty: string }) {
  const names = [...new Set(chosen.flatMap((e) => Object.keys(pick(e))))];
  if (!names.length) return <p className="text-xs text-muted">{empty}</p>;
  return (
    <div className="space-y-4">
      {names.map((n) => (
        <Card key={n} title={n}>
          <div className="space-y-3">
            {chosen.filter((e) => pick(e)[n] !== undefined).map((e) => (
              <div key={e.id}><div className="mb-1 text-xs" style={{ color: color(e.id) }}>{e.name}</div>{render(pick(e)[n])}</div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** A Plotly figure's JSON drawn simply: bar / histogram traces as bars, everything else as lines. */
function FigureView({ figure }: { figure: unknown }) {
  const fig = figure as { data?: { type?: string; x?: (number | string)[]; y?: number[]; name?: string }[]; layout?: { title?: { text?: string } | string } } | undefined;
  const traces = (fig?.data ?? []).filter((t) => Array.isArray(t.y) || Array.isArray(t.x));
  if (!traces.length) return <pre className="max-h-48 overflow-auto rounded bg-ink p-2 text-[11px] text-muted">{JSON.stringify(figure, null, 1)?.slice(0, 4000)}</pre>;
  const title = typeof fig?.layout?.title === "string" ? fig.layout.title : fig?.layout?.title?.text;
  const bar = traces[0].type === "bar";
  return (
    <div>
      {title && <div className="mb-1 text-xs text-soft">{title}</div>}
      {bar ? <BarChart x={(traces[0].x ?? []).map(String)} y={traces[0].y ?? []} />
        : <LineChart series={traces.map((t, i) => ({ name: t.name ?? `trace ${i + 1}`, color: SERIES_COLORS[i % SERIES_COLORS.length], points: (t.y ?? []).map((y, j) => [typeof t.x?.[j] === "number" ? (t.x[j] as number) : j, y] as [number, number]) }))} />}
    </div>
  );
}

// -- evaluations --------------------------------------------------------------------------------------------------

function Evaluations({ model }: { model: TrainedModel }) {
  const [data, setData] = useState<EvaluationSets | null>(null);
  const [set, setSet] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<"overview" | "metrics" | "images" | "plots" | "tables">("overview");
  const [groupBy, setGroupBy] = useState<"subset" | "metric">("subset");
  const [branch, setBranch] = useState("");
  const [running, setRunning] = useState(false);
  const [runVersion, setRunVersion] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    trainedModels.evaluations(model.id, set).then((d) => { setData(d); setSelected((s) => (s.length ? s.filter((x) => d.evaluations.some((e) => e.id === x)) : d.evaluations.slice(0, 1).map((e) => e.id))); }, () => setData({ sets: [], set: null, evaluations: [], schedules: [] }));
  }, [model.id, set]);
  useEffect(load, [load]);
  if (!data) return <Loading />;
  if (!data.sets.length) {
    return <p className="text-sm text-muted">No evaluations. Decorate a transform with <code className="text-soft">@evaluation(&quot;set name&quot;)</code> (from transforms.api), call <code className="text-soft">model_input.create_evaluation().log_metrics(...)</code> with scikit-learn metrics and build it: the evaluation is committed when the build succeeds.</p>;
  }
  const evs = data.evaluations.filter((e) => !branch || e.branch === branch);
  const chosen = selected.map((x) => data.evaluations.find((e) => e.id === x)).filter(Boolean) as ModelEvaluation[];
  const schedule = data.schedules[0];
  const groups = new Map<string, ModelEvaluation[]>();
  for (const e of evs) groups.set(e.version ?? "?", [...(groups.get(e.version ?? "?") ?? []), e]);
  const toggle = (eid: string) => setSelected((s) => (s.includes(eid) ? s.filter((x) => x !== eid) : [...s, eid]));
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="rounded-xl border border-line bg-panel p-2">
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted">Evaluation sets</div>
        {data.sets.map((s) => (
          <button key={s.name} type="button" onClick={() => { setSet(s.name); setSelected([]); }} className={`flex w-full justify-between rounded px-2 py-1.5 text-left text-xs ${data.set === s.name ? "bg-panel-2 text-white" : "text-soft hover:bg-panel-2"}`}>
            <span className="truncate">{s.name}</span><span className="text-muted">{s.evaluations}</span>
          </button>
        ))}
      </aside>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(["overview", "metrics", "images", "plots", "tables"] as const).map((v) => <button key={v} type="button" onClick={() => setView(v)} className={`rounded px-3 py-1.5 capitalize ${view === v ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}>{v}</button>)}
          <div className="ml-auto flex items-center gap-2">
            {schedule && model.can_edit && (
              <label className="flex items-center gap-1 text-soft" title="Runs the transform that writes this set whenever a new model version is published">
                <input type="checkbox" checked={schedule.on_new_version} onChange={async (e) => { await trainedModels.scheduleEvaluation(model.id, data.set as string, e.target.checked); load(); }} /> Run on new versions
              </label>
            )}
            {schedule && model.can_edit && (
              <>
                <select value={runVersion} onChange={(e) => setRunVersion(e.target.value)} className={`${inputClass} w-auto py-1 text-xs`}>
                  <option value="">Latest version</option>{model.versions_detail.map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
                </select>
                <button type="button" disabled={running} className={buttonClass.secondary}
                  onClick={async () => {
                    setRunning(true);
                    setMsg(null);
                    try {
                      const r = await trainedModels.runEvaluation(model.id, data.set as string, runVersion || null);
                      setMsg(r.status === "succeeded" ? "The evaluation ran." : `The build failed: ${r.error}`);
                      load();
                    } catch (e) {
                      setMsg((e as Error).message);
                    } finally {
                      setRunning(false);
                    }
                  }}>
                  <Icon name="play" className="h-3.5 w-3.5" /> {running ? "Running…" : "Run"}
                </button>
              </>
            )}
          </div>
        </div>
        {msg && <p className="whitespace-pre-wrap text-xs text-soft">{msg}</p>}
        {view === "overview" && (
          <Card title={`${data.set} · ${evs.length} evaluation(s)`} aside={
            <select value={branch} onChange={(e) => setBranch(e.target.value)} className={`${inputClass} w-auto py-1 text-xs font-normal`}>
              <option value="">All branches</option>{[...new Set(data.evaluations.map((e) => e.branch))].map((b) => <option key={b}>{b}</option>)}
            </select>}>
            {[...groups.entries()].map(([ver, list]) => (
              <div key={ver} className="mb-3 last:mb-0">
                <div className="mb-1 text-xs text-muted">Model version {ver}</div>
                {list.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 border-t border-line py-1.5 text-xs">
                    <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} aria-label={`Compare ${e.name}`} />
                    <span className="flex-1 text-white">{e.name}</span>
                    <span className="text-muted">{Object.keys(e.metrics).length} metrics · {e.branch} · {when(e.created_at)}</span>
                    <button type="button" className="text-ocean hover:underline" onClick={() => { setSelected((s) => (s.includes(e.id) ? s : [...s, e.id])); setView("metrics"); }}>View metrics</button>
                  </div>
                ))}
              </div>
            ))}
          </Card>
        )}
        {view === "metrics" && (
          <Card title="Metrics" aside={<select value={groupBy} onChange={(e) => setGroupBy(e.target.value as "subset" | "metric")} className={`${inputClass} w-auto py-1 text-xs font-normal`}><option value="subset">Group by subset</option><option value="metric">Group by metric</option></select>}>
            <MetricsTable chosen={chosen} groupBy={groupBy} />
          </Card>
        )}
        {view === "images" && <EvalCards chosen={chosen} pick={(e) => e.images} render={(v) => {
          const img = v as { png: string; caption: string };
          // eslint-disable-next-line @next/next/no-img-element
          return <a href={`data:image/png;base64,${img.png}`} download="image.png"><img src={`data:image/png;base64,${img.png}`} alt={img.caption} className="max-h-64 rounded border border-line" /></a>;
        }} empty="No images were logged (log_image)." />}
        {view === "plots" && <EvalCards chosen={chosen} pick={(e) => e.plots} render={(v) => <FigureView figure={(v as { figure: unknown }).figure} />} empty="No plots were logged (log_plot)." />}
        {view === "tables" && <EvalCards chosen={chosen} pick={(e) => e.tables} render={(v) => <LoggedTableView table={v as ModelEvaluation["tables"][string]} />} empty="No tables were logged (log_table)." />}
      </div>
    </div>
  );
}

function MetricsTable({ chosen, groupBy }: { chosen: ModelEvaluation[]; groupBy: "subset" | "metric" }) {
  if (!chosen.length) return <p className="text-xs text-muted">Select evaluations in the Overview tab to compare them.</p>;
  const keys = [...new Set(chosen.flatMap((e) => Object.keys(e.metrics)))];
  const split = (k: string) => (k.includes("/") ? [k.slice(0, k.indexOf("/")), k.slice(k.indexOf("/") + 1)] : ["Overall", k]);
  const groups = new Map<string, string[]>();
  for (const k of keys) {
    const [subset, metric] = split(k);
    const g = groupBy === "subset" ? subset : metric;
    groups.set(g, [...(groups.get(g) ?? []), k]);
  }
  const order = [...groups.keys()].sort((a, b) => (a === "Overall" ? -1 : b === "Overall" ? 1 : a.localeCompare(b)));
  return (
    <table className="w-full text-xs">
      <thead className="text-muted"><tr><th className="px-2 py-1 text-left font-normal">{groupBy === "subset" ? "Metric" : "Subset"}</th>{chosen.map((e) => <th key={e.id} className="px-2 py-1 text-right font-normal">{e.name} <span className="text-muted">({e.version})</span></th>)}</tr></thead>
      <tbody>
        {order.map((g) => (
          <FragmentRows key={g} title={g} rows={(groups.get(g) ?? []).map((k) => ({ label: split(k)[groupBy === "subset" ? 1 : 0], values: chosen.map((e) => e.metrics[k]) }))} span={chosen.length + 1} />
        ))}
      </tbody>
    </table>
  );
}

function FragmentRows({ title, rows, span }: { title: string; rows: { label: string; values: (number | undefined)[] }[]; span: number }) {
  return (
    <>
      <tr><td colSpan={span} className="bg-panel-2 px-2 py-1 text-[11px] uppercase tracking-wide text-muted">{title}</td></tr>
      {rows.map((r) => (
        <tr key={r.label} className="border-t border-line"><td className="px-2 py-1 text-soft">{r.label}</td>{r.values.map((v, i) => <td key={i} className="px-2 py-1 text-right font-mono text-white">{v === undefined ? "—" : formatMetric(v)}</td>)}</tr>
      ))}
    </>
  );
}

function EvalCards<T>({ chosen, pick, render, empty }: { chosen: ModelEvaluation[]; pick: (e: ModelEvaluation) => Record<string, T>; render: (v: T) => React.ReactNode; empty: string }) {
  const names = [...new Set(chosen.flatMap((e) => Object.keys(pick(e))))];
  if (!names.length) return <p className="text-xs text-muted">{chosen.length ? empty : "Select evaluations in the Overview tab."}</p>;
  return (
    <div className="space-y-4">
      {names.map((n) => (
        <Card key={n} title={n}>
          <div className={`grid gap-4 ${chosen.length > 1 ? "md:grid-cols-2" : ""}`}>
            {chosen.filter((e) => pick(e)[n] !== undefined).map((e) => <div key={e.id}><div className="mb-1 text-xs text-muted">{e.name} · version {e.version}</div>{render(pick(e)[n])}</div>)}
          </div>
        </Card>
      ))}
    </div>
  );
}

// -- live deployment ----------------------------------------------------------------------------------------------

function LiveDeployment({ model }: { model: TrainedModel }) {
  const [deps, setDeps] = useState<Deployment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { modelDeployments.list({ model_id: model.id }).then(setDeps, (e: Error) => setErr(e.message)); }, [model.id]);
  useEffect(load, [load]);
  const branches = [...new Set(model.versions_detail.map((v) => v.branch))];
  const free = branches.filter((b) => !(deps ?? []).some((d) => d.branch === b));
  const [branch, setBranch] = useState("");
  if (!deps) return err ? <p className="text-sm text-bad">{err}</p> : <Loading />;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        A direct model deployment hosts the latest version on a branch behind a REST endpoint and upgrades by itself when a new version is published there.
        For releases you control (staging, production), deploy from a <Link href="/modeling-objectives" className="text-ocean hover:underline">Modeling Objective</Link> instead.
      </p>
      {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
      {deps.map((d) => <DeploymentPanel key={d.id} id={d.id} canEdit={model.can_edit} onDeleted={load} />)}
      {model.can_edit && free.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-line-2 p-4 text-sm">
          <span className="text-soft">Branch</span>
          <select value={branch || free[0]} onChange={(e) => setBranch(e.target.value)} className={`${inputClass} w-auto`}>{free.map((b) => <option key={b}>{b}</option>)}</select>
          <button type="button" disabled={busy} className={buttonClass.primary}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await modelDeployments.createDirect(model.id, branch || free[0]);
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
                load();
              }
            }}>
            <Icon name="play" className="h-3.5 w-3.5" /> {busy ? "Starting…" : "Start deployment"}
          </button>
        </div>
      )}
    </div>
  );
}
