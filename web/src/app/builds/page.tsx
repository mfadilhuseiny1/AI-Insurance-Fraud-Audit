"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { BuildMetricsView, ExpectationsList } from "@/components/code/PythonPanels";
import { StatusBadge } from "@/components/pipeline/Builds";
import { inputClass } from "@/components/pipeline/Modal";
import { EnvironmentTable } from "@/components/transforms/CommonParts";
import { codeRepos, type BuildRecord } from "@/lib/codeRepos";
import { computeSeconds, streamingUsage } from "@/lib/compute";
import { when } from "@/lib/format";
import { runtime, type BuildSummary } from "@/lib/runtime";

const STATUSES = ["", "running", "queued", "succeeded", "failed", "cancelled"] as const;
const TRIGGERS: [string, string][] = [
  ["", "Any trigger"],
  ["manual", "Manual deploys"],
  ["schedule", "Schedules"],
  ["retry", "Retries"],
  ["restart", "Auto-restarts"],
  ["rerun", "Reruns"],
];
const RANGES: [string, string, number][] = [
  ["", "Any time", 0],
  ["1h", "Last hour", 1],
  ["24h", "Last 24 hours", 24],
  ["7d", "Last 7 days", 24 * 7],
  ["30d", "Last 30 days", 24 * 30],
];

const seconds = (s: number | null) => (s === null ? "—" : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** Builds: every build of every pipeline, filtered, to monitor and debug them in one place. */
export default function BuildsPage() {
  // tests: "true" shows the builds of test and bug-hunting pipelines (hidden by default, counted)
  const [filters, setFilters] = useState({ status: "", pipeline_id: "", branch: "", trigger: "", kind: "", range: "24h", q: "", tests: "" });
  // the time the list was fetched: running builds' durations count to it
  const [data, setData] = useState<{ builds: BuildSummary[]; pipelines: { id: string; name: string }[]; hidden_tests?: number; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof filters>) => setFilters({ ...filters, ...patch });
  const load = useCallback(() => {
    const hours = RANGES.find((r) => r[0] === filters.range)?.[2] ?? 0;
    const { range: _r, ...rest } = filters;
    void _r;
    return runtime
      .searchBuilds({ ...rest, since: hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined, limit: "300" })
      .then(
        (d) => {
          setData({ ...d, at: Date.now() });
          setError(null);
        },
        (e: Error) => setError(e.message),
      );
  }, [filters]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);
  const builds = data?.builds ?? [];
  const counts = { running: builds.filter((b) => b.status === "running" || b.status === "queued").length, failed: builds.filter((b) => b.status === "failed").length };
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl p-8">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold">
          <Icon name="refresh" className="h-5 w-5 text-ocean" /> Builds
        </h1>
        <p className="mb-5 text-sm text-muted">
          Every build and streaming job of every pipeline. Open one to follow it, download its logs, compare it with the last successful build, rerun it or have AI explain a failure.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <div className="relative w-64">
            <Icon name="search" className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted" />
            <input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Pipeline, build id or error…" className={`${inputClass} pl-8 text-xs`} />
          </div>
          <select value={filters.status} onChange={(e) => set({ status: e.target.value })} className={`${inputClass} w-36 py-1.5 text-xs`}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? s[0].toUpperCase() + s.slice(1) : "Any status"}
              </option>
            ))}
          </select>
          <select value={filters.pipeline_id} onChange={(e) => set({ pipeline_id: e.target.value })} className={`${inputClass} w-48 py-1.5 text-xs`}>
            <option value="">Any pipeline</option>
            {data?.pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={filters.trigger} onChange={(e) => set({ trigger: e.target.value })} className={`${inputClass} w-36 py-1.5 text-xs`}>
            {TRIGGERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select value={filters.kind} onChange={(e) => set({ kind: e.target.value })} className={`${inputClass} w-36 py-1.5 text-xs`}>
            <option value="">Batch and streaming</option>
            <option value="batch">Batch builds</option>
            <option value="streaming">Streaming jobs</option>
          </select>
          <input value={filters.branch} onChange={(e) => set({ branch: e.target.value })} placeholder="Branch" className={`${inputClass} w-28 py-1.5 text-xs`} />
          <select value={filters.range} onChange={(e) => set({ range: e.target.value })} className={`${inputClass} w-36 py-1.5 text-xs`}>
            {RANGES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted" title="Build pipeline uji & bug (nama atau proyek berisi “test”) — terpisah dari demo">
            <input type="checkbox" checked={filters.tests === "true"} onChange={(e) => set({ tests: e.target.checked ? "true" : "" })} />
            Tampilkan uji{filters.tests !== "true" && data?.hidden_tests ? ` (${data.hidden_tests} disembunyikan)` : ""}
          </label>
          <span className="ml-auto text-muted">
            {builds.length} builds · <span className="text-ocean">{counts.running} running</span> · <span className="text-bad">{counts.failed} failed</span>
          </span>
        </div>
        {error && <p className="mb-3 text-sm text-bad">{error}</p>}
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Pipeline</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Outputs</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data === null && !error && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted">
                    Loading…
                  </td>
                </tr>
              )}
              {data !== null && !builds.length && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted">
                    No build matches.
                  </td>
                </tr>
              )}
              {builds.map((b) => {
                const usage = b.streaming ? streamingUsage({ ...b, jobs: [{ id: "stream", name: "", profile: b.profile ?? "xs", status: b.status, outputs: [] }] }, data!.at) : null;
                return (
                  <tr key={b.id} className="border-t border-line align-top hover:bg-panel-2">
                    <td className="px-3 py-2">
                      <StatusBadge status={b.status} />
                      {b.failure_type && <div className="text-muted">{b.failure_type}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/pipeline/${b.pipeline_id}`} className="text-ocean hover:underline">
                        {b.pipeline_name}
                      </Link>
                      <div className="text-muted">
                        {b.branch || "main"}
                        {b.streaming ? " · streaming job" : ""}
                        {b.run_setup ? ` · ${b.run_setup.name}` : ""}
                      </div>
                    </td>
                    <td className="max-w-56 px-3 py-2 text-soft">
                      {b.trigger}
                      {b.error && (
                        <div className="truncate text-bad" title={b.error}>
                          {b.error}
                        </div>
                      )}
                    </td>
                    <td className="max-w-64 px-3 py-2 text-muted">
                      {b.outputs_built.length
                        ? b.outputs_built.map((o) => (
                            <span key={o.id} className={`mr-2 ${o.status === "failed" ? "text-bad" : ""}`}>
                              {o.name}
                              {o.rows !== undefined && o.rows !== null ? ` (${o.rows.toLocaleString()})` : ""}
                            </span>
                          ))
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">{when(b.started_at ?? b.created_at)}</td>
                    <td className="px-3 py-2 text-muted">
                      {seconds(b.seconds ?? (b.started_at ? (data!.at - Date.parse(b.started_at)) / 1000 : null))}
                      {usage && <div title={`Streaming compute usage on the ${usage.profile.label} profile`}>{computeSeconds(usage.total)}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/pipeline/${b.pipeline_id}/builds/${b.id}`} className="text-ocean hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <CodeBuilds
          hours={RANGES.find((r) => r[0] === filters.range)?.[2] ?? 0}
          status={filters.status === "succeeded" || filters.status === "failed" ? filters.status : undefined}
          q={filters.q}
        />
      </div>
    </div>
  );
}

/** Code Repositories builds (Python, SQL, Java transforms): status, outputs, data expectations and the Metrics telemetry. */
function CodeBuilds({ hours, status, q }: { hours: number; status?: string; q: string }) {
  const [builds, setBuilds] = useState<(BuildRecord & { repo_name: string })[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    const load = () =>
      codeRepos.recentBuilds({ limit: 200, since: hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined, status }).then(
        (b) => !stale && setBuilds(b),
        () => !stale && setBuilds([]),
      );
    load();
    const t = setInterval(load, 15000);
    return () => {
      stale = true;
      clearInterval(t);
    };
  }, [hours, status]);
  const needle = q.trim().toLowerCase();
  const shown = (builds ?? []).filter((b) => !needle || `${b.repo_name} ${b.transform} ${b.id} ${b.error ?? ""}`.toLowerCase().includes(needle));
  return (
    <section className="mt-8">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Icon name="code" className="h-4 w-4 text-ocean" /> Code Repositories builds
      </h2>
      <p className="mb-3 text-xs text-muted">Transform builds from Code Repositories. Open one for its data expectations and Metrics (memory and CPU over time against what it requested).</p>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Transform</th>
              <th className="px-3 py-2 font-medium">Trigger</th>
              <th className="px-3 py-2 font-medium">Outputs</th>
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {builds === null && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {builds !== null && !shown.length && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted">
                  No code build matches.
                </td>
              </tr>
            )}
            {shown.map((b) => {
              const outs = b.outputs?.length ? b.outputs.map((o) => ({ name: o.name, rows: o.rows })) : b.output ? [{ name: b.output.name, rows: b.output.rows }] : [];
              const failedChecks = (b.expectations ?? []).filter((e) => !e.ok).length;
              return (
                <Fragment key={b.id}>
                  <tr onClick={() => setOpen(open === b.id ? null : b.id)} className="cursor-pointer border-t border-line align-top hover:bg-panel-2">
                    <td className="px-3 py-2">
                      <StatusBadge status={b.status} />
                      {b.aborted && <div className="text-muted">aborted</div>}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/code-repositories/${b.repo_id}`} onClick={(e) => e.stopPropagation()} className="text-ocean hover:underline">
                        {b.repo_name}
                      </Link>
                      <div className="font-mono text-muted">
                        {b.transform.split("::").pop()} · {b.branch ?? "master"}
                      </div>
                    </td>
                    <td className="max-w-56 px-3 py-2 text-soft">
                      {b.trigger}
                      {b.error && (
                        <div className="truncate text-bad" title={b.error}>
                          {b.error}
                        </div>
                      )}
                      {failedChecks > 0 && <div className="text-warn">{failedChecks} expectation{failedChecks > 1 ? "s" : ""} not met</div>}
                    </td>
                    <td className="max-w-64 px-3 py-2 text-muted">
                      {outs.length ? outs.map((o) => <span key={o.name} className="mr-2">{o.name}{typeof o.rows === "number" ? ` (${o.rows.toLocaleString()})` : ""}</span>) : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">{when(b.at)}</td>
                    <td className="px-3 py-2 text-muted">{seconds((b.ms ?? 0) / 1000)}</td>
                  </tr>
                  {open === b.id && (
                    <tr className="border-t border-line bg-ink/40">
                      <td colSpan={6} className="space-y-2 px-3 py-2">
                        {b.expectations && b.expectations.length > 0 && <ExpectationsList items={b.expectations} />}
                        {b.metrics ? <BuildMetricsView metrics={b.metrics} /> : <p className="text-muted">No metrics for this build.</p>}
                        {b.environment && (
                          <details className="rounded-md border border-line bg-panel p-2">
                            <summary className="cursor-pointer text-muted">
                              Spark details → Environment · transforms {b.environment.sparkModuleVersion}
                              {b.environment.sparkVersion ? ` · Spark ${b.environment.sparkVersion}` : ""}
                            </summary>
                            <div className="mt-2">
                              <EnvironmentTable env={b.environment} />
                            </div>
                          </details>
                        )}
                        {b.status === "failed" && (
                          <Link href={`/transforms-common?repo=${b.repo_id}&tab=versions&debug=${b.id}`} className="inline-flex items-center gap-1 text-ocean hover:underline">
                            <Icon name="bug" className="h-3.5 w-3.5" /> Rerun as debug job
                          </Link>
                        )}
                        {b.logs && <pre className="max-h-40 overflow-auto rounded-md bg-ink p-2 text-muted">{b.logs}</pre>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
