"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { DataPreview } from "@/components/pipeline/DataPreview";
import { curlFor, useStreamRecords } from "@/components/pipeline/Streams";
import { runtime, type StreamInfo } from "@/lib/runtime";

/** Stream preview: the records of a stream as they arrive, and how to push more. */
export default function StreamPage() {
  const { streamId } = useParams<{ streamId: string }>();
  const [info, setInfo] = useState<StreamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const records = useStreamRecords(streamId);
  useEffect(() => {
    runtime.stream(streamId).then(setInfo, (e: Error) => setError(e.message));
  }, [streamId]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-5 text-sm">
        <Link href="/pipeline" className="text-muted hover:text-white">
          Pipeline Builder
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <Icon name="wave" className="h-4 w-4 text-ocean" />
        <span className="font-medium">{info?.name ?? streamId}</span>
        <span className="text-xs text-muted">{records ? `${records.table.rows.length.toLocaleString()} records · live` : "…"}</span>
      </header>
      {error && <p className="p-5 text-sm text-bad">{error}</p>}
      {info && (
        <div className="border-b border-line p-4 text-xs">
          <div className="mb-1 font-medium text-soft">Push records (curl)</div>
          <pre className="overflow-x-auto rounded-md bg-ink p-2 font-mono text-[11px] text-soft">{curlFor(info)}</pre>
          {!info.can_push && <p className="mt-1 text-muted">Only those who may change this stream (Editors of its Project) see its push token.</p>}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {records?.table.rows.length ? <DataPreview table={records.table} title="Stream records (newest last)" /> : <p className="p-6 text-center text-sm text-muted">No records yet. The streaming job writes here as records arrive.</p>}
      </div>
    </div>
  );
}
