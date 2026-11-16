"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";
import { when } from "@/lib/format";
import { COL_TYPES, type ColType, type Column, type Table } from "@/lib/pipeline";
import { runtime, type StreamInfo } from "@/lib/runtime";
import { curlPush, streaming, type IngestStream, type StreamColumn, type StreamKeys } from "@/lib/streaming";
import { KeysEditor, NO_KEYS, SchemaEditor } from "../streaming/parts";
import { Icon } from "../Icon";
import { DataPreview } from "./DataPreview";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field, Tabs } from "./ui";

const typed = (cols: { name: string; type: string }[]): Column[] => cols.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType }));

/** How a machine pushes to a pipeline stream: with the stream's push token (shown only to those who may push). */
export function curlFor(stream: Pick<StreamInfo, "id" | "schema" | "token">) {
  const example = Object.fromEntries(stream.schema.map((c) => [c.name, ["Integer", "Long", "Double", "Float", "Decimal", "Short", "Byte"].includes(c.type) ? 21.5 : c.type === "Boolean" ? true : `${c.name}-1`]));
  return `curl -X POST "${API_URL}/api/pipeline/stream-push/${stream.id}" \\\n  -H "Authorization: Bearer ${stream.token ?? "<stream token>"}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ value: example })}'`;
}

/** The records of a stream, refreshed while open (the stream viewer). */
export function useStreamRecords(id: string | null, live = true) {
  const [data, setData] = useState<{ table: Table; last: number } | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await runtime.records(id, 0, 1000);
        if (alive) setData({ table: { columns: typed(r.columns), rows: r.rows as Table["rows"] }, last: r.last_seq });
      } catch {}
      if (alive && live) timer = setTimeout(load, 2000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, live]);
  return data;
}

/** The records of an ingest stream (Streaming app), refreshed every two seconds while open. */
function useIngestRecords(id: string | null) {
  const [data, setData] = useState<Table | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await streaming.records(id, 0, 1000);
        if (alive) setData({ columns: typed(r.columns), rows: r.rows as Table["rows"] });
      } catch {}
      if (alive) timer = setTimeout(load, 2000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);
  return data;
}

/**
 * Streams for a streaming pipeline, as in Foundry: create a stream (throughput, schema, keys), push records
 * to it, see them arrive, then start pipelining. Streams are the Streaming app's ingest streams, so the
 * same stream can also be fed by a streaming sync; streams of older pipelines stay listed under Legacy.
 */
export function StreamDialog({
  onUse,
  onUseIngest,
  onClose,
}: {
  onUse: (s: StreamInfo, preview: Table) => void;
  onUseIngest: (s: IngestStream, preview: Table) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"new" | "existing" | "legacy">("new");
  const [ingest, setIngest] = useState<IngestStream[] | null>(null);
  const [legacy, setLegacy] = useState<StreamInfo[] | null>(null);
  const [name, setName] = useState("Sensor readings");
  const [throughput, setThroughput] = useState("normal");
  const [schema, setSchema] = useState<StreamColumn[]>([
    { name: "sensor_id", type: "String" },
    { name: "temperature", type: "Double" },
  ]);
  const [keys, setKeys] = useState<StreamKeys>(NO_KEYS);
  const [picked, setPicked] = useState<IngestStream | null>(null);
  const [legacyPicked, setLegacyPicked] = useState<StreamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const records = useIngestRecords(picked?.id ?? null);
  const legacyRecords = useStreamRecords(legacyPicked?.id ?? null);
  useEffect(() => {
    streaming.streams().then(setIngest, () => setIngest([]));
    runtime.streams().then(setLegacy, () => setLegacy([]));
  }, []);
  const pick = (s: IngestStream) => streaming.stream(s.id, true).then(setPicked, (e: Error) => setError(e.message));
  const create = () =>
    streaming
      .createStream({ name: name.trim(), schema, throughput, keys: { partition: keys.partition.filter((k) => schema.some((c) => c.name === k)), primary: keys.primary } })
      .then(setPicked, (e: Error) => setError(e.message));
  const sample = (s: IngestStream) =>
    Object.fromEntries((s.schema.length ? s.schema : [{ name: "message", type: "String" }]).map((c) => [c.name, c.type === "String" ? `${c.name}-${Math.ceil(Math.random() * 9)}` : c.type === "Boolean" ? Math.random() > 0.5 : Math.round(Math.random() * 400) / 10]));
  return (
    <Modal title="Streams" icon="wave" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        {!picked && !legacyPicked && (
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "new", label: "New stream" },
              { id: "existing", label: "Existing streams", badge: ingest?.length },
              ...(legacy?.length ? [{ id: "legacy" as const, label: "Legacy pipeline streams", badge: legacy.length }] : []),
            ]}
          />
        )}
        {picked ? (
          <>
            <div className="flex items-center gap-2">
              <Icon name="wave" className="h-4 w-4 text-ocean" />
              <span className="font-medium">{picked.name}</span>
              <span className="text-xs text-muted">{records ? `${records.rows.length} records` : "…"} · refreshes every 2 seconds</span>
              <a href={`/streaming/streams/${picked.id}`} target="_blank" rel="noreferrer" className="ml-auto text-xs text-ocean hover:underline">
                Open in Streaming
              </a>
            </div>
            <Field label="Connect via API — push records with curl (Bash)" hint="Each call adds the records in the array. A streaming sync (Kafka, MQTT …) can write to this stream too: Streaming → Streaming syncs.">
              <pre className="overflow-x-auto rounded-md bg-ink p-2 font-mono text-[11px] text-soft">{curlPush(picked, picked.token)}</pre>
            </Field>
            <button type="button" onClick={() => streaming.push(picked.push_path, picked.token ?? "", [sample(picked)]).catch((e: Error) => setError(e.message))} className={buttonClass.secondary}>
              Push a sample record
            </button>
            {error && <p className="text-xs text-bad">{error}</p>}
            <div className="flex h-56 flex-col rounded-md border border-line">
              {records?.rows.length ? <DataPreview table={records} title="Stream records" /> : <p className="p-4 text-xs text-muted">No records yet — run the curl command.</p>}
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={() => onUseIngest(picked, records ?? { columns: typed(picked.schema), rows: [] })} className={buttonClass.primary}>
                Start pipelining
              </button>
            </div>
          </>
        ) : legacyPicked ? (
          <>
            <div className="flex items-center gap-2">
              <Icon name="wave" className="h-4 w-4 text-muted" />
              <span className="font-medium">{legacyPicked.name}</span>
              <span className="text-xs text-muted">legacy pipeline stream · {legacyRecords ? `${legacyRecords.table.rows.length} records` : "…"}</span>
            </div>
            <pre className="overflow-x-auto rounded-md bg-ink p-2 font-mono text-[11px] text-soft">{curlFor(legacyPicked)}</pre>
            <div className="flex h-56 flex-col rounded-md border border-line">
              {legacyRecords?.table.rows.length ? <DataPreview table={legacyRecords.table} title="Stream records" /> : <p className="p-4 text-xs text-muted">No records yet.</p>}
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={() => onUse(legacyPicked, legacyRecords?.table ?? { columns: legacyPicked.schema as Column[], rows: [] })} className={buttonClass.primary}>
                Start pipelining
              </button>
            </div>
          </>
        ) : tab === "new" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stream name">
                <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </Field>
              <Field label="Throughput">
                <select value={throughput} onChange={(e) => setThroughput(e.target.value)} className={inputClass}>
                  <option value="normal">Normal (one partition)</option>
                  <option value="high">High</option>
                </select>
              </Field>
            </div>
            <Field label="Schema">
              <SchemaEditor value={schema} onChange={setSchema} />
            </Field>
            <Field label="Keys (optional)" hint="Partition keys keep records with the same key in order; CDC mode adds a primary key.">
              <KeysEditor columns={schema.map((c) => c.name).filter(Boolean)} value={keys} onChange={setKeys} />
            </Field>
            {error && <p className="text-xs text-bad">{error}</p>}
            <div className="flex justify-end">
              <button type="button" disabled={!name.trim() || !schema.length || schema.some((c) => !c.name.trim())} onClick={create} className={buttonClass.primary}>
                Create stream
              </button>
            </div>
          </>
        ) : tab === "existing" ? (
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {ingest?.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => pick(s)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-panel-2">
                  <Icon name="wave" className="h-4 w-4 text-ocean" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{s.name}</span>
                    <span className="block text-xs text-muted">
                      {s.schema.length ? s.schema.map((c) => `${c.name}: ${c.type}`).join(", ") : "schema from the records"} · {s.records} records
                      {s.keys?.partition.length ? ` · keyed by ${s.keys.partition.join(", ")}` : ""}
                      {s.last_record_at ? ` · last ${when(s.last_record_at)}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {ingest?.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">No streams yet.</li>}
          </ul>
        ) : (
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {legacy?.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setLegacyPicked(s)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-panel-2">
                  <Icon name="wave" className="h-4 w-4 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{s.name}</span>
                    <span className="block text-xs text-muted">
                      {s.schema.map((c) => `${c.name}: ${c.type}`).join(", ")} · {s.records ?? 0} records{s.last_record_at ? ` · last ${when(s.last_record_at)}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
