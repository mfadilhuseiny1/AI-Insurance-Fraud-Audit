"use client";

import type { EngineReport, EngineSettings } from "@/lib/contour";

const LABEL: Record<EngineReport["engine"], string> = { duckdb: "DuckDB (in memory)", "duckdb-scan": "DuckDB (scanned from disk)", spark: "Spark" };

function size(bytes: number | null): string {
  if (bytes === null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** The engine a path ran on, its sources' sizes (which were scanned from disk) and any fallback notes. */
export function EngineBadge({ report }: { report?: EngineReport }) {
  if (!report) return null;
  const tip = [
    `Engine setting: ${report.mode}; datasets from ${report.large_rows.toLocaleString()} rows or ${size(report.large_bytes)} are scanned from disk`,
    ...report.sources.map((s) => `${s.name ?? s.id}: ${s.rows !== null ? `${s.rows.toLocaleString()} rows` : s.kind}${s.bytes !== null ? `, ${size(s.bytes)}` : ""}${s.scan ? " (scanned)" : ""}`),
    ...report.notes,
  ].join("\n");
  const fellBack = report.notes.length > 0;
  return (
    <span className={`rounded border px-1.5 py-0.5 ${fellBack ? "border-warn/40 bg-warn/10" : "border-line-2"} text-muted`} title={tip} data-engine={report.engine}>
      {LABEL[report.engine]}
      {fellBack ? " *" : ""}
    </span>
  );
}

/** The analysis' engine setting for large inputs (api/contour_scale.py). */
export function EngineSettingsField({ value, disabled, onChange }: { value?: EngineSettings; disabled?: boolean; onChange: (v: EngineSettings) => void }) {
  const mode = value?.mode ?? "auto";
  return (
    <label
      className="flex items-center gap-2 px-1 text-xs text-muted"
      title="Automatic: datasets over 1,000,000 rows or 128 MB are scanned from disk instead of read into memory (same results). Spark: paths run on a local Spark session; boards Spark does not run use DuckDB."
    >
      Engine
      <select
        value={mode}
        disabled={disabled}
        onChange={(e) => onChange({ ...(value ?? {}), mode: e.target.value as EngineSettings["mode"] })}
        className="rounded border border-line-2 bg-panel px-1.5 py-0.5"
      >
        <option value="auto">Automatic</option>
        <option value="memory">In memory</option>
        <option value="spark">Spark</option>
      </select>
    </label>
  );
}
