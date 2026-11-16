"use client";

import type { TelemetrySpan } from "@/lib/modelDeployments";

/** The spans of one inference call as a waterfall: the span over the whole call first, the adapter's own spans
 *  (OpenTelemetry) nested under their parents. api/model_worker.py */
export function SpanWaterfall({ spans }: { spans: TelemetrySpan[] }) {
  if (!spans.length) return <div className="text-xs text-muted">No spans were recorded for this call.</div>;
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const depth = (s: TelemetrySpan): number => {
    let n = 0;
    for (let p = s.parent_id ? byId.get(s.parent_id) : undefined; p && n < 50; p = p.parent_id ? byId.get(p.parent_id) : undefined) n += 1;
    return n;
  };
  const total = Math.max(...spans.map((s) => s.start_ms + s.ms), 0.001);
  return (
    <div className="space-y-1">
      {spans.map((s) => {
        const attrs = Object.entries(s.attributes).filter(([k]) => !k.startsWith("model.") && k !== "request.id");
        return (
          <div key={s.span_id} className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs">
            <div className="truncate text-soft" style={{ paddingLeft: depth(s) * 12 }} title={s.name}>
              <span className={s.status === "ERROR" ? "text-bad" : "text-white"}>{s.name}</span>
              {attrs.length > 0 && <span className="ml-1.5 text-[11px] text-muted">{attrs.map(([k, v]) => `${k}=${String(v)}`).join(" ")}</span>}
            </div>
            <div className="relative h-3 rounded bg-panel-2" title={`starts at ${s.start_ms} ms${s.events.length ? ` · ${s.events.map((e) => e.name).join(", ")}` : ""}`}>
              <div className={`absolute inset-y-0 rounded ${s.status === "ERROR" ? "bg-bad" : "bg-ocean"}`}
                style={{ left: `${Math.min(99, (s.start_ms / total) * 100)}%`, width: `${Math.max(1, (s.ms / total) * 100)}%` }} />
            </div>
            <div className="text-right tabular-nums text-muted">{s.ms < 10 ? s.ms.toFixed(2) : Math.round(s.ms)} ms</div>
          </div>
        );
      })}
    </div>
  );
}
