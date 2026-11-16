"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { DatasetView, DebugJobDialog, EnvironmentTable, FileView } from "@/components/transforms/CommonParts";
import { codeRepos, type BuildRecord, type Repo, type RepoSummary } from "@/lib/codeRepos";
import { when } from "@/lib/format";
import {
  fileArgs,
  previewCommand,
  transformsCommon,
  type DebugJob,
  type EnvironmentUse,
  type ListedTransform,
  type OutputsAdvice,
  type PreviewRun,
  type Runtime,
} from "@/lib/transformsCommon";

/** Transforms common (palantir.com/docs/foundry/transforms-common): local preview tasks, transforms versions with
 *  build environments and debug jobs, and multi-output transform design — over real Code Repositories. */
export default function TransformsCommonPage() {
  return (
    <Suspense fallback={null}>
      <TransformsCommon />
    </Suspense>
  );
}

type Tab = "preview" | "versions" | "outputs";
const seconds = (s: number) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const TABS: [Tab, string, IconName][] = [
  ["preview", "Local preview", "play"],
  ["versions", "Runtime versions", "refresh"],
  ["outputs", "Multi-output design", "layers"],
];

function TransformsCommon() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : params.get("debug") ? "versions" : "preview") as Tab;
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [runtimes, setRuntimes] = useState<{ runtimes: Runtime[]; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const repoId = params.get("repo") ?? repos?.[0]?.id ?? null;
  const branch = params.get("branch") ?? repo?.default_branch ?? undefined;

  const go = useCallback(
    (next: Record<string, string | null>) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      router.replace(`/transforms-common?${q.toString()}`);
    },
    [params, router],
  );

  useEffect(() => {
    codeRepos.list().then(setRepos, (e: Error) => (setRepos([]), setError(e.message)));
    transformsCommon.runtimes().then(setRuntimes, () => {});
  }, []);
  useEffect(() => {
    if (!repoId) return;
    let alive = true;
    codeRepos.get(repoId).then((r) => alive && setRepo(r), (e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [repoId]);

  const python = runtimes?.runtimes.find((r) => r.language === "Python");
  const shownRepo = repo && repo.id === repoId ? repo : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name="sliders" className="h-4 w-4" />
          </span>
          Transforms common
        </div>
        <span className="text-xs text-muted">Local preview, versions, and output design</span>
        <div className="ml-auto flex items-center gap-2">
          {repoId && (
            <Link href={`/code-repositories/${repoId}`} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
              <Icon name="code" className="h-3.5 w-3.5" /> Open repository
            </Link>
          )}
          <button type="button" onClick={() => go({ tab: "versions" })} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
            <Icon name="bug" className="h-3.5 w-3.5" /> Debug job
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel p-3">
          <div className="mb-3 text-xs font-semibold text-soft">Transforms toolkit</div>
          <label className="mb-2 block text-[10px] uppercase tracking-wider text-muted">
            Repository
            <select value={repoId ?? ""} onChange={(e) => go({ repo: e.target.value, branch: null, debug: null })} className={`${inputClass} mt-1 text-xs normal-case tracking-normal`}>
              {!repos?.length && <option value="">{repos ? "No repositories" : "Loading…"}</option>}
              {repos?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {shownRepo && (
            <label className="mb-4 block text-[10px] uppercase tracking-wider text-muted">
              Branch
              <select value={branch} onChange={(e) => go({ branch: e.target.value })} className={`${inputClass} mt-1 text-xs normal-case tracking-normal`}>
                {shownRepo.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {TABS.map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => go({ tab: id })}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2"}`}
            >
              <Icon name={icon} className="h-4 w-4" />
              {label}
            </button>
          ))}
          <div className="mt-auto rounded-lg border border-line bg-panel-2 p-3 text-[10px] text-muted">
            <div className="text-soft">Python transforms version</div>
            <div className="mt-1 font-mono text-ocean">{python?.transforms_version ?? "…"}</div>
            <div className="mt-2">
              {python ? [python.spark && `Spark ${python.spark}`, python.java && `Java ${python.java}`, python.scala && `Scala ${python.scala}`, python.python && `Python ${python.python}`].filter(Boolean).join(" · ") : ""}
            </div>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          {error && <p className="mx-auto mb-4 max-w-5xl rounded-md bg-bad/10 p-2 text-xs text-bad">{error}</p>}
          {repos && !repos.length ? (
            <div className="mx-auto max-w-5xl rounded-xl border-2 border-dashed border-line-2 p-10 text-center text-sm text-muted">
              Create a repository in <Link href="/code-repositories" className="text-ocean hover:underline">Code Repositories</Link> to preview its transforms.
            </div>
          ) : !repoId || !shownRepo ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : tab === "preview" ? (
            <Preview key={`${repoId}:${branch}`} repoId={repoId} branch={branch} />
          ) : tab === "versions" ? (
            <Versions key={repoId} repoId={repoId} runtimes={runtimes} debug={params.get("debug")} onDebug={(id) => go({ debug: id })} />
          ) : (
            <Outputs key={`${repoId}:${branch}`} repoId={repoId} branch={branch} />
          )}
        </main>
      </div>
    </div>
  );
}

function Heading({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-xs uppercase tracking-wider text-ocean">{eyebrow}</div>
      <h1 className="mt-1 text-xl font-semibold">{title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">{children}</p>
    </div>
  );
}

function Preview({ repoId, branch }: { repoId: string; branch?: string }) {
  const [list, setList] = useState<{ transforms: ListedTransform[]; logs: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [printMode, setPrintMode] = useState<"uri" | "table">("uri");
  const [inputFiles, setInputFiles] = useState("");
  const [outputFiles, setOutputFiles] = useState("");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<PreviewRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const load = useCallback(() => {
    transformsCommon.transforms(repoId, branch).then(
      (l) => {
        setListError(null);
        setList(l);
        setPicked((p) => (l.transforms.some((t) => t.id === p) ? p : l.transforms[0]?.id ?? ""));
      },
      (e: Error) => (setList({ transforms: [], logs: "" }), setListError(e.message)),
    );
  }, [repoId, branch]);
  useEffect(() => {
    load();
  }, [load]);
  const t = list?.transforms.find((x) => x.id === picked);
  const start = async () => {
    setRunning(true);
    setRun(null);
    setRunError(null);
    try {
      setRun(await transformsCommon.preview(repoId, { branch, transform_id: picked, print_mode: printMode, input_files: fileArgs(inputFiles), output_files: fileArgs(outputFiles) }));
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const addAlias = (set: (f: (s: string) => string) => void, alias: string) => set((s) => (s.trim() ? `${s.replace(/,?\s*$/, "")},${alias}:` : `${alias}:`));
  return (
    <div className="mx-auto max-w-5xl">
      <Heading eyebrow="Task Runner and Gradle preview" title="Preview transforms locally">
        Foundry&apos;s Gradle-based preview runs the preview on the platform and returns a link to it. Here the same tasks run on this server, from the Task Runner in Code Repositories or with an API token
        (<span className="font-mono">POST /api/transforms-common/repos/&lt;id&gt;/dataset-preview</span>). A preview never writes its outputs.
      </Heading>
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="flex items-center text-xs font-semibold">
            Available transforms
            <button type="button" onClick={load} className="ml-auto text-muted hover:text-white" title="Run displayTransformsList again" aria-label="Refresh the transforms">
              <Icon name="refresh" className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
            {!list && <p className="text-xs text-muted">Running displayTransformsList…</p>}
            {listError && <p className="text-xs text-bad">{listError}</p>}
            {list && !list.transforms.length && !listError && <p className="text-xs text-muted">This branch declares no transforms.</p>}
            {list?.transforms.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setPicked(x.id)}
                title={x.file}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs ${x.id === picked ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
              >
                <Icon name="code" className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 truncate font-mono">{x.id}</span>
              </button>
            ))}
          </div>
          {list?.logs && (
            <button type="button" onClick={() => setShowList(!showList)} className="mt-2 text-[11px] text-ocean hover:underline">
              {showList ? "Hide" : "Show"} the task output
            </button>
          )}
          <div className="mt-4 space-y-3 border-t border-line pt-4 text-xs">
            <label className="block text-muted">
              Print mode
              <select value={printMode} onChange={(e) => setPrintMode(e.target.value as "uri" | "table")} className={`${inputClass} mt-1`}>
                <option value="uri">Link to the preview</option>
                <option value="table">Table (first 10 rows)</option>
              </select>
            </label>
            <label className="block text-muted">
              Input files <span className="text-[10px]">(alias:path, comma-separated)</span>
              <input value={inputFiles} onChange={(e) => setInputFiles(e.target.value)} placeholder="raw:notes.csv" className={`${inputClass} mt-1 font-mono`} />
            </label>
            {t && Object.keys(t.inputs).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.keys(t.inputs).map((a) => (
                  <button key={a} type="button" onClick={() => addAlias(setInputFiles, a)} className="rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] text-soft hover:text-white" title={t.inputs[a]}>
                    {a}
                  </button>
                ))}
              </div>
            )}
            <label className="block text-muted">
              Output files
              <input value={outputFiles} onChange={(e) => setOutputFiles(e.target.value)} placeholder="report:summary.txt" className={`${inputClass} mt-1 font-mono`} />
            </label>
            {t && Object.keys(t.outputs).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.keys(t.outputs).map((a) => (
                  <button key={a} type="button" onClick={() => addAlias(setOutputFiles, a)} className="rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] text-soft hover:text-white" title={t.outputs[a]}>
                    {a}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={running || !picked}
            onClick={start}
            className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-md bg-ocean px-3 py-2 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-50"
          >
            <Icon name={running ? "refresh" : "play"} className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running ? "Running preview…" : "Run dataset preview"}
          </button>
        </div>
        <div className="min-w-0 space-y-4">
          <div className="rounded-xl border border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line p-4 text-xs font-medium">
              <Icon name="code" className="h-4 w-4 text-ocean" />
              Gradle command
              <span className="ml-auto font-normal text-muted">also in the Task Runner, without ./gradlew</span>
            </div>
            <pre className="overflow-auto p-4 font-mono text-xs leading-6 text-soft">
              ./gradlew displayTransformsList{"\n"}
              {previewCommand(picked, { printMode, inputFiles, outputFiles })}
            </pre>
          </div>
          {showList && list?.logs && <pre className="overflow-auto rounded-xl border border-line bg-panel p-4 font-mono text-[11px] leading-5 text-soft">{list.logs}</pre>}
          {runError && <p className="whitespace-pre-wrap rounded-xl border border-bad/30 bg-bad/10 p-4 text-xs text-bad">{runError}</p>}
          {run && !run.ok && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-bad/30 bg-bad/10 p-4 font-mono text-xs text-bad">{run.error}</pre>}
          {run?.ok && run.uri && (
            <div className="rounded-xl border border-ok/30 bg-ok/10 p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-ok">
                <Icon name="check" className="h-4 w-4" />
                Preview complete
              </div>
              <p className="mt-2 text-xs text-soft">
                {run.logs.split("\n")[1]}{" "}
                <Link href={run.uri} target="_blank" className="text-ocean hover:underline">
                  Open the preview
                </Link>{" "}
                <span className="text-muted">(only you can open it, for 24 hours)</span>
              </p>
            </div>
          )}
          {run?.ok && !run.uri && (
            <>
              <pre className="max-h-[480px] overflow-auto rounded-xl border border-line bg-panel p-4 font-mono text-[11px] leading-5 text-soft">{run.logs}</pre>
              {run.input_files?.map((f) => <FileView key={`i:${f.alias}:${f.path}`} f={f} direction="input" />)}
            </>
          )}
          {run?.ok && run.datasets && run.uri && run.datasets.map((d) => <DatasetView key={d.alias} d={{ ...d, preview: d.preview.slice(0, 10) }} />)}
          {!run && !runError && (
            <div className="rounded-xl border-2 border-dashed border-line-2 p-10 text-center text-sm text-muted">Run a preview to inspect output rows and files.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Versions({ repoId, runtimes, debug, onDebug }: { repoId: string; runtimes: { runtimes: Runtime[]; note: string } | null; debug: string | null; onDebug: (id: string | null) => void }) {
  const [envs, setEnvs] = useState<EnvironmentUse[] | null>(null);
  const [builds, setBuilds] = useState<BuildRecord[] | null>(null);
  const [jobs, setJobs] = useState<DebugJob[]>([]);
  const [openEnv, setOpenEnv] = useState<number | null>(null);
  const reload = useCallback(() => {
    transformsCommon.environments(repoId).then(setEnvs, () => setEnvs([]));
    codeRepos.builds(repoId).then(setBuilds, () => setBuilds([]));
    transformsCommon.debugJobs(repoId).then(setJobs, () => setJobs([]));
  }, [repoId]);
  useEffect(() => {
    reload();
  }, [reload]);
  const failed = (builds ?? []).filter((b) => b.status === "failed").slice(0, 15);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Heading eyebrow="Runtime environment" title="Transforms versions">
        The Spark, Java and Scala versions a build uses depend on its transforms version. Every build records them (Spark Details → Environment). When an upgrade seems to break a pipeline, rerun the failed
        build as a debug job on an earlier version.
      </Heading>
      <section className="overflow-hidden rounded-xl border border-line bg-panel">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Language</th>
              <th className="px-4 py-3">Transforms version</th>
              <th className="px-4 py-3">Spark</th>
              <th className="px-4 py-3">Java</th>
              <th className="px-4 py-3">Scala</th>
              <th className="px-4 py-3">Engines</th>
            </tr>
          </thead>
          <tbody>
            {!runtimes && (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {runtimes?.runtimes.map((r) => (
              <tr key={r.language} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-medium text-soft">
                  {r.language}
                  {r.available === false && <span className="ml-2 text-[10px] text-warn">not installed</span>}
                </td>
                <td className="px-4 py-3 font-mono text-soft">{r.transforms_version}</td>
                <td className="px-4 py-3 text-muted">{r.spark ?? "—"}</td>
                <td className="px-4 py-3 text-muted">{r.java ?? "—"}</td>
                <td className="px-4 py-3 text-muted">{r.scala ?? "—"}</td>
                <td className="px-4 py-3 text-muted">{r.engines.join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {runtimes && <p className="border-t border-line px-4 py-3 text-[11px] text-muted">{runtimes.note}</p>}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Environments of this repository&apos;s builds</h2>
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {envs === null && <p className="p-4 text-xs text-muted">Loading…</p>}
          {envs?.length === 0 && <p className="p-4 text-xs text-muted">No build has recorded its environment yet: builds record it from now on.</p>}
          {envs?.map((e, i) => (
            <div key={i} className="border-b border-line last:border-0">
              <button type="button" onClick={() => setOpenEnv(openEnv === i ? null : i)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs hover:bg-panel-2">
                <Icon name={openEnv === i ? "down" : "right"} className="h-3.5 w-3.5 text-muted" />
                <span className="font-mono text-ocean">{e.sparkModuleVersion}</span>
                <span className="text-soft">{e.engine}</span>
                <span className="text-muted">{[e.sparkVersion && `Spark ${e.sparkVersion}`, e.pythonVersion && `Python ${e.pythonVersion}`, e.javaVersion && `Java ${e.javaVersion}`].filter(Boolean).join(" · ")}</span>
                <span className="ml-auto text-muted">
                  {e.builds} build{e.builds === 1 ? "" : "s"} · <span className="text-ok">{e.succeeded} ok</span>
                  {e.failed > 0 && <span className="text-bad"> · {e.failed} failed</span>} · last {when(e.last_at)}
                </span>
              </button>
              {openEnv === i && (
                <div className="px-11 pb-3">
                  <EnvironmentTable env={e} />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Debug jobs</h2>
        <div className="overflow-hidden rounded-xl border border-line bg-panel text-xs">
          {builds === null && <p className="p-4 text-muted">Loading…</p>}
          {builds && !failed.length && <p className="p-4 text-muted">No failed builds in this repository.</p>}
          {failed.map((b) => (
            <div key={b.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
              <Icon name="alert" className="h-4 w-4 shrink-0 text-bad" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-soft">{b.transform.split("::").pop()}</span>
                <span className="block truncate text-[11px] text-bad" title={b.error ?? ""}>
                  {b.error}
                </span>
              </span>
              <span className="shrink-0 text-muted">
                {when(b.at)} · {b.environment?.sparkModuleVersion ?? "no environment recorded"}
              </span>
              <button type="button" onClick={() => onDebug(b.id)} className={buttonClass.secondary}>
                <Icon name="bug" className="h-3.5 w-3.5" /> Rerun as debug job
              </button>
            </div>
          ))}
        </div>
        {jobs.length > 0 && (
          <ul className="mt-3 space-y-2">
            {jobs.slice(0, 10).map((j) => (
              <li key={j.id} className="rounded-lg border border-line bg-panel p-3 text-xs">
                <div className="flex items-center gap-2">
                  <Icon name={j.ok ? "check" : "alert"} className={`h-3.5 w-3.5 ${j.ok ? "text-ok" : "text-warn"}`} />
                  <span className="font-mono text-soft">{j.transform.split("::").pop()}</span>
                  <span className="text-muted">
                    {when(j.at)} · {seconds(j.ms / 1000)} · ran on {j.ran_on === "current" ? "the current environment" : j.ran_on}
                  </span>
                  {j.spark_ui && (
                    <Link href={`/spark-ui?repo=${repoId}&job=${j.id}`} className="ml-auto flex items-center gap-1 text-ocean hover:underline">
                      <Icon name="bolt" className="h-3.5 w-3.5" /> Spark UI
                    </Link>
                  )}
                </div>
                <p className="mt-1 text-soft">{j.verdict}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Foundry does not run debug jobs for external transforms that use sources with secrets or credentials; Code Repositories here have no external transforms.
        </p>
      </section>
      {debug && (
        <DebugJobDialog
          repoId={repoId}
          buildId={debug}
          onClose={() => onDebug(null)}
          onDone={() => transformsCommon.debugJobs(repoId).then(setJobs, () => {})}
        />
      )}
    </div>
  );
}

function Outputs({ repoId, branch }: { repoId: string; branch?: string }) {
  const [data, setData] = useState<OutputsAdvice | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    transformsCommon.outputs(repoId, branch).then(setData, (e: Error) => setError(e.message));
  }, [repoId, branch]);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Heading eyebrow="Output architecture" title="Optimize multi-output transforms">
        Compare independent single-output transforms with one multi-output transform, then check this repository: transforms that read the same inputs, and multi-output transforms whose failures or build
        times suggest splitting them.
      </Heading>
      <div className="grid gap-4 md:grid-cols-2">
        <Strategy
          title="Multiple single-output transforms"
          icon="split"
          pros={["Build each output independently, at its own frequency", "Customize Spark profiles per output", "Failures contained to one output", "Minimal inputs per transform (and markings)"]}
          cons={["Duplicate logic and repeated Spark operations", "Each transform pays its own driver and start-up overhead"]}
        />
        <Strategy
          title="Multi-output transform"
          icon="layers"
          pros={["One driver and job: no repeated overhead", "Logic for all outputs in one place", "Intermediate data stays in memory"]}
          cons={["Outputs cannot build independently", "One set of Spark profiles for every output", "A failure fails every output", "Cost is split equally between outputs"]}
        />
      </div>
      <section>
        <h2 className="mb-2 text-sm font-semibold">This repository{data ? ` · ${data.repo.name} (${data.repo.branch})` : ""}</h2>
        {error && <p className="rounded-md bg-bad/10 p-2 text-xs text-bad">{error}</p>}
        {!data && !error && <p className="text-xs text-muted">Loading…</p>}
        {data && (
          <>
            <div className="space-y-2">
              {data.advice.length === 0 && <p className="rounded-lg border border-line bg-panel p-3 text-xs text-muted">Nothing to suggest: no single-output transforms share inputs, and no multi-output transform shows failures or uneven build times.</p>}
              {data.advice.map((a, i) => (
                <div key={i} className={`rounded-lg border p-3 text-xs ${a.kind === "combine" ? "border-ocean/30 bg-ocean/10" : "border-warn/30 bg-warn/10"}`}>
                  <div className={`mb-1 flex items-center gap-2 font-medium ${a.kind === "combine" ? "text-ocean" : "text-warn"}`}>
                    <Icon name={a.kind === "combine" ? "layers" : "split"} className="h-4 w-4" />
                    {a.kind === "combine" ? "Consider a multi-output transform" : "Consider splitting"}
                  </div>
                  <p className="text-soft">{a.message}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted">{a.transforms.join(" · ")}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-line bg-panel">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5">Transform</th>
                    <th className="px-4 py-2.5">Inputs</th>
                    <th className="px-4 py-2.5">Outputs</th>
                    <th className="px-4 py-2.5">Builds</th>
                    <th className="px-4 py-2.5">Median</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transforms.map((t) => (
                    <tr key={t.key} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-soft">{t.id}</span>
                        {t.multi_output && <span className="ml-2 rounded bg-ocean/15 px-1.5 py-0.5 text-[10px] text-ocean">multi-output</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{t.inputs.join(", ") || "—"}</td>
                      <td className="px-4 py-2.5 text-muted">{t.outputs.join(", ") || "—"}</td>
                      <td className="px-4 py-2.5 text-muted">
                        {t.builds}
                        {t.failed > 0 && <span className="text-bad"> · {t.failed} failed</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{t.median_ms === null ? "—" : seconds(t.median_ms / 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <div className="rounded-xl border border-line bg-panel p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon name="info" className="h-4 w-4 text-ocean" /> Which approach should you use?
        </div>
        <p className="mt-2 text-xs leading-5 text-soft">
          Opt for a multi-output transform when its limitations fit your needs, the outputs share similar logic, and the operations are parallelizable. Otherwise decide case by case: multiple
          single-output transforms are the fallback.
        </p>
      </div>
    </div>
  );
}

function Strategy({ title, icon, pros, cons }: { title: string; icon: IconName; pros: string[]; cons: string[] }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon name={icon} className="h-5 w-5 text-ocean" />
        {title}
      </div>
      <div className="mt-5 text-[10px] font-semibold uppercase tracking-wide text-ok">Benefits</div>
      {pros.map((item) => (
        <div key={item} className="mt-2 flex items-center gap-2 text-xs text-soft">
          <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-ok" />
          {item}
        </div>
      ))}
      <div className="mt-5 text-[10px] font-semibold uppercase tracking-wide text-warn">Tradeoffs</div>
      {cons.map((item) => (
        <div key={item} className="mt-2 flex items-center gap-2 text-xs text-soft">
          <Icon name="alert" className="h-3.5 w-3.5 shrink-0 text-warn" />
          {item}
        </div>
      ))}
    </div>
  );
}
