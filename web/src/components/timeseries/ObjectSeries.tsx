"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { resolveRange, tsOntology, type ObjectTsp, type SeriesResult } from "@/lib/timeseries";
import { RangePicker, TsChart } from "./TsChart";

/** Every time series of an object: its time series properties and its linked sensors' series, one chart each. */
export function ObjectSeries({ typeId, pk, resource = "ontology", compact }: { typeId: string; pk: string; resource?: string; compact?: boolean }) {
  const [state, setTsps] = useState<{ key: string; list: ObjectTsp[] } | null>(null);
  const tsps = state?.key === `${typeId}:${pk}` ? state.list : null;
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ start?: string | null; end?: string | null; last?: string | null }>({});
  useEffect(() => {
    tsOntology.objectTsps(typeId, pk).then((list) => setTsps({ key: `${typeId}:${pk}`, list }), (e: Error) => setError(e.message));
  }, [typeId, pk]);
  if (error) return <p className="text-xs text-bad">{error}</p>;
  if (!tsps) return <p className="text-xs text-muted">Loading time series…</p>;
  if (!tsps.length) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-soft">
          <Icon name="wave" className="h-3.5 w-3.5 text-ocean" /> Time series
        </span>
        {!compact && <RangePicker value={range} onChange={setRange} />}
      </div>
      {tsps.map((t) => (
        <OneSeries key={t.key} typeId={typeId} pk={pk} tsp={t} range={range} resource={resource} height={compact ? 120 : 170} />
      ))}
    </div>
  );
}

function OneSeries({ typeId, pk, tsp, range, resource, height }: { typeId: string; pk: string; tsp: ObjectTsp; range: { start?: string | null; end?: string | null; last?: string | null }; resource: string; height: number }) {
  const [data, setData] = useState<SeriesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const { start, end } = resolveRange(range);
    tsOntology.objectSeries(typeId, pk, { property: tsp.key, start, end, buckets: 300, resource }).then(
      (r) => (setData(r), setError(null)),
      (e: Error) => setError(e.message),
    );
  }, [typeId, pk, tsp.key, range, resource]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-xs">
        <span className="font-medium">{tsp.label}</span>
        {tsp.source === "sensor" && <span className="rounded bg-panel-2 px-1 text-[10px] text-muted">sensor</span>}
        {tsp.ref_kind === "derived" && <span className="rounded bg-ocean/15 px-1 text-[10px] text-ocean">derived</span>}
        {tsp.default && <span className="rounded bg-panel-2 px-1 text-[10px] text-muted">default</span>}
        {data && <span className="ml-auto text-muted">last {String(data.stats.last ?? "—")}{data.unit ? ` ${data.unit}` : ""}</span>}
      </div>
      {error ? (
        <p className="rounded-md border border-bad/30 bg-bad/10 px-2 py-1.5 text-[11px] text-bad">{error}</p>
      ) : data ? (
        <TsChart series={[{ key: tsp.key, label: tsp.label, unit: data.unit, points: data.points, categorical: data.categorical }]} height={height} />
      ) : (
        <div className="rounded-md border border-line bg-ink text-center text-[11px] text-muted" style={{ height }} />
      )}
    </div>
  );
}
