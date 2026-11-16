"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { Bars } from "@/components/streaming/StreamingSyncs";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { SyncDialog } from "@/components/timeseries/SyncDialog";
import { isDemo, monitorHref, timeseries, tsOntology, type GeoSeriesInfo, type SeriesPoint, type SeriesSync, type SyncError, type TimeSeriesInfo } from "@/lib/timeseries";

type Tab = "series" | "writes" | "errors";

/** A time series or geotemporal series sync: its series, points written per minute and rejected rows. */
export default function SeriesSyncPage() {
  const { syncId } = useParams<{ syncId: string }>();
  const router = useRouter();
  const [sync, setSync] = useState<SeriesSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("series");
  const [editing, setEditing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [props, setProps] = useState<{ object_type_id: string; object_type: string; property: string; display_name: string }[] | null>(null);
  useEffect(() => {
    tsOntology.viewed("sync", syncId);
    tsOntology.home().then((h) => setFavorite(h.favorites.some((f) => f.kind === "sync" && f.id === syncId)), () => {});
    timeseries.syncProperties(syncId).then(setProps, () => setProps([]));
  }, [syncId]);
  useEffect(() => {
    const load = () => timeseries.sync(syncId).then(setSync, (e: Error) => setError(e.message));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [syncId]);
  if (error && !sync) return <ApiError message={error} />;
  if (!sync) return <Loading />;
  const geo = sync.kind === "geotemporal";
  const remove = async () => {
    if (!(await confirmDialog(`Delete ${sync.name}? Its ${sync.stored.toLocaleString()} ${geo ? "observations" : "points"} are deleted; the next build or streaming batch creates it again.`))) return;
    await timeseries.deleteSync(sync.id);
    router.push("/time-series");
  };
  const mapping = Object.entries(sync.mapping).filter(([, v]) => v !== "" && v !== null && !(Array.isArray(v) && !v.length));
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <Link href="/time-series" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-white">
          <Icon name="left" className="h-3 w-3" /> Time Series Catalog
        </Link>
        <div className="mb-4 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Icon name={geo ? "globe" : "wave"} className="h-5 w-5 text-ocean" /> {sync.name}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {sync.kind_label} · {sync.mode} · written by{" "}
              {isDemo(sync) ? (
                "the demo project (Time Series Catalog → Load demo data)"
              ) : sync.pipeline_id ? (
                <Link href={`/pipeline/${sync.pipeline_id}`} className="text-soft hover:text-ocean">
                  {sync.pipeline_name || sync.pipeline_id}
                </Link>
              ) : (
                "—"
              )}
              {sync.backing_dataset ? ` · backing dataset ${sync.backing_dataset}` : ""}
              {sync.stream_id ? (
                <>
                  {" · "}
                  <Link href={`/streaming/streams/${sync.stream_id}`} className="text-soft hover:text-ocean">
                    output stream
                  </Link>
                </>
              ) : null}
            </p>
            {mapping.length > 0 && <p className="mt-1 font-mono text-xs text-muted">{mapping.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`).join("  ")}</p>}
          </div>
          {geo && (
            <Link href={`/map?sync=${sync.id}`} className={buttonClass.secondary}>
              <Icon name="globe" className="h-4 w-4" /> Open in Map
            </Link>
          )}
          <button
            type="button"
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            onClick={async () => (await tsOntology.favorite("sync", sync.id, !favorite), setFavorite(!favorite))}
            className={`${buttonClass.secondary} ${favorite ? "text-sand" : ""}`}
          >
            <Icon name="star" className="h-4 w-4" />
          </button>
          {!geo && (
            <button type="button" onClick={() => setEditing(true)} className={buttonClass.secondary}>
              <Icon name="pencil" className="h-4 w-4" /> Update sync
            </button>
          )}
          {sync.source === "catalog" && (
            <button
              type="button"
              disabled={building}
              onClick={async () => {
                setBuilding(true);
                try {
                  setSync(await timeseries.buildSync(sync.id));
                } finally {
                  setBuilding(false);
                }
              }}
              className={buttonClass.secondary}
            >
              <Icon name="play" className="h-4 w-4" /> {building ? "Building…" : "Build"}
            </button>
          )}
          <Link href={monitorHref(sync)} className={buttonClass.secondary}>
            <Icon name="bell" className="h-4 w-4" /> Add output monitor
          </Link>
          <button type="button" onClick={remove} className={buttonClass.secondary}>
            <Icon name="trash" className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          {(
            [
              ["Series", sync.series.toLocaleString()],
              [geo ? "Observations stored" : "Points stored", sync.stored.toLocaleString()],
              [geo ? "Sent (last 5 min)" : "Written (last 5 min)", sync.written_5m.toLocaleString()],
              ["Time range", sync.first_ts ? `${sync.first_ts.slice(0, 16).replace("T", " ")} → ${sync.last_ts?.slice(0, 16).replace("T", " ")}` : "—"],
              ["Last write", sync.last_write_at ? when(sync.last_write_at) : "never"],
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-panel p-3">
              <div className="text-xs text-muted">{k}</div>
              <div className="mt-0.5 truncate text-sm font-medium" title={v}>
                {v}
              </div>
            </div>
          ))}
        </div>
        {sync.status === "failed" && sync.error && <p className="mb-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{sync.error}</p>}
        {!geo && props && (
          <div className="mb-5 rounded-xl border border-line bg-panel p-3 text-sm">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-soft">
              <Icon name="cube" className="h-3.5 w-3.5 text-ocean" /> Nexus
            </div>
            {props.length ? (
              <div className="flex flex-wrap gap-2 text-xs">
                Data source of
                {props.map((p) => (
                  <Link key={`${p.object_type_id}:${p.property}`} href={`/ontology/${p.object_type_id}?tab=capabilities`} className="rounded bg-ocean/10 px-1.5 py-0.5 text-ocean hover:underline">
                    {p.object_type} · {p.display_name}
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted">
                This sync backs no time series property yet.
                <Link href={`/time-series/setup?sync=${sync.id}`} className={`${buttonClass.primary} py-1 text-xs`}>
                  Set up now
                </Link>
              </div>
            )}
            {sync.source === "catalog" && sync.builds && sync.builds.length > 0 && (
              <div className="mt-2 border-t border-line pt-2 text-xs text-muted">
                Builds:{" "}
                {sync.builds.slice(0, 5).map((b, i) => (
                  <span key={i} className={`mr-3 ${b.status === "failed" ? "text-bad" : ""}`} title={b.error ?? undefined}>
                    {when(b.at)} · {b.status}
                    {b.written !== undefined ? ` · ${b.written.toLocaleString()} points` : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="mb-4 flex gap-1">
          {(
            [
              ["series", "Series"],
              ["writes", geo ? "Observations sent" : "Points written"],
              ["errors", `Rejected rows${sync.errors ? ` (${sync.errors.toLocaleString()})` : ""}`],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-md px-2.5 py-1 text-sm ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "series" && (geo ? <GeoSeries sync={sync} /> : <TimeSeries sync={sync} />)}
        {tab === "writes" && <Writes sync={sync} />}
        {tab === "errors" && <Errors sync={sync} />}
      </div>
      {editing && (
        <SyncDialog
          sync={sync}
          onClose={() => setEditing(false)}
          onSaved={(x) => {
            setSync(x);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function TimeSeries({ sync }: { sync: SeriesSync }) {
  const [search, setSearch] = useState("");
  const [series, setSeries] = useState<TimeSeriesInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => timeseries.series<TimeSeriesInfo>(sync.id, search).then(setSeries, (e: Error) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [sync.id, sync.last_write_at, search]);
  const current = selected ?? series?.[0]?.series_id ?? null;
  return (
    <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
      <div className="rounded-xl border border-line bg-panel">
        <div className="border-b border-line p-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter series…" className={inputClass} />
        </div>
        <ul className="max-h-[32rem] overflow-y-auto text-sm">
          {error && <li className="p-3 text-xs text-bad">{error}</li>}
          {series?.length === 0 && <li className="p-3 text-center text-xs text-muted">No series.</li>}
          {series?.map((s) => (
            <li key={s.series_id}>
              <button
                type="button"
                onClick={() => setSelected(s.series_id)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left ${current === s.series_id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}
              >
                <span className="truncate font-mono text-xs">{s.series_id}</span>
                <span className="shrink-0 text-xs text-muted">{fmt(s.last_value)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {current ? <SeriesChart sync={sync} info={series?.find((s) => s.series_id === current)} seriesId={current} /> : <div className="rounded-xl border border-line bg-panel p-8 text-center text-sm text-muted">Pick a series.</div>}
    </div>
  );
}

const RANGES: [string, number | null][] = [
  ["1 hour", 60],
  ["1 day", 1440],
  ["7 days", 7 * 1440],
  ["All", null],
];

function SeriesChart({ sync, seriesId, info }: { sync: SeriesSync; seriesId: string; info?: TimeSeriesInfo }) {
  const [range, setRange] = useState<number | null>(null);
  const [data, setData] = useState<{ total: number; bucketed: boolean; points: SeriesPoint[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // ranges count back from the series' newest point (data may be historical)
    const end = info?.last_ts ? new Date(info.last_ts).getTime() : Date.now();
    const start = range ? new Date(end - range * 60_000).toISOString() : undefined;
    timeseries.points(sync.id, seriesId, { start, buckets: 400 }).then(setData, (e: Error) => setError(e.message));
  }, [sync.id, seriesId, range, info?.last_ts, sync.last_write_at]);
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium">{seriesId}</div>
          {info && (
            <div className="text-xs text-muted">
              {info.points.toLocaleString()} points · min {fmt(info.min)} · avg {fmt(info.avg)} · max {fmt(info.max)} · last {fmt(info.last_value)}
            </div>
          )}
        </div>
        {RANGES.map(([label, minutes]) => (
          <button
            key={label}
            type="button"
            onClick={() => setRange(minutes)}
            className={`rounded-md px-2 py-0.5 text-xs ${range === minutes ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {!data ? <Loading /> : <LineChart points={data.points} />}
      {data && (
        <p className="mt-2 text-xs text-muted">
          {data.total.toLocaleString()} points in range{data.bucketed ? ` · averaged into ${data.points.length} time buckets (band: min–max)` : ""}
        </p>
      )}
    </div>
  );
}

const fmt = (v: number | string | null | undefined) =>
  v === null || v === undefined ? "—" : typeof v === "number" ? (Math.abs(v) >= 1000 || Number.isInteger(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toPrecision(4)) : v;

/** An SVG line chart of numeric points (text values are left out), with the min–max band of bucketed points. */
function LineChart({ points }: { points: SeriesPoint[] }) {
  const W = 800;
  const H = 260;
  const pad = { l: 56, r: 12, t: 10, b: 28 };
  const num = useMemo(() => points.filter((p) => typeof p.value === "number").map((p) => ({ ...p, x: new Date(p.t).getTime(), y: p.value as number })), [points]);
  if (!num.length) return <div className="flex h-64 items-center justify-center rounded-md border border-line bg-ink text-xs text-muted">No numeric points in this range.</div>;
  const x0 = num[0].x;
  const x1 = num[num.length - 1].x;
  const lo = Math.min(...num.map((p) => p.min ?? p.y));
  const hi = Math.max(...num.map((p) => p.max ?? p.y));
  const span = hi - lo || Math.abs(hi) || 1;
  const yLo = lo - span * 0.05;
  const yHi = hi + span * 0.05;
  const sx = (x: number) => pad.l + (x1 === x0 ? (W - pad.l - pad.r) / 2 : ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r));
  const sy = (y: number) => pad.t + (1 - (y - yLo) / (yHi - yLo)) * (H - pad.t - pad.b);
  const line = num.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const band = num.some((p) => p.min !== undefined) ? [...num.map((p) => `${sx(p.x).toFixed(1)},${sy(p.max ?? p.y).toFixed(1)}`), ...[...num].reverse().map((p) => `${sx(p.x).toFixed(1)},${sy(p.min ?? p.y).toFixed(1)}`)].join(" ") : null;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yLo + f * (yHi - yLo));
  const label = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full rounded-md border border-line bg-ink" role="img" aria-label="Series chart">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} className="stroke-line" strokeWidth={1} />
          <text x={pad.l - 6} y={sy(v) + 3} textAnchor="end" className="fill-muted text-[10px]">
            {fmt(v)}
          </text>
        </g>
      ))}
      {band && <polygon points={band} className="fill-ocean/15" />}
      <polyline points={line} fill="none" className="stroke-ocean" strokeWidth={1.75} strokeLinejoin="round" />
      {num.length <= 60 && num.map((p) => <circle key={p.t} cx={sx(p.x)} cy={sy(p.y)} r={2.5} className="fill-ocean"><title>{`${p.t} · ${fmt(p.y)}`}</title></circle>)}
      <text x={pad.l} y={H - 8} className="fill-muted text-[10px]">
        {label(x0)}
      </text>
      <text x={W - pad.r} y={H - 8} textAnchor="end" className="fill-muted text-[10px]">
        {label(x1)}
      </text>
    </svg>
  );
}

function GeoSeries({ sync }: { sync: SeriesSync }) {
  const [series, setSeries] = useState<GeoSeriesInfo[] | null>(null);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => timeseries.series<GeoSeriesInfo>(sync.id, search).then(setSeries, () => setSeries([])), 200);
    return () => clearTimeout(t);
  }, [sync.id, sync.last_write_at, search]);
  return (
    <div className="rounded-xl border border-line bg-panel">
      <div className="border-b border-line p-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter series…" className={`${inputClass} max-w-xs`} />
      </div>
      <table className="w-full text-sm">
        <thead className="bg-panel-2 text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2">Series</th>
            <th className="px-3 py-2 text-right">Observations</th>
            <th className="px-3 py-2">Latest position</th>
            <th className="px-3 py-2">Last seen</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {series?.map((s) => (
            <tr key={s.series_id} className="border-t border-line">
              <td className="px-3 py-2 font-mono text-xs">{s.series_id}</td>
              <td className="px-3 py-2 text-right tabular-nums">{s.observations.toLocaleString()}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
              </td>
              <td className="px-3 py-2 text-xs text-muted">{s.last_ts.slice(0, 19).replace("T", " ")}</td>
              <td className="px-3 py-2 text-right">
                <Link href={`/map?sync=${sync.id}&series=${encodeURIComponent(s.series_id)}`} className={`${buttonClass.secondary} py-1 text-xs`}>
                  <Icon name="globe" className="h-3.5 w-3.5" /> Track
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {series?.length === 0 && <p className="p-6 text-center text-sm text-muted">No series.</p>}
    </div>
  );
}

function Writes({ sync }: { sync: SeriesSync }) {
  const [rows, setRows] = useState<{ minute: string; points: number; errors: number }[] | null>(null);
  const [minutes, setMinutes] = useState(120);
  useEffect(() => {
    timeseries.metrics(sync.id, minutes).then(setRows, () => setRows([]));
  }, [sync.id, minutes, sync.last_write_at]);
  const geo = sync.kind === "geotemporal";
  return (
    <div className="space-y-4 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">Window</span>
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={`${inputClass} w-auto py-1 text-xs`}>
          <option value={60}>1 hour</option>
          <option value={120}>2 hours</option>
          <option value={1440}>1 day</option>
          <option value={10080}>7 days</option>
        </select>
        <span className="ml-auto text-muted">
          {geo ? "Geotemporal observations sent" : "Points written to the Time Series DB"} per minute — what an output monitor checks over 5 or 30 minutes.
        </span>
      </div>
      {!rows ? (
        <Loading />
      ) : (
        <>
          <Bars points={rows.map((r) => ({ minute: r.minute, value: r.points }))} label={geo ? "Observations sent" : "Points written"} />
          <Bars points={rows.map((r) => ({ minute: r.minute, value: r.errors }))} label="Rejected rows" />
        </>
      )}
    </div>
  );
}

function Errors({ sync }: { sync: SeriesSync }) {
  const [rows, setRows] = useState<SyncError[] | null>(null);
  useEffect(() => {
    timeseries.errors(sync.id).then(setRows, () => setRows([]));
  }, [sync.id, sync.last_write_at]);
  if (!rows) return <Loading />;
  if (!rows.length) return <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">No rejected rows.</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <p className="border-b border-line px-3 py-2 text-xs text-muted">
        Rows without a series id or a time{sync.kind === "geotemporal" ? ", or without a valid latitude / longitude," : ""} are not written; the newest are kept here (the sync&apos;s errors dataset).
      </p>
      <table className="w-full text-sm">
        <thead className="bg-panel-2 text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2">At</th>
            <th className="px-3 py-2">Error</th>
            <th className="px-3 py-2">Row</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line align-top">
              <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{r.at.slice(0, 19).replace("T", " ")}</td>
              <td className="px-3 py-2 text-xs text-warn">{r.error}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-soft">{JSON.stringify(r.record)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
