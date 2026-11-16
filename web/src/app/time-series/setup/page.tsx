"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { SyncDialog } from "@/components/timeseries/SyncDialog";
import { ontology, type ObjectType } from "@/lib/ontology";
import { timeseries, tsOntology, type DatasetColumns, type DatasetRef, type SeriesSync } from "@/lib/timeseries";

export default function SetupPage() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}

/**
 * The time series setup assistant: a time series sync over the time series dataset, then a time series object
 * type — an existing one, or a new one created from its backing dataset — whose Capabilities tab adds the time
 * series properties.
 */
function Setup() {
  const router = useRouter();
  const params = useSearchParams();
  const [syncs, setSyncs] = useState<SeriesSync[]>([]);
  const [sync, setSync] = useState(params.get("sync") ?? "");
  const [newSync, setNewSync] = useState(false);
  const [path, setPath] = useState<"existing" | "new">("existing");
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [datasets, setDatasets] = useState<DatasetRef[]>([]);
  const [backing, setBacking] = useState("");
  const [colsState, setCols] = useState<DatasetColumns | null>(null);
  const [name, setName] = useState("");
  const [pk, setPk] = useState("");
  const [title, setTitle] = useState("");
  const [seriesCols, setSeriesCols] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    timeseries.syncs("timeseries").then(setSyncs, () => setSyncs([]));
    ontology.objectTypes().then(setTypes, () => setTypes([]));
    timeseries.datasets().then(setDatasets, () => setDatasets([]));
  }, []);
  useEffect(() => {
    if (!backing) return;
    timeseries.datasetColumns(backing).then((c) => {
      setCols(c);
      setName((n) => n || c.name.replace(/\.parquet$/i, "").replace(/[_-]+/g, " "));
      setPk(c.columns.find((x) => /(^id$|_id$|key)/i.test(x.name))?.name ?? c.columns[0]?.name ?? "");
      setSeriesCols(c.columns.filter((x) => /series/i.test(x.name)).map((x) => x.name));
    }, (e: Error) => setError(e.message));
  }, [backing]);
  const createType = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await tsOntology.createBackedType({ dataset_id: backing, display_name: name, primary_key: pk, title_property: title || undefined, timeseries_columns: seriesCols });
      router.push(`/ontology/${t.id}?tab=capabilities`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const syncRec = syncs.find((s) => s.id === sync);
  const cols = backing && colsState?.id === backing ? colsState : null;
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 p-8">
        <Link href="/time-series" className="inline-flex items-center gap-1 text-xs text-muted hover:text-white">
          <Icon name="left" className="h-3 w-3" /> Time Series Catalog
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Icon name="sparkle" className="h-5 w-5 text-ocean" /> Set up time series
        </h1>
        <details className="rounded-xl border border-line bg-panel p-4 text-sm">
          <summary className="cursor-pointer font-medium">Setup checkpoints — where to start or resume</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-soft">
            <li>Raw time series not in the platform yet? Sync it with <Link href="/sources" className="text-ocean hover:underline">Data Connection</Link>.</li>
            <li>Data shaped as one dataset per object with a column per measurement, or several datasets? Transform it in <Link href="/pipeline" className="text-ocean hover:underline">Pipeline Builder</Link> (unpivot, concatenate a series ID, join) into series ID / timestamp / value rows — and the object type backing dataset (a primary key and a series ID column per time series property).</li>
            <li>Have a time series sync? Pick it in step 1. Otherwise create one from the dataset.</li>
            <li>Object type exists? Choose it in step 2; else create it from its backing dataset.</li>
            <li>Then add time series properties in the object type&apos;s Capabilities tab, and use them in <Link href="/quiver" className="text-ocean hover:underline">Quiver</Link>, Workshop, derived series and Automate.</li>
          </ul>
        </details>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <span className="rounded-full bg-ocean/15 px-2 text-xs text-ocean">1</span> Time series sync
          </h2>
          <p className="mb-3 text-xs text-muted">Indexes the series ID / timestamp / value rows of your time series dataset. Its series IDs must match the object type&apos;s.</p>
          <div className="flex gap-2">
            <select value={sync} onChange={(e) => setSync(e.target.value)} className={inputClass}>
              <option value="">Choose a time series sync…</option>
              {syncs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.series} series)
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setNewSync(true)} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New sync from a dataset
            </button>
          </div>
          {syncRec && <p className="mt-2 text-xs text-ok">{syncRec.stored.toLocaleString()} points in {syncRec.series} series.</p>}
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <span className="rounded-full bg-ocean/15 px-2 text-xs text-ocean">2</span> Time series object type
          </h2>
          <div className="mb-3 grid grid-cols-2 gap-2">
            {(
              [
                ["existing", "Choose existing object type", "Add time series properties to an object type you have"],
                ["new", "Create new object type", "From a backing dataset: one object per row, a series ID column per time series property"],
              ] as const
            ).map(([k, label, hint]) => (
              <button key={k} type="button" onClick={() => setPath(k)} className={`rounded-lg border p-2.5 text-left text-sm ${path === k ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                <div className="font-medium">{label}</div>
                <div className="text-xs text-muted">{hint}</div>
              </button>
            ))}
          </div>
          {path === "existing" ? (
            <div className="flex gap-2">
              <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputClass}>
                <option value="">Choose an object type…</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.display_name}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!typeId} onClick={() => router.push(`/ontology/${typeId}?tab=capabilities`)} className={buttonClass.primary}>
                Continue to Capabilities <Icon name="right" className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="Time series object type backing dataset">
                <select value={backing} onChange={(e) => setBacking(e.target.value)} className={inputClass}>
                  <option value="">Pick a dataset…</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {[...d.path, d.name].join(" / ")}
                    </option>
                  ))}
                </select>
              </Field>
              {cols && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Name">
                      <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
                    </Field>
                    <Field label="Primary key" hint="Unique per row">
                      <select value={pk} onChange={(e) => setPk(e.target.value)} className={inputClass}>
                        {cols.columns.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Title">
                      <select value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass}>
                        <option value="">The primary key</option>
                        {cols.columns.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Series ID columns" hint="Each becomes a time series property (configure its syncs next)">
                    <div className="flex flex-wrap gap-1.5">
                      {cols.columns
                        .filter((c) => c.name !== pk)
                        .map((c) => {
                          const on = seriesCols.includes(c.name);
                          return (
                            <button
                              key={c.name}
                              type="button"
                              onClick={() => setSeriesCols(on ? seriesCols.filter((x) => x !== c.name) : [...seriesCols, c.name])}
                              className={`rounded px-2 py-0.5 text-xs ${on ? "bg-ocean/20 text-white ring-1 ring-ocean/40" : "bg-panel-2 text-muted"}`}
                            >
                              {c.name}
                            </button>
                          );
                        })}
                    </div>
                  </Field>
                  <button type="button" disabled={busy || !name.trim() || !pk} onClick={createType} className={buttonClass.primary}>
                    <Icon name="cube" className="h-3.5 w-3.5" /> {busy ? "Creating…" : "Create object type and continue"}
                  </button>
                </>
              )}
            </div>
          )}
          <ErrorBox message={error} />
        </section>
      </div>
      {newSync && (
        <SyncDialog
          onClose={() => setNewSync(false)}
          onSaved={(s) => {
            setSyncs([s, ...syncs]);
            setSync(s.id);
            setNewSync(false);
          }}
        />
      )}
    </div>
  );
}
