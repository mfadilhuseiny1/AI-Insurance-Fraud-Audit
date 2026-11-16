"use client";

import Link from "next/link";
import { useState } from "react";
import type { AppConfig, FileMeta, Job } from "@/lib/api";
import { usePageChunkBoxes } from "@/lib/chunks";
import { amount, duration, perPage } from "@/lib/format";
import { CodePanel } from "./CodePanel";
import { ConfigPanel, loadSavedSettings, saveSettings, tierBlocker, type ParseSettings } from "./ConfigPanel";
import { Icon } from "./Icon";
import { JobControls } from "./JobControls";
import { PageViewer } from "./PageViewer";
import { ResultsPanel } from "./ResultsPanel";
import { StatusPill } from "./StatusPill";

type Tab = "build" | "results" | "code";
/** "editor" is the page viewer + side panel; "result" shows the parsed document full width */
type MainTab = "editor" | "result";

function initialSettings(config: AppConfig, file: FileMeta, job?: Job): ParseSettings {
  if (job) {
    return {
      tier: job.tier,
      pageFrom: job.page_from,
      pageTo: job.page_to,
      languages: job.languages,
      instructions: job.instructions ?? "",
    };
  }
  const saved = loadSavedSettings();
  const usable = config.tiers.filter((t) => !tierBlocker(t, file.kind));
  // ?tier=<id> (from the tier cards on Home) wins over the last-used tier
  const wanted = new URLSearchParams(window.location.search).get("tier") ?? saved.tier;
  const pick =
    usable.find((t) => t.id === wanted) ?? usable.find((t) => t.id === "agentic") ?? usable[0] ?? config.tiers[0];
  return {
    tier: pick.id,
    pageFrom: 1,
    pageTo: file.pages,
    languages: saved.languages ?? ["ind", "ara"],
    instructions: saved.instructions ?? "",
  };
}

export function Workspace({
  config,
  file,
  job,
  onRun,
  onJobChanged,
}: {
  config: AppConfig;
  file: FileMeta;
  job?: Job;
  onRun: (settings: ParseSettings) => Promise<void>;
  /** after Pause, Resume or Stop */
  onJobChanged?: (job: Job) => void;
}) {
  const [tab, setTab] = useState<Tab>(job ? "results" : "build");
  const [mainTab, setMainTab] = useState<MainTab>("editor");
  const [page, setPage] = useState(job?.page_from ?? 1);
  const [autoJumped, setAutoJumped] = useState(false);

  // when a job completes, open the first page that has content (page 1 is often an image-only cover)
  const contentPages = job?.status === "completed" ? job.content_pages : null;
  if (!autoJumped && contentPages) {
    setAutoJumped(true);
    if (contentPages.length > 0 && !contentPages.includes(page)) setPage(contentPages[0]);
  }
  const [settings, setSettings] = useState<ParseSettings>(() => initialSettings(config, file, job));
  const [editing, setEditing] = useState(!job);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const chunkBoxes = usePageChunkBoxes(job, page);
  const [activeChunk, setActiveChunk] = useState<number | null>(null);
  const selectChunk = (chunk: number) => {
    setTab("results");
    setActiveChunk(chunk);
    document.getElementById(`chunk-${chunk}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const tier = config.tiers.find((t) => t.id === settings.tier) ?? config.tiers[0];
  const blocker = tierBlocker(tier, file.kind);
  const selectedPages = settings.pageTo - settings.pageFrom + 1;
  const estimate = selectedPages * (tier.price_per_page ?? 0);
  const busy = job?.status === "queued" || job?.status === "running";

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      saveSettings(settings);
      await onRun(settings);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
        <Link href="/parse" className="text-muted hover:text-white">
          Parse
        </Link>
        {job && (
          <>
            <Icon name="right" className="h-3.5 w-3.5 text-muted" />
            <span className="font-mono text-soft">{job.id}</span>
          </>
        )}
        <span className="truncate text-muted">· {file.name}</span>
        {job && (
          <div className="ml-2 flex shrink-0 rounded-lg border border-line bg-ink p-0.5">
            {(
              [
                ["editor", "Editor", "sliders"],
                ["result", "Result", "doc"],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                disabled={id === "result" && job.status !== "completed"}
                title={id === "result" && job.status !== "completed" ? "Available when the parse completes" : undefined}
                onClick={() => setMainTab(id)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs disabled:opacity-30 ${
                  mainTab === id ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"
                }`}
              >
                <Icon name={icon} className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          {job && <StatusPill job={job} />}
          <Link
            href="/parse"
            className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-soft hover:text-white"
          >
            <Icon name="upload" className="h-3.5 w-3.5" /> New file
          </Link>
        </div>
      </header>

      {mainTab === "result" && job?.status === "completed" ? (
        <section className="flex min-h-0 flex-1 flex-col bg-panel">
          <ResultsPanel job={job} page={page} onPage={setPage} />
        </section>
      ) : (
        <div className="flex min-h-0 flex-1">
          <PageViewer
            file={file}
            page={page}
            onPage={setPage}
            chunks={
              job?.status === "completed"
                ? { boxes: chunkBoxes, active: activeChunk, onActive: setActiveChunk, onSelect: selectChunk }
                : undefined
            }
          />

          <section className="flex w-[46%] min-w-[460px] max-w-[760px] flex-col bg-panel">
            <div className="flex h-11 shrink-0 items-end gap-1 border-b border-line px-3">
              {(
                [
                  ["build", "Build", "sliders"],
                  ["results", "Results", "doc"],
                  ["code", "Code", "code"],
                ] as const
              ).map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  disabled={id === "results" && !job}
                  onClick={() => setTab(id)}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm disabled:opacity-30 ${
                    tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"
                  }`}
                >
                  <Icon name={icon} className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {tab === "build" && (
                <ConfigPanel
                  config={config}
                  pages={file.pages}
                  fileKind={file.kind}
                  value={settings}
                  onChange={(next) => {
                    // changing any setting on a finished job starts a new run
                    setSettings(next);
                    setEditing(true);
                  }}
                  readOnly={busy}
                />
              )}
              {tab === "results" && job && (
                <>
                  {job.status === "completed" ? (
                    <ResultsPanel
                      job={job}
                      page={page}
                      onPage={setPage}
                      activeChunk={activeChunk}
                      onActiveChunk={setActiveChunk}
                    />
                  ) : (
                    <JobProgress job={job} onChanged={onJobChanged} />
                  )}
                </>
              )}
              {tab === "code" && <CodePanel config={config} settings={settings} fileName={file.name} />}
            </div>

            <footer className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-3">
              <div className="mr-auto">
                {job && !editing ? (
                  <>
                    <div className="text-xs text-muted">{busy ? "Charged so far" : "Charged"}</div>
                    <div className="text-lg font-semibold tabular-nums">
                      {amount(job.price)}
                      <span className="ml-2 text-xs font-normal text-muted">
                        {job.pages_done} pages · {job.tier_label} · {perPage(job.price_per_page)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-xs text-muted">Estimated price</div>
                    <div className="text-lg font-semibold tabular-nums">
                      {blocker ? "–" : amount(estimate)}
                      <span className="ml-2 text-xs font-normal text-muted">
                        {selectedPages} pages · {tier.label} · {blocker ?? perPage(tier.price_per_page)}
                      </span>
                    </div>
                  </>
                )}
                {error && <div className="mt-1 text-xs text-bad">{error}</div>}
              </div>

              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      saveSettings(settings);
                      setSaved(true);
                      setTimeout(() => setSaved(false), 1500);
                    }}
                    className="rounded-md px-3 py-2 text-sm text-soft hover:text-white"
                  >
                    {saved ? "Saved" : "Save config"}
                  </button>
                  {job && (
                    <button
                      type="button"
                      onClick={() => {
                        setSettings(initialSettings(config, file, job));
                        setEditing(false);
                      }}
                      className="rounded-md px-3 py-2 text-sm text-soft hover:text-white"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={run}
                    disabled={running || blocker !== null}
                    className="flex items-center gap-2 rounded-md bg-ocean px-4 py-2 text-sm font-medium text-white hover:bg-ocean-deep disabled:opacity-50"
                  >
                    <Icon name="play" className="h-3.5 w-3.5" /> {running ? "Starting…" : job ? "Run again" : "Run Parse"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setTab("build");
                  }}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-md border border-line-2 px-4 py-2 text-sm text-soft hover:text-white disabled:opacity-40"
                >
                  <Icon name="refresh" className="h-3.5 w-3.5" /> Run again
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function JobProgress({ job, onChanged }: { job: Job; onChanged?: (job: Job) => void }) {
  const fraction = job.pages_total ? job.pages_done / job.pages_total : 0;
  if (job.status === "failed") {
    return (
      <div className="m-5 rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm">
        <div className="mb-1 flex items-center gap-2 font-semibold text-bad">
          <Icon name="alert" /> Parse failed
        </div>
        <p className="text-soft">{job.error}</p>
      </div>
    );
  }
  return (
    <div className="m-5 rounded-xl border border-line bg-panel-2 p-5">
      <div className="mb-3 flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">
          {job.halt === "pause"
            ? "Pausing…"
            : job.halt === "stop"
              ? "Finishing…"
              : job.status === "queued"
                ? "Waiting in queue…"
                : job.status === "paused"
                  ? "Paused"
                  : job.status === "stopped"
                    ? "Stopped"
                    : "Parsing…"}
        </span>
        <span className="tabular-nums text-muted">
          {job.pages_done} / {job.pages_total} pages
          {(job.status === "running" || job.status === "queued") && ` · ${duration(job.started_at, null)}`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full transition-all ${
            job.status === "paused" || job.status === "stopped" ? "bg-sand/60" : "bg-gradient-to-r from-ocean to-sand"
          }`}
          style={{ width: `${Math.max(2, fraction * 100)}%` }}
        />
      </div>
      {onChanged && (
        <div className="mt-3">
          <JobControls job={job} onChanged={onChanged} />
        </div>
      )}
      <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <Stat label="Tier" value={job.tier_label} />
        <Stat label="Charged so far" value={amount(job.price)} />
        <Stat label="Elements" value={String(job.elements)} />
      </div>
      <p className="mt-4 text-xs text-muted">
        {job.status === "paused" || job.status === "stopped"
          ? "The parsed pages are kept in the buffer (Files → My Project → Parsed Document → Buffer). Resume parses only the rest."
          : "Pages are processed in batches of 10; progress updates after each batch, and each finished batch is kept in the buffer, so Pause or Stop loses nothing. You can leave this page — the job keeps running and appears in History."}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="truncate font-semibold" title={value}>
        {value}
      </div>
    </div>
  );
}
