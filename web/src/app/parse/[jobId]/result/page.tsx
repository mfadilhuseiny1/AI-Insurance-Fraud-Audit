"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ResultsPanel } from "@/components/ResultsPanel";
import { ApiError, Loading } from "@/components/States";
import { StatusPill } from "@/components/StatusPill";
import { api, type FileMeta, type Job } from "@/lib/api";

/** The parsed result on its own, full width — opened in a new tab from the workspace. */
export default function ResultPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [file, setFile] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?page=N opens a specific page; otherwise the first page with content
  const [page, setPage] = useState<number | null>(() => {
    const p = typeof window === "undefined" ? null : Number(new URLSearchParams(window.location.search).get("page"));
    return p && Number.isInteger(p) && p > 0 ? p : null;
  });

  // poll the job until it finishes, in case the tab is opened while it is still running
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api.job(jobId);
        if (stop) return;
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer = setTimeout(tick, 2000);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  const fileId = job?.file_id;
  useEffect(() => {
    if (fileId) api.file(fileId).then(setFile).catch(() => {}); // only used for the title
  }, [fileId]);

  useEffect(() => {
    document.title = `${file?.name ?? jobId} · Results · BluesandAI Parse`;
  }, [file, jobId]);

  if (error) return <ApiError message={error} />;
  if (!job) return <Loading />;

  const shown = page ?? job.content_pages?.[0] ?? job.page_from;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
        <Link href={`/parse/${job.id}`} className="text-muted hover:text-white">
          {job.id}
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <span className="text-soft">Results</span>
        {file && <span className="truncate text-muted">· {file.name}</span>}
        <div className="ml-auto">
          <StatusPill job={job} />
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col bg-panel">
        {job.status === "completed" ? (
          <ResultsPanel job={job} page={shown} onPage={setPage} standalone />
        ) : job.status === "failed" ? (
          <div className="m-5 rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm">
            <div className="mb-1 flex items-center gap-2 font-semibold text-bad">
              <Icon name="alert" /> Parse failed
            </div>
            <p className="text-soft">{job.error}</p>
          </div>
        ) : (
          <Loading label={`Parsing… ${job.pages_done} / ${job.pages_total} pages`} />
        )}
      </section>
    </div>
  );
}
