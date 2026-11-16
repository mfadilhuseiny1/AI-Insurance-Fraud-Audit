"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import { API_URL } from "@/lib/api";
import { LifecycleGuide } from "@/components/models/Lifecycle";
import { modelOverview, type Overview } from "@/lib/modelOverview";

const PATHS: { label: string; description: string; icon: IconName; href: string }[] = [
  { label: "Model Studio", description: "No-code training: pick a trainer, map a dataset, run. Each run publishes a model version with an experiment.", icon: "cpu", href: "/model-studio" },
  { label: "Code Repositories", description: "Train in a Python transform with MLflow (open source): ModelOutput.publish(model). Start from the Model Training template.", icon: "code", href: "/code-repositories" },
  { label: "Container models", description: "Push images to the model's Docker repository and pair them with a container model adapter.", icon: "server", href: "/container-models" },
  { label: "Externally hosted", description: "Connect a model served elsewhere: URL, configuration, encrypted credentials and an adapter.", icon: "plug", href: "/model-assets" },
];

/** Model Integration: the guide (the four steps and every model's progress through them, with its next step), where
 *  models come from, how many there are, what is released and deployed. Live from api/model_overview.py. */
export default function ModelIntegrationPage() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState<{ busy: boolean; message: string | null; objective?: string }>({ busy: false, message: null });
  useEffect(() => { modelOverview.get().then(setO, (e: Error) => setError(e.message)); }, []);
  const buildDemo = async () => {
    setDemo({ busy: true, message: "Building the demo: datasets, two training runs, evaluation, release and deployments…" });
    try {
      const res = await fetch(`${API_URL}/api/demo/jkn-models`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
      setDemo({ busy: false, message: `Released ${body.released} (recall ${body.recall.toFixed(2)} on the holdout).`, objective: body.objective_id });
      modelOverview.get().then(setO, () => {});
    } catch (e) {
      setDemo({ busy: false, message: (e as Error).message });
    }
  };
  if (error) return <ApiError message={error} />;
  if (!o) return <Loading />;
  const stats: [string, string | number, string, string][] = [
    ["Models", o.models.total, `${o.models.trained} trained · ${o.models.external} external · ${o.models.container} container`, "/model-assets"],
    ["Model versions", o.versions, `${o.experiments} experiment(s)`, "/model-assets"],
    ["Evaluation sets", o.evaluation_sets, `${o.evaluations} evaluation(s)`, "/model-experiments?view=evaluations"],
    ["Deployments", o.deployments.total, `${o.deployments.running} running · ${o.deployments.functions} function(s)`, "/modeling-objectives"],
    ["Modeling objectives", o.objectives.length, `${o.objectives.filter((x) => x.production).length} with a production release`, "/modeling-objectives"],
    ["Model studios", o.studios, "no-code training", "/model-studio"],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Model Integration" icon="layers" href="/model-integration">
        <Link href="/model-assets" className={buttonClass.ghost}><Icon name="cube" className="h-3.5 w-3.5" /> Models</Link>
        <Link href="/modeling-objectives" className={buttonClass.primary}><Icon name="layers" className="h-3.5 w-3.5" /> Modeling Objectives</Link>
      </AppHeader>
      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <div>
            <h1 className="text-xl font-semibold">Model Integration</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">Train or connect a model, evaluate it, release it through a modeling objective and serve it from live and batch deployments and model functions.</p>
          </div>
          <LifecycleGuide />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stats.map(([label, value, sub, href]) => (
              <Link key={label} href={href} className="rounded-xl border border-line bg-panel p-4 hover:bg-panel-2">
                <div className="text-xs text-muted">{label}</div><div className="mt-1 text-2xl font-semibold text-white">{value}</div><div className="mt-1 text-xs text-soft">{sub}</div>
              </Link>
            ))}
          </div>
          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-ocean/30 bg-ocean/10 p-4 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Demo: Prioritas audit faskes JKN</div>
              <p className="text-xs text-soft">Synthetic facility indicators for the 20 risk subcategories, a model trained in a Code Repository and one in Model Studio, an objective with automatic evaluation and checks, a production release, a live deployment with a function and a monthly batch scoring.</p>
              {demo.message && <p className="mt-1 whitespace-pre-wrap text-xs text-white">{demo.message} {demo.objective && <Link href={`/modeling-objectives?id=${demo.objective}`} className="text-ocean hover:underline">Open the objective</Link>}</p>}
            </div>
            <button type="button" disabled={demo.busy} onClick={buildDemo} className={buttonClass.primary}><Icon name="play" className="h-3.5 w-3.5" /> {demo.busy ? "Building…" : "Build or refresh the demo"}</button>
          </section>
          <section>
            <div className="mb-2 text-sm font-medium">Bring in a model</div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              {PATHS.map((p) => (
                <Link key={p.label} href={p.href} className="rounded-xl border border-line bg-panel p-4 hover:bg-panel-2">
                  <Icon name={p.icon} className="h-4 w-4 text-ocean" /><div className="mt-2 text-sm text-white">{p.label}</div><p className="mt-1 text-xs text-muted">{p.description}</p>
                </Link>
              ))}
            </div>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-line bg-panel">
              <div className="border-b border-line px-4 py-2.5 text-sm font-medium">Latest model versions</div>
              {o.latest_versions.length === 0 ? <p className="p-4 text-xs text-muted">No model versions yet.</p> : (
                <ul>{o.latest_versions.map((v) => (
                  <li key={`${v.model_id}${v.version}`} className="border-t border-line first:border-t-0">
                    <Link href={v.kind === "container" ? `/container-models?id=${v.model_id}` : `/model-assets/${v.model_id}`} className="flex items-center gap-3 px-4 py-2 text-xs hover:bg-panel-2">
                      <span className="flex-1 truncate text-white">{v.model}</span><span className="text-soft">{v.version}</span><span className="w-28 truncate text-muted">{v.source}</span><span className="w-28 text-right text-muted">{when(v.created_at)}</span>
                    </Link>
                  </li>
                ))}</ul>
              )}
            </section>
            <section className="rounded-xl border border-line bg-panel">
              <div className="border-b border-line px-4 py-2.5 text-sm font-medium">Modeling objectives</div>
              {o.objectives.length === 0 ? <p className="p-4 text-xs text-muted">No objectives yet.</p> : (
                <ul>{o.objectives.map((x) => (
                  <li key={x.id} className="border-t border-line first:border-t-0">
                    <Link href={`/modeling-objectives?id=${x.id}`} className="flex items-center gap-3 px-4 py-2 text-xs hover:bg-panel-2">
                      <span className="flex-1 truncate text-white">{x.name}</span><span className="text-soft">{x.submissions} model(s)</span>
                      <span className="w-40 text-right text-muted">{x.production ? `production ${x.production.version}` : x.staging ? `staging ${x.staging.version}` : "no release"}</span>
                    </Link>
                  </li>
                ))}</ul>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
