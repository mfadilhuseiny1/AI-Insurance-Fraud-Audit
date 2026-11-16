"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { transformsCommon, type SparkUi } from "@/lib/transformsCommon";

/** Spark UI of a debug job (palantir.com/docs/foundry/optimizing-pipelines/spark-ui): Spark's web UI captured when
 *  the job ended — Jobs, Stages (task metric quantiles, peak memory), SQL (plans and their sub-executions),
 *  Executors and Environment (every Spark config). */
export default function SparkUiPage() {
  return (
    <Suspense fallback={null}>
      <SparkUiView />
    </Suspense>
  );
}

type Tab = "jobs" | "stages" | "sql" | "executors" | "environment";
const TABS: [Tab, string][] = [
  ["jobs", "Jobs"],
  ["stages", "Stages"],
  ["sql", "SQL / DataFrame"],
  ["executors", "Executors"],
  ["environment", "Environment"],
];

const fmtBytes = (n?: number) => {
  if (n === undefined || n === null) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
};
const ms = (n?: number) => (n === undefined || n === null ? "—" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const sparkTime = (t?: string) => (t ? t.replace("GMT", "Z").replace("T", " ").slice(0, 19) : "—");
const span = (a?: string, b?: string) => (a && b ? ms(Date.parse(b.replace("GMT", "Z")) - Date.parse(a.replace("GMT", "Z"))) : "—");

function SparkUiView() {
  const params = useSearchParams();
  const repo = params.get("repo") ?? "";
  const job = params.get("job") ?? "";
  const [data, setData] = useState<SparkUi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("jobs");
  const [plan, setPlan] = useState<number | null>(null);
  useEffect(() => {
    transformsCommon.sparkUi(repo, job).then(setData, (e: Error) => setError(e.message));
  }, [repo, job]);
  const list = <T,>(v: T[] | { error: string } | undefined): T[] => (Array.isArray(v) ? v : []);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-5 py-3">
        <span className="rounded-md bg-sand/15 p-1.5 text-sand">
          <Icon name="bolt" className="h-4 w-4" />
        </span>
        <div>
          <div className="text-sm font-semibold">Spark UI</div>
          <div className="text-[11px] text-muted">
            {data ? `${data.app_name} · ${data.app_id} · Spark ${data.spark_version} · captured ${sparkTime(data.captured_at)}` : "debug job"}
          </div>
        </div>
        <Link href={`/transforms-common?repo=${repo}`} className="ml-auto text-xs text-ocean hover:underline">
          ← Debug jobs
        </Link>
      </header>
      {error && <p className="p-5 text-sm text-bad">{error}</p>}
      {!data && !error && <p className="p-5 text-sm text-muted">Loading…</p>}
      {data && (
        <div className="p-5">
          <div className="mb-4 flex gap-1 border-b border-line">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}>
                {l}
              </button>
            ))}
          </div>
          {tab === "jobs" && (
            <Table
              head={["Job", "Description", "Submitted", "Duration", "Stages", "Tasks", "Status"]}
              rows={list(data.jobs).map((j) => [
                j.jobId,
                j.name,
                sparkTime(j.submissionTime),
                span(j.submissionTime, j.completionTime),
                `${j.numCompletedStages}/${j.stageIds.length}${j.numSkippedStages ? ` (${j.numSkippedStages} skipped)` : ""}`,
                `${j.numCompletedTasks}/${j.numTasks}${j.numFailedTasks ? ` (${j.numFailedTasks} failed)` : ""}`,
                j.status,
              ])}
              note="Transforms jobs start with a small count job that asks for executors early (context warming)."
            />
          )}
          {tab === "stages" && (
            <div className="space-y-3">
              {list(data.stages).map((s) => (
                <details key={`${s.stageId}.${s.attemptId}`} className="rounded-lg border border-line bg-panel p-3 text-xs">
                  <summary className="cursor-pointer text-soft">
                    Stage {s.stageId}.{s.attemptId} · {s.status} · {s.numCompleteTasks}/{s.numTasks} tasks · {span(s.submissionTime, s.completionTime)} · input {fmtBytes(s.inputBytes)} ·
                    shuffle read {fmtBytes(s.shuffleReadBytes)} / write {fmtBytes(s.shuffleWriteBytes)} · peak execution memory {fmtBytes(s.peakExecutionMemory)}
                    {s.memoryBytesSpilled ? ` · spilled ${fmtBytes(s.memoryBytesSpilled)}` : ""}
                  </summary>
                  <p className="mt-2 text-muted">{s.name}</p>
                  {s.taskSummary && (
                    <table className="mt-2 w-full text-left">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 font-normal">Metric</th>
                          {["Min", "25th", "Median", "75th", "Max"].map((h) => (
                            <th key={h} className="py-1 font-normal">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          [
                            ["Duration", "duration", ms],
                            ["Scheduler delay", "schedulerDelay", ms],
                            ["GC time", "jvmGcTime", ms],
                            ["Peak execution memory", "peakExecutionMemory", fmtBytes],
                            ["Memory spilled", "memoryBytesSpilled", fmtBytes],
                            ["Result size", "resultSize", fmtBytes],
                          ] as [string, string, (n?: number) => string][]
                        ).map(([label, key, f]) => (
                          <tr key={key} className="border-t border-line">
                            <td className="py-1 text-soft">{label}</td>
                            {((s.taskSummary as Record<string, number[]>)[key] ?? []).map((v, i) => (
                              <td key={i} className="py-1 text-muted">
                                {f(v)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </details>
              ))}
              {!list(data.stages).length && <p className="text-sm text-muted">No stages.</p>}
            </div>
          )}
          {tab === "sql" && (
            <div className="space-y-2">
              <p className="text-xs text-muted">A dataset write can appear as a main query with its query graph under a sub-execution: open the executions below it.</p>
              {list(data.sql).map((q) => (
                <div key={q.id} className="rounded-lg border border-line bg-panel p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-soft">#{q.id}</span>
                    <span className="text-soft">{q.description}</span>
                    <span className="text-muted">
                      {q.status} · {ms(q.duration)} · jobs {[...(q.successJobIds ?? []), ...(q.failedJobIds ?? [])].join(", ") || "—"}
                    </span>
                    <button type="button" onClick={() => setPlan(plan === q.id ? null : q.id)} className="ml-auto text-ocean hover:underline">
                      {plan === q.id ? "Hide plan" : "Show plan"}
                    </button>
                  </div>
                  {plan === q.id && (
                    <>
                      <pre className="mt-2 max-h-96 overflow-auto rounded bg-ink p-2 font-mono text-[11px] text-soft">{q.planDescription}</pre>
                      {Array.isArray(q.nodes) && (
                        <table className="mt-2 w-full text-left">
                          <tbody>
                            {q.nodes.map((n) => (
                              <tr key={n.nodeId} className="border-t border-line">
                                <td className="py-1 text-soft">
                                  ({n.nodeId}) {n.nodeName}
                                </td>
                                <td className="py-1 text-muted">{n.metrics.map((m) => `${m.name}: ${m.value}`).join(" · ") || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                </div>
              ))}
              {!list(data.sql).length && <p className="text-sm text-muted">No SQL executions.</p>}
            </div>
          )}
          {tab === "executors" && (
            <Table
              head={["Executor", "Address", "Added", "Removed", "Cores", "Tasks (failed)", "Task time (GC)", "Input", "Shuffle read / write", "Storage memory"]}
              rows={list(data.executors).map((e) => [
                e.id,
                e.hostPort,
                sparkTime(e.addTime),
                e.removeTime ? `${sparkTime(e.removeTime)}${e.removeReason ? ` — ${e.removeReason}` : ""}` : e.isActive ? "active" : "—",
                e.totalCores,
                `${e.totalTasks} (${e.failedTasks})`,
                `${ms(e.totalDuration)} (${ms(e.totalGCTime)})`,
                fmtBytes(e.totalInputBytes),
                `${fmtBytes(e.totalShuffleRead)} / ${fmtBytes(e.totalShuffleWrite)}`,
                `${fmtBytes(e.memoryUsed)} / ${fmtBytes(e.maxMemory)}`,
              ])}
              note="Local mode: the driver runs the tasks itself (one executor, the driver)."
            />
          )}
          {tab === "environment" && data.environment && "runtime" in data.environment && (
            <div className="space-y-4">
              <Table head={["Runtime", "Value"]} rows={Object.entries(data.environment.runtime).map(([k, v]) => [k, String(v)])} />
              <Table head={["Spark property", "Value"]} rows={data.environment.sparkProperties.map(([k, v]) => [k, v])} />
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">System properties ({data.environment.systemProperties.length})</summary>
                <Table head={["Name", "Value"]} rows={data.environment.systemProperties.map(([k, v]) => [k, v])} />
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Table({ head, rows, note }: { head: string[]; rows: (string | number)[][]; note?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-panel">
      <table className="w-full text-left text-xs">
        <thead className="text-muted">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line align-top">
              {r.map((c, j) => (
                <td key={j} className={`px-3 py-1.5 ${j === 0 ? "text-soft" : "text-muted"} break-all`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {note && <p className="border-t border-line px-3 py-2 text-[11px] text-muted">{note}</p>}
      {!rows.length && <p className="px-3 py-2 text-xs text-muted">Nothing recorded.</p>}
    </div>
  );
}
