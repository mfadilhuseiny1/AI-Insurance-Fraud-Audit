"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { GraphDialog } from "@/components/kg/GraphDialog";
import { GraphExplorer } from "@/components/kg/GraphExplorer";
import { KgStatusPill, ProgressBar, usePolling } from "@/components/kg/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { kg, kgDownloadUrl, STAGE_LABEL, type KgGraph, type KnowledgeGraph } from "@/lib/kg";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

export default function KnowledgeGraphPage() {
  const { id } = useParams<{ id: string }>();
  const [rec, setRec] = useState<KnowledgeGraph | null>(null);
  const [graph, setGraph] = useState<KgGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    kg.graph(id)
      .then((r) => {
        setRec(r);
        if (r.status === "completed") kg.graphData(id).then(setGraph);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  usePolling(load, rec?.status === "queued" || rec?.status === "running", 2000);

  const sourceNames = useMemo(
    () => Object.fromEntries((graph?.meta.extractions ?? []).map((e) => [e.id, e.name])),
    [graph],
  );

  /** Run an action that returns the updated record; errors are shown, not swallowed. */
  const act = async (fn: (id: string) => Promise<KnowledgeGraph>) => {
    if (!rec) return;
    try {
      setRec(await fn(rec.id));
    } catch (err) {
      void alertDialog((err as Error).message);
    }
  };
  const rebuild = () => act(kg.rebuildGraph);
  const resume = () => act(kg.continueGraph);
  const stop = async () => {
    if ((await confirmDialog("Stop building this knowledge graph? Finished AI resolution batches are kept for Continue."))) act(kg.stopGraph);
  };

  if (error) return <ApiError message={error} />;
  if (!rec) return <Loading />;
  const building = rec.status === "queued" || rec.status === "running";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
        <Link href="/knowledge-graph" className="text-muted hover:text-white">
          Knowledge Graph
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <span className="truncate font-medium">{rec.name}</span>
        <KgStatusPill status={rec.status} label={rec.status === "running" ? STAGE_LABEL[rec.stage] : undefined} />
        {graph && (
          <span className="hidden truncate text-xs text-muted lg:inline">
            {graph.meta.extractions?.map((e) => e.name).join(" · ")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {rec.status === "completed" && (
            <>
              <a href={kgDownloadUrl("graphs", rec.id, "json")} className={buttonClass.secondary}>
                <Icon name="download" className="h-3.5 w-3.5" /> JSON
              </a>
              <a href={kgDownloadUrl("graphs", rec.id, "ttl")} className={buttonClass.secondary} title="OWL / RDF Turtle">
                <Icon name="download" className="h-3.5 w-3.5" /> Turtle
              </a>
            </>
          )}
          {building && (
            <button type="button" onClick={stop} disabled={rec.stage === "stopping"} className={buttonClass.secondary}>
              <Icon name="stop" className="h-3.5 w-3.5" /> {rec.stage === "stopping" ? "Stopping…" : "Stop"}
            </button>
          )}
          {(rec.status === "cancelled" || rec.status === "failed") && (
            <button type="button" onClick={resume} className={buttonClass.primary}>
              <Icon name="play" className="h-3.5 w-3.5" /> Continue
            </button>
          )}
          <button type="button" disabled={building} onClick={() => setEditing(true)} className={buttonClass.secondary}>
            <Icon name="edit" className="h-3.5 w-3.5" /> Edit sources
          </button>
          <button type="button" disabled={building} onClick={rebuild} className={buttonClass.ghost} title="Rebuild from the current extractions">
            <Icon name="refresh" className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {building || rec.status === "failed" || rec.status === "cancelled" || !graph ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-md rounded-xl border border-line bg-panel p-6">
            {rec.status === "cancelled" ? (
              <>
                <div className="mb-2 flex items-center gap-2 font-semibold text-warn">
                  <Icon name="stop" /> Build stopped
                </div>
                <p className="text-sm text-soft">
                  Continue picks up where it left off: AI resolution batches already done are reused.
                </p>
                <button type="button" onClick={resume} className={`${buttonClass.primary} mt-4`}>
                  <Icon name="play" className="h-3.5 w-3.5" /> Continue
                </button>
              </>
            ) : rec.status === "failed" ? (
              <>
                <div className="mb-2 flex items-center gap-2 font-semibold text-bad">
                  <Icon name="alert" /> Build failed
                </div>
                <p className="text-sm text-soft">{rec.error}</p>
                <button type="button" onClick={resume} className={`${buttonClass.primary} mt-4`}>
                  <Icon name="play" className="h-3.5 w-3.5" /> Continue
                </button>
              </>
            ) : building ? (
              <>
                <div className="mb-3 font-semibold">
                  {STAGE_LABEL[rec.stage] ?? "Building"} {rec.extraction_ids.length} extractions…
                </div>
                <ProgressBar value={rec.progress ? 0.1 + (0.85 * rec.progress[0]) / rec.progress[1] : rec.stage === "merging" ? 0.08 : 0.02} />
                {rec.progress && (
                  <div className="mt-1 text-xs text-muted tabular-nums">
                    batch {rec.progress[0]} of {rec.progress[1]}
                  </div>
                )}
              </>
            ) : (
              <Loading label="Loading graph…" />
            )}
          </div>
        </div>
      ) : (
        <GraphExplorer key={graph.meta.generatedAt} graph={graph} sourceNames={sourceNames} />
      )}

      {editing && (
        <GraphDialog
          graph={rec}
          onClose={() => setEditing(false)}
          onSaved={(g) => {
            setEditing(false);
            setRec(g);
            if (g.status === "completed") load();
          }}
        />
      )}
    </div>
  );
}
