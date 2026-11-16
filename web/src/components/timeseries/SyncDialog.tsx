"use client";

import { useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import {
  DEFAULT_SYNC_SETTINGS,
  fmtValue,
  timeseries,
  type DatasetColumns,
  type DatasetRef,
  type SeriesSync,
  type SyncMapping,
  type SyncPreview,
  type SyncSettings,
  type TimestampUnit,
} from "@/lib/timeseries";

const LONG = new Set(["Long", "Integer", "Short", "Byte"]);
const UNITS: TimestampUnit[] = ["SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"];

/**
 * New time series sync (Time Series Catalog) or Update sync: pick the time series dataset, map its series ID,
 * timestamp and value columns (with the unit of a Long timestamp), preview, set the advanced settings, then
 * Save and build.
 */
export function SyncDialog({ sync, initialDataset, onClose, onSaved }: { sync?: SeriesSync; initialDataset?: string; onClose: () => void; onSaved: (s: SeriesSync) => void }) {
  const editing = !!sync;
  const pipelineOwned = editing && sync?.source !== "catalog";
  const [step, setStep] = useState(editing ? 1 : 0);
  const [datasets, setDatasets] = useState<DatasetRef[] | null>(null);
  const [datasetId, setDatasetId] = useState(sync?.dataset_id ?? initialDataset ?? "");
  const [colsState, setCols] = useState<DatasetColumns | null>(null);
  const cols = datasetId && colsState?.id === datasetId ? colsState : null;
  const [name, setName] = useState(sync?.name ?? "");
  const [description, setDescription] = useState(sync?.description ?? "");
  // the list holds the newest datasets: any other one is picked in Files
  const [browsing, setBrowsing] = useState(false);
  const [mapping, setMapping] = useState<SyncMapping>((sync?.mapping as SyncMapping) ?? { series_id: "", timestamp: "", value: "" });
  const [settings, setSettings] = useState<SyncSettings>(sync?.settings ?? DEFAULT_SYNC_SETTINGS);
  const [previewState, setPreview] = useState<{ key: string; data: SyncPreview } | null>(null);
  const [others, setOthers] = useState<SeriesSync[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    timeseries.datasets().then(setDatasets, (e: Error) => setError(e.message));
    timeseries.syncs("timeseries").then((s) => setOthers(s.filter((x) => x.id !== sync?.id)), () => setOthers([]));
  }, [sync?.id]);
  useEffect(() => {
    if (!datasetId) return;
    timeseries.datasetColumns(datasetId).then(
      (c) => {
        setCols(c);
        if (!editing) {
          const find = (re: RegExp) => c.columns.find((x) => re.test(x.name))?.name ?? "";
          setMapping((m) => ({
            series_id: m.series_id || find(/series|^id$|sensor|tag/i),
            timestamp: m.timestamp || c.columns.find((x) => x.type === "Timestamp")?.name || find(/time|date|^ts$/i),
            value: m.value || find(/value|reading|measure/i),
          }));
          setName((n) => n || `${c.name.replace(/\.parquet$/i, "")} time series`);
        }
      },
      (e: Error) => setError(e.message),
    );
  }, [datasetId, editing]);
  const tsCol = cols?.columns.find((c) => c.name === mapping.timestamp);
  const needsUnit = !!tsCol && LONG.has(tsCol.type);
  const mapped = mapping.series_id && mapping.timestamp && mapping.value && (!needsUnit || mapping.timestamp_unit);
  const previewKey = JSON.stringify([datasetId, mapping]);
  const preview = mapped && previewState?.key === previewKey ? previewState.data : null;
  useEffect(() => {
    if (!datasetId || !mapped) return;
    const t = setTimeout(() => timeseries.previewSync(datasetId, mapping).then((data) => setPreview({ key: JSON.stringify([datasetId, mapping]), data }), (e: Error) => setError(e.message)), 300);
    return () => clearTimeout(t);
  }, [datasetId, mapping, mapped]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = editing
        ? await timeseries.updateSync(sync!.id, pipelineOwned ? { name, description } : { name, description, mapping, settings })
        : await timeseries.createSync({ name, description, dataset_id: datasetId, mapping, settings, build: true });
      onSaved(editing && !pipelineOwned ? await timeseries.buildSync(s.id) : s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const colSelect = (key: keyof SyncMapping, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <select value={(mapping[key] as string) ?? ""} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })} className={inputClass} disabled={pipelineOwned} aria-label={`${label} column`}>
        <option value="">Pick a column…</option>
        {cols?.columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} ({c.type})
          </option>
        ))}
      </select>
    </Field>
  );
  const steps = ["Input dataset", "Column mapping", "Advanced settings"];
  return (
    <Modal title={editing ? `Update sync · ${sync!.name}` : "New time series sync"} icon="wave" onClose={onClose} wide>
      <div className="flex gap-1 border-b border-line px-4 py-2 text-xs">
        {steps.map((label, i) => (
          <button key={label} type="button" onClick={() => (i === 0 && editing ? null : setStep(i))} className={`rounded-md px-2 py-1 ${step === i ? "bg-ocean/15 text-white" : "text-muted"}`}>
            {i + 1}. {label}
          </button>
        ))}
      </div>
      <div className="space-y-4 p-4">
        {pipelineOwned && (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            This sync was created in Pipeline Builder: the pipeline&apos;s column mapping and settings override changes made here the next time it runs.
          </p>
        )}
        {step === 0 && (
          <>
            <Field label="Time series dataset" hint="A dataset with a series ID, a timestamp (Timestamp or Long) and a value column; the sync lives next to it">
              <div className="flex gap-2">
                <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className={`${inputClass} min-w-0 flex-1`} aria-label="Time series dataset">
                  <option value="">{datasets === null ? "Loading…" : datasets.length ? "Pick a dataset…" : "No datasets in Files yet"}</option>
                  {datasetId && datasets && !datasets.some((d) => d.id === datasetId) && <option value={datasetId}>{cols?.name ?? datasetId}</option>}
                  {datasets?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {[...d.path, d.name].join(" / ")}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setBrowsing(true)} className={buttonClass.secondary} title="Pick the dataset in Files">
                  Browse…
                </button>
              </div>
            </Field>
            <Field label="Sync name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} aria-label="Sync name" />
            </Field>
            <Field label="Description" hint="Optional: what the series measure">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass} aria-label="Sync description" />
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            {editing && <Field label="Sync name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} aria-label="Sync name" /></Field>}
            {editing && <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass} aria-label="Sync description" /></Field>}
            <div className="grid grid-cols-3 gap-3">
              {colSelect("series_id", "Series ID", "String: matches the TSP's series IDs")}
              {colSelect("timestamp", "Timestamp", "Timestamp or Long")}
              {colSelect("value", "Value", "Number, or String (categorical)")}
            </div>
            {needsUnit && (
              <Field label="Timestamp unit" hint={`${mapping.timestamp} is a Long column`}>
                <select value={mapping.timestamp_unit ?? ""} onChange={(e) => setMapping({ ...mapping, timestamp_unit: (e.target.value || null) as TimestampUnit | null })} className={inputClass} aria-label="Timestamp unit">
                  <option value="">Pick the unit…</option>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {preview && (
              <div className="rounded-lg border border-line">
                <div className="border-b border-line px-3 py-2 text-xs text-muted">
                  Preview of the first {preview.rows_read.toLocaleString()} rows: {preview.series_count.toLocaleString()} series
                  {preview.categorical ? " · categorical (at most 10,000 values per series)" : ""}
                  {preview.rejected ? <span className="text-warn"> · {preview.rejected} rows rejected</span> : null}
                </div>
                {preview.problems.map((p) => (
                  <p key={p} className="px-3 py-1 text-xs text-warn">
                    {p}
                  </p>
                ))}
                <table className="w-full text-xs">
                  <tbody>
                    {preview.points.slice(0, 8).map((p, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="px-3 py-1 font-mono">{p.series_id}</td>
                        <td className="px-3 py-1 text-muted">{p.timestamp.slice(0, 19).replace("T", " ")}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{fmtValue(p.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.rejected_samples.slice(0, 3).map((r, i) => (
                  <p key={i} className="border-t border-line px-3 py-1 text-[11px] text-warn">
                    {r.error}: {JSON.stringify(r.row)}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
        {step === 2 && (
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted">In most cases the defaults are recommended.</p>
            {(
              [
                ["schedule_on_update", "Schedule sync runs on input dataset update", "Rebuild the sync whenever its dataset changes (checked every minute)"],
                ["optimized", "Enable optimized sync builds", "Recommended when series are only read through time series properties or qualified series IDs: series IDs need not be unique across syncs"],
                ["index_view_inputs", "Index view dataset inputs", "For views of a few large datasets: index the backing datasets instead of the view"],
              ] as const
            ).map(([k, label, hint]) => (
              <label key={k} className="flex items-start gap-2 rounded-md border border-line p-2.5">
                <input type="checkbox" checked={settings[k]} onChange={(e) => setSettings({ ...settings, [k]: e.target.checked })} disabled={pipelineOwned} className="mt-1" />
                <span>
                  <span className="block">{label}</span>
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
            <Field label="Overwrite series from other syncs backed by other datasets" hint="Those syncs fail once this one builds and should then be trashed">
              <select
                multiple
                value={settings.overwrite_syncs}
                onChange={(e) => setSettings({ ...settings, overwrite_syncs: [...e.target.selectedOptions].map((o) => o.value) })}
                className={`${inputClass} h-24`}
                disabled={pipelineOwned}
              >
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Spark profiles" hint="Rarely needed (comma separated)">
              <input value={settings.spark_profiles.join(", ")} onChange={(e) => setSettings({ ...settings, spark_profiles: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={inputClass} disabled={pipelineOwned} />
            </Field>
            <p className="text-xs text-muted">Security markings: the sync inherits every marking of its input dataset.</p>
          </div>
        )}
        <ErrorBox message={error} />
        {browsing && (
          <DrivePicker
            title="Time series dataset"
            canPick={(i) => (i.name.toLowerCase().endsWith(".parquet") ? null : "not a dataset")}
            onPick={(i) => {
              setDatasetId(i.id);
              setBrowsing(false);
            }}
            onClose={() => setBrowsing(false)}
          />
        )}
        <div className="flex justify-end gap-2">
          {step > (editing ? 1 : 0) && (
            <button type="button" onClick={() => setStep(step - 1)} className={buttonClass.secondary}>
              Back
            </button>
          )}
          {step < 2 ? (
            <button type="button" onClick={() => setStep(step + 1)} disabled={step === 0 ? !datasetId || !name.trim() : !mapped && !pipelineOwned} className={buttonClass.primary}>
              Next <Icon name="right" className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button type="button" onClick={save} disabled={busy || (!mapped && !pipelineOwned) || !name.trim()} className={buttonClass.primary}>
              <Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Building…" : pipelineOwned ? "Save" : "Save and build"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
