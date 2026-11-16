"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { TsChart } from "@/components/timeseries/TsChart";
import { when } from "@/lib/format";
import { streaming, type StreamArchive, type StreamDataset, type StreamJobs, type StreamMetricKey, type StreamMetrics, type StreamPipelineJob, type StreamRecords, type TroubleshootStep } from "@/lib/streaming";

/** Streaming datasets in Dataset Preview (api/stream_datasets.py): the Live view of the stream's records, the
 *  Stream tab (the jobs that wrote it) and the Metrics tab with Troubleshoot mode. */

export function LiveRecords({ sd }: { sd: StreamDataset }) {
  const [data, setData] = useState<StreamRecords | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const id = sd.stream.id;
  const load = useCallback(() => {
    streaming.records(id, 0, 500, "changelog").then(
      (r) => {
        setData(r);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);
  useEffect(() => {
    load();
    if (paused) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, paused]);
  const cols = data ? [...data.columns.map((c) => c.name), ...Object.keys(data.rows[0] ?? {}).filter((k) => k.startsWith("_") && !data.columns.some((c) => c.name === k))] : [];
  const rows = data ? [...data.rows].reverse().slice(0, 200) : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs">
        <span className="flex items-center gap-1.5 text-ok">
          <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-muted" : "animate-pulse bg-ok"}`} /> {paused ? "Paused" : "Live updates"}
        </span>
        <span className="text-muted">
          {data ? `${data.last_seq.toLocaleString()} records in view ${data.view_id} · newest first` : "Loading…"}
        </span>
        <button type="button" onClick={() => setPaused(!paused)} className="ml-auto text-ocean hover:underline">
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      {error && <p className="m-4 text-xs text-bad">{error}</p>}
      <div className="result-table min-h-0 flex-1 overflow-auto p-3">
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} className="bg-panel-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className="text-xs text-soft">
                    {r[c] === null || r[c] === undefined ? <span className="italic text-muted">null</span> : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data && !rows.length && <p className="p-4 text-xs text-muted">No records in the stream yet.</p>}
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = { running: "text-ok", starting: "text-ocean", retrying: "text-warn", failed: "text-bad", stopped: "text-muted" };

export function StreamTab({ sd }: { sd: StreamDataset }) {
  const [hours, setHours] = useState(24);
  const [jobs, setJobs] = useState<StreamJobs | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => streaming.jobs(sd.stream.id, hours).then((j) => alive && setJobs(j), (e: Error) => alive && setError(e.message));
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sd.stream.id, hours]);
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
      <div className="flex items-center gap-3">
        <span className="font-semibold text-soft">Streaming jobs</span>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="rounded border border-line-2 bg-ink px-2 py-1 text-soft outline-none">
          {[1, 6, 24, 72, 168, 720].map((h) => (
            <option key={h} value={h}>
              Last {h < 24 ? `${h} hour${h > 1 ? "s" : ""}` : `${h / 24} day${h > 24 ? "s" : ""}`}
            </option>
          ))}
        </select>
        <Link href={`/streaming/streams/${sd.stream.id}`} className="ml-auto text-ocean hover:underline">
          Open the stream in Streaming
        </Link>
      </div>
      {error && <p className="text-bad">{error}</p>}
      {!jobs && !error && <p className="text-muted">Loading…</p>}
      {jobs?.push && <p className="rounded-lg border border-line bg-panel p-3 text-muted">No job writes this stream: records arrive by push to the stream proxy URL.</p>}
      {jobs?.pipeline && !jobs.pipeline_job && (
        <div className="rounded-lg border border-line bg-panel p-3">
          <Icon name="pipeline" className="mr-1.5 inline h-3.5 w-3.5 text-ocean" />
          Output of the pipeline{" "}
          <Link href={`/pipeline/${jobs.pipeline.id}`} className="text-ocean hover:underline">
            {jobs.pipeline.name}
          </Link>
        </div>
      )}
      {jobs?.pipeline_job && <PipelineJobCard job={jobs.pipeline_job} />}
      {jobs?.syncs.map((s) => (
        <div key={s.id} className="rounded-lg border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <Icon name="wave" className="h-4 w-4 text-ocean" />
            <Link href={`/streaming/syncs/${s.id}`} className="font-medium text-soft hover:underline">
              {s.name}
            </Link>
            <span className="text-muted">{s.kind} sync</span>
            <span className={`font-medium ${STATUS_COLOR[s.status] ?? "text-soft"}`}>{s.status}</span>
            <span className="ml-auto text-muted">
              {s.records_5m.toLocaleString()} records in 5 min · lag {s.lag ?? 0} · parallelism {s.parallelism ?? 1}
              {s.last_checkpoint_at ? ` · last checkpoint ${when(s.last_checkpoint_at)}` : ""}
            </span>
          </div>
          {s.error && <pre className="mx-3 mt-2 whitespace-pre-wrap rounded bg-bad/10 p-2 font-mono text-[11px] text-bad">{s.error}</pre>}
          <ul className="max-h-60 overflow-y-auto p-3">
            {!s.events.length && <li className="text-muted">No job events in this period.</li>}
            {s.events.map((e, i) => (
              <li key={i} className="flex items-start gap-3 py-0.5">
                <span className="w-36 shrink-0 font-mono text-[11px] text-muted">{e.at.slice(0, 19).replace("T", " ")}</span>
                <span className={`w-16 shrink-0 ${STATUS_COLOR[e.status] ?? "text-soft"}`}>{e.status}</span>
                <span className="min-w-0 truncate text-muted" title={e.error ?? ""}>
                  {e.error}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <ArchiveRuns streamId={sd.stream.id} initial={sd.archive} />
    </div>
  );
}

const JOB_STATUS_COLOR: Record<string, string> = { ...STATUS_COLOR, started: "text-ok", queued: "text-ocean", succeeded: "text-muted", cancelled: "text-muted" };

/** The streaming pipeline writing the stream: its build, checkpoint, lag and the offsets of its inputs. */
function PipelineJobCard({ job }: { job: StreamPipelineJob }) {
  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon name="pipeline" className="h-4 w-4 text-ocean" />
        <Link href={`/pipeline/${job.pipeline_id}`} className="font-medium text-soft hover:underline">
          {job.pipeline_name}
        </Link>
        <span className="text-muted">streaming pipeline · {job.branch}</span>
        <span className={`font-medium ${job.running ? "text-ok" : (JOB_STATUS_COLOR[job.status] ?? "text-soft")}`}>{job.status}</span>
        <span className="ml-auto text-muted">
          {job.records_in_5m.toLocaleString()} in · {job.records_out_5m.toLocaleString()} out in 5 min · lag {job.lag ?? "?"}
          {job.last_checkpoint_at ? ` · last checkpoint ${when(job.last_checkpoint_at)}` : " · no checkpoint yet"}
        </span>
      </div>
      {job.error && !job.running && <pre className="mx-3 mt-2 whitespace-pre-wrap rounded bg-bad/10 p-2 font-mono text-[11px] text-bad">{job.error}</pre>}
      {job.inputs.length > 0 && (
        <table className="mx-3 mt-2 w-[calc(100%-1.5rem)] text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted">
              <th className="py-1 font-medium">Input stream</th>
              <th className="py-1 text-right font-medium">Checkpointed offset</th>
              <th className="py-1 text-right font-medium">Last offset</th>
              <th className="py-1 text-right font-medium">Lag</th>
            </tr>
          </thead>
          <tbody>
            {job.inputs.map((i) => (
              <tr key={i.id} className="border-t border-line">
                <td className="py-1 text-soft">{i.kind === "ingest" ? <Link href={`/streaming/streams/${i.id}`} className="hover:underline">{i.name}</Link> : i.name}</td>
                <td className="py-1 text-right font-mono text-muted">{i.offset.toLocaleString()}</td>
                <td className="py-1 text-right font-mono text-muted">{i.head.toLocaleString()}</td>
                <td className={`py-1 text-right font-mono ${i.lag ? "text-warn" : "text-muted"}`}>{i.lag.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ul className="max-h-60 overflow-y-auto p-3">
        {!job.events.length && <li className="text-muted">No streaming builds in this period.</li>}
        {job.events.map((e, i) => (
          <li key={i} className="flex items-start gap-3 py-0.5">
            <span className="w-36 shrink-0 font-mono text-[11px] text-muted">{e.at.slice(0, 19).replace("T", " ")}</span>
            <span className={`w-16 shrink-0 ${JOB_STATUS_COLOR[e.status] ?? "text-soft"}`}>{e.status}</span>
            <span className="min-w-0 truncate text-muted" title={e.error ?? e.trigger ?? ""}>
              {e.error ?? e.trigger ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The archive's runs: APPENDs of the new records (offsets and watermark), and full rewrites with their reason. */
function ArchiveRuns({ streamId, initial }: { streamId: string; initial: StreamArchive | null }) {
  const [archive, setArchive] = useState(initial);
  useEffect(() => {
    let alive = true;
    const load = () => streaming.archive(streamId).then((d) => alive && setArchive(d.archive), () => {});
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [streamId]);
  const runs = archive?.history ?? [];
  if (!archive) return null;
  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon name="history" className="h-4 w-4 text-ocean" />
        <span className="font-medium text-soft">Archive runs</span>
        <span className="ml-auto text-muted">
          offset {archive.last_seq?.toLocaleString() ?? 0}
          {archive.watermark ? ` · watermark ${archive.watermark.slice(0, 19).replace("T", " ")}` : ""} · every {archive.every_minutes} min
        </span>
      </div>
      <ul className="max-h-72 overflow-y-auto p-3">
        {!runs.length && <li className="text-muted">No archive run recorded with offsets yet (runs before incremental archiving rewrote the whole view).</li>}
        {runs.map((r, i) => (
          <li key={i} className="flex items-start gap-3 py-0.5">
            <span className="w-36 shrink-0 font-mono text-[11px] text-muted">{r.at.slice(0, 19).replace("T", " ")}</span>
            <span className={`w-20 shrink-0 font-medium ${r.transaction === "APPEND" ? "text-ok" : "text-warn"}`}>{r.transaction}</span>
            <span className="min-w-0 text-muted">
              {r.written.toLocaleString()} record{r.written === 1 ? "" : "s"}
              {r.from_offset !== null ? ` (offsets ${r.from_offset.toLocaleString()}–${r.to_offset.toLocaleString()})` : ""} · {r.rows.toLocaleString()} rows in all
              {r.reason ? <span className="block text-warn">{r.reason}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STEP_STYLE: Record<TroubleshootStep["state"], [string, IconName]> = { pass: ["text-ok", "check"], fail: ["text-bad", "x"], warn: ["text-warn", "alert"], info: ["text-ocean", "info"] };

export function MetricsTab({ sd }: { sd: StreamDataset }) {
  const [minutes, setMinutes] = useState(60);
  const [data, setData] = useState<StreamMetrics | null>(null);
  // the charts shown: until changed, a sync's defaults, or a streaming pipeline's (records in / out, lag, checkpoint age)
  const [picked, setShown] = useState<StreamMetricKey[] | null>(null);
  const [expanded, setExpanded] = useState<StreamMetricKey | null>(null);
  const [debug, setDebug] = useState(false);
  const [steps, setSteps] = useState<TroubleshootStep[] | null>(null);
  const [highlight, setHighlight] = useState<StreamMetricKey | null>(null);
  const [adding, setAdding] = useState("");
  const id = sd.stream.id;
  useEffect(() => {
    let alive = true;
    const load = () => streaming.streamMetrics(id, minutes).then((d) => alive && setData(d), () => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, minutes]);
  useEffect(() => {
    if (!debug) return;
    let alive = true;
    streaming.troubleshoot(id).then((r) => alive && setSteps(r.steps), () => {});
    return () => {
      alive = false;
    };
  }, [id, debug]);
  const defs = data?.metrics ?? [];
  const shown: StreamMetricKey[] = picked ?? (data?.pipeline ?["records", "records_in", "lag", "cp_age"] : ["records", "lag", "cp_failures", "utilization"]);
  const chart = (key: StreamMetricKey, height: number) => {
    const def = defs.find((d) => d.key === key);
    if (!def || !data) return null;
    const points = data.series.map((s) => ({ t: `${s.minute}:00Z`, value: s[key] ?? null }));
    const has = points.some((p) => p.value !== null);
    const over = def.threshold !== null && points.some((p) => typeof p.value === "number" && (def.direction === "below" ? p.value < def.threshold! : p.value >= def.threshold!));
    return (
      <div key={key} className={`rounded-lg border bg-panel p-3 ${highlight === key ? "border-ocean ring-2 ring-ocean/40" : over ? "border-warn/50" : "border-line"}`}>
        <div className="mb-1 flex items-center gap-2 text-xs">
          <span className="font-medium text-soft">{def.label}</span>
          <span className="text-muted">{def.unit}</span>
          {def.recommended && <span className="rounded bg-ocean/15 px-1 text-[10px] text-ocean">debugging</span>}
          {over && (
            <span className="flex items-center gap-1 text-warn" title={`threshold ${def.threshold}`}>
              <Icon name="alert" className="h-3 w-3" /> over the {def.threshold} threshold
            </span>
          )}
          <button type="button" onClick={() => setExpanded(expanded === key ? null : key)} className="ml-auto text-muted hover:text-white" aria-label="Expand">
            <Icon name={expanded === key ? "x" : "external"} className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => setShown(shown.filter((k) => k !== key))} className="text-muted hover:text-bad" aria-label="Remove chart">
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        </div>
        {has ? (
          <TsChart
            height={height}
            series={[
              { key, label: def.label, unit: def.unit, points },
              ...(def.threshold !== null ? [{ key: "threshold", label: "Threshold", unit: def.unit, points: points.map((p) => ({ t: p.t, value: def.threshold })), color: "var(--color-warn)" }] : []),
            ]}
          />
        ) : (
          <p className="py-8 text-center text-xs text-muted">{data.jobs ? (data.pipeline && ["cp_failures", "cp_ms_max", "utilization", "dropped"].includes(key) ? "Streaming pipelines do not report this metric (only streaming syncs do)." : "No data in this period.") : "Only jobs (streaming syncs and streaming pipelines) report this metric."}</p>
        )}
      </div>
    );
  };
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="rounded border border-line-2 bg-ink px-2 py-1 text-soft outline-none">
            {[30, 60, 180, 720, 1440].map((m) => (
              <option key={m} value={m}>
                Last {m < 120 ? `${m} minutes` : `${m / 60} hours`}
              </option>
            ))}
          </select>
          <select
            value={adding}
            onChange={(e) => {
              const k = e.target.value as StreamMetricKey;
              if (k && !shown.includes(k)) setShown([...shown, k]);
              setAdding("");
            }}
            className="rounded border border-line-2 bg-ink px-2 py-1 text-soft outline-none"
          >
            <option value="">Add a metric chart…</option>
            {defs
              .filter((d) => !shown.includes(d.key))
              .map((d) => (
                <option key={d.key} value={d.key}>
                  {d.recommended ? "★ " : ""}
                  {d.label}
                </option>
              ))}
          </select>
          <span className="text-[11px] text-muted">★ recommended for debugging</span>
          <label className="ml-auto flex items-center gap-2 text-soft">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Troubleshoot and Debug mode
          </label>
        </div>
        {!data && <p className="text-xs text-muted">Loading…</p>}
        {expanded ? chart(expanded, 380) : <div className="grid gap-3 xl:grid-cols-2">{shown.map((k) => chart(k, 160))}</div>}
      </div>
      {debug && (
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel p-4 text-xs">
          <div className="mb-2 flex items-center gap-2 font-semibold text-soft">
            <Icon name="bug" className="h-4 w-4 text-ocean" /> Debug a stream outage
          </div>
          <p className="mb-3 text-muted">Work through the steps in order; select a metric tag to highlight its chart.</p>
          {!steps && <p className="text-muted">Checking…</p>}
          <ol className="space-y-2">
            {steps?.map((s, i) => (
              <li key={s.key} className="rounded-md border border-line-2 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-muted">{i + 1}.</span>
                  <Icon name={STEP_STYLE[s.state][1]} className={`h-3.5 w-3.5 ${STEP_STYLE[s.state][0]}`} />
                  <span className="font-medium text-soft">{s.title}</span>
                </div>
                <p className="mt-1 text-muted">{s.detail}</p>
                {s.metric && (
                  <button
                    type="button"
                    onClick={() => {
                      const m = s.metric!;
                      if (!shown.includes(m)) setShown([...shown, m]);
                      setExpanded(null);
                      setHighlight(highlight === m ? null : m);
                    }}
                    className={`mt-1.5 rounded px-1.5 py-0.5 text-[10px] ${highlight === s.metric ? "bg-ocean text-white" : "bg-ocean/15 text-ocean"}`}
                  >
                    {defs.find((d) => d.key === s.metric)?.label ?? s.metric}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}
