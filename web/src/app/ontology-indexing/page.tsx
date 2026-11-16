"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { InvalidValuesTable, type InvalidValuesReport } from "@/components/ontology/Datasources";
import { AppHeader, Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { request } from "@/lib/ontology";

type Step = { name: string; status: string; detail: string; ms?: number };
type Run = {
  id: string;
  at: string;
  trigger: string;
  status: "succeeded" | "failed";
  pipeline: "live" | "replacement";
  mode: "incremental" | "full";
  rows?: number;
  added?: number;
  modified?: number;
  removed?: number;
  edits_merged?: number;
  objects?: number;
  ms?: number;
  error?: string;
  warnings?: { message: string; count: number }[];
  /** Values the properties do not allow: indexed as null (mode null) or the reason the run failed (mode fail). */
  invalid_values?: InvalidValuesReport;
  steps: Step[];
};
type Status = {
  object_type_id: string;
  display_name: string;
  source: "dataset" | "edits only";
  dataset: string | null;
  dataset_id: string | null;
  auto_reindex: boolean | null;
  synced_at: string | null;
  errors: { code: string; message: string }[];
  objects: number;
  status: "ready" | "failed";
  last_run: Run | null;
};

const api = {
  overview: () => request<Status[]>("/indexing"),
  type: (id: string) => request<Status & { runs: Run[] }>(`/object-types/${id}/indexing`),
  full: (id: string) => request<Status & { runs: Run[] }>(`/object-types/${id}/indexing/full`, { method: "POST" }),
};

const RESTRICTIONS = [
  "Primary keys are unique; geopoints, geoshapes, arrays, time series and real numbers cannot be primary keys.",
  "Column types must fit their properties on every sync.",
  "A value its property does not allow is indexed as null and counted on the run, or fails the whole re-index (the datasource's Disallowed values setting).",
  "No NaN or ±infinity values and no empty strings (they become null).",
  "No nested arrays and no null elements in arrays.",
  "Strings up to 12 MB (use a media reference above that), arrays up to 100,000 elements (use a link type).",
];

/**
 * Indexing: every object type's datasource, and each re-index as a Funnel-style batch pipeline (changelog, merge
 * changes, indexing, hydration), incremental or full, live or replacement, with the data restrictions it checked.
 */
export default function OntologyIndexingPage() {
  const [rows, setRows] = useState<Status[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<(Status & { runs: Run[] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.overview().then(setRows, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const current = selected ?? rows?.find((r) => r.source === "dataset")?.object_type_id ?? rows?.[0]?.object_type_id ?? null;
  useEffect(() => {
    if (current) api.type(current).then(setDetail, (e: Error) => setError(e.message));
  }, [current]);
  if (error && !rows) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  const d = detail && detail.object_type_id === current ? detail : null;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Indexing" icon="pipeline" href="/ontology-indexing" crumbs={d ? [{ label: d.display_name }] : []} />
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          {(["dataset", "edits only"] as const).map((src) => (
            <div key={src} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{src === "dataset" ? "Backed by datasets" : "Edits only"}</div>
              {rows
                .filter((r) => r.source === src)
                .map((r) => (
                  <button
                    key={r.object_type_id}
                    type="button"
                    onClick={() => setSelected(r.object_type_id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${current === r.object_type_id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${r.status === "failed" ? "bg-bad" : "bg-ok"}`} />
                    <span className="min-w-0 flex-1 truncate">{r.display_name}</span>
                    <span className="text-[11px] tabular-nums text-muted">{r.objects.toLocaleString()}</span>
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
          {d && (
            <div className="mx-auto max-w-6xl space-y-4 p-5">
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <h1 className="text-xl font-semibold">{d.display_name}</h1>
                  <p className="mt-1 text-xs text-muted">
                    {d.source === "dataset" ? (
                      <>
                        Backed by{" "}
                        <Link href={`/datasets/${d.dataset_id}`} className="text-ocean hover:underline">
                          {d.dataset}
                        </Link>{" "}
                        · auto re-index {d.auto_reindex ? "on" : "off"} · synced {d.synced_at ? new Date(d.synced_at).toLocaleString() : "never"}
                      </>
                    ) : (
                      "No backing dataset: objects are created and changed by edits, indexed as they are written."
                    )}
                  </p>
                </div>
                {d.source === "dataset" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        setDetail(await api.full(d.object_type_id));
                        await load();
                        setError(null);
                      } catch (e) {
                        setError((e as Error).message);
                        api.type(d.object_type_id).then(setDetail, () => undefined);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    className={buttonClass.primary}
                  >
                    <Icon name="refresh" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Full re-index
                  </button>
                )}
              </div>
              <ErrorBox message={error} />
              {d.errors.length > 0 && (
                <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-xs text-bad">
                  {d.errors.map((e) => (
                    <div key={e.code + e.message}>
                      <span className="font-mono">{e.code}</span>: {e.message}
                    </div>
                  ))}
                </div>
              )}
              <Card title="Pipeline runs" count={d.runs.length}>
                <div className="divide-y divide-line text-xs">
                  {d.runs.length === 0 && <div className="p-4 text-muted">No index runs recorded yet{d.source === "dataset" ? ": run a full re-index." : "."}</div>}
                  {d.runs.map((r) => (
                    <div key={r.id} className="space-y-2 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${r.status === "failed" ? "bg-bad/15 text-bad" : "bg-ok/15 text-ok"}`}>{r.status}</span>
                        <span className="font-medium">{new Date(r.at).toLocaleString()}</span>
                        <span className="rounded bg-panel-2 px-1.5 text-muted">{r.pipeline} pipeline</span>
                        <span className="rounded bg-panel-2 px-1.5 text-muted">{r.mode}</span>
                        <span className="text-muted">trigger: {r.trigger}</span>
                        {r.ms !== undefined && <span className="ml-auto text-muted">{r.ms} ms</span>}
                      </div>
                      <div className="flex flex-wrap items-stretch gap-1">
                        {r.steps.map((s, i) => (
                          <div key={s.name} className="flex items-center gap-1">
                            <div className={`rounded-md border px-2.5 py-1.5 ${s.status === "failed" ? "border-bad/40 bg-bad/5" : "border-line bg-panel"}`}>
                              <div className="font-medium">{s.name}</div>
                              <div className="text-muted">{s.detail}</div>
                            </div>
                            {i < r.steps.length - 1 && <Icon name="right" className="h-3 w-3 text-muted" />}
                          </div>
                        ))}
                      </div>
                      {r.error && <div className="text-bad">{r.error}</div>}
                      {(r.warnings ?? []).length > 0 && (
                        <div className="text-warn">
                          {r.warnings!.map((w) => (
                            <div key={w.message}>
                              ⚠ {w.message} ({w.count})
                            </div>
                          ))}
                        </div>
                      )}
                      {r.invalid_values && (
                        <div className={`rounded-md border p-2 ${r.status === "failed" ? "border-bad/40 bg-bad/5" : "border-warn/40 bg-warn/5"}`}>
                          <InvalidValuesTable report={r.invalid_values} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="Data restrictions (Object Storage v2)">
                <ul className="list-disc space-y-1 p-4 pl-8 text-xs text-soft">
                  {RESTRICTIONS.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </Card>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
