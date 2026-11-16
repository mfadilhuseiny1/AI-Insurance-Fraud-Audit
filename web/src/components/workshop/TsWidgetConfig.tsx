"use client";

import { useEffect, useState } from "react";
import { Field, ObjectPicker } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { AGGREGATIONS, tsOntology, type Analysis, type TsObjectType } from "@/lib/timeseries";
import type { Widget, WidgetConfig } from "@/lib/workshop";

const RANGES: [string, string][] = [
  ["", "All time"],
  ["1h", "Last hour"],
  ["1d", "Last day"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
];

/** Configuration of the time series widgets (Chart XY, metric, Quiver dashboard, derived series). */
export function TsWidgetConfig({ widget, set }: { widget: Widget; set: (c: Partial<WidgetConfig>) => void }) {
  const c = widget.config;
  const [types, setTypes] = useState<TsObjectType[]>([]);
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [sensor, setSensor] = useState("");
  useEffect(() => {
    tsOntology.objectTypes().then(setTypes, () => setTypes([]));
    if (widget.type === "quiver") tsOntology.analyses().then(setAnalyses, () => setAnalyses([]));
  }, [widget.type]);
  if (widget.type === "quiver")
    return (
      <>
        <Field label="Quiver analysis" hint="Its dashboard; the object input follows the object selected in a table on the analysis' object type">
          <select value={c.analysis_id ?? ""} onChange={(e) => set({ analysis_id: e.target.value || undefined })} className={inputClass}>
            <option value="">Choose an analysis…</option>
            {analyses.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Time range">
          <select value={c.range_last ?? ""} onChange={(e) => set({ range_last: e.target.value || undefined })} className={inputClass}>
            {RANGES.map(([v, l]) => (
              <option key={v} value={v}>
                {v ? l : "The analysis' range"}
              </option>
            ))}
          </select>
        </Field>
      </>
    );
  if (widget.type === "derived")
    return (
      <>
        <Field label="Derived series type">
          <select value={c.derived_type ?? ""} onChange={(e) => set({ derived_type: e.target.value as WidgetConfig["derived_type"] })} className={inputClass}>
            <option value="">Templated and single</option>
            <option value="templated">Templated</option>
            <option value="single">Single</option>
          </select>
        </Field>
        <Field label="Root object type">
          <select value={c.derived_root ?? ""} onChange={(e) => set({ derived_root: e.target.value || undefined })} className={inputClass}>
            <option value="">Any</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sensor object type (bound)">
          <select value={c.derived_bound ?? ""} onChange={(e) => set({ derived_bound: e.target.value || undefined })} className={inputClass}>
            <option value="">Any</option>
            {types
              .filter((t) => t.is_sensor)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={!!c.disable_create} onChange={(e) => set({ disable_create: e.target.checked })} /> Disable creating derived series
        </label>
        <Field label="Empty state header">
          <input value={c.empty_header ?? ""} onChange={(e) => set({ empty_header: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Empty state description">
          <input value={c.empty_description ?? ""} onChange={(e) => set({ empty_description: e.target.value })} className={inputClass} />
        </Field>
      </>
    );
  const t = c.source?.kind === "object_type" ? types.find((x) => x.id === c.source!.id) : undefined;
  const layers = c.tsps ?? [];
  const metric = widget.type === "ts_metric";
  return (
    <>
      <p className="text-[11px] text-muted">Data source: a time series object type (below). The widget shows the object selected in a table on the same type, or a fixed object.</p>
      {t && (
        <Field label={metric ? "Time series property" : "Plot layers (time series sets)"}>
          <div className="flex flex-wrap gap-1">
            {t.properties.map((p) => {
              const on = layers.includes(p.api_name);
              return (
                <button
                  key={p.api_name}
                  type="button"
                  onClick={() => set({ tsps: metric ? [p.api_name] : on ? layers.filter((x) => x !== p.api_name) : [...layers, p.api_name] })}
                  className={`rounded px-1.5 py-0.5 text-xs ${on ? "bg-ocean/20 text-white ring-1 ring-ocean/40" : "bg-panel-2 text-muted"}`}
                >
                  {p.display_name}
                </button>
              );
            })}
            {layers
              .filter((l) => l.startsWith("sensor:"))
              .map((l) => (
                <button key={l} type="button" onClick={() => set({ tsps: layers.filter((x) => x !== l) })} className="rounded bg-ocean/20 px-1.5 py-0.5 text-xs text-white ring-1 ring-ocean/40">
                  {l.slice(7)} ×
                </button>
              ))}
          </div>
          {t.sensor_types.length > 0 && (
            <div className="mt-1 flex gap-1">
              <input value={sensor} onChange={(e) => setSensor(e.target.value)} placeholder="Linked sensor name" className={`${inputClass} py-1 text-xs`} />
              <button
                type="button"
                onClick={() => {
                  if (!sensor.trim()) return;
                  set({ tsps: metric ? [`sensor:${sensor.trim()}`] : [...layers, `sensor:${sensor.trim()}`] });
                  setSensor("");
                }}
                className="rounded-md border border-line-2 px-2 text-xs text-soft"
              >
                Add
              </button>
            </div>
          )}
        </Field>
      )}
      {c.source?.kind === "object_type" && (
        <Field label="Fixed object (optional)">
          <ObjectPicker objectTypeId={c.source.id} value={c.object_pk ?? ""} onChange={(pk) => set({ object_pk: pk || undefined })} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Rolling transform window">
          <input value={c.rolling ?? ""} onChange={(e) => set({ rolling: e.target.value || undefined })} placeholder="e.g. 1w" className={`${inputClass} font-mono`} />
        </Field>
        <Field label="Rolling aggregation">
          <select value={c.rolling_agg ?? "mean"} onChange={(e) => set({ rolling_agg: e.target.value })} className={inputClass}>
            {AGGREGATIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {/* the Metric Card's range and aggregation are in its Value section (custom ranges, every summarizer) */}
      {!metric && (
        <Field label="Time range">
          <select value={c.range_last ?? ""} onChange={(e) => set({ range_last: e.target.value || undefined })} className={inputClass}>
            {RANGES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      )}
      {metric && (
        <>
          <Field label="Label">
            <input value={c.label ?? ""} onChange={(e) => set({ label: e.target.value })} className={inputClass} />
          </Field>
        </>
      )}
    </>
  );
}
