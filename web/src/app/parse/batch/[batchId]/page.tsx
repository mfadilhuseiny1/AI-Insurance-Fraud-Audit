"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { JobControls } from "@/components/JobControls";
import { ApiError, Loading } from "@/components/States";
import { StatusPill } from "@/components/StatusPill";
import { api, type Batch } from "@/lib/api";
import { amount, when } from "@/lib/format";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

const action = "inline-flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-sm text-soft hover:text-white disabled:opacity-40";

/** One batch: every file's job with its progress, and Pause / Resume / Finish now for all of them. */
export default function BatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .batch(batchId)
        .then(setBatch)
        .catch((e: Error) => setError(e.message)),
    [batchId],
  );

  const active = !!batch && batch.totals.active > 0;
  useEffect(() => {
    load();
    const t = setInterval(load, active ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, active]);

  if (error) return <ApiError message={error} />;
  if (!batch) return <Loading />;

  const t = batch.totals;
  const fraction = t.pages_total ? t.pages_done / t.pages_total : 0;
  const all = async (what: "pause" | "resume" | "finish") => {
    if (what === "finish" && !(await confirmDialog(`Finish every unfinished file now with the pages parsed so far? Pages not reached are listed as not parsed.`))) return;
    setBusy(true);
    try {
      setBatch(await api.batchAction(batch.id, what));
    } catch (e) {
      void alertDialog((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="flex h-14 items-center gap-2 border-b border-line bg-panel px-5 text-sm">
        <Link href="/parse" className="text-soft hover:text-white">
          Parse
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <span className="truncate">{batch.name}</span>
      </header>

      <div className="space-y-4 p-6">
        <div className="rounded-xl border border-line bg-panel p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">{batch.name}</h1>
              <p className="text-xs text-muted">
                {batch.tier_label} · started {when(batch.created_at)} · <span className="font-mono">{batch.id}</span>
              </p>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <button type="button" className={action} disabled={busy || !t.active} onClick={() => all("pause")}>
                <Icon name="pause" className="h-3.5 w-3.5" /> Pause all
              </button>
              <button type="button" className={action} disabled={busy || !t.paused} onClick={() => all("resume")}>
                <Icon name="play" className="h-3.5 w-3.5" /> Resume all
              </button>
              <button type="button" className={action} disabled={busy || !(t.active + t.paused)} onClick={() => all("finish")}>
                <Icon name="check" className="h-3.5 w-3.5" /> Finish all now
              </button>
            </div>
          </div>

          <div className="mt-4 h-2 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-gradient-to-r from-ocean to-sand transition-all" style={{ width: `${Math.max(1, fraction * 100)}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <Stat label="Files done" value={`${t.completed} / ${t.files}`} />
            <Stat label="Pages" value={`${t.pages_done.toLocaleString()} / ${t.pages_total.toLocaleString()}`} />
            <Stat label="In progress" value={String(t.active)} />
            <Stat label="Paused" value={String(t.paused)} warn={t.paused > 0} />
            <Stat label="Charged so far" value={`${amount(t.price)} of ~${amount(t.estimated_price)}`} />
          </div>
          {t.failed > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-bad">
              <Icon name="alert" className="h-3.5 w-3.5" /> {t.failed} file{t.failed === 1 ? "" : "s"} failed. Run them again from the job page;
              finished pages are reused from the buffer.
            </p>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs text-muted">
              <tr>
                {["File", "Status", "Progress", "Price", ""].map((h) => (
                  <th key={h} className="px-4 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batch.jobs.map((j) => {
                const f = j.pages_total ? j.pages_done / j.pages_total : 0;
                return (
                  <tr key={j.id} className="border-t border-line align-middle hover:bg-panel/60">
                    <td className="max-w-sm px-4 py-2.5">
                      <Link href={`/parse/${j.id}`} className="block truncate hover:text-ocean" title={j.file_name}>
                        {j.file_name}
                      </Link>
                      <span className="font-mono text-[11px] text-muted">{j.id}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <StatusPill job={j} />
                    </td>
                    <td className="w-64 px-4 py-2.5">
                      <div className="h-1.5 overflow-hidden rounded-full bg-line">
                        <div
                          className={`h-full rounded-full ${j.status === "completed" ? "bg-ok" : j.status === "failed" ? "bg-bad" : j.status === "paused" || j.status === "stopped" ? "bg-sand/60" : "bg-ocean"}`}
                          style={{ width: `${Math.max(1, f * 100)}%` }}
                        />
                      </div>
                      <div className="mt-1 text-[11px] tabular-nums text-muted">
                        {j.pages_done} / {j.pages_total} pages
                        {j.partial && ` · ${j.pages_not_parsed.length} not parsed`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-soft">{amount(j.price)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {j.status === "completed" ? (
                        <Link href={`/parse/${j.id}/result`} className="text-xs text-ocean hover:underline">
                          Open result
                        </Link>
                      ) : (
                        <JobControls job={j} compact onChanged={load} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`truncate font-semibold tabular-nums ${warn ? "text-sand" : ""}`} title={value}>
        {value}
      </div>
    </div>
  );
}
