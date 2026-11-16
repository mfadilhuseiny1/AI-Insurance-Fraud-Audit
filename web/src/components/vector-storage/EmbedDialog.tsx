"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type Job, type VectorIndex, type VectorIngest } from "@/lib/api";
import { when } from "@/lib/format";

/** Step 1 of embedding from an index: pick completed parse jobs. Step 2 (EmbedDocumentsDialog)
 * sets how they are embedded. */
export function EmbedDialog({
  index,
  ingests,
  onClose,
  onNext,
}: {
  index: VectorIndex;
  ingests: VectorIngest[];
  onClose: () => void;
  onNext: (jobs: Job[]) => void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api
      .jobs()
      .then((all) => setJobs(all.filter((j) => j.status === "completed" && (j.chunks ?? 0) > 0)))
      .catch((e: Error) => setError(e.message));
  }, []);

  const embedded = useMemo(() => new Map(ingests.map((i) => [i.job_id, i])), [ingests]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (jobs ?? []).filter((j) => !q || j.file_name.toLowerCase().includes(q) || j.id.includes(q));
  }, [jobs, filter]);
  const chunks = (jobs ?? []).filter((j) => picked.includes(j.id)).reduce((n, j) => n + (j.chunks ?? 0), 0);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Modal title={`Embed parsed results into ${index.name}`} icon="sparkle" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <p className="text-xs text-soft">
          Each document&apos;s RAG chunks (the same chunks shown in the result viewer) are embedded with{" "}
          <span className="font-mono text-white">{index.model}</span> at {index.dimension} dimensions and stored as one vector
          per chunk. Next you choose chunking, enrichment, tags and automation.
        </p>
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by file name or job id"
            className={`${inputClass} pl-8`}
          />
        </div>

        <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-line">
          {!jobs && !error && <p className="p-4 text-sm text-muted">Loading parse results…</p>}
          {jobs && !shown.length && (
            <p className="p-4 text-sm text-muted">{jobs.length ? "No match." : "No completed parse jobs with chunks yet."}</p>
          )}
          {shown.map((j) => {
            const done = embedded.get(j.id);
            return (
              <label
                key={j.id}
                className="flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-0 hover:bg-panel-2"
              >
                <input type="checkbox" checked={picked.includes(j.id)} onChange={() => toggle(j.id)} className="accent-ocean" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{j.file_name}</span>
                  <span className="font-mono text-[11px] text-muted">
                    {j.id} · {j.tier_label} · pp. {j.page_from}–{j.page_to} · {when(j.created_at)}
                  </span>
                </span>
                {done && (
                  <span
                    className={`shrink-0 rounded px-1.5 py-px text-[10.5px] ${
                      done.status === "completed" ? "bg-ok/15 text-ok" : done.status === "failed" ? "bg-bad/15 text-bad" : "bg-ocean/15 text-ocean"
                    }`}
                  >
                    {done.status === "completed" ? "embedded" : done.status}
                  </span>
                )}
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-soft">{j.chunks} chunks</span>
              </label>
            );
          })}
        </div>
        {error && <p className="text-xs text-bad">{error}</p>}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <span className="text-xs text-muted">
          {picked.length ? `${picked.length} selected · ${chunks.toLocaleString()} chunks` : "Select documents"}
        </span>
        <button type="button" onClick={onClose} className={`${buttonClass.secondary} ml-auto`}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onNext((jobs ?? []).filter((j) => picked.includes(j.id)))}
          disabled={!picked.length}
          className={buttonClass.primary}
        >
          Next: settings <Icon name="right" className="h-3.5 w-3.5" />
        </button>
      </div>
    </Modal>
  );
}
