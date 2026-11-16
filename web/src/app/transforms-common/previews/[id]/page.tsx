"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { DatasetView, EnvironmentTable, FileView } from "@/components/transforms/CommonParts";
import { when } from "@/lib/format";
import { transformsCommon, type StoredPreview } from "@/lib/transformsCommon";

/** A computed dataset preview (datasetPreview): only the user who ran it can open it, for 24 hours. */
export default function DatasetPreviewResultPage() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<StoredPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  useEffect(() => {
    transformsCommon.storedPreview(id).then(setP, (e: Error) => setError(e.message));
  }, [id]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <Link href="/transforms-common" className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name="sliders" className="h-4 w-4" />
          </span>
          Dataset preview
        </Link>
        {p && (
          <>
            <span className="text-xs text-muted">/</span>
            <span className="truncate font-mono text-sm text-soft">{p.transform_id}</span>
            <span className="rounded-full border border-line-2 bg-panel-2 px-2 py-0.5 text-[10px] text-muted">
              {p.repo_name} · {p.branch}
            </span>
            <span className="ml-auto text-[11px] text-muted">
              Computed {when(p.created_at)} · expires {when(p.expires_at)} · only you can open it
            </span>
          </>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          {error && <p className="rounded-xl border border-bad/30 bg-bad/10 p-4 text-sm text-bad">{error}</p>}
          {!p && !error && <p className="text-sm text-muted">Loading…</p>}
          {p && !p.ok && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-bad/30 bg-bad/10 p-4 font-mono text-xs text-bad">{p.error}</pre>}
          {p && p.datasets.length > 0 && (
            <>
              <div className="flex gap-1 border-b border-line text-xs">
                {p.datasets.map((d, i) => (
                  <button key={d.alias} type="button" onClick={() => setTab(i)} className={`px-3 py-2 ${tab === i ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
                    {d.alias}
                    <span className="ml-1.5 text-muted">{d.name}</span>
                  </button>
                ))}
              </div>
              {p.datasets[tab] && <DatasetView d={p.datasets[tab]} />}
            </>
          )}
          {p?.input_files.map((f) => <FileView key={`i:${f.alias}:${f.path}`} f={f} direction="input" />)}
          {p?.output_files.map((f) => <FileView key={`o:${f.alias}:${f.path}`} f={f} direction="output" />)}
          {p && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-line bg-panel p-4">
                <div className="mb-2 text-xs font-semibold">Environment</div>
                <EnvironmentTable env={p.environment} />
              </div>
              <div className="rounded-xl border border-line bg-panel p-4">
                <div className="mb-2 text-xs font-semibold">Logs</div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{p.logs || "No output."}</pre>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
