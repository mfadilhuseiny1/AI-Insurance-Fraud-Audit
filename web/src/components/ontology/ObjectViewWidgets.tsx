"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MapCanvas, type Basemap, type Projection } from "@/components/map/MapCanvas";
import { RangePicker, TsChart } from "@/components/timeseries/TsChart";
import { resolveRange, tsOntology, type SeriesPoint } from "@/lib/timeseries";

/** What a map tab draws: the viewed object ("object") and its linked objects ("linked"), resolved by the API. */
export type MapFeature = {
  role: "object" | "linked";
  object_type_id: string;
  primary_key: string;
  title: string;
  /** min lon, min lat, max lon, max lat */
  bounds: [number, number, number, number];
} & ({ kind: "point"; lat: number; lon: number } | { kind: "shape"; geometry: { type: string; coordinates: unknown } });

/** One series of a time series tab: the object and property the series route takes, with the default range's points. */
export type TabSeries = {
  key: string;
  object_type_id: string;
  primary_key: string;
  property: string;
  label: string;
  source: "property" | "sensor" | "linked";
  unit: string | null;
  categorical: boolean;
  points: SeriesPoint[];
  error?: string;
};

const OBJECT_COLOR = "#fbbf24";
const LINKED_COLOR = "#38bdf8";

/** A GeoJSON geometry as SVG: polygons filled, lines stroked, points as dots. */
function Shape({ geometry, p, color }: { geometry: { type: string; coordinates: unknown }; p: Projection; color: string }) {
  const line = (r: number[][]) => r.map(([lon, lat], i) => `${i ? "L" : "M"}${p.px(lon)},${p.py(lat)}`).join("");
  const c = geometry.coordinates;
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return (
        <>
          {(geometry.type === "Point" ? [c as number[]] : (c as number[][])).map(([lon, lat], i) => (
            <circle key={i} cx={p.px(lon)} cy={p.py(lat)} r={6} fill={color} stroke="#0b1220" strokeWidth={2} />
          ))}
        </>
      );
    case "LineString":
    case "MultiLineString":
      return <path d={(geometry.type === "LineString" ? [c as number[][]] : (c as number[][][])).map(line).join("")} fill="none" stroke={color} strokeWidth={2.5} />;
    case "Polygon":
    case "MultiPolygon":
      return (
        <path
          d={(geometry.type === "Polygon" ? [c as number[][][]] : (c as number[][][][])).flatMap((poly) => poly.map((r) => `${line(r)}Z`)).join("")}
          fill={color}
          fillOpacity={0.2}
          fillRule="evenodd"
          stroke={color}
          strokeWidth={2}
        />
      );
    default:
      return null;
  }
}

/** A map tab: the object and its linked objects on the platform's map, opened on everything drawn. */
export function ObjectViewMap({
  features,
  bounds,
  skipped,
  count,
  objectType,
  height,
}: {
  features: MapFeature[];
  bounds: [number, number, number, number] | null;
  skipped: number;
  count?: number;
  objectType?: string;
  height: number;
}) {
  const [basemap, setBasemap] = useState<Basemap>("google-satellite");
  if (!features.length || !bounds) return <div className="text-muted">Nothing to draw: no location on this object{objectType ? ` or its ${objectType}` : ""}.</div>;
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 0.005);
  const initial = { lat: (bounds[1] + bounds[3]) / 2, lon: (bounds[0] + bounds[2]) / 2, zoom: Math.max(2, Math.min(16, Math.floor(Math.log2(360 / span)) - 1)) };
  const linked = features.filter((f) => f.role === "linked");
  return (
    <div className="space-y-2">
      {/* flex: the map fills the box (MapCanvas is a flex item) */}
      <div className="flex overflow-hidden rounded-lg border border-line" style={{ height }}>
        <MapCanvas basemap={basemap} onBasemap={setBasemap} initial={initial}>
          {(p) =>
            // linked objects first, so the viewed object is drawn on top
            [...linked, ...features.filter((f) => f.role === "object")].map((f) => {
              const color = f.role === "object" ? OBJECT_COLOR : LINKED_COLOR;
              const [x, y] = f.kind === "point" ? [p.px(f.lon), p.py(f.lat)] : [p.px((f.bounds[0] + f.bounds[2]) / 2), p.py((f.bounds[1] + f.bounds[3]) / 2)];
              return (
                <g key={`${f.role}:${f.object_type_id}:${f.primary_key}`}>
                  <title>{f.title}</title>
                  {f.kind === "point" ? <circle cx={x} cy={y} r={f.role === "object" ? 8 : 6} fill={color} stroke="#0b1220" strokeWidth={2} /> : <Shape geometry={f.geometry} p={p} color={color} />}
                  {(f.role === "object" || p.z >= 8) && (
                    <text x={x + 10} y={y + 4} className="pointer-events-none fill-white text-[11px]" style={{ paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 }}>
                      {f.title}
                    </text>
                  )}
                </g>
              );
            })
          }
        </MapCanvas>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: OBJECT_COLOR }} /> this object
        </span>
        {objectType && (
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: LINKED_COLOR }} /> {linked.length}
            {count !== undefined && count > linked.length ? ` of ${count}` : ""} {objectType}
          </span>
        )}
        {skipped > 0 && <span>{skipped} without a location</span>}
        {linked.slice(0, 30).map((f) => (
          <Link key={f.primary_key} href={`/ontology/objects/${f.object_type_id}/${encodeURIComponent(f.primary_key)}`} className="text-ocean hover:underline">
            {f.title}
          </Link>
        ))}
      </div>
    </div>
  );
}

type Range = { start?: string | null; end?: string | null; last?: string | null };

/** A time series tab: its series on one chart. The default range comes with the tab; another range is read from the series route. */
export function ObjectViewTimeSeries({ series, defaultRange, error, height }: { series: TabSeries[]; defaultRange: string | null; error?: string; height: number }) {
  const initial = useMemo<Range>(() => (defaultRange ? { last: defaultRange } : {}), [defaultRange]);
  const [range, setRange] = useState<Range>(initial);
  const [fetched, setFetched] = useState<{ range: Range; series: TabSeries[] } | null>(null);
  useEffect(() => {
    if (range === initial) return;
    let live = true;
    const { start, end } = resolveRange(range);
    Promise.all(
      series.map((s) =>
        tsOntology.objectSeries(s.object_type_id, s.primary_key, { property: s.property, start, end, buckets: 300, resource: "object-view" }).then(
          (r): TabSeries => ({ ...s, unit: r.unit, categorical: r.categorical, points: r.points, error: undefined }),
          (e: Error): TabSeries => ({ ...s, points: [], error: e.message }),
        ),
      ),
    ).then((list) => {
      if (live) setFetched({ range, series: list });
    });
    return () => {
      live = false;
    };
  }, [range, initial, series]);
  if (error) return <div className="text-bad">{error}</div>;
  if (!series.length) return <div className="text-muted">No time series to chart on this object.</div>;
  const shown = range === initial ? series : fetched?.range === range ? fetched.series : null;
  const failed = (shown ?? []).filter((s) => s.error);
  return (
    <div className="space-y-2">
      <RangePicker value={range} onChange={(r) => setRange(JSON.stringify(r) === JSON.stringify(initial) ? initial : r)} />
      {shown ? (
        <TsChart series={shown.filter((s) => !s.error).map((s) => ({ key: s.key, label: s.label, unit: s.unit, points: s.points, categorical: s.categorical }))} height={height} />
      ) : (
        <div className="rounded-md border border-line bg-ink" style={{ height }} />
      )}
      {failed.map((s) => (
        <div key={s.key} className="rounded-md border border-bad/30 bg-bad/10 px-2 py-1.5 text-[11px] text-bad">
          {s.label}: {s.error}
        </div>
      ))}
    </div>
  );
}

/**
 * A free-form HTML tab. The API has already replaced the placeholders with escaped values and sanitized the result
 * (allow-listed tags and attributes, no scripts, no event handlers, only http(s) / mailto / site links); here it is
 * also kept apart from the app: a sandboxed frame that cannot run scripts or reach this page, under a content
 * security policy that loads nothing but images and inline styles. Links open in a new tab.
 */
export function ObjectViewHtml({ html, removed, title, height }: { html: string; removed: string[]; title: string; height: number }) {
  // the frame cannot read the app's theme: its colours follow the app's light / dark setting here
  const light = typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
  const [scheme, bg, fg, link] = light ? ["light", "#ffffff", "#1f2937", "#0369a1"] : ["dark", "#0d131d", "#d7e0ea", "#38bdf8"];
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${scheme}">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'">` +
    `<base target="_blank"><style>html{color-scheme:${scheme};background:${bg}}body{margin:8px;font:13px system-ui,sans-serif;color:${fg}}a{color:${link}}</style></head><body>${html}</body></html>`;
  return (
    <div className="space-y-1">
      <iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} title={title} className="w-full rounded-lg border border-line" style={{ height }} />
      {removed.length > 0 && <div className="text-[11px] text-muted">Left out for safety: {removed.join(", ")}</div>}
    </div>
  );
}
