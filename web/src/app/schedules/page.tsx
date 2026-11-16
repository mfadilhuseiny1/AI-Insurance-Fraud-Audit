"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { StatusBadge } from "@/components/pipeline/Builds";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { latchedLabel, RunOutcome, ScheduleHistoryDialog, ScopeLine } from "@/components/pipeline/Schedules";
import { Switch } from "@/components/pipeline/ui";
import { codeRepos, type RepoSummary } from "@/lib/codeRepos";
import { when } from "@/lib/format";
import type { Schedule } from "@/lib/pipeline";
import { runtime, type ScheduleSummary } from "@/lib/runtime";

type Filter = "all" | "enabled" | "disabled" | "paused" | "failing" | "warnings";
const FILTERS: { id: Filter; label: string; test: (s: ScheduleSummary) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "enabled", label: "Enabled", test: (s) => s.schedule.enabled && !s.paused },
  { id: "disabled", label: "Disabled", test: (s) => !s.schedule.enabled },
  { id: "paused", label: "Paused", test: (s) => !!s.paused },
  { id: "failing", label: "Last run failed", test: (s) => s.last_run?.status === "failed" || s.failures_in_row > 0 },
  { id: "warnings", label: "Warnings", test: (s) => s.warnings.length > 0 },
];

/** Build Schedules: every pipeline schedule in one place — find, run, pause, resume and inspect them. */
export default function BuildSchedulesPage() {
  const [list, setList] = useState<ScheduleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // schedules owned by a user, or scoped to a Project
  const [owner, setOwner] = useState("");
  const [project, setProject] = useState("");
  const [history, setHistory] = useState<{ pipelineId: string; schedule: Schedule } | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(
    () =>
      runtime.schedules().then(
        (l) => {
          setList(l);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  const key = (s: ScheduleSummary) => `${s.pipeline_id}/${s.schedule.id}`;
  const act = async (s: ScheduleSummary, fn: () => Promise<unknown>, done?: (r: unknown) => string) => {
    try {
      const r = await fn();
      if (done) setNote((n) => ({ ...n, [key(s)]: done(r) }));
    } catch (e) {
      setNote((n) => ({ ...n, [key(s)]: (e as Error).message }));
    }
    load();
  };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const test = FILTERS.find((f) => f.id === filter)!.test;
    return (list ?? []).filter(
      (s) =>
        test(s) &&
        (!owner || s.owner?.id === owner) &&
        (!project || s.scope_projects.some((p) => p.id === project)) &&
        (!q || [s.schedule.name, s.pipeline_name, s.trigger, ...s.path].some((x) => x.toLowerCase().includes(q))),
    );
  }, [list, query, filter, owner, project]);
  const owners = useMemo(() => [...new Map((list ?? []).filter((s) => s.owner).map((s) => [s.owner!.id, s.owner!])).values()], [list]);
  const projects = useMemo(() => [...new Map((list ?? []).flatMap((s) => s.scope_projects).map((p) => [p.id, p])).values()], [list]);
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold">
          <Icon name="clock" className="h-5 w-5 text-ocean" /> Build Schedules
        </h1>
        <p className="mb-5 text-sm text-muted">Every schedule of every pipeline: what triggers it, how its last run went and when it runs next. Edit a schedule in its pipeline (Schedules panel).</p>
        <HygieneReport />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-72">
            <Icon name="search" className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search schedules, pipelines, folders…" className={`${inputClass} pl-8 text-xs`} />
          </div>
          {FILTERS.map((f) => {
            const n = (list ?? []).filter(f.test).length;
            return (
              <button key={f.id} type="button" onClick={() => setFilter(f.id)} className={`rounded-md px-2.5 py-1 text-xs ${filter === f.id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}>
                {f.label} <span className="tabular-nums text-muted">{n}</span>
              </button>
            );
          })}
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={`${inputClass} w-40 text-xs`} title="Owner (user-scoped schedules run as them)">
            <option value="">Any owner</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.display_name || o.username}
                {o.status !== "active" ? ` (${o.status})` : ""}
              </option>
            ))}
          </select>
          <select value={project} onChange={(e) => setProject(e.target.value)} className={`${inputClass} w-40 text-xs`} title="Project a schedule is scoped to">
            <option value="">Any scope</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={load} title="Refresh" className="ml-auto rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white">
            <Icon name="refresh" className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="mb-3 text-sm text-bad">{error}</p>}
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="px-3 py-2 font-medium">Next run</th>
                <th className="px-3 py-2 font-medium">Enabled</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list === null && !error && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted">
                    Loading…
                  </td>
                </tr>
              )}
              {list !== null && !shown.length && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted">
                    {list.length ? "No schedule matches." : "No schedules yet. Add one in a pipeline's Schedules panel."}
                  </td>
                </tr>
              )}
              {shown.map((s) => {
                const waiting = latchedLabel(s.schedule, s.latched);
                return (
                  <tr key={key(s)} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-white">{s.schedule.name}</div>
                      <Link href={`/pipeline/${s.pipeline_id}`} className="text-ocean hover:underline">
                        {s.pipeline_name}
                      </Link>
                      <div className="text-muted">{s.path.join(" / ")}</div>
                      <ScopeLine st={s} />
                      {s.paused && (
                        <div className="mt-1 flex items-center gap-1 text-warn">
                          <Icon name="pause" className="h-3 w-3" /> Paused: {s.paused.reason}
                        </div>
                      )}
                      {s.warnings.map((w) => (
                        <div key={w} className="mt-0.5 flex items-center gap-1 text-warn">
                          <Icon name="alert" className="h-3 w-3" /> {w}
                        </div>
                      ))}
                    </td>
                    <td className="max-w-xs px-3 py-2 text-soft">
                      {s.trigger || "—"}
                      {waiting.length > 0 && <div className="text-muted">already happened: {waiting.join(", ")}</div>}
                      {s.pipeline_type === "streaming" && <div className="text-muted">streaming pipeline</div>}
                    </td>
                    <td className="px-3 py-2">
                      {s.last_run ? (
                        <>
                          <RunOutcome run={s.last_run} /> <span className="text-muted">{when(s.last_run.at)}</span>
                          {s.last_run.reason && <div className="text-muted">{s.last_run.reason}</div>}
                          {s.last_run.build_status?.slice(-1).map((b) => (
                            <Link key={b.id} href={`/pipeline/${s.pipeline_id}/builds/${b.id}`} className="flex items-center gap-1 text-ocean hover:underline">
                              <StatusBadge status={b.status} spin={false} /> build {b.id.slice(6)}
                            </Link>
                          ))}
                        </>
                      ) : (
                        <span className="text-muted">Not run yet</span>
                      )}
                      {s.failures_in_row > 0 && <div className="text-bad">{s.failures_in_row} failed in a row</div>}
                    </td>
                    <td className="px-3 py-2 text-muted">{s.next_runs[0] ? new Date(s.next_runs[0]).toLocaleString() : s.schedule.enabled && !s.paused ? "on its events" : "—"}</td>
                    <td className="px-3 py-2">
                      <Switch
                        on={s.schedule.enabled}
                        onChange={(enabled) => act(s, () => runtime.setScheduleEnabled(s.pipeline_id, s.schedule.id, enabled), () => `${enabled ? "Enabled" : "Disabled"} — saved to the pipeline file (reload the pipeline if it is open)`)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              act(
                                s,
                                () => runtime.runSchedule(s.pipeline_id, s.schedule.id),
                                (r) => {
                                  const run = r as { outcome: string; reason: string | null; builds: string[] };
                                  return run.outcome === "started" ? `Started ${run.builds.length} build(s)` : `${run.outcome}: ${run.reason}`;
                                },
                              )
                            }
                            className={`${buttonClass.secondary} py-0.5 text-xs`}
                          >
                            <Icon name="play" className="h-3 w-3" /> Run now
                          </button>
                          {s.paused && (
                            <button type="button" onClick={() => act(s, () => runtime.resumeSchedule(s.pipeline_id, s.schedule.id))} className={`${buttonClass.secondary} py-0.5 text-xs`}>
                              Resume
                            </button>
                          )}
                          <button type="button" onClick={() => setHistory({ pipelineId: s.pipeline_id, schedule: s.schedule })} className={`${buttonClass.secondary} py-0.5 text-xs`}>
                            <Icon name="history" className="h-3 w-3" /> History
                          </button>
                        </div>
                        {note[key(s)] && <span className="text-muted">{note[key(s)]}</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-8 pb-8">
        <RepoSchedules query={query} />
      </div>
      {history && <ScheduleHistoryDialog pipelineId={history.pipelineId} schedule={history.schedule} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** Code Repositories transform schedules (built on each repository's default branch). */
function RepoSchedules({ query }: { query: string }) {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(() => codeRepos.list().then(setRepos, () => setRepos([])), []);
  useEffect(() => {
    load();
  }, [load]);
  const q = query.trim().toLowerCase();
  const rows = (repos ?? []).flatMap((r) => r.schedules.map((s) => ({ repo: r, s }))).filter(({ repo, s }) => !q || `${repo.name} ${s.transform}`.toLowerCase().includes(q));
  if (!rows.length) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Icon name="code" className="h-4 w-4 text-ocean" /> Code Repositories
      </h2>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Transform</th>
              <th className="px-3 py-2 font-medium">Trigger</th>
              <th className="px-3 py-2 font-medium">Last run</th>
              <th className="px-3 py-2 font-medium">Enabled</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ repo, s }) => (
              <tr key={s.id} className="border-t border-line align-top">
                <td className="px-3 py-2">
                  <div className="font-mono text-white">{s.transform.split("::").pop()}</div>
                  <Link href={`/code-repositories/${repo.id}`} className="text-ocean hover:underline">
                    {repo.name}
                  </Link>
                  <span className="text-muted"> · {repo.default_branch}</span>
                </td>
                <td className="px-3 py-2 text-soft">
                  {[s.cron ? `cron ${s.cron} (${s.timezone ?? "UTC"})` : "", s.every_minutes ? `every ${s.every_minutes} min` : "", s.on_input_update ? "input updated" : ""].filter(Boolean).join(" or ")}
                  {s.retries ? <div className="text-muted">{s.retries} retries</div> : null}
                </td>
                <td className="px-3 py-2">
                  {s.last_status ? <StatusBadge status={s.last_status === "retrying" ? "running" : s.last_status} spin={false} /> : <span className="text-muted">Not run yet</span>}
                  {s.last_run_at && <div className="text-muted">{when(s.last_run_at)}</div>}
                </td>
                <td className="px-3 py-2">
                  <Switch on={s.enabled} onChange={(enabled) => codeRepos.updateSchedule(repo.id, s.id, { enabled }).then(load)} />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      codeRepos.runSchedule(repo.id, s.id).then(
                        () => {
                          setNote((n) => ({ ...n, [s.id]: "Started" }));
                          load();
                        },
                        (e: Error) => setNote((n) => ({ ...n, [s.id]: e.message })),
                      )
                    }
                    className={`${buttonClass.secondary} py-0.5 text-xs`}
                  >
                    <Icon name="play" className="h-3 w-3" /> Run now
                  </button>
                  {note[s.id] && <div className="mt-1 text-muted">{note[s.id]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Usage hygiene: schedules that build the same outputs twice (duplicates) or fire together (overlapping). */
function HygieneReport() {
  const [report, setReport] = useState<Awaited<ReturnType<typeof runtime.schedulesReport>> | null>(null);
  useEffect(() => {
    runtime.schedulesReport().then(setReport, () => {});
  }, []);
  if (!report?.findings.length) return null;
  const tone = { duplicate: "border-bad/40 bg-bad/10", overlapping: "border-warn/40 bg-warn/10", shared_outputs: "border-line bg-panel" } as const;
  return (
    <div className="mb-4 space-y-2">
      <div className="text-sm font-medium">
        Usage hygiene · {report.findings.length} finding{report.findings.length === 1 ? "" : "s"}
      </div>
      {report.findings.map((f, i) => (
        <div key={i} className={`rounded-lg border p-2.5 text-xs ${tone[f.kind]}`}>
          <div className="flex items-center gap-2">
            <span className="rounded bg-ink/40 px-1.5 py-0.5 uppercase tracking-wide">{f.kind.replace("_", " ")}</span>
            <Link href={`/pipeline/${f.pipeline_id}`} className="font-medium text-ocean hover:underline">
              {f.pipeline_name}
            </Link>
            <span className="text-muted">· {f.outputs}</span>
          </div>
          <div className="mt-1 text-soft">{f.schedules.map((s) => `${s.name} (${s.trigger})`).join("  ↔  ")}</div>
          <div className="mt-0.5 text-muted">{f.message}</div>
        </div>
      ))}
    </div>
  );
}
