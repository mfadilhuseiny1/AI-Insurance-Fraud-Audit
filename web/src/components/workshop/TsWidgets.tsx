"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { QuiverDashboard } from "@/components/timeseries/Quiver";
import { TsChart, type ChartSeries } from "@/components/timeseries/TsChart";
import { fmtValue, resolveRange, tsOntology, type Analysis, type DerivedSeries, type SeriesResult } from "@/lib/timeseries";
import { fmtWith, sourceKey, workshop, type TsCellData, type TsColumnRequest, type Widget } from "@/lib/workshop";
import { metricColumn, metricIsLegacy, rangeLabel, Sparkline, tsColumnRequest, tsStyle } from "./TsFormatting";
import type { ModuleState } from "./WidgetView";

/** The object a time series widget shows: a fixed one, else the one selected in a table on the same object type. */
function useObject(widget: Widget, state: ModuleState) {
  const c = widget.config;
  const pk = c.object_pk || (c.source ? state.selection[sourceKey(c.source)] : undefined);
  return c.source?.kind === "object_type" && pk ? { object_type_id: c.source.id, primary_key: pk } : null;
}

const resource = (state: ModuleState) => (state.moduleId ? `workshop:${state.moduleId}` : "workshop");

/** Chart XY over time series sets: one layer per time series property (or sensor), optionally a rolling aggregate. */
export function TsChartWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const obj = useObject(widget, state);
  const [series, setSeries] = useState<ChartSeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const spec = JSON.stringify({ obj, t: c.tsps, r: c.rolling, a: c.rolling_agg, l: c.range_last, v: state.version });
  useEffect(() => {
    if (!obj || !c.tsps?.length) return;
    const { start, end } = resolveRange({ last: c.range_last || null });
    Promise.all(
      c.tsps.map((p) =>
        tsOntology
          .objectSeries(obj.object_type_id, obj.primary_key, { property: p, start, end, buckets: 400, resource: resource(state), rolling: c.rolling || undefined, aggregation: c.rolling_agg || "mean" })
          .then((r: SeriesResult) => ({ key: p, label: p.replace(/^sensor:/, ""), unit: r.unit, points: r.points, categorical: r.categorical })),
      ),
    ).then((s) => (setSeries(s), setError(null)), (e: Error) => setError(e.message));
    // spec holds every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  if (!c.source || c.source.kind !== "object_type") return <Hint text="Choose a time series object type" />;
  if (!c.tsps?.length) return <Hint text="Add time series properties as plot layers" />;
  if (!obj) return <Hint text="Select an object in a table on the same object type (or set a fixed object)" />;
  if (error) return <div className="p-3 text-xs text-bad">{error}</div>;
  return (
    <div className="h-full overflow-hidden p-2">
      <TsChart series={series} height={Math.max(120, (widget.h * 56) - 70)} />
    </div>
  );
}

/** Metric card over a time series: last, first, min, max, mean or sum over the range, with value formatting,
 * conditional formatting (value and sparkline) and a sparkline of the range. */
export function TsMetricWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const obj = useObject(widget, state);
  const [value, setValue] = useState<{ v: unknown; unit: string | null } | null>(null);
  const [cell, setCell] = useState<TsCellData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const how = c.ts_aggregation ?? "last";
  // the summary as a table column's: original cards (the six first aggregations over a preset range) keep the time
  // series query for the value; the others (transforms, value change, the newer aggregations, value at a time, custom
  // ranges) take value and sparkline from the time series column API
  const legacy = metricIsLegacy(c);
  const req: Omit<TsColumnRequest, "id"> & { id?: string } = tsColumnRequest({ ...metricColumn(c), buckets: 40 });
  delete req.id;
  const spec = JSON.stringify({ obj, p: c.tsps?.[0], how, r: c.rolling, a: c.rolling_agg, l: c.range_last, req: legacy ? null : req, v: state.version });
  // the sparkline: the Workshop time series column API (also fetched without a sparkline when a rule or the color
  // scale tests a measure of the series: change, change %, trend)
  const spark = c.ts_sparkline !== false;
  const series = !legacy || spark || (c.rules ?? []).some((r) => r.test && r.test !== "value") || (!!c.ts_color_scale?.by && c.ts_color_scale.by !== "value");
  useEffect(() => {
    const prop = c.tsps?.[0];
    if (!obj || !prop || !series) return;
    let stale = false;
    workshop
      .tsColumns({ ...req, object_type_id: obj.object_type_id, primary_keys: [obj.primary_key], property: prop, resource: resource(state) })
      .then(
        (r) => {
          if (stale) return;
          const got = r.rows[obj.primary_key] ?? null;
          setCell(got);
          if (!legacy) {
            setError(got?.error ?? null);
            setValue(got && !got.error ? { v: got.value ?? null, unit: got.unit ?? null } : null);
          }
        },
        (e: Error) => {
          if (stale) return;
          setCell(null);
          if (!legacy) setError(e.message);
        },
      );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, series]);
  useEffect(() => {
    const prop = c.tsps?.[0];
    if (!obj || !prop || !legacy) return;
    const { start, end } = resolveRange({ last: c.range_last || null });
    const cards = [{ id: "A", type: "tsp" as const, config: { property: prop } }];
    const logic = c.rolling
      ? { cards: [...cards, { id: "B", type: "rolling" as const, config: { input: "A", window: c.rolling, aggregation: c.rolling_agg || "mean" } }, { id: "C", type: "aggregate" as const, config: { input: "B", aggregation: how } }] }
      : { cards: [...cards, { id: "C", type: "aggregate" as const, config: { input: "A", aggregation: how } }] };
    // an answer for options changed since (e.g. switched to a newer summary) is dropped
    let stale = false;
    tsOntology
      .query({ logic, root: obj, start, end, resource: resource(state), cards: ["A", "C"], buckets: 10 })
      .then((r) => {
        if (stale) return;
        const out = r.cards.C;
        const a = r.cards.A;
        if (out.kind === "error") throw new Error(out.error);
        setValue({ v: out.kind === "scalar" ? out.value : null, unit: a.kind === "series" ? a.unit : null });
        setError(null);
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  if (!c.tsps?.[0]) return <Hint text="Pick a time series property" />;
  if (!obj) return <Hint text="Select an object in a table on the same object type" />;
  if (error) return <div className="p-3 text-xs text-bad">{error}</div>;
  const f = c.formats?.[""];
  // the first matching rule (on the value or a measure of the series), else the color scale (its fixed bounds)
  const st = value ? tsStyle(c.rules, c.ts_color_scale, cell, undefined, typeof value.v === "number" ? value.v : null) : {};
  const prop = c.tsps[0].replace(/^sensor:/, "");
  const vc = !legacy && c.ts_summarizer === "value_change";
  const range = rangeLabel({ last: c.range_last, start: c.range_start, end: c.range_end, end_offset: c.range_end_offset });
  const at = how === "value_at" ? `value of ${prop} at ${cell?.at ? new Date(cell.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : c.ts_value_at || "now"}` : null;
  const label = c.label || (at ?? `${how.replace(/_/g, " ")} of ${prop}${range ? ` · ${range}` : ""}`) + (vc ? ` · change${c.ts_change_as === "percent" ? " %" : ""}` : "");
  const title = vc && cell && cell.change !== undefined
    ? `previous ${f ? fmtWith(cell.previous ?? null, f) : fmtValue(cell.previous ?? null)}${cell.previous_at ? ` (${new Date(cell.previous_at).toLocaleString()})` : ""} → current ${f ? fmtWith(cell.current ?? null, f) : fmtValue(cell.current ?? null)}${cell.at ? ` (${new Date(cell.at).toLocaleString()})` : ""}`
    : undefined;
  return (
    <div className="flex h-full flex-col justify-center px-4" data-ts-metric data-ts-metric-mode={legacy ? "query" : "column"} data-ts-color={st.rule?.color ?? st.scaled ?? ""} title={title}>
      <div className="text-3xl font-semibold tabular-nums">
        <span className="rounded px-0.5" style={st.text} data-ts-value>
          {value ? (f ? fmtWith(value.v, f) : fmtValue(value.v)) : "…"}
        </span>
        {value?.unit && !f?.suffix ? <span className="ml-1 text-base text-muted">{value.unit}</span> : null}
      </div>
      <div className="text-xs text-muted" data-ts-metric-label>{label}</div>
      {spark && cell?.points && cell.points.length > 1 && (
        <div className="mt-1">
          <Sparkline points={cell.points} color={st.line} width={Math.max(120, widget.w * 60)} height={Math.max(24, widget.h * 12)} />
        </div>
      )}
    </div>
  );
}

/** An embedded Quiver dashboard; its object input follows the selection on the same object type. */
export function QuiverWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const [a, setA] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!c.analysis_id) return;
    tsOntology.analysis(c.analysis_id).then(setA, (e: Error) => setError(e.message));
  }, [c.analysis_id]);
  if (!c.analysis_id) return <Hint text="Pick a Quiver analysis" />;
  if (error) return <div className="p-3 text-xs text-bad">{error}</div>;
  if (!a) return <Hint text="Loading…" />;
  const pk = a.root ? state.selection[`object_type:${a.root.object_type_id}`] : undefined;
  const root = a.root && pk ? { object_type_id: a.root.object_type_id, primary_key: pk } : a.root;
  return (
    <div className="h-full overflow-auto p-3">
      <QuiverDashboard key={`${root?.primary_key ?? ""}|${c.range_last ?? ""}`} analysis={a} root={root} resource={resource(state)} range={c.range_last ? { last: c.range_last } : undefined} />
    </div>
  );
}

/** The Derived Series widget: the derived series of a type and object types, to open, or a link to create one. */
export function DerivedWidget({ widget }: { widget: Widget }) {
  const c = widget.config;
  const [list, setList] = useState<DerivedSeries[] | null>(null);
  useEffect(() => {
    tsOntology
      .derivedList({ type: c.derived_type || undefined, root_object_type_id: c.derived_root || undefined, bound_object_type_id: c.derived_bound || undefined })
      .then(setList, () => setList([]));
  }, [c.derived_type, c.derived_root, c.derived_bound]);
  return (
    <div className="flex h-full flex-col p-3 text-sm">
      {!list ? (
        <Hint text="Loading…" />
      ) : list.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="font-medium">{c.empty_header || "No derived series yet"}</div>
          <div className="text-xs text-muted">{c.empty_description || "Derived series save calculations over time series to the Nexus."}</div>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {list.map((d) => (
            <li key={d.id} className="flex items-center gap-2 py-1.5">
              <Icon name="layers" className="h-3.5 w-3.5 text-ocean" />
              <Link href={`/time-series/derived/${d.id}`} target="_blank" className="truncate hover:text-ocean">
                {d.name}
              </Link>
              <span className="ml-auto text-xs text-muted">
                {d.type} · v{d.version}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!c.disable_create && (
        <Link
          href={`/time-series/derived/new${c.derived_root ? `?root=${c.derived_root}` : ""}`}
          target="_blank"
          className="mt-2 inline-flex items-center justify-center gap-1 rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep"
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> New derived series
        </Link>
      )}
    </div>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-xs text-muted">
      <Icon name="wave" className="h-5 w-5" />
      {text}
    </div>
  );
}
