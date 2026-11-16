"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { GraphExplorer } from "@/components/kg/GraphExplorer";
import { KgStatusPill, ProgressBar, usePolling } from "@/components/kg/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { SaveToFiles } from "@/components/SaveToFiles";
import { ApiError, Loading } from "@/components/States";
import { duration } from "@/lib/format";
import { extractionProgress, kg, kgDownloadUrl, kgMarkdownUrl, STAGE_LABEL, type Extraction, type KgGraph } from "@/lib/kg";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";

const GRAPH_FORMATS: { id: "json" | "ttl"; label: string }[] = [
  { id: "json", label: "JSON" },
  { id: "ttl", label: "Turtle" },
];

export default function ExtractionPage() {
  const { id } = useParams<{ id: string }>();
  const [rec, setRec] = useState<Extraction | null>(null);
  const [graph, setGraph] = useState<KgGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    kg.extraction(id)
      .then((r) => {
        setRec(r);
        if (r.status === "completed") kg.extractionGraph(id).then(setGraph);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  usePolling(load, rec?.status === "queued" || rec?.status === "running", 2500);

  const rename = async () => {
    const name = (await promptDialog("Rename extraction", rec?.name))?.trim();
    if (name && rec) setRec(await kg.renameExtraction(rec.id, name));
  };

  const rerun = async () => {
    if (!rec || !(await confirmDialog("Run this extraction again from scratch? Saved parts are discarded and the current graph is replaced when it finishes.")))
      return;
    setRec(await kg.rerunExtraction(rec.id));
  };

  const resume = async () => {
    if (!rec) return;
    try {
      setRec(await kg.continueExtraction(rec.id));
    } catch (err) {
      void alertDialog((err as Error).message);
    }
  };

  const stop = async () => {
    if (!rec || !(await confirmDialog("Stop this extraction? Tokens already used are kept in the cost; you can run it again later."))) return;
    try {
      setRec(await kg.stopExtraction(rec.id));
    } catch (err) {
      void alertDialog((err as Error).message);
    }
  };

  if (error) return <ApiError message={error} />;
  if (!rec) return <Loading />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
        <Link href="/extraction" className="text-muted hover:text-white">
          Extraction
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <button type="button" onClick={rename} className="group flex min-w-0 items-center gap-1.5 font-medium" title="Rename">
          <span className="truncate">{rec.name}</span>
          <Icon name="pencil" className="h-3.5 w-3.5 text-muted opacity-0 group-hover:opacity-100" />
        </button>
        <KgStatusPill status={rec.status} label={rec.status === "running" ? STAGE_LABEL[rec.stage] : undefined} />
        <span className="hidden truncate text-xs text-muted lg:inline">
          {rec.model_label} · {rec.source.name}
          {rec.source_format && ` · ${rec.source_format}`}
          {rec.finished_at && ` · ${duration(rec.started_at, rec.finished_at)}`}
          {rec.windows_failed > 0 && ` · ${rec.windows_failed} of ${rec.windows_total} parts failed`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {rec.source_format && (
            <a
              href={kgMarkdownUrl(rec.id)}
              target="_blank"
              rel="noreferrer"
              className={buttonClass.ghost}
              title={`The Markdown the model read (${rec.source_format})`}
            >
              <Icon name="doc" className="h-3.5 w-3.5" /> Markdown
            </a>
          )}
          {rec.status === "completed" && (
            <>
              <a href={kgDownloadUrl("extractions", rec.id, "json")} className={buttonClass.secondary}>
                <Icon name="download" className="h-3.5 w-3.5" /> JSON
              </a>
              <a href={kgDownloadUrl("extractions", rec.id, "ttl")} className={buttonClass.secondary} title="OWL / RDF Turtle">
                <Icon name="download" className="h-3.5 w-3.5" /> Turtle
              </a>
              <SaveToFiles
                title={`Save the graph of ${rec.name} to Files`}
                formats={GRAPH_FORMATS}
                save={(formats, parentId) => kg.saveExtractionToFiles(rec.id, formats, parentId)}
                className={buttonClass.secondary}
              />
            </>
          )}
          {(rec.status === "running" || rec.status === "queued") && (
            <button type="button" onClick={stop} disabled={rec.stage === "stopping"} className={buttonClass.secondary}>
              <Icon name="stop" className="h-3.5 w-3.5" /> {rec.stage === "stopping" ? "Stopping…" : "Stop"}
            </button>
          )}
          {(rec.status === "failed" || rec.status === "cancelled") && (
            <button type="button" onClick={resume} className={buttonClass.primary}>
              <Icon name="play" className="h-3.5 w-3.5" /> Continue
            </button>
          )}
          {rec.status === "completed" && rec.windows_failed > 0 && (
            <button
              type="button"
              onClick={resume}
              className={buttonClass.secondary}
              title="Read the parts that failed again; finished parts are reused"
            >
              <Icon name="play" className="h-3.5 w-3.5" /> Retry {rec.windows_failed} failed part{rec.windows_failed > 1 ? "s" : ""}
            </button>
          )}
          {(rec.status === "completed" || rec.status === "failed" || rec.status === "cancelled") && (
            <button type="button" onClick={rerun} className={buttonClass.ghost} title="Run again from scratch">
              <Icon name="refresh" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      {rec.status === "completed" ? (
        graph ? (
          <GraphExplorer graph={graph} />
        ) : (
          <Loading label="Loading graph…" />
        )
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-md rounded-xl border border-line bg-panel p-6">
            {rec.status === "cancelled" ? (
              <>
                <div className="mb-2 flex items-center gap-2 font-semibold text-warn">
                  <Icon name="stop" /> Extraction stopped
                </div>
                <p className="text-sm text-soft">
                  Stopped{rec.windows_total ? ` at part ${rec.windows_done} of ${rec.windows_total}` : ""}. Continue picks up where
                  it left off: finished parts are kept and only the rest is extracted.
                </p>
                <div className="mt-4 flex gap-2">
                  <button type="button" onClick={resume} className={buttonClass.primary}>
                    <Icon name="play" className="h-3.5 w-3.5" /> Continue
                  </button>
                  <button type="button" onClick={rerun} className={buttonClass.secondary}>
                    <Icon name="refresh" className="h-3.5 w-3.5" /> Start over
                  </button>
                </div>
              </>
            ) : rec.status === "failed" ? (
              <>
                <div className="mb-2 flex items-center gap-2 font-semibold text-bad">
                  <Icon name="alert" /> Extraction failed
                </div>
                <p className="text-sm text-soft">{rec.error}</p>
                <div className="mt-4 flex gap-2">
                  <button type="button" onClick={resume} className={buttonClass.primary}>
                    <Icon name="play" className="h-3.5 w-3.5" /> Continue
                  </button>
                  <button type="button" onClick={rerun} className={buttonClass.secondary}>
                    <Icon name="refresh" className="h-3.5 w-3.5" /> Start over
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-3 font-semibold">{STAGE_LABEL[rec.stage]}…</div>
                <ProgressBar value={extractionProgress(rec)} />
                <ol className="mt-4 space-y-1.5 text-sm">
                  {(["converting", "schema", "extracting", "merging", "deduplicating"] as const)
                    .filter((s) => (s !== "schema" || !rec.schema_from) && (s !== "deduplicating" || rec.dedupe))
                    .map((s) => {
                      const order = ["queued", "reading", "converting", "schema", "extracting", "merging", "deduplicating", "done"];
                      const state = order.indexOf(rec.stage) > order.indexOf(s) ? "done" : rec.stage === s ? "now" : "todo";
                      return (
                        <li key={s} className={`flex items-center gap-2 ${state === "todo" ? "text-muted" : ""}`}>
                          {state === "done" ? (
                            <Icon name="check" className="h-4 w-4 text-ok" />
                          ) : state === "now" ? (
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-ocean" />
                          ) : (
                            <span className="h-4 w-4 rounded-full border-2 border-line-2" />
                          )}
                          {STAGE_LABEL[s]}
                          {s === "schema" && rec.schema_summary && (
                            <span className="text-xs text-muted">
                              {rec.schema_summary.classes} classes, {rec.schema_summary.properties} properties
                            </span>
                          )}
                          {s === "extracting" && rec.windows_total > 0 && (
                            <span className="text-xs text-muted tabular-nums">
                              {rec.windows_done}/{rec.windows_total}
                            </span>
                          )}
                        </li>
                      );
                    })}
                </ol>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
