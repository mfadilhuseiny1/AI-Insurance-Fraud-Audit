"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import { modelOverview, type AdapterUse } from "@/lib/modelOverview";

const REFERENCE = `import mlflow
import pandas as pd


class MyModel(mlflow.pyfunc.PythonModel):
    """An MLflow model (open source): MLflow saves it with its package, so it loads anywhere."""

    def __init__(self, model, threshold=0.5):
        self.model, self.threshold = model, threshold

    def predict(self, context, model_input, params=None):
        df = model_input.copy()
        df["prediction"] = self.model.predict(df[["feature_a"]])
        return df


# in the training transform (ModelOutput from transforms.api):
#   with mlflow.start_run():
#       mlflow.log_metric("rmse", rmse)
#       model_output.publish(MyModel(fitted), input_example=df[["feature_a", "feature_b"]].head(5))`;

/** Model Developer: the model adapters in use across model versions (class, kinds, serializers, the models using
 *  them, their API) and how to write one. Live data from api/model_overview.py. */
export default function ModelDeveloperPage() {
  const [rows, setRows] = useState<AdapterUse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { modelOverview.adapters().then(setRows, (e: Error) => setError(e.message)); }, []);
  if (error) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Model Developer" icon="code" href="/model-developer">
        <Link href="/code-repositories" className={buttonClass.primary}><Icon name="plus" className="h-3.5 w-3.5" /> New repository (Model Training / Model Adapter Library)</Link>
      </AppHeader>
      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
          <section className="rounded-xl border border-line bg-panel">
            <div className="border-b border-line px-4 py-2.5 text-sm font-medium">Model adapters in use ({rows.length})</div>
            {rows.length === 0 ? <p className="p-4 text-xs text-muted">No model versions yet.</p> : rows.map((a) => (
              <div key={a.adapter} className="border-t border-line first:border-t-0">
                <button type="button" onClick={() => setOpen(open === a.adapter ? null : a.adapter)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-xs hover:bg-panel-2">
                  <Icon name={open === a.adapter ? "down" : "right"} className="h-3 w-3 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-white">{a.adapter}</span>
                  <span className="text-soft">{a.kinds.join(", ")}</span><span className="w-24 text-right text-muted">{when(a.last_used)}</span>
                </button>
                {open === a.adapter && (
                  <div className="space-y-2 px-10 pb-3 text-xs">
                    <div className="text-soft">Serialization: {a.serializers.join(", ") || "—"}</div>
                    <div className="text-soft">Used by: {a.models.map((m, i) => <span key={m.model_id}>{i > 0 && ", "}<Link href={m.kind === "container" ? `/container-models?id=${m.model_id}` : `/model-assets/${m.model_id}`} className="text-ocean hover:underline">{m.model}</Link> ({m.versions.join(", ")})</span>)}</div>
                    {a.repo_id && <Link href={`/code-repositories/${a.repo_id}`} className="text-ocean hover:underline">Source repository</Link>}
                    {a.api && <pre className="max-h-48 overflow-auto rounded bg-ink p-2 text-[11px] text-muted">{JSON.stringify(a.api, null, 1)}</pre>}
                  </div>
                )}
              </div>
            ))}
          </section>
          <aside className="space-y-4">
            <section className="rounded-xl border border-line bg-panel p-4 text-xs">
              <div className="mb-2 text-sm font-medium">Writing a model (MLflow)</div>
              <pre className="overflow-x-auto rounded bg-ink p-3 text-[11px] text-soft">{REFERENCE}</pre>
              <ul className="mt-3 list-disc space-y-1 pl-4 text-muted">
                <li>Publish an mlflow.pyfunc.PythonModel, a scikit-learn estimator or an MLflow model URI (runs:/…, models:/…).</li>
                <li>The input example (or an MLflow signature) declares the columns; functions and live deployments use them.</li>
                <li>The MLflow run of the training (params, stepped metrics, log_table, PNG artifacts) becomes the version&apos;s experiment.</li>
                <li>MLflow saves the model&apos;s package with it (code_paths): versions load without the repository.</li>
                <li>Older adapters (ModelAdapter classes, container and externally hosted models) keep working.</li>
              </ul>
            </section>
            <section className="rounded-xl border border-line bg-panel p-4 text-xs text-muted">
              Not available here: GPUs for training or inference, and packaging models for Marketplace products.
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
