"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, Modal } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { when } from "@/lib/format";
import { confirmDialog } from "@/lib/dialogs";
import { iceberg, iecBytes, SNAPSHOT_TYPE_LABEL, type IcebergTable, type SchemaVersion, type Snapshot, type SnapshotsView, type TrendPoint } from "@/lib/iceberg";

const RANGES: [string, string, number | null][] = [
  ["24h", "Last 24 hours", 1],
  ["7d", "Last 7 days", 7],
  ["30d", "Last 30 days", 30],
  ["all", "All time", null],
];
const TYPE_TONE: Record<Snapshot["operation"], string> = {
  append: "bg-ok/15 text-ok",
  overwrite: "bg-warn/15 text-warn",
  delete: "bg-bad/15 text-bad",
  replace: "bg-ocean/15 text-ocean",
};

/** The Snapshots tab: trends of Iceberg's snapshot summary metrics, and every snapshot of the branch in the range. */
export function SnapshotsTab({ t, branch, onChanged }: { t: IcebergTable; branch: string; onChanged: () => void }) {
  const [range, setRange] = useState("all");
  const [view, setView] = useState<SnapshotsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [schema, setSchema] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const days = RANGES.find(([k]) => k === range)?.[2];
    const since = days ? new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19) : undefined;
    iceberg.snapshots(t.id, { branch, since }).then(setView, (e: Error) => setError(e.message));
  }, [t.id, branch, range, reload]);
  if (error) return <p className="m-4 text-sm text-bad">{error}</p>;
  if (!view) return <Loading />;
  const rollback = async (s: Snapshot) => {
    if (
      !(await confirmDialog({
        title: "Roll back main",
        message: `Make snapshot ${s.snapshot_id} (${when(s.at)}) the current snapshot of main? Later snapshots stay in the history until they expire.`,
        confirmLabel: "Roll back",
      }))
    )
      return;
    try {
      await iceberg.rollback(t.id, s.snapshot_id);
      setReload((n) => n + 1);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-medium">Snapshots</h2>
        <span className="text-xs text-muted">
          {view.snapshots.length} of {view.total} retained snapshot{view.total === 1 ? "" : "s"} on {branch}
        </span>
        <select value={range} onChange={(e) => setRange(e.target.value)} className={`${fieldClass} ml-auto py-1 text-xs`}>
          {RANGES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <section className="mb-4 rounded-xl border border-line bg-panel p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Trends</div>
        {view.trend.length ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Trend label="Total size" points={view.trend} value={(p) => p.total_size} format={iecBytes} />
            <Trend label="Record count" points={view.trend} value={(p) => p.total_records} format={(n) => (n ?? 0).toLocaleString()} />
            <Trend label="File count" points={view.trend} value={(p) => p.total_files} format={(n) => (n ?? 0).toLocaleString()} />
            <Trend label="Schema version" points={view.trend} value={(p) => p.schema_id} format={(n) => `v${n ?? 0}`} step />
          </div>
        ) : (
          <p className="text-xs text-muted">No snapshots in this time range.</p>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Iceberg&apos;s snapshot summary: total-files-size (live data and delete files, IEC units), total-records (rows physically in live data files; rows behind
          position or equality deletes are still counted), total-data-files. Metadata-only changes (schema, partitions) make no snapshot.
        </p>
      </section>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-xs">
          <thead className="bg-panel-2 text-left text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Timestamp</th>
              <th className="px-3 py-2 font-medium">Snapshot ID</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Size</th>
              <th className="px-3 py-2 text-right font-medium">Records</th>
              <th className="px-3 py-2 text-right font-medium">Files</th>
              <th className="px-3 py-2 font-medium">Schema</th>
              <th className="px-3 py-2 font-medium">Attribution</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {view.snapshots.map((s, i) => (
              <tr key={s.snapshot_id} className="border-t border-line align-top">
                <td className="px-3 py-2">
                  <div title={s.at}>{when(s.at)}</div>
                  {s.job && <div className="text-[11px] text-muted">{s.job}</div>}
                  {s.refs.length > 0 && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {s.refs.map((r) => (
                        <span key={r} className="rounded bg-panel-2 px-1 text-[10px] text-soft">
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    title="Copy"
                    onClick={() => {
                      navigator.clipboard?.writeText(s.snapshot_id);
                      setCopied(s.snapshot_id);
                    }}
                    className="font-mono text-[11px] text-soft hover:text-white"
                  >
                    {s.snapshot_id} {copied === s.snapshot_id ? <span className="text-ok">copied</span> : null}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${TYPE_TONE[s.operation]}`} title={s.foundry_transactions.length ? `Foundry transaction: ${s.foundry_transactions.join(" / ")}` : "No Foundry transaction equivalent"}>
                    {SNAPSHOT_TYPE_LABEL[s.operation]}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  {iecBytes(s.total_size)}
                  <Delta add={s.added_size} remove={s.removed_size} fmt={iecBytes} />
                </td>
                <td className="px-3 py-2 text-right">
                  {(s.total_records ?? 0).toLocaleString()}
                  <Delta add={s.added_records} remove={s.deleted_records} />
                </td>
                <td className="px-3 py-2 text-right">
                  {(s.total_files ?? 0).toLocaleString()}
                  <Delta add={s.added_files} remove={s.deleted_files} />
                </td>
                <td className="px-3 py-2">
                  {s.schema_id !== null && (
                    <button type="button" onClick={() => setSchema(s.schema_id)} className="flex items-center gap-1 text-ocean hover:underline">
                      v{s.schema_id}
                      {(s.new_schema || i === view.snapshots.length - 1) && <span className="h-1.5 w-1.5 rounded-full bg-sand" title="Introduced a new schema version" />}
                    </button>
                  )}
                </td>
                <td className="px-3 py-2">
                  {s.user ?? "—"}
                  {s.marking_names && s.marking_names.length > 0 && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {s.marking_names.map((m) => (
                        <span key={m} className="rounded bg-bad/15 px-1 text-[10px] text-bad" title="Marking inherited by this snapshot (restricts the whole table until it expires)">
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {t.can_edit && branch === "main" && i > 0 && (
                    <button type="button" onClick={() => rollback(s)} className="text-muted hover:text-white" title="Roll back main to this snapshot">
                      <Icon name="restore" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!view.snapshots.length && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted">
                  No snapshots in this range — expired snapshots no longer appear.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {schema !== null && <SchemaDialog tableId={t.id} schemaId={schema} onClose={() => setSchema(null)} />}
    </div>
  );
}

function Delta({ add, remove, fmt = (n) => (n ?? 0).toLocaleString() }: { add: number | null; remove: number | null; fmt?: (n: number | null) => string }) {
  if (!add && !remove) return null;
  return (
    <div className="text-[10px]">
      {add ? <span className="text-ok">+{fmt(add)}</span> : null} {remove ? <span className="text-bad">−{fmt(remove)}</span> : null}
    </div>
  );
}

function Trend({ label, points, value, format, step }: { label: string; points: TrendPoint[]; value: (p: TrendPoint) => number | null; format: (n: number | null) => string; step?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 260;
  const H = 70;
  const xs = useMemo(() => points.map((p) => new Date(p.at).getTime()), [points]);
  const ys = points.map((p) => value(p) ?? 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(1, ...ys);
  // snapshots committed within a minute of each other are spread evenly (by order), otherwise by commit time
  const byIndex = maxX - minX < 60_000;
  const px = (x: number, i = 0) => (xs.length < 2 ? W / 2 : byIndex ? (i / (xs.length - 1)) * (W - 8) + 4 : ((x - minX) / (maxX - minX)) * (W - 8) + 4);
  const py = (y: number) => H - 6 - (y / maxY) * (H - 14);
  const path = xs
    .map((x, i) => {
      const cmd = i === 0 ? "M" : "L";
      if (step && i > 0) return `L${px(x, i)},${py(ys[i - 1])} L${px(x, i)},${py(ys[i])}`;
      return `${cmd}${px(x, i)},${py(ys[i])}`;
    })
    .join(" ");
  const shown = hover ?? points.length - 1;
  return (
    <div className="rounded-lg border border-line bg-ink p-2">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-medium text-soft">{format(ys[shown])}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-16 w-full" onMouseLeave={() => setHover(null)}>
        <path d={path} fill="none" stroke="currentColor" className="text-ocean" strokeWidth={1.5} />
        {xs.map((x, i) => (
          <circle key={i} cx={px(x, i)} cy={py(ys[i])} r={hover === i ? 3.5 : 2} className={hover === i ? "fill-sand" : "fill-ocean"} onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      <div className="text-[10px] text-muted">{points[shown] ? `${when(points[shown].at)} · ${points[shown].operation}` : ""}</div>
    </div>
  );
}

/** A schema version and what changed from the previous one. */
export function SchemaDialog({ tableId, schemaId, onClose }: { tableId: string; schemaId: number; onClose: () => void }) {
  const [s, setS] = useState<SchemaVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    iceberg.schema(tableId, schemaId).then(setS, (e: Error) => setError(e.message));
  }, [tableId, schemaId]);
  return (
    <Modal title={`Schema version ${schemaId}`} icon="table" onClose={onClose} wide>
      {error && <p className="p-4 text-sm text-bad">{error}</p>}
      {!s && !error && <Loading />}
      {s && (
        <div className="space-y-4 p-4 text-sm">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
              Changes {s.previous_id === null ? "(the first schema version)" : `since version ${s.previous_id}`}
            </div>
            {s.changes.length ? (
              <ul className="space-y-1 text-xs">
                {s.changes.map((c, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 ${c.change === "added" ? "bg-ok/15 text-ok" : c.change === "removed" ? "bg-bad/15 text-bad" : "bg-warn/15 text-warn"}`}>{c.change}</span>
                    <span className="font-mono">{c.name}</span>
                    {c.from && <span className="text-muted">from {c.from}</span>}
                    {c.type && <span className="text-muted">{c.type}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No column changes.</p>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Columns</div>
            <table className="w-full text-xs">
              <tbody>
                {s.columns.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="py-1 pr-2 text-muted">{c.id}</td>
                    <td className="py-1 pr-2 font-mono">{c.name}</td>
                    <td className="py-1 pr-2">{c.type}</td>
                    <td className="py-1 text-muted">
                      {c.required ? "required" : "optional"}
                      {s.identifier_fields.includes(c.name) ? " · identifier" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Close
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
