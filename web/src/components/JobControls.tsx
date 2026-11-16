"use client";

import { useState } from "react";
import { api, type Job } from "@/lib/api";
import { Icon } from "./Icon";
import { buttonClass, Modal } from "./pipeline/Modal";

const small =
  "inline-flex items-center gap-1 rounded-md border border-line-2 px-2 py-1 text-xs text-soft hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Pause / Resume and Finish now for a parse job. Pausing lets chunks already sent to the engine
 * finish; every finished chunk is in the buffer (Files → My Project → Parsed Document → Buffer), so
 * Resume parses only the rest. Finish now ends the job with the pages parsed so far as its result.
 */
export function JobControls({ job, onChanged, compact }: { job: Job; onChanged: (job: Job) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<Job>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const active = job.status === "queued" || job.status === "running";
  if (job.halt && active) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-sand">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-sand/30 border-t-sand" />
        {job.halt === "pause" ? "Pausing" : "Finishing"}: chunks in progress first…
      </span>
    );
  }
  // "stopped": finished with nothing parsed yet (or stopped before Finish now existed); still resumable
  const halted = job.status === "paused" || job.status === "stopped";
  if (!active && !halted) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {active ? (
        <button type="button" className={small} disabled={busy} onClick={() => act(() => api.pauseJob(job.id))} title="Pause: parsed pages stay in the buffer">
          <Icon name="pause" className="h-3.5 w-3.5" /> {!compact && "Pause"}
        </button>
      ) : (
        <button
          type="button"
          className={`${small} border-ocean/50 text-ocean`}
          disabled={busy}
          onClick={() => act(() => api.resumeJob(job.id))}
          title={`Resume: parses the remaining ${job.pages_total - job.pages_done} pages`}
        >
          <Icon name="play" className="h-3.5 w-3.5" /> {!compact && "Resume"}
        </button>
      )}
      <button
        type="button"
        className={small}
        disabled={busy || (halted && !job.pages_done)}
        onClick={() => setFinishing(true)}
        title={halted && !job.pages_done ? "Nothing parsed yet" : "Finish now with the pages parsed so far"}
      >
        <Icon name="check" className="h-3.5 w-3.5" /> {!compact && "Finish now"}
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}

      {finishing && (
        <Modal title={`Finish ${job.file_name} now?`} icon="check" onClose={() => setFinishing(false)}>
          <div className="space-y-2 p-4 text-sm text-soft">
            <p>
              The job completes with the pages parsed so far ({job.pages_done} of {job.pages_total}
              {active ? ", plus chunks already in progress" : ""}); the rest are listed as not parsed. You&apos;re charged for parsed pages
              only.
            </p>
            <p className="text-xs text-muted">
              The parsed pages also stay in the buffer (Files → My Project → Parsed Document → Buffer): running the same parse again
              picks up from there and only parses the rest.
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
            <button type="button" className={buttonClass.secondary} onClick={() => setFinishing(false)}>
              {active ? "Keep parsing" : "Cancel"}
            </button>
            <button
              type="button"
              className={buttonClass.primary}
              onClick={() => {
                setFinishing(false);
                act(() => api.stopJob(job.id, true));
              }}
            >
              <Icon name="check" className="h-3.5 w-3.5" /> Finish now
            </button>
          </div>
        </Modal>
      )}
    </span>
  );
}
