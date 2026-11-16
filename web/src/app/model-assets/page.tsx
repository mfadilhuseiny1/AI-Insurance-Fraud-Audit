"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { ExternalModelForm } from "@/components/models/ExternalModelForm";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { modelAssets, trainedModels, type ModelAsset } from "@/lib/modelAssets";

/** Models (palantir.com/docs/foundry/integrate-models): every model resource — trained in Python transforms with
 *  palantir_models (ModelOutput.publish) or container-backed — with its versions. api/model_assets.py */
export default function ModelsPage() {
  return (
    <Suspense fallback={null}>
      <Models />
    </Suspense>
  );
}

function Models() {
  const router = useRouter();
  const item = useSearchParams().get("item");
  // opened from Files: the model behind the Files item
  useEffect(() => {
    if (item) trainedModels.byItem(item).then((m) => router.replace(m.kind === "container" ? `/container-models?id=${m.id}` : `/model-assets/${m.id}`), () => {});
  }, [item, router]);
  const [models, setModels] = useState<ModelAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "python" | "container">("all");
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    modelAssets.list().then(setModels, (e: Error) => setError(e.message));
  }, []);
  const counts = useMemo(() => ({
    all: models?.length ?? 0,
    python: models?.filter((m) => m.kind === "python").length ?? 0,
    container: models?.filter((m) => m.kind === "container").length ?? 0,
  }), [models]);
  const shown = useMemo(() => (models ?? []).filter((m) =>
    (kind === "all" || m.kind === kind) && `${m.name} ${m.path.join("/")} ${m.id}`.toLowerCase().includes(q.trim().toLowerCase()),
  ), [models, q, kind]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Models" icon="cube" href="/model-assets" />
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-6xl space-y-5">
          <section className="flex flex-col gap-4 rounded-2xl border border-line bg-gradient-to-br from-violet-500/[0.07] via-panel to-panel p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-white">Models</h1>
                {models && <span className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-xs tabular-nums text-soft">{counts.all} total</span>}
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
                Browse trained model resources and container models. Open a model to inspect its versions, API, evaluations, and deployment.
              </p>
            </div>
            <label className="flex w-full items-center gap-2 rounded-lg border border-line bg-ink px-3 py-2.5 text-muted focus-within:border-ocean sm:max-w-sm">
              <Icon name="search" className="h-4 w-4 shrink-0" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, path, or ID" aria-label="Search models" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-muted" />
              {q && <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="text-xs text-muted hover:text-white">Clear</button>}
            </label>
          </section>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter models by type">
              {(["all", "python", "container"] as const).map((k) => {
                const label = k === "all" ? "All models" : k === "python" ? "Trained models" : "Container models";
                return <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${kind === k ? "border-ocean/50 bg-ocean/15 text-white" : "border-line bg-panel text-muted hover:bg-panel-2 hover:text-white"}`}>
                  {label}<span className="ml-2 tabular-nums text-muted">{counts[k]}</span>
                </button>;
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/modeling-objectives" className={buttonClass.ghost}><Icon name="layers" className="h-3.5 w-3.5" /> Objectives</Link>
              <Link href="/model-studio" className={buttonClass.ghost}><Icon name="cpu" className="h-3.5 w-3.5" /> Model Studio</Link>
              <Link href="/container-models" className={buttonClass.ghost}><Icon name="server" className="h-3.5 w-3.5" /> Import container</Link>
              <button type="button" onClick={() => setConnecting(true)} className={buttonClass.primary}><Icon name="plug" className="h-3.5 w-3.5" /> Connect model</button>
            </div>
          </div>

          {error && <div role="alert" className="rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm text-bad">Could not load models: {error}</div>}
          {!models && !error && <div className="flex min-h-40 items-center justify-center rounded-xl border border-line bg-panel text-sm text-muted"><span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-ocean" />Loading model resources…</div>}
          {models && shown.length === 0 && (
            <div className="rounded-xl border border-dashed border-line-2 bg-panel/50 px-6 py-12 text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-panel-2 text-muted"><Icon name="cube" className="h-5 w-5" /></span>
              <h2 className="mt-3 text-sm font-semibold text-white">{q || kind !== "all" ? "No matching models" : "No models yet"}</h2>
              <p className="mx-auto mt-1 max-w-lg text-sm text-muted">{q || kind !== "all"
                ? "Try another search or model type."
                : <>Publish a model from Model Studio or a Code Repository, import a container, or connect an externally hosted model.</>}</p>
              {(q || kind !== "all") && <button type="button" onClick={() => { setQ(""); setKind("all"); }} className="mt-3 text-xs text-ocean hover:underline">Clear filters</button>}
            </div>
          )}
          {shown.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((m) => (
                <Link key={m.id} href={m.kind === "container" ? `/container-models?id=${m.id}` : `/model-assets/${m.id}`}
                  className="group flex min-h-40 min-w-0 flex-col rounded-xl border border-line bg-panel p-4 transition-colors hover:border-ocean/50 hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${m.kind === "container" ? "bg-amber-500/10 text-amber-300" : "bg-violet-500/15 text-violet-300"}`}>
                      <Icon name={m.kind === "container" ? "server" : "cube"} className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-semibold text-white group-hover:text-ocean" title={m.name}>{m.name}</h2>
                      <p className="mt-1 truncate text-xs text-muted" title={m.path.join(" / ")}>{m.path.join(" / ") || "Root project"}</p>
                    </div>
                    <Icon name="right" className="mt-1 h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ocean" />
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                    <span className={`rounded-full px-2 py-1 text-[11px] ${m.kind === "container" ? "bg-amber-500/10 text-amber-200" : "bg-violet-500/10 text-violet-200"}`}>{m.kind === "container" ? "Container" : "Trained model"}</span>
                    <span className="text-xs text-soft">{m.versions ? `${m.versions} version${m.versions === 1 ? "" : "s"} · ${m.latest ?? "latest"}` : "No versions"}</span>
                    <span className="ml-auto text-xs text-muted">Updated {when(m.updated_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
      {connecting && <ExternalModelForm onClose={() => setConnecting(false)} onSaved={(m) => router.push(`/model-assets/${m.id}`)} />}
    </div>
  );
}
