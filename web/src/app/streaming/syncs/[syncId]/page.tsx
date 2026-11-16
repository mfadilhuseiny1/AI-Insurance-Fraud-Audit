"use client";

import { ResourceMarkings } from "@/components/auth/ItemMarkings";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { Section } from "@/components/streaming/parts";
import { Bars, SOURCES, STATUS_CLASS } from "@/components/streaming/StreamingSyncs";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { streaming, type StreamingSync, type SyncMetric } from "@/lib/streaming";

const SETTING_LABEL: Record<string, string> = {
  parallelism: "Parallelism",
  batch_records: "Records per poll",
  max_record_bytes: "Max record size",
  buffer_records: "Buffered records",
  checkpoint_interval_s: "Checkpoint interval (s)",
  poll_timeout_s: "Poll timeout (s)",
};

export default function SyncPage() {
  const { syncId } = useParams<{ syncId: string }>();
  const router = useRouter();
  const [sync, setSync] = useState<StreamingSync | null>(null);
  const [metrics, setMetrics] = useState<SyncMetric[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    streaming.sync(syncId).then(setSync, (e: Error) => setError(e.message));
    streaming.syncMetrics(syncId, 60).then(setMetrics, () => {});
  }, [syncId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ApiError message={error} />;
  if (!sync) return <Loading />;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      load();
    } catch (e) {
      alertDialog((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resetCheckpoint = async () => {
    if (
      !(await confirmDialog({
        title: "Reset checkpoint",
        message: "The sync forgets its position (offsets, sequence numbers, timestamps) and reads from the configured starting point again. Records may be ingested twice.",
        confirmLabel: "Reset checkpoint",
        danger: true,
      }))
    )
      return;
    act(() => streaming.resetCheckpoint(sync.id));
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete streaming sync", message: `Delete "${sync.name}"? The stream and its records stay.`, confirmLabel: "Delete", danger: true }))) return;
    act(async () => {
      await streaming.deleteSync(sync.id);
      router.push("/streaming");
    });
  };
  const series = (f: (m: SyncMetric) => number | null) => metrics.map((m) => ({ minute: m.minute, value: f(m) }));
  const source = SOURCES[sync.kind];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <Link href="/streaming" className="text-muted hover:text-white">
          <Icon name="left" className="h-4 w-4" />
        </Link>
        <Icon name="plug" className="h-5 w-5 text-ocean" />
        <div className="min-w-0">
          <div className="truncate font-medium">{sync.name}</div>
          <div className="text-xs text-muted">
            Streaming sync · {source?.label ?? sync.kind} →{" "}
            <Link href={`/streaming/streams/${sync.stream_id}`} className="text-ocean hover:underline">
              ingest stream
            </Link>
          </div>
        </div>
        <span className={`ml-3 rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[sync.status] ?? ""}`}>{sync.status}</span>
        <div className="ml-auto flex shrink-0 gap-2 whitespace-nowrap">
          {sync.desired === "running" ? (
            <button type="button" disabled={busy} onClick={() => act(() => streaming.stopSync(sync.id))} className={buttonClass.secondary}>
              <Icon name="stop" /> Stop
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => act(() => streaming.startSync(sync.id))} className={buttonClass.primary}>
              <Icon name="play" /> Start
            </button>
          )}
          <button type="button" disabled={busy} onClick={resetCheckpoint} className={buttonClass.secondary}>
            <Icon name="restore" /> Reset checkpoint
          </button>
          <Link href="/data-health" className={buttonClass.secondary}>
            <Icon name="bell" /> Monitor
          </Link>
          <button type="button" disabled={busy} onClick={remove} className={buttonClass.secondary}>
            <Icon name="trash" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-2">
          {sync.status === "queued" && sync.queue?.message && (
            <div className="flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn lg:col-span-2">
              <Icon name="clock" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {sync.queue.message} ·{" "}
                <Link href="/resource-management" className="underline">
                  Resource Management → Resource queues
                </Link>
              </span>
            </div>
          )}
          {sync.error && (
            <div className="flex gap-2 rounded-xl border border-bad/40 bg-bad/10 p-3 text-xs text-bad lg:col-span-2">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="whitespace-pre-wrap">{sync.error}</span>
            </div>
          )}
          <Section title="Job metrics (last hour, per minute)" icon="gauge">
            <div className="space-y-3">
              <Bars points={series((m) => m.records)} label="Records ingested" />
              <Bars points={series((m) => m.lag)} label="Total lag" />
              <Bars points={series((m) => Math.round(m.busy_ms / 600))} label="Utilization" unit="%" />
            </div>
          </Section>
          <ResourceMarkings kind="stream_sync" id={sync.id} />
          <Section title="Checkpoints" icon="check">
            <dl className="mb-3 grid grid-cols-[170px_1fr] gap-y-1 text-xs">
              <dt className="text-muted">Last checkpoint</dt>
              <dd>{sync.last_checkpoint_at ? when(sync.last_checkpoint_at) : "—"}</dd>
              <dt className="text-muted">Last checkpoint duration</dt>
              <dd>{sync.last_checkpoint_ms != null ? `${sync.last_checkpoint_ms} ms` : "—"}</dd>
              <dt className="text-muted">Records in last checkpoint</dt>
              <dd>{sync.last_checkpoint_records ?? "—"}</dd>
              <dt className="text-muted">Records (5 min)</dt>
              <dd>{sync.records_5m.toLocaleString()}</dd>
              <dt className="text-muted">Lag</dt>
              <dd>{sync.lag ?? "—"}</dd>
            </dl>
            <div className="space-y-3">
              <Bars points={series((m) => m.checkpoints)} label="Checkpoints" />
              <Bars points={series((m) => m.cp_ms_max)} label="Max checkpoint duration" unit=" ms" />
              <Bars points={series((m) => m.cp_failures)} label="Checkpoint failures" />
            </div>
          </Section>
          <Section title="Streaming profiles" icon="sliders">
            <div className="mb-2 flex flex-wrap gap-1 text-xs">
              {sync.profiles.map((p) => (
                <span key={p} className="rounded-full bg-ocean/15 px-2 py-0.5 text-ocean">
                  {p}
                </span>
              ))}
              {Object.keys(sync.advanced).length > 0 && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-warn">Advanced overrides</span>}
            </div>
            <dl className="grid grid-cols-[170px_1fr] gap-y-1 text-xs">
              {Object.entries(sync.settings).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{SETTING_LABEL[k] ?? k}</dt>
                  <dd>{v.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted">
              Project <span className="font-mono">{sync.project_id}</span> ·{" "}
              <Link href="/control-panel" className="text-ocean hover:underline">
                manage profiles in Control Panel
              </Link>
            </p>
          </Section>
          <Section title="Source configuration" icon="plug">
            <dl className="grid grid-cols-[170px_1fr] gap-y-1 text-xs">
              {Object.entries(sync.config).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{source?.fields.find((f) => f.name === k)?.label ?? k}</dt>
                  <dd className="break-all">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
              {sync.secrets_set.map((k) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{source?.fields.find((f) => f.name === k)?.label ?? k}</dt>
                  <dd>••••••</dd>
                </div>
              ))}
            </dl>
            {sync.checkpoint && Object.keys(sync.checkpoint).length > 0 && (
              <>
                <div className="mb-1 mt-3 text-xs text-muted">Checkpointed position</div>
                <pre className="max-h-48 overflow-auto rounded-md bg-ink p-2 text-[11px] text-soft">{JSON.stringify(sync.checkpoint, null, 2)}</pre>
              </>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
