"use client";

import { useState } from "react";
import { Badge } from "@/components/ontology/parts";
import { BarChart } from "@/components/workshop/Charts";
import type { FnSignature, Telemetry } from "@/lib/actions";

export const KIND_LABEL: Record<FnSignature["kind"], string> = { function: "Function", query: "Query", edit: "Nexus edit" };

export const signature = (f: Pick<FnSignature, "name" | "inputs" | "output">) =>
  `${f.name}(${f.inputs.map((i) => `${i.name}: ${i.type}${i.required ? "" : "?"}`).join(", ")}) → ${f.output}`;

type Bucket = { key: unknown; value: unknown; buckets?: Bucket[] };
const isAgg = (v: unknown): v is { buckets: Bucket[] } => !!v && typeof v === "object" && Array.isArray((v as { buckets?: unknown }).buckets);

/** A TwoDimensionalAggregation as a bar chart; a ThreeDimensionalAggregation as one chart per outer bucket. */
export function AggregationView({ value }: { value: { buckets: Bucket[] } }) {
  const nested = value.buckets.some((b) => Array.isArray(b.buckets));
  if (!nested)
    return (
      <div className="h-56 rounded-md bg-panel-2 p-2">
        <BarChart data={value.buckets.map((b) => ({ key: b.key, value: typeof b.value === "number" ? b.value : null, count: 0 }))} metricLabel="Value" />
      </div>
    );
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {value.buckets.map((b) => (
        <div key={String(b.key)} className="rounded-md bg-panel-2 p-2">
          <div className="mb-1 text-xs font-medium">{String(b.key)}</div>
          <div className="h-40">
            <BarChart data={(b.buckets ?? []).map((x) => ({ key: x.key, value: typeof x.value === "number" ? x.value : null, count: 0 }))} metricLabel="Value" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A run's telemetry: spans and platform calls on a timeline (Performance), and log records by level. */
export function TelemetryView({ t, ms }: { t: Telemetry; ms?: number }) {
  const [level, setLevel] = useState("");
  const total = Math.max(ms ?? 0, ...t.spans.map((s) => s.start_ms + s.ms), ...t.calls.map((c) => c.at_ms + c.ms), 1);
  const slow = [...t.calls].sort((a, b) => b.ms - a.ms).slice(0, 5);
  const callMs = t.calls.reduce((n, c) => n + c.ms, 0);
  const logs = t.log_records.filter((l) => !level || l.level === level);
  const bar = (start: number, dur: number, cls: string, label: string) => (
    <div className="relative h-4 rounded bg-panel" title={label}>
      <div className={`absolute h-4 rounded ${cls}`} style={{ left: `${(start / total) * 100}%`, width: `${Math.max(0.5, (dur / total) * 100)}%` }} />
    </div>
  );
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap gap-4 text-muted">
        <span>{t.calls.length} platform calls · {Math.round(callMs)} ms</span>
        <span>{t.spans.length} spans</span>
        <span>{t.log_records.length} log records</span>
        {t.peak_memory_mb ? <span>peak memory {Math.round(t.peak_memory_mb)} MB</span> : null}
      </div>
      {(t.spans.length > 0 || t.calls.length > 0) && (
        <div className="space-y-1">
          {t.spans.map((s, i) => (
            <div key={`s${i}`} className="grid grid-cols-[180px_1fr_60px] items-center gap-2">
              <span className="truncate font-medium">{s.name}</span>
              {bar(s.start_ms, s.ms, s.error ? "bg-bad/70" : "bg-sand/70", `${s.name}: ${s.ms} ms`)}
              <span className="text-right tabular-nums">{s.ms} ms</span>
            </div>
          ))}
          {t.calls.slice(0, 60).map((c, i) => (
            <div key={`c${i}`} className="grid grid-cols-[180px_1fr_60px] items-center gap-2 text-muted">
              <span className="truncate font-mono" title={c.path}>
                {c.method} {c.path.replace("/api/ontology/", "")}
              </span>
              {bar(c.at_ms, c.ms, c.status === "error" ? "bg-bad/60" : "bg-ocean/60", `${c.path}: ${c.ms} ms`)}
              <span className="text-right tabular-nums">{c.ms} ms</span>
            </div>
          ))}
        </div>
      )}
      {slow.length > 0 && (
        <div>
          <div className="mb-1 text-muted">Slowest platform calls</div>
          {slow.map((c, i) => (
            <div key={i} className="font-mono">
              {c.ms} ms · {c.method} {c.path}
            </div>
          ))}
        </div>
      )}
      {t.log_records.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-2 text-muted">
            Logs
            <select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded border border-line-2 bg-ink px-1 py-0.5 text-xs">
              <option value="">All levels</option>
              {["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="max-h-48 overflow-auto rounded-md bg-panel-2 p-2 font-mono">
            {logs.map((l, i) => (
              <div key={i} className={l.level === "ERROR" || l.level === "CRITICAL" ? "text-bad" : l.level === "WARNING" ? "text-warn" : ""}>
                +{l.at_ms} ms {l.level} {l.logger}: {l.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ResultView({
  ok,
  value,
  edits,
  error,
  logs,
  ms,
  version,
  errorName,
  telemetry,
}: {
  ok: boolean;
  value?: unknown;
  edits?: { op: string; object_type_id: string; primary_key: string }[];
  error?: string | null;
  logs?: string | null;
  ms?: number;
  version?: string;
  errorName?: string;
  telemetry?: Telemetry;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Badge status={ok ? "succeeded" : "failed"} />
        {version && <span className="font-mono text-muted">v{version}</span>}
        {ms !== undefined && <span className="text-muted">{ms} ms</span>}
      </div>
      {error && (
        <pre className="whitespace-pre-wrap rounded-md bg-bad/10 p-2 text-xs text-bad">
          {errorName ? `${errorName}: ` : ""}
          {error}
        </pre>
      )}
      {ok && isAgg(value) && <AggregationView value={value} />}
      {ok && value !== undefined && <pre className="max-h-72 overflow-auto rounded-md bg-panel-2 p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>}
      {!!edits?.length && (
        <div className="text-xs">
          <div className="mb-1 text-muted">Nexus edits</div>
          <ul className="space-y-0.5">
            {edits.map((e, i) => (
              <li key={i}>
                <span className="capitalize">{e.op}</span> {e.object_type_id} · <span className="font-mono">{e.primary_key}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {telemetry && (telemetry.spans.length > 0 || telemetry.calls.length > 0 || telemetry.log_records.length > 0) && <TelemetryView t={telemetry} ms={ms} />}
      {logs && <pre className="max-h-48 overflow-auto rounded-md bg-panel-2 p-2 text-[11px] text-muted">{logs}</pre>}
    </div>
  );
}
