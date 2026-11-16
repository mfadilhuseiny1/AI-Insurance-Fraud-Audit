"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { when } from "@/lib/format";
import { modelOverview, type LifecycleRow } from "@/lib/modelOverview";

/* The guide of Model Integration: the four steps of bringing a model in, and every model's progress through them
   with its next step. Live from GET /api/model-overview/lifecycle. */

const STEPS: { n: number; title: string; icon: IconName; body: string; links: [string, string][]; optional?: boolean }[] = [
  {
    n: 1, title: "Explore", icon: "doc", optional: true,
    body: "Try features and algorithms in a Jupyter notebook on the datasets you alias. A notebook can already publish a model version.",
    links: [["Code Workspaces", "/code-workspaces"]],
  },
  {
    n: 2, title: "Train", icon: "code",
    body: "Production training: a Model Training repository (MLflow; log_regresi / log_klasifikasi add the charts), or Model Studio without code — pick algorithms and their settings.",
    links: [["Code Repositories", "/code-repositories"], ["Model Studio", "/model-studio"]],
  },
  {
    n: 3, title: "Benchmark", icon: "split",
    body: "Submit two or more models to a Modeling Objective with an evaluation dataset: every one is scored the same way; Comparisons shows metrics by subset, confusion matrices and ROC curves.",
    links: [["Modeling Objectives", "/modeling-objectives"]],
  },
  {
    n: 4, title: "Deploy", icon: "play",
    body: "Release the winner, then serve it: a live endpoint, a function for Pipeline Builder, Workshop and Nexus actions, or batch scoring.",
    links: [["Modeling Objectives", "/modeling-objectives"]],
  },
];

type Next = { label: string; href: string; done?: boolean };

function nextStep(r: LifecycleRow): Next {
  if (!r.trained.versions) return { label: "Train a first version", href: r.trained.link ?? "/code-repositories" };
  if (!r.evaluated.charts && r.kind === "python" && !r.benchmarks.length) return { label: "Log an evaluation", href: r.trained.link ?? `/model-assets/${r.id}` };
  if (!r.benchmarks.length) return { label: "Submit to an objective", href: `/model-assets/${r.id}` };
  const b = r.benchmarks.find((x) => !x.evaluated);
  if (b) return { label: "Build its evaluation", href: `/modeling-objectives?id=${b.id}&view=comparisons` };
  if (!r.deployed.live && !r.deployed.batch) {
    const o = r.benchmarks[0];
    return { label: o.released ? "Deploy the release" : "Release and deploy", href: `/modeling-objectives?id=${o.id}&view=${o.released ? "deployments" : "releases"}` };
  }
  return { label: r.deployed.functions.length ? `Serving · ${r.deployed.functions[0]}` : "Deployed", href: `/model-assets/${r.id}`, done: true };
}

function Dot({ on, label, title }: { on: boolean; label: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${on ? "bg-emerald-500/15 text-emerald-300" : "bg-panel-2 text-muted"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-line-2"}`} />
      {label}
    </span>
  );
}

export function LifecycleGuide() {
  const [rows, setRows] = useState<LifecycleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState(false);
  useEffect(() => {
    modelOverview.lifecycle().then(setRows, (e: Error) => setError(e.message));
  }, []);
  const shown = (rows ?? []).filter((r) => tests || !r.test);
  return (
    <div className="space-y-4">
      <section>
        <div className="mb-2 flex items-baseline gap-3">
          <h2 className="text-sm font-semibold">How to bring a model in</h2>
          <span className="text-xs text-muted">Data Lineage links every step by itself: datasets → code / notebook / studio → model → function → pipelines and apps</span>
        </div>
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="relative rounded-xl border border-line bg-gradient-to-b from-panel-2/50 to-panel p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ocean/20 text-xs font-semibold text-ocean">{s.n}</span>
                <Icon name={s.icon} className="h-4 w-4 text-soft" />
                <span className="text-sm font-medium text-white">{s.title}</span>
                {s.optional && <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">optional</span>}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-soft">{s.body}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {s.links.map(([label, href]) => (
                  <Link key={label} href={href} className="rounded-md border border-line px-2 py-1 text-[11px] text-ocean hover:border-ocean">{label} →</Link>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <span className="text-sm font-medium">Models in progress</span>
          <span className="text-xs text-muted">{shown.length} model(s) · what each one still needs</span>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> Show tests ({(rows ?? []).filter((r) => r.test).length})
          </label>
        </div>
        {error ? <p className="p-4 text-xs text-bad">{error}</p> : !rows ? <div className="m-4 h-24 animate-pulse rounded-lg bg-panel-2/40" /> : shown.length === 0 ? (
          <p className="p-4 text-xs text-muted">No models yet: start with step 2.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>{["Model", "1–2 · Trained", "Evaluated", "3 · Benchmarked", "4 · Deployed", "Next step", ""].map((h) => <th key={h} className="px-4 py-2 text-left font-normal">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const next = nextStep(r);
                return (
                  <tr key={r.id} className="border-t border-line hover:bg-panel-2/50">
                    <td className="max-w-[16rem] px-4 py-2.5">
                      <Link href={r.kind === "container" ? `/container-models?id=${r.id}` : `/model-assets/${r.id}`} className="block truncate text-white hover:text-ocean">{r.name}</Link>
                      <div className="truncate text-[10px] text-muted">{r.path.join(" / ")}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Dot on={r.trained.versions > 0} label={r.trained.versions ? `v${r.trained.latest}` : "no version"} title={r.trained.at ? when(r.trained.at) : undefined} />
                      {r.trained.app && <div className="mt-1 text-[10px] text-muted">{r.trained.link ? <Link href={r.trained.link} className="hover:text-ocean">{r.trained.app}</Link> : r.trained.app}</div>}
                    </td>
                    <td className="px-4 py-2.5"><Dot on={r.evaluated.charts || r.evaluated.evaluation_sets > 0} label={r.evaluated.charts ? "charts" : r.evaluated.evaluation_sets ? `${r.evaluated.evaluation_sets} set(s)` : "none"} /></td>
                    <td className="px-4 py-2.5">
                      {r.benchmarks.length ? r.benchmarks.slice(0, 2).map((b) => (
                        <Link key={b.id} href={`/modeling-objectives?id=${b.id}&view=comparisons`} className="mb-0.5 block max-w-[14rem] truncate">
                          <Dot on={b.evaluated} label={b.name} title={b.evaluated ? "evaluated with the other submissions" : "submitted, not evaluated yet"} />
                        </Link>
                      )) : <Dot on={false} label="not submitted" />}
                    </td>
                    <td className="px-4 py-2.5">
                      <Dot on={r.deployed.live + r.deployed.batch > 0} label={r.deployed.live + r.deployed.batch ? `${r.deployed.running} running${r.deployed.batch ? ` · ${r.deployed.batch} batch` : ""}` : "not deployed"} />
                      {r.deployed.functions.length > 0 && <div className="mt-1 truncate font-mono text-[10px] text-muted">{r.deployed.functions.join(", ")}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link href={next.href} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 ${next.done ? "text-emerald-300" : "bg-ocean/15 text-ocean hover:bg-ocean/25"}`}>
                        {next.done ? <Icon name="check" className="h-3 w-3" /> : null}{next.label}{next.done ? "" : " →"}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/lineage?node=${encodeURIComponent(`model:${r.id}`)}`} title="Open in Data Lineage" className="text-muted hover:text-ocean"><Icon name="split" className="h-3.5 w-3.5" /></Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
