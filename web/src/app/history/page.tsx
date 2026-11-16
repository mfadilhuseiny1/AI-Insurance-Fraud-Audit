"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { JobControls } from "@/components/JobControls";
import { RESULT_FORMATS as FORMATS, SaveToFiles } from "@/components/SaveToFiles";
import { ApiError } from "@/components/States";
import { buttonClass } from "@/components/pipeline/Modal";
import { api, downloadUrl, type Job } from "@/lib/api";
import { amount, duration, pageRanges, perPage } from "@/lib/format";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

export default function HistoryPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .jobs()
      .then(setJobs)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !jobs) return <ApiError message={error} />;

  const remove = async (job: Job) => {
    if (!(await confirmDialog(`Delete the results of ${job.file_name} (${job.id})?`))) return;
    try {
      await api.deleteJob(job.id);
      load();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };

  return (
    <AppHome
      app="History"
      icon="history"
      accent="#64748b"
      href="/history"
      tagline="Every parse job: its pages, status, cost and results to download or save to Files."
      description={<>Each job parses a page range of one file at a tier. Running jobs can be paused, resumed or finished early; completed jobs download as JSON, Markdown or text, or save into a folder in Files.</>}
      noun={["parse job", "parse jobs"]}
      error={error}
      items={
        jobs?.map((j) => ({
          id: j.id,
          href: `/parse/${j.id}`,
          title: j.file_name,
          updated_at: j.created_at,
          icon: "doc" as const,
          badges: [
            { label: statusLabel(j), tone: STATUS_TONE[j.status] },
            { label: j.tier_label, tone: "muted" as const },
            ...(j.pages_not_parsed.length ? [{ label: `${j.pages_not_parsed.length} not parsed (${pageRanges(j.pages_not_parsed)})`, tone: "bad" as const }] : []),
          ],
          meta: amount(j.price),
          detail: `Pages ${j.page_from}–${j.page_to} of ${j.pages_total} · ${perPage(j.price_per_page)} per page · ${duration(j.started_at, j.finished_at)} · ${j.id}`,
          actions: (
            <>
              <JobControls job={j} compact onChanged={load} />
              <button
                type="button"
                onClick={() => remove(j)}
                disabled={j.status === "queued" || j.status === "running"}
                title="Delete"
                className="rounded p-1.5 text-muted hover:bg-bad/10 hover:text-bad disabled:opacity-30"
              >
                <Icon name="trash" />
              </button>
            </>
          ),
          footer:
            j.status === "completed" ? (
              <div className="flex items-center gap-1">
                {FORMATS.map((f) => (
                  <a
                    key={f.id}
                    href={downloadUrl(j.id, f.id)}
                    title={`Download ${f.label}`}
                    className="rounded border border-line-2 px-1.5 py-0.5 text-[11px] font-medium text-soft hover:border-ocean hover:text-ocean"
                  >
                    {f.label}
                  </a>
                ))}
                <span className="ml-1">
                  <SaveToFiles iconOnly title={`Save results of ${j.file_name} to Files`} formats={FORMATS} save={(formats, parentId) => api.saveToFiles(j.id, formats, parentId)} />
                </span>
              </div>
            ) : undefined,
        })) ?? null
      }
      stats={[
        { label: "Jobs", value: (jobs?.length ?? 0).toLocaleString() },
        { label: "Running", value: (jobs ?? []).filter((j) => j.status === "running" || j.status === "queued").length.toLocaleString() },
        { label: "Pages parsed", value: (jobs ?? []).reduce((n, j) => n + j.pages_done, 0).toLocaleString() },
        { label: "Spent", value: amount((jobs ?? []).reduce((n, j) => n + j.price, 0)) },
      ]}
      empty={{ title: "No parse jobs yet", hint: "Parse a file: its job, pages, cost and results appear here.", steps: ["Upload or pick a file", "Choose the pages and tier", "Download or save the results"] }}
      create={
        <Link href="/parse" className={buttonClass.primary}>
          <Icon name="parse" className="h-3.5 w-3.5" /> Parse a file
        </Link>
      }
    />
  );
}

const STATUS_TONE: Record<Job["status"], "ocean" | "ok" | "warn" | "bad" | "sand" | "muted"> = {
  queued: "muted",
  running: "ocean",
  paused: "sand",
  stopped: "muted",
  completed: "ok",
  failed: "bad",
};

/** the status as the History table's pill read it */
function statusLabel(job: Job): string {
  const halting = job.halt && (job.status === "running" || job.status === "queued");
  if (halting) return `${job.halt === "pause" ? "Pausing" : "Finishing"} ${job.pages_done}/${job.pages_total}`;
  if (job.status === "running") return `Running ${job.pages_done}/${job.pages_total}`;
  if (job.status === "paused" || job.status === "stopped") return `${job.status === "paused" ? "Paused" : "Stopped"} ${job.pages_done}/${job.pages_total}`;
  if (job.status === "completed" && job.partial) return "Completed (partial)";
  return job.status[0].toUpperCase() + job.status.slice(1);
}
