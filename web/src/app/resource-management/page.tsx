"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { tsOntology, type UsageRow } from "@/lib/timeseries";
import { om, type OntologyUsage } from "@/lib/ontologyModel";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import { computeSeconds } from "@/lib/compute";
import { ResourceQueues } from "@/components/ResourceQueues";

type Usage = {
  days: number;
  since: string;
  totals: { batch: number; streaming: number; syncs: number; media: number; iceberg?: number; all: number };
  pipelines: { id: string; name: string; type: "batch" | "streaming"; builds: number; failed: number; seconds: number; compute_seconds: number; running: boolean; profiles: Record<string, number> }[];
  streams: { id: string; name: string; pipeline_id: string; pipeline_name: string; seconds: number; compute_seconds: number; records: number }[];
  syncs: { id: string; name: string; kind: string; type: "streaming" | "batch"; consumers?: number; minutes?: number; runs?: number; seconds?: number; records: number; compute_seconds: number; running: boolean }[];
  daily: { day: string; batch: number; streaming: number; syncs: number; media?: number }[];
  /** media set downloads and access patterns, in compute-seconds per GB (api/media_sets.py) */
  media_sets?: { id: string | null; name: string | null; compute_seconds: number; gb: number; requests: number; by: Record<string, number> }[];
  /** Iceberg tables (api/iceberg_tables.py): storage of main's latest snapshot, maintenance and sync compute */
  iceberg?: import("@/lib/iceberg").IcebergUsage | null;
  /** pipeline compute by the usage account of each pipeline's space (Control Panel → Spaces) */
  accounts?: { account: string; compute_seconds: number; pipelines: number }[];
};

/** Fixed categorical order (validated on the dark surface; same slots as Data Lineage's families). */
const SERIES = [
  { key: "batch", label: "Batch builds", color: "#3987e5" },
  { key: "streaming", label: "Streaming jobs", color: "#d95926" },
  { key: "syncs", label: "Syncs", color: "#199e70" },
  { key: "media", label: "Media sets", color: "#c98500" },
] as const;

const hours = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** Resource Management: estimated compute usage by pipeline, stream and sync (api/resource_usage.py). */
export default function ResourceManagementPage() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<"usage" | "queues">("usage");
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/api/resources/usage?days=${days}`)
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))))
      .then((d: Usage) => live && setData(d), (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [days]);
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Icon name="gauge" className="h-5 w-5 text-ocean" /> Resource Management
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Compute usage of pipelines, streams and syncs, in compute-seconds: each container counts max(vCPU, GiB ÷ 7.5) × 0.5 per second it runs. Streaming jobs use their streaming profile
              (job manager + task managers × (parallelism + 1)); batch builds their jobs&apos; compute profiles (driver + minimum executors); syncs one vCPU per consumer. These are
              estimates of what the profiles allocate, not measured CPU time.
            </p>
          </div>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-md border border-line-2 bg-ink px-2 py-1 text-sm">
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d === 1 ? "24 hours" : `${d} days`}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-5 flex gap-1 border-b border-line">
          {(
            [
              ["usage", "Usage"],
              ["queues", "Resource queues"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}>
              {l}
            </button>
          ))}
        </div>
        {tab === "queues" && <ResourceQueues />}
        {tab === "usage" && error && <p className="text-sm text-bad">{error}</p>}
        {tab === "usage" && !data && !error && <p className="text-sm text-muted">Loading…</p>}
        {tab === "usage" && data && (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-4">
              <Tile label="All compute" value={data.totals.all} />
              {SERIES.map((s) => (
                <Tile key={s.key} label={s.label} value={data.totals[s.key]} color={s.color} />
              ))}
            </div>
            <DailyChart daily={data.daily} />
            <Section title="By pipeline" empty={!data.pipelines.length}>
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Pipeline</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Builds</th>
                    <th className="px-3 py-2 font-medium">Profiles</th>
                    <th className="px-3 py-2 font-medium">Run time</th>
                    <th className="px-3 py-2 text-right font-medium">Compute</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pipelines.map((p) => (
                    <tr key={p.id} className="border-t border-line">
                      <td className="px-3 py-2">
                        <Link href={`/pipeline/${p.id}`} className="text-ocean hover:underline">
                          {p.name}
                        </Link>
                        {p.running && <span className="ml-2 text-ocean">running</span>}
                      </td>
                      <td className="px-3 py-2 text-muted">{p.type}</td>
                      <td className="px-3 py-2 text-soft">
                        {p.builds}
                        {p.failed > 0 && <span className="text-bad"> · {p.failed} failed</span>}
                      </td>
                      <td className="px-3 py-2 text-muted">{Object.entries(p.profiles).map(([k, n]) => `${k} ×${n}`).join(", ")}</td>
                      <td className="px-3 py-2 text-muted">{hours(p.seconds)}</td>
                      <td className="px-3 py-2 text-right text-soft">{computeSeconds(p.compute_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title="By usage account" hint="Pipeline compute grouped by the usage account of each pipeline's space (Control Panel → Spaces and templates)." empty={!(data.accounts ?? []).length}>
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 font-medium">Pipelines</th>
                    <th className="px-3 py-2 font-medium">Compute-seconds</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.accounts ?? []).map((a) => (
                    <tr key={a.account} className="border-t border-line">
                      <td className="px-3 py-2">{a.account}</td>
                      <td className="px-3 py-2">{a.pipelines}</td>
                      <td className="px-3 py-2">{Math.round(a.compute_seconds).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title="By stream" hint="Streaming jobs' usage, split evenly over the output ingest streams each writes." empty={!data.streams.length}>
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Stream</th>
                    <th className="px-3 py-2 font-medium">Written by</th>
                    <th className="px-3 py-2 font-medium">Records</th>
                    <th className="px-3 py-2 text-right font-medium">Compute</th>
                  </tr>
                </thead>
                <tbody>
                  {data.streams.map((s) => (
                    <tr key={s.id} className="border-t border-line">
                      <td className="px-3 py-2">
                        <Link href={`/streaming/streams/${s.id}`} className="text-ocean hover:underline">
                          {s.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-muted">{s.pipeline_name}</td>
                      <td className="px-3 py-2 text-muted">{s.records.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-soft">{computeSeconds(s.compute_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title="By sync" hint="Streaming syncs (minutes they reported metrics × consumers) and data source syncs (run time)." empty={!data.syncs.length}>
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Sync</th>
                    <th className="px-3 py-2 font-medium">Kind</th>
                    <th className="px-3 py-2 font-medium">Ran</th>
                    <th className="px-3 py-2 font-medium">Records</th>
                    <th className="px-3 py-2 text-right font-medium">Compute</th>
                  </tr>
                </thead>
                <tbody>
                  {data.syncs.map((s) => (
                    <tr key={s.id} className="border-t border-line">
                      <td className="px-3 py-2">
                        <Link href={s.type === "streaming" ? `/streaming/syncs/${s.id}` : "/sources"} className="text-ocean hover:underline">
                          {s.name}
                        </Link>
                        {s.running && <span className="ml-2 text-ocean">running</span>}
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {s.type} · {s.kind}
                        {s.consumers ? ` · ${s.consumers} consumer${s.consumers > 1 ? "s" : ""}` : ""}
                      </td>
                      <td className="px-3 py-2 text-muted">{s.type === "streaming" ? `${s.minutes ?? 0} min` : `${s.runs} runs · ${hours(s.seconds ?? 0)}`}</td>
                      <td className="px-3 py-2 text-muted">{s.records.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-soft">{computeSeconds(s.compute_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section
              title="By media set"
              hint="Downloads (2 compute-seconds per GB) and access patterns such as previews, page renders, waveforms and conversions, at the rates of the media usage table."
              empty={!(data.media_sets ?? []).length}
            >
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Media set</th>
                    <th className="px-3 py-2 font-medium">Requests</th>
                    <th className="px-3 py-2 font-medium">Processed</th>
                    <th className="px-3 py-2 font-medium">Largest cost</th>
                    <th className="px-3 py-2 text-right font-medium">Compute</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.media_sets ?? []).map((m) => {
                    const top = Object.entries(m.by).sort((a, b) => b[1] - a[1])[0];
                    return (
                      <tr key={m.id ?? "_"} className="border-t border-line">
                        <td className="px-3 py-2">
                          {m.id ? (
                            <Link href={`/media-sets/${m.id}`} className="text-ocean hover:underline">
                              {m.name ?? m.id}
                            </Link>
                          ) : (
                            <span className="text-soft">{m.name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted">{m.requests.toLocaleString()}</td>
                        <td className="px-3 py-2 text-muted">{m.gb < 1 ? `${(m.gb * 1024).toFixed(1)} MB` : `${m.gb.toFixed(2)} GB`}</td>
                        <td className="px-3 py-2 text-muted">{top ? top[0].replace(/_/g, " ") : "—"}</td>
                        <td className="px-3 py-2 text-right text-soft">{computeSeconds(m.compute_seconds)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>
            {data.iceberg && (
              <Section
                title="Iceberg tables"
                hint={`Storage: the live data and delete files of main's latest snapshot on Foundry-managed storage (${data.iceberg.gigabytes.toFixed(3)} GB now, ${data.iceberg.gigabyte_months.toFixed(3)} gigabyte-months over ${data.iceberg.days} days); history, other branches, metadata and orphan files are not counted, nor bring-your-own-bucket tables. Compute: maintenance jobs ${computeSeconds(data.iceberg.maintenance_compute_seconds)}, syncs ${computeSeconds(data.iceberg.sync_compute_seconds)}.`}
                empty={!data.iceberg.tables.length}
              >
                <table className="w-full text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Table</th>
                      <th className="px-3 py-2 font-medium">Location</th>
                      <th className="px-3 py-2 text-right font-medium">Storage</th>
                      <th className="px-3 py-2 text-right font-medium">Maintenance compute</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.iceberg.tables.map((t) => (
                      <tr key={t.id} className="border-t border-line">
                        <td className="px-3 py-2">
                          <Link href={`/datasets/${t.id}`} className="text-ocean hover:underline">
                            {t.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-muted">{t.path.join(" / ")}</td>
                        <td className="px-3 py-2 text-right text-soft">{t.byob ? "BYOB (not reported)" : `${((t.bytes ?? 0) / 1024 ** 2).toFixed(2)} MiB`}</td>
                        <td className="px-3 py-2 text-right text-soft">{computeSeconds(t.maintenance_compute_seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
          </div>
        )}
        <TimeSeriesUsage days={days} />
        <OntologyUsageSection days={days} />
      </div>
    </div>
  );
}

/** Time series query compute: 4 compute-seconds per query plus points scanned / 25,000, by the resource that ran it. */
function TimeSeriesUsage({ days }: { days: number }) {
  const [usage, setUsage] = useState<{ resources: UsageRow[]; total_compute_seconds: number; formula: string } | null>(null);
  useEffect(() => {
    tsOntology.usage(days).then(setUsage, () => setUsage(null));
  }, [days]);
  if (!usage) return null;
  return (
    <div className="mt-8">
      <Section
        title={`Time series queries · ${computeSeconds(usage.total_compute_seconds)}`}
        hint={`${usage.formula}. Usage is attributed to the Quiver analysis, Workshop module, derived series, automation or code repository that ran the query.`}
        empty={!usage.resources.length}
      >
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Resource</th>
              <th className="px-3 py-2 text-right font-medium">Queries</th>
              <th className="px-3 py-2 text-right font-medium">Points scanned</th>
              <th className="px-3 py-2 text-right font-medium">Compute</th>
            </tr>
          </thead>
          <tbody>
            {usage.resources.map((r) => (
              <tr key={r.resource} className="border-t border-line">
                <td className="px-3 py-2">{r.href ? <Link href={r.href} className="hover:text-ocean">{r.label}</Link> : r.label}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{r.queries.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{r.points.toLocaleString()}</td>
                <td className="px-3 py-2 text-right text-soft">{computeSeconds(r.compute_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

/**
 * Ontology usage: volume (indexed objects and join table links, averaged into GB-months), indexing compute, and query
 * compute by query type (2026 model), resource and object type.
 */
function OntologyUsageSection({ days }: { days: number }) {
  const [u, setU] = useState<OntologyUsage | null>(null);
  useEffect(() => {
    om.usage(days).then(setU, () => setU(null));
  }, [days]);
  if (!u) return null;
  const kinds = Object.entries(u.by_kind);
  return (
    <div id="ontology" className="mt-8 space-y-6">
      <Section
        title={`Nexus query and indexing compute · ${computeSeconds(u.compute_seconds)}`}
        hint={`Minimum compute-seconds per query: ${Object.entries(u.query_costs)
          .map(([k, v]) => `${k.replace("_", " ")} ${v}`)
          .join(", ")} (actions add 1 per object edited beyond the first). Indexing counts edits and re-imports.`}
        empty={!kinds.length}
      >
        <div className="grid gap-4 p-3 md:grid-cols-3">
          <table className="w-full text-sm">
            <tbody>
              {kinds.map(([k, v]) => (
                <tr key={k} className="border-t border-line first:border-0">
                  <td className="px-2 py-1.5 capitalize">{k.replace("query:", "").replace("_", " ")}</td>
                  <td className="px-2 py-1.5 text-right text-soft">{computeSeconds(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full text-sm">
            <tbody>
              {u.by_resource.slice(0, 8).map((r) => (
                <tr key={r.resource} className="border-t border-line first:border-0">
                  <td className="truncate px-2 py-1.5">{r.resource}</td>
                  <td className="px-2 py-1.5 text-right text-soft">{computeSeconds(r.compute_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full text-sm">
            <tbody>
              {u.by_object_type.slice(0, 8).map((r) => (
                <tr key={r.object_type_id} className="border-t border-line first:border-0">
                  <td className="truncate px-2 py-1.5">
                    <Link href={`/ontology/${r.object_type_id}`} className="hover:text-ocean">
                      {r.object_type}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5 text-right text-soft">{computeSeconds(r.compute_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title={`Nexus volume · ${(u.volume_bytes / 1e6).toFixed(2)} MB now · ${u.gb_months.toFixed(6)} GB-months`} hint="Sampled hourly per object type: the indexed size of its objects and join table links." empty={!u.volume.length}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Object type</th>
              <th className="px-3 py-2 text-right font-medium">Size now</th>
              <th className="px-3 py-2 text-right font-medium">Average GB</th>
              <th className="px-3 py-2 text-right font-medium">GB-months</th>
            </tr>
          </thead>
          <tbody>
            {u.volume.map((v) => (
              <tr key={v.object_type_id} className="border-t border-line">
                <td className="px-3 py-2">{v.object_type}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{(v.bytes / 1024).toFixed(1)} KB</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{v.average_gb.toFixed(6)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-soft">{v.gb_months.toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {color && <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{Math.round(value).toLocaleString()}</div>
      <div className="text-xs text-muted">compute-seconds</div>
    </div>
  );
}

function Section({ title, hint, empty, children }: { title: string; hint?: string; empty: boolean; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mb-2 text-xs text-muted">{hint}</p>}
      <div className="mt-2 overflow-hidden rounded-xl border border-line bg-panel">{empty ? <p className="px-3 py-6 text-center text-xs text-muted">Nothing ran in this period.</p> : children}</div>
    </section>
  );
}

/** Compute-seconds per day, stacked by kind; hover a segment for its value. */
function DailyChart({ daily }: { daily: Usage["daily"] }) {
  const [hover, setHover] = useState<{ day: string; key: string; value: number } | null>(null);
  if (!daily.length) return null;
  const max = Math.max(...daily.map((d) => d.batch + d.streaming + d.syncs + (d.media ?? 0)), 1);
  const H = 160;
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
        <span className="font-medium text-soft">Compute-seconds per day</span>
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-muted">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
        <span className="ml-auto text-muted">{hover ? `${hover.day} · ${SERIES.find((s) => s.key === hover.key)?.label}: ${computeSeconds(hover.value)}` : `max ${computeSeconds(max)}`}</span>
      </div>
      <div className="flex items-end gap-1 border-b border-line-2" style={{ height: H }}>
        {daily.map((d) => (
          <div key={d.day} className="flex min-w-0 flex-1 flex-col-reverse gap-[2px]" title={`${d.day}: ${computeSeconds(d.batch + d.streaming + d.syncs + (d.media ?? 0))}`}>
            {SERIES.map((s, i) => {
              const v = d[s.key] ?? 0;
              if (!v) return null;
              const top = SERIES.slice(i + 1).every((x) => !d[x.key]);
              return (
                <div
                  key={s.key}
                  onMouseEnter={() => setHover({ day: d.day, key: s.key, value: v })}
                  onMouseLeave={() => setHover(null)}
                  className={top ? "rounded-t" : ""}
                  style={{ height: Math.max(2, (v / max) * (H - 8)), background: s.color }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{daily[0].day}</span>
        <span>{daily[daily.length - 1].day}</span>
      </div>
    </div>
  );
}
