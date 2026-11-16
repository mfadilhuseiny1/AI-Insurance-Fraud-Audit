"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { computeSeconds, streamingUsage } from "@/lib/compute";
import { when } from "@/lib/format";
import { isActive, outputStates, runtime, type BuildRecord, type OutputState } from "@/lib/runtime";
import { Icon, type IconName } from "../Icon";
import { buttonClass } from "./Modal";
import { Panel, Tabs } from "./ui";

/** Builds of a pipeline and its outputs' deploy state, polled (fast while a build runs). */

const FAILURE_LABEL = { immediate: "Immediate", transient: "Transient", persistent: "Persistent" } as const;
const FAILURE_HINT = {
  immediate: "It failed before running: fix the pipeline (validation, inputs) and deploy again.",
  transient: "A passing problem (network, a restart): streaming jobs restart on their own from the last checkpoint.",
  persistent: "It will keep failing until the logic or the data changes: check the error and the input records.",
} as const;
export function useBuilds(pipelineId: string | undefined, branch = "main") {
  const [builds, setBuilds] = useState<BuildRecord[] | null>(null);
  const [outputs, setOutputs] = useState<Map<string, OutputState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!pipelineId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [b, s] = await Promise.all([runtime.builds(pipelineId, 40), runtime.state(pipelineId)]);
        if (!live) return;
        setBuilds(b);
        setOutputs(outputStates(s, branch));
        setError(null);
        timer = setTimeout(load, b.some(isActive) ? 1500 : 15000);
      } catch (e) {
        if (!live) return;
        setError((e as Error).message);
        timer = setTimeout(load, 15000);
      }
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [pipelineId, tick, branch]);
  return { builds, outputs, error, refresh };
}

export const STATUS: Record<string, { icon: IconName; tone: string; label: string }> = {
  queued: { icon: "clock", tone: "text-muted", label: "Queued" },
  running: { icon: "refresh", tone: "text-ocean", label: "Running" },
  pending: { icon: "clock", tone: "text-muted", label: "Waiting" },
  succeeded: { icon: "check", tone: "text-ok", label: "Succeeded" },
  failed: { icon: "alert", tone: "text-bad", label: "Failed" },
  cancelled: { icon: "x", tone: "text-muted", label: "Cancelled" },
  skipped: { icon: "minus", tone: "text-muted", label: "Skipped" },
};

export function StatusBadge({ status, spin = true }: { status: string; spin?: boolean }) {
  const s = STATUS[status] ?? STATUS.queued;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${s.tone}`}>
      <Icon name={s.icon} className={`h-3.5 w-3.5 ${spin && status === "running" ? "animate-spin" : ""}`} /> {s.label}
    </span>
  );
}

const duration = (a?: string | null, b?: string | null) => {
  if (!a) return "";
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** A build's jobs, outputs, expectations and logs (the build progress page and the Builds panel). */
export function BuildDetails({ build, onCancel }: { build: BuildRecord; onCancel?: () => void }) {
  const [tab, setTab] = useState<"jobs" | "expectations" | "logs">("jobs");
  const expectations = [
    ...(build.preconditions ?? []).map((e) => ({ ...e, output: `input ${e.input}` })),
    ...build.jobs.flatMap((j) => j.outputs.flatMap((o) => (o.expectations ?? []).map((e) => ({ ...e, output: o.name })))),
  ];
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <StatusBadge status={build.status} />
        <span className="text-xs text-muted">{build.trigger}</span>
        <span className="text-xs text-muted">branch {build.branch || "main"}</span>
        <span className="text-xs text-muted">queued {when(build.created_at)}</span>
        {build.started_at && <span className="text-xs text-muted">ran {duration(build.started_at, build.finished_at)}</span>}
        {onCancel && isActive(build) && (
          <button type="button" onClick={onCancel} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
            <Icon name="stop" className="h-3.5 w-3.5" /> Cancel build
          </button>
        )}
      </div>
      {build.error && (
        <p className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {build.failure_type && <span className="mr-1.5 rounded bg-bad/20 px-1.5 py-px text-[10px] uppercase tracking-wide">{FAILURE_LABEL[build.failure_type]}</span>}
            {build.error}
            {build.failure_type && <span className="mt-0.5 block text-muted">{FAILURE_HINT[build.failure_type]}</span>}
          </span>
        </p>
      )}
      {build.streaming && <StreamingUsageLine build={build} />}
      {build.summary?.regularSnapshot && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Icon name="restore" className="h-3.5 w-3.5" /> Regular snapshot ({build.summary.regularSnapshot}): the inputs were read in full and the outputs replaced.
        </p>
      )}
      {build.restart_of && (
        <p className="text-xs text-muted">
          Restarted automatically from build {build.restart_of.slice(6)} ({build.auto_restarts ?? 1} restart{(build.auto_restarts ?? 1) === 1 ? "" : "s"} in a row); it resumed from the last checkpoint.
        </p>
      )}
      {(build.rerun_of || build.retry_of || build.version_id || build.parameters && Object.keys(build.parameters).length > 0) && (
        <p className="text-xs text-muted">
          {build.rerun_of && <>Rerun of build {build.rerun_of.slice(6)}. </>}
          {build.retry_of && <>Retry {build.attempt ?? 2} of build {build.retry_of.slice(6)}. </>}
          {build.version_id && build.logic_version && <>Built the earlier logic version saved {when(build.logic_version.at)}{build.logic_version.message ? ` (“${build.logic_version.message}”)` : ""}. </>}
          {build.parameters && Object.keys(build.parameters).length > 0 && <>Parameters: {Object.entries(build.parameters).map(([k, v]) => `${k} = ${v}`).join(", ")}.</>}
        </p>
      )}
      {build.validation?.length > 0 && (
        <div className="rounded-md border border-bad/40 bg-bad/5 p-2 text-xs">
          <div className="mb-1 font-medium text-bad">Deployment validation</div>
          <ul className="list-disc space-y-0.5 pl-4 text-soft">
            {build.validation.map((v, i) => (
              <li key={i}>{v.message}</li>
            ))}
          </ul>
          <p className="mt-1 text-muted">Resolve each issue, save, and deploy again.</p>
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "jobs", label: "Jobs", badge: build.jobs.length },
          { id: "expectations", label: "Job expectations", badge: expectations.filter((e) => !e.ok).length || undefined, tone: expectations.some((e) => !e.ok && e.mode !== "warn") ? "bad" : "warn" },
          { id: "logs", label: "Logs", badge: build.logs.length },
        ]}
      />
      {tab === "jobs" && (
        <ul className="space-y-2">
          {build.jobs.map((j) => (
            <li key={j.id} className="rounded-md border border-line bg-panel-2 p-2.5">
              <div className="flex items-center gap-2 text-xs">
                <Icon name="layers" className="h-3.5 w-3.5 text-ocean" />
                <span className="font-medium text-white">{j.name}</span>
                <span className="text-muted">profile {j.profile}</span>
                <span className="ml-auto">
                  <StatusBadge status={j.status} />
                </span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {j.outputs.map((o) => (
                  <li key={o.id} className="rounded bg-panel px-2 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={o.status} />
                      <span className="truncate text-soft">{o.name}</span>
                      <span className="text-muted">{o.kind}</span>
                      {o.rows !== undefined && <span className="ml-auto text-muted">{o.rows.toLocaleString()} rows</span>}
                      {o.seconds !== undefined && <span className="text-muted">{o.seconds}s</span>}
                    </div>
                    {o.error && <p className="mt-0.5 text-bad">{o.error}</p>}
                    {o.path &&
                      (o.streamId ? (
                        <Link href={`/streaming/streams/${o.streamId}`} className="mt-0.5 block truncate text-ocean hover:underline">
                          → output ingest stream (open in Streaming)
                        </Link>
                      ) : o.path.startsWith("stream ") ? (
                        <Link href={`/pipeline/streams/${o.path.slice(7)}`} className="mt-0.5 block truncate text-ocean hover:underline">
                          → output stream (open the stream preview)
                        </Link>
                      ) : (
                        <p className="mt-0.5 truncate text-muted" title={o.path}>
                          → {o.path}
                        </p>
                      ))}
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {!build.jobs.length && <li className="text-xs text-muted">{isActive(build) ? "Preparing jobs…" : "No jobs ran."}</li>}
        </ul>
      )}
      {tab === "expectations" && (
        <ul className="space-y-1 text-xs">
          {expectations.map((e, i) => (
            <li key={i} className="flex items-start gap-2 rounded bg-panel-2 px-2 py-1.5">
              <Icon name={e.ok ? "check" : "alert"} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${e.ok ? "text-ok" : e.mode === "warn" ? "text-warn" : "text-bad"}`} />
              <span className="w-32 shrink-0 truncate text-muted" title={e.output}>
                {e.output}
              </span>
              <span className="text-soft">{e.message}</span>
              {e.mode === "warn" && <span className="ml-auto shrink-0 text-muted">warn only</span>}
            </li>
          ))}
          {!expectations.length && <li className="text-muted">No expectations were checked.</li>}
        </ul>
      )}
      {tab === "logs" && (
        <pre className="max-h-96 overflow-auto rounded-md bg-ink p-2 font-mono text-[11px] leading-5">
          {build.logs.map((l, i) => (
            <div key={i} className={l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "text-soft"}>
              {new Date(l.at).toLocaleTimeString()} {l.level.toUpperCase().padEnd(5)} {l.msg}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** Compute-seconds a streaming build used so far: the job manager plus parallelism + 1 task managers. */
function StreamingUsageLine({ build }: { build: BuildRecord }) {
  const u = streamingUsage(build);
  if (!u) return null;
  const p = u.profile;
  return (
    <p className="rounded-md border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
      <Icon name="gauge" className="mr-1.5 inline h-3.5 w-3.5 text-ocean" />
      Compute usage <b className="text-soft">{computeSeconds(u.total)}</b>
      {isActive(build) ? " so far" : ""} — job manager {computeSeconds(u.jobManager)} ({p.jmCpu} vCPU, {p.jmGiB}GB) + task managers {computeSeconds(u.taskManagers)} ({p.par + 1} × {p.tmCpu} vCPU, {p.tmGiB}GB) over{" "}
      {duration(build.started_at, build.finished_at)} on the {p.label} profile.
    </p>
  );
}

/** Right panel: the pipeline's builds (deploy history), newest first. */
export function BuildsPanel({ pipelineId, builds, error, onClose, onRefresh }: { pipelineId: string; builds: BuildRecord[] | null; error: string | null; onClose: () => void; onRefresh: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title="Builds"
      icon="pipeline"
      onClose={onClose}
      width="w-[26rem]"
      actions={
        <button type="button" title="Refresh" onClick={onRefresh} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </button>
      }
    >
      {error && <p className="p-3 text-xs text-bad">{error}</p>}
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {builds === null && !error && <li className="text-xs text-muted">Loading…</li>}
        {builds?.length === 0 && <li className="py-6 text-center text-xs text-muted">No builds yet. Deploy the pipeline to build its outputs.</li>}
        {builds?.map((b) => (
          <li key={b.id} className="rounded-md border border-line bg-panel-2">
            <button type="button" onClick={() => setOpen(open === b.id ? null : b.id)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs">
              <StatusBadge status={b.status} />
              <span className="min-w-0 flex-1 truncate text-soft">{b.trigger}</span>
              <span className="text-muted">{when(b.created_at)}</span>
              <Icon name={open === b.id ? "down" : "right"} className="h-3 w-3 text-muted" />
            </button>
            {open === b.id && (
              <div className="border-t border-line p-2.5">
                <BuildDetails build={b} onCancel={() => runtime.cancel(b.id).then(onRefresh)} />
                <Link href={`/pipeline/${pipelineId}/builds/${b.id}`} className="mt-2 inline-flex items-center gap-1 text-xs text-ocean hover:underline">
                  <Icon name="external" className="h-3 w-3" /> Open build progress page
                </Link>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
