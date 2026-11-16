"use client";

import { ResourceMarkings } from "@/components/auth/ItemMarkings";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { DataPreview } from "@/components/pipeline/DataPreview";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { ApiError, Loading } from "@/components/States";
import { CopyButton, KeysEditor, NO_KEYS, SchemaEditor, Section } from "@/components/streaming/parts";
import { StreamingSyncs } from "@/components/streaming/StreamingSyncs";
import { ArchiveSection } from "@/components/streaming/ArchiveSection";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import type { Table } from "@/lib/pipeline";
import { curlPush, pushUrl, streaming, type IngestStream, type StreamColumn, type StreamKeys } from "@/lib/streaming";

type Tab = "preview" | "details" | "syncs";
const KEEP = 500;

export default function StreamPage() {
  const { streamId } = useParams<{ streamId: string }>();
  const router = useRouter();
  const [stream, setStream] = useState<IngestStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("preview");
  const [token, setToken] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(() => streaming.stream(streamId).then(setStream, (e: Error) => setError(e.message)), [streamId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ApiError message={error} />;
  if (!stream) return <Loading />;

  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete stream", message: `Delete "${stream.name}" and all of its records?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await streaming.deleteStream(stream.id);
      router.push("/streaming");
    } catch (e) {
      alertDialog((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <Link href="/streaming" className="text-muted hover:text-white">
          <Icon name="left" className="h-4 w-4" />
        </Link>
        <Icon name="wave" className="h-5 w-5 text-ocean" />
        <div className="min-w-0">
          <div className="truncate font-medium">{stream.name}</div>
          <div className="text-xs text-muted">
            Ingest stream · {stream.records.toLocaleString()} records in view {stream.view_id}
            {stream.last_record_at ? ` · last record ${when(stream.last_record_at)}` : ""}
            {stream.keys?.partition.length ? ` · keyed by ${stream.keys.partition.join(", ")}${stream.keys.primary ? " (CDC)" : ""}` : ""}
            {stream.origin?.kind === "pipeline" && (
              <>
                {" · output of "}
                <Link href={`/pipeline/${stream.origin.pipeline_id}`} className="text-ocean hover:underline">
                  {stream.origin.pipeline_name ?? "a pipeline"}
                </Link>
              </>
            )}
          </div>
        </div>
        <nav className="ml-6 flex gap-1 text-sm">
          {(
            [
              ["preview", "Live preview", "eye"],
              ["details", "Details", "info"],
              ["syncs", "Streaming syncs", "plug"],
            ] as [Tab, string, IconName][]
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
            >
              <Icon name={icon} className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 gap-2 whitespace-nowrap">
          <Link href={`/pipeline?new=streaming&ingest=${stream.id}`} className={buttonClass.primary}>
            <Icon name="pipeline" /> Start pipelining
          </Link>
          <button type="button" onClick={() => setResetting(true)} className={buttonClass.secondary}>
            <Icon name="restore" /> Reset stream
          </button>
          <button type="button" onClick={remove} className={buttonClass.secondary}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "preview" && <LivePreview key={stream.view_id} stream={stream} />}
        {tab === "details" && (
          <Details
            stream={stream}
            token={token}
            onReveal={() => streaming.stream(stream.id, true).then((s) => setToken(s.token ?? null), (e: Error) => alertDialog(e.message))}
            onReset={() => setResetting(true)}
          />
        )}
        {tab === "syncs" && (
          <div className="mx-auto max-w-6xl p-6">
            <StreamingSyncs streamId={stream.id} />
          </div>
        )}
      </div>
      {resetting && (
        <ResetDialog
          stream={stream}
          onClose={() => setResetting(false)}
          onDone={(s) => {
            setResetting(false);
            setStream(s);
          }}
        />
      )}
    </div>
  );
}

/** Records of the stream's current view, refreshed every two seconds (the newest KEEP rows). */
function LivePreview({ stream }: { stream: IngestStream }) {
  const [table, setTable] = useState<Table | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a primary-keyed stream is a changelog; the current view is the latest record per key
  const [view, setView] = useState<"changelog" | "current">("changelog");
  const last = useRef(0);
  useEffect(() => {
    if (paused) return;
    let alive = true;
    if (view === "current") {
      const tick = () =>
        streaming.records(stream.id, 0, KEEP, "current").then(
          (r) => alive && (setError(null), setTable({ columns: r.columns as Table["columns"], rows: r.rows as Table["rows"] })),
          (e: Error) => alive && setError(e.message),
        );
      tick();
      const t = setInterval(tick, 2000);
      return () => {
        alive = false;
        clearInterval(t);
      };
    }
    const tick = () =>
      streaming.records(stream.id, last.current, 5000).then(
        (r) => {
          if (!alive) return;
          setError(null);
          if (last.current && r.rows.length === 0) return;
          last.current = r.last_seq;
          setTable((prev) => {
            const rows = [...(prev?.rows ?? []), ...(r.rows as Table["rows"])].slice(-KEEP);
            const names = new Set(r.columns.map((c) => c.name));
            const columns = [...r.columns, ...(prev?.columns ?? []).filter((c) => !names.has(c.name))];
            return { columns: columns as Table["columns"], rows };
          });
        },
        (e: Error) => alive && setError(e.message),
      );
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [stream.id, paused, view]);
  return (
    <div className="flex h-full min-h-[400px] flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs text-muted">
        <span className={`h-2 w-2 rounded-full ${paused ? "bg-muted" : "animate-pulse bg-ok"}`} />
        {paused ? "Paused" : "Live"} · {view === "current" ? "current view: the latest record per primary key" : `latest ${KEEP} records of the current view`}
        <button type="button" onClick={() => setPaused(!paused)} className="text-ocean hover:underline">
          {paused ? "Resume" : "Pause"}
        </button>
        {stream.keys?.primary && (
          <span className="ml-auto flex gap-1">
            {(["changelog", "current"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  last.current = 0;
                  setTable(null);
                  setView(v);
                }} className={`rounded px-2 py-0.5 ${view === v ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "hover:text-white"}`}>
                {v === "changelog" ? "Changelog" : "Current view (CDC)"}
              </button>
            ))}
          </span>
        )}
        {error && <span className="text-bad">{error}</span>}
      </div>
      {!table ? (
        <Loading />
      ) : table.rows.length === 0 ? (
        <p className="m-auto max-w-md text-center text-sm text-muted">
          No records yet. Push records to the stream proxy URL (see Details) or set up a streaming sync into this stream.
        </p>
      ) : (
        <div className="min-h-0 flex-1">
          <DataPreview table={table} title={stream.name} />
        </div>
      )}
    </div>
  );
}

function Details({ stream, token, onReveal, onReset }: { stream: IngestStream; token: string | null; onReveal: () => void; onReset: () => void }) {
  const [sample, setSample] = useState("");
  const [pushResult, setPushResult] = useState<string | null>(null);
  const push = async () => {
    try {
      const t = token ?? (await streaming.stream(stream.id, true)).token ?? "";
      const body = JSON.parse(sample || "[]");
      const r = await streaming.push(stream.push_path, t, Array.isArray(body) ? body : [body]);
      setPushResult(`Pushed ${r.pushed} record${r.pushed === 1 ? "" : "s"}.`);
    } catch (e) {
      setPushResult((e as Error).message);
    }
  };
  return (
    <div className="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-2">
      <ResourceMarkings kind="stream" id={stream.id} className="lg:col-span-2" />
      <div className="lg:col-span-2">
        <ArchiveSection streamId={stream.id} />
      </div>
      <Section title="Push-based ingestion" icon="upload">
        <p className="mb-2 text-xs text-muted">
          POST JSON records to the stream proxy with the stream&apos;s token. Each record is <code>{"{\"value\": {…}}"}</code> or a plain object. The URL includes the
          view id, so it changes when the stream is reset.
        </p>
        <Copyable label="Stream proxy URL" value={pushUrl(stream)} />
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-muted">Token</span>
          <code className="min-w-0 flex-1 truncate rounded bg-ink px-2 py-1">{token ?? "••••••••••••••••"}</code>
          {!token && (
            <button type="button" onClick={onReveal} className="text-ocean hover:underline">
              Reveal
            </button>
          )}
          {token && <CopyButton value={token} />}
        </div>
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>curl example</span>
            <CopyButton value={curlPush(stream, token ?? undefined)} />
          </div>
          <pre className="overflow-x-auto rounded-md bg-ink p-2 text-[11px] text-soft">{curlPush(stream, token ?? undefined)}</pre>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted">Test push (a JSON object or array)</div>
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            rows={3}
            placeholder={JSON.stringify(Object.fromEntries((stream.schema.length ? stream.schema : [{ name: "message", type: "String" }]).map((c) => [c.name, c.type === "String" ? "text" : 1])))}
            className={`${inputClass} font-mono text-xs`}
          />
          <div className="mt-1 flex items-center gap-2">
            <button type="button" onClick={push} className={`${buttonClass.secondary} py-1 text-xs`}>
              <Icon name="upload" className="h-3.5 w-3.5" /> Push
            </button>
            {pushResult && <span className="text-xs text-muted">{pushResult}</span>}
          </div>
        </div>
      </Section>
      <Section title="Schema" icon="table">
        {stream.schema.length ? (
          <table className="w-full text-xs">
            <tbody>
              {stream.schema.map((c) => (
                <tr key={c.name} className="border-b border-line last:border-0">
                  <td className="py-1">{c.name}</td>
                  <td className="py-1 text-muted">{c.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-muted">No fixed schema: columns come from the records.</p>
        )}
        <p className="mt-2 text-xs text-muted">Changing the schema needs a stream reset.</p>
        <StreamKeysSection stream={stream} />
      </Section>
      <Section title="Stream settings" icon="sliders">
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-xs">
          <dt className="text-muted">Throughput</dt>
          <dd>{stream.throughput === "high" ? "High" : "Normal"}</dd>
          <dt className="text-muted">Current view</dt>
          <dd className="font-mono">{stream.view_id}</dd>
          <dt className="text-muted">Records</dt>
          <dd>{stream.records.toLocaleString()}</dd>
          <dt className="text-muted">Created</dt>
          <dd>{when(stream.created_at)}</dd>
          <dt className="text-muted">Configuration</dt>
          <dd>
            {Object.keys(stream.configuration).length
              ? Object.entries(stream.configuration).map(([k, v]) => (
                  <div key={k}>
                    {k} = {v}
                  </div>
                ))
              : "—"}
          </dd>
        </dl>
        <button type="button" onClick={onReset} className={`${buttonClass.secondary} mt-3 py-1 text-xs`}>
          <Icon name="restore" className="h-3.5 w-3.5" /> Reset stream
        </button>
      </Section>
      <Section title="Previous views" icon="clock">
        {stream.views.length === 0 ? (
          <p className="text-xs text-muted">The stream has not been reset.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {[...stream.views].reverse().map((v) => (
              <li key={v.view_id} className="flex justify-between">
                <span className="font-mono">{v.view_id}</span>
                <span className="text-muted">replaced {when(v.replaced_at)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Pushes to a previous view are refused (409); clients must use the new URL.</p>
      </Section>
    </div>
  );
}

/**
 * Reset stream (a development tool): clears the records by starting a new view, optionally
 * changing schema, throughput and configuration. Syncs into the stream restart; downstream
 * pipelines must be replayed.
 */
function ResetDialog({ stream, onClose, onDone }: { stream: IngestStream; onClose: () => void; onDone: (s: IngestStream) => void }) {
  const [schema, setSchema] = useState<StreamColumn[]>(stream.schema);
  const [throughput, setThroughput] = useState<string>(stream.throughput);
  const [config, setConfig] = useState(
    Object.entries(stream.configuration)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reset = async () => {
    try {
      const configuration = Object.fromEntries(
        config
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf("=");
            return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
          }),
      );
      const r = await streaming.reset(stream.id, { schema, throughput, configuration });
      onDone(r);
      alertDialog({
        title: "Stream reset",
        message: `New view ${r.view_id}.${r.restarted_syncs.length ? ` Restarted ${r.restarted_syncs.length} streaming sync(s).` : ""} Push clients must use the new stream proxy URL; replay downstream streaming pipelines.`,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Reset stream" icon="restore" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <div className="flex gap-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Resetting removes all records from the stream&apos;s current view and starts a new view with a new push URL. Records are lost: do not reset production streams.
            Downstream streaming pipelines must be replayed, and push clients updated to the new view.
          </span>
        </div>
        <Field label="Schema">
          <SchemaEditor value={schema} onChange={setSchema} />
        </Field>
        <Field label="Throughput">
          <select value={throughput} onChange={(e) => setThroughput(e.target.value)} className={inputClass}>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </Field>
        <Field label="Configuration" hint="One key=value per line.">
          <textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={3} className={`${inputClass} font-mono text-xs`} />
        </Field>
        <Field label={`Type "${stream.name}" to confirm`}>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} />
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={confirm !== stream.name} onClick={reset} className={buttonClass.primary}>
            Reset stream
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-xs">
      <div className="mb-1 flex justify-between text-muted">
        <span>{label}</span>
        <CopyButton value={value} />
      </div>
      <code className="block truncate rounded bg-ink px-2 py-1">{value}</code>
    </div>
  );
}

/** Partition and primary keys: changed without a reset (they only change how consumers read the stream). */
function StreamKeysSection({ stream }: { stream: IngestStream }) {
  const [keys, setKeys] = useState<StreamKeys>(stream.keys ?? NO_KEYS);
  const [msg, setMsg] = useState<string | null>(null);
  const changed = JSON.stringify(keys) !== JSON.stringify(stream.keys ?? NO_KEYS);
  const save = () => streaming.setKeys(stream.id, keys).then(() => setMsg("Keys saved"), (e: Error) => setMsg(e.message));
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-1 text-xs font-medium text-soft">Keys</div>
      <p className="mb-2 text-xs text-muted">
        Partition keys keep the order of records with the same key; adding a column makes the guarantee weaker. A primary key (CDC) makes the stream a changelog read
        as the latest record per key.
      </p>
      <KeysEditor columns={stream.schema.map((c) => c.name)} value={keys} onChange={setKeys} />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled={!changed} onClick={save} className={`${buttonClass.secondary} py-1 text-xs`}>
          Save keys
        </button>
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </div>
  );
}
